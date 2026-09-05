"""Feishu ingress Lambda（IM 重构 / M1）—— webhook 入口，秒回 ACK。

事件订阅路径：**API Gateway HTTP API（`$default` catch-all，未鉴权）→ 本 Lambda**。
（2026-09-01 之前是 Lambda Function URL `AuthType=NONE`；换的原因见
`infra/lib/constructs/im-core.ts` 的 `createIngressHttpApi()` 注释。事件形状不变 ——
payload format 2.0 与 Function URL 一致，所以本文件的解析代码没动。）所以：
  1. Feishu 侧的每一次请求都是**未鉴权的公网调用**，签名 / 加密 / URL-challenge 全靠
     `lark_oapi.event.EventDispatcherHandler.do()`（复用 SDK 已经写好的加密 + 验签逻辑）。
  2. 事件解密 + URL challenge 之后，把"要真正做的事"**异步**投给 worker Lambda，
     ingress 秒回 ACK —— Feishu 对 `card.action.trigger` 有 ~3s 硬超时，卡片按钮那条
     路径必须走异步（长连接下的 `threading.Thread` 在 Lambda 上不成立：execution env
     响应返回后就冻结了）。见 §3。
  3. 投完 worker（**顺序不能颠倒**）再给用户那条消息加一个"收到了"的表情回复 ——
     这是 ingress 里唯一一件"对外发消息"的事，理由是它常态热、能在 0.3s 内落地，
     而「正在思考」卡片要等 worker 冷启动（冷的那一次是十几秒，实测数见
     `platforms/common/warmup.py` 的模块 docstring）。见 `platforms/common/quick_ack.py`。

**硬约束 A（§6.1）—— fail-fast**：`encrypt_key` 空 → `_verify_sign` 直接 return（不再验签）；
`verification_token` 空 → 上面那个 token check 的 `if` 不成立。两个都空 = 请求完全可伪造。
所以启动时**两把钥匙**都必须非空，`os.environ[]` KeyError 直接 crash（Lambda 冷启动失败，
更明显）。**绝不**用 `.get("", ...)` —— 那正好命中 SDK 的绕过分支。

**硬约束 B（§6.2）—— 响应形状**：由 `webhook_adapter.to_function_url_response` /
`unauthorized_response` / `swallow_response` 三个函数收口，任何异常都不外泄 `str(e)`。
"""
from __future__ import annotations

import json
import logging
import os
import time

import boto3
import lark_oapi as lark
from lark_oapi.api.im.v1 import P2ImMessageReceiveV1
from lark_oapi.core.exception import (
    AccessDeniedException,
    NoAuthorizationException,
)
from lark_oapi.event.callback.model.p2_card_action_trigger import (
    P2CardActionTrigger,
    P2CardActionTriggerResponse,
)

from platforms.common import lambda_deadline, quick_ack, warmup
from platforms.feishu import bot_identity, webhook_adapter

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _safe_err(e: Exception) -> str:
    return type(e).__name__


# ---------------------------------------------------------------------------
# fail-fast secret load (硬约束 A)
# ---------------------------------------------------------------------------
_SECRET_NAME = os.environ.get("FEISHU_SECRET_NAME", "notiops/im-bot-feishu")
_sm = boto3.client("secretsmanager")
_feishu_secret = json.loads(
    _sm.get_secret_value(SecretId=_SECRET_NAME)["SecretString"]
)
# 两个 KeyError 都必须炸 —— 没有回落到 `""`（那是 SDK 的绕过分支）
APP_ID = _feishu_secret["app_id"]
APP_SECRET = _feishu_secret["app_secret"]
ENCRYPT_KEY = _feishu_secret["encrypt_key"]
VERIFICATION_TOKEN = _feishu_secret["verification_token"]
if not (ENCRYPT_KEY and VERIFICATION_TOKEN):
    # secret 里键存在但值是空串 —— 也要炸，这是 §6.1 里点名的伪造漏洞。
    raise RuntimeError("feishu secret missing encrypt_key/verification_token "
                       "(both required to prevent request forgery)")


