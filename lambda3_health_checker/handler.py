"""
Lambda3-HealthChecker 主入口。
协调完整的 AI 巡检流程：加载配置 → 读取监控数据 → 排除白名单 →
构建 Metrics Payload → 调用 Bedrock → 解析报告 → 存储报告。
"""

import logging
import time
from datetime import date, datetime

from lambda3_health_checker.data_loader import (
    load_config,
    load_monitoring_data,
    load_idle_status,
    load_health_check_whitelist,
    filter_whitelist,
)
from lambda3_health_checker.payload_formatter import (
    estimate_token_count,
    format_metrics_payload,
    split_payload_by_account,
)
from lambda3_health_checker.bedrock_invoker import invoke_bedrock
from lambda3_health_checker.report_parser import merge_reports, parse_report_summary
from lambda3_health_checker.report_saver import (
    save_report,
    update_report_status,
)
from lambda3_health_checker.ec_data_loader import (
    load_ec_config,
    load_ec_monitoring_data,
    load_ec_idle_status,
    load_ec_health_check_whitelist,
)
from lambda3_health_checker.ec_payload_formatter import (
    format_ec_metrics_payload,
    split_ec_payload_by_account,
)
from lambda3_health_checker.ec_report_saver import (
    save_ec_report,
    update_ec_report_status,
)

logger = logging.getLogger(__name__)

MAX_PAYLOAD_TOKENS = 100000


