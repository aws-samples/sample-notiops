"""
海选采集模块。
分批调用 CloudWatch GetMetricData 采集基础指标（24h 均值），
支持 RDS 和 ElastiCache 不同的指标名称映射。
"""

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from lambda1_collector.discovery import InstanceMetadata

logger = logging.getLogger(__name__)

# 每批最多 500 个 MetricDataQuery
BATCH_SIZE = 500

# RDS 基础指标 (metric_name, stat)
RDS_BASE_METRICS = [
    ("CPUUtilization", "Average"),
    ("CPUUtilization", "Maximum"),           # 🆕
    ("DatabaseConnections", "Average"),
    ("FreeStorageSpace", "Average"),
    ("FreeStorageSpace", "Maximum"),          # 🆕 for capacity audit
    ("WriteIOPS", "Average"),                 # 🆕
    # 🆕 AI 巡检新增指标
    ("FreeableMemory", "Minimum"),
    ("DiskQueueDepth", "Maximum"),
    ("EBSByteBalance%", "Minimum"),
    ("ReadLatency", "Maximum"),
    ("WriteLatency", "Maximum"),
    ("DatabaseConnections", "Maximum"),
]

# ElastiCache 基础指标 (metric_name, stat)
ELASTICACHE_BASE_METRICS = [
    # --- 原有 11 个指标 (indices 0-10) ---
    ("EngineCPUUtilization", "Average"),                    # 0
    ("EngineCPUUtilization", "Maximum"),                    # 1
    ("CurrConnections", "Average"),                         # 2
    ("DatabaseMemoryUsagePercentage", "Average"),           # 3
    ("CacheHits", "Sum"),                                   # 4
    ("CacheMisses", "Sum"),                                 # 5
    ("ReplicationLag", "Maximum"),                          # 6
    ("BytesUsedForCache", "Average"),                       # 7
    ("SwapUsage", "Average"),                               # 8
    ("NetworkBandwidthInAllowanceExceeded", "Sum"),         # 9
    ("NetworkBandwidthOutAllowanceExceeded", "Sum"),        # 10
    # --- 🆕 AI 巡检新增 10 个指标 (indices 11-20) ---
    ("FreeableMemory", "Minimum"),                          # 11
    ("CurrConnections", "Maximum"),                         # 12
    ("DatabaseMemoryUsagePercentage", "Maximum"),           # 13
    ("BytesUsedForCache", "Maximum"),                       # 14
    ("SwapUsage", "Maximum"),                               # 15
    ("NewConnections", "Sum"),                              # 16
    ("DatabaseCapacityUsagePercentage", "Maximum"),         # 17
    ("CurrItems", "Maximum"),                               # 18
    ("MemoryFragmentationRatio", "Maximum"),                # 19
    ("CPUUtilization", "Maximum"),                          # 20
    # --- 🆕 从深度指标升级为基础指标 (indices 21-23) ---
    ("Evictions", "Sum"),                                   # 21
    ("NetworkBytesIn", "Sum"),                              # 22
    ("NetworkBytesOut", "Sum"),                              # 23
]

# CloudWatch Namespace 映射
NAMESPACE_MAP = {
    "rds": "AWS/RDS",
    "elasticache": "AWS/ElastiCache",
}

# CloudWatch Dimension 名称映射
DIMENSION_MAP = {
    "rds": "DBInstanceIdentifier",
    "elasticache": "CacheClusterId",
}


