"""Account CRUD — DDB-native (boto3 + stdlib), no platform SDK deps.

Table layout (config table):
  PK = "account#<account_id>", SK = "meta"
  GSI1PK = "accounts", GSI1SK = "<account_id>"

Access patterns:
  * list_accounts   -> GSI1 Query GSI1PK="accounts", optional filter on enabled
  * get_account     -> GetItem
  * put_account     -> UpdateItem SET with if_not_exists(created_at)
  * delete_account  -> DeleteItem
"""
from __future__ import annotations

from boto3.dynamodb.conditions import Key

from shared.queries._client import config_table, _now_iso, to_decimal

_SK = "meta"
_GSI1PK_VAL = "accounts"


def _pk(account_id: str) -> str:
    return f"account#{account_id}"


def list_accounts(*, enabled_only: bool = False) -> list[dict]:
    """GSI1 Query GSI1PK='accounts'. Optionally filter enabled=True."""
    _table = config_table()
    resp = _table.query(
        IndexName="GSI1",
        KeyConditionExpression=Key("GSI1PK").eq(_GSI1PK_VAL),
    )
    items = resp.get("Items", [])
    if enabled_only:
        items = [it for it in items if it.get("enabled") is True]
    return items


def get_account(account_id: str) -> dict | None:
    """GetItem by PK/SK."""
    _table = config_table()
    resp = _table.get_item(Key={"PK": _pk(account_id), "SK": _SK})
    return resp.get("Item")


def put_account(account_id: str, **fields) -> None:
    """UpdateItem SET with if_not_exists(created_at), always update GSI1PK/GSI1SK."""
    _table = config_table()
    now = _now_iso()

    names: dict[str, str] = {}
    values: dict[str, object] = {}
    assignments: list[str] = []

    # Always set GSI1PK/GSI1SK + account_id as queryable attribute
    fields["GSI1PK"] = _GSI1PK_VAL
    fields["GSI1SK"] = account_id
    fields["account_id"] = account_id
    fields["updated_at"] = now

    for i, (k, v) in enumerate(fields.items()):
        nk, vk = f"#f{i}", f":v{i}"
        names[nk] = k
        values[vk] = to_decimal(v)
        assignments.append(f"{nk} = {vk}")

    # created_at with if_not_exists
    names["#ca"] = "created_at"
    values[":ca"] = now
    assignments.append("#ca = if_not_exists(#ca, :ca)")

    _table.update_item(
        Key={"PK": _pk(account_id), "SK": _SK},
        UpdateExpression="SET " + ", ".join(assignments),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def delete_account(account_id: str) -> None:
    """DeleteItem — idempotent."""
    _table = config_table()
    _table.delete_item(Key={"PK": _pk(account_id), "SK": _SK})
