"""
Slack UI for AWS Support case management.

Mirrors platforms/feishu/app/case_flow.py — same business logic
(`core.case_management` + `core.support_logic`), Slack-native UX:

  Entry points (called from main on natural-language commands):
    start_create(client, channel, raw_text, user, thread_ts, locale)
    start_list(client, channel, thread_ts, status_filter, locale)
    start_view(client, channel, thread_ts, display_id, locale)
    start_reply(client, channel, thread_ts, display_id, raw_text, user, locale)
    start_resolve(client, channel, thread_ts, display_id, locale)

  Action callbacks (button clicks):
    case_view              → render detail message in thread
    case_list_open / case_list_filter → re-render list with new filter
    case_reply_form        → open reply modal
    case_resolve_confirm   → open confirm-resolve modal
    case_resolve_yes/no    → callbacks from confirm modal
    case_create_dispatch_after → start an investigation for an
                                 already-created case

  View submissions:
    case_create_view       → CreateCase (+ optional dispatch) call
    case_reply_view        → AddCommunicationToCase call

Bilingual (zh + en) end-to-end via core.i18n.t(). The conversation
locale rides through as the `locale` parameter on every entry point;
button-action callbacks read it back from the convo row in DDB. Slack's
default user-facing locale here is "en" because the Slack workspace
this bot ships into is English by default — feishu defaults to "zh".

多账号（2026-09-07）：每个入口点都收一个 `account_id`（空 = 部署账号 = 历史
行为），一路透传给 `core.case_management` / `core.support_logic` /
`core.case_analyze`；每条消息的按钮 `value` 与每个 modal 的 `private_metadata`
都把它「盖章」成 `case_account_id` 带回来。按钮点回来时**只认卡上那个章**，
不查当下会话选的账号 —— 用户可能在点之前又切了账号，而工单只在原账号里存在，
拿当下的偏好去 AddCommunication / ResolveCase 就是往另一个账号里写。
本次改动之前渲染的老消息没有这个字段 → 空 = 部署账号，而那正是它们当年唯一
可能的归属，所以缺省值天然正确。与飞书侧
`platforms/feishu/app/case_flow.py` 逐项对位。
"""
from __future__ import annotations

import json as _json
import logging
import threading

from core import case_analyze
from core import case_classifier
from core import case_management
from core import ddb_state
from core import i18n
from core import im_accounts
from core import support_logic
from core import webhook_dispatch  # noqa: F401 — reserved for future skill paths
from core.case_management import CaseSummary, Communication
from core.support_logic import (
    DEFAULT_ISSUE_TYPE, DEFAULT_LANGUAGE, DEFAULT_SEVERITY,
    ISSUE_TYPE_CODES,
    LANGUAGE_CODES, LANGUAGE_LABELS,
    SEVERITY_CODES,
    issue_type_label,
    issue_type_labels,
    severity_label,
    severity_labels,
)

from platforms.common import account_picker
from platforms.slack.app import blocks

logger = logging.getLogger(__name__)
PLATFORM = "slack"


def _normalize_locale(locale: str | None) -> str:
    """Bound `locale` to the supported set. Slack defaults to en."""
    loc = (locale or "en").strip().lower()
    return loc if loc in {"zh", "en"} else "en"


def _filter_label(slug: str, locale: str) -> str:
    """Localized human label for a status_filter slug."""
    key = f"case.list.filter.{slug}"
    return i18n.t(key, locale)


_FILTER_BUTTON_SLUGS = ("recent", "pending_customer", "unresolved",
                        "work_in_progress", "resolved")


def _account_banner_blocks(account_id: str, locale: str) -> list[dict]:
    """消息顶上那条「🏷️ Account: 123456789012」。**总是**报账号（2026-09-07 起）。

    返回 0 或 1 个元素的列表，好让调用方 `*_account_banner_blocks(...)` 直接
    展开 —— 与飞书侧 `_account_banner` 同一套语义（同两个 i18n key、同一条"两个号
    都拿不到就整条不显示"的规矩），只是渲染成 Slack 的 context 块。为什么从"只在成员
    账号时出现"改成"总是出现"，见飞书那份 docstring：开案例是唯一的写操作，而"没有
    横幅"原来同时代表"开在部署账号"和"目标账号丢了"两件事。
    """
    acct = (account_id or "").strip()
    deploy = im_accounts.deploy_account_id()
    if not acct or acct == deploy:
        if not deploy:
            return []
        return [blocks.context(i18n.t("case.account_banner_deploy", locale,
                                      account=deploy))]
    return [blocks.context(i18n.t("case.account_banner", locale,
                                  account=acct))]


# ===========================================================================
# Entry points (called from main.py on natural-language commands)
# ===========================================================================
def start_create(client, channel_id: str, raw_text: str,
                 user_id: str, thread_ts: str, locale: str = "en",
                 account_id: str = "") -> None:
    """Open the create-case modal. We need a trigger_id, but @mentions
    don't supply one — fall back to posting a button into the thread that
    the user clicks to open the modal.

    `account_id`（空 = 部署账号）：工单开在哪个账号下，由 `/account` 决定。
    发这颗按钮**之前**先探一次那个账号能不能开工单
    （`support_logic.case_capability`，0 token 的一次只读调用）—— 让客户点开
    表单、填完整张表才发现"这个账号是 Basic 计划"是最差的体验。与飞书侧
    `platforms/feishu/app/case_flow.py::start_create` 同一套判据。
    """
    locale = _normalize_locale(locale)
    cap = support_logic.case_capability(account_id)
    if not cap.get("ok"):
        # 不发按钮：这个账号这条路从头到尾不通，给出确切原因和出路。失败文案统一
        # 走 `support_logic.failure_hint`，别在这里再维护一条 if 链。
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None,
            text=i18n.t("case.create.fail_text_short", locale),
            blocks=[blocks.section(
                i18n.t("case.create.fail_block", locale,
                       code=cap.get("code") or "Unavailable",
                       hint=blocks.escape_mrkdwn(support_logic.failure_hint(
                           support_logic.CaseResult(
                               ok=False, error_code=cap.get("code") or ""),
                           locale))))],
        )
        return
    initial_subject = _summarize_subject(raw_text)
    pm = _json.dumps({
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "initial_subject": initial_subject,
        "locale": locale,
        # 账号「章」：这颗按钮点回来时才真正打开表单，那时会话里选的账号可能已经
        # 换了，但用户点的是**这条**消息 —— 只认这个章。
        "case_account_id": account_id,
    }, ensure_ascii=False)

    # @mentions don't carry a trigger_id, so the modal can't open
    # immediately. Post a "Click to open form" button — clicking it
    # carries a trigger_id we can use.
    client.chat_postMessage(
        channel=channel_id, thread_ts=thread_ts or None,
        text=i18n.t("case.create.opener.fallback_text", locale),
        blocks=[
            blocks.section(i18n.t("case.create.opener.title", locale)),
            blocks.actions(
                blocks.button(
                    i18n.t("case.create.opener.btn", locale),
                    "case_create_open_form",
                    value=pm, style="danger"),
            ),
        ],
    )


def start_list(client, channel_id: str, thread_ts: str,
               status_filter: str = "recent",
               locale: str = "en", account_id: str = "") -> None:
    locale = _normalize_locale(locale)
    cases = case_management.list_recent_cases(after_days=90, max_items=5,
                                              status_filter=status_filter,
                                              account_id=account_id)
    blocks_out = _list_blocks(cases, status_filter, locale,
                              account_id=account_id)
    fallback = _filter_label(status_filter, locale) \
        if status_filter in _FILTER_BUTTON_SLUGS \
        else i18n.t("case.list.title_simple", locale)
    client.chat_postMessage(
        channel=channel_id, thread_ts=thread_ts or None,
        text=fallback,
        blocks=blocks_out,
    )


def start_view(client, channel_id: str, thread_ts: str,
               display_id: str, internal_id: str = "",
               locale: str = "en", account_id: str = "") -> None:
    locale = _normalize_locale(locale)
    if not display_id and not internal_id:
        start_list(client, channel_id, thread_ts, locale=locale,
                   account_id=account_id)
        return
    summary = case_management.describe_case(display_id,
                                            internal_id=internal_id or None,
                                            account_id=account_id)
    if not summary:
        # 「找不到」在跨账号时**必须把账号号念出来** —— 同号工单可以存在于另一个
        # 账号里，不写清用户会以为工单被删了。
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None,
            text=i18n.t("case.view.not_found_text_short", locale),
            blocks=[*_account_banner_blocks(account_id, locale),
                    blocks.section(
                        i18n.t("case.view.not_found_block_short", locale,
                               display_id=display_id))],
        )
        return
    comms = case_management.list_communications(
        display_id, max_items=5,
        internal_id=summary.internal_id or internal_id or None,
        account_id=account_id)
    client.chat_postMessage(
        channel=channel_id, thread_ts=thread_ts or None,
        text=i18n.t("case.view.title_short", locale, display_id=display_id),
        blocks=_view_blocks(summary, comms, locale, account_id=account_id),
    )


