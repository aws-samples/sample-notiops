"""
"Ask for human support" flow — Feishu UI layer.

Pure business logic (severity/language constants, classification, CreateCase
calls, idempotency, context loading) lives in `core.support_logic`. This
file holds only the Feishu-specific bits:

  - card.action.trigger handlers (ask_support / confirm_support / cancel_support)
  - Feishu v2 form card builder (severity select + language select + notes input)
  - "creating…" / success / error / "ask again" cards in Feishu's schema
  - threading harness that returns a quick ACK then patches the card later
    (Feishu requires <3s ACK on card.action.trigger)

Flow:
  1. User clicks 🆘 on the report card → action="ask_support"
     → send a NEW form card with severity + language + notes
  2. User submits → action="confirm_support"
     → return "creating..." card immediately, do CreateCase in a thread,
       patch the card with success/error when done
  3. User clicks "Cancel" → action="cancel_support"
     → replace the form with an "ask again" card

Bilingual: every user-facing string flows through `core.i18n.t()` with the
conversation locale plumbed in. Card builders that produce visible UI take
a `locale: str = "zh"` parameter (default zh for legacy / safety).
"""
from __future__ import annotations

import logging
import re
import threading

from lark_oapi.event.callback.model.p2_card_action_trigger import (
    P2CardActionTriggerResponse,
)

from core import ddb_state
from core import i18n
from core import support_logic
from core.support_logic import (
    DEFAULT_LANGUAGE, DEFAULT_SEVERITY,
    LANGUAGE_CODES, LANGUAGE_LABELS,
    SEVERITY_CODES,
    severity_label, severity_labels,
)

from platforms.feishu.app import feishu_utils

logger = logging.getLogger(__name__)

PLATFORM = "feishu"


# ---------------------------------------------------------------------------
# Locale helpers
# ---------------------------------------------------------------------------
def _normalize_locale(value: str | None) -> str:
    """Coerce any incoming locale value to canonical zh/en. Default zh so
    legacy callers without a locale still render Chinese — the historical
    default for this bot."""
    v = (value or "").strip().lower()
    if v not in {"zh", "en"}:
        return "zh"
    return v


def _locale_from_incident(incident_id: str, fallback: str = "zh") -> str:
    """Best-effort locale lookup from a DDB conversations row keyed by
    incident_id. Used by the support flow's button handlers (where the
    button's action_value typically doesn't carry locale)."""
    if incident_id:
        try:
            row = ddb_state.get_by_incident(incident_id)
            if row and row.get("locale"):
                return _normalize_locale(row.get("locale"))
        except Exception as e:
            logger.warning("locale lookup for incident %s failed: %s",
                           incident_id, e)
    return _normalize_locale(fallback)


# Slack-style "*bold*" → Feishu lark_md "**bold**". i18n templates are
# written single-star (Slack convention); convert when rendering for
# Feishu cards. Idempotent if already double-starred.
_SINGLE_STAR_BOLD_RE = re.compile(r"(?<!\*)\*([^*\n]+?)\*(?!\*)")


