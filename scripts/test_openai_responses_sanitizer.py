"""
Self-test for core/openai_responses_client._looks_like_protocol_leak
and the bad-JSON-arguments fallback path inside run_tool_use_loop.

Run from repo root::

    PYTHONPATH=. python scripts/test_openai_responses_sanitizer.py

No network. Exits non-zero on any failure.

Background: 2026-06-05 incident — GPT-5.4 emitted OpenAI ChatML
protocol fragments and Chinese SEO/gambling spam tokens to end users
after a function_call.arguments JSON value was truncated by an
implicit output-token cap. This test pins down the three defenses we
added so the regression can't sneak back in:

  A. _MAX_OUTPUT_TOKENS is set to a non-trivial cap on every Mantle
     request body
  B. run_tool_use_loop does NOT silently default args to {} on
     malformed JSON — it feeds the parse error back to the model
  C. extract_text refuses to surface output containing leaked protocol
     fragments or known spam tokens
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

from core import openai_responses_client as orc  # noqa: E402

PASS = "✅"
FAIL = "❌"

_failed = 0


def _check(label: str, ok: bool, detail: str = "") -> None:
    global _failed
    if ok:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


def test_protocol_fragments() -> None:
    print("test_protocol_fragments")
    leaks = [
        "to=functions.aws_docs_read",
        "Sure, I'll help you. to=functions.list_buckets {\"name\":\"x\"}",
        "<|start|>assistant<|message|>",
        "<|im_start|>user",
        "ok<|channel|>analysis",
    ]
    for s in leaks:
        _check(f"flag protocol fragment: {s[:40]!r}",
               orc._looks_like_protocol_leak(s))


def test_spam_tokens() -> None:
    print("test_spam_tokens")
    leaks = [
        "天天中彩票网_json",
        "大发快三计划",
        "六和彩 天天中彩",
        "请访问 红鼎彩票",
        "时时彩 strategy",
        # Real tokens observed in 2026-06-05 PM post-deploy validation
        # (a feishu DM where GPT-5.4 was asked "what is EKS"). These
        # are exactly what the user saw flash through before the audit
        # caught it; pin them down so a future regression cannot let
        # any of them slip past.
        "彩神争霸网站",
        "下载彩神争霸",
        "天天送彩金",
        "开号地址json",
    ]
    for s in leaks:
        _check(f"flag spam token: {s[:30]!r}",
               orc._looks_like_protocol_leak(s))


def test_truncated_json_line() -> None:
    print("test_truncated_json_line")
    # Stranded truncated JSON on its own line — what GPT leaked when
    # function_call.arguments got cut mid-string.
    leaks = [
        '{"query":"Amazon EKS 什么是 EKS 官方文档',
        '{"url":"https://docs.aws.amazon.com/eks/latest/',
    ]
    for s in leaks:
        _check(f"flag truncated JSON line: {s[:40]!r}",
               orc._looks_like_protocol_leak(s))


def test_clean_text_passes() -> None:
    print("test_clean_text_passes")
    # Real-looking AWS replies must NOT trip the sanitizer.
    safe = [
        "ALB works at OSI Layer 7. NLB works at Layer 4.",
        "EKS 是托管的 Kubernetes 服务,你可以参考官方文档。",
        # Code fence with valid JSON — full object on its own block,
        # multiple lines, terminating brace present. Still acceptable
        # because each individual line is either a brace or short.
        '```json\n{\n  "Bucket": "my-bucket"\n}\n```',
        "Use the `aws_docs_search` tool to find the right page.",
        "function_call_output is a Responses API concept.",
        "看 CloudWatch 指标的 evaluation period 是 60 秒。",
    ]
    for s in safe:
        _check(f"safe text passes: {s[:40]!r}",
               not orc._looks_like_protocol_leak(s))


def test_extract_text_redacts() -> None:
    print("test_extract_text_redacts")

    # All-blocks-leaked → still redact whole response.
    bad_response = {
        "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text",
                 "text": "to=functions.aws_docs_read 大发快三计划"},
            ]},
        ],
    }
    _check("extract_text returns '' when ALL blocks leak",
           orc.extract_text(bad_response) == "")

    # All clean → pass-through.
    good_response = {
        "output": [
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text",
                 "text": "ALB and NLB serve different layers."},
            ]},
        ],
    }
    _check("extract_text passes clean text through",
           orc.extract_text(good_response) ==
           "ALB and NLB serve different layers.")


def test_extract_text_keeps_clean_block_in_mixed_response() -> None:
    """The 2026-06-06 NLB-vs-ALB symptom: Mantle for GPT-5.x emits
    multiple output_text items, the FIRST few are leaked CoT
    fragments, the LAST one is the model's actual clean Chinese
    answer. Old behaviour discarded the whole thing. New behaviour:
    drop leaked items, keep the clean one."""
    print("test_extract_text_keeps_clean_block_in_mixed_response")
    mixed = {
        "output": [
            {"type": "reasoning", "summary": []},
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text",
                 "text": "to=functions.aws_docs_search  彩神争霸json\n"
                         '{"query":"NLB ALB"}'},
            ]},
            {"type": "reasoning", "summary": []},
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text",
                 "text": "to=functions.aws_docs_search 中国福利彩票"},
            ]},
            {"type": "reasoning", "summary": []},
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text",
                 "text": "**ALB**:Layer 7 路由,适合 HTTP/HTTPS。"
                         "\n**NLB**:Layer 4,适合高吞吐 TCP/UDP。"},
            ]},
        ],
    }
    out = orc.extract_text(mixed)
    _check("clean block surfaces from mixed response",
           "ALB" in out and "NLB" in out, f"got {out!r}")
    _check("no protocol fragment leaks through",
           "to=functions" not in out, f"got {out!r}")


def test_extract_text_streaming_dedupe() -> None:
    """When Mantle emits N clean blocks where each strictly extends
    the previous (streaming-replay), surface only the longest so
    the user sees the answer once, not 4 prefix-truncated copies.
    """
    print("test_extract_text_streaming_dedupe")
    streaming = {
        "output": [
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text",
                 "text": "Amazon EKS 是托管的"},
            ]},
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text",
                 "text": "Amazon EKS 是托管的 Kubernetes 服务"},
            ]},
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text",
                 "text": "Amazon EKS 是托管的 Kubernetes 服务,"
                         "可帮助你在 AWS 上运行容器。"},
            ]},
        ],
    }
    out = orc.extract_text(streaming)
    _check("streaming dedupe keeps longest only",
           out.count("Amazon EKS") == 1, f"got {out!r}")
    _check("longest content preserved",
           "运行容器" in out)


def test_max_output_tokens_set() -> None:
    """Regression guard for Fix A — every body we send to Mantle must
    declare an output cap large enough for a tool-use turn but
    bounded enough that a runaway can't burn $$$."""
    print("test_max_output_tokens_set")
    _check("constant defined and >= 4000",
           getattr(orc, "_MAX_OUTPUT_TOKENS", 0) >= 4000,
           f"got {getattr(orc, '_MAX_OUTPUT_TOKENS', None)}")

    sent: dict = {}

    def fake_send(body: dict, region: str) -> dict:
        sent.clear()
        sent.update(body)
        return {"id": "resp_test", "output": []}

    real_sender = getattr(orc, "_sign_and_send")
    setattr(orc, "_sign_and_send", fake_send)
    try:
        orc.call_responses(model_id="openai.gpt-5.4",
                           instructions="be helpful",
                           user_text="hi")
        _check("call_responses sends max_output_tokens",
               sent.get("max_output_tokens") == orc._MAX_OUTPUT_TOKENS,
               f"sent={sent.get('max_output_tokens')}")

        sent.clear()
        orc.call_with_tool_outputs(
            model_id="openai.gpt-5.4",
            previous_response_id="resp_prev",
            tool_outputs=[{"type": "function_call_output",
                           "call_id": "call_x", "output": "ok"}],
        )
        _check("call_with_tool_outputs sends max_output_tokens",
               sent.get("max_output_tokens") == orc._MAX_OUTPUT_TOKENS,
               f"sent={sent.get('max_output_tokens')}")
    finally:
        setattr(orc, "_sign_and_send", real_sender)


