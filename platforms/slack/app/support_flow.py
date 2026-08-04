"""
Slack UI for the "ask for human support" escalation flow.

Mirrors platforms/feishu/app/support_flow.py — same business logic
(`core.support_logic`), different UI surface:

  ask_support button click       → open a modal (form view)
  modal submit (confirm_support) → call create_case in a worker thread
                                    + ack with a 'creating…' modal,
                                    then post a result message to the
                                    originating channel/thread when done

We use views.update for the in-modal "creating…" state, and
chat_postMessage for the final result so the channel sees it (modals
close automatically after submit).

Bilingual (zh + en) end-to-end via core.i18n.t(). Locale is read from
the per-action JSON value (preferred — mirrors what we rendered the
report card with), falls back to the linked DDB row keyed by
incident_id, and finally to "en" (Slack default). Modal submit handlers
read locale back from `view.private_metadata` since they don't see the
original action payload.
"""
from __future__ import annotations

import json as _json
import logging
import threading

from core import ddb_state
from core import i18n
from core import support_logic
from core.support_logic import (
    DEFAULT_LANGUAGE, DEFAULT_SEVERITY,
    LANGUAGE_CODES, LANGUAGE_LABELS,
    SEVERITY_CODES,
    severity_label, severity_labels,
)

from platforms.slack.app import blocks

logger = logging.getLogger(__name__)
PLATFORM = "slack"


# ---------------------------------------------------------------------------
# Locale helpers
# ---------------------------------------------------------------------------
def _normalize_locale(locale: str | None) -> str:
    """Bound `locale` to the supported set. Slack defaults to en (the
    workspace this bot ships into is English by default; feishu defaults
    to zh)."""
    loc = (locale or "en").strip().lower()
    return loc if loc in {"zh", "en"} else "en"


def _locale_from_action(action_value: str) -> str:
    """Pull `locale` out of the action's JSON value, falling back to en."""
    try:
        v = _json.loads(action_value or "{}")
    except Exception:
        return "en"
    return _normalize_locale(v.get("locale"))


def _locale_from_incident(incident_id: str, fallback: str = "en") -> str:
    """Best-effort locale lookup from a DDB conversations row keyed by
    incident_id. Used when the action JSON doesn't carry a locale (older
    cards without locale plumbing)."""
    if incident_id:
        try:
            row = ddb_state.get_by_incident(incident_id)
            if row and row.get("locale"):
                return _normalize_locale(row.get("locale"))
        except Exception as e:
            logger.warning("locale lookup for incident %s failed: %s",
                           incident_id, e)
    return _normalize_locale(fallback)


def _locale_from_view(view: dict) -> str:
    """Read locale from a modal's `private_metadata` (we stuff it in when
    opening the modal). Falls back to en."""
    try:
        pm = _json.loads(view.get("private_metadata") or "{}")
    except Exception:
        pm = {}
    return _normalize_locale(pm.get("locale"))


# ---------------------------------------------------------------------------
# Action router (called from main.on_support_or_special)
# ---------------------------------------------------------------------------
def handle_action(action_id: str, body: dict, client) -> None:
    if action_id == "ask_support":
        _open_form(body, client)
        return
    if action_id == "cancel_support":
        # Slack cancel = close modal; nothing to do server-side
        return
    if action_id == "case_sync_report":
        _handle_sync_report(body, client)
        return


def _open_form(body: dict, client) -> None:
    """User clicked 🆘 on a report message — open the escalation modal,
    pre-filling subject from intent_summary."""
    raw_value = (body.get("actions") or [{}])[0].get("value") or "{}"
    try:
        v = _json.loads(raw_value)
    except Exception:
        v = {}
    incident_id = v.get("incident_id", "")
    # Locale priority: action JSON > linked DDB row > en. Read it BEFORE
    # the early-return so the missing-incident toast itself is localized.
    locale = _locale_from_action(raw_value)
    if not incident_id:
        client.chat_postEphemeral(
            channel=(body.get("channel") or {}).get("id", ""),
            user=(body.get("user") or {}).get("id", ""),
            text=i18n.t("support.toast.missing_incident", locale),
        )
        return

    # Refine locale from the linked DDB row if the action didn't supply one
    # (or if the value disagrees) — keeps the modal in the user's language
    # even when the click came through a default-locale path.
    if locale == "en":
        locale = _locale_from_incident(incident_id, fallback=locale)

    ctx = support_logic.load_support_context(incident_id) or {}
    default_subject = _build_subject_default(ctx)

    view = _build_form_view(incident_id=incident_id,
                            channel_id=(body.get("channel") or {}).get("id", ""),
                            thread_ts=(body.get("message") or {}).get("ts", ""),
                            initial_subject=default_subject,
                            locale=locale)
    try:
        client.views_open(trigger_id=body.get("trigger_id"), view=view)
    except Exception as e:
        logger.exception("views_open failed: %s", e)