def start_reply(client, channel_id: str, thread_ts: str,
                display_id: str, raw_text: str, user_id: str,
                internal_id: str = "",
                locale: str = "en", account_id: str = "") -> None:
    locale = _normalize_locale(locale)
    if not display_id and not internal_id:
        start_list(client, channel_id, thread_ts, locale=locale,
                   account_id=account_id)
        return
    body = _extract_reply_body(raw_text, display_id) if display_id else ""
    if body and len(body) >= 4:
        ok = case_management.add_communication(display_id, body,
                                               internal_id=internal_id or None,
                                               account_id=account_id)
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None,
            text=(i18n.t("case.reply.success_text_short", locale) if ok
                  else i18n.t("case.reply.fail_text_short", locale)),
            blocks=_reply_result_blocks(display_id, body, ok, locale,
                                        account_id=account_id),
        )
        return
    # Need a modal — but again no trigger_id from @mention. Post a button.
    pm = _json.dumps({
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "display_id": display_id,
        "internal_id": internal_id,
        "locale": locale,
        # 账号「章」—— `internal_id` 是**账号内**唯一的（见
        # `core/case_management.py` 模块 docstring 口径 1），两者必须成对带回来。
        "case_account_id": account_id,
    }, ensure_ascii=False)
    client.chat_postMessage(
        channel=channel_id, thread_ts=thread_ts or None,
        text=i18n.t("case.reply.opener.fallback_text", locale,
                    display_id=display_id),
        blocks=[
            blocks.section(i18n.t("case.reply.opener.title", locale,
                                  display_id=display_id)),
            blocks.actions(
                blocks.button(
                    i18n.t("case.reply.opener.btn", locale),
                    "case_reply_open_form",
                    value=pm, style="primary"),
            ),
        ],
    )


def start_analyze(client, channel_id: str, thread_ts: str,
                   display_id: str, locale: str = "en",
                   account_id: str = "") -> None:
    """LLM-driven case analysis: fetch case + comms → Bedrock summary →
    render insight blocks. Posts a "Analyzing…" placeholder first to
    cover the 5-15s round-trip."""
    locale = _normalize_locale(locale)
    if not display_id:
        start_list(client, channel_id, thread_ts, locale=locale,
                   account_id=account_id)
        return

    # Placeholder while we wait for Bedrock
    try:
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None,
            text=i18n.t("case.analyze.toast.starting", locale,
                        display_id=display_id),
        )
    except Exception as e:
        logger.warning("case_analyze: starting placeholder send failed "
                       "(non-fatal): %s", e)

    result = case_analyze.analyze(display_id, locale=locale,
                                  account_id=account_id)

    if result.error == "case_not_found":
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None,
            text=i18n.t("case.view.not_found_text_short", locale),
            blocks=[*_account_banner_blocks(account_id, locale),
                    blocks.section(
                        i18n.t("case.analyze.error.case_not_found", locale,
                               display_id=display_id))],
        )
        return
    if result.error:
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None,
            text=i18n.t("case.analyze.title", locale, display_id=display_id),
            blocks=[blocks.section(
                i18n.t("case.analyze.error.llm_failed", locale,
                       detail=result.error))],
        )
        return

    client.chat_postMessage(
        channel=channel_id, thread_ts=thread_ts or None,
        text=i18n.t("case.analyze.title", locale, display_id=display_id),
        blocks=_analyze_blocks(result, locale=locale, account_id=account_id),
    )


def start_resolve(client, channel_id: str, thread_ts: str,
                  display_id: str, internal_id: str = "",
                  locale: str = "en", account_id: str = "") -> None:
    locale = _normalize_locale(locale)
    if not display_id and not internal_id:
        start_list(client, channel_id, thread_ts, locale=locale,
                   account_id=account_id)
        return
    pm = _json.dumps({
        "display_id": display_id,
        "internal_id": internal_id,
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "locale": locale,
        # 账号「章」—— 关工单是**写**操作，关错账号就是关了别人的工单。
        "case_account_id": account_id,
    }, ensure_ascii=False)
    client.chat_postMessage(
        channel=channel_id, thread_ts=thread_ts or None,
        text=i18n.t("case.resolve.opener.fallback_text", locale,
                    display_id=display_id),
        blocks=[
            *_account_banner_blocks(account_id, locale),
            blocks.section(i18n.t("case.resolve.opener.title", locale,
                                  display_id=display_id)),
            blocks.actions(
                blocks.button(i18n.t("case.resolve.btn.confirm", locale),
                              "case_resolve_yes",
                              value=pm, style="danger"),
                blocks.button(i18n.t("case.resolve.btn.cancel", locale),
                              "case_resolve_no", value=pm),
            ),
        ],
    )


# ===========================================================================
# Action router (called from main.on_case_action)
# ===========================================================================
def _locale_from_action(action_value: str) -> str:
    """Pull `locale` out of the JSON action payload, fall back to en."""
    try:
        v = _json.loads(action_value or "{}")
    except Exception:
        return "en"
    return _normalize_locale(v.get("locale"))


def _account_from_action(action_value: str) -> str:
    """Pull the account「章」(`case_account_id`) out of the JSON action payload.

    空 = 部署账号 —— 也正是本次改动之前所有已发出消息的情况，所以老按钮点回来
    仍然落在它们当年唯一可能的那个账号上。见模块 docstring 的多账号一节。
    """
    try:
        v = _json.loads(action_value or "{}")
    except Exception:
        return ""
    return str(v.get("case_account_id") or "")


