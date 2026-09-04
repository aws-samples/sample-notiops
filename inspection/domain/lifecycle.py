"""finding 状态机（R6.2~R6.9 / R14.4， + 1.13a~c）。

## 为什么这个模块是纯函数

R14.4 要求 `reconcile_findings(上轮状态, 评估集合, 命中集合, today) -> [Transition]`
是纯函数。理由不是洁癖 —— 状态机的错误**只在跨天的序列里显形**：

```
「昨天 200 个风险全部解决」→ 第三天又全部以 new 冒出
```

要复现这个 bug，得能在测试里连跑 5 个虚拟的「天」。任何一处偷偷读库或取
`date.today()` 都会让这种测试变成不可能（R14.2）。

## 五个状态与两条对称的确认

```
                  ┌── 连续 2 轮命中 ──► active ──┐
        (首次命中) │                              │ 连续 2 轮未命中
  ──────────► new ┤                              ▼   且水位已回健康区
                  └── 未确认就消失 ──► (丢弃)   resolving ──► resolved
                                                  │
                                    水位仍在坏侧 ──┴──► chronic（留在看板）
```

`new_confirm_rounds = 2` 与 `resolved_confirm_rounds = 2` 是**刻意对称**的
（R1.0c）：一轮抖动既不该造出一条新风险，也不该消掉一条旧风险。

## 三条最容易写错的地方

```
R6.2  未被评估的实例，状态原地不动 —— 不是「按未命中处理」
R6.4  「本轮未命中」≠「已缓解」，水位仍在坏侧要转 chronic 而不是 resolved
R6.5  「已持续 N 天」由 first_seen_date 与 today 相减，不是 ADD days 1
```

三条的共同点：写错都会产出**看起来很正常**的数据。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date
from enum import Enum

from inspection.domain.dto import Severity

# R2.4a 总表的三个轮次常数。**写死，不开放配置**（与评分权重同规格）。
RESOLVED_CONFIRM_ROUNDS = 2
"""R6.3：连续 K 轮不命中才落 resolved，中间态 `resolving`。"""
NEW_CONFIRM_ROUNDS = 2
"""R1.0c：与 resolved 对称 —— 连续 2 轮命中才有推送资格。"""
BASELINE_ROUNDS = 3
"""R1.0b：新账号首 3 轮只写库不推送。"""


class FindingState(str, Enum):
    """R6.6 明确只保留这五个。

    ⚠️ `escalated` **不是状态**，它是标记 + 事件（`severity_trend: worsening`）。
    做成状态会让「升级后又缓解」无处可去 —— 那条 finding 既不是 active
    也不是 resolving，状态机会卡住。
    """

    NEW = "new"
    ACTIVE = "active"
    RESOLVING = "resolving"
    RESOLVED = "resolved"
    CHRONIC = "chronic"

    @property
    def is_open(self) -> bool:
        """是否仍在看板上。`chronic` **算开着** —— R6.4 要求它继续留在看板。"""
        return self is not FindingState.RESOLVED


class ResolutionKind(str, Enum):
    """R11d.4 / ：finding 是怎么结束的。

    ⚠️ 三值必须分开，它们对客户的含义完全不同：
    ```
    fixed            客户改了东西（扩容 / 换规格 / 改参数）→ 我们的建议起作用了
    self_relieved    负载自己降了（业务淡季 / 上游变更）→ 风险仍在，只是暂时不显
    prediction_missed 我们报了但它根本没恶化 → **误报**
    ```
    第三类是 R9.7 准确率闭环的**唯一**数据来源。把它并进 `fixed` 等于
    永久失去衡量误报率的能力 —— 而那正是客户判断这套系统值不值得看的依据。

    ⚠️ 第四类 `out_of_scope` 与前三类**不同轴**：前三类说的是「风险怎么没了」，
    它说的是「我们不再看了」—— 风险可能还在。所以它 SHALL NOT 参与 R9.7 的
    准确率统计（分子分母都不进），否则客户每排除一批噪音，误报率就跟着动一下。
    """

    FIXED = "fixed"
    SELF_RELIEVED = "self_relieved"
    PREDICTION_MISSED = "prediction_missed"
    OUT_OF_SCOPE = "out_of_scope"
    """客户把资源移出了巡检范围（R1.8）。**不是**风险消失了。

    🔴 2026-09-01 客户实测暴露的缺口：排除是**入口过滤**
    （`pipeline.apply_exclusions` 在拉指标之前跑，为的是不给「别看」的资源
    付 GetMetricData 的钱），于是被排除的实例掉出了评估集合：

    ```
    pipeline.py    attrs, excluded = apply_exclusions(...)   attrs 里已经没有它
                   evaluated_instance_ids = {a.instance_id for a in attrs} - failed
    lifecycle.py   if not _in_scope(fid, evaluated_set): continue   ← R6.2「原地不动」
    ```

    ⇒ 它**已有的** finding 永久冻在 `new` / `active`：既不 resolve、也不消失。
      客户原话：「他们等加入到白名单后 为什么仍然显示在findings里面当作噪音呢」。
      而 `exit_filter` 只挡本轮**新产出**的，管不到已经落库的行。

    ⚠️ 为什么不复用前三类：`fixed` 是「我们的建议起作用了」、`self_relieved`
      是「负载自己降了」、`prediction_missed` 是「误报」—— 三句对客户都是**假的**。
      尤其第三类：客户排掉一台已知的灾备备库，会被记成我们报错了一条。
    """


class TransitionKind(str, Enum):
    """一次状态变化的类型。载荷与 UI 都按它分支。"""

    CREATED = "created"
    """首次出现。"""
    CONFIRMED = "confirmed"
    """`new` 连续命中达标 → `active`（获得推送资格，R1.0c）。"""
    UNCHANGED = "unchanged"
    """仍命中，状态不变。**仍要产出** —— 它承载 last_run_date 的推进（R6.8）。"""
    WORSENED = "worsened"
    """R6.7：跨严重度档位恶化。⚠️ 不是「headroom 相对缩小 X%」。"""
    RELIEVING = "relieving"
    """本轮未命中，进入 `resolving` 观察期。"""
    RESOLVED = "resolved"
    """连续 K 轮未命中 **且** 水位回到健康区（R6.4）。"""
    CHRONIC = "chronic"
    """连续 K 轮未命中但水位仍在坏侧 → 留在看板（R6.4）。"""
    REOPENED = "reopened"
    """`resolving` 期间又命中 → 回到 `active`，观察计数清零。"""
    FORCE_RESOLVED = "force_resolved"
    """R6.9：规则变更导致的强制关闭，UI 要标「规则变更导致重新计数」。"""


@dataclass(frozen=True)
class FindingRecord:
    """一条 finding 的持久化状态（上轮读出来的）。

    ⚠️ 没有 `days_active` 字段是**刻意的**（R6.5）：那个数由
    `first_seen_date` 与 `today` 相减得出。存一个可增量写的计数字段，
    在 SQS at-least-once 重投下必然被放大 —— 而 at-least-once 是必然路径，
    不是异常路径。
    """

    finding_id: str
    state: FindingState
    first_seen_date: date
    last_run_date: date
    severity: Severity = Severity.INFO
    rule_version: str = ""
    consecutive_hits: int = 0
    """连续命中轮数，用于 R1.0c 的 `new → active` 确认。"""
    consecutive_misses: int = 0
    """连续未命中轮数，用于 R6.3 的 `resolving → resolved` 确认。"""
    was_confirmed: bool = False
    """曾经达到 `new → active` 的确认门槛。**单调，一旦为真不再变假。**

    ⚠️ 这个字段是必需的，不能用 `consecutive_hits >= 2` 或 `state is ACTIVE` 替代：
    ```
    缓解路径     active → resolving → resolved
                 第一次 miss 就把 consecutive_hits 清零、state 改成 resolving
                 ⇒ 到判 resolution_kind 时两个判据**都已失效**
                 ⇒ 一条被确认过的真实风险会被记成 prediction_missed（误报）
    ```
    后果是 R9.7 的准确率闭环把「我们报对了而且客户修了」算成误报 ——
    数字方向完全反了，而且越是正常工作的部署，误报率看起来越高。
    """

    def days_active(self, today: date) -> int:
        """R6.5：「已持续 N 天」。首见当天算 1 天。"""
        return (today - self.first_seen_date).days + 1


@dataclass(frozen=True)
class Observation:
    """本轮对一条 finding 的观察结果。

    `healthy` 是 R6.4 的关键输入：**它与「未命中」是两件事**。
    未命中只说明「今天没越线」；healthy 说明「水位回到了 MEDIUM 档以上」。
    `FreeableMemory` 掉到 800MB 后横三周就是「未命中但不 healthy」。
    """

    finding_id: str
    hit: bool
    severity: Severity = Severity.INFO
    healthy: bool = False
    """水位是否回到 R7.2a 的 MEDIUM 档以上（headroom > 0.35）。"""
    rule_version: str = ""


@dataclass(frozen=True)
class Transition:
    """状态机的输出。**一条 finding 一条**，包括「没变化」。

    ⚠️ `UNCHANGED` 也要产出：调用方靠它推进 `last_run_date`（R6.8 的条件写），
    不产出会让那条 finding 在下一轮看起来「昨天没被评估」。
    """

    finding_id: str
    kind: TransitionKind
    state: FindingState
    record: FindingRecord
    resolution_kind: ResolutionKind | None = None
    prev_severity: Severity | None = None
    note: str = ""

    @property
    def pushable(self) -> bool:
        """是否具备 IM 推送资格（R1.0c + R7.7）。

        ⚠️ `new` 未确认前不推 —— 首轮全部 finding 都是 new，直接推会一次推出几百项。
        ⚠️ INFO 不推（R7.7）。这两条一起决定「值不值得打扰客户」。
        """
        if self.state is FindingState.NEW:
            return False
        if self.record.severity is Severity.INFO:
            return False
        return self.kind in (
            TransitionKind.CONFIRMED, TransitionKind.WORSENED,
            TransitionKind.RESOLVED, TransitionKind.REOPENED,
        )


def _resolution_kind(rec: FindingRecord, obs: Observation | None) -> ResolutionKind:
    """R11d.4 / 1.13c：区分三种结束方式。

    ```
    水位回健康区 + 曾经真的越线过   → fixed          客户改了东西
    水位回健康区 + 从未越线         → prediction_missed  我们报了但它没恶化
    水位没回健康区（走不到这里）     → chronic，不是 resolved
    ```

    ⚠️ v1 用 `consecutive_hits` 是否曾 ≥ `NEW_CONFIRM_ROUNDS` 来区分
    「真的越线过」与「一轮抖动」。这不完美（客户可能在第 1 轮之后就改了），
    但它**可解释**：报出来但没被确认过的，计入误报。
    宁可高估误报率，也不要把误报藏进 `fixed` 里 —— 后者会让 R9.7 的
    准确率闭环永远显示「我们很准」。
    """
    return (ResolutionKind.FIXED if rec.was_confirmed
            else ResolutionKind.PREDICTION_MISSED)


def _worsened(prev: Severity, now: Severity) -> bool:
    """R6.7：**跨档位**才算恶化。

    ⚠️ SHALL NOT 用「headroom 相对缩小 X%」—— 余量比例本身带日间波动，
    裸用相对变化会变成随机升级器。跨档位是离散事件，抖动一次不会连跨两档。
    """
    return now.order < prev.order


def reconcile_findings(
    prev: Mapping[str, FindingRecord],
    evaluated: Iterable[str],
    observations: Sequence[Observation],
    *,
    today: date,
    rule_version: str = "",
) -> list[Transition]:
    """R14.4 的纯函数状态机。

    Args:
        prev: 上轮状态，`{finding_id: FindingRecord}`。
        evaluated: **评估集合** = 采集目标 − 采集失败的实例（R6.2a）。
            ⚠️ SHALL NOT 直接传采集目标：部分批次失败是常态
            （1000 个资源 = 155 批 GetMetricData，限流挂 60 批很容易），
            那批实例产不出 finding → 不在命中集合 → 被整批误判 resolved。
        observations: 本轮的观察结果。**只含被评估到的**。
        today: R14.2 —— 由入参传入，SHALL NOT 在函数内取当前时间。
        rule_version: 当前规则版本。与记录里的不同 → 强制 resolve + 新建（R6.9）。

    Returns:
        每条**被评估到**的 finding 一个 Transition，加上 `prev` 里
        被评估到但本轮没有观察结果的（那是 miss）。
        ⚠️ **未被评估的 finding 不出现在返回值里**（R6.2：状态原地不动）。
    """
    evaluated_set = set(evaluated)
    obs_by_id = {o.finding_id: o for o in observations}
    out: list[Transition] = []

    # 只处理评估集合覆盖到的 finding。这是 R6.2 的核心：
    # 未被评估的实例，其 finding 状态原地不动 —— 不是「按未命中处理」。
    seen: set[str] = set()

    for obs in observations:
        fid = obs.finding_id
        if not _in_scope(fid, evaluated_set):
            # 观察到了但不在评估集合里 —— 上游给错了输入。
            # 静默丢弃比处理它安全：它可能来自一批已知失败的实例。
            continue
        seen.add(fid)
        rec = prev.get(fid)
        t = _step_observed(rec, obs, today=today, rule_version=rule_version)
        # 🔴 `None` = 「无历史 + 本轮未命中」，**不产出任何东西**。
        #    见 `_step_observed` 里那一支的说明：产一条 resolved 会凭空造出
        #    一条「已解决」的历史。
        if t is not None:
            out.append(t)

    # 上轮开着、本轮被评估到、但没有观察结果 → 本轮未命中。
    for fid, rec in prev.items():
        if fid in seen or not rec.state.is_open:
            continue
        if not _in_scope(fid, evaluated_set):
            continue        # R6.2：原地不动
        out.append(_step_missed(rec, None, today=today, rule_version=rule_version))

    out.sort(key=lambda t: t.finding_id)   # R14：可重放，顺序确定
    return out


def _in_scope(finding_id: str, evaluated: set[str]) -> bool:
    """finding_id 是否落在评估集合里。

    `finding_id` 形如 `<account>#<region>#<service>#<instance>#<rule>#<metric>`
    （R6.1）。三种形状都认，**按精确度从高到低**：

    ```
    ① 整条 finding_id                     测试与某些调用方更自然
    ② "<region>#<instance>"               🔴 生产调用方 SHALL 用这种
    ③ 裸 "<instance>"                     存量契约，仅在单 region 下安全
    ```

    🔴 **③ 在多 region 下是错的。** 资源 ID 只在区域内唯一
    （`keys.py` 的键构造那段说的就是这件事），而 `prev` 读的是整个账号
    `inspfind#<账号>` 的全部 finding —— 跨全部 region。所以：

    ```
    finding   677#ap-northeast-1#rds#prod-mysql#threshold_high#cpu   东京，真风险
    evaluated {"prod-mysql"}                                          来自 us-east-1 那一轮
    → ③ 命中 → 东京那条走 _step_missed → 连续两轮后判 RESOLVED
    ```

    一个 region 健康把另一个 region 的真风险判成「已解决」，而且**零报错**。
    今天不会发生（升级前所有 finding 的 region 段都相同），多 region 一开就激活。

    ⚠️ 为什么不直接删掉 ③：删了之后任何仍在传裸 id 的调用方会让本轮**全部
    finding 原地不动** —— 状态机静默停摆，看板上的数字冻住而不报错。两种失败
    都是静默的，所以做法是「生产传 ② + 用行为测试钉住」而不是收紧这里。
    见 `tests/test_inspection_lifecycle.py` 里同名实例跨 region 那条。
    """
    if finding_id in evaluated:
        return True
    parts = finding_id.split("#")
    if len(parts) < 4:
        return False
    # ② region 限定 —— 生产路径
    if f"{parts[1]}#{parts[3]}" in evaluated:
        return True
    # ③ 裸实例 id —— 存量契约
    return parts[3] in evaluated


def _step_observed(
    rec: FindingRecord | None, obs: Observation, *, today: date, rule_version: str
) -> Transition | None:
    """本轮有观察结果的那条路。`None` = 什么都不该产出（见下）。"""
    if rec is None:
        if not obs.hit:
            # 🔴 没有历史、本轮也没命中 → **不产出任何东西**（返回 None）。
            #
            # 这不是异常输入，而是**正常且高频**的路径：`healthy_observations`
            # 会给每一个水位在健康区的 `(实例, 指标)` 产一条 `hit=False,
            # healthy=True` 的观测，而其中绝大多数从来就不是 finding。
            # 那条观测存在的唯一目的是驱动 `resolving → RESOLVED`
            # （见 `_step_missed` 的 `healthy` 分支）—— 没有历史时它无事可做。
            #
            # ⚠️ 这里原来返回一条 `RESOLVED` 记录并标 `note="pass-without-history"`，
            #    也就是**代码做了它自己的注释禁止的事**。实机后果
            #    （2026-08-31，部署账号，62 条 finding 里 44 条）：
            #
            #    ```
            #    高负载页默认筛「待处置」→ 0 条 → 客户永远看不到它们
            #    点「已解决 44」筛选 → 一屏凭空出现的「已解决」
            #    而没有任何一条真的「从有问题变成没问题」——
            #    它们从第一天就是 resolved，first_seen == last_run == 当天
            #    ```
            #
            #    代价不止于界面：每条占一行 DDB（每天 × 每实例 × 每指标），
            #    而「已解决」在 R6.5 的 resolved 判定、推送的「已解决公告」、
            #    以及 R9.7 的准确率闭环里都有语义 —— 44 条假 resolved 会
            #    直接污染那三处。
            #
            # ⚠️ **不在 `healthy_observations` 那侧过滤。** 那个函数拿不到
            #    `prev`（它是纯函数、只吃 attrs），而状态机是唯一同时看得到
            #    「有没有历史」和「本轮命中没」的地方。在这里挡是唯一的单点。
            return None
        return Transition(
            obs.finding_id, TransitionKind.CREATED, FindingState.NEW,
            _new_record(obs, today, rule_version),
        )

    # R6.9：规则变了 → 强制 resolve 旧的，同时新建一条。
    if rule_version and rec.rule_version and rec.rule_version != rule_version:
        return _force_resolve(rec, obs, today=today, rule_version=rule_version)

    if obs.hit:
        return _step_hit(rec, obs, today=today, rule_version=rule_version)
    return _step_missed(rec, obs, today=today, rule_version=rule_version)


def _new_record(
    obs: Observation, today: date, rule_version: str,
    *, state: FindingState = FindingState.NEW,
) -> FindingRecord:
    return FindingRecord(
        finding_id=obs.finding_id, state=state,
        first_seen_date=today, last_run_date=today,
        severity=obs.severity, rule_version=rule_version or obs.rule_version,
        consecutive_hits=1 if obs.hit else 0,
    )


def _step_hit(
    rec: FindingRecord, obs: Observation, *, today: date, rule_version: str
) -> Transition:
    hits = rec.consecutive_hits + 1
    nxt = replace(
        rec, last_run_date=today, severity=obs.severity,
        consecutive_hits=hits, consecutive_misses=0,
        rule_version=rule_version or rec.rule_version,
    )

    # resolving 期间又命中 → 回 active，观察计数清零。
    if rec.state is FindingState.RESOLVING:
        return Transition(
            rec.finding_id, TransitionKind.REOPENED, FindingState.ACTIVE,
            replace(nxt, state=FindingState.ACTIVE, was_confirmed=True),
            prev_severity=rec.severity,
        )

    # R6.7：跨档位恶化。先判它 —— 一条 active 的 finding 恶化了，
    # 那件事比「仍然 active」更该被报出去。
    if _worsened(rec.severity, obs.severity):
        state = (FindingState.ACTIVE if rec.state is FindingState.NEW
                 and hits >= NEW_CONFIRM_ROUNDS else rec.state)
        if state is FindingState.CHRONIC:
            state = FindingState.ACTIVE     # 慢性的东西恶化了，回到 active
        return Transition(
            rec.finding_id, TransitionKind.WORSENED, state,
            replace(nxt, state=state,
                    was_confirmed=rec.was_confirmed or state is FindingState.ACTIVE),
            prev_severity=rec.severity,
        )

    # R1.0c：new 连续命中达标 → active（获得推送资格）。
    if rec.state is FindingState.NEW and hits >= NEW_CONFIRM_ROUNDS:
        return Transition(
            rec.finding_id, TransitionKind.CONFIRMED, FindingState.ACTIVE,
            replace(nxt, state=FindingState.ACTIVE, was_confirmed=True),
            prev_severity=rec.severity,
        )

    # chronic 又命中 → 回 active（它重新越线了）。
    if rec.state is FindingState.CHRONIC:
        return Transition(
            rec.finding_id, TransitionKind.REOPENED, FindingState.ACTIVE,
            replace(nxt, state=FindingState.ACTIVE, was_confirmed=True),
            prev_severity=rec.severity,
        )

    return Transition(
        rec.finding_id, TransitionKind.UNCHANGED, rec.state, nxt,
        prev_severity=rec.severity,
    )


def _step_missed(
    rec: FindingRecord, obs: Observation | None, *, today: date, rule_version: str
) -> Transition:
    """本轮未命中。**这里是 R6.4 的落点，最容易写错的一处。**"""
    misses = rec.consecutive_misses + 1
    healthy = bool(obs and obs.healthy)
    nxt = replace(
        rec, last_run_date=today, consecutive_hits=0, consecutive_misses=misses,
        rule_version=rule_version or rec.rule_version,
    )

    # new 还没确认就消失 → 丢弃（不留 resolved 记录）。
    # ⚠️ 留一条 resolved 会让「本周解决了 N 项」把一轮抖动算成成绩。
    if rec.state is FindingState.NEW and not rec.was_confirmed:
        return Transition(
            rec.finding_id, TransitionKind.RESOLVED, FindingState.RESOLVED,
            replace(nxt, state=FindingState.RESOLVED),
            resolution_kind=ResolutionKind.PREDICTION_MISSED,
            note="unconfirmed-new-disappeared",
        )

    if misses < RESOLVED_CONFIRM_ROUNDS:
        # R6.3：中间态。SHALL NOT 直接 resolved。
        return Transition(
            rec.finding_id, TransitionKind.RELIEVING, FindingState.RESOLVING,
            replace(nxt, state=FindingState.RESOLVING),
        )

    # 连续 K 轮未命中。R6.4：**还要看水位有没有回健康区。**
    if not healthy:
        # ⚠️ 这是 R6.4 举的那个例子：FreeableMemory 掉到 800MB 后横三周，
        # 斜率归零 → 不再命中 → 若判 resolved 就从报告消失。
        # 而横在坏水位比缓慢下降更危险 —— 系统已在压力平衡点。
        return Transition(
            rec.finding_id, TransitionKind.CHRONIC, FindingState.CHRONIC,
            replace(nxt, state=FindingState.CHRONIC),
            note=f"still-at-risk-level-for-{rec.days_active(today)}-days",
        )

    return Transition(
        rec.finding_id, TransitionKind.RESOLVED, FindingState.RESOLVED,
        replace(nxt, state=FindingState.RESOLVED),
        resolution_kind=_resolution_kind(rec, obs),
    )


def _force_resolve(
    rec: FindingRecord, obs: Observation, *, today: date, rule_version: str
) -> Transition:
    """R6.9：规则版本变化 → 强制关闭旧 finding。

    ⚠️ 调用方 SHALL 同时新建一条（`follow_up_for()` 给出那条）。
    只 force_resolve 不新建会让仍然存在的风险从看板上消失。
    """
    return Transition(
        rec.finding_id, TransitionKind.FORCE_RESOLVED, FindingState.RESOLVED,
        replace(rec, state=FindingState.RESOLVED, last_run_date=today),
        note=f"rule-version-changed-{rec.rule_version}-to-{rule_version}",
    )


def resolve_out_of_scope(
    prev: Mapping[str, FindingRecord],
    excluded_keys: Iterable[str],
    *,
    today: date,
    already: Iterable[str] = (),
) -> list[Transition]:
    """把「资源已被移出巡检范围」的那些 finding 关掉（R1.8）。

    Args:
        prev: 上一轮的 finding 状态（**本轮规则域内**的，与 `reconcile` 同一份）。
        excluded_keys: 被排除资源的 `"<region>#<instance>"` 键。
            ⚠️ 与 `reconcile_findings` 的 `evaluated` **同一种形状** ——
            两处用不同形状是这套系统踩过的坑（`_in_scope` 的 ③ 那段）。
        already: 本轮已经由 `reconcile` 处理过的 finding_id。
            🔴 必须传。不传的话同一条 finding 会拿到两个 Transition，
            而 `apply_transitions` 是逐条条件写 —— 后写的那条覆盖前一条，
            结果取决于列表顺序，也就是不确定。

    Returns:
        每条要关闭的 finding 一个 `Transition`（`resolution_kind=OUT_OF_SCOPE`）。

    ## 为什么关掉而不是「读侧隐藏」

    排除条目**会过期**（默认 30 天）。隐藏方案下，过期那天这条 finding 带着
    原来的 `first_seen_date` 重新出现，卡片上写「已持续 45 天」——
    而中间那 30 天我们压根没看。那是一句假话。

    关掉之后，排除过期、资源仍然闲置时会**新建**一条，`first_seen_date` 是
    恢复观察那天。「我们从 X 日重新开始看，它还是闲的」是真的。

    ## 只动**开着的**

    已经 resolved 的不再动 —— 它的 `resolution_kind` 记录着当初为什么结束，
    覆盖成 `out_of_scope` 会把那段历史改写。
    """
    done = set(already)
    keys = set(excluded_keys)
    out: list[Transition] = []
    for fid, rec in prev.items():
        if fid in done or not rec.state.is_open:
            continue
        # finding_id 六段定长：account#region#service#instance#rule#metric（R6.1）
        parts = fid.split("#")
        if len(parts) < 4 or f"{parts[1]}#{parts[3]}" not in keys:
            continue
        out.append(Transition(
            fid, TransitionKind.FORCE_RESOLVED, FindingState.RESOLVED,
            replace(rec, state=FindingState.RESOLVED, last_run_date=today),
            resolution_kind=ResolutionKind.OUT_OF_SCOPE,
            note="excluded-from-scope",
        ))
    out.sort(key=lambda t: t.finding_id)      # R14：可重放，顺序确定
    return out


def follow_up_for(t: Transition, obs: Observation, *, today: date,
                  rule_version: str) -> Transition | None:
    """`FORCE_RESOLVED` 之后要新建的那条（R6.9 / 1.13a）。

    ⚠️ 缺了它，改一次阈值会让全部历史 finding 的「已持续 N 天」继续累计
    而基线已经不同 —— 客户看到「已持续 47 天」，而那个数字里前 40 天用的是旧阈值。
    """
    if t.kind is not TransitionKind.FORCE_RESOLVED or not obs.hit:
        return None
    return Transition(
        obs.finding_id, TransitionKind.CREATED, FindingState.NEW,
        _new_record(obs, today, rule_version),
        note="recreated-after-rule-change",
    )


@dataclass(frozen=True)
class ReconcileResult:
    """`reconcile()` 的完整结果，含 dry-run 标记（1.13b）。"""

    transitions: tuple[Transition, ...]
    dry_run: bool = False
    """R11.4：手动触发默认 dry-run —— 算出来但不落库。

    ⚠️ 这是 **domain 层的接口决定**，Phase 1 就要定。等到 Phase 6 再加，
    落库逻辑已经和状态机缠在一起，dry-run 就只能靠调用方「算完别写」——
    而那种约定没有任何东西能强制。
    """

    @property
    def pushable(self) -> tuple[Transition, ...]:
        """具备推送资格的那些（R1.0c + R7.7）。dry-run 时恒为空。"""
        if self.dry_run:
            return ()
        return tuple(t for t in self.transitions if t.pushable)

    def by_kind(self, kind: TransitionKind) -> tuple[Transition, ...]:
        return tuple(t for t in self.transitions if t.kind is kind)

    @property
    def counts(self) -> dict[str, int]:
        """R9.3 的分级计数用。"""
        out: dict[str, int] = {}
        for t in self.transitions:
            out[t.kind.value] = out.get(t.kind.value, 0) + 1
        return out


def reconcile(
    prev: Mapping[str, FindingRecord],
    evaluated: Iterable[str],
    observations: Sequence[Observation],
    *,
    today: date,
    rule_version: str = "",
    dry_run: bool = False,
) -> ReconcileResult:
    """`reconcile_findings` + R6.9 的新建 + dry-run 包装。

    这是**生产调用方应该用的入口** —— `reconcile_findings` 只做状态推进，
    不产出 R6.9 要求的「强制关闭后新建的那条」。
    """
    transitions = reconcile_findings(
        prev, evaluated, observations, today=today, rule_version=rule_version)
    obs_by_id = {o.finding_id: o for o in observations}

    full: list[Transition] = []
    for t in transitions:
        full.append(t)
        obs = obs_by_id.get(t.finding_id)
        if obs is not None:
            extra = follow_up_for(t, obs, today=today, rule_version=rule_version)
            if extra is not None:
                full.append(extra)
    return ReconcileResult(tuple(full), dry_run=dry_run)
