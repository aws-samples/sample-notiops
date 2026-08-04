"""
AWS Support case creation logic — platform-agnostic.

This module encapsulates "given an investigation context, classify and
open an AWS Support case" without any IM card / button / form rendering.
Each chat platform builds its own UI on top.

Public surface:
  - SEVERITY_CODES / SEVERITY_LABELS / DEFAULT_SEVERITY
  - LANGUAGE_CODES  / LANGUAGE_LABELS  / DEFAULT_LANGUAGE
  - load_support_context(incident_id) -> dict | None
  - claim_inflight(idempotency_key)   -> bool
  - create_case(...)                  -> CaseResult dataclass

Idempotency: callers should call `claim_inflight(key)` before kicking off
case creation. Feishu/Slack both retry callbacks on missed-ACK,
so without this guard we'd open duplicate cases.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import boto3
from botocore.exceptions import ClientError

from . import case_classifier
from . import ddb_state

logger = logging.getLogger(__name__)

_support = boto3.client("support", region_name="us-east-1")

# AWS Support API severity codes (lowercase) — confirmed against
# describe-severity-levels in Business plan.
SEVERITY_CODES = ["low", "normal", "high", "urgent", "critical"]
DEFAULT_SEVERITY = "normal"

# Severity labels per UI locale. The label is what the user sees on
# the picker / badge; the underlying API value is always the lowercase
# code (low / normal / high / urgent / critical). Both locales keep
# the dot-separated bilingual form because customers cross-reference
# the AWS Console which shows English-only labels.
_SEVERITY_LABELS_BY_LOCALE: dict[str, dict[str, str]] = {
    "zh": {
        "low": "低 · Low",
        "normal": "中 · Normal",
        "high": "高 · High",
        "urgent": "紧急 · Urgent",
        "critical": "严重 · Critical",
    },
    "en": {
        "low": "Low",
        "normal": "Normal",
        "high": "High",
        "urgent": "Urgent",
        "critical": "Critical",
    },
}


def severity_label(code: str, locale: str = "en") -> str:
    """Return the human label for a severity `code` in `locale`.
    Falls back to en, then to the code itself."""
    code = (code or "").lower()
    by_loc = _SEVERITY_LABELS_BY_LOCALE.get(locale) \
        or _SEVERITY_LABELS_BY_LOCALE["en"]
    return by_loc.get(code) or code


def severity_labels(locale: str = "en") -> dict[str, str]:
    """Return the full code→label dict for a locale. Used by the case
    severity picker UI."""
    return dict(_SEVERITY_LABELS_BY_LOCALE.get(locale)
                or _SEVERITY_LABELS_BY_LOCALE["en"])


# Legacy alias kept for one release — case_flow.py imports this name.
# Will be removed once all call sites use severity_labels(locale).
SEVERITY_LABELS = _SEVERITY_LABELS_BY_LOCALE["zh"]


LANGUAGE_CODES = ["zh", "en", "ja", "ko"]
# Language labels — these stay bilingual / native-form because the
# customer is choosing what language AWS Support engineers should
# reply in, regardless of the bot's UI locale. "中文" / "日本語" /
# "한국어" are universally readable inside their own ecosystem.
LANGUAGE_LABELS = {
    "zh": "Chinese / 中文",
    "en": "English",
    "ja": "Japanese / 日本語",
    "ko": "Korean / 한국어",
}
DEFAULT_LANGUAGE = "zh"

# Body cap matching AWS Support API (8000 chars hard limit; we leave headroom).
_BODY_MAX_CHARS = 7900


@dataclass
class CaseResult:
    ok: bool
    display_id: str = ""
    internal_id: str = ""
    case_url: str = ""
    error_code: str = ""
    error_message: str = ""
    classification: dict | None = None


def claim_inflight(key: str) -> bool:
    """Return True if this is the first attempt for `key`; False if a previous
    attempt is already in progress (or completed within TTL).

    Pass an empty string to bypass (best-effort path).

    Backed by `core.ddb_state.claim_inflight` so the lock survives process
    restarts and works across multiple replicas. On DDB infrastructure
    failure the underlying call fails open (returns True), which trades
    rare duplicate work for not deadlocking the user — see ddb_state for
    the rationale.
    """
    return ddb_state.claim_inflight(key)


def load_support_context(incident_id: str) -> dict | None:
    """Read the support#<incident_id> row written by the report-handler.

    Returns the DDB item (dict) on hit, None if missing/expired.
    """
    table = ddb_state._table  # reuse the same table client
    resp = table.get_item(Key={"lookup_key": f"support#{incident_id}"})
    return resp.get("Item")


def build_subject(ctx: dict, platform: str) -> str:
    intent = ctx.get("intent_summary") or ctx.get("raw_text") or "investigation"
    intent = intent.strip().splitlines()[0][:120]
    label = platform.capitalize() if platform else "Bot"
    return f"[{label} NotiOps] {intent}"


def build_body(ctx: dict, severity: str, extra: str, operator_name: str,
               platform: str) -> str:
    summary = ctx.get("summary_md", "") or "(no summary available)"
    raw_text = ctx.get("raw_text", "")
    intent = ctx.get("intent_summary", "")
    report_url = ctx.get("report_url", "")
    trace_url = ctx.get("trace_url", "")
    incident_id = ctx.get("incident_id", "")
    task_id = ctx.get("task_id", "")
    agent_space_id = ctx.get("agent_space_id", "")
    operator_url = (f"https://{agent_space_id}.aidevops.global.app.aws/investigation/{task_id}"
                    if agent_space_id and task_id else "")
    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    via = (platform or "bot").capitalize()

    parts = [
        f"This case was opened automatically from a {via} NotiOps",
        "investigation. Below is the agent's findings; please continue from there.",
        "",
        "=== Request context ===",
        f"Submitted by   : {operator_name or 'unknown'} (via {via})",
        f"Submitted at   : {now_utc}",
        f"Severity       : {severity}",
        f"Incident ID    : {incident_id}",
        f"Task ID        : {task_id}",
        f"Agent Space    : {agent_space_id}",
        f"User question  : {raw_text}",
        f"Intent summary : {intent}",
        "",
    ]
    if extra:
        parts += ["=== Additional context from requester ===", extra, ""]
    if operator_url:
        parts += ["=== Live investigation in DevOps Agent ===", operator_url,
                  "(requires AWS console login)", ""]
    if report_url:
        parts += ["=== Final report (HTML, presigned, valid 7 days) ===",
                  report_url, ""]
    if trace_url:
        parts += ["=== Investigation trace (HTML, presigned, valid 7 days) ===",
                  trace_url, ""]
    parts += ["=== Investigation summary ===", "", summary]

    body = "\n".join(parts)
    if len(body) > _BODY_MAX_CHARS:
        body = body[:_BODY_MAX_CHARS] + "\n\n[truncated — see report URL for full content]"
    return body


def create_case(ctx: dict, *, platform: str, severity: str, language: str,
                extra: str, operator_name: str) -> CaseResult:
    """Classify the investigation and call support:CreateCase.

    Pure logic — no card rendering, no Feishu/Slack SDK calls.
    Returns a CaseResult the caller renders into a platform-specific card.
    """
    if severity not in SEVERITY_CODES:
        return CaseResult(ok=False, error_code="InvalidSeverity",
                          error_message=f"unknown severity: {severity}")
    if language not in LANGUAGE_CODES:
        language = DEFAULT_LANGUAGE

    subject = build_subject(ctx, platform)
    body = build_body(ctx, severity, extra, operator_name, platform)

    classification = case_classifier.classify(
        intent_summary=ctx.get("intent_summary", ""),
        raw_text=ctx.get("raw_text", ""),
        summary_md=ctx.get("summary_md", ""),
    )
    logger.info("Case classification: %s", classification)

    try:
        resp = _support.create_case(
            subject=subject,
            serviceCode=classification["serviceCode"],
            categoryCode=classification["categoryCode"],
            severityCode=severity,
            communicationBody=body,
            language=language,
            issueType=classification["issueType"],
        )
        internal_id = resp.get("caseId", "")
        display_id = internal_id
        try:
            d = _support.describe_cases(
                caseIdList=[internal_id],
                includeCommunications=False,
            )
            cases = d.get("cases") or []
            if cases:
                display_id = cases[0].get("displayId") or internal_id
        except ClientError as e:
            logger.warning("DescribeCases failed: %s", e)

        case_url = (f"https://us-east-1.console.aws.amazon.com/support/home"
                    f"#/case/?displayId={display_id}")
        logger.info("Support case created: internal=%s display=%s lang=%s sev=%s",
                    internal_id, display_id, language, severity)
        return CaseResult(
            ok=True,
            internal_id=internal_id,
            display_id=display_id,
            case_url=case_url,
            classification=classification,
        )
    except ClientError as e:
        err = e.response.get("Error", {})
        code = err.get("Code", "")
        msg = err.get("Message", str(e))
        logger.error("CreateCase failed (%s): %s", code, msg)
        return CaseResult(ok=False, error_code=code, error_message=msg,
                          classification=classification)
    except Exception as e:
        logger.exception("CreateCase unexpected error")
        return CaseResult(ok=False, error_code="UnexpectedError",
                          error_message=str(e), classification=classification)
