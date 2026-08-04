"""
Lambda4-Notifier — 定时推送巡检报告和闲置资源通知到飞书。

触发方式：EventBridge 定时规则（每天 02:00 UTC，各上游 Lambda 巡检完成后）

新架构职责（见 spec: devops-agent-per-account-architecture）：
  1. 查询当天 RDS / ElastiCache 巡检报告摘要（按账号展示）
  2. 查询当天闲置资源 Top 5（按账号展示）
  3. 查询当天成本异常（按账号展示，**不触发调查** — R11.1）
  4. 对 RDS / EC 巡检 critical 资源用 Health_Report_Parser 拆分到账号级，
     按账号独立触发 DevOps Agent 健康告警调查（R11.2 / R11.3）。单账号失败
     不中断其他账号（R11.8）。未上车账号跳过（R11.4）。
  5. 成功触发后预注册 `devops_agent_investigation` 记录（status=pending），
     等 Callback Lambda 收到事件后 UPSERT 为最终状态（R18.1）
  6. 查询过去 24h 的调查记录，作为"昨日调查汇总"附加到推送末尾（R11.5 / R11.6）
  7. 通过飞书 IM 适配器推送

环境变量：
  - CONFIG_TABLE：DynamoDB 配置表名
  - FEISHU_SECRET_ARN：IM 凭证
  - BEDROCK_API_KEY_SECRET_ARN（可选）：Bedrock Bearer Token 认证

Requirements: R11.1, R11.2, R11.3, R11.4, R11.5, R11.6, R11.7, R11.8,
              R11.9, R18.1, R14.1, R14.2
"""

import json
import logging
import os
from datetime import date, datetime, timedelta, timezone

from shared.devops_agent import create_investigation
from shared.queries._client import config_table as _config_table
from shared.queries.cost_anomaly import (
    list_anomaly_results_by_date,
    list_anomaly_summaries_by_date,
)
from shared.queries.reports import (
    get_health_report,
    list_health_reports,
    list_investigations,
    upsert_investigation,
)
from shared.queries.waste_report import get_report_summary, query_idle_topN

from lambda4_notifier.health_report_parser import parse_critical_by_account

logger = logging.getLogger("lambda4_notifier")
logger.setLevel(logging.INFO)

# Secrets cache (with TTL)
_SECRET_CACHE_TTL = 300  # 5 分钟
_secrets_cache: dict[str, tuple[dict, float]] = {}


def _load_secret(secret_arn: str) -> dict:
    import time
    if secret_arn in _secrets_cache:
        cached, ts = _secrets_cache[secret_arn]
        if time.time() - ts < _SECRET_CACHE_TTL:
            return cached
    if not secret_arn:
        return {}
    try:
        import boto3
        client = boto3.client("secretsmanager")
        resp = client.get_secret_value(SecretId=secret_arn)
        secret = json.loads(resp["SecretString"])
        _secrets_cache[secret_arn] = (secret, time.time())
        return secret
    except Exception as e:
        logger.error("加载 Secret 失败 (%s): %s", secret_arn, e)
        return {}


# ---------------------------------------------------------------------------
# 查询：巡检报告摘要（按账号展示用）
# ---------------------------------------------------------------------------


def _query_latest_health_reports(report_date: date) -> list[dict]:
    """查询指定日期的 RDS 巡检报告摘要（per_account + summary 都要）。"""
    try:
        date_str = report_date.strftime("%Y-%m-%d")
        items, _ = list_health_reports("rds", date_str, status="completed", limit=20)
        # Normalize DDB field names to match downstream format expectations
        rows = []
        for it in items:
            rows.append({
                "id": it.get("id"),
                "report_date": it.get("date"),
                "report_type": it.get("type"),
                "account_id": it.get("account") if it.get("account") != "$GLOBAL" else None,
                "total_instances": it.get("total_instances", 0),
                "critical_count": it.get("critical_count", 0),
                "warning_count": it.get("warning_count", 0),
                "attention_count": it.get("attention_count", 0),
                "status": it.get("status"),
                "created_at": it.get("created_at"),
            })
        return rows
    except Exception as e:
        logger.error("查询 RDS 巡检报告失败: %s", e)
        return []


