"""Unified LLM provider — Bedrock / LiteLLM Proxy 共存抽象层。

设计原则：
1. 调用方只看到一个函数 `invoke_llm(model_id, system_prompt, user_prompt, max_tokens)`
   返回统一格式 `{"content": str, "stop_reason": str, "usage": dict}`
2. Provider 选择来自 SSM Parameter `/notiops/llm/provider`（值: "bedrock" | "litellm"），
   带 5 分钟 TTL 缓存。
3. 凭证：
   - bedrock：从 Secrets Manager `notiops/bedrock-api-key` 读 API Key（已存在）
   - litellm：从 Secrets Manager `notiops/litellm-config` 读 base_url + api_key
4. 失败处理：本函数只抛异常，调用方决定降级策略。

兼容性：
- 沿用现有 `bedrock_invoker.invoke_bedrock` 的签名 + 返回值；
  历史调用点零改动只需把导入换成 `from shared.llm_provider import invoke_llm`。
- LiteLLM 路径走 OpenAI Chat Completions 协议（POST /v1/chat/completions），
  不引入 LiteLLM Python SDK，纯 urllib + json 走 stdlib（保持 Lambda 启动快）。
"""

from __future__ import annotations
from shared.net import safe_urlopen

import ipaddress
import json
import logging
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


class LiteLLMConfigError(RuntimeError):
    """LiteLLM 配置不完整,无法调用。"""


class LiteLLMHTTPError(RuntimeError):
    """LiteLLM 端点返回非 2xx。"""


def _is_blocked_ip(addr) -> bool:
    """True if the IP is in a range base_url must never reach."""
    mapped = getattr(addr, "ipv4_mapped", None)
    if mapped is not None:
        addr = mapped  # treat ::ffff:169.254.x.x as the embedded IPv4
    return (
        addr.is_private or addr.is_loopback or addr.is_link_local
        or addr.is_reserved or addr.is_multicast or addr.is_unspecified
    )


def _validate_base_url(url: str) -> None:
    """校验 base_url 不指向内网地址，防止 SSRF。

    层次：localhost/IP 字面量黑名单 → .internal/.local 域名 → **DNS 解析**后
    校验所有 A/AAAA 记录都不是私网/环回/链路本地/保留地址（堵"公网域名解析
    到内网 IP"的绕过）。DNS 解析失败时不硬拦（best-effort，避免离线/解析抖动
    误伤；真正不可达时实际 HTTP 请求自然失败）。
    """
    parsed = urllib.parse.urlparse(url)
    hostname = parsed.hostname or ""
    if not hostname:
        raise LiteLLMConfigError("base_url has no hostname")
    if hostname in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):  # nosec B104 - membership check to REJECT these hosts, not a socket bind to all interfaces
        raise LiteLLMConfigError(f"base_url must not point to localhost: {hostname}")
    try:
        addr = ipaddress.ip_address(hostname)
        if _is_blocked_ip(addr):
            raise LiteLLMConfigError(
                f"base_url must not point to private/link-local address: {hostname}"
            )
        return
    except ValueError:
        # hostname 是域名，不是 IP
        pass
    if hostname.endswith(".internal") or hostname.endswith(".local"):
        raise LiteLLMConfigError(
            f"base_url must not point to internal hostname: {hostname}"
        )
    # 解析 DNS，逐一校验解析出的地址（防公网域名→内网 IP 绕过）
    try:
        infos = socket.getaddrinfo(hostname, parsed.port or 443,
                                   proto=socket.IPPROTO_TCP)
    except OSError:
        return  # 解析失败：best-effort 放行，实际请求会自然失败
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if _is_blocked_ip(addr):
            raise LiteLLMConfigError(
                f"base_url hostname {hostname} resolves to a private/link-local "
                f"address ({info[4][0]}) — refused to prevent SSRF"
            )

logger = logging.getLogger("shared.llm_provider")

# ---------------------------------------------------------------------------
# Provider 配置缓存（SSM Parameter） — 5 分钟 TTL
# ---------------------------------------------------------------------------

