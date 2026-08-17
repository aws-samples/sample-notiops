"""
DingTalk Stream-Mode bot for NotiOps.

Long-lived process: connects outbound to DingTalk over WebSocket via
the official `dingtalk-stream` SDK and handles bot @-mentions / DMs.
Mirrors the role of `platforms/feishu/app/main.py` and
`platforms/slack/app/main.py` — same intent routing, same dispatch
flow, same DDB conventions, same locale + LLM prefs.

Phase 1 scope (this file): chitchat / general_qa replies, intent
classification, investigation dispatch, language + model commands.
Case management, skill commands, push handler integration land in
Phase 2-3.

DingTalk-specific quirks:

  * No native modal / view — case + skill-author flows fall back to
    LLM-parsed conversational input. Phase 2.
  * No Slack `thread_ts` equivalent — group-level locale lock
    instead of per-thread. locale_resolver already supports
    chat_id-only fallback so we don't need to change `core/`.
  * Stream Mode `IM_MESSAGE` callbacks ONLY fire on @-mentions /
    DMs to the bot (the bot can't see general group chatter), so
    we don't need a "is bot mentioned?" gate the way feishu does.

Outbound-reply mechanism (Phase 1.6 correction): every reply goes
through the SDK's `ChatbotHandler.reply_text` /
`reply_markdown` / `reply_markdown_card` helpers, which use the
PER-MESSAGE `incoming_message.session_webhook` URL the platform
hands to the bot for ~5 minutes after each inbound. We do NOT
mint a global access_token + POST to /v1.0/robot/groupMessages/send
— that's a different class of robot (custom-bot / outgoing webhook).
"""
from __future__ import annotations

import asyncio
import logging
import os
import re
import uuid
from typing import Any

import dingtalk_stream

import case_flow
import dingtalk_utils
from core import bedrock_intent
from core import dispatch_compose
from core import i18n
from core import llm_pref_resolver
from core import locale_resolver
from core import model_catalog
from core import webhook_dispatch

PLATFORM = "dingtalk"

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)

ALLOWED_CHAT_IDS_RAW = os.environ.get("ALLOWED_CHAT_IDS", "").strip()
ALLOWED_CHAT_IDS = (
    {c.strip() for c in ALLOWED_CHAT_IDS_RAW.split(",") if c.strip()}
    if ALLOWED_CHAT_IDS_RAW else set()
)


# Defense-in-depth pattern, identical to feishu/slack: catch the most
# blatant change-imperatives before LLM intent classification runs so
# we can return the canned refusal at zero token cost.
_STRONG_CHANGE_RE = re.compile(
    r"\b(delete|remove|stop|terminate|destroy|drop|kill|reboot|restart|shutdown)\s+"
    r"(?:the\s+|a\s+|an\s+)?"
    r"(i-[0-9a-f]{8,17}|vol-[0-9a-f]{8,17}|sg-[0-9a-f]{8,17}|"
    r"(?:arn:aws:[a-z0-9-]+:[a-z0-9-]*:[0-9]{12}:[^ \t\n]+))",
    re.IGNORECASE,
)


def _looks_strongly_change(text: str) -> bool:
    return bool(_STRONG_CHANGE_RE.search(text or ""))


_LANG_CMD_RE = re.compile(r"^\s*/?\s*language(?:\s+(\S+))?\s*$",
                           re.IGNORECASE)
_MODEL_CMD_RE = re.compile(r"^\s*/?\s*model(?:\s+(\S+))?\s*$",
                            re.IGNORECASE)


# ---------- Inline command handlers ---------------------------------------
#
# Mirrors feishu/slack `_maybe_handle_language_command` /
# `_maybe_handle_model_command`. Returning True means we handled the
# message and the caller should NOT continue with intent dispatch.

