"""PHD translate/summarise model loader (used by the PHD forwarder Lambda).

Twin of ``shared/summarizer_config.py`` -- same 3-level fallback, different
namespace. Kept as a separate module (rather than parameterising the existing
one) so the two backend tasks can be pointed at different models, which is the
whole point of the Admin "backend task models" section.

  bedrock_model_id:
    1. DDB config table: PK="appconfig#phd", SK="bedrock_model_id"
       This row is a *derived* value: the BFF writes it whenever an admin saves
       the model catalogue, resolving llmcfg.backend_tasks.phd_translate (an
       alias) into a raw model id. Editing it by hand works but gets
       overwritten on the next save.
    2. Environment variable MODEL_ID (what the CDK stack injects today, and the
       only source before the catalogue existed -- keeps old deployments and
       `-c skipPhd` style manual runs working).
    3. Hardcoded default.

DDB failures are never raised: a config read must not stop a PHD notification.
An empty DDB value counts as "unbound" and falls through to the env var, which
is how the Admin UI expresses "let this task follow the deployment default".

Requirements: R8.1.2
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("shared.phd_config")

# Final fallback. Aligned with the CDK-injected MODEL_ID and with
# config/llm-model-catalog.json's default_model, so all three agree.
#
# Must stay Converse-capable. ``phd_model_route`` returns ("", "") on the env /
# hardcoded paths -- i.e. "speak Converse" -- so a Mantle-only id here would
# fail as ``ValidationException: model identifier is invalid`` on every push
# that lands before an admin has ever saved the catalogue. Claude Sonnet 5's
# catalogue entry is ``kind: bedrock_anthropic``, which the Converse path handles.
_DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-5"

_ENV_MODEL_ID = "MODEL_ID"

_PK = "appconfig#phd"
_SK_MODEL_ID = "bedrock_model_id"
# Projected alongside the model id so the caller knows which protocol/endpoint to
# use. Absent (the pre-catalogue state, and the env/default fallback paths) means
# Converse -- see ``phd_model_route``.
_SK_MODEL_KIND = "bedrock_model_kind"
_SK_MODEL_REGION = "bedrock_model_region"


def _query_row(config_key: str) -> dict | None:
    """Read one config row and return the whole item. None on failure/absence.

    Returns the item rather than just ``config_value`` because the routing rows
    carry a second attribute (``for_model_id``) that says which model id they
    belong to -- see ``phd_model_route``.
    """
    # No CONFIG_TABLE -> the Lambda predates this wiring (or we're in a unit
    # test). Skip DDB entirely instead of constructing a boto3 resource just to
    # throw KeyError; that keeps the cold path cheap and the logs quiet.
    if not os.environ.get("CONFIG_TABLE"):
        return None
    try:
        from shared.queries._client import config_table

        resp = config_table().get_item(Key={"PK": _PK, "SK": config_key})
    except Exception as e:  # noqa: BLE001 -- a config read must never break the push
        logger.warning(
            "Query DDB phd config failed, falling back: config_key=%s, error=%s",
            config_key, e,
        )
        return None

    return resp.get("Item") or None


def _query_config(config_key: str) -> str | None:
    """Read one config row's value. Returns None on any failure, absence or empty."""
    item = _query_row(config_key)
    if not item:
        return None

    value = item.get("config_value")
    if not isinstance(value, str) or not value.strip():
        return None

    return value.strip()


def phd_model_id() -> str:
    """Bedrock model ID for PHD translation (3-level fallback)."""
    db_value = _query_config(_SK_MODEL_ID)
    if db_value:
        logger.info("PHD model_id from DDB: %s", db_value)
        return db_value

    env_value = os.environ.get(_ENV_MODEL_ID, "").strip()
    if env_value:
        logger.info("PHD model_id from env %s: %s", _ENV_MODEL_ID, env_value)
        return env_value

    logger.info("PHD model_id using hardcoded default: %s", _DEFAULT_MODEL_ID)
    return _DEFAULT_MODEL_ID


