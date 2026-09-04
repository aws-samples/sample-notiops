"""闲置评分（R4.2 ~ R4.6）。

与老 `lambda2_analyzer/engine.calculate_enhanced_idle_score` 的差异 —— 四处都是修 bug：

  R4.3  RDS 存储维度用 free/allocated 比例，不再用写死的 100GB 归一化
        老式 `min(free/100GB, 1.0)`：剩余超 100GB 的实例全部饱和到满分，
        2TB 剩余与 101GB 剩余同分，该维度在高端不携带信息。
        实测后果：CPU 92% 的满负载库只因磁盘开得大，闲置分白拿 30 分（idle_score=33.2）。
  R4.4  连接数按 max_connections 归一化（老式写死 /100），
        IOPS 按 gp3 基线归一化（老式无此维度）
  R4.5  ElastiCache 用请求总量 hits+misses，不用命中率
        命中率低反而说明被频繁查询却未命中 = 忙且设计差
  R4.2  per-service 函数 + dict 注册：加服务只需加一个函数 + 一行注册

两条贯穿全模块的约定：

  维度不可用时 SHALL 丢弃该维度并把权重按比例重分给其余维度，SHALL NOT 拿 0 顶上。
  拿 0 顶会把「不知道」说成「一点都不闲」或「完全闲」，两个方向都错。

  归一化依据只出 BasisCode + params，SHALL NOT 出自然语言（R10.9 i18n）。
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from typing import Any

from inspection.domain import metrics_meta, specs
from inspection.domain.dto import (
    BasisCode,
    CandidateRecord,
    DenominatorSource,
    Dimension,
    IdleRuleConfig,
    IdleScore,
    PriceEstimate,
    ResourceAttrs,
)
from inspection.domain.scoring import capacity

# ---------------------------------------------------------------------------
# 权重 —— R2.5.4：写死，不开放配置
# ---------------------------------------------------------------------------
# 客户认同的是「按分数排出最该优化的资源」这个能力，不是权重本身可调。
# 权重一旦可调，跨账号/跨天的分数就不可比，排序也就没有意义了。

WEIGHTS_RDS: dict[str, float] = {
    "cpu": 0.40,
    "connections": 0.30,
    "storage": 0.20,
    "iops": 0.10,
}

WEIGHTS_ELASTICACHE: dict[str, float] = {
    "cpu": 0.35,
    "memory": 0.35,
    "requests": 0.30,
}

# 归一化结果：(0~1 或 None, BasisCode, params)
NormResult = tuple[float | None, BasisCode, dict[str, Any]]


# ---------------------------------------------------------------------------
# 维度归一化：每个都返回 0~1，1 = 最闲，None = 不可判
# ---------------------------------------------------------------------------


def _norm_cpu(cand: CandidateRecord, attrs: ResourceAttrs) -> NormResult:
    """CPU 越低越闲。CPU 是百分比，自带分母。"""
    if cand.cpu_avg is None:
        # ⚠️ 报出来的指标名要跟着引擎变，否则运维会去补一个不是判定依据的指标。
        # Redis/Valkey 的 CPU 判定用 EngineCPUUtilization，Memcached 才是 CPUUtilization
        # （见 metrics_repo._ec_candidate）。同文件的 _norm_requests / _norm_memory
        # 都按引擎分支给了正确的名字，这里曾经硬写 CPUUtilization。
        if attrs.service == "elasticache" and not metrics_meta.is_memcached(
            attrs.service, attrs.engine
        ):
            missing = ["EngineCPUUtilization"]
        else:
            missing = ["CPUUtilization"]
        return None, BasisCode.METRIC_MISSING, {"metrics": missing}
    pct = _clamp(cand.cpu_avg / 100.0, 0.0, 1.0)
    return 1.0 - pct, BasisCode.CPU_PCT, {"value": cand.cpu_avg}


def _norm_connections(cand: CandidateRecord, attrs: ResourceAttrs) -> NormResult:
    """连接数越少越闲。分母是实例规格的 max_connections（R4.4）。"""
    if cand.connections_avg is None:
        return None, BasisCode.METRIC_MISSING, {"metrics": ["DatabaseConnections"]}

    max_conn = attrs.max_connections
    source = DenominatorSource.PARAMETER_GROUP

    if max_conn is None:
        max_conn, estimated = specs.resolve_max_connections(
            attrs.instance_class, attrs.engine, attrs.memory_bytes
        )
        source = (
            DenominatorSource.FORMULA if estimated else DenominatorSource.PUBLISHED_TABLE
        )
        if max_conn is None:
            return (
                None,
                BasisCode.DENOMINATOR_UNKNOWN,
                {"denominator": "max_connections", "instance_class": attrs.instance_class},
            )

    if max_conn <= 0:
        return (
            None,
            BasisCode.DENOMINATOR_INVALID,
            {"denominator": "max_connections", "value": max_conn},
        )

    ratio = _clamp(cand.connections_avg / max_conn, 0.0, 1.0)
    return (
        1.0 - ratio,
        BasisCode.CONN_OVER_MAX,
        {
            "value": cand.connections_avg,
            "max_connections": max_conn,
            "source": source.value,
        },
    )


def _norm_storage(cand: CandidateRecord, attrs: ResourceAttrs) -> NormResult:
    """剩余存储占分配容量的比例越大 → 存储开得越浪费（R4.3）。

    ⚠️ 这个维度衡量的是「存储超配」，不是「实例闲置」，两者因果关系弱。
    权重因此从老实现的 0.30 降到 0.20，腾出的 0.10 给 IOPS
    （IOPS 与「有没有人在用」的相关性强得多）。
    """
    # ⚠️ Aurora 没有「分配容量」这个概念（集群卷按需增长），该维度**不适用**
    # 而不是「暂时取不到」—— 两者必须区分，否则运维会一直去查一个永远查不到的东西。
    #
    # ⚠️ 这一判必须在 `free_storage_bytes is None` **之前**。
    # Aurora PostgreSQL 连 `AuroraVolumeBytesLeftTotal` 都没有（那是 Aurora MySQL
    # 专属），free_storage_bytes 恒为 None —— 先判 None 就会给出 METRIC_MISSING，
    # 也就是告诉运维「去把这个指标采上来」，而那个指标根本不存在。
    if capacity.storage_is_consumption_based(attrs):
        return (
            None,
            BasisCode.NOT_APPLICABLE,
            {"dimension": "storage", "why": "consumption_based_storage"},
        )

    if cand.free_storage_bytes is None:
        return None, BasisCode.METRIC_MISSING, {"metrics": ["FreeStorageSpace"]}

    # ⚠️ bytes → GiB 比例的换算全仓只在 capacity.free_storage_ratio 里做一次。
    # 老实现在 engine.py 的两个函数里各写一遍，单位混用是它的坑之一。
    raw = capacity.free_storage_ratio(cand, attrs)
    if raw is None:
        return (
            None,
            BasisCode.DENOMINATOR_UNKNOWN,
            {"denominator": "allocated_storage_gb"},
        )

    ratio = _clamp(raw, 0.0, 1.0)
    return (
        ratio,
        BasisCode.STORAGE_FREE_RATIO,
        {
            "free_bytes": cand.free_storage_bytes,
            "allocated_gb": attrs.allocated_storage_gb,
        },
    )


def _norm_iops(cand: CandidateRecord, attrs: ResourceAttrs) -> NormResult:
    """IOPS 越低越闲。分母是 gp3 基线（R4.4）。"""
    read = cand.read_iops
    write = cand.write_iops if cand.write_iops is not None else cand.write_iops_avg
    if read is None and write is None:
        return (
            None,
            BasisCode.METRIC_MISSING,
            {"metrics": ["ReadIOPS", "WriteIOPS"]},
        )

    total = (read or 0.0) + (write or 0.0)
    baseline = attrs.baseline_iops or specs.gp3_baseline_iops(
        attrs.engine, attrs.allocated_storage_gb
    )
    if baseline <= 0:
        return (
            None,
            BasisCode.DENOMINATOR_INVALID,
            {"denominator": "baseline_iops", "value": baseline},
        )

    ratio = _clamp(total / baseline, 0.0, 1.0)
    return (
        1.0 - ratio,
        BasisCode.IOPS_OVER_BASELINE,
        {"value": total, "baseline_iops": baseline},
    )


def _norm_memory(cand: CandidateRecord, attrs: ResourceAttrs) -> NormResult:
    """ElastiCache 内存占用越低越闲。指标本身是百分比。

    ⚠️ **Memcached 上这个维度不适用**，不是「指标缺失」。
    `DatabaseMemoryUsagePercentage` 是 Redis/Valkey 专属；Memcached 只发
    `BytesUsedForCacheItems`（绝对字节），而我们没有节点内存上限做分母。
    标 METRIC_MISSING 会让运维每天去查一个永远采不到的指标。
    该维度的权重会按 `_build_dimensions` 的规则重分给 cpu 与 requests。
    """
    if metrics_meta.is_memcached(attrs.service, attrs.engine):
        return (
            None,
            BasisCode.NOT_APPLICABLE,
            {"dimension": "memory", "why": "no_percentage_metric_on_memcached",
             "available_absolute_metric": "BytesUsedForCacheItems"},
        )
    if cand.memory_usage_pct is None:
        return (
            None,
            BasisCode.METRIC_MISSING,
            {"metrics": ["DatabaseMemoryUsagePercentage"]},
        )
    pct = _clamp(cand.memory_usage_pct / 100.0, 0.0, 1.0)
    return 1.0 - pct, BasisCode.MEMORY_PCT, {"value": cand.memory_usage_pct}


def _norm_requests(
    cand: CandidateRecord, attrs: ResourceAttrs, cfg: IdleRuleConfig
) -> NormResult:
    """请求总量越低越闲（R4.5）。

    ⚠️ 用 hits+misses，**不用命中率**。没人查 → 请求量低但命中率可能仍高
    （少量请求都命中）；命中率低反而是「被频繁查询却未命中」= 忙且设计差。
    分母用 `cfg.requests_per_minute`（隐形负载否决的同一门槛），达到门槛即视为完全不闲。

    ⚠️ 量纲：`cache_hits` / `cache_misses` 取自 `Average` 统计量，在
    `period=86400` 下等于「那天各 1 分钟数据点的平均值」= **平均每分钟请求数**。
    门槛字段因此叫 `requests_per_minute` 而不是原来的 `requests_sum` ——
    后者读起来像窗口总量，与喂进来的数据不是一个量纲，而这种错配不会报错。
    """
    hits, misses = cand.cache_hits, cand.cache_misses
    if hits is None and misses is None:
        # ⚠️ 报出来的指标名必须跟着引擎变，否则运维会去查一个这个引擎上
        # 不存在的指标名。Memcached 叫 GetHits / GetMisses。
        names = (
            ["GetHits", "GetMisses"]
            if metrics_meta.is_memcached(attrs.service, attrs.engine)
            else ["CacheHits", "CacheMisses"]
        )
        return None, BasisCode.METRIC_MISSING, {"metrics": names}

    total = (hits or 0.0) + (misses or 0.0)
    denom = float(cfg.requests_per_minute) if cfg.requests_per_minute > 0 else 1.0
    ratio = _clamp(total / denom, 0.0, 1.0)
    return (
        1.0 - ratio,
        BasisCode.REQUESTS_OVER_THRESHOLD,
        {
            "value": total,
            "threshold": cfg.requests_per_minute,
            "threshold_unit": "requests_per_minute",
            "source": DenominatorSource.SPEC_DEFAULT.value,
        },
    )


# ---------------------------------------------------------------------------
# per-service 评分 —— R4.2
# ---------------------------------------------------------------------------


def _score_rds(
    cand: CandidateRecord, attrs: ResourceAttrs, cfg: IdleRuleConfig
) -> tuple[list[Dimension], float]:
    return _build_dimensions(
        WEIGHTS_RDS,
        {
            "cpu": lambda: _norm_cpu(cand, attrs),
            "connections": lambda: _norm_connections(cand, attrs),
            "storage": lambda: _norm_storage(cand, attrs),
            "iops": lambda: _norm_iops(cand, attrs),
        },
    )


def _score_elasticache(
    cand: CandidateRecord, attrs: ResourceAttrs, cfg: IdleRuleConfig
) -> tuple[list[Dimension], float]:
    return _build_dimensions(
        WEIGHTS_ELASTICACHE,
        {
            "cpu": lambda: _norm_cpu(cand, attrs),
            "memory": lambda: _norm_memory(cand, attrs),
            "requests": lambda: _norm_requests(cand, attrs, cfg),
        },
    )


ScorerFn = Callable[
    [CandidateRecord, ResourceAttrs, IdleRuleConfig], "tuple[list[Dimension], float]"
]

# 加新服务：写一个 _score_xxx，在这里加一行。不改任何已有服务的代码路径。
SCORERS: dict[str, ScorerFn] = {
    "rds": _score_rds,
    "elasticache": _score_elasticache,
}


def supported_services() -> tuple[str, ...]:
    return tuple(sorted(SCORERS))


# ---------------------------------------------------------------------------
# 组装：权重重归一化 + value_score
# ---------------------------------------------------------------------------


# 可用维度的原始权重之和低于这个值就不出分（R4.7）。
#
# ⚠️ 0.5 = 至少要有一半的判据在。低于它时算出来的分不是「不太准」，而是**不可比**：
# RDS 只剩 cpu 存活时 `eff_w = 0.40/0.40 = 1.0`，一台 CPU 1% 但 IOPS 打满
# （只是 ReadIOPS/WriteIOPS 没采到）的库会拿 99 分，排在四维齐全、实测确实闲的
# 85 分实例**前面**。而这不是边缘情形：Aurora PostgreSQL 恒定命中 ——
# storage 恒 NOT_APPLICABLE、connections 因无公布表恒 DENOMINATOR_UNKNOWN，
# 只剩 cpu(0.40) + iops(0.10)，CPU 独占 80% 的分。
MIN_AVAILABLE_WEIGHT = 0.5


def _build_dimensions(
    weights: dict[str, float],
    normalizers: dict[str, Callable[[], NormResult]],
) -> tuple[list[Dimension], float]:
    """算各维度，并把不可用维度的权重按比例重分给可用维度。

    返回 `(维度列表, 可用维度的原始权重之和)` —— 后者让调用方能判断
    「这个分到底还有多少判据支撑」，而不是只看到一个数字。
    """
    raw: dict[str, NormResult] = {name: fn() for name, fn in normalizers.items()}
    available_weight = sum(
        weights[name] for name, (value, _, _) in raw.items() if value is not None
    )

    dims: list[Dimension] = []
    for name, (value, code, params) in raw.items():
        raw_w = weights[name]
        if value is None:
            dims.append(
                Dimension(
                    name=name, weight=0.0, raw_weight=raw_w,
                    normalized_value=None, points=0.0,
                    basis_code=code, basis_params=params,
                )
            )
            continue
        # 重归一化：可用维度按原比例吃满 100%
        eff_w = raw_w / available_weight if available_weight > 0 else 0.0
        dims.append(
            Dimension(
                name=name, weight=eff_w, raw_weight=raw_w,
                normalized_value=value, points=value * 100.0 * eff_w,
                basis_code=code, basis_params=params,
            )
        )
    return dims, available_weight


def consecutive_days_factor(low_days: int, cfg: IdleRuleConfig) -> float:
    """连续低位越久，越确信它真的闲着。

    与老实现同式：max(1.0, 1.0 + (low_days - 1) * 0.1)。
    low_days=0 或 1 都得 1.0（不加成也不惩罚）。
    """
    return max(1.0, 1.0 + (low_days - 1) * cfg.consecutive_days_step)


def value_score(idle_score: float, size_weight: float, days_factor: float,
                available_weight: float = 1.0) -> float:
    """R4.1 要求把它从 `calculate_enhanced_scores` 的内联算式提取成独立函数
    （老实现里它只是 JudgmentResult 的一个字段，无法单独调用与单测）。

    ## 🔴 `available_weight` 是**排序的置信度折扣**

    `MIN_AVAILABLE_WEIGHT = 0.5` 那段注释描述的危害是**排序**：

    > 一台 CPU 1% 但 IOPS 打满（只是 ReadIOPS/WriteIOPS 没采到）的库会拿 99 分，
    > 排在四维齐全、实测确实闲的 85 分实例**前面**。而这不是边缘情形：
    > Aurora PostgreSQL 恒定命中 —— 只剩 cpu(0.40) + iops(0.10)。

    而 `cpu 0.40 + iops 0.10 = 0.50`，判据是 `>= 0.5` → **正好放行**。
    也就是那段注释点名的情形恰恰没被挡住。实测：

    ```
    aurora-pg  available_weight=0.5  idle_score=99.19   ← 两维
    mysql      四维齐全              idle_score=89.57
    ```

    把 `>=` 改成 `>` 会让**整个 Aurora PostgreSQL 引擎族**都不出闲置分 ——
    太钝了（那是真实的省钱机会）。所以修在这里：`idle_score` 保持「按现有判据
    算出来的分」（`idle_weight_avail` 已落库，UI 会标降级），而 `value_score`
    —— 决定谁排在上面的那个键 —— 按可用权重打折。

    ⚠️ 折扣是**线性**的：两维齐全（0.5）的 99 分 → 49.6，排在四维齐全的
    85 分之后；而四维齐全（1.0）不受影响。这样既不丢 Aurora PG，
    也不让它靠「判据少所以每一维都满分」插队。

    ⚠️ 默认 1.0 —— 老调用点（只传三个参数）行为不变。
    """
    return round(idle_score * size_weight * days_factor * available_weight, 4)


def score_idle(
    candidate: CandidateRecord,
    attrs: ResourceAttrs,
    cfg: IdleRuleConfig,
    consecutive_low_days: int = 0,
    estimated_monthly_savings: PriceEstimate | None = None,
    data_date: date | None = None,
) -> IdleScore:
    """R2.4b.3 声明的签名。纯函数：同一入参恒等输出。

    ⚠️ `estimated_monthly_savings` 的类型是 `PriceEstimate` 而**不是 float**。
    早期版本的标注写成 `float | None`，而 `IdleScore.monthly_usd` /
    `savings_is_coarse` 都要读它的属性 —— 真按标注传 float 会在
    `rank_cross_service`（R4.6 的实现）里抛 AttributeError。
    测试一直传的是真 `PriceEstimate`，所以没被发现。
    """
    scorer = SCORERS.get(candidate.service)
    if scorer is None:
        raise ValueError(
            f"no idle scorer registered for service {candidate.service!r}; "
            f"registered: {supported_services()}"
        )

    dims, available_weight = scorer(candidate, attrs, cfg)
    size_w = specs.instance_size_weight(attrs.instance_class)
    days_f = consecutive_days_factor(consecutive_low_days, cfg)

    # ⚠️ 判据不足时 `idle_score` 留 None，**SHALL NOT 出 0**。
    # 0 分在排序里等于「完全不闲」，所以「没有任何数据」会被呈现成
    # 「这台一点都不闲」—— 方向正好反了，且完全无声。
    # 最刺眼的具体形态是**停机的 RDS 实例**：停机不发 CloudWatch 指标 →
    # 四个维度全 None → 0 分 → 排在列表最末；而它恰恰是全机队里
    # 最该被处置的资源（停机仍在为存储与 IP 付费）。
    sufficient = available_weight >= MIN_AVAILABLE_WEIGHT
    idle = round(sum(d.points for d in dims), 4) if sufficient else None

    return IdleScore(
        instance_id=candidate.instance_id,
        service=candidate.service,
        account_id=attrs.account_id,
        region=attrs.region,
        data_date=data_date,
        idle_score=idle,
        value_score=(
            # ⚠️ 第四个参数是置信度折扣（见 `value_score`）。不传的话判据只剩
            #    一半的实例会靠「每一维都满分」插到四维齐全的前面。
            value_score(idle, size_w, days_f, available_weight)
            if idle is not None else None
        ),
        available_weight=round(available_weight, 4),
        size_weight=size_w,
        consecutive_low_days=consecutive_low_days,
        consecutive_days_factor=days_f,
        estimated_monthly_savings=estimated_monthly_savings,
        dimensions=tuple(dims),
        degraded_dimensions=tuple(d.name for d in dims if not d.available),
    )


def _clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))