def _query_latest_ec_health_reports(report_date: date) -> list[dict]:
    """查询指定日期的 ElastiCache 巡检报告摘要。"""
    try:
        date_str = report_date.strftime("%Y-%m-%d")
        items, _ = list_health_reports("elasticache", date_str, status="completed", limit=20)
        rows = []
        for it in items:
            rows.append({
                "id": it.get("id"),
                "report_date": it.get("date"),
                "report_type": it.get("type"),
                "account_id": it.get("account") if it.get("account") != "$GLOBAL" else None,
                "total_instances": it.get("total_instances", 0),
                "critical_count": it.get("critical_count", 0),
                "warning_count": it.get("warning_count", 0),
                "attention_count": it.get("attention_count", 0),
                "status": it.get("status"),
                "created_at": it.get("created_at"),
            })
        return rows
    except Exception as e:
        logger.error("查询 ElastiCache 巡检报告失败: %s", e)
        return []


def _query_summary_report_content(
    table: str, report_date: date
) -> str | None:
    """查询 summary 报告（account_id IS NULL）的 report_content Markdown 全文。

    Health_Report_Parser 用此解析出按账号的 critical 清单。

    Args:
        table: 'rds_health_report' 或 'elasticache_health_report'
              — mapped to rt='rds' or rt='elasticache'
    """
    try:
        # Map old table name to rt key
        rt = "rds" if "rds" in table else "elasticache"
        date_str = report_date.strftime("%Y-%m-%d")
        item = get_health_report(rt, date_str, "summary", account=None)
        if item and item.get("status") == "completed":
            content = item.get("report_content")
            return str(content) if content else None
        return None
    except Exception as e:
        logger.error("查询 %s summary 报告失败: %s", table, e)
        return None


def _query_top_idle_resources(report_date: date, limit: int = 5) -> list[dict]:
    """查询当天高价值闲置资源 Top N。"""
    try:
        date_str = report_date.strftime("%Y-%m-%d")
        items = query_idle_topN(date_str, n=limit)
        # DDB items already contain instance_id, account_id, region, etc.
        # Ensure estimated_monthly_savings is a float for downstream formatting
        rows = []
        for it in items:
            rows.append({
                "instance_id": it.get("instance_id", ""),
                "account_id": it.get("account_id", ""),
                "region": it.get("region", ""),
                "resource_type": it.get("resource_type", ""),
                "instance_class": it.get("instance_class", ""),
                "idle_score": it.get("idle_score"),
                "estimated_monthly_savings": float(it.get("estimated_monthly_savings", 0) or 0),
            })
        return rows
    except Exception as e:
        logger.error("查询闲置资源失败: %s", e)
        return []


def _query_idle_summary(report_date: date) -> dict:
    """查询闲置资源汇总统计。"""
    try:
        date_str = report_date.strftime("%Y-%m-%d")
        item = get_report_summary(date_str)
        if item:
            return {
                "total_idle": int(item.get("idle_total", 0)),
                "total_savings": float(item.get("idle_savings", 0)),
            }
        return {"total_idle": 0, "total_savings": 0.0}
    except Exception as e:
        logger.error("查询闲置汇总失败: %s", e)
        return {"total_idle": 0, "total_savings": 0.0}


# ---------------------------------------------------------------------------
# 查询：成本异常（按账号展示，不触发调查 — R11.1）
# ---------------------------------------------------------------------------


