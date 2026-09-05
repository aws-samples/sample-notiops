"""Feishu worker Lambda（IM 重构 / M1）—— 真正干活儿的那个。

由 ingress 用 `InvocationType='Event'` 异步投递触发。事件形状：
  ``{"kind": "message" | "card_action", "payload": {...}, "ts": <epoch>}``

职责：
  1. **幂等去重**（§6.3）—— 用 `ddb_state.put_new_event` 挡住 Feishu 的自动重试；
  2. **locale 解析**（§8.1.4 #3）—— 命令类要用 `_pre_locale`（用户偏好 + 锁，
     **不自动检测**）；否则 `language en` 之类会在 `set_user_pref` 之前把 DM 锁成 en；
  3. **规范化事件**成 `ImMessage`，调用 `platforms.common.router.dispatch` 落到
     `FeishuCaps` 上；
  4. **卡片按钮**（card_action）—— 首版直接沿用平台里现成的 case_flow / support_flow /
     skill_commands 的 handler；这一层只做 dict → SDK 对象的解码。
"""
from __future__ import annotations

import json
import logging
import os
import threading

import lark_oapi as lark
from lark_oapi.api.im.v1 import P2ImMessageReceiveV1
from lark_oapi.event.callback.model.p2_card_action_trigger import (
    P2CardActionTrigger,
)

from core import bedrock_credentials
from core import ddb_state
from core import i18n
from core import locale_resolver
from platforms.common import lambda_deadline, quoted_context, router
from platforms.common.im_types import ImMessage
from platforms.feishu import bot_identity
from platforms.feishu.app import feishu_utils
from platforms.feishu.caps import FeishuCaps, PLATFORM

logger = logging.getLogger()
logger.setLevel(logging.INFO)

ALLOWED_CHAT_IDS = {
    c.strip() for c in os.environ.get("ALLOWED_CHAT_IDS", "").split(",")
    if c.strip()
}

# main.py 的后台线程最多等多久。worker 的 Lambda timeout 是 900s，留足余量给
# `create_investigation`（实测个位数秒，但跨账号 AssumeRole 慢时会到几十秒）。
_THREAD_JOIN_TIMEOUT = 600

# 每次冷启动装一次 bedrock 凭证（case 路径用到 analyze_intent）
try:
    bedrock_credentials.install()
except Exception as e:                        # noqa: BLE001
    logger.warning("bedrock_credentials.install failed: %s", type(e).__name__)


_CAPS = FeishuCaps()


def _normalize_message(event: P2ImMessageReceiveV1) -> ImMessage | None:
    """SDK P2 对象 → 规范化 ImMessage。返回 None = 应该丢弃（不响应）。"""
    msg = event.event.message
    sender = event.event.sender
    chat_id = msg.chat_id or ""
    if ALLOWED_CHAT_IDS and chat_id not in ALLOWED_CHAT_IDS:
        logger.info("worker: chat %s not in allowlist", chat_id)
        return None
    if msg.message_type != "text":
        return None

    root_id = getattr(msg, "root_id", "") or ""
    # `parent_id` = 用户点「回复」/「在话题中回复」时**被回复的那一条**（B8 第 7 项）。
    # 与 root_id 不是一回事：对一条不在任何话题里的历史消息回复时两者相同，在长话题里
    # 回复中间某条时 parent_id 才是那条。正文要另外调 API 取（事件里只有 id）。
    parent_id = getattr(msg, "parent_id", "") or ""
    in_bot_thread = bool(root_id) and ddb_state.is_bot_thread(PLATFORM, root_id)
    is_dm = msg.chat_type == "p2p"
    mentioned = _is_bot_mentioned(msg)
    if not is_dm and not mentioned and not in_bot_thread:
        return None

    try:
        raw_payload = json.loads(msg.content or "{}")
    except (ValueError, TypeError):
        raw_payload = {}
    raw_text = feishu_utils.strip_at_mention(raw_payload.get("text", "") or "")
    if not raw_text:
        return None

    user_id = ""
    try:
        if sender and sender.sender_id:
            user_id = sender.sender_id.open_id or ""
    except AttributeError:
        pass

    # `_pre_locale` 口径 —— 见 §8.1.4 #3：**不做自动检测**，只看用户偏好 + 锁；
    # 自动检测放到「非命令」的分支里再做（此时 raw_text 里已经不是 language/model
    # 那种 ASCII 命令词）。
    pre_locale, _ = locale_resolver.resolve(
        user_id=user_id, platform=PLATFORM, is_dm=is_dm,
        thread_root_id=root_id or "", text="",
    )
    return ImMessage(
        platform=PLATFORM,
        event_id=event.header.event_id or "",
        chat_id=chat_id,
        user_id=user_id,
        text=raw_text,
        raw_text=raw_text,
        message_id=msg.message_id or "",
        root_message_id=root_id or msg.message_id or "",
        is_direct=is_dm,
        mentioned=mentioned,
        account_id="",
        locale=pre_locale,
        quoted_message_id=parent_id,
    )