def handler(event: dict, context) -> dict:
    """Lambda3-HealthChecker 主入口。

    通过 event.get("resource_type", "rds") 路由到不同巡检路径。
    - "rds": 现有 RDS 巡检流程（默认值，向后兼容）
    - "elasticache": ElastiCache 巡检流程

    触发来源：
      - EventBridge 自动触发：event 中不含 report_id
      - API 手动触发：event 中包含 report_id（指向 status='generating' 的占位记录）

    Returns:
        包含执行状态信息的 dict。
    """
    resource_type = event.get("resource_type", "rds") if event else "rds"
    if resource_type == "elasticache":
        return _handle_elasticache(event)

    # --- RDS 巡检路径（默认，保持向后兼容）---
    report_id = event.get("report_id") if event else None
    trigger_source = "manual" if report_id else "eventbridge"
    logger.info("Lambda3-HealthChecker started: trigger=%s, report_id=%s", trigger_source, report_id)

    # Default date so the except-block status write can locate the DDB item
    # even if the failure happens before step 2 computes monitoring_date.
    monitoring_date = date.today()

    try:
        # 1. Load config
        config = load_config()
        agent_prompt = config["agent_prompt"]
        model_id = config["bedrock_model_id"]
        if not model_id:
            raise ValueError("bedrock_model_id is not configured")
        # API Key auth is handled internally by bedrock_invoker via env var

        # 2. Determine monitoring date
        raw_date = event.get("monitoring_date") if event else None
        if raw_date:
            if isinstance(raw_date, str):
                monitoring_date = datetime.strptime(raw_date, "%Y-%m-%d").date()
            else:
                monitoring_date = raw_date
        else:
            monitoring_date = date.today()
        logger.info("Monitoring date: %s", monitoring_date)

        # 3. Load monitoring data (auto-fallback to latest available date)
        instances, actual_date = load_monitoring_data(monitoring_date)
        if not instances:
            msg = f"No monitoring data found for {monitoring_date}"
            logger.warning(msg)
            if report_id:
                update_report_status(report_id, "failed", msg, report_date=monitoring_date)
            return {"status": "failed", "message": msg}
        if actual_date != monitoring_date:
            logger.info("Using fallback date %s instead of %s", actual_date, monitoring_date)
            monitoring_date = actual_date

        # 4. Load and apply whitelist
        whitelist = load_health_check_whitelist()
        instances = filter_whitelist(instances, whitelist)
        if not instances:
            msg = "所有实例均已加入巡检白名单，本次巡检已跳过。如需生成报告，请先从白名单中移除部分实例。"
            logger.info("All instances filtered by whitelist for %s, skipping", monitoring_date)
            skip_content = (
                f"# RDS 巡检报告 — {monitoring_date}\n\n"
                f"**状态：已跳过**\n\n"
                f"所有 RDS 实例均在巡检白名单中，无需巡检的实例。\n\n"
                f"如需生成报告，请前往「AI 巡检设置 → 巡检白名单」移除部分实例后重新触发。"
            )
            if report_id:
                save_report(
                    report_id=report_id,
                    report_date=monitoring_date,
                    report_type="summary",
                    account_id=None,
                    region=None,
                    total_instances=0,
                    critical_count=0,
                    warning_count=0,
                    attention_count=0,
                    report_content=skip_content,
                    model_id=model_id,
                    status="skipped",
                )
            return {"status": "skipped", "message": msg}

        # 5. Load idle status and exclude idle instances (already in waste_report)
        idle_status = load_idle_status(monitoring_date)
        before_count = len(instances)
        instances = [
            i for i in instances
            if not idle_status.get((i["instance"], i["account"]), False)
        ]
        if before_count != len(instances):
            logger.info("Excluded %d idle instances, %d remaining", before_count - len(instances), len(instances))

        # 6. Build payload and check token count
        now_str = datetime.now().strftime("%Y年%m月%d日 %H:%M")
        num_accounts = len({i["account"] for i in instances})
        num_regions = len({i["region"] for i in instances})
        payload_header = (
            f"分析时间: {now_str}\n监控数据日期: {monitoring_date}\n"
            f"【准确统计（请直接引用，不要自行计算）】总实例数: {len(instances)}, "
            f"账户数: {num_accounts}, 区域数: {num_regions}\n\n"
        )
        payload = payload_header + format_metrics_payload(instances, idle_status)
        tokens = estimate_token_count(payload)
        logger.info("Payload token estimate: %d (max=%d)", tokens, MAX_PAYLOAD_TOKENS)

        total_instances = len(instances)
        bedrock_start = time.time()

        if tokens > MAX_PAYLOAD_TOKENS:
            # --- Batch mode: split by account ---
            result = _handle_batch_mode(
                instances, idle_status, model_id, agent_prompt,
                monitoring_date, report_id,
            )
        else:
            # --- Single call mode ---
            result = _handle_single_mode(
                payload, model_id, agent_prompt,
                monitoring_date, report_id, total_instances,
            )

        bedrock_duration = time.time() - bedrock_start

        logger.info(
            "Lambda3-HealthChecker completed: trigger=%s, instances=%d, "
            "bedrock_time=%.1fs, status=%s",
            trigger_source, total_instances, bedrock_duration, result.get("status"),
        )
        return result

    except Exception as e:
        logger.error("Lambda3-HealthChecker failed: %s", str(e), exc_info=True)
        if report_id:
            try:
                update_report_status(report_id, "failed", str(e), report_date=monitoring_date)
            except Exception:
                logger.error("Failed to update report status", exc_info=True)
        return {"status": "failed", "message": str(e)}


def _handle_single_mode(
    payload: str,
    model_id: str,
    agent_prompt: str,
    monitoring_date: date,
    report_id: int | None,
    total_instances: int,
) -> dict:
    """Single Bedrock call when payload fits within token limit."""
    result = invoke_bedrock(model_id, agent_prompt, payload)
    report_content = result["content"]

    summary = parse_report_summary(report_content)
    # Always use the actual instance count from code, not from LLM-generated text
    summary["total_instances"] = total_instances

    saved_id = save_report(
        report_id=report_id,
        report_date=monitoring_date,
        report_type="summary",
        account_id=None,
        region=None,
        total_instances=total_instances,
        critical_count=summary["critical_count"],
        warning_count=summary["warning_count"],
        attention_count=summary["attention_count"],
        report_content=report_content,
        model_id=model_id,
        status="completed",
    )

    return {
        "status": "completed",
        "report_id": saved_id,
        "total_instances": total_instances,
        "critical_count": summary["critical_count"],
        "warning_count": summary["warning_count"],
        "attention_count": summary["attention_count"],
    }


