"""飞书 bot 自身身份（`open_id`）—— 判「这条消息 @ 的到底是不是**我**」。

为什么必须有这一层：飞书**没有** Slack 的 `app_mention` 事件类型。bot 在群里是成员时，
群里的每一句话都会作为 `im.message.receive_v1` 投过来，事件里只有一个 `mentions` 数组，
装着这条消息 @ 到的**所有**人/bot。所以「@ 的是谁」只能由我们自己比对，平台不替我们分。

只判「有没有 mentions」的写法在同一个群里装了**两个** NotiOps bot（很常见：测试环境 +
生产环境各一个）时，会让两个 bot 同时抢答同一句话 —— 用户侧几乎无法分辨是谁在答。

`open_id` 是**唯一**可用的身份键，判据在**事件那一侧**：SDK 的 mention 模型
(`lark_oapi/api/im/v1/model/mention_event.py` → `key / id{user_id,open_id,union_id} /
name / tenant_key`) 里没有 `app_id`。所以哪怕手上有自己的 `app_id`，也没有东西可以跟它
比 —— 拿 `app_id` 写的判据永远不成立。

⚠️ 别把这句读成"`app_id` 拿不到"：本 bot 自己的 `app_id` 就在飞书 secret 里
（`platforms/feishu/app/feishu_utils.py::_load_credentials`），随时可读。缺的是
**mention 里没有可比的那一半**，不是我们这一侧没有值。（`GET /bot/v3/info` 我们只读
`bot.open_id` 一个字段，返回里还有什么没验证过，别照着这行写别的判据。）

ingress 与 worker 共用这里。ingress 的 INIT 阶段有 10s 硬上限（实测过 init timeout），
所以 `feishu_utils` 只在函数体里 import —— 口径同 `platforms/common/quick_ack.py`。
"""
from __future__ import annotations

import logging
import threading
import time

logger = logging.getLogger(__name__)

_BOT_INFO_PATH = "/bot/v3/info"

#: 查失败时的负缓存时长。取不到自己的 open_id 就在群里装死（见 `is_bot_mentioned` 的
#: fail-closed），所以不能永久缓存失败 —— 否则一次网络抖动会让这个执行环境**整个生命
#: 周期**都聋。也不能不缓存 —— 那样凭证真挂了会让每条带 @ 的消息都白等一次超时。
_NEGATIVE_TTL_SECONDS = 60.0

_lock = threading.Lock()
_bot_open_id: str | None = None      # None = 没查过；"" = 查过但失败
_failed_at: float = 0.0


def get_bot_open_id() -> str:
    """本 bot 自己的 `open_id`。取不到返回 `""`（调用方按 fail-closed 处理）。

    进程内缓存：成功后永不再查（bot 的 open_id 是这个应用的固有属性，不会变）。
    """
    global _bot_open_id, _failed_at
    if _bot_open_id:
        return _bot_open_id
    with _lock:
        if _bot_open_id:
            return _bot_open_id
        if _bot_open_id == "" and (time.monotonic() - _failed_at) < _NEGATIVE_TTL_SECONDS:
            return ""
        # 见模块 docstring：ingress init 预算很紧，这个 import 只在真需要时才发生。
        from platforms.feishu.app import feishu_utils

        try:
            resp = feishu_utils.call_openapi("GET", _BOT_INFO_PATH)
        except Exception as e:                    # noqa: BLE001
            return _remember_failure("call failed: %s" % type(e).__name__)
        if resp.get("code") != 0:
            # 只记 code，不记 resp 全文（返回里带 bot 配置，日志里没必要留）。
            return _remember_failure("code=%s" % resp.get("code"))
        open_id = (resp.get("bot") or {}).get("open_id", "") or ""
        if not open_id:
            return _remember_failure("no open_id in response")
        _bot_open_id = open_id
        logger.info("bot identity: open_id=%s", _bot_open_id)
        return _bot_open_id


def _remember_failure(why: str) -> str:
    """记下失败 + 负缓存。**必须是 ERROR**：群里彻底不响应 @ 是用户可见的功能中断。"""
    global _bot_open_id, _failed_at
    _bot_open_id = ""
    _failed_at = time.monotonic()
    # 文案刻意用英文：这是运维日志（CloudWatch），不是用户界面 —— 走 i18n.t 会把
    # 产品文案表当日志字符串表用，而 `core/i18n.py` 是**产品文案**的单一来源。
    logger.error("bot identity: GET %s %s -- groups will not answer "
                 "@-mentions (DMs unaffected)", _BOT_INFO_PATH, why)
    return ""


def is_bot_mentioned(msg) -> bool:
    """这条消息的 `mentions` 里有没有本 bot。

    fail-closed：拿不到自己的 open_id 时返回 False —— 宁可在群里装死（用户会立刻发现
    并来找我们），也不要在装了两个 bot 的群里抢答（用户很难发现是哪个在答）。私聊路径
    不经过这里，所以身份查询挂掉时 bot 仍然可用。
    """
    mentions = getattr(msg, "mentions", None) or []
    if not mentions:
        # 群里的普通闲聊在这里就返回了 —— 一次 HTTP 都不发。
        return False
    bot_open_id = get_bot_open_id()
    if not bot_open_id:
        return False
    for m in mentions:
        mid = getattr(m, "id", None)
        if mid is None:
            continue
        if (getattr(mid, "open_id", "") or "") == bot_open_id:
            return True
    return False


def _reset_cache_for_tests() -> None:
    """只给测试用：清掉进程内缓存。"""
    global _bot_open_id, _failed_at
    _bot_open_id = None
    _failed_at = 0.0