def _is_bot_mentioned(msg) -> bool:
    """这条消息 @ 到的是不是**本** bot —— 比对 `mentions[].id.open_id`。

    判据与实现都在 `platforms/feishu/bot_identity.py`（ingress 用的是同一个模块，
    两边口径由此不可能再漂）。**不要**退回成「有 mentions 就算」：飞书没有 Slack 的
    `app_mention` 事件类型，群里每一句话都投过来，那样写会让同一个群里的两个 NotiOps
    bot（测试 + 生产）一起抢答。
    """
    return bot_identity.is_bot_mentioned(msg)


def _handle_message(event_dict: dict) -> None:
    """P2ImMessageReceiveV1 dict → ImMessage → router.dispatch → FeishuCaps。"""
    # SDK 反序列化：接受 JSON 字符串
    event = lark.JSON.unmarshal(json.dumps(event_dict), P2ImMessageReceiveV1)
    im = _normalize_message(event)
    if im is None:
        return

    # 幂等去重：Feishu 会重试；用 event_id 挡住第二次。**放在这里**（worker）而不是
    # ingress —— ingress 已经 async 出去了，它并不知道 worker 是否真的处理成功。§6.3。
    if not ddb_state.put_new_event(
            im.event_id, platform=PLATFORM, chat_id=im.chat_id,
            root_message_id=im.message_id, user_id=im.user_id,
            raw_text=im.raw_text, locale=im.locale):
        logger.info("worker: duplicate event %s — skipped", im.event_id)
        return

    # 标记 thread 为 bot-active，后续 follow-up 不需要再 @
    ddb_state.mark_bot_thread(PLATFORM, im.root_message_id or im.message_id)

    # 命令用 `_pre_locale`；非命令类再做 auto-detect + lock（`resolve` 带 text 版本）
    from core import nl_router
    route = nl_router.classify(im.text)
    if route.kind == "":
        # 走 chat 分支之前，允许 auto-detect + lock（多轮对话锁 thread 语言）
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
        im = ImMessage(**{**im.__dict__, "locale": final_locale})

    # 用户对着一条历史消息回复 → 把那条的正文取回来当背景（B8 第 7 项）。
    # 只在"会把文本交给 agent"的三条能力上取：`/help`、`/language` 这些拿了也没用，
    # 白付一次 API 往返。取不到就**明说**（这条需求本身就是从"静默当没有"来的）。
    kind = route.kind or "chat"
    if kind in router.QUOTE_AWARE_KINDS and im.quoted_message_id:
        im, quote_failed = quoted_context.enrich(
            im, feishu_utils.get_message_text)
        if quote_failed:
            _CAPS.reply_text(im, i18n.t("im.quoted.fetch_failed", im.locale))

    router.dispatch(
        im, _CAPS,
        refusal_text=i18n.t("out_of_scope.change_request", im.locale),
    )