def handle_action(action_id: str, body: dict, client) -> None:
    action_value = (body.get("actions") or [{}])[0].get("value", "")
    channel_id = (body.get("channel") or {}).get("id", "")
    thread_ts = ((body.get("message") or {}).get("thread_ts")
                 or (body.get("message") or {}).get("ts", ""))
    user_id = (body.get("user") or {}).get("id", "")
    trigger_id = body.get("trigger_id", "")
    # Slack requires unique action_ids per message, so we suffix list-row
    # buttons like `case_view:<display_id>`. Strip the suffix here so the
    # rest of the router can match against the canonical names.
    base_action = action_id.split(":", 1)[0]

    # 「同步到案例」的实现在 support_flow（它才有 support context 那套读写），
    # 但 `^case_` 的分流两条路径（`main.py` 长连接 / `lambda_worker.py` webhook）
    # 都先命中这里 —— 所以 support_flow 那个分支**在两条路径上都到不了**，按钮
    # 点了完全没反应、也不报错。在这里转发过去，两条路径一次修好、不产生行为差异。
    # 延迟 import：support_flow 在模块顶部 import 了本模块，顶层 import 会成环。
    if base_action == "case_sync_report":
        from platforms.slack.app import support_flow
        support_flow.handle_action("case_sync_report", body, client)
        return

    # Locale priority: per-action JSON value (preferred — preserves
    # whichever locale we rendered the card in) > thread/dm lock > en.
    locale = _locale_from_action(action_value)
    # 按钮点回来时**不查当前会话选的账号**，只认按钮自己带的那个（渲染时盖的章）。
    # 两个理由：① 用户可能在点按钮之前又切了账号，那时"当前账号"和这张工单不是
    # 一回事，拿它去 AddCommunication / ResolveCase 就是往另一个账号里写；② 本次
    # 改动之前渲染的老消息没有这个字段 → 空 = 部署账号，而那正是它们当年唯一
    # 可能的归属，所以缺省值天然正确。
    account_id = _account_from_action(action_value)

    if base_action == "case_create_open_form":
        # Opens the create modal using the trigger_id from this click.
        try:
            v = _json.loads(action_value or "{}")
        except Exception:
            v = {}
        view = _build_create_view(
            channel_id=v.get("channel_id", channel_id),
            thread_ts=v.get("thread_ts", thread_ts),
            initial_subject=v.get("initial_subject", ""),
            locale=locale,
            account_id=account_id,
        )
        try:
            client.views_open(trigger_id=trigger_id, view=view)
        except Exception as e:
            logger.exception("views_open(case_create) failed: %s", e)
        return

    if base_action == "case_create_dispatch_after":
        try:
            v = _json.loads(action_value or "{}")
        except Exception:
            v = {}
        _dispatch_for_case(
            client, v.get("channel_id", channel_id),
            v.get("thread_ts", thread_ts),
            user_id=user_id,
            display_id=v.get("display_id", ""),
            subject=v.get("subject", ""),
            body_text=v.get("body", ""),
            locale=locale,
            account_id=account_id,
        )
        return

    if base_action == "case_view":
        try:
            v = _json.loads(action_value or "{}")
        except Exception:
            v = {}
        start_view(client, channel_id, thread_ts,
                   display_id=v.get("display_id", ""),
                   internal_id=v.get("internal_id", ""),
                   locale=locale, account_id=account_id)
        return

    if base_action == "case_list_open":
        start_list(client, channel_id, thread_ts, locale=locale,
                   account_id=account_id)
        return

    # action_id is `case_list_filter:<slug>` (slug is the filter value);
    # we read it back from `value` for safety, but accept both forms.
    if base_action == "case_list_filter":
        try:
            v = _json.loads(action_value or "{}")
        except Exception:
            v = {}
        flt = v.get("filter") or (
            action_id.split(":", 1)[1] if ":" in action_id else "recent")
        start_list(client, channel_id, thread_ts, status_filter=flt,
                   locale=locale, account_id=account_id)
        return

    if base_action in ("case_reply_form", "case_reply_open_form"):
        try:
            v = _json.loads(action_value or "{}")
        except Exception:
            v = {}
        view = _build_reply_view(
            display_id=v.get("display_id", ""),
            internal_id=v.get("internal_id", ""),
            channel_id=v.get("channel_id", channel_id),
            thread_ts=v.get("thread_ts", thread_ts),
            locale=locale,
            account_id=account_id,
        )
        try:
            client.views_open(trigger_id=trigger_id, view=view)
        except Exception as e:
            logger.exception("views_open(case_reply) failed: %s", e)
        return

    if base_action == "case_resolve_confirm":
        # Same as start_resolve but called from a button on a list row.
        try:
            v = _json.loads(action_value or "{}")
        except Exception:
            v = {}
        start_resolve(client, channel_id, thread_ts,
                      display_id=v.get("display_id", ""),
                      internal_id=v.get("internal_id", ""),
                      locale=locale, account_id=account_id)
        return

    if base_action == "case_resolve_yes":
        try:
            v = _json.loads(action_value or "{}")
        except Exception:
            v = {}
        _do_resolve(client,
                    channel_id=v.get("channel_id", channel_id),
                    thread_ts=v.get("thread_ts", thread_ts),
                    display_id=v.get("display_id", ""),
                    internal_id=v.get("internal_id", ""),
                    locale=locale, account_id=account_id)
        return

    if base_action == "case_resolve_no":
        client.chat_postEphemeral(
            channel=channel_id, user=user_id,
            text=i18n.t("case.resolve.cancel_ephemeral", locale))
        return


# ===========================================================================
# View submission router
# ===========================================================================
def handle_view_submission(callback: str, ack, body: dict, view: dict,
                           client) -> None:
    if callback == "case_create_view":
        _on_create_submit(ack, body, view, client)
        return
    if callback == "case_reply_view":
        _on_reply_submit(ack, body, view, client)
        return


def _locale_from_view(view: dict) -> str:
    """Pull the locale we stuffed into private_metadata when the modal
    was first opened. Fall back to en if missing."""
    try:
        pm = _json.loads(view.get("private_metadata") or "{}")
    except Exception:
        pm = {}
    return _normalize_locale(pm.get("locale"))


def _on_create_submit(ack, body: dict, view: dict, client) -> None:
    state = view.get("state", {}).get("values", {})
    locale = _locale_from_view(view)

    def field(b, a):
        return (state.get(b, {}).get(a, {}) or {}).get("value", "") or ""

    def select(b, a):
        opt = (state.get(b, {}).get(a, {}) or {}).get("selected_option") or {}
        return opt.get("value", "")

    subject = field("subject_block", "subject").strip()
    body_text = field("body_block", "body").strip()
    contact = field("contact_block", "contact").strip()
    severity = select("severity_block", "severity_select") or DEFAULT_SEVERITY
    language = select("language_block", "language_select") or DEFAULT_LANGUAGE
    dispatch_choice = select("dispatch_block", "dispatch_select") or "no"
    # 服务名称 / 类别 / 案例类型（2026-09-03 补前两项、2026-09-04 补类别，与 web 端案例
    # 面板对齐）。服务名与类别留空 = 交给分类器；案例类型总有默认值
    # （`initial_value=DEFAULT_ISSUE_TYPE`），拿不到就退回默认，**不校验报错** ——
    # 这几项都不该拦住用户开案例。类别匹配不上也不拦，改在结果卡上如实说明。
    service_text = _picked_service_code(
        select("service_select_block", "service_select"),
        field("service_block", "service_text"))
    category_text = field("category_block", "category_text").strip()
    issue_type = select("issue_type_block", "issue_type_select") \
        or DEFAULT_ISSUE_TYPE
    if issue_type not in ISSUE_TYPE_CODES:
        issue_type = DEFAULT_ISSUE_TYPE

    pm_raw = view.get("private_metadata") or "{}"
    try:
        pm = _json.loads(pm_raw)
    except Exception:
        pm = {}
    channel_id = pm.get("channel_id", "")
    thread_ts = pm.get("thread_ts", "")
    # 账号「章」：开表单那一刻定下来的目标账号（空 = 部署账号）。这里**不**去查
    # 会话当前选的账号 —— 用户可能在填表期间又切了账号，而表单上那句"Case 将开在
    # 账号 X 下"已经写死了承诺，必须兑现它。
    account_id = pm.get("case_account_id", "") or ""
    # 账号下拉（2026-09-07）：客户在 modal 里直接选的目标账号**优先于**那个章。
    # 下拉没渲染 / 老 modal 没这个 block 时回传为空 → 仍用章（向后兼容）。
    # 选了一个不在允许集里的号码 → **拒绝**并把错误挂在账号那一栏,不回落到部署
    # 账号：回落会把"这个账号不让开"变成"已在另一个账号开好了"。
    picked_account = select("account_block", "account_select")
    resolved = account_picker.resolve_choice(
        picked_account, stamped=account_id,
        deploy=im_accounts.deploy_account_id())
    if resolved is None:
        ack(response_action="errors",
            errors={"account_block":
                    i18n.t("case.create.account_refused", locale,
                           account=picked_account)})
        return
    account_id = resolved

    if not subject:
        ack(response_action="errors",
            errors={"subject_block":
                    i18n.t("case.create.subject_required_short", locale)})
        return
    if not body_text:
        ack(response_action="errors",
            errors={"body_block":
                    i18n.t("case.create.body_required_short", locale)})
        return
    if severity not in SEVERITY_CODES:
        ack(response_action="errors",
            errors={"severity_block":
                    i18n.t("case.create.severity_invalid_short", locale)})
        return
    if language not in LANGUAGE_CODES:
        language = DEFAULT_LANGUAGE

    if not support_logic.claim_inflight(f"slack_create:{view.get('id', '')}"):
        ack(response_action="errors",
            errors={"subject_block":
                    i18n.t("case.create.processing_short", locale)})
        return

    extra = f"Contact: {contact}" if contact else ""

    # Close the modal immediately — the result lands as a chat.postMessage
    # in the originating channel/thread, so there's nothing more for the
    # modal to show. Slack views don't auto-dismiss, so leaving a
    # "creating…" view stuck on screen until the user manually clicks
    # Close is bad UX. `clear` dismisses the modal and any underlying
    # views in the stack.
    ack(response_action="clear")
    if channel_id:
        try:
            client.chat_postMessage(
                channel=channel_id,
                thread_ts=thread_ts or None,
                text=i18n.t("case.create.creating_status", locale,
                            severity=severity_label(severity, locale),
                            language=LANGUAGE_LABELS.get(language, language)),
            )
        except Exception as e:
            logger.warning("post 'creating' status failed: %s", e)

    # Build context dict mimicking what support_flow's escalation path
    # supplies; intent_summary/raw_text/summary_md all carry the user's
    # own input so the classifier and case body get the question.
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

    threading.Thread(
        target=_create_case_worker,
        args=(client, channel_id, thread_ts, ctx, severity, language, extra,
              subject, body_text, dispatch_choice == "with_dispatch", locale),
        kwargs={"service_text": service_text, "issue_type": issue_type,
                "category_text": category_text, "account_id": account_id},
        daemon=True,
    ).start()


