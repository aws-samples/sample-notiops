"""Resolve the chat locale for any inbound user message or outbound
agent reply, with the priority chain:

    1. user explicit pref     (DDB row, set by /language)
    2. thread / investigation lock  (set on first message of a thread)
    3. DM lock                (set on first message of a 1:1 chat)
    4. auto-detect this message    (heuristic, see core.i18n)
    5. group default          (CFN parameter / env)
    6. fallback "en"

The first four are RESOLVED PER MESSAGE; (5) and (6) are static.
The point is "the customer never sees a language they don't speak":
once a thread/DM is established, we LOCK the locale, so a single
short follow-up like `why?` doesn't accidentally flip the whole
investigation to English mid-flight.

Storage layout (piggy-backs on the existing conversations DDB table):

    locale#user#{user_id}             # explicit pref, TTL 90d
    locale#dm#{platform}:{user_id}     # DM auto-lock, TTL 30d
    locale#thread#{platform}:{root_id}  # group thread lock, TTL 7d
    locale#incident#{incident_id}     # investigation lock, TTL 24h

All locks share the same `locale` attribute and a `set_at` timestamp
so we can debug "why did this come back zh" later. None of them are
load-bearing for correctness — if any DDB read fails, we fall through
to the next layer.
"""
from __future__ import annotations

import logging
import os
import time

from . import ddb_state
from . import i18n

logger = logging.getLogger(__name__)

# TTLs picked to be loose enough that real usage won't hit them, but
# tight enough that a forgotten lock doesn't haunt the user forever.
_USER_PREF_TTL = 90 * 24 * 3600   # 90d — this is "set and forget"
_DM_LOCK_TTL = 30 * 24 * 3600     # 30d — long-running 1:1 conversations
_THREAD_LOCK_TTL = 7 * 24 * 3600  # 7d — group threads usually finish faster
_INCIDENT_LOCK_TTL = 24 * 3600    # 24h — same as the bot_thread marker

VALID_LOCALES = {"zh", "en"}


def _env_default() -> str:
    """CFN parameter pulled in via env. Two-character canonical, falls
    to en. We don't expose the parameter as a per-stack default yet —
    operators can flip via env at task-def time if they want a non-en
    fallback for a region-specific deployment."""
    raw = (os.environ.get("DEFAULT_LOCALE") or "").strip().lower()
    return raw if raw in VALID_LOCALES else "en"


# ---------------------------------------------------------------------------
# Storage keys
# ---------------------------------------------------------------------------
def _k_user(user_id: str) -> str:
    return f"locale#user#{user_id}"


def _k_dm(platform: str, user_id: str) -> str:
    return f"locale#dm#{platform}:{user_id}"


def _k_thread(platform: str, root_id: str) -> str:
    return f"locale#thread#{platform}:{root_id}"


def _k_incident(incident_id: str) -> str:
    return f"locale#incident#{incident_id}"


def _read_locale(lookup_key: str) -> str | None:
    """Return the `locale` attribute on the row, or None if missing /
    DDB error. Never raises — locale resolution must never block a
    chat reply."""
    try:
        item = ddb_state._table.get_item(
            Key={"lookup_key": lookup_key}, ConsistentRead=False,
        ).get("Item")
    except Exception as e:
        logger.warning("locale read %s failed: %s", lookup_key, e)
        return None
    if not item:
        return None
    locale = (item.get("locale") or "").strip().lower()
    return locale if locale in VALID_LOCALES else None


def _write_locale(lookup_key: str, locale: str, ttl_seconds: int,
                  *, set_by: str = "auto") -> None:
    """Idempotent write — overwrites whatever was there. Callers that
    only want to set-on-first-write should check is_set first."""
    if locale not in VALID_LOCALES:
        return
    try:
        ddb_state._table.put_item(Item={
            "lookup_key": lookup_key,
            "locale": locale,
            "set_at": int(time.time()),
            "set_by": set_by,
            "ttl": int(time.time()) + ttl_seconds,
        })
    except Exception as e:
        logger.warning("locale write %s=%s failed: %s",
                       lookup_key, locale, e)


