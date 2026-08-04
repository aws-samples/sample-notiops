"""
Lambda2-Analyzer 主入口。
从数据库加载 Candidate 数据和阈值配置，执行判定流水线（峰值否决 → 隐形负载检查 → 增强版评分），
将结果写入 waste_report 表，并记录执行历史。
"""

import logging
import time
from datetime import date

from lambda2_analyzer.engine import (
    CandidateRecord,
    JudgmentResult,
    OptimizationResult,
    capacity_audit,
    peak_veto,
    hidden_load_check,
    calculate_enhanced_scores,
)
from lambda1_collector.threshold import load_threshold_configs
from shared.queries.metrics import query_candidates as _query_candidates_ddb
from shared.queries.waste_report import upsert_waste_report, upsert_report_summary
from shared.queries.optimization import upsert_optimization_report
from shared.queries.execution import record_execution

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Load candidates from DB
# ---------------------------------------------------------------------------

def _to_float(v, default=0.0) -> float:
    """Safely convert DynamoDB Decimal / str / None to float."""
    if v is None:
        return default
    return float(v)


def _to_int(v, default=0) -> int:
    """Safely convert DynamoDB Decimal / str / None to int."""
    if v is None:
        return default
    return int(v)


def _load_candidates_from_db() -> list[CandidateRecord]:
    """
    Load all candidates (is_candidate=TRUE, monitoring_date=today) from both
    rds and elasticache metric rows via DDB GSI1 query.
    """
    today_str = date.today().isoformat()
    candidates: list[CandidateRecord] = []

    # RDS candidates
    rds_rows = _query_candidates_ddb("rds", today_str, is_candidate=True)
    for row in rds_rows:
        candidates.append(
            CandidateRecord(
                instance_id=row["instance"],
                resource_type="rds",
                instance_class=row.get("instance_class", ""),
                engine=row.get("engine", ""),
                account_id=row["account"],
                region=row.get("region", ""),
                cpu_utilization=_to_float(row.get("cpu_utilization")),
                connections=_to_int(row.get("connections")),
                free_storage_or_memory=_to_float(row.get("free_storage")),
                read_iops=_to_float(row.get("read_iops"), None),
                write_iops=_to_float(row.get("write_iops"), None),
                network_in=_to_float(row.get("network_in"), None),
                network_out=_to_float(row.get("network_out"), None),
                evictions=None,
                peak_cpu_7d=_to_float(row.get("peak_cpu_7d"), None),
                peak_connections_7d=_to_int(row.get("peak_connections_7d"), None),
                write_iops_avg=_to_float(row.get("write_iops_avg"), None),
                cpu_max=_to_float(row.get("cpu_max"), None),
                allocated_storage_gb=_to_float(row.get("allocated_storage_gb"), None),
            )
        )

    # ElastiCache candidates
    ec_rows = _query_candidates_ddb("elasticache", today_str, is_candidate=True)
    for row in ec_rows:
        candidates.append(
            CandidateRecord(
                instance_id=row["instance"],
                resource_type="elasticache",
                instance_class=row.get("instance_class", ""),
                engine=row.get("engine", ""),
                account_id=row["account"],
                region=row.get("region", ""),
                cpu_utilization=_to_float(row.get("cpu_utilization")),
                connections=_to_int(row.get("connections")),
                free_storage_or_memory=_to_float(row.get("memory_usage_pct")),
                read_iops=None,
                write_iops=None,
                network_in=_to_float(row.get("network_in"), None),
                network_out=_to_float(row.get("network_out"), None),
                evictions=_to_int(row.get("evictions"), None),
                peak_cpu_7d=_to_float(row.get("peak_cpu_7d"), None),
                peak_connections_7d=_to_int(row.get("peak_connections_7d"), None),
                cache_hits=_to_float(row.get("cache_hits"), None),
                cache_misses=_to_float(row.get("cache_misses"), None),
                bytes_used_for_cache=_to_float(row.get("bytes_used_for_cache"), None),
                swap_usage=_to_float(row.get("swap_usage"), None),
                num_cache_nodes=_to_int(row.get("num_cache_nodes"), None),
            )
        )

    logger.info(
        "Loaded %d candidates from DB (rds=%d, elasticache=%d)",
        len(candidates), len(rds_rows), len(ec_rows),
    )
    return candidates