def _create_case_worker(client, channel_id: str, thread_ts: str, ctx: dict,
                        severity: str, language: str, extra: str,
                        subject: str, body_text: str,
                        dispatch_after: bool,
                        locale: str = "en", *,
                        service_text: str = "", issue_type: str = "",
                        category_text: str = "",
                        account_id: str = "") -> None:
    try:
        result = support_logic.create_case(
            ctx, platform=PLATFORM, severity=severity, language=language,
            extra=extra, operator_name="",
            service_text=service_text, issue_type=issue_type,
            category_text=category_text, account_id=account_id,
        )
        result_blocks = _create_result_blocks(
            result, severity, language, subject, body_text, dispatch_after,
            locale=locale, account_id=account_id,
        )
        result_text = (i18n.t("case.create.success_text_short", locale)
                       if result.ok
                       else i18n.t("case.create.fail_text_short", locale))
    except Exception as e:
        logger.exception("create_case worker crashed")  # full detail → CloudWatch only
        result_blocks = [*_account_banner_blocks(account_id, locale),
                         blocks.section(
                             i18n.t("case.create.internal_error_block", locale,
                                    kind=type(e).__name__))]
        result_text = i18n.t("case.create.fail_text_short", locale)

    try:
        client.chat_postMessage(channel=channel_id,
                                thread_ts=thread_ts or None,
                                text=result_text, blocks=result_blocks)
    except Exception as e:
        logger.error("post create result failed: %s", e)
        return

    if dispatch_after and channel_id and getattr(result, "ok", False):
        try:
            _dispatch_for_case(client, channel_id, thread_ts,
                               user_id="", display_id=result.display_id,
                               subject=subject, body_text=body_text,
                               locale=locale, account_id=account_id)
        except Exception as e:
            logger.warning("inline dispatch after create failed: %s", e)


def _on_reply_submit(ack, body: dict, view: dict, client) -> None:
    state = view.get("state", {}).get("values", {})
    locale = _locale_from_view(view)
    body_text = (state.get("reply_body_block", {})
                 .get("reply_body", {})
                 .get("value", "") or "").strip()

    pm_raw = view.get("private_metadata") or "{}"
    try:
        pm = _json.loads(pm_raw)
    except Exception:
        pm = {}
    display_id = pm.get("display_id", "")
    internal_id = pm.get("internal_id", "")
    channel_id = pm.get("channel_id", "")
    thread_ts = pm.get("thread_ts", "")
    # 账号「章」—— `internal_id` 只在这个账号里有效（见
    # `core/case_management.py` 模块 docstring 口径 1），两者必须成对使用。
    account_id = pm.get("case_account_id", "") or ""

    if not body_text:
        ack(response_action="errors",
            errors={"reply_body_block":
                    i18n.t("case.reply.body_required_short", locale)})
        return
    if not display_id and not internal_id:
        ack(response_action="errors",
            errors={"reply_body_block":
                    i18n.t("case.reply.missing_id_short", locale)})
        return

    if not support_logic.claim_inflight(f"slack_reply:{view.get('id', '')}"):
        ack(response_action="errors",
            errors={"reply_body_block":
                    i18n.t("case.create.processing_short", locale)})
        return

    ack(response_action="clear")

    threading.Thread(
        target=_reply_worker,
        args=(client, channel_id, thread_ts, display_id, internal_id,
              body_text, locale, account_id),
        daemon=True,
    ).start()


def _reply_worker(client, channel_id: str, thread_ts: str, display_id: str,
                  internal_id: str, body_text: str,
                  locale: str = "en", account_id: str = "") -> None:
    try:
        ok = case_management.add_communication(display_id, body_text,
                                               internal_id=internal_id or None,
                                               account_id=account_id)
    except Exception as e:
        logger.exception("reply worker crashed")
        ok = False
    try:
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None,
            text=(i18n.t("case.reply.success_text_short", locale) if ok
                  else i18n.t("case.reply.fail_text_short", locale)),
            blocks=_reply_result_blocks(display_id, body_text, ok, locale,
                                        account_id=account_id))
    except Exception as e:
        logger.error("post reply result failed: %s", e)


def _do_resolve(client, channel_id: str, thread_ts: str,
                display_id: str, internal_id: str,
                locale: str = "en", account_id: str = "") -> None:
    if not display_id and not internal_id:
        return
    # 去重键带上账号：不同账号可以有相同的 displayId（`caseId` 虽然嵌了账号号，
    # 但走 displayId 那条路时这里只有 displayId），不带账号会把 B 账号的同号工单
    # 误判成"正在处理中"而拒掉。
    if not support_logic.claim_inflight(
            f"slack_resolve:{account_id}:{internal_id or display_id}"):
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None,
            text=i18n.t("case.toast.processing_short", locale))
        return
    final = case_management.resolve_case(display_id,
                                         internal_id=internal_id or None,
                                         account_id=account_id)
    if final:
        case_url = case_management._case_console_url(display_id)
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None,
            text=i18n.t("case.resolve.success_text_short", locale,
                        display_id=display_id),
            blocks=[
                *_account_banner_blocks(account_id, locale),
                blocks.section(
                    i18n.t("case.resolve.success_block_short", locale,
                           display_id=display_id, status=final)),
                blocks.actions(
                    blocks.button(
                        i18n.t("case.resolve.btn.open_console_short", locale),
                        "open_case_url", url=case_url)),
            ],
        )
    else:
        client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None,
            text=i18n.t("case.resolve.fail_text_short", locale),
            blocks=[*_account_banner_blocks(account_id, locale),
                    blocks.section(
                        i18n.t("case.resolve.fail_block_short", locale,
                               display_id=display_id))],
        )


