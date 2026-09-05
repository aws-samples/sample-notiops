"""DevOps Agent `ui_investigation_summary` 组件树 → markdown（纯函数，零 IO）。

## 这是什么

DevOps Agent 的调查结束时会写一条 `recordType == "ui_investigation_summary"`
的 journal 记录。它**不是 markdown**，而是后台调查详情页那几个面板的
**UI 组件树**（`{type, id, text, props, children}` 递归结构）。DA 控制台
渲染的「Summary」「Root cause」「Investigation timeline」都出自这一条记录。

## 为什么把它提到一个独立模块

2026-09-05 之前这套摊平逻辑只有一份，在
`agent-build/NotiOpsWebChat/app/NotiOpsWebChat/core/devops_agent.py` 里
（web chat 的 agent 用），而 **IM 侧的报告管道压根没有** ——
`shared/report_delivery/report_handler.py` 的取正文四级里没有这一档，于是
同一次调查在 web 上有结构化的「概要 / 核心建议」，在 IM 的报告 HTML 里
只能落到一段对话式的 `assistant_message`，「调查 Trace」页更是常年空白。
那是用户 2026-09-05 报的 D1/D2 的一半成因。

同一份树、两个部署单元（AgentCore Runtime / report-handler Lambda）要读，
所以逻辑必须只有一份。本模块两棵 `core/` 树逐字节一致，由
`tests/test_core_tree_parity.py` 的 `_MUST_MATCH` 锁住。

## 实测的树形状（2026-08 ~ 2026-09 多次核对）

```
container
  card#summary                       ← 执行摘要卡
    card-header#summary__header        标题 + 状态/严重性徽章
    markdown#summary__incident         「概要」一节（DA 自己生成的标题文字）
    markdown#summary__cause            「核心建议」一节（有些调查没有这一节）
  card#records                       ← 调查过程时间线
    accordion#records__acc
      accordion-item#records__rec_1    每一步：trigger 行 + 正文
      accordion-item#records__rec_2
      …
```

🔴 **按 `id` 前缀选卡，不按第几个孩子。** 子节点的**数量和顺序都会变**
（早期注释里写的是「四张卡」，2026-09 实测只有两张），而 `id` 的前缀段
（`__` 之前那一截）是后台稳定用的。按序号选会在 DA 改版当天静默取到错的一张。

🔴 **一个中文标题都不许硬编码。** 「概要」「核心建议」这些标题是 **DA 按本次
调查生成的**（不同调查会不一样），本模块只做结构 → markdown 的**透传**。
这也是本模块能不进 i18n 表的原因：它自己一个字的文案都不产出。
"""

from __future__ import annotations

import json

# 这些 leaf type 当作「标题文字」看待（合成 card-header / accordion-trigger 的那一行）
_HEADING_TYPES = {"title", "card-title"}


def leaves(node) -> list[tuple[str, str]]:
    """深度优先收集 `(type, text)` 叶子文本。type 已 lower。"""
    out: list[tuple[str, str]] = []
    if not isinstance(node, dict):
        return out
    s = node.get("text")
    if isinstance(s, str) and s.strip():
        out.append(((node.get("type") or "").lower(), s.strip()))
    for ch in node.get("children") or []:
        out.extend(leaves(ch))
    return out


