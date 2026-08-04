"""DevOps Agent 调查长报告 → Bedrock 短卡片精简模块。

调用 Bedrock Converse API，把 `ListJournalRecords` 拉到的 investigation_summary_md
长报告精简成结构化短卡片（Symptoms / Root Cause / Findings，中文 200–400 字）。

设计要点：

- 认证模式与 phd_event_forwarder/summarizer.py 保持一致：
  BEDROCK_API_KEY_SECRET_ARN 配置了就用 Bearer Token，否则走 IAM 凭证
- 指数退避重试：最多 3 次（1s / 2s / 4s），只重试 Throttling 与 ServiceUnavailable
  类短暂错误，ValidationException 等不可重试错误直接抛
- 失败时抛异常，**不在本函数内降级**：调用方（报告管道 _summarize_with_degrade）
  捕获异常后自行降级（用截断的 long_report[:N] 当 summary_card，保持单一职责）

Requirements: R6.4, R6.6, R6.7, R11.9, R18.5
"""

import json
import logging
import os
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

logger = logging.getLogger("shared.bedrock_summarizer")


# ---------------------------------------------------------------------------
# Bedrock 客户端配置
# ---------------------------------------------------------------------------

# 轻量模型，短卡片输出，超时适中（与 phd_event_forwarder 一致）
_bedrock_config = Config(
    read_timeout=60,
    connect_timeout=10,
    retries={"max_attempts": 2, "mode": "adaptive"},
)

_DEFAULT_REGION = "ap-northeast-1"
_MAX_TOKENS = 1024

# 重试策略（指数退避）
_MAX_ATTEMPTS = 3
_INITIAL_BACKOFF_SECONDS = 1.0
_RETRYABLE_ERROR_CODES = (
    "ThrottlingException",
    "Throttling",
    "TooManyRequestsException",
    "ServiceUnavailableException",
    "ServiceUnavailable",
)


# ---------------------------------------------------------------------------
# 默认 System Prompt
# ---------------------------------------------------------------------------

_DEFAULT_SYSTEM_PROMPT = """你是一位 AWS 运维专家助手。你的任务是把一份较长的 AWS DevOps Agent 调查报告精简为结构化短卡片。

要求：
1. 用中文输出，必须包含以下三个章节：
   **症状 (Symptoms)** - 1-3 条 bullet，说明现象与影响范围
   **根因 (Root Cause)** - 1-2 句，定位的直接原因
   **关键发现 (Findings)** - 1-3 条 bullet，调查过程中关键证据或配置问题
2. 保留关键技术术语（资源 ID、Region、ARN、服务名等）不翻译
3. 输出总长度控制在 400 字以内
4. 避免"根据报告显示"、"综上所述"之类的冗余表达
5. 输出格式为 Markdown，不要额外解释"""


# ---------------------------------------------------------------------------
# API Key 缓存（与 phd_event_forwarder/summarizer.py 模式一致）
# ---------------------------------------------------------------------------

_cached_api_key: str | None = None
_cached_api_key_ts: float = 0.0
_API_KEY_CACHE_TTL = 300  # 5 分钟


def _get_api_key() -> str | None:
    """从 Secrets Manager 读取 Bedrock API Key（带缓存）。

    Secret ARN 来自 BEDROCK_API_KEY_SECRET_ARN 环境变量。
    读取失败、未配置或值为空时返回 None，调用方回退到 IAM 凭证。
    """
    global _cached_api_key, _cached_api_key_ts
    now = time.time()
    if _cached_api_key is not None and (now - _cached_api_key_ts) < _API_KEY_CACHE_TTL:
        return _cached_api_key if _cached_api_key else None

    secret_arn = os.environ.get("BEDROCK_API_KEY_SECRET_ARN", "")
    if not secret_arn:
        return None

    try:
        region = os.environ.get("AWS_REGION", _DEFAULT_REGION)
        client = boto3.client("secretsmanager", region_name=region)
        response = client.get_secret_value(SecretId=secret_arn)
        secret_dict = json.loads(response["SecretString"])
        api_key = secret_dict.get("bedrock_api_key", "")
        if isinstance(api_key, str) and api_key:
            _cached_api_key = api_key
            _cached_api_key_ts = now
            return api_key
        # 空值也缓存，避免频繁读取
        _cached_api_key = ""
        _cached_api_key_ts = now
        return None
    except Exception as e:
        logger.warning("从 Secrets Manager 读取 Bedrock API Key 失败: %s", e)
        return None


# ---------------------------------------------------------------------------
# Bedrock Converse 调用（含重试）
# ---------------------------------------------------------------------------


def _is_retryable_error(e: Exception) -> bool:
    """判断 LLM 调用错误是否可重试。

    覆盖两类:
    - Bedrock ClientError(Throttling/ServiceUnavailable)
    - LiteLLMHTTPError 包装的 HTTP 5xx / 429
    """
    # Bedrock ClientError
    if isinstance(e, ClientError):
        try:
            code = e.response["Error"]["Code"]
            return code in _RETRYABLE_ERROR_CODES
        except (KeyError, TypeError):
            return False
    # LiteLLM 包装错误 — 通过类名匹配避免循环 import
    cls = type(e).__name__
    if cls == "LiteLLMHTTPError":
        msg = str(e)
        return any(
            sig in msg
            for sig in ("HTTP 429", "HTTP 500", "HTTP 502", "HTTP 503", "HTTP 504",
                        "Throttl", "ServiceUnavailable")
        )
    return False


