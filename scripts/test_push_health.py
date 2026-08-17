#!/usr/bin/env python3
"""Unit tests for #1 — health critical-issues-only + thread mode.

The Slack QA harness can't cover this: health events arrive via EventBridge
(aws.health → push_handler Lambda), not as user messages. So we drive
push_handler.lambda_handler() directly with synthetic aws.health events and
assert routing + thread-root behaviour, mocking the sender / DDB / dispatch.

Run: python3 scripts/test_push_health.py
"""
import os
import sys
import unittest.mock as mock

os.environ.setdefault("PUSH_TARGET_PLATFORM", "slack")
os.environ.setdefault("PUSH_TARGET_CHAT_ID", "C_TEST")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AWS_REGION", "us-east-1")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
# `push_handler` / `dingtalk_sender` 已从 `lambda/` 搬到 `shared/report_delivery/`，
# 而这行路径没跟着改 —— 于是这三套测试一直 ModuleNotFoundError，也正因为一直是坏的
# 才没被加进 CI。修路径而不是继续豁免：它们覆盖的是钉钉推送与健康报告投递。
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..",
                                "shared", "report_delivery"))

import push_handler  # noqa: E402


def _health_event(category: str, type_code: str = "AWS_TEST_FAULT") -> dict:
    return {
        "source": "aws.health",
        "detail-type": "AWS Health Event",
        "region": "us-east-1",
        "account": "111122223333",
        "detail": {
            "eventTypeCategory": category,
            "eventTypeCode": type_code,
            "eventArn": f"arn:aws:health:us-east-1::event/{type_code}/{category}",
            "eventDescription": [{"latestDescription": "synthetic test event"}],
        },
    }


class _FakeSender:
    """Records send_push_headsup calls and returns a fixed message ts."""
    HEADSUP_TS = "1780000000.123456"

    def __init__(self):
        self.calls = []

    def send_push_headsup(self, *, chat_id, event, locale="en"):
        self.calls.append({"chat_id": chat_id, "event": event})
        return self.HEADSUP_TS


def _run(event):
    """Invoke the handler with all external deps mocked. Returns
    (result, sender, dispatched, ddb_items)."""
    sender = _FakeSender()
    dispatched = []
    ddb_items = []

    fake_table = mock.MagicMock()
    fake_table.put_item.side_effect = lambda **kw: ddb_items.append(kw.get("Item", {}))

    def fake_dispatch(**kw):
        dispatched.append(kw)
        return {"ok": True, "status": 200, "task_id": "task-test"}

    with mock.patch.object(push_handler, "_load_sender", return_value=sender), \
         mock.patch.object(push_handler, "_claim_dedupe", return_value=True), \
         mock.patch.object(push_handler, "_ddb_table", fake_table), \
         mock.patch.object(push_handler.webhook_dispatch, "dispatch",
                           side_effect=fake_dispatch):
        result = push_handler.lambda_handler(event, None)
    return result, sender, dispatched, ddb_items


def main() -> int:
    passed = failed = 0

    def check(name, cond):
        nonlocal passed, failed
        print(f"  {'✅' if cond else '❌'} {name}")
        passed += cond
        failed += (not cond)

    # 1. Critical ISSUE → notify + investigate + thread root = heads-up ts
    print("\n[1] aws.health category=issue → proactive + thread mode")
    result, sender, dispatched, ddb_items = _run(_health_event("issue"))
    check("heads-up card sent", len(sender.calls) == 1)
    check("investigation dispatched", len(dispatched) == 1)
    check("DDB records written", len(ddb_items) >= 1)
    check("thread root = heads-up ts (one event one thread)",
          all(i.get("root_message_id") == _FakeSender.HEADSUP_TS
              for i in ddb_items))

    # 2. scheduledChange (EOL/maintenance) → deferred, no spam, no investigate
    print("\n[2] aws.health category=scheduledChange → deferred to digest")
    result, sender, dispatched, _ = _run(_health_event("scheduledChange"))
    check("not proactively posted", len(sender.calls) == 0)
    check("not auto-investigated", len(dispatched) == 0)
    check("returns health-non-issue-deferred",
          result.get("body") == "health-non-issue-deferred")

    # 3. accountNotification → deferred
    print("\n[3] aws.health category=accountNotification → deferred")
    result, sender, dispatched, _ = _run(_health_event("accountNotification"))
    check("not proactively posted", len(sender.calls) == 0)
    check("not auto-investigated", len(dispatched) == 0)

    print(f"\n{passed}/{passed + failed} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
