"""同一轮里同一个工具、同样的参数、拿回逐字相同的结果 → 把这份重复的结果换成一句短提示。

## 现网现象（2026-10-14，NotiOpsWebChat v96 / Kimi K3）

中文问「us-east-1 的 Lambda 函数里，哪些用的是快要过期的运行时版本？」6 轮，**每一轮**都用同一个
URL 调 `aws_docs_read` 2–3 次，每次拿回逐字相同的 4,509 字（当时那个工具没法翻页，见 main.py 的
`aws_docs_read`）。其中 1 轮在第二次拿到相同结果之后输出崩成多语种乱码：约 3K 字乱码思考 + 55,845
字乱码正文，流了约 9.5 分钟直到 max_tokens（现网此前 14 天一次 max_tokens 都没有）。

翻页修好的是那一个工具。这里是对**所有**工具的兜底：同样的输入再喂给模型一遍同样的大块内容，
它得不到任何新东西，只会更想再调一次。换成一句「和你前面那次一模一样、还在上面，别再调了」，
既省 token，也把它从这个循环里推出来。

## 判据：四条同时成立才替换，否则原样放行

1. 同一轮（一次 invoke）里 —— 每轮开头 `reset()`；
2. 同一个工具、入参规范化后逐字相同；
3. 这次的结果与前一次**逐字节相同**。结果变了就是新信息（轮询状态变了、时间窗数据刷新了、
   上次失败这次成功了），一律原样给模型 —— 所以这里**不需要**工具白名单：`get_investigation_result`
   这种轮询工具，状态一变结果就不同，照常放行；
4. 前一次的 toolResult **还在上下文里、而且没被改过**。conversation manager 是 `per_turn=True`
   的滑动窗口（main.py `_make_conversation_manager`），长任务一轮中途就可能把它裁掉或截断 ——
   那时再读一遍是合理的，必须放行。

只换 `content`（一句提示；前一次结果带 `next_start_index` 时顺带给出续读写法），`toolUseId` /
`status` 原样保留。工具本身照常执行：这里只决定模型看到什么，不拦调用、不动任何副作用。

## 零依赖

同 thinking_steps.py / paragraphs.py：本模块住在 agent 部署树里，邻居 main.py 一进门就
`from strands import …`（测试环境没有）。所以这里**不 import strands**：Strands 的 `HookProvider`
是 `runtime_checkable` 的 Protocol，有 `register_hooks` 方法的对象就算数；要挂的两个事件类由
main.py 从 `strands.hooks` 取了传进来（`RepeatCallGuard(BeforeInvocationEvent, AfterToolCallEvent)`）。
只用公开 hook，不碰 Strands 内部。tests/test_agent_repeat_calls.py 按文件路径直接加载本模块。
`agent/repeat_calls.py` 是逐字节相同的副本（手写权威副本那个 agent 也挂它），测试会比对。
"""

from __future__ import annotations

import hashlib
import json
import logging

# 换进去的提示。英文：这是给模型看的工具返回，与 main.py 里其它工具提示同一口径（回答语言由 prompt 管）。
_NOTE = ("[Repeated call] `{tool}` was already called earlier in this turn with exactly these "
         "arguments and returned exactly this same result, which is still in the conversation "
         "above. Calling it again will not return anything new. Use that result, call the tool "
         "with different arguments, or finish your answer.")
_NEXT_PAGE = " To read further into the same page, call `{tool}` again with start_index={n}."


def _canon(obj) -> str:
    """稳定的 JSON 串：键排序、不转义非 ASCII；bytes 等非 JSON 值用 repr（只用来比对，不外发）。"""
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=repr)


def fingerprint(content) -> str:
    """toolResult `content` 的指纹。"""
    return hashlib.sha256(_canon(content).encode("utf-8")).hexdigest()


def _tool_result_in(messages, tool_use_id: str):
    """上下文里 `tool_use_id` 对应的 toolResult；找不到 = 已被滑动窗口裁掉。"""
    for msg in reversed(messages or []):
        if not isinstance(msg, dict):
            continue
        for block in msg.get("content") or []:
            tr = block.get("toolResult") if isinstance(block, dict) else None
            if isinstance(tr, dict) and tr.get("toolUseId") == tool_use_id:
                return tr
    return None


