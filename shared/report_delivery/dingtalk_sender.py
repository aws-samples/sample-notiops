"""DingTalk sender — Lambda → DingTalk delivery.

Mirrors the public interface of `feishu_sender.py` /
`slack_sender.py` so `shared/report_delivery/report_handler.py` and
`push_handler.py`'s `_load_sender(platform)` branch picks
this up unchanged.

Delivery model (different from feishu / slack)
----------------------------------------------

Two mechanisms, and **which one runs depends on the caller**:

  1. **企业内部应用机器人 server API** — `groupMessages/send` (group) /
     `oToMessages/batchSend` (1:1), implemented once in
     `shared/dingtalk_api.py` and keyed off the SAME
     `notiops/im-bot-dingtalk` secret the IM worker uses. This IS
     available from a Lambda — it needs an access_token, not an
     inbound `sessionWebhook`.

     ⚠️ An earlier version of this docstring claimed "NO outbound
     delivery from a Lambda is possible because the Lambda has no
     `incoming_message` to reach for". That was **wrong** and is why
     report write-back used to land in whatever group the operator's
     custom-bot happened to live in instead of the group that asked.
     `sessionWebhook` is only one of three mechanisms (see the table
     in `shared/dingtalk_api.py`); the other two are token-based.

     Routing needs one extra bit the DDB investigation row doesn't
     carry: **group or 1:1**. `platforms/dingtalk/caps.py` writes it
     with `sender.save_route()` when the investigation starts, and
     `dingtalk_api.load_route()` reads it back here. Guessing wrong
     doesn't fail loudly — it delivers a group's investigation result
     into one person's DM (or the reverse).

  2. **Custom (自定义机器人) webhook robot** — a separate robot
     class that lives in a SPECIFIC group, exposes one HMAC-signed
     webhook URL, and is the standard channel for "machine pushes
     a notification into a group" (Jenkins, Prometheus, AWS, …).
     Kept as (a) the fallback when mechanism 1 has no route / no
     credentials, and (b) the ONLY path for cron broadcast
     (`send_markdown`) and push heads-ups — those have no
     conversation to route back to. The webhook URL comes from
     `DINGTALK_PUSH_WEBHOOK_URL` (or its `_ARN` indirection, or the
     optional `webhook_url` field of the bot secret) and the HMAC
     sign-secret from `DINGTALK_PUSH_WEBHOOK_SECRET`. If absent, the
     delivery call logs a clear warning and returns without raising —
     so the rest of the report-handler / push-handler still works for
     the feishu / slack platforms.

Live progress cards (`update_live_card`, `send_live_console_link`)
remain stubs. Real-time cards on DingTalk require a pre-registered
cardTemplateId in the DingTalk Open Platform UI, which is operator
config that can't be automated from CFN. Tracked as Phase 2c.

Keep the function signatures byte-for-byte identical to
feishu_sender / slack_sender — the dispatcher does positional +
keyword calls both ways.
"""
from __future__ import annotations
from core import i18n
from shared import dingtalk_api
from shared.net import safe_urlopen

import base64
import hashlib
import hmac
import json
import logging
import os
import re as _re
import time
import urllib.error
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Custom-bot webhook delivery — outbound-only path used by Lambda.
# ---------------------------------------------------------------------------

def _read_secret(env_name: str) -> str:
    arn = os.environ.get(env_name, "")
    if not arn:
        return ""
    import boto3
    sm = boto3.client("secretsmanager")
    return sm.get_secret_value(SecretId=arn)["SecretString"]


def _push_webhook_url() -> str:
    """Resolve the custom-bot webhook URL.

    Priority:
      1. Plain `DINGTALK_PUSH_WEBHOOK_URL` env (set by template.yaml
         from the CFN parameter)
      2. `DINGTALK_PUSH_WEBHOOK_URL_ARN` Secrets Manager indirection
         (so operators can keep the URL out of CFN params if their
         security review prefers that)
    """
    direct = os.environ.get("DINGTALK_PUSH_WEBHOOK_URL", "")
    if direct:
        return direct
    from_arn = _read_secret("DINGTALK_PUSH_WEBHOOK_URL_ARN")
    if from_arn:
        return from_arn
    # 3. The optional `webhook_url` field of `notiops/im-bot-dingtalk`.
    #    The Lambda-webhook shape only provisions ONE dingtalk secret, so a
    #    customer who wants the cron/broadcast path has nowhere else to put
    #    this. Without this branch the field documented in
    #    `platforms/dingtalk/README.md` would be read by nobody.
    return dingtalk_api.push_webhook_url()


