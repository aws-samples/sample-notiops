"""
Phase 2b smoke test for the `_push_configured` gate added to
`lambda/push_handler.py`.

Pins down the contract:

  * For feishu / slack: gate is True iff `PUSH_TARGET_CHAT_ID` is set
    (legacy behaviour preserved).
  * For dingtalk: gate is True iff EITHER `PUSH_TARGET_CHAT_ID` OR a
    custom-bot webhook URL is configured (chat_id is unused for
    dingtalk delivery, so requiring it would block all dingtalk
    push traffic forever).

No network. boto3 calls are stubbed at import time.
Run from repo root::

    PYTHONPATH=lambda python3 scripts/test_push_handler_dingtalk.py
"""
from __future__ import annotations

import os
import sys
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "lambda"))

# Required so module-level boto3 calls in the lambda don't blow up.
os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")

import boto3  # noqa: E402
boto3.resource = mock.MagicMock()
boto3.client = mock.MagicMock()


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


def _reload(env: dict[str, str]):
    """Re-import push_handler with the given env so its module-level
    constants reflect the test scenario."""
    for key in ("PUSH_TARGET_PLATFORM", "PUSH_TARGET_CHAT_ID",
                "DINGTALK_PUSH_WEBHOOK_URL", "DINGTALK_PUSH_WEBHOOK_URL_ARN"):
        os.environ.pop(key, None)
    for k, v in env.items():
        os.environ[k] = v
    if "push_handler" in sys.modules:
        del sys.modules["push_handler"]
    import push_handler  # type: ignore
    return push_handler


def test_feishu_requires_chat_id():
    print("test_feishu_requires_chat_id")
    ph = _reload({"PUSH_TARGET_PLATFORM": "feishu"})
    _check("feishu without chat_id → disabled",
           ph._push_configured() is False)

    ph = _reload({"PUSH_TARGET_PLATFORM": "feishu",
                   "PUSH_TARGET_CHAT_ID": "oc_xyz"})
    _check("feishu with chat_id → enabled",
           ph._push_configured() is True)


def test_slack_requires_chat_id():
    print("test_slack_requires_chat_id")
    ph = _reload({"PUSH_TARGET_PLATFORM": "slack"})
    _check("slack without chat_id → disabled",
           ph._push_configured() is False)

    ph = _reload({"PUSH_TARGET_PLATFORM": "slack",
                   "PUSH_TARGET_CHAT_ID": "C012XY"})
    _check("slack with chat_id → enabled",
           ph._push_configured() is True)


def test_dingtalk_accepts_webhook_url_in_lieu_of_chat_id():
    print("test_dingtalk_accepts_webhook_url_in_lieu_of_chat_id")
    ph = _reload({"PUSH_TARGET_PLATFORM": "dingtalk"})
    _check("dingtalk without anything → disabled",
           ph._push_configured() is False)

    ph = _reload({
        "PUSH_TARGET_PLATFORM": "dingtalk",
        "DINGTALK_PUSH_WEBHOOK_URL": "https://oapi.dingtalk.com/robot/send?access_token=t",
    })
    _check("dingtalk with webhook URL only → enabled",
           ph._push_configured() is True,
           "the new gate must allow dingtalk to opt-in via webhook URL")

    ph = _reload({
        "PUSH_TARGET_PLATFORM": "dingtalk",
        "PUSH_TARGET_CHAT_ID": "cid_xyz=",
    })
    _check("dingtalk with legacy chat_id only → enabled (parity)",
           ph._push_configured() is True)


def test_dingtalk_webhook_via_secrets_arn_also_counts():
    print("test_dingtalk_webhook_via_secrets_arn_also_counts")
    ph = _reload({
        "PUSH_TARGET_PLATFORM": "dingtalk",
        "DINGTALK_PUSH_WEBHOOK_URL_ARN": "arn:aws:secretsmanager:...",
    })
    _check("dingtalk with secrets-arn indirection → enabled",
           ph._push_configured() is True)


def main() -> int:
    test_feishu_requires_chat_id()
    test_slack_requires_chat_id()
    test_dingtalk_accepts_webhook_url_in_lieu_of_chat_id()
    test_dingtalk_webhook_via_secrets_arn_also_counts()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
