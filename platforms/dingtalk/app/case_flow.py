"""
Conversational AWS Support case flow for DingTalk.

Compensation for DingTalk's lack of native modal forms. The flow is
driven entirely by chat turns:

  T0  user: "open a case for the RDS outage"
      → bot routes here. We seed a session in ddb_state with the
        original raw_text + intent summary + a state machine cursor
        and reply "请发送一段描述 (subject + body)".
  T1  user: a single multi-line message — first line = subject,
        rest = body.
      → we call core.support_logic.create_case (which calls
        Support's CreateCase) and reply with the case ID + console
        URL. Session cleared.

  Cancel: user types "cancel" / "取消" / "/cancel" → session cleared.

Design notes:
  - Session keyed by (platform, chat_id, user_id, kind="case_create").
    Two users in the same group can each have their own in-flight
    case at once.
  - The other case_* intents (case_list / case_view / case_reply /
    case_resolve) are SINGLE-TURN: the LLM intent classifier already
    extracts the case_display_id, and reply bodies fit in one turn.
    They don't need session state.

This module is DingTalk-specific by design — feishu/slack have
their own modal-driven case flows that look nothing like this.
The only thing both share is calling into core/case_management +
core/support_logic; the platform-specific bit is the UX shape.
"""
from __future__ import annotations

import logging
from typing import Any

from core import case_analyze
from core import case_management
from core import ddb_state
from core import i18n
from core import support_logic

logger = logging.getLogger(__name__)

PLATFORM = "dingtalk"
SESSION_KIND = "case_create"

# State machine cursor values in the session dict.
ST_AWAITING_DETAILS = "awaiting_details"


_CANCEL_PHRASES = {"cancel", "取消", "/cancel", "停止", "stop"}


# ---------- Session helpers -----------------------------------------------

def _start_session(*, conversation_id: str, user_id: str,
                    raw_text: str, intent_summary: str = "") -> None:
    ddb_state.put_convo_session(
        platform=PLATFORM, chat_id=conversation_id, user_id=user_id,
        kind=SESSION_KIND,
        data={
            "state": ST_AWAITING_DETAILS,
            "raw_text": raw_text,
            "intent_summary": intent_summary,
        },
    )


def _get_session(*, conversation_id: str, user_id: str) -> dict | None:
    return ddb_state.get_convo_session(
        platform=PLATFORM, chat_id=conversation_id, user_id=user_id,
        kind=SESSION_KIND,
    )


def _clear_session(*, conversation_id: str, user_id: str) -> None:
    ddb_state.clear_convo_session(
        platform=PLATFORM, chat_id=conversation_id, user_id=user_id,
        kind=SESSION_KIND,
    )


# ---------- Public entry points -------------------------------------------

def start_create(*, handler: Any, msg: Any, conversation_id: str,
                  user_id: str, raw_text: str, intent_summary: str,
                  locale: str) -> None:
    """Begin the conversational case-create flow.

    Called when bedrock_intent classifies a message as `case_create`.
    Persists the original raw_text + intent_summary so the next turn
    has full context, then prompts the user for details.
    """
    _start_session(
        conversation_id=conversation_id, user_id=user_id,
        raw_text=raw_text, intent_summary=intent_summary,
    )
    handler.reply_markdown(
        i18n.t("dingtalk.case.create.prompt_title", locale),
        i18n.t("dingtalk.case.create.prompt_body", locale),
        msg,
    )


