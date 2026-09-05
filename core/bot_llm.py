"""IM/后端小任务的**单轮 LLM 调用**收口 —— 从"手搓 Anthropic body"改成 Converse。

── 为什么有这个模块 ────────────────────────────────────────────────────────────
`core/` 下有 8 处「一个 system prompt + 一段用户文本 → 一段（通常是 JSON 的）文本」
的调用：`bedrock_intent`、`next_steps`、`case_analyze`、`skill_dispatcher`、
`case_classifier`、`progress_card`（两处）、`skill_authoring`。它们原来各自
`invoke_model(body={"anthropic_version": "bedrock-2023-05-31", ...})` —— 也就是
**写死了 Anthropic 的原生协议**。

后果很具体：SSM `/notiops/agent/model_id`（`shared/model_config.get_bot_model_id()`）
一旦填成非 Anthropic 的模型，这 8 处**全部**当场 `ValidationException`。所以在
2026-09-01 把产品默认模型换成 Grok 4.6 之前，这一格是"到处都换成 Grok"唯一真正的墙。

改成走 `shared.llm_provider.invoke_llm`（Converse / Mantle / LiteLLM 三协议统一入口）
之后，这 8 处跟对话侧（webchat / IM）用的是同一套协议分派：目录里任何 Bedrock 模型
都能绑，Claude 的行为不变（Converse 对 Anthropic 模型同样适用）。

── 刻意没做的两件事 ────────────────────────────────────────────────────────────
1. **不传 `temperature`。** `notiops-backend-stack.ts` 曾有一句注释说这 8 处
   「现在各自设了 temperature（分类器靠低温保证确定性）」—— 那是**不实**的，8 处
   body 里一个 `temperature` 都没有（2026-09-01 grep 实证）。`invoke_llm` 也没有这个
   参数。所以这次迁移在采样参数上是**零行为变化**，不是"顺手把温度丢了"。
2. **不按 model_id 猜 `kind`。** 猜错的表现是
   `ValidationException: The provided model identifier is invalid`，读起来像"模型不
   存在"，归因成本极高（`shared/phd_config.py::phd_model_route` 里写了这段教训）。
   这里恒传空 `kind` = Converse。**代价要说清**：只在 `bedrock-mantle` 上架的模型
   （GPT-5.6 系列）绑到 `/notiops/agent/model_id` 仍然不可用 —— 要支持它们，得像
   PHD 那样把 `kind` 一起投影到配置里（`for_model_id` 那套防撕裂读法），那是独立的
   一件事，不在这次范围内。
"""
from __future__ import annotations

import logging

# `get_bot_model_id` is **deliberately re-exported**: `skill_dispatcher` /
# `skill_authoring` log an `llm_audit: … model=%s …` line next to each call and
# need the same id this module resolved. Don't "clean up the unused import".
from shared.model_config import get_bot_model_id

__all__ = ["invoke_bot_text", "strip_code_fence", "get_bot_model_id"]

logger = logging.getLogger(__name__)

#: 输出预算的**下界**。调用方传的 `max_tokens` 是「答案该有多长」，而
#: `maxTokens` 管的是「答案 **+ 推理** 一共能有多长」。
#:
#: 🔴 2026-09-05 加这个下界的由来（现网 D4）：报告摘要那条链路的预算是
#: 1024，默认模型在 509cb42 之后全槽位换成 Grok 4.6 —— 推理模型的 thinking
#: token 先把预算吃光，`stopReason` 恒为 `max_tokens`，`content` 里只剩
#: `reasoningContent`，于是下游拿到空串。表现不是"答得不好"，是**整块内容
#: 没有**，而且不报错。
#:
#: 这里选择在**收口处**兜底，而不是把 6 个调用点的数字一个个改大：新调用点
#: 只会照着老调用点抄一个几百的数字，抄完就复发。真正的口径是
#: `core/model_catalog._FLOOR.max_output_tokens` / `llm_config._OUTPUT_TARGET`
#: = 6000；2000 是「留给推理的空间 + 小任务答案」的折中 —— 小任务的输出长度
#: 由 prompt 和调用方的截断（如 `progress_card` 的 `[:200]`）决定，不靠这个
#: 数字去卡，所以调大它**不会**让答案变长，只会让答案有机会出现。
_MIN_MAX_TOKENS = 2000


def invoke_bot_text(system_prompt: str, user_text: str, max_tokens: int) -> str:
    """一次单轮调用，返回**已去掉 markdown 代码围栏**的文本（可能为空串）。

    异常**不吞**：向上抛给调用方，让每一处保留自己原有的 fallback 语义
    （`bedrock_intent` 回安全默认、`case_classifier` 回 None、`progress_card`
    回原文……）。这里统一处理的只有三件事：协议分派、预算下界与围栏剥离。
    """
    from shared.llm_provider import invoke_llm

    model_id = get_bot_model_id()
    budget = max(int(max_tokens or 0), _MIN_MAX_TOKENS)
    result = invoke_llm(
        model_id,
        system_prompt,
        user_text,
        max_tokens=budget,
    )
    text = (result.get("content") or "").strip()
    if not text:
        # 说出来。空内容以前的形态是"取 content[0] 却拿到 reasoningContent"，
        # 静默返回空串 → 下游走 fallback → 看起来像"模型答得不好"而不是"没答"。
        logger.warning(
            "bot_llm: empty content (model=%s stop_reason=%s max_tokens=%d "
            "requested=%d)",
            model_id, result.get("stop_reason"), budget, max_tokens,
        )
    return strip_code_fence(text)


def strip_code_fence(text: str) -> str:
    """剥掉 ```json … ``` 围栏。与原先 8 处各自内联的那几行**逐字等价**。

    模型被要求"只输出 JSON"时仍常常裹一层围栏；`_loose_load_json` 能容忍尾部多余
    文本，但容忍不了开头的 ``` 。
    """
    if not text.startswith("```"):
        return text
    out = text.strip("`")
    if out.lstrip().lower().startswith("json"):
        out = out.split("\n", 1)[1] if "\n" in out else out[4:]
    return out.strip()
