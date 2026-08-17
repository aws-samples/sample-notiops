"""Resolve which LLM model the bot should use for a given chat message.

Priority chain (per inbound message):

    1. group chat preference  (set via `@bot model X` in a group)
    2. DM preference          (set via `@bot model X` in a 1:1)
    3. admin default          (DDB model catalogue `default_model`, see core/llm_config.py)

Converged 2026-08 (spec R8.2). The chain used to be
`env DEFAULT_LLM_PROVIDER → SSM /notiops/agent/model_id → catalogue constant`,
which silently out-ranked the admin-managed default: an admin changing the
default model in the console saw no effect on IM. Both legacy levels are gone:

  * `DEFAULT_LLM_PROVIDER` — verified absent from CDK and from the deployed ECS
    task definition (a SAM-era leftover), so dropping it changes no live behaviour.
  * SSM `/notiops/agent/model_id` — still read by `shared/model_config.py::
    get_bot_model_id()`, but that value drives **internal utility calls**
    (intent classification / next-steps / progress-card narration / case
    classification / skill dispatch), all of which hand-roll an Anthropic
    `invoke_model` body and therefore hard-assume a Claude model. It is a
    different concern from the user's conversational model choice and is tracked
    separately (spec R8).

The DDB read is fail-safe: `llm_config` falls back to its builtin catalogue
snapshot when DynamoDB is unreachable, so this chain never hard-fails.

Storage layout (piggy-backs on the existing conversations DDB table,
mirrors `core/locale_resolver.py`):

    model#chat#{platform}:{chat_id}     # group lock, TTL 30d
    model#dm#{platform}:{user_id}       # DM lock, TTL 30d

This module mirrors `locale_resolver` deliberately — same write /
read shape, same fail-soft "DDB error → None" behavior, same
"any chat member can switch" stance (no admin gate, per product
decision 2026-06-05). Anyone who can talk to the bot in a chat can
flip its model for that chat.
"""
from __future__ import annotations

import logging
import time

from . import ddb_state
from . import llm_config
from . import model_catalog

logger = logging.getLogger(__name__)

# 30d aligns with the locale DM lock — a reasonable group preference
# horizon. If a chat hasn't sent anything in 30d, re-detection from
# the env default isn't going to surprise anyone.
_CHAT_PREF_TTL = 30 * 24 * 3600
_DM_PREF_TTL = 30 * 24 * 3600


def _admin_default() -> str:
    """The admin-managed default model, read fresh from the DDB catalogue on
    every call (TTL-cached inside `llm_config`) so a console change propagates
    without restarting the container.

    Delegates to `llm_config.default_alias()`, which applies two rules this
    function used to get wrong by hand-rolling a `next(...)` over `cfg["models"]`:

      * the entry must be **enabled** — otherwise the admin's "turn this model
        off" would still hand it out as the default;
      * `default_model` is a **global** setting, so it may name a model that is
        not offered on this surface (Claude Haiku is web-chat only, for
        instance). In that case it falls back to the first model enabled *here*
        rather than returning an alias IM cannot resolve.

    Returns a canonical alias (`claude-sonnet-5`). The short-alias bridge that
    used to live here is gone: `model_catalog` is DDB-backed now (spec task 4.1)
    and accepts canonical, short and legacy forms alike, so there is nothing
    left to translate.
    """
    try:
        return llm_config.default_alias()
    except Exception as e:  # noqa: BLE001 — never block a reply on config read
        logger.warning("admin default lookup failed (%s); using catalogue default",
                       type(e).__name__)
    return model_catalog.DEFAULT_ALIAS


# ---------------------------------------------------------------------------
# Storage keys
# ---------------------------------------------------------------------------
def _k_chat(platform: str, chat_id: str) -> str:
    return f"model#chat#{platform}:{chat_id}"


def _k_dm(platform: str, user_id: str) -> str:
    return f"model#dm#{platform}:{user_id}"


