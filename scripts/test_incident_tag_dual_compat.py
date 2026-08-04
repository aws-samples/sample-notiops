"""
Pin down the dual-compat behavior of `_INCIDENT_TAG_RE` after the
2026-06 brand rename (notiops-devops → NotiOps).

Why: in-flight DevOps Agent investigations dispatched BEFORE the
rename embed `<!--notiops-devops:incident-xxx-->` in their task
description. Investigations dispatched AFTER use `<!--notiops:
incident-xxx-->`. The report-handler sees BOTH forms in journal
records during the transition window (24h TTL of incident# rows)
and must route both correctly.

Run from repo root::

    PYTHONPATH=. python3 scripts/test_incident_tag_dual_compat.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

# `report_handler` calls `boto3.client("devops-agent")` at import time;
# botocore in older local envs doesn't know that service name. Stub it
# so this offline test only exercises the regex.
import unittest.mock as _mock
import boto3 as _boto3
_boto3.client = _mock.MagicMock()
_boto3.resource = _mock.MagicMock()

from shared.report_delivery import report_handler  # noqa: E402

PASS = "✅"
FAIL = "❌"
_failed = 0


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


def test_new_form_matches():
    print("test_new_form_matches")
    text = "Some agent text\n<!--notiops:feishu-abc123-->\nmore text"
    m = report_handler._INCIDENT_TAG_RE.search(text)
    _check("new form `notiops:` matches", m is not None)
    if m:
        _check("captures incident_id",
               m.group(1) == "feishu-abc123",
               f"got {m.group(1)!r}")


def test_legacy_form_still_matches():
    print("test_legacy_form_still_matches")
    text = "Some agent text\n<!--notiops-devops:feishu-abc123-->\nmore text"
    m = report_handler._INCIDENT_TAG_RE.search(text)
    _check("legacy form `notiops-devops:` matches", m is not None)
    if m:
        _check("captures incident_id from legacy form",
               m.group(1) == "feishu-abc123")


def test_random_text_does_not_match():
    print("test_random_text_does_not_match")
    cases = [
        "no marker here",
        "<!--unrelated-comment-->",
        "<!--notiops-without-colon abc-->",
        "<!--:no-prefix-->",
    ]
    for s in cases:
        _check(f"no false match: {s!r}",
               report_handler._INCIDENT_TAG_RE.search(s) is None)


def test_findall_picks_both_in_mixed_journal():
    """During the rename transition a single agent execution might
    have picked up multiple bot dispatches across the boundary —
    one with the legacy form, one with the new form. The handler
    treats the LATEST as the routing target; both must be findable
    so the latest-wins logic upstream can do its job."""
    print("test_findall_picks_both_in_mixed_journal")
    journal = (
        "first record: <!--notiops-devops:slack-old-->\n"
        "later record: <!--notiops:slack-new-->\n"
    )
    matches = report_handler._INCIDENT_TAG_RE.findall(journal)
    _check("both incident ids extracted",
           matches == ["slack-old", "slack-new"],
           f"got {matches!r}")


def test_strip_removes_both_forms():
    print("test_strip_removes_both_forms")
    raw = (
        "Real report content here.\n"
        "<!--notiops:feishu-1-->\n"
        "<!--notiops-devops:feishu-2-->"
    )
    stripped = report_handler._INCIDENT_TAG_RE.sub("", raw)
    _check("new form stripped", "notiops:" not in stripped)
    _check("legacy form stripped", "notiops-devops:" not in stripped)
    _check("real content kept", "Real report content here." in stripped)


def main() -> int:
    test_new_form_matches()
    test_legacy_form_still_matches()
    test_random_text_does_not_match()
    test_findall_picks_both_in_mixed_journal()
    test_strip_removes_both_forms()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