def flatten(node, out: list[str]) -> None:
    """把组件树摊平成 markdown 行，追加到 `out`。

    正文**一律原文透传**，只映射层级与列表符号。产出的标题从 `###` 起
    —— 调用方外面套的章节标题是 `##`。
    """
    if not isinstance(node, dict):
        return
    t = (node.get("type") or "").lower()
    txt = (node.get("text") or "").strip()
    props = node.get("props") or {}
    kids = node.get("children") or []
    if t in ("card-header", "accordion-trigger"):
        # 标题行：标题文字 + 徽章合成**一行**（徽章用 code 记号，避免与正文混淆）
        lv = leaves(node)
        heads = [s for k, s in lv if k in _HEADING_TYPES or k == "text"]
        badges = [s for k, s in lv if k == "badge"]
        descs = [s for k, s in lv if k in ("card-description", "markdown")]
        line = " ".join(f"**{h}**" for h in heads[:1]) if heads else ""
        if badges:
            line = (line + " " if line else "") + " · ".join(f"`{b}`" for b in badges)
        if line:
            out.append(line)
        out.extend(descs)
        return
    if t == "title":
        lvl = props.get("level")
        try:
            lvl = int(lvl)
        except (TypeError, ValueError):
            lvl = 3
        if txt:
            out.append("#" * max(3, min(6, lvl)) + " " + txt)
        return
    if t in ("markdown", "text", "paragraph", "code"):
        if txt:
            out.append(txt)
        return
    if t == "badge":
        if txt:
            out.append(f"`{txt}`")
        return
    if t == "list-item":
        if txt:
            out.append(f"- {txt}")
        return
    if txt:
        out.append(txt)
    for ch in kids:
        flatten(ch, out)


def tree_from_records(records) -> dict | None:
    """从 journal records 里取**最后一条** `ui_investigation_summary` 的树。

    取最后一条是有意的：DA 在调查过程中会多次覆盖写这条记录，最后那条才是终版。
    解析失败 / 没有这类记录 → `None`（调用方据此退化，**不要**抛）。
    """
    tree = None
    for r in records or []:
        if not isinstance(r, dict):
            continue
        if r.get("recordType") != "ui_investigation_summary":
            continue
        c = r.get("content")
        try:
            c = json.loads(c) if isinstance(c, str) else c
        except (ValueError, TypeError):
            continue
        if isinstance(c, dict):
            # 外层可能再包一层 {"content": {...}}
            tree = c.get("content") if isinstance(c.get("content"), dict) else c
    return tree if isinstance(tree, dict) else None


def find_card(tree, id_prefix: str, *, fallback_first: bool = False) -> dict | None:
    """在树里找 `type == "card"` 且 `id` 的前缀段等于 `id_prefix` 的那张卡。

    `fallback_first=True` 时找不到就退化成「树里第一张 card」。

    ⚠️ 默认 **不**退化：那个退化只对「摘要卡」成立（第一张恰好就是它）。
    找时间线卡（`records`）时退化会静默返回摘要卡 —— 于是 Trace 页显示的是
    报告正文的复制品，而那种错比空页面更难发现。
    """
    if not isinstance(tree, dict):
        return None
    found: list[dict] = []

    def _walk(n) -> None:
        if found or not isinstance(n, dict):
            return
        if (n.get("type") or "").lower() == "card":
            if str(n.get("id") or "").split("__")[0] == id_prefix:
                found.append(n)
                return
        for ch in n.get("children") or []:
            _walk(ch)

    _walk(tree)
    if found:
        return found[0]
    if not fallback_first:
        return None

    def _first_card(n):
        if not isinstance(n, dict):
            return None
        if (n.get("type") or "").lower() == "card":
            return n
        for ch in n.get("children") or []:
            got = _first_card(ch)
            if got is not None:
                return got
        return None

    return _first_card(tree)


def card_md(records, id_prefix: str, *, fallback_first: bool = False) -> str:
    """`records` → 指定卡片的 markdown。取不到返回空串。"""
    card = find_card(tree_from_records(records), id_prefix,
                     fallback_first=fallback_first)
    if card is None:
        return ""
    lines: list[str] = []
    flatten(card, lines)
    return "\n\n".join(x for x in lines if x).strip()


def summary_md(records) -> str:
    """执行摘要卡（DA 控制台的 Summary + Root cause 两节）→ markdown。

    这一段就是用户要在「查看调查报告」页看到的内容。
    """
    return card_md(records, "summary", fallback_first=True)


def timeline_md(records) -> str:
    """调查过程卡（DA 控制台的 Investigation timeline）→ markdown。

    这一段是用户要在「调查 Trace」页看到的内容。**不**退化到第一张卡，
    理由见 `find_card`。
    """
    return card_md(records, "records")
