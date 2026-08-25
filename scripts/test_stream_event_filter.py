"""流事件过滤测试 —— 「模型的加密思考链不得变成回答正文」。

实测事故（Grok，一句"你好"）：回答开头出现一坨
    {'event': {'contentBlockDelta': {'delta': {'reasoningContent':
     {'redactedContent': b'rsn_jQzy…'}}, 'contentBlockIndex': 0}}}你好！我是 NotiOps…

链条（三段，缺一不成）：
  ① agent 把 Strands 的**原始 chunk** 原样 yield 出去。该 chunk 是
     reasoningContent.redactedContent = **bytes**（Grok 的思考链由 provider 加密；
     Sonnet 的思考链是明文 text，不带 bytes —— 所以同一份代码在 Sonnet 上看不出问题，
     这也是它长期没被发现的原因）。
  ② AgentCore runtime 序列化该事件：json.dumps 抛 TypeError → 兜底
     `json.dumps(str(obj))` → 整个事件的 **Python repr** 成了一个合法 JSON 字符串。
  ③ BFF 见到字符串事件就当正文 → repr 进了用户的回答。

本测试钉住 ① 与 ③ 的判据（③ 的 JS 侧另有 bff/web-chat/tests/agentcore.test.mjs）：
  * bytes 事件必须被丢弃（含未来任何新的带二进制的 chunk —— 兜底靠递归扫描，
    不靠"认识 redactedContent 这个名字"）。
  * 明文思考链仍要发（{reasoning}），否则前端折叠灰字功能被一起改坏。
  * 正文增量必须原样通过。
  * **两处 stream 循环（主循环 + 寒暄快路径）必须共用同一个出口** —— 原 bug 的成因
    就是快路径自己写了一遍过滤、漏了 reasoning 分支。这条断言防它再次分叉。

不导入 main.py（它要 strands / bedrock_agentcore 等重依赖）：用 ast 把被测函数
单独抽出来 exec，因此测的是**真实源码**而非复制品。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_stream_event_filter.py
"""
from __future__ import annotations

import ast
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WEBCHAT = os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app", "NotiOpsWebChat", "main.py")
AUTHORITATIVE = os.path.join(ROOT, "agent", "main.py")

PASS, FAIL = "✅", "❌"
_failed = 0


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


class _StubLog:
    def __init__(self) -> None:
        self.warnings: list[str] = []

    def warning(self, msg, *a):  # noqa: D102
        self.warnings.append(str(msg) % a if a else str(msg))

    def info(self, *a, **k):  # noqa: D102
        pass


def _load_funcs(path: str, names: list[str]) -> dict:
    """把指定顶层函数从源码里抽出来 exec 到一个隔离命名空间。"""
    tree = ast.parse(open(path, encoding="utf-8").read())
    picked = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names]
    missing = set(names) - {n.name for n in picked}
    if missing:
        raise AssertionError(f"{os.path.relpath(path, ROOT)} 缺少函数: {sorted(missing)}")
    ns: dict = {
        "log": _StubLog(),
        # 进度行文案：两份源码签名不同（web chat 一个参数、权威副本两个），都给个宽松替身。
        "_progress_for_tool": lambda name, *a: f"tool:{name}",
    }
    exec(compile(ast.Module(body=picked, type_ignores=[]), path, "exec"), ns)  # noqa: S102
    return ns


# 实测泄漏的那条事件（redactedContent 已截短；bytes 是关键，不是内容）。
GROK_REDACTED = {
    "event": {
        "contentBlockDelta": {
            "delta": {"reasoningContent": {"redactedContent": b"rsn_jQzyXZIFJLlpKyflYkCfvwIF"}},
            "contentBlockIndex": 0,
        }
    }
}
TEXT_DELTA = {"event": {"contentBlockDelta": {"delta": {"text": "你好！"}, "contentBlockIndex": 0}}}
REASONING_TEXT = {"event": {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "先想一下"}},
                                                  "contentBlockIndex": 0}}}
REASONING_SIG = {"event": {"contentBlockDelta": {"delta": {"reasoningContent": {"signature": "abc"}},
                                                 "contentBlockIndex": 0}}}
TOOL_START = {"event": {"contentBlockStart": {"start": {"toolUse": {"name": "aws_docs_search"}}}}}
# Strands 自有事件（无外层 "event"）。ReasoningRedactedContentStreamEvent 同样带 bytes。
STRANDS_REDACTED = {"reasoningRedactedContent": b"rsn_xx", "delta": {}, "reasoning": True}


def _identity_scrubber():
    class _S:
        def feed(self, t):
            return t

        def flush(self):
            return ""
    return _S()


