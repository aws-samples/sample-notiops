"""钉钉的 AWS Support 案例交互 —— **纯文本、无按钮回调**的那条路。

`platforms/feishu/app/case_flow.py`（2200+ 行）/ `platforms/slack/app/case_flow.py`
的钉钉对位实现。业务逻辑一行都不重写：`core.case_management` +
`core.support_logic` + `core.case_analyze` 三家共用同一份。

── 为什么只有 400 行而那两家有 2000+ ────────────────────────────────────────
另外两家的绝大部分体量是**卡片 / 弹窗 / 按钮回调**：表单 modal、下拉菜单、
`case_view` / `case_reply_form` / `case_resolve_confirm` 一串 action handler。
钉钉这些一个都没有 —— ActionCard 的按钮只能跳 URL，没有"按钮 → 回调我们服务器"
这条路（见 `caps.py` 文件头第 4 条）。于是：

  · **没有表单**  → 参数从用户那一句话里解析（`severity=high` 这种 ASCII k=v）；
  · **没有按钮**  → 危险动作（开案例 / 关案例）靠**用户回一句「确认」**二次确认，
                    草稿存在 `core.ddb_state` 的 convo-session 里（30 分钟 TTL）；
  · **没有 view** → 每条渲染都是一条独立的 markdown 消息，走 `dt_messages`。

── 二次确认为什么不能省 ─────────────────────────────────────────────────────
开案例是 IM 侧唯一的**写操作**，关案例会让 AWS 工程师停止处理。另外两家用弹窗
+ 按钮把"我真的要做"这一步显式化了；钉钉这边如果直接执行，一句
「帮我开个案例看看」就会真的开出一张工单（还带账号轴 —— 可能开错账号）。
所以确认这一步是**产品要求**，不是实现方便。

── 账号轴（多账号）────────────────────────────────────────────────────────
每个入口点都收 `account_id`（空 = 部署账号 = 历史行为），一路透传给三个 core
模块。与另外两家的差别：那两家把账号"盖章"在按钮 `value` / modal 的
`private_metadata` 里带回来；钉钉没有按钮，所以盖在 **convo-session 的 data**
里 —— 同一个道理：用户可能在回「确认」之前又切了账号，而草稿只对原账号有意义。

**每条消息顶上都印账号**（`_account_banner`），口径与另外两家逐字一致。

── 文案 ────────────────────────────────────────────────────────────────────
一律复用 `case.*` 的既有 key，**用飞书那一套（标准 markdown 口味）**，不用
`*_slack` 变体（`<url|text>` + 单星粗体在钉钉里是坏的）。单星粗体的历史文案统一
过 `im_markdown.star_to_bold`。钉钉独有的提示（草稿 / 确认 / 取消 / 用法）在
`core/i18n.py` 的 `im.dt.*` 一小块里。
"""
from __future__ import annotations

import logging
import re
import time

from core import case_analyze
from core import case_classifier
from core import case_management
from core import ddb_state
from core import i18n
from core import im_accounts
from core import nl_router
from core import support_logic
from core.case_management import CaseSummary, Communication
from core.support_logic import (
    DEFAULT_ISSUE_TYPE, DEFAULT_LANGUAGE, DEFAULT_SEVERITY,
    ISSUE_TYPE_CODES, LANGUAGE_CODES, LANGUAGE_LABELS, SEVERITY_CODES,
    issue_type_label, severity_label,
)

from platforms.common import im_markdown
from platforms.dingtalk import dt_messages, sender

logger = logging.getLogger(__name__)

PLATFORM = "dingtalk"

#: convo-session 的 kind。**一个会话 × 一个用户只有一个待确认动作** —— 开案例和
#: 关案例共用这一格，靠 data 里的 `op` 区分。为什么不分两个 kind：用户回的那句
#: 「确认」不带任何指向，两个待确认动作同时挂着就没法判断确认的是哪一个。
CONVO_KIND = "case"

#: 案例模版的会话标记。与 `CONVO_KIND` **分开一格**：那一格是"待确认的写操作"，
#: 只能有一个；模版标记只是"我刚给过他一张模版"，发完模版用户完全可能先去干别的
#: （比如 `/关闭案例`），共用一格会把真正待确认的动作挤掉。
CONVO_FORM_KIND = "case_form"

#: 草稿正文的渲染上限。`dt_messages.MAX_BODY` 管整条消息；这里额外把**用户原话**
#: 剪短，否则一句 2000 字的粘贴会把草稿卡里的严重等级/语言挤到看不见。
DRAFT_BODY_MAX = 600

#: 面板参数的纯 ASCII 写法。**故意只认 ASCII** —— 这些 token 会进
#: `scripts/lint_i18n.py` 扫的源码，中文别名放在 `core.nl_router` 那边（已加
#: CJK 允许清单）才是对的地方；而且用户在钉钉里打 `severity=high` 比打中文更快。
_OVERRIDE_RE = re.compile(
    r"\b(severity|language|lang|type|issue_type|service|category)"
    r"\s*=\s*([^\s]+)", re.IGNORECASE)

#: `_OVERRIDE_RE` 抓到的键 → 规范名。
_OVERRIDE_ALIASES = {
    "severity": "severity",
    "language": "language",
    "lang": "language",
    "type": "issue_type",
    "issue_type": "issue_type",
    "service": "service",
    "category": "category",
}

# 过滤器 slug → 标签 / 空态文案。与飞书 `_FILTER_LABEL_KEYS` /
# `_FILTER_EMPTY_KEYS` 逐条对齐（那两份是同一批 key，三边漂移就会出现
# "同一个过滤器在飞书叫 A、在钉钉叫 B"）。
_FILTER_LABEL_KEYS = {
    "recent": "case.list.filter.recent",
    "pending_customer": "case.list.filter.pending_customer",
    "unresolved": "case.list.filter.unresolved",
    "work_in_progress": "case.list.filter.work_in_progress",
    "resolved": "case.list.filter.resolved",
}
_FILTER_EMPTY_KEYS = {
    "recent": "case.list.empty.recent",
    "pending_customer": "case.list.empty.pending_customer",
    "unresolved": "case.list.empty.unresolved",
    "work_in_progress": "case.list.empty.work_in_progress",
    "resolved": "case.list.empty.resolved",
}

#: 严重等级 → emoji。与飞书 `_list_card` 里那一份逐字对齐。
_SEV_EMOJI = {"critical": "🟣", "urgent": "🔴", "high": "🟠",
              "normal": "🟡", "low": "🟢"}


# ===========================================================================
# 小工具（与飞书 case_flow 的同名函数逐字对位）
# ===========================================================================
def _normalize_locale(locale: str | None) -> str:
    """把 locale 收进支持集。钉钉默认 zh —— 与飞书一致、与 Slack 相反
    （Slack 那边的工作区默认英文）。"""
    loc = (locale or "zh").strip().lower()
    return loc if loc in {"zh", "en"} else "zh"


def _bold(s: str) -> str:
    """单星粗体 → 双星。`core/i18n.py` 里有一批案例文案是 Slack 口味的
    `*x*`，钉钉按标准 markdown 解析（单星 = 斜体），不转就会显示成小斜体字。"""
    return im_markdown.star_to_bold(s)


