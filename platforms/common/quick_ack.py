"""「收到了」的表情回复 —— 在「正在思考」卡片之前的那一下反馈。

现网反馈（2026-09-03）：「从问题发出到出现『正在思考』卡片的时间还是有些长」。
拆开看那段时间花在哪：

    T+0.00  Feishu/Slack 把事件 POST 给 ingress
    T+0.05  ingress 验签完，异步 invoke worker，回 200
    T+3~5   **worker 冷启动**（层里 1 万个 .py，即使预编译过也要 2.9~5.4s，
            见 scripts/build_im_layer.sh 的「预编译字节码」段）
    T+4~6   worker 拿 tenant token → 发出「正在思考」卡

也就是说这段等待的**大头是 worker 的冷启动**，不是卡片本身。所以「先给个反馈」这件事
只有放在 **ingress** 里才真的有用：ingress 被 EventBridge 每 4 分钟保活一次
（`platforms/common/warmup.py`），常态是热的，表情能在 **T+0.3s** 落地 —— 比卡片早
一个数量级。放 worker 里只能省下"建卡 + 读会话"那两百毫秒，等于没做。

── 三条硬约束 ───────────────────────────────────────────────────────────────
1. **必须在 `_dispatch_worker()` 之后发**。表情要多打一次 HTTP（token + reactions），
   放在投递之前 = 让真正干活的那一路白等这段时间，把要优化的延迟又加回去了。
2. **绝不抛异常、绝不阻塞回 200**。这是一层纯粹的体验加速，失败了用户照样能拿到
   卡片和答案；为了一个表情把 webhook 拖成非 2xx 会触发平台重试风暴。
   但**不静默**：非零返回码一律打一条 WARNING（缺权限就是这么被发现的，见 docs）。
3. **剩余时间不够就不发**。冷启动 INIT 撞 10s 上限后 Lambda 会把 init 挪进首次
   invoke 里重跑（现网实测重跑用掉 11.7s），那一次调用剩下的预算要留给"把 200 回出去"。
   判据走 `lambda_deadline`（ingress handler 入口已经 `set_from_context`）。
   ⚠️ 这个判据在 `feishu()` / `slack()` **内部**，所以调用方在它前面自己打的 HTTP
   不受它保护 —— 飞书 ingress 的「这条消息 worker 会不会回」要查 bot 自己的 open_id
   （一次 token + 一次 OpenAPI），那一段发生在进到这里**之前**。故把判据导出成公开的
   `budget_ok()`，调用方在花第一分钱之前先问一次。见
   `platforms/feishu/lambda_ingress.py::_quick_ack`。

── 刻意没做的事 ─────────────────────────────────────────────────────────────
· **不在答完之后把表情换成 ✅**。那要多两次 API 调用（remove + add），而卡片本身的
  状态标题已经说明了进度（「思考中」→「回答」+ 计时），表情的职责只是"收到了"。
· **不做去重**。平台重试会让同一条消息再走一遍这里，但两边的 `reactions.add` 对
  「同一个用户 + 同一个表情」都是幂等的（Slack 返回 `already_reacted`），不值得为它
  引一张状态表。ingress 侧能便宜拿到重试标记的（Slack 的 `X-Slack-Retry-Num`）顺手
  跳过，拿不到的（飞书）就让它重复调一次。
  ⚠️ 这份免费的幂等性**依赖"同一条消息永远同一个表情"**——所以表情池是按消息 id
  确定性选取的，不是 `random.choice`（见 `ack_variants`）。随机选会在用户那条消息上
  贴出第二个表情，等于亲手把这条"刻意没做"变成必须做。
"""
from __future__ import annotations

import json
import logging
import os
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from platforms.common import ack_variants, lambda_deadline

logger = logging.getLogger(__name__)

#: 表情不再是一个常量了 —— 按消息 id 从池子里确定性选一个（见 `ack_variants` 模块头：
#: 为什么是确定性而不是 random，以及 `IM_ACK_EMOJI_*` 钉死单个表情的语义为什么没变）。
#: 池里除了兜底那一项都**没在真实租户上验证过键名**，所以下面留了一次回落：失败就用
#: 兜底键再发一次。填错的代价是一条 WARNING，不是"用户那次没收到反馈"。

#: 剩余时间低于这个数就跳过表情（约束 3）。ingress 的 timeout 是 20s，正常 warm 调用
#: 进到这里还剩 19s+；只有"init 撞 10s 上限后重跑"那一次会掉到个位数。
MIN_REMAINING_SECONDS = 5.0

_SLACK_API = "https://slack.com/api/reactions.add"

_slack_token: str | None = None


def budget_ok() -> bool:
    """本次调用还够不够做"贴表情"这件闲事。**公开**：见约束 3 的 ⚠️ —— 调用方在自己
    花 HTTP 之前也要问一次，不然这道闸只挡住了最后一步。"""
    # 没设过 context（单测 / 本地）→ `remaining_seconds` 返回默认 900，正常发。
    return lambda_deadline.remaining_seconds() >= MIN_REMAINING_SECONDS


