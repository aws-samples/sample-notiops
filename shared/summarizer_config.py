"""Summarizer_Config loader (shared by Callback Lambda and Health_Report_Parser).

Bedrock model ID and optional agent_prompt with 3-level fallback:

  bedrock_model_id:
    1. DDB config table: PK="appconfig#devops_agent", SK="bedrock_model_id"
       (fallback on query failure or empty value)
    2. Environment variable DEVOPS_AGENT_SUMMARIZER_MODEL_ID
       (fallback if not set)
    3. Hardcoded default: see ``_DEFAULT_MODEL_ID`` below (follows the
       catalogue's default_model; Grok 4.6 as of 2026-09-01)

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

# Hardcoded default model ID (final fallback).
#
# Kept in step with config/llm-model-catalog.json's default_model: an unbound
# backend task means "follow the deployment default". It used to be
# claude-opus-4-6-v1, which made an unbound task
# quietly run on a *different* model than the one the console advertises as the
# default -- visible only as a differently-worded report.
#
# Must stay Converse-capable: ``_model_route`` returns ("", "") on the env /
# hardcoded paths, so a Mantle-only id here would fail every summarisation that
# runs before an admin has saved the catalogue. Grok 4.6 is
# ``kind: bedrock_converse``, i.e. natively the Converse path.
#
# 2026-09-01: follows the catalogue default from Claude Sonnet 5 to Grok 4.6.
_DEFAULT_MODEL_ID = "global.xai.grok-4.6"

# Environment variable name
_ENV_MODEL_ID = "DEVOPS_AGENT_SUMMARIZER_MODEL_ID"

# DDB key prefix for app config
_PK_PREFIX = "appconfig#devops_agent"


def _query_row(config_key: str) -> dict | None:
    """Query a single config item from DDB and return the whole item.

    Returns the item rather than just ``config_value`` because the routing rows
    carry a second attribute (``for_model_id``) naming the model id they belong
    to -- see ``_model_route``.
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

    return resp.get("Item") or None


def _query_config(config_key: str) -> str | None:
    """Query a single config value from DDB config table.

    Returns None on DDB exception, missing item, or empty value.
    """
    item = _query_row(config_key)
    if not item:
        return None

    value = item.get("config_value")
    if not isinstance(value, str) or not value.strip():
        return None

    return value


def _model_route(model_id: str) -> tuple[str, str]:
    """``(kind, region)`` for ``model_id``, or ``("", "")`` meaning Converse.

    The pairing is **checked**, not assumed. The three projected rows are
    separate DDB items, so a reader can straddle two generations. The writer
    orders its puts ``kind -> region -> model_id`` so the trigger row lands
    last; that protection was cancelled by this module reading ``model_id``
    first and ``kind`` last, which yields OLD model_id + NEW kind -- the
    Responses protocol aimed at a Converse-only model id.

    Since ``model_id`` is written last, "the kind row names the model id I am
    holding" is sufficient proof that both came from the same projection. A
    mismatch means a torn read, and the safe reading is "no routing info",
    which is what absence already means.

    Rows predating ``for_model_id`` carry no tag and are trusted as before --
    otherwise the first deploy of this code would silently revert every
    already-projected Mantle binding to Converse.
    """
    kind_row = _query_row("bedrock_model_kind") or {}
    region_row = _query_row("bedrock_model_region") or {}

    kind = str(kind_row.get("config_value") or "").strip()
    region = str(region_row.get("config_value") or "").strip()
    if not kind:
        return "", ""

    # 两行都校验：BFF 给 kind 与 region 都写了 `for_model_id`，早先只查 kind，于是
    # 「region 来自下一代」的组合会被接受 —— 而 region 决定 Mantle 的 hostname。
    want = (model_id or "").strip()
    for label, row in (("kind", kind_row), ("region", region_row)):
        owner = row.get("for_model_id")
        if isinstance(owner, str) and owner.strip() and owner.strip() != want:
            logger.warning(
                "summarizer model route discarded: the %s row belongs to %s but "
                "model_id is %s (torn projection read); treating as Converse",
                label, owner.strip(), model_id,
            )
            return "", ""

    return kind, region


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
            "model_kind": str,            # "" => Converse; else e.g. bedrock_mantle_responses
            "model_region": str,          # Region for Region-pinned models, "" otherwise
        }

    ``model_kind`` / ``model_region`` are projected by the BFF next to
    ``bedrock_model_id`` (see ``projectBackendTasks``). They are needed because
    some Bedrock models are served **only** on the ``bedrock-mantle`` endpoint;
    calling Converse for those fails with ``ValidationException: The provided
    model identifier is invalid``. Empty means Converse, which is both the
    pre-existing behaviour and the right answer for the env/default fallbacks.

    Requirements: R18.5
    """
    # 顺序有意义：先定下 model_id，再拿它去校验路由行的配对。
    # 别退回 dict 字面量里直接 `_query_config("bedrock_model_kind")` —— 那样读到的
    # kind 可能属于另一代的 model_id（见 _model_route）。
    model_id = _load_model_id()
    model_kind, model_region = _model_route(model_id)
    return {
        "model_id": model_id,
        "agent_prompt": _load_agent_prompt(),
        "model_kind": model_kind,
        "model_region": model_region,
    }
