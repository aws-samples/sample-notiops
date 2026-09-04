"""把 Strands 的 `message` 事件翻成「思考过程」时间线的步骤（thinking_step）。

## 为什么单独成模块

2026-09-03 需求：长任务（Grok 问成本这类先想、再连调几个工具的活）过去只在气泡里挤出
几句灰字，用户看不到过程、像卡死。前端已能把 `progress`（工具开始那句"正在做什么"）和
`reasoning`（模型明文思考）攒成一条右侧时间线；这里补上**工具的入参与返回**——也就是
"调用 X（region=…）→ X 返回了结果"这层密度更高的信息。

数据来自 Strands 的 `message` 事件（`{"message": {...}}`，**不带外层 `event` 包装**），
`main.py::_stream_events` 此前用 `"event" not in event → []` 把它整类丢掉了。这里只从
里面挑 toolUse / toolResult 两种块，其余（纯文本 assistant 消息等）不产出步骤。

## 与 progress 的衔接（别产生重复行）

工具开始时 `contentBlockStart` 已发过一句 `progress`（无入参），随后这一层再发一条
**同文**的 toolUse 步、但带上 `detail`（入参摘要）。前端 `thinking.ts::appendStep` 的
"升级"规则据此把那一行原地补上入参，而不是新增一行。所以 toolUse 步的 `text` 必须与
`progress` 用**同一个** label 函数（main.py 传入的 `_progress_for_tool`）。

## 零依赖 + 纯函数

这个模块住在 agent 部署树里、不是可 import 的包，其邻居 main.py 一进门就
`from strands import Agent`（测试环境没有）。所以这里刻意**零依赖**，只吃普通 dict、
吐普通 dict，便于 tests/test_webchat_thinking_steps.py 按文件路径直接加载来钉。
安全：只回显工具入参键值与返回的**状态/规模**（条数/字符数），绝不 dump 返回正文
（既避免把大段数据灌进面板，也与日志纪律一致——不外泄原始 payload）。
"""

from __future__ import annotations

from typing import Callable

# 入参摘要的长度上限（面板只是过程回看，不是全文）。
_ARG_HINT_MAX = 160
_ARG_VAL_MAX = 48
# 单个工具最多显示几个入参键（避免一行铺满）。
_ARG_KEYS_MAX = 4


def _fmt_val(v) -> str:
    """把一个入参值压成短字符串。容器只给规模、不展开（避免刷屏，也不 dump 大对象）。"""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        s = v.strip().replace("\n", " ")
        return s if len(s) <= _ARG_VAL_MAX else s[:_ARG_VAL_MAX] + "…"
    if isinstance(v, dict):
        return "{…}" if v else "{}"
    if isinstance(v, (list, tuple)):
        return f"[{len(v)}]"
    if v is None:
        return "null"
    return "…"


def tool_arg_hint(tool_input) -> str:
    """把工具入参 dict 压成 "region=us-east-1, days=30" 这样的一行摘要。

    空/非 dict → 空串（调用方据此决定是否带 detail）。跳过空值键，稳定按插入序，
    最多 _ARG_KEYS_MAX 个键，整体再截到 _ARG_HINT_MAX。"""
    if not isinstance(tool_input, dict) or not tool_input:
        return ""
    parts = []
    for k, v in tool_input.items():
        if v is None or v == "" or v == [] or v == {}:
            continue
        parts.append(f"{k}={_fmt_val(v)}")
        if len(parts) >= _ARG_KEYS_MAX:
            break
    hint = ", ".join(parts)
    return hint if len(hint) <= _ARG_HINT_MAX else hint[:_ARG_HINT_MAX] + "…"


def _result_detail(tool_result: dict) -> str:
    """工具返回的**规模/状态**摘要（不含正文）：如 "success · 3 blocks" / "error"。"""
    status = str(tool_result.get("status") or "").strip()
    content = tool_result.get("content")
    size = ""
    if isinstance(content, list):
        size = f"{len(content)} blocks"
    elif isinstance(content, str):
        size = f"{len(content)} chars"
    if status and size:
        return f"{status} · {size}"
    return status or size or ""


def steps_from_message(msg, label_for_tool: Callable[[str], str], *,
                       tool_result_text: str = "工具已返回") -> list[dict]:
    """从一个 Strands `message` dict 抽出 0..n 个 thinking_step（供 `_stream_events` 逐个 yield）。

    · assistant 的 toolUse 块 → {"text": label_for_tool(name), "kind": "tool", "detail": 入参摘要}
      （无入参则不带 detail；无 name 直接跳过 —— 没法给它起名，硬造一行没意义）。
    · user 的 toolResult 块  → {"text": tool_result_text, "kind": "result", "detail": 状态/规模}
      （toolResult 里没有工具名，故用一句通用"已返回"，细节给状态+规模）。
    其它块（普通文本、reasoningContent 等）不在这里处理 —— 文本/思考走 _stream_events 的
    既有分支，这里只补工具这一层，避免把正文/思考重复产出。
    """
    if not isinstance(msg, dict):
        return []
    content = msg.get("content")
    if not isinstance(content, list):
        return []
    out: list[dict] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        tu = block.get("toolUse")
        if isinstance(tu, dict):
            name = str(tu.get("name") or "").strip()
            if not name:
                continue
            step = {"text": label_for_tool(name), "kind": "tool"}
            hint = tool_arg_hint(tu.get("input"))
            if hint:
                step["detail"] = hint
            out.append(step)
            continue
        tr = block.get("toolResult")
        if isinstance(tr, dict):
            step = {"text": tool_result_text, "kind": "result"}
            detail = _result_detail(tr)
            if detail:
                step["detail"] = detail
            out.append(step)
    return out
