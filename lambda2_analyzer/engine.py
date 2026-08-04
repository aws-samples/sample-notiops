"""
增强版判定引擎。
实现峰值否决、隐形负载检查、增强版闲置评分、连续低阈值天数计算、
规格权重映射、价值评分和月度节省估算。
"""

import json
import logging
from dataclasses import dataclass
from pathlib import Path

from lambda1_collector.threshold import ThresholdConfig, get_threshold_for_resource_type
from shared.queries.metrics import get_monitoring_history

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class CandidateRecord:
    instance_id: str
    resource_type: str          # 'rds' | 'elasticache'
    instance_class: str
    engine: str
    account_id: str
    region: str
    cpu_utilization: float
    connections: int
    free_storage_or_memory: float
    read_iops: float | None
    write_iops: float | None
    network_in: float | None
    network_out: float | None
    evictions: int | None
    peak_cpu_7d: float | None
    peak_connections_7d: int | None
    tags: dict[str, str] | None = None
    write_iops_avg: float | None = None
    cache_hits: float | None = None
    cache_misses: float | None = None
    cpu_max: float | None = None
    allocated_storage_gb: float | None = None
    bytes_used_for_cache: float | None = None
    swap_usage: float | None = None
    num_cache_nodes: int | None = None


@dataclass
class JudgmentResult:
    instance_id: str
    account_id: str
    region: str
    is_idle: bool
    exclusion_reason: str | None    # 'peak_veto' | 'io_intensive' | 'memory_full' | None
    idle_score: float | None
    value_score: float | None
    estimated_monthly_savings: float | None
    consecutive_low_days: int
    # snapshot fields for report
    resource_type: str = ""
    instance_class: str = ""
    engine: str = ""
    cpu_utilization: float = 0.0
    connections: int = 0
    free_storage_or_memory: float = 0.0
    peak_cpu_7d: float | None = None
    read_iops: float | None = None
    write_iops: float | None = None
    evictions: int | None = None
    allocated_storage_gb: float | None = None
    cache_hits: float | None = None
    cache_misses: float | None = None


# ---------------------------------------------------------------------------
# 1. peak_veto – 峰值否决
# ---------------------------------------------------------------------------

def peak_veto(
    candidates: list[CandidateRecord],
    threshold_configs: dict[str, ThresholdConfig],
) -> list[CandidateRecord]:
    """
    排除 peak_cpu_7d > 资源类型 peak_cpu_veto 阈值的实例。
    如果 peak_cpu_7d 为 None，则不排除（数据缺失时保守处理）。
    """
    passed: list[CandidateRecord] = []
    for c in candidates:
        if c.peak_cpu_7d is None:
            passed.append(c)
            continue
        effective = get_threshold_for_resource_type(c.resource_type, threshold_configs)
        if c.peak_cpu_7d > effective.peak_cpu_veto:
            logger.info(
                "peak_veto: excluding %s (peak_cpu_7d=%.2f > threshold=%.2f)",
                c.instance_id, c.peak_cpu_7d, effective.peak_cpu_veto,
            )
        else:
            passed.append(c)
    return passed


# ---------------------------------------------------------------------------
# 2. hidden_load_check – 隐形负载检查
# ---------------------------------------------------------------------------

def hidden_load_check(
    candidates: list[CandidateRecord],
    threshold_configs: dict[str, ThresholdConfig],
) -> list[CandidateRecord]:
    """
    RDS:  排除 read_iops + write_iops > 资源类型 iops 阈值
    ElastiCache: 排除 evictions > 资源类型 evictions 阈值
    """
    passed: list[CandidateRecord] = []
    for c in candidates:
        effective = get_threshold_for_resource_type(c.resource_type, threshold_configs)
        excluded = False
        if c.resource_type == "rds":
            read = c.read_iops or 0.0
            write = c.write_iops or 0.0
            total_iops = read + write
            if total_iops > effective.iops:
                logger.info(
                    "hidden_load_check: excluding RDS %s (iops=%.2f > threshold=%d)",
                    c.instance_id, total_iops, effective.iops,
                )
                excluded = True
            # NEW: WriteIOPS check
            if not excluded and c.write_iops_avg is not None and c.write_iops_avg > effective.write_iops:
                logger.info(
                    "hidden_load_check: excluding RDS %s (write_iops_avg=%.2f > threshold=%d)",
                    c.instance_id, c.write_iops_avg, effective.write_iops,
                )
                excluded = True
        elif c.resource_type == "elasticache":
            if c.evictions is not None and c.evictions > effective.evictions:
                logger.info(
                    "hidden_load_check: excluding ElastiCache %s (evictions=%d > threshold=%d)",
                    c.instance_id, c.evictions, effective.evictions,
                )
                excluded = True
            # NEW: Requests sum check
            if not excluded:
                hits = c.cache_hits or 0.0
                misses = c.cache_misses or 0.0
                total_requests = hits + misses
                if total_requests > effective.requests_sum:
                    logger.info(
                        "hidden_load_check: excluding ElastiCache %s (requests=%.2f > threshold=%d)",
                        c.instance_id, total_requests, effective.requests_sum,
                    )
                    excluded = True
            # NEW: Connections max check
            if not excluded and c.peak_connections_7d is not None and c.peak_connections_7d > effective.conn_max:
                logger.info(
                    "hidden_load_check: excluding ElastiCache %s (peak_conn=%d > threshold=%d)",
                    c.instance_id, c.peak_connections_7d, effective.conn_max,
                )
                excluded = True
        if not excluded:
            passed.append(c)
    return passed


