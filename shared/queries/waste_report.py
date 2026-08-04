"""Waste report queries — DDB-native (boto3 + stdlib), no platform SDK deps.

Table layout (config table):
  PK = "wreport#<account_id>", SK = "<date>#<instance_id>"
  GSI1PK = "wreport#<date>", GSI1SK = "<is_idle_flag>#<savings_zpad12>#<account>#<instance>"
  Summary item: PK = "wreport#<date>#$SUMMARY", SK = "meta"
    fields: idle_total, idle_savings

Access patterns:
  * upsert_waste_report   -> PutItem full row
  * query_idle_topN       -> GSI1 Query descending with begins_with "1#"
  * upsert_report_summary -> PutItem summary item
  * get_report_summary    -> GetItem summary item
  * list_waste_reports    -> Main table or GSI1 Query with pagination
"""
from __future__ import annotations

from decimal import Decimal

from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError

from shared.queries._client import config_table, _now_iso, _zpad, encode_cursor, decode_cursor, to_decimal

_SK_META = "meta"
_LATEST_PK = "wreport#$LATEST"


def _pk(account_id: str) -> str:
    return f"wreport#{account_id}"


def _sk(date: str, instance_id: str) -> str:
    return f"{date}#{instance_id}"


def _gsi1pk(date: str) -> str:
    return f"wreport#{date}"


def _gsi1sk(is_idle: bool, savings: float, account_id: str, instance_id: str) -> str:
    flag = "1" if is_idle else "0"
    savings_z = _zpad(int(savings * 100), 12)  # cents, 12-digit zero-padded
    return f"{flag}#{savings_z}#{account_id}#{instance_id}"


def _summary_pk(date: str) -> str:
    return f"wreport#{date}#$SUMMARY"


def _advance_waste_latest(date: str) -> None:
    """Monotonically advance the latest-date pointer (conditional write).

    Replaces SQL `SELECT MAX(report_date)` without a scan. ConditionalCheck
    failure (incoming date <= stored) is swallowed.
    """
    try:
        config_table().update_item(
            Key={"PK": _LATEST_PK, "SK": _SK_META},
            UpdateExpression="SET latest_date = :d",
            ConditionExpression="attribute_not_exists(latest_date) OR :d > latest_date",
            ExpressionAttributeValues={":d": date},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def get_latest_waste_date() -> str | None:
    """Read the latest-date pointer (strongly consistent)."""
    item = config_table().get_item(
        Key={"PK": _LATEST_PK, "SK": _SK_META}, ConsistentRead=True,
    ).get("Item")
    return item.get("latest_date") if item else None


def get_waste_report(account_id: str, date: str, instance_id: str) -> dict | None:
    """Point read a single waste report row by full key (detail lookup)."""
    return config_table().get_item(
        Key={"PK": _pk(account_id), "SK": _sk(date, instance_id)}
    ).get("Item")


def upsert_waste_report(account_id: str, date: str, instance_id: str, **fields) -> None:
    """PutItem full row (overwrite on conflict). Computes GSI1SK from is_idle + savings."""
    _table = config_table()
    is_idle = bool(fields.get("is_idle", False))
    savings = float(fields.get("savings", 0))

    item: dict = {
        "PK": _pk(account_id),
        "SK": _sk(date, instance_id),
        "account_id": account_id,
        "date": date,
        "instance_id": instance_id,
        "GSI1PK": _gsi1pk(date),
        "GSI1SK": _gsi1sk(is_idle, savings, account_id, instance_id),
        "created_at": _now_iso(),
    }
    # Merge extra fields, converting floats to Decimal for DDB (recursive)
    for k, v in fields.items():
        item[k] = to_decimal(v)
    _table.put_item(Item=item)
    _advance_waste_latest(date)


def query_idle_topN(date: str, n: int = 5) -> list[dict]:
    """GSI1 Query for idle items (flag=1), descending by savings, Limit=n."""
    _table = config_table()
    resp = _table.query(
        IndexName="GSI1",
        KeyConditionExpression=(
            Key("GSI1PK").eq(_gsi1pk(date))
            & Key("GSI1SK").begins_with("1#")
        ),
        ScanIndexForward=False,
        Limit=n,
    )
    return resp.get("Items", [])


def upsert_report_summary(date: str, *, idle_total: int, idle_savings: float) -> None:
    """PutItem to summary item."""
    _table = config_table()
    _table.put_item(Item={
        "PK": _summary_pk(date),
        "SK": _SK_META,
        "date": date,
        "idle_total": idle_total,
        "idle_savings": Decimal(str(idle_savings)),
        "updated_at": _now_iso(),
    })


def get_report_summary(date: str) -> dict | None:
    """GetItem summary item."""
    _table = config_table()
    resp = _table.get_item(Key={"PK": _summary_pk(date), "SK": _SK_META})
    return resp.get("Item")


def list_waste_reports(*, account_id: str | None = None, date: str | None = None,
                       cursor: str | None = None, limit: int = 50) -> tuple[list, str | None]:
    """Query waste reports with pagination. Returns ONLY idle rows (is_idle=TRUE),
    mirroring the original RDS `WHERE is_idle = TRUE` list semantics.

    If account_id: main table Query PK='wreport#<account>', SK begins_with date
      if given, + FilterExpression is_idle (account is not in any idle-prefixed key).
    If no account_id but date: GSI1 Query GSI1PK='wreport#<date>' with
      begins_with(GSI1SK,'1#') — idle filter pushed into the sort-key condition.
    """
    _table = config_table()
    kwargs: dict = {"Limit": limit}

    start = decode_cursor(cursor)
    if start:
        kwargs["ExclusiveStartKey"] = start

    if account_id:
        kce = Key("PK").eq(_pk(account_id))
        if date:
            kce = kce & Key("SK").begins_with(date)
        kwargs["KeyConditionExpression"] = kce
        kwargs["FilterExpression"] = Attr("is_idle").eq(True)
    elif date:
        kwargs["IndexName"] = "GSI1"
        kwargs["KeyConditionExpression"] = (
            Key("GSI1PK").eq(_gsi1pk(date)) & Key("GSI1SK").begins_with("1#")
        )
    else:
        # No filter — fallback to scan, idle-only (not ideal but spec says both optional)
        kwargs["FilterExpression"] = (
            Attr("PK").begins_with("wreport#") & Attr("SK").ne(_SK_META)
            & Attr("is_idle").eq(True)
        )
        resp = _table.scan(**kwargs)
        return resp.get("Items", []), encode_cursor(resp.get("LastEvaluatedKey"))

    resp = _table.query(**kwargs)
    items = resp.get("Items", [])
    return items, encode_cursor(resp.get("LastEvaluatedKey"))
