"""严重度分级与 headroom（R7.2a / R7.2b / R7.4 / R2.4a.1， + 1.12a~d）。

## 为什么这个模块必须存在

`severity` 被 **7 处**当既有输入用（5.6 额度降级 / 6.15 排序限流 / 7.3 载荷 /
8.5 总览分级计数 / 9.8 前端 / 10.3 推送分级 / 1.13 状态机），而 R7 整节原本零任务。
后果是 severity 由 9 处规则各自硬写，最高只给到 `HIGH`：

```
Severity.CRITICAL 在全仓只出现于 dto.py 的枚举定义与 _SEVERITY_ORDER
⇒ R12.2 的「pace > 1.5 → 只对 CRITICAL 调 DA」等价于**一条都不派**
⇒ 而且没有任何错误信号，看板上只显示「本轮 0 条派发」
```

## 边界

纯函数，零 IO（R14.1）。MTTR 表写死在代码里（R7.0a）——它同时是 R9.9
「修复动作与代价」的数据源，**一张表两用**，不得各存一份。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from inspection.domain.dto import ResourceAttrs, Severity

# ---------------------------------------------------------------------------
# headroom
# ---------------------------------------------------------------------------


def compute_headroom(
    value: float, threshold: float, *, bad_up: bool
) -> float | None:
    """余量比例。`None` 表示**不该用比例表达**（见下）。

    ```
    bad_up   指标越大越坏（CPU / 延迟 / 队列深度）   headroom = (T − x) / |T|
    bad_down 指标越小越坏（可用内存 / 剩余存储）      headroom = (x − T) / |T|
    ```

    两个方向都归一成「**越小越危险，0 = 刚好在阈值上，负数 = 已越线**」，
    这样下游的分档表只需要一套判据。

    ⚠️ 先按方向归一**再**做除法。反过来（先除再取绝对值）会让 bad_down 指标的
    符号丢掉 —— 可用内存 100MB 对阈值 500MB 会算出正的 headroom，
    也就是把「已经不够了」读成「还有余量」。

    ⚠️ `|T| == 0` 时返回 `None`（R2.4a.1 的第二段）：那种指标的健康基线恒 0
    且阈值也设成 0（如 `Evictions`），比例没有意义，SHALL 走 R2.1.3 的绝对值表达。
    分母取 `|T|` 而不是 `T` —— 阈值理论上可为负（虽然 `ThresholdRuleConfig`
    已经拒了负数），用带符号的分母会把大小关系整体翻转。
    """
    if threshold == 0:
        return None
    slack = (threshold - value) if bad_up else (value - threshold)
    return slack / abs(threshold)


def is_breached(headroom: float | None) -> bool:
    """`headroom ≤ 0` = 当前值已越过阈值（R2.4a.1 的「现状型」）。

    `None`（比例不适用）**不算越线** —— 那种指标是否越线由绝对值判据回答，
    在这里当成越线会把所有 `Evictions=0` 的实例判成 CRITICAL。
    """
    return headroom is not None and headroom <= 0.0


# ---------------------------------------------------------------------------
# MTTR 表（R7.0a）
# ---------------------------------------------------------------------------


class FixAction(str, Enum):
    """修复动作。**一张表两用**：这里做 severity 的 MTTR 输入，
    同时是 R9.9「修复动作与代价」呈现给客户的数据源。"""

    DISK_GROW = "disk_grow"
    PARAM_RESTART = "param_restart"
    PARAM_IMMEDIATE = "param_immediate"
    """改一个参数、立即生效、**不需要重启**。

    ⚠️ 与 `PARAM_RESTART` 分开是必须的，不是洁癖：后者是
    `downtime=True, window_or_approval=True`，而这一档两个都是 False。
    合并会让报告告诉客户「需要停机 + 走审批」，而实际上是一次 CONFIG SET
    级别的变更 —— 那种误报会让一个 6 小时就能修的事被排到下个变更窗口。

    2026-08-23 实测（`describe-engine-default-parameters --cache-parameter-
    group-family redis7`）：`activedefrag` 的 `ChangeType` 是 `immediate`，
    `IsModifiable` 为 true，默认值是 **`no`**。"""
    EC_SCALE = "ec_scale"
    INSTANCE_TYPE = "instance_type"
    ENGINE_MINOR = "engine_minor"
    PG_XID_VACUUM = "pg_xid_vacuum"
    APP_QUERY_FIX = "app_query_fix"


@dataclass(frozen=True)
class FixCost:
    """一个修复动作的代价。`mttr_days` 进 R7.2a 的分档判据。"""

    mttr_days: float
    downtime: bool
    """是否需要停机。"""
    window_or_approval: bool
    """是否需要变更窗口或审批 —— 它是「5 天」这类长 MTTR 的真实成因。"""
    caveat: str = ""


# R7.0a 的默认值，逐条对应需求正文。⚠️ 与 R2.5.4 的评分权重同规格：
# **不开放配置** —— 这些数字是变更流程的现实约束，不是客户偏好。
MTTR_TABLE: dict[FixAction, FixCost] = {
    FixAction.DISK_GROW: FixCost(
        0.5, downtime=False, window_or_approval=False,
        caveat="同一 EBS 卷 6 小时内只能修改一次",
    ),
    FixAction.PARAM_RESTART: FixCost(1.0, downtime=True, window_or_approval=True),
    # 全表最便宜的一档 —— 比 DISK_GROW 还快（它连「同卷 6 小时一次」那个
    # 限制都没有）。碎片整理属于这一类：开 `activedefrag` 即可，立即生效。
    FixAction.PARAM_IMMEDIATE: FixCost(
        0.25, downtime=False, window_or_approval=False,
        caveat="参数组变更，ChangeType=immediate，无需重启节点",
    ),
    FixAction.EC_SCALE: FixCost(
        1.0, downtime=False, window_or_approval=False,
        caveat="cluster mode 下在线；非 cluster mode 需要 failover",
    ),
    FixAction.INSTANCE_TYPE: FixCost(
        5.0, downtime=True, window_or_approval=True,
        caveat="需 failover 窗口 + 企业变更审批",
    ),
    FixAction.ENGINE_MINOR: FixCost(5.0, downtime=True, window_or_approval=True),
    FixAction.PG_XID_VACUUM: FixCost(
        14.0, downtime=True, window_or_approval=True,
        caveat="需停机数小时，必须提前排期",
    ),
    FixAction.APP_QUERY_FIX: FixCost(
        7.0, downtime=False, window_or_approval=True,
        caveat="需走发布流程",
    ),
}

# 指标 → 主修复动作。决定该指标命中时用哪个 MTTR 做分档。
# ⚠️ 只列**判定用**指标（`thresholds.THRESHOLD_METRICS`），有元断言锁住两者一致。
METRIC_FIX_ACTION: dict[str, FixAction] = {
    # 存储类 → 扩容，最快
    "FreeStorageSpace": FixAction.DISK_GROW,
    # CPU / 内存 / 连接数 → 换规格，慢且要审批
    "CPUUtilization": FixAction.INSTANCE_TYPE,
    # credit 耗尽的真正修复是**离开 burstable**（换 m/r 系），不是调参 ——
    # 切 unlimited 模式只是把问题变成账单（surplus credit 要另外付费）。
    "CPUCreditBalance": FixAction.INSTANCE_TYPE,
    "FreeableMemory": FixAction.INSTANCE_TYPE,
    "EngineCPUUtilization": FixAction.INSTANCE_TYPE,
    "DatabaseMemoryUsagePercentage": FixAction.EC_SCALE,
    "Evictions": FixAction.EC_SCALE,
    # ⚠️ 碎片率**不是** EC_SCALE。内存本身可能完全够用 —— 碎片高的第一处置
    #    是开 `activedefrag`（默认 `no`！），扩容只是掩盖。两者的代价差
    #    4 倍 MTTR 且一个要 failover 一个不用。
    "MemoryFragmentationRatio": FixAction.PARAM_IMMEDIATE,
    "SwapUsage": FixAction.INSTANCE_TYPE,
    # IO 类 → 通常是查询问题，改应用最慢
    "ReadLatency": FixAction.APP_QUERY_FIX,
    "WriteLatency": FixAction.APP_QUERY_FIX,
    "DiskQueueDepth": FixAction.APP_QUERY_FIX,
}


def mttr_days_for(metric: str) -> float:
    """指标对应的 MTTR 天数。未登记的指标返回 0 —— **不猜**。

    ⚠️ 返回 0 而不是某个「保守的大值」：大值会让未登记的指标自动升到 HIGH
    （R7.2a 的第二条判据是 `headroom ≤ 0.35 且 MTTR ≥ 5`），
    也就是加一个指标就悄悄提升了它的严重度。
    """
    action = METRIC_FIX_ACTION.get(metric)
    return MTTR_TABLE[action].mttr_days if action else 0.0


# ---------------------------------------------------------------------------
# 业务影响档位（R7.5）
# ---------------------------------------------------------------------------

PROD_TIERS: frozenset[str] = frozenset({"tier1", "prod"})
"""被视为「生产」的 tier。CRITICAL 档要求 `tier ∈ {tier1, prod}`。

