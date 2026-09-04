"""
Lambda1-Collector 主入口。
遍历目标账户和 Region，顺序执行阶段一至三（资源发现、海选采集、精选采集），
完成后异步调用 Lambda2-Analyzer，并记录执行历史。
包含超时保护：每个阶段开始前检查剩余时间，不足 2 分钟则提前终止。
"""

import json
import logging
import os
import time
from datetime import datetime, timezone, date

import boto3

from lambda1_collector.accounts import (
    load_target_accounts,
    assume_role,
    create_clients,
)
from lambda1_collector.discovery import (
    discover_rds_instances,
    discover_elasticache_clusters,
    discover_replication_groups,
)
from lambda1_collector.whitelist import load_whitelist, filter_whitelist
from lambda1_collector.threshold import load_threshold_configs
from lambda1_collector.metrics_collector import batch_get_base_metrics
from lambda1_collector.ingestion import bulk_insert_monitoring_data
from lambda1_collector.deep_dive import identify_candidates, deep_dive_collection, health_check_deep_dive
from lambda1_collector.ec2_trusted_advisor import collect_ec2_trusted_advisor
from shared.queries.execution import record_execution

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# 超时保护阈值：剩余时间低于此值（毫秒）时提前终止
TIMEOUT_THRESHOLD_MS = 120_000  # 2 分钟

# Lambda2 函数名（从环境变量读取）
LAMBDA2_FUNCTION_NAME = os.environ.get("LAMBDA2_FUNCTION_NAME", "lambda2-analyzer")


def _create_local_clients(region: str) -> dict:
    """部署账号无需 AssumeRole,用 Lambda 执行角色直接创建客户端。"""
    return {
        "rds_client": boto3.client("rds", region_name=region),
        "elasticache_client": boto3.client("elasticache", region_name=region),
        "cloudwatch_client": boto3.client("cloudwatch", region_name=region),
        "region": region,
    }


def _check_timeout(context, phase_name: str) -> bool:
    """
    检查 Lambda 剩余执行时间是否充足。
    返回 True 表示应该继续执行，False 表示应提前终止。
    如果 context 为 None（本地测试），始终返回 True。
    """
    if context is None:
        return True

    remaining_ms = context.get_remaining_time_in_millis()
    if remaining_ms < TIMEOUT_THRESHOLD_MS:
        logger.warning(
            "Timeout protection: only %dms remaining before phase '%s', stopping early",
            remaining_ms,
            phase_name,
        )
        return False

    logger.debug(
        "Timeout check OK: %dms remaining before phase '%s'",
        remaining_ms,
        phase_name,
    )
    return True


def _invoke_lambda2() -> None:
    """异步调用 Lambda2-Analyzer（InvocationType=Event）。"""
    try:
        lambda_client = boto3.client("lambda")
        response = lambda_client.invoke(
            FunctionName=LAMBDA2_FUNCTION_NAME,
            InvocationType="Event",
            Payload=json.dumps({"source": "lambda1_collector"}),
        )
        status_code = response.get("StatusCode", 0)
        logger.info(
            "Lambda2 invoked asynchronously, status code: %d", status_code
        )
    except Exception as e:
        logger.error("Failed to invoke Lambda2: %s", e)
        raise


def _write_execution_history(
    status: str,
    stats: dict,
    error_message: str | None,
    start_time: float,
) -> None:
    """将执行历史记录写入 DynamoDB config 表。"""
    duration_seconds = int(time.time() - start_time)
    try:
        record_execution(
            phase="collection",
            status=status,
            execution_date=datetime.now(timezone.utc).isoformat(),
            total_discovered=stats.get("total_discovered", 0),
            total_after_whitelist=stats.get("total_after_whitelist", 0),
            total_candidates=stats.get("total_candidates", 0),
            total_idle=0,  # Lambda2 填写
            accounts_processed=stats.get("accounts_processed", 0),
            regions_processed=stats.get("regions_processed", 0),
            ec2_discovered=stats.get("ec2_discovered", 0),
            ec2_after_whitelist=stats.get("ec2_after_whitelist", 0),
            error_message=error_message,
            duration_seconds=duration_seconds,
        )
        logger.info("Execution history recorded: status=%s, duration=%ds", status, duration_seconds)
    except Exception as e:
        logger.error("Failed to write execution history: %s", e)


