"""
Lambda4-Notifier — 每日运维通知（飞书）。

触发方式：EventBridge 定时规则（每天 02:00 UTC）。

## 2026-09-04 改造：数据源全部换到新系统

老 idle-detector（lambda1/2/3 的 RDS/EC 健康报告与闲置分析）已整体退役。
此前本函数的 RDS/EC/闲置三段读的是老报告表，退役后那三段的数字要么是空、
要么与 Web Chat 巡检看板**口径相反**（老闲置=0 而新巡检有 finding）——
一条自相矛盾的每日消息比没有消息更糟。

现职责：
  1. **资源巡检段**：读新巡检系统（`notiops-inspection` 表）——
     每账号每类型今天跑没跑（R9.11：「没跑」与「没风险」必须可区分）、
     当前未关闭 finding 的严重度分布、判读回来了几条
  2. 成本异常段（lambda5 产数，`notiops-metrics` 表，**不触发调查**，R11.1）
  3. 过去 24h 调查汇总（R11.5 / R11.6 / R14.2）
  4. 通过飞书推送（`notify_chat_ids` 在飞书 Secret 里配置）

## 刻意去掉的：健康告警自动触发 DA 调查

老链路对 RDS/EC 报告里的 critical 每天触发 DevOps Agent 调查 —— 它没有
复用闸门，同 3 条 critical 会**每天重新买一次调查**（2026-09-04 现网实测
连续两天对同账号同问题各触发一次）。新巡检系统的判读派发自带 R5.12 复用
闸门与额度档位，这个功能由它整体接管，不在通知 Lambda 里做第二套。

环境变量：
  - CONFIG_TABLE：DynamoDB 配置表名（调查汇总的账号别名等）
  - INSPECTION_TABLE：新巡检表名（巡检段数据源）
  - WEB_BASE_URL（可选）：Web Chat 地址，用于拼「打开看板」深链
  - FEISHU_SECRET_ARN：IM 凭证（含 notify_chat_ids）

Requirements: R11.1, R11.5, R11.6, R11.7, R11.9, R14.1, R14.2, R9.11
"""

import json
import logging
import os
from datetime import date, datetime, timedelta, timezone

from shared.queries.cost_anomaly import (
    list_anomaly_results_by_date,
    list_anomaly_summaries_by_date,
)
from shared.queries.reports import list_investigations

logger = logging.getLogger("lambda4_notifier")
logger.setLevel(logging.INFO)

# Secrets cache (with TTL)
_SECRET_CACHE_TTL = 300  # 5 分钟
_secrets_cache: dict[str, tuple[dict, float]] = {}

#: 巡检的两类轮次（与 `inspection.domain.schedule.RunType` 的取值一致）。
#: ⚠️ 不 import 那个枚举：本模块只要字符串，import 会把 inspection 的
#:    依赖树拖进来，而这两个值有下面 `_RUN_TYPE_LABEL` 的测试钉着。
_RUN_TYPES = ("high", "idle")
_RUN_TYPE_LABEL = {"high": "高负载", "idle": "闲置"}

#: 严重度展示顺序与图标（与 finding 行的 severity 取值一致）。
_SEV_ICONS = (("CRITICAL", "🔴"), ("HIGH", "🟠"), ("MEDIUM", "🟡"), ("INFO", "🔵"))


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
# 查询：新巡检系统（runs + findings）
# ---------------------------------------------------------------------------


def _inspection_store():
    """新巡检表的 store。返回 None = 表名没配（老部署升级中间态）。"""
    table_name = os.environ.get("INSPECTION_TABLE", "")
    if not table_name:
        return None
    import boto3

    from inspection.adapters.store import InspectionStore

    return InspectionStore(boto3.resource("dynamodb").Table(table_name))


