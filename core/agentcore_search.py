"""
Web Search via **AWS Bedrock AgentCore Gateway** (built-in `web-search` connector).

This is the AWS-native, in-region web search (GA 2026): queries **stay inside AWS**
(no third-party egress). Since 2026-08 it is the **only** web-search provider — the Exa
public-MCP fallback was removed, see core/web_search.py's module docstring for why.
We reach it over the Gateway's MCP endpoint with a single `tools/call` to the `WebSearch`
tool, SigV4-signed with the runtime's IAM role (service = ``bedrock-agentcore``), using
plain synchronous JSON-RPC-over-HTTP to stay dependency-light (no extra MCP client lib).

Design:
  - ``search()`` returns ``{"text","sources"}`` or **None** on any failure / when not
    configured. The caller (core/web_search.py) turns None into an empty result — there is
    no second provider to fall back to.
  - Gateway URL comes from env ``AGENTCORE_WEBSEARCH_GATEWAY_URL`` (injected at deploy time
    by both deployment paths); if unset, returns None immediately.

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

def _read_gateway_url() -> str:
    """Gateway URL from env, or "" when this deployment has no web-search capability.

    Only an ``https://`` value counts as configured. Both non-URL values that reach this
    env var in practice are "no capability", and both used to fail *later*, obscurely:
      - ``__WEBSEARCH_GATEWAY_URL__`` — the un-substituted placeholder you get by running
        `agentcore deploy` by hand instead of `scripts/deploy_agent.sh`;
      - ``unavailable`` — what the one-click stager writes when the Gateway could not be
        provisioned (it cannot write "" — AgentCore Runtime rejects empty env values).
    Treating them as unconfigured makes the failure mode "no web search" instead of
    "every search SigV4-signs a request to a garbage host and times out".
    """
    raw = os.environ.get("AGENTCORE_WEBSEARCH_GATEWAY_URL", "").strip()
    return raw if raw.startswith("https://") else ""


_GATEWAY_URL = _read_gateway_url()
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


# JS 渲染的占位/无正文页面特征（如 aws.amazon.com/new/ 抓回来是一堆 "Loading…"）。
# 这类命中没有真实内容，却会把模型带回训练记忆里的旧信息 —— 必须丢弃，不能当"有结果"。
# （原先长在 core/web_search.py 的 Exa 解析里；Exa 移除后搬到这一层 —— 这里才拿得到
#   结构化的 hit，能逐条丢弃而不是整批放弃。）
_NOISE_MARKERS = ("正在加载", "Loading", "Skip to main content", "跳至主要内容")
_MIN_SNIPPET_CHARS = 40


def _looks_like_noise(snippet: str) -> bool:
    s = (snippet or "").strip()
    if len(s) < _MIN_SNIPPET_CHARS:
        return True
    return sum(s.count(m) for m in _NOISE_MARKERS) >= 3


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
            if isinstance(r, dict) and r.get("text") and not _looks_like_noise(r.get("text")):
                out.append({
                    "text": r.get("text", ""),
                    "url": r.get("url", ""),
                    "title": r.get("title", ""),
                    "publishedDate": r.get("publishedDate", ""),
                })
    return out


def search(query: str, *, num_results: int = _MAX_RESULTS) -> dict | None:
    """Search the web via AgentCore. Returns ``{"text","sources"}`` or **None**.

    None signals "unavailable / failed"; the caller (core/web_search.py) turns it into an
    empty result. Never raises. ``sources`` mirrors the aws_docs tools' shape so the UI
    Sources drawer renders identically.
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
        return None  # empty / all-noise / failed → caller returns an empty result

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
