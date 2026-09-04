"""
EC2 Trusted Advisor 数据采集模块。
通过 AWS Support API 拉取经典版和新版 Cost Optimization Hub 两个数据源的
EC2 低利用率检查数据，合并后经白名单过滤入库。
"""

import logging
import re
from dataclasses import dataclass
from datetime import date

import boto3
from botocore.exceptions import ClientError

from shared.queries.metrics import put_monitoring_batch, query_monitoring_by_date
from shared.queries.whitelist import load_whitelist_set

logger = logging.getLogger(__name__)

# Trusted Advisor Check IDs
CLASSIC_CHECK_ID = "Qch7DwouX1"
COSTHUB_CHECK_ID = "c1z7kmr00n"

# EC2 Instance ID 格式验证
EC2_INSTANCE_ID_PATTERN = re.compile(r"^i-[0-9a-f]{8,17}$")


# ── 数据类定义 ──


@dataclass
class ClassicCheckRecord:
    """经典版 Trusted Advisor EC2 低利用率检查记录。"""
    instance_id: str
    region: str
    instance_name: str
    instance_type: str
    estimated_savings: float | None
    cpu_14d_avg: float | None
    network_io_14d_avg: float | None
    low_utilization_days: int | None


@dataclass
class CostHubCheckRecord:
    """新版 Cost Optimization Hub EC2 检查记录。"""
    instance_id: str
    region: str
    status: str
    recommended_action: str
    current_resource_summary: str
    recommended_resource_summary: str
    estimated_monthly_cost: float | None
    estimated_savings: float | None
    last_refresh: str


@dataclass
class MergedEc2Record:
    """合并后的 EC2 记录，包含经典版指标和新版优化建议。"""
    instance_id: str
    account_id: str
    region: str
    instance_name: str | None
    instance_type: str | None
    # 经典版字段
    cpu_14d_avg: float | None
    network_io_14d_avg: float | None
    low_utilization_days: int | None
    classic_estimated_savings: float | None
    # 新版字段
    recommended_action: str | None
    current_resource_summary: str | None
    recommended_resource_summary: str | None
    costhub_estimated_monthly_cost: float | None
    costhub_estimated_savings: float | None
    costhub_last_refresh: str | None
    status: str | None


# ── 安全类型转换辅助函数 ──


def _safe_float(value: str) -> float | None:
    """将字符串安全转换为 float，转换失败返回 None。"""
    try:
        return float(value)
    except (ValueError, TypeError):
        return None


def _safe_int(value: str) -> int | None:
    """将字符串安全转换为 int，转换失败返回 None。"""
    try:
        return int(value)
    except (ValueError, TypeError):
        return None


# ── 经典版数据采集 ──


def fetch_classic_check(support_client) -> list[ClassicCheckRecord]:
    """
    调用 Support API 获取经典版 EC2 低利用率检查结果。
    Check ID: Qch7DwouX1，按固定索引解析 metadata 数组。

    metadata 索引映射:
        0 - Region/AZ (不直接使用，改用 resource 级别 region 字段)
        1 - Instance ID
        2 - Instance Name
        3 - Instance Type
        4 - Estimated Monthly Savings (float)
        5 - CPU Utilization 14-Day Average (float)
        6 - Network I/O 14-Day Average (float)
        7 - Number of Days Low Utilization (int)
    """
    try:
        response = support_client.describe_trusted_advisor_check_result(
            checkId=CLASSIC_CHECK_ID,
            language="en",
        )
    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        logger.error(
            "Support API error fetching classic check (code=%s): %s",
            error_code, e,
        )
        return []
    except Exception as e:
        logger.error("Unexpected error fetching classic check: %s", e)
        return []

    flagged = response.get("result", {}).get("flaggedResources", [])
    records: list[ClassicCheckRecord] = []

    for resource in flagged:
        metadata = resource.get("metadata", [])
        if len(metadata) < 8:
            logger.warning(
                "Skipping classic record with insufficient metadata length: %d",
                len(metadata),
            )
            continue

        instance_id = metadata[1]
        if not EC2_INSTANCE_ID_PATTERN.match(instance_id):
            logger.warning(
                "Skipping classic record with invalid Instance ID: %s",
                instance_id,
            )
            continue

        # metadata[0] 是 AZ（如 us-east-1a），用 resource 级别 region 字段获取标准 region
        region = resource.get("region", "")
        if not region:
            # fallback: 从 AZ 去掉末尾字母得到 region
            raw_az = metadata[0]
            region = raw_az.rstrip("abcdefghij") if raw_az else ""
        if not region:
            logger.warning(
                "Skipping classic record with empty region: instance_id=%s",
                instance_id,
            )
            continue

        records.append(
            ClassicCheckRecord(
                region=region,
                instance_id=instance_id,
                instance_name=metadata[2],
                instance_type=metadata[3],
                estimated_savings=_safe_float(metadata[4]),
                cpu_14d_avg=_safe_float(metadata[5]),
                network_io_14d_avg=_safe_float(metadata[6]),
                low_utilization_days=_safe_int(metadata[7]),
            )
        )

    logger.info("Classic check: parsed %d records", len(records))
    return records

