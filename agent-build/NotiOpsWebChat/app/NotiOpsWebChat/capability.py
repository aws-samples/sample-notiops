"""能力/元问题的**确定性应答**（「你能做什么」/ "what can you do"）—— 真 0 token。

「你能做什么」几乎是每个新用户的第一句话，而它的答案是**产品事实**，不是模型推理。
让模型现编一遍要付三笔钱：

  ① ~17K 工具 schema 的 input token —— 当前默认模型 Grok 4.6 走 Converse、不支持
     `cachePoint`，每轮都重新计费（见 config/llm-model-catalog.json）；
  ② 每次编得不一样（同一个问题今天六条能力、明天四条）；
  ③ **会夸大** —— 模型看到一堆工具 schema 就顺口把「能改配置 / 能帮你修」都说了，
     而 NotiOps 的产品承诺是**默认只读**。这一条是安全问题，不只是体验问题。

所以这里给确定性答案：0 token、瞬时、每次一致、能力清单由我们维护。

## 判据：整句精确匹配，宁漏不误

与 `core/nl_router.py` 的 `_HELP_RE` 同一个口径 —— 归一化后整句落在
`CAPABILITY_PHRASES` 里才算。宁可漏判（回落正常 agent 路径、照旧能答），绝不误伤真问题：
「你能帮我看看 EC2 吗」/ "what can you do about this alarm" 都不在集合里。

用**集合**而不是正则：能力/元问题的说法是**枚举**而非模式。正则一旦写宽（`.*能做.*`）
就会吃掉「这个账号能做成本优化吗」这种真问题；集合永远只命中整句。

## 为什么独立成一个模块

`main.py` 第一行就 `from strands import Agent`，在没装 strands 的环境（CI / 本地
pytest）里 import 不了。而「哪些说法算能力问题」和「能力清单写什么」恰恰是最该被测试
钉住、也最常被改的两样东西 —— 见 tests/test_webchat_capability_fastpath.py。

语言由调用方传入（`main.py` 用它自己的 `_dv` 决定本轮语言，那是该文件唯一的语言口径），
这个模块不碰 ContextVar。
"""

from __future__ import annotations

# 中文句尾语气词：归一化时削掉，让「你能做什么呀」与「你能做什么」落到同一条。
#
# ⚠️ **不要**把「么 / 麽」加进来。它确实能当句末语气词（「好么」＝「好吗」），但它同时是
# 「什么 / 怎么」的尾字 —— 一加进来，「你能做什么」就被削成「你能做什」，集合里**每一条**
# 带「什么」的短语（也就是大多数）全部永久失配。这是本模块唯一一个"看着无害、后果是
# 功能整体静默失效"的改动，tests/test_webchat_capability_fastpath.py 里
# test_every_phrase_in_the_set_is_already_normalized 就是拦它的。
_META_TAIL_CHARS = "呀呢啊吗嘛吧哦噢喔咧捏"

# ⚠️ 集合里的英文一律**已小写、已去标点**，与 normalize_meta 的输出对齐；
#    中文同理不带标点。加新说法前先想一遍："这句话有没有可能是别的意思？"
CAPABILITY_PHRASES = frozenset({
    # ── 中文 ──
    "你能做什么", "你能做些什么", "你能做啥", "你能干什么", "你能干啥", "你会做什么",
    "你可以做什么", "你可以做些什么", "你可以干什么", "你都能做什么", "都能做什么",
    "能做什么", "能做些什么", "可以做什么",
    "你能帮我做什么", "你能帮我什么", "你能帮什么", "你能帮我干什么",
    "你能帮忙做什么", "你能帮我们做什么", "你能提供什么帮助", "你能提供哪些帮助",
    "你有什么功能", "你有哪些功能", "有什么功能", "有哪些功能",
    "你有什么能力", "你有哪些能力", "你的功能", "你的能力",
    "你的功能有哪些", "你的能力有哪些", "功能介绍", "能力介绍",
    "你是谁", "你是什么", "你叫什么", "你叫什么名字",
    "介绍一下你自己", "介绍一下自己", "介绍下你自己", "介绍一下你", "自我介绍",
    "什么是notiops", "什么是 notiops", "notiops是什么", "notiops 是什么",
    "怎么用", "怎么使用", "如何使用", "使用说明", "使用帮助", "帮助", "帮助文档",
    # ── English ──
    "what can you do", "what can you do for me", "what do you do",
    "what are you able to do", "what else can you do",
    "what can you help me with", "what can you help with", "what can you help me do",
    "how can you help", "how can you help me",
    "what can i ask you", "what can i ask", "what can i do here",
    "what are your capabilities", "what capabilities do you have",
    "what are your features", "what features do you have",
    "who are you", "what are you", "introduce yourself", "tell me about yourself",
    "about you", "help", "help me get started",
    "how do i use this", "how do i use you", "how to use this", "how to use you",
    "what is notiops", "whats notiops", "notiops",
})


