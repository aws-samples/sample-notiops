"""推送策略：推什么、现在推不推（R11b.5~R11b.8）。

纯函数层。零 IO、零 boto3、零 `datetime.now()` —— `today` / `now` 一律入参。

```
insppush#<acct> 行 ──┐
inspfind#<acct> 行 ──┼─► select_for_target(target, …) ─► Selection
ChatTarget（accounts / severity_min / locale）           │  picked  → 要推的（已排序、已截断）
                                                        │  skipped → 逐条为什么没推
                                                        └  truncated → Top N 之外还有多少
```

## 三条节奏，不是一条（R11b.5）

```
CRITICAL   首次 + 退避重推 1 / 2 / 4 / 7 天，之后固定 7 天    ← 不是每天
HIGH       状态跃迁时推；无变化则最多 3 天一次
MEDIUM     不进每日推送，进周度摘要
INFO       只进看板，永不推 IM（R7.7）
```

⚠️ 「CRITICAL 每天重推」在一条挂 3 周的 finding 上会推 21 次，
第 3 次之后客户即免疫 —— 之后所有推送都被当成噪音，包括新出现的那些。

## 🔴 与 `lifecycle.Transition.pushable` 的关系：**互补，不是重复**

`pushable`（`lifecycle.py`）答的是「**发生了值得说的变化吗**」——
`CONFIRMED` / `WORSENED` / `RESOLVED` / `REOPENED` 四种跃迁，且排除 `new` 与
`INFO`。本模块答的是「**没变化的东西什么时候再说一次**」——
而那恰恰是 `pushable` 覆盖不到的：一条 CRITICAL 挂着三周，每天都是
`UNCHANGED`，`pushable` 恒 False，只靠它的话客户**第一天之后再也听不到**
这条 CRITICAL。R11b.5 的退避重推存在的全部意义就是接住这段。

## 结构性风险不进每日推送（R2.4.3 / 10.3c）

判据是 `rule` 段属于结构性/容量规则集。⚠️ `cadence: monthly` 这个标记
**没有落进 DDB**（只活在 `dto.Finding` 上，`_finding_to_item` 不写它），
所以推送侧只能按 rule 反查。有元断言钉住两侧的规则集合一致 ——
分叉的表现是「证书 30 天后过期」被塞进每日推送，天天推一个月。

## 周一：**标注**而不是顺延（R11b.8）

R11b.8 给了两个选项。选标注，因为顺延意味着周一的 CRITICAL 要等到周二
—— 而周末维护窗刚过正是最可能真出事的时候。标注的成本只是一句话，
收益是 on-call 知道「这批里有一部分可能是维护动作的余波」（R8.5）。

## ⚠️ 时刻一律 UTC

与 `schedule.ScheduleConfig` 同约定（那个 docstring 明写「存本地时区会让
客户改时区偏好变成一次静默的调度平移」）。`tz_label` 只用于报告里那句
「北京时间 11:00」的措辞，**不参与任何判定** —— 所以 Lambda 容器里有没有
IANA 时区库不影响推送是否发生。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from enum import Enum
from typing import Any, Iterable, Mapping, Sequence

from inspection.domain.dto import CapacityRule, Severity, StructuralRule
from inspection.domain.overview import DEFAULT_TOP_N, SEVERITY_ORDER

CRITICAL_BACKOFF_DAYS: tuple[int, ...] = (1, 2, 4, 7)
"""CRITICAL 的重推间隔（R11b.5）。用完之后**固定停在最后一档**。

⚠️ 不是「用完就不推了」：一条挂了两个月的 CRITICAL 仍然是 CRITICAL，
彻底停推等于把它从客户视野里删掉，而看板上它还在 —— 两边不一致时
客户会问「你们不是说会推吗」。
"""

HIGH_QUIET_DAYS = 3
"""HIGH 无变化时的最小重推间隔（R11b.5 写「2~3 天一次」）。

⚠️ 取上界 3 而不是 2。这个数字的方向是**越小越吵**，而 HIGH 的条数通常
是 CRITICAL 的十倍 —— 取 2 会让每周多出两轮 HIGH 全量重推。
真要更勤可以配，但默认值应当偏安静。
"""

WEEKLY_DIGEST_WEEKDAY = 2
"""周度摘要在**周二**（`isoweekday()`，1=周一）。

⚠️ 不放周一：R8.5 论证过企业维护窗集中在周末 → 周一整队列告警是 on-call
最忙的时刻，而 R11b.8 正是为此存在。在最忙的那天再叠一份周报，
表现是整份周报被划成「不用看」。
"""

MONTHLY_DIGEST_DAY = 1
"""结构性风险月度摘要在每月 1 号。