_PROVIDER_PARAM_NAME = "/notiops/llm/provider"
_PROVIDER_DEFAULT = "bedrock"
_PROVIDER_CACHE_TTL = 300

_cached_provider: str | None = None
_cached_provider_ts: float = 0.0


def _get_provider(force_refresh: bool = False) -> str:
    """读 SSM Parameter `/notiops/llm/provider`,带缓存。

    返回 "bedrock"(默认)或 "litellm"。
    任何错误都 fallback 到 "bedrock",保证不因配置读取问题挂掉。

    `LITELLM_PROVIDER_FORCE` 环境变量可以强制覆盖(测试 / debug 用)。

    Args:
        force_refresh: 跳过本进程缓存,直接读 SSM。
            invoke_llm 路径用 False(每次 invoke 多打 SSM 不划算);
            UI 触发的端点(如 _get_models / _get_llm_provider GET)用 True,
            让 Provider 切换立刻反映,无需等 5min TTL。
    """
    global _cached_provider, _cached_provider_ts

    forced = (os.environ.get("LITELLM_PROVIDER_FORCE") or "").strip().lower()
    if forced in ("bedrock", "litellm"):
        return forced

    now = time.time()
    if (
        not force_refresh
        and _cached_provider is not None
        and (now - _cached_provider_ts) < _PROVIDER_CACHE_TTL
    ):
        return _cached_provider

    region = os.environ.get("AWS_REGION", "us-east-1")
    try:
        client = boto3.client("ssm", region_name=region)
        resp = client.get_parameter(Name=_PROVIDER_PARAM_NAME)
        value = (resp.get("Parameter", {}).get("Value") or "").strip().lower()
        if value not in ("bedrock", "litellm"):
            value = _PROVIDER_DEFAULT
        _cached_provider = value
        _cached_provider_ts = now
        return value
    except ClientError as e:
        if e.response["Error"]["Code"] == "ParameterNotFound":
            _cached_provider = _PROVIDER_DEFAULT
            _cached_provider_ts = now
            return _PROVIDER_DEFAULT
        logger.warning("read provider from SSM failed, fallback bedrock: %s", e)
        _cached_provider = _PROVIDER_DEFAULT
        _cached_provider_ts = now
        return _PROVIDER_DEFAULT
    except Exception as e:
        logger.warning("read provider from SSM failed, fallback bedrock: %s", e)
        _cached_provider = _PROVIDER_DEFAULT
        _cached_provider_ts = now
        return _PROVIDER_DEFAULT


def reset_cache() -> None:
    """测试用 / 强制刷新 provider 选择(管理员页保存配置后立刻生效)。"""
    global _cached_provider, _cached_provider_ts, _cached_litellm, _cached_litellm_ts
    _cached_provider = None
    _cached_provider_ts = 0.0
    _cached_litellm = None
    _cached_litellm_ts = 0.0


# ---------------------------------------------------------------------------
# LiteLLM 配置(Secrets Manager) — 5 分钟 TTL
# ---------------------------------------------------------------------------

_LITELLM_SECRET_ID = os.environ.get(
    "LITELLM_CONFIG_SECRET_ARN", "notiops/litellm-config"
)
_LITELLM_CACHE_TTL = 300

_cached_litellm: dict | None = None
_cached_litellm_ts: float = 0.0


def _get_litellm_config() -> dict:
    """读 LiteLLM 配置 Secret,带缓存。

    Secret 内容形如:
      {"base_url": "https://xxx", "api_key": "sk-xxx", "default_model": "bedrock/..."}
    """
    global _cached_litellm, _cached_litellm_ts
    now = time.time()
    if _cached_litellm is not None and (now - _cached_litellm_ts) < _LITELLM_CACHE_TTL:
        return _cached_litellm

    region = os.environ.get("AWS_REGION", "us-east-1")
    try:
        client = boto3.client("secretsmanager", region_name=region)
        resp = client.get_secret_value(SecretId=_LITELLM_SECRET_ID)
        cfg = json.loads(resp["SecretString"]) or {}
    except Exception as e:
        logger.warning("read LiteLLM config secret failed: %s", e)
        cfg = {}

    # 规范化
    cfg = {
        "base_url": (cfg.get("base_url") or "").rstrip("/"),
        "api_key": cfg.get("api_key") or "",
        "default_model": cfg.get("default_model") or "",
    }
    _cached_litellm = cfg
    _cached_litellm_ts = now
    return cfg


