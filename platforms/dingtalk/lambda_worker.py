"""钉钉 worker Lambda（IM 重构 / M4）—— 真正干活儿的那个。

由 ingress 用 `InvocationType='Event'` 异步投递触发。事件形状：
  ``{"kind": "message", "payload": {<钉钉原始回调报文>}, "ts": <float epoch>}``

职责与 `platforms/feishu/lambda_worker.py` / `platforms/slack/lambda_worker.py`
一一对应（幂等去重 → locale → 规范化成 `ImMessage` →
`platforms.common.router.dispatch` → `DingtalkCaps`），下面只写**钉钉特有**的五件事。

── ⚠️ 坑 1：绝不能 import `platforms/dingtalk/app/main.py` ─────────────────────
那个模块是 Fargate 常驻形态（`dingtalk-stream` 长连接），且在缺凭证时进
`while True: time.sleep(3600)` —— Fargate 上那是"等人填凭证"，Lambda 上是**必然
超时**。同 Slack worker 的坑 1。所以这条路径**一行都不复用** `app/`：
`strip_at_mention` 这类纯字符串变换在下面自己留一份（与 Slack worker 对 `main.py:138`
那条正则的处理同一个取舍 —— 宁可两份 3 行的纯函数，也不要 Lambda 依赖 Fargate 模块）。

── ⚠️ 坑 2：回复凭证在**进程全局**，必须 bind / clear 成对 ─────────────────────
钉钉的会话内回复靠入站报文带来的 `sessionWebhook`（≈90 分钟有效）。`ImMessage` 是三
平台共享契约，不给它加钉钉专属字段，所以这个上下文放在
`platforms/dingtalk/sender.py` 的模块级 `Session` 里，由这里 `bind()`。

**`clear()` 必须在 `finally` 里**：Lambda 复用执行环境，不清就把上一条消息的
`sessionWebhook` 留给下一次调用 —— 表现是**回复串到别的会话去**，而且完全静默。

── ⚠️ 坑 3：「确认」要在 `router.dispatch` **之前**截 ──────────────────────────
钉钉的按钮只能跳 URL（设计文档 §4.2），所以开案例 / 关案例的二次确认靠**用户回一句
「确认」**。那一句话对 `nl_router` 来说就是一句普通闲聊，走到 `dispatch` 就会被当成
问题发给 agent（用户看到的是"我说确认，它开始答一段废话"）。所以
`case_text.maybe_handle_confirm()` 必须在 dispatch 之前问一次，返回 True 就到此为止。

── ⚠️ 坑 4：没有 thread，所以群里**不锁**会话语言 ─────────────────────────────
飞书/Slack 的自动语言锁是**按 thread** 存的（`lock_for_thread`）—— 一个 thread 说中文
就一直中文，不影响群里别人。钉钉没有 thread，唯一可用的作用域是"整个会话"，那会让一个
人问一句英文把整个群翻成英文。所以这里只在**单聊**里锁（`lock_for_dm`），群里每条消息
各自检测。`/language`（用户偏好）在两种场合都照常生效且优先级更高。

── ⚠️ 坑 5：没有引用消息 ──────────────────────────────────────────────────────
钉钉 HTTP 回调不带"被回复的那条消息"（设计文档 §4.3），所以这里**没有** Slack worker
的 `_attach_quoted` 对位段落，`quoted_*` 恒空、`router.QUOTE_AWARE_KINDS` 那条增强路径
自然是 no-op。**不模拟**（反查历史消息要额外权限 + 一次 API 往返，换来的只是猜）。

**日志纪律**：不记 `sessionWebhook`（它就是凭证）、不记用户问题原文、不记
`senderStaffId`（人员标识；`ImMessage.user_id` 落库是业务必需，但**不进日志**）。
"""
from __future__ import annotations

import logging
import os
import threading

from core import bedrock_credentials
from core import ddb_state
from core import i18n
from core import im_accounts
from core import locale_resolver
from platforms.common import lambda_deadline, router
from platforms.common.im_types import ImMessage
from platforms.dingtalk import case_text, sender
from platforms.dingtalk.caps import PLATFORM, DingtalkCaps

logger = logging.getLogger()
logger.setLevel(logging.INFO)

#: 会话允许清单（空 = 不限制）。变量名与另外两家的对位物**刻意不同**
#: （飞书 `ALLOWED_CHAT_IDS` / Slack `ALLOWED_CHANNEL_IDS`）—— 钉钉的标识叫
#: `conversationId`，用平台自己的词，免得三家混用同一个名字时改错一处。
ALLOWED_CONVERSATION_IDS = {
    c.strip() for c in os.environ.get("ALLOWED_CONVERSATION_IDS", "").split(",")
    if c.strip()
}

#: 后台线程最多等多久（同另外两家）。
_THREAD_JOIN_TIMEOUT = 600

