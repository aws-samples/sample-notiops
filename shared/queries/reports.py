"""DDB-native health-report + investigation query layer (config table).

Pure boto3 + stdlib. Uses lazy table access via config_table() from
_client.py — each function resolves the handle at call time rather than
import time, so tests can set CONFIG_TABLE env after import.

config table (spec section 2): PK/SK + GSI1.
  health reports : PK = hreport#<rt>#<date>, SK = <type>#<account|$GLOBAL>
                   GSI1PK = hreport#<rt>#<date>, GSI1SK = <created_at>
  latest summary : PK = hlatest#<rt>, SK = meta
  investigations : PK = invst#<task_id>, SK = meta
                   GSI1PK = invst#<account_id|$ALL>, GSI1SK = <created_at>
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from botocore.exceptions import ClientError

from shared.queries._client import config_table, encode_cursor, decode_cursor, to_decimal

logger = logging.getLogger(__name__)

_GLOBAL = "$GLOBAL"  # sentinel for account=None health summary rows
_ALL = "$ALL"        # sentinel for the global investigation list partition


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _acct(account: str | None) -> str:
    return account if account else _GLOBAL


def _hreport_pk(rt: str, date: str) -> str:
    return f"hreport#{rt}#{date}"


def _hreport_sk(type: str, account: str | None) -> str:
    return f"{type}#{_acct(account)}"


def begin_health_report(rt: str, date: str, type: str, *,
                        account: str | None = None) -> str:
    """Step 1 of the two-step health-report write.

    Writes a placeholder row (status=generating) keyed by the business
    tuple (rt, date, type, account) and returns a client-generated uuid.
    `SET id = if_not_exists(id, :new)` makes a retried invoke idempotent:
    the FIRST id wins and an already-advanced status is left untouched.
    Returns the surviving id (existing one on retry).
    """
    new_id = str(uuid.uuid4())
    now = _now_iso()
    resp = config_table().update_item(
        Key={"PK": _hreport_pk(rt, date), "SK": _hreport_sk(type, account)},
        UpdateExpression=(
            "SET id = if_not_exists(id, :id), "
            "#s = if_not_exists(#s, :gen), "
            "rt = if_not_exists(rt, :rt), "
            "#d = if_not_exists(#d, :d), "
            "#t = if_not_exists(#t, :t), "
            "account = if_not_exists(account, :acct), "
            "created_at = if_not_exists(created_at, :now), "
            "GSI1PK = if_not_exists(GSI1PK, :gpk), "
            "GSI1SK = if_not_exists(GSI1SK, :now)"
        ),
        ExpressionAttributeNames={
            "#s": "status", "#d": "date", "#t": "type",
        },
        ExpressionAttributeValues={
            ":id": new_id, ":gen": "generating", ":rt": rt, ":d": date,
            ":t": type, ":acct": _acct(account), ":now": now,
            ":gpk": _hreport_pk(rt, date),
        },
        ReturnValues="ALL_NEW",
    )
    return resp["Attributes"]["id"]


# Attribute names that are part of the key / managed by begin(); callers
# may not overwrite them through **fields.
_HREPORT_RESERVED = {"PK", "SK", "GSI1PK", "GSI1SK", "id", "rt", "date",
                     "type", "account", "created_at"}

# Large/irrelevant attributes that must NOT be duplicated into the
# hlatest#<rt> pointer item. report_content (LLM markdown) can approach the
# 400KB DynamoDB item limit; the pointer only needs summary counters +
# latest_date (see get_latest_health_summary / dashboard reads).
_LATEST_POINTER_EXCLUDE = {"report_content", "error_message"}


def reset_health_report_for_regenerate(rt: str, date: str, type: str, *,
                                       account: str | None = None) -> str:
    """Force-reset an existing health report back to 'generating' state.

    Unlike begin_health_report (which uses if_not_exists and won't overwrite),
    this function unconditionally sets status=generating, mints a new id, and
    clears report content fields so the UI shows a fresh 'generating' record.

    Returns the new report_id.
    """
    new_id = str(uuid.uuid4())
    now = _now_iso()
    config_table().update_item(
        Key={"PK": _hreport_pk(rt, date), "SK": _hreport_sk(type, account)},
        UpdateExpression=(
            "SET id = :id, #s = :gen, created_at = :now, "
            "GSI1SK = :now, "
            "report_content = :empty, error_message = :empty, "
            "total_instances = :zero, critical_count = :zero, "
            "warning_count = :zero, attention_count = :zero"
        ),
        ExpressionAttributeNames={"#s": "status"},
        ExpressionAttributeValues={
            ":id": new_id, ":gen": "generating", ":now": now,
            ":empty": "", ":zero": 0,
        },
    )
    logger.info("Reset health report for regenerate: rt=%s, date=%s, new_id=%s", rt, date, new_id)
    return new_id


def upsert_health_report(rt: str, date: str, type: str, *,
                         account: str | None = None, **fields) -> None:
    """Step 2 / blind upsert: backfill arbitrary report fields onto the row.

    PG `ON CONFLICT DO UPDATE` analogue via UpdateItem. Seeds id/created_at/
    GSI keys with if_not_exists so it also works when begin() was skipped,
    without clobbering a uuid/created_at already minted by begin().
    """
    now = _now_iso()
    sets = [
        "id = if_not_exists(id, :id)",
        "rt = if_not_exists(rt, :rt)",
        "#d = if_not_exists(#d, :d)",
        "#t = if_not_exists(#t, :t)",
        "account = if_not_exists(account, :acct)",
        "created_at = if_not_exists(created_at, :now)",
        "GSI1PK = if_not_exists(GSI1PK, :gpk)",
        "GSI1SK = if_not_exists(GSI1SK, :now)",
    ]
    names = {"#d": "date", "#t": "type"}
    values = {
        ":id": str(uuid.uuid4()), ":rt": rt, ":d": date, ":t": type,
        ":acct": _acct(account), ":now": now, ":gpk": _hreport_pk(rt, date),
    }
    for i, (k, v) in enumerate(fields.items()):
        if k in _HREPORT_RESERVED:
            continue
        nk, vk = f"#f{i}", f":f{i}"
        sets.append(f"{nk} = {vk}")
        names[nk] = k
        values[vk] = to_decimal(v)
    config_table().update_item(
        Key={"PK": _hreport_pk(rt, date), "SK": _hreport_sk(type, account)},
        UpdateExpression="SET " + ", ".join(sets),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )
    if account is None:
        _bump_latest_health(rt, date, fields)


def get_health_report(rt: str, date: str, type: str, *,
                      account: str | None = None) -> dict | None:
    return config_table().get_item(
        Key={"PK": _hreport_pk(rt, date), "SK": _hreport_sk(type, account)}
    ).get("Item")


def list_health_reports(rt: str, date: str, *, status: str = "completed",
                        cursor: str | None = None, limit: int = 20):
    """List health reports for (rt, date) via GSI1, created_at DESC.

    Returns (items, next_cursor). next_cursor is an opaque base64 token
    (LastEvaluatedKey); None when the page is the last. Total count is not
    returned by design (cursor pagination, no COUNT(*)).

    `status` filters server-side (FilterExpression). NOTE: the filter is
    applied AFTER the Limit page is read, so callers paginate until cursor
    is None to drain all matches -- acceptable here (per-day partitions are
    small).
    """
    kwargs = {
        "IndexName": "GSI1",
        "KeyConditionExpression": "GSI1PK = :pk",
        "ExpressionAttributeValues": {":pk": _hreport_pk(rt, date)},
        "ScanIndexForward": False,  # created_at DESC
        "Limit": limit,
    }
    names = {}
    if status:
        kwargs["FilterExpression"] = "#s = :st"
        names["#s"] = "status"
        kwargs["ExpressionAttributeValues"][":st"] = status
    if names:
        kwargs["ExpressionAttributeNames"] = names
    lek = decode_cursor(cursor)
    if lek:
        kwargs["ExclusiveStartKey"] = lek
    resp = config_table().query(**kwargs)
    return resp.get("Items", []), encode_cursor(resp.get("LastEvaluatedKey"))


# --- Latest health summary pointer ---


def _hlatest_pk(rt: str) -> str:
    return f"hlatest#{rt}"


def _bump_latest_health(rt: str, date: str, fields: dict) -> None:
    """Advance the latest-pointer item for `rt` iff `date` > stored.

    Conditional UpdateItem; ConditionalCheckFailedException (stale/older
    date) is swallowed -- replaces SQL MAX(date) without a scan.
    """
    sets = ["latest_date = :d"]
    names = {}
    values = {":d": date}
    for i, (k, v) in enumerate(fields.items()):
        if k in _HREPORT_RESERVED or k in _LATEST_POINTER_EXCLUDE:
            continue
        nk, vk = f"#p{i}", f":p{i}"
        sets.append(f"{nk} = {vk}")
        names[nk] = k
        values[vk] = to_decimal(v)
    kwargs = {
        "Key": {"PK": _hlatest_pk(rt), "SK": "meta"},
        "UpdateExpression": "SET " + ", ".join(sets),
        "ConditionExpression": "attribute_not_exists(latest_date) OR latest_date < :d",
        "ExpressionAttributeValues": values,
    }
    if names:
        kwargs["ExpressionAttributeNames"] = names
    try:
        config_table().update_item(**kwargs)
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise  # older date -> pointer already ahead, ignore


def get_latest_health_summary(rt: str) -> dict | None:
    return config_table().get_item(
        Key={"PK": _hlatest_pk(rt), "SK": "meta"}
    ).get("Item")


# --- Investigations ---

TERMINAL_STATES = ("completed", "failed", "timed_out")

# Fields owned by upsert plumbing; **fields may not overwrite them.
_INVST_RESERVED = {"PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK",
                   "task_id", "created_at", "source"}


def _invst_pk(task_id: str) -> str:
    return f"invst#{task_id}"


def _invst_gsi1pk(account_id: str | None) -> str:
    return f"invst#{account_id}" if account_id else f"invst#{_ALL}"


def _invst_gsi2pk() -> str:
    """Constant global partition for the cross-account investigation list.

    GSI1 is partitioned per-account (account-filtered list); GSI2 collects
    EVERY investigation under one constant partition so the no-filter
    dashboard list can read them all (fix: writes always carry account_id,
    so the old GSI1 invst#$ALL partition was never populated and the global
    list came back empty).
    """
    return f"invst#{_ALL}"


def upsert_investigation(task_id: str, *, account_id: str | None = None,
                         **fields) -> None:
    """Strongly-consistent upsert of an investigation row (PK=invst#<task_id>,
    SK=meta). DevOps Agent callbacks carry only task_id, so task_id is the
    primary key and GetItem is O(1) strongly-consistent.

    - task_id / created_at / GSI1 keys seeded with if_not_exists.
    - `source` is COALESCEd (if_not_exists): first writer wins.
    - account_id=None routes the GSI1 list key to the invst#$ALL partition.
    - Terminal-state guard: once status is completed/failed/timed_out, no
      further writes are applied (EventBridge cross-account is unordered).
    """
    now = _now_iso()
    sets = [
        "task_id = if_not_exists(task_id, :tid)",
        "created_at = if_not_exists(created_at, :now)",
        "GSI1PK = if_not_exists(GSI1PK, :gpk)",
        "GSI1SK = if_not_exists(GSI1SK, :now)",
        "GSI2PK = if_not_exists(GSI2PK, :g2pk)",
        "GSI2SK = if_not_exists(GSI2SK, :now)",
    ]
    names = {}
    values = {
        ":tid": task_id, ":now": now,
        ":gpk": _invst_gsi1pk(account_id),
        ":g2pk": _invst_gsi2pk(),
    }
    if account_id is not None:
        sets.append("account_id = if_not_exists(account_id, :acc)")
        values[":acc"] = account_id
    if "source" in fields and fields["source"] is not None:
        sets.append("#src = if_not_exists(#src, :src)")
        names["#src"] = "source"
        values[":src"] = fields["source"]
    for i, (k, v) in enumerate(fields.items()):
        if k in _INVST_RESERVED:
            continue
        nk, vk = f"#g{i}", f":g{i}"
        sets.append(f"{nk} = {vk}")
        names[nk] = k
        values[vk] = to_decimal(v)
    kwargs = {
        "Key": {"PK": _invst_pk(task_id), "SK": "meta"},
        "UpdateExpression": "SET " + ", ".join(sets),
        "ExpressionAttributeValues": values,
    }
    # Terminal-state guard: block the update when the CURRENT status is
    # already terminal. attribute_not_exists(#st) keeps first-write (incl.
    # first-write-terminal) allowed. EventBridge cross-account delivery is
    # unordered, so a stale in_progress can arrive after completed -- this
    # makes terminal states sticky (first terminal wins).
    guard_vals = {f":term{i}": s for i, s in enumerate(TERMINAL_STATES)}
    placeholders = ", ".join(guard_vals.keys())
    kwargs["ConditionExpression"] = (
        f"attribute_not_exists(#st) OR NOT (#st IN ({placeholders}))"
    )
    names["#st"] = "status"
    values.update(guard_vals)
    if names:
        kwargs["ExpressionAttributeNames"] = names
    try:
        config_table().update_item(**kwargs)
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        logger.info("investigation %s already terminal; dropping late "
                    "status=%s", task_id, fields.get("status"))


def backfill_report_pointers(task_id: str, *,
                             report_md_key: str | None = None,
                             report_html_key: str | None = None,
                             trace_html_key: str | None = None,
                             report_available: bool = True) -> None:
    """Best-effort backfill of S3 report pointers onto an existing row.

    Unlike upsert_investigation, this deliberately BYPASSES the terminal-state
    guard: it only SETs pointer fields + report_available and NEVER touches
    `status`. This repairs the B3 scenario where a first execution wrote a
    degraded terminal row (S3 had failed → report_available=false, pointers
    missing) and a later retry succeeded at S3 — the terminal guard would
    otherwise block the pointer write forever, violating Property 4.

    ConditionExpression only requires the row to exist (attribute_exists(PK));
    it does not inspect status. If the row is gone (never created / TTL'd),
    the ConditionalCheckFailedException is swallowed. Idempotent: re-running
    with the same pointers is a no-op overwrite.

    Only non-None pointer args are written; report_available is always set.
    """
    sets = ["report_available = :avail"]
    values = {":avail": report_available}
    names = {}
    pointer_fields = {
        "report_md_key": report_md_key,
        "report_html_key": report_html_key,
        "trace_html_key": trace_html_key,
    }
    for i, (k, v) in enumerate(pointer_fields.items()):
        if v is None:
            continue
        nk, vk = f"#p{i}", f":p{i}"
        sets.append(f"{nk} = {vk}")
        names[nk] = k
        values[vk] = v
    kwargs = {
        "Key": {"PK": _invst_pk(task_id), "SK": "meta"},
        "UpdateExpression": "SET " + ", ".join(sets),
        "ConditionExpression": "attribute_exists(PK)",
        "ExpressionAttributeValues": values,
    }
    if names:
        kwargs["ExpressionAttributeNames"] = names
    try:
        config_table().update_item(**kwargs)
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise
        logger.info("backfill_report_pointers skipped: investigation %s row "
                    "absent", task_id)


def get_investigation(task_id: str) -> dict | None:
    return config_table().get_item(
        Key={"PK": _invst_pk(task_id), "SK": "meta"},
        ConsistentRead=True,
    ).get("Item")


def list_investigations(*, account_id: str | None = None,
                        since: str | None = None,
                        statuses=None, cursor: str | None = None,
                        limit: int = 50):
    """List investigations newest-first (created_at DESC).

    - account_id=None -> cross-account global list via GSI2 (constant
      invst#$ALL partition that every row dual-writes into).
    - account_id set  -> per-account list via GSI1 (invst#<account>).
    - `since` (ISO created_at) -> inclusive lower bound on the sort key.
    - `statuses` (iterable) -> server-side FilterExpression (status IN ...).
    - returns (items, next_cursor); next_cursor None on last page. No total.
    """
    if account_id is None:
        index, pk_name, sk_name = "GSI2", "GSI2PK", "GSI2SK"
        pk_val = _invst_gsi2pk()
    else:
        index, pk_name, sk_name = "GSI1", "GSI1PK", "GSI1SK"
        pk_val = _invst_gsi1pk(account_id)

    values = {":pk": pk_val}
    if since:
        key_cond = f"{pk_name} = :pk AND {sk_name} >= :since"
        values[":since"] = since
    else:
        key_cond = f"{pk_name} = :pk"
    kwargs = {
        "IndexName": index,
        "KeyConditionExpression": key_cond,
        "ExpressionAttributeValues": values,
        "ScanIndexForward": False,  # created_at DESC
        "Limit": limit,
    }
    names = {}
    if statuses:
        st = list(statuses)
        ph = []
        for i, s in enumerate(st):
            vk = f":st{i}"
            values[vk] = s
            ph.append(vk)
        kwargs["FilterExpression"] = f"#s IN ({', '.join(ph)})"
        names["#s"] = "status"
    if names:
        kwargs["ExpressionAttributeNames"] = names
    lek = decode_cursor(cursor)
    if lek:
        kwargs["ExclusiveStartKey"] = lek
    resp = config_table().query(**kwargs)
    return resp.get("Items", []), encode_cursor(resp.get("LastEvaluatedKey"))
