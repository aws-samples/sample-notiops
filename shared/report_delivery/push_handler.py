"""
Push-mode handler — receives EventBridge events from AWS sources
(CloudWatch / Health / Backup / GuardDuty / Cost Anomaly / Trusted Advisor),
posts a heads-up card into a configured chat, and dispatches a fresh
investigation to DevOps Agent so the report comes back to the same chat.

This is the "subscribe → push" half of the bot. The mention-driven half
(users @-mentioning the bot) is unchanged.

Environment variables (set by template.yaml):
  PUSH_TARGET_PLATFORM       "feishu" / "slack" / "dingtalk"
  PUSH_TARGET_CHAT_ID        chat id where heads-up + reports are sent
  CONVERSATIONS_TABLE        shared DDB table
  GUARDDUTY_MIN_SEVERITY     float, default 7.0
  TA_INCLUDE_CATEGORIES      comma-sep list, default "security,fault_tolerance,service_limits"
  WEBHOOK_URL / WEBHOOK_SECRET_ARN  (used by core.webhook_dispatch)

Disabled state: when PUSH_TARGET_CHAT_ID is empty the handler logs and
returns successfully without doing any work. This lets us deploy the
EventBridge wiring without making it active until the customer opts in.
"""
from __future__ import annotations

import json
import logging
import os
import time

import boto3

from core import push_event
from core import webhook_dispatch

logger = logging.getLogger()
logger.setLevel(logging.INFO)

PUSH_TARGET_PLATFORM = (os.environ.get("PUSH_TARGET_PLATFORM") or "feishu").strip()
PUSH_TARGET_CHAT_ID = (os.environ.get("PUSH_TARGET_CHAT_ID") or "").strip()
CONVERSATIONS_TABLE = os.environ.get("CONVERSATIONS_TABLE", "")
DEDUPE_TTL_SECONDS = int(os.environ.get("DEDUPE_TTL_SECONDS", "300"))   # 5 min

GUARDDUTY_MIN_SEVERITY = float(os.environ.get("GUARDDUTY_MIN_SEVERITY", "7.0"))
TA_INCLUDE_CATEGORIES = {
    c.strip().lower()
    for c in (os.environ.get("TA_INCLUDE_CATEGORIES") or
              "security,fault_tolerance,service_limits").split(",")
    if c.strip()
}

_ddb_table = (
    boto3.resource("dynamodb").Table(CONVERSATIONS_TABLE)
    if CONVERSATIONS_TABLE else None
)


def _push_configured() -> bool:
    """Decide whether the push pipeline has any sink to deliver to.

    Most platforms (feishu / slack) require an explicit
    `PUSH_TARGET_CHAT_ID` because their sender API is "post to chat
    X". DingTalk's outbound is bound to a custom-bot webhook URL,
    which is already a per-group endpoint — there's no chat_id to
    pass. So when the target platform is dingtalk we accept either
    (the legacy `PUSH_TARGET_CHAT_ID`, kept for parity) OR a
    configured custom-bot webhook URL. Either being non-empty means
    the operator wired up a delivery sink.
    """
    if PUSH_TARGET_CHAT_ID:
        return True
    if PUSH_TARGET_PLATFORM == "dingtalk":
        return bool(os.environ.get("DINGTALK_PUSH_WEBHOOK_URL", "").strip()
                    or os.environ.get("DINGTALK_PUSH_WEBHOOK_URL_ARN", "").strip())
    return False


