"""Lambda5-CostAnalyzer 主入口。

每日 01:45 UTC 由 EventBridge 触发，遍历所有已启用目标账户，
执行成本异常分析并将结果持久化到数据库。

处理流程（每个账户）：
1. STS AssumeRole 获取临时凭证
2. CE 查询近 30 天按 SERVICE 分组的每日成本
3. 统计计算（日均、标准差、近 3 天均值等）
4. 多因子异常评分 + 置信度分级
5. 异常服务下钻查询
6. UPSERT 到 cost_anomaly_result 和 cost_anomaly_summary 表
7. 立即提交事务（确保 Property 8）

需求: 3.5, 3.6, 5.1, 5.2, 5.3, 6.1, 6.2, 7.1, 7.2
"""

from __future__ import annotations

import logging
import math
import os
import time
from datetime import date, datetime, timedelta, timezone

import boto3
from botocore.exceptions import ClientError

from lambda5_cost_analyzer.ce_client import query_cost_by_service, query_cost_drilldown
from lambda5_cost_analyzer.scoring import (
    classify_confidence,
    compute_anomaly_score,
    compute_projected_7d_extra,
)
from shared.account_scope import filter_allowed
from shared.queries.accounts import list_accounts
from shared.queries.cost_anomaly import upsert_anomaly_result, upsert_anomaly_summary

logger = logging.getLogger("lambda5_cost_analyzer.handler")
logger.setLevel(logging.INFO)

# 异常评分阈值：>= 此值视为需要关注的异常
_ANOMALY_SCORE_THRESHOLD = 40

# 单账户 CE 调用次数超过此值时，处理完后额外等待
_CE_CALL_HEAVY_THRESHOLD = 10
_CE_CALL_HEAVY_WAIT_SEC = 2.0

# 候选池：Top N 服务 + 旁路候选
_TOP_N_SERVICES = 20


# ---------------------------------------------------------------------------
# 数据库操作
# ---------------------------------------------------------------------------


def _load_enabled_accounts() -> list[dict]:
    """从 target_accounts 表读取已启用账户。

    跨账号闸门:若设置了 LOCKED_ACCOUNT_ID(默认部署形态=部署账号),只保留该账号。
    本期"跨账号 disabled",成本分析仅针对部署账号(见 shared/account_scope.py)。
    """
    accounts = list_accounts(enabled_only=True)
    return filter_allowed(accounts, lambda it: it["account_id"])


def _assume_role(role_arn: str, account_id: str) -> boto3.Session | None:
    """STS AssumeRole 获取临时 Session。失败返回 None。"""
    try:
        sts = boto3.client("sts")
        resp = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName="CostAnalyzer",
            DurationSeconds=3600,
        )
        creds = resp["Credentials"]
        return boto3.Session(
            aws_access_key_id=creds["AccessKeyId"],
            aws_secret_access_key=creds["SecretAccessKey"],
            aws_session_token=creds["SessionToken"],
        )
    except ClientError as e:
        logger.error("AssumeRole failed for %s: %s", account_id, e)
        return None


def _upsert_anomaly_results(account_id: str, report_date: date, results: list[dict]) -> None:
    """UPSERT 异常结果到 cost_anomaly_result 表。"""
    for r in results:
        upsert_anomaly_result(
            account_id,
            str(report_date),
            r["service_name"],
            score=int(r["anomaly_score"]),  # for GSI1SK sorting
            anomaly_score=r["anomaly_score"],
            confidence_level=r["confidence_level"],
            anomaly_type=r["anomaly_type"],
            baseline_daily_avg=r["baseline_daily_avg"],
            recent_3d_avg=r["recent_3d_avg"],
            projected_7d_extra_cost=r["projected_7d_extra_cost"],
            top_drivers=r.get("top_drivers", []),
            trend_symbols=r.get("trend_symbols", ""),
            related_services=r.get("related_services", []),
        )


def _upsert_summary(account_id: str, report_date: date, summary: dict) -> None:
    """UPSERT 账户汇总到 cost_anomaly_summary 表。"""
    projected_cost = summary.get("total_projected_7d_extra_cost", 0.0)
    upsert_anomaly_summary(
        account_id,
        str(report_date),
        total_daily_avg=summary.get("total_daily_avg", 0.0),
        recent_3d_daily_avg=summary.get("recent_3d_daily_avg", 0.0),
        total_anomalies_detected=summary.get("total_anomalies_detected", 0),
        projected=int(projected_cost),  # for GSI1SK sorting
        total_projected_7d_extra_cost=projected_cost,
        status=summary.get("status", "normal"),
        error_message=summary.get("error_message"),
    )


