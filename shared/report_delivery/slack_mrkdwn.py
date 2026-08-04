"""
Convert generic GitHub-flavored markdown to Slack-mrkdwn-friendly blocks.

Slack mrkdwn (the Web API's block markup) supports:
  - *bold*, _italic_, ~strike~, `inline code`, ```code block```
  - >blockquote
  - <url|label>, <@userid>
  - bulleted lists with leading "• " or "- "
  - numbered lists with "1. "

Slack mrkdwn does NOT support:
  - Markdown headers (`#`, `##`, `###`)  — render as plain text
  - GFM pipe tables (`| col1 | col2 |`)   — render as plain text
  - Double-asterisk **bold**             — only single `*` works
  - Underscore `_italic_` mid-word       — gets eaten

DevOps Agent's Report Summary is GFM. Sending it raw makes it look like
a wall of text. This module converts it into a list of Slack `section`
blocks, each rendered with proper mrkdwn so the output is actually
readable in Slack.

Strategy (line-by-line):
  - `# Heading 1`   → header block (≥ Slack header limit) or *bold + emoji*
  - `## Heading 2`  → section "*▎ Heading 2*"
  - `### Heading 3` → section "*◆ Heading 3*"
  - GFM table       → render as ASCII-aligned table inside a triple-
                       backtick code block (monospace = visible columns;
                       handles CJK + emoji widths via east-asian-width)
  - fenced code     → keep as triple-backtick block in mrkdwn
  - `**bold**`      → `*bold*`
  - everything else → passthrough into the current section paragraph

We accumulate paragraphs until we hit a header / table / code block
boundary, then flush. Each flushed chunk becomes one section block,
which keeps Slack's per-block 3000-char text limit honored.
"""
from __future__ import annotations

import re
import unicodedata

# Slack section text limit is 3000 chars. We split paragraph buffers a bit
# below that to leave headroom for our own decoration.
_PARA_MAX = 2800
_TABLE_LINE_RE = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEP_RE = re.compile(r"^\s*\|?[\s:|\-]+\|?\s*$")
_HEADER_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
_HORIZONTAL_RULE_RE = re.compile(r"^\s*[-=*]{3,}\s*$")


def to_blocks(md: str, *, header_text: str = "📝 Report Summary") -> list[dict]:
    """Render `md` as a list of Slack Block Kit blocks. Always begins
    with a `header` block carrying `header_text`."""
    blocks: list[dict] = [
        {"type": "header",
         "text": {"type": "plain_text",
                  "text": header_text[:150],
                  "emoji": True}},
    ]
    paragraph_buf: list[str] = []

    def flush_paragraph() -> None:
        if not paragraph_buf:
            return
        text = "\n".join(paragraph_buf).strip()
        paragraph_buf.clear()
        if not text:
            return
        # Apply inline transforms once on the joined paragraph so multi-
        # line bold spans (rare) work too.
        text = _convert_inline(text)
        # Split if oversized — Slack rejects sections over 3000 chars.
        for chunk in _chunks(text, _PARA_MAX):
            blocks.append({"type": "section",
                           "text": {"type": "mrkdwn", "text": chunk}})

    lines = (md or "").splitlines()
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]

        # ---- fenced code block ----
        if line.lstrip().startswith("```"):
            flush_paragraph()
            i += 1
            code_lines: list[str] = []
            while i < n and not lines[i].lstrip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            i += 1  # skip closing fence (or EOF)
            code_block = "\n".join(code_lines).strip("\n")
            if code_block:
                # Slack mrkdwn supports triple-backtick blocks.
                wrapped = f"```{code_block}```"
                for chunk in _chunks(wrapped, _PARA_MAX):
                    blocks.append({"type": "section",
                                   "text": {"type": "mrkdwn", "text": chunk}})
            continue

        # ---- horizontal rule ----
        if _HORIZONTAL_RULE_RE.match(line):
            flush_paragraph()
            blocks.append({"type": "divider"})
            i += 1
            continue

        # ---- pipe table ----
        if _TABLE_LINE_RE.match(line):
            j = i
            while j < n and _TABLE_LINE_RE.match(lines[j]):
                j += 1
            flush_paragraph()
            blocks.extend(_render_table_as_sections(lines[i:j]))
            i = j
            continue

        # ---- header ----
        m = _HEADER_RE.match(line)
        if m:
            flush_paragraph()
            level = len(m.group(1))
            heading_text = m.group(2).strip()
            blocks.append(_render_header_as_block(level, heading_text))
            i += 1
            continue

        # ---- regular paragraph line ----
        paragraph_buf.append(line)
        # Empty line breaks a paragraph (Slack honors line breaks within
        # a section, but very long sections look cramped — flush at
        # blank lines too).
        if not line.strip():
            flush_paragraph()
        i += 1

    flush_paragraph()
    return blocks


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------
def _render_header_as_block(level: int, text: str) -> dict:
    """Slack has a real `header` block but only one font size, and the
    Block Kit header doesn't support mrkdwn. We use it for h1, and a
    decorated bold mrkdwn section for h2/h3+."""
    if level == 1:
        return {"type": "header",
                "text": {"type": "plain_text",
                         "text": text[:150], "emoji": True}}
    if level == 2:
        return {"type": "section",
                "text": {"type": "mrkdwn",
                         "text": f"*▎ {_convert_inline(text)}*"}}
    if level == 3:
        return {"type": "section",
                "text": {"type": "mrkdwn",
                         "text": f"*◆ {_convert_inline(text)}*"}}
    return {"type": "section",
            "text": {"type": "mrkdwn",
                     "text": f"*{_convert_inline(text)}*"}}


