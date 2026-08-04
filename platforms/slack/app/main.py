"""
Slack adapter entrypoint — Socket Mode (zero public ingress, outbound-only
WebSocket to slack.com).

Mirrors platforms/feishu/app/main.py for the Slack ecosystem:
  - app_mention                → classify intent → confirm/dispatch / case_*
  - block_actions (buttons)    → confirm_dispatch / cancel_dispatch /
                                  ask_support / case_* / next_step_dispatch
  - view_submission (modals)   → confirm_support / case_create_submit /
                                  case_reply_submit
"""
from __future__ import annotations

import logging
import os
import re

import boto3
from slack_bolt import App, Ack
from slack_bolt.adapter.socket_mode import SocketModeHandler

from core import bedrock_intent
from core import chat_history
from core import ddb_state
from core import dispatch_compose
from core import i18n
from core import locale_resolver
# webhook_dispatch is retained ONLY for skill_commands' `/skills run` path,
# which still POSTs to the single fixed Agent Space. The @-mention
# investigate path below uses idle's cross-account STS+API instead — see
# the dispatch rationale block in _handle_dispatch_decision.
from core import webhook_dispatch
from core import skill_dispatcher
from core import skill_registry
from core import skill_authoring
from core import webhook_dispatch
from core import llm_pref_resolver
from core import model_catalog
from shared.devops_agent import create_investigation
from platforms.slack.app import skill_commands

from platforms.slack.app import blocks

PLATFORM = "slack"

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)


_STRONG_CHANGE_RE = re.compile(
    # High-precision change-request regex used as the third arm of the
    # hybrid LLM+regex change-detection. Mirrors feishu/main.py.
    # Catches:
    #   - bare imperative + AWS resource id   ("delete i-0123")
    #   - AWS CLI mutation                     ("aws ec2 stop-instances")
    #   - terraform / kubectl mutations
    #   - prompt-injection role-play patterns (defense in depth)
    r"\b(delete|remove|stop|terminate|destroy|drop|kill|reboot|restart|shutdown)\s+"
    r"(?:the\s+|a\s+|an\s+)?"
    r"(?:i|vol|vpc|sg|snap|subnet|nat)-[0-9a-f]{6,17}"
    r"|\baws\s+\S+\s+(?:delete|put|create|update|modify|attach|detach|"
    r"start|stop|reboot|terminate|run|associate|disassociate|enable|disable|"
    r"register|deregister)[a-z\-]*"
    r"|\bterraform\s+(?:apply|destroy|taint|import)\b"
    r"|\bkubectl\s+(?:apply|create|delete|patch|edit|scale|rollout|exec|drain)\b"
    r"|假装你是\s*admin|pretend\s+you\s+are\s+admin|忽略前面|"
    r"ignore\s+(?:the\s+)?previous|disregard\s+(?:the\s+)?previous",
    re.IGNORECASE,
)


def _looks_strongly_change(text: str) -> bool:
    """High-precision change-request check — the 'override LLM' arm of
    the hybrid layer. See feishu/main.py for the full design rationale."""
    if not text:
        return False
    return bool(_STRONG_CHANGE_RE.search(text))

# ---------------------------------------------------------------------------
# Credential bootstrap
# ---------------------------------------------------------------------------
_sm = boto3.client("secretsmanager")


def _read_secret(arn_env: str) -> str:
    arn = os.environ.get(arn_env, "")
    if not arn:
        raise RuntimeError(f"Missing env var: {arn_env}")
    return _sm.get_secret_value(SecretId=arn)["SecretString"].strip()


def _wait_for_credentials():
    """凭证未配置时优雅等待,不崩溃(避免 ECS crash-loop 阻塞 CFN 部署)。"""
    import time
    logger.warning("Slack credentials not configured — container is alive but idle. "
                   "Configure secrets and restart the ECS task to activate.")
    while True:
        time.sleep(3600)  # nosemgrep: arbitrary-sleep — idle loop while waiting for credentials to be configured


try:
    SLACK_BOT_TOKEN = _read_secret("SLACK_BOT_TOKEN_ARN")
    SLACK_APP_TOKEN = _read_secret("SLACK_APP_TOKEN_ARN")
except (RuntimeError, Exception) as e:
    logger.warning("Slack credential load failed: %s", e)
    _wait_for_credentials()

ALLOWED_CHANNEL_IDS = {
    c.strip() for c in os.environ.get("ALLOWED_CHANNEL_IDS", "").split(",")
    if c.strip()
}

app = App(token=SLACK_BOT_TOKEN)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
_BOT_USER_ID: str | None = None


def _bot_user_id() -> str:
    """Return our own bot user id (cached). Used to strip leading <@U...>
    mentions from the user's text."""
    global _BOT_USER_ID
    if _BOT_USER_ID is None:
        try:
            resp = app.client.auth_test()
            _BOT_USER_ID = resp.get("user_id", "")
        except Exception as e:
            logger.warning("auth_test failed: %s", e)
            _BOT_USER_ID = ""
    return _BOT_USER_ID


_MENTION_RE = re.compile(r"<@[A-Z0-9]+>\s*")


def _strip_mention(text: str) -> str:
    return _MENTION_RE.sub("", text or "", count=1).strip()


def _channel_allowed(channel_id: str) -> bool:
    if not ALLOWED_CHANNEL_IDS:
        return True
    return channel_id in ALLOWED_CHANNEL_IDS


_LANGUAGE_CMD_RE = re.compile(
    r"^\s*/?\s*language(?:\s+(\S+))?\s*$",
    re.IGNORECASE,
)


def _maybe_handle_language_command(client, channel_id: str,
                                    thread_ts: str | None, user_id: str,
                                    raw_text: str, locale: str) -> bool:
    """Detect and handle `/language [zh|en|auto]` (and the bare-word
    `language ...` variant) inside a regular @-mention or DM message.
    Returns True if it was a language command — caller should return
    early without running intent classification / dispatch.

    Why text-keyword instead of relying on Slack's slash command:
      * The slash `@app.command("/language")` only works when the slash
        is registered in the workspace's App Manifest. Many deployments
        skip that step.
      * In DMs, `/language` typed without registration is intercepted
        by Slackbot itself ("invalid command") — the bot never sees it.
      * In channels, `@bot /language` is delivered as a normal message
        whose text starts with `/language` — perfect for keyword match.

    By accepting both `/language en` and `language en` (and `语言 en`
    via the same regex below) we sidestep all the slash-command
    plumbing and let the user change locale from anywhere.
    """
    m = _LANGUAGE_CMD_RE.match(raw_text or "")
    nl_target = "" if m else i18n.parse_language_switch_intent(raw_text or "")
    if not m and not nl_target:
        return False
    if not user_id:
        client.chat_postMessage(channel=channel_id, thread_ts=thread_ts,
                                text=i18n.t("main.failed_user_id", locale))
        return True
    # Natural-language phrasings always carry a concrete zh/en target;
    # only the explicit `/language` slash form can have an empty arg
    # (= "show current").
    if nl_target:
        arg = nl_target
    else:
        arg = i18n.normalize_locale(m.group(1)) if m.group(1) else ""

    if not arg:
        # Show current. We have a real `locale` already (resolved upstream
        # against this user_id), so render it directly. Source detection
        # is best-effort by re-running resolve and seeing what fires.
        cur, source = locale_resolver.resolve(user_id=user_id,
                                              platform=PLATFORM,
                                              text=raw_text)
        name = i18n.locale_name(cur, cur)
        if source == "user":
            text = i18n.t("lang.current.user", cur, name=name)
        else:
            text = i18n.t("lang.current.auto", cur, name=name)
        text += "\n" + i18n.t("lang.usage", cur)
        client.chat_postMessage(channel=channel_id, thread_ts=thread_ts,
                                text=text)
        return True

    if arg == "auto":
        ok = locale_resolver.set_user_pref(user_id, "auto",
                                           platform=PLATFORM)
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts,
            text=i18n.t("lang.unset", locale) if ok
                 else i18n.t("lang.unset_failed", locale),
        )
        return True

    if arg in {"zh", "en"}:
        ok = locale_resolver.set_user_pref(user_id, arg,
                                           platform=PLATFORM)
        name = i18n.locale_name(arg, arg)
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts,
            text=i18n.t("lang.set.user", arg, name=name) if ok
                 else i18n.t("lang.set_failed", locale),
        )
        return True

    # `arg` is normalized to one of zh/en/auto/"". Defensive fallback.
    client.chat_postMessage(channel=channel_id, thread_ts=thread_ts,
                            text=i18n.t("lang.usage", locale))
    return True


# `@bot model [alias|list|default]` — anyone in the channel can switch
# the model used for that channel (no admin gate, per product decision
# 2026-06-05). Same short-circuit pattern as the language command.
_MODEL_CMD_RE = re.compile(
    r"^\s*/?\s*model(?:\s+(\S+))?\s*$",
    re.IGNORECASE,
)


