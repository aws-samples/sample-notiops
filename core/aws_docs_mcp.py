"""
AWS Documentation / Knowledge MCP client.

Calls the publicly hosted ``knowledge-mcp.global.api.aws`` server (streamable
HTTP transport defined by the Model Context Protocol spec) to ground
Bedrock answers in authoritative AWS sources: docs.aws.amazon.com,
What's New, blogs, code samples, Workshops.

Why hosted, not self-deployed:
  - AWS publishes & maintains the server, so we always get the latest
    docs index without redeploying.
  - One HTTP endpoint = no extra infrastructure on our side.
  - Same MCP protocol; if we later need a private knowledge source
    (internal wiki / Confluence) we add another client without
    changing call sites.

Boundary contract (zero-change promise):
  - This module ONLY does read-only retrieval. It never makes a tool
    call that mutates customer state. The hosted MCP server itself
    only exposes search / fetch tools.
  - Failures (network / parse / timeout / 4xx / 5xx) are swallowed —
    the caller falls back to a non-MCP answer rather than surfacing
    an error to the user.
  - URLs returned by the server are kept verbatim and validated against
    an AWS host allowlist before being shown back to users — this
    prevents an upstream-injected URL from being echoed as an
    "official source".

Operating constraints:
  - Total HTTP timeout 5s per call (connect 2s + read 3s).
  - Up to 5 search hits returned to the caller; longer responses are
    truncated. Each hit's snippet capped at 600 chars to bound the
    prompt token budget.
  - No HMAC signing required — the hosted endpoint is unauthenticated
    public access.
"""
from __future__ import annotations
from core.net import safe_urlopen

import json as _json
import logging
import os
import re
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Hosted MCP server published by awslabs/mcp. Streamable HTTP endpoint.
# https://github.com/awslabs/mcp/tree/main/src/aws-knowledge-mcp-server
_MCP_ENDPOINT = os.environ.get(
    "AWS_KNOWLEDGE_MCP_ENDPOINT",
    "https://knowledge-mcp.global.api.aws",
)

# Per-call HTTP timeout. The MCP server is internet-hosted; if it's slow
# we'd rather fall back to a non-MCP answer than make the user wait.
_HTTP_TIMEOUT_SECONDS = float(os.environ.get("AWS_MCP_HTTP_TIMEOUT", "5.0"))

# Cap how many results we keep per search. The model cares more about
# the top 3-5 hits than a long tail, and each hit costs prompt tokens.
_MAX_SEARCH_HITS = 5
_MAX_SNIPPET_CHARS = 600

# URL host allowlist — only URLs from these hosts may be shown back to
# users as "📚 来源". Anything else is dropped silently. This is a
# defense-in-depth check on top of the upstream server's own promise
# to only return AWS URLs.
#
# Matches:  exact host, or any subdomain.
# Mirrors the upstream MCP server's URL allowlist so we never accept a
# host the server itself wouldn't read. Plus a few AWS subdomains the
# server explicitly returns (repost.aws, docs.amplify.aws, etc.).
_ALLOWED_HOSTS = (
    "aws.amazon.com",
    "docs.aws.amazon.com",
    "amazonaws.cn",
    "aws.amazon.com.cn",
    "awsstatic.com",
    # Re:Post knowledge center articles — search hits often link here
    "repost.aws",
    # Amplify dev docs
    "docs.amplify.aws",
    "ui.docs.amplify.aws",
    # Strands Agents docs (AWS-published)
    "strandsagents.com",
    # CDK / awslabs code references
    "github.com",
    "constructs.dev",
)


def _is_allowed_url(url: str) -> bool:
    """Return True iff ``url`` is on the AWS-related host allowlist.

    Drops any URL that:
      - is not http/https
      - has no hostname
      - host doesn't match an allowlist entry as exact or *.<entry>

    The MCP server is supposed to only return AWS docs / blog URLs, but
    we audit every URL anyway in case an injected document tries to
    smuggle a phishing link into a citation list.
    """
    try:
        p = urlparse(url)
    except Exception:
        return False
    if p.scheme not in ("http", "https"):
        return False
    host = (p.hostname or "").lower()
    if not host:
        return False
    return any(host == h or host.endswith("." + h) for h in _ALLOWED_HOSTS)


