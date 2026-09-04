"""调度判定（R11.1 / R11.1a）。

## 为什么调度判定要做成纯函数

一条固定的 EventBridge Rule 每 15 分钟触发一次，调度器读 DDB 的定时配置决定
「这一 tick 该跑哪些（类型 × 账号）」。这个判断有四种错法，全都不报错：

```
① 一天跑两次      窗口判断写成「当前时刻 >= 配置时刻」→ 之后每个 tick 都成立
② 一天都不跑      写成「当前时刻 == 配置时刻」→ tick 落在 02:00:03 就错过
③ 跨天漏跑        UTC 与本地时区混用 → 客户配 09:00 却在 UTC 09:00 跑
④ 补跑风暴        Lambda 挂了两小时后恢复 → 一次性把错过的 8 个 tick 全跑
```

②③④ 的共同点是**表现为「没跑」或「跑太多」**，而 run 记录看起来正常。

## 判据

```
该跑  = 配置时刻落在 [本 tick 起点, 本 tick 起点 + 周期) 内
      且 今天这个 (类型, 账号) 还没有成功的 run 记录
```

第二个条件让「补跑」自然发生（Lambda 挂了下一 tick 会接着跑），
同时避免风暴（一天最多一次）。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from enum import Enum

TICK_MINUTES = 15
"""EventBridge Rule 的周期（R11.1a）。

⚠️ 它同时是**调度粒度**：配置里写 `02:07` 只能落到某个 15 分钟的桶里。
UI SHALL 限制成 15 分钟整数倍，SHALL NOT 让客户填一个永远不会被精确命中的时间
—— 那种配置不会报错，只是「说好 02:07 跑」而实际 02:00 就跑了。
"""


class RunType(str, Enum):
    """两类独立的巡检轮次（R11.1：按类型全局配置，不按账号）。

    ⚠️ 两者是**独立 run**，各自派 task、各自一份排除清单。
    同一台实例在两轮都被报是正常且有价值的：
    「没人用」+「盘快满」→ 结论是直接删，不是给没人用的库扩容。
    """

    HIGH = "high"
    """高负载（R2.1 阈值 + R2.6 慢性）。"""
    IDLE = "idle"
    """闲置与成本（R2.2 + R2.4 结构性）。"""


class RunStatus(str, Enum):
    """run 记录的状态（的四态）。

    ⚠️ **单一来源。** 这四个字符串同时被三处用到：
    `due_runs()` 判「今天跑过没」、`store.try_acquire_run_lock()` 的条件表达式、
    看板的完成度统计。分散成两份常量不会报错 —— 只会让锁认 `completed`
    而调度认 `success`，于是同一天被判成「还没跑」反复重跑。

    ⚠️ 是 `SUCCESS` 而不是 `COMPLETED`：设计写的是
    `status: running | success | partial | failed`，改词等于改契约。
    """

    RUNNING = "running"
    SUCCESS = "success"
    PARTIAL = "partial"
    """部分指标缺口但仍出了报告（R9.2）。**不阻止重跑**。"""
    FAILED = "failed"
    """**不阻止重跑** —— 那正是补跑要覆盖的情形。"""


BLOCKING_STATUSES = frozenset({RunStatus.RUNNING.value, RunStatus.SUCCESS.value})
"""这两种状态下今天不再重复派发。