def _maybe_handle_model_command(client, channel_id: str,
                                 thread_ts: str | None, user_id: str,
                                 channel_type: str | None,
                                 raw_text: str, locale: str) -> bool:
    """Handle `model` / `model list` / `model <alias>` / `model default`.
    Returns True if a model command was handled (caller should return
    early). False otherwise.

    DM scope (channel_type == "im") writes to the DM-level pref row;
    everything else writes to the chat-level pref row so all members
    of the channel see the same model from then on."""
    m = _MODEL_CMD_RE.match(raw_text or "")
    if not m:
        return False

    is_dm = channel_type == "im"
    arg = (m.group(1) or "").strip().lower()

    if not arg:
        alias, source = llm_pref_resolver.resolve(
            platform=PLATFORM, chat_id=channel_id,
            user_id=user_id, is_dm=is_dm,
        )
        entry = model_catalog.get(alias)
        text = i18n.t("model.current", locale,
                      label=entry.label, source=source)
        text += "\n" + i18n.t("model.usage", locale)
        client.chat_postMessage(channel=channel_id, thread_ts=thread_ts,
                                text=text)
        return True

    if arg == "list":
        rows = "\n".join(
            i18n.t("model.list_row", locale, alias=e.alias, label=e.label)
            for e in model_catalog.all_entries()
        )
        text = i18n.t("model.list_header", locale) + "\n" + rows
        text += "\n\n" + i18n.t("model.usage", locale)
        client.chat_postMessage(channel=channel_id, thread_ts=thread_ts,
                                text=text)
        return True

    if arg == "default":
        if is_dm:
            llm_pref_resolver.clear_dm_pref(PLATFORM, user_id)
        else:
            llm_pref_resolver.clear_chat_pref(PLATFORM, channel_id)
        client.chat_postMessage(channel=channel_id, thread_ts=thread_ts,
                                text=i18n.t("model.cleared", locale))
        return True

    if not model_catalog.is_known(arg):
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts,
            text=i18n.t("model.unknown", locale,
                        alias=arg,
                        valid=", ".join(model_catalog.list_aliases())),
        )
        return True

    if is_dm:
        ok = llm_pref_resolver.set_dm_pref(PLATFORM, user_id, arg)
    else:
        ok = llm_pref_resolver.set_chat_pref(PLATFORM, channel_id, arg)

    if not ok:
        client.chat_postMessage(channel=channel_id, thread_ts=thread_ts,
                                text=i18n.t("model.set_failed", locale))
        return True

    entry = model_catalog.get(arg)
    msg_key = "model.set_dm" if is_dm else "model.set_chat"
    client.chat_postMessage(
        channel=channel_id, thread_ts=thread_ts,
        text=i18n.t(msg_key, locale, label=entry.label),
    )
    return True


# ---------------------------------------------------------------------------
# Event: message in a DM channel (1:1 chat with the bot).
# Slack delivers DMs as `message` events with channel_type="im". We only
# care about user-typed messages (skip our own bot replies + edits).
# ---------------------------------------------------------------------------
@app.event("message")
def on_message_event(event: dict, say, client) -> None:
    # Slack sends every message in subscribed channels as a `message`
    # event — including the bot's own posts, edits, joins/leaves, etc.
    # We want:
    #   • user-typed text in DMs (channel_type="im"), AND
    #   • user-typed text in channel threads where the bot has already
    #     replied (so users can follow up without re-@ing the bot).
    # Channel messages NOT in a bot-active thread fall through to the
    # `app_mention` event handler, which Slack only fires when the bot
    # is explicitly @-mentioned.
    if event.get("bot_id") or event.get("subtype"):
        return  # ignore bot messages, edits, channel-joined notices, etc.
    if not event.get("user") or not event.get("text"):
        return

    channel_type = event.get("channel_type")
    if channel_type == "im":
        on_app_mention(event, say, client)
        return

    # Channel message: only forward if it's a follow-up in a bot-active
    # thread. The thread root timestamp uniquely identifies the thread.
    thread_ts = event.get("thread_ts")
    if not thread_ts:
        return  # not a thread reply — `app_mention` handler covers @s
    if not ddb_state.is_bot_thread(PLATFORM, thread_ts):
        return  # bot has never replied in this thread — stay silent
    # Bot-active thread: treat as if the user @-mentioned the bot.
    on_app_mention(event, say, client)


# ---------------------------------------------------------------------------
# Event: app_mention (user @mentions the bot in a channel)
# ---------------------------------------------------------------------------
def _thread_context(client, channel_id: str, thread_ts: str,
                    exclude_ts: str) -> str:
    """Build a compact transcript of the prior thread so a follow-up reply
    dispatched to DevOps Agent carries continuity (what 'dig deeper' refers
    to). Returns '' on any failure or if there's no usable prior content."""
    # Skip the bot's own ack / progress / footer lines. Both zh and en variants
    # share an emoji prefix (🤔 ack, 🚀 progress, 🔧 MCP footer), so matching the
    # emoji is language-agnostic and keeps the file CJK-free for the i18n lint.
    _SKIP = ("🤔", "🚀", "🔧", "Working on your request",
             "Investigating", "MCP tools used", "By Claude")
    try:
        resp = client.conversations_replies(
            channel=channel_id, ts=thread_ts, limit=20)
    except Exception as e:
        logger.warning("thread_context fetch failed: %s", e)
        return ""
    lines = []
    for m in resp.get("messages", []):
        if m.get("ts") == exclude_ts:
            continue
        txt = (m.get("text") or "").strip()
        if not txt or any(s in txt for s in _SKIP):
            continue
        who = "Bot" if m.get("bot_id") or m.get("app_id") else "User"
        lines.append(f"{who}: {txt}")
    if not lines:
        return ""
    blob = "\n".join(lines)[-3000:]   # cap to keep the payload lean
    return ("PRIOR THREAD CONTEXT (for continuity — the user is following up "
            "on this conversation):\n" + blob + "\n\n---\nFOLLOW-UP REQUEST:\n")