def _write_error_summary(account_id: str, report_date: date, error_message: str) -> None:
    """单账户失败时写入 error summary。"""
    try:
        _upsert_summary(account_id, report_date, {
            "status": "error",
            "error_message": error_message,
        })
    except Exception as e:
        logger.error("Failed to write error summary for %s: %s", account_id, e)


def _persist_account_results(
    account_id: str,
    report_date: date,
    anomaly_results: list[dict],
    summary: dict,
) -> None:
    """持久化单个账户的结果（DDB 自动持久化，无需显式提交）。"""
    _upsert_anomaly_results(account_id, report_date, anomaly_results)
    _upsert_summary(account_id, report_date, summary)
    logger.info(
        "Persisted results for account %s: %d anomalies",
        account_id, len(anomaly_results),
    )


# ---------------------------------------------------------------------------
# 统计计算
# ---------------------------------------------------------------------------


def _parse_ce_results(results_by_time: list[dict]) -> dict[str, list[tuple[str, float]]]:
    """将 CE ResultsByTime 解析为 {service_name: [(date_str, amount), ...]} 映射。"""
    service_data: dict[str, list[tuple[str, float]]] = {}
    for entry in results_by_time:
        date_str = entry.get("TimePeriod", {}).get("Start", "")
        for group in entry.get("Groups", []):
            keys = group.get("Keys", [])
            if not keys:
                continue
            service_name = keys[0]
            amount_str = (
                group.get("Metrics", {})
                .get("AmortizedCost", {})
                .get("Amount", "0")
            )
            try:
                amount = float(amount_str)
            except (ValueError, TypeError):
                amount = 0.0
            service_data.setdefault(service_name, []).append((date_str, amount))
    return service_data


def _compute_service_stats(daily_costs: list[tuple[str, float]]) -> dict:
    """从每日成本序列计算统计指标。

    Returns:
        dict with keys: baseline_daily_avg, recent_3d_avg, std_dev,
                        consecutive_days_above, daily_changes, total_30d
    """
    # 按日期排序
    sorted_costs = sorted(daily_costs, key=lambda x: x[0])
    amounts = [c[1] for c in sorted_costs]

    if not amounts:
        return {
            "baseline_daily_avg": 0.0,
            "recent_3d_avg": 0.0,
            "std_dev": 0.0,
            "consecutive_days_above": 0,
            "daily_changes": [],
            "total_30d": 0.0,
        }

    n = len(amounts)
    baseline_avg = sum(amounts) / n if n > 0 else 0.0
    recent_3d = amounts[-3:] if n >= 3 else amounts
    recent_3d_avg = sum(recent_3d) / len(recent_3d) if recent_3d else 0.0

    # 标准差
    if n > 1:
        variance = sum((x - baseline_avg) ** 2 for x in amounts) / n
        std_dev = math.sqrt(variance)
    else:
        std_dev = 0.0

    # 连续超阈值天数（从最近一天往回数）
    threshold = baseline_avg + std_dev if std_dev > 0 else baseline_avg * 1.1
    consecutive_days = 0
    for amount in reversed(amounts):
        if amount > threshold:
            consecutive_days += 1
        else:
            break

    # 日环比变化（近 3 天）
    daily_changes: list[float] = []
    if n >= 2:
        recent_window = amounts[-(min(4, n)):]
        for i in range(1, len(recent_window)):
            prev = recent_window[i - 1]
            if prev > 0:
                daily_changes.append((recent_window[i] - prev) / prev)
            else:
                daily_changes.append(0.0)

    return {
        "baseline_daily_avg": baseline_avg,
        "recent_3d_avg": recent_3d_avg,
        "std_dev": std_dev,
        "consecutive_days_above": consecutive_days,
        "daily_changes": daily_changes,
        "total_30d": sum(amounts),
    }


def _classify_anomaly_type(score: float) -> str:
    """根据评分分类异常类型。"""
    if score >= 80:
        return "high_priority"
    elif score >= 60:
        return "medium_priority"
    elif score >= 40:
        return "observation"
    else:
        return "observation"


def _build_trend_symbols(daily_costs: list[tuple[str, float]]) -> str:
    """构建 7 天趋势符号序列。"""
    sorted_costs = sorted(daily_costs, key=lambda x: x[0])
    amounts = [c[1] for c in sorted_costs]
    recent_7 = amounts[-7:] if len(amounts) >= 7 else amounts

    if len(recent_7) < 2:
        return "─"

    symbols = []
    for i in range(1, len(recent_7)):
        prev, curr = recent_7[i - 1], recent_7[i]
        if prev == 0:
            symbols.append("↑" if curr > 0 else "─")
        else:
            change_pct = (curr - prev) / prev
            if change_pct > 0.1:
                symbols.append("↑")
            elif change_pct < -0.1:
                symbols.append("↓")
            else:
                symbols.append("─")
    return "".join(symbols)


