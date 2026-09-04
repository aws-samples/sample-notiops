"""DA 判读缺失时的 degraded 报告（R12.4）。

## R12.4 原文

> DevOps Agent 不可用时 SHALL 输出 degraded 报告（规则判定 + headroom + 严重度，
> 标注「判读缺失」）。

## 为什么这条必须做，而且必须显式标注

我们的判定层是**确定性的**：越线与否、headroom、严重度、连续天数，全部由
`thresholds` / `severity` 算出来，一个字都不依赖 DA。DA 只负责回答「为什么」。

所以 DA 不可用时我们仍然有一份完整的「是什么」。不出报告等于把
「DA 挂了」升级成「今天没有风险」——那是本 feature 从头到尾在防的静默失败。

⚠️ 但**不标注**同样危险，而且更隐蔽：一份只有数字没有分析的报告，
读起来像「系统认为这条不严重所以没多说」。客户据此不处理，
而真相是我们没能给出分析。

## 归因必须分清是谁的问题

和 `GapReason.ACCESS_DENIED` / `COLLECTION_FAILED` 的分法同一个道理
（R13b.5）：把**我们的配置错误**说成「DA 判读缺失」会让客户去查 AWS，
而真正该改的是我们的 CDK。所以 `DegradedReason` 带 `blame` 分类。
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Mapping


class Blame(str, Enum):
    """这次判读缺失是谁的问题。**决定报告里该建议谁去做什么。**"""

    OURS = "ours"
    """我们的 bug 或配置错误。SHALL NOT 作为「AWS 侧问题」呈现给客户 ——
    那会让客户去查一个他改不了也不该改的东西，而真正该改的是我们的部署。"""

    AWS = "aws"
    """AWS 侧的限制或故障（额度用尽、服务不可用）。客户可能需要提额度。"""

    UNKNOWN = "unknown"
    """还判不出来。**单独一档而不是并进 AWS** —— 并进去会让我们的 bug
    有一半概率被算成 AWS 的问题，而那正是最该被发现的那一半。"""


class DegradedReason(str, Enum):
    """判读为什么缺失。**每一档的后续动作不同，不可合并。**

    ⚠️ 覆盖**整条生命周期**，不只是 journal 那一段：
    `journal_gate.Degradation` 只能描述「调查回来了但有问题」，
    而 R12.4 说的「DA 不可用」包含调查压根没发出去、发出去没回来这些形态。
    只用 Degradation 会让前面那几段没有归属，落到「未知原因」里。
    """

    DISPATCH_FAILED = "dispatch_failed"
    """`CreateBacklogTask` 抛异常 —— 从没派出去，额度也没花。"""

    NOT_MAPPED = "not_mapped"
    """派出去了但 `taskId` 没接住 → 判读**永久**回不来，额度已花。
    🔴 这是我们的 bug（响应解析），不是 AWS 的问题。"""

    QUOTA_EXHAUSTED = "quota_exhausted"
    """月度额度用尽（R12.3：`Created` 紧接 `Cancelled` 且无 `Completed`）。"""

    NO_CALLBACK = "no_callback"
    """派出去了、也没被取消，但终态事件一直没到（对账发现，R13.13）。"""

    PARSE_FAILED = "parse_failed"
    """判读回来了但分节解析不出（R9.6）。原文已保留。"""

    MISSING_SECTION = "missing_section"
    """判读回来了、解析成功，但**这一条** finding 没有对应节。"""

    SKILL_NOT_LOADED = "skill_not_loaded"
    """journal 显示判读 skill 没被加载 → 结论不是按我们的方法论出的。"""

    WRONG_SKILL = "wrong_skill"
    """加载了别的 skill —— 措辞路由偏了。"""

    NO_DATA_ACCESS = "no_data_access"
    """🔴 agent space 缺账号关联。**完全静默**：task status=COMPLETED、
    skill 已加载、报告格式完好，但 finding 0 条、只有一条
    `gap-account-access`。这是我们 CDK 漏配，不是客户的运维问题。"""

    GATED_BY_BUDGET = "gated_by_budget"
    """额度档位（`Tier`）把它挡在门外 —— **不是** DA 不可用，
    是我们主动省额度。⚠️ 单独一档：把它说成「DA 不可用」会让客户
    以为服务出了问题，而这其实是设计好的降速行为。"""

    INVESTIGATION_FAILED = "investigation_failed"
    """DA 侧调查以 `FAILED` 终态结束。

    ⚠️ 与 `DISPATCH_FAILED` 是两件事：那个是 `CreateBacklogTask` 抛异常
    （**从没派出去**，额度也没花），这个是派出去了、DA 接了、跑失败了。
    合并会让「我们发不出去」与「他们跑不出来」在报告上无法区分，
    而两者的下一步动作完全不同（查我们的载荷 vs 提 case）。
    """

    INVESTIGATION_TIMED_OUT = "investigation_timed_out"
    """DA 侧判定超时（`TIMED_OUT`）。

    ⚠️ 超时是**AWS 自己判的**，investigation 没有我们可配的 timeout（R12.5）。
    所以归 `Blame.AWS`，且**不能**由我们按墙钟时长推断
    —— 见 `dispatch_recon` 的模块 docstring。
    """

    SKIPPED_BY_SKILL = "skipped_by_skill"
    """DA 按 skill 里定义的 skip 判据跳过了（`SKIPPED`）。

    🔴 **SHALL NOT 重投。** 官方语义是「matched skip criteria defined in a
    skill」，而那两份 skill 是我们自己上传的 —— 重投会得到同样结果：
    每轮白烧一次额度，报告永远不出现。
    ⚠️ 处置与 FAILED / TIMED_OUT **相反**，不能合并成一个分支。
    """

    DA_DISABLED = "da_disabled"
    """`da_enabled` kill switch 被人拉停了（R11c.1）。

    ⚠️ **不能并进 `GATED_BY_BUDGET`。** 那一档的文案写着「按严重度排序靠后」，
    而拉停是全量停、与 severity 无关 —— 客户会读成「我这条不够严重」，
    于是「判读被整体关掉了」这件事永远不会被发现。
    也不能并进 `QUOTA_EXHAUSTED`：那是 AWS 侧的额度用尽（`Blame.AWS`），
    而这是我们自己的运维动作。
    """

    UNKNOWN = "unknown"


_BLAME: Mapping[DegradedReason, Blame] = {
    DegradedReason.DISPATCH_FAILED: Blame.UNKNOWN,
    DegradedReason.NOT_MAPPED: Blame.OURS,
    DegradedReason.QUOTA_EXHAUSTED: Blame.AWS,
    DegradedReason.NO_CALLBACK: Blame.UNKNOWN,
    DegradedReason.PARSE_FAILED: Blame.OURS,
    DegradedReason.MISSING_SECTION: Blame.UNKNOWN,
    DegradedReason.SKILL_NOT_LOADED: Blame.OURS,
    DegradedReason.WRONG_SKILL: Blame.OURS,
    DegradedReason.NO_DATA_ACCESS: Blame.OURS,
    DegradedReason.GATED_BY_BUDGET: Blame.OURS,
    # 调查失败的成因可能在我们（载荷/权限）也可能在 DA 侧 —— 归 UNKNOWN 而不是
    # 二选一。硬归给 AWS 会让我们的载荷缺陷有一半概率被算成对方的问题。
    DegradedReason.INVESTIGATION_FAILED: Blame.UNKNOWN,
    # 超时是 AWS 自己判的，investigation 没有我们可配的 timeout（R12.5）。
    DegradedReason.INVESTIGATION_TIMED_OUT: Blame.AWS,
    # skip 判据写在**我们上传的** skill 里 —— 是我们的配置问题。
    DegradedReason.SKIPPED_BY_SKILL: Blame.OURS,
    DegradedReason.DA_DISABLED: Blame.OURS,
    DegradedReason.UNKNOWN: Blame.UNKNOWN,
}


def blame_of(reason: DegradedReason | str) -> Blame:
    r = reason if isinstance(reason, DegradedReason) else _coerce(reason)
    return _BLAME.get(r, Blame.UNKNOWN)


def _coerce(value: Any) -> DegradedReason:
    """字符串 → 枚举。认不出返回 `UNKNOWN`，**不抛**。

    ⚠️ 不抛的理由：这个值来自 DDB 行里的 `da_parse_status`
    等历史字段，老数据里可能有本枚举还没有的取值。
    为一个陌生字符串抛异常会让整份报告生成失败 ——
    而报告本身正是我们在降级时唯一还能交付的东西。
    """
    try:
        return DegradedReason(str(value or "").strip().lower())
    except ValueError:
        return DegradedReason.UNKNOWN


# ---------------------------------------------------------------------------
# 文案
# ---------------------------------------------------------------------------
#
# ⚠️ 中英双份**逐条对应**。少一条的表现是英文客户在英文报告里读到一句中文，
# 而那句话恰好是「判读缺失」这个最需要读懂的提示。

_ZH: Mapping[DegradedReason, str] = {
    DegradedReason.DISPATCH_FAILED: "判读任务派发失败，本条只有规则判定结果。",
    DegradedReason.NOT_MAPPED: "判读任务已派发，但系统未能记录任务标识，"
                              "分析结果无法回填。这是系统缺陷，已记录。",
    DegradedReason.QUOTA_EXHAUSTED: "本月智能判读额度已用尽，本条只有规则判定结果。",
    DegradedReason.NO_CALLBACK: "判读任务已派发但尚未返回结果，本条暂只有规则判定。",
    DegradedReason.PARSE_FAILED: "判读结果格式无法解析，原文已保留。",
    DegradedReason.MISSING_SECTION: "判读结果中未包含本条资源的分析。",
    DegradedReason.SKILL_NOT_LOADED: "判读方法论未被加载，结论不可用；"
                                     "本条只保留规则判定结果。",
    DegradedReason.WRONG_SKILL: "判读加载了不匹配的方法论，结论不可用。",
    DegradedReason.NO_DATA_ACCESS: "判读服务缺少目标账号访问权限，无法读取指标。"
                                   "这是系统配置问题，无需客户处理。",
    DegradedReason.GATED_BY_BUDGET: "为控制额度消耗，本条未做智能判读（按严重度排序靠后）。",
    # ⚠️ 措辞刻意**不提**严重度或额度：拉停是全量的。也刻意说明「规则判定
    #    仍然有效」—— 否则客户会以为这一轮的结果整体不可信。
    DegradedReason.DA_DISABLED: "智能判读功能当前已暂停，本条只有规则判定结果。"
                               "规则判定不受影响，结论仍然有效。",
    DegradedReason.INVESTIGATION_FAILED: "智能判读任务执行失败，本条只有规则判定结果。"
                                        "已记录，将在下一轮重新尝试。",
    DegradedReason.INVESTIGATION_TIMED_OUT: "智能判读任务超时未完成，"
                                           "本条只有规则判定结果。",
    # ⚠️ 措辞必须让客户看懂「这不是故障」：跳过是判据命中的结果。
    #    同时**不能**暗示会重试 —— 重投只会得到同样结果。
    DegradedReason.SKIPPED_BY_SKILL: "本条命中了判读方法论中的跳过判据，"
                                    "未做智能判读；规则判定结果仍然有效。",
    DegradedReason.UNKNOWN: "智能判读缺失，原因未知。",
}

_EN: Mapping[DegradedReason, str] = {
    DegradedReason.DISPATCH_FAILED:
        "The analysis task could not be dispatched; rule findings only.",
    DegradedReason.NOT_MAPPED:
        "The analysis task was dispatched but its identifier was not recorded, "
        "so the result cannot be matched back. This is a defect on our side "
        "and has been logged.",
    DegradedReason.QUOTA_EXHAUSTED:
        "The monthly analysis quota is exhausted; rule findings only.",
    DegradedReason.NO_CALLBACK:
        "The analysis task was dispatched but has not returned yet; "
        "rule findings only for now.",
    DegradedReason.PARSE_FAILED:
        "The analysis result could not be parsed; the raw text is preserved.",
    DegradedReason.MISSING_SECTION:
        "The analysis result contains no section for this resource.",
    DegradedReason.SKILL_NOT_LOADED:
        "The analysis methodology was not loaded, so its conclusion is not "
        "usable; rule findings only.",
    DegradedReason.WRONG_SKILL:
        "The analysis loaded a mismatched methodology; its conclusion is not "
        "usable.",
    DegradedReason.NO_DATA_ACCESS:
        "The analysis service lacks access to the target account and could not "
        "read metrics. This is a configuration issue on our side; no customer "
        "action is needed.",
    DegradedReason.GATED_BY_BUDGET:
        "To conserve quota, this finding was not sent for analysis "
        "(lower severity ranking).",
    DegradedReason.DA_DISABLED:
        "AI analysis is currently paused; rule findings only. The rule "
        "evaluation is unaffected and its conclusion still holds.",
    DegradedReason.INVESTIGATION_FAILED:
        "The analysis task failed to run; rule findings only. This has been "
        "logged and will be retried on the next run.",
    DegradedReason.INVESTIGATION_TIMED_OUT:
        "The analysis task timed out before completing; rule findings only.",
    DegradedReason.SKIPPED_BY_SKILL:
        "This finding matched a skip rule in the analysis methodology, so no "
        "AI analysis was performed; the rule findings still hold.",
    DegradedReason.UNKNOWN: "The analysis is missing for an unknown reason.",
}

_HEADING = {"zh": "判读缺失", "en": "Analysis missing"}
_RULES_HEADING = {"zh": "规则判定", "en": "Rule findings"}


def explain(reason: DegradedReason | str, locale: str = "zh") -> str:
    """一句话说明为什么没有判读。"""
    r = reason if isinstance(reason, DegradedReason) else _coerce(reason)
    table = _EN if str(locale or "zh").lower().startswith("en") else _ZH
    return table.get(r, table[DegradedReason.UNKNOWN])


# ---------------------------------------------------------------------------
# 渲染
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class DegradedSection:
    """一条 finding 的 degraded 呈现。"""

    finding_id: str
    reason: DegradedReason
    blame: Blame
    text: str

    @property
    def is_our_fault(self) -> bool:
        return self.blame is Blame.OURS


def render_degraded(
    payload: Mapping[str, Any],
    reason: DegradedReason | str,
    *,
    locale: str = "",
) -> DegradedSection:
    """从**载荷本身**渲染一条 degraded 段落（R12.4）。

    只用载荷里已有的确定性字段，不做任何推断：
    `judgment` 的 metric / value / threshold / headroom / coverage_days，
    `severity`，`hit_reason`，以及 `structural.params` / `cost`。

    ⚠️ `locale` 缺省从载荷里取（`payload["locale"]`），载荷也没有才用 zh。
    在这里写死 zh 会让英文客户在英文报告里读到一句中文 ——
    而那句话恰好是「判读缺失」这个最需要读懂的提示。

    ⚠️ **不编任何结论。** 这里出现的每个数字都能在载荷里逐字找到；
    编一句「建议升配」会让 degraded 报告看起来像正常判读，
    于是「DA 挂了」这件事再也不会被人发现。
    """
    r = reason if isinstance(reason, DegradedReason) else _coerce(reason)
    loc = str(locale or payload.get("locale") or "zh")
    en = loc.lower().startswith("en")
    fid = str(payload.get("finding_id") or "")

    lines: list[str] = []
    lines.append(f"## {fid}")
    lines.append(f"**{_HEADING['en' if en else 'zh']}** — {explain(r, loc)}")
    lines.append("")
    lines.append(f"{_RULES_HEADING['en' if en else 'zh']}:")

    sev = payload.get("severity") or "-"
    reasons = ", ".join(payload.get("hit_reason") or []) or "-"
    lines.append(f"- severity: {sev}")
    lines.append(f"- hit_reason: {reasons}")

    j = payload.get("judgment") or {}
    if j:
        for key in ("metric", "stat", "value", "threshold", "headroom",
                    "consecutive_high_days", "coverage_days"):
            if j.get(key) is not None:
                lines.append(f"- {key}: {j[key]}")

    st = payload.get("structural") or {}
    if st:
        lines.append(f"- rule: {st.get('rule', '-')}")
        for k, v in (st.get("params") or {}).items():
            lines.append(f"- {k}: {v}")

    cost = payload.get("cost") or {}
    if cost:
        for key in ("savings_estimate", "price_precision"):
            if cost.get(key) is not None:
                lines.append(f"- {key}: {cost[key]}")

    return DegradedSection(finding_id=fid, reason=r, blame=blame_of(r),
                           text="\n".join(lines))


def reason_from_degradation(degradation: Any) -> DegradedReason:
    """`journal_gate.Degradation` → `DegradedReason`。

    多数档同名直通，两处**语义不同名**必须显式映射：

    ```
    NO_JOURNAL     journal 里一条记录都没有 → 等价于「调查没产出」
                   ⇒ NO_CALLBACK（对客户的表述是「尚未返回结果」）
    ANALYSIS_GAP   部分证据缺失，**不阻断可信性**（见 JournalVerdict.trustworthy）
                   ⇒ 不走 degraded 路径，返回 UNKNOWN 让调用方发现自己判断错了
    ```

    ⚠️ 不做这个映射的表现：journal 明确告诉我们「skill 没加载」，
    而报告上写「原因未知」—— 我们手里有答案却没用。
    """
    raw = getattr(degradation, "value", degradation)
    special: Mapping[str, DegradedReason] = {
        "no_journal": DegradedReason.NO_CALLBACK,
    }
    key = str(raw or "").strip().lower()
    if key in special:
        return special[key]
    return _coerce(key)


def reason_from_parse_status(status: str) -> DegradedReason:
    """`attach_judgment` 写进 finding 行的 `da_parse_status` → 降级原因。

    ⚠️ `ok` / `partial` 映射成 `UNKNOWN` 而不是抛：那两个值意味着
    **不该走** degraded 路径，调用方判断错了。返回 UNKNOWN 让报告
    显示「原因未知」是可见的错误，抛异常会让整份报告生成失败。
    """
    return _coerce(status)


_FROM_SKIP: Mapping[str, DegradedReason] = {
    "budget": DegradedReason.GATED_BY_BUDGET,
    "quota": DegradedReason.QUOTA_EXHAUSTED,
    "kill_switch": DegradedReason.DA_DISABLED,
}
"""`gating.SkipReason` → `DegradedReason`。**三档全部不同名**，见下。"""


def reason_from_skip_reason(skip_reason: Any) -> DegradedReason:
    """`gating.SkipReason` → `DegradedReason`（R11c.1 / R12.2 / R12.6）。

    只收「派发被挡住」的三档。`playbook` / `reused` **压根不该到这里** ——
    它们自带 `conclusion`，是升级不是降级（见 `Decision.has_conclusion`）。
    传进来会返回 `UNKNOWN`，于是报告上出现一句「原因未知」——
    那是可见的错误，比静默把一条确定性结论渲染成「判读缺失」好。

    ⚠️ 三档**没有一个同名**，所以不能像 `reason_from_parse_status` 那样直通
    `_coerce`：`budget` / `quota` / `kill_switch` 直通全都落到 `UNKNOWN`，
    表现是三种完全不同的原因在报告上都写「原因未知」——
    而我们手里明明有答案。

    ⚠️ 取字符串而不是 import `gating.SkipReason`：`degraded` 在 domain 层，
    让它依赖 gating 会把「文案」与「闸门判据」绑在一起，
    而报告侧读到的其实是 run 记录里 `skipped_by_gate` 的**字符串键**。
    """
    raw = getattr(skip_reason, "value", skip_reason)
    key = str(raw or "").strip().lower()
    return _FROM_SKIP.get(key, _coerce(key))
