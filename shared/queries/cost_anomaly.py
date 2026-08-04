"""Cost anomaly queries — DDB-native (boto3 + stdlib), no platform SDK deps.

Table layout (config table):
  Result: PK = "anomaly#<account_id>#<date>", SK = "<service_name>"
  Summary: PK = "anomalysum#<account_id>", SK = "<date>"
  GSI1 cross-account:
    Result:  GSI1PK = "anomaly#<date>", GSI1SK = <score_zpad12>
    Summary: GSI1PK = "anomalysum#<date>", GSI1SK = <projected_zpad12>

Access patterns:
  * upsert_anomaly_result           -> PutItem result
  * upsert_anomaly_summary          -> PutItem summary
  * list_anomaly_summaries_by_date  -> GSI1 Query descending, filter status!='error'
  * list_anomaly_results_by_date    -> GSI1 Query with GSI1SK >= zpad(min_score)
  * get_anomaly_summary             -> GetItem
"""
from __future__ import annotations

from decimal import Decimal

from boto3.dynamodb.conditions import Key

from shared.queries._client import config_table, _now_iso, _zpad, to_decimal


def _result_pk(account_id: str, date: str) -> str:
    return f"anomaly#{account_id}#{date}"


def _summary_pk(account_id: str) -> str:
    return f"anomalysum#{account_id}"


def _result_gsi1pk(date: str) -> str:
    return f"anomaly#{date}"


def _summary_gsi1pk(date: str) -> str:
    return f"anomalysum#{date}"


def upsert_anomaly_result(account_id: str, date: str, service_name: str, **fields) -> None:
    """PutItem result row."""
    _table = config_table()
    score = int(fields.get("score", 0))
    item: dict = {
        "PK": _result_pk(account_id, date),
        "SK": service_name,
        "account_id": account_id,
        "date": date,
        "service_name": service_name,
        "GSI1PK": _result_gsi1pk(date),
        "GSI1SK": _zpad(score, 12),
        "created_at": _now_iso(),
    }
    for k, v in fields.items():
        item[k] = to_decimal(v)
    _table.put_item(Item=item)


def upsert_anomaly_summary(account_id: str, date: str, **fields) -> None:
    """PutItem summary row."""
    _table = config_table()
    projected = int(fields.get("projected", 0))
    item: dict = {
        "PK": _summary_pk(account_id),
        "SK": date,
        "account_id": account_id,
        "date": date,
        "GSI1PK": _summary_gsi1pk(date),
        "GSI1SK": _zpad(projected, 12),
        "created_at": _now_iso(),
    }
    for k, v in fields.items():
        item[k] = to_decimal(v)
    _table.put_item(Item=item)


def list_anomaly_summaries_by_date(date: str, *, exclude_error: bool = True) -> list[dict]:
    """GSI1 Query GSI1PK='anomalysum#<date>', descending. Filter status!='error'."""
    _table = config_table()
    resp = _table.query(
        IndexName="GSI1",
        KeyConditionExpression=Key("GSI1PK").eq(_summary_gsi1pk(date)),
        ScanIndexForward=False,
    )
    items = resp.get("Items", [])
    if exclude_error:
        items = [it for it in items if it.get("status") != "error"]
    return items


def list_anomaly_results_by_date(date: str, *, min_score: int = 60) -> list[dict]:
    """GSI1 Query GSI1PK='anomaly#<date>', GSI1SK >= zpad(min_score)."""
    _table = config_table()
    resp = _table.query(
        IndexName="GSI1",
        KeyConditionExpression=(
            Key("GSI1PK").eq(_result_gsi1pk(date))
            & Key("GSI1SK").gte(_zpad(min_score, 12))
        ),
        ScanIndexForward=False,
    )
    return resp.get("Items", [])


def get_anomaly_summary(account_id: str, date: str) -> dict | None:
    """GetItem summary."""
    _table = config_table()
    resp = _table.get_item(Key={"PK": _summary_pk(account_id), "SK": date})
    return resp.get("Item")
