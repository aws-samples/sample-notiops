"""API GW v2 事件 → `lark_oapi.core.model.RawRequest`（IM 重构 / M1）。

飞书订阅要求「加密 + 签名验证」，SDK 已经写好那两段（`EventDispatcherHandler.do()`），
且 do() 只需要一个 `RawRequest`（属性只有三个：`uri: str` / `headers: Dict[str,str]` /
`body: bytes`）。所以 ingress Lambda 只要把入口事件对象**如实**翻译成
`RawRequest`、把 do() 返回的 `RawResponse` 翻译成 API GW proxy 响应形状即可。

⚠️ 硬约束 A（§6.1）—— **不吞 body 字节**：签名 `sha256(timestamp + nonce + encrypt_key + body)`
里的 body 必须是**原字节**。任何 `json.dumps(json.loads(body))` 之类的再序列化都会改动
空白/键序，签名立刻失败。这里必须走 `isBase64Encoded → base64.b64decode` 的原始字节路径。

⚠️ 硬约束 B（§6.2）—— **绝不直接返回 SDK 的 RawResponse**：SDK 会把 `str(e)` 塞进 500 body
（unauthenticated 公开端点的信息泄漏，违反 docs/LOGGING_STANDARD.md）；且任何 non-2xx
都会让飞书**重试**，`processor not found`（未订阅事件类型）走的正是这条路径，一个额外订阅
的事件类型就能把 ingress 打成"无限重试风暴"。这里：
  · 成功 → 200 + SDK body（`{"challenge":...}` 或 `{"msg":"success"}`）；
  · AccessDeniedException / NoAuthorizationException → **401 空 body**（安全日志留下类型名）；
  · 其它异常（含 processor not found、事件反序列化失败）→ **200 `{"msg":"success"}`**
    （让飞书**别再重试**，同时不泄漏 str(e)；服务端日志里另行记录）。
"""
from __future__ import annotations

import base64
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _lower_headers(raw_headers: Any) -> dict[str, str]:
    """飞书签名头是 `X-Lark-Request-Signature` / `-Timestamp` / `-Nonce`。

    API GW v2 事件里 headers 是 lower-case dict，但 SDK 在 `_verify_sign` 里用的键名是
    大小写敏感的字面量（LARK_REQUEST_TIMESTAMP 等，实际是 `X-Lark-Request-Timestamp`）。
    所以把 header 名**同时**放进两种大小写：SDK 拿到什么都能命中。
    """
    if not isinstance(raw_headers, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in raw_headers.items():
        if not isinstance(k, str) or v is None:
            continue
        s = str(v)
        out[k] = s
        # SDK 使用的字面量键名（见 lark_oapi/core/const.py）
        canonical = "-".join(w.capitalize() for w in k.split("-"))
        if canonical != k:
            out[canonical] = s
    return out


class _FallbackRawRequest:
    """`lark_oapi.core.model.RawRequest` 的最小结构 —— 只在 CI 里没装 SDK 时用（tests
    要能跑）。字段与 SDK 那个类逐字段一致，SDK 装了就走真的那个。"""
    def __init__(self):
        self.uri = None
        self.headers: dict[str, str] = {}
        self.body: bytes | None = None


def parse_function_url_event(event: dict):
    """API GW HTTP API v2（payload format 2.0）/ Function URL 事件 → `RawRequest`。

    两种入口的事件形状一致，所以 2026-09-01 把公网入口从 Function URL 换成 HTTP API
    时这个函数一行都不用改（函数名保留历史叫法，调用点在两个 ingress 里）。

    模仿 `lark_oapi/adapter/flask/parser.py::parse_req`。**不做任何 JSON 解析**，
    body 原样传给 SDK 保住签名。
    """
    try:
        from lark_oapi.core.model import RawRequest
    except ModuleNotFoundError:
        RawRequest = _FallbackRawRequest        # 只在 CI 单测里进这个分支

    req = RawRequest()
    # uri 只用于日志；requestContext 里两个字段都可能存在
    ctx = (event or {}).get("requestContext") or {}
    http = ctx.get("http") or {}
    req.uri = str(http.get("path") or event.get("rawPath") or "/")
    req.headers = _lower_headers((event or {}).get("headers") or {})

    body = (event or {}).get("body")
    if body is None:
        req.body = b""
    elif event.get("isBase64Encoded"):
        try:
            req.body = base64.b64decode(body)
        except (ValueError, TypeError):
            req.body = b""      # 让 SDK 走 InvalidArgsException → 401 空 body
    elif isinstance(body, (bytes, bytearray)):
        req.body = bytes(body)
    else:
        # 明文 body：**保持原字节**，别 str → dict → json.dumps 再来一遍（会毁签名）
        req.body = str(body).encode("utf-8")
    return req


def to_function_url_response(resp) -> dict:
    """把 SDK 的 `RawResponse` 翻译成 API GW v2 响应形状 —— 应用硬约束 B。

    参数 `resp` 可以是 SDK 的 `RawResponse`，也可以是 None（我们主动 401 的路径）。
    """
    body = b""
    status = 200
    try:
        if resp is not None and getattr(resp, "content", None):
            body = resp.content
            status = int(getattr(resp, "status_code", 200) or 200)
    except Exception as e:
        logger.warning("webhook_adapter serialize failed: %s", type(e).__name__)
        body, status = b"", 500

    if status >= 500:
        # SDK 的 500 body 里含 str(e) —— **不外泄**。同时改 200 让飞书不重试。
        # （若确实是我们内部 bug，服务端日志已有堆栈；用户侧只需成功 ack。）
        body, status = b'{"msg":"success"}', 200

    ct = "application/json; charset=utf-8"
    try:
        ct = (resp and resp.headers.get("Content-Type")) or ct
    except AttributeError:
        pass

    return {
        "statusCode": status,
        "headers": {"Content-Type": ct},
        "body": body.decode("utf-8") if isinstance(body, (bytes, bytearray)) else str(body),
    }


def unauthorized_response() -> dict:
    """401 空 body —— 用于 AccessDeniedException / NoAuthorizationException 兜底。"""
    return {"statusCode": 401, "headers": {"Content-Type": "text/plain"}, "body": ""}


def swallow_response() -> dict:
    """200 `{"msg":"success"}` —— 用于 processor-not-found / 反序列化失败等，
    避免飞书对未订阅事件无限重试打爆 ingress。"""
    return {"statusCode": 200,
            "headers": {"Content-Type": "application/json; charset=utf-8"},
            "body": '{"msg":"success"}'}
