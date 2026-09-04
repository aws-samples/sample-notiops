"""把 DA 判读回拼到各条 finding（R9.6）。

## 位置与理由

和 `assemble.py` 同一个理由：这段逻辑如果写在 `devops_agent_callback/handler.py`
里，就需要真 EventBridge 事件 + 真 DDB 才跑得到，**永远没有测试**。
本 feature 已经因为「逻辑塞在需要真客户端的函数里」踩过两次静默失败
（判定层零调用、接线层零调用），不再重复。

## 链路

```
callback 收到 Investigation Completed
  ↓ agent_space_id 判出是巡检（callback_route，7.12g）
  ↓ build_investigation_report 拿到 long_report（card_mode=SKIP，7.10a）
  ↓ get_dispatch(task_id) 拿到这个 task 装了哪些 finding（7.4b）
  ↓ parse_sections 按 `## <finding_id>` 切开（本模块调用，7.10b）
  ↓ attach_judgment 逐条挂到 finding 行
```

⚠️ 每一环失败都要**留下痕迹而不是静默**。这条链上任何一环断掉的表现都是
「报告里有分析但 finding 旁边是空的」，而那和「本轮没有风险」在看板上长得一样。
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ApplyOutcome:
    """回拼结果。每个计数都对应一种**不同的**失败，不可合并。"""

    task_id: str = ""
    parse_status: str = ""
    expected: int = 0
    """派发映射里记着的 finding 条数。"""
    attached: int = 0
    """真正挂上去的条数。"""
    missing: tuple[str, ...] = ()
    """DA 没给判读的 finding。**不当成「没问题」** —— 它们的判读是缺失的。"""
    orphaned: tuple[str, ...] = ()
    """DA 给了判读、但 finding 行已经不在了（可能已 resolved 被清）。"""
    raw_kept: bool = False
    """解析失败时是否把原文留下了（R9.6）。"""
    skipped_reason: str = ""
    """整段跳过的原因（不是巡检 / 没有派发映射 / 空报告）。"""
    skills_loaded: tuple[str, ...] = ()
    """这次调查实际加载的 skill 名（`utilization.skills.bundles`）。

    ⚠️ 空元组有两种来源，日志要能区分：读不到 journal，或者 journal 里
    确实没有 skill。`degradations` 那一栏会分别给出 `no_journal` /
    `skill_not_loaded`。
    """
    degradations: tuple[str, ...] = ()
    """`journal_gate.evaluate_journal` 判出的降级原因（字符串枚举值）。

    🔴 这一栏是 2026-08-31 补的，起因是一次**误诊**：判读一直 `parse_failed`，
    而当时唯一的线索是输出格式，于是被反推成「skill 没加载」，接着往 IAM 和
    agent space 的 asset 竞争上查了几个小时。实测（`utilization.skills.bundles`）
    表明 skill 两次都正常加载 —— 真正的原因是取正文取错了 recordType。

    ⇒ 「skill 有没有加载」是**可以直接读出来的事实**，不该靠输出格式反推。
      `journal_gate` 这个模块本来就是为此写的，但在此之前它的生产调用点是 0。
    """
    journal_trustworthy: bool = True
    """判读能不能当成「按我们的方法论判出来的」（见 `JournalVerdict.trustworthy`）。

    ⚠️ 默认 `True`：拿不到 journal 记录时不改变既有行为（此前压根没有这个门禁），
    降级只由 `degradations` 表达。默认 `False` 会让所有存量路径一夜之间
    全部变成「不可信」，而那是噪音不是信号。
    """

    @property
    def ok(self) -> bool:
        return bool(self.expected) and self.attached == self.expected

    @property
    def is_heartbeat(self) -> bool:
        """heartbeat task 没有 finding，`expected == 0` 且不算失败。"""
        return self.skipped_reason == "heartbeat"


def apply_judgment(
    store: Any,
    *,
    task_id: str,
    long_report: str | None,
    report_md_key: str = "",
    journal_records: Sequence[Mapping[str, Any]] | None = None,
) -> ApplyOutcome:
    """按派发映射把判读文本逐条挂到 finding 行。

    Args:
        store: `InspectionStore`（需要 `get_dispatch` / `attach_judgment`）。
        task_id: callback 事件里的 task id —— **唯一可用的锚点**。
        long_report: DA 判读全文。
        report_md_key: 全文在 S3 的 key，挂到每条 finding 上供 UI 深链。
        journal_records: 这次调查的 journal 记录，喂给 skill 加载门禁
            （`journal_gate`）。`None` = 拿不到 → 门禁判 `no_journal` 而不是
            「没问题」。调用方从 `ReportArtifacts.journal_records` 取，那批
            记录**已经为 trace.html 拉过一次**，不要再发一次 API。

    ⚠️ 拿不到派发映射时**跳过而不是报错**：客户在 webchat 手点的深度调查
    走同一个 callback，那些 task 当然没有巡检派发行。
    但巡检自己的 task 拿不到映射是真问题（派发时没落成），所以两者要能区分 ——
    这里靠调用方先用 `callback_route` 判过是巡检才进来。
    """
    from inspection.domain.report_parse import ParseStatus, parse_sections

    tid = (task_id or "").strip()
    if not tid:
        return ApplyOutcome(skipped_reason="no_task_id")

    row = store.get_dispatch(tid)
    if row is None:
        # ⚠️ WARNING 而不是 DEBUG：调用方已经判过这是巡检事件，
        #    那么映射缺失就意味着派发时没写成 —— 这一条的判读永久丢失。
        logger.warning(
            "巡检事件但没有派发映射，判读无法回拼: task_id=%s。"
            "派发时 put_dispatch 可能失败过（查 run 记录的 mapped_tasks "
            "是否小于 dispatched_tasks）", tid)
        return ApplyOutcome(task_id=tid, skipped_reason="no_dispatch_row")

    account_id = str(row.get("account_id") or "")
    finding_ids = [str(f) for f in (row.get("finding_ids") or [])]

    if row.get("is_heartbeat") or not finding_ids:
        # heartbeat 没有 finding，本来就没什么可回拼的。
        logger.info("heartbeat task，无 finding 需回拼: task_id=%s", tid)
        return ApplyOutcome(task_id=tid, skipped_reason="heartbeat")

    res = parse_sections(long_report, finding_ids)

    # 7.9a skill 加载门禁。**必须在 parse 之后**（要把 parse_failed 喂进去），
    # 且必须在两条 return 路径上都带出去 —— 只在成功路径上带的话，
    # 恰好在最需要它的那次（解析失败）拿不到诊断。
    gate = _evaluate_gate(
        journal_records,
        run_type=str(row.get("run_type") or ""),
        parse_failed=res.status in (ParseStatus.PARSE_FAILED, ParseStatus.EMPTY),
        task_id=tid)

    # 门禁结论要**落库**（D22），不能只进日志。
    #
    # 🔴 在 2026-09-03 之前这三个值只出现在 `handler.py` 的一行 logger.info 里 ——
    #    也就是说「这条判读的方法论到底生效了没有」只有去 CloudWatch 按 task_id
    #    捞日志才知道，而看板上一条 skill 没加载的判读与一条正常判读**长得
    #    一模一样**。`journal_gate` 那个模块的全部意义就是把这件事变成可读的
    #    事实，而它算完之后没人取。
    #
    # ⚠️ `gate` 为空 dict = 门禁**没跑**（老派发行没 run_type / 门禁自己抛了）。
    #    那时三个参数一律传 `None`，`attach_judgment` 会一个键都不写，
    #    于是「属性缺失」= 未知。**不能**退化成 `False` 或空列表 ——
    #    前者把「不知道」说成「不可信」，后者把「没验过」说成「验过且干净」。
    gate_kw: dict[str, Any] = {
        "gate_trustworthy": gate.get("journal_trustworthy") if gate else None,
        "degradations": gate.get("degradations") if gate else None,
        "skills_loaded": gate.get("skills_loaded") if gate else None,
    }

    # R9.6：解析失败 → 存原文 + 标 parse_failed。
    # ⚠️ 原文挂到**每一条** finding 上而不是只挂第一条：客户在 UI 上点开
    #    任意一条都该看到「判读没解析出来，这是原文」。只挂第一条会让
    #    其余几条显示成「没有判读」，而那与「DA 说这条没问题」长得一样。
    if res.status in (ParseStatus.PARSE_FAILED, ParseStatus.EMPTY):
        attached = 0
        for fid in finding_ids:
            if store.attach_judgment(
                    account_id, fid, task_id=tid,
                    body=res.raw, parse_status=res.status.value,
                    report_md_key=report_md_key, **gate_kw):
                attached += 1
        logger.error(
            "判读解析失败（%s），已把原文挂到 %d/%d 条 finding 上: task_id=%s",
            res.status.value, attached, len(finding_ids), tid)
        return ApplyOutcome(
            task_id=tid, parse_status=res.status.value,
            expected=len(finding_ids), attached=attached,
            missing=res.missing, orphaned=_orphans_of(res),
            raw_kept=res.status is ParseStatus.PARSE_FAILED, **gate)

    attached = 0
    orphaned: list[str] = []
    for sec in res.sections:
        ok = store.attach_judgment(
            account_id, sec.finding_id, task_id=tid,
            verdict=sec.verdict, body=sec.body,
            parse_status=res.status.value, report_md_key=report_md_key,
            **gate_kw)
        if ok:
            attached += 1
        else:
            orphaned.append(sec.finding_id)

    if res.missing:
        # ⚠️ 缺的那些**也要标记**，否则 UI 上它们与「DA 判了没问题」一样。
        for fid in res.missing:
            store.attach_judgment(
                account_id, fid, task_id=tid,
                parse_status="missing_section",
                report_md_key=report_md_key, **gate_kw)

    out = ApplyOutcome(
        task_id=tid, parse_status=res.status.value,
        expected=len(finding_ids), attached=attached,
        missing=res.missing, orphaned=tuple(orphaned),
        raw_kept=False, **gate)
    if out.ok:
        logger.info("判读已回拼 %d/%d 条: task_id=%s", attached,
                    len(finding_ids), tid)
    else:
        logger.warning(
            "判读回拼不完整 %d/%d：missing=%s orphaned=%s task_id=%s",
            attached, len(finding_ids), res.missing[:3], orphaned[:3], tid)
    return out


def _evaluate_gate(
    journal_records: Sequence[Mapping[str, Any]] | None,
    *,
    run_type: str,
    parse_failed: bool,
    task_id: str,
) -> dict[str, Any]:
    """跑 skill 加载门禁，返回可直接展开进 `ApplyOutcome` 的三个字段。

    🔴 **这是 `journal_gate` 的生产调用点。** 在 2026-08-31 之前它是 0 ——
    模块写完、测完、反向注入验完，然后没人调。那次的代价是一场误诊：
    `parse_failed` 被反推成「skill 没加载」，而实测 `skills.bundles` 两次
    都是对的那份。

    ⚠️ **从不抛。** 调用方是 callback 主路径，判读已经挂好了；
    一个诊断用的门禁不该让整条回拼失败（那会让判读文本白丢）。

    ⚠️ `run_type` 认不出时（老的派发行没这个字段）`EXPECTED_SKILL` 查不到 →
    `evaluate_journal` 会判 `SKILL_NOT_LOADED`，那是**误报**。所以空 run_type
    直接跳过门禁并说明原因，而不是产一条假降级 ——
    假降级混在真降级里会让这一栏整体失去可信度。
    """
    if not run_type:
        logger.info(
            "跳过 skill 门禁：派发行没有 run_type（老数据）task_id=%s", task_id)
        return {}
    try:
        from inspection.domain.journal_gate import evaluate_journal

        v = evaluate_journal(journal_records, run_type=run_type,
                             parse_failed=parse_failed)
    except Exception as e:                                     # noqa: BLE001
        logger.warning("skill 门禁评估失败（不阻断）: task_id=%s %s", task_id, e)
        return {}

    codes = tuple(d.value for d in v.degradations)
    # ⚠️ 日志分级按**可信性**而不是「有没有降级」：`compaction` /
    #    `analysis_gap` 是精度损失，按 ERROR 记会让真正的方法论失效
    #    （skill 没加载 / 加载错 / 账号没关联）淹没在里面。
    if not v.trustworthy:
        logger.error(
            "🔴 判读不可信: task_id=%s run_type=%s 已加载skill=%s 降级=%s。"
            "记录数=%s —— skill_not_loaded/wrong_skill 去查 task description 的"
            "措辞路由与 space 里的 skill；no_data_access 去查 agent space 的"
            "账号关联；no_journal 表示无法证明，不等于没问题",
            task_id, run_type, list(v.bundles) or "无", list(codes),
            "None" if journal_records is None else len(journal_records))
    elif codes:
        logger.warning(
            "判读有降级但仍可信: task_id=%s 已加载skill=%s 降级=%s",
            task_id, list(v.bundles), list(codes))
    else:
        logger.info("skill 门禁通过: task_id=%s 已加载skill=%s",
                    task_id, list(v.bundles))
    return {
        "skills_loaded": v.bundles,
        "degradations": codes,
        "journal_trustworthy": v.trustworthy,
    }


def _orphans_of(res: Any) -> tuple[str, ...]:
    """`parse_sections` 的 `unexpected` 在回拼语境下就是「孤儿判读」。

    DA 给了判读但标题对不上任何预期 finding_id —— 判读文本就在那儿，
    只是无处安放。留着这个清单是排查「DA 抄错 id」的唯一线索。
    """
    return tuple(getattr(res, "unexpected", ()) or ())
