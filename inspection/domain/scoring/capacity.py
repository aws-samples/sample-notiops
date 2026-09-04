"""容量超配审计 —— 承接老 `lambda2_analyzer/engine.py` 的
`capacity_audit` / `_audit_rds` / `_audit_elasticache`（R4.1c）。

## 它和闲置评分、结构性风险的分工

```
闲置评分 (idle.py)        「这台没人用」          → 整机可以停/缩
容量超配 (本模块)          「这台在用，但某个维度开太大」 → 单维度可以缩
结构性风险 (structural/)   「配置本身有风险」        → 纯属性，零指标
```

老实现把它跑在**非 candidate**（闲置判定没选中的）资源上，正是这个语义：
一台 CPU 忙的库，磁盘开了 4TB 用了 500GB —— 不是闲置，但存储确实超配。

⚠️ **R4.1c 原写「SHALL 并入 scan_structural」，这里不照做。** 理由：
容量超配必须读指标（剩余存储 / 内存占用 / CPU 峰值），而 R2.4.1 把结构性风险定义为
「不需要统计推断、纯属性判定」，`scan_structural(attrs, refdata, cfg, today)` 的签名里
也没有指标入参。并进去会同时破掉那条定义和那个签名。
它的真实语义是 rightsizing，输出归②「闲置与优化」，所以落在 scoring/ 包。

## 修掉老实现的三个坑（Phase 2 调查已登记）

1. **单位混用** —— 老代码 `row["free_storage"]` 是字节、`row["allocated_storage_gb"]` 是 GB，
   转换散落在两个函数里。这里收敛到唯一的 `free_storage_ratio()`。
2. **`cpu_max is None` → 判定通过** —— 改成**不判定**。
   cpu_max 是这条规则的否决项（排除「其实很忙」），缺了它就无法否决；
   而本模块的输出是「建议缩容」，对一台可能很忙的实例建议缩容是危险动作。
   与新架构「None SHALL 丢弃维度，SHALL NOT 拿 0 或猜测值继续算」一致。
3. **`is_micro` 靠 `"micro" in instance_class` 字符串匹配** —— 改用 `specs.is_micro()`
   走规格后缀解析。老写法对 `db.t4g.micro` 能命中，但没有规格表兜底，
   遇到形如 `db.micro-legacy` 之类的命名会误判。
4. **CPU 否决项读的是「最近一天的 max」** —— 改用窗口峰值 `peak_cpu_7d`。
   `cpu_max` 只覆盖窗口最后一天：前六天 95%、昨天正好安静的库会通过否决，
   于是我们对一台明显很忙的库建议缩容。否决项的语义是「排除其实很忙的」，
   一天的数据排除不掉。闲置侧的 `peak_veto` 早就是窗口峰值，这里是把口径对齐。
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import date

from inspection.domain import metrics_meta, specs
from inspection.domain.dto import (
    CandidateRecord,
    CapacityRule,
    CapacityRuleConfig,
    Finding,
    ResourceAttrs,
    Severity,
)

_BYTES_PER_GIB = 1024**3


# ---------------------------------------------------------------------------
# 共享的单位换算 —— 坑 ①：全模块只有这一处做 bytes → GiB 比例
# ---------------------------------------------------------------------------


def storage_is_consumption_based(attrs: ResourceAttrs) -> bool:
    """存储是否按实际用量计费 —— 是则「存储超配」这个概念不适用。

    只有 Aurora 属于这一类：集群卷按需增长（上限 128 TiB），
    客户只为实际占用付费，没有「预先分配了但没用上」的钱可以省。

    ⚠️ **不要把「开了 RDS 存储自动扩容」也算进来。** 两件事不同：
    ```
    Aurora                    按用量计费    → 超配不存在
    RDS + MaxAllocatedStorage 仍按 AllocatedStorage 付费
                                            → 超配依然真实，只是上界会自己涨
    ```
    自动扩容只影响上界，不改变「你已经在为分配容量付钱」这个事实。
    把它一起跳过会漏掉真实的超配。
    """
    return (attrs.engine or "").strip().lower().startswith("aurora")


def free_storage_ratio(
    candidate: CandidateRecord, attrs: ResourceAttrs
) -> float | None:
    """剩余存储占分配容量的比例。None = 判不了（缺数据，或该概念不适用）。

    `free_storage_bytes` 是字节（CloudWatch FreeStorageSpace），
    `allocated_storage_gb` 是 GiB（DescribeDBInstances.AllocatedStorage）。
    ⚠️ 这是全仓唯一做这个换算的地方，`idle._norm_storage` 也复用它。

    ⚠️ Aurora 返回 None：它的 `AllocatedStorage` 实测恒为占位值 1，
    拿它当分母会算出 `261919 GiB / 1 GiB = 261919`（本次抓到的真 bug）。
    adapters 层已把 Aurora 的该字段置 None，这里再挡一道以防别的调用方直接构造 attrs。
    """
    if candidate.free_storage_bytes is None:
        return None
    if (attrs.engine or "").strip().lower().startswith("aurora"):
        return None
    if attrs.allocated_storage_gb is None or attrs.allocated_storage_gb <= 0:
        return None
    return candidate.free_storage_bytes / (attrs.allocated_storage_gb * _BYTES_PER_GIB)


# ---------------------------------------------------------------------------
# 规则
# ---------------------------------------------------------------------------


def audit_oversized_storage(
    candidate: CandidateRecord, attrs: ResourceAttrs, cfg: CapacityRuleConfig,
    data_date: date | None = None,
) -> Finding | None:
    """RDS 存储超配：剩余比例高 **且** CPU 峰值不高（否则它可能只是在等增长）。

    ⚠️ CPU 否决项用 **`peak_cpu_7d`（窗口峰值）而不是 `cpu_max`（最近一天的 max）**。
    `cpu_max` 只覆盖窗口里的最后一天：一台前六天 95%、昨天正好安静的库，
    `cpu_max` 是个小数字 → 否决项失效 → 我们对一台明显很忙的库建议缩容。
    否决项的语义是「排除掉其实很忙的」，只看一天排除不掉。
    （`peak_veto` 在闲置侧早就是这么做的，这里是把口径对齐。）

    ⚠️ **Aurora 不适用，直接跳过。** Aurora 的集群卷按需增长（上限 128 TiB），
    存储按实际用量计费 —— `AllocatedStorage` 实测恒为占位值 1，
    「存储开太大可以缩」对它没有意义：客户没有多付任何超配的钱。

    ⚠️ 但**开了自动扩容的普通 RDS 仍然要报** —— 它照旧按 AllocatedStorage 付费，
    自动扩容只影响上界。只是在 params 里打 `storage_autoscaling` 标记，
    因为它改变的是修复动作（RDS 存储只能扩不能缩，得等下次重建）而不是问题是否存在。
    """
    if storage_is_consumption_based(attrs):
        return None

    ratio = free_storage_ratio(candidate, attrs)
    if ratio is None:
        return None
    # ⚠️ `cfg.free_storage_pct` 是 0~100 的**百分数**（40.0），而
    #    `free_storage_ratio()` 返回 0~1 的**比例**。除以 100 在这里做一次，
    #    SHALL NOT 让两种量纲在判定式里直接相遇 —— 那正是配置页上两个同名
    #    字段会被填错的同一个坑。
    if ratio < cfg.free_storage_pct / 100.0:
        return None

    # 坑 ②：CPU 否决项缺失 → 不判定（老实现是「通过」）
    # 坑 ④：用**窗口峰值** peak_cpu_7d，不用 cpu_max（那是最近一天的 max）
    if candidate.peak_cpu_7d is None:
        return None
    if candidate.peak_cpu_7d >= cfg.cpu_max_veto:
        return None

    return Finding(
        account_id=attrs.account_id, region=attrs.region, service=attrs.service,
        instance_id=attrs.instance_id, rule=CapacityRule.OVERSIZED_STORAGE,
        # ⚠️ 容量审计恒为 INFO，**不进 severity.compute_severity()**。
        # 它回答的是「能不能省钱」而不是「会不会挂」——
        # 用可靠性的分档去分它会让「有 80% 空闲存储」和「存储快满了」
        # 挤在同一个 HIGH 档里，客户看不出哪个要紧。降配建议的排序
        # 走 scoring/ranking.py 的 value_score，与 severity 是两套序。
        severity=Severity.INFO, cadence="daily", data_date=data_date,
        params={
            "free_storage_ratio": round(ratio, 4),
            "free_storage_gib": round(
                (candidate.free_storage_bytes or 0) / _BYTES_PER_GIB, 2
            ),
            "allocated_storage_gib": attrs.allocated_storage_gb,
            "peak_cpu_7d": candidate.peak_cpu_7d,
            "cpu_max_last_day": candidate.cpu_max,
            "threshold_free_storage_pct": cfg.free_storage_pct,
            "threshold_cpu_max_veto": cfg.cpu_max_veto,
            "is_micro": specs.is_micro(attrs.instance_class),
            # R7.3：开了自动扩容的库，「存储开太大」的结论要反过来说
            "storage_autoscaling": attrs.max_allocated_storage_gb is not None,
        },
    )


def audit_oversized_memory(
    candidate: CandidateRecord, attrs: ResourceAttrs, cfg: CapacityRuleConfig,
    data_date: date | None = None,
) -> Finding | None:
    """ElastiCache 内存超配：几乎没换页 + 引擎 CPU 不高 + 内存占用低。

    ⚠️ CPU 否决项用 `peak_cpu_7d`。对 ElastiCache 它承载的是
    **EngineCPUUtilization 的窗口峰值**（见 `metrics_repo._ec_candidate`）——
    Redis 主线程单线程，引擎 CPU 打满时整机 CPU 可能还很低（多核只一核在忙），
    用整机 CPU 会把已经打满的节点判成可以缩容。
    同时它是**窗口峰值**而不是最近一天的 max，理由同 `audit_oversized_storage`。

    ⚠️ **Memcached 直接跳过，并且是显式跳过。** 它没有
    `DatabaseMemoryUsagePercentage` 这个指标（那是 Redis/Valkey 专属），
    只发 `BytesUsedForCacheItems`（绝对字节），而我们手上没有节点内存上限做分母。
    虽然 `memory_usage_pct is None` 事实上也会让它返回 None，但那是**偶然正确**：
    读代码的人会以为「Memcached 是数据没采到」，进而去修一个修不了的采集缺口。
    写成显式跳过，语义就变成「这条规则对 Memcached 不适用」。
    """
    if metrics_meta.is_memcached(attrs.service, attrs.engine):
        return None
    if candidate.swap_usage_bytes is None:
        return None
    if candidate.memory_usage_pct is None:
        return None

    swap_gib = candidate.swap_usage_bytes / _BYTES_PER_GIB
    if swap_gib >= cfg.swap_max_gb:
        return None
    if candidate.memory_usage_pct >= cfg.memory_util_max:
        return None

    # 坑 ②：CPU 否决项缺失 → 不判定    坑 ④：用窗口峰值
    if candidate.peak_cpu_7d is None:
        return None
    if candidate.peak_cpu_7d >= cfg.cpu_max_veto:
        return None

    return Finding(
        account_id=attrs.account_id, region=attrs.region, service=attrs.service,
        instance_id=attrs.instance_id, rule=CapacityRule.OVERSIZED_MEMORY,
        # ⚠️ 容量审计恒为 INFO，**不进 severity.compute_severity()**。
        # 它回答的是「能不能省钱」而不是「会不会挂」——
        # 用可靠性的分档去分它会让「有 80% 空闲存储」和「存储快满了」
        # 挤在同一个 HIGH 档里，客户看不出哪个要紧。降配建议的排序
        # 走 scoring/ranking.py 的 value_score，与 severity 是两套序。
        severity=Severity.INFO, cadence="daily", data_date=data_date,
        params={
            "swap_usage_gib": round(swap_gib, 6),
            "memory_usage_pct": candidate.memory_usage_pct,
            "peak_engine_cpu_7d": candidate.peak_cpu_7d,
            "engine_cpu_max_last_day": candidate.engine_cpu_max,
            "threshold_swap_max_gb": cfg.swap_max_gb,
            "threshold_memory_util_max": cfg.memory_util_max,
            "threshold_cpu_max_veto": cfg.cpu_max_veto,
            "is_micro": specs.is_micro(attrs.instance_class),
            "num_cache_nodes": attrs.num_cache_nodes,
        },
    )


AuditFn = Callable[
    [CandidateRecord, ResourceAttrs, CapacityRuleConfig, "date | None"],
    "Finding | None",
]

# 按服务注册。加服务 = 加一个函数 + 一行。
AUDITS: dict[str, tuple[AuditFn, ...]] = {
    "rds": (audit_oversized_storage,),
    "elasticache": (audit_oversized_memory,),
}


def supported_services() -> tuple[str, ...]:
    return tuple(sorted(AUDITS))


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def scan_capacity(
    candidates: Sequence[tuple[CandidateRecord, ResourceAttrs]],
    cfg: CapacityRuleConfig,
    data_date: date | None = None,
) -> list[Finding]:
    """对一批 (指标快照, 属性) 跑容量审计。

    ⚠️ 未注册的服务静默跳过（不抛）—— 老实现也是这个行为，
    但老实现连日志都不打；这里靠返回值的缺席即可观测（调用方能对比输入输出条数）。

    返回顺序稳定：非 micro 在前、按预计节省降序、再按 instance_id。
    micro 沉底是承接老实现的呈现习惯（它们省不下什么钱，混在前面会挤掉值钱的条目）。
    """
    findings: list[Finding] = []
    for candidate, attrs in candidates:
        for fn in AUDITS.get(candidate.service, ()):
            hit = fn(candidate, attrs, cfg, data_date)
            if hit is not None:
                findings.append(hit)
    return sort_capacity_findings(findings)


def sort_capacity_findings(
    findings: Sequence[Finding],
    savings_by_instance: dict[str, float] | None = None,
) -> list[Finding]:
    """micro 沉底，组内按预计月节省降序。

    `savings_by_instance` 缺省时退化为按 instance_id 定序 —— 保证可重放。
    """
    savings = savings_by_instance or {}
    return sorted(
        findings,
        key=lambda f: (
            bool(f.params.get("is_micro")),
            -savings.get(f.instance_id, 0.0),
            f.instance_id,
            str(f.rule.value),
        ),
    )