def _handle_batch_mode(
    instances: list[dict],
    idle_status: dict,
    model_id: str,
    agent_prompt: str,
    monitoring_date: date,
    report_id: int | None,
) -> dict:
    """Batch Bedrock calls when payload exceeds token limit.

    Splits by account, calls Bedrock per batch, saves per_account reports,
    then merges and saves a summary report.
    """
    batches = split_payload_by_account(instances, idle_status, MAX_PAYLOAD_TOKENS)
    logger.info("Batch mode: %d batches for %d instances", len(batches), len(instances))

    batch_reports: list[str] = []
    total_critical = 0
    total_warning = 0
    total_attention = 0

    now_str = datetime.now().strftime("%Y年%m月%d日 %H:%M")
    batch_header = f"分析时间: {now_str}\n监控数据日期: {monitoring_date}\n\n"

    for i, batch_payload in enumerate(batches, start=1):
        logger.info("Processing batch %d/%d", i, len(batches))
        result = invoke_bedrock(
            model_id, agent_prompt, batch_header + batch_payload,
        )
        batch_content = result["content"]
        batch_reports.append(batch_content)

        # Parse and save per_account report
        batch_summary = parse_report_summary(batch_content)
        total_critical += batch_summary["critical_count"]
        total_warning += batch_summary["warning_count"]
        total_attention += batch_summary["attention_count"]

        save_report(
            report_id=None,
            report_date=monitoring_date,
            report_type="per_account",
            account_id=f"batch_{i}",
            region=None,
            total_instances=batch_summary["total_instances"],
            critical_count=batch_summary["critical_count"],
            warning_count=batch_summary["warning_count"],
            attention_count=batch_summary["attention_count"],
            report_content=batch_content,
            model_id=model_id,
            status="completed",
        )

    # Merge all batch reports into a summary
    merged_content = merge_reports(batch_reports)
    merged_summary = parse_report_summary(merged_content)

    # Use aggregated counts if parser returns zeros
    final_critical = merged_summary["critical_count"] or total_critical
    final_warning = merged_summary["warning_count"] or total_warning
    final_attention = merged_summary["attention_count"] or total_attention
    # Always use actual instance count from code, not from LLM-generated text
    final_total = len(instances)

    saved_id = save_report(
        report_id=report_id,
        report_date=monitoring_date,
        report_type="summary",
        account_id=None,
        region=None,
        total_instances=final_total,
        critical_count=final_critical,
        warning_count=final_warning,
        attention_count=final_attention,
        report_content=merged_content,
        model_id=model_id,
        status="completed",
    )

    return {
        "status": "completed",
        "report_id": saved_id,
        "total_instances": final_total,
        "critical_count": final_critical,
        "warning_count": final_warning,
        "attention_count": final_attention,
        "batches": len(batches),
    }


