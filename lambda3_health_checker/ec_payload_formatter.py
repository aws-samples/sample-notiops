"""
Lambda3-HealthChecker ElastiCache Metrics Payload 格式化模块。
将 ElastiCache 监控数据格式化为 CSV 表格文本，作为 Bedrock 调用的 user prompt。
"""

import logging
from collections import defaultdict

from lambda3_health_checker.payload_formatter import estimate_token_count

logger = logging.getLogger(__name__)

# ElastiCache CSV column names in the required order (30 columns, optimized)
EC_CSV_COLUMNS = [
    # 元数据 + 拓扑 (10)
    "CacheClusterId",
    "ReplicationGroupId",
    "NodeRole",
    "ShardId",
    "ClusterEnabled",
    "MultiAZ",
    "AutomaticFailover",
    "EngineVersion",
    "CacheNodeType",
    "engine",
    # CPU (3)
    "EngineCPUUtilization_avg(%)",
    "CPUUtilization_max(%)",
    "PeakCPU_7d(%)",
    # 连接 (4)
    "CurrConnections_avg",
    "CurrConnections_max",
    "NewConnections_sum",
    "PeakConnections_7d",
    # 内存 (7)
    "DatabaseMemoryUsagePercentage_max(%)",
    "BytesUsedForCache_max(GB)",
    "FreeableMemory_min(MB)",
    "SwapUsage_max(MB)",
    "MemoryFragmentationRatio_max",
    "Evictions_sum",
    "CurrItems_max",
    # 缓存 (1)
    "CacheHitRate(%)",
    # 网络 + 复制 (3)
    "NetworkBandwidthInExceeded_sum",
    "NetworkBandwidthOutExceeded_sum",
    "ReplicationLag_max(s)",
    # 容量 (1)
    "DatabaseCapacityUsagePercentage_max(%)",
    # 状态 (1)
    "idle_status",
]


def _fmt(value, fmt_type="str") -> str:
    """Format a single value. None → 'N/A', with type-specific precision."""
    if value is None:
        return "N/A"
    if fmt_type == "pct1":       # 百分比，1位小数
        return str(round(float(value), 1))
    if fmt_type == "bytes_mb":   # bytes → MB，2位小数
        return str(round(float(value) / 1048576, 2))
    if fmt_type == "bytes_gb":   # bytes → GB，2位小数
        return str(round(float(value) / 1073741824, 2))
    if fmt_type == "int":        # 取整
        return str(int(float(value)))
    if fmt_type == "ratio2":     # 比率，2位小数
        return str(round(float(value), 2))
    if fmt_type == "sec3":       # 秒，3位小数
        return str(round(float(value), 3))
    return str(value)            # 字符串原样


def _calc_hit_rate(hits, misses) -> str:
    """Pre-calculate cache hit rate. Returns 'N/A' if either is None or total is 0."""
    if hits is None or misses is None:
        return "N/A"
    total = float(hits) + float(misses)
    if total == 0:
        return "N/A"
    return str(round(float(hits) / total * 100, 1))


def _get_idle_label(instance: dict, idle_status: dict) -> str:
    """Get idle status label for an instance."""
    key = (instance.get("instance"), instance.get("account"))
    if key not in idle_status:
        return "unknown"
    return "idle" if idle_status[key] else "active"


def _ec_instance_to_row(instance: dict, idle_status: dict) -> list[str]:
    """Convert an ElastiCache instance dict to a list of CSV field values (30 columns)."""
    return [
        # 元数据 + 拓扑
        _fmt(instance.get("instance")),
        _fmt(instance.get("replication_group_id")),
        _fmt(instance.get("node_role")),
        _fmt(instance.get("shard_id")),
        _fmt(instance.get("cluster_enabled")),
        _fmt(instance.get("multi_az")),
        _fmt(instance.get("automatic_failover")),
        _fmt(instance.get("engine_version")),
        _fmt(instance.get("instance_class")),
        _fmt(instance.get("engine")),
        # CPU
        _fmt(instance.get("cpu_utilization"), "pct1"),
        _fmt(instance.get("cpu_utilization_max"), "pct1"),
        _fmt(instance.get("peak_cpu_7d"), "pct1"),
        # 连接
        _fmt(instance.get("connections"), "int"),
        _fmt(instance.get("curr_connections_max"), "int"),
        _fmt(instance.get("new_connections_sum"), "int"),
        _fmt(instance.get("peak_connections_7d"), "int"),
        # 内存
        _fmt(instance.get("memory_usage_pct_max"), "pct1"),
        _fmt(instance.get("bytes_used_for_cache_max"), "bytes_gb"),
        _fmt(instance.get("freeable_memory_min"), "bytes_mb"),
        _fmt(instance.get("swap_usage_max"), "bytes_mb"),
        _fmt(instance.get("memory_fragmentation_ratio_max"), "ratio2"),
        _fmt(instance.get("evictions_sum"), "int"),
        _fmt(instance.get("curr_items_max"), "int"),
        # 缓存命中率（预计算）
        _calc_hit_rate(instance.get("cache_hits"), instance.get("cache_misses")),
        # 网络 + 复制
        _fmt(instance.get("nw_bw_in_exceeded"), "int"),
        _fmt(instance.get("nw_bw_out_exceeded"), "int"),
        _fmt(instance.get("replication_lag"), "sec3"),
        # 容量
        _fmt(instance.get("capacity_usage_pct_max"), "pct1"),
        # 状态
        _get_idle_label(instance, idle_status),
    ]


