from strands.models.bedrock import BedrockModel

# 前端模型选择 key → 实际模型标识。
# 多数走标准 Bedrock（Converse）；GPT-5.4 走 Bedrock Mantle（OpenAI Responses API），
# 见 https://aws.amazon.com/blogs/aws/get-started-with-openai-gpt-5-5-gpt-5-4-models-and-codex-on-amazon-bedrock/
_MODEL_MAP = {
    "claude-opus-5": "global.anthropic.claude-opus-5",  # 最强档:深度分析/复杂根因(输出硬上限 128K，同 Sonnet 5)
    "claude-sonnet-5": "global.anthropic.claude-sonnet-5",
    "claude-sonnet-4-6": "global.anthropic.claude-sonnet-4-6",  # 保留:老会话/显式选择仍可用
    "claude-haiku-4-5": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
    "amazon-nova-pro": "amazon.nova-pro-v1:0",
    "deepseek-v3-2": "deepseek.v3.2",
    "gpt-5-6": "openai.gpt-5.6-terra",  # 走 Mantle（见下）
    "gpt-5-6-sol": "openai.gpt-5.6-sol",    # GPT-5.6 Sol，走 Mantle
    "gpt-5-6-luna": "openai.gpt-5.6-luna",  # GPT-5.6 Luna，走 Mantle
}

_DEFAULT = "global.anthropic.claude-sonnet-5"

# 走 Bedrock Mantle 的模型（OpenAI Responses API，非标准 Converse）。
# GPT-5.6 系列（Terra/Sol/Luna）仅在 us-east-2 / us-west-2；我们的 runtime 在 us-east-1，故显式指定区域。
_MANTLE_MODELS = {
    "gpt-5-6": {"model_id": "openai.gpt-5.6-terra", "region": "us-east-2"},
    "gpt-5-6-sol": {"model_id": "openai.gpt-5.6-sol", "region": "us-east-2"},
    "gpt-5-6-luna": {"model_id": "openai.gpt-5.6-luna", "region": "us-east-2"},
}


def resolve_model_id(model_key: str | None = None) -> str:
    """前端模型 key → 实际模型标识（供"你用什么模型"如实回答用）。"""
    key = model_key or ""
    if key in _MANTLE_MODELS:
        return _MANTLE_MODELS[key]["model_id"]
    return _MODEL_MAP.get(key, _DEFAULT)


def _make_mantle_responses_model(cfg: dict):
    """构造走 Bedrock Mantle 的 GPT-5.4（OpenAI Responses API）模型实例。

    坑：Strands 1.44 的 Mantle base_url 模板是 `https://bedrock-mantle.{region}.api.aws/v1`，
    **少了 `/openai`**。正确应为 `.../api.aws/openai/v1`（见 AWS 博客）。否则请求打到
    `/v1/responses`，服务端报 "model does not support the '/v1/responses' API"。
    修法：子类化 OpenAIResponsesModel，重写 _resolve_client_args —— 仍用官方逻辑每请求
    铸新 bearer token（不会过期），只把 base_url 补成 `/openai/v1`（已含则不重复插）。
    将来 Strands 修正模板后此 patch 仍兼容（幂等）。"""
    from strands.models.openai_responses import OpenAIResponsesModel

    class _MantleResponsesModel(OpenAIResponsesModel):
        def _resolve_client_args(self):  # type: ignore[override]
            args = super()._resolve_client_args()
            base = args.get("base_url") or ""
            # 把 `.../api.aws/v1` 修成 `.../api.aws/openai/v1`（幂等）
            if base.endswith("/v1") and "/openai/v1" not in base:
                args["base_url"] = base[: -len("/v1")] + "/openai/v1"
            return args

    return _MantleResponsesModel(
        model_id=cfg["model_id"],
        bedrock_mantle_config={"region": cfg["region"]},
        # 输出上限：走 OpenAI Responses API，参数名是 max_output_tokens（非 Bedrock 的 max_tokens）。
        # GPT-5.6 Terra 上下文 272K、官方卡片未单列硬输出上限，用统一目标（安全，远低于其能力）。
        # 与 Bedrock 路径同理：防长回答撞默认小上限被截断、丢 sources/usage。
        params={"max_output_tokens": _MAX_OUTPUT_TARGET},
    )