# ---------------------------------------------------------------------------
# Public types
# ---------------------------------------------------------------------------
def _empty_search_result() -> dict[str, Any]:
    return {"hits": [], "queried": ""}


# ---------------------------------------------------------------------------
# MCP JSON-RPC over streamable HTTP
# ---------------------------------------------------------------------------
# Tool name prefix used by the hosted server. All tools are namespaced
# under "aws___" (the server registers them via FastMCP). We expose a
# clean public API (`search_documentation` / `read_documentation`) but
# call the prefixed names under the hood.
_TOOL_NS = "aws___"


# MCP's streamable-HTTP transport speaks JSON-RPC 2.0 over a single POST
# per call. The server responds with either a Server-Sent-Events stream
# (when streaming) or a single JSON body (when not). For the
# search/fetch tools we only need the final result, so we read the
# whole body and parse the last JSON-RPC envelope we find.
#
# Request shape:
#   {
#     "jsonrpc": "2.0",
#     "id": <int>,
#     "method": "tools/call",
#     "params": {"name": "<tool>", "arguments": {...}}
#   }
def _mcp_call(tool: str, arguments: dict[str, Any]) -> dict[str, Any] | None:
    """Invoke an MCP tool and return its parsed JSON content, or None on
    any failure. Never raises."""
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {"name": _TOOL_NS + tool, "arguments": arguments},
    }
    body = _json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _MCP_ENDPOINT,
        data=body,
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
        logger.warning("aws_docs_mcp: %s HTTP %s", tool, e.code)
        return None
    except urllib.error.URLError as e:
        logger.warning("aws_docs_mcp: %s URL error: %s", tool, e.reason)
        return None
    except Exception as e:
        logger.warning("aws_docs_mcp: %s unexpected error: %s", tool, e)
        return None

    # SSE responses prepend "data: " on each line. Strip & rejoin.
    if "\n" in raw and raw.lstrip().startswith("event:") or "data:" in raw[:64]:
        chunks: list[str] = []
        for line in raw.splitlines():
            if line.startswith("data: "):
                chunks.append(line[len("data: "):])
        candidate = "".join(chunks).strip() or raw.strip()
    else:
        candidate = raw.strip()

    try:
        envelope = _json.loads(candidate)
    except _json.JSONDecodeError:
        logger.warning("aws_docs_mcp: %s non-JSON body: %r", tool, candidate[:200])
        return None

    if "error" in envelope:
        logger.warning("aws_docs_mcp: %s server error: %s", tool, envelope["error"])
        return None

    return envelope.get("result")


