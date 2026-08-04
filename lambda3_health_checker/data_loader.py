"""
Lambda3-HealthChecker 数据加载模块。
负责从 DynamoDB 读取配置、监控数据、idle 状态和白名单。
"""

import logging
import os
from datetime import date

from shared.queries._client import config_table
from shared.queries.metrics import get_latest_monitoring_date, query_monitoring_by_date
from shared.queries.waste_report import list_waste_reports
from shared.queries.whitelist import load_whitelist_set

logger = logging.getLogger(__name__)

DEFAULT_AGENT_PROMPT = """\
# Role

你是一位拥有大规模集群管理经验的 AWS 资深数据库架构师。你的任务是分析包含 Amazon Aurora 和 Amazon RDS 标准实例的混合集群监控数据，为企业 CTO 输出一份高度概括、重点突出、结构清晰且绝对严谨的《AWS RDS/Aurora 大规模集群性能与优化分析报告》。

# Task
严格基于输入数据生成报告。**报告必须具有全局视野，重点罗列异常实例清单，绝不要长篇大论解释底层原理，严禁输出任何 AWS CLI/API 命令或实施步骤代码。**

---

请接收以下 RDS/Aurora 混合监控数据集，并开始生成报告："""


_APPCONFIG_PK = "appconfig#rds_health"


def _get_config_value(config_key: str) -> str | None:
    """从 DynamoDB config table 读取 appconfig 项。"""
    resp = config_table().get_item(
        Key={"PK": _APPCONFIG_PK, "SK": config_key}
    )
    item = resp.get("Item")
    if item:
        return item.get("config_value")
    return None


def load_config() -> dict:
    """从 DynamoDB config table 加载配置。

    返回 {"agent_prompt": str, "bedrock_model_id": str}。
    若 agent_prompt 不存在，使用内置默认值并记录警告。
    若 bedrock_model_id 不存在，使用环境变量 BEDROCK_MODEL_ID。
    Bedrock Invoker 直接通过环境变量 BEDROCK_API_KEY_SECRET_ARN 获取 Secret ARN。
    """
    config: dict[str, str] = {}

    # Load agent_prompt
    value = _get_config_value("agent_prompt")
    if value:
        config["agent_prompt"] = value
    else:
        logger.warning(
            "agent_prompt not found in appconfig#rds_health, using built-in default"
        )
        config["agent_prompt"] = DEFAULT_AGENT_PROMPT

    # Load bedrock_model_id
    value = _get_config_value("bedrock_model_id")
    if value:
        config["bedrock_model_id"] = value
    else:
        fallback = os.environ.get("BEDROCK_MODEL_ID", "")
        if fallback:
            logger.warning(
                "bedrock_model_id not found in appconfig#rds_health, "
                "using environment variable BEDROCK_MODEL_ID"
            )
            config["bedrock_model_id"] = fallback
        else:
            logger.warning(
                "bedrock_model_id not found in config or environment variable"
            )
            config["bedrock_model_id"] = ""

    return config



def load_monitoring_data(monitoring_date: date) -> tuple[list[dict], date]:
    """从 DynamoDB metrics table 读取指定日期的全量 RDS 实例数据。

    若指定日期无数据，自动回退到最近有数据的日期。
    包含所有基础指标和深度指标列。

    Returns:
        (rows, actual_date) — 实例数据列表和实际使用的日期。
    """
    date_str = monitoring_date.isoformat()
    rows = query_monitoring_by_date("rds", date_str)
    if rows:
        logger.info(
            "Loaded %d RDS instances from metrics table for %s",
            len(rows), monitoring_date,
        )
        return rows, monitoring_date

    # 回退：查找最近有数据的日期
    logger.warning(
        "No monitoring data for %s, searching for latest available date",
        monitoring_date,
    )
    latest_date_str = get_latest_monitoring_date("rds")
    if not latest_date_str:
        logger.warning("No monitoring data found for rds at all")
        return [], monitoring_date

    from datetime import datetime
    fallback_date = datetime.strptime(latest_date_str, "%Y-%m-%d").date()

    rows = query_monitoring_by_date("rds", latest_date_str)
    logger.info(
        "Fallback: loaded %d RDS instances for %s (requested %s)",
        len(rows), fallback_date, monitoring_date,
    )
    return rows, fallback_date


def load_idle_status(monitoring_date: date) -> dict[tuple[str, str], bool]:
    """从 DynamoDB waste_report 读取当天的 idle_status。

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
        # Filter for rds resource_type if present in item
        rt = item.get("resource_type", item.get("rt", ""))
        if rt and rt != "rds":
            continue
        key = (instance_id, account_id)
        idle_map[key] = bool(item.get("is_idle", False))

    logger.info(
        "Loaded idle status for %d RDS instances from waste_report", len(idle_map)
    )
    return idle_map


def load_health_check_whitelist() -> list[dict]:
    """从 DynamoDB whitelist 读取 resource_type='rds' 的白名单。

    返回 [{"instance_id": str, "account_id": str}, ...]。
    """
    wl_set = load_whitelist_set("health", rt="rds")
    rows = []
    for account, instance in wl_set:
        # $ACCT sentinel means account-level whitelist (instance is empty)
        if instance == "$ACCT":
            rows.append({"instance_id": "", "account_id": account})
        else:
            rows.append({"instance_id": instance, "account_id": account})
    logger.info("Loaded %d RDS health check whitelist entries", len(rows))
    return rows


def filter_whitelist(
    instances: list[dict],
    whitelist: list[dict],
) -> list[dict]:
    """根据白名单过滤实例列表。

    匹配规则：
    - 同时指定 instance_id 和 account_id → 精确匹配
    - 只指定 instance_id（account_id 为空）→ 匹配所有账户下同名实例
    - 只指定 account_id（instance_id 为空）→ 跳过该账户所有实例
    返回过滤后的实例列表。
    """
    if not whitelist:
        return instances

    # 精确匹配集合：(instance_id, account_id)
    exact_set: set[tuple[str, str]] = set()
    # instance_id 通配集合（account_id 为空）
    instance_wildcard_set: set[str] = set()
    # account_id 通配集合（instance_id 为空）
    account_wildcard_set: set[str] = set()

    for entry in whitelist:
        iid = entry.get("instance_id") or ""
        aid = entry.get("account_id") or ""
        if iid and aid:
            exact_set.add((iid, aid))
        elif iid:
            instance_wildcard_set.add(iid)
        elif aid:
            account_wildcard_set.add(aid)

    filtered = [
        inst for inst in instances
        if inst["instance"] not in instance_wildcard_set
        and (inst.get("account") or "") not in account_wildcard_set
        and (inst["instance"], inst.get("account")) not in exact_set
    ]

    excluded_count = len(instances) - len(filtered)
    if excluded_count > 0:
        logger.info(
            "Filtered %d instances by health check whitelist, %d remaining",
            excluded_count, len(filtered),
        )

    return filtered
