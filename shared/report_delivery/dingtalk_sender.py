"""DingTalk sender — Phase 2a Lambda → DingTalk delivery.

Mirrors the public interface of `feishu_sender.py` /
`slack_sender.py` so `lambda/devops_agent_report_handler.py` and
`lambda/push_handler.py`'s `_load_sender(platform)` branch picks
this up unchanged.

Delivery model (different from feishu / slack)
----------------------------------------------

DingTalk has two distinct robot classes:

  1. **H5-app Stream-Mode robot** — the bot the ECS task runs.
     Replies use the per-message `incoming_message.session_webhook`
     URL. NO outbound delivery from a Lambda is possible because the
     Lambda has no `incoming_message` to reach for.

  2. **Custom (自定义机器人) webhook robot** — a separate robot
     class that lives in a SPECIFIC group, exposes one HMAC-signed
     webhook URL, and is the standard channel for "machine pushes
     a notification into a group" (Jenkins, Prometheus, AWS, …).
     This is the right tool for the report-writeback / push-event
     path: the Lambda has a fixed URL + secret in env and POSTs
     a markdown message.

This module assumes the operator created (per group, optional) a
custom-bot in each chat that should receive push or report
writebacks. The webhook URL lives in the env as
`DINGTALK_PUSH_WEBHOOK_URL` and the HMAC sign-secret as
`DINGTALK_PUSH_WEBHOOK_SECRET`. If either is absent, all delivery
calls log a clear warning and return without raising — so the rest
of the report-handler / push-handler still works for feishu /
slack platforms.

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
    return _read_secret("DINGTALK_PUSH_WEBHOOK_URL_ARN")


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

    `chat_id` is accepted for parity with feishu/slack but not
    used: the custom-bot webhook is bound to ONE specific group
    per webhook URL, so the routing is implicit. If an operator
    needs to fan out to multiple groups, they configure multiple
    sender stacks each with its own webhook URL.
    """
    # ⚠️ 这个局部变量原来也叫 `title`，跟新加的 `title` 入参**同名**。
    # 改名而不是复用：卡片顶部的 h3 是给钉钉列表页看的短标签（带 status /
    # task_id），跟用户问的那句话是两回事，混在一起两边都表达不清。
    heading = f"[{status}] {detail_type or 'NotiOps'} — {task_id[:8]}"
    body_parts: list[str] = [f"### {heading}"]
    if title:
        # 展示上界 140：存储上界是 200（`report_handler._TITLE_MAX_CHARS`）。
        shown = title if len(title) <= 140 else title[:139] + "…"
        body_parts.append(_bold(i18n.t("report.header.subject", locale,
                                       title=_escape_md(shown))))
    if priority:
        body_parts.append(f"**Priority:** {priority}")

    body = (summary_md or "").strip()
    truncated = report_truncated
    if len(body) > _MD_MAX_CHARS:
        body = body[:_MD_MAX_CHARS]
        truncated = True
    if body:
        body_parts.append(body)
        if truncated:
            body_parts.append(_bold(i18n.t("report.summary_truncated", locale)))
    else:
        # 「没取到正文」≠「正文被截断」。以前这里两种情况都渲染成
        # `(empty report)`，读者无从判断该不该点完整报告链接（D4）。
        body_parts.append(_bold(i18n.t("report.no_body", locale)))

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
            body_parts.append(_bold(i18n.t("report.next_steps_header", locale))
                              + "\n" + "\n".join(nl))

    # 一句话，而且无条件为真：这条消息里剩下的每个链接都是预签名的。
    # ⚠️ 别再加 `progress.link_login_warning`（它是给控制台深链的）。
    body_parts.append(_bold(i18n.t("report.link_validity", locale)))

    text_md = "\n\n".join(body_parts).strip()

    _post_webhook({
        "msgtype": "markdown",
        "markdown": {"title": heading, "text": text_md},
        "at": {"isAtAll": False},
    })


def send_markdown(chat_id: str, markdown: str, *, locale: str = "zh",
                  title: str = "NotiOps") -> bool:
    """Post a standalone markdown body via the custom-bot webhook. True on ok.

    Added for the inspection broadcast layer . `send_report` is
    not reusable there: it prefixes a `[STATUS] detail_type — task_id[:8]`
    heading that a cron digest has no values for, and it returns None so a
    fan-out can't tell which groups failed.

    🔴 `chat_id` is accepted for signature parity but **NOT used** — the
    custom-bot webhook URL is bound to one specific group, so routing is
    implicit (same caveat as `send_report`). That is exactly why
    `inspection/domain/targets.py` rejects the whole platform when more than
    one DingTalk target is configured: every target would land in the same
    group, so a per-account digest would leak account A's findings into
    account B's group. Do not "fix" that by looping here.
    """
    if not is_configured():
        logger.warning(
            "dingtalk_sender: not configured — skipping send_markdown")
        return False
    body = (markdown or "").strip() or "(empty)"
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
    Backup / etc.) — Phase 2a markdown rendering via the custom-bot
    webhook. Same chat_id-is-implicit caveat as send_report.

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
        text += f"\n\n{detail[:500]}"

    _post_webhook({
        "msgtype": "markdown",
        "markdown": {"title": title, "text": text},
        "at": {"isAtAll": False},
    })