def _push_webhook_secret() -> str:
    """The custom-bot's "加签" HMAC secret. Optional — the operator
    can configure their custom-bot with "自定义关键词" or "IP 段"
    instead of HMAC, in which case this returns "" and we just
    POST without a signature."""
    direct = os.environ.get("DINGTALK_PUSH_WEBHOOK_SECRET", "")
    if direct:
        return direct
    return _read_secret("DINGTALK_PUSH_WEBHOOK_SECRET_ARN")


def _signed_url(base_url: str, secret: str) -> str:
    """Build a signed webhook URL per DingTalk's 加签 spec:

      timestamp = current ms
      string_to_sign = f"{timestamp}\n{secret}"
      sign = url-quoted base64( HMAC-SHA256(secret, string_to_sign) )
      url = f"{base_url}&timestamp={timestamp}&sign={sign}"

    Doc: https://open.dingtalk.com/document/robots/customize-robot-security-settings
    """
    if not secret:
        return base_url
    ts = str(round(time.time() * 1000))
    string_to_sign = f"{ts}\n{secret}"
    digest = hmac.new(secret.encode(), string_to_sign.encode(),
                      hashlib.sha256).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(digest).decode())
    sep = "&" if "?" in base_url else "?"
    return f"{base_url}{sep}timestamp={ts}&sign={sign}"


def _post_webhook(payload: dict) -> dict | None:
    """POST to the custom-bot webhook URL with optional 加签
    signature. Returns the parsed JSON response, or None on
    config / network error (errors are logged and swallowed —
    we never let a delivery hiccup crash the report-handler).
    """
    base_url = _push_webhook_url()
    if not base_url:
        logger.warning(
            "dingtalk_sender: DINGTALK_PUSH_WEBHOOK_URL not set; "
            "skipping outbound delivery (operator must add a "
            "custom-bot to the target group and put its URL in "
            "the env)")
        return None
    url = _signed_url(base_url, _push_webhook_secret())
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with safe_urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")[:500]
        logger.warning("dingtalk_sender: webhook HTTP %d: %s", e.code, raw)
        return None
    except Exception as e:
        logger.warning("dingtalk_sender: webhook post failed: %s", e)
        return None
    # DingTalk returns `{"errcode": 0, "errmsg": "ok"}` on success.
    if data.get("errcode", 0) != 0:
        logger.warning("dingtalk_sender: webhook returned errcode=%s msg=%s",
                       data.get("errcode"), data.get("errmsg"))
    return data


# ---------------------------------------------------------------------------
# 会话定向投递（机制 1）—— 报告回写走这条，回落到自定义机器人 webhook。
# ---------------------------------------------------------------------------

def _deliver_to_chat(chat_id: str, title: str, text: str) -> bool:
    """把一条 markdown 投到**提问的那个会话**。回 True = 送到了。

    顺序：
      1. `chat_id` 为空 → 没有会话可投，直接走自定义机器人 webhook；
      2. 读 `dtroute` 路由行 → 单聊走 `oToMessages/batchSend`、群走
         `groupMessages/send`；
      3. **没有路由行**（客户是从 web 起的调查、或者行过期了）→ 按**群**试一次：
         `chat_id` 对钉钉就是 `openConversationId`，群是绝大多数情况，而猜错的代价
         只是这一次发送失败（不会发到别人那儿去）——
         `send_oto` 的入参是 `staffId`，拿 `conversationId` 去当 staffId 一定失败；
      4. 还是不行 → 自定义机器人 webhook 兜底（那条路无视 `chat_id`，是"至少让人
         看到报告"而不是"投对地方"，所以放在最后而且要留一条 warning）。
    """
    if not chat_id:
        return bool(_post_webhook({
            "msgtype": "markdown",
            "markdown": {"title": title, "text": text},
            "at": {"isAtAll": False},
        }))

    route = dingtalk_api.load_route(chat_id) or {}
    robot_code = str(route.get("robot_code") or "")
    if route.get("is_direct"):
        staff_id = str(route.get("staff_id") or "")
        ok = dingtalk_api.send_oto([staff_id], title=title, text=text,
                                   robot_code=robot_code)
    else:
        ok = dingtalk_api.send_group(chat_id, title=title, text=text,
                                     robot_code=robot_code)
    if ok:
        return True

    # ⚠️ 这条 warning 是「报告投错群」这类投诉唯一的线索 —— 现网上一次就是这么被
    # 误判成"钉钉不支持报告回写"的。`chat_id` 是会话标识不是凭证，可以记。
    logger.warning(
        "dingtalk_sender: conversation-targeted delivery failed for chat=%s "
        "(routed=%s) — falling back to the custom-bot webhook, which ignores "
        "chat_id", chat_id[:32], bool(route))
    return bool(_post_webhook({
        "msgtype": "markdown",
        "markdown": {"title": title, "text": text},
        "at": {"isAtAll": False},
    }))


