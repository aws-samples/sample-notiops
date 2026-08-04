"""
Minimal Feishu OpenAPI client used by the report handler to deliver investigation
results back to Feishu when a result event was triggered by the Feishu bot.

Stdlib only (no extra Lambda layer needed).
"""
from __future__ import annotations
from shared.net import safe_urlopen

import json
import logging
import os
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import boto3

from core import i18n

logger = logging.getLogger(__name__)

OPENAPI_BASE = "https://open.feishu.cn/open-apis"

_sm = boto3.client("secretsmanager")

_app_id: str | None = None
_app_secret: str | None = None
_token: str | None = None
_token_expiry: float = 0.0
_lock = threading.Lock()


def _credentials() -> tuple[str, str]:
    """Lazy-load Feishu app credentials.

    Supports two modes (auto-detect):
    1. 融合架构(单 JSON Secret): FEISHU_SECRET_ARN 或 FEISHU_SECRET_NAME
       → {"app_id":"...","app_secret":"..."}
    2. Legacy(双 Secret): FEISHU_APP_ID_ARN + FEISHU_APP_SECRET_ARN(各存明文）

    Returns ("","") if neither mode configured.
    """
    global _app_id, _app_secret
    if _app_id and _app_secret:
        return _app_id, _app_secret

    # Mode 1: single JSON secret (融合架构,CDK 注入 FEISHU_SECRET_ARN)
    secret_name = os.environ.get("FEISHU_SECRET_ARN") or os.environ.get("FEISHU_SECRET_NAME", "")
    if secret_name:
        try:
            raw = _sm.get_secret_value(SecretId=secret_name)["SecretString"]
            data = json.loads(raw)
            _app_id = data.get("app_id", "").strip()
            _app_secret = data.get("app_secret", "").strip()
            if _app_id and _app_secret:
                return _app_id, _app_secret
        except Exception as e:
            logger.warning("feishu_sender: load from %s failed: %s", secret_name, e)

    # Mode 2: legacy dual secrets
    app_id_arn = os.environ.get("FEISHU_APP_ID_ARN", "")
    app_secret_arn = os.environ.get("FEISHU_APP_SECRET_ARN", "")
    if app_id_arn and app_secret_arn:
        _app_id = _sm.get_secret_value(SecretId=app_id_arn)["SecretString"].strip()
        _app_secret = _sm.get_secret_value(SecretId=app_secret_arn)["SecretString"].strip()
        return _app_id, _app_secret

    return "", ""