@app.event("app_mention")
def on_app_mention(event: dict, say, client) -> None:
    channel_id = event.get("channel", "")
    user_id = event.get("user", "")
    event_ts = event.get("ts", "")
    raw_text = _strip_mention(event.get("text", ""))

    # DM threading rule:
    #   • In a 1:1 IM (`channel_type == "im"`) we DO NOT thread —
    #     a DM with the bot is already a private 1:1 conversation,
    #     forcing every reply into a thread just adds clicks. So
    #     leave `thread_ts` empty for DMs.
    #   • In a channel/group, we always thread on the user's message
    #     (or continue the existing thread if the user @-d inside one)
    #     so the main timeline stays clean.
    is_dm = event.get("channel_type") == "im"
    if is_dm:
        thread_ts = None
    else:
        thread_ts = event.get("thread_ts") or event_ts

    if not _channel_allowed(channel_id):
        logger.info("Channel %s not in allowlist; ignoring", channel_id)
        return

    if not raw_text:
        # No text yet → no auto-detect signal; use user-pref or env default.
        _no_text_locale, _ = locale_resolver.resolve(
            user_id=user_id, platform=PLATFORM, is_dm=is_dm,
            thread_root_id=thread_ts or "", text="",
        )
        say(channel=channel_id, thread_ts=thread_ts,
            text=i18n.t("main.usage_hint", _no_text_locale))
        return

    # Slack message ts is unique per workspace and stable; safe to use as
    # event_id for idempotency.
    event_id = event_ts.replace(".", "")

    # `root_message_id` becomes lambda/slack_sender's `thread_ts` for the
    # progress card / report posts. In a CHANNEL we want those posts to
    # land in the thread (`thread_ts = event_ts` so all replies cluster
    # under the user's original message). In a DM we want them flat —
    # writing event_ts here would force every progress card + report
    # message into a thread under the user's prompt, which violates the
    # "DM is always flat" rule. Empty string → lambda sees None → flat.
    root_message_id_for_replies = "" if is_dm else event_ts

    # `/language [zh|en|auto]` text-keyword short-circuit. Must run
    # BEFORE `locale_resolver.resolve()` below — otherwise the auto-
    # detect on this message ("language en" is pure ASCII → en) would
    # write a fresh DM lock to en *before* set_user_pref runs, and
    # the user would still see English replies after typing
    # "language auto". Pre-resolve here using only the user pref +
    # existing locks (no auto-detect) just to render the command's
    # confirmation reply in the right language.
    _pre_locale, _ = locale_resolver.resolve(
        user_id=user_id, platform=PLATFORM, is_dm=is_dm,
        thread_root_id=thread_ts or "", text="",
    )
    if _maybe_handle_language_command(client, channel_id, thread_ts,
                                      user_id, raw_text, _pre_locale):
        return

    # `@bot model [alias|list|default]` — same short-circuit pattern.
    # Anyone in the channel can switch (no admin gate, per product
    # decision 2026-06-05).
    if _maybe_handle_model_command(client, channel_id, thread_ts,
                                    user_id, event.get("channel_type"),
                                    raw_text, _pre_locale):
        return

    # Resolve the conversation locale BEFORE writing the event row so
    # the entire response chain (ack / refusal / chat / dispatch card /
    # downstream incident lock) is language-consistent. Priority chain:
    # user explicit pref → thread/incident lock → DM lock → auto-detect
    # this message → env default → "en". See core/locale_resolver.py.
    locale, locale_source = locale_resolver.resolve(
        user_id=user_id, platform=PLATFORM, is_dm=is_dm,
        thread_root_id=thread_ts or "", text=raw_text,
    )
    logger.info("locale=%s source=%s", locale, locale_source)
    # First message of a thread/DM → write the lock so subsequent
    # messages don't re-detect (and accidentally flip on a short
    # follow-up like "why?"). Idempotent — second-call no-ops.
    if locale_source == "auto":
        if is_dm:
            locale_resolver.lock_for_dm(PLATFORM, user_id, locale)
        elif thread_ts:
            locale_resolver.lock_for_thread(PLATFORM, thread_ts, locale)

    if not ddb_state.put_new_event(event_id, platform=PLATFORM,
                                   chat_id=channel_id,
                                   root_message_id=root_message_id_for_replies,
                                   user_id=user_id, raw_text=raw_text,
                                   locale=locale):
        logger.info("Duplicate event %s — skipped", event_id)
        return

    # `/skills ...` short-circuit — runs AFTER the duplicate-event guard so a
    # DM @mention (delivered by Slack as BOTH a `message` and an `app_mention`
    # event, same event_id) is handled exactly once. Runs after full locale
    # resolve so replies match the conversation language. (BUG-2 fix.)
    if skill_commands.maybe_handle_skill_command(
            client, channel_id=channel_id, thread_ts=thread_ts,
            event_ts=event.get("ts", ""), user_id=user_id,
            raw_text=raw_text, locale=locale):
        return

    # Mark this Slack thread as bot-active so subsequent follow-ups in
    # the same thread route through `on_message_event` without needing
    # a fresh @-mention. `thread_ts` is either the existing thread root
    # (when the user @-ed inside an existing thread) or this very ts
    # (when the user @-ed at the channel root — the bot's reply will
    # then start a new thread on this message). DMs don't thread, so
    # there's nothing to mark.
    if thread_ts:
        ddb_state.mark_bot_thread(PLATFORM, thread_ts)

    # Authoring-intent nudge (Option A): "write me a skill" is not a run/
    # investigate request — point the user to the admin `/skills create` path
    # instead of dispatching an investigation. Admin-aware (_is_admin returns
    # True in open mode, i.e. SKILLS_ADMINS unset).
    if skill_dispatcher.looks_like_authoring_request(raw_text):
        if skill_commands._is_admin(user_id):
            # Author directly from the NL request — no need to retype as
            # `/skills create`. Extract the goal and run the create flow
            # (enrich → lint → confirm card).
            goal = skill_dispatcher.extract_authoring_goal(raw_text)
            skill_commands.begin_authoring(
                client, channel_id=channel_id, thread_ts=thread_ts,
                event_ts=event.get("ts", ""), user_id=user_id,
                locale=locale, mode="create", skill_id="", goal=goal)
        else:
            say(channel=channel_id, thread_ts=thread_ts,
                text=i18n.t("skill.author.denied", locale))
        return

    # Quick acknowledgement so the user sees we got it.
    say(channel=channel_id, thread_ts=thread_ts,
        text=i18n.t("ack.understanding", locale))

    # ZERO-CHANGE PROMISE — Hybrid LLM + regex architecture.
    # 主判:LLM 在 analyze_intent() 输出 is_change_request 字段。
    # 兜底:LLM 失败 / chitchat 短路 → 正则。
    # 详见 platforms/feishu/app/main.py 同款逻辑的注释。
    analysis = bedrock_intent.analyze_intent(raw_text, locale=locale)
    intent = analysis["intent"]
    suggestions = analysis.get("suggestions", [])
    command = analysis.get("command", "investigate")
    case_display_id = analysis.get("case_display_id", "")
    needs_diagnosis = analysis.get("needs_diagnosis", True)
    # Multi-turn rewrite (#1) was retired — kept as constants so the
    # dispatch + confirmation block construction below doesn't need
    # rewiring. Always-False branches simply pick raw_text.
    references_prior = False
    rewritten_text = ""

    # === ZERO-CHANGE check (LLM 主判 + 正则兜底) ===
    llm_says_change = bool(analysis.get("is_change_request", False))
    is_chitchat_shortcut = analysis.get("_source") == "chitchat_shortcut"
    try:
        from core import bedrock_chat as _bc
        regex_says_change = _bc._is_change_request(raw_text)
    except Exception as e:
        logger.warning("regex change-request fallback failed: %s", e)
        regex_says_change = False

    if llm_says_change or (is_chitchat_shortcut and regex_says_change) or \
            (not llm_says_change and regex_says_change and command == "investigate"
             and _looks_strongly_change(raw_text)):
        logger.info("change-request rejected (llm=%s regex=%s command=%s)",
                    llm_says_change, regex_says_change, command)
        client.chat_postMessage(channel=channel_id, thread_ts=thread_ts,
                                text=i18n.t("refusal.change_request", locale))
        return

    logger.info("Classified intent: command=%s case_display_id=%s",
                command, case_display_id)

    # Branch on command.
    #
    # Conversational commands (chitchat / general_qa) — gated behind
    # `AGENTIC_CHAT_MODE`. Double-checked here even though the intent
    # layer also gates: belt-and-suspenders means a stale prompt cache
    # can never accidentally route casual chat into a real dispatch.
    # Reply is generated by `core.bedrock_chat.respond()` which enforces
    # the read-only boundary (inbound regex + system prompt + outbound
    # audit).
    if command in {"chitchat", "general_qa"}:
        _agentic_mode = (os.environ.get("AGENTIC_CHAT_MODE") or "").strip().lower()
        if _agentic_mode in {"enabled", "qa_only"}:
            try:
                from core import bedrock_chat
                # chitchat_count was tied to the retired chat-history
                # row; pass 0 → no soft "回到主题" nudge.
                reply = bedrock_chat.respond(
                    raw_text, command=command,
                    chitchat_count=0,
                    locale=locale,
                    platform=PLATFORM,
                    chat_id=channel_id,
                    user_id=user_id,
                    is_dm=is_dm,
                )
                if reply:
                    client.chat_postMessage(
                        channel=channel_id, thread_ts=thread_ts,
                        text=reply,
                    )
                    return
            except Exception as e:
                logger.warning("bedrock_chat.respond failed: %s", e)
        logger.info("agentic chat path declined (mode=%s, command=%s) — "
                    "falling through to investigate", _agentic_mode, command)
        command = "investigate"

    # query command — read existing DDB results and reply immediately.
    if command == "query":
        from platforms.feishu.app.query_handler import handle as query_handle
        query_type = analysis.get("query_type", "health_report")
        result = query_handle(query_type, chat_id=channel_id, locale=locale)
        if result:
            client.chat_postMessage(channel=channel_id, thread_ts=thread_ts,
                                    text=result)
            return
        # If query returned None, fall through to investigate
        command = "investigate"

    # case_* commands skip the dispatch-confirmation flow entirely and
    # go straight to the matching case_flow entry point. `locale` rides
    # through so cards/modals/toasts render in the same language we
    # acked the user with above.
    if command == "case_create":
        from platforms.slack.app import case_flow
        case_flow.start_create(client, channel_id, raw_text, user_id,
                               thread_ts, locale=locale)
        return
    if command == "case_list":
        from platforms.slack.app import case_flow
        case_flow.start_list(client, channel_id, thread_ts,
                             status_filter=analysis.get("case_filter") or "recent",
                             locale=locale)
        return
    if command == "case_view":
        from platforms.slack.app import case_flow
        case_flow.start_view(client, channel_id, thread_ts, case_display_id,
                             locale=locale)
        return
    if command == "case_reply":
        from platforms.slack.app import case_flow
        case_flow.start_reply(client, channel_id, thread_ts,
                              case_display_id, raw_text, user_id,
                              locale=locale)
        return
    if command == "case_resolve":
        from platforms.slack.app import case_flow
        case_flow.start_resolve(client, channel_id, thread_ts,
                                case_display_id, locale=locale)
        return
    if command == "case_analyze":
        from platforms.slack.app import case_flow
        case_flow.start_analyze(client, channel_id, thread_ts,
                                case_display_id, locale=locale)
        return

    # Default: investigate path. Skip the old "confirm intent" middle
    # step — render the "Start an investigation" inline edit card
    # directly. Same fields as Slack's modal version: details (pre-
    # filled with intent), starting point, suggestion chips, log
    # snippet. The user can keep all defaults and click submit, or
    # edit anything before dispatching.
    dispatch_text = rewritten_text if (references_prior and rewritten_text) else raw_text

    # If this @mention is a reply inside an existing thread, prepend the prior
    # thread transcript so DevOps Agent has continuity instead of treating the
    # follow-up ("dig deeper into the Bedrock usage") as a contextless request.
    if not is_dm and event.get("thread_ts") and event.get("thread_ts") != event_ts:
        _ctx = _thread_context(client, channel_id, event["thread_ts"], event_ts)
        if _ctx:
            dispatch_text = _ctx + dispatch_text

    # ── Skill auto-dispatch ──────────────────────────────────────────────
    # Match the message to a saved skill. select() is fail-safe: any error /
    # low confidence / no match → None, and we fall through to the normal
    # free-form investigation. The user never sees a skill id or types /skills.
    skill_card = None
    try:
        decision = skill_dispatcher.select(raw_text, locale=locale)
    except Exception as e:
        logger.warning("skill_dispatch.select crashed (%s) → free-form", e)
        decision = None
    if decision:
        # Build the whole skill path defensively: if compose/persist/card-build
        # fails for any reason, fall back to a free-form card (dispatch_text stays
        # the free-form text, skill_card stays None) so a mention always gets a card.
        try:
            composed = skill_dispatcher.compose_payload(decision)
            try:
                _catalogue = skill_registry.list_skills(status="active")
            except Exception:
                _catalogue = None
            _card = skill_dispatcher.describe_decision(
                decision, event_id, locale=locale, catalogue=_catalogue)
            # Commit only after everything built successfully.
            dispatch_text = composed
            skill_card = _card
            try:
                ddb_state._table.update_item(
                    Key={"lookup_key": f"event#{event_id}"},
                    UpdateExpression="SET skill_id = :s, skill_version = :v, "
                                     "skill_missing = :m, skill_params = :p, "
                                     "original_text = :o",
                    ExpressionAttributeValues={
                        ":s": decision["skill_id"],
                        ":v": decision["version"],
                        ":m": decision.get("missing") or [],
                        ":p": decision.get("params") or {},
                        ":o": raw_text,
                    },
                )
            except Exception as e:
                logger.warning("persist skill provenance failed: %s", e)
            logger.info("skill_dispatch: skill=%s v%s conf=%.2f missing=%s",
                        decision["skill_id"], decision["version"],
                        decision["confidence"], decision.get("missing"))
        except Exception as e:
            logger.warning("skill_dispatch: card setup failed (%s) → free-form", e)
            skill_card = None

    # ── Auto-dispatch: general queries that need no deep-dive ──────────
    # Simple lookups / inventory / config / cost queries (needs_diagnosis
    # = False) go straight to DevOps Agent — no card. Troubleshooting and
    # deep investigations (needs_diagnosis = True) still show the card to
    # collect context first. Inventory queries DO carry suggestions
    # (account/region hints), so we must NOT gate on `suggestions` here.
    auto_dispatch = (
        os.environ.get("AUTO_DISPATCH", "true").strip().lower()
        in {"1", "true", "yes", "on"}
        and not needs_diagnosis      # not a troubleshooting/deep-dive request
        and not skill_card           # no skill took over
    )

    if auto_dispatch:
        logger.info("auto-dispatch: query is self-contained, skipping card")
        incident_id = f"{PLATFORM}-{event_id}"
        # Same path as the confirm-dispatch button: STS AssumeRole +
        # create_investigation, with incident_id embedded into description
        # for report-handler routing recovery.
        target_account_id = os.environ.get("DEFAULT_INVESTIGATION_ACCOUNT_ID", "")
        if target_account_id:
            result = create_investigation(
                title=f"[{PLATFORM.capitalize()}#{incident_id[-12:]}] {dispatch_text[:50]}",
                description=dispatch_text,
                priority="MEDIUM",
                source=f"{PLATFORM}-mention",
                target_account_id=target_account_id,
                incident_id=incident_id,
            )
        else:
            logger.warning("DEFAULT_INVESTIGATION_ACCOUNT_ID not configured; "
                           "auto-dispatch falls back to confirmation card")
            result = {"success": False, "error": "no-default-account"}
        if result.get("success"):
            # Write the incident#/task# routing records so the report-handler
            # Lambda can find this thread when DevOps Agent finishes. Without
            # this, the investigation completes but the report is never
            # delivered ("no chat routing context found").
            ddb_state.link_incident(event_id, incident_id, platform=PLATFORM,
                                    task_id=result.get("task_id"))
            if locale in {"zh", "en"}:
                locale_resolver.lock_for_incident(incident_id, locale)
            return
        else:
            logger.warning("auto-dispatch failed (%s), falling back to card",
                           result.get("error", ""))
            # Fall through to show the card as a safety net

    edit_blocks = _build_inline_edit_blocks(
        event_id=event_id, intent=intent, suggestions=suggestions,
        locale=locale, skill_card=skill_card,
    )
    posted = client.chat_postMessage(
        channel=channel_id, thread_ts=thread_ts,
        text=i18n.t("edit.modal.title", locale),
        blocks=edit_blocks,
    )
    prompt_msg_ts = posted.get("ts", "")
    ddb_state.update_intent(event_id, intent, prompt_msg_ts)

    # Persist the rewritten text so the dispatch path picks it up if
    # the user clicks submit without editing details.
    if dispatch_text != raw_text:
        try:
            ddb_state._table.update_item(
                Key={"lookup_key": f"event#{event_id}"},
                UpdateExpression="SET raw_text = :t",
                ExpressionAttributeValues={":t": dispatch_text},
            )
        except Exception as e:
            logger.warning("Failed to persist rewritten text: %s", e)