def _get_top_drivers(drilldown_results: list[dict]) -> list[dict]:
    """从下钻结果中提取 top drivers。"""
    usage_totals: dict[str, float] = {}
    for entry in drilldown_results:
        for group in entry.get("Groups", []):
            keys = group.get("Keys", [])
            if not keys:
                continue
            usage_type = keys[0]
            amount_str = (
                group.get("Metrics", {})
                .get("AmortizedCost", {})
                .get("Amount", "0")
            )
            try:
                amount = float(amount_str)
            except (ValueError, TypeError):
                amount = 0.0
            usage_totals[usage_type] = usage_totals.get(usage_type, 0.0) + amount

    total = sum(usage_totals.values())
    if total <= 0:
        return []

    # 按金额降序排列，取 top 5
    sorted_items = sorted(usage_totals.items(), key=lambda x: x[1], reverse=True)[:5]
    n_days = len(drilldown_results) if drilldown_results else 1

    return [
        {
            "dimension": "USAGE_TYPE",
            "value": usage_type,
            "daily_avg": round(amount / n_days, 2),
            "contribution_pct": round((amount / total) * 100, 1),
        }
        for usage_type, amount in sorted_items
    ]


# ---------------------------------------------------------------------------
# 单账户处理
# ---------------------------------------------------------------------------


def _process_account(
    session: boto3.Session,
    account_id: str,
    report_date: date,
) -> tuple[list[dict], dict, int]:
    """处理单个账户的成本异常分析。

    Returns:
        (anomaly_results, summary_dict, ce_call_count)
    """
    today = report_date
    start_date = (today - timedelta(days=30)).isoformat()
    end_date = today.isoformat()

    ce_call_count = 0

    # 一级查询：按 SERVICE 分组
    logger.info("Querying cost by service for account %s", account_id)
    results_by_time = query_cost_by_service(session, start_date, end_date)
    ce_call_count += 1

    # 解析 CE 结果
    service_data = _parse_ce_results(results_by_time)

    if not service_data:
        logger.info("No cost data for account %s", account_id)
        return [], {
            "total_daily_avg": 0.0,
            "recent_3d_daily_avg": 0.0,
            "total_anomalies_detected": 0,
            "total_projected_7d_extra_cost": 0.0,
            "status": "normal",
        }, ce_call_count

    # 计算账户级别统计
    all_daily_totals: dict[str, float] = {}
    for svc, costs in service_data.items():
        for date_str, amount in costs:
            all_daily_totals[date_str] = all_daily_totals.get(date_str, 0.0) + amount

    daily_total_amounts = sorted(all_daily_totals.items())
    total_amounts = [a for _, a in daily_total_amounts]
    account_daily_avg = sum(total_amounts) / len(total_amounts) if total_amounts else 0.0

    recent_3d_totals = total_amounts[-3:] if len(total_amounts) >= 3 else total_amounts
    account_recent_3d_avg = sum(recent_3d_totals) / len(recent_3d_totals) if recent_3d_totals else 0.0

    # 计算每个服务的统计指标和评分
    service_scores: list[tuple[str, float, dict]] = []
    for svc_name, daily_costs in service_data.items():
        stats = _compute_service_stats(daily_costs)
        score = compute_anomaly_score(stats, account_daily_avg)
        service_scores.append((svc_name, score, stats))

    # 候选池筛选：Top N + 旁路候选（score >= threshold）
    service_scores.sort(key=lambda x: x[1], reverse=True)
    top_n = service_scores[:_TOP_N_SERVICES]
    top_n_names = {s[0] for s in top_n}
    bypass = [s for s in service_scores[_TOP_N_SERVICES:] if s[1] >= _ANOMALY_SCORE_THRESHOLD]
    candidates = top_n + bypass

    # 对候选服务执行下钻查询和最终评分
    anomaly_results: list[dict] = []
    for svc_name, score, stats in candidates:
        if score < _ANOMALY_SCORE_THRESHOLD:
            continue

        # 下钻查询
        try:
            logger.info("Drilldown for %s in account %s", svc_name, account_id)
            drilldown = query_cost_drilldown(session, start_date, end_date, svc_name)
            ce_call_count += 1
        except ClientError as e:
            logger.warning("Drilldown failed for %s: %s", svc_name, e)
            drilldown = []

        top_drivers = _get_top_drivers(drilldown)
        driver_contribution = top_drivers[0]["contribution_pct"] if top_drivers else 0.0

        # 置信度分级
        sigma_multiple = 0.0
        if stats["std_dev"] > 0:
            sigma_multiple = (stats["recent_3d_avg"] - stats["baseline_daily_avg"]) / stats["std_dev"]

        impact_pct = 0.0
        if account_daily_avg > 0:
            delta = stats["recent_3d_avg"] - stats["baseline_daily_avg"]
            if delta > 0:
                impact_pct = (delta / account_daily_avg) * 100.0

        confidence = classify_confidence(
            {"sigma_multiple": sigma_multiple, "impact_pct": impact_pct},
            driver_contribution,
        )

        anomaly_type = _classify_anomaly_type(score)
        projected_extra = compute_projected_7d_extra(stats["recent_3d_avg"], stats["baseline_daily_avg"])
        trend = _build_trend_symbols(service_data[svc_name])

        anomaly_results.append({
            "service_name": svc_name,
            "anomaly_score": round(score, 2),
            "confidence_level": confidence,
            "anomaly_type": anomaly_type,
            "baseline_daily_avg": round(stats["baseline_daily_avg"], 4),
            "recent_3d_avg": round(stats["recent_3d_avg"], 4),
            "projected_7d_extra_cost": round(projected_extra, 2),
            "top_drivers": top_drivers,
            "trend_symbols": trend,
            "related_services": [],
        })

    # 构建 summary
    total_projected = sum(r["projected_7d_extra_cost"] for r in anomaly_results)
    status = "anomaly_detected" if anomaly_results else "normal"

    summary = {
        "total_daily_avg": round(account_daily_avg, 4),
        "recent_3d_daily_avg": round(account_recent_3d_avg, 4),
        "total_anomalies_detected": len(anomaly_results),
        "total_projected_7d_extra_cost": round(total_projected, 2),
        "status": status,
    }

    return anomaly_results, summary, ce_call_count