def maybe_continue(*, handler: Any, msg: Any, conversation_id: str,
                    user_id: str, raw_text: str, locale: str,
                    operator_name: str) -> bool:
    """If a case-create session is active for (chat, user), interpret
    `raw_text` as the next step in the flow. Return True iff the
    message was consumed by the flow and the caller should NOT
    continue with normal intent dispatch.

    Cancel keywords are recognized at every step.
    """
    sess = _get_session(conversation_id=conversation_id, user_id=user_id)
    if not sess:
        return False

    if (raw_text or "").strip().lower() in _CANCEL_PHRASES:
        _clear_session(conversation_id=conversation_id, user_id=user_id)
        handler.reply_text(i18n.t("dingtalk.case.create.cancelled", locale), msg)
        return True

    state = sess.get("state")
    if state != ST_AWAITING_DETAILS:
        # Unknown state → defensively drop the session and fall
        # through to normal intent routing so the user isn't stuck.
        logger.warning("dingtalk case_flow: unknown session state %r — clearing",
                        state)
        _clear_session(conversation_id=conversation_id, user_id=user_id)
        return False

    # User's reply is the case details. First line = subject, rest = body.
    lines = [ln for ln in (raw_text or "").splitlines() if ln.strip()]
    if not lines:
        handler.reply_text(
            i18n.t("dingtalk.case.create.empty_details", locale), msg)
        return True

    extra_body = "\n".join(lines[1:]).strip() if len(lines) > 1 else ""
    # The "subject" is the first line; we let support_logic.build_subject
    # build the final wire-form subject (which prepends the platform
    # label). What we surface to support_logic is the conversational
    # hint as both the intent_summary AND raw_text fall-back.
    user_subject = lines[0].strip()

    ctx = {
        "raw_text": sess.get("raw_text", ""),
        "intent_summary": sess.get("intent_summary", "") or user_subject,
        "summary_md": "",  # no investigation report attached for ad-hoc cases
    }

    # Best-effort severity / language defaults for ad-hoc creates.
    severity = support_logic.DEFAULT_SEVERITY
    language = "zh" if locale == "zh" else "en"

    try:
        result = support_logic.create_case(
            ctx,
            platform=PLATFORM,
            severity=severity,
            language=language,
            extra=extra_body,
            operator_name=operator_name or user_id,
        )
    except Exception as e:
        logger.exception("dingtalk case create failed: %s", e)
        _clear_session(conversation_id=conversation_id, user_id=user_id)
        handler.reply_text(
            i18n.t("dingtalk.case.create.failed", locale), msg)
        return True

    _clear_session(conversation_id=conversation_id, user_id=user_id)

    if not result.ok:
        handler.reply_markdown(
            i18n.t("dingtalk.case.create.error_title", locale),
            i18n.t("dingtalk.case.create.error_body", locale,
                   code=result.error_code or "unknown",
                   message=result.error_message or "(no detail)"),
            msg,
        )
        return True

    handler.reply_markdown(
        i18n.t("dingtalk.case.create.ok_title", locale,
               display_id=result.display_id),
        i18n.t("dingtalk.case.create.ok_body", locale,
               display_id=result.display_id,
               case_url=result.case_url,
               severity=severity,
               language=language),
        msg,
    )
    return True


# ---------- Single-turn intents (no session needed) -----------------------

def _format_case_summary_line(c: case_management.CaseSummary,
                               locale: str) -> str:
    """One markdown line per case for the list view."""
    sev = (c.severity or "?").lower()
    return (f"- **{c.display_id}** · {c.subject or '(no subject)'}"
            f" · `{c.status}` · sev={sev}"
            f" · last {c.created_at or 'unknown'}")


def handle_list(*, handler: Any, msg: Any, status_filter: str,
                 locale: str) -> None:
    cases = case_management.list_recent_cases(
        after_days=90, max_items=10,
        status_filter=status_filter or "recent",
    )
    if not cases:
        handler.reply_text(
            i18n.t("dingtalk.case.list.empty", locale,
                   filter=status_filter or "recent"),
            msg)
        return
    lines = [
        i18n.t("dingtalk.case.list.header", locale,
               n=len(cases), filter=status_filter or "recent")
    ]
    lines += [_format_case_summary_line(c, locale) for c in cases]
    handler.reply_markdown(
        i18n.t("dingtalk.case.list.title", locale),
        "\n".join(lines), msg)


def handle_view(*, handler: Any, msg: Any, display_id: str,
                 locale: str) -> None:
    if not display_id:
        handler.reply_text(
            i18n.t("dingtalk.case.view.missing_id", locale), msg)
        return
    case = case_management.describe_case(display_id)
    if not case:
        handler.reply_text(
            i18n.t("dingtalk.case.view.not_found", locale,
                   display_id=display_id),
            msg)
        return
    coms = case_management.list_communications(display_id, max_items=5)
    body_parts = [
        f"**{i18n.t('dingtalk.case.view.subject', locale)}:** "
        f"{case.subject or '(no subject)'}",
        f"**Status:** `{case.status}` · sev={case.severity or '?'}",
        f"**Submitted:** {case.created_at or 'unknown'}",
    ]
    if coms:
        body_parts.append("\n**Recent replies (newest first):**")
        for c in coms:
            who = c.submitted_by or "unknown"
            ts = c.submitted_at or ""
            preview = (c.body or "").strip().splitlines()[0][:200]
            body_parts.append(f"- _{who}_ at {ts}: {preview}")
    handler.reply_markdown(
        i18n.t("dingtalk.case.view.title", locale, display_id=display_id),
        "\n".join(body_parts),
        msg,
    )