def _query_cost_anomaly_summary(report_date: date) -> list[dict] | None:
    """查询当天所有账户的成本异常汇总（排除 status='error' 的账户）。"""
    try:
        date_str = report_date.strftime("%Y-%m-%d")
        items = list_anomaly_summaries_by_date(date_str, exclude_error=True)
        # Normalize Decimal values to float for downstream formatting
        rows = []
        for it in items:
            rows.append({
                "account_id": it.get("account_id", ""),
                "total_daily_avg": float(it.get("total_daily_avg", 0) or 0),
                "recent_3d_daily_avg": float(it.get("recent_3d_daily_avg", 0) or 0),
                "total_anomalies_detected": int(it.get("total_anomalies_detected", 0) or 0),
                "total_projected_7d_extra_cost": float(it.get("total_projected_7d_extra_cost", 0) or 0),
                "status": it.get("status", ""),
            })
        return rows
    except Exception as e:
        logger.error("查询成本异常汇总失败: %s", e)
        return None


def _query_cost_anomaly_details(report_date: date) -> list[dict] | None:
    """查询当天 anomaly_score >= 60 的异常明细。"""
    try:
        date_str = report_date.strftime("%Y-%m-%d")
        items = list_anomaly_results_by_date(date_str, min_score=60)
        rows = []
        for it in items:
            rows.append({
                "account_id": it.get("account_id", ""),
                "service_name": it.get("service_name", ""),
                "anomaly_score": float(it.get("anomaly_score", 0) or 0),
                "confidence_level": it.get("confidence_level", ""),
                "anomaly_type": it.get("anomaly_type", ""),
                "baseline_daily_avg": float(it.get("baseline_daily_avg", 0) or 0),
                "recent_3d_avg": float(it.get("recent_3d_avg", 0) or 0),
                "projected_7d_extra_cost": float(it.get("projected_7d_extra_cost", 0) or 0),
                "trend_symbols": it.get("trend_symbols", ""),
            })
        return rows
    except Exception as e:
        logger.error("查询成本异常明细失败: %s", e)
        return None


# ---------------------------------------------------------------------------
# 账号别名 + 过去 24h 调查查询（R14.1 / R14.2 / R11.5 / R11.6）
# ---------------------------------------------------------------------------


def _query_account_alias(account_id: str) -> str | None:
    """从 DevOps Agent 账户配置(da#)查 account_alias。"""
    try:
        table = _config_table()
        resp = table.get_item(Key={"PK": f"da#{account_id}", "SK": "meta"})
        item = resp.get("Item")
        if item:
            alias = item.get("account_alias")
            return alias if alias else None
        return None
    except Exception as e:
        logger.error("查询 account_alias 失败: account=%s error=%s", account_id, e)
        return None


def _query_recent_investigations(hours: int = 24) -> list[dict]:
    """查询过去 hours 小时内状态为 completed/failed/timed_out 的调查记录。"""
    try:
        since_dt = datetime.now(timezone.utc) - timedelta(hours=hours)
        since_iso = since_dt.isoformat(timespec="microseconds").replace("+00:00", "Z")
        items, _ = list_investigations(
            since=since_iso,
            statuses=("completed", "failed", "timed_out"),
            limit=50,
        )
        return items
    except Exception as e:
        logger.error("查询过去 %sh 调查记录失败: %s", hours, e)
        return []


def _preregister_investigation(
    task_id: str,
    execution_id: str,
    account_id: str,
    account_alias: str | None,
    title: str,
    source: str,
) -> None:
    """create_investigation 成功后预注册 pending 记录到 DDB.

    upsert_investigation uses if_not_exists semantics on task_id/created_at,
    so a retry or late callback won't overwrite the initial write (analogous
    to the old ON CONFLICT DO NOTHING).

    Requirements: R18.1
    """
    try:
        fields: dict = {
            "status": "pending",
            "title": title,
            "source": source,
        }
        if execution_id:
            fields["execution_id"] = execution_id
        if account_alias:
            fields["account_alias"] = account_alias

        upsert_investigation(task_id, account_id=account_id, **fields)
        logger.info(
            "预注册 pending 记录成功: task_id=%s account=%s", task_id, account_id
        )
    except Exception as e:
        logger.error(
            "预注册 pending 记录失败（不中断）: task_id=%s error=%s", task_id, e
        )


