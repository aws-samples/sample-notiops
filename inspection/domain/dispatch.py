"""复合优先级排序与配额限流（R12.6 / R12.6a）。

派发量经四层收敛，顺序固定（R12.6a）：

```
① rollup        集群 / 副本组算 1 个判定单位   1000 实例 → 约 375 单位
② 命中过滤      未命中规则的不派发             高负载 ~3% ｜ 闲置 ~15%
③ top-N 截断    每账号每轮上限，超限的**留到下一轮**，不丢弃
④ 三重配额      每账号 / 全局 / 每(账号,指标)
```

本模块做 ③④。① 在 `domain/rollup.py`，② 在各规则自己。

## 复合优先级（R12.6）

```
排序键 = (severity 档位, headroom 升序, idle_score 降序, instance_id)
```

⚠️ **SHALL NOT 只按单一指标排序。** 只按 severity 会让同为 HIGH 的 20 条
按字典序取前 5 —— 于是 `a-prod-db` 永远被分析、`z-prod-db` 永远排不上，
而两者可能一个还有 60% 余量、一个只剩 5%。

⚠️ `instance_id` 是**最后**的决胜键，不是可省的。少了它两条各项都相同的
finding 顺序取决于 dict 遍历，R14「同输入同输出」就守不住 ——
而那会让「昨天分析了 A 今天分析了 B」看起来像系统在随机挑。

## 三重配额（requirements 配置表）

```
da_calls_per_run_per_account_max   5    单账号单轮
da_calls_per_run_global_max        8    全局单轮（**从不 binding**，见 GLOBAL_MAX）
                                        ⚠️ 这里原写「受 custom agent 并发=1 约束」
                                        是错的：INVESTIGATION 吃的是
                                        concurrent-investigations-per-agent-space
                                        （L-1553F789，默认 3，**可调**）
da_calls_per_account_metric_max    2    单账号单指标
```

⚠️ 三条**同时**生效，且缺任何一条都有具体后果：

```
缺 per_account   一个大账号吃光全局 8 条，其余账号整轮零分析
缺 global        10 个账号 × 5 条 = 50 条同时在飞，而并发位只有 3 个
                 → 47 条排队，客户在 IM 里点「深度调查」排在它们之后 =「卡住」
缺 account_metric 同一账号 20 台库都是 FreeableMemory 越线 → 5 条全给同一指标，
                 而它们的判读结论逐字相同（这正是 Fingerprint 要解决的）
```
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace

from inspection.domain.budget import Tier
from inspection.domain.dto import Severity

MAX_DISPATCH_PER_RUN = 20
"""R12.6a ③ 的 top-N 默认值（每账号每轮）。会被 `Tier.top_n()` 缩放。"""

PER_ACCOUNT_MAX = 5
"""`da_calls_per_run_per_account_max`。"""

GLOBAL_MAX = 8
"""`da_calls_per_run_global_max`。

⚠️ 取 8 的理由是「别派超过并发位数太多」：派超了只会让它们排队，而排队的
代价是**客户的交互式深度调查排在巡检后面** —— 界面上就是「卡住不动」。

🔴 这个名字是错的，而且这条上限**从来不 binding**：
   ① `plan_dispatch` 在 `_assemble_and_dispatch` 里，而那个函数**每个账号跑
      一次**（一条 SQS 消息 = 一个账号）→ 它拦不住跨账号的爆量
   ② 单账号调用下所有候选同一个 `account_id` → `PER_ACCOUNT_MAX`（5）先撞上
   ⇒ 每账号每轮的真实上限是 **5**，不是 8。

⚠️ 2026-08-29 核过配额：`CreateBacklogTask(taskType="INVESTIGATION")` 吃的是
   **Concurrent investigations per agent space（默认 3，可调）**，不是
   「Concurrent invocations per custom agent（1，不可调）」。这段注释此前
   写的是后者。数字变大且可调，但结论不变 —— 8 或 5 都远超 3 个并发位。