# ---------------------------------------------------------------------------
# block_actions: confirm_dispatch / cancel_dispatch
# ---------------------------------------------------------------------------
@app.action("confirm_dispatch")
def on_confirm_dispatch(ack: Ack, body: dict, client) -> None:
    ack()
    _handle_dispatch_decision(body, client, action="confirm_dispatch")


@app.action("cancel_dispatch")
def on_cancel_dispatch(ack: Ack, body: dict, client) -> None:
    ack()
    _handle_dispatch_decision(body, client, action="cancel_dispatch")


def _build_edit_modal_view(*, event_id: str, channel_id: str, msg_ts: str,
                           intent: str, suggestions: list[str],
                           locale: str,
                           details_value: str | None = None,
                           starting_point_value: str = "",
                           log_value: str = "",
                           suggestion_values: dict[str, str] | None = None,
                           ) -> dict:
    """Build the "Start an investigation" modal view.

    Initial open passes only `intent` + `suggestions` — the textareas
    open populated with `details=intent` and everything else empty.
    Live-preview redraw passes the current state (collected from the
    incoming `block_actions` payload) so the preview block updates
    without losing the user's typing.
    """
    if details_value is None:
        details_value = intent

    sug_vals = suggestion_values or {}

    blks: list[dict] = [
        blocks.section(i18n.t("edit.modal.intro", locale)),
        blocks.divider(),
        # Investigation details
        {
            "type": "input",
            "block_id": "edit_details",
            "label": {"type": "plain_text",
                      "text": i18n.t("edit.field.details.label", locale)},
            "element": {
                "type": "plain_text_input",
                "action_id": "edit_details_input",
                "multiline": True,
                "initial_value": details_value or "",
                "placeholder": {
                    "type": "plain_text",
                    # Slack caps placeholder text at 150 chars; clamp
                    # to avoid 400 invalid_blocks if a future i18n edit
                    # exceeds that.
                    "text": i18n.t("edit.field.details.placeholder", locale)[:150],
                },
            },
        },
        # Investigation starting point
        {
            "type": "input",
            "block_id": "edit_starting_point",
            "label": {"type": "plain_text",
                      "text": i18n.t("edit.field.starting_point.label", locale)},
            "optional": True,
            "element": {
                "type": "plain_text_input",
                "action_id": "edit_starting_point_input",
                "multiline": True,
                "initial_value": starting_point_value or "",
                "placeholder": {
                    "type": "plain_text",
                    "text": i18n.t("edit.field.starting_point.placeholder", locale)[:150],
                },
            },
        },
    ]

    # LLM-suggested dimensions render as a hint right under the
    # starting_point input — they describe what's worth mentioning in
    # that field, not a separate "additional details" section. Earlier
    # we surfaced each suggestion as its own input, but that bloated
    # the form and the inputs were always optional, so almost nobody
    # filled them.
    sug_lines = [s.strip() for s in (suggestions or [])[:8] if (s or "").strip()]
    if sug_lines:
        blks.append(blocks.section(
            f"💡 _{i18n.t('edit.field.suggestions.hint', locale)}_\n"
            + "\n".join(f"• {s}" for s in sug_lines)
        ))

    # Log / error snippet — multiline, optional, auto-fenced on submit.
    blks.append(blocks.divider())
    blks.append({
        "type": "input",
        "block_id": "edit_log_snippet",
        "label": {"type": "plain_text",
                  "text": i18n.t("edit.field.log_snippet.label", locale)},
        "optional": True,
        "element": {
            "type": "plain_text_input",
            "action_id": "edit_log_snippet_input",
            "multiline": True,
            "initial_value": log_value or "",
            "placeholder": {
                "type": "plain_text",
                "text": i18n.t("edit.field.log_snippet.placeholder", locale)[:150],
            },
        },
    })

    # `private_metadata` carries channel/msg routing through to the
    # view_submission handler (which doesn't have access to the original
    # block_actions context).
    import json as _json
    private = _json.dumps({
        "event_id": event_id,
        "channel_id": channel_id,
        "msg_ts": msg_ts,
        "locale": locale,
        "suggestions": suggestions[:8],
    })

    return {
        "type": "modal",
        "callback_id": "edit_dispatch_submit",
        "private_metadata": private,
        "title": {"type": "plain_text",
                  "text": i18n.t("edit.modal.title", locale)[:24]},
        "submit": {"type": "plain_text",
                   "text": i18n.t("edit.button.submit", locale)[:24]},
        "close": {"type": "plain_text",
                  "text": i18n.t("edit.button.cancel", locale)[:24]},
        "blocks": blks,
    }


def _build_inline_edit_blocks(*, event_id: str, intent: str,
                              suggestions: list[str],
                              locale: str,
                              skill_card: dict | None = None) -> list[dict]:
    """Build the "Start an investigation" card as a regular Slack
    message (not a modal). Used for the new direct-into-edit flow:
    the user @-mentions the bot with an investigate-class message,
    we skip the old "confirm your intent" middle step and post this
    card directly so they can review/edit and click submit.

    Mirrors the modal layout: header, details textarea, starting
    point textarea, optional per-suggestion chips, log snippet
    textarea, submit + cancel buttons.

    Submit is wired to action_id `edit_dispatch_submit_inline` (vs
    the modal's view callback `edit_dispatch_submit`); the handler
    collects values from the message's `state.values` dict.
    """
    out: list[dict] = [
        {"type": "header",
         "text": {"type": "plain_text",
                  "text": i18n.t("edit.modal.title", locale)[:150]}},
        blocks.section(i18n.t("edit.modal.intro", locale)),
        blocks.divider(),
        {"type": "input",
         "block_id": "edit_details",
         "label": {"type": "plain_text",
                   "text": i18n.t("edit.field.details.label", locale)},
         "element": {
             "type": "plain_text_input",
             "action_id": "edit_details_input",
             "multiline": True,
             "initial_value": intent or "",
             "placeholder": {
                 "type": "plain_text",
                 # Slack's plain_text_input placeholder cap = 150 chars.
                 "text": i18n.t("edit.field.details.placeholder", locale)[:150],
             },
         }},
        {"type": "input",
         "block_id": "edit_starting_point",
         "label": {"type": "plain_text",
                   "text": i18n.t("edit.field.starting_point.label", locale)},
         "optional": True,
         "element": {
             "type": "plain_text_input",
             "action_id": "edit_starting_point_input",
             "multiline": True,
             "placeholder": {
                 "type": "plain_text",
                 "text": i18n.t("edit.field.starting_point.placeholder", locale)[:150],
             },
         }},
    ]

    # ── Skill banner: which skill, why, override controls ────────────────
    # Spliced in after the header (index 1) when a skill was auto-selected.
    # When skill_card is None the card is byte-identical to the free-form card.
    if skill_card:
        banner: list[dict] = []
        b = skill_card["banner"]
        banner.append(blocks.section(
            i18n.t(b["text_key"], locale, **b["text_args"])))
        banner.append(blocks.context(
            i18n.t(b["reason_key"], locale, **b["reason_args"])))
        if b.get("missing_hint_key"):
            banner.append(blocks.context(
                i18n.t(b["missing_hint_key"], locale, **b["missing_hint_args"])))
        # 🔄 switch-skill drop-down (static_select element inside an actions
        # block so it fires block_actions on pick) + ❌ don't-use button.
        sel = skill_card.get("switch_select")
        action_elems: list[dict] = []
        if sel:
            opts = [{"text": {"type": "plain_text", "text": o["label"][:75]},
                     "value": o["value"][:75]} for o in sel["options"]]
            select_el: dict = {
                "type": "static_select",
                "action_id": sel["action_id"],
                "placeholder": {"type": "plain_text",
                                "text": i18n.t(sel["label_key"], locale)[:150]},
                "options": opts,
            }
            iv = sel.get("initial_value")
            if iv:
                for o in opts:
                    if o["value"] == iv:
                        select_el["initial_option"] = o
                        break
            action_elems.append(select_el)
        action_elems += [
            blocks.button(i18n.t(btn["text_key"], locale),
                          btn["action_id"], value=btn["value"])
            for btn in skill_card["buttons"]
        ]
        banner.append(blocks.actions(*action_elems, block_id="skill_overrides"))
        banner.append(blocks.divider())
        out[1:1] = banner

    sug_lines = [s.strip() for s in (suggestions or [])[:8] if (s or "").strip()]
    if sug_lines:
        out.append(blocks.section(
            f"💡 _{i18n.t('edit.field.suggestions.hint', locale)}_\n"
            + "\n".join(f"• {s}" for s in sug_lines)
        ))

    out.append(blocks.divider())
    out.append({
        "type": "input",
        "block_id": "edit_log_snippet",
        "label": {"type": "plain_text",
                  "text": i18n.t("edit.field.log_snippet.label", locale)},
        "optional": True,
        "element": {
            "type": "plain_text_input",
            "action_id": "edit_log_snippet_input",
            "multiline": True,
            "placeholder": {
                "type": "plain_text",
                "text": i18n.t("edit.field.log_snippet.placeholder", locale)[:150],
            },
        },
    })

    # event_id + suggestions list are embedded into the submit button
    # value JSON so the handler can reconstruct them without another
    # DDB roundtrip. (suggestions is needed to map sug_N → label.)
    import json as _json
    submit_value = _json.dumps({
        "event_id": event_id,
        "suggestions": suggestions[:8],
        "locale": locale,
    })

    # ── Missing required skill params: blank inputs to fill before submit ──
    # block_id is skill_param__<name> so _do_edit_dispatch's `flat` (keyed by
    # block_id) hands them to merge_param_overrides. None when free-form.
    if skill_card:
        for inp in skill_card["missing_inputs"]:
            out.append(blocks.text_input(
                label=i18n.t(inp["label_key"], locale, **inp["label_args"]),
                action_id=f'{inp["block_id"]}_input',
                block_id=inp["block_id"],
                optional=inp.get("optional", False),
            ))

    out.append(blocks.actions(
        blocks.button(i18n.t("edit.button.submit", locale),
                      "edit_dispatch_submit_inline",
                      value=submit_value, style="primary"),
        blocks.button(i18n.t("edit.button.cancel", locale),
                      "cancel_dispatch", value=event_id),
    ))
    return out