def _handle_elasticache(event: dict) -> dict:
    """ElastiCache 巡检完整流程。

    与 RDS 巡检流程完全对称，仅数据源和存储目标不同。
    """
    report_id = event.get("report_id") if event else None
    trigger_source = "manual" if report_id else "eventbridge"
    logger.info(
        "ElastiCache health check started: trigger=%s, report_id=%s",
        trigger_source, report_id,
    )

    # Default date so the except-block status write can locate the DDB item
    # even if the failure happens before step 2 computes monitoring_date.
    monitoring_date = date.today()

    try:
        # 1. Load ElastiCache config
        config = load_ec_config()
        agent_prompt = config["agent_prompt"]
        model_id = config["bedrock_model_id"]
        if not model_id:
            raise ValueError("bedrock_model_id is not configured for ElastiCache")

        # 2. Determine monitoring date
        raw_date = event.get("monitoring_date") if event else None
        if raw_date:
            if isinstance(raw_date, str):
                monitoring_date = datetime.strptime(raw_date, "%Y-%m-%d").date()
            else:
                monitoring_date = raw_date
        else:
            monitoring_date = date.today()
        logger.info("ElastiCache monitoring date: %s", monitoring_date)

        # 3. Load monitoring data (auto-fallback to latest available date)
        instances, actual_date = load_ec_monitoring_data(monitoring_date)
        if not instances:
            msg = f"No ElastiCache monitoring data found for {monitoring_date}"
            logger.warning(msg)
            if report_id:
                update_ec_report_status(report_id, "failed", msg, report_date=monitoring_date)
            return {"status": "failed", "message": msg}
        if actual_date != monitoring_date:
            logger.info(
                "ElastiCache using fallback date %s instead of %s",
                actual_date, monitoring_date,
            )
            monitoring_date = actual_date

        # 4. Load and apply whitelist
        whitelist = load_ec_health_check_whitelist()
        instances = filter_whitelist(instances, whitelist)
        if not instances:
            msg = "所有 ElastiCache 实例均已加入巡检白名单，本次巡检已跳过。如需生成报告，请先从白名单中移除部分实例。"
            logger.info(
                "All ElastiCache instances filtered by whitelist for %s, skipping",
                monitoring_date,
            )
            skip_content = (
                f"# ElastiCache 巡检报告 — {monitoring_date}\n\n"
                f"**状态：已跳过**\n\n"
                f"所有 ElastiCache 实例均在巡检白名单中，无需巡检的实例。\n\n"
                f"如需生成报告，请前往「ElastiCache 巡检设置 → 巡检白名单」移除部分实例后重新触发。"
            )
            if report_id:
                save_ec_report(
                    report_id=report_id,
                    report_date=monitoring_date,
                    report_type="summary",
                    account_id=None,
                    region=None,
                    total_instances=0,
                    critical_count=0,
                    warning_count=0,
                    attention_count=0,
                    report_content=skip_content,
                    model_id=model_id,
                    status="skipped",
                )
            return {"status": "skipped", "message": msg}

        # 5. Load idle status and exclude idle instances
        idle_status = load_ec_idle_status(monitoring_date)
        before_count = len(instances)
        instances = [
            i for i in instances
            if not idle_status.get((i["instance"], i["account"]), False)
        ]
        if before_count != len(instances):
            logger.info(
                "Excluded %d idle ElastiCache instances, %d remaining",
                before_count - len(instances), len(instances),
            )

        # 6. Build payload and check token count
        now_str = datetime.now().strftime("%Y年%m月%d日 %H:%M")
        num_accounts = len({i["account"] for i in instances})
        num_regions = len({i["region"] for i in instances})
        payload_header = (
            f"分析时间: {now_str}\n监控数据日期: {monitoring_date}\n"
            f"【准确统计（请直接引用，不要自行计算）】总实例数: {len(instances)}, "
            f"账户数: {num_accounts}, 区域数: {num_regions}\n\n"
        )
        payload = payload_header + format_ec_metrics_payload(instances, idle_status)
        tokens = estimate_token_count(payload)
        logger.info(
            "ElastiCache payload token estimate: %d (max=%d)", tokens, MAX_PAYLOAD_TOKENS,
        )

        total_instances = len(instances)
        bedrock_start = time.time()

        if tokens > MAX_PAYLOAD_TOKENS:
            # --- Batch mode: split by account ---
            result = _handle_ec_batch_mode(
                instances, idle_status, model_id, agent_prompt,
                monitoring_date, report_id,
            )
        else:
            # --- Single call mode ---
            result = _handle_ec_single_mode(
                payload, model_id, agent_prompt,
                monitoring_date, report_id, total_instances,
            )

        bedrock_duration = time.time() - bedrock_start

        logger.info(
            "ElastiCache health check completed: trigger=%s, instances=%d, "
            "bedrock_time=%.1fs, status=%s",
            trigger_source, total_instances, bedrock_duration, result.get("status"),
        )
        return result

    except Exception as e:
        logger.error("ElastiCache health check failed: %s", str(e), exc_info=True)
        if report_id:
            try:
                update_ec_report_status(report_id, "failed", str(e), report_date=monitoring_date)
            except Exception:
                logger.error(
                    "Failed to update ElastiCache report status", exc_info=True,
                )
        return {"status": "failed", "message": str(e)}