# ---------------------------------------------------------------------------
# Build excluded results for candidates filtered out by the pipeline
# ---------------------------------------------------------------------------

def _build_excluded_results(
    all_candidates: list[CandidateRecord],
    after_veto: list[CandidateRecord],
    after_hidden: list[CandidateRecord],
) -> list[JudgmentResult]:
    """
    Build JudgmentResult entries for candidates that were excluded during
    the peak_veto or hidden_load_check stages.
    """
    after_veto_ids = {c.instance_id for c in after_veto}
    after_hidden_ids = {c.instance_id for c in after_hidden}

    excluded: list[JudgmentResult] = []
    for c in all_candidates:
        if c.instance_id not in after_veto_ids:
            # Excluded by peak_veto
            excluded.append(
                JudgmentResult(
                    instance_id=c.instance_id,
                    account_id=c.account_id,
                    region=c.region,
                    is_idle=False,
                    exclusion_reason="peak_veto",
                    idle_score=None,
                    value_score=None,
                    estimated_monthly_savings=None,
                    consecutive_low_days=0,
                    resource_type=c.resource_type,
                    instance_class=c.instance_class,
                    engine=c.engine,
                    cpu_utilization=c.cpu_utilization,
                    connections=c.connections,
                    free_storage_or_memory=c.free_storage_or_memory,
                    peak_cpu_7d=c.peak_cpu_7d,
                    read_iops=c.read_iops,
                    write_iops=c.write_iops,
                    evictions=c.evictions,
                    allocated_storage_gb=c.allocated_storage_gb,
                    cache_hits=c.cache_hits,
                    cache_misses=c.cache_misses,
                )
            )
        elif c.instance_id not in after_hidden_ids:
            # Excluded by hidden_load_check
            if c.resource_type == "rds":
                reason = "io_intensive"
            else:
                reason = "memory_full"
            excluded.append(
                JudgmentResult(
                    instance_id=c.instance_id,
                    account_id=c.account_id,
                    region=c.region,
                    is_idle=False,
                    exclusion_reason=reason,
                    idle_score=None,
                    value_score=None,
                    estimated_monthly_savings=None,
                    consecutive_low_days=0,
                    resource_type=c.resource_type,
                    instance_class=c.instance_class,
                    engine=c.engine,
                    cpu_utilization=c.cpu_utilization,
                    connections=c.connections,
                    free_storage_or_memory=c.free_storage_or_memory,
                    peak_cpu_7d=c.peak_cpu_7d,
                    read_iops=c.read_iops,
                    write_iops=c.write_iops,
                    evictions=c.evictions,
                    allocated_storage_gb=c.allocated_storage_gb,
                    cache_hits=c.cache_hits,
                    cache_misses=c.cache_misses,
                )
            )

    return excluded


# ---------------------------------------------------------------------------
# Save results to waste_report table
# ---------------------------------------------------------------------------

def _save_results(results: list[JudgmentResult]) -> int:
    """
    Save all judgment results (idle + excluded) to the waste_report DDB table.
    Uses PutItem (idempotent upsert) per row. Also writes pre-aggregated summary.
    Returns the number of rows written.
    """
    if not results:
        return 0

    today_str = date.today().isoformat()
    count = 0

    for r in results:
        upsert_waste_report(
            account_id=r.account_id,
            date=today_str,
            instance_id=r.instance_id,
            region=r.region,
            resource_type=r.resource_type,
            instance_class=r.instance_class,
            engine=r.engine,
            is_idle=r.is_idle,
            exclusion_reason=r.exclusion_reason,
            idle_score=r.idle_score,
            value_score=r.value_score,
            savings=r.estimated_monthly_savings or 0.0,
            estimated_monthly_savings=r.estimated_monthly_savings or 0.0,
            consecutive_low_days=r.consecutive_low_days,
            cpu_utilization=r.cpu_utilization,
            connections=r.connections,
            free_storage_or_memory=r.free_storage_or_memory,
            peak_cpu_7d=r.peak_cpu_7d,
            read_iops=r.read_iops,
            write_iops=r.write_iops,
            evictions=r.evictions,
            allocated_storage_gb=r.allocated_storage_gb,
            cache_hits=r.cache_hits,
            cache_misses=r.cache_misses,
        )
        count += 1

    # Write pre-aggregated summary
    idle_items = [r for r in results if r.is_idle]
    idle_total = len(idle_items)
    idle_savings = sum(r.estimated_monthly_savings or 0.0 for r in idle_items)

    upsert_report_summary(today_str, idle_total=idle_total, idle_savings=idle_savings)

    logger.info("Saved %d results to waste_report table", count)
    return count


