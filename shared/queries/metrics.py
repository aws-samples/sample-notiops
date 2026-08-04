"""DDB-native time-series query layer for per-resource monitoring metrics.

Pure boto3 + stdlib (no platform SDK). Uses lazy table access via
metrics_table() from _client.py — each function resolves the handle at call
time rather than import time, so tests can set METRICS_TABLE env after import.

Table (spec section 2):
  PK = metric#<rt>#<instance>#<account>
  SK = <YYYY-MM-DD>
  GSI1PK = metric#<rt>#<date>
  GSI1SK = <cand_flag 1/0>#<account>#<instance>
  TTL on `ttl` (epoch seconds) ~= 400 days.

The latest-monitoring-date pointer lives in the same table under a sentinel
row (PK = metric#<rt>#$LATEST, SK = $POINTER) and is advanced monotonically.
"""
from __future__ import annotations

import logging
import time
from decimal import Decimal, InvalidOperation

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.queries._client import metrics_table

logger = logging.getLogger(__name__)

_GSI1 = "GSI1"
TTL_DAYS = 400
TTL_SECONDS = TTL_DAYS * 24 * 3600


# --- key builders -----------------------------------------------------------

def _pk(rt: str, instance: str, account: str) -> str:
    return f"metric#{rt}#{instance}#{account}"


def _gsi1pk(rt: str, date: str) -> str:
    return f"metric#{rt}#{date}"


def _gsi1sk(*, cand_flag: int, account: str, instance: str) -> str:
    return f"{cand_flag}#{account}#{instance}"


def _latest_pk(rt: str) -> str:
    return f"metric#{rt}#$LATEST"


_LATEST_SK = "$POINTER"

# Fields that are always strings even if they look numeric
_STRING_FIELDS = frozenset({"instance", "account", "date", "PK", "SK",
                            "GSI1PK", "GSI1SK"})


def _coerce_numeric(value):
    """Convert float/int/numeric-string to Decimal for DynamoDB Number type."""
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str):
        try:
            return Decimal(value)
        except InvalidOperation:
            return value
    return value


# --- public API (stubs, filled in by subsequent tasks) ----------------------

def put_monitoring_batch(rt: str, rows: list[dict]) -> int:
    """Full-row write of one ingestion batch. Each `row` must carry at least
    `instance`, `account`, `date`, `cand_flag` (1/0); any other keys are
    persisted verbatim as the metric payload.

    Derives pk/sk/GSI1PK/GSI1SK and stamps a ~400d `ttl`. Uses PutItem
    (via batch_writer) so re-ingesting the same (rt, instance, account, date)
    replaces the row in place — naturally idempotent on the daily key.

    Returns the number of rows written.
    """
    if not rows:
        return 0
    _table = metrics_table()
    now = int(time.time())
    count = 0
    with _table.batch_writer() as batch:
        for row in rows:
            instance = row["instance"]
            account = row["account"]
            date = row["date"]
            cand_flag = int(row.get("cand_flag", 0))
            # Coerce numeric-looking payload strings to Decimal for DDB N type
            item = {
                k: (v if k in _STRING_FIELDS else _coerce_numeric(v))
                for k, v in row.items()
            }
            item.update({
                "PK": _pk(rt, instance, account),
                "SK": date,
                "GSI1PK": _gsi1pk(rt, date),
                "GSI1SK": _gsi1sk(cand_flag=cand_flag, account=account,
                                  instance=instance),
                "cand_flag": cand_flag,
                "ttl": now + TTL_SECONDS,
            })
            batch.put_item(Item=item)
            count += 1
    return count