def test_parallel_tool_calls_disabled() -> None:
    """Regression guard for the 2026-06-06 leak — Bedrock Mantle does
    NOT translate the OpenAI internal `multi_tool_use.parallel`
    pseudo-tool into canonical `function_call` blocks. When
    `parallel_tool_calls` is enabled (the API default), the model
    can decide to batch 2+ tool invocations into a single
    multi_tool_use.parallel emission, and Mantle surfaces that raw
    ChatML protocol marker as `output_text` — exactly the
    `to=functions.multi_tool_use.parallel\\n{"tool_uses":[...]}`
    string our sanitizer has had to refuse repeatedly. The fix is
    to send `parallel_tool_calls: false` on EVERY body so the model
    is forced into single-tool-per-turn mode.
    """
    print("test_parallel_tool_calls_disabled")
    sent: dict = {}

    def fake_send(body: dict, region: str) -> dict:
        sent.clear()
        sent.update(body)
        return {"id": "resp_test", "output": []}

    real_sender = getattr(orc, "_sign_and_send")
    setattr(orc, "_sign_and_send", fake_send)
    try:
        orc.call_responses(model_id="openai.gpt-5.4",
                           instructions="be helpful",
                           user_text="hi")
        _check("call_responses sends parallel_tool_calls=False",
               sent.get("parallel_tool_calls") is False,
               f"sent={sent.get('parallel_tool_calls')!r}")

        sent.clear()
        orc.call_with_tool_outputs(
            model_id="openai.gpt-5.4",
            previous_response_id="resp_prev",
            tool_outputs=[{"type": "function_call_output",
                           "call_id": "call_x", "output": "ok"}],
        )
        _check("call_with_tool_outputs sends parallel_tool_calls=False",
               sent.get("parallel_tool_calls") is False,
               f"sent={sent.get('parallel_tool_calls')!r}")
    finally:
        setattr(orc, "_sign_and_send", real_sender)


