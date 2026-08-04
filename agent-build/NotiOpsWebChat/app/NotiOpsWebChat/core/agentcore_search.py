"""
Web Search via **AWS Bedrock AgentCore Gateway** (built-in `web-search` connector).

This is the AWS-native, in-region web search (GA 2026): queries **stay inside AWS**
(no third-party egress, unlike Exa). We reach it over the Gateway's MCP endpoint with
a single `tools/call` to the `WebSearch` tool, SigV4-signed with the runtime's IAM role
(service = ``bedrock-agentcore``). Mirrors core/web_search.py's synchronous
JSON-RPC-over-HTTP style to stay dependency-light (no extra MCP client lib).

Design:
  - ``search()`` returns ``{"text","sources"}`` (same shape as Exa) or **None** on any
    failure / when not configured — the caller (core/web_search.py) then falls back to Exa.
  - Gateway URL comes from env ``AGENTCORE_WEBSEARCH_GATEWAY_URL`` (set at deploy time);
    if unset, returns None immediately so behavior is unchanged where it's not provisioned.

Refs (official AWS docs):
  - Web Search connector + input/response schema:
    gateway-target-connector-web-search-tool.html
  - SigV4/IAM gateway invocation: gateway-inbound-auth.html
  - Tool name "WebSearch"; input {query(<=200 chars), maxResults(1-25, default 10)};
    each result: {text(required), url?, title?, publishedDate?}. Citations must be shown.
"""
from __future__ import annotations
from core.net import safe_urlopen

import json as _json
import logging
import os

logger = logging.getLogger(__name__)

_GATEWAY_URL = os.environ.get("AGENTCORE_WEBSEARCH_GATEWAY_URL", "").strip()
_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
_HTTP_TIMEOUT_SECONDS = float(os.environ.get("WEB_SEARCH_HTTP_TIMEOUT", "8.0"))
_MAX_RESULTS = int(os.environ.get("WEB_SEARCH_MAX_RESULTS", "5"))
_MAX_SNIPPET_CHARS = 800
_QUERY_MAX_CHARS = 200  # AgentCore web search hard limit
# Gateway 暴露的工具名 = "<targetName>___WebSearch"（target 名 + 三下划线 + 工具名）。
# 我们的 target 叫 web-search-tool，故默认如下；可用 env 覆盖（换 target 名时）。
_TOOL_NAME = os.environ.get("AGENTCORE_WEBSEARCH_TOOL_NAME", "web-search-tool___WebSearch")
# Gateway 当前要求的 MCP 协议版本（实测只接受 2025-03-26，拒绝 2025-06-18）。
_MCP_PROTOCOL_VERSION = "2025-03-26"


def configured() -> bool:
    """True if an AgentCore web-search Gateway URL is configured."""
    return bool(_GATEWAY_URL)


def _sigv4_post(url: str, body: bytes) -> str | None:
    """POST ``body`` to ``url`` SigV4-signed for service ``bedrock-agentcore``.
    Returns the raw response text, or None on any failure."""
    try:
        import urllib.request
        import urllib.error
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        import boto3
    except Exception as e:  # noqa: BLE001 — deps missing → caller falls back
        logger.warning("agentcore_search: import failed: %s", e)
        return None

    try:
        session = boto3.Session()
        creds = session.get_credentials()
        if creds is None:
            logger.warning("agentcore_search: no AWS credentials")
            return None
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": _MCP_PROTOCOL_VERSION,
        }
        aws_req = AWSRequest(method="POST", url=url, data=body, headers=headers)
        SigV4Auth(creds.get_frozen_credentials(), "bedrock-agentcore", _REGION).add_auth(aws_req)
        signed_headers = dict(aws_req.headers)

        req = urllib.request.Request(url, data=body, method="POST", headers=signed_headers)
        with safe_urlopen(req, timeout=_HTTP_TIMEOUT_SECONDS) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:  # type: ignore[name-defined]
        logger.warning("agentcore_search: HTTP %s", getattr(e, "code", "?"))
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("agentcore_search: request failed: %s", e)
        return None


def _mcp_call(tool: str, arguments: dict) -> dict | None:
    """Invoke a Gateway MCP tool via `tools/call`. None on any failure."""
    if not _GATEWAY_URL:
        return None
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    raw = _sigv4_post(_GATEWAY_URL, _json.dumps(payload).encode("utf-8"))
    if not raw:
        return None

    # SSE responses put the JSON envelope on `data:` lines; rejoin them.
    if "data:" in raw[:64] or raw.lstrip().startswith("event:"):
        chunks = [ln[len("data: "):] for ln in raw.splitlines() if ln.startswith("data: ")]
        candidate = "".join(chunks).strip() or raw.strip()
    else:
        candidate = raw.strip()

    try:
        envelope = _json.loads(candidate)
    except _json.JSONDecodeError:
        logger.warning("agentcore_search: non-JSON body: %r", candidate[:200])
        return None
    if envelope.get("error"):
        logger.warning("agentcore_search: server error: %s", envelope["error"])
        return None
    return envelope.get("result")


def _extract_results(result: dict | None) -> list[dict]:
    """Pull the inner ``results`` array out of the MCP result. The connector returns
    content[].text as a **JSON-encoded string** {"id":..,"results":[{text,url,title,publishedDate}]}."""
    if not result:
        return []
    # MCP tool error?
    if result.get("isError"):
        logger.warning("agentcore_search: tool returned isError")
        return []
    out: list[dict] = []
    for blk in result.get("content", []) or []:
        if blk.get("type") != "text":
            continue
        txt = blk.get("text")
        if not isinstance(txt, str):
            continue
        try:
            inner = _json.loads(txt)
        except _json.JSONDecodeError:
            # Some responses may already be plain text — keep as a single snippet.
            out.append({"text": txt, "url": "", "title": "", "publishedDate": ""})
            continue
        for r in inner.get("results", []) or []:
            if isinstance(r, dict) and r.get("text"):
                out.append({
                    "text": r.get("text", ""),
                    "url": r.get("url", ""),
                    "title": r.get("title", ""),
                    "publishedDate": r.get("publishedDate", ""),
                })
    return out


def search(query: str, *, num_results: int = _MAX_RESULTS) -> dict | None:
    """Search the web via AgentCore. Returns ``{"text","sources"}`` or **None**.

    None signals "unavailable / failed" so the caller falls back to Exa. Never raises.
    ``sources`` mirrors the aws_docs/exa shape so the UI Sources drawer renders the same.
    """
    if not _GATEWAY_URL:
        return None
    query = (query or "").strip()
    if not query:
        return None
    if len(query) > _QUERY_MAX_CHARS:
        query = query[:_QUERY_MAX_CHARS]

    max_results = max(1, min(25, num_results))
    result = _mcp_call(_TOOL_NAME, {"query": query, "maxResults": max_results})
    hits = _extract_results(result)
    if not hits:
        return None  # treat empty/failed as "fall back to Exa"

    lines, sources = [], []
    for h in hits[:_MAX_RESULTS]:
        snippet = h["text"]
        if len(snippet) > _MAX_SNIPPET_CHARS:
            snippet = snippet[:_MAX_SNIPPET_CHARS] + "…"
        title = h.get("title") or h.get("url") or "(untitled)"
        date = f" ({h['publishedDate']})" if h.get("publishedDate") else ""
        url = h.get("url", "")
        lines.append(f"- {title}{date}\n  {url}\n  {snippet}")
        if url:
            sources.append({"icon": "web", "title": title, "detail": url})
    return {"text": "\n\n".join(lines), "sources": sources}
