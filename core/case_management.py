"""
AWS Support case management — platform-agnostic.

Wraps the 5 read/write operations the bot needs:

  list_recent_cases(after_days, max_items)        -> list[CaseSummary]
  describe_case(display_id)                       -> CaseSummary | None
  list_communications(display_id, max_items)      -> list[Communication]
  add_communication(display_id, body)             -> bool
  resolve_case(display_id)                        -> str    (final status)

Functions return dataclasses (or None / empty list on failure) and never
raise. Each platform adapter renders these into its own card / block / UI.

Note: AWS Support API uses two different ids:
  - displayId : human-friendly numeric (e.g. 177968247000414) shown on
                console URLs and what users typically remember
  - caseId    : opaque internal id (case-<account>-<region>-<...>)
                required by the write APIs
We accept displayId in the public surface and resolve to caseId
internally via DescribeCases.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from botocore.exceptions import ClientError

from .support_logic import _support  # reuse single boto3 client + region

logger = logging.getLogger(__name__)


@dataclass
class CaseSummary:
    display_id: str            # human-readable id (177968...)
    internal_id: str           # opaque caseId (case-...)
    subject: str
    status: str                # opened / pending-customer-action / resolved / ...
    severity: str              # low / normal / high / urgent / critical
    service_code: str
    category_code: str
    created_at: str            # ISO timestamp from API
    submitted_by: str          # email of submitter (often the bot's role/user)
    case_url: str
    language: str = "en"
    recent_communication: str = ""  # short preview of newest message body


@dataclass
class Communication:
    body: str
    submitted_by: str          # email or "Amazon Web Services"
    submitted_at: str          # ISO
    is_aws: bool               # heuristic: True iff submitted_by contains "@amazon" / "Amazon Web Services"
    attachment_set_id: str = ""


def _case_console_url(display_id: str) -> str:
    return ("https://us-east-1.console.aws.amazon.com/support/home"
            f"#/case/?displayId={display_id}")


def _to_summary(case: dict) -> CaseSummary:
    """Map an AWS Support API case dict to our CaseSummary dataclass."""
    display_id = case.get("displayId") or case.get("caseId", "")
    submitted_by = case.get("submittedBy", "")
    recent = ""
    comm_summary = case.get("recentCommunications") or {}
    comms = comm_summary.get("communications") or []
    if comms:
        body = comms[0].get("body") or ""
        recent = body.strip().replace("\n", " ")[:160]
    return CaseSummary(
        display_id=display_id,
        internal_id=case.get("caseId", ""),
        subject=case.get("subject", ""),
        status=case.get("status", ""),
        severity=case.get("severityCode", ""),
        service_code=case.get("serviceCode", ""),
        category_code=case.get("categoryCode", ""),
        created_at=case.get("timeCreated", ""),
        submitted_by=submitted_by,
        case_url=_case_console_url(display_id),
        language=case.get("language", "en"),
        recent_communication=recent,
    )


def _to_communication(c: dict) -> Communication:
    submitted_by = c.get("submittedBy", "")
    body = c.get("body", "") or ""
    is_aws = (
        "amazon" in submitted_by.lower()
        or submitted_by.strip() == ""    # AWS internal often blank
    )
    return Communication(
        body=body,
        submitted_by=submitted_by or "Amazon Web Services",
        submitted_at=c.get("timeCreated", ""),
        is_aws=is_aws,
        attachment_set_id=c.get("attachmentSetId", "") or "",
    )


def _resolve_internal_id(display_id: str) -> str | None:
    """Map a user-facing displayId to the opaque caseId required by writes.

    AWS Support API's `DescribeCases.caseIdList` is restricted by a regex
    that only accepts the internal caseId format (`case-<12-account>-<region>-...`)
    — it rejects raw displayIds with a ValidationException. So we can't
    just round-trip through caseIdList.

    Instead we paginate `describe_cases` (no caseIdList filter) and scan
    for a row whose displayId matches. Bounded to ~90 days + 200 cases
    so a customer with many cases doesn't make this O(N) too slow.

    Callers that already hold the internal_id (e.g. from a list response
    cached in a button's action_value) MUST skip this function — it's a
    fallback for the natural-language path where only displayId is known.
    """
    if not display_id:
        return None
    try:
        params: dict = {
            "includeResolvedCases": True,
            "includeCommunications": False,
            "maxResults": 100,
            # 90 days back is generous; older cases are rarely targeted.
            "afterTime": (datetime.now(timezone.utc) - timedelta(days=90)
                          ).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        }
        scanned = 0
        while scanned < 200:
            resp = _support.describe_cases(**params)
            for case in resp.get("cases", []):
                if case.get("displayId") == display_id:
                    return case.get("caseId") or None
                scanned += 1
                if scanned >= 200:
                    break
            token = resp.get("nextToken")
            if not token:
                break
            params["nextToken"] = token
        logger.info("_resolve_internal_id(%s): not found in last 90 days / 200 cases",
                    display_id)
        return None
    except ClientError as e:
        logger.warning("_resolve_internal_id(%s) scan failed: %s",
                       display_id, e)
        return None


# ---------------------------------------------------------------------------
# 1. List recent cases (any status, newest first)
# ---------------------------------------------------------------------------
# Console URL for the full case list — shown at the bottom of the bot's
# list card so users can drill into older cases / filter by status.
SUPPORT_CONSOLE_LIST_URL = (
    "https://support.console.aws.amazon.com/support/home#/case/history"
)


def list_recent_cases(after_days: int = 90, max_items: int = 5,
                      status_filter: str = "recent"
                      ) -> list[CaseSummary]:
    """Return the most recently created `max_items` cases.

    `status_filter`:
      - "recent" (default): no filter, all statuses
      - "pending_customer": only `pending-customer-action`
      - "unresolved":       any non-resolved/non-closed status
      - "work_in_progress": only `work-in-progress`
      - "resolved":         only `resolved` or `closed`

    Filtering is done client-side after the API call. We over-fetch up to
    `max_items * 5` (capped at 100) when a filter is set so we still hit
    `max_items` matches even if recent cases are mostly the wrong status.
    """
    after = (datetime.now(timezone.utc) - timedelta(days=after_days))
    after_iso = after.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    # Over-fetch budget: when filtering we may need to scan more pages
    # to find max_items matches. AWS Support describe_cases supports up
    # to 100 per page; we cap fan-out at 200 cases overall to keep the
    # UX responsive.
    overfetch = max(10, min(max_items * 5, 100)) if status_filter != "recent" \
                else max(10, min(max_items, 100))
    scan_budget = 200 if status_filter != "recent" else max(max_items, 10)
    params: dict = {
        "afterTime": after_iso,
        "includeResolvedCases": True,    # client-side filtering picks the slice
        "includeCommunications": False,
        "maxResults": overfetch,
    }
    items: list[CaseSummary] = []
    scanned = 0
    try:
        while len(items) < max_items and scanned < scan_budget:
            resp = _support.describe_cases(**params)
            for c in resp.get("cases", []):
                scanned += 1
                if not _matches_filter(c.get("status", ""), status_filter):
                    continue
                items.append(_to_summary(c))
                if len(items) >= max_items:
                    break
            token = resp.get("nextToken")
            if not token:
                break
            params["nextToken"] = token
    except ClientError as e:
        logger.error("list_recent_cases failed: %s", e)
        return []
    items.sort(key=lambda x: x.created_at, reverse=True)
    return items[:max_items]


def _matches_filter(status: str, status_filter: str) -> bool:
    """Apply our slug-based status filter to a raw AWS Support status."""
    s = (status or "").lower()
    if status_filter == "recent" or not status_filter:
        return True
    if status_filter == "pending_customer":
        return s == "pending-customer-action"
    if status_filter == "work_in_progress":
        return s == "work-in-progress"
    if status_filter == "resolved":
        return s in {"resolved", "closed"}
    if status_filter == "unresolved":
        return s not in {"resolved", "closed"}
    return True


# Backwards-compat shim: any external code still importing the old name
# keeps working. Internal callers should use list_recent_cases directly.
def list_open_cases(after_days: int = 30, max_items: int = 10
                    ) -> list[CaseSummary]:
    return list_recent_cases(after_days=after_days, max_items=max_items,
                             status_filter="unresolved")


# ---------------------------------------------------------------------------
# 2. Describe a single case (with newest communication preview)
# ---------------------------------------------------------------------------
def describe_case(display_id: str,
                  internal_id: str | None = None) -> CaseSummary | None:
    """Look up a single case. Pass `internal_id` if cached to avoid the
    resolve scan."""
    if not display_id and not internal_id:
        return None
    cid = internal_id or _resolve_internal_id(display_id)
    if not cid:
        return None
    try:
        resp = _support.describe_cases(
            caseIdList=[cid],
            includeCommunications=True,
            includeResolvedCases=True,
        )
        cases = resp.get("cases") or []
        if not cases:
            return None
        return _to_summary(cases[0])
    except ClientError as e:
        logger.warning("describe_case(%s) failed: %s", display_id, e)
        return None


# ---------------------------------------------------------------------------
# 3. List communications (full history, newest first)
# ---------------------------------------------------------------------------
def list_communications(display_id: str, max_items: int = 5,
                        internal_id: str | None = None
                        ) -> list[Communication]:
    """Most recent `max_items` communications, newest first.

    `caseId` requires the **internal** case id; pass `internal_id` if you
    already have it (e.g. cached from a recent list_open_cases call) to
    skip the resolve scan.
    """
    if not display_id and not internal_id:
        return []
    cid = internal_id or _resolve_internal_id(display_id)
    if not cid:
        return []
    out: list[Communication] = []
    # AWS Support API requires maxResults >= 10. We may want fewer rows to
    # display, so we ask for at least 10 and trim client-side via max_items.
    params: dict = {
        "caseId": cid,
        "maxResults": max(10, min(max_items, 100)),
    }
    try:
        while len(out) < max_items:
            resp = _support.describe_communications(**params)
            for c in resp.get("communications", []):
                out.append(_to_communication(c))
                if len(out) >= max_items:
                    break
            token = resp.get("nextToken")
            if not token or len(out) >= max_items:
                break
            params["nextToken"] = token
    except ClientError as e:
        logger.warning("list_communications(%s) failed: %s", display_id, e)
        return []
    return out


# ---------------------------------------------------------------------------
# 4. Add a customer reply
# ---------------------------------------------------------------------------
# AWS Support API caseBody hard limit; trim defensively.
_COMM_MAX_CHARS = 7900


def add_communication(display_id: str, body: str,
                      internal_id: str | None = None) -> bool:
    """Append a customer-side communication. Returns True on success.

    Pass `internal_id` if you already have it to skip the resolve scan.
    """
    if (not display_id and not internal_id) or not body:
        return False
    cid = internal_id or _resolve_internal_id(display_id)
    if not cid:
        logger.warning("add_communication: cannot resolve display_id=%s",
                       display_id)
        return False
    body = body[:_COMM_MAX_CHARS]
    try:
        _support.add_communication_to_case(caseId=cid,
                                           communicationBody=body)
        logger.info("Added communication to case %s (display=%s, %d chars)",
                    cid, display_id, len(body))
        return True
    except ClientError as e:
        logger.warning("add_communication(%s) failed: %s", display_id, e)
        return False


# ---------------------------------------------------------------------------
# 5. Resolve (close)
# ---------------------------------------------------------------------------
def resolve_case(display_id: str,
                 internal_id: str | None = None) -> str:
    """Resolve a case. Returns the API-reported final status, or '' on error.

    Pass `internal_id` if you already have it to skip the resolve scan.
    """
    if not display_id and not internal_id:
        return ""
    cid = internal_id or _resolve_internal_id(display_id)
    if not cid:
        logger.warning("resolve_case: cannot resolve display_id=%s",
                       display_id)
        return ""
    try:
        resp = _support.resolve_case(caseId=cid)
        return resp.get("finalCaseStatus", "resolved")
    except ClientError as e:
        logger.warning("resolve_case(%s) failed: %s", display_id, e)
        return ""
