"""
Lambda3-HealthChecker ElastiCache 报告存储模块。
负责 ElastiCache 巡检报告的 DynamoDB 持久化（创建、保存、状态更新）。
"""

import logging
from datetime import date

from shared.queries.reports import begin_health_report, upsert_health_report, get_health_report

logger = logging.getLogger(__name__)


def create_ec_generating_record(report_date: date) -> str:
    """创建 status='generating' 的占位记录（手动触发时使用）。

    Args:
        report_date: 报告日期。

    Returns:
        新创建记录的 report_id (uuid string)。
    """
    report_id = begin_health_report("elasticache", report_date.isoformat(), "summary")
    logger.info(
        "Created ElastiCache generating record: report_id=%s, report_date=%s",
        report_id, report_date,
    )
    return report_id


def save_ec_report(
    report_id: str | None,
    report_date: date,
    report_type: str,
    account_id: str | None,
    region: str | None,
    total_instances: int,
    critical_count: int,
    warning_count: int,
    attention_count: int,
    report_content: str,
    model_id: str,
    status: str = "completed",
) -> str:
    """保存或更新 ElastiCache 报告记录。

    Uses upsert_health_report to write report fields to DynamoDB.
    The item is keyed by (rt='elasticache', date, type, account).

    Returns:
        报告记录的 id (uuid string)。
    """
    upsert_health_report(
        "elasticache",
        report_date.isoformat(),
        report_type,
        account=account_id,
        status=status,
        region=region or "",
        total_instances=total_instances,
        critical_count=critical_count,
        warning_count=warning_count,
        attention_count=attention_count,
        report_content=report_content,
        model_id=model_id,
    )

    # Retrieve the id from the upserted item
    item = get_health_report("elasticache", report_date.isoformat(), report_type, account=account_id)
    result_id = item["id"] if item else report_id or ""

    logger.info(
        "Saved ElastiCache report: id=%s, report_date=%s, report_type=%s, "
        "account_id=%s, status=%s",
        result_id, report_date, report_type, account_id, status,
    )
    return result_id


def update_ec_report_status(
    report_id: str,
    status: str,
    error_message: str | None = None,
    *,
    report_date: date | None = None,
    report_type: str = "summary",
    account_id: str | None = None,
) -> None:
    """更新 ElastiCache 报告状态（generating → completed/failed）。

    Args:
        report_id: 报告记录 ID (unused for DDB key but kept for API compat).
        status: 新状态（"completed" 或 "failed"）。
        error_message: 失败时的错误信息。
        report_date: 报告日期（DDB key 需要）。
        report_type: 报告类型。
        account_id: 账户ID。
    """
    if report_date is None:
        logger.warning(
            "update_ec_report_status called without report_date; cannot locate DDB item"
        )
        return

    fields: dict = {"status": status}
    if error_message:
        fields["error_message"] = error_message

    upsert_health_report(
        "elasticache",
        report_date.isoformat(),
        report_type,
        account=account_id,
        **fields,
    )
    logger.info(
        "Updated ElastiCache report status: report_id=%s, status=%s, error_message=%s",
        report_id, status, error_message[:100] if error_message else None,
    )
