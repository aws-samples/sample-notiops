"""
Web Search via Exa's public MCP endpoint (https://mcp.exa.ai/mcp).

Mirrors core/aws_docs_mcp.py's synchronous JSON-RPC-over-HTTP pattern so the
agent can reach current external info that AWS docs don't cover. Used only as
the LAST step of the answer chain (AWS docs → professional knowledge → web),
and ONLY when the user explicitly enables web search for that turn.

隐私边界（重要）：
  - 这是**第三方**搜索（Exa AI），用户的查询文本会离开 AWS。仅在用户
    主动开启"联网搜索"开关时才会被调用；默认关闭。
  - 公开端点、无需鉴权；无 SLA。若上游限流/失败，安静返回空结果，让模型
    回退到非联网回答，而不是把错误抛给用户。

Operating constraints (与 aws_docs_mcp 一致):
  - 单次 HTTP 超时 8s（联网搜索比读文档慢，给宽一点）。
  - 最多保留 5 条结果；每条正文截断到 800 字以控 token。
  - 返回 {"text": <拼接正文>, "sources": [{icon,title,detail}]}，
    sources 直接喂给前端 Sources 抽屉（与 aws_docs 工具同形）。
"""
from __future__ import annotations
from core.net import safe_urlopen

import json as _json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

_EXA_ENDPOINT = os.environ.get("WEB_SEARCH_MCP_ENDPOINT", "https://mcp.exa.ai/mcp")
_HTTP_TIMEOUT_SECONDS = float(os.environ.get("WEB_SEARCH_HTTP_TIMEOUT", "8.0"))
_MAX_RESULTS = int(os.environ.get("WEB_SEARCH_MAX_RESULTS", "5"))
_MAX_SNIPPET_CHARS = 800


def _mcp_call(tool: str, arguments: dict) -> dict | None:
    """Invoke an Exa MCP tool over streamable-HTTP JSON-RPC. None on any failure."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    req = urllib.request.Request(
        _EXA_ENDPOINT,
        data=_json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-06-18",
        },
    )
    try:
        with safe_urlopen(req, timeout=_HTTP_TIMEOUT_SECONDS) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        logger.warning("web_search: %s HTTP %s", tool, e.code)
        return None
    except urllib.error.URLError as e:
        logger.warning("web_search: %s URL error: %s", tool, e.reason)
        return None
    except Exception as e:  # noqa: BLE001
        logger.warning("web_search: %s unexpected error: %s", tool, e)
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
        logger.warning("web_search: %s non-JSON body: %r", tool, candidate[:200])
        return None
    if "error" in envelope:
        logger.warning("web_search: %s server error: %s", tool, envelope["error"])
        return None
    return envelope.get("result")


def _coerce_text(result: dict | None) -> str:
    if not result:
        return ""
    parts: list[str] = []
    for blk in result.get("content", []) or []:
        if blk.get("type") == "text" and isinstance(blk.get("text"), str):
            parts.append(blk["text"])
        elif blk.get("type") == "json" and "json" in blk:
            try:
                parts.append(_json.dumps(blk["json"]))
            except Exception:  # noqa: BLE001
                pass
    return "\n".join(parts)


# JS 渲染的占位/无正文页面特征（如 aws.amazon.com/new/ 抓回来是一堆"Loading…"），
# 这类命中没有真实内容，反而会把模型带向训练记忆里的旧信息，必须丢弃。
_NOISE_MARKERS = ("正在加载", "Loading", "Skip to main content", "跳至主要内容")


def _looks_like_noise(snippet: str) -> bool:
    s = (snippet or "").strip()
    if len(s) < 40:
        return True
    # 正文里"Loading/正在加载"占比过高 → 判为占位页
    noise = sum(s.count(m) for m in _NOISE_MARKERS)
    return noise >= 3


def _parse_blocks(text: str) -> list[dict]:
    """Exa returns plain text blocks separated by '---', each starting with
    'Title: ...\\nURL: ...\\nPublished: ...\\n...Highlights:...'. Parse into
    structured hits, capturing the publish date (用于时效排序/展示)。"""
    hits: list[dict] = []
    for raw_block in text.split("\n---\n"):
        block = raw_block.strip()
        if not block:
            continue
        title, url, published, body_lines = "", "", "", []
        for line in block.splitlines():
            if line.startswith("Title:") and not title:
                title = line[len("Title:"):].strip()
            elif line.startswith("URL:") and not url:
                url = line[len("URL:"):].strip()
            elif line.startswith("Published:") and not published:
                published = line[len("Published:"):].strip()
            elif line.startswith(("Author:", "Highlights:")):
                continue
            else:
                body_lines.append(line)
        snippet = "\n".join(body_lines).strip()
        if _looks_like_noise(snippet):
            continue  # 丢弃占位/无正文页面
        if len(snippet) > _MAX_SNIPPET_CHARS:
            snippet = snippet[:_MAX_SNIPPET_CHARS] + "…"
        if published.upper() in ("N/A", "NONE"):
            published = ""
        if url or title:
            hits.append({"title": title or url, "url": url,
                         "published": published, "snippet": snippet})
        if len(hits) >= _MAX_RESULTS:
            break
    return hits


def search(query: str, *, num_results: int = _MAX_RESULTS) -> dict:
    """Search the web for ``query``. Returns ``{"text": str, "sources": [...]}``.

    **Provider order:** AWS-native **AgentCore Gateway web search** first (queries stay
    inside AWS), then fall back to **Exa** (third-party, data leaves AWS) if AgentCore is
    not configured or returns nothing. Public shape/behavior unchanged — empty on total
    failure, never raises. Set ``WEB_SEARCH_PROVIDER=exa`` to force Exa-only (skip AgentCore).
    """
    provider = os.environ.get("WEB_SEARCH_PROVIDER", "auto").strip().lower()
    if provider != "exa":
        try:
            from . import agentcore_search as _ac
            if _ac.configured():
                res = _ac.search(query, num_results=num_results)
                if res and res.get("text"):
                    return res  # AgentCore (in-AWS) succeeded
        except Exception as e:  # noqa: BLE001 — any issue → fall back to Exa
            logger.warning("web_search: AgentCore path failed, falling back to Exa: %s", e)
    return _exa_search(query, num_results=num_results)


def _exa_search(query: str, *, num_results: int = _MAX_RESULTS) -> dict:
    """Exa public-MCP search (third-party; query leaves AWS). Fallback path.
    ``text`` is a compact, model-readable summary of top hits; ``sources`` mirrors the
    aws_docs tools' shape. Empty on any failure (never raises)."""
    query = (query or "").strip()
    if not query:
        return {"text": "", "sources": []}
    if len(query) > 400:
        query = query[:400]

    # 多取几条（占位/噪声页会被过滤掉），保证有足够真实命中喂模型。
    result = _mcp_call("web_search_exa", {
        "query": query,
        "numResults": max(num_results, 8),
    })
    text = _coerce_text(result)
    if not text:
        return {"text": "", "sources": []}

    hits = _parse_blocks(text)
    if not hits:
        # 全是噪声/无法解析 — 退回原始文本（截断），仍交给模型，但提示其时效未知。
        return {"text": text[: _MAX_SNIPPET_CHARS * 3], "sources": []}

    lines, sources = [], []
    for h in hits:
        date = f" ({h['published']})" if h.get("published") else ""
        lines.append(f"- {h['title']}{date}\n  {h['url']}\n  {h['snippet']}")
        if h.get("url"):
            sources.append({"icon": "web", "title": h["title"], "detail": h["url"]})
    return {"text": "\n\n".join(lines), "sources": sources}
