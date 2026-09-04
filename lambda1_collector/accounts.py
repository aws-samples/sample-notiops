"""
多账户管理模块。
从 DynamoDB 加载目标账户配置，通过 STS AssumeRole 获取临时凭证，
为每个 Region 创建 boto3 客户端。
"""

import logging
from dataclasses import dataclass

import boto3
from botocore.exceptions import ClientError

from shared.account_scope import filter_allowed
from shared.queries.accounts import list_accounts

logger = logging.getLogger(__name__)


@dataclass
class TargetAccount:
    account_id: str
    role_arn: str
    regions: list[str]
    enabled: bool


def load_target_accounts() -> list[TargetAccount]:
    """从 DynamoDB config 表加载已启用的目标账户配置。

    跨账号闸门:若设置了 LOCKED_ACCOUNT_ID(默认部署形态=部署账号),只保留该账号,
    其余账号在采集前被过滤掉(见 shared/account_scope.py)。本期"跨账号 disabled"。

    部署账号的 onboard 记录由 CDK Custom Resource 自动写入,不含 role_arn/regions
    (那些是跨账号字段)。对于部署账号:
      - role_arn 为空 → handler 跳过 AssumeRole,用 Lambda 自身执行角色
      - regions 缺失 → 默认使用 Lambda 所在 Region (AWS_REGION)
    """
    import os
    items = list_accounts(enabled_only=True)
    items = filter_allowed(items, lambda it: it["account_id"])
    default_region = os.environ.get("AWS_REGION", "us-east-1")
    return [
        TargetAccount(
            account_id=item["account_id"],
            role_arn=item.get("role_arn", ""),
            regions=_clean_regions(
                item.get("regions"), item["account_id"], default_region),
            enabled=item.get("enabled", True),
        )
        for item in items
    ]


def _clean_regions(
    raw: list[str] | None, account_id: str, default_region: str,
) -> list[str]:
    """把 `regions` 字段整成这条老链路能用的形状。

    🔴 `regions` 是**共用字段**：2026-08-29 起巡检也读它，并且约定
    `"*"` = 扫全部 region（`inspection/adapters/accounts.py::ALL_REGIONS`）。
    而这条链路是 `for region in account.regions` → `session.client("rds",
    region_name=region)` —— 拿到 `"*"` 会去解析 `rds.*.amazonaws.com`。

    这里**滤掉 `*` 而不是展开成全部 region**：展开等于让这条老链路一次
    串行扫 17 个区（它每个区一轮 describe + GetMetricData，还有
    `_check_timeout` 保护），必然半路超时 —— 而超时的表现是「后面几个区
    没数据」，看起来像那些区没资源。滤掉之后这条链路的行为与改造前
    **逐字一致**（字段里只有 `*` → 落回默认 region，等同于字段没配）。

    要让老链路也支持全部 region 是另一件事，得先把它改成并发或分片。
    """
    vals = [str(r or "").strip() for r in (raw or [])]
    kept = [r for r in vals if r and r != "*"]
    if len(kept) != len([r for r in vals if r]):
        logger.warning(
            "账号 %s 的 regions 含 '*'（巡检的「全部 region」哨兵），"
            "这条老采集链路不支持，已忽略它；本账号实际采集 %s",
            account_id, kept or [default_region])
    return kept or [default_region]


def assume_role(role_arn: str, account_id: str) -> dict | None:
    """
    调用 STS AssumeRole 获取临时凭证。
    返回凭证字典，失败时返回 None（调用方应跳过该账户）。

    🔴 `account_id` 是 2026-08-30 新加的**必填**参数，用来校验 `role_arn` 的
       账号段。此前本函数只收 ARN —— 也就是说它**没有任何办法**判断这个 ARN
       指向的是不是我们以为的那个账号，而写侧（`api/routes/accounts.py`）
       对 `role_arn` 零校验。详见
       `shared.account_scope.assert_role_belongs_to`。

    ⚠️ 刻意做成**必填位置参数**而不是带默认值的关键字参数：漏改的调用方会
       当场 `TypeError`（fail-loud），而给个默认值会让漏改的那处静默地不校验。
       两个调用方（`handler.py` 与 `ec2_trusted_advisor.py`）手里都有
       `account.account_id`。
       实测：改完之后 `tests/test_ec2_trusted_advisor.py` 里那个单参数的
       假实现立刻红了。
    """
    from shared.account_scope import (
        CrossAccountRoleMismatch, assert_role_belongs_to,
    )

    try:
        assert_role_belongs_to(role_arn, account_id,
                               what=f"account#{account_id}.role_arn")
    except CrossAccountRoleMismatch as e:
        # 走本函数既有的约定（返回 None → 调用方跳过该账户），但用 ERROR：
        # 这不是瞬时故障，是配置被写坏了或有人在试。
        logger.error("拒绝跨账号 AssumeRole: %s", e)
        return None

    try:
        sts_client = boto3.client("sts")
        response = sts_client.assume_role(
            RoleArn=role_arn,
            RoleSessionName="IdleDetectionCollector",
            DurationSeconds=3600,
        )
        credentials = response["Credentials"]
        logger.info("Successfully assumed role: %s", role_arn)
        return {
            "AccessKeyId": credentials["AccessKeyId"],
            "SecretAccessKey": credentials["SecretAccessKey"],
            "SessionToken": credentials["SessionToken"],
        }
    except ClientError as e:
        logger.error("Failed to assume role %s: %s", role_arn, e)
        return None


def create_clients(credentials: dict, region: str) -> dict:
    """
    使用临时凭证为指定 Region 创建 boto3 客户端。
    返回包含 rds_client、elasticache_client、cloudwatch_client 的字典。
    """
    session = boto3.Session(
        aws_access_key_id=credentials["AccessKeyId"],
        aws_secret_access_key=credentials["SecretAccessKey"],
        aws_session_token=credentials["SessionToken"],
        region_name=region,
    )
    return {
        "rds_client": session.client("rds"),
        "elasticache_client": session.client("elasticache"),
        "cloudwatch_client": session.client("cloudwatch"),
        "region": region,
    }
