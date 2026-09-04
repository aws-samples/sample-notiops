"""
Feishu (Lark) long-connection bot for NotiOps.

Long-lived process: connects outbound to open.feishu.cn over WebSocket,
handles `im.message.receive_v1` (mention messages) and `card.action.trigger`
(button clicks). Mirrors the Slack Socket Mode bot but uses Feishu's
official `lark-oapi` SDK and Feishu interactive cards.

No public ingress endpoint required.
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading

import boto3
import lark_oapi as lark
from lark_oapi.api.im.v1 import (
    P2ImMessageReceiveV1,
)
from lark_oapi.event.callback.model.p2_card_action_trigger import (
    P2CardActionTrigger,
    P2CardActionTriggerResponse,
)

from platforms.feishu.app import skill_commands
from core import bedrock_intent
from core import nl_router
from core import chat_history
from core import ddb_state
from core import dispatch_compose
from core import i18n
from core.feishu_card import card_config
from core import locale_resolver
# webhook_dispatch is retained ONLY for skill_commands' `/skills run` path,
# which still POSTs to the single fixed Agent Space. The @-mention
# investigate path below uses idle's cross-account STS+API instead — see
# the dispatch rationale block in on_card_action / _handle_edit_dispatch_submit.
from core import webhook_dispatch
from core import skill_registry
from core import skill_dispatcher
from core import llm_pref_resolver
from core import model_catalog
from shared.devops_agent import create_investigation
from platforms.feishu.app import feishu_utils

PLATFORM = "feishu"

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)


_STRONG_CHANGE_RE = re.compile(
    # Tight regex for "absolutely a change request" patterns that should
    # override an LLM verdict of investigate. Used as the third arm of
    # the hybrid LLM+regex change-detection in on_message.
    #
    # Covers:
    #   1. Bare imperative + AWS resource id  ("delete i-0123" / "stop vol-...")
    #   2. AWS CLI mutation                    ("aws ec2 stop-instances ...")
    #   3. Terraform / kubectl mutations       ("terraform apply" / "kubectl delete")
    #   4. Prompt-injection role-play patterns (defense in depth)
    r"\b(delete|remove|stop|terminate|destroy|drop|kill|reboot|restart|shutdown)\s+"
    r"(?:the\s+|a\s+|an\s+)?"
    r"(?:i|vol|vpc|sg|snap|subnet|nat)-[0-9a-f]{6,17}"
    r"|\baws\s+\S+\s+(?:delete|put|create|update|modify|attach|detach|"
    r"start|stop|reboot|terminate|run|associate|disassociate|enable|disable|"
    r"register|deregister)[a-z\-]*"
    r"|\bterraform\s+(?:apply|destroy|taint|import)\b"
    r"|\bkubectl\s+(?:apply|create|delete|patch|edit|scale|rollout|exec|drain)\b"
    # Prompt-injection bypass attempts — caught regardless of LLM verdict
    r"|假装你是\s*admin|pretend\s+you\s+are\s+admin|忽略前面|"
    r"ignore\s+(?:the\s+)?previous|disregard\s+(?:the\s+)?previous",
    re.IGNORECASE,
)


def _looks_strongly_change(text: str) -> bool:
    """High-precision regex check for unambiguous change requests, used
    as the third arm of the hybrid LLM+regex change-detection layer.

    This is *narrower* than `bedrock_chat._is_change_request()` — it
    only catches patterns that no semantically-aware reader would
    classify as anything but a mutation imperative. The wider regex
    serves as the no-LLM fallback path; this one as the override-LLM path.
    """
    if not text:
        return False
    return bool(_STRONG_CHANGE_RE.search(text))

ALLOWED_CHAT_IDS = {
    c.strip() for c in os.environ.get("ALLOWED_CHAT_IDS", "").split(",") if c.strip()
}

# Resolve credentials at startup (fail fast)
# Unified credential loading: Dashboard UI → Secrets Manager JSON → env injection
# Format: {"app_id": "cli_xxx", "app_secret": "xxx", ...}
_sm = boto3.client("secretsmanager")
_feishu_secret = json.loads(
    _sm.get_secret_value(
        SecretId=os.environ.get("FEISHU_SECRET_NAME", "notiops/im-bot-feishu")
    )["SecretString"]
)
APP_ID = _feishu_secret["app_id"]
APP_SECRET = _feishu_secret["app_secret"]


# ===========================================================================
# Event: im.message.receive_v1 (user @ the bot, or DMs the bot)
# ===========================================================================
# zh + en command words. This regex only carries the ASCII alternates so
# `scripts/lint_i18n.py` stays clean on this file; the Chinese aliases live
# in `core/nl_router.py` (which IS allowlisted for CJK literals) and are
# folded in via `_maybe_handle_language_command` → `nl_router.parse_command`.
_LANGUAGE_CMD_RE = re.compile(
    r"^\s*/?\s*(?:language|lang)(?:\s+(\S+))?\s*$",
    re.IGNORECASE,
)


def _maybe_handle_language_command(msg, raw_text: str, user_id: str,
                                    locale: str) -> bool:
    """Detect and handle `/language [zh|en|auto]` from a Feishu user,
    OR a natural-language language-switch request like "切换到英文" /
    "switch to english". Returns True if the message was handled (a
    reply was already sent); caller should then return early. False
    otherwise.
    """
    m = _LANGUAGE_CMD_RE.match(raw_text or "")
    # zh command alias (`/语言`) is caught here — the ASCII-only regex above
    # is deliberate (see the CJK-lint note where it's defined). NL path stays
    # as before.
    zh_cmd_arg: str = ""
    if not m:
        _route = nl_router.parse_command(raw_text or "")
        if _route.kind == "language":
            zh_cmd_arg = _route.arg
    nl_target = "" if (m or zh_cmd_arg) else i18n.parse_language_switch_intent(raw_text or "")
    if not m and not zh_cmd_arg and not nl_target:
        return False
    if not user_id:
        feishu_utils.reply_text(msg.message_id,
                                i18n.t("main.failed_user_id", locale),
                                in_thread=msg.chat_type != "p2p")
        return True
    # Natural-language path produces a definite zh/en target; the
    # explicit `/language` form may have no arg (= show current).
    if nl_target:
        arg = nl_target
    elif m:
        arg = i18n.normalize_locale(m.group(1)) if m.group(1) else ""
    else:
        arg = i18n.normalize_locale(zh_cmd_arg) if zh_cmd_arg else ""
    if not arg:
        # Show current.
        cur, source = locale_resolver.resolve(user_id=user_id,
                                              platform=PLATFORM,
                                              text=raw_text)
        name = i18n.locale_name(cur, cur)
        if source == "user":
            text = i18n.t("lang.current.user", cur, name=name)
        else:
            text = i18n.t("lang.current.auto", cur, name=name)
        text += "\n" + i18n.t("lang.usage", cur)
        _reply(msg, text)
        return True
    if arg == "auto":
        ok = locale_resolver.set_user_pref(user_id, "auto",
                                           platform=PLATFORM)
        _reply(msg, i18n.t("lang.unset", locale) if ok
                    else i18n.t("lang.unset_failed", locale))
        return True
    if arg in {"zh", "en"}:
        ok = locale_resolver.set_user_pref(user_id, arg,
                                           platform=PLATFORM)
        name = i18n.locale_name(arg, arg)
        _reply(msg, i18n.t("lang.set.user", arg, name=name) if ok
                    else i18n.t("lang.set_failed", locale))
        return True
    _reply(msg, i18n.t("lang.usage", locale))
    return True


# `@bot model [alias|list|default]` — anyone in chat can switch model
# for that chat. Same short-circuit pattern as the language command.
# ASCII-only regex; the `/模型` Chinese alias is folded in via
# `nl_router.parse_command` below (see the language cmd note for why).
_MODEL_CMD_RE = re.compile(
    r"^\s*/?\s*model(?:\s+(\S+))?\s*$",
    re.IGNORECASE,
)


def _maybe_handle_model_command(msg, raw_text: str, chat_id: str,
                                 user_id: str, locale: str) -> bool:
    """Handle `model` / `model list` / `model <alias>` / `model default`.

    Returns True when the message was a model command (and we already
    sent a reply); caller returns early. False when the message wasn't
    one and should fall through to normal intent classification.
    """
    m = _MODEL_CMD_RE.match(raw_text or "")
    is_dm = msg.chat_type == "p2p"
    # zh command alias (`/模型 …`) via the shared router (kept out of the
    # ASCII regex above to keep this file CJK-clean for the i18n lint).
    zh_cmd_arg: str = ""
    if not m:
        _route = nl_router.parse_command(raw_text or "")
        if _route.kind == "model":
            zh_cmd_arg = _route.model_arg
    if not m and not zh_cmd_arg:
        # Natural-language "换个模型" / "switch model" — can't name a specific
        # alias (aliases are dynamic), so surface the list and let the user
        # pick. 0 token: pure regex, runs before Bedrock.
        if not nl_router.parse_model_switch_intent(raw_text or ""):
            return False
        rows = "\n".join(
            i18n.t("model.list_row", locale, alias=e.alias, label=e.label)
            for e in model_catalog.all_entries()
        )
        text = (i18n.t("model.switch_nl_hint", locale) + "\n" + rows
                + "\n\n" + i18n.t("model.usage", locale))
        _reply(msg, text)
        return True

    arg = ((m.group(1) if m else zh_cmd_arg) or "").strip().lower()

    if not arg:
        # show current
        alias, source = llm_pref_resolver.resolve(
            platform=PLATFORM, chat_id=chat_id, user_id=user_id, is_dm=is_dm,
        )
        entry = model_catalog.get(alias)
        text = i18n.t("model.current", locale,
                      label=entry.label, source=source)
        text += "\n" + i18n.t("model.usage", locale)
        _reply(msg, text)
        return True

    if arg == "list":
        rows = "\n".join(
            i18n.t("model.list_row", locale, alias=e.alias, label=e.label)
            for e in model_catalog.all_entries()
        )
        text = i18n.t("model.list_header", locale) + "\n" + rows
        text += "\n\n" + i18n.t("model.usage", locale)
        _reply(msg, text)
        return True

    if arg == "default":
        if is_dm:
            llm_pref_resolver.clear_dm_pref(PLATFORM, user_id)
        else:
            llm_pref_resolver.clear_chat_pref(PLATFORM, chat_id)
        _reply(msg, i18n.t("model.cleared", locale))
        return True

    if not model_catalog.is_known(arg):
        _reply(msg, i18n.t("model.unknown", locale,
                            alias=arg,
                            valid=", ".join(model_catalog.list_aliases())))
        return True

    # Set the preference. DM scope vs chat scope based on chat_type.
    if is_dm:
        ok = llm_pref_resolver.set_dm_pref(PLATFORM, user_id, arg)
    else:
        ok = llm_pref_resolver.set_chat_pref(PLATFORM, chat_id, arg)

    if not ok:
        _reply(msg, i18n.t("model.set_failed", locale))
        return True

    entry = model_catalog.get(arg)
    msg_key = "model.set_dm" if is_dm else "model.set_chat"
    _reply(msg, i18n.t(msg_key, locale, label=entry.label))
    return True


def _help_text(locale: str) -> str:
    """Bilingual command menu, rendered from the i18n `help.*` keys.

    Lists BOTH language forms of every command — a Chinese user won't guess
    `/调查` exists unless we tell them.
    """
    rows = "\n".join(
        i18n.t(f"help.row.{feature}", locale)
        for feature, _en, _zh in nl_router.HELP_COMMANDS
    )
    return (f"**{i18n.t('help.title', locale)}**\n\n"
            f"{i18n.t('help.intro', locale)}\n\n"
            f"{rows}\n\n"
            f"{i18n.t('help.footer', locale)}")


def _maybe_handle_help_command(msg, raw_text: str, locale: str) -> bool:
    """Handle `/help` / `/帮助` / bare `怎么用` — the command menu.

    Deterministic, 0 token. Returns True if handled (reply already sent).
    Discoverability is a hard requirement once routing is deterministic:
    without it the new command forms effectively don't exist.
    """
    if nl_router.parse_command(raw_text or "").kind != "help":
        return False
    _reply(msg, _help_text(locale))
    return True


def _reply(msg, text: str) -> dict:
    """Reply to ``msg`` choosing the right rendering automatically:

      • Group chat (chat_type != "p2p"): thread the reply so the main
        timeline stays clean — chitchat / refusals / "正在理解" all go
        into a Feishu 话题.
      • DM (chat_type == "p2p"): no thread — DMs are 1:1 so threading
        adds an extra click without any chat-noise benefit.

    Centralizing the decision here lets us call `_reply(msg, text)`
    from every error / status / chitchat reply site without each one
    knowing about Feishu thread semantics.
    """
    in_thread = msg.chat_type != "p2p"
    return feishu_utils.reply_text(msg.message_id, text, in_thread=in_thread)


def on_message(event: P2ImMessageReceiveV1) -> None:
    msg = event.event.message
    sender = event.event.sender

    chat_id = msg.chat_id
    if ALLOWED_CHAT_IDS and chat_id not in ALLOWED_CHAT_IDS:
        logger.info("Chat %s not in allowlist; ignoring", chat_id)
        return

    # Thread-continuity: if this message is inside a Feishu thread that
    # the bot has already replied in, treat it as a follow-up regardless
    # of whether the user @-mentioned us. The main timeline still
    # requires an explicit @-mention to avoid spamming the channel.
    root_id = getattr(msg, "root_id", "") or ""
    in_bot_thread = bool(root_id) and ddb_state.is_bot_thread(PLATFORM, root_id)

    # Resolve a preliminary locale for any pre-text-validation replies
    # below (e.g. "I only handle text" / "send me a command"). At this
    # point we have no message content to auto-detect from, so we fall
    # back to user-pref → env default. Real per-message resolve happens
    # again after raw_text is known.
    _early_user_id = ""
    try:
        if sender and sender.sender_id:
            _early_user_id = sender.sender_id.open_id or ""
    except AttributeError:
        pass
    _early_locale, _ = locale_resolver.resolve(
        user_id=_early_user_id, platform=PLATFORM,
        is_dm=(msg.chat_type == "p2p"),
        thread_root_id=root_id or "", text="",
    )

    if msg.message_type != "text":
        # Only nag about format if the user @-ed the bot directly,
        # was in a bot-touched thread, or DM-ing the bot. Silent
        # otherwise so we don't spam non-targeted group messages.
        if _is_bot_mentioned(msg) or msg.chat_type == "p2p" or in_bot_thread:
            _reply(msg, i18n.t("main.unsupported_msg_type", _early_locale))
        return

    # In group chats: only respond when explicitly @-mentioned, OR when
    # the message is a follow-up inside a thread the bot is already in.
    # DMs (p2p) are always treated as commands.
    if msg.chat_type != "p2p" and not _is_bot_mentioned(msg) and not in_bot_thread:
        return

    raw_payload = json.loads(msg.content)
    raw_text = feishu_utils.strip_at_mention(raw_payload.get("text", ""))
    if not raw_text:
        _reply(msg, i18n.t("main.usage_hint", _early_locale))
        return

    event_id = event.header.event_id
    user_id = sender.sender_id.open_id if sender and sender.sender_id else ""

    is_dm = msg.chat_type == "p2p"
    # `/language [zh|en|auto]` short-circuit — Feishu has no native
    # slash commands so we accept the same syntax as a plain @-mention
    # message. Bypass intent classification + Bedrock so users who
    # don't speak the bot's current locale can still escape.
    #
    # Must run BEFORE locale_resolver.resolve() below — otherwise the
    # auto-detect on this message ("language en" is pure ASCII → en)
    # would write a fresh DM lock to en *before* set_user_pref runs,
    # and the user would still see English replies after typing
    # "language auto". Pre-resolve here using only user-pref + locks
    # (no auto-detect) so we render the command's confirmation reply
    # in the right language.
    _pre_locale, _ = locale_resolver.resolve(
        user_id=user_id, platform=PLATFORM, is_dm=is_dm,
        thread_root_id=root_id or "", text="",
    )
    if _maybe_handle_language_command(msg, raw_text, user_id, _pre_locale):
        return

    # `@bot model [alias|list|default]` short-circuit — same pattern,
    # different DDB row prefix. Anyone in the chat can switch (no
    # admin gate, per product decision 2026-06-05).
    if _maybe_handle_model_command(msg, raw_text, chat_id, user_id, _pre_locale):
        return

    # `/help` / `/帮助` / `怎么用` — the command menu. Deterministic, 0 token.
    # Runs here (before Bedrock) so commands stay discoverable now that
    # routing is deterministic. See §8.1.3.
    if _maybe_handle_help_command(msg, raw_text, _pre_locale):
        return

    # Resolve conversation locale BEFORE the event row is written so
    # everything downstream (ack / refusal / chat / dispatch / Lambda
    # senders) reads the same locale. Priority: user-pref → thread/
    # incident lock → DM lock → auto-detect → env default → "en". See
    # core/locale_resolver.py.
    locale, locale_source = locale_resolver.resolve(
        user_id=user_id, platform=PLATFORM, is_dm=is_dm,
        thread_root_id=root_id or "", text=raw_text,
    )
    logger.info("locale=%s source=%s", locale, locale_source)
    if locale_source == "auto":
        if is_dm:
            locale_resolver.lock_for_dm(PLATFORM, user_id, locale)
        elif root_id:
            locale_resolver.lock_for_thread(PLATFORM, root_id, locale)

    # `/skills ...` short-circuit — same pattern as slack.
    if not ddb_state.put_new_event(event_id, platform=PLATFORM, chat_id=chat_id,
                                   root_message_id=msg.message_id,
                                   user_id=user_id, raw_text=raw_text,
                                   locale=locale):
        logger.info("Duplicate event %s — skipped", event_id)
        return

    # `/skills ...` short-circuit — AFTER the duplicate-event guard so a
    # message delivered more than once is handled exactly once. (BUG-2 fix.)
    if skill_commands.maybe_handle_skill_command(
            msg, chat_id=chat_id, user_id=user_id,
            event_id=msg.message_id, raw_text=raw_text, locale=locale):
        return

    # Mark this Feishu thread as bot-active so subsequent follow-ups
    # in the same thread can be processed without a fresh @-mention.
    # If the user is already in a thread (root_id set), use that;
    # otherwise the bot's first reply to message_id becomes the new
    # thread's root.
    _bot_thread_root = root_id or msg.message_id
    ddb_state.mark_bot_thread(PLATFORM, _bot_thread_root)
    # Also lock this thread root if we just resolved by auto-detect —
    # this is the first message in a NEW thread the bot is starting.
    if locale_source == "auto" and not root_id and msg.message_id:
        locale_resolver.lock_for_thread(PLATFORM, msg.message_id, locale)

    # Authoring-intent nudge (Option A): "write me a skill" is not a run/
    # investigate request — point the user to the admin `/skills create` path.
    # Admin-aware (_is_admin returns True in open mode, i.e. SKILLS_ADMINS unset).
    if skill_dispatcher.looks_like_authoring_request(raw_text):
        _key = ("skill.author.hint" if skill_commands._is_admin(user_id)
                else "skill.author.denied")
        _reply(msg, i18n.t(_key, locale))
        return

    # ── Deterministic 0-token routing (core.nl_router) ───────────────────
    # Explicit case commands (`/案例` `/case` …) and clearly-worded NL case
    # requests ("我要开案例" / "open a case") route STRAIGHT to the case flow
    # with NO Bedrock classify — that's the token the IM refactor cuts. An
    # explicit investigate command (`/调查 …` `/investigate …`) forces the
    # investigate route so an unambiguous signal can never be misclassified.
    #
    # Guard: if the text also trips the strong-change regex, DON'T shortcut —
    # fall through to the normal hybrid change-request check so the read-only
    # guarantee (§8.3) still refuses mutations deterministically.
    _route = nl_router.classify(raw_text)
    _force_investigate = False
    if _route.kind in ("case", "investigate") and not _looks_strongly_change(raw_text):
        if _route.kind == "case":
            from platforms.feishu.app import case_flow
            cc, cid = _route.case_command, _route.case_id
            logger.info("nl_router: case route command=%s id=%s form=%s (0 token)",
                        cc, cid, _route.form)
            if cc == "case_view":
                case_flow.start_view(chat_id, cid, locale=locale)
            elif cc == "case_reply":
                case_flow.start_reply(chat_id, cid, raw_text, locale=locale)
            elif cc == "case_resolve":
                case_flow.start_resolve(chat_id, cid, locale=locale)
            elif cc == "case_analyze":
                case_flow.start_analyze(chat_id, cid, locale=locale)
            elif cc == "case_create":
                case_flow.start_create(chat_id, raw_text, locale=locale)
            else:  # case_list + any unmapped canonical
                case_flow.start_list(chat_id, status_filter="recent", locale=locale)
            return
        # investigate — only the explicit COMMAND form forces the route (an
        # unambiguous user signal). NL deep-dive phrasings still flow through
        # analyze_intent, which already routes them AND fills `suggestions`.
        if _route.form == "command":
            _investigate_text = _route.arg.strip()
            if _investigate_text:
                # Strip the `/调查` prefix so the investigation is about the
                # request, not the command word. Persist so confirm_dispatch
                # (which reads the row) dispatches the clean text.
                raw_text = _investigate_text
                try:
                    ddb_state._table.update_item(
                        Key={"lookup_key": f"event#{event_id}"},
                        UpdateExpression="SET raw_text = :t",
                        ExpressionAttributeValues={":t": raw_text},
                    )
                except Exception as e:
                    logger.warning("nl_router: persist investigate text failed: %s", e)
            _force_investigate = True
            logger.info("nl_router: investigate command route (forced)")

    _reply(msg, i18n.t("ack.understanding", locale))

    # ZERO-CHANGE PROMISE — Hybrid LLM + regex architecture.
    #
    # 主判:LLM 在 `analyze_intent()` 里输出 `is_change_request` 字段
    #         (semantic-aware,理解 "调查 EC2 重启历史" 是 read-only)。
    # 兜底:LLM 失败 / Bedrock 报错 / 客户禁用 LLM → 用正则。
    #
    # 设计原则(纵深防御):
    #   - LLM 是主信号(精确,低误伤,理解上下文)
    #   - 正则是 fallback + prompt-injection 防线(快,确定性)
    #   - 两层都通过才放行;任何一层 flag 即拒绝
    #
    # 这里先做 LLM 分类,然后在分类结果后判断变更请求 — 这样可以
    # 让 LLM 的语义理解参与决策,而不是在它之前用正则一刀切。
    #
    # Multi-turn chat history was retired — each message
    # is classified independently of prior turns.
    analysis = bedrock_intent.analyze_intent(raw_text, locale=locale)
    intent = analysis["intent"]
    suggestions = analysis.get("suggestions", [])
    command = analysis.get("command", "investigate")
    # An explicit `/调查 …` command overrides the classifier — the user named
    # the route, so it must win even if Bedrock would have guessed otherwise.
    if _force_investigate:
        command = "investigate"
    case_display_id = analysis.get("case_display_id", "")
    # Multi-turn rewrite (#1) was retired — these locals always stay
    # at the no-rewrite values. Kept (rather than ripped out) so the
    # dispatch text + confirmation card construction below stays
    # untouched. The conditional `if references_prior else ...`
    # branches always take the False arm; that's the desired behaviour.
    references_prior = False
    rewritten_text = ""

    # === ZERO-CHANGE check (LLM 主判 + 正则兜底)===
    # LLM 判定 — 来自 analyze_intent() 的 is_change_request 字段。
    # LLM 失败时(Bedrock 异常等)analyze_intent 走 fallback,这个字段
    # 仍然存在(默认 False),此时我们必须用正则补刀。
    llm_says_change = bool(analysis.get("is_change_request", False))
    is_chitchat_shortcut = analysis.get("_source") == "chitchat_shortcut"
    try:
        from core import bedrock_chat as _bc
        # 正则兜底总是跑 — 防 LLM 漏判(prompt injection / 极短指令等)
        regex_says_change = _bc._is_change_request(raw_text)
    except Exception as e:
        logger.warning("regex change-request fallback failed: %s", e)
        regex_says_change = False

    # chitchat 短路路径不调 Bedrock,LLM 信号无效 → 正则说了算
    if llm_says_change or (is_chitchat_shortcut and regex_says_change) or \
            (not llm_says_change and regex_says_change and command == "investigate"
             and _looks_strongly_change(raw_text)):
        # 命中条件:
        #   (a) LLM 明确说是变更请求
        #   (b) chitchat 短路路径下,正则兜底说是变更
        #   (c) LLM 走了 investigate(可能误判),但正则在 raw_text 里
        #       看到了非常确凿的变更模式(短动词+资源 ID / role-play 注入)
        logger.info("change-request rejected (llm=%s regex=%s command=%s)",
                    llm_says_change, regex_says_change, command)
        _reply(msg, i18n.t("refusal.change_request", locale))
        return

    logger.info("Classified intent: command=%s case_display_id=%s",
                command, case_display_id)

    # Branch on command.
    #
    # Conversational commands (chitchat / general_qa) — gated behind
    # `AGENTIC_CHAT_MODE`. We double-check the env here even though
    # the intent layer also gates: belt-and-suspenders means a stale
    # prompt cache or a misclassification can never accidentally route
    # casual chat into a real dispatch. The actual reply is generated
    # by `core.bedrock_chat.respond()` which enforces the read-only
    # boundary (inbound regex + system prompt + outbound audit).
    if command in {"chitchat", "general_qa"}:
        _agentic_mode = (os.environ.get("AGENTIC_CHAT_MODE") or "").strip().lower()
        if _agentic_mode in {"enabled", "qa_only"}:
            try:
                from core import bedrock_chat
                # chitchat_count was wired up for the soft "回到主题"
                # nudge after several non-action turns. With history
                # retired we no longer track it; pass 0 → no nudge,
                # which is fine: the bot stays patient & helpful.
                reply = bedrock_chat.respond(
                    raw_text, command=command,
                    chitchat_count=0,
                    locale=locale,
                    platform=PLATFORM,
                    chat_id=chat_id,
                    user_id=user_id,
                    is_dm=is_dm,
                )
                if reply:
                    _reply(msg, reply)
                    return
            except Exception as e:
                logger.warning("bedrock_chat.respond failed: %s", e)
        # If we reach here either the mode is disabled, or respond()
        # returned empty / threw — fall through to investigate so the
        # user is never silently dropped.
        logger.info("agentic chat path declined (mode=%s, command=%s) — "
                    "falling through to investigate", _agentic_mode, command)
        command = "investigate"

    # query command — read existing DDB results and reply immediately.
    if command == "query":
        from platforms.feishu.app.query_handler import handle as query_handle
        query_type = analysis.get("query_type", "health_report")
        result = query_handle(query_type, chat_id=chat_id, locale=locale)
        if result:
            _reply(msg, result)
            return
        # If query returned None, fall through to investigate
        command = "investigate"

    # case_* commands skip the dispatch-confirmation card entirely and
    # go straight to the matching case_flow entry point.
    if command == "case_create":
        from platforms.feishu.app import case_flow
        case_flow.start_create(chat_id, raw_text, locale=locale)
        return
    if command == "case_list":
        from platforms.feishu.app import case_flow
        case_flow.start_list(chat_id,
                             status_filter=analysis.get("case_filter") or "recent",
                             locale=locale)
        return
    if command == "case_view":
        from platforms.feishu.app import case_flow
        case_flow.start_view(chat_id, case_display_id, locale=locale)
        return
    if command == "case_reply":
        from platforms.feishu.app import case_flow
        case_flow.start_reply(chat_id, case_display_id, raw_text,
                              locale=locale)
        return
    if command == "case_resolve":
        from platforms.feishu.app import case_flow
        case_flow.start_resolve(chat_id, case_display_id, locale=locale)
        return
    if command == "case_analyze":
        from platforms.feishu.app import case_flow
        case_flow.start_analyze(chat_id, case_display_id, locale=locale)
        return

    # Default: investigate path — skip the old "confirm intent" middle
    # step and send the editable "Start an investigation" form card
    # directly. Mirrors Slack's inline-form flow so behaviour is the
    # same on both platforms: the user can keep all defaults and click
    # submit, or edit anything before dispatching.
    dispatch_text = rewritten_text if (references_prior and rewritten_text) else raw_text

    # ── Skill auto-dispatch ──────────────────────────────────────────────
    # Match the message to a saved skill. select() is fail-safe: any error /
    # low confidence / no match → None, and we fall through to the normal
    # free-form investigation card. The user never sees a skill id.
    skill_card = None
    try:
        decision = skill_dispatcher.select(raw_text, locale=locale)
    except Exception as e:
        logger.warning("skill_dispatch.select crashed (%s) → free-form", e)
        decision = None
    if decision:
        # Defensive: if compose/persist/card-build fails, fall back to a
        # free-form card so a mention always gets a card.
        try:
            composed = skill_dispatcher.compose_payload(decision)
            try:
                _catalogue = skill_registry.list_skills(status="active")
            except Exception:
                _catalogue = None
            _card = skill_dispatcher.describe_decision(
                decision, event_id, locale=locale, catalogue=_catalogue)
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

    card = _edit_dispatch_card(event_id=event_id,
                               intent=intent or raw_text,
                               suggestions=suggestions,
                               locale=locale, skill_card=skill_card)
    # Send confirmation card directly to the chat (not as a thread reply) —
    # Feishu hides thread replies behind a collapsed "1 reply" link by default,
    # so users miss the buttons. Card goes to main timeline; users still see the
    # context via the @ in original message.
    resp = feishu_utils.send_card(chat_id=chat_id, card=card)
    logger.info("send_card resp code=%s, message_id=%s",
                resp.get("code"), resp.get("data", {}).get("message_id"))
    if resp.get("code") == 0:
        prompt_msg_id = resp.get("data", {}).get("message_id", "")
        ddb_state.update_intent(event_id, intent, prompt_msg_id)
        # Persist the rewritten text so confirm_dispatch picks it up.
        # We piggyback on the existing event row (it already has raw_text);
        # writing back to the same row is cheap and keeps things atomic.
        if dispatch_text != raw_text:
            try:
                ddb_state._table.update_item(
                    Key={"lookup_key": f"event#{event_id}"},
                    UpdateExpression="SET raw_text = :t",
                    ExpressionAttributeValues={":t": dispatch_text},
                )
            except Exception as e:
                logger.warning("Failed to persist rewritten text: %s", e)
    else:
        logger.error("send_card failed: %s", resp)
        _reply(msg, i18n.t("main.send_card_failed", locale,
                           detail=resp.get("msg", resp)))


# ===========================================================================
# Event: card.action.trigger (user clicked confirm/cancel button)
# ===========================================================================
def on_card_action(event: P2CardActionTrigger) -> P2CardActionTriggerResponse:
    """
    Handle button clicks. Must return P2CardActionTriggerResponse.

    Cards refresh in two ways:
      1. PATCH /im/v1/messages/{id}  (works but flaky in some chat types)
      2. Return {"card": {...}} in the trigger response — Feishu client
         updates the card in place. This is the recommended approach for
         interactive flows and is what we use here.
    """
    action = event.event.action
    action_value = (action.value or {}) if action else {}
    action_tag = action_value.get("action") if isinstance(action_value, dict) else ""
    event_id = action_value.get("event_id") if isinstance(action_value, dict) else ""

    logger.info("card.action.trigger received: action=%s event_id=%s",
                action_tag, event_id)

    operator_name = ""
    try:
        operator_name = event.event.operator.operator_name or ""
    except AttributeError:
        pass

    # Route support-related actions to a dedicated handler
    if action_tag in ("ask_support", "confirm_support", "cancel_support"):
        try:
            from platforms.feishu.app import support_flow
            # Resolve the conversation locale so the support flow's toasts
            # / cards / inline messages render in the user's language.
            # Priority: incident row's locale (set when investigation was
            # dispatched), then event row's locale, then zh fallback.
            incident_id = (action_value.get("incident_id", "")
                           if isinstance(action_value, dict) else "")
            convo_locale = "zh"
            try:
                if incident_id:
                    row = ddb_state.get_by_incident(incident_id)
                    if row and (row.get("locale") or "").strip():
                        convo_locale = row["locale"].strip().lower()
                if convo_locale == "zh" and event_id:
                    convo = ddb_state.get_by_event(event_id)
                    if convo and (convo.get("locale") or "").strip():
                        convo_locale = convo["locale"].strip().lower()
            except Exception as e:
                logger.warning("locale lookup for support action failed: %s", e)
            if convo_locale not in {"zh", "en"}:
                convo_locale = "zh"
            return support_flow.handle(action_tag, action_value, event,
                                       operator_name=operator_name,
                                       locale=convo_locale)
        except Exception as e:
            logger.exception("support_flow crashed: %s", e)
            # NOTE: do NOT add `from core import i18n` here — Python
            # treats any rebinding of `i18n` inside this function as a
            # function-local, which then shadows the module-level
            # import on EVERY branch (UnboundLocalError on the cancel
            # path). The top-of-file `from core import i18n` already
            # makes the module available in this scope.
            return _toast(i18n.t("support.toast.flow_crashed", "zh",
                                 kind=type(e).__name__))  # Security: detail → CloudWatch

    # "Next step" dispatch from a report card — triggered by a Bedrock-
    # generated suggestion button. Spin up a brand-new investigation
    # using the suggested query as the user_text, with a synthesized
    # event/incident_id so the chat-history and report-handler routing
    # all work the same as a manually-typed @mention.
    if action_tag == "next_step_dispatch":
        try:
            return _handle_next_step_dispatch(action_value, event)
        except Exception as e:
            logger.exception("next_step_dispatch crashed: %s", e)
            # No event_id context here yet; default to zh for backwards
            # compat with legacy convos. Most users dispatching next-
            # step buttons clicked from a report card we already wrote
            # in their language.
            return _toast(i18n.t("main.dispatch_thread_failed", "zh",
                                  kind=type(e).__name__))  # Security: detail → CloudWatch

    # Route case-management actions (create / list / view / reply / resolve)
    if action_tag and action_tag.startswith("case_"):
        try:
            from platforms.feishu.app import case_flow
            # Resolve the conversation locale for handler-rendered text
            # (toasts, result/pending cards). Priority: the original
            # event row's locale (the same one set on intake), then a
            # default of zh for legacy convos pre-dating multi-locale.
            convo_locale = "zh"
            try:
                if event_id:
                    convo = ddb_state.get_by_event(event_id)
                    if convo and (convo.get("locale") or "").strip():
                        convo_locale = convo["locale"].strip().lower()
            except Exception as e:
                logger.warning("locale lookup for case action failed: %s", e)
            if convo_locale not in {"zh", "en"}:
                convo_locale = "zh"
            return case_flow.handle(action_tag, action_value, event,
                                    operator_name=operator_name,
                                    locale=convo_locale)
        except Exception as e:
            logger.exception("case_flow crashed: %s", e)
            return _toast(i18n.t("main.case_flow_crashed", convo_locale,
                                  kind=type(e).__name__))  # Security: detail → CloudWatch

    # Route the "📝 编辑后派发" path — replace the confirmation card
    # with a form card so the user can edit before dispatching.
    if action_tag == "edit_dispatch":
        convo = ddb_state.get_by_event(event_id) or {}
        convo_locale = (convo.get("locale") or "zh").strip().lower()
        if convo_locale not in {"zh", "en"}:
            convo_locale = "zh"
        intent = convo.get("intent_summary") or convo.get("raw_text") or ""
        try:
            analysis = bedrock_intent.analyze_intent(
                convo.get("raw_text") or "", locale=convo_locale)
            suggestions = analysis.get("suggestions", []) or []
        except Exception as e:
            logger.warning("re-analysis for edit form failed: %s", e)
            suggestions = []
        return _build_response(
            "edit-dispatch",
            _edit_dispatch_card(event_id=event_id, intent=intent,
                                suggestions=suggestions, locale=convo_locale),
        )

    if action_tag == "edit_dispatch_submit":
        return _handle_edit_dispatch_submit(action_value, event)

    # ── Authoring confirm-card button callbacks (save/edit/edit-submit/cancel) ─
    if action_tag in (skill_commands.ACTION_SAVE, skill_commands.ACTION_EDIT,
                      skill_commands.ACTION_EDIT_SUBMIT, skill_commands.ACTION_CANCEL):
        try:
            if action_tag == skill_commands.ACTION_SAVE:
                return skill_commands.handle_author_save(action_value, event, event_id)
            if action_tag == skill_commands.ACTION_EDIT:
                return skill_commands.handle_author_edit(action_value, event, event_id)
            if action_tag == skill_commands.ACTION_EDIT_SUBMIT:
                return skill_commands.handle_author_edit_submit(action_value, event, event_id)
            return skill_commands.handle_author_cancel(action_value, event, event_id)
        except Exception as e:
            logger.exception("skill authoring action crashed: %s", e)
            return _toast(i18n.t("skill.error.unexpected", "zh"))  # Security: detail → CloudWatch

    # ── 🔄 Switch skill: user picked a different skill from the body picker ──
    if action_tag == skill_dispatcher.ACTION_SWITCH_SKILL:
        return _handle_skill_switch(action_value, event, event_id)

    # ── ❌ Don't use a skill: drop the match, fall back to free-form ────────
    if action_tag == skill_dispatcher.ACTION_DONT_USE_SKILL:
        return _handle_skill_dont_use(event_id)

    if action_tag not in ("confirm_dispatch", "cancel_dispatch"):
        # Best-effort locale lookup — toast text is short, en fallback ok.
        _toast_locale = "zh"
        try:
            if event_id:
                _convo = ddb_state.get_by_event(event_id)
                if _convo and (_convo.get("locale") or "").strip():
                    _toast_locale = _convo["locale"].strip().lower()
        except Exception:
            pass
        if _toast_locale not in {"zh", "en"}:
            _toast_locale = "zh"
        return _toast(i18n.t("main.unknown_action", _toast_locale))

    convo = ddb_state.get_by_event(event_id)
    # Locale comes from the row written at intake; fall back to zh
    # because legacy convos pre-dating multi-locale stored Chinese text.
    convo_locale = ((convo or {}).get("locale") or "zh").strip().lower()
    if convo_locale not in {"zh", "en"}:
        convo_locale = "zh"

    if not convo:
        return _toast(i18n.t("confirm.expired", convo_locale))

    # NOTE on _final_card_v2: the originating card on every path
    # below is the v2-schema `_edit_dispatch_card`, and Feishu's
    # card_action.trigger reply rejects a v1 reply card replacing a
    # v2 message with err 200830 ("card schema mismatch"). All
    # confirm/cancel/already-handled/failed branches must therefore
    # return v2.
    if convo.get("status") not in ("awaiting_confirmation", "received"):
        already_text = i18n.t("confirm.already_handled", convo_locale,
                              raw_text=convo.get("raw_text", ""))
        return _build_response("already-handled", _final_card_v2(
            already_text, "", color="grey"))

    chat_id = convo.get("chat_id", "")
    intent = convo.get("intent_summary", "")
    raw_text = convo.get("raw_text", "")

    if action_tag == "cancel_dispatch":
        # Feishu's trigger payload doesn't carry the operator's display
        # name (only IDs) — see the comment on confirm.dispatched.no_operator.
        cancelled_text = i18n.t("confirm.cancelled.no_operator", convo_locale,
                                raw_text=raw_text)
        return _build_response("cancelled", _final_card_v2(
            cancelled_text, "", color="grey"))

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
    # route the async result back to this chat. It is NOT the DevOps Agent
    # task_id (which create_investigation returns separately, below).
    incident_id = f"{PLATFORM}-{event_id}"

    # target_account_id: 调查目标账号。本期只支持【默认账号】(= 部署账号,
    # 由 DEFAULT_INVESTIGATION_ACCOUNT_ID 注入)。跨账号调查(用户指定别的
    # 业务账号)暂未开放。
    # 注意:代码层面就只调默认账号,没有"让用户指定账号"的入口;所以无需
    # 检测"用户想跨账号"再拒绝 —— 只要不实现"指定账号"入口即可。
    target_account_id = os.environ.get("DEFAULT_INVESTIGATION_ACCOUNT_ID", "")
    if not target_account_id:
        logger.warning("DEFAULT_INVESTIGATION_ACCOUNT_ID 未配置,无法发起调查 incident_id=%s", incident_id)
        no_account_text = i18n.t("confirm.no_default_account", convo_locale)
        return _build_response("no-default-account", _final_card_v2(
            no_account_text, "", color="red"))

    # ── 异步派发(修复"目标回调服务超时未响应")──────────────────────────────
    # 飞书 card_action.trigger 回调有 ~3s 硬超时,而 create_investigation
    # (STS AssumeRole + DevOps Agent CreateBacklogTask)常 >3s。若在这里同步调用
    # 再返回,飞书等不到 ACK → 顶部报红"目标回调服务超时未响应"。
    # 修法(对齐 case_flow/support_flow 的成熟模式):先立刻 ACK 一张"正在派发…"
    # 卡片(秒回,不超时),真正的派发放到后台 daemon 线程里跑,完成后用
    # update_card PATCH 覆盖成成功/失败结果卡。
    try:
        card_message_id = event.event.context.open_message_id or ""
    except AttributeError:
        card_message_id = ""

    def _dispatch_worker():
        try:
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
                body_text = (result.get("error") or "")[:500]
                failed_text = i18n.t("confirm.dispatch_failed", convo_locale,
                                     status="", body=body_text)
                new_card = _final_card_v2(failed_text, "", color="red")
            else:
                ddb_state.link_incident(event_id, incident_id, platform=PLATFORM,
                                        task_id=result.get("task_id"))
                # Lock the locale at the incident level so Lambda-side senders
                # (which run outside this process) render in the same language.
                if convo_locale in {"zh", "en"}:
                    locale_resolver.lock_for_incident(incident_id, convo_locale)
                suffix = f"\n_task: `{result['task_id']}`_" if result.get("task_id") else ""
                dispatched_text = i18n.t("confirm.dispatched.no_operator", convo_locale,
                                         intent=intent, incident=incident_id, suffix=suffix)
                new_card = _final_card_v2(dispatched_text, "", color="green")
                logger.info("Dispatch succeeded incident_id=%s task_id=%s",
                            incident_id, result.get("task_id"))
        except Exception as e:
            logger.exception("dispatch worker crashed incident_id=%s", incident_id)
            # Security: surface only the exception type; full detail → CloudWatch.
            new_card = _final_card_v2(
                i18n.t("confirm.dispatch_failed", convo_locale, status="",
                       body=type(e).__name__),
                "", color="red")
        # 带外 PATCH 覆盖 ACK 卡片(无 message_id 时降级为往群里补发一张)。
        try:
            if card_message_id:
                feishu_utils.update_card(card_message_id, new_card)
            elif chat_id:
                feishu_utils.send_card(chat_id, new_card)
        except Exception as e:
            logger.error("dispatch worker update_card failed incident_id=%s: %s",
                         incident_id, e)

    threading.Thread(target=_dispatch_worker, daemon=True).start()

    # 立刻 ACK(秒回,避免飞书回调超时);真正结果由后台线程 PATCH 上来。
    pending_text = i18n.t("confirm.dispatching", convo_locale, intent=intent)
    return _build_response(i18n.t("main.dispatched_short", convo_locale),
                           _final_card_v2(pending_text, "", color="blue"))


# ===========================================================================
# Card builders
# ===========================================================================
def _confirmation_card(event_id: str, intent: str, raw_text: str,
                       suggestions: list | None = None,
                       rewritten_text: str = "",
                       locale: str = "zh") -> dict:
    """Build the dispatch-confirmation card.

    `suggestions` is an optional list of short hints (Chinese) about info the
    user didn't mention but DevOps Agent would benefit from. We render them
    as a yellow warning block above the buttons; user can take them or
    ignore them.

    `rewritten_text` is set when the analyzer detected a back-reference to
    earlier investigations in this chat and rewrote the message into a
    self-contained command. We show both the original and the rewrite so
    the user can see how their reference was resolved before confirming.
    """
    # Feishu lark_md uses double-star bold; i18n templates here already
    # use double-star inline (see `confirm.title` / `confirm.original_message`)
    # so no Slack-style single-star promotion is needed.
    elements: list = [
        {"tag": "div",
         "text": {"tag": "lark_md",
                  "content": f"**{i18n.t('confirm.title', locale)}：**\n> {intent}"}},
        {"tag": "div",
         "text": {"tag": "lark_md",
                  "content": f"_{i18n.t('confirm.original_message', locale)}：_ `{raw_text}`"}},
    ]

    if rewritten_text:
        # Multi-turn rewrite is retired but we keep the rendering path
        # so older deploys don't crash. No i18n key — dead path.
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md", "content": f"> {rewritten_text}"},
        })

    if suggestions:
        bullet_lines = "\n".join(f"• {s}" for s in suggestions)
        elements.append({
            "tag": "div",
            "text": {
                "tag": "lark_md",
                "content": (
                    f"**{i18n.t('confirm.suggestions_header', locale)}：**\n"
                    f"{bullet_lines}\n\n"
                    f"_{i18n.t('confirm.suggestions_footer', locale)}_"
                ),
            },
        })

    elements.append({
        "tag": "action",
        "actions": [
            {"tag": "button",
             "text": {"tag": "plain_text",
                      "content": i18n.t("confirm.button.dispatch", locale)},
             "type": "primary",
             "value": {"action": "confirm_dispatch", "event_id": event_id}},
            {"tag": "button",
             "text": {"tag": "plain_text",
                      "content": i18n.t("confirm.button.edit_dispatch", locale)},
             "type": "default",
             "value": {"action": "edit_dispatch", "event_id": event_id}},
            {"tag": "button",
             "text": {"tag": "plain_text",
                      "content": i18n.t("confirm.button.cancel", locale)},
             "type": "default",
             "value": {"action": "cancel_dispatch", "event_id": event_id}},
        ],
    })

    return {
        "config": card_config(wide_screen_mode=True),
        "header": {
            "title": {"tag": "plain_text", "content": "🤖 NotiOps"},
            "template": "blue",
        },
        "elements": elements,
    }


def _edit_dispatch_card(*, event_id: str, intent: str,
                        suggestions: list[str] | None,
                        locale: str = "zh",
                        skill_card: dict | None = None) -> dict:
    """Build the "Start an investigation" form card — Feishu equivalent
    of Slack's edit-dispatch modal. Uses Feishu **v2 schema** because
    v1 cards don't reliably render `tag: form` + multiple `tag: input`
    elements together (the form container gets dropped, leaving only
    the header visible — the bug the first user hit).

    v2 docs: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/feishu-cards/card-json-v2

    Submit aggregates all input values into the action's `form_value`
    dict (same on both v1 and v2; the action handler logic doesn't
    change).
    """
    form_inner: list = [
        {"tag": "markdown",
         "content": i18n.t("edit.modal.intro", locale)},
        {"tag": "input",
         "name": "details",
         "label": {"tag": "plain_text",
                   "content": i18n.t("edit.field.details.label", locale)},
         "label_position": "top",
         "default_value": intent or "",
         "placeholder": {"tag": "plain_text",
                         "content": i18n.t("edit.field.details.placeholder", locale)},
         "input_type": "multiline_text",
         "rows": 4,
         "max_length": 1000,
         "width": "fill",
         "required": True},
        {"tag": "input",
         "name": "starting_point",
         "label": {"tag": "plain_text",
                   "content": i18n.t("edit.field.starting_point.label", locale)},
         "label_position": "top",
         "placeholder": {"tag": "plain_text",
                         "content": i18n.t("edit.field.starting_point.placeholder", locale)},
         "input_type": "multiline_text",
         "rows": 5,
         "max_length": 1000,
         "width": "fill"},
    ]

    # LLM-suggested dimensions render as a hint right under the
    # starting_point input — they describe what's worth mentioning in
    # that field, not a separate "additional details" section. Earlier
    # we surfaced each suggestion as its own input, but that bloated
    # the form (8 blank chips for the user to ignore) and the inputs
    # were always optional, so almost nobody filled them.
    sug_lines = [s.strip() for s in (suggestions or [])[:8] if (s or "").strip()]
    if sug_lines:
        form_inner.append({
            "tag": "markdown",
            "content": (f"💡 _{i18n.t('edit.field.suggestions.hint', locale)}_\n"
                        + "\n".join(f"- {s}" for s in sug_lines)),
        })

    # Log / error snippet — multi-line, auto-wrapped in a code fence
    # by compose_edited() at submit time.
    form_inner.append({"tag": "hr"})
    form_inner.append({
        "tag": "input",
        "name": "log_snippet",
        "label": {"tag": "plain_text",
                  "content": i18n.t("edit.field.log_snippet.label", locale)},
        "label_position": "top",
        "placeholder": {"tag": "plain_text",
                        "content": i18n.t("edit.field.log_snippet.placeholder", locale)},
        "input_type": "multiline_text",
        "rows": 5,
        "max_length": 1000,
        "width": "fill",
    })

    # ── Missing required skill params: blank inputs INSIDE the form ───────
    # name = skill_param__<param> so the submit handler reads them by prefix
    # out of form_value. None when free-form.
    if skill_card:
        for inp in skill_card["missing_inputs"]:
            form_inner.append({
                "tag": "input",
                "name": inp["block_id"],
                "label": {"tag": "plain_text",
                          "content": i18n.t(inp["label_key"], locale,
                                            **inp["label_args"])},
                "label_position": "top",
                "placeholder": {"tag": "plain_text",
                                "content": i18n.t(inp["label_key"], locale,
                                                  **inp["label_args"])},
                "default_value": "",
                "max_length": 200,
                "width": "fill",
                "required": not inp.get("optional", False),
            })

    # Submit + cancel buttons live in a `column_set` row INSIDE the
    # form, and the buttons themselves carry a `behaviors` array (NOT a
    # bare `value`). That's the only shape Feishu v2 form accepts:
    #   • Bare buttons w/ `value: {...}` → err 200530 ("invalid card
    #     content"); v2 form-submit needs the `behaviors` callback shape
    #     to bind the click back to the form.
    #   • Buttons inside a `tag: action` row → err 200621 ("type of
    #     element is not supported tag: action"); v2 form rejects the
    #     `action` container type entirely.
    # Reference shape: see _reply_card / _create_form_card in
    # case_flow.py — same layout has been working in prod since the
    # case-management cards shipped.
    form_inner.append({
        "tag": "column_set",
        "columns": [
            {"tag": "column", "width": "weighted", "weight": 2,
             "elements": [{
                 "tag": "button",
                 "name": "btn_dispatch_submit",
                 "text": {"tag": "plain_text",
                          "content": i18n.t("edit.button.submit", locale)},
                 "type": "primary",
                 "form_action_type": "submit",
                 "behaviors": [{
                     "type": "callback",
                     "value": {"action": "edit_dispatch_submit",
                               "event_id": event_id},
                 }],
             }]},
            {"tag": "column", "width": "weighted", "weight": 1,
             "elements": [{
                 "tag": "button",
                 "name": "btn_dispatch_cancel",
                 "text": {"tag": "plain_text",
                          "content": i18n.t("edit.button.cancel", locale)},
                 "type": "default",
                 "behaviors": [{
                     "type": "callback",
                     "value": {"action": "cancel_dispatch",
                               "event_id": event_id},
                 }],
             }]},
        ],
    })

    # ── Body: when a skill matched, prepend banner + picker + ❌ above form ─
    body_elements: list = []
    if skill_card:
        b = skill_card["banner"]
        body_elements.append({
            "tag": "markdown",
            "content": i18n.t(b["text_key"], locale, **b["text_args"]),
        })
        body_elements.append({
            "tag": "markdown",
            "content": "_" + i18n.t(b["reason_key"], locale,
                                    **b["reason_args"]) + "_",
        })
        if b.get("missing_hint_key"):
            body_elements.append({
                "tag": "markdown",
                "content": "_" + i18n.t(b["missing_hint_key"], locale,
                                        **b["missing_hint_args"]) + "_",
            })
        # 🔄 switch-skill — a standalone select_static in the BODY (NOT in the
        # form). Its behaviors:callback fires card.action.trigger on pick; the
        # value carries {action, event_id} so on_card_action rebuilds for the
        # chosen skill. None when the catalogue couldn't be listed.
        sel = skill_card.get("switch_select")
        if sel:
            options = []
            initial_index = None
            for i, o in enumerate(sel["options"]):
                options.append({
                    "text": {"tag": "plain_text", "content": o["label"][:100]},
                    "value": o["value"][:100],
                })
                if sel.get("initial_value") and o["value"] == sel["initial_value"]:
                    initial_index = i + 1   # Feishu initial_index is 1-based
            picker = {
                "tag": "select_static",
                "name": skill_dispatcher.SWITCH_BLOCK_ID,
                "placeholder": {"tag": "plain_text",
                                "content": i18n.t(sel["label_key"], locale)[:100]},
                "options": options,
                "type": "default",
                "width": "fill",
                "behaviors": [{
                    "type": "callback",
                    "value": {"action": skill_dispatcher.ACTION_SWITCH_SKILL,
                              "event_id": event_id},
                }],
            }
            if initial_index is not None:
                picker["initial_index"] = initial_index
            body_elements.append(picker)
        # ❌ "don't use a skill" button — body-level callback (NOT a form
        # submit), so it doesn't validate the (possibly blank) required inputs.
        for btn in skill_card["buttons"]:
            body_elements.append({
                "tag": "button",
                "name": "btn_" + btn["action_id"],
                "text": {"tag": "plain_text",
                         "content": i18n.t(btn["text_key"], locale)},
                "type": "default",
                "behaviors": [{
                    "type": "callback",
                    "value": {"action": btn["action_id"],
                              "event_id": btn["value"]},
                }],
            })
        body_elements.append({"tag": "hr"})
    body_elements.append({"tag": "form",
                          "name": "edit_dispatch_form",
                          "elements": form_inner})
    return {
        "schema": "2.0",
        "config": card_config(
            streaming_mode=False,
            summary={"content": i18n.t("edit.modal.title", locale)}),
        "header": {
            "title": {"tag": "plain_text",
                      "content": i18n.t("edit.modal.title", locale)},
            "template": "blue",
        },
        "body": {
            "direction": "vertical",
            "padding": "12px 12px",
            "elements": body_elements,
        },
    }


def _final_card_v2(title: str, body_md: str = "",
                   color: str = "blue") -> dict:
    """v2-schema variant of `_final_card`. Used when the message we're
    REPLACING is a v2 card (e.g. the edit-dispatch form submit
    response): Feishu rejects a card_action.trigger reply with err
    200830 ("card type mismatch") if the original message was v2 and
    the reply card is v1. v2-on-v2 is the only safe combination.
    """
    if not body_md:
        first_line, _, rest = title.partition("\n")
        title = first_line
        body_md = rest or first_line
    return {
        "schema": "2.0",
        "config": card_config(
            streaming_mode=False,
            summary={"content": title[:100]}),
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": color,
        },
        "body": {
            "direction": "vertical",
            "padding": "12px 12px",
            "elements": [
                {"tag": "markdown", "content": body_md},
            ],
        },
    }


# ===========================================================================
# "Next step" follow-up dispatch (Idea #3)
# ===========================================================================
def _handle_edit_dispatch_submit(action_value: dict, event,
                                  ) -> P2CardActionTriggerResponse:
    """Receive a submit from the "Start an investigation" form card,
    compose the user-edited fields into the dispatch payload, and run
    the same code path as confirm_dispatch.

    No `operator_name` parameter — Feishu's card_action.trigger payload
    only carries operator IDs (open_id / user_id / union_id), no
    display name. The success card just says "✅ 已派发" without an
    `@user` prefix; see confirm.dispatched.no_operator in core/i18n.py.
    """
    event_id = action_value.get("event_id", "") if isinstance(action_value, dict) else ""
    if not event_id:
        # No event_id → no row → no locale; en is the safer global default.
        return _toast(i18n.t("main.missing_event_id", "en"))

    # Feishu's form submit delivers all input values via
    # `event.event.action.form_value` — a dict keyed by `name`.
    form_value: dict = {}
    try:
        form_value = (event.event.action.form_value or {}) or {}
    except AttributeError:
        pass

    convo = ddb_state.get_by_event(event_id) or {}
    convo_locale = (convo.get("locale") or "zh").strip().lower()
    if convo_locale not in {"zh", "en"}:
        convo_locale = "zh"

    if not convo:
        return _build_response(
            "expired",
            _final_card_v2(i18n.t("confirm.expired", convo_locale),
                           "", color="grey"),
        )

    details = (form_value.get("details") or "").strip()
    starting_point = (form_value.get("starting_point") or "").strip()
    log_snippet = (form_value.get("log_snippet") or "").strip()
    if not details:
        # Form-level required=True covers this, but defend anyway.
        details = (convo.get("intent_summary") or convo.get("raw_text") or "")

    # ── Skill path: re-render the skill prompt with params the user filled ─
    # When the row carries a skill_id, the authoritative text is the skill
    # prompt (not the free-form fields). Fold any skill_param__<name> inputs
    # back in, then re-render. No skill_id → unchanged free-form behaviour.
    skill_id = convo.get("skill_id", "")
    skill_version = convo.get("skill_version", "")
    if skill_id:
        submitted = {}
        for name, val in form_value.items():
            if name.startswith(skill_dispatcher.PARAM_BLOCK_PREFIX):
                pname = name[len(skill_dispatcher.PARAM_BLOCK_PREFIX):]
                submitted[pname] = val.strip() if isinstance(val, str) else val
        decision = {
            "skill_id": skill_id,
            "version": skill_version,
            "source_key": f"skills/{skill_id}/versions/{skill_version}.md",
            "params": dict(convo.get("skill_params") or {}),
            "missing": convo.get("skill_missing") or [],
        }
        merged = skill_dispatcher.merge_param_overrides(decision, submitted)
        composed = skill_dispatcher.compose_payload(merged)
    else:
        composed = dispatch_compose.compose_edited(
            details=details,
            starting_point=starting_point,
            suggestion_fills=[],
            log_snippet=log_snippet,
            locale=convo_locale,
        )

    # Persist the rewritten text on the row so dispatch sees it.
    try:
        ddb_state._table.update_item(
            Key={"lookup_key": f"event#{event_id}"},
            UpdateExpression="SET raw_text = :t",
            ExpressionAttributeValues={":t": composed},
        )
    except Exception as e:
        logger.warning("persist edited text failed: %s", e)

    # Same idle STS+API path as confirm_dispatch (see the rationale block
    # in on_card_action). The edit-form submit is just the confirm path
    # with user-edited text, so it routes through create_investigation too.
    #
    # target_account_id: 本期只调【默认账号】(DEFAULT_INVESTIGATION_ACCOUNT_ID)。
    # 跨账号调查暂未开放 —— 不实现"指定账号"入口即可。
    incident_id = f"{PLATFORM}-{event_id}"
    chat_id = convo.get("chat_id", "")
    target_account_id = os.environ.get("DEFAULT_INVESTIGATION_ACCOUNT_ID", "")
    if not target_account_id:
        logger.warning("DEFAULT_INVESTIGATION_ACCOUNT_ID 未配置,无法发起调查 incident_id=%s", incident_id)
        return _build_response(
            "no-default-account",
            _final_card_v2(
                i18n.t("confirm.no_default_account", convo_locale),
                "", color="red"),
        )

    result = create_investigation(
        title=f"[{PLATFORM.capitalize()}#{incident_id[-12:]}] {composed[:50]}",
        description=composed,
        priority="MEDIUM",
        source=f"{PLATFORM}-mention",
        target_account_id=target_account_id,
        incident_id=incident_id,
    )
    if not result.get("success"):
        body_text = (result.get('error') or '')[:500]
        return _build_response(
            "dispatch-failed",
            _final_card_v2(
                i18n.t("confirm.dispatch_failed", convo_locale,
                       status="", body=body_text),
                "", color="red"),
        )

    ddb_state.link_incident(event_id, incident_id, platform=PLATFORM,
                            task_id=result.get("task_id"))
    if convo_locale in {"zh", "en"}:
        locale_resolver.lock_for_incident(incident_id, convo_locale)

    suffix = f"\n_task: `{result['task_id']}`_" if result.get("task_id") else ""
    intent_for_card = (convo.get("intent_summary") or details)[:120]
    dispatched_text = i18n.t("confirm.dispatched.no_operator", convo_locale,
                              intent=intent_for_card,
                              incident=incident_id, suffix=suffix)
    logger.info("Edited dispatch succeeded incident_id=%s task_id=%s",
                incident_id, result.get("task_id"))
    return _build_response("dispatched",
                           _final_card_v2(dispatched_text, "", color="green"))


def _handle_skill_switch(action_value: dict, event,
                         event_id: str) -> P2CardActionTriggerResponse:
    """🔄 Switch skill — user picked a different skill from the body picker.
    decision_for_skill pins confidence to 1.0 (user is authoritative). A manual
    switch starts clean — params aren't carried over (schemas differ). Falls
    back to free-form if the skill can't be resolved."""
    chosen = ""
    try:
        chosen = (event.event.action.option or "").strip()
    except AttributeError:
        pass
    if not chosen and isinstance(action_value, dict):
        chosen = (action_value.get("option") or "").strip()
    convo = ddb_state.get_by_event(event_id) or {}
    logger.info("skill_feedback: action=switch event_id=%s from=%s to=%s",
                event_id, convo.get("skill_id", ""), chosen)
    convo_locale = (convo.get("locale") or "zh").strip().lower()
    if convo_locale not in {"zh", "en"}:
        convo_locale = "zh"

    decision = skill_dispatcher.decision_for_skill(chosen)
    if not decision:
        logger.warning("skill_switch: can't resolve %r → free-form", chosen)
        return _handle_skill_dont_use(event_id)

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
        decision, event_id, locale=convo_locale, catalogue=_catalogue)
    intent = convo.get("intent_summary") or convo.get("original_text") or ""
    card = _edit_dispatch_card(event_id=event_id, intent=intent,
                               suggestions=[], locale=convo_locale,
                               skill_card=skill_card)
    return _build_response("switched", card)


