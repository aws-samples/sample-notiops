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
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from typing import Any

from inspection.adapters import keys
from inspection.adapters.store import InspectionStore, SeriesRow
from inspection.domain import metrics_meta as mm
from inspection.domain import payload as pl
from inspection.domain.dto import ResourceAttrs, Severity, StructuralRule
from inspection.domain.schedule import RunType

logger = logging.getLogger(__name__)


class ManualJudgeError(Exception):
    """这次按需判读没法进行。`code` 供调用方转成 HTTP 状态。"""

    def __init__(self, message: str, *, code: str = "bad_request") -> None:
        super().__init__(message)
        self.code = code


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
    """把 `store.query_series()` 的行喂给既有的 `_correlated_section`。

    🔴 只实现 `.daily()` —— 那是 `_correlated_section` 唯一用到的 bundle 方法
       （2026-08-31 逐字核过它的源码）。实现更多方法只会让人以为这是一个
       完整的 bundle 替身，而它不是。

    ⚠️ 按 `data_date` 排序后再取值。DDB 的 query 按 SK 字典序返回，而 SK 是
       `<metric>#<stat>#<date>` —— 同一 (metric, stat) 下日期恰好也是字典序，
       所以**当前**是对的。但那是巧合而不是保证（换个 SK 结构就不成立），
       而序列顺序错了的表现是 skill 读到一条时间倒着走的趋势，
       它会把「在下降」说成「在上升」。所以这里显式排。
    """

    def __init__(self, rows: Sequence[SeriesRow]) -> None:
        buckets: dict[tuple[str, str, str], list[tuple[date, float | None]]] = {}
        for r in rows:
            buckets.setdefault(
                (r.instance_id, r.metric, r.stat), []).append((r.data_date, r.value))
        self._m = {
            k: [v for _, v in sorted(pairs, key=lambda p: p[0])]
            for k, pairs in buckets.items()
        }

    def daily(self, instance_id: str, metric: str, stat: str) -> list[float | None]:
        return list(self._m.get((instance_id, metric, stat), []))


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
    """
    from inspection.assemble import _correlated_section

    rule = str(finding.get("rule") or "")
    reasons = hit_reasons_for(rule)
    fam = mm.metric_family(attrs.service, attrs.engine)
    metric = str(finding.get("metric") or "")

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
    return pl.build_payload(
        finding_id=str(finding.get("finding_id") or ""),
        account_id=attrs.account_id,
        region=attrs.region,
        instance=attrs.instance_id,
        engine=attrs.engine,
        metric_family=fam,
        # ⚠️ `evidence_as_of` 而不是「今天」：载荷契约里 `data_date` 是
        #    「窗口里最后一个完整 UTC 日」，而 skill 被明确禁止说「今天」。
        #    用今天会让报告里的日期与看板上那条 finding 的日期差一天。
        data_date=str(finding.get("evidence_as_of")
                      or finding.get("last_run_date") or date.today().isoformat()),
        hit_reason=reasons,
        severity=Severity.coerce(str(finding.get("severity") or "INFO")),
        judgment=judgment,
        daily=[
            {"date": r.data_date.isoformat(), "value": r.value}
            for r in sorted(series, key=lambda r: r.data_date)
            if metric and metric != "-" and r.metric == metric
        ],
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
        raise ManualJudgeError(
            f"这条已经派过判读了（task {existing}）。等它回来，或去 DevOps Agent "
            "后台看进度 —— 重复派发会重复烧额度，而两份判读回填到同一行只会互相覆盖。",
            code="already_dispatched")
    return dict(item)


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
) -> JudgeResult:
    """给一条 finding 派一次 DA 判读。返回回执，失败抛 `ManualJudgeError`。

    Args:
        describe_attrs: `(account_id, region, service, instance_id) -> ResourceAttrs`。
            **注入而不是内部实现** —— describe 要跨账号 assume，那部分属于
            executor 的 IO 层（`_session_for`，带账号段校验）。这里保持纯粹，
            测试也就不必 mock boto3。

    步骤（每一步都可能失败，失败都要能说清是哪一步）：

    ```
    ① 读 finding 行        不存在 / 已 resolved / 已派过  → 拒
    ② 读库里的序列          零 CloudWatch
    ③ describe 那一台       engine + attrs（唯一一次跨账号 API）
    ④ 拼载荷 + 过契约校验    契约层的报错原话直接回传（它带着「为什么必须有」）
    ⑤ 解析巡检 space + client
    ⑥ 下发 skill            失败**不阻断**（返回 failed:… 由日志承载）
    ⑦ CreateBacklogTask
    ⑧ put_dispatch          ← 判读结果回拼到这条 finding 的唯一锚点
    ```
    """
    from inspection.adapters import da_client
    from inspection.adapters.skill_upload import ensure_skills
    from inspection.domain import task_builder as tb

    # ① ---------------------------------------------------------------------
    finding = load_finding(store, account_id, finding_id)
    region = str(finding.get("region") or "")
    service = str(finding.get("service") or "")
    instance_id = str(finding.get("instance_id") or "")
    if not (region and service and instance_id):
        raise ManualJudgeError(
            f"finding 行缺 region/service/instance_id，无法定位资源: {finding_id}")

    # ② ---------------------------------------------------------------------
    try:
        series = store.query_series(account_id, region, service, instance_id)
    except Exception as e:                             # noqa: BLE001
        # ⚠️ 序列读失败**不能**静默降级成空列表：`correlated` 会全变
        #    `no_datapoints`，而那对 skill 的含义是「可能是 standby，别删」——
        #    一个读表故障会被读成一条业务结论。
        raise ManualJudgeError(f"读指标序列失败: {e}", code="internal") from e

    # ③ ---------------------------------------------------------------------
    try:
        attrs = describe_attrs(account_id, region, service, instance_id)
    except Exception as e:                             # noqa: BLE001
        raise ManualJudgeError(
            f"读取资源属性失败（{instance_id} @ {region}）: {e}。"
            "这一步要跨账号 assume + describe —— 确认该账号已接入且采集角色可用。",
            code="internal") from e
    if attrs is None:
        raise ManualJudgeError(
            f"资源不存在或已被删除: {instance_id} @ {region}。"
            "这条 finding 可能已经过期 —— 等下一轮巡检把它标成「已解决」。",
            code="not_found")

    # ④ ---------------------------------------------------------------------
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

    # ⑤ ---------------------------------------------------------------------
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
            f"解析不出这个账号的巡检 Agent Space（{e}）。"
            "到管理页确认该账号那一行填了「巡检 Agent Space ID」。",
            code="bad_request") from e

    # ⑥ ---------------------------------------------------------------------
    # ⚠️ `ensure_skills` **从不抛**（它自己的约定）。失败返回 `failed:…`。
    #    这里不因为它失败而中止：task 照样能发，DA 会用通用提示词回答 ——
    #    比「点了没反应」好。但要把状态写进日志，否则「skill 没下发」
    #    与「skill 下发了但 DA 没用」在事后完全分不开。
    skill_state = ensure_skills(
        client, space_id, account_id=account_id, skills_root=skills_root)
    if skill_state.startswith("failed"):
        logger.error("手动判读：skill 下发失败（继续派发）: %s", skill_state)

    # ⑦ ---------------------------------------------------------------------
    data_date = _parse_date(str(payload["data_date"]))
    run_type = run_type_for(str(finding.get("rule") or ""))
    req = tb.build_task(
        run_type=run_type, account_id=account_id, data_date=data_date,
        run_id=MANUAL_RUN_ID, agent_space_id=space_id, payloads=[payload])
    try:
        resp = client.create_backlog_task(**req.to_api_kwargs())
    except Exception as e:                             # noqa: BLE001
        raise ManualJudgeError(
            f"发起判读失败: {e}", code="internal") from e

    task_id = _task_id_of(resp)
    if not task_id:
        # 🔴 task 已经发出去了（会花额度）但拿不到 id ⇒ 这次判读的结果
        #    **永久无法回拼**。必须当失败报，否则界面显示「已派发」，
        #    而客户等一个永远不会出现在这条 finding 上的答案。
        logger.error("手动判读：派发成功但响应里没有 taskId，resp_keys=%s",
                     sorted((resp or {}).keys()))
        raise ManualJudgeError(
            "判读已发起，但 API 响应里没有 task id —— 这次的结果无法回拼到这条 "
            "finding。请到 DevOps Agent 后台查看该 space 的最新任务。",
            code="internal")

    # ⑧ ---------------------------------------------------------------------
    try:
        store.put_dispatch(
            task_id, account_id=account_id, run_id=MANUAL_RUN_ID,
            # ⚠️ 这里写**真的** run_type（`high` / `idle`）而不是 `"manual"`：
            #    对账那侧按它归类，一个它不认识的值会让这条 dispatch 落进
            #    「未知类型」而不是被正常跟踪。
            #    「这条不属于定时轮」由 `run_id == MANUAL_RUN_ID` 表达。
            run_type=run_type.value, data_date=data_date,
            finding_ids=[finding_id], agent_space_id=space_id,
            client_token=req.client_token)
    except Exception as e:                             # noqa: BLE001
        # 🔴 映射写失败 = 结果回不来。task 已经在跑了，所以**要如实报错**
        #    而不是当成功 —— 这是「已经花了钱且拿不到东西」，最该让人知道。
        logger.exception("手动判读：put_dispatch 失败，判读结果将无法回拼")
        raise ManualJudgeError(
            f"判读已发起（task {task_id}）但映射写入失败：{e}。"
            "结果无法自动回填到这条 finding —— 请到 DevOps Agent 后台直接查看。",
            code="internal") from e

    # ⑨ 立刻在 finding 行上打标 —— **不等 callback** ------------------------
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
    # ⚠️ 打标失败**不算派发失败**：task 在跑、映射也写好了，结果照样会回填。
    #    只是那 1~3 分钟里按钮还在（退化成修这个 bug 之前的行为）。
    #    所以记 error 而不是抛。
    if not store.mark_judge_dispatched(
            account_id, finding_id, task_id=task_id):
        logger.error(
            "手动判读：给 finding 打标失败（行不存在？）—— 那 1~3 分钟里"
            "「深入分析」按钮还会在，可能被重复点: finding=%s", finding_id)

    logger.info("手动判读已派发: finding=%s account=%s task=%s space=%s skill=%s",
                finding_id, account_id, task_id, space_id, skill_state)
    return JudgeResult(
        finding_id=finding_id, account_id=account_id, task_id=task_id,
        agent_space_id=space_id, payload_chars=pl.payload_chars(payload))


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
