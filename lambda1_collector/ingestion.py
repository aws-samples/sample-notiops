"""
全量入库模块。
批量写入监控数据到 DynamoDB metrics 表，
使用 put_monitoring_batch 的 PutItem 语义实现幂等。
"""

import logging
from datetime import date

from shared.queries.metrics import put_monitoring_batch
from lambda1_collector.metrics_collector import BaseMetricsResult

logger = logging.getLogger(__name__)


def _rds_metric_to_dict(m: BaseMetricsResult, account_id: str, region: str) -> dict:
    """将 RDS BaseMetricsResult 转为 DynamoDB 行 dict。"""
    return {
        "instance": m.instance_id,
        "account": account_id,
        "region": region,
        "date": m.monitoring_date if isinstance(m.monitoring_date, str) else m.monitoring_date.isoformat(),
        "instance_class": m.instance_class,
        "engine": m.engine,
        "cpu_utilization": m.cpu_utilization,
        "connections": m.connections,
        "free_storage": m.free_storage_or_memory,
        "write_iops_avg": m.write_iops_avg,
        "cpu_max": m.cpu_max,
        "allocated_storage_gb": m.allocated_storage_gb,
        "freeable_memory_min": m.freeable_memory_min,
        "disk_queue_depth_max": m.disk_queue_depth_max,
        "ebs_byte_balance_min": m.ebs_byte_balance_min,
        "read_latency_max": m.read_latency_max,
        "write_latency_max": m.write_latency_max,
        "connections_max": m.connections_max,
        "is_candidate": False,
        "cand_flag": 0,
    }


def _ec_metric_to_dict(m: BaseMetricsResult, account_id: str, region: str) -> dict:
    """将 ElastiCache BaseMetricsResult 转为 DynamoDB 行 dict。"""
    return {
        "instance": m.instance_id,
        "account": account_id,
        "region": region,
        "date": m.monitoring_date if isinstance(m.monitoring_date, str) else m.monitoring_date.isoformat(),
        "instance_class": m.instance_class,
        "engine": m.engine,
        "cpu_utilization": m.cpu_utilization,
        "connections": m.connections,
        "memory_usage_pct": m.free_storage_or_memory,
        "cache_hits": m.cache_hits,
        "cache_misses": m.cache_misses,
        "replication_lag": m.replication_lag,
        "num_cache_nodes": m.num_cache_nodes,
        "nw_bw_in_exceeded": m.nw_bw_in_exceeded,
        "nw_bw_out_exceeded": m.nw_bw_out_exceeded,
        # AI 巡检新增 13 列
        "freeable_memory_min": m.freeable_memory_min,
        "curr_connections_max": m.curr_connections_max,
        "memory_usage_pct_max": m.memory_usage_pct_max,
        "bytes_used_for_cache_max": m.bytes_used_for_cache_max,
        "swap_usage_max": m.swap_usage_max,
        "new_connections_sum": m.new_connections_sum,
        "capacity_usage_pct_max": m.capacity_usage_pct_max,
        "curr_items_max": m.curr_items_max,
        "memory_fragmentation_ratio_max": m.memory_fragmentation_ratio_max,
        "cpu_utilization_max": m.cpu_utilization_max,
        "evictions_sum": m.evictions_sum,
        "network_bytes_in_sum": m.network_bytes_in_sum,
        "network_bytes_out_sum": m.network_bytes_out_sum,
        # 集群拓扑 9 列
        "replication_group_id": m.replication_group_id,
        "node_role": m.node_role,
        "shard_id": m.shard_id,
        "cluster_enabled": m.cluster_enabled,
        "num_shards": m.num_shards,
        "num_replicas_per_shard": m.num_replicas_per_shard,
        "multi_az": m.multi_az,
        "automatic_failover": m.automatic_failover,
        "engine_version": m.engine_version,
        "is_candidate": False,
        "cand_flag": 0,
    }


def bulk_insert_monitoring_data(
    rds_metrics: list[BaseMetricsResult],
    ec_metrics: list[BaseMetricsResult],
    account_id: str,
    region: str,
) -> dict:
    """
    批量写入 RDS 和 ElastiCache 监控数据。
    返回写入统计 {"rds_count": N, "ec_count": N}。
    """
    rds_count = 0
    ec_count = 0

    if rds_metrics:
        rds_rows = [
            {k: v for k, v in _rds_metric_to_dict(m, account_id, region).items() if v is not None}
            for m in rds_metrics
        ]
        rds_count = put_monitoring_batch("rds", rds_rows)
        logger.info("Inserted/updated %d RDS monitoring records", rds_count)

    if ec_metrics:
        ec_rows = [
            {k: v for k, v in _ec_metric_to_dict(m, account_id, region).items() if v is not None}
            for m in ec_metrics
        ]
        ec_count = put_monitoring_batch("elasticache", ec_rows)
        logger.info("Inserted/updated %d ElastiCache monitoring records", ec_count)

    return {"rds_count": rds_count, "ec_count": ec_count}
