"""
Dispatch a webhook to DevOps Agent with HMAC signing.

Platform-agnostic: caller passes a `platform` slug ("feishu", "slack")
which is used to:
  - build the title prefix `[<Platform>#<short_id>] ...`
  - build the unique service tag `<platform>-bot-<short_id>` so the agent's
    triage step doesn't merge unrelated requests
  - tag the dispatch metadata (for observability/routing back)

The invocation contract with DevOps Agent itself is unchanged.
"""
from __future__ import annotations
from core.net import safe_urlopen

import base64
import hashlib
import hmac
import json
import logging
import os
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import boto3

logger = logging.getLogger(__name__)

WEBHOOK_URL = os.environ.get("WEBHOOK_URL", "")
WEBHOOK_SECRET_ARN = os.environ.get("WEBHOOK_SECRET_ARN", "")

_sm = boto3.client("secretsmanager")
_secret_cache: str | None = None


def _get_secret() -> str:
    global _secret_cache
    if _secret_cache:
        return _secret_cache
    _secret_cache = _sm.get_secret_value(SecretId=WEBHOOK_SECRET_ARN)["SecretString"]
    return _secret_cache


def dispatch(incident_id: str, user_text: str, *,
             platform: str,
             user_id: str = "",
             chat_id: str = "",
             skill_id: str = "",
             skill_version: str = "",
             extra_metadata: dict | None = None) -> dict:
    """Send a signed webhook to DevOps Agent.

    Args:
      incident_id:    unique routing key, conventionally `<platform>-<event_id>`.
                      Embedded as a hidden tag in the agent task description so
                      the report-handler can recover it from journal records.
      user_text:      the user's natural-language request (after intent confirm).
      platform:       slug like "feishu" / "slack". Used to build
                      title prefix, unique service tag, and metadata.trigger.
      user_id:        platform-specific user identifier (open_id / Slack user_id).
                      Optional, recorded in metadata.
      chat_id:        platform-specific chat identifier. Optional, recorded in
                      metadata for observability.
      extra_metadata: additional fields to merge into metadata (per-platform
                      context the bot may want round-tripped in logs).

    Returns: {"ok": bool, "status": int, "body": str, "task_id": str | None}
    """
    if not WEBHOOK_URL or not WEBHOOK_SECRET_ARN:
        return {"ok": False, "status": 0, "body": "WEBHOOK_URL or secret not set",
                "task_id": None}

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")

    platform_label = platform.capitalize() if platform else "Bot"

    # IMPORTANT: DevOps Agent's callback events do NOT echo our incidentId,
    # and the synchronous webhook response does NOT include task_id either.
    # The only field guaranteed to round-trip back to us is the user-facing
    # `description` (which becomes the agent's task input). So we embed a
    # routing tag in the description; the report-handler greps for it from
    # the agent's journal records to reconstruct the routing context.
    #
    # Also: DevOps Agent has a 20-minute triage step that may LINK related
    # incidents into one execution. To force it to treat each request as a
    # standalone investigation, we (a) prepend an explicit "NEW INDEPENDENT
    # REQUEST" header, (b) make title/service unique per request.
    # Routing marker the report-handler greps from the agent's journal
    # to recover (incident_id, target chat). Renamed to `notiops:` in
    # the 2026-06 brand rename; the report-handler regex accepts BOTH
    # `<!--notiops:...-->` (new dispatches) and `<!--notiops-devops:
    # ...-->` (in-flight investigations dispatched before this MR).
    # The legacy form can be removed after the 24h TTL window has
    # cleared all pre-rename `incident#*` rows.
    description_with_tag = (
        f"NEW INDEPENDENT REQUEST (id={incident_id}). "
        f"Treat this as a brand-new investigation independent from any prior tasks.\n\n"
        f"{user_text}\n\n"
        f"<!--notiops:{incident_id}-->"
    )

    metadata: dict = {
        "trigger": f"{platform}-mention" if platform else "bot-mention",
        "platform": platform,
        "incident_id": incident_id,
    }
    if user_id:
        metadata["user_id"] = user_id
        metadata[f"{platform}_user_id"] = user_id
    if chat_id:
        metadata["chat_id"] = chat_id
        metadata[f"{platform}_chat_id"] = chat_id
    if skill_id:
        metadata["skill_id"] = skill_id
    if skill_version:
        metadata["skill_version"] = skill_version
    if extra_metadata:
        metadata.update(extra_metadata)

    payload = {
        "eventType": "incident",
        "incidentId": incident_id,
        "action": "created",
        "priority": "MEDIUM",
        "title": f"[{platform_label}#{incident_id[-12:]}] {user_text[:50]}",
        "description": description_with_tag,
        "service": f"{platform}-bot-{incident_id[-8:]}" if platform else f"bot-{incident_id[-8:]}",
        "timestamp": timestamp,
        "data": {"metadata": metadata},
    }
    payload_str = json.dumps(payload, ensure_ascii=False)

    sig_input = f"{timestamp}:{payload_str}"
    secret = _get_secret()
    signature = base64.b64encode(
        hmac.new(secret.encode("utf-8"), sig_input.encode("utf-8"), hashlib.sha256).digest()
    ).decode("utf-8")

    req = Request(WEBHOOK_URL, data=payload_str.encode("utf-8"), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-amzn-event-timestamp", timestamp)
    req.add_header("x-amzn-event-signature", signature)

    try:
        with safe_urlopen(req, timeout=30) as resp:
            status = resp.status
            body = resp.read().decode("utf-8")
            # 只记状态码 + 长度，不打响应体（可能含用户内容/敏感返回）。
            logger.info("Webhook response: %d (%d bytes)", status, len(body))
            return {"ok": 200 <= status < 300, "status": status, "body": body,
                    "task_id": _extract_task_id(body)}
    except HTTPError as e:
        body = e.read().decode("utf-8") if e.fp else ""
        # 只记状态码 + 长度，不打错误响应体。
        logger.error("Webhook HTTPError %d (%d bytes)", e.code, len(body))
        return {"ok": False, "status": e.code, "body": body, "task_id": None}
    except URLError as e:
        logger.error("Webhook URLError: %s", e.reason)
        return {"ok": False, "status": 0, "body": str(e.reason), "task_id": None}


def _extract_task_id(body: str) -> str | None:
    try:
        parsed = json.loads(body)
        for key in ("task_id", "taskId", "executionId", "execution_id"):
            if key in parsed and parsed[key]:
                return str(parsed[key])
    except (json.JSONDecodeError, TypeError):
        pass
    return None
