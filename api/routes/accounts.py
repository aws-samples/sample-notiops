"""
目标账户管理 API 路由。
GET    /api/target-accounts       - 查询目标账户列表
POST   /api/target-accounts       - 添加目标账户
PUT    /api/target-accounts/:id   - 更新目标账户配置
DELETE /api/target-accounts/:id   - 删除目标账户
"""

import logging

from shared.queries.accounts import list_accounts, get_account, put_account, delete_account

logger = logging.getLogger(__name__)


def handle_accounts(method: str, path: str, query_params: dict, path_params: dict, body: dict | None) -> dict | list:
    parts = path.rstrip("/").split("/")
    # For PUT/DELETE, last segment is account_id (12-digit string)
    resource_id = parts[-1] if len(parts) >= 3 and parts[-1] not in ("target-accounts",) else None

    if method == "GET":
        return _list_accounts()
    elif method == "POST":
        return _create_account(body)
    elif method == "PUT" and resource_id is not None:
        return _update_account(resource_id, body)
    elif method == "DELETE" and resource_id is not None:
        return _delete_account(resource_id)
    else:
        raise ValueError(f"Method {method} not allowed or missing resource ID")


def _list_accounts() -> dict:
    """查询目标账户列表。"""
    items = list_accounts()
    return {"items": items, "total": len(items)}


def _create_account(body: dict | None) -> dict:
    """添加目标账户。"""
    if not body:
        raise ValueError("Request body is required")

    account_id = body.get("account_id")
    role_arn = body.get("role_arn")
    regions = body.get("regions")

    if not account_id:
        raise ValueError("account_id is required")
    if not role_arn:
        raise ValueError("role_arn is required")
    if not regions or not isinstance(regions, list):
        raise ValueError("regions must be a non-empty list")

    # 检查是否已存在
    existing = get_account(account_id)
    if existing:
        raise ValueError(f"Account {account_id} already exists")

    put_account(
        account_id,
        role_arn=role_arn,
        regions=regions,
        enabled=body.get("enabled", True),
        description=body.get("description", ""),
    )
    return {"account_id": account_id, "message": "Target account added"}


def _update_account(account_id: str, body: dict | None) -> dict:
    """更新目标账户配置。"""
    if not body:
        raise ValueError("Request body is required")

    existing = get_account(account_id)
    if not existing:
        raise KeyError(f"Target account {account_id} not found")

    put_account(
        account_id,
        role_arn=body.get("role_arn", existing.get("role_arn", "")),
        regions=body.get("regions", existing.get("regions", [])),
        enabled=body.get("enabled", existing.get("enabled", True)),
        description=body.get("description", existing.get("description", "")),
    )
    return {"message": "Target account updated", "account_id": account_id}


def _delete_account(account_id: str) -> dict:
    """删除目标账户。"""
    existing = get_account(account_id)
    if not existing:
        raise KeyError(f"Target account {account_id} not found")
    delete_account(account_id)
    return {"message": "Target account deleted", "account_id": account_id}