def _get_token() -> str | None:
    global _token, _token_expiry
    with _lock:
        if _token and time.time() < _token_expiry - 300:
            return _token
        app_id, app_secret = _credentials()
        if not app_id:
            return None
        body = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode("utf-8")
        req = Request(f"{OPENAPI_BASE}/auth/v3/tenant_access_token/internal",
                      data=body, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with safe_urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            logger.error("Feishu token fetch failed: %s", e)
            return None
        if data.get("code") != 0:
            # 只记录 code/msg，绝不打印整个响应体（token 端点响应含 tenant_access_token）
            logger.error("Feishu token api error: code=%s msg=%s", data.get("code"), data.get("msg"))
            return None
        _token = data["tenant_access_token"]
        _token_expiry = time.time() + int(data.get("expire", 7200))
        return _token


def is_configured() -> bool:
    """True if any credential source is available (single JSON or dual ARN)."""
    if os.environ.get("FEISHU_SECRET_ARN") or os.environ.get("FEISHU_SECRET_NAME"):
        return True
    return bool(os.environ.get("FEISHU_APP_ID_ARN") and os.environ.get("FEISHU_APP_SECRET_ARN"))


def _post(path: str, payload: dict) -> dict:
    """Generic Feishu OpenAPI POST. Returns parsed JSON or {} on failure."""
    token = _get_token()
    if not token:
        return {}
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = Request(f"{OPENAPI_BASE}{path}", data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with safe_urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") != 0:
                logger.error("Feishu API %s error: code=%s msg=%s", path, data.get("code"), data.get("msg"))
            return data
    except (HTTPError, URLError) as e:
        logger.error("Feishu API %s HTTP error: %s", path, e)
        return {}


def _try_send_card(chat_id: str | None, root_message_id: str | None,
                    card: dict) -> bool:
    """Send a card. Returns True on success, False on any API/network error.

    Use this when callers need to fall back to an alternative card on
    failure (e.g., v2 → v1 schema downgrade for the report summary).
    `_send_card` is the fire-and-forget wrapper around this.
    """
    if not chat_id:
        logger.error("_send_card: no chat_id; skipping (root_message_id=%s)",
                     root_message_id)
        return False
    content = json.dumps(card, ensure_ascii=False)
    body = json.dumps({
        "receive_id": chat_id, "msg_type": "interactive", "content": content,
    }, ensure_ascii=False).encode("utf-8")
    token = _get_token()
    if not token:
        return False
    req = Request(
        f"{OPENAPI_BASE}/im/v1/messages?receive_id_type=chat_id",
        data=body, method="POST",
    )
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with safe_urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") != 0:
                logger.error("Feishu send_card error: code=%s msg=%s", data.get("code"), data.get("msg"))
                return False
            return True
    except HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read().decode("utf-8")[:1000]
        except Exception:
            pass
        logger.error("Feishu direct-send HTTPError %d: %s", e.code, body_txt)
        return False
    except Exception as e:
        logger.error("Feishu direct-send error: %s", e)
        return False


def _send_card(chat_id: str | None, root_message_id: str | None, card: dict) -> None:
    """Send an interactive card to the group main timeline (chat_id).

    Fire-and-forget wrapper around `_try_send_card`. We intentionally do
    NOT use thread reply because Feishu renders thread replies in a
    "topic" side panel that some mobile clients show as a DM-like view,
    causing users to miss messages.
    """
    _try_send_card(chat_id, root_message_id, card)


# ---------------------------------------------------------------------------
# Markdown -> Feishu interactive card elements
#
# Feishu's lark_md only supports inline markdown (**bold**, *italic*,
# `code`, [text](url), blockquote). It does NOT render headers, fenced
# code, or pipe tables — and it doesn't have a true monospace mode, so
# text-aligned tables look broken (CJK widths can't be honored without
# a fixed-width font).
#
# Strategy: parse markdown line-by-line and emit a list of card
# elements rather than one giant lark_md string:
#   - paragraphs/headers/lists  → div + lark_md (with visual decoration
#                                  for headers since lark_md has none)
#   - fenced code               → div + lark_md with each line wrapped
#                                  in `inline code` ticks (Feishu *does*
#                                  use a monospace font for inline code)
#   - pipe tables               → column_set element (native Feishu
#                                  layout that adapts to chat width)
#   - horizontal rule           → hr element
# ---------------------------------------------------------------------------
import re as _re


_TABLE_LINE_RE = _re.compile(r"^\s*\|.*\|\s*$")
_TABLE_SEP_RE = _re.compile(r"^\s*\|?[\s:|\-]+\|?\s*$")
_HEADER_RE = _re.compile(r"^(#{1,6})\s+(.*)$")


def _md_to_card_elements(md: str) -> list[dict]:
    """Parse markdown into a list of Feishu interactive-card elements."""
    if not md:
        return []
    lines = md.split("\n")
    elements: list[dict] = []
    para_buf: list[str] = []  # accumulates lines for the next div element

    def flush_para():
        if not para_buf:
            return
        text = "\n".join(para_buf).strip()
        para_buf.clear()
        if text:
            elements.append({"tag": "div",
                             "text": {"tag": "lark_md", "content": text}})

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]

        # ---- fenced code ```lang ... ``` ----
        if line.lstrip().startswith("```"):
            flush_para()
            i += 1
            code_buf: list[str] = []
            while i < n and not lines[i].lstrip().startswith("```"):
                code_buf.append(lines[i])
                i += 1
            i += 1  # skip closing fence (or EOF)
            elements.extend(_emit_code_block(code_buf))
            continue

        # ---- pipe tables ----
        if _TABLE_LINE_RE.match(line):
            j = i
            while j < n and _TABLE_LINE_RE.match(lines[j]):
                j += 1
            flush_para()
            elements.extend(_render_pipe_table_as_columns(lines[i:j]))
            i = j
            continue

        # ---- headers ----
        m = _HEADER_RE.match(line)
        if m:
            flush_para()
            level = len(m.group(1))
            text = m.group(2).strip()
            elements.append({"tag": "div",
                             "text": {"tag": "lark_md",
                                      "content": _render_header(level, text)}})
            i += 1
            continue

        # ---- horizontal rule ----
        if _re.match(r"^\s*[-=*]{3,}\s*$", line):
            flush_para()
            elements.append({"tag": "hr"})
            i += 1
            continue

        # ---- everything else: accumulate into paragraph buffer ----
        para_buf.append(line)
        i += 1

    flush_para()
    return elements


def _render_header(level: int, text: str) -> str:
    """lark_md has no real headers; simulate visual hierarchy with decoration."""
    if level == 1:
        return f"**━━━ {text} ━━━**"
    if level == 2:
        return f"**▎ {text}**"
    if level == 3:
        return f"**◆ {text}**"
    return f"**{text}**"


def _emit_code_block(block_lines: list[str]) -> list[dict]:
    """Render a fenced code block. lark_md uses a monospace font for inline
    `code`, so we wrap each line individually in single backticks and chain
    them with newlines — gives a passable monospace block.
    """
    if not block_lines:
        return []
    # Collapse trailing empty lines but keep interior structure
    while block_lines and not block_lines[-1].strip():
        block_lines.pop()
    if not block_lines:
        return []
    rendered_lines = []
    for ln in block_lines:
        if not ln:
            rendered_lines.append("")
            continue
        # Escape backticks inside content so we don't break the wrapping ticks
        safe = ln.replace("`", "ˋ")
        rendered_lines.append(f"`{safe}`")
    return [{
        "tag": "div",
        "text": {"tag": "lark_md", "content": "\n".join(rendered_lines)},
    }]


def _render_pipe_table_as_columns(table_lines: list[str]) -> list[dict]:
    """Render a GFM pipe table as a series of Feishu elements that look like
    a real table: header row (grey background) + body rows (white) + a
    horizontal rule between every row to give the grid feel.

    Layout strategy: one column_set PER row (not per column). This way each
    row is a horizontal band that can have its own background color, and
    between bands we drop in `hr` elements as separators. Cells share a
    common width via `weight: 1` so columns line up across rows.
    """
    rows: list[list[str]] = []
    for raw in table_lines:
        if _TABLE_SEP_RE.match(raw) and "-" in raw:
            continue
        cells = raw.strip().strip("|").split("|")
        cells = [c.strip() for c in cells]
        if cells:
            rows.append(cells)

    if not rows:
        return [{"tag": "div",
                 "text": {"tag": "plain_text", "content": "(empty table)"}}]

    n_cols = max(len(r) for r in rows)
    for r in rows:
        while len(r) < n_cols:
            r.append("")

    def make_row(cells: list[str], is_header: bool = False) -> dict:
        columns = []
        for idx, cell in enumerate(cells):
            text = (f"**{cell}**" if is_header else cell) or " "
            # Prefix every cell except the first with a thin vertical bar
            # to give a "column separator" feel — Feishu column_set has no
            # native cell borders, so this is the cleanest visual hack.
            if idx > 0:
                text = f"▏ {text}"
            columns.append({
                "tag": "column",
                "width": "weighted",
                "weight": 1,
                "vertical_align": "top",
                "elements": [
                    {"tag": "div",
                     "text": {"tag": "lark_md", "content": text}},
                ],
            })
        return {
            "tag": "column_set",
            "flex_mode": "none",
            # Header row gets a grey band; body rows stay default to make
            # the header visually distinct.
            "background_style": "grey" if is_header else "default",
            "horizontal_spacing": "default",
            "columns": columns,
        }

    elements: list[dict] = [make_row(rows[0], is_header=True)]
    for body_row in rows[1:]:
        elements.append({"tag": "hr"})
        elements.append(make_row(body_row, is_header=False))
    return elements


# ---------------------------------------------------------------------------
# Card builders for the report delivery
# ---------------------------------------------------------------------------
_STATUS_TEMPLATE = {
    "COMPLETED": "green", "FAILED": "red",
    "TIMED_OUT": "orange", "CANCELLED": "grey",
}
_STATUS_EMOJI = {"COMPLETED": "✅", "FAILED": "❌", "TIMED_OUT": "⏰", "CANCELLED": "🚫"}


def _header_card(status: str, priority: str, detail_type: str, task_id: str,
                 report_url: str, trace_url: str, incident_id: str = "",
                 linked_case_display_id: str = "",
                 next_steps: list[dict] | None = None,
                 locale: str = "zh") -> dict:
    emoji = _STATUS_EMOJI.get(status, "ℹ️")
    template = _STATUS_TEMPLATE.get(status, "blue")
    # Use ** instead of * because Feishu lark_md uses double-star for
    # bold (Slack uses single-star). The i18n templates are written
    # with single-star — patch them up here for Feishu.
    def _bold(s: str) -> str:
        # Slack-style "*x*" → Feishu-style "**x**". Idempotent if
        # already double-star.
        import re as _re
        return _re.sub(r"(?<!\*)\*([^*\n]+?)\*(?!\*)", r"**\1**", s)
    body_lines = [
        _bold(i18n.t("report.header.event", locale, detail_type=detail_type)),
        _bold(i18n.t("report.header.status_priority", locale,
                     status=status, priority=priority)),
        _bold(i18n.t("report.header.task", locale, task_id=task_id)),
    ]
    if linked_case_display_id:
        body_lines.append(_bold(
            i18n.t("report.header.linked_case", locale,
                   case_display_id=linked_case_display_id)))
    elements: list = [
        {"tag": "div", "text": {"tag": "lark_md", "content": "\n".join(body_lines)}},
        {"tag": "hr"},
        {"tag": "action",
         "actions": [
             {"tag": "button",
              "text": {"tag": "plain_text",
                       "content": i18n.t("report.see_full", locale)},
              "type": "primary",
              "url": report_url,
              "multi_url": {"url": report_url, "android_url": report_url,
                            "ios_url": report_url, "pc_url": report_url}},
             {"tag": "button",
              "text": {"tag": "plain_text",
                       "content": i18n.t("report.see_trace", locale)},
              "type": "default",
              "url": trace_url,
              "multi_url": {"url": trace_url, "android_url": trace_url,
                            "ios_url": trace_url, "pc_url": trace_url}},
         ]},
        {"tag": "note",
         "elements": [{"tag": "plain_text",
                       "content": i18n.t("report.link_validity", locale)}]},
    ]

    # Bedrock-derived "next step" buttons. Each is one of:
    #   - {type: "dispatch", label, query}  → dispatched as a fresh
    #       investigation by the platform bot (handled in main.on_card_action)
    #   - {type: "open_url", label, url}    → opens AWS Console deep link
    if next_steps:
        elements.append({"tag": "hr"})
        # i18n.t returns "*🤖 ...*" (single-star); _bold() converts to "**".
        elements.append({"tag": "div",
                         "text": {"tag": "lark_md",
                                  "content": _bold(i18n.t(
                                      "report.next_steps_header", locale))}})
        ns_buttons = []
        for ns in next_steps[:3]:
            ns_type = ns.get("type")
            label = ns.get("label", "")
            if ns_type == "dispatch":
                query = ns.get("query", "")
                if not label or not query:
                    continue
                ns_buttons.append({
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": label},
                    "type": "default",
                    "value": {"action": "next_step_dispatch",
                              "incident_id": incident_id,
                              "query": query},
                })
            elif ns_type == "open_url":
                url = ns.get("url", "")
                if not label or not url:
                    continue
                ns_buttons.append({
                    "tag": "button",
                    "text": {"tag": "plain_text", "content": label},
                    "type": "default",
                    "url": url,
                    "multi_url": {"url": url, "android_url": url,
                                  "ios_url": url, "pc_url": url},
                })
        if ns_buttons:
            elements.append({"tag": "action", "actions": ns_buttons})
    # Sync-to-case button: only when this investigation was kicked off by a
    # "create case + dispatch" flow. Lets the user push the agent's findings
    # to AWS Support engineers as a comment on that case for context.
    if linked_case_display_id and incident_id:
        elements.append({"tag": "hr"})
        elements.append({
            "tag": "action",
            "actions": [
                {"tag": "button",
                 "text": {"tag": "plain_text",
                          "content": i18n.t("report.sync_to_case", locale,
                                            case_display_id=linked_case_display_id)},
                 "type": "primary",
                 "value": {"action": "case_sync_report",
                           "incident_id": incident_id,
                           "case_display_id": linked_case_display_id}},
            ],
        })
    if incident_id:
        # Generic "ask for human support" button — covers the path where the
        # user *didn't* dispatch a linked case at create time and now wants
        # to escalate. We hide it when a linked case already exists, since
        # creating a second case from the same investigation is rarely what
        # the user wants.
        if not linked_case_display_id:
            elements.append({"tag": "hr"})
            elements.append({
                "tag": "action",
                "actions": [
                    {"tag": "button",
                     "text": {"tag": "plain_text",
                              "content": i18n.t("report.escalate_support", locale)},
                     "type": "danger",
                     "value": {"action": "ask_support", "incident_id": incident_id}},
                ],
            })
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text",
                      "content": i18n.t("report.header.title", locale, emoji=emoji)},
            "template": template,
        },
        "elements": elements,
    }


