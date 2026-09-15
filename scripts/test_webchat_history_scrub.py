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


def _roles(msgs):
    return [m["role"] for m in msgs]


def _alternates(msgs):
    """Bedrock Converse 的三条硬要求：首条 user、末条 assistant、严格交替。"""
    if not msgs:
        return True
    return (msgs[0]["role"] == "user" and msgs[-1]["role"] == "assistant"
            and all(msgs[i]["role"] != msgs[i - 1]["role"] for i in range(1, len(msgs))))


def _nonempty_text(msgs):
    """占位块必须非空（Bedrock 拒绝空 text）。"""
    for m in msgs:
        for b in m.get("content") or []:
            if isinstance(b, dict) and "text" in b and not str(b["text"]).strip():
                return False
    return True


def test_trailing_user_is_repaired():
    """现网故障的正主：一次模型失败让历史停在 user，下一轮再 append 一条 user 就是
    连续同角色 → 每一轮都 ValidationException。此刻**还不是**重复，所以只修「已出现的
    连续同角色」不够，必须把结尾也补平。"""
    print("test_trailing_user_is_repaired")
    msgs = [{"role": "user", "content": [{"text": "q1"}]},
            {"role": "assistant", "content": [{"text": "a1"}]},
            {"role": "user", "content": [{"text": "q2"}]}]
    n = hs.repair_role_alternation(msgs)
    _check("one repair applied", n == 1, f"n={n}")
    _check("tail is now assistant", _roles(msgs) == ["user", "assistant", "user", "assistant"],
           str(_roles(msgs)))
    _check("placeholder text is non-empty", _nonempty_text(msgs))
    _check("second pass is a no-op (idempotent)", hs.repair_role_alternation(msgs) == 0)


def test_consecutive_same_role_is_repaired():
    """已经坏在 AgentCore Memory 里的老会话（连续 N 条 user）也要能救回来。"""
    print("test_consecutive_same_role_is_repaired")
    for label, msgs in (
        ("user,user", [{"role": "user", "content": [{"text": "q1"}]},
                       {"role": "assistant", "content": [{"text": "a1"}]},
                       {"role": "user", "content": [{"text": "q2"}]},
                       {"role": "user", "content": [{"text": "q3"}]}]),
        ("user x3", [{"role": "user", "content": [{"text": f"q{i}"}]} for i in range(3)]),
        ("assistant first", [{"role": "assistant", "content": [{"text": "a0"}]},
                             {"role": "user", "content": [{"text": "q1"}]},
                             {"role": "assistant", "content": [{"text": "a1"}]}]),
    ):
        hs.repair_role_alternation(msgs)
        _check(f"{label} → strict alternation", _alternates(msgs), str(_roles(msgs)))


def test_dangling_tool_blocks_are_dropped():
    """同一次中途失败也会留下单边的 toolUse / toolResult。Bedrock 对这两种同样报
    ValidationException，而且**补占位文本救不了**（它要的是配对的 toolResult）——
    只能把悬空的块摘掉。配好对的必须原样留下。"""
    print("test_dangling_tool_blocks_are_dropped")
    tool_use = {"toolUse": {"toolUseId": "t1", "name": "rds_list_instances", "input": {}}}
    dangling = [{"role": "user", "content": [{"text": "q"}]},
                {"role": "assistant", "content": [tool_use]},
                {"role": "user", "content": [{"text": "q2"}]}]
    hs.repair_role_alternation(dangling)
    _check("dangling toolUse dropped",
           not any("toolUse" in b for m in dangling for b in m["content"]))
    _check("alternation held", _alternates(dangling), str(_roles(dangling)))
    _check("emptied message got a non-empty placeholder", _nonempty_text(dangling))

    orphan = [{"role": "user", "content": [{"text": "q"}]},
              {"role": "assistant", "content": [{"text": "a"}]},
              {"role": "user", "content": [{"toolResult": {"toolUseId": "zz",
                                                          "content": [{"text": "o"}]}}]}]
    hs.repair_role_alternation(orphan)
    _check("orphan toolResult dropped",
           not any("toolResult" in b for m in orphan for b in m["content"]))

    paired = [{"role": "user", "content": [{"text": "q"}]},
              {"role": "assistant", "content": [dict(tool_use)]},
              {"role": "user", "content": [{"toolResult": {"toolUseId": "t1",
                                                           "content": [{"text": "ok"}]}}]},
              {"role": "assistant", "content": [{"text": "a1"}]}]
    n = hs.repair_role_alternation(paired)
    _check("a valid toolUse/toolResult pair is left completely alone", n == 0, f"n={n}")