def _group_by_account_region(instances: list[dict]) -> dict[tuple[str, str], list[dict]]:
    """Group instances by (account, region)."""
    groups: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for inst in instances:
        key = (inst.get("account", ""), inst.get("region", ""))
        groups[key].append(inst)
    return groups


def format_ec_metrics_payload(
    instances: list[dict],
    idle_status: dict[tuple[str, str], bool],
) -> str:
    """将 ElastiCache 实例监控数据格式化为 CSV 表格文本。

    - 按 account_id 和 region 分组排列
    - NULL 值标记为 "N/A"
    - 包含 idle_status 字段

    Returns:
        格式化后的 CSV 文本字符串。
    """
    if not instances:
        return ""

    groups = _group_by_account_region(instances)
    header_row = ",".join(EC_CSV_COLUMNS)

    sections: list[str] = []
    for (account_id, region) in sorted(groups.keys()):
        group_instances = groups[(account_id, region)]
        lines: list[str] = []
        lines.append(f"Account: {account_id}, Region: {region}")
        lines.append(header_row)
        for inst in group_instances:
            row_values = _ec_instance_to_row(inst, idle_status)
            lines.append(",".join(row_values))
        sections.append("\n".join(lines))

    return "\n\n".join(sections)


def split_ec_payload_by_account(
    instances: list[dict],
    idle_status: dict[tuple[str, str], bool],
    max_tokens: int,
) -> list[str]:
    """当 ElastiCache 实例数量过多时，按账户分批构建 payload。

    每批生成独立的格式化文本，确保每批的估算 token 数不超过 max_tokens。
    如果单个账户的 payload 已超过 max_tokens，则将其作为独立批次包含。

    Returns:
        格式化文本的列表，每个元素为一个批次的 payload。
    """
    if not instances:
        return []

    # Group instances by account
    account_groups: dict[str, list[dict]] = defaultdict(list)
    for inst in instances:
        account_groups[inst.get("account", "")].append(inst)

    # Build per-account payloads
    account_payloads: list[tuple[str, str]] = []  # (account_id, payload)
    for account_id in sorted(account_groups.keys()):
        account_instances = account_groups[account_id]
        payload = format_ec_metrics_payload(account_instances, idle_status)
        account_payloads.append((account_id, payload))

    # Combine accounts into batches respecting max_tokens
    batches: list[str] = []
    current_parts: list[str] = []
    current_tokens = 0

    for account_id, payload in account_payloads:
        payload_tokens = estimate_token_count(payload)

        # Single account exceeds limit — include as its own batch
        if payload_tokens >= max_tokens:
            # Flush current batch first if non-empty
            if current_parts:
                batches.append("\n\n".join(current_parts))
                current_parts = []
                current_tokens = 0
            batches.append(payload)
            continue

        # Check if adding this account would exceed the limit
        separator_tokens = estimate_token_count("\n\n") if current_parts else 0
        if current_tokens + separator_tokens + payload_tokens > max_tokens and current_parts:
            batches.append("\n\n".join(current_parts))
            current_parts = []
            current_tokens = 0

        current_parts.append(payload)
        current_tokens = estimate_token_count("\n\n".join(current_parts))

    # Flush remaining
    if current_parts:
        batches.append("\n\n".join(current_parts))

    logger.info(
        "Split %d ElastiCache instances across %d accounts into %d batches (max_tokens=%d)",
        len(instances), len(account_groups), len(batches), max_tokens,
    )
    return batches