# ---------------------------------------------------------------------------
# v2 table component — proper rendering for pipe tables
#
# v2 markdown CAN render GFM tables, but Feishu enforces a global cap of
# ~4 tables across the entire markdown body (ErrCode 11310). Our reports
# routinely contain 8-10 tables, so we extract pipe tables out of the
# markdown stream and render each one as a v2 `table` component (separate
# card element with column widths, alignment, pagination) — that path has
# its own cap of 5 `table` components per card, and we split into multiple
# cards if a report exceeds that. Non-table prose stays in v2 markdown.
# ---------------------------------------------------------------------------
_MAX_V2_TABLES_PER_CARD = 5


def _parse_pipe_table_to_v2(table_lines: list[str]) -> dict | None:
    """Convert a GFM pipe table to a v2 `{tag: 'table'}` component."""
    rows: list[list[str]] = []
    for raw in table_lines:
        if _TABLE_SEP_RE.match(raw) and "-" in raw:
            continue
        cells = raw.strip().strip("|").split("|")
        cells = [c.strip() for c in cells]
        if cells:
            rows.append(cells)
    if not rows:
        return None
    header = rows[0]
    body = rows[1:]
    n_cols = max(len(header), max((len(r) for r in body), default=0))
    while len(header) < n_cols:
        header.append("")
    columns: list[dict] = []
    for idx, name in enumerate(header):
        columns.append({
            "name": f"c{idx}",
            "display_name": name or " ",
            "data_type": "lark_md",
            "horizontal_align": "left",
            "vertical_align": "top",
        })
    rows_payload: list[dict] = []
    for r in body:
        while len(r) < n_cols:
            r.append("")
        rows_payload.append({f"c{i}": r[i] or " " for i in range(n_cols)})
    # Sized to fit Feishu's per-table page_size cap (max 10) — large
    # enough that a typical TOP-8 / TOP-10 ranking shows in one page,
    # so users don't have to click "next page" to see the rest.
    page_size = min(10, max(5, len(rows_payload)))
    return {
        "tag": "table",
        "page_size": page_size,
        "row_height": "low",
        "header_style": {
            "text_align": "left",
            "text_size": "normal",
            "background_style": "grey",
            "text_color": "default",
            "bold": True,
            "lines": 1,
        },
        "columns": columns,
        "rows": rows_payload,
    }