🔴 **SHALL NOT 改到 25 以上。** `_digest_due` 用 `today.replace(day=…)` 算锚点：
29/30/31 在 2 月抛 `ValueError`，而那个异常会穿过 `kinds_due` 冒泡到 handler
—— 那个月**连每日推送一起停**。26~28 则让顺延窗口（锚点 +6 天）跨月，
而「这个月发过没」的判据是同月比对，跨月那半段判错。
`_MAX_MONTHLY_DAY` 把这条固化成断言。
"""

_MAX_MONTHLY_DAY = 25
"""月度锚点日的上界。见 `MONTHLY_DIGEST_DAY`。"""

assert 1 <= MONTHLY_DIGEST_DAY <= _MAX_MONTHLY_DAY, (
    f"MONTHLY_DIGEST_DAY={MONTHLY_DIGEST_DAY} 超出 1~{_MAX_MONTHLY_DAY}："
    "29 以上会在 2 月让 replace(day=) 抛 ValueError 并拖停整个推送 Lambda；"
    "26~28 会让顺延窗口跨月而幂等判据是同月比对"
)

STRUCTURAL_RULES: frozenset[str] = frozenset(
    {r.value for r in StructuralRule} | {r.value for r in CapacityRule}
)
"""走月度摘要的规则码（R2.4.3 / 10.3c）。