`partial` / `failed` 故意不在内 —— 它们是「该补跑」的信号。
"""


@dataclass(frozen=True)
class ScheduleConfig:
    """一种巡检类型的定时配置（存 DDB，客户可改）。

    ⚠️ 时刻一律 **UTC**。存本地时区会让「客户改了时区偏好」变成一次静默的
    调度平移 —— 而调度平移的表现是某天跑了两次或一次没跑。
    UI 负责在展示层做时区换算。
    """

    run_type: RunType
    enabled: bool = True
    at_utc: time = time(2, 0)
    """当天的触发时刻（UTC）。"""
    weekdays: frozenset[int] | None = None
    """限定星期（`date.isoweekday()`，1=周一）。`None` = 每天。

    R11.5 的慢车道（每周一次）用它。
    """

    catch_up_hours: int = 6
    """★ 错过后允许在多少小时内补跑。0 = 不补跑。

    ⚠️ **这一档 spec 里原本没有，是实现时发现的真缺口。** 只按
    「配置时刻是否落在本 tick 窗口内」判，会出现：

    ```
    02:00 该跑 → 那一刻 Lambda 冷启动超时 / 限流 / 账号 Role 临时失效
    02:15 恢复 → 配置时刻 02:00 已不在窗口内 → 判「不该跑」
    ⇒ 那一整天没有巡检数据，而 run 记录里连一条 failed 都没有
      （压根没启动过）→ 对账（R13.13）扫不到「缺账号行」以外的任何线索
    ```

    补跑窗口让下一个 tick 接着跑，而「今天已有 running/success 记录就跳过」
    自然避免了风暴 —— 挂 2 小时恢复后只补一次，不是把 8 个 tick 全跑。

    ⚠️ 取 6 小时而不是 24：跨过太久的补跑意义有限（数据窗口是到昨天为止的
    完整日，补跑拿到的是同一份数据），但会让「昨天的报告今天早上才出来」
    这种客户可感知的异常变得常态化。6 小时覆盖绝大多数瞬时故障。
    """

    def matches_day(self, d: date) -> bool:
        return self.weekdays is None or d.isoweekday() in self.weekdays


@dataclass(frozen=True)
class TickWindow:
    """一次 tick 覆盖的时间窗 `[start, start + TICK_MINUTES)`。"""

    start: datetime
    minutes: int = TICK_MINUTES

    @property
    def end(self) -> datetime:
        return self.start + timedelta(minutes=self.minutes)

    @property
    def run_date(self) -> date:
        """这一 tick 属于哪一天（UTC）。"""
        return self.start.date()

    def contains_time(self, t: time) -> bool:
        """配置时刻是否落在本窗口内。**左闭右开。**

        ⚠️ 左闭右开而不是双闭：双闭会让恰好等于 `end` 的时刻在**两个** tick
        里都成立 → 一天跑两次。而两次的第二次会因为 run 锁被拒（看起来正常），
        于是这个 bug 只在锁失效时才显形。
        """
        moment = datetime.combine(self.start.date(), t, tzinfo=self.start.tzinfo)
        return self.start <= moment < self.end

    def hours_since(self, t: time) -> float | None:
        """配置时刻已过去多少小时。`None` = 还没到（配置时刻在本窗口之后）。

        用于补跑判定：`0 <= hours_since <= catch_up_hours` 即可补。
        """
        moment = datetime.combine(self.start.date(), t, tzinfo=self.start.tzinfo)
        if moment > self.start:
            return None
        return (self.start - moment).total_seconds() / 3600.0


def tick_window_for(now: datetime, minutes: int = TICK_MINUTES) -> TickWindow:
    """把任意时刻归一到它所属的 tick 窗口起点。

    ⚠️ `now` 由入参传入（R14.2）。函数内取当前时间会让「tick 边界」永远测不到。
    ⚠️ 必须带 tzinfo：naive datetime 与 aware 的比较会抛 TypeError，
    而那个异常发生在调度器里 = 整轮巡检不跑。
    """
    if now.tzinfo is None:
        raise ValueError("now 必须带时区（UTC）—— naive datetime 会让比较抛 TypeError")
    floored_minute = (now.minute // minutes) * minutes
    return TickWindow(now.replace(minute=floored_minute, second=0, microsecond=0),
                      minutes)


@dataclass(frozen=True)
class DueRun:
    """本 tick 该跑的一个 (类型, 账号)。"""

    run_type: RunType
    account_id: str
    run_date: date
    catch_up: bool = False
    """这一次是补跑（错过了原定时刻）。

    ⚠️ 要落进 run 记录：「今天的报告为什么晚了 2 小时」只能靠它回答。
    不记录会让补跑与正常跑在事后完全无法区分。
    """


def due_runs(
    *,
    now: datetime,
    configs: Sequence[ScheduleConfig],
    accounts: Sequence[str],
    completed: Mapping[tuple[str, str, date], str] | None = None,
    tick_minutes: int = TICK_MINUTES,
) -> list[DueRun]:
    """本 tick 该跑哪些 (类型 × 账号)。

    Args:
        now: 当前时刻（**必须带 UTC 时区**）。
        configs: 每种类型一份定时配置。
        accounts: 已启用的账号（取自 `da#<account>` 的 `enabled`）。
        completed: 已有的 run 记录 `{(type, account, date): status}`。
            `status` ∈ {running, success, partial, failed}。
        tick_minutes: tick 周期。

    Returns:
        按 (类型, 账号) 排序的列表 —— R14 要求同输入同输出。

    ```
    该跑 = 配置时刻落在本 tick 窗口内
         且 今天这个 (类型, 账号) 还没有 running / success 的 run 记录
    ```

    ⚠️ `failed` 与 `partial` **不**阻止重跑 —— 那正是「补跑」要覆盖的情形。
    而 `running` 阻止重跑，避免两个 tick 撞在一起（真正的互斥靠 DDB 条件写，
    这里只是先省一次无用的 fan-out）。
    """
    window = tick_window_for(now, tick_minutes)
    done = completed or {}
    out: list[DueRun] = []

    for cfg in configs:
        if not cfg.enabled:
            continue
        if not cfg.matches_day(window.run_date):
            continue

        on_time = window.contains_time(cfg.at_utc)
        # 补跑：配置时刻已过，但还在 catch_up_hours 内。
        # ⚠️ 「今天已有 running/success 就跳过」在下面 —— 那一条让补跑
        # 天然不风暴（挂 2 小时恢复后只补一次，而不是把 8 个 tick 全跑）。
        elapsed = window.hours_since(cfg.at_utc)
        catch_up = (
            not on_time
            and cfg.catch_up_hours > 0
            and elapsed is not None
            and 0 < elapsed <= cfg.catch_up_hours
        )
        if not on_time and not catch_up:
            continue

        for acct in accounts:
            status = done.get((cfg.run_type.value, acct, window.run_date), "")
            if status in BLOCKING_STATUSES:
                continue
            out.append(DueRun(cfg.run_type, acct, window.run_date,
                              catch_up=catch_up))

    out.sort(key=lambda r: (r.run_type.value, r.account_id))
    return out


# ---------------------------------------------------------------------------
# 手动触发的两个正交维度（R11.4）
# ---------------------------------------------------------------------------


class DataSource(str, Enum):
    """数据来源。**与 `RunMode` 正交** —— 合成一个开关就表达不了四种组合。"""

    REUSE = "reuse"
    """复用最近一轮已采集的指标。秒级返回、零 CloudWatch 成本。"""
    REFETCH = "refetch"
    """重新拉取。分钟级、按请求指标数计费。"""


class RunMode(str, Enum):
    """结果去向。"""

    DRY_RUN = "dry_run"
    """只出报告，不推进 finding 状态机、不推送。"""
    OFFICIAL = "official"
    """推进状态机、参与 resolved 判定、进推送。"""


@dataclass(frozen=True)
class ManualTrigger:
    """一次手动触发（R11.3 / R11.4）。

    四种组合都有真实用途：
    ```
    reuse   + dry_run    改了阈值先看看会报出什么      ← 最常用
    reuse   + official   确认新阈值没问题，正式跑一轮
    refetch + dry_run    怀疑指标本身有问题，重新取来看
    refetch + official   补一轮漏掉的（调度那天 Lambda 挂了）
    ```
    """

    run_type: RunType
    account_ids: tuple[str, ...]
    source: DataSource = DataSource.REUSE
    mode: RunMode = RunMode.DRY_RUN
    requested_by: str = ""

    @property
    def dry_run(self) -> bool:
        return self.mode is RunMode.DRY_RUN


class ReuseUnavailable(RuntimeError):
    """`reuse` 找不到可复用批次（R11.4b）。

    ⚠️ **明确失败，SHALL NOT 静默降级成 `refetch`。** 静默降级会让客户
    以为「点一下很快」，结果跑了几分钟并产生 CloudWatch 费用。
    """

    def __init__(self, message: str, *, latest: date | None = None):
        super().__init__(message)
        self.latest = latest


def resolve_reuse_date(
    *,
    available: Iterable[date],
    today: date,
    max_age_days: int = 7,
) -> date:
    """`reuse` 时用哪一天的数据（R11.4a）。

    Returns:
        被复用批次的**真实日期**。

    Raises:
        ReuseUnavailable: 没有可复用批次，或最新那批太旧。

    ⚠️ **返回真实日期，绝不返回 today。** 写成 today 的后果：
    ```
    报告声称「今天的数据」，而数据其实是 3 天前的
    更糟：finding 的 consecutive_high_days 会凭空 +1
          （同一批数据被当成新的一天算了两次）
          → 慢性高位判定（R2.6，coverage≥7）被反复 reuse 污染
    ```
    ⚠️ `dry_run` **不能**替代这条约束 —— 它只是不写状态机，
    报告上的日期照样展示给客户。
    """
    dates = sorted(available)
    if not dates:
        raise ReuseUnavailable(
            "没有可复用的采集批次。请改用 refetch 重新采集 —— "
            "这里不静默降级，因为重采需要几分钟并产生 CloudWatch 费用"
        )
    latest = dates[-1]
    age = (today - latest).days
    if age > max_age_days:
        raise ReuseUnavailable(
            f"最新可复用批次是 {latest.isoformat()}（{age} 天前），"
            f"超过 {max_age_days} 天。请确认是否仍要复用，或改用 refetch",
            latest=latest,
        )
    return latest
