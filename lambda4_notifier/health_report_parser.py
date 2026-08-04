"""Health_Report_Parser：用 Bedrock 从 RDS / ElastiCache 巡检报告 Markdown 中
按账号解析出 critical 资源清单。

Lambda4 Notifier 在触发 DevOps Agent 健康告警调查前调用此函数，把 Lambda3 生成的
整份 Markdown 长报告拆解成 `{account_id: [critical_resource, ...]}`。

设计要点（与 shared/bedrock_summarizer.py 保持一致）：

- API Key 优先，回退 IAM 凭证
- 最多 3 次指数退避（1s / 2s / 4s）仅对 Throttling / ServiceUnavailable 类重试
- ValidationException 等不可重试错误直接抛给调用方（Lambda4）
- JSON 解析失败或格式不符预期时记录 WARN 并返回 {}（降级：不触发任何调查）

Requirements: R11.2, R11.7, R11.9
"""

import json
import logging
import os
import re
import time

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from shared.summarizer_config import load_summarizer_config

logger = logging.getLogger("lambda4_notifier.health_report_parser")


# ---------------------------------------------------------------------------
# Bedrock 客户端配置
# ---------------------------------------------------------------------------

_bedrock_config = Config(
    read_timeout=90,
    connect_timeout=10,
    retries={"max_attempts": 2, "mode": "adaptive"},
)

_DEFAULT_REGION = "ap-northeast-1"
_MAX_TOKENS = 4096  # critical 资源清单可能较长

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
# System Prompt
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """你是一位 AWS 运维报告解析专家。你的任务是从 RDS 或 ElastiCache 巡检报告（Markdown 格式）中
提取所有 severity=critical（严重）级别的资源，按 AWS 账户 ID 分组，输出严格的 JSON 格式。

输入示例（Markdown 报告片段）：
  ## 账户 123456789012 - RDS 巡检
  - 实例 `rds-prod-01` CPU 持续 >90%，严重（critical）
  - 实例 `rds-prod-02` 磁盘使用率 85%，警告（warning）

输出要求：
  1. 只返回 severity=critical 的资源（忽略 warning / attention / info）
  2. 输出必须是一个严格合法的 JSON 对象，不要 Markdown 代码块包裹、不要额外解释
  3. JSON 格式：
     {
       "<account_id>": [
         {
           "resource_id": "<实例 ID 或 ARN>",
           "issue_description": "<简要描述问题，不超过 80 字>",
           "severity": "critical",
           "resource_type": "rds"
         }
       ]
     }
  4. account_id 必须是 12 位数字字符串。无法识别账户 ID 的资源，跳过
  5. 没有 critical 资源时，返回空对象 `{}`
  6. resource_type 必须是 "rds" 或 "elasticache"（根据输入报告来源判断，如果报告同时含 RDS 和 EC，各自标注）"""


# ---------------------------------------------------------------------------
# Bedrock Converse 调用（含重试）
# ---------------------------------------------------------------------------


def _is_retryable(error: ClientError) -> bool:
    try:
        code = error.response["Error"]["Code"]
    except (KeyError, TypeError):
        return False
    return code in _RETRYABLE_ERROR_CODES


