"""API 路由:LLM provider 切换 + LiteLLM 配置。

提供 4 个端点:
  GET  /api/system-config/llm-provider              — 当前 provider + LiteLLM 概况(api_key 脱敏)
  PUT  /api/system-config/llm-provider              — 切 provider(写 SSM Parameter)
  PUT  /api/system-config/litellm-config            — 写 LiteLLM Secret(base_url/api_key/default_model)
  POST /api/system-config/litellm-test              — 现场拨号测试,不入库

设计原则:
- API Key 永远脱敏后返回(只显示前 4 位 + 后 4 位)
- Provider 切换是 provider-only(不动模型)
- 所有写都触发 `shared.llm_provider.reset_cache()`,让 Lambda 进程内 5min 缓存立刻失效
  (其他 Lambda 容器要等本地 5min TTL 自然过期 — 这是可接受的最终一致)

存储:
- Provider 选择: SSM Parameter `/notiops/llm/provider` ("bedrock"|"litellm")
- LiteLLM 凭证: Secrets Manager `notiops/litellm-config`
  Secret JSON: {"base_url": "...", "api_key": "...", "default_model": "..."}

错误处理:
- 配置缺失 → 200 OK,字段为空,前端能区分"未配置"vs"配置错"
- SSM/Secrets Manager API 错误 → 500
- 拨号 (test) 失败 → 200 + ok:false + reason
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

import boto3
from shared.llm_provider import _validate_base_url, LiteLLMConfigError
from shared.net import safe_urlopen  # B310: scheme-validated urlopen wrapper

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

_PROVIDER_PARAM_NAME = "/notiops/llm/provider"
_PROVIDER_DEFAULT = "bedrock"
_VALID_PROVIDERS = {"bedrock", "litellm"}
_LITELLM_SECRET_ID_DEFAULT = "notiops/litellm-config"  # nosec B105 - Secrets Manager secret id (reference), not a credential


def _litellm_secret_id() -> str:
    return os.environ.get("LITELLM_CONFIG_SECRET_ARN", _LITELLM_SECRET_ID_DEFAULT)


# ---------------------------------------------------------------------------
# 容器级 boto3 client 单例
# ---------------------------------------------------------------------------

_ssm_client = None
_secrets_client = None


def _get_ssm_client():
    global _ssm_client
    if _ssm_client is None:
        region = os.environ.get("AWS_REGION", "us-east-1")
        _ssm_client = boto3.client("ssm", region_name=region)
    return _ssm_client


def _get_secrets_client():
    global _secrets_client
    if _secrets_client is None:
        region = os.environ.get("AWS_REGION", "us-east-1")
        _secrets_client = boto3.client("secretsmanager", region_name=region)
    return _secrets_client


def _mask_api_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "****"
    return f"{key[:4]}…{key[-4:]}"


# ---------------------------------------------------------------------------
# 分发
# ---------------------------------------------------------------------------


def handle_system_config(method, path, query_params, path_params, body):
    """路由分发:/api/system-config 及子路径。"""
    normalized = path.rstrip("/") if path != "/" else path

    if method == "GET" and normalized == "/api/system-config/llm-provider":
        return _get_llm_provider()
    if method == "PUT" and normalized == "/api/system-config/llm-provider":
        return _put_llm_provider(body)
    if method == "PUT" and normalized == "/api/system-config/litellm-config":
        return _put_litellm_config(body)
    if method == "POST" and normalized == "/api/system-config/litellm-test":
        return _test_litellm(body)
    if method == "GET" and normalized == "/api/system-config/litellm-models":
        return _list_litellm_models()
    if method == "GET" and normalized == "/api/system-config/bedrock-models":
        return _list_bedrock_models()

    raise ValueError(f"Method {method} not allowed for {path}")


# ---------------------------------------------------------------------------
# GET /api/system-config/llm-provider
# ---------------------------------------------------------------------------


def _get_llm_provider() -> dict:
    """返回当前 provider + LiteLLM 配置概况(脱敏)。"""
    # provider 选择
    try:
        resp = _get_ssm_client().get_parameter(Name=_PROVIDER_PARAM_NAME)
        value = (resp.get("Parameter", {}).get("Value") or "").strip().lower()
        provider = value if value in _VALID_PROVIDERS else _PROVIDER_DEFAULT
        provider_source = "ssm"
    except _get_ssm_client().exceptions.ParameterNotFound:
        provider = _PROVIDER_DEFAULT
        provider_source = "default"
    except Exception:
        logger.exception("read provider parameter failed")
        return {
            "_status_code": 500,
            "error": "InternalServerError",
            "message": "read SSM parameter failed",
        }

    # LiteLLM 配置(脱敏)
    litellm_cfg = {"base_url": "", "default_model": "", "api_key_masked": ""}
    try:
        secret_resp = _get_secrets_client().get_secret_value(SecretId=_litellm_secret_id())
        try:
            cfg = json.loads(secret_resp["SecretString"]) or {}
        except Exception:
            cfg = {}
        litellm_cfg = {
            "base_url": (cfg.get("base_url") or "").rstrip("/"),
            "default_model": cfg.get("default_model") or "",
            "api_key_masked": _mask_api_key(cfg.get("api_key") or ""),
        }
    except _get_secrets_client().exceptions.ResourceNotFoundException:
        # 首次部署,Secret 还不存在 — 返回空字段,前端展示"未配置"
        pass
    except Exception as e:
        logger.warning("read LiteLLM secret failed: %s", e)

    return {
        "provider": provider,
        "provider_source": provider_source,
        "litellm": litellm_cfg,
        "parameter_name": _PROVIDER_PARAM_NAME,
        "litellm_secret_id": _litellm_secret_id(),
    }


# ---------------------------------------------------------------------------
# PUT /api/system-config/llm-provider
# ---------------------------------------------------------------------------


def _put_llm_provider(body) -> dict:
    """切换 provider。Body: {"provider": "bedrock"|"litellm"}"""
    if isinstance(body, str):
        try:
            body = json.loads(body) if body else {}
        except json.JSONDecodeError:
            return {"_status_code": 400, "error": "BadRequest",
                    "message": "body must be JSON object"}

    if not isinstance(body, dict):
        return {"_status_code": 400, "error": "BadRequest",
                "message": "body must be JSON object"}

    provider = (body.get("provider") or "").strip().lower()
    if provider not in _VALID_PROVIDERS:
        return {"_status_code": 400, "error": "BadRequest",
                "message": f"provider must be one of {sorted(_VALID_PROVIDERS)}"}

    # 切到 litellm 前,要求 LiteLLM 已经配置好
    if provider == "litellm":
        try:
            secret_resp = _get_secrets_client().get_secret_value(SecretId=_litellm_secret_id())
            cfg = json.loads(secret_resp.get("SecretString") or "{}")
            if not (cfg.get("base_url") and cfg.get("api_key")):
                return {
                    "_status_code": 400, "error": "ConfigIncomplete",
                    "message": "LiteLLM base_url + api_key must be set first "
                               "(PUT /api/system-config/litellm-config).",
                }
        except _get_secrets_client().exceptions.ResourceNotFoundException:
            return {
                "_status_code": 400, "error": "ConfigIncomplete",
                "message": "LiteLLM secret not found; configure it first.",
            }

    try:
        _get_ssm_client().put_parameter(
            Name=_PROVIDER_PARAM_NAME,
            Value=provider,
            Type="String",
            Overwrite=True,
        )
    except Exception:
        logger.exception("put SSM parameter failed")
        return {"_status_code": 500, "error": "InternalServerError",
                "message": "put SSM parameter failed"}

    # API Lambda 进程内缓存清掉 — 别的 Lambda 容器 5min 自然过期
    try:
        from shared import llm_provider as _llm
        _llm.reset_cache()
    except Exception:
        pass

    logger.info("LLM provider switched to %s", provider)
    return {"provider": provider, "ok": True}


# ---------------------------------------------------------------------------
# PUT /api/system-config/litellm-config
# ---------------------------------------------------------------------------


def _put_litellm_config(body) -> dict:
    """更新 LiteLLM Secret。Body: {"base_url": "...", "api_key": "...", "default_model": "..."}"""
    if isinstance(body, str):
        try:
            body = json.loads(body) if body else {}
        except json.JSONDecodeError:
            return {"_status_code": 400, "error": "BadRequest",
                    "message": "body must be JSON object"}

    if not isinstance(body, dict):
        return {"_status_code": 400, "error": "BadRequest",
                "message": "body must be JSON object"}

    base_url = (body.get("base_url") or "").strip().rstrip("/")
    api_key = (body.get("api_key") or "").strip()
    default_model = (body.get("default_model") or "").strip()

    if base_url and not (base_url.startswith("http://") or base_url.startswith("https://")):
        return {"_status_code": 400, "error": "BadRequest",
                "message": "base_url must start with http:// or https://"}

    if base_url:
        try:
            _validate_base_url(base_url)
        except LiteLLMConfigError as e:
            return {"_status_code": 400, "error": "BadRequest",
                    "message": str(e)}

    # 读现有(允许"只更新部分字段" — 比如只改 default_model 不动 key)
    sm = _get_secrets_client()
    sid = _litellm_secret_id()
    existing = {}
    try:
        existing_str = sm.get_secret_value(SecretId=sid).get("SecretString", "{}")
        existing = json.loads(existing_str) or {}
    except sm.exceptions.ResourceNotFoundException:
        existing = {}
    except Exception:
        existing = {}

    new_cfg = {
        "base_url": base_url or existing.get("base_url", ""),
        "api_key": api_key or existing.get("api_key", ""),
        "default_model": default_model or existing.get("default_model", ""),
    }

    try:
        sm.get_secret_value(SecretId=sid)
        sm.put_secret_value(SecretId=sid, SecretString=json.dumps(new_cfg))
    except sm.exceptions.ResourceNotFoundException:
        sm.create_secret(Name=sid, SecretString=json.dumps(new_cfg),
                         Description="LiteLLM proxy config (base_url/api_key/default_model).")
    except Exception:
        logger.exception("put LiteLLM secret failed")
        return {"_status_code": 500, "error": "InternalServerError",
                "message": "put secret failed"}

    try:
        from shared import llm_provider as _llm
        _llm.reset_cache()
    except Exception:
        pass

    return {
        "ok": True,
        "litellm": {
            "base_url": new_cfg["base_url"],
            "default_model": new_cfg["default_model"],
            "api_key_masked": _mask_api_key(new_cfg["api_key"]),
        },
    }


# ---------------------------------------------------------------------------
# POST /api/system-config/litellm-test
# ---------------------------------------------------------------------------


def _test_litellm(body) -> dict:
    """现场拨号 LiteLLM,不入库。

    Body 可选:
      {"base_url": "...", "api_key": "...", "model": "..."}
    任意字段省略 → 用 Secret 里已有值。
    返回 {"ok": bool, "reason": str?, "latency_ms": int?, "model": str, "content": str?}
    """
    if isinstance(body, str):
        try:
            body = json.loads(body) if body else {}
        except json.JSONDecodeError:
            body = {}
    body = body if isinstance(body, dict) else {}

    sm = _get_secrets_client()
    existing = {}
    try:
        existing_str = sm.get_secret_value(SecretId=_litellm_secret_id()).get("SecretString", "{}")
        existing = json.loads(existing_str) or {}
    except Exception:
        existing = {}

    base_url = (body.get("base_url") or existing.get("base_url") or "").rstrip("/")
    api_key = body.get("api_key") or existing.get("api_key") or ""
    model = body.get("model") or existing.get("default_model") or "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"

    if not base_url or not api_key:
        return {"ok": False, "reason": "base_url and api_key are required",
                "model": model}

    try:
        _validate_base_url(base_url)
    except LiteLLMConfigError as e:
        return {"ok": False, "reason": str(e), "model": model}

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": "Reply with only the literal word OK."},
            {"role": "user", "content": "ping"},
        ],
        "max_tokens": 10,
    }
    req = urllib.request.Request(
        f"{base_url}/v1/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    import time as _time
    started = _time.time()
    try:
        with safe_urlopen(req, timeout=20) as resp:  # scheme validated (http/https only)
            raw = resp.read().decode("utf-8")
        data = json.loads(raw)
        if "error" in data:
            return {"ok": False, "reason": str(data["error"])[:200], "model": model}
        choices = data.get("choices") or []
        content = (choices[0] or {}).get("message", {}).get("content", "") if choices else ""
        latency_ms = int((_time.time() - started) * 1000)
        return {"ok": True, "model": model, "content": content[:200],
                "latency_ms": latency_ms, "usage": data.get("usage")}
    except urllib.error.HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        return {"ok": False, "reason": f"HTTP {e.code}: {body_txt}", "model": model}
    except Exception as e:
        return {"ok": False, "reason": f"{type(e).__name__}: {e}", "model": model}


# ---------------------------------------------------------------------------
# GET /api/system-config/litellm-models
# ---------------------------------------------------------------------------


# Dev / placeholder model ids that LiteLLM Proxy ships with — never list these
# in the dashboard (they're intentionally non-functional and would just confuse
# operators looking at a real model selector).
_LITELLM_DEV_FIXTURE_IDS = {
    "my-special-fake-model-alias-name",
    "gpt-3.5-turbo-end-user-test",
    "fake-openai-endpoint",
    "fake-openai-endpoint-2",
    "fake-openai-endpoint-3",
    "fake-openai-endpoint-4",
    "fake-openai-endpoint-5",
    "bad-model",
    "good-model",
    "badly-configured-openai-endpoint",
    "*",
    "anthropic/*",
    "bedrock/*",
    "groq/*",
    "sagemaker-completion-model",  # 此 proxy 后端 IAM 不全,实测 403
}

# Embedding / image / audio 等非 chat-completion 模型在巡检场景里没用,
# 也过滤掉避免大哥误选。
_LITELLM_NON_CHAT_PATTERNS = (
    "embed",
    "rerank",
    "image-generator",
    "stable-diffusion",
    "stable-image",
    "stable-creative",
    "stable-conservative",
    "stable-fast",
    "stable-style",
    "stable-outpaint",
    "nova-canvas",
    "tts",
    "whisper",
    "voxtral",
    "marengo",
    "pegasus",
    "playai",
    "dall-e",
    "realtime",
)


def _is_chat_model(model_id: str) -> bool:
    """简单启发式过滤,只留 chat-completion 类模型。"""
    if model_id in _LITELLM_DEV_FIXTURE_IDS:
        return False
    lower = model_id.lower()
    return not any(p in lower for p in _LITELLM_NON_CHAT_PATTERNS)


def _list_litellm_models() -> dict:
    """转发 LiteLLM Proxy `/v1/models`,过滤掉 dev fixture/非 chat 模型。

    返回:
      {
        "models": [{"id": "...", "provider": "bedrock"|"anthropic"|"groq"|"other"},
                   ...],
        "default_model": "<当前 Secret 里的 default_model>",
        "base_url": "<当前 Secret 里的 base_url>"
      }

    出错:
      - Secret 不存在或 base_url/api_key 缺 → 200 但 models=[],reason 字段提示
      - LiteLLM Proxy 不可达 → 200 但 models=[],reason 字段含 HTTP 信息
    """
    sm = _get_secrets_client()
    cfg = {}
    try:
        existing_str = sm.get_secret_value(SecretId=_litellm_secret_id()).get(
            "SecretString", "{}"
        )
        cfg = json.loads(existing_str) or {}
    except Exception:
        cfg = {}

    base_url = (cfg.get("base_url") or "").rstrip("/")
    api_key = cfg.get("api_key") or ""
    default_model = cfg.get("default_model") or ""

    if not base_url or not api_key:
        return {
            "models": [],
            "default_model": default_model,
            "base_url": base_url,
            "reason": "LiteLLM not configured (base_url/api_key missing)",
        }

    try:
        _validate_base_url(base_url)
    except LiteLLMConfigError as e:
        return {
            "models": [],
            "default_model": default_model,
            "base_url": base_url,
            "reason": f"base_url rejected: {e}",
        }

    url = f"{base_url}/v1/models"
    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
        },
    )
    try:
        with safe_urlopen(req, timeout=15) as resp:  # scheme validated (http/https only)
            raw = resp.read().decode("utf-8")
        data = json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read().decode("utf-8", errors="replace")[:200]
        except Exception:
            pass
        return {
            "models": [],
            "default_model": default_model,
            "base_url": base_url,
            "reason": f"HTTP {e.code} from LiteLLM /v1/models: {body_txt}",
        }
    except Exception as e:
        return {
            "models": [],
            "default_model": default_model,
            "base_url": base_url,
            "reason": f"{type(e).__name__}: {e}",
        }

    raw_ids = []
    for entry in data.get("data") or []:
        mid = entry.get("id") if isinstance(entry, dict) else None
        if isinstance(mid, str) and mid:
            raw_ids.append(mid)

    filtered: list[dict] = []
    for mid in raw_ids:
        if not _is_chat_model(mid):
            continue
        provider = "other"
        if mid.startswith("bedrock/"):
            provider = "bedrock"
        elif mid.startswith("anthropic/"):
            provider = "anthropic"
        elif mid.startswith("groq/"):
            provider = "groq"
        elif "/" not in mid:
            provider = "openai"
        filtered.append({"id": mid, "provider": provider})

    # 按 provider+id 字典序稳定排序,便于 UI 分组展示
    filtered.sort(key=lambda m: (m["provider"], m["id"]))

    return {
        "models": filtered,
        "default_model": default_model,
        "base_url": base_url,
    }


# ---------------------------------------------------------------------------
# GET /api/system-config/bedrock-models
# ---------------------------------------------------------------------------


def _list_bedrock_models() -> dict:
    """始终从 Bedrock SDK 拉取模型列表（不跟随全局 provider 切换）。

    用于 Bedrock 默认模型配置区域 — 无论当前全局 provider 是什么，
    这里都只列 Bedrock 原生模型。
    """
    region = os.environ.get("AWS_REGION", "us-east-1")
    client = boto3.client("bedrock", region_name=region)
    models = []
    seen_ids: set = set()

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
    return {"models": models}
