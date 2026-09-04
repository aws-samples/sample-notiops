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
