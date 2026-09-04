"""巡检编排层 —— 把 adapters 与 domain 串成一轮完整巡检。

## 为什么必须有这个文件

在它之前，`inspection/` 包有 **零个非测试调用方**。M1「端到端跑通」是靠一个写在
`/tmp` 里的一次性脚本完成的 —— 那个脚本随即消失，于是：

```
· 排期上这一步标着「已完成」，但没有任何人能重放它
· 「哪一步先跑、谁的输出喂给谁」这个知识只存在于我的短期记忆里
· 每个模块都有单测，但**模块之间的接线一行都没被测过**
  （`to_candidate` 需要先 `collect`、`score_idle` 需要 attrs 与 candidate 配对、
   `scan_capacity` 吃的是 (candidate, attrs) 元组对 —— 这些顺序错了单测全绿）
```

编排层入仓之后，端到端就是一条可以在 CI 里跑的测试。

## 分层位置

```
handler        Lambda 入口，解析 SQS 消息、建 boto3 client      ← 不在本文件
▓ pipeline ▓   编排：展开清单 → 拉数 → 算 → 返回结果对象         ← 本文件，集成测试
repository     adapters/*，返回 domain DTO                      可 stub
domain         纯函数，零 IO                                    单测 + property
```

⚠️ **本层不建 client、不取当前时间、不写库。**
`clients` 与 `today` 都是入参，返回的是一个纯数据的 `InspectionResult`。
理由：
  · 建 client 要 region 与凭证，那是部署形态的事，混进来就没法在 CI 里跑
  · 写库放在调用方，让「算错了」与「写坏了」两类故障可以分开定位
  · `today` 入参是 R14.2 的硬约束，编排层同样适用 —— 否则跨月的行为永远测不到

## 一轮的顺序（顺序本身是需求，不是实现细节）

```
① load_resources      describe RDS + ElastiCache → ResourceAttrs
② enrich              memory_bytes（ec2） + max_connections（参数组）
③ apply_exclusions    R1.8 入口过滤。**在拉指标之前** —— 被排除的资源不该产生 API 费用
④ load_refdata        引擎 EOL + CA 证书（结构性风险要用）
⑤ collect_metrics     GetMetricData 7 天 × 按族的统计量
⑥ 结构性风险           纯属性，不需要指标 → scan_structural + 指纹去重
⑦ 闲置与容量           需要指标 → apply_vetoes → score_idle / scan_capacity
```

③ 的位置是刻意的：先过滤再拉数。反过来会为客户明确说了「别看这个」的资源付
`GetMetricData` 的钱，而且那笔钱在账单上看不出是浪费的。
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date

from inspection.adapters import attrs_repo, metrics_repo, refdata
from inspection.adapters.metrics_repo import MetricsBundle, ObservabilityGap
from inspection.domain import scope
from inspection.domain.dto import (
    CandidateRecord,
    CapacityRuleConfig,
    Finding,
    FingerprintGroup,
    IdleRuleConfig,
    IdleScore,
    PriceEstimate,
    ResourceAttrs,
    StructuralRefData,
    StructuralRuleConfig,
    VetoResult,
)
from inspection.domain.scoring import (
    apply_vetoes,
    count_consecutive_low,
    estimate_monthly_savings,
    rank_cross_service,
    scan_capacity,
    score_idle,
)
from inspection.domain.structural import group_by_fingerprint, scan_structural

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 入参
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class InspectionClients:
    """本轮要用到的 AWS client。

    做成一个对象而不是 4 个位置参数：加服务（EC2 / OpenSearch …）时
    `run_inspection` 的签名不变，调用方也不用改。

    ⚠️ 允许为 None —— 客户没有 ElastiCache 时不该被迫造一个假 client。
    缺哪个就跳过对应的采集，并在 `InspectionResult.skipped` 里说明。
    """

    rds: object | None = None
    elasticache: object | None = None
    ec2: object | None = None
    cloudwatch: object | None = None


@dataclass(frozen=True)
class InspectionConfig:
    """三份规则配置 + 窗口长度。

    三份分开是 R2.5 的要求：客户可以只调闲置门槛而不动阈值门槛。
    """

    idle: IdleRuleConfig = field(default_factory=IdleRuleConfig)
    capacity: CapacityRuleConfig = field(default_factory=CapacityRuleConfig)
    structural: StructuralRuleConfig = field(default_factory=StructuralRuleConfig)
    window_days: int = 7
    """v1 = 7 天。v1.1 趋势要 28 天，改这个数即可（成本不变）。"""

    max_workers: int | None = None
    """采集并发批数。None = `metrics_repo.DEFAULT_MAX_WORKERS`（8）。

    ⚠️ 串行是**跑不完**而不是慢：500+500 规模约 158 批 × 2.3 秒 ≈ 6 分钟/账号，
    5 个账号一次 Lambda 调用 = 30 分钟 > 15 分钟上限。
    ⚠️ 用 `botocore.stub.Stubber` 造的假 client 必须设 1 ——
    Stubber 注册了自定义 botocore 事件钩子，官方明确说那会让 client 失去线程安全保证。
    """


# ---------------------------------------------------------------------------
# 出参
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IdleOutcome:
    """一台资源在闲置侧的完整结论 —— 通过或被否决，两种都要能解释。

    ⚠️ 被否决的也留在结果里。只返回通过的那些，UI 上就无法回答
    「我这台明显没人用，为什么不在闲置清单里」——
    而那是客户第一个会问的问题。
    """

    instance_id: str
    service: str
    passed: bool
    vetoes: tuple[VetoResult, ...]
    score: IdleScore | None = None
    consecutive_low_days: int = 0


@dataclass(frozen=True)
class InspectionResult:
    """一轮巡检的全部产出。纯数据，可序列化，可 diff。"""

    account_id: str
    region: str
    today: date
    data_date: date | None

    attrs: tuple[ResourceAttrs, ...] = ()
    """经排除过滤后、真正参与判定的资源。"""

    excluded: tuple[tuple[scope.ResourceRef, scope.ExclusionDecision], ...] = ()
    """被排除的资源 + 命中的那条清单条目。UI 要显示理由（R1.8）。"""

    candidates: tuple[tuple[CandidateRecord, ResourceAttrs], ...] = ()

    structural_findings: tuple[Finding, ...] = ()
    fingerprint_groups: tuple[FingerprintGroup, ...] = ()
    capacity_findings: tuple[Finding, ...] = ()
    idle_outcomes: tuple[IdleOutcome, ...] = ()
    ranked_idle: tuple[IdleScore, ...] = ()

    gaps: tuple[ObservabilityGap, ...] = ()
    queries_issued: int = 0
    batches_total: int = 0
    batches_failed: int = 0
    failed_instance_ids: frozenset[str] = frozenset()
    skipped: tuple[str, ...] = ()
    """本轮**没做**的事（缺 client、缺参考数据…）。空元组才是完整的一轮。"""

    ec_eol_table_staleness_days: int | None = None
    """ElastiCache EOL 维护表距上次核对多少天（R2.4b.4）。

    ⚠️ 这是本 feature 里唯一需要人工维护的参考表（EC 没有等价 API）。
    它的陈旧程度必须是一个能上看板、能告警的**数字** ——
    写成注释里的「记得每季度核对」等于没有。
    """

    @property
    def collection_complete(self) -> bool:
        """本轮采集是否可信到能驱动 finding 状态机（R6.2）。"""
        return self.batches_failed == 0

    @property
    def evaluated_instance_ids(self) -> frozenset[str]:
        """R6.2 的**评估集合** = 采集目标 − 采集失败的。

        ⚠️ `reconcile_findings` 必须用这个而不是 `attrs` 全集。
        一批 400 query 因限流失败 → 那批实例产不出 finding → 不在命中集合
        → 按 `resolved = 评估集合 ∩ 上轮active − 命中集合` 会被**整批误判为已解决**，
        客户会看到「昨天 200 个风险全部解决」。
        """
        return frozenset(a.instance_id for a in self.attrs) - self.failed_instance_ids

    @property
    def all_findings(self) -> tuple[Finding, ...]:
        return (*self.structural_findings, *self.capacity_findings)

    def counts_by_severity(self) -> dict[str, int]:
        """R9.3 的分级计数。**由这里确定性算出**，SHALL NOT 从 DA 报告文本解析。"""
        out: dict[str, int] = {}
        for f in self.all_findings:
            out[f.severity] = out.get(f.severity, 0) + 1
        return out


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------


def run_inspection(
    clients: InspectionClients,
    cfg: InspectionConfig,
    *,
    account_id: str,
    region: str,
    today: date,
    exclusions: Iterable[scope.ExclusionEntry] = (),
    price_table: Mapping[str, object] | None = None,
    refdata_override: StructuralRefData | None = None,
) -> InspectionResult:
    """跑完一轮，返回结果对象。**不写库、不推送、不调 DA。**

    Args:
        clients: 见 `InspectionClients`。缺哪个跳过对应采集。
        cfg: 三份规则配置 + 窗口长度。
        account_id / region: 落库键的一部分，SHALL 显式传 ——
            从 client 里反推 region 要额外一次 STS 调用，且在 stub 下拿不到。
        today: R14.2。窗口是 `[today − window_days, today)`，不含今天。
        exclusions: 排除清单条目。空 = 全部资源纳入巡检（R1.0 冷启动语义）。
        price_table: `adapters.pricing_table.load_pricing_table()` 的返回。
            None 则 savings 只走关键字兜底并标 coarse。
        refdata_override: 直接给参考数据（测试或缓存命中时用），跳过 API。

    ⚠️ 任何一步的 AWS 调用失败都**降级而不抛** —— 单个服务不可用不该让整轮无产出。
    降级的痕迹落在 `skipped` 与 `gaps` 里，SHALL NOT 静默。
    """
    skipped: list[str] = []

    # ① + ② 属性与补全
    attrs = load_resources(clients, account_id=account_id, region=region,
                           skipped=skipped)
    if not attrs:
        logger.warning("no resources found (account=%s region=%s)", account_id, region)
        return InspectionResult(
            account_id=account_id, region=region, today=today, data_date=None,
            skipped=tuple(skipped),
        )

    # ③ 入口过滤 —— **在拉指标之前**，否则为客户说了「别看」的资源付钱
    attrs, excluded = apply_exclusions(attrs, exclusions, today)
    if not attrs:
        logger.info("all %d resources excluded by scope lists", len(excluded))
        return InspectionResult(
            account_id=account_id, region=region, today=today, data_date=None,
            excluded=tuple(excluded), skipped=tuple(skipped),
        )

    # ④ 参考数据
    if refdata_override is not None:
        ref = refdata_override
    elif clients.rds is not None:
        ref = refdata.load_refdata(clients.rds)
    else:
        ref = StructuralRefData()
        skipped.append("refdata:no_rds_client")

    # ⑤ 指标
    bundle = collect_metrics(clients.cloudwatch, attrs, cfg=cfg, today=today,
                             skipped=skipped)
    data_date = bundle.window_end

    # ⑥ 结构性风险（纯属性，不依赖 ⑤ 的成败）
    structural = scan_structural(attrs, ref, cfg.structural, today)
    groups = group_by_fingerprint(structural, {a.instance_id: a for a in attrs})

    # ⑦ 闲置与容量（依赖 ⑤）
    pairs = build_candidates(bundle, attrs)
    idle_outcomes = score_candidates(
        pairs, bundle, cfg=cfg, data_date=data_date, price_table=price_table
    )
    capacity = scan_capacity(list(pairs), cfg.capacity, data_date)

    ranked = rank_cross_service(
        [o.score for o in idle_outcomes if o.score is not None]
    )

    result = InspectionResult(
        account_id=account_id, region=region, today=today, data_date=data_date,
        attrs=tuple(attrs), excluded=tuple(excluded), candidates=tuple(pairs),
        structural_findings=tuple(structural), fingerprint_groups=tuple(groups),
        capacity_findings=tuple(capacity), idle_outcomes=tuple(idle_outcomes),
        ranked_idle=tuple(ranked),
        gaps=bundle.gaps, queries_issued=bundle.queries_issued,
        batches_total=bundle.batches_total, batches_failed=bundle.batches_failed,
        failed_instance_ids=bundle.failed_instance_ids,
        skipped=tuple(skipped),
        ec_eol_table_staleness_days=refdata.elasticache_table_staleness_days(today),
    )
    _log_summary(result)
    return result


# ---------------------------------------------------------------------------
# 各步骤 —— 单独暴露，让 Lambda 可以只跑其中几步（例如月度只跑结构性风险）
# ---------------------------------------------------------------------------


def load_resources(
    clients: InspectionClients,
    *,
    account_id: str,
    region: str,
    skipped: list[str] | None = None,
) -> list[ResourceAttrs]:
    """① + ② describe → ResourceAttrs，并补 `memory_bytes` / `max_connections`。

    ⚠️ 补全的顺序有依赖：`enrich_max_connections` 会在参数组读不到值时退到规格表，
    而规格表的公式分支需要 `memory_bytes` —— 所以 memory 必须先补。
    （v1 公式分支默认关闭，但顺序仍按依赖来写，避免日后打开开关时踩坑。）
    """
    marks = skipped if skipped is not None else []
    out: list[ResourceAttrs] = []
    groups: attrs_repo.ParamGroupMap | None = None

    if clients.rds is not None:
        # ⚠️ 用 `_with_groups` 变体：参数组名就在这份响应里，
        # 不取出来的话 `enrich_max_connections` 只能再问一遍 AWS。
        # 🔴 `errors=marks` —— describe 失败要落进 `skipped`。
        #    不传的话失败被压成空列表，而空列表与「这个账号里真的没有资源」
        #    在返回值上完全一样：0 finding + run success + completeness 100%
        #    + 看板显示「跑过了、没找到风险」。见 `_describe_all` 的说明。
        rds_attrs, groups = attrs_repo.load_rds_attrs_with_groups(
            clients.rds, account_id, region, errors=marks
        )
        out.extend(rds_attrs)
    else:
        marks.append("rds:no_client")

    if clients.elasticache is not None:
        out.extend(
            attrs_repo.load_elasticache_attrs(
                clients.elasticache, account_id, region, errors=marks)
        )
    else:
        marks.append("elasticache:no_client")

    if not out:
        return out

    if clients.ec2 is not None:
        out = attrs_repo.enrich_memory(clients.ec2, out)
    else:
        # R2.1.2 的内存判定会因此拿不到分母 → 该维度丢弃并重归一化，不猜
        marks.append("memory_bytes:no_ec2_client")

    if clients.rds is not None:
        out = attrs_repo.enrich_max_connections(clients.rds, out, groups=groups)
    else:
        marks.append("max_connections:no_rds_client")

    return out


def apply_exclusions(
    attrs_list: Sequence[ResourceAttrs],
    exclusions: Iterable[scope.ExclusionEntry],
    today: date,
) -> tuple[list[ResourceAttrs], list[tuple[scope.ResourceRef, scope.ExclusionDecision]]]:
    """③ R1.8 入口过滤。返回 (保留的 attrs, 被排除的 ref + 理由)。

    ⚠️ 索引只建一次（`filter_targets` 内部做），O(n+m) 而非 O(n×m)。
    """
    refs = [
        scope.ResourceRef(
            account_id=a.account_id, service=a.service, instance_id=a.instance_id,
            cluster_id=a.cluster_id, region=a.region,
        )
        for a in attrs_list
    ]
    kept_refs, dropped = scope.filter_targets(refs, exclusions, today)

    # ⚠️ 反查必须用**四元组**，不能用 instance_id 单键。
    # 资源 ID 只在 (region, service) 内唯一 —— `keys.py` 为此在每个 DDB 键里
    # 都放了 region 与 service。早期实现是 `{r.instance_id for r in kept_refs}`，
    # 于是：
    #   · RDS 的 `cache-01` 被排除、ElastiCache 的 `cache-01` 没被排除
    #     → `"cache-01"` 仍在 kept 集合里 → **被排除的那台照样进了巡检**，
    #       同时还出现在 `excluded` 列表里（同一轮里既排除又保留）
    #   · 反过来排除 EC 那台，会把 RDS 那台一起丢掉
    # 前者让客户明说的「别看这个」失效并照付 GetMetricData 的钱，
    # 后者让资源静默消失。`scope.covers_region()` 为 region 做的工作
    # 全被这一行抹掉了。
    kept_keys = {
        (r.account_id, r.region, r.service, r.instance_id) for r in kept_refs
    }
    return [
        a for a in attrs_list
        if (a.account_id, a.region, a.service, a.instance_id) in kept_keys
    ], dropped


def collect_metrics(
    cw_client,
    attrs_list: Sequence[ResourceAttrs],
    *,
    cfg: InspectionConfig,
    today: date,
    skipped: list[str] | None = None,
) -> MetricsBundle:
    """⑤ 拉指标。没有 cloudwatch client 时返回空 bundle 而不是抛。

    ⚠️ 空 bundle 会让闲置与容量两侧全部产不出结论（所有指标都是 None →
    维度全丢 / 否决项缺失 → 不判定）。这是**正确的降级方向**：
    宁可少报，不要拿 0 当「完全闲置」。结构性风险不受影响，照样出结果。
    """
    if cw_client is None:
        if skipped is not None:
            skipped.append("metrics:no_cloudwatch_client")
        return MetricsBundle()
    return metrics_repo.collect(
        cw_client, attrs_list, window_days=cfg.window_days, today=today,
        max_workers=cfg.max_workers,
    )


def build_candidates(
    bundle: MetricsBundle, attrs_list: Sequence[ResourceAttrs]
) -> list[tuple[CandidateRecord, ResourceAttrs]]:
    """⑥ 把采集结果按实例装成 (指标快照, 属性) 对。

    ⚠️ 成对返回而不是两个平行列表 —— `score_idle` 与 `scan_capacity` 都要求
    candidate 与 attrs 属于同一台实例，用两个 list 靠下标对齐是最容易错位的写法
    （一旦某台在中途被过滤掉，后面全错，且分数看起来仍然「合理」）。
    """
    return [
        (metrics_repo.to_candidate(bundle, a), a)
        for a in attrs_list
        if a.service in _SCORABLE_SERVICES
    ]


# 有闲置评分实现的服务。未注册的服务跳过评分但仍参与结构性风险。
_SCORABLE_SERVICES = frozenset({"rds", "elasticache"})


def score_candidates(
    pairs: Sequence[tuple[CandidateRecord, ResourceAttrs]],
    bundle: MetricsBundle,
    *,
    cfg: InspectionConfig,
    data_date: date | None,
    price_table: Mapping[str, object] | None = None,
) -> list[IdleOutcome]:
    """⑦ 否决 → 闲置评分。被否决的也返回（带原因）。

    `consecutive_low_days` 从 `daily_rows_for_lowdays` 现算 ——
    它需要日序列，而序列在 bundle 里，所以这一步必须在编排层做，
    不能塞进 `score_idle`（那会给 domain 层引入 bundle 依赖）。
    """
    out: list[IdleOutcome] = []

    for candidate, attrs in pairs:
        passed, vetoes = apply_vetoes(candidate, cfg.idle)
        if not passed:
            out.append(IdleOutcome(
                instance_id=candidate.instance_id, service=candidate.service,
                passed=False, vetoes=vetoes,
            ))
            continue

        rows = metrics_repo.daily_rows_for_lowdays(bundle, attrs)
        low_days = count_consecutive_low(rows, cfg.idle)
        savings = _savings_of(attrs, price_table)

        out.append(IdleOutcome(
            instance_id=candidate.instance_id, service=candidate.service,
            passed=True, vetoes=vetoes, consecutive_low_days=low_days,
            score=score_idle(
                candidate, attrs, cfg.idle,
                consecutive_low_days=low_days,
                estimated_monthly_savings=savings,
                data_date=data_date,
            ),
        ))

    return out


def _savings_of(
    attrs: ResourceAttrs, price_table: Mapping[str, object] | None
) -> PriceEstimate:
    """ElastiCache 按节点数乘；RDS 恒按 1 算。"""
    nodes = attrs.num_cache_nodes if attrs.service == "elasticache" else 1
    return estimate_monthly_savings(
        attrs.instance_class, attrs.engine, nodes or 1, price_table
    )


def _log_summary(r: InspectionResult) -> None:
    logger.info(
        "inspection done account=%s region=%s data_date=%s | "
        "resources=%d excluded=%d | structural=%d(%d groups) capacity=%d "
        "idle_passed=%d/%d | queries=%d gaps=%d batches=%d/%d complete=%s | skipped=%s",
        r.account_id, r.region, r.data_date,
        len(r.attrs), len(r.excluded),
        len(r.structural_findings), len(r.fingerprint_groups),
        len(r.capacity_findings),
        sum(1 for o in r.idle_outcomes if o.passed), len(r.idle_outcomes),
        r.queries_issued, len(r.gaps),
        r.batches_total - r.batches_failed, r.batches_total,
        r.collection_complete, r.skipped or "-",
    )
    if not r.collection_complete:
        logger.error(
            "collection incomplete: %d/%d batches failed, %d instances not evaluated "
            "— reconcile_findings SHALL use evaluated_instance_ids (%d), not attrs (%d)",
            r.batches_failed, r.batches_total, len(r.failed_instance_ids),
            len(r.evaluated_instance_ids), len(r.attrs),
        )