# 每次冷启动装一次 bedrock 凭证 —— 案例路径的两处模型调用要用
# （`core.case_analyze` 与开案例时的主题摘要）。失败不阻断：其余九条能力都是 0 token，
# 不能因为案例分析用不了就整个 worker 起不来。
try:
    bedrock_credentials.install()
except Exception as e:                        # noqa: BLE001
    logger.warning("bedrock_credentials.install failed: %s", type(e).__name__)

_CAPS = DingtalkCaps()


def _strip_mention(text: str) -> str:
    """去掉开头那个 `@机器人名 `。

    钉钉的 @ 没有 Slack 那种 `<@U123ABC>` 标记，就是**字面的显示名**加一个空格，而显示
    名每个部署都不一样 —— 所以按"以 `@` 开头则丢掉第一段非空白"这个形状剥，不按名字。
    与 `platforms/dingtalk/app/dingtalk_utils.py::strip_at_mention` 同口径（坑 1 说明了
    为什么不直接 import 那一份）；两处要一起改。
    """
    s = (text or "").lstrip()
    if not s.startswith("@"):
        return s.strip()
    parts = s.split(None, 1)
    return parts[1].strip() if len(parts) > 1 else ""


def _extract_text(body: dict) -> str:
    """HTTP 回调模式在**顶层 `content`**，Stream 模式在 `text.content` —— 两个都读。

    与 `platforms/dingtalk/lambda_ingress.py::_extract_text` 同一份（ingress 用它做
    "一个字都没有就别投 worker"的闸门）。3 行的纯函数，两处各留一份而不是互相 import：
    ingress 的冷启动要尽量瘦，而 worker 也不该反向依赖 ingress。
    """
    text = body.get("text")
    if isinstance(text, dict) and text.get("content"):
        return str(text["content"])
    return str(body.get("content") or "")


# ---------------------------------------------------------------------------
# 规范化
# ---------------------------------------------------------------------------
def _normalize(payload: dict) -> ImMessage | None:
    """钉钉回调报文 → 规范化 `ImMessage`。返回 None = 应该丢弃（不响应）。

    钉钉的受理判定比另外两家简单得多：平台**只在**"@了机器人"或"单聊"时才推送
    （群里的普通闲聊压根不会到这儿）。所以没有 Slack 那三条
    "DM / app_mention / bot 回过话的 thread"的分层判定，`mentioned` 恒 True。
    """
    conversation_id = str(payload.get("conversationId") or "")
    if ALLOWED_CONVERSATION_IDS and conversation_id not in ALLOWED_CONVERSATION_IDS:
        logger.info("worker: conversation %s not in allowlist", conversation_id)
        return None

    raw_text = _strip_mention(_extract_text(payload))
    if not raw_text:
        return None

    # "1" 单聊 / "2" 群聊。缺字段时按**群**处理（更保守：群里回复会 @ 回提问人，
    # 而按单聊处理会在兜底投递时把消息发成一对一私聊 —— 那才是真的发错地方）。
    is_dm = str(payload.get("conversationType") or "2") == "1"
    user_id = str(payload.get("senderStaffId") or "")
    msg_id = str(payload.get("msgId") or "")

    # `_pre_locale` 口径 —— 不做自动检测，只看用户偏好 + 锁。否则 `language en` 这类
    # 纯 ASCII 命令会在 `set_user_pref` 之前把会话锁成 en。三家逐字一致。
    # `thread_root_id` 恒空：钉钉没有 thread（坑 4）。
    pre_locale, _ = locale_resolver.resolve(
        user_id=user_id, platform=PLATFORM, is_dm=is_dm,
        thread_root_id="", text="",
    )
    return ImMessage(
        platform=PLATFORM,
        # 钉钉没有独立的 event_id，`msgId` 就是幂等键（平台重试用同一个 msgId）。
        event_id=msg_id,
        chat_id=conversation_id,
        user_id=user_id,
        text=raw_text,
        raw_text=raw_text,
        message_id=msg_id,
        # **刻意留空**：这个字段的语义是"可以拿来回复/更新的消息句柄"。钉钉发出去的
        # 消息拿不到 id，`msgId` 是**用户那条**的 id，填进去会让下游（进度轮询、报告
        # 回写）以为有一条可更新的消息。见设计文档 §4.4。
        root_message_id="",
        is_direct=is_dm,
        # 平台只在 @ 或单聊时推送，所以到这里必然是"在跟机器人说话"。
        mentioned=True,
        # 「这个会话在问哪个 AWS 账号」—— 空 = 部署账号。与另外两家同一句：没设过偏好
        # 时一次 GetItem 就短路，设过才多一次注册表校验。见 `core/im_accounts.py`。
        account_id=im_accounts.resolve(
            platform=PLATFORM, chat_id=conversation_id, user_id=user_id,
            is_dm=is_dm),
        locale=pre_locale,
        user_name=str(payload.get("senderNick") or ""),
        # 钉钉不带被引用的消息（坑 5）—— `quoted_*` 全部留默认空值。
    )