def _collect_view_state(view: dict) -> dict:
    """Pull current values out of a Slack view's `state.values` dict.
    Returns a flat dict keyed by block_id."""
    out: dict[str, str] = {}
    state = (view or {}).get("state") or {}
    values = state.get("values") or {}
    for block_id, slot in values.items():
        for action_id, payload in (slot or {}).items():
            v = (payload or {}).get("value")
            if v is None:
                continue
            out[block_id] = v
    return out


@app.action("edit_dispatch")
def on_edit_dispatch(ack: Ack, body: dict, client) -> None:
    """Open the "Start an investigation" modal so the user can edit
    intent + add a starting point + fill suggested context fields
    before dispatching. Mirrors AWS's DevOps Agent web UI."""
    ack()
    event_id = (body.get("actions") or [{}])[0].get("value", "")
    trigger_id = body.get("trigger_id", "")
    msg_ref = body.get("message") or {}
    channel_id = (body.get("channel") or {}).get("id", "")
    msg_ts = msg_ref.get("ts", "")
    if not event_id or not trigger_id:
        return

    convo = ddb_state.get_by_event(event_id) or {}
    locale = (convo.get("locale") or "en").strip().lower()
    if locale not in {"zh", "en"}:
        locale = "en"

    intent = convo.get("intent_summary") or convo.get("raw_text") or ""
    raw_text = convo.get("raw_text") or ""
    # Suggestions were on the confirmation card body; we re-fetch from
    # the original analyzer output that was stored alongside intent.
    # The analyzer doesn't currently persist them, so we re-run the
    # parse on raw_text for stability. Cheap because the row exists.
    try:
        analysis = bedrock_intent.analyze_intent(raw_text, locale=locale)
        suggestions = analysis.get("suggestions", []) or []
    except Exception as e:
        logger.warning("re-analysis for edit modal failed: %s", e)
        suggestions = []

    view = _build_edit_modal_view(event_id=event_id,
                                  channel_id=channel_id,
                                  msg_ts=msg_ts,
                                  intent=intent,
                                  suggestions=suggestions,
                                  locale=locale)
    try:
        client.views_open(trigger_id=trigger_id, view=view)
    except Exception as e:
        logger.exception("views_open failed: %s", e)
        client.chat_postEphemeral(
            channel=channel_id, user=(body.get("user") or {}).get("id", ""),
            text=i18n.t("main.editor_open_failed", locale))


def _handle_dispatch_decision(body: dict, client, action: str) -> None:
    event_id = (body.get("actions") or [{}])[0].get("value", "")
    channel_id = (body.get("channel") or {}).get("id", "")
    msg_ts = (body.get("message") or {}).get("ts", "")
    operator = (body.get("user") or {}).get("name", "")

    convo = ddb_state.get_by_event(event_id)
    # Locale comes from the row written at intake; fall back to en if
    # missing (older convos pre-dating multi-locale).
    locale = ((convo or {}).get("locale") or "en").strip().lower()
    if locale not in {"zh", "en"}:
        locale = "en"

    if not convo:
        client.chat_postEphemeral(channel=channel_id,
                                  user=(body.get("user") or {}).get("id", ""),
                                  text=i18n.t("confirm.expired", locale))
        return

    if convo.get("status") not in ("awaiting_confirmation", "received"):
        client.chat_update(channel=channel_id, ts=msg_ts,
                           text=i18n.t("confirm.already_handled", locale,
                                       raw_text=convo.get("raw_text", "")),
                           blocks=[blocks.section(
                               i18n.t("confirm.already_handled", locale,
                                      raw_text=convo.get("raw_text", "")))])
        return

    raw_text = convo.get("raw_text", "")
    intent = convo.get("intent_summary", "")

    if action == "cancel_dispatch":
        client.chat_update(channel=channel_id, ts=msg_ts,
                           text=i18n.t("confirm.cancelled", locale,
                                       operator=operator, raw_text=raw_text),
                           blocks=[blocks.section(
                               i18n.t("confirm.cancelled", locale,
                                      operator=operator, raw_text=raw_text))])
        return

    # ── DevOps Agent dispatch: notiops's cross-account STS+API ──
    # We intentionally use shared.devops_agent.create_investigation (idle's
    # per-account STS AssumeRole + boto3 devops-agent create_backlog_task)
    # instead of notiops-devops's core/webhook_dispatch.py (HMAC webhook).
    #
    # WHY (for reviewers who know the original notiops-devops design):
    #   1. webhook_dispatch is SINGLE-ACCOUNT by construction: it POSTs to one
    #      fixed WEBHOOK_URL bound to one Agent Space, with no account_id routing.
    #      The merged system requires MULTI-ACCOUNT investigations (one Agent
    #      Space per business account), which only the STS+API path supports.
    #   2. The merged system already retains idle's full multi-account stack:
    #      devops_agent_account_config (per-account Agent Space + Trigger Role)
    #      and devops_agent_callback (EventBridge result callback). Using the
    #      webhook path would require a SECOND, parallel trigger + callback
    #      mechanism — unnecessary complexity.
    #   3. Latency is equivalent: both are sub-second "fire" operations that
    #      just return a task_id; the actual investigation runs async for
    #      minutes and reports back via EventBridge. The user perceives no diff.
    #   core/webhook_dispatch.py is left in the tree (used by skill_commands'
    #   /skills run for now) but the @-mention investigate path uses STS+API.
    #
    # incident_id stays as the LOCAL routing key (`<platform>-<event_id>`) — it
    # keys the Conversations row that progress-poller / report-handler use to
    # route the async result back to this channel/thread. It is NOT the DevOps
    # Agent task_id (which create_investigation returns separately, below).
    incident_id = f"{PLATFORM}-{event_id}"

    # target_account_id: 调查目标账号。本期只支持【默认账号】(= 部署账号,
    # 由 DEFAULT_INVESTIGATION_ACCOUNT_ID 注入)。跨账号调查(用户指定别的
    # 业务账号)暂未开放。
    # 注意:代码层面就只调默认账号,没有"让用户指定账号"的入口;所以无需
    # 检测"用户想跨账号"再拒绝 —— 只要不实现"指定账号"入口即可。
    target_account_id = os.environ.get("DEFAULT_INVESTIGATION_ACCOUNT_ID", "")
    if not target_account_id:
        logger.warning("DEFAULT_INVESTIGATION_ACCOUNT_ID 未配置,无法发起调查 incident_id=%s", incident_id)
        no_account_text = i18n.t("confirm.no_default_account", locale)
        client.chat_update(
            channel=channel_id, ts=msg_ts,
            text=no_account_text,
            blocks=[blocks.section(no_account_text)])
        return

    result = create_investigation(
        # Mirror webhook_dispatch's title shape so triage stays readable:
        # platform + short incident id + a slice of the user's request.
        title=f"[{PLATFORM.capitalize()}#{incident_id[-12:]}] {raw_text[:50]}",
        description=raw_text,
        priority="MEDIUM",
        source=f"{PLATFORM}-mention",
        target_account_id=target_account_id,
        incident_id=incident_id,
    )
    if not result.get("success"):
        logger.error("dispatch failed: %s", result)
        body_text = (result.get('error') or '')[:500]
        client.chat_update(
            channel=channel_id, ts=msg_ts,
            text=i18n.t("confirm.dispatch_failed", locale,
                        status="", body=body_text),
            blocks=[blocks.section(
                i18n.t("confirm.dispatch_failed", locale,
                       status="", body=body_text))])
        return

    ddb_state.link_incident(event_id, incident_id, platform=PLATFORM,
                            task_id=result.get("task_id"))
    # Lock the locale at the incident level too, so Lambda-side
    # senders (which run outside this process) can look it up by
    # incident_id alone — see core/locale_resolver.get_for_incident.
    if locale in {"zh", "en"}:
        locale_resolver.lock_for_incident(incident_id, locale)
    # (Multi-turn history was retired — see analyze_intent caller above.)

    suffix = f"\n_task: `{result['task_id']}`_" if result.get("task_id") else ""
    dispatched_text = i18n.t("confirm.dispatched", locale,
                              operator=operator, intent=intent,
                              incident=incident_id, suffix=suffix)
    client.chat_update(
        channel=channel_id, ts=msg_ts,
        text=dispatched_text,
        blocks=[blocks.section(dispatched_text)],
    )
    # The "Investigation In Progress" event handler in report-handler
    # posts a live card a few seconds later, and the progress poller then
    # updates it every 20s with tool-call info. We no longer need a
    # placeholder text here.


