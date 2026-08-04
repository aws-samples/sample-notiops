"""
Pin down the new `case_analyze` intent classification.

We exercise both the slash-style fast path (deterministic, no Bedrock)
and the Bedrock NL path (Bedrock invoke_model is mocked so we control the
returned JSON). Failures in either path are loud — these are the
guarantees the platform routers depend on:

  1. Slash patterns ("/analyze-case 12345" / "/case-summary 12345" /
     "/summarize-case 12345") classify as case_analyze with case id.
  2. NL phrases ("分析 case 12345" / "summarize case 67890" /
     "帮我看 case 555555 是什么原因") classify as case_analyze
     when Bedrock returns the right JSON.
  3. Without a 6-digit case id, case_analyze always falls back to
     case_list (so the user picks one).
  4. Empty-string case_id from Bedrock falls back to case_list.

Run from repo root::

    PYTHONPATH=. python3.13 scripts/test_case_analyze_intent.py
"""
from __future__ import annotations

import json
import os
import sys
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

# `bedrock_intent` constructs a boto3 client at import time. Stub it.
import boto3 as _boto3
_boto3.client = mock.MagicMock()

# AGENTIC_CHAT_MODE doesn't matter for case_* paths; default disabled.
os.environ.setdefault("AGENTIC_CHAT_MODE", "disabled")

from core import bedrock_intent  # noqa: E402

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


def _bedrock_response(payload: dict) -> dict:
    """Build the boto3-shape response that bedrock_intent expects."""
    body = json.dumps({"content": [{"type": "text",
                                    "text": json.dumps(payload)}]})
    fake_body = mock.MagicMock()
    fake_body.read.return_value = body.encode("utf-8")
    return {"body": fake_body}


# ---------------------------------------------------------------------------
# Slash path (no Bedrock involved)
# ---------------------------------------------------------------------------
def test_slash_analyze_case_with_id():
    print("test_slash_analyze_case_with_id")
    cases = [
        ("/analyze-case 1234567890", "1234567890"),
        ("analyze-case 1234567890", "1234567890"),
        ("analyze_case 1234567890", "1234567890"),
        ("/summarize-case 9876543210", "9876543210"),
        ("/summarize_case 9876543210", "9876543210"),
        ("/case-summary 5555555555", "5555555555"),
        ("case_summary 5555555555", "5555555555"),
        ("/case-analyse 1111111111", "1111111111"),  # British
    ]
    for text, expected_id in cases:
        result = bedrock_intent.analyze_intent(text, locale="en")
        _check(f"{text!r} → command=case_analyze",
               result["command"] == "case_analyze",
               f"got {result['command']!r}")
        _check(f"{text!r} → case_id={expected_id}",
               result["case_display_id"] == expected_id,
               f"got {result['case_display_id']!r}")


def test_slash_analyze_no_id_falls_back_to_list():
    print("test_slash_analyze_no_id_falls_back_to_list")
    result = bedrock_intent.analyze_intent("/analyze-case", locale="en")
    _check("'/analyze-case' (no id) → case_list",
           result["command"] == "case_list",
           f"got {result['command']!r}")
    _check("case_id empty",
           result["case_display_id"] == "",
           f"got {result['case_display_id']!r}")


# ---------------------------------------------------------------------------
# Bedrock NL path
# ---------------------------------------------------------------------------
def _patch_bedrock(payload: dict):
    """Return a context manager that patches `_bedrock.invoke_model` to
    return `payload` shape."""
    return mock.patch.object(
        bedrock_intent._bedrock, "invoke_model",
        return_value=_bedrock_response(payload),
    )


def test_nl_analyze_zh_with_id():
    print("test_nl_analyze_zh_with_id")
    payload = {
        "command": "case_analyze",
        "intent": "分析 case 1234567890",
        "case_display_id": "1234567890",
        "case_filter": "",
        "suggestions": [],
        "needs_diagnosis": False,
        "is_change_request": False,
    }
    with _patch_bedrock(payload):
        r = bedrock_intent.analyze_intent("分析 case 1234567890",
                                            locale="zh")
    _check("zh 'analyze case 12...' → case_analyze",
           r["command"] == "case_analyze",
           f"got {r['command']!r}")
    _check("zh case_id captured",
           r["case_display_id"] == "1234567890",
           f"got {r['case_display_id']!r}")


