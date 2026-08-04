"""Handle 'query' command — read DDB results and return as Feishu card."""
from __future__ import annotations

import logging

from core import i18n
from shared.queries import waste_report, reports, optimization, execution
from shared.queries.metrics import query_monitoring_by_date

logger = logging.getLogger(__name__)

QUERY_TYPES = {
    "health_report", "idle_resources", "optimization",
    "ec2_underutilized", "pipeline_status",
}


def handle(query_type: str, *, chat_id: str, locale: str = "en",
           reply_fn=None, **kwargs) -> str | None:
    """Dispatch to the appropriate query and return markdown result."""
    if query_type not in QUERY_TYPES:
        return i18n.t("query.unknown_type", locale, type=query_type)

    if query_type == "health_report":
        items, _ = reports.list_health_reports("rds", _today(), status="completed", limit=5)
        if not items:
            return i18n.t("query.no_data", locale, type="health_report")
        lines = [f"**RDS 巡检报告** ({_today()})"]
        for it in items:
            lines.append(f"- {it.get('account', 'N/A')}: {it.get('status', '?')}")
        return "\n".join(lines)

    elif query_type == "idle_resources":
        items = waste_report.query_idle_topN(_today(), n=5)
        if not items:
            return i18n.t("query.no_data", locale, type="idle_resources")
        lines = ["**闲置资源 Top 5**"]
        for it in items:
            savings = it.get("estimated_monthly_savings", 0)
            lines.append(f"- {it.get('instance_id', '?')} ({it.get('resource_type', '?')}): ${savings}/月")
        return "\n".join(lines)

    elif query_type == "optimization":
        items, _ = optimization.list_optimization_reports(limit=5)
        if not items:
            return i18n.t("query.no_data", locale, type="optimization")
        lines = ["**优化建议 Top 5**"]
        for it in items:
            lines.append(f"- {it.get('instance_id', '?')}: {it.get('optimization_type', '?')}")
        return "\n".join(lines)

    elif query_type == "ec2_underutilized":
        items = query_monitoring_by_date("ec2", _today())
        if not items:
            return i18n.t("query.no_data", locale, type="ec2_underutilized")
        lines = ["**EC2 低利用率**"]
        for it in items[:5]:
            lines.append(f"- {it.get('instance', '?')}: CPU {it.get('cpu_utilization', '?')}%")
        return "\n".join(lines)

    elif query_type == "pipeline_status":
        latest = execution.get_latest_execution("collection")
        if not latest:
            return i18n.t("query.no_data", locale, type="pipeline_status")
        return f"**采集状态**: {latest.get('status', '?')} ({latest.get('date', '?')})"

    return None


def _today() -> str:
    from datetime import date
    return date.today().isoformat()