def _handle_skill_dont_use(event_id: str) -> P2CardActionTriggerResponse:
    """❌ Don't use a skill — drop the match, restore the user's original
    message, and re-render the card WITHOUT the skill banner (free-form)."""
    convo = ddb_state.get_by_event(event_id) or {}
    logger.info("skill_feedback: action=dont_use event_id=%s prior_skill=%s",
                event_id, convo.get("skill_id", ""))
    convo_locale = (convo.get("locale") or "zh").strip().lower()
    if convo_locale not in {"zh", "en"}:
        convo_locale = "zh"
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
    try:
        analysis = bedrock_intent.analyze_intent(original, locale=convo_locale)
        suggestions = analysis.get("suggestions", []) or []
    except Exception:
        suggestions = []
    intent = convo.get("intent_summary") or original
    card = _edit_dispatch_card(event_id=event_id, intent=intent,
                               suggestions=suggestions, locale=convo_locale,
                               skill_card=None)
    return _build_response("free-form", card)


def _handle_next_step_dispatch(action_value: dict,
                               event) -> P2CardActionTriggerResponse:
    """Handle a click on a Bedrock-suggested follow-up dispatch button.

    Re-uses the same dispatch + DDB plumbing as a manual @mention so the
    new investigation's report routes back to this same chat thread. We
    synthesize an event_id from the parent incident so multi-clicking
    the same button doesn't create duplicate investigations.
    """
    parent_incident = action_value.get("incident_id", "")
    query = (action_value.get("query") or "").strip()
    # Inherit the parent investigation's locale so the toast / new-
    # dispatch heads-up text matches what the user was seeing on the
    # report card they clicked.
    next_step_locale = "zh"
    try:
        if parent_incident:
            _row = ddb_state.get_by_incident(parent_incident)
            if _row and (_row.get("locale") or "").strip():
                next_step_locale = _row["locale"].strip().lower()
    except Exception:
        pass
    if next_step_locale not in {"zh", "en"}:
        next_step_locale = "zh"

    if not query:
        return _toast(i18n.t("main.missing_query", next_step_locale))

    chat_id = ""
    try:
        chat_id = event.event.context.open_chat_id or ""
    except AttributeError:
        pass
    if not chat_id:
        return _toast(i18n.t("main.missing_chat_id", next_step_locale))

    # Synthesize an event id from the parent + query digest. Same query +
    # same parent → same event id → put_new_event's conditional write
    # naturally dedupes accidental double-clicks.
    # SHA1 used for short dedup-key generation only (not security).
    import hashlib
    digest = hashlib.sha1(
        f"{parent_incident}:{query}".encode("utf-8"),
        usedforsecurity=False).hexdigest()[:16]
    synth_event_id = f"nextstep-{digest}"

    is_new = ddb_state.put_new_event(
        synth_event_id, platform=PLATFORM, chat_id=chat_id,
        root_message_id="", user_id="", raw_text=query,
        locale=next_step_locale,
    )
    if not is_new:
        return _toast(i18n.t("main.duplicate_dispatch", next_step_locale))

    # Next-step follow-up uses the same idle STS+API path as the primary
    # investigate dispatch (see the rationale block in on_card_action). The
    # parent's provenance — which used to ride in webhook_dispatch's
    # extra_metadata — is folded into the `source` tag here so it still
    # surfaces in the [source] description prefix + CloudTrail session name.
    #
    # target_account_id: 本期只调【默认账号】(DEFAULT_INVESTIGATION_ACCOUNT_ID)。
    # 跨账号调查暂未开放 —— 不实现"指定账号"入口即可。
    incident_id = f"{PLATFORM}-{synth_event_id}"
    target_account_id = os.environ.get("DEFAULT_INVESTIGATION_ACCOUNT_ID", "")
    if not target_account_id:
        logger.warning("DEFAULT_INVESTIGATION_ACCOUNT_ID 未配置,无法发起调查 incident_id=%s", incident_id)
        return _toast(i18n.t("confirm.no_default_account", next_step_locale))

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
        return _toast(i18n.t("main.dispatch_failed_short",
                              next_step_locale,
                              status=result.get("error", "")))

    try:
        ddb_state.link_incident(synth_event_id, incident_id, platform=PLATFORM,
                                task_id=result.get("task_id"))
    except Exception as e:
        logger.warning("next_step DDB writes failed: %s", e)

    feishu_utils.send_text_to_chat(
        chat_id,
        # Don't truncate — slicing in the middle of CJK chars produces a
        # half-character glyph at the cut point ('识' ghost). If query is
        # truly long the user can scroll the message.
        i18n.t("main.next_step.report_pending", next_step_locale,
               query=query),
    )
    return _toast(i18n.t("main.next_step.dispatched_new", next_step_locale))


