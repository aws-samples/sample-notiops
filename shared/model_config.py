"""Bot 模型 ID 动态配置 — SSM Parameter + TTL 缓存。

Dashboard「AI 助手模型」页面写入 SSM `/notiops/agent/model_id`,
本模块提供 `get_bot_model_id()` 供 ECS bot 的所有 Bedrock 调用点使用。
TTL 300 秒(5 分钟),Dashboard 改模型后最多 5 分钟自动生效,无需重启容器。

Fallback 链:SSM → 环境变量 BEDROCK_MODEL_ID → hardcoded default。
SSM 读取失败(网络/权限)时 fail-open 用 fallback,不阻塞请求。
"""

import logging
import os
import time

import boto3

logger = logging.getLogger("shared.model_config")

_SSM_PARAMETER = "/notiops/agent/model_id"
# `global.*` —— 与 CDK 写入 SSM 的值（global.anthropic.claude-sonnet-5）一致。
# 此前这里是 us.*，只有在 SSM 与 env 都缺失时才暴露，属于隐蔽的地理路由分叉。
#
# ⚠️ **必须是 Claude**，不能跟随模型目录的 default_model（现为 Claude Sonnet 5，恰好同值，但那是目录的自由）。本函数的
# 返回值只喂给一批手搓 Anthropic 原生 body 的 `invoke_model` 调用（bedrock_intent /
# next_steps / case_analyze / skill_dispatcher / case_classifier / progress_card ×2 /
# skill_authoring），换非 Claude 模型 = ValidationException。要统一得先把那些调用点
# 迁到 shared/llm_provider.py::invoke_llm。见 core/llm_pref_resolver.py 与
# infra/lib/notiops-backend-stack.ts 的 AgentModelIdParam 注释（spec R8）。
_ENV_DEFAULT = os.environ.get("BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-5")
_CACHE_TTL = 300  # 5 分钟

_cached_model_id: str | None = None
_cached_ts: float = 0.0


def get_bot_model_id() -> str:
    """返回当前应使用的 Bedrock 模型 ID。

    优先级:SSM Parameter(Dashboard 设置)→ 环境变量 → hardcoded default。
    带 5 分钟 TTL 缓存,热路径零延迟。
    """
    global _cached_model_id, _cached_ts

    now = time.time()
    if _cached_model_id and (now - _cached_ts) < _CACHE_TTL:
        return _cached_model_id

    try:
        region = os.environ.get("AWS_REGION", "us-east-1")
        client = boto3.client("ssm", region_name=region)
        resp = client.get_parameter(Name=_SSM_PARAMETER)
        value = resp.get("Parameter", {}).get("Value", "").strip()
        if value:
            _cached_model_id = value
            _cached_ts = now
            return value
    except Exception as e:
        error_name = type(e).__name__
        if "ParameterNotFound" not in error_name and "ParameterNotFound" not in str(e):
            logger.warning("SSM get_parameter failed, using fallback: %s", e)

    _cached_model_id = _ENV_DEFAULT
    _cached_ts = now
    return _ENV_DEFAULT


def reset_cache():
    """测试用:清除缓存,强制下次调用重新读 SSM。"""
    global _cached_model_id, _cached_ts
    _cached_model_id = None
    _cached_ts = 0.0