def normalize_meta(text: str) -> str:
    """整句精确匹配用的归一化：去标点/表情、压空白、小写，再削掉尾部语气词。

    「你能做什么？」「你能做什么呀」「What can you do?!」都归一到集合里的同一条。
    """
    s = (text or "").strip().lower()
    s = "".join(ch for ch in s if ch.isalnum() or ch == " ")
    s = " ".join(s.split())
    # 留住至少 2 个字：再削下去就不是"去语气词"而是在改词了。
    while len(s) > 2 and s[-1] in _META_TAIL_CHARS:
        s = s[:-1]
    return s.strip()


def is_capability_question(text: str) -> bool:
    """整句就是能力/元问题（「你能做什么」/ "who are you" / "help"）才算。"""
    if not text:
        return False
    return normalize_meta(text) in CAPABILITY_PHRASES


def _pick(locale: str, zh: str, en: str) -> str:
    return en if (locale or "").lower().startswith("en") else zh


def capability_answer(locale: str = "zh") -> str:
    """确定性能力说明。**这里是能力清单的唯一维护点** —— 加了新主题/新能力改这一处，
    不必指望模型自己发现（它也发现不了：它看到的是工具 schema，不是产品边界）。

    ⚠️ 只写**产品事实**、不写具体工具名：工具会增删，「能干什么」不会。
    ⚠️ 「默认只读」这句必须留着 —— 它是产品承诺，也是客户安全 review 的第一个问题。
    """
    return _pick(
        locale,
        "我是 **NotiOps** —— 面向 AWS 运维的 AI 助手。可以帮你做这些事：\n\n"
        "- **故障调查** — 看指标与日志、翻审计事件、只读巡检 EC2 / RDS 等资源；"
        "打开「深度调查」会把问题交给 AWS DevOps Agent 做根因分析。\n"
        "- **成本分析（FinOps）** — 账单与用量拆解、成本异常定位、按服务 / 账号归因、官方定价查询。\n"
        "- **支持案例** — 查看、创建、回复 AWS Support case。\n"
        "- **安全检查** — 只读的安全态势巡检（安全组规则、对外暴露面等）。\n"
        "- **What's New** — AWS 最新发布的摘要，或完整列表（可下载）。\n"
        "- **技能（Skills）** — 把你团队的排查手册变成可复用的检查流程。\n\n"
        "用法：左侧切换主题，输入框上方可选目标 AWS 账号与模型。"
        "**默认全程只读**；需要写操作（比如提一个 case）我会先把要做的事列给你、等你确认。\n\n"
        "直接说事就行，例如「i-0abc 为什么停了」「这个月成本涨在哪」「帮我开一个 case」。",

        "I'm **NotiOps** — an AI assistant for AWS operations. Here's what I can do:\n\n"
        "- **Investigation** — read metrics and logs, search audit events, inspect resources "
        "like EC2 / RDS read-only; turn on **Deep Dive** to hand the problem to AWS DevOps Agent "
        "for root-cause analysis.\n"
        "- **Cost analysis (FinOps)** — break down spend and usage, find cost anomalies, "
        "attribute cost by service / account, look up official pricing.\n"
        "- **Support cases** — view, create and reply to AWS Support cases.\n"
        "- **Security checks** — read-only posture checks (security group rules, public exposure…).\n"
        "- **What's New** — a digest of the latest AWS launches, or the full list (downloadable).\n"
        "- **Skills** — turn your team's runbooks into reusable checks.\n\n"
        "How to use it: switch topics on the left; pick the target AWS account and model above the "
        "input box. **Everything is read-only by default** — if something needs a write (opening a "
        "case, say), I'll show you exactly what I'm about to do and wait for your confirmation.\n\n"
        "Just tell me what you need, e.g. \"why did i-0abc stop\", \"where did cost go up this "
        "month\", \"open a support case for me\".",
    )


def builtin_answer_source(locale: str = "zh") -> dict:
    """内置确定性答案的「来源」（信息透明铁律：每条回复都要能说清答案从哪来）。

    刻意**不用** `main.py` 的 `_model_knowledge_source` —— 这条回答不是模型自身知识，
    是产品内置文案，说成「模型知识」同样是把来源说错。icon 用 doc
    （SourcesPanel 未识别的 icon 会落到 DocIcon，见 SourcesPanel.tsx:59）。
    """
    return {
        "icon": "doc",
        "title": _pick(locale, "NotiOps 内置能力说明（未调用模型）",
                       "NotiOps built-in capability summary (no model call)"),
        "detail": _pick(locale, "产品内置的确定性回答 · 0 token · 不含任何实时账号数据",
                        "Built-in deterministic answer · 0 tokens · contains no live account data"),
    }