# ── 新版 Cost Optimization Hub 数据采集 ──


def fetch_costhub_check(support_client) -> list[CostHubCheckRecord]:
    """
    调用 Support API 获取新版 Cost Optimization Hub EC2 检查结果。
    Check ID: c1z7kmr00n，解析 flaggedResources 中的结构化字段。

    metadata 索引映射:
        0 - Resource ID (Instance ID)
        1 - Recommended Action
        2 - Current Resource Summary
        3 - Recommended Resource Summary
        4 - Estimated Monthly Cost (float)
        5 - Estimated Monthly Savings (float)
        6 - Last Refresh Timestamp
    """
    try:
        response = support_client.describe_trusted_advisor_check_result(
            checkId=COSTHUB_CHECK_ID,
            language="en",
        )
    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code", "")
        logger.error(
            "Support API error fetching CostHub check (code=%s): %s",
            error_code, e,
        )
        return []
    except Exception as e:
        logger.error("Unexpected error fetching CostHub check: %s", e)
        return []

    flagged = response.get("result", {}).get("flaggedResources", [])
    records: list[CostHubCheckRecord] = []

    for resource in flagged:
        metadata = resource.get("metadata", [])
        if len(metadata) < 7:
            logger.warning(
                "Skipping CostHub record with insufficient metadata length: %d",
                len(metadata),
            )
            continue

        instance_id = metadata[0]
        if not EC2_INSTANCE_ID_PATTERN.match(instance_id):
            logger.warning(
                "Skipping CostHub record with invalid Instance ID: %s",
                instance_id,
            )
            continue

        records.append(
            CostHubCheckRecord(
                instance_id=instance_id,
                region=resource.get("region", ""),
                status=resource.get("status", ""),
                recommended_action=metadata[1],
                current_resource_summary=metadata[2],
                recommended_resource_summary=metadata[3],
                estimated_monthly_cost=_safe_float(metadata[4]),
                estimated_savings=_safe_float(metadata[5]),
                last_refresh=metadata[6],
            )
        )

    logger.info("CostHub check: parsed %d records", len(records))
    return records

# ── 双数据源合并 ──