def handle_view_submission(ack, body: dict, view: dict, client) -> None:
    """Submit handler for the support_form modal."""
    state = view.get("state", {}).get("values", {})
    locale = _locale_from_view(view)

    def field(block_id: str, action_id: str) -> str:
        return (state.get(block_id, {}).get(action_id, {}) or {}).get("value", "") or ""

    def select(block_id: str, action_id: str) -> str:
        opt = (state.get(block_id, {}).get(action_id, {}) or {}).get("selected_option") or {}
        return opt.get("value", "")

    subject = field("subject_block", "subject").strip()
    body_text = field("notes_block", "support_notes").strip()  # optional notes
    contact = field("contact_block", "contact").strip()
    severity = select("severity_block", "severity_select") or DEFAULT_SEVERITY
    language = select("language_block", "language_select") or DEFAULT_LANGUAGE

    pm_raw = view.get("private_metadata") or "{}"
    try:
        pm = _json.loads(pm_raw)
    except Exception:
        pm = {}
    incident_id = pm.get("incident_id", "")
    channel_id = pm.get("channel_id", "")
    thread_ts = pm.get("thread_ts", "")

    if severity not in SEVERITY_CODES:
        ack(response_action="errors",
            errors={"severity_block": i18n.t("support.toast.invalid_severity",
                                              locale, severity=severity)})
        return
    if language not in LANGUAGE_CODES:
        language = DEFAULT_LANGUAGE
    if not subject:
        ack(response_action="errors",
            errors={"subject_block": i18n.t(
                "case.create.subject_required_short", locale)})
        return

    if not support_logic.claim_inflight(f"slack:{incident_id}:{view.get('id', '')}"):
        ack(response_action="errors",
            errors={"subject_block": i18n.t(
                "case.create.processing_short", locale)})
        return

    ctx = support_logic.load_support_context(incident_id)
    if not ctx:
        ack(response_action="errors",
            errors={"subject_block": i18n.t(
                "support.expired.modal_error_short", locale)})
        return

    # Honor user-edited subject by overriding intent_summary in ctx.
    ctx = {**ctx, "intent_summary": subject}

    extra = body_text
    if contact:
        extra = (f"{extra}\n\nContact: {contact}".strip()
                 if extra else f"Contact: {contact}")

    # Dismiss the modal immediately. The result is posted to the
    # channel/thread by the worker thread, so there's no need to keep
    # a "creating…" modal open (Slack views don't auto-close).
    ack(response_action="clear")
    if channel_id:
        try:
            sev_label = severity_label(severity, locale)
            lang_label = LANGUAGE_LABELS.get(language, language)
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts or None,
                text=i18n.t("support.creating_status_msg", locale,
                            severity=sev_label, language=lang_label),
            )
        except Exception as e:
            logger.warning("post 'creating' status failed: %s", e)

    threading.Thread(
        target=_create_case_worker,
        args=(client, channel_id, thread_ts, ctx, incident_id,
              severity, language, extra, locale),
        daemon=True,
    ).start()


def _create_case_worker(client, channel_id: str, thread_ts: str, ctx: dict,
                        incident_id: str, severity: str, language: str,
                        extra: str, locale: str = "en") -> None:
    locale = _normalize_locale(locale)
    try:
        result = support_logic.create_case(
            ctx, platform=PLATFORM, severity=severity, language=language,
            extra=extra, operator_name="",
        )
        subject_for_display = support_logic.build_subject(ctx, PLATFORM)
        result_blocks = _result_blocks(result, severity, language,
                                       incident_id, subject_for_display,
                                       locale=locale)
        result_text = (i18n.t("support.success.title", locale) if result.ok
                       else i18n.t("support.failure.title", locale,
                                   code=result.error_code or "Error"))
    except Exception as e:
        logger.exception("create_case worker crashed")  # full detail → CloudWatch only
        result_blocks = [blocks.section(
            i18n.t("support.failure.internal_error_block_slack", locale,
                   kind=type(e).__name__))]
        result_text = i18n.t("support.failure.title_no_code", locale)

    try:
        client.chat_postMessage(channel=channel_id, thread_ts=thread_ts or None,
                                text=result_text, blocks=result_blocks)
    except Exception as e:
        logger.error("post result message failed: %s", e)