def _bold(s: str) -> str:
    return _SINGLE_STAR_BOLD_RE.sub(r"**\1**", s)


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------
def handle(action_tag: str, action_value: dict, event,
           operator_name: str,
           locale: str = "zh") -> P2CardActionTriggerResponse:
    locale = _normalize_locale(locale)
    incident_id = action_value.get("incident_id", "")
    if not incident_id:
        return _toast(i18n.t("support.toast.missing_incident", locale))

    # Refine locale from the linked DDB row if the caller's hint differs —
    # keeps the cards we render from this handler in the user's language
    # even when the original click came through a default-locale path.
    locale = _locale_from_incident(incident_id, fallback=locale)

    if action_tag == "ask_support":
        # Send the form as a NEW chat message instead of replacing the
        # original report card. This keeps the report's "查看完整报告" /
        # "调查过程 Trace" buttons accessible after escalation.
        chat_id = _extract_chat_id(event)
        if not chat_id:
            return _toast(i18n.t("support.toast.missing_chat", locale))
        try:
            # Pre-fill subject from the investigation context so the user
            # sees a sensible default; they can edit it before submitting.
            ctx = support_logic.load_support_context(incident_id) or {}
            default_subject = _build_subject_default(ctx)
            form_card = _form_card(incident_id, subject=default_subject,
                                   locale=locale)
            resp = feishu_utils.send_card(chat_id=chat_id, card=form_card)
            if resp.get("code") != 0:
                logger.error("send form card failed: %s", resp)
                return _toast(i18n.t("support.toast.form_send_failed", locale))
            return _toast(i18n.t("support.toast.form_sent", locale))
        except Exception as e:
            logger.exception("ask_support send-card failed")
            return _toast(i18n.t("support.toast.exception", locale,
                                 kind=type(e).__name__))  # Security: detail → CloudWatch

    if action_tag == "cancel_support":
        # Replace the form card with a simple "cancelled" notice. The
        # original report card above still has the 🆘 button, so users can
        # restart escalation from there if they change their mind.
        return _build_card_response(
            i18n.t("case.create.cancel_toast", locale),
            _info_card(
                i18n.t("support.cancel.title", locale),
                i18n.t("support.cancel.body", locale),
                "grey",
            ),
        )

    if action_tag == "confirm_support":
        form = _extract_form_values(event)
        severity = form.get("severity_select") or DEFAULT_SEVERITY
        language = form.get("language_select") or DEFAULT_LANGUAGE
        extra = (form.get("support_notes", "") or "").strip()
        contact = (form.get("contact") or "").strip()
        # Append contact info to the extra block so it lands in the case
        # body's "Additional context from requester" section.
        if contact:
            extra = (f"{extra}\n\nContact: {contact}".strip()
                     if extra else f"Contact: {contact}")
        subject_override = (form.get("subject_override") or "").strip()
        message_id = ""
        try:
            message_id = (event.event.context.open_message_id or "")
        except AttributeError:
            try:
                message_id = (event.event.action.message_id or "")
            except AttributeError:
                pass
        logger.info("confirm_support sev=%s lang=%s notes_len=%d "
                    "subject_override=%r msg_id=%s",
                    severity, language, len(extra), subject_override[:60],
                    message_id)
        return _confirm(incident_id, severity, language, extra,
                        operator_name, card_message_id=message_id,
                        subject_override=subject_override,
                        locale=locale)

    return _toast(i18n.t("case.toast.unknown_action", locale))


# ---------------------------------------------------------------------------
# Two-phase confirm (return quick ACK, do slow work in background)
# ---------------------------------------------------------------------------
def _confirm(incident_id: str, severity: str, language: str, extra: str,
             operator_name: str,
             card_message_id: str,
             subject_override: str = "",
             locale: str = "zh") -> P2CardActionTriggerResponse:
    locale = _normalize_locale(locale)
    if severity not in SEVERITY_CODES:
        return _toast(i18n.t("support.toast.invalid_severity", locale,
                             severity=severity))
    if language not in LANGUAGE_CODES:
        language = DEFAULT_LANGUAGE

    if not support_logic.claim_inflight(card_message_id):
        logger.info("Duplicate confirm_support for msg=%s — already in flight",
                    card_message_id)
        return _toast(i18n.t("case.toast.processing", locale))

    ctx = support_logic.load_support_context(incident_id)
    if not ctx:
        return _build_card_response(
            i18n.t("support.toast.session_expired", locale),
            _info_card(
                i18n.t("support.expired.title", locale),
                i18n.t("support.expired.body", locale),
                "grey",
            ),
        )

    # Honor user-edited subject. support_logic.build_subject reads from
    # ctx["intent_summary"] first, so overriding that is enough — and we
    # avoid changing build_subject's signature for one platform.
    if subject_override:
        ctx = {**ctx, "intent_summary": subject_override}

    if card_message_id:
        threading.Thread(
            target=_create_case_worker,
            args=(card_message_id, ctx, incident_id, severity, language,
                  extra, operator_name, locale),
            daemon=True,
        ).start()
    else:
        logger.warning("No card_message_id; can't update card with result. "
                       "Falling back to synchronous create.")
        result = support_logic.create_case(
            ctx, platform=PLATFORM, severity=severity, language=language,
            extra=extra, operator_name=operator_name,
        )
        subject_for_display = support_logic.build_subject(ctx, PLATFORM)
        return _build_card_response(
            i18n.t("support.toast.created", locale),
            _result_card(result, severity, language, incident_id,
                         operator_name, subject=subject_for_display,
                         locale=locale))

    return _build_card_response(
        i18n.t("support.toast.creating", locale),
        _pending_card(severity, language, locale=locale))