# ---------------------------------------------------------------------------
# block_actions: support flow (ask / open / cancel)
# ---------------------------------------------------------------------------
@app.action(re.compile(
    r"^(ask_support|cancel_support|case_sync_report"
    r"|next_step_dispatch(?:_\d+)?)$"))
def on_support_or_special(ack: Ack, body: dict, client) -> None:
    ack()
    action = (body.get("actions") or [{}])[0].get("action_id", "")
    # Match both bare and indexed forms (next_step_dispatch_0/1/2).
    # See lambda/slack_sender.py — each button gets a unique action_id
    # because Slack rejects the whole message if two share an id.
    if action.startswith("next_step_dispatch"):
        try:
            _handle_next_step_dispatch(body, client)
        except Exception as e:
            logger.exception("next_step_dispatch crashed: %s", e)
        return
    try:
        from platforms.slack.app import support_flow
        support_flow.handle_action(action, body, client)
    except Exception as e:
        logger.exception("support_flow crashed: %s", e)


# ---------------------------------------------------------------------------
# Edit-dispatch modal: submit
# ---------------------------------------------------------------------------
def _do_edit_dispatch(*, client, event_id: str, suggestions: list[str],
                      flat: dict, channel_id: str, msg_ts: str,
                      locale: str, operator: str, user_id_for_ephemeral: str
                      ) -> None:
    """Shared submit handler for both the inline edit-card path and
    the (legacy) modal path. Composes the user-edited fields, persists,
    dispatches, and updates the original message in place.
    """
    details = flat.get("edit_details", "").strip()
    starting_point = flat.get("edit_starting_point", "").strip()
    log_snippet = flat.get("edit_log_snippet", "").strip()
    # Old in-flight cards posted before the suggestions-chip removal may
    # still submit `edit_sug_N` values; pick them up if present so those
    # users don't lose typing. New cards have no chips at all.
    suggestion_fills: list[tuple[str, str]] = []
    for idx, label in enumerate(suggestions[:8]):
        val = flat.get(f"edit_sug_{idx}", "").strip()
        if val:
            suggestion_fills.append((label, val))

    if not details:
        # Inline form has no built-in required-validation; show ephemeral.
        if user_id_for_ephemeral and channel_id:
            client.chat_postEphemeral(
                channel=channel_id, user=user_id_for_ephemeral,
                text=i18n.t("edit.field.details.placeholder", locale))
        return

    composed = dispatch_compose.compose_edited(
        details=details,
        starting_point=starting_point,
        suggestion_fills=suggestion_fills,
        log_snippet=log_snippet,
        locale=locale,
    )

    convo = ddb_state.get_by_event(event_id)
    if not convo:
        if user_id_for_ephemeral and channel_id:
            client.chat_postEphemeral(channel=channel_id,
                                      user=user_id_for_ephemeral,
                                      text=i18n.t("confirm.expired", locale))
        return

    # ── Skill path: re-render the skill prompt with params the user filled ─
    # When the row carries a skill_id, the authoritative text is the skill
    # prompt (not the free-form fields). Fold any skill_param__<name> inputs
    # back in, then re-render so placeholders resolve. No skill_id → unchanged.
    skill_id = convo.get("skill_id", "")
    skill_version = convo.get("skill_version", "")
    if skill_id:
        submitted = {
            bid[len(skill_dispatcher.PARAM_BLOCK_PREFIX):]: val
            for bid, val in flat.items()
            if bid.startswith(skill_dispatcher.PARAM_BLOCK_PREFIX)
        }
        decision = {
            "skill_id": skill_id,
            "version": skill_version,
            "source_key": f"skills/{skill_id}/versions/{skill_version}.md",
            "params": dict(convo.get("skill_params") or {}),
            "missing": convo.get("skill_missing") or [],
        }
        merged = skill_dispatcher.merge_param_overrides(decision, submitted)
        composed = skill_dispatcher.compose_payload(merged)

    try:
        ddb_state._table.update_item(
            Key={"lookup_key": f"event#{event_id}"},
            UpdateExpression="SET raw_text = :t",
            ExpressionAttributeValues={":t": composed},
        )
    except Exception as e:
        logger.warning("persist edited text failed: %s", e)

    # Same idle STS+API path as _handle_dispatch_decision (see the rationale
    # block there). The edit-form submit is just the confirm path with
    # user-edited text, so it routes through create_investigation too.
    #
    # target_account_id: 本期只调【默认账号】(DEFAULT_INVESTIGATION_ACCOUNT_ID)。
    # 跨账号调查暂未开放 —— 不实现"指定账号"入口即可。
    incident_id = f"{PLATFORM}-{event_id}"
    target_account_id = os.environ.get("DEFAULT_INVESTIGATION_ACCOUNT_ID", "")
    if not target_account_id:
        logger.warning("DEFAULT_INVESTIGATION_ACCOUNT_ID 未配置,无法发起调查 incident_id=%s", incident_id)
        if msg_ts:
            no_account_text = i18n.t("confirm.no_default_account", locale)
            client.chat_update(
                channel=channel_id, ts=msg_ts,
                text=no_account_text,
                blocks=[blocks.section(no_account_text)])
        return

    result = create_investigation(
        title=f"[{PLATFORM.capitalize()}#{incident_id[-12:]}] {composed[:50]}",
        description=composed,
        priority="MEDIUM",
        source=f"{PLATFORM}-mention",
        target_account_id=target_account_id,
        incident_id=incident_id,
    )
    if not result.get("success"):
        logger.error("edited dispatch failed: %s", result)
        body_text = (result.get('error') or '')[:500]
        if msg_ts:
            client.chat_update(
                channel=channel_id, ts=msg_ts,
                text=i18n.t("confirm.dispatch_failed", locale,
                            status="", body=body_text),
                blocks=[blocks.section(
                    i18n.t("confirm.dispatch_failed", locale,
                           status="", body=body_text))])
        return

    ddb_state.link_incident(event_id, incident_id, platform=PLATFORM,
                            task_id=result.get("task_id"))
    if locale in {"zh", "en"}:
        locale_resolver.lock_for_incident(incident_id, locale)

    suffix = f"\n_task: `{result['task_id']}`_" if result.get("task_id") else ""
    intent_for_card = (convo.get("intent_summary") or details)[:120]
    dispatched_text = i18n.t("confirm.dispatched", locale,
                             operator=operator or "user",
                             intent=intent_for_card,
                             incident=incident_id, suffix=suffix)
    if msg_ts:
        try:
            client.chat_update(
                channel=channel_id, ts=msg_ts,
                text=dispatched_text,
                blocks=[blocks.section(dispatched_text)],
            )
        except Exception as e:
            logger.warning("chat_update after edited dispatch failed: %s", e)


@app.action(skill_dispatcher.ACTION_DONT_USE_SKILL)
def on_skill_dont_use(ack: Ack, body: dict, client) -> None:
    """❌ Don't use a skill — drop the match, restore the user's original
    message, and re-render the card WITHOUT the skill banner (free-form)."""
    ack()
    action = (body.get("actions") or [{}])[0]
    event_id = action.get("value", "") or _event_id_from_message(body)
    convo = ddb_state.get_by_event(event_id) or {}
    locale = convo.get("locale", "en")
    logger.info("skill_feedback: action=dont_use event_id=%s prior_skill=%s",
                event_id, convo.get("skill_id", ""))
    if locale not in {"zh", "en"}:
        locale = "en"
    original = convo.get("original_text") or convo.get("raw_text", "")
    try:
        ddb_state._table.update_item(
            Key={"lookup_key": f"event#{event_id}"},
            UpdateExpression="SET raw_text = :t REMOVE skill_id, skill_version, "
                             "skill_missing",
            ExpressionAttributeValues={":t": original},
        )
    except Exception as e:
        logger.warning("skill_dont_use: revert failed: %s", e)
    channel_id = (body.get("channel") or {}).get("id", "")
    msg_ts = (body.get("message") or {}).get("ts", "")
    edit_blocks = _build_inline_edit_blocks(
        event_id=event_id, intent=convo.get("intent_summary", ""),
        suggestions=[], locale=locale, skill_card=None)
    if msg_ts:
        client.chat_update(channel=channel_id, ts=msg_ts,
                           text=i18n.t("edit.modal.title", locale),
                           blocks=edit_blocks)


@app.action(skill_dispatcher.ACTION_SWITCH_SKILL)
def on_skill_switch(ack: Ack, body: dict, client) -> None:
    """🔄 Switch skill — user picked a different skill from the drop-down.
    decision_for_skill pins confidence to 1.0 (user is authoritative). A manual
    switch starts clean — params aren't carried over (schemas differ). Falls
    back to free-form if the skill can't be resolved."""
    ack()
    action = (body.get("actions") or [{}])[0]
    chosen = ((action.get("selected_option") or {}).get("value")
              or action.get("value") or "")
    event_id = _event_id_from_message(body)
    convo = ddb_state.get_by_event(event_id) or {}
    locale = convo.get("locale", "en")
    logger.info("skill_feedback: action=switch event_id=%s from=%s to=%s",
                event_id, convo.get("skill_id", ""), chosen)
    if locale not in {"zh", "en"}:
        locale = "en"
    channel_id = (body.get("channel") or {}).get("id", "")
    msg_ts = (body.get("message") or {}).get("ts", "")

    decision = skill_dispatcher.decision_for_skill(chosen)
    if not decision:
        logger.warning("skill_switch: can't resolve %r → free-form", chosen)
        return on_skill_dont_use(lambda *a, **k: None, body, client)

    composed = skill_dispatcher.compose_payload(decision)
    try:
        ddb_state._table.update_item(
            Key={"lookup_key": f"event#{event_id}"},
            UpdateExpression="SET raw_text = :t, skill_id = :s, "
                             "skill_version = :v, skill_missing = :m, "
                             "skill_params = :p",
            ExpressionAttributeValues={
                ":t": composed, ":s": decision["skill_id"],
                ":v": decision["version"], ":m": decision.get("missing") or [],
                ":p": decision.get("params") or {},
            },
        )
    except Exception as e:
        logger.warning("skill_switch: persist failed: %s", e)

    try:
        _catalogue = skill_registry.list_skills(status="active")
    except Exception:
        _catalogue = None
    skill_card = skill_dispatcher.describe_decision(
        decision, event_id, locale=locale, catalogue=_catalogue)
    edit_blocks = _build_inline_edit_blocks(
        event_id=event_id, intent=convo.get("intent_summary", ""),
        suggestions=[], locale=locale, skill_card=skill_card)
    if msg_ts:
        client.chat_update(channel=channel_id, ts=msg_ts,
                           text=i18n.t("edit.modal.title", locale),
                           blocks=edit_blocks)