# ---------------------------------------------------------------------------
# Modal view builder
# ---------------------------------------------------------------------------
def _build_form_view(*, incident_id: str, channel_id: str,
                     thread_ts: str, initial_subject: str,
                     locale: str = "en") -> dict:
    locale = _normalize_locale(locale)
    sev_labels = severity_labels(locale)
    severity_options = [(c, sev_labels[c]) for c in SEVERITY_CODES]
    # Language picker labels stay bilingual / native form (中文 / 日本語 /
    # 한국어) — they're the language AWS Support engineers should reply in,
    # not the bot UI locale.
    language_options = [(c, LANGUAGE_LABELS[c]) for c in LANGUAGE_CODES]

    pm = _json.dumps({
        "incident_id": incident_id,
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "locale": locale,
    }, ensure_ascii=False)

    # Slack modal title field is plain_text with a 24-char hard cap.
    # We use the dedicated `_short` keys which are pre-trimmed; truncate
    # defensively as belt-and-suspenders.
    return blocks.modal(
        title=i18n.t("support.modal.title_short", locale)[:24],
        callback_id="confirm_support",
        submit=i18n.t("support.modal.submit_short", locale)[:24],
        close=i18n.t("support.modal.cancel_short", locale)[:24],
        private_metadata=pm,
        blocks=[
            blocks.section(i18n.t("support.form.intro_short", locale)),
            blocks.text_input(
                i18n.t("support.form.subject_label_short", locale),
                "subject", block_id="subject_block",
                placeholder=i18n.t("case.create.subject_placeholder_short",
                                   locale),
                initial_value=initial_subject,
                max_length=250,
            ),
            blocks.static_select(
                i18n.t("support.form.severity_label_short", locale),
                "severity_select",
                options=severity_options,
                initial_value=DEFAULT_SEVERITY,
                block_id="severity_block",
            ),
            blocks.static_select(
                i18n.t("support.form.language_label_short", locale),
                "language_select",
                options=language_options,
                initial_value=DEFAULT_LANGUAGE,
                block_id="language_block",
            ),
            blocks.text_input(
                i18n.t("support.form.notes_label_short", locale),
                "support_notes", block_id="notes_block",
                placeholder=i18n.t("support.form.notes_placeholder_short",
                                   locale),
                multiline=True, max_length=1000, optional=True,
            ),
            blocks.text_input(
                i18n.t("case.create.contact_label_short", locale),
                "contact", block_id="contact_block",
                placeholder=i18n.t("case.create.contact_placeholder_short",
                                   locale),
                max_length=200, optional=True,
            ),
            blocks.context(i18n.t("case.create.account_note", locale)),
        ],
    )


# ---------------------------------------------------------------------------
# Result message blocks
# ---------------------------------------------------------------------------
def _result_blocks(result: support_logic.CaseResult, severity: str,
                   language: str, incident_id: str,
                   subject: str,
                   locale: str = "en") -> list[dict]:
    locale = _normalize_locale(locale)
    if not result.ok:
        code = result.error_code or "Error"
        if code == "SubscriptionRequiredException":
            hint = i18n.t("case.create.fail_subscription", locale)
        else:
            hint = (result.error_message or "")[:300]
        return [blocks.section(
            i18n.t("support.failure.fail_block_slack", locale,
                   code=code, hint=blocks.escape_mrkdwn(hint)))]

    cls = result.classification or {}
    classification_block = ""
    if cls.get("serviceCode") or cls.get("categoryCode"):
        classification_block = i18n.t(
            "case.create.classification_lines", locale,
            service=cls.get("serviceCode", ""),
            category=cls.get("categoryCode", ""),
            issue_type=cls.get("issueType", ""),
        )
    subject_line = (i18n.t("support.success.subject_block_slack", locale,
                           subject=blocks.escape_mrkdwn(subject.strip()))
                    if subject and subject.strip() else "")
    sev_label = severity_label(severity, locale)
    lang_label = LANGUAGE_LABELS.get(language, language)
    return [
        blocks.header(i18n.t("support.success.title", locale)),
        blocks.section(
            i18n.t("support.success.id_link_block_slack", locale,
                   case_id=result.display_id,
                   subject_line=subject_line,
                   case_url=result.case_url)
        ),
        blocks.divider(),
        blocks.section(
            i18n.t("support.success.severity_lang_block_slack", locale,
                   severity=sev_label,
                   language=lang_label,
                   classification=classification_block,
                   incident_id=incident_id)
        ),
        blocks.actions(
            blocks.button(i18n.t("support.success.btn.open_case", locale),
                          "open_case_url",
                          url=result.case_url, style="primary"),
        ),
        blocks.context(i18n.t("support.success.login_warning", locale)),
    ]


