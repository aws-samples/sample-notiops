"""Threshold queries — DDB-native (boto3 + stdlib), no platform SDK deps.

Table layout (config table):
  PK = "threshold#<rt>", SK = "meta"
  Fields: thresholds (Map), description, updated_at

Access patterns:
  * get_thresholds   -> GetItem
  * list_thresholds  -> Scan with PK begins_with 'threshold#' (only 2-3 rows)
  * put_thresholds   -> PutItem (full replace)
"""
from __future__ import annotations

from boto3.dynamodb.conditions import Attr

from shared.queries._client import config_table, _now_iso

_SK = "meta"


def _pk(rt: str) -> str:
    return f"threshold#{rt}"


def get_thresholds(rt: str) -> dict | None:
    """GetItem by PK/SK."""
    _table = config_table()
    resp = _table.get_item(Key={"PK": _pk(rt), "SK": _SK})
    return resp.get("Item")


def list_thresholds() -> list[dict]:
    """Scan with PK prefix filter — only 2-3 items expected."""
    _table = config_table()
    resp = _table.scan(
        FilterExpression=Attr("PK").begins_with("threshold#"),
    )
    items = resp.get("Items", [])
    for item in items:
        if "resource_type" not in item:
            item["resource_type"] = item["PK"].removeprefix("threshold#")
    return items


def put_thresholds(rt: str, thresholds: dict, *, description: str | None = None) -> None:
    """PutItem full replace."""
    from decimal import Decimal

    def _to_decimal(obj):
        if isinstance(obj, float):
            return Decimal(str(obj))
        if isinstance(obj, dict):
            return {k: _to_decimal(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_to_decimal(i) for i in obj]
        return obj

    _table = config_table()
    now = _now_iso()
    item: dict = {
        "PK": _pk(rt),
        "SK": _SK,
        "resource_type": rt,
        "thresholds": _to_decimal(thresholds),
        "updated_at": now,
    }
    if description is not None:
        item["description"] = description
    _table.put_item(Item=item)
