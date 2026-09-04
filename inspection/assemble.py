"""判定结果 → 派发计划：把各 domain 模块接成一条链。

## 为什么单独一个模块

`_run_inspection` 需要真 AWS 客户端才跑得到，塞在里面的逻辑**永远没有测试**。
2026-08-20 的自查发现了这件事的代价：`rollup` / `gating` / `dispatch` /
`task_builder` / `journal_gate` 五个模块写完、测完、反向注入验完，
但 `_run_inspection` 里**一次都没调用** —— 采完指标写完序列库就结束了。

```
按那个状态部署：巡检「成功」→ 一条 finding 不产出 → 一次 DA 不调
                run 状态是 success
```

这正是本 feature 从头到尾在防的静默失败，而它出在我自己的接线上。
所以接线本身必须是纯函数 + 可测的。

## 链路顺序（每一步的位置都有理由）

```
① 阈值判定           thresholds.evaluate_threshold   高负载轮
② finding 状态机     lifecycle.reconcile             跨天演进
③ 出口过滤           scope.is_excluded               R1.8 二次兜底
④ 群体 rollup        rollup.rollup                   R8.6，先集群内合并
⑤ 载荷组装           payload.build_payload
⑥ 派发闸门           gating.decide                   playbook / 复用 / 额度
⑦ 复合排序 + 配额     dispatch.plan_dispatch          R12.6
⑧ 装箱 + task        payload.pack_payloads → task_builder.build_task
```

⚠️ ③ 在 ④ 之前：先剔掉被排除的成员再算 rollup 比例，否则分母把客户
说了「别看」的实例也算进去，60% 判据的分母虚高。

⚠️ ④ 在 ⑦ 之前（R12.6a 明写「SHALL 先做集群 / 副本组 rollup 去重」）：
反过来会让同一集群的 6 个成员各占一个 top-N 名额，把其他集群挤出去。

⚠️ ⑥ 在 ⑦ 之前：闸门里 playbook 与结论复用是**零成本**路径，
先过闸门能让它们不占配额名额。反过来会让「本来免费就能出结论」的 finding
被配额挡在门外。
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from typing import Any

from inspection.domain import gating, payload as pl, rollup as rl, scope
from inspection.domain import task_builder as tb
from inspection.domain.budget import Tier
from inspection.domain.dispatch import Candidate, DispatchPlan, plan_dispatch
from inspection.domain.dto import (
    Finding,
    ResourceAttrs,
    Severity,
    StructuralRule,
)
from inspection.domain.lifecycle import (
    FindingRecord,
    Observation,
    ReconcileResult,
    reconcile,
)
from inspection.domain.schedule import RunType

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AssembledFinding:
    """一条走完全链的 finding。"""

    finding_id: str
    instance_id: str
    metric: str
    severity: Severity
    hit_reasons: tuple[str, ...]
    payload: Mapping[str, Any]
    decision: gating.Decision
    is_rollup: bool = False
    member_count: int = 1
    rollup_covered_by: str = ""
    """被哪条集群级 finding 覆盖（空 = 没被覆盖）。

    🔴 **只影响派发，不影响落库与看板。** 2026-08-26 之前 rollup 的做法是把
    被合并的成员 finding 从列表里**删掉**，而 `RollupGroup` 在调用侧只被
    `len()` 用了一次 —— 没有任何代码把它变成 finding、落库或渲染。后果：

    ```
    3 台 prod Aurora 成员 CPUUtilization 92% CRITICAL
      → rollup 后 findings = []
      → 派发 0 条、to_observations 0 条
      → heartbeat_if_empty 判据是 `if findings:` → 发出「本轮无风险」通报
      → 上一轮的 active 行走 _step_missed（昨天刚建的直接判 RESOLVED + 误报）
    ```

    客户看到「本轮无风险」，真相是整个生产集群 CPU 打满。run 状态 success、
    completeness 100%、`rollup_groups: 1` 老实记在 stats 里但没人读。

    现在改成：成员**全部保留**（落库、看板、状态机都看得到），只在派发那一层
    由 `apply_gates` 落 `SkipReason.ROLLUP_MEMBER` 去重 —— rollup 的成本收益
    （一个集群只买一次判读）保住了，而风险不再消失。
    """
    score: Any = None
    """闲置评分结果（`IdleScore`）。只有闲置 finding 有，其余恒 None。

    🔴 **不塞进 payload。** 闲置轮走 `SkipReason.DETERMINISTIC`，压根不派发
    DA —— 塞进去只会被 `build_payload` 组装出来然后随载荷一起丢掉，
    还要连带改 `validate_payload` 的契约。评分因子的用途是**落进 finding 行
    给看板看**，所以走 `to_evidence` 那条路。

    ⚠️ 类型写 `Any` 而不是 `IdleScore`：`dto` 在本模块是延迟 import 的
    （`idle_findings` 里才 import scoring），标注成具体类型会把它提到模块顶层。
    """


@dataclass(frozen=True)
class AssembleResult:
    """接线的产物。"""

    findings: tuple[AssembledFinding, ...] = ()
    transitions: tuple[Any, ...] = ()
    """`reconcile` 的结果，交给 `store.apply_transitions` 落库。"""
    rollup_groups: tuple[rl.RollupGroup, ...] = ()
    excluded_at_exit: tuple[str, ...] = ()
    """出口过滤剔掉的 finding_id（R1.8 二次兜底命中的）。"""
    plan: DispatchPlan | None = None
    tasks: tuple[tb.TaskRequest, ...] = ()
    skipped_by_gate: Mapping[str, int] = field(default_factory=dict)
    """各闸门各拦下多少条 —— 报告要能解释「为什么这条没有 AI 分析」。"""

    @property
    def dispatch_count(self) -> int:
        return len(self.tasks)


def _daily_rows(bundle: Any, iid: str, metric: str, stat: str) -> list[dict]:
    """判定指标的逐日行 → 载荷 `daily[]`。

    ⚠️ skill 明写「用 `daily[]` 而不是最新单值」——「峰值决定小一号规格能不能扛住」、
    「`ReplicaLag == -1` 持续多久决定它是不是真断了」。不给 daily，
    这两条判断 DA 只能靠 `judgment.value` 那**一个**数字硬猜。

    ⚠️ 保留 `value=None` 的那一天而不是过滤掉 —— 缺哪一天本身是证据。
    过滤会让 7 天里缺 3 天的曲线看起来是连续的 6 天。
    """
    s = bundle.get(iid, metric, stat)
    if s is None:
        return []
    return [{"date": p.data_date.isoformat(), "value": p.value} for p in s.points]


def _correlated_section(
    bundle: Any, attrs: ResourceAttrs, fam: str, *, failed: bool = False
) -> dict[str, Any]:
    """关联指标 → 载荷 `correlated{}`（：**空数组是被禁止的**）。

    每个键要么是非空序列，要么是 `unavailable()` 声明。四档缺失原因不可合并：
    `NOT_APPLICABLE` 本身是**有效证据**（「没有 AuroraReplicaLag」=「这台不是 reader」），
    其余三档只能得出 insufficient_evidence。

    ⚠️ 副本判定指标是 idle 载荷的**硬性要求**（`validate_payload` 会拦）。
    Memcached 的关联指标清单里压根没有副本信号 —— 它没有复制机制，
    所以走 `NOT_APPLICABLE`，而不是「拉了没拿到」。这两者对 DA 是相反的结论：
    前者「不是副本，可以考虑删」，后者「可能是 standby，千万别删」。
    """
    from inspection.domain import metrics_meta as mm
    from inspection.domain.dto import resolve_role

    iid = attrs.instance_id
    role = resolve_role(attrs)
    out: dict[str, Any] = {}
    for m in mm.CORRELATION_METRICS.get(fam, ()):
        stat = mm.judge_stat_of(m, fam)
        if stat is None:
            continue
        vals = list(bundle.daily(iid, m, stat))
        if any(v is not None for v in vals):
            # 🔴 **有数据就发数据，即使适用性表说它不该有。** 实测数据是最高一级
            #    证据（`ReplicationLag` 在 Redis primary 上确实有值）——
            #    反过来会让我们拿一张表去否认 CloudWatch 里真实存在的曲线。
            out[m] = vals
            continue
        # 没数据 → 是「结构上不该有」还是「期望有却拿到空」？
        # ⚠️ 这两档合并会误删灾备副本，见 `dto.Unavailable` 的说明。
        #    判据集中在 `metrics_meta.applicability()`（角色 / 规格 / 卷类型），
        #    不在这里逐个 `startswith` —— 那样每加一条规则就多一个 elif，
        #    而两条判读路径（自动派发与手动派发）都走这个函数。
        app = mm.applicability(
            m, family=fam, role=role,
            instance_class=attrs.instance_class, storage_type=attrs.storage_type)
        if not app.applicable:
            out[m] = pl.unavailable(
                pl.Unavailable.NOT_APPLICABLE, detail=app.reason)
        elif failed:
            out[m] = pl.unavailable(pl.Unavailable.COLLECTION_FAILED)
        else:
            out[m] = pl.unavailable(pl.Unavailable.NO_DATAPOINTS)

    if not (pl.REPLICA_SIGNAL_METRICS & set(out)):
        # 这一族的关联清单里没有任何复制类指标（Memcached 就是这样）→
        # 合成一条显式声明，`validate_payload` 对 idle 类要求至少有一个。
        # ⚠️ 理由从 `applicability()` 取，不在这里另写一套判据 ——
        #    另写的那一套会与 `metric_contract` 里的 `applicable` 打架，
        #    而载荷里两个字段互相矛盾时判读侧只能挑一个信。
        app = mm.applicability(
            "ReplicaLag", family=fam, role=role,
            instance_class=attrs.instance_class, storage_type=attrs.storage_type)
        out["ReplicaLag"] = (
            pl.unavailable(pl.Unavailable.NOT_APPLICABLE, detail=app.reason)
            if not app.applicable
            else pl.unavailable(pl.Unavailable.NO_DATAPOINTS)
        )
    return out


def high_load_findings(
    bundle: Any,
    attrs_by_id: Mapping[str, ResourceAttrs],
    *,
    cfg: Any,
    data_date: date,
    window_days: int = 7,
    suppressed: Mapping[tuple[str, str], str] | None = None,
    locale: str = "zh",
    config_version: str = "",
    healthy_out: list[tuple[str, str]] | None = None,
    not_evaluable_out: list[str] | None = None,
    reachable: bool = True,
) -> list[AssembledFinding]:
    """高负载轮的阈值判定 → `AssembledFinding`（的剩余部分）。

    ⚠️ 只返回 finding。**未命中且水位已回健康区**的那些由
    `judge_high_load()` 一起给出（同一次判定，不重算）—— 见那个函数的说明。

    ⚠️ 这一段**曾经缺失**。6.17 接线时高负载轮的 findings 是空列表，
    于是高负载巡检永远零命中 —— 而零命中会去派 heartbeat，
    报告上写「本轮无风险」。看不出阈值判定压根没跑。

    ⚠️ `suppressed` 里的 (实例, 指标) **不产 finding**（R8.5 的 warm-up 抑制）。
    抑制发生在**判定之后、组装之前**：判定照跑（否则序列库缺那几天的判定依据），
    只是不上报。反过来（判定前就跳过）会让「抑制期结束后突然冒出一条
    已持续 5 天的 finding」——而那 5 天的证据我们其实有。

    ⚠️ 只对**评估集合内**的实例判定。采集失败的那些既不 hit 也不 healthy，
    进了会让它们的 active finding 被误判 resolved（R6.2）。
    """
    from inspection.domain import metrics_meta as mm
    from inspection.domain import severity as sev_mod
    from inspection.domain import specs
    from inspection.domain import thresholds as th

    evaluated = bundle.evaluated_instance_ids(list(attrs_by_id))
    out: list[AssembledFinding] = []
    healthy: list[tuple[str, str]] = []
    not_evaluable: list[str] = []
    # 判定盲区（缺分母）。单独一个列表，最后拼在 out 后面 ——
    # 它们是 INFO 且不派发，混在主循环里 append 会让排序逻辑更难读。
    blind: list[AssembledFinding] = []
    supp = suppressed or {}

    for iid in sorted(evaluated):
        attrs = attrs_by_id.get(iid)
        if attrs is None:
            continue
        fam = mm.metric_family(attrs.service, attrs.engine)
        # 🔴 引擎不在 v1 判定范围（DocumentDB / Neptune）→ 产一条 INFO 盲区
        #    通知后跳过。它们的指标在 `AWS/DocDB` / `AWS/Neptune`，走下面的
        #    判定会每个指标都 NO_DATA → coverage 0 → 空 verdicts → **一条
        #    finding 都不产**，那台实例在看板上完全消失。
        #    ⚠️ 它们确实会进到这里：`describe-db-instances` 返回它们
        #    （共用 RDS 控制平面），而「返回空数据点」不算采集失败，
        #    所以它们在 `evaluated_instance_ids` 里。
        if mm.is_unsupported_engine(attrs.engine):
            blind.append(_unsupported_engine_finding(attrs, data_date=data_date))
            continue
        metrics = list(mm.alerting_metrics(attrs.service, attrs.engine))
        if not metrics:
            # 这个服务/引擎没有任何 alerting 指标 → 本轮判不了它。
            # ⚠️ 必须报出去（见下面 `not_evaluable_out`），否则它留在评估集合里
            #    「未命中」，把上一轮的 finding 判成 resolved。
            not_evaluable.append(iid)
            continue
        # 🔴 T 系专属判定：credit 余额只对 burstable 有意义。
        #
        # 对 T 系实例，`CPUUtilization` 会骗人 —— credit 耗尽后 CPU 被硬压到
        # baseline（t4g 是 10%~40%），此时「CPU 30%」与「CPU 打满」是同一件事，
        # 而 30% 远低于 70% 的门槛，那条规则一声不响。实测真实客户 49 台 RDS
        # 里 18 台（37%）是 T 系，含 7 台 t4g.micro。
        #
        # ⚠️ **逐台加，不放进 `ALERTING_METRICS`。** `metrics_meta` 的 R3.8b
        #    准入门槛点名了这个指标：「`CPUCreditBalance` 只有 T 系有」，
        #    放进族清单会让每台非 T 系实例每天一条永远修不好的缺口。
        #    采集侧照采（它在 `CORRELATION_METRICS` 里），所以 bundle 里有值。
        if specs.is_burstable(attrs.instance_class):
            metrics.append("CPUCreditBalance")

        values: dict[str, float | None] = {}
        stats: dict[str, str] = {}
        daily: dict[str, Sequence[float | None]] = {}
        for m in metrics:
            # ⚠️ `judge_stat_of` 必须**带族**调用（R3.2a）：`CPUUtilization`
            #    在 `AWS/RDS` 上判 p95，在 `AWS/ElastiCache` 上没有百分位，
            #    要降级到 Maximum。不带族会去取一个从没被请求过的统计量 → 恒 None。
            #
            # ⚠️ 返回 None = 指标未归类。**跳过，不要兜底成 Average**（R3.3）：
            #    兜底会让一个方向未知的指标参与判定 —— 而「越大越坏」还是
            #    「越小越坏」都不知道的指标，判出来的结论是随机的。
            stat = mm.judge_stat_of(m, fam)
            if stat is None:
                logger.warning("%s 未归类，跳过判定（R3.3）", m)
                continue
            stats[m] = stat
            values[m] = bundle.value(iid, m, stat)
            # 🔴 用**窗口对齐**版：缺的那天是 None，慢性计数才会在断日处中断。
            #    `daily()` 只含真有数据的天，于是 `count_consecutive_high` 的
            #    `if value is None: break` 在生产上永远不触发 ——「8/20 有、
            #    8/21 缺、8/22~8/26 有」会被数成连续 6 天。
            daily[m] = bundle.daily_aligned(iid, m, stat)

        if not stats:
            # 所有指标都未归类 / 取不到统计量 → 判不了。
            not_evaluable.append(iid)
            continue
        # ⚠️ 伴随指标（`thresholds.COMPANIONS`）的值**不需要单独取** ——
        #    `alerting_metrics` 比 `THRESHOLD_METRICS` 大，已经含 `ReadIOPS`；
        #    Redis 那侧的伴随指标 `DatabaseMemoryUsagePercentage` 自己就有阈值。
        #    所以上面那个循环已经把它们放进 `values` 了。
        #    （曾在这里补了一段单独取值的代码 —— 反向注入时发现删掉它测试
        #      照样全绿，才确认是多余的。）
        coverage = max((len([v for v in d if v is not None])
                        for d in daily.values()), default=0)
        # 百分比类阈值的分母（实例总内存 / 分配存储）。
        # ⚠️ `memory_bytes` 常常是 None（需要 ec2:DescribeInstanceTypes 补全）。
        #    不传的表现是内存判定全部 NO_DENOMINATOR —— 那是**有意的**，
        #    并由下面那条 no_capacity_metadata finding 变成可见的缺口。
        capacity = th.Capacity(
            memory_bytes=attrs.memory_bytes,
            allocated_storage_bytes=(
                attrs.allocated_storage_gb * 1024 ** 3
                if attrs.allocated_storage_gb else None),
        )
        # 🔴 按引擎选阈值。Aurora 的 latency 分布与社区版差一个数量级
        #    （p90 3.83ms vs 10.0ms），一个数管不了两种引擎 ——
        #    15ms 判 Aurora 等于不判（实测 24 台 Aurora max 只有 7.42ms）。
        #    ⚠️ 只有 latency 分档，其余字段实测分布一致（见 `for_engine`）。
        eff_cfg = cfg.for_engine(attrs.engine)
        verdict = th.evaluate_threshold(
            # ⚠️ 传 `list(stats)` 不是 `list(metrics)` —— 未归类而被跳过的
            #    指标不能进判定，否则 values 里没有它、判定侧却在等它。
            instance_id=iid, values=values, cfg=eff_cfg,
            coverage_days=coverage, stats=stats, metrics=list(stats),
            daily=daily, window_days=window_days, capacity=capacity)

        # 🔴 判定盲区要**可见**：按规格百分比判的指标缺分母时，那一类告警
        #    对这台实例永久静默，而看板上「没有内存告警」与「内存健康」
        #    长得完全一样（R9.11 的同一个道理）。
        #    ⚠️ 放在 hit 判断**之前** —— 一台既缺分母又没别的命中的实例
        #    会在下面 `continue` 掉，那时这条盲区通知就再也产不出来了。
        # ── 本轮**真的判过**吗（R6.2a 的评估集合判据）──
        #
        # 🔴 `InstanceVerdict.evaluable` 的 docstring 写着「调用方 SHALL 用它
        #    决定要不要把这台放进评估集合」，而全仓 `grep .evaluable` 在
        #    `inspection/` 与 `lambda_inspection_executor/` 下**零命中** ——
        #    只有 e2e 脚本断言过它。
        #
        #    后果：某台实例的 coverage 掉到 `min_coverage_days`(5) 以下
        #    （新建实例、节点被替换、指标名/维度写错、DocDB/Neptune），
        #    而采集批次本身成功 → 它仍在 `evaluated_instance_ids` 里
        #    （那个只减「采集失败」的实例）→ 本轮产不出 finding
        #    → 上一轮那条走 `_step_missed`。若它是昨天刚建的（state=new、
        #    未确认），`lifecycle` 直接判 **RESOLVED + prediction_missed**，
        #    note 是 `unconfirmed-new-disappeared` —— 一条真实风险被记成误报
        #    并从看板消失。R6.2 的第二半在生产链路上没有接。
        #
        # ⚠️ 放在 `missing_denominator` **之前**：缺分母那条盲区通知仍然要出
        #    （它是「可见的缺口」），但这台不该进评估集合。两件事不冲突。
        if not_evaluable_out is not None and not verdict.evaluable:
            not_evaluable.append(iid)

        missing = verdict.missing_denominator
        if missing and specs.has_fixed_memory(attrs.instance_class):
            # ⚠️ Serverless v2（`db.serverless`）被 `has_fixed_memory` 挡在
            #    这里：它的内存随 ACU 秒级伸缩，压根没有固定分母 ——
            #    「不适用」与「拿不到」不是一回事。不挡的表现是每台
            #    Serverless 实例每天报一条**永远修不掉**的盲区通知。
            blind.append(_no_capacity_metadata_finding(
                attrs, missing, data_date=data_date))

        # ── 水位已回健康区的指标（`healthy_out`）──
        #
        # 🔴 状态机的 `resolving → RESOLVED` 需要它。`to_observations` 只处理
        #    命中的，它的 docstring 明写「未命中的由调用方按 evaluated 集合
        #    给出」—— 而调用方从来没给，全仓 `healthy=` 只有一处、写死 False。
        #    后果是客户处置完之后那条 finding 走进 **CHRONIC 并永久留在看板**，
        #    `ResolutionKind.FIXED` 一次都产不出来（见 `judge_high_load`）。
        #
        # ⚠️ 判据是 `headroom > MEDIUM_HEADROOM`，与 severity 用同一个常数 ——
        #    另立一个门槛会在「不再算高负载」与「算恢复了」之间留一段灰区。
        # ⚠️ 只收**本轮真的判过**的指标（`v.headroom is not None` 说明有分母、
        #    有数据、方向已知）。采集失败 / 缺分母的那些既不 hit 也不 healthy。
        # ⚠️ 慢性还在的指标**不算恢复**，即使当天 headroom 回来了 ——
        #    「横在坏水位」正是 R2.6.3 要盯的形态。
        if healthy_out is not None:
            for v in verdict.verdicts:
                # ⚠️ `v.hit` 这一半是**冗余的**（越线 → headroom ≤ 0，
                #    下面那条 `> MEDIUM_HEADROOM` 本来就不成立）；
                #    `chronic_days` 这一半在当前设计下**不可达** ——
                #    `count_consecutive_high` 从最近一天开始数，所以慢性命中
                #    必然意味着最近一天在坏侧，headroom 也就 ≤ 0。
                #
                #    反向注入验过：删掉这一行测试照样全绿。**留着是刻意的**，
                #    因为它表达的是语义前提「横在坏水位不算恢复」，而
                #    `chronic_days` 的算法将来可能允许跳过缺数据的天
                #    （那时慢性就能与「当天健康」共存，这一行立刻变成必需）。
                #    不假装它现在承载保证 —— 这一轮一堆缺陷正是「看起来承载
                #    保证、实际不起作用」的代码（is_rollup / evaluable / skipped）。
                if v.hit or v.metric in verdict.chronic_days:
                    continue
                if v.headroom is not None and v.headroom > sev_mod.MEDIUM_HEADROOM:
                    healthy.append((iid, v.metric))

        if not verdict.hit and not verdict.chronic:
            continue

        reasons = th.payload_hit_reasons(verdict)
        if not reasons:
            continue
        # 🔴 慢性**单独**命中（hit=False 而 chronic=True）时 `worst` 是 None。
        #    退到 `chronic_worst`（慢性天数最多那个指标的 MetricVerdict）——
        #    与 `severity_for_verdict` 同口径。
        #
        #    原来直接退到 `metrics[0]`（通常是 CPUUtilization），产出的是一条
        #    彻底错位的 finding：指标错、value/threshold 全空、日序列给的是
        #    CPU 的（健康的）而 hit_reason 说「已连续 7 天在坏侧」。
        #    页面上是一条 HIGH 的「CPU 使用率」卡片而没有任何数字，
        #    真相是内存慢性低位。见 `InstanceVerdict.chronic_worst`。
        #
        # ⚠️ `metrics[0]` 仍然保留在最后 —— `payload_hit_reasons` 非空但既没有
        #    命中也没有慢性的形态理论上不该出现，真出现时给一个确定的指标名
        #    比抛 IndexError 好（后者会让整轮失败）。
        worst = verdict.worst or verdict.chronic_worst
        metric = worst.metric if worst else metrics[0]
        if (iid, metric) in supp:
            # R8.5：warm-up / 平台期内不上报。判定已经跑过，证据在序列库里。
            logger.info("warm-up 抑制 %s/%s（%s）", iid, metric, supp[(iid, metric)])
            continue

        severity = sev_mod.severity_for_verdict(verdict, attrs)
        finding_id = "#".join((
            attrs.account_id, attrs.region or "-", attrs.service,
            iid, "threshold_high", metric))
        payload = pl.build_payload(
            finding_id=finding_id, account_id=attrs.account_id,
            region=attrs.region, instance=iid, engine=attrs.engine,
            metric_family=fam, data_date=data_date,
            hit_reason=reasons, severity=severity,
            daily=_daily_rows(bundle, iid, metric, stats.get(metric, "Average")),
            correlated=_correlated_section(bundle, attrs, fam),
            # `threshold_config` 是**客户可改**的那份配置（契约表原话）——
            # 给 DA 是为了让它知道判据可调，以及方向是 bad_up 还是 bad_down。
            # ⚠️ `direction` 必须来自 `metrics_meta` 这一个来源。
            #    在这里写死 bad_up 会让 FreeableMemory / FreeStorageSpace
            #    这类「越小越坏」的指标被 DA 反向解读：
            #    「剩余内存 1e8 低于阈值」会被读成「还没到上限，没事」。
            threshold_config={
                "metric": metric,
                "direction": getattr(
                    mm.direction_of(metric), "value", pl.DIR_BAD_UP),
                "value": worst.threshold if worst else None,
            },
            # ⚠️ `Judgment` 的字段名是 `consecutive_high_days`，不是
            #    `chronic_days`（载荷契约里那个才叫 chronic_days）。
            #    `direction` 也不在 Judgment 上 —— 它由 payload 侧从 metric 推。
            judgment=pl.Judgment(
                metric=metric,
                stat=stats.get(metric, "Average"),
                value=worst.value if worst else None,
                threshold=worst.threshold if worst else None,
                headroom=worst.headroom if worst else None,
                consecutive_high_days=verdict.chronic_worst_days,
                # 🔴 写**这个指标**的 coverage，不是实例级那个跨指标最大值。
                #    实测过的错形态：FreeableMemory 只有 5 个日点、
                #    CPUUtilization 有 7 个，载荷写 `consecutive_high_days=5 /
                #    coverage_days=7` —— DA 读成「7 天里连续 5 天」，
                #    而那个指标只有 5 天数据。
                coverage_days=verdict.metric_coverage.get(
                    metric, verdict.coverage_days),
                # 百分比类指标的原始值与分母。⚠️ 非百分比类这两个是 None，
                #    `as_dict()` 会一起省掉 —— 不会在载荷里留一对孤立的键。
                raw_value=worst.raw_value if worst else None,
                denominator=worst.denominator if worst else None,
                # 伴随条件的证据（`thresholds.COMPANIONS`）。
                # 🔴 这是「1.1% 可用内存到底是不是问题」的唯一判据 ——
                #    实测两台真实实例都在 1.1%~1.3%，一台 492 IOPS/s 在回盘读
                #    （真问题），另一台 0.07 IOPS/s（buffer pool 正常占用）。
                #    不下发的话 DA 只能说「可用内存 1.1%」，而客户完全有理由
                #    把它当成 MySQL 的正常稳态忽略掉。
                companion_metric=worst.companion_metric if worst else "",
                companion_value=worst.companion_value if worst else None,
                companion_threshold=(
                    worst.companion_threshold if worst else None),
            ),
            attrs=attrs, config_version=config_version, locale=locale,
            resource_reachable=reachable)
        out.append(AssembledFinding(
            finding_id=finding_id, instance_id=iid, metric=metric,
            severity=severity, hit_reasons=tuple(reasons), payload=payload,
            decision=gating.Decision(dispatch=True)))
    if healthy_out is not None:
        healthy_out.extend(healthy)
    if not_evaluable_out is not None:
        not_evaluable_out.extend(not_evaluable)
    return out + blind


def judge_high_load(
    bundle: Any,
    attrs_by_id: Mapping[str, ResourceAttrs],
    *,
    cfg: Any,
    data_date: date,
    window_days: int = 7,
    suppressed: Mapping[tuple[str, str], str] | None = None,
    locale: str = "zh",
    config_version: str = "",
    reachable: bool = True,
) -> tuple[list[AssembledFinding], list[tuple[str, str]], list[str]]:
    """`high_load_findings` + healthy 对 + **本轮判不了的实例 id**。

    ## 为什么必须有第二个返回值

    状态机的 `Observation.healthy` 决定 `resolving → RESOLVED` 还是
    `resolving → CHRONIC`（`lifecycle._step_missed`）。而 `to_observations`
    只处理**命中**的 finding，它的 docstring 明写「未命中的由调用方按
    `evaluated` 集合给出」—— **调用方从来没给**。

    🔴 全仓 `grep healthy=` 只有一处赋值点，写死 `False`。后果：

    ```
    客户把 gp2 换成 gp3 / 扩了存储 / 换了规格（真的处置完了）
      → 那条 finding 走 active → resolving → **CHRONIC**
      → note = still-at-risk-level-for-N-days
      → FindingState.CHRONIC.is_open 为真 → 永久留在看板与周报
      → 每 3 天再推一次 HIGH（push_policy 的 backoff）
    ```

    同时 `ResolutionKind.FIXED` 一次都产不出来 —— R9.7 的准确率闭环只剩
    `prediction_missed`，于是**越是正常工作的部署，误报率看起来越高**。

    ## 判据

    「水位回健康区」= 该指标本轮的 `headroom > MEDIUM_HEADROOM`（0.35）。
    用与 severity 同一个常数，不另立一个门槛 —— 两个门槛会让「不再算高负载」
    与「算恢复了」之间出现一段谁都不认领的灰区。

    ⚠️ 只报**这一轮真的判过**的指标。采集失败的实例既不 hit 也不 healthy
    （它们压根不该进评估集合，否则 active finding 会被误判 resolved，R6.2）。

    ⚠️ 返回 `(instance_id, metric)` 而不是 finding_id：调用方要按**自己的**
    规则域拼 finding_id（六段定长，R6.1），而那个拼装逻辑已经在
    `_healthy_observations()` 里了 —— 让这个函数也拼一遍会出现两份格式。
    """
    healthy: list[tuple[str, str]] = []
    not_evaluable: list[str] = []
    findings = high_load_findings(
        bundle, attrs_by_id, cfg=cfg, data_date=data_date,
        window_days=window_days, suppressed=suppressed, locale=locale,
        config_version=config_version, healthy_out=healthy,
        not_evaluable_out=not_evaluable, reachable=reachable)
    return findings, healthy, not_evaluable


def _unsupported_engine_finding(
    attrs: ResourceAttrs, *, data_date: date,
) -> AssembledFinding:
    """「这台实例的引擎我们判不了」的 INFO finding。

    🔴 存在的理由与 `_no_capacity_metadata_finding` 完全一样：把一个**静默的
    盲区**变成一行可见的东西。

    DocumentDB / Neptune 会被 `describe-db-instances` 返回（共用 RDS 控制
    平面），所以它们进了采集清单；但指标在 `AWS/DocDB` / `AWS/Neptune`
    namespace，用 `AWS/RDS` 查全部取不到 → `coverage_days=0` → 空 verdicts
    → **一条 finding 都不产**。表现是它在看板上完全消失，与「巡检过了、
    很健康」不可区分。

    ⚠️ 不派发 DA（`SkipReason.PLAYBOOK`，同上）：动作是「换用对应服务的
    巡检」或「确认无需巡检」，两者都不需要 LLM。
    """
    from inspection.domain import metrics_meta as mm

    eng = (attrs.engine or "").strip().lower()
    _NS = {"docdb": "AWS/DocDB", "neptune": "AWS/Neptune"}
    ns = _NS.get(eng, "该引擎自己的 namespace")
    conclusion = (
        f"这台实例的引擎是 `{attrs.engine}`，**不在本轮巡检的判定范围内** —— "
        f"它的 CloudWatch 指标发布在 `{ns}`，而巡检读的是 `AWS/RDS`，"
        f"所以本轮对它的所有指标判定都拿不到数据。"
        f"⚠️ 这不代表它健康，只代表**我们没看**。"
        f"它出现在清单里是因为 `rds:DescribeDBInstances` 会返回 "
        f"DocumentDB / Neptune 实例（共用 RDS 控制平面）。"
        f"处置：若这台需要巡检，请改用对应服务的监控；"
        f"若确认不需要，把它加进排除清单，本条会自行 resolve。"
    )
    f = Finding(
        account_id=attrs.account_id, region=attrs.region, service=attrs.service,
        instance_id=attrs.instance_id,
        rule=StructuralRule.UNSUPPORTED_ENGINE,
        severity=Severity.INFO,
        cadence="monthly",
        data_date=data_date,
        # ⚠️ 只放码与字符串，不放散文（R10.9b）。namespace 是确定性事实，
        #    不是判断，所以可以进 params 供 UI 直接显示。
        params={"engine": eng, "namespace": ns},
    )
    payload = pl.build_payload(
        finding_id=f.finding_id, account_id=attrs.account_id,
        region=attrs.region, instance=attrs.instance_id, engine=attrs.engine,
        metric_family=mm.metric_family(attrs.service, attrs.engine),
        data_date=data_date, hit_reason=[pl.HIT_STRUCTURAL],
        severity=Severity.INFO, attrs=attrs,
        structural={"rule": f.rule.value, "params": dict(f.params)},
    )
    return AssembledFinding(
        finding_id=f.finding_id, instance_id=attrs.instance_id,
        metric=f.rule.value, severity=Severity.INFO,
        hit_reasons=(pl.HIT_STRUCTURAL,), payload=payload,
        decision=gating.Decision(
            dispatch=False, reason=gating.SkipReason.PLAYBOOK,
            conclusion=conclusion),
    )


def _no_capacity_metadata_finding(
    attrs: ResourceAttrs,
    missing: Sequence[Any],
    *,
    data_date: date,
) -> AssembledFinding:
    """「拿不到规格，因此这几个指标判不了」的 INFO finding。

    🔴 存在的理由：内存与存储改成按规格百分比判定之后，分母缺失意味着那两类
    告警对这台实例**永久静默** —— 而「没有内存告警」在看板上与「内存健康」
    长得完全一样。这条 finding 把那个盲区变成一行可见的东西。

    ⚠️ **不派发 DA**，且理由是 `SkipReason.PLAYBOOK` 而不是新造一个档 ——
    它的定义就是「命中已知模式，给了确定性结论，**比 DA 更准，不是降级**」。
    这条完全符合：缺分母是一个已知模式，修复动作是确定的
    （补 `ec2:DescribeInstanceTypes` 权限）。派给 DA 只会烧额度换回
    一句「建议检查权限配置」。
    🔴 用 `dispatch=False` 而不给 conclusion 才是错的 —— 那会让报告上显示
    「这条没有 AI 分析」，一句无信息的话（`SkipReason` 的 docstring 明写
    这是要避免的）。

    ⚠️ 走 `structural` 段而不是 `threshold_config` —— 后者的契约强制
    `direction`，而「拿不到分母」没有方向。
    """
    from inspection.domain import metrics_meta as mm

    metrics = sorted({str(v.metric) for v in missing})
    keys = sorted({str(v.denominator_key) for v in missing if v.denominator_key})
    _WHAT = {
        "memory_bytes": "实例总内存（规格表）",
        "allocated_storage_bytes": "分配存储容量",
    }
    what = "、".join(_WHAT.get(k, k) for k in keys) or "规格信息"
    conclusion = (
        f"拿不到{what}，因此 {'、'.join(metrics)} 这几个按规格百分比判定的"
        f"指标本轮**没有被判定** —— 这不代表它们健康。"
        f"内存类分母来自 `ec2:DescribeInstanceTypes`"
        f"（RDS / ElastiCache 的 API 都不返回实例内存），"
        f"所以最常见的原因是巡检角色缺这个权限。"
        f"补上之后下一轮自动恢复判定，本条会自行 resolve。"
    )
    f = Finding(
        account_id=attrs.account_id, region=attrs.region, service=attrs.service,
        instance_id=attrs.instance_id,
        rule=StructuralRule.NO_CAPACITY_METADATA,
        severity=Severity.INFO,
        cadence="monthly",
        data_date=data_date,
        params={"metrics": metrics, "missing": keys},
    )
    payload = pl.build_payload(
        finding_id=f.finding_id, account_id=attrs.account_id,
        region=attrs.region, instance=attrs.instance_id, engine=attrs.engine,
        metric_family=mm.metric_family(attrs.service, attrs.engine),
        data_date=data_date, hit_reason=[pl.HIT_STRUCTURAL],
        severity=Severity.INFO, attrs=attrs,
        structural={"rule": f.rule.value, "params": dict(f.params)},
    )
    return AssembledFinding(
        finding_id=f.finding_id, instance_id=attrs.instance_id,
        metric=f.rule.value, severity=Severity.INFO,
        hit_reasons=(pl.HIT_STRUCTURAL,), payload=payload,
        decision=gating.Decision(
            dispatch=False, reason=gating.SkipReason.PLAYBOOK,
            conclusion=conclusion),
    )


def structural_findings(
    findings: Sequence[Any],
    attrs_by_id: Mapping[str, ResourceAttrs],
    *,
    data_date: date,
    locale: str = "zh",
    config_version: str = "",
    reachable: bool = True,
) -> list[AssembledFinding]:
    """`structural.Finding`（结构性 + 容量）→ `AssembledFinding`。

    ⚠️ 结构性风险**不依赖指标采集**（纯属性判定），所以这里不做评估集合过滤 ——
    采集整批失败时结构性结论依然成立，把它们也剔掉会让「证书 30 天后过期」
    这种和 CloudWatch 毫无关系的风险因为限流而消失。

    ⚠️ 容量 finding 由 `scan_capacity` 产出，和结构性同为 `Finding` 类型，
    合并走这一条路径。两者的 `hit_reason` 都是 `structural`
    （`VALID_HIT_REASONS` 只有四个值，容量没有独立档）。
    """
    from inspection.domain import metrics_meta as mm

    out: list[AssembledFinding] = []
    for f in findings:
        attrs = attrs_by_id.get(f.instance_id)
        if attrs is None:
            continue
        fam = mm.metric_family(attrs.service, attrs.engine)
        severity = Severity.coerce(f.severity)
        payload = pl.build_payload(
            finding_id=f.finding_id, account_id=f.account_id,
            region=f.region, instance=f.instance_id, engine=attrs.engine,
            metric_family=fam, data_date=f.data_date or data_date,
            hit_reason=[pl.HIT_STRUCTURAL], severity=severity,
            attrs=attrs,
            # ⚠️ 走 `structural` 段而**不是** `threshold_config` ——
            #    后者的契约强制 `direction`，而「证书 20 天后过期」没有方向。
            structural={"rule": f.rule.value, "params": dict(f.params or {})},
            config_version=config_version, locale=locale,
            resource_reachable=reachable)
        out.append(AssembledFinding(
            finding_id=f.finding_id, instance_id=f.instance_id,
            metric=f.rule.value, severity=severity,
            hit_reasons=(pl.HIT_STRUCTURAL,), payload=payload,
            decision=gating.Decision(dispatch=True)))
    return out


def idle_findings(
    ranked: Sequence[Any],
    attrs_by_id: Mapping[str, ResourceAttrs],
    *,
    bundle: Any,
    data_date: date,
    locale: str = "zh",
    config_version: str = "",
    reachable: bool = True,
) -> list[AssembledFinding]:
    """`IdleScore` → `AssembledFinding`（的闲置侧）。

    ⚠️ 只收**已判定**的（`is_judged`）。降级维度过多而算不出分的那些
    进来会带着 `value_score=None` 一路走到排序，在 dispatch 侧变成
    「分数最低所以永远排最后」—— 看起来是「不重要」，实际是「没算出来」。

    ⚠️ `estimated_monthly_savings` 为 None 时**不写 cost 段**，而不是写 0。
    写 0 会让报告说「优化后每月省 0 美元」，客户合理地据此不采纳；
    真实情况是我们没拿到价格。
    """
    from inspection.adapters import metrics_repo as mr
    from inspection.domain import metrics_meta as mm

    out: list[AssembledFinding] = []
    for s in ranked:
        if not s.is_judged:
            logger.info("闲置分未判定，跳过派发: %s", s.instance_id)
            continue
        attrs = attrs_by_id.get(s.instance_id)
        if attrs is None:
            continue
        fam = mm.metric_family(attrs.service, attrs.engine)
        finding_id = "#".join((
            s.account_id or attrs.account_id, s.region or attrs.region or "-",
            s.service, s.instance_id, pl.HIT_IDLE, "-"))
        # 闲置侧的 daily 用 CPU + 连接数两列（`daily_rows_for_lowdays` 的口径），
        # 因为 cost-idle 要拿它对 `attrs.max_connections` 这个分母算余量，
        # 并用**峰值**判断小一号规格扛不扛得住。
        daily_rows = mr.daily_rows_for_lowdays(bundle, attrs)
        cost = None
        est = s.estimated_monthly_savings
        if est is not None:
            # ⚠️ 键名由契约定死（`validate_payload` + GUARDRAILS 契约表）：
            #    `savings_estimate` / `price_precision`，不是 `precision`。
            #    写错键的表现是**校验直接抛**（好事）——
            #    但 `price_precision` 若写成空串则会通过 build 而在 validate 才炸。
            cost = {
                "monthly_cost": est.monthly_usd,
                "savings_estimate": est.monthly_usd,
                "price_precision": getattr(
                    est.precision, "value", str(est.precision)),
                "matched_key": est.matched_key,
                "as_of": est.as_of,
            }
        payload = pl.build_payload(
            finding_id=finding_id, account_id=s.account_id or attrs.account_id,
            region=s.region or attrs.region, instance=s.instance_id,
            engine=attrs.engine, metric_family=fam,
            data_date=s.data_date or data_date,
            hit_reason=[pl.HIT_IDLE], severity=Severity.INFO,
            attrs=attrs, cost=cost,
            # ⚠️ 闲置载荷**必须**带副本判定指标，否则 `validate_payload` 拦下 ——
            #    cost-idle 的第一步是判「这台是不是灾备副本」，
            #    缺了它「不是副本可以删」与「是 standby 千万别删」在载荷里长得一样。
            daily=daily_rows,
            # ⚠️ 传 `failed` 是为了让缺失原因落在正确的档上：
            #    `collection_failed`（我们没拉到）与 `no_datapoints`
            #    （拉了但为空）对 DA 是不同的结论强度。
            correlated=_correlated_section(
                bundle, attrs, fam,
                failed=s.instance_id in getattr(
                    bundle, "failed_instance_ids", frozenset())),
            config_version=config_version, locale=locale,
            resource_reachable=reachable)
        out.append(AssembledFinding(
            finding_id=finding_id, instance_id=s.instance_id,
            metric=pl.HIT_IDLE, severity=Severity.INFO,
            hit_reasons=(pl.HIT_IDLE,), payload=payload,
            decision=gating.Decision(dispatch=True),
            # 评分因子带下去 —— `to_evidence` 从这里取，落进 finding 行。
            # 不带的表现：看板上闲置条目只有一个 INFO 徽标和一个金额，
            # 「凭什么说它闲」完全看不到，而 `deterministic_conclusion` 的
            # 文案却写着「结论与降配目标见本条的评分明细」。
            score=s))
    return out


def judge_findings(
    *,
    run_type: Any,
    bundle: Any,
    attrs_by_id: Mapping[str, ResourceAttrs],
    cfg: Any,
    refdata: Any,
    data_date: date,
    today: date,
    threshold_cfg: Any = None,
    price_table: Mapping[str, Any] | None = None,
    suppressed: Mapping[tuple[str, str], str] | None = None,
    window_days: int = 7,
    locale: str = "zh",
    config_version: str = "",
    healthy_out: list[tuple[str, str]] | None = None,
    not_evaluable_out: list[str] | None = None,
    reachable: bool = True,
) -> list[AssembledFinding]:
    """按轮次类型产出 finding（的总入口）。

    ```
    RunType.HIGH  阈值 + 慢性              → high_load_findings
    RunType.IDLE  结构性 + 容量 + 闲置      → structural_findings + idle_findings
    ```

    ⚠️ **按轮次分流，不是两类都算。** R11.1 说两者是独立 run、各自派 task。
    混算会让高负载轮的 task 里混进闲置条目，而 `inspection-high-load` 的
    scope 只认 `threshold_high` / `chronic_high` —— 那些条目 DA 会跳过，
    既不判读也不报错，报告里就少了它们，且看板计数仍算它派出去了。

    ⚠️ 结构性判定**不依赖指标采集**（纯属性 + refdata 查表），
    所以采集整批失败时它照样出结论。反过来把它也按评估集合过滤，
    会让「证书 30 天后过期」这种与 CloudWatch 无关的风险因为限流而消失。
    """
    from inspection import pipeline
    from inspection.domain.schedule import RunType

    rt = run_type if isinstance(run_type, RunType) else RunType(str(run_type))

    if rt is RunType.HIGH:
        from inspection.domain.thresholds import ThresholdRuleConfig

        return high_load_findings(
            bundle, attrs_by_id,
            cfg=threshold_cfg or ThresholdRuleConfig(),
            data_date=data_date, window_days=window_days,
            suppressed=suppressed, locale=locale,
            config_version=config_version,
            # 水位已回健康区的 (实例, 指标) —— 状态机的 resolving → RESOLVED
            # 只能靠一条显式的 healthy 观测表达。见 `healthy_observations`。
            # ⚠️ 只有 HIGH 轮有这条判据：结构性是属性判定、闲置是评分，
            #    它们的「恢复」语义不同，不能共用 headroom 门槛。
            healthy_out=healthy_out,
            # 本轮判不了的实例（coverage 不足 / 全部指标 NO_DATA / 无可判指标）。
            # ⚠️ 调用方 SHALL 把它从评估集合里减掉 —— 见
            #    `InstanceVerdict.evaluable`。留在里面会让上一轮的 finding
            #    被判 resolved（昨天刚建的直接记成 prediction_missed）。
            not_evaluable_out=not_evaluable_out,
            reachable=reachable)

    attrs_list = list(attrs_by_id.values())

    # 结构性：**不按评估集合过滤** —— 纯属性 + refdata 查表，与采集成败无关。
    # 过滤会让「证书 30 天后过期」这种和 CloudWatch 毫无关系的风险因为限流而消失。
    structural = pipeline.scan_structural(attrs_list, refdata, cfg.structural, today)

    # 容量与闲置：**必须按评估集合过滤**（R6.2）。
    # ⚠️ 采集失败的实例，其 CandidateRecord 各字段全是 None ——
    #    否决规则可能恰好放它过去，`score_idle` 于是拿一堆缺失维度算出一个
    #    「降级但已判定」的分。表现是「这台库很闲，建议删」，
    #    而真相是我们这一轮压根没拿到它的指标。
    evaluated = bundle.evaluated_instance_ids(list(attrs_by_id))
    measured = [a for a in attrs_list if a.instance_id in evaluated]
    if len(measured) != len(attrs_list):
        logger.warning(
            "闲置/容量判定跳过 %d 台采集失败的实例（R6.2）: %s",
            len(attrs_list) - len(measured),
            sorted(set(attrs_by_id) - set(evaluated))[:10])

    pairs = pipeline.build_candidates(bundle, measured)
    capacity = pipeline.scan_capacity(list(pairs), cfg.capacity, data_date)
    outcomes = pipeline.score_candidates(
        pairs, bundle, cfg=cfg, data_date=data_date, price_table=price_table)
    ranked = pipeline.rank_cross_service(
        [o.score for o in outcomes if o.score is not None])

    out = structural_findings(
        [*structural, *capacity], attrs_by_id, data_date=data_date,
        locale=locale, config_version=config_version, reachable=reachable)
    out += idle_findings(
        ranked, attrs_by_id, bundle=bundle, data_date=data_date,
        locale=locale, config_version=config_version, reachable=reachable)
    logger.info(
        "闲置轮判定: 结构性 %d + 容量 %d + 闲置 %d（候选 %d，已判定 %d）",
        len(structural), len(capacity), len(ranked), len(pairs),
        sum(1 for o in outcomes if o.score is not None))
    return out


def exit_filter(
    findings: Sequence[AssembledFinding],
    exclusions: Iterable[scope.ExclusionEntry],
    *,
    today: date,
    attrs_by_id: Mapping[str, ResourceAttrs],
    list_kind: scope.ScopeList,
) -> tuple[list[AssembledFinding], list[str]]:
    """出口过滤（R1.8 的二次兜底）。

    ⚠️ **入口已经过滤过一次，这里为什么还要再来一遍。**
    入口过滤发生在拉指标之前（省钱），而排除清单可能在这两步之间被改动：
    客户在 UI 上点了排除，而本轮巡检已经跑到判定阶段。
    只有入口一道时那条 finding 照样会出现在报告里 ——
    客户会以为排除功能坏了。

    ⚠️ 复用 `scope.is_excluded` 而不是自己写判据：级联排除（集群级排除盖住
    成员）的语义只在那一处实现，重写一遍必然漂移。
    """
    # ⚠️ 直接把 entries 交给 `is_excluded` —— 它自己会建索引。
    #    `ExclusionIndex` 的构造器是按四张分表收参数的（by_instance /
    #    by_container / by_service / by_account），不接一个扁平列表。
    entries = tuple(exclusions)
    kept: list[AssembledFinding] = []
    dropped: list[str] = []
    for f in findings:
        attrs = attrs_by_id.get(f.instance_id)
        if attrs is None:
            # ⚠️ 拿不到属性时**保留**而不是剔除。剔除会让一次属性加载抖动
            #    静默吞掉真实 finding，而保留只是多报一条已被排除的。
            kept.append(f)
            continue
        ref = scope.ResourceRef(
            account_id=attrs.account_id, service=attrs.service,
            instance_id=attrs.instance_id, region=attrs.region,
            cluster_id=attrs.cluster_id or "",
        )
        decision = scope.is_excluded(ref, entries, today, list_kind)
        if decision.excluded:
            dropped.append(f.finding_id)
        else:
            kept.append(f)
    if dropped:
        logger.info("出口过滤剔掉 %d 条（排除清单在本轮中途被改动）", len(dropped))
    return kept, dropped


def rules_for_run_type(run_type: RunType) -> frozenset[str]:
    """这一轮**能产出**哪些 `finding_id` 的 `<rule>` 段。

    ## 🔴 状态机必须按它收窄 `prev`

    `store.load_findings(account_id)` 读的是**整个账号所有** finding 行，而
    `lifecycle._in_scope` 只按 finding_id 的**实例段**匹配。两轮默认都是每天
    02:00 跑、扫同一批实例，所以不收窄的话（2026-08-23 交叉 review 实测）：

    ```
    IDLE 轮不产 threshold_high → 它对高负载的行走 _step_missed
                               → 行是 new 且未确认 → 直接 RESOLVED
                                 （note: unconfirmed-new-disappeared）
    HIGH 轮反向同理            → 昨天的 gp2_volume / oversized_storage 被判 miss
    ```

    更糟的是 `apply_transitions` 的同日条件写（`last_run_date < :today`）让
    **后跑的那一轮整批写入被静默丢弃** —— 于是最终状态取决于两条 SQS 消息
    谁先被消费，不确定。

    ## 三个维度别混
    
    ```
    run_type   哪一轮**产出**它        ← 本函数
    kind       看板上归哪一**页**      bff 的 KIND_RULES
    cadence    推送用哪套**节奏**      push_policy 的 STRUCTURAL_RULES
    ```

    ⚠️ **两条盲区通知都归 HIGH 轮**（`no_capacity_metadata` /
    `unsupported_engine`）：它们由阈值判定在 `high_load_findings` 里产出
    —— 只有那里才知道「分母缺了」/「引擎的指标在别的 namespace」——
    尽管它们在看板上归结构性页、在推送上走月度。

    🔴 判据用 `structural.rules.NOT_SCANNED` 这个**单一来源**，不在这里手写。
    那个集合的定义正是「在 `StructuralRule` 里但不由 `scan_structural` 产出」，
    与「不由闲置轮产出」是同一件事。

    手写的代价已经发生过一次：这里原来只列了 `NO_CAPACITY_METADATA`，
    而 `UNSUPPORTED_ENGINE`（2026-08-31 加的第二条盲区通知）漏了，于是它
    **同时**落进两轮的规则域，两边一起坏：

    ```
    HIGH 轮  scope_prev_findings 把昨天的 unsupported_engine 滤出 prev
             → 今天的观测被当成全新 finding
             → first_seen_date / consecutive_hits **每天重置**，days_active 恒 1
    IDLE 轮  prev 里有这些行而本轮不产观测 → _step_missed
             → new 且未确认 → 直接 RESOLVED（note: unconfirmed-new-disappeared）
             → apply_transitions 顺手 REMOVE 掉 evidence 字段
    ```

    叠加 `apply_transitions` 的同日条件写，最终状态取决于两条 SQS 消息谁先被
    消费 —— 也就是本函数 docstring 开头警告的那个形态，在它自己身上重演了。
    """
    from inspection.domain.dto import CapacityRule
    from inspection.domain.structural.rules import NOT_SCANNED

    # 阈值判定产出的盲区通知（规则码在 StructuralRule 里，但产出点在 HIGH 轮）。
    blind = {r.value for r in NOT_SCANNED}

    if run_type is RunType.HIGH:
        return frozenset({"threshold_high"} | blind)
    return frozenset(
        {"idle"}
        | ({r.value for r in StructuralRule} - blind)
        | {r.value for r in CapacityRule})


def scope_prev_findings(
    prev: Mapping[str, Any], run_type: RunType,
) -> dict[str, Any]:
    """把上一轮的 finding 收窄到**本轮自己的规则域**。

    见 `rules_for_run_type` 的说明 —— 不收窄的话两轮会互相把对方的 finding
    判 resolved，且结果取决于消息消费顺序。
    """
    own = rules_for_run_type(run_type)
    return {
        fid: rec for fid, rec in prev.items()
        # finding_id 第 5 段是 rule（六段定长，R6.1）
        if (fid.split("#") + [""] * 6)[4] in own
    }


def healthy_observations(
    healthy: Sequence[tuple[str, str]],
    attrs_by_id: Mapping[str, ResourceAttrs],
    *, rule_version: str, rule: str = "threshold_high",
) -> list[Observation]:
    """`(instance_id, metric)` → `Observation(hit=False, healthy=True)`。

    `judge_high_load()` 的第二个返回值喂进来。

    ## 为什么状态机离不开它

    `lifecycle._step_missed` 的分支是 `healthy = bool(obs and obs.healthy)`；
    未命中且**没有** Observation 时它是 False → `_step_missed` 走 CHRONIC。
    所以「客户处置完了」这件事只能靠一条显式的 `healthy=True` 观测表达。

    🔴 缺了它的表现（全仓 `healthy=` 只有一处、写死 False）：客户把 gp2 换成
    gp3、扩了存储、换了规格之后，那条 finding 走 `active → resolving →
    CHRONIC`，note 是 `still-at-risk-level-for-N-days`，永久留在看板与周报里，
    每 3 天再推一次 HIGH。而 `ResolutionKind.FIXED` 一次都产不出来 ——
    R9.7 的准确率闭环只剩 `prediction_missed`，越是正常工作的部署，
    误报率看起来越高。

    ## finding_id 的六段定长（R6.1）

    ```
    account # region # service # instance # rule # metric
    ```

    ⚠️ `region` 为空时写 `-`（与 `high_load_findings` 里那段逐字一致）。
    不一致的后果是拼出来的 id 与 `prev` 里的对不上 —— 状态机收到一条永远
    匹配不到任何记录的观测，**不报错**，只是恢复检测永远不生效。

    ⚠️ `rule` 固定 `threshold_high`：结构性风险与闲置不走 headroom 这条判据
    （前者是属性判定、后者是评分），它们的恢复语义不同，不能共用这条路。
    """
    out: list[Observation] = []
    for iid, metric in healthy:
        a = attrs_by_id.get(iid)
        if a is None:
            continue
        fid = "#".join((a.account_id, a.region or "-", a.service,
                        iid, rule, metric))
        out.append(Observation(finding_id=fid, hit=False, healthy=True,
                               rule_version=rule_version))
    return out


def to_observations(findings: Sequence[AssembledFinding],
                    *, rule_version: str) -> list[Observation]:
    """`AssembledFinding` → 状态机的观测。

    ⚠️ `healthy` 与 `hit` 不是互补的：一台实例本轮**被评估过且没命中**
    才是 `healthy`；采集失败的那些既不 hit 也不 healthy ——
    它们不该进评估集合，否则 active finding 会被误判 resolved（R6.2）。
    这里只处理命中的，未命中的由调用方按 `evaluated` 集合给出。
    """
    return [
        Observation(finding_id=f.finding_id, hit=True, severity=f.severity,
                    healthy=False, rule_version=rule_version)
        for f in findings
    ]


# 落库的证据字段。**白名单**而不是「把 judgment 整段塞进去」——
# finding 行是被整表 Query 的（一个账号可能几千条），每条多 1KB 就是几 MB 响应。
_EVIDENCE_NUMERIC = ("value", "threshold", "headroom",
                     "raw_value", "denominator")


def _unit_of_metric(metric: str) -> str:
    """指标名 → 它的物理单位（`%` / `B` / `s` / `d` / 空）。

    🔴 **必须由后端给。** 前端拿到的只有指标名，没有单位，于是要么显示裸数值
    （`524288000` 而不是 `500 MB`、`0.05` 而不是 `50 ms`），要么自己写一份
    「哪个指标是什么单位」的映射 —— 后者与后端分叉的表现是**单位标错**，
    比不显示更糟。

    链路是现成的两张表接起来，不新增第三份真源：

    ```
    metric → 阈值字段名     thresholds._THRESHOLD_BY_METRIC_FIELD
    阈值字段名 → unit        rule_limits.find("threshold", key)["unit"]
    ```

    ⚠️ 只给**物理单位**，不给显示单位（MB / GB / ms）。`1 GB = 1024 MB`
    这种换算前端做不会分叉，而「哪个字段该用 MB 起步」是业务判断，
    那个在配置页走 `rule_limits.DISPLAY_UNITS`。
    """
    from inspection.domain import rule_limits as rl
    from inspection.domain import thresholds as th

    field = th._THRESHOLD_BY_METRIC_FIELD.get(str(metric or ""))
    if not field:
        return ""
    spec = rl.find("threshold", field)
    return str((spec or {}).get("unit") or "")


def _as_float(v: Any) -> float | None:
    """任何实数 → float。**`Decimal` 也接**。不是数就返回 None。

    ## 🔴 为什么不能用 `isinstance(v, (int, float))`

    那个判据把 **`Decimal` 判成「不是数」**：

    ```
    isinstance(Decimal("87.3"), float) → False
    isinstance(Decimal("87.3"), int)   → False
    ```

    而巡检链路里到处是 Decimal —— DynamoDB 不存 float（`to_ddb_number` 把
    float 转成 Decimal 落库），所以任何「写进 series 表再读回来参与计算」
    的数值，算出来的结果都是 Decimal。

    2026-08-25 实测的后果：`_idle_evidence` 拿到 `idle_score=Decimal("87.3")`
    → 守卫判它不是数 → **返回空 dict** → 12 条闲置 finding 的评分因子
    一条都没落库。而 `savings_usd` 落上了（那个来自当场构造的 payload，
    是真 float），于是现象是「一半证据有一半没有」，非常难定位。

    ⚠️ `bool` 要显式排除：`isinstance(True, int)` 是 True，
    `float(True)` 是 1.0 —— 一个布尔标志会被当成数值 1 落进证据里。
    """
    if v is None or isinstance(v, bool):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def to_evidence(findings: Sequence[AssembledFinding]) -> dict[str, dict[str, Any]]:
    """`AssembledFinding` → 落进 finding 行的**判定证据**（R9.1）。

    ## 为什么需要它

    判定算出来的数字此前只走一条路：`payload` → S3 → DA。状态机那侧的
    `Observation` 只带 `finding_id / hit / severity / healthy`，于是
    `_finding_to_item` 写出来的行**没有任何数值**。表现是看板卡片上
    「CPU 使用率 高负载 CRITICAL」—— 客户看不到到底是 85% 还是 71%，
    也看不到阈值是多少，只能去点 DA 判读全文（而那要 1~3 分钟才回来）。

    R9.1 明写「所有数字 SHALL 由巡检 Lambda 确定性计算」，读侧不许补算。
    所以补的是**写侧**：把已经算好的那几个数一起落库。

    ## 刻意不做的事

    ```
    不重算              全部从 f.payload 里取，那里是判定层的输出
    不补 None           取不到就不写这个键（与 Judgment.as_dict() 同约定）——
                        「这条规则不产出 headroom」与「headroom 是 null」不同
    不写 0 当兜底        「估不出金额」与「省 $0」是两件事
    不整段塞 judgment    白名单三个数值 + 方向 + 金额，控制行大小
    ```

    ⚠️ 结构性风险是**属性判定**（零指标），没有 value/threshold ——
    它的 evidence 只有 `{}` 或只有金额。调用方与 UI 都要容忍缺键。
    """
    out: dict[str, dict[str, Any]] = {}
    for f in findings:
        ev: dict[str, Any] = {}
        j = f.payload.get("judgment") or {}
        if isinstance(j, Mapping):
            for k in _EVIDENCE_NUMERIC:
                # ⚠️ 走 `_as_float` 而不是 `isinstance(v, (int, float))` ——
                #    后者把 Decimal 判成「不是数」而静默丢掉（见 `_as_float`）。
                #    这一段当前拿到的都是真 float（payload 是当场构造的），
                #    但判据不该依赖那个巧合。
                fv = _as_float(j.get(k))
                if fv is not None:
                    ev[k] = fv
        # 比较方向。🔴 必须来自 `threshold_config`（唯一真源是 `metrics_meta`）——
        # UI 上「高于阈值 / 低于阈值」由它决定。前端按指标名猜方向的话，
        # FreeableMemory 这类「越小越坏」的会被写成「高于阈值 500MB」，正好反了。
        tc = f.payload.get("threshold_config") or {}
        if isinstance(tc, Mapping):
            d = str(tc.get("direction") or "").strip()
            if d:
                ev["direction"] = d
        # 单位。只在有数值可显示时才带 —— 一个没有 value 的行带着 unit
        # 只会让读侧多一次判空。
        if "value" in ev or "threshold" in ev:
            metric = str(
                (j.get("metric") if isinstance(j, Mapping) else "") or f.metric or "")
            u = _unit_of_metric(metric)
            if u:
                ev["unit"] = u
        # 金额。⚠️ 精度档必须与数字**一起**落 —— 只给数字不给档位，
        # 客户会拿 `coarse_default` 的兜底常数去做预算。
        cost = f.payload.get("cost") or {}
        if isinstance(cost, Mapping):
            sv = _as_float(cost.get("savings_estimate"))
            if sv is not None:
                ev["savings_usd"] = sv
            p = str(cost.get("price_precision") or "").strip()
            if p:
                ev["savings_precision"] = p
        # 形态哈希（R5.12 结论复用的判据）。
        #
        # 🔴 **必须落库**，因为下一轮重建不出来：`shape_hash` 要的是完整的
        #    `hit_reasons` 集合，而 finding 行里只有单个 `rule` 段
        #    —— `chronic_high` 是附属标记，行里完全看不到。
        #    不落的表现是复用永远命中不了（拿不到 prior.shape 去比对），
        #    于是每天为同一个形态重新买一次 LLM 判读。
        #
        # ⚠️ 只有**命中**的 finding 有 evidence，所以未命中时 `shape` 会被
        #    `apply_transitions` 一起 REMOVE —— 那正是想要的：水位已经回到
        #    健康区，下一轮再出现时应当重新判读，不该沿用上次的结论。
        #
        # 🔴 放在 `if ev` **里面**：结构性风险是属性判定（零指标），它的
        #    evidence 本该是空的（见本函数 docstring）。在外面加会让每条
        #    `gp2_volume` 都凭空多出一行 evidence —— 而它们压根不派发 DA
        #    （闲置轮走 `SkipReason.DETERMINISTIC`），shape 对它们毫无用处。
        # 闲置评分因子。**闲置条目「凭什么」的全部内容就在这里。**
        #
        # 高负载有「实测值 vs 阈值」一行就说清了；闲置没有单一阈值 ——
        # 它是四个（RDS）或三个（ElastiCache）维度加权出来的分。不落这些，
        # 看板上就只剩一个 INFO 徽标和一个金额，客户合理地问「凭什么」。
        #
        # ⚠️ 只落**可用**维度的明细，不可用的只留名字（`idle_degraded`）。
        #    不可用维度的 `points` 恒 0、`normalized_value` 恒 None，
        #    混在一张表里渲染出来是四行里两行空白 —— 那不是「明细」，
        #    是让客户以为这两维得了 0 分（而实际是没数据，权重已重分给别人）。
        ev.update(_idle_evidence(f.score))
        # 规格。**闲置条目最重要的一个字段之一，而它此前一直没落库。**
        #
        # 🔴 「db.t4g.micro 闲置」与「db.r8g.4xlarge 闲置」的处置价值差两个
        #    数量级，而看板上两者长得一模一样（同一个 INFO 徽标 + 一个金额）。
        #    客户提的原话是「客户想要的是 xxx 实例，什么规格，什么 region 的，
        #    评分是多少分」—— region 和评分都有了，规格是唯一缺的那个。
        #
        # ⚠️ 从 `payload["attrs"]` 取而不是重新读 `ResourceAttrs`：`to_evidence`
        #    的约定是「不重算，全部从 f.payload 里取」（见本函数 docstring），
        #    而 `payload.attrs_section` 已经把它放进去了。加一个 attrs_by_id
        #    参数会让这个纯函数多一个可以传错的入口。
        #
        # ⚠️ 不写空串。Serverless v2 的 `instance_class` 是 `db.serverless`
        #    （有值），而拿不到属性时是空串 —— 后者写进去会让卡片上多一个
        #    空的规格位，比不显示更糟。
        at = f.payload.get("attrs") or {}
        if isinstance(at, Mapping):
            ic = str(at.get("instance_class") or "").strip()
            if ic:
                ev["instance_class"] = ic
        # 🔴 **确定性结论 + 跳过原因**（2026-08-31 实机暴露）。
        #
        #    `gating.decide()` 对闲置轮返回
        #    `Decision(dispatch=False, reason=DETERMINISTIC, conclusion=<文本>)`
        #    —— 闲置判定是纯计算的，**它有结论**、不需要 AI。
        #    但那个文本此前**从不落库**。
        #
        #    后果（实机 16 条全中）：看板卡片显示「判读缺失」，详情抽屉的
        #    「AI 判读」那块显示红色的「读取失败: not_found」—— 因为前端按
        #    `da_task_id` 去查 `invst#` 行，而闲置轮从没派过。
        #    也就是说**功能完全正常，但看起来全坏了**。
        #
        # ⚠️ `gating.Decision.has_conclusion` 的 docstring 自己写着：
        #    「`dispatch=False` 且没有结论 = 报告上是空的。
        #      **只有 BUDGET / QUOTA 是那种情况**」——
        #    代码此前做成了它自己反对的样子。
        #
        # ⚠️ 走 evidence 通道而不是新加参数：`apply_transitions(evidence=…)`
        #    已经是写侧的既有接口，`_finding_to_item` 会把它合并进行里。
        #
        # ⚠️ 只在**有结论**时才写。没有结论的 `dispatch=False`（BUDGET / QUOTA）
        #    要让读侧看到「缺」—— 那两种是真的没答案，必须与「不需要」区分开。
        #
        # 🔴 **加在下面那个 `if ev:` 之前**，因为它要参与那个判断：
        #    闲置与结构性 finding 是零指标的（没有 value/threshold），若结论不算
        #    进 `ev`，那条会因「一个数都没有」被整条丢出 evidence 表。
        #    ⚠️ 但**不能**把 `out[...] = ev` 挪到 `if ev` 外面 —— 那样真正一无所有
        #      的 finding 会以空 dict 进表，
        #      `test_evidence_omits_missing_keys_rather_than_writing_zero` 会红
        #      （我第一版就是这么错的，实测确认）。
        if f.decision.has_conclusion:
            ev["conclusion"] = f.decision.conclusion
        # 跳过原因**独立落**：读侧靠它区分「不需要判读」（DETERMINISTIC /
        # PLAYBOOK / REUSED / ROLLUP_MEMBER）与「本该判读但没判」（BUDGET / QUOTA）。
        # 只看 conclusion 有无区分不出后者那两种。
        if f.decision.reason is not None:
            ev["skip_reason"] = f.decision.reason.value

        if ev:
            ev["shape"] = gating.shape_hash(f.hit_reasons, f.severity)
            out[f.finding_id] = ev
    return out


def _idle_evidence(score: Any) -> dict[str, Any]:
    """`IdleScore` → 落库的评分因子。非闲置 finding 传 None，返回空。

    ## 落库形状（键名短是刻意的 —— 每条 finding 一行，四维就是四个 map）

    ```
    idle_score        87.3        总分 0~100，越大越闲
    idle_weight_avail 1.0         可用维度的原始权重之和；< 0.5 时压根不判定
    idle_degraded     ["iops"]    因缺数据被丢弃、权重已重分给别人的维度
    idle_factors      [ {n,w,v,p,b,m}, … ]   只含可用维度
                      n 维度名（cpu/connections/storage/iops/memory/requests）
                      w 重归一化**后**实际生效的权重
                      v 归一化值 0~1，越大越闲
                      p 本维贡献的分数
                      b BasisCode —— 归一化的依据（分母从哪来）
                      m 实测值（`basis_params["value"]`，有些维度没有）
    ```

    🔴 `w` 用生效权重不是原始权重。IOPS 缺数据时 CPU 的 0.40 会被重分到
    0.44，而报告里若显示 0.40，四维之和不等于 1，客户会以为我们算错了。
    `raw_weight` 不落 —— 需要追溯原始配置的话去看 `idle_degraded` 与
    阈值配置页，那是配置而不是本轮观测。

    ⚠️ `idle_score is None`（判据不足未判定）时**什么都不落**。落一个
    `idle_factors` 而没有总分，UI 上会渲染出一张「有明细没结论」的表。
    这种 finding 本来就在 `idle_findings` 里被 `is_judged` 拦掉了，
    这里是第二道。
    """
    if score is None:
        return {}
    total = _as_float(getattr(score, "idle_score", None))
    if total is None:
        return {}
    # ⚠️ 逐键 `out[...] = ` 而不是字典字面量 `{"idle_score": …}`。
    #    `test_evidence_field_list_covers_what_to_evidence_produces` 靠扫
    #    `out["…"]` 找本函数产出的字段名，字面量它看不见 —— 于是那条
    #    「漏一个键就会让看板挂着上一轮数字」的保护会静默失效。
    out: dict[str, Any] = {}
    out["idle_score"] = total
    aw = _as_float(getattr(score, "available_weight", None))
    if aw is not None:
        out["idle_weight_avail"] = aw
    degraded = tuple(getattr(score, "degraded_dimensions", ()) or ())
    if degraded:
        out["idle_degraded"] = [str(d) for d in degraded]
    factors: list[dict[str, Any]] = []
    for d in getattr(score, "dimensions", ()) or ():
        if not getattr(d, "available", False):
            continue
        rec: dict[str, Any] = {
            "n": str(getattr(d, "name", "") or ""),
            "w": _as_float(getattr(d, "weight", None)) or 0.0,
            "v": _as_float(getattr(d, "normalized_value", None)) or 0.0,
            "p": _as_float(getattr(d, "points", None)) or 0.0,
        }
        code = getattr(d, "basis_code", None)
        if code is not None:
            rec["b"] = getattr(code, "value", str(code))
        # 实测值。⚠️ 只取 `value` 一个键 —— `basis_params` 还带
        # `metrics`（缺失指标名的列表）之类的诊断字段，整段落库会让
        # 不可用维度的诊断信息混进可用维度的展示数据里。
        mv = _as_float((getattr(d, "basis_params", None) or {}).get("value"))
        if mv is not None:
            rec["m"] = mv
        factors.append(rec)
    if factors:
        out["idle_factors"] = factors
    return out


def _excursion(f: AssembledFinding) -> float:
    """越线幅度（**带符号**）—— rollup 的 `magnitude` 与 `direction` 都由它定。

    ```
    (实测值 - 阈值) / |阈值|
      bad_up 越线    value > threshold  → 正 → Direction.UP
      bad_down 越线  value < threshold  → 负 → Direction.DOWN
    ```

    ## 为什么用这个定义

    符号天然给出方向，不用再查一遍 `metrics_meta`（少一个可以对不上的来源）；
    绝对值是「超出多少倍阈值」，在同一指标的成员之间可比 —— 那正是
    `MAGNITUDE_TOLERANCE` 要比的东西（「同幅」）。

    ⚠️ 拿不到 value / threshold，或阈值为 0 → 返回 0.0。
       0.0 会让方向落到 UP、幅度落到 0，也就是**退回原来的行为** ——
       但那时 `ratio` 那道闸门已经用真实分母了，不会再无条件成立。
       慢性单独命中的 finding 现在有 value/threshold（见 `chronic_worst`），
       所以这条兜底实际很少走到。
    """
    j = f.payload.get("judgment")
    if not isinstance(j, Mapping):
        return 0.0
    v = _as_float(j.get("value"))
    t = _as_float(j.get("threshold"))
    if v is None or t is None or not t:
        return 0.0
    return (v - t) / abs(t)


def rollup_candidates(
    findings: Sequence[AssembledFinding],
    *,
    attrs_by_id: Mapping[str, ResourceAttrs],
    magnitudes: Mapping[str, float] | None = None,
    cluster_sizes: Mapping[str, int] | None = None,
) -> tuple[list[AssembledFinding], tuple[rl.RollupGroup, ...]]:
    """群体 rollup（R8.6）。

    ⚠️ 返回的是「rollup 之后剩下的个体 finding」+「集群层组」。
    rollup 是**合并表达**不是过滤 —— 没达到 60% 的成员仍按个体上报。

    ## 🔴 两条护栏，都是 2026-08-23 交叉 review 找到的实测缺陷

    ### ① 只有**指标类**的 finding 参与 rollup

    rollup 的判据是「同一集群里多数成员在同一指标上**同向同幅**」。而结构性
    与容量类 finding（`gp2_volume` / `no_capacity_metadata` / …）没有方向也
    没有幅度 —— 它们的 `magnitude` 恒 0、`direction` 恒 UP，于是
    `_consistent_subset` 全部通过：「≥60% 成员缺规格」就够触发一次 rollup。

    而缺 `ec2:DescribeInstanceTypes` 权限是**全账号一致**的，也就是所有
    多节点集群会同时中招。

    ### ② 过滤键是 `(instance_id, metric)` 而不是 `instance_id`

    实测（5 节点集群，5 台都缺规格，其中 n3 另有一条 CRITICAL 的
    `threshold_high#CPUUtilization`）：

    ```
    盲区 finding 不存在时   kept = [(n3, CPUUtilization, CRITICAL)]   groups=0
    加上 5 条盲区 finding   kept = []                                 groups=1
    ```

    那条 CRITICAL 没进 `to_observations` → `reconcile` 判它「被评估到但没
    观察到」→ resolving → **resolved**。也就是「加一条 INFO 盲区通知，代价是
    同集群的 CRITICAL 从看板上消失」。
    """
    # ① 只有指标类且非 INFO 的才参与。INFO 里没有「趋势」这个概念。
    def _eligible(f: AssembledFinding) -> bool:
        return (bool(f.metric) and f.severity is not Severity.INFO
                and not f.is_rollup and not f.rollup_covered_by)

    eligible = [f for f in findings if _eligible(f)]
    if not eligible:
        return list(findings), ()

    obs: list[rl.MemberObservation] = []
    for f in eligible:
        a = attrs_by_id.get(f.instance_id)
        cid = (a.cluster_id or "") if a else ""
        # 🔴 幅度**自己算**，不依赖调用方传。
        #
        #    `magnitudes` 这个参数生产调用点（`handler._assemble_and_dispatch`）
        #    **从来没传** → 全部 0.0 → 两件事同时失效：
        #
        #    ```
        #    direction = UP if mag >= 0   恒 UP
        #                                 FreeableMemory（bad_down）也标成「在涨」
        #    _consistent_subset           med = min = max = 0
        #                                 `0 <= 0 <= 0` 全通过
        #                                 → MAGNITUDE_TOLERANCE 成死配置
        #    ```
        #
        #    而所有 rollup 测试都**显式传** `magnitudes`，所以这条路从来没被测到。
        #    参数保留是为了让测试能注入特定幅度，但默认从 payload 推 ——
        #    一个「忘了传就静默失效」的参数不该是唯一来源。
        mag = (magnitudes or {}).get(f.finding_id)
        if mag is None:
            mag = _excursion(f)
        obs.append(rl.MemberObservation(
            instance_id=f.instance_id, cluster_id=cid, metric=f.metric,
            direction=rl.Direction.UP if mag >= 0 else rl.Direction.DOWN,
            magnitude=abs(mag), severity=f.severity.value))
    # 本轮**已评估**的成员数（按集群）—— `ratio` 的分母。
    # ⚠️ 用 `attrs_by_id`（= 评估集合）而不是 `findings`（= 命中集合）。
    #    传后者的话分母恒等于命中数，`ROLLUP_RATIO=0.60` 无条件成立。
    evaluated_sizes: dict[str, int] = {}
    for a in attrs_by_id.values():
        cid = a.cluster_id or ""
        if cid:
            evaluated_sizes[cid] = evaluated_sizes.get(cid, 0) + 1
    res = rl.rollup(obs, cluster_sizes=cluster_sizes,
                    evaluated_sizes=evaluated_sizes)

    # ② 精确到 (实例, 指标)。`RollupGroup` 自带 `metric` 与 `members`，
    #    所以不需要从 `rolled_up_ids` 那个只有实例 id 的集合去推。
    #
    # 🔴 **不删 finding，只打标。** 见 `AssembledFinding.rollup_covered_by`
    #    的说明 —— 删掉会让整个集群的风险从看板上消失，并让 heartbeat 发出
    #    「本轮无风险」。
    by_pair = {(f.instance_id, f.metric): f for f in findings}
    out = list(findings)
    idx = {id(f): i for i, f in enumerate(out)}
    for g in res.groups:
        members = [by_pair[(m, g.metric)] for m in g.members
                   if (m, g.metric) in by_pair]
        if not members:
            continue
        # 代表 = 最严重的那台；同 severity 时按 instance_id 决胜（确定性，
        # 否则同一份输入两次跑出的代表不同，报告里「覆盖 N 台」指向会漂）。
        rep = min(members, key=lambda f: (f.severity.order, f.instance_id))
        out[idx[id(rep)]] = replace(
            rep, is_rollup=True, member_count=len(members))
        for m in members:
            if m is rep:
                continue
            out[idx[id(m)]] = replace(m, rollup_covered_by=rep.finding_id)
    return out, res.groups


def apply_gates(
    findings: Sequence[AssembledFinding],
    *,
    run_type: RunType,
    today: date,
    tier: Tier,
    priors: Mapping[str, gating.PriorConclusion] | None = None,
    attrs_by_id: Mapping[str, ResourceAttrs] | None = None,
    da_enabled: bool = True,
) -> tuple[list[AssembledFinding], dict[str, int]]:
    """派发闸门（R5.11 / R5.12 / R12.2 / R11c.1）。

    返回「决定要派发的」+「各闸门拦下的计数」。

    ⚠️ 被闸门拦下的 finding **不丢**：它们的 `decision` 里带着
    `conclusion`（playbook / 复用）或 `reason`（额度 / 配额 / kill switch），
    报告要能解释「为什么这条没有 AI 分析」。

    `da_enabled=False`（kill switch 拉停）时全部落 `SkipReason.KILL_SWITCH`，
    于是 `build_tasks` 自然不产出任何 task（它只看 `decision.dispatch`），
    计数也自动进 run 记录的 `skipped_by_gate`。
    ⚠️ 这是**刻意复用现有表达**而不是在 handler 里加一条 `if`：加 if 会让
    「本轮没派发」在 run 记录上看不出原因 —— 而那正是 `skipped_by_gate`
    这个字段存在的意义。
    """
    counts: dict[str, int] = {}
    out: list[AssembledFinding] = []
    for f in findings:
        # 🔴 **已经带确定性结论的 finding 原样保留。**
        #
        # `gating.decide` 对每条 finding 无条件重算，于是任何在组装阶段就
        # 给出了结论的 finding 都会被它覆盖。实测（交叉 review）：
        #
        # ```
        # no_capacity_metadata（INFO + PLAYBOOK + 完整的修复说明）
        #   → tier.allows(INFO) 为假（RELAXED 最低也只到 MEDIUM）
        #   → SkipReason.BUDGET，conclusion **空**
        #   → 看板/报告显示「因额度未分析」+ 一片空白
        # ```
        #
        # 而 `_no_capacity_metadata_finding` 的 docstring 里正明写着
        # 「用 `dispatch=False` 而不给 conclusion 才是错的」—— 代码做成了
        # 它自己反对的样子。附带还污染 `skipped_by_gate["budget"]`：
        # 额度统计把这些结构性盲区算成了额度不足。
        #
        # ⚠️ 判据是「**已有 conclusion**」而不是「是不是某个特定规则」——
        # 将来任何自带确定性结论的 finding 都自动受保护。
        if not f.decision.dispatch and f.decision.has_conclusion:
            out.append(f)
            if f.decision.reason is not None:
                key = f.decision.reason.value
                counts[key] = counts.get(key, 0) + 1
            continue

        # 🔴 被集群级结论覆盖的成员：不派发，但**保留在列表里**。
        #
        # rollup 的成本收益（一个集群同一指标只买一次判读）落在这里，而不是
        # 靠把成员 finding 删掉 —— 删掉会让整个集群的风险从看板消失，还会让
        # `heartbeat_if_empty` 发出「本轮无风险」。见
        # `AssembledFinding.rollup_covered_by` 的实测记录。
        #
        # ⚠️ 必须给 `conclusion`。`dispatch=False` 且没有结论的 finding 在报告
        #    上是空白（见 `Decision.has_conclusion`），而这一条明确有答案 ——
        #    答案在代表那条上。
        if f.rollup_covered_by:
            out.append(replace(f, decision=gating.Decision(
                dispatch=False, reason=gating.SkipReason.ROLLUP_MEMBER,
                conclusion=("同集群同指标已有集群级结论覆盖："
                            f"{f.rollup_covered_by}"))))
            key = gating.SkipReason.ROLLUP_MEMBER.value
            counts[key] = counts.get(key, 0) + 1
            continue

        a = (attrs_by_id or {}).get(f.instance_id)
        d = gating.decide(
            metric=f.metric,
            service=(a.service if a else ""),
            reasons=f.hit_reasons,
            severity=f.severity,
            today=today,
            tier=tier,
            # 🔴 闲置轮设计上不派发 DA（`gating.DETERMINISTIC_RUN_TYPES`）。
            #    `.value` 而不是直接传枚举 —— gating 层刻意只认字符串，
            #    不 import `schedule.RunType`。
            run_type=run_type.value,
            prior=(priors or {}).get(f.finding_id),
            context=dict(f.payload.get("judgment") or {}),
            da_enabled=da_enabled,
        )
        # 🔴 **用 `replace` 而不是逐字段重建。**
        #
        # 这里原本是 `AssembledFinding(finding_id=…, instance_id=…, …)` 八个
        # 字段照抄。加一个字段就必然漏一次 —— 2026-08-25 就漏了 `score`
        # （闲置评分因子），后果是：
        #
        # ```
        # idle_findings 里 score=s 设上了
        #   → apply_gates 重建时丢掉
        #   → to_evidence 读 f.score 拿到 None
        #   → 12 条闲置 finding 一条评分因子都没落库
        # ```
        #
        # 而单测全绿：没有一条断言检查 score 能穿过这一层。真实巡检跑完
        # 去查库才发现（`❌ 没有 idle_score` × 12）。
        #
        # `replace` 只改 `decision`，其余字段自动带上 —— 以后加字段不用改这里。
        out.append(replace(f, decision=d))
        if d.reason is not None:
            counts[d.reason.value] = counts.get(d.reason.value, 0) + 1
    return out, counts


def build_tasks(
    findings: Sequence[AssembledFinding],
    *,
    run_type: RunType,
    account_id: str,
    data_date: date,
    run_id: str,
    agent_space_id: str,
    tier: Tier,
    base_top_n: int | None = None,
) -> tuple[DispatchPlan, list[tb.TaskRequest]]:
    """排序 → 配额 → 装箱 → task（R12.6 / 7.3 / 7.4）。

    ⚠️ 只处理 `decision.dispatch` 为真的那些。被闸门拦下的不进这一步 ——
    它们已经有结论（playbook / 复用）或已有明确的不派原因（额度 / 配额）。
    """
    to_dispatch = [f for f in findings if f.decision.dispatch]
    if not to_dispatch:
        return DispatchPlan(dispatch=(), deferred=()), []

    cands = [
        Candidate(
            account_id=account_id, instance_id=f.instance_id, metric=f.metric,
            severity=f.severity,
            headroom=(f.payload.get("judgment") or {}).get("headroom"),
            is_rollup=f.is_rollup, member_count=f.member_count,
        )
        for f in to_dispatch
    ]
    kw: dict[str, Any] = {"tier": tier}
    if base_top_n is not None:
        kw["base_top_n"] = base_top_n
    plan = plan_dispatch(cands, **kw)

    by_key = {(f.instance_id, f.metric): f for f in to_dispatch}
    payloads = [by_key[(c.instance_id, c.metric)].payload
                for c in plan.dispatch
                if (c.instance_id, c.metric) in by_key]

    tasks: list[tb.TaskRequest] = []
    for i, batch in enumerate(pl.pack_payloads(payloads)):
        tasks.append(tb.build_task(
            run_type=run_type, account_id=account_id, data_date=data_date,
            run_id=run_id, agent_space_id=agent_space_id,
            payloads=batch, batch_id=f"{run_id}-{i}"))
    return plan, tasks


def heartbeat_if_empty(
    findings: Sequence[AssembledFinding],
    *,
    run_type: RunType,
    account_id: str,
    data_date: date,
    run_id: str,
    agent_space_id: str,
    evaluated: int,
    completeness: float,
    closest: Sequence[Mapping[str, Any]] = (),
) -> tb.TaskRequest | None:
    """零命中时派 heartbeat（R11.2）。

    ⚠️ 判据是「一条 finding 都没有」，**不是「一条 task 都没派」**。
    后者会让「有 finding 但全被 playbook 接住」也派 heartbeat ——
    而那时报告里是有结论的，heartbeat 会自相矛盾。
    """
    if findings:
        return None
    return tb.build_heartbeat_task(
        run_type=run_type, account_id=account_id, data_date=data_date,
        run_id=run_id, agent_space_id=agent_space_id,
        evaluated=evaluated, completeness=completeness, closest=closest)
