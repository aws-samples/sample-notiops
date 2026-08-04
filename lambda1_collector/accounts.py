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
            regions=item.get("regions") or [default_region],
            enabled=item.get("enabled", True),
        )
        for item in items
    ]


def assume_role(role_arn: str) -> dict | None:
    """
    调用 STS AssumeRole 获取临时凭证。
    返回凭证字典，失败时返回 None（调用方应跳过该账户）。
    """
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