def _bind_session(payload: dict, im: ImMessage) -> None:
    """把这一轮的回复凭证绑到 `sender` 的模块级 Session（坑 2）。

    `sessionWebhookExpiredTime` 是**毫秒**时刻。缺字段时 `Session.webhook_usable()`
    当"可用"处理（理由见那个方法的 docstring）。
    """
    try:
        expires_ms = int(payload.get("sessionWebhookExpiredTime") or 0)
    except (TypeError, ValueError):
        expires_ms = 0
    sender.bind(sender.Session(
        webhook=str(payload.get("sessionWebhook") or ""),
        expires_ms=expires_ms,
        conversation_id=im.chat_id,
        is_direct=im.is_direct,
        staff_id=im.user_id,
        robot_code=str(payload.get("robotCode") or ""),
        # 群里回复默认 @ 回提问人（`caps._at` 会按场合决定要不要用）。
        at_user_ids=[im.user_id] if (im.user_id and not im.is_direct) else [],
    ))


def _finalize_locale(im: ImMessage) -> ImMessage:
    """非命令类才允许 auto-detect；**只在单聊里锁**（坑 4）。"""
    from core import nl_router
    route = nl_router.classify(im.text)
    if route.kind != "":
        return im
    final_locale, source = locale_resolver.resolve(
        user_id=im.user_id, platform=PLATFORM, is_dm=im.is_direct,
        thread_root_id="", text=im.text,
    )
    if source == "auto" and im.is_direct:
        locale_resolver.lock_for_dm(PLATFORM, im.user_id, final_locale)
    return ImMessage(**{**im.__dict__, "locale": final_locale})


# ---------------------------------------------------------------------------
# message
# ---------------------------------------------------------------------------
def _handle_message(payload: dict) -> None:
    im = _normalize(payload)
    if im is None:
        return

    # 幂等去重：钉钉在 3 秒内没收到 2xx 会重推（同一个 `msgId`）。放在 worker 而不是
    # ingress —— ingress 已经 async 出去了，它并不知道 worker 是否真的处理成功。
    if not ddb_state.put_new_event(
            im.event_id, platform=PLATFORM, chat_id=im.chat_id,
            # 这里存**用户那条消息**的 id（取证用），与 `ImMessage.root_message_id`
            # 刻意留空不矛盾：那个字段的语义是"可更新的消息句柄"。
            root_message_id=im.message_id, user_id=im.user_id,
            raw_text=im.raw_text, locale=im.locale):
        logger.info("worker: duplicate event %s — skipped", im.event_id)
        return

    # ⚠️ 顺序：bind 必须在任何可能回话的代码之前（`maybe_handle_confirm` 就会回话）。
    _bind_session(payload, im)
    im = _finalize_locale(im)

    before = set(threading.enumerate())
    try:
        # 坑 3：「确认」/「取消」先截。返回 True = 已经处理完，不再路由。
        if case_text.maybe_handle_confirm(
                chat_id=im.chat_id, user_id=im.user_id, text=im.text,
                locale=im.locale):
            logger.info("worker: handled pending-action confirmation")
            return
        # 填好的**案例模版**发回来了 → 直接进开案例草稿，不走路由。
        # 顺序在 confirm **之后**：「确认」是整句一个词，凑不出模版的标签行，两者不
        # 可能同时命中；而模版判据（≥2 个标签行且必须有「问题描述」）比 confirm 宽，
        # 放前面会多读一次 DDB。判据本身在 `case_text.maybe_handle_form`。
        if case_text.maybe_handle_form(
                chat_id=im.chat_id, user_id=im.user_id, text=im.text,
                locale=im.locale, account_id=im.account_id or "",
                operator_name=im.user_name):
            logger.info("worker: handled filled case form")
            return
        router.dispatch(
            im, _CAPS,
            refusal_text=i18n.t("out_of_scope.change_request", im.locale),
        )
    finally:
        # 进度心跳线程正常由 `AppendProgress.close()` join 掉；这里是最后一道保险
        # （Lambda 在 handler 返回后**冻结**执行环境，漏掉的线程会成为下一次调用的幽灵）。
        _join_spawned(before, "message")


def _join_spawned(before: set, what: str) -> None:
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
        if kind == "message":
            _handle_message(payload)
        else:
            # 钉钉只有一种入站形态（没有 Slack 的 interactivity / slash 回调，
            # 见 lambda_ingress.py 文件头第 5 点）。真收到别的 kind 说明 ingress 变了。
            logger.warning("worker: unknown kind=%s", kind)
    except Exception as e:                    # noqa: BLE001
        logger.exception("worker: swallow %s", type(e).__name__)
    finally:
        # 坑 2 —— **必须**在 finally 里，且在 `_join_spawned` 之后（心跳线程还在跑时
        # 清掉 Session 会让最后一条进度消息发不出去）。
        sender.clear()
    return {"ok": True}
