"""DA 载荷构造与校验（R5.3）。

载荷是**我们与 DevOps Agent 之间唯一的数据契约**。它直传 `CreateBacklogTask` 的
`description`（不落 S3 —— 实测单 finding 1227~1623 字符，上限 10000）。

两份判读 skill 的 Input contract 表逐字依赖这里的字段名
（`inspection/skills/_shared/GUARDRAILS.md`）。少一个字段，skill 里对应的那条约束
就静默失效 —— 报告照样生成，只是不再受约束。所以：

    build_payload()     构造，字段名与设计的载荷块一一对应
    validate_payload()  校验，把「少字段」「cost 出现在不该出现的地方」变成会失败的断言
    payload_chars()     装箱依据（7.3 按字符数打包，不按条数）

⚠️ 本模块 SHALL NOT 做 IO（R14.1）。价格、属性、指标都由上层读好后传进来。
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from inspection.domain.dto import (
    PriceEstimate,
    ResourceAttrs,
    Severity,
    Unavailable,
    resolve_role,
)

# 契约版本。⚠️ 不兼容变更必须升 major —— 两份 skill 都被要求「major 版本认不出就什么都别判」，
# 那条约束只有在我们真的升版本时才有意义。
SCHEMA_VERSION = "1.0"

# skill 激活的唯一确定信号。DA 对 investigation 的 skill 激活是**按 description 模型匹配**
# （官方：load automatically when relevant），不是显式挂载。两份 skill 的 description 都写
# 「当 task description 含该 marker 时使用」，把模糊语义匹配换成唯一字符串匹配。
# scripts/sync_inspection_skills.py 断言两份 description 必含它。
MARKER = "NOTIOPS_INSPECTION"

# `CreateBacklogTask.description` 的 API 硬上限。超限抛 ContentSizeExceededException (413)。
DESCRIPTION_LIMIT = 10_000
# 装箱目标：留 15% 安全边际。⚠️ 早期 spec 写过「≤2000 字符」，那个自设余量没有依据，
# 而且它会把装箱从 6 条压到 1~2 条。上限就是 API 的 10000。
PACKING_TARGET = 8_500

# `operator_note` 的字符上限。
#
# 🔴 它是**唯一**由用户自由输入、进到载荷里的字段，所以必须有硬上限：
#    单条 finding 的载荷实测 1227~3700 字符，而 `DESCRIPTION_LIMIT` 是 10000。
#    一个不设限的备注能单独把描述顶穿 → `ContentSizeExceededException` (413)
#    → 那次派发失败。而失败点在 API 调用处，错误信息里只有「内容超限」，
#    不会指出是备注太长 —— 客户看到的是「深入分析点了没反应」。
#
# ⚠️ 1000 而不是更大：装箱路径上一个 task 最多 6 条 finding，
#    每条都带 1000 字符的备注就是 6000，加上载荷本身必然超。
#    手动派发是单条（用不到装箱），但这个常量是**共用**的 ——
#    按最坏路径定上限，而不是按当前唯一调用方。
OPERATOR_NOTE_LIMIT = 1_000

# 四类命中原因（的 hit_reason 表）。
HIT_THRESHOLD_HIGH = "threshold_high"
HIT_CHRONIC_HIGH = "chronic_high"
HIT_IDLE = "idle"
HIT_STRUCTURAL = "structural"
VALID_HIT_REASONS = frozenset({
    HIT_THRESHOLD_HIGH, HIT_CHRONIC_HIGH, HIT_IDLE, HIT_STRUCTURAL,
})

# `cost` 只在这两类上出现 —— 它是 inspection-cost-idle skill 的输入，
# 高负载判读不需要金额（给了反而诱导 DA 在可靠性结论里谈钱）。
COST_BEARING_HIT_REASONS = frozenset({HIT_IDLE, HIT_STRUCTURAL})

# 严重度四档（R7.2a）。取值定义在 `dto.Severity` —— **全仓唯一一份**。
# ⚠️ 这里曾经另写一份大写字符串集合，而 `Finding.severity` 默认小写 `"info"`，
#    于是把 Finding 直接喂进 `build_payload()` 必抛 PayloadContractError。
#    两处各存一份取值的代价就是这个：类型对得上、值对不上，且只在运行时才发现。
# ⚠️ 与 DA `Recommendation.priority`（只有 HIGH/MEDIUM/LOW）**不是同一套** ——
#    那边表达不了 CRITICAL，这也是 R9.1 禁止依赖 DA 侧分级的原因之一。
VALID_SEVERITIES = frozenset(m.value for m in Severity)

# 方向。bad_down 指标（FreeableMemory / FreeStorageSpace / 命中率）跌才是坏。
DIR_BAD_UP = "bad_up"
DIR_BAD_DOWN = "bad_down"
VALID_DIRECTIONS = frozenset({DIR_BAD_UP, DIR_BAD_DOWN})

# 缺失声明的固定标记。
STATUS_UNAVAILABLE = "unavailable"

# 副本判定指标。**cost-idle 第 1 步的判据全靠它们**，见 `dto.Unavailable` 的说明。
# 名字取自 metrics_meta.py（那里的注释已逐条对过官方语义）：
#   ReplicaLag               普通 RDS 只读副本；-1 = 复制未激活（另一条更严重的发现）
#   AuroraReplicaLag         只有 reader 有 → 存在即证明角色
#   AuroraReplicaLagMaximum  只有 writer 有
#   ReplicationLag           ElastiCache 副本节点；Memcached 无
REPLICA_SIGNAL_METRICS = frozenset({
    "ReplicaLag", "AuroraReplicaLag", "AuroraReplicaLagMaximum", "ReplicationLag",
})


class PayloadContractError(ValueError):
    """载荷不满足契约。**故意用异常而不是返回 bool** —— 静默产出残缺载荷的后果是
    DA 少了一条约束却照样出报告，从外面看不出来。"""


@dataclass(frozen=True)
class Judgment:
    """`judgment` 段：这条 finding 为什么被判命中。

    `value` 与 `threshold` 的比较方向由 `threshold_config.direction` 决定，
    不在这里编码 —— 两处各存一份方向必然对不上。
    """

    metric: str
    stat: str
    value: float
    threshold: float
    headroom: float | None = None
    consecutive_high_days: int | None = None
    coverage_days: int | None = None
    raw_value: float | None = None
    """原始观测值（字节等）。

    🔴 只有百分比类指标才有。`value` 与 `threshold` 是**同量纲的百分比**
    （headroom 的计算依赖这一点），而人读的是「可用 200 MB / 共 8 GB」。
    少了它，DA 与报告只能说「可用 2.4%」—— 那句话没法直接对着
    CloudWatch 图表核对，因为图表上是字节。
    """
    denominator: float | None = None
    """百分比的分母（实例总内存 / 分配存储，字节）。与 `raw_value` 成对出现。"""
    companion_metric: str = ""
    """伴随指标名（`thresholds.COMPANIONS`）。没有伴随条件的指标为空串。"""
    companion_value: float | None = None
    """伴随指标的实测值。

    🔴 这是「为什么这次是真的」的证据。`FreeableMemory` 单看百分比**分不出**
    两种情况 —— 实测两台真实实例都在 1.1%~1.3%，一台在 492 IOPS/s 回盘读
    （真问题），另一台 0.07 IOPS/s（buffer pool 正常占用，完全健康）。

    少了它，DA 只能说「可用内存 1.1%」，而客户完全有理由把它当成 MySQL 的
    正常稳态而忽略掉 —— 那句话本身也确实无法区分。
    """
    companion_threshold: float | None = None
    """伴随条件的门槛，供写成「ReadIOPS 492/s，门槛 20/s」。"""

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "metric": self.metric,
            "stat": self.stat,
            "value": self.value,
            "threshold": self.threshold,
        }
        # None 的字段不写进载荷 —— 让 skill 看到 `headroom: null` 与看不到这个键
        # 是两种不同的信息，而我们只想表达后者（「本规则不产出 headroom」）。
        if self.headroom is not None:
            out["headroom"] = self.headroom
        if self.consecutive_high_days is not None:
            out["consecutive_high_days"] = self.consecutive_high_days
        if self.coverage_days is not None:
            out["coverage_days"] = self.coverage_days
        # 成对出现或都不出现 —— 一个没有分母的 raw_value 说明不了任何事，
        # 而 DA 拿到孤零零的 `raw_value: 2.1e8` 会把它当成阈值的同量纲值。
        if self.raw_value is not None and self.denominator is not None:
            out["raw_value"] = self.raw_value
            out["denominator"] = self.denominator
        # 伴随条件：三个一起出现或都不出现。
        # ⚠️ 只给 `companion_value` 不给名字和门槛，DA 就只看到一个孤零零的
        #    数字，既不知道它是哪个指标也不知道跟什么比 —— 那时它大概会
        #    忽略这个字段，而它恰恰是「1.1% 到底是不是问题」的唯一判据。
        if (self.companion_metric and self.companion_value is not None
                and self.companion_threshold is not None):
            out["companion_metric"] = self.companion_metric
            out["companion_value"] = self.companion_value
            out["companion_threshold"] = self.companion_threshold
        return out


def cost_from_estimate(
    estimate: PriceEstimate | None,
    *,
    monthly_cost: float | None = None,
    downsize_target: str | None = None,
) -> dict[str, Any] | None:
    """把 `PriceEstimate` 映射成载荷的 `cost` 段。`None` 估价 → 无 `cost` 段。

    ⚠️ `price_precision` **必须**给：缺了它 DA 会把粗估当精确值写进客户报告，
    而 `pricing_estimates.json` 的 `_region_note` 明确说本表任何取值都是 coarse。
    """
    if estimate is None:
        return None
    out: dict[str, Any] = {
        "savings_estimate": estimate.monthly_usd,
        "price_precision": estimate.precision.value,
    }
    if monthly_cost is not None:
        out["monthly_cost"] = monthly_cost
    if downsize_target:
        out["downsize_target"] = downsize_target
    return out


def unavailable(
    reason: Unavailable | str, *, detail: str = ""
) -> dict[str, Any]:
    """构造一条缺失声明：`{"status": "unavailable", "reason": ...}`。

    用在 `correlated` 的值位上，替代空数组：

    ```python
    correlated = {
        "DatabaseConnections": [12, 11, 13],
        # 这台是 writer，本来就不该有 reader 侧的延迟指标 —— 是证据，不是缺口
        "AuroraReplicaLag": unavailable(Unavailable.NOT_APPLICABLE,
                                        detail="cluster writer"),
        # 期望有却拿到空 —— 不是证据，只能得出 insufficient_evidence
        "ReplicationLag": unavailable(Unavailable.NO_DATAPOINTS),
    }
    ```
    """
    r = reason if isinstance(reason, Unavailable) else Unavailable(str(reason))
    out: dict[str, Any] = {"status": STATUS_UNAVAILABLE, "reason": r.value}
    if detail:
        out["detail"] = detail
    return out


def is_unavailable(value: Any) -> bool:
    """判断 `correlated` 的某个值是否为缺失声明（而不是数据序列）。"""
    return isinstance(value, Mapping) and value.get("status") == STATUS_UNAVAILABLE


def attrs_section(attrs: ResourceAttrs) -> dict[str, Any]:
    """`attrs` 段：describe 类事实，让 DA 不必自己再查一遍。

    ⚠️ `baseline_iops` 是**真实基线**而非 gp3 假设。100GiB 的 gp2 基线是 300 IOPS，
    按 gp3 的 3000 算会把「已经饱和」判成「几乎不做 IO」—— 方向正好反。
    """
    return {
        "instance_class": attrs.instance_class,
        "engine_version": attrs.engine_version,
        "multi_az": attrs.multi_az,
        "storage_type": attrs.storage_type,
        "baseline_iops": attrs.baseline_iops,
        "max_connections": attrs.max_connections,
        "allocated_storage_gb": attrs.allocated_storage_gb,
        "max_allocated_storage": attrs.max_allocated_storage_gb,
        "maxmemory_policy": attrs.maxmemory_policy,
        # 🔴 **角色的权威字段。** 来自 Describe API：
        #      RDS      ReadReplicaSourceDBInstanceIdentifier
        #      Aurora   DBClusterMembers[].IsClusterWriter
        #      EC       NodeGroups[].NodeGroupMembers[].CurrentRole
        #
        #    2026-09-01 之前载荷里没有它，判读侧只有下面两个布尔值 +
        #    一堆指标，于是它按「有 ReplicationLag ⇒ 是 replica」去猜身份，
        #    把一台单节点 Redis primary 判成 standby 并建议留着不动。
        #    而那台 primary 的 `ReplicationLag` **确实有 6 天数据** ——
        #    指标存在与否说明不了角色，只有这一行说得了。
        #
        # ⚠️ `unknown` 是一个**正常取值**，不是错误：Aurora 成员而
        #    `describe_db_clusters` 失败时就是它。判读侧遇到 unknown
        #    SHALL NOT 补一个猜测，也 SHALL NOT 据此给破坏性建议。
        "resource_role": resolve_role(attrs).value,
        # 以下两个是过渡期保留的旧字段（结构性规则仍在用）。
        # ⚠️ 与 `resource_role` 冲突时**以 resource_role 为准** ——
        #    它区分得出「不知道」，这两个布尔值区分不出。
        "is_read_replica": attrs.is_read_replica,
        "is_cluster_writer": attrs.is_cluster_writer,
        # Performance Insights：判读 skill 靠这两个决定能不能用 PI。
        # ⚠️ 两个都要给。`DBLoad`（AAS）是官方的负载度量但只在 PI 里，
        #    而 PI 默认只留 7 天 —— 只给 enabled 会让 skill 说
        #    「已查 PI，DBLoad 正常」而它实际什么都没查到（保留期不覆盖
        #    `data_date`）。
        "performance_insights_enabled": attrs.performance_insights_enabled,
        "performance_insights_retention_days":
            attrs.performance_insights_retention_days,
        "tier": attrs.tier,
    }


def metric_contract(
    attrs: ResourceAttrs,
    *,
    family: str,
    metrics: Sequence[str] | Iterable[str],
) -> dict[str, dict[str, Any]]:
    """`metric_contract` 段：**本条 finding 用到的**每个指标在回答什么问题、
    对这台资源适不适用。

    🔴 存在的理由：判读 skill 此前只拿到指标名 + 一串数字，语义靠它自己猜。
       猜错一次的代价是 2026-09-01 那条 P0（把 primary 判成 replica）。
       指标语义本来就在 `metrics_meta` 里有单一来源 —— 把它随载荷下发，
       比写进两份 SKILL.md 更不容易漂移（md 改一份忘另一份不会有任何东西失败）。

    ⚠️ **只带本条 finding 相关的指标**，不是整族清单。理由是硬的：
       `DESCRIPTION_LIMIT` 是 10000 字符，而一条载荷已经占 1200~3700。
       整族下发（52 个指标 × 约 70 字节）会直接把装箱容量吃掉一半以上。

    每个指标的字段：

    ```
    purpose        在回答什么问题（MetricPurpose）。未归类的指标省略此键。
    applicable     对这台资源结构上存不存在。false 时必带 reason。
    reason         为什么不适用（人类可读，如 "storage_type=gp3 无 gp2 突发额度机制"）
    role_evidence  仅在**看起来像角色信号但不是**的指标上出现，恒为 false。
                   见 `metrics_meta.ROLE_BLIND_METRICS`。
                   ⚠️ 这个键不出现 ≠ 可以拿它判角色 —— 只是那个指标压根不像
                     角色信号，不需要专门辟谣。角色一律读 attrs.resource_role。
    ```
    """
    from inspection.domain import metrics_meta as mm

    role = resolve_role(attrs)
    out: dict[str, dict[str, Any]] = {}
    for m in metrics:
        name = str(m or "").strip()
        # ⚠️ 未知指标**不进契约**：我们对它没有任何权威语义，
        #    编一个 purpose 出来就是把猜测伪装成事实。
        if not name or name in out or not mm.is_known(name):
            continue
        app = mm.applicability(
            name, family=family, role=role,
            instance_class=attrs.instance_class, storage_type=attrs.storage_type)
        spec: dict[str, Any] = {}
        purpose = mm.purpose_of(name)
        if purpose is not None:
            spec["purpose"] = purpose.value
        spec["applicable"] = app.applicable
        if not app.applicable and app.reason:
            spec["reason"] = app.reason
        if name in mm.ROLE_BLIND_METRICS:
            spec["role_evidence"] = False
        out[name] = spec
    return dict(sorted(out.items()))


def _contract_metrics(
    *,
    correlated: Mapping[str, Any] | None,
    judgment: Mapping[str, Any] | None,
    threshold_config: Mapping[str, Any] | None,
    daily_metric: str = "",
) -> list[str]:
    """本条载荷里**真的被引用到**的指标名，去重且顺序稳定。

    ⚠️ `judgment.metric` 与 `threshold_config.metric` 也要收进来 ——
    高负载类载荷的主指标在那两处，不在 `correlated` 里。漏了它们的表现是
    「越线的那个指标恰好是契约里唯一没有的」。
    """
    names: list[str] = []
    for m in (daily_metric, ):
        if m:
            names.append(str(m))
    for src in (judgment, threshold_config):
        if isinstance(src, Mapping):
            m = str(src.get("metric") or "").strip()
            if m and m != "-":
                names.append(m)
    if correlated:
        names.extend(str(k) for k in correlated)
    seen: dict[str, None] = {}
    for n in names:
        seen.setdefault(n, None)
    return list(seen)


def _coerce_correlated_value(metric: str, value: Any) -> Any:
    """`correlated` 的一个值：数据序列或缺失声明，两者之外**在构造时就拒**。

    ⚠️ 早期版本这里是无条件 `list(value)`，两种输入被静默毁形：

    ```
    {"reason": "not_applicable"}   漏写 status 的声明 → ["reason"]
    "12,11,13"                     字符串             → ["1","2",",","1","1",...]
    ```

    两者都变成了「非空列表」，于是 `validate_payload` 看到的是合法序列，
    什么都拦不住 —— 错误被搬运到了下游而不是被拦下。
    """
    if is_unavailable(value):
        r = value.get("reason")
        if r not in {m.value for m in Unavailable}:
            raise PayloadContractError(
                f"correlated[{metric!r}] 的 reason 必须是 "
                f"{sorted(m.value for m in Unavailable)} 之一，实际 {r!r}"
            )
        return dict(value)
    if isinstance(value, Mapping):
        raise PayloadContractError(
            f"correlated[{metric!r}] 是 Mapping 但不是合法的缺失声明"
            f"（缺 status={STATUS_UNAVAILABLE!r}）。空缺请用 payload.unavailable() 构造"
        )
    if isinstance(value, (str, bytes)):
        raise PayloadContractError(
            f"correlated[{metric!r}] 必须是序列或缺失声明，实际 "
            f"{type(value).__name__} —— 字符串虽然是 Sequence，"
            "但 list() 会把它拆成单字符"
        )
    if not isinstance(value, Sequence):
        raise PayloadContractError(
            f"correlated[{metric!r}] 必须是序列或缺失声明，实际 {type(value).__name__}"
        )
    return list(value)


def build_payload(
    *,
    finding_id: str,
    account_id: str,
    region: str,
    instance: str,
    engine: str,
    metric_family: str,
    data_date: date | str,
    hit_reason: Sequence[str],
    severity: Severity | str,
    judgment: Judgment | Mapping[str, Any] | None = None,
    daily: Sequence[Mapping[str, Any]] = (),
    correlated: Mapping[str, Sequence[Any] | Mapping[str, Any]] | None = None,
    threshold_config: Mapping[str, Any] | None = None,
    attrs: ResourceAttrs | Mapping[str, Any] | None = None,
    metric_contract_override: Mapping[str, Mapping[str, Any]] | None = None,
    cost: Mapping[str, Any] | None = None,
    structural: Mapping[str, Any] | None = None,
    change_events: Sequence[Mapping[str, Any]] = (),
    config_version: str = "",
    locale: str = "zh",
    resource_reachable: bool = True,
    operator_note: str = "",
) -> dict[str, Any]:
    """按设计组装一条 finding 的载荷。不校验 —— 校验走 `validate_payload()`。

    `engine_eol` 不在 `attrs` 里而由 `structural` 规则单独产出（它是 refdata 查表结果，
    不是 describe 字段）—— 它走 `structural` 段。

    ⚠️ `structural` 段是**后补的**，补之前结构性 finding 的判据数字
    （证书剩余天数、EOL 日期、gp2 卷的真实基线）在载荷里**无处安放**：
    `threshold_config` 强制要求 `direction`，而「证书 20 天后过期」没有方向；
    `attrs` 只装 describe 字段，把查表结果塞进去会让 skill 那句
    「attrs 里的都是我们已经 describe 过的」变成假话。
    结果是 DA 只能自己编日期 —— 正是边界②要防的事。
    """
    out: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "marker": MARKER,
        "finding_id": finding_id,
        "account_id": account_id,
        "region": region,
        "instance": instance,
        "engine": engine,
        "metric_family": metric_family,
        "data_date": data_date.isoformat() if isinstance(data_date, date) else data_date,
        "hit_reason": list(hit_reason),
        # `Severity` 是 str 子类，但显式取 .value 让 JSON 里永远是裸字符串
        # 而不是 "Severity.HIGH"（某些序列化器会那样输出枚举）。
        "severity": Severity.coerce(severity).value,
        "locale": locale,
        # 🔴 DA 能不能**自己去这个账号调 API**（Performance Insights /
        #    DescribeEvents / CloudTrail）。
        #
        #    巡检的判读共用**部署账号**的一个 Agent Space，而那个 space 的
        #    association 默认只有部署账号自己。所以成员账号的 finding 派进去
        #    之后，DA 对那个账号是**够不到**的。
        #
        #    没有这个字段的后果（实测形态）：`attrs.performance_insights_enabled`
        #    是从成员账号读到的 `true`，skill 于是判「usable」并要求 DA 自己去取
        #    `DBLoad`；DA 拿到 AccessDenied（或在部署账号里解析到同名实例），
        #    而 skill 强制的三选一表述里没有「我到不了那个账号」这一档 ——
        #    最可能的输出是「PI is not enabled on this instance」。
        #    **对一台明明开了 PI 的库说了假话**，客户去查自己的配置查不出问题。
        #
        #    同样适用于 `rds:DescribeEvents` / `elasticache:DescribeEvents` /
        #    CloudTrail 那三条指引。
        #
        # ⚠️ 默认 `True`：部署账号自己的 finding 是绝大多数，也是唯一一定够得到的。
        "resource_reachable": bool(resource_reachable),
    }
    if judgment is not None:
        out["judgment"] = (
            judgment.as_dict() if isinstance(judgment, Judgment) else dict(judgment)
        )
    if daily:
        out["daily"] = [dict(r) for r in daily]
    if correlated:
        out["correlated"] = {
            k: _coerce_correlated_value(k, v) for k, v in correlated.items()
        }
    if threshold_config:
        out["threshold_config"] = dict(threshold_config)
    if attrs is not None:
        out["attrs"] = (
            attrs_section(attrs) if isinstance(attrs, ResourceAttrs) else dict(attrs)
        )
    # `metric_contract` —— 自动建，不要求调用方记得传。
    #
    # 🔴 自动的理由：判读有**两条**入口（编排自动派发 `assemble` 与运维手动
    #    派发 `manual_judge`），而这个段是安全约束的一部分（它说明哪些指标
    #    不适用、哪些不能用来判角色）。做成可选入参 = 迟早有一条路径忘了传，
    #    而忘了的表现是那条路径的判读退回到 2026-09-01 的猜身份状态 ——
    #    从外面完全看不出来，载荷照样合法、报告照样出。
    #
    # ⚠️ 只有 `attrs` 是 `ResourceAttrs` 时才建：适用性判定要读
    #    `instance_class` / `storage_type` / 角色，dict 形态的 attrs
    #    不保证有这些键，缺了会算出错误的 `applicable`。
    if metric_contract_override is not None:
        if metric_contract_override:
            out["metric_contract"] = {
                k: dict(v) for k, v in metric_contract_override.items()
            }
    elif isinstance(attrs, ResourceAttrs):
        contract = metric_contract(
            attrs, family=metric_family,
            metrics=_contract_metrics(
                correlated=correlated,
                judgment=out.get("judgment"),
                threshold_config=threshold_config,
            ),
        )
        if contract:
            out["metric_contract"] = contract
    if cost:
        out["cost"] = dict(cost)
    if structural:
        out["structural"] = dict(structural)
    if change_events:
        out["change_events"] = [dict(e) for e in change_events]
    if config_version:
        out["config_version"] = config_version
    # 🔴 运维在界面上手填的一句背景说明（「手动派判读」那条路才有）。
    #
    #    存在的理由：确定性规则能看出「利用率低」，看不出**为什么**低。而
    #    「这台是 DR 备库」「月末才跑批」这类事只有客户知道，
    #    而 skill 的整个价值就在这个区分上 —— 它自己的 docstring 写着
    #    「recommending deletion of a disaster-recovery replica is worse than
    #    recommending nothing at all」。
    #
    # ⚠️ **只在非空时写这个键。** 空串写进去会让 skill 那侧多一个「有这个字段
    #    但里面没东西」的状态要处理，而它与「没有这个字段」的正确行为完全一样。
    #
    # ⚠️ 它是**背景信息，不是指令** —— 这条约束写在 `_shared/GUARDRAILS.md`
    #    的字段表里（会生成进两个 SKILL.md）。不写的话客户输入
    #    「这台没问题别报了」会真的把结论翻掉，而严重度是判定层的事，
    #    不该由一段自由文本改写。
    # ⚠️ 判据是 `.strip()` 而不是裸真值：`"   "` / `"\n"` 都是真值，
    #    会把一个纯空白的备注写进载荷 —— 而 `validate_payload` 那侧正好拒空白
    #    （它的理由是「出现空值说明有别的写入面绕过了 build_payload」），
    #    于是这里写进去、那里拒掉，整条派发失败在自己身上。
    #    2026-08-31 测试抓到：输入框里敲几个空格就够。
    #    同时 **落库的是 strip 后的值** —— 前后空白进了 JSON 只是噪音。
    note = str(operator_note or "").strip()
    if note:
        out["operator_note"] = note
    return out


# 无条件必须存在的键。其余键按 hit_reason 条件性存在（见 validate_payload）。
_REQUIRED_KEYS = (
    "schema_version", "marker", "finding_id", "account_id", "region",
    "instance", "engine", "metric_family", "data_date", "hit_reason",
    "severity", "locale",
)


def validate_payload(payload: Mapping[str, Any]) -> None:
    """校验一条载荷。不满足契约即抛 `PayloadContractError`。

    这里的每一条都对应 skill 里的一条约束。**加约束时两边一起加** ——
    只在 skill 里写「你会收到 X」而载荷不保证 X，那条约束就是空话。
    """
    missing = [k for k in _REQUIRED_KEYS if k not in payload]
    if missing:
        raise PayloadContractError(f"缺必填字段: {sorted(missing)}")

    if payload["marker"] != MARKER:
        raise PayloadContractError(
            f"marker 必须恒为 {MARKER!r}（skill 激活的唯一确定信号），"
            f"实际 {payload['marker']!r}"
        )

    ver = str(payload["schema_version"])
    if not ver or not ver.split(".")[0].isdigit():
        raise PayloadContractError(f"schema_version 形如 '1.0'，实际 {ver!r}")

    reasons = payload["hit_reason"]
    if not isinstance(reasons, list) or not reasons:
        raise PayloadContractError("hit_reason 必须是非空列表")
    unknown = sorted(set(reasons) - VALID_HIT_REASONS)
    if unknown:
        raise PayloadContractError(
            f"未知 hit_reason: {unknown}（合法: {sorted(VALID_HIT_REASONS)}）"
        )

    if payload["severity"] not in VALID_SEVERITIES:
        raise PayloadContractError(
            f"severity 必须是 {sorted(VALID_SEVERITIES)} 之一，"
            f"实际 {payload['severity']!r}。"
            "⚠️ 它由 R7.2a 的确定性表算出并随载荷下发；不下发 DA 会自评一套，"
            "于是同一条 finding 在看板与报告正文里两个严重度（R9.1 禁止）"
        )

    # `operator_note` —— 唯一由用户自由输入的字段（「手动派判读」那条路）。
    #
    # 🔴 校验放在这里而不是只在写侧（BFF）：写侧管新数据，这一道管**所有**
    #    进到 API 的载荷。而这个字段的失败模式是「描述超 10000 → 413 →
    #    那次派发失败」，错误信息里不会提备注，客户看到的是「点了没反应」。
    if "operator_note" in payload:
        note = payload["operator_note"]
        if not isinstance(note, str):
            raise PayloadContractError(
                f"operator_note 必须是字符串，实际 {type(note).__name__}"
            )
        # ⚠️ 空串要拒而不是放过：`build_payload` 只在非空时写这个键，所以载荷里
        #    出现空串意味着有别的写入面绕过了它 —— 而那一面大概率也没做长度校验。
        if not note.strip():
            raise PayloadContractError(
                "operator_note 存在但是空的 —— build_payload 只在非空时写这个键，"
                "出现空值说明有别的写入面绕过了它（那一面大概率也没做长度校验）"
            )
        if len(note) > OPERATOR_NOTE_LIMIT:
            raise PayloadContractError(
                f"operator_note 超过 {OPERATOR_NOTE_LIMIT} 字符（实际 {len(note)}）。"
                f"描述硬上限是 {DESCRIPTION_LIMIT}，而单条载荷本身就占 1200~3700，"
                "超限时 API 抛 ContentSizeExceededException(413)、那次派发失败，"
                "而错误信息里不会提到备注"
            )

    if not str(payload["finding_id"]).strip():
        raise PayloadContractError(
            "finding_id 不能为空 —— 合批后 reference.referenceId 存的是 batch_id，"
            "callback 靠内联的 finding_id 把判读文本回拼到各自的 finding 行"
        )

    # R2.6.2：chronic_high 是「慢性高位」的**补充标注**，不能单独成立 ——
    # 它没有自己的 judgment（阈值来自 threshold_high 那条），单独出现时
    # skill 拿不到任何可引用的数字，只能凭 severity 编一段话。
    if HIT_CHRONIC_HIGH in reasons and HIT_THRESHOLD_HIGH not in reasons:
        raise PayloadContractError(
            f"{HIT_CHRONIC_HIGH!r} 不能单独出现，必须与 {HIT_THRESHOLD_HIGH!r} 同现"
            "（R2.6.2：它是慢性高位的补充标注，判据与阈值都在 threshold_high 那条上）"
        )

    # 高负载类必须带 judgment —— 边界②要求 DA 引用的每个数字都来自载荷，
    # 缺了 judgment 它无数字可引，却仍会被要求给出结论。
    if HIT_THRESHOLD_HIGH in reasons and "judgment" not in payload:
        raise PayloadContractError(
            f"{HIT_THRESHOLD_HIGH!r} 类 finding 必须带 judgment"
            "（metric/stat/value/threshold）—— 边界②要求每个数字都可从载荷复制，"
            "没有 judgment 就只能让 DA 自己编"
        )

    tc = payload.get("threshold_config")
    if tc is not None:
        if not isinstance(tc, Mapping):
            raise PayloadContractError(
                f"threshold_config 必须是映射，实际 {type(tc).__name__}"
            )
        d = tc.get("direction")
        if d not in VALID_DIRECTIONS:
            raise PayloadContractError(
                f"threshold_config.direction 必须是 {sorted(VALID_DIRECTIONS)} 之一，"
                f"实际 {d!r}"
            )

    # cost 的存在性是**双向**约束：该有的必须有，不该有的必须没有。
    has_cost_reason = bool(set(reasons) & COST_BEARING_HIT_REASONS)
    cost = payload.get("cost")
    if cost is not None and not has_cost_reason:
        raise PayloadContractError(
            f"cost 只能出现在 {sorted(COST_BEARING_HIT_REASONS)} 类 finding 上，"
            f"当前 hit_reason={reasons}。"
            "⚠️ 给高负载判读喂金额会诱导 DA 在可靠性结论里谈钱"
        )
    if cost is not None:
        if not isinstance(cost, Mapping):
            raise PayloadContractError(
                f"cost 必须是映射，实际 {type(cost).__name__}"
            )
        if not str(cost.get("price_precision") or "").strip():
            raise PayloadContractError(
                "cost.price_precision 不能为空 —— 缺了 DA 会把粗估当精确值写进客户报告"
            )
        if "savings_estimate" not in cost:
            raise PayloadContractError("cost 存在时必须带 savings_estimate")

    # `structural` 的存在性也是**双向**约束，理由和 cost 一样：
    # 单向检查会让「结构性 finding 忘了带判据」这一类静默通过 ——
    # 那条 finding 照样发得出去，DA 照样出报告，只是日期是它编的。
    st = payload.get("structural")
    if HIT_STRUCTURAL in reasons and st is None:
        raise PayloadContractError(
            f"{HIT_STRUCTURAL!r} 类 finding 必须带 structural 段（rule + params）——"
            "结构性风险的判据是「日期 / 属性事实」，"
            "不给 DA 它就只能自己编一个日期写进客户报告（边界②）"
        )
    if st is not None and HIT_STRUCTURAL not in reasons:
        raise PayloadContractError(
            f"structural 段只能出现在 {HIT_STRUCTURAL!r} 类 finding 上，"
            f"当前 hit_reason={reasons}"
        )
    if st is not None:
        if not isinstance(st, Mapping):
            raise PayloadContractError(
                f"structural 必须是映射，实际 {type(st).__name__}"
            )
        if not str(st.get("rule") or "").strip():
            raise PayloadContractError(
                "structural.rule 不能为空 —— 它是规则码（gp2_volume / engine_eol …），"
                "DA 靠它决定说哪一类暴露面"
            )
        params = st.get("params")
        if params is not None and not isinstance(params, Mapping):
            raise PayloadContractError(
                f"structural.params 必须是映射，实际 {type(params).__name__}"
            )
        # R10.9b：params 只装 code 与数值，不装自然语言 ——
        # 装了自然语言就等于我们替 DA 写了结论，而那段话不受 locale 控制，
        # 英文客户会在英文报告里读到一句中文判词。
        for k, v in (params or {}).items():
            if not isinstance(v, (str, int, float, bool, type(None))):
                raise PayloadContractError(
                    f"structural.params[{k!r}] 必须是标量（code 或数值），"
                    f"实际 {type(v).__name__}（R10.9b）"
                )

    _validate_correlated(payload, reasons)
    _validate_metric_contract(payload)

    # 体积。⚠️ 这是唯一一条会在**派发时**变成 AWS 侧硬失败的约束：
    # `CreateBacklogTask.description` 超 10000 字符 → ContentSizeExceededException (413)。
    # 放在这里是为了让它在**构造完就暴露**，而不是等到那一批 task 发出去时才炸
    # —— 那时候错误信息只说「description 太长」，不会告诉你是哪条 finding。
    size = payload_chars(payload)
    if size > DESCRIPTION_LIMIT:
        raise PayloadContractError(
            f"单条载荷 {size} 字符，超过 CreateBacklogTask.description 的硬限 "
            f"{DESCRIPTION_LIMIT}（超限时 API 抛 ContentSizeExceededException/413）。"
            "常见原因是 daily/correlated 的窗口过长或点数过密；"
            "SHALL 在采集侧收窄，不要靠装箱掩盖 —— pack_payloads 对单条超限的"
            "处理是「自成一箱」，那一箱照样发不出去"
        )


def _validate_metric_contract(payload: Mapping[str, Any]) -> None:
    """`metric_contract` 的形状，以及它与 `correlated` **必须一致**。

    🔴 一致性这条是本段的重点，不是形状。载荷里两个字段互相矛盾时判读侧只能
       挑一个信，而挑错的方向就是误删：

    ```
    correlated.ReplicaLag  = {"status":"unavailable","reason":"no_datapoints"}
    metric_contract        = {"ReplicaLag": {"applicable": false}}
                             ↑ 契约说「结构上不该有」，correlated 说「期望有却拿到空」
    ⇒ 判读侧读 correlated  → insufficient_evidence（保守，但把一台该处置的库留着）
      判读侧读 contract    → 「不是副本，可以删」
    ```

    两个方向都钉：
      contract 说不适用 ⟹ correlated 那条不能是 `no_datapoints`
      correlated 说不适用 ⟹ contract 那条的 applicable 必须是 false
    """
    contract = payload.get("metric_contract")
    if contract is None:
        return
    if not isinstance(contract, Mapping):
        raise PayloadContractError(
            f"metric_contract 必须是 metric → spec 的映射，实际 {type(contract).__name__}"
        )

    for metric, spec in contract.items():
        if not isinstance(spec, Mapping):
            raise PayloadContractError(
                f"metric_contract[{metric!r}] 必须是映射，实际 {type(spec).__name__}"
            )
        applicable = spec.get("applicable")
        if not isinstance(applicable, bool):
            raise PayloadContractError(
                f"metric_contract[{metric!r}].applicable 必须是布尔值，"
                f"实际 {applicable!r} —— 缺了它判读侧无从知道这个指标该不该有值"
            )
        if not applicable and not str(spec.get("reason") or "").strip():
            raise PayloadContractError(
                f"metric_contract[{metric!r}] 声明 applicable=false 但没给 reason。"
                "⚠️ 「这个指标不适用」是一条会被当证据用的断言"
                "（「没有副本指标 ⇒ 不是副本 ⇒ 可以删」），"
                "不说明理由等于让判读侧凭一个没有依据的断言下破坏性结论"
            )
        role_evidence = spec.get("role_evidence")
        if role_evidence is not None and role_evidence is not False:
            raise PayloadContractError(
                f"metric_contract[{metric!r}].role_evidence 只允许是 false 或缺省，"
                f"实际 {role_evidence!r}。⚠️ 资源角色的唯一来源是 "
                "attrs.resource_role（Describe API 事实）；任何指标的有无或取值"
                "都不能用来判角色 —— 2026-09-01 实测一台单节点 Redis primary 的 "
                "ReplicationLag 有 6 天数据，靠它判身份会把主库判成 standby"
            )

    correlated = payload.get("correlated") or {}
    if not isinstance(correlated, Mapping):
        return
    for metric, value in correlated.items():
        spec = contract.get(metric)
        if not isinstance(spec, Mapping):
            continue
        contract_na = spec.get("applicable") is False
        payload_na = (
            is_unavailable(value)
            and value.get("reason") == Unavailable.NOT_APPLICABLE.value
        )
        payload_no_data = (
            is_unavailable(value)
            and value.get("reason") == Unavailable.NO_DATAPOINTS.value
        )
        if contract_na and payload_no_data:
            raise PayloadContractError(
                f"{metric!r} 自相矛盾：metric_contract 说 applicable=false"
                f"（{spec.get('reason')!r}），而 correlated 说 "
                f"{Unavailable.NO_DATAPOINTS.value!r}。"
                "前者是「结构上不该有」（有效证据），后者是「期望有却拿到空」"
                "（只能得出 insufficient_evidence）—— 判读侧挑哪一个信都是猜"
            )
        if payload_na and not contract_na:
            raise PayloadContractError(
                f"{metric!r} 自相矛盾：correlated 声明 "
                f"{Unavailable.NOT_APPLICABLE.value!r}，而 metric_contract 说 "
                f"applicable={spec.get('applicable')!r}。"
                "两处判据必须同源（`metrics_meta.applicability()`）"
            )


def _validate_correlated(payload: Mapping[str, Any], reasons: list[str]) -> None:
    """`correlated` 的形状与「缺失必须显式声明」。"""
    correlated = payload.get("correlated")
    if correlated is None:
        correlated = {}
    if not isinstance(correlated, Mapping):
        raise PayloadContractError(
            f"correlated 必须是 metric → 序列|缺失声明 的映射，实际 {type(correlated).__name__}"
        )

    for metric, value in correlated.items():
        if is_unavailable(value):
            r = value.get("reason")
            if r not in {m.value for m in Unavailable}:
                raise PayloadContractError(
                    f"correlated[{metric!r}] 的 reason 必须是 "
                    f"{sorted(m.value for m in Unavailable)} 之一，实际 {r!r}。"
                    "⚠️ 这四档不可合并：NOT_APPLICABLE 是有效证据"
                    "（「没有 AuroraReplicaLag」= 「这台不是 reader」），"
                    "其余三档只能得出 insufficient_evidence"
                )
            continue
        if isinstance(value, Mapping):
            raise PayloadContractError(
                f"correlated[{metric!r}] 是 Mapping 但不是合法的缺失声明"
                f"（缺 status={STATUS_UNAVAILABLE!r}）。"
                "空缺请用 payload.unavailable() 构造"
            )
        if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
            raise PayloadContractError(
                f"correlated[{metric!r}] 必须是序列或缺失声明，"
                f"实际 {type(value).__name__}"
            )
        if len(value) == 0:
            raise PayloadContractError(
                f"correlated[{metric!r}] 是空序列。**空数组是被禁止的**——"
                "它把「拉了没数据」「压根没拉」「客户关了」压成同一个值。"
                "请用 payload.unavailable(Unavailable.X) 说明是哪一种"
            )

    # ★ idle 判读必须能回答「这台是不是副本」。
    if HIT_IDLE in reasons:
        present = REPLICA_SIGNAL_METRICS & set(correlated)
        if not present:
            raise PayloadContractError(
                "idle 类 finding 的 correlated 必须包含至少一个副本判定指标"
                f"（{sorted(REPLICA_SIGNAL_METRICS)}），有值或 unavailable 声明都行。\n"
                "⚠️ 缺了它 cost-idle 的第 1 步无法判「是不是灾备副本」：\n"
                "    这台不是 reader        → 不是副本 → 可以考虑删\n"
                "    这台是 reader 但没采到 → 是副本   → 千万别删\n"
                "两种相反事实在载荷里长得一样 → 落到 disposition: delete，"
                "删掉一台真的 standby。"
            )


def payload_chars(payload: Mapping[str, Any]) -> int:
    """载荷序列化后的字符数 —— 7.3 的装箱依据。

    ⚠️ 按**字符数**而不是条数装箱：单 finding 实测 1227~1623 字符，挂 15 个关联指标
    约 3700，条数固定的装箱会在关联指标多的时候撞 413。
    `ensure_ascii=False` —— 载荷里有中文（reason / locale 相关文本），
    转义成 \\uXXXX 会让字符数虚高 6 倍，装箱就白留了边际。
    """
    return len(json.dumps(payload, ensure_ascii=False, default=str))


def pack_payloads(
    payloads: Sequence[Mapping[str, Any]],
    *,
    target_chars: int = PACKING_TARGET,
    max_per_task: int = 6,
) -> list[list[Mapping[str, Any]]]:
    """按字符数把载荷装箱成多个 task（R5.4）。保持输入顺序。

    Args:
        target_chars: 单个 task 的目标字符上限（默认留 15% 边际）。
        max_per_task: 条数上限。字符数够用时也不超过它 —— 一个 task 里塞太多条，
            DA 的判读会变浅（每条分到的注意力下降），且 context 更容易被压缩
            （见设计的 compaction_count）。

    ⚠️ 单条就超 `target_chars` 时**自成一箱**而不是丢弃 —— 丢弃会让那条 finding
    静默消失。真正超 API 硬限的情况由调用方在派发前处置。
    """
    if target_chars <= 0:
        raise ValueError("target_chars must be positive")
    if max_per_task <= 0:
        raise ValueError("max_per_task must be positive")

    batches: list[list[Mapping[str, Any]]] = []
    cur: list[Mapping[str, Any]] = []
    cur_chars = 0
    for p in payloads:
        n = payload_chars(p)
        too_long = cur and (cur_chars + n > target_chars)
        too_many = len(cur) >= max_per_task
        if too_long or too_many:
            batches.append(cur)
            cur, cur_chars = [], 0
        cur.append(p)
        cur_chars += n
    if cur:
        batches.append(cur)
    return batches