def _query_inspection_daily(report_date: date) -> dict | None:
    """今天的巡检快照：每账号 → 各类型跑没跑 + 未关闭 finding 分布。

    返回 None = 表没配或读失败（调用方渲染成「数据暂不可用」，
    **不能**渲染成「无风险」—— R9.11 的语义在通知里同样成立）。

    形状::

        {"accounts": {
            "<account_id>": {
                "runs": {"high": {"status": ..., "findings": int|None}, ...},
                "open_by_severity": {"CRITICAL": 2, ...},
                "judged": 3,          # 未关闭 finding 里判读已回来的条数
            }, ...},
         "ran_any": bool}
    """
    store = _inspection_store()
    if store is None:
        logger.warning("INSPECTION_TABLE 未配置 —— 巡检段渲染为不可用")
        return None
    try:
        from inspection.domain.push_policy import view_from_item

        accounts: dict[str, dict] = {}

        def _acct(acct: str) -> dict:
            return accounts.setdefault(acct, {
                "runs": {}, "open_by_severity": {}, "judged": 0})

        # ① 今天的 run 行（每类型每账号至多一行）
        ran_any = False
        for rt in _RUN_TYPES:
            for acct, row in store.runs_for(rt, report_date).items():
                stats = row.get("stats") or {}
                findings = stats.get("findings")
                _acct(acct)["runs"][rt] = {
                    "status": str(row.get("status") or ""),
                    "findings": int(findings) if findings is not None else None,
                }
                ran_any = True

        # ② 未关闭 finding 的严重度分布 + 判读回没回。
        #    ⚠️ 只统计**有 run 行或有 finding** 的账号 —— 账号清单从
        #    finding 的分区里来要 Scan 全表，这里复用 da# 行的账号清单
        #    （与派发侧同一来源，enabled_accounts）。
        from shared.queries._client import config_table
        from inspection.adapters.accounts import enabled_accounts

        for acct in enabled_accounts(config_table()):
            rec = _acct(acct)
            for item in store.list_finding_items(acct):
                view = view_from_item(item)
                if not view.is_open:
                    continue
                sev = str(item.get("severity") or "INFO").upper()
                rec["open_by_severity"][sev] = (
                    rec["open_by_severity"].get(sev, 0) + 1)
                # 判读回来了 = 有 verdict（DA 判读）或有确定性结论（闸门）
                if str(item.get("da_verdict") or "").strip() \
                        or str(item.get("conclusion") or "").strip():
                    rec["judged"] += 1

        return {"accounts": accounts, "ran_any": ran_any}
    except Exception as e:
        logger.error("查询巡检快照失败: %s", e)
        return None


def _format_inspection_section(snapshot: dict | None, report_date: date) -> str:
    """巡检段 Markdown。

    🔴 三种形态必须可区分（把任何一种渲染成另一种都是本模块此前犯过的错）：
       ① 数据不可用 → 「暂不可用」（不是「没风险」）
       ② 今天没跑   → 「今日未跑」（不是「没风险」，R9.11）
       ③ 跑了       → 数字，含 0（0 是真实的「本轮未发现」）
    """
    if snapshot is None:
        return "**🔍 资源巡检**：⚠️ 数据暂不可用（查询失败或表未配置）\n"

    accounts = snapshot.get("accounts") or {}
    if not accounts:
        return ("**🔍 资源巡检**：今日两类巡检都未跑，且无接入账号 —— "
                "如果这不符合预期，去看板检查调度与账号接入\n")

    lines: list[str] = ["**🔍 资源巡检**\n"]
    for acct in sorted(accounts):
        rec = accounts[acct]
        run_bits: list[str] = []
        for rt in _RUN_TYPES:
            run = rec["runs"].get(rt)
            if run is None:
                # R9.11：没跑要说「没跑」。写成 0 会与「跑了没发现」混淆。
                run_bits.append(f"{_RUN_TYPE_LABEL[rt]}：今日未跑")
            else:
                n = run.get("findings")
                n_text = "?" if n is None else str(n)
                status = run.get("status") or "?"
                icon = {"completed": "✅", "success": "✅", "partial": "⚠️",
                        "failed": "❌", "running": "⏳"}.get(status, "•")
                run_bits.append(
                    f"{_RUN_TYPE_LABEL[rt]}：{icon} {status}（发现 {n_text}）")
        lines.append(f"- [{acct}] " + " ｜ ".join(run_bits))

        open_by_sev = rec.get("open_by_severity") or {}
        total_open = sum(open_by_sev.values())
        if total_open:
            sev_text = " ".join(
                f"{icon}{open_by_sev[sev]}"
                for sev, icon in _SEV_ICONS if open_by_sev.get(sev))
            lines.append(
                f"  当前未关闭风险 **{total_open}**：{sev_text}"
                f" ｜ 判读已回 {rec.get('judged', 0)}")
    lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 查询：成本异常（lambda5 产数；按账号展示，不触发调查 — R11.1）
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
# 查询：过去 24h 调查（R11.5 / R11.6 / R14.2）
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# 格式化：成本异常 / 调查汇总
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
# Handler 主入口
# ---------------------------------------------------------------------------


