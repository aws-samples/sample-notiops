"""
⚠️  RETIRED — kept for backward compatibility, not actively used.

Per-chat rolling investigation history. Originally fed multi-turn context
into the intent analyzer (so "在刚才那个 EC2 上再查一下安全组" could be
auto-rewritten into a self-contained query). The feature was retired
2026-05-27 — empirically the historical `investigate`
turns biased Bedrock toward `investigate` even on a 2-character "你好",
which broke the chitchat / general_qa path.

Current state:
  - Platform routers (`platforms/{feishu,slack}/app/main.py`) no longer
    call `get_history()` / `append_entry()` / `bump_chitchat_count()`.
  - `bedrock_intent.analyze_intent(history=...)` accepts the parameter
    for signature compatibility but ignores it.
  - The DDB rows already in production decay naturally via the 7-day TTL.

Why keep the module at all:
  - `bump_chitchat_count` is referenced by an experimental nudge feature
    that may come back.
  - Future work (#7 cross-investigation memory) might reuse the storage
    layer.

If you decide to remove this module entirely:
  1. Remove the `chitchat_count` write in `append_entry` (line ~95-100).
  2. Drop `from core import chat_history` imports in platforms / lambda.
  3. Optionally clean up old DDB rows with prefix `chat_history#`.

DDB schema (left in place for any historical row that's still ticking):
    lookup_key = chat_history#<platform>#<chat_id>
    entries    = [{ts, raw_text, intent_summary, resources, region, account}, ...]
    ttl        = epoch + 7 days

Failures are non-fatal — every read/write swallows exceptions.
"""
from __future__ import annotations

import logging
import time
from typing import Iterable

from . import ddb_state

logger = logging.getLogger(__name__)


