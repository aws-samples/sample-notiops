"""Slack ingress Lambda（IM 重构 / M3）—— API Gateway HTTP API webhook，秒回 ACK。

飞书那份（`platforms/feishu/lambda_ingress.py`）的 Slack 对位实现，同样的四段结构：
验签 → 异步投 worker → 贴一个"收到了"的表情（`platforms/common/quick_ack.py`，
顺序不能提前）→ 秒回。差别全在"Slack 的协议长什么样"上：

── 与飞书的四处硬差异 ─────────────────────────────────────────────────────────
 1. **验签自己写，不借 SDK**。飞书那边 `EventDispatcherHandler.do()` 把加密+验签都做了；
    Slack 的对应物是 `slack_bolt` 的 `SignatureVerifier`，但把 bolt 拉进 ingress 会连带
    `App(...)`/adapter 一大坨（冷启动 + `platforms/slack/app/main.py` 那个死循环风险）。
    Slack 的算法只有三行 HMAC-SHA256，用 stdlib 写完反而更可控 —— 见 `_verify`。
 2. **没有加密**（飞书有 `encrypt_key` 解密）。Slack 只签名，body 是明文 JSON 或
    form-urlencoded。
 3. **三种 content-type 三条路**：
      · Events API / url_verification → `application/json`
      · Interactivity（block_actions / view_submission）→ form，字段名 `payload`
      · Slash commands（`/devops`、`/language`）→ form，字段名 `command` / `text` / …
 4. **重试语义不同**：Slack 只对 Events API 重试（`X-Slack-Retry-Num`），且**同一个
    `event_id`**，所以 worker 侧的 `put_new_event` 去重天然生效。Interactivity 不重试
    （超时直接给用户报错）—— 这也是 worker 必须做 trigger_id 时效预检的原因，见
    `platforms/slack/lambda_worker.py` 文件头。

**硬约束 A（fail-fast，同飞书 §6.1）**：signing secret 为空 = 请求完全可伪造。
冷启动时读不到 / 读到空串就 `raise`（Lambda 直接起不来，比"线上静默不验签"好一万倍）。
**绝不** `except: secret = ""` 然后跳过验签。

**硬约束 B（响应形状，同飞书 §6.2）**：
  · 验签失败 / 时间戳过期 → **401 空 body**（不解释原因，公开端点不做错误画像）；
  · `url_verification` → 200 + `{"challenge": ...}`；
  · 其它任何异常（未订阅的事件类型、解析失败、投递失败）→ **200 空 body**
    —— 非 2xx 会让 Slack 重试，一个多订阅的事件类型就能打成重试风暴；
    且**绝不**把 `str(e)` 写进 body。
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

from platforms.common import lambda_deadline, quick_ack, warmup

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Slack 官方建议的时间戳容忍窗口（防重放）。
_MAX_SKEW = 60 * 5

# 与 worker 的 `ALLOWED_CHANNEL_IDS` 同一个变量名（别改成飞书那边的 ALLOWED_CHAT_IDS）。
# ingress 只用它决定"要不要贴表情"——真正的受理判定仍在 worker。
_ALLOWED_CHANNEL_IDS = {
    c.strip() for c in os.environ.get("ALLOWED_CHANNEL_IDS", "").split(",")
    if c.strip()
}

# ---------------------------------------------------------------------------
# fail-fast secret load (硬约束 A)
# ---------------------------------------------------------------------------
_SIGNING_REF = os.environ.get("SLACK_SIGNING_SECRET_ARN", "").strip()
if not _SIGNING_REF:
    raise RuntimeError("SLACK_SIGNING_SECRET_ARN not set — refusing to run an "
                       "unauthenticated public webhook without signature "
                       "verification")
_sm = boto3.client("secretsmanager")
_raw_secret = _sm.get_secret_value(SecretId=_SIGNING_REF)["SecretString"]
# CDK 建的是**纯字符串** secret（客户从 Slack 的 Basic Information 页粘一串 hex）。
# 但有人手工建成 `{"signing_secret": "..."}` 也很常见 —— 两种都吃，别让客户卡在这。
try:
    _parsed = json.loads(_raw_secret)
    SIGNING_SECRET = str(
        (_parsed.get("signing_secret") or _parsed.get("secret") or "")
        if isinstance(_parsed, dict) else _raw_secret
    ).strip()
except (ValueError, TypeError):
    SIGNING_SECRET = _raw_secret.strip()
if not SIGNING_SECRET:
    # secret 存在但值为空 —— CDK 建的空壳、客户还没填。这是点名的伪造漏洞，必须炸。
    raise RuntimeError("slack signing secret is empty (fill it from Slack app "
                       "→ Basic Information → Signing Secret)")

_WORKER_FN = os.environ["SLACK_WORKER_FUNCTION"]
_lambda = boto3.client("lambda")


# ---------------------------------------------------------------------------
# 响应形状（硬约束 B）
# ---------------------------------------------------------------------------
def _ok(body: str = "") -> dict:
    """200。Slack 只看状态码；空 body 是合法 ACK（也是 slash command 的"不回话"）。"""
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
    """**原字节**。签名基串里的 body 必须逐字节原样 —— 任何 loads→dumps 的往返都会
    改动空白/键序/转义，签名立刻失败（与飞书 webhook_adapter 同一个坑）。"""
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


def _verify(headers: dict[str, str], raw: bytes) -> bool:
    """Slack 请求验签。

    基串 = ``v0:{X-Slack-Request-Timestamp}:{raw body}``；
    期望值 = ``v0=`` + HMAC-SHA256(signing_secret, 基串).hexdigest()。

    两道都要过：
      · 时间戳偏差 ≤ 5 分钟（防重放 —— 光比 HMAC 的话，抓到一个包就能永久重放）；
      · `hmac.compare_digest` 常数时间比较（不要用 `==`，那是可测时的）。
    """
    ts = headers.get("x-slack-request-timestamp", "")
    sig = headers.get("x-slack-signature", "")
    if not ts or not sig:
        return False
    try:
        skew = abs(time.time() - int(ts))
    except (TypeError, ValueError):
        return False
    if skew > _MAX_SKEW:
        logger.warning("ingress: timestamp skew %.0fs — rejected", skew)
        return False
    base = b"v0:" + ts.encode("utf-8") + b":" + raw
    expected = "v0=" + hmac.new(SIGNING_SECRET.encode("utf-8"), base,
                                hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)


def _form(raw: bytes) -> dict[str, str]:
    """form-urlencoded body → 单值 dict（Slack 的 interactivity / slash 都是这个形状）。"""
    try:
        pairs = urllib.parse.parse_qsl(raw.decode("utf-8"), keep_blank_values=True)
    except (UnicodeDecodeError, ValueError):
        return {}
    return {k: v for k, v in pairs}


# ---------------------------------------------------------------------------
# worker 投递
# ---------------------------------------------------------------------------
def _dispatch_worker(kind: str, payload: dict) -> None:
    """异步投递（`InvocationType='Event'`）—— 不等 worker 返回。

    `ts` 是**投递时刻**，worker 用它算 trigger_id 还剩多少时效（Slack 的
    `views_open` trigger_id 只有约 3 秒可用；见 worker 文件头）。幂等去重在 worker，
    理由同飞书：ingress 已经 async 出去了，它不知道 worker 有没有真的处理成功。
    """
    body = json.dumps({"kind": kind, "payload": payload, "ts": time.time()})
    _lambda.invoke(FunctionName=_WORKER_FN, InvocationType="Event",
                   Payload=body.encode("utf-8"))


# ---------------------------------------------------------------------------
# handler
# ---------------------------------------------------------------------------
def handler(event: dict, context) -> dict:
    """Lambda entry —— 秒回 ACK。"""
    # 保活探测（EventBridge rate(4 minutes)）—— 第一行，在验签之前。这不是"绕过验签"：
    # 公网请求构造不出这个形状，判据见 platforms/common/warmup.py 文件头。
    # 与飞书 ingress 同一份判定，两边必须一起改。
    if warmup.is_warmup(event):
        return warmup.response()

    # 表情回复要知道"还剩多久"才敢多打一次 HTTP（quick_ack 约束 3）。同飞书 ingress。
    lambda_deadline.set_from_context(context)

    try:
        headers = _headers(event)
        raw = _raw_body(event)

        if not _verify(headers, raw):
            # 不打 body、不打 signature，也不打 secret 长度（docs/LOGGING_STANDARD.md）。
            logger.warning("ingress: 401 signature verification failed")
            return _unauthorized()

        ctype = headers.get("content-type", "")
        if "application/json" in ctype:
            return _handle_json(raw, headers)
        # form：interactivity + slash command + 旧的 ssl_check
        return _handle_form(raw)
    except Exception as e:                    # noqa: BLE001
        # 200 而不是 500：非 2xx 会让 Slack 重试，把一次解析 bug 放大成重试风暴。
        logger.exception("ingress: swallow %s", type(e).__name__)
        return _ok()


def _handle_json(raw: bytes, headers: dict[str, str]) -> dict:
    """Events API（含 `url_verification`）。"""
    try:
        body = json.loads(raw.decode("utf-8") or "{}")
    except (ValueError, UnicodeDecodeError):
        logger.warning("ingress: json parse failed — swallowed")
        return _ok()
    if not isinstance(body, dict):
        return _ok()

    kind = str(body.get("type") or "")

    if kind == "url_verification":
        # Slack 也签这一条，所以到这里已经验过签了。
        return _ok(json.dumps({"challenge": str(body.get("challenge") or "")}))

    if kind != "event_callback":
        # `app_rate_limited` 等 —— 记一条就够，别重试。
        logger.info("ingress: unhandled envelope type=%s", kind)
        return _ok()

    inner = body.get("event") or {}
    if not isinstance(inner, dict):
        return _ok()
    itype = str(inner.get("type") or "")
    if itype not in ("message", "app_mention"):
        logger.info("ingress: unhandled event type=%s", itype)
        return _ok()

    # **自我触发闸门放在 ingress**（飞书那边不需要：SDK 不投递 bot 自己的消息）。
    # Slack 会把 bot 自己发的消息也作为 `message` 事件投回来 —— 不挡就是无限自问自答，
    # 而且每一轮都会真的去打 DevOps Agent。放在 ingress 而不是 worker：省掉整条
    # worker 调用链（否则每条 bot 回复都要冷启动一个 worker 只为了立刻 return）。
    if inner.get("bot_id") or inner.get("subtype") or inner.get("app_id"):
        return _ok()
    if not inner.get("user") or not inner.get("text"):
        return _ok()

    retry = headers.get("x-slack-retry-num", "")
    if retry:
        # 仍然投递：第一次可能压根没投出去。worker 的 put_new_event 按 event_id 去重，
        # 而 Slack 重试用的是**同一个** event_id，所以重复处理不会发生。
        logger.info("ingress: slack retry num=%s reason=%s", retry,
                    headers.get("x-slack-retry-reason", ""))

    _dispatch_worker("message", {
        "event_id": str(body.get("event_id") or ""),
        "team_id": str(body.get("team_id") or ""),
        "event": inner,
    })
    # ⚠️ **投递之后**才贴表情（多一次 HTTP，放前面就是让干活那一路白等）。
    # 重试那次跳过：第一次已经贴上了，`already_reacted` 白跑一趟。
    if not retry:
        _quick_ack(inner, itype)
    return _ok()


def _will_be_answered(inner: dict, itype: str) -> bool:
    """这条消息 worker 会不会真的回？—— 决定要不要贴表情。

    ⚠️ 这是 `platforms/slack/lambda_worker.py::_normalize_message` 丢弃规则的一个
    **子集**，两处必须一起改。理由与飞书那份逐字相同（群里普通消息也会投过来，无脑贴
    表情等于给所有闲聊盖章）：只贴 DM 和 `app_mention`；差集是「bot 回过话的 thread 里
    免 @ 追问」——那要查 DDB（`is_bot_thread`），ingress 没有那个权限，所以不贴。
    """
    channel = str(inner.get("channel") or "")
    if _ALLOWED_CHANNEL_IDS and channel not in _ALLOWED_CHANNEL_IDS:
        return False
    return itype == "app_mention" or str(inner.get("channel_type") or "") == "im"


def _quick_ack(inner: dict, itype: str) -> None:
    try:
        if not _will_be_answered(inner, itype):
            return
        # `ts` 是**这条消息自己的** ts，不是 thread_ts —— 表情要贴在用户刚发的那条上。
        quick_ack.slack(str(inner.get("channel") or ""), str(inner.get("ts") or ""))
    except Exception as e:                    # noqa: BLE001
        logger.warning("ingress: quick_ack skipped: %s", type(e).__name__)


def _handle_form(raw: bytes) -> dict:
    """Interactivity（`payload=`）+ Slash commands + `ssl_check`。"""
    form = _form(raw)
    if not form:
        logger.warning("ingress: empty/invalid form body — swallowed")
        return _ok()

    if form.get("ssl_check"):
        # Slack 的存活探测（老 app 配置页会打）。回 200 空即可。
        return _ok()

    if "payload" in form:
        try:
            payload = json.loads(form["payload"] or "{}")
        except (ValueError, TypeError):
            logger.warning("ingress: interactivity payload parse failed")
            return _ok()
        if not isinstance(payload, dict):
            return _ok()
        ptype = str(payload.get("type") or "")
        if ptype not in ("block_actions", "view_submission"):
            logger.info("ingress: unhandled interactivity type=%s", ptype)
            return _ok()
        _dispatch_worker(ptype, {"payload": payload})
        # ⚠️ `view_submission` 的响应体是**有语义**的：空 body = 关闭 modal（我们要的），
        # `{"response_action":"errors",...}` 才是留在原地报错。因为真正的处理在 worker
        # 里异步做，这里无法知道校验结果，所以一律"关闭 modal + worker 事后发消息"。
        return _ok()

    if form.get("command"):
        # `/devops`、`/language` —— 只有在 Slack App 里注册过的 slash command 才会到这。
        _dispatch_worker("slash", {
            "command": form.get("command", ""),
            "text": form.get("text", ""),
            "user_id": form.get("user_id", ""),
            "channel_id": form.get("channel_id", ""),
            "channel_name": form.get("channel_name", ""),
            "trigger_id": form.get("trigger_id", ""),
            "response_url": form.get("response_url", ""),
            "team_id": form.get("team_id", ""),
        })
        # 空 body = 不在频道里回显任何东西；worker 稍后 postMessage。
        # 若这里回一段文本，用户会先看到一句"收到"再看到答案，多一条噪音。
        return _ok()

    logger.info("ingress: unrecognized form body keys=%s", sorted(form.keys()))
    return _ok()