def _maybe_handle_language_command(*, handler: "ChatBotHandler",
                                    msg: dingtalk_stream.ChatbotMessage,
                                    user_id: str, raw_text: str,
                                    locale: str) -> bool:
    m = _LANG_CMD_RE.match(raw_text or "")
    nl_target = "" if m else i18n.parse_language_switch_intent(raw_text or "")
    if not m and not nl_target:
        return False
    if not user_id:
        handler.reply_text(i18n.t("main.failed_user_id", locale), msg)
        return True
    arg = nl_target or (i18n.normalize_locale(m.group(1)) if m and m.group(1)
                        else "")
    if not arg:
        cur, source = locale_resolver.resolve(
            user_id=user_id, platform=PLATFORM, text=raw_text)
        name = i18n.locale_name(cur, cur)
        key = "lang.current.user" if source == "user" else "lang.current.auto"
        text = i18n.t(key, cur, name=name) + "\n" + i18n.t("lang.usage", cur)
        handler.reply_text(text, msg)
        return True
    if arg == "auto":
        ok = locale_resolver.set_user_pref(user_id, "auto", platform=PLATFORM)
        handler.reply_text(
            i18n.t("lang.unset", locale) if ok
            else i18n.t("lang.unset_failed", locale),
            msg)
        return True
    if arg in {"zh", "en"}:
        ok = locale_resolver.set_user_pref(user_id, arg, platform=PLATFORM)
        name = i18n.locale_name(arg, arg)
        handler.reply_text(
            i18n.t("lang.set.user", arg, name=name) if ok
            else i18n.t("lang.set_failed", locale),
            msg)
        return True
    handler.reply_text(i18n.t("lang.usage", locale), msg)
    return True


def _maybe_handle_model_command(*, handler: "ChatBotHandler",
                                 msg: dingtalk_stream.ChatbotMessage,
                                 conversation_id: str, user_id: str,
                                 is_dm: bool, raw_text: str,
                                 locale: str) -> bool:
    m = _MODEL_CMD_RE.match(raw_text or "")
    if not m:
        return False
    arg = (m.group(1) or "").strip().lower()

    if not arg:
        alias, source = llm_pref_resolver.resolve(
            platform=PLATFORM, chat_id=conversation_id,
            user_id=user_id, is_dm=is_dm)
        entry = model_catalog.get(alias)
        text = (i18n.t("model.current", locale,
                        label=entry.label, source=source)
                + "\n" + i18n.t("model.usage", locale))
        handler.reply_text(text, msg)
        return True

    if arg == "list":
        rows = "\n".join(
            i18n.t("model.list_row", locale, alias=e.alias, label=e.label)
            for e in model_catalog.all_entries()
        )
        text = (i18n.t("model.list_header", locale) + "\n" + rows
                + "\n\n" + i18n.t("model.usage", locale))
        handler.reply_text(text, msg)
        return True

    if arg == "default":
        if is_dm:
            llm_pref_resolver.clear_dm_pref(PLATFORM, user_id)
        else:
            llm_pref_resolver.clear_chat_pref(PLATFORM, conversation_id)
        handler.reply_text(i18n.t("model.cleared", locale), msg)
        return True

    if not model_catalog.is_known(arg):
        handler.reply_text(
            i18n.t("model.unknown", locale,
                   alias=arg, valid=", ".join(model_catalog.list_aliases())),
            msg)
        return True

    if is_dm:
        ok = llm_pref_resolver.set_dm_pref(PLATFORM, user_id, arg)
    else:
        ok = llm_pref_resolver.set_chat_pref(PLATFORM, conversation_id, arg)
    if not ok:
        handler.reply_text(i18n.t("model.set_failed", locale), msg)
        return True
    entry = model_catalog.get(arg)
    msg_key = "model.set_dm" if is_dm else "model.set_chat"
    handler.reply_text(i18n.t(msg_key, locale, label=entry.label), msg)
    return True


# ---------- Stream Mode handler --------------------------------------------