# ---------------------------------------------------------------------------
# Public API — read
# ---------------------------------------------------------------------------
def resolve(*,
            user_id: str = "",
            platform: str = "",
            is_dm: bool = False,
            thread_root_id: str = "",
            incident_id: str = "",
            text: str = "",
            ) -> tuple[str, str]:
    """Run the priority chain and return ``(locale, source)``.

    `source` is one of: ``user`` / ``incident`` / ``thread`` / ``dm``
    / ``auto`` / ``default``. Used for logging and the `/language`
    response so users understand why a language is being applied.
    """
    if user_id:
        v = _read_locale(_k_user(user_id))
        if v:
            return v, "user"

    if incident_id:
        v = _read_locale(_k_incident(incident_id))
        if v:
            return v, "incident"

    if platform and thread_root_id:
        v = _read_locale(_k_thread(platform, thread_root_id))
        if v:
            return v, "thread"

    if platform and is_dm and user_id:
        v = _read_locale(_k_dm(platform, user_id))
        if v:
            return v, "dm"

    if text:
        return i18n.detect_locale(text), "auto"

    return _env_default(), "default"


# ---------------------------------------------------------------------------
# Public API — set
# ---------------------------------------------------------------------------
def set_user_pref(user_id: str, locale: str,
                   *, platform: str = "") -> bool:
    """Persist the explicit `/language` setting.

    `locale="auto"` removes the user pref AND clears the per-DM lock
    for this user (so the next message can re-detect from scratch).
    Without clearing the DM lock, "language auto" looks broken: the
    user pref is gone but the resolver still falls through to the
    DM-lock layer and keeps returning whatever was previously locked.

    Thread locks are NOT cleared here — they're scoped to a single
    investigation thread, not to the user.

    Pass `platform` so we know which DM-lock row to clear. When
    omitted (legacy callers) we just clear the user pref; the DM
    lock is then handled by the next caller that knows the platform.

    Returns True on success."""
    if not user_id:
        return False
    canon = i18n.normalize_locale(locale)
    if canon == "auto":
        ok = True
        try:
            ddb_state._table.delete_item(Key={"lookup_key": _k_user(user_id)})
        except Exception as e:
            logger.warning("locale unset user=%s failed: %s", user_id, e)
            ok = False
        if platform:
            try:
                ddb_state._table.delete_item(
                    Key={"lookup_key": _k_dm(platform, user_id)})
            except Exception as e:
                # Failure here is non-critical; lock will TTL out
                # within 30 days. Log + continue.
                logger.info("clear DM lock for user=%s platform=%s "
                            "failed (non-critical): %s",
                            user_id, platform, e)
        return ok
    if canon not in VALID_LOCALES:
        return False
    _write_locale(_k_user(user_id), canon, _USER_PREF_TTL, set_by="user")
    # Also clear the stale DM lock if any. Reason: when the user later
    # flips to "auto", we want to fall straight through to detection;
    # leaving an old DM-lock row would silently override "auto" after
    # the user pref is gone.
    if platform:
        try:
            ddb_state._table.delete_item(
                Key={"lookup_key": _k_dm(platform, user_id)})
        except Exception as e:
            logger.info("clear DM lock for user=%s platform=%s "
                        "failed (non-critical): %s",
                        user_id, platform, e)
    return True


def lock_for_thread(platform: str, root_id: str, locale: str) -> None:
    """Set the thread lock if it doesn't exist yet. Subsequent calls
    in the same thread are no-ops — the FIRST message's locale wins,
    because re-detecting a 2-character follow-up is unreliable."""
    if not platform or not root_id or locale not in VALID_LOCALES:
        return
    if _read_locale(_k_thread(platform, root_id)) is not None:
        return
    _write_locale(_k_thread(platform, root_id), locale,
                  _THREAD_LOCK_TTL, set_by="auto")


def lock_for_dm(platform: str, user_id: str, locale: str) -> None:
    """Set the DM lock if it doesn't exist yet. Same first-write-wins
    semantics as `lock_for_thread`."""
    if not platform or not user_id or locale not in VALID_LOCALES:
        return
    if _read_locale(_k_dm(platform, user_id)) is not None:
        return
    _write_locale(_k_dm(platform, user_id), locale,
                  _DM_LOCK_TTL, set_by="auto")


def lock_for_incident(incident_id: str, locale: str) -> None:
    """Set the incident lock — bound to a specific investigation.
    Idempotent; callers don't need to check first.

    Used by the dispatch flow so progress card / report / next-step
    cards (which run from Lambda, not the bot ECS task) can look up
    locale from the incident_id alone."""
    if not incident_id or locale not in VALID_LOCALES:
        return
    _write_locale(_k_incident(incident_id), locale,
                  _INCIDENT_LOCK_TTL, set_by="auto")


def get_for_incident(incident_id: str) -> str:
    """Lambda-side reader. Return the incident's locked locale, or
    `_env_default()` if the row isn't there (older incidents that
    pre-date this feature, or DDB hiccup). Never raises."""
    if not incident_id:
        return _env_default()
    v = _read_locale(_k_incident(incident_id))
    return v or _env_default()