def _md_to_v2_blocks(md: str) -> list[dict]:
    """Parse markdown into a flat sequence of v2 card elements:

    - pipe tables  →  {tag: "table"}        (true Feishu table component)
    - everything else (prose, headers, lists, code)  →  {tag: "markdown"}

    Adjacent non-table lines are collapsed into a single markdown
    element to minimise component count. Each pipe table becomes its
    own `table` component.
    """
    if not md:
        return []
    lines = md.splitlines()
    blocks: list[dict] = []
    md_buf: list[str] = []

    def flush_md():
        if not md_buf:
            return
        text = "\n".join(md_buf).rstrip()
        md_buf.clear()
        if text.strip():
            blocks.append({"tag": "markdown", "content": text})

    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if _TABLE_LINE_RE.match(line):
            j = i
            while j < n and _TABLE_LINE_RE.match(lines[j]):
                j += 1
            flush_md()
            tbl = _parse_pipe_table_to_v2(lines[i:j])
            if tbl is not None:
                blocks.append(tbl)
            i = j
            continue
        md_buf.append(line)
        i += 1
    flush_md()
    return blocks


def _split_blocks_into_cards(blocks: list[dict]) -> list[list[dict]]:
    """Split a flat block list into chunks each containing at most
    `_MAX_V2_TABLES_PER_CARD` `table` components — Feishu's per-card cap.
    Markdown blocks ride along with whichever chunk they sit between.
    """
    if not blocks:
        return []
    cards: list[list[dict]] = [[]]
    table_count = 0
    for b in blocks:
        if b.get("tag") == "table":
            if table_count >= _MAX_V2_TABLES_PER_CARD:
                cards.append([])
                table_count = 0
            table_count += 1
        cards[-1].append(b)
    return [c for c in cards if c]


