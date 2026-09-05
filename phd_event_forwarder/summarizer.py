"""Bedrock 摘要模块。

调用 Bedrock Converse API 对 PHD 事件进行中文翻译和摘要。
内联简化版 Bedrock 调用，复用 bedrock_invoker.py 的 API Key 认证模式。

认证优先级：
  1. API Key Bearer Token（BEDROCK_API_KEY_SECRET_ARN 非空且 API Key 非空）
  2. IAM 凭证（默认回退）
"""

import json
import logging
import os
import time

import boto3
from botocore.config import Config

from phd_event_forwarder.event_parser import PHDEvent
from shared.llm_provider import invoke_llm
from shared.phd_config import phd_model_id, phd_model_route

logger = logging.getLogger("phd_event_forwarder.summarizer")

# Bedrock 客户端配置（轻量模型，超时适中）
_bedrock_config = Config(
    read_timeout=60,
    connect_timeout=10,
    retries={"max_attempts": 2, "mode": "adaptive"},
)

# ---------------------------------------------------------------------------
# API Key 缓存（与 bedrock_invoker.py 模式一致）
# ---------------------------------------------------------------------------

_cached_api_key: str | None = None
_cached_api_key_ts: float = 0
_API_KEY_CACHE_TTL = 300  # 5 分钟


def _get_api_key() -> str | None:
    """从 Secrets Manager 读取 API Key（带缓存）。

    Secret ARN 来自环境变量 BEDROCK_API_KEY_SECRET_ARN。
    缓存 TTL 为 300 秒，与 bedrock_invoker.py 保持一致。

    Returns:
        API Key 字符串（非空时），读取失败或为空时返回 None。
    """
    global _cached_api_key, _cached_api_key_ts
    now = time.time()
    if _cached_api_key is not None and (now - _cached_api_key_ts) < _API_KEY_CACHE_TTL:
        return _cached_api_key if _cached_api_key else None

    secret_arn = os.environ.get("BEDROCK_API_KEY_SECRET_ARN", "")
    if not secret_arn:
        return None

    try:
        region = os.environ.get("AWS_REGION", "us-east-1")
        client = boto3.client("secretsmanager", region_name=region)
        response = client.get_secret_value(SecretId=secret_arn)
        secret_string = response["SecretString"]
        secret_dict = json.loads(secret_string)
        api_key = secret_dict.get("bedrock_api_key", "")
        if isinstance(api_key, str) and api_key:
            _cached_api_key = api_key
            _cached_api_key_ts = now
            return api_key
        # API Key 为空，缓存空值避免频繁读取
        _cached_api_key = ""
        _cached_api_key_ts = now
        return None
    except Exception as e:
        logger.warning("从 Secrets Manager 读取 Bedrock API Key 失败: %s", e)
        return None


# ---------------------------------------------------------------------------
# System Prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """你是一位 AWS 运维专家助手。你的任务是将英文 AWS Personal Health Dashboard (PHD) 事件翻译为简洁的中文摘要。

要求：
1. 用中文输出，保留关键技术术语（如服务名、Region、ARN 等）不翻译
2. 保留以下关键信息：
   - 事件类型和严重程度
   - 受影响的 AWS 服务
   - 影响范围（Region、账户）
   - 事件时间线
   - 推荐的应对措施
3. 输出格式为 Markdown
4. 简洁明了，突出重点，不超过 300 字
5. 如果事件描述中包含推荐操作（recommended actions），务必翻译并保留"""


def _build_user_prompt(phd_event: PHDEvent) -> str:
    """构建用户提示词，包含 PHD 事件关键字段。"""
    event_data = {
        "eventTypeCode": phd_event.eventTypeCode,
        "eventTypeCategory": phd_event.eventTypeCategory,
        "service": phd_event.service,
        "region": phd_event.region,
        "statusCode": phd_event.statusCode,
        "startTime": phd_event.startTime,
        "endTime": phd_event.endTime,
        "eventDescription": phd_event.eventDescription,
        "affectedAccount": phd_event.affectedAccount,
        "affectedEntities": phd_event.affectedEntities[:10],  # 最多 10 个
    }
    return (
        "请将以下 AWS PHD 事件翻译为中文摘要：\n\n"
        f"```json\n{json.dumps(event_data, ensure_ascii=False, indent=2)}\n```"
    )


def summarize_event(phd_event: PHDEvent) -> str:
    """调用 LLM 生成 PHD 事件中文摘要。

    Provider 选择由 SSM Parameter `/notiops/llm/provider` 决定
    (走 shared.llm_provider)。Bedrock 路径下沿用原有 API Key/IAM 认证;
    LiteLLM 路径走配置好的 Proxy。

    模型 ID 由 shared.phd_config 决定：DDB (appconfig#phd) → env MODEL_ID → 硬编码。

    Args:
        phd_event: 解析后的 PHD 事件

    Returns:
        中文摘要字符串(Markdown 格式)

    Raises:
        Exception: LLM 调用失败时抛出异常,由调用方处理降级。
    """
    # 模型 ID 走 DDB → env MODEL_ID → 硬编码 三级降级（shared/phd_config.py）。
    # DDB 那一层由 Admin「后端任务模型」写入，改完**下一条 PHD 事件**即生效，不必重新部署。
    model_id = phd_model_id()
    # 协议与区域也来自同一份投影。缺省为空 = Converse（env / 硬编码兜底那两级本就是
    # Converse 模型），有值时才切到 Mantle Responses —— 有一批 Bedrock 模型只在
    # bedrock-mantle 上架，Converse 调不到。
    # 传 model_id 是必需的，不是方便：三行投影是独立 item，读者可能跨代读到
    # 「旧 model_id + 新 kind」。phd_model_route 用行上的 for_model_id 校验配对，
    # 不匹配就当没有路由信息（= Converse）。详见该函数 docstring。
    model_kind, model_region = phd_model_route(model_id)
    user_prompt = _build_user_prompt(phd_event)

    logger.info("Invoking LLM for PHD summary, model=%s kind=%s region=%s",
                model_id, model_kind or "converse", model_region or "-")
    result = invoke_llm(
        model_id=model_id,
        system_prompt=SYSTEM_PROMPT,
        user_prompt=user_prompt,
        # 🔴 2026-09-05：1024 → 2000。`maxTokens` 管的是「摘要 **+ 推理** 一共
        # 多长」，而默认模型（509cb42 起全槽位 Grok 4.6）是推理模型：thinking
        # token 先把 1024 吃光，`stopReason` 恒为 `max_tokens`，`content` 里只剩
        # `reasoningContent` → 摘要是空串。口径与 `core/bot_llm._MIN_MAX_TOKENS`
        # 一致（同一个坑的同一个数字），产品级目标是 `_OUTPUT_TARGET` = 6000。
        max_tokens=2000,
        kind=model_kind,
        region=model_region,
    )

    logger.info(
        "LLM PHD summary completed: model=%s, stop_reason=%s, usage=%s",
        model_id, result.get("stop_reason"), result.get("usage"),
    )
    content = (result.get("content") or "").strip()
    if not content:
        # 不许静默降级：空摘要以前会被 `format_message` 原样渲染成一张
        # 「有标题、没内容」的卡（D4 在飞书侧的同款形状）。抛出去让
        # `handler.py` 的 except 走 `format_fallback_message` —— 那条路径
        # 至少把 PHD 原始事件完整转发出去，用户不会一无所获。
        raise RuntimeError(
            "PHD summary came back empty (model=%s stop_reason=%s); "
            "falling back to raw event forwarding"
            % (model_id, result.get("stop_reason")))
    return content