@dataclass
class BaseMetricsResult:
    instance_id: str
    resource_type: str
    instance_class: str
    engine: str
    account_id: str
    region: str
    monitoring_date: date
    cpu_utilization: float | None
    connections: int | None
    free_storage_or_memory: float | None
    # 保留原始 tags 用于后续阈值匹配
    tags: dict[str, str] | None = None
    # 🆕 新增字段
    cpu_max: float | None = None
    write_iops_avg: float | None = None
    cache_hits: float | None = None
    cache_misses: float | None = None
    replication_lag: float | None = None
    allocated_storage_gb: float | None = None
    num_cache_nodes: int | None = None
    free_storage_max: float | None = None       # RDS FreeStorageSpace Max
    bytes_used_for_cache: float | None = None   # ElastiCache
    swap_usage: float | None = None             # ElastiCache
    engine_cpu_max: float | None = None         # ElastiCache EngineCPUUtilization Max
    nw_bw_in_exceeded: float | None = None      # ElastiCache NetworkBandwidthInAllowanceExceeded
    nw_bw_out_exceeded: float | None = None     # ElastiCache NetworkBandwidthOutAllowanceExceeded
    # 🆕 AI 巡检新增字段 (RDS)
    freeable_memory_min: float | None = None    # FreeableMemory Minimum (also used by ElastiCache)
    disk_queue_depth_max: float | None = None   # DiskQueueDepth Maximum
    ebs_byte_balance_min: float | None = None   # EBSByteBalance% Minimum
    read_latency_max: float | None = None       # ReadLatency Maximum
    write_latency_max: float | None = None      # WriteLatency Maximum
    connections_max: int | None = None           # DatabaseConnections Maximum
    engine_version: str | None = None           # RDS engine version
    # 🆕 ElastiCache AI 巡检新增字段
    curr_connections_max: int | None = None              # CurrConnections Maximum
    memory_usage_pct_max: float | None = None            # DatabaseMemoryUsagePercentage Maximum
    bytes_used_for_cache_max: float | None = None        # BytesUsedForCache Maximum
    swap_usage_max: float | None = None                  # SwapUsage Maximum
    new_connections_sum: float | None = None              # NewConnections Sum
    capacity_usage_pct_max: float | None = None          # DatabaseCapacityUsagePercentage Maximum
    curr_items_max: int | None = None                    # CurrItems Maximum
    memory_fragmentation_ratio_max: float | None = None  # MemoryFragmentationRatio Maximum
    cpu_utilization_max: float | None = None             # CPUUtilization Maximum
    evictions_sum: int | None = None                     # Evictions Sum (升级为基础)
    network_bytes_in_sum: float | None = None            # NetworkBytesIn Sum (升级为基础)
    network_bytes_out_sum: float | None = None           # NetworkBytesOut Sum (升级为基础)
    # 🆕 集群拓扑字段
    replication_group_id: str | None = None
    node_role: str | None = None
    shard_id: str | None = None
    cluster_enabled: bool | None = None
    num_shards: int | None = None
    num_replicas_per_shard: int | None = None
    multi_az: str | None = None
    automatic_failover: str | None = None


def _get_metric_names(resource_type: str) -> list[tuple[str, str]]:
    """根据资源类型返回对应的基础指标 (metric_name, stat) 列表。"""
    if resource_type == "rds":
        return RDS_BASE_METRICS
    elif resource_type == "elasticache":
        return ELASTICACHE_BASE_METRICS
    else:
        raise ValueError(f"Unknown resource_type: {resource_type}")


def _build_metric_queries(
    instances: list[InstanceMetadata],
    resource_type: str,
) -> list[dict]:
    """
    构建 GetMetricData 的 MetricDataQueries 参数。
    每个实例多个指标，ID 格式: m_{instance_index}_{metric_index}
    """
    metric_tuples = _get_metric_names(resource_type)
    namespace = NAMESPACE_MAP[resource_type]
    dimension_name = DIMENSION_MAP[resource_type]
    queries = []

    for i, instance in enumerate(instances):
        for j, (metric_name, stat) in enumerate(metric_tuples):
            query_id = f"m_{i}_{j}"
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
                    "Period": 86400,  # 24 小时
                    "Stat": stat,
                },
                "ReturnData": True,
            })

    return queries


