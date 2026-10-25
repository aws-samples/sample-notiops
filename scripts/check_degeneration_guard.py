#!/usr/bin/env python3
"""离线端到端检查:输出崩坏守卫(强制拦截,待办 #2)挂在**真实的** Strands 循环与 agent 入口上。

tests/test_agent_degeneration.py 用手写的事件(测试环境没有 strands),它证明不了:Strands 真流出来的
原始事件守卫认不认、模型流检查点抛的异常 Strands 是不是真的接住并重试(`AfterModelCallEvent.retry`)、
被判死那次的输出是不是真的没进 `agent.messages`、发给前端的书签 / 丢弃帧是不是对得上。这些会在
**升级 strands** 时静默变掉(守卫不报错,只是再也停不下、或者把乱码写进历史)。

这里跑部署版 `main.invoke` 原样(主题 `im-chat`),只换两样:模型 → 按脚本出事件的假模型;
文档服务的出网那一下(`_mcp_call`)→ 本地回包。四轮:
  ① 三次模型调用:第 1 次调 `aws_docs_read`,第 2 次的思考是 `-` 粘连的乱码 → 判死、Strands 重试,
     第 3 次正常作答。期望:1 行 glue / action=retry;书签 1·2·3 + 一个 discard(call=2, retry);
     按书签退回后的正文就是第 3 次的答案;历史里没有乱码;第 2 次调用被提前关掉、取消信号置位;
  ② 一次调用:思考写着写着变成无限重复的 ` @`,重试那次又是 → 2 行(retry、give_up)、2 个 discard,
     最后是「换一个模型」的说明(IM 版,`/model`),历史以这段说明收尾(交替补平),没有乱码;
  ③ 正常的思考 + 回答 → 0 行、0 个 discard,答案原样;
  ④ 守卫自己出错 → 本轮关掉,这一轮照常答完(乱码照常流出去 —— 等于没有守卫,不是把回答弄坏)。
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
_LOOP = _NORMAL_THINKING + " 让我" + " @" * 1500


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
    """每次模型调用按脚本吐一段:[("reasoning"|"text", 文字) | ("tool", 入参), …]。
    记下每次调用收到的取消信号、吐了几个 chunk、是不是被提前关掉。"""

    def __init__(self, calls):
        self.calls = list(calls)
        self.i = 0
        self.log = []          # 每次调用一条 {"cancel": 信号对象, "chunks": n, "finished": bool}

    def update_config(self, **kw):
        pass

    def get_config(self):
        return {"model_id": "scripted"}

    async def structured_output(self, *a, **k):  # pragma: no cover
        raise NotImplementedError
        yield

    def _script(self, call):
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

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kw):
        call = self.calls[self.i]
        self.i += 1
        rec = {"cancel": kw.get("cancel_signal"), "chunks": 0, "finished": False}
        self.log.append(rec)
        for chunk in self._script(call):
            rec["chunks"] += 1
            yield chunk
        rec["finished"] = True


class _Lines(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines = []

    def emit(self, record):
        msg = record.getMessage()
        if msg.startswith("degeneration guard"):
            self.lines.append(msg)


async def _turn(calls, prompt: str):
    """跑一轮 invoke,返回 (发给前端的事件, 这一轮的 agent, 假模型)。"""
    model = _ScriptedModel(calls)
    M.load_model = lambda key=None: model
    seen = []
    real_get = M.get_or_create_agent

    def capture(*a, **k):
        seen.append(real_get(*a, **k))
        return seen[-1]

    M.get_or_create_agent = capture
    ctx = types.SimpleNamespace(session_id=f"degeneration-check-{uuid.uuid4().hex[:8]}", user_id=None)
    payload = {"prompt": prompt, "topic": "im-chat", "now": "2026-10-14", "account_id": "",
               "web_search": False, "devops_agent": False, "finops_agent": False}
    try:
        with contextlib.redirect_stdout(io.StringIO()):   # Strands 默认回调会把正文打到 stdout
            events = [ev async for ev in M.invoke(payload, ctx)]
    finally:
        M.get_or_create_agent = real_get
    return events, (seen[-1] if seen else None), model


def _fields(line: str) -> dict:
    return dict(kv.split("=", 1) for kv in line.split(": ", 1)[1].split())


def _text_of(ev) -> str:
    if not isinstance(ev, dict) or "event" not in ev:
        return ""
    return (((ev.get("event") or {}).get("contentBlockDelta") or {}).get("delta") or {}).get("text") or ""


def _client_view(events):
    """像 BFF / IM 那样消费:按书签退回。返回 (最终正文, 书签序列, discard 列表, 被丢弃过的正文)。"""
    text, marks, starts, discards, dropped = "", {}, [], [], []
    for ev in events:
        if not isinstance(ev, dict):
            continue
        if isinstance(ev.get("call_start"), int):
            marks[ev["call_start"]] = len(text)
            starts.append(ev["call_start"])
        if isinstance(ev.get("discard"), dict):
            discards.append(ev["discard"])
            at = marks.get(ev["discard"].get("call"))
            if at is not None:
                dropped.append(text[at:])
                text = text[:at]
        text += _text_of(ev)
    return text, starts, discards, dropped


def _history_text(agent) -> str:
    out = []
    for m in getattr(agent, "messages", None) or []:
        for b in m.get("content") or []:
            if isinstance(b, dict):
                out.append(json.dumps(b, ensure_ascii=False, default=repr))
    return "\n".join(out)


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

    # ① 粘连乱码 → 判死 → Strands 重试 → 正常作答
    events, agent, model = await _turn([[("reasoning", _NORMAL_THINKING), ("tool", {"url": _URL})],
                                        [("reasoning", _GLUED * 3), ("text", _GLUED)],
                                        [("reasoning", "对照完了，写结论。"), ("text", _ANSWER)]], q)
    got = list(handler.lines)
    f = _fields(got[0]) if got else {}
    check(len(got) == 1 and (f.get("signal"), f.get("action"), f.get("call"), f.get("phase"))
          == ("glue", "retry", "2", "reasoning"), f"① one guard line: glue / retry / call 2 / reasoning: {got}")
    check(bool(got) and got[0].startswith("degeneration guard (enforced, model call stopped): ")
          and not re.search(r"[一-鿿]", got[0]), "① the line is key=value metadata only (no model text)")
    text, starts, discards, dropped = _client_view(events)
    check(starts == [1, 2, 3], f"① a bookmark per model call: {starts}")
    check(discards == [{"call": 2, "signal": "glue", "retry": True}], f"① one discard for call 2, retrying: {discards}")
    check(text == _ANSWER, "① after rewinding, the answer is exactly the retried call's answer")
    check(not any(_GLUED[:12] in _text_of(e) for e in events[events.index({"discard": discards[0]}) + 1:])
          if discards else False, "① nothing of the collapsed call reaches the client after the discard")
    check(any(isinstance(e.get("progress"), dict) and e["progress"].get("kind") == "status" for e in events
              if isinstance(e, dict)), "① the user is told (a status progress line), not silent")
    check(model.i == 3 and not model.log[1]["finished"] and model.log[1]["chunks"] < len(list(model._script(
        [("reasoning", _GLUED * 3), ("text", _GLUED)]))), f"① the collapsed call was cut short: {model.log}")
    check(getattr(model.log[1]["cancel"], "is_set", lambda: False)(),
          "① the cancel signal handed to the model is set (Bedrock's reader thread closes the HTTP stream on it)")
    hist = _history_text(agent)
    check(agent is not None and "勒-何" not in hist and "heads项目-panic" not in hist and "nodejs22.x" in hist,
          "① the collapsed output never entered agent.messages; the retried answer did")

    # ② 复读两次 → 放弃,回「换一个模型」
    handler.lines.clear()
    events, agent, model = await _turn([[("reasoning", _LOOP)], [("reasoning", _LOOP)]], q)
    got = [_fields(x) for x in handler.lines]
    check([(x.get("signal"), x.get("action"), x.get("call")) for x in got]
          == [("repeat", "retry", "1"), ("repeat", "give_up", "2")], f"② retry once, then give up: {got}")
    text, starts, discards, dropped = _client_view(events)
    want = M._collapse_failure_text(True, True)
    check([d.get("retry") for d in discards] == [True, False], f"② two discards: {discards}")
    check(text.strip() == want.strip() and "`/model`" in text and "继续" not in text,
          f"② the reply is the IM 'switch models' note, no 'reply continue': {text[:80]!r}")
    msgs = getattr(agent, "messages", None) or []
    last = msgs[-1] if msgs else {}
    last_text = "".join(b.get("text") or "" for b in last.get("content") or [] if isinstance(b, dict))
    check(last.get("role") == "assistant" and last_text == want.strip() and " @ @ @" not in _history_text(agent),
          f"② history ends with the note (alternation repaired), no garbage: {[m.get('role') for m in msgs]}")

    # ③ 正常一轮
    handler.lines.clear()
    events, agent, model = await _turn([[("reasoning", _NORMAL_THINKING), ("tool", {"url": _URL})],
                                        [("reasoning", "对照完了，写结论。"), ("text", _ANSWER)]], q)
    text, starts, discards, dropped = _client_view(events)
    check(handler.lines == [] and discards == [] and starts == [1, 2] and text == _ANSWER,
          f"③ a normal turn: no line, no discard, answer intact ({handler.lines}, {discards}, {starts})")

    # ④ 守卫自己出错 → 本轮关掉,照常答完
    handler.lines.clear()
    real_feed = M.DegenerationGuard.__init__.__globals__["CollapseDetector"].feed

    def boom(self, text, phase="text"):
        raise ValueError("payload must never reach the log")

    M.DegenerationGuard.__init__.__globals__["CollapseDetector"].feed = boom
    try:
        events, agent, model = await _turn([[("reasoning", _GLUED), ("text", _ANSWER)]], q)
    finally:
        M.DegenerationGuard.__init__.__globals__["CollapseDetector"].feed = real_feed
    text, starts, discards, dropped = _client_view(events)
    check(handler.lines == ["degeneration guard disabled for this turn: ValueError"] and discards == []
          and _ANSWER in text, f"④ a guard failure only switches it off; the turn completes: {handler.lines}")

    # ⑤ 真的 BedrockModel(读流在它自己的线程里):检查点一停,那个线程就关掉 HTTP 流、不再往下读。
    #    只关我们这边的 async generator 的话,线程会在后台把整段乱码读完 —— 照样计费。
    problems += await _check_bedrock_reader_stops(check)

    M.log.removeHandler(handler)
    return problems


async def _check_bedrock_reader_stops(check) -> list:
    import threading
    import time
    from degeneration import DegenerationGuard, OutputCollapsed, install_stream_stop
    from strands.models.bedrock import BedrockModel

    total = 4000

    class _FakeStream:
        def __init__(self):
            self.read = 0
            self.closed = threading.Event()

        def __iter__(self):
            yield {"messageStart": {"role": "assistant"}}
            yield {"contentBlockStart": {"start": {}, "contentBlockIndex": 0}}
            for _ in range(total):
                if self.closed.is_set():
                    return
                self.read += 1
                time.sleep(0.001)                 # 模型一个 token 一个 token 地吐
                yield {"contentBlockDelta": {"delta": {"reasoningContent": {"text": " @"}}, "contentBlockIndex": 0}}

        def close(self):
            self.closed.set()

    fake = _FakeStream()
    model = BedrockModel(model_id="global.moonshotai.kimi-k3")
    model.client.converse_stream = lambda **kw: {"stream": fake}
    guard = DegenerationGuard("q", log=logging.getLogger("degeneration-check"))
    assert install_stream_stop(model, lambda: guard)
    caught = None
    try:
        async for chunk in model.stream([{"role": "user", "content": [{"text": "q"}]}], None, None,
                                        cancel_signal=threading.Event()):
            guard.observe({"event": chunk})
    except OutputCollapsed as e:
        caught = e
    for _ in range(200):                          # 给读流线程一点时间走到下一个 chunk 边界
        if fake.closed.is_set():
            break
        await asyncio.sleep(0.01)
    read_at_stop = fake.read
    await asyncio.sleep(0.3)
    check(isinstance(caught, OutputCollapsed) and fake.closed.is_set() and fake.read == read_at_stop
          and fake.read < total // 2,
          f"⑤ real BedrockModel: reader thread closed the stream and stopped reading "
          f"(read {fake.read} of {total} chunks, closed={fake.closed.is_set()})")
    return []


def main() -> int:
    problems = asyncio.run(_run())
    print("OK" if not problems else f"FAILED: {len(problems)} check(s)")
    sys.stdout.flush()
    return 0 if not problems else 1


if __name__ == "__main__":
    code = main()
    os._exit(code)  # 不等 MCP / 线程池收尾