# Slack section text limit is 3000 chars. We chunk a code-block table
# *by row* if it would overshoot, opening a fresh ``` block per chunk.
_CODEBLOCK_MAX = 2800


def _visual_width(s: str) -> int:
    """Monospace visual width — CJK / fullwidth = 2, ascii = 1, emoji = 2.

    Slack's code-block font (Lato Mono / Menlo on Mac) renders East Asian
    Wide chars at ~2× the width of an ASCII char, so we count them as 2
    columns when computing padding. Without this, alignment breaks the
    moment a row contains 名称 / 区域 / 状态 etc.

    Subtle cases handled here that mainstream `wcwidth` libraries get
    wrong:

      1. **Symbol-other (category=So)** — covers most pictographic
         emoji (✅ ❌ 📊 ⚠ etc.). Most are EAW=W already; the few
         EAW=N ones (e.g. ⚠ U+26A0 alone) we still want at 2 cols
         because Slack renders them as emoji glyphs.
      2. **Variation Selectors (U+FE00..U+FE0F)** — zero-width
         "render-as-emoji" modifiers that follow a base char. They
         must count as 0 (the base char's width is what matters).
      3. **Zero-width joiners / combining marks** — drop entirely.
    """
    w = 0
    for ch in s:
        cp = ord(ch)
        # Variation Selectors-1..16 (U+FE00..FE0F) and ZWJ — zero width.
        if 0xFE00 <= cp <= 0xFE0F or cp == 0x200D:
            continue
        # Combining marks (e.g. accents)
        if unicodedata.category(ch) == "Mn":
            continue
        eaw = unicodedata.east_asian_width(ch)
        if eaw in ("F", "W"):
            w += 2
        elif unicodedata.category(ch) == "So":
            # Pictographic symbols (most emoji) — render at 2 cols
            # even when EAW=N (e.g. ⚠ U+26A0).
            w += 2
        else:
            w += 1
    return w


def _pad(text: str, width: int) -> str:
    """Right-pad `text` to `width` visual columns using ASCII spaces.

    NOTE: relies on Slack rendering the surrounding ``` block in a
    monospace font where ASCII space = 1 col. If the user is on a
    client that ignores `code_block_tone_marker` styling, the padding
    will look slightly off but rows still stay on their own lines.
    """
    return text + " " * max(0, width - _visual_width(text))


