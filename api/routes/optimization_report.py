"""
潜在优化资源报告 API 路由。
GET /api/optimization-report         - 列表查询（筛选、分页）
GET /api/optimization-report/export  - CSV 导出
GET /api/optimization-report/:id     - 详情查询（按 account_id + instance_id 复合键）
"""

import csv
import io
import logging

from shared.queries.optimization import (
    summarize_optimization_reports,
    get_optimization_report,
    get_latest_optimization_date,
)
from shared.queries.metrics import get_monitoring_history
from api.routes._export_util import csv_safe_row

logger = logging.getLogger(__name__)

# CSV 导出字段
CSV_FIELDS = [
    "instance_id", "account_id", "region", "resource_type", "instance_class",
    "engine", "optimization_type", "estimated_monthly_cost", "is_micro",
    "free_storage_avg_gb", "allocated_storage_gb", "cpu_max",
    "bytes_used_for_cache_gb", "swap_max_gb", "engine_cpu_max",
    "memory_util_pct", "nw_bw_in_exceeded", "nw_bw_out_exceeded",
]


def handle_optimization_report(method: str, path: str, query_params: dict, path_params: dict, body: dict | None) -> dict:
    if method != "GET":
        raise ValueError(f"Method {method} not allowed")

    if path.endswith("/export"):
        return _export_csv(query_params)

    # 详情查询: /api/optimization-report/{account_id}/{instance_id}
    # TODO: 暂保留旧路径格式兼容，内部用业务键查询
    parts = path.rstrip("/").split("/")
    if len(parts) >= 5:
        account_id = parts[-2]
        instance_id = parts[-1]
        return _get_detail(account_id, instance_id, query_params)

    return _get_list(query_params)


def _get_list(query_params: dict) -> dict:
    """潜在优化资源报告列表（默认最新日期）。

    返回该日期的**完整过滤集** + 服务端聚合的 total / total_cost，避免前端
    在被截断的 cursor 页上做客户端聚合（镜像原版 SELECT *, COUNT, SUM）。
    支持 resource_type 过滤（专项页 RDS/ElastiCache 用）。
    """
    account_id = query_params.get("account_id")
    report_date = query_params.get("report_date")
    resource_type = query_params.get("resource_type") or None

    # 默认查最新日期，避免跨天重复（镜像原版 SELECT MAX(report_date)）
    if not report_date:
        report_date = get_latest_optimization_date()
        if not report_date:
            return {"items": [], "total": 0, "total_cost": 0.0, "next_cursor": None}

    items, total, total_cost = summarize_optimization_reports(
        account_id=account_id,
        date=report_date,
        resource_type=resource_type,
    )

    return {
        "items": items,
        "total": total,
        "total_cost": total_cost,
        "next_cursor": None,
    }


def _get_detail(account_id: str, instance_id: str, query_params: dict) -> dict:
    """优化报告详情。按全键点查。"""
    report_date = query_params.get("report_date") or get_latest_optimization_date()
    if not report_date:
        raise KeyError(f"Optimization report for {account_id}/{instance_id} not found")

    report = get_optimization_report(account_id, report_date, instance_id)
    if not report:
        raise KeyError(f"Optimization report for {account_id}/{instance_id} not found")

    # 查询关联的监控数据（最近 7 天）
    rt = report.get("resource_type", "rds")
    monitoring = get_monitoring_history(rt, instance_id, account_id, days=7)

    return {
        "report": report,
        "monitoring_history": monitoring,
    }


def _export_csv(query_params: dict) -> dict:
    """CSV 导出（默认最新日期，与列表一致，支持 resource_type 过滤）。"""
    account_id = query_params.get("account_id")
    report_date = query_params.get("report_date") or get_latest_optimization_date()
    resource_type = query_params.get("resource_type") or None

    all_rows: list = []
    if report_date:
        all_rows, _total, _cost = summarize_optimization_reports(
            account_id=account_id,
            date=report_date,
            resource_type=resource_type,
        )

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=CSV_FIELDS, extrasaction="ignore")
    writer.writeheader()
    for row in all_rows:
        writer.writerow(csv_safe_row(row))

    return {
        "_csv": output.getvalue(),
        "_filename": "optimization_report.csv",
    }
