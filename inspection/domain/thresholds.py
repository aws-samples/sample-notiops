"""高负载阈值判定（R2.1）。

## 阈值默认值的来源

**迁移自老系统线上实测过的那套**，不是新编的。但两套的存放位置不同：

```
闲置阈值    老系统在 DDB threshold#rds / threshold#elasticache，客户能通过 UI 改
            → 已迁完，12 个键与线上值逐个一致（IdleRuleConfig / CapacityRuleConfig）
高负载阈值  老系统**写死在 prompt 正文里**（appconfig#rds_health 的 4536 字符文本）
            → 客户改不了；要改得去编辑 DDB 里的 prompt
            → 本模块把它们提成配置，这是本文件存在的理由
```

## 一处有意的语义变更：延迟从三档绝对值改为单阈值 + headroom

老 prompt 的 3.2 节是三档：

```
20-50 ms   警告
50-100 ms  严重
> 100 ms   极危
```

我们的分级是 R7.2a 的 headroom 档（≤0.10 CRITICAL / ≤0.20 HIGH / ≤0.35 MEDIUM），
且 R2.4a.1 规定「已越线（headroom ≤ 0）直接判 CRITICAL」。两个模型形状不同，
而 R7.2a 明令「SHALL NOT 留两份判据」。

**取舍（用户 2026-08-19 定，选项甲）：阈值设在「严重」线，放弃 20-50ms 那段。**

```
老 20-50ms  警告   →  不命中（有意放弃）
老 50-100ms 严重   →  命中，headroom 分 MEDIUM/HIGH/CRITICAL
老 >100ms   极危   →  headroom ≤ 0 → CRITICAL，由 DA 判读说清影响面
```

放弃那段是有意的：老系统不稳定的一部分原因就是告警面过宽 —— 那份 prompt 里的
「Top 10-15 限制」「输出密度控制」条款都是在事后压噪音。
被放弃的区间由 DA 的判读覆盖（它能看 `correlated` 与资源角色，
判断 30ms 对**这个**资源算不算急），而 DA SHALL NOT 改 severity（边界①）。

## 没有迁进来的四条

老 prompt 3.3 节这四条**不是阈值判定**，硬塞进来会让 R2.1 的语义从「某指标越线」
变成「模式匹配」：

```
读密集     ReadIOPS > 5000 且读写比 > 5        负载形态分类 → DA 从 correlated 看
写密集     WriteIOPS > 2000 且写读比 > 3       同上
RDS Proxy  DatabaseConnections > 200           架构建议 → 判读结论
降级锁     CPU < 15% AND (读+写 IOPS) < 200    容量审计判据 → CapacityRuleConfig 已有
```
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from enum import Enum

from inspection.domain import metrics_meta
from inspection.domain.scoring.lowdays import count_consecutive_high

# 单位换算。老 prompt 里的数值带单位（MB / GB / ms），而 CloudWatch 返回的是
# 原始单位（Bytes / seconds）。⚠️ 换算写在这里一次，SHALL NOT 散落在判定逻辑里 ——
# 老系统正是因为在 payload_formatter 里换算、在 prompt 里又写一遍单位说明，
# 才需要那条「数据已预转换，报告中直接引用数值即可」的防御条款。
_MB = 1024 * 1024
_GB = 1024 * 1024 * 1024


class ThresholdOutcome(str, Enum):
    """单个指标的阈值判定结果。"""

    HIT = "hit"
    """越线（含刚好等于门槛的反面 —— 见 `crossed()` 的严格不等号）。"""

    PASS = "pass"
    """有数据且未越线。"""

    NO_THRESHOLD = "no_threshold"
    """该指标没配阈值。**不是错误** —— 多数指标只作关联证据，不做判定。"""

    NO_DATA = "no_data"
    """该指标取不到值。⚠️ SHALL NOT 当成 PASS —— 那会让「采不到」冒充「健康」。"""

    UNCLASSIFIED = "unclassified"
    """指标未在 `metrics_meta` 归类方向，无法判断哪边是坏。
    这是**配置错误**，应当在 CI 被 `test_inspection_metrics` 拦下。"""

    NO_DENOMINATOR = "no_denominator"
    """该指标按**规格百分比**判定，但拿不到分母（实例总内存 / 分配存储）。

    ⚠️ SHALL NOT 当成 PASS，也 SHALL NOT 静默跳过 —— 两者都会让
    「这台的内存判定根本没跑」冒充「这台内存健康」。
    调用方（`assemble`）看到它会产出一条 INFO 的 `no_capacity_metadata`
    结构性 finding，让这个判定盲区在看板上可见。

    典型成因：`ResourceAttrs.memory_bytes` 需要 `ec2:DescribeInstanceTypes`
    补全（`attrs_repo._MEMORY_NOTE`），那个调用失败或无权限时就是 None。
    """

    COMPANION_NOT_MET = "companion_not_met"
    """主指标越线了，但**伴随条件**不成立 —— 按设计不算命中（见 `COMPANIONS`）。

    ⚠️ 与 `PASS` 分开是刻意的：PASS 是「这个指标没事」，
    COMPANION_NOT_MET 是「这个指标越线了但那不构成问题」。
    两者对客户是不同的话，而且后者需要能解释**为什么越线了却不报**
    —— 合并成 PASS 会让「可用内存 1.3%」这种数字在报告上凭空消失，
    客户下次自己看 CloudWatch 时会以为我们漏了。

    2026-08-23 真实客户数据（73 台 RDS/Aurora）：
    ```
    可用内存 <20% 单独判        39/73  53%   ← 改之前的误报率
    <10% ∧ ReadIOPS>20 IOPS/s   8/73  11%   ← 命中的 8 台全在实质回盘读
    ```
    被抑制掉的那批 Free% 更低（0.6%~3.8%）但 ReadIOPS ≤10 ——
    MySQL 的 buffer pool 默认吃掉 75% 内存且不计入 `MemAvailable`，
    所以低可用内存是**设计稳态**，不是故障。
    """


@dataclass(frozen=True)
class Capacity:
    """百分比类阈值的**分母**（规格归一化用）。

    🔴 全部允许 `None`。拿不到分母时该指标判 `NO_DENOMINATOR`，
    **不是** PASS、也不是静默跳过 —— 后两者都让「没判」冒充「健康」。

    ⚠️ `memory_bytes` 常常是 None：它需要 `ec2:DescribeInstanceTypes`
    补全（RDS/ElastiCache 的 API 都不返回实例内存），那一步失败或无权限
    就拿不到。`allocated_storage_bytes` 相反，RDS 的 `DescribeDBInstances`
    直接给 `AllocatedStorage`，基本总有。
    """

    memory_bytes: float | None = None
    allocated_storage_bytes: float | None = None

    def of(self, key: str) -> float | None:
        """按分母名取值。非正数按 None 处理 —— 0 做分母会抛 ZeroDivisionError，
        而负数算出来的百分比方向是反的（比抛异常更糟）。"""
        v = getattr(self, key, None)
        if v is None:
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return f if f > 0 else None


# 按规格百分比判定的指标 → 分母字段名（`Capacity` 的属性）。
#
# 🔴 只有这几个是百分比。其余（CPU 类本来就是 %、延迟是绝对秒、
# Evictions 是计数、SwapUsage 是噪音门槛）都按原值判。
#
# ⚠️ 加一个条目就必须同时把对应的阈值字段改成 `%` 量纲 ——
# `test_inspection_thresholds.py` 有断言比对两者。
_PCT_DENOMINATOR: Mapping[str, str] = {
    "FreeableMemory": "memory_bytes",
    "FreeStorageSpace": "allocated_storage_bytes",
}


ENGINE_VARIANTS: Mapping[str, Mapping[str, str]] = {
    "aurora": {
        "read_latency_seconds": "read_latency_seconds_aurora",
        "write_latency_seconds": "write_latency_seconds_aurora",
    },
}
"""按引擎分档的阈值字段：`引擎档位 → {基础字段: 该档位用的字段}`。