def _coerce_text_blocks(result: dict[str, Any] | None) -> str:
    """MCP tools return content as a list of {type, text|json} blocks.
    Concatenate the text content into a single string so callers can
    parse it as JSON if the tool emits structured data."""
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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def search_documentation(query: str, *, limit: int = _MAX_SEARCH_HITS) -> dict[str, Any]:
    """Search AWS knowledge sources for ``query``.

    Returns ``{"hits": [...], "queried": query}``. Each hit is::

        {
            "title": str,
            "url": str,           # already passed the host allowlist
            "snippet": str,       # truncated to _MAX_SNIPPET_CHARS
            "source": str,        # e.g. "docs" / "blog" / "what's new"
        }

    Returns an empty hit list on any failure. Never raises.
    """
    query = (query or "").strip()
    if not query:
        return _empty_search_result()
    if len(query) > 400:
        query = query[:400]

    result = _mcp_call("search_documentation", {
        "search_phrase": query,
        "limit": min(max(limit, 1), _MAX_SEARCH_HITS),
        # Cast a wide net by default. The hosted server treats topics as
        # filters, not requirements, and "general" alone misses
        # reference / troubleshooting hits.
        "topics": ["general", "reference_documentation", "troubleshooting"],
    })
    text = _coerce_text_blocks(result)
    if not text:
        return _empty_search_result()

    # The hosted server returns search hits as either a JSON array or a
    # JSON object with a "results" / "hits" key. Try both shapes.
    try:
        data = _json.loads(text)
    except _json.JSONDecodeError:
        # Some MCP servers stream NDJSON-ish blocks. Take the last
        # parseable JSON value we find.
        data = None
        for line in reversed(text.strip().splitlines()):
            try:
                data = _json.loads(line)
                break
            except _json.JSONDecodeError:
                continue
    if not data:
        return _empty_search_result()

    # Hosted server wraps the list two layers deep:
    #   {"content": {"result": [ ... ]}}
    # Older awslabs revisions return {"results": [...]} or just a list.
    # Try all in order.
    items: list[Any] = []
    if isinstance(data, dict):
        nested = data.get("content")
        if isinstance(nested, dict):
            items = nested.get("result") or nested.get("results") \
                or nested.get("hits") or nested.get("items") or []
        if not items:
            items = data.get("results") or data.get("hits") \
                or data.get("items") or []
    elif isinstance(data, list):
        items = data

    hits: list[dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        url = it.get("url") or it.get("link") or ""
        if not _is_allowed_url(url):
            continue
        title = (it.get("title") or it.get("heading") or "").strip()
        # Hosted MCP server returns the excerpt in `context`. Other field
        # names tolerated for forward compatibility.
        snippet = (it.get("context") or it.get("snippet")
                   or it.get("description") or it.get("text") or "").strip()
        source = (it.get("source") or it.get("type")
                  or it.get("topic") or "").strip()
        if len(snippet) > _MAX_SNIPPET_CHARS:
            snippet = snippet[:_MAX_SNIPPET_CHARS] + "…"
        hits.append({
            "title": title or url,
            "url": url,
            "snippet": snippet,
            "source": source,
        })
        if len(hits) >= limit:
            break

    return {"hits": hits, "queried": query}


def recommend_documentation(url: str) -> dict[str, Any]:
    """Fetch related-page recommendations for a given AWS docs URL.

    Returns ``{"hits": [...], "queried": url}`` mirroring `search_documentation`
    so the bedrock_chat dispatch + citation-rendering paths can reuse the
    same machinery. Each hit is::

        {"title": str, "url": str, "snippet": str, "source": "highly_rated"|"new"|"similar"|"journey"}

    The hosted MCP server's `aws___recommend` returns four buckets
    (Highly Rated / New / Similar / Journey) keyed by the input URL.
    """
    url = (url or "").strip()
    if not url:
        return _empty_search_result()
    if not _is_allowed_url(url):
        return _empty_search_result()

    result = _mcp_call("recommend", {"url": url})
    text = _coerce_text_blocks(result)
    if not text:
        return _empty_search_result()

    try:
        data = _json.loads(text)
    except _json.JSONDecodeError:
        return _empty_search_result()

    # The hosted server returns recommendations as a flat list of
    # `{url, title, context}` items, double-wrapped:
    #   {"content": {"result": [ ... ]}}
    # The `context` field describes the bucket (e.g. "Intent: Learn
    # about" / "New content added on …" / topical summary). Older
    # revisions return a dict-of-lists keyed by bucket; tolerate both.
    items: list[Any] = []
    if isinstance(data, dict):
        nested = data.get("content")
        if isinstance(nested, dict):
            inner = nested.get("result") or nested.get("results")
            if isinstance(inner, list):
                items = inner
            elif isinstance(inner, dict):
                # bucket-keyed shape
                for v in inner.values():
                    if isinstance(v, list):
                        items.extend(v)
        if not items:
            for v in data.values():
                if isinstance(v, list):
                    items.extend(v)
    elif isinstance(data, list):
        items = data

    hits: list[dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        u = it.get("url") or it.get("link") or ""
        if not _is_allowed_url(u):
            continue
        title = (it.get("title") or it.get("heading") or "").strip()
        snippet = (it.get("context") or it.get("description")
                   or it.get("text") or "").strip()
        if len(snippet) > _MAX_SNIPPET_CHARS:
            snippet = snippet[:_MAX_SNIPPET_CHARS] + "…"
        # `context` often indicates the bucket — surface it as `source`
        # so the citation block can show "(Recommended)" / "(New)" etc.
        source = (it.get("source") or "").strip().lower()
        if not source:
            ctx_lc = snippet.lower()
            if "intent: learn" in ctx_lc:
                source = "similar"
            elif "intent: how to" in ctx_lc:
                source = "journey"
            elif "new content added" in ctx_lc:
                source = "new"
            else:
                source = "highly_rated"
        hits.append({
            "title": title or u,
            "url": u,
            "snippet": snippet,
            "source": source,
        })
        if len(hits) >= _MAX_SEARCH_HITS:
            break

    return {"hits": hits, "queried": url}


def list_regions() -> list[dict[str, str]]:
    """List all AWS regions. Returns a list of ``{"id": "us-east-1",
    "name": "US East (N. Virginia)"}`` dicts. Empty list on failure."""
    result = _mcp_call("list_regions", {})
    text = _coerce_text_blocks(result)
    if not text:
        return []
    try:
        data = _json.loads(text)
    except _json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        nested = data.get("content")
        if isinstance(nested, dict):
            data = nested.get("result") or nested
        items = data if isinstance(data, list) else \
                data.get("regions") or data.get("results") or []
    elif isinstance(data, list):
        items = data
    else:
        return []
    out: list[dict[str, str]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        rid = (it.get("region_id") or it.get("regionId")
               or it.get("id") or it.get("code") or "").strip()
        rname = (it.get("region_long_name") or it.get("regionLongName")
                 or it.get("name") or it.get("displayName") or "").strip()
        if rid:
            out.append({"id": rid, "name": rname})
    return out


def get_regional_availability(*, regions: list[str], resource_type: str,
                              filters: list[str] | None = None) -> dict[str, Any]:
    """Check whether AWS products / APIs / CloudFormation resource types
    are available in given regions. Wraps the upstream
    `aws___get_regional_availability` tool.

    Parameters
    ----------
    regions : up to 10 AWS region codes.
    resource_type : "product" | "api" | "cfn"
    filters : optional list of resource identifiers (e.g.
        ["AWS Lambda"], ["Lambda+Invoke"], ["AWS::EC2::Instance"]).

    Returns the upstream payload or ``{"error": "..."}`` on failure.
    """
    if not regions or not resource_type:
        return {"error": "regions and resource_type required"}
    if resource_type not in {"product", "api", "cfn"}:
        return {"error": "resource_type must be product / api / cfn"}
    args: dict[str, Any] = {"regions": regions[:10], "resource_type": resource_type}
    if filters:
        args["filters"] = filters[:20]
    result = _mcp_call("get_regional_availability", args)
    text = _coerce_text_blocks(result)
    if not text:
        return {"error": "empty response"}
    try:
        return _json.loads(text)
    except _json.JSONDecodeError:
        return {"raw": text[:_MAX_SNIPPET_CHARS]}


def read_documentation(url: str, *, max_chars: int = 4000) -> str:
    """Fetch the full text of a single AWS doc page via the MCP server.

    Returns the page body (truncated to ``max_chars`` chars), or an
    empty string on failure. Always validates the URL against the
    host allowlist first — even our own search results have to pass it
    again because the input may have come from elsewhere.
    """
    if not _is_allowed_url(url):
        return ""

    # Hosted server takes a `requests` array (batch read). We send one
    # request and pull its body.
    result = _mcp_call("read_documentation", {
        "requests": [{"url": url, "max_length": max_chars}],
    })
    text = _coerce_text_blocks(result)
    if not text:
        return ""
    if len(text) > max_chars:
        text = text[:max_chars]
    return text


# ---------------------------------------------------------------------------
# Test hooks
# ---------------------------------------------------------------------------
def _is_allowed_url_for_test(url: str) -> bool:
    """Public-by-convention alias for unit tests."""
    return _is_allowed_url(url)