def _event_id_from_message(body: dict) -> str:
    """Recover event_id from the submit button's value JSON on the message
    (the 🔄 drop-down doesn't carry it)."""
    import json as _json
    for block in (body.get("message") or {}).get("blocks", []):
        for el in block.get("elements", []):
            if el.get("action_id") == "edit_dispatch_submit_inline":
                try:
                    return _json.loads(el.get("value") or "{}").get("event_id", "")
                except Exception:
                    return ""
    return ""


# ── Authoring confirm-card handlers (delegate to skill_commands builders) ─────

@app.action(skill_authoring.ACTION_SAVE_SKILL)
def on_skill_author_save(ack: Ack, body: dict, client) -> None:
    """✅ Save the LLM-drafted skill."""
    ack()
    import json as _json
    action = (body.get("actions") or [{}])[0]
    event_id = _json.loads(action.get("value") or "{}").get("event_id", "")
    channel_id = (body.get("channel") or {}).get("id", "")
    msg_ts = (body.get("message") or {}).get("ts", "")
    skill_commands.save_authored_skill(event_id, channel_id, msg_ts, client)


@app.action(skill_authoring.ACTION_EDIT_SKILL)
def on_skill_author_edit(ack: Ack, body: dict, client) -> None:
    """✏️ Open a modal pre-filled with the draft's editable fields."""
    ack()
    import json as _json
    action = (body.get("actions") or [{}])[0]
    event_id = _json.loads(action.get("value") or "{}").get("event_id", "")
    draft, convo = skill_commands._load_draft(event_id)
    locale = convo.get("locale", "en")
    if not draft:
        return
    fields = [
        ("name", draft.get("name", "")),
        ("description", draft.get("description", "")),
        ("prompt", draft.get("prompt", "")),
        ("tags", " ".join(draft.get("tags", []))),
    ]
    modal_blocks = [
        blocks.text_input(
            label=i18n.t(f"skill.author.field.{f}", locale),
            action_id=f"{skill_authoring.DRAFT_BLOCK_PREFIX}{f}_input",
            block_id=f"{skill_authoring.DRAFT_BLOCK_PREFIX}{f}",
            initial_value=v, multiline=(f == "prompt"),
            optional=(f != "prompt"), max_length=3000)
        for f, v in fields
    ]
    client.views_open(
        trigger_id=body["trigger_id"],
        view=blocks.modal(
            i18n.t("skill.author.edit_title", locale), modal_blocks,
            callback_id="skill_author_edit_submit",
            private_metadata=_json.dumps({"event_id": event_id})))


@app.view("skill_author_edit_submit")
def on_skill_author_edit_submit(ack: Ack, body: dict, view: dict, client) -> None:
    """Fold modal edits back into the draft, re-lint, re-render the card."""
    ack()
    import json as _json
    event_id = _json.loads(view.get("private_metadata") or "{}").get("event_id", "")
    state = (view.get("state") or {}).get("values") or {}
    edits = {}
    for f in ("name", "description", "prompt", "tags"):
        bid = f"{skill_authoring.DRAFT_BLOCK_PREFIX}{f}"
        aid = f"{bid}_input"
        edits[f] = ((state.get(bid, {}) or {}).get(aid, {}) or {}).get("value", "") or ""
    skill_commands.apply_authoring_edits(event_id, edits, client)


@app.action(skill_authoring.ACTION_CANCEL_SKILL)
def on_skill_author_cancel(ack: Ack, body: dict, client) -> None:
    """❌ Cancel — discard the draft, clear the card."""
    ack()
    import json as _json
    action = (body.get("actions") or [{}])[0]
    event_id = _json.loads(action.get("value") or "{}").get("event_id", "")
    _, convo = skill_commands._load_draft(event_id)
    locale = convo.get("locale", "en")
    channel_id = (body.get("channel") or {}).get("id", "")
    msg_ts = (body.get("message") or {}).get("ts", "")
    if msg_ts:
        client.chat_update(channel=channel_id, ts=msg_ts,
                           text=i18n.t("skill.author.cancelled", locale), blocks=[])


@app.action("edit_dispatch_submit_inline")
def on_edit_dispatch_submit_inline(ack: Ack, body: dict, client) -> None:
    """Submit handler for the inline (in-message) edit card. Pulls
    state from the message itself rather than a modal view."""
    ack()
    import json as _json
    action = (body.get("actions") or [{}])[0]
    raw_value = action.get("value") or "{}"
    try:
        meta = _json.loads(raw_value)
    except Exception:
        meta = {}
    event_id = meta.get("event_id", "")
    suggestions = meta.get("suggestions", []) or []
    locale = meta.get("locale", "en")
    if locale not in {"zh", "en"}:
        locale = "en"

    channel_id = (body.get("channel") or {}).get("id", "")
    msg_ref = body.get("message") or {}
    msg_ts = msg_ref.get("ts", "")

    # Slack delivers the message's input state on `state.values` of the
    # message itself when block_actions fires from a non-modal context.
    state = (body.get("state") or {}).get("values") or {}
    flat: dict[str, str] = {}
    for block_id, slot in state.items():
        for action_id, payload in (slot or {}).items():
            v = (payload or {}).get("value")
            if v is not None:
                flat[block_id] = v

    operator = (body.get("user") or {}).get("name", "")
    user_id = (body.get("user") or {}).get("id", "")
    _do_edit_dispatch(
        client=client, event_id=event_id, suggestions=suggestions,
        flat=flat, channel_id=channel_id, msg_ts=msg_ts,
        locale=locale, operator=operator, user_id_for_ephemeral=user_id)


@app.view("edit_dispatch_submit")
def on_edit_dispatch_submit(ack: Ack, body: dict, view: dict, client) -> None:
    """Submit handler for the legacy modal path (kept for the case
    where the old confirmation card with `📝 编辑后派发` button still
    exists in chat history)."""
    ack()
    import json as _json
    try:
        meta = _json.loads(view.get("private_metadata") or "{}")
    except Exception:
        meta = {}
    event_id = meta.get("event_id", "")
    channel_id = meta.get("channel_id", "")
    msg_ts = meta.get("msg_ts", "")
    locale = meta.get("locale", "en")
    suggestions = meta.get("suggestions", []) or []

    flat = _collect_view_state(view)
    operator = (body.get("user") or {}).get("name", "")
    user_id = (body.get("user") or {}).get("id", "")
    _do_edit_dispatch(
        client=client, event_id=event_id, suggestions=suggestions,
        flat=flat, channel_id=channel_id, msg_ts=msg_ts,
        locale=locale, operator=operator, user_id_for_ephemeral=user_id)


# Submit handler for the support escalation modal.
@app.view("confirm_support")
def on_confirm_support_view(ack: Ack, body: dict, view: dict, client) -> None:
    try:
        from platforms.slack.app import support_flow
        support_flow.handle_view_submission(ack, body, view, client)
    except Exception as e:
        logger.exception("confirm_support view failed: %s", e)
        # Recover locale from view's private_metadata when present;
        # default en since modals open from button clicks in any locale.
        _err_locale = "en"
        try:
            import json as _json
            _meta = _json.loads(view.get("private_metadata") or "{}")
            _ml = (_meta.get("locale") or "").strip().lower()
            if _ml in {"zh", "en"}:
                _err_locale = _ml
        except Exception:
            pass
        ack(response_action="errors",
            errors={"subject_block": i18n.t(
                "main.modal_submit_failed", _err_locale,
                detail=type(e).__name__)})


# ---------------------------------------------------------------------------
# block_actions + view_submission: case management
# ---------------------------------------------------------------------------
@app.action(re.compile(r"^case_"))
def on_case_action(ack: Ack, body: dict, client) -> None:
    ack()
    action_id = (body.get("actions") or [{}])[0].get("action_id", "")
    try:
        from platforms.slack.app import case_flow
        case_flow.handle_action(action_id, body, client)
    except Exception as e:
        logger.exception("case_flow action %s crashed: %s", action_id, e)


@app.view(re.compile(r"^case_"))
def on_case_view(ack: Ack, body: dict, view: dict, client) -> None:
    callback = view.get("callback_id", "")
    try:
        from platforms.slack.app import case_flow
        case_flow.handle_view_submission(callback, ack, body, view, client)
    except Exception as e:
        logger.exception("case_flow view %s crashed: %s", callback, e)
        # Recover locale from view's private_metadata when present;
        # default en since modals open from button clicks in any locale.
        _err_locale = "en"
        try:
            import json as _json
            _meta = _json.loads(view.get("private_metadata") or "{}")
            _ml = (_meta.get("locale") or "").strip().lower()
            if _ml in {"zh", "en"}:
                _err_locale = _ml
        except Exception:
            pass
        ack(response_action="errors",
            errors={"subject_block": i18n.t(
                "main.modal_submit_failed", _err_locale,
                detail=type(e).__name__)})


# ---------------------------------------------------------------------------
# Slash commands (literal /devops-* shortcuts)
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Catch-all for url-only buttons — Slack still requires a 200 ack on every
# block_actions, even for buttons whose only behavior is `url`. Without
# this, `open_report` / `open_trace` / `open_case_url` etc. flood the
# logs with "unhandled request" warnings.
# ---------------------------------------------------------------------------
@app.action(re.compile(r"^open_"))
def on_open_url_button(ack: Ack, body: dict) -> None:
    ack()


