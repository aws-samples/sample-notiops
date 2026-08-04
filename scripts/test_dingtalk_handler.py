"""
Smoke test for the DingTalk Stream Mode handler.

Pins down the contract between `platforms/dingtalk/app/main.py` and
the `dingtalk-stream` SDK:

  * `ChatBotHandler.process(callback)` runs to completion on a
    well-formed inbound payload without raising.
  * Inline command short-circuits work (language / model).
  * Investigate dispatches via `core.webhook_dispatch.dispatch`.
  * Defense-in-depth refuses blatant change requests before LLM.

Run from repo root::

    PYTHONPATH=. python3 scripts/test_dingtalk_handler.py

Requires the `dingtalk-stream` SDK to be importable; if absent the
test exits 0 with a "skipped" notice (CI environments without the
SDK pinned shouldn't fail).
"""
from __future__ import annotations

import asyncio
import os
import sys
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..",
                                  "platforms", "dingtalk", "app"))

# Required for `core.ddb_state` to import without a real table.
os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")
os.environ.setdefault("DINGTALK_APP_KEY", "fake")
os.environ.setdefault("DINGTALK_APP_SECRET", "fake")

# Stub boto3 BEFORE importing main so module-level boto3 calls are
# inert in this offline test.
import boto3  # noqa: E402
boto3.resource = mock.MagicMock()
boto3.client = mock.MagicMock()

try:
    import dingtalk_stream  # noqa: F401
except ImportError:
    print("⏭  dingtalk-stream SDK not installed; skipping handler smoke test")
    sys.exit(0)

import main as m  # noqa: E402  pylint: disable=wrong-import-position
from core import (bedrock_intent, i18n, llm_pref_resolver,  # noqa: E402
                  locale_resolver, webhook_dispatch)

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


def _setup_mocks():
    locale_resolver.resolve = mock.MagicMock(return_value=("zh", "auto"))
    locale_resolver.set_user_pref = mock.MagicMock(return_value=True)
    locale_resolver.lock_for_dm = mock.MagicMock()
    locale_resolver.lock_for_incident = mock.MagicMock()
    i18n.parse_language_switch_intent = mock.MagicMock(return_value="")
    i18n.normalize_locale = mock.MagicMock(
        side_effect=lambda x: (x or "").lower())
    i18n.locale_name = mock.MagicMock(return_value="中文")
    llm_pref_resolver.set_dm_pref = mock.MagicMock(return_value=True)
    llm_pref_resolver.set_chat_pref = mock.MagicMock(return_value=True)
    bedrock_intent.analyze_intent = mock.MagicMock(return_value={
        "command": "investigate", "intent": "look",
        "is_change_request": False,
    })
    webhook_dispatch.dispatch = mock.MagicMock(
        return_value={"ok": True, "task_id": "t1"})


def _make_handler():
    h = m.ChatBotHandler()
    h._captured = []  # type: ignore[attr-defined]
    h.reply_text = lambda t, msg: h._captured.append(("text", t))
    h.reply_markdown = lambda title, t, msg: h._captured.append(
        ("md", title, t))
    return h


def _payload(content: str, *, conversation_type: str = "1") -> dict:
    return {
        "conversationType": conversation_type,
        "conversationId": "cid_test",
        "senderStaffId": "u1",
        "senderId": "u1",
        "messageId": "msg1",
        "msgtype": "text",
        "text": {"content": content},
    }


class _CB:
    def __init__(self, data: dict):
        self.data = data


def test_language_command_short_circuits():
    print("test_language_command_short_circuits")
    _setup_mocks()
    h = _make_handler()
    asyncio.run(h.process(_CB(_payload("language zh"))))
    _check("language reply emitted", len(h._captured) == 1)
    _check("dispatch NOT called",
           not webhook_dispatch.dispatch.called,
           "should never reach intent classification")


def test_model_command_short_circuits():
    print("test_model_command_short_circuits")
    _setup_mocks()
    h = _make_handler()
    asyncio.run(h.process(_CB(_payload("model claude"))))
    _check("model reply emitted", len(h._captured) == 1)
    _check("set_dm_pref called (DM scope)",
           llm_pref_resolver.set_dm_pref.called)


def test_investigate_dispatches():
    print("test_investigate_dispatches")
    _setup_mocks()
    h = _make_handler()
    asyncio.run(h.process(_CB(_payload(
        "@DevOps look at i-1234567890abc CPU"))))
    _check("dispatch called", webhook_dispatch.dispatch.called)
    _check("ack reply emitted (dispatched_short)",
           any(c[0] == "text" for c in h._captured))


def test_blatant_change_refused():
    print("test_blatant_change_refused")
    _setup_mocks()
    h = _make_handler()
    asyncio.run(h.process(_CB(_payload("delete i-1234567890abc"))))
    _check("refusal emitted", len(h._captured) == 1)
    _check("dispatch NOT called",
           not webhook_dispatch.dispatch.called,
           "Layer-1 regex must refuse before LLM")


def test_chitchat_general_qa_uses_markdown_reply():
    print("test_chitchat_general_qa_uses_markdown_reply")
    _setup_mocks()
    bedrock_intent.analyze_intent = mock.MagicMock(return_value={
        "command": "general_qa", "intent": "what is EKS",
        "is_change_request": False,
    })
    # Stub bedrock_chat.respond import target.
    from core import bedrock_chat
    bedrock_chat.respond = mock.MagicMock(
        return_value="EKS 是托管的 Kubernetes 服务。")
    h = _make_handler()
    asyncio.run(h.process(_CB(_payload("什么是 EKS"))))
    _check("at least one markdown reply emitted",
           any(c[0] == "md" for c in h._captured),
           f"captured={h._captured}")


def test_strip_at_mention():
    print("test_strip_at_mention")
    import dingtalk_utils as u
    cases = [
        ("@Bot hello", "hello"),
        ("hello world", "hello world"),
        ("  @Bot  hi", "hi"),
        ("", ""),
        ("@Bot", ""),
    ]
    for raw, expected in cases:
        got = u.strip_at_mention(raw)
        _check(f"strip_at_mention({raw!r}) → {expected!r}",
               got == expected, f"got {got!r}")


def main() -> int:
    test_strip_at_mention()
    test_language_command_short_circuits()
    test_model_command_short_circuits()
    test_investigate_dispatches()
    test_blatant_change_refused()
    test_chitchat_general_qa_uses_markdown_reply()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