⚠️ 容量超配（`oversized_*`）与结构性风险在 `assemble.structural_findings()`
里走**同一条**路径、同一个 `hit_reason`，所以推送侧也必须一起算 ——
只列 `StructuralRule` 会让「RDS 存储开太大」天天推。
"""


class PushKind(str, Enum):
    """一次推送的种类。**决定读哪些 finding、用哪套节奏。**"""

    DAILY = "daily"
    """每日：跃迁 + CRITICAL 退避 + HIGH 静默期到点。"""
    WEEKLY = "weekly"
    """周度「仍未关闭」摘要，含 MEDIUM（R11b.5 / 10.4）。"""
    MONTHLY = "monthly"
    """结构性风险月度摘要（R2.4.3 / 10.3c）。"""


class PushSkip(str, Enum):
    """没推的原因。**枚举而不是日志文本** —— 「今天为什么没推这条」
    是上线后第二高频的问题（第一是「这个群怎么没收到」，见
    `targets.RejectReason`）。枚举能计数、能进 run 记录、能在看板上显示。
    """

    INFO_NEVER_PUSHED = "info_never_pushed"
    BELOW_TARGET_FLOOR = "below_target_floor"
    ACCOUNT_NOT_VISIBLE = "account_not_visible"
    STATE_NOT_PUSHABLE = "state_not_pushable"
    STRUCTURAL_MONTHLY_ONLY = "structural_monthly_only"
    MEDIUM_WEEKLY_ONLY = "medium_weekly_only"
    BACKOFF_NOT_DUE = "backoff_not_due"
    ALREADY_PUSHED_TODAY = "already_pushed_today"
    RESOLVED_AND_ANNOUNCED = "resolved_and_announced"


_SKIP_TEXT_ZH: dict[PushSkip, str] = {
    PushSkip.INFO_NEVER_PUSHED: "INFO 只进看板，不推 IM（R7.7）",
    PushSkip.BELOW_TARGET_FLOOR: "低于该投递目标的 severity_min",
    PushSkip.ACCOUNT_NOT_VISIBLE: "该 chat 看不到这个账号",
    PushSkip.STATE_NOT_PUSHABLE: "尚未确认（new）或已关闭且已通报过",
    PushSkip.STRUCTURAL_MONTHLY_ONLY: "结构性风险走月度摘要",
    PushSkip.MEDIUM_WEEKLY_ONLY: "MEDIUM 走周度摘要",
    PushSkip.BACKOFF_NOT_DUE: "无变化且退避间隔还没到",
    PushSkip.ALREADY_PUSHED_TODAY: "今天已经推过",
    PushSkip.RESOLVED_AND_ANNOUNCED: "已关闭且缓解通报已发过",
}


def skip_text(reason: PushSkip) -> str:
    return _SKIP_TEXT_ZH.get(reason, reason.value)


# ---------------------------------------------------------------------------
# 推送窗口（R11b.6 / 10.3a）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PushWindow:
    """推送时段配置。存 DDB（`inspsched#config` / `SK="push"`）。

    ⚠️ `at_utc` 默认 03:00 = 巡检默认时刻（`ScheduleConfig.at_utc` 的
    02:00 UTC）**之后一小时**。取值必须晚于巡检 —— 早于它的表现是每天推
    的都是**前一天**的结论，而客户看到的日期是今天，于是「报告里的数字
    和看板不一样」。`has_run_today` 那道闸是兜底，这里是第一道。

    ⚠️ R11b.6 的「不在巡检 cron 完成的凌晨直接推」由三件事共同满足：
    独立 cron（不是巡检完成后顺手发）、可配时刻、只在工作日。
    """

    enabled: bool = True
    at_utc: time = time(3, 0)
    weekdays: frozenset[int] = frozenset({1, 2, 3, 4, 5})
    """工作日（`isoweekday()`，1=周一）。R11b.6 的「默认工作日」。"""
    window_minutes: int = 15
    """判定窗口宽度。与 EventBridge Rule 的周期一致。"""
    tz_label: str = "Asia/Shanghai"
    """**仅用于报告措辞**（「北京时间 11:00」），不参与任何判定。

    ⚠️ 刻意不做 IANA 时区换算：`schedule.ScheduleConfig` 的既有约定是
    「时刻一律 UTC，UI 负责展示层换算」。在这里引入 `zoneinfo` 会让推送
    是否发生取决于 Lambda 容器里有没有时区数据库，而那是一个**部署后才会
    显形**的依赖。
    """

    def matches_day(self, d: date) -> bool:
        return d.isoweekday() in self.weekdays


def in_push_window(now: datetime, cfg: PushWindow) -> bool:
    """现在是不是推送时刻。**左闭右开**，与 `schedule.TickWindow` 同语义。

    ⚠️ `now` 必须带时区。naive 与 aware 相比会抛 TypeError，
    而那个异常发生在推送 Lambda 里 = 当天一条都不推。
    """
    if now.tzinfo is None:
        raise ValueError("now 必须带时区（UTC）—— naive datetime 会让比较抛 TypeError")
    if not cfg.enabled or not cfg.matches_day(now.date()):
        return False
    start = datetime.combine(now.date(), cfg.at_utc, tzinfo=now.tzinfo)
    return start <= now < start + timedelta(minutes=max(1, cfg.window_minutes))


def kinds_due(
    now: datetime, cfg: PushWindow, *, last_digest: DigestLedger | None = None,
) -> tuple[PushKind, ...]:
    """本次窗口该发哪几种。**可以同时多种**（月初的周二）。

    ⚠️ 返回顺序即发送顺序，`DAILY` 在最前 —— 今天新出的 CRITICAL 要排在
    月度结构性摘要之前，否则客户先看到一屏「gp2 该换 gp3」。

    🔴 **摘要日落在非推送日时顺延到下一个推送日**（review 抓到的缺陷）。

    原实现是「先过 `in_push_window`（含 `weekdays`），再看今天是不是摘要日」
    —— 于是 1 号落周六/周日的月份，月度摘要**一条都不发**，2026 年有
    4 个月中招（2/3/8/11 月）。而结构性 finding 在每日推送里被
    `STRUCTURAL_MONTHLY_ONLY` 明确挡掉，月度是它**唯一**的出口：
    那个月客户对「证书 30 天后过期」「引擎已 EOL」完全无感知。

    周度同理 —— 默认 `WEEKLY_DIGEST_WEEKDAY=2` 落在工作日里所以安全，
    但运维把 `weekdays` 收窄成 `{1,3,5}` 就会让 MEDIUM 整档静默消失
    （它在每日推送里被 `MEDIUM_WEEKLY_ONLY` 挡掉）。

    `last_digest` 让顺延可判：没有它就无法区分「今天该补发」与
    「这个月已经发过了」。传 `None` 时退化成「只在正日子发」（老行为），
    调用方**应当**传 —— 有元断言钉住生产调用点传了它。
    """
    if not in_push_window(now, cfg):
        return ()
    out = [PushKind.DAILY]
    today = now.date()
    if _digest_due(today, cfg, period="week",
                   last=(last_digest or DigestLedger()).weekly):
        out.append(PushKind.WEEKLY)
    if _digest_due(today, cfg, period="month",
                   last=(last_digest or DigestLedger()).monthly):
        out.append(PushKind.MONTHLY)
    return tuple(out)


@dataclass(frozen=True)
class DigestLedger:
    """两类摘要各自最后一次发出的日期。由调用方从库里读。

    ⚠️ 与逐条 finding 的 `PushState.last_digest_date` 不是一回事：
    这个是**整份摘要**的账本（「这个月的月度摘要发过没」），
    那个是「这条 finding 今天进过摘要没」。合成一个会让
    「补发整份」与「单条幂等」互相干扰。
    """

    weekly: date | None = None
    monthly: date | None = None


def _digest_due(
    today: date, cfg: PushWindow, *, period: str, last: date | None,
) -> bool:
    """摘要该不该在今天发。含**顺延**：正日子不是推送日时，
    落到之后第一个推送日。

    ```
    period="week"   锚点 = 本周的 WEEKLY_DIGEST_WEEKDAY
    period="month"  锚点 = 本月的 MONTHLY_DIGEST_DAY
    ```

    ⚠️ 只往**后**顺延，不提前。提前会让「本周还没过完就发本周摘要」。
    ⚠️ 顺延上限是同一个周期内 —— 跨月就算错过了，不补发上个月的
    （补发一个月前的结构性风险摘要没有意义，那些条目今天照样在看板上）。
    """
    if period == "week":
        # 锚点 = **今天或今天之前**最近一个 `WEEKLY_DIGEST_WEEKDAY`。
        # ⚠️ 不能写成 `today - (isoweekday - WEEKLY_DIGEST_WEEKDAY)` ——
        #    那在锚点日之前的那几天会算出**未来**的锚点然后早退，于是
        #    `weekdays={1}`（只有周一是推送日）时周度 0/104 周命中，
        #    而周报是 MEDIUM 的唯一出口（每日推送里被 `MEDIUM_WEEKLY_ONLY`
        #    挡掉）。往前取让顺延窗口真的能跨过周末。
        back = (today.isoweekday() - WEEKLY_DIGEST_WEEKDAY) % 7
        anchor = today - timedelta(days=back)
        already = last is not None and last >= anchor
        horizon = anchor + timedelta(days=6)
    else:
        anchor = today.replace(day=MONTHLY_DIGEST_DAY)
        already = (last is not None and last.year == today.year
                   and last.month == today.month)
        horizon = anchor + timedelta(days=6)

    if already or today < anchor or today > horizon:
        return False

    # 🔴 锚点当天**就是**推送日 → 只在那天发，不补。
    #
    #    「锚点是推送日却没发」意味着那天推送整体没跑（Lambda 挂了 /
    #    kill switch 被拉），那是另一个问题，有 `PushSent` 指标兜着 ——
    #    事后补一份周报解决不了它，反而会让**全新部署**在第一次跑时
    #    无条件补发一份（账本天然为空），而那一份的内容是「本周仍未关闭」
    #    ——一个刚装好的系统没有「本周」。
    if cfg.matches_day(anchor):
        return today == anchor

    # 锚点不是推送日（1 号落周六 / 运维把 weekdays 收窄了）→ 顺延到
    # 锚点之后**第一个**推送日。这是这段逻辑存在的全部理由。
    probe = anchor + timedelta(days=1)
    while probe <= horizon:
        if cfg.matches_day(probe):
            return today == probe
        probe += timedelta(days=1)
    # 整个周期内一天都不是推送日 —— 配置本身让摘要不可能发出，
    # 这里不强行发（那会绕过运维的显式配置）。`push_policy` 的
    # 元断言会在 CLI 侧提醒这种配置。
    return False


def monday_caveat(today: date, locale: str = "zh") -> str:
    """周一那句标注（R11b.8）。非周一返回空串。

    ⚠️ 选**标注**而不是顺延：顺延意味着周一的 CRITICAL 要等到周二，
    而周末维护窗刚过正是最可能真出事的时候（R8.5）。
    """
    if today.isoweekday() != 1:
        return ""
    if str(locale or "zh").lower().startswith("en"):
        return ("Note: weekend maintenance windows often land here — some items "
                "may be after-effects of planned changes rather than new risk.")
    return "提示：周末维护窗刚过，以下条目里可能有一部分是计划变更的余波而非新增风险。"


# ---------------------------------------------------------------------------
# 推送状态（`insppush#<acct>` 行）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PushState:
    """一条 finding 的推送历史。行不存在 = 从没推过。"""

    finding_id: str = ""
    last_pushed_date: date | None = None
    push_count: int = 0
    last_pushed_severity: str = ""
    last_digest_date: date | None = None
    """摘要类（周度/月度）最后一次发出的日期。

    🔴 **与 `last_pushed_date` 分开。** 合成一个字段会同时坏两件事
    （review 抓到的两条）：
    ① `next_push_date` 拿 `last_pushed_date + 退避天数` 算下次可推日，
       周报每周把 CRITICAL 的下次重推往后顶一天 —— 与「摘要不消耗退避
       配额」的设计意图相反；
    ② 摘要类若不写任何日期，就没有当日幂等判据，同一个窗口被触发两次
       （EventBridge at-least-once，或 `window_minutes` 被配得比 tick 周期宽）
       会把整份周报重发一遍。
    分成两个字段让两条都成立：退避只看前者，摘要幂等只看后者。
    """
    resolved_announced: bool = False
    """缓解已经通报过。

    ⚠️ 需要这个字段：`resolved` 是终态，它会**一直**留在 finding 表里
    （`load_findings` 刻意不过滤 state）。没有这个标记的话
    「已缓解」会每天推一次，直到那行被 TTL 清掉。
    """

    @property
    def ever_pushed(self) -> bool:
        return self.last_pushed_date is not None


def push_state_from_item(item: Mapping[str, Any]) -> PushState:
    """DDB 行 → `PushState`。**从不抛** —— 坏行按「没推过」处理。

    ⚠️ 方向是「没推过」而不是「推过」：前者会多推一次（客户看到重复，
    会说一声），后者会永久漏推（没有任何信号）。
    """
    raw = str(item.get("last_pushed_date") or "")
    try:
        last = date.fromisoformat(raw) if raw else None
    except ValueError:
        last = None
    try:
        count = int(item.get("push_count") or 0)
    except (TypeError, ValueError):
        count = 0
    raw_digest = str(item.get("last_digest_date") or "")
    try:
        digest = date.fromisoformat(raw_digest) if raw_digest else None
    except ValueError:
        digest = None
    return PushState(
        finding_id=str(item.get("finding_id") or item.get("SK") or ""),
        last_pushed_date=last,
        push_count=max(0, count),
        last_pushed_severity=str(item.get("last_pushed_severity") or ""),
        last_digest_date=digest,
        resolved_announced=bool(item.get("resolved_announced") or False),
    )


def backoff_days(push_count: int) -> int:
    """第 `push_count` 次之后要等多少天再推 CRITICAL（R11b.5）。

    ```
    push_count  0 → 1     首次推完，明天可以再推
                1 → 2
                2 → 4
                3 → 7
                ≥4 → 7    固定停在最后一档，不是停推
    ```
    """
    n = max(0, int(push_count))
    if n >= len(CRITICAL_BACKOFF_DAYS):
        return CRITICAL_BACKOFF_DAYS[-1]
    return CRITICAL_BACKOFF_DAYS[n]


def next_push_date(severity: str, state: PushState) -> date | None:
    """下次可推日期。`None` = 没推过（现在就可以推）。"""
    if state.last_pushed_date is None:
        return None
    sev = str(severity or "").strip().upper()
    if sev == Severity.CRITICAL.value:
        gap = backoff_days(state.push_count)
    elif sev == Severity.HIGH.value:
        gap = HIGH_QUIET_DAYS
    else:
        # MEDIUM / INFO 不走每日节奏（各自被更早的判据挡掉），
        # 这里给一个保守值而不是 0 —— 0 会让任何漏掉的分支变成天天推。
        gap = HIGH_QUIET_DAYS
    return state.last_pushed_date + timedelta(days=gap)


# ---------------------------------------------------------------------------
# 单条判定
# ---------------------------------------------------------------------------

_TRANSITION_WORTH_SAYING: frozenset[str] = frozenset({
    "confirmed", "worsened", "resolved", "reopened",
})
"""值得单独说一次的跃迁。**与 `lifecycle.Transition.pushable` 的四档逐字一致**，
有元断言锁住 —— 分叉的表现是两处对「什么叫有变化」的定义不同，
于是某类跃迁在状态机里算可推、在推送里算不可推（或反过来）。
"""

_OPEN_STATES: frozenset[str] = frozenset({"new", "active", "resolving", "chronic"})
"""仍在看板上的状态。与 `lifecycle.FindingState.is_open` 一致（`chronic` 算开着）。"""


@dataclass(frozen=True)
class FindingView:
    """推送要看的那几个字段（从 DDB finding 行取）。"""

    finding_id: str
    account_id: str = ""
    severity: str = Severity.INFO.value
    state: str = "new"
    rule: str = ""
    transition_kind: str = ""
    first_seen_date: str = ""
    instance_id: str = ""
    region: str = ""
    metric: str = ""
    days_active: int = 0
    has_judgment: bool = False
    verdict: str = ""

    @property
    def is_structural(self) -> bool:
        return self.rule in STRUCTURAL_RULES

    @property
    def is_open(self) -> bool:
        return self.state in _OPEN_STATES


def view_from_item(item: Mapping[str, Any]) -> FindingView:
    """DDB finding 行 → `FindingView`。**从不抛。**"""
    try:
        days = int(item.get("days_active") or 0)
    except (TypeError, ValueError):
        days = 0
    return FindingView(
        finding_id=str(item.get("finding_id") or item.get("SK") or ""),
        account_id=str(item.get("account_id") or ""),
        severity=str(item.get("severity") or Severity.INFO.value).strip().upper(),
        state=str(item.get("state") or "new").strip().lower(),
        rule=str(item.get("rule") or ""),
        transition_kind=str(item.get("transition_kind") or "").strip().lower(),
        first_seen_date=str(item.get("first_seen_date") or ""),
        instance_id=str(item.get("instance_id") or ""),
        region=str(item.get("region") or ""),
        metric=str(item.get("metric") or ""),
        days_active=max(0, days),
        has_judgment=item.get("da_updated_at") is not None,
        verdict=str(item.get("da_verdict") or ""),
    )


@dataclass(frozen=True)
class Decision:
    """一条 finding 在一次推送里的去向。"""

    view: FindingView
    push: bool
    reason: str = ""
    """推的理由（`transition` / `backoff` / `digest`）或 `PushSkip` 的值。"""

    @property
    def skip_reason(self) -> PushSkip | None:
        if self.push:
            return None
        try:
            return PushSkip(self.reason)
        except ValueError:
            return None


PUSH_BECAUSE_TRANSITION = "transition"
PUSH_BECAUSE_BACKOFF = "backoff"
PUSH_BECAUSE_DIGEST = "digest"


def decide(
    view: FindingView, state: PushState, *, today: date, kind: PushKind,
) -> Decision:
    """一条 finding 这次推不推。纯判定，不看投递目标（那在 `select_for_target`）。

    ⚠️ 判据顺序是有讲究的：**先按种类分流，再按节奏**。
    倒过来（先算节奏再看是不是结构性）会让结构性风险在每日推送里
    先通过退避判定、再被种类挡掉 —— 结果一样，但 `PushSkip` 会记成
    `BACKOFF_NOT_DUE`，于是「为什么这条月度风险没推」得到一个错误的解释。
    """
    sev = view.severity

    if sev == Severity.INFO.value:
        return Decision(view, False, PushSkip.INFO_NEVER_PUSHED.value)

    if kind in (PushKind.MONTHLY, PushKind.WEEKLY):
        # ── 摘要类（周度 / 月度）────────────────────────────────────
        #
        # 🔴 这两条闸门原本只写在每日分支里，摘要绕过了它们（review 抓到）：
        #
        #   `state == "new"`            R1.0c 未确认不推。`_OPEN_STATES` 含
        #                               `new`，而摘要只判 `is_open` ——
        #                               新接客户第一个周二收到的 Top 5
        #                               全是未二次确认的单点命中。
        #   当日幂等                     摘要压根不看日期，同一窗口被触发两次
        #                               就整份重发。
        if view.state == "new":
            return Decision(view, False, PushSkip.STATE_NOT_PUSHABLE.value)
        if state.last_digest_date == today:
            return Decision(view, False, PushSkip.ALREADY_PUSHED_TODAY.value)

        if kind is PushKind.MONTHLY:
            # 月度只发结构性；其余在这一轮里不是「被跳过」而是不属于本轮。
            if not view.is_structural:
                return Decision(view, False,
                                PushSkip.STRUCTURAL_MONTHLY_ONLY.value)
        elif view.is_structural:
            # 周度不收结构性 —— 它有自己的月度出口。
            return Decision(view, False, PushSkip.STRUCTURAL_MONTHLY_ONLY.value)

        # 10.4「仍未关闭」摘要：只要还开着就进，**不看节奏** ——
        # ⚠️ 这一份的全部意义是「保证没有东西静默腐烂」，
        #    按退避过滤会让挂得最久、最该被看见的那些恰好被滤掉。
        if not view.is_open:
            return Decision(view, False, PushSkip.STATE_NOT_PUSHABLE.value)
        return Decision(view, True, PUSH_BECAUSE_DIGEST)

    if view.is_structural:
        return Decision(view, False, PushSkip.STRUCTURAL_MONTHLY_ONLY.value)

    # ── 每日 ────────────────────────────────────────────────────────
    if sev == Severity.MEDIUM.value:
        return Decision(view, False, PushSkip.MEDIUM_WEEKLY_ONLY.value)

    if view.state == "new":
        # R1.0c：未确认不推。首轮全部是 new，直接推会一次推出几百项。
        return Decision(view, False, PushSkip.STATE_NOT_PUSHABLE.value)

    if state.last_pushed_date == today:
        return Decision(view, False, PushSkip.ALREADY_PUSHED_TODAY.value)

    if view.transition_kind in _TRANSITION_WORTH_SAYING:
        if view.transition_kind == "resolved" and state.resolved_announced:
            return Decision(view, False, PushSkip.RESOLVED_AND_ANNOUNCED.value)
        return Decision(view, True, PUSH_BECAUSE_TRANSITION)

    if not view.is_open:
        return Decision(view, False, PushSkip.STATE_NOT_PUSHABLE.value)

    due = next_push_date(sev, state)
    if due is None or due <= today:
        return Decision(view, True, PUSH_BECAUSE_BACKOFF)
    return Decision(view, False, PushSkip.BACKOFF_NOT_DUE.value)


# ---------------------------------------------------------------------------
# 按投递目标切分（R11b.3 / 10.7）+ Top N（R11b.7 / 10.5）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Selection:
    """一个投递目标这一轮要看到的内容。"""

    picked: tuple[FindingView, ...] = ()
    truncated: int = 0
    """Top N 之外还有多少条 —— 「查看全部」那句要显示这个数。"""
    total: int = 0
    skipped: tuple[Decision, ...] = field(default_factory=tuple)

    @property
    def is_empty(self) -> bool:
        return not self.picked


def _sort_key(v: FindingView) -> tuple[int, str, str]:
    """严重度降序 → 首见日升序 → finding_id。**与
    `overview.FindingBrief.sort_key` 同序**（元断言锁住）。

    ⚠️ 尾键必须是 `finding_id`：少了它，同档同日两条的顺序取决于 DDB
    返回顺序（分页时会变），表现是同一天两份推送的 Top 5 顺序不同。
    """
    try:
        rank = SEVERITY_ORDER.index(v.severity)
    except ValueError:
        rank = len(SEVERITY_ORDER)
    return (rank, v.first_seen_date or "9999-99-99", v.finding_id)


def select_for_target(
    views: Iterable[FindingView],
    states: Mapping[str, PushState],
    target: Any,
    *,
    today: date,
    kind: PushKind = PushKind.DAILY,
    top_n: int = DEFAULT_TOP_N,
) -> Selection:
    """挑出这个投递目标该看到的条目。

    Args:
        target: `domain/targets.ChatTarget`（duck-typed —— 只用 `sees()` 与
            `accepts()`，这样测试不用造整个 dataclass）。

    🔴 **账号可见性判在最前面**（R11b.3）。放到后面会让一条不可见的 finding
    先参与 Top N 排序再被剔掉 —— 于是 `truncated` 里含着客户根本无权看到的
    条数，「另有 7 条」里有 3 条是别人的。

    ⚠️ `truncated` 按**该目标可见且该推**的条数算，不是全量。
    """
    decisions: list[Decision] = []
    kept: list[FindingView] = []
    for v in views:
        if not target.sees(v.account_id):
            decisions.append(
                Decision(v, False, PushSkip.ACCOUNT_NOT_VISIBLE.value))
            continue
        if not target.accepts(v.severity):
            decisions.append(
                Decision(v, False, PushSkip.BELOW_TARGET_FLOOR.value))
            continue
        d = decide(v, states.get(v.finding_id, PushState()), today=today, kind=kind)
        decisions.append(d)
        if d.push:
            kept.append(v)

    kept.sort(key=_sort_key)
    n = max(0, top_n)
    picked = tuple(kept[:n])
    return Selection(
        picked=picked,
        truncated=max(0, len(kept) - len(picked)),
        total=len(kept),
        skipped=tuple(d for d in decisions if not d.push),
    )


def skip_counts(selection: Selection) -> dict[str, int]:
    """按原因计数 —— EMF 打点与 run 记录用。"""
    out: dict[str, int] = {}
    for d in selection.skipped:
        out[d.reason] = out.get(d.reason, 0) + 1
    return out


def views_from_items(
    items: Iterable[Mapping[str, Any]],
) -> list[FindingView]:
    return [view_from_item(it) for it in items]


def states_from_items(
    items: Iterable[Mapping[str, Any]],
) -> dict[str, PushState]:
    out: dict[str, PushState] = {}
    for it in items:
        st = push_state_from_item(it)
        if st.finding_id:
            out[st.finding_id] = st
    return out


def push_window_from_item(item: Mapping[str, Any] | None) -> PushWindow:
    """DDB 行 → `PushWindow`。行不存在给默认值。

    ⚠️ 默认 `enabled=True`：全新部署的表是空的，默认关掉会让客户跑完
    `setup.sh` 之后什么都没收到，而且没有任何错误信号 ——
    只会以为「推送要等一天」，等到第二天还是没有
    （与 `_schedule_from_item` 的同一条理由）。

    ⚠️ 单个坏字段不能让整轮不推：`at_utc` 解析失败退回默认时刻。
    抛异常会让一行手工改错的配置把推送整个掐停。
    """
    default = PushWindow()
    if not item:
        return default

    at_utc = default.at_utc
    raw_at = str(item.get("at_utc") or "")
    if raw_at:
        try:
            at_utc = time.fromisoformat(raw_at)
        except ValueError:
            pass

    weekdays = default.weekdays
    raw_days = item.get("weekdays")
    if raw_days:
        try:
            parsed = frozenset(int(w) for w in raw_days)
        except (TypeError, ValueError):
            parsed = frozenset()
        parsed = frozenset(w for w in parsed if 1 <= w <= 7)
        if parsed:
            weekdays = parsed

    try:
        minutes = int(item.get("window_minutes") or default.window_minutes)
    except (TypeError, ValueError):
        minutes = default.window_minutes

    raw_enabled = item.get("enabled")
    if raw_enabled is None:
        enabled = True
    elif isinstance(raw_enabled, str):
        enabled = raw_enabled.strip().lower() not in ("0", "false", "no", "")
    else:
        enabled = bool(raw_enabled)

    return PushWindow(
        enabled=enabled,
        at_utc=at_utc,
        weekdays=weekdays,
        window_minutes=max(1, minutes),
        tz_label=str(item.get("tz_label") or default.tz_label),
    )


def push_window_to_item(cfg: PushWindow) -> dict[str, Any]:
    return {
        "enabled": cfg.enabled,
        "at_utc": cfg.at_utc.isoformat(timespec="minutes"),
        "weekdays": sorted(cfg.weekdays),
        "window_minutes": cfg.window_minutes,
        "tz_label": cfg.tz_label,
    }


_L: dict[str, dict[str, str]] = {
    "zh": {
        "daily": "资源巡检 · 今日变化",
        "weekly": "资源巡检 · 本周仍未关闭",
        "monthly": "资源巡检 · 结构性风险月度摘要",
        "account": "账号",
        "days": "已持续 {n} 天",
        "no_judgment": "（无根因分析）",
        "more": "另有 {n} 条 · [查看全部]({url})",
        "more_plain": "另有 {n} 条，见看板",
        "detail": "详情",
        "snooze": "不想再收到这类提醒？[调整巡检范围]({url})",
        "empty": "本轮没有需要提醒的变化。",
    },
    "en": {
        "daily": "Resource Inspection · Changes today",
        "weekly": "Resource Inspection · Still open this week",
        "monthly": "Resource Inspection · Structural risk (monthly)",
        "account": "Account",
        "days": "active for {n}d",
        "no_judgment": " (no root-cause analysis)",
        "more": "{n} more · [see all]({url})",
        "more_plain": "{n} more, see the dashboard",
        "detail": "details",
        "snooze": "Too noisy? [Adjust inspection scope]({url})",
        "empty": "Nothing worth flagging this run.",
    },
}


def _t(locale: str, key: str, **kw: Any) -> str:
    table = _L["en"] if str(locale or "zh").lower().startswith("en") else _L["zh"]
    return table[key].format(**kw) if kw else table[key]


def render_selection(
    sel: Selection,
    *,
    account_id: str,
    today: date,
    kind: PushKind = PushKind.DAILY,
    locale: str = "zh",
    links: Mapping[str, str] | None = None,
    all_link: str = "",
    snooze_link: str = "",
    caveat: str = "",
    intro: str = "",
) -> str:
    """一个账号的推送正文（确定性 markdown）。空 selection → 空串。

    🔴 **链接由调用方算好传进来**（`links` / `all_link` / `snooze_link`）。
    拼 URL 要 `urllib.parse.quote`，而 domain 层禁 `urllib`
    （`test_domain_layer_has_no_io` 的 `BANNED_MODULES`）——
    真正的原因不是那条规则本身：base URL 来自环境变量，把它读进判定层会让
    「推什么」这件事变得不可纯函数测试。拼接在 `adapters/links.py`。

    ⚠️ 返回空串而不是「本轮无变化」：发不发那句话是**调用方**的决定 ——
    每日推送里天天来一句「无变化」两周后没人看，而周报里那句是有意义的
    （证明系统在跑）。在这里替调用方决定会让两种场合只能有一种行为。
    """
    if sel.is_empty:
        return ""
    link_map = links or {}
    lines = [f"## {_t(locale, kind.value)}"]
    if intro.strip():
        lines += ["", intro.strip()]
    if caveat.strip():
        lines += ["", caveat.strip()]
    lines += ["", f"{_t(locale, 'account')}: {account_id} · {today.isoformat()}"]
    lines.append("")
    for v in sel.picked:
        bits = [f"**{v.severity}**", v.instance_id or v.finding_id]
        if v.region:
            bits.append(v.region)
        if v.metric and v.metric != "-":
            bits.append(v.metric)
        seg = f"- {' · '.join(bits)}"
        if v.days_active > 0:
            seg += f" · {_t(locale, 'days', n=v.days_active)}"
        if v.has_judgment and v.verdict:
            seg += f" · {v.verdict}"
        elif not v.has_judgment:
            seg += _t(locale, "no_judgment")
        url = link_map.get(v.finding_id, "")
        if url:
            seg += f" · [{_t(locale, 'detail')}]({url})"
        lines.append(seg)
    if sel.truncated:
        lines.append("- " + (_t(locale, "more", n=sel.truncated, url=all_link)
                             if all_link
                             else _t(locale, "more_plain", n=sel.truncated)))
    if snooze_link:
        lines += ["", _t(locale, "snooze", url=snooze_link)]
    return "\n".join(lines)


DASHBOARD_TABS: tuple[str, ...] = ("high-load", "idle", "structural")
"""看板子页 id。**与 `InspectionDashboardBrowser.tsx` 的 `ENTRIES` 逐字一致**，
有元断言锁住 —— 深链带一个不存在的 tab 会静默落回默认页（`sel` 是派生值，
认不出的 `initial` 直接被 fallback 吃掉），而链接看起来是好的。
"""


CAPACITY_RULES: frozenset[str] = frozenset(r.value for r in CapacityRule)
"""容量超配的规则码。

