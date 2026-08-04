"""
Dashboard API 路由。
GET /api/dashboard/summary  - 全量数据大盘概览（支持 account_id, region 筛选）
GET /api/dashboard/pipeline - 各阶段处理数量统计
"""

import logging

from shared.queries.dashboard import compute_dashboard_summary
from shared.queries.execution import get_latest_execution

logger = logging.getLogger(__name__)


def handle_dashboard(method: str, path: str, query_params: dict, path_params: dict, body: dict | None) -> dict:
    if method != "GET":
        raise ValueError(f"Method {method} not allowed")

    if path.endswith("/summary"):
        return _get_summary(query_params)
    elif path.endswith("/pipeline"):
        return _get_pipeline(query_params)
    else:
        raise ValueError("Unknown dashboard endpoint. Use /summary or /pipeline")


def _get_summary(query_params: dict) -> dict:
    """全量数据大盘概览（按 account_id / region 读时聚合，镜像原版语义）。"""
    account_id = query_params.get("account_id") or None
    region = query_params.get("region") or None
    return compute_dashboard_summary(account=account_id, region=region)


def _get_pipeline(query_params: dict) -> dict:
    """各阶段处理数量统计（最近一次执行）。"""
    collection = get_latest_execution("collection")
    analysis = get_latest_execution("analysis")

    return {
        "collection": collection or {},
        "analysis": analysis or {},
    }
