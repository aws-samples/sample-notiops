"""
Pin down that `shared.devops_agent.create_investigation` embeds the
`<!--notiops:<incident_id>-->` HTML marker into the description it sends
to the DevOps Agent API.

Why this test exists: in 2026-06 fusion the dispatch path moved from the
old webhook+HMAC route to STS AssumeRole + DevOps Agent
`create_investigation` API. The new path forgot to embed the routing
marker that the report-handler greps from journal records to look up
DDB context (chat_id, locale, "升级 Support" button visibility, etc.).
This regressed the report card — it stopped showing the case escalation
button because `_resolve_chat_target` couldn't find the incident# row.

This test stubs out boto3 + DDB + STS so create_investigation can run
fully offline, and asserts the description sent to `create_backlog_task`
contains `<!--notiops:<incident_id>-->`. Should fail loudly the moment
anyone refactors the dispatch path and drops the marker again.

Run from repo root::

    PYTHONPATH=. python3.13 scripts/test_incident_marker_in_dispatch.py
"""
from __future__ import annotations

import os
import sys
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

# `shared.devops_agent` constructs boto3 clients at module import time.
# Stub them out so this test runs without AWS credentials.
import boto3 as _boto3
_boto3.client = mock.MagicMock()
_boto3.resource = mock.MagicMock()

from shared import devops_agent  # noqa: E402

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


def _make_stub_client(captured_calls: list) -> mock.MagicMock:
    """Return a mock boto3 devops-agent client. Each create_backlog_task
    call has its kwargs appended to captured_calls so the test can inspect
    the description that was actually sent."""
    client = mock.MagicMock()

    def _create_backlog_task(**kwargs):
        captured_calls.append(kwargs)
        return {"task": {"taskId": "task-stub-1", "executionId": "exe-stub-1"}}

    client.create_backlog_task.side_effect = _create_backlog_task
    return client


def test_marker_embedded_when_incident_id_provided():
    print("test_marker_embedded_when_incident_id_provided")
    captured = []
    fake_client = _make_stub_client(captured)

    with mock.patch.object(
        devops_agent, "_query_account_mapping",
        return_value={
            "agent_space_id": "as-stub",
            "trigger_role_arn": "arn:aws:iam::111111111111:role/x",
            "related_business_accounts": [],
        },
    ), mock.patch.object(
        devops_agent, "_get_cross_account_client",
        return_value=fake_client,
    ), mock.patch.object(
        devops_agent, "is_account_allowed", return_value=True,
    ):
        result = devops_agent.create_investigation(
            title="[Feishu#abc] hello world",
            description="please look at the EC2 instances in IAD",
            target_account_id="111111111111",
            source="feishu-mention",
            incident_id="feishu-abc123def456",
        )

    _check("create_investigation succeeded", result.get("success") is True,
           f"got {result!r}")
    _check("API was called once", len(captured) == 1,
           f"got {len(captured)} calls")
    if not captured:
        return
    desc = captured[0].get("description", "")
    _check("description contains the marker",
           "<!--notiops:feishu-abc123def456-->" in desc,
           f"description={desc!r}")
    _check("marker placed at end (after user text)",
           desc.rstrip().endswith("<!--notiops:feishu-abc123def456-->"),
           f"description={desc!r}")
    _check("source prefix preserved",
           desc.startswith("[feishu-mention]"),
           f"description={desc!r}")
    _check("user text preserved",
           "please look at the EC2 instances in IAD" in desc)


def test_no_marker_when_incident_id_omitted():
    """Lambda4 + cost-anomaly paths don't have an incident_id; they rely on
    the report-handler's `task-<task_id>` fallback. Make sure passing
    incident_id=None (the default) leaves the description marker-free."""
    print("test_no_marker_when_incident_id_omitted")
    captured = []
    fake_client = _make_stub_client(captured)

    with mock.patch.object(
        devops_agent, "_query_account_mapping",
        return_value={
            "agent_space_id": "as-stub",
            "trigger_role_arn": "arn:aws:iam::111111111111:role/x",
            "related_business_accounts": [],
        },
    ), mock.patch.object(
        devops_agent, "_get_cross_account_client",
        return_value=fake_client,
    ), mock.patch.object(
        devops_agent, "is_account_allowed", return_value=True,
    ):
        devops_agent.create_investigation(
            title="health-critical scan",
            description="critical RDS issue",
            target_account_id="111111111111",
            source="notiops-health-critical",
            # incident_id intentionally omitted
        )

    if not captured:
        _check("API was called", False)
        return
    desc = captured[0].get("description", "")
    _check("no marker leaked when incident_id absent",
           "<!--notiops:" not in desc,
           f"description={desc!r}")


def test_empty_string_incident_id_treated_as_absent():
    """The `if incident_id:` truthy check should also skip the marker when
    a caller explicitly passes incident_id="" (vs None)."""
    print("test_empty_string_incident_id_treated_as_absent")
    captured = []
    fake_client = _make_stub_client(captured)

    with mock.patch.object(
        devops_agent, "_query_account_mapping",
        return_value={
            "agent_space_id": "as-stub",
            "trigger_role_arn": "arn:aws:iam::111111111111:role/x",
            "related_business_accounts": [],
        },
    ), mock.patch.object(
        devops_agent, "_get_cross_account_client",
        return_value=fake_client,
    ), mock.patch.object(
        devops_agent, "is_account_allowed", return_value=True,
    ):
        devops_agent.create_investigation(
            title="t",
            description="d",
            target_account_id="111111111111",
            source="manual",
            incident_id="",
        )
    desc = captured[0].get("description", "") if captured else ""
    _check("no marker when incident_id=''",
           "<!--notiops:" not in desc,
           f"description={desc!r}")


def main() -> int:
    test_marker_embedded_when_incident_id_provided()
    test_no_marker_when_incident_id_omitted()
    test_empty_string_incident_id_treated_as_absent()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