def update_monitoring_fields(rt: str, instance: str, account: str, date: str,
                             fields: dict) -> None:
    """Patch a subset of attributes on the daily metric row WITHOUT touching
    the other attributes ingestion wrote.

    Implemented as an UpdateItem `SET` over exactly the keys in `fields` —
    deliberately NOT a PutItem, which would drop every metric not present in
    `fields`. On a missing row, UpdateItem upserts (keyed pk/sk + the fields).

    `fields` keys are arbitrary attribute names; reserved-word collisions are
    sidestepped with ExpressionAttributeNames placeholders.
    """
    if not fields:
        return
    _table = metrics_table()
    names: dict[str, str] = {}
    values: dict[str, object] = {}
    assignments = []
    for i, (k, v) in enumerate(fields.items()):
        nk, vk = f"#f{i}", f":v{i}"
        names[nk] = k
        values[vk] = _coerce_numeric(v) if k not in _STRING_FIELDS else v
        assignments.append(f"{nk} = {vk}")
    _table.update_item(
        Key={"PK": _pk(rt, instance, account), "SK": date},
        UpdateExpression="SET " + ", ".join(assignments),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def get_monitoring_history(rt: str, instance: str, account: str,
                           days: int) -> list[dict]:
    """Return up to `days` most-recent daily rows for one resource, newest
    first.

    Pure main-table Query on the partition (pk) with the date in the sort key
    (sk). `ScanIndexForward=False` gives descending sk (newest date first);
    `Limit=days` caps the page. Because each pk holds exactly one row per day,
    Limit == number-of-days. Returns [] when the partition is empty.
    """
    if days <= 0:
        return []
    _table = metrics_table()
    resp = _table.query(
        KeyConditionExpression=Key("PK").eq(_pk(rt, instance, account)),
        ScanIndexForward=False,
        Limit=days,
    )
    return resp.get("Items", [])


def query_candidates(rt: str, date: str, *, is_candidate: bool = True) -> list[dict]:
    """Return the day's rows whose candidate flag matches `is_candidate`,
    served entirely off GSI1.

    GSI1PK pins the (rt, date) partition; GSI1SK starts with the cand flag
    (`1#...` candidates, `0#...` non-candidates), so a `begins_with` on the
    sort key selects the subset without a table scan or post-filter.
    """
    _table = metrics_table()
    prefix = "1#" if is_candidate else "0#"
    resp = _table.query(
        IndexName=_GSI1,
        KeyConditionExpression=(
            Key("GSI1PK").eq(_gsi1pk(rt, date))
            & Key("GSI1SK").begins_with(prefix)
        ),
    )
    return resp.get("Items", [])


def query_monitoring_by_date(rt: str, date: str) -> list[dict]:
    """Return every resource's row for the given (rt, date), candidate or not.
    GSI1 partition Query, paginated to return the COMPLETE set (loops
    LastEvaluatedKey) so aggregations over the result are not truncated at the
    1MB page boundary.
    """
    _table = metrics_table()
    items: list[dict] = []
    start_key = None
    while True:
        kwargs = {
            "IndexName": _GSI1,
            "KeyConditionExpression": Key("GSI1PK").eq(_gsi1pk(rt, date)),
        }
        if start_key:
            kwargs["ExclusiveStartKey"] = start_key
        resp = _table.query(**kwargs)
        items.extend(resp.get("Items", []))
        start_key = resp.get("LastEvaluatedKey")
        if not start_key:
            break
    return items


def get_latest_monitoring_date(rt: str) -> str | None:
    """Read the per-rt latest-monitoring-date pointer, or None if unset."""
    _table = metrics_table()
    item = _table.get_item(
        Key={"PK": _latest_pk(rt), "SK": _LATEST_SK},
        ConsistentRead=True,
    ).get("Item")
    return item.get("latest_date") if item else None


def update_latest_pointer(rt: str, date: str) -> bool:
    """Monotonically advance the per-rt latest-monitoring-date pointer.

    Replaces a `MAX(date)` aggregate with an O(1) conditional UpdateItem on a
    sentinel row. The pointer is written ONLY when the row is absent or the
    incoming ISO date is strictly greater than the stored one
    (`attribute_not_exists(latest_date) OR :d > latest_date`). ISO
    YYYY-MM-DD strings compare correctly lexicographically, so string `>`
    is a date `>`.

    Returns True if the pointer was (created or) advanced, False if the
    conditional check failed (incoming date <= current — older or equal).
    """
    _table = metrics_table()
    try:
        _table.update_item(
            Key={"PK": _latest_pk(rt), "SK": _LATEST_SK},
            UpdateExpression="SET latest_date = :d",
            ConditionExpression=(
                "attribute_not_exists(latest_date) OR :d > latest_date"
            ),
            ExpressionAttributeValues={":d": date},
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.debug("latest pointer %s not advanced (incoming %s <= current)",
                         rt, date)
            return False
        raise
