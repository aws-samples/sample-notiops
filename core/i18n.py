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
    # ⚠️ 上面三条**不带秒表**的那一份 —— 给不会原地刷新的平台（钉钉）用，理由与
    # `im.chat.thinking_title.noclock` 逐字相同：那条消息发出去就定格，而这条路径
    # （`platforms/common/inv_status.py` 的状态回读）压根没有 `elapsed` 可传 ⇒ 渲染
    # 出来是「调查中 · 已用时 0 秒」/「调查已完成 · 用时 0 秒」。0 秒不是"少给信息"，
    # 是**假信息**：一次跑了 6 分钟的调查在用户眼里成了 0 秒。
    # 2026-09-09 现网原话：「在钉钉里，『已用时 0 秒』这个就不需要了」。
    # 消费方只有 `platforms/dingtalk/dt_messages._DISPATCH_TITLES_NOCLOCK`；飞书 /
    # Slack 的进度卡每分钟被 PATCH 一次，那两家的秒数是真话，**不许**用这三条。
    # ⚠️ 这三条同样**不许带方向词**（「见下方」/「见上方」/「below」…）—— 口径与下面
    # 报告文案那条注释一致。理由更硬：这条消息发出去就定格，方向指错了永远改不回来。
    "progress.investigating.noclock": {
        "zh": "🔍 调查中",
        "en": "🔍 Investigating",
    },
    # ⚠️ 这一条比"去掉秒表"还多丢一句：`progress.completed` 结尾的「· 报告见下方」在
    # 这条路上**也是假话**。三条 noclock 的唯一消费方是钉钉的 `dispatch_text`，而
    # `dispatch_text` 只有两个调用点（`platforms/dingtalk/caps.py` 的 267 / 342），
    # `done` / `failed` 只可能来自 342 那个**状态回读** —— 它的正文是
    # `inv_status.body()`（标题 + 状态 + 最近几条过程行），底下没有报告，只有一个控制台
    # 链接。报告是调查完成时由 `shared/report_delivery/dingtalk_sender.py` **另发**的一条
    # 推送，不在这条消息"下方"。所以这里只说"完成了"。
    "progress.completed.noclock": {
        "zh": "✅ 调查已完成",
        "en": "✅ Investigation completed",
    },
    "progress.failed.noclock": {
        "zh": "⚠️ 调查失败",
        "en": "⚠️ Investigation failed",
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
    # ⚠️ 措辞**不许再带方向词**（原文是「详见**上方**…链接」）。
    # 2026-09-05 起摘要与操作按钮合并成同一张卡，链接在正文**下方**；
    # 而 `send_markdown`（巡检播报）那条路径上根本没有这颗按钮。
    # 带方向的文案在这两处都是错的，而且错了不会报错 —— 只是让用户
    # 照着指错的方向找。
    "report.summary_truncated": {
        "zh": "⚠️ 卡片仅展示报告的开头部分 · 完整内容见「📊 查看完整报告」",
        "en": "⚠️ This card shows only the beginning of the report — "
              "full content via *📊 View full report*",
    },
    # 用户原始问题 / 调查目标。D1：报告卡与两个 HTML 页面上原来只有
    # task_id，用户看不出「这份报告是哪一次调查」。
    "report.header.subject": {
        "zh": "*🎯 调查目标* · {title}",
        "en": "*🎯 Investigation target* · {title}",
    },
    # 「没取到正文」≠「正文被截断」。以前两者都渲染成一句截断告警
    # （D4：现网出现过整张卡只有 35 个字符的告警、正文一个字都没有）。
    "report.no_body": {
        "zh": "_未取到报告正文 · 请用「📊 查看完整报告」，或看「🔍 调查过程 Trace」_",
        "en": "_No report body was retrieved — use *📊 View full report*, "
              "or the *🔍 Investigation trace*_",
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
    # 模型超时专用。与 `chitchat.downgraded` 分开是有意的：那条是「你好，我能帮你…」
    # 的能力介绍，用户真问了个问题、等了 5 分钟、拿到一段自我介绍，只会以为 bot 坏了。
    # 这里如实说「等了多久、为什么、下一步做什么」。
    # ⚠️ 文案里的「5 分钟」对应 core/bedrock_chat.py 的 read_timeout=300；改一处要改两处。
    "chitchat.model_timeout": {
        "zh": ("⏳ 模型 5 分钟内没有返回内容,这一轮我先停下了。\n"
               "\n通常是问题比较重、模型在做很长的推理。可以试:\n"
               "• 把问题拆小一点(只问一个服务、缩小时间范围)再发一次\n"
               "• 或换个出字更快的模型:`@bot model claude`\n"
               "• 要做长时间排查的话,直接说「排查 …」走深度调查那条路"),
        "en": ("⏳ The model returned nothing within 5 minutes, so I stopped "
               "waiting on this one.\n"
               "\nThat usually means the question is heavy and the model is "
               "doing a long reasoning pass. You can:\n"
               "• Narrow it down (one service, a shorter time range) and send "
               "again\n"
               "• Or switch to a faster model: `@bot model claude`\n"
               "• For a genuinely long investigation, say \"investigate …\" to "
               "take the deep-investigation path"),
    },
    "gpt.output_blocked": {
        "zh": ("⚠️ 当前模型(GPT-5.6 Terra)的本轮输出被审计拦截"
               "(疑似协议碎片或低质 token 混入),已跳过避免给你看到 garbage。\n"
               "\n建议切到稳定模型重试这一句:\n"
               "• `@bot model claude` → Claude Sonnet 5(内部测试中较稳定)\n"
               "• `@bot model nova` → Amazon Nova Pro(合规白名单友好)\n"
               "\n(所有模型均经 Amazon Bedrock 访问;GPT-5.6 Terra 当前为 experimental,见 USER_GUIDE §15.3。)"),
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
               "GPT-5.6 Terra is currently experimental, see USER_GUIDE §15.3.)"),
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
    # 工具循环调过工具、但没给出文本(撞迭代上限 / 中途 Throttling / 收尾轮失败),
    # 于是回答退回一次**不带任何工具结果**的裸调用 —— 这时 `📚 来源` 与
    # `🔧 调用的 MCP 工具` 两块都被清掉(它们描述的是没进入这段回答的东西),
    # 换成这一句。⚠️ 不许改成静默清掉:「没有来源」与「有来源但我没显示」
    # 对读者是两件事,而后者会被当成前者。
    "mcp.ungrounded_notice": {
        "zh": "⚠ 本次查阅 AWS 文档的调用没有返回结果,以上回答来自模型自身知识,"
              "未经文档核对 —— 请自行复核关键结论。",
        "en": "⚠ The AWS documentation lookup returned nothing this time, so the "
              "answer above comes from the model's own knowledge and was not "
              "checked against the docs — please verify key claims yourself.",
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
    "model.switch_nl_hint": {
        # NL "换个模型" can't name a specific alias (aliases are dynamic), so
        # we surface the list and let the user pick.
        "zh": "想换模型?下面是可用列表,回复 `model <alias>` 切换:",
        "en": "Want a different model? Here's the list — reply `model <alias>` to switch:",
    },

    # -- @bot agent / web —— 两个会话级开关（core/im_prefs.py）。归属规则与 `model`
    # 完全一致：群里一个群一份、私聊按人，任何成员都能切（不设管理员门）。
    #
    # ⚠️ 切到 notiops 的那句**必须**把"要花钱"说出来。IM 是被动入口（群里 @ 一下就是
    # 一轮），默认值是 devops（NotiOps 侧 0 token）；用户显式切过去时如果我们不说，
    # 他就是在不知情的前提下开了计费开关。这条口径的完整理由见 `core/im_prefs.py` 头部。
    "agent.label.devops": {
        "zh": "DevOps Agent(直连 · 无模型消耗)",
        "en": "DevOps Agent (direct · no model usage)",
    },
    "agent.label.notiops": {
        "zh": "NotiOps Agent(走模型 · 会消耗 token)",
        "en": "NotiOps Agent (uses the model · consumes tokens)",
    },
    # ⚠️ 标签里必须写「阿里云」：这条路 NotiOps 侧同样 0 token,但它看的是**阿里云**资源。
    # 只写 "STAROps(直连 · 无模型消耗)" 的下场是客户拿它问 EC2、得到"查不到",
    # 然后归因成产品坏了 —— 那是这三个标签里最贵的一种误解。
    "agent.label.starops": {
        "zh": "STAROps 数字员工(阿里云 · 直连 · 不消耗 NotiOps token)",
        "en": "STAROps digital employee (Alibaba Cloud · direct · no NotiOps tokens)",
    },
    "agent.current": {
        "zh": "🧭 当前对话由 **{label}** 回答(来源: {source})",
        "en": "🧭 Chat is answered by **{label}** (source: {source})",
    },
    "agent.set_chat": {
        "zh": "✅ 已切到 **{label}**。本群所有人之后都用它。",
        "en": "✅ Switched to **{label}**. Everyone in this chat will use it from now on.",
    },
    "agent.set_dm": {
        "zh": "✅ 已切到 **{label}**(仅本私聊)。",
        "en": "✅ Switched to **{label}** (this DM only).",
    },
    "agent.cleared": {
        "zh": "✅ 已清除偏好,回到默认的 DevOps Agent(无模型消耗)。",
        "en": "✅ Cleared preference; back to the default DevOps Agent (no model usage).",
    },
    "agent.set_failed": {
        "zh": "⚠️ 切换失败(DDB 写入错误),请稍后再试 —— 当前仍然是原来那个。",
        "en": "⚠️ Switch failed (DDB write error); please try again — still on the previous one.",
    },
    # ⚠️ 下面这一对（以及 `agent.usage` / `help.row.agent` 那两对）是**孪生文案**：
    #   · 基线 key = 当前发给客户的那份，**不含 starops**；
    #   · `<key>.multicloud` = 含 starops 的原文，逐字保留。
    # 选哪一份由 `core/multicloud.py` 的 `VISIBLE` 决定（2026-09-15 产品决策：多云先不
    # 对外，只藏文案、执行路径全留）。所以：**改基线的时候要顺手改孪生那份**，否则以后
    # 把多云翻回来，客户看到的是一份漂移了半年的旧文案。一致性由
    # `tests/test_multicloud_gate.py` 钉住（两份都必须存在、都必须双语）。
    "agent.unknown": {
        "zh": "⚠️ 未知的 agent `{arg}`。可用: `notiops` · `devops`",
        "en": "⚠️ Unknown agent `{arg}`. Available: `notiops` · `devops`",
    },
    "agent.unknown.multicloud": {
        "zh": "⚠️ 未知的 agent `{arg}`。可用: `notiops` · `devops` · `starops`",
        "en": "⚠️ Unknown agent `{arg}`. Available: `notiops` · `devops` · `starops`",
    },
    "agent.token_notice": {
        "zh": "⚠️ NotiOps Agent 走大模型,每一轮问答都会消耗 token。想回到不花钱的那条:`agent devops`。",
        "en": "⚠️ The NotiOps Agent calls the model — every turn consumes tokens. "
              "To go back to the free path: `agent devops`.",
    },
    # 孪生文案，见上面 `agent.unknown` 那段注释。
    "agent.usage": {
        "zh": "用法:`agent` 查看 · `agent notiops` 切到 NotiOps Agent(走模型) · "
              "`agent devops` 切回直连(无模型消耗) · `agent default` 清除偏好",
        "en": "Usage: `agent` to view · `agent notiops` for the NotiOps Agent (uses the model) · "
              "`agent devops` for the direct path (no model usage) · "
              "`agent default` to clear",
    },
    "agent.usage.multicloud": {
        "zh": "用法:`agent` 查看 · `agent notiops` 切到 NotiOps Agent(走模型) · "
              "`agent devops` 切回直连(无模型消耗) · `agent starops` 切到阿里云 STAROps "
              "数字员工(问阿里云资源) · `agent default` 清除偏好",
        "en": "Usage: `agent` to view · `agent notiops` for the NotiOps Agent (uses the model) · "
              "`agent devops` for the direct path (no model usage) · `agent starops` for the "
              "Alibaba Cloud STAROps digital employee (asks about Alibaba Cloud resources) · "
              "`agent default` to clear",
    },
    "agent.not_configured": {
        "zh": "⚠️ 这套部署没有接 NotiOps Agent(缺 `AGENT_RUNTIME_ARN`),切不过去。"
              "当前仍然是 DevOps Agent 直连。",
        "en": "⚠️ This deployment has no NotiOps Agent wired in (missing `AGENT_RUNTIME_ARN`), "
              "so the switch was not applied. Still on the DevOps Agent direct path.",
    },
    # ⚠️ 与 `agent.not_configured` 同一条口径:**拒绝且不写偏好**。这里要说清楚"去哪儿配"
    # 与"缺的是两样东西",否则客户只填了 AccessKey 就回来重试,又被拒一次。
    # 缺**哪一项**的精确话术在 `core/starops_chat.not_configured_text()`(对话时给),
    # 这里是切换时的拒绝 —— 只给去处,不重复那张表。
    "agent.starops_not_configured": {
        "zh": "⚠️ 还没配好阿里云 STAROps,切不过去。请到管理后台 →「多云」→ 阿里云,"
              "填好 **AccessKey**(ID + Secret)和 **数字员工 ID**,再切一次。"
              "当前仍然是原来那个 agent。",
        "en": "⚠️ Alibaba Cloud STAROps is not configured yet, so the switch was not applied. "
              "Go to Admin -> Multi-cloud -> Alibaba Cloud, fill in the **AccessKey** "
              "(ID + Secret) and the **digital employee ID**, then switch again. "
              "Still on the previous agent.",
    },
    # 切过去时的一次性提醒。两件事都必须说(理由同 `agent.token_notice`:IM 是被动入口):
    #   1. 问的是**阿里云**资源,不是 AWS;
    #   2. NotiOps 侧 0 token,但烧客户自己的阿里云 AI 额度。
    # `{employee}` 是数字员工 **ID**(不是显示名称)—— 一个阿里云账号可以有多个数字员工,
    # 纳管范围与答案质量完全不同,所以这是读答案时的必要坐标。
    "agent.starops_notice": {
        "zh": "ℹ️ 这条路直连你自己的阿里云 STAROps 数字员工 `{employee}`,问的是**阿里云**"
              "资源(不是 AWS)。NotiOps 侧不消耗 token,但会消耗你阿里云账号的 AI 额度。"
              "想回到问 AWS 的那条:`agent devops`。",
        "en": "ℹ️ This path talks directly to your own Alibaba Cloud STAROps digital employee "
              "`{employee}` and answers about **Alibaba Cloud** resources (not AWS). It uses no "
              "NotiOps tokens, but it does consume your Alibaba Cloud AI quota. "
              "To go back to asking about AWS: `agent devops`.",
    },

    # ── NotiOps Agent 那条路**跑起来之后**的失败话术（core/agent_chat.py）──────
    # 与上面 `agent.not_configured` 的区别是**时机**，不是措辞：那条是用户发
    # `/agent notiops` **切不过去**时的拒绝，这几条是已经切过去了、每一轮问答真的去
    # 调 runtime 时的失败。所以这几条都必须带**可执行的下一步**（切回直连 / 拆小问题 /
    # 走 `/investigate`）—— IM 里用户没有控制台可看，我们不说他就只有一句"失败了"。
    #
    # ⚠️ 这五条原本是 `core/agent_chat.py` 里一个本地 `dv(zh, en)` 三元helper，
    # 双语是全的、功能没错。搬过来的理由是**回退方向相反**：`dv()` 只判
    # `startswith("en")`，于是任何意外 locale（""、"ja"）都掉回**中文**，而
    # `i18n.t` 掉回**英文** —— 同一张卡里其它文案全走 `t()`，就会中英混排。
    "agent.chat.not_configured": {
        "zh": "⚠️ 这个部署没有接入 NotiOps Agent(缺 AGENT_RUNTIME_ARN)。\n\n"
              "先用 `/agent devops` 切回 DevOps Agent 直连(0 token),"
              "或者请管理员重新部署以接入。",
        "en": "⚠️ This deployment is not wired to the NotiOps agent "
              "(AGENT_RUNTIME_ARN is unset).\n\n"
              "Use `/agent devops` to switch back to the DevOps Agent direct path "
              "(0 tokens), or ask your administrator to redeploy with it enabled.",
    },
    "agent.chat.invoke_failed": {
        "zh": "⚠️ 调用 NotiOps Agent 失败({err})。稍后再试,"
              "或用 `/agent devops` 走 DevOps Agent 直连。",
        "en": "⚠️ Failed to reach the NotiOps agent ({err}). "
              "Please retry, or use `/agent devops` for the direct path.",
    },
    "agent.chat.no_stream": {
        "zh": "⚠️ NotiOps Agent 没有返回事件流。",
        "en": "⚠️ The NotiOps agent returned no event stream.",
    },
    "agent.chat.timed_out": {
        "zh": "⏱️ 这个问题跑了超过 {sec} 秒还没答完。可以拆小一点再问,"
              "或者用 `/investigate` 发起一次深度调查(异步,跑完回帖)。",
        "en": "⏱️ This took longer than {sec}s without finishing. "
              "Try a narrower question, or run `/investigate` "
              "(asynchronous — it posts back when done).",
    },
    "agent.chat.failed": {
        "zh": "⚠️ NotiOps Agent 这轮失败了({etype})。稍后再试,"
              "或用 `/agent devops` 走 DevOps Agent 直连。",
        "en": "⚠️ The NotiOps agent failed this turn ({etype}). "
              "Please retry, or use `/agent devops` for the direct path.",
    },
    "agent.chat.partial": {
        # 有正文但被我们掐断了 —— 追加在答案后面，所以不能自带换行/标题。
        "zh": "⏱️(已超过 {sec} 秒,上面是截断到此的部分答案)",
        "en": "⏱️ (cut off at {sec}s — the answer above is partial)",
    },

    "web.on": {"zh": "开", "en": "on"},
    "web.off": {"zh": "关", "en": "off"},
    "web.current": {
        "zh": "🌐 联网搜索:**{state}**(来源: {source})",
        "en": "🌐 Web search: **{state}** (source: {source})",
    },
    "web.set_chat": {
        "zh": "✅ 联网搜索已**{state}**。本群所有人之后都是这个设置。",
        "en": "✅ Web search is now **{state}**. Applies to everyone in this chat.",
    },
    "web.set_dm": {
        "zh": "✅ 联网搜索已**{state}**(仅本私聊)。",
        "en": "✅ Web search is now **{state}** (this DM only).",
    },
    "web.set_failed": {
        "zh": "⚠️ 设置失败(DDB 写入错误),请稍后再试。",
        "en": "⚠️ Update failed (DDB write error); please try again.",
    },
    "web.usage": {
        "zh": "用法:`web` 查看 · `web on` 开 · `web off` 关。只对 NotiOps Agent 生效。",
        "en": "Usage: `web` to view · `web on` · `web off`. Only affects the NotiOps Agent.",
    },
    "web.not_configured": {
        # ⚠️ 这条**目前没有任何调用点**，是留给后续那一步的，不是漏接线：
        # `core.web_search.configured()` 判的是 `AGENTCORE_WEBSEARCH_GATEWAY_URL`，而这个
        # 环境变量只注入到 **agent runtime**（方式A `notiops-webchat-standalone-stack.ts`
        # 的 conditionIf / 方式B `agentcore/agentcore.json` 的 envVars），IM Lambda 的
        # `commonEnv` 里没有 —— 也就是说 IM 侧**根本看不到**这套部署有没有联网出口，
        # 现在加检查只会是个永远为假的判断。
        # 而这也正好与 Web 端一致：`bff/web-chat/index.mjs` 把 `web_search` 原样透传，
        # 同样不做能力门。要让这条真能用，必须在**两条路径**上都把
        # `AGENTCORE_WEBSEARCH_GATEWAY_URL` 注进 `im-core.ts` 的 `commonEnv`（只接一边
        # 会让方式A/方式B 行为分叉，违反两条路径必须对等那条铁律）。
        "zh": "⚠️ 这套部署没有配联网搜索出口,打不开。要用的话请先在部署时启用联网搜索。",
        "en": "⚠️ This deployment has no web-search gateway configured, so it can't be enabled. "
              "Enable web search at deploy time first.",
    },
    "web.devops_noop": {
        # 追加在**查看**和**设置**两条回复后面，所以这句不能自带"设置已记下"——
        # 查看路径什么都没写，那样说就是假的。
        "zh": "ℹ️ 当前是 DevOps Agent 直连,联网与否由你自己那套 agent 决定 —— 这个开关只对 "
              "NotiOps Agent(`agent notiops`)生效。",
        "en": "ℹ️ You're on the DevOps Agent direct path, where web access is decided by your own "
              "agent — this switch only affects the NotiOps Agent (`agent notiops`).",
    },

    # -- /account — 「这个会话在问哪个 AWS 账号」。⚠️ 上车 / 启用 / 停用**只在 Web 做**，
    # IM 侧对注册表只读（`core/im_accounts.py`），所以每一句"加不了账号"的文案都必须
    # 把人指回 Web，而不是暗示"这里再试一次就行"。
    # 这里刻意**不打印部署账号号**（`account.current_default`）：拿它要一次 STS，而紧跟
    # 在后面的清单里那一行本来就带着 id，打两遍只是让查看路径多一次 AWS 调用。
    "account.current_default": {
        "zh": "🏦 当前在问**部署账号**(默认)。",
        "en": "🏦 Currently asking about the **deployment account** (default).",
    },
    "account.current_selected": {
        "zh": "🏦 当前在问账号 `{account}`(来源: {source})。",
        "en": "🏦 Currently asking about account `{account}` (source: {source}).",
    },
    "account.stale": {
        # §4.4 自愈：Web 上停用/下车之后**立刻**失效。这句是"为什么变回去了"的解释 ——
        # 少了它用户只看到"当前是部署账号"，会以为自己上次没切成功。
        "zh": "⚠️ 之前选的账号 `{account}` 现在不能问了(在 Web 端被停用或下车了),"
              "已自动回到部署账号。",
        "en": "⚠️ The account you picked earlier (`{account}`) is no longer available "
              "(disabled or offboarded in the web app), so we fell back to the deployment account.",
    },
    "account.list_title": {
        "zh": "可以问的账号:",
        "en": "Accounts you can ask about:",
    },
    "account.list_tag_deploy": {
        "zh": "部署账号(默认)",
        "en": "deployment account (default)",
    },
    "account.list_tag_locked": {
        # §4.1：闸门**不下沉**到列表 —— 已登记的账号照实列出来，只是标明现在切不过去。
        # 直接不显示等于让人以为"Web 上启用了但 IM 没同步"，那是另一个（不存在的）故障。
        "zh": "当前切不过去(单账号模式)",
        "en": "not selectable right now (single-account mode)",
    },
    "account.list_empty": {
        "zh": "ℹ️ 目前只有部署账号。要问别的账号,得先在 Web 端的「账号」页面把它上车并启用 —— "
              "IM 侧只读这份清单,不能在这里上车。",
        "en": "ℹ️ Only the deployment account is available. To ask about others, onboard and enable "
              "them on the Accounts page in the web app — the bot only reads that list; it can't "
              "onboard an account here.",
    },
    "account.locked_note": {
        # **查看**路径用这条（ℹ️，陈述事实）；**切换**路径用 `account.locked_refused`
        # （⚠️，明确说"没切"）。A1/A2 是两条不同的判据，共用一句会让"拒绝"看起来像"提示"。
        "zh": "ℹ️ 这套部署是单账号模式,只能问部署账号。要跨账号得以多账号模式重新部署"
              "(方式 A:开栈时选 `DeployMode=MultiAccount`;方式 B:`./setup.sh --multi-account`)。",
        "en": "ℹ️ This deployment is single-account, so the deployment account is the only one "
              "available. Cross-account needs a redeploy in multi-account mode "
              "(Option A: `DeployMode=MultiAccount`; Option B: `./setup.sh --multi-account`).",
    },
    "account.locked_refused": {
        "zh": "⚠️ 没切:这套部署是单账号模式。",
        "en": "⚠️ Not switched: this deployment is single-account.",
    },
    "account.not_enabled": {
        "zh": "⚠️ 没切:账号 `{account}` 不在已启用的清单里。请先在 Web 端的「账号」页面"
              "把它上车并启用 —— 上车只能在 Web 做,IM 侧只能从已启用的里面选。",
        "en": "⚠️ Not switched: account `{account}` is not in the enabled list. Onboard and enable "
              "it on the Accounts page in the web app first — onboarding only happens there; here "
              "you can only pick from what is already enabled.",
    },
    "account.set_chat": {
        "zh": "✅ 已切到账号 `{account}`。本群所有人之后问的都是这个账号。",
        "en": "✅ Switched to account `{account}`. Applies to everyone in this chat.",
    },
    "account.set_dm": {
        "zh": "✅ 已切到账号 `{account}`(仅本私聊)。",
        "en": "✅ Switched to account `{account}` (this DM only).",
    },
    "account.cleared": {
        "zh": "✅ 已回到默认 —— 部署账号。",
        "en": "✅ Back to the default — the deployment account.",
    },
    "account.set_failed": {
        "zh": "⚠️ 切换失败(DDB 写入错误),请稍后再试 —— 当前仍然是原来那个账号。",
        "en": "⚠️ Switch failed (DDB write error); please try again — you're still on the "
              "previous account.",
    },
    "account.unknown": {
        "zh": "🤔 没看懂 `{arg}` —— AWS 账号 id 是 12 位数字。",
        "en": "🤔 Didn't understand `{arg}` — an AWS account id is 12 digits.",
    },
    "account.usage": {
        "zh": "用法:`account` 看当前 + 列出可选 · `account <12 位账号 id>` 切换 · "
              "`account default` 回到部署账号。上车 / 启用只在 Web 端做。",
        "en": "Usage: `account` to see the current one and list the options · "
              "`account <12-digit id>` to switch · `account default` back to the deployment "
              "account. Onboarding and enabling happen in the web app.",
    },
    "account.case_notice": {
        # 2026-09-07 起 `case` 也跟着切了（跨账号建案）。这句话**留着**而不是删掉：
        # 开工单是本产品唯一的写操作,用户必须清楚它会落到哪个账号下 ——
        # "落错账号"这种事等到工单开出来才发现就晚了。
        "zh": "ℹ️ 说明:支持案例(开单 / 回复 / 关闭)也跟着走这个账号 —— 会开在 "
              "`{account}` 下。前提是该账号 onboarding 时允许了 NotiOps 代开工单。",
        "en": "ℹ️ Note: support cases (open / reply / resolve) follow this account too — "
              "they will be opened under `{account}`. This requires that the account "
              "allowed NotiOps to open cases on its behalf during onboarding.",
    },

    # -- /help — the command menu. Bilingual, lists BOTH language forms of
    # every command because a Chinese user won't guess `/调查` exists unless
    # we tell them. Rendered from core.nl_router.HELP_COMMANDS. --------------
    "help.title": {
        "zh": "🤖 NotiOps 命令菜单",
        "en": "🤖 NotiOps command menu",
    },
    "help.intro": {
        "zh": "你可以直接用大白话跟我说话,也可以用下面这些命令(中英文都行,`/` 可省略):",
        "en": "Talk to me in plain language, or use any of these commands "
              "(either language; the leading `/` is optional):",
    },
    # ⚠️ 每一行的自然语言示例都必须**中英各至少一条**,而不是"英文菜单只给英文例子"。
    # 抬头那句说的是「中英文都行」,例子却只有一种语言,等于自己拆自己的台 —— 看英文
    # 菜单的人不会知道「深入调查…」也认。所有示例一律用引号包起来(中文 「」、英文 “”),
    # `tests/test_im_help_menu.py::TestHelpExamplesActuallyRoute` 会**把引号里的字抽出来
    # 真的喂给 `nl_router.classify`**:菜单里承诺的每一句都必须真的命中对应意图。
    # 所以改这几行时不要凭感觉换措辞 —— 换了不匹配的说法测试会当场挂。
    "help.row.investigate": {
        "zh": "🔍 **深度调查** — `/investigate <内容>` 或 `/调查 <内容>`;也可以直接说「深度调查一下…」「根因分析」,英文 “deep dive on …” 一样认",
        "en": "🔍 **Deep investigation** — `/investigate <text>` or `/调查 <text>`; "
              "or just say “deep dive on …” / “root cause”, "
              "or in Chinese 「深入调查…」",
    },
    "help.row.case": {
        "zh": "🎫 **支持案例** — `/case`、`/cases`、`/案例`、`/工单`;也可以直接说「我要开案例」「转人工」,英文 “open a case” 一样认",
        "en": "🎫 **Support cases** — `/case`, `/cases`, `/案例`, `/工单`; "
              "or just say “open a case” / “escalate”, "
              "or in Chinese 「我要开案例」",
    },
    # ⚠️ 这三行的示例故意就是**命令本身**（`/` 可省略，所以「智能体 notiops」是真的
    # 能打的说法）。不给"大白话"示例是有意的：`agent` / `web` / `account` 是开关，猜错的
    # 代价是悄悄开了计费、悄悄关了联网,或者**把整个群问到另一个 AWS 账号上**,宁漏不误。
    # 引号样式仍要中英各一条（见上面那段）。
    # ⚠️ 这一行要与 `agent.usage` 列的取值**一致**：菜单里没写的档位等于没有这个功能
    #    （客户不会去猜 `/agent starops`）。所以这一对与 `agent.usage` 那一对是**同进
    #    同退**的 —— 孪生机制见上面 `agent.unknown` 那段注释。
    "help.row.agent": {
        "zh": "🧭 **谁来回答** — `/agent notiops|devops`、`/智能体 notiops|devops`;"
              "默认是 DevOps Agent 直连(无模型消耗),说「智能体 notiops」换成走模型的 "
              "NotiOps Agent,英文 “agent devops” 一样认",
        "en": "🧭 **Who answers** — `/agent notiops|devops`, `/智能体 notiops|devops`; "
              "defaults to the DevOps Agent (no model usage). Say “agent notiops” for the "
              "model-backed NotiOps Agent, or in Chinese 「智能体 devops」",
    },
    # starops 那一格必须点明是**阿里云** —— 不写「阿里云」的话，用户会以为它是另一个问
    # AWS 的档位，问一句 AWS 得到一句「查不到这个实例」，然后当成产品坏了。
    "help.row.agent.multicloud": {
        "zh": "🧭 **谁来回答** — `/agent notiops|devops|starops`、`/智能体 notiops|devops`;"
              "默认是 DevOps Agent 直连(无模型消耗),说「智能体 notiops」换成走模型的 "
              "NotiOps Agent,英文 “agent devops” 一样认;`/agent starops` 切到**阿里云** "
              "STAROps 数字员工(问阿里云资源,NotiOps 侧也不消耗 token)",
        "en": "🧭 **Who answers** — `/agent notiops|devops|starops`, `/智能体 notiops|devops`; "
              "defaults to the DevOps Agent (no model usage). Say “agent notiops” for the "
              "model-backed NotiOps Agent, or in Chinese 「智能体 devops」; `/agent starops` "
              "switches to your **Alibaba Cloud** STAROps digital employee (asks about "
              "Alibaba Cloud resources, also no NotiOps tokens)",
    },
    "help.row.web": {
        "zh": "🌐 **联网搜索** — `/web on|off`、`/联网 on|off`;默认关,只对 NotiOps Agent 生效,"
              "说「联网 on」打开,英文 “web off” 一样认",
        "en": "🌐 **Web search** — `/web on|off`, `/联网 on|off`; off by default and only affects "
              "the NotiOps Agent. Say “web on” to enable, or in Chinese 「联网 off」",
    },
    "help.row.account": {
        "zh": "🏦 **问哪个 AWS 账号** — `/account <12 位账号 id>`、`/账号 <账号 id>`;"
              "默认是部署账号,打「账号 列表」看有哪些可选,英文 “account list” 一样认。"
              "账号的上车 / 启用只在 Web 端做",
        "en": "🏦 **Which AWS account** — `/account <12-digit id>`, `/账号 <account id>`; "
              "defaults to the deployment account. Type “account list” to see the options, "
              "or in Chinese 「账号 列表」. Onboarding and enabling happen in the web app only",
    },
    "help.row.model": {
        "zh": "🧠 **切换模型** — `/model`、`/model list`、`/模型 list`;也可以说「换个模型」,英文 “switch model” 一样认",
        "en": "🧠 **Switch model** — `/model`, `/model list`, `/模型 list`; "
              "or say “switch model”, or in Chinese 「换个模型」",
    },
    "help.row.language": {
        "zh": "🌐 **切换语言** — `/language zh|en`、`/语言 zh|en`;也可以说「切换到英文」「说中文」,英文 “switch to English” 一样认",
        # ⚠️ 「说中文」用中文引号 —— 引号样式是上面那条测试分辨"这条示例是哪种语言"的
        # 唯一依据(「」=中文示例、“”=英文示例),用错了这一行就会被判成"没有中文示例"。
        "en": "🌐 **Switch language** — `/language zh|en`, `/语言 zh|en`; "
              "or say “switch to English” / 「说中文」",
    },
    # ⚠️ 既没有 `help.row.skills` 也没有 `skill.im_web_only`：skill 能力 2026-09-06 从
    # IM 侧整体退役（完整实现在 Web 端），连"去 Web 端"那句指路都不留 —— 打了 `/skills`
    # 由 `nl_router._UNKNOWN_SLASH_RE` 统一回 `/help` 菜单（0 token）。原因见
    # `core/nl_router.py` 文件末尾那段。别再把 skill 相关文案加回这张表。
    "help.row.help": {
        "zh": "❓ **帮助** — `/help`、`/帮助`",
        "en": "❓ **Help** — `/help`, `/帮助`",
    },
    "help.footer": {
        "zh": "_其它任何问题直接问我就行,不用记命令。_",
        "en": "_For anything else, just ask — no command needed._",
    },

    # -- Bidirectional fallback buttons (all 0 token). Two of the three reuse
    # existing handlers (support_flow / next_step_dispatch). See
    # ------------------------------------------------------------------------
    "router.btn.escalate_investigate": {
        "zh": "🔍 转深度调查",
        "en": "🔍 Escalate to deep dive",
    },
    "router.btn.open_case": {
        "zh": "🎫 开支持案例",
        "en": "🎫 Open a support case",
    },
    "router.btn.just_answer": {
        "zh": "💬 改为快速问答",
        "en": "💬 Just answer quickly",
    },
    # Visibility line — 0 token must not look like "nothing happened".
    "router.direct_no_token": {
        "zh": "⚡ 直连 DevOps Agent · 无模型消耗",
        "en": "⚡ Direct to DevOps Agent · no model usage",
    },
    # 走 NotiOps Agent 那条路的对应落款 —— 报**哪个 agent、哪个模型**。
    #
    # ⚠️ 2026-09-06 产品决策：**用量先不给客户看**。原来这两句写的是
    # 「🧠 NotiOps Agent · 8,545 tokens · 1 轮」,现在换成
    # 「Agent: NotiOps | Model: <真实模型 id>」。**统计本身一个字没动** ——
    # `core.agent_chat.run_agent_chat` 照样回 `usage`（`totalTokens` / `cycles` /
    # 缓存读写),照样进日志与指标;只是**不渲染到卡片上**。要重新露出来就是在
    # `usage_footer` 里把它拼回去,不需要动链路。
    #
    # 模型 id 来自 `usage["modelId"]`（`core.llm_config.resolve(alias).model_id`,
    # 与 agent 侧 `resolve_model_id()` 同一个模块、同一行 DDB 配置）—— 不是硬编码的
    # 默认模型名:Admin 换过默认模型、或用户 `/model` 点的那个已被停用而实际回落到别的
    # 模型时,落款必须说**实际生效**的那个,否则就是在跟客户报一个假的模型。
    #
    # 两个 locale **故意逐字相同**:这一行是技术标识（agent 名 + 模型 id）,翻译它
    # 只会让同一次回答在中英文界面看起来像用了两个不同的东西。
    "router.agent_model": {
        "zh": "Agent: NotiOps | Model: {model}",
        "en": "Agent: NotiOps | Model: {model}",
    },
    # 拿不到模型 id（配置读失败等）→ 只报 agent，**不许**退成上面那句"无模型消耗"：
    # 那是把"不知道"说成"没花钱"。宁可少说一半，也不能说反。
    "router.agent_model_unknown": {
        "zh": "Agent: NotiOps",
        "en": "Agent: NotiOps",
    },
    # 落款的**账号**那一段（2026-09-07,多账号)。渲染口径见
    # `platforms/common/im_footer.py::account_line` —— 一句话:号码一定是具体的
    # 12 位数字,拿不到就整段不显示。
    #
    # 🔴 为什么值得占卡片上一行:IM 侧 `/account` 切账号是**按会话**生效的,群里任何
    #    人都能把整个群切到另一个已启用的账号。切完之后每一条回答都基于那个账号,而
    #    在这一行出现之前卡片上一个字都看不出来 —— 客户拿着一张「EC2 都很健康」的卡
    #    以为说的是生产账号,其实问的是另一个。
    #
    # ⚠️ 这里刻意**只报账号号,不报账号名**。名字要再读一次注册表(GSI1 Query),而落款
    #    每张卡都要渲染、进度卡还每几秒 PATCH 一次 —— 为了一个可有可无的别名给每一次
    #    回答加一次 DDB 往返不值得。要名字的地方有 `/account`(`account.list_title`
    #    那份清单带别名)。
    #
    # ⚠️ 号码**不加反引号**(2026-09-07 产品决策)。落款是卡片最下面那一行灰色小字,
    #    行内代码在飞书/Slack 里都会被渲染成一个带底色的小方块 —— 一行字里塞三段,
    #    再给中间那段加个灰底盒子就是纯噪音。12 位数字本身已经足够显眼,不需要框。
    "router.account": {
        "zh": "账号: {account}",
        "en": "Account: {account}",
    },
    "router.account_deploy": {
        # 部署账号要盖章:只给号码的话客户还得自己回忆"这个号是不是我的部署账号"。
        # 与 `account.list_tag_deploy`(「部署账号(默认)」)同一件事的短版 —— 落款是
        # 一行字,带上"(默认)"就太长了。
        "zh": "账号: {account}(部署账号)",
        "en": "Account: {account} (deployment account)",
    },
    # ── 第三条路(阿里云 STAROps,2026-09-14)的落款两段 ────────────────────────
    # 为什么不复用 `router.direct_no_token`:那句的**字面**是「直连 DevOps Agent」。
    # 判据只写 `agent != "notiops"` 的话,STAROps 这条路会顶着 DevOps Agent 的名字 ——
    # "不会宣称花钱"和"名字是对的"是两件事(见 im_footer.route_line 的 ⚠️)。
    # "NotiOps 侧"这三个字必须留:这条路对我们免费,但**会烧客户自己的阿里云 AI 额度**,
    # 一句光秃秃的"无模型消耗"是在暗示"完全不花钱"。
    "router.direct_starops": {
        "zh": "⚡ 直连阿里云 STAROps · NotiOps 侧无模型消耗",
        "en": "⚡ Direct to Alibaba Cloud STAROps · no NotiOps model usage",
    },
    # 🔴 这一段**顶替**上面 `router.account*`(而不是并列):STAROps 答的是阿里云资源,
    #    在同一行里再盖一个 12 位 AWS 账号号是跨云假信息 —— 客户会以为这份阿里云结论
    #    "是关于那个 AWS 账号的"。互斥逻辑在 `im_footer.usage_footer` 一处。
    # ⚠️ 值是数字员工 **ID**(不是显示名称):一个阿里云账号可以有多个数字员工,纳管范围
    #    与答案质量完全不同,而客户要拿这个值回控制台/工单里对 —— 能唯一定位的是 ID。
    # 与 `router.account` 同口径:不加反引号(落款是一行灰色小字,加底色方块是噪音)。
    "router.employee": {
        "zh": "数字员工: {employee}",
        "en": "Digital employee: {employee}",
    },

    # =====================================================================
    # AWS Support case management — Feishu / Slack UI
    # Used by platforms/feishu/app/case_flow.py and slack/app/case_flow.py.
    # Grouped at end of dict per Agent-friendly insertion contract.
    # =====================================================================

    # ---- Subject summarizer：2026-09-06 随飞书那条死掉的 LLM 分支一起删 -------
    # 原 `case.create.summarizer_system_prompt` 是给
    # `platforms/feishu/app/case_flow.py::_summarize_subject` 第四步用的 system
    # prompt。那一步删了（成因见该函数 docstring），键也就没有调用方了。
    # 别再把它加回来：标题预填现在两端都是确定性的。

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
    # 服务名称 / 案例类型（飞书卡片，2026-09-03 补齐；与 web 端案例面板对齐）。
    # 服务名是**自由文本**（AWS Support 目录 400+ 条），服务端反查真实目录。
    # 飞书卡片版的「服务名称」两栏（Slack modal 用上面 `*_short` / `*_select_*` 那组，
    # 文案更短是因为 modal 的 label 空间小）。下拉优先于自由文本 —— 见
    # `case.create.service_select_label` 那组的注释。
    "case.create.service_select_label": {
        "zh": "**服务名称**(常用)",
        "en": "**Service** (common)",
    },
    "case.create.service_label": {
        "zh": "**其他服务**(可选,上面列表里没有就填这里)",
        "en": "**Other service** (optional, if not in the list above)",
    },
    "case.create.service_placeholder": {
        "zh": "例:Bedrock / Redshift / Cost Explorer",
        "en": "e.g. Bedrock / Redshift / Cost Explorer",
    },
    # 类别（飞书卡片，2026-09-04 补齐；与 web 端的「类别」对齐）。
    # 为什么是手打而不是像 web 那样的下拉：类别选项取决于先选了哪个服务，联动要在面板
    # 中途回一趟服务端重绘卡片，而飞书表单容器里的数据**只在点提交时**才回调 ——
    # 中途重绘就会把用户已经打好的主题/描述清空。理由与实测数据见
    # `core/case_classifier.resolve_category_detail` 的 docstring。
    # 目录是英文的（Support API 只支持 en / ja），所以 placeholder 必须给英文关键词示例。
    "case.create.category_label": {
        "zh": "**类别**(可选,留空按服务自动挑)",
        "en": "**Category** (optional, auto-picked from the service if blank)",
    },
    "case.create.category_placeholder": {
        "zh": "英文关键词,例:performance / network / limit",
        "en": "English keyword, e.g. performance / network / limit",
    },
    "case.create.issue_type_label": {
        "zh": "**案例类型**",
        "en": "**Case type**",
    },
    "case.create.issue_type_placeholder": {
        "zh": "选择案例类型",
        "en": "Select case type",
    },
    "case.create.service_unmatched_block": {
        "zh": ("\n_⚠️ 未在 AWS Support 服务目录中匹配到「{text}」,"
               "已改用自动判断的服务。_"),
        "en": ("\n_⚠️ \"{text}\" did not match any service in the AWS Support "
               "catalog; the auto-detected service was used instead._"),
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
    # 2026-09-07 多账号：这句原来写死「开在运行本 bot 的账号」,现在案例跟着
    # `/account` 走了,所以拆成两句 —— 没选成员账号时仍是部署账号(措辞改精确),
    # 选了成员账号时**必须把账号号念出来**(控制台链接不带账号参数,用户点进去看到的
    # 是自己当前登录的那个账号,不写清就会误判工单没开出来)。
    "case.create.account_note": {
        "zh": "_Case 将开在本 bot 的部署账号下,需该账号有 Business / Enterprise Support 计划。_",
        "en": "_The case will be opened in this bot's deployment account. That account needs a Business / Enterprise Support plan._",
    },
    "case.create.account_note_target": {
        "zh": "_Case 将开在账号 `{account}` 下(当前会话选定的账号),需该账号有 "
              "Business / Enterprise Support 计划,且 onboarding 时允许了 NotiOps 代开工单。_",
        "en": "_The case will be opened under account `{account}` (the account selected "
              "for this conversation). That account needs a Business / Enterprise Support "
              "plan and must have allowed NotiOps to open cases on its behalf._",
    },
    # 2026-09-07 追加：卡片/modal 上真有一个**账号下拉**时用这一句，而不是上面那两句。
    # 上面两句是"承诺"（案例会开在 X 下），有下拉时那个承诺的主语是客户自己刚点的那一项，
    # 所以措辞必须换成"以下拉里选的为准"—— 沿用 `..._target` 会出现"卡上写着 A、
    # 下拉里选了 B"这种自相矛盾的卡片。
    "case.create.account_note_picker": {
        "zh": "_Case 会开在表单里「开到哪个账号」选中的账号下(默认是本会话当前的账号)。"
              "该账号需有 Business / Enterprise Support 计划,且 onboarding 时允许了 "
              "NotiOps 代开工单。_",
        "en": "_The case will be opened under the account selected in the \"Open in which "
              "account\" field (defaults to this conversation's current account). That "
              "account needs a Business / Enterprise Support plan and must have allowed "
              "NotiOps to open cases on its behalf._",
    },
    "case.create.account_label": {
        "zh": "开到哪个账号",
        "en": "Open in which account",
    },
    "case.create.account_placeholder": {
        "zh": "选择目标 AWS 账号",
        "en": "Pick the target AWS account",
    },
    # 下拉回传了一个不在允许集里的账号号 → **拒绝提交**（`account_picker.resolve_choice`
    # 返回 None）。这句必须说清"没开"，不能含糊：唯一比"开错账号"更糟的是让客户以为
    # 开成功了。
    "case.create.account_refused": {
        "zh": "⚠️ 没创建:账号 `{account}` 不在可开案例的清单里。请先在 Web 端的「账号」"
              "页面把它上车并启用,或改选别的账号重新提交。",
        "en": "⚠️ Not created: account `{account}` is not in the list of accounts cases "
              "can be opened in. Onboard and enable it on the Accounts page in the web "
              "app, or pick a different account and submit again.",
    },
    # 跨账号卡片的账号横幅：list / view / reply / resolve / analyze / 结果卡通用。
    #
    # 2026-09-07 反转：原来只在选了成员账号时出现（"部署账号 = 历史行为,不给卡片
    # 加噪音"）。现网实测到的症状是「✅ 已创建 AWS Support Case」这张卡上一个账号
    # 字都没有 —— 而开案例是本产品**唯一的写操作**，这张卡就是那次写的收据。
    # "没有横幅"同时对应两种完全不同的事实：① 开在部署账号（正常）② 目标账号丢了
    # 所以回落成了部署账号（正是 2026-09-07 的那个 P0）。二者长得一模一样，客户
    # 只能靠去控制台数工单才能分辨。所以现在**总是**报账号，口径与落款
    # （`router.account*`）一致：部署账号盖「(部署账号)」的章。
    "case.account_banner": {
        "zh": "🏷️ 账号: `{account}`",
        "en": "🏷️ Account: `{account}`",
    },
    "case.account_banner_deploy": {
        "zh": "🏷️ 账号: `{account}`(部署账号)",
        "en": "🏷️ Account: `{account}` (deployment account)",
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
    # 跨账号建案的两种失败（2026-09-07）。都必须给出**出路**：只说"失败了"等于让
    # 客户去猜是自己没上车、还是没给权限、还是我们坏了。
    "case.create.fail_cross_account": {
        "zh": "拿不到目标账号的访问凭证,没有开单。可能是:该账号没在 Web 端上车 / 已被停用,"
              "或跨账号角色还没在该账号里部署。请在 Web 端「账号」页确认后重试;"
              "也可以先 `account default` 回到部署账号下开单。",
        "en": "Could not obtain credentials for the target account, so nothing was created. "
              "Either the account was never onboarded (or has been disabled) in the web app, "
              "or its cross-account role is not deployed yet. Check the Accounts page in the "
              "web app and retry; or run `account default` to open the case under the "
              "deployment account instead.",
    },
    "case.create.fail_support_read_denied": {
        "zh": "该账号的 NotiOps 角色连 Support 的只读权限都没有(探测 "
              "support:DescribeSeverityLevels 被拒)。通常是该账号的接入角色没挂 "
              "ReadOnlyAccess,或被 SCP / 权限边界拦住了。请检查该账号的接入栈。",
        "en": "The NotiOps role in this account lacks even read access to AWS Support "
              "(the support:DescribeSeverityLevels probe was denied). Usually its "
              "onboarding role is missing ReadOnlyAccess, or an SCP / permissions "
              "boundary is blocking it. Check that account's onboarding stack.",
    },
    "case.create.fail_write_not_granted": {
        # 这不是 bug 也不是"权限不够"这种含糊说法 —— 是客户在成员账号 onboarding 时
        # 主动关掉的一项授权。所以要点名那个参数,客户才知道去哪打开。
        "zh": "该账号没有授权 NotiOps 代开工单,没有开单。成员账号接入时的 "
              "`EnableSupportCaseWrite` 是关的(它控制 support:CreateCase / "
              "AddCommunicationToCase / ResolveCase 三条权限)。要用这个能力,"
              "请把该账号的接入模板改成 `true` 后重跑;不改也可以在 AWS 控制台自己开单。",
        "en": "This account has not authorized NotiOps to open cases on its behalf, so "
              "nothing was created. `EnableSupportCaseWrite` is off in its member-account "
              "onboarding template (it controls support:CreateCase / "
              "AddCommunicationToCase / ResolveCase). To use this feature, re-run that "
              "template with `true`; otherwise open the case yourself in the AWS console.",
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
    # 服务名称 / 案例类型（2026-09-03 补齐，与 web 端案例面板对齐）。
    # 服务名是**自由文本**（AWS Support 目录 400+ 条，装不进 Slack 的 100 选项上限），
    # 服务端对着真实目录反查；所以 placeholder 要明确"可以留空"。
    # 「服务名称」在 IM 面板上是**两个控件**：常用服务下拉（这一组）+ 长尾自由文本
    # （下面 `service_label_short` 那组）。下拉里只有二十条常用的 —— 真实目录 323 条
    # 装不进 Slack `static_select`（上限 100）和飞书卡片选择器，所以冷门服务照样得能
    # 手打。两个都不给就交给分类器自动判断。见 core/case_classifier.popular_services。
    # ⚠️ 这条是 Slack modal 用的**纯文本**版：Slack 的 `label` 是 `plain_text`，
    # 带 `**` 会原样显示成星号。飞书卡片那版（markdown，带粗体）叫
    # `case.create.service_select_label`，别把两者合成一个 key。
    "case.create.service_select_label_short": {
        "zh": "服务名称(常用)",
        "en": "Service (common)",
    },
    "case.create.service_select_auto": {
        "zh": "自动判断(推荐)",
        "en": "Auto-detect (recommended)",
    },
    "case.create.service_select_placeholder": {
        "zh": "不选则自动判断",
        "en": "Leave as auto-detect",
    },
    # 自由文本那一栏的标签要说清它跟下拉的关系，否则两个都填时用户不知道谁生效
    # （答案：下拉优先，这条也写在 label 里）。
    "case.create.service_label_short": {
        "zh": "其他服务(可选,上面没有就填这里)",
        "en": "Other service (optional, if not in the list above)",
    },
    "case.create.service_placeholder_short": {
        "zh": "例如 Bedrock / Redshift / Cost Explorer",
        "en": "e.g. Bedrock / Redshift / Cost Explorer",
    },
    # 目录读不到时（`describe_services` 需要 Business/Enterprise 支持计划）下拉整块
    # 去掉，只留自由文本 —— 但**必须说出来**，不许留一个空下拉或者静默少一个控件。
    "case.create.service_catalog_unavailable": {
        "zh": "ℹ️ 暂时读不到 AWS Support 服务目录,「服务名称」这次请手填(或留空由我们判断)。",
        "en": "ℹ️ The AWS Support service catalog is unavailable right now — "
              "type the service name below, or leave it blank and we'll detect it.",
    },
    # 类别（Slack modal 的**纯文本** label 版；飞书 markdown 版见
    # `case.create.category_label`，理由同上面服务那组，别合成一个 key）。
    "case.create.category_label_short": {
        "zh": "类别(可选,留空按服务自动挑)",
        "en": "Category (optional, auto-picked from the service if blank)",
    },
    "case.create.category_placeholder_short": {
        "zh": "英文关键词,例:performance / network / limit",
        "en": "English keyword, e.g. performance / network / limit",
    },
    "case.create.issue_type_label_short": {
        "zh": "案例类型",
        "en": "Case type",
    },
    "case.create.service_unmatched_line": {
        "zh": ("\n_⚠️ 未在 AWS Support 服务目录中匹配到「{text}」,"
               "已改用自动判断的服务。_"),
        "en": ("\n_⚠️ \"{text}\" did not match any service in the AWS Support "
               "catalog; the auto-detected service was used instead._"),
    },
    # 类别没匹配上也**必须说出来**（与服务那条同一口径）：类别决定案例进哪个工程师
    # 队列，用户以为自己指定了、实际落到通用类别，是最容易白等的那种坑。
    # `_line` = Slack、`_block` = 飞书，两边文案一致（沿用服务那两条的分法）。
    "case.create.category_unmatched_line": {
        "zh": ("\n_⚠️ 「{service}」名下没有匹配「{text}」的类别,"
               "已改用 `{category}`。_"),
        "en": ("\n_⚠️ No category under \"{service}\" matched \"{text}\"; "
               "`{category}` was used instead._"),
    },
    "case.create.category_unmatched_block": {
        "zh": ("\n_⚠️ 「{service}」名下没有匹配「{text}」的类别,"
               "已改用 `{category}`。_"),
        "en": ("\n_⚠️ No category under \"{service}\" matched \"{text}\"; "
               "`{category}` was used instead._"),
    },
    # 结果卡上「Category」那一格的来源标注。只印一个 code 是静默的 —— 用户分不清
    # 这个类别是自己指定的还是我们按服务推的，而这直接决定案例的路由质量。
    "case.create.category_source_chosen": {
        "zh": "(你指定)",
        "en": "(as specified)",
    },
    "case.create.category_source_auto": {
        "zh": "(自动挑选)",
        "en": "(auto-picked)",
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
    # ⚠️ 这条只讲"两种模式有什么区别"，**不许**再写案例落在哪个账号（2026-09-07
    #    去掉了原来那句"开在当前 AWS 账号"）：多账号之后归属由 `/account` 决定，
    #    写死在这里就是撒谎。账号归属另有一条随会话变的 context 块
    #    （`case.create.account_note` / `..._target`），Slack 的
    #    `_build_create_view` 紧跟在这条后面追加。
    "case.create.modal.context_hint": {
        "zh": ("_• 仅创建 Case: 把问题提给 AWS Support 工程师人工处理。_\n"
               "_• 创建 + 启动 Agent 调查: 同时让 DevOps Agent 立即开始调查,"
               "几分钟内出诊断报告;两条线并行进行。_"),
        "en": ("_• Create case only — file the issue with AWS Support engineers._\n"
               "_• Create + start Agent investigation — also kick off "
               "DevOps Agent in parallel; you get a diagnostic report in "
               "minutes alongside the support engineer's reply._"),
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
    # 2026-09-07 多账号：这句原来写死「当前 AWS 账号(运行本 bot 的账号)」,现在从
    # 报告卡升级出来的工单跟着**这次调查查的那个账号**走(不是"点按钮那一刻会话里选
    # 的账号"——🆘 可以几小时后才被点)。所以拆成两句,选了成员账号时**必须把账号号
    # 念出来**(控制台链接不带账号参数,用户点进去看到的是自己当前登录的那个账号)。
    "support.form.account_note": {
        "zh": "_提示:案例将开在本 bot 的部署账号下,需该账号有 Business / Enterprise Support 计划。_",
        "en": "_Note: the case will be opened in this bot's deployment account. That account needs a Business / Enterprise Support plan._",
    },
    "support.form.account_note_target": {
        "zh": "_提示:案例将开在账号 `{account}` 下(本次调查的账号),需该账号有 "
              "Business / Enterprise Support 计划,且 onboarding 时允许了 NotiOps 代开工单。_",
        "en": "_Note: the case will be opened under account `{account}` (the account this "
              "investigation ran against). That account needs a Business / Enterprise "
              "Support plan and must have allowed NotiOps to open cases on its behalf._",
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
    # 只被 `platforms/dingtalk/app/main.py`(已退役的 Stream 模式长连接形态)调用。
    # 现网钉钉走 HTTP 回调 Lambda 通道,那条路径上 case / push / 调查全都可用 ——
    # 所以这条文案**不能**说「钉钉还没做」,也不能把客户劝去飞书 / Slack。
    "dingtalk.legacy_stream_path_unsupported": {
        "zh": ("👷 这个意图在当前这条**长连接(Stream 模式)**通道上没有实现 —— "
               "它是已退役的回滚形态。现网的钉钉接入走 HTTP 回调模式,在那条通道上 "
               "调查派发 / 概念问答 / Support case 管理 / 主动推送 / 模型与语言切换 "
               "都可用。请联系管理员确认钉钉后台的「消息接收模式」是否为 HTTP 模式。"),
        "en": ("👷 This intent is not implemented on this long-connection "
               "(Stream mode) channel — a retired fallback shape. The shipped "
               "DingTalk integration uses HTTP callback mode, where "
               "investigation dispatch, concept Q&A, Support case management, "
               "proactive push, and model / language switching all work. Ask "
               "your administrator to confirm DingTalk's message-receive mode "
               "is set to HTTP mode."),
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
    "out_of_scope.change_request": {
        "zh": "⚠️ NotiOps 是只读界面，不能代替你做变更类操作。请到 AWS Console，"
              "或让 DevOps Agent 走人工确认流程完成这项变更。",
        "en": "⚠️ NotiOps is read-only and won't perform change actions. "
              "Use the AWS Console, or run this via DevOps Agent's "
              "human-approval flow.",
    },

    # ── IM webhook (Lambda) 卡片文案 ────────────────────────────────────────
    # 这批 key 只被 platforms/*/caps.py 用。**这些文案本身**全是确定性渲染（0 token）：
    # 没有任何一条会去过模型，所以文案必须自己是双语的，不能靠运行时翻译。
    #
    # ⚠️ "文案 0 token" ≠ "这条路径 0 token"（2026-09-06 校正）：同一批卡片也用在
    # `/agent notiops` 之后那条走 NotiOps Agent 的路上，那条路是**烧 token 的**。
    # 落款分两套（`router.direct_no_token` / `router.agent_model`），标题也分两套。
    "im.chat.card_title": {
        "zh": "DevOps Agent 回答",
        "en": "DevOps Agent answer",
    },
    "im.chat.card_title.notiops": {
        "zh": "NotiOps Agent 回答",
        "en": "NotiOps Agent answer",
    },
    # 第三条路(2026-09-14)。标题里必须带**阿里云**:这张卡的正文说的是阿里云资源,
    # 而它长得和上面两张一模一样 —— 客户在同一个群里三条路来回切,标题是唯一的分辨点。
    # 只写 "STAROps 回答" 不够:STAROps 这个产品名客户未必认,「阿里云」三个字才是他脑子里
    # 的那条路(同一条理由让 `_AGENT_ALIASES` 收了「阿里云」这个别名)。
    "im.chat.card_title.starops": {
        "zh": "阿里云 STAROps 回答",
        "en": "Alibaba Cloud STAROps answer",
    },
    # 「边想边看」三条 —— 见 platforms/common/live_card.py。
    # 立刻回一张这个标题的卡（不等答案），用户才知道"收到了、要等一会儿"：实测一个
    # 「列出所有 S3 桶及其大小」的问题跑了 347 秒，M1 那版全程静默，看着像后台挂了。
    "im.chat.thinking_title": {
        "zh": "🤔 思考中 · 已用时 {seconds} 秒",
        "en": "🤔 Thinking · {seconds}s elapsed",
    },
    # ⚠️ 不带秒表的那一份 —— 给**不会原地刷新**的平台用（钉钉，见
    # `platforms/dingtalk/dt_messages._ANSWER_TITLES_NOCLOCK`）。一条永远不会重绘的消息上写
    # 「已用时 0 秒」，用户看到的就是一个卡死在 0 的计时器：它不是"信息少一点"，
    # 是**假信息**（2026-09-08 现网反馈原话：「如果不会自动刷新，也没有意义」）。
    # 追加式进度的第二、三条消息有真实秒数，那几条照样用上面带秒表的那一份。
    "im.chat.thinking_title.noclock": {
        "zh": "🤔 思考中",
        "en": "🤔 Thinking",
    },
    # 开场话有 5 种说法，按消息 id 确定性选一条 —— 见 platforms/common/ack_variants.py
    # （那里也解释了为什么是"确定性"而不是 random，以及为什么「NotiOps」那三个字不在
    # 我们手里）。客户反馈原话：「机制很好，但文案生硬」—— 每问一次就一字不差地重复
    # 同一句，问到第十次就像在跟一台自动应答机说话。
    #
    # ── 一条开场话 = 开场句（5 种说法 × 2 个 agent）+ 去处句（按平台 2 种）─────────
    # 2026-09-08 现网反馈：钉钉上"过程和结论会更新在这张卡片上"是**假的** —— 钉钉拿不到
    # 消息 id，没法原地刷新，答案是**另发一条新消息**（见 platforms/dingtalk/caps.py
    # 文件头）。原来那句承诺写在 10 条文案里各写一遍，于是"哪个平台说哪句话"这件事
    # 无处可改。现在拆开：开场句只管语气（这才是"新鲜感"的来源），去处句
    # `im.chat.ack_tail.*` 只管"答案会出现在哪"，由
    # `platforms/common/ack_variants.ack_body(platform=...)` 拼起来。
    #
    # ⚠️ 拼出来的整句**必须**留着那句「不用重复发问 / no need to ask again」——
    # 它不是客套：它是唯一拦住用户重复发问的东西，而重复发问会撞上 §3.22 的会话排队
    # （把自己排到自己后面，越急越慢）。那句话现在只在**去处句**里，所以
    # `tests/test_im_ack_variants.py` 断言的是**拼接结果**，不是单条 key。
    #
    # ⚠️ 也别在这里引入 `{占位符}`：`t()` 的 `format()` 包在 `except KeyError` 里，
    # 少传一个 kwarg 不会报错，会把 `{opener}` 原样发给客户。
    "im.chat.ack_body.1": {
        "zh": "已收到，正在让 DevOps Agent 分析。复杂问题可能要跑几分钟。",
        "en": "Got it — the DevOps Agent is working on this. Complex questions "
              "can take a few minutes.",
    },
    "im.chat.ack_body.2": {
        "zh": "收到，DevOps Agent 已经开始查了。复杂一点的问题要跑几分钟。",
        "en": "On it — the DevOps Agent has started digging. Anything "
              "non-trivial takes a few minutes.",
    },
    "im.chat.ack_body.3": {
        "zh": "这个问题交给 DevOps Agent 了，正在翻数据。可能要等几分钟。",
        "en": "Handed this to the DevOps Agent — it is pulling the data now. "
              "This can take a few minutes.",
    },
    "im.chat.ack_body.4": {
        "zh": "好，DevOps Agent 接手了。查得细的时候会慢一点，可能要几分钟。",
        "en": "Sure — the DevOps Agent has picked this up. A thorough look "
              "takes a bit longer, maybe a few minutes.",
    },
    "im.chat.ack_body.5": {
        "zh": "收到了，正在查。DevOps Agent 挖得深一些需要几分钟。",
        "en": "Got it, looking into this now. A deeper dig by the DevOps Agent "
              "needs a few minutes.",
    },
    # 同样 5 条，给 `/agent notiops` 那条路 —— 只换了 agent 的名字。
    #
    # 为什么不共用一套中性文案：默认那条路是"直连你自己的 DevOps Agent"，这条是"我们
    # 的 NotiOps Agent 在花你的 token"。把名字含糊掉，用户就分不清这一轮到底谁在答、
    # 花没花钱 —— 而这正是 `/agent` 这个开关存在的意义。
    "im.chat.ack_body.notiops.1": {
        "zh": "已收到，正在让 NotiOps Agent 分析。复杂问题可能要跑几分钟。",
        "en": "Got it — the NotiOps Agent is working on this. Complex questions "
              "can take a few minutes.",
    },
    "im.chat.ack_body.notiops.2": {
        "zh": "收到，NotiOps Agent 已经开始查了。复杂一点的问题要跑几分钟。",
        "en": "On it — the NotiOps Agent has started digging. Anything "
              "non-trivial takes a few minutes.",
    },
    "im.chat.ack_body.notiops.3": {
        "zh": "这个问题交给 NotiOps Agent 了，正在翻数据。可能要等几分钟。",
        "en": "Handed this to the NotiOps Agent — it is pulling the data now. "
              "This can take a few minutes.",
    },
    "im.chat.ack_body.notiops.4": {
        "zh": "好，NotiOps Agent 接手了。查得细的时候会慢一点，可能要几分钟。",
        "en": "Sure — the NotiOps Agent has picked this up. A thorough look "
              "takes a bit longer, maybe a few minutes.",
    },
    "im.chat.ack_body.notiops.5": {
        "zh": "收到了，正在查。NotiOps Agent 挖得深一些需要几分钟。",
        "en": "Got it, looking into this now. A deeper dig by the NotiOps Agent "
              "needs a few minutes.",
    },
    # 同样 5 条，给 `/agent starops` 那条路（2026-09-14）—— 换的不只是名字，还有**云**。
    #
    # 为什么必须单独一套而不是复用上面十条里的任意一套：这条路问的是**阿里云**资源。
    # 一句「正在让 DevOps Agent 分析」出现在一个阿里云问题上，客户等几分钟拿到一份
    # 阿里云答案时会先怀疑自己切错了；更糟的是他拿 AWS 的问题过来问，ack 说得像 AWS
    # 那条路、结果答"查不到"，然后归因成产品坏了。所以这五条里「阿里云」三个字是**必须**
    # 出现的（英文同理 Alibaba Cloud）—— 它是这一轮唯一的早期纠错信号。
    #
    # ⚠️ 这五条**不提 token / 额度**：切换那一刻已经用 `agent.starops_notice` 说过
    # 「NotiOps 侧不消耗 token，但会消耗你阿里云账号的 AI 额度」。每一轮再说一遍就变成
    # 噪音，而客户真正会漏读的是"这条路问的是哪家云"（上面那条）。
    "im.chat.ack_body.starops.1": {
        "zh": "已收到，正在让阿里云 STAROps 数字员工分析。复杂问题可能要跑几分钟。",
        "en": "Got it — the Alibaba Cloud STAROps digital employee is working on "
              "this. Complex questions can take a few minutes.",
    },
    "im.chat.ack_body.starops.2": {
        "zh": "收到，阿里云 STAROps 数字员工已经开始查了。复杂一点的问题要跑几分钟。",
        "en": "On it — the Alibaba Cloud STAROps digital employee has started "
              "digging. Anything non-trivial takes a few minutes.",
    },
    "im.chat.ack_body.starops.3": {
        "zh": "这个问题交给阿里云 STAROps 数字员工了，正在翻数据。可能要等几分钟。",
        "en": "Handed this to the Alibaba Cloud STAROps digital employee — it is "
              "pulling the data now. This can take a few minutes.",
    },
    "im.chat.ack_body.starops.4": {
        "zh": "好，阿里云 STAROps 数字员工接手了。查得细的时候会慢一点，可能要几分钟。",
        "en": "Sure — the Alibaba Cloud STAROps digital employee has picked this "
              "up. A thorough look takes a bit longer, maybe a few minutes.",
    },
    "im.chat.ack_body.starops.5": {
        "zh": "收到了，正在查阿里云。STAROps 数字员工挖得深一些需要几分钟。",
        "en": "Got it, looking into Alibaba Cloud now. A deeper dig by the "
              "STAROps digital employee needs a few minutes.",
    },
    # 去处句 —— 飞书 / Slack：同一张卡原地刷新。
    "im.chat.ack_tail.card": {
        "zh": "过程和结论都会**更新到这张卡片**上，不用重复发问。",
        "en": "Progress and the answer both **update in this card**, so no need "
              "to ask again.",
    },
    # 去处句 —— 钉钉：追加式（拿不到消息 id，改不了已发出的消息）。文案里不点平台
    # 名字：判断"要不要用这一份"的是调用方，不是文案。
    "im.chat.ack_tail.append": {
        "zh": "过程和结论会**另发新消息**贴出来，不用重复发问。",
        "en": "Progress and the answer arrive as **new messages** here, so no "
              "need to ask again.",
    },
    "im.chat.steps_title": {
        "zh": "**过程**",
        "en": "**Progress**",
    },
    # 引用来源 —— 只有 NotiOps Agent 那条路会有（`aws_docs_*` / `web_search` 的结果）。
    # DevOps Agent 直连那条路我们拿不到它的引用，所以这一段在那条路上根本不渲染。
    "im.chat.sources_title": {
        "zh": "**参考来源**",
        "en": "**Sources**",
    },
    # 「正文放不下」三条 —— 见 platforms/common/long_answer.py。
    # 飞书卡片正文上限 3500 / Slack section 2900，原来是裸切片，客户看到的是一个
    # 在第 3500 字符处**无声**断掉的答案。截断本身不可避免，但必须说出来 + 给下文。
    "im.chat.truncated_report": {
        "zh": "⚠️ 回答太长（{total} 字），这里只显示了开头。**完整内容**在这份网页报告里"
              "（{hours} 小时内有效）：\n{url}",
        "en": "⚠️ The answer is too long ({total} chars) to fit here, so only the "
              "beginning is shown. **Full version** (valid for {hours}h):\n{url}",
    },
    "im.chat.truncated_nolink": {
        "zh": "⚠️ 回答太长（{total} 字），这里只显示了开头；完整报告没能生成"
              "（{reason}），请把问题拆小一点再问一次。",
        "en": "⚠️ The answer is too long ({total} chars) to fit here, so only the "
              "beginning is shown. The full report could not be generated "
              "({reason}) — try narrowing the question.",
    },
    # 过程行 / 进度卡正文这类"天天在变"的位置用它：不落报告，但也不许看不出被切了。
    "im.chat.clipped_marker": {
        "zh": "…（内容过长，此处已截断）",
        "en": "… (truncated — too long to display here)",
    },
    # 「排队」三条 —— 见 platforms/common/chat_lease.py。同一个会话同时只跑一个问题
    # （多轮上下文是一个 chat 一个 execution_id），第二个问题排队而不是并发抢 agent。
    # 标题与「思考中」分开：还没轮到就写"思考中"是在骗用户（正是本次要修的那类 bug）。
    "im.chat.queued_title": {
        "zh": "⏳ 排队中 · 已等 {seconds} 秒",
        "en": "⏳ Queued · waiting {seconds}s",
    },
    #: 不带秒表的那一份，理由同 `im.chat.thinking_title.noclock`。
    "im.chat.queued_title.noclock": {
        "zh": "⏳ 排队中",
        "en": "⏳ Queued",
    },
    "im.chat.queued_body": {
        "zh": "已收到。这个会话里前一个问题**还在跑**（同一个会话一次只跑一个，"
              "并发会互相拖慢），你排在它后面。轮到你时这张卡片会自己变成"
              "「思考中」，不用重复发问。",
        "en": "Got it. The previous question in this conversation is **still "
              "running** — one at a time per conversation, since running them "
              "concurrently makes both slower. This card will switch to "
              "'Thinking' when your turn starts, so no need to ask again.",
    },
    # 同一句话的「追加式」版本 —— 给不会原地刷新的平台（钉钉）。选哪一份由
    # `platforms/common/ack_variants.queued_body(platform=...)` 决定，三端共用那个入口。
    # 上面那一份承诺"这张卡片会自己变成「思考中」"，在钉钉上是**不会发生的事**。
    "im.chat.queued_body.append": {
        "zh": "已收到。这个会话里前一个问题**还在跑**（同一个会话一次只跑一个，"
              "并发会互相拖慢），你排在它后面。轮到你时我会**另发一条消息**说"
              "「思考中」，不用重复发问。",
        "en": "Got it. The previous question in this conversation is **still "
              "running** — one at a time per conversation, since running them "
              "concurrently makes both slower. When your turn starts I will send "
              "**a new message** saying 'Thinking', so no need to ask again.",
    },
    "im.chat.queue_timeout": {
        "zh": "⚠️ 这个会话里前一个问题跑得比预期久，你这个问题**没能开始**。"
              "请稍后再发一次；如果很急，可以私聊我（私聊是另一个会话，不用排队）。",
        "en": "⚠️ The previous question in this conversation is taking longer "
              "than expected, so yours **never started**. Please send it again "
              "in a bit — or DM me, which is a separate conversation with its "
              "own queue.",
    },
    "im.investigate.need_text": {
        "zh": "请把要调查的内容写在命令后面，例如：`/调查 生产环境 RDS 连接数暴涨`。",
        "en": "Add what you want investigated after the command, e.g. "
              "`/investigate RDS connections spiking in prod`.",
    },
    "im.investigate.card_title": {
        "zh": "深度调查已发起",
        "en": "Deep investigation dispatched",
    },
    # 卡片发不出去 → 实时进度就没有落点可以 PATCH。**必须明说**（不许静默降级）：
    # 调查本身已经在跑，用户得知道去哪儿看。
    "im.investigate.card_failed": {
        "zh": "⚠️ 卡片发送失败，这里无法推送实时进度。调查已经在运行，请用上面的链接"
              "在 Operator App 里查看。",
        "en": "⚠️ Couldn't post the card, so live progress won't stream here. "
              "The investigation is running — use the link above to follow it "
              "in the Operator App.",
    },
    # ── 「问一条已有调查的进展」（0 token 回读，**不新建任何东西**）──────────────
    # 为什么要单独一组文案而不复用 `im.investigate.*`：现网 2026-09-03 的反馈是用户
    # 拿着 `[[investigation:…]]` 追问进展，结果每追问一次就**再开一条新调查**。修好
    # 路由之后这条路径必须有自己的说法 —— 回一句「深度调查已发起」正是那个误导的来源。
    "im.investigate.status.title": {
        "zh": "调查进展",
        "en": "Investigation progress",
    },
    "im.investigate.status.header": {
        "zh": "**{title}**\n状态：`{status}`",
        "en": "**{title}**\nStatus: `{status}`",
    },
    "im.investigate.status.no_lines": {
        "zh": "还没有可展示的过程记录 —— 调查刚开始，过一会儿再看。",
        "en": "No progress entries yet — the investigation just started; check "
              "back in a moment.",
    },
    # 非终态 + 这条调查还没有别的卡片在刷 → 把这张新卡挂到每分钟的进度轮询上。
    "im.investigate.status.attached": {
        "zh": "这张卡片会自动刷新后续进展，不用重复追问。",
        "en": "This card refreshes itself as the investigation progresses — no "
              "need to ask again.",
    },
    # 非终态，但已经有一张卡在刷同一条调查 → 只给快照。再挂一张会变成两张卡刷同一次
    # 调查（纯噪音，见 `core.ddb_state.link_im_investigation` 的说明）。
    "im.investigate.status.watching_elsewhere": {
        "zh": "这条调查已经有一张卡片在自动刷新了，这里只给一次快照。",
        "en": "Another card is already refreshing this investigation live — this "
              "is a one-off snapshot.",
    },
    # 用户**明确**写了引用但查不到 → 照实说，并且明说没有替他新建（这正是本次修的 bug）。
    "im.investigate.status.not_found": {
        "zh": "没有找到调查 `{ref}`。请确认引用是否完整（形如 "
              "`[[investigation:<id>]]`），或者它属于另一个 AWS 账号。"
              "**没有**为你新建调查 —— 需要新起一条请直接说「深入调查 …」。",
        "en": "Couldn't find investigation `{ref}`. Check that the reference is "
              "complete (like `[[investigation:<id>]]`) — it may also belong to a "
              "different AWS account. **No** new investigation was created; say "
              "\"deep dive on …\" if you want to start one.",
    },
    "im.action.unknown": {
        "zh": "这个按钮已失效（会话可能已过期）。请重新发起一次。",
        "en": "This button is no longer active (the conversation may have "
              "expired). Please start again.",
    },
    "im.action.no_context": {
        "zh": "按钮里没有带上原始问题，无法继续。请重新发一条消息。",
        "en": "The button didn't carry the original question, so it can't "
              "continue. Please send a new message.",
    },
    # Slack 专用：`views_open` 的 trigger_id 只有约 3 秒有效，worker 冷启动可能吃掉
    # 大半。与其调一个必然失败的 views_open（case_flow 会把异常自己吞掉，用户侧表现
    # 成"点了没反应"），不如原样重发这个按钮 —— 第二次 worker 是热的。
    "im.action.retry_hint": {
        "zh": "刚才这一下没赶上 Slack 的弹窗时限（约 3 秒）。请点下面的按钮再试一次，"
              "这次会立刻打开。",
        "en": "That click missed Slack's ~3s dialog window. Tap the button below "
              "to try again — it will open right away this time.",
    },
    "im.action.retry_btn": {
        "zh": "再试一次",
        "en": "Try again",
    },
    # 用户对着一条历史消息提问，但那条正文取不回来（bot 不在那个会话里 / 消息已撤回 /
    # 纯图片纯文件 / 权限还没发版本）。**必须说出来** —— 这条需求就是从"静默当没有、
    # 然后回一句『你的问题好像没发过来』"这个体验来的（B8 第 7 项）。
    "im.quoted.fetch_failed": {
        "zh": "⚠️ 没能读到你回复的那条历史消息（可能是我不在那个会话里、消息已撤回，"
              "或者那条只有图片/文件没有文字）。下面只按你这一句来回答 —— 如果需要"
              "结合那条消息，把关键内容直接贴过来最快。",
        "en": "⚠️ I couldn't read the message you replied to (I may not be in that "
              "conversation, it may have been recalled, or it may contain only "
              "images/files with no text). I'll answer based on your message alone "
              "— paste the key content here if it matters.",
    },

    # ── 钉钉专属（`im.dt.*`）────────────────────────────────────────────────
    # 只有这几条：钉钉的差异不在「文案」，而在「没有按钮回调」。飞书/Slack 靠卡片
    # 按钮完成的「确认 → 执行」，钉钉只能靠**用户回一句话**，所以需要一批
    # 别的平台完全没有的提示文案。凡是两家已经有的（`case.*` / `progress.*` /
    # `im.chat.*`）一律**复用原 key**，不在这里重写一份 —— 三边文案漂移是 IM 侧
    # 最容易复发的一类 bug。差异清单见 `platforms/dingtalk/caps.py` 的文件头。
    # ⚠️ 这条**不能带 `{seconds}`**：它是 `platforms/dingtalk/append_progress.py`
    # 的 `ack` —— 一个**发一次就定死**的字符串，追加式进度靠"改标题"而不是"改正文"
    # 来体现用时（标题走 `im.chat.thinking_title`，那条才有 `{seconds}`）。正文里写
    # 死一个秒数会在 120s / 360s 的两次追加里显示同一个过时数字，比不显示更糟。
    "im.dt.progress.still_running": {
        "zh": "⏳ 还在查。查完会在这个会话里直接给结果，不用重复发问。",
        "en": "⏳ Still working. The answer will land in this conversation — no "
              "need to ask again.",
    },
    # 深度调查的诚实声明。飞书/Slack 的调查卡会**原地刷新**成进度条；钉钉的消息发出
    # 去就改不了了（§4.4），所以必须说清"这里不会自己更新"，否则用户会盯着一条静态
    # 消息等半小时。报告投递是另一条路（`shared/report_delivery`），那条**能**回来。
    "im.dt.investigate.no_live_progress": {
        "zh": "\n\nℹ️ 钉钉的消息发出后无法原地刷新，所以**这条不会自动更新**。"
              "报告跑完会自动投回这个会话；想看中间进展就再问一次"
              "「调查进展」。",
        "en": "\n\nℹ️ DingTalk messages can't be edited after sending, so **this "
              "one won't update itself**. The finished report will be delivered "
              "back to this conversation; ask again for progress any time.",
    },
    "im.dt.investigate.snapshot_only": {
        "zh": "\n\nℹ️ 以上是此刻的快照，不会自动刷新 —— 再问一次就是最新的。",
        "en": "\n\nℹ️ That's a snapshot from just now and won't refresh — ask "
              "again for the latest.",
    },
    # 开案例的「草稿 → 确认」两段式。钉钉没有表单弹窗，所以草稿就是一条消息，
    # 确认就是用户回一句「确认」。
    "im.dt.case.draft_title": {
        "zh": "确认开 AWS Support 案例",
        "en": "Confirm: open an AWS Support case",
    },
    "im.dt.case.draft_body": {
        "zh": "**主题** · {subject}\n"
              "**严重等级** · {severity}\n"
              "**语言** · {language}\n\n"
              "**问题描述**\n{body}",
        "en": "**Subject** · {subject}\n"
              "**Severity** · {severity}\n"
              "**Language** · {language}\n\n"
              "**Problem**\n{body}",
    },
    # ⚠️ 例句里**必须**是 `开案例 <描述>` 而不是 `/案例 <描述>`：`案例` 是
    # `core.nl_router._CASE_CMD_PATTERNS` 里的 bare 形式，后面没有 ≥6 位案例号就落到
    # `case_list`（列最近的案例），**不会**开案例。三处 `im.dt.case.*` 例句同此口径。
    "im.dt.case.draft_hint": {
        "zh": "回复 **确认** 就按上面开案例，回复 **取消** 放弃。30 分钟内有效。\n"
              "想改参数就重发一次，例如："
              "`开案例 RDS 连接数暴涨 severity=high language=en`。",
        "en": "Reply **confirm** to open it as shown, or **cancel** to drop it. "
              "Valid for 30 minutes.\nTo change anything, just send it again, e.g. "
              "`open case RDS connections spiking severity=high language=en`.",
    },
    # 确认到了但草稿已经过期（30 分钟 TTL）。**必须说清是过期**，不能静默当没听见 ——
    # 用户会以为案例已经开了。
    "im.dt.case.draft_expired": {
        "zh": "⚠️ 没有待确认的操作（可能已超过 30 分钟）。请重新发起，例如 "
              "`开案例 <一句话描述>`。",
        "en": "⚠️ Nothing pending to confirm (it may have expired after 30 "
              "minutes). Start again, e.g. `open case <one-line description>`.",
    },
    "im.dt.case.cancelled": {
        "zh": "已取消，什么都没做。",
        "en": "Cancelled — nothing was done.",
    },
    # ⚠️ 这几行是**动词+名词一个词**的形式（`查看案例` / `关闭案例`…），不是
    # 「`/案例` + 子命令词」——后者根本不解析子命令：`/案例 关闭 1234567890` 落到
    # bare `案例` 上，带了案例号就当**查看**，`关闭` 那个词被丢掉；`/案例 回复 <号> <正文>`
    # 同样退化成查看，正文一起丢。真正的判据是 `core.nl_router._CASE_CMD_PATTERNS`。
    "im.dt.case.usage": {
        "zh": "用法：\n"
              "· `/案例` —— 列出最近的案例（`/案例 <案例号>` 看详情）\n"
              "· `开案例 <一句话描述>` —— 开一个新案例（会先给你确认）\n"
              "· `/查看案例 <案例号>` / `/分析案例 <案例号>`\n"
              "· `/回复案例 <案例号> <内容>` / `/关闭案例 <案例号>`\n\n"
              "开案例前可以用 `/account <12 位账号>` 切换目标账号。",
        "en": "Usage:\n"
              "· `/case` — list recent cases (`/case <case-id>` for details)\n"
              "· `open case <one-line description>` — open a new case (you'll confirm first)\n"
              "· `/view-case <case-id>` / `/analyze-case <case-id>`\n"
              "· `/reply-case <case-id> <text>` / `/close-case <case-id>`\n\n"
              "Use `/account <12-digit account>` first to pick the target account.",
    },
    # ⚠️ 这里曾经有一条 `im.dt.case.need_description`（"还差一句问题描述，照抄这个例句
    # 再发一次"）。2026-09-09 **删掉**了：只说「开案例」现在回的是下面那张**案例模版**
    # （`im.dt.case.form.*`），用户改完整段发回来即可，不再需要"照抄一句话重发"这条
    # 引导。**别把它加回来** —— 两条同时存在的话，同一个入口会随改动漂移成两种回法。
    # 用户只给了意图时**依然不许建草稿**（那会在 AWS Support 里留下一个标题和正文都写着
    # 「开案例」的对外可见案例）；那道闸门现在钉在 `tests/test_im_case_subject_guard.py`。
    # 用户写了 `severity=huge` 这种认不出的值。**说出来**：静默套用默认值会让
    # 「我明明选了 urgent」变成一个查不出来的 bug。
    # ⚠️ 占位符叫 `{field}` 而**不是** `{key}`：`i18n.t(key, locale, **kwargs)` 的第一个
    # 形参就叫 `key`，写成 `t(..., key=...)` 会 `TypeError: got multiple values for
    # argument 'key'` —— 这条曾经真的把钉钉的开案例整条打挂（2026-09-09 修）。
    "im.dt.case.override_ignored": {
        "zh": "\n\n⚠️ 认不出 `{field}={value}`，这一项用了默认值。",
        "en": "\n\n⚠️ Couldn't recognize `{field}={value}` — used the default for it.",
    },
    # --- 案例模版（复制 → 改 → 发回来）---------------------------------------
    # 钉钉没有表单弹窗，所以「表单」退化成一张**可复制的纯文本模版**：用户说
    # 「开案例」→ 回这张模版 → 他改完整段发回来 → 我们解析（`nl_router.parse_case_form`）
    # → 照旧走确认卡 → 回「确认」才真开单。**全程 0 token**。
    #
    # ⚠️ 下面 `label.*` 那六个标签必须能被 `core.nl_router._CASE_FORM_LABELS` 认回来
    # （那是回填解析的词表）。改了这里就要改那边 ——
    # `tests/test_dingtalk_case_form.py::test_every_rendered_label_parses_back`
    # 会逐个把渲染出来的标签喂回解析器，对不上就红。
    "im.dt.case.form.title": {
        "zh": "📋 开案例模版",
        "en": "📋 Case template",
    },
    "im.dt.case.form.instruction": {
        "zh": "复制整段,改完发回来。只有「问题描述」必填,其余根据实际情况进行修改即可。",
        "en": "Copy the whole block, edit it, send it back. Only "
              "\"Description\" is required — adjust the rest as needed.",
    },
    # 六行字段的**复制边界**。现网原话(2026-09-09):「现在混在一起,不太明显看出来要
    # 复制什么内容」。钉钉没有代码块、没有引用块能安全用(`>` 会被一起复制走)、更没有
    # 「复制」按钮 —— 能用的只有两条肉眼可辨的界线,加上把标签加粗(在
    # `case_text._form_body()` 里包 `**`)。
    #
    # ⚠️ 这两行的文案里**不许出现 `**`**:它们会跟着用户复制回来,靠
    # `case_text._form_boilerplate()` → `nl_router.parse_case_form(boilerplate=…)`
    # 剔掉,而那边比对前会用 `_case_form_probe` 把 `**` 剪掉 —— 存进来的原文自带星号
    # 就对不上,界线会直接进 AWS 案例正文(工程师会读到「从这里开始复制」)。
    # 同理**别加占位符**:比对是整行逐字的。
    "im.dt.case.form.copy_begin": {
        "zh": "━━━ ↓ 从这里开始复制 ↓ ━━━",
        "en": "━━━ ↓ copy from here ↓ ━━━",
    },
    "im.dt.case.form.copy_end": {
        "zh": "━━━ ↑ 复制到这里为止 ↑ ━━━",
        "en": "━━━ ↑ copy up to here ↑ ━━━",
    },
    "im.dt.case.form.label.description": {"zh": "问题描述", "en": "Description"},
    "im.dt.case.form.label.severity": {"zh": "严重等级", "en": "Severity"},
    "im.dt.case.form.label.language": {"zh": "语言", "en": "Language"},
    "im.dt.case.form.label.issue_type": {"zh": "案例类型", "en": "Case type"},
    "im.dt.case.form.label.service": {"zh": "涉及服务", "en": "Service"},
    "im.dt.case.form.label.subject": {"zh": "标题", "en": "Subject"},
    # 语言选项的短名。**故意不用 `LANGUAGE_LABELS`**：那份是 `Chinese / 中文` 这种
    # 带 ` / ` 的双语标签，而选项之间的分隔符也是 ` / ` —— 拼在一行里数不清哪个
    # 数字对哪个语言。四个都是本地名（endonym），所以 zh / en 两栏一样。
    "im.dt.case.form.lang.zh": {"zh": "中文", "en": "中文"},
    "im.dt.case.form.lang.en": {"zh": "English", "en": "English"},
    "im.dt.case.form.lang.ja": {"zh": "日本語", "en": "日本語"},
    "im.dt.case.form.lang.ko": {"zh": "한국어", "en": "한국어"},
    # 「涉及服务」的 0 号选项 = 不填，让 `core.case_classifier` 自己判。
    "im.dt.case.form.service_auto": {"zh": "自动判断", "en": "auto-detect"},
    "im.dt.case.form.service_freeform": {
        "zh": "清单外直接写名字,如 bedrock / msk / glue",
        "en": "not listed? just type the name, e.g. bedrock / msk / glue",
    },
    # 「标题」留这个词 = 按问题描述自动生成（`nl_router.summarize_case_subject`）。
    "im.dt.case.form.subject_auto": {"zh": "自动", "en": "auto"},
    "im.dt.case.form.subject_hint": {
        "zh": "留「自动」= 按你的描述生成",
        "en": "leave \"auto\" = generated from your description",
    },
    "im.dt.case.form.footer": {
        "zh": "问题描述可以换行多写几段,都会进案例正文。\n\n"
              "发回来后我先给你一张确认卡,回「确认」才真的开工单。",
        "en": "The description can span several lines — all of it goes into the "
              "case body.\n\n"
              "Once you send it back I'll show a confirmation card; nothing is "
              "filed until you reply \"confirm\".",
    },
    # 模版收回来了，但「问题描述」还是空的 —— 那一项是唯一必填项。**不建草稿**，
    # 把模版原样再发一遍（前面加这一句），用户接着改就行。
    "im.dt.case.form.need_description": {
        "zh": "⚠️ 模版收到了,但「问题描述」是空的 —— 这一项必填。补上再发一次:",
        "en": "⚠️ Got the template, but \"Description\" is empty — that one is "
              "required. Fill it in and send it again:",
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
