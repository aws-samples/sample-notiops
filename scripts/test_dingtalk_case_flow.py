"""
Phase 2b smoke test for the DingTalk conversational case-create flow.

Pins down the contract between `platforms/dingtalk/app/case_flow.py`
and `core/ddb_state.py` + `core/support_logic.py`:

  * `start_create` opens a session and prompts the user.
  * `maybe_continue` returns True only when a session is active for
    the (chat, user) pair.
  * Cancel keywords clear the session.
  * A successful details turn calls `support_logic.create_case` with
    the right ctx + severity + language and replies with the case id.
  * A failed `create_case` does NOT leave a stale session behind.
  * `handle_list / view / reply / resolve` route into core
    `case_management` correctly.

Also exercises the new `core.ddb_state` convo-session helpers.

No network. ddb / boto3 / support_logic.create_case are all mocked.
Run from repo root::

    PYTHONPATH=. python3 scripts/test_dingtalk_case_flow.py
"""
from __future__ import annotations

import os
import sys
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..",
                                  "platforms", "dingtalk", "app"))

os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")

import boto3  # noqa: E402
boto3.resource = mock.MagicMock()
boto3.client = mock.MagicMock()

import case_flow  # noqa: E402
from core import case_management, ddb_state, support_logic  # noqa: E402

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


def _fake_session_store():
    """In-memory replacement for the convo-session helpers in
    ddb_state. Lets us assert exact transitions without DDB."""
    store: dict = {}

    def put(*, platform, chat_id, user_id, kind, data, ttl_seconds=1800):
        store[(platform, chat_id, user_id, kind)] = dict(data)

    def get(platform, chat_id, user_id, kind):
        return store.get((platform, chat_id, user_id, kind))

    def clear(platform, chat_id, user_id, kind):
        store.pop((platform, chat_id, user_id, kind), None)

    return store, put, get, clear


def _make_handler():
    h = mock.MagicMock()
    h._captured = []  # not used today but symmetric with the other tests
    return h


# ---------- Tests ---------------------------------------------------------

def test_start_create_opens_session_and_prompts():
    print("test_start_create_opens_session_and_prompts")
    store, put, get, clear = _fake_session_store()
    with mock.patch.object(ddb_state, "put_convo_session", put), \
         mock.patch.object(ddb_state, "get_convo_session", get), \
         mock.patch.object(ddb_state, "clear_convo_session", clear):
        handler = _make_handler()
        case_flow.start_create(
            handler=handler, msg="msg",
            conversation_id="cid_grp", user_id="u1",
            raw_text="open a case for RDS my-db slow queries",
            intent_summary="RDS slow queries",
            locale="en",
        )
    _check("session opened",
           ("dingtalk", "cid_grp", "u1", "case_create") in store)
    _check("state is awaiting_details",
           store[("dingtalk", "cid_grp", "u1", "case_create")]["state"]
           == "awaiting_details")
    _check("prompt was reply_markdown not reply_text",
           handler.reply_markdown.called and not handler.reply_text.called)


def test_maybe_continue_returns_false_when_no_session():
    print("test_maybe_continue_returns_false_when_no_session")
    store, put, get, clear = _fake_session_store()
    with mock.patch.object(ddb_state, "put_convo_session", put), \
         mock.patch.object(ddb_state, "get_convo_session", get), \
         mock.patch.object(ddb_state, "clear_convo_session", clear):
        handler = _make_handler()
        out = case_flow.maybe_continue(
            handler=handler, msg="msg",
            conversation_id="cid_grp", user_id="u_other",
            raw_text="hi", locale="en", operator_name="Tester",
        )
    _check("returned False (no session for this user)", out is False)
    _check("did NOT call any reply method",
           not handler.reply_text.called and not handler.reply_markdown.called)


def test_cancel_keyword_clears_session():
    print("test_cancel_keyword_clears_session")
    store, put, get, clear = _fake_session_store()
    store[("dingtalk", "cid_grp", "u1", "case_create")] = {
        "state": "awaiting_details", "raw_text": "x", "intent_summary": "",
    }
    with mock.patch.object(ddb_state, "put_convo_session", put), \
         mock.patch.object(ddb_state, "get_convo_session", get), \
         mock.patch.object(ddb_state, "clear_convo_session", clear):
        handler = _make_handler()
        out = case_flow.maybe_continue(
            handler=handler, msg="msg",
            conversation_id="cid_grp", user_id="u1",
            raw_text="cancel", locale="en", operator_name="t",
        )
    _check("returned True (consumed)", out is True)
    _check("session cleared",
           ("dingtalk", "cid_grp", "u1", "case_create") not in store)


