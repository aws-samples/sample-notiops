"""
EC2 低利用率报告 API 路由。
GET /api/ec2-underutilized         - 列表查询（筛选、分页）
GET /api/ec2-underutilized/export  - CSV 导出
GET /api/ec2-underutilized/:id     - 详情查询
"""

import csv
import io
import logging

from shared.queries.metrics import query_monitoring_by_date, get_latest_monitoring_date, get_monitoring_history
from shared.queries.whitelist import load_whitelist_set
from api.routes._export_util import csv_safe_row
from api.errors import NotFoundError

logger = logging.getLogger(__name__)

# CSV 导出字段
CSV_FIELDS = [
    "instance", "account", "region", "instance_name", "instance_type",
    "cpu_14d_avg", "network_io_14d_avg", "low_utilization_days",
    "classic_estimated_savings", "recommended_action",
    "current_resource_summary", "recommended_resource_summary",
    "costhub_estimated_monthly_cost", "costhub_estimated_savings",
    "costhub_last_refresh", "status", "monitoring_date",
]


def handle_ec2_underutilized(
    method: str, path: str, query_params: dict,
    path_params: dict, body: dict | None,
) -> dict:
    """路由分发：列表 / 导出 / 详情。"""
    if method != "GET":
        raise ValueError(f"Method {method} not allowed")

    if path.endswith("/export"):
        return _export_csv(query_params)

    # 详情查询: /api/ec2-underutilized/{account_id}/{instance_id}
    # TODO: 暂保留旧路径格式兼容
    parts = path.rstrip("/").split("/")
    if len(parts) >= 5:
        account_id = parts[-2]
        instance_id = parts[-1]
        return _get_detail(account_id, instance_id, query_params)

    return _get_list(query_params)


def _get_list(query_params: dict) -> dict:
    """列表查询，支持 account_id/region/instance_type 筛选，cursor 分页。"""
    monitoring_date = query_params.get("monitoring_date")
    account_filter = query_params.get("account_id")
    region_filter = query_params.get("region")
    instance_type_filter = query_params.get("instance_type")

    # Get latest date if not specified
    if not monitoring_date:
        monitoring_date = get_latest_monitoring_date("ec2")
        if not monitoring_date:
            return {"items": [], "next_cursor": None}

    # Query all EC2 monitoring data for the date
    all_rows = query_monitoring_by_date("ec2", monitoring_date)

    # Load EC2 whitelist to filter out. EC2 whitelist entries live in the
    # `health` namespace (health_check_whitelist accepts rt=ec2); the `waste`
    # namespace only ever holds rds/elasticache, so reading it here meant EC2
    # whitelisting silently no-op'd.
    wl_set = load_whitelist_set("health", rt="ec2")

    # Apply filters in application layer
    filtered = []
    for row in all_rows:
        instance_id = row.get("instance", "")
        account_id = row.get("account", "")

        # Exclude whitelisted (instance-specific or account-level $ACCT)
        if (account_id, instance_id) in wl_set or (account_id, "$ACCT") in wl_set:
            continue

        # Apply query filters
        if account_filter and account_id != account_filter:
            continue
        if region_filter and row.get("region") != region_filter:
            continue
        if instance_type_filter and row.get("instance_type") != instance_type_filter:
            continue

        filtered.append(row)

    # Calculate savings totals
    total_classic_savings = sum(
        float(row.get("classic_estimated_savings") or 0)
        for row in filtered
    )
    total_costhub_savings = sum(
        float(row.get("costhub_estimated_savings") or 0)
        for row in filtered
    )

    for item in filtered:
        item.setdefault("instance_id", item.get("instance", ""))
        item.setdefault("account_id", item.get("account", ""))

    return {
        "items": filtered,
        "next_cursor": None,
        "total": len(filtered),
        "total_classic_savings": total_classic_savings,
        "total_costhub_savings": total_costhub_savings,
    }


def _get_detail(account_id: str, instance_id: str, query_params: dict) -> dict:
    """单条 EC2 低利用率记录详情。"""
    monitoring = get_monitoring_history("ec2", instance_id, account_id, days=1)
    if not monitoring:
        raise NotFoundError(f"EC2 underutilized record {account_id}/{instance_id} not found")

    record = monitoring[0]
    record.setdefault("instance_id", record.get("instance", ""))
    record.setdefault("account_id", record.get("account", ""))
    return {"record": record}


def _export_csv(query_params: dict) -> dict:
    """CSV 导出（与列表一致：白名单 + account/region/instance_type 过滤）。"""
    monitoring_date = query_params.get("monitoring_date")
    account_filter = query_params.get("account_id")
    region_filter = query_params.get("region")
    instance_type_filter = query_params.get("instance_type")

    if not monitoring_date:
        monitoring_date = get_latest_monitoring_date("ec2")
        if not monitoring_date:
            return {"_csv": "", "_filename": "ec2_underutilized.csv"}

    all_rows = query_monitoring_by_date("ec2", monitoring_date)
    wl_set = load_whitelist_set("health", rt="ec2")

    filtered = []
    for row in all_rows:
        instance_id = row.get("instance", "")
        account_id = row.get("account", "")
        if (account_id, instance_id) in wl_set or (account_id, "$ACCT") in wl_set:
            continue
        if account_filter and account_id != account_filter:
            continue
        if region_filter and row.get("region") != region_filter:
            continue
        if instance_type_filter and row.get("instance_type") != instance_type_filter:
            continue
        filtered.append(row)

    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=CSV_FIELDS, extrasaction="ignore")
    writer.writeheader()
    for row in filtered:
        writer.writerow(csv_safe_row(row))

    return {
        "_csv": output.getvalue(),
        "_filename": "ec2_underutilized.csv",
    }