def test_sanitizer_catches_multi_tool_use_parallel_leak() -> None:
    """Belt-and-suspenders: even if `parallel_tool_calls: false` is
    ever ignored upstream, the sanitizer must still recognize the
    `multi_tool_use.parallel` leak signature and refuse to surface
    it. The literal head observed in the 2026-06-06 incident."""
    print("test_sanitizer_catches_multi_tool_use_parallel_leak")
    leaked = ('to=functions.multi_tool_use.parallel\n'
              '{"tool_uses":[{"recipient_name":'
              '"functions.aws_pricing_get_pricing_attribute_values",'
              '"parameters":{"service_code":"AmazonEC2"}}]}')
    _check("sanitizer flags multi_tool_use.parallel leak",
           orc._looks_like_protocol_leak(leaked))


def test_sentinel_pushed_when_audit_redacts() -> None:
    """Regression guard for the 2026-06-05 PM addendum — when the
    sanitizer redacts the model's reply to "" we must mark the trace
    with `OUTPUT_BLOCKED_SENTINEL` so the bedrock_chat layer can
    surface the right message to the user instead of falling back to
    the same model and looping leaks."""
    print("test_sentinel_pushed_when_audit_redacts")

    # Loop reply 1: assistant message turn that contains a leaked
    # protocol fragment in `output_text`. Audit will redact this to ""
    # and the loop should terminate (no function_call).
    leaked_resp = {
        "id": "resp_leak",
        "output": [
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text",
                 "text": "to=functions.aws_docs_read 彩神争霸网站\n"
                         "{\"url\":\"https://docs.aws.amazon.com/eks/"},
            ]},
        ],
    }

    def fake_send(body: dict, region: str) -> dict:
        return leaked_resp

    real_sender = getattr(orc, "_sign_and_send")
    setattr(orc, "_sign_and_send", fake_send)
    try:
        text, citations, trace = orc.run_tool_use_loop(
            model_id="openai.gpt-5.4",
            instructions="be helpful",
            user_text="what is EKS",
            tools=[{"type": "function", "name": "aws_docs_search",
                    "description": "x", "parameters": {"type": "object"}}],
            tool_dispatch=lambda n, a: (True, "ok", []),
            max_iterations=3,
        )
    finally:
        setattr(orc, "_sign_and_send", real_sender)

    _check("redacted reply yields empty text",
           text == "", f"got {text!r}")
    _check("trace contains OUTPUT_BLOCKED_SENTINEL",
           any(t.get("name") == orc.OUTPUT_BLOCKED_SENTINEL for t in trace),
           f"trace={trace}")


