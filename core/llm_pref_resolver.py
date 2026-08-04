"""Resolve which LLM model the bot should use for a given chat message.

Priority chain (per inbound message):

    1. group chat preference  (set via `@bot model X` in a group)
    2. DM preference          (set via `@bot model X` in a 1:1)
    3. env default            (DEFAULT_LLM_PROVIDER CFN parameter)
    4. fallback "claude"

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
import os
import time

from . import ddb_state
from . import model_catalog

logger = logging.getLogger(__name__)

# 30d aligns with the locale DM lock — a reasonable group preference
# horizon. If a chat hasn't sent anything in 30d, re-detection from
# the env default isn't going to surprise anyone.
_CHAT_PREF_TTL = 30 * 24 * 3600
_DM_PREF_TTL = 30 * 24 * 3600


def _env_default() -> str:
    """Read DEFAULT_LLM_PROVIDER on every call so a CFN parameter
    flip propagates without a process restart. Falls back to SSM
    model config (Dashboard "IM Bot 模型" setting), then catalogue default.

    Priority: env DEFAULT_LLM_PROVIDER → SSM /notiops/agent/model_id
    (resolved to alias via catalog) → hardcoded "claude".
    """
    raw = (os.environ.get("DEFAULT_LLM_PROVIDER") or "").strip().lower()
    if raw and model_catalog.is_known(raw):
        return raw

    # Fall back to SSM-configured model (Dashboard "IM Bot 模型" tab).
    # get_bot_model_id() returns a model_id string; if it's in the catalog
    # return the alias, otherwise return the raw model_id itself — get()
    # and is_known() both support raw model_ids via find_by_model_id fallback.
    try:
        from shared.model_config import get_bot_model_id
        ssm_model_id = get_bot_model_id()
        if ssm_model_id:
            entry = model_catalog.find_by_model_id(ssm_model_id)
            if entry:
                # If it's a catalogued model, return alias for consistency.
                # If it's a dynamic fallback entry, return raw model_id so
                # get() can re-resolve it (alias "claude" would map back to
                # the hardcoded sonnet-4.6 entry, not the SSM value).
                if entry.model_id == ssm_model_id:
                    return ssm_model_id
                return entry.alias
    except Exception:
        pass

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
      - ``"env"``      — DEFAULT_LLM_PROVIDER CFN parameter
      - ``"default"``  — final fallback to the catalogue default

    The `source` is only used for the `@bot model` (no-arg) reply so
    users see why a particular model is in effect.
    """
    if platform and chat_id and not is_dm:
        v = _read_alias(_k_chat(platform, chat_id))
        if v:
            return v, "chat"

    if platform and is_dm and user_id:
        v = _read_alias(_k_dm(platform, user_id))
        if v:
            return v, "dm"

    env = _env_default()
    if env != model_catalog.DEFAULT_ALIAS:
        return env, "env"
    return env, "default"


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
