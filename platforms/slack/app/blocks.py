"""
Slack Block Kit helpers shared by main / support_flow / case_flow.

Slack's Block Kit is a fixed schema — these helpers exist so callers
don't have to keep typing the same dict scaffolds, and so visual
conventions (emoji prefixes, section spacing) are consistent.

References:
- Block Kit  https://api.slack.com/reference/block-kit/blocks
- Modals     https://api.slack.com/surfaces/modals
"""
from __future__ import annotations

from typing import Any


# ---------------------------------------------------------------------------
# Section / context / header / divider
# ---------------------------------------------------------------------------
def section(markdown: str, accessory: dict | None = None,
            block_id: str | None = None) -> dict:
    """A `section` block with mrkdwn text. `accessory` is an optional
    right-aligned button / image / select (Block Kit accessory)."""
    block: dict[str, Any] = {
        "type": "section",
        "text": {"type": "mrkdwn", "text": markdown},
    }
    if accessory:
        block["accessory"] = accessory
    if block_id:
        block["block_id"] = block_id
    return block


def context(markdown: str) -> dict:
    """A `context` block — small grey text under a section."""
    return {
        "type": "context",
        "elements": [{"type": "mrkdwn", "text": markdown}],
    }


def header(plain_text: str) -> dict:
    return {
        "type": "header",
        "text": {"type": "plain_text", "text": plain_text[:150], "emoji": True},
    }


def divider() -> dict:
    return {"type": "divider"}


# ---------------------------------------------------------------------------
# Buttons + actions row
# ---------------------------------------------------------------------------
def button(text: str, action_id: str, *,
           value: str | None = None,
           style: str | None = None,
           url: str | None = None) -> dict:
    """A button element. Pass either `url` (link button — no callback) or
    `action_id` + optional `value` (callback button).

    `style`: None / "primary" / "danger". Slack rejects "primary" on
    url-only buttons; we silently drop style when url is set.
    """
    elem: dict[str, Any] = {
        "type": "button",
        "text": {"type": "plain_text", "text": text[:75], "emoji": True},
        "action_id": action_id,
    }
    if url:
        elem["url"] = url[:3000]
    else:
        if value is not None:
            elem["value"] = str(value)[:2000]
        if style in ("primary", "danger"):
            elem["style"] = style
    return elem


def actions(*buttons: dict, block_id: str | None = None) -> dict:
    """An `actions` block holding up to 25 button-like elements."""
    block: dict[str, Any] = {
        "type": "actions",
        "elements": list(buttons)[:25],
    }
    if block_id:
        block["block_id"] = block_id
    return block


# ---------------------------------------------------------------------------
# Modal input blocks (used by support_flow + case_flow forms)
# ---------------------------------------------------------------------------
def text_input(label: str, action_id: str, *,
               block_id: str | None = None,
               placeholder: str = "",
               initial_value: str = "",
               multiline: bool = False,
               max_length: int = 1000,
               optional: bool = False) -> dict:
    """A `input` block wrapping a `plain_text_input` element."""
    element: dict[str, Any] = {
        "type": "plain_text_input",
        "action_id": action_id,
        "max_length": max_length,
    }
    if multiline:
        element["multiline"] = True
    if placeholder:
        element["placeholder"] = {"type": "plain_text",
                                  "text": placeholder[:150]}
    if initial_value:
        element["initial_value"] = initial_value[:max_length]
    return {
        "type": "input",
        "block_id": block_id or action_id,
        "label": {"type": "plain_text", "text": label[:2000], "emoji": True},
        "element": element,
        "optional": optional,
    }


def static_select(label: str, action_id: str, options: list[tuple[str, str]],
                  *, block_id: str | None = None,
                  initial_value: str | None = None,
                  placeholder: str = "Select…") -> dict:
    """A `input` block wrapping a `static_select` element. `options` is a
    list of (value, label) tuples; `initial_value` matches against value."""
    opts = [
        {"text": {"type": "plain_text", "text": label[:75], "emoji": True},
         "value": value[:75]}
        for value, label in options[:100]
    ]
    element: dict[str, Any] = {
        "type": "static_select",
        "action_id": action_id,
        "placeholder": {"type": "plain_text", "text": placeholder[:150]},
        "options": opts,
    }
    if initial_value:
        for o in opts:
            if o["value"] == initial_value:
                element["initial_option"] = o
                break
    return {
        "type": "input",
        "block_id": block_id or action_id,
        "label": {"type": "plain_text", "text": label[:2000], "emoji": True},
        "element": element,
    }


# ---------------------------------------------------------------------------
# Modal scaffold
# ---------------------------------------------------------------------------
def modal(title: str, blocks: list[dict], *,
          callback_id: str,
          submit: str = "Submit",
          close: str = "Cancel",
          private_metadata: str = "") -> dict:
    """Build a `modal` view payload for views.open / views.update.

    `private_metadata` rides through Slack's modal lifecycle and is
    available on view_submission — handy for stuffing context like
    incident_id without re-querying DDB.
    """
    payload: dict[str, Any] = {
        "type": "modal",
        "callback_id": callback_id,
        "title": {"type": "plain_text", "text": title[:24], "emoji": True},
        "submit": {"type": "plain_text", "text": submit[:24], "emoji": True},
        "close": {"type": "plain_text", "text": close[:24], "emoji": True},
        "blocks": blocks[:100],
    }
    if private_metadata:
        payload["private_metadata"] = private_metadata[:3000]
    return payload


def info_modal(title: str, message_md: str, *,
               callback_id: str = "noop") -> dict:
    """A read-only modal with no submit button — used for confirmations
    and error displays."""
    return {
        "type": "modal",
        "callback_id": callback_id,
        "title": {"type": "plain_text", "text": title[:24], "emoji": True},
        "close": {"type": "plain_text", "text": "Close", "emoji": True},
        "blocks": [section(message_md)],
    }


# ---------------------------------------------------------------------------
# Markdown helpers
# ---------------------------------------------------------------------------
def trim(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[:n] + "…"


def to_mrkdwn(s: str) -> str:
    """把「标准 markdown 的粗体」`**x**` 换成 Slack mrkdwn 的 `*x*`。

    为什么需要：共享的 i18n 文案（`core/i18n.py`）是按飞书/钉钉的 markdown 写的，
    粗体是 `**x**`。Slack 的 mrkdwn 里粗体只认**单个**星号，`**x**` 会渲染成
    「*x*」—— 星号原样显示给用户看。2026-09-03 现网就是这么暴露的（`/help` 菜单
    「直接是源码」）。

    ⚠️ 只处理粗体。斜体不动：markdown 的 `*x*` 与 Slack 的斜体 `_x_` 冲突，盲目
    互换会把已经正确的 mrkdwn 弄坏。反引号两边一致，不用管。

    实现委托给 `platforms.common.im_markdown.bold_to_mrkdwn` —— agent 回答的降级
    （`im_markdown.to_slack`）也要这一条，同一条规则两处各写一遍就会漂移。
    """
    from platforms.common.im_markdown import bold_to_mrkdwn
    return bold_to_mrkdwn(s)


def escape_mrkdwn(s: str) -> str:
    """Slack mrkdwn treats `<`, `>`, `&` literally only when escaped.
    For user-supplied text that might contain these, escape so they
    don't get interpreted as `<url|label>` link syntax.
    """
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