def test_repair_tolerates_malformed_input():
    """和清洗同理：历史来自外部存储，修复绝不能成为新的崩溃点。"""
    print("test_repair_tolerates_malformed_input")
    for bad in (None, [], {}, "nope", [None], ["x"], [{"role": "user"}],
                [{"role": "user", "content": None}], [{"role": "tool", "content": []}],
                [{"role": "user", "content": ["raw string block"]}]):
        try:
            hs.repair_role_alternation(bad)
            _check(f"tolerates {type(bad).__name__} {str(bad)[:28]}", True)
        except Exception as e:  # noqa: BLE001 — 这就是本测试要抓的
            _check(f"tolerates {str(bad)[:28]}", False, f"{type(e).__name__}: {e}")


def test_both_halves_of_the_poisoning_fix_are_wired():
    """修复必须是**两半**：写入端（模型失败分支补一条 assistant，新会话不被写坏）+
    读取端（restore 时修交替，救已经坏掉的老会话）。少任何一半，客户那边都还是死会话。"""
    print("test_both_halves_of_the_poisoning_fix_are_wired")
    m = re.search(r"def _build\(restore: bool\):(.*?)\n        def _build_with_restore_fallback",
                  SRC, re.S)
    _check("_build body located", m is not None)
    if m:
        body = m.group(1)
        _check("read half: repair_role_alternation called in the restore branch",
               "repair_role_alternation" in body)
        _check("read half: repair runs after the scrub",
               body.index("scrub_cross_model_history") < body.index("repair_role_alternation"))
    # 写入端：模型失败分支必须在 yield 降级文案之后把结尾补成 assistant。
    err = re.search(r"except _MODEL_CALL_ERRORS as e:(.*?)\n    # 流结束", SRC, re.S)
    _check("model-failure branch located", err is not None)
    if err:
        b = err.group(1)
        _check("write half: appends an assistant message", '"role": "assistant"' in b)
        _check("write half: only when the tail is a user message", '"role") == "user"' in b)
        _check("write half: reuses the degraded text it just sent the user", "_msg.strip()" in b)
        _check("write half: cannot mask the answer already streamed out",
               b.index("yield {\"event\"") < b.index('"role": "assistant"'))


def test_model_failure_is_split_into_three_tiers():
    """把「重试通常就好」发给 AccessDenied 是把新客户送进无限循环 —— 权限/未开通、
    历史坏了、真的临时故障，是三种病、三种下一步。"""
    print("test_model_failure_is_split_into_three_tiers")
    err = re.search(r"except _MODEL_CALL_ERRORS as e:(.*?)\n    # 流结束", SRC, re.S)
    _check("model-failure branch located", err is not None)
    if not err:
        return
    b = err.group(1)
    _check("tier: timeout", "_MODEL_TIMEOUT_ERRORS" in b)
    _check("tier: access denied / model not enabled",
           'startswith("AccessDenied")' in b and "ResourceNotFoundException" in b)
    _check("tier: ValidationException", '_what == "ValidationException"' in b)
    _check("access-denied copy says retrying will not help",
           "重试不会好转" in b and "Retrying will not help" in b)
    _check("access-denied copy names Model access", "Model access" in b)
    _check("access-denied copy names the invoke permissions",
           "bedrock:InvokeModelWithResponseStream" in b)
    _check("validation copy tells the user to start a new conversation",
           "新建一个对话" in b and "Start a new conversation" in b)
    # 「直接再发一次」这句只许出现在真的临时故障那一档（注释里提到「重试通常就好」
    # 不算 —— 所以这里钉的是那一行**文案本身**，不是关键词）。
    _check("transient copy is the only one telling the user to just resend",
           b.count("1. 直接再发一次") == 1, f"count={b.count('1. 直接再发一次')}")


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
    test_trailing_user_is_repaired()
    test_consecutive_same_role_is_repaired()
    test_dangling_tool_blocks_are_dropped()
    test_repair_tolerates_malformed_input()
    test_both_halves_of_the_poisoning_fix_are_wired()
    test_model_failure_is_split_into_three_tiers()
    test_docstring_records_the_measured_matrix()
    print()
    if _failed:
        print(f"{FAIL} {_failed} check(s) failed")
        sys.exit(1)
    print(f"{PASS} all checks passed")
