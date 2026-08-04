"""Optimization report queries — DDB-native (boto3 + stdlib), no platform SDK deps.

Table layout (config table):
  PK = "oreport#<account_id>", SK = "<date>#<instance_id>"

Access patterns:
  * upsert_optimization_report -> PutItem full row
  * list_optimization_reports  -> Main table Query by account + date prefix in SK
"""
from __future__ import annotations

from decimal import Decimal

from boto3.dynamodb.conditions import Key, Attr
from botocore.exceptions import ClientError

from shared.queries._client import config_table, _now_iso, encode_cursor, decode_cursor, to_decimal

_LATEST_PK = "oreport#$LATEST"
_LATEST_SK = "meta"


def _pk(account_id: str) -> str:
    return f"oreport#{account_id}"


def _sk(date: str, instance_id: str) -> str:
    return f"{date}#{instance_id}"


def _advance_optimization_latest(date: str) -> None:
    """Monotonically advance the latest-date pointer (conditional write)."""
    try:
        config_table().update_item(
            Key={"PK": _LATEST_PK, "SK": _LATEST_SK},
            UpdateExpression="SET latest_date = :d",
            ConditionExpression="attribute_not_exists(latest_date) OR :d > latest_date",
            ExpressionAttributeValues={":d": date},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] != "ConditionalCheckFailedException":
            raise


def get_latest_optimization_date() -> str | None:
    """Read the latest-date pointer (strongly consistent)."""
    item = config_table().get_item(
        Key={"PK": _LATEST_PK, "SK": _LATEST_SK}, ConsistentRead=True,
    ).get("Item")
    return item.get("latest_date") if item else None


def get_optimization_report(account_id: str, date: str, instance_id: str) -> dict | None:
    """Point read a single optimization report row by full key (detail lookup)."""
    return config_table().get_item(
        Key={"PK": _pk(account_id), "SK": _sk(date, instance_id)}
    ).get("Item")


def upsert_optimization_report(account_id: str, date: str, instance_id: str, **fields) -> None:
    """PutItem full row (overwrite on conflict)."""
    _table = config_table()
    item: dict = {
        "PK": _pk(account_id),
        "SK": _sk(date, instance_id),
        "account_id": account_id,
        "date": date,
        "instance_id": instance_id,
        "created_at": _now_iso(),
    }
    for k, v in fields.items():
        item[k] = to_decimal(v)
    _table.put_item(Item=item)
    _advance_optimization_latest(date)


def list_optimization_reports(*, account_id: str | None = None, date: str | None = None,
                              cursor: str | None = None, limit: int = 50) -> tuple[list, str | None]:
    """Main table Query by account + optional date prefix in SK.

    If account_id provided: Query PK='oreport#<account>', SK begins_with date if given.
    If only date: Scan with filter (few items expected per date in P2).
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
        resp = _table.query(**kwargs)
    elif date:
        # Scan with filter for date prefix in SK (small dataset)
        from boto3.dynamodb.conditions import Attr
        kwargs["FilterExpression"] = (
            Attr("PK").begins_with("oreport#") & Attr("SK").begins_with(date)
        )
        resp = _table.scan(**kwargs)
    else:
        from boto3.dynamodb.conditions import Attr
        kwargs["FilterExpression"] = (
            Attr("PK").begins_with("oreport#") & Attr("SK").ne(_LATEST_SK)
        )
        resp = _table.scan(**kwargs)

    items = resp.get("Items", [])
    return items, encode_cursor(resp.get("LastEvaluatedKey"))


def summarize_optimization_reports(*, account_id: str | None = None,
                                   date: str | None = None,
                                   resource_type: str | None = None) -> tuple[list, int, float]:
    """Paginate the full (account_id?, date) set and compute totals server-side.

    Returns (items, total, total_cost). `resource_type`, when given, filters
    rows app-side (each row carries a `resource_type` attribute). Mirrors the
    original RDS ``SELECT *, COUNT(*), SUM(estimated_monthly_cost)`` so the
    dashboard/overview cards don't aggregate over a truncated cursor page.
    """
    items: list = []
    cursor: str | None = None
    while True:
        page, cursor = list_optimization_reports(
            account_id=account_id, date=date, cursor=cursor, limit=200,
        )
        items.extend(page)
        if not cursor:
            break
    if resource_type:
        items = [r for r in items if r.get("resource_type") == resource_type]
    total_cost = sum(float(r.get("estimated_monthly_cost", 0) or 0) for r in items)
    return items, len(items), total_cost
