"""Lambda3-HealthChecker LLM 调用模块。

历史上这里直接封装 boto3 bedrock-runtime Converse API。

为支持 LiteLLM Proxy(以及未来更多 provider),实际 provider 选择委托给
`shared/llm_provider`(根据 SSM Parameter `/notiops/llm/provider` 切换),
但 Bedrock 路径仍在本模块内执行 `client.converse()` —— 这样旧测试通过
`patch('lambda3_health_checker.bedrock_invoker.boto3')` 仍可拦截调用。

签名与返回值与历史保持一致,handler.py / data_loader.py 等调用方零改动:
    {"content": str, "stop_reason": str, "usage": dict}

usage 字段名(Bedrock 与 LiteLLM 路径都返回这套):
    inputTokens / outputTokens / totalTokens
"""

import json
import logging
import os
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from shared import llm_provider as _llm

logger = logging.getLogger(__name__)

# 增大读取超时以支持大模型长时间推理(默认 60s 不够)
_bedrock_config = Config(
    read_timeout=300,
    connect_timeout=10,
    retries={"max_attempts": 2, "mode": "adaptive"},
)

TRUNCATION_NOTICE = "\n\n---\n⚠️ 报告因 token 限制被截断,部分内容可能不完整。"


# ---------------------------------------------------------------------------
# API Key 缓存(与 agent/core.py 模式一致)
# ---------------------------------------------------------------------------

_cached_api_key: str | None = None
_cached_api_key_ts: float = 0
_API_KEY_CACHE_TTL = 300  # 5 分钟


def _get_api_key_from_secret() -> str | None:
    """从 Secrets Manager 读 Bedrock API Key(带 TTL 缓存)。"""
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
        secret_dict = json.loads(response["SecretString"])
        api_key = secret_dict.get("bedrock_api_key", "")
        if isinstance(api_key, str) and api_key:
            _cached_api_key = api_key
            _cached_api_key_ts = now
            return api_key
        _cached_api_key = ""
        _cached_api_key_ts = now
        return None
    except Exception as e:
        logger.warning("从 Secrets Manager 读取 Bedrock API Key 失败: %s", e)
        return None


def _invoke_bedrock_local(
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
) -> dict:
    """本模块内 Bedrock 调用(保留以让旧测试 patch 拦截 boto3)。"""
    api_key = _get_api_key_from_secret()
    if api_key:
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = api_key
        logger.info(
            "Invoking Bedrock model=%s, system_prompt_len=%d, user_prompt_len=%d, "
            "max_tokens=%d, auth=api_key",
            model_id, len(system_prompt), len(user_prompt), max_tokens,
        )
    else:
        os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)
        logger.info(
            "Invoking Bedrock model=%s, system_prompt_len=%d, user_prompt_len=%d, "
            "max_tokens=%d, auth=iam_credentials",
            model_id, len(system_prompt), len(user_prompt), max_tokens,
        )

    client = boto3.client("bedrock-runtime", config=_bedrock_config)
    try:
        response = client.converse(
            modelId=model_id,
            system=[{"text": system_prompt}],
            messages=[{"role": "user", "content": [{"text": user_prompt}]}],
            inferenceConfig={"maxTokens": max_tokens},
        )
    except ClientError as e:
        error_code = e.response["Error"]["Code"]
        error_msg = e.response["Error"]["Message"]
        logger.error(
            "Bedrock converse failed: code=%s, message=%s, model=%s",
            error_code, error_msg, model_id,
        )
        raise
    except Exception as e:
        logger.error(
            "Bedrock converse failed: error_type=%s, model=%s",
            type(e).__name__, model_id,
        )
        raise

    output = response.get("output", {})
    message = output.get("message", {})
    content_blocks = message.get("content", [])
    content = content_blocks[0].get("text", "") if content_blocks else ""

    stop_reason = response.get("stopReason", "")
    usage = response.get("usage", {})

    if stop_reason == "max_tokens":
        logger.warning(
            "Bedrock response truncated (stop_reason=max_tokens), model=%s, usage=%s",
            model_id, usage,
        )
        content += TRUNCATION_NOTICE

    logger.info(
        "Bedrock converse completed: model=%s, stop_reason=%s, usage=%s",
        model_id, stop_reason, usage,
    )

    return {
        "content": content,
        "stop_reason": stop_reason,
        "usage": usage,
    }


def invoke_bedrock(
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 16000,
) -> dict:
    """统一 LLM 调用入口(保留 invoke_bedrock 这个名字以兼容现有 import)。

    根据 SSM Parameter `/notiops/llm/provider` 切换走 Bedrock 还是 LiteLLM。
    Bedrock 路径在本模块执行(支持旧测试 patch 拦截);LiteLLM 路径走
    `shared.llm_provider._invoke_litellm`。
    """
    provider = _llm._get_provider()
    if provider == "litellm":
        return _llm._invoke_litellm(model_id, system_prompt, user_prompt, max_tokens)
    return _invoke_bedrock_local(model_id, system_prompt, user_prompt, max_tokens)
