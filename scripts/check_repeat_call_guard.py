#!/usr/bin/env python3
"""离线端到端检查:重复调用守卫 + `aws_docs_read` 翻页,走**真实的** Strands 循环与 agent 入口。

tests/test_agent_repeat_calls.py 与 tests/test_agent_docs_read_paging.py 用的是桩(测试环境没有
strands),它们证明不了「守卫真的挂上了 Strands」:`AfterToolCallEvent.result` 还能不能写、事件在
toolResult 进上下文**之前**还是之后触发、`hooks=[...]` 的鸭子类型还认不认 —— 这些只有真跑一遍才
知道,而它们会在**升级 strands** 时静默变掉(守卫不报错,只是不再生效)。

这里跑的是部署版 `main.invoke` 原样(主题 `im-chat`:真实 system prompt、真实 agent 工厂、真实
`per_turn` 滑动窗口、真实 `aws_docs_read`),只换掉两样:
  · 模型 → 按脚本出工具调用的假模型(同一 URL 读四次:第 2、4 次与第 1 次同参,第 3 次换 start_index);
  · 文档服务的出网那一下(`_mcp_call`)→ 托管 AWS Knowledge MCP 的真实回包形状(Lambda 运行时页)。
不联网、不碰 AWS(凭证在进程里换成假的)、不花 token。

跑法(需要 agent 的依赖 —— 按 agent-build/NotiOpsWebChat/agent-constraints.txt 装好的 Python 3.13 venv):
    <agent-venv>/bin/python scripts/check_repeat_call_guard.py
通过 = 最后一行 `OK`,退出码 0;任何一条判据不成立 = 打印原因、退出码 1。
"""
from __future__ import annotations

import asyncio
import json
import os
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

_TOC = ("Table of Contents:\n- Lambda Event Function runtimes (char 0-21325)\n"
        "  - Supported runtimes (char 2467-8354)\n  - Deprecated runtimes (char 17946-21325)\n\n")


def _envelope(start: int) -> dict:
    """托管 `read_documentation` 的回包形状(2026-10-14 实测抄的),按 start_index 回不同的段。"""
    end = min(start + 10000, 21326)
    item = {"status": "SUCCESS", "url": _URL, "content": _TOC + f"page chars {start}-{end} " + "x" * 9000,
            "total_length": 21326, "start_index": start, "end_index": end, "truncated": end < 21326,
            "redirected_url": None, "error_code": None}
    return {"isError": False,
            "content": [{"type": "text", "text": json.dumps({"content": {"result": [item]}})}]}


def _fake_mcp_call(tool, arguments):
    assert tool == "read_documentation", tool
    return _envelope(int(arguments["requests"][0].get("start_index") or 0))


_SCRIPT = [
    ("tool", {"url": _URL}),                         # 1:第一段(原样)
    ("tool", {"url": _URL}),                         # 2:与 1 同参同果 → 应换成提示
    ("tool", {"url": _URL, "start_index": 10000}),   # 3:换了 start_index → 原样
    ("tool", {"url": _URL}),                         # 4:又与 1 同参同果 → 应再换
    ("text", "done"),
]


class _ScriptedModel(Model):
    def __init__(self):
        self.i = 0

    def update_config(self, **kw):
        pass

    def get_config(self):
        return {"model_id": "scripted"}

    async def structured_output(self, *a, **k):  # pragma: no cover
        raise NotImplementedError
        yield

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kw):
        kind, arg = _SCRIPT[self.i]
        self.i += 1
        yield {"messageStart": {"role": "assistant"}}
        if kind == "tool":
            yield {"contentBlockStart": {"start": {"toolUse": {"toolUseId": f"tu{self.i}",
                                                               "name": "aws_docs_read"}}}}
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(arg)}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockStart": {"start": {}}}
            yield {"contentBlockDelta": {"delta": {"text": arg}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}
        yield {"metadata": {"usage": {"inputTokens": 1, "outputTokens": 1, "totalTokens": 2},
                            "metrics": {"latencyMs": 1}}}


async def _run() -> list[str]:
    M.load_model = lambda key=None: _ScriptedModel()
    M._aws_docs._mcp_call = _fake_mcp_call
    captured = {}
    _orig = M.get_or_create_agent

    def _capture(*a, **k):
        captured["agent"] = _orig(*a, **k)
        return captured["agent"]

    M.get_or_create_agent = _capture
    ctx = types.SimpleNamespace(session_id=f"repeat-guard-check-{uuid.uuid4().hex[:8]}", user_id=None)
    payload = {"prompt": "Which Lambda runtimes are about to be deprecated?", "topic": "im-chat", "now": "2026-10-14",
               "account_id": "", "web_search": False, "devops_agent": False, "finops_agent": False}
    events = [ev async for ev in M.invoke(payload, ctx)]

    results = {}
    for msg in captured["agent"].messages:
        for block in msg.get("content", []):
            tr = block.get("toolResult")
            if tr:
                results[tr["toolUseId"]] = (tr.get("status"), tr["content"][0].get("text", ""))
    problems = []
    # Strands 默认的回调会把流式正文直接打到 stdout(不带换行),先换一行再出判据。
    print()

    def check(ok: bool, what: str):
        print(("  ok    " if ok else "  FAIL  ") + what)
        if not ok:
            problems.append(what)

    check(set(results) == {"tu1", "tu2", "tu3", "tu4"}, f"four tool results in context: {sorted(results)}")
    first = json.loads(results.get("tu1", ("", "{}"))[1] or "{}")
    check(first.get("start_index") == 0 and first.get("next_start_index") == 10000
          and first.get("content", "").startswith("Table of Contents:"),
          "1st read: unwrapped page chunk with paging fields (next_start_index=10000)")
    for tid in ("tu2", "tu4"):
        status, text = results.get(tid, ("", ""))
        check(status == "success" and text.startswith("[Repeated call] `aws_docs_read`")
              and "start_index=10000" in text and len(text) < 600,
              f"{tid}: identical repeat replaced by the short note (status kept, next page named)")
    third = json.loads(results.get("tu3", ("", "{}"))[1] or "{}")
    check(third.get("start_index") == 10000 and third.get("end_index") == 20000,
          "3rd read (different start_index): the real next chunk, untouched")
    sources = [s for e in events if isinstance(e, dict) for s in e.get("sources", [])]
    check(any(s.get("detail") == _URL for s in sources), "Sources still carry the doc URL")
    answer = "".join(((e.get("event") or {}).get("contentBlockDelta") or {}).get("delta", {}).get("text", "")
                     for e in events if isinstance(e, dict) and "event" in e)
    check(answer.strip().endswith("done"), "the turn still finishes with the model's answer")
    return problems


def main() -> int:
    problems = asyncio.run(_run())
    print("OK" if not problems else f"FAILED: {len(problems)} check(s)")
    sys.stdout.flush()
    return 0 if not problems else 1


if __name__ == "__main__":
    code = main()
    os._exit(code)  # 不等 MCP / 线程池收尾
