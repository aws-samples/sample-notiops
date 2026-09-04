"""跨模型历史清洗测试 —— 钉住「Claude / Grok / GLM 同会话可互换」这条性质。

对应现网故障（2026-09-01）：同一会话里 Sonnet 5 先答一轮，切 Grok 报
InternalServerException、切 GLM 报 ValidationException，切回 Sonnet 就好。根因是换模型
= 新建 Agent + 恢复**上一个模型**写下的历史，Claude 的 `reasoningContent` 回放给非
Anthropic 模型直接被 Bedrock 拒。修复见 core/history_scrub.py。

本测试**直接压真实现**（按文件路径加载，不导入 main.py —— 那会拉起 Strands 与 5 个 MCP
子进程），并在 main.py 源码上钉住三件调用现场的事：清洗只发生在 restore 分支、发生在
Agent 构造**之后**、且作用在 `.messages` 上。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_webchat_history_scrub.py
"""
from __future__ import annotations

import importlib.util
import os
import re
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP = os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app", "NotiOpsWebChat")
MAIN_PY = os.path.join(APP, "main.py")
SCRUB_PY = os.path.join(APP, "core", "history_scrub.py")

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


def _load(path: str, name: str):
    """按文件路径加载，避免与仓库根的同名 `core` 包撞车。"""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


SRC = open(MAIN_PY).read()
hs = _load(SCRUB_PY, "webchat_history_scrub")


def _claude_history():
    """Sonnet 5（adaptive thinking 常开）写进 AgentCore Memory 的典型历史形状。"""
    return [
        {"role": "user", "content": [{"text": "why is my ALB 5xx spiking"}]},
        {"role": "assistant", "content": [
            {"reasoningContent": {"reasoningText": {
                "text": "The user wants ALB diagnostics.",
                "signature": "ErUBCkYIBxgCKkD3anthropic-private-signature",
            }}},
            {"text": "Let me look at the target group health."},
            {"toolUse": {"toolUseId": "tu-1", "name": "aws_readonly",
                         "input": {"service": "elbv2", "op": "describe_target_health"}}},
        ]},
        {"role": "user", "content": [
            {"toolResult": {"toolUseId": "tu-1", "status": "success",
                            "content": [{"text": "2 of 4 targets unhealthy"}]}},
        ]},
        {"role": "assistant", "content": [
            {"reasoningContent": {"redactedContent": b"opaque-redacted-thinking-bytes"}},
            {"text": "Two targets are failing health checks."},
        ]},
    ]