def batch_get_base_metrics(
    clients: dict,
    targets: list[InstanceMetadata],
    resource_type: str,
) -> list[BaseMetricsResult]:
    """
    分批调用 GetMetricData 采集基础指标。
    每个实例 3 个指标，每批最多 500 个 MetricDataQuery（约 166 个实例）。
    时间范围：过去 24 小时，统计方式：Average，周期：86400 秒。
    """
    if not targets:
        return []

    cw_client = clients["cloudwatch_client"]
    metric_tuples = _get_metric_names(resource_type)
    metrics_per_instance = len(metric_tuples)
    instances_per_batch = BATCH_SIZE // metrics_per_instance

    now = datetime.now(timezone.utc)
    start_time = now - timedelta(hours=24)
    today = now.date()

    all_results = []

    # 分批处理
    for batch_start in range(0, len(targets), instances_per_batch):
        batch_instances = targets[batch_start:batch_start + instances_per_batch]
        queries = _build_metric_queries(batch_instances, resource_type)

        # 调用 GetMetricData
        try:
            response = cw_client.get_metric_data(
                MetricDataQueries=queries,
                StartTime=start_time,
                EndTime=now,
            )
        except Exception as e:
            logger.error(
                "GetMetricData failed for batch starting at %d: %s",
                batch_start, e,
            )
            continue

        # 解析结果，按实例索引组织
        metric_results = {}
        for result in response.get("MetricDataResults", []):
            query_id = result["Id"]  # m_{i}_{j}
            parts = query_id.split("_")
            instance_idx = int(parts[1])
            metric_idx = int(parts[2])
            values = result.get("Values", [])
            value = values[0] if values else None
            if instance_idx not in metric_results:
                metric_results[instance_idx] = {}
            metric_results[instance_idx][metric_idx] = value

        # 构建 BaseMetricsResult
        for i, instance in enumerate(batch_instances):
            values = metric_results.get(i, {})

            if resource_type == "rds":
                # RDS 指标顺序: CPUUtilization Avg(0), CPUUtilization Max(1),
                # DatabaseConnections Avg(2), FreeStorageSpace Avg(3),
                # FreeStorageSpace Max(4), WriteIOPS Avg(5),
                # FreeableMemory Min(6), DiskQueueDepth Max(7),
                # EBSByteBalance% Min(8), ReadLatency Max(9),
                # WriteLatency Max(10), DatabaseConnections Max(11)
                cpu = values.get(0)
                cpu_max_val = values.get(1)
                connections_val = values.get(2)
                storage_or_memory = values.get(3)
                free_storage_max_val = values.get(4)
                write_iops_val = values.get(5)
                freeable_memory_min_val = values.get(6)
                disk_queue_depth_max_val = values.get(7)
                ebs_byte_balance_min_val = values.get(8)
                read_latency_max_val = values.get(9)
                write_latency_max_val = values.get(10)
                connections_max_val = values.get(11)

                all_results.append(
                    BaseMetricsResult(
                        instance_id=instance.instance_id,
                        resource_type=resource_type,
                        instance_class=instance.instance_class,
                        engine=instance.engine,
                        account_id=instance.account_id,
                        region=instance.region,
                        monitoring_date=today,
                        cpu_utilization=cpu,
                        connections=int(connections_val) if connections_val is not None else None,
                        free_storage_or_memory=storage_or_memory,
                        tags=instance.tags,
                        cpu_max=cpu_max_val,
                        write_iops_avg=write_iops_val,
                        allocated_storage_gb=instance.allocated_storage_gb,
                        free_storage_max=free_storage_max_val,
                        freeable_memory_min=freeable_memory_min_val,
                        disk_queue_depth_max=disk_queue_depth_max_val,
                        ebs_byte_balance_min=ebs_byte_balance_min_val,
                        read_latency_max=read_latency_max_val,
                        write_latency_max=write_latency_max_val,
                        connections_max=int(connections_max_val) if connections_max_val is not None else None,
                        engine_version=instance.engine_version,
                    )
                )
            else:  # elasticache
                # ElastiCache 指标顺序 (24 个指标):
                # --- 原有 11 个 (indices 0-10) ---
                # EngineCPUUtilization Avg(0), EngineCPUUtilization Max(1),
                # CurrConnections Avg(2), DatabaseMemoryUsagePercentage Avg(3),
                # CacheHits Sum(4), CacheMisses Sum(5), ReplicationLag Max(6),
                # BytesUsedForCache Avg(7), SwapUsage Avg(8),
                # NetworkBandwidthInAllowanceExceeded Sum(9), NetworkBandwidthOutAllowanceExceeded Sum(10)
                # --- 新增 10 个 (indices 11-20) ---
                # FreeableMemory Min(11), CurrConnections Max(12),
                # DatabaseMemoryUsagePercentage Max(13), BytesUsedForCache Max(14),
                # SwapUsage Max(15), NewConnections Sum(16),
                # DatabaseCapacityUsagePercentage Max(17), CurrItems Max(18),
                # MemoryFragmentationRatio Max(19), CPUUtilization Max(20)
                # --- 升级深度指标 (indices 21-23) ---
                # Evictions Sum(21), NetworkBytesIn Sum(22), NetworkBytesOut Sum(23)
                cpu = values.get(0)
                engine_cpu_max_val = values.get(1)
                connections_val = values.get(2)
                storage_or_memory = values.get(3)
                cache_hits_val = values.get(4)
                cache_misses_val = values.get(5)
                replication_lag_val = values.get(6)
                bytes_used_val = values.get(7)
                swap_usage_val = values.get(8)
                nw_bw_in_exceeded_val = values.get(9)
                nw_bw_out_exceeded_val = values.get(10)
                # 🆕 新增指标
                freeable_memory_min_val = values.get(11)
                curr_connections_max_val = values.get(12)
                memory_usage_pct_max_val = values.get(13)
                bytes_used_for_cache_max_val = values.get(14)
                swap_usage_max_val = values.get(15)
                new_connections_sum_val = values.get(16)
                capacity_usage_pct_max_val = values.get(17)
                curr_items_max_val = values.get(18)
                memory_fragmentation_ratio_max_val = values.get(19)
                cpu_utilization_max_val = values.get(20)
                # 🆕 升级深度指标
                evictions_sum_val = values.get(21)
                network_bytes_in_sum_val = values.get(22)
                network_bytes_out_sum_val = values.get(23)

                all_results.append(
                    BaseMetricsResult(
                        instance_id=instance.instance_id,
                        resource_type=resource_type,
                        instance_class=instance.instance_class,
                        engine=instance.engine,
                        account_id=instance.account_id,
                        region=instance.region,
                        monitoring_date=today,
                        cpu_utilization=cpu,
                        connections=int(connections_val) if connections_val is not None else None,
                        free_storage_or_memory=storage_or_memory,
                        tags=instance.tags,
                        cache_hits=cache_hits_val,
                        cache_misses=cache_misses_val,
                        replication_lag=replication_lag_val,
                        num_cache_nodes=instance.num_cache_nodes,
                        bytes_used_for_cache=bytes_used_val,
                        swap_usage=swap_usage_val,
                        engine_cpu_max=engine_cpu_max_val,
                        nw_bw_in_exceeded=nw_bw_in_exceeded_val,
                        nw_bw_out_exceeded=nw_bw_out_exceeded_val,
                        # 🆕 AI 巡检新增字段
                        freeable_memory_min=freeable_memory_min_val,
                        curr_connections_max=int(curr_connections_max_val) if curr_connections_max_val is not None else None,
                        memory_usage_pct_max=memory_usage_pct_max_val,
                        bytes_used_for_cache_max=bytes_used_for_cache_max_val,
                        swap_usage_max=swap_usage_max_val,
                        new_connections_sum=new_connections_sum_val,
                        capacity_usage_pct_max=capacity_usage_pct_max_val,
                        curr_items_max=int(curr_items_max_val) if curr_items_max_val is not None else None,
                        memory_fragmentation_ratio_max=memory_fragmentation_ratio_max_val,
                        cpu_utilization_max=cpu_utilization_max_val,
                        evictions_sum=int(evictions_sum_val) if evictions_sum_val is not None else None,
                        network_bytes_in_sum=network_bytes_in_sum_val,
                        network_bytes_out_sum=network_bytes_out_sum_val,
                        # 🆕 拓扑字段传递
                        engine_version=instance.engine_version,
                        replication_group_id=instance.replication_group_id,
                        node_role=instance.node_role,
                        shard_id=instance.shard_id,
                        cluster_enabled=instance.cluster_enabled,
                        num_shards=instance.num_shards,
                        num_replicas_per_shard=instance.num_replicas_per_shard,
                        multi_az=instance.multi_az,
                        automatic_failover=instance.automatic_failover,
                    )
                )

    logger.info(
        "Collected base metrics for %d/%d %s instances",
        len(all_results), len(targets), resource_type,
    )
    return all_results
