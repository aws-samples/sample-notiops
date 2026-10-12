"""按需给**单条 finding** 派一次 DA 判读（2026-08-31）。

## 为什么要有这条路

闲置轮设计上不派 DA（`gating.DETERMINISTIC_RUN_TYPES = {"idle"}`）——
三个维度加权算分就是结论，不需要 LLM。这个判断在**批量**语境下是对的：
为每台「CPU 0.25% 的机器」每天买一次判读是纯烧钱。

但它让 `inspection-cost-idle` 这个 skill 的 idle 那一半成了**死代码**。
而那个 skill 的 description 逐字写着它能回答的正是客户唯一真正关心的问题：

> decide whether the resource is genuinely idle **or idle for a reason**
> (standby replica, month-end batch, warmed cache, stopped instance)

规则能看出「利用率低」，看不出**为什么**低。而那个区分就是这份 review 的全部
价值 —— skill 自己写着「recommending deletion of a disaster-recovery replica
is worse than recommending nothing at all」。

⇒ 所以：**批量不派，但人点了就派**。一条一条、显式、带上运维手填的背景。

## 为什么不复用 run 流水线

第一版设计想走 `Task(region=…, instance_subset=(…,))`（那两个字段的注释写着
就是给「运维手动重跑」用的）。但那条路会**占掉当天的巡检槽位**：

```
handler.py:903   无条件 try_acquire_run_lock
handler.py:291   「③ 但仍占当天槽位 ← build_stats 照样落 success，
                   而调度的判据是 BLOCKING_STATUSES = {running, success}」

⇒ 在一条 finding 上点一次「深入分析」
  → 当天的正式定时轮不再执行
  → 那天没有状态机推进、没有「已解决」判定、没有推送
```

一次好奇心的点击取消掉当天整轮巡检。所以这条路**完全不碰** run 记录：
不抢锁、不写 run 行、不进 completeness、不参与对账缺行判定。

## 数据从哪来（**零 CloudWatch 花费**）

```
finding 行      severity · rule · instance_class · idle_* · savings · evidence_as_of
inspseries# 行  日序列（本来就落库，`store.query_series`）
describe 一次   engine + ResourceAttrs（multi_az / maxmemory_policy / …）
                ⚠️ 这一次是必须的：`engine` 不在 finding 行上，而
                   `metric_family()` 要它；而 attrs 正是 skill 判「是否有原因」
                   的依据（是不是 standby、是不是多 AZ）
```

🔴 **不重采指标**，理由不是省钱而是**一致性**：重采会让载荷里的数字与看板上
那条 finding 的数字不一致（02:00 采的 vs 现在采的），于是 skill 分析的是一组
客户在界面上看不到的数。用同一批序列，报告里每个数字都能在看板上对上。

## 载荷为什么不能省 `correlated`

`validate_payload` 对 idle **硬性要求** correlated 里有副本判定指标
（2026-08-31 实测被拒过一次）。理由是：

```
这台不是 reader        → 不是副本 → 可以考虑删
这台是 reader 但没采到 → 是副本   → 千万别删
⇒ 两种相反的事实在载荷里长得一样 → 可能删掉一台真的 standby
```

所以这里复用 `assemble._correlated_section` 而**不重写**那四档
`unavailable` 语义（`not_applicable` / `no_datapoints` / … 各自是不同强度的
结论，合并任意两档都会让 DA 得出错的方向）。
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from inspection.adapters import keys
from inspection.adapters.metrics_repo import DailyPoint, MetricSeries
from inspection.adapters.store import InspectionStore, SeriesRow
from inspection.domain import metrics_meta as mm
from inspection.domain import payload as pl
from inspection.domain.dto import ResourceAttrs, Severity, StructuralRule
from inspection.domain.schedule import RunType
from inspection.domain.series import WINDOW_DAYS

logger = logging.getLogger(__name__)


class ManualJudgeError(Exception):
    """这次按需判读没法进行。`code` 供调用方转成 HTTP 状态。

    ⚠️ 与资源相关的三个 code 各自对应一句不同的话，前端按它分支：

    ```
    not_found            finding 行不在库里了（规则变更后重建、或被清理）
    resource_gone        finding 在，但那台资源已经不存在（describe 列全了、里面没有它）
                         → 已在行上打标，前端不再给「深入分析」
    describe_incomplete  describe 没列全（权限 / 限流），**不知道**它还在不在
                         → 不打标，可以稍后重试
    ```
    """

    def __init__(self, message: str, *, code: str = "bad_request") -> None:
        super().__init__(message)
        self.code = code


class DescribeIncomplete(Exception):
    """`describe_attrs` 没列全（部分 describe 失败）时抛。

    🔴 与「返回 None」必须分开：None = 列全了、里面没有它 = 资源已不存在；
       这个 = 我们没看全。合成一个的后果是把一台在跑的库说成「已删除」并藏掉按钮。
    """


@dataclass(frozen=True)
class JudgeResult:
    """派发成功的回执。"""

    finding_id: str
    account_id: str
    task_id: str
    agent_space_id: str
    payload_chars: int
    console_url: str = ""


class _SeriesBundle:
    """把 `store.query_series()` 的行喂给既有的 `_correlated_section` 与
    `metrics_repo.daily_rows_for_lowdays`。

    🔴 只实现那两处用到的 `.daily()` 与 `.get()`。实现更多方法只会让人以为这是
       一个完整的 bundle 替身，而它不是。

    ⚠️ 按 `data_date` 排序后再取值。DDB 的 query 按 SK 字典序返回，而 SK 是
       `<metric>#<stat>#<date>` —— 同一 (metric, stat) 下日期恰好也是字典序，
       所以**当前**是对的。但那是巧合而不是保证（换个 SK 结构就不成立），
       而序列顺序错了的表现是 skill 读到一条时间倒着走的趋势，
       它会把「在下降」说成「在上升」。所以这里显式排。

    ⚠️ `window`：只收 `[起, 止]` 闭区间内的行（2026-10-10 review B11）。序列库保留
       35 天，不截断的话 `correlated` 里是一串没有日期、长度对不上 7 天窗口的值，
       与批量判读（采集窗口恰好 7 天）不是同一个口径。
    """

    def __init__(self, rows: Sequence[SeriesRow], *,
                 window: tuple[date, date] | None = None) -> None:
        buckets: dict[tuple[str, str, str], list[tuple[date, float | None]]] = {}
        for r in rows:
            if window is not None and not (window[0] <= r.data_date <= window[1]):
                continue
            buckets.setdefault(
                (r.instance_id, r.metric, r.stat), []).append((r.data_date, r.value))
        self._pairs = {k: sorted(pairs, key=lambda p: p[0]) for k, pairs in buckets.items()}
        self._m = {k: [v for _, v in pairs] for k, pairs in self._pairs.items()}

    def daily(self, instance_id: str, metric: str, stat: str) -> list[float | None]:
        return list(self._m.get((instance_id, metric, stat), []))

    def get(self, instance_id: str, metric: str, stat: str) -> MetricSeries | None:
        """与 `MetricsBundle.get` 同一契约：点位**按日期倒序**、没值的天不出现。"""
        pairs = self._pairs.get((instance_id, metric, stat))
        if not pairs:
            return None
        pts = tuple(DailyPoint(data_date=d, value=float(v))
                    for d, v in reversed(pairs) if v is not None)
        return MetricSeries(instance_id=instance_id, metric=metric, stat=stat,
                            points=pts)


def _data_date_of(finding: Mapping[str, Any]) -> str:
    """载荷的 `data_date`：`evidence_as_of`（最后一次被评估的那天）。

    ⚠️ 不用「今天」：载荷契约里 `data_date` 是「窗口里最后一个完整 UTC 日」，
       而 skill 被明确禁止说「今天」。用今天会让报告里的日期与看板上那条
       finding 的日期差一天。
    """
    return str(finding.get("evidence_as_of")
               or finding.get("last_run_date") or date.today().isoformat())[:10]


def _window_of(data_date: str, days: int = WINDOW_DAYS) -> tuple[date, date] | None:
    try:
        end = date.fromisoformat(data_date)
    except ValueError:
        return None
    return (end - timedelta(days=days - 1), end)


# `rule` 段 → 载荷的 `hit_reason`。
#
# ⚠️ 不能直接把 `rule` 当 hit_reason 用：`validate_payload` 只认四个值
#    （`VALID_HIT_REASONS`），而 `rule` 段里有 `gp2_volume` / `engine_eol` /
#    `single_az_in_prod` 这些**结构性规则名**。传进去会被拒，
#    而错误信息说的是「未知 hit_reason」，看不出根因是这里没映射。
# 🔴 **从枚举派生，不手写第二份。** 手写那一份已经漂了（2026-08-31 发现）：
#    它含 2 个压根不存在的值（`cert_expiring` —— 真名是 `ca_cert_expiring`、
#    `no_deletion_protection` —— 从来没有这条规则），而漏了 5 个真实值
#    （`burstable_in_prod` / `no_read_replica` / `ca_cert_expiring` /
#    `no_capacity_metadata` / `unsupported_engine`）。
#
#    今天的表现是「无害但有噪音」：漏掉的那 5 类落到 `hit_reasons_for` 的
#    fallback，分类结果**恰好相同**，只是每次都打一条「未映射的 rule=…」
#    的 WARNING —— 而那条日志的字面意思是「这里有个漏映射」，排查时会被
#    当成真缺陷追。
#
# ⚠️ 真正的风险是它给了**假的覆盖感**：下面那个函数的 docstring 正在讨论
#    「未知规则要不要抛」。哪天改成抛，这 5 类当场全挂 —— 而这份手写清单
#    看起来是完整的。`push_policy.py` 就是从枚举派生的，照它。
_STRUCTURAL_RULES = frozenset(
    r.value for r in StructuralRule)


def hit_reasons_for(rule: str) -> list[str]:
    """`rule` → `hit_reason[]`。未知规则按结构性处理（**不抛**）。

    ⚠️ 未知规则**不能抛异常**：那会让一个新加的结构性规则把「深入分析」
       整个按钮变成必然失败，而失败信息里只有「未知 rule」。
       按结构性处理最坏是 skill 拿到一个偏保守的分类，仍然能给出结论。
    """
    r = (rule or "").strip()
    if r == "idle":
        return [pl.HIT_IDLE]
    if r == "threshold_high":
        return [pl.HIT_THRESHOLD_HIGH]
    if r == "chronic_high":
        # ⚠️ `validate_payload` 拦「chronic 不带 threshold_high」——
        #    chronic 的定义是「持续越线」，它蕴含越线。
        return [pl.HIT_THRESHOLD_HIGH, pl.HIT_CHRONIC_HIGH]
    if r.startswith("oversized_") or r in _STRUCTURAL_RULES:
        return [pl.HIT_STRUCTURAL]
    logger.warning("未映射的 rule=%s，按结构性处理", r)
    return [pl.HIT_STRUCTURAL]


def _num(item: Mapping[str, Any], key: str) -> float | None:
    v = item.get(key)
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def build_manual_payload(
    *,
    finding: Mapping[str, Any],
    series: Sequence[SeriesRow],
    attrs: ResourceAttrs,
    operator_note: str = "",
    locale: str = "zh",
    resource_reachable: bool = False,
    window_days: int = WINDOW_DAYS,
) -> dict[str, Any]:
    """finding 行 + 库里的序列 + describe 出的 attrs → 一条合法载荷。

    🔴 `resource_reachable` 默认 **False**。这条路的绝大多数调用来自**成员
       账号**的 finding，而巡检 space 在部署账号里 —— DA 对成员账号够不到。
       默认 True 的后果（载荷契约里写着）：skill 会要求 DA 自己去取
       `DBLoad` / `DescribeEvents`，DA 拿到 AccessDenied 或者**解析到部署账号
       里的同名实例**，而 skill 强制的三选一表述里没有「我到不了那个账号」
       这一档 —— 最可能的输出是「PI is not enabled on this instance」，
       对一台明明开了 PI 的库说了假话。
       调用方确认是部署账号自己时再显式传 True。

    ⚠️ 不抛 `PayloadContractError` —— 校验由调用方在 `validate_payload` 那一步
       做，这样错误信息里是契约层的原话（它带着「为什么这条必须有」）。

    与批量判读对齐的两处（2026-10-10 review B11）：序列只取 `data_date` 往前
    `WINDOW_DAYS` 天；闲置的 `daily` 用 `daily_rows_for_lowdays`（CPU + 连接数两列）
    —— 改前闲置的 `daily` 恒为空，skill 第 4 步拿不到连接数峰值去对 `max_connections`。
    """
    from inspection.adapters import metrics_repo as mr
    from inspection.assemble import _correlated_section

    rule = str(finding.get("rule") or "")
    reasons = hit_reasons_for(rule)
    fam = mm.metric_family(attrs.service, attrs.engine)
    metric = str(finding.get("metric") or "")
    data_date = _data_date_of(finding)
    window = _window_of(data_date, window_days)
    if window is not None:
        series = [r for r in series if window[0] <= r.data_date <= window[1]]

    # `judgment` 段：`threshold_high` 类**必须**有它（validate_payload 会拦）。
    # ⚠️ 闲置类的 metric 段是 `-`（复合判定，没有单一指标），那时不构造 judgment
    #    —— 塞一个 metric="-" 的 judgment 会让 skill 去找一个不存在的指标。
    judgment: pl.Judgment | None = None
    if metric and metric != "-":
        judgment = pl.Judgment(
            metric=metric,
            stat=mm.judge_stat_of(metric, fam) or "Average",
            value=_num(finding, "value"),
            threshold=_num(finding, "threshold"),
            headroom=_num(finding, "headroom"),
            consecutive_high_days=int(finding.get("consecutive_hits") or 0),
            coverage_days=len({r.data_date for r in series}) or None,
            raw_value=_num(finding, "raw_value"),
            denominator=_num(finding, "denominator"),
        )

    # `cost` 段：有金额才带。
    # ⚠️ `validate_payload` 要求 cost 存在时**必须**同时有 `savings_estimate`
    #    与非空 `price_precision`，且只有成本类 hit_reason 才允许带 cost。
    #
    # 🔴 判据用契约自己的 `COST_BEARING_HIT_REASONS`（= {idle, structural}），
    #    **不要**只判 `HIT_IDLE`。只判 idle 时比契约更严，代价落在超配类上：
    #
    #    ```
    #    oversized_storage / oversized_memory
    #      hit_reasons_for() → [HIT_STRUCTURAL]（走 startswith("oversized_")）
    #      → 旧判据不成立 → 载荷里没有 cost 段
    #      → 而 run_type_for() 又把它路由到 inspection-cost-idle
    #      ⇒ 那份 skill 的第 4 步「报告金额并说明精度档」拿不到输入
    #    ```
    #
    #    也就是一条「RDS 存储开太大」的深入分析**看不到预计月省**，
    #    而金额正是这一页唯一的决策依据。行上明明有这两个字段。
    cost: dict[str, Any] | None = None
    savings = _num(finding, "savings_usd")
    precision = str(finding.get("savings_precision") or "").strip()
    if savings is not None and precision and (
            set(reasons) & pl.COST_BEARING_HIT_REASONS):
        cost = {"savings_estimate": savings, "price_precision": precision}

    # 结构性段：`validate_payload` 要求 structural 类必须带它。
    structural: dict[str, Any] | None = None
    if pl.HIT_STRUCTURAL in reasons:
        structural = {"rule": rule, "params": {}}

    threshold_config: dict[str, Any] | None = None
    if metric and metric != "-":
        threshold_config = {
            "metric": metric,
            "direction": getattr(mm.direction_of(metric), "value", pl.DIR_BAD_UP),
            "value": _num(finding, "threshold"),
        }

    bundle = _SeriesBundle(series)
    if pl.HIT_IDLE in reasons:
        daily = mr.daily_rows_for_lowdays(bundle, attrs)
    else:
        daily = [
            {"date": r.data_date.isoformat(), "value": r.value}
            for r in sorted(series, key=lambda r: r.data_date)
            if metric and metric != "-" and r.metric == metric
        ]
    return pl.build_payload(
        finding_id=str(finding.get("finding_id") or ""),
        account_id=attrs.account_id,
        region=attrs.region,
        instance=attrs.instance_id,
        engine=attrs.engine,
        metric_family=fam,
        data_date=data_date,
        hit_reason=reasons,
        severity=Severity.coerce(str(finding.get("severity") or "INFO")),
        judgment=judgment,
        daily=daily,
        correlated=_correlated_section(bundle, attrs, fam),
        threshold_config=threshold_config,
        attrs=attrs,
        cost=cost,
        structural=structural,
        config_version=str(finding.get("rule_version") or ""),
        locale=locale,
        resource_reachable=resource_reachable,
        operator_note=operator_note,
    )


def _utc_today() -> date:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).date()


def load_finding(store: InspectionStore, account_id: str, finding_id: str) -> dict[str, Any]:
    """读一条 finding 行。不存在或已 resolved 都抛。

    ⚠️ `resolved` 的行要拒：它的 evidence 字段在 resolve 时被 `REMOVE` 掉了
       （`_EVIDENCE_FIELDS`），载荷里会缺 value / threshold / idle_factors。
       而那不是「数据缺失」——是「这条风险已经没了」，派一次判读去分析一个
       不存在的问题只会得到一段自相矛盾的文字。
    """
    item = store.get_finding_item(account_id, finding_id)
    if not item:
        raise ManualJudgeError(
            f"finding 不存在: {finding_id}（账号 {account_id}）", code="not_found")
    state = str(item.get("state") or "")
    if state == "resolved":
        raise ManualJudgeError(
            "这条 finding 已标记为「已解决」——它的判定证据在 resolve 时被清掉了，"
            "派判读只会得到一段自相矛盾的分析。要重新评估请等下一轮巡检把它重新命中。",
            code="conflict")
    existing = str(item.get("da_task_id") or "")
    if existing:
        # 🔴 「派过」分三种，只有最后一种放行（2026-10-10 review B2）：
        #
        #    在路上        da_updated_at 不存在，或早于 da_dispatched_at（批量派发保留了旧判读）
        #    回来了、有内容  ok / partial / parse_failed / skipped …  → 再派只是重复花钱
        #    回来了、没内容  RETRYABLE_PARSE_STATUSES                → 放行「重新分析」
        #
        #    改前三种一律 `already_dispatched`，而界面在第三种上写着「需要重新派发」——
        #    钱花了，路走不通。
        if judge_in_flight(item):
            raise ManualJudgeError(
                f"这条正在分析中（task {existing}）。等它回来，或去 DevOps Agent "
                "后台看进度 —— 重复派发会重复烧额度，而两份判读回填到同一行只会互相覆盖。",
                code="already_dispatched")
        status = str(item.get("da_parse_status") or "")
        if status not in RETRYABLE_PARSE_STATUSES:
            raise ManualJudgeError(
                f"这条已经有分析结果了（task {existing}）。重复派发会重复烧额度。",
                code="already_dispatched")
        retries = int(item.get("judge_retries") or 0)
        if retries >= MAX_JUDGE_RETRIES:
            raise ManualJudgeError(
                f"这条已经重新分析过 {retries} 次，仍然没有拿到结果（最近一次 task "
                f"{existing}）。不再继续重派，避免反复计费；请到 DevOps Agent 后台"
                "查看这个 task 的执行记录。",
                code="retry_exhausted")
    return dict(item)


RETRYABLE_PARSE_STATUSES: frozenset[str] = frozenset({
    "empty", "missing_section", "investigation_failed", "investigation_timed_out",
    "no_callback",
})
"""判读回来了但**没有内容**、再派一次有意义的那些 `da_parse_status`。

