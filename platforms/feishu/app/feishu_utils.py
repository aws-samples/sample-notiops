"""
Feishu (Lark) helpers: tenant access token caching/refresh, OpenAPI calls.

Feishu requires tenant_access_token for all enterprise-app OpenAPI calls.
Tokens are short-lived (~2 hours) — we lazily refresh ~5min before expiry.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from core.lazy_boto import LazyClient
from platforms.common import lambda_deadline

logger = logging.getLogger(__name__)

OPENAPI_BASE = os.environ.get("FEISHU_OPENAPI_BASE", "https://open.feishu.cn/open-apis")
#: 惰性构造 —— 这个模块坐在 IM worker 的**模块级 import 路径**上（caps.py → 这里），
#: 而 `boto3.client("secretsmanager")` 在 import 期就要加载 botocore 的服务模型、
#: 跑一遍 endpoint/凭证解析。冷启动本来就贴着 Lambda 那条 10s INIT 硬上限
#: （根因与修法见 `scripts/build_im_layer.sh` 的「预编译字节码」段），能从 init 里
#: 挪出去的都挪走。行为不变：第一次 `.get_secret_value(...)` 时才真正构造。
_sm = LazyClient("secretsmanager")

_app_id: str | None = None
_app_secret: str | None = None
_token: str | None = None
_token_expiry: float = 0.0
_lock = threading.Lock()


#: HTTP 等待的地板：预算再紧也留一次机会。**不能是 0** —— `urlopen(timeout=0)` 不是
#: "不等"，而是立刻 `timed out`，等于把这条路径直接关掉。
_MIN_HTTP_TIMEOUT = 2.0
#: 给"把响应写回去"留的余量。urlopen 一直等到被 Lambda 杀掉，对外就是 5xx + 平台重试，
#: 而日志里只有一行 `Task timed out` —— 什么都看不出来。
_HTTP_RESERVE = 5.0


def _http_timeout(default: float) -> float:
    """这一次 HTTP 最多等多久 —— 不许超过本次调用剩下的时间。

    为什么需要这一层：ingress 的 timeout 是 **20s**（`infra/lib/constructs/im-core.ts`），
    而"取 token（10s）+ 一次 OpenAPI（15s）"两次都撞上限就是 **25s** —— 函数先被平台
    杀掉，API Gateway 对飞书回 5xx，飞书重试（答案不会重复，worker 用 `event_id` 去重，
    但 ingress 白烧一轮、且 CloudWatch 里只留下一行 `Task timed out`）。ingress 上跑的
    是「收到了」表情那条**纯体验**路径（`platforms/common/quick_ack.py` 约束 2/3），
    为它把 webhook 拖成非 2xx 是反的。

    ⚠️ 只会**变短，不会变长**（`min(default, ...)`）：worker（timeout 900s）与本地 /
    Fargate / 单测（没设过 context → `remaining_seconds()` 返回 900）都拿回原值，
    行为逐字不变。
    """
    room = lambda_deadline.remaining_seconds() - _HTTP_RESERVE
    if room >= default:
        return default
    return max(_MIN_HTTP_TIMEOUT, room)


def _load_credentials() -> tuple[str, str]:
    global _app_id, _app_secret
    if _app_id and _app_secret:
        return _app_id, _app_secret
    # Unified credential loading: read the single Feishu Secret JSON
    # (same source main.py uses) instead of two separate ARN env vars.
    # Format: {"app_id": "cli_xxx", "app_secret": "xxx", ...}
    _feishu_secret = json.loads(
        _sm.get_secret_value(
            SecretId=os.environ.get("FEISHU_SECRET_NAME", "notiops/im-bot-feishu")
        )["SecretString"]
    )
    _app_id = _feishu_secret["app_id"]
    _app_secret = _feishu_secret["app_secret"]
    return _app_id, _app_secret


def get_tenant_access_token() -> str:
    """Cached tenant access token; refreshes ~5min before expiry."""
    global _token, _token_expiry
    with _lock:
        if _token and time.time() < _token_expiry - 300:
            return _token
        app_id, app_secret = _load_credentials()
        body = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode("utf-8")
        req = Request(f"{OPENAPI_BASE}/auth/v3/tenant_access_token/internal",
                      data=body, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        if not (req.full_url if hasattr(req, "full_url") else str(req)).lower().startswith(("https://","http://")):
            raise ValueError("refusing non-http(s) URL")  # B310 mitigation
        with urlopen(req, timeout=_http_timeout(10)) as resp:  # nosec B310 - scheme validated above
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("code") != 0:
            raise RuntimeError(f"Feishu token fetch failed: {data}")
        _token = data["tenant_access_token"]
        _token_expiry = time.time() + int(data.get("expire", 7200))
        logger.info("Refreshed tenant_access_token (expires in %ds)", data.get("expire"))
        return _token


# ---------------------------------------------------------------------------
# Generic OpenAPI call wrapper
# ---------------------------------------------------------------------------
def call_openapi(method: str, path: str, payload: dict | None = None,
                 query: dict | None = None) -> dict:
    """Call Feishu OpenAPI with tenant token."""
    url = f"{OPENAPI_BASE}{path}"
    if query:
        from urllib.parse import urlencode
        url = f"{url}?{urlencode(query)}"
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {get_tenant_access_token()}")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        if not (req.full_url if hasattr(req, "full_url") else str(req)).lower().startswith(("https://","http://")):
            raise ValueError("refusing non-http(s) URL")  # B310 mitigation
        with urlopen(req, timeout=_http_timeout(15)) as resp:  # nosec B310 - scheme validated above
            data = json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body_txt = e.read().decode("utf-8") if e.fp else ""
        logger.error("Feishu API %s %s -> HTTP %d %s", method, path, e.code, body_txt)
        return {"code": -1, "msg": f"http {e.code}: {body_txt}"}
    except URLError as e:
        logger.error("Feishu API %s %s -> conn error %s", method, path, e.reason)
        return {"code": -1, "msg": str(e.reason)}
    if data.get("code") != 0:
        logger.warning("Feishu API non-zero: %s %s -> %s", method, path, data)
    return data


# ---------------------------------------------------------------------------
# Message helpers (text + interactive cards)
# ---------------------------------------------------------------------------
def send_text(chat_id: str, text: str, root_id: str | None = None) -> dict:
    """Send a plain text message (optionally as a thread reply)."""
    content = json.dumps({"text": text}, ensure_ascii=False)
    return _send(receive_id_type="chat_id", receive_id=chat_id,
                 msg_type="text", content=content, root_id=root_id)


def send_text_to_chat(chat_id: str, text: str) -> dict:
    """Send a plain text message directly to the group's main timeline.
    Avoids thread-reply rendering which Feishu sometimes routes to a
    DM-like topic view on mobile clients."""
    return send_text(chat_id, text, root_id=None)


def send_card(chat_id: str, card: dict, root_id: str | None = None) -> dict:
    """Send an interactive card (Feishu's structured message format)."""
    return _send(receive_id_type="chat_id", receive_id=chat_id,
                 msg_type="interactive",
                 content=json.dumps(card, ensure_ascii=False),
                 root_id=root_id)


def update_card(message_id: str, card: dict) -> dict:
    """Patch an interactive card in place (used after user clicks confirm/cancel)."""
    return call_openapi("PATCH", f"/im/v1/messages/{message_id}",
                        payload={"content": json.dumps(card, ensure_ascii=False)})


def reply_text(message_id: str, text: str, *,
               in_thread: bool = True) -> dict:
    """Reply to a specific message.

    By default we set ``reply_in_thread: true`` so the response opens /
    continues a Feishu **thread** on the original @-mention, keeping
    the main chat timeline reserved for substantive bot output
    (dispatch confirmation cards, investigation reports). Used for
    chitchat / general_qa replies and the zero-change REFUSAL text.

    Pass ``in_thread=False`` to use the legacy quote-style reply that
    appears inline on the main timeline. Rarely needed."""
    payload: dict = {
        "content": json.dumps({"text": text}, ensure_ascii=False),
        "msg_type": "text",
    }
    if in_thread:
        payload["reply_in_thread"] = True
    return call_openapi("POST", f"/im/v1/messages/{message_id}/reply", payload=payload)


def get_message(message_id: str) -> dict:
    """读一条**已有消息**的正文（`GET /im/v1/messages/:id`）。

    用途只有一个：用户对着一条历史消息点「回复」/「在话题中回复」再 @NotiOps 时，
    把那条消息的正文取回来当背景（B8 第 7 项，见
    `platforms/common/quoted_context.py`）。

    ⚠️ 权限用的是现有的 `im:message` / `im:message:readonly`，**不需要客户加新 scope**
    （前提是 bot 在那个会话里 —— 不在的话飞书返回非零码，我们按"取不到"处理并
    **明确告诉用户**，不静默）。撤回的消息同样是非零码。
    """
    return call_openapi("GET", f"/im/v1/messages/{message_id}")


def get_message_text(message_id: str) -> tuple[str, str]:
    """`get_message` + 解析，返回 ``(正文, 发件人 id)``。取不到就 ``("", "")``。

    解析在 `platforms/feishu/msg_text.py`（不依赖 lark_oapi，因此 CI 里能测）。
    """
    from platforms.feishu import msg_text
    data = get_message(message_id)
    if data.get("code") != 0:
        return "", ""
    items = ((data.get("data") or {}).get("items") or [])
    if not items:
        return "", ""
    item = items[0]
    return msg_text.parse_item(item), msg_text.sender_of(item)


def add_reaction(message_id: str, emoji_type: str) -> dict:
    """给一条消息加表情回复（`POST /im/v1/messages/:id/reactions`）。

    用途只有一个：ingress 在「正在思考」卡片之前先给用户一个"收到了"的反馈
    （理由与延迟分解见 `platforms/common/quick_ack.py` 文件头）。

    ⚠️ 需要 `im:message.reaction:write` 权限，客户在开放平台加完权限要**重新发布版本**
    才生效。没有权限时返回 `{"code": <非0>}` —— 调用方按"不影响答案"处理，只打一条
    WARNING，绝不抛。`emoji_type` 是飞书的表情键（不是 Unicode 表情），填错同样是非零码。
    """
    return call_openapi("POST", f"/im/v1/messages/{message_id}/reactions",
                        payload={"reaction_type": {"emoji_type": emoji_type}})


def _send(receive_id_type: str, receive_id: str, msg_type: str,
          content: str, root_id: str | None = None) -> dict:
    payload: dict = {
        "receive_id": receive_id,
        "msg_type": msg_type,
        "content": content,
    }
    if root_id:
        # Reply within an existing thread root
        return call_openapi("POST", f"/im/v1/messages/{root_id}/reply",
                            payload={"content": content, "msg_type": msg_type,
                                     "reply_in_thread": True})
    return call_openapi("POST", "/im/v1/messages",
                        payload=payload, query={"receive_id_type": receive_id_type})


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------
def strip_at_mention(text: str) -> str:
    """
    Remove leading @bot mentions from a Feishu text message.
    Feishu wraps mentions as `@_user_1` placeholders that are resolved client-side;
    in events the original text shows `@<bot_name>` literal. Best-effort strip.
    """
    import re
    # @_user_N tokens (Feishu placeholder for at-mentions)
    text = re.sub(r"@_user_\d+\s*", "", text or "", flags=re.IGNORECASE)
    # Generic leading @something whitespace
    text = re.sub(r"^\s*@\S+\s*", "", text)
    return text.strip()
