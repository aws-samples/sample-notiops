"""DA 额度节奏与降级档位（R12.1 / R12.2）。

## 为什么判据是「节奏」而不是「用量比例」

credits 由上月 support 费按固定比例生成（Enterprise Support 为 75%），
按 `$0.498/agent-minute` 折算，**月底清零、不结转**。
所以「省着用」不是节约而是**浪费已付的钱** —— 目标是月底刚好用满。

```
错的判据   用量 > 80% → 只对 CRITICAL 调 DA
           月份第 28 天用掉 80% 恰好是健康节奏（pace ≈ 0.86）
           → 在最该用的时候把系统掐停，剩下 20% 月底清零
           反过来第 3 天用掉 30%（pace = 3.0）才真需要刹车，而 30% < 80% 不触发

对的判据   pace = 已用比例 ÷ 当月已过比例
           pace ≈ 1.0  正好按节奏
           pace < 0.8  用得太慢 → **主动放宽**（把 MEDIUM 也送去判读）
           pace > 1.2  用得太快 → 只对 HIGH 以上
           pace > 1.5  严重超前 → 只对 CRITICAL
```

## 数据源（2026-08-19 实测确认）

```
CloudWatch  AWS/AIDevOps · ConsumedInvestigationTime · 维度 AgentSpaceUUID
单位        Seconds
统计量      Sum（累计用量）。⚠️ Maximum 是「单次调查最长耗时」，不是用量
```

⚠️ 本账号有**两个** agent space（排障 + 巡检，R12.5c），pace 要**跨两个求和**。
只读巡检那个会把 pace 系统性低估 → 一直判「用得太慢」→ 一直放宽 →
月中就把额度打光。
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass
from datetime import date
from enum import Enum

from inspection.domain.dto import Severity

SECONDS_PER_AGENT_MINUTE = 60.0
USD_PER_AGENT_MINUTE = 0.498
"""官方定价（$0.0083/agent-second）。用于把用量折算成金额做展示。"""

PACE_SLOW = 0.8
PACE_FAST = 1.1
PACE_CRITICAL_ONLY = 1.5
"""pace 的三条分界线。

⚠️ **requirements R12.2 与设计原本不一致**，我一度在这里写
「与 R12.2 同一份数值」—— 那句是错的：

```
              requirements R12.2      设计
正常上界      pace ≤ 1.1              pace ≤ 1.2
减速档动作    top-N **砍半**，         只对 HIGH 以上调 DA
              优先 CRITICAL / HIGH
耗尽          已用 ≥ 100% → degraded  用量 ≥ 98% → degraded
```

取 requirements 的口径（它是 SHALL 文档，design 是它的展开），
并把设计一并改成 1.1，让两侧不再分叉。

⚠️ 更要紧的是**减速档的动作**：只按 design 实现「只对 HIGH 以上」会让
`Tier.HIGH_ONLY` 与 `Tier.NORMAL` 的放行集合完全相同（两者 `min_severity`
都是 HIGH）—— 于是这一档算出来了、记了日志、**对派发毫无影响**。
真正的减速手段是 `top_n_multiplier`，见下。
"""

EXHAUSTED_RATIO = 1.0
"""已用比例达到它 → 纯规则报告并标 `degraded`（此后是真实付费）。