# ---------------------------------------------------------------------------
# Public interface — keep signatures identical to feishu_sender /
# slack_sender so the dispatcher can call us interchangeably.
# ---------------------------------------------------------------------------

def is_configured() -> bool:
    """True iff the env has enough configuration to deliver
    outbound messages. The dispatcher calls this to decide whether
    to attempt delivery; missing config = silent skip, never error.
    """
    return bool(_push_webhook_url())


def reply_text(parent_message_id: str, text: str) -> None:
    """No-op for DingTalk — DingTalk's custom-bot webhook can't
    "reply to a specific message id". The dispatcher uses this for
    trivial error messages; they go to the same group via the
    custom-bot webhook (no threading).

    We DON'T error — we silently log so the report-handler keeps
    running. If you want the message visible, the heads-up card
    path (`send_push_headsup`) covers the same ground with a real
    title.
    """
    logger.info(
        "dingtalk_sender.reply_text noop (parent=%s, text_head=%r)",
        parent_message_id[:24], (text or "")[:80])


#: 正文字符上界。钉钉自定义机器人对 markdown `text` 的实测上限在 20000
#: **字节**量级；中文一字 3 字节，4000 字符 ≈ 12000 字节，留足余量。
#: 报告链路上游（`report_handler._CARD_MAX_CHARS`）已经按 3000 字符裁过，
#: 所以这条只在别的调用方（或上游哪天放宽）时才生效 —— 但它必须存在：
#: 钉钉此前**一道闸门都没有**，超限的表现是整条消息发不出去。
_MD_MAX_CHARS = 4000


def _escape_md(s: str) -> str:
    """中和 `title` 里会改变 markdown 结构的字符。

    `title` 是**用户手打的原文**：行首一个 `#` 会把整行变成标题，一个 `|`
    在钉钉里会被当成表格分隔符。用户不会知道自己"打坏了卡片"。
    """
    return (s or "").replace("|", "\\|").replace("#", "＃")


def _bold(s: str) -> str:
    """把 i18n 文案里的 `*x*` 提成 `**x**`。

    i18n 文案里的强调统一写成单星（Slack mrkdwn 的语法），而钉钉 markdown
    跟标准 GFM 一样把单星读成**斜体**。不转的话「🎯 调查目标」在钉钉上
    是歪的 —— 不会报错，只是看着不对。
    """
    return _re.sub(r"(?<!\*)\*([^*\n]+?)\*(?!\*)", r"**\1**", s or "")


# ─── 钉钉 markdown 方言 —— `platforms/common/im_markdown.py` 的**本地副本** ──────
# 为什么复制而不是 import：这个模块跑在 `notiops-push-handler` /
# 报告回写 Lambda 里，而那些 asset 的 exclude 列表里有 `platforms/**`
# （见 `infra/lib/notiops-backend-stack.ts` 的 `pushLambdaCode`）——
# import 会在**运行时**炸，且只在真发消息那一刻炸。上面 `_bold` 已经是
# 同一个理由留下的副本，这里沿用那个先例。
# 改这三个函数时**必须同步改** `platforms/common/im_markdown.py`（那边是权威口径，
# 有完整注释和测试）。两边漂移的表现是"IM 里好的，报告卡里还是糊的"。