# ---------------------------------------------------------------------------
# Bedrock — 复用 lambda3 现有 invoke 逻辑(import 它,避免代码漂移)
# ---------------------------------------------------------------------------

_TRUNCATION_NOTICE = "\n\n---\n⚠️ 报告因 token 限制被截断,部分内容可能不完整。"

_bedrock_config = Config(
    read_timeout=300,
    connect_timeout=10,
    retries={"max_attempts": 2, "mode": "adaptive"},
)

# Bedrock API Key 缓存(独立于 lambda3,避免循环 import)
_BEDROCK_API_KEY_SECRET_ENV = "BEDROCK_API_KEY_SECRET_ARN"  # nosec B105 - env var *name*, not a credential
_cached_bedrock_key: str | None = None
_cached_bedrock_key_ts: float = 0.0


def _get_bedrock_api_key() -> str | None:
    global _cached_bedrock_key, _cached_bedrock_key_ts
    now = time.time()
    if _cached_bedrock_key is not None and (now - _cached_bedrock_key_ts) < 300:
        return _cached_bedrock_key or None

    secret_arn = os.environ.get(_BEDROCK_API_KEY_SECRET_ENV, "")
    if not secret_arn:
        return None
    try:
        region = os.environ.get("AWS_REGION", "us-east-1")
        client = boto3.client("secretsmanager", region_name=region)
        resp = client.get_secret_value(SecretId=secret_arn)
        secret_dict = json.loads(resp["SecretString"])
        api_key = secret_dict.get("bedrock_api_key", "") or ""
        _cached_bedrock_key = api_key
        _cached_bedrock_key_ts = now
        return api_key or None
    except Exception as e:
        logger.warning("read Bedrock API key secret failed: %s", e)
        _cached_bedrock_key = ""
        _cached_bedrock_key_ts = now
        return None


def _invoke_bedrock(
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
) -> dict:
    api_key = _get_bedrock_api_key()
    if api_key:
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = api_key
    else:
        os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)

    client = boto3.client("bedrock-runtime", config=_bedrock_config)
    try:
        response = client.converse(
            modelId=model_id,
            system=[{"text": system_prompt}],
            messages=[{"role": "user", "content": [{"text": user_prompt}]}],
            inferenceConfig={"maxTokens": max_tokens},
        )
    except ClientError as e:
        logger.error(
            "Bedrock converse failed: code=%s message=%s model=%s",
            e.response["Error"]["Code"],
            e.response["Error"]["Message"],
            model_id,
        )
        raise

    output = response.get("output", {})
    message = output.get("message", {})
    content_blocks = message.get("content", [])
    content = content_blocks[0].get("text", "") if content_blocks else ""
    stop_reason = response.get("stopReason", "")
    usage = response.get("usage", {})

    if stop_reason == "max_tokens":
        content += _TRUNCATION_NOTICE

    return {"content": content, "stop_reason": stop_reason, "usage": usage}


# ---------------------------------------------------------------------------
# LiteLLM Proxy(OpenAI Chat Completions 协议)
# ---------------------------------------------------------------------------