# ===========================================================================
# Investigation dispatch for a (just-)created case (Idea: dispatch + sync)
# ===========================================================================
def _dispatch_for_case(client, channel_id: str, thread_ts: str,
                       user_id: str, display_id: str,
                       subject: str, body_text: str,
                       locale: str = "en", account_id: str = "") -> None:
    """「开案例 + 起调查」的调查那一半。飞书侧的对位实现是
    `platforms/feishu/app/case_flow.py::_dispatch_for_case`，两边必须对等。

    ── 2026-09-03：从 Fargate 那条老路径切到 IM Lambda 路径 ─────────────────────
    改动的理由与飞书侧逐字相同（`link_incident` 要求先有 `event#` 行、派发完只有一条
    纯文本没有进度卡、依赖 `DEFAULT_INVESTIGATION_ACCOUNT_ID` 没配就静默跳过整个调查）。
    现在与 `platforms/slack/caps.py::investigate` 完全同款：`start_investigation`
    → 发 `dispatch_blocks` → `put_im_task`（进度 Lambda 每分钟 `chat.update` 这条）
    → `link_im_investigation`（最终报告卡回到这个 thread）。

    `incident_id` 仍然是 `slack-case-<display_id>`：report_handler 的
    `_extract_case_display_id()` 靠这个形状认出「这次调查是某个案例带起来的」，从而在
    报告卡上给出「同步到案例」按钮。**别改成 `slack-<event_id>`**。

    `account_id`（空 = 部署账号）：既是调查目标账号（`start_investigation`），也是
    报告卡上那颗「同步到案例」按钮要写回的工单所在账号（`link_im_investigation`）。
    """
    if not channel_id or not display_id:
        return
    # 幂等键带上账号：不同账号可以有相同的 displayId，不带账号会把 B 账号那次
    # 派发误判成"已经在派了"而静默丢掉。
    # ⚠️ 下面那道 `get_im_task(incident_id)` 幂等**没法**这样修：`incident_id` 的形状
    #   （`slack-case-<display_id>`）是 report_handler `_extract_case_display_id()`
    #   的解析契约，加账号段会让报告卡丢掉「同步到案例」按钮。已知取舍：两个账号里
    #   撞到同一个 displayId 且都要起调查时，第二次会被判成"已派发过"。撞号概率极低，
    #   而弄坏报告回投是必然损失。
    if not support_logic.claim_inflight(
            f"slack_dispatch_for_case:{account_id}:{display_id}"):
        if user_id:
            client.chat_postEphemeral(
                channel=channel_id, user=user_id,
                text=i18n.t("case.dispatch.processing_ephemeral", locale))
        return
    from core import devops_agent
    from platforms.slack import im_blocks

    incident_id = f"{PLATFORM}-case-{display_id}"
    user_text = (
        f"AWS Support case {display_id} was just opened with subject:\n"
        f"  {subject}\n\n"
        f"User's question:\n{body_text}\n\n"
        f"Please investigate this issue in parallel with AWS Support so the "
        f"customer gets a faster diagnostic. Reference the case as needed."
    )
    # 幂等：一个案例只起一次调查。`imtask#` 那行的 TTL 覆盖整个调查生命周期，比
    # `claim_inflight` 的短时效在飞（几秒）更可靠 —— 用户隔一分钟再点一次也拦得住。
    try:
        if ddb_state.get_im_task(incident_id):
            client.chat_postEphemeral(
                channel=channel_id, user=user_id or "U000",
                text=i18n.t("case.dispatch.already_dispatched_ephemeral", locale))
            return
    except Exception as e:                        # noqa: BLE001
        # 查不到就当没派过 —— 宁可重复派一次，也不能因为 DDB 抖动就把调查吞掉。
        logger.warning("get_im_task for case dispatch failed: %s", type(e).__name__)

    title = f"[{PLATFORM.capitalize()}#case-{display_id}] {subject[:50]}"
    raw_result = devops_agent.start_investigation(
        title=title, description=user_text, priority="MEDIUM",
        source=f"notiops-im-{PLATFORM}-case",
        account_id=account_id or None,
    )
    if raw_result.get("error"):
        logger.error("Investigation dispatch for case %s failed: %s",
                     display_id, raw_result["error"])
        if user_id:
            client.chat_postEphemeral(
                channel=channel_id, user=user_id,
                text=str(raw_result.get("message") or raw_result["error"]))
        return

    task_id = raw_result.get("task_id") or ""
    home = raw_result.get("console_home") or ""
    deep = raw_result.get("console_url") or ""

    # 进度消息（取代原来那条纯文本）—— 与 `/investigate` 那条路径同一套 blocks。
    body = i18n.t("case.dispatch.dispatched_inline", locale,
                  display_id=display_id)
    card_ts = ""
    try:
        resp = client.chat_postMessage(
            channel=channel_id, thread_ts=thread_ts or None, text=body,
            # 落款带上账号：这条调查是从一张**已经属于某个账号**的工单发起的，
            # 而 `raw_result["account_id"]` 已经解析成具体 12 位数字。
            blocks=im_blocks.dispatch_blocks(
                body, locale, deep_link=deep, home=home, state="dispatched",
                account=str(raw_result.get("account_id") or ""),
                deploy=im_accounts.deploy_account_id()))
        card_ts = im_blocks.ts_of(resp)
    except Exception as e:                        # noqa: BLE001
        logger.error("case dispatch blocks post failed: %s", type(e).__name__)
    if not card_ts:
        # 消息没发出去 → 没有 update 落点。**不落 `imtask#`**（否则进度 Lambda 会对着
        # 空 ts 重试 30 分钟）。调查本身已经起来了，退纯文本把这件事说清楚。
        logger.error("case %s: dispatch blocks failed; falling back to text",
                     display_id)
        line = body
        if deep:
            line += f"\n{i18n.t('progress.btn.open_link', locale)}: {deep}"
        elif home:
            line += f"\n{i18n.t('progress.btn.open_home', locale)}: {home}"
        try:
            client.chat_postMessage(channel=channel_id,
                                    thread_ts=thread_ts or None, text=line)
        except Exception as e:                    # noqa: BLE001
            logger.error("case dispatch text fallback failed: %s", type(e).__name__)
    else:
        ddb_state.put_im_task(
            incident_id,
            platform=PLATFORM, chat_id=channel_id, message_id=card_ts,
            locale=locale, account_id=raw_result.get("account_id") or "",
            task_id=task_id,
            execution_id=raw_result.get("execution_id") or "",
            agent_space_id=raw_result.get("agent_space_id") or "",
            user_id=user_id, title=title,
            console_url=deep, console_home=home,
        )

    # 第二行路由：最终报告卡走 EventBridge → notiops-devops-callback →
    # report_handler，它只认 `incident#` / `task#`。少了这一步，进度消息会一路刷到
    # 「已完成」，但报告只躺在 S3 里 —— 而且案例流程还会因此失去「同步到案例」按钮。
    try:
        ddb_state.link_im_investigation(
            incident_id, task_id, platform=PLATFORM, chat_id=channel_id,
            root_message_id=card_ts or (thread_ts or ""), locale=locale,
            user_id=user_id, raw_text=user_text[:1000],
            # 报告卡上那颗「同步到案例」按钮要写的是**这个**账号的工单。
            # ⚠️ 这里存**请求值**（`account_id`，空 = 部署账号），不存
            #   `raw_result["account_id"]` —— 后者是 `start_investigation` 解析后
            #   的结果，单账号客户那里也会是一串部署账号号，于是报告卡上会凭空
            #   多出一条「Account: …」。全线口径统一：空字符串才代表"没选成员账号"。
            account_id=account_id or "",
        )
    except Exception as e:                        # noqa: BLE001
        logger.warning("link_im_investigation for case dispatch failed: %s",
                       type(e).__name__)

    logger.info("Dispatched investigation for case %s incident_id=%s task_id=%s",
                display_id, incident_id, task_id)


# ===========================================================================
# View builders (modals)
# ===========================================================================
#: 下拉里"不指定，你们自己判断"那一项的值。Slack 不接受空 `value`，所以用哨兵；
#: 提交时 `_picked_service_code()` 把它折回空串。
SERVICE_AUTO = "__auto__"


def _service_select_blocks(locale: str) -> list[dict]:
    """常用服务下拉（拿不到目录就换成一句说明）。

    ⚠️ 目录读不到时**不给空下拉**：一个只有"自动判断"一项的选择器看着像功能坏了，
    而客户其实还有自由文本那条路。所以这里换成一条 context 说明 —— 不许静默少一个控件。
    """
    try:
        services = case_classifier.popular_services()
    except Exception as e:                            # noqa: BLE001
        # 面板不能因为拉目录失败就打不开 —— 案例是客户在出事时才开的东西。
        logger.warning("popular_services failed: %s", type(e).__name__)
        services = []
    # `blocks.static_select` 会把 value 截到 75 字符 —— 截断过的 code 一定被 CreateCase
    # 拒收，宁可这条不进下拉（自由文本照样能填）。
    options = [(s["code"], s["name"]) for s in services if len(s["code"]) <= 75]
    if not options:
        return [blocks.context(
            i18n.t("case.create.service_catalog_unavailable", locale))]
    return [blocks.static_select(
        i18n.t("case.create.service_select_label_short", locale),
        "service_select",
        options=[(SERVICE_AUTO,
                  i18n.t("case.create.service_select_auto", locale)), *options],
        initial_value=SERVICE_AUTO,
        block_id="service_select_block",
        placeholder=i18n.t("case.create.service_select_placeholder", locale),
    )]


def _picked_service_code(dropdown: str, free_text: str) -> str:
    """下拉优先、自由文本兜底 —— 汇成一个交给 `resolve_service` 的字符串。

    下拉给的是真实 code（走 `resolve_service` 第 1 级精确命中），自由文本走模糊反查。
    两个都空 = 分类器自动判断（历史行为）。
    """
    picked = (dropdown or "").strip()
    if picked and picked != SERVICE_AUTO:
        return picked
    return (free_text or "").strip()