#: `_下划线斜体_` —— 钉钉不认（官方只列 `**加粗**` / `*斜体*`），下划线原样显示
#: 给用户。两侧的 `\w` 断言把 `snake_case` / `__bold__` 挡在外面。
_US_ITALIC_RE = _re.compile(r"(?<![\w`])_(?!\s)([^_\n]+?)(?<!\s)_(?![\w`])")
#: inline 代码段 —— 斜体转换只在代码段外做（代码里的 `_` 是标识符的一部分）。
_CODE_SPAN_RE = _re.compile(r"(`+[^`\n]*`+)")
#: 代码围栏 —— 围栏内的内容一律不动（里面的 `#` / `|` 是内容，不是语法）。
#: 权威那份还有一个 `_BLOCK_RE`（"块级行不硬化"），钉钉这边**故意没有** —— 见
#: `_harden_breaks` 的注释。
_FENCE_RE = _re.compile(r"^\s{0,3}(?:```|~~~)")


def _italic(s: str) -> str:
    """`_x_` → `*x*`。代码段内原样。"""
    return "".join(
        p if i % 2 else _US_ITALIC_RE.sub(r"*\1*", p)
        for i, p in enumerate(_CODE_SPAN_RE.split(s or "")))


def _emph(s: str) -> str:
    """i18n 文案 → 钉钉 inline 语法。**顺序不能换**：先把单星升成粗体，再把
    下划线降成单星 —— 反过来会把刚产出的 `*斜体*` 又升成 `**粗体**`。"""
    return _italic(_bold(s))


def _harden_breaks(s: str) -> str:
    """段落内的软换行 → 空行。**列表项之间也插**（与飞书那份的差别就在这）。

    钉钉那边单个 `\\n` 被吃掉、连空格都不留，多行正文糊成一整段
    （2026-09-08 现网 `/help` 就是这么来的）；紧凑列表也一样糊
    （同一天的「过程」那一段：两个步骤连成 `…gather more informationDone`）。
    所以这里不留 `_BLOCK_RE` 那个例外 —— 松散列表在钉钉上仍是列表，只是行距大一点。
    """
    lines = (s or "").split("\n")
    out: list[str] = []
    in_fence = False
    for k, ln in enumerate(lines):
        fence = bool(_FENCE_RE.match(ln))
        if fence:
            in_fence = not in_fence
        out.append(ln)
        if in_fence or fence or k + 1 >= len(lines):
            continue
        if not ln.strip() or not lines[k + 1].strip():
            continue
        out.append("")
    return "\n".join(out)


def _body_md(s: str) -> str:
    """正文（agent 产出 / 巡检摘要）→ 钉钉能渲染的形式。

    ⚠️ 必须在按 `_MD_MAX_CHARS` 裁剪**之前**跑 —— 硬化会加长度，先裁再硬化
    就可能又超上限（钉钉超限的表现是整条消息发不出去）。
    """
    out: list[str] = []
    in_fence = False
    for ln in _harden_breaks(s).split("\n"):
        if _FENCE_RE.match(ln):
            in_fence = not in_fence
            out.append(ln)
            continue
        out.append(ln if in_fence else _italic(ln))
    return "\n".join(out)


