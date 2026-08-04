"""IM notification module (PHD Event Forwarder).

Uses shared.feishu_sender to push PHD event messages to Feishu.

Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
"""

import logging

logger = logging.getLogger("phd_event_forwarder.notifier")


def _send_feishu_notifications(
    chat_ids: list[str], content: str, secret: dict
) -> int:
    """Send notifications to a list of Feishu chat_ids, return success count."""
    from shared.feishu_sender import FeishuSender

    sender = FeishuSender(
        app_id=secret.get("app_id", ""),
        app_secret=secret.get("app_secret", ""),
    )

    success = 0
    for chat_id in chat_ids:
        chat_id = chat_id.strip()
        if not chat_id:
            continue
        try:
            ok = sender.send_response(chat_id, content, "markdown")
            if ok:
                success += 1
                logger.info("飞书通知发送成功: chat_id=%s", chat_id)
            else:
                logger.warning("飞书通知发送失败: chat_id=%s", chat_id)
        except Exception as e:
            logger.error("飞书通知异常: chat_id=%s, error=%s", chat_id, e)
    return success


def send_notifications(content: str, feishu_secret: dict) -> dict:
    """Push message to all configured IM platforms.

    Args:
        content: Message content to push
        feishu_secret: Feishu credentials dict (app_id, app_secret, notify_chat_ids)

    Returns:
        {"feishu_sent": int}
    """
    feishu_sent = 0

    try:
        chat_ids_str = feishu_secret.get("notify_chat_ids", "") if feishu_secret else ""
        if chat_ids_str:
            chat_ids = [c.strip() for c in chat_ids_str.split(",") if c.strip()]
            if chat_ids:
                feishu_sent = _send_feishu_notifications(chat_ids, content, feishu_secret)
                logger.info("飞书通知: %d/%d 成功", feishu_sent, len(chat_ids))
    except Exception as e:
        logger.error("飞书推送整体失败: %s", e)

    return {"feishu_sent": feishu_sent}
