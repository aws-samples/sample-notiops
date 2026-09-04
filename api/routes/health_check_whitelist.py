"""
巡检白名单管理 API 路由。
GET    /api/health-check-whitelist              - 白名单列表（支持 resource_type 筛选）
GET    /api/health-check-whitelist/instances     - 被巡检的实例列表（排除已在白名单中的）
POST   /api/health-check-whitelist              - 添加白名单条目（单条或批量）
DELETE /api/health-check-whitelist/{id}          - 删除白名单条目
"""

import logging
from datetime import datetime, timezone, timedelta

from shared.queries.whitelist import (
    add_whitelist,
    list_whitelist,
    remove_whitelist,
    set_whitelist_expiry,
    load_whitelist_set,
)
from shared.queries.metrics import get_latest_monitoring_date, query_monitoring_by_date
from api.errors import NotFoundError

logger = logging.getLogger(__name__)

VALID_RESOURCE_TYPES = ("rds", "ec2", "elasticache", "ebs")


def _expires_at_from_days(days: int | None) -> str | None:
    """Convert expires_days to ISO-8601 UTC timestamp."""
    if days is None:
        return None
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()


def handle_health_check_whitelist(
    method: str, path: str, query_params: dict,
    path_params: dict, body: dict | None,
) -> dict:
    """路由分发。"""
    parts = path.rstrip("/").split("/")

    if method == "DELETE":
        if len(parts) >= 4 and parts[-1] == "batch":
            return _delete_batch(body)
        return _delete(body)
    if method == "PATCH":
        return _update_expiry(body)
    if method == "POST":
        if len(parts) >= 4 and parts[-1] == "batch":
            return _add_batch(body)
        return _add(body)
    if method == "GET":
        if len(parts) >= 4 and parts[-1] == "instances":
            return _get_inspected_instances(query_params)
        return _get_list(query_params)

    raise ValueError(f"Method {method} not allowed")


def _get_list(query_params: dict) -> dict:
    """白名单列表，支持按 resource_type 筛选（cursor 分页）。"""
    resource_type = query_params.get("resource_type")
    cursor = query_params.get("cursor")
    limit = min(200, max(1, int(query_params.get("limit", "100"))))

    result = list_whitelist("health", rt=resource_type, active_only=True,
                            cursor=cursor, limit=limit)
    items = result["items"]
    for item in items:
        item.setdefault("instance_id", item.get("instance", ""))
        item.setdefault("account_id", item.get("account", ""))
        item.setdefault("resource_type", item.get("rt", ""))
    return {"items": items, "next_cursor": result["cursor"]}


def _add(body: dict | None) -> dict:
    """添加白名单条目。"""
    if not body:
        raise ValueError("Request body is required")

    instance_id = body.get("instance_id")
    account_id = body.get("account_id")
    resource_type = body.get("resource_type")
    reason = body.get("reason", "")

    if not instance_id and not account_id:
        raise ValueError("instance_id and account_id cannot both be empty")

    if not resource_type:
        raise ValueError("resource_type is required")
    if resource_type not in VALID_RESOURCE_TYPES:
        raise ValueError(
            f"resource_type must be one of: {', '.join(VALID_RESOURCE_TYPES)}"
        )

    expires_days = body.get("expires_days")
    if expires_days is not None:
        expires_days = int(expires_days)
        if expires_days <= 0:
            raise ValueError("expires_days must be a positive integer")

    expires_at = _expires_at_from_days(expires_days)

    written = add_whitelist(
        "health",
        account_id or "",
        instance_id,
        rt=resource_type,
        reason=reason,
        created_by="dashboard",
        expires_at=expires_at,
        if_absent=True,
    )
    if not written:
        raise ValueError("该白名单条目已存在")

    return {"success": True}


def _delete(body: dict | None) -> dict:
    """删除白名单条目（按 instance_id + account_id + resource_type）。"""
    if not body:
        raise ValueError("Request body with instance_id, account_id, resource_type is required")
    instance_id = body.get("instance_id")
    account_id = body.get("account_id", "")
    resource_type = body.get("resource_type")
    if not resource_type:
        raise ValueError("resource_type is required")

    existed = remove_whitelist("health", account_id, instance_id, rt=resource_type)
    if not existed:
        raise NotFoundError(f"Health check whitelist entry not found")
    return {"success": True}