# ---------------------------------------------------------------------------
# Lambda 入口
# ---------------------------------------------------------------------------


def handler(event: dict, context) -> dict:
    """Lambda5-CostAnalyzer 主入口。

    1. 从 target_accounts 表读取所有已启用账户
    2. 按顺序遍历每个账户：STS AssumeRole → CE 查询 → 统计计算 → 评分 → 持久化
    3. 每个账户处理完成后立即提交事务（Property 8）
    4. 单账户超 10 次 CE 调用时，额外等待 2 秒（Property 11）
    5. 单账户失败时写入 error summary，继续下一个账户
    """
    report_date = date.today()
    logger.info("Lambda5 CostAnalyzer started, report_date=%s", report_date)

    accounts = _load_enabled_accounts()
    logger.info("Loaded %d enabled accounts", len(accounts))

    accounts_processed = 0
    accounts_failed = 0
    total_anomalies = 0

    for i, account in enumerate(accounts):
        account_id = account["account_id"]
        role_arn = account.get("role_arn", "")

        try:
            # STS AssumeRole — 部署账号(role_arn 为空)用 Lambda 自身角色
            if role_arn:
                session = _assume_role(role_arn, account_id)
                if session is None:
                    raise RuntimeError(f"AssumeRole failed for {account_id}")
            else:
                session = boto3.Session(
                    region_name=os.environ.get("AWS_REGION", "us-east-1")
                )

            # 处理账户
            anomaly_results, summary, ce_call_count = _process_account(
                session, account_id, report_date,
            )

            # 持久化并立即提交（Property 8）
            _persist_account_results(account_id, report_date, anomaly_results, summary)

            accounts_processed += 1
            total_anomalies += len(anomaly_results)

            logger.info(
                "Account %s done: %d anomalies, %d CE calls",
                account_id, len(anomaly_results), ce_call_count,
            )

            # Property 11: 重负载账户额外等待
            if ce_call_count > _CE_CALL_HEAVY_THRESHOLD and i < len(accounts) - 1:
                logger.info(
                    "Account %s had %d CE calls (> %d), waiting %.1fs before next account",
                    account_id, ce_call_count, _CE_CALL_HEAVY_THRESHOLD, _CE_CALL_HEAVY_WAIT_SEC,
                )
                time.sleep(_CE_CALL_HEAVY_WAIT_SEC)  # nosemgrep: arbitrary-sleep — Cost Explorer rate-limit throttle between heavy accounts

        except Exception as e:
            logger.error(
                "Failed to process account %s: %s", account_id, e, exc_info=True,
            )
            accounts_failed += 1
            _write_error_summary(account_id, report_date, str(e))

    result = {
        "status": "completed",
        "report_date": report_date.isoformat(),
        "accounts_total": len(accounts),
        "accounts_processed": accounts_processed,
        "accounts_failed": accounts_failed,
        "total_anomalies": total_anomalies,
    }
    logger.info("Lambda5 CostAnalyzer completed: %s", result)
    return result
