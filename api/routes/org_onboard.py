"""Organizations 一键账号接入 API 路由(控制台「账户接入」Tab)。

前提: org 模式部署(setup.sh --multi-account 且管理账号/委派管理员),
CDK 注入 MEMBER_ONBOARDING_STACKSET_NAME + ORGANIZATION_ID 环境变量并授权
StackSets / Organizations 只读动作。非 org 模式下所有端点返回 400。

GET  /api/org-onboard/accounts
     - Organizations ListAccounts(ACTIVE)+ config 表接入状态合并
POST /api/org-onboard
     - body {account_id, regions: [..]}
     - CreateStackInstances(单账号: 根 OU + Accounts + INTERSECTION)
     - config 表预登记(enabled=False, org_onboard_status=PROVISIONING)
     - 返回 {operation_id}
GET  /api/org-onboard/status/<operation_id>?account_id=<id>
     - DescribeStackSetOperation 轮询;SUCCEEDED 时把账号翻为
       enabled=True / org_onboard_status=ACTIVE(幂等)

设计取舍: StackSet 操作是异步的(分钟级),Lambda 不阻塞等待——
POST 立即返回 operation_id,由前端轮询 status 端点推进状态机。
"""

from __future__ import annotations

import logging
import os

import boto3
from botocore.exceptions import ClientError

from shared.queries.accounts import get_account, list_accounts, put_account

logger = logging.getLogger(__name__)

# 与成员模板 infra/member-account-onboarding.yaml 的 RoleName 保持一致
# 与 infra/member-account-onboarding.yaml 一致（带管理账号后缀，与独立部署共存）；env 由 CDK 注入
_MEMBER_ROLE_NAME = os.environ.get("NOTIOPS_MEMBER_ROLE_NAME", "notiops-idle-detection-role")

# 模块级缓存(Lambda 容器复用)
_cf_client = None
_org_client = None
_root_id: str | None = None


def _stackset_name() -> str:
    name = os.environ.get("MEMBER_ONBOARDING_STACKSET_NAME", "").strip()
    if not name:
        raise ValueError(
            "Org mode not enabled — 需以 ./setup.sh --multi-account 在组织管理账号部署"
        )
    return name


def _cf():
    global _cf_client
    if _cf_client is None:
        _cf_client = boto3.client("cloudformation")
    return _cf_client


def _org():
    global _org_client
    if _org_client is None:
        _org_client = boto3.client("organizations")
    return _org_client


def _get_root_id() -> str:
    """Organizations 根 ID(r-xxxx)。SERVICE_MANAGED CreateStackInstances
    按单账号定向时需要 OU 上下文,用根 + Accounts + INTERSECTION 最通用。"""
    global _root_id
    if _root_id is None:
        roots = _org().list_roots().get("Roots", [])
        if not roots:
            raise ValueError("Organizations ListRoots 返回为空")
        _root_id = roots[0]["Id"]
    return _root_id


def handle_org_onboard(
    method: str, path: str, query_params: dict, path_params: dict, body: dict | None
) -> dict:
    parts = path.rstrip("/").split("/")
    # /api/org-onboard | /api/org-onboard/accounts | /api/org-onboard/status/<op_id>
    if method == "GET" and parts[-1] == "accounts":
        return _list_org_accounts()
    if method == "GET" and len(parts) >= 2 and parts[-2] == "status":
        return _operation_status(parts[-1], query_params)
    if method == "POST" and parts[-1] == "org-onboard":
        return _onboard_account(body)
    raise ValueError(f"Method {method} not allowed for {path}")


def _list_org_accounts() -> dict:
    """组织内 ACTIVE 账号 × config 表接入状态。"""
    _stackset_name()  # org 模式校验
    onboarded = {str(it.get("account_id")): it for it in list_accounts()}

    items: list[dict] = []
    paginator = _org().get_paginator("list_accounts")
    for page in paginator.paginate():
        for acct in page.get("Accounts", []):
            if acct.get("Status") != "ACTIVE":
                continue
            acct_id = acct["Id"]
            cfg = onboarded.get(acct_id)
            items.append(
                {
                    "account_id": acct_id,
                    "name": acct.get("Name", ""),
                    "email": acct.get("Email", ""),
                    "onboarded": cfg is not None,
                    "enabled": bool(cfg.get("enabled")) if cfg else False,
                    "org_onboard_status": (cfg or {}).get("org_onboard_status", ""),
                    "regions": (cfg or {}).get("regions", []),
                }
            )
    items.sort(key=lambda x: x["account_id"])
    return {"items": items, "total": len(items)}


def _onboard_account(body: dict | None) -> dict:
    """单账号一键接入: 下发 Stack Instance + config 表预登记。"""
    stackset = _stackset_name()
    if not body:
        raise ValueError("Request body is required")
    account_id = str(body.get("account_id", "")).strip()
    regions = body.get("regions")
    if not account_id or not account_id.isdigit() or len(account_id) != 12:
        raise ValueError("account_id must be a 12-digit AWS account ID")
    if not regions or not isinstance(regions, list):
        raise ValueError("regions must be a non-empty list")

    existing = get_account(account_id)
    if existing and existing.get("org_onboard_status") == "ACTIVE":
        raise ValueError(f"Account {account_id} already onboarded")

    deploy_region = os.environ.get("AWS_REGION", "us-east-1")
    try:
        resp = _cf().create_stack_instances(
            StackSetName=stackset,
            DeploymentTargets={
                "OrganizationalUnitIds": [_get_root_id()],
                "Accounts": [account_id],
                "AccountFilterType": "INTERSECTION",
            },
            Regions=[deploy_region],
            OperationPreferences={
                "FailureTolerancePercentage": 0,
                "MaxConcurrentPercentage": 100,
            },
        )
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code == "OperationInProgressException":
            raise ValueError(
                "StackSet 有进行中的 operation, 请稍后重试(操作按序执行)"
            ) from e
        logger.error("create_stack_instances failed for %s: %s", account_id, e)
        raise

    operation_id = resp["OperationId"]

    # 预登记: enabled=False, 待 StackSet SUCCEEDED 后由 status 轮询翻正
    role_arn = f"arn:aws:iam::{account_id}:role/{_MEMBER_ROLE_NAME}"
    put_account(
        account_id,
        role_arn=role_arn,
        regions=regions,
        enabled=False,
        description="via org one-click onboarding",
        org_onboard_status="PROVISIONING",
        org_onboard_operation_id=operation_id,
    )
    logger.info(
        "org-onboard: account=%s operation=%s regions=%s", account_id, operation_id, regions
    )
    return {"_status_code": 202, "operation_id": operation_id, "account_id": account_id}


def _operation_status(operation_id: str, query_params: dict) -> dict:
    """轮询 StackSet operation;成功时启用账号(幂等)。"""
    stackset = _stackset_name()
    account_id = str(query_params.get("account_id", "")).strip()

    op = _cf().describe_stack_set_operation(
        StackSetName=stackset, OperationId=operation_id
    )["StackSetOperation"]
    status = op.get("Status", "UNKNOWN")  # RUNNING|SUCCEEDED|FAILED|STOPPED|...

    if account_id:
        cfg = get_account(account_id)
        if cfg is not None:
            if status == "SUCCEEDED" and cfg.get("org_onboard_status") != "ACTIVE":
                put_account(account_id, enabled=True, org_onboard_status="ACTIVE")
            elif status in ("FAILED", "STOPPED") and cfg.get("org_onboard_status") == "PROVISIONING":
                put_account(account_id, org_onboard_status="FAILED")

    return {"operation_id": operation_id, "status": status, "account_id": account_id}