# ---------------------------------------------------------------------------
# 格式化：成本异常 / 巡检报告 / 闲置资源 / 调查汇总
# ---------------------------------------------------------------------------


def _format_cost_anomaly_section(
    summaries: list[dict] | None, details: list[dict] | None
) -> str:
    """按账号展示成本异常（R11.1：不触发调查）。"""
    if summaries is None:
        return "⚠️ 成本异常检测数据暂不可用"

    total_anomalies = sum(s.get("total_anomalies_detected", 0) for s in summaries)
    if total_anomalies == 0:
        return "✅ 成本异常：全部账号过去 24h 无成本异常"

    total_projected = sum(
        s.get("total_projected_7d_extra_cost", 0) or 0 for s in summaries
    )

    lines: list[str] = []
    lines.append("**🔥 成本异常检测**\n")
    lines.append(f"- 异常总数: **{total_anomalies}** 个")
    lines.append(f"- 预计 7 天额外成本: **${total_projected:,.2f}**\n")

    if details:
        lines.append("**异常明细（按账号）：**\n")
        for d in details:
            account = d.get("account_id", "")
            service = d.get("service_name", "")
            score = d.get("anomaly_score", 0)
            confidence = d.get("confidence_level", "")
            anomaly_type = d.get("anomaly_type", "")
            baseline = d.get("baseline_daily_avg", 0) or 0
            recent = d.get("recent_3d_avg", 0) or 0
            projected = d.get("projected_7d_extra_cost", 0) or 0
            trend = d.get("trend_symbols", "")

            type_label = {
                "high_priority": "🔴 高优先",
                "medium_priority": "🟡 中优先",
                "new_cost": "🆕 新增成本",
                "observation": "🔵 观察",
            }.get(anomaly_type, anomaly_type)

            lines.append(
                f"- [{account}] **{service}** | 评分 {score:.0f} | {confidence} | {type_label}"
                f" | 基线 ${baseline:,.2f}/天 → 近3天 ${recent:,.2f}/天"
                f" | 预计7天额外 ${projected:,.2f} {trend}"
            )
        lines.append("")

    return "\n".join(lines)


def _format_recent_investigations_section(records: list[dict]) -> str:
    """格式化"昨日调查汇总"（R11.5, R11.6, R14.2）。

    空列表返回空字符串（调用方 skip）。
    """
    if not records:
        return ""

    status_icons = {
        "completed": "✅",
        "failed": "❌",
        "timed_out": "⏰",
    }

    lines: list[str] = []
    lines.append("**📋 昨日调查汇总（过去 24h）**\n")

    for r in records:
        account_id = r.get("account_id", "")
        alias = r.get("account_alias") or ""
        label = alias if alias else f"账号 {account_id}"
        title = r.get("title") or "DevOps Agent 调查"
        task_id = r.get("task_id", "")
        status = r.get("status", "")
        icon = status_icons.get(status, "•")

        created_at = r.get("created_at")
        if isinstance(created_at, datetime):
            time_str = created_at.strftime("%Y-%m-%d %H:%M UTC")
        else:
            time_str = str(created_at or "")

        lines.append(
            f"- [{label}] {title} — {time_str} (task_id: `{task_id}`) {icon}"
        )

    lines.append("")
    lines.append(
        "查看详情请访问 Dashboard 调查历史，或 @机器人 '发送 <task_id> 报告'"
    )
    return "\n".join(lines)


