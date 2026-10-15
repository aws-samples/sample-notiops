#!/usr/bin/env python3
"""离线端到端检查:输出崩坏守卫(影子模式)挂在**真实的** Strands 循环与 agent 入口上。

tests/test_agent_degeneration.py 用手写的事件(测试环境没有 strands),它证明不了:Strands 真流出来的
原始事件(messageStart / reasoningContent / text 增量)守卫认不认、主循环是不是真的把每个事件先给了它、
日志行是不是真的打出来、发给前端的事件流是不是一个字节都没变。这些会在**升级 strands** 时静默变掉
(守卫不报错,只是再也看不到正文)。

这里跑部署版 `main.invoke` 原样(主题 `im-chat`),只换两样:模型 → 按脚本出事件的假模型;
文档服务的出网那一下(`_mcp_call`)→ 本地回包。四轮:
  ① 两次模型调用:第 1 次调 `aws_docs_read`,第 2 次的思考是 `-` 粘连的乱码 → 期望 1 行 glue、call=2;
  ② 一次调用:思考写着写着变成无限重复的 ` @` → 期望 1 行 repeat、call=1;
  ③ 正常的思考 + 回答 → 0 行;
  ④ 把 ① 再跑一遍、守卫换成什么都不做的桩 → 发给前端的事件与 ① 逐个相同(影子模式不改行为)。
不联网、不碰 AWS(凭证在进程里换成假的)、不花 token。

跑法(需要 agent 的依赖 —— 按 agent-build/NotiOpsWebChat/agent-constraints.txt 装好的 Python 3.13 venv):
    <agent-venv>/bin/python scripts/check_degeneration_guard.py
通过 = 最后一行 `OK`,退出码 0;任何一条判据不成立 = 打印原因、退出码 1。
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import logging
import os
import re
import sys
import types
import uuid

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_APP = os.path.join(_ROOT, "agent-build", "NotiOpsWebChat", "app", "NotiOpsWebChat")
_URL = "https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html"

# 在 import main 之前:关掉一切会出网 / 起子进程的东西,凭证换成假的(真发出去也只会失败)。
for _k in ("AWS_PROFILE", "AWS_BEARER_TOKEN_BEDROCK", "AWS_SESSION_TOKEN"):
    os.environ.pop(_k, None)
os.environ.update({
    "AWS_ACCESS_KEY_ID": "testing", "AWS_SECRET_ACCESS_KEY": "testing",
    "AWS_CONFIG_FILE": os.devnull, "AWS_SHARED_CREDENTIALS_FILE": os.devnull,
    "AWS_EC2_METADATA_DISABLED": "true", "AWS_REGION": "us-east-1", "AWS_DEFAULT_REGION": "us-east-1",
    "LLMCFG_ENABLED": "0", "NOTIOPS_DISABLE_LAZY_MCP": "1", "NOTIOPS_DISABLE_AWS_API_MCP": "1",
})
sys.path.insert(0, _APP)

import main as M  # noqa: E402
from strands.models.model import Model  # noqa: E402

# 形状 1 的样子(与 degeneration.py 文件头那段示例同一种):中英碎片用 `-` 粘在一起,夹着假名。
_GLUED = ("aws 理想会均之大 PI 项目重庆( pilot safely还是会 with one.\n"
          "1位-Na li still-ish 带 以-ja 刷新 heads项目-panic twice: Por as IT out-3 can how 偏离-ip.\n"
          "- which the wasの是 网站-avar pan- mi u-'--c the a and as of -alc when a hidden the for--ts ")
_NORMAL_THINKING = ("用户问 us-east-1 的 Lambda 运行时哪些快要过期。我先读官方文档里的运行时弃用表，"
                    "再对照函数清单，列出命中的函数和弃用日期。")
_ANSWER = ("结论:没有已弃用的运行时;最接近的是 `nodejs22.x`(2027-04-30 弃用)。\n\n"
           "| 运行时 | 弃用日期 |\n|---|---|\n| `nodejs22.x` | 2027-04-30 |\n| `python3.12` | 2028-10-31 |\n")


def _envelope(start: int) -> dict:
    item = {"status": "SUCCESS", "url": _URL, "content": "Supported runtimes … " + "x" * 2000,
            "total_length": 2100, "start_index": start, "end_index": 2100, "truncated": False,
            "redirected_url": None, "error_code": None}
    return {"isError": False,
            "content": [{"type": "text", "text": json.dumps({"content": {"result": [item]}})}]}


def _fake_mcp_call(tool, arguments):
    assert tool == "read_documentation", tool
    return _envelope(int(arguments["requests"][0].get("start_index") or 0))


def _pieces(text: str, size: int = 7):
    return [text[i:i + size] for i in range(0, len(text), size)]


class _ScriptedModel(Model):
    """每次模型调用按脚本吐一段:[("reasoning"|"text", 文字) | ("tool", 入参), …]。"""

    def __init__(self, calls):
        self.calls = list(calls)
        self.i = 0

    def update_config(self, **kw):
        pass

    def get_config(self):
        return {"model_id": "scripted"}

    async def structured_output(self, *a, **k):  # pragma: no cover
        raise NotImplementedError
        yield

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kw):
        call = self.calls[self.i]
        self.i += 1
        yield {"messageStart": {"role": "assistant"}}
        stop = "end_turn"
        for idx, (kind, arg) in enumerate(call):
            if kind == "tool":
                stop = "tool_use"
                yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": f"tu{self.i}-{idx}",
                                                                   "name": "aws_docs_read"}},
                                             "contentBlockIndex": idx}}
                yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(arg)}},
                                             "contentBlockIndex": idx}}
            else:
                yield {"contentBlockStart": {"start": {}, "contentBlockIndex": idx}}
                for p in _pieces(arg):
                    delta = {"reasoningContent": {"text": p}} if kind == "reasoning" else {"text": p}
                    yield {"contentBlockDelta": {"delta": delta, "contentBlockIndex": idx}}
            yield {"contentBlockStop": {"contentBlockIndex": idx}}
        yield {"messageStop": {"stopReason": stop}}
        yield {"metadata": {"usage": {"inputTokens": 10, "outputTokens": 10, "totalTokens": 20},
                            "metrics": {"latencyMs": 1}}}


class _Lines(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        msg = record.getMessage()
        if msg.startswith("degeneration guard"):
            self.lines.append(msg)


class _NoopGuard:
    def __init__(self, *a, **k):
        pass

    def observe(self, event):
        pass


async def _turn(calls, prompt: str) -> list:
    M.load_model = lambda key=None: _ScriptedModel(calls)
    ctx = types.SimpleNamespace(session_id=f"degeneration-check-{uuid.uuid4().hex[:8]}", user_id=None)
    payload = {"prompt": prompt, "topic": "im-chat", "now": "2026-10-14", "account_id": "",
               "web_search": False, "devops_agent": False, "finops_agent": False}
    with contextlib.redirect_stdout(io.StringIO()):   # Strands 默认回调会把正文打到 stdout
        return [ev async for ev in M.invoke(payload, ctx)]


def _fields(line: str) -> dict:
    return dict(kv.split("=", 1) for kv in line.split(": ", 1)[1].split())


async def _run() -> list[str]:
    M._aws_docs._mcp_call = _fake_mcp_call
    handler = _Lines()
    M.log.addHandler(handler)
    problems = []

    def check(ok: bool, what: str):
        print(("  ok    " if ok else "  FAIL  ") + what)
        if not ok:
            problems.append(what)

    q = "us-east-1 的 Lambda 函数里，哪些用的是快要过期的运行时版本？"
    glued_turn = [[("reasoning", _NORMAL_THINKING), ("tool", {"url": _URL})],
                  [("reasoning", _GLUED * 3), ("text", _GLUED)]]
    first = await _turn(glued_turn, q)
    got = list(handler.lines)
    check(len(got) == 1, f"① glued reasoning: exactly one guard line (got {len(got)})")
    f = _fields(got[0]) if got else {}
    check((f.get("signal"), f.get("call"), f.get("phase")) == ("glue", "2", "reasoning"),
          f"① signal=glue on the 2nd model call, in the reasoning: {f}")
    check(bool(got) and re.fullmatch(r"degeneration guard \(shadow, no action taken\): (\w+=\S+ ?)+", got[0])
          and not re.search(r"[一-鿿]", got[0]), "① the line is key=value metadata only (no model text)")

    handler.lines.clear()
    await _turn([[("reasoning", _NORMAL_THINKING + " 让我" + " @" * 1500)]], q)
    got = list(handler.lines)
    f = _fields(got[0]) if got else {}
    check(len(got) == 1 and (f.get("signal"), f.get("call"), f.get("text_chars")) == ("repeat", "1", "0"),
          f"② ' @' loop: one repeat line on the 1st call, answer still empty: {got}")

    handler.lines.clear()
    await _turn([[("reasoning", _NORMAL_THINKING), ("tool", {"url": _URL})],
                 [("reasoning", "对照完了，写结论。"), ("text", _ANSWER)]], q)
    check(handler.lines == [], f"③ a normal turn logs nothing: {handler.lines}")

    real_guard = M.DegenerationGuard
    M.DegenerationGuard = _NoopGuard
    try:
        second = await _turn(glued_turn, q)
    finally:
        M.DegenerationGuard = real_guard

    def dump(evs):
        return [json.dumps(e, sort_keys=True, ensure_ascii=False, default=repr) for e in evs]

    a, b = dump(first), dump(second)
    diff = next((i for i, (x, y) in enumerate(zip(a, b)) if x != y), None)
    check(len(a) == len(b) and diff is None,
          f"④ events sent to the client are identical with and without the guard ({len(a)} vs {len(b)} events"
          + ("" if diff is None else f", first difference at #{diff}") + ")")
    answer = "".join(((e.get("event") or {}).get("contentBlockDelta") or {}).get("delta", {}).get("text", "")
                     for e in first if isinstance(e, dict) and "event" in e)
    check(_GLUED.strip()[:20] in answer, "④ the collapsed answer still streams to the client (shadow mode)")
    M.log.removeHandler(handler)
    return problems


def main() -> int:
    problems = asyncio.run(_run())
    print("OK" if not problems else f"FAILED: {len(problems)} check(s)")
    sys.stdout.flush()
    return 0 if not problems else 1


if __name__ == "__main__":
    code = main()
    os._exit(code)  # 不等 MCP / 线程池收尾
