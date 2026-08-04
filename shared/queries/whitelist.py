"""Whitelist queries — DDB-native (boto3 + stdlib), no platform SDK deps.

Two kinds share the config table:
  * waste  : suppress idle/cost candidates.  PK = wl#waste#<account>#<instance>
  * health : suppress health-check findings. PK = wl#health#<rt>#<account>#<instance>
             `rt` (resource type, e.g. rds/ec) is part of the key; `instance`
             may be empty to whitelist a whole account -> $ACCT sentinel.

Access patterns:
  * existence/active check  -> GetItem O(1) on PK (`is_whitelisted`)
  * list/sort by recency    -> GSI1 (GSI1PK=wl#<kind>[#<rt>], GSI1SK=<created_at>)
                               descending, app-layer `active_only` filter,
                               LastEvaluatedKey cursor pagination.

Expiry: `expires_at` is an ISO-8601 UTC timestamp (lexicographically ordered);
an entry is active iff it has no expiry or `now < expires_at`.
"""
from __future__ import annotations

import base64
import json
from datetime import datetime, timezone

from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from shared.queries._client import config_table

_SK = "meta"
_ACCT_SENTINEL = "$ACCT"


def _pk(kind: str, account: str, instance: str | None, *, rt: str | None = None) -> str:
    inst = instance or _ACCT_SENTINEL
    if kind == "health":
        return f"wl#health#{rt}#{account}#{inst}"
    return f"wl#{kind}#{account}#{inst}"


def _gsi1pk(kind: str, *, rt: str | None = None) -> str:
    if kind == "health":
        return f"wl#health#{rt}"
    return f"wl#{kind}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def add_whitelist(kind: str, account: str, instance: str | None, *,
                  rt: str | None = None, reason: str, created_by: str,
                  expires_at: str | None = None, if_absent: bool = False) -> bool:
    """Insert (or overwrite) a whitelist entry. Returns True on write.

    With `if_absent=True` an existing entry is left untouched and False is
    returned (PG `ON CONFLICT DO NOTHING`). Implemented in the next task.
    """
    created_at = _now_iso()
    item = {
        "PK": _pk(kind, account, instance, rt=rt),
        "SK": _SK,
        "kind": kind,
        "account": account,
        "instance": instance or "",
        "reason": reason,
        "created_by": created_by,
        "created_at": created_at,
        "GSI1PK": _gsi1pk(kind, rt=rt),
        "GSI1SK": created_at,
    }
    if rt is not None:
        item["rt"] = rt
    if expires_at is not None:
        item["expires_at"] = expires_at
    _table = config_table()
    if if_absent:
        try:
            _table.put_item(
                Item=item,
                ConditionExpression="attribute_not_exists(PK)",
            )
            return True
        except ClientError as e:
            if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return False
            raise
    _table.put_item(Item=item)
    return True


def is_whitelisted(kind: str, account: str, instance: str | None, *,
                   rt: str | None = None, at: str | None = None) -> bool:
    """O(1) GetItem existence check honouring `expires_at`.

    `at` (ISO-8601 UTC) defaults to now; an entry with `expires_at <= at`
    is treated as inactive. ISO-8601 UTC strings sort lexicographically,
    so a plain string compare is a correct time compare.
    """
    _table = config_table()
    resp = _table.get_item(Key={"PK": _pk(kind, account, instance, rt=rt), "SK": _SK})
    item = resp.get("Item")
    if not item:
        return False
    expires_at = item.get("expires_at")
    if expires_at:
        now = at or _now_iso()
        if now >= expires_at:
            return False
    return True


def _encode_cursor(last_key: dict | None) -> str | None:
    if not last_key:
        return None
    return base64.urlsafe_b64encode(json.dumps(last_key).encode()).decode()


def _decode_cursor(cursor: str | None) -> dict | None:
    if not cursor:
        return None
    return json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())


def list_whitelist(kind: str, *, rt: str | None = None, active_only: bool = True,
                   cursor: str | None = None, limit: int = 100,
                   at: str | None = None) -> dict:
    """List entries for `kind` (+`rt` for health) newest-first via GSI1.

    Returns {"items": [...], "cursor": <opaque str | None>}. `active_only`
    drops expired rows in the application layer (expiry is time-relative
    and not a clean GSI range); `at` is the injectable comparison clock.
    The cursor is an opaque base64 of the DDB LastEvaluatedKey.
    """
    _table = config_table()
    kwargs = {
        "IndexName": "GSI1",
        "KeyConditionExpression": Key("GSI1PK").eq(_gsi1pk(kind, rt=rt)),
        "ScanIndexForward": False,  # created_at descending (newest first)
        "Limit": limit,
    }
    start = _decode_cursor(cursor)
    if start:
        kwargs["ExclusiveStartKey"] = start
    resp = _table.query(**kwargs)
    items = resp.get("Items", [])
    if active_only:
        now = at or _now_iso()
        items = [it for it in items
                 if not it.get("expires_at") or now < it["expires_at"]]
    return {"items": items, "cursor": _encode_cursor(resp.get("LastEvaluatedKey"))}


def remove_whitelist(kind: str, account: str, instance: str | None, *,
                     rt: str | None = None) -> bool:
    """Delete an entry. Returns True iff a row existed (via ReturnValues)."""
    _table = config_table()
    resp = _table.delete_item(
        Key={"PK": _pk(kind, account, instance, rt=rt), "SK": _SK},
        ReturnValues="ALL_OLD",
    )
    return bool(resp.get("Attributes"))


def set_whitelist_expiry(kind: str, account: str, instance: str | None, *,
                         rt: str | None = None, expires_at: str) -> bool:
    """Set/replace `expires_at` on an existing entry.

    Guarded by attribute_exists(PK) so a missing entry is a no-op (False)
    rather than an UpdateItem-created phantom row.
    """
    _table = config_table()
    try:
        _table.update_item(
            Key={"PK": _pk(kind, account, instance, rt=rt), "SK": _SK},
            UpdateExpression="SET expires_at = :e",
            ExpressionAttributeValues={":e": expires_at},
            ConditionExpression="attribute_exists(PK)",
        )
        return True
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return False
        raise


_SCAN_PAGE = 1000  # GSI page size for full-scan helpers (overridable in tests)


def load_whitelist_set(kind: str, *, rt: str | None = None,
                       at: str | None = None) -> set[tuple[str, str]]:
    """Return all *active* (account, instance) pairs for `kind` (+`rt`).

    For O(1) bulk filtering inside the detector: load once, then test
    membership per candidate. Empty (account-level health) instances
    surface as the $ACCT sentinel so the caller can probe both the
    instance-specific and account-level keys. Paginates every GSI1 page.
    """
    _table = config_table()
    now = at or _now_iso()
    out: set[tuple[str, str]] = set()
    start: dict | None = None
    while True:
        kwargs = {
            "IndexName": "GSI1",
            "KeyConditionExpression": Key("GSI1PK").eq(_gsi1pk(kind, rt=rt)),
            "Limit": _SCAN_PAGE,
        }
        if start:
            kwargs["ExclusiveStartKey"] = start
        resp = _table.query(**kwargs)
        for it in resp.get("Items", []):
            expires_at = it.get("expires_at")
            if expires_at and now >= expires_at:
                continue
            out.add((it["account"], it.get("instance") or _ACCT_SENTINEL))
        start = resp.get("LastEvaluatedKey")
        if not start:
            break
    return out
