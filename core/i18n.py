"""Lightweight i18n facade for chat-facing text.

Two responsibilities:
  1. Heuristic locale detection — pick `zh` / `en` from a single user
     message without calling Bedrock. Cheap, deterministic, runs on
     every inbound message before we know the conversation locale.
  2. `t(key, locale, **kwargs)` — pull a translation from the static
     table, fall back to English, then fall back to the key itself
     (so a missing translation is visible but not an exception).

DESIGN NOTES
- Only zh / en are supported. JP / DE / FR / KO et al would be
  drop-in additions to `_TRANSLATIONS[key]`, but each new locale
  needs the L1 inbound-change-request regex updated too — out of
  scope for this MVP.
- Detection is deliberately ASYMMETRIC: any CJK character in a SHORT
  message (≤10 chars) wins zh, because failing-open to en for a
  Chinese-speaking user is a worse experience than failing-open to
  zh for an English-speaking user (the en user gets a polite-Chinese
  reply they can't read; the zh user gets English they can decode
  from training-data-shared technical terms).  For longer messages
  we use the doc's 30% CJK threshold.
- Translations live as flat dotted keys (`card.investigating.title`)
  so the table reads top-to-bottom by feature area. Keys never get
  computed at runtime — keep the call sites greppable.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

# CJK Unified Ideographs (U+4E00..U+9FFF) covers ~all common Chinese,
# Japanese kanji, and Korean hanja. We don't disambiguate them in MVP
# — anyone writing Chinese characters is treated as zh.
_CJK_LO = 0x4E00
_CJK_HI = 0x9FFF

_SHORT_MSG_LEN = 10
_LONG_CJK_RATIO = 0.20
# Mid-length messages that mix Chinese keywords with English technical
# tokens ("使用 devops agent 看一下" — 4 CJK in 21 chars = 19%) are
# very common and should still be zh. We treat ≥3 CJK characters as
# "intentional Chinese signal" regardless of overall ratio.
_CJK_INTENT_THRESHOLD = 3


def detect_locale(text: str) -> str:
    """Return ``"zh"`` or ``"en"`` for a user message. Empty / None → en
    (the safer default for a global product).

    See module docstring for the asymmetric short-message rule."""
    if not text:
        return "en"
    cjk_count = sum(1 for ch in text if _CJK_LO <= ord(ch) <= _CJK_HI)
    if cjk_count == 0:
        return "en"
    n = len(text)
    if n <= _SHORT_MSG_LEN:
        # Any CJK character in a short message → zh. "查 i-0123" should
        # not fall to en just because most of it is alphanumeric.
        return "zh"
    # Mid-length: ≥3 deliberate Chinese characters → zh even if the
    # ratio is low (mixed Chinese-with-technical-terms is the norm).
    if cjk_count >= _CJK_INTENT_THRESHOLD:
        return "zh"
    return "zh" if (cjk_count / n) >= _LONG_CJK_RATIO else "en"


def normalize_locale(value: str | None) -> str:
    """Map any user-typed string (`zh-CN`, `Chinese`, `EN`, `auto`) to
    the canonical `zh` / `en` / `auto`. Returns `auto` for anything
    unrecognized so callers fall through to detection."""
    if not value:
        return "auto"
    v = value.strip().lower().replace("_", "-")
    if v in {"auto", ""}:
        return "auto"
    if v.startswith("zh") or v in {"chinese", "中文", "简体中文", "中"}:
        return "zh"
    if v.startswith("en") or v in {"english", "英文", "英"}:
        return "en"
    return "auto"


# Natural-language phrasings that mean "switch the bot's reply language".
# Returned by `parse_language_switch_intent`. Patterns are intentionally
# narrow — chitchat path catches anything we miss.
#
# Why pattern-match instead of asking the LLM? Reliability + zero added
# latency. The LLM's chitchat reply is "好的,以后用英文" but it can't
# actually flip the user's preference (no tool call wired up). We catch
# the intent BEFORE chitchat, set the pref, and reply with the canonical
# `lang.set.user` confirmation.
import re as _re  # local alias to avoid shadowing if a caller imports `re`
_NL_LANGUAGE_SWITCH_PATTERNS: tuple[tuple[object, str], ...] = (
    # Chinese — "切换到英文" / "改成英文" / "用英文回复" / "请说英文" /
    # "把语言改成 en" / "切英文" — anything mentioning English in a
    # change-imperative shape.
    (_re.compile(
        r"(?:切换?(?:到|成|为)?|改(?:成|为)?|换(?:成|为)?|用|说|讲|"
        r"切|设(?:置|定)?(?:成|为|到)?)"
        r".{0,16}?"
        r"(?:英(?:文|语)?|english|en)(?![a-z])",
        _re.IGNORECASE), "en"),
    (_re.compile(
        r"(?:切换?(?:到|成|为)?|改(?:成|为)?|换(?:成|为)?|用|说|讲|"
        r"切|设(?:置|定)?(?:成|为|到)?)"
        r".{0,16}?"
        r"(?:中(?:文|国话)?|chinese|zh)(?![a-z])",
        _re.IGNORECASE), "zh"),
    # English — "switch to english" / "reply in english" / "speak english" /
    # "use english" / "change language to english"
    (_re.compile(
        r"\b(?:switch(?:\s+(?:to|the\s+language\s+to))?|change\s+(?:to|"
        r"the\s+language\s+to)|reply(?:\s+in)?|respond\s+in|"
        r"speak|use|set\s+(?:the\s+)?language\s+to)"
        r"\s+english\b",
        _re.IGNORECASE), "en"),
    (_re.compile(
        r"\b(?:switch(?:\s+(?:to|the\s+language\s+to))?|change\s+(?:to|"
        r"the\s+language\s+to)|reply(?:\s+in)?|respond\s+in|"
        r"speak|use|set\s+(?:the\s+)?language\s+to)"
        r"\s+chinese\b",
        _re.IGNORECASE), "zh"),
)


def parse_language_switch_intent(text: str) -> str:
    """Return `"zh"` / `"en"` if the text is a natural-language request to
    switch the bot's reply language; `""` otherwise.

    Catches phrasings the explicit `language zh|en` slash command misses
    — "切换到英文", "请用英文回复", "switch to english" — so the user
    doesn't have to learn the slash form. Caller is responsible for
    actually flipping the pref via `locale_resolver.set_user_pref`.

    Designed to run BEFORE the Bedrock intent classifier so the LLM
    never sees these messages — pattern check is ~free and the chitchat
    reply ("OK, I'll use English") couldn't actually flip the pref
    anyway."""
    if not text:
        return ""
    s = text.strip()
    if not s or len(s) > 200:
        # Long messages aren't language-switch requests — guard against
        # false positives in long technical questions that happen to
        # mention "english" / "中文" in passing.
        return ""
    for pat, lang in _NL_LANGUAGE_SWITCH_PATTERNS:
        if pat.search(s):
            return lang
    return ""


# ---------------------------------------------------------------------------
# Translation table
# ---------------------------------------------------------------------------
# Keep additions alphabetical inside each section. New keys MUST have
# both `zh` and `en` — fail-louder than fall-through.

_TRANSLATIONS: dict[str, dict[str, str]] = {
    # -- Acknowledgement / canned greetings -------------------------------
    "ack.understanding": {
        "zh": "🤔 正在理解你的指令…",
        "en": "🤔 Working on your request…",
    },
    "ack.dispatched": {
        "zh": "✅ 已派发,DevOps Agent 正在调查中",
        "en": "✅ Dispatched. DevOps Agent is investigating.",
    },

    # -- Confirmation card -------------------------------------------------
    "confirm.title": {
        "zh": "🎯 我理解的意图",
        "en": "🎯 Intent I understood",
    },
    "confirm.original_message": {
        "zh": "原始消息",
        "en": "Original message",
    },
    "confirm.suggestions_header": {
        "zh": "⚠️ 你没说但建议补充",
        "en": "⚠️ You didn't mention these, but they help",
    },
    "confirm.suggestions_footer": {
        "zh": "缺失这些信息会让 DevOps Agent 多花时间澄清。"
              "如果不重要可直接确认派发;想补充就先取消重发。",
        "en": "Without these the DevOps Agent will spend extra time "
              "clarifying. If unimportant, just confirm; otherwise cancel "
              "and re-send with details.",
    },
    "confirm.button.dispatch":      {"zh": "✅ 直接派发",   "en": "✅ Dispatch"},
    "confirm.button.edit_dispatch": {"zh": "📝 编辑后派发", "en": "📝 Edit & dispatch"},
    "confirm.button.cancel":        {"zh": "❌ 取消",        "en": "❌ Cancel"},

    # ---- Edit modal / form (mirrors DevOps Agent's "Start an investigation") ----
    "edit.modal.title": {
        "zh": "🚀 启动调查",
        "en": "🚀 Start an investigation",
    },
    "edit.modal.intro": {
        "zh": "DevOps Agent 需要以下信息才能调查这个问题。我们已经预填了一部分,"
              "请检查并补全缺失内容,这能让调查更高效、更准确。",
        "en": "DevOps Agent needs the following details to successfully "
              "investigate your issue. We've collected some information "
              "already, but please review what's here and add anything "
              "that's missing. This helps DevOps Agent run its "
              "investigation more efficiently and accurately.",
    },
    "edit.field.details.label": {
        "zh": "调查内容",
        "en": "Investigation details",
    },
    "edit.field.details.placeholder": {
        "zh": "描述你想调查什么。",
        "en": "Describe what you'd like to investigate.",
    },
    "edit.field.starting_point.label": {
        "zh": "调查起点",
        "en": "Investigation starting point",
    },
    "edit.field.starting_point.placeholder": {
        # Slack's plain_text_input placeholder caps at 150 chars; keep
        # both translations comfortably under that. The wider context
        # already lives in the field label + the suggestions hint.
        "zh": "alarm / metric / 日志片段等,任何能给 DevOps Agent 提供起点的信息。",
        "en": "An alarm, metric, log snippet, or anything else that "
              "gives DevOps Agent a starting point.",
    },
    "edit.field.suggestions.header": {
        "zh": "📌 补充信息(可选)",
        "en": "📌 Additional details (optional)",
    },
    "edit.field.suggestions.hint": {
        "zh": "DevOps Agent 通常需要这些维度才能精确定位问题,填上能少走弯路。",
        "en": "DevOps Agent usually needs these dimensions to pinpoint "
              "the issue. Filling them in saves clarification rounds.",
    },
    "edit.field.log_snippet.label": {
        "zh": "📋 日志 / 错误片段(可选)",
        "en": "📋 Log / error snippet (optional)",
    },
    "edit.field.log_snippet.placeholder": {
        # Slack 150-char cap (see starting_point.placeholder). Auto-
        # code-fencing happens server-side; no need to mention here.
        "zh": "粘贴相关日志、报错或 JSON(≤1000 字,长日志节选关键行)。",
        "en": "Paste relevant logs, error messages, or JSON "
              "(≤1000 chars; trim long output to the key lines).",
    },
    "edit.button.submit": {
        "zh": "🚀 派发调查",
        "en": "🚀 Start investigation",
    },
    "edit.button.cancel": {
        "zh": "取消",
        "en": "Cancel",
    },
    "edit.preview.header": {
        "zh": "📨 DevOps Agent 将收到",
        "en": "📨 DevOps Agent will receive",
    },
    # Section headers used inside the composed user_text payload that
    # gets dispatched to DevOps Agent. Kept short + technical, English-
    # leaning since the agent itself answers in either language fine.
    "edit.payload.starting_point_header": {
        "zh": "## 调查起点",
        "en": "## Starting point",
    },
    "edit.payload.context_header": {
        "zh": "## 补充上下文",
        "en": "## Additional context",
    },
    "edit.payload.logs_header": {
        "zh": "## 日志 / 错误片段",
        "en": "## Logs / error snippet",
    },
    "confirm.dispatched": {
        "zh": "✅ 已派发 (by @{operator})\n*意图:* {intent}\n"
              "_incident: `{incident}`_{suffix}\n"
              "⏳ _调查启动中,通常 1 分钟内会出现进度卡片_",
        "en": "✅ Dispatched (by @{operator})\n*Intent:* {intent}\n"
              "_incident: `{incident}`_{suffix}\n"
              "⏳ _Investigation starting; the progress card usually "
              "appears within a minute_",
    },
    # Feishu's card_action.trigger payload only carries operator IDs
    # (open_id / user_id / union_id) — there's no display-name field
    # like Slack provides on `body.user.name`, and resolving the name
    # would cost a `/contact/v3/users/{id}` OpenAPI hop per click. So
    # the Feishu variant just drops the "by @user" prefix entirely
    # rather than displaying a misleading "by @user" placeholder.
    "confirm.dispatched.no_operator": {
        "zh": "✅ 已派发\n*意图:* {intent}\n"
              "_incident: `{incident}`_{suffix}\n"
              "⏳ _调查启动中,通常 1 分钟内会出现进度卡片_",
        "en": "✅ Dispatched\n*Intent:* {intent}\n"
              "_incident: `{incident}`_{suffix}\n"
              "⏳ _Investigation starting; the progress card usually "
              "appears within a minute_",
    },
    # 立即 ACK 卡片(点确认后先回这个,再由后台线程 create_investigation 后 update_card 覆盖)。
    # 目的:飞书 card_action.trigger 回调有 ~3s 超时,而 create_investigation(STS AssumeRole +
    # DevOps Agent CreateBacklogTask)常 >3s → 否则飞书报"目标回调服务超时未响应"。
    "confirm.dispatching": {
        "zh": "🚀 正在派发调查…\n*意图:* {intent}\n_稍候,派发结果会更新在这张卡片上_",
        "en": "🚀 Dispatching investigation…\n*Intent:* {intent}\n"
              "_Hang on — the result will update on this card_",
    },
    "confirm.cancelled": {
        "zh": "🚫 已取消 (by @{operator})\n原指令: `{raw_text}`",
        "en": "🚫 Cancelled (by @{operator})\nOriginal: `{raw_text}`",
    },
    "confirm.cancelled.no_operator": {
        "zh": "🚫 已取消\n原指令: `{raw_text}`",
        "en": "🚫 Cancelled\nOriginal: `{raw_text}`",
    },
    # All live callers are the idle STS+API investigate paths, which pass
    # the create_investigation error string in {body} and status="" (there
    # is no HTTP status on the API path). {status} is kept in the signature
    # for source-compat but rendered as an empty prefix space-collapsed away.
    "confirm.dispatch_failed": {
        "zh": "❌ 派发失败{status}\n```{body}```",
        "en": "❌ Dispatch failed{status}\n```{body}```",
    },
    # Shown when DEFAULT_INVESTIGATION_ACCOUNT_ID is unset, so the bot
    # has no business account to route the cross-account investigation
    # to. Directs the user to configure a default in the Dashboard.
    "confirm.no_default_account": {
        "zh": "⚠️ *尚未配置默认调查账号*\n"
              "请先在 Dashboard 设置默认调查账号(或在指令中指明目标账号),"
              "之后再 @ 我发起调查。",
        "en": "⚠️ *No default investigation account configured*\n"
              "Please set a default investigation account in the Dashboard "
              "(or name a target account in your request), then @ me again "
              "to start an investigation.",
    },
    # Shown when an investigate-class request is dispatched but live
    # investigation is deferred (2026-06-02 decision — cross-account
    # DevOps Agent investigation not implemented yet). The IM bot replies
    # this instead of calling create_investigation.
    "investigate.not_supported": {
        "zh": "🔧 实时调查功能暂未上线。你可以查询已有的巡检报告、闲置资源、成本分析等(直接问我,例如「今天的巡检报告」)。",
        "en": "🔧 Live investigation is not available yet. You can query existing inspection reports, idle resources, cost analysis, etc. (just ask, e.g. \"today's inspection report\").",
    },
    "confirm.expired": {
        "zh": "⚠️ 会话已过期,请重新 @ 我",
        "en": "⚠️ Session expired — please @ me again",
    },
    "confirm.already_handled": {
        "zh": "ℹ️ *该请求已处理*\n原指令: `{raw_text}`",
        "en": "ℹ️ *Already handled*\nOriginal: `{raw_text}`",
    },

    # -- Progress card -----------------------------------------------------
    "progress.investigating": {
        "zh": "🔍 调查中 · 已用时 {seconds} 秒",
        "en": "🔍 Investigating · {seconds}s elapsed",
    },
    "progress.completed": {
        "zh": "✅ 调查已完成 · 用时 {seconds} 秒 · 报告见下方",
        "en": "✅ Investigation completed · {seconds}s · see report below",
    },
    "progress.failed": {
        "zh": "⚠️ 调查失败 · 用时 {seconds} 秒",
        "en": "⚠️ Investigation failed · {seconds}s",
    },
    "progress.summary": {
        "zh": "📊 进度概要",
        "en": "📊 Progress summary",
    },
    "progress.thinking": {
        "zh": "💭 当前思路",
        "en": "💭 Current thinking",
    },
    "progress.recent_calls": {
        "zh": "🔧 最近调用",
        "en": "🔧 Recent tool calls",
    },
    "progress.target": {
        "zh": "🎯 调查目标",
        "en": "🎯 Investigation target",
    },
    "progress.investigation_done_msg": {
        "zh": "DevOps Agent 已完成调查,完整报告见下方消息。",
        "en": "DevOps Agent finished — full report in the message below.",
    },
    "progress.investigation_running_msg": {
        "zh": "DevOps Agent 正在调查中,点开下方链接查看实时进程。",
        "en": "DevOps Agent is investigating. Tap the link below for the "
              "live console.",
    },
    "progress.placeholder_analyzing": {
        "zh": "_⏳ Agent 正在分析问题、规划调查步骤…_\n"
              "_有进展会自动更新到这张卡片。_",
        "en": "_⏳ Agent is analyzing the issue and planning steps…_\n"
              "_This card will auto-update as progress comes in._",
    },
    "progress.btn.open_link": {
        "zh": "🔬 查看本次调查",
        "en": "🔬 Open this investigation",
    },
    "progress.btn.open_home": {
        "zh": "🌐 Operator 主页",
        "en": "🌐 Operator home",
    },
    "progress.link_login_warning": {
        "zh": "⚠️ 链接打开后需登录 AWS 控制台才能查看。",
        "en": "⚠️ The link requires an active AWS Console login.",
    },
    "progress.investigation_started_live": {
        "zh": "🔭 调查已开始 · 实时观察",
        "en": "🔭 Investigation started · live view",
    },
    "progress.investigation_started_short": {
        "zh": "🔭 调查已开始 incident {incident_id}",
        "en": "🔭 Investigation started · incident {incident_id}",
    },
    "push.headsup_dispatched": {
        "zh": "🤖 已自动启动 DevOps Agent 调查,几分钟后报告会发到本对话。",
        "en": "🤖 DevOps Agent investigation auto-started; the report "
              "will land in this conversation in a few minutes.",
    },
    "push.btn.open_console": {
        "zh": "🌐 在控制台查看",
        "en": "🌐 Open in console",
    },
    "progress.incident_id": {
        "zh": "_Incident · `{incident_id}`_",
        "en": "_Incident · `{incident_id}`_",
    },

    # -- Report ------------------------------------------------------------
    "report.summary_header": {
        "zh": "📝 报告概要",
        "en": "📝 Report summary",
    },
    "report.summary_truncated": {
        "zh": "…(详见上方 *查看完整报告* 链接)",
        "en": "…(see *View full report* link above)",
    },
    "report.see_full": {
        "zh": "📊 查看完整报告",
        "en": "📊 View full report",
    },
    "report.see_trace": {
        "zh": "🔍 调查过程 Trace",
        "en": "🔍 Investigation trace",
    },
    "report.header.title": {
        "zh": "{emoji} NotiOps 报告",
        "en": "{emoji} NotiOps Report",
    },
    "report.header.event": {
        "zh": "*事件* · {detail_type}",
        "en": "*Event* · {detail_type}",
    },
    "report.header.status_priority": {
        "zh": "*状态* · {status}    *优先级* · {priority}",
        "en": "*Status* · {status}    *Priority* · {priority}",
    },
    "report.header.task": {
        "zh": "*Task* · `{task_id}`",
        "en": "*Task* · `{task_id}`",
    },
    "report.header.linked_case": {
        "zh": "*关联 Case* · `{case_display_id}`",
        "en": "*Linked Case* · `{case_display_id}`",
    },
    "report.link_validity": {
        "zh": "🔗 链接 7 天内有效 · 无需登录控制台即可访问",
        "en": "🔗 Links valid for 7 days · no console login required",
    },
    "report.next_steps_header": {
        "zh": "*🤖 建议的下一步*",
        "en": "*🤖 Suggested next steps*",
    },
    "report.sync_to_case": {
        "zh": "📎 同步到 Case {case_display_id}",
        "en": "📎 Sync to Case {case_display_id}",
    },
    "report.escalate_support": {
        "zh": "🆘 升级到 AWS Support",
        "en": "🆘 Escalate to AWS Support",
    },

    # -- Refusal / errors --------------------------------------------------
    "refusal.change_request": {
        "zh": "❌ 我不会替你在云环境里做变更操作。"
              "我可以帮你查看 / 调查 / 分析,但不会执行 创建 / 修改 / "
              "删除 / 重启 等任何写操作。如果确实要变更,请人工执行。",
        "en": "❌ I will not make changes to your cloud environment. "
              "I can help inspect / investigate / analyze, but I will not "
              "execute create / modify / delete / restart or any other "
              "mutation. If you really need a change, please run it "
              "manually.",
    },
    "refusal.out_of_scope": {
        "zh": "这个问题超出了我的服务范围。我是 AWS DevOps 助手,"
              "只能帮你处理 AWS(亚马逊云)相关的问题。",
        "en": "This is outside my scope. I'm an AWS DevOps assistant — "
              "I can only help with AWS (Amazon Web Services) topics.",
    },
    "refusal.change_request_long": {
        "zh": (
            "我是 AWS DevOps 助手,专门帮你处理云相关问题:\n"
            "\n"
            "• 🔍 调查 AWS 资源问题 —— 看日志、查指标、分析根因"
            "(比如 EC2 宕机原因、Lambda 超时、RDS 连接失败)\n"
            "• 📋 管理 AWS Support case —— 帮你整理信息、理解 support 回复\n"
            "• 📚 解答 AWS 概念 / 文档 / 最佳实践\n"
            "• 🛠️ 给你查询命令 —— 你 review 后自己执行(只给 read-only)\n"
            "\n"
            "我不会替你改云环境(创建 / 修改 / 删除 / 重启任何资源)。\n"
            "\n"
            "有具体问题吗?告诉我你的 AWS 账号 ID、资源类型、现象,我来帮你排查。"
        ),
        "en": (
            "I'm an AWS DevOps assistant — here's what I can help with:\n"
            "\n"
            "• 🔍 Investigate AWS resource issues — logs, metrics, "
            "root cause (e.g. EC2 outage, Lambda timeout, RDS connection)\n"
            "• 📋 Manage AWS Support cases — summarize, interpret replies\n"
            "• 📚 Answer AWS concept / docs / best-practice questions\n"
            "• 🛠️ Suggest read-only commands you can review and run\n"
            "\n"
            "I will NOT mutate your cloud (create / modify / delete / "
            "restart any resource).\n"
            "\n"
            "If you have a specific issue, share the AWS account, "
            "resource type, and symptoms — I'll investigate."
        ),
    },
    "out_of_scope.long": {
        "zh": (
            "这个问题超出了我的本职范围。\n"
            "我是 AWS DevOps 助手,可以帮你:\n"
            "• 调查 AWS 资源问题(EC2 / RDS / Lambda / 网络 …)\n"
            "• 解答 AWS 概念 / 文档 / 最佳实践\n"
            "• 创建、查看、回复 AWS Support case"
        ),
        "en": (
            "This is outside my scope.\n"
            "I'm an AWS DevOps assistant — I can help you:\n"
            "• Investigate AWS resource issues (EC2 / RDS / Lambda / "
            "networking …)\n"
            "• Answer AWS concept / docs / best-practice questions\n"
            "• Create, view, and reply to AWS Support cases"
        ),
    },
    "guidance.tail": {
        "zh": ("\n\n💡 顺便提醒:我的本职是帮你调查 AWS 资源问题或管 "
               "Support case,如果有具体的资源(EC2 / RDS / Lambda 等)"
               "需要排查,直接告诉我 ID 即可。"),
        "en": ("\n\n💡 Reminder — I'm built for investigating AWS "
               "resources and managing Support cases. Share a specific "
               "resource ID (EC2 / RDS / Lambda) and I'll dig in."),
    },
    "chitchat.downgraded": {
        "zh": ("你好 👋 我是 AWS DevOps 助手。我可以帮你:\n"
               "• 调查 AWS 资源问题(EC2 / RDS / Lambda / 网络 …)\n"
               "• 解答 AWS 概念 / 文档 / 最佳实践\n"
               "• 创建、查看、回复 AWS Support case\n"
               "\n直接说要查什么就行,例如「查 IAD 所有 EC2」。"),
        "en": ("Hi 👋 I'm the AWS DevOps assistant. I can help with:\n"
               "• Investigating AWS resources (EC2 / RDS / Lambda / "
               "networking …)\n"
               "• AWS concept / docs / best-practice questions\n"
               "• Creating, viewing, replying to AWS Support cases\n"
               "\nJust tell me what to look at, e.g. "
               "\"list all EC2 in us-east-1\"."),
    },
    "gpt.output_blocked": {
        "zh": ("⚠️ 当前模型(GPT-5.6 Terra)的本轮输出被审计拦截"
               "(疑似协议碎片或低质 token 混入),已跳过避免给你看到 garbage。\n"
               "\n建议切到稳定模型重试这一句:\n"
               "• `@bot model claude` → Claude Sonnet 5(内部测试中较稳定)\n"
               "• `@bot model nova` → Amazon Nova Pro(合规白名单友好)\n"
               "\n(所有模型均经 Amazon Bedrock 访问;GPT-5.6 Terra 当前为 experimental,见 USER_GUIDE §7.3。)"),
        "en": ("⚠️ The current model (GPT-5.6 Terra) had its reply blocked by "
               "the output sanitizer this turn (suspected protocol "
               "fragment or low-quality token leak). Skipped so you "
               "don't see garbage.\n"
               "\nTry switching to a stable model and retrying:\n"
               "• `@bot model claude` → Claude Sonnet 5 (more stable in "
               "our testing)\n"
               "• `@bot model nova` → Amazon Nova Pro (compliance-list "
               "friendly)\n"
               "\n(All models are accessed through Amazon Bedrock. "
               "GPT-5.6 Terra is currently experimental, see USER_GUIDE §7.3.)"),
    },
    # 凭证被拒（401/403）。刻意不说成"临时故障、请重试"—— 它不会自愈，重试只是白等。
    # 也刻意不透露任何凭证细节（spec R5.5）：只说是凭证问题，以及谁能修。
    "gpt.auth_failed": {
        "zh": ("⚠️ 调用当前模型(GPT-5.6 Terra)时,Amazon Bedrock 拒绝了本系统的凭证。\n"
               "这**不是**临时故障,重试不会好 —— 通常是 Bedrock API Key 过期 / 被吊销,"
               "或者这个 Key 被限制了不能调该模型。\n"
               "\n你现在可以:\n"
               "• `@bot model claude` → 换 Claude Sonnet 5 继续(走另一套调用路径,大概率可用)\n"
               "• 让管理员到控制台「模型」页检查凭证方式与 Bedrock API Key\n"),
        "en": ("⚠️ Amazon Bedrock rejected this system's credential when calling "
               "the current model (GPT-5.6 Terra).\n"
               "This is **not** a transient error and retrying will not help — "
               "usually the Bedrock API key has expired or been revoked, or that "
               "key is not permitted to invoke this model.\n"
               "\nWhat you can do now:\n"
               "• `@bot model claude` → switch to Claude Sonnet 5 (a different "
               "call path, very likely still working)\n"
               "• Ask an administrator to check the credential mode and the "
               "Bedrock API key on the console's Models page\n"),
    },

    # -- Slash commands ----------------------------------------------------
    "lang.current.user": {
        "zh": "✅ 当前语言:{name} (来源:用户偏好)",
        "en": "✅ Current language: {name} (source: user preference)",
    },
    "lang.current.thread": {
        "zh": "✅ 当前语言:{name} (来源:本轮调查锁定)",
        "en": "✅ Current language: {name} (source: this investigation)",
    },
    "lang.current.auto": {
        "zh": "✅ 当前语言:{name} (来源:自动检测)",
        "en": "✅ Current language: {name} (source: auto-detect)",
    },
    "lang.set.user": {
        # `/language auto` still works to clear the preference, but we
        # don't surface it to end users — keeping it in muscle memory
        # is enough; the simpler "send `language zh` or `language en`"
        # mental model is what we want them to keep.
        "zh": "✅ 已设置你的语言偏好为:{name}",
        "en": "✅ Set your language preference: {name}",
    },
    "lang.unset": {
        "zh": "✅ 已恢复自动检测。下次发消息时会按消息内容自动判断语言。",
        "en": "✅ Auto-detect re-enabled. Future messages will be detected "
              "by content.",
    },
    "lang.set_failed": {
        "zh": "⚠️ 设置语言偏好失败,请稍后再试。",
        "en": "⚠️ Failed to set language preference; please try again.",
    },
    "lang.unset_failed": {
        "zh": "⚠️ 重置语言偏好失败,请稍后再试。",
        "en": "⚠️ Failed to reset language preference; please try again.",
    },
    "lang.usage": {
        # `/language auto` is intentionally NOT shown — the mental model
        # we want for end users is "send `language zh` or `language en`
        # to switch". Auto-detection is the default; advertising "auto"
        # as a third option only adds confusion without helping anyone.
        "zh": "用法:`language` 查看当前 · `language zh|en` 切换语言",
        "en": "Usage: `language` to view · `language zh|en` to switch",
    },

    # MCP citation block headers — appended by core/bedrock_chat.py at the
    # tail of every chitchat / general_qa reply that touched MCP. Localized
    # so an English-locale reply doesn't get a Chinese "来源:" header.
    "mcp.sources.header": {
        "zh": "📚 来源:",
        "en": "📚 Sources:",
    },
    "mcp.tools.header": {
        "zh": "🔧 调用的 MCP 工具({servers}):",
        "en": "🔧 MCP tools used ({servers}):",
    },
    "mcp.tools.call_failed": {
        "zh": "⚠ 调用失败",
        "en": "⚠ call failed",
    },

    # -- @bot model command (per-chat LLM provider switching) -------------
    # Anyone in a chat can switch which model the bot uses for that chat;
    # there's no admin gate by design. See docs/USER_GUIDE.md.
    "model.current": {
        "zh": "🤖 当前模型:**{label}** (来源: {source})",
        "en": "🤖 Current model: **{label}** (source: {source})",
    },
    "model.list_header": {
        "zh": "🤖 可用模型:",
        "en": "🤖 Available models:",
    },
    "model.list_row": {
        "zh": "• `{alias}` — {label}",
        "en": "• `{alias}` — {label}",
    },
    "model.set_chat": {
        "zh": "✅ 已切换为 **{label}**。本群所有人之后都看到这个模型。",
        "en": "✅ Switched to **{label}**. Everyone in this chat will see this model from now on.",
    },
    "model.set_dm": {
        "zh": "✅ 已切换为 **{label}**(仅本私聊)。",
        "en": "✅ Switched to **{label}** (this DM only).",
    },
    "model.cleared": {
        "zh": "✅ 已清除偏好,回到群默认模型。",
        "en": "✅ Cleared preference; back to the chat default.",
    },
    "model.set_failed": {
        "zh": "⚠️ 切换失败(DDB 写入错误),请稍后再试。",
        "en": "⚠️ Switch failed (DDB write error); please try again.",
    },
    "model.unknown": {
        "zh": "⚠️ 未知模型 `{alias}`。可用: {valid}",
        "en": "⚠️ Unknown model `{alias}`. Available: {valid}",
    },
    "model.usage": {
        "zh": "用法:`model` 查看 · `model list` 列出 · `model <alias>` 切换 · `model default` 清除偏好",
        "en": "Usage: `model` to view · `model list` to list · `model <alias>` to switch · `model default` to clear preference",
    },

    # =====================================================================
    # AWS Support case management — Feishu / Slack UI
    # Used by platforms/feishu/app/case_flow.py and slack/app/case_flow.py.
    # Grouped at end of dict per Agent-friendly insertion contract.
    # =====================================================================

    # ---- Subject summarizer (Bedrock system prompt) ---------------------
    "case.create.summarizer_system_prompt": {
        "zh": (
            "你是 AWS Support case subject 生成器。给定用户的中文/英文运维问题描述,"
            "**严格按格式提炼一个 ≤80 字符的 subject**:\n"
            "  - 格式:「服务名 + 资源标识(可选) + 现象关键词」\n"
            "  - 例:「RDS db-prod-01 间歇性 5xx 慢查询」\n"
            "  - 不要写完整句子,不要带语气词('帮我'、'请')。\n"
            "  - 输入语言中文 → 输出中文;输入英文 → 输出英文。\n"
            "  - 用户没说服务名时,subject 留空字符串。\n"
            "  - 只输出 subject 文本,不要 JSON、不要解释、不要 markdown。"
        ),
        "en": (
            "You generate concise subjects for AWS Support cases. Given the "
            "user's Chinese/English ops issue description, "
            "**produce a single subject ≤80 characters in this format**:\n"
            "  - Format: `service + resource id (optional) + symptom keywords`\n"
            "  - Example: `RDS db-prod-01 intermittent 5xx slow query`\n"
            "  - Do NOT write a full sentence; no filler words.\n"
            "  - If input is Chinese, output Chinese; if English, output English.\n"
            "  - If the user did not name a service, return an empty string.\n"
            "  - Output the subject only — no JSON, explanation, or markdown."
        ),
    },

    # ---- Filter labels (status_filter slug → human label) ---------------
    "case.list.filter.recent": {
        "zh": "最近 5 个案例 · 不限状态",
        "en": "Last 5 cases · any status",
    },
    "case.list.filter.pending_customer": {
        "zh": "需要你处理的案例",
        "en": "Cases waiting for you",
    },
    "case.list.filter.unresolved": {
        "zh": "未解决的案例",
        "en": "Unresolved cases",
    },
    "case.list.filter.work_in_progress": {
        "zh": "AWS 工程师处理中的案例",
        "en": "Cases AWS engineers are working on",
    },
    "case.list.filter.resolved": {
        "zh": "已解决的案例",
        "en": "Resolved cases",
    },

    # ---- Filter quick-button labels -------------------------------------
    "case.list.filter_btn.recent": {
        "zh": "🕒 最近",
        "en": "🕒 Recent",
    },
    "case.list.filter_btn.pending_customer": {
        "zh": "👤 待我处理",
        "en": "👤 Waiting for me",
    },
    "case.list.filter_btn.unresolved": {
        "zh": "🔵 未解决",
        "en": "🔵 Unresolved",
    },
    "case.list.filter_btn.work_in_progress": {
        "zh": "🛠️ 处理中",
        "en": "🛠️ In progress",
    },
    "case.list.filter_btn.resolved": {
        "zh": "✅ 已解决",
        "en": "✅ Resolved",
    },

    # ---- Empty-state messages per filter --------------------------------
    "case.list.empty.recent": {
        "zh": "最近 90 天内此账号下没有 AWS Support case。",
        "en": "No AWS Support cases in this account in the last 90 days.",
    },
    "case.list.empty.pending_customer": {
        "zh": "目前没有需要你回复的 case 🎉",
        "en": "No cases waiting for your reply 🎉",
    },
    "case.list.empty.unresolved": {
        "zh": "目前没有未解决的 case 🎉",
        "en": "No unresolved cases 🎉",
    },
    "case.list.empty.work_in_progress": {
        "zh": "目前没有 AWS 工程师处理中的 case。",
        "en": "No cases currently being worked on by AWS engineers.",
    },
    "case.list.empty.resolved": {
        "zh": "最近 90 天内此账号下没有已解决的 case。",
        "en": "No resolved cases in this account in the last 90 days.",
    },
    "case.list.empty.default": {
        "zh": "没有匹配的 case。",
        "en": "No matching cases.",
    },

    # ---- List card chrome -----------------------------------------------
    "case.list.card_title": {
        "zh": "📋 我的 AWS Support Cases",
        "en": "📋 My AWS Support Cases",
    },
    "case.list.title_with_label": {
        "zh": "📋 {label}",
        "en": "📋 {label}",
    },
    "case.list.subtotal": {
        "zh": "**{label}** · 共 {count} 个,按创建时间倒序",
        "en": "**{label}** · {count} total, newest first",
    },
    "case.list.status.resolved": {
        "zh": "✅ 已解决",
        "en": "✅ Resolved",
    },
    "case.list.status.active": {
        "zh": "🔵 {status}",
        "en": "🔵 {status}",
    },
    "case.list.row_meta": {
        "zh": "_{date} · 提交人 {submitter}_",
        "en": "_{date} · submitted by {submitter}_",
    },
    "case.list.no_subject": {
        "zh": "(无主题)",
        "en": "(no subject)",
    },
    "case.list.unknown_submitter": {
        "zh": "—",
        "en": "—",
    },
    "case.list.btn.detail": {
        "zh": "💬 详情",
        "en": "💬 Details",
    },
    "case.list.btn.reply": {
        "zh": "✏️ 回复",
        "en": "✏️ Reply",
    },
    "case.list.btn.open_case": {
        "zh": "🌐 打开 Case",
        "en": "🌐 Open Case",
    },
    "case.list.btn.close": {
        "zh": "✅ 关闭",
        "en": "✅ Close",
    },
    "case.list.quick_filter_header": {
        "zh": "_快速过滤_",
        "en": "_Quick filters_",
    },
    "case.list.see_more_hint": {
        "zh": "_想看更多?在控制台用状态/服务/时间过滤完整的 case 列表 ↓_",
        "en": "_Want more? Filter the full case list by status / service / time in the console ↓_",
    },
    "case.list.btn.console_all": {
        "zh": "🔍 在控制台查看全部 Cases",
        "en": "🔍 View all cases in console",
    },

    # ---- Create form card -----------------------------------------------
    "case.create.title": {
        "zh": "🆘 创建 AWS Support Case",
        "en": "🆘 Create AWS Support Case",
    },
    "case.create.intro": {
        "zh": ("填写下方表单创建一个新的 AWS Support case。\n\n"
               "Service / Category / Issue Type 会由 Bedrock 根据"
               "**Question** 自动分类。"),
        "en": ("Fill out the form below to create a new AWS Support case.\n\n"
               "Service / Category / Issue Type are auto-classified by "
               "Bedrock from the **Question** field."),
    },
    "case.create.subject_label": {
        "zh": "**Subject**(简短主题,≤120 字)",
        "en": "**Subject** (short summary, ≤120 chars)",
    },
    "case.create.subject_placeholder": {
        "zh": "服务 + 资源 + 现象。例:RDS db-prod-01 间歇性 5xx 慢查询",
        "en": "service + resource + symptom. e.g. RDS db-prod-01 intermittent 5xx slow query",
    },
    "case.create.body_label": {
        "zh": "**Question / 问题描述**(可换行)",
        "en": "**Question / Description** (multi-line)",
    },
    "case.create.body_placeholder": {
        "zh": ("请尽量包含:Region · 资源 ID · 时间窗口 · 错误原文 · 已尝试的排查。\n"
               "越具体,工程师/Agent 回复越快越准。\n\n"
               "示例:\nRegion: us-east-1\n资源: i-0abc...\n"
               "时间: 2026-05-25 12:00 UTC\n现象: ...\n已尝试: ..."),
        "en": ("Include: Region · resource ID · time window · raw error · "
               "what you have tried.\n"
               "More detail = faster, more accurate engineer / Agent reply.\n\n"
               "Example:\nRegion: us-east-1\nResource: i-0abc...\n"
               "Time: 2026-05-25 12:00 UTC\nSymptom: ...\nTried: ..."),
    },
    "case.create.severity_label": {
        "zh": "**Severity**",
        "en": "**Severity**",
    },
    "case.create.severity_placeholder": {
        "zh": "选择严重等级",
        "en": "Select severity",
    },
    "case.create.language_label": {
        "zh": "**Language**",
        "en": "**Language**",
    },
    "case.create.language_placeholder": {
        "zh": "选择 Case 语言",
        "en": "Select case language",
    },
    "case.create.contact_label": {
        "zh": "**联系方式**(可选,邮箱 / 电话)",
        "en": "**Contact** (optional, email / phone)",
    },
    "case.create.contact_placeholder": {
        "zh": "例:you@example.com 或 +1 555-0123",
        "en": "e.g. you@example.com or +1 555-0123",
    },
    "case.create.btn.create_only": {
        "zh": "🚀 仅创建 Case",
        "en": "🚀 Create case only",
    },
    "case.create.btn.create_with_dispatch": {
        "zh": "🤖 创建 + 启动 Agent 调查",
        "en": "🤖 Create + start Agent investigation",
    },
    "case.create.btn.reset": {
        "zh": "🧹 重置",
        "en": "🧹 Reset",
    },
    "case.create.btn.cancel": {
        "zh": "❌ 取消",
        "en": "❌ Cancel",
    },
    "case.create.dispatch_hint": {
        "zh": ("_• **仅创建 Case**:把问题提给 AWS Support 工程师人工处理。_\n"
               "_• **创建 + 启动 Agent 调查**:同时让 DevOps Agent 立即开始调查,"
               "几分钟内出诊断报告;两条线并行进行。_"),
        "en": ("_• **Create case only** — file the issue with AWS Support engineers._\n"
               "_• **Create + start Agent investigation** — also kick off "
               "DevOps Agent in parallel; you get a diagnostic report in "
               "minutes alongside the support engineer's reply._"),
    },
    "case.create.account_note": {
        "zh": "_Case 将开在当前 AWS 账号(运行本 bot 的账号),需 Business / Enterprise Support 计划。_",
        "en": "_The case is opened in the current AWS account (the one this bot runs in). Requires Business / Enterprise Support plan._",
    },

    # ---- Create result card (success) -----------------------------------
    "case.create.success_title": {
        "zh": "✅ 已创建 AWS Support Case",
        "en": "✅ AWS Support case created",
    },
    "case.create.case_id_block": {
        "zh": "**🆔 案例 ID**\n{display_id}",
        "en": "**🆔 Case ID**\n{display_id}",
    },
    "case.create.subject_block": {
        "zh": "\n\n**📌 案例主题**\n{subject}",
        "en": "\n\n**📌 Subject**\n{subject}",
    },
    "case.create.case_link_block": {
        "zh": "**🔗 案例链接**\n[{url}]({url})",
        "en": "**🔗 Case link**\n[{url}]({url})",
    },
    "case.create.classification_block": {
        "zh": "\n**Service** · {service}\n**Category** · {category}\n**Issue Type** · {issue_type}",
        "en": "\n**Service** · {service}\n**Category** · {category}\n**Issue Type** · {issue_type}",
    },
    "case.create.severity_field": {
        "zh": "**严重等级** · {severity}\n**语言** · {language}",
        "en": "**Severity** · {severity}\n**Language** · {language}",
    },
    "case.create.support_will_reply": {
        "zh": "AWS Support 工程师会在工单上回复。",
        "en": "AWS Support engineers will reply on the case.",
    },
    "case.create.dispatched_note": {
        "zh": "🤖 **DevOps Agent 调查已启动**,几分钟后诊断报告会发到本对话。",
        "en": "🤖 **DevOps Agent investigation started** — the diagnostic report will arrive in this conversation in a few minutes.",
    },
    "case.create.dispatch_prompt": {
        "zh": ("🤖 想让 DevOps Agent 同时帮你**自动调查**这个问题吗?"
               "诊断报告会发到本对话,可与 AWS Support 工程师的回复并行参考。"),
        "en": ("🤖 Want DevOps Agent to **investigate** this in parallel? "
               "The diagnostic report lands in this conversation alongside "
               "the AWS Support engineer's reply."),
    },
    "case.create.btn.dispatch_agent": {
        "zh": "🤖 启动 Agent 调查",
        "en": "🤖 Start Agent investigation",
    },
    "case.create.btn.open_case": {
        "zh": "🌐 打开 Case",
        "en": "🌐 Open Case",
    },
    "case.create.btn.my_cases": {
        "zh": "📋 我的 Cases",
        "en": "📋 My cases",
    },

    # ---- Create result card (failure) -----------------------------------
    "case.create.fail_title": {
        "zh": "❌ 创建失败 ({code})",
        "en": "❌ Create failed ({code})",
    },
    "case.create.fail_subscription": {
        "zh": "当前账号的 Support 计划不支持开 case。需要升级到 Business 或 Enterprise 计划。",
        "en": "The current account's Support plan does not allow creating cases. Please upgrade to Business or Enterprise.",
    },
    "case.create.error_title": {
        "zh": "❌ 开 case 失败",
        "en": "❌ Failed to create case",
    },
    "case.create.internal_error": {
        # Security: surface only the exception type; full detail stays in CloudWatch
        # (logger.exception at every call site). See docs/LOGGING_STANDARD.md.
        "zh": "内部错误 ({kind})，请稍后重试。",
        "en": "Internal error ({kind}). Please try again later.",
    },

    # ---- Pending card (during create) -----------------------------------
    "case.create.pending_title.dispatch": {
        "zh": "⏳ 正在创建 Case + 启动 Agent 调查",
        "en": "⏳ Creating case + starting Agent investigation",
    },
    "case.create.pending_title.create_only": {
        "zh": "⏳ 正在创建 AWS Support Case",
        "en": "⏳ Creating AWS Support case",
    },
    "case.create.pending_body": {
        "zh": ("**Severity** · {severity}\n**Language** · {language}\n\n"
               "正在调用 AWS Support API,预计 5–15 秒…{extra}\n"
               "_完成后这张卡片会自动更新成 case 详情。_"),
        "en": ("**Severity** · {severity}\n**Language** · {language}\n\n"
               "Calling the AWS Support API, ~5–15s…{extra}\n"
               "_This card will refresh into case details when done._"),
    },
    "case.create.pending_extra_dispatch": {
        "zh": "\n\n🤖 case 创建后会**同时**让 DevOps Agent 开始调查。",
        "en": "\n\n🤖 DevOps Agent will start its investigation **in parallel** once the case is open.",
    },
    "case.create.pending_msg.create_only": {
        "zh": "正在创建 case…",
        "en": "Creating case…",
    },
    "case.create.pending_msg.dispatch": {
        "zh": "正在创建 case 并启动 Agent 调查…",
        "en": "Creating case and starting Agent investigation…",
    },
    "case.create.toast.created": {
        "zh": "已开 case",
        "en": "Case opened",
    },
    "case.create.toast.subject_required": {
        "zh": "⚠️ Subject 和 Question 都必填",
        "en": "⚠️ Subject and Question are both required",
    },

    # ---- Cancel cards ---------------------------------------------------
    "case.create.cancel_title": {
        "zh": "🚫 已取消创建",
        "en": "🚫 Creation cancelled",
    },
    "case.create.cancel_body": {
        "zh": "如需重新创建,请再次说 \"创建 case\"。",
        "en": "Say \"create case\" again to start over.",
    },
    "case.create.cancel_toast": {
        "zh": "已取消",
        "en": "Cancelled",
    },

    # ---- Pending simple cards -------------------------------------------
    "case.pending.simple_body": {
        "zh": "正在调用 AWS Support API,几秒后自动更新…",
        "en": "Calling AWS Support API — auto-updating shortly…",
    },
    "case.pending.reply": {
        "zh": "📤 正在添加回复…",
        "en": "📤 Adding your reply…",
    },
    "case.pending.resolve": {
        "zh": "🔒 正在关闭 case…",
        "en": "🔒 Closing the case…",
    },
    "case.pending.sync": {
        "zh": "📎 正在把调查报告同步到 Case {display_id}…",
        "en": "📎 Syncing investigation report to Case {display_id}…",
    },

    # ---- Generic toasts (case_flow handler) -----------------------------
    "case.toast.processing": {
        "zh": "⏳ 正在处理中,请稍候",
        "en": "⏳ Processing — please wait",
    },
    "case.toast.loaded": {
        "zh": "已加载 case {display_id}",
        "en": "Loaded case {display_id}",
    },
    "case.toast.loaded_no_id": {
        "zh": "已加载",
        "en": "Loaded",
    },
    "case.toast.refreshed": {
        "zh": "已刷新",
        "en": "Refreshed",
    },
    "case.toast.switched_filter": {
        "zh": "切换到 {filter}",
        "en": "Switched to {filter}",
    },
    "case.toast.opened_reply_form": {
        "zh": "已打开回复表单 {display_id}",
        "en": "Opened reply form for {display_id}",
    },
    "case.toast.opened_reply_form_no_id": {
        "zh": "已打开回复表单",
        "en": "Opened reply form",
    },
    "case.toast.missing_id_or_body": {
        "zh": "⚠️ 缺少 case id 或回复内容",
        "en": "⚠️ Missing case id or reply body",
    },
    "case.toast.confirm_close": {
        "zh": "确认关闭 case {display_id}?",
        "en": "Confirm closing case {display_id}?",
    },
    "case.toast.confirm_close_generic": {
        "zh": "请确认",
        "en": "Please confirm",
    },
    "case.toast.unknown_action": {
        "zh": "未知操作",
        "en": "Unknown action",
    },
    "case.toast.missing_chat_or_case": {
        "zh": "⚠️ 缺少 chat_id 或 case id",
        "en": "⚠️ Missing chat_id or case id",
    },
    "case.toast.dispatch_started": {
        "zh": "🤖 已启动调查,稍后报告会发到本对话",
        "en": "🤖 Investigation started — the report will arrive in this conversation",
    },
    "case.toast.dispatch_failed": {
        "zh": "⚠️ 派发失败: {detail}",
        "en": "⚠️ Dispatch failed: {detail}",
    },
    "case.toast.missing_id_or_incident": {
        "zh": "⚠️ 缺少案例 ID 或 incident_id",
        "en": "⚠️ Missing case ID or incident_id",
    },
    "case.toast.report_expired": {
        "zh": "⚠️ 报告内容已过期,无法同步",
        "en": "⚠️ Report context expired — cannot sync",
    },
    "case.toast.syncing_in_progress": {
        "zh": "⏳ 正在同步,请稍候",
        "en": "⏳ Syncing — please wait",
    },
    "case.toast.synced": {
        "zh": "已同步",
        "en": "Synced",
    },
    "case.toast.sync_failed": {
        "zh": "失败",
        "en": "Failed",
    },
    "case.toast.syncing": {
        "zh": "正在同步…",
        "en": "Syncing…",
    },
    "case.toast.missing_case_id": {
        "zh": "⚠️ 缺少 case id",
        "en": "⚠️ Missing case id",
    },
    "case.toast.sending": {
        "zh": "发送中…",
        "en": "Sending…",
    },
    "case.toast.sent": {
        "zh": "已发送",
        "en": "Sent",
    },
    "case.toast.send_failed": {
        "zh": "失败",
        "en": "Failed",
    },
    "case.toast.closing": {
        "zh": "关闭中…",
        "en": "Closing…",
    },
    "case.toast.closed": {
        "zh": "已关闭",
        "en": "Closed",
    },
    "case.toast.close_failed": {
        "zh": "失败",
        "en": "Failed",
    },

    # ---- Case analyze (LLM summary + insights) --------------------------
    "case.analyze.title": {
        "zh": "🔬 Case {display_id} · 智能分析",
        "en": "🔬 Case {display_id} · Smart analysis",
    },
    "case.analyze.subject_meta": {
        "zh": "**主题**:{subject}\n**严重度**:{severity}  **服务**:{service}  **状态**:{status}\n**通信记录**:{comm_count} 条",
        "en": "**Subject**: {subject}\n**Severity**: {severity}  **Service**: {service}  **Status**: {status}\n**Communications**: {comm_count}",
    },
    "case.analyze.section.summary": {
        "zh": "📝 现状摘要",
        "en": "📝 Summary",
    },
    "case.analyze.section.root_cause": {
        "zh": "🔍 根因推断",
        "en": "🔍 Likely root cause",
    },
    "case.analyze.section.aws_progress": {
        "zh": "🛠 AWS 工程师进展",
        "en": "🛠 AWS engineer progress",
    },
    "case.analyze.section.next_steps": {
        "zh": "✅ 建议下一步",
        "en": "✅ Recommended next steps",
    },
    "case.analyze.section.info_to_provide": {
        "zh": "📋 你应补充给 AWS 的信息",
        "en": "📋 Info to provide to AWS",
    },
    "case.analyze.section.suggested_reply": {
        "zh": "✉️ 建议回复模板",
        "en": "✉️ Suggested reply",
    },
    "case.analyze.btn.reply": {
        "zh": "💬 回复 case",
        "en": "💬 Reply to case",
    },
    "case.analyze.btn.view_full": {
        "zh": "📋 查看完整 case",
        "en": "📋 View full case",
    },
    "case.analyze.btn.dispatch_investigation": {
        "zh": "🔍 派发关联调查",
        "en": "🔍 Dispatch investigation",
    },
    "case.analyze.toast.starting": {
        "zh": "正在分析 case {display_id}…",
        "en": "Analyzing case {display_id}…",
    },
    "case.analyze.error.case_not_found": {
        "zh": "找不到 case `{display_id}`。可能 ID 错误,或该 case 不属于当前 AWS 账号。",
        "en": "Could not find case `{display_id}`. The ID may be wrong, or it may belong to a different AWS account.",
    },
    "case.analyze.error.llm_failed": {
        "zh": "LLM 分析失败,请稍后再试或直接查看 case 原文。错误:{detail}",
        "en": "LLM analysis failed; please try again later or view the raw case. Error: {detail}",
    },

    # ---- Case-not-found card (start_view) -------------------------------
    "case.view.not_found_title": {
        "zh": "⚠️ 案例未找到",
        "en": "⚠️ Case not found",
    },
    "case.view.not_found_body": {
        "zh": "找不到 case `{display_id}`。可能 ID 错误,或该 case 不属于当前 AWS 账号。",
        "en": "Could not find case `{display_id}`. The ID may be wrong, or the case may belong to a different AWS account.",
    },

    # ---- View card ------------------------------------------------------
    "case.view.title": {
        "zh": "📌 Case {display_id}",
        "en": "📌 Case {display_id}",
    },
    "case.view.head_block": {
        "zh": ("**Subject** · {subject}\n"
               "**ID** · `{display_id}`\n"
               "**Status** · {status}\n"
               "**Severity** · {severity}\n"
               "**Service / Category** · {service} / {category}\n"
               "**Created** · {created}\n"
               "**Submitted by** · {submitter}"),
        "en": ("**Subject** · {subject}\n"
               "**ID** · `{display_id}`\n"
               "**Status** · {status}\n"
               "**Severity** · {severity}\n"
               "**Service / Category** · {service} / {category}\n"
               "**Created** · {created}\n"
               "**Submitted by** · {submitter}"),
    },
    "case.view.no_replies": {
        "zh": "_(暂无回复记录)_",
        "en": "_(no replies yet)_",
    },
    "case.view.recent_replies_header": {
        "zh": "**最近 {count} 条回复**(新→旧)",
        "en": "**Last {count} replies** (newest first)",
    },
    "case.view.who_aws": {
        "zh": "🅰️ AWS Support",
        "en": "🅰️ AWS Support",
    },
    "case.view.who_customer": {
        "zh": "👤 {name}",
        "en": "👤 {name}",
    },
    "case.view.who_customer_default": {
        "zh": "Customer",
        "en": "Customer",
    },
    "case.view.reply_block": {
        "zh": "**{who}** · _{ts}_\n\n{body}",
        "en": "**{who}** · _{ts}_\n\n{body}",
    },
    "case.view.btn.add_reply": {
        "zh": "✏️ 添加回复",
        "en": "✏️ Add reply",
    },
    "case.view.btn.open_console": {
        "zh": "🌐 在控制台打开",
        "en": "🌐 Open in console",
    },
    "case.view.btn.close": {
        "zh": "✅ 关闭 Case",
        "en": "✅ Close case",
    },

    # ---- Reply form -----------------------------------------------------
    "case.reply.title": {
        "zh": "✏️ 回复 Case {display_id}",
        "en": "✏️ Reply to Case {display_id}",
    },
    "case.reply.intro": {
        "zh": "将作为客户消息附加到该 case。AWS Support 工程师会看到并回复。",
        "en": "This will be added to the case as a customer message. AWS Support engineers will see and reply.",
    },
    "case.reply.body_placeholder": {
        "zh": "在这里输入回复内容…",
        "en": "Type your reply here…",
    },
    "case.reply.btn.send": {
        "zh": "📤 发送",
        "en": "📤 Send",
    },
    "case.reply.btn.reset": {
        "zh": "🧹 重置",
        "en": "🧹 Reset",
    },

    # ---- Reply result ---------------------------------------------------
    "case.reply.fail_title": {
        "zh": "❌ 回复失败",
        "en": "❌ Reply failed",
    },
    "case.reply.fail_body": {
        "zh": "未能将回复添加到 case `{display_id}`。请稍后重试或在控制台手动回复。",
        "en": "Could not add the reply to case `{display_id}`. Please retry later or reply manually in the console.",
    },
    "case.reply.success_title": {
        "zh": "✅ 回复已发送",
        "en": "✅ Reply sent",
    },
    "case.reply.success_intro": {
        "zh": "已添加到 case `{display_id}`:",
        "en": "Added to case `{display_id}`:",
    },
    "case.reply.btn.open_console": {
        "zh": "🌐 在控制台查看",
        "en": "🌐 View in console",
    },
    "case.reply.btn.detail": {
        "zh": "📌 查看详情",
        "en": "📌 View details",
    },
    "case.reply.error_title": {
        "zh": "❌ 回复失败",
        "en": "❌ Reply failed",
    },

    # ---- Resolve confirm + result --------------------------------------
    "case.resolve.confirm_title": {
        "zh": "⚠️ 确认关闭 Case",
        "en": "⚠️ Confirm closing case",
    },
    "case.resolve.confirm_body": {
        "zh": ("确定要关闭 case `{display_id}` 吗?\n\n"
               "关闭后 AWS 工程师不会再处理。"
               "_(如需重开,新增一条回复即可让 case 回到 pending 状态。)_"),
        "en": ("Are you sure you want to close case `{display_id}`?\n\n"
               "After closing, AWS engineers will stop working on it. "
               "_(To reopen, just add a new reply — that brings the case back to pending.)_"),
    },
    "case.resolve.btn.confirm": {
        "zh": "✅ 确认关闭",
        "en": "✅ Confirm close",
    },
    "case.resolve.btn.cancel": {
        "zh": "取消",
        "en": "Cancel",
    },
    "case.resolve.cancel_title": {
        "zh": "🚫 已取消关闭",
        "en": "🚫 Close cancelled",
    },
    "case.resolve.cancel_body": {
        "zh": "案例状态未变更。",
        "en": "Case status unchanged.",
    },
    "case.resolve.cancel_toast": {
        "zh": "已取消",
        "en": "Cancelled",
    },
    "case.resolve.fail_title": {
        "zh": "❌ 关闭失败",
        "en": "❌ Close failed",
    },
    "case.resolve.fail_body": {
        "zh": "未能关闭 case `{display_id}`。请稍后重试或在控制台关闭。",
        "en": "Could not close case `{display_id}`. Please retry later or close from the console.",
    },
    "case.resolve.success_title": {
        "zh": "✅ Case 已关闭",
        "en": "✅ Case closed",
    },
    "case.resolve.success_body": {
        "zh": "Case `{display_id}` 已关闭。\n\n**Final status** · {status}",
        "en": "Case `{display_id}` is closed.\n\n**Final status** · {status}",
    },
    "case.resolve.btn.open_console": {
        "zh": "🌐 在控制台查看",
        "en": "🌐 View in console",
    },
    "case.resolve.error_title": {
        "zh": "❌ 关闭失败",
        "en": "❌ Close failed",
    },

    # ---- Sync report card ----------------------------------------------
    "case.sync.fail_title": {
        "zh": "❌ 同步失败",
        "en": "❌ Sync failed",
    },
    "case.sync.fail_body": {
        "zh": "未能把报告同步到 case `{display_id}`。请稍后重试或在控制台手动添加。",
        "en": "Could not sync the report to case `{display_id}`. Please retry later or add it manually in the console.",
    },
    "case.sync.success_title": {
        "zh": "✅ 调查报告已同步到 Case",
        "en": "✅ Investigation report synced to case",
    },
    "case.sync.success_body": {
        "zh": ("DevOps Agent 的调查报告已附加到 case `{display_id}`,"
               "AWS Support 工程师可以直接在工单上看到。"),
        "en": ("DevOps Agent's investigation report is now attached to case "
               "`{display_id}` — AWS Support engineers can see it directly on the ticket."),
    },
    "case.sync.btn.open_case": {
        "zh": "🌐 打开 Case",
        "en": "🌐 Open Case",
    },
    "case.sync.btn.detail": {
        "zh": "📌 查看详情",
        "en": "📌 View details",
    },
    "case.sync.error_title": {
        "zh": "❌ 同步失败",
        "en": "❌ Sync failed",
    },

    # ---- Inline dispatch text (sent into chat after case dispatch) ------
    "case.dispatch.inline_chat_msg": {
        "zh": "🔍 已为 case {display_id} 启动 DevOps Agent 调查,几分钟后报告会发到本对话。",
        "en": "🔍 Started a DevOps Agent investigation for case {display_id} — the report will arrive in this conversation in a few minutes.",
    },

    # =====================================================================
    # Slack-only — modal titles, opener buttons, view-submission errors.
    # Slack `views_open` requires a trigger_id which @-mentions don't carry,
    # so we post a "click to open form" button. Modal title fields cap at
    # 24 chars; we keep these short or pass them through `[:24]` at use.
    # =====================================================================
    "case.create.opener.title": {
        "zh": "*🆘 创建 AWS Support Case*\n点击下面的按钮打开表单。Slack 不允许直接在 @mention 时弹出表单,所以需要再点一下。",
        "en": "*🆘 Create AWS Support Case*\nClick the button below to open the form. Slack does not allow modals to open straight from an @mention, so an extra click is needed.",
    },
    "case.create.opener.fallback_text": {
        "zh": "点击下方按钮打开创建 case 表单",
        "en": "Click the button below to open the create-case form",
    },
    "case.create.opener.btn": {
        "zh": "🆘 打开创建表单",
        "en": "🆘 Open create form",
    },
    "case.reply.opener.title": {
        "zh": "*✏️ 回复 Case `{display_id}`*\n点击下方按钮打开回复表单。",
        "en": "*✏️ Reply to Case `{display_id}`*\nClick the button below to open the reply form.",
    },
    "case.reply.opener.fallback_text": {
        "zh": "回复 case {display_id}",
        "en": "Reply to case {display_id}",
    },
    "case.reply.opener.btn": {
        "zh": "✏️ 打开回复表单",
        "en": "✏️ Open reply form",
    },
    "case.resolve.opener.title": {
        "zh": "*⚠️ 确认关闭 Case `{display_id}`?*\n关闭后 AWS 工程师不会再处理。_(如需重开,新增一条回复即可让 case 回到 pending 状态。)_",
        "en": "*⚠️ Confirm closing Case `{display_id}`?*\nAfter closing, AWS engineers will stop working on it. _(To reopen, just add a new reply — that brings the case back to pending.)_",
    },
    "case.resolve.opener.fallback_text": {
        "zh": "确认关闭 case {display_id}?",
        "en": "Confirm closing case {display_id}?",
    },
    "case.create.modal.title_short": {
        "zh": "🆘 创建 Case",
        "en": "🆘 Create Case",
    },
    "case.create.modal.submit_short": {
        "zh": "🚀 创建",
        "en": "🚀 Create",
    },
    "case.create.modal.cancel_short": {
        "zh": "取消",
        "en": "Cancel",
    },
    "case.create.subject_label_short": {
        "zh": "Case 主题(简短描述,≤120 字)",
        "en": "Subject (short description, ≤120 chars)",
    },
    "case.create.body_label_short": {
        "zh": "问题描述(可换行)",
        "en": "Question (multi-line)",
    },
    "case.create.body_placeholder_short": {
        "zh": ("请尽量包含:Region · 资源 ID · 时间窗口 · 错误原文 · 已尝试的排查。\n"
               "越具体,工程师/Agent 回复越快越准。"),
        "en": ("Include: Region · resource ID · time window · raw error · "
               "what you have tried.\nMore detail = faster, more accurate "
               "engineer / Agent reply."),
    },
    "case.create.severity_label_short": {
        "zh": "Case 严重等级",
        "en": "Case severity",
    },
    "case.create.language_label_short": {
        "zh": "Case 语言",
        "en": "Case language",
    },
    "case.create.dispatch_label": {
        "zh": "执行方式",
        "en": "Action mode",
    },
    "case.create.dispatch_placeholder": {
        "zh": "选择创建方式",
        "en": "Select action mode",
    },
    "case.create.dispatch_with_dispatch": {
        "zh": "🤖 创建 Case + 同时启动 Agent 调查(推荐)",
        "en": "🤖 Create case + start Agent investigation (recommended)",
    },
    "case.create.dispatch_no": {
        "zh": "🚀 仅创建 Case,稍后再决定是否调查",
        "en": "🚀 Create case only, decide later about investigation",
    },
    "case.create.contact_label_short": {
        "zh": "联系方式(可选,邮箱 / 电话)",
        "en": "Contact (optional, email / phone)",
    },
    "case.create.modal.context_hint": {
        "zh": ("_• 仅创建 Case: 把问题提给 AWS Support 工程师人工处理。_\n"
               "_• 创建 + 启动 Agent 调查: 同时让 DevOps Agent 立即开始调查,"
               "几分钟内出诊断报告;两条线并行进行。_\n"
               "_Case 将开在当前 AWS 账号(运行本 bot 的账号),"
               "需 Business / Enterprise Support 计划。_"),
        "en": ("_• Create case only — file the issue with AWS Support engineers._\n"
               "_• Create + start Agent investigation — also kick off "
               "DevOps Agent in parallel; you get a diagnostic report in "
               "minutes alongside the support engineer's reply._\n"
               "_The case is opened in the current AWS account (the one this "
               "bot runs in). Requires Business / Enterprise Support plan._"),
    },
    "case.reply.modal.title_short": {
        "zh": "✏️ 回复 {display_id}",
        "en": "✏️ Reply {display_id}",
    },
    "case.reply.modal.submit_short": {
        "zh": "📤 发送",
        "en": "📤 Send",
    },
    "case.reply.body_label_short": {
        "zh": "回复内容",
        "en": "Reply body",
    },
    "case.create.creating_status": {
        "zh": "⏳ 正在创建 case ({severity}, {language})…",
        "en": "⏳ Creating case ({severity}, {language})…",
    },
    "case.create.success_text_short": {
        "zh": "✅ 已创建 AWS Support Case",
        "en": "✅ AWS Support case created",
    },
    "case.create.fail_text_short": {
        "zh": "❌ 创建失败",
        "en": "❌ Create failed",
    },
    "case.create.internal_error_block": {
        # Security: only the exception *type* ({kind}) is surfaced — the raw message
        # can embed request payloads; full detail is in CloudWatch (logger.exception).
        "zh": "❌ *创建失败*\n内部错误 (`{kind}`)，请稍后重试。",
        "en": "❌ *Create failed*\nInternal error (`{kind}`). Please try again later.",
    },
    "case.create.fail_block": {
        "zh": "❌ *创建失败 ({code})*\n{hint}",
        "en": "❌ *Create failed ({code})*\n{hint}",
    },
    "case.list.title_simple": {
        "zh": "我的 cases",
        "en": "My cases",
    },
    "case.list.subtotal_simple": {
        "zh": "共 {count} 个,按创建时间倒序",
        "en": "{count} total, newest first",
    },
    "case.list.row_md": {
        "zh": ("*{sev_emoji} {subject}*\n"
               "`{display_id}` · {status_badge} · {severity}\n"
               "_{date} · 提交人 {submitter}_"),
        "en": ("*{sev_emoji} {subject}*\n"
               "`{display_id}` · {status_badge} · {severity}\n"
               "_{date} · submitted by {submitter}_"),
    },
    "case.view.head_block_slack": {
        "zh": ("*Subject* · {subject}\n"
               "*ID* · `{display_id}`\n"
               "*Status* · {status}\n"
               "*Severity* · {severity}\n"
               "*Service / Category* · {service} / {category}\n"
               "*Created* · {created}\n"
               "*Submitted by* · {submitter}"),
        "en": ("*Subject* · {subject}\n"
               "*ID* · `{display_id}`\n"
               "*Status* · {status}\n"
               "*Severity* · {severity}\n"
               "*Service / Category* · {service} / {category}\n"
               "*Created* · {created}\n"
               "*Submitted by* · {submitter}"),
    },
    "case.view.recent_replies_header_slack": {
        "zh": "*最近 {count} 条回复*(新→旧)",
        "en": "*Last {count} replies* (newest first)",
    },
    "case.view.reply_block_slack": {
        "zh": "*{who}* · _{ts}_\n\n{body}",
        "en": "*{who}* · _{ts}_\n\n{body}",
    },
    "case.view.who_aws_short": {
        "zh": "🅰️ AWS Support",
        "en": "🅰️ AWS Support",
    },
    "case.view.who_customer_short": {
        "zh": "👤 {name}",
        "en": "👤 {name}",
    },
    "case.view.customer_default": {
        "zh": "Customer",
        "en": "Customer",
    },
    "case.view.no_subject": {
        "zh": "(无主题)",
        "en": "(no subject)",
    },
    "case.view.unknown_submitter": {
        "zh": "—",
        "en": "—",
    },
    "case.create.success_block": {
        "zh": ("*🆔 案例 ID*\n{display_id}{subject_line}\n\n"
               "*🔗 案例链接*\n<{case_url}|{case_url}>"),
        "en": ("*🆔 Case ID*\n{display_id}{subject_line}\n\n"
               "*🔗 Case link*\n<{case_url}|{case_url}>"),
    },
    "case.create.success_subject_line": {
        "zh": "\n*📌 案例主题*\n{subject}",
        "en": "\n*📌 Subject*\n{subject}",
    },
    "case.create.severity_lang_block": {
        "zh": ("*严重等级* · {severity}\n*语言* · {language}{classification}\n\n"
               "AWS Support 工程师会在工单上回复。"),
        "en": ("*Severity* · {severity}\n*Language* · {language}{classification}\n\n"
               "AWS Support engineers will reply on the case."),
    },
    "case.create.classification_lines": {
        "zh": ("\n*Service* · {service}"
               "\n*Category* · {category}"
               "\n*Issue Type* · {issue_type}"),
        "en": ("\n*Service* · {service}"
               "\n*Category* · {category}"
               "\n*Issue Type* · {issue_type}"),
    },
    "case.create.dispatched_section": {
        "zh": "🤖 *DevOps Agent 调查已启动*,几分钟后诊断报告会发到本对话。",
        "en": "🤖 *DevOps Agent investigation started* — the diagnostic report will arrive in this conversation in a few minutes.",
    },
    "case.create.dispatch_prompt_section": {
        "zh": ("🤖 想让 DevOps Agent 同时帮你*自动调查*这个问题吗?"
               "诊断报告会发到本对话,可与 AWS Support 工程师的回复并行参考。"),
        "en": ("🤖 Want DevOps Agent to *investigate* this in parallel? "
               "The diagnostic report lands in this conversation alongside "
               "the AWS Support engineer's reply."),
    },
    "case.create.btn.start_agent_short": {
        "zh": "🤖 启动 Agent 调查",
        "en": "🤖 Start Agent",
    },
    "case.create.btn.open_case_short": {
        "zh": "🌐 打开 Case",
        "en": "🌐 Open Case",
    },
    "case.create.btn.my_cases_short": {
        "zh": "📋 我的 Cases",
        "en": "📋 My Cases",
    },
    "case.reply.success_block_short": {
        "zh": "✅ *回复已发送*\n已添加到 case `{display_id}`:",
        "en": "✅ *Reply sent*\nAdded to case `{display_id}`:",
    },
    "case.reply.fail_block_short": {
        "zh": "❌ *回复失败*\n未能将回复添加到 case `{display_id}`。请稍后重试或在控制台手动回复。",
        "en": "❌ *Reply failed*\nCould not add the reply to case `{display_id}`. Please retry later or reply manually in the console.",
    },
    "case.reply.success_text_short": {
        "zh": "✅ 回复已发送",
        "en": "✅ Reply sent",
    },
    "case.reply.fail_text_short": {
        "zh": "❌ 回复失败",
        "en": "❌ Reply failed",
    },
    "case.reply.btn.open_console_short": {
        "zh": "🌐 在控制台查看",
        "en": "🌐 View in console",
    },
    "case.reply.btn.detail_short": {
        "zh": "📌 查看详情",
        "en": "📌 View details",
    },
    "case.resolve.success_block_short": {
        "zh": "✅ *Case `{display_id}` 已关闭*\n*Final status* · {status}",
        "en": "✅ *Case `{display_id}` closed*\n*Final status* · {status}",
    },
    "case.resolve.success_text_short": {
        "zh": "✅ Case {display_id} 已关闭",
        "en": "✅ Case {display_id} closed",
    },
    "case.resolve.fail_block_short": {
        "zh": "❌ *关闭失败*\n未能关闭 case `{display_id}`。请稍后重试或在控制台关闭。",
        "en": "❌ *Close failed*\nCould not close case `{display_id}`. Please retry later or close from the console.",
    },
    "case.resolve.fail_text_short": {
        "zh": "❌ 关闭失败",
        "en": "❌ Close failed",
    },
    "case.resolve.cancel_ephemeral": {
        "zh": "🚫 已取消关闭。Case 状态未变更。",
        "en": "🚫 Close cancelled. Case status unchanged.",
    },
    "case.resolve.btn.open_console_short": {
        "zh": "🌐 在控制台查看",
        "en": "🌐 View in console",
    },
    "case.list.btn.detail_short": {
        "zh": "💬 详情",
        "en": "💬 Details",
    },
    "case.list.btn.reply_short": {
        "zh": "✏️ 回复",
        "en": "✏️ Reply",
    },
    "case.list.btn.open_short": {
        "zh": "🌐 打开 Case",
        "en": "🌐 Open Case",
    },
    "case.list.btn.close_short": {
        "zh": "✅ 关闭",
        "en": "✅ Close",
    },
    "case.list.console_btn_short": {
        "zh": "🔍 在控制台查看全部 Cases",
        "en": "🔍 View all in console",
    },
    "case.list.console_hint_short": {
        "zh": "_想看更多? 在控制台用状态/服务/时间过滤完整的 case 列表 ↓_",
        "en": "_Want more? Filter the full case list by status / service / time in the console ↓_",
    },
    "case.list.quick_filter_short": {
        "zh": "_快速过滤_",
        "en": "_Quick filters_",
    },
    "case.view.btn.add_reply_short": {
        "zh": "✏️ 添加回复",
        "en": "✏️ Add reply",
    },
    "case.view.btn.open_console_short": {
        "zh": "🌐 在控制台打开",
        "en": "🌐 Open in console",
    },
    "case.view.btn.close_short": {
        "zh": "✅ 关闭 Case",
        "en": "✅ Close case",
    },
    "case.view.no_replies_short": {
        "zh": "_(暂无回复记录)_",
        "en": "_(no replies yet)_",
    },
    "case.create.subject_required_short": {
        "zh": "Case 主题必填",
        "en": "Subject is required",
    },
    "case.create.body_required_short": {
        "zh": "问题描述必填",
        "en": "Question is required",
    },
    "case.create.severity_invalid_short": {
        "zh": "无效 severity",
        "en": "Invalid severity",
    },
    "case.create.processing_short": {
        "zh": "正在处理中,请稍候",
        "en": "Processing — please wait",
    },
    "case.reply.body_required_short": {
        "zh": "回复内容必填",
        "en": "Reply body is required",
    },
    "case.reply.missing_id_short": {
        "zh": "缺少 case ID",
        "en": "Missing case ID",
    },
    "case.dispatch.dispatched_inline": {
        "zh": "🔍 已为 case {display_id} 启动 DevOps Agent 调查",
        "en": "🔍 Started DevOps Agent investigation for case {display_id}",
    },
    "case.dispatch.already_dispatched_ephemeral": {
        "zh": "🔍 已为该 case 派发过调查,稍后看结果",
        "en": "🔍 Investigation already dispatched for this case — check back later",
    },
    "case.dispatch.processing_ephemeral": {
        "zh": "⏳ 正在派发,请稍候",
        "en": "⏳ Dispatching — please wait",
    },
    "case.create.contact_placeholder_short": {
        "zh": "例:you@example.com 或 +1 555-0123",
        "en": "e.g. you@example.com or +1 555-0123",
    },
    "case.create.subject_placeholder_short": {
        "zh": "服务 + 资源 + 现象。例:RDS db-prod-01 间歇性 5xx 慢查询",
        "en": "service + resource + symptom. e.g. RDS db-prod-01 intermittent 5xx slow query",
    },
    "case.reply.body_placeholder_short": {
        "zh": "在这里输入回复内容…",
        "en": "Type your reply here…",
    },
    "case.reply.intro_short": {
        "zh": "将作为客户消息附加到该 case。AWS Support 工程师会看到并回复。",
        "en": "This will be added to the case as a customer message. AWS Support engineers will see and reply.",
    },
    "case.view.title_short": {
        "zh": "📌 Case {display_id}",
        "en": "📌 Case {display_id}",
    },
    "case.view.not_found_text_short": {
        "zh": "⚠️ Case 未找到",
        "en": "⚠️ Case not found",
    },
    "case.view.not_found_block_short": {
        "zh": "⚠️ *Case 未找到*\n找不到 case `{display_id}`。可能 ID 错误,或该 case 不属于当前 AWS 账号。",
        "en": "⚠️ *Case not found*\nCould not find case `{display_id}`. The ID may be wrong, or the case may belong to a different AWS account.",
    },
    "case.toast.processing_short": {
        "zh": "⏳ 正在处理中,请稍候",
        "en": "⏳ Processing — please wait",
    },

    # =====================================================================
    # AWS Support escalation flow — Feishu / Slack UI
    # Used by platforms/feishu/app/support_flow.py and slack/app/support_flow.py.
    # The "🆘 升级到 AWS Support" button on a report card opens this flow,
    # which builds a case from the investigation context and CreateCases on
    # the user's AWS account.
    # =====================================================================

    # ---- Toast / inline notices ----------------------------------------
    "support.toast.missing_incident": {
        "zh": "⚠️ 缺少 incident_id",
        "en": "⚠️ Missing incident_id",
    },
    "support.toast.missing_chat": {
        "zh": "⚠️ 缺少 chat_id",
        "en": "⚠️ Missing chat_id",
    },
    "support.toast.form_sent": {
        "zh": "📋 已发送升级表单",
        "en": "📋 Escalation form sent",
    },
    "support.toast.form_send_failed": {
        "zh": "⚠️ 发送表单失败",
        "en": "⚠️ Failed to send form",
    },
    "support.toast.exception": {
        # Security: type only; raw detail → CloudWatch (logger.exception at call site).
        "zh": "⚠️ 出错了 ({kind})，请稍后重试。",
        "en": "⚠️ Something went wrong ({kind}). Please try again later.",
    },
    "support.toast.invalid_severity": {
        "zh": "无效的 severity: {severity}",
        "en": "Invalid severity: {severity}",
    },
    "support.toast.session_expired": {
        "zh": "会话过期",
        "en": "Session expired",
    },
    "support.toast.created": {
        "zh": "已开案例",
        "en": "Case opened",
    },
    "support.toast.creating": {
        "zh": "正在创建案例…",
        "en": "Creating case…",
    },
    "support.toast.flow_crashed": {
        # Security: type only; raw detail → CloudWatch.
        "zh": "支持流程出错 ({kind})，请稍后重试。",
        "en": "Support flow crashed ({kind}). Please try again later.",
    },

    # ---- Cancel card ----------------------------------------------------
    "support.cancel.title": {
        "zh": "🚫 已取消升级",
        "en": "🚫 Escalation cancelled",
    },
    "support.cancel.body": {
        "zh": "如需重新升级,请点击上方报告卡片中的 **🆘 升级到 AWS Support** 按钮。",
        "en": "To escalate again, tap the **🆘 Escalate to AWS Support** button on the report card above.",
    },

    # ---- Expired-context card -------------------------------------------
    "support.expired.title": {
        "zh": "⚠️ 会话上下文已过期",
        "en": "⚠️ Conversation context expired",
    },
    "support.expired.body": {
        "zh": "调查内容已超过 7 天保留期,无法关联。请重新触发调查后再升级。",
        "en": "The investigation has exceeded the 7-day retention window and can no longer be linked. Please trigger a fresh investigation before escalating.",
    },

    # ---- Form card ------------------------------------------------------
    "support.form.title": {
        "zh": "🆘 升级到 AWS Support",
        "en": "🆘 Escalate to AWS Support",
    },
    "support.form.intro": {
        "zh": ("将根据本次调查内容,自动开一个 AWS Support 案例,"
               "调查报告会作为附件正文提交。\n\n"
               "请填写下方表单,然后点击 **🚀 提交并开案例**。"),
        "en": ("This will automatically open an AWS Support case using the "
               "current investigation; the report will be submitted as the "
               "case body.\n\n"
               "Fill in the form below, then tap **🚀 Submit & open case**."),
    },
    "support.form.subject_label": {
        "zh": "**案例主题**(简短描述,≤120 字)",
        "en": "**Subject** (short description, ≤120 chars)",
    },
    "support.form.language_label": {
        "zh": "**案例语言**",
        "en": "**Case language**",
    },
    "support.form.language_placeholder": {
        "zh": "选择案例语言",
        "en": "Select case language",
    },
    "support.form.severity_label": {
        "zh": "**案例严重等级**",
        "en": "**Case severity**",
    },
    "support.form.severity_placeholder": {
        "zh": "选择案例严重等级",
        "en": "Select case severity",
    },
    "support.form.notes_label": {
        "zh": "**补充说明**(可选,可换行)",
        "en": "**Additional notes** (optional, multi-line)",
    },
    "support.form.notes_placeholder": {
        "zh": "可选:给 AWS Support 工程师的额外说明、复现步骤、影响范围等",
        "en": "Optional: extra notes for the AWS Support engineer — repro steps, blast radius, etc.",
    },
    "support.form.btn.submit": {
        "zh": "🚀 提交并开案例",
        "en": "🚀 Submit & open case",
    },
    "support.form.btn.cancel": {
        "zh": "取消升级",
        "en": "Cancel escalation",
    },
    "support.form.account_note": {
        "zh": "_提示:案例将开在当前 AWS 账号(运行本 bot 的账号),需 Business / Enterprise Support 计划。_",
        "en": "_Note: the case opens in the current AWS account (the one this bot runs in). Requires Business / Enterprise Support plan._",
    },

    # ---- Pending card ---------------------------------------------------
    "support.pending.title": {
        "zh": "⏳ 正在创建 AWS Support 案例",
        "en": "⏳ Creating AWS Support case",
    },
    "support.pending.body": {
        "zh": ("**严重等级** · {severity}\n"
               "**语言** · {language}\n\n"
               "正在调用 AWS Support API,预计 5–15 秒…\n"
               "_完成后这张卡片会自动更新成案例详情。_"),
        "en": ("**Severity** · {severity}\n"
               "**Language** · {language}\n\n"
               "Calling the AWS Support API, ~5–15s…\n"
               "_This card will refresh into case details when done._"),
    },

    # ---- Success card ---------------------------------------------------
    "support.success.title": {
        "zh": "✅ 已开 AWS Support 案例",
        "en": "✅ AWS Support case opened",
    },
    "support.success.case_id_block": {
        "zh": "**🆔 案例 ID**\n{case_id}",
        "en": "**🆔 Case ID**\n{case_id}",
    },
    "support.success.subject_block": {
        "zh": "\n\n**📌 案例主题**\n{subject}",
        "en": "\n\n**📌 Subject**\n{subject}",
    },
    "support.success.case_link_block": {
        "zh": "**🔗 案例链接**\n[{url}]({url})",
        "en": "**🔗 Case link**\n[{url}]({url})",
    },
    "support.success.severity_lang_block": {
        "zh": ("**严重等级** · {severity}\n"
               "**语言** · {language}{classification}\n"
               "**Incident** · {incident_id}\n\n"
               "AWS Support 工程师会在工单上回复。"),
        "en": ("**Severity** · {severity}\n"
               "**Language** · {language}{classification}\n"
               "**Incident** · {incident_id}\n\n"
               "AWS Support engineers will reply on the case."),
    },
    "support.success.btn.open_case": {
        "zh": "🌐 打开案例",
        "en": "🌐 Open case",
    },
    "support.success.login_warning": {
        "zh": "_⚠️ 该链接需要登录 AWS 控制台才能查看案例。_",
        "en": "_⚠️ The link requires an active AWS Console login to view the case._",
    },

    # ---- Failure card ---------------------------------------------------
    "support.failure.title": {
        "zh": "❌ 开案例失败 ({code})",
        "en": "❌ Failed to open case ({code})",
    },
    "support.failure.title_no_code": {
        "zh": "❌ 开案例失败",
        "en": "❌ Failed to open case",
    },

    # ---- Slack-only — modal titles capped at 24 chars; section/result -------
    # blocks use single-star Slack mrkdwn instead of the lark_md double-star
    # used by the Feishu side. Mirrors the case_flow `*_slack` / `*_short`
    # split.
    "support.modal.title_short": {
        "zh": "🆘 升级到 Support",
        "en": "🆘 AWS Support",
    },
    "support.modal.submit_short": {
        "zh": "🚀 提交开案例",
        "en": "🚀 Submit",
    },
    "support.modal.cancel_short": {
        "zh": "取消",
        "en": "Cancel",
    },
    "support.form.intro_short": {
        "zh": "将根据本次调查内容,自动开一个 AWS Support 案例,调查报告会作为附件正文提交。",
        "en": "This will automatically open an AWS Support case using the current investigation; the report will be submitted as the case body.",
    },
    "support.form.subject_label_short": {
        "zh": "案例主题(简短描述,≤120 字)",
        "en": "Subject (short description, ≤120 chars)",
    },
    "support.form.severity_label_short": {
        "zh": "案例严重等级",
        "en": "Case severity",
    },
    "support.form.language_label_short": {
        "zh": "案例语言",
        "en": "Case language",
    },
    "support.form.notes_label_short": {
        "zh": "补充说明(可选,可换行)",
        "en": "Additional notes (optional, multi-line)",
    },
    "support.form.notes_placeholder_short": {
        "zh": "可选:复现步骤、影响范围、已尝试的排查",
        "en": "Optional: repro steps, blast radius, what you've tried",
    },
    "support.expired.modal_error_short": {
        "zh": "会话上下文已过期(7 天保留期)。请重新触发调查后再升级。",
        "en": "Session context expired (7-day retention). Re-trigger the investigation before escalating.",
    },
    "support.success.id_link_block_slack": {
        "zh": ("*🆔 案例 ID*\n{case_id}{subject_line}\n\n"
               "*🔗 案例链接*\n<{case_url}|{case_url}>"),
        "en": ("*🆔 Case ID*\n{case_id}{subject_line}\n\n"
               "*🔗 Case link*\n<{case_url}|{case_url}>"),
    },
    "support.success.subject_block_slack": {
        "zh": "\n*📌 案例主题*\n{subject}",
        "en": "\n*📌 Subject*\n{subject}",
    },
    "support.success.severity_lang_block_slack": {
        "zh": ("*严重等级* · {severity}\n"
               "*语言* · {language}{classification}\n"
               "*Incident* · `{incident_id}`\n\n"
               "AWS Support 工程师会在工单上回复。"),
        "en": ("*Severity* · {severity}\n"
               "*Language* · {language}{classification}\n"
               "*Incident* · `{incident_id}`\n\n"
               "AWS Support engineers will reply on the case."),
    },
    "support.failure.fail_block_slack": {
        "zh": "❌ *开案例失败 ({code})*\n{hint}",
        "en": "❌ *Failed to open case ({code})*\n{hint}",
    },
    "support.failure.internal_error_block_slack": {
        # Security: surface only the exception type; full detail stays in CloudWatch.
        "zh": "❌ *开案例失败*\n内部错误 (`{kind}`)，请稍后重试。",
        "en": "❌ *Failed to open case*\nInternal error (`{kind}`). Please try again later.",
    },
    "support.sync.success_block_slack": {
        "zh": ("✅ *调查报告已同步到 case `{display_id}`*\n"
               "AWS Support 工程师可以直接在工单上看到。"),
        "en": ("✅ *Investigation report synced to case `{display_id}`*\n"
               "AWS Support engineers can see it directly on the ticket."),
    },
    "support.sync.fail_block_slack": {
        "zh": ("❌ *同步失败*\n未能把报告同步到 case `{display_id}`。"
               "请稍后重试或在控制台手动添加。"),
        "en": ("❌ *Sync failed*\nCould not sync the report to case "
               "`{display_id}`. Please retry later or add it manually in the console."),
    },
    "support.sync.internal_error_block_slack": {
        # Security: surface only the exception type; full detail stays in CloudWatch.
        "zh": "❌ *同步失败*\n内部错误 (`{kind}`)，请稍后重试。",
        "en": "❌ *Sync failed*\nInternal error (`{kind}`). Please try again later.",
    },
    "support.creating_status_msg": {
        "zh": "⏳ 正在创建案例 ({severity}, {language})…",
        "en": "⏳ Creating case ({severity}, {language})…",
    },

    # ---- Platform main.py shared strings -------------------------------
    "main.usage_hint": {
        "zh": "Hi 👋 给我一条指令吧,例如:`查 IAD 所有 EC2 信息`",
        "en": "Hi 👋 Send me a command, e.g. `list all EC2 in us-east-1`",
    },
    "dingtalk.phase2_not_yet": {
        "zh": ("👷 这个意图(skill 编排 / 主动观察等)在钉钉端属于后续 Phase "
               "计划,目前先用飞书或 Slack。基础调查 / 概念问答 / Support "
               "case 管理 / 模型切换 / 语言切换 都已经可用。"),
        "en": ("👷 This intent (skill orchestration / push observation, "
               "etc.) is on the DingTalk later-phase roadmap. Use Feishu "
               "or Slack for now. Basic investigation, concept Q&A, "
               "Support case management, and model / language switching "
               "already work."),
    },
    # ----- DingTalk conversational case-create flow -----
    "dingtalk.case.create.prompt_title": {
        "zh": "📝 创建 AWS Support Case",
        "en": "📝 Create AWS Support Case",
    },
    "dingtalk.case.create.prompt_body": {
        "zh": ("请用一条消息把 case 详情发给我:\n\n"
               "- **第一行 = 主题(subject)**\n"
               "- **后面几行 = 详细描述(body)**\n\n"
               "例如:\n```\nRDS my-db CPU 持续 100%\n实例 ID:db-prod-01\n"
               "持续时间:过去 1 小时\n影响:订单服务变慢\n```\n\n"
               "随时回复 `取消` 退出。"),
        "en": ("Please send the case details in ONE message:\n\n"
               "- **First line = subject**\n"
               "- **Remaining lines = body / details**\n\n"
               "Example:\n```\nRDS my-db CPU pinned at 100%\n"
               "Instance: db-prod-01\nWindow: past 1 hour\n"
               "Impact: order service degraded\n```\n\n"
               "Reply `cancel` at any time to abort."),
    },
    "dingtalk.case.create.empty_details": {
        "zh": "我没看到内容,请把 subject 和 body 一起发一条消息给我,或者回复 `取消`。",
        "en": "Empty content. Please send subject + body in one message, "
              "or reply `cancel` to abort.",
    },
    "dingtalk.case.create.cancelled": {
        "zh": "✅ 已取消创建 case。",
        "en": "✅ Case creation cancelled.",
    },
    "dingtalk.case.create.failed": {
        "zh": "❌ 创建 case 时出现意外错误,请稍后再试或去 AWS Support 控制台手动创建。",
        "en": "❌ Unexpected error creating the case. Try again later or "
              "create it manually in the AWS Support console.",
    },
    "dingtalk.case.create.error_title": {
        "zh": "❌ 创建 case 失败",
        "en": "❌ Case creation failed",
    },
    "dingtalk.case.create.error_body": {
        "zh": "AWS Support API 返回:\n- 错误代码:`{code}`\n- 详情:{message}",
        "en": "AWS Support API responded:\n- Error code: `{code}`\n"
              "- Detail: {message}",
    },
    "dingtalk.case.create.ok_title": {
        "zh": "✅ Case 已创建 · {display_id}",
        "en": "✅ Case created · {display_id}",
    },
    "dingtalk.case.create.ok_body": {
        "zh": ("- **Display ID:** {display_id}\n"
               "- **Severity:** {severity}\n"
               "- **Language:** {language}\n"
               "- **Console:** [打开 case]({case_url})\n\n"
               "AWS Support 工程师收到后会在 case 里回复,你也可以让我"
               "继续追查:`@bot 回复 case {display_id} <消息内容>` 或 "
               "`@bot 关闭 case {display_id}`。"),
        "en": ("- **Display ID:** {display_id}\n"
               "- **Severity:** {severity}\n"
               "- **Language:** {language}\n"
               "- **Console:** [Open case]({case_url})\n\n"
               "AWS Support engineers will reply on the case. You can "
               "also follow up here: `@bot reply case {display_id} <text>` "
               "or `@bot close case {display_id}`."),
    },
    # ----- DingTalk case list / view / reply / resolve -----
    "dingtalk.case.list.title": {
        "zh": "🗂  最近的 Support Case",
        "en": "🗂  Recent Support Cases",
    },
    "dingtalk.case.list.header": {
        "zh": "**最近 {n} 条** (filter=`{filter}`):",
        "en": "**Most recent {n}** (filter=`{filter}`):",
    },
    "dingtalk.case.list.empty": {
        "zh": "🟢 没有匹配的 case (filter=`{filter}`)。",
        "en": "🟢 No matching cases (filter=`{filter}`).",
    },
    "dingtalk.case.view.title": {
        "zh": "📄 Case · {display_id}",
        "en": "📄 Case · {display_id}",
    },
    "dingtalk.case.view.subject": {
        "zh": "主题",
        "en": "Subject",
    },
    "dingtalk.case.view.missing_id": {
        "zh": "请告诉我 case ID,例如 `case 177968247000414`。",
        "en": "Please tell me the case ID, e.g. `case 177968247000414`.",
    },
    "dingtalk.case.view.not_found": {
        "zh": "❓ 没找到 case `{display_id}`。",
        "en": "❓ Case `{display_id}` not found.",
    },
    "dingtalk.case.reply.missing_id": {
        "zh": "请告诉我要回复哪个 case,例如 `回复 case 177968 ... <你的消息>`。",
        "en": "Tell me which case to reply to, e.g. "
              "`reply case 177968 ... <your message>`.",
    },
    "dingtalk.case.reply.missing_body": {
        "zh": "你想回复什么内容?把消息一起写在同一行里。",
        "en": "What do you want to reply with? Include the message text "
              "on the same line.",
    },
    "dingtalk.case.reply.ok": {
        "zh": "✅ 已把回复追加到 case `{display_id}`。",
        "en": "✅ Reply appended to case `{display_id}`.",
    },
    "dingtalk.case.reply.failed": {
        "zh": "❌ 追加回复失败 — 可能权限不足或 case 已关闭。",
        "en": "❌ Failed to append reply — likely insufficient permission "
              "or the case is already resolved.",
    },
    "dingtalk.case.resolve.missing_id": {
        "zh": "请告诉我要关闭哪个 case,例如 `关闭 case 177968...`。",
        "en": "Tell me which case to close, e.g. `close case 177968...`.",
    },
    "dingtalk.case.resolve.ok": {
        "zh": "✅ Case `{display_id}` 状态:{status}",
        "en": "✅ Case `{display_id}` status: {status}",
    },
    "dingtalk.case.resolve.failed": {
        "zh": "❌ 关闭 case `{display_id}` 失败。",
        "en": "❌ Failed to close case `{display_id}`.",
    },
    "main.unsupported_msg_type": {
        "zh": "我目前只能处理文本消息哦。请直接发文字给我～",
        "en": "I can only handle text messages right now. Please send "
              "plain text.",
    },
    "main.unknown_action": {
        "zh": "未知操作",
        "en": "Unknown action",
    },
    "main.missing_event_id": {
        "zh": "⚠️ 缺少 event_id",
        "en": "⚠️ Missing event_id",
    },
    "main.missing_query": {
        "zh": "⚠️ 缺少 query",
        "en": "⚠️ Missing query",
    },
    "main.missing_chat_id": {
        "zh": "⚠️ 缺少 chat_id",
        "en": "⚠️ Missing chat_id",
    },
    "main.duplicate_dispatch": {
        "zh": "⏳ 已派发过该建议,请稍后看结果",
        "en": "⏳ This follow-up was already dispatched; check back for "
              "the result shortly.",
    },
    "main.next_step.dispatched_new": {
        "zh": "🚀 已派发新调查",
        "en": "🚀 New investigation dispatched",
    },
    "main.next_step.report_pending": {
        "zh": "🔍 已根据建议启动新调查\n> {query}\n\n几分钟后报告会发到本对话。",
        "en": "🔍 New investigation started based on the suggested "
              "next step:\n> {query}\n\nThe report will arrive in this "
              "conversation in a few minutes.",
    },
    "main.send_card_failed": {
        "zh": "⚠️ 发送确认卡片失败: {detail}",
        "en": "⚠️ Failed to send confirmation card: {detail}",
    },
    # {status} now carries either an HTTP status (legacy webhook path) or
    # a create_investigation error string (idle STS+API path). Kept generic
    # so neither reads awkwardly.
    "main.dispatch_failed_short": {
        "zh": "⚠️ 派发失败: {status}",
        "en": "⚠️ Dispatch failed: {status}",
    },
    "main.case_flow_crashed": {
        # Security: type only; raw detail → CloudWatch.
        "zh": "Case 流程出错 ({kind})，请稍后重试。",
        "en": "Case flow error ({kind}). Please try again later.",
    },
    "main.dispatch_thread_failed": {
        # Security: type only; raw detail → CloudWatch.
        "zh": "派发失败 ({kind})，请稍后重试。",
        "en": "Dispatch failed ({kind}). Please try again later.",
    },
    "main.failed_user_id": {
        "zh": "⚠️ 无法识别用户。",
        "en": "⚠️ Could not identify user.",
    },
    "main.channel_unauthorized": {
        "zh": "当前频道未授权使用 NotiOps。",
        "en": "This channel is not authorized to use NotiOps.",
    },
    "main.command_usage": {
        "zh": "请在命令后跟一条指令,例如 `/devops 我的 case`",
        "en": "Please add a command after the slash, e.g. `/devops my cases`",
    },
    "main.modal_submit_failed": {
        "zh": "提交失败: {detail}",
        "en": "Submission failed: {detail}",
    },
    "main.editor_open_failed": {
        "zh": "⚠️ 编辑器打开失败,请点 *派发* 直接发送。",
        "en": "⚠️ Failed to open editor; tap *Dispatch* to send as-is.",
    },
    "main.dispatched_short": {
        "zh": "已派发",
        "en": "Dispatched",
    },
    # -- Skill lifecycle commands ------------------------------------------
    "skill.usage": {
        "zh": (
            "**Skill 命令用法**\n"
            "• `/skills list` — 列出所有 skill\n"
            "• `/skills get <id> [version]` — 查看详情\n"
            "• `/skills history <id>` — 版本历史\n"
            "• `/skills run <id> [version] [k=v ...]` — 运行（默认 latest）\n"
            "• `/skills rollback <id> <version>` — 回滚 latest 指针\n"
            "• `/skills archive <id>` — 归档\n"
            "• `/skills create <goal>` + 下一行起的 prompt 正文"
        ),
        "en": (
            "*Skill commands*\n"
            "• `/skills list` — list all skills\n"
            "• `/skills get <id> [version]` — view details\n"
            "• `/skills history <id>` — version history\n"
            "• `/skills run <id> [version] [k=v ...]` — run (default: latest)\n"
            "• `/skills rollback <id> <version>` — repoint latest at older version\n"
            "• `/skills archive <id>` — archive (hidden from list, still runnable)\n"
            "• `/skills create <goal>` + prompt body on the following lines"
        ),
    },
    "skill.list.empty": {
        "zh": "暂无 skill。用 `/skills create <goal>` 创建第一个。",
        "en": "No skills yet. Create one with `/skills create <goal>`.",
    },
    "skill.list.header": {
        "zh": "**已注册 Skill**",
        "en": "*Registered skills*",
    },
    "skill.list.entry": {
        "zh": "• `{skill_id}` v{version} ({count} 版本) — {name}",
        "en": "• `{skill_id}` v{version} ({count} versions) — {name}",
    },
    "skill.detail.body": {
        "zh": (
            "**{name}** (`{skill_id}`)\n"
            "版本: v{version} (latest: v{latest})\n"
            "状态: {status} | 参数: {params}\n"
            "描述: {description}\n"
            "```\n{prompt}\n```"
        ),
        "en": (
            "*{name}* (`{skill_id}`)\n"
            "Version: v{version} (latest: v{latest})\n"
            "Status: {status} | Parameters: {params}\n"
            "Description: {description}\n"
            "```\n{prompt}\n```"
        ),
    },
    "skill.history.header": {
        "zh": "**`{skill_id}` 版本历史**",
        "en": "*Version history of `{skill_id}`*",
    },
    "skill.history.entry": {
        "zh": "• v{version} — {changelog} ({date})",
        "en": "• v{version} — {changelog} ({date})",
    },
    "skill.params.none": {
        "zh": "无",
        "en": "none",
    },
    "skill.created": {
        "zh": "✅ 已创建 skill `{skill_id}` v{version}",
        "en": "✅ Created skill `{skill_id}` v{version}",
    },
    "skill.rolled_back": {
        "zh": "↩️ `{skill_id}` 已回滚到 v{version}",
        "en": "↩️ `{skill_id}` rolled back to v{version}",
    },
    "skill.archived": {
        "zh": "📦 `{skill_id}` 已归档（仍可运行，从列表隐藏）",
        "en": "📦 `{skill_id}` archived (still runnable, hidden from list)",
    },
    "skill.create.body_too_short": {
        "zh": "⚠️ create 需要 prompt 正文（命令行下一行开始，≥20 字符）",
        "en": "⚠️ create needs a prompt body on the following lines (≥20 chars)",
    },
    "skill.run.dispatched": {
        "zh": "🚀 已用 `{skill_id}` v{version} 发起调查，报告完成后会回到此处。",
        "en": "🚀 Investigation dispatched with `{skill_id}` v{version}. "
              "The report will be delivered here when done.",
    },
    "skill.run.dispatch_failed": {
        "zh": "❌ dispatch 失败 ({status}): {body}",
        "en": "❌ Dispatch failed ({status}): {body}",
    },
    "skill.error": {
        "zh": "❌ {message}",
        "en": "❌ {message}",
    },
    "skill.error.unexpected": {
        # Security: no raw message surfaced; full detail → CloudWatch (logger.exception).
        "zh": "❌ skill 命令异常，请稍后重试。",
        "en": "❌ skill command error. Please try again later.",
    },

    # -- Query command --------------------------------------------------------
    "query.unknown_type": {
        "zh": "不支持的查询类型: {type}",
        "en": "Unsupported query type: {type}",
    },
    "query.no_data": {
        "zh": "暂无 {type} 数据。定时任务可能尚未执行。",
        "en": "No {type} data available yet. The scheduled task may not have run.",
    },

    # ── Natural-language auto-dispatch card ──────────────────────────────
    "skill.dispatch.chosen": {
        "zh": "🤖 已为你选择 skill：**{name}**",
        "en": "🤖 Auto-selected skill: *{name}*",
    },
    "skill.dispatch.reason": {
        "zh": "原因：{reason}（置信度 {confidence}）",
        "en": "Why: {reason} (confidence {confidence})",
    },
    "skill.dispatch.missing": {
        "zh": "还需补充：{params}（在下方填写后点击派发）",
        "en": "Still needed: {params} (fill in below, then click submit)",
    },
    "skill.dispatch.param_label": {
        "zh": "参数 {param}",
        "en": "Parameter {param}",
    },
    "skill.dispatch.btn.switch": {
        "zh": "🔄 换 skill",
        "en": "🔄 Switch skill",
    },
    "skill.dispatch.btn.dont_use": {
        "zh": "❌ 不用 skill",
        "en": "❌ Don't use a skill",
    },
    "skill.dispatch.switch_label": {
        "zh": "🔄 换一个 skill",
        "en": "🔄 Switch to another skill",
    },
    "skill.dispatch.switch_hint": {
        "zh": "想换一个 skill？用 `/skills list` 查看全部，再用 `/skills run <id>` 运行；"
              "或直接重新描述你的问题，我会重新匹配。",
        "en": "Want a different skill? Run `/skills list` to see them all, then "
              "`/skills run <id>`; or just rephrase your question and I'll re-match.",
    },

    # ── Model-assisted skill authoring confirm-card ─────────────────────
    "skill.author.draft": {
        "zh": "🤖 我把「{goal}」展开成了 skill 草稿：**{name}**",
        "en": "🤖 Expanded \"{goal}\" into a skill draft: *{name}*",
    },
    "skill.author.params": {"zh": "参数", "en": "Parameters"},
    "skill.author.param_row": {
        "zh": "• `{name}`{required}{default} — {description}",
        "en": "• `{name}`{required}{default} — {description}",
    },
    "skill.author.no_params": {"zh": "（无参数）", "en": "(no parameters)"},
    "skill.author.version_new": {
        "zh": "将保存为版本 **v{version}**",
        "en": "Will be saved as version *v{version}*",
    },
    "skill.author.version_bump": {
        "zh": "版本 v{current} → **v{next}**（{level}）",
        "en": "Version v{current} → *v{next}* ({level})",
    },
    "skill.author.lint_header": {"zh": "检查结果：", "en": "Checks:"},
    "skill.author.btn.save": {"zh": "✅ 保存", "en": "✅ Save"},
    "skill.author.btn.edit": {"zh": "✏️ 修改", "en": "✏️ Edit"},
    "skill.author.btn.cancel": {"zh": "❌ 取消", "en": "❌ Cancel"},
    "skill.author.lint.placeholder_without_param": {
        "zh": "❌ prompt 里有占位符 `{{{name}}}` 但没有声明对应参数（运行时会原样保留）",
        "en": "❌ prompt uses `{{{name}}}` but no matching parameter is declared (it will render literally)",
    },
    "skill.author.lint.param_without_placeholder": {
        "zh": "⚠️ 参数 `{name}` 没有在 prompt 里被使用（多余输入）",
        "en": "⚠️ parameter `{name}` is never used in the prompt (dead input)",
    },
    "skill.author.lint.required_with_default": {
        "zh": "⚠️ 参数 `{name}` 同时设了必填和默认值（默认值已生效，必填被忽略）",
        "en": "⚠️ parameter `{name}` is both required and has a default (the default wins)",
    },
    "skill.author.lint.prompt_too_short": {
        "zh": "❌ prompt 太短（至少 {min} 字）",
        "en": "❌ prompt is too short (min {min} chars)",
    },
    "skill.author.lint.bad_skill_id": {
        "zh": "❌ skill id `{skill_id}` 不合法（需小写 kebab-case，2-64 字符）",
        "en": "❌ skill id `{skill_id}` is invalid (lowercase kebab-case, 2-64 chars)",
    },
    "skill.author.lint.missing_name": {
        "zh": "⚠️ 没有名称，将用 skill id 代替",
        "en": "⚠️ no name set; the skill id will be used instead",
    },
    "skill.author.lint.no_placeholders": {
        "zh": "⚠️ prompt 没有任何占位符，这个 skill 无法跨客户复用",
        "en": "⚠️ prompt has no placeholders; this skill won't be reusable across customers",
    },
    "skill.author.enrich_failed": {
        "zh": "🤖 没能把这句话展开成 skill 草稿，请换个说法或写得更具体一点。",
        "en": "🤖 Couldn't expand that into a skill draft — try rephrasing or adding detail.",
    },
    "skill.author.blocked": {
        "zh": "❌ 草稿还有必须修复的问题（见上方检查结果），请先点 ✏️ 修改。",
        "en": "❌ The draft still has blocking issues (see checks above) — click ✏️ Edit first.",
    },
    "skill.author.cancelled": {
        "zh": "已取消，草稿未保存。",
        "en": "Cancelled — the draft was not saved.",
    },
    "skill.author.edit_title": {"zh": "修改 skill 草稿", "en": "Edit skill draft"},
    "skill.author.field.name": {"zh": "名称", "en": "Name"},
    "skill.author.field.description": {"zh": "描述", "en": "Description"},
    "skill.author.field.prompt": {
        "zh": "Prompt（投给调查的模板，用 {占位符}）",
        "en": "Prompt (the investigation template; use {placeholders})",
    },
    "skill.author.field.tags": {
        "zh": "标签（空格或逗号分隔）",
        "en": "Tags (space- or comma-separated)",
    },

    # ── admin authz + maintenance commands ──────────────────────────────
    "skill.admin.denied": {
        "zh": "❌ 仅管理员可执行此操作（联系管理员或配置 SKILLS_ADMINS）。",
        "en": "❌ Admin-only action (ask an admin, or configure SKILLS_ADMINS).",
    },
    "skill.author.hint": {
        "zh": "💡 看起来你想创作一个 skill。请用 `/skills create <一句话目标>` 来创建，例如：`/skills create 检查闲置的 EC2 实例`。",
        "en": "💡 It looks like you want to author a skill. Use `/skills create <one-line goal>` — e.g. `/skills create review idle EC2 instances`.",
    },
    "skill.author.denied": {
        "zh": "💡 看起来你想创作一个 skill，但创作仅限管理员。请联系管理员代为创建，或直接提问让我帮你调查。",
        "en": "💡 It looks like you want to author a skill, but authoring is admin-only. Ask an admin to create it, or just ask me to investigate directly.",
    },
    "skill.unarchived": {
        "zh": "✅ 已恢复 skill `{skill_id}`（状态 → active）",
        "en": "✅ Unarchived skill `{skill_id}` (status → active)",
    },
    "skill.deleted": {
        "zh": "🗑️ 已永久删除 skill `{skill_id}`（含全部版本，不可恢复）",
        "en": "🗑️ Permanently deleted skill `{skill_id}` (all versions, irreversible)",
    },
    "skill.renamed": {
        "zh": "✅ 已重命名 skill `{old}` → `{new}`",
        "en": "✅ Renamed skill `{old}` → `{new}`",
    },
    "skill.meta_updated": {
        "zh": "✅ 已更新 skill `{skill_id}` 的元数据（未新增版本）",
        "en": "✅ Updated metadata for skill `{skill_id}` (no new version)",
    },
    "skill.diff.header": {
        "zh": "`{skill_id}` v{v1} → v{v2} 的 prompt 差异：",
        "en": "Prompt diff for `{skill_id}` v{v1} → v{v2}:",
    },
    "skill.run.missing_params": {
        "zh": "❌ 缺少必填参数：{params}。请用 k=v 提供，例如 `/skills run {skill_id} {first}=...`",
        "en": "❌ Missing required params: {params}. Provide as k=v, e.g. `/skills run {skill_id} {first}=...`",
    },
    "skill.author.lint.unsafe_prompt": {
        "zh": "❌ prompt 含疑似不安全内容：「{match}」（会以调查 agent 权限运行，请移除后再保存）",
        "en": "❌ prompt contains unsafe content: \"{match}\" (runs with the agent's access — remove before saving)",
    },
    "skill.audit.header": {
        "zh": "🧾 审计记录（最近）：",
        "en": "🧾 Audit trail (recent):",
    },
    "skill.audit.row": {
        "zh": "• {ts} — **{action}** `{skill_id}` by {actor} {version}",
        "en": "• {ts} — *{action}* `{skill_id}` by {actor} {version}",
    },
    "skill.audit.empty": {
        "zh": "（暂无审计记录）",
        "en": "(no audit records)",
    },
    "skill.stale.header": {
        "zh": "🧹 闲置 skill（{days} 天内未运行 / 从未运行）：",
        "en": "🧹 Stale skills (no run in {days} days / never run):",
    },
    "skill.stale.row": {
        "zh": "• `{skill_id}` — 运行 {run_count} 次，最近 {last_run_at}",
        "en": "• `{skill_id}` — {run_count} runs, last {last_run_at}",
    },
    "skill.stale.empty": {
        "zh": "✅ 没有闲置 skill（都在用）",
        "en": "✅ No stale skills (all in use)",
    },

}


_LOCALE_NAMES = {
    "zh": {"zh": "中文 (zh)", "en": "Chinese (zh)"},
    "en": {"zh": "英文 (en)", "en": "English (en)"},
}


def locale_name(locale: str, display_locale: str | None = None) -> str:
    """Human-readable name for `locale`, rendered in `display_locale`
    (defaults to `locale` itself — i.e. zh shown in Chinese).
    """
    display = display_locale or locale
    bundle = _LOCALE_NAMES.get(locale) or {}
    return bundle.get(display) or bundle.get("en") or locale


def t(key: str, locale: str = "en", **kwargs) -> str:
    """Look up `key` in `locale`. On any miss, fall back to en, then to
    the literal key. `**kwargs` are str.format-applied if non-empty."""
    bundle = _TRANSLATIONS.get(key)
    if not bundle:
        logger.warning("i18n: missing translation key %r", key)
        return key.format(**kwargs) if kwargs else key
    template = bundle.get(locale) or bundle.get("en") or key
    if kwargs:
        try:
            return template.format(**kwargs)
        except (KeyError, IndexError) as e:
            logger.warning("i18n: format failed for %r locale=%s: %s",
                           key, locale, e)
            return template
    return template