def handle_reply(*, handler: Any, msg: Any, display_id: str,
                  body: str, locale: str) -> None:
    if not display_id:
        handler.reply_text(
            i18n.t("dingtalk.case.reply.missing_id", locale), msg)
        return
    if not (body or "").strip():
        handler.reply_text(
            i18n.t("dingtalk.case.reply.missing_body", locale), msg)
        return
    ok = case_management.add_communication(display_id, body)
    handler.reply_text(
        i18n.t("dingtalk.case.reply.ok" if ok
               else "dingtalk.case.reply.failed",
               locale, display_id=display_id),
        msg,
    )


def handle_resolve(*, handler: Any, msg: Any, display_id: str,
                    locale: str) -> None:
    if not display_id:
        handler.reply_text(
            i18n.t("dingtalk.case.resolve.missing_id", locale), msg)
        return
    final_status = case_management.resolve_case(display_id)
    ok = bool(final_status)
    handler.reply_text(
        i18n.t("dingtalk.case.resolve.ok" if ok
               else "dingtalk.case.resolve.failed",
               locale, display_id=display_id, status=final_status or ""),
        msg,
    )


def handle_analyze(*, handler: Any, msg: Any, display_id: str,
                    locale: str) -> None:
    """LLM-driven case analysis. DingTalk Phase 2a only supports
    markdown messages (no ActionCard until Phase 2c registers a
    cardTemplateId), so we render the analysis as a single markdown
    reply with sections + a quoted suggested-reply block."""
    if not display_id:
        handler.reply_text(
            i18n.t("dingtalk.case.view.missing_id", locale), msg)
        return

    # Lightweight "starting" toast so the chat doesn't appear
    # unresponsive during the 5-15s analyze (describe_case +
    # list_communications + Bedrock).
    try:
        handler.reply_text(
            i18n.t("case.analyze.toast.starting", locale,
                   display_id=display_id),
            msg,
        )
    except Exception as e:
        logger.warning("dingtalk case_analyze: starting reply failed "
                       "(non-fatal): %s", e)

    result = case_analyze.analyze(display_id, locale=locale)

    if result.error == "case_not_found":
        handler.reply_text(
            i18n.t("case.analyze.error.case_not_found", locale,
                   display_id=display_id),
            msg,
        )
        return
    if result.error:
        handler.reply_text(
            i18n.t("case.analyze.error.llm_failed", locale,
                   detail=result.error),
            msg,
        )
        return

    # Render a single markdown body with the same section structure as
    # feishu / slack.
    c = result.case_summary
    parts: list[str] = []
    parts.append(i18n.t(
        "case.analyze.subject_meta", locale,
        subject=c.subject or "(no subject)",
        severity=c.severity or "—",
        service=c.service_code or "—",
        status=c.status or "—",
        comm_count=result.comm_count,
    ))
    parts.append("")

    def _section(header_key: str, body_text: str) -> None:
        if not body_text:
            return
        parts.append(f"**{i18n.t(header_key, locale)}**")
        parts.append(body_text)
        parts.append("")

    def _bullet_section(header_key: str, items: list[str]) -> None:
        if not items:
            return
        parts.append(f"**{i18n.t(header_key, locale)}**")
        for it in items:
            parts.append(f"- {it}")
        parts.append("")

    _section("case.analyze.section.summary", result.summary)
    _section("case.analyze.section.root_cause", result.root_cause)
    _section("case.analyze.section.aws_progress", result.aws_progress)
    _bullet_section("case.analyze.section.next_steps", result.next_steps)
    _bullet_section("case.analyze.section.info_to_provide",
                     result.info_to_provide)
    if result.suggested_reply:
        parts.append(f"**{i18n.t('case.analyze.section.suggested_reply', locale)}**")
        # Quote-prefix every line so DingTalk markdown renders it as a
        # blockquote, visually distinct from the analysis sections.
        for ln in result.suggested_reply.split("\n"):
            parts.append(f"> {ln}")
        parts.append("")

    parts.append(f"[{i18n.t('case.analyze.btn.view_full', locale)}]"
                 f"({c.case_url})")

    handler.reply_markdown(
        i18n.t("case.analyze.title", locale, display_id=display_id),
        "\n".join(parts),
        msg,
    )
