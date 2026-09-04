"""Feishu outbound push module.

Provides FeishuSender for sending messages to Feishu chats via Card Kit 2.0
streaming cards with automatic fallback to plain interactive cards.

No inbound webhook / signature / challenge logic (handled by ECS bot).
"""

from shared.net import safe_urlopen
import json
import logging
import re
import time
import urllib.request
import urllib.error

from core.feishu_card import card_config

logger = logging.getLogger("shared.feishu_sender")

# Card Kit API base URL
_API_BASE = "https://open.feishu.cn/open-apis"


class FeishuSender:
    """Feishu outbound message sender (Card Kit 2.0 streaming cards)."""

    def __init__(self, app_id: str = "", app_secret: str = "") -> None:  # nosec B107 - empty-string default (no hardcoded secret); real value injected at call time
        self.app_id = app_id
        self.app_secret = app_secret
        self._tenant_token: str = ""
        self._token_expires: float = 0

    # ------------------------------------------------------------------
    # Tenant Access Token
    # ------------------------------------------------------------------

    def _get_tenant_token(self) -> str:
        """Get feishu tenant_access_token with caching."""
        if self._tenant_token and time.time() < self._token_expires:
            return self._tenant_token

        if not self.app_id or not self.app_secret:
            logger.error("Feishu app_id/app_secret not configured")
            return ""

        url = f"{_API_BASE}/auth/v3/tenant_access_token/internal"
        data = json.dumps({
            "app_id": self.app_id,
            "app_secret": self.app_secret,
        }).encode("utf-8")
        req = urllib.request.Request(
            url, data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        try:
            with safe_urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("code") != 0:
                    logger.error("Failed to get tenant_token: %s", result.get("msg"))
                    return ""
                self._tenant_token = result.get("tenant_access_token", "")
                expire = result.get("expire", 7200)
                self._token_expires = time.time() + expire - 300
                return self._tenant_token
        except Exception as e:
            logger.error("Exception getting tenant_token: %s", e)
            return ""

    # ------------------------------------------------------------------
    # Card Kit 2.0 Streaming Cards
    # ------------------------------------------------------------------

    def _send_thinking_card(self, thread_id: str) -> dict | None:
        """Create a Card Kit 2.0 streaming card and send it to a chat.

        Returns:
            {"card_id": str, "message_id": str, "sequence": int} or None
        """
        token = self._get_tenant_token()
        if not token:
            return None

        card_json = {
            "schema": "2.0",
            "config": card_config(
                streaming_mode=True,
                summary={"content": "... thinking ..."},
                streaming_config={
                    "print_frequency_ms": {"default": 50},
                    "print_step": {"default": 1},
                },
            ),
            "header": {
                "title": {"tag": "plain_text", "content": "AI Assistant"},
                "template": "blue",
            },
            "body": {
                "elements": [
                    {
                        "tag": "markdown",
                        "content": "... thinking ...",
                        "element_id": "content",
                    }
                ]
            },
        }

        create_url = f"{_API_BASE}/cardkit/v1/cards"
        create_payload = json.dumps({
            "type": "card_json",
            "data": json.dumps(card_json, ensure_ascii=False),
        }, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(
            create_url, data=create_payload,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": f"Bearer {token}",
            },
            method="POST",
        )

        try:
            with safe_urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("code") != 0:
                    logger.error("Failed to create streaming card: %s", result.get("msg"))
                    return None
                card_id = result.get("data", {}).get("card_id", "")
                if not card_id:
                    return None
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            logger.error("Create streaming card HTTP error: status=%s, body=%s", e.code, body[:500])
            return None
        except Exception as e:
            logger.error("Create streaming card exception: %s", e)
            return None

        # Send card message
        send_url = f"{_API_BASE}/im/v1/messages?receive_id_type=chat_id"
        card_content = json.dumps(
            {"type": "card", "data": {"card_id": card_id}},
            ensure_ascii=False,
        )
        send_payload = json.dumps({
            "receive_id": thread_id,
            "msg_type": "interactive",
            "content": card_content,
        }, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(
            send_url, data=send_payload,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": f"Bearer {token}",
            },
            method="POST",
        )

        try:
            with safe_urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("code") != 0:
                    logger.error("Failed to send streaming card: %s", result.get("msg"))
                    return None
                message_id = result.get("data", {}).get("message_id", "")
                logger.info("Streaming card sent: card_id=%s, message_id=%s", card_id, message_id)
                return {"card_id": card_id, "message_id": message_id, "sequence": 1}
        except Exception as e:
            logger.error("Send streaming card exception: %s", e)
            return None

    def _update_card(self, card_id: str, content: str, sequence: int) -> bool:
        """Update streaming card content."""
        token = self._get_tenant_token()
        if not token:
            return False

        url = f"{_API_BASE}/cardkit/v1/cards/{card_id}/elements/content/content"
        payload = json.dumps({
            "content": content,
            "sequence": sequence,
        }, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(
            url, data=payload,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": f"Bearer {token}",
            },
            method="PUT",
        )

        try:
            with safe_urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("code") != 0:
                    logger.error("Failed to update card: %s", result.get("msg"))
                    return False
                return True
        except Exception as e:
            logger.error("Update card exception: %s", e)
            return False

    def _close_card(self, card_id: str, content: str, sequence: int) -> bool:
        """Close streaming mode, card becomes static."""
        token = self._get_tenant_token()
        if not token:
            return False

        clean = content.replace("\n", " ").strip()
        summary = clean[:47] + "..." if len(clean) > 50 else clean

        url = f"{_API_BASE}/cardkit/v1/cards/{card_id}/settings"
        payload = json.dumps({
            "settings": json.dumps({
                # 这里的 config 会**整体替换**卡片原有 config —— 不带 width_mode
                # 的话，流式一结束卡片就缩回默认宽度。所以照样走 card_config()。
                "config": card_config(
                    streaming_mode=False,
                    summary={"content": summary},
                ),
            }),
            "sequence": sequence,
        }, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(
            url, data=payload,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": f"Bearer {token}",
            },
            method="PATCH",
        )

        try:
            with safe_urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("code") != 0:
                    logger.error("Failed to close streaming card: %s", result.get("msg"))
                    return False
                logger.info("Streaming card closed: card_id=%s", card_id)
                return True
        except Exception as e:
            logger.error("Close streaming card exception: %s", e)
            return False

    # ------------------------------------------------------------------
    # Public API: send_response
    # ------------------------------------------------------------------

    def send_response(self, thread_id: str, content: str, fmt: str = "markdown") -> bool:
        """Send a response message to a Feishu chat.

        Pseudo-streaming: create streaming card -> update content -> close.
        Falls back to plain interactive card if streaming card creation fails.

        Args:
            thread_id: Target chat_id
            content: Response content
            fmt: Content format (markdown / text)
        """
        card_state = self._send_thinking_card(thread_id)
        if card_state:
            card_id = card_state["card_id"]
            seq = card_state["sequence"] + 1
            self._update_card(card_id, content, seq)
            seq += 1
            self._close_card(card_id, content, seq)
            return True

        # Fallback: plain interactive card
        return self._send_plain_card(thread_id, content)

    def _send_plain_card(self, thread_id: str, content: str) -> bool:
        """Fallback: send a plain interactive card (non-streaming)."""
        token = self._get_tenant_token()
        if not token:
            logger.error("Cannot get tenant_token, skipping message send")
            return False

        card = convert_markdown(content)
        card_json = json.dumps(card, ensure_ascii=False)

        url = f"{_API_BASE}/im/v1/messages?receive_id_type=chat_id"
        payload = json.dumps({
            "receive_id": thread_id,
            "msg_type": "interactive",
            "content": card_json,
        }, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(
            url, data=payload,
            headers={
                "Content-Type": "application/json; charset=utf-8",
                "Authorization": f"Bearer {token}",
            },
            method="POST",
        )

        try:
            with safe_urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read().decode("utf-8"))
                if result.get("code") != 0:
                    logger.error("Feishu message send failed: %s", result.get("msg"))
                    return False
                logger.info("Feishu message sent (plain card): thread_id=%s", thread_id)
                return True
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", errors="replace")
            logger.error("Feishu message send failed: status=%s, body=%s", e.code, body[:500])
            return False
        except Exception as e:
            logger.error("Feishu message send exception: %s", e)
            return False


# ------------------------------------------------------------------
# Markdown -> Card JSON 1.0 (used by plain card fallback)
# ------------------------------------------------------------------


def convert_markdown(markdown: str) -> dict:
    """Convert Markdown to Feishu interactive card structure (Card JSON 1.0)."""
    processed = _preprocess_for_feishu(markdown)
    return {
        "header": {
            "title": {"tag": "plain_text", "content": "AI Assistant"},
            "template": "blue",
        },
        "elements": [
            {
                "tag": "markdown",
                "content": processed,
            }
        ],
    }


def _preprocess_for_feishu(text: str) -> str:
    """Preprocess Markdown for Card JSON 1.0 limitations.

    Card JSON 1.0 markdown element does not support:
    - # headings -> **bold**
    - | tables | -> plain text list
    - --- dividers -> feishu format " ---"

    Code blocks are left untouched.
    """
    lines = text.split("\n")
    result: list[str] = []
    in_code_block = False
    in_table = False
    table_headers: list[str] = []

    for line in lines:
        if line.strip().startswith("```"):
            in_code_block = not in_code_block
            result.append(line)
            continue

        if in_code_block:
            result.append(line)
            continue

        # Heading -> bold
        heading_match = re.match(r"^(#{1,6})\s+(.+)", line)
        if heading_match:
            title_text = heading_match.group(2).strip()
            result.append(f"**{title_text}**")
            continue

        # Divider
        if re.match(r"^-{3,}\s*$", line.strip()):
            result.append(" ---")
            continue

        # Table detection and conversion
        stripped = line.strip()
        if "|" in stripped and stripped.startswith("|") and stripped.endswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if all(re.match(r"^:?-+:?$", c) for c in cells):
                continue
            if not in_table:
                in_table = True
                table_headers = cells
                result.append("  ".join(f"**{c}**" for c in cells))
            else:
                if table_headers and len(cells) == len(table_headers):
                    result.append("  ".join(
                        f"{table_headers[i]}: {cells[i]}" for i in range(len(cells))
                    ))
                else:
                    result.append("  ".join(cells))
            continue

        if in_table:
            in_table = False
            table_headers = []

        result.append(line)

    return "\n".join(result)
