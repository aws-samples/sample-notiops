"""
阈值配置管理 API 路由（按资源类型分开）。
GET    /api/threshold-config       - 查询所有资源类型的阈值配置
PUT    /api/threshold-config/:rt   - 更新某个资源类型的阈值
POST   /api/threshold-config       - 新增资源类型阈值（用于后续扩展 EC2 等）
DELETE /api/threshold-config/:rt   - 删除阈值配置
"""

import json
import logging

from shared.queries.threshold import get_thresholds, list_thresholds, put_thresholds

logger = logging.getLogger(__name__)


def handle_threshold(method: str, path: str, query_params: dict, path_params: dict, body: dict | None) -> dict | list:
    parts = path.rstrip("/").split("/")
    # resource_type is last segment for PUT/DELETE
    resource_type = parts[-1] if len(parts) >= 3 and parts[-1] not in ("threshold-config",) else None

    if method == "GET":
        return _list_configs()
    elif method == "POST":
        return _create_config(body)
    elif method == "PUT" and resource_type is not None:
        return _update_config(resource_type, body)
    elif method == "DELETE" and resource_type is not None:
        return _delete_config(resource_type)
    else:
        raise ValueError(f"Method {method} not allowed or missing resource ID")


def _list_configs() -> dict:
    """查询所有资源类型的阈值配置。"""
    rows = list_thresholds()
    # 将 thresholds 字段确保为 dict
    for row in rows:
        if isinstance(row.get("thresholds"), str):
            row["thresholds"] = json.loads(row["thresholds"])
    return {"items": rows, "total": len(rows)}


def _create_config(body: dict | None) -> dict:
    """新增资源类型阈值配置。"""
    if not body:
        raise ValueError("Request body is required")

    resource_type = body.get("resource_type")
    if not resource_type:
        raise ValueError("resource_type is required")

    thresholds = body.get("thresholds", {})
    if isinstance(thresholds, str):
        thresholds = json.loads(thresholds)

    put_thresholds(resource_type, thresholds, description=body.get("description", ""))
    return {"resource_type": resource_type, "message": "Threshold config created"}


def _update_config(resource_type: str, body: dict | None) -> dict:
    """更新阈值配置。"""
    if not body:
        raise ValueError("Request body is required")

    existing = get_thresholds(resource_type)
    if not existing:
        raise KeyError(f"Threshold config {resource_type} not found")

    thresholds = body.get("thresholds")
    if thresholds is not None:
        if isinstance(thresholds, str):
            thresholds = json.loads(thresholds)
    else:
        thresholds = existing.get("thresholds", {})
        if isinstance(thresholds, str):
            thresholds = json.loads(thresholds)

    put_thresholds(
        resource_type,
        thresholds,
        description=body.get("description", existing.get("description", "")),
    )
    return {"message": "Threshold config updated", "resource_type": resource_type}


def _delete_config(resource_type: str) -> dict:
    """删除阈值配置。"""
    from shared.queries._client import config_table

    existing = get_thresholds(resource_type)
    if not existing:
        raise KeyError(f"Threshold config {resource_type} not found")

    # Direct DeleteItem — threshold module only has put/get/list
    _table = config_table()
    _table.delete_item(Key={"PK": f"threshold#{resource_type}", "SK": "meta"})
    return {"message": "Threshold config deleted", "resource_type": resource_type}