def merge_check_results(
    classic: list[ClassicCheckRecord],
    costhub: list[CostHubCheckRecord],
    account_id: str,
) -> list[MergedEc2Record]:
    """以 Instance ID + Region 为联合键，FULL OUTER JOIN 合并两个数据源。
    以新版数据为左表，经典版数据为右表；Step 3 保留仅经典版存在的记录。"""

    # Step 1: 构建经典版字典，键为 (instance_id, region)
    classic_map: dict[tuple[str, str], ClassicCheckRecord] = {}
    for rec in classic:
        classic_map[(rec.instance_id, rec.region)] = rec

    merged: list[MergedEc2Record] = []
    matched_keys: set[tuple[str, str]] = set()

    # Step 2: 遍历新版记录（左表），查找匹配的经典版记录
    for ch in costhub:
        key = (ch.instance_id, ch.region)
        cl = classic_map.get(key)

        if cl is not None:
            # 两者都有：填充所有字段
            matched_keys.add(key)
            merged.append(
                MergedEc2Record(
                    instance_id=ch.instance_id,
                    account_id=account_id,
                    region=ch.region,
                    instance_name=cl.instance_name,
                    instance_type=cl.instance_type,
                    cpu_14d_avg=cl.cpu_14d_avg,
                    network_io_14d_avg=cl.network_io_14d_avg,
                    low_utilization_days=cl.low_utilization_days,
                    classic_estimated_savings=cl.estimated_savings,
                    recommended_action=ch.recommended_action,
                    current_resource_summary=ch.current_resource_summary,
                    recommended_resource_summary=ch.recommended_resource_summary,
                    costhub_estimated_monthly_cost=ch.estimated_monthly_cost,
                    costhub_estimated_savings=ch.estimated_savings,
                    costhub_last_refresh=ch.last_refresh,
                    status=ch.status,
                )
            )
        else:
            # 仅新版：经典版字段设为 None
            merged.append(
                MergedEc2Record(
                    instance_id=ch.instance_id,
                    account_id=account_id,
                    region=ch.region,
                    instance_name=None,
                    instance_type=None,
                    cpu_14d_avg=None,
                    network_io_14d_avg=None,
                    low_utilization_days=None,
                    classic_estimated_savings=None,
                    recommended_action=ch.recommended_action,
                    current_resource_summary=ch.current_resource_summary,
                    recommended_resource_summary=ch.recommended_resource_summary,
                    costhub_estimated_monthly_cost=ch.estimated_monthly_cost,
                    costhub_estimated_savings=ch.estimated_savings,
                    costhub_last_refresh=ch.last_refresh,
                    status=ch.status,
                )
            )

    # Step 3: 遍历仅存在于经典版的记录
    for key, cl in classic_map.items():
        if key not in matched_keys:
            merged.append(
                MergedEc2Record(
                    instance_id=cl.instance_id,
                    account_id=account_id,
                    region=cl.region,
                    instance_name=cl.instance_name,
                    instance_type=cl.instance_type,
                    cpu_14d_avg=cl.cpu_14d_avg,
                    network_io_14d_avg=cl.network_io_14d_avg,
                    low_utilization_days=cl.low_utilization_days,
                    classic_estimated_savings=cl.estimated_savings,
                    recommended_action=None,
                    current_resource_summary=None,
                    recommended_resource_summary=None,
                    costhub_estimated_monthly_cost=None,
                    costhub_estimated_savings=None,
                    costhub_last_refresh=None,
                    status=None,
                )
            )

    # Step 4: 记录合并统计日志
    classic_only = len(classic_map) - len(matched_keys)
    costhub_only = len(costhub) - len(matched_keys)
    logger.info(
        "Merge results: classic=%d, costhub=%d, merged=%d, classic_only=%d, costhub_only=%d",
        len(classic), len(costhub), len(merged), classic_only, costhub_only,
    )

    return merged


# ── 白名单过滤 ──


def filter_ec2_whitelist(
    records: list[MergedEc2Record],
    whitelist_set: set[tuple[str, str]],
) -> list[MergedEc2Record]:
    """过滤白名单中的 EC2 记录。
    匹配条件：(account_id, instance_id) in whitelist_set。"""

    before_count = len(records)
    result: list[MergedEc2Record] = []

    for rec in records:
        if (rec.account_id, rec.instance_id) in whitelist_set:
            logger.debug(
                "EC2 whitelist filtered: instance_id=%s, account_id=%s",
                rec.instance_id, rec.account_id,
            )
            continue
        result.append(rec)

    logger.info(
        "EC2 whitelist filter: before=%d, after=%d, filtered=%d",
        before_count, len(result), before_count - len(result),
    )
    return result


# ── 批量 Upsert 入库 ──