def service_and_type_blocks(locale: str) -> list[dict]:
    """「服务名称」+「类别」+「案例类型」这一组控件 —— **两个开案例面板共用同一份**。

    为什么抽出来:开案例有**两个**入口 —— `/案例` 面板(`_build_create_view`)和调查报告卡
    上的「🆘 Escalate to AWS Support」(`support_flow._build_form_view`)。这两项当初只加在
    前一个上,后一个就少了 —— 复制一份的话下次改动照样长歪(选项不同 / 默认值不同 /
    目录挂了的退化行为不同),而这种不一致**不报错**,只是同一个操作从两个入口进去开出
    不同的案例。所以两边都调这一个函数,并有测试钉住"两个面板都调了它"。

    四件东西按客户填写顺序:常用服务下拉 → 长尾自由文本 → 类别 → 案例类型。
    「类别」是**手打**而不是像 web 那样跟着服务联动的下拉 —— 联动要在面板中途回一趟
    服务端重绘,Slack 做得到(modal 的 `block_actions` 带着整个 `state.values`),飞书
    做不到(表单容器的数据只在点提交时才回调,中途重绘会清空已填内容)。两端统一用
    "手打 + 服务端在该服务名下反查",理由与实测数据见
    `core.case_classifier.resolve_category_detail`。
    """
    it_labels = issue_type_labels(locale)
    return [
        # 下拉里的 value 是**真实 code**（`popular_services()` 从现网目录反查，见那边的
        # 注释），所以提交时原样交给 `resolve_service` 就能精确命中；目录读不到时
        # `_service_select_blocks` 返回一条说明而不是空下拉。
        *_service_select_blocks(locale),
        blocks.text_input(
            i18n.t("case.create.service_label_short", locale),
            "service_text", block_id="service_block",
            placeholder=i18n.t("case.create.service_placeholder_short", locale),
            max_length=100, optional=True,
        ),
        # 类别 —— 留空就按服务挑一个通用类别（`resolve_category_detail`），填了就在
        # **该服务名下**反查，所以怎么填都不可能拼出 CreateCase 拒收的非法组合。
        blocks.text_input(
            i18n.t("case.create.category_label_short", locale),
            "category_text", block_id="category_block",
            placeholder=i18n.t("case.create.category_placeholder_short", locale),
            max_length=100, optional=True,
        ),
        # 案例类型 —— 与 web 端案例面板同三项（`core.support_logic.ISSUE_TYPE_CODES`）。
        blocks.static_select(
            i18n.t("case.create.issue_type_label_short", locale),
            "issue_type_select",
            options=[(c, it_labels[c]) for c in ISSUE_TYPE_CODES],
            initial_value=DEFAULT_ISSUE_TYPE,
            block_id="issue_type_block",
        ),
    ]


def picked_service_code(dropdown: str, free_text: str) -> str:
    """`_picked_service_code` 的公开别名 —— 给另一个面板（`support_flow`）用。"""
    return _picked_service_code(dropdown, free_text)


def _build_create_view(*, channel_id: str, thread_ts: str,
                       initial_subject: str, locale: str = "en",
                       account_id: str = "") -> dict:
    """开案例 modal。`account_id`（空 = 部署账号）= 打开 modal 那一刻的会话账号,
    既是账号下拉的默认选中项,也盖进 `private_metadata` 当兜底章。

    账号下拉与飞书那份共用 `platforms.common.account_picker`（选项 / 默认项 / 回传值
    校验三件事都在那里）—— 两端各写一份的症状是"同一个部署里飞书能开到成员账号、
    Slack 只能开到部署账号",而谁也不会同时看两端。

    ⚠️ 这里解析部署账号（一次 STS,已被 `im_accounts` 容器级缓存）是可以的：modal
    构造是**一次性**的用户交互,不是 `LiveCard.flush` 那种每几秒一轮的渲染循环。
    """
    sev_labels = severity_labels(locale)
    deploy = im_accounts.deploy_account_id()
    account_options = account_picker.options(locale, deploy=deploy)
    severity_options = [(c, sev_labels[c]) for c in SEVERITY_CODES]
    language_options = [(c, LANGUAGE_LABELS[c]) for c in LANGUAGE_CODES]
    # Two options as a Slack static_select. Slack modals only allow ONE
    # submit button per modal (platform constraint), so we can't mirror
    # feishu's two-button design directly. The radio between "create
    # only" vs "create + dispatch" picks the path. We default to
    # "with_dispatch" because that's the higher-value flow customers
    # usually want when they reach for case creation.
    dispatch_options = [
        ("with_dispatch",
         i18n.t("case.create.dispatch_with_dispatch", locale)),
        ("no",
         i18n.t("case.create.dispatch_no", locale)),
    ]

    pm = _json.dumps({
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "locale": locale,
        # 账号「章」：提交时 `_on_create_submit` 只认这个，不查会话当前偏好 ——
        # 表单上那句"Case 将开在账号 X 下"是承诺，必须兑现。
        "case_account_id": account_id,
    }, ensure_ascii=False)

    return blocks.modal(
        title=i18n.t("case.create.modal.title_short", locale)[:24],
        callback_id="case_create_view",
        submit=i18n.t("case.create.modal.submit_short", locale)[:24],
        close=i18n.t("case.create.modal.cancel_short", locale)[:24],
        private_metadata=pm,
        blocks=[
            # 账号放**第一项**：这张表里只有它决定"这次写操作落在谁的账号上"。
            # 空列表（单账号部署 / 注册表里没有别的启用账号）时整块不出现,
            # 行为与加下拉之前逐字相同。
            *([blocks.static_select(
                i18n.t("case.create.account_label", locale),
                "account_select",
                options=account_options,
                initial_value=(account_id or "").strip() or deploy,
                block_id="account_block",
                placeholder=i18n.t("case.create.account_placeholder", locale),
            )] if account_options else []),
            blocks.text_input(
                i18n.t("case.create.subject_label_short", locale),
                "subject", block_id="subject_block",
                placeholder=i18n.t("case.create.subject_placeholder_short",
                                   locale),
                initial_value=initial_subject, max_length=250,
            ),
            blocks.text_input(
                i18n.t("case.create.body_label_short", locale),
                "body", block_id="body_block",
                placeholder=i18n.t("case.create.body_placeholder_short",
                                   locale),
                multiline=True, max_length=1000,
            ),
            # 服务名称 + 案例类型 —— 与调查报告卡上的「🆘 Escalate」面板**共用**同一份
            # 控件（`service_and_type_blocks`），两个入口不会长歪。
            *service_and_type_blocks(locale),
            blocks.static_select(
                i18n.t("case.create.severity_label_short", locale),
                "severity_select",
                options=severity_options, initial_value=DEFAULT_SEVERITY,
                block_id="severity_block",
            ),
            blocks.static_select(
                i18n.t("case.create.language_label_short", locale),
                "language_select",
                options=language_options, initial_value=DEFAULT_LANGUAGE,
                block_id="language_block",
            ),
            blocks.static_select(
                i18n.t("case.create.dispatch_label", locale),
                "dispatch_select",
                options=dispatch_options, initial_value="with_dispatch",
                block_id="dispatch_block",
                placeholder=i18n.t("case.create.dispatch_placeholder",
                                   locale),
            ),
            blocks.text_input(
                i18n.t("case.create.contact_label_short", locale),
                "contact", block_id="contact_block",
                placeholder=i18n.t("case.create.contact_placeholder_short",
                                   locale),
                max_length=200, optional=True,
            ),
            blocks.context(
                i18n.t("case.create.modal.context_hint", locale)
            ),
            # 落在哪个账号 —— 这是本产品唯一的写操作，必须在**提交之前**说清楚。
            # 单独一条 context 块（不塞进 `context_hint`）：那条 key 是"两种模式
            # 有什么区别"的说明，账号归属是另一件事，而且只有它随会话变。
            # 有下拉时换一句：那时归属由客户刚点的那一项决定,沿用 `..._target`
            # 会出现"说明写着 A、下拉里选了 B"的自相矛盾 modal。
            blocks.context(
                i18n.t("case.create.account_note_picker", locale)
                if account_options
                else (i18n.t("case.create.account_note_target", locale,
                             account=account_id)
                      if (account_id or "").strip()
                      else i18n.t("case.create.account_note", locale))),
        ],
    )


def _build_reply_view(*, display_id: str, internal_id: str,
                      channel_id: str, thread_ts: str,
                      locale: str = "en", account_id: str = "") -> dict:
    pm = _json.dumps({
        "display_id": display_id,
        "internal_id": internal_id,
        "channel_id": channel_id,
        "thread_ts": thread_ts,
        "locale": locale,
        # 账号「章」—— 与 `internal_id` 成对，见 `_on_reply_submit`。
        "case_account_id": account_id,
    }, ensure_ascii=False)
    title = i18n.t("case.reply.modal.title_short", locale,
                   display_id=display_id[:18])
    return blocks.modal(
        title=title[:24],
        callback_id="case_reply_view",
        submit=i18n.t("case.reply.modal.submit_short", locale)[:24],
        close=i18n.t("case.create.modal.cancel_short", locale)[:24],
        private_metadata=pm,
        blocks=[
            *_account_banner_blocks(account_id, locale),
            blocks.section(i18n.t("case.reply.intro_short", locale)),
            blocks.text_input(
                i18n.t("case.reply.body_label_short", locale),
                "reply_body", block_id="reply_body_block",
                placeholder=i18n.t("case.reply.body_placeholder_short", locale),
                multiline=True, max_length=1000,
            ),
        ],
    )