def _format_notification(
    report_date: date,
    health_reports: list[dict],
    idle_summary: dict,
    top_idle: list[dict],
    cost_anomaly_section: str = "",
    ec_health_reports: list[dict] | None = None,
) -> str:
    """格式化主通知消息为 Markdown。"""
    ec_health_reports = ec_health_reports or []
    lines: list[str] = []
    date_str = report_date.strftime("%Y-%m-%d")

    lines.append(f"📋 **{date_str} 每日巡检通知**\n")

    # RDS 巡检报告（按账号标签展示 R14.1）
    if health_reports:
        lines.append("**🔍 RDS 巡检报告**\n")
        for r in health_reports:
            rtype = r.get("report_type", "summary")
            total = r.get("total_instances", 0)
            critical = r.get("critical_count", 0)
            warning = r.get("warning_count", 0)
            attention = r.get("attention_count", 0)
            if rtype == "per_account":
                label = f"[{r.get('account_id') or 'unknown'}]"
            else:
                label = "[汇总]"
            lines.append(
                f"- {label} 共 {total} 实例 | "
                f"🔴 严重 {critical} | 🟡 警告 {warning} | 🔵 关注 {attention}"
            )
        lines.append("")
    else:
        lines.append("**🔍 RDS 巡检报告**：今日无新报告\n")

    # ElastiCache 巡检报告
    if ec_health_reports:
        lines.append("**🔍 ElastiCache 巡检报告**\n")
        for r in ec_health_reports:
            rtype = r.get("report_type", "summary")
            total = r.get("total_instances", 0)
            critical = r.get("critical_count", 0)
            warning = r.get("warning_count", 0)
            attention = r.get("attention_count", 0)
            if rtype == "per_account":
                label = f"[{r.get('account_id') or 'unknown'}]"
            else:
                label = "[汇总]"
            lines.append(
                f"- {label} 共 {total} 实例 | "
                f"🔴 严重 {critical} | 🟡 警告 {warning} | 🔵 关注 {attention}"
            )
        lines.append("")
    else:
        lines.append("**🔍 ElastiCache 巡检报告**：今日无新报告\n")

    # 闲置资源汇总
    total_idle = idle_summary.get("total_idle", 0)
    total_savings = idle_summary.get("total_savings", 0.0)

    if total_idle > 0:
        lines.append("**💰 闲置资源概览**\n")
        lines.append(f"- 闲置资源总数: **{total_idle}** 个")
        lines.append(f"- 预估月度节省: **${total_savings:,.2f}**\n")

        if top_idle:
            lines.append("**Top 5 高价值闲置资源：**\n")
            for i, r in enumerate(top_idle, 1):
                savings = r.get("estimated_monthly_savings") or 0
                lines.append(
                    f"{i}. `{r['instance_id']}` ({r.get('resource_type', 'N/A')})"
                    f" | {r.get('account_id', '')} | {r.get('region', '')}"
                    f" | ${savings:,.2f}/月"
                )
            lines.append("")
    else:
        lines.append("**💰 闲置资源**：今日无闲置资源数据\n")

    # 成本异常（按账号展示，不触发调查）
    if cost_anomaly_section:
        lines.append(cost_anomaly_section)
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# IM 推送（飞书）
# ---------------------------------------------------------------------------


def _send_feishu_notifications(chat_ids: list[str], content: str, secret: dict) -> int:
    from shared.feishu_sender import FeishuSender

    sender = FeishuSender(
        app_id=secret.get("app_id", ""),
        app_secret=secret.get("app_secret", ""),
    )

    success = 0
    for chat_id in chat_ids:
        chat_id = chat_id.strip()
        if not chat_id:
            continue
        try:
            ok = sender.send_response(chat_id, content, "markdown")
            if ok:
                success += 1
                logger.info("飞书通知发送成功: chat_id=%s", chat_id)
            else:
                logger.warning("飞书通知发送失败: chat_id=%s", chat_id)
        except Exception as e:
            logger.error("飞书通知异常: chat_id=%s error=%s", chat_id, e)
    return success


# ---------------------------------------------------------------------------
# DevOps Agent 健康告警触发（按账号独立，单账号失败不中断）
# ---------------------------------------------------------------------------