# ---------------------------------------------------------------------------
# 📎 Sync investigation report to a linked case (case-create + dispatch flow)
# ---------------------------------------------------------------------------
def _handle_sync_report(body: dict, client) -> None:
    raw_value = (body.get("actions") or [{}])[0].get("value") or "{}"
    try:
        v = _json.loads(raw_value)
    except Exception:
        v = {}
    incident_id = v.get("incident_id", "")
    display_id = v.get("case_display_id", "")
    locale = _locale_from_action(raw_value)
    if not incident_id or not display_id:
        return
    if locale == "en":
        # Refine from incident if action didn't carry locale.
        locale = _locale_from_incident(incident_id, fallback=locale)

    channel_id = (body.get("channel") or {}).get("id", "")
    thread_ts = (body.get("message") or {}).get("thread_ts") \
        or (body.get("message") or {}).get("ts", "")
    user_id = (body.get("user") or {}).get("id", "")

    if not support_logic.claim_inflight(f"sync:{incident_id}:{display_id}"):
        client.chat_postEphemeral(channel=channel_id, user=user_id,
                                  text=i18n.t("case.toast.syncing_in_progress",
                                              locale))
        return

    ctx = support_logic.load_support_context(incident_id)
    if not ctx:
        client.chat_postEphemeral(channel=channel_id, user=user_id,
                                  text=i18n.t("case.toast.report_expired",
                                              locale))
        return

    threading.Thread(
        target=_sync_report_worker,
        args=(client, channel_id, thread_ts, display_id, ctx, locale),
        daemon=True,
    ).start()
    client.chat_postEphemeral(channel=channel_id, user=user_id,
                              text=i18n.t("case.pending.sync", locale,
                                          display_id=display_id))


def _sync_report_worker(client, channel_id: str, thread_ts: str,
                        display_id: str, ctx: dict,
                        locale: str = "en") -> None:
    locale = _normalize_locale(locale)
    from core import case_management
    try:
        body_text = _build_sync_body(ctx)
        ok = case_management.add_communication(display_id, body_text)
        if ok:
            case_url = case_management._case_console_url(display_id)
            blocks_out = [
                blocks.section(i18n.t("support.sync.success_block_slack",
                                       locale, display_id=display_id)),
                blocks.actions(
                    blocks.button(i18n.t("support.success.btn.open_case",
                                          locale),
                                  "open_case_url",
                                  url=case_url, style="primary"),
                ),
            ]
            text = i18n.t("case.sync.success_title", locale)
        else:
            blocks_out = [blocks.section(i18n.t(
                "support.sync.fail_block_slack", locale,
                display_id=display_id))]
            text = i18n.t("case.sync.fail_title", locale)
    except Exception as e:
        logger.exception("sync_report worker crashed")  # full detail → CloudWatch only
        blocks_out = [blocks.section(i18n.t(
            "support.sync.internal_error_block_slack", locale,
            kind=type(e).__name__))]
        text = i18n.t("case.sync.fail_title", locale)
    try:
        client.chat_postMessage(channel=channel_id,
                                thread_ts=thread_ts or None,
                                text=text, blocks=blocks_out)
    except Exception as e:
        logger.error("post sync result failed: %s", e)


def _build_sync_body(ctx: dict) -> str:
    summary = (ctx.get("summary_md") or "(no summary available)").strip()
    report_url = ctx.get("report_url") or ""
    trace_url = ctx.get("trace_url") or ""
    raw_text = ctx.get("raw_text") or ""
    intent = ctx.get("intent_summary") or ""
    parts = [
        "==============================================",
        "DevOps Agent automated investigation — FOR REFERENCE",
        "==============================================",
        "",
        "This comment was posted automatically by DevOps Agent. It contains",
        "the agent's diagnostic findings; please use it as additional context",
        "alongside any customer-provided information.",
        "",
        f"Original request : {raw_text or intent or '—'}",
        "",
    ]
    if report_url:
        parts += ["Full report (HTML, presigned, valid 7 days):",
                  report_url, ""]
    if trace_url:
        parts += ["Investigation trace (HTML, presigned, valid 7 days):",
                  trace_url, ""]
    parts += ["=== Investigation summary ===", "", summary]
    body = "\n".join(parts)
    if len(body) > 7900:
        body = body[:7900] + "\n\n[truncated — see report URL above for full content]"
    return body


# ---------------------------------------------------------------------------
# Subject pre-fill — same logic as the feishu side
# ---------------------------------------------------------------------------
def _build_subject_default(ctx: dict) -> str:
    if not ctx:
        return ""
    intent = _clean_subject_candidate(ctx.get("intent_summary") or "")
    if intent:
        return intent[:120]
    raw = _clean_subject_candidate(ctx.get("raw_text") or "")
    return raw[:120]


def _clean_subject_candidate(text: str) -> str:
    s = (text or "").strip()
    if not s:
        return ""
    looks_like_json = (
        s.startswith("{") or s.startswith("[")
        or '"command"' in s or '"intent"' in s or '"case_filter"' in s
    )
    if looks_like_json:
        return ""
    return s.splitlines()[0].strip()