def handler(event: dict, context) -> dict:
    """
    Lambda1-Collector 主入口。
    遍历目标账户和 Region，顺序执行阶段一至三，
    完成后异步调用 Lambda2 并记录执行历史。
    """
    start_time = time.time()
    stats = {
        "total_discovered": 0,
        "total_after_whitelist": 0,
        "total_candidates": 0,
        "accounts_processed": 0,
        "regions_processed": 0,
    }
    timed_out = False

    try:
        # 加载目标账户和阈值配置
        accounts = load_target_accounts()
        threshold_configs = load_threshold_configs()

        logger.info("Loaded %d target accounts", len(accounts))

        for account in accounts:
            # 超时保护：检查是否有足够时间处理下一个账户
            if not _check_timeout(context, f"account {account.account_id}"):
                timed_out = True
                break

            # STS AssumeRole — 部署账号(role_arn 为空)跳过,用 Lambda 自身角色
            if account.role_arn:
                credentials = assume_role(account.role_arn, account.account_id)
                if credentials is None:
                    logger.warning(
                        "Skipping account %s: AssumeRole failed", account.account_id
                    )
                    continue
            else:
                credentials = None

            stats["accounts_processed"] += 1

            for region in account.regions:
                # 超时保护：检查是否有足够时间处理下一个 Region
                if not _check_timeout(context, f"region {region} in account {account.account_id}"):
                    timed_out = True
                    break

                logger.info(
                    "Processing account %s, region %s",
                    account.account_id, region,
                )

                if credentials:
                    clients = create_clients(credentials, region)
                else:
                    clients = _create_local_clients(region)

                # ── 阶段一：资源发现与预过滤 ──
                if not _check_timeout(context, "phase1-discovery"):
                    timed_out = True
                    break

                rds_instances = discover_rds_instances(clients)
                elasticache_clusters, node_endpoint_map = discover_elasticache_clusters(clients)

                # 获取复制组拓扑映射
                topology_map = discover_replication_groups(clients, node_endpoint_map)

                # 用拓扑映射填充 ElastiCache 节点的拓扑字段
                for inst in elasticache_clusters:
                    if inst.engine and inst.engine.lower() == "memcached":
                        continue
                    topo_info = topology_map.get(inst.instance_id)
                    if topo_info is not None:
                        inst.replication_group_id = topo_info.get("replication_group_id")
                        inst.node_role = topo_info.get("node_role")
                        inst.shard_id = topo_info.get("shard_id")
                        inst.cluster_enabled = topo_info.get("cluster_enabled")
                        inst.num_shards = topo_info.get("num_shards")
                        inst.num_replicas_per_shard = topo_info.get("num_replicas_per_shard")
                        inst.multi_az = topo_info.get("multi_az")
                        inst.automatic_failover = topo_info.get("automatic_failover")

                # 设置 account_id
                for inst in rds_instances:
                    inst.account_id = account.account_id
                for inst in elasticache_clusters:
                    inst.account_id = account.account_id

                whitelist = load_whitelist()
                rds_targets = filter_whitelist(rds_instances, whitelist)
                ec_targets = filter_whitelist(elasticache_clusters, whitelist)

                discovered_count = len(rds_instances) + len(elasticache_clusters)
                after_whitelist_count = len(rds_targets) + len(ec_targets)
                stats["total_discovered"] += discovered_count
                stats["total_after_whitelist"] += after_whitelist_count

                logger.info(
                    "Phase 1 complete: discovered=%d, after_whitelist=%d",
                    discovered_count, after_whitelist_count,
                )

                # ── 阶段二：海选采集与全量入库 ──
                if not _check_timeout(context, "phase2-base-metrics"):
                    timed_out = True
                    break

                rds_metrics = batch_get_base_metrics(clients, rds_targets, "rds")
                ec_metrics = batch_get_base_metrics(clients, ec_targets, "elasticache")
                bulk_insert_monitoring_data(
                    rds_metrics, ec_metrics, account.account_id, region
                )

                logger.info(
                    "Phase 2 complete: rds_metrics=%d, ec_metrics=%d",
                    len(rds_metrics), len(ec_metrics),
                )

                # ── 阶段三：精选采集 ──
                if not _check_timeout(context, "phase3-deep-dive"):
                    timed_out = True
                    break

                rds_candidates = identify_candidates(rds_metrics, threshold_configs)
                ec_candidates = identify_candidates(ec_metrics, threshold_configs)
                deep_dive_collection(clients, rds_candidates, "rds")
                deep_dive_collection(clients, ec_candidates, "elasticache")

                candidates_count = len(rds_candidates) + len(ec_candidates)
                stats["total_candidates"] += candidates_count

                # ── 阶段三扩展：AI 巡检全量 RDS 深度指标采集 ──
                if _check_timeout(context, "phase3-health-check-deep-dive"):
                    health_check_deep_dive(clients, rds_metrics)
                else:
                    logger.warning("Skipping health check deep dive due to timeout")

                stats["regions_processed"] += 1

                logger.info(
                    "Phase 3 complete: candidates=%d", candidates_count
                )

            # 如果内层循环因超时退出，外层也退出
            if timed_out:
                break

        # ── EC2 Trusted Advisor 采集阶段 ──
        if timed_out:
            logger.warning("Skipping EC2 Trusted Advisor collection due to timeout")
        elif not _check_timeout(context, "ec2-trusted-advisor"):
            timed_out = True
        else:
            try:
                ec2_stats = collect_ec2_trusted_advisor(context)
                stats["ec2_discovered"] = ec2_stats.get("ec2_discovered", 0)
                stats["ec2_after_whitelist"] = ec2_stats.get("ec2_after_whitelist", 0)
            except Exception as e:
                logger.error("EC2 Trusted Advisor collection failed: %s", e, exc_info=True)
                # EC2 采集失败不影响 RDS/ElastiCache 的正常流程

        # 确定最终状态
        if timed_out:
            status = "completed"  # 部分完成仍视为 completed（已处理的数据有效）
            error_msg = "Execution stopped early due to timeout protection"
            logger.warning(error_msg)
        else:
            status = "completed"
            error_msg = None

        # 异步调用 Lambda2（仅在非超时或有数据处理时）
        if not timed_out and stats["accounts_processed"] > 0:
            _invoke_lambda2()
        elif timed_out:
            logger.warning("Skipping Lambda2 invocation due to timeout")

        # 记录执行历史
        _write_execution_history(status, stats, error_msg, start_time)

        return {
            "status": status,
            "stats": stats,
            "timed_out": timed_out,
        }

    except Exception as e:
        logger.error("Lambda1 execution failed: %s", e, exc_info=True)
        _write_execution_history("failed", stats, str(e), start_time)
        return {
            "status": "failed",
            "stats": stats,
            "error": str(e),
        }
