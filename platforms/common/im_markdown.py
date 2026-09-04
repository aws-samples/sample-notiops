"""IM 端 markdown 降级 —— 把标准 / GFM markdown 变成飞书卡片和 Slack **真的会渲染**的语法。

── 修的是什么（2026-09-03 线上截图）───────────────────────────────────────────────
DevOps Agent 的回答是标准 markdown（`## 标题` + GFM 表格），我们原样塞进飞书卡片的
`{"tag": "markdown"}` 元素。飞书那个元素只认 markdown 的一个**子集**：

    ✅ 粗体 / 斜体 / 删除线 / 链接 / 无序&有序列表 / 代码 / 引用 / 分割线
    ❌ `#`~`######` ATX 标题      —— 整行原样显示成 "## G 系列（图形加速型…）"
    ❌ GFM 表格                   —— 整块原样显示成 "| 实例系列 | GPU 类型 |…" + "|---|---|"
    ❌ 段落内的软换行（单个 `\\n`）—— **被吃掉，不留空格**，于是相邻两行糊成一行
       （线上截图里的 "…published AWS documentationDone" 就是这么来的）

Slack 的 `mrkdwn` 子集更小：上面三条同样不认，另外粗体只认**单个**星号
（`**x**` 会把星号显示给用户看，见 `platforms/slack/app/blocks.to_mrkdwn`），
链接必须是 `<url|text>` 而不是 `[text](url)`。

网页控制台不受影响 —— `frontend/chat-app` 用的是 `react-markdown` + `remark-gfm`，
标题和表格都渲染得了。**这是纯渲染层问题，不要去改 agent 的输出。**

── 为什么放在 `platforms/common/` ─────────────────────────────────────────────────
两个平台的降级规则里，"标题→粗体""表格→带标签的列表"是**同一份**（差异只在 inline：
Slack 还要单星粗体 + `<url|text>`）。各写一遍就会漂移，而 IM 侧历史上最容易复发的
bug 正是"两处各写一遍卡片" —— 见 `platforms/feishu/im_cards.py` 文件头。

── 三条降级口径 ───────────────────────────────────────────────────────────────────
 1. **ATX 标题 → 独立一行的粗体**，前后各留一个空行。不退化成"删掉 `#`"：标题的层级
    信息本来就只剩"这是一个小节名"，粗体是这个子集里唯一能表达它的东西。
 2. **GFM 表格 → 每行一个列表项**，第一列做粗体标题，其余列用**表头自己的文字**做标签：
    `| 实例 | GPU | 显存 |` + `| g6 | L4 | 24GB |` → `- **g6** — GPU: L4 · 显存: 24GB`。
    为什么不退成等宽代码块对齐：CJK 是双宽，手机上还会二次折行，对齐一定崩。
 3. **段落内软换行 → 空行**（只有飞书要）。只在两行**都不是**列表/引用/表格/分割线时插，
    否则会把紧凑列表撑成松散列表。代价是偶尔多一个空行，比糊成一行强得多。

代码块（``` / ~~~ 围栏）内的内容**一律不动** —— 里面的 `#` 和 `|` 是内容，不是语法。
"""
from __future__ import annotations

import re

__all__ = ["to_feishu", "to_slack", "bold_to_mrkdwn"]

#: 代码围栏。进出围栏之间的行原样保留。
_FENCE_RE = re.compile(r"^\s{0,3}(?:```|~~~)")

#: ATX 标题：`### 标题 ###`（尾部的 `#` 是可选的闭合记号，按 CommonMark 丢掉）。
_ATX_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")

#: 块级行（软换行硬化时**不碰**它们，见口径 3）。
_BLOCK_RE = re.compile(r"^\s*(?:[-*+]\s|\d+[.)]\s|>|\||#{1,6}\s|-{3,}$|\*{3,}$|_{3,}$)")

#: markdown 链接 → Slack 的 `<url|text>`。`!` 开头的图片不动（Slack 不支持内联图片，
#: 转成 `<url|alt>` 会把一张图变成一条看不出是图的链接，反而更糊）。
_LINK_RE = re.compile(r"(?<!!)\[([^\]\n]+)\]\(\s*<?([^()\s]+)>?\s*\)")


def bold_to_mrkdwn(s: str) -> str:
    """`**x**` → `*x*`（Slack mrkdwn 的粗体只认单个星号）。

    只处理粗体。斜体不动：markdown 的 `*x*` 与 Slack 的斜体 `_x_` 冲突，盲目互换会把
    已经正确的 mrkdwn 弄坏。`platforms/slack/app/blocks.to_mrkdwn` 委托到这里 ——
    同一条规则两处各写一遍就会漂移。
    """
    return (s or "").replace("**", "*")


# ---------------------------------------------------------------------------
# GFM 表格
# ---------------------------------------------------------------------------
def _is_row(line: str) -> bool:
    """看起来像表格的一行 = 带至少一个 `|`（两列的表格没有前导竖线时只有一个）。

    这么宽是安全的：真正的判据是**下一行必须是 `|---|` 分隔行**（见 `_degrade`），
    而 `_is_delim` 要求那行同时有 `|` 和 `-` —— 散文后面跟一条 `---` 水平线不会命中。
    """
    return "|" in line.strip()


def _is_delim(line: str) -> bool:
    """表头下面那条 `|---|:---:|` 分隔行。"""
    s = line.strip()
    if "|" not in s or "-" not in s:
        return False
    return re.fullmatch(r"[|\s:-]+", s) is not None


