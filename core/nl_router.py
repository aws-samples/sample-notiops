"""Transport-agnostic, **0-token**, bilingual (zh + en) intent router for IM.

This is the deterministic front door the IM refactor puts *before* the Bedrock
classifier (`core.bedrock_intent.analyze_intent`). It recognises the four
trigger forms the product requires — **all at zero model cost** —:

  1. slash commands            `/调查 …` `/investigate …` `/案例` `/case` …
  2. bare `@bot <word>`        `@bot 调查 …` `@bot investigate …` (same regex,
                               the leading `/` is optional — Feishu has no
                               native slash commands so "slash optional" is the
                               established convention, see main.py:113)
  3. natural language          「我要开案例」「深度调查一下」/ "open a case" …
  4. (card buttons live in the platform handlers, not here)

Anything this module does NOT recognise returns ``None`` / ``""`` — the caller
falls through to its existing path (Bedrock classify → investigate card, or the
default DevOps chat). **宁漏不误**: patterns are intentionally narrow so a normal
question never gets eaten.

WHY REGEX AND NOT THE LLM
-------------------------
"不猜意图" ≠ "不认关键词". Recognising a keyword the user *explicitly typed* is a
deterministic match — it costs no tokens and needs no model. Guessing an intent
the user *didn't* state is what needs the LLM. This module only does the former.

This is not a new invention: `core.i18n.parse_language_switch_intent`
(i18n.py:133) already ships the same shape on prod — a 0-token, bilingual,
regex-driven NL intent parser for language switching. We reuse it verbatim for
the language axis and generalise its four design decisions to the others:

  1. **双要素才触发** — a verb × a target, never a bare noun.
  2. **长度闸门** — `len(s) > _NL_MAX_LEN` → don't fire (guards against a long
     technical question that merely *mentions* "案例"/"case" in passing).
     ⚠️ This guard does **not** apply to the strong-investigate axis — an
     investigation description is naturally long — so that axis uses a required
     strong-signal word with no length cap instead. This is the only asymmetry.
  3. **runs before the Bedrock classifier** — pattern check is ~free.
  4. **宁漏不误** — the default (DevOps chat / analyze_intent) catches misses.

VOCAB SOURCE
------------
The canonical case commands and their aliases come from
`core.bedrock_intent` (`VALID_COMMANDS`, `_COMMAND_ALIASES`). ⚠️ Those aliases
are *model-output* tokens, not *user phrasings* — the English column is reusable
as literal command words, the Chinese column is authored here (there is no
Chinese command alias anywhere else in the repo — measured 2026-08-31).

The strong-investigate vocabulary is deliberately kept away from 「查」:
「查一下 CPU 为什么高」/"check why CPU is high" is everyday chat phrasing; eating
it would turn every question into a form card the user must click through, which
feels *slower*. Only "要求深挖" wording (深度调查 / 根因分析 / deep dive / RCA)
fires the investigate axis.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Reuse the shipped language parser verbatim so the language axis stays in one
# place. `parse_language_switch_intent` is re-exported below.
from core.i18n import parse_language_switch_intent  # noqa: F401  (re-export)

# ---------------------------------------------------------------------------
# Length guard — copied from core/i18n.py:149. NL axes (case / language /
# model) don't fire on long messages; the strong-investigate axis is exempt
# (see module docstring) and has NO length cap.
# ---------------------------------------------------------------------------
_NL_MAX_LEN = 200


@dataclass(frozen=True)
class Route:
    """A deterministic routing decision, or a no-op sentinel.

    ``kind`` is one of:
      "help" | "language" | "model" | "skills" | "investigate" |
      "investigate_status" | "case" | ""

    An empty ``kind`` means "not recognised — caller falls through". All the
    other fields carry the parsed parameters for that kind; unused fields are
    empty strings.
    """
    kind: str = ""
    form: str = ""            # "command" | "nl" | "ref" — provenance, logging
    arg: str = ""            # investigate text / skills rest / language target
    lang: str = ""           # "zh" | "en" — only for kind == "language"
    model_arg: str = ""      # "" | "list" | "default" | "<alias>" — kind==model
    case_command: str = ""   # case_create|case_list|case_view|case_reply|
                             # case_resolve|case_analyze — only kind == "case"
    case_id: str = ""        # ≥6-digit case id, when the user typed one
    ref_id: str = ""         # investigation task_id / execution_id the user
                             # cited — only kind == "investigate_status"
    ref_explicit: bool = False  # True = the user typed a real reference token
                                # (`[[investigation:…]]` / `execution_id=…` /
                                # `exe-…`); False = a bare uuid we guessed at.

    def __bool__(self) -> bool:  # `if route(text):` reads naturally
        return bool(self.kind)


# ===========================================================================
# Command form (slash OR bare @bot word) — bilingual
# ===========================================================================
# Every command word is listed in BOTH languages. The leading `/` is always
# optional so `/investigate x` and `@bot investigate x` share one regex.
#
# ⚠️ Order matters where words are prefixes of each other; we compile each
# command as its own anchored regex and test them in priority order (case
# before investigate is irrelevant since vocab is disjoint, but help is tested
# first so "/help case things" reads as help, not case).

# `_cmd(words)` → a compiled regex matching `[/ ]<word>[ <rest>]` for any word.
def _cmd(*words: str) -> re.Pattern:
    alt = "|".join(re.escape(w) for w in words)
    return re.compile(
        rf"^\s*/?\s*(?:{alt})\b\s*(?P<rest>.*)$",
        re.IGNORECASE | re.DOTALL,
    )


# Case subcommand words → canonical command. English words are literal command
# tokens (reusable); Chinese authored here. `case`/`案例`/`工单` bare (no
# subcommand) → view/list is resolved by the caller via presence of an id.
# Help is matched STRICTLY (whole message only) — unlike the other commands it
# must not eat "help me debug X" / "帮我看看", which are task requests, not a
# request for the command menu.
#
# ⚠️ The capability question ("你能做什么" / "what can you do") MUST be in here.
# 2026-09-02 现网实测：它不在词表里 → 落到 `chat` → 打到客户的 DevOps Agent 上，
# 跑了 **318 秒**才以 `connection_error` 收场（worker 日志 cd0f6745）。这恰恰是新用户
# 进来的**第一句话**，而答案就是我们自己那张 0-token 能力卡 —— 让它过 agent 是纯粹的
# 浪费 + 最差的第一印象。凡是"你（这个 bot）能干什么"语义的说法都往这里加。
_HELP_RE = re.compile(
    r"^\s*/?\s*(?:"
    r"help|帮助|幫助|怎么用|怎麼用|如何使用|"
    r"how\s+(?:do\s+i|to)\s+use(?:\s+(?:this|it|you|the\s+bot))?|"
    # ── 能力提问（whole-message only，同上）──
    # 「你/您」与「能/会/可以/都能」自由组合；「做|干」+「什么|啥」。
    r"(?:你|您|你们|你們)?\s*(?:都)?\s*(?:能|会|會|可以)\s*(?:做|干|幹)\s*(?:什么|什麼|啥|哪些)|"
    r"(?:有|支持)\s*(?:什么|什麼|哪些)\s*(?:功能|能力|命令|指令)|"
    r"(?:功能|能力|命令|指令)\s*(?:列表|清单|清單|有哪些)|"
    r"what\s+(?:can|do)\s+you\s+do|"
    r"what\s+(?:are\s+your|can\s+i\s+ask)\s*(?:capabilities|for|about)?|"
    r"capabilities|commands"
    r")\s*[?？!！。.]*\s*$",
    re.IGNORECASE,
)
_LANGUAGE_RE = _cmd("language", "lang", "语言", "語言")
_MODEL_RE = _cmd("model", "模型")
_SKILLS_RE = _cmd("skills", "skill", "技能")
_INVESTIGATE_RE = _cmd(
    "investigate", "inv", "investigation", "调查", "調查", "排查", "深度调查",
    "深度調查",
)

# Case commands: <subcommand-word> → canonical. We build one regex per
# canonical command so the parsed `case_command` is unambiguous.
_CASE_CMD_PATTERNS: tuple[tuple[re.Pattern, str], ...] = (
    (_cmd("case_create", "create-case", "create_case", "new-case", "new_case",
          "开案例", "開案例", "建案例", "创建案例", "創建案例", "提工单",
          "提工單", "开工单", "開工單", "转人工", "轉人工"), "case_create"),
    (_cmd("case_list", "list-cases", "list_cases", "list-case", "list_case",
          "my-cases", "my_cases", "my-case", "my_case",
          "案例列表", "工单列表", "工單列表", "我的案例", "我的工单",
          "我的工單"), "case_list"),
    (_cmd("case_view", "view-case", "view_case", "show-case", "show_case",
          "查看案例", "查看工单", "查看工單", "案例详情", "案例詳情"),
     "case_view"),
    (_cmd("case_reply", "reply-case", "reply_case", "comment-case",
          "comment_case", "回复案例", "回覆案例", "追加案例"), "case_reply"),
    (_cmd("case_resolve", "resolve-case", "resolve_case", "close-case",
          "close_case", "关闭案例", "關閉案例", "结案", "結案", "解决案例",
          "解決案例"), "case_resolve"),
    (_cmd("case_analyze", "analyze-case", "analyse-case", "analyze_case",
          "analyse_case", "summarize-case", "summarise-case",
          "case-analyze", "case-analyse", "case-summary",
          "分析案例", "案例分析", "案例摘要", "总结案例", "總結案例"),
     "case_analyze"),
    # bare "case" / "cases" / "案例" / "工单" LAST — the specific verb+noun
    # forms above win; this bare form falls to view-if-id / list-otherwise.
    (_cmd("case", "cases", "案例", "工单", "工單"), "case_bare"),
)

# ≥6-digit case id, same shape as bedrock_intent._CASE_ID_RE (kept local so
# nl_router has no hard dep on bedrock_intent internals).
_CASE_ID_RE = re.compile(r"\b(\d{6,})\b")


def _extract_case_id(text: str) -> str:
    m = _CASE_ID_RE.search(text or "")
    return m.group(1) if m else ""


def parse_command(text: str) -> Route:
    """Deterministic slash / bare-word command parser (both languages).

    Returns a populated :class:`Route` (``form="command"``) or an empty
    ``Route`` when the text is not a recognised command.

    Never calls the LLM. Never raises.
    """
    s = (text or "").strip()
    if not s:
        return Route()

    if _HELP_RE.match(s):
        return Route(kind="help", form="command")

    m = _LANGUAGE_RE.match(s)
    if m:
        return Route(kind="language", form="command",
                     arg=(m.group("rest") or "").strip())

    m = _MODEL_RE.match(s)
    if m:
        return Route(kind="model", form="command",
                     model_arg=(m.group("rest") or "").strip().lower())

    m = _SKILLS_RE.match(s)
    if m:
        return Route(kind="skills", form="command",
                     arg=(m.group("rest") or "").strip())

    for pat, canonical in _CASE_CMD_PATTERNS:
        m = pat.match(s)
        if not m:
            continue
        rest = (m.group("rest") or "").strip()
        case_id = _extract_case_id(rest)
        if canonical == "case_bare":
            # bare "case <id>" → view; bare "case" (no id) → list.
            canonical = "case_view" if case_id else "case_list"
        # view/reply/resolve/analyze without an id → fall back to list so the
        # user can pick from recent cases first (mirrors bedrock_intent).
        if canonical in {"case_view", "case_reply", "case_resolve",
                         "case_analyze"} and not case_id:
            canonical = "case_list"
        return Route(kind="case", form="command",
                     case_command=canonical, case_id=case_id, arg=rest)

    m = _INVESTIGATE_RE.match(s)
    if m:
        return Route(kind="investigate", form="command",
                     arg=(m.group("rest") or "").strip())

    return Route()


# ===========================================================================
# Natural-language forms — narrow, precision-first, 0 token
# ===========================================================================

# --- Strong investigate signal (NO length cap; requires an explicit "深挖"
#     wording). Never widen to 「查」/"check"/"look at" — those are everyday
#     chat phrasings and eating them makes every question a form card. ---
#
# ⚠️ 中英必须**对等**（2026-09-03 客户实测报的问题）：英文侧 `deep dive` 一直命中，
# 中文侧却只认「深度…」这一个前缀 —— 「深入调查 8 月成本」「全面排查网络」「详细分析
# EBS 性能」全部落到 `chat`，被当成普通闲聊发给 DevOps Agent。所以中文这一支现在是
# **程度副词 × 调查动词**的笛卡尔积（深度/深入/彻底/全面/详细/仔细/系统 ×
# 调查/排查/分析/诊断/定位/追查），而不是逐条穷举短语。
#   · 程度副词是必需项：「分析一下这张图」不该变成一次付费调查；
#   · 动词表里**没有**光秃秃的「查」/「看」：「查一下 CPU」是日常问法。
_ZH_DEPTH_ADV = (r"(?:深度|深入|彻底|徹底|全面|详细|詳細|仔细|仔細|系统性?|系統性?|"
                 r"完整|从头到尾|從頭到尾)")
_ZH_PROBE_VERB = (r"(?:调查|調查|排查|分析|诊断|診斷|定位|追查|梳理|挖掘|复盘|復盤)")
_STRONG_INVESTIGATE_RE = re.compile(
    # zh — 程度副词 × 调查动词（允许中间夹「地/的」这种助词）
    rf"{_ZH_DEPTH_ADV}(?:地|的)?\s*{_ZH_PROBE_VERB}|"
    # zh — 与副词无关但同样是"要求深挖"的固定说法
    r"根(?:本)?原因(?:分析)?|根因(?:分析)?|立案调查|立案調查|"
    r"排查到底|查到底|深挖|刨根问底|刨根問底|"
    # en —— ⚠️ 名词 `investigation` **不能**裸放（见 `parse_investigation_ref`
    # 的注释）：那会让「what's the status of this investigation」变成新开一次调查。
    # 只认"动词引导"的形态。
    r"\bdeep[-\s]?dive\b|\binvestigate\b|"
    r"\b(?:start|open|launch|kick\s*off|run|create|need|want|request|"
    r"trigger|do|perform)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+|full\s+|deep\s+)?"
    r"investigation\b|"
    r"\broot[-\s]?cause\b|\brca\b|\bfull\s+investigation\b|"
    r"\bget\s+to\s+the\s+bottom\b|\bdig\s+(?:in|into|deep)\b",
    re.IGNORECASE,
)


def parse_strong_investigate(text: str) -> bool:
    """True iff the text explicitly asks for a *deep* investigation.

    Deliberately narrow (precision over recall) and intentionally exempt from
    the length guard — investigation descriptions are naturally long. Bare
    「查」/"check"/"look at" do NOT match; see module docstring.
    """
    s = (text or "").strip()
    if not s:
        return False
    return bool(_STRONG_INVESTIGATE_RE.search(s))


# --- Investigation **reference** signal — "问已有那条调查", NOT "再开一条" ---
#
# 2026-09-03 客户实测的 bug：我们自己发的卡片正文里就带着
#   「调查已创建：[[investigation:544a06e4-…:IAD (us-east-1) EBS 性能问题排查]]」
# 用户顺手复制这串去追问「…现在是什么状态」/「帮我监控…的实时进展」，结果
# `_STRONG_INVESTIGATE_RE` 里裸放的 `\binvestigation\b` 命中 → 又开一条**付费**调查。
# 三条示例全部复现（`kind == "investigate"`）。
#
# 修法两半，缺一不可：
#   1. 上面把裸 `investigation` 收成"动词引导"形态；
#   2. 这里加一条**优先级最高**的引用轴 —— 只要用户明确写了一个引用 token，就一定是
#      「问那一条」，交给 `investigate_status`（0 token，去 DevOps Agent 查状态并回读）。
#
# ⚠️ 显式引用必须在 `parse_command` **之前**判：`_INVESTIGATE_RE` 的命令形态
# （`^/?investigation\b…`）会把一条以 `investigation:<uuid>` 开头的消息当成 `/调查`。
#
# 口径与 web 端 `bff/web-chat/devops_investigate.mjs::extractInvestigationRef`
# 保持一致（同一批 token 形态、同一个"显式 vs 猜"的二分），这样两个入口对同一句话
# 的理解不会分叉。
_INV_REF_TOKEN = r"([A-Za-z0-9][A-Za-z0-9._-]{7,})"
#: `[[investigation:<id>[:title]]]` 与裸 `investigation:<id>` 是同一条正则 ——
#: 前者只是多了对方括号，`\b` 在 `[` 后面成立。id 后面的 `:标题` 天然被 token 的
#: 字符集截断（`:` 不在里面），所以不需要要求闭合的 `]]`（用户常常复制成半截）。
_INV_REF_PREFIX_RE = re.compile(
    r"\binvestigation\s*[:：]\s*`?" + _INV_REF_TOKEN, re.IGNORECASE)
_INV_REF_EXEC_RE = re.compile(
    r"execution[_\s-]?id\s*[=:：]\s*`?" + _INV_REF_TOKEN, re.IGNORECASE)
_INV_REF_EXE_RE = re.compile(r"\b(exe-[A-Za-z0-9-]{8,})\b", re.IGNORECASE)
_UUID_RE = re.compile(
    r"\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b",
    re.IGNORECASE)

#: 「在问状态/进展」的措辞。**只用于裸 uuid 那条兜底路径** —— 一个裸 uuid 可能是
#: 任何资源 id，必须再有一个状态词才敢认；显式 token 那三条不需要它。
_INV_STATUS_WORD_RE = re.compile(
    r"状态|狀態|进展|進展|进度|進度|怎么样|怎麼樣|如何了|到哪(?:一)?步|"
    r"完成(?:了)?(?:吗|嗎|没|沒)|好了(?:吗|嗎)|结束(?:了)?(?:吗|嗎)|"
    r"结果|結果|报告|報告|监控|監控|跟踪|跟蹤|追踪|追蹤|"
    r"\bstatus\b|\bprogress\b|\bupdates?\b|\bmonitor\b|\btrack\b|"
    r"\bresults?\b|\breport\b|\beta\b|\bdone\b|\bfinished\b|"
    r"\bhow(?:'s|\s+is|\s+are)\b",
    re.IGNORECASE,
)


def parse_investigation_ref(text: str) -> Route:
    """认出"用户在问一条**已有**调查"，返回 ``kind="investigate_status"``。

    两档置信度（与 web 端同口径）：

      · ``ref_explicit=True`` —— 用户写了 `[[investigation:<id>]]` /
        `investigation:<id>` / `execution_id=<id>` / 裸 `exe-…`。这是**明确引用**：
        解析不出来也不能退化成"再开一条"，平台层应当照实说"这条引用查不到"然后停。
      · ``ref_explicit=False`` —— 只有一个裸 uuid，且句子里另有状态词。这是**猜**：
        查不到就静默落回 `chat`。

    0 token，永不抛。
    """
    s = (text or "").strip()
    if not s:
        return Route()
    for pat in (_INV_REF_PREFIX_RE, _INV_REF_EXEC_RE, _INV_REF_EXE_RE):
        m = pat.search(s)
        if m:
            return Route(kind="investigate_status", form="ref",
                         ref_id=m.group(1), ref_explicit=True, arg=s)
    m = _UUID_RE.search(s)
    if m and _INV_STATUS_WORD_RE.search(s):
        return Route(kind="investigate_status", form="nl",
                     ref_id=m.group(1), ref_explicit=False, arg=s)
    return Route()


# --- Case NL signal — verb × noun, both required. Length-guarded. ---
# The noun ("案例"/"工单"/"case"/"ticket") is mandatory so "有没有类似案例"
# ("is there a similar precedent") doesn't fire — that "案例" means an example,
# not an AWS Support Case. `case_view` additionally requires a numeric id.
_CASE_NOUN = r"(?:案例|工单|工單|support\s*case|case|ticket)"
_CASE_NL_PATTERNS: tuple[tuple[re.Pattern, str], ...] = (
    # create — verb + noun, OR the standalone "转人工/找人工/联系支持" idioms.
    (re.compile(
        rf"(?:开|開|提|建|创建|創建|新建|提交|发起|發起|申请|申請)\s*(?:一个|一個|个|個)?\s*{_CASE_NOUN}"
        rf"|(?:转|轉|找)\s*人工"
        rf"|联系\s*(?:aws\s*)?支持|聯繫\s*(?:aws\s*)?支持"
        rf"|\b(?:open|create|raise|file|submit)\s+(?:a\s+)?(?:new\s+)?(?:support\s+)?(?:case|ticket)\b"
        rf"|\bescalate\b|\btalk\s+to\s+(?:a\s+)?human\b",
        re.IGNORECASE), "case_create"),
    # list — "我的/所有/最近 案例", "case list".
    (re.compile(
        rf"(?:我的|所有|全部|最近|列出)\s*{_CASE_NOUN}\s*(?:列表)?"
        rf"|{_CASE_NOUN}\s*列表"
        rf"|\b(?:list|show)\s+(?:my\s+|all\s+|recent\s+)?(?:support\s+)?cases?\b"
        rf"|\bmy\s+cases?\b",
        re.IGNORECASE), "case_list"),
    # reply — "回复/追加/补充 案例". (verb-specific; checked before view so
    # "回复案例 123" doesn't get eaten by the generic noun+id form below.)
    (re.compile(
        rf"(?:回复|回覆|追加|补充|補充)\s*{_CASE_NOUN}"
        rf"|\b(?:reply\s+to|comment\s+on|add\s+to)\s+(?:the\s+)?(?:support\s+)?case\b",
        re.IGNORECASE), "case_reply"),
    # resolve — "关闭/结案/解决 案例".
    (re.compile(
        rf"(?:关闭|關閉|结案|結案|解决|解決)\s*{_CASE_NOUN}?"
        rf"|\b(?:close|resolve)\s+(?:the\s+)?(?:support\s+)?case\b",
        re.IGNORECASE), "case_resolve"),
    # analyze — "分析/总结 案例".
    (re.compile(
        rf"(?:分析|总结|總結|摘要)\s*{_CASE_NOUN}"
        rf"|\b(?:analy[sz]e|summari[sz]e)\s+(?:the\s+)?(?:support\s+)?case\b",
        re.IGNORECASE), "case_analyze"),
    # view — LAST among case forms: an explicit view verb + case, OR a bare
    # noun+id. Placed after reply/resolve/analyze so their verbs win; the
    # generic noun+id form would otherwise swallow "close case 123" etc.
    (re.compile(
        rf"(?:查看|查询|查詢|详情|詳情)\s*{_CASE_NOUN}"
        rf"|\b(?:view|show|describe)\s+(?:support\s+)?case\b"
        rf"|{_CASE_NOUN}\b.*?\d{{6,}}",
        re.IGNORECASE), "case_view"),
)


def parse_case_intent(text: str) -> Route:
    """Narrow, length-guarded NL case detector (verb × noun).

    Returns a ``kind="case"`` :class:`Route` (``form="nl"``) or an empty
    ``Route``. Precision-first — a bare "案例" (meaning "example") never fires.
    Does NOT extract subject/body; the case flow's own summarizer does that
    (this gate only routes — 闸门只分流，不作答).
    """
    s = (text or "").strip()
    if not s or len(s) > _NL_MAX_LEN:
        return Route()
    for pat, canonical in _CASE_NL_PATTERNS:
        if pat.search(s):
            case_id = _extract_case_id(s)
            # view/reply/resolve/analyze without an id → list first so the
            # user can pick from recent cases (mirrors parse_command).
            if canonical in {"case_view", "case_reply", "case_resolve",
                             "case_analyze"} and not case_id:
                canonical = "case_list"
            return Route(kind="case", form="nl",
                         case_command=canonical, case_id=case_id)
    return Route()


# --- Model-switch NL signal (verb × "模型"/"model"). Like language, there is
#     no reliable way to name the target alias in NL (aliases are dynamic, in
#     DDB), so a match means "the user wants to change model" → the caller
#     shows the picker (`model list`). Length-guarded. ---
_MODEL_SWITCH_RE = re.compile(
    r"(?:切换?|换个?|換個?|改用?|改成?|用别的|用別的|设置|設置)\s*.{0,8}?(?:模型|model)"
    r"|(?:模型|model)\s*.{0,8}?(?:切换?|换|換|改)"
    r"|\b(?:switch|change|use\s+(?:a\s+)?(?:different|another))\s+(?:the\s+)?model\b",
    re.IGNORECASE,
)


def parse_model_switch_intent(text: str) -> bool:
    """True iff the text is a NL request to change the model (no alias named).

    The caller surfaces the model list so the user can pick. Length-guarded.
    """
    s = (text or "").strip()
    if not s or len(s) > _NL_MAX_LEN:
        return False
    return bool(_MODEL_SWITCH_RE.search(s))


# ===========================================================================
# Top-level classify — command form first, then NL. 0 token, never raises.
# ===========================================================================
def classify(text: str) -> Route:
    """Single entry point. Returns a :class:`Route`; an empty ``Route``
    (``kind == ""``) means "fall through to your existing path".

    Priority (highest first):
      0. **explicit** investigation reference     — "问已有那条"，必须先于命令，
                                                    见 `parse_investigation_ref`
      1. explicit command (slash / bare word)  — most specific, both languages
      2. NL language switch                     — shipped parser (i18n.py)
      3. NL model switch
      4. guessed investigation reference (裸 uuid + 状态词)
      5. NL strong-investigate signal
      6. NL case signal
      7. (nothing) → caller's default: DevOps chat / analyze_intent

    Language and case NL are the token-relevant catches: firing them here means
    the Bedrock classifier never runs for those messages.

    ⚠️ 已知取舍（有意为之）：一句里**既有**显式引用**又有**深挖措辞
    （「深度调查一下 [[investigation:abc…]]」）会走 status。代价是用户想"照着那条再开
    一条"时要多说一句；收益是不会因为一次误判凭空多跑一条付费调查。
    """
    ref = parse_investigation_ref(text)
    if ref.ref_explicit:
        return ref

    cmd = parse_command(text)
    if cmd:
        return cmd

    lang = parse_language_switch_intent(text)
    if lang:
        return Route(kind="language", form="nl", lang=lang, arg=lang)

    if parse_model_switch_intent(text):
        return Route(kind="model", form="nl", model_arg="list")

    # 裸 uuid + 状态词 —— 放在 strong-investigate 之前：两边都命中时，"问已有的那条"
    # 是 0 token 且可逆的，"再开一条"是付费且不可逆的。
    if ref:
        return ref

    # Strong-investigate is checked before case: "对这个案例做根因分析" is rare,
    # but if both fire the deep-dive intent is the stronger signal. Case NL is
    # narrow enough that this ordering almost never matters.
    if parse_strong_investigate(text):
        return Route(kind="investigate", form="nl", arg=(text or "").strip())

    case = parse_case_intent(text)
    if case:
        return case

    return Route()


# ---------------------------------------------------------------------------
# `/help` content — bilingual, lists BOTH language forms of every command.
# A Chinese user won't guess `/调查` exists unless we tell them. The platform
# layer renders this via i18n key "help.body"; the canonical command list
# lives here so all three platforms stay in sync (词表不各自维护一份).
# ---------------------------------------------------------------------------
HELP_COMMANDS: tuple[tuple[str, str, str], ...] = (
    # (feature, "en command(s)", "zh command(s)")
    ("investigate", "/investigate <text>", "/调查 <内容>"),
    ("case",        "/case · /cases",       "/案例 · /工单"),
    ("model",       "/model · /model list", "/模型 · /模型 list"),
    ("language",    "/language zh|en",      "/语言 zh|en"),
    ("help",        "/help",                "/帮助"),
)
#: ⚠️ 2026-09-03 起 `skills` **不在这张菜单里**。IM 侧 `/skills` 从来没有真正实现过
#: （`caps.skills` 只回一句"请用 `/skills create …`"，而那条命令在 IM 路径上无人处理
#: —— 用户照着提示打一遍会拿到同一句，是个自指的死循环）；skill 的创建/上传/运行需要
#: S3 + Secrets 权限，一直留在 Web 端。把一个做不到的能力挂在 `/help` 里比不挂更糟。
#: `parse_command` 里的 `skills` 分支**保留**（`_SKILLS_RE`）：打了 `/skills` 要有一句
#: 确定性的"去 Web 端"指路（0 token），删掉路由会让它掉进 `chat` 去问 DevOps Agent。