"""

PER_ACCOUNT_METRIC_MAX = 2
"""`da_calls_per_account_metric_max`。"""


@dataclass(frozen=True)
class Candidate:
    """一个待派发单位（rollup 之后的判定单位，不一定是单实例）。"""

    account_id: str
    instance_id: str
    metric: str
    severity: Severity
    headroom: float | None = None
    """余量比例（0.05 = 只剩 5%）。**越小越急**。None 表示不适用。"""
    idle_score: float | None = None
    """闲置分。**越大越该处理**。None 表示不适用。"""
    is_rollup: bool = False
    """是否是集群层合并单位（R12.6a ①）。"""
    member_count: int = 1
    """这个单位覆盖几台实例。用于报告说明「1 条结论覆盖 6 台」。"""
    deferred_runs: int = 0
    """已经被延后过几轮（R12.6a ③ 的「留到下一轮」）。

    ⚠️ **这个字段让 carry-over 从口号变成机制。** 没有它会出现系统性饿死：
    `global_max=8` 而 `per_account_max=5` 时，两个账号就能吃光全局配额；
    而排序在各项相同时由 `instance_id` 决胜 —— 于是**每天都是同样那两个账号**
    赢，账号 C~J 恒零分析。这不是随机不公平，是确定性饿死，
    而看板上每个账号都显示「本轮 0 条待分析」（因为它们确实没被派）。

    调用方必须把 `deferred` 持久化并在下一轮把 `deferred_runs` 加一。
    """

    @property
    def sort_key(self) -> tuple[int, float, float, int, str, str]:
        """复合优先级（R12.6）。全部转成「越小越优先」。

        ```
        ① severity 档位        最急的先来
        ② headroom 升序        同级里余量少的先
        ③ idle_score 降序      闲置分高的先
        ④ deferred_runs 降序   等得久的先  ← 防饿死
        ⑤ instance_id / metric 决胜，保证 R14 可重放
        ```

        ⚠️ `headroom` 缺失时取 `1.0`（当成余量充足）而不是 `0.0`。
        取 0 会让所有「没有余量概念」的 finding（如结构性 EOL）
        全部插到最前面，把真正快满的实例挤出 top-N。

        ⚠️ `deferred_runs` 放在**第四位而不是第一位**：放最前会让一条
        等了三轮的 MEDIUM 插到新出现的 CRITICAL 前面 —— 紧急度必须先赢。
        放在这里意味着「同样紧急时，等久的先」，既防饿死又不倒置优先级。

        ⚠️ `instance_id` 是**最后**的决胜键，不是可省的。少了它两条各项都相同的
        finding 顺序取决于 dict 遍历，R14「同输入同输出」就守不住 ——
        而那会让「昨天分析了 A 今天分析了 B」看起来像系统在随机挑。
        """
        return (
            self.severity.order,
            1.0 if self.headroom is None else self.headroom,
            -(self.idle_score or 0.0),
            -self.deferred_runs,
            self.instance_id,
            self.metric,
        )


@dataclass(frozen=True)
class DispatchPlan:
    """本轮的派发计划。"""

    dispatch: tuple[Candidate, ...]
    deferred: tuple[Candidate, ...]
    """被 top-N 或配额挡下的。**留到下一轮，不丢弃**（R12.6a ③ 原文）。"""
    truncated_by: Mapping[str, int] = field(default_factory=dict)
    """各判据各挡下了多少条。写进 run 记录（R12.6 要求「被截断数量」）。

    ⚠️ 不记这个的话「今天为什么只分析了 3 条」在事后无法回答 ——
    是没命中、被额度挡了、还是被配额挡了，三者的处理完全不同。
    """

    @property
    def deferred_count(self) -> int:
        return len(self.deferred)


def rank(candidates: Iterable[Candidate]) -> list[Candidate]:
    """按复合优先级排序（R12.6）。"""
    return sorted(candidates, key=lambda c: c.sort_key)


def plan_dispatch(
    candidates: Iterable[Candidate],
    *,
    tier: Tier,
    base_top_n: int = MAX_DISPATCH_PER_RUN,
    per_account_max: int = PER_ACCOUNT_MAX,
    global_max: int = GLOBAL_MAX,
    per_account_metric_max: int = PER_ACCOUNT_METRIC_MAX,
) -> DispatchPlan:
    """排序 → 档位过滤 → top-N → 三重配额。

    ⚠️ 顺序不能换：先排序再截断。反过来（先截断再排序）会让 top-N 取到的
    是任意 N 条然后把它们排好序 —— 看起来完全正常，而最急的那条可能不在里面。
    """
    ranked = rank(candidates)
    truncated: dict[str, int] = {}

    def bump(key: str) -> None:
        truncated[key] = truncated.get(key, 0) + 1

    # ── 档位过滤（R12.2）
    allowed: list[Candidate] = []
    for c in ranked:
        if not tier.allows(c.severity):
            bump("tier")
            continue
        allowed.append(c)

    top_n = tier.top_n(base_top_n)

    dispatch: list[Candidate] = []
    deferred: list[Candidate] = []
    per_account: dict[str, int] = {}
    per_account_metric: dict[tuple[str, str], int] = {}

    for c in allowed:
        if len(dispatch) >= global_max:
            bump("global_max")
            deferred.append(c)
            continue
        if per_account.get(c.account_id, 0) >= top_n:
            bump("top_n")
            deferred.append(c)
            continue
        if per_account.get(c.account_id, 0) >= per_account_max:
            bump("per_account_max")
            deferred.append(c)
            continue
        key = (c.account_id, c.metric)
        if per_account_metric.get(key, 0) >= per_account_metric_max:
            bump("per_account_metric_max")
            deferred.append(c)
            continue
        dispatch.append(c)
        per_account[c.account_id] = per_account.get(c.account_id, 0) + 1
        per_account_metric[key] = per_account_metric.get(key, 0) + 1

    # 被 tier 挡下的**不进 deferred**：它们不是「排不上」而是「本轮不该派」。
    # 混进去会让下一轮以为有一堆积压，而 tier 恢复后它们本来就会重新被评估。
    return DispatchPlan(
        dispatch=tuple(dispatch),
        deferred=tuple(deferred),
        truncated_by=dict(sorted(truncated.items())),
    )


def carry_over(deferred: Iterable[Candidate]) -> list[Candidate]:
    """把上一轮延后的候选带到下一轮，`deferred_runs` 加一（R12.6a ③）。

    ⚠️ **不调这个函数，carry-over 就只是个字段名。** `plan_dispatch()` 返回
    `deferred` 之后没人管的话，下一轮这些候选会以 `deferred_runs=0` 重新出现，
    与新候选完全同权 —— 于是排序在各项相同时仍由 `instance_id` 决胜，
    同样那几个账号每天都赢，其余账号确定性饿死。
    """
    return [replace(c, deferred_runs=c.deferred_runs + 1) for c in deferred]
