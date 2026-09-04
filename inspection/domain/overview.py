"""总览的确定性拼装（R9.3）。

推送与报告都要一份「今天怎么样」的摘要。R9.1 明写**所有数字由巡检确定性计算**，
所以这里只排序、计数、比差，不做任何判定、不调 LLM。

## 与 BFF 那份的关系

看板走 `bff/web-chat/inspection.mjs::getOverview`（JS，直读 DDB）。本模块是
**Python 侧的同一口径**，给推送与报告用。两份实现是既有事实（BFF 不能 import
Python），所以口径必须逐条对齐，并由 `test_inspection_overview.py` 的元断言
比对 —— 分叉的表现是**推送说 12 条而看板说 9 条**，客户会问哪个是真的。

对齐的三条口径：

```
diff 基准    = 同类型的**上一轮**，不是昨天
               闲置轮可能是周度的，拿昨天做基准会让每次都显示「全部新增」
dispatch_gap = Σ max(0, dispatched − mapped)，且两者都已知才算
               这是「判读永久回不来」的条数
by_severity  四档降序，缺的档补 0（不是省略）
```

## ⚠️ 排序必须**全序**

R14 要求同输入同输出。只按 severity 排会让同档内的顺序取决于 DDB 返回顺序，
而那个顺序在分页时会变 —— 表现是同一天的两份报告里 Top 5 的顺序不同，
客户以为风险在变化。所以尾键一路排到 `finding_id`。

## 8.6 的导语：**注入**而不是在这里调 LLM

`build_overview` 与 `render_overview` 都是纯函数（零 IO、零 boto3）。导语由
调用方生成后传进来，开关也在调用方读（`switches.Switch.LLM_INTRO`）。

⚠️ 这不只是洁癖：R9.3 要求「导语可关闭且关闭后**不影响任何数据**」。
把 LLM 调用放进拼装函数里，就没法在单测里证明「关掉之后确定性部分逐字不变」——
而那正是这条需求要保证的东西。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Iterable, Mapping, Sequence

SEVERITY_ORDER: tuple[str, ...] = ("CRITICAL", "HIGH", "MEDIUM", "INFO")
"""四档**降序**。与 `dto.Severity` 及 BFF 的 `SEVERITIES` 同序。