⚠️ 不含 `skipped_by_skill`（skill 的 skip 判据命中，重派结果一样）、
   `parse_failed`（有原文，读侧显示为部分结果）、`quota_exhausted`（本月额度用尽）。
"""

MAX_JUDGE_RETRIES = 2
"""同一段生命周期里「重新分析」最多几次（首次派发不算）。"""


def judge_in_flight(item: Mapping[str, Any]) -> bool:
    """这条 finding 当前的那个 task 还没回来。

    `da_updated_at` 是结果落库的时刻，`da_dispatched_at` 是派发时刻；结果早于派发
    = 那是上一个 task 的结果（批量派发保留旧判读，见 `mark_judge_dispatched`）。
    """
    if not item.get("da_task_id"):
        return False
    upd = item.get("da_updated_at")
    if upd is None:
        return True
    disp = item.get("da_dispatched_at")
    try:
        return disp is not None and float(upd) < float(disp)
    except (TypeError, ValueError):
        return False


# ── 派发 ────────────────────────────────────────────────────────────────────
#
# 🔴 这条路**不碰 run 记录**：不抢 `try_acquire_run_lock`、不 `put_run`、
#    不进 `build_stats` 的 completeness、不参与 reconciler 的缺行判定。
#    理由见模块 docstring —— 走 run 流水线会占掉当天的巡检槽位，
#    也就是「点一次深入分析 → 当天的正式定时轮不再执行」。
#
# ⚠️ 但它**照样受 kill switch 管**。那个开关（`appconfig#inspection/enabled`）
#    是急停，不是省钱护栏 —— 拉停的场景通常就是「DA 那边在出问题」，
#    那时仍然允许有人一条条点着派，等于开关没关上。
#    判据由调用方（executor 的入口）复用既有的那一处检查，不在这里重做。

# `run_id` 只是 `put_dispatch` 的记录字段（不参与任何调度判据）。
# 用一个**可识别的常量**而不是真 run_id：排查时一眼能看出这条 dispatch 不属于
# 任何一轮定时巡检。⚠️ 不能留空 —— `put_dispatch` 会把它写进行里，
# 空值会让对账那侧的日志读起来像「run_id 丢了」。
MANUAL_RUN_ID = "manual-judge"


def run_type_for(rule: str) -> RunType:
    """`rule` → `RunType`。**决定用哪份 skill**。

    🔴 这不是一个记录字段，而是**路由本身**。`task_builder.routing_header()`
       按 RunType 选 description 的开头措辞，而两份判读 skill 的激活靠 DA 对
       description 做模型匹配（不是显式挂载）：

    ```
    RunType.HIGH  「资源巡检 · 高负载判读请求…」  → inspection-high-load
    RunType.IDLE  「资源巡检 · 闲置与成本判读请求…」→ inspection-cost-idle
    ```

    ⚠️ 第一版我传了一个字符串 `"manual"`，两处后果：
         `build_title`      `run_type is RunType.HIGH` 为假 → 标题恒说「闲置与成本」
         `routing_header`   `run_type not in _ROUTING_HEADER` → **当场抛**
       也就是说手动派发对高负载 finding 会直接失败，对闲置 finding 会
       侥幸正确 —— 而后者是最坏的，因为它掩盖了前者。

    ⚠️ 结构性（`gp2_volume` / `engine_eol` / …）走 IDLE：`cost-idle` 的 scope
       逐字写着 `hit_reason` ∈ {idle, structural}，高负载那份明确把它排除。
    """
    reasons = hit_reasons_for(rule)
    return RunType.HIGH if pl.HIT_THRESHOLD_HIGH in reasons else RunType.IDLE


def dispatch_manual_judge(
    *,
    store: InspectionStore,
    config_table: Any,
    account_id: str,
    finding_id: str,
    deploy_account_id: str,
    home_region: str,
    describe_attrs,
    operator_note: str = "",
    locale: str = "zh",
    env_space_id: str = "",
    skills_root=None,
    today: date | None = None,
    load_exclusions: Callable[[RunType], Sequence[Any]] | None = None,
) -> JudgeResult:
    """给一条 finding 派一次 DA 判读。返回回执，失败抛 `ManualJudgeError`。

    Args:
        describe_attrs: `(account_id, region, service, instance_id) -> ResourceAttrs`。
            **注入而不是内部实现** —— describe 要跨账号 assume，那部分属于
            executor 的 IO 层（`_session_for`，带账号段校验）。这里保持纯粹，
            测试也就不必 mock boto3。
        load_exclusions: `RunType -> [scope.ExclusionEntry]`。缺省不查排除清单
            （只有测试这么用）；executor 传 `handler.load_exclusions`。

    步骤（每一步都可能失败，失败都要能说清是哪一步）。**便宜的检查在前**，
    跨账号 describe 与真正花钱的 CreateBacklogTask 在后（2026-10-10 review B6）：

    ```
    ① 读 finding 行        不存在 / 已 resolved / 在路上 / 有结果 / 重派用完 → 拒
    ② 读库里的序列          零 CloudWatch；窗口内一行都没有 → 拒（no_series）
    ③ 解析巡检 space + client  缺巡检 Agent Space → 拒（不必先做 describe）
    ④ describe 那一台       engine + attrs（唯一一次跨账号 API）；已不存在 → 拒并打标
    ⑤ 排除清单              客户已「移出巡检范围」→ 拒（out_of_scope）
    ⑥ 拼载荷 + 过契约校验    契约层的报错原话直接回传（它带着「为什么必须有」）
    ⑦ 下发 skill            失败 → 拒（skill_unavailable，没有计费）
    ⑧ 领租约 + 尝试序号      并发的另一次点击 → 拒；序号进 clientToken
    ⑨ CreateBacklogTask
    ⑩ put_dispatch          ← 判读结果回拼到这条 finding 的唯一锚点
    ⑪ 打标                  da_task_id + da_dispatched_at，清掉上一份失败的结果
    ```
    """
    from inspection.adapters import da_client
    from inspection.adapters.skill_upload import ensure_skills
    from inspection.domain import task_builder as tb

    checked = today or _utc_today()

    # ① ---------------------------------------------------------------------
    finding = load_finding(store, account_id, finding_id)
    region = str(finding.get("region") or "")
    service = str(finding.get("service") or "")
    instance_id = str(finding.get("instance_id") or "")
    if not (region and service and instance_id):
        raise ManualJudgeError(
            f"finding 行缺 region/service/instance_id，无法定位资源: {finding_id}")
    seen_task_id = str(finding.get("da_task_id") or "")
    rule = str(finding.get("rule") or "")
    reasons = hit_reasons_for(rule)
    run_type = run_type_for(rule)
    data_date = _parse_date(_data_date_of(finding))

    # ② ---------------------------------------------------------------------
    try:
        series = store.query_series(account_id, region, service, instance_id)
    except Exception as e:                             # noqa: BLE001
        # ⚠️ 序列读失败**不能**静默降级成空列表：`correlated` 会全变
        #    `no_datapoints`，而那对 skill 的含义是「可能是 standby，别删」——
        #    一个读表故障会被读成一条业务结论。
        raise ManualJudgeError(f"读指标序列失败: {e}", code="internal") from e
    window = _window_of(data_date.isoformat())
    in_window = [r for r in series if window and window[0] <= r.data_date <= window[1]]
    if not in_window and (
            pl.HIT_IDLE in reasons or pl.HIT_THRESHOLD_HIGH in reasons):
        # 🔴 闲置 / 高负载的判读全靠这 7 天的序列。一行都没有（停更超过序列库的
        #    35 天保留期）时派出去，`correlated` 全是 `no_datapoints` —— 那对 skill
        #    的含义是「可能是 standby，别删」：花了钱，换来一个由缺数据造出来的结论。
        #    结构性规则（gp2 / EOL / 单 AZ）靠 describe 出的属性，不受影响。
        raise ManualJudgeError(
            f"这条的指标数据（截至 {data_date.isoformat()}）已超过保留期，"
            "没有可供分析的序列。等下一次正式巡检重新评估后再分析；"
            "这次没有发起分析，也没有计费。",
            code="no_series")

    # ③ ---------------------------------------------------------------------
    try:
        space_id, client = da_client.resolve(
            account_id,
            deploy_account_id=deploy_account_id,
            home_region=home_region,
            config_table=config_table,
            env_space_id=env_space_id,
            source="inspection-manual-judge",
        )
    except da_client.DaTargetUnavailable as e:
        raise ManualJudgeError(
            f"这个账号还没有可用的巡检 Agent Space（{e}）。"
            "到管理页确认该账号那一行填了「巡检 Agent Space ID」；"
            "这次没有发起分析，也没有计费。",
            code="bad_request") from e

    # ④ ---------------------------------------------------------------------
    try:
        attrs = describe_attrs(account_id, region, service, instance_id)
    except DescribeIncomplete as e:
        # 不知道它还在不在 —— **不打标**，按钮留着，稍后可以重试。
        raise ManualJudgeError(
            f"暂时确认不了 {instance_id} 还在不在：在账号 {account_id} 的 {region} 里"
            f"没能列全资源（{e}）。通常是采集角色权限不足或被限流，稍后再试；"
            "这次没有发起分析，也没有计费。",
            code="describe_incomplete") from e
    except Exception as e:                             # noqa: BLE001
        raise ManualJudgeError(
            f"读取资源属性失败（{instance_id} @ {region}）: {e}。"
            "这一步要跨账号 assume + describe —— 确认该账号已接入且采集角色可用。",
            code="internal") from e
    if attrs is None:
        # 🔴 列全了、里面没有它 = 资源已经不存在。**在 finding 行上打标**，前端据此
        #    不再给「深入分析」按钮（2026-10-10 客户实测：不打标的话按钮一直在，
        #    再点还是同一句报错）。打标失败不影响这次的回答，只记日志。
        # ⚠️ 同一台资源上的**其余**开着的 finding 一起打标（闲置 + 存储超配是两条）。
        #    只标点的那一条的话，抽屉里切到「存储超配」那条，按钮又出现了。
        prefix = "#".join(finding_id.split("#")[:4]) + "#"
        ids = [finding_id]
        try:
            ids += sorted(fid for fid, rec in store.load_findings(account_id).items()
                          if fid != finding_id and fid.startswith(prefix)
                          and rec.state.is_open)
        except Exception as e:                         # noqa: BLE001
            logger.error("手动判读：读同一台资源的其余 finding 失败（只标这一条）: %s", e)
        for fid in ids:
            try:
                store.mark_resource_missing(account_id, fid, today=checked)
            except Exception as e:                     # noqa: BLE001
                logger.error("手动判读：资源已不存在，但打标失败（不影响回答）%s: %s", fid, e)
        raise ManualJudgeError(
            f"这台资源已经不存在了：在账号 {account_id} 的 {region} 里查不到 "
            f"{instance_id}（{checked.isoformat()} 核实）。不需要再分析，这次没有发起"
            "分析，也没有计费；看板上已不计入合计。",
            code="resource_gone")

    # ⑤ ---------------------------------------------------------------------
    if load_exclusions is not None:
        _refuse_if_excluded(attrs, _scope_run_type(rule), load_exclusions,
                            today=checked)

    # ⑥ ---------------------------------------------------------------------
    payload = build_manual_payload(
        finding=finding, series=series, attrs=attrs,
        operator_note=operator_note, locale=locale,
        # 🔴 只有部署账号自己够得到（巡检 space 在部署账号里）。
        resource_reachable=(account_id == deploy_account_id),
    )
    try:
        pl.validate_payload(payload)
    except pl.PayloadContractError as e:
        # 原话回传 —— 契约层的报错里带着「为什么这一条必须有」，
        # 换成一句「载荷不合法」等于把那段说明丢掉。
        raise ManualJudgeError(f"载荷不满足契约: {e}", code="internal") from e

    # ⑦ ---------------------------------------------------------------------
    # ⚠️ `ensure_skills` **从不抛**（它自己的约定），失败返回 `failed:…`。
    # 🔴 失败就**拒**（2026-10-10 review B12）。skill 不在，DA 退化成通用发挥 →
    #    切不出 `## <finding_id>` → `da_parse_status=parse_failed`，额度照花。
    #    批量路径不中止是因为指标钱已经花了（沉没成本）；这里点一次就是一笔单独的花费。
    skill_state = ensure_skills(
        client, space_id, account_id=account_id, skills_root=skills_root)
    if skill_state.startswith("failed"):
        logger.error("手动判读：skill 下发失败，拒绝派发: %s", skill_state)
        raise ManualJudgeError(
            "分析方法论没能同步到这个账号的巡检 Agent Space，这次没有发起分析，"
            "也没有计费。稍后再试；反复出现请到管理页检查该账号的 Agent Space 关联。",
            code="skill_unavailable")

    # ⑧ ---------------------------------------------------------------------
    attempt = store.claim_judge_attempt(
        account_id, finding_id, seen_task_id=seen_task_id, retry=bool(seen_task_id))
    if attempt is None:
        raise ManualJudgeError(
            "这条刚刚已经有人发起了分析，等它回来就好 —— 这次没有重复计费。",
            code="already_dispatched")

    # ⑨ ---------------------------------------------------------------------
    # 🔴 clientToken 带尝试序号（2026-10-10 review B14）。改前同一条 finding 的 token
    #    恒定，而 DA 的幂等缓存长期有效 ⇒ 重新分析拿回上一次那个已结束的 task，
    #    映射写上了、callback 却不会再来。`run_id` 只进 token；映射行上仍写
    #    `MANUAL_RUN_ID`（排查时一眼看出不属于定时轮）。
    req = tb.build_task(
        run_type=run_type, account_id=account_id, data_date=data_date,
        run_id=f"{MANUAL_RUN_ID}#{attempt}", agent_space_id=space_id,
        payloads=[payload])
    try:
        resp = client.create_backlog_task(**req.to_api_kwargs())
    except Exception as e:                             # noqa: BLE001
        store.release_judge_claim(account_id, finding_id)
        raise ManualJudgeError(
            f"发起判读失败: {e}", code="internal") from e

    task_id = _task_id_of(resp)
    if not task_id:
        # 🔴 task 已经发出去了（会花额度）但拿不到 id ⇒ 这次判读的结果
        #    **永久无法回拼**。必须当失败报，否则界面显示「已派发」，
        #    而客户等一个永远不会出现在这条 finding 上的答案。
        logger.error("手动判读：派发成功但响应里没有 taskId，resp_keys=%s",
                     sorted((resp or {}).keys()))
        store.release_judge_claim(account_id, finding_id)
        raise ManualJudgeError(
            "判读已发起，但 API 响应里没有 task id —— 这次的结果无法回拼到这条 "
            "finding。请到 DevOps Agent 后台查看该 space 的最新任务。",
            code="internal")

    # ⑩ ---------------------------------------------------------------------
    try:
        store.put_dispatch(
            task_id, account_id=account_id, run_id=MANUAL_RUN_ID,
            # ⚠️ 这里写**真的** run_type（`high` / `idle`）而不是 `"manual"`：
            #    对账那侧按它归类，一个它不认识的值会让这条 dispatch 落进
            #    「未知类型」而不是被正常跟踪。
            #    「这条不属于定时轮」由 `run_id == MANUAL_RUN_ID` 表达。
            run_type=run_type.value, data_date=data_date,
            finding_ids=[finding_id], agent_space_id=space_id,
            client_token=req.client_token,
            # 🔴 TTL 从**写入当天**起算（review B9）：`data_date` 是 evidence_as_of，
            #    停更几周的 finding 按它算，映射一写进去就已过期。
            ttl_from=checked)
    except Exception as e:                             # noqa: BLE001
        # 🔴 映射写失败 = 结果回不来。task 已经在跑了，所以**要如实报错**
        #    而不是当成功 —— 这是「已经花了钱且拿不到东西」，最该让人知道。
        logger.exception("手动判读：put_dispatch 失败，判读结果将无法回拼")
        store.release_judge_claim(account_id, finding_id)
        raise ManualJudgeError(
            f"判读已发起（task {task_id}）但映射写入失败：{e}。"
            "结果无法自动回填到这条 finding —— 请到 DevOps Agent 后台直接查看。",
            code="internal") from e

    # ⑪ 立刻在 finding 行上打标 —— **不等 callback** ------------------------
    #
    # 🔴 `da_task_id` 原本只在 DA 回调回来时才写（`attach_judgment`），
    #    也就是派发之后的 1~3 分钟里 finding 行上没有它。而那个字段同时是
    #    两处「已经派过了」的判据：
    #
    #    ```
    #    前端  `!f.da_task_id`          决定「深入分析」按钮渲不渲染
    #    后端  load_finding()           拒绝重复派发
    #    ```
    #
    #    两处在窗口期内**都失效**（2026-08-31 客户实测）：点完拿到「判读已派发」，
    #    再点开那条 finding 按钮还在、还能点 → 派第二个 task →
    #    两份判读回填到同一行互相覆盖，而额度花了两次。
    #
    # ⚠️ **放在 put_dispatch 之后**。反过来的话：打标成功但映射写失败 ⇒
    #    行上有 da_task_id（按钮消失、后端也拒绝重派）而结果永远回不来 ——
    #    那条 finding 被永久锁死在「等一个不会来的判读」。
    #    现在的顺序下，映射失败会走上面那个 raise，行上还是干净的，可以重试。
    #
    # ⚠️ `clear_previous=True`：重新分析时清掉上一份失败的结果，否则行上同时
    #    挂着新 task_id 与旧的 parse_status，读侧会把还在跑的这次显示成「失败」。
    #
    # ⚠️ 打标失败**不算派发失败**：task 在跑、映射也写好了，结果照样会回填。
    #    租约还在，120 秒内的重复点击仍会被挡住。所以记 error 而不是抛。
    try:
        marked = store.mark_judge_dispatched(
            account_id, finding_id, task_id=task_id, clear_previous=True)
    except Exception as e:                             # noqa: BLE001
        logger.error("手动判读：打标异常: %s", e)
        marked = False
    if not marked:
        logger.error(
            "手动判读：给 finding 打标失败（行不存在？）—— 那 1~3 分钟里"
            "「深入分析」按钮还会在，可能被重复点: finding=%s", finding_id)

    logger.info("手动判读已派发: finding=%s account=%s task=%s space=%s skill=%s "
                "attempt=%s", finding_id, account_id, task_id, space_id, skill_state,
                attempt)
    return JudgeResult(
        finding_id=finding_id, account_id=account_id, task_id=task_id,
        agent_space_id=space_id, payload_chars=pl.payload_chars(payload))


def _scope_run_type(rule: str) -> RunType:
    """这条 rule 归哪一轮管 —— 决定查哪一份排除清单。

    ⚠️ 不能用 `run_type_for`（那是 skill 路由）：`no_capacity_metadata` /
       `unsupported_engine` 由**高负载轮**产出、受高负载那份清单管
       （`resolve_out_of_scope` 按 run 的规则域关闭），判读却走 cost-idle。
    """
    from inspection.assemble import rules_for_run_type

    return RunType.HIGH if rule in rules_for_run_type(RunType.HIGH) else RunType.IDLE


def _refuse_if_excluded(
    attrs: ResourceAttrs, run_type: RunType,
    load_exclusions: Callable[[RunType], Sequence[Any]], *, today: date,
) -> None:
    """客户已「移出巡检范围」的资源不派（2026-10-10 review B7）。

    排除只写 `inspscope#` 行，finding 要等下一次**正式**巡检才关闭 —— 定时关着的
    账号里它会一直挂着。那段时间里照派，分析的是一台客户说过「别管它」的资源。

    ⚠️ 读清单失败**不拦**：排除清单是客户的偏好，不是安全边界；因为一次读表故障
       把所有「深入分析」都变成失败不值得。
    """
    from inspection.domain import scope

    try:
        entries = list(load_exclusions(run_type))
    except Exception as e:                             # noqa: BLE001
        logger.error("手动判读：读排除清单失败（不拦）: %s", e)
        return
    ref = scope.ResourceRef(
        account_id=attrs.account_id, service=attrs.service,
        instance_id=attrs.instance_id, cluster_id=attrs.cluster_id,
        region=attrs.region)
    decision = scope.is_excluded(
        ref, entries, today, list_kind=scope.ScopeList(run_type.value))
    if decision.excluded:
        entry = decision.matched
        until = getattr(entry, "expires_at", None)
        tail = f"（到 {until.isoformat()}）" if until else ""
        raise ManualJudgeError(
            f"这台资源已被移出巡检范围{tail}，不再分析。要分析请先在「巡检范围」里"
            "恢复它；这次没有发起分析，也没有计费。",
            code="out_of_scope")


def _parse_date(s: str) -> date:
    """`YYYY-MM-DD` → date。解析失败抛（不静默用今天）。

    ⚠️ 静默落回今天的表现是 `put_dispatch` 的 `data_date` 与载荷里的
       `data_date` 不一致，而对账那侧按前者找批次 —— 找不到就当「事件丢了」
       去重投，重复烧额度。
    """
    from datetime import datetime
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError as e:
        raise ManualJudgeError(
            f"finding 行上的 data_date 不是 YYYY-MM-DD: {s!r}", code="internal") from e


def _task_id_of(resp: Mapping[str, Any] | None) -> str:
    """从 `CreateBacklogTask` 的响应里取 task id。

    ⚠️ 响应体是 **WRAPPED**：`{"task": {"taskId": …}}`，顶层没有 `taskId`。
       executor 那侧第一版只找顶层，恒返回空 —— 于是每一条判读都回不来。
       这里与 `lambda_inspection_executor.handler._task_id_of` 是同一个判据；
       两处分叉的表现是「批量能回拼、手动回不来」。
    """
    r = dict(resp or {})
    inner = r.get("task") if isinstance(r.get("task"), Mapping) else {}
    for src in (inner, r):
        for k in ("taskId", "TaskId", "task_id", "id"):
            v = (src or {}).get(k)
            if v:
                return str(v)
    return ""