def _summary_card_v2_from_blocks(blocks: list[dict],
                                  header_suffix: str = "") -> dict:
    """Wrap a list of v2 elements into a Report Summary card.

    `width_mode: fill` makes the card stretch to the chat container's
    full width on desktop / mobile — required so wide markdown tables
    don't get squeezed into a narrow column with truncated cells. v1's
    equivalent flag is `wide_screen_mode: true` (set in the v1 fallback).
    """
    title = "📝 Report Summary"
    if header_suffix:
        title = f"{title} · {header_suffix}"
    return {
        "schema": "2.0",
        "config": {
            "streaming_mode": False,
            "width_mode": "fill",
        },
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": "blue",
        },
        "body": {"elements": blocks or [{"tag": "markdown",
                                         "content": "(no summary)"}]},
    }


def _summary_card_v1_fallback(summary_md: str) -> dict:
    """Last-resort: v1 schema with column_set fake-tables. Used when v2
    send fails (network/schema issue) — keeps the bot responsive even
    if the v2 path breaks."""
    elements = _md_to_card_elements(summary_md or "(no summary)")
    if not elements:
        elements = [{"tag": "div",
                     "text": {"tag": "lark_md",
                              "content": summary_md or "(no summary)"}}]
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": "📝 Report Summary"},
            "template": "blue",
        },
        "elements": elements,
    }


def reply_text(parent_message_id: str, text: str) -> None:
    """Reply to a specific message with plain text (used for status updates)."""
    _post(f"/im/v1/messages/{parent_message_id}/reply", {
        "content": json.dumps({"text": text}, ensure_ascii=False),
        "msg_type": "text",
    })


