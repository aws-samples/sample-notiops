"""
Notification config management API routes (Feishu IM bot configuration).
GET    /api/notification-config       - Read current notification config (sensitive fields masked)
PUT    /api/notification-config       - Update notification config
POST   /api/notification-config/test  - Test send notification message
"""

import json
import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Input format validation
# ---------------------------------------------------------------------------

# Feishu app_id format: cli_ + alphanumeric
_FEISHU_APP_ID_RE = re.compile(r"^cli_[a-zA-Z0-9]+$")
# Feishu chat_id format: oc_ + alphanumeric
_FEISHU_CHAT_ID_RE = re.compile(r"^oc_[a-zA-Z0-9]+$")


def _validate_chat_ids(raw: str, pattern: re.Pattern, platform: str) -> None:
    """Validate comma-separated chat_id list format. Skip empty strings."""
    if not raw or not raw.strip():
        return
    for chat_id in raw.split(","):
        cleaned = chat_id.strip()
        if cleaned and not pattern.match(cleaned):
            raise ValueError(f"Invalid {platform} chat_id format: {cleaned}")


def _validate_feishu_config(config: dict) -> None:
    """Validate Feishu config field formats (only validate non-empty fields)."""
    app_id = config.get("app_id", "")
    if app_id and not _FEISHU_APP_ID_RE.match(app_id):
        raise ValueError(f"Invalid Feishu app_id format: {app_id} (should start with cli_)")
    _validate_chat_ids(config.get("notify_chat_ids", ""), _FEISHU_CHAT_ID_RE, "Feishu")


def handle_notification_config(
    method: str, path: str, query_params: dict, path_params: dict, body: dict | None
) -> dict | list:
    """Route dispatch."""
    if path.endswith("/test"):
        if method == "POST":
            return _test_send(body)
        else:
            raise ValueError(f"Method {method} not allowed for /test endpoint")
    elif method == "GET":
        return _get_config()
    elif method == "PUT":
        return _update_config(body)
    else:
        raise ValueError(f"Method {method} not allowed")


def _get_config() -> dict:
    """Read current notification config with sensitive fields masked."""
    import boto3

    client = boto3.client("secretsmanager")
    result = {"feishu": {}}

    # Read Feishu config
    feishu_secret_name = "notiops/im-bot-feishu"  # nosec B105 - Secrets Manager secret *id* (a reference), not a credential; the secret value is fetched at runtime
    try:
        resp = client.get_secret_value(SecretId=feishu_secret_name)
        feishu_data = json.loads(resp["SecretString"])
        result["feishu"] = {
            "app_id": feishu_data.get("app_id", ""),
            "app_secret": _mask_secret(feishu_data.get("app_secret", "")),
            "verification_token": _mask_secret(feishu_data.get("verification_token", "")),
            "encrypt_key": _mask_secret(feishu_data.get("encrypt_key", "")),
            "notify_chat_ids": feishu_data.get("notify_chat_ids", ""),
        }
    except client.exceptions.ResourceNotFoundException:
        logger.warning("Feishu Secret not found: %s", feishu_secret_name)
        result["feishu"] = {
            "app_id": "",
            "app_secret": "",
            "verification_token": "",
            "encrypt_key": "",
            "notify_chat_ids": "",
        }
    except Exception as e:
        logger.error("Failed to read Feishu config: %s", e)
        raise

    return result


def _update_config(body: dict | None) -> dict:
    """Update notification config to Secrets Manager.

    If a field value matches the masked pattern (****xxxx), keep the original value.
    """
    if not body:
        raise ValueError("Request body is required")

    platform = body.get("platform")
    if platform != "feishu":
        raise ValueError("platform must be 'feishu'")

    config = body.get("config")
    if not config or not isinstance(config, dict):
        raise ValueError("config field is required and must be an object")

    _validate_feishu_config(config)

    import boto3

    client = boto3.client("secretsmanager")

    secret_name = "notiops/im-bot-feishu"  # nosec B105 - Secrets Manager secret id (reference), not a credential
    # Read existing values
    try:
        resp = client.get_secret_value(SecretId=secret_name)
        existing = json.loads(resp["SecretString"])
    except client.exceptions.ResourceNotFoundException:
        existing = {}

    # Merge config, preserve masked field original values
    updated = {
        "app_id": config.get("app_id", existing.get("app_id", "")),
        "app_secret": _merge_if_masked(
            config.get("app_secret", ""), existing.get("app_secret", "")
        ),
        "verification_token": _merge_if_masked(
            config.get("verification_token", ""), existing.get("verification_token", "")
        ),
        "encrypt_key": _merge_if_masked(
            config.get("encrypt_key", ""), existing.get("encrypt_key", "")
        ),
        "notify_chat_ids": config.get("notify_chat_ids", existing.get("notify_chat_ids", "")),
    }

    # Write back to Secrets Manager
    try:
        client.update_secret(SecretId=secret_name, SecretString=json.dumps(updated))
    except client.exceptions.ResourceNotFoundException:
        client.create_secret(Name=secret_name, SecretString=json.dumps(updated))

    return {"message": "Feishu config updated successfully"}


def _test_send(body: dict | None) -> dict:
    """Test send a notification message to a specified chat_id."""
    if not body:
        raise ValueError("Request body is required")

    platform = body.get("platform")
    chat_id = body.get("chat_id")

    if platform != "feishu":
        raise ValueError("platform must be 'feishu'")
    if not chat_id:
        raise ValueError("chat_id is required")

    if not _FEISHU_CHAT_ID_RE.match(chat_id):
        raise ValueError(f"Invalid Feishu chat_id format: {chat_id} (should start with oc_)")

    import boto3

    client = boto3.client("secretsmanager")

    try:
        secret_name = "notiops/im-bot-feishu"  # nosec B105 - Secrets Manager secret id (reference), not a credential
        resp = client.get_secret_value(SecretId=secret_name)
        secret = json.loads(resp["SecretString"])

        from shared.feishu_sender import FeishuSender

        sender = FeishuSender(
            app_id=secret.get("app_id", ""),
            app_secret=secret.get("app_secret", ""),
        )

        test_msg = "Test notification from AWS Idle Resource Detection System.\nIf you receive this message, the notification config is correct."
        success = sender.send_response(chat_id, test_msg, "markdown")

        if success:
            return {"success": True, "message": "Test message sent successfully"}
        else:
            return {"success": False, "message": "Failed to send test message"}

    except client.exceptions.ResourceNotFoundException:
        raise ValueError(f"Secret not found for platform: {platform}")
    except Exception as e:
        logger.error("Test send failed: platform=%s, error=%s", platform, e)
        raise ValueError(f"Failed to send test message: {str(e)}")


def _mask_secret(value: str) -> str:
    """Mask sensitive values: show only last 4 chars."""
    if not value or len(value) <= 4:
        return "****"
    return f"****{value[-4:]}"


def _merge_if_masked(new_value: str, old_value: str) -> str:
    """If new value looks masked (****xxxx), return old value; otherwise return new."""
    if new_value.startswith("****") and len(new_value) <= 8:
        return old_value
    return new_value