# ---------------------------------------------------------------------------
# Slash commands
# ---------------------------------------------------------------------------
@app.command("/devops")
def on_devops_slash(ack: Ack, command: dict, client, respond) -> None:
    """Slash command dispatcher. Treats the command body as a normal user
    request and reuses the same intent classifier path."""
    ack()
    text = (command.get("text") or "").strip()
    channel_id = command.get("channel_id", "")
    user_id = command.get("user_id", "")
    # Locale for slash-command error toasts: probe user pref + auto-
    # detect on the slash text itself.
    _slash_locale, _ = locale_resolver.resolve(
        user_id=user_id, platform=PLATFORM, text=text,
    )
    if not text:
        respond(i18n.t("main.command_usage", _slash_locale))
        return
    if not _channel_allowed(channel_id):
        respond(i18n.t("main.channel_unauthorized", _slash_locale))
        return
    # Synthesize an event so the rest of the flow works the same way.
    fake_event = {
        "channel": channel_id,
        "user": user_id,
        "ts": command.get("trigger_id", "") or text[:32],
        "thread_ts": "",
        "text": text,
    }
    on_app_mention(fake_event, say=lambda **kw: client.chat_postMessage(**kw),
                   client=client)


@app.command("/language")
def on_language_slash(ack: Ack, command: dict, respond) -> None:
    """`/language [zh|en|auto]` — manage per-user output language pref.

    No args      → show current locale + source.
    zh / en      → pin user's preference (overrides auto-detect).
    auto         → clear user preference (re-enable auto-detect).
    """
    ack()
    raw = (command.get("text") or "").strip()
    user_id = command.get("user_id", "")
    # Slash command's invoker locale: probe user pref + fall back to
    # detect on the slash text. May land on env default if neither.
    invoker_locale, _ = locale_resolver.resolve(user_id=user_id,
                                                 platform=PLATFORM,
                                                 text=raw)
    if not user_id:
        respond(i18n.t("main.failed_user_id", invoker_locale))
        return

    arg = i18n.normalize_locale(raw) if raw else ""

    if not arg:
        # Show current resolution. We can't easily synthesize the
        # full thread context here, so just report user pref vs
        # auto-detect on a probe of the slash-text.
        locale, source = invoker_locale, "user"  # placeholder
        locale, source = locale_resolver.resolve(user_id=user_id,
                                                 platform=PLATFORM,
                                                 text=raw)
        name = i18n.locale_name(locale, locale)
        if source == "user":
            respond(i18n.t("lang.current.user", locale, name=name))
        else:
            respond(i18n.t("lang.current.auto", locale, name=name))
        respond(i18n.t("lang.usage", locale))
        return

    if arg == "auto":
        ok = locale_resolver.set_user_pref(user_id, "auto",
                                           platform=PLATFORM)
        # `unset` confirms in invoker_locale; if user just turned auto
        # back on we don't yet have a message to detect from for the
        # NEXT reply, so stick with whatever they had set just now.
        respond(i18n.t("lang.unset", invoker_locale) if ok
                else i18n.t("lang.unset_failed", invoker_locale))
        return

    if arg in {"zh", "en"}:
        ok = locale_resolver.set_user_pref(user_id, arg,
                                           platform=PLATFORM)
        name = i18n.locale_name(arg, arg)
        respond(i18n.t("lang.set.user", arg, name=name) if ok
                else i18n.t("lang.set_failed", invoker_locale))
        return

    # arg is normalized; only "auto" / "zh" / "en" possible. The
    # else-branch is unreachable but kept defensive.
    respond(i18n.t("lang.usage", invoker_locale))


# ---------------------------------------------------------------------------
# Confirmation message blocks
# ---------------------------------------------------------------------------
def _confirmation_blocks(event_id: str, intent: str, raw_text: str,
                         suggestions: list[str] | None,
                         rewritten_text: str = "",
                         locale: str = "en") -> list[dict]:
    out: list[dict] = [
        blocks.section(f"*{i18n.t('confirm.title', locale)}*\n"
                       f"> {blocks.escape_mrkdwn(intent)}"),
        blocks.context(f"_{i18n.t('confirm.original_message', locale)}:_ "
                       f"`{blocks.escape_mrkdwn(raw_text)}`"),
    ]
    if rewritten_text:
        # Multi-turn rewrite text — kept around but multi-turn is retired
        # so this branch never triggers. Leave the literal string to
        # avoid burning an i18n key on a dead path.
        out.append(blocks.section(
            f"> {blocks.escape_mrkdwn(rewritten_text)}"))
    if suggestions:
        bullets = "\n".join(f"• {blocks.escape_mrkdwn(s)}" for s in suggestions)
        out.append(blocks.section(
            f"*{i18n.t('confirm.suggestions_header', locale)}*\n{bullets}\n\n"
            f"_{i18n.t('confirm.suggestions_footer', locale)}_"
        ))
    out.append(blocks.actions(
        blocks.button(i18n.t("confirm.button.dispatch", locale),
                      "confirm_dispatch", value=event_id, style="primary"),
        blocks.button(i18n.t("confirm.button.edit_dispatch", locale),
                      "edit_dispatch", value=event_id),
        blocks.button(i18n.t("confirm.button.cancel", locale),
                      "cancel_dispatch", value=event_id),
    ))
    return out


# ---------------------------------------------------------------------------
# Next-step dispatch (Idea #3) — clicked from a report message
# ---------------------------------------------------------------------------
def _handle_next_step_dispatch(body: dict, client) -> None:
    """Mirror of feishu's _handle_next_step_dispatch. Synthesizes an
    event_id from (parent_incident, query) and routes through the standard
    dispatch flow so the report comes back to the same channel/thread."""
    import hashlib
    import json as _json

    action = (body.get("actions") or [{}])[0]
    raw_value = action.get("value") or "{}"
    try:
        action_value = _json.loads(raw_value)
    except Exception:
        action_value = {}

    parent_incident = action_value.get("incident_id", "")
    query = (action_value.get("query") or "").strip()
    # Inherit parent investigation's locale.
    next_step_locale = "en"
    try:
        if parent_incident:
            _row = ddb_state.get_by_incident(parent_incident)
            if _row and (_row.get("locale") or "").strip():
                next_step_locale = _row["locale"].strip().lower()
    except Exception:
        pass
    if next_step_locale not in {"zh", "en"}:
        next_step_locale = "en"

    if not query:
        return

    channel_id = (body.get("channel") or {}).get("id", "")
    thread_ts = (body.get("message") or {}).get("thread_ts") \
        or (body.get("message") or {}).get("ts", "")
    if not channel_id:
        return

    # SHA1 used for short dedup-key generation only (not security).
    digest = hashlib.sha1(
        f"{parent_incident}:{query}".encode("utf-8"),
        usedforsecurity=False).hexdigest()[:16]
    synth_event_id = f"nextstep-{digest}"

    is_new = ddb_state.put_new_event(
        synth_event_id, platform=PLATFORM, chat_id=channel_id,
        root_message_id=thread_ts, user_id="", raw_text=query,
        locale=next_step_locale,
    )
    if not is_new:
        client.chat_postEphemeral(channel=channel_id,
                                  user=(body.get("user") or {}).get("id", ""),
                                  text=i18n.t("main.duplicate_dispatch",
                                              next_step_locale))
        return

    # Next-step follow-up uses the same idle STS+API path as the primary
    # investigate dispatch (see the rationale block in
    # _handle_dispatch_decision). The parent's provenance — which used to
    # ride in webhook_dispatch's extra_metadata — is folded into the
    # `source` tag here so it still surfaces in the [source] description
    # prefix + CloudTrail session name.
    #
    # target_account_id: 本期只调【默认账号】(DEFAULT_INVESTIGATION_ACCOUNT_ID)。
    # 跨账号调查暂未开放 —— 不实现"指定账号"入口即可。
    incident_id = f"{PLATFORM}-{synth_event_id}"
    target_account_id = os.environ.get("DEFAULT_INVESTIGATION_ACCOUNT_ID", "")
    if not target_account_id:
        logger.warning("DEFAULT_INVESTIGATION_ACCOUNT_ID 未配置,无法发起调查 incident_id=%s", incident_id)
        client.chat_postEphemeral(
            channel=channel_id,
            user=(body.get("user") or {}).get("id", ""),
            text=i18n.t("confirm.no_default_account", next_step_locale),
        )
        return

    result = create_investigation(
        title=f"[{PLATFORM.capitalize()}#{incident_id[-12:]}] {query[:50]}",
        description=query,
        priority="MEDIUM",
        source=f"{PLATFORM}-next-step-{parent_incident[-12:]}" if parent_incident
               else f"{PLATFORM}-next-step",
        target_account_id=target_account_id,
        incident_id=incident_id,
    )
    if not result.get("success"):
        logger.error("next_step dispatch failed: %s", result)
        client.chat_postEphemeral(
            channel=channel_id,
            user=(body.get("user") or {}).get("id", ""),
            text=i18n.t("main.dispatch_failed_short", next_step_locale,
                        status=result.get("error", "")),
        )
        return

    try:
        ddb_state.link_incident(synth_event_id, incident_id, platform=PLATFORM,
                                task_id=result.get("task_id"))
    except Exception as e:
        logger.warning("next_step DDB writes failed: %s", e)

    client.chat_postMessage(
        channel=channel_id, thread_ts=thread_ts,
        text=i18n.t("main.next_step.report_pending", next_step_locale,
                    query=query),
    )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
def main() -> None:
    handler = SocketModeHandler(app, SLACK_APP_TOKEN)

    # Start the progress poller daemon. It scans the shared
    # Conversations table for `progress#*` rows belonging to platform
    # "slack" and patches the live investigation card with new tool
    # calls + Bedrock narratives every ~20s. Daemon thread; dies with
    # the process. Required IAM: aidevops:ListJournalRecords (added in
    # template.yaml).
    try:
        from core import progress_poller
        from platforms.slack.app import progress_sender
        progress_poller.run(platform=PLATFORM,
                            update_live_card=progress_sender.update_live_card,
                            finalize_card=progress_sender.update_live_card)
        logger.info("Progress poller started")
    except Exception as e:
        logger.warning("Progress poller failed to start: %s", e)

    logger.info("Starting Slack Socket Mode handler…")
    handler.start()


if __name__ == "__main__":
    main()