class ChatBotHandler(dingtalk_stream.ChatbotHandler):
    """Handle inbound `IM_MESSAGE` callbacks from DingTalk Stream Mode.

    The SDK delivers `ChatbotMessage` objects with chat metadata
    (`conversation_id`, `sender_staff_id`, `text`,
    `conversation_type`, …) already extracted from the wire format.
    Wrap them in our PLATFORM-agnostic flow and dispatch.
    """

    async def process(self,
                      callback: dingtalk_stream.CallbackMessage) -> Any:  # type: ignore[override]
        try:
            msg = dingtalk_stream.ChatbotMessage.from_dict(callback.data)
        except Exception as e:
            logger.warning("dingtalk: failed to parse ChatbotMessage: %s", e)
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"

        # DingTalk's conversation_type: "1" = 1-on-1, "2" = group.
        is_dm = (msg.conversation_type == "1")
        conversation_id = msg.conversation_id or ""
        if ALLOWED_CHAT_IDS and conversation_id not in ALLOWED_CHAT_IDS:
            logger.info("dingtalk: chat %s not in allowlist; ignoring",
                        conversation_id)
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"

        raw_text = (msg.text and msg.text.content) or ""
        raw_text = dingtalk_utils.strip_at_mention(raw_text)
        if not raw_text:
            self.reply_text(i18n.t("main.usage_hint", "en"), msg)
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"

        user_id = msg.sender_staff_id or msg.sender_id or ""

        # Resolve locale. DingTalk has no thread_ts.
        locale, _src = locale_resolver.resolve(
            user_id=user_id, platform=PLATFORM,
            is_dm=is_dm, thread_root_id="", text=raw_text,
        )

        # Lock locale on first DM touch (parity with feishu/slack so a
        # follow-up "why?" doesn't switch language mid-thread). Group
        # chats fall back to text auto-detect each turn — locking the
        # whole group to whoever spoke first is usually wrong.
        if is_dm:
            try:
                locale_resolver.lock_for_dm(PLATFORM, user_id, locale)
            except Exception:
                pass

        # If the user has an in-flight conversational case-create
        # session, their next message is likely the case details
        # rather than a fresh request. Let case_flow consume it
        # FIRST — but cancel keywords ("取消" / "cancel") are
        # recognised inside case_flow.maybe_continue too. This
        # avoids the user getting a generic intent reply when they
        # were halfway through filing a case.
        operator_name = (msg.sender_nick or user_id or "").strip()
        if case_flow.maybe_continue(
                handler=self, msg=msg,
                conversation_id=conversation_id, user_id=user_id,
                raw_text=raw_text, locale=locale,
                operator_name=operator_name):
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"

        # Inline commands first — language / model. Both short-circuit.
        if _maybe_handle_language_command(
                handler=self, msg=msg, user_id=user_id,
                raw_text=raw_text, locale=locale):
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"
        if _maybe_handle_model_command(
                handler=self, msg=msg, conversation_id=conversation_id,
                user_id=user_id, is_dm=is_dm, raw_text=raw_text,
                locale=locale):
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"

        # Layer 1: blatant change request → canned refusal at zero LLM
        # cost. Same gate feishu/slack run.
        if _looks_strongly_change(raw_text):
            self.reply_text(i18n.t("refusal.change_request", locale), msg)
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"

        # LLM intent classification.
        try:
            analysis = bedrock_intent.analyze_intent(raw_text, locale=locale)
        except Exception as e:
            logger.warning("dingtalk: analyze_intent failed: %s — "
                           "falling back to investigate", e)
            analysis = {"command": "investigate", "intent": raw_text,
                        "suggestions": [], "is_change_request": False}

        cmd = (analysis.get("command") or "investigate").strip()

        # Layer 2: LLM flagged the message as a change request → refuse.
        if analysis.get("is_change_request"):
            self.reply_text(i18n.t("refusal.change_request", locale), msg)
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"

        if cmd in ("chitchat", "general_qa"):
            try:
                # Local import: bedrock_chat pulls in heavy deps; keep
                # cold-start fast for the dispatch-only path.
                from core import bedrock_chat
                reply = bedrock_chat.respond(
                    raw_text, command=cmd,
                    chitchat_count=0, locale=locale,
                    platform=PLATFORM, chat_id=conversation_id,
                    user_id=user_id, is_dm=is_dm,
                )
            except Exception as e:
                logger.warning("dingtalk: bedrock_chat.respond failed: %s", e)
                reply = ""
            if reply:
                self.reply_markdown("NotiOps", reply, msg)
                return dingtalk_stream.AckMessage.STATUS_OK, "ok"
            # respond() returned empty → fall through to investigate
            # so the user is never silently dropped.
            cmd = "investigate"

        # Case-management intents (Phase 2b). All five route into
        # platforms/dingtalk/app/case_flow.py. case_create starts a
        # multi-turn session (see _START at top); the others are
        # single-shot.
        if cmd == "case_create":
            case_flow.start_create(
                handler=self, msg=msg,
                conversation_id=conversation_id, user_id=user_id,
                raw_text=raw_text,
                intent_summary=(analysis.get("intent") or "").strip(),
                locale=locale,
            )
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"
        if cmd == "case_list":
            case_flow.handle_list(
                handler=self, msg=msg,
                status_filter=(analysis.get("case_filter") or "recent"),
                locale=locale,
            )
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"
        if cmd == "case_view":
            case_flow.handle_view(
                handler=self, msg=msg,
                display_id=(analysis.get("case_display_id") or "").strip(),
                locale=locale,
            )
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"
        if cmd == "case_reply":
            case_flow.handle_reply(
                handler=self, msg=msg,
                display_id=(analysis.get("case_display_id") or "").strip(),
                # Reuse the user's raw text as the reply body. The
                # LLM intent classifier already extracted the case id;
                # the rest of the message is the body.
                body=raw_text,
                locale=locale,
            )
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"
        if cmd == "case_resolve":
            case_flow.handle_resolve(
                handler=self, msg=msg,
                display_id=(analysis.get("case_display_id") or "").strip(),
                locale=locale,
            )
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"
        if cmd == "case_analyze":
            case_flow.handle_analyze(
                handler=self, msg=msg,
                display_id=(analysis.get("case_display_id") or "").strip(),
                locale=locale,
            )
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"

        if cmd == "investigate":
            # Phase 1: simple direct dispatch — no edit-form modal
            # because DingTalk has none. Phase 2 will add a confirm
            # ActionCard so the user can reject / re-edit before we
            # burn DevOps Agent budget.
            incident_id = f"{PLATFORM}-{uuid.uuid4().hex[:12]}"
            try:
                user_text = dispatch_compose.compose_simple(raw_text)
                result = webhook_dispatch.dispatch(
                    incident_id, user_text,
                    platform=PLATFORM,
                    user_id=user_id,
                    chat_id=conversation_id,
                )
                if result.get("ok"):
                    self.reply_text(
                        i18n.t("main.dispatched_short", locale), msg)
                    # Lock locale on the incident so the report
                    # writeback comes back in the same language.
                    try:
                        locale_resolver.lock_for_incident(incident_id, locale)
                    except Exception:
                        pass
                else:
                    _body = result.get("body")
                    logger.warning(
                        "dingtalk: webhook_dispatch failed: status=%s (%d-char body)",
                        result.get("status"),
                        len(_body) if isinstance(_body, str) else 0)
                    self.reply_text(
                        i18n.t("main.dispatch_failed_short", locale), msg)
            except Exception as e:
                logger.exception("dingtalk: dispatch threw: %s", e)
                self.reply_text(
                    i18n.t("main.dispatch_failed_short", locale), msg)
            return dingtalk_stream.AckMessage.STATUS_OK, "ok"

        # support / case / skill commands ship in Phase 2.
        self.reply_text(i18n.t("dingtalk.phase2_not_yet", locale), msg)
        return dingtalk_stream.AckMessage.STATUS_OK, "ok"


