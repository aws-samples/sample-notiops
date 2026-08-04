"""Execution (pipeline run history) queries — DDB-native (boto3 + stdlib).

Table layout (config table):
  PK = "exec#<phase>", SK = "<date_iso>"
  GSI1PK = "exec#$ALL", GSI1SK = "<date_iso>"  (global latest across phases)

Access patterns:
  * record_execution      -> PutItem with created_at, GSI1PK/GSI1SK
  * get_latest_execution  -> Main table Query desc Limit=1
  * list_executions       -> Main table (per phase) or GSI1 (all phases) desc
"""
from __future__ import annotations

from decimal import Decimal

from boto3.dynamodb.conditions import Key

from shared.queries._client import config_table, _now_iso, to_decimal

_GSI1PK_ALL = "exec#$ALL"


def _pk(phase: str) -> str:
    return f"exec#{phase}"


def record_execution(phase: str, **fields) -> None:
    """PutItem with created_at=_now_iso(), GSI1PK/GSI1SK."""
    _table = config_table()
    now = _now_iso()
    item: dict = {
        "PK": _pk(phase),
        "SK": now,
        "phase": phase,
        "GSI1PK": _GSI1PK_ALL,
        "GSI1SK": now,
        "created_at": now,
    }
    for k, v in fields.items():
        item[k] = to_decimal(v)
    _table.put_item(Item=item)


def get_latest_execution(phase: str) -> dict | None:
    """Main table Query PK='exec#<phase>', ScanIndexForward=False, Limit=1."""
    _table = config_table()
    resp = _table.query(
        KeyConditionExpression=Key("PK").eq(_pk(phase)),
        ScanIndexForward=False,
        Limit=1,
    )
    items = resp.get("Items", [])
    return items[0] if items else None


def list_executions(*, phase: str | None = None, limit: int = 10) -> list[dict]:
    """If phase: main table Query; else GSI1 Query GSI1PK='exec#$ALL' desc."""
    _table = config_table()
    if phase:
        resp = _table.query(
            KeyConditionExpression=Key("PK").eq(_pk(phase)),
            ScanIndexForward=False,
            Limit=limit,
        )
    else:
        resp = _table.query(
            IndexName="GSI1",
            KeyConditionExpression=Key("GSI1PK").eq(_GSI1PK_ALL),
            ScanIndexForward=False,
            Limit=limit,
        )
    return resp.get("Items", [])
