"""
Feishu (Lark) helpers: tenant access token caching/refresh, OpenAPI calls.

Feishu requires tenant_access_token for all enterprise-app OpenAPI calls.
Tokens are short-lived (~2 hours) — we lazily refresh ~5min before expiry.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import boto3

logger = logging.getLogger(__name__)

OPENAPI_BASE = os.environ.get("FEISHU_OPENAPI_BASE", "https://open.feishu.cn/open-apis")
_sm = boto3.client("secretsmanager")

_app_id: str | None = None
_app_secret: str | None = None
_token: str | None = None
_token_expiry: float = 0.0
_lock = threading.Lock()


def _load_credentials() -> tuple[str, str]:
    global _app_id, _app_secret
    if _app_id and _app_secret:
        return _app_id, _app_secret
    # Unified credential loading: read the single Feishu Secret JSON
    # (same source main.py uses) instead of two separate ARN env vars.
    # Format: {"app_id": "cli_xxx", "app_secret": "xxx", ...}
    _feishu_secret = json.loads(
        _sm.get_secret_value(
            SecretId=os.environ.get("FEISHU_SECRET_NAME", "notiops/im-bot-feishu")
        )["SecretString"]
    )
    _app_id = _feishu_secret["app_id"]
    _app_secret = _feishu_secret["app_secret"]
    return _app_id, _app_secret


def get_tenant_access_token() -> str:
    """Cached tenant access token; refreshes ~5min before expiry."""
    global _token, _token_expiry
    with _lock:
        if _token and time.time() < _token_expiry - 300:
            return _token
        app_id, app_secret = _load_credentials()
        body = json.dumps({"app_id": app_id, "app_secret": app_secret}).encode("utf-8")
        req = Request(f"{OPENAPI_BASE}/auth/v3/tenant_access_token/internal",
                      data=body, method="POST")
        req.add_header("Content-Type", "application/json; charset=utf-8")
        if not (req.full_url if hasattr(req, "full_url") else str(req)).lower().startswith(("https://","http://")):
            raise ValueError("refusing non-http(s) URL")  # B310 mitigation
        with urlopen(req, timeout=10) as resp:  # nosec B310 - scheme validated above
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("code") != 0:
            raise RuntimeError(f"Feishu token fetch failed: {data}")
        _token = data["tenant_access_token"]
        _token_expiry = time.time() + int(data.get("expire", 7200))
        logger.info("Refreshed tenant_access_token (expires in %ds)", data.get("expire"))
        return _token


# ---------------------------------------------------------------------------
# Generic OpenAPI call wrapper
# ---------------------------------------------------------------------------
def call_openapi(method: str, path: str, payload: dict | None = None,
                 query: dict | None = None) -> dict:
    """Call Feishu OpenAPI with tenant token."""
    url = f"{OPENAPI_BASE}{path}"
    if query:
        from urllib.parse import urlencode
        url = f"{url}?{urlencode(query)}"
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {get_tenant_access_token()}")
    req.add_header("Content-Type", "application/json; charset=utf-8")
    try:
        if not (req.full_url if hasattr(req, "full_url") else str(req)).lower().startswith(("https://","http://")):
            raise ValueError("refusing non-http(s) URL")  # B310 mitigation
        with urlopen(req, timeout=15) as resp:  # nosec B310 - scheme validated above
            data = json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body_txt = e.read().decode("utf-8") if e.fp else ""
        logger.error("Feishu API %s %s -> HTTP %d %s", method, path, e.code, body_txt)
        return {"code": -1, "msg": f"http {e.code}: {body_txt}"}
    except URLError as e:
        logger.error("Feishu API %s %s -> conn error %s", method, path, e.reason)
        return {"code": -1, "msg": str(e.reason)}
    if data.get("code") != 0:
        logger.warning("Feishu API non-zero: %s %s -> %s", method, path, data)
    return data


# ---------------------------------------------------------------------------
# Message helpers (text + interactive cards)
# ---------------------------------------------------------------------------
def send_text(chat_id: str, text: str, root_id: str | None = None) -> dict:
    """Send a plain text message (optionally as a thread reply)."""
    content = json.dumps({"text": text}, ensure_ascii=False)
    return _send(receive_id_type="chat_id", receive_id=chat_id,
                 msg_type="text", content=content, root_id=root_id)


def send_text_to_chat(chat_id: str, text: str) -> dict:
    """Send a plain text message directly to the group's main timeline.
    Avoids thread-reply rendering which Feishu sometimes routes to a
    DM-like topic view on mobile clients."""
    return send_text(chat_id, text, root_id=None)


def send_card(chat_id: str, card: dict, root_id: str | None = None) -> dict:
    """Send an interactive card (Feishu's structured message format)."""
    return _send(receive_id_type="chat_id", receive_id=chat_id,
                 msg_type="interactive",
                 content=json.dumps(card, ensure_ascii=False),
                 root_id=root_id)


def update_card(message_id: str, card: dict) -> dict:
    """Patch an interactive card in place (used after user clicks confirm/cancel)."""
    return call_openapi("PATCH", f"/im/v1/messages/{message_id}",
                        payload={"content": json.dumps(card, ensure_ascii=False)})


def reply_text(message_id: str, text: str, *,
               in_thread: bool = True) -> dict:
    """Reply to a specific message.

    By default we set ``reply_in_thread: true`` so the response opens /
    continues a Feishu **thread** on the original @-mention, keeping
    the main chat timeline reserved for substantive bot output
    (dispatch confirmation cards, investigation reports). Used for
    chitchat / general_qa replies and the zero-change REFUSAL text.

    Pass ``in_thread=False`` to use the legacy quote-style reply that
    appears inline on the main timeline. Rarely needed."""
    payload: dict = {
        "content": json.dumps({"text": text}, ensure_ascii=False),
        "msg_type": "text",
    }
    if in_thread:
        payload["reply_in_thread"] = True
    return call_openapi("POST", f"/im/v1/messages/{message_id}/reply", payload=payload)


def _send(receive_id_type: str, receive_id: str, msg_type: str,
          content: str, root_id: str | None = None) -> dict:
    payload: dict = {
        "receive_id": receive_id,
        "msg_type": msg_type,
        "content": content,
    }
    if root_id:
        # Reply within an existing thread root
        return call_openapi("POST", f"/im/v1/messages/{root_id}/reply",
                            payload={"content": content, "msg_type": msg_type,
                                     "reply_in_thread": True})
    return call_openapi("POST", "/im/v1/messages",
                        payload=payload, query={"receive_id_type": receive_id_type})


# ---------------------------------------------------------------------------
# Text utilities
# ---------------------------------------------------------------------------
def strip_at_mention(text: str) -> str:
    """
    Remove leading @bot mentions from a Feishu text message.
    Feishu wraps mentions as `@_user_1` placeholders that are resolved client-side;
    in events the original text shows `@<bot_name>` literal. Best-effort strip.
    """
    import re
    # @_user_N tokens (Feishu placeholder for at-mentions)
    text = re.sub(r"@_user_\d+\s*", "", text or "", flags=re.IGNORECASE)
    # Generic leading @something whitespace
    text = re.sub(r"^\s*@\S+\s*", "", text)
    return text.strip()