def _delete_batch(body: dict | None) -> dict:
    """批量删除白名单条目。body: { items: [{instance_id, account_id, resource_type}] }"""
    if not body or not body.get("items"):
        raise ValueError("items is required")
    items = body["items"]
    if not isinstance(items, list) or not items:
        raise ValueError("items must be a non-empty list")

    deleted = 0
    for item in items:
        instance_id = item.get("instance_id")
        account_id = item.get("account_id", "")
        resource_type = item.get("resource_type")
        if resource_type and remove_whitelist("health", account_id, instance_id, rt=resource_type):
            deleted += 1
    return {"deleted": deleted, "success": True}


def _update_expiry(body: dict | None) -> dict:
    """更新白名单有效期。"""
    if not body:
        raise ValueError("Request body is required")
    instance_id = body.get("instance_id")
    account_id = body.get("account_id", "")
    resource_type = body.get("resource_type")
    if not resource_type:
        raise ValueError("resource_type is required")

    expires_days = body.get("expires_days")
    if expires_days is not None:
        expires_days = int(expires_days)
        if expires_days <= 0:
            raise ValueError("expires_days must be a positive integer")
        expires_at = _expires_at_from_days(expires_days)
    else:
        expires_at = "9999-12-31T23:59:59Z"

    found = set_whitelist_expiry("health", account_id, instance_id,
                                 rt=resource_type, expires_at=expires_at)
    if not found:
        raise NotFoundError(f"Health check whitelist entry not found")
    return {"success": True, "message": "Expiry updated"}


def _get_inspected_instances(query_params: dict) -> dict:
    """查询被巡检的实例列表，排除已在白名单中的。

    支持 resource_type 查询参数：
    - resource_type="elasticache": 从 metrics 表查询 rt=elasticache
    - resource_type="rds" 或未指定: 从 metrics 表查询 rt=rds
    """
    resource_type = query_params.get("resource_type", "rds")

    # Get latest monitoring date for this resource type
    latest_date = get_latest_monitoring_date(resource_type)
    if not latest_date:
        return {"items": [], "next_cursor": None}

    # Load all monitoring data for that date
    all_rows = query_monitoring_by_date(resource_type, latest_date)

    # Load whitelist set to filter out whitelisted instances
    wl_set = load_whitelist_set("health", rt=resource_type)

    # Filter out whitelisted instances
    items = []
    for row in all_rows:
        instance = row.get("instance", "")
        account = row.get("account", "")
        # Check both instance-specific and account-level whitelist
        if (account, instance) in wl_set or (account, "$ACCT") in wl_set:
            continue
        row.setdefault("instance_id", instance)
        row.setdefault("account_id", account)
        items.append(row)

    return {"items": items, "next_cursor": None}


def _add_batch(body: dict | None) -> dict:
    """批量添加白名单条目。

    请求体: { items: [{instance_id, account_id}], reason, expires_days, resource_type }
    """
    if not body:
        raise ValueError("Request body is required")

    items = body.get("items")
    if not items or not isinstance(items, list):
        raise ValueError("items must be a non-empty list")

    resource_type = body.get("resource_type", "rds")
    if resource_type not in VALID_RESOURCE_TYPES:
        raise ValueError(f"resource_type must be one of: {', '.join(VALID_RESOURCE_TYPES)}")

    reason = body.get("reason", "")
    expires_days = body.get("expires_days")
    if expires_days is not None:
        expires_days = int(expires_days)
        if expires_days <= 0:
            raise ValueError("expires_days must be a positive integer")

    expires_at = _expires_at_from_days(expires_days)

    added = 0
    for item in items:
        instance_id = item.get("instance_id")
        account_id = item.get("account_id", "")
        if not instance_id and not account_id:
            continue
        try:
            add_whitelist(
                "health",
                account_id,
                instance_id,
                rt=resource_type,
                reason=reason,
                created_by="dashboard",
                expires_at=expires_at,
                if_absent=True,
            )
            added += 1
        except Exception as e:
            logger.warning("Failed to add whitelist entry %s/%s: %s", instance_id, account_id, e)

    return {"added": added, "total": len(items), "success": True}
