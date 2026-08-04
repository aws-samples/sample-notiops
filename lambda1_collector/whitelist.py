"""
白名单过滤模块。
从 DynamoDB 加载白名单配置，结合 Tag 过滤和配置表 ID 过滤，
剔除不需要检测的实例。
"""

import logging
from dataclasses import dataclass
from datetime import datetime

from shared.queries.whitelist import load_whitelist_set
from lambda1_collector.discovery import InstanceMetadata

logger = logging.getLogger(__name__)

# 白名单 Tag 键值
WHITELIST_TAG_KEY = "Op:IgnoreIdle"
WHITELIST_TAG_VALUE = "true"


@dataclass
class WhitelistEntry:
    instance_id: str
    account_id: str | None
    reason: str
    created_at: datetime | None = None


def load_whitelist() -> list[WhitelistEntry]:
    """从 DynamoDB config 表加载 waste 类型白名单。
    返回 WhitelistEntry 列表，兼容下游 filter_whitelist 接口。
    """
    whitelist_pairs = load_whitelist_set("waste")
    return [
        WhitelistEntry(
            instance_id=instance,
            account_id=account,
            reason="",
        )
        for account, instance in whitelist_pairs
    ]


def filter_whitelist(
    instances: list[InstanceMetadata],
    whitelist: list[WhitelistEntry],
) -> list[InstanceMetadata]:
    """
    过滤逻辑：
    1. 剔除 tags 中包含 Op:IgnoreIdle=true 的实例
    2. 剔除 instance_id 在白名单配置表中的实例
    返回过滤后的 Target_Instance_List
    """
    whitelist_ids = {entry.instance_id for entry in whitelist}

    result = []
    for instance in instances:
        # 检查 Tag 白名单
        tag_value = instance.tags.get(WHITELIST_TAG_KEY, "")
        if tag_value.lower() == WHITELIST_TAG_VALUE:
            logger.debug("Filtered by tag: %s", instance.instance_id)
            continue

        # 检查配置表白名单
        if instance.instance_id in whitelist_ids:
            logger.debug("Filtered by whitelist table: %s", instance.instance_id)
            continue

        result.append(instance)

    filtered_count = len(instances) - len(result)
    logger.info(
        "Whitelist filter: %d/%d instances filtered, %d remaining",
        filtered_count, len(instances), len(result),
    )
    return result
