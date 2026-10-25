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
  - 去重窗口(conditional put + TTL),与 IM 端同法;另加一道按事件 id 的投递去重(见下)。

收件箱数据模型(写 notiops-web-chat 表,账号级共享一份 —— 方案 Q1 一期选 (a)):
  通知事件:  PK=notif#account   SK=evt#{ts_ms}#{dedupe_key}
    属性: source,title,severity,resource,region,account,description,
          console_url,dispatch_query,read=false,ts,ttl
  已读游标由 BFF 侧维护(PK=notif#account SK=cursor)。

环境变量(CDK 只注入前三个,其余都用这里的默认值 —— 两条部署路径因此天然一致):
  WEB_CHAT_TABLE            web chat 单表(默认 notiops-web-chat)
  NOTIF_INBOX_KEY           收件箱分区键后缀,默认 "account"(账号级共享)
  NOTIF_TTL_DAYS            通知保留天数,默认 90
  DEDUPE_TTL_SECONDS        去重窗口秒,默认 300
  TA_DEDUPE_TTL_SECONDS     Trusted Advisor 的去重窗口秒,默认 86400(见下)
  DELIVERY_DEDUPE_TTL_SECONDS  同一次 EventBridge 投递(事件 `id` 相同)的去重秒,默认 86400(见下)
  GUARDDUTY_MIN_SEVERITY    float,默认 7.0
  TA_INCLUDE_CATEGORIES     逗号分隔,默认 "security,fault_tolerance,service_limits"

两道去重(2026-10-23,待办 #4 ④ / #11):
  ① 投递去重 `notif_delivery#<事件 id>`:EventBridge 对同一个事件的重投 / 重试用的是同一个
     `id`,而它会在 24 小时内重试投递(默认的最大事件年龄)。以前只有下面那道 5 分钟的窗口,
     晚于 5 分钟到的重投会在收件箱里多出一条一模一样的记录。
  ② 内容去重 `notif_dedupe#<dedupe_key>`:同一个告警 / 发现在窗口内反复上报只记一次。
     Trusted Advisor 用 24 小时窗口:它的事件是检查项**刷新**通知,两个反复刷新的检查项
     在现网每天多出约 14 条一模一样的记录;键里已经带了 status 和资源,状态一变照样立刻记。
写收件箱失败时,这两道认领都会放开(待办 #4 ①):否则窗口内再来的同一个事件会被当成重复,
连带也丢掉。放开用的是带条件的 PutItem(把这次认领改成已过期),不需要 DeleteItem 权限 ——
web 通知角色在两条部署路径上都只有 PutItem。

失败安全:任何异常都吞掉并返回 200(EventBridge 不重投风暴);写不进去只丢这一条,
不影响其它事件。
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid

import boto3

from core import push_event

logger = logging.getLogger()
logger.setLevel(logging.INFO)

WEB_CHAT_TABLE = os.environ.get("WEB_CHAT_TABLE", "notiops-web-chat")
NOTIF_INBOX_KEY = (os.environ.get("NOTIF_INBOX_KEY") or "account").strip()
NOTIF_TTL_DAYS = int(os.environ.get("NOTIF_TTL_DAYS", "90"))
DEDUPE_TTL_SECONDS = int(os.environ.get("DEDUPE_TTL_SECONDS", "300"))
TA_DEDUPE_TTL_SECONDS = int(os.environ.get("TA_DEDUPE_TTL_SECONDS", "86400"))
DELIVERY_DEDUPE_TTL_SECONDS = int(os.environ.get("DELIVERY_DEDUPE_TTL_SECONDS", "86400"))
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

    # AWS Health:仅 issue(真实影响)进实时收件箱;scheduledChange /
    # accountNotification(计划维护 / EOL 等)不逐条刷屏,与 IM 端策略一致。
    # 放在去重认领之前:反正要跳过的事件不该占一个去重键(重投时也如实回 skipped)。
    if source == "aws.health" and pe.raw_event_excerpt.get("category") != "issue":
        logger.info("web notif: non-issue health event (category=%s) skipped",
                    pe.raw_event_excerpt.get("category"))
        return {"statusCode": 200, "body": "health-non-issue-skipped"}

    # ① 同一次投递的重投:EventBridge 的事件 `id` 在重投 / 重试之间不变。
    delivery = _delivery_key(event)
    delivery_token = _claim(delivery, "delivery", DELIVERY_DEDUPE_TTL_SECONDS)
    if delivery_token is None:
        logger.info("web notif: redelivery of an event already handled; id=%s", event.get("id"))
        return {"statusCode": 200, "body": "duplicate-delivery"}

    # ② 内容去重。这里判成重复时**不**放开 ①:这次投递已经处理完了(结论就是"重复"),
    #    它晚于窗口的重投也该是重复。
    dedupe = f"notif_dedupe#{pe.dedupe_key}" if pe.dedupe_key else ""
    dedupe_token = _claim(dedupe, "dedupe", _window_for(source))
    if dedupe_token is None:
        logger.info("web notif: duplicate within window; key=%s", pe.dedupe_key)
        return {"statusCode": 200, "body": "duplicate"}

    ok = _write_inbox(pe)
    if not ok:
        # 没写进去就别占着认领:窗口内再来的同一个事件 / 同一次投递的重试都还要能落库。
        _release(dedupe, "dedupe", dedupe_token)
        _release(delivery, "delivery", delivery_token)
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
# 去重 —— 条件写 notif_delivery#<事件 id> / notif_dedupe#<key>
# ---------------------------------------------------------------------------
def _window_for(source: str) -> int:
    """内容去重窗口(秒)。Trusted Advisor 单独一档,理由见文件头 ②。"""
    return TA_DEDUPE_TTL_SECONDS if source == "aws.trustedadvisor" else DEDUPE_TTL_SECONDS


def _delivery_key(event: dict) -> str:
    """投递去重的 PK;事件没有 `id`(手工 / 测试投递)就返回空串 —— 不做这一道。"""
    eid = str(event.get("id") or "").strip()
    return f"notif_delivery#{eid}" if eid else ""


def _claim(pk: str, sk: str, window: int) -> str | None:
    """条件写认领一个去重键。

    返回值三种:认领成功 → 这次认领的 token(放开时要用);窗口内已经有人认领 → None;
    DynamoDB 出错 → 空串(fail-open 放行,但没有可放开的东西)。

    窗口靠条件里比对 `ttl` 结束,不靠 DynamoDB TTL 删条目:TTL 是后台异步删除
    (官方口径「通常几天内」),删之前过期条目对条件写照样可见。只写
    `attribute_not_exists(PK)` 的话,同一个告警一小时后、隔天再进 ALARM 也会被当成
    重复静默丢掉(2026-10-11 查出)。过期条目由这次认领直接覆盖。
    """
    if not _ddb_table or not pk:
        return ""
    now = int(time.time())
    token = uuid.uuid4().hex
    try:
        _ddb_table.put_item(
            Item={"PK": pk, "SK": sk, "claimed_at": now, "ttl": now + window,
                  "claim": token},
            ConditionExpression="attribute_not_exists(PK) OR #t < :now",
            ExpressionAttributeNames={"#t": "ttl"},
            ExpressionAttributeValues={":now": now},
        )
        return token
    except _ddb_table.meta.client.exceptions.ConditionalCheckFailedException:
        return None
    except Exception as e:  # noqa: BLE001
        logger.error("web notif dedupe DDB error (fail-open): %s", e)
        return ""


def _release(pk: str, sk: str, token: str) -> None:
    """放开自己的认领:把它改成已过期(`ttl` 落在过去),下一次 `_claim` 立刻能拿到。

    条件是 `claim` 还等于这次的 token —— 认领已经被别人接手时什么都不动。用 PutItem
    而不是 DeleteItem:web 通知角色在两条部署路径上都只有 `dynamodb:PutItem`。
    尽力而为:失败只记一行,最坏情况是窗口照常走完。
    """
    if not _ddb_table or not pk or not token:
        return
    now = int(time.time())
    try:
        _ddb_table.put_item(
            Item={"PK": pk, "SK": sk, "claimed_at": now, "ttl": now - 1,
                  "released": True},
            ConditionExpression="#c = :tok",
            ExpressionAttributeNames={"#c": "claim"},
            ExpressionAttributeValues={":tok": token},
        )
    except _ddb_table.meta.client.exceptions.ConditionalCheckFailedException:
        pass
    except Exception as e:  # noqa: BLE001
        logger.warning("web notif: releasing %s failed: %s", pk, type(e).__name__)


def _claim_dedupe(key: str) -> bool:
    """内容去重(默认窗口)的布尔版:首次命中 True,窗口内重复 False,DDB 出错放行 True。"""
    if not key:
        return True
    return _claim(f"notif_dedupe#{key}", "dedupe", DEDUPE_TTL_SECONDS) is not None


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
