"""
DynamoDB conversation state — shared across all chat platforms.

Single table; same business row indexed by multiple lookup_key prefixes:
  event#<event_id>      -- idempotency on platform event id (or message ts)
  incident#<id>         -- key passed to DevOps Agent webhook
                           conventionally `<platform>-<event_id>` so it's
                           globally unique across platforms
  task#<id>             -- fallback when DevOps Agent doesn't echo incident_id
  support#<incident_id> -- written by report-handler with case-creation context

Every row carries a `platform` field ("feishu" / "slack") so
the report-handler's sender router can dispatch results back to the right IM.

TTL on `ttl` (epoch seconds) auto-cleans rows after ~24h (events/incidents)
or ~7d (support context — matches presigned report URL expiry).

`event_id` uniqueness: Feishu event_ids are UUIDs; Slack message ts is
"<seconds>.<microseconds>" and unique per workspace. They don't collide
across platforms.
"""
from __future__ import annotations

import logging
import os
import time

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


def _safe_err(e: Exception) -> str:
    """Sensitive-data handling: return the exception *type* (plus the AWS
    error code for botocore ClientError), never the raw message / response body
    which can embed request payloads or user data. See docs/LOGGING_STANDARD.md."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


DEFAULT_TTL_SECONDS = 24 * 3600


class _LazyTable:
    """惰性 DynamoDB Table 代理：import 时不创建 boto3 资源、不读环境变量，
    第一次真正用到（.put_item / .get_item 等）时才初始化并缓存。

    这样在无 AWS region / 无 CONVERSATIONS_TABLE 的环境（如 CI 静态检查、
    单元导入测试）下仅 import 本模块不会触发 NoRegionError / KeyError。"""

    _real = None

    def _resolve(self):
        if self._real is None:
            self._real = boto3.resource("dynamodb").Table(os.environ["CONVERSATIONS_TABLE"])
        return self._real

    def __getattr__(self, name):
        return getattr(self._resolve(), name)


_table = _LazyTable()


def put_new_event(event_id: str, *, platform: str, chat_id: str,
                  root_message_id: str, user_id: str, raw_text: str,
                  locale: str = "") -> bool:
    """Returns False if event_id already exists (platform retried).

    `locale` ("zh" | "en" | "") is the resolved conversation locale at
    intake. Stored on the row so downstream stages (`link_incident` →
    Lambda's report sender → progress poller) inherit it without
    re-resolving."""
    item = {
        "lookup_key": _k_event(event_id),
        "platform": platform,
        "event_id": event_id,
        "chat_id": chat_id,
        "root_message_id": root_message_id,
        "user_id": user_id,
        "raw_text": raw_text,
        "status": "received",
        "ttl": int(time.time()) + DEFAULT_TTL_SECONDS,
    }
    if locale:
        item["locale"] = locale
    try:
        _table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(lookup_key)",
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.info("Duplicate event_id %s — skipping", event_id)
            return False
        raise


def update_intent(event_id: str, intent_summary: str, prompt_message_id: str) -> None:
    _table.update_item(
        Key={"lookup_key": _k_event(event_id)},
        UpdateExpression="SET intent_summary = :i, prompt_message_id = :p, #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":i": intent_summary,
            ":p": prompt_message_id,
            ":s": "awaiting_confirmation",
        },
    )


def get_by_event(event_id: str) -> dict | None:
    return _table.get_item(Key={"lookup_key": _k_event(event_id)}).get("Item")


def get_by_incident(incident_id: str) -> dict | None:
    return _table.get_item(Key={"lookup_key": _k_incident(incident_id)}).get("Item")


def get_by_task(task_id: str) -> dict | None:
    return _table.get_item(Key={"lookup_key": _k_task(task_id)}).get("Item")


def link_incident(event_id: str, incident_id: str, *, platform: str,
                  task_id: str | None = None) -> None:
    src = get_by_event(event_id)
    if not src:
        logger.error("link_incident: source row missing for event_id=%s", event_id)
        return
    base = {
        "platform": platform,
        "event_id": event_id,
        "incident_id": incident_id,
        "chat_id": src["chat_id"],
        "root_message_id": src.get("root_message_id", ""),
        "user_id": src.get("user_id", ""),
        "raw_text": src.get("raw_text", ""),
        "intent_summary": src.get("intent_summary", ""),
        "status": "investigating",
        "ttl": int(time.time()) + DEFAULT_TTL_SECONDS,
    }
    # Carry locale forward so downstream stages (Lambda's slack_sender /
    # feishu_sender, progress poller, next-step generator) can render
    # in the same language without re-resolving.
    if src.get("locale"):
        base["locale"] = src["locale"]
    _table.put_item(Item={**base, "lookup_key": _k_incident(incident_id)})
    if task_id:
        _table.put_item(Item={**base, "lookup_key": _k_task(task_id), "task_id": task_id})
    _table.update_item(
        Key={"lookup_key": _k_event(event_id)},
        UpdateExpression="SET incident_id = :i, #s = :s",
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={":i": incident_id, ":s": "dispatched"},
    )


def _k_event(event_id: str) -> str:
    return f"event#{event_id}"


def _k_incident(incident_id: str) -> str:
    return f"incident#{incident_id}"


def _k_task(task_id: str) -> str:
    return f"task#{task_id}"


def _k_inflight(key: str) -> str:
    return f"inflight#{key}"


# ---------------------------------------------------------------------------
# Persistent inflight lock — replaces in-process dicts so duplicate-action
# protection survives process restarts and works across multiple replicas.
#
# Lock lifetime is bounded by the DDB TTL; after expiry the row auto-deletes
# and a retry by the user goes through. Pick the TTL based on the expected
# end-to-end completion time of the operation:
#
#   - case create / reply / resolve / sync   → ~5 min plenty
#   - dispatch (which kicks off agent run)   → ~10 min
#
# The default is 1 hour, matching the prior in-memory _INFLIGHT_TTL.
# ---------------------------------------------------------------------------
INFLIGHT_TTL_SECONDS = 3600


def claim_inflight(key: str, ttl_seconds: int = INFLIGHT_TTL_SECONDS) -> bool:
    """Attempt to claim a one-shot lock for `key`. Returns True iff this
    caller is the first to claim it within the TTL window.

    Implemented as a DDB conditional put: succeeds when no row with the
    inflight key exists, fails (returns False) when one already does.

    On any DDB error (throttling, network) we **fail-open** and return
    True — better to let the user proceed than to deadlock the workflow
    on infrastructure flakes. This matches the pre-persistent semantics:
    duplicate work is recoverable; not running at all is not.

    Pass an empty string to bypass the check (best-effort path); useful
    when callers don't have a good idempotency key handy.
    """
    if not key:
        return True
    try:
        _table.put_item(
            Item={
                "lookup_key": _k_inflight(key),
                "claimed_at": int(time.time()),
                "ttl": int(time.time()) + ttl_seconds,
            },
            ConditionExpression="attribute_not_exists(lookup_key)",
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.info("inflight lock already held: %s", key)
            return False
        # Any other DDB error → fail-open with a loud log so we notice.
        logger.error("claim_inflight DDB error (failing open): %s — %s", key, _safe_err(e))
        return True
    except Exception as e:
        logger.error("claim_inflight unexpected error (failing open): %s — %s", key, _safe_err(e))
        return True


# ---------------------------------------------------------------------------
# Bot-thread membership — tracks IM threads where the bot has already
# responded, so subsequent messages in that thread can be processed
# without requiring a fresh @mention. Cheap O(1) DDB conditional put +
# get on a `botthread#<platform>:<root_id>` key. 24h TTL keeps the
# table small (a thread that's been silent for a day is unlikely to
# need autocomplete @-context anyway).
#
# `platform` segments the namespace so the same root id can't collide
# between feishu/slack and the same key never moves between platforms.
# ---------------------------------------------------------------------------
_BOT_THREAD_TTL_SECONDS = 24 * 3600


def _k_botthread(platform: str, root_id: str) -> str:
    return f"botthread#{platform}:{root_id}"


def mark_bot_thread(platform: str, root_id: str) -> None:
    """Record that the bot has just replied inside the IM thread rooted
    at ``root_id``. Subsequent messages in that thread are then treated
    as conversations with the bot even if the user didn't @-mention
    explicitly. Idempotent + cheap; never raises."""
    if not platform or not root_id:
        return
    try:
        _table.put_item(Item={
            "lookup_key": _k_botthread(platform, root_id),
            "marked_at": int(time.time()),
            "ttl": int(time.time()) + _BOT_THREAD_TTL_SECONDS,
        })
    except Exception as e:
        # Failure here just means thread continuity won't kick in for
        # this thread — not worth raising.
        logger.warning("mark_bot_thread (%s, %s) failed: %s",
                       platform, root_id, _safe_err(e))


def is_bot_thread(platform: str, root_id: str) -> bool:
    """Return True if the bot has been recorded as participating in the
    IM thread rooted at ``root_id`` within the TTL window. False on any
    DDB error so we fall back to the safer "@mention required" path."""
    if not platform or not root_id:
        return False
    try:
        resp = _table.get_item(
            Key={"lookup_key": _k_botthread(platform, root_id)},
            ConsistentRead=False,
        )
    except Exception as e:
        logger.warning("is_bot_thread (%s, %s) DDB error: %s",
                       platform, root_id, _safe_err(e))
        return False
    item = resp.get("Item") or {}
    if not item:
        return False
    # Defensive TTL check: DDB reaper can lag a few hours, so a row may
    # still be readable past its `ttl`. We treat anything past TTL as
    # absent so behaviour matches what the user expects.
    if int(item.get("ttl", 0)) < int(time.time()):
        return False
    return True


def release_inflight(key: str) -> None:
    """Best-effort early release of an inflight lock. Optional — the TTL
    will reap stale rows automatically. Useful only when the worker
    finishes very quickly and the user might want to retry sooner.
    """
    if not key:
        return
    try:
        _table.delete_item(Key={"lookup_key": _k_inflight(key)})
    except Exception as e:
        logger.warning("release_inflight (%s) failed: %s", key, _safe_err(e))


# ---------------------------------------------------------------------------
# Multi-turn conversational session state
# ---------------------------------------------------------------------------
# Used by platforms that lack native modal/view forms (DingTalk Phase 2b)
# to drive multi-step flows like "open a case" through plain text turns.
# Each session is keyed by `(platform, chat_id, user_id, kind)` so two
# concurrent flows from the same user in different chats don't collide.
#
# Generic shape on purpose: the value is an arbitrary dict the caller
# controls. ddb_state never inspects it. TTL defaults to 30 minutes —
# long enough to type a multi-line body, short enough to abandon
# silently if the user wanders off.

_CONVO_SESSION_TTL_SECONDS = 30 * 60


def _k_convo_session(platform: str, chat_id: str, user_id: str,
                      kind: str) -> str:
    return f"convosess#{platform}:{chat_id}:{user_id}:{kind}"


def get_convo_session(platform: str, chat_id: str, user_id: str,
                       kind: str) -> dict | None:
    """Fetch the current session state for a (chat, user, kind) tuple.

    Returns None if no session is active or it has expired (the row's
    own TTL field is checked client-side as well, so we don't surface
    a near-stale state that DDB hasn't yet GC'd)."""
    if not (platform and chat_id and user_id and kind):
        return None
    try:
        resp = _table.get_item(
            Key={"lookup_key": _k_convo_session(platform, chat_id,
                                                  user_id, kind)},
            ConsistentRead=False,
        )
    except Exception as e:
        logger.warning("get_convo_session (%s/%s) failed: %s",
                       chat_id, kind, _safe_err(e))
        return None
    item = resp.get("Item")
    if not item:
        return None
    if int(item.get("ttl", 0)) < int(time.time()):
        return None
    return item.get("data") or {}


def put_convo_session(platform: str, chat_id: str, user_id: str,
                       kind: str, data: dict,
                       ttl_seconds: int = _CONVO_SESSION_TTL_SECONDS) -> None:
    """Upsert the session state. `data` is stored verbatim under the
    `data` attribute. Replaces any prior state for the same key — the
    caller is responsible for read-modify-write semantics if they
    want to merge rather than overwrite."""
    if not (platform and chat_id and user_id and kind):
        return
    try:
        _table.put_item(Item={
            "lookup_key": _k_convo_session(platform, chat_id, user_id, kind),
            "platform": platform,
            "chat_id": chat_id,
            "user_id": user_id,
            "kind": kind,
            "data": data,
            "updated_at": int(time.time()),
            "ttl": int(time.time()) + ttl_seconds,
        })
    except Exception as e:
        logger.warning("put_convo_session (%s/%s) failed: %s",
                       chat_id, kind, _safe_err(e))


def clear_convo_session(platform: str, chat_id: str, user_id: str,
                         kind: str) -> None:
    """Delete the session state — used when the flow completes or the
    user explicitly cancels."""
    if not (platform and chat_id and user_id and kind):
        return
    try:
        _table.delete_item(Key={"lookup_key": _k_convo_session(
            platform, chat_id, user_id, kind)})
    except Exception as e:
        logger.warning("clear_convo_session (%s/%s) failed: %s",
                       chat_id, kind, _safe_err(e))