def _run(ns: dict, event, *, en: bool = False):
    """两份源码的 _stream_events 第二参不同（scrubber / en 标志），按需喂。"""
    import inspect
    params = list(inspect.signature(ns["_stream_events"]).parameters)
    second = _identity_scrubber() if params[1] == "scrubber" else en
    return ns["_stream_events"](event, second)


def _suite(label: str, path: str, names: list[str]) -> None:
    print(f"\n{label}  ({os.path.relpath(path, ROOT)})")
    ns = _load_funcs(path, names)

    # —— 事故本体 ——
    out = _run(ns, GROK_REDACTED)
    _check("Grok 加密思考链事件被丢弃（不进正文）", out == [], repr(out)[:160])

    # —— 兜底：换个形状、换个键名的 bytes 一样拦住 ——
    for shape in (
        {"event": {"contentBlockDelta": {"delta": {"someNewBinaryThing": b"\x00\x01"}}}},
        {"event": {"metadata": {"trace": {"blob": bytearray(b"xx")}}}},
        {"event": {"contentBlockDelta": {"delta": {"parts": [{"blob": b"y"}]}}}},
    ):
        out = _run(ns, shape)
        _check(f"未知形状的 bytes 事件也被丢弃 {list(shape['event'])[0]}", out == [], repr(out)[:160])

    _check("_event_has_bytes 认得 bytes/bytearray/memoryview",
           all(ns["_event_has_bytes"](x) for x in (b"a", bytearray(b"a"), memoryview(b"a"),
                                                   {"a": [{"b": b"c"}]})))
    _check("_event_has_bytes 不误伤纯文本事件",
           not ns["_event_has_bytes"](TEXT_DELTA) and not ns["_event_has_bytes"]({"a": "b", "n": 1}))

    # —— 不能因为修 bug 把正常功能一起关掉 ——
    out = _run(ns, TEXT_DELTA)
    _check("正文增量原样通过", len(out) == 1 and out[0]["event"]["contentBlockDelta"]["delta"]["text"] == "你好！",
           repr(out)[:160])
    out = _run(ns, REASONING_TEXT)
    _check("明文思考链仍发 {reasoning}", out == [{"reasoning": {"text": "先想一下"}}], repr(out)[:160])
    out = _run(ns, REASONING_SIG)
    _check("思考链 signature 不外发（对用户无意义）", out == [], repr(out)[:160])
    out = _run(ns, TOOL_START)
    _check("工具开始 → 一条 progress，且不转发 contentBlockStart 本身",
           len(out) == 1 and "progress" in out[0], repr(out)[:160])
    out = _run(ns, {"event": {"contentBlockStart": {"start": {}}}})
    _check("无 toolUse 的 contentBlockStart 不产生事件", out == [], repr(out)[:160])

    # —— Strands 自有事件不外发（其中也有带 bytes 的） ——
    for ev in (STRANDS_REDACTED, {"init_event_loop": True}, {"data": "dup", "delta": {"text": "dup"}}):
        out = _run(ns, ev)
        _check(f"Strands 自有事件不外发 {sorted(ev)[0]}", out == [], repr(out)[:160])

    out = _run(ns, "not a dict")
    _check("非 dict 事件不外发", out == [], repr(out)[:160])


def _check_single_exit() -> None:
    """两处 stream 循环必须都走 _stream_events —— 原 bug 就是快路径自己写了一遍过滤。"""
    print("\n唯一出口（防快路径再次分叉）")
    src = open(WEBCHAT, encoding="utf-8").read()
    _check("主循环与寒暄快路径都调用 _stream_events", src.count("_stream_events(event,") >= 2,
           f"count={src.count('_stream_events(event,')}")
    # 快路径那段（greet_agent.stream_async 之后的若干行）里不得再出现自己的事件过滤。
    i = src.find("greet_agent.stream_async")
    _check("快路径不再自行判 reasoningContent / 自行 _scrub_event_text",
           i > 0 and "reasoningContent" not in src[i:i + 900] and "_scrub_event_text" not in src[i:i + 900])
    for path in (WEBCHAT, AUTHORITATIVE):
        s = open(path, encoding="utf-8").read()
        # 裸 `yield event`（不经过滤）是这个 bug 的形状本身。
        _check(f"{os.path.relpath(path, ROOT)} 没有裸 yield event",
               "\n        yield event\n" not in s and "\n            yield event\n" not in s)


print("=" * 72)
print("stream 事件过滤 —— 加密思考链不得泄漏成正文")
print("=" * 72)
_suite("部署版 web chat agent", WEBCHAT, ["_event_has_bytes", "_stream_events", "_scrub_event_text"])
_suite("权威手写副本", AUTHORITATIVE, ["_event_has_bytes", "_stream_events"])
_check_single_exit()

print("=" * 72)
if _failed:
    print(f"{FAIL} {_failed} 项失败")
    sys.exit(1)
print("✅ 全部通过")