# ---------------------------------------------------------------------------
# Load non-candidates from DB (Path B)
# ---------------------------------------------------------------------------

def _load_non_candidates_from_db() -> list[dict]:
    """Load non-candidate records (is_candidate=FALSE, monitoring_date=today) for Path B."""
    today_str = date.today().isoformat()
    non_candidates: list[dict] = []

    # RDS non-candidates
    rds_rows = _query_candidates_ddb("rds", today_str, is_candidate=False)
    for row in rds_rows:
        non_candidates.append({
            "instance_id": row.get("instance", ""),
            "account_id": row.get("account", ""),
            "region": row.get("region", ""),
            "instance_class": row.get("instance_class", ""),
            "engine": row.get("engine", ""),
            "cpu_utilization": _to_float(row.get("cpu_utilization"), None),
            "connections": _to_int(row.get("connections"), None),
            "free_storage": _to_float(row.get("free_storage"), None),
            "write_iops_avg": _to_float(row.get("write_iops_avg"), None),
            "cpu_max": _to_float(row.get("cpu_max"), None),
            "allocated_storage_gb": _to_float(row.get("allocated_storage_gb"), None),
            "resource_type": "rds",
        })

    # ElastiCache non-candidates
    ec_rows = _query_candidates_ddb("elasticache", today_str, is_candidate=False)
    for row in ec_rows:
        non_candidates.append({
            "instance_id": row.get("instance", ""),
            "account_id": row.get("account", ""),
            "region": row.get("region", ""),
            "instance_class": row.get("instance_class", ""),
            "engine": row.get("engine", ""),
            "cpu_utilization": _to_float(row.get("cpu_utilization"), None),
            "connections": _to_int(row.get("connections"), None),
            "memory_usage_pct": _to_float(row.get("memory_usage_pct"), None),
            "cache_hits": _to_float(row.get("cache_hits"), None),
            "cache_misses": _to_float(row.get("cache_misses"), None),
            "replication_lag": _to_float(row.get("replication_lag"), None),
            "num_cache_nodes": _to_int(row.get("num_cache_nodes"), None),
            "bytes_used_for_cache": _to_float(row.get("bytes_used_for_cache"), None),
            "swap_usage": _to_float(row.get("swap_usage"), None),
            "nw_bw_in_exceeded": row.get("nw_bw_in_exceeded"),
            "nw_bw_out_exceeded": row.get("nw_bw_out_exceeded"),
            "engine_cpu_max": _to_float(row.get("peak_cpu_7d"), None),
            "resource_type": "elasticache",
        })

    return non_candidates


# ---------------------------------------------------------------------------
# Save optimization results (Path B)
# ---------------------------------------------------------------------------

def _save_optimization_results(results: list[OptimizationResult]) -> int:
    """Save capacity audit results to optimization_report DDB table."""
    if not results:
        return 0
    today_str = date.today().isoformat()
    count = 0

    for r in results:
        upsert_optimization_report(
            account_id=r.account_id,
            date=today_str,
            instance_id=r.instance_id,
            region=r.region,
            resource_type=r.resource_type,
            instance_class=r.instance_class,
            engine=r.engine,
            optimization_type=r.optimization_type,
            estimated_monthly_cost=r.estimated_monthly_cost,
            is_micro=r.is_micro,
            free_storage_avg_gb=r.capacity_details.get("free_storage_avg_gb"),
            allocated_storage_gb=r.capacity_details.get("allocated_storage_gb"),
            cpu_max=r.capacity_details.get("cpu_max"),
            bytes_used_for_cache_gb=r.capacity_details.get("bytes_used_for_cache_gb"),
            swap_max_gb=r.capacity_details.get("swap_usage_gb"),
            engine_cpu_max=r.capacity_details.get("engine_cpu_max"),
            memory_util_pct=r.capacity_details.get("memory_usage_pct"),
            nw_bw_in_exceeded=r.capacity_details.get("nw_bw_in_exceeded"),
            nw_bw_out_exceeded=r.capacity_details.get("nw_bw_out_exceeded"),
        )
        count += 1

    logger.info("Saved %d optimization results", count)
    return count


