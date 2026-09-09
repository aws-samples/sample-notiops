"""钉钉 ingress Lambda（IM 重构 / M4）—— API Gateway HTTP API webhook，秒回 ACK。

`platforms/slack/lambda_ingress.py` / `platforms/feishu/lambda_ingress.py` 的钉钉对位
实现，同样的三段结构：**验签 → 异步投 worker → 秒回 200**。差别全在"钉钉的协议长
什么样"上。

── 与另外两家的五处硬差异（照抄会踩）────────────────────────────────────────
 1. **`timestamp` 是毫秒**。Slack 的 `X-Slack-Request-Timestamp` 是秒。照抄
    `abs(time.time() - int(ts))` 会得到 1000 倍偏差 —— 每个请求都判成过期，表现是
    "机器人完全不理人"，而日志里只有一行 401。窗口按官方口径取 **1 小时**。
 2. **签名基串不含 body**：`stringToSign = f"{timestamp}\\n{appSecret}"`，HMAC 的 key
    也是 `appSecret`，输出是 **base64**（Slack 是 hexdigest 且基串含整个 body）。
    ⚠️ 直接后果：钉钉的签名**只防伪造来源，不防 body 篡改**（同一个 timestamp 的
    签名对任何 body 都成立）。这是钉钉协议本身的性质，不是这里少写了什么；能补的只有
    时间窗（已经取到官方口径的最紧值）。写在这里，免得后人以为漏了一段校验。
 3. **没有加密**（飞书有 `encrypt_key`），也**没有 challenge 握手**（飞书/Slack 都有
    `url_verification`）。钉钉的 AES 握手（`check_url`）属于**事件订阅**通道，我们
    一个事件都不订阅，只收机器人消息 —— 所以不实现，也不假装实现。
 4. **不贴"收到了"的表情**。`platforms/common/quick_ack.py` 在这里没有对位函数：
    钉钉开放平台**没有给机器人提供表情回应接口**。这不是漏做 —— 另外两家靠表情把
    首次反馈从 T+4~6s（worker 冷启动之后）提前到 T+0.3s，钉钉拿不到这个便宜。
    ⚠️ 也**不**在 HTTP 响应体里同步回一条消息当 ack：那个能力没在本次核实的官方文档
    里确认，而一旦它其实生效，用户就会看到**两条** ack（这里一条 + worker 里
    `caps.chat` 那条）。宁可慢 4 秒，不赌一个会重复刷屏的优化。
 5. **`content-type` 只有一种**（`application/json`）。钉钉机器人回调没有 Slack 那套
    form-urlencoded 的 interactivity / slash command —— 按钮只能跳 URL（设计文档
    §4.2），所以根本没有回调形态的交互。命令走"用户打一句 `/xxx`"，与普通消息同路。

**硬约束 A（fail-fast）**：`app_secret` 为空 = 请求完全可伪造。冷启动时读不到 /
读到空串就 `raise`（Lambda 直接起不来，比"线上静默不验签"好一万倍）。**绝不**
`except: secret = ""` 然后跳过验签。判空逻辑复用 `sender.load_credentials()`（它本来
就为此而抛），不在这里再抄一份 secret 解析 —— 两份解析必然漂移，而漂移的方向就是
"其中一份取到空值还继续跑"。

**硬约束 B（响应形状）**：
  · 验签失败 / 时间戳过期 → **401 空 body**（不解释原因，公开端点不做错误画像）；
  · 其它任何异常（形状不认、解析失败、投递失败）→ **200 空 body** —— 非 2xx 会让
    钉钉重试，一个解析 bug 就能放大成重试风暴；且**绝不**把 `str(e)` 写进 body。

**日志纪律**（`docs/LOGGING_STANDARD.md`）：不记 body、不记 `sign`、不记
`app_secret`（**连长度都不记**）、不记 `sessionWebhook`（它就是凭证）、不记用户问题
原文。只记异常**类型名**、`errcode`、以及时间偏差这类无害的量。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
import urllib.parse

import boto3

from platforms.common import warmup
from platforms.dingtalk import sender

logger = logging.getLogger()
logger.setLevel(logging.INFO)

#: 时间戳容忍窗口，**毫秒**。官方口径 1 小时（比另外两家的 5 分钟宽得多 —— 这是钉钉
#: 自己定的，且因为基串不含 body，窗口就是这里唯一的抗重放手段，所以取官方最紧值，
#: 不再放宽。
_MAX_SKEW_MS = 60 * 60 * 1000

# ---------------------------------------------------------------------------
# fail-fast secret load (硬约束 A)
# ---------------------------------------------------------------------------
if not (os.environ.get("DINGTALK_SECRET_ARN")
        or os.environ.get("DINGTALK_SECRET_NAME")):
    raise RuntimeError("DINGTALK_SECRET_ARN not set — refusing to run an "
                       "unauthenticated public webhook without signature "
                       "verification")
try:
    APP_SECRET = sender.app_secret()
except Exception as e:                    # noqa: BLE001
    # secret 不存在 / 不是 JSON / 字段为空 —— 全都是"客户还没填"。照实炸，别静默降级。
    # 只带类型名和 sender 自己那句不含值的说明，绝不打 secret 本身。
    raise RuntimeError(
        f"dingtalk app_secret unavailable ({type(e).__name__}) — fill app_key / "
        f"app_secret in the notiops/im-bot-dingtalk secret; refusing to run "
        f"without signature verification") from None

_WORKER_FN = os.environ["DINGTALK_WORKER_FUNCTION"]
_lambda = boto3.client("lambda")


# ---------------------------------------------------------------------------
# 响应形状（硬约束 B）
# ---------------------------------------------------------------------------
def _ok(body: str = "") -> dict:
    """200。钉钉只看状态码；空 body 是合法 ACK（见文件头第 4 点：**刻意**不在这里
    回消息体）。"""
    return {"statusCode": 200,
            "headers": {"Content-Type": "application/json; charset=utf-8"},
            "body": body}


def _unauthorized() -> dict:
    """401 空 body —— 验签失败 / 时间戳过期。不写原因。"""
    return {"statusCode": 401, "headers": {"Content-Type": "text/plain"}, "body": ""}


# ---------------------------------------------------------------------------
# 请求解析 + 验签
# ---------------------------------------------------------------------------
def _headers(event: dict) -> dict[str, str]:
    """header 名全部小写。API GW / Function URL 都已经小写化了，但显式做一次，别赌。"""
    raw = (event or {}).get("headers") or {}
    if not isinstance(raw, dict):
        return {}
    return {str(k).lower(): str(v) for k, v in raw.items() if v is not None}


def _raw_body(event: dict) -> bytes:
    """**原字节**。钉钉的签名基串不含 body（文件头第 2 点），所以这里不像 Slack 那样
    存在"往返改动一个空格就验不过"的坑；仍然按字节读 —— JSON 里带 emoji 时
    `isBase64Encoded` 会是 True，走 `str()` 会得到一段 base64 当 JSON 去解析。"""
    body = (event or {}).get("body")
    if body is None:
        return b""
    if event.get("isBase64Encoded"):
        try:
            return base64.b64decode(body)
        except (ValueError, TypeError):
            return b""
    if isinstance(body, (bytes, bytearray)):
        return bytes(body)
    return str(body).encode("utf-8")


def _verify(headers: dict[str, str]) -> bool:
    """钉钉请求验签。

    ``stringToSign = f"{timestamp}\\n{appSecret}"``；
    ``expected = base64( HMAC_SHA256(key=appSecret, msg=stringToSign) )``。

    两道都要过：
      · `|now_ms - ts_ms| < 1 小时`（防重放 —— 光比 HMAC 的话，抓到一个包就能永久重放，
        而这里的签名连 body 都不覆盖，重放的危害更大）；
      · `hmac.compare_digest` 常数时间比较（不要用 `==`，那是可测时的）。

    ⚠️ `sign` **同时接受 raw base64 和 url-encoded 两种形式**：base64 里的 `+` `/` `=`
    会被某些网关/SDK 转义，只比原样的话表现是"偶发 401"——最难查的那一类。
    """
    ts = (headers.get("timestamp") or "").strip()
    sig = (headers.get("sign") or "").strip()
    if not ts or not sig:
        return False
    try:
        skew_ms = abs(int(time.time() * 1000) - int(ts))
    except (TypeError, ValueError):
        return False
    if skew_ms >= _MAX_SKEW_MS:
        logger.warning("ingress: timestamp skew %.0fs — rejected", skew_ms / 1000)
        return False
    string_to_sign = f"{ts}\n{APP_SECRET}"
    expected = base64.b64encode(
        hmac.new(APP_SECRET.encode("utf-8"), string_to_sign.encode("utf-8"),
                 hashlib.sha256).digest()).decode("utf-8")
    if hmac.compare_digest(expected, sig):
        return True
    # 第二次机会：`sign` 被 url-encode 过（`+` → `%2B` / ` `，`=` → `%3D`）。
    return hmac.compare_digest(expected, urllib.parse.unquote_plus(sig))


def _extract_text(body: dict) -> str:
    """两种模式的文本位置**都读**（设计文档 §1.2）。

    · HTTP 回调模式 → 顶层 `content`
    · Stream 模式   → `text.content`

    我们只用 HTTP 回调模式，但两个都读的成本是 3 行代码，收益是钉钉改形状或客户误配
    Stream 模式时不至于**静默收不到消息**。
    """
    text = body.get("text")
    if isinstance(text, dict) and text.get("content"):
        return str(text["content"])
    return str(body.get("content") or "")


# ---------------------------------------------------------------------------
# worker 投递
# ---------------------------------------------------------------------------
def _dispatch_worker(payload: dict) -> None:
    """异步投递（`InvocationType='Event'`）—— 不等 worker 返回。

    `ts` 是**投递时刻**，worker 用它算 `sessionWebhook` 还剩多少时效（≈90 分钟，
    所以正常情况下永远够；留这个字段是为了兜底路径能记一条日志）。幂等去重在 worker，
    理由同另外两家：ingress 已经 async 出去了，它不知道 worker 有没有真的处理成功。

    ⚠️ **整个入站报文原样转发**，包括 `sessionWebhook` —— 那是回复用的凭证，只在
    Lambda 之间的 `Payload` 里流转，**不落库、不进日志**。
    """
    body = json.dumps({"kind": "message", "payload": payload, "ts": time.time()})
    _lambda.invoke(FunctionName=_WORKER_FN, InvocationType="Event",
                   Payload=body.encode("utf-8"))


# ---------------------------------------------------------------------------
# handler
# ---------------------------------------------------------------------------
def handler(event: dict, context) -> dict:
    """Lambda entry —— 秒回 ACK。"""
    # 保活探测（EventBridge rate(4 minutes)）—— 第一行，在验签之前。这不是"绕过验签"：
    # 公网请求构造不出这个形状，判据见 platforms/common/warmup.py 文件头。
    # 三家 ingress 同一份判定，必须一起改。
    if warmup.is_warmup(event):
        return warmup.response()

    # ⚠️ 另外两家在这里 `lambda_deadline.set_from_context(context)` —— 那是给
    # `quick_ack` 判"还剩多少预算敢不敢多打一次 HTTP"用的。钉钉没有表情回应接口
    # （文件头第 4 点），这一路一次外部 HTTP 都不打，所以不需要那个预算。

    try:
        headers = _headers(event)

        if not _verify(headers):
            # 不打 body、不打 sign，也不打 secret 长度（docs/LOGGING_STANDARD.md）。
            logger.warning("ingress: 401 signature verification failed")
            return _unauthorized()

        raw = _raw_body(event)
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            logger.warning("ingress: json parse failed — swallowed")
            return _ok()
        if not isinstance(body, dict):
            return _ok()

        msg_id = str(body.get("msgId") or "")
        conversation_id = str(body.get("conversationId") or "")
        staff_id = str(body.get("senderStaffId") or "")

        # 最小受理闸门。真正的判定在 worker（`_normalize`）—— 这里只挡掉"连投过去都
        # 没意义"的三类，省一次 worker 冷启动：
        #  · 没有会话 id → 回不了话；
        #  · 没有 `senderStaffId` → 不是企业内的人发的（机器人 / 系统消息没有 staffId），
        #    这也是这个平台上的**自我触发闸门**（钉钉本来不把机器人自己的消息推回来，
        #    但另外两家都在这里踩过无限自问自答，留一道便宜的保险）;
        #  · 一个字都没有 → `router.dispatch` 无从判断意图。
        if not conversation_id or not staff_id or not _extract_text(body).strip():
            logger.info("ingress: dropped msgtype=%s (incomplete envelope)",
                        body.get("msgtype"))
            return _ok()

        _dispatch_worker(body)
        logger.info("ingress: dispatched msgId=%s convType=%s", msg_id,
                    body.get("conversationType"))
        return _ok()
    except Exception as e:                    # noqa: BLE001
        # 200 而不是 500：非 2xx 会让钉钉重试，把一次解析 bug 放大成重试风暴。
        logger.exception("ingress: swallow %s", type(e).__name__)
        return _ok()
