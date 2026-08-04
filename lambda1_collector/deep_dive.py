"""
精选采集模块。
识别 Candidate（疑似闲置实例），对其采集深度指标和 7 天峰值，
并将深度指标 UPDATE 到 DynamoDB 现有记录。
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from lambda1_collector.discovery import InstanceMetadata  # noqa: F401 - may be used by callers
from lambda1_collector.metrics_collector import (
    BaseMetricsResult,
    BATCH_SIZE,
    NAMESPACE_MAP,
    DIMENSION_MAP,
)
from lambda1_collector.threshold import ThresholdConfig, get_threshold_for_resource_type
from shared.queries.metrics import update_monitoring_fields

logger = logging.getLogger(__name__)

# RDS 深度指标
RDS_DEEP_METRICS = [
    "ReadIOPS",
    "WriteIOPS",
    "NetworkReceiveThroughput",
    "NetworkTransmitThroughput",
]

# ElastiCache 深度指标
ELASTICACHE_DEEP_METRICS = [
    "Evictions",
    "NetworkBytesIn",
    "NetworkBytesOut",
    "BytesUsedForCache",   # 🆕
    "SwapUsage",           # 🆕
]

# CPU 指标名称映射（用于 7 天峰值采集）
CPU_METRIC_MAP = {
    "rds": "CPUUtilization",
    "elasticache": "EngineCPUUtilization",
}

# 连接数指标名称映射（用于 7 天峰值采集）
CONNECTIONS_METRIC_MAP = {
    "rds": "DatabaseConnections",
    "elasticache": "CurrConnections",
}


@dataclass
class DeepMetricsResult:
    instance_id: str
    read_iops: float | None
    write_iops: float | None
    network_in: float | None
    network_out: float | None
    evictions: int | None          # 仅 ElastiCache
    peak_cpu_7d: float | None
    peak_connections_7d: int | None
    bytes_used_for_cache: float | None = None  # 🆕 ElastiCache
    swap_usage: float | None = None            # 🆕 ElastiCache


def identify_candidates(
    metrics: list[BaseMetricsResult],
    threshold_configs: dict[str, ThresholdConfig],
) -> list[BaseMetricsResult]:
    """
    根据资源类型的阈值筛选 Candidate：
    CPU < 阈值 且 连接数 < 阈值 → 标记为 Candidate。
    如果 CPU 或连接数为 None，视为不满足 Candidate 条件（跳过）。
    ElastiCache 副本（replication_lag 不为 None）自动跳过。
    """
    candidates = []

    for m in metrics:
        # 🆕 跳过 ElastiCache 副本
        if m.resource_type == "elasticache" and m.replication_lag is not None:
            logger.info("Skipping replica: %s (replication_lag=%.2f)", m.instance_id, m.replication_lag)
            continue

        # 跳过缺失指标的实例
        if m.cpu_utilization is None or m.connections is None:
            continue

        threshold = get_threshold_for_resource_type(m.resource_type, threshold_configs)

        if (
            m.cpu_utilization <= threshold.candidate_cpu
            and m.connections <= threshold.candidate_connections
        ):
            candidates.append(m)
            logger.debug(
                "Instance %s identified as candidate: CPU=%.2f < %.2f, Conn=%d < %d",
                m.instance_id,
                m.cpu_utilization,
                threshold.candidate_cpu,
                m.connections,
                threshold.candidate_connections,
            )

    logger.info(
        "Identified %d candidates out of %d instances",
        len(candidates),
        len(metrics),
    )
    return candidates


def _get_deep_metric_names(resource_type: str) -> list[str]:
    """根据资源类型返回对应的深度指标名称列表。"""
    if resource_type == "rds":
        return RDS_DEEP_METRICS
    elif resource_type == "elasticache":
        return ELASTICACHE_DEEP_METRICS
    else:
        raise ValueError(f"Unknown resource_type: {resource_type}")


def _build_deep_metric_queries(
    candidates: list[BaseMetricsResult],
    resource_type: str,
) -> list[dict]:
    """
    构建深度指标的 GetMetricData MetricDataQueries。
    ID 格式: d_{instance_index}_{metric_index}
    """
    metric_names = _get_deep_metric_names(resource_type)
    namespace = NAMESPACE_MAP[resource_type]
    dimension_name = DIMENSION_MAP[resource_type]
    queries = []

    for i, candidate in enumerate(candidates):
        for j, metric_name in enumerate(metric_names):
            query_id = f"d_{i}_{j}"
            queries.append({
                "Id": query_id,
                "MetricStat": {
                    "Metric": {
                        "Namespace": namespace,
                        "MetricName": metric_name,
                        "Dimensions": [
                            {"Name": dimension_name, "Value": candidate.instance_id}
                        ],
                    },
                    "Period": 86400,
                    "Stat": "Average",
                },
                "ReturnData": True,
            })

    return queries


def _collect_deep_metrics(
    cw_client,
    candidates: list[BaseMetricsResult],
    resource_type: str,
) -> dict[int, dict[int, float | None]]:
    """
    调用 GetMetricData 采集深度指标（24h 均值）。
    返回 {instance_index: {metric_index: value}} 的映射。
    """
    if not candidates:
        return {}

    metric_names = _get_deep_metric_names(resource_type)
    metrics_per_instance = len(metric_names)
    instances_per_batch = BATCH_SIZE // metrics_per_instance

    now = datetime.now(timezone.utc)
    start_time = now - timedelta(hours=24)

    all_results: dict[int, dict[int, float | None]] = {}

    for batch_start in range(0, len(candidates), instances_per_batch):
        batch = candidates[batch_start:batch_start + instances_per_batch]
        queries = _build_deep_metric_queries(batch, resource_type)

        try:
            response = cw_client.get_metric_data(
                MetricDataQueries=queries,
                StartTime=start_time,
                EndTime=now,
            )
        except Exception as e:
            logger.error(
                "Deep metrics GetMetricData failed for batch starting at %d: %s",
                batch_start, e,
            )
            continue

        for result in response.get("MetricDataResults", []):
            query_id = result["Id"]  # d_{i}_{j}
            parts = query_id.split("_")
            instance_idx = int(parts[1]) + batch_start
            metric_idx = int(parts[2])
            values = result.get("Values", [])
            value = values[0] if values else None

            if instance_idx not in all_results:
                all_results[instance_idx] = {}
            all_results[instance_idx][metric_idx] = value

    return all_results


def _collect_peak_metrics(
    cw_client,
    candidates: list[BaseMetricsResult],
    resource_type: str,
) -> dict[int, dict[str, float | None]]:
    """
    调用 GetMetricStatistics 采集 7 天 CPU 峰值和连接数峰值。
    Period=86400, Stat=Maximum。
    返回 {instance_index: {"peak_cpu": value, "peak_connections": value}}。
    """
    if not candidates:
        return {}

    namespace = NAMESPACE_MAP[resource_type]
    dimension_name = DIMENSION_MAP[resource_type]
    cpu_metric = CPU_METRIC_MAP[resource_type]
    conn_metric = CONNECTIONS_METRIC_MAP[resource_type]

    now = datetime.now(timezone.utc)
    start_time = now - timedelta(days=7)

    results: dict[int, dict[str, float | None]] = {}

    for i, candidate in enumerate(candidates):
        peak_cpu = None
        peak_connections = None

        # 采集 7 天 CPU 峰值
        try:
            response = cw_client.get_metric_statistics(
                Namespace=namespace,
                MetricName=cpu_metric,
                Dimensions=[
                    {"Name": dimension_name, "Value": candidate.instance_id}
                ],
                StartTime=start_time,
                EndTime=now,
                Period=86400,
                Statistics=["Maximum"],
            )
            datapoints = response.get("Datapoints", [])
            if datapoints:
                peak_cpu = max(dp["Maximum"] for dp in datapoints)
        except Exception as e:
            logger.error(
                "Failed to get peak CPU for %s: %s",
                candidate.instance_id, e,
            )

        # 采集 7 天连接数峰值
        try:
            response = cw_client.get_metric_statistics(
                Namespace=namespace,
                MetricName=conn_metric,
                Dimensions=[
                    {"Name": dimension_name, "Value": candidate.instance_id}
                ],
                StartTime=start_time,
                EndTime=now,
                Period=86400,
                Statistics=["Maximum"],
            )
            datapoints = response.get("Datapoints", [])
            if datapoints:
                peak_connections = max(dp["Maximum"] for dp in datapoints)
        except Exception as e:
            logger.error(
                "Failed to get peak connections for %s: %s",
                candidate.instance_id, e,
            )

        results[i] = {
            "peak_cpu": peak_cpu,
            "peak_connections": peak_connections,
        }

    return results


def _build_deep_metrics_results(
    candidates: list[BaseMetricsResult],
    resource_type: str,
    deep_data: dict[int, dict[int, float | None]],
    peak_data: dict[int, dict[str, float | None]],
) -> list[DeepMetricsResult]:
    """
    将深度指标和峰值数据组装为 DeepMetricsResult 列表。
    """
    results = []

    for i, candidate in enumerate(candidates):
        metrics = deep_data.get(i, {})
        peaks = peak_data.get(i, {})

        if resource_type == "rds":
            result = DeepMetricsResult(
                instance_id=candidate.instance_id,
                read_iops=metrics.get(0),
                write_iops=metrics.get(1),
                network_in=metrics.get(2),
                network_out=metrics.get(3),
                evictions=None,
                peak_cpu_7d=peaks.get("peak_cpu"),
                peak_connections_7d=(
                    int(peaks["peak_connections"])
                    if peaks.get("peak_connections") is not None
                    else None
                ),
            )
        elif resource_type == "elasticache":
            result = DeepMetricsResult(
                instance_id=candidate.instance_id,
                read_iops=None,
                write_iops=None,
                network_in=metrics.get(1),
                network_out=metrics.get(2),
                evictions=(
                    int(metrics[0])
                    if metrics.get(0) is not None
                    else None
                ),
                peak_cpu_7d=peaks.get("peak_cpu"),
                peak_connections_7d=(
                    int(peaks["peak_connections"])
                    if peaks.get("peak_connections") is not None
                    else None
                ),
                bytes_used_for_cache=metrics.get(3),
                swap_usage=metrics.get(4),
            )
        else:
            raise ValueError(f"Unknown resource_type: {resource_type}")

        results.append(result)

    return results


def _update_deep_metrics_in_db(
    candidates: list[BaseMetricsResult],
    deep_results: list[DeepMetricsResult],
    resource_type: str,
) -> int:
    """
    将深度指标 UPDATE 到 DynamoDB 现有记录。
    返回更新的行数。
    """
    if not deep_results:
        return 0

    updated = 0
    for candidate, dr in zip(candidates, deep_results):
        date_str = candidate.monitoring_date if isinstance(candidate.monitoring_date, str) else candidate.monitoring_date.isoformat()

        if resource_type == "rds":
            fields = {
                "read_iops": dr.read_iops,
                "write_iops": dr.write_iops,
                "network_in": dr.network_in,
                "network_out": dr.network_out,
                "allocated_storage_gb": candidate.allocated_storage_gb if hasattr(candidate, 'allocated_storage_gb') else None,
                "peak_cpu_7d": dr.peak_cpu_7d,
                "peak_connections_7d": dr.peak_connections_7d,
                "is_candidate": True,
                "cand_flag": 1,
            }
        elif resource_type == "elasticache":
            fields = {
                "evictions": dr.evictions,
                "network_in": dr.network_in,
                "network_out": dr.network_out,
                "bytes_used_for_cache": dr.bytes_used_for_cache,
                "swap_usage": dr.swap_usage,
                "peak_cpu_7d": dr.peak_cpu_7d,
                "peak_connections_7d": dr.peak_connections_7d,
                "is_candidate": True,
                "cand_flag": 1,
            }
        else:
            raise ValueError(f"Unknown resource_type: {resource_type}")

        # Remove None values to avoid overwriting with empty
        fields = {k: v for k, v in fields.items() if v is not None}

        update_monitoring_fields(
            resource_type,
            candidate.instance_id,
            candidate.account_id,
            date_str,
            fields,
        )
        updated += 1

    logger.info(
        "Updated %d %s records with deep metrics",
        updated, resource_type,
    )
    return updated


def deep_dive_collection(
    clients: dict,
    candidates: list[BaseMetricsResult],
    resource_type: str,
) -> list[DeepMetricsResult]:
    """
    对嫌疑人执行深度采集：
    1. GetMetricData 采集深度指标（24h 均值）
    2. GetMetricStatistics 采集 7 天 CPU 峰值和连接数峰值
    3. UPDATE DynamoDB 记录，补充深度指标并标记 is_candidate=TRUE

    如果某个 Candidate 的深度采集失败，记录错误日志并跳过。
    """
    if not candidates:
        logger.info("No candidates for deep dive collection (%s)", resource_type)
        return []

    cw_client = clients["cloudwatch_client"]

    # 1. 采集深度指标
    deep_data = _collect_deep_metrics(cw_client, candidates, resource_type)

    # 2. 采集 7 天峰值
    peak_data = _collect_peak_metrics(cw_client, candidates, resource_type)

    # 3. 组装结果
    deep_results = _build_deep_metrics_results(
        candidates, resource_type, deep_data, peak_data,
    )

    # 4. UPDATE DynamoDB
    _update_deep_metrics_in_db(candidates, deep_results, resource_type)

    logger.info(
        "Deep dive collection completed for %d %s candidates",
        len(candidates), resource_type,
    )
    return deep_results

# ============================================================
# AI 巡检：全量实例深度指标采集（阶段三扩展）
# ============================================================

# 所有 RDS 实例的 AI 巡检深度指标 (metric_name, stat)
HEALTH_CHECK_DEEP_METRICS = [
    ("ReadThroughput", "Sum"),
    ("WriteThroughput", "Sum"),
    ("ReadIOPS", "Sum"),
    ("WriteIOPS", "Sum"),
    ("NetworkReceiveThroughput", "Sum"),
    ("NetworkTransmitThroughput", "Sum"),
]

# Aurora LogVolume 指标 (metric_name, stat)
AURORA_LOG_VOLUME_METRICS = [
    ("DiskQueueDepthLogVolume", "Maximum"),
    ("FreeStorageSpaceLogVolume", "Minimum"),
    ("ReadLatencyLogVolume", "Maximum"),
    ("ReadThroughputLogVolume", "Sum"),
    ("ReadIOPSLogVolume", "Sum"),
]


def _is_aurora_engine(engine: str) -> bool:
    """检测引擎类型是否为 Aurora（aurora-mysql 或 aurora-postgresql）。"""
    return engine.startswith("aurora-mysql") or engine.startswith("aurora-postgresql")


def _build_health_check_queries(
    instances: list[BaseMetricsResult],
) -> list[dict]:
    """
    构建 AI 巡检深度指标的 GetMetricData MetricDataQueries。
    对所有实例采集通用深度指标，对 Aurora 实例额外采集 LogVolume 指标。
    ID 格式: hc_{instance_index}_{metric_index}
    """
    namespace = NAMESPACE_MAP["rds"]
    dimension_name = DIMENSION_MAP["rds"]
    queries = []

    for i, instance in enumerate(instances):
        # 通用深度指标
        for j, (metric_name, stat) in enumerate(HEALTH_CHECK_DEEP_METRICS):
            query_id = f"hc_{i}_{j}"
            queries.append({
                "Id": query_id,
                "MetricStat": {
                    "Metric": {
                        "Namespace": namespace,
                        "MetricName": metric_name,
                        "Dimensions": [
                            {"Name": dimension_name, "Value": instance.instance_id}
                        ],
                    },
                    "Period": 86400,
                    "Stat": stat,
                },
                "ReturnData": True,
            })

        # Aurora LogVolume 指标
        if _is_aurora_engine(instance.engine):
            base_offset = len(HEALTH_CHECK_DEEP_METRICS)
            for k, (metric_name, stat) in enumerate(AURORA_LOG_VOLUME_METRICS):
                query_id = f"hc_{i}_{base_offset + k}"
                queries.append({
                    "Id": query_id,
                    "MetricStat": {
                        "Metric": {
                            "Namespace": namespace,
                            "MetricName": metric_name,
                            "Dimensions": [
                                {"Name": dimension_name, "Value": instance.instance_id}
                            ],
                        },
                        "Period": 86400,
                        "Stat": stat,
                    },
                    "ReturnData": True,
                })

    return queries


def _collect_health_check_metrics(
    cw_client,
    instances: list[BaseMetricsResult],
) -> dict[int, dict[int, float | None]]:
    """
    调用 GetMetricData 采集 AI 巡检深度指标。
    返回 {instance_index: {metric_index: value}} 的映射。
    """
    if not instances:
        return {}

    # 计算每个实例的最大指标数（Aurora 实例有更多指标）
    max_metrics_per_instance = len(HEALTH_CHECK_DEEP_METRICS) + len(AURORA_LOG_VOLUME_METRICS)
    instances_per_batch = BATCH_SIZE // max_metrics_per_instance

    now = datetime.now(timezone.utc)
    start_time = now - timedelta(hours=24)

    all_results: dict[int, dict[int, float | None]] = {}

    for batch_start in range(0, len(instances), instances_per_batch):
        batch = instances[batch_start:batch_start + instances_per_batch]
        queries = _build_health_check_queries(batch)

        if not queries:
            continue

        try:
            response = cw_client.get_metric_data(
                MetricDataQueries=queries,
                StartTime=start_time,
                EndTime=now,
            )
        except Exception as e:
            logger.error(
                "Health check deep metrics GetMetricData failed for batch starting at %d: %s",
                batch_start, e,
            )
            continue

        for result in response.get("MetricDataResults", []):
            query_id = result["Id"]  # hc_{i}_{j}
            parts = query_id.split("_")
            instance_idx = int(parts[1]) + batch_start
            metric_idx = int(parts[2])
            values = result.get("Values", [])
            value = values[0] if values else None

            if instance_idx not in all_results:
                all_results[instance_idx] = {}
            all_results[instance_idx][metric_idx] = value

    return all_results


def _update_health_check_metrics_in_db(
    instances: list[BaseMetricsResult],
    metrics_data: dict[int, dict[int, float | None]],
    peak_data: dict[int, dict[str, float | None]] | None = None,
) -> int:
    """
    将 AI 巡检深度指标 UPDATE 到 DynamoDB metrics 表。
    返回更新的行数。
    """
    if not instances:
        return 0

    if peak_data is None:
        peak_data = {}

    base_offset = len(HEALTH_CHECK_DEEP_METRICS)
    updated = 0

    for i, instance in enumerate(instances):
        metrics = metrics_data.get(i, {})
        is_aurora = _is_aurora_engine(instance.engine)

        # 通用深度指标
        read_throughput_sum = metrics.get(0)
        write_throughput_sum = metrics.get(1)
        read_iops_sum = metrics.get(2)
        write_iops_sum = metrics.get(3)
        network_in_sum = metrics.get(4)
        network_out_sum = metrics.get(5)

        # Aurora LogVolume 指标（非 Aurora 实例为 NULL）
        if is_aurora:
            disk_queue_depth_log_volume_max = metrics.get(base_offset + 0)
            free_storage_log_volume_min = metrics.get(base_offset + 1)
            read_latency_log_volume_max = metrics.get(base_offset + 2)
            read_throughput_log_volume_sum = metrics.get(base_offset + 3)
            read_iops_log_volume_sum = metrics.get(base_offset + 4)
        else:
            disk_queue_depth_log_volume_max = None
            free_storage_log_volume_min = None
            read_latency_log_volume_max = None
            read_throughput_log_volume_sum = None
            read_iops_log_volume_sum = None

        # 7 天峰值
        peaks = peak_data.get(i, {})
        peak_cpu = peaks.get("peak_cpu")
        peak_connections = peaks.get("peak_connections")
        peak_connections_int = int(peak_connections) if peak_connections is not None else None

        fields = {
            "read_throughput_sum": read_throughput_sum,
            "write_throughput_sum": write_throughput_sum,
            "read_iops_sum": read_iops_sum,
            "write_iops_sum": write_iops_sum,
            "network_in_sum": network_in_sum,
            "network_out_sum": network_out_sum,
            "disk_queue_depth_log_volume_max": disk_queue_depth_log_volume_max,
            "free_storage_log_volume_min": free_storage_log_volume_min,
            "read_latency_log_volume_max": read_latency_log_volume_max,
            "read_throughput_log_volume_sum": read_throughput_log_volume_sum,
            "read_iops_log_volume_sum": read_iops_log_volume_sum,
            "peak_cpu_7d": peak_cpu,
            "peak_connections_7d": peak_connections_int,
            "engine_version": instance.engine_version,
        }

        # Remove None values to avoid overwriting existing data with empty
        fields = {k: v for k, v in fields.items() if v is not None}

        date_str = instance.monitoring_date if isinstance(instance.monitoring_date, str) else instance.monitoring_date.isoformat()

        update_monitoring_fields(
            "rds",
            instance.instance_id,
            instance.account_id,
            date_str,
            fields,
        )
        updated += 1

    logger.info(
        "Updated %d RDS records with health check deep metrics",
        updated,
    )
    return updated


def health_check_deep_dive(
    clients: dict,
    all_rds_metrics: list[BaseMetricsResult],
) -> int:
    """
    对所有 RDS 实例执行 AI 巡检深度指标采集：
    1. 对所有实例采集通用深度指标（ReadThroughput, WriteThroughput, ReadIOPS, WriteIOPS,
       NetworkReceiveThroughput, NetworkTransmitThroughput）
    2. 对 Aurora 实例额外采集 LogVolume 指标
    3. 对所有实例采集 7 天 CPU 峰值和连接数峰值
    4. UPDATE DynamoDB metrics 表对应新增列

    保留现有候选实例深度采集逻辑不变，本函数独立运行。
    返回更新的记录数。
    """
    if not all_rds_metrics:
        logger.info("No RDS instances for health check deep dive")
        return 0

    cw_client = clients["cloudwatch_client"]

    aurora_count = sum(1 for m in all_rds_metrics if _is_aurora_engine(m.engine))
    logger.info(
        "Health check deep dive: %d total RDS instances (%d Aurora)",
        len(all_rds_metrics), aurora_count,
    )

    # 1. 采集 AI 巡检深度指标（GetMetricData 批量）
    metrics_data = _collect_health_check_metrics(cw_client, all_rds_metrics)

    # 2. 采集 7 天峰值（GetMetricStatistics 逐实例）
    peak_data = _collect_peak_metrics(cw_client, all_rds_metrics, "rds")

    # 3. UPDATE DynamoDB
    updated = _update_health_check_metrics_in_db(all_rds_metrics, metrics_data, peak_data)

    logger.info(
        "Health check deep dive completed: %d records updated",
        updated,
    )
    return updated