def _action_message(event: P2CardActionTrigger, action_value: dict) -> ImMessage:
    """卡片回调 → `ImMessage`，供 `im_*` 那三个 0-token 兜底按钮复用 `FeishuCaps`。

    卡片回调事件里**没有** chat_type，所以 `is_direct` 只能按 True 处理（影响的仅是
    `reply_text` 用行内引用还是话题回复；这三条路径发的都是卡片，不受影响）。
    """
    ctx = getattr(event.event, "context", None)
    op = getattr(event.event, "operator", None)
    chat_id = getattr(ctx, "open_chat_id", "") or ""
    card_message_id = getattr(ctx, "open_message_id", "") or ""
    user_id = getattr(op, "open_id", "") or ""
    # 命令口径：只看用户偏好 + 锁，不自动检测（§8.1.4 #3）
    pre_locale, _ = locale_resolver.resolve(
        user_id=user_id, platform=PLATFORM, is_dm=True,
        thread_root_id="", text="",
    )
    text = str(action_value.get("q") or "")
    return ImMessage(
        platform=PLATFORM,
        event_id=getattr(event.header, "event_id", "") or "",
        chat_id=chat_id, user_id=user_id,
        text=text, raw_text=text,
        message_id=card_message_id, root_message_id=card_message_id,
        is_direct=True, mentioned=True, account_id="", locale=pre_locale,
    )


def _response_card(resp) -> dict | None:
    """从 `P2CardActionTriggerResponse` 里取出要替换上去的卡片（没有就 None）。"""
    try:
        card = getattr(resp, "card", None)
        data = getattr(card, "data", None)
        return data if isinstance(data, dict) else None
    except AttributeError:
        return None


def _response_toast(resp) -> str:
    try:
        return str(getattr(getattr(resp, "toast", None), "content", "") or "")
    except AttributeError:
        return ""


def _handle_card_action(event_dict: dict) -> None:
    """卡片按钮回调。

    两类 tag：
      1. `im_*` —— M1 新增的三个 0-token 兜底按钮（升级调查 / 开案例 / 只要答案），
         直接落到 `FeishuCaps` 上；
      2. 其它 —— 全部委托给 `platforms/feishu/app/main.py::on_card_action`。那 600 行
         分流表（case_* / support / skill / dispatch / edit_dispatch …）已经在线上跑了
         很久，重写一遍只会引入回归。

    ⚠️ **两个 webhook 特有的坑**（长连接下不存在）：
      · `on_card_action` 是给 `card.action.trigger` **同步回复**设计的：它把新卡片放在
        返回值里让飞书客户端就地替换。webhook 路径下 ingress 早就 ACK 过了，所以这里
        必须把 `resp.card.data` 主动 PATCH 到 `open_message_id` 上；
      · 它内部会 `threading.Thread(daemon=True).start()` 去干重活（比如
        `confirm_dispatch`）。Lambda 在 handler 返回后会**冻结执行环境**，daemon 线程
        直接消失。所以调用前后各快照一次 `threading.enumerate()`，把新起的线程 join 掉
        （worker timeout 900s，够它们跑完）。
    """
    event = lark.JSON.unmarshal(json.dumps(event_dict), P2CardActionTrigger)
    action_value: dict = {}
    try:
        av = event.event.action.value
        action_value = av if isinstance(av, dict) else {}
    except AttributeError:
        logger.warning("card_action: no action.value — dropped")
        return
    # ⚠️ tag 不是 `action.tag`（那永远是 "button"）—— 分流键在 value["action"] 里。
    action_tag = str(action_value.get("action") or "")

    if action_tag.startswith("im_"):
        _handle_im_action(event, action_tag, action_value)
        return

    from platforms.feishu.app import main as feishu_main

    before = set(threading.enumerate())
    try:
        resp = feishu_main.on_card_action(event)
    except Exception as e:                    # noqa: BLE001
        logger.exception("card_action %s failed: %s", action_tag, type(e).__name__)
        return
    spawned = [t for t in threading.enumerate() if t not in before]

    card = _response_card(resp)
    # 后台线程已经跑完 = 它已经把终态卡 PATCH 上去了；这时再贴我们手里这张（ACK）卡
    # 会把结果覆盖回"处理中"。只有"还没跑完 / 根本没起线程"时才由我们写。
    already_finished = bool(spawned) and not any(t.is_alive() for t in spawned)
    message_id = ""
    try:
        message_id = event.event.context.open_message_id or ""
    except AttributeError:
        pass
    if card and message_id and not already_finished:
        try:
            feishu_utils.update_card(message_id, card)
        except Exception as e:                # noqa: BLE001
            logger.warning("card_action: update_card failed: %s", type(e).__name__)
    elif not card:
        # 只有 toast 的 handler（例如"已取消"）—— webhook 下 toast 没法回给客户端，
        # 补一条文本，别让用户点了按钮什么反馈都没有。
        toast = _response_toast(resp)
        if toast and message_id:
            try:
                feishu_utils.reply_text(message_id, toast, in_thread=False)
            except Exception as e:            # noqa: BLE001
                logger.warning("card_action: toast reply failed: %s", type(e).__name__)

    for t in spawned:
        try:
            t.join(timeout=_THREAD_JOIN_TIMEOUT)
            if t.is_alive():
                logger.error("card_action %s: worker thread still running after %ds",
                             action_tag, _THREAD_JOIN_TIMEOUT)
        except RuntimeError as e:
            logger.warning("card_action: join failed: %s", type(e).__name__)