def _handle_ec_single_mode(
    payload: str,
    model_id: str,
    agent_prompt: str,
    monitoring_date: date,
    report_id: int | None,
    total_instances: int,
) -> dict:
    """Single Bedrock call for ElastiCache when payload fits within token limit."""
    result = invoke_bedrock(model_id, agent_prompt, payload)
    report_content = result["content"]

    summary = parse_report_summary(report_content)
    summary["total_instances"] = total_instances

    saved_id = save_ec_report(
        report_id=report_id,
        report_date=monitoring_date,
        report_type="summary",
        account_id=None,
        region=None,
        total_instances=total_instances,
        critical_count=summary["critical_count"],
        warning_count=summary["warning_count"],
        attention_count=summary["attention_count"],
        report_content=report_content,
        model_id=model_id,
        status="completed",
    )

    return {
        "status": "completed",
        "report_id": saved_id,
        "total_instances": total_instances,
        "critical_count": summary["critical_count"],
        "warning_count": summary["warning_count"],
        "attention_count": summary["attention_count"],
    }


def _handle_ec_batch_mode(
    instances: list[dict],
    idle_status: dict,
    model_id: str,
    agent_prompt: str,
    monitoring_date: date,
    report_id: int | None,
) -> dict:
    """Batch Bedrock calls for ElastiCache when payload exceeds token limit.

    Splits by account, calls Bedrock per batch, saves per_account reports,
    then merges and saves a summary report.
    """
    batches = split_ec_payload_by_account(instances, idle_status, MAX_PAYLOAD_TOKENS)
    logger.info(
        "ElastiCache batch mode: %d batches for %d instances",
        len(batches), len(instances),
    )

    batch_reports: list[str] = []
    total_critical = 0
    total_warning = 0
    total_attention = 0

    now_str = datetime.now().strftime("%Y年%m月%d日 %H:%M")
    batch_header = f"分析时间: {now_str}\n监控数据日期: {monitoring_date}\n\n"

    for i, batch_payload in enumerate(batches, start=1):
        logger.info("Processing ElastiCache batch %d/%d", i, len(batches))
        result = invoke_bedrock(
            model_id, agent_prompt, batch_header + batch_payload,
        )
        batch_content = result["content"]
        batch_reports.append(batch_content)

        # Parse and save per_account report
        batch_summary = parse_report_summary(batch_content)
        total_critical += batch_summary["critical_count"]
        total_warning += batch_summary["warning_count"]
        total_attention += batch_summary["attention_count"]

        save_ec_report(
            report_id=None,
            report_date=monitoring_date,
            report_type="per_account",
            account_id=f"batch_{i}",
            region=None,
            total_instances=batch_summary["total_instances"],
            critical_count=batch_summary["critical_count"],
            warning_count=batch_summary["warning_count"],
            attention_count=batch_summary["attention_count"],
            report_content=batch_content,
            model_id=model_id,
            status="completed",
        )

    # Merge all batch reports into a summary
    merged_content = merge_reports(
        batch_reports, title="ElastiCache AI 智能巡检综合报告",
    )
    merged_summary = parse_report_summary(merged_content)

    # Use aggregated counts if parser returns zeros
    final_critical = merged_summary["critical_count"] or total_critical
    final_warning = merged_summary["warning_count"] or total_warning
    final_attention = merged_summary["attention_count"] or total_attention
    final_total = len(instances)

    saved_id = save_ec_report(
        report_id=report_id,
        report_date=monitoring_date,
        report_type="summary",
        account_id=None,
        region=None,
        total_instances=final_total,
        critical_count=final_critical,
        warning_count=final_warning,
        attention_count=final_attention,
        report_content=merged_content,
        model_id=model_id,
        status="completed",
    )

    return {
        "status": "completed",
        "report_id": saved_id,
        "total_instances": final_total,
        "critical_count": final_critical,
        "warning_count": final_warning,
        "attention_count": final_attention,
        "batches": len(batches),
    }
