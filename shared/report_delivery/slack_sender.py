"""
Slack sender for the report-handler Lambda.

Same interface contract as feishu_sender:
  - send_report(...)             → final investigation report (with summary)
  - send_live_console_link(...)  → "Investigation In Progress" deep link
  - send_push_headsup(...)       → AWS push event heads-up card

Implementation uses the Slack Web API (chat.postMessage) directly via
urllib so we don't need to bundle slack_sdk inside the Lambda zip.
The Bot Token is read from Secrets Manager on cold start and cached.

Environment:
  SLACK_BOT_TOKEN_ARN  Secrets Manager ARN containing the xoxb-... token

When the env var is unset the sender is "not configured" and silently
no-ops — matches feishu_sender's pattern so a customer who only deploys
Slack OR only feishu doesn't get spurious errors.
"""
from __future__ import annotations
from shared.net import safe_urlopen

import json
import logging
import os
import threading
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import boto3

from core import i18n

logger = logging.getLogger(__name__)


def _safe_err(e: Exception) -> str:
    """Sensitive-data handling: return the exception *type* (plus the AWS
    error code for botocore ClientError), never the raw message which can embed
    request payloads or user data. See docs/LOGGING_STANDARD.md."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


SLACK_API_BASE = "https://slack.com/api"

_sm = boto3.client("secretsmanager")
_bot_token: str | None = None
_lock = threading.Lock()


def is_configured() -> bool:
    return bool(os.environ.get("SLACK_BOT_TOKEN_ARN"))


def _get_token() -> str | None:
    global _bot_token
    with _lock:
        if _bot_token:
            return _bot_token
        arn = os.environ.get("SLACK_BOT_TOKEN_ARN", "")
        if not arn:
            return None
        try:
            _bot_token = _sm.get_secret_value(SecretId=arn)["SecretString"].strip()
            return _bot_token
        except Exception as e:
            logger.error("Slack token fetch failed: %s", _safe_err(e))
            return None


def _post(path: str, payload: dict) -> dict:
    token = _get_token()
    if not token:
        return {}
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = Request(f"{SLACK_API_BASE}{path}", data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        with safe_urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if not data.get("ok"):
                # Security: 只记 Slack 的 error 码，不打整个响应体（可能含回显的 payload）。
                logger.error("Slack API %s error: %s", path, data.get("error"))
            return data
    except (HTTPError, URLError) as e:
        logger.error("Slack API %s HTTP error: %s", path, _safe_err(e))
        return {}


# ---------------------------------------------------------------------------
# Block helpers (mirror platforms/slack/app/blocks.py — kept inline so the
# Lambda doesn't need to import the platform-side adapter package)
# ---------------------------------------------------------------------------
def _section(md: str) -> dict:
    return {"type": "section",
            "text": {"type": "mrkdwn", "text": md}}


def _context(md: str) -> dict:
    return {"type": "context",
            "elements": [{"type": "mrkdwn", "text": md}]}


def _header(text: str) -> dict:
    return {"type": "header",
            "text": {"type": "plain_text", "text": text[:150], "emoji": True}}


def _divider() -> dict:
    return {"type": "divider"}


def _button(text: str, action_id: str, *, value=None, style=None,
            url=None) -> dict:
    elem: dict = {"type": "button",
                  "text": {"type": "plain_text", "text": text[:75], "emoji": True},
                  "action_id": action_id}
    if url:
        elem["url"] = url[:3000]
    else:
        if value is not None:
            elem["value"] = json.dumps(value, ensure_ascii=False)[:2000] \
                if not isinstance(value, str) else value[:2000]
        if style in ("primary", "danger"):
            elem["style"] = style
    return elem


def _actions(*buttons: dict) -> dict:
    return {"type": "actions", "elements": list(buttons)[:25]}


def _escape(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------------------
# Public API: live console link (Investigation In Progress)
# ---------------------------------------------------------------------------
def _build_live_blocks(*, incident_id: str, deep_link: str,
                       operator_home: str,
                       elapsed_seconds: int = 0,
                       intent_summary: str = "",
                       summary_md: str = "",
                       recent_tools: list[str] | None = None,
                       latest_thinking: str = "",
                       is_final: bool = False,
                       locale: str = "en") -> list[dict]:
    """Build the live investigation card blocks. Buttons are always
    preserved across updates."""
    if is_final:
        title = i18n.t("progress.completed", locale, seconds=elapsed_seconds)
    elif elapsed_seconds <= 0:
        # Pre-tick state ("just dispatched") — short generic header.
        title = i18n.t("progress.investigation_started_live", locale)
    else:
        spinner = ["🔍", "🔧", "📊", "⏳"][(elapsed_seconds // 20) % 4]
        title = i18n.t("progress.investigating", locale,
                       seconds=elapsed_seconds)
        # Restore the spinner glyph at the front of the templated title.
        # Templates start with a fixed 🔍 — swap with the rotating glyph.
        if title.startswith("🔍"):
            title = spinner + title[1:]
    out: list[dict] = [_header(title)]
    # Lead with the user's actual question — incident_id is opaque.
    if intent_summary:
        out.append(_section(
            f"*{i18n.t('progress.target', locale)}*\n{intent_summary}"))
    if is_final:
        out.append(_section(i18n.t("progress.investigation_done_msg", locale)))
    else:
        if not intent_summary:
            out.append(_section(
                i18n.t("progress.investigation_running_msg", locale)))
        if summary_md:
            out.append(_divider())
            out.append(_section(
                f"*{i18n.t('progress.summary', locale)}*\n{summary_md}"))
        if latest_thinking:
            out.append(_section(
                f"*{i18n.t('progress.thinking', locale)}*\n{latest_thinking}"))
        if recent_tools:
            tool_lines = "\n".join(f"• {t}" for t in recent_tools[:5])
            out.append(_section(
                f"*{i18n.t('progress.recent_calls', locale)}*\n{tool_lines}"))
        if not recent_tools and not latest_thinking:
            out.append(_divider())
            out.append(_section(
                i18n.t("progress.placeholder_analyzing", locale)))
    out.append(_context(
        i18n.t("progress.incident_id", locale, incident_id=incident_id)))
    out.append(_actions(
        _button(i18n.t("progress.btn.open_link", locale), "open_live_link",
                url=deep_link, style="primary"),
        _button(i18n.t("progress.btn.open_home", locale), "open_live_home",
                url=operator_home),
    ))
    out.append(_context(i18n.t("progress.link_login_warning", locale)))
    return out


def send_live_console_link(chat_id: str, root_message_id: str,
                           agent_space_id: str, execution_id: str,
                           incident_id: str, task_id: str = "",
                           intent_summary: str = "",
                           locale: str = "en") -> dict:
    """Post initial live-investigation card. Returns a `message_ref`
    dict (`{"channel", "ts", "deep_link", "operator_home_url"}`) for
    later progress updates."""
    if not is_configured():
        logger.warning("Slack not configured — skipping send_live_console_link")
        return {}
    operator_root = f"https://{agent_space_id}.aidevops.global.app.aws"
    deep_link = (f"{operator_root}/investigation/{task_id}"
                 if task_id else f"{operator_root}/")
    operator_home = f"{operator_root}/"
    blocks_out = _build_live_blocks(
        incident_id=incident_id, deep_link=deep_link,
        operator_home=operator_home,
        intent_summary=intent_summary,
        locale=locale,
    )
    resp = _post("/chat.postMessage", {
        "channel": chat_id,
        "thread_ts": root_message_id or None,
        "text": i18n.t("progress.investigation_started_short", locale,
                       incident_id=incident_id),
        "blocks": blocks_out,
    })
    if not resp.get("ok"):
        return {}
    return {
        "channel": resp.get("channel") or chat_id,
        "ts": resp.get("ts", ""),
        "deep_link": deep_link,
        "operator_home_url": operator_home,
    }


def update_live_card(message_ref: dict, ir, locale: str = "en") -> None:
    """Patch an existing live-investigation card with progress info."""
    if not is_configured():
        return
    channel = (message_ref or {}).get("channel")
    ts = (message_ref or {}).get("ts")
    if not channel or not ts:
        return
    blocks_out = _build_live_blocks(
        incident_id=getattr(ir, "incident_id", ""),
        deep_link=getattr(ir, "deep_link", "")
            or message_ref.get("deep_link", ""),
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
    title = (i18n.t("progress.completed", locale,
                    seconds=getattr(ir, "elapsed_seconds", 0))
             if getattr(ir, "is_final", False)
             else i18n.t("progress.investigating", locale,
                         seconds=getattr(ir, "elapsed_seconds", 0)))
    _post("/chat.update", {
        "channel": channel,
        "ts": ts,
        "text": title,
        "blocks": blocks_out,
    })


# ---------------------------------------------------------------------------
# Public API: final investigation report
# ---------------------------------------------------------------------------
_STATUS_EMOJI = {"COMPLETED": "✅", "FAILED": "❌",
                 "TIMED_OUT": "⏰", "CANCELLED": "🚫"}


#: Slack rejects a message with more than 50 blocks (`invalid_blocks`) —
#: and it rejects the WHOLE message, so overflowing means "that channel got
#: nothing", with no partial output to hint at why. 48 leaves headroom.
_MAX_BLOCKS = 48


def _summary_blocks(summary_md: str, locale: str, *,
                    header_text: str = "",
                    with_header: bool = True,
                    max_blocks: int = _MAX_BLOCKS) -> list[dict]:
    """GFM markdown → Slack blocks, with both hard caps applied.

    Extracted from `send_report` so the inspection broadcast layer
    (`send_markdown`) renders through the exact same path — two copies of
    the 8000-char / block caps would drift, and the drift only shows up
    on a long report as `invalid_blocks`.

    `with_header=False` drops the leading `header` block (`to_blocks`
    always emits one): the merged report message carries its own
    「NotiOps 报告」 header, and two stacked headers read as two reports —
    which is exactly the confusion D5 asked us to remove.
    """
    header = header_text or i18n.t("report.summary_header", locale)
    text = (summary_md or "").strip() or i18n.t("report.no_body", locale)
    if len(text) > 8000:
        text = text[:8000] + "\n\n" + i18n.t("report.summary_truncated", locale)
    try:
        from shared.report_delivery.slack_mrkdwn import to_blocks as _to_blocks
        blocks = _to_blocks(text, header_text=header)
    except Exception as e:
        logger.warning("slack_mrkdwn rendering failed; falling back to plain: %s",
                       _safe_err(e))
        blocks = [_header(header), _section(text)]
    if not with_header:
        blocks = blocks[1:]
    if len(blocks) > max_blocks:
        blocks = blocks[:max_blocks - 1] + [
            _section("_" + i18n.t("report.summary_truncated", locale) + "_")]
    return blocks


def send_report(chat_id: str, root_message_id: str, status: str, priority: str,
                detail_type: str, task_id: str, report_url: str, trace_url: str,
                summary_md: str, incident_id: str = "",
                linked_case_display_id: str = "",
                next_steps: list[dict] | None = None,
                locale: str = "en", title: str = "",
                report_truncated: bool = False) -> None:
    """Post the investigation result as **one** Slack message.

    Until 2026-09-05 this posted two messages — body, then a separate
    "header card" with the buttons. Merged on user request (D5); see
    `feishu_sender.send_report` for the same change on Feishu.

    `title` (D1) is the user's own question. `report_truncated` says the
    body is a cut-down slice, so the notice is rendered here (per-locale)
    rather than spliced into the body.

    ⚠️ **没有 `console_url` 参数**(控制台深链不上报告卡)——理由见下面
    `action_row` 处的注释。别看见调用方手里有这个值就补回参数。
    """
    if not is_configured():
        logger.warning("Slack not configured — skipping send_report")
        return
    emoji = _STATUS_EMOJI.get(status, "ℹ️")

    meta_lines = []
    if title:
        # Display cap: the storage cap is 200 (report_handler
        # `_TITLE_MAX_CHARS`); a wrapped 200-char first line pushes the
        # buttons off-screen on mobile.
        shown = title if len(title) <= 140 else title[:139] + "…"
        meta_lines.append(i18n.t("report.header.subject", locale,
                                 title=_escape(shown)))
    meta_lines += [
        i18n.t("report.header.event", locale, detail_type=detail_type),
        i18n.t("report.header.status_priority", locale,
               status=status, priority=priority),
        i18n.t("report.header.task", locale, task_id=task_id),
    ]
    if linked_case_display_id:
        meta_lines.append(
            i18n.t("report.header.linked_case", locale,
                   case_display_id=linked_case_display_id))

    head: list = [
        _header(i18n.t("report.header.title", locale, emoji=emoji)),
        _section("\n".join(meta_lines)),
        _divider(),
    ]

    tail: list = [
        _divider(),
        _actions(
            _button(i18n.t("report.see_full", locale), "open_report",
                    url=report_url, style="primary"),
            _button(i18n.t("report.see_trace", locale), "open_trace",
                    url=trace_url),
        ),
    ]

    # Next-step buttons. Nothing generates these any more (the report path
    # is 0-token since 2026-09-05) but cards already in users' history do,
    # so the rendering + `main.py`'s block_actions handlers stay.
    # Each action_id MUST be unique within the message — Slack rejects the
    # whole message with `invalid_blocks` on a duplicate — hence the index
    # suffix, which `main.py` matches with a regex.
    if next_steps:
        ns_buttons = []
        for idx, ns in enumerate(next_steps[:3]):
            ns_type = ns.get("type")
            label = ns.get("label", "")
            if ns_type == "dispatch":
                query = ns.get("query", "")
                if not label or not query:
                    continue
                ns_buttons.append(_button(
                    label, f"next_step_dispatch_{idx}",
                    value={"incident_id": incident_id, "query": query},
                ))
            elif ns_type == "open_url":
                url = ns.get("url", "")
                if not label or not url:
                    continue
                ns_buttons.append(_button(
                    label, f"open_next_step_url_{idx}", url=url))
        if ns_buttons:
            tail.append(_divider())
            tail.append(_section(i18n.t("report.next_steps_header", locale)))
            tail.append(_actions(*ns_buttons))

    # Exactly one escalation button. ⚠️ 报告卡上**没有**「🔬 查看本次调查」
    # (控制台深链):这张卡上其余链接都是预签名、7 天免登录,而深链要求登录
    # AWS 控制台 —— 两者并排会逼着底下的说明同时写「无需登录」和「需要
    # 登录」。2026-09-05 加过当天去掉。进度卡上那颗保留(见 `progress_sender`)。
    action_row: list = []
    if linked_case_display_id and incident_id:
        action_row.append(
            _button(i18n.t("report.sync_to_case", locale,
                           case_display_id=linked_case_display_id),
                    "case_sync_report",
                    value={"incident_id": incident_id,
                           "case_display_id": linked_case_display_id},
                    style="primary"))
    elif incident_id:
        action_row.append(
            _button(i18n.t("report.escalate_support", locale), "ask_support",
                    value={"incident_id": incident_id}, style="danger"))
    if action_row:
        tail.append(_divider())
        tail.append(_actions(*action_row))

    # One line, unconditionally true: every link left on this card is a
    # presigned S3 / CDN URL. ⚠️ 别再加 `progress.link_login_warning` ——
    # 它是给控制台深链的,而那颗按钮已不在这张卡上。
    tail.append(_context(i18n.t("report.link_validity", locale)))

    # Body budget = whatever the block cap leaves after the chrome, minus
    # one slot for the truncation notice.
    budget = max(1, _MAX_BLOCKS - len(head) - len(tail) - 1)
    body = _summary_blocks(summary_md, locale, with_header=False,
                           max_blocks=budget)
    # `_summary_blocks` may already have appended the notice (8000-char cut or
    # block-cap cut). Rendering it twice reads as two separate warnings, so
    # only add ours when it isn't there yet.
    notice_text = i18n.t("report.summary_truncated", locale)
    already = any(notice_text in ((b.get("text") or {}).get("text") or "")
                  for b in body if b.get("type") == "section")
    notice = [] if (already or not report_truncated) else [_section(notice_text)]

    _post("/chat.postMessage", {
        "channel": chat_id,
        "thread_ts": root_message_id or None,
        "text": i18n.t("report.header.title", locale, emoji=emoji),
        "blocks": head + body + notice + tail,
    })


def send_markdown(chat_id: str, markdown: str, *, locale: str = "en") -> bool:
    """Post a standalone markdown body into a channel. True on success.

    Added for the inspection broadcast layer . `send_report` is
    not reusable there: it posts a second "header card" with status /
    priority / task_id / report buttons that a cron digest has no values
    for, and it returns None so a fan-out can't tell which channels failed.

    `thread_ts` is omitted on purpose — a cron broadcast has no thread root.
    """
    if not is_configured():
        logger.warning("Slack not configured — skipping send_markdown")
        return False
    header = i18n.t("report.summary_header", locale)
    data = _post("/chat.postMessage", {
        "channel": chat_id,
        "text": header,
        "blocks": _summary_blocks(markdown, locale, header_text=header),
    })
    return bool(data.get("ok"))


# ---------------------------------------------------------------------------
# Public API: AWS push event heads-up
# ---------------------------------------------------------------------------
def send_push_headsup(chat_id: str, event: dict,
                       locale: str = "en") -> str:
    if not is_configured():
        logger.warning("Slack not configured — skipping send_push_headsup")
        return ""
    title = event.get("title", "AWS push event")
    description = (event.get("description") or "").strip() or "(no detail)"
    console_url = event.get("console_url", "")

    blocks_out: list = [
        _header(title),
        _section(_escape(description)),
    ]
    if console_url:
        blocks_out.append(_actions(
            _button(i18n.t("push.btn.open_console", locale),
                    "open_push_console", url=console_url),
        ))
    blocks_out.append(_context(i18n.t("push.headsup_dispatched", locale)))

    resp = _post("/chat.postMessage", {
        "channel": chat_id,
        "text": title,
        "blocks": blocks_out,
    })
    # Return the message ts so the caller can thread the investigation
    # report under this heads-up (one event = one thread).
    return (resp or {}).get("ts", "")
