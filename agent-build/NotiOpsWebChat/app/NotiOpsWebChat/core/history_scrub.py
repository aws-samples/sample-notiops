"""跨模型历史清洗 —— 让 Claude / Grok / GLM 在**同一个会话里**可以互相切换。

## 这段代码解决的现网故障（2026-09-01 实测定位）

同一个会话 `conv-...-153` 的日志：

    02:06:40  一轮正常完成（Claude Sonnet 5）
    02:17:35  ERROR model invocation failed: type=InternalServerException  model=global.xai.grok-4.6
    02:18:50  ERROR model invocation failed: type=ValidationException      model=zai.glm-5

两次失败都在 AgentCore Memory 恢复历史之后 ~8s 冒出来，而**换回 Sonnet 立刻就好**。

机制：`core/agent_cache.build_key()` 把 `model_key` 计入缓存键 —— 换模型 = 新建一个
Agent 实例；新实例又通过 `get_memory_session_manager(session_id, actor_id)` 把**上一个
模型写下的历史**原样恢复回来。Claude 的 adaptive thinking 常开，历史里因此躺着
`reasoningContent` 块（`reasoningText` + Anthropic 私有 `signature`，或 `redactedContent`）。
把这些块回放给非 Anthropic 模型，Bedrock Converse 直接报错。

us-east-1 实测矩阵（2026-09-01，直调 Converse，同一段两轮历史只换模型）：

    历史里的块                         grok-4.6                glm-5                    sonnet-5
    reasoningText + signature          InternalServerException ValidationException      OK（自己的签名）
    redactedContent                    OK                      InternalServerException  OK（自己的数据）
    cachePoint（user content 里）      AccessDeniedException   AccessDeniedException    OK
    纯文本 / toolUse+toolResult        OK                      OK                       OK

GLM 的报错原文点名了字段：`This model doesn't support the
reasoningContent.reasoningText.signature field.`

## 为什么必须在「恢复时」洗、不能在「请求时」洗

反方向也是坏的：**Grok 自己也会产 `reasoningContent`** —— 实测一次 maxTokens=400 的
往返，assistant 消息的 content 只有 `['reasoningContent']`、连 text 都没有；它把自己
的块回放回去完全正常，而 Claude 见到外来签名会 `ValidationException: Invalid
signature in thinking`。所以在请求构造时无差别剥掉 `reasoningContent` 会**打断 Grok
自己的轮次**；只能在「历史刚从 Memory 恢复出来、还没进任何一次请求」这个点洗一次。

洗是**无条件**的（不看当前模型）：Claude→Grok 与 Grok→Claude 都会坏，只有统一剥掉
才能拿到「三个模型任意互换」这个性质。剥掉历史 thinking 对 Claude 无损 —— thinking
块只在**当前**这一轮的 tool-use 循环里需要原样回传，跨轮历史里的可以丢。

## 角色交替这条坑

Bedrock Converse 要求 user/assistant 严格交替。Grok 那种「只有 reasoningContent」的
消息洗完会变成**空消息**，此时不能把消息删掉（删了就出现连续同角色 → 400），必须塞一个
占位文本块。Bedrock 同时拒绝空字符串，所以占位不能是 ""。

Strands 自己有一份同样的修复，但硬编码只认 DeepSeek（`strands/models/bedrock.py`
里 `if "deepseek" in model_id.lower() and "reasoningContent" in content_block`，旁边
挂着 TODO 说要换成模型能力注册表）。等不到那个注册表，这里自己做。

## 第二种坏历史：`user, user` —— 一次模型失败把会话**永久**弄死

`repair_role_alternation()` 修的是另一个故障，和上面的清洗无关，但坏在同一个地方
（Bedrock 的严格交替）：

Strands 在**调模型之前**就把用户这句话 append 进 `agent.messages`。所以只要模型调用
失败一次（限流 / 5xx / 读超时 / 没开模型访问权限），这一轮就没有 assistant 消息补上，
历史结尾停在 `user`。下一轮再 append 一条 `user` → 出现连续同角色 → Bedrock 报
`ValidationException`，**而且每一轮都报**：这一轮又失败 → 又留一条 `user` → 越堆越坏。
更糟的是这段坏历史会被 AgentCore Memory 持久化下来，换模型、换 Agent 实例都带着它，
从用户角度看就是「这个会话彻底不能用了，报的还是看不懂的 validation 错误」。

所以修复分两头：
  * 写入端 —— `main.py` 的模型失败分支里补一条 assistant 降级消息，新会话不再被写坏；
  * 读取端 —— 这里，在历史刚从 Memory 恢复出来时把**已经**坏掉的会话救回来。

顺带修 `toolUse` / `toolResult` 悬空：同一次中途失败也可能留下「assistant 发了
toolUse、但后面没有对应的 toolResult」（或反过来）。Bedrock 对这两种同样报
ValidationException，而且补占位文本救不了它（它要的是配对的 toolResult），只能把悬空的
块摘掉。
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

# 洗掉的块类型。
#   reasoningContent —— 模型私有的思考块（签名/加密数据只对产出它的那家模型有效）。
#   cachePoint       —— prompt cache 标记；grok/glm 不支持显式 cachePoint（AccessDenied）。
#                       Strands 目前把 cachePoint 注入到请求副本而非 agent 历史，所以
#                       历史里出现它属于「不该发生但代价极低」的防御性清理。
_DROP_KEYS = ("reasoningContent", "cachePoint")

# 消息被洗空时的占位。必须非空（Bedrock 拒绝空 text）、必须 ASCII（scripts/lint_i18n.py
# 只允许 i18n 表里出现 CJK 字面量；这段文本也不该被翻译 —— 它是给模型看的历史痕迹，
# 不是给用户看的 UI 文案）。
_PLACEHOLDER_TEXT = "[reasoning omitted]"

# 交替修复用的占位文案。同样必须非空 + ASCII（理由见上）。这两句是**给模型看的历史
# 痕迹**，不是 UI 文案 —— 用户永远看不到它们，所以不进 i18n 表。
_ASSISTANT_GAP_TEXT = "[the previous turn failed before an answer was produced]"
_USER_GAP_TEXT = "[continue]"


def _is_droppable(block: Any) -> bool:
    if not isinstance(block, dict):
        return False
    if any(k in block for k in _DROP_KEYS):
        return True
    # 洗完可能剩下空文本块（历史里本就有、或上游截断留下的）。Bedrock 对空 text 报
    # ValidationException，顺手一起清掉。
    if set(block) == {"text"} and not str(block.get("text") or "").strip():
        return True
    return False


def scrub_cross_model_history(messages: Any) -> int:
    """就地清洗刚恢复出来的会话历史，返回被删掉的 block 数（0 = 无需清洗）。

    只改 `content` 列表：删掉 `_DROP_KEYS` 里的块与空文本块；某条消息被删空时补一个
    占位文本块（保住 user/assistant 交替，见模块 docstring）。其余字段一律不动。
    """
    if not isinstance(messages, list) or not messages:
        return 0
    dropped = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if not isinstance(content, list) or not content:
            continue
        kept = []
        for block in content:
            if _is_droppable(block):
                dropped += 1
                continue
            kept.append(block)
        if len(kept) == len(content):
            continue
        msg["content"] = kept if kept else [{"text": _PLACEHOLDER_TEXT}]
    return dropped


def _blocks(msg: Any) -> list:
    content = msg.get("content") if isinstance(msg, dict) else None
    return content if isinstance(content, list) else []


def _tool_ids(msg: Any, key: str) -> set:
    """msg 里某一类工具块（toolUse / toolResult）的 id 集合。"""
    out = set()
    for block in _blocks(msg):
        if isinstance(block, dict) and isinstance(block.get(key), dict):
            tid = block[key].get("toolUseId")
            if tid:
                out.add(tid)
    return out


def _drop_unpaired_tool_blocks(messages: list) -> int:
    """摘掉悬空的 toolUse / toolResult 块，返回摘掉的块数。

    Bedrock 的配对规则：assistant 的每个 toolUse 必须在**紧接着**那条 user 消息里有同
    id 的 toolResult，反之亦然。中途失败的一轮会留下单边的块，补占位文本救不了 —— 只能
    摘掉。摘空的消息补占位文本（不能删消息，删了就破交替）。
    """
    dropped = 0
    for i, msg in enumerate(messages):
        if not isinstance(msg, dict):
            continue
        nxt = messages[i + 1] if i + 1 < len(messages) else None
        prev = messages[i - 1] if i > 0 else None
        if msg.get("role") == "assistant":
            paired = _tool_ids(nxt, "toolResult") if isinstance(nxt, dict) and nxt.get("role") == "user" else set()
            drop_key, keep_ids = "toolUse", paired
        elif msg.get("role") == "user":
            paired = _tool_ids(prev, "toolUse") if isinstance(prev, dict) and prev.get("role") == "assistant" else set()
            drop_key, keep_ids = "toolResult", paired
        else:
            continue
        content = _blocks(msg)
        if not content:
            continue
        kept = []
        for block in content:
            if (isinstance(block, dict) and isinstance(block.get(drop_key), dict)
                    and block[drop_key].get("toolUseId") not in keep_ids):
                dropped += 1
                continue
            kept.append(block)
        if len(kept) != len(content):
            msg["content"] = kept if kept else [{"text": _PLACEHOLDER_TEXT}]
    return dropped


def repair_role_alternation(messages: Any) -> int:
    """就地修复被打断的 user/assistant 交替，返回改动次数（0 = 历史本来就是好的）。

    先摘悬空工具块，再在连续同角色之间插占位消息；历史若以 assistant 开头也补一条
    user 占位（Bedrock 要求首条是 user）。见模块 docstring「第二种坏历史」。
    """
    if not isinstance(messages, list) or not messages:
        return 0
    fixed = _drop_unpaired_tool_blocks(messages)

    def _role(m: Any) -> str:
        return m.get("role") if isinstance(m, dict) else ""

    i = 0
    while i < len(messages):
        role = _role(messages[i])
        if role not in ("user", "assistant"):
            i += 1
            continue
        if i == 0:
            if role == "assistant":
                messages.insert(0, {"role": "user", "content": [{"text": _USER_GAP_TEXT}]})
                fixed += 1
                i += 1
            i += 1
            continue
        if role == _role(messages[i - 1]):
            gap = (_ASSISTANT_GAP_TEXT if role == "user" else _USER_GAP_TEXT)
            filler = "assistant" if role == "user" else "user"
            messages.insert(i, {"role": filler, "content": [{"text": gap}]})
            fixed += 1
            i += 1
        i += 1

    # 结尾停在 user = 上一轮没写出 assistant 消息（模型调用失败）。这是**最常见**的那种
    # 坏历史，而且此刻还不是「连续同角色」—— 得等 Strands 把本轮这句 append 进来才变成
    # user,user。所以必须在这里就把结尾补平，不能只修已经出现的重复。
    # 一轮正常结束的历史结尾一定是 assistant，所以这个判断不会误伤好会话。
    if _role(messages[-1]) == "user":
        messages.append({"role": "assistant", "content": [{"text": _ASSISTANT_GAP_TEXT}]})
        fixed += 1
    return fixed