# ---------------------------------------------------------------------------
# 3. calculate_enhanced_idle_score – 增强版闲置评分
# ---------------------------------------------------------------------------

def calculate_enhanced_idle_score(candidate: CandidateRecord) -> float:
    """
    增强版闲置评分 (0-100)，综合三个维度：
    - CPU 维度 (40%): (1 - cpu/100) * 100 * 0.4
    - 连接数维度 (30%): max(0, (1 - connections/100)) * 100 * 0.3
    - 存储/内存维度 (30%):
        RDS: higher FreeStorageSpace → higher score
             normalise against 100 GB (100_000_000_000 bytes) ceiling
        ElastiCache: (1 - memory_usage_pct/100) * 100 * 0.3
    """
    # CPU dimension (40%)
    cpu_score = (1.0 - candidate.cpu_utilization / 100.0) * 100.0 * 0.4

    # Connections dimension (30%) – cap at 100
    conn_ratio = min(candidate.connections, 100) / 100.0
    conn_score = max(0.0, (1.0 - conn_ratio)) * 100.0 * 0.3

    # Storage / Memory dimension (30%)
    if candidate.resource_type == "rds":
        # free_storage_or_memory is FreeStorageSpace in bytes
        # Normalise: assume max ~100 GB = 100_000_000_000 bytes
        max_storage = 100_000_000_000.0  # 100 GB
        ratio = min(candidate.free_storage_or_memory / max_storage, 1.0) if max_storage > 0 else 0.0
        storage_score = ratio * 100.0 * 0.3
    else:
        # ElastiCache: free_storage_or_memory is DatabaseMemoryUsagePercentage
        memory_pct = candidate.free_storage_or_memory
        storage_score = (1.0 - memory_pct / 100.0) * 100.0 * 0.3

    total = cpu_score + conn_score + storage_score
    return round(total, 4)


# ---------------------------------------------------------------------------
# 4. calculate_consecutive_low_days – 连续低阈值天数
# ---------------------------------------------------------------------------

def calculate_consecutive_low_days(
    instance_id: str,
    account_id: str,
    resource_type: str,
    threshold_configs: dict[str, ThresholdConfig],
) -> int:
    """
    查询过去 7 天的历史监控数据，从最近一天向前回溯，
    计算连续低于阈值（cpu < threshold AND connections < threshold）的天数。
    返回 0-7。
    """
    rows = get_monitoring_history(resource_type, instance_id, account_id, days=7)

    if not rows:
        return 0

    effective = get_threshold_for_resource_type(resource_type, threshold_configs)

    consecutive = 0
    for row in rows:
        cpu = row.get("cpu_utilization")
        conns = row.get("connections")
        if cpu is None or conns is None:
            break
        if cpu <= effective.candidate_cpu and conns <= effective.candidate_connections:
            consecutive += 1
        else:
            break

    return consecutive


# ---------------------------------------------------------------------------
# 5. get_instance_size_weight – 规格权重映射
# ---------------------------------------------------------------------------

def get_instance_size_weight(instance_class: str) -> float:
    """
    根据实例规格返回权重：
    - xlarge 及以上: 1.5
    - small 及以下 (nano, micro, small): 0.5
    - 其余 (medium, large): 1.0
    """
    lower = instance_class.lower()

    # xlarge 及以上 (xlarge, 2xlarge, 4xlarge, 8xlarge, …)
    if "xlarge" in lower:
        return 1.5

    # small 及以下
    if "nano" in lower or "micro" in lower or "small" in lower:
        return 0.5

    # medium, large, or anything else
    return 1.0


# ---------------------------------------------------------------------------
# 6. calculate_enhanced_scores – 增强版价值评分
# ---------------------------------------------------------------------------