def _is_retryable(e: ClientError) -> bool:
    """[deprecated, 兼容旧测试] — 委托给 _is_retryable_error。"""
    return _is_retryable_error(e)


def _invoke_with_retry(
    client,
    model_id: str,
    system_prompt: str,
    user_prompt: str,
) -> dict:
    """调用 LLM,最多 3 次指数退避重试。

    历史签名第 1 个参数是 boto3 client(已不使用,通过 shared.llm_provider 自动选)。
    保留它是为了不破坏单元测试 fixture。

    返回 dict 字段:`output.message.content[0].text` / `stopReason` / `usage`,
    与 boto3 Bedrock Converse 一致(LiteLLM 路径已在 invoke_llm 里规范化)。
    """
    from shared.llm_provider import invoke_llm

    backoff = _INITIAL_BACKOFF_SECONDS

    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            result = invoke_llm(
                model_id=model_id,
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                max_tokens=_MAX_TOKENS,
            )
            # 用 Bedrock Converse 的 envelope 包回去,后续代码不用改
            return {
                "output": {
                    "message": {
                        "content": [{"text": result.get("content", "")}]
                    }
                },
                "stopReason": result.get("stop_reason", ""),
                "usage": result.get("usage", {}),
            }
        except Exception as e:
            error_code = ""
            if isinstance(e, ClientError):
                error_code = e.response.get("Error", {}).get("Code", "")
            else:
                error_code = type(e).__name__

            if not _is_retryable_error(e) or attempt == _MAX_ATTEMPTS:
                logger.error(
                    "LLM 调用失败(不重试或已达上限): "
                    "attempt=%d/%d, error_code=%s, model=%s",
                    attempt, _MAX_ATTEMPTS, error_code, model_id,
                )
                raise
            logger.warning(
                "LLM 短暂错误,%.1fs 后重试: "
                "attempt=%d/%d, error_code=%s, model=%s",
                backoff, attempt, _MAX_ATTEMPTS, error_code, model_id,
            )
            time.sleep(backoff)  # nosemgrep: arbitrary-sleep — exponential retry backoff for Bedrock transient errors
            backoff *= 2

    raise RuntimeError("LLM retry loop 异常退出")


def summarize_investigation(
    long_report: str,
    model_id: str,
    agent_prompt: str | None = None,
) -> str:
    """用 Bedrock Converse API 把长报告精简为结构化短卡片。

    输出卡片包含三个章节（中文，约 200–400 字）：
      **症状 (Symptoms)** - 1-3 条 bullet
      **根因 (Root Cause)** - 1-2 句
      **关键发现 (Findings)** - 1-3 条 bullet

    Args:
        long_report: 原始 investigation_summary_md 长报告全文。
        model_id: Bedrock 模型 ID，由调用方通过 load_summarizer_config() 获取。
        agent_prompt: 可选的 system prompt 覆盖，非空时直接使用，否则用硬编码默认。

    Returns:
        精简后的短卡片 Markdown 文本。

    Raises:
        ValueError: long_report 为空或模型返回空内容。
        ClientError: Bedrock API 最终失败（包括重试耗尽）。

    调用方（Callback Lambda）捕获异常后应自行降级（例如把 long_report 直接
    当 summary_card 入库）。本函数不做降级以保持单一职责。

    Requirements: R6.4, R6.7, R11.9
    """
    if not long_report or not long_report.strip():
        raise ValueError("long_report 不能为空")

    system_prompt = (
        agent_prompt.strip()
        if isinstance(agent_prompt, str) and agent_prompt.strip()
        else _DEFAULT_SYSTEM_PROMPT
    )
    prompt_source = "custom" if system_prompt is not _DEFAULT_SYSTEM_PROMPT else "default"

    # 认证模式：API Key 优先，回退 IAM 凭证
    api_key = _get_api_key()
    if api_key:
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = api_key
        auth_mode = "api_key"
    else:
        os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)
        auth_mode = "iam_credentials"

    region = os.environ.get("AWS_REGION", _DEFAULT_REGION)
    logger.info(
        "开始精简调查报告: model=%s, region=%s, auth=%s, prompt=%s, "
        "report_len=%d",
        model_id, region, auth_mode, prompt_source, len(long_report),
    )

    client = boto3.client("bedrock-runtime", region_name=region, config=_bedrock_config)

    response = _invoke_with_retry(
        client=client,
        model_id=model_id,
        system_prompt=system_prompt,
        user_prompt=long_report,
    )

    output = response.get("output", {})
    message = output.get("message", {})
    content_blocks = message.get("content", [])
    content = content_blocks[0].get("text", "") if content_blocks else ""

    stop_reason = response.get("stopReason", "")
    usage = response.get("usage", {})

    if not content or not content.strip():
        logger.error(
            "Bedrock 返回空内容: model=%s, stop_reason=%s, usage=%s",
            model_id, stop_reason, usage,
        )
        raise ValueError("Bedrock 返回空内容")

    logger.info(
        "调查报告精简完成: model=%s, stop_reason=%s, usage=%s, card_len=%d",
        model_id, stop_reason, usage, len(content),
    )
    return content