def _build_live_card(*, incident_id: str, deep_link: str,
                     operator_home: str,
                     elapsed_seconds: int = 0,
                     intent_summary: str = "",
                     summary_md: str = "",
                     recent_tools: list[str] | None = None,
                     latest_thinking: str = "",
                     is_final: bool = False,
                     locale: str = "zh") -> dict:
    """Build the live investigation card. Used by both the initial post
    (called from send_live_console_link) and subsequent progress updates
    (called from update_live_card).

    Buttons are always preserved across updates so the user can keep
    clicking through to the operator app even mid-investigation.
    """
    if is_final:
        title = i18n.t("progress.completed", locale, seconds=elapsed_seconds)
    elif elapsed_seconds <= 0:
        title = i18n.t("progress.investigation_started_live", locale)
    else:
        # Rotating emoji creates a "still working" feeling without an
        # extra API call — the tick is already going to chat_update,
        # we just vary the glyph based on elapsed seconds.
        spinner = ["🔍", "🔧", "📊", "⏳"][(elapsed_seconds // 20) % 4]
        title = i18n.t("progress.investigating", locale,
                       seconds=elapsed_seconds)
        if title.startswith("🔍"):
            title = spinner + title[1:]

    elements: list = []
    # Lead with the user's actual question (when known) — incident_id is
    # opaque to humans and not useful as a primary header.
    if intent_summary:
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md",
                     "content": f"**{i18n.t('progress.target', locale)}**\n{intent_summary}"},
        })
    if is_final:
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md",
                     "content": i18n.t("progress.investigation_done_msg", locale)},
        })
    else:
        if not intent_summary:
            elements.append({
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": i18n.t("progress.investigation_running_msg", locale)},
            })
        if summary_md:
            elements.append({"tag": "hr"})
            elements.append({
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": f"**{i18n.t('progress.summary', locale)}**\n{summary_md}"},
            })
        if latest_thinking:
            elements.append({
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": f"**{i18n.t('progress.thinking', locale)}**\n{latest_thinking}"},
            })
        if recent_tools:
            tool_lines = "\n".join(f"• {t}" for t in recent_tools[:5])
            elements.append({
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": f"**{i18n.t('progress.recent_calls', locale)}**\n{tool_lines}"},
            })
        if not recent_tools and not latest_thinking:
            # First ~30s before tools have run yet — show a friendly
            # placeholder so the card doesn't feel empty.
            elements.append({"tag": "hr"})
            # Promote single-star → double-star bold for Feishu lark_md.
            import re as _re
            placeholder = _re.sub(r"(?<!\*)\*([^*\n]+?)\*(?!\*)",
                                  r"**\1**",
                                  i18n.t("progress.placeholder_analyzing", locale))
            elements.append({
                "tag": "div",
                "text": {"tag": "lark_md", "content": placeholder},
            })
    elements.append({
        "tag": "div",
        "text": {"tag": "lark_md",
                 "content": i18n.t("progress.incident_id", locale,
                                   incident_id=incident_id)},
    })
    elements.append({
        "tag": "action",
        "actions": [
            {"tag": "button",
             "text": {"tag": "plain_text",
                      "content": i18n.t("progress.btn.open_link", locale)},
             "type": "primary",
             "url": deep_link,
             "multi_url": {"url": deep_link, "android_url": deep_link,
                           "ios_url": deep_link, "pc_url": deep_link}},
            {"tag": "button",
             "text": {"tag": "plain_text",
                      "content": i18n.t("progress.btn.open_home", locale)},
             "type": "default",
             "url": operator_home,
             "multi_url": {"url": operator_home, "android_url": operator_home,
                           "ios_url": operator_home, "pc_url": operator_home}},
        ],
    })
    elements.append({
        "tag": "note",
        "elements": [
            {"tag": "plain_text",
             "content": i18n.t("progress.link_login_warning", locale)},
        ],
    })
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": "green" if is_final else "blue",
        },
        "elements": elements,
    }


def send_live_console_link(chat_id: str, root_message_id: str,
                           agent_space_id: str, execution_id: str,
                           incident_id: str, task_id: str = "",
                           intent_summary: str = "",
                           locale: str = "zh") -> dict:
    """Post the initial live investigation card. Returns a `message_ref`
    dict (`{"message_id": "om_..."}`) the progress poller persists in
    DDB for later updates. Returns `{}` on error / not configured.

    The AWS Console (console.aws.amazon.com/aidevops) does NOT have a route
    for individual investigations — its SPA router only defines /agent-spaces
    and /agent-spaces/{id}. Investigation deep links exist only in the
    per-AgentSpace Operator App, keyed on task_id (NOT execution_id):
    the Operator App routes `investigation/{task_id}` where the id is
    the backlog task_id.
    """
    if not is_configured():
        logger.warning("Feishu not configured — skipping send_live_console_link")
        return {}

    operator_root = f"https://{agent_space_id}.aidevops.global.app.aws"
    deep_link = (f"{operator_root}/investigation/{task_id}"
                 if task_id else f"{operator_root}/")
    operator_home = f"{operator_root}/"

    card = _build_live_card(
        incident_id=incident_id, deep_link=deep_link,
        operator_home=operator_home,
        intent_summary=intent_summary,
        locale=locale,
    )
    msg_id = _send_card_returning_id(chat_id, root_message_id, card)
    return {
        "message_id": msg_id,
        "deep_link": deep_link,
        "operator_home_url": operator_home,
    } if msg_id else {}


def update_live_card(message_ref: dict, ir, locale: str = "zh") -> None:
    """Patch an existing live-investigation card with the latest progress.

    `message_ref` is whatever send_live_console_link returned.
    `ir` is a core.progress_card.ProgressCardIR dataclass — passed in
    duck-typed so this module doesn't import core (Lambda layer concern).
    """
    if not is_configured():
        return
    msg_id = (message_ref or {}).get("message_id")
    if not msg_id:
        return
    card = _build_live_card(
        incident_id=getattr(ir, "incident_id", ""),
        deep_link=getattr(ir, "deep_link", "") or message_ref.get("deep_link", ""),
        operator_home=(getattr(ir, "operator_home_url", "")
                       or message_ref.get("operator_home_url", "")),
        elapsed_seconds=getattr(ir, "elapsed_seconds", 0),
        intent_summary=getattr(ir, "intent_summary", ""),
        summary_md=getattr(ir, "summary_md", ""),
        recent_tools=getattr(ir, "recent_tools", []) or [],
        latest_thinking=getattr(ir, "latest_thinking", ""),
        is_final=getattr(ir, "is_final", False),
        locale=locale,
    )
    token = _get_token()
    if not token:
        return
    body = json.dumps({"content": json.dumps(card, ensure_ascii=False)},
                      ensure_ascii=False).encode("utf-8")
    req = Request(f"{OPENAPI_BASE}/im/v1/messages/{msg_id}",
                  data=body, method="PATCH")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with safe_urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") != 0:
                logger.warning("Feishu update_live_card error: code=%s msg=%s", data.get("code"), data.get("msg"))
    except Exception as e:
        logger.warning("Feishu update_live_card error: %s", e)


