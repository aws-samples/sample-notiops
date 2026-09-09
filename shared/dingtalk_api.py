"""钉钉服务端 API —— **两个 Lambda 共用的唯一一份实现**。

为什么这个文件在 `shared/` 而不是 `platforms/dingtalk/`
------------------------------------------------------
钉钉的出站要在**两个不同的 Lambda 里**发生：

  1. IM worker（`platforms/dingtalk/lambda_worker.py`）—— 会话内回复；
  2. 报告投递 / 推送（`shared/report_delivery/report_handler.py`、
     `lambda/push_handler.py`）—— 调查跑完几十分钟后**另一个函数**把结果贴回原会话。

而 `infra/lib/notiops-backend-stack.ts` 给回调那个函数的 asset 排除列表里有
``"platforms/**"``（方式 A 的 `notiops-webchat-standalone-stack.ts` 同构）。也就是说
**报告投递那条路 import 不到 `platforms.dingtalk.sender`** —— 真那么写，现网表现是
`Runtime.ImportModuleError`，本地测试却全绿（本地没有 asset 边界）。

反过来，`infra/im-code-exclude.txt` **没有**排除 `shared/`（`core/` 也没有），所以
`shared/` 是唯一能被两边同时 import 的地方。凭证读取 / access_token 缓存 /
`msgParam` 上限 / `groupMessages/send` / `oToMessages/batchSend` 这些**必须只有一份**：
复制两份的结局是"改了一处忘了另一处"，而钉钉这些约束（15000 **字节**、20 个 userId）
一旦漂移，表现是整条消息发不出去而不是报错。

`platforms/dingtalk/sender.py` 只留**会话层**（`Session` / `bind` / `current` /
`clear` / `send_session` / `reply`）—— 那些东西只有 worker 有（`sessionWebhook` 来自
入站报文），报告投递那条路压根拿不到。

三条出站机制（逐条在钉钉开放平台上核实过）
--------------------------------------------------------
| # | 机制                                        | 支持 @ | 需要 token | 谁在用 |
| 1 | 回调报文里带的 `sessionWebhook`             | ✅     | ❌         | worker（`platforms/dingtalk/sender.py`）|
| 2 | `POST /v1.0/robot/groupMessages/send`       | ❌     | ✅         | 群的会话外投递（本文件）|
| 3 | `POST /v1.0/robot/oToMessages/batchSend`    | ❌     | ✅         | 单聊的会话外投递（本文件）|

日志纪律（`docs/LOGGING_STANDARD.md`）
-------------------------------------
· `app_key` / `app_secret` / access_token / `sessionWebhook` 绝不进日志，**连长度都不记**。
· `staffId` 是人员标识 —— 只记**计数**。
· 用户问题原文不进日志。这里只记 `errcode` / `code` 和异常**类型名**。
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request

from shared.net import safe_urlopen

logger = logging.getLogger(__name__)

PLATFORM = "dingtalk"

#: 服务端 API 根。钉钉新版（v1.0）接口都在这个域名下。
NEW_API = "https://api.dingtalk.com"

#: 单次 HTTP 超时。一次发消息卡住 15s 以上只可能是网络异常 —— 快点失败去走兜底，
#: 比把这一轮（worker 900s / 投递 Lambda 的预算）拖死好。
HTTP_TIMEOUT_SECONDS = 15

#: access_token 提前刷新余量。钉钉给的 `expireIn` 是 7200 秒。
TOKEN_REFRESH_MARGIN_S = 300

#: `oToMessages/batchSend` 一次最多 20 个 userId（官方硬上限）。
MAX_OTO_USERS = 20

#: `msgParam` 的硬上限是 **15000 字节**（不是字符）。渲染层的 `MAX_BODY = 3000`
#: 字已经留了足够余量（3000 × 3 字节 CJK = 9000），这里只做最后一道保险。
MAX_MSG_PARAM_BYTES = 15000

#: 会话定向路由行的 `kind`（详见 `save_route`）。
ROUTE_KIND = "dtroute"

#: 路由行的 `user_id` 位 —— **必须非空**：`ddb_state.put_convo_session` /
#: `get_convo_session` / `clear_convo_session` 三个函数开头都是
#: `if not (platform and chat_id and user_id and kind): return`，
#: 传空串是**静默 no-op**（写不进去、读不出来，一条日志都没有）。
#: 用 `"-"` 这个哨兵值把"路由是按会话存的、不是按人存的"写进数据里。
ROUTE_USER = "-"

#: 路由行 TTL。调查最长几十分钟，7 天足够覆盖"报告失败重投 / 人工重跑"。
ROUTE_TTL_SECONDS = 7 * 24 * 3600


# ---------------------------------------------------------------------------
# 凭证
# ---------------------------------------------------------------------------
_SECRET_LOCK = threading.Lock()
_secret_cache: dict | None = None


def secret_id() -> str:
    """优先用 ARN（一键 CFN 与 setup.sh 都会注入），退到字面名。"""
    return (os.environ.get("DINGTALK_SECRET_ARN")
            or os.environ.get("DINGTALK_SECRET_NAME")
            or "notiops/im-bot-dingtalk")


def _secret_label() -> str:
    """报错文案里指的那个 secret —— ARN 尾部的随机后缀砍掉（那 6 位没信息量）。"""
    sid = secret_id()
    return sid.rsplit(":", 1)[0] if sid.startswith("arn:") else sid


def load_secret() -> dict:
    """整个 secret（JSON 对象）。进程内缓存 —— Lambda 复用执行环境时不重复取。"""
    global _secret_cache
    with _SECRET_LOCK:
        if _secret_cache is not None:
            return _secret_cache
        # 惰性 import：ingress 的冷启动只要验签，不该为了 boto3 多付几百毫秒；
        # 而报告投递那条路本来就已经 import 了 boto3。
        import boto3
        sm = boto3.client("secretsmanager")
        raw = sm.get_secret_value(SecretId=secret_id())["SecretString"]
        try:
            data = json.loads(raw)
        except (TypeError, ValueError):
            # 客户手工把整个 secret 改成了裸串 —— 当成 app_secret 单值处理会更糟
            # （app_key 依然是空的，只是错误从"没填"变成"填了但发不出去"）。照实报。
            raise RuntimeError(
                "dingtalk secret is not valid JSON; expected "
                '{"app_key": "...", "app_secret": "..."}') from None
        if not isinstance(data, dict):
            raise RuntimeError("dingtalk secret must be a JSON object")
        _secret_cache = data
        return data


def load_credentials() -> tuple[str, str]:
    """``(app_key, app_secret)``。**任一为空立刻抛**。

    CDK 建 secret 时用的是 `secretStringTemplate`（字段是**空串**）+ 独立的
    `generateStringKey: "placeholder"` —— 与飞书逐字同构。所以"客户还没填"的表现就是
    空串。不许回落成"发不出去但日志里只有一条 warning"（`不许静默降级`）。
    """
    data = load_secret()
    app_key = str(data.get("app_key") or "").strip()
    secret = str(data.get("app_secret") or "").strip()
    if not app_key or not secret:
        # 只说缺哪个字段、在哪个 secret 里 —— 不打值、不打长度。
        raise RuntimeError(
            "dingtalk credentials not configured: fill app_key / app_secret "
            f"in secret {_secret_label()}")
    return app_key, secret


def app_secret() -> str:
    """入站验签要的那一个（`sign = base64(HMAC_SHA256(appSecret, ts + "\\n" + appSecret))`）。"""
    return load_credentials()[1]


def card_template_id() -> str:
    """Tier 2（真互动卡片）的模板 id。**今天恒为空**。

    普通版互动卡片接口（`cardTemplateId="StandardCard"`）官方已标注「接口不再支持新
    应用接入」，真卡片要客户自己在开放平台搭建并发布一个模板。所以这里只留判空位：
    有值才有资格走 Tier 2，没值就是 Tier 1（markdown），**不假装有**。
    """
    try:
        return str(load_secret().get("card_template_id") or "").strip()
    except Exception as e:                        # noqa: BLE001
        logger.warning("card_template_id lookup failed: %s", type(e).__name__)
        return ""


def push_webhook_url() -> str:
    """旧自定义机器人的推送地址（可选字段 `webhook_url`）。

    ⚠️ 这个 URL **本身就是凭证**（谁拿到都能往那个群里发消息）。只在
    `shared/report_delivery/dingtalk_sender.py` 的 cron/广播兜底路径用，绝不进日志。
    """
    try:
        return str(load_secret().get("webhook_url") or "").strip()
    except Exception as e:                        # noqa: BLE001
        logger.warning("webhook_url lookup failed: %s", type(e).__name__)
        return ""


# ---------------------------------------------------------------------------
# access_token（只有机制 2/3 需要）
# ---------------------------------------------------------------------------
_TOKEN_LOCK = threading.Lock()
_token_cache: tuple[str, float] | None = None     # (token, expires_at_epoch)


def _fetch_access_token() -> tuple[str, float]:
    app_key, secret = load_credentials()
    body = json.dumps({"appKey": app_key, "appSecret": secret}).encode("utf-8")
    payload = post_json(f"{NEW_API}/v1.0/oauth2/accessToken", body)
    token = str((payload or {}).get("accessToken") or "")
    if not token:
        raise RuntimeError("dingtalk accessToken response has no accessToken")
    expire_in = int((payload or {}).get("expireIn") or 7200)
    return token, time.time() + expire_in - TOKEN_REFRESH_MARGIN_S


def get_access_token() -> str:
    """带缓存的 access_token。线程安全（进度心跳线程也可能走到）。"""
    global _token_cache
    with _TOKEN_LOCK:
        if _token_cache and _token_cache[1] > time.time():
            return _token_cache[0]
        _token_cache = _fetch_access_token()
        return _token_cache[0]


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def post_json(url: str, body: bytes, *, headers: dict | None = None) -> dict:
    """POST 一段 JSON，回解析好的 dict。**URL 永不进日志**（见模块头）。

    走 `shared.net.safe_urlopen`：URL 里有一段来自入站报文（`sessionWebhook`），
    而 `urlopen` 本身还认 `file://` 等 scheme（B310）。
    """
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={"Content-Type": "application/json", **(headers or {})})
    with safe_urlopen(req, timeout=HTTP_TIMEOUT_SECONDS) as resp:
        raw = resp.read().decode("utf-8", "replace")
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {}


def msg_param(payload: dict) -> str:
    """`msgParam` 是一个 **JSON 字符串**（不是对象），且 ≤15000 字节。

    超限时**不静默截断到一半 JSON**（那会让整条消息发不出去，钉钉直接报参数错）——
    截 `text` 字段本身，并留一个省略号。渲染层的 `MAX_BODY` 正常情况下就到不了这里。
    """
    s = json.dumps(payload, ensure_ascii=False)
    if len(s.encode("utf-8")) <= MAX_MSG_PARAM_BYTES:
        return s
    text = str(payload.get("text") or "")
    # 逐步砍，直到整包进得去。CJK 3 字节，一次砍 500 字最多几轮就收敛。
    while text and len(s.encode("utf-8")) > MAX_MSG_PARAM_BYTES:
        text = text[:max(0, len(text) - 500)]
        payload = {**payload, "text": text + "…"}
        s = json.dumps(payload, ensure_ascii=False)
    logger.warning("dingtalk msgParam over %d bytes - text clipped",
                   MAX_MSG_PARAM_BYTES)
    return s


# ---------------------------------------------------------------------------
# 机制 2/3：会话外投递
# ---------------------------------------------------------------------------
def send_group(open_conversation_id: str, *, title: str, text: str,
               robot_code: str = "") -> bool:
    """机制 2：群的会话外投递。**不支持 @**，需要「企业内机器人发送消息权限」。"""
    if not open_conversation_id:
        return False
    try:
        app_key, _ = load_credentials()
        token = get_access_token()
    except Exception as e:                        # noqa: BLE001
        logger.warning("dingtalk group send: no credentials/token: %s",
                       type(e).__name__)
        return False
    body = {
        "msgKey": "sampleMarkdown",
        "msgParam": msg_param({"title": title or " ", "text": text or " "}),
        "openConversationId": open_conversation_id,
        "robotCode": robot_code or app_key,
    }
    try:
        resp = post_json(f"{NEW_API}/v1.0/robot/groupMessages/send",
                         json.dumps(body, ensure_ascii=False).encode("utf-8"),
                         headers={"x-acs-dingtalk-access-token": token})
    except (urllib.error.URLError, OSError, ValueError) as e:
        logger.warning("dingtalk group send failed: %s", type(e).__name__)
        return False
    ok = bool(resp.get("processQueryKey"))
    if not ok:
        logger.warning("dingtalk group send rejected: code=%s", resp.get("code"))
    return ok


def send_oto(user_ids, *, title: str, text: str, robot_code: str = "") -> bool:
    """机制 3：单聊的会话外投递。**不支持 @**，一次 ≤20 个 userId。"""
    ids = [u for u in (user_ids or []) if u][:MAX_OTO_USERS]
    if not ids:
        return False
    try:
        app_key, _ = load_credentials()
        token = get_access_token()
    except Exception as e:                        # noqa: BLE001
        logger.warning("dingtalk oto send: no credentials/token: %s",
                       type(e).__name__)
        return False
    body = {
        "msgKey": "sampleMarkdown",
        "msgParam": msg_param({"title": title or " ", "text": text or " "}),
        "robotCode": robot_code or app_key,
        "userIds": ids,
    }
    try:
        resp = post_json(f"{NEW_API}/v1.0/robot/oToMessages/batchSend",
                         json.dumps(body, ensure_ascii=False).encode("utf-8"),
                         headers={"x-acs-dingtalk-access-token": token})
    except (urllib.error.URLError, OSError, ValueError) as e:
        logger.warning("dingtalk oto send failed: %s", type(e).__name__)
        return False
    # 部分失败要留痕，但**只记计数** —— staffId 是人员标识，不进日志。
    invalid = len(resp.get("invalidStaffIdList") or [])
    throttled = len(resp.get("flowControlledStaffIdList") or [])
    if invalid or throttled:
        logger.warning("dingtalk oto send partial: invalid=%d throttled=%d",
                       invalid, throttled)
    return bool(resp.get("processQueryKey"))


# ---------------------------------------------------------------------------
# 会话定向路由（worker 写、报告投递读）
# ---------------------------------------------------------------------------
def save_route(*, conversation_id: str, is_direct: bool, staff_id: str,
               robot_code: str = "") -> None:
    """记下「这个会话该用机制 2 还是机制 3 投递」。worker 起调查时写一次。

    为什么必须存这一行：飞书 / Slack 的报告回写靠 `root_message_id` 找到那条消息
    再回到它的 thread 里；钉钉**发出去的消息拿不到 id**，`ImMessage.root_message_id`
    刻意留空（设计文档 §4.4）。投递侧的 `_resolve_chat_target()` 只给
    `{platform, chat_id, ...}`，**连 `user_id` 都不给** —— 所以：

    · 键必须是**按会话**的（`user_id` 位填 `ROUTE_USER` 哨兵），按人存投递侧读不到；
    · `is_direct` 决定走群还是单聊 —— 猜错的后果不是发失败，而是**发到别的地方去**
      （把群里的调查结果私聊给一个人，或者反过来）。

    同一个群里第二个人再起一次调查会覆盖这一行 —— 无害：`conversation_id` 是同一个，
    `is_direct` 也是同一个，`staff_id` 只在单聊分支用得上（单聊里只有一个人）。
    """
    if not conversation_id:
        return
    from core import ddb_state
    try:
        ddb_state.put_convo_session(
            platform=PLATFORM, chat_id=conversation_id, user_id=ROUTE_USER,
            kind=ROUTE_KIND,
            data={
                "is_direct": bool(is_direct),
                "conversation_id": conversation_id,
                "staff_id": staff_id or "",
                "robot_code": robot_code or "",
            },
            ttl_seconds=ROUTE_TTL_SECONDS,
        )
    except Exception as e:                        # noqa: BLE001
        # 写不进去不该让这一轮问答失败 —— 但要留痕：没有这一行，报告只能回落到
        # 自定义机器人 webhook（甚至完全投不出去）。
        logger.warning("dingtalk save_route failed: %s", type(e).__name__)


def load_route(conversation_id: str) -> dict | None:
    """读回 `save_route` 存的那一行。没有 → None（调用方回落）。"""
    if not conversation_id:
        return None
    from core import ddb_state
    try:
        return ddb_state.get_convo_session(
            platform=PLATFORM, chat_id=conversation_id, user_id=ROUTE_USER,
            kind=ROUTE_KIND)
    except Exception as e:                        # noqa: BLE001
        logger.warning("dingtalk load_route failed: %s", type(e).__name__)
        return None