# ---------------------------------------------------------------------------
# worker 投递（异步 InvokeFunction，秒回 ACK）
# ---------------------------------------------------------------------------
_WORKER_FN = os.environ["FEISHU_WORKER_FUNCTION"]
_lambda = boto3.client("lambda")


_ALLOWED_CHAT_IDS = {
    c.strip() for c in os.environ.get("ALLOWED_CHAT_IDS", "").split(",")
    if c.strip()
}


def _dispatch_worker(kind: str, payload: dict) -> None:
    """异步投递给 worker。**Event 模式**（`InvocationType='Event'`）—— 不等 worker 返回。

    ingress 只保证「秒回 ACK」；真正的幂等去重在 worker 里做（ingress 已经 async 出去了，
    它并不知道 worker 会不会真的跑起来 —— 幂等键必须由能感知到"这次真的处理了"的一方持有）。
    """
    body = json.dumps({"kind": kind, "payload": payload, "ts": int(time.time())})
    _lambda.invoke(FunctionName=_WORKER_FN, InvocationType="Event",
                   Payload=body.encode("utf-8"))


# ---------------------------------------------------------------------------
# SDK EventDispatcherHandler —— 复用现有 processor 函数（M0 抽出来的那批）
# ---------------------------------------------------------------------------
# processor 里做的事：把 SDK 反序列化好的 P2*/Event 序列化回 dict，async 投给 worker。
# **不能**在 ingress 里做真正的响应工作 —— 那正是要绕开 3s 硬超时的原因。

def _on_message(event: P2ImMessageReceiveV1) -> None:
    _dispatch_worker("message", {
        "event_id": event.header.event_id,
        # SDK 的 P2*/Event 都是 pydantic-like 对象；`.to_dict()` 各版本都有，
        # 不同版本键名有出入，所以用 lark.JSON.marshal（SDK 内部序列化器）。
        "event": lark.JSON.marshal(event),
    })
    # ⚠️ **投递之后**才加表情（多一次 HTTP，放前面就是让干活那一路白等）。
    # 见 platforms/common/quick_ack.py 的「三条硬约束」。
    _quick_ack(event)


def _will_be_answered(msg) -> bool:
    """这条消息 worker 会不会真的回？—— 决定要不要贴表情。

    ⚠️ 这是 `platforms/feishu/lambda_worker.py::_normalize_message` 丢弃规则的一个
    **子集**，两处必须一起改。为什么要在 ingress 重复一遍而不是"先贴了再说"：群里
    bot 是成员时，**每一句话**都会作为 `im.message.receive_v1` 投过来（worker 才靠
    `mentions` / bot-thread 判定要不要理），无脑贴表情等于给群里所有闲聊都盖一个章。

    刻意保守（只贴 worker 一定会回的那些），差集是「bot 已经回过话的话题里免 @ 追问」：
    那一条要查 DDB（`is_bot_thread`）才能判定，而 ingress 没有表加载也没有那个权限。
    代价是这类追问看不到表情（照样有卡片），比"贴了却没人回"好。

    ⚠️ **群消息这一路会打 HTTP**：`bot_identity` 要查本 bot 的 `open_id`（进程内缓存，
    冷环境的第一条群 @ 要一次 token + 一次 OpenAPI）。所以调用方必须先过预算闸门 ——
    见 `_quick_ack`。私聊与"群里闲聊"两条都在发第一个包之前就返回了。
    """
    if getattr(msg, "message_type", "") != "text":
        return False
    chat_id = getattr(msg, "chat_id", "") or ""
    if _ALLOWED_CHAT_IDS and chat_id not in _ALLOWED_CHAT_IDS:
        return False
    # p2p = 私聊，一律受理；群里只认 @ 到**本** bot 的那些。判据与 worker 共用
    # `platforms/feishu/bot_identity.py`（不是"照抄一遍"，是同一个函数），所以两处不会漂。
    if getattr(msg, "chat_type", "") == "p2p":
        return True
    return bot_identity.is_bot_mentioned(msg)