def _create_case_worker(card_message_id: str, ctx: dict, incident_id: str,
                        severity: str, language: str, extra: str,
                        operator_name: str,
                        locale: str = "zh") -> None:
    """Background thread: call CreateCase, then patch the original card."""
    locale = _normalize_locale(locale)
    try:
        result = support_logic.create_case(
            ctx, platform=PLATFORM, severity=severity, language=language,
            extra=extra, operator_name=operator_name,
        )
        # Show the same subject we used on the API call back to the user
        # so the success card matches what was sent to AWS Support.
        subject_for_display = support_logic.build_subject(ctx, PLATFORM)
        result_card = _result_card(result, severity, language, incident_id,
                                   operator_name, subject=subject_for_display,
                                   locale=locale)
    except Exception as e:
        logger.exception("create_case worker crashed")
        result_card = _info_card(
            i18n.t("support.failure.title_no_code", locale),
            i18n.t("case.create.internal_error", locale,
                   kind=type(e).__name__),  # Security: type only; detail → CloudWatch
            "red",
        )

    try:
        feishu_utils.update_card(card_message_id, result_card)
    except Exception as e:
        logger.error("Failed to update card %s: %s", card_message_id, e)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _build_subject_default(ctx: dict) -> str:
    """Pick a sensible default subject for the escalation form.

    Prefers Bedrock's `intent_summary` since it's a clean one-line
    restatement, falling back to the user's `raw_text`. Defends against
    the rare case where intent_summary is the model's malformed JSON
    output (happens when Bedrock returns non-JSON and bedrock_intent's
    fallback used to paste the raw text in) — anything that looks like
    JSON or is suspiciously long gets dropped in favor of raw_text.
    """
    if not ctx:
        return ""
    intent = _clean_subject_candidate(ctx.get("intent_summary") or "")
    if intent:
        return intent[:120]
    raw = _clean_subject_candidate(ctx.get("raw_text") or "")
    return raw[:120]


def _clean_subject_candidate(text: str) -> str:
    """Reject text that looks like LLM-output JSON or is too long to be a
    case subject. Returns '' to signal the caller to fall through."""
    s = (text or "").strip()
    if not s:
        return ""
    # JSON-like content (`{"command": ...}` etc.) is not a usable subject.
    looks_like_json = (
        s.startswith("{")
        or s.startswith("[")
        or '"command"' in s
        or '"intent"' in s
        or '"case_filter"' in s
    )
    if looks_like_json:
        return ""
    # Bedrock occasionally returns multi-line junk; subject should be one line.
    s = s.splitlines()[0].strip()
    return s