def _next_start_index(content):
    """结果里的 `next_start_index`（分页工具，如 aws_docs_read），没有就 None。"""
    for block in content or []:
        text = block.get("text") if isinstance(block, dict) else None
        if not isinstance(text, str) or '"next_start_index"' not in text:
            continue
        try:
            data = json.loads(text)
        except ValueError:
            continue
        n = data.get("next_start_index") if isinstance(data, dict) else None
        if isinstance(n, int) and not isinstance(n, bool):
            return n
    return None


class RepeatCallTracker:
    """一个 agent 实例一份：每轮开头 `reset()`，每个工具返回后 `review()`。"""

    def __init__(self) -> None:
        # (工具名, 规范化入参) → (最近一次原样给了模型的 toolUseId, 它的结果指纹)
        self._seen: dict[tuple[str, str], tuple[str, str]] = {}

    def reset(self) -> None:
        self._seen = {}

    def review(self, tool_name, tool_input, result, messages):
        """返回替换用的 toolResult；返回 None = 原样放行。`messages` = agent 当前的上下文。"""
        if not isinstance(result, dict) or not isinstance(result.get("content"), list):
            return None
        tool_use_id = result.get("toolUseId")
        if not isinstance(tool_use_id, str) or not tool_use_id:
            return None
        key = (str(tool_name or ""), _canon(tool_input if tool_input is not None else {}))
        fp = fingerprint(result["content"])
        prev = self._seen.get(key)
        if prev is not None and prev[1] == fp:
            earlier = _tool_result_in(messages, prev[0])
            if earlier is not None and fingerprint(earlier.get("content")) == fp:
                note = _NOTE.format(tool=key[0])
                n = _next_start_index(result["content"])
                if n is not None:
                    note += _NEXT_PAGE.format(tool=key[0], n=n)
                # 被替换的这次不记：上下文里留着的仍是前一份，下一次重复还要跟它比。
                return {"toolUseId": tool_use_id, "status": result.get("status") or "success",
                        "content": [{"text": note}]}
        self._seen[key] = (tool_use_id, fp)
        return None


class RepeatCallGuard:
    """挂到 Strands Agent 上的 hook（`Agent(hooks=[RepeatCallGuard(BeforeInvocationEvent, AfterToolCallEvent)])`）。

    `BeforeInvocationEvent` 每轮清零；`AfterToolCallEvent.result` 是可写字段，判定重复就换掉。
    一个 Agent 实例一份：部署版 agent 按会话缓存，而 Strands 默认不许同一实例并发跑两轮
    （`ConcurrencyException`），所以「本轮」的状态不会被另一轮清掉。
    守卫自己出错时**放行原结果**：它是省 token / 防打转的兜底，不能反过来让一次正常的工具调用失败。
    """

    def __init__(self, before_invocation_event, after_tool_call_event, log=None) -> None:
        self._events = (before_invocation_event, after_tool_call_event)
        self._log = log or logging.getLogger(__name__)
        self._tracker = RepeatCallTracker()

    def register_hooks(self, registry, **kwargs) -> None:
        before_invocation, after_tool_call = self._events
        registry.add_callback(before_invocation, self._on_turn_start)
        registry.add_callback(after_tool_call, self._on_tool_result)

    def _on_turn_start(self, event) -> None:
        self._tracker.reset()

    def _on_tool_result(self, event) -> None:
        if getattr(event, "cancel_message", None):  # 被别的 hook 取消的调用不是真结果，不参与比对
            return
        tool_use = getattr(event, "tool_use", None) or {}
        try:
            replacement = self._tracker.review(tool_use.get("name"), tool_use.get("input"),
                                               event.result, event.agent.messages)
        except Exception as e:  # noqa: BLE001 — 见 docstring：守卫失败只放行，不影响工具
            # 只记异常类型：异常文本可能带着工具入参 / 结果（用户数据），见 docs/LOGGING_STANDARD.md。
            self._log.warning("repeat-call guard skipped: %s", type(e).__name__)
            return
        if replacement is not None:
            self._log.info("repeat-call guard: identical %s result replaced with a note",
                           tool_use.get("name"))
            event.result = replacement