def main() -> None:
    # Bedrock API Key 注入（spec task 4.5）：注册 bedrock 客户端的构造前钩子并做一次
    # 初次收敛。必须在任何 Bedrock 调用之前 —— botocore 在**构造时**快照 token provider，
    # 设晚了会 NoAuthTokenError 硬失败而非回退 IAM。之后每条消息 / 每轮轮询各自 refresh()。
    try:
        from core import bedrock_credentials
        bedrock_credentials.install()
        bedrock_credentials.refresh()
    except Exception as e:  # noqa: BLE001 — 凭证注入失败不阻断启动（回退 IAM 仍可对话）
        logger.warning("bedrock credential install failed: %s", type(e).__name__)

    app_key = dingtalk_utils._read_secret_env("DINGTALK_APP_KEY_ARN")
    app_secret = dingtalk_utils._read_secret_env("DINGTALK_APP_SECRET_ARN")
    if not app_key or not app_secret:
        import time
        logger.warning(
            "DingTalk credentials not configured — container is alive but idle. "
            "Configure secrets and restart the ECS task to activate.")
        while True:
            time.sleep(3600)  # nosemgrep: arbitrary-sleep — idle loop while waiting for credentials to be configured

    creds = dingtalk_stream.Credential(app_key, app_secret)
    client = dingtalk_stream.DingTalkStreamClient(creds)
    client.register_callback_handler(
        dingtalk_stream.ChatbotMessage.TOPIC,
        ChatBotHandler())

    # Phase 2 — wire up the progress poller daemon (parity with
    # feishu/slack/main.py:main()) once we have ActionCard updates
    # working.

    logger.info("Starting DingTalk Stream Mode client…")
    asyncio.run(client.start())


if __name__ == "__main__":
    main()
