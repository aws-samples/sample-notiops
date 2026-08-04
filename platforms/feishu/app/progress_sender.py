"""
Feishu-side renderer for progress updates.

Used by `core.progress_poller`'s daemon (running in this ECS task) to
patch the live investigation card with new IR data. We mirror the card
shape produced by `lambda/feishu_sender.py:_build_live_card` so the
update overwrites the same visual structure the report-handler initially
posted.
"""
from __future__ import annotations

import json
import logging

from core import i18n

from platforms.feishu.app import feishu_utils

logger = logging.getLogger(__name__)


def _build_card(*, incident_id: str, deep_link: str, operator_home: str,
                elapsed_seconds: int, intent_summary: str,
                summary_md: str, recent_tools: list[str],
                latest_thinking: str,
                is_final: bool, locale: str) -> dict:
    """Same structure as lambda/feishu_sender._build_live_card. Kept in
    sync manually — the two run in different runtimes (Lambda vs ECS)
    and we don't want them sharing imports."""
    if is_final:
        title = i18n.t("progress.completed", locale, seconds=elapsed_seconds)
    elif elapsed_seconds <= 0:
        title = i18n.t("progress.investigation_started_live", locale)
    else:
        spinner = ["🔍", "🔧", "📊", "⏳"][(elapsed_seconds // 20) % 4]
        title = i18n.t("progress.investigating", locale, seconds=elapsed_seconds)
        if title.startswith("🔍"):
            title = spinner + title[1:]

    # Feishu lark_md uses double-star bold; i18n templates carry single-
    # star Slack-style. Promote inline.
    import re as _re
    def _bold(s: str) -> str:
        return _re.sub(r"(?<!\*)\*([^*\n]+?)\*(?!\*)", r"**\1**", s)

    elements: list = []
    if intent_summary:
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md",
                     "content": f"**{i18n.t('progress.target', locale)}**\n{intent_summary}"},
        })
    if is_final:
        elements.append({
            "tag": "div",
            "text": {"tag": "lark_md",
                     "content": i18n.t("progress.investigation_done_msg", locale)},
        })
    else:
        if not intent_summary:
            elements.append({
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": i18n.t("progress.investigation_running_msg", locale)},
            })
        if summary_md:
            elements.append({"tag": "hr"})
            elements.append({
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": f"**{i18n.t('progress.summary', locale)}**\n{summary_md}"},
            })
        if latest_thinking:
            elements.append({
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": f"**{i18n.t('progress.thinking', locale)}**\n{latest_thinking}"},
            })
        if recent_tools:
            tool_lines = "\n".join(f"• {t}" for t in recent_tools[:5])
            elements.append({
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": f"**{i18n.t('progress.recent_calls', locale)}**\n{tool_lines}"},
            })
        if not recent_tools and not latest_thinking:
            elements.append({"tag": "hr"})
            elements.append({
                "tag": "div",
                "text": {"tag": "lark_md",
                         "content": _bold(i18n.t("progress.placeholder_analyzing", locale))},
            })
    elements.append({
        "tag": "div",
        "text": {"tag": "lark_md",
                 "content": i18n.t("progress.incident_id", locale,
                                   incident_id=incident_id)},
    })
    elements.append({
        "tag": "action",
        "actions": [
            {"tag": "button",
             "text": {"tag": "plain_text",
                      "content": i18n.t("progress.btn.open_link", locale)},
             "type": "primary",
             "url": deep_link,
             "multi_url": {"url": deep_link, "android_url": deep_link,
                           "ios_url": deep_link, "pc_url": deep_link}},
            {"tag": "button",
             "text": {"tag": "plain_text",
                      "content": i18n.t("progress.btn.open_home", locale)},
             "type": "default",
             "url": operator_home,
             "multi_url": {"url": operator_home, "android_url": operator_home,
                           "ios_url": operator_home, "pc_url": operator_home}},
        ],
    })
    elements.append({
        "tag": "note",
        "elements": [
            {"tag": "plain_text",
             "content": i18n.t("progress.link_login_warning", locale)},
        ],
    })
    return {
        "config": {"wide_screen_mode": True},
        "header": {
            "title": {"tag": "plain_text", "content": title},
            "template": "green" if is_final else "blue",
        },
        "elements": elements,
    }


def update_live_card(message_ref: dict, ir, locale: str = "zh") -> None:
    """Adapter callable passed to core.progress_poller.run().

    `message_ref` is the dict the report-handler stashed in DDB:
        {"message_id": "om_...", "deep_link": "...", "operator_home_url": "..."}
    `ir` is a core.progress_card.ProgressCardIR.
    `locale` resolved by progress_poller from the row.
    """
    msg_id = (message_ref or {}).get("message_id")
    if not msg_id:
        return
    if locale not in {"zh", "en"}:
        locale = "zh"
    card = _build_card(
        incident_id=getattr(ir, "incident_id", ""),
        deep_link=getattr(ir, "deep_link", "")
            or message_ref.get("deep_link", ""),
        operator_home=(getattr(ir, "operator_home_url", "")
                       or message_ref.get("operator_home_url", "")),
        elapsed_seconds=getattr(ir, "elapsed_seconds", 0),
        intent_summary=getattr(ir, "intent_summary", "") or "",
        summary_md=getattr(ir, "summary_md", "") or "",
        recent_tools=getattr(ir, "recent_tools", []) or [],
        latest_thinking=getattr(ir, "latest_thinking", "") or "",
        is_final=getattr(ir, "is_final", False),
        locale=locale,
    )
    try:
        # Feishu's update_card helper sends `PATCH /im/v1/messages/{msg_id}`.
        feishu_utils.update_card(msg_id, card)
    except Exception as e:
        logger.warning("feishu update_live_card failed: %s", e)