def _safe_err(e: Exception) -> str:
    """Sensitive-data handling: return the exception *type* (plus the AWS
    error code for botocore ClientError), never the raw message / response body
    which can embed request payloads or user data. See docs/LOGGING_STANDARD.md."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


MAX_ENTRIES = 5
TTL_SECONDS = 7 * 24 * 3600


def _key(platform: str, chat_id: str) -> str:
    return f"chat_history#{platform}#{chat_id}"


def get_history(platform: str, chat_id: str) -> list[dict]:
    """Return the latest list of history entries (oldest → newest), or
    an empty list when none exists / the read fails. Never raises."""
    if not platform or not chat_id:
        return []
    try:
        item = ddb_state._table.get_item(
            Key={"lookup_key": _key(platform, chat_id)}
        ).get("Item")
        if not item:
            return []
        entries = item.get("entries") or []
        if not isinstance(entries, list):
            return []
        return entries
    except Exception as e:
        logger.warning("chat_history get failed for %s#%s: %s",
                       platform, chat_id, _safe_err(e))
        return []


def append_entry(platform: str, chat_id: str, *,
                 raw_text: str,
                 intent_summary: str,
                 incident_id: str = "",
                 resources: Iterable[str] = (),
                 region: str = "",
                 account: str = "") -> None:
    """Push one entry onto the rolling window. Best effort — logs and
    swallows on failure (chat history is enrichment, not a hard requirement).

    The function reads-then-writes. We don't bother with conditional
    writes / optimistic locking: in the rare case of two concurrent
    @-mentions racing each other, losing one history slot is harmless.

    Side effect: this also resets the chitchat counter to zero. The
    counter only tracks **consecutive** non-action turns since the last
    real investigation / case action, so any successful dispatch is the
    natural reset point. See `bump_chitchat_count` / `get_chitchat_count`.
    """
    if not platform or not chat_id or not raw_text:
        return
    entry = {
        "ts": int(time.time()),
        "raw_text": (raw_text or "")[:500],
        "intent_summary": (intent_summary or "")[:200],
    }
    if incident_id:
        entry["incident_id"] = incident_id
    if resources:
        entry["resources"] = [str(r)[:80] for r in resources][:8]
    if region:
        entry["region"] = region[:32]
    if account:
        entry["account"] = account[:32]

    history = get_history(platform, chat_id)
    history.append(entry)
    if len(history) > MAX_ENTRIES:
        history = history[-MAX_ENTRIES:]

    try:
        ddb_state._table.put_item(Item={
            "lookup_key": _key(platform, chat_id),
            "platform": platform,
            "chat_id": chat_id,
            "entries": history,
            # Real action just happened — counter resets so the next
            # chitchat / general_qa turn starts fresh.
            "chitchat_count": 0,
            "ttl": int(time.time()) + TTL_SECONDS,
        })
    except Exception as e:
        logger.warning("chat_history put failed for %s#%s: %s",
                       platform, chat_id, _safe_err(e))


def get_chitchat_count(platform: str, chat_id: str) -> int:
    """Read the consecutive chitchat / general_qa turn count for this
    chat. Returns 0 when missing / on read error.

    The counter exists so `bedrock_chat.respond()` knows whether to
    append the soft "回到主题" guidance after the user has been off-topic
    for several turns. Reset by `append_entry()` on any successful
    investigate / case_* dispatch.
    """
    if not platform or not chat_id:
        return 0
    try:
        item = ddb_state._table.get_item(
            Key={"lookup_key": _key(platform, chat_id)}
        ).get("Item") or {}
        return int(item.get("chitchat_count") or 0)
    except Exception as e:
        logger.warning("chat_history get_chitchat_count failed for %s#%s: %s",
                       platform, chat_id, _safe_err(e))
        return 0


def bump_chitchat_count(platform: str, chat_id: str) -> int:
    """Increment the chitchat counter atomically; return the new value.

    Used by the platform router after responding to a chitchat /
    general_qa intent. We use a DDB ADD update with a default-zero
    initial value; if the row didn't exist yet the counter starts at 1.
    On any error we return the best-effort prior value + 1 so the
    caller still sees forward progress (the guidance tail tolerates a
    stale/wrong count).
    """
    if not platform or not chat_id:
        return 0
    try:
        resp = ddb_state._table.update_item(
            Key={"lookup_key": _key(platform, chat_id)},
            UpdateExpression=(
                "SET platform = if_not_exists(platform, :p), "
                "chat_id = if_not_exists(chat_id, :c), "
                "#ttl = :ttl "
                "ADD chitchat_count :one"
            ),
            ExpressionAttributeNames={"#ttl": "ttl"},
            ExpressionAttributeValues={
                ":p": platform,
                ":c": chat_id,
                ":ttl": int(time.time()) + TTL_SECONDS,
                ":one": 1,
            },
            ReturnValues="UPDATED_NEW",
        )
        return int((resp.get("Attributes") or {}).get("chitchat_count") or 1)
    except Exception as e:
        logger.warning("chat_history bump_chitchat_count failed for %s#%s: %s",
                       platform, chat_id, _safe_err(e))
        return get_chitchat_count(platform, chat_id) + 1


def format_for_prompt(history: list[dict], max_chars: int = 1200) -> str:
    """Render the history into a compact text block for the LLM system
    prompt. Returns '' when no history. Trims oldest entries if the
    rendered block would exceed `max_chars`."""
    if not history:
        return ""
    parts: list[str] = []
    for i, e in enumerate(history, 1):
        bits = [f"#{i}", e.get("intent_summary") or e.get("raw_text", "")]
        if e.get("resources"):
            bits.append("resources=" + ",".join(e["resources"]))
        if e.get("region"):
            bits.append(f"region={e['region']}")
        if e.get("account"):
            bits.append(f"account={e['account']}")
        parts.append(" | ".join(b for b in bits if b))
    rendered = "\n".join(parts)
    if len(rendered) <= max_chars:
        return rendered
    # Drop oldest until we fit
    while parts and len("\n".join(parts)) > max_chars:
        parts.pop(0)
    return "\n".join(parts)