def _send_card_returning_id(chat_id: str | None, root_message_id: str | None,
                            card: dict) -> str:
    """Like _send_card but returns the new message id ("om_xxx") so callers
    can patch the card later. Returns '' on failure."""
    if not chat_id:
        return ""
    content = json.dumps(card, ensure_ascii=False)
    body = json.dumps({"receive_id": chat_id, "msg_type": "interactive",
                       "content": content}, ensure_ascii=False).encode("utf-8")
    token = _get_token()
    if not token:
        return ""
    req = Request(
        f"{OPENAPI_BASE}/im/v1/messages?receive_id_type=chat_id",
        data=body, method="POST",
    )
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with safe_urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("code") != 0:
                logger.error("Feishu _send_card_returning_id error: code=%s msg=%s", data.get("code"), data.get("msg"))
                return ""
            return (data.get("data") or {}).get("message_id", "") or ""
    except Exception as e:
        logger.error("Feishu _send_card_returning_id error: %s", e)
        return ""


def send_push_headsup(chat_id: str, event: dict,
                      locale: str = "zh") -> None:
    """Send a one-card heads-up about an inbound AWS push event (CloudWatch
    Alarm / Health / Backup / GuardDuty / Cost / Trusted Advisor).

    `event` is a dict shape from core.push_event.PushEvent (rendered as a
    plain dict by the push_handler so this module doesn't need a hard
    dependency on core/).

    The follow-up investigation report card lands a few minutes later via
    the existing report-handler path; this card just tells the user what
    triggered it so they're not confused when the report arrives.
    """
    if not is_configured():
        logger.warning("Feishu not configured — skipping send_push_headsup")
        return
    title = event.get("title", "AWS push event")
    severity = event.get("severity", "warn")
    template = {"critical": "red", "warn": "orange", "info": "blue"}.get(severity, "blue")
    description = (event.get("description") or "").strip()
    console_url = event.get("console_url", "")
    elements: list = [
        {"tag": "div", "text": {"tag": "lark_md",
                                 "content": description or "(no detail)"}},
        {"tag": "note",
         "elements": [{"tag": "plain_text",
                       "content": i18n.t("push.headsup_dispatched", locale)}]},
    ]
    if console_url:
        elements.insert(1, {
            "tag": "action",
            "actions": [
                {"tag": "button",
                 "text": {"tag": "plain_text",
                          "content": i18n.t("push.btn.open_console", locale)},
                 "type": "default",
                 "url": console_url,
                 "multi_url": {"url": console_url, "android_url": console_url,
                               "ios_url": console_url, "pc_url": console_url}},
            ],
        })
    card = {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": template,
        },
        "elements": elements,
    }
    _send_card(chat_id, None, card)


def _canonical_sep_row(header: str) -> str:
    """Build the canonical `| --- | --- | ... |` separator row matching
    the column count of `header`."""
    n_cols = max(1, header.strip().strip("|").count("|") + 1)
    return "| " + " | ".join(["---"] * n_cols) + " |"