def _read_alias(lookup_key: str) -> str | None:
    """Return the `alias` attribute on the row, or None if missing /
    invalid / DDB error. Never raises — model resolution must never
    block a chat reply."""
    try:
        item = ddb_state._table.get_item(
            Key={"lookup_key": lookup_key}, ConsistentRead=False,
        ).get("Item")
    except Exception as e:
        logger.warning("model pref read %s failed: %s", lookup_key, e)
        return None
    if not item:
        return None
    alias = (item.get("alias") or "").strip().lower()
    return alias if model_catalog.is_known(alias) else None


def _write_alias(lookup_key: str, alias: str, ttl_seconds: int) -> bool:
    """Idempotent write — overwrites whatever was there. Returns True
    on success, False on validation failure or DDB error (callers
    surface the failure to the user)."""
    if not model_catalog.is_known(alias):
        return False
    try:
        ddb_state._table.put_item(Item={
            "lookup_key": lookup_key,
            "alias": alias,
            "set_at": int(time.time()),
            "ttl": int(time.time()) + ttl_seconds,
        })
        return True
    except Exception as e:
        logger.warning("model pref write %s=%s failed: %s",
                       lookup_key, alias, e)
        return False


def _delete(lookup_key: str) -> bool:
    try:
        ddb_state._table.delete_item(Key={"lookup_key": lookup_key})
        return True
    except Exception as e:
        logger.warning("model pref delete %s failed: %s", lookup_key, e)
        return False


# ---------------------------------------------------------------------------
# Public API — read
# ---------------------------------------------------------------------------
def resolve(*,
            platform: str = "",
            chat_id: str = "",
            user_id: str = "",
            is_dm: bool = False,
            ) -> tuple[str, str]:
    """Return `(alias, source)` where `source` is one of:

      - ``"chat"``     — group-level preference set via `@bot model X`
      - ``"dm"``       — 1:1 preference set in DM
      - ``"default"``  — the admin-managed default (DDB catalogue)

    The `source` is only used for the `@bot model` (no-arg) reply so
    users see why a particular model is in effect.

    ``"env"`` was retired in 2026-08 together with the env/SSM levels of the
    priority chain (see module docstring); no caller compares the value, it is
    only interpolated into the reply text.
    """
    if platform and chat_id and not is_dm:
        v = _read_alias(_k_chat(platform, chat_id))
        if v:
            return v, "chat"

    if platform and is_dm and user_id:
        v = _read_alias(_k_dm(platform, user_id))
        if v:
            return v, "dm"

    return _admin_default(), "default"


# ---------------------------------------------------------------------------
# Public API — set / clear
# ---------------------------------------------------------------------------
def set_chat_pref(platform: str, chat_id: str, alias: str) -> bool:
    """Pin the model alias for this group chat. Subsequent messages in
    this chat will use the chosen model regardless of who sends them.
    Anyone in the group can call this — no admin gate, per product
    decision 2026-06-05."""
    if not platform or not chat_id:
        return False
    return _write_alias(_k_chat(platform, chat_id), alias, _CHAT_PREF_TTL)


def set_dm_pref(platform: str, user_id: str, alias: str) -> bool:
    """Pin the model alias for this user's 1:1 DM with the bot."""
    if not platform or not user_id:
        return False
    return _write_alias(_k_dm(platform, user_id), alias, _DM_PREF_TTL)


def clear_chat_pref(platform: str, chat_id: str) -> bool:
    """Drop the chat-level pin (no error if there was none).
    Subsequent messages fall through to env / default."""
    if not platform or not chat_id:
        return False
    return _delete(_k_chat(platform, chat_id))


def clear_dm_pref(platform: str, user_id: str) -> bool:
    if not platform or not user_id:
        return False
    return _delete(_k_dm(platform, user_id))


__all__ = [
    "resolve",
    "set_chat_pref",
    "set_dm_pref",
    "clear_chat_pref",
    "clear_dm_pref",
]