def lambda_handler(event, context):
    """EventBridge → push pipeline entrypoint."""
    if not _push_configured():
        logger.info("Push disabled (no chat_id or webhook URL); "
                    "ignoring event (platform=%s)", PUSH_TARGET_PLATFORM)
        return {"statusCode": 200, "body": "disabled"}

    source = event.get("source", "")
    detail_type = event.get("detail-type", "")
    logger.info("Received push event source=%s detail-type=%s", source, detail_type)

    # Per-source pre-filtering with env-controlled thresholds. We pass the
    # tuned min_severity / categories straight into the normalizers; the
    # source-side functions keep their defaults so they're testable in
    # isolation.
    pe = _normalize(event)
    if pe is None:
        logger.info("Event filtered out by normalizer (source=%s)", source)
        return {"statusCode": 200, "body": "filtered"}

    if not _claim_dedupe(pe.dedupe_key):
        logger.info("Duplicate push event within window; key=%s", pe.dedupe_key)
        return {"statusCode": 200, "body": "duplicate"}

    # #1 Health: only proactively notify + auto-investigate CRITICAL ISSUES.
    # Non-issue health events (scheduledChange / accountNotification, e.g. EOL)
    # are NOT spammed per-event — they belong in the periodic digest (#2).
    if source == "aws.health" and pe.raw_event_excerpt.get("category") != "issue":
        logger.info("Non-issue health event (category=%s) — skipping proactive "
                    "notify; deferred to digest",
                    pe.raw_event_excerpt.get("category"))
        return {"statusCode": 200, "body": "health-non-issue-deferred"}

    # QA dry-run: a synthetic event carrying detail._qa_dry_run exercises the
    # routing decision (gate passed → would proactively investigate) WITHOUT
    # real side effects — no heads-up post, no DevOps Agent dispatch. Real
    # aws.health events never carry this flag.
    if (event.get("detail") or {}).get("_qa_dry_run"):
        return {"statusCode": 200, "body": "qa-dry-run-would-proactive-investigate"}

    incident_id = f"{PUSH_TARGET_PLATFORM}-push-{pe.dedupe_key}"

    # Step 1: heads-up card to the chat. Best-effort — if the platform
    # client fails we still want the dispatch to happen (the report card
    # itself will land later). Push events have no per-user context so
    # we use the env DEFAULT_LOCALE; ops can flip this on the lambda
    # if a region-specific default is needed.
    push_locale = (os.environ.get("DEFAULT_LOCALE") or "en").strip().lower()
    if push_locale not in {"zh", "en"}:
        push_locale = "en"
    headsup_ts = ""   # the heads-up message ts → thread root for the report
    try:
        sender = _load_sender(PUSH_TARGET_PLATFORM)
        if sender:
            try:
                headsup_ts = sender.send_push_headsup(
                    chat_id=PUSH_TARGET_CHAT_ID,
                    event=_pe_to_dict(pe),
                    locale=push_locale,
                ) or ""
            except TypeError:
                # Older sender without locale param.
                headsup_ts = sender.send_push_headsup(
                    chat_id=PUSH_TARGET_CHAT_ID,
                    event=_pe_to_dict(pe),
                ) or ""
        else:
            logger.warning("No sender for platform=%s; skipping heads-up",
                           PUSH_TARGET_PLATFORM)
    except Exception as e:
        logger.exception("send_push_headsup failed: %s", e)

    # Step 2: register the incident in DDB so report-handler can route
    # the eventual report back to PUSH_TARGET_CHAT_ID. We synthesize an
    # event_id from the dedupe_key.
    synth_event_id = f"push-{pe.dedupe_key}"
    if _ddb_table:
        try:
            _ddb_table.put_item(Item={
                "lookup_key": f"event#{synth_event_id}",
                "platform": PUSH_TARGET_PLATFORM,
                "event_id": synth_event_id,
                "chat_id": PUSH_TARGET_CHAT_ID,
                "root_message_id": headsup_ts,
                "user_id": "",
                "raw_text": pe.dispatch_query,
                "intent_summary": pe.title,
                "status": "received",
                "ttl": int(time.time()) + 24 * 3600,
            }, ConditionExpression="attribute_not_exists(lookup_key)")
        except Exception as e:
            logger.warning("put_item for synth event failed: %s", e)

    # Step 3: dispatch investigation. This kicks DevOps Agent; the report
    # will eventually flow back through report-handler's existing path.
    result = webhook_dispatch.dispatch(
        incident_id=incident_id,
        user_text=_compose_dispatch_text(pe),
        platform=PUSH_TARGET_PLATFORM,
        user_id="",
        chat_id=PUSH_TARGET_CHAT_ID,
        extra_metadata={
            "source": "push",
            "push_source": pe.source,
            "push_severity": pe.severity,
            "push_resource": pe.resource,
        },
    )
    if not result.get("ok"):
        logger.error("Webhook dispatch for push event %s failed: %s",
                     pe.dedupe_key, result)
        return {"statusCode": 200, "body": "dispatch-failed"}

    # Step 4: link the synth event to the incident so report-handler can
    # route by `incident#<id>` lookup. Mirrors what main.on_card_action
    # does after confirm_dispatch.
    if _ddb_table:
        try:
            base = {
                "platform": PUSH_TARGET_PLATFORM,
                "event_id": synth_event_id,
                "incident_id": incident_id,
                "chat_id": PUSH_TARGET_CHAT_ID,
                "root_message_id": headsup_ts,
                "user_id": "",
                "raw_text": pe.dispatch_query,
                "intent_summary": pe.title,
                "status": "investigating",
                "ttl": int(time.time()) + 24 * 3600,
            }
            _ddb_table.put_item(Item={**base,
                                      "lookup_key": f"incident#{incident_id}"})
            if result.get("task_id"):
                _ddb_table.put_item(Item={**base, "task_id": result["task_id"],
                                          "lookup_key": f"task#{result['task_id']}"})
        except Exception as e:
            logger.warning("link_incident put failed: %s", e)

    logger.info("Push pipeline ok: source=%s incident=%s task_id=%s",
                pe.source, incident_id, result.get("task_id"))
    return {"statusCode": 200, "body": json.dumps({
        "incident_id": incident_id,
        "task_id": result.get("task_id"),
    })}