def handler(event: dict, context) -> dict:
    """Lambda4-Notifier 主入口。EventBridge 触发，汇总当日数据并推送。"""
    logger.info("Lambda4-Notifier started")

    raw_date = event.get("report_date") if event else None
    if raw_date:
        report_date = datetime.strptime(raw_date, "%Y-%m-%d").date()
    else:
        report_date = date.today()
    logger.info("通知日期: %s", report_date)

    # --- 数据查询 ---
    snapshot = _query_inspection_daily(report_date)

    cost_anomaly_section = ""
    try:
        summaries = _query_cost_anomaly_summary(report_date)
        details = _query_cost_anomaly_details(report_date)
        cost_anomaly_section = _format_cost_anomaly_section(summaries, details)
    except Exception as e:
        logger.error("成本异常数据查询失败: %s", e)
        cost_anomaly_section = "⚠️ 成本异常检测数据暂不可用"

    recent_investigations = _query_recent_investigations(hours=24)

    # 跳过判据：巡检没跑 + 无未关闭 finding + 无成本异常 + 无调查 = 真没东西说。
    # ⚠️ snapshot 为 None（读失败）**不算**没东西 —— 「数据不可用」本身
    #    就是要通知的事，静默跳过会让读失败与无事发生长得一样。
    has_open = snapshot is not None and any(
        rec.get("open_by_severity")
        for rec in (snapshot.get("accounts") or {}).values())
    cost_unavailable = cost_anomaly_section == "⚠️ 成本异常检测数据暂不可用"
    has_cost_anomaly_data = (
        cost_anomaly_section
        and not cost_unavailable
        and cost_anomaly_section != "✅ 成本异常：全部账号过去 24h 无成本异常"
    )
    # ⚠️ 「不可用」不算「没东西」—— 成本段与巡检段同一条规则：查询失败
    #    本身是要通知的事，skip 会让读失败与无事发生长得一样。
    if (snapshot is not None
            and not snapshot.get("ran_any")
            and not has_open
            and not cost_unavailable
            and not has_cost_anomaly_data
            and not recent_investigations):
        logger.info("今日无任何数据，跳过通知")
        return {"status": "skipped", "reason": "no_data"}

    # --- 组装消息 ---
    date_str = report_date.strftime("%Y-%m-%d")
    content = f"📋 **{date_str} 每日运维通知**\n\n"
    content += _format_inspection_section(snapshot, report_date)

    if cost_anomaly_section:
        content += "\n" + cost_anomaly_section + "\n"

    recent_section = _format_recent_investigations_section(recent_investigations)
    if recent_section:
        content += "\n" + recent_section + "\n"

    web_base = os.environ.get("WEB_BASE_URL", "").strip().rstrip("/")
    if web_base:
        content += f"\n---\n💡 判读详情与处置入口：{web_base}（左侧「巡检」看板）"
    else:
        content += "\n---\n💡 判读详情与处置入口见 Web Chat 巡检看板。"

    logger.info("通知内容已生成，长度=%d", len(content))

    # --- 推送 ---
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
        "inspection_available": snapshot is not None,
        "inspection_ran_any": bool(snapshot and snapshot.get("ran_any")),
        "recent_investigations": len(recent_investigations),
        "notifications_sent": total_sent,
    }
    logger.info("Lambda4-Notifier 完成: %s", result)
    return result
