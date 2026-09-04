"""把 DA 判读全文按 `finding_id` 拆回各条 finding（R9.6）。

## 缝合点

skill 的输出信封明写「One section per `finding_id`, heading exactly the id
so it can be routed back」：

```
## 111122223333#us-east-1#rds#db-1#threshold_high#CPUUtilization
verdict: real_degradation
evidence: …
recommended_action:
  - action: …
```

一个 task 因装箱（R5.4）可能含最多 6 条 finding，所以 DA 的一次回复里
会有最多 6 个这样的节。`inspdispatch#<task_id>` 那行记着这个 task 装了哪些
finding_id，本模块负责把全文切开、对上号。

## 为什么解析失败不能静默丢

R9.6 要求「解析失败 → 存原文 + 标 `parse_failed`」。三种失败长得完全不一样，
但如果只判「解析到几节」就会被压成同一个结果：

```
一节都没有        DA 没按格式输出（skill 没加载 / 被截断 / 换了措辞）
节数少于预期      部分 finding 被 DA 跳过（可能合理，也可能是它漏了）
节标题对不上号    DA 把 finding_id 抄错了（改了大小写、去掉了 # 段）
```

前两种要保留原文让人看；第三种如果**按位置**硬对（第 i 节配第 i 个
finding_id）会把 A 的分析写到 B 的 finding 上 —— 那比丢掉更坏，
因为报告看起来完整且自信。所以本模块只按 id 精确匹配，绝不按位置回退。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)

# `## <finding_id>` —— 允许 1~6 个 `#`（DA 偶尔用 `###`），
# 但**不允许**标题行里有其他内容：`## db-1 的分析` 不算命中。
# ⚠️ 不用 `^##\s*(.+)$` 那种宽松写法 —— 它会把标题后的说明文字一起吃进 id。
_HEADING = re.compile(r"^#{1,6}[ \t]+(?P<id>\S+)[ \t]*$", re.MULTILINE)

VERDICTS: frozenset[str] = frozenset({
    "real_degradation", "expected_behaviour", "warm_up",
    "insufficient_evidence",
})
"""`verdict` 的**权威取值**，与 skill 输出信封逐字一致
（`inspection/skills/_shared/GUARDRAILS.md` 的 `verdict:` 那一行）。

这里是单一来源。两处元断言钉着它，因为分叉的表现都是静默的：

```
tests/test_inspection_report_parse.py
  ↔ GUARDRAILS.md 里声明的枚举   skill 改了措辞而解析器不认 → verdict 恒空
  ↔ gating.REUSE_DAYS_BY_VERDICT  少一档 → 那一档落回默认复用期，
                                  而 expected_behaviour 的 30 天是自学习降噪的
                                  全部价值（见那张表的 docstring）
```
"""

_VERDICT = re.compile(
    # ^   行首（含缩进）
    # (?:[-*+>][ \t]*)*   列表符号 / 引用符号，如 `- ` `* ` `> `
    # [*_`]*              强调开符号，如 `**` `__` `` ` ``
    # verdict             标签本身（大小写不敏感）
    # [*_`]*              强调闭符号 —— `**verdict**:` 的那一对
    # [ \t]*:             冒号（容忍 `verdict :`）
    # [ \t*_`"'\[]*       值前面的空白 / 强调 / 引号 / 括号，
    #                     覆盖 `**verdict:** x` 与 `verdict: `x``
    r"^[ \t]*(?:[-*+>][ \t]*)*[*_`]*verdict[*_`]*[ \t]*:[ \t*_`\"'\[]*"
    r"(?P<v>[A-Za-z_]+)",
    re.MULTILINE | re.IGNORECASE,
)
"""抽 `verdict:` 那一行的结论。

🔴 **必须容忍 markdown 强调。** 原来的判据是裸 `^verdict:[ \\t]*([a-z_]+)`，
而 2026-08-31 实机实测 DA 写的是：

```
**verdict**: `expected_behaviour`
```

于是 `parse_sections` 返回 `status=ok`（节切出来了、正文完整），而
`verdict` 是**空串** —— 看板卡片上那句一行结论恒空。这一档比 `parse_failed`
更难发现：`parse_status` 是 `ok`，`parse_quality` 全绿，只有卡片上少一行。