def _cells(line: str) -> list[str]:
    """切单元格。**不处理 `\\|` 转义** —— agent 的表格里没见过，真出现只是多切一格，
    不会丢内容（GFM 那种"多出来的格子被静默丢掉"才是真问题）。"""
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


#: 表格里表示"这一格没有值"的占位符 —— 渲染成 `列名: -` 是纯噪音。
_EMPTY_CELLS = {"", "-", "–", "—", "n/a", "N/A", "无"}


def _table_to_bullets(header: list[str], rows: list[list[str]]) -> list[str]:
    """`(表头, 数据行)` → 每行一个列表项。**不丢任何一格**：列数比表头多的那几格
    没有标签，照样接在后面（GFM 会把它们静默丢掉，我们不）。"""
    if not rows:
        # 只有表头没有数据 —— 至少把表头本身留下来，别整块消失。
        labels = [h for h in header if h not in _EMPTY_CELLS]
        return ["- " + " · ".join(labels)] if labels else []
    out: list[str] = []
    for cells in rows:
        title = cells[0].strip() if cells else ""
        parts: list[str] = []
        for i, c in enumerate(cells[1:], start=1):
            c = c.strip()
            if c in _EMPTY_CELLS:
                continue
            label = header[i].strip() if i < len(header) else ""
            parts.append(f"{label}: {c}" if label not in _EMPTY_CELLS else c)
        bits = " · ".join(parts)
        if title not in _EMPTY_CELLS and bits:
            out.append(f"- **{title}** — {bits}")
        elif title not in _EMPTY_CELLS:
            out.append(f"- **{title}**")
        elif bits:
            out.append(f"- {bits}")
    return out


# ---------------------------------------------------------------------------
# 两个平台共用的结构降级
# ---------------------------------------------------------------------------
def _degrade(md: str) -> str:
    """标题 → 粗体行，GFM 表格 → 列表。代码围栏内原样。"""
    lines = (md or "").split("\n")
    out: list[str] = []
    i, in_fence = 0, False
    while i < len(lines):
        ln = lines[i]
        if _FENCE_RE.match(ln):
            in_fence = not in_fence
            out.append(ln)
            i += 1
            continue
        if in_fence:
            out.append(ln)
            i += 1
            continue
        if _is_row(ln) and i + 1 < len(lines) and _is_delim(lines[i + 1]):
            header = _cells(ln)
            j = i + 2
            rows: list[list[str]] = []
            while j < len(lines) and _is_row(lines[j]) and not _is_delim(lines[j]):
                rows.append(_cells(lines[j]))
                j += 1
            block = _table_to_bullets(header, rows)
            if block:
                if out and out[-1].strip():
                    out.append("")
                out.extend(block)
                out.append("")
            i = j
            continue
        m = _ATX_RE.match(ln)
        if m:
            text = m.group(2).strip()
            if out and out[-1].strip():
                out.append("")
            out.append(f"**{text}**" if text else "")
            out.append("")
            i += 1
            continue
        out.append(ln)
        i += 1
    return "\n".join(out)


def _harden_breaks(md: str) -> str:
    """段落内的软换行 → 空行（见口径 3）。飞书专用。"""
    lines = md.split("\n")
    out: list[str] = []
    in_fence = False
    for k, ln in enumerate(lines):
        fence = bool(_FENCE_RE.match(ln))
        if fence:
            in_fence = not in_fence
        out.append(ln)
        if in_fence or fence or k + 1 >= len(lines):
            continue
        nxt = lines[k + 1]
        if not ln.strip() or not nxt.strip():
            continue
        # 当前行是列表/引用/表格/分割线 → 不动（否则紧凑列表被撑成松散列表）。
        if _BLOCK_RE.match(ln):
            continue
        out.append("")
    return "\n".join(out)


def _map_outside_fences(md: str, fn) -> str:
    """只对代码围栏**外**的行做 inline 替换。"""
    out: list[str] = []
    in_fence = False
    for ln in (md or "").split("\n"):
        if _FENCE_RE.match(ln):
            in_fence = not in_fence
            out.append(ln)
            continue
        out.append(ln if in_fence else fn(ln))
    return "\n".join(out)


# ---------------------------------------------------------------------------
# 平台入口
# ---------------------------------------------------------------------------
def to_feishu(md: str) -> str:
    """飞书卡片 `{"tag": "markdown"}` 能渲染的形式。

    ⚠️ 调用点在**渲染函数里**（`platforms/feishu/im_cards.py`），且必须在
    `long_answer.clip()` **之前** —— 降级会改变长度，先 clip 再降级就可能又超上限
    （飞书超限是整张卡不显示）。
    """
    return _harden_breaks(_degrade(md or ""))


def to_slack(md: str) -> str:
    """Slack `mrkdwn` section 能渲染的形式。

    比飞书多两条 inline 转换：单星粗体、`<url|text>` 链接。软换行**不动** ——
    Slack 的 mrkdwn 里单个 `\\n` 本来就是真换行。
    调用点同飞书：`platforms/slack/im_blocks.py`，在 `long_answer.clip()` 之前。
    """
    s = _degrade(md or "")
    return _map_outside_fences(
        s, lambda ln: bold_to_mrkdwn(_LINK_RE.sub(r"<\2|\1>", ln)))
