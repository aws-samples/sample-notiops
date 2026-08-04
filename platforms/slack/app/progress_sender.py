"""
Slack-side renderer for progress updates.

Used by `core.progress_poller`'s daemon (running in this ECS task) to
patch the live investigation card with new IR data via Slack's
chat.update Web API. Mirror of lambda/slack_sender's _build_live_blocks.
"""
from __future__ import annotations

import logging
import os

from slack_sdk import WebClient

from core import i18n

from platforms.slack.app import blocks

logger = logging.getLogger(__name__)


_client: WebClient | None = None


def _get_client() -> WebClient:
    """The same Bot Token the main app uses. We can't import main's `app`
    object here because that would create a circular import; we just
    re-read the token from env (cached after first call)."""
    global _client
    if _client is not None:
        return _client
    import boto3
    arn = os.environ.get("SLACK_BOT_TOKEN_ARN", "")
    if not arn:
        raise RuntimeError("SLACK_BOT_TOKEN_ARN not set")
    sm = boto3.client("secretsmanager")
    token = sm.get_secret_value(SecretId=arn)["SecretString"].strip()
    _client = WebClient(token=token)
    return _client


def _build_blocks(*, incident_id: str, deep_link: str, operator_home: str,
                  elapsed_seconds: int, intent_summary: str,
                  summary_md: str, recent_tools: list[str],
                  latest_thinking: str,
                  is_final: bool, locale: str) -> list[dict]:
    if is_final:
        title = i18n.t("progress.completed", locale,
                       seconds=elapsed_seconds)
    elif elapsed_seconds <= 0:
        title = i18n.t("progress.investigation_started_live", locale)
    else:
        spinner = ["🔍", "🔧", "📊", "⏳"][(elapsed_seconds // 20) % 4]
        title = i18n.t("progress.investigating", locale,
                       seconds=elapsed_seconds)
        # Templates start with 🔍; swap with the rotating spinner.
        if title.startswith("🔍"):
            title = spinner + title[1:]
    out: list[dict] = [blocks.header(title)]
    if intent_summary:
        out.append(blocks.section(
            f"*{i18n.t('progress.target', locale)}*\n{intent_summary}"))
    if is_final:
        out.append(blocks.section(
            i18n.t("progress.investigation_done_msg", locale)))
    else:
        if not intent_summary:
            out.append(blocks.section(
                i18n.t("progress.investigation_running_msg", locale)))
        if summary_md:
            out.append(blocks.divider())
            out.append(blocks.section(
                f"*{i18n.t('progress.summary', locale)}*\n{summary_md}"))
        if latest_thinking:
            out.append(blocks.section(
                f"*{i18n.t('progress.thinking', locale)}*\n{latest_thinking}"))
        if recent_tools:
            tool_lines = "\n".join(f"• {t}" for t in recent_tools[:5])
            out.append(blocks.section(
                f"*{i18n.t('progress.recent_calls', locale)}*\n{tool_lines}"))
        if not recent_tools and not latest_thinking:
            out.append(blocks.divider())
            out.append(blocks.section(
                i18n.t("progress.placeholder_analyzing", locale)))
    out.append(blocks.context(
        i18n.t("progress.incident_id", locale, incident_id=incident_id)))
    out.append(blocks.actions(
        blocks.button(i18n.t("progress.btn.open_link", locale),
                      "open_live_link",
                      url=deep_link, style="primary"),
        blocks.button(i18n.t("progress.btn.open_home", locale),
                      "open_live_home", url=operator_home),
    ))
    out.append(blocks.context(i18n.t("progress.link_login_warning", locale)))
    return out


def update_live_card(message_ref: dict, ir, locale: str = "en") -> None:
    """Adapter for core.progress_poller. `message_ref` carries the
    Slack channel + ts the report-handler stashed when posting the
    initial card. `locale` is supplied by the poller (read from the
    progress# row).
    """
    channel = (message_ref or {}).get("channel")
    ts = (message_ref or {}).get("ts")
    if not channel or not ts:
        return
    if locale not in {"zh", "en"}:
        locale = "en"
    blocks_out = _build_blocks(
        incident_id=getattr(ir, "incident_id", ""),
        deep_link=(getattr(ir, "deep_link", "")
                   or message_ref.get("deep_link", "")),
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
    title = (i18n.t("progress.completed", locale,
                    seconds=getattr(ir, "elapsed_seconds", 0))
             if getattr(ir, "is_final", False)
             else i18n.t("progress.investigating", locale,
                         seconds=getattr(ir, "elapsed_seconds", 0)))
    try:
        _get_client().chat_update(channel=channel, ts=ts,
                                  text=title, blocks=blocks_out)
    except Exception as e:
        logger.warning("slack update_live_card failed: %s", e)