⚠️ 放宽之后必须**校验 token**（见 `_verdict_of`）。`da_verdict` 是直接渲染给
客户看的（`FindingCard.tsx` 的 `<b>{f.da_verdict}</b>`、推送卡片的 `· <verdict>`），
且 `gating.reuse_window()` 按它决定抑制多少天。不校验的话
`Verdict: the instance is fine` 会让「the」出现在界面上并落进抑制逻辑。
"""


def _verdict_of(body: str) -> str:
    """从一节正文里抽 `verdict`。认不出的取值返回空串并**吵一声**。

    ⚠️ 认不出时返回空串而不是原样返回：调用方会把它写进 `da_verdict`，
    那个字段直接上界面、并参与 `REUSE_DAYS_BY_VERDICT` 的查表。
    但**必须记日志** —— 「DA 用了一个我们不认识的 verdict」是 skill 漂移的
    早期信号，静默丢掉就等于把这个信号也丢掉。
    """
    m = _VERDICT.search(body)
    if not m:
        return ""
    tok = m.group("v").lower()
    if tok in VERDICTS:
        return tok
    logger.warning(
        "verdict 取值不在契约枚举里，按「没有 verdict」处理: %r（合法值: %s）"
        "—— 若 DA 持续这样输出，说明 skill 的输出信封需要对齐",
        tok, sorted(VERDICTS))
    return ""

_MIN_ID_SEPARATORS = 2
"""标题要被当成节起点，至少要有这么多个 `#` 分隔符。

finding_id 的形状是 6 段（`account#region#service#instance#reason#metric`），
也就是 5 个分隔符。这里只要 2 个，是为了容忍被 DA 改坏的 id
（少抄了几段仍然能对上号或至少进 `unexpected` 诊断）。

🔴 **这个判据不能省。** 不加时 `## 结论` / `## Conclusion` 这类正文小标题
会被当成节起点，于是**上一节的正文在那里被截断** —— 报告里那条 finding
的分析只剩前半段，而 `status` 仍然是 `ok`。实测确认过这个形状：

```
## <finding_id>
verdict: real_degradation
## 结论            ← 松判据在这里切开
升配即可            ← 这段从 finding 的判读里消失了
```