def _trigger_health_investigations_per_account(
    report_date: date,
    critical_by_account: dict[str, list[dict]],
) -> tuple[list[str], list[str]]:
    """按账号独立触发 DevOps Agent 健康告警调查。

    R11.2 / R11.3 / R11.4 / R11.8 / R18.1：
    - 对每个有 critical 资源的账号独立调用 create_investigation(target_account_id=...)
    - 每个账号 try/except 独立，失败不中断其他账号
    - 成功 → 预注册 pending 记录（R18.1）
    - 未上车（create_investigation 返回 success=False 且 error 中含"未上车"）→ 
      记入 "未上车，已跳过" 汇总

    Returns:
        (trigger_info, failure_info): 两个字符串列表，供推送末尾展示
    """
    trigger_info: list[str] = []
    failure_info: list[str] = []

    if not critical_by_account:
        return trigger_info, failure_info

    for account_id, resources in critical_by_account.items():
        account_alias = _query_account_alias(account_id)
        label = account_alias if account_alias else f"账号 {account_id}"

        # 构造描述
        desc_lines = [
            f"账户 {account_id} 检测到 {len(resources)} 个严重（critical）健康问题："
        ]
        for r in resources:
            desc_lines.append(
                f"- [{r.get('resource_type', 'unknown')}] "
                f"`{r.get('resource_id', '')}`: "
                f"{r.get('issue_description', '')}"
            )
        description = "\n".join(desc_lines)

        title = f"健康检查严重告警 - {account_id} ({report_date})"

        try:
            result = create_investigation(
                title=title,
                description=description,
                priority="HIGH",
                source="notiops-health-critical",
                target_account_id=account_id,
                component="lambda4",
            )
        except Exception as e:
            logger.error(
                "create_investigation 异常: account=%s error=%s",
                account_id, e,
            )
            failure_info.append(f"⚠️ [{label}] 调查触发异常：{e}")
            continue

        if result.get("success"):
            task_id = result.get("task_id", "")
            execution_id = result.get("execution_id", "")
            trigger_info.append(
                f"🔍 [{label}] 已触发健康告警调查 (task_id: `{task_id}`)"
            )
            logger.info(
                "健康告警 DevOps Agent 调查已触发: account=%s task_id=%s",
                account_id, task_id,
            )
            # 预注册 pending 记录（R18.1）
            _preregister_investigation(
                task_id=task_id,
                execution_id=execution_id,
                account_id=account_id,
                account_alias=account_alias,
                title=title,
                source="notiops-health-critical",
            )
        else:
            error = result.get("error", "未知错误")
            # 区分"未上车"和其他错误（R11.4 / R11.8）
            if "未上车" in error or "未启用" in error:
                failure_info.append(
                    f"ℹ️ [{label}] 未上车 DevOps Agent，已跳过自动调查"
                )
                logger.info(
                    "账户 %s 未上车，跳过健康告警触发: %s", account_id, error
                )
            else:
                failure_info.append(
                    f"⚠️ [{label}] 调查触发失败：{error}"
                )
                logger.warning(
                    "健康告警 DevOps Agent 触发失败: account=%s error=%s",
                    account_id, error,
                )

    return trigger_info, failure_info


# ---------------------------------------------------------------------------
# Handler 主入口
# ---------------------------------------------------------------------------