def test_sentinel_NOT_pushed_when_clean() -> None:
    print("test_sentinel_NOT_pushed_when_clean")
    clean_resp = {
        "id": "resp_clean",
        "output": [
            {"type": "message", "role": "assistant", "content": [
                {"type": "output_text",
                 "text": "EKS is a managed Kubernetes service."},
            ]},
        ],
    }

    def fake_send(body: dict, region: str) -> dict:
        return clean_resp

    real_sender = getattr(orc, "_sign_and_send")
    setattr(orc, "_sign_and_send", fake_send)
    try:
        text, citations, trace = orc.run_tool_use_loop(
            model_id="openai.gpt-5.4",
            instructions="be helpful",
            user_text="what is EKS",
            tools=[],
            tool_dispatch=lambda n, a: (True, "ok", []),
            max_iterations=3,
        )
    finally:
        setattr(orc, "_sign_and_send", real_sender)

    _check("clean reply text passes through",
           text == "EKS is a managed Kubernetes service.")
    _check("clean reply trace has NO sentinel",
           all(t.get("name") != orc.OUTPUT_BLOCKED_SENTINEL for t in trace),
           f"trace={trace}")


def test_bad_json_args_dont_dispatch() -> None:
    """Regression guard for Fix B — when arguments JSON is unparseable
    we must NOT dispatch the tool with empty args. We must return an
    error string to the model so it can retry."""
    print("test_bad_json_args_dont_dispatch")

    dispatched: list = []

    def fake_dispatch(name: str, args: dict):
        dispatched.append((name, args))
        return True, "should not reach here", []

    # Two scripted server replies:
    #   1) an assistant turn that contains a single function_call with
    #      truncated arguments
    #   2) a message turn (no further tool calls) that finalizes
    replies = [
        {
            "id": "resp_1",
            "output": [
                {"type": "function_call",
                 "id": "fc_1", "call_id": "call_1",
                 "name": "aws_docs_search",
                 "arguments": '{"query":"Amazon EKS 什么是'},  # truncated
            ],
        },
        {
            "id": "resp_2",
            "output": [
                {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text",
                     "text": "I couldn't run that search — please retry."},
                ]},
            ],
        },
    ]
    call_idx = {"i": 0}

    def fake_send(body: dict, region: str) -> dict:
        i = call_idx["i"]
        call_idx["i"] += 1
        return replies[i]

    real_sender = getattr(orc, "_sign_and_send")
    setattr(orc, "_sign_and_send", fake_send)
    try:
        text, citations, trace = orc.run_tool_use_loop(
            model_id="openai.gpt-5.4",
            instructions="be helpful",
            user_text="what is EKS",
            tools=[{"type": "function", "name": "aws_docs_search",
                    "description": "x", "parameters": {"type": "object"}}],
            tool_dispatch=fake_dispatch,
            max_iterations=3,
        )
    finally:
        setattr(orc, "_sign_and_send", real_sender)

    _check("tool was NOT dispatched on bad args",
           dispatched == [], f"dispatched={dispatched}")
    _check("trace marks the bad call as not-ok",
           any(t.get("ok") is False
               and "invalid arguments" in (t.get("summary") or "").lower()
               for t in trace),
           f"trace={trace}")


def main() -> int:
    test_protocol_fragments()
    test_spam_tokens()
    test_truncated_json_line()
    test_clean_text_passes()
    test_extract_text_redacts()
    test_extract_text_keeps_clean_block_in_mixed_response()
    test_extract_text_streaming_dedupe()
    test_max_output_tokens_set()
    test_parallel_tool_calls_disabled()
    test_sanitizer_catches_multi_tool_use_parallel_leak()
    test_bad_json_args_dont_dispatch()
    test_sentinel_pushed_when_audit_redacts()
    test_sentinel_NOT_pushed_when_clean()

    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