⚠️ 与 `dto.StructuralRuleConfig.prod_tiers` 是同一套取值，有元断言锁住。
"""


def is_production(attrs: ResourceAttrs) -> bool:
    """R7.5：**只取事实，不做推导。**

    tier 由客户声明的 tier-1 清单 + `Environment`/`Criticality` tag 决定，
    在 `attrs_repo` 那一侧已经算好，这里只读。

    ⚠️ SHALL NOT 在这里按「有 MultiAZ 就是生产」之类的规则反推 ——
    R7.5 明令 SHALL NOT 尝试自动推导重要性。推导错的方向是双向有害的：
    把 dev 判成 prod 会制造噪音，把 prod 判成 dev 会漏掉真事故。
    """
    return attrs.tier in PROD_TIERS


# ---------------------------------------------------------------------------
# 分级（R7.2a）
# ---------------------------------------------------------------------------

# R7.2a 的数值。⚠️ 与 R2.4a 的默认值表**同一份数值**，改一处必须改两处。
CRITICAL_HEADROOM = 0.10
HIGH_HEADROOM = 0.20
MEDIUM_HEADROOM = 0.35
HIGH_MTTR_DAYS = 5.0
"""`headroom ≤ 0.35 且 MTTR ≥ 5 天` → HIGH。