# ===========================================================================
# Bot identity (cached) — used to check if @ mentions target this bot
# ===========================================================================
_bot_open_id: str | None = None
_bot_app_id_cached: str | None = None


def _get_bot_open_id() -> str | None:
    """Fetch and cache the bot's own open_id via /bot/v3/info."""
    global _bot_open_id, _bot_app_id_cached
    if _bot_open_id is not None:
        return _bot_open_id
    try:
        resp = feishu_utils.call_openapi("GET", "/bot/v3/info")
        if resp.get("code") == 0:
            bot = resp.get("bot", {})
            _bot_open_id = bot.get("open_id", "")
            _bot_app_id_cached = bot.get("app_id", "")
            logger.info("Bot identity: open_id=%s app_id=%s",
                        _bot_open_id, _bot_app_id_cached)
        else:
            logger.warning("Could not fetch bot info: %s", resp)
            _bot_open_id = ""
    except Exception as e:
        logger.warning("Bot info fetch failed: %s", e)
        _bot_open_id = ""
    return _bot_open_id


def _is_bot_mentioned(msg) -> bool:
    """True iff the message's mentions list includes this bot's open_id/app_id.

    Feishu populates `msg.mentions` with the participants the user @-ed; for
    bots, `id.open_id` is the open_id and `name` is the bot's display name.
    Some Feishu versions also populate `app_id`. We accept either.
    """
    bot_open_id = _get_bot_open_id() or ""
    mentions = getattr(msg, "mentions", None) or []
    for m in mentions:
        try:
            mid = m.id
            open_id = getattr(mid, "open_id", "") or ""
            app_id = getattr(mid, "app_id", "") or ""
        except AttributeError:
            continue
        if bot_open_id and open_id == bot_open_id:
            return True
        if _bot_app_id_cached and app_id == _bot_app_id_cached:
            return True
    return False