静默丢正文比丢诊断线索坏得多，所以宁可让「DA 把 id 抄成 `db-1`」
退化成 `PARSE_FAILED`（原文仍保留，人一眼能看出来）。
"""


def _looks_like_finding_id(token: str) -> bool:
    """标题是不是 id 形状。见 `_MIN_ID_SEPARATORS`。"""
    return token.count("#") >= _MIN_ID_SEPARATORS

class ParseStatus(str, Enum):
    """整段解析的结果。**四档不可合并** —— 每一档的后续动作不同。"""

    OK = "ok"
    """全部预期的 finding 都找到了对应节。"""

    PARTIAL = "partial"
    """找到了一部分。缺的那些**不当成「没问题」** ——
    它们的判读是缺失的，报告里要标出来（R9.6）。"""

    PARSE_FAILED = "parse_failed"
    """一节都没解析出来，或解析出的节和预期的 id 全不对号。
    ⚠️ 必须存原文：这通常意味着 skill 没加载或输出被截断，
    而原文是唯一能判断是哪种的证据。"""

    EMPTY = "empty"
    """DA 没回任何内容。与 `PARSE_FAILED` 分开：前者是「没东西可解析」，
    后者是「有东西但解析不出」，前者该去查 DA 那侧，后者该去查 skill。"""


@dataclass(frozen=True)
class Section:
    """一条 finding 的判读文本。"""

    finding_id: str
    body: str
    verdict: str = ""

    @property
    def chars(self) -> int:
        return len(self.body)


@dataclass(frozen=True)
class ParseResult:
    """解析产出。**永远含原文**，不管成功还是失败。

    ⚠️ 成功时也留原文（`raw`）：判读文本是我们花了 DA 额度换来的唯一产物，
    而分节解析的正确性只能靠事后对照原文验证。丢掉原文就等于把
    「解析器有没有切错」变成一个不可回答的问题。
    """

    status: ParseStatus
    sections: tuple[Section, ...] = ()
    raw: str = ""
    missing: tuple[str, ...] = ()
    """预期有、但没找到对应节的 finding_id。"""
    unexpected: tuple[str, ...] = ()
    """解析出了节、但不在预期清单里的标题。

    ⚠️ 单独记而不是丢掉：它是「DA 抄错了 finding_id」的**唯一线索**。
    丢掉之后现象是「某条 finding 没有判读」，而真相是判读就在那儿、
    只是标题差了一个字符。"""

    @property
    def ok(self) -> bool:
        return self.status is ParseStatus.OK

    @property
    def needs_raw_fallback(self) -> bool:
        """要不要把原文整段存下来给人看（R9.6）。"""
        return self.status in (ParseStatus.PARSE_FAILED, ParseStatus.PARTIAL)

    def by_finding(self) -> dict[str, Section]:
        return {s.finding_id: s for s in self.sections}


def parse_sections(
    long_report: str | None,
    expected_finding_ids: list[str] | tuple[str, ...] = (),
) -> ParseResult:
    """按 `## <finding_id>` 切开判读全文。

    Args:
        long_report: DA 回复的 markdown 全文。
        expected_finding_ids: 这个 task 装了哪些 finding
            （来自 `inspdispatch#<task_id>` 行）。空表示不做对号，
            解析到什么就返回什么。

    ⚠️ **只按 id 精确匹配，绝不按位置回退。** 按位置对（第 i 节配第 i 个 id）
    会在 DA 少输出一节时把后面全部错位 —— A 的分析写到 B 的 finding 上，
    而报告看起来完整且自信。宁可标 `missing`。
    """
    raw = long_report or ""
    expected = list(expected_finding_ids or ())

    if not raw.strip():
        return ParseResult(status=ParseStatus.EMPTY, raw=raw,
                           missing=tuple(expected))

    all_headings = list(_HEADING.finditer(raw))
    # ⚠️ 只在 **id 形状**的标题处切节。正文小标题（`## 结论`）如果也切，
    #    会把上一节的正文截断，而 status 仍是 ok —— 静默丢报告内容。
    matches = [m for m in all_headings
               if _looks_like_finding_id(m.group("id").strip())]
    prose = [m.group("id").strip() for m in all_headings
             if not _looks_like_finding_id(m.group("id").strip())]
    if prose:
        logger.info(
            "判读里有 %d 个非 id 形状的标题（不作为节起点，正文保留在所属节内）: %s",
            len(prose), prose[:5])

    if not matches:
        logger.warning(
            "判读全文里没有任何 `## <finding_id>` 节标题（%d 字符）—— "
            "大概率 skill 没加载或输出被截断。原文已保留", len(raw))
        return ParseResult(status=ParseStatus.PARSE_FAILED, raw=raw,
                           missing=tuple(expected))

    found: dict[str, Section] = {}
    titles: list[str] = []
    for i, m in enumerate(matches):
        fid = m.group("id").strip()
        titles.append(fid)
        start = m.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(raw)
        body = raw[start:end].strip()
        # ⚠️ 同一个 id 出现两次时**保留第一节**而不是后来者覆盖：
        #    DA 偶尔会在结尾复述一遍标题做总结，那一节通常是空的。
        #    后写覆盖会让真正的分析被一段空文本替掉。
        if fid not in found:
            found[fid] = Section(finding_id=fid, body=body,
                                 verdict=_verdict_of(body))

    if not expected:
        return ParseResult(status=ParseStatus.OK, raw=raw,
                           sections=tuple(found.values()))

    # 按**预期顺序**输出，而不是按 DA 的输出顺序 ——
    # 预期顺序是我们按严重度排过的，报告要照它呈现。
    matched = [found[f] for f in expected if f in found]
    missing = tuple(f for f in expected if f not in found)
    unexpected = tuple(t for t in titles if t not in set(expected))

    if not matched:
        logger.warning(
            "解析出 %d 节但没有一个对上预期的 finding_id —— "
            "DA 可能抄错了 id。解析到的标题: %s；预期: %s",
            len(titles), titles[:3], expected[:3])
        return ParseResult(status=ParseStatus.PARSE_FAILED, raw=raw,
                           sections=tuple(found.values()),
                           missing=missing, unexpected=unexpected)

    status = ParseStatus.OK if not missing else ParseStatus.PARTIAL
    if missing:
        logger.warning("判读缺 %d/%d 条 finding 的节: %s",
                       len(missing), len(expected), missing[:3])
    if unexpected:
        logger.warning(
            "判读里有 %d 个不在预期清单里的节标题（DA 可能抄错 finding_id）: %s",
            len(unexpected), unexpected[:3])
    return ParseResult(status=status, raw=raw, sections=tuple(matched),
                       missing=missing, unexpected=unexpected)
