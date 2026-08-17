"""
Smoke test for the DingTalk Lambda sender (`lambda/dingtalk_sender.py`).

Verifies the contract that `lambda/devops_agent_report_handler.py`
relies on:

  * `is_configured()` reflects whether the env carries the custom-bot
    webhook URL.
  * `send_report` POSTs a markdown payload to the webhook URL with
    the expected fields (msgtype="markdown", title, link bullet
    list, next-step bullets).
  * `send_push_headsup` does the same with the alert title.
  * The 加签 signature is appended to the URL when a secret is
    configured, omitted otherwise.
  * `reply_text` / `update_live_card` / `send_live_console_link` are
    no-ops that don't crash and don't network.

Run from repo root::

    PYTHONPATH=lambda python3 scripts/test_dingtalk_sender.py
"""
from __future__ import annotations

import os
import sys
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))
# `push_handler` / `dingtalk_sender` 已从 `lambda/` 搬到 `shared/report_delivery/`，
# 而这行路径没跟着改 —— 于是这三套测试一直 ModuleNotFoundError，也正因为一直是坏的
# 才没被加进 CI。修路径而不是继续豁免：它们覆盖的是钉钉推送与健康报告投递。
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..",
                                "shared", "report_delivery"))

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


def _import_sender():
    """Late-import after we set env so module-level reads see the
    test config. boto3 is not invoked because every code path that
    would call it is gated on env var presence."""
    if "dingtalk_sender" in sys.modules:
        del sys.modules["dingtalk_sender"]
    import dingtalk_sender as ds  # type: ignore
    return ds


def _mock_urlopen(captured: list):
    """Return a context-manager-style mock that captures the request
    and returns a successful DingTalk response."""
    class _FakeResponse:
        def __init__(self, body: bytes):
            self._body = body
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def read(self):
            return self._body

    def _open(req, timeout=None):
        captured.append({
            "url": req.full_url,
            "data": req.data.decode("utf-8") if req.data else "",
            "headers": dict(req.headers),
            "method": req.method,
        })
        return _FakeResponse(b'{"errcode":0,"errmsg":"ok"}')

    return _open


def test_is_configured():
    print("test_is_configured")
    os.environ.pop("DINGTALK_PUSH_WEBHOOK_URL", None)
    os.environ.pop("DINGTALK_PUSH_WEBHOOK_URL_ARN", None)
    ds = _import_sender()
    _check("not configured by default", not ds.is_configured())

    os.environ["DINGTALK_PUSH_WEBHOOK_URL"] = "https://example/webhook?access_token=t"
    ds = _import_sender()
    _check("configured when URL set", ds.is_configured())


def test_send_report_posts_markdown():
    print("test_send_report_posts_markdown")
    os.environ["DINGTALK_PUSH_WEBHOOK_URL"] = "https://example/webhook?access_token=t"
    os.environ.pop("DINGTALK_PUSH_WEBHOOK_SECRET", None)
    os.environ.pop("DINGTALK_PUSH_WEBHOOK_SECRET_ARN", None)
    ds = _import_sender()
    captured: list = []
    with mock.patch("dingtalk_sender.urllib.request.urlopen",
                     side_effect=_mock_urlopen(captured)):
        ds.send_report(
            chat_id="cid_test", root_message_id="msg_test",
            status="COMPLETED", priority="P3",
            detail_type="EC2 CPU investigation",
            task_id="t_abcdef123456",
            summary_md="### Root cause\n- CPU bound nginx",
            html_url="https://example/r.html",
            trace_url="https://example/trace",
            console_url="https://console.example",
            next_steps=[
                {"label": "Check ALB", "url": "dispatch://alb"},
                {"label": "Look at RDS slow queries", "url": ""},
            ],
            locale="en",
        )
    _check("exactly one POST", len(captured) == 1, f"got {len(captured)}")
    if captured:
        req = captured[0]
        _check("URL is the bare webhook (no signature without secret)",
               req["url"] == "https://example/webhook?access_token=t",
               req["url"])
        import json as _j
        body = _j.loads(req["data"])
        _check("msgtype=markdown", body.get("msgtype") == "markdown")
        _check("title contains COMPLETED",
               "COMPLETED" in body["markdown"]["title"])
        text = body["markdown"]["text"]
        _check("body has summary",
               "Root cause" in text and "CPU bound" in text)
        _check("body has Full report link", "Full report" in text)
        _check("body has Trace link",       "Trace" in text)
        _check("body has Console link",     "Console" in text)
        _check("body has next-step",        "Check ALB" in text)