# ===========================================================================
# List / view / result block builders
# ===========================================================================
def _list_blocks(cases: list[CaseSummary], status_filter: str,
                 locale: str = "en", account_id: str = "") -> list[dict]:
    label = _filter_label(status_filter, locale) \
        if status_filter in _FILTER_BUTTON_SLUGS \
        else _filter_label("recent", locale)
    console_url = case_management.SUPPORT_CONSOLE_LIST_URL
    if not cases:
        empty_key = (f"case.list.empty.{status_filter}"
                     if status_filter in _FILTER_BUTTON_SLUGS
                     else "case.list.empty.default")
        empty_msg = i18n.t(empty_key, locale)
        return [
            blocks.header(i18n.t("case.list.title_with_label", locale,
                                 label=label)),
            *_account_banner_blocks(account_id, locale),
            blocks.section(empty_msg),
            *_filter_quick_buttons(status_filter, locale, account_id),
            blocks.actions(blocks.button(
                i18n.t("case.list.console_btn_short", locale),
                "open_console_list",
                url=console_url)),
        ]
    out: list[dict] = [
        blocks.header(i18n.t("case.list.title_with_label", locale,
                             label=label)),
        *_account_banner_blocks(account_id, locale),
        blocks.context(i18n.t("case.list.subtotal_simple", locale,
                              count=len(cases))),
    ]
    for c in cases:
        out.append(blocks.divider())
        sev_emoji = {"critical": "🟣", "urgent": "🔴", "high": "🟠",
                     "normal": "🟡", "low": "🟢"}.get(c.severity, "⚪")
        is_resolved = c.status.startswith("resolved") or c.status == "closed"
        status_badge = (i18n.t("case.list.status.resolved", locale)
                        if is_resolved
                        else i18n.t("case.list.status.active", locale,
                                    status=c.status))
        subject = (blocks.escape_mrkdwn(c.subject)
                   or i18n.t("case.view.no_subject", locale))
        submitter = (c.submitted_by
                     or i18n.t("case.view.unknown_submitter", locale))
        body_md = i18n.t("case.list.row_md", locale,
                         sev_emoji=sev_emoji,
                         subject=subject,
                         display_id=c.display_id,
                         status_badge=status_badge,
                         severity=severity_label(c.severity, locale),
                         date=_short_date(c.created_at),
                         submitter=submitter)
        if c.recent_communication:
            body_md += f"\n> {blocks.escape_mrkdwn(c.recent_communication)}"
        out.append(blocks.section(body_md))
        # `internal_id` 与 `case_account_id` 必须成对盖章：caseId 只在它自己的
        # 账号里查得到（见 `core/case_management.py` 口径 1）。
        action_val = _json.dumps({"display_id": c.display_id,
                                  "internal_id": c.internal_id,
                                  "locale": locale,
                                  "case_account_id": account_id},
                                 ensure_ascii=False)
        # Slack rejects messages where two action_ids collide. Suffix
        # each per-row button with the display_id to keep them unique
        # while preserving the prefix that our router matches on.
        suffix = c.display_id
        row = [
            blocks.button(i18n.t("case.list.btn.detail_short", locale),
                          f"case_view:{suffix}", value=action_val),
            blocks.button(i18n.t("case.list.btn.reply_short", locale),
                          f"case_reply_form:{suffix}", value=action_val),
            blocks.button(i18n.t("case.list.btn.open_short", locale),
                          f"open_case_url:{suffix}", url=c.case_url),
        ]
        if not is_resolved:
            row.append(blocks.button(
                i18n.t("case.list.btn.close_short", locale),
                f"case_resolve_confirm:{suffix}",
                value=action_val, style="danger"))
        out.append(blocks.actions(*row))
    out.append(blocks.divider())
    out.extend(_filter_quick_buttons(status_filter, locale, account_id))
    out.append(blocks.context(
        i18n.t("case.list.console_hint_short", locale)))
    out.append(blocks.actions(
        blocks.button(i18n.t("case.list.console_btn_short", locale),
                      "open_console_list",
                      url=console_url, style="primary"),
    ))
    return out


def _filter_quick_buttons(current: str, locale: str = "en",
                          account_id: str = "") -> list[dict]:
    btns = []
    for slug in _FILTER_BUTTON_SLUGS:
        if slug == current:
            continue
        label = i18n.t(f"case.list.filter_btn.{slug}", locale)
        # action_id MUST be unique within the same Slack message; suffix
        # with the filter slug. The action handler matches `case_list_filter`
        # via regex prefix and reads the filter from `value`.
        btns.append(blocks.button(
            label, f"case_list_filter:{slug}",
            value=_json.dumps({"filter": slug, "locale": locale,
                               # 换 filter 不该换账号 —— 章带着走。
                               "case_account_id": account_id})))
    if not btns:
        return []
    return [blocks.context(i18n.t("case.list.quick_filter_short", locale)),
            blocks.actions(*btns)]


def _view_blocks(c: CaseSummary,
                 comms: list[Communication],
                 locale: str = "en", account_id: str = "") -> list[dict]:
    sev_label = severity_label(c.severity, locale)
    subject = (blocks.escape_mrkdwn(c.subject)
               or i18n.t("case.view.no_subject", locale))
    submitter = c.submitted_by or i18n.t("case.view.unknown_submitter", locale)
    head = i18n.t("case.view.head_block_slack", locale,
                  subject=subject,
                  display_id=c.display_id,
                  status=c.status,
                  severity=sev_label,
                  service=c.service_code,
                  category=c.category_code,
                  created=_short_date(c.created_at),
                  submitter=submitter)
    out: list[dict] = [
        blocks.header(i18n.t("case.view.title_short", locale,
                             display_id=c.display_id)),
        *_account_banner_blocks(account_id, locale),
        blocks.section(head),
        blocks.divider(),
    ]
    if not comms:
        out.append(blocks.context(
            i18n.t("case.view.no_replies_short", locale)))
    else:
        out.append(blocks.section(
            i18n.t("case.view.recent_replies_header_slack", locale,
                   count=len(comms))))
        for cm in comms:
            who = (i18n.t("case.view.who_aws_short", locale) if cm.is_aws
                   else i18n.t("case.view.who_customer_short", locale,
                               name=(cm.submitted_by
                                     or i18n.t("case.view.customer_default",
                                               locale))))
            ts = _short_date(cm.submitted_at)
            preview = blocks.escape_mrkdwn(blocks.trim(cm.body, 800))
            out.append(blocks.section(
                i18n.t("case.view.reply_block_slack", locale,
                       who=who, ts=ts, body=preview)))
    is_resolved = c.status.startswith("resolved") or c.status == "closed"
    action_val = _json.dumps({"display_id": c.display_id,
                              "internal_id": c.internal_id,
                              "locale": locale,
                              "case_account_id": account_id},
                             ensure_ascii=False)
    actions_row = [
        blocks.button(i18n.t("case.view.btn.add_reply_short", locale),
                      "case_reply_form",
                      value=action_val, style="primary"),
        blocks.button(i18n.t("case.view.btn.open_console_short", locale),
                      "open_case_url", url=c.case_url),
    ]
    if not is_resolved:
        actions_row.append(blocks.button(
            i18n.t("case.view.btn.close_short", locale),
            "case_resolve_confirm",
            value=action_val, style="danger"))
    out.append(blocks.divider())
    out.append(blocks.actions(*actions_row))
    return out