def _render_table_as_sections(table_lines: list[str]) -> list[dict]:
    """Render a GFM pipe table as an ASCII-aligned table inside a Slack
    code block.

    Why a code block, not blocks-with-fields:
      - Slack's Block Kit `fields` only supports 2 columns (max 10
        fields per section), totally inadequate for typical 5-7 col
        AWS tables.
      - Plain mrkdwn lines wrap on narrow viewports, destroying alignment.
      - Code blocks use monospace, so `_pad`-aligned rows survive.
      - emoji / CJK width is corrected via `_visual_width` so columns
        actually line up across mixed-language content.

    Trade-offs accepted:
      - Wide tables overflow horizontally on mobile (Slack adds a
        horizontal scroll bar inside the code block).
      - Cells lose markdown — no bold, no clickable links. The Agent
        rarely puts those into the table cells anyway; if it does, we
        strip them via `_strip_md_for_codeblock`.
    """
    rows: list[list[str]] = []
    for raw in table_lines:
        if _TABLE_SEP_RE.match(raw) and "-" in raw:
            continue
        cells = [c.strip() for c in raw.strip().strip("|").split("|")]
        if cells:
            rows.append(cells)
    if not rows:
        return []

    # Strip markdown decorations from every cell (code blocks don't
    # render them anyway). Empty cells get an em-dash placeholder.
    rows = [[_strip_md_for_codeblock(c) or "—" for c in row] for row in rows]
    headers = rows[0]
    body_rows = rows[1:]

    n_cols = len(headers)
    # Defensively pad short rows
    body_rows = [(r + [""] * n_cols)[:n_cols] for r in body_rows]
    body_rows = [[c if c else "—" for c in r] for r in body_rows]

    if not body_rows:
        # Header-only table — render headers in a code block
        return _wrap_code_block([" │ ".join(headers)])

    # Per-column visual width = max(header, all body cells)
    col_widths = [
        max(_visual_width(headers[i]),
            max((_visual_width(row[i]) for row in body_rows), default=0))
        for i in range(n_cols)
    ]

    def render_row(row: list[str]) -> str:
        return " │ ".join(_pad(row[i], col_widths[i]) for i in range(n_cols))

    sep_line = "─┼─".join("─" * w for w in col_widths)

    lines: list[str] = [render_row(headers), sep_line]
    lines.extend(render_row(r) for r in body_rows)

    return _wrap_code_block(lines)


def _strip_md_for_codeblock(cell: str) -> str:
    """Strip markdown decorations that Slack code blocks render literally
    (so we don't end up with `**foo**` or `\\`bar\\`` showing as actual
    asterisks / backticks in the output)."""
    if not cell:
        return ""
    # **bold** / *italic* → bare text
    cell = re.sub(r"\*\*(.+?)\*\*", r"\1", cell)
    # `inline code` → bare text
    cell = re.sub(r"`([^`]+)`", r"\1", cell)
    # [text](url) → text
    cell = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", cell)
    return cell.strip()


def _wrap_code_block(lines: list[str]) -> list[dict]:
    """Wrap rendered table lines in one or more triple-backtick code-
    block sections, splitting if a single block would exceed Slack's
    per-section 3000-char limit. Each chunk repeats the header line so
    every block is self-describing.
    """
    if not lines:
        return []
    header = lines[0]
    sep = lines[1] if len(lines) >= 2 and "─" in lines[1] else ""
    body = lines[2:] if sep else lines[1:]

    blocks: list[dict] = []
    # Account for the surrounding ``` markers + separator
    overhead = len("```\n```") + len(header) + len(sep) + 4

    def emit(chunk_body_lines: list[str]) -> None:
        if not chunk_body_lines:
            return
        parts = ["```", header]
        if sep:
            parts.append(sep)
        parts.extend(chunk_body_lines)
        parts.append("```")
        text = "\n".join(parts)
        blocks.append({"type": "section",
                       "text": {"type": "mrkdwn", "text": text}})

    cur: list[str] = []
    cur_len = 0
    for line in body:
        line_len = len(line) + 1
        if cur_len + line_len + overhead > _CODEBLOCK_MAX and cur:
            emit(cur)
            cur, cur_len = [], 0
        cur.append(line)
        cur_len += line_len
    emit(cur)
    return blocks


# ---------------------------------------------------------------------------
# Inline transforms
# ---------------------------------------------------------------------------
def _convert_inline(text: str) -> str:
    if not text:
        return ""
    # GFM **bold** → Slack *bold*. Be careful: Slack uses the same
    # asterisk for italic (it's actually bold there), and double-asterisk
    # is illegal — it just renders literal asterisks. So we collapse.
    text = _BOLD_RE.sub(r"*\1*", text)
    return text


def _chunks(text: str, size: int) -> list[str]:
    """Split text into chunks ≤ size characters, preferring newline
    boundaries so we don't break in the middle of a sentence."""
    if len(text) <= size:
        return [text]
    out: list[str] = []
    while len(text) > size:
        # Try the last newline within window
        cut = text.rfind("\n", 0, size)
        if cut < size // 2:
            cut = size
        out.append(text[:cut])
        text = text[cut:].lstrip("\n")
    if text:
        out.append(text)
    return out
