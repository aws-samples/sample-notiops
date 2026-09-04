"""
闲置报告 API 路由。
GET /api/waste-report         - 列表查询（筛选、分页）
GET /api/waste-report/export  - CSV 导出
GET /api/waste-report/:id     - 详情查询（按 account_id + instance_id + date 复合键）
"""

import csv
import io
import logging

from shared.queries.waste_report import (
    list_waste_reports,
    get_waste_report,
    get_latest_waste_date,
    query_idle_topN,
)
from shared.queries.metrics import get_monitoring_history, get_latest_monitoring_date
from shared.queries.whitelist import load_whitelist_set
from api.routes._export_util import csv_safe_row
from api.errors import NotFoundError

logger = logging.getLogger(__name__)

# CSV 导出字段
CSV_FIELDS = [
    "instance_id", "account_id", "region", "resource_type", "instance_class",
    "engine", "idle_score", "value_score", "consecutive_low_days",
    "estimated_monthly_savings", "exclusion_reason",
    "cpu_utilization", "connections", "free_storage_or_memory",
    "peak_cpu_7d", "read_iops", "write_iops", "evictions",
    "allocated_storage_gb", "cache_hits", "cache_misses",
]


def handle_waste_report(method: str, path: str, query_params: dict, path_params: dict, body: dict | None) -> dict:
    if method != "GET":
        raise ValueError(f"Method {method} not allowed")

    if path.endswith("/export"):
        return _export_csv(query_params)

    # 详情查询: /api/waste-report/{account_id}/{instance_id}
    # TODO: 暂保留旧路径格式兼容，内部用业务键查询
    parts = path.rstrip("/").split("/")
    if len(parts) >= 5:
        # /api/waste-report/{account_id}/{instance_id}
        account_id = parts[-2]
        instance_id = parts[-1]
        return _get_detail(account_id, instance_id, query_params)

    return _get_list(query_params)


def _get_list(query_params: dict) -> dict:
    """闲置资源报告列表（仅 idle，默认最新日期）。

    返回该日期的**完整集**（内部翻页，不截断）经白名单 + resource_type 过滤后的
    结果，并服务端聚合 total / total_savings，避免前端在被截断的 cursor 页上做
    客户端聚合。支持 resource_type 过滤（专项页 RDS/ElastiCache 用）。
    """
    account_id = query_params.get("account_id")
    report_date = query_params.get("report_date")
    resource_type = query_params.get("resource_type") or None

    # 默认查最新日期，避免同一实例跨天重复（镜像原版 SELECT MAX(report_date)）
    if not report_date:
        report_date = get_latest_waste_date()
        if not report_date:
            return {"items": [], "total": 0, "total_savings": 0.0, "next_cursor": None}

    # 翻页拉取该日期的完整 idle 集（不截断），再在应用层做白名单 + 类型过滤。
    rows: list = []
    cursor = None
    while True:
        page, cursor = list_waste_reports(
            account_id=account_id, date=report_date, cursor=cursor, limit=200,
        )
        rows.extend(page)
        if not cursor:
            break

    # 白名单一次性批量加载（O(1) 内存判定，避免逐行 GetItem）。
    wl = load_whitelist_set("waste")
    filtered = []
    total_savings = 0.0
    for item in rows:
        if resource_type and item.get("resource_type") != resource_type:
            continue
        inst = item.get("instance_id", "")
        acct = item.get("account_id", "")
        if (acct, inst) in wl:
            continue
        filtered.append(item)
        sv = item.get("estimated_monthly_savings", item.get("savings", 0)) or 0
        total_savings += float(sv)

    return {
        "items": filtered,
        "total": len(filtered),
        "total_savings": total_savings,
        "next_cursor": None,
    }


def _get_detail(account_id: str, instance_id: str, query_params: dict) -> dict:
    """闲置实例详情（含关联监控数据）。按全键点查。"""
    report_date = query_params.get("report_date") or get_latest_waste_date()
    if not report_date:
        raise NotFoundError(f"Waste report for {account_id}/{instance_id} not found")

    report = get_waste_report(account_id, report_date, instance_id)
    if not report:
        raise NotFoundError(f"Waste report for {account_id}/{instance_id} not found")

    # 查询关联的监控数据（最近 7 天）
    rt = report.get("resource_type", "rds")
    monitoring = get_monitoring_history(rt, instance_id, account_id, days=7)

    return {
        "report": report,
        "monitoring_history": monitoring,
    }


def _export_csv(query_params: dict) -> dict:
    """CSV 导出（仅 idle，默认最新日期，与列表一致，支持 resource_type 过滤）。"""
    account_id = query_params.get("account_id")
    report_date = query_params.get("report_date") or get_latest_waste_date()
    resource_type = query_params.get("resource_type") or None

    # Fetch all items (paginate through)
    all_rows = []
    cursor = None
    if report_date:
        wl = load_whitelist_set("waste")
        while True:
            items, cursor = list_waste_reports(
                account_id=account_id,
                date=report_date,
                cursor=cursor,
                limit=200,
            )
            # Filter out whitelisted + non-matching resource_type
            for item in items:
                if resource_type and item.get("resource_type") != resource_type:
                    continue
                inst = item.get("instance_id", "")
                acct = item.get("account_id", "")
                if (acct, inst) not in wl:
                    all_rows.append(item)
            if not cursor:
                break

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=CSV_FIELDS, extrasaction="ignore")
    writer.writeheader()
    for row in all_rows:
        writer.writerow(csv_safe_row(row))

    return {
        "_csv": output.getvalue(),
        "_filename": "waste_report.csv",
    }