def _invoke_litellm(
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
) -> dict:
    cfg = _get_litellm_config()
    base_url = cfg["base_url"]
    api_key = cfg["api_key"]
    if not base_url or not api_key:
        raise LiteLLMConfigError(
            "LiteLLM is selected as provider but base_url/api_key not configured "
            "in Secrets Manager. Fill them in Dashboard → AI 认证 → LiteLLM."
        )
    _validate_base_url(base_url)

    # 如果调用方传的 model_id 是 Bedrock 推理 profile(global.anthropic.* 等),
    # 自动给它加 LiteLLM 期望的 "bedrock/" 前缀;否则原样透传。
    if "/" not in model_id and model_id and not model_id.startswith("bedrock/"):
        model_for_litellm = f"bedrock/{model_id}"
    else:
        model_for_litellm = model_id

    payload = {
        "model": model_for_litellm,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
    }
    body = json.dumps(payload).encode("utf-8")
    url = f"{base_url}/v1/chat/completions"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        # 与 Bedrock invoker 一致用 5min 超时
        with safe_urlopen(req, timeout=300) as resp:  # noqa: S310 (固定 https)
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read().decode("utf-8", errors="replace")[:1000]
        except Exception:
            pass
        logger.error(
            "LiteLLM HTTP %s for model=%s url=%s body=%s",
            e.code, model_for_litellm, url, body_txt,
        )
        raise LiteLLMHTTPError(
            f"LiteLLM proxy returned HTTP {e.code}: {body_txt[:200]}"
        ) from e
    except Exception as e:
        logger.error("LiteLLM request failed: %s url=%s", e, url)
        raise

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise LiteLLMHTTPError(
            f"LiteLLM returned non-JSON body: {raw[:200]}"
        ) from e

    if "error" in data:
        err = data["error"]
        msg = err.get("message", "") if isinstance(err, dict) else str(err)
        raise LiteLLMHTTPError(f"LiteLLM error: {msg[:300]}")

    choices = data.get("choices") or []
    if not choices:
        raise LiteLLMHTTPError(f"LiteLLM returned no choices: {raw[:200]}")
    msg_obj = (choices[0] or {}).get("message") or {}
    content = msg_obj.get("content", "") or ""
    finish_reason = (choices[0] or {}).get("finish_reason", "") or ""
    usage = data.get("usage") or {}

    # 把 OpenAI 的 finish_reason 翻成 Bedrock 用的同义词,
    # 让上层判断 (== "max_tokens") 的代码继续工作。
    stop_reason = {
        "stop": "end_turn",
        "length": "max_tokens",
        "content_filter": "content_filtered",
        "tool_calls": "tool_use",
    }.get(finish_reason, finish_reason or "end_turn")

    if stop_reason == "max_tokens":
        content += _TRUNCATION_NOTICE

    # 把 OpenAI 的 usage 名字标准化成 Bedrock 风格,日志和监控能看
    bedrock_usage = {
        "inputTokens": usage.get("prompt_tokens", 0),
        "outputTokens": usage.get("completion_tokens", 0),
        "totalTokens": usage.get("total_tokens", 0),
    }

    logger.info(
        "LiteLLM converse completed: model=%s stop=%s usage=%s",
        model_for_litellm, stop_reason, bedrock_usage,
    )

    return {
        "content": content,
        "stop_reason": stop_reason,
        "usage": bedrock_usage,
    }


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------


def invoke_llm(
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 16000,
) -> dict:
    """统一 LLM 调用入口,根据 SSM 中的 provider 选择走 Bedrock 或 LiteLLM。

    Args:
        model_id: 模型 ID。Bedrock 模式用推理 profile(如 global.anthropic.claude-opus-4-7);
                  LiteLLM 模式可以传裸名(自动加 bedrock/ 前缀)或带 provider 前缀。
        system_prompt: 系统提示词
        user_prompt: 用户提示词
        max_tokens: 最大输出 token 数

    Returns:
        {"content": str, "stop_reason": str, "usage": dict}
        usage 字段名与 Bedrock 一致(inputTokens / outputTokens / totalTokens)。

    Raises:
        ClientError: Bedrock 调用失败(限流、模型不可用)
        LiteLLMConfigError: 选择 LiteLLM 但配置不完整
        LiteLLMHTTPError: LiteLLM 端点返回非 2xx 或非 JSON
    """
    provider = _get_provider()
    logger.info(
        "invoke_llm provider=%s model=%s sys_len=%d user_len=%d max_tokens=%d",
        provider, model_id, len(system_prompt), len(user_prompt), max_tokens,
    )
    if provider == "litellm":
        return _invoke_litellm(model_id, system_prompt, user_prompt, max_tokens)
    return _invoke_bedrock(model_id, system_prompt, user_prompt, max_tokens)