# ---------------------------------------------------------------------------
# Card builders (Feishu v2 schema)
# ---------------------------------------------------------------------------
def _form_card(incident_id: str,
               language: str = DEFAULT_LANGUAGE,
               severity: str = DEFAULT_SEVERITY,
               subject: str = "",
               locale: str = "zh") -> dict:
    """Feishu v2 form card with subject + language + severity + multiline notes.

    `subject` is pre-filled from the investigation's intent_summary. The
    user can edit it before submitting; the edited value is read out as
    `subject_override` in confirm_support and replaces ctx.intent_summary
    for the CreateCase call.
    """
    locale = _normalize_locale(locale)
    # Language picker labels stay bilingual / native form (中文 / 日本語 /
    # 한국어) — they're the language AWS Support engineers should reply in,
    # not the bot UI locale. Same as case_flow.
    language_options = [
        {"text": {"tag": "plain_text", "content": LANGUAGE_LABELS[code]},
         "value": code}
        for code in LANGUAGE_CODES
    ]
    sev_labels = severity_labels(locale)
    severity_options = [
        {"text": {"tag": "plain_text", "content": sev_labels[code]},
         "value": code}
        for code in SEVERITY_CODES
    ]
    return {
        "schema": "2.0",
        "config": {"streaming_mode": False},
        "header": {
            "title": {"tag": "plain_text",
                      "content": i18n.t("support.form.title", locale)},
            "template": "red",
        },
        "body": {
            "elements": [
                {"tag": "markdown",
                 "content": i18n.t("support.form.intro", locale)},
                {"tag": "form",
                 "name": "support_form",
                 "elements": [
                     {"tag": "markdown",
                      "content": i18n.t("support.form.subject_label", locale)},
                     {"tag": "input",
                      "name": "subject_override",
                      "placeholder": {"tag": "plain_text",
                                      "content": i18n.t(
                                          "case.create.subject_placeholder",
                                          locale)},
                      "default_value": subject[:200],
                      "max_length": 250,
                      "required": True,
                      "width": "fill"},
                     {"tag": "markdown",
                      "content": i18n.t("support.form.language_label", locale)},
                     {"tag": "select_static",
                      "name": "language_select",
                      "placeholder": {"tag": "plain_text",
                                      "content": i18n.t(
                                          "support.form.language_placeholder",
                                          locale)},
                      "initial_index": LANGUAGE_CODES.index(language) + 1,
                      "options": language_options,
                      "type": "default",
                      "width": "fill",
                      "required": True},
                     {"tag": "markdown",
                      "content": i18n.t("support.form.severity_label", locale)},
                     {"tag": "select_static",
                      "name": "severity_select",
                      "placeholder": {"tag": "plain_text",
                                      "content": i18n.t(
                                          "support.form.severity_placeholder",
                                          locale)},
                      "initial_index": SEVERITY_CODES.index(severity) + 1,
                      "options": severity_options,
                      "type": "default",
                      "width": "fill",
                      "required": True},
                     {"tag": "markdown",
                      "content": i18n.t("support.form.notes_label", locale)},
                     {"tag": "input",
                      "input_type": "multiline_text",
                      "name": "support_notes",
                      "placeholder": {"tag": "plain_text",
                                      "content": i18n.t(
                                          "support.form.notes_placeholder",
                                          locale)},
                      "default_value": "",
                      "max_length": 1000,
                      "rows": 5,
                      "width": "fill"},
                     {"tag": "markdown",
                      "content": i18n.t("case.create.contact_label", locale)},
                     {"tag": "input",
                      "name": "contact",
                      "placeholder": {"tag": "plain_text",
                                      "content": i18n.t(
                                          "case.create.contact_placeholder",
                                          locale)},
                      "default_value": "",
                      "max_length": 200,
                      "required": False,
                      "width": "fill"},
                     {"tag": "column_set",
                      "columns": [
                          {"tag": "column", "width": "weighted", "weight": 2,
                           "elements": [
                               {"tag": "button",
                                "name": "btn_submit",
                                "text": {"tag": "plain_text",
                                         "content": i18n.t(
                                             "support.form.btn.submit",
                                             locale)},
                                "type": "primary",
                                "form_action_type": "submit",
                                "behaviors": [{
                                    "type": "callback",
                                    "value": {
                                        "action": "confirm_support",
                                        "incident_id": incident_id,
                                    },
                                }]},
                           ]},
                          {"tag": "column", "width": "weighted", "weight": 1,
                           "elements": [
                               {"tag": "button",
                                "name": "btn_reset",
                                "text": {"tag": "plain_text",
                                         "content": i18n.t(
                                             "case.create.btn.reset",
                                             locale)},
                                "type": "default",
                                "form_action_type": "reset"},
                           ]}
                      ]},
                 ]},
                {"tag": "column_set",
                 "columns": [
                     {"tag": "column", "width": "weighted", "weight": 1,
                      "elements": [
                          {"tag": "button",
                           "text": {"tag": "plain_text",
                                    "content": i18n.t(
                                        "support.form.btn.cancel", locale)},
                           "type": "default",
                           "behaviors": [{
                               "type": "callback",
                               "value": {"action": "cancel_support",
                                         "incident_id": incident_id},
                           }]},
                      ]}
                 ]},
                {"tag": "markdown",
                 "content": i18n.t("support.form.account_note", locale)},
            ],
        },
    }