`ThresholdRuleConfig.for_engine()` 在判定入口把基础字段的值换成对应档位的值，
于是判定层（`evaluate_metric` / `_THRESHOLD_BY_METRIC_FIELD`）一行都不用改。

## 只有 latency 在这里

2026-08-23 拿两个客户 73 台 RDS/Aurora 逐字段比对分布，只有 latency 真的分叉：

```
字段                 Aurora        社区版 RDS      分档？
read_latency         p90 3.83ms    p90 10.0ms      ✅ 差一个数量级
write_latency        max 3.52ms    p99 556ms       ✅ 同上
cpu_utilization      >70% 4%       >70% 4%         ❌ 一样
freeable_memory_pct  p50 25.4%     p50 12.6%       ❌ 靠伴随条件解决
disk_queue_depth     >10 12%       >10 10%         ❌ 一样
swap_usage_bytes     4~5%          同               ❌ 一样
```

⚠️ 加条目前先看分布**是否真的分叉**。不分叉却分档的代价是配置页多一行、
客户多一个要理解的概念，而判定结果一模一样。

⚠️ 这张表同时是 `test_inspection_rule_config.py` 反查「一个指标的多个阈值
字段」的依据 —— `_THRESHOLD_BY_METRIC_FIELD` 是单射（一个指标一个字段），
分档字段不在里面，测试靠这张表把它们归到同一个指标下比对 services 并集。
"""


def engine_variant_key(engine: str) -> str:
    """引擎名 → `ENGINE_VARIANTS` 的档位键。认不出返回空串（= 用基础档）。"""
    return "aurora" if (engine or "").strip().lower().startswith("aurora") else ""


@dataclass(frozen=True)
class Companion:
    """伴随条件：主指标越线**且**这个指标也越线，才算真命中。

    ⚠️ 这不是「多一个阈值」，而是把「越线」与「构成问题」拆开。
    单指标判定在两种情况下会说同样的话，而它们的处置完全相反：

    ```
    可用内存 1.1% + ReadIOPS 492/s  → 工作集放不下，要升配或调查询
    可用内存 1.3% + ReadIOPS 0.07/s → buffer pool 正常占用，什么都不用做
    ```
    """

    metric: str
    """伴随指标的 CloudWatch 名。方向取自 `metrics_meta`，不在这里编码。"""
    field: str
    """`ThresholdRuleConfig` 上的阈值字段名。"""
    why: str
    """为什么需要这个条件 —— 会进报告，让「越线却不报」能被解释。"""


COMPANIONS: Mapping[str, Companion] = {
    "FreeableMemory": Companion(
        metric="ReadIOPS",
        field="memory_read_iops_min",
        why="可用内存低但没有回盘读 —— InnoDB buffer pool 默认占 75% 内存"
            "且不计入 MemAvailable，属正常稳态",
    ),
    "Evictions": Companion(
        metric="DatabaseMemoryUsagePercentage",
        field="database_memory_usage_pct",
        why="有驱逐但内存未接近上限 —— maxmemory-policy 为 LRU 时"
            "驱逐是设计行为，不是容量不足",
    ),
}
"""需要伴随条件的指标。

## 为什么只有这两个

判据是「**单看这个指标会把设计行为误判成故障**」：

```
FreeableMemory   MySQL 默认 innodb_buffer_pool_size = {DBInstanceClassMemory*3/4}
                 那 75% 是进程私有匿名内存，不计入 MemAvailable
                 → 健康的 MySQL 稳态就在 10% 上下（实测 49 台 p50=12.6%）

Evictions        allkeys-lru / volatile-lru 策略下驱逐**就是**缓存在正常工作
                 → 实测 79 个节点里有驱逐的 6 台全部内存 >90%，
                   组合判据一条不漏且排除了正常 LRU
```

CPU、延迟、队列深度都不属于这一类 —— 它们越线本身就是问题。

