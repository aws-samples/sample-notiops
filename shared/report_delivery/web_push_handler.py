"""
Web Chat 通知收件箱 handler — EventBridge 事件 → 落库到 web chat 的持久化收件箱。

与 IM 端 push_handler 的区别:
  IM 端 push 能"直达"是因为飞书/Slack 服务器替我们保管消息;web chat 没有这个
  信箱——页面关了就收不到。所以 web 端 push 拆成两层:
    A. 持久化收件箱(本 handler):事件发生就**无条件落库**,永不丢失 —— 根基。
    B. 实时红点(前端 60s 轮询 BFF):页面在线时才弹 —— 锦上添花。
  本 handler 只负责 A:normalize → 去重 → 写 inbox。**不自动发起调查**
  (与 IM 端不同):web 端调查由用户在通知卡上点「深入调查」触发,省 token、
  避免误触发风暴(见方案 Q2)。

复用:
  - core.push_event.normalize / from_guardduty / from_trusted_advisor — 6 源 normalizer,纯逻辑零平台依赖。
  - 5 分钟去重窗口(conditional put + TTL),与 IM 端同法。

收件箱数据模型(写 notiops-web-chat 表,账号级共享一份 —— 方案 Q1 一期选 (a)):
  通知事件:  PK=notif#account   SK=evt#{ts_ms}#{dedupe_key}
    属性: source,title,severity,resource,region,account,description,
          console_url,dispatch_query,read=false,ts,ttl
  已读游标由 BFF 侧维护(PK=notif#account SK=cursor)。

环境变量(CDK 注入):
  WEB_CHAT_TABLE            web chat 单表(默认 notiops-web-chat)
  NOTIF_INBOX_KEY           收件箱分区键后缀,默认 "account"(账号级共享)
  NOTIF_TTL_DAYS            通知保留天数,默认 90
  DEDUPE_TTL_SECONDS        去重窗口秒,默认 300
  GUARDDUTY_MIN_SEVERITY    float,默认 7.0
  TA_INCLUDE_CATEGORIES     逗号分隔,默认 "security,fault_tolerance,service_limits"

失败安全:任何异常都吞掉并返回 200(EventBridge 不重投风暴);写不进去只丢这一条,
不影响其它事件。
"""
from __future__ import annotations

import json
import logging
import os
import time

import boto3

from core import push_event

logger = logging.getLogger()
logger.setLevel(logging.INFO)

WEB_CHAT_TABLE = os.environ.get("WEB_CHAT_TABLE", "notiops-web-chat")
NOTIF_INBOX_KEY = (os.environ.get("NOTIF_INBOX_KEY") or "account").strip()
NOTIF_TTL_DAYS = int(os.environ.get("NOTIF_TTL_DAYS", "90"))
DEDUPE_TTL_SECONDS = int(os.environ.get("DEDUPE_TTL_SECONDS", "300"))
GUARDDUTY_MIN_SEVERITY = float(os.environ.get("GUARDDUTY_MIN_SEVERITY", "7.0"))
TA_INCLUDE_CATEGORIES = {
    c.strip().lower()
    for c in (os.environ.get("TA_INCLUDE_CATEGORIES") or
              "security,fault_tolerance,service_limits").split(",")
    if c.strip()
}

_ddb_table = (
    boto3.resource("dynamodb").Table(WEB_CHAT_TABLE) if WEB_CHAT_TABLE else None
)


