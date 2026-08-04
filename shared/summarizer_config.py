"""Summarizer_Config loader (shared by Callback Lambda and Health_Report_Parser).

Bedrock model ID and optional agent_prompt with 3-level fallback:

  bedrock_model_id:
    1. DDB config table: PK="appconfig#devops_agent", SK="bedrock_model_id"
       (fallback on query failure or empty value)
    2. Environment variable DEVOPS_AGENT_SUMMARIZER_MODEL_ID
       (fallback if not set)
    3. Hardcoded default: global.anthropic.claude-opus-4-6-v1

  agent_prompt (optional):
    1. DDB config table: PK="appconfig#devops_agent", SK="agent_prompt"
       (empty string treated as unconfigured)
    2. Return None (caller uses its own hardcoded default prompt)

DDB exceptions are not raised -- silently fallback with WARN log,
ensuring callers work even when DDB is unreachable.

Requirements: R6.4, R6.6, R18.5
"""

import logging
import os

from shared.queries._client import config_table

logger = logging.getLogger("shared.summarizer_config")

# Hardcoded default model ID (final fallback)
_DEFAULT_MODEL_ID = "global.anthropic.claude-opus-4-6-v1"

# Environment variable name
_ENV_MODEL_ID = "DEVOPS_AGENT_SUMMARIZER_MODEL_ID"

# DDB key prefix for app config
_PK_PREFIX = "appconfig#devops_agent"


def _query_config(config_key: str) -> str | None:
    """Query a single config item from DDB config table.

    Returns None on DDB exception, missing item, or empty value.
    """
    try:
        resp = config_table().get_item(
            Key={"PK": _PK_PREFIX, "SK": config_key}
        )
    except Exception as e:
        logger.warning(
            "Query DDB config failed, falling back: config_key=%s, error=%s",
            config_key, e,
        )
        return None

    item = resp.get("Item")
    if not item:
        return None

    value = item.get("config_value")
    if not isinstance(value, str) or not value.strip():
        return None

    return value


def _load_model_id() -> str:
    """Load Bedrock model ID with 3-level fallback."""
    db_value = _query_config("bedrock_model_id")
    if db_value:
        logger.info("Summarizer_Config model_id from DDB: %s", db_value)
        return db_value

    env_value = os.environ.get(_ENV_MODEL_ID, "").strip()
    if env_value:
        logger.info(
            "Summarizer_Config model_id from env %s: %s",
            _ENV_MODEL_ID, env_value,
        )
        return env_value

    logger.info(
        "Summarizer_Config model_id using hardcoded default: %s",
        _DEFAULT_MODEL_ID,
    )
    return _DEFAULT_MODEL_ID


def _load_agent_prompt() -> str | None:
    """Load optional agent_prompt with 2-level fallback."""
    db_value = _query_config("agent_prompt")
    if db_value:
        logger.info(
            "Summarizer_Config agent_prompt from DDB (length=%d)",
            len(db_value),
        )
        return db_value

    logger.info(
        "Summarizer_Config agent_prompt not configured, caller will use hardcoded default prompt",
    )
    return None


def load_summarizer_config() -> dict:
    """Load Summarizer_Config (3-level fallback).

    Returns:
        {
            "model_id": str,              # Bedrock model ID
            "agent_prompt": str | None,   # Optional prompt override, None if unconfigured
        }

    Requirements: R18.5
    """
    return {
        "model_id": _load_model_id(),
        "agent_prompt": _load_agent_prompt(),
    }