⚠️ 加条目前先问：**这个指标越线时存在"正常"的解释吗？** 答案是否就别加，
否则伴随条件会变成一道悄悄吃掉真告警的闸门。
"""


@dataclass(frozen=True)
class MetricVerdict:
    """一个 (实例, 指标) 的判定。`headroom` 仅在有数据且有阈值时非 None。

    ⚠️ 百分比类指标（见 `_PCT_DENOMINATOR`）的 `value` 是**换算后的百分比**，
    与 `threshold` 同量纲 —— headroom 的计算依赖这一点。原始观测值放在
    `raw_value`，分母放在 `denominator`，两者供 UI 显示
    「可用内存 15.2%（1.2 GB / 8 GB）」和给 DA 溯源。
    """

    instance_id: str
    metric: str
    outcome: ThresholdOutcome
    value: float | None = None
    threshold: float | None = None
    headroom: float | None = None
    stat: str = ""
    direction: str = ""
    raw_value: float | None = None
    """原始观测值。非百分比类指标上它与 `value` 相同。"""
    denominator: float | None = None
    """百分比类指标的分母（字节）。非百分比类为 None。"""
    denominator_key: str = ""
    """缺分母时告诉调用方缺的是**哪个** —— 「拿不到规格内存」与
    「拿不到分配存储」的处理动作不同（前者补 EC2 权限，后者是 API 异常）。"""
    companion_metric: str = ""
    """伴随指标名（见 `COMPANIONS`）。没有伴随条件的指标为空。"""
    companion_value: float | None = None
    """伴随指标的实测值。`COMPANION_NOT_MET` 时它是「为什么不报」的证据，
    HIT 时它是「为什么这次是真的」的证据 —— 两种情况都要能写进报告。

    ⚠️ 也可能是 None：伴随指标本身采不到。那时**按命中处理**（见
    `evaluate_metric`）—— 抑制机制不能因为缺数据而吃掉真告警。"""
    companion_threshold: float | None = None
    """伴随条件的门槛，供报告写成「ReadIOPS 0.07/s，门槛 20/s」。"""

    @property
    def hit(self) -> bool:
        return self.outcome is ThresholdOutcome.HIT

    @property
    def is_pct(self) -> bool:
        return self.metric in _PCT_DENOMINATOR

    @property
    def suppressed_by_companion(self) -> bool:
        """越线了但伴随条件不成立。报告要把它与 PASS 区别对待。"""
        return self.outcome is ThresholdOutcome.COMPANION_NOT_MET


@dataclass(frozen=True)
class InstanceVerdict:
    """一台实例的阈值判定汇总。

    R2.1 是 **OR 语义**：任一指标越线即命中（与 R2.2 闲置的 AND 语义相反）。
    """

    instance_id: str
    verdicts: tuple[MetricVerdict, ...] = ()
    coverage_days: int = 0
    metric_coverage: Mapping[str, int] = field(default_factory=dict)
    """`{指标: 该指标本窗口有数据的天数}`。

    ⚠️ 与 `coverage_days`（实例级、跨指标最大值）是**两件事**。
    载荷 `judgment.coverage_days` 要写的是**这条 finding 那个指标**的天数 ——
    写实例级的会让 DA 读成「7 天里连续 5 天」，而那个指标只有 5 天数据。
    """
    chronic_days: Mapping[str, int] = field(default_factory=dict)
    """R2.6 慢性高位命中的 `{指标: 连续天数}`。**只放命中的**（天数 ≥ 门槛）。

    ⚠️ 空 dict 有两种来源，对下游是同一个值但含义不同：
    ```
    调用方没传 daily     我们不知道有没有慢性
    传了但都没到门槛      确实没有慢性
    ```
    两者都不该让调用方误以为「已确认无慢性」，所以判断慢性 SHALL 用
    `bool(chronic_days)` 而不是 `chronic_days == {}` 之类的等值比较。
    """

    @property
    def hits(self) -> tuple[MetricVerdict, ...]:
        return tuple(v for v in self.verdicts if v.hit)

    @property
    def hit(self) -> bool:
        return bool(self.hits)

    @property
    def worst(self) -> MetricVerdict | None:
        """headroom 最小的那条命中 —— 派发载荷的 `judgment` 段取它。

        ⚠️ headroom 为 None 的命中（阈值为 0 等无法计算余量的情况）排在最前，
        因为「越线但算不出余量」不该被「越线且余量 -0.1」盖过去。
        """
        hs = self.hits
        if not hs:
            return None
        return min(hs, key=lambda v: (v.headroom is not None,
                                      v.headroom if v.headroom is not None else 0.0))

    @property
    def chronic_worst(self) -> MetricVerdict | None:
        """慢性天数最多那个指标的 `MetricVerdict`（`hit` 可能是 False）。

        ## 为什么需要它

        慢性高位可以**单独命中**（`hit=False` 而 `chronic=True`）——
        `FreeableMemory` 长期贴着门槛但当天没越线、或者伴随条件把当天的判定
        压掉了。那时 `worst` 是 `None`，而调用方拿它取载荷的 `judgment` 段。

        🔴 `assemble` 原来的兜底是 `metrics[0]`（alerting 清单的第 0 项，
        通常是 `CPUUtilization`），后果是一条彻底错位的 finding：

        ```
        finding_id  …#threshold_high#CPUUtilization      ← 错的指标
        judgment    {"metric":"CPUUtilization",
                     "value":null,"threshold":null,       ← 全空
                     "consecutive_high_days":7}
        daily       CPU 的日序列（健康的）                 ← 与 hit_reason 矛盾
        ```

        页面上是一条 HIGH 的「CPU 使用率」卡片、**没有任何数字**，而真相是
        内存慢性低位。DA 拿到的是一组自相矛盾的证据。

        ⚠️ `severity_for_verdict` 对同一情形**是对的**
        （`max(verdict.chronic_days, key=...)`），`payload_hit_reasons` 的
        docstring 也明写「judgment 段 SHALL 取慢性那个指标」—— 只有 assemble
        那一处没照做。这个 property 让三处口径收敛到一个地方。

        ⚠️ 返回的 `MetricVerdict` 里 value / threshold / headroom /
        companion_* 都是**已经算好的**（`verdicts` 存的是全部指标，不只命中的），
        所以调用方不需要重算 —— 那正是那些字段为 null 的根因：它们只从
        `worst` 取，而 `worst` 恒 None。
        """
        if not self.chronic_days:
            return None
        m = max(self.chronic_days, key=lambda k: self.chronic_days[k])
        return next((v for v in self.verdicts if v.metric == m), None)

    @property
    def missing_denominator(self) -> tuple[MetricVerdict, ...]:
        """按规格百分比判定但拿不到分母的那些指标。

        🔴 调用方 SHALL 把它变成一条可见的 finding
        （`assemble` 产 INFO 的 `no_capacity_metadata`）。
        丢掉它的表现是**内存告警对这台实例永久静默**，而看板上一切正常 ——
        「没有内存告警」被读成「内存健康」。
        """
        return tuple(
            v for v in self.verdicts
            if v.outcome is ThresholdOutcome.NO_DENOMINATOR
        )

    @property
    def chronic(self) -> bool:
        """是否命中慢性高位（R2.6）。"""
        return bool(self.chronic_days)

    @property
    def chronic_worst_days(self) -> int:
        """最长的连续天数 —— 进载荷 judgment 的 `consecutive_high_days`。"""
        return max(self.chronic_days.values(), default=0)

    @property
    def insufficient_data(self) -> bool:
        """全部有阈值的指标都判不了 —— 这台实例本轮没有可判定的证据。

        ⚠️ 与「PASS」区分开：调用方 SHALL NOT 把它当成健康，
        也 SHALL NOT 据此把上一轮的 finding 判 resolved（R6.2）。

        🔴 `NO_DENOMINATOR` 也算「判不了」。漏掉它的表现很隐蔽：一台
        **既取不到指标又缺规格**的实例会得到 `insufficient_data=False`
        （因为有一条 verdict 不是 NO_DATA），于是 `evaluable=True`
        → 它进了评估集合 → 未命中 → 上一轮的 finding 被判 **resolved**。
        那正是 R6.2 要防的入口，而且完全静默。
        """
        judged = [v for v in self.verdicts
                  if v.outcome is not ThresholdOutcome.NO_THRESHOLD]
        undecidable = (ThresholdOutcome.NO_DATA, ThresholdOutcome.NO_DENOMINATOR)
        return bool(judged) and all(v.outcome in undecidable for v in judged)

    @property
    def coverage_too_low(self) -> bool:
        """coverage 不足 `min_coverage_days`，`evaluate_threshold` 直接返回了空。

        ⚠️ 与 `insufficient_data` 是**两件事**，不能合并：
        ```
        coverage_too_low   窗口里没几天有数据 —— 连「取不到」都谈不上
        insufficient_data  取了，每个指标都返回 NO_DATA
        ```
        两者对判定的结论相同（不产 finding），但对**评估集合**的影响相同而
        对运维的提示不同：前者是「这台刚建/刚恢复」，后者是
        「指标名或维度可能写错了」（R3.5 的可观测性缺口）。

        ⚠️ 早期只有 `insufficient_data`，而 coverage 不足时 `verdicts` 为空
        → `bool(judged)` 为 False → **返回 False**。于是调用方问「这台能判吗」
        得到「能」，进而把它算进评估集合 → 未命中 → 上一轮的 finding 被判 resolved。
        那正是 R6.2 要防的入口，而且完全静默。
        """
        return not self.verdicts

    @property
    def evaluable(self) -> bool:
        """这台实例本轮是否**真的被评估过**（R6.2a 的评估集合判据）。

        调用方 SHALL 用它决定「要不要把这台放进评估集合」，
        SHALL NOT 用 `not verdict.hit` 之类的取反 —— 那会把
        「没能评估」与「评估了且健康」混成一个值。
        """
        return not self.coverage_too_low and not self.insufficient_data


@dataclass(frozen=True)
class ThresholdRuleConfig:
    """高负载阈值（R2.1）。**全部显式写死，不留空**（R2.4a 的「缺一个实现者就会自己猜」）。

    默认值迁移自老系统 `appconfig#rds_health` / `appconfig#elasticache_health`
    的 prompt 正文第 3 节。每条都标注了老 prompt 里的原文判据。
    """

    # ── RDS / Aurora ────────────────────────────────────────────────────────
    cpu_utilization: float = 70.0
    """老 3.1「CPU 严重瓶颈：CPUUtilization > 70%」。

    ⚠️ **对 T 系实例这个指标会骗人。** credit 耗尽后 CPU 被硬压到 baseline
    （t4g 是 10%~40% 视规格），此时「CPU 只有 30%」与「CPU 打满」是同一件事
    —— 而 30% 远低于 70%，这条规则一声不响。T 系要看
    `cpu_credit_balance_min`。实测真实客户 49 台 RDS 里 18 台（37%）是 T 系，
    其中 7 台 t4g.micro。"""

    cpu_credit_balance_min: float = 10.0
    """T 系实例的 CPU credit 余额下限（单位 credits = vCPU-minutes）。

    🔴 **只对 burstable 实例判定** —— `assemble.high_load_findings` 里按
    `specs.is_burstable(instance_class)` 决定要不要把这个指标加进本轮判定。

    ## 为什么不放进 `ALERTING_METRICS`

    `metrics_meta` 有一条明确的准入门槛（R3.8b）：「任何『只有某些实例 /
    某些版本 / 某个角色才有』的指标一律放 CORRELATION，否则每天会为每台
    不满足条件的实例产出一条永远修不好的缺口，把真信号淹掉」，并且点名
    `CPUCreditBalance 只有 T 系有`。

    所以它留在 CORRELATION（采集侧照采），判定侧按机型逐台加入。
    这样非 T 系压根不判 → 零缺口，既拿到了判定又没违反那条门槛。

    ## 10 这个数

    credit 的单位是 vCPU-minutes，10 credits = 单 vCPU 满载 10 分钟的余量。
    对任何 T 系规格来说,剩 10 分钟 burst 都已经是「随时被压到 baseline」。

    ⚠️ **这个值没有真实数据校准** —— 客户导出的指标里没有这一列。它是按
    单位语义推的，属于本次校准里唯一一个「有依据但未实测」的数字。
    首轮上线后应当拿实际命中率复核。

    ⚠️ 方向是 `bad_down`（`metrics_meta` 里已标 `_DOWN`），统计量是**日
    Minimum** —— credit 白天耗夜里回，日均完全健康而每天下午撞零，
    只有日 min 说得出真相。"""

    freeable_memory_pct: float = 10.0
    """可用内存低于**实例总内存的**这个百分比即命中（还需伴随条件，见下）。

    🔴 **从绝对值改成百分比**（用户 2026-08-23 定）。老系统与本表第一版都是
    「< 500 MB」，而那个数在机型跨度大的账号里两端都错：

    ```
    db.t4g.micro     1 GB 内存   → 用掉一半就告警        噪音
    db.r6g.16xlarge  512 GB 内存 → 用到 99.9% 才告警      漏报
    ```

    🔴 **20% → 10%，并加伴随条件**（真实客户数据校准，2026-08-23）。

    R2.1.2 的原文是「FreeableMemory 低于实例内存 20%」，但拿两个客户
    73 台 RDS/Aurora 的实测值一比，20% 压在**正常水位上**：

    ```
                     n     min    p10     p50     <10%   <20%
    Aurora          24    5.9%   8.1%   25.4%     17%    21%
    RDS(社区版)     49    0.6%   1.3%   12.6%     35%    69%
    ```

    成因是确定的：MySQL 默认 `innodb_buffer_pool_size =
    {DBInstanceClassMemory*3/4}`（`describe-engine-default-parameters`
    的字面值），那 75% 是**进程私有匿名内存**，而 `FreeableMemory` 的
    官方定义是 `/proc/meminfo` 的 `MemAvailable` —— 私有匿名内存不计入。
    所以健康的社区版 MySQL 稳态就在 10% 上下。

    ⚠️ 只降到 10% 还不够，因为 10% 单独判仍有 29% 命中率。真正的判据是
    **官方那一条**：Best Practices「DB instance RAM recommendations」全节
    只提一个指标 —— 「To tell if your working set is almost all in memory,
    check the **ReadIOPS** metric」。见 `memory_read_iops_min`。

    ```
    <20% 单独判              39/73  53%
    <10% ∧ ReadIOPS>20      8/73  11%   ← 命中的 8 台全在实质回盘读
    < 5% ∧ ReadIOPS>20      3/73   4%   ← 会漏掉 6.9% + 265 IOPS/s 那台
    ```

    所以 10% 而不是 5% —— **靠伴随条件收紧，不靠压低百分比**。压低会漏掉
    「内存不算最低但确实在回盘读」的那类，而那类恰恰是真问题。

    ⚠️ 分母 `ResourceAttrs.memory_bytes` 可能为 None（需要
    `ec2:DescribeInstanceTypes` 补全）→ 判 `NO_DENOMINATOR`，
    调用方产出 INFO 的 `no_capacity_metadata` finding。**不静默跳过。**"""

    memory_read_iops_min: float = 20.0
    """`FreeableMemory` 的伴随门槛：ReadIOPS 高于这个值才算真的内存不足。

    量纲是 **IOPS/s**（`metrics_meta` 里 `ReadIOPS` 的统计量是 `Average`，
    不是 Sum）。⚠️ 拿 CloudWatch 控制台的 Sum 值直接填会差 4 个数量级。

    20 这个数来自实测的分界点 —— 它是唯一让"内存充裕组"零假阳性的档：

    ```
    阈值        低内存组命中      内存充裕组（应为 0）
    > 5 IOPS/s     14/21              1/21     ← 有假阳性
    >10 IOPS/s     13/21              1/21     ← 有假阳性
    >20 IOPS/s      8/21              0/21     ← 定这个
    >50 IOPS/s      4/21              0/21     ← 开始漏真问题
    ```

    命中的 8 台实测 21.6 ~ 491.7 IOPS/s；被抑制的那批 Free% 更低
    （0.6%~3.8%）但 ReadIOPS ≤10 —— buffer pool 正常占用。

    ⚠️ ReadIOPS 采不到时**按命中处理**（`evaluate_metric` 里
    `companion_value is None` 的分支）。抑制机制不能因为缺数据吃掉真告警。"""

    free_storage_pct: float = 15.0
    """可用存储低于**分配存储的**这个百分比即命中（仅普通 RDS）。

    🔴 同样从绝对值（5 GB）改成百分比。5GB / 50GB = 10%，50GB 是
    `DescribeDBInstances` 默认分配量的常见档。

    🔴 **10 → 15**（2026-08-23）。对齐 AWS Best Practices 里唯一给了硬数字
    的那条：「Investigate disk space consumption if space used is
    **consistently at or above 85 percent** of the total disk space」——
    85% 已用 = 15% 可用。

    ⚠️ 这一维要比官方**更早**而不是更晚触发，所以是往上调而不是往下：
    存储写满是硬故障（实例进 `storage-full` 直接不可用），而且 RDS 存储
    **只能加不能减** —— 早一点发现的代价只是多看一眼，晚一点的代价是
    一次不可逆的扩容或一次停机。

    ⚠️ Aurora 没有此指标（用集群卷），判定落到 NO_DATA 而不是误报 ——
    `metrics_meta` 已把它标为普通 RDS 专属。
    ⚠️ 分母 `allocated_storage_gb` 由 RDS API 直给，基本总有；
    拿不到时同样走 `NO_DENOMINATOR`。"""

    read_latency_seconds: float = 0.015
    """**普通 RDS** 的读延迟上限。⚠️ CloudWatch 的 ReadLatency 单位是**秒**。

    🔴 **50ms → 15ms**（2026-08-23 真实数据校准）。50ms 是老 prompt 的
    「严重」线，而它在真实数据上是一条**死规则**：

    ```
                      p50      p90      p99     max     >50ms
    Aurora (24 台)   1.69ms   3.83ms   7.42ms  7.42ms    0%
    RDS    (49 台)   1.44ms   10.0ms   20.0ms  20.0ms    0%
    ```

    gp3 官方标称 single-digit millisecond、io2 Block Express 是
    sub-millisecond。50ms 时早已出事很久。

    15ms 在社区版 RDS 上命中 2%（p90 正好在 10ms，说明确有一批偏高）。

    ⚠️ Aurora 用 `read_latency_seconds_aurora`（见下）—— 一个数管不了
    两种引擎，Aurora 的 max 只有 7.42ms。"""

    read_latency_seconds_aurora: float = 0.005
    """**Aurora** 的读延迟上限。

    Aurora 的存储层是共享分布式存储，读延迟分布与社区版差一个数量级
    （p90 3.83ms vs 10.0ms）。用 15ms 判 Aurora 等于不判 —— 实测 24 台
    Aurora 里连 5ms 都只有 2 台越过。

    5ms 相对 p90 (3.83ms) 有 30% 余量，是合理的异常线。

    ⚠️ 这批 Aurora 都健康，所以它在**当前数据上** 0 命中 —— 那不等于
    死规则：死规则是「任何真实异常都触发不了」，而这条在 Aurora 真出问题
    时会响。判据是「相对该引擎的正常分布有多少余量」，不是「现在有没有命中」。"""

    write_latency_seconds: float = 0.030
    """**普通 RDS** 的写延迟上限。

    🔴 **50ms → 30ms**。写延迟是这批真实数据里**唯一抓到确凿问题**的维度：

    ```
                      p50      p90      p99      max      >50ms   >30ms
    Aurora (24 台)   0.29ms   2.22ms   3.52ms   3.52ms     0%      0%
    RDS    (49 台)   3.63ms   27.9ms   556ms    556ms      4%      ~6%
    ```

    p99 = **556 毫秒**。那两台很可能是 gp2 burst 耗尽或 t 系 credit 枯竭。
    50ms 只抓到 2 台，漏掉 p90 那批（27.9ms）。"""

    write_latency_seconds_aurora: float = 0.010
    """**Aurora** 的写延迟上限。实测 max 只有 3.52ms，10ms 有近 3 倍余量。"""

    disk_queue_depth: float = 10.0
    """老 3.2「严重：DQD > 10」。

    ⚠️ **不按引擎分档**，实测两种引擎的分布几乎一样：
    Aurora >10 命中 3/24（12%）、社区版 RDS 5/49（10%）。
    分档只在分布真的分叉时才有意义（见 latency 那两对）。"""

    # ── ElastiCache ─────────────────────────────────────────────────────────
    engine_cpu_utilization: float = 70.0
    """Redis/Valkey 的引擎核 CPU。⚠️ 与 `cpu_utilization` 分开配：
    引擎单线程，同一个百分比的含义与主机均值不同（≥4 vCPU 时看引擎核，
    1-2 vCPU 时看主机 —— 判读侧的选择见 high-load skill）。
    Memcached 没有此指标 → NO_DATA。"""

    database_memory_usage_pct: float = 90.0
    """Redis/Valkey 内存占用百分比。老 EC prompt 未给高负载门槛
    （它只有 `memory_util_max 30` 那个**闲置**判据），故取 90 ——
    官方在数据分层文档里以「可用内存 <5% 开始淘汰」为界，
    留出余量后 90% 是保守值。⚠️ 这是本表**唯一没有老系统对应值**的一项。"""

    memory_fragmentation_ratio: float = 3.0
    """Redis/Valkey 内存碎片率（`used_memory_rss / used_memory`）上限。

    🔴 **此前完全没采这个指标**（2026-08-23 补齐）。实测两个客户 141 个节点：

    ```
                  >1.5    >2.0    >3.0    >5.0
    账号 A          10%      3%      0%      0%
    账号 B          47%     34%     11%      8%     p99 = 21.79
    ```

    定 3.0 而不是通常说的 1.5 —— 1.5 在账号 B 上命中 47%，那个量级的
    报告没人看。3.0 命中 11%，且 >3 时内存浪费已经超过两倍、有 OOM 风险。

    ⚠️ **不做 `<1.0` 的判据**（v1）。`<1.0` 意味着 `used_memory >
    used_memory_rss`，理论上是「数据被换出」比高碎片更严重，但账号 A 有 26%
    的节点 <1.0 而 swap 只有 3 台超 50MB —— 小数据量节点上这个比率本身
    不稳定（min 实测 0.07）。留作 correlated 证据交给判读，不做触发条件。

    ⚠️ Memcached 没有这个指标（slab 分配器不暴露该比率），所以
    `rule_limits` 那侧标了 `services=(REDIS,)`，`ALERTING_METRICS` 也只在
    REDIS 清单里 —— 三处要一致，否则会出现「Memcached 上永远 NO_DATA
    却在配置页上占一行」。"""

    evictions: float = 0.0
    """淘汰数。> 0 即命中 —— 与闲置侧的 `evictions=0` 是同一个数，
    但语义相反（闲置要求恒为 0，高负载要求出现即报）。

    🔴 **加了伴随条件**（`COMPANIONS`）：还需 `DatabaseMemoryUsagePercentage`
    也越线（>90%）才算命中。单看驱逐数分不出「LRU 按设计工作」和
    「容量不够」—— 实测 79 个节点里有驱逐的 6 台**全部**内存 >90%，
    组合判据一条不漏且排除了正常 LRU。"""

    swap_usage_bytes: float = 50 * _MB
    """Redis 开始 swap 就已经在降级。⚠️ 与 `CapacityRuleConfig.swap_max_gb`
    （0.01 GB ≈ 10MB，用于容量审计的降配否决）不是同一个门槛，
    也不该是 —— 那边是「有一点 swap 就别降配」，这边是「swap 到这个量级要报警」。"""

    # ── 覆盖度门槛 ──────────────────────────────────────────────────────────
    min_coverage_days: int = 5
    """coverage 少于此值 SHALL NOT 产生 finding（R2.1 与 1.12 的
    INSUFFICIENT_DATA 路径）。⚠️ 也 SHALL NOT 把已有 finding 判 resolved。"""

    # ── 慢性高位（R2.6）────────────────────────────────────────────────────
    chronic_days_min: int = 5
    """R2.6.1：水位连续超门槛达 N 天即命中慢性高位。**不看斜率。**

    这是 v1 唯一的「持续性」规则，作用是兜住渐进式劣化里最危险的那一类：
    `FreeableMemory` 掉到 800MB 后横在那里三周 —— 斜率归零，趋势规则也不会命中，
    但它已经在压力平衡点上，任一流量尖峰即 OOM。**横在坏水位比缓慢下降更危险。**"""

    chronic_min_coverage: int = 7
    """R2.6.1 的准入门槛：coverage 不足 7 天 SHALL NOT 判慢性。

    ⚠️ 比 `min_coverage_days`（5）更严，因为慢性是「持续 N 天」的断言 ——
    只有 5 天数据却说「持续 5 天」，那句话的置信度和 12 天数据里的 5 天完全不同。
    ⚠️ coverage 不足时 SHALL NOT 报 INSUFFICIENT_DATA：慢性附属于 R2.1，
    主判定自己已经处理了数据不足，再报一次是重复噪音（R2.6.2）。"""

    # 百分比字段：必须落在 (0, 100]。
    #
    # ⚠️ `freeable_memory_pct` / `free_storage_pct` 进这一组是关键 ——
    #    它们改成百分比之后，一个手填的 500000000（客户以为还是字节）
    #    必须被**拒**而不是当成 5 亿个百分点静默接受。
    _PCT_FIELDS = ("cpu_utilization", "engine_cpu_utilization",
                   "database_memory_usage_pct",
                   "freeable_memory_pct", "free_storage_pct")
    # 非负字段：0 是合法门槛（`evictions=0` 表示「出现即报」），负数不是。
    _NON_NEGATIVE_FIELDS = ("read_latency_seconds", "write_latency_seconds",
                            "disk_queue_depth", "evictions", "swap_usage_bytes",
                            # 伴随门槛（IOPS/s）。0 是合法值 —— 等于关掉抑制，
                            # 回到「只看可用内存」的老行为。负数无意义。
                            "memory_read_iops_min",
                            # Aurora 那两档 latency（`for_engine` 运行时选）。
                            # ⚠️ 漏登记的表现是客户能在 Aurora 页填负数，
                            #    而 `crossed()` 对负门槛恒成立 → 每台 Aurora
                            #    每天一条 latency 告警。
                            "read_latency_seconds_aurora",
                            "write_latency_seconds_aurora",
                            # 碎片率是 rss/used 的比值，恒 > 0；负数无意义。
                            "memory_fragmentation_ratio",
                            # credit 余额恒 ≥ 0（耗尽就是 0，借贷记在
                            # CPUSurplusCreditBalance 里）。
                            "cpu_credit_balance_min")
    # 天数类：必须为正。0 天会让「连续 0 天」恒真 → 每台实例都判慢性。
    _POSITIVE_DAY_FIELDS = ("min_coverage_days", "chronic_days_min",
                            "chronic_min_coverage")

    def __post_init__(self) -> None:
        for name in self._POSITIVE_DAY_FIELDS:
            if getattr(self, name) <= 0:
                raise ValueError(f"{name} must be positive")
        # ⚠️ 慢性的准入 coverage 不得低于「连续天数」本身 ——
        # `chronic_days_min=5` 而 `chronic_min_coverage=3` 时，
        # 「连续 5 天」在只有 3 天数据的窗口里永远数不出来，规则静默永不命中。
        if self.chronic_min_coverage < self.chronic_days_min:
            raise ValueError(
                f"chronic_min_coverage ({self.chronic_min_coverage}) 不得小于 "
                f"chronic_days_min ({self.chronic_days_min}) —— "
                "否则「连续 N 天」在窗口里永远数不出来，规则静默永不命中"
            )
        for name in self._PCT_FIELDS:
            v = getattr(self, name)
            if not 0.0 < v <= 100.0:
                raise ValueError(f"{name} must be a percentage in (0, 100], got {v}")
        # ⚠️ 这一段原本不存在，7 个绝对值阈值负数全放行。阈值是**客户可改**的
        # （R2.1：从 UI 下发），而负数门槛的后果按方向分两种，都很糟：
        #
        #   bad_up   指标（ReadLatency / DiskQueueDepth / Evictions）
        #            value > -1  → 恒真 → 每台实例每天都报「严重」
        #   bad_down 指标（FreeableMemory / FreeStorageSpace）
        #            value < -1  → 恒假 → 内存耗尽也永不告警
        #
        # 前者是噪音，后者是**漏报**，而且都不会有任何错误信号。
        for name in self._NON_NEGATIVE_FIELDS:
            v = getattr(self, name)
            if v < 0:
                raise ValueError(f"{name} must be non-negative, got {v}")

    def threshold_for(self, metric: str) -> float | None:
        """指标名 → 门槛。没配返回 None（**不是 0** —— 0 是合法门槛）。"""
        return _THRESHOLD_BY_METRIC_FIELD.get(metric) and getattr(
            self, _THRESHOLD_BY_METRIC_FIELD[metric]
        )

    def for_engine(self, engine: str) -> ThresholdRuleConfig:
        """按引擎选出该用的那套阈值。非 Aurora 原样返回（`self`）。

        ## 为什么用「换一份 cfg」而不是给判定函数加 engine 参数

        判定层（`evaluate_metric` / `evaluate_chronic` / `_THRESHOLD_BY_METRIC_FIELD`）
        一行都不用改 —— 它们照旧读 `cfg.read_latency_seconds`，只是拿到的
        cfg 已经是"这台实例该用的那份"。给每个判定函数加一个 engine 参数
        会让引擎判断散到十几个调用点，而漏掉一个的表现是**那台实例用了
        另一种引擎的阈值**且不报错。

        ## 为什么只有 latency 分档

        2026-08-23 真实数据（73 台 RDS/Aurora）逐字段比对，只有 latency 的
        分布真的分叉：

        ```
        字段                 Aurora           社区版 RDS        分档？
        read_latency         p90 3.83ms       p90 10.0ms        ✅ 差一个数量级
        write_latency        max 3.52ms       p99 556ms         ✅ 同上
        cpu_utilization      >70% 4%          >70% 4%           ❌ 一样
        freeable_memory_pct  p50 25.4%        p50 12.6%         ❌ 靠伴随条件解决
        disk_queue_depth     >10 12%          >10 10%           ❌ 一样
        swap_usage_bytes     命中 4~5%        同                ❌ 一样
        ```

        ⚠️ 加字段前先看分布**是否真的分叉**。不分叉却分档的代价是配置页多
        一行、客户多一个要理解的概念，而判定结果一模一样。
        """
        variants = ENGINE_VARIANTS.get(engine_variant_key(engine))
        if not variants:
            return self
        return replace(self, **{base: getattr(self, alt)
                                for base, alt in variants.items()})


# 指标名 → `ThresholdRuleConfig` 字段名。
# ⚠️ 键必须是 `metrics_meta` 里真实存在的指标名 —— 拼错的键会静默变成「该指标没配阈值」，
# 于是整条规则永不命中且不报错。`tests/test_inspection_thresholds.py` 有断言守住这点。
_THRESHOLD_BY_METRIC_FIELD: Mapping[str, str] = {
    # RDS / Aurora
    "CPUUtilization": "cpu_utilization",
    # ⚠️ 只对 T 系实例生效 —— 它留在 `CORRELATION_METRICS`（因为非 T 系没有
    #    这个指标），由 `assemble` 按机型逐台加进判定清单。
    "CPUCreditBalance": "cpu_credit_balance_min",
    "FreeableMemory": "freeable_memory_pct",
    "FreeStorageSpace": "free_storage_pct",
    "ReadLatency": "read_latency_seconds",
    "WriteLatency": "write_latency_seconds",
    "DiskQueueDepth": "disk_queue_depth",
    # ElastiCache
    "EngineCPUUtilization": "engine_cpu_utilization",
    "DatabaseMemoryUsagePercentage": "database_memory_usage_pct",
    "MemoryFragmentationRatio": "memory_fragmentation_ratio",
    "Evictions": "evictions",
    "SwapUsage": "swap_usage_bytes",
}

# 判定用的指标全集。SHALL NOT 在别处再写一份 —— 采集侧的清单是
# `metrics_meta.metrics_for_family()`，这里只是它的判定子集。
THRESHOLD_METRICS: tuple[str, ...] = tuple(_THRESHOLD_BY_METRIC_FIELD)


def evaluate_metric(
    *,
    instance_id: str,
    metric: str,
    value: float | None,
    cfg: ThresholdRuleConfig,
    stat: str = "",
    capacity: Capacity | None = None,
    companion_value: float | None = None,
) -> MetricVerdict:
    """单个指标的阈值判定。纯函数，零 IO。

    方向由 `metrics_meta` 决定，**不在这里编码** —— 两处各存一份方向必然对不上，
    而对不上的表现是「余量充足」被读成「已越线」（或反之），不会报错。

    `capacity`：百分比类指标（`_PCT_DENOMINATOR`）的分母。
    ⚠️ 不传 = 拿不到分母 → 那几个指标判 `NO_DENOMINATOR`。**不默认按原值判**
    —— 那会拿一个百分比阈值（15）去比一个字节数（1.2e9），恒不越线，
    于是内存告警**永久静默**且没有任何信号。

    `companion_value`：伴随指标的实测值（见 `COMPANIONS`）。只对
    `FreeableMemory` / `Evictions` 有意义。
    ⚠️ 不传 = 伴随指标采不到 → **按命中处理**，不抑制。方向选择是刻意的：
    抑制机制漏报的代价（一次故障）远大于误报的代价（一次沟通）。
    """
    field_name = _THRESHOLD_BY_METRIC_FIELD.get(metric)
    if field_name is None:
        return MetricVerdict(instance_id, metric, ThresholdOutcome.NO_THRESHOLD)

    threshold = float(getattr(cfg, field_name))
    direction = metrics_meta.direction_of(metric)
    if direction is None:
        return MetricVerdict(
            instance_id, metric, ThresholdOutcome.UNCLASSIFIED,
            threshold=threshold, stat=stat,
        )

    # ── 百分比类：先归一化到 % ──────────────────────────────────────────
    denom_key = _PCT_DENOMINATOR.get(metric, "")
    denom: float | None = None
    if denom_key:
        denom = capacity.of(denom_key) if capacity else None
        if denom is None:
            # ⚠️ 顺序要紧：**先**判缺分母，再判缺数据。两者都缺时报缺分母
            #    更有指导性 —— 补上分母之后这个指标才可能被判，而
            #    「这一天没采到数」是另一回事、明天自己就好了。
            return MetricVerdict(
                instance_id, metric, ThresholdOutcome.NO_DENOMINATOR,
                threshold=threshold, stat=stat, direction=direction.value,
                raw_value=value, denominator_key=denom_key,
            )

    if value is None:
        return MetricVerdict(
            instance_id, metric, ThresholdOutcome.NO_DATA,
            threshold=threshold, stat=stat, direction=direction.value,
            denominator=denom, denominator_key=denom_key,
        )

    # 判定用的值：百分比类换算成 %，其余原样。
    judged = (value / denom * 100.0) if denom else value

    crossed = metrics_meta.crossed(metric, judged, threshold)
    headroom = metrics_meta.headroom(metric, judged, threshold)

    # ── 伴随条件（`COMPANIONS`）─────────────────────────────────────────
    companion = COMPANIONS.get(metric)
    comp_threshold: float | None = None
    outcome = ThresholdOutcome.HIT if crossed else ThresholdOutcome.PASS
    if companion is not None:
        comp_threshold = float(getattr(cfg, companion.field))
        # 🔴 只在**已越线**时才看伴随条件。没越线就是 PASS，不需要解释。
        # 🔴 `companion_value is None`（伴随指标采不到）时**保持 HIT** ——
        #    抑制机制不能因为缺数据而吃掉真告警。缺 ReadIOPS 的那台可能
        #    正是采集出问题的那台，而那时更该让人看一眼。
        if crossed and companion_value is not None and not metrics_meta.crossed(
                companion.metric, companion_value, comp_threshold):
            outcome = ThresholdOutcome.COMPANION_NOT_MET

    return MetricVerdict(
        instance_id=instance_id,
        metric=metric,
        outcome=outcome,
        value=judged,
        threshold=threshold,
        headroom=headroom,
        stat=stat,
        direction=direction.value,
        raw_value=value,
        denominator=denom,
        denominator_key=denom_key,
        # 无论命中与否都带上 —— HIT 时它是「为什么这次是真的」，
        # COMPANION_NOT_MET 时它是「为什么越线了却不报」。
        companion_metric=(companion.metric if companion else ""),
        companion_value=companion_value,
        companion_threshold=comp_threshold,
    )


def evaluate_chronic(
    *,
    metric: str,
    daily_values: Sequence[float | None],
    cfg: ThresholdRuleConfig,
    coverage_days: int,
    window_days: int = 7,
    capacity: Capacity | None = None,
    companion_value: float | None = None,
) -> int:
    """R2.6 慢性高位：返回连续处于坏侧的天数；**0 表示未命中**。

    Args:
        daily_values: 日值，**按日期倒序**（最近一天在 `[0]`）。
        coverage_days: 本窗口实际有数据的天数。
        window_days: 窗口长度，用于截断（见 `count_consecutive_high`）。

    ```
    coverage < chronic_min_coverage    → 0（且 SHALL NOT 报 INSUFFICIENT_DATA）
    连续天数 < chronic_days_min         → 0
    否则                                → 连续天数（写进载荷的 judgment）
    ```

    ⚠️ **水位尚未越线但已横在坏侧 N 天也要命中** —— 这正是 R2.6.3 的立意。
    所以判据用的是「与门槛比较」的连续天数，与 `evaluate_metric` 的 `HIT`
    是同一个门槛，但**不要求当天越线**：`FreeableMemory` 掉到 800MB 后横三周，
    每天都在坏侧、斜率归零，趋势规则不会命中，而它已在压力平衡点上。

    ⚠️ 返回 `int` 而不是 `bool`：`consecutive_high_days` 要进载荷的 judgment，
    DA 的判读需要「持续了多久」这个数字。只回 bool 会让那个字段无从填写。

    ⚠️ 百分比类指标（`_PCT_DENOMINATOR`）的 `daily_values` 是**原始字节数**，
    必须先按分母归一化再与门槛比。不归一化的表现是拿 15（百分点）去比
    1.2e9（字节），`bad_down` 下恒不成立 → 慢性判定对内存**永久静默**。
    拿不到分母时返回 0（不命中）—— 缺分母那件事由主判定的
    `NO_DENOMINATOR` 报出去，这里再报一次是重复噪音。

    ## 🔴 伴随条件对慢性同样生效（`companion_value`）

    这个函数原来**完全不看** `COMPANIONS`，于是那道校准在慢性路径上整条被绕过：

    ```
    evaluate_metric    内存 1.1% + ReadIOPS 0.07/s → COMPANION_NOT_MET（不命中）
    evaluate_chronic    只比「日值 vs 门槛」→ 5 天以上就出 chronic_days
                        → verdict.chronic 为真 → 照样出一条 finding
    ```

    而 `high_load_findings` 的闸门是 `not verdict.hit and not verdict.chronic`
    —— 两者任一为真就出 finding。抑制生效与被绕过在 stats / 日志上没有区别。

    代价有多大：MySQL 默认 `innodb_buffer_pool_size = DBInstanceClassMemory*3/4`，
    那 75% 是进程私有匿名内存、不计入 MemAvailable，所以**健康的 MySQL 稳态就在
    10% 上下**（实测 49 台 p50=12.6%）。不抑制的话每一台健康的 MySQL 都会永久
    挂着一条慢性内存 finding —— 正是那次校准要消掉的 53% 误报
    （校准后 11%，靠的就是伴随条件）。

    ⚠️ 与 `evaluate_metric` 同口径的两条：
    ```
    只在慢性已命中时才看伴随     没命中就不需要解释
    companion_value 为 None 时**不抑制**   抑制机制不能因为缺数据吃掉真告警；
                                          缺 ReadIOPS 的那台可能正是采集出问题的
    ```

    ⚠️ 比的是伴随指标的**当窗口值**而不是它自己的慢性状态 —— 与
    `evaluate_metric` 一致。「内存长期低 + 现在没有回盘读」就是正常稳态，
    不需要再问「回盘读有没有长期低」。
    """
    if coverage_days < cfg.chronic_min_coverage:
        return 0
    threshold = cfg.threshold_for(metric)
    if threshold is None:
        return 0
    direction = metrics_meta.direction_of(metric)
    if direction is None:
        return 0
    series = daily_values
    denom_key = _PCT_DENOMINATOR.get(metric, "")
    if denom_key:
        denom = capacity.of(denom_key) if capacity else None
        if denom is None:
            return 0
        series = [None if v is None else (v / denom * 100.0) for v in daily_values]
    days = count_consecutive_high(
        series, threshold,
        bad_up=(direction is metrics_meta.Direction.BAD_UP),
        window_days=window_days,
    )
    if days < cfg.chronic_days_min:
        return 0
    # 伴随条件（见 docstring）。只在已命中时才看，缺数据时不抑制。
    companion = COMPANIONS.get(metric)
    if companion is not None and companion_value is not None:
        comp_threshold = float(getattr(cfg, companion.field))
        if not metrics_meta.crossed(
                companion.metric, companion_value, comp_threshold):
            return 0
    return days


def evaluate_threshold(
    *,
    instance_id: str,
    values: Mapping[str, float | None],
    cfg: ThresholdRuleConfig,
    coverage_days: int = 0,
    stats: Mapping[str, str] | None = None,
    metrics: Sequence[str] | None = None,
    daily: Mapping[str, Sequence[float | None]] | None = None,
    window_days: int = 7,
    capacity: Capacity | None = None,
) -> InstanceVerdict:
    """一台实例的高负载判定（R2.1，**OR 语义**）。

    Args:
        values: `{指标名: 判定统计量的最新值}`。取不到的指标传 `None`
            或直接省略 —— 两者都落到 `NO_DATA`。
            ⚠️ SHALL NOT 用 0.0 代替缺失：`Evictions=0` 是健康，
            `Evictions` 缺失是「不知道」，两者判定相反。
        coverage_days: 本窗口实际有数据的天数。
        stats: 可选 `{指标名: 统计量名}`，仅用于把统计量记进 verdict 供载荷溯源。
        metrics: 要判的指标；缺省判 `THRESHOLD_METRICS` 全集。
            传子集用于按族收窄（Memcached 不必判 `EngineCPUUtilization`）。
        capacity: 百分比类指标的分母（实例总内存 / 分配存储）。
            ⚠️ 不传的表现是那几个指标全部 `NO_DENOMINATOR` ——
            **不是**回落到按原值判。回落会拿 15（百分点）去比 1.2e9（字节），
            恒不越线，于是内存告警永久静默。

    Returns:
        `InstanceVerdict`。⚠️ `coverage_days < cfg.min_coverage_days` 时
        **返回空 verdicts** —— 让调用方无法误把它当成「已评估且无命中」，
        那正是 R6.2 会导致整批误判 resolved 的入口。
    """
    if coverage_days < cfg.min_coverage_days:
        return InstanceVerdict(instance_id=instance_id, coverage_days=coverage_days)

    todo = tuple(metrics) if metrics is not None else THRESHOLD_METRICS
    stats = stats or {}
    daily = daily or {}
    verdicts = tuple(
        evaluate_metric(
            instance_id=instance_id, metric=m, value=values.get(m),
            cfg=cfg, stat=stats.get(m, ""), capacity=capacity,
            # 伴随指标的值从同一份 `values` 里取 —— 调用方负责把它补进去
            # （`assemble.high_load_findings` 单独取了一次，因为伴随指标
            # 不在 `alerting_metrics` 清单里）。取不到就是 None，
            # 那时 `evaluate_metric` 按「不抑制」处理。
            companion_value=(values.get(COMPANIONS[m].metric)
                             if m in COMPANIONS else None),
        )
        for m in todo
    )
    # R2.6 慢性高位：逐指标数连续天数。**只在给了日序列时算** ——
    # 没给就是 0，而不是「假设没有慢性」；两者对下游是同一个值，
    # 但调用方漏传 `daily` 时不会得到一个看起来很确定的「无慢性」结论。
    # 🔴 慢性门禁用**该指标自己的** coverage，不是实例级那个跨指标最大值。
    #
    #    `coverage_days` 参数是「这台实例本轮有几天有数据」，由调用方按
    #    `max(...)` 跨指标取的。拿它当慢性的门禁会出现：
    #
    #    ```
    #    FreeableMemory  只有 5 个日点  → 连续 5 天
    #    CPUUtilization  有 7 个日点
    #    coverage_days = max(...) = 7  → chronic_min_coverage=7 被 CPU 满足
    #    ⇒ finding 写 consecutive_high_days=5 / coverage_days=7
    #      DA 读成「7 天里连续 5 天」，而那个指标只有 5 天数据
    #    ```
    #
    # ⚠️ 数的是**非 None** 的天数 —— `daily` 现在是窗口对齐的（缺的那天是
    #    None），所以 `len(daily[m])` 恒等于窗口长度，不能直接用。
    chronic_cov = {
        m: sum(1 for v in daily[m] if v is not None) for m in todo if m in daily
    }
    chronic = {
        m: evaluate_chronic(
            metric=m, daily_values=daily[m], cfg=cfg,
            coverage_days=chronic_cov[m], window_days=window_days,
            capacity=capacity,
            # 与上面 `evaluate_metric` 取的是同一个值 —— 两条通路必须用同一份
            # 伴随证据，否则会出现「当天被抑制、慢性没被抑制」这种分裂。
            companion_value=(values.get(COMPANIONS[m].metric)
                             if m in COMPANIONS else None),
        )
        for m in todo if m in daily
    }
    return InstanceVerdict(
        instance_id=instance_id, verdicts=verdicts, coverage_days=coverage_days,
        chronic_days={m: d for m, d in chronic.items() if d > 0},
        # 按指标的 coverage —— 载荷的 `coverage_days` 要写慢性那个指标的，
        # 不是实例级最大值（见上面 `chronic_cov` 的说明）。
        metric_coverage=dict(chronic_cov),
    )


def hit_reasons(verdict: InstanceVerdict, *, chronic: bool | None = None) -> list[str]:
    """`InstanceVerdict` → 载荷的 `hit_reason` 列表。

    慢性标记默认**从 verdict 自己读**（`evaluate_threshold` 传了 `daily` 时已算好）。
    `chronic` 参数保留为显式覆盖，供上层已单独算过慢性的场景使用。

    ⚠️ `chronic_high` 是**附属**标记，与 `threshold_high` 同时出现，
    SHALL NOT 单独成为一条 finding（R2.6.2）——
    `payload.validate_payload()` 那侧也有一条断言拦这件事。

    ⚠️ 早期签名是 `chronic: bool = False`，默认值让调用方**忘记传**时静默得到
    「无慢性」。而慢性是唯一能兜住渐进式劣化的规则（R2.6.3），漏掉它不会报错，
    只是那类风险从此不再出现在报告里。改成从 verdict 读之后，
    只要 `evaluate_threshold` 收到了日序列，慢性就自动跟着走。
    """
    out: list[str] = []
    if verdict.hit:
        out.append("threshold_high")
    is_chronic = verdict.chronic if chronic is None else chronic
    if is_chronic:
        out.append("chronic_high")
    return out
    # ⚠️ **这里刻意不补 `threshold_high`。** 我一度在慢性命中时自动补上它，
    # 理由是 `payload.validate_payload()` 会拒掉单独出现的 `chronic_high`
    # （R2.6.2）。但那是把**载荷合法性**的责任塞进了一个「如实翻译判定结果」
    # 的函数里 —— 本函数说 threshold_high 就意味着「有指标越线」，
    # 而慢性命中时当天可能并没有越线。伪造它会让载荷里的 judgment 与 hit_reason
    # 对不上（DA 会去找那条越线的指标，而它不存在）。
    #
    # 正确的分层：
    # ```
    # hit_reasons()             如实翻译：越线了才有 threshold_high
    # payload_for_finding()     组装载荷时保证 R2.6.2 —— 见下面的 payload_hit_reasons()
    # pipeline                  决定这条 finding 要不要派发
    # ```


def payload_hit_reasons(verdict: InstanceVerdict) -> list[str]:
    """载荷用的 `hit_reason`，**保证满足 R2.6.2**（chronic 不单独出现）。

    与 `hit_reasons()` 的分工：
    ```
    hit_reasons()          如实翻译判定结果，可能只有 ["chronic_high"]
    payload_hit_reasons()  面向载荷契约，chronic 单独出现时补上 threshold_high
    ```

    ⚠️ 为什么补的是 `threshold_high` 而不是删掉 `chronic_high`：
    慢性命中意味着水位**已经在门槛的坏侧横了 N 天**，按 R2.6.3 那是比「当天尖峰」
    更危险的形态。删掉它等于把 v1 唯一能兜住渐进式劣化的规则丢掉。
    ⚠️ 补的时候 `judgment` 段 SHALL 取慢性那个指标（见
    `severity.severity_for_verdict` 的同一处理），否则 DA 会去找一条不存在的越线指标。
    """
    reasons = hit_reasons(verdict)
    if "chronic_high" in reasons and "threshold_high" not in reasons:
        return ["threshold_high", *reasons]
    return reasons


def threshold_config_section(verdict: MetricVerdict) -> dict[str, object]:
    """`MetricVerdict` → 载荷的 `threshold_config` 段。

    ⚠️ `direction` 必须随载荷下发。skill 侧被明确要求「不得假设越大越坏」，
    而它只能从这里知道方向。
    """
    return {
        "metric": verdict.metric,
        "direction": verdict.direction,
        "value": verdict.threshold,
    }