# ---------------------------------------------------------------------------
# Write execution history
# ---------------------------------------------------------------------------

def _write_execution_history(
    status: str,
    total_candidates: int,
    total_idle: int,
    error_message: str | None,
    start_time: float,
) -> None:
    """Write analysis execution history via shared/queries/execution."""
    duration_seconds = int(time.time() - start_time)
    try:
        record_execution(
            phase="analysis",
            status=status,
            total_candidates=total_candidates,
            total_idle=total_idle,
            error_message=error_message,
            duration_seconds=duration_seconds,
        )
        logger.info(
            "Execution history recorded: phase=analysis, status=%s, duration=%ds",
            status, duration_seconds,
        )
    except Exception as e:
        logger.error("Failed to write execution history: %s", e)


# ---------------------------------------------------------------------------
# Main handler
# ---------------------------------------------------------------------------

def handler(event: dict, context) -> dict:
    """
    Lambda2-Analyzer 主入口。
    1. 从数据库加载 Candidate 数据和阈值配置
    2. 执行判定流水线：peak_veto → hidden_load_check → calculate_enhanced_scores
    3. 构建被排除 Candidate 的结果（含 exclusion_reason）
    4. 将所有结果（idle + excluded）写入 waste_report 表
    5. 可选调用 send_alert_if_needed
    6. 记录执行历史（phase='analysis'）
    """
    start_time = time.time()
    total_candidates = 0
    total_idle = 0

    try:
        # Step 1: Load candidates and threshold config
        candidates = _load_candidates_from_db()
        threshold_configs = load_threshold_configs()
        total_candidates = len(candidates)

        if not candidates:
            logger.info("No candidates found, nothing to analyze")
            _write_execution_history("completed", 0, 0, None, start_time)
            return {"status": "completed", "idle_count": 0, "total_candidates": 0}

        # Step 2: Run judgment pipeline
        after_veto = peak_veto(candidates, threshold_configs)
        logger.info(
            "After peak_veto: %d/%d candidates remain",
            len(after_veto), total_candidates,
        )

        after_hidden = hidden_load_check(after_veto, threshold_configs)
        logger.info(
            "After hidden_load_check: %d/%d candidates remain",
            len(after_hidden), len(after_veto),
        )

        idle_results = calculate_enhanced_scores(after_hidden, threshold_configs)
        total_idle = len(idle_results)
        logger.info("Scored %d idle instances", total_idle)

        # Step 3: Build excluded results
        excluded_results = _build_excluded_results(
            candidates, after_veto, after_hidden,
        )
        logger.info("Built %d excluded results", len(excluded_results))

        # Step 4: Save all results to waste_report
        all_results = idle_results + excluded_results
        _save_results(all_results)

        # Step 4b: Path B - Capacity optimization analysis
        try:
            non_candidates = _load_non_candidates_from_db()
            if non_candidates:
                optimization_results = capacity_audit(non_candidates, threshold_configs)
                _save_optimization_results(optimization_results)
                logger.info(
                    "Path B: %d optimization results from %d non-candidates",
                    len(optimization_results), len(non_candidates),
                )
        except Exception as e:
            logger.error("Path B capacity audit failed (non-fatal): %s", e)

        # Step 6: Record execution history
        _write_execution_history("completed", total_candidates, total_idle, None, start_time)

        return {
            "status": "completed",
            "idle_count": total_idle,
            "total_candidates": total_candidates,
            "excluded_count": len(excluded_results),
        }

    except Exception as e:
        logger.error("Lambda2 execution failed: %s", e, exc_info=True)
        _write_execution_history("failed", total_candidates, total_idle, str(e), start_time)
        return {
            "status": "failed",
            "error": str(e),
            "total_candidates": total_candidates,
        }
