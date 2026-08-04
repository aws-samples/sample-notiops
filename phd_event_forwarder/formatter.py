"""消息格式化模块。

将 PHD 事件和 Bedrock 摘要格式化为 IM 推送消息。

Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7
"""

from phd_event_forwarder.event_parser import PHDEvent

# ---------------------------------------------------------------------------
# Emoji 映射
# ---------------------------------------------------------------------------

CATEGORY_EMOJI: dict[str, str] = {
    "issue": "🔴",
    "scheduledChange": "🟡",
    "accountNotification": "🔵",
    "investigation": "🟠",
}
DEFAULT_EMOJI = "⚪"
CLOSED_EMOJI = "✅"

# ---------------------------------------------------------------------------
# 中文名称映射
# ---------------------------------------------------------------------------

CATEGORY_NAME: dict[str, str] = {
    "issue": "服务问题",
    "scheduledChange": "计划维护",
    "accountNotification": "账户通知",
    "investigation": "调查中",
}

STATUS_NAME: dict[str, str] = {
    "upcoming": "即将开始",
    "open": "进行中",
    "closed": "已关闭",
}

# ---------------------------------------------------------------------------
# 控制台链接
# ---------------------------------------------------------------------------

HEALTH_DASHBOARD_LINK = "https://health.aws.amazon.com/health/home#/account/event-log"


def _get_emoji(phd_event: PHDEvent) -> str:
    """根据事件状态和类型获取 emoji 前缀。

    优先级：statusCode == "closed" 时使用 ✅，否则按 eventTypeCategory 映射。
    """
    if phd_event.statusCode == "closed":
        return CLOSED_EMOJI
    return CATEGORY_EMOJI.get(phd_event.eventTypeCategory, DEFAULT_EMOJI)


def _get_category_name(phd_event: PHDEvent) -> str:
    """获取事件类型中文名称。"""
    return CATEGORY_NAME.get(phd_event.eventTypeCategory, "未知类型")


def _get_status_name(phd_event: PHDEvent) -> str:
    """获取状态中文名称，未知状态返回原始值。"""
    return STATUS_NAME.get(phd_event.statusCode, phd_event.statusCode)


def _format_affected_entities(entities: list[dict], max_display: int = 10) -> str:
    """格式化受影响资源列表。

    最多显示 max_display 个，超出时显示总数提示。
    """
    if not entities:
        return ""

    total = len(entities)
    display = entities[:max_display]

    lines: list[str] = []
    for entity in display:
        entity_value = entity.get("entityValue", entity.get("entityArn", "未知资源"))
        lines.append(f"  - {entity_value}")

    if total > max_display:
        lines.append(f"  ... 共 {total} 个")

    return "\n".join(lines)


def format_message(phd_event: PHDEvent, summary: str) -> str:
    """格式化 PHD 事件推送消息。

    消息结构：
    - 标题行：emoji + 事件类型中文名 + 服务名
    - 正文：账户 ID、区域、时间范围、状态、eventScopeCode、AI 摘要
    - 受影响资源：最多显示 10 个，超出显示总数
    - 底部：AWS Health Dashboard 控制台链接

    Args:
        phd_event: 解析后的 PHD 事件
        summary: Bedrock 生成的中文摘要

    Returns:
        格式化后的消息字符串
    """
    emoji = _get_emoji(phd_event)
    category_name = _get_category_name(phd_event)
    status_name = _get_status_name(phd_event)

    # 标题行
    title = f"{emoji} 【{category_name}】{phd_event.service}"

    # 基本信息（跳过空值，避免显示空行）
    lines: list[str] = [title, ""]
    if phd_event.affectedAccount:
        lines.append(f"账户: {phd_event.affectedAccount}")
    if phd_event.region:
        lines.append(f"区域: {phd_event.region}")

    # 时间范围（跳过空 startTime）
    if phd_event.startTime:
        time_range = f"开始: {phd_event.startTime}"
        if phd_event.endTime:
            time_range += f" | 结束: {phd_event.endTime}"
        lines.append(time_range)
    elif phd_event.endTime:
        lines.append(f"结束: {phd_event.endTime}")

    lines.append(f"状态: {status_name}")

    if phd_event.eventScopeCode:
        lines.append(f"影响范围: {phd_event.eventScopeCode}")

    # AI 摘要
    lines.append("")
    lines.append(summary)

    # 受影响资源
    entities_str = _format_affected_entities(phd_event.affectedEntities)
    if entities_str:
        lines.append("")
        lines.append("受影响资源:")
        lines.append(entities_str)

    # 控制台链接
    lines.append("")
    lines.append(f"🔗 [AWS Health Dashboard]({HEALTH_DASHBOARD_LINK})")

    return "\n".join(lines)


def format_fallback_message(phd_event: PHDEvent) -> str:
    """Bedrock 不可用时的降级消息格式化。

    以 ⚠️ 开头，包含原始事件关键字段。

    Args:
        phd_event: 解析后的 PHD 事件

    Returns:
        降级格式化后的消息字符串
    """
    emoji = _get_emoji(phd_event)
    category_name = _get_category_name(phd_event)
    status_name = _get_status_name(phd_event)

    lines: list[str] = [
        f"{emoji} 【{category_name}】{phd_event.service}",
        "",
        "⚠️ AI 摘要不可用，以下为原始事件信息",
        "",
    ]

    if phd_event.affectedAccount:
        lines.append(f"账户: {phd_event.affectedAccount}")
    if phd_event.region:
        lines.append(f"区域: {phd_event.region}")
    if phd_event.eventTypeCode:
        lines.append(f"事件代码: {phd_event.eventTypeCode}")
    lines.append(f"状态: {status_name}")
    if phd_event.startTime:
        lines.append(f"开始: {phd_event.startTime}")

    if phd_event.endTime:
        lines.append(f"结束: {phd_event.endTime}")

    if phd_event.eventScopeCode:
        lines.append(f"影响范围: {phd_event.eventScopeCode}")

    if phd_event.eventDescription:
        lines.append("")
        lines.append("事件描述:")
        lines.append(phd_event.eventDescription)

    # 受影响资源
    entities_str = _format_affected_entities(phd_event.affectedEntities)
    if entities_str:
        lines.append("")
        lines.append("受影响资源:")
        lines.append(entities_str)

    # 控制台链接
    lines.append("")
    lines.append(f"🔗 [AWS Health Dashboard]({HEALTH_DASHBOARD_LINK})")

    return "\n".join(lines)