⚠️ 这条是 R7.2a 的第二条判据，容易被漏掉：余量还有三成但修起来要一周，
等于「等你排到窗口它已经撞线了」。
"""


def _base_severity(
    headroom: float | None, *, mttr_days: float, production: bool
) -> Severity:
    """R7.2a 的四档表，逐条按数值实现。

    ```
    CRITICAL   headroom ≤ 0.10  且  tier ∈ {tier1, prod}
    HIGH       headroom ≤ 0.20  或  (headroom ≤ 0.35 且 MTTR ≥ 5 天)
    MEDIUM     headroom ≤ 0.35
    INFO       其余 ｜ 结构性 ｜ INSUFFICIENT_DATA
    ```

    ⚠️ `headroom is None`（比例不适用的指标）落 INFO 而不是 CRITICAL ——
    判它的是绝对值判据，不是这里。
    """
    if headroom is None:
        return Severity.INFO
    if headroom <= CRITICAL_HEADROOM and production:
        return Severity.CRITICAL
    if headroom <= HIGH_HEADROOM:
        return Severity.HIGH
    if headroom <= MEDIUM_HEADROOM and mttr_days >= HIGH_MTTR_DAYS:
        return Severity.HIGH
    if headroom <= MEDIUM_HEADROOM:
        return Severity.MEDIUM
    return Severity.INFO


_BY_ORDER: dict[int, Severity] = {m.order: m for m in Severity}


def bump(sev: Severity, *, cap: Severity = Severity.CRITICAL) -> Severity:
    """升**一**档，不超过 `cap`。

    `Severity.order` 越小越严重，所以升档是 order 减 1。

    ⚠️ 第一版写成了「取 `min(sev.order - 1, cap.order)` 再按 order 反查」，
    结果 MEDIUM 直接跳到 CRITICAL —— 因为 `min` 选的是**更严重**的那个，
    而 cap 的语义是「不得超过」，应该用 `max`。升两档在 R7.2b 下是错的：
    慢性高位只是「撑了 N 天」，不该等同于「已越线且在生产」。
    """
    target = max(sev.order - 1, cap.order)
    if target >= sev.order:
        return sev          # 已经到 cap 或已是最高档
    return _BY_ORDER[target]


@dataclass(frozen=True)
class SeverityInput:
    """`compute_severity` 的全部输入。做成 dataclass 而不是长参数列表 ——
    调用点有 7 处，位置参数出错时不会报错，只会静默算出别的档位。"""

    headroom: float | None
    metric: str = ""
    chronic_high: bool = False
    """R2.6 慢性高位命中（水位超门槛持续 N 天）。"""
    insufficient_data: bool = False
    """coverage 不足（R2.1 / 1.12）。"""
    structural: bool = False
    """结构性风险（走 R2.4.3a 月度摘要）。"""


def compute_severity(
    inp: SeverityInput, attrs: ResourceAttrs
) -> Severity:
    """R7 的唯一分级入口。**全仓只有这一处产出 severity。**

    ⚠️ 落地它的时候 SHALL 把 `structural/rules.py` 与 `scoring/capacity.py` 里
    那 9 处硬写改为调用这里—— 否则就是 severity 的双真源，
    表现是「同一条 finding 在列表页和详情页显示不同严重度」。

    顺序是刻意的：数据不足 / 结构性先短路（它们与 headroom 无关），
    再算基础档，最后按 R7.2b（慢性）与 R7.4（noeviction）升档。
    """
    if inp.insufficient_data or inp.structural:
        # R7.2a 明确把这两类归入 INFO 档。它们不是「不严重」，
        # 而是「不由 headroom 分级」——结构性走月度摘要，数据不足要先补数据。
        return Severity.INFO

    sev = _base_severity(
        inp.headroom,
        mttr_days=mttr_days_for(inp.metric),
        production=is_production(attrs),
    )

    # R7.2b：慢性高位升一档，**上限 HIGH**。
    # 不升到 CRITICAL 的理由：慢性意味着它已经这样撑了 N 天，不是今晚就炸；
    # 但也不能留在 MEDIUM —— 它处在压力平衡点上，任一尖峰即越线。
    if inp.chronic_high:
        sev = bump(sev, cap=Severity.HIGH)

    # R7.4：ElastiCache 的 noeviction 比 LRU 高一档 —— 撞墙时是**写入失败**
    # 而不是淘汰旧键。这里不设 cap：noeviction 的生产集群撞墙就是事故。
    if _is_noeviction(attrs):
        sev = bump(sev)

    return sev


def severity_for_verdict(verdict, attrs: ResourceAttrs) -> Severity:
    """`InstanceVerdict` → `Severity`（闭合 1.3a → 1.12e → 1.12a → 1.12f 的依赖链）。

    这是**高负载路径的唯一分级入口**。它把三件事接起来：

    ```
    evaluate_threshold  给出 worst（headroom 最小的那条命中）与 chronic_days
            ↓
    这里                取 worst.headroom + worst.metric（决定 MTTR）+ verdict.chronic
            ↓
    compute_severity    R7.2a 四档 → R7.2b 慢性升档(cap=HIGH) → R7.4 noeviction
            ↓
    载荷的 severity 字段  两份 skill 的硬边界①「不得自己评级」才有意义
    ```

    ⚠️ 最后一跳是真实耦合：`_shared/GUARDRAILS.md` 要求 DA 不自评级，
    前提是**我们把 severity 下发**。这里不接 → 载荷没有 severity →
    DA 必然自评一套 → 同一条 finding 在看板与报告正文两个严重度（R9.1 禁止）。

    ⚠️ 慢性命中但当天未越线时（R2.6.3 的典型形态：横在坏侧三周、斜率归零），
    `worst` 为 `None` —— 此时用 `headroom=0.0` 作为「刚好在阈值上」，
    因为它确实横在门槛线的坏侧。SHALL NOT 用 `None`（那会落 INFO，
    而 INFO 不推 IM，等于把 v1 唯一能兜住渐进劣化的规则静默作废）。
    """
    if verdict.insufficient_data:
        return compute_severity(
            SeverityInput(headroom=None, insufficient_data=True), attrs)

    worst = verdict.worst
    if worst is not None:
        headroom, metric = worst.headroom, worst.metric
    elif verdict.chronic:
        # 慢性命中但今天没越线（R2.6.3 的典型形态：横在坏侧数周、斜率归零）。
        # ⚠️ 用 `MEDIUM_HEADROOM` 作为基线，**不是 0.0**。
        # 0.0 的含义是「刚好在阈值线上」，而 `_base_severity` 对
        # `headroom <= CRITICAL_HEADROOM 且生产` 判 CRITICAL ——
        # 于是「当天已恢复、只是历史横过」会直接变成 CRITICAL，
        # 比「当天真的越线」还严重，方向完全反了。
        # 取 MEDIUM 档基线再由下面的慢性升档抬到 HIGH，才符合 R7.2b 的原意：
        # 「不是今晚就炸，但处在压力平衡点上」。
        headroom = MEDIUM_HEADROOM
        metric = max(verdict.chronic_days, key=lambda m: verdict.chronic_days[m])
    else:
        return Severity.INFO

    return compute_severity(
        SeverityInput(
            headroom=headroom, metric=metric, chronic_high=verdict.chronic,
        ),
        attrs,
    )


# ---------------------------------------------------------------------------
# 结构性风险的分级（R7.6「日期确定，零统计成本」）
# ---------------------------------------------------------------------------
#
# ⚠️ **这里与 R7.2a 的字面表述有出入，是刻意的。** R7.2a 把「结构性风险」列在
# INFO 档里，读起来像是「结构性一律 INFO」。但那会造成真实危害：
#
# ```
# CA 证书 3 天后过期 → INFO → R7.7 规定 INFO 不推 IM → 客户到期才发现
# 引擎已过 EOL 正在按 Extended Support 计费 → INFO → 没人看
# ```
#
# 正确的读法是：R7.2a 那张表分的是**按 headroom 分级**的那条路，
# 而结构性风险不走 headroom（它没有「余量」这个量），它按 **日期临近度** 分级
# —— 这正是 R7.6 说的「日期确定」。两者是并列的两条路，不是一条覆盖另一条。
#
# 收拢到这里的目的不是改判据，而是**消灭 severity 的第二个真源**：
# 原先这些分档硬写在 `structural/rules.py`（4 处）与 `scoring/capacity.py`（2 处），
# 与 headroom 那套各自演化，表现是「同一条 finding 在列表页和详情页显示不同严重度」。

# 日期型结构性风险的临近度分档（天）。
STRUCTURAL_IMMINENT_DAYS = 0
"""已过期/已越线。"""
STRUCTURAL_NEAR_DAYS = 30
"""30 天内 —— 排一次变更窗口通常要 1~2 周，30 天是「该动手了」的线。"""


def structural_severity_by_date(days_left: int | None) -> Severity:
    """按剩余天数给结构性风险分级。

    ```
    days_left < 0    HIGH     已过期（如引擎已过 EOL，正在按 Extended Support 计费）
    ≤ 30             MEDIUM   排变更窗口通常 1~2 周，30 天是「该动手」的线
    其余             INFO     还早，进月度摘要（R2.4.3a）
    None             INFO     拿不到日期 —— **不猜**
    ```

    ⚠️ `None` 落 INFO 而不是 HIGH：拿不到 EOL 日期通常是 refdata 没覆盖到那个版本，
    按最坏情况报会在每次 refdata 滞后时制造一批假 HIGH。
    """
    if days_left is None:
        return Severity.INFO
    if days_left < STRUCTURAL_IMMINENT_DAYS:
        return Severity.HIGH
    if days_left <= STRUCTURAL_NEAR_DAYS:
        return Severity.MEDIUM
    return Severity.INFO


def structural_severity_cert(days_left: int | None) -> Severity:
    """CA 证书临期。**比通用日期分档严一档。**

    ⚠️ 与 `structural_severity_by_date` 不同是刻意的，两者的失败模式不一样：

    ```
    引擎 EOL 到期    → 进入 Extended Support，**多花钱**，服务照常
    CA 证书到期      → 客户端 TLS 握手直接失败，**服务中断**
    ```

    所以证书用 `≤30 天 → HIGH`（而不是 MEDIUM）：30 天内要走一次
    「改客户端信任库 + 滚动重启」，那不是一个变更窗口能做完的事。

    ⚠️ 这条判据是从原 `rules.py` 的 `days_left <= 30 → HIGH` 平移过来的。
    统一到 severity.py 时我一度把它并进通用日期分档，结果 15 天后过期的证书
    从 HIGH 降到 MEDIUM —— R7.7 下 MEDIUM 与 HIGH 的推送渠道不同，
    等于把一次即将发生的服务中断降级成了普通提示。测试抓住了这次回归。
    """
    if days_left is None:
        return Severity.INFO
    return Severity.HIGH if days_left <= STRUCTURAL_NEAR_DAYS else Severity.MEDIUM


def structural_severity_backup_disabled(service: str) -> Severity:
    """备份未开启。ElastiCache 比 RDS 低一档。

    理由是**数据的性质不同**：ElastiCache 多数是缓存，丢了能重建；
    RDS 是主数据源，没有备份意味着任何误删都不可恢复。
    """
    return Severity.MEDIUM if service == "elasticache" else Severity.HIGH


def structural_severity_no_read_replica() -> Severity:
    """无只读副本。只对 `read_replica_required_tiers` 报（调用方已过滤）。

    ElastiCache 上这是**根因级**的 —— 没有副本就无法开 Multi-AZ，
    所以它同时否决了另一条建议，不是一个独立的小提示。
    """
    return Severity.HIGH


def _is_noeviction(attrs: ResourceAttrs) -> bool:
    """`maxmemory-policy` 是否为 noeviction（R7.4）。

    ⚠️ AWS 侧的取值用连字符（`noeviction` / `volatile-lru` / `allkeys-lru`），
    大小写与前后空白都见过，所以归一后比较。
    """
    policy = (attrs.maxmemory_policy or "").strip().lower()
    return policy == "noeviction"


# ---------------------------------------------------------------------------
# 元断言（给测试用，也可在启动时自检）
# ---------------------------------------------------------------------------


def assert_tables_consistent() -> None:
    """MTTR 表与阈值指标表必须对得上，PROD_TIERS 与结构性规则那侧也要一致。

    ⚠️ 这两处不一致的后果都是**静默降级**：
    ```
    指标没登记 MTTR      → mttr_days=0 → 永远命中不了「≤0.35 且 MTTR≥5」那条
                           → 该指标的 HIGH 档少了一半判据
    PROD_TIERS 分叉      → 同一台实例在结构性规则里算生产、在分级里算非生产
                           → CRITICAL 档静默失效
    ```
    """
    from inspection.domain import thresholds
    from inspection.domain.dto import StructuralRuleConfig

    missing = sorted(set(thresholds.THRESHOLD_METRICS) - set(METRIC_FIX_ACTION))
    if missing:
        raise AssertionError(
            f"判定指标 {missing} 没有登记 MTTR（METRIC_FIX_ACTION）。"
            "mttr_days 会返回 0，于是 R7.2a 的第二条判据"
            "「headroom ≤ 0.35 且 MTTR ≥ 5」对它永不成立 —— "
            "该指标的 HIGH 档少了一半判据，且不报错"
        )
    extra = sorted(set(METRIC_FIX_ACTION) - set(thresholds.THRESHOLD_METRICS))
    if extra:
        raise AssertionError(
            f"METRIC_FIX_ACTION 里的 {extra} 不是判定指标 —— "
            "要么拼错了，要么该指标已从 THRESHOLD_METRICS 移除但这里忘了删"
        )
    if PROD_TIERS != StructuralRuleConfig().prod_tiers:
        raise AssertionError(
            f"PROD_TIERS {sorted(PROD_TIERS)} 与 "
            f"StructuralRuleConfig.prod_tiers "
            f"{sorted(StructuralRuleConfig().prod_tiers)} 不一致 —— "
            "同一台实例会在结构性规则里算生产、在分级里算非生产"
        )
    for action in FixAction:
        if action not in MTTR_TABLE:
            raise AssertionError(
                f"FixAction.{action.name} 没有 MTTR 条目 —— "
                "取它会抛 KeyError，而调用点在 severity 计算里"
            )