def lambda_handler(event, context):
    """EventBridge → web 通知收件箱。"""
    source = event.get("source", "")
    detail_type = event.get("detail-type", "")
    logger.info("web notif: received source=%s detail-type=%s", source, detail_type)

    pe = _normalize(event)
    if pe is None:
        logger.info("web notif: filtered by normalizer (source=%s)", source)
        return {"statusCode": 200, "body": "filtered"}

    if not _claim_dedupe(pe.dedupe_key):
        logger.info("web notif: duplicate within window; key=%s", pe.dedupe_key)
        return {"statusCode": 200, "body": "duplicate"}

    # AWS Health:仅 issue(真实影响)进实时收件箱;scheduledChange /
    # accountNotification(计划维护 / EOL 等)不逐条刷屏,与 IM 端策略一致。
    if source == "aws.health" and pe.raw_event_excerpt.get("category") != "issue":
        logger.info("web notif: non-issue health event (category=%s) skipped",
                    pe.raw_event_excerpt.get("category"))
        return {"statusCode": 200, "body": "health-non-issue-skipped"}

    ok = _write_inbox(pe)
    logger.info("web notif: %s source=%s key=%s",
                "stored" if ok else "store-failed", pe.source, pe.dedupe_key)
    return {"statusCode": 200, "body": json.dumps({
        "stored": ok, "source": pe.source, "dedupe_key": pe.dedupe_key,
    })}


# ---------------------------------------------------------------------------
# normalize —— 阈值/类别从 env 注入,其余复用 core.push_event(与 IM handler 同法)
# ---------------------------------------------------------------------------
def _normalize(event: dict):
    src = (event.get("source") or "").lower()
    if src == "aws.guardduty":
        return push_event.from_guardduty(event, min_severity=GUARDDUTY_MIN_SEVERITY)
    if src == "aws.trustedadvisor":
        return push_event.from_trusted_advisor(event, include_categories=TA_INCLUDE_CATEGORIES)
    return push_event.normalize(event)


# ---------------------------------------------------------------------------
# 去重 —— conditional put on notif_dedupe#<key>,5 分钟窗口
# ---------------------------------------------------------------------------
def _claim_dedupe(key: str) -> bool:
    """首次命中返回 True;窗口内重复返回 False。DDB 出错则 fail-open(放行)。"""
    if not _ddb_table or not key:
        return True
    try:
        _ddb_table.put_item(
            Item={
                "PK": f"notif_dedupe#{key}",
                "SK": "dedupe",
                "claimed_at": int(time.time()),
                "ttl": int(time.time()) + DEDUPE_TTL_SECONDS,
            },
            ConditionExpression="attribute_not_exists(PK)",
        )
        return True
    except _ddb_table.meta.client.exceptions.ConditionalCheckFailedException:
        return False
    except Exception as e:  # noqa: BLE001
        logger.error("web notif dedupe DDB error (fail-open): %s", e)
        return True


# ---------------------------------------------------------------------------
# 写收件箱 —— PK=notif#<inbox_key>  SK=evt#<ts_ms>#<dedupe_key>
# ---------------------------------------------------------------------------
def _write_inbox(pe: push_event.PushEvent) -> bool:
    if not _ddb_table:
        logger.warning("web notif: no WEB_CHAT_TABLE; drop event")
        return False
    now_ms = int(time.time() * 1000)
    try:
        _ddb_table.put_item(Item={
            "PK": f"notif#{NOTIF_INBOX_KEY}",
            # ts_ms 前缀 → 天然按时间排序(倒序查即最新在前);dedupe_key 保证同毫秒不撞。
            "SK": f"evt#{now_ms:013d}#{pe.dedupe_key}",
            "ts": now_ms,
            "source": pe.source,
            "title": pe.title,
            "severity": pe.severity,           # info|warn|critical → 前端色条
            "resource": pe.resource,
            "region": pe.region,
            "account": pe.account,
            "description": pe.description,
            "console_url": pe.console_url,
            "dispatch_query": pe.dispatch_query,  # 「深入调查」时发给 DevOps Agent 的文本
            "dedupe_key": pe.dedupe_key,
            "read": False,
            "ttl": int(time.time()) + NOTIF_TTL_DAYS * 86400,
        })
        return True
    except Exception as e:  # noqa: BLE001
        logger.exception("web notif: write_inbox failed: %s", e)
        return False
