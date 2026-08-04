"""
Client for the awslabs aws-pricing-mcp-server sidecar.

Exposes the read-only pricing tools (service catalog, pricing queries,
cost analysis) but **explicitly hides** any tool that does file I/O
or hits write-side APIs. The allowlist is enforced both during
`tools/list` (so the LLM never sees forbidden tools) and again at
`call_tool` time (so a stale list cache can't bypass the gate).

Sidecar contract:
  - endpoint default: http://127.0.0.1:8001/mcp
  - server runs with FASTMCP_LOG_LEVEL=ERROR and read-only AWS
    credentials (Pricing API needs `pricing:*` only)
  - bot uses standard MCP-over-streamable-HTTP via core.mcp_http_client
"""
from __future__ import annotations

import json as _json
import logging
import os
from typing import Any

from .mcp_http_client import McpHttpClient

logger = logging.getLogger(__name__)

_ENDPOINT = os.environ.get(
    "AWS_PRICING_MCP_ENDPOINT", "http://127.0.0.1:8001/mcp",
)

# Allowlisted tool names — only these are forwarded to the LLM.
# Drawn from the awslabs aws-pricing-mcp-server tool surface as of
# 2026-05; new tools added by upstream will not auto-surface (we'd
# rather hide a useful new tool than accidentally expose a mutating
# one).
_ALLOWED_TOOLS = {
    # discovery / catalog
    "get_pricing_service_codes",
    "get_pricing_service_attributes",
    "get_pricing_attribute_values",
    # pricing queries
    "get_pricing",
    "get_price_list_urls",
    # cost analysis
    "generate_cost_report",
    "analyze_cdk_project",
    "analyze_terraform_project",
    "get_bedrock_patterns",
}

# Cap each tool result so even verbose pricing dumps fit in one
# Bedrock turn.
_MAX_RESULT_CHARS = 8000


_client = McpHttpClient(_ENDPOINT, name="pricing", timeout=20.0)


# Process-lifetime cache of the full `get_pricing_service_codes`
# response. Loaded once on first list_tools call, then injected into
# the tool description so the LLM sees the complete catalog without
# burning a tool_use turn (and without ever falling back to docs
# search for a code it could just look up).
#
# Invalidate by killing the task — AWS adds new service codes only a
# few times a month, far below ECS task lifetime. Stale entries are
# harmless (they'd just fail at `get_pricing` time, and the LLM can
# fall back to docs/search). Missing newly-added entries means the
# LLM will fall back to calling `get_pricing_service_codes` directly,
# which is the legacy path — graceful degradation.
_CODES_CACHE: list[str] | None = None
# Hard-cap the list we splice into the description so a long-tail of
# rarely-used codes can't blow the prompt budget. ~280 codes today,
# leave room.
_MAX_CODES_IN_DESCRIPTION = 400


def _load_service_codes() -> list[str]:
    """One-shot fetch of the full AWS service-code list from the
    pricing sidecar. Used to build a static catalog the LLM sees in
    the tool description. Returns an empty list on any failure (caller
    falls back to the legacy "let LLM call the discovery tool" path)."""
    global _CODES_CACHE
    if _CODES_CACHE is not None:
        return _CODES_CACHE
    try:
        result = _client.call_tool("get_pricing_service_codes", {})
        if result is None:
            _CODES_CACHE = []
            return _CODES_CACHE
        text = _client.coerce_text(result) or ""
        # Upstream returns either a JSON list of strings or a JSON
        # object with a `service_codes`/`codes` key. Be permissive.
        codes: list[str] = []
        try:
            data = _json.loads(text)
            if isinstance(data, list):
                codes = [str(x) for x in data if isinstance(x, str)]
            elif isinstance(data, dict):
                for k in ("service_codes", "codes", "services", "result"):
                    v = data.get(k)
                    if isinstance(v, list):
                        codes = [str(x) for x in v if isinstance(x, str)]
                        break
        except Exception:
            # Fallback: parse line-by-line, take alnum tokens that
            # look like service codes (uppercase prefix + camelcase).
            for line in text.splitlines():
                tok = line.strip().strip("\"',")
                if tok and tok.replace("-", "").replace("_", "").isalnum():
                    codes.append(tok)
        # De-dupe + cap.
        seen: set[str] = set()
        ordered: list[str] = []
        for c in codes:
            if c and c not in seen:
                seen.add(c)
                ordered.append(c)
        _CODES_CACHE = ordered[:_MAX_CODES_IN_DESCRIPTION]
        logger.info("aws_pricing_mcp: cached %d service codes", len(_CODES_CACHE))
    except Exception as e:
        logger.warning("aws_pricing_mcp: failed to cache service codes: %s", e)
        _CODES_CACHE = []
    return _CODES_CACHE