def _normalize_md_tables(md: str) -> str:
    """Make pipe-tables in `md` parseable by Feishu's text-message
    Markdown renderer:

      1. Inject a missing GFM separator row when the Agent emits header
         + body rows without `| --- | --- |`.
      2. Rewrite alignment-flavoured separators (`|:---:|`, `|:---|`,
         `|---:|`, or long-dash `|--------|`) to the plain `| --- |`
         form. Feishu's parser is conservative — it accepts plain `---`
         but bails on alignment colons or dash counts other than 3+
         consistently.
      3. Add a blank line before the table if the prior line is prose,
         so the parser sees a clean table-start boundary.

    Algorithm: scan for runs of consecutive pipe-table lines (`| ... |`).
    For each run, if the second line looks like a separator, replace it
    with a canonical one; otherwise inject a canonical one after the
    header. Then skip past the run.
    """
    if not md or "|" not in md:
        return md
    lines = md.splitlines()
    out: list[str] = []
    i = 0
    n = len(lines)
    while i < n:
        if _TABLE_LINE_RE.match(lines[i]):
            j = i
            while j < n and _TABLE_LINE_RE.match(lines[j]):
                j += 1
            block = lines[i:j]
            if len(block) >= 2:
                header = block[0]
                second_is_sep = (_TABLE_SEP_RE.match(block[1])
                                 and "-" in block[1])
                # Blank line before the table when prior content is prose.
                if out and out[-1].strip() and not _TABLE_LINE_RE.match(out[-1]):
                    out.append("")
                out.append(header)
                out.append(_canonical_sep_row(header))
                # If the original second line was already a separator,
                # we replaced it; otherwise it was a body row and we
                # keep it. Either way, append remaining rows verbatim.
                rest = block[2:] if second_is_sep else block[1:]
                out.extend(rest)
            else:
                # Single pipe line — not a table, leave it alone.
                out.extend(block)
            i = j
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def _send_summary_cards(chat_id: str, root_message_id: str,
                        summary_md: str, locale: str = "zh") -> None:
    """Send the report summary as one or more v2 interactive cards.

    Why v2 cards (and not `msg_type: text` or v2 single-`markdown`)?
      - For Feishu **application bots** (this project), `msg_type: text`
        does NOT render Markdown — pipe tables, bold, and headings show
        up as literal characters. We verified this empirically against
        production. The "text-message renders markdown" behaviour only
        applies to certain bot types (e.g. custom-webhook bots) and not
        to OpenAPI-driven app bots.
      - Conversely, a v2 `markdown` component also does not render pipe
        tables — pipes show up as literal `|` characters. To get a real
        table you MUST use the native `table` component.
      - So the only reliable rendering path is: parse markdown, promote
        pipe tables to native `table` components, and send everything
        as a v2 interactive card with `width_mode: fill` so the card
        stretches to the chat width.

    Pre-processing:
      - `_normalize_md_tables` rewrites alignment-flavoured separators
        (`|:---:|`, `|---:|`) and long-dash separators (`|-------|`)
        into the canonical `| --- |` form, AND injects a missing
        separator row when the Agent emits header + body rows without
        one. Both cases break Feishu's table-component parser.

    Strategy:
      1. Cap total length at 12K chars (full report stays available
         via the `查看完整报告` button on the header card).
      2. Parse markdown into v2 elements (text → `markdown`,
         pipe-tables → native `table`).
      3. Chunk into cards each holding ≤5 `table` components (Feishu's
         per-card cap). Multi-card output gets a `(idx/total)` suffix.
      4. On failure of the FIRST card, fall back to the v1 schema with
         the full markdown so the user still gets the report — better
         degraded than dropped.
    """
    if not summary_md:
        summary_md = "(no summary)"
    if len(summary_md) > 12000:
        summary_md = (summary_md[:12000] + "\n\n…"
                      + i18n.t("report.summary_truncated", locale))

    summary_md = _normalize_md_tables(summary_md)

    blocks = _md_to_v2_blocks(summary_md)
    cards = _split_blocks_into_cards(blocks)
    if not cards:
        cards = [[{"tag": "markdown", "content": summary_md}]]

    total = len(cards)
    first_ok = False
    for idx, card_blocks in enumerate(cards, start=1):
        suffix = f"{idx}/{total}" if total > 1 else ""
        ok = _try_send_card(
            chat_id, root_message_id,
            _summary_card_v2_from_blocks(card_blocks, header_suffix=suffix),
        )
        if idx == 1:
            first_ok = ok
        if not ok and idx == 1:
            logger.warning("v2 summary card rejected — falling back to v1 schema")
            _send_card(chat_id, root_message_id,
                       _summary_card_v1_fallback(summary_md))
            return
    if not first_ok:
        _send_card(chat_id, root_message_id,
                   _summary_card_v1_fallback(summary_md))


def send_report(chat_id: str, root_message_id: str, status: str, priority: str,
                detail_type: str, task_id: str, report_url: str, trace_url: str,
                summary_md: str, incident_id: str = "",
                linked_case_display_id: str = "",
                next_steps: list[dict] | None = None,
                locale: str = "zh") -> None:
    """Send investigation results back to Feishu as two interactive cards.

    `linked_case_display_id` is set when the investigation was triggered by
    a "create case + dispatch" flow (incident_id like "feishu-case-NNNN");
    causes the header card to render a "sync to case" button instead of
    the generic "ask for human support" one.

    `next_steps` is a list of Bedrock-suggested follow-up actions
    (dispatch / open_url) rendered as a button row on the header card.

    `locale` controls report card output language. P1 currently only
    threads `locale` through to next-step button labels (which were
    already locale-aware via their generation prompt) and the i18n keys
    we have. The Feishu summary-card markdown (rendered server-side
    from the agent's GFM output) and the Chinese header-card chrome
    are still always-Chinese — full i18n there is P2 work.
    """
    if not is_configured():
        logger.warning("Feishu not configured — skipping send_report")
        return

    # Send summary first, then the header card (with action buttons + 🆘
    # escalation) — putting the header last keeps it at the bottom of the
    # thread so users land on the actionable card without scrolling past
    # the long markdown body.
    _send_summary_cards(chat_id, root_message_id, summary_md, locale=locale)
    _send_card(chat_id, root_message_id,
               _header_card(status, priority, detail_type, task_id,
                            report_url, trace_url, incident_id=incident_id,
                            linked_case_display_id=linked_case_display_id,
                            next_steps=next_steps,
                            locale=locale))