def send_report(chat_id: str, root_message_id: str, status: str,
                priority: str, detail_type: str, task_id: str,
                summary_md: str, html_url: str, trace_url: str,
                next_steps: list[dict] | None = None,
                locale: str = "zh", title: str = "",
                report_truncated: bool = False, **_kwargs) -> None:
    """Render the investigation result into the DingTalk group via the
    custom-bot webhook — one markdown message.

    markdown only (no ActionCard buttons): next_steps and the report /
    trace links are inlined as markdown links. They aren't real buttons
    but they're visible and clickable, and the ordering matches
    feishu/slack so the three platforms read the same.

    ⚠️ **没有 `console_url` 参数**（控制台深链不上报告卡）——理由见下面
    `link_lines` 处的注释。`**_kwargs` 会把它悄悄吃掉，所以这条**只能**
    靠注释和测试守住：补回它不会报错，只会让说明重新自相矛盾。

    `title` (D1) is the user's own question — rendered first, because
    without it the reader can't tell which investigation this report is.
    `report_truncated` (D4) says the body is a cut-down slice; the notice
    is rendered here per-locale, never spliced into `summary_md`.

    `chat_id` **is** used: it's the `openConversationId` of the chat that
    asked, and `_deliver_to_chat` routes the message back there via the
    server API (group vs 1:1 comes from the `dtroute` row). The custom-bot
    webhook is only the last-resort fallback — it's bound to ONE group per
    URL, so on that path the report lands wherever that bot lives.
    ⚠️ An earlier version of this docstring said `chat_id` was "accepted for
    parity but not used". Fixing that was the whole point: with `root_message_id`
    unusable on DingTalk (§4.4 — sent messages have no addressable id),
    `chat_id` is the *only* routing information this platform gives us.
    """
    # ⚠️ 这个局部变量原来也叫 `title`，跟新加的 `title` 入参**同名**。
    # 改名而不是复用：卡片顶部的 h3 是给钉钉列表页看的短标签（带 status /
    # task_id），跟用户问的那句话是两回事，混在一起两边都表达不清。
    heading = f"[{status}] {detail_type or 'NotiOps'} — {task_id[:8]}"
    body_parts: list[str] = [f"### {heading}"]
    if title:
        # 展示上界 140：存储上界是 200（`report_handler._TITLE_MAX_CHARS`）。
        shown = title if len(title) <= 140 else title[:139] + "…"
        body_parts.append(_emph(i18n.t("report.header.subject", locale,
                                       title=_escape_md(shown))))
    if priority:
        body_parts.append(f"**Priority:** {priority}")

    # 先降级再裁剪 —— 见 `_body_md` 的注释。
    body = _body_md((summary_md or "").strip()).strip()
    truncated = report_truncated
    if len(body) > _MD_MAX_CHARS:
        body = body[:_MD_MAX_CHARS]
        truncated = True
    if body:
        body_parts.append(body)
        if truncated:
            body_parts.append(_emph(i18n.t("report.summary_truncated", locale)))
    else:
        # 「没取到正文」≠「正文被截断」。以前这里两种情况都渲染成
        # `(empty report)`，读者无从判断该不该点完整报告链接（D4）。
        body_parts.append(_emph(i18n.t("report.no_body", locale)))

    link_lines: list[str] = []
    if html_url:
        link_lines.append(f"[{i18n.t('report.see_full', locale)}]({html_url})")
    if trace_url:
        link_lines.append(f"[{i18n.t('report.see_trace', locale)}]({trace_url})")
    # ⚠️ 这里**没有**「🔬 查看本次调查」（DevOps Agent 控制台深链）：上面
    # 两条都是预签名链接、7 天内免登录，而控制台深链必须登录 AWS 控制台。
    # 混在同一行 `·` 分隔的链接里，底下那句说明就只能同时写「无需登录」和
    # 「需要登录」——2026-09-05 现网就是这么自相矛盾的。少一个入口换一句
    # 不骗人的说明；进度卡上那颗保留（那里深链是唯一的链接）。
    if link_lines:
        body_parts.append(" · ".join(link_lines))
    if next_steps:
        nl = []
        for ns in next_steps[:5]:
            label = (ns.get("label") or "").strip()
            url = (ns.get("url") or "").strip()
            if label and url:
                nl.append(f"- [{label}]({url})")
            elif label:
                nl.append(f"- {label}")
        if nl:
            body_parts.append(_emph(i18n.t("report.next_steps_header", locale))
                              + "\n\n" + "\n".join(nl))

    # 一句话，而且无条件为真：这条消息里剩下的每个链接都是预签名的。
    # ⚠️ 别再加 `progress.link_login_warning`（它是给控制台深链的）。
    body_parts.append(_emph(i18n.t("report.link_validity", locale)))

    text_md = "\n\n".join(body_parts).strip()

    _deliver_to_chat(chat_id, heading, text_md)


