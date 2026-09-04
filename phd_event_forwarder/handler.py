"""PHD 事件转发 Lambda Handler。

SNS 触发，编排完整处理流程：
  1. 遍历 event["Records"]，解析 SNS 信封
  2. json.loads(record["Sns"]["Message"]) 获取 EventBridge 事件
  3. 提取 PHDEvent dataclass
  4. 调用 Bedrock 摘要（失败则降级为原始事件转发）
  5. 格式化消息（emoji + 结构化字段）
  6. 推送至飞书
  7. 不抛出未处理异常（避免 SNS 重试导致重复通知）

环境变量：
  - FEISHU_SECRET_ARN: Feishu credentials Secret ARN
  - BEDROCK_API_KEY_SECRET_ARN: Bedrock API Key Secret ARN
"""

import json
import logging
import os
import time

logger = logging.getLogger("phd_event_forwarder.handler")
logger.setLevel(logging.INFO)

# Secrets 缓存（带 TTL，与 lambda4_notifier 保持一致）
_SECRET_CACHE_TTL = 300  # 5 分钟
_secrets_cache: dict[str, tuple[dict, float]] = {}


def _load_secret(secret_arn: str) -> dict:
    """从 Secrets Manager 加载 Secret（带缓存）。

    参照 Lambda4 Notifier 的 _load_secret 模式。
    加载失败返回空字典。
    """
    if secret_arn in _secrets_cache:
        cached, ts = _secrets_cache[secret_arn]
        if time.time() - ts < _SECRET_CACHE_TTL:
            return cached
    if not secret_arn:
        return {}
    try:
        import boto3
        client = boto3.client("secretsmanager")
        resp = client.get_secret_value(SecretId=secret_arn)
        secret = json.loads(resp["SecretString"])
        _secrets_cache[secret_arn] = (secret, time.time())
        return secret
    except Exception as e:
        logger.error("加载 Secret 失败 (%s): %s", secret_arn, e)
        return {}


def _process_record(record: dict) -> None:
    """处理单条 SNS record。

    流程：解析 PHDEvent → Bedrock 摘要（降级） → 格式化 → 推送 IM。
    """
    from phd_event_forwarder.event_parser import parse_sns_event
    from phd_event_forwarder.formatter import format_fallback_message, format_message
    from phd_event_forwarder.notifier import send_notifications
    from phd_event_forwarder.summarizer import summarize_event

    phd_event = parse_sns_event(record)
    if phd_event is None:
        logger.warning("SNS record 解析失败，跳过处理")
        return

    logger.info(
        "处理 PHD 事件: eventArn=%s, account=%s, type=%s",
        phd_event.eventArn,
        phd_event.affectedAccount,
        phd_event.eventTypeCategory,
    )

    # Bedrock 摘要（失败降级）
    try:
        summary = summarize_event(phd_event)
        content = format_message(phd_event, summary)
    except Exception as e:
        logger.warning("Bedrock 摘要失败，降级为原始事件转发: %s", e)
        content = format_fallback_message(phd_event)

    # Load IM Secret
    feishu_secret_arn = os.environ.get("FEISHU_SECRET_ARN", "")
    feishu_secret = _load_secret(feishu_secret_arn) if feishu_secret_arn else {}

    # Push notifications
    result = send_notifications(content, feishu_secret)

    total_sent = result["feishu_sent"]
    if total_sent == 0:
        feishu_chat_ids = feishu_secret.get("notify_chat_ids", "") if feishu_secret else ""
        has_any_chat_ids = bool(feishu_chat_ids.strip())
        if has_any_chat_ids:
            logger.error(
                "Feishu push failed: eventArn=%s", phd_event.eventArn
            )
        else:
            logger.info(
                "No notify_chat_ids configured, skipping push: eventArn=%s",
                phd_event.eventArn,
            )
    else:
        logger.info(
            "PHD event push done: eventArn=%s, feishu=%d",
            phd_event.eventArn,
            result["feishu_sent"],
        )


def handler(event: dict, context) -> dict:
    """PHD 事件转发 Lambda 入口（SNS 触发）。

    顶层 try/except 捕获所有异常，永远不向 SNS 抛出（避免重试导致重复通知）。
    单条 record 处理失败不影响其他 record。

    Args:
        event: Lambda 事件（SNS 触发）
        context: Lambda 上下文

    Returns:
        处理结果字典
    """
    processed = 0
    errors = 0

    try:
        records = event.get("Records", []) if isinstance(event, dict) else []
        if not isinstance(records, list):
            records = []

        logger.info("PHD Lambda 收到 %d 条 record", len(records))

        for i, record in enumerate(records):
            try:
                _process_record(record)
                processed += 1
            except Exception as e:
                errors += 1
                logger.error("处理第 %d 条 record 失败: %s", i, e)

    except Exception as e:
        logger.error("Handler 顶层异常: %s", e)

    # 永远不抛出异常，避免 SNS 重试
    return {
        "status": "completed",
        "processed": processed,
        "errors": errors,
    }