# ---------------------------------------------------------------------------
# Source-aware normalization with env-driven thresholds
# ---------------------------------------------------------------------------
def _normalize(event: dict):
    source = (event.get("source") or "").lower()
    if source == "aws.guardduty":
        return push_event.from_guardduty(event,
                                         min_severity=GUARDDUTY_MIN_SEVERITY)
    if source == "aws.trustedadvisor":
        return push_event.from_trusted_advisor(
            event, include_categories=TA_INCLUDE_CATEGORIES,
        )
    return push_event.normalize(event)


# ---------------------------------------------------------------------------
# Dedupe — opaque conditional put on inflight#push:<key>
# ---------------------------------------------------------------------------
def _claim_dedupe(key: str) -> bool:
    """Returns True if first time within window, False if a duplicate."""
    if not _ddb_table or not key:
        return True
    try:
        _ddb_table.put_item(
            Item={
                "lookup_key": f"push_dedupe#{key}",
                "claimed_at": int(time.time()),
                "ttl": int(time.time()) + DEDUPE_TTL_SECONDS,
            },
            ConditionExpression="attribute_not_exists(lookup_key)",
        )
        return True
    except _ddb_table.meta.client.exceptions.ConditionalCheckFailedException:
        return False
    except Exception as e:
        logger.error("push dedupe DDB error (failing open): %s", e)
        return True


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _compose_dispatch_text(pe: push_event.PushEvent) -> str:
    """Assemble the user_text we pass to webhook_dispatch. Includes both
    the agent-facing query and the structured event context so the
    summarizer has something concrete to work from."""
    parts = [
        f"AWS push event from {pe.source}:",
        pe.title,
        "",
        pe.description.strip() if pe.description else "",
        "",
        "Investigation request:",
        pe.dispatch_query,
    ]
    return "\n".join(p for p in parts if p is not None)


def _pe_to_dict(pe: push_event.PushEvent) -> dict:
    return {
        "source": pe.source,
        "title": pe.title,
        "severity": pe.severity,
        "resource": pe.resource,
        "region": pe.region,
        "account": pe.account,
        "description": pe.description,
        "dedupe_key": pe.dedupe_key,
        "console_url": pe.console_url,
    }


# Per-platform sender registry (lazy import). Keep symmetric with
# devops_agent_report_handler so future platforms slot in cleanly.
_SENDERS: dict = {}


def _load_sender(platform: str):
    if not platform:
        return None
    if platform in _SENDERS:
        return _SENDERS[platform]
    sender = None
    try:
        if platform == "feishu":
            from shared.report_delivery import feishu_sender as sender  # type: ignore
        elif platform == "slack":
            from shared.report_delivery import slack_sender as sender  # type: ignore
        elif platform == "dingtalk":
            import dingtalk_sender as sender  # type: ignore  # later phase
    except ImportError as e:
        logger.warning("No sender module for platform=%s: %s", platform, e)
        sender = None
    _SENDERS[platform] = sender
    return sender