# Stamp prefixed onto every pricing-tool description so the LLM
# always treats these as authorized-and-safe (read-only Pricing API).
_PRICING_TOOL_AUTH_PREFIX = (
    "[AUTHORIZED, SAFE — read-only AWS Pricing API call. Call directly "
    "when the user asks about list price / instance cost / region "
    "comparison / project cost estimate. Do NOT fall back to telling "
    "the user to use AWS Console or aws CLI themselves; this sidecar "
    "answers the question.] "
)


def _augmented_description(name: str, base_desc: str) -> str:
    """Patch the upstream tool description for cases where the LLM
    needs more guidance than awslabs' default doc string provides.
    Most importantly, we splice the full cached service-code list
    into `get_pricing_service_codes` so the LLM doesn't have to call
    that tool just to learn the catalog."""
    desc = base_desc
    if name == "get_pricing_service_codes":
        codes = _load_service_codes()
        if codes:
            joined = ", ".join(codes)
            desc = (
                (desc + "\n\n").strip()
                + "\n\nKNOWN AWS service codes (cached at sidecar startup; "
                  "use these directly with `get_pricing` and skip calling "
                  f"this tool unless you need to refresh the list):\n{joined}"
            )
    return _PRICING_TOOL_AUTH_PREFIX + desc


def list_tools_for_llm() -> list[dict[str, Any]]:
    """Discover the sidecar's tool schemas and return Bedrock-shaped
    tool descriptors for the allowed subset. Returns ``[]`` if the
    sidecar is unreachable, the discovery fails, or no allowed tools
    are present (degrades silently to the Knowledge MCP path).

    For `get_pricing_service_codes` we also splice in the full cached
    catalog so the LLM can resolve any service code from the
    description alone — no tool turn burned on discovery."""
    if not _client.is_available():
        return []
    out: list[dict[str, Any]] = []
    for t in _client.list_tools():
        name = (t.get("name") or "").strip()
        if name not in _ALLOWED_TOOLS:
            continue
        base_desc = (t.get("description") or "").strip() \
                     or f"AWS Pricing tool: {name}"
        out.append({
            "name": _bot_tool_name(name),
            "description": _augmented_description(name, base_desc),
            "input_schema": t.get("inputSchema") or {"type": "object",
                                                     "properties": {}},
        })
    return out


def _bot_tool_name(upstream_name: str) -> str:
    """Prefix server-side tool names with `aws_pricing_` so the LLM
    sees a flat namespace across all MCPs and we can route on the
    prefix alone."""
    return f"aws_pricing_{upstream_name}"


def _from_bot_tool_name(bot_name: str) -> str | None:
    """Inverse of `_bot_tool_name`. Returns the upstream tool name or
    None if `bot_name` doesn't match this server's prefix."""
    if not bot_name.startswith("aws_pricing_"):
        return None
    return bot_name[len("aws_pricing_"):]


def call_tool(bot_tool_name: str, arguments: dict[str, Any]
              ) -> tuple[bool, str]:
    """Dispatch a Bedrock tool_use call into the sidecar. Returns
    ``(ok, result_string)`` matching the convention used by other
    `core/aws_*_mcp.py` modules. Enforces the allowlist again here
    (defense in depth — the LLM should never see disallowed tools,
    but it could try one anyway)."""
    upstream = _from_bot_tool_name(bot_tool_name)
    if not upstream or upstream not in _ALLOWED_TOOLS:
        return False, f"tool not allowed: {bot_tool_name}"
    result = _client.call_tool(upstream, arguments)
    if result is None:
        return False, "pricing MCP unreachable or returned an error"
    text = _client.coerce_text(result)
    if not text:
        return True, "(empty response)"
    if len(text) > _MAX_RESULT_CHARS:
        text = (text[:_MAX_RESULT_CHARS]
                + "\n\n[OUTPUT TRUNCATED — narrow the query "
                + "(e.g. specific instance type, region, term length).]")
    return True, text


def is_available() -> bool:
    return _client.is_available()