def calculate_enhanced_scores(
    candidates: list[CandidateRecord],
    threshold_configs: dict[str, ThresholdConfig],
) -> list[JudgmentResult]:
    """
    For each candidate:
      idle_score = calculate_enhanced_idle_score(candidate)
      consecutive_low_days = calculate_consecutive_low_days(...)
      size_weight = get_instance_size_weight(instance_class)
      consecutive_days_factor = max(1.0, 1.0 + (consecutive_low_days - 1) * 0.1)
      value_score = idle_score * size_weight * consecutive_days_factor
      estimated_monthly_savings = estimate_monthly_savings(instance_class, engine)
    """
    results: list[JudgmentResult] = []
    for c in candidates:
        idle_score = calculate_enhanced_idle_score(c)
        low_days = calculate_consecutive_low_days(
            c.instance_id, c.account_id, c.resource_type, threshold_configs,
        )
        size_weight = get_instance_size_weight(c.instance_class)
        consecutive_days_factor = max(1.0, 1.0 + (low_days - 1) * 0.1)
        value_score = round(idle_score * size_weight * consecutive_days_factor, 4)
        savings = estimate_monthly_savings(c.instance_class, c.engine, c.num_cache_nodes or 1)

        results.append(
            JudgmentResult(
                instance_id=c.instance_id,
                account_id=c.account_id,
                region=c.region,
                is_idle=True,
                exclusion_reason=None,
                idle_score=idle_score,
                value_score=value_score,
                estimated_monthly_savings=savings,
                consecutive_low_days=low_days,
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
    return results


# ---------------------------------------------------------------------------
# Pricing data cache
# ---------------------------------------------------------------------------

_PRICING_DATA: dict | None = None


def _load_pricing_data() -> dict:
    """加载 aws_pricing_estimates.json，缓存在模块级变量中。"""
    global _PRICING_DATA
    if _PRICING_DATA is not None:
        return _PRICING_DATA
    json_path = Path(__file__).parent / "aws_pricing_estimates.json"
    try:
        with open(json_path) as f:
            _PRICING_DATA = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError) as e:
        logger.warning("Failed to load pricing data from %s: %s", json_path, e)
        _PRICING_DATA = {}
    return _PRICING_DATA


# ---------------------------------------------------------------------------
# 7. estimate_monthly_savings – 月度节省估算
# ---------------------------------------------------------------------------

# Lookup table: instance size keyword → approximate monthly on-demand cost (USD)
_SAVINGS_TABLE: list[tuple[str, float]] = [
    ("nano",    15.0),
    ("micro",   15.0),
    ("small",   30.0),
    ("medium",  60.0),
    ("large",  120.0),
    ("xlarge", 250.0),
    ("2xlarge", 500.0),
    ("4xlarge", 1000.0),
    ("8xlarge", 1000.0),
    ("12xlarge", 1000.0),
    ("16xlarge", 1000.0),
    ("24xlarge", 1000.0),
]


def estimate_monthly_savings(instance_class: str, engine: str, num_nodes: int = 1) -> float:
    """
    精确定价查找：
    1. 在 aws_pricing_estimates.json 中按完整实例类型查找
    2. 回退到 _SAVINGS_TABLE 关键字查找
    3. ElastiCache: 单节点价格 × 节点数
    """
    pricing = _load_pricing_data()
    lower = instance_class.lower()

    # 精确查找
    if lower.startswith("cache."):
        exact_price = pricing.get("monthly_usd", {}).get("elasticache_node", {}).get(lower)
        if exact_price is not None:
            return exact_price * max(num_nodes, 1)
    else:
        exact_price = pricing.get("monthly_usd", {}).get("rds", {}).get(lower)
        if exact_price is not None:
            return exact_price

    # 关键字回退
    for keyword, cost in sorted(_SAVINGS_TABLE, key=lambda x: len(x[0]), reverse=True):
        if keyword in lower:
            return cost * max(num_nodes, 1) if lower.startswith("cache.") else cost

    return 60.0


# ---------------------------------------------------------------------------
# 8. OptimizationResult & capacity_audit – 容量优化分析（路径 B）
# ---------------------------------------------------------------------------

@dataclass
class OptimizationResult:
    instance_id: str
    account_id: str
    region: str
    resource_type: str
    instance_class: str
    engine: str
    optimization_type: str          # 'oversized_storage' | 'oversized_compute' | 'oversized_memory'
    estimated_monthly_cost: float
    capacity_details: dict          # capacity metrics snapshot
    is_micro: bool


def capacity_audit(
    non_candidates: list[dict],
    threshold_configs: dict[str, ThresholdConfig],
) -> list[OptimizationResult]:
    """
    对非 Candidate 资源执行容量审计：
    - RDS: FreeStorageAvg / AllocatedStorage >= free_storage_pct AND CPUMax < cpu_max_veto
      → oversized_storage
    - ElastiCache: SwapMax < swap_max_gb AND EngineCPUMax < cpu_max_veto AND MemoryUtil < memory_util_max
      → oversized_memory
    结果按 estimated_monthly_cost 降序排序，micro 实例单独分组在末尾。
    """
    results: list[OptimizationResult] = []

    for row in non_candidates:
        resource_type = row.get("resource_type", "")
        threshold = get_threshold_for_resource_type(resource_type, threshold_configs)
        instance_class = row.get("instance_class", "")
        is_micro = "micro" in instance_class.lower()

        if resource_type == "rds":
            result = _audit_rds(row, threshold, is_micro)
            if result is not None:
                results.append(result)
        elif resource_type == "elasticache":
            result = _audit_elasticache(row, threshold, is_micro)
            if result is not None:
                results.append(result)

    # Sort: non-micro by cost desc, then micro by cost desc
    non_micro = [r for r in results if not r.is_micro]
    micro = [r for r in results if r.is_micro]
    non_micro.sort(key=lambda r: r.estimated_monthly_cost, reverse=True)
    micro.sort(key=lambda r: r.estimated_monthly_cost, reverse=True)

    return non_micro + micro


def _audit_rds(
    row: dict,
    threshold: ThresholdConfig,
    is_micro: bool,
) -> OptimizationResult | None:
    """
    RDS oversized_storage check:
    - allocated_storage_gb must not be None and > 0
    - free_storage (avg, in bytes) must not be None
    - free_storage_ratio = free_storage_avg_gb / allocated_storage_gb
    - If ratio >= free_storage_pct AND (cpu_max is None OR cpu_max < cpu_max_veto)
    """
    allocated_storage_gb = row.get("allocated_storage_gb")
    free_storage = row.get("free_storage")  # avg in bytes

    if allocated_storage_gb is None or allocated_storage_gb <= 0:
        return None
    if free_storage is None:
        return None

    free_storage_avg_gb = free_storage / (1024 ** 3)
    free_storage_ratio = free_storage_avg_gb / allocated_storage_gb

    cpu_max = row.get("cpu_max")

    if free_storage_ratio >= threshold.free_storage_pct and (
        cpu_max is None or cpu_max < threshold.cpu_max_veto
    ):
        instance_class = row.get("instance_class", "")
        engine = row.get("engine", "")
        cost = estimate_monthly_savings(instance_class, engine)
        return OptimizationResult(
            instance_id=row.get("instance_id", ""),
            account_id=row.get("account_id", ""),
            region=row.get("region", ""),
            resource_type="rds",
            instance_class=instance_class,
            engine=engine,
            optimization_type="oversized_storage",
            estimated_monthly_cost=cost,
            capacity_details={
                "free_storage_avg_gb": round(free_storage_avg_gb, 4),
                "allocated_storage_gb": allocated_storage_gb,
                "free_storage_ratio": round(free_storage_ratio, 4),
                "cpu_max": cpu_max,
            },
            is_micro=is_micro,
        )
    return None


def _audit_elasticache(
    row: dict,
    threshold: ThresholdConfig,
    is_micro: bool,
) -> OptimizationResult | None:
    """
    ElastiCache oversized_memory check:
    - swap_usage must not be None (in bytes from CloudWatch)
    - engine_cpu_max must be available
    - memory_usage_pct (free_storage_or_memory field) must be available
    - swap_usage_gb < swap_max_gb AND (engine_cpu_max is None OR engine_cpu_max < cpu_max_veto)
      AND memory_usage_pct < memory_util_max
    """
    swap_usage = row.get("swap_usage")
    if swap_usage is None:
        return None

    swap_usage_gb = swap_usage / (1024 ** 3)

    engine_cpu_max = row.get("engine_cpu_max")
    memory_usage_pct = row.get("memory_usage_pct")

    if memory_usage_pct is None:
        return None

    if (
        swap_usage_gb < threshold.swap_max_gb
        and (engine_cpu_max is None or engine_cpu_max < threshold.cpu_max_veto)
        and memory_usage_pct < threshold.memory_util_max
    ):
        instance_class = row.get("instance_class", "")
        engine = row.get("engine", "")
        num_cache_nodes = row.get("num_cache_nodes") or 1
        cost = estimate_monthly_savings(instance_class, engine, num_cache_nodes)
        return OptimizationResult(
            instance_id=row.get("instance_id", ""),
            account_id=row.get("account_id", ""),
            region=row.get("region", ""),
            resource_type="elasticache",
            instance_class=instance_class,
            engine=engine,
            optimization_type="oversized_memory",
            estimated_monthly_cost=cost,
            capacity_details={
                "swap_usage_gb": round(swap_usage_gb, 6),
                "engine_cpu_max": engine_cpu_max,
                "cpu_max": engine_cpu_max,
                "memory_usage_pct": memory_usage_pct,
                "nw_bw_in_exceeded": row.get("nw_bw_in_exceeded"),
                "nw_bw_out_exceeded": row.get("nw_bw_out_exceeded"),
            },
            is_micro=is_micro,
        )
    return None