def test_send_report_signed_when_secret_set():
    print("test_send_report_signed_when_secret_set")
    os.environ["DINGTALK_PUSH_WEBHOOK_URL"] = "https://example/webhook?access_token=t"
    os.environ["DINGTALK_PUSH_WEBHOOK_SECRET"] = "S" * 32
    ds = _import_sender()
    captured: list = []
    with mock.patch("dingtalk_sender.urllib.request.urlopen",
                     side_effect=_mock_urlopen(captured)):
        ds.send_report(
            chat_id="cid", root_message_id="m",
            status="COMPLETED", priority="P4",
            detail_type="x", task_id="ta",
            summary_md="ok", html_url="", trace_url="", locale="zh",
        )
    if captured:
        url = captured[0]["url"]
        _check("URL contains timestamp= when signed",
               "&timestamp=" in url, url)
        _check("URL contains sign= when signed",
               "&sign=" in url, url)


def test_send_push_headsup_posts_alert():
    print("test_send_push_headsup_posts_alert")
    os.environ["DINGTALK_PUSH_WEBHOOK_URL"] = "https://example/webhook?access_token=t"
    os.environ.pop("DINGTALK_PUSH_WEBHOOK_SECRET", None)
    ds = _import_sender()
    captured: list = []
    with mock.patch("dingtalk_sender.urllib.request.urlopen",
                     side_effect=_mock_urlopen(captured)):
        ds.send_push_headsup(
            chat_id="cid",
            event={"title": "high-cpu-prod-rds", "detail_str": "ALARM 98.5"},
            locale="en",
        )
    _check("one POST emitted", len(captured) == 1)
    if captured:
        import json as _j
        body = _j.loads(captured[0]["data"])
        _check("alert msgtype markdown",
               body.get("msgtype") == "markdown")
        _check("alert title carried",
               "high-cpu-prod-rds" in body["markdown"]["title"])
        _check("alert text has ⚠️ + detail",
               "⚠️" in body["markdown"]["text"]
               and "ALARM 98.5" in body["markdown"]["text"])


def test_reply_text_is_noop():
    print("test_reply_text_is_noop")
    os.environ["DINGTALK_PUSH_WEBHOOK_URL"] = "https://example/webhook"
    ds = _import_sender()
    with mock.patch("dingtalk_sender.urllib.request.urlopen",
                     side_effect=AssertionError(
                         "reply_text must NOT hit the network")):
        ds.reply_text("parent_msg_id", "trivial error")
    _check("reply_text does not network", True)


def test_unconfigured_skips_silently():
    print("test_unconfigured_skips_silently")
    os.environ.pop("DINGTALK_PUSH_WEBHOOK_URL", None)
    os.environ.pop("DINGTALK_PUSH_WEBHOOK_URL_ARN", None)
    ds = _import_sender()
    with mock.patch("dingtalk_sender.urllib.request.urlopen",
                     side_effect=AssertionError(
                         "must NOT network when unconfigured")):
        ds.send_report(
            chat_id="cid", root_message_id="m",
            status="COMPLETED", priority="P4",
            detail_type="x", task_id="ta",
            summary_md="ok", html_url="", trace_url="", locale="en",
        )
        ds.send_push_headsup(chat_id="cid",
                              event={"title": "t"},
                              locale="en")
    _check("send_report skips silently when URL missing", True)
    _check("send_push_headsup skips silently when URL missing", True)


def test_live_card_paths_are_stubs():
    print("test_live_card_paths_are_stubs")
    os.environ["DINGTALK_PUSH_WEBHOOK_URL"] = "https://example/webhook"
    ds = _import_sender()
    msg_ref = ds.send_live_console_link(
        chat_id="cid", root_message_id="m",
        console_url="https://console.example", locale="en")
    _check("send_live_console_link returns dict", isinstance(msg_ref, dict))
    _check("send_live_console_link returns empty (Phase 2c stub)",
           msg_ref == {})
    # update_live_card with empty ref should be a quiet no-op
    ds.update_live_card({}, mock.MagicMock(), locale="en")
    _check("update_live_card empty noop", True)


def main() -> int:
    test_is_configured()
    test_send_report_posts_markdown()
    test_send_report_signed_when_secret_set()
    test_send_push_headsup_posts_alert()
    test_reply_text_is_noop()
    test_unconfigured_skips_silently()
    test_live_card_paths_are_stubs()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