def send_markdown(chat_id: str, markdown: str, *, locale: str = "zh",
                  title: str = "NotiOps") -> bool:
    """Post a standalone markdown body via the custom-bot webhook. True on ok.

    Added for the inspection broadcast layer . `send_report` is
    not reusable there: it prefixes a `[STATUS] detail_type — task_id[:8]`
    heading that a cron digest has no values for, and it returns None so a
    fan-out can't tell which groups failed.

    🔴 `chat_id` is accepted for signature parity but **NOT used** — the
    custom-bot webhook URL is bound to one specific group, so routing is
    implicit. That is exactly why `inspection/domain/targets.py` rejects the
    whole platform when more than one DingTalk target is configured: every
    target would land in the same group, so a per-account digest would leak
    account A's findings into account B's group. Do not "fix" that by looping
    here.

    ⚠️ **This is deliberately asymmetric with `send_report`**, which DOES route
    by `chat_id` now. The difference is where the chat id comes from:
      · `send_report` gets it from the investigation row — a real
        `openConversationId` the bot itself was @-ed in, with a `dtroute` row
        recording group-vs-1:1. Routing there is verifiable.
      · the cron broadcast gets it from an operator-typed `inspchat#target`
        row. Nothing has ever validated that string, no `dtroute` row exists
        for it, and a wrong value on the server-API path fails *per target*
        with no digest delivered at all. So this path stays on the one
        mechanism that cannot be misaddressed.
    Lifting this means validating those target rows first (and only then
    dropping `dingtalk` from `SINGLE_SINK_PLATFORMS`) — not adding a loop.
    """
    if not is_configured():
        logger.warning(
            "dingtalk_sender: not configured — skipping send_markdown")
        return False
    body = _body_md((markdown or "").strip()).strip() or "(empty)"
    data = _post_webhook({
        "msgtype": "markdown",
        "markdown": {"title": title, "text": body},
        "at": {"isAtAll": False},
    })
    return bool(data) and data.get("errcode", 0) == 0


def send_live_console_link(chat_id: str, root_message_id: str,
                            console_url: str, locale: str = "zh",
                            **_kwargs) -> dict:
    """Phase 2c placeholder — interactive live cards on DingTalk
    require a pre-registered cardTemplateId in the DingTalk Open
    Platform UI, which we can't automate from CFN. Until then we
    return an empty `message_ref` so the progress-poller's
    `update_live_card` calls below see "no card to update" and
    skip quietly. The dispatcher accepts an empty dict here
    without error.
    """
    logger.info(
        "dingtalk_sender.send_live_console_link Phase 2c stub "
        "(chat=%s console=%s)",
        chat_id[:24] if chat_id else "", (console_url or "")[:80])
    return {}


def update_live_card(message_ref: dict, ir, locale: str = "zh",
                      **_kwargs) -> None:
    """Phase 2c stub. The dispatcher calls this with the dict
    returned by `send_live_console_link`, which we currently return
    empty — so this is a definitional no-op until live cards land.
    """
    logger.debug("dingtalk_sender.update_live_card noop")


def send_push_headsup(chat_id: str, event: dict, locale: str = "zh",
                       **_kwargs) -> None:
    """Heads-up card for push events (CloudWatch alarm / Health /
    Backup / etc.) — markdown rendering via the custom-bot webhook.

    `chat_id` is **not** used here, for the same reason as `send_markdown`
    (operator-typed target rows, no `dtroute` row) — see that docstring.
    Not `send_report`'s reason: that one routes by `chat_id` now.

    Event dict shape mirrors what push_handler builds:
      {"title": "...", "detail_str": "..."}
    Defensive — title falls back to a generic label and detail
    truncates at 500 chars so we don't blow past DingTalk's
    markdown size cap on a stray giant payload.
    """
    title = (event or {}).get("title") or "NotiOps alert"
    detail = (event or {}).get("detail_str") or ""
    text = f"### ⚠️ {title}"
    if detail:
        # 先裁再降级（跟 `send_report` 相反）：这里的 500 是**防御性**上界，
        # 不是钉钉的硬限；硬化多加的空行不会把它顶到 `_MD_MAX_CHARS` 以上。
        text += f"\n\n{_body_md(detail[:500])}"

    _post_webhook({
        "msgtype": "markdown",
        "markdown": {"title": title, "text": text},
        "at": {"isAtAll": False},
    })