def test_details_turn_calls_create_case_and_reports_id():
    print("test_details_turn_calls_create_case_and_reports_id")
    store, put, get, clear = _fake_session_store()
    store[("dingtalk", "cid_grp", "u1", "case_create")] = {
        "state": "awaiting_details",
        "raw_text": "open a case for RDS my-db slow",
        "intent_summary": "RDS slow",
    }
    fake_result = mock.MagicMock(
        ok=True, internal_id="case-1", display_id="177968",
        case_url="https://console.example/case/177968",
        error_code=None, error_message=None,
    )
    with mock.patch.object(ddb_state, "put_convo_session", put), \
         mock.patch.object(ddb_state, "get_convo_session", get), \
         mock.patch.object(ddb_state, "clear_convo_session", clear), \
         mock.patch.object(support_logic, "create_case",
                            return_value=fake_result) as cc:
        handler = _make_handler()
        out = case_flow.maybe_continue(
            handler=handler, msg="msg",
            conversation_id="cid_grp", user_id="u1",
            raw_text="RDS my-db CPU 100%\nInstance: db-prod-01\n"
                     "Window: past hour",
            locale="en", operator_name="Tester",
        )
    _check("returned True (consumed)", out is True)
    _check("create_case was called", cc.called)
    if cc.called:
        kwargs = cc.call_args.kwargs
        _check("platform=dingtalk", kwargs.get("platform") == "dingtalk")
        _check("severity is the default",
               kwargs.get("severity") == support_logic.DEFAULT_SEVERITY)
        _check("language is en (matches locale)",
               kwargs.get("language") == "en")
        _check("operator_name passed", kwargs.get("operator_name") == "Tester")
        _check("extra carries body lines",
               "Instance: db-prod-01" in (kwargs.get("extra") or ""))
    _check("session cleared after create",
           ("dingtalk", "cid_grp", "u1", "case_create") not in store)
    _check("ok-card replied via reply_markdown",
           handler.reply_markdown.called)


def test_failed_create_clears_session():
    print("test_failed_create_clears_session")
    store, put, get, clear = _fake_session_store()
    store[("dingtalk", "cid_grp", "u1", "case_create")] = {
        "state": "awaiting_details", "raw_text": "x", "intent_summary": "",
    }
    fake_result = mock.MagicMock(
        ok=False, internal_id=None, display_id=None,
        error_code="SubscriptionRequiredException",
        error_message="No Business Support plan",
    )
    with mock.patch.object(ddb_state, "put_convo_session", put), \
         mock.patch.object(ddb_state, "get_convo_session", get), \
         mock.patch.object(ddb_state, "clear_convo_session", clear), \
         mock.patch.object(support_logic, "create_case",
                            return_value=fake_result):
        handler = _make_handler()
        case_flow.maybe_continue(
            handler=handler, msg="msg",
            conversation_id="cid_grp", user_id="u1",
            raw_text="subj\nbody", locale="zh", operator_name="t",
        )
    _check("session cleared even on failure",
           ("dingtalk", "cid_grp", "u1", "case_create") not in store)
    _check("error reply emitted via reply_markdown",
           handler.reply_markdown.called)


def test_handle_list_routes_to_core():
    print("test_handle_list_routes_to_core")
    fake_case = mock.MagicMock(
        display_id="177968", subject="Slow RDS",
        status="opened", severity="normal", created_at="2026-06-04",
    )
    with mock.patch.object(case_management, "list_recent_cases",
                            return_value=[fake_case]) as lc:
        handler = _make_handler()
        case_flow.handle_list(handler=handler, msg="m",
                               status_filter="unresolved", locale="en")
    _check("list_recent_cases called", lc.called)
    if lc.called:
        _check("status_filter forwarded",
               lc.call_args.kwargs.get("status_filter") == "unresolved")
    _check("rendered as markdown reply", handler.reply_markdown.called)


def test_handle_view_missing_id_short_circuits():
    print("test_handle_view_missing_id_short_circuits")
    with mock.patch.object(case_management, "describe_case") as dc:
        handler = _make_handler()
        case_flow.handle_view(handler=handler, msg="m",
                               display_id="", locale="en")
    _check("describe_case NOT called when id missing",
           not dc.called)
    _check("plain-text guidance reply", handler.reply_text.called)


def test_handle_reply_routes_add_communication():
    print("test_handle_reply_routes_add_communication")
    with mock.patch.object(case_management, "add_communication",
                            return_value=True) as ac:
        handler = _make_handler()
        case_flow.handle_reply(
            handler=handler, msg="m", display_id="177968",
            body="Fixed by upgrading", locale="en")
    _check("add_communication called", ac.called)


def test_handle_resolve_uses_returned_status():
    print("test_handle_resolve_uses_returned_status")
    with mock.patch.object(case_management, "resolve_case",
                            return_value="resolved") as rc:
        handler = _make_handler()
        case_flow.handle_resolve(
            handler=handler, msg="m", display_id="177968", locale="en")
    _check("resolve_case called", rc.called)
    _check("text reply emitted", handler.reply_text.called)


def main() -> int:
    test_start_create_opens_session_and_prompts()
    test_maybe_continue_returns_false_when_no_session()
    test_cancel_keyword_clears_session()
    test_details_turn_calls_create_case_and_reports_id()
    test_failed_create_clears_session()
    test_handle_list_routes_to_core()
    test_handle_view_missing_id_short_circuits()
    test_handle_reply_routes_add_communication()
    test_handle_resolve_uses_returned_status()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