def test_nl_summarize_case_en():
    print("test_nl_summarize_case_en")
    payload = {
        "command": "case_analyze",
        "intent": "summarize case 9876543210",
        "case_display_id": "9876543210",
        "case_filter": "",
        "suggestions": [],
        "needs_diagnosis": False,
        "is_change_request": False,
    }
    with _patch_bedrock(payload):
        r = bedrock_intent.analyze_intent("summarize case 9876543210",
                                            locale="en")
    _check("en 'summarize case ...' → case_analyze",
           r["command"] == "case_analyze",
           f"got {r['command']!r}")


def test_nl_what_should_i_reply():
    """A user asking 'case xxx 应该回什么' / 'what should I reply to
    case xxx' is the classic case_analyze use case (they want LLM
    to draft a reply for them)."""
    print("test_nl_what_should_i_reply")
    payload = {
        "command": "case_analyze",
        "intent": "case 1234567890 应该回什么",
        "case_display_id": "1234567890",
        "case_filter": "",
        "suggestions": [],
        "needs_diagnosis": False,
        "is_change_request": False,
    }
    with _patch_bedrock(payload):
        r = bedrock_intent.analyze_intent(
            "帮我看下 case 1234567890 应该回什么", locale="zh")
    _check("'case xxx 应该回什么' → case_analyze",
           r["command"] == "case_analyze",
           f"got {r['command']!r}")
    _check("case_id captured",
           r["case_display_id"] == "1234567890")


def test_nl_analyze_without_id_falls_back():
    """If Bedrock returns case_analyze but no id (corner case — the
    classifier prompt explicitly forbids this, but defense-in-depth),
    we should fall back to case_list."""
    print("test_nl_analyze_without_id_falls_back")
    payload = {
        "command": "case_analyze",
        "intent": "analyze a case",
        "case_display_id": "",
        "case_filter": "",
        "suggestions": [],
        "needs_diagnosis": False,
        "is_change_request": False,
    }
    with _patch_bedrock(payload):
        r = bedrock_intent.analyze_intent("分析一个 case", locale="zh")
    _check("case_analyze without id → case_list",
           r["command"] == "case_list",
           f"got {r['command']!r}")


def test_aliases_normalize_to_case_analyze():
    """Bedrock occasionally produces alternate verbs (analyze_case /
    summarize_case / case_summary). The alias map must collapse them
    all to canonical `case_analyze`."""
    print("test_aliases_normalize_to_case_analyze")
    aliases_under_test = [
        "analyze_case",
        "case_analyse",
        "summarize_case",
        "case_summary",
        "summarise_case",
    ]
    for alias in aliases_under_test:
        payload = {
            "command": alias,
            "intent": f"alias-test {alias}",
            "case_display_id": "1234567890",
            "case_filter": "",
            "suggestions": [],
            "needs_diagnosis": False,
            "is_change_request": False,
        }
        with _patch_bedrock(payload):
            r = bedrock_intent.analyze_intent("test 1234567890", locale="en")
        _check(f"alias '{alias}' → case_analyze",
               r["command"] == "case_analyze",
               f"got {r['command']!r}")


def test_case_analyze_in_valid_commands():
    """Sanity check that the canonical command name is registered in
    VALID_COMMANDS — protects against typos in the constant itself."""
    print("test_case_analyze_in_valid_commands")
    _check("case_analyze in VALID_COMMANDS",
           "case_analyze" in bedrock_intent.VALID_COMMANDS)
    _check("case_analyze in _allowed_commands()",
           "case_analyze" in bedrock_intent._allowed_commands())


def main() -> int:
    test_slash_analyze_case_with_id()
    test_slash_analyze_no_id_falls_back_to_list()
    test_nl_analyze_zh_with_id()
    test_nl_summarize_case_en()
    test_nl_what_should_i_reply()
    test_nl_analyze_without_id_falls_back()
    test_aliases_normalize_to_case_analyze()
    test_case_analyze_in_valid_commands()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
