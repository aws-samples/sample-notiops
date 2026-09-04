"""Slack worker Lambda（IM 重构 / M3）—— 真正干活儿的那个。

由 ingress 用 `InvocationType='Event'` 异步投递触发。事件形状：
  ``{"kind": "message" | "block_actions" | "view_submission" | "slash",
     "payload": {...}, "ts": <float epoch>}``

职责与 `platforms/feishu/lambda_worker.py` 一一对应（幂等去重 → locale → 规范化成
`ImMessage` → `platforms.common.router.dispatch` → `SlackCaps`），下面只写**Slack 特有**
的四件事。

── ⚠️ 坑 1：绝不能 import `platforms/slack/app/main.py` ────────────────────────
那个模块在 import 期就 `App(token=...)`（第 115 行）并做 `auth_test()`；读不到凭证时进
`_wait_for_credentials()` —— `while True: time.sleep(3600)`。Fargate 上那是"等人填凭证"，
Lambda 上是**必然超时**。所以 Slack 这边不能像飞书 worker 那样"把卡片回调整个委托给
main.py"，必须自己抄一份分流表。抄的是 main.py 的**注册顺序**（`^case_` 先于
support_flow），见 `_handle_block_actions`。

── ⚠️ 坑 2：`trigger_id` 只有约 3 秒有效 ──────────────────────────────────────
`views_open` 必须在用户点击后 ~3s 内发出。ingress→异步 worker 这条链上，worker 冷启动
（读 secret + import slack_sdk + boto3）能吃掉 2s 以上。所以开 modal 的那几个 action
（`case_create_open_form` / `case_reply_form` / `case_reply_open_form`）**先做时效预检**：
ingress 在 payload 里盖了 `ts`，这里算 elapsed，超过 `_TRIGGER_BUDGET` 就不去调
`views_open`，改发一条"再点一次"的消息（第二次 worker 是热的，~200ms 就到）。

为什么用时间预检而不是"调用失败再兜底"：`case_flow.handle_action` 内部把 `views_open`
的异常**自己吞了**（只 `logger.exception`），我们拿不到失败信号。见 case_flow.py:325。

── ⚠️ 坑 3：`view_submission` 的 `ack` 已经被 ingress 用掉了 ──────────────────
`case_flow._on_create_submit` 用 `ack(response_action="errors", ...)` 把校验错误显示在
modal 里。但 webhook 路径下 ingress 早就回了 200 空 body（= 关闭 modal），modal 已经没了。
所以这里传一个 **ack shim**：把 `errors` 转成一条发到原频道的消息。不这么做的话，
"标题为空"这类校验失败会**静默丢弃**用户刚填的一整个表单。

── ⚠️ 坑 4：后台线程会被冻结 ─────────────────────────────────────────────────
`_on_create_submit` / `_do_resolve` 等会 `threading.Thread(daemon=True).start()`。
Lambda 在 handler 返回后冻结执行环境，daemon 线程直接消失。所以调用前后各快照一次
`threading.enumerate()`，把新起的线程 join 掉（worker timeout 900s，够它们跑完）。
与飞书 worker 同一套做法。
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import time

from core import bedrock_credentials
from core import ddb_state
from core import i18n
from core import locale_resolver
from platforms.common import lambda_deadline, quoted_context, router
from platforms.common.im_types import ImMessage
from platforms.slack import caps as caps_mod
from platforms.slack import im_blocks
from platforms.slack.caps import PLATFORM, SlackCaps, get_client

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# 与 platforms/slack/app/main.py:110 同一个变量名。改名等于给 Fargate 回滚路径
# 埋一个空白名单。
ALLOWED_CHANNEL_IDS = {
    c.strip() for c in os.environ.get("ALLOWED_CHANNEL_IDS", "").split(",")
    if c.strip()
}

# `views_open` 的 trigger_id 时效预算。Slack 官方口径是"约 3 秒"，这里留 0.5s 给
# 本次调用本身的网络往返 —— 宁可多发一次"再点一次"，也不要点了没反应。
_TRIGGER_BUDGET = 2.5

# main.py 的后台线程最多等多久（同飞书 worker）。
_THREAD_JOIN_TIMEOUT = 600

# 与 platforms/slack/app/main.py:138 同一条正则（`<@U123ABC> ` 前缀）。
_MENTION_RE = re.compile(r"<@[A-Z0-9]+>\s*")

# 每次冷启动装一次 bedrock 凭证（case 路径用到 analyze_intent）
try:
    bedrock_credentials.install()
except Exception as e:                        # noqa: BLE001
    logger.warning("bedrock_credentials.install failed: %s", type(e).__name__)

_CAPS = SlackCaps()


def _strip_mention(text: str) -> str:
    """去掉开头那个 `<@Uxxxx>`。与 main.py:141 同口径（只去**第一个**，count=1）——
    去全部会把「帮我看看 <@U999> 说的那个问题」里的引用也吃掉。"""
    return _MENTION_RE.sub("", text or "", count=1).strip()


# ---------------------------------------------------------------------------
# message 事件
# ---------------------------------------------------------------------------
def _normalize_message(payload: dict) -> ImMessage | None:
    """Slack event → 规范化 `ImMessage`。返回 None = 应该丢弃（不响应）。

    ⚠️ 群里的"免 @ 追问"判定与 main.py:405-412 逐字对齐：
      · DM（`channel_type == "im"`）→ 一律受理；
      · 群里 `app_mention` → 受理；
      · 群里普通 `message` → **只有**在 bot 已经回过话的 thread 里才受理。
    少了最后一条，bot 会对群里每一句话都作答。
    """
    inner = payload.get("event") or {}
    channel_id = str(inner.get("channel") or "")
    if ALLOWED_CHANNEL_IDS and channel_id not in ALLOWED_CHANNEL_IDS:
        logger.info("worker: channel %s not in allowlist", channel_id)
        return None

    itype = str(inner.get("type") or "")
    is_dm = str(inner.get("channel_type") or "") == "im"
    event_ts = str(inner.get("ts") or "")
    thread_ts = str(inner.get("thread_ts") or "")

    if not is_dm and itype != "app_mention":
        if not thread_ts:
            return None
        if not ddb_state.is_bot_thread(PLATFORM, thread_ts):
            return None

    raw_text = _strip_mention(str(inner.get("text") or ""))
    if not raw_text:
        return None

    user_id = str(inner.get("user") or "")
    # DM 不 thread（与 caps._post / main.py 同口径）；群里 thread 在用户那条上。
    root_id = "" if is_dm else (thread_ts or event_ts)
    # 「针对历史消息提问」在 Slack 里的唯一形态 = 在那条消息的 thread 里回复（B8 第 7
    # 项）。所以被引用的那条就是 thread 的父消息。`thread_ts == event_ts` 说明这条**就是**
    # thread 根（自己引用自己没有意义），排掉。正文要另外调 API 取。
    quoted_id = thread_ts if (thread_ts and thread_ts != event_ts) else ""

    # `_pre_locale` 口径 —— 不做自动检测，只看用户偏好 + 锁。否则 `language en` 这类
    # 纯 ASCII 命令会在 `set_user_pref` 之前把会话锁成 en。
    pre_locale, _ = locale_resolver.resolve(
        user_id=user_id, platform=PLATFORM, is_dm=is_dm,
        thread_root_id=root_id, text="",
    )
    return ImMessage(
        platform=PLATFORM,
        event_id=str(payload.get("event_id") or ""),
        chat_id=channel_id,
        user_id=user_id,
        text=raw_text,
        raw_text=raw_text,
        message_id=event_ts,
        root_message_id=root_id or event_ts,
        is_direct=is_dm,
        mentioned=(itype == "app_mention"),
        account_id="",
        locale=pre_locale,
        quoted_message_id=quoted_id,
    )


def _finalize_locale(im: ImMessage) -> ImMessage:
    """非命令类才允许 auto-detect + lock（多轮对话锁住会话语言）。与飞书 worker 同逻辑。"""
    from core import nl_router
    route = nl_router.classify(im.text)
    if route.kind != "":
        return im
    final_locale, source = locale_resolver.resolve(
        user_id=im.user_id, platform=PLATFORM, is_dm=im.is_direct,
        thread_root_id=im.root_message_id or "", text=im.text,
    )
    if source == "auto":
        if im.is_direct:
            locale_resolver.lock_for_dm(PLATFORM, im.user_id, final_locale)
        elif im.root_message_id:
            locale_resolver.lock_for_thread(PLATFORM, im.root_message_id,
                                            final_locale)
    return ImMessage(**{**im.__dict__, "locale": final_locale})


def _attach_quoted(im: ImMessage) -> ImMessage:
    """用户在某条历史消息的 thread 里提问 → 把那条的正文取回来当背景（B8 第 7 项）。

    与飞书 worker 同口径（`platforms/feishu/lambda_worker.py`）：
      · 只在「会把文本交给 agent」的三条能力上取（`chat` / `investigate` / `case`）——
        `/help`、`/language` 这些拿了也没用，白付一次 API 往返；
      · 取不到就**明说**（这条需求本身就是从"静默当没有"这个体验来的）。

    Slack 侧的取数是 `conversations.replies(channel, ts=thread_ts, limit=1)`，所以
    `channel` 必须一起带上（飞书那边 message_id 全局唯一，不需要）。

    ⚠️ 有意接受的一点冗余：Slack 没有"引用某条消息"这个事件字段，所以**thread 里的每一次
    追问**都会取一次 thread 根消息（多数情况下就是用户自己那第一句）。代价是一次
    `conversations.replies` 往返 + 最多 2000 字背景；换来的是"对着历史消息提问"必然
    可用。反过来做（猜哪次是真引用）会把 B8 第 7 项那个 bug 放回来。
    """
    if not im.quoted_message_id:
        return im
    from core import nl_router
    kind = nl_router.classify(im.text).kind or "chat"
    if kind not in router.QUOTE_AWARE_KINDS:
        return im
    im, failed = quoted_context.enrich(
        im, lambda mid: caps_mod.fetch_message_text(im.chat_id, mid))
    if failed:
        _CAPS.reply_text(im, i18n.t("im.quoted.fetch_failed", im.locale))
    return im


def _handle_message(payload: dict) -> None:
    im = _normalize_message(payload)
    if im is None:
        return

    # 幂等去重：Slack 对 Events API 会重试（同一个 event_id）。放在 worker 而不是
    # ingress —— ingress 已经 async 出去了，它并不知道 worker 是否真的处理成功。
    if not ddb_state.put_new_event(
            im.event_id, platform=PLATFORM, chat_id=im.chat_id,
            root_message_id=im.message_id, user_id=im.user_id,
            raw_text=im.raw_text, locale=im.locale):
        logger.info("worker: duplicate event %s — skipped", im.event_id)
        return

    # 标记 thread 为 bot-active，后续 follow-up 不需要再 @。DM 没有 thread，跳过。
    if not im.is_direct and im.root_message_id:
        ddb_state.mark_bot_thread(PLATFORM, im.root_message_id)

    im = _finalize_locale(im)
    im = _attach_quoted(im)
    router.dispatch(
        im, _CAPS,
        refusal_text=i18n.t("out_of_scope.change_request", im.locale),
    )


# ---------------------------------------------------------------------------
# slash command（`/devops`、`/language`）
# ---------------------------------------------------------------------------
#: `/devops` 是"通用入口"：后面那段原话直接交给 nl_router 分类（可能落到调查/案例/对话）。
#: 其它已注册的 slash 命令则把命令名**拼回文本**，让 nl_router 命中它的命令形式
#: （`/language zh` 必须带着 `/language` 才认）。
_GENERIC_SLASH = {"/devops"}


def _handle_slash(payload: dict) -> None:
    command = str(payload.get("command") or "").strip().lower()
    text = str(payload.get("text") or "").strip()
    channel_id = str(payload.get("channel_id") or "")
    user_id = str(payload.get("user_id") or "")
    trigger_id = str(payload.get("trigger_id") or "")

    if ALLOWED_CHANNEL_IDS and channel_id not in ALLOWED_CHANNEL_IDS:
        logger.info("worker: slash in channel %s not in allowlist", channel_id)
        return

    # Slack 的 slash payload 里 DM 的 channel_name 固定是 "directmessage"
    # （没有 channel_type 字段）。
    is_dm = str(payload.get("channel_name") or "") == "directmessage"

    routed_text = text if command in _GENERIC_SLASH else f"{command} {text}".strip()

    pre_locale, _ = locale_resolver.resolve(
        user_id=user_id, platform=PLATFORM, is_dm=is_dm,
        thread_root_id="", text="",
    )
    im = ImMessage(
        platform=PLATFORM,
        # slash 没有 event_id；trigger_id 每次调用唯一，正好当幂等键 + imtask 键。
        event_id=f"slash-{trigger_id}" if trigger_id else f"slash-{time.time()}",
        chat_id=channel_id, user_id=user_id,
        text=routed_text, raw_text=text,
        # slash 没有"用户那条消息"可以 thread，所以 message_id / root 都是空。
        message_id="", root_message_id="",
        is_direct=is_dm, mentioned=True, account_id="", locale=pre_locale,
    )
    if not routed_text:
        # 光打 `/devops` 不带内容 —— 给用法而不是把空串丢给 DevOps Agent。
        _CAPS.reply_text(im, i18n.t("main.command_usage", im.locale))
        return
    im = _finalize_locale(im)
    router.dispatch(
        im, _CAPS,
        refusal_text=i18n.t("out_of_scope.change_request", im.locale),
    )


# ---------------------------------------------------------------------------
# block_actions
# ---------------------------------------------------------------------------
#: 会调 `views_open` 的 action —— 需要 trigger_id 时效预检（坑 2）。
#: 名单来自 case_flow.handle_action 里三处 `client.views_open`。
_MODAL_ACTIONS = {"case_create_open_form", "case_reply_form", "case_reply_open_form"}


def _action_locale(action_value: str, user_id: str) -> str:
    """按钮上带的 locale 优先（渲染时是什么语言，点完还是什么语言），否则回落到偏好/锁。

    与 `case_flow._locale_from_action` 同一个约定 —— `im_blocks._btn_value` 就是按这个
    约定把 locale 塞进 value 的。
    """
    try:
        v = json.loads(action_value or "{}")
        loc = i18n.normalize_locale(str((v or {}).get("locale") or ""))
        if loc in ("zh", "en"):
            return loc
    except (ValueError, TypeError):
        pass
    loc, _ = locale_resolver.resolve(user_id=user_id, platform=PLATFORM,
                                     is_dm=True, thread_root_id="", text="")
    return loc


def _action_message(body: dict, action_value: str, locale: str) -> ImMessage:
    """`block_actions` → `ImMessage`，供 `im_*` 那三个 0-token 兜底按钮复用 `SlackCaps`。

    `is_direct` 按**真实频道类型**判：`container.channel_id` 以 `D` 开头 = DM。
    不能像飞书那样一律按 True 处理 —— Slack 上那会让群里点按钮的回复丢掉 thread，
    直接刷到频道主时间线。
    """
    channel_id = str((body.get("channel") or {}).get("id")
                     or (body.get("container") or {}).get("channel_id") or "")
    message = body.get("message") or {}
    msg_ts = str(message.get("ts") or (body.get("container") or {}).get("message_ts") or "")
    thread_ts = str(message.get("thread_ts") or "")
    user_id = str((body.get("user") or {}).get("id") or "")
    is_dm = channel_id.startswith("D")
    try:
        text = str((json.loads(action_value or "{}") or {}).get("q") or "")
    except (ValueError, TypeError):
        text = ""
    root = "" if is_dm else (thread_ts or msg_ts)
    return ImMessage(
        platform=PLATFORM,
        event_id=f"act-{str(body.get('trigger_id') or msg_ts)}",
        chat_id=channel_id, user_id=user_id,
        text=text, raw_text=text,
        message_id=msg_ts, root_message_id=root or msg_ts,
        is_direct=is_dm, mentioned=True, account_id="", locale=locale,
    )


def _handle_block_actions(body: dict, elapsed: float) -> None:
    action = (body.get("actions") or [{}])[0] or {}
    action_id = str(action.get("action_id") or "")
    # Slack 的按钮 value 是**字符串**（飞书是 JSON 对象）。分流键在 `action_id`，
    # 不在 value 里 —— 与飞书刚好相反，抄那边会拿到空 tag。
    action_value = str(action.get("value") or "")

    if not action_id:
        logger.warning("block_actions: no action_id — dropped")
        return

    # url-only 按钮（`im_open_console` / `open_*`）：Slack 仍然会发回调，什么都不用做。
    # 对齐 main.py:1881 那个 `^open_` catch-all。
    if action_id == "im_open_console" or action_id.startswith("open_"):
        return

    if action_id.startswith("im_"):
        locale = _action_locale(action_value, str((body.get("user") or {}).get("id") or ""))
        _handle_im_action(action_id, body, action_value, locale)
        return

    client = get_client()

    # trigger_id 时效预检（坑 2）。base_action 要先剥掉 `:<display_id>` 后缀 ——
    # case_flow 用它区分列表行上的同名按钮（case_flow.py:305）。
    base_action = action_id.split(":", 1)[0]
    if base_action in _MODAL_ACTIONS and elapsed > _TRIGGER_BUDGET:
        _retry_modal_button(client, body, action_id, action_value, elapsed)
        return

    before = set(threading.enumerate())
    try:
        # ⚠️ 分流顺序照抄 main.py：`^case_` 先命中 case_flow（main.py:1836）。
        # `case_sync_report` 的实现在 support_flow，以前被这条顺序吃掉（两条路径
        # 都点不动），现在由 `case_flow.handle_action` 自己转发过去 —— 修在共享层，
        # 所以长连接和 webhook 行为一致，这里不需要（也不许）加特例分支。
        if base_action.startswith("case_"):
            from platforms.slack.app import case_flow
            case_flow.handle_action(action_id, body, client)
        elif base_action in ("ask_support", "cancel_support"):
            from platforms.slack.app import support_flow
            support_flow.handle_action(base_action, body, client)
        else:
            # skill_* / confirm_dispatch / edit_dispatch —— 这些卡片只有 Fargate 路径
            # 会渲染出来（webhook 路径的 skills 只回一句引导）。真收到了说明用户点了
            # 一张切换前留下的旧卡片：给一句人话，别静默。
            logger.info("block_actions: legacy action %s (Fargate-era card)", action_id)
            locale = _action_locale(action_value,
                                    str((body.get("user") or {}).get("id") or ""))
            im = _action_message(body, action_value, locale)
            if im.chat_id:
                _CAPS.reply_text(im, i18n.t("im.action.unknown", locale))
            return
    except Exception as e:                    # noqa: BLE001
        logger.exception("block_actions %s failed: %s", action_id, type(e).__name__)
    finally:
        _join_spawned(before, action_id)


def _retry_modal_button(client, body: dict, action_id: str,
                        action_value: str, elapsed: float) -> None:
    """trigger_id 已经（或即将）过期 —— 重发一个同样的按钮，让用户再点一次。

    第二次点击时 worker 已经是热的（~200ms），`views_open` 稳过。**不要**试着照旧调
    `views_open` 再看它失败：`case_flow` 把那个异常自己吞了（case_flow.py:325），
    用户侧的表现是"点了没反应"。
    """
    channel_id = str((body.get("channel") or {}).get("id")
                     or (body.get("container") or {}).get("channel_id") or "")
    message = body.get("message") or {}
    thread_ts = str(message.get("thread_ts") or message.get("ts") or "")
    locale = _action_locale(action_value,
                           str((body.get("user") or {}).get("id") or ""))
    logger.info("block_actions %s: trigger_id budget exceeded (%.2fs) — "
                "re-posting the button", action_id, elapsed)
    from platforms.slack.app import blocks
    try:
        client.chat_postMessage(
            channel=channel_id,
            thread_ts=thread_ts or None,
            text=i18n.t("im.action.retry_hint", locale),
            blocks=[
                blocks.section(i18n.t("im.action.retry_hint", locale)),
                blocks.actions(
                    # 原样带回 action_id 与 value：再点一次走的是同一条分支。
                    blocks.button(i18n.t("im.action.retry_btn", locale),
                                  action_id, value=action_value or None),
                ),
            ],
        )
    except Exception as e:                    # noqa: BLE001
        logger.warning("re-post modal button failed: %s", type(e).__name__)


def _handle_im_action(action_id: str, body: dict, action_value: str,
                      locale: str) -> None:
    """M1 新增的三个双向兜底按钮 —— 全部 0 token（`im_open_case` 走案例路径，
    那条本身保留 LLM）。按钮 value 里带着（截断后的）原始问题。"""
    im = _action_message(body, action_value, locale)
    if not im.chat_id:
        logger.warning("im action %s: no channel — dropped", action_id)
        return
    if not im.text:
        _CAPS.reply_text(im, i18n.t("im.action.no_context", locale))
        return
    if action_id == "im_escalate_investigate":
        _CAPS.investigate(im, im.text)
    elif action_id == "im_open_case":
        _CAPS.case(im, "case_create", "", im.text)
    elif action_id == "im_just_answer":
        _CAPS.chat(im, im.text)
    else:
        logger.warning("im action %s: unknown", action_id)
        _CAPS.reply_text(im, i18n.t("im.action.unknown", locale))


# ---------------------------------------------------------------------------
# view_submission
# ---------------------------------------------------------------------------
class _AckShim:
    """替代 bolt 的 `ack` —— ingress 早就回过 200 了（modal 已关闭）。

    `case_flow` / `support_flow` 用 `ack(response_action="errors", errors={...})` 把校验
    错误显示在 modal 里。modal 已经不在了，所以这里把 errors 转成一条发到原频道的消息。
    不这么做的话，"标题为空"这类校验失败会**静默丢掉**用户刚填完的整个表单
    （违反「不许静默降级」）。

    `response_action="clear"` / 无参调用 = "提交成功、关掉 modal" —— 已经关了，无事可做。
    """

    def __init__(self, client, channel_id: str, thread_ts: str, locale: str):
        self._client = client
        self._channel = channel_id
        self._thread = thread_ts
        self._locale = locale
        self.errored = False

    def __call__(self, *_args, **kwargs) -> None:
        if kwargs.get("response_action") != "errors":
            return
        self.errored = True
        errors = kwargs.get("errors") or {}
        # errors 的值就是给用户看的那句话（case_flow 已经按 locale 取过 i18n）。
        text = "\n".join(f"• {v}" for v in errors.values() if v)
        if not (text and self._channel):
            logger.warning("ack shim: validation error with no channel to report to")
            return
        try:
            self._client.chat_postMessage(
                channel=self._channel, thread_ts=self._thread or None,
                text=text,
                blocks=im_blocks.text_blocks(text, self._locale),
            )
        except Exception as e:                # noqa: BLE001
            logger.warning("ack shim: postMessage failed: %s", type(e).__name__)


def _view_meta(view: dict) -> tuple[str, str, str]:
    """从 `private_metadata` 取 (channel_id, thread_ts, locale)。

    `case_create_view` / `case_reply_view` / `confirm_support` 三个 modal 都往
    private_metadata 里塞了这三个字段（case_flow.py:768/823，support_flow.py:288）。
    """
    try:
        pm = json.loads(view.get("private_metadata") or "{}")
    except (ValueError, TypeError):
        pm = {}
    if not isinstance(pm, dict):
        pm = {}
    # ⚠️ `normalize_locale("")` 返回的是 **"auto"**，不是空串 —— 不能写
    # `normalize_locale(...) or "en"`（那个 `or` 永远不会触发，最后把 "auto" 当 locale
    # 传给 i18n.t）。只认 zh/en，其余一律 en（Slack 的默认语言，与飞书的 zh 不同）。
    loc = i18n.normalize_locale(str(pm.get("locale") or ""))
    if loc not in ("zh", "en"):
        loc = "en"
    return (str(pm.get("channel_id") or ""), str(pm.get("thread_ts") or ""), loc)


def _handle_view_submission(body: dict) -> None:
    view = body.get("view") or {}
    callback = str(view.get("callback_id") or "")
    if not callback:
        logger.warning("view_submission: no callback_id — dropped")
        return
    client = get_client()
    channel_id, thread_ts, locale = _view_meta(view)
    ack = _AckShim(client, channel_id, thread_ts, locale)

    before = set(threading.enumerate())
    try:
        if callback.startswith("case_"):
            from platforms.slack.app import case_flow
            case_flow.handle_view_submission(callback, ack, body, view, client)
        elif callback == "confirm_support":
            from platforms.slack.app import support_flow
            support_flow.handle_view_submission(ack, body, view, client)
        else:
            # skill_author_edit_submit / edit_dispatch_submit —— Fargate 时代的 modal。
            logger.info("view_submission: legacy callback %s", callback)
            ack(response_action="errors",
                errors={"_": i18n.t("im.action.unknown", locale)})
    except Exception as e:                    # noqa: BLE001
        logger.exception("view_submission %s failed: %s", callback,
                         type(e).__name__)
        if not ack.errored:
            ack(response_action="errors",
                errors={"_": i18n.t("main.modal_submit_failed", locale,
                                    detail=type(e).__name__)})
    finally:
        _join_spawned(before, callback)


# ---------------------------------------------------------------------------
# 共用
# ---------------------------------------------------------------------------
def _join_spawned(before: set, what: str) -> None:
    """把 handler 新起的 daemon 线程 join 掉（坑 4）。

    Lambda 在 handler 返回后**冻结**执行环境，daemon 线程就地消失 —— 用户会看到
    「正在创建案例…」然后永远没有下文。
    """
    for t in [t for t in threading.enumerate() if t not in before]:
        try:
            t.join(timeout=_THREAD_JOIN_TIMEOUT)
            if t.is_alive():
                logger.error("%s: worker thread still running after %ds",
                             what, _THREAD_JOIN_TIMEOUT)
        except RuntimeError as e:
            logger.warning("%s: thread join failed: %s", what, type(e).__name__)


def handler(event: dict, context) -> dict:
    """Lambda entry。永不抛（异步调用抛异常会进 DLQ，我们没配 DLQ）。"""
    # 先记下"本次调用还剩多久"—— `chat_lease` 拿它算能排多久队、租约给多长 TTL。
    # 必须在这里做：`Caps` 协议里没有 context，深处再拿不到（见 lambda_deadline.py）。
    lambda_deadline.set_from_context(context)
    try:
        kind = str((event or {}).get("kind") or "")
        payload = (event or {}).get("payload") or {}
        # ingress 盖的投递时刻 —— 只有 trigger_id 时效预检用得到。
        try:
            elapsed = max(0.0, time.time() - float((event or {}).get("ts") or 0))
        except (TypeError, ValueError):
            elapsed = 0.0

        if kind == "message":
            _handle_message(payload)
        elif kind == "slash":
            _handle_slash(payload)
        elif kind == "block_actions":
            _handle_block_actions(payload.get("payload") or {}, elapsed)
        elif kind == "view_submission":
            _handle_view_submission(payload.get("payload") or {})
        else:
            logger.warning("worker: unknown kind=%s", kind)
    except Exception as e:                    # noqa: BLE001
        logger.exception("worker: swallow %s", type(e).__name__)
    return {"ok": True}