def _quick_ack(event: P2ImMessageReceiveV1) -> None:
    try:
        # ⚠️ 预算闸门必须在 `_will_be_answered()` **之前** —— 群消息的那一路要查 bot
        # 自己的 open_id（`bot_identity`：一次 token + 一次 OpenAPI），**那也是 HTTP**，
        # 而 `quick_ack.feishu()` 自己的闸门在它后面才生效。本函数 timeout 只有 20s
        # （`infra/lib/constructs/im-core.ts`），先花掉这段再问"还有预算吗"就晚了：
        # 表情照样不发，时间照样花掉，函数被平台杀掉 → 对飞书回 5xx → 白挨一轮重试。
        if not quick_ack.budget_ok():
            return
        msg = event.event.message
        if not _will_be_answered(msg):
            return
        quick_ack.feishu(msg.message_id or "")
    except Exception as e:                    # noqa: BLE001
        # 表情失败绝不能影响 ACK（约束 2）。`quick_ack` 自己已经不抛了，这层兜住的是
        # 事件形状变化（SDK 升级少了某个字段）之类。
        logger.warning("ingress: quick_ack skipped: %s", _safe_err(e))


def _on_card_action(event: P2CardActionTrigger) -> P2CardActionTriggerResponse:
    _dispatch_worker("card_action", {
        "event_id": getattr(event.header, "event_id", "") if event.header else "",
        "event": lark.JSON.marshal(event),
    })
    # 空 toast + 空 card = "没变化"，飞书就不会弹 loading —— worker 稍后 PATCH 卡片。
    resp = P2CardActionTriggerResponse({})
    return resp


_dispatcher = (
    lark.EventDispatcherHandler
    .builder(ENCRYPT_KEY, VERIFICATION_TOKEN)
    .register_p2_im_message_receive_v1(_on_message)
    .register_p2_card_action_trigger(_on_card_action)
    .build()
)


# ---------------------------------------------------------------------------
# handler
# ---------------------------------------------------------------------------
def handler(event: dict, context) -> dict:
    """Lambda entry —— 秒回 ACK。

    错误处理三档（硬约束 B）：
      · AccessDenied / NoAuthorization → 401 空 body（含日志）；
      · 其它异常（含 processor not found、反序列化失败、SDK 500） → 200 `{"msg":"success"}`
        —— 避免飞书对未订阅事件类型无限重试打爆 ingress；
      · 成功 → 200 + SDK body（URL challenge 或 `{"msg":"success"}`）。
    """
    # 保活探测（EventBridge rate(4 minutes)）—— 必须是**第一行**：整个目的就是
    # "什么都不做，只让这个执行环境别被回收"。公网构造不出来，理由见
    # platforms/common/warmup.py 文件头。日志也不打：4 分钟一条 × 两个平台，
    # 一年 26 万条纯噪音，真要确认它在跳看 EventBridge 规则的 Invocations 指标。
    if warmup.is_warmup(event):
        return warmup.response()

    # 表情回复要知道"还剩多久"才敢多打一次 HTTP（quick_ack 约束 3）。放在保活之后 ——
    # 保活那一路什么都不做，没必要记。
    lambda_deadline.set_from_context(context)

    try:
        req = webhook_adapter.parse_function_url_event(event)
        resp = _dispatcher.do(req)
        # SDK 内部把 AccessDenied / NoAuthorization 抓成 500；从状态码 + content 反推
        status = int(getattr(resp, "status_code", 200) or 200)
        if status >= 500:
            content = getattr(resp, "content", b"") or b""
            text = content.decode("utf-8", "replace") if isinstance(content, (bytes, bytearray)) else str(content)
            if "AccessDenied" in text or "NoAuthorization" in text or "signature" in text.lower():
                logger.warning("ingress: 401 (signature/token) uri=%s", req.uri)
                return webhook_adapter.unauthorized_response()
            logger.warning("ingress: swallow SDK 500 uri=%s", req.uri)
            return webhook_adapter.swallow_response()
        return webhook_adapter.to_function_url_response(resp)
    except (AccessDeniedException, NoAuthorizationException) as e:
        logger.warning("ingress: 401 %s", _safe_err(e))
        return webhook_adapter.unauthorized_response()
    except Exception as e:                    # noqa: BLE001
        logger.exception("ingress: swallow %s", _safe_err(e))
        return webhook_adapter.swallow_response()
