"""
Generic stateful MCP-over-streamable-HTTP client.

awslabs publishes a growing set of MCP servers (pricing /
well-architected-security / billing-cost-management / aws-api / ...)
that share the FastMCP transport. They are stateful: each session must
start with `initialize`, then send a `notifications/initialized`
notification, and every subsequent `tools/call` must echo the
`Mcp-Session-Id` header the server returned. The hosted Knowledge MCP
is a stateless variant of the same protocol.

This module abstracts that handshake so each `core/aws_*_mcp.py`
specific client can focus on the per-tool argument shaping + result
parsing, instead of re-implementing JSON-RPC, SSE chunking, session
caching, and stale-session retry every time.

Boundary contract:
  - Every method either returns a parsed result dict or `None` on any
    failure. Never raises (the chat loop must keep going on transport
    errors).
  - Sessions cache per-endpoint. We re-handshake automatically on 400 /
    404 (server restart), and treat 401/403 as fatal (auth
    misconfigured — log loudly).
  - Per-call HTTP timeout defaults to 25s; tunable per-instance.

Why a class (not module-level globals like `aws_docs_mcp.py`):
  - Each MCP server needs its own session id + initialized flag, so a
    single shared global would race. Wrapping in a class lets every
    `aws_*_mcp.py` instantiate one client per server.
  - The hosted docs path (`aws_docs_mcp.py`) keeps its own simpler
    stateless HTTP shim — it pre-dates this module and the protocol
    version it talks to is stateless. We could refactor it onto this
    class later but it's working fine today, so don't disturb.
"""
from __future__ import annotations
from core.net import safe_urlopen

import json as _json
import logging
import time
import urllib.error
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)