⚠️ 顺序即报告里的呈现顺序。反过来会把 INFO 排在最前面，
而客户看报告时第一眼要看到的是 CRITICAL。
"""

RUN_TYPE_ORDER: tuple[str, ...] = ("high", "idle")
"""与侧栏顺序一致（BFF 的 `RUN_TYPES`）。"""

DEFAULT_TOP_N = 5
"""报告/推送里列几条。R11b.7 的「单条消息 Top N + 查看全部深链」用同一个数。"""


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    return None


def _int(value: Any) -> int | None:
    n = _num(value)
    return None if n is None else int(n)


@dataclass(frozen=True)
class FindingBrief:
    """报告/推送需要的最小 finding 视图。"""

    finding_id: str
    account_id: str
    region: str
    service: str
    instance_id: str
    metric: str
    rule: str
    severity: str
    state: str
    first_seen_date: str
    has_judgment: bool
    verdict: str = ""

    def days_active(self, today: date) -> int | None:
        """已持续天数（R6.5）。**由 today 入参算**，不读时钟。

        ⚠️ 读时钟会让同一份数据在不同时刻渲染出不同的天数，
        而 R14.2 要求 `today` 必须是入参。
        """
        if not self.first_seen_date:
            return None
        try:
            first = date.fromisoformat(self.first_seen_date)
        except ValueError:
            return None
        return max(0, (today - first).days)

    @property
    def sort_key(self) -> tuple[int, str, str]:
        """全序排序键：严重度降序 → 首次发现日升序 → finding_id。

        ⚠️ 尾键必须是 `finding_id`（唯一）。少了它，同档同日的两条的相对
        顺序取决于 DDB 返回顺序，而那个顺序在分页时会变 —— 表现是同一天
        两份报告的 Top N 顺序不同，客户以为风险在变化。
        """
        try:
            rank = SEVERITY_ORDER.index(self.severity)
        except ValueError:
            rank = len(SEVERITY_ORDER)      # 认不出的档排最后，不抛
        return (rank, self.first_seen_date or "9999-99-99", self.finding_id)


def brief_from_item(item: Mapping[str, Any]) -> FindingBrief:
    """DDB finding 行 → `FindingBrief`。

    ⚠️ `has_judgment` 的判据是 `da_updated_at` 存在 —— 与
    `store.list_awaiting_judgment()` 用的是同一个判据。用 `da_body` 判会把
    「解析失败但留了原文」算成有判读，而那两种在报告上的措辞不同。
    """
    return FindingBrief(
        finding_id=str(item.get("finding_id") or item.get("SK") or ""),
        account_id=str(item.get("account_id") or ""),
        region=str(item.get("region") or ""),
        service=str(item.get("service") or ""),
        instance_id=str(item.get("instance_id") or ""),
        metric=str(item.get("metric") or ""),
        rule=str(item.get("rule") or ""),
        severity=str(item.get("severity") or "INFO"),
        state=str(item.get("state") or "unknown"),
        first_seen_date=str(item.get("first_seen_date") or ""),
        has_judgment=item.get("da_updated_at") is not None,
        verdict=str(item.get("da_verdict") or ""),
    )


@dataclass(frozen=True)
class RunDiff:
    """一种巡检类型与**上一轮**的对比。"""

    run_type: str
    current: int | None = None
    previous: int | None = None
    last_run_date: str = ""
    last_status: str = ""
    completeness: float | None = None

    @property
    def delta(self) -> int | None:
        """`None` 表示**不可比**（缺一边），不是 0。

        ⚠️ 缺一边返回 0 会让「第一轮」显示成「与上轮持平」，
        而那时压根没有上一轮。
        """
        if self.current is None or self.previous is None:
            return None
        return self.current - self.previous

    @property
    def completeness_pct(self) -> int | None:
        """完整度的百分比**整数**。渲染层不许自己算这个数（R9.1）。

        ⚠️ 不能写 `f"{c * 100:.0f}"`。Python 的格式化是 banker's rounding
        （五取偶），前端 `InspectionDashboard.tsx` 用的是 `Math.round`（half-up）。
        两者在 `c * 100` 恰好落在 .5 上时给出不同结果 —— 而那不是罕见值：
        8 台里成功 5 台就是 `0.625 → 62.5`，Python 给 62、JS 给 63。
        表现是**看板 63% 而推送 62%**，客户会问哪个是真的。

        `floor(x + 0.5)` 与 JS `Math.round` 逐位等价（同一个 IEEE754 double，
        completeness 非负所以不用管负数那一侧的差异）。
        """
        if self.completeness is None:
            return None
        return math.floor(self.completeness * 100 + 0.5)


@dataclass(frozen=True)
class Overview:
    account_id: str
    run_date: str = ""
    total: int = 0
    by_severity: dict[str, int] = field(default_factory=dict)
    by_state: dict[str, int] = field(default_factory=dict)
    without_judgment: int = 0
    dispatch_gap: int = 0
    diff: tuple[RunDiff, ...] = ()
    top: tuple[FindingBrief, ...] = ()
    truncated: int = 0
    """Top N 之外还有多少条 —— R11b.7 的「查看全部」要显示这个数。"""

    @property
    def is_clean(self) -> bool:
        return self.total == 0


def _shape_run(item: Mapping[str, Any]) -> dict[str, Any]:
    """run 行 → 扁平视图。与 BFF 的 `shapeRun` 同口径。"""
    stats = item.get("stats") or {}
    dispatch = item.get("dispatch") or stats.get("dispatch") or {}
    return {
        "run_type": str(item.get("run_type") or ""),
        "run_date": str(item.get("run_date") or ""),
        "status": str(item.get("status") or stats.get("status") or ""),
        # ⚠️ `stats.completeness ?? item.completeness` —— 后者是给老行的兜底，
        #    不代表有第二个位置。
        "completeness": _num(stats.get("completeness")
                             if stats.get("completeness") is not None
                             else item.get("completeness")),
        "findings": _int(dispatch.get("findings")),
        "dispatched_tasks": _int(dispatch.get("dispatched_tasks")),
        "mapped_tasks": _int(dispatch.get("mapped_tasks")),
    }


def build_overview(
    *,
    account_id: str,
    finding_items: Iterable[Mapping[str, Any]],
    run_items: Sequence[Mapping[str, Any]],
    today: date,
    top_n: int = DEFAULT_TOP_N,
) -> Overview:
    """拼装总览。**只排序、计数、比差**，不做判定、不调 LLM（R9.1 / R9.3）。

    `run_items` 可以是多天多类型混在一起的原始行 —— 这里自己按类型取最近两轮。
    """
    briefs = [brief_from_item(it) for it in finding_items]
    briefs.sort(key=lambda b: b.sort_key)

    by_severity = {s: 0 for s in SEVERITY_ORDER}
    by_state: dict[str, int] = {}
    without_judgment = 0
    for b in briefs:
        if b.severity in by_severity:
            by_severity[b.severity] += 1
        else:
            # 认不出的档也要计数 —— 丢掉会让 by_severity 的和不等于 total，
            # 而报告上那两个数是并排显示的。
            by_severity[b.severity] = by_severity.get(b.severity, 0) + 1
        by_state[b.state] = by_state.get(b.state, 0) + 1
        if not b.has_judgment:
            without_judgment += 1

    shaped = [_shape_run(r) for r in run_items]
    # 日期降序 → 类型顺序（与 BFF 的 rows.sort 同）
    shaped.sort(key=lambda r: (r["run_date"],
                               -RUN_TYPE_ORDER.index(r["run_type"])
                               if r["run_type"] in RUN_TYPE_ORDER else 0),
                reverse=True)

    diffs: list[RunDiff] = []
    latest_date = ""
    for rt in RUN_TYPE_ORDER:
        same = [r for r in shaped if r["run_type"] == rt]
        cur = same[0] if same else None
        prev = same[1] if len(same) > 1 else None
        if cur and cur["run_date"] > latest_date:
            latest_date = cur["run_date"]
        diffs.append(RunDiff(
            run_type=rt,
            current=cur["findings"] if cur else None,
            previous=prev["findings"] if prev else None,
            last_run_date=cur["run_date"] if cur else "",
            last_status=cur["status"] if cur else "",
            completeness=cur["completeness"] if cur else None,
        ))

    # 🔴 派发缺口：dispatched > mapped 意味着判读永久回不来。
    #    ⚠️ 两者**都已知**才算 —— 缺键当 0 会让失败 run（dispatch 默认值里
    #    没有 mapped_tasks）算出一个假的缺口。
    gap = 0
    for r in shaped:
        d, m = r["dispatched_tasks"], r["mapped_tasks"]
        if d is not None and m is not None and d > m:
            gap += d - m

    top = tuple(briefs[:max(0, top_n)])
    return Overview(
        account_id=account_id,
        run_date=latest_date,
        total=len(briefs),
        by_severity=by_severity,
        by_state=by_state,
        without_judgment=without_judgment,
        dispatch_gap=gap,
        diff=tuple(diffs),
        top=top,
        truncated=max(0, len(briefs) - len(top)),
    )


# ---------------------------------------------------------------------------
# 渲染（确定性模板）
# ---------------------------------------------------------------------------

_L = {
    "zh": {
        "title": "资源巡检总览",
        "account": "账号",
        "clean": "本轮未发现风险。",
        "total": "风险总数",
        "no_analysis": "未做根因分析",
        "gap": "⚠️ 有 {n} 条判读任务已派发但未能关联，其分析结果无法回填",
        "vs_prev": "较上一轮",
        "first_run": "首轮（无对比基准）",
        "top": "重点关注",
        "more": "另有 {n} 条，见看板",
        "days": "已持续 {n} 天",
        "no_judgment_mark": "（无根因分析）",
        "completeness": "采集完整度",
    },
    "en": {
        "title": "Resource Inspection Overview",
        "account": "Account",
        "clean": "No findings this run.",
        "total": "Total findings",
        "no_analysis": "Without analysis",
        "gap": ("⚠️ {n} analysis tasks were dispatched but could not be matched "
                "back; their results cannot be filled in"),
        "vs_prev": "vs previous run",
        "first_run": "first run (no baseline)",
        "top": "Top findings",
        "more": "{n} more, see the dashboard",
        "days": "active for {n}d",
        "no_judgment_mark": " (no root-cause analysis)",
        "completeness": "Data completeness",
    },
}


def _t(locale: str, key: str, **kw: Any) -> str:
    table = _L["en"] if str(locale or "zh").lower().startswith("en") else _L["zh"]
    return table[key].format(**kw) if kw else table[key]


def render_overview(
    ov: Overview, *, today: date, locale: str = "zh", intro: str = "",
) -> str:
    """确定性 Markdown。

    Args:
        intro: 8.6 的可选 LLM 导语。**空串时输出逐字等于没有导语的版本** ——
            那正是 R9.3「关闭后不影响任何数据」要保证的东西，
            由 `test_inspection_overview.py` 逐字比对。

    ⚠️ 这里出现的每个数字都来自 `ov`。在渲染时补算一个百分比就意味着同一个
    数字有两个来源（另一个在 BFF），而两处必然分叉。
    """
    lines: list[str] = [f"## {_t(locale, 'title')}"]
    if intro.strip():
        # 导语与确定性内容之间留一条分隔 —— 混在一起会让客户分不清
        # 哪句是模型说的、哪句是算出来的。
        lines += ["", intro.strip(), ""]
    head = f"{_t(locale, 'account')}: {ov.account_id}"
    if ov.run_date:
        head += f" · {ov.run_date}"
    lines.append(head)

    if ov.is_clean:
        lines += ["", _t(locale, "clean")]
        return "\n".join(lines)

    counts = " · ".join(
        f"{s} {ov.by_severity.get(s, 0)}" for s in SEVERITY_ORDER)
    lines += ["", f"{_t(locale, 'total')}: {ov.total}（{counts}）"]
    if ov.without_judgment:
        lines.append(f"{_t(locale, 'no_analysis')}: {ov.without_judgment}")
    # 🔴 派发缺口放在最前面的位置之一 —— 它不是「有多少风险」而是
    #    「我们的链路漏了东西」，后者优先级更高。
    if ov.dispatch_gap > 0:
        lines += ["", _t(locale, "gap", n=ov.dispatch_gap)]

    lines += ["", f"### {_t(locale, 'vs_prev')}"]
    for d in ov.diff:
        if d.current is None:
            continue
        if d.delta is None:
            trend = _t(locale, "first_run")
        else:
            trend = f"{d.delta:+d}"
        seg = f"- {d.run_type}: {d.current}（{trend}）"
        if d.completeness is not None and d.completeness < 1.0:
            seg += (f" · {_t(locale, 'completeness')} "
                    f"{d.completeness_pct}%")
        lines.append(seg)

    if ov.top:
        lines += ["", f"### {_t(locale, 'top')}"]
        for b in ov.top:
            days = b.days_active(today)
            bits = [f"**{b.severity}**", f"{b.instance_id}"]
            if b.region:
                bits.append(b.region)
            if b.metric:
                bits.append(b.metric)
            seg = f"- {' · '.join(bits)}"
            if days is not None:
                seg += f" · {_t(locale, 'days', n=days)}"
            if b.has_judgment and b.verdict:
                seg += f" · {b.verdict}"
            elif not b.has_judgment:
                seg += _t(locale, "no_judgment_mark")
            lines.append(seg)
        if ov.truncated:
            lines.append(f"- {_t(locale, 'more', n=ov.truncated)}")

    return "\n".join(lines)
