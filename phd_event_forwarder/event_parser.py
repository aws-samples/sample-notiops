"""PHD 事件解析模块。

从 SNS 信封中提取和解析 AWS Personal Health Dashboard 事件。

SNS 信封结构：
  Records[i].Sns.Message → JSON 字符串 → EventBridge 事件对象
  EventBridge 事件的 detail 字段包含 PHD 事件详情。
"""

import json
import logging
from dataclasses import asdict, dataclass, field

logger = logging.getLogger("phd_event_forwarder.event_parser")


@dataclass
class PHDEvent:
    """PHD 事件结构化表示。"""

    eventArn: str
    service: str
    eventTypeCode: str
    eventTypeCategory: str  # issue | accountNotification | scheduledChange | investigation
    statusCode: str  # upcoming | open | closed
    region: str  # 受影响区域
    startTime: str
    endTime: str | None = None
    eventDescription: str = ""  # eventDescription[0].latestDescription
    affectedEntities: list[dict] = field(default_factory=list)
    affectedAccount: str = ""  # 从事件信封 account 字段提取
    eventScopeCode: str = ""  # PUBLIC | ACCOUNT_SPECIFIC

    def to_json(self) -> str:
        """序列化为 JSON 字符串。"""
        return json.dumps(asdict(self), ensure_ascii=False)

    @classmethod
    def from_json(cls, json_str: str) -> "PHDEvent":
        """从 JSON 字符串反序列化。"""
        data = json.loads(json_str)
        return cls(**{k: v for k, v in data.items() if k in cls.__dataclass_fields__})


def parse_sns_event(sns_record: dict) -> PHDEvent | None:
    """从 SNS Record 解析 PHD 事件。

    1. json.loads(sns_record["Sns"]["Message"]) 获取 EventBridge 事件
    2. 从 detail 中提取 PHD 字段
    3. 缺少 eventArn 或 eventTypeCategory 返回 None 并记录警告

    Args:
        sns_record: SNS Record 字典

    Returns:
        PHDEvent 或 None（解析失败时）
    """
    try:
        sns_obj = sns_record["Sns"]
        message_str = sns_obj["Message"]
    except (KeyError, TypeError) as e:
        logger.warning("SNS record 缺少 Sns.Message 字段: %s", e)
        return None

    try:
        eb_event = json.loads(message_str)
    except (json.JSONDecodeError, TypeError) as e:
        logger.warning("SNS Message 不是有效 JSON: %s", e)
        return None

    detail = eb_event.get("detail")
    if not isinstance(detail, dict):
        logger.warning("EventBridge 事件缺少 detail 字段")
        return None

    event_arn = detail.get("eventArn", "")
    event_type_category = detail.get("eventTypeCategory", "")

    if not event_arn:
        logger.warning("PHD 事件缺少 eventArn，跳过处理")
        return None
    if not event_type_category:
        logger.warning("PHD 事件缺少 eventTypeCategory，跳过处理")
        return None

    # 提取 eventDescription
    event_desc_list = detail.get("eventDescription", [])
    event_description = ""
    if isinstance(event_desc_list, list) and len(event_desc_list) > 0:
        first_desc = event_desc_list[0]
        if isinstance(first_desc, dict):
            event_description = first_desc.get("latestDescription", "")

    # 提取 affectedEntities
    affected_entities = detail.get("affectedEntities", [])
    if not isinstance(affected_entities, list):
        affected_entities = []

    # affectedAccount 从事件信封 account 字段提取
    affected_account = eb_event.get("account", "")

    return PHDEvent(
        eventArn=event_arn,
        service=detail.get("service", ""),
        eventTypeCode=detail.get("eventTypeCode", ""),
        eventTypeCategory=event_type_category,
        statusCode=detail.get("statusCode", ""),
        region=detail.get("eventRegion", eb_event.get("region", "")),
        startTime=detail.get("startTime", ""),
        endTime=detail.get("endTime") or None,
        eventDescription=event_description,
        affectedEntities=affected_entities,
        affectedAccount=affected_account,
        eventScopeCode=detail.get("eventScopeCode", ""),
    )


def parse_lambda_event(lambda_event: dict) -> list[PHDEvent]:
    """从 Lambda event 解析所有 PHD 事件。

    遍历 Records[]，对每条 SNS record 调用 parse_sns_event()。
    单条解析失败不影响其他 record。

    Args:
        lambda_event: Lambda 事件字典

    Returns:
        成功解析的 PHDEvent 列表
    """
    events: list[PHDEvent] = []
    records = lambda_event.get("Records", [])

    if not isinstance(records, list):
        logger.warning("Lambda event Records 不是列表")
        return events

    for i, record in enumerate(records):
        try:
            phd_event = parse_sns_event(record)
            if phd_event is not None:
                events.append(phd_event)
        except Exception as e:
            logger.warning("解析第 %d 条 SNS record 失败: %s", i, e)

    return events
