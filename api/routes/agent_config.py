"""API 路由：飞书 AI 助手（AgentCore Runtime）模型配置。

提供 3 个端点：
  - GET  /api/agent-config         — 返回当前 model_id
  - GET  /api/agent-config/models  — 返回可选模型列表（ListInferenceProfiles + ListFoundationModels 合并）
  - PUT  /api/agent-config         — 更新 model_id（写入 SSM Parameter Store）

配置存储在 SSM Parameter `/notiops/agent/model_id`。Agent Runtime 通过模块级 TTL 缓存
（300 秒）读取该 Parameter，切换最多 5 分钟生效。

spec: agent-model-config-integration
"""
import logging
import os
from datetime import datetime, timezone

import boto3

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量（与 agent/core.py 保持同步）
# ---------------------------------------------------------------------------

_MODEL_ID_SSM_PARAMETER = "/notiops/agent/model_id"
_HARDCODED_DEFAULT_MODEL_ID = "global.anthropic.claude-opus-4-7"
_MAX_MODEL_ID_LENGTH = 512

# ---------------------------------------------------------------------------
# 容器级 boto3 client 缓存（G4: region 显式传递）
# ---------------------------------------------------------------------------

_ssm_client = None
_bedrock_client = None


def _get_ssm_client():
    """容器级 SSM client 单例，region 显式传递（对齐 agent/core.py pattern）。"""
    global _ssm_client
    if _ssm_client is None:
        region = os.environ.get("AWS_REGION", "us-east-1")
        _ssm_client = boto3.client("ssm", region_name=region)
    return _ssm_client


def _get_bedrock_client():
    """容器级 Bedrock client 单例，region 显式传递。"""
    global _bedrock_client
    if _bedrock_client is None:
        region = os.environ.get("AWS_REGION", "us-east-1")
        _bedrock_client = boto3.client("bedrock", region_name=region)
    return _bedrock_client


# ---------------------------------------------------------------------------
# 顶层分发
# ---------------------------------------------------------------------------


def handle_agent_config(method, path, query_params, path_params, body):
    """路由分发：/api/agent-config 及子路径。

    分发顺序重要：/models 子路径必须在根路径前匹配。
    """
    # 归一化尾斜杠
    normalized_path = path.rstrip("/") if path != "/" else path

    if method == "GET" and normalized_path.endswith("/models"):
        return _list_models()
    if method == "GET" and normalized_path == "/api/agent-config":
        return _get_current()
    if method == "PUT" and normalized_path == "/api/agent-config":
        return _put_current(body)

    raise ValueError(f"Method {method} not allowed for {path}")


# ---------------------------------------------------------------------------
# _get_current
# ---------------------------------------------------------------------------


def _get_current() -> dict:
    """GET /api/agent-config — 返回当前 model_id。

    Returns:
      {model_id, source, parameter_name}
        - source="ssm"     ← SSM 返回非空非空白字符串
        - source="default" ← ParameterNotFound / 空值 / 纯空白

    SSM 其他异常 → 返回 {_status_code: 500, error, message}。
    """
    try:
        resp = _get_ssm_client().get_parameter(Name=_MODEL_ID_SSM_PARAMETER)
        value = resp.get("Parameter", {}).get("Value", "")
        if isinstance(value, str) and value.strip():
            return {
                "model_id": value,
                "source": "ssm",
                "parameter_name": _MODEL_ID_SSM_PARAMETER,
            }
        # 空值或纯空白 → 归入 default
        return {
            "model_id": _HARDCODED_DEFAULT_MODEL_ID,
            "source": "default",
            "parameter_name": _MODEL_ID_SSM_PARAMETER,
        }
    except Exception as e:
        # ParameterNotFound 归入 default（200）
        if type(e).__name__ == "ParameterNotFound" or "ParameterNotFound" in str(e):
            return {
                "model_id": _HARDCODED_DEFAULT_MODEL_ID,
                "source": "default",
                "parameter_name": _MODEL_ID_SSM_PARAMETER,
            }
        logger.error("GetParameter failed: %s", e)
        return {
            "_status_code": 500,
            "error": "InternalServerError",
            "message": "read agent model config failed",
        }