def handler(event: dict, context) -> dict:
    """Lambda4-Notifier 主入口。

    EventBridge 触发，查询当天数据并推送通知。
    """
    logger.info("Lambda4-Notifier started")

    # 确定通知日期
    raw_date = event.get("report_date") if event else None
    if raw_date:
        report_date = datetime.strptime(raw_date, "%Y-%m-%d").date()
    else:
        report_date = date.today()

    logger.info("通知日期: %s", report_date)

    # --- 数据查询 ---
    health_reports = _query_latest_health_reports(report_date)
    ec_health_reports = _query_latest_ec_health_reports(report_date)
    idle_summary = _query_idle_summary(report_date)
    top_idle = _query_top_idle_resources(report_date)

    # 成本异常（按账号展示，不触发调查）
    cost_anomaly_section = ""
    try:
        summaries = _query_cost_anomaly_summary(report_date)
        details = _query_cost_anomaly_details(report_date)
        cost_anomaly_section = _format_cost_anomaly_section(summaries, details)
    except Exception as e:
        logger.error("成本异常数据查询失败: %s", e)
        cost_anomaly_section = "⚠️ 成本异常检测数据暂不可用"

    # 最近 24h 调查汇总
    recent_investigations = _query_recent_investigations(hours=24)

    # 判断是否有任何数据（避免空推送）
    has_cost_anomaly_data = (
        cost_anomaly_section
        and cost_anomaly_section != "⚠️ 成本异常检测数据暂不可用"
        and cost_anomaly_section != "✅ 成本异常：全部账号过去 24h 无成本异常"
    )
    if (
        not health_reports
        and not ec_health_reports
        and idle_summary.get("total_idle", 0) == 0
        and not has_cost_anomaly_data
        and not recent_investigations
    ):
        logger.info("今日无任何数据，跳过通知")
        return {"status": "skipped", "reason": "no_data"}

    # --- DevOps Agent 健康告警触发（按账号独立）---
    trigger_info: list[str] = []
    failure_info: list[str] = []
    try:
        rds_md = _query_summary_report_content("rds_health_report", report_date)
        ec_md = _query_summary_report_content(
            "elasticache_health_report", report_date
        )
        critical_by_account = parse_critical_by_account(rds_md, ec_md)
        if critical_by_account:
            logger.info(
                "Health_Report_Parser 得到 %d 个账号的 critical 清单",
                len(critical_by_account),
            )
            trigger_info, failure_info = (
                _trigger_health_investigations_per_account(
                    report_date, critical_by_account
                )
            )
        else:
            logger.info("无 critical 健康告警，跳过触发")
    except Exception as e:
        logger.error("健康告警触发整体失败: %s", e)
        failure_info.append(f"⚠️ 健康告警触发整体失败：{e}")

    # --- 格式化消息 ---
    content = _format_notification(
        report_date, health_reports, idle_summary, top_idle,
        cost_anomaly_section, ec_health_reports=ec_health_reports,
    )

    # 附加 DevOps Agent 自动触发信息
    if trigger_info or failure_info:
        content += "\n**🤖 DevOps Agent 自动调查**\n"
        for line in trigger_info:
            content += f"- {line}\n"
        for line in failure_info:
            content += f"- {line}\n"

    # 附加"昨日调查汇总"（R11.5, R11.6）
    recent_section = _format_recent_investigations_section(recent_investigations)
    if recent_section:
        content += "\n" + recent_section + "\n"

    content += "\n---\n💡 回复消息可直接与 AI 助手对话，查看详细报告或执行操作。"

    logger.info("通知内容已生成，长度=%d", len(content))

    # --- IM 推送 ---
    total_sent = 0

    feishu_secret_arn = os.environ.get("FEISHU_SECRET_ARN", "")
    if feishu_secret_arn:
        feishu_secret = _load_secret(feishu_secret_arn)
        chat_ids_str = feishu_secret.get("notify_chat_ids", "")
        if chat_ids_str:
            chat_ids = [c.strip() for c in chat_ids_str.split(",") if c.strip()]
            if chat_ids:
                sent = _send_feishu_notifications(chat_ids, content, feishu_secret)
                total_sent += sent
                logger.info("飞书通知: %d/%d 成功", sent, len(chat_ids))


    if total_sent == 0:
        logger.warning("未发送任何通知（可能未配置 notify_chat_ids）")

    result = {
        "status": "completed",
        "report_date": str(report_date),
        "health_reports": len(health_reports),
        "ec_health_reports": len(ec_health_reports),
        "idle_count": idle_summary.get("total_idle", 0),
        "devops_triggered": len(trigger_info),
        "devops_failed": len(failure_info),
        "recent_investigations": len(recent_investigations),
        "notifications_sent": total_sent,
    }
    logger.info("Lambda4-Notifier 完成: %s", result)
    return result
