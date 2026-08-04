"""
Client for the awslabs billing-cost-management-mcp-server sidecar.

⚠️ This MCP was retired from the bot on 2026-05-30 (see core/bedrock_chat.py
header) because the awslabs cost-explorer tool returns `preview` snapshots
backed by a sidecar SQLite (forcing a follow-up `session-sql` query) and the
SERVICE dimension has aliases that produce inconsistent numbers from a chat
interface. It was re-enabled 2026-06-04 for evaluation (Issue "B"). If the
known reliability problems resurface, set EnableMcpCost=false to drop it again —
no code change needed.

Exposes the read-only cost-analysis tools only (explicit allowlist, enforced at
both tools/list and call_tool time). Mirrors core/aws_pricing_mcp.py.

Sidecar contract:
  - endpoint default: http://127.0.0.1:8003/mcp
  - server uses the task-role credentials (needs ce/budgets/compute-optimizer/
    cost-optimization-hub read perms — granted by the McpCostReadOnly task
    policy when EnableMcpCost=true)
"""
from __future__ import annotations

import logging
import os
from typing import Any

from .mcp_http_client import McpHttpClient

logger = logging.getLogger(__name__)

_ENDPOINT = os.environ.get(
    "AWS_COST_MCP_ENDPOINT", "http://127.0.0.1:8003/mcp",
)

# Read-only cost-analysis tools from the awslabs billing-cost-management MCP
# server. These are the server's ACTUAL (coarse, hyphenated) tool names — each
# is a meta-tool driven by an `operation` arg. `session-sql` is required because
# `cost-explorer` returns a preview snapshot backed by a sidecar SQLite that
# must be queried for the full result. Mutating/niche billing-conductor tools
# stay hidden.
_ALLOWED_TOOLS = {
    "cost-explorer",
    "cost-anomaly",
    "cost-comparison",
    "cost-optimization",
    "compute-optimizer",
    "ri-performance",
    "sp-performance",
    "budgets",
    "free-tier-usage",
    "storage-lens",
    "rec-details",
    "session-sql",
}

_MAX_RESULT_CHARS = 8000

_client = McpHttpClient(_ENDPOINT, name="cost", timeout=20.0)

_COST_TOOL_AUTH_PREFIX = (
    "[AUTHORIZED, SAFE — read-only AWS Billing & Cost Management API call. "
    "Call directly when the user asks about actual spend / bill / cost trend / "
    "savings / RI-SP coverage. Cost Explorer dates are UTC and End is "
    "exclusive. If a result says rows were stored in a table (preview mode), "
    "call `aws_cost_session-sql` to read the actual numbers before answering. "
    "Do NOT tell the user to open the Console themselves.] "
)


def _bot_tool_name(upstream_name: str) -> str:
    return f"aws_cost_{upstream_name}"


def _from_bot_tool_name(bot_name: str) -> str | None:
    if not bot_name.startswith("aws_cost_"):
        return None
    return bot_name[len("aws_cost_"):]


def list_tools_for_llm() -> list[dict[str, Any]]:
    """Bedrock-shaped descriptors for the allowed cost tools. Returns ``[]``
    if the sidecar is unreachable or none of the allowed tools are present
    (degrades silently)."""
    if not _client.is_available():
        return []
    out: list[dict[str, Any]] = []
    for t in _client.list_tools():
        name = (t.get("name") or "").strip()
        if name not in _ALLOWED_TOOLS:
            continue
        base_desc = (t.get("description") or "").strip() or f"AWS cost tool: {name}"
        out.append({
            "name": _bot_tool_name(name),
            "description": _COST_TOOL_AUTH_PREFIX + base_desc,
            "input_schema": t.get("inputSchema") or {"type": "object",
                                                     "properties": {}},
        })
    return out


def call_tool(bot_tool_name: str, arguments: dict[str, Any]) -> tuple[bool, str]:
    """Dispatch a Bedrock tool_use call into the sidecar. Re-checks the
    allowlist (defense in depth)."""
    upstream = _from_bot_tool_name(bot_tool_name)
    if not upstream or upstream not in _ALLOWED_TOOLS:
        return False, f"tool not allowed: {bot_tool_name}"
    result = _client.call_tool(upstream, arguments)
    if result is None:
        return False, "cost MCP unreachable or returned an error"
    text = _client.coerce_text(result)
    if not text:
        return True, "(empty response)"
    if len(text) > _MAX_RESULT_CHARS:
        text = (text[:_MAX_RESULT_CHARS]
                + "\n\n[OUTPUT TRUNCATED — narrow the query "
                + "(specific time period, service, or granularity).]")
    return True, text


def is_available() -> bool:
    return _client.is_available()