def phd_model_route(model_id: str) -> tuple[str, str]:
    """``(kind, region)`` for ``model_id`` -- which wire protocol to speak and,
    for Region-pinned models, where to send the request.

    Both are projected by the BFF alongside ``bedrock_model_id`` (see
    ``projectBackendTasks``). They exist because some Bedrock models are served
    **only** on the ``bedrock-mantle`` endpoint -- calling Converse for those
    returns ``ValidationException: The provided model identifier is invalid``.
    A bare model id cannot express that, so the protocol has to travel with it.

    Returns ``("", "")`` whenever the rows are absent, which ``invoke_llm``
    reads as "speak Converse" -- i.e. exactly the pre-existing behaviour. That
    matters for the fallback paths: when ``phd_model_id`` came from the env var
    or the hardcoded default (both deliberately Converse-capable profiles --
    see ``_DEFAULT_MODEL_ID``), there is no projection to read and defaulting
    to Converse is correct.

    **Deliberately not inferred from the model id.** Guessing by prefix breaks
    silently the moment the catalogue gains a model whose id does not match the
    guess, and the failure surfaces as "model identifier is invalid" -- which
    reads like "this model does not exist" and costs a lot to attribute.

    Why ``model_id`` is a parameter (the torn-read problem)
    ------------------------------------------------------
    The three rows are separate items, so a reader can straddle two generations.
    The writer orders its puts ``kind -> region -> model_id`` precisely so that
    ``model_id`` -- the row consumers treat as the trigger -- never lands before
    the protocol that goes with it. That ordering was **exactly cancelled** by
    the read side, which read ``model_id`` first and ``kind`` last:

        t0  reader reads model_id      -> OLD (a Converse model)
        t1  writer puts kind=mantle
        t2  writer puts region
        t3  writer puts model_id=GPT
        t4  reader reads kind          -> NEW (mantle)

    giving OLD model_id + NEW kind: Responses protocol aimed at a Claude id.
    Same mismatch class the write order was designed to prevent, arriving from
    the other side. The old comment on the write path claimed consumers "ignore
    a kind that does not match the model id" -- no consumer ever did that.

    So the rows now carry ``for_model_id`` and the pairing is **checked** rather
    than assumed. Because ``model_id`` is written last, the check is sufficient:
    if we hold a ``model_id`` and the kind row names that same id, the two were
    written by the same projection. A mismatch means we are looking at a torn
    pair, and the safe reading is "no routing information" -> Converse, which is
    the documented meaning of absence anyway.

    Rows written before ``for_model_id`` existed have no such attribute. Those
    are trusted as before (absence != mismatch); requiring the tag would make
    every already-projected Mantle binding silently revert to Converse on the
    first deploy of this code. The tag appears on the next save.
    """
    kind_row = _query_row(_SK_MODEL_KIND) or {}
    region_row = _query_row(_SK_MODEL_REGION) or {}

    kind = str(kind_row.get("config_value") or "").strip()
    region = str(region_row.get("config_value") or "").strip()
    if not kind:
        return "", ""

    # **两行都要校验配对**。BFF 给 kind 与 region 都写了 `for_model_id`，但早先只查了
    # kind —— 于是一个「kind 与 model_id 同代、region 来自下一代」的组合会被接受，而
    # region 决定 Mantle 的 hostname，在本仓库别处被当作数据驻留控制。窗口比 kind 那条
    # 窄（要求保存与 PHD 事件并发），但既然标记已经写在行上，校验只是一行。
    want = (model_id or "").strip()
    for label, row in (("kind", kind_row), ("region", region_row)):
        owner = row.get("for_model_id")
        if isinstance(owner, str) and owner.strip() and owner.strip() != want:
            logger.warning(
                "PHD model route discarded: the %s row belongs to %s but model_id is %s "
                "(torn projection read); treating as Converse",
                label, owner.strip(), model_id,
            )
            return "", ""

    logger.info("PHD model route from DDB: kind=%s region=%s", kind, region or "-")
    return kind, region