def _analyze_blocks(result: case_analyze.AnalyzeResult,
                     locale: str = "en", account_id: str = "") -> list[dict]:
    """LLM analysis card: header + meta + insight sections + 2 buttons.

    Caller (start_analyze) has already filtered error paths; here
    `result.error == ""` and `result.case_summary` is non-None."""
    c = result.case_summary
    assert c is not None  # error paths handled in start_analyze

    head = i18n.t(
        "case.analyze.subject_meta", locale,
        subject=blocks.escape_mrkdwn(c.subject)
                or i18n.t("case.list.no_subject", locale),
        severity=severity_label(c.severity, locale),
        service=c.service_code or "—",
        status=c.status or "—",
        comm_count=result.comm_count,
    )
    out: list[dict] = [
        blocks.header(i18n.t("case.analyze.title", locale,
                              display_id=c.display_id)),
        *_account_banner_blocks(account_id, locale),
        blocks.section(head),
        blocks.divider(),
    ]

    def _section_text(header_key: str, body_text: str) -> None:
        if not body_text:
            return
        out.append(blocks.section(
            f"*{i18n.t(header_key, locale)}*\n"
            + blocks.escape_mrkdwn(body_text)
        ))

    def _section_bullets(header_key: str, items: list[str]) -> None:
        if not items:
            return
        bullets = "\n".join(f"• {blocks.escape_mrkdwn(it)}" for it in items)
        out.append(blocks.section(
            f"*{i18n.t(header_key, locale)}*\n{bullets}"
        ))

    _section_text("case.analyze.section.summary", result.summary)
    _section_text("case.analyze.section.root_cause", result.root_cause)
    _section_text("case.analyze.section.aws_progress", result.aws_progress)
    _section_bullets("case.analyze.section.next_steps", result.next_steps)
    _section_bullets("case.analyze.section.info_to_provide",
                     result.info_to_provide)
    if result.suggested_reply:
        # Prefix every line with "> " for Slack quote-block styling.
        quoted = "\n".join(
            "> " + ln for ln in
            blocks.escape_mrkdwn(result.suggested_reply).split("\n"))
        out.append(blocks.section(
            f"*{i18n.t('case.analyze.section.suggested_reply', locale)}*\n"
            + quoted))

    out.append(blocks.divider())
    action_val = _json.dumps({"display_id": c.display_id,
                              "internal_id": c.internal_id,
                              "locale": locale,
                              "case_account_id": account_id},
                             ensure_ascii=False)
    out.append(blocks.actions(
        blocks.button(i18n.t("case.analyze.btn.reply", locale),
                      "case_reply_form",
                      value=action_val, style="primary"),
        blocks.button(i18n.t("case.analyze.btn.view_full", locale),
                      "open_case_url", url=c.case_url),
    ))
    return out


def _create_result_blocks(result: support_logic.CaseResult,
                          severity: str, language: str,
                          subject: str, body_text: str,
                          dispatched: bool,
                          locale: str = "en",
                          account_id: str = "") -> list[dict]:
    if not result.ok:
        code = result.error_code or "Error"
        # 失败文案统一走 `support_logic.failure_hint`（跨账号 / 缺写权限 / 缺只读
        # 权限 / 无 Support 计划四种成因各有各的出路），别在这里再维护一条 if 链 ——
        # 五个渲染点各写一份的时候，漏掉的正是跨账号那两种。
        hint = support_logic.failure_hint(result, locale)
        return [*_account_banner_blocks(account_id, locale),
                blocks.section(
                    i18n.t("case.create.fail_block", locale,
                           code=code, hint=blocks.escape_mrkdwn(hint)))]
    cls = result.classification or {}
    classification_block = ""
    if cls.get("serviceCode") or cls.get("categoryCode"):
        classification_block = i18n.t(
            "case.create.classification_lines", locale,
            service=cls.get("serviceCode", ""),
            # 类别后面缀"你指定/自动挑选" —— 光印一个 code 用户分不清是谁定的。
            category=support_logic.category_display(cls, locale),
            # 显示本地化标签而不是 `technical` 这种 API code —— 用户在面板里选的是标签。
            issue_type=issue_type_label(cls.get("issueType", ""), locale),
        )
    # 用户填了服务名但目录里没有 → **必须说出来**。静默忽略最坑：用户以为自己指定了
    # 服务，案例却落在分类器挑的（可能是 general-info）那条上。
    if cls.get("serviceUnmatched"):
        classification_block += i18n.t(
            "case.create.service_unmatched_line", locale,
            text=blocks.escape_mrkdwn(str(cls["serviceUnmatched"])))
    # 类别同理：填了但这个服务名下没有 → 说清用的是哪个，别让人以为按自己填的走了。
    if cls.get("categoryUnmatched"):
        classification_block += i18n.t(
            "case.create.category_unmatched_line", locale,
            text=blocks.escape_mrkdwn(str(cls["categoryUnmatched"])),
            service=cls.get("serviceCode", ""),
            category=cls.get("categoryCode", ""))
    subject_line = (
        i18n.t("case.create.success_subject_line", locale,
               subject=blocks.escape_mrkdwn(subject.strip()))
        if subject and subject.strip() else "")

    out: list[dict] = [
        blocks.header(i18n.t("case.create.success_text_short", locale)),
        # 开在哪个账号 —— 控制台链接不带账号参数，不写清用户点进去看不到这张工单。
        *_account_banner_blocks(account_id, locale),
        blocks.section(
            i18n.t("case.create.success_block", locale,
                   display_id=result.display_id,
                   subject_line=subject_line,
                   case_url=result.case_url)),
        blocks.divider(),
        blocks.section(
            i18n.t("case.create.severity_lang_block", locale,
                   severity=severity_label(severity, locale),
                   language=LANGUAGE_LABELS.get(language, language),
                   classification=classification_block)),
    ]
    # ⚠️ No "start an Agent investigation" button here any more (removed
    # 2026-09-02, same change as the Feishu twin in
    # platforms/feishu/app/case_flow.py). Opening a case and investigating are
    # two separate decisions; the button turned the success card of the first
    # into a nudge for the second. `case_create_dispatch_after` stays wired up
    # in the action handler so already-posted cards don't dead-click.
    if dispatched:
        out.append(blocks.section(
            i18n.t("case.create.dispatched_section", locale)))
    out.append(blocks.actions(
        blocks.button(i18n.t("case.create.btn.open_case_short", locale),
                      "open_case_url",
                      url=result.case_url, style="primary"),
        blocks.button(i18n.t("case.create.btn.my_cases_short", locale),
                      "case_list_open"),
    ))
    return out


def _reply_result_blocks(display_id: str, body_text: str,
                         ok: bool,
                         locale: str = "en",
                         account_id: str = "") -> list[dict]:
    if not ok:
        return [*_account_banner_blocks(account_id, locale),
                blocks.section(
                    i18n.t("case.reply.fail_block_short", locale,
                           display_id=display_id))]
    case_url = case_management._case_console_url(display_id)
    return [
        *_account_banner_blocks(account_id, locale),
        blocks.section(
            i18n.t("case.reply.success_block_short", locale,
                   display_id=display_id)),
        blocks.section(f"> {blocks.escape_mrkdwn(blocks.trim(body_text, 600))}"),
        blocks.actions(
            blocks.button(
                i18n.t("case.reply.btn.open_console_short", locale),
                "open_case_url", url=case_url),
            blocks.button(
                i18n.t("case.reply.btn.detail_short", locale),
                "case_view",
                value=_json.dumps({"display_id": display_id,
                                   "locale": locale,
                                   "case_account_id": account_id})),
        ),
    ]


# ===========================================================================
# Helpers
# ===========================================================================
# Phrases users typically type to OPEN a case — when the input is just
# this short kind of intent ("帮我开 case", "create case"), there's no
# detail to summarize and Subject should stay empty. Both languages
# included because the bot speaks both; this is intent matching, not
# user-facing text.
_INTENT_ONLY_PATTERNS = (
    "创建案例", "创建 case", "创建case", "开案例", "开 case", "开case",
    "新建案例", "新建 case", "新建case", "提工单", "开工单",
    "升级到 support", "升级到support", "升级 support",
    "create case", "open case", "new case", "support ticket",
    "escalate to support", "ask support",
)


def _summarize_subject(raw_text: str) -> str:
    """Same logic as feishu's _summarize_subject (sans Bedrock — Slack
    side keeps it simple; ≤60 char inputs after stripping intent prefix
    are used directly, longer ones return as-is and the user can edit
    in the modal anyway)."""
    text = (raw_text or "").strip()
    if not text:
        return ""
    lowered = text.lower()
    stripped = text
    for p in _INTENT_ONLY_PATTERNS:
        idx = lowered.find(p)
        if idx >= 0:
            head = text[:idx].rstrip(" ,，:。.")
            tail = text[idx + len(p):].lstrip(" ,，:。.")
            stripped = (head + " " + tail).strip() if head else tail
            break
    return stripped[:200] if stripped else ""


def _extract_reply_body(text: str, display_id: str) -> str:
    if not text or not display_id:
        return ""
    idx = text.find(display_id)
    if idx < 0:
        return ""
    rest = text[idx + len(display_id):].strip(" \t\n\r:,.，。")
    return rest if len(rest) >= 4 else ""


def _short_date(iso: str) -> str:
    if not iso or len(iso) < 16:
        return iso or "—"
    return f"{iso[:10]} {iso[11:16]} UTC"