⚠️ 与 `STRUCTURAL_RULES` **分开**是必要的：那个集合表达的是「走月度摘要
节奏」（容量必须在里面，否则「存储开太大」天天推），而这个集合表达的是
「在看板上归哪一页」—— 两件事不同，混用一个集合就是下面那个 bug 的成因。
"""

PURE_STRUCTURAL_RULES: frozenset[str] = frozenset(
    r.value for r in StructuralRule
)
"""七项结构性风险的规则码（不含容量）。"""


def tab_for_rule(rule: str) -> str:
    """`finding_id` 的 rule 段 → 深链该落在看板的哪一类（R11b.7）。

    ```
    七项结构性风险的规则码        → structural
    容量超配（oversized_*）       → idle       ← 见下
    "idle"                       → idle
    其余（threshold_high 等）      → high-load
    ```

    🔴 **容量归闲置，不归结构性。** 第一版复用了 `STRUCTURAL_RULES`
    （它含容量码，因为推送节奏那侧需要），于是一条「RDS 存储开太大」的深链
    落在结构性风险页 —— 而它在那一页上**找不到**，因为
    `dto.py::CapacityRule` 明写「输出归②「闲置与优化」而不是结构性风险页」
    （R4.1c）。表现是客户点开推送里的链接，看到一个空列表。

    ⚠️ 返回值仍是 `high-load` / `idle` / `structural` 这三个老字符串。
    看板的 IA 已经把三页合成「待处置」一页 + 类别 chip，但**已经发出去的
    IM 深链还在客户手里**，所以这三个值的语义变成「预选哪个 chip」，
    前端有兼容映射（`InspectionDashboardBrowser` 的 `LEGACY_TAB`）。

    ⚠️ `chronic_high` 不会单独成为 rule 段（R2.6.2：它是慢性高位的**补充
    标注**，必须与 `threshold_high` 同现），所以走 else 分支是对的。
    """
    r = (rule or "").strip()
    if r in CAPACITY_RULES:
        return "idle"
    if r in PURE_STRUCTURAL_RULES:
        return "structural"
    if r == "idle":
        return "idle"
    return "high-load"


def has_run_today(run_items: Sequence[Mapping[str, Any]], *, today: date) -> bool:
    """今天有没有产出过 run 记录（任一类型、任一状态）。

    🔴 推送前的**最后一道闸**：没有它，把 `at_utc` 配到巡检之前就会每天推
    前一天的结论，而客户看到的日期是今天 —— 表现是「推送里的数字和看板
    不一样」，而两边都不报错。
    """
    stamp = today.isoformat()
    return any(str(r.get("run_date") or "") == stamp for r in run_items)
