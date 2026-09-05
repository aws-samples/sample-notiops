"""
AWS Support case management — Feishu UI layer.

Pure business logic (list / describe / communicate / resolve) lives in
`core.case_management`. This file owns Feishu v2 card builders and the
callback router for these card.action.trigger types:

  case_create_form        - render new-case form
  case_create_submit      - submit form, call CreateCase
  case_create_cancel      - dismiss form

  case_list_open          - render the open-cases list
  case_view               - render detail card for a single case
  case_reply_form         - render reply textarea
  case_reply_submit       - call AddCommunicationToCase
  case_resolve_confirm    - render confirmation card
  case_resolve_yes        - call ResolveCase
  case_resolve_no         - dismiss confirmation

`main.py` dispatches inbound mentions by `command` (from
`core.bedrock_intent.analyze_intent`) into the `start_*` entry points
defined here; clicked card buttons re-enter via `handle()`.

Bilingual: every user-facing string flows through `core.i18n.t()` with
the conversation locale plumbed in. Card builders that produce visible
UI take a `locale: str` parameter (defaulting to "zh" for legacy
callers that haven't been updated).
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Optional

from lark_oapi.event.callback.model.p2_card_action_trigger import (
    P2CardActionTriggerResponse,
)

from core import case_analyze
from core import case_classifier
from core import case_management
from core import ddb_state
from core import i18n
from core import support_logic
from core import webhook_dispatch  # noqa: F401 — reserved for future skill paths
from core.case_management import CaseSummary, Communication
from core.feishu_card import card_config
from core.support_logic import (
    DEFAULT_ISSUE_TYPE, DEFAULT_LANGUAGE, DEFAULT_SEVERITY,
    ISSUE_TYPE_CODES,
    LANGUAGE_CODES, LANGUAGE_LABELS,
    SEVERITY_CODES, issue_type_label, issue_type_labels,
    severity_label, severity_labels,
)

from platforms.feishu.app import feishu_utils

logger = logging.getLogger(__name__)

PLATFORM = "feishu"

CASE_CREATE_ACTIONS = {"case_create_submit", "case_create_submit_with_dispatch",
                       "case_create_cancel", "case_create_dispatch_after"}
CASE_REPLY_ACTIONS = {"case_reply_form", "case_reply_submit"}
CASE_RESOLVE_ACTIONS = {"case_resolve_confirm", "case_resolve_yes",
                        "case_resolve_no"}
CASE_NAV_ACTIONS = {"case_view", "case_list_open"}
CASE_SYNC_ACTIONS = {"case_sync_report"}

ALL_CASE_ACTIONS = (CASE_CREATE_ACTIONS | CASE_REPLY_ACTIONS
                    | CASE_RESOLVE_ACTIONS | CASE_NAV_ACTIONS)


# ---------------------------------------------------------------------------
# Locale helpers
# ---------------------------------------------------------------------------

def _normalize_locale(value: str | None) -> str:
    """Coerce any incoming locale value to the canonical zh/en. Default zh
    so legacy paths that still call without a locale render Chinese — the
    historical default for this bot."""
    v = (value or "").strip().lower()
    if v not in {"zh", "en"}:
        return "zh"
    return v


def _locale_from_event(event_id: str = "", incident_id: str = "",
                       fallback: str = "zh") -> str:
    """Best-effort locale lookup from a DDB conversations row.

    Used by handler branches that don't already have a locale in scope —
    e.g. a button click on a card we sent earlier. We try event_id first
    (the user's original @-mention row), then incident_id (the linked
    investigation row carrying the same locale), then fall back."""
    for getter, key in ((ddb_state.get_by_event, event_id),
                        (ddb_state.get_by_incident, incident_id)):
        if not key:
            continue
        try:
            row = getter(key)
        except Exception as e:
            logger.warning("locale lookup failed for %s: %s", key, e)
            continue
        if row and row.get("locale"):
            return _normalize_locale(row.get("locale"))
    return _normalize_locale(fallback)


# Slack-style "*bold*" → Feishu lark_md "**bold**". i18n templates are
# written single-star (Slack convention); convert when rendering for
# Feishu cards. Idempotent if already double-starred.
_SINGLE_STAR_BOLD_RE = re.compile(r"(?<!\*)\*([^*\n]+?)\*(?!\*)")


def _bold(s: str) -> str:
    return _SINGLE_STAR_BOLD_RE.sub(r"**\1**", s)


# ===========================================================================
# Entry points called from main.py (natural-language / slash dispatch)
# ===========================================================================
def start_create(chat_id: str, raw_text: str, locale: str = "zh") -> None:
    """Send the case-create form into the chat.

    Subject pre-fill: if the user's original message contains enough signal
    (service name, resource id, error keywords), ask Bedrock to summarize
    it into a clean "service + resource + symptom" subject. Otherwise we
    leave Subject empty so the markdown hint above the input can guide
    them — much better than dumping the entire user message into Subject.
    """
    if not chat_id:
        return
    locale = _normalize_locale(locale)
    initial_subject = _summarize_subject(raw_text, locale=locale)
    feishu_utils.send_card(chat_id=chat_id,
                           card=_create_form_card(subject=initial_subject,
                                                  locale=locale))


# Phrases users typically type to OPEN a case — when the input is just
# this short kind of intent ("帮我开案例", "create case"), there's no
# detail to summarize and Subject should stay empty.
_INTENT_ONLY_PATTERNS = (
    "创建案例", "创建 case", "创建case", "开案例", "开 case", "开case",
    "新建案例", "新建 case", "新建case", "提工单", "开工单",
    "升级到 support", "升级到support", "升级 support",
    "create case", "open case", "new case", "support ticket",
    "escalate to support", "ask support",
)


def _summarize_subject(raw_text: str, locale: str = "zh") -> str:
    """Return a clean subject pre-fill, or '' if the input has no usable
    detail. Uses Bedrock for the summarization."""
    text = (raw_text or "").strip()
    if not text:
        return ""

    # Step 1: strip a leading "create case" / "开案例" intent marker if
    # present, anywhere in the text — many users type "@bot 开案例 调查
    # EC2 CPU 过高" where the meaningful topic is what FOLLOWS the marker.
    # Removing the marker first means we treat that as a real subject
    # rather than fall through to Bedrock with the verbose original.
    lowered = text.lower()
    stripped = text
    for p in _INTENT_ONLY_PATTERNS:
        idx = lowered.find(p)
        if idx >= 0:
            # Keep what's before the marker (rare) + what's after it.
            head = text[:idx].rstrip(" ,，:。.")
            tail = text[idx + len(p):].lstrip(" ,，:。.")
            stripped = (head + " " + tail).strip() if head else tail
            break

    # Step 2: empty after stripping → user only said "create case" with
    # no topic; leave Subject blank so the form's hint guides them.
    if not stripped:
        return ""

    # Step 3: short enough to use as-is — no Bedrock round-trip needed.
    # Bumped the threshold from 30 to 60 since CJK characters carry a lot
    # of meaning per char and the kind of phrases users type tend to be
    # already concise enough to use verbatim.
    if len(stripped) <= 60:
        return stripped

    # Step 4: long input — ask Bedrock to extract a clean
    # "service + resource + symptom" subject.
    try:
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 120,
            "system": i18n.t("case.create.summarizer_system_prompt", locale),
            "messages": [{"role": "user", "content": text}],
        }
        # Reuse the bedrock client already initialized in core.bedrock_intent
        # so we don't pay a second cold start.
        from core import bedrock_intent
        resp = bedrock_intent._bedrock.invoke_model(
            modelId=bedrock_intent.BEDROCK_MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=__import__("json").dumps(body),
        )
        import json as _json
        data = _json.loads(resp["body"].read())
        subject = ""
        for block in data.get("content", []):
            if block.get("type") == "text":
                subject = block["text"].strip().strip('"').strip("'")
                break
        # Bedrock got it: use that. Otherwise fall back to the
        # marker-stripped text so users still see SOMETHING relevant.
        return (subject[:200] if subject else stripped[:200])
    except Exception as e:
        logger.warning("Subject summarization failed; falling back to stripped text: %s", e)
        return stripped[:200]


# Mapping of status_filter slug → i18n key for the human-readable label.
_FILTER_LABEL_KEYS = {
    "recent": "case.list.filter.recent",
    "pending_customer": "case.list.filter.pending_customer",
    "unresolved": "case.list.filter.unresolved",
    "work_in_progress": "case.list.filter.work_in_progress",
    "resolved": "case.list.filter.resolved",
}

# Order-preserving slug list for the quick-filter button row at the bottom of
# the list card — paired with `case.list.filter_btn.<slug>` keys for labels.
_FILTER_BUTTON_SLUGS = ("recent", "pending_customer", "unresolved",
                        "work_in_progress", "resolved")

# Mapping of filter slug → empty-state i18n key. Keep in lockstep with
# `_FILTER_BUTTON_SLUGS`.
_FILTER_EMPTY_KEYS = {
    "recent": "case.list.empty.recent",
    "pending_customer": "case.list.empty.pending_customer",
    "unresolved": "case.list.empty.unresolved",
    "work_in_progress": "case.list.empty.work_in_progress",
    "resolved": "case.list.empty.resolved",
}


def _filter_label(slug: str, locale: str) -> str:
    """Human-readable filter label, falling back to 'recent' for unknown
    slugs (matches legacy default)."""
    key = _FILTER_LABEL_KEYS.get(slug, _FILTER_LABEL_KEYS["recent"])
    return i18n.t(key, locale)


def _filter_quick_row(current: str, locale: str) -> dict:
    """Render a row of quick-filter buttons. The currently-active filter
    is omitted so users can't click into the same view they're already in."""
    buttons = []
    for slug in _FILTER_BUTTON_SLUGS:
        if slug == current:
            continue
        label = i18n.t(f"case.list.filter_btn.{slug}", locale)
        buttons.append(_callback_button(
            label,
            {"action": "case_list_filter", "case_filter": slug},
        ))
    return _action_row(buttons)


def start_list(chat_id: str, status_filter: str = "recent",
               locale: str = "zh") -> None:
    if not chat_id:
        return
    locale = _normalize_locale(locale)
    cases = case_management.list_recent_cases(
        after_days=90, max_items=5, status_filter=status_filter,
    )
    feishu_utils.send_card(chat_id=chat_id,
                           card=_list_card(cases, status_filter=status_filter,
                                           locale=locale))


def start_view(chat_id: str, display_id: str,
               internal_id: str = "", locale: str = "zh") -> None:
    if not chat_id:
        return
    locale = _normalize_locale(locale)
    if not display_id and not internal_id:
        # Defensive — bedrock_intent.analyze_intent should have already
        # downgraded to case_list, but main.py can still call us.
        start_list(chat_id, locale=locale)
        return
    summary = case_management.describe_case(display_id,
                                            internal_id=internal_id or None)
    if not summary:
        feishu_utils.send_card(chat_id=chat_id, card=_info_card(
            i18n.t("case.view.not_found_title", locale),
            i18n.t("case.view.not_found_body", locale, display_id=display_id),
            "grey",
        ))
        return
    comms = case_management.list_communications(
        display_id, max_items=5, internal_id=summary.internal_id or internal_id or None)
    feishu_utils.send_card(chat_id=chat_id,
                           card=_view_card(summary, comms, locale=locale))


def start_reply(chat_id: str, display_id: str, raw_text: str,
                internal_id: str = "", locale: str = "zh") -> None:
    if not chat_id:
        return
    locale = _normalize_locale(locale)
    if not display_id and not internal_id:
        start_list(chat_id, locale=locale)
        return
    body = _extract_reply_body(raw_text, display_id) if display_id else ""
    if body and len(body) >= 4:
        _send_reply(chat_id, display_id, body, internal_id=internal_id,
                    locale=locale)
        return
    feishu_utils.send_card(
        chat_id=chat_id,
        card=_reply_form_card(display_id, internal_id=internal_id,
                              locale=locale),
    )


def start_resolve(chat_id: str, display_id: str,
                  internal_id: str = "", locale: str = "zh") -> None:
    if not chat_id:
        return
    locale = _normalize_locale(locale)
    if not display_id and not internal_id:
        start_list(chat_id, locale=locale)
        return
    feishu_utils.send_card(
        chat_id=chat_id,
        card=_resolve_confirm_card(display_id, internal_id=internal_id,
                                   locale=locale),
    )


def start_analyze(chat_id: str, display_id: str,
                  locale: str = "zh") -> None:
    """LLM-driven case analysis: fetch case + comms → Bedrock summary →
    render insights card. Heavy lift (~5-15s including AWS Support
    describe + Bedrock invoke) — runs synchronously in the event handler
    thread; an inline-text "正在分析..." is sent first so the user sees
    immediate feedback.
    """
    if not chat_id:
        return
    locale = _normalize_locale(locale)
    if not display_id:
        start_list(chat_id, locale=locale)
        return

    # Inline "starting" toast so the chat doesn't appear unresponsive
    # during the 5-15s analyze. Uses send_text_to_chat (no card) — keeps
    # it visually light vs the report card that follows.
    try:
        feishu_utils.send_text_to_chat(
            chat_id,
            i18n.t("case.analyze.toast.starting", locale, display_id=display_id),
        )
    except Exception as e:
        logger.warning("case_analyze: starting-toast send failed (non-fatal): %s", e)

    result = case_analyze.analyze(display_id, locale=locale)

    if result.error == "case_not_found":
        feishu_utils.send_card(chat_id=chat_id, card=_info_card(
            i18n.t("case.view.not_found_title", locale),
            i18n.t("case.analyze.error.case_not_found", locale,
                   display_id=display_id),
            "grey",
        ))
        return
    if result.error:
        feishu_utils.send_card(chat_id=chat_id, card=_info_card(
            i18n.t("case.analyze.title", locale, display_id=display_id),
            i18n.t("case.analyze.error.llm_failed", locale,
                   detail=result.error),
            "red",
        ))
        return

    feishu_utils.send_card(chat_id=chat_id,
                           card=_analyze_card(result, locale=locale))


# ===========================================================================
# Callback router (called by main.on_card_action)
# ===========================================================================
def handle(action_tag: str, action_value: dict, event,
           *, operator_name: str = "",
           locale: str = "zh") -> P2CardActionTriggerResponse:
    locale = _normalize_locale(locale)
    chat_id = _extract_chat_id(event)
    message_id = _extract_message_id(event)

    if action_tag == "case_create_submit":
        return _handle_create_submit(action_value, event, operator_name,
                                     card_message_id=message_id,
                                     dispatch_after=False, locale=locale)
    if action_tag == "case_create_submit_with_dispatch":
        return _handle_create_submit(action_value, event, operator_name,
                                     card_message_id=message_id,
                                     dispatch_after=True, locale=locale)
    if action_tag == "case_create_dispatch_after":
        # User clicked "Dispatch investigation" on the success card after
        # opening a case. We have the case context in the action_value
        # (subject + body), so spin up an investigation now.
        display_id = action_value.get("case_display_id", "")
        subject = action_value.get("subject", "")
        body = action_value.get("body", "")
        return _dispatch_investigation_for_case(chat_id, display_id, subject,
                                                body, message_id, locale=locale)
    if action_tag == "case_create_cancel":
        return _build_card_response(
            i18n.t("case.create.cancel_toast", locale),
            _info_card(
                i18n.t("case.create.cancel_title", locale),
                i18n.t("case.create.cancel_body", locale),
                "grey",
            ),
        )

    if action_tag == "case_view":
        display_id = action_value.get("case_display_id", "")
        internal_id = action_value.get("case_internal_id", "")
        if chat_id and (display_id or internal_id):
            start_view(chat_id, display_id, internal_id=internal_id,
                       locale=locale)
        return _toast(
            i18n.t("case.toast.loaded", locale, display_id=display_id)
            if display_id
            else i18n.t("case.toast.loaded_no_id", locale))

    if action_tag == "case_list_open":
        if chat_id:
            start_list(chat_id, locale=locale)
        return _toast(i18n.t("case.toast.refreshed", locale))

    if action_tag == "case_list_filter":
        # Quick-filter buttons at the bottom of the list card. Send a NEW
        # list card with the requested filter; original list stays put.
        new_filter = action_value.get("case_filter", "recent")
        if chat_id:
            start_list(chat_id, status_filter=new_filter, locale=locale)
        return _toast(i18n.t("case.toast.switched_filter", locale,
                             filter=_filter_label(new_filter, locale)))

    if action_tag == "case_reply_form":
        # Send the reply form as a NEW card so the original list card
        # remains visible — users want to keep the list open while they
        # reply to one row.
        display_id = action_value.get("case_display_id", "")
        internal_id = action_value.get("case_internal_id", "")
        if chat_id:
            feishu_utils.send_card(
                chat_id=chat_id,
                card=_reply_form_card(display_id, internal_id=internal_id,
                                      locale=locale),
            )
        return _toast(
            i18n.t("case.toast.opened_reply_form", locale,
                   display_id=display_id)
            if display_id
            else i18n.t("case.toast.opened_reply_form_no_id", locale))

    if action_tag == "case_reply_submit":
        display_id = action_value.get("case_display_id", "")
        internal_id = action_value.get("case_internal_id", "")
        form = _extract_form_values(event)
        body = (form.get("reply_body") or "").strip()
        if (not display_id and not internal_id) or not body:
            return _toast(i18n.t("case.toast.missing_id_or_body", locale))
        return _handle_reply_submit(display_id, body, message_id,
                                    internal_id=internal_id, locale=locale)

    if action_tag == "case_resolve_confirm":
        # Same as reply_form: send a NEW confirm card so the list survives.
        display_id = action_value.get("case_display_id", "")
        internal_id = action_value.get("case_internal_id", "")
        if chat_id:
            feishu_utils.send_card(
                chat_id=chat_id,
                card=_resolve_confirm_card(display_id, internal_id=internal_id,
                                           locale=locale),
            )
        return _toast(
            i18n.t("case.toast.confirm_close", locale, display_id=display_id)
            if display_id
            else i18n.t("case.toast.confirm_close_generic", locale))

    if action_tag == "case_resolve_yes":
        display_id = action_value.get("case_display_id", "")
        internal_id = action_value.get("case_internal_id", "")
        return _handle_resolve(display_id, message_id, internal_id=internal_id,
                               locale=locale)

    if action_tag == "case_resolve_no":
        return _build_card_response(
            i18n.t("case.resolve.cancel_toast", locale),
            _info_card(
                i18n.t("case.resolve.cancel_title", locale),
                i18n.t("case.resolve.cancel_body", locale),
                "grey",
            ),
        )

    if action_tag == "case_sync_report":
        display_id = action_value.get("case_display_id", "")
        incident_id = action_value.get("incident_id", "")
        # Sync is triggered from a report card — that card already knows
        # the incident's locale, but the payload doesn't carry it. Pull
        # it from the incident's DDB row so the sync result/pending cards
        # speak the user's language.
        sync_locale = _locale_from_event(incident_id=incident_id,
                                         fallback=locale)
        return _handle_sync_report(chat_id, display_id, incident_id,
                                   locale=sync_locale)

    return _toast(i18n.t("case.toast.unknown_action", locale))


# ===========================================================================
# Submit handlers (the slow ones do the API call in a background thread
# so we satisfy Feishu's 3s ACK window — same pattern as support_flow.py)
# ===========================================================================
def _handle_create_submit(action_value: dict, event, operator_name: str,
                          card_message_id: str,
                          dispatch_after: bool,
                          locale: str = "zh"
                          ) -> P2CardActionTriggerResponse:
    locale = _normalize_locale(locale)
    form = _extract_form_values(event)
    subject = (form.get("subject") or "").strip()
    body = (form.get("body") or "").strip()
    contact = (form.get("contact") or "").strip()
    severity = form.get("severity_select") or DEFAULT_SEVERITY
    language = form.get("language_select") or DEFAULT_LANGUAGE
    # 服务名称 / 类别 / 案例类型（2026-09-03 补服务与类型、2026-09-04 补类别，与 web 端
    # 案例面板对齐）。三项都**不拦提交**：服务名与类别留空 = 交给分类器（历史行为）；
    # 类型拿不到就退回默认。
    service_text = _picked_service_code(form.get("service_select") or "",
                                        form.get("service_text") or "")
    category_text = (form.get("category_text") or "").strip()
    issue_type = form.get("issue_type_select") or DEFAULT_ISSUE_TYPE
    if issue_type not in ISSUE_TYPE_CODES:
        issue_type = DEFAULT_ISSUE_TYPE
    chat_id = _extract_chat_id(event)

    if not subject or not body:
        return _toast(i18n.t("case.create.toast.subject_required", locale))

    if not support_logic.claim_inflight(card_message_id or f"create:{subject[:60]}"):
        return _toast(i18n.t("case.toast.processing", locale))

    # Build the support_logic.create_case context as if there were no
    # investigation behind it — just user-typed subject+body.
    ctx = {
        "intent_summary": subject,
        "raw_text": body,
        "summary_md": body,    # lets the classifier and case body get the question
        "incident_id": "",
        "task_id": "",
        "agent_space_id": "",
        "execution_id": "",
        "report_url": "",
        "trace_url": "",
    }
    # support_logic.build_body() prepends `extra` as a "Additional context
    # from requester" block — perfect for stuffing the optional contact info.
    extra = f"Contact: {contact}" if contact else ""

    if card_message_id:
        threading.Thread(
            target=_create_worker,
            args=(card_message_id, ctx, severity, language, operator_name,
                  chat_id, dispatch_after, extra, locale),
            kwargs={"service_text": service_text, "issue_type": issue_type,
                    "category_text": category_text},
            daemon=True,
        ).start()
        msg = i18n.t(
            "case.create.pending_msg.dispatch" if dispatch_after
            else "case.create.pending_msg.create_only", locale)
        return _build_card_response(msg, _pending_card(severity, language,
                                                      dispatch_after=dispatch_after,
                                                      locale=locale))

    result = support_logic.create_case(
        ctx, platform=PLATFORM, severity=severity, language=language,
        extra=extra, operator_name=operator_name,
        service_text=service_text, issue_type=issue_type,
        category_text=category_text,
    )
    if dispatch_after and result.ok and chat_id:
        _dispatch_investigation_inline(chat_id, result.display_id, subject, body,
                                       operator_name, locale=locale)
    return _build_card_response(
        i18n.t("case.create.toast.created", locale),
        _create_result_card(result, severity, language, operator_name,
                            subject=subject, body=body,
                            dispatched=dispatch_after, locale=locale))


def _create_worker(card_message_id: str, ctx: dict,
                   severity: str, language: str, operator_name: str,
                   chat_id: str, dispatch_after: bool, extra: str,
                   locale: str = "zh", *,
                   service_text: str = "", issue_type: str = "",
                   category_text: str = "") -> None:
    locale = _normalize_locale(locale)
    try:
        result = support_logic.create_case(
            ctx, platform=PLATFORM, severity=severity, language=language,
            extra=extra, operator_name=operator_name,
            service_text=service_text, issue_type=issue_type,
            category_text=category_text,
        )
        # Body / subject for the result card
        subject = ctx.get("intent_summary", "")
        body = ctx.get("raw_text", "")
        if dispatch_after and result.ok and chat_id:
            _dispatch_investigation_inline(chat_id, result.display_id, subject,
                                           body, operator_name, locale=locale)
        new_card = _create_result_card(result, severity, language, operator_name,
                                       subject=subject, body=body,
                                       dispatched=dispatch_after, locale=locale)
    except Exception as e:
        logger.exception("case create worker crashed")
        new_card = _info_card(
            i18n.t("case.create.error_title", locale),
            i18n.t("case.create.internal_error", locale,
                   kind=type(e).__name__),  # Security: type only; detail → CloudWatch
            "red")
    try:
        feishu_utils.update_card(card_message_id, new_card)
    except Exception as e:
        logger.error("update_card failed: %s", e)


# ---------------------------------------------------------------------------
# Sync DevOps Agent investigation report to the linked AWS Support case.
# Triggered from the "📎 同步到案例" button on a report card whose
# investigation was kicked off by a "create case + dispatch" flow.
#
# ⚠️ **结果必须以一条新消息发出去，不许"就地改那张报告卡"**（2026-09-03 现网反馈：
#    「确实同步成功了，但是飞书里面没有任何的信息反馈」）。原来的写法是
#    `update_card(<报告卡的 message_id>, 结果卡)`，两处都错：
#
#      1. 载体不匹配就会静默失败。当时报告卡是一张 **v1** 卡（顶层 `elements`），
#         而这里的结果卡 / pending 卡是 **v2**（`"schema": "2.0"` + `body.elements`）。
#         往 v1 消息上 PATCH 一份 v2 正文，飞书**不报错也不渲染** —— 现网日志实证：
#         `add_communication` 成功、整个 invocation 里一条 `Feishu API non-zero` /
#         HTTP 错误都没有，用户屏幕上零变化。
#         ⚠️ 2026-09-05：报告卡已经换成 `_report_card_v2`（v1 只是被拒时的兜底），
#         所以"schema 对不上"这条**具体**成因不再成立；但下面第 2 条（业务错误码
#         只 warning）没变，PATCH 失败照样看不见 —— 所以结论不变：发新消息。
#      2. 就算渲染出来了也是错的：报告卡被结果卡**顶掉**，报告正文和那两个
#         presigned「查看完整报告 / 调查过程」链接一起没了。
#
#    这个 bug 能活这么久，是因为 `feishu_utils.call_openapi` 对业务错误码只
#    warning、不抛 —— 所以 `_sync_report_worker` 里那圈 try/except 对"API 说不行"
#    根本不生效（那是死代码）。修法有三条，缺一不可：
#      · 结果走 `send_card`（新消息 → 有通知、不可能看不见，也不动报告卡）；
#      · pending 只回 toast：webhook 下 toast 到不了客户端，`lambda_worker`
#        会把它补成一条文本（见那边 `_handle_card_action` 的 toast 兜底），
#        所以这句 toast 要带案例号，别用干巴巴的「正在同步…」；
#      · 发不出去要**显式判 code** 再退纯文本（`_tell_chat`），不许静默。
#
#    Slack 侧一直就是"发新消息"（`platforms/slack/app/support_flow.py`），
#    这次是飞书补齐对等，不是新发明。
# ---------------------------------------------------------------------------
def _handle_sync_report(chat_id: str, display_id: str, incident_id: str,
                        locale: str = "zh"
                        ) -> P2CardActionTriggerResponse:
    locale = _normalize_locale(locale)
    if not display_id or not incident_id:
        return _toast(i18n.t("case.toast.missing_id_or_incident", locale))

    # Idempotency: prevent double-add when Feishu retries the trigger.
    if not support_logic.claim_inflight(
            f"sync:{incident_id}:{display_id}"):
        return _toast(i18n.t("case.toast.syncing_in_progress", locale))

    # Pull the agent's summary + report URLs from the support context
    # row that report-handler wrote (under support#<incident_id>).
    ctx = support_logic.load_support_context(incident_id)
    if not ctx:
        return _toast(i18n.t("case.toast.report_expired", locale))

    if chat_id:
        threading.Thread(
            target=_sync_report_worker,
            args=(chat_id, display_id, ctx, locale),
            daemon=True,
        ).start()
        return _toast(i18n.t("case.pending.sync", locale,
                             display_id=display_id))

    # 卡片回调里拿不到 chat_id（正常点击不会走到这里）。此时唯一还能说话的通道是
    # trigger 响应本身 —— 同步做完直接把结果卡回过去，宁可慢几秒也不能没反馈。
    body = _build_sync_body(ctx)
    ok = case_management.add_communication(display_id, body)
    return _build_card_response(
        i18n.t("case.toast.synced", locale) if ok
        else i18n.t("case.toast.sync_failed", locale),
        _sync_result_card(display_id, ok, locale=locale),
    )


def _sync_report_worker(chat_id: str, display_id: str, ctx: dict,
                        locale: str = "zh") -> None:
    locale = _normalize_locale(locale)
    try:
        body = _build_sync_body(ctx)
        ok = case_management.add_communication(display_id, body)
        new_card = _sync_result_card(display_id, ok, locale=locale)
        fallback = i18n.t("case.sync.success_title" if ok
                          else "case.sync.fail_title", locale)
    except Exception as e:
        logger.exception("sync_report worker crashed")
        new_card = _info_card(
            i18n.t("case.sync.error_title", locale),
            i18n.t("case.create.internal_error", locale,
                   kind=type(e).__name__),  # Security: type only; detail → CloudWatch
            "red")
        fallback = i18n.t("case.sync.fail_title", locale)
    _tell_chat(chat_id, new_card, fallback)


def _tell_chat(chat_id: str, card: dict, fallback_text: str) -> None:
    """把一张卡发进会话，并且**确认飞书真的收下了**。

    `feishu_utils.send_card` 底下的 `call_openapi` 对业务错误码只 warning、不抛，
    所以"发失败"在调用方看来和成功一模一样 —— 正是上面那个 bug 的成因。这里显式
    判 `code`：卡片被拒就退一条纯文本（至少告诉用户成/败），纯文本也不行才记 error。
    `code` 缺省视为成功（飞书成功响应里 `code` 恒为 0，缺字段只会出现在测试替身里）。
    """
    try:
        resp = feishu_utils.send_card(chat_id=chat_id, card=card) or {}
        if resp.get("code", 0) == 0:
            return
        logger.error("sync result card rejected: code=%s", resp.get("code"))
    except Exception as e:
        logger.error("sync result card send failed: %s", type(e).__name__)
    try:
        resp = feishu_utils.send_text_to_chat(chat_id, fallback_text) or {}
        if resp.get("code", 0) != 0:
            logger.error("sync result text rejected: code=%s", resp.get("code"))
    except Exception as e:
        logger.error("sync result text failed: %s", type(e).__name__)


def _build_sync_body(ctx: dict) -> str:
    """Compose a comment that AWS Support engineers will see on the case,
    clearly marked as auto-generated by DevOps Agent so engineers know
    it's reference-only and not the customer's manual reply.

    Body language is intentionally English regardless of the bot UI
    locale — AWS Support engineers may be in any region and the case
    body is the durable artefact other engineers / case owners will read.
    """
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
    # AWS Support API caseBody / communicationBody hard limit is 8000 chars.
    if len(body) > 7900:
        body = body[:7900] + "\n\n[truncated — see report URL above for full content]"
    return body


def _sync_result_card(display_id: str, ok: bool, locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    if not ok:
        return _info_card(
            i18n.t("case.sync.fail_title", locale),
            i18n.t("case.sync.fail_body", locale, display_id=display_id),
            "red",
        )
    case_url = case_management._case_console_url(display_id)
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text",
                             "content": i18n.t("case.sync.success_title", locale)},
                   "template": "green"},
        "body": {"elements": [
            {"tag": "markdown",
             "content": i18n.t("case.sync.success_body", locale,
                               display_id=display_id)},
            _action_row([
                _open_url_button(i18n.t("case.sync.btn.open_case", locale),
                                 case_url, primary=True),
                _callback_button(i18n.t("case.sync.btn.detail", locale),
                                 {"action": "case_view",
                                  "case_display_id": display_id}),
            ]),
        ]},
    }


# ---------------------------------------------------------------------------
# DevOps Agent investigation kicked off from a case-create flow
# ---------------------------------------------------------------------------
def _dispatch_investigation_inline(chat_id: str, display_id: str,
                                   subject: str, body: str,
                                   operator_name: str,
                                   locale: str = "zh") -> None:
    """Fire-and-forget dispatch from inside the create flow. Logs but doesn't
    surface errors here — the success card mentions the investigation kicked
    off; failure is recoverable by the user clicking the button on the
    success card again."""
    try:
        _dispatch_for_case(chat_id, display_id, subject, body, locale=locale)
    except Exception as e:
        logger.error("Inline investigation dispatch failed: %s", e)


def _dispatch_investigation_for_case(chat_id: str, display_id: str,
                                     subject: str, body: str,
                                     card_message_id: str,
                                     locale: str = "zh"
                                     ) -> P2CardActionTriggerResponse:
    """Action handler for the 'Dispatch investigation' button on the success
    card. Synchronous-style: returns either a confirmation or a follow-up card.
    """
    locale = _normalize_locale(locale)
    if not chat_id or not display_id:
        return _toast(i18n.t("case.toast.missing_chat_or_case", locale))
    if not support_logic.claim_inflight(
            card_message_id or f"dispatch_for_case:{display_id}"):
        return _toast(i18n.t("case.toast.processing", locale))

    result = _dispatch_for_case(chat_id, display_id, subject, body,
                                locale=locale)
    if result.get("ok"):
        return _toast(i18n.t("case.toast.dispatch_started", locale))
    return _toast(i18n.t("case.toast.dispatch_failed", locale,
                         detail=result.get("body", "")[:60]))


def _dispatch_for_case(chat_id: str, display_id: str,
                       subject: str, body: str,
                       locale: str = "zh") -> dict:
    """Shared dispatch implementation used by both the form's
    'create + dispatch' path and the success card's 'dispatch after' button.

    Records the originating chat in DDB so the report-handler routes the
    eventual investigation report back into the same Feishu thread.

    ── 2026-09-03：从 Fargate 那条老路径切到 IM Lambda 路径 ─────────────────────
    以前这里走 `shared.devops_agent.create_investigation` + `put_new_event` +
    `link_incident`，那一套是给 Fargate 长连接时代写的，切到 webhook 之后有三个问题：
      1. `link_incident()` **要求先有一行 `event#`**（Fargate 时代由 `put_event` 写），
         webhook 路径上没有，所以要先造一个合成 `event#` 行来凑；
      2. 派发完只发一条**纯文本**「已发起」，没有进度卡 —— 用户在案例流程里看不到
         调查跑到哪了，而 `/调查` 那条路径早就有实时刷新的卡片了（体验不对等）；
      3. 依赖 `DEFAULT_INVESTIGATION_ACCOUNT_ID` 环境变量，没配就静默跳过整个调查
         （用户点了「开案例 + 起调查」，案例开了、调查没起，也没人告诉他）。

    现在与 `platforms/feishu/caps.py::investigate` 完全同款：
    `start_investigation` → 发 `dispatch_card` → `put_im_task`（进度 Lambda 每分钟
    PATCH 这张卡）→ `link_im_investigation`（最终报告卡回到这个会话）。

    `incident_id` 仍然是 `feishu-case-<display_id>`：report_handler 的
    `_extract_case_display_id()` 靠这个形状认出「这次调查是某个案例带起来的」，
    从而在报告卡上给出「同步到案例」按钮。**别改成 `feishu-<event_id>`**。
    """
    locale = _normalize_locale(locale)
    from core import devops_agent
    from platforms.feishu import im_cards

    incident_id = f"feishu-case-{display_id}"
    # English user_text is intentional — the agent's reasoning prompt
    # should stay in English regardless of UI locale; the agent chooses
    # its OUTPUT language separately. (Mirrors the report.header.* keys
    # design where the agent body stays English-leaning.)
    user_text = (
        f"AWS Support case {display_id} was just opened with subject:\n"
        f"  {subject}\n\n"
        f"User's question:\n{body}\n\n"
        f"Please investigate this issue in parallel with AWS Support so the "
        f"customer gets a faster diagnostic. Reference the case as needed."
    )

    # 幂等：一个案例只起一次调查。`imtask#` 那行的 TTL 覆盖整个调查生命周期，比
    # `claim_inflight` 的短时效在飞（几秒）更可靠 —— 用户隔一分钟再点一次也拦得住。
    try:
        if ddb_state.get_im_task(incident_id):
            logger.info("Investigation already dispatched for case %s — skipping",
                        display_id)
            return {"ok": True, "status": 200, "body": "duplicate-skipped",
                    "task_id": None}
    except Exception as e:
        # 查不到就当没派过 —— 宁可重复派一次，也不能因为 DDB 抖动就把调查吞掉。
        logger.warning("get_im_task for case dispatch failed: %s", e)

    title = f"[{PLATFORM.capitalize()}#case-{display_id}] {subject[:50]}"
    raw_result = devops_agent.start_investigation(
        title=title, description=user_text, priority="MEDIUM",
        source=f"notiops-im-{PLATFORM}-case",
    )
    if raw_result.get("error"):
        err = str(raw_result.get("message") or raw_result["error"])
        logger.error("Investigation dispatch for case %s failed: %s",
                     display_id, raw_result["error"])
        # 与老实现同一个返回形状（`{ok, status, body, task_id}`）—— 上游 toast 处理
        # 认的是这个，改形状会静默丢掉错误提示。
        return {"ok": False, "status": 0, "body": err, "task_id": None}

    task_id = raw_result.get("task_id") or ""
    home = raw_result.get("console_home") or ""
    deep = raw_result.get("console_url") or ""
    result = {"ok": True, "status": 200, "body": "", "task_id": task_id}

    # 进度卡（取代原来那条纯文本）—— 与 `/调查` 那条路径同一张卡。
    body_text = i18n.t("case.dispatch.inline_chat_msg", locale,
                       display_id=display_id)
    card_message_id = ""
    try:
        resp = feishu_utils.send_card(
            chat_id,
            im_cards.dispatch_card(body_text, locale, deep_link=deep, home=home,
                                   state="dispatched"))
        card_message_id = im_cards.message_id_of(resp)
    except Exception as e:
        logger.error("case dispatch card send failed: %s", type(e).__name__)
    if not card_message_id:
        # 卡片发不出去 → 没有 PATCH 落点。**不落 `imtask#`**（否则进度 Lambda 会对着
        # 空 message_id 重试 30 分钟）。调查本身已经起来了，退纯文本把这件事说清楚。
        logger.error("case %s: dispatch card failed; falling back to text",
                     display_id)
        line = body_text
        if deep:
            line += f"\n{i18n.t('progress.btn.open_link', locale)}: {deep}"
        elif home:
            line += f"\n{i18n.t('progress.btn.open_home', locale)}: {home}"
        feishu_utils.send_text_to_chat(chat_id, line)
    else:
        ddb_state.put_im_task(
            incident_id,
            platform=PLATFORM, chat_id=chat_id, message_id=card_message_id,
            locale=locale, account_id=raw_result.get("account_id") or "",
            task_id=task_id,
            execution_id=raw_result.get("execution_id") or "",
            agent_space_id=raw_result.get("agent_space_id") or "",
            title=title, console_url=deep, console_home=home,
        )

    # 第二行路由：最终报告卡走 EventBridge → notiops-devops-callback →
    # report_handler，它只认 `incident#` / `task#`。少了这一步，进度卡会一路刷到
    # 「已完成」，但报告只躺在 S3 里 —— 而且案例流程还会因此失去「同步到案例」按钮。
    try:
        ddb_state.link_im_investigation(
            incident_id, task_id, platform=PLATFORM, chat_id=chat_id,
            root_message_id=card_message_id, locale=locale,
            raw_text=user_text[:1000],
        )
    except Exception as e:
        logger.warning("link_im_investigation for case dispatch failed: %s", e)

    logger.info("Dispatched investigation for case %s incident_id=%s task_id=%s",
                display_id, incident_id, task_id)
    return result


def _handle_reply_submit(display_id: str, body: str,
                         card_message_id: str,
                         internal_id: str = "",
                         locale: str = "zh"
                         ) -> P2CardActionTriggerResponse:
    locale = _normalize_locale(locale)
    key = f"reply:{internal_id or display_id}:{card_message_id}"
    if not support_logic.claim_inflight(key):
        return _toast(i18n.t("case.toast.processing", locale))

    if card_message_id:
        threading.Thread(
            target=_reply_worker,
            args=(card_message_id, display_id, body, internal_id, locale),
            daemon=True,
        ).start()
        return _build_card_response(
            i18n.t("case.toast.sending", locale),
            _pending_simple_card(i18n.t("case.pending.reply", locale),
                                 locale=locale))

    ok = case_management.add_communication(display_id, body,
                                           internal_id=internal_id or None)
    return _build_card_response(
        i18n.t("case.toast.sent", locale) if ok
        else i18n.t("case.toast.send_failed", locale),
        _reply_result_card(display_id, body, ok, locale=locale),
    )


def _send_reply(chat_id: str, display_id: str, body: str,
                internal_id: str = "", locale: str = "zh") -> None:
    """Inline-send path used when the user passes the reply body in the
    same message (e.g. '回复 12345 已重启'). No card form interaction."""
    locale = _normalize_locale(locale)
    ok = case_management.add_communication(display_id, body,
                                           internal_id=internal_id or None)
    feishu_utils.send_card(chat_id=chat_id,
                           card=_reply_result_card(display_id, body, ok,
                                                   locale=locale))


def _reply_worker(card_message_id: str, display_id: str, body: str,
                  internal_id: str, locale: str = "zh") -> None:
    locale = _normalize_locale(locale)
    try:
        ok = case_management.add_communication(display_id, body,
                                               internal_id=internal_id or None)
        new_card = _reply_result_card(display_id, body, ok, locale=locale)
    except Exception as e:
        logger.exception("reply worker crashed")
        new_card = _info_card(
            i18n.t("case.reply.error_title", locale),
            i18n.t("case.create.internal_error", locale,
                   kind=type(e).__name__),  # Security: type only; detail → CloudWatch
            "red")
    try:
        feishu_utils.update_card(card_message_id, new_card)
    except Exception as e:
        logger.error("update_card failed: %s", e)


def _handle_resolve(display_id: str,
                    card_message_id: str,
                    internal_id: str = "",
                    locale: str = "zh"
                    ) -> P2CardActionTriggerResponse:
    locale = _normalize_locale(locale)
    if not display_id and not internal_id:
        return _toast(i18n.t("case.toast.missing_case_id", locale))
    key = f"resolve:{internal_id or display_id}:{card_message_id}"
    if not support_logic.claim_inflight(key):
        return _toast(i18n.t("case.toast.processing", locale))

    if card_message_id:
        threading.Thread(
            target=_resolve_worker,
            args=(card_message_id, display_id, internal_id, locale),
            daemon=True,
        ).start()
        return _build_card_response(
            i18n.t("case.toast.closing", locale),
            _pending_simple_card(i18n.t("case.pending.resolve", locale),
                                 locale=locale))

    final = case_management.resolve_case(display_id,
                                         internal_id=internal_id or None)
    return _build_card_response(
        i18n.t("case.toast.closed", locale) if final
        else i18n.t("case.toast.close_failed", locale),
        _resolve_result_card(display_id, final, locale=locale))


def _resolve_worker(card_message_id: str, display_id: str,
                    internal_id: str, locale: str = "zh") -> None:
    locale = _normalize_locale(locale)
    try:
        final = case_management.resolve_case(display_id,
                                             internal_id=internal_id or None)
        new_card = _resolve_result_card(display_id, final, locale=locale)
    except Exception as e:
        logger.exception("resolve worker crashed")
        new_card = _info_card(
            i18n.t("case.resolve.error_title", locale),
            i18n.t("case.create.internal_error", locale,
                   kind=type(e).__name__),  # Security: type only; detail → CloudWatch
            "red")
    try:
        feishu_utils.update_card(card_message_id, new_card)
    except Exception as e:
        logger.error("update_card failed: %s", e)


# ===========================================================================
# Card builders (Feishu v2 schema)
# ===========================================================================
#: 「不指定，你们自己判断」那一项的值。用哨兵而不是空串：飞书 `select_static` 的
#: option value 为空时表单回传的形态不确定，而空串又与"用户没选"无法区分。
#: 提交时 `_picked_service_code()` 把它折回空串。
SERVICE_AUTO = "__auto__"


def _service_select_elements(locale: str) -> list[dict]:
    """常用服务选择器（拿不到目录就换成一句说明，不给空选择器）。

    ⚠️ 目录读不到（`describe_services` 要 Business/Enterprise 支持计划）时**不许**留
    一个只有"自动判断"的选择器：那看着像功能坏了，而客户其实还有下面的自由文本。
    """
    try:
        services = case_classifier.popular_services()
    except Exception as e:                            # noqa: BLE001
        # 面板不能因为拉目录失败就打不开 —— 案例是客户出事时才开的东西。
        logger.warning("popular_services failed: %s", type(e).__name__)
        services = []
    if not services:
        return [{"tag": "markdown",
                 "content": i18n.t("case.create.service_catalog_unavailable",
                                   locale)}]
    options = [{"text": {"tag": "plain_text",
                         "content": i18n.t("case.create.service_select_auto",
                                           locale)},
                "value": SERVICE_AUTO}]
    options += [{"text": {"tag": "plain_text", "content": s["name"]},
                 "value": s["code"]} for s in services]
    return [
        {"tag": "markdown",
         "content": i18n.t("case.create.service_select_label", locale)},
        {"tag": "select_static",
         "name": "service_select",
         "placeholder": {"tag": "plain_text",
                         "content": i18n.t(
                             "case.create.service_select_placeholder", locale)},
         # ⚠️ `initial_index` 是 **1-based**（同款注释见下面 issue_type_select）：
         # 「自动判断」是第一项，所以是 1 —— 写 0 会默认选中第一个真实服务，
         # 等于替客户瞎猜一个服务，比不选更糟。
         "initial_index": 1,
         "options": options,
         "type": "default",
         "width": "fill",
         # 留成非必填：客户可以完全不碰这一栏（默认就是"自动判断"）。
         "required": False},
    ]


def _picked_service_code(dropdown: str, free_text: str) -> str:
    """选择器优先、自由文本兜底 —— 汇成一个交给 `resolve_service` 的字符串。

    选择器给的是真实 code（第 1 级精确命中），自由文本走模糊反查；两个都空 = 分类器
    自动判断（历史行为）。
    """
    picked = (dropdown or "").strip()
    if picked and picked != SERVICE_AUTO:
        return picked
    return (free_text or "").strip()


def picked_service_code(dropdown: str, free_text: str) -> str:
    """`_picked_service_code` 的公开别名 —— 给另一个面板（`support_flow`）用。"""
    return _picked_service_code(dropdown, free_text)


def service_and_type_elements(locale: str) -> list[dict]:
    """「服务名称」+「类别」+「案例类型」这一组表单元素 —— **两个开案例面板共用同一份**。

    为什么抽出来:开案例有**两个**入口 —— `/案例` 面板(`_create_form_card`)和调查报告卡
    上的「🆘 升级到 AWS Support」(`support_flow._form_card`)。这两项当初只加在前一个上,
    后一个就少了 —— 复制一份的话下次改动照样长歪(选项不同 / 默认值不同 / 目录挂了的
    退化行为不同),而这种不一致**不报错**,只是同一个操作从两个入口进去开出不同的案例。
    所以两边都调这一个函数,并有测试钉住"两个面板都调了它"。

    四件东西按客户填写顺序:常用服务选择器 → 长尾自由文本 → 类别 → 案例类型。
    「类别」是**手打**而不是像 web 那样跟着服务联动的下拉:联动要在面板中途回一趟服务端
    重绘卡片,而**表单容器里的数据只在点提交按钮时才回调**(飞书官方文档原话:"在表单
    容器中,输入框组件的数据为异步提交的形式,即用户填写完所有表单项后,点击表单容器中
    绑定提交事件的按钮,才会将包括输入框组件的所有数据一次回调至开发者的服务端"),
    也就是说选择器自己的回调拿不到用户已经打进去的主题/描述,中途重绘就等于把它们清空。
    所以两端统一"手打 + 服务端在该服务名下反查",理由与实测数据见
    `core.case_classifier.resolve_category_detail`。
    """
    it_labels = issue_type_labels(locale)
    issue_type_options = [
        {"text": {"tag": "plain_text", "content": it_labels[c]},
         "value": c}
        for c in ISSUE_TYPE_CODES
    ]
    return [
        # 服务名称 —— 常用**选择器** + 长尾**自由文本**，两个都不填就交给分类器自动
        # 判断。选择器里只放二十条常用的：真实目录 323 条塞不进卡片选择器。选中的
        # value 是真实 code（`popular_services()` 从现网目录反查），提交时原样交给
        # `resolve_service` 精确命中。匹配不上（自由文本那条路）就退回分类器并在结果
        # 卡上说明（不静默）。
        *_service_select_elements(locale),
        {"tag": "markdown",
         "content": i18n.t("case.create.service_label", locale)},
        {"tag": "input",
         "name": "service_text",
         "placeholder": {"tag": "plain_text",
                         "content": i18n.t("case.create.service_placeholder",
                                           locale)},
         "default_value": "",
         "max_length": 100,
         "required": False,
         "width": "fill"},
        # 类别 —— 留空就按服务挑一个通用类别（`resolve_category_detail`），填了就在
        # **该服务名下**反查，所以怎么填都不可能拼出 CreateCase 拒收的非法组合。
        {"tag": "markdown",
         "content": i18n.t("case.create.category_label", locale)},
        {"tag": "input",
         "name": "category_text",
         "placeholder": {"tag": "plain_text",
                         "content": i18n.t("case.create.category_placeholder",
                                           locale)},
         "default_value": "",
         "max_length": 100,
         "required": False,
         "width": "fill"},
        # 案例类型 —— 与 web 端案例面板同三项（`core.support_logic.ISSUE_TYPE_CODES`）。
        {"tag": "markdown",
         "content": i18n.t("case.create.issue_type_label", locale)},
        {"tag": "select_static",
         "name": "issue_type_select",
         "placeholder": {"tag": "plain_text",
                         "content": i18n.t("case.create.issue_type_placeholder",
                                           locale)},
         # ⚠️ 飞书 `initial_index` 是 **1-based**（见
         # platforms/feishu/app/main.py:1321 的同款注释）——
         # 写成 0-based 会默认选中下一项，正是本次要修的"类型猜错"。
         "initial_index": ISSUE_TYPE_CODES.index(DEFAULT_ISSUE_TYPE) + 1,
         "options": issue_type_options,
         "type": "default",
         "width": "fill",
         "required": True},
    ]


def _create_form_card(subject: str = "", locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    # Language picker labels are deliberately bilingual / native form
    # (Chinese / 中文, Japanese / 日本語) — they're the language the AWS
    # support engineer should reply in, not the bot UI locale. So we
    # keep using the module-level LANGUAGE_LABELS dict regardless.
    language_options = [
        {"text": {"tag": "plain_text", "content": LANGUAGE_LABELS[c]},
         "value": c}
        for c in LANGUAGE_CODES
    ]
    sev_labels = severity_labels(locale)
    severity_options = [
        {"text": {"tag": "plain_text", "content": sev_labels[c]},
         "value": c}
        for c in SEVERITY_CODES
    ]
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {
            "title": {"tag": "plain_text",
                      "content": i18n.t("case.create.title", locale)},
            "template": "red",
        },
        "body": {
            "elements": [
                {"tag": "markdown",
                 "content": i18n.t("case.create.intro", locale)},
                {"tag": "form",
                 "name": "case_create_form",
                 "elements": [
                     {"tag": "markdown",
                      "content": i18n.t("case.create.subject_label", locale)},
                     {"tag": "input",
                      "name": "subject",
                      "placeholder": {"tag": "plain_text",
                                      "content": i18n.t(
                                          "case.create.subject_placeholder",
                                          locale)},
                      "default_value": subject,
                      "max_length": 250,
                      "required": True,
                      "width": "fill"},
                     {"tag": "markdown",
                      "content": i18n.t("case.create.body_label", locale)},
                     {"tag": "input",
                      "input_type": "multiline_text",
                      "name": "body",
                      "placeholder": {"tag": "plain_text",
                                      "content": i18n.t(
                                          "case.create.body_placeholder",
                                          locale)},
                      "default_value": "",
                      "max_length": 1000,
                      "rows": 6,
                      "required": True,
                      "width": "fill"},
                     # 服务名称 + 案例类型 —— 与调查报告卡上的「🆘 升级到 AWS
                     # Support」面板**共用**同一份控件，两个入口不会长歪。
                     *service_and_type_elements(locale),
                     {"tag": "markdown",
                      "content": i18n.t("case.create.severity_label", locale)},
                     {"tag": "select_static",
                      "name": "severity_select",
                      "placeholder": {"tag": "plain_text",
                                      "content": i18n.t(
                                          "case.create.severity_placeholder",
                                          locale)},
                      "initial_index": SEVERITY_CODES.index(DEFAULT_SEVERITY) + 1,
                      "options": severity_options,
                      "type": "default",
                      "width": "fill",
                      "required": True},
                     {"tag": "markdown",
                      "content": i18n.t("case.create.language_label", locale)},
                     {"tag": "select_static",
                      "name": "language_select",
                      "placeholder": {"tag": "plain_text",
                                      "content": i18n.t(
                                          "case.create.language_placeholder",
                                          locale)},
                      "initial_index": LANGUAGE_CODES.index(DEFAULT_LANGUAGE) + 1,
                      "options": language_options,
                      "type": "default",
                      "width": "fill",
                      "required": True},
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
                     # Primary actions: two equal-width submit buttons.
                     {"tag": "column_set",
                      "columns": [
                          {"tag": "column", "width": "weighted", "weight": 1,
                           "elements": [
                               {"tag": "button",
                                "name": "btn_create_only",
                                "text": {"tag": "plain_text",
                                         "content": i18n.t(
                                             "case.create.btn.create_only",
                                             locale)},
                                "type": "primary",
                                "form_action_type": "submit",
                                "behaviors": [{"type": "callback",
                                               "value": {"action": "case_create_submit"}}]},
                           ]},
                          {"tag": "column", "width": "weighted", "weight": 1,
                           "elements": [
                               {"tag": "button",
                                "name": "btn_create_with_dispatch",
                                "text": {"tag": "plain_text",
                                         "content": i18n.t(
                                             "case.create.btn.create_with_dispatch",
                                             locale)},
                                "type": "primary",
                                "form_action_type": "submit",
                                "behaviors": [{"type": "callback",
                                               "value": {"action": "case_create_submit_with_dispatch"}}]},
                           ]},
                      ]},
                     {"tag": "markdown",
                      "content": i18n.t("case.create.dispatch_hint", locale)},
                     # Secondary actions on a single row: reset + cancel.
                     # Both must live INSIDE the form so the row aligns
                     # with the primary buttons above. cancel is a regular
                     # callback (not a form_action_type) so it doesn't
                     # submit the form values.
                     {"tag": "column_set",
                      "columns": [
                          {"tag": "column", "width": "weighted", "weight": 1,
                           "elements": [
                               {"tag": "button",
                                "name": "btn_reset",
                                "text": {"tag": "plain_text",
                                         "content": i18n.t(
                                             "case.create.btn.reset", locale)},
                                "type": "default",
                                "form_action_type": "reset"},
                           ]},
                          {"tag": "column", "width": "weighted", "weight": 1,
                           "elements": [
                               {"tag": "button",
                                "name": "btn_cancel",
                                "text": {"tag": "plain_text",
                                         "content": i18n.t(
                                             "case.create.btn.cancel", locale)},
                                "type": "default",
                                "behaviors": [{"type": "callback",
                                               "value": {"action": "case_create_cancel"}}]},
                           ]},
                      ]},
                 ]},
                {"tag": "markdown",
                 "content": i18n.t("case.create.account_note", locale)},
            ],
        },
    }


def _create_result_card(result: support_logic.CaseResult, severity: str,
                        language: str, operator_name: str,
                        subject: str = "", body: str = "",
                        dispatched: bool = False,
                        locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    if result.ok:
        cls = result.classification or {}
        block = ""
        if cls.get("serviceCode") or cls.get("categoryCode"):
            block = i18n.t("case.create.classification_block", locale,
                           service=cls.get("serviceCode", ""),
                           # 类别后面跟一句"你指定"还是"自动挑选"，四张结果卡同口径
                           # （`support_logic.category_display`）。
                           category=support_logic.category_display(cls, locale),
                           # 显示本地化标签而不是 `technical` 这种 API code ——
                           # 用户在面板里选的是标签。
                           issue_type=issue_type_label(
                               cls.get("issueType", ""), locale))
        # 用户填了服务名但目录里没有 → **必须说出来**。静默忽略最坑：用户以为自己
        # 指定了服务，案例却落在分类器挑的（可能是 general-info）那条上。
        if cls.get("serviceUnmatched"):
            block += i18n.t("case.create.service_unmatched_block", locale,
                            text=str(cls["serviceUnmatched"]))
        # 类别同理：填了但这个服务名下没有 → 说清用的是哪个，别让人以为按自己填的走了。
        if cls.get("categoryUnmatched"):
            block += i18n.t("case.create.category_unmatched_block", locale,
                            text=str(cls["categoryUnmatched"]),
                            service=cls.get("serviceCode", ""),
                            category=cls.get("categoryCode", ""))
        # ID first so the user can copy it without scrolling, subject second
        # for context, link last as the primary action target.
        subject_block = (
            i18n.t("case.create.subject_block", locale, subject=subject.strip())
            if subject and subject.strip() else "")
        sev_label = severity_label(severity, locale)
        lang_label = LANGUAGE_LABELS.get(language, language)
        elements: list[dict] = [
            {"tag": "markdown",
             "content": (
                 i18n.t("case.create.case_id_block", locale,
                        display_id=result.display_id)
                 + subject_block + "\n\n"
                 + i18n.t("case.create.case_link_block", locale,
                          url=result.case_url))},
            {"tag": "hr"},
            {"tag": "markdown",
             "content": (
                 i18n.t("case.create.severity_field", locale,
                        severity=sev_label, language=lang_label)
                 + block + "\n\n"
                 + i18n.t("case.create.support_will_reply", locale))},
        ]
        # If we already kicked off the investigation when the case was
        # created, say so. Otherwise the card ends here: the case is open and
        # the only two useful actions are "look at it" and "see all of them".
        #
        # ⚠️ There is deliberately **no** "start an Agent investigation" button
        # any more (removed 2026-09-02). Opening a case and investigating are
        # two separate decisions; offering the second one on the success card of
        # the first made the card read like the case wasn't enough. Users who do
        # want an investigation say so (`/调查` / 「帮我调查…」) — that path is
        # unchanged. `case_create_dispatch_after` stays wired up in the action
        # handler so cards already sitting in a chat don't dead-click.
        if dispatched:
            elements.append({"tag": "markdown",
                             "content": i18n.t(
                                 "case.create.dispatched_note", locale)})
        elements.append(_action_row([
            _open_url_button(i18n.t("case.create.btn.open_case", locale),
                             result.case_url, primary=True),
            _callback_button(i18n.t("case.create.btn.my_cases", locale),
                             {"action": "case_list_open"}),
        ]))
        return {
            "schema": "2.0",
            "config": card_config(streaming_mode=False),
            "header": {"title": {"tag": "plain_text",
                                 "content": i18n.t(
                                     "case.create.success_title", locale)},
                       "template": "green"},
            "body": {"elements": elements},
        }
    code = result.error_code or "Error"
    if code == "SubscriptionRequiredException":
        hint = i18n.t("case.create.fail_subscription", locale)
    else:
        hint = (result.error_message or "")[:300]
    return _info_card(
        i18n.t("case.create.fail_title", locale, code=code),
        hint, "red")


def _list_card(cases: list[CaseSummary], status_filter: str = "recent",
               locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    console_url = case_management.SUPPORT_CONSOLE_LIST_URL
    label = _filter_label(status_filter, locale)
    if not cases:
        empty_key = _FILTER_EMPTY_KEYS.get(status_filter,
                                           "case.list.empty.default")
        empty_msg = i18n.t(empty_key, locale)
        return {
            "schema": "2.0",
            "config": card_config(streaming_mode=False),
            "header": {"title": {"tag": "plain_text",
                                 "content": i18n.t(
                                     "case.list.title_with_label", locale,
                                     label=label)},
                       "template": "grey"},
            "body": {"elements": [
                {"tag": "markdown", "content": empty_msg},
                _filter_quick_row(status_filter, locale),
                _action_row([_open_url_button(
                    i18n.t("case.list.btn.console_all", locale),
                    console_url, primary=True)]),
            ]},
        }
    elements: list[dict] = [{
        "tag": "markdown",
        "content": _bold(i18n.t("case.list.subtotal", locale,
                                label=label, count=len(cases))),
    }]
    for c in cases:
        elements.append({"tag": "hr"})
        sev_emoji = {"critical": "🟣", "urgent": "🔴", "high": "🟠",
                     "normal": "🟡", "low": "🟢"}.get(c.severity, "⚪")
        # Status badge — visually distinguish resolved/closed from active
        # cases at a glance.
        is_resolved = c.status.startswith("resolved") or c.status == "closed"
        status_badge = (i18n.t("case.list.status.resolved", locale)
                        if is_resolved
                        else i18n.t("case.list.status.active", locale,
                                    status=c.status))
        subject_text = (_escape_md(c.subject)
                        or i18n.t("case.list.no_subject", locale))
        sev_label = severity_label(c.severity, locale)
        meta_line = i18n.t(
            "case.list.row_meta", locale,
            date=_short_date(c.created_at),
            submitter=(c.submitted_by
                       or i18n.t("case.list.unknown_submitter", locale)))
        body_md = (
            f"**{sev_emoji} {subject_text}**\n"
            f"`{c.display_id}` · {status_badge} · {sev_label}\n"
            f"{meta_line}"
        )
        if c.recent_communication:
            body_md += f"\n\n> {_escape_md(c.recent_communication)}"
        elements.append({"tag": "markdown", "content": body_md})
        action_val = {"case_display_id": c.display_id,
                      "case_internal_id": c.internal_id}
        # Hide the close button for already-resolved cases (idempotent on
        # the API side, but it's noisy in the UI).
        actions = [
            _callback_button(i18n.t("case.list.btn.detail", locale),
                             {"action": "case_view", **action_val}),
            _callback_button(i18n.t("case.list.btn.reply", locale),
                             {"action": "case_reply_form", **action_val}),
            _open_url_button(i18n.t("case.list.btn.open_case", locale),
                             c.case_url),
        ]
        if not is_resolved:
            actions.append(_callback_button(
                i18n.t("case.list.btn.close", locale),
                {"action": "case_resolve_confirm", **action_val},
                danger=True,
            ))
        elements.append(_action_row(actions))
    # Footer: quick filter shortcuts + link to the full Support console
    # list so users can dig into older / filtered cases beyond the 5-row
    # preview.
    elements.append({"tag": "hr"})
    elements.append({
        "tag": "markdown",
        "content": i18n.t("case.list.quick_filter_header", locale),
    })
    elements.append(_filter_quick_row(status_filter, locale))
    elements.append({
        "tag": "markdown",
        "content": i18n.t("case.list.see_more_hint", locale),
    })
    elements.append(_action_row([
        _open_url_button(i18n.t("case.list.btn.console_all", locale),
                         console_url, primary=True),
    ]))
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text",
                             "content": i18n.t("case.list.card_title", locale)},
                   "template": "blue"},
        "body": {"elements": elements},
    }


def _view_card(c: CaseSummary, comms: list[Communication],
               locale: str = "zh") -> dict:
    """Detail card: case meta + recent communications + action buttons."""
    locale = _normalize_locale(locale)
    sev_label = severity_label(c.severity, locale)
    head_md = i18n.t(
        "case.view.head_block", locale,
        subject=_escape_md(c.subject) or i18n.t("case.list.no_subject", locale),
        display_id=c.display_id,
        status=c.status,
        severity=sev_label,
        service=c.service_code,
        category=c.category_code,
        created=_short_date(c.created_at),
        submitter=c.submitted_by or i18n.t("case.list.unknown_submitter", locale),
    )
    elements: list[dict] = [{"tag": "markdown", "content": head_md},
                            {"tag": "hr"}]
    if not comms:
        elements.append({"tag": "markdown",
                         "content": i18n.t("case.view.no_replies", locale)})
    else:
        elements.append({"tag": "markdown",
                         "content": _bold(i18n.t(
                             "case.view.recent_replies_header", locale,
                             count=len(comms)))})
        for cm in comms:
            who = (i18n.t("case.view.who_aws", locale) if cm.is_aws
                   else i18n.t("case.view.who_customer", locale,
                               name=(cm.submitted_by or i18n.t(
                                   "case.view.who_customer_default", locale))))
            ts = _short_date(cm.submitted_at)
            preview = _escape_md(_trim(cm.body, 800))
            elements.append({
                "tag": "markdown",
                "content": i18n.t("case.view.reply_block", locale,
                                  who=who, ts=ts, body=preview),
            })
    elements.append({"tag": "hr"})
    is_resolved = c.status.startswith("resolved") or c.status == "closed"
    action_val = {"case_display_id": c.display_id,
                  "case_internal_id": c.internal_id}
    actions = [
        _callback_button(i18n.t("case.view.btn.add_reply", locale),
                         {"action": "case_reply_form", **action_val},
                         primary=True),
        _open_url_button(i18n.t("case.view.btn.open_console", locale),
                         c.case_url),
    ]
    if not is_resolved:
        actions.append(_callback_button(
            i18n.t("case.view.btn.close", locale),
            {"action": "case_resolve_confirm", **action_val},
            danger=True,
        ))
    elements.append(_action_row(actions))
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text",
                             "content": i18n.t("case.view.title", locale,
                                               display_id=c.display_id)},
                   "template": "blue"},
        "body": {"elements": elements},
    }


def _reply_form_card(display_id: str, internal_id: str = "",
                     locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    submit_value = {"action": "case_reply_submit",
                    "case_display_id": display_id,
                    "case_internal_id": internal_id}
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text",
                             "content": i18n.t("case.reply.title", locale,
                                               display_id=display_id)},
                   "template": "blue"},
        "body": {"elements": [
            {"tag": "markdown",
             "content": i18n.t("case.reply.intro", locale)},
            {"tag": "form",
             "name": "case_reply_form",
             "elements": [
                 {"tag": "input",
                  "input_type": "multiline_text",
                  "name": "reply_body",
                  "placeholder": {"tag": "plain_text",
                                  "content": i18n.t(
                                      "case.reply.body_placeholder", locale)},
                  "default_value": "",
                  "max_length": 1000,
                  "rows": 5,
                  "required": True,
                  "width": "fill"},
                 {"tag": "column_set",
                  "columns": [
                      {"tag": "column", "width": "weighted", "weight": 2,
                       "elements": [{
                           "tag": "button",
                           "name": "btn_reply_send",
                           "text": {"tag": "plain_text",
                                    "content": i18n.t(
                                        "case.reply.btn.send", locale)},
                           "type": "primary",
                           "form_action_type": "submit",
                           "behaviors": [{"type": "callback",
                                          "value": submit_value}],
                       }]},
                      {"tag": "column", "width": "weighted", "weight": 1,
                       "elements": [{
                           "tag": "button",
                           "name": "btn_reply_reset",
                           "text": {"tag": "plain_text",
                                    "content": i18n.t(
                                        "case.reply.btn.reset", locale)},
                           "type": "default",
                           "form_action_type": "reset",
                       }]},
                  ]},
             ]},
        ]},
    }


def _reply_result_card(display_id: str, body: str, ok: bool,
                       locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    if not ok:
        return _info_card(
            i18n.t("case.reply.fail_title", locale),
            i18n.t("case.reply.fail_body", locale, display_id=display_id),
            "red",
        )
    case_url = case_management._case_console_url(display_id)
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text",
                             "content": i18n.t("case.reply.success_title",
                                               locale)},
                   "template": "green"},
        "body": {"elements": [
            {"tag": "markdown",
             "content": i18n.t("case.reply.success_intro", locale,
                               display_id=display_id)},
            {"tag": "markdown",
             "content": f"> {_escape_md(_trim(body, 600))}"},
            _action_row([
                _open_url_button(i18n.t("case.reply.btn.open_console", locale),
                                 case_url),
                _callback_button(i18n.t("case.reply.btn.detail", locale),
                                 {"action": "case_view",
                                  "case_display_id": display_id}),
            ]),
        ]},
    }


def _resolve_confirm_card(display_id: str, internal_id: str = "",
                          locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    action_val = {"case_display_id": display_id,
                  "case_internal_id": internal_id}
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text",
                             "content": i18n.t("case.resolve.confirm_title",
                                               locale)},
                   "template": "orange"},
        "body": {"elements": [
            {"tag": "markdown",
             "content": i18n.t("case.resolve.confirm_body", locale,
                               display_id=display_id)},
            _action_row([
                _callback_button(i18n.t("case.resolve.btn.confirm", locale),
                                 {"action": "case_resolve_yes", **action_val},
                                 danger=True),
                _callback_button(i18n.t("case.resolve.btn.cancel", locale),
                                 {"action": "case_resolve_no", **action_val}),
            ]),
        ]},
    }


def _resolve_result_card(display_id: str, final_status: str,
                         locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    if not final_status:
        return _info_card(
            i18n.t("case.resolve.fail_title", locale),
            i18n.t("case.resolve.fail_body", locale, display_id=display_id),
            "red")
    case_url = case_management._case_console_url(display_id)
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text",
                             "content": i18n.t("case.resolve.success_title",
                                               locale)},
                   "template": "green"},
        "body": {"elements": [
            {"tag": "markdown",
             "content": i18n.t("case.resolve.success_body", locale,
                               display_id=display_id, status=final_status)},
            _action_row([
                _open_url_button(i18n.t("case.resolve.btn.open_console", locale),
                                 case_url),
            ]),
        ]},
    }


def _pending_card(severity: str, language: str,
                  dispatch_after: bool = False,
                  locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    title_key = ("case.create.pending_title.dispatch" if dispatch_after
                 else "case.create.pending_title.create_only")
    title = i18n.t(title_key, locale)
    extra = (i18n.t("case.create.pending_extra_dispatch", locale)
             if dispatch_after else "")
    sev_label = severity_label(severity, locale)
    lang_label = LANGUAGE_LABELS.get(language, language)
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text", "content": title},
                   "template": "blue"},
        "body": {"elements": [{
            "tag": "markdown",
            "content": i18n.t("case.create.pending_body", locale,
                              severity=sev_label, language=lang_label,
                              extra=extra),
        }]},
    }


def _pending_simple_card(text: str, locale: str = "zh") -> dict:
    locale = _normalize_locale(locale)
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text", "content": text},
                   "template": "blue"},
        "body": {"elements": [{
            "tag": "markdown",
            "content": i18n.t("case.pending.simple_body", locale),
        }]},
    }


def _analyze_card(result: case_analyze.AnalyzeResult,
                  locale: str = "zh") -> dict:
    """LLM case-analysis card: meta header + 4-6 insight sections + 3
    action buttons (reply / view full / dispatch investigation).

    `result.case_summary` is guaranteed non-None when result.error == "" —
    `start_analyze` already filters error paths to `_info_card` before
    we get here."""
    locale = _normalize_locale(locale)
    c = result.case_summary
    assert c is not None  # error paths are handled in start_analyze

    head_md = i18n.t(
        "case.analyze.subject_meta", locale,
        subject=_escape_md(c.subject) or i18n.t("case.list.no_subject", locale),
        severity=severity_label(c.severity, locale),
        service=c.service_code or "—",
        status=c.status or "—",
        comm_count=result.comm_count,
    )
    elements: list[dict] = [{"tag": "markdown", "content": head_md},
                            {"tag": "hr"}]

    def _section(header_key: str, body_md: str) -> None:
        if not body_md:
            return
        elements.append({"tag": "markdown",
                         "content": _bold(i18n.t(header_key, locale))})
        elements.append({"tag": "markdown",
                         "content": _escape_md(body_md)})

    def _bullet_section(header_key: str, items: list[str]) -> None:
        if not items:
            return
        elements.append({"tag": "markdown",
                         "content": _bold(i18n.t(header_key, locale))})
        bullets = "\n".join(f"- {_escape_md(it)}" for it in items)
        elements.append({"tag": "markdown", "content": bullets})

    _section("case.analyze.section.summary", result.summary)
    _section("case.analyze.section.root_cause", result.root_cause)
    _section("case.analyze.section.aws_progress", result.aws_progress)
    _bullet_section("case.analyze.section.next_steps", result.next_steps)
    _bullet_section("case.analyze.section.info_to_provide",
                    result.info_to_provide)
    if result.suggested_reply:
        elements.append({"tag": "markdown",
                         "content": _bold(i18n.t(
                             "case.analyze.section.suggested_reply", locale))})
        # Quote-block the suggested reply so it visually stands out as a
        # template the user could copy.
        quoted = "\n".join("> " + ln for ln in
                           _escape_md(result.suggested_reply).split("\n"))
        elements.append({"tag": "markdown", "content": quoted})

    elements.append({"tag": "hr"})
    action_val = {"case_display_id": c.display_id,
                  "case_internal_id": c.internal_id}
    actions = [
        _callback_button(i18n.t("case.analyze.btn.reply", locale),
                         {"action": "case_reply_form", **action_val},
                         primary=True),
        _open_url_button(i18n.t("case.analyze.btn.view_full", locale),
                         c.case_url),
    ]
    elements.append(_action_row(actions))

    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text",
                             "content": i18n.t("case.analyze.title", locale,
                                               display_id=c.display_id)},
                   "template": "purple"},
        "body": {"elements": elements},
    }


def _info_card(title: str, body: str, color: str = "blue") -> dict:
    return {
        "schema": "2.0",
        "config": card_config(streaming_mode=False),
        "header": {"title": {"tag": "plain_text", "content": title},
                   "template": color},
        "body": {"elements": [{"tag": "markdown", "content": body}]},
    }


# ===========================================================================
# Small UI helpers
# ===========================================================================
def _action_row(buttons: list[dict]) -> dict:
    return {
        "tag": "column_set",
        "columns": [
            {"tag": "column", "width": "weighted", "weight": 1,
             "elements": [b]}
            for b in buttons
        ],
    }


def _callback_button(label: str, value: dict,
                     primary: bool = False, danger: bool = False) -> dict:
    btn_type = "default"
    if danger:
        btn_type = "danger"
    elif primary:
        btn_type = "primary"
    return {
        "tag": "button",
        "text": {"tag": "plain_text", "content": label},
        "type": btn_type,
        "behaviors": [{"type": "callback", "value": value}],
    }


def _open_url_button(label: str, url: str, primary: bool = False) -> dict:
    return {
        "tag": "button",
        "text": {"tag": "plain_text", "content": label},
        "type": "primary" if primary else "default",
        "behaviors": [{"type": "open_url",
                       "default_url": url, "android_url": url,
                       "ios_url": url, "pc_url": url}],
    }


def _trim(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[:n] + "…"


def _escape_md(s: str) -> str:
    """Escape characters that would break Feishu markdown rendering."""
    return (s or "").replace("|", "\\|")


def _short_date(iso: str) -> str:
    """Trim '2026-05-25T04:14:31.000Z' to '2026-05-25 04:14 UTC'."""
    if not iso or len(iso) < 16:
        return iso or "—"
    return f"{iso[:10]} {iso[11:16]} UTC"


def _extract_reply_body(text: str, display_id: str) -> str:
    """If the user typed 'reply 12345 <body>' or '回复 12345 <body>',
    pull <body> out. Otherwise return ''."""
    if not text or not display_id:
        return ""
    idx = text.find(display_id)
    if idx < 0:
        return ""
    rest = text[idx + len(display_id):].strip(" \t\n\r:,.，。")
    return rest if len(rest) >= 4 else ""


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


def _extract_message_id(event) -> str:
    try:
        return (event.event.context.open_message_id or "")
    except AttributeError:
        try:
            return (event.event.action.message_id or "")
        except AttributeError:
            return ""


def _extract_form_values(event) -> dict:
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
        "toast": {"type": "info", "content": text},
    })


def _build_card_response(toast: str, new_card: dict) -> P2CardActionTriggerResponse:
    return P2CardActionTriggerResponse({
        "toast": {"type": "info", "content": toast},
        "card": {"type": "raw", "data": new_card},
    })
