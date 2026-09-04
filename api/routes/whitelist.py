"""
白名单管理 API 路由。
POST   /api/whitelist      - 添加白名单
DELETE /api/whitelist/:id   - 移除白名单（按 instance_id + account_id 复合键）
GET    /api/whitelist       - 查询白名单列表
"""

import logging
from datetime import datetime, timezone, timedelta

from shared.queries.whitelist import (
    add_whitelist,
    list_whitelist,
    remove_whitelist,
    set_whitelist_expiry,
)
from api.errors import NotFoundError

logger = logging.getLogger(__name__)


def _expires_at_from_days(days: int | None) -> str | None:
    """Convert expires_days to ISO-8601 UTC timestamp."""
    if days is None:
        return None
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def handle_whitelist(method: str, path: str, query_params: dict, path_params: dict, body: dict | None) -> dict | list:
    parts = path.rstrip("/").split("/")

    if method == "GET":
        return _list_whitelist(query_params)
    elif method == "POST":
        return _add_whitelist(body)
    elif method == "PATCH":
        return _update_whitelist_expiry(body)
    elif method == "DELETE":
        # batch delete: DELETE /api/whitelist/batch
        if len(parts) >= 3 and parts[-1] == "batch":
            return _remove_whitelist_batch(body)
        return _remove_whitelist(body)
    else:
        raise ValueError(f"Method {method} not allowed")


def _list_whitelist(query_params: dict) -> dict:
    """查询白名单列表（cursor 分页）。"""
    cursor = query_params.get("cursor")
    limit = min(200, max(1, int(query_params.get("limit", "100"))))

    result = list_whitelist("waste", active_only=True, cursor=cursor, limit=limit)
    items = result["items"]
    for item in items:
        item.setdefault("instance_id", item.get("instance", ""))
        item.setdefault("account_id", item.get("account", ""))
        item.setdefault("resource_type", item.get("rt", item.get("kind", "")))
    return {"items": items, "next_cursor": result["cursor"]}


def _add_whitelist(body: dict | None) -> dict:
    """添加白名单（支持单条和批量格式）。"""
    if not body:
        raise ValueError("Request body is required")

    items = body.get("items")
    if items and isinstance(items, list):
        # 批量格式: { items: [...], reason: "...", expires_days: N }
        expires_days = body.get("expires_days")
        if expires_days is not None:
            expires_days = int(expires_days)
            if expires_days <= 0:
                raise ValueError("expires_days must be a positive integer")
        return _add_whitelist_batch(items, body.get("reason", ""), expires_days)

    # 单条格式: { instance_id, account_id, resource_type, reason, expires_days }
    instance_id = body.get("instance_id")
    resource_type = body.get("resource_type")
    if not instance_id or not resource_type:
        raise ValueError("instance_id and resource_type are required")

    expires_days = body.get("expires_days")
    if expires_days is not None:
        expires_days = int(expires_days)
        if expires_days <= 0:
            raise ValueError("expires_days must be a positive integer")

    return _add_whitelist_batch(
        [{"instance_id": instance_id, "account_id": body.get("account_id"), "resource_type": resource_type}],
        body.get("reason", ""),
        expires_days,
    )


def _add_whitelist_batch(items: list[dict], reason: str, expires_days: int | None = None) -> dict:
    """批量添加白名单。"""
    added = 0
    skipped = 0
    expires_at = _expires_at_from_days(expires_days)

    for item in items:
        instance_id = item.get("instance_id")
        resource_type = item.get("resource_type")
        account_id = item.get("account_id", "")
        if not instance_id or resource_type not in ("rds", "elasticache"):
            skipped += 1
            continue

        try:
            add_whitelist(
                "waste",
                account_id,
                instance_id,
                reason=reason,
                created_by="dashboard",
                expires_at=expires_at,
            )
            added += 1
        except Exception as e:
            logger.error("Failed to add whitelist entry for %s: %s", instance_id, e)
            skipped += 1

    return {"added": added, "skipped": skipped, "total": len(items), "message": f"{added} entries added to whitelist"}


def _remove_whitelist(body: dict | None) -> dict:
    """移除白名单（按 instance_id + account_id）。"""
    if not body:
        raise ValueError("Request body with instance_id and account_id is required")
    instance_id = body.get("instance_id")
    account_id = body.get("account_id", "")
    if not instance_id:
        raise ValueError("instance_id is required")

    existed = remove_whitelist("waste", account_id, instance_id)
    if not existed:
        raise NotFoundError(f"Whitelist entry {instance_id}/{account_id} not found")
    return {"message": "Whitelist entry removed"}


def _remove_whitelist_batch(body: dict | None) -> dict:
    """批量移除白名单。body: { items: [{instance_id, account_id}] }"""
    if not body or not body.get("items"):
        raise ValueError("items is required")
    items = body["items"]
    if not isinstance(items, list) or not items:
        raise ValueError("items must be a non-empty list")

    deleted = 0
    for item in items:
        instance_id = item.get("instance_id")
        account_id = item.get("account_id", "")
        if instance_id and remove_whitelist("waste", account_id, instance_id):
            deleted += 1
    return {"deleted": deleted, "message": f"{deleted} entries removed"}


def _update_whitelist_expiry(body: dict | None) -> dict:
    """更新白名单有效期。"""
    if not body:
        raise ValueError("Request body is required")
    instance_id = body.get("instance_id")
    account_id = body.get("account_id", "")
    if not instance_id:
        raise ValueError("instance_id is required")

    expires_days = body.get("expires_days")
    if expires_days is not None:
        expires_days = int(expires_days)
        if expires_days <= 0:
            raise ValueError("expires_days must be a positive integer")
        expires_at = _expires_at_from_days(expires_days)
    else:
        # expires_days=null means permanent — set far-future expiry (effectively none)
        # DDB approach: remove the expires_at attribute
        expires_at = "9999-12-31T23:59:59Z"

    found = set_whitelist_expiry("waste", account_id, instance_id, expires_at=expires_at)
    if not found:
        raise NotFoundError(f"Whitelist entry {instance_id}/{account_id} not found")
    return {"message": "Whitelist expiry updated"}
