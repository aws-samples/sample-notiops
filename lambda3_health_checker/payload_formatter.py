"""
Lambda3-HealthChecker Metrics Payload 格式化模块。
将 RDS 监控数据格式化为 CSV 表格文本，作为 Bedrock 调用的 user prompt。
"""

import logging
from collections import defaultdict

logger = logging.getLogger(__name__)

# CSV column names in the required order (25 columns, optimized)
CSV_COLUMNS = [
    # 元数据 (4)
    "dBInstanceIdentifier",
    "dBInstanceClass",
    "engine",
    "engineVersion",
    # CPU (2)
    "CPUUtilization(%)",
    "PeakCPU_7d(%)",
    # 内存 (2)
    "FreeableMemory_min(MB)",
    "EBSByteBalance%",
    # 存储 (2)
    "FreeStorageSpace(GB)",
    "FreeStorageSpaceLogVolume(GB)",
    # IO (7)
    "DiskQueueDepth",
    "DiskQueueDepthLogVolume",
    "ReadIOPS",
    "WriteIOPS",
    "ReadLatency_max(ms)",
    "WriteLatency_max(ms)",
    "ReadLatencyLogVolume(ms)",
    # 吞吐量 (3)
    "ReadThroughput",
    "WriteThroughput",
    "ReadThroughputLogVolume",
    # 网络 (2)
    "NetworkReceiveThroughput",
    "NetworkTransmitThroughput",
    # 连接 (2)
    "DatabaseConnections",
    "PeakConnections_7d",
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
    if fmt_type == "s_to_ms":    # 秒 → 毫秒，2位小数
        return str(round(float(value) * 1000, 2))
    if fmt_type == "int":        # 取整
        return str(int(float(value)))
    if fmt_type == "dqd":        # DiskQueueDepth，2位小数
        return str(round(float(value), 2))
    return str(value)            # 字符串原样


def _get_idle_label(instance: dict, idle_status: dict) -> str:
    """Get idle status label for an instance."""
    key = (instance.get("instance"), instance.get("account"))
    if key not in idle_status:
        return "unknown"
    return "idle" if idle_status[key] else "active"


def _instance_to_row(instance: dict, idle_status: dict) -> list[str]:
    """Convert an instance dict to a list of CSV field values (25 columns).

    Uses deep/health-check metrics (_sum, _max, _min variants) when available,
    falling back to base metrics. Applies precision truncation and unit conversion.
    """
    return [
        # 元数据
        _fmt(instance.get("instance")),
        _fmt(instance.get("instance_class")),
        _fmt(instance.get("engine")),
        _fmt(instance.get("engine_version")),
        # CPU
        _fmt(instance.get("cpu_utilization"), "pct1"),
        _fmt(instance.get("peak_cpu_7d"), "pct1"),
        # 内存
        _fmt(instance.get("freeable_memory_min"), "bytes_mb"),
        _fmt(instance.get("ebs_byte_balance_min"), "pct1"),
        # 存储
        _fmt(instance.get("free_storage"), "bytes_gb"),
        _fmt(instance.get("free_storage_log_volume_min"), "bytes_gb"),
        # IO
        _fmt(instance.get("disk_queue_depth_max"), "dqd"),
        _fmt(instance.get("disk_queue_depth_log_volume_max"), "dqd"),
        _fmt(
            instance.get("read_iops_sum")
            if instance.get("read_iops_sum") is not None
            else instance.get("read_iops"),
            "int",
        ),
        _fmt(
            instance.get("write_iops_sum")
            if instance.get("write_iops_sum") is not None
            else instance.get("write_iops"),
            "int",
        ),
        _fmt(instance.get("read_latency_max"), "s_to_ms"),
        _fmt(instance.get("write_latency_max"), "s_to_ms"),
        _fmt(instance.get("read_latency_log_volume_max"), "s_to_ms"),
        # 吞吐量
        _fmt(instance.get("read_throughput_sum"), "int"),
        _fmt(instance.get("write_throughput_sum"), "int"),
        _fmt(instance.get("read_throughput_log_volume_sum"), "int"),
        # 网络
        _fmt(
            instance.get("network_in_sum")
            if instance.get("network_in_sum") is not None
            else instance.get("network_in"),
            "int",
        ),
        _fmt(
            instance.get("network_out_sum")
            if instance.get("network_out_sum") is not None
            else instance.get("network_out"),
            "int",
        ),
        # 连接
        _fmt(
            instance.get("connections_max")
            if instance.get("connections_max") is not None
            else instance.get("connections"),
            "int",
        ),
        _fmt(instance.get("peak_connections_7d"), "int"),
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


def format_metrics_payload(
    instances: list[dict],
    idle_status: dict,
) -> str:
    """将实例监控数据格式化为 CSV 表格文本。

    - 按 account_id 和 region 分组排列
    - NULL 值标记为 "N/A"
    - 包含 idle_status 字段
    - 格式与 Agent Prompt 中定义的输入数据格式一致

    Returns:
        格式化后的 CSV 文本字符串。
    """
    if not instances:
        return ""

    groups = _group_by_account_region(instances)
    header_row = ",".join(CSV_COLUMNS)

    sections: list[str] = []
    for (account_id, region) in sorted(groups.keys()):
        group_instances = groups[(account_id, region)]
        lines: list[str] = []
        lines.append(f"Account: {account_id}, Region: {region}")
        lines.append(header_row)
        for inst in group_instances:
            row_values = _instance_to_row(inst, idle_status)
            lines.append(",".join(row_values))
        sections.append("\n".join(lines))

    return "\n\n".join(sections)


def estimate_token_count(payload: str) -> int:
    """粗略估算 payload 的 token 数量（按字符数/4 估算）。

    用于判断是否需要分批调用 Bedrock。
    """
    return len(payload) // 4


def split_payload_by_account(
    instances: list[dict],
    idle_status: dict,
    max_tokens: int,
) -> list[str]:
    """当实例数量过多时，按账户分批构建 payload。

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
        payload = format_metrics_payload(account_instances, idle_status)
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
        # Account for the "\n\n" separator between sections
        separator_tokens = estimate_token_count("\n\n") if current_parts else 0
        if current_tokens + separator_tokens + payload_tokens > max_tokens and current_parts:
            batches.append("\n\n".join(current_parts))
            current_parts = []
            current_tokens = 0

        current_parts.append(payload)
        separator_tokens = estimate_token_count("\n\n") if len(current_parts) > 1 else 0
        current_tokens = estimate_token_count("\n\n".join(current_parts))

    # Flush remaining
    if current_parts:
        batches.append("\n\n".join(current_parts))

    logger.info(
        "Split %d instances across %d accounts into %d batches (max_tokens=%d)",
        len(instances), len(account_groups), len(batches), max_tokens,
    )
    return batches
