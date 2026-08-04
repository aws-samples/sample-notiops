"""
Lambda3-HealthChecker ElastiCache 数据加载模块。
负责从 DynamoDB 读取 ElastiCache 配置、监控数据、idle 状态和白名单。
复用 data_loader.py 中的 filter_whitelist() 函数。
"""

import logging
import os
from datetime import date

from shared.queries._client import config_table
from shared.queries.metrics import get_latest_monitoring_date, query_monitoring_by_date
from shared.queries.waste_report import list_waste_reports
from shared.queries.whitelist import load_whitelist_set

logger = logging.getLogger(__name__)

# ElastiCache 内置默认 Agent Prompt（与 schema-init 中的默认值一致）
DEFAULT_EC_AGENT_PROMPT = """\
# Role

你是一位拥有大规模缓存集群管理经验的 AWS 资深架构师。你的任务是分析 Amazon ElastiCache 集群监控数据，为企业 CTO 输出一份高度概括、重点突出、结构清晰且绝对严谨的《AWS ElastiCache 集群性能与优化分析报告》。

# Task
严格基于输入数据生成报告。**报告必须具有全局视野，重点罗列异常实例清单，绝不要长篇大论解释底层原理，严禁输出任何 AWS CLI/API 命令或实施步骤代码。**

---

请接收以下 ElastiCache 监控数据集，并开始生成报告："""


_APPCONFIG_PK = "appconfig#elasticache_health"


def _get_config_value(config_key: str) -> str | None:
    """从 DynamoDB config table 读取 appconfig 项。"""
    resp = config_table().get_item(
        Key={"PK": _APPCONFIG_PK, "SK": config_key}
    )
    item = resp.get("Item")
    if item:
        return item.get("config_value")
    return None


def load_ec_config() -> dict:
    """从 DynamoDB config table 加载 ElastiCache 配置。

    返回 {"agent_prompt": str, "bedrock_model_id": str}。
    若 agent_prompt 不存在，使用内置 ElastiCache 默认值并记录警告。
    若 bedrock_model_id 不存在，使用环境变量 BEDROCK_MODEL_ID。
    """
    config: dict[str, str] = {}

    # Load agent_prompt
    value = _get_config_value("agent_prompt")
    if value:
        config["agent_prompt"] = value
    else:
        logger.warning(
            "agent_prompt not found in appconfig#elasticache_health, using built-in default"
        )
        config["agent_prompt"] = DEFAULT_EC_AGENT_PROMPT

    # Load bedrock_model_id
    value = _get_config_value("bedrock_model_id")
    if value:
        config["bedrock_model_id"] = value
    else:
        fallback = os.environ.get("BEDROCK_MODEL_ID", "")
        if fallback:
            logger.warning(
                "bedrock_model_id not found in appconfig#elasticache_health, "
                "using environment variable BEDROCK_MODEL_ID"
            )
            config["bedrock_model_id"] = fallback
        else:
            logger.warning(
                "bedrock_model_id not found in config or environment variable"
            )
            config["bedrock_model_id"] = ""

    return config


def load_ec_monitoring_data(monitoring_date: date) -> tuple[list[dict], date]:
    """从 DynamoDB metrics table 读取指定日期的全量 ElastiCache 实例数据。

    若指定日期无数据，自动回退到最近有数据的日期。
    包含所有基础指标和新增列。

    Returns:
        (rows, actual_date) — 实例数据列表和实际使用的日期。
    """
    date_str = monitoring_date.isoformat()
    rows = query_monitoring_by_date("elasticache", date_str)
    if rows:
        logger.info(
            "Loaded %d ElastiCache instances from metrics table for %s",
            len(rows), monitoring_date,
        )
        return rows, monitoring_date

    # 回退：查找最近有数据的日期
    logger.warning(
        "No monitoring data for %s, searching for latest available date",
        monitoring_date,
    )
    latest_date_str = get_latest_monitoring_date("elasticache")
    if not latest_date_str:
        logger.warning("No monitoring data found for elasticache at all")
        return [], monitoring_date

    from datetime import datetime
    fallback_date = datetime.strptime(latest_date_str, "%Y-%m-%d").date()

    rows = query_monitoring_by_date("elasticache", latest_date_str)
    logger.info(
        "Fallback: loaded %d ElastiCache instances for %s (requested %s)",
        len(rows), fallback_date, monitoring_date,
    )
    return rows, fallback_date


def load_ec_idle_status(monitoring_date: date) -> dict[tuple[str, str], bool]:
    """从 DynamoDB waste_report 读取 resource_type='elasticache' 的 idle_status。

    返回 {(instance_id, account_id): is_idle} 映射。
    """
    date_str = monitoring_date.isoformat()
    items, _ = list_waste_reports(date=date_str, limit=5000)

    idle_map: dict[tuple[str, str], bool] = {}
    for item in items:
        instance_id = item.get("instance_id", "")
        account_id = item.get("account_id", "")
        if not instance_id or not account_id:
            continue
        # Filter for elasticache resource_type
        rt = item.get("resource_type", item.get("rt", ""))
        if rt and rt != "elasticache":
            continue
        key = (instance_id, account_id)
        idle_map[key] = bool(item.get("is_idle", False))

    logger.info(
        "Loaded idle status for %d ElastiCache instances from waste_report",
        len(idle_map),
    )
    return idle_map


def load_ec_health_check_whitelist() -> list[dict]:
    """从 DynamoDB whitelist 读取 resource_type='elasticache' 且未过期的白名单。

    返回 [{"instance_id": str, "account_id": str}, ...]。
    """
    wl_set = load_whitelist_set("health", rt="elasticache")
    rows = []
    for account, instance in wl_set:
        # $ACCT sentinel means account-level whitelist (instance is empty)
        if instance == "$ACCT":
            rows.append({"instance_id": "", "account_id": account})
        else:
            rows.append({"instance_id": instance, "account_id": account})
    logger.info("Loaded %d ElastiCache health check whitelist entries", len(rows))
    return rows