def _toast(text: str) -> P2CardActionTriggerResponse:
    """Build a short toast response shown next to the button after click."""
    return P2CardActionTriggerResponse({
        "toast": {"type": "info", "content": text}
    })


def _build_response(toast: str, new_card: dict) -> P2CardActionTriggerResponse:
    """
    Trigger response that both shows a toast and replaces the card in place.

    Feishu's `card_action.trigger` callback supports returning a fresh card
    inline; the client renders it immediately, no separate API call needed.
    """
    return P2CardActionTriggerResponse({
        "toast": {"type": "info", "content": toast},
        "card": {"type": "raw", "data": new_card},
    })


# ===========================================================================
# Entrypoint
# ===========================================================================
def main():
    # Bedrock API Key 注入：注册 bedrock 客户端的构造前钩子并做一次
    # 初次收敛。必须在任何 Bedrock 调用之前 —— botocore 在**构造时**快照 token provider，
    # 设晚了会 NoAuthTokenError 硬失败而非回退 IAM。之后每条消息 / 每轮轮询各自 refresh()。
    try:
        from core import bedrock_credentials
        bedrock_credentials.install()
        bedrock_credentials.refresh()
    except Exception as e:  # noqa: BLE001 — 凭证注入失败不阻断启动（回退 IAM 仍可对话）
        logger.warning("bedrock credential install failed: %s", type(e).__name__)

    handler = (lark.EventDispatcherHandler.builder("", "")
               .register_p2_im_message_receive_v1(on_message)
               .register_p2_card_action_trigger(on_card_action)
               .build())

    cli = (lark.ws.Client(APP_ID, APP_SECRET,
                          event_handler=handler,
                          log_level=lark.LogLevel.INFO))

    # Start the progress poller daemon. It scans the shared
    # Conversations table for `progress#*` rows belonging to platform
    # "feishu" and patches the live investigation card with new tool
    # calls + Bedrock narratives every ~20s. Daemon thread; dies with
    # the process. Required IAM: aidevops:ListJournalRecords (added in
    # template.yaml).
    try:
        from core import progress_poller
        from platforms.feishu.app import progress_sender
        progress_poller.run(platform=PLATFORM,
                            update_live_card=progress_sender.update_live_card,
                            finalize_card=progress_sender.update_live_card)
        logger.info("Progress poller started")
    except Exception as e:
        logger.warning("Progress poller failed to start: %s", e)

    logger.info("Starting Feishu long-connection client…")
    cli.start()


if __name__ == "__main__":
    main()