def bulk_upsert_ec2_data(
    records: list[MergedEc2Record],
    monitoring_date: date,
) -> int:
    """批量写入 EC2 monitoring data 到 DynamoDB metrics 表。
    使用 put_monitoring_batch 的 PutItem 语义（幂等 upsert）。
    返回写入记录数。"""
    if not records:
        logger.info("No EC2 records to upsert, skipping")
        return 0

    date_str = monitoring_date.isoformat()
    rows = []
    for rec in records:
        row = {
            "instance": rec.instance_id,
            "account": rec.account_id,
            "region": rec.region,
            "date": date_str,
            "instance_name": rec.instance_name,
            "instance_type": rec.instance_type,
            "cpu_14d_avg": rec.cpu_14d_avg,
            "network_io_14d_avg": rec.network_io_14d_avg,
            "low_utilization_days": rec.low_utilization_days,
            "classic_estimated_savings": rec.classic_estimated_savings,
            "recommended_action": rec.recommended_action,
            "current_resource_summary": rec.current_resource_summary,
            "recommended_resource_summary": rec.recommended_resource_summary,
            "costhub_estimated_monthly_cost": rec.costhub_estimated_monthly_cost,
            "costhub_estimated_savings": rec.costhub_estimated_savings,
            "costhub_last_refresh": rec.costhub_last_refresh,
            "status": rec.status,
            "cand_flag": 0,
        }
        # Remove None values
        row = {k: v for k, v in row.items() if v is not None}
        rows.append(row)

    count = put_monitoring_batch("ec2", rows)
    logger.info("EC2 upsert: wrote %d records for monitoring_date=%s", count, monitoring_date)
    return count

# ── 采集主入口 ──


def _load_ec2_whitelist() -> set[tuple[str, str]]:
    """从 DynamoDB config 表加载 EC2 白名单，返回 (account, instance) set。"""
    return load_whitelist_set("waste", rt="ec2")


def collect_ec2_trusted_advisor(context) -> dict:
    """EC2 Trusted Advisor 数据采集主入口。
    遍历目标账户，执行采集、合并、过滤、入库全流程。
    返回统计字典 {"ec2_discovered": N, "ec2_after_whitelist": N, ...}。"""
    from lambda1_collector.accounts import load_target_accounts, assume_role

    stats = {
        "ec2_discovered": 0,
        "ec2_after_whitelist": 0,
        "ec2_accounts_success": 0,
        "ec2_accounts_failed": 0,
    }

    # 加载目标账户和白名单
    accounts = load_target_accounts()
    whitelist_set = _load_ec2_whitelist()
    monitoring_date = date.today()

    logger.info("EC2 Trusted Advisor collection started: %d accounts, monitoring_date=%s",
                len(accounts), monitoring_date)

    for account in accounts:
        try:
            # STS AssumeRole — 部署账号(role_arn 为空)用 Lambda 自身角色
            if account.role_arn:
                credentials = assume_role(account.role_arn, account.account_id)
                if credentials is None:
                    logger.warning(
                        "EC2 collection: skipping account %s, AssumeRole failed",
                        account.account_id,
                    )
                    stats["ec2_accounts_failed"] += 1
                    continue
                session = boto3.Session(
                    aws_access_key_id=credentials["AccessKeyId"],
                    aws_secret_access_key=credentials["SecretAccessKey"],
                    aws_session_token=credentials["SessionToken"],
                    region_name="us-east-1",
                )
            else:
                session = boto3.Session(region_name="us-east-1")

            # Support API 必须用 us-east-1 端点
            support_client = session.client("support")

            # 顺序执行：经典版采集 → 新版采集 → 合并 → 白名单过滤 → 入库
            classic_records = fetch_classic_check(support_client)
            costhub_records = fetch_costhub_check(support_client)
            merged = merge_check_results(classic_records, costhub_records, account.account_id)
            filtered = filter_ec2_whitelist(merged, whitelist_set)
            upserted = bulk_upsert_ec2_data(filtered, monitoring_date)

            stats["ec2_discovered"] += len(merged)
            stats["ec2_after_whitelist"] += len(filtered)
            stats["ec2_accounts_success"] += 1

            logger.info(
                "EC2 collection for account %s: classic=%d, costhub=%d, merged=%d, "
                "after_whitelist=%d, upserted=%d",
                account.account_id, len(classic_records), len(costhub_records),
                len(merged), len(filtered), upserted,
            )

        except Exception as e:
            logger.error(
                "EC2 collection failed for account %s: %s",
                account.account_id, e, exc_info=True,
            )
            stats["ec2_accounts_failed"] += 1
            continue

    logger.info(
        "EC2 Trusted Advisor collection completed: success=%d, failed=%d, "
        "discovered=%d, after_whitelist=%d",
        stats["ec2_accounts_success"], stats["ec2_accounts_failed"],
        stats["ec2_discovered"], stats["ec2_after_whitelist"],
    )

    return stats