# ── 输出 token 上限（max_tokens）─────────────────────────────────────────────
# 背景（客户实测事故）：BedrockModel 默认 max_tokens 偏小（~4096），长回答（大表格 +
# 建议 + 报告收尾）——尤其 Sonnet 5 的 adaptive thinking 常驻、reasoning token 也计入
# 输出——很容易撞顶，触发 MaxTokensReachedException → 流被中断、正文半截、且**收尾**才发的
# sources/usage 全部丢失（客户："查询每个存储层的成本"回答被截断且无 Sources）。
#
# 修法：给每个模型设一个**尽量大**的输出上限。但**绝不能一刀切**——各模型硬上限差异巨大，
# 设超过硬上限会被 Bedrock 直接拒（ValidationException），比截断更糟。故取 min(模型硬上限,
# 统一目标)。硬上限数字来自 AWS 官方模型卡片（docs.aws.amazon.com，2026-07 核实）：
#   Claude Opus 5 = 128K；Claude Sonnet 5 = 128K；Sonnet 4.6 / Haiku 4.5 = 64K；
#   DeepSeek V3.2 = 8K；Nova Pro = 5K。（Opus 5 硬上限 128K 已用 bedrock-runtime converse 实测：
#   maxTokens=128000 通过、200000 报 "exceeds the model limit of 128000"，2026-07 核实。）
_MAX_OUTPUT_TARGET = 32768  # 统一目标：足够覆盖本产品最长的分析/报告类回答（含 reasoning）


def _model_max_output_limit(model_id: str) -> int:
    """按模型返回其**硬输出上限**（AWS 官方模型卡片核实）。未知模型保守取 8192。"""
    mid = (model_id or "").lower()
    if "nova" in mid:
        return 5120           # Amazon Nova Pro: 5K
    if "deepseek" in mid:
        return 8192           # DeepSeek V3.2: 8K
    if "claude-opus-5" in mid or "claude-sonnet-5" in mid:
        return 128000         # Claude Opus 5 / Sonnet 5: 128K（实测核实）
    if "claude" in mid:
        return 65536          # Claude Sonnet 4.6 / Haiku 4.5 / Opus 4.x: 64K
    return 8192               # 未知模型：保守，避免超限被拒


def _max_tokens_for(model_id: str) -> int:
    """该模型实际用的 max_tokens = min(硬上限, 统一目标)。永不超硬上限。"""
    return min(_model_max_output_limit(model_id), _MAX_OUTPUT_TARGET)


def _bedrock_kwargs(model_id: str) -> dict:
    """构造 BedrockModel 参数。P2b：对**支持 Converse 提示缓存**的模型开启 cache_tools +
    cache_prompt，把 ~17K 的工具 schema + system prompt 这段固定前缀缓存起来
    （cacheRead 比正常 input 便宜约 90%）。这两段每步都全量重发，缓存后 agentic loop
    多步 + 多轮对话都命中 cacheRead，显著降 token 成本。
    仅对 Claude 开启（确定支持）；DeepSeek/Nova 不确定支持、贸然开会 API 报错，故不开。"""
    kwargs = {"model_id": model_id}
    # 输出上限：per-model 取 min(硬上限, 目标)，见上方说明（防截断 + 不超限）。
    kwargs["max_tokens"] = _max_tokens_for(model_id)
    if "anthropic.claude" in model_id:
        kwargs["cache_tools"] = "default"    # 缓存工具 schema
        kwargs["cache_prompt"] = "default"   # 缓存 system prompt（同为固定前缀，每步复用）
    return kwargs


def load_model(model_key: str | None = None):
    """按前端模型 key 返回对应模型实例。
    - GPT-5.4 → Strands OpenAIResponsesModel + Bedrock Mantle（Responses API，区域 us-east-2）。
    - 其余 → 标准 BedrockModel（Converse），用 runtime IAM 角色凭证；Claude 额外开工具缓存。
    GPT-5.4 依赖未装/区域未开通时，安全回退默认 Claude，避免整轮失败。"""
    key = model_key or ""
    if key in _MANTLE_MODELS:
        try:
            return _make_mantle_responses_model(_MANTLE_MODELS[key])
        except Exception:  # noqa: BLE001 — 依赖缺失/区域未开通 → 回退默认，不阻断
            return BedrockModel(**_bedrock_kwargs(_DEFAULT))
    return BedrockModel(**_bedrock_kwargs(_MODEL_MAP.get(key, _DEFAULT)))