⚠️ requirements 写 100%，design 写 98%。取 100%：
98% 会让每月最后那 2% 额度永远用不掉，而 R12.0 的目标恰恰是用满。
超出部分是真实付费，但「刚好超一点」的成本远小于「每月扔掉 2%」。
"""


class Tier(str, Enum):
    """本轮的派发档位。

    ⚠️ 每一档都要在**两个维度**上有区别，否则它就是个装饰：
    `min_severity`（派哪些级别）与 `top_n_multiplier`（派几条）。
    `NORMAL` 与 `HIGH_ONLY` 的 `min_severity` 相同 —— 区别全在后者。
    """

    RELAXED = "relaxed"
    """用得太慢 → 把 MEDIUM 也送去判读，月末还剩很多就把 INFO 批量补送。"""
    NORMAL = "normal"
    HIGH_ONLY = "high_only"
    """R12.2 的「减速」档：**top-N 砍半**，优先 CRITICAL / HIGH。"""
    CRITICAL_ONLY = "critical_only"
    DEGRADED = "degraded"
    """额度已用尽（≥100%）→ 纯规则报告，一条都不调 DA。

    ⚠️ 与 `CRITICAL_ONLY` 的区别是**真的一条都不派**。
    报告必须标 `degraded` —— 客户看到「没有 AI 分析」时要能知道是额度用尽，
    而不是系统坏了。
    """

    @property
    def min_severity(self) -> Severity:
        """本档位最低派发到哪一级。"""
        return {
            Tier.RELAXED: Severity.MEDIUM,
            Tier.NORMAL: Severity.HIGH,
            Tier.HIGH_ONLY: Severity.HIGH,
            Tier.CRITICAL_ONLY: Severity.CRITICAL,
            Tier.DEGRADED: Severity.CRITICAL,
        }[self]

    @property
    def top_n_multiplier(self) -> float:
        """对每轮派发上限（top-N）的系数（R12.2）。

        ⚠️ 这是「减速」档**唯一**的实际手段。只改 `min_severity` 的话
        `HIGH_ONLY` 与 `NORMAL` 完全等价，那一档就白算了。
        """
        return {
            Tier.RELAXED: 1.5,        # 额度用不完，反向放宽
            Tier.NORMAL: 1.0,
            Tier.HIGH_ONLY: 0.5,      # R12.2：top-N 砍半
            Tier.CRITICAL_ONLY: 0.5,
            Tier.DEGRADED: 0.0,       # 一条都不派
        }[self]

    @property
    def dispatches_at_all(self) -> bool:
        return self is not Tier.DEGRADED

    def allows(self, sev: Severity) -> bool:
        """`sev` 在本档位下是否该派发。`order` 越小越严重。"""
        if self is Tier.DEGRADED:
            return False
        return sev.order <= self.min_severity.order

    def top_n(self, base: int) -> int:
        """本档位下的实际派发上限。

        ⚠️ 向下取整但**至少 1**（除 DEGRADED）：`base=1` 砍半后取 0
        会让减速档变成「一条都不派」，那是 `CRITICAL_ONLY` 之上的第五档，
        不是 R12.2 说的「砍半」。
        """
        if self is Tier.DEGRADED:
            return 0
        return max(1, int(base * self.top_n_multiplier))


def month_elapsed_ratio(today: date) -> float:
    """当月已过比例。**含当天** —— 月初第 1 天算 1/31 而不是 0。

    ⚠️ 不含当天会让月初第一天的分母为 0 → 除零，或 pace 无穷大 →
    第一天就判「严重超前」把系统掐停。
    """
    days_in_month = calendar.monthrange(today.year, today.month)[1]
    return today.day / days_in_month


@dataclass(frozen=True)
class BudgetState:
    """本轮的额度状态。"""

    consumed_seconds: float
    monthly_limit_seconds: float
    today: date

    @property
    def used_ratio(self) -> float:
        """已用比例。limit ≤ 0 时返回 0（未知额度不该触发刹车）。

        ⚠️ 返回 0 而不是 1：`GetAccountUsage` 实测 `limit=-1`（无上限），
        把它当成「已用 100%」会让每一轮都判 CRITICAL_ONLY —— 而那等于
        一条都不派（`compute_severity` 之前全仓产不出 CRITICAL 的那个坑）。
        """
        if self.monthly_limit_seconds <= 0:
            return 0.0
        return self.consumed_seconds / self.monthly_limit_seconds

    @property
    def pace(self) -> float:
        """消耗节奏 = 已用比例 ÷ 当月已过比例。"""
        elapsed = month_elapsed_ratio(self.today)
        if elapsed <= 0:      # 不可能（day ≥ 1），防御性
            return 0.0
        return self.used_ratio / elapsed

    @property
    def tier(self) -> Tier:
        """本轮档位（R12.2）。

        ⚠️ 额度未知（limit ≤ 0）时返回 `NORMAL`，**不是** `CRITICAL_ONLY`。
        未知不等于耗尽 —— 实测 `GetAccountUsage` 对本账号返回 `limit=-1`，
        按耗尽处理会让整套系统在正常账号上一条都不派。
        """
        if self.monthly_limit_seconds <= 0:
            return Tier.NORMAL
        # ⚠️ 耗尽判据在 pace 之前：已用 100% 时 pace 可能仍然「正常」
        #    （月末用满恰恰是目标），但那时**不能再派** —— 超出的是真实付费。
        if self.used_ratio >= EXHAUSTED_RATIO:
            return Tier.DEGRADED
        p = self.pace
        if p > PACE_CRITICAL_ONLY:
            return Tier.CRITICAL_ONLY
        if p > PACE_FAST:
            return Tier.HIGH_ONLY
        if p < PACE_SLOW:
            return Tier.RELAXED
        return Tier.NORMAL

    @property
    def consumed_usd(self) -> float:
        return self.consumed_seconds / SECONDS_PER_AGENT_MINUTE * USD_PER_AGENT_MINUTE


def combine_agent_spaces(consumed_by_space: dict[str, float]) -> float:
    """把多个 agent space 的用量求和（R12.5c 的必要配套）。

    ⚠️ **必须跨两个 space 求和。** CloudWatch 的维度是 `AgentSpaceUUID`，
    一个 space 一条曲线。本账号有排障 + 巡检两个 space；
    只读巡检那个会把 pace 系统性低估 → 一直判「用得太慢」→ 一直放宽派发 →
    月中就把额度打光。而分母（credits）是**账号级**的
    （`GetAccountUsage` 返回 `monthlyAccountInvestigationHours`）。
    """
    return float(sum(consumed_by_space.values()))