# ---------------------------------------------------------------------------
# 飞书
# ---------------------------------------------------------------------------
def feishu(message_id: str) -> bool:
    """给用户那条消息加一个表情。返回是否真的发出去了（只用于日志/断言）。

    ⚠️ 这里的 import 是**函数内**的：ingress 的 INIT 阶段有 10s 硬上限，能不进 init
    的就不进（`feishu_utils` 本身很轻，但这条纪律要守住 —— 它 import 的
    `core.lazy_boto` 以后要是变重了，受害的是冷启动）。
    """
    if not message_id or not budget_ok():
        return False
    emoji = ack_variants.feishu_emoji(message_id)
    if _feishu_react(message_id, emoji):
        return True
    if emoji == ack_variants.FEISHU_EMOJI_FALLBACK or not budget_ok():
        return False
    # 走到这里最可能是"这个 emoji_type 键在本租户不认"。回落到实测过的那个再试一次 ——
    # 缺权限的话第二次也会失败（两条 WARNING，一眼看得出是权限不是键名）。
    logger.warning("quick_ack.feishu: emoji=%s rejected, retrying with %s",
                   emoji, ack_variants.FEISHU_EMOJI_FALLBACK)
    return _feishu_react(message_id, ack_variants.FEISHU_EMOJI_FALLBACK)


def _feishu_react(message_id: str, emoji: str) -> bool:
    try:
        from platforms.feishu.app import feishu_utils
        resp = feishu_utils.add_reaction(message_id, emoji) or {}
    except Exception as e:                        # noqa: BLE001
        # 约束 2：吃掉异常，但留下类型名。绝不带 payload / 用户原文。
        logger.warning("quick_ack.feishu: %s", type(e).__name__)
        return False
    code = resp.get("code")
    if code != 0:
        # 最常见的原因是缺 `im:message.reaction:write` 权限（客户在开放平台加完权限
        # 需要重新发布版本）。把 code 打出来，别打 msg 里可能带的回显内容。
        logger.warning("quick_ack.feishu: reactions.create code=%s emoji=%s",
                       code, emoji)
        return False
    return True


# ---------------------------------------------------------------------------
# Slack
# ---------------------------------------------------------------------------
def _slack_bot_token() -> str:
    """bot token，模块级缓存。

    ⚠️ 刻意**不走** `platforms/slack/caps.py::get_client()`：那个模块会把 slack_sdk
    连带整条 caps 依赖（i18n / ddb_state / devops_chat …）拉进 ingress，为了一次
    `reactions.add` 不值得 —— 而且 ingress 的 INIT 已经贴着 10s 上限。
    读取口径与 `caps.get_client` 一致：`SLACK_BOT_TOKEN_ARN` 的值可以是 secret 名
    也可以是 ARN（GetSecretValue 两种都吃），内容是**纯字符串** token。
    """
    global _slack_token
    if _slack_token:
        return _slack_token
    ref = os.environ.get("SLACK_BOT_TOKEN_ARN", "").strip()
    if not ref:
        return ""
    import boto3
    token = boto3.client("secretsmanager").get_secret_value(
        SecretId=ref)["SecretString"].strip()
    _slack_token = token
    return token


def slack(channel: str, ts: str) -> bool:
    """`reactions.add` —— 给用户那条消息加表情。`ts` 是消息自己的 `ts`，不是 thread_ts。"""
    if not channel or not ts or not budget_ok():
        return False
    emoji = ack_variants.slack_emoji(ts)
    if _slack_react(channel, ts, emoji):
        return True
    if emoji == ack_variants.SLACK_EMOJI_FALLBACK or not budget_ok():
        return False
    logger.warning("quick_ack.slack: emoji=%s rejected, retrying with %s",
                   emoji, ack_variants.SLACK_EMOJI_FALLBACK)
    return _slack_react(channel, ts, ack_variants.SLACK_EMOJI_FALLBACK)


def _slack_react(channel: str, ts: str, emoji: str) -> bool:
    try:
        token = _slack_bot_token()
        if not token:
            logger.warning("quick_ack.slack: SLACK_BOT_TOKEN_ARN not set")
            return False
        body = json.dumps({"channel": channel, "timestamp": ts,
                           "name": emoji}).encode("utf-8")
        req = Request(_SLACK_API, data=body, method="POST")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        if not req.full_url.lower().startswith("https://"):
            raise ValueError("refusing non-https URL")  # B310 mitigation
        with urlopen(req, timeout=5) as resp:  # nosec B310 - scheme validated above
            data = json.loads(resp.read().decode("utf-8"))
    except (HTTPError, URLError, ValueError, KeyError) as e:
        logger.warning("quick_ack.slack: %s", type(e).__name__)
        return False
    except Exception as e:                        # noqa: BLE001
        logger.warning("quick_ack.slack: %s", type(e).__name__)
        return False
    if not data.get("ok"):
        err = str(data.get("error") or "")
        if err == "already_reacted":
            # 平台重试走到这里 —— 不是问题，别当告警。
            return True
        # 常见：`missing_scope`（缺 reactions:write）/ `not_in_channel`；
        # `invalid_name` = 这个表情名在本 workspace 不存在 → 上层会回落重试一次。
        logger.warning("quick_ack.slack: reactions.add error=%s emoji=%s",
                       err, emoji)
        return False
    return True