def _invoke_with_retry(
    client,
    model_id: str,
    system_prompt: str,
    user_prompt: str,
) -> dict:
    """[migration] 调用 LLM(provider 由 SSM 切换),最多 3 次指数退避重试。

    历史签名第一个参数是 boto3 client(已不使用,通过 shared.llm_provider 自动选)。
    保留是为了不破坏旧测试 fixture。返回 Bedrock Converse envelope 兼容结构。
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
            code = ""
            if isinstance(e, ClientError):
                code = e.response.get("Error", {}).get("Code", "")
            else:
                code = type(e).__name__

            # _is_retryable 只认 ClientError;LiteLLM 错误这里不重试,直接抛
            retryable = isinstance(e, ClientError) and _is_retryable(e)
            if not retryable or attempt == _MAX_ATTEMPTS:
                logger.error(
                    "Health_Report_Parser LLM 调用失败(不重试或已达上限): "
                    "attempt=%d/%d, code=%s",
                    attempt, _MAX_ATTEMPTS, code,
                )
                raise
            logger.warning(
                "Health_Report_Parser 短暂错误 %.1fs 后重试: "
                "attempt=%d/%d, code=%s",
                backoff, attempt, _MAX_ATTEMPTS, code,
            )
            time.sleep(backoff)  # nosemgrep: arbitrary-sleep — exponential retry backoff for Bedrock transient errors
            backoff *= 2
    raise RuntimeError("Health_Report_Parser retry loop 异常退出")


# ---------------------------------------------------------------------------
# API Key 认证（与 shared/bedrock_summarizer 一致的缓存模式）
# ---------------------------------------------------------------------------

_cached_api_key: str | None = None
_cached_api_key_ts: float = 0.0
_API_KEY_CACHE_TTL = 300


def _get_api_key() -> str | None:
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
        resp = client.get_secret_value(SecretId=secret_arn)
        secret = json.loads(resp["SecretString"])
        key = secret.get("bedrock_api_key", "")
        if isinstance(key, str) and key:
            _cached_api_key = key
            _cached_api_key_ts = now
            return key
        _cached_api_key = ""
        _cached_api_key_ts = now
        return None
    except Exception as e:
        logger.warning("读取 Bedrock API Key 失败: %s", e)
        return None


# ---------------------------------------------------------------------------
# JSON 解析
# ---------------------------------------------------------------------------


def _parse_llm_json(raw: str) -> dict:
    """从 LLM 输出中解析 JSON。

    容错策略：
      1. 尝试直接 json.loads
      2. 若失败，尝试从 ```json ... ``` 或 ``` ... ``` 代码块中抠出
      3. 若失败，尝试抠出首个 `{` 到最后一个 `}` 之间的子串
      4. 均失败返回 {}
    """
    if not raw or not raw.strip():
        return {}

    # 策略 1：直接解析
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass

    # 策略 2：代码块
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass

    # 策略 3：抠 {...}
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            pass

    logger.warning(
        "Health_Report_Parser JSON 解析失败，降级返回空 dict。原始输出前 200 字: %s",
        raw[:200],
    )
    return {}


_ACCOUNT_ID_RE = re.compile(r"^[0-9]{12}$")


def _validate_and_filter(parsed: dict) -> dict[str, list[dict]]:
    """校验 LLM 输出结构，过滤非法条目。"""
    if not isinstance(parsed, dict):
        logger.warning("Health_Report_Parser 输出不是 dict，降级返回空")
        return {}

    result: dict[str, list[dict]] = {}
    for account_id, resources in parsed.items():
        if not isinstance(account_id, str) or not _ACCOUNT_ID_RE.match(account_id):
            logger.warning(
                "Health_Report_Parser 跳过非法 account_id: %r", account_id
            )
            continue
        if not isinstance(resources, list) or not resources:
            continue

        valid_resources = []
        for r in resources:
            if not isinstance(r, dict):
                continue
            if r.get("severity") != "critical":
                continue
            # 最小字段必须有 resource_id / issue_description
            if not r.get("resource_id") or not r.get("issue_description"):
                continue
            valid_resources.append({
                "resource_id": str(r["resource_id"]),
                "issue_description": str(r["issue_description"])[:200],
                "severity": "critical",
                "resource_type": str(r.get("resource_type") or "unknown"),
            })

        if valid_resources:
            result[account_id] = valid_resources

    return result


# ---------------------------------------------------------------------------
# 主入口
# ---------------------------------------------------------------------------


def parse_critical_by_account(
    rds_report_md: str | None,
    ec_report_md: str | None,
) -> dict[str, list[dict]]:
    """从 RDS / ElastiCache 巡检报告中解析出按账号的 critical 资源清单。

    Args:
        rds_report_md: RDS 巡检报告的 Markdown 全文（Lambda3 生成的整份 summary 报告）
        ec_report_md: ElastiCache 巡检报告的 Markdown 全文

    Returns:
        {account_id: [{resource_id, issue_description, severity, resource_type}, ...]}
        两个输入都为 None / 空字符串时返回 {}。
        Bedrock 调用 / JSON 解析失败时返回 {}（降级，调用方 Lambda4 不触发任何调查）。

    Requirements: R11.2, R11.7, R11.9
    """
    rds = (rds_report_md or "").strip()
    ec = (ec_report_md or "").strip()

    if not rds and not ec:
        logger.info("Health_Report_Parser 输入为空，返回 {}")
        return {}

    # 构造用户消息：两份报告拼接，标明来源
    parts: list[str] = []
    if rds:
        parts.append("【RDS 巡检报告】\n\n" + rds)
    if ec:
        parts.append("【ElastiCache 巡检报告】\n\n" + ec)
    user_prompt = "\n\n---\n\n".join(parts)

    # 读取 model_id（三级降级链已封装在 summarizer_config）
    config = load_summarizer_config()
    model_id = config["model_id"]

    # 认证：API Key 优先
    api_key = _get_api_key()
    if api_key:
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = api_key
        auth_mode = "api_key"
    else:
        os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)
        auth_mode = "iam_credentials"

    region = os.environ.get("AWS_REGION", _DEFAULT_REGION)
    logger.info(
        "Health_Report_Parser 开始: model=%s region=%s auth=%s "
        "rds_len=%d ec_len=%d",
        model_id, region, auth_mode, len(rds), len(ec),
    )

    try:
        client = boto3.client(
            "bedrock-runtime", region_name=region, config=_bedrock_config
        )
        response = _invoke_with_retry(
            client=client,
            model_id=model_id,
            system_prompt=_SYSTEM_PROMPT,
            user_prompt=user_prompt,
        )
    except Exception as e:
        logger.error("Health_Report_Parser Bedrock 调用失败，降级返回 {}: %s", e)
        return {}

    # 提取文本
    output = response.get("output", {})
    message = output.get("message", {})
    blocks = message.get("content", [])
    text = blocks[0].get("text", "") if blocks else ""
    usage = response.get("usage", {})

    if not text or not text.strip():
        logger.warning("Health_Report_Parser Bedrock 返回空，降级返回 {}")
        return {}

    parsed = _parse_llm_json(text)
    result = _validate_and_filter(parsed)

    logger.info(
        "Health_Report_Parser 完成: model=%s usage=%s accounts=%d total_critical=%d",
        model_id,
        usage,
        len(result),
        sum(len(v) for v in result.values()),
    )
    return result