# ---------------------------------------------------------------------------
# _list_models
# ---------------------------------------------------------------------------


def _get_llm_provider_for_models() -> str:
    """读 SSM provider（force refresh，UI 端点需即时反映切换）。"""
    try:
        from shared.llm_provider import _get_provider
        return _get_provider(force_refresh=True)
    except Exception:
        return "bedrock"


def _list_models() -> dict:
    """GET /api/agent-config/models — provider-aware 模型列表。"""
    provider = _get_llm_provider_for_models()

    if provider == "litellm":
        try:
            from api.routes.system_config import _list_litellm_models
            data = _list_litellm_models()
        except Exception as e:
            logger.exception("LiteLLM models fetch failed: %s", e)
            return {"models": [], "llm_provider": "litellm",
                    "litellm_reason": f"{type(e).__name__}: {e}"}

        out_models = [
            {"model_id": m["id"], "model_name": m["id"], "provider": m.get("provider", "other")}
            for m in (data.get("models") or [])
        ]
        result: dict = {"models": out_models, "llm_provider": "litellm"}
        if data.get("reason"):
            result["litellm_reason"] = data["reason"]
        return result

    # Bedrock 路径（保留原逻辑）
    client = _get_bedrock_client()
    models = []
    seen_ids = set()

    try:
        paginator = client.get_paginator("list_inference_profiles")
        for page in paginator.paginate():
            for profile in page.get("inferenceProfileSummaries", []):
                profile_id = profile.get("inferenceProfileId", "")
                profile_name = profile.get("inferenceProfileName", "")
                status = profile.get("status", "")
                if status == "ACTIVE" and profile_id and profile_id not in seen_ids:
                    seen_ids.add(profile_id)
                    models.append({"model_id": profile_id, "model_name": profile_name or profile_id})
    except Exception as e:
        logger.error("Failed to list inference profiles: %s", e)

    try:
        resp = client.list_foundation_models(byOutputModality="TEXT")
        for model in resp.get("modelSummaries", []):
            model_id = model.get("modelId", "")
            model_name = model.get("modelName", "")
            throughput = model.get("inferenceTypesSupported", [])
            if "ON_DEMAND" in throughput and model_id and model_id not in seen_ids:
                seen_ids.add(model_id)
                models.append({"model_id": model_id, "model_name": model_name or model_id})
    except Exception as e:
        logger.error("Failed to list foundation models: %s", e)

    models.sort(key=lambda m: m["model_name"].lower())
    return {"models": models, "llm_provider": "bedrock"}


# ---------------------------------------------------------------------------
# _put_current
# ---------------------------------------------------------------------------


def _put_current(body) -> dict:
    """PUT /api/agent-config — 校验并写入 SSM Parameter。

    校验失败 raise ValueError（由 handler.py 转为 HTTP 400）。
    SSM PutParameter 失败返回 {_status_code: 500, error, message}。
    """
    # 1. body 存在 + 字段存在 + 是字符串
    if not isinstance(body, dict) or "model_id" not in body or not isinstance(body["model_id"], str):
        raise ValueError("model_id is required and must be a string")

    model_id = body["model_id"]

    # 2. 非空非空白
    if model_id.strip() == "":
        raise ValueError("model_id must not be empty")

    # 3. 长度上限
    if len(model_id) > _MAX_MODEL_ID_LENGTH:
        raise ValueError(f"model_id exceeds maximum length of {_MAX_MODEL_ID_LENGTH} characters")

    # 写入 SSM
    try:
        _get_ssm_client().put_parameter(
            Name=_MODEL_ID_SSM_PARAMETER,
            Value=model_id,
            Type="String",
            Overwrite=True,
        )
    except Exception as e:
        logger.error("PutParameter failed: %s", e)
        return {
            "_status_code": 500,
            "error": "InternalServerError",
            "message": "save agent model config failed",
        }

    return {
        "model_id": model_id,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