def _escape_md(s: str) -> str:
    """竖线会被当成表格语法。与飞书 `_escape_md` 同口径。"""
    return (s or "").replace("|", "\\|")


def _trim(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[:n] + "…"


def _short_date(iso: str) -> str:
    """'2026-05-25T04:14:31.000Z' → '2026-05-25 04:14 UTC'。"""
    if not iso or len(iso) < 16:
        return iso or "—"
    return f"{iso[:10]} {iso[11:16]} UTC"


def _filter_label(slug: str, locale: str) -> str:
    key = _FILTER_LABEL_KEYS.get(slug, _FILTER_LABEL_KEYS["recent"])
    return i18n.t(key, locale)


def _account_banner(account_id: str, locale: str) -> str:
    """消息顶上那条账号横幅，**总是**报账号。返回 "" 表示两个号都拿不到。

    与飞书 `_account_banner` / Slack `_account_banner_blocks` 同一套语义（同两个
    i18n key、同一条"两个都空就整条不显示"的规矩），只是这里回一段 markdown
    而不是一个卡片元素。
    """
    acct = (account_id or "").strip()
    deploy = im_accounts.deploy_account_id()
    if not acct or acct == deploy:
        if not deploy:
            return ""
        return i18n.t("case.account_banner_deploy", locale, account=deploy)
    return i18n.t("case.account_banner", locale, account=acct)


def _compose(banner: str, *blocks: str) -> str:
    """账号横幅 + 若干正文段 → 一段 markdown。空段自动丢掉。"""
    parts = [p for p in ((banner,) + blocks) if (p or "").strip()]
    return "\n\n".join(parts)


def _send(pair: tuple[str, str]) -> bool:
    """`dt_messages.*` 回的 `(title, text)` → 真的发出去。

    发送失败**不抛**（`sender.reply` 自己已经吞了异常并记了日志）—— 案例这条路
    上每个入口点都可能连发两条（"正在创建…" + 结果），第一条发失败不该让第二条
    也丢掉。
    """
    title, text = pair
    return sender.reply(title=title, text=text)


def _info(title: str, body: str, locale: str) -> bool:
    """一条"标题 + 一段话"的消息。对位飞书的 `_info_card`。"""
    return _send(dt_messages.titled_text(title, body, locale))


# ===========================================================================
# 入口：列表 / 详情 / 分析
# ===========================================================================
def start_list(status_filter: str = "recent", *, locale: str = "zh",
               account_id: str = "") -> bool:
    """最近的案例列表（5 条）。对位飞书 `_list_card`。"""
    locale = _normalize_locale(locale)
    banner = _account_banner(account_id, locale)
    label = _filter_label(status_filter, locale)
    cases = case_management.list_recent_cases(
        after_days=90, max_items=5, status_filter=status_filter,
        account_id=account_id)
    title = i18n.t("case.list.title_with_label", locale, label=label)
    if not cases:
        empty_key = _FILTER_EMPTY_KEYS.get(status_filter,
                                           "case.list.empty.default")
        body = _compose(banner, i18n.t(empty_key, locale),
                        _console_link(locale))
        return _send(dt_messages.titled_text(title, body, locale))
    blocks = [_bold(i18n.t("case.list.subtotal", locale,
                           label=label, count=len(cases)))]
    for c in cases:
        blocks.append(_list_row(c, locale))
    blocks.append(i18n.t("case.list.see_more_hint", locale))
    blocks.append(_console_link(locale))
    body = _compose(banner, *blocks)
    return _send(dt_messages.titled_text(title, body, locale))


def _console_link(locale: str) -> str:
    """控制台全量列表的链接。钉钉没有按钮，url 按钮一律降级成正文里的链接。"""
    url = case_management.SUPPORT_CONSOLE_LIST_URL
    return f"[{i18n.t('case.list.btn.console_all', locale)}]({url})"


def _list_row(c: CaseSummary, locale: str) -> str:
    """列表里的一行。与飞书 `_list_card` 的 `body_md` 逐字对齐 —— 唯一的差别是
    那边紧跟着一排回调按钮，这里改成正文里的 url 链接（§4.2）。"""
    sev_emoji = _SEV_EMOJI.get(c.severity, "⚪")
    is_resolved = c.status.startswith("resolved") or c.status == "closed"
    status_badge = (i18n.t("case.list.status.resolved", locale) if is_resolved
                    else i18n.t("case.list.status.active", locale,
                                status=c.status))
    subject_text = (_escape_md(c.subject)
                    or i18n.t("case.list.no_subject", locale))
    meta_line = i18n.t(
        "case.list.row_meta", locale,
        date=_short_date(c.created_at),
        submitter=(c.submitted_by
                   or i18n.t("case.list.unknown_submitter", locale)))
    row = (f"**{sev_emoji} {subject_text}**\n"
           f"`{c.display_id}` · {status_badge} · "
           f"{severity_label(c.severity, locale)}\n"
           f"{meta_line}")
    if c.recent_communication:
        row += f"\n\n> {_escape_md(c.recent_communication)}"
    if c.case_url:
        row += (f"\n\n[{i18n.t('case.list.btn.open_case', locale)}]"
                f"({c.case_url})")
    return row


def start_view(display_id: str, *, internal_id: str = "",
               locale: str = "zh", account_id: str = "") -> bool:
    """案例详情 + 最近 5 条回复。对位飞书 `_view_card`。"""
    locale = _normalize_locale(locale)
    if not display_id:
        return start_list(locale=locale, account_id=account_id)
    banner = _account_banner(account_id, locale)
    c = case_management.describe_case(display_id, internal_id=internal_id,
                                      account_id=account_id)
    if c is None:
        # 跨账号找不到是**最常见**的一种失败，所以横幅必须在 —— "找不到"加上
        # "我查的是哪个账号"才是可操作的信息。
        return _info(i18n.t("case.view.not_found_title", locale),
                     _compose(banner,
                              _bold(i18n.t("case.view.not_found_block_short",
                                           locale, display_id=display_id))),
                     locale)
    comms = case_management.list_communications(
        display_id, max_items=5, internal_id=c.internal_id or internal_id,
        account_id=account_id)
    head = i18n.t(
        "case.view.head_block", locale,
        subject=_escape_md(c.subject) or i18n.t("case.list.no_subject", locale),
        display_id=c.display_id,
        status=c.status,
        severity=severity_label(c.severity, locale),
        service=c.service_code,
        category=c.category_code,
        created=_short_date(c.created_at),
        submitter=(c.submitted_by
                   or i18n.t("case.list.unknown_submitter", locale)),
    )
    blocks = [head]
    if not comms:
        blocks.append(i18n.t("case.view.no_replies", locale))
    else:
        blocks.append(_bold(i18n.t("case.view.recent_replies_header", locale,
                                   count=len(comms))))
        blocks.extend(_reply_block(cm, locale) for cm in comms)
    if c.case_url:
        blocks.append(f"[{i18n.t('case.view.btn.open_console', locale)}]"
                      f"({c.case_url})")
    return _send(dt_messages.titled_text(
        i18n.t("case.view.title", locale, display_id=c.display_id),
        _compose(banner, *blocks), locale))


def _reply_block(cm: Communication, locale: str) -> str:
    who = (i18n.t("case.view.who_aws", locale) if cm.is_aws
           else i18n.t("case.view.who_customer", locale,
                       name=(cm.submitted_by
                             or i18n.t("case.view.who_customer_default",
                                       locale))))
    return i18n.t("case.view.reply_block", locale, who=who,
                  ts=_short_date(cm.submitted_at),
                  body=_escape_md(_trim(cm.body, 800)))


def start_analyze(display_id: str, *, locale: str = "zh",
                  account_id: str = "") -> bool:
    """LLM 案例分析。对位飞书 `start_analyze` + `_analyze_card`。

    ⚠️ 这是案例这条路上**唯一烧 token** 的一步（`core.case_analyze` 打 Bedrock），
    且只在用户明确说「分析」时才走 —— 与另外两家同口径。
    """
    locale = _normalize_locale(locale)
    if not display_id:
        return start_list(locale=locale, account_id=account_id)
    banner = _account_banner(account_id, locale)
    # 先回一句"正在分析" —— describe + Bedrock 合起来 5~15 秒，钉钉这边没有
    # "卡片原地刷新"，所以这条是独立一条消息（§4.4）。
    _send(dt_messages.text_message(
        i18n.t("case.analyze.toast.starting", locale, display_id=display_id),
        locale))
    result = case_analyze.analyze(display_id, locale=locale,
                                  account_id=account_id)
    if result.error == "case_not_found":
        return _info(i18n.t("case.view.not_found_title", locale),
                     _compose(banner,
                              i18n.t("case.analyze.error.case_not_found",
                                     locale, display_id=display_id)),
                     locale)
    if result.error:
        return _info(i18n.t("case.analyze.title", locale,
                            display_id=display_id),
                     _compose(banner,
                              i18n.t("case.analyze.error.llm_failed", locale,
                                     detail=result.error)),
                     locale)
    return _send(dt_messages.titled_text(
        i18n.t("case.analyze.title", locale, display_id=display_id),
        _compose(banner, *_analyze_blocks(result, locale)), locale))


def _analyze_blocks(result: case_analyze.AnalyzeResult,
                    locale: str) -> list[str]:
    """分析报告的正文段。与飞书 `_analyze_card` 的段落顺序 / 文案 key 逐字对齐。"""
    c = result.case_summary
    blocks: list[str] = []
    if c is not None:
        blocks.append(i18n.t(
            "case.analyze.subject_meta", locale,
            subject=(_escape_md(c.subject)
                     or i18n.t("case.list.no_subject", locale)),
            severity=severity_label(c.severity, locale),
            service=c.service_code or "—",
            status=c.status or "—",
            comm_count=result.comm_count,
        ))

    def _section(header_key: str, body: str) -> None:
        if not body:
            return
        blocks.append(_bold(i18n.t(header_key, locale)))
        blocks.append(_escape_md(body))

    def _bullets(header_key: str, items: list[str]) -> None:
        if not items:
            return
        blocks.append(_bold(i18n.t(header_key, locale)))
        blocks.append("\n".join(f"- {_escape_md(it)}" for it in items))

    _section("case.analyze.section.summary", result.summary)
    _section("case.analyze.section.root_cause", result.root_cause)
    _section("case.analyze.section.aws_progress", result.aws_progress)
    _bullets("case.analyze.section.next_steps", result.next_steps)
    _bullets("case.analyze.section.info_to_provide", result.info_to_provide)
    if result.suggested_reply:
        blocks.append(_bold(i18n.t("case.analyze.section.suggested_reply",
                                   locale)))
        # 引用块，好让用户一眼看出这是"可以照抄的模板"。与飞书同处理。
        blocks.append("\n".join(
            "> " + ln for ln in _escape_md(result.suggested_reply).split("\n")))
    return blocks


# ===========================================================================
# 入口：回复（写操作，但**不需要**二次确认）
# ===========================================================================
def start_reply(display_id: str, raw_text: str, *, internal_id: str = "",
                locale: str = "zh", account_id: str = "") -> bool:
    """给案例追加一条回复。

    为什么这个写操作不走二次确认：用户打的就是
    `/案例 回复 12345 <正文>` —— 正文已经在那句话里了，再让他回一句「确认」是
    纯噪音。而开案例/关案例的参数是我们**推断**出来的（主题、严重等级、目标账号），
    那才需要给他看一眼。
    """
    locale = _normalize_locale(locale)
    if not display_id:
        return start_list(locale=locale, account_id=account_id)
    banner = _account_banner(account_id, locale)
    body = _extract_reply_body(raw_text, display_id)
    if not body:
        # 只给了案例号没给正文 → 当成"看一眼这个案例"，而不是回一句"参数不对"。
        return start_view(display_id, internal_id=internal_id, locale=locale,
                         account_id=account_id)
    ok = case_management.add_communication(
        display_id, body, internal_id=internal_id, account_id=account_id)
    if ok:
        return _info(i18n.t("case.reply.success_title", locale),
                     _compose(banner,
                              _bold(i18n.t("case.reply.success_block_short",
                                           locale, display_id=display_id)),
                              f"> {_escape_md(_trim(body, 800))}"),
                     locale)
    return _info(i18n.t("case.reply.fail_title", locale),
                 _compose(banner,
                          _bold(i18n.t("case.reply.fail_block_short", locale,
                                       display_id=display_id))),
                 locale)


def _extract_reply_body(text: str, display_id: str) -> str:
    """`回复 12345 <正文>` → `<正文>`。与飞书 `_extract_reply_body` 同口径
    （含那条"短于 4 个字符就当没给"的判据 —— 那通常是标点残留）。"""
    if not text or not display_id:
        return ""
    idx = text.find(display_id)
    if idx < 0:
        return ""
    rest = text[idx + len(display_id):].strip(" \t\n\r:,.，。")
    return rest if len(rest) >= 4 else ""


# ===========================================================================
# 入口：关闭案例（需要二次确认）
# ===========================================================================
def start_resolve(display_id: str, *, internal_id: str = "",
                  chat_id: str = "", user_id: str = "",
                  locale: str = "zh", account_id: str = "") -> bool:
    """把"关闭案例"存成待确认动作，回一条确认提示。**不在这里真的关。**"""
    locale = _normalize_locale(locale)
    if not display_id:
        return start_list(locale=locale, account_id=account_id)
    if not chat_id or not user_id:
        # 拿不到会话/用户就存不了草稿，也就无法二次确认 → 宁可不做这个写操作。
        # （正常路径上 `lambda_worker` 一定给得出这两个值。）
        logger.warning("dingtalk case resolve: missing chat/user — refusing")
        return _info(i18n.t("case.resolve.error_title", locale),
                     i18n.t("im.dt.case.draft_expired", locale), locale)
    _put_pending(chat_id, user_id, {
        "op": "resolve",
        "display_id": display_id,
        "internal_id": internal_id,
        "account_id": account_id,
        "locale": locale,
        "token": str(int(time.time())),
    })
    return _info(i18n.t("case.resolve.confirm_title", locale),
                 _compose(_account_banner(account_id, locale),
                          i18n.t("case.resolve.confirm_body", locale,
                                 display_id=display_id),
                          i18n.t("im.dt.case.draft_hint", locale)),
                 locale)


def _execute_resolve(data: dict, *, chat_id: str, user_id: str) -> bool:
    locale = _normalize_locale(data.get("locale"))
    display_id = data.get("display_id", "")
    account_id = data.get("account_id", "") or ""
    banner = _account_banner(account_id, locale)
    if not support_logic.claim_inflight(
            f"dingtalk_resolve:{chat_id}:{user_id}:{data.get('token', '')}"):
        return _send(dt_messages.text_message(
            i18n.t("case.create.processing_short", locale), locale))
    status = case_management.resolve_case(
        display_id, internal_id=data.get("internal_id", "") or None,
        account_id=account_id)
    if status:
        return _info(i18n.t("case.resolve.success_title", locale),
                     _compose(banner,
                              i18n.t("case.resolve.success_body", locale,
                                     display_id=display_id, status=status)),
                     locale)
    return _info(i18n.t("case.resolve.fail_title", locale),
                 _compose(banner,
                          i18n.t("case.resolve.fail_body", locale,
                                 display_id=display_id)),
                 locale)


# ===========================================================================
# 入口：开案例（需要二次确认）
# ===========================================================================
def start_create(raw_text: str, *, chat_id: str = "", user_id: str = "",
                 locale: str = "zh", account_id: str = "",
                 operator_name: str = "") -> bool:
    """把"开案例"存成草稿，回一条确认提示。**不在这里真的开。**

    发草稿**之前**先探一次目标账号能不能开工单
    （`support_logic.case_capability`，一次只读调用、0 token）—— 让用户回了
    「确认」才发现"这个账号是 Basic 计划"是最差的体验。与另外两家同判据。
    """
    locale = _normalize_locale(locale)
    cap = support_logic.case_capability(account_id)
    if not cap.get("ok"):
        return _cap_refusal(cap, account_id, locale)
    body_text, overrides, warnings = _parse_create_args(raw_text, locale)
    if not body_text:
        return _send(dt_messages.text_message(
            i18n.t("im.dt.case.usage", locale), locale))
    subject = nl_router.summarize_case_subject(body_text)
    if not subject:
        # 剪完是空的 = 用户只说了「开案例」这句意图，问题本身还没说。按
        # `core.nl_router.summarize_case_subject` 的契约，空串就是"让调用方去引导他
        # 补"—— **不许**回落成把原话当主题（`or _trim(body_text, 80)` 就是那个坑：
        # 会真开出一个 Subject 和正文都写着「开案例」的 AWS Support 案例，而那是
        # 对外可见的写操作）。另外两家的引导是表单里那个空着的输入框，钉钉没有表单
        # 弹窗 —— 所以引导做成一张**可复制的纯文本模版**：他改完整段发回来，由
        # `maybe_handle_form` 接住（0 token，全程不过模型）。
        return _send_create_form(locale=locale, account_id=account_id,
                                 chat_id=chat_id, user_id=user_id, cap=cap)
    if not chat_id or not user_id:
        logger.warning("dingtalk case create: missing chat/user — refusing")
        return _info(i18n.t("case.create.fail_title", locale, code="NoSession"),
                     i18n.t("im.dt.case.draft_expired", locale), locale)
    draft = _new_draft(
        subject=subject, body_text=body_text,
        severity=overrides.get("severity", DEFAULT_SEVERITY),
        language=overrides.get("language", DEFAULT_LANGUAGE),
        issue_type=overrides.get("issue_type", ""),
        service=overrides.get("service", ""),
        category=overrides.get("category", ""),
        account_id=account_id, operator_name=operator_name, locale=locale)
    _put_pending(chat_id, user_id, draft)
    return _send_draft(draft, warnings, locale)


def _cap_refusal(cap: dict, account_id: str, locale: str) -> bool:
    """目标账号开不了工单 → 一条说清成因和出路的消息。**不发草稿、不发模版。**

    失败文案统一走 `support_logic.failure_hint`（跨账号 / 缺写权限 / 缺只读权限 /
    无 Support 计划四种成因各有各的出路），别在调用点各维护一条 if 链。
    """
    code = cap.get("code") or "Unavailable"
    return _info(i18n.t("case.create.fail_title", locale, code=code),
                 _compose(_account_banner(account_id, locale),
                          support_logic.failure_hint(
                              support_logic.CaseResult(
                                  ok=False, error_code=code), locale)),
                 locale)


def _new_draft(*, subject: str, body_text: str, severity: str, language: str,
               issue_type: str, service: str, category: str, account_id: str,
               operator_name: str, locale: str) -> dict:
    """待确认的开案例草稿。**两条入口（一句话 / 模版）必须产出同一个形状** ——
    `_execute_create` 全靠这些 key 取值，漂一个就是静默丢参数。"""
    return {
        "op": "create",
        "subject": subject,
        "body": body_text,
        "severity": severity or DEFAULT_SEVERITY,
        "language": language or DEFAULT_LANGUAGE,
        "issue_type": issue_type,
        "service": service,
        "category": category,
        "account_id": account_id,
        "operator": operator_name,
        "locale": locale,
        "token": str(int(time.time())),
    }


def _send_draft(draft: dict, warnings: list[str], locale: str) -> bool:
    """草稿确认卡。回「确认」才真的开工单（判据在 `maybe_handle_confirm`）。"""
    return _send(dt_messages.titled_text(
        i18n.t("im.dt.case.draft_title", locale),
        _compose(
            _account_banner(draft.get("account_id", "") or "", locale),
            i18n.t("im.dt.case.draft_body", locale,
                   subject=_escape_md(draft.get("subject", "")),
                   severity=severity_label(draft.get("severity", ""), locale),
                   language=LANGUAGE_LABELS.get(draft.get("language", ""),
                                                draft.get("language", "")),
                   body=_escape_md(_trim(draft.get("body", ""),
                                         DRAFT_BODY_MAX))),
            _classification_hint(draft, locale),
            i18n.t("im.dt.case.draft_hint", locale) + "".join(warnings),
        ),
        locale))


def _classification_hint(draft: dict, locale: str) -> str:
    """用户自己指定的 service / category / issue_type 回显。

    只回显**他填了的**那几项：没填的由 `core.case_classifier` 在真正开单时决定，
    这里提前印一个猜测值反而是误导（而且要多烧一次分类）。
    """
    bits = []
    if draft.get("service"):
        bits.append(f"**Service** · {_escape_md(draft['service'])}")
    if draft.get("category"):
        bits.append(f"**Category** · {_escape_md(draft['category'])}")
    if draft.get("issue_type"):
        bits.append("**Issue Type** · "
                    + issue_type_label(draft["issue_type"], locale))
    return "\n".join(bits)


def _parse_create_args(raw_text: str,
                       locale: str) -> tuple[str, dict, list[str]]:
    """一句话 → `(正文, 参数覆盖, 警告列表)`。**确定性、0 token。**

    钉钉没有表单，所以面板里那几个下拉框退化成 `severity=high` 这种 ASCII k=v。
    认不出的值**必须说出来**（`im.dt.case.override_ignored`）—— 静默套默认值会让
    "我明明写了 urgent" 变成一个查不出来的 bug。

    `service` / `category` 是自由文本，这里不校验：`support_logic.create_case`
    会拿 AWS Support 的服务目录去匹配，匹配不上时结果卡上有专门的一句提醒
    （`case.create.service_unmatched_block`）—— 那才是权威判据。
    """
    text = (raw_text or "").strip()
    if not text:
        return "", {}, []
    overrides: dict[str, str] = {}
    warnings: list[str] = []

    def _take(m: re.Match) -> str:
        key = _OVERRIDE_ALIASES.get(m.group(1).lower(), "")
        value = m.group(2).strip().strip(",.;，。")
        if not key or not value:
            return ""
        low = value.lower()
        if key == "severity":
            if low in SEVERITY_CODES:
                overrides["severity"] = low
            else:
                warnings.append(i18n.t("im.dt.case.override_ignored", locale,
                                       field="severity", value=value))
        elif key == "language":
            if low in LANGUAGE_CODES:
                overrides["language"] = low
            else:
                warnings.append(i18n.t("im.dt.case.override_ignored", locale,
                                       field="language", value=value))
        elif key == "issue_type":
            if low in ISSUE_TYPE_CODES:
                overrides["issue_type"] = low
            else:
                warnings.append(i18n.t("im.dt.case.override_ignored", locale,
                                       field="type", value=value))
        else:
            overrides[key] = value
        # k=v 一律从正文里摘掉 —— 留着会进案例主题，AWS 工程师看到
        # "RDS 连接数暴涨 severity=high" 只会困惑。
        return ""

    body = _OVERRIDE_RE.sub(_take, text).strip()
    # 连续空格收拢：摘掉中间的 k=v 之后会留下双空格。
    body = re.sub(r"[ \t]{2,}", " ", body).strip(" \t\n:,，。")
    return body, overrides, warnings


# ===========================================================================
# 案例模版（复制 → 改 → 发回来）—— 钉钉版的"表单"
# ===========================================================================
# 钉钉弹不出表单，ActionCard 的按钮也回调不到我们（见文件头）。所以另外两家的
# 「create 表单 + 下拉框」在这里退化成一张**逐行的纯文本模版**：
#
#   用户说「开案例」 → 我们回模版（每项都带默认值和全部选项）
#   → 他复制、改、整段发回来 → `maybe_handle_form` 解析 → 照旧走确认卡
#   → 回「确认」才真的开工单。
#
# **全程 0 token**：渲染是拼字符串，解析是 `core.nl_router.parse_case_form`
# （确定性词表），选项来源是 AWS 只读 API + 进程内缓存。唯一可能烧 token 的是
# 「涉及服务」留了「自动」时那次分类；用户自己选了服务和案例类型的话，
# `support_logic.overrides_cover_classification` 会把那次也省掉。
#
# ⚠️ 本模块**不在** `scripts/lint_i18n.py` 的 CJK 允许清单里，所以这里一个中文
# 字面量都不许有：模版的**文案**全在 `core/i18n.py` 的 `im.dt.case.form.*`，
# 认回来用的**中文标签词表**在 `core.nl_router._CASE_FORM_LABELS`（那个模块在
# 允许清单里）。这里只剩数字↔code 的映射和默认值。

#: 一行里选项之间的分隔符。**不能是 `·`** —— 严重等级的标签本身长这样
#: （`中 · Normal`），我们要按 `·` 把它切成可以单独匹配的词。
_FORM_OPT_SEP = " / "

#: 「涉及服务」那一行的 0 号选项 = 不填，交给分类器。
_FORM_AUTO_NUM = "0"

#: 「留着不改就是自动」的那些词取自哪几个 i18n key（两个语种都收）。
_FORM_AUTO_KEYS = ("im.dt.case.form.service_auto", "im.dt.case.form.subject_auto")

#: 值里的括号提示从哪儿开始剪。与 `nl_router._CASE_FORM_HINT_RE` 同一个判据，
#: 但这里只用在**标题**上（且只用于"还是默认值吗"的判断，不改真正的取值）。
_FORM_PAREN_RE = re.compile(r"[(（]")


def _form_norm(s: str) -> str:
    """选项匹配用的归一化：去掉 markdown 噪声和句读，转小写。"""
    return (s or "").strip().strip("*`~ \t").strip("·、,，.。;；:：!！ ").lower()


def _form_label(field: str, locale: str) -> str:
    """模版某一行的标签。⚠️ 必须能被 `nl_router._CASE_FORM_LABELS` 认回来 ——
    `tests/test_dingtalk_case_form.py` 会逐个把这里渲染出来的标签喂回解析器。"""
    return i18n.t(f"im.dt.case.form.label.{field}", locale)


def _form_auto_words() -> frozenset[str]:
    """「自动」这类词 —— **两个语种一起收**，再加上 ASCII 的 `auto`。

    为什么不只收当前 locale：用户可能在中文模版上手打 `auto`，也可能群 locale
    被切过之后拿着上一张模版发回来。多收几个词的代价是零，认不出的代价是一次
    误判（把「自动」当成服务名去查目录）。
    """
    words = {"auto", _FORM_AUTO_NUM}
    for key in _FORM_AUTO_KEYS:
        for loc in ("zh", "en"):
            words.add(_form_norm(i18n.t(key, loc)))
    return frozenset(w for w in words if w)


def _enum_spec(pairs: list[tuple[str, str]], default_code: str) -> dict:
    """`[(code, 标签)]` → 印在括号里的选项串 + 默认序号 + 认回来的别名表。

    别名一次全收：序号（`2`）、API code（`normal`）、整个标签（`中 · Normal`）、
    标签按 `·` 切开的每个词（`中` / `Normal`）。同一个词落到两个 code 上就**整条
    丢掉** —— 宁可回一句"认不出，用了默认值"，也不能猜错严重等级。
    """
    hint_bits: list[str] = []
    aliases: dict[str, str] = {}
    dupes: set[str] = set()

    def _add(word: str, code: str) -> None:
        w = _form_norm(word)
        if not w:
            return
        if w in aliases and aliases[w] != code:
            dupes.add(w)
            return
        aliases[w] = code

    for i, (code, label) in enumerate(pairs, start=1):
        hint_bits.append(f"{i} {label}")
        _add(str(i), code)
        _add(code, code)
        _add(label, code)
        for tok in label.split("·"):
            _add(tok, code)
    for w in dupes:
        aliases.pop(w, None)
    codes = [c for c, _ in pairs]
    default = default_code if default_code in codes else (codes[0] if codes
                                                         else "")
    return {
        "hint": _FORM_OPT_SEP.join(hint_bits),
        "aliases": aliases,
        "default": default,
        "default_num": str(codes.index(default) + 1) if default in codes else "",
    }


def _severity_spec(locale: str, cap: dict) -> dict:
    """严重等级的选项。**清单跟着 support plan 走** ——
    `support_logic.plan_severities` 用的是探针那次 `DescribeSeverityLevels` 的结果：
    Basic / Developer 计划没有 `urgent` / `critical`，印出来让客户选、他一选就被
    AWS 拒，是最难查的一类失败。探不到就回全部五档（历史行为）。
    """
    return _enum_spec([(c, severity_label(c, locale))
                       for c in support_logic.plan_severities(cap)],
                      DEFAULT_SEVERITY)


def _language_spec(locale: str) -> dict:
    """回复语言的选项。默认值 = **当前群的 locale**（英文群默认 English），
    locale 不在 `LANGUAGE_CODES` 里才退回 `DEFAULT_LANGUAGE`。"""
    return _enum_spec(
        [(c, i18n.t(f"im.dt.case.form.lang.{c}", locale))
         for c in LANGUAGE_CODES],
        locale if locale in LANGUAGE_CODES else DEFAULT_LANGUAGE)


def _issue_type_spec(locale: str) -> dict:
    return _enum_spec([(c, issue_type_label(c, locale))
                       for c in ISSUE_TYPE_CODES], DEFAULT_ISSUE_TYPE)


def _service_spec(locale: str) -> dict:
    """「涉及服务」那一行：`0 自动判断 / 1 ec2 / … / 20 opensearch`。

    印的是 `case_classifier.popular_service_choices()` 里的**短查询词**（`ec2`），
    不是目录全名（`Amazon Elastic Compute Cloud (EC2) - Linux`）—— 一行 20 个全名
    没人看得完，而短词照样能被 `resolve_service` 认回来。目录读不到时清单是空的，
    那一行就只剩 0 号选项（此时任何 >0 的数字都会被明确警告，不会静默）。
    """
    choices = case_classifier.popular_service_choices()
    bits = [f"{_FORM_AUTO_NUM} {i18n.t('im.dt.case.form.service_auto', locale)}"]
    bits += [f"{i} {c['query']}" for i, c in enumerate(choices, start=1)]
    return {
        "hint": (_FORM_OPT_SEP.join(bits) + "; "
                 + i18n.t("im.dt.case.form.service_freeform", locale)),
        "choices": choices,
    }


def _form_body(locale: str, cap: dict) -> str:
    """模版那六行。

    一项一行、**不手工折行** —— 钉钉会吃掉单个 `\\n`（`im_markdown.to_dingtalk`
    在相邻非空行之间插空行），手工折的行回来时是断开的两行，解析器只会把后半截
    当正文。所以哪怕「涉及服务」那一行有 20 个选项，也必须待在同一行里。
    """
    sev = _severity_spec(locale, cap)
    lang = _language_spec(locale)
    itype = _issue_type_spec(locale)
    svc = _service_spec(locale)
    return "\n".join([
        f"{_form_label('description', locale)}:",
        f"{_form_label('severity', locale)}: "
        f"{sev['default_num']}  ({sev['hint']})",
        f"{_form_label('language', locale)}: "
        f"{lang['default_num']}  ({lang['hint']})",
        f"{_form_label('issue_type', locale)}: "
        f"{itype['default_num']}  ({itype['hint']})",
        f"{_form_label('service', locale)}: "
        f"{_FORM_AUTO_NUM}  ({svc['hint']})",
        f"{_form_label('subject', locale)}: "
        f"{i18n.t('im.dt.case.form.subject_auto', locale)}  "
        f"({i18n.t('im.dt.case.form.subject_hint', locale)})",
    ])


def _send_create_form(*, locale: str, account_id: str = "", chat_id: str = "",
                      user_id: str = "", cap: dict | None = None,
                      prefix: str = "") -> bool:
    """发那张模版，并在会话里留一个「刚发过模版」的标记。

    `prefix` 是模版**前面**加的一句（目前只有一种：收回来但问题描述还是空的）。
    标记只影响"只改了问题描述一行"这一种回填的识别，见 `maybe_handle_form`；
    拿不到 chat/user 时照样发模版 —— 它是只读的，没有标记只是判据严一点。
    """
    locale = _normalize_locale(locale)
    if cap is None:
        cap = support_logic.case_capability(account_id)
    body = _compose(
        _account_banner(account_id, locale),
        prefix,
        i18n.t("im.dt.case.form.instruction", locale),
        _form_body(locale, cap),
        i18n.t("im.dt.case.form.footer", locale),
    )
    if chat_id and user_id:
        ddb_state.put_convo_session(
            PLATFORM, chat_id, user_id, CONVO_FORM_KIND,
            {"op": "form", "locale": locale, "account_id": account_id,
             "token": str(int(time.time()))})
    return _send(dt_messages.titled_text(
        i18n.t("im.dt.case.form.title", locale), body, locale))


def _form_boilerplate() -> tuple[str, ...]:
    """模版里**我们自己那几行**的原文（两个语种都要）。

    用户把整张模版原样发回来时这几行会跟着回来。传给
    `nl_router.parse_case_form(boilerplate=…)` 剔掉 —— 那边只对**认不出标签**的行
    生效，所以真正的字段行（用户一项没改时与模版逐字相同）不受影响。
    不剔的后果：AWS 工程师会在案例正文里读到「发回来后我先给你一张确认卡」。
    """
    keys = ("im.dt.case.form.footer", "im.dt.case.form.instruction",
            "im.dt.case.form.need_description", "im.dt.case.form.title")
    out: list[str] = []
    for key in keys:
        for loc in ("zh", "en"):
            out.extend(ln for ln in i18n.t(key, loc).splitlines() if ln.strip())
    return tuple(out)


def _pick_enum(raw: str, spec: dict, *, label: str, locale: str,
               warnings: list[str]) -> str:
    """模版里一个枚举项的值 → API code。认不出就**说出来**并用默认值。

    值留空 = 用户把那一项删了 → 静默用默认值（他表达的是"我不关心这项"）；
    值填了但认不出（`严重等级: 特别急`）→ 必须警告，否则"我明明选了紧急"会变成
    一个查不出来的 bug。
    """
    v = _form_norm(raw)
    if not v:
        return spec["default"]
    code = spec["aliases"].get(v)
    if code:
        return code
    warnings.append(i18n.t("im.dt.case.override_ignored", locale,
                           field=label, value=_trim((raw or "").strip(), 40)))
    return spec["default"]


def _read_service(raw: str, spec: dict, *, locale: str,
                  warnings: list[str]) -> str:
    """「涉及服务」的值 → 喂给 `create_case(service_text=…)` 的文本。

    回 `""` = 交给 `core.case_classifier` 自动判（0 号选项 / 空 / 「自动」）。
    数字按清单还原成短查询词；超出清单范围要警告（清单是运行时算的，可能比他
    手上那张模版短 —— 静默落到别的服务上就是开错队列）。其它一律**原样透传**：
    自由填的服务名由 `resolve_service` 去匹配，匹配不上时结果卡上有专门一句提醒。
    """
    v = (raw or "").strip().strip("*` ")
    if not v or _form_norm(v) in _form_auto_words():
        return ""
    if v.isdigit():
        choices = spec["choices"]
        n = int(v)
        if 1 <= n <= len(choices):
            return choices[n - 1]["query"]
        warnings.append(i18n.t("im.dt.case.override_ignored", locale,
                               field=_form_label("service", locale), value=v))
        return ""
    return v


def _read_subject(raw: str, description: str) -> str:
    """「标题」的值 → 真正的案例主题。留「自动」/ 留空 → 按问题描述生成。

    判"还是默认值吗"只看**第一个左括号之前**那一截：没改的话整行是
    `自动  (留「自动」= 按你的描述生成)`；而 `RDS (Aurora) 连不上` 是用户自己的
    标题，必须整条留下 —— 所以只拿括号前那截做判断，返回的是**原值**。
    """
    v = (raw or "").strip().strip("*` ")
    head = _FORM_PAREN_RE.split(v, maxsplit=1)[0].strip()
    if not head or _form_norm(head) in _form_auto_words():
        return nl_router.summarize_case_subject(description)
    return v[:nl_router.CASE_SUBJECT_MAX]


def maybe_handle_form(*, chat_id: str, user_id: str, text: str,
                      locale: str = "zh", account_id: str = "",
                      operator_name: str = "") -> bool:
    """用户这一句是不是**填好的案例模版**？是就建草稿并回确认卡，回 True。

    **返回 False = 请继续走 `router.dispatch`。** 与 `maybe_handle_confirm` 一样，
    这是正常路由**之前**的一道岔口，所以判据必须窄，否则会吞掉正常对话：

      · 必须有「问题描述」那一行 —— 模版一定有它（哪怕值是空的），
        而它也是唯一的必填项；
      · 且标签行数 ≥ `nl_router.CASE_FORM_MIN_LABELS`。单独一句
        「问题: 打不开」是日常问句，不是模版；
      · 只有「问题描述」一行时，额外要求会话里有「我刚发过模版」的标记
        （用户把其它几行都删了，那也是回填）。

    账号轴取**当前**的 `account_id`（不是发模版时那个）：与 `开案例 xxx` 一句话
    那条路一致 —— 用户中途 `/account` 切过去，就该开在切过去的那个号上。
    """
    if not (text or "").strip():
        return False
    locale = _normalize_locale(locale)
    parsed = nl_router.parse_case_form(text,
                                       boilerplate=_form_boilerplate())
    if "description" not in parsed["fields"]:
        return False
    if (parsed["labels"] < nl_router.CASE_FORM_MIN_LABELS
            and not _has_form_marker(chat_id, user_id)):
        return False
    logger.info("worker: case form detected (labels=%d, extra=%d)",
                parsed["labels"], len(parsed["extra"]))
    return _handle_form(parsed, chat_id=chat_id, user_id=user_id,
                        locale=locale, account_id=account_id,
                        operator_name=operator_name)


def _has_form_marker(chat_id: str, user_id: str) -> bool:
    if not chat_id or not user_id:
        return False
    return bool(ddb_state.get_convo_session(PLATFORM, chat_id, user_id,
                                            CONVO_FORM_KIND))


def _handle_form(parsed: dict, *, chat_id: str, user_id: str, locale: str,
                 account_id: str, operator_name: str) -> bool:
    """填好的模版 → 草稿确认卡。**这里不开工单**，回「确认」才开。"""
    fields = parsed["fields"]
    warnings: list[str] = []
    cap = support_logic.case_capability(account_id)
    if not cap.get("ok"):
        # 与 `start_create` 同判据：这个账号这条路从头到尾不通，就别让他再改一遍模版。
        return _cap_refusal(cap, account_id, locale)
    # 问题描述那一行的值 + 后面所有认不出标签的行。模版明写了"可以换行多写几段"，
    # 而绝大多数人是在 `问题描述:` 下面另起一行写的 —— 那些行都在 `extra` 里。
    description = "\n".join(
        [fields.get("description", "").strip()] + list(parsed["extra"])).strip()
    if not description:
        return _send_create_form(
            locale=locale, account_id=account_id, chat_id=chat_id,
            user_id=user_id, cap=cap,
            prefix=i18n.t("im.dt.case.form.need_description", locale))
    subject = _read_subject(fields.get("subject", ""), description)
    if not subject:
        # 描述本身只是一句「开案例」——`summarize_case_subject` 剪完是空的。
        # **绝不**回落成拿原话当主题（会开出一个标题写着「开案例」的对外案例）。
        return _send_create_form(
            locale=locale, account_id=account_id, chat_id=chat_id,
            user_id=user_id, cap=cap,
            prefix=i18n.t("im.dt.case.form.need_description", locale))
    if not chat_id or not user_id:
        logger.warning("dingtalk case form: missing chat/user — refusing")
        return _info(i18n.t("case.create.fail_title", locale, code="NoSession"),
                     i18n.t("im.dt.case.draft_expired", locale), locale)
    draft = _new_draft(
        subject=subject, body_text=description,
        severity=_pick_enum(fields.get("severity", ""),
                            _severity_spec(locale, cap),
                            label=_form_label("severity", locale),
                            locale=locale, warnings=warnings),
        language=_pick_enum(fields.get("language", ""), _language_spec(locale),
                            label=_form_label("language", locale),
                            locale=locale, warnings=warnings),
        issue_type=_pick_enum(fields.get("issue_type", ""),
                              _issue_type_spec(locale),
                              label=_form_label("issue_type", locale),
                              locale=locale, warnings=warnings),
        service=_read_service(fields.get("service", ""), _service_spec(locale),
                              locale=locale, warnings=warnings),
        # 模版里没有「类别」那一栏：它必须在**已定下来的服务**名下反查，多一栏
        # 让人手打只会填出匹配不上的值（`apply_case_overrides` 会退回通用类别）。
        category="",
        account_id=account_id, operator_name=operator_name, locale=locale)
    _put_pending(chat_id, user_id, draft)
    # 模版这一轮走完了：标记清掉，免得他下一句随口说「问题: 还有个事」又被当成回填。
    ddb_state.clear_convo_session(PLATFORM, chat_id, user_id, CONVO_FORM_KIND)
    return _send_draft(draft, warnings, locale)


def _execute_create(data: dict, *, chat_id: str, user_id: str) -> bool:
    locale = _normalize_locale(data.get("locale"))
    account_id = data.get("account_id", "") or ""
    banner = _account_banner(account_id, locale)
    severity = data.get("severity") or DEFAULT_SEVERITY
    language = data.get("language") or DEFAULT_LANGUAGE
    subject = data.get("subject", "")
    body_text = data.get("body", "")
    # 重复点击 / 重复投递保护。key 里带 draft token：同一张草稿只开一次，但用户
    # 稍后**另开**一张不会被这把锁挡住。
    if not support_logic.claim_inflight(
            f"dingtalk_create:{chat_id}:{user_id}:{data.get('token', '')}"):
        return _send(dt_messages.text_message(
            i18n.t("case.create.processing_short", locale), locale))
    _send(dt_messages.text_message(
        i18n.t("case.create.creating_status", locale,
               severity=severity_label(severity, locale),
               language=LANGUAGE_LABELS.get(language, language)), locale))
    # ctx 的形状与 Slack / 飞书**逐字一致**（`support_logic.build_subject` /
    # `build_body` 认这些 key）。钉钉这条路上没有调查上下文，所以那几个 id 全空 ——
    # 别去掉它们：`build_body` 用 `ctx.get(...)`，缺 key 和空串等价，但显式写出来
    # 才能看出"这条路本来就没有报告链接"，而不是"忘了传"。
    ctx = {
        "intent_summary": subject,
        "raw_text": body_text,
        "summary_md": body_text,
        "incident_id": "",
        "task_id": "",
        "agent_space_id": "",
        "execution_id": "",
        "report_url": "",
        "trace_url": "",
    }
    try:
        result = support_logic.create_case(
            ctx, platform=PLATFORM, severity=severity, language=language,
            extra="", operator_name=data.get("operator", "") or "",
            service_text=data.get("service", ""),
            issue_type=data.get("issue_type", "") or DEFAULT_ISSUE_TYPE,
            category_text=data.get("category", ""),
            account_id=account_id)
    except Exception as e:  # noqa: BLE001
        # 绝不静默：用户刚回了「确认」，没有回音等于"我不知道案例开了没有"。
        logger.exception("dingtalk create_case crashed: %s", type(e).__name__)
        return _info(i18n.t("case.create.fail_title", locale, code="Internal"),
                     _compose(banner,
                              _bold(i18n.t("case.create.internal_error_block",
                                           locale, kind=type(e).__name__))),
                     locale)
    if not result.ok:
        code = result.error_code or "Error"
        return _info(i18n.t("case.create.fail_title", locale, code=code),
                     _compose(banner,
                              support_logic.failure_hint(result, locale)),
                     locale)
    return _send(dt_messages.titled_text(
        i18n.t("case.create.success_title", locale),
        _compose(banner, *_create_success_blocks(result, severity, language,
                                                 subject, locale)),
        locale))


def _create_success_blocks(result: support_logic.CaseResult, severity: str,
                           language: str, subject: str,
                           locale: str) -> list[str]:
    """成功卡的正文段。

    ⚠️ 用的是**飞书那一套** key（`case.create.case_id_block` /
    `subject_block` / `case_link_block` / `severity_field` /
    `classification_block`），**不是** `case.create.success_block` —— 后者是
    Slack 口味的（`<url|text>` 链接 + 单星粗体），在钉钉里会把链接显示成一串
    尖括号。
    """
    cls = result.classification or {}
    blocks: list[str] = []
    head = i18n.t("case.create.case_id_block", locale,
                  display_id=result.display_id)
    if subject.strip():
        head += i18n.t("case.create.subject_block", locale,
                       subject=_escape_md(subject.strip()))
    if result.case_url:
        head += "\n\n" + i18n.t("case.create.case_link_block", locale,
                                url=result.case_url)
    blocks.append(head)

    meta = i18n.t("case.create.severity_field", locale,
                  severity=severity_label(severity, locale),
                  language=LANGUAGE_LABELS.get(language, language))
    if cls.get("serviceCode") or cls.get("categoryCode"):
        meta += i18n.t("case.create.classification_block", locale,
                       service=cls.get("serviceCode", ""),
                       category=support_logic.category_display(cls, locale),
                       issue_type=issue_type_label(cls.get("issueType", ""),
                                                   locale))
    # 用户填了服务名/类别但目录里没有 → **必须说出来**。静默忽略最坑：用户以为
    # 自己指定了服务，案例却落在分类器挑的那条上。
    if cls.get("serviceUnmatched"):
        meta += i18n.t("case.create.service_unmatched_block", locale,
                       text=str(cls["serviceUnmatched"]))
    if cls.get("categoryUnmatched"):
        meta += i18n.t("case.create.category_unmatched_block", locale,
                       text=str(cls["categoryUnmatched"]),
                       service=cls.get("serviceCode", ""),
                       category=cls.get("categoryCode", ""))
    meta += "\n\n" + i18n.t("case.create.support_will_reply", locale)
    blocks.append(meta)
    return blocks


# ===========================================================================
# 二次确认
# ===========================================================================
def _put_pending(chat_id: str, user_id: str, data: dict) -> None:
    """存待确认动作。**覆盖**上一个 —— `put_convo_session` 是替换语义，而这正是
    我们要的：用户重发一次草稿，确认的就该是新那一张。"""
    ddb_state.put_convo_session(PLATFORM, chat_id, user_id, CONVO_KIND, data)


def maybe_handle_confirm(*, chat_id: str, user_id: str, text: str,
                         locale: str = "zh") -> bool:
    """用户这一句是不是在确认/取消一个待确认动作？处理了就回 True。

    **返回 False = 请继续走 `router.dispatch`。** 这个函数是
    `lambda_worker` 在正常路由**之前**的一道岔口，所以"没有待确认动作"和
    "有，但这句话不是确认也不是取消"都必须回 False —— 否则用户在等确认的
    30 分钟里问什么都会被这里吞掉。

    判据来自 `core.nl_router.CONFIRM_WORDS` / `CANCEL_WORDS`：**整句完全等于**
    其中一个词才算。为什么不做包含匹配：「确认一下这个实例的配置」里有"确认"
    两个字，包含匹配会把它当成"开案例吧"。
    """
    locale = _normalize_locale(locale)
    if not chat_id or not user_id:
        return False
    word = (text or "").strip().strip("!?。！？，,. \t\n").lower()
    if not word:
        return False
    if word not in nl_router.CONFIRM_WORDS and word not in nl_router.CANCEL_WORDS:
        # 没到"要不要读 DDB"这一步就先排掉绝大多数消息 —— 每条消息都去 GetItem
        # 是一笔白花的延迟。
        return False
    data = ddb_state.get_convo_session(PLATFORM, chat_id, user_id, CONVO_KIND)
    if not data:
        # 有意**不**回 `draft_expired`：这条路上"没有待确认动作"最常见的成因是
        # 用户只是在对话里说了句「好的」。回一句"没有待确认的操作"是纯噪音。
        # 真正需要那句文案的是"确认到了但草稿过期"—— 而过期的草稿在这里读不到，
        # 与"从来没有"无法区分，所以两者一起落回 `router.dispatch`（chat）。
        return False
    # 先清掉再执行：重复投递 / 用户连点两次「确认」时，第二次读不到草稿就落回
    # chat，而不是开出第二张工单。真正的幂等还有 `claim_inflight` 兜底。
    ddb_state.clear_convo_session(PLATFORM, chat_id, user_id, CONVO_KIND)
    if word in nl_router.CANCEL_WORDS:
        _send(dt_messages.text_message(
            i18n.t("im.dt.case.cancelled", locale), locale))
        return True
    op = data.get("op", "")
    try:
        if op == "create":
            _execute_create(data, chat_id=chat_id, user_id=user_id)
        elif op == "resolve":
            _execute_resolve(data, chat_id=chat_id, user_id=user_id)
        else:
            logger.warning("dingtalk confirm: unknown pending op %r", op)
            _send(dt_messages.text_message(
                i18n.t("im.dt.case.draft_expired", locale), locale))
    except Exception as e:  # noqa: BLE001
        logger.exception("dingtalk confirm op=%s failed: %s", op,
                         type(e).__name__)
        _send(dt_messages.text_message(
            i18n.t("main.case_flow_crashed", locale, kind=type(e).__name__),
            locale))
    return True


__all__ = [
    "CONVO_FORM_KIND",
    "CONVO_KIND",
    "maybe_handle_confirm",
    "maybe_handle_form",
    "start_analyze",
    "start_create",
    "start_list",
    "start_reply",
    "start_resolve",
    "start_view",
]