class McpHttpClient:
    """One client = one MCP server endpoint + cached session.

    Use:
        c = McpHttpClient("http://127.0.0.1:8001/mcp", name="pricing")
        result = c.call_tool("get_pricing", {"service_code": "AmazonEC2"})
    """

    def __init__(self, endpoint: str, *, name: str = "mcp",
                 timeout: float = 25.0):
        self.endpoint = endpoint
        self.name = name
        self.timeout = timeout
        self._session_id: str | None = None
        self._initialized: bool = False
        self._cached_avail: bool | None = None
        self._cached_avail_at: float = 0.0

    # ---- low-level transport ------------------------------------------------
    def _post(self, payload: dict[str, Any] | None, *,
              extra_headers: dict[str, str] | None = None,
              timeout: float | None = None,
              ) -> tuple[int, dict[str, str], str]:
        body = _json.dumps(payload).encode("utf-8") if payload else b""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
        }
        if extra_headers:
            headers.update(extra_headers)
        req = urllib.request.Request(self.endpoint, data=body, method="POST",
                                     headers=headers)
        try:
            with safe_urlopen(req, timeout=timeout or self.timeout) as resp:
                return (resp.status, dict(resp.headers.items()),
                        resp.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as e:
            try:
                err_body = e.read().decode("utf-8", errors="replace")
            except Exception:
                err_body = ""
            return (e.code, dict(e.headers.items()) if e.headers else {}, err_body)
        except urllib.error.URLError as e:
            logger.warning("mcp[%s]: URL error: %s", self.name, e.reason)
            return (0, {}, "")
        except Exception as e:
            logger.warning("mcp[%s]: unexpected transport error: %s",
                           self.name, e)
            return (0, {}, "")

    @staticmethod
    def _parse_jsonrpc_body(raw: str) -> dict[str, Any] | None:
        """SSE-aware JSON-RPC envelope parser. The server may interleave
        `notifications/message` frames before the final `result` frame;
        we keep the last frame that has `result` or `error`."""
        raw = (raw or "").strip()
        if not raw:
            return None
        candidates: list[dict[str, Any]] = []
        if raw.startswith("event:") or "\ndata:" in raw or raw.startswith("data:"):
            for line in raw.splitlines():
                if line.startswith("data: "):
                    payload = line[len("data: "):].strip()
                    if not payload:
                        continue
                    try:
                        candidates.append(_json.loads(payload))
                    except _json.JSONDecodeError:
                        pass
        else:
            try:
                candidates.append(_json.loads(raw))
            except _json.JSONDecodeError:
                logger.warning("mcp: non-JSON body (%d bytes)", len(raw))
                return None
        for env in reversed(candidates):
            if isinstance(env, dict) and ("result" in env or "error" in env):
                return env
        return candidates[-1] if candidates else None

    # ---- handshake ----------------------------------------------------------
    def _do_handshake(self) -> bool:
        init_req = {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "notiops", "version": "1.0"},
            },
        }
        status, hdrs, body = self._post(init_req, timeout=10.0)
        if status != 200:
            logger.warning("mcp[%s]: initialize HTTP %d (%d-byte body)",
                           self.name, status, len(body))
            return False
        env = self._parse_jsonrpc_body(body)
        if not env or "result" not in env:
            logger.warning("mcp[%s]: initialize bad envelope (%d-byte body)",
                           self.name, len(body))
            return False
        sid = hdrs.get("Mcp-Session-Id") or hdrs.get("mcp-session-id")
        self._session_id = sid or None
        if sid:
            logger.info("mcp[%s]: handshake OK session=%s",
                        self.name, sid[:12] + "…")
        else:
            logger.info("mcp[%s]: handshake OK (stateless)", self.name)

        notify = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        self._post(
            notify,
            extra_headers={"Mcp-Session-Id": self._session_id} if self._session_id else None,
            timeout=5.0,
        )
        # Don't fail on the notification status — some servers return
        # 200/202/204 inconsistently and we shouldn't block tool calls.
        self._initialized = True
        return True

    # ---- public API ---------------------------------------------------------
    def call_tool(self, tool_name: str, arguments: dict[str, Any]
                  ) -> dict[str, Any] | None:
        """Invoke `tools/call` with the given arguments. Returns the
        envelope's `result` field (with `content` blocks), or `None` on
        any unrecoverable failure. Auto re-handshakes if the server
        invalidates the session."""
        if not self._initialized:
            if not self._do_handshake():
                return None

        payload = {
            "jsonrpc": "2.0",
            "id": int(time.time() * 1000) % 10_000_000,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }

        def _attempt() -> tuple[int, str]:
            status, _, body = self._post(
                payload,
                extra_headers={"Mcp-Session-Id": self._session_id}
                if self._session_id else None,
            )
            return status, body

        status, body = _attempt()
        if status in (400, 404):
            logger.info("mcp[%s]: stale session (HTTP %d), re-handshaking",
                        self.name, status)
            self._initialized = False
            self._session_id = None
            if self._do_handshake():
                status, body = _attempt()

        if status != 200:
            logger.warning("mcp[%s]: tools/call %s HTTP %d (%d-byte body)",
                           self.name, tool_name, status, len(body))
            return None

        env = self._parse_jsonrpc_body(body)
        if not env:
            return None
        if "error" in env:
            err = env["error"] if isinstance(env["error"], dict) else {}
            logger.warning("mcp[%s]: server error on %s: code=%s msg=%s",
                           self.name, tool_name, err.get("code"), err.get("message"))
            return None
        return env.get("result")

    def list_tools(self) -> list[dict[str, Any]]:
        """Return the upstream server's `tools/list` payload. Each
        item has the shape {name, description, inputSchema}. Empty
        list on any failure."""
        if not self._initialized:
            if not self._do_handshake():
                return []
        payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list",
                   "params": {}}
        status, _, body = self._post(
            payload,
            extra_headers={"Mcp-Session-Id": self._session_id}
            if self._session_id else None,
            timeout=5.0,
        )
        if status != 200:
            return []
        env = self._parse_jsonrpc_body(body)
        if not env or not isinstance(env.get("result"), dict):
            return []
        return env["result"].get("tools") or []

    def is_available(self) -> bool:
        """Cheap probe gated by a 60s cache. Used by `_build_tools_for_call`
        to hide tools whose sidecar isn't responding yet (e.g. boot lag)."""
        now = time.time()
        if self._cached_avail is not None and now - self._cached_avail_at < 60:
            return self._cached_avail
        payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list",
                   "params": {}}
        if not self._initialized:
            if not self._do_handshake():
                self._cached_avail = False
                self._cached_avail_at = now
                return False
        status, _, body = self._post(
            payload,
            extra_headers={"Mcp-Session-Id": self._session_id}
            if self._session_id else None,
            timeout=5.0,
        )
        ok = (status == 200) and bool(self._parse_jsonrpc_body(body))
        self._cached_avail = ok
        self._cached_avail_at = now
        return ok

    @staticmethod
    def coerce_text(result: dict[str, Any] | None) -> str:
        """MCP tools return content as a list of {type, text|json} blocks.
        Concatenate the text content into a single string for downstream
        parsing."""
        if not result:
            return ""
        parts: list[str] = []
        for blk in result.get("content", []) or []:
            t = blk.get("type")
            if t == "text" and isinstance(blk.get("text"), str):
                parts.append(blk["text"])
            elif t == "json" and "json" in blk:
                try:
                    parts.append(_json.dumps(blk["json"]))
                except Exception:
                    pass
        return "\n".join(parts)