def test_claude_reasoning_is_removed():
    print("test_claude_reasoning_is_removed")
    msgs = _claude_history()
    n = hs.scrub_cross_model_history(msgs)
    _check("removed both reasoningContent blocks", n == 2, f"n={n}")
    flat = [k for m in msgs for b in m["content"] for k in b]
    _check("no reasoningContent survives", "reasoningContent" not in flat, str(flat))
    # 洗掉思考块不许伤到 tool-use 配对 —— 否则历史整段作废。
    _check("toolUse kept", any("toolUse" in b for b in msgs[1]["content"]))
    _check("toolResult kept", any("toolResult" in b for b in msgs[2]["content"]))
    _check("assistant text kept", msgs[3]["content"][0]["text"].startswith("Two targets"))
    _check("role order untouched",
           [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant"])


def test_grok_reasoning_only_message_keeps_role_alternation():
    """Grok 会产**只有 reasoningContent** 的 assistant 消息（实测：content==['reasoningContent']）。

    洗完不能把这条消息删掉 —— 删了就出现 user, user 连续同角色，Bedrock Converse 400。
    必须补一个非空占位文本块。
    """
    print("test_grok_reasoning_only_message_keeps_role_alternation")
    msgs = [
        {"role": "user", "content": [{"text": "hi"}]},
        {"role": "assistant", "content": [
            {"reasoningContent": {"reasoningText": {"text": "brief", "signature": "grok-sig"}}},
        ]},
        {"role": "user", "content": [{"text": "still there?"}]},
    ]
    n = hs.scrub_cross_model_history(msgs)
    _check("removed the lone reasoning block", n == 1, f"n={n}")
    _check("message not dropped (roles still alternate)",
           [m["role"] for m in msgs] == ["user", "assistant", "user"],
           str([m["role"] for m in msgs]))
    body = msgs[1]["content"]
    _check("emptied message got exactly one placeholder block", len(body) == 1, str(body))
    _check("placeholder is a non-empty text block",
           bool(str(body[0].get("text") or "").strip()), str(body))
    _check("placeholder is ASCII (lint_i18n forbids CJK literals outside i18n)",
           body[0]["text"].isascii(), body[0]["text"])


def test_cachepoint_is_removed():
    """grok/glm 不支持显式 cachePoint（AccessDeniedException，实测）。防御性清理。"""
    print("test_cachepoint_is_removed")
    msgs = [
        {"role": "user", "content": [{"text": "long context"}, {"cachePoint": {"type": "default"}}]},
    ]
    n = hs.scrub_cross_model_history(msgs)
    _check("cachePoint removed", n == 1, f"n={n}")
    _check("sibling text kept", msgs[0]["content"] == [{"text": "long context"}], str(msgs[0]))


def test_empty_text_blocks_removed():
    print("test_empty_text_blocks_removed")
    msgs = [{"role": "assistant", "content": [{"text": "   "}, {"text": "real"}]}]
    n = hs.scrub_cross_model_history(msgs)
    _check("blank text block removed", n == 1, f"n={n}")
    _check("real text kept", msgs[0]["content"] == [{"text": "real"}], str(msgs[0]))


def test_clean_history_is_untouched():
    """没有可洗的东西时必须 0 改动 —— 免得每次恢复都白写一遍 content 列表。"""
    print("test_clean_history_is_untouched")
    msgs = [
        {"role": "user", "content": [{"text": "hello"}]},
        {"role": "assistant", "content": [{"text": "hi"}]},
    ]
    before = [m["content"] for m in msgs]
    n = hs.scrub_cross_model_history(msgs)
    _check("nothing dropped", n == 0, f"n={n}")
    _check("content lists are the same objects (no rewrite)",
           all(m["content"] is b for m, b in zip(msgs, before)))


def test_malformed_input_does_not_raise():
    """历史来自外部存储，形状不可信；清洗绝不能成为新的崩溃点。"""
    print("test_malformed_input_does_not_raise")
    for bad in (None, [], {}, "nope", [None], ["x"], [{"role": "user"}],
                [{"role": "user", "content": None}], [{"role": "user", "content": []}],
                [{"role": "user", "content": ["raw string block"]}]):
        try:
            hs.scrub_cross_model_history(bad)
            _check(f"tolerates {type(bad).__name__} {str(bad)[:28]}", True)
        except Exception as e:  # noqa: BLE001 — 这就是本测试要抓的
            _check(f"tolerates {str(bad)[:28]}", False, f"{type(e).__name__}: {e}")


def test_call_site_is_restore_only_and_after_construction():
    print("test_call_site_is_restore_only_and_after_construction")
    _check("main.py imports the shared implementation (no hand-copied logic)",
           "from core import history_scrub as _history_scrub" in SRC)
    m = re.search(r"def _build\(restore: bool\):(.*?)\n        def _build_with_restore_fallback",
                  SRC, re.S)
    _check("_build body located", m is not None)
    if not m:
        return
    body = m.group(1)
    _check("scrub is called inside _build", "scrub_cross_model_history" in body)
    _check("scrub is gated on restore", re.search(r"if restore:\s*\n\s*_n = _history_scrub", body)
           is not None, body[-400:])
    _check("scrub runs on .messages", ".messages)" in body)
    # 顺序：必须先构造（历史那时才被 session manager 恢复进来），再洗。
    _check("scrub happens after Agent(...) construction",
           body.index("Agent(") < body.index("scrub_cross_model_history"))
    _check("scrubbed agent is what gets returned", "return _agent" in body)


def test_docstring_records_the_measured_matrix():
    """判据不是「有注释」，而是「错误码这类**实测事实**写在代码里」——
    下一个人不必重跑一遍 Bedrock 才敢动这段。"""
    print("test_docstring_records_the_measured_matrix")
    doc = open(SCRUB_PY).read()
    for token in ("InternalServerException", "ValidationException", "AccessDeniedException",
                  "grok", "glm", "reasoningContent", "cachePoint"):
        _check(f"history_scrub.py documents {token}", token in doc)


if __name__ == "__main__":
    print("=== webchat cross-model history scrub ===")
    test_claude_reasoning_is_removed()
    test_grok_reasoning_only_message_keeps_role_alternation()
    test_cachepoint_is_removed()
    test_empty_text_blocks_removed()
    test_clean_history_is_untouched()
    test_malformed_input_does_not_raise()
    test_call_site_is_restore_only_and_after_construction()
    test_docstring_records_the_measured_matrix()
    print()
    if _failed:
        print(f"{FAIL} {_failed} check(s) failed")
        sys.exit(1)
    print(f"{PASS} all checks passed")
