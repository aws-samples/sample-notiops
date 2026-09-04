"""CloudWatch `GetMetricData` → 日序列 → `CandidateRecord`（R3.1 / R3.2）。

## 成本模型（最容易算错的地方）

```
GetMetricData 按【请求的指标数】计费  $0.01 / 1000 metrics requested
              **不按返回的数据点数** —— 拉 1 天与拉 7 天价格完全相同
但每个统计量是【独立的 MetricDataQuery，各自计费】
  ⇒ 4 个统计量 = 4 倍指标数。这是设计里最容易漏乘的因子。
```

所以：一次就拉够窗口（7 天），不做增量、不用趋势库替代拉取 —— 省 $0
却换来 TTL 一致性、缺口回填、写入幂等三类问题（R3.1）。

## 三条实现约束

1. **批大小 ≤ 400 query**（R3.10，不用上限 500）。
   ⚠️ 单次返回点数上限 100,800：若为支持变更窗口剔除而按 `period=3600` 拉，
   一个指标 14 天 = 336 点，500 × 336 = 168,000 已超限。

2. **零数据点要上报，不能静默跳过**（R3.5）。
   「拉了没数据」是一条可观测性缺口发现 —— 可能是指标名写错、
   维度选错、或该实例确实不产生这个指标。三种都需要人看一眼。

3. **维度按指标查表**（R3.6a）。少数卷级指标只有集群维度
   （`VolumeBytesUsed` / `AuroraVolumeBytesLeftTotal` 实测实例维度为空）。
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from enum import Enum

from botocore.exceptions import BotoCoreError, ClientError

from inspection.domain import metrics_meta
from inspection.domain.dto import CandidateRecord, ResourceAttrs

logger = logging.getLogger(__name__)

# R3.10：不用 API 上限 500
MAX_QUERIES_PER_CALL = 400

_ACCESS_DENIED_CODES = frozenset({
    "AccessDenied", "AccessDeniedException",
    "UnauthorizedOperation", "AuthFailure",
})
"""被判为「我们的 IAM 缺权限」的错误码（R13b.5）。