def _pending_card(severity: str, language: str,
                  locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    sev_label = severity_label(severity, locale)
    lang_label = LANGUAGE_LABELS.get(language, language)
    return {
        "schema": "2.0",
        "config": {"streaming_mode": False},
        "header": {
            "title": {"tag": "plain_text",
                      "content": i18n.t("support.pending.title", locale)},
            "template": "blue",
        },
        "body": {
            "elements": [
                {"tag": "markdown",
                 "content": i18n.t("support.pending.body", locale,
                                   severity=sev_label,
                                   language=lang_label)},
            ],
        },
    }


def _result_card(result: support_logic.CaseResult, severity: str, language: str,
                 incident_id: str, operator_name: str,
                 subject: str = "",
                 locale: str = "zh") -> dict:
    """Render either a success or failure card from the CaseResult dataclass."""
    locale = _normalize_locale(locale)
    if result.ok:
        return _success_card(result.display_id, result.case_url, severity,
                             language, incident_id, operator_name,
                             classification=result.classification,
                             subject=subject, locale=locale)
    code = result.error_code or "Error"
    if code == "SubscriptionRequiredException":
        hint = i18n.t("case.create.fail_subscription", locale)
    else:
        hint = (result.error_message or "")[:300]
    return _info_card(
        i18n.t("support.failure.title", locale, code=code),
        hint, "red")


def _success_card(case_id: str, case_url: str, severity: str, language: str,
                  incident_id: str, operator_name: str,
                  classification: dict | None = None,
                  subject: str = "",
                  locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    cls = classification or {}
    service = cls.get("serviceCode", "")
    category = cls.get("categoryCode", "")
    issue_type = cls.get("issueType", "")
    classification_block = ""
    if service or category:
        classification_block = i18n.t("case.create.classification_block", locale,
                                      service=service,
                                      category=category,
                                      issue_type=issue_type)
    # ID first so the user can copy it without scrolling, subject second
    # for context, link last as the primary action target.
    subject_block = (i18n.t("support.success.subject_block", locale,
                            subject=subject.strip())
                     if subject and subject.strip() else "")
    sev_label = severity_label(severity, locale)
    lang_label = LANGUAGE_LABELS.get(language, language)
    return {
        "schema": "2.0",
        "config": {"streaming_mode": False},
        "header": {
            "title": {"tag": "plain_text",
                      "content": i18n.t("support.success.title", locale)},
            "template": "green",
        },
        "body": {
            "elements": [
                {"tag": "markdown",
                 "content": (i18n.t("support.success.case_id_block", locale,
                                    case_id=case_id)
                             + subject_block + "\n\n"
                             + i18n.t("support.success.case_link_block", locale,
                                      url=case_url))},
                {"tag": "hr"},
                {"tag": "markdown",
                 "content": i18n.t("support.success.severity_lang_block", locale,
                                   severity=sev_label,
                                   language=lang_label,
                                   classification=classification_block,
                                   incident_id=incident_id)},
                {"tag": "column_set",
                 "columns": [
                     {"tag": "column", "width": "weighted", "weight": 1,
                      "elements": [
                          {"tag": "button",
                           "text": {"tag": "plain_text",
                                    "content": i18n.t(
                                        "support.success.btn.open_case",
                                        locale)},
                           "type": "primary",
                           "behaviors": [{
                               "type": "open_url",
                               "default_url": case_url,
                               "android_url": case_url,
                               "ios_url": case_url,
                               "pc_url": case_url,
                           }]},
                      ]}
                 ]},
                {"tag": "markdown",
                 "content": i18n.t("support.success.login_warning", locale)},
            ],
        },
    }


def _info_card(title: str, body: str, color: str = "blue") -> dict:
    return {
        "schema": "2.0",
        "config": {"streaming_mode": False},
        "header": {"title": {"tag": "plain_text", "content": title},
                   "template": color},
        "body": {
            "elements": [
                {"tag": "markdown", "content": body},
            ],
        },
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _extract_chat_id(event) -> str:
    candidates = []
    try:
        candidates.append(event.event.context.open_chat_id)
    except AttributeError:
        pass
    try:
        candidates.append(event.event.chat_id)
    except AttributeError:
        pass
    for c in candidates:
        if isinstance(c, str) and c:
            return c
    return ""


def _extract_form_values(event) -> dict:
    """Pull the dict of form input values from the trigger event.

    Feishu places form-control values under `event.event.form_value` (dict
    keyed by element name). Different lark_oapi releases have shuffled the
    accessor paths; try several defensively.
    """
    candidates = []
    try:
        candidates.append(getattr(event.event, "form_value", None))
    except AttributeError:
        pass
    try:
        candidates.append(getattr(event.event.action, "form_value", None))
    except AttributeError:
        pass
    try:
        candidates.append(getattr(event.event.action, "input_value", None))
    except AttributeError:
        pass
    for c in candidates:
        if isinstance(c, dict) and c:
            return {k: (v if isinstance(v, str) else str(v or ""))
                    for k, v in c.items()}
    return {}


def _toast(text: str) -> P2CardActionTriggerResponse:
    return P2CardActionTriggerResponse({
        "toast": {"type": "info", "content": text}
    })


def _build_card_response(toast: str, new_card: dict) -> P2CardActionTriggerResponse:
    return P2CardActionTriggerResponse({
        "toast": {"type": "info", "content": toast},
        "card": {"type": "raw", "data": new_card},
    })