def _handle_im_action(event: P2CardActionTrigger, action_tag: str,
                      action_value: dict) -> None:
    """M1 新增的三个双向兜底按钮 —— 全部 0 token（`im_open_case` 走案例路径，那条本身
    保留 LLM）。按钮 `value["q"]` 带着（截断后的）原始问题。"""
    im = _action_message(event, action_value)
    if not im.chat_id:
        logger.warning("im action %s: no chat_id — dropped", action_tag)
        return
    if not im.text:
        _CAPS.reply_text(im, i18n.t("im.action.no_context", im.locale))
        return
    if action_tag == "im_escalate_investigate":
        _CAPS.investigate(im, im.text)
    elif action_tag == "im_open_case":
        _CAPS.case(im, "case_create", "", im.text)
    elif action_tag == "im_just_answer":
        _CAPS.chat(im, im.text)
    else:
        logger.warning("im action %s: unknown tag", action_tag)
        _CAPS.reply_text(im, i18n.t("im.action.unknown", im.locale))


def handler(event: dict, context) -> dict:
    """Lambda entry。永不抛（异步调用抛异常会进 DLQ，我们没配 DLQ）。"""
    # 先记下"本次调用还剩多久"—— `chat_lease` 拿它算能排多久队、租约给多长 TTL。
    # 必须在这里做：`Caps` 协议里没有 context，深处再拿不到（见 lambda_deadline.py）。
    lambda_deadline.set_from_context(context)
    try:
        kind = str((event or {}).get("kind") or "")
        payload = (event or {}).get("payload") or {}
        ev = payload.get("event")
        # ingress 存的是 lark.JSON.marshal 出来的字符串
        ev_dict = json.loads(ev) if isinstance(ev, str) else (ev or {})
        if kind == "message":
            _handle_message(ev_dict)
        elif kind == "card_action":
            _handle_card_action(ev_dict)
        else:
            logger.warning("worker: unknown kind=%s", kind)
    except Exception as e:                    # noqa: BLE001
        logger.exception("worker: swallow %s", type(e).__name__)
    return {"ok": True}