⚠️ 列多个而不是只判 `AccessDenied`：CloudWatch 在不同路径上返回的码不统一
（SDK 层 `AccessDenied`，部分服务 `AccessDeniedException`，
STS/EC2 路径可能是 `UnauthorizedOperation` / `AuthFailure`）。
漏掉一个就会让那次退回 `COLLECTION_FAILED`，于是权限问题又变成客户的运维问题。
"""

# R3.2：四个统计量，数量写死
#
# ⚠️ 实际发出去的是 `metrics_meta.stats_for_family(fam, STATS)` 的结果，不是这个常量。
# `AWS/ElastiCache` 不支持百分位（官方支持清单只有 API GW / ALB / EC2 / ELB /
# Kinesis / RDS），对它请求 p95 会拿到空数组**并照样计费**。
STATS: tuple[str, ...] = ("Minimum", "Average", "Maximum", "p95")

_PERIOD_DAILY = 86_400

# 并发批数。串行是**跑不完**而不是「慢」：
#
#   500 RDS + 500 EC ≈ 63,000 query ≈ 158 批 × 约 2.3 秒/批 ≈ 6 分钟/账号
#   5 个账号放在一次 Lambda 调用里 = 30 分钟 > 15 分钟上限 → 直接超时
#
# 配额（2026-08-18 核实，账号级且可通过 Service Quotas 调）：
#   GetMetricData  50 TPS
#                  396,000 data points/秒（StartTime 早于 3 小时前时）
# 我们一批 400 query × 7 天 = 2,800 点，8 并发约 22,400 DPS —— 离两个上限都很远。
# 取 8 而不是贴着 50 TPS：Lambda 默认内存下线程切换本身有成本，
# 且限流后 botocore 的重试会放大尾延迟，收益不是线性的。
#
# ⚠️ boto3 **client** 是线程安全的（Session 与 Resource 不是）：
#   https://docs.aws.amazon.com/boto3/latest/guide/clients.html
# ⚠️ 但官方同一页写着：注册了**自定义 botocore 事件钩子**的 client
#   不再享有这个保证 —— 而 `botocore.stub.Stubber` 正是这么工作的。
#   所以用 Stubber 造的假 client 必须 `max_workers=1`，否则它那个 FIFO
#   响应队列会被并发读成乱序。
DEFAULT_MAX_WORKERS = 8

# CloudWatch 的 Id 只能是小写字母开头的字母数字下划线
_ID_SAFE = str.maketrans({c: "_" for c in "-.:/%() "})


@dataclass(frozen=True)
class DailyPoint:
    """某 (指标, 统计量) 在某一天的值。"""

    data_date: date
    value: float


@dataclass(frozen=True)
class MetricSeries:
    """一个 (实例, 指标, 统计量) 的日序列。

    `points` **按日期倒序**（最近一天在 [0]）—— 与
    `lowdays.count_consecutive_low` 的入参契约一致。
    """

    instance_id: str
    metric: str
    stat: str
    points: tuple[DailyPoint, ...] = ()

    @property
    def latest(self) -> float | None:
        return self.points[0].value if self.points else None

    @property
    def datapoint_count(self) -> int:
        return len(self.points)

    def values(self) -> tuple[float, ...]:
        return tuple(p.value for p in self.points)


class GapReason(str, Enum):
    """指标取不到的原因。**必须分开**，因为行动项完全不同。

    ⚠️ 早期版本把这三种全贴 `zero_datapoints` 一个标签，于是
    「API 挂了」与「这个指标本来就不存在」在返回值上无法区分 ——
    而前者意味着本轮结论不可信，后者只是一条配置提示。
    """

    ZERO_DATAPOINTS = "zero_datapoints"
    """API 正常返回但没有数据点。三种子原因需要人看一眼：
    指标名写错（如 Aurora 上用了 FreeStorageSpace）、维度选错、
    或该实例确实不产生这个指标（如非 T 系的 CPUCreditBalance）。"""

    COLLECTION_FAILED = "collection_failed"
    """这一批 GetMetricData 调用本身失败了（限流 / 网络 / 畸形响应）。
    ⚠️ 与 ZERO_DATAPOINTS 的关键差别：**这台实例本轮没有被真正评估**，
    SHALL NOT 进入 R6.2 的「评估集合」，否则它的 active finding 会被误判 resolved。"""
    ACCESS_DENIED = "access_denied"
    """🔴 **我们自己的 IAM 缺权限**（R13b.5）。

    ⚠️ 必须与 `COLLECTION_FAILED` 分开。合成一类的后果是
    **一个权限 bug 会伪装成客户的运维问题上报给客户**：
    报告上写「这台实例的 CloudWatch 指标取不到，请检查监控配置」，
    而真相是我们的 Lambda role 少了 `cloudwatch:GetMetricData`。
    客户会去查他自己的东西，查不出任何问题。

    ⚠️ 也必须与 `ZERO_DATAPOINTS` 分开：后者是「客户侧确实没数据」，
    要上报给客户；这一类要告警给**我们**，不该出现在客户报告里。
    """

    DIMENSION_UNAVAILABLE = "dimension_unavailable"
    """该指标只有集群维度，但这台实例拿不到 cluster_id → 请求根本没发出去。
    常见于 `describe_db_clusters` 失败但 `describe_db_instances` 成功的组合。"""


@dataclass(frozen=True)
class ObservabilityGap:
    """R3.5：白名单指标取不到值。"""

    instance_id: str
    service: str
    metric: str
    dimension_used: str
    reason: GapReason = GapReason.ZERO_DATAPOINTS
    data_date: date | None = None

    @property
    def is_our_fault(self) -> bool:
        """这个缺口是**我们的**问题，不是客户的（R13b.5）。

        ⚠️ 报告侧必须靠它过滤：`ACCESS_DENIED` 的缺口写进客户报告
        会变成「请检查你的监控配置」，而真相是我们的 Lambda role 少了
        `cloudwatch:GetMetricData`。客户会去查自己的东西，查不出任何问题，
        然后来问我们 —— 而那时我们手上的报告也说是他的问题。
        """
        return self.reason is GapReason.ACCESS_DENIED

    @property
    def customer_visible(self) -> bool:
        """能不能出现在客户报告里。"""
        return not self.is_our_fault


@dataclass(frozen=True)
class MetricsBundle:
    """一次采集的全部结果。

    ⚠️ `failed_instance_ids` 是 R6.2 正确性的关键输入：
    「评估集合」SHALL 是 `采集目标 − failed_instance_ids`，而不是全部采集目标。
    否则一批 400 query 因限流失败 → 那批实例产不出 finding → 不在命中集合
    → 按 `resolved = 评估集合 ∩ 上轮active − 命中集合` 被**整批误判为已解决**，
    客户会看到「昨天 200 个风险全部解决」。R6.2 原本只防住了全失败。
    """

    series: dict[tuple[str, str, str], MetricSeries] = field(default_factory=dict)
    gaps: tuple[ObservabilityGap, ...] = ()
    window_start: date | None = None
    window_end: date | None = None
    queries_issued: int = 0

    batches_total: int = 0
    batches_failed: int = 0
    failed_instance_ids: frozenset[str] = frozenset()

    # {instance_id: metric_family}。`judge_value` 要靠它挑对统计量 ——
    # 同一个指标名在 AWS/RDS 与 AWS/ElastiCache 下可用的统计量不同。
    family_by_instance: dict[str, str] = field(default_factory=dict)

    @property
    def partially_failed(self) -> bool:
        return self.batches_failed > 0

    @property
    def collection_complete(self) -> bool:
        """本轮采集是否可信到能驱动 finding 状态机。

        ⚠️ `batches_total > 0` 这一半不能省。早期实现只判 `batches_failed == 0`，
        于是**一批都没发**的空 bundle（没有 cloudwatch client、
        或 `_build_query_specs` 一条都没产出）会报告「采集完整」，
        `evaluated_instance_ids` 返回全部实例 → 上一轮的 finding 全部无命中
        → 按 R6.2 被整批判 resolved。这正是 R6.2 存在的目的，
        却从「零批次」这个侧门绕了进来。
        """
        return self.batches_total > 0 and self.batches_failed == 0

    def evaluated_instance_ids(self, attempted: Iterable[str]) -> frozenset[str]:
        """R6.2 的「评估集合」。剔掉采集失败的实例。

        ⚠️ 一批都没发时返回**空集** —— 「没采过」不等于「采过且没命中」。
        """
        if self.batches_total == 0:
            return frozenset()
        return frozenset(attempted) - self.failed_instance_ids

    def get(self, instance_id: str, metric: str, stat: str) -> MetricSeries | None:
        return self.series.get((instance_id, metric, stat))

    def value(self, instance_id: str, metric: str, stat: str) -> float | None:
        s = self.get(instance_id, metric, stat)
        return s.latest if s else None

    def judge_value(self, instance_id: str, metric: str) -> float | None:
        """按 R3.2 取该指标该用的统计量的最新值。

        ⚠️ 统计量按该实例的族解析（R3.2a）。早期版本不传族，
        于是对 ElastiCache 的 `CPUUtilization` 去要 p95 —— 那个统计量
        在 `AWS/ElastiCache` 上根本没被请求过，恒返回 None。
        """
        fam = self.family_by_instance.get(instance_id, "")
        stat = metrics_meta.judge_stat_of(metric, fam)
        return self.value(instance_id, metric, stat) if stat else None

    def daily(self, instance_id: str, metric: str, stat: str) -> tuple[float, ...]:
        s = self.get(instance_id, metric, stat)
        return s.values() if s else ()

    def daily_aligned(
        self, instance_id: str, metric: str, stat: str,
    ) -> tuple[float | None, ...]:
        """按窗口逐日对齐的日值，**缺的那天是 `None`**，最近一天在 `[0]`。

        ## 为什么需要它

        `count_consecutive_high` / `count_consecutive_low` 的缺日判据是
        `if value is None: break` —— 中间断了一天就不算「连续」。而 `daily()`
        返回的是 `points` 的值，`points` **只含真有数据的那些天**
        （`_paginate` 拿到的 (ts, value) 对直接构造），所以那条护栏在生产上
        **永远不可能触发**：

        ```
        真实序列   8/20 有、8/21 缺、8/22~8/26 有
        daily()    (8/26, 8/25, 8/24, 8/23, 8/22, 8/20)   ← 6 个值，没有 None
        慢性计数   6 天「连续」                              ← 中间断了一天
        ```

        `tests/…::test_chronic_breaks_on_missing_day` 是手工插 `None` 才绿的，
        它测的形态生产上不存在。

        ⚠️ 与 `daily()` 分开而不是改它：`peak_of`（peak_veto）要的是「各日
        Maximum 的最大值」，塞进 None 会让 `max()` 抛 TypeError；
        `_correlated_section` 要的是「有没有任何数据」，补 None 会让每条相关
        指标都变成定长带洞的数组、白白撑大载荷。
        """
        s = self.get(instance_id, metric, stat)
        if s is None or not s.points:
            return ()
        by_date = {p.data_date: p.value for p in s.points}
        span = (self.window_end - self.window_start).days + 1
        return tuple(
            by_date.get(self.window_end - timedelta(days=i))
            for i in range(max(span, 0))
        )


# ---------------------------------------------------------------------------
# 采集
# ---------------------------------------------------------------------------


def collect(
    cw_client,
    attrs_list: Sequence[ResourceAttrs],
    *,
    window_days: int = 7,
    today: date | None = None,
    max_workers: int | None = None,
) -> MetricsBundle:
    """拉 `window_days` 天日粒度、按族的统计量。

    Args:
        attrs_list: 要采集的资源（需要 service / engine / cluster_id 决定指标与维度）。
        window_days: R3.1 的 7 天（v1.1 趋势要 28 天时改这里，成本不变）。
        today: 注入以便测试；缺省用 UTC 今天。
        max_workers: 并发批数。`None` = `DEFAULT_MAX_WORKERS`，`1` = 串行。
            ⚠️ 用 Stubber 造的假 client **必须传 1**，见 `DEFAULT_MAX_WORKERS` 说明。

    ⚠️ 窗口是 **[today − window_days, today)** —— 不含今天。
    今天的日聚合还没结束，取进来会得到一个偏低的假值
    （例如 UTC 上午 10 点取「今日 max」只覆盖了 10 小时）。
    """
    today = today or datetime.now(timezone.utc).date()
    window_end = today                      # 独占
    window_start = today - timedelta(days=window_days)

    raw_specs = list(_build_query_specs(attrs_list))
    specs = dedup_specs(raw_specs)
    if len(specs) < len(raw_specs):
        logger.info(
            "deduped %d → %d queries (集群维度指标按成员重复，见 dedup_specs)",
            len(raw_specs), len(specs),
        )

    batches = list(_chunks(specs, MAX_QUERIES_PER_CALL))
    series: dict[tuple[str, str, str], MetricSeries] = {}
    issued = 0
    batches_failed = 0
    failed_instances: set[str] = set()

    # {instance_id: GapReason}。同一实例落在多批时，**权限失败优先**记下 ——
    # 一台实例既遇到限流又遇到 AccessDenied 时，要报的是后者（前者会自愈）。
    failure_reason: dict[str, GapReason] = {}

    workers = _resolve_workers(max_workers, len(batches))
    for batch, (results, ok, reason) in zip(
        batches, _fetch_batches(cw_client, batches, window_start, window_end, workers)
    ):
        if ok:
            # ⚠️ 只有成功的批次才计入 `queries_issued` —— 被限流拒掉的请求
            # AWS 不计费，早期实现在 ok 判断之前累加，于是部分失败时
            # 报告出来的成本正好被那些「什么都没拿到」的批次虚高。
            issued += len(batch)
            series.update(results)
        else:
            batches_failed += 1
            # ⚠️ 整批失败 → 这批里的每个实例本轮都没被真正评估。
            # 记下来，让 R6.2 的评估集合能把它们剔掉，否则会被误判 resolved。
            for spec in batch:
                failed_instances.update(spec.instance_ids)
                for iid in spec.instance_ids:
                    prev = failure_reason.get(iid)
                    if prev is GapReason.ACCESS_DENIED:
                        continue          # 权限失败不被限流失败盖掉
                    failure_reason[iid] = reason or GapReason.COLLECTION_FAILED

    batches_total = len(batches)
    data_date = window_end - timedelta(days=1)
    gaps = _detect_gaps(
        attrs_list, specs, series, failed_instances, data_date, failure_reason
    )

    denied = sorted(i for i, r in failure_reason.items()
                    if r is GapReason.ACCESS_DENIED)
    if denied:
        # 🔴 R13b.5：这不是客户的运维问题，是我们的 IAM 缺权限。
        logger.error(
            "ACCESS DENIED on %d instances — 我们的 Lambda role 缺 CloudWatch 权限，"
            "SHALL NOT 作为客户侧可观测性缺口上报: %s",
            len(denied), denied[:10],
        )

    if batches_failed:
        logger.error(
            "collection PARTIALLY FAILED: %d/%d batches failed, %d instances "
            "not evaluated this round — 这些实例 SHALL NOT 进入 R6.2 的评估集合",
            batches_failed, batches_total, len(failed_instances),
        )
    logger.info(
        "collected %d series in %d queries (%s ~ %s), %d gaps, %d/%d batches ok",
        len(series), issued, window_start, data_date, len(gaps),
        batches_total - batches_failed, batches_total,
    )
    return MetricsBundle(
        series=series, gaps=gaps,
        window_start=window_start, window_end=data_date,
        queries_issued=issued,
        batches_total=batches_total, batches_failed=batches_failed,
        failed_instance_ids=frozenset(failed_instances),
        family_by_instance={
            a.instance_id: metrics_meta.metric_family(a.service, a.engine)
            for a in attrs_list
        },
    )


@dataclass(frozen=True)
class _QuerySpec:
    """一条 `MetricDataQuery` 的规格。

    ⚠️ `instance_ids` 是**复数**：集群维度的指标对同一集群的全部成员是同一条
    query（同 namespace / metric / dimension / stat），发 N 遍拿回 N 份一样的数据
    却按 N 个指标计费。所以按维度去重、一条 query 回填给多台实例。
    """

    instance_ids: tuple[str, ...]
    service: str
    metric: str
    stat: str
    namespace: str
    dimension_name: str
    dimension_value: str

    @property
    def dedup_key(self) -> tuple[str, str, str, str, str]:
        """决定「这两条 query 是不是同一条」。**不含 instance_id。**"""
        return (self.namespace, self.metric, self.stat,
                self.dimension_name, self.dimension_value)

    def keys(self) -> tuple[tuple[str, str, str], ...]:
        """这条 query 的结果要写到哪些 (实例, 指标, 统计量) 上。"""
        return tuple((iid, self.metric, self.stat) for iid in self.instance_ids)


def _build_query_specs(attrs_list: Iterable[ResourceAttrs]) -> Iterable[_QuerySpec]:
    """为每个 (实例, 指标, 统计量) 生成一条 query 规格。

    维度按 R3.6a 查表选：
      · 只有集群维度的指标（VolumeBytesUsed / AuroraVolumeBytesLeftTotal）
        → 用 cluster_id；拿不到 cluster_id 就**跳过**（不用实例维度硬试，那必然为空）
      · 其余用实例维度
    """
    for attrs in attrs_list:
        ns, inst_dim, clus_dim = _namespace_and_dims(attrs.service)
        if ns is None:
            logger.debug("service %s not collectable, skipped", attrs.service)
            continue

        fam = metrics_meta.metric_family(attrs.service, attrs.engine)
        stats = metrics_meta.stats_for_family(fam, STATS)

        for metric in metrics_meta.collected_metrics(attrs.service, attrs.engine):
            on_instance = metrics_meta.available_on_instance(metric)
            if on_instance:
                dim_name, dim_value = inst_dim, attrs.instance_id
            else:
                if not attrs.cluster_id:
                    # 只有集群维度但这台不属于任何集群 → 该指标对它不存在，不发无用请求
                    continue
                dim_name, dim_value = clus_dim, attrs.cluster_id

            for stat in stats:
                yield _QuerySpec(
                    instance_ids=(attrs.instance_id,), service=attrs.service,
                    metric=metric, stat=stat, namespace=ns,
                    dimension_name=dim_name, dimension_value=dim_value,
                )


def dedup_specs(specs: Iterable[_QuerySpec]) -> list[_QuerySpec]:
    """按维度去重，把指向同一条 query 的多台实例合并进 `instance_ids`。

    ⚠️ 这不是「优化」，是在纠正一次重复计费。`AuroraVolumeBytesLeftTotal` 等
    卷级指标只有集群维度，所以一个 4 成员的 Aurora 集群会为**同一个**
    `(AWS/RDS, AuroraVolumeBytesLeftTotal, DBClusterIdentifier=c1, Minimum)`
    发 4 条一模一样的 query —— 拿回 4 份逐字相同的数据，
    而 `GetMetricData` 按**请求的指标数**计费，4 倍的钱。

    去重后结果回填给全部成员，判定行为完全不变（有测试锁住这一点）。
    顺序稳定：按首次出现的顺序，保证可重放。
    """
    merged: dict[tuple[str, str, str, str, str], _QuerySpec] = {}
    for spec in specs:
        existing = merged.get(spec.dedup_key)
        if existing is None:
            merged[spec.dedup_key] = spec
            continue
        extra = tuple(
            i for i in spec.instance_ids if i not in existing.instance_ids
        )
        if extra:
            merged[spec.dedup_key] = replace(
                existing, instance_ids=existing.instance_ids + extra
            )
    return list(merged.values())


def _resolve_workers(max_workers: int | None, n_batches: int) -> int:
    if n_batches <= 1:
        return 1
    requested = DEFAULT_MAX_WORKERS if max_workers is None else max_workers
    return max(1, min(requested, n_batches))


def _fetch_batches(
    cw_client,
    batches: Sequence[Sequence[_QuerySpec]],
    window_start: date,
    window_end: date,
    workers: int,
) -> list[tuple[dict[tuple[str, str, str], MetricSeries], bool, GapReason | None]]:
    """并发发多批，**按输入顺序**返回结果。

    ⚠️ 顺序必须保持 —— 调用方靠 `zip(batches, results)` 把失败批次对回它的实例。
    `Executor.map` 保证按输入顺序产出（不是按完成顺序），这正是要的语义。

    ⚠️ 单批时不建线程池：绝大多数客户只有一批，凭空起一个 executor 只是噪音。
    """
    if workers <= 1:
        return [
            _fetch_batch(cw_client, b, window_start, window_end) for b in batches
        ]

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(
            lambda b: _fetch_batch(cw_client, b, window_start, window_end),
            batches,
        ))


def _namespace_and_dims(service: str) -> tuple[str | None, str, str]:
    if service == "rds":
        return "AWS/RDS", "DBInstanceIdentifier", "DBClusterIdentifier"
    if service == "elasticache":
        return "AWS/ElastiCache", "CacheClusterId", "ReplicationGroupId"
    return None, "", ""


def _fetch_batch(
    cw_client,
    batch: Sequence[_QuerySpec],
    window_start: date,
    window_end: date,
) -> tuple[dict[tuple[str, str, str], MetricSeries], bool]:
    """发一批 GetMetricData 并解析。返回 (结果, 是否成功)。

    ⚠️ **必须把成败告诉调用方**。早期版本整批失败只返回空 dict + 打 warning，
    于是「一半指标本来就没数据」与「一半批次挂了」在返回值上完全同形，
    而后者会让 R6.2 把那批实例的 active finding 全判 resolved。
    """
    queries = []
    id_to_spec: dict[str, _QuerySpec] = {}

    for i, spec in enumerate(batch):
        qid = _query_id(i, spec)
        id_to_spec[qid] = spec
        queries.append({
            "Id": qid,
            "MetricStat": {
                "Metric": {
                    "Namespace": spec.namespace,
                    "MetricName": spec.metric,
                    "Dimensions": [
                        {"Name": spec.dimension_name, "Value": spec.dimension_value}
                    ],
                },
                "Period": _PERIOD_DAILY,
                # ⚠️ 百分位直接写进 `Stat`，**没有** ExtendedStatistic 字段。
                # `MetricStat` 只接受 Metric / Period / Stat / Unit ——
                # 写了 ExtendedStatistic 会被 botocore 参数校验整批拒掉
                # （2026-08-17 实测：688 个 query 一条都没发出去）。
                # 这与 GetMetricStatistics 不同，那个才有独立的 ExtendedStatistics 参数。
                "Stat": spec.stat,
            },
            "ReturnData": True,
        })

    # ⚠️ **必须是 UTC 零点整。** `Period=86400` 的桶不会自动对齐到自然日 ——
    # 官方（GetMetricData 的 StartTime 说明）：CloudWatch 只把 StartTime
    # **向下取整到整分钟**（15 天内的窗口），然后从那一刻起按 Period 步进。
    #
    # ```
    # 传 2026-08-12T00:00:00Z  → 桶 = [08-12 00:00, 08-13 00:00) …  ✅ 自然日
    # 传 2026-08-12T09:37:00Z  → 桶 = [08-12 09:37, 08-13 09:37) …  ❌ 跨日
    # ```
    #
    # 跨日的后果是静默的：每个「日值」实际是横跨两天的 24 小时窗口，
    # 于是 `data_date` 标的日期与数据覆盖的时段对不上（违反 R13.10），
    # 而 min/avg/max 看起来完全正常。所以这里从 `date` 构造而**不是**
    # 从 `datetime.now()` 减 N 天 —— 后者带当前时刻，会把桶整体平移。
    start_dt = datetime(
        window_start.year, window_start.month, window_start.day, tzinfo=timezone.utc
    )
    end_dt = datetime(
        window_end.year, window_end.month, window_end.day, tzinfo=timezone.utc
    )

    out: dict[tuple[str, str, str], MetricSeries] = {}

    # ⚠️ **响应解析也必须在 try 里。** 早期实现只包住 `_paginate_metric_data`，
    # 于是 `zip` / `sort` / `_to_date` / `float()` 里任何一个 TypeError 都会
    # 一路冒出 `_fetch_batch` → `pool.map` → `collect()` → `run_inspection()`，
    # 把「一批降级」变成「整轮无产出」—— 而且 `ThreadPoolExecutor.__exit__` 会
    # `shutdown(wait=True)`，所以剩下 100 多批的钱照付完才抛。
    # 这与本函数 docstring 承诺的「整批失败只返回 (结果, False)」直接矛盾。
    try:
        pages = _paginate_metric_data(cw_client, queries, start_dt, end_dt)

        # 分页时同一个 Id 会跨页续传，先按 Id 累积
        accum: dict[str, list[tuple[datetime, float]]] = {}
        for page in pages:
            for result in page.get("MetricDataResults") or []:
                qid = result.get("Id")
                if qid not in id_to_spec:
                    continue
                stamps = result.get("Timestamps") or []
                values = result.get("Values") or []
                accum.setdefault(qid, []).extend(zip(stamps, values))

        for qid, pairs in accum.items():
            spec = id_to_spec[qid]
            # 按时间倒序（最近一天在前）—— lowdays 的入参契约
            pairs.sort(key=lambda p: p[0], reverse=True)
            points = tuple(
                DailyPoint(data_date=_to_date(ts), value=float(v)) for ts, v in pairs
            )
            if not points:
                continue
            # 一条 query 可能服务多台实例（集群维度去重后），逐个回填
            for iid, metric, stat in spec.keys():
                out[(iid, metric, stat)] = MetricSeries(
                    instance_id=iid, metric=metric, stat=stat, points=points,
                )
    except ClientError as exc:
        code = str(exc.response.get("Error", {}).get("Code") or "")
        if code in _ACCESS_DENIED_CODES:
            # 🔴 R13b.5：这是**我们的** IAM 缺权限，不是客户的监控配置问题。
            # 用 error 而不是 warning：它需要有人来改 CDK，不是等它自愈。
            logger.error(
                "GetMetricData batch of %d DENIED (%s) — 这是我们的 IAM 缺权限，"
                "SHALL NOT 作为客户侧可观测性缺口上报: %s",
                len(batch), code, exc,
            )
            return {}, False, GapReason.ACCESS_DENIED
        logger.warning("GetMetricData batch of %d failed: %s", len(batch), exc)
        return {}, False, GapReason.COLLECTION_FAILED
    except BotoCoreError as exc:
        logger.warning("GetMetricData batch of %d failed: %s", len(batch), exc)
        return {}, False, GapReason.COLLECTION_FAILED
    except Exception:
        # 解析异常（畸形响应、意外类型）—— 只降级这一批，不拖垮整轮
        logger.exception(
            "GetMetricData batch of %d failed while parsing (metrics=%s)",
            len(batch), sorted({s.metric for s in batch})[:8],
        )
        return {}, False, GapReason.COLLECTION_FAILED

    return out, True, None


def _paginate_metric_data(cw_client, queries, start_dt, end_dt) -> list[dict]:
    """GetMetricData 的 NextToken 分页。"""
    pages: list[dict] = []
    token: str | None = None
    while True:
        kwargs = {
            "MetricDataQueries": queries,
            "StartTime": start_dt,
            "EndTime": end_dt,
            "ScanBy": "TimestampDescending",
        }
        if token:
            kwargs["NextToken"] = token
        resp = cw_client.get_metric_data(**kwargs)
        pages.append(resp)
        token = resp.get("NextToken")
        if not token:
            return pages


def _detect_gaps(
    attrs_list: Sequence[ResourceAttrs],
    specs: Sequence[_QuerySpec],
    series: dict[tuple[str, str, str], MetricSeries],
    failed_instances: set[str] | None = None,
    data_date: date | None = None,
    failure_reason: dict[str, "GapReason"] | None = None,
) -> tuple[ObservabilityGap, ...]:
    """R3.5：只对 `alerting_metrics` 报缺口。

    ⚠️ 关联指标缺失是常态（`CPUCreditBalance` 在非 T 系上本来就没有、
    `BurstBalance` 只在 gp2 上有），全报会淹掉真信号。
    判定用的 alerting 指标缺失才是要人看一眼的事。
    ⚠️ 判定口径是「该指标的**全部**统计量都没数据」——
    只有 p95 缺（某些指标不支持扩展统计量）不算缺口。
    """
    # ⚠️ **有序元组，不是 set。** `alerting_metrics()` 的顺序是稳定的（见其 docstring），
    # 这里必须保住那个顺序：下面 ② 直接遍历它来产出 gaps，而遍历 `set[str]` 的顺序
    # 由字符串 hash 决定 —— CPython 的 hash 随机化让它**每个进程都不一样**。
    # 后果是 `gaps` 的顺序每轮都变：R14「同输入同输出」不成立、gap 列表做 top-N 截断时
    # 保留的条目每轮不同、依赖顺序的测试随机红。这是本模块唯一的真非确定性来源
    # （①那处已经 `sorted(dim_by_key.items())`）。
    alerting_by_instance: dict[str, tuple[str, ...]] = {
        a.instance_id: metrics_meta.alerting_metrics(a.service, a.engine)
        for a in attrs_list
    }
    # 成员判断走 set（O(1)），遍历走上面的元组（有序）。两者从同一个来源派生，
    # 不会像「两处各存一份」那样漂移。
    alerting_lookup: dict[str, frozenset[str]] = {
        k: frozenset(v) for k, v in alerting_by_instance.items()
    }
    dim_by_key: dict[tuple[str, str], str] = {
        (iid, s.metric): s.dimension_name for s in specs for iid in s.instance_ids
    }
    service_by_instance = {a.instance_id: a.service for a in attrs_list}

    # (instance, metric) → 有数据的统计量数
    have: dict[tuple[str, str], int] = {}
    for (inst, metric, _stat) in series:
        have[(inst, metric)] = have.get((inst, metric), 0) + 1

    failed = failed_instances or set()
    gaps: list[ObservabilityGap] = []

    # ① 实际发出去但没数据 / 或整批失败
    for (inst, metric), dim in sorted(dim_by_key.items()):
        if metric not in alerting_lookup.get(inst, frozenset()):
            continue
        if have.get((inst, metric), 0) > 0:
            continue
        gaps.append(ObservabilityGap(
            instance_id=inst,
            service=service_by_instance.get(inst, ""),
            metric=metric,
            dimension_used=dim,
            reason=(
                # 🔴 R13b.5：区分「我们的 IAM 缺权限」与「客户侧确实没数据」。
                # 合成一类会让权限 bug 伪装成客户的运维问题上报给客户 ——
                # 报告写「请检查监控配置」，而真相是我们少了 GetMetricData 权限。
                (failure_reason or {}).get(inst, GapReason.COLLECTION_FAILED)
                if inst in failed else GapReason.ZERO_DATAPOINTS
            ),
            data_date=data_date,
        ))

    # ② 因缺 cluster_id 被 skip、请求根本没发出去的 alerting 指标
    # ⚠️ 早期版本以 specs 为基准，而被 skip 的组合不在 specs 里 → 不会报 gap
    #    → `AuroraVolumeBytesLeftTotal` 在 describe_db_clusters 失败时**彻底静默消失**
    issued_keys = {(iid, s.metric) for s in specs for iid in s.instance_ids}
    for a in attrs_list:
        for metric in alerting_by_instance.get(a.instance_id, ()):
            if (a.instance_id, metric) in issued_keys:
                continue
            gaps.append(ObservabilityGap(
                instance_id=a.instance_id,
                service=a.service,
                metric=metric,
                dimension_used="(not requested)",
                reason=GapReason.DIMENSION_UNAVAILABLE,
                data_date=data_date,
            ))

    return tuple(gaps)


# ---------------------------------------------------------------------------
# → CandidateRecord
# ---------------------------------------------------------------------------


def to_candidate(bundle: MetricsBundle, attrs: ResourceAttrs) -> CandidateRecord:
    """把采集结果装成闲置侧要的 `CandidateRecord`。

    ⚠️ 拿不到的指标一律留 `None`，**不填 0** —— domain 层靠 None 区分
    「没采到」与「使用率是 0」，填 0 会让空记录看起来是「完美闲置」。
    """
    iid = attrs.instance_id
    v = bundle.value
    fam = metrics_meta.metric_family(attrs.service, attrs.engine)

    if metrics_meta.is_elasticache_family(fam):
        return _ec_candidate(bundle, attrs, fam)

    # RDS / Aurora。Aurora 没有 FreeStorageSpace，Aurora **MySQL** 用
    # AuroraVolumeBytesLeftTotal；Aurora PostgreSQL 两个都没有 → 留 None，
    # 由 `idle._norm_storage` 标 NOT_APPLICABLE（不是 METRIC_MISSING）。
    free_storage = v(iid, "FreeStorageSpace", "Minimum")
    if free_storage is None:
        free_storage = v(iid, "AuroraVolumeBytesLeftTotal", "Minimum")

    return CandidateRecord(
        instance_id=iid,
        service=attrs.service,
        account_id=attrs.account_id,
        region=attrs.region,
        # ⚠️ RDS/Aurora 的网络指标叫 Network*Throughput，单位 Bytes/Second。
        # `NetworkIn` / `NetworkOut` 是 EC2 的名字，在 AWS/RDS 下不存在。
        network_in=v(iid, "NetworkReceiveThroughput", "Average"),
        network_out=v(iid, "NetworkTransmitThroughput", "Average"),
        network_unit="bytes_per_second",
        cpu_avg=v(iid, "CPUUtilization", "Average"),
        cpu_max=v(iid, "CPUUtilization", "Maximum"),
        peak_cpu_7d=_peak(bundle, iid, "CPUUtilization"),
        connections_avg=v(iid, "DatabaseConnections", "Average"),
        peak_connections_7d=_int_or_none(
            _peak(bundle, iid, "DatabaseConnections")
        ),
        free_storage_bytes=free_storage,
        read_iops=v(iid, "ReadIOPS", "Average"),
        write_iops=v(iid, "WriteIOPS", "Average"),
        write_iops_avg=v(iid, "WriteIOPS", "Average"),
        swap_usage_bytes=v(iid, "SwapUsage", "Maximum"),
    )


def _ec_candidate(
    bundle: MetricsBundle, attrs: ResourceAttrs, family: str
) -> CandidateRecord:
    """ElastiCache 的装配 —— **Redis 与 Memcached 读的是不同的指标名**。

    ```
                      Redis / Valkey                  Memcached
    CPU 判定           EngineCPUUtilization ★          CPUUtilization ★
    内存占用率         DatabaseMemoryUsagePercentage   无（只有 BytesUsedForCacheItems 字节）
    命中 / 未命中      CacheHits / CacheMisses         GetHits / GetMisses
    ```

    ★ 两边恰好相反，都不是笔误：
      · Redis 主线程单线程 → 4 vCPU 上引擎打满时整机 CPU 仅约 25%，
        看整机 CPU 会把打满的节点判成空闲
      · Memcached 多线程 → 没有 `EngineCPUUtilization` 这个指标，
        官方指导就是看整机 `CPUUtilization`

    ⚠️ 早期版本让 Memcached 走 Redis 的名字，后果不是「少几个字段」而是
    **闲置分恒为 0**：三个维度（cpu / memory / requests）全部取不到值，
    `_build_dimensions` 的 `available_weight` 归零 → 每个维度 `eff_w = 0`
    → 总分 0，而 0 分在排序里等于「完全不闲」，看不出任何异常。
    """
    iid = attrs.instance_id
    v = bundle.value
    is_memcached = family == metrics_meta.MetricFamily.MEMCACHED.value

    cpu_metric = "CPUUtilization" if is_memcached else "EngineCPUUtilization"
    hits_metric = "GetHits" if is_memcached else "CacheHits"
    misses_metric = "GetMisses" if is_memcached else "CacheMisses"

    return CandidateRecord(
        instance_id=iid,
        service=attrs.service,
        account_id=attrs.account_id,
        region=attrs.region,
        # ⚠️ ElastiCache 用 NetworkBytesIn/Out，单位是 **Bytes（累计）**，
        # 与 RDS 侧的 Bytes/Second 不同量纲 —— 所以要记下 network_unit，
        # 任何跨服务比较网络量的代码都必须先看这个字段。
        network_in=v(iid, "NetworkBytesIn", "Average"),
        network_out=v(iid, "NetworkBytesOut", "Average"),
        network_unit="bytes",
        cpu_avg=v(iid, cpu_metric, "Average"),
        cpu_max=v(iid, "CPUUtilization", "Maximum"),
        # Memcached 没有引擎 CPU → 留 None，容量审计会因此跳过（见 capacity.py）
        engine_cpu_max=(
            None if is_memcached else v(iid, "EngineCPUUtilization", "Maximum")
        ),
        peak_cpu_7d=_peak(bundle, iid, cpu_metric),
        connections_avg=v(iid, "CurrConnections", "Average"),
        peak_connections_7d=_int_or_none(_peak(bundle, iid, "CurrConnections")),
        # Memcached 无百分比内存指标；填 None 而不是拿字节数硬当百分比
        memory_usage_pct=(
            None if is_memcached
            else v(iid, "DatabaseMemoryUsagePercentage", "Maximum")
        ),
        memory_used_bytes=(
            v(iid, "BytesUsedForCacheItems", "Maximum") if is_memcached
            else v(iid, "BytesUsedForCache", "Maximum")
        ),
        evictions=_int_or_none(v(iid, "Evictions", "Maximum")),
        cache_hits=v(iid, hits_metric, "Average"),
        cache_misses=v(iid, misses_metric, "Average"),
        swap_usage_bytes=v(iid, "SwapUsage", "Maximum"),
    )


def _peak(bundle: MetricsBundle, instance_id: str, metric: str) -> float | None:
    """窗口内的峰值 = 各日 Maximum 里最大的那个。

    ⚠️ 不是「最近一天的 max」。peak_veto 要挡的是「平时闲、每晚跑批打满」，
    只看最近一天会漏掉前六天的批处理。
    """
    values = bundle.daily(instance_id, metric, "Maximum")
    return max(values) if values else None


def daily_rows_for_lowdays(
    bundle: MetricsBundle, attrs: ResourceAttrs
) -> list[dict]:
    """给 `lowdays.count_consecutive_low()` 的入参。

    返回按日期**倒序**的行，每行 `{cpu_utilization, connections}`。
    ⚠️ 某天任一指标缺失就把该天的值留 None —— `count_consecutive_low`
    在 None 处中断计数，这正是我们要的（缺数据不当低位，否则连续天数虚长）。
    """
    iid = attrs.instance_id
    fam = metrics_meta.metric_family(attrs.service, attrs.engine)
    if fam == metrics_meta.MetricFamily.MEMCACHED.value:
        # Memcached 多线程，没有 EngineCPUUtilization —— 用整机 CPU。
        # 用 Redis 的名字会让每一天都取不到值，`count_consecutive_low`
        # 在 None 处中断 → 连续低位天数恒为 0 → 闲置加成恒为 1.0。
        cpu_metric, conn_metric = "CPUUtilization", "CurrConnections"
    elif metrics_meta.is_elasticache_family(fam):
        cpu_metric, conn_metric = "EngineCPUUtilization", "CurrConnections"
    else:
        cpu_metric, conn_metric = "CPUUtilization", "DatabaseConnections"

    cpu_series = bundle.get(iid, cpu_metric, "Average")
    conn_series = bundle.get(iid, conn_metric, "Average")

    cpu_by_date = {p.data_date: p.value for p in (cpu_series.points if cpu_series else ())}
    conn_by_date = {
        p.data_date: p.value for p in (conn_series.points if conn_series else ())
    }

    all_dates = sorted(set(cpu_by_date) | set(conn_by_date), reverse=True)
    return [
        {
            "date": d.isoformat(),
            "cpu_utilization": cpu_by_date.get(d),
            "connections": conn_by_date.get(d),
        }
        for d in all_dates
    ]


# ---------------------------------------------------------------------------
# 内部工具
# ---------------------------------------------------------------------------


def _query_id(index: int, spec: _QuerySpec) -> str:
    """CloudWatch 的 Id 必须小写字母开头、只含字母数字下划线。

    带上指标与统计量便于排查（返回结果只有 Id 可以对回来）。
    """
    tail = f"{spec.metric}_{spec.stat}".translate(_ID_SAFE).lower()
    return f"q{index}_{tail}"[:255]


def _chunks(items: Sequence, size: int):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def _to_date(ts) -> date:
    if isinstance(ts, datetime):
        return ts.date()
    if isinstance(ts, date):
        return ts
    return datetime.fromisoformat(str(ts)).date()


def _int_or_none(v: float | None) -> int | None:
    return int(v) if v is not None else None
