"""DingTalk adapter helpers — token cache + text-shaping utilities.

⚠️ This module belongs to the LEGACY Fargate/Stream-Mode shape
(`platforms/dingtalk/app/`). The live path is the Lambda webhook one —
see `platforms/dingtalk/README.md` and `platforms/dingtalk/sender.py`,
which re-implements outbound delivery with stdlib only. Nothing under
`platforms/dingtalk/*.py` (the Lambda layer) imports this file.

Mirrors the role of `platforms/feishu/app/feishu_utils.py` but
INTENTIONALLY does NOT wrap the inbound reply path. The reply path
in Stream Mode goes through the `dingtalk-stream` SDK's
`ChatbotHandler.reply_text` / `reply_markdown` /
`reply_markdown_card` / `reply_markdown_button` family — those use
the per-message `incoming_message.session_webhook` URL that the
platform hands to the bot after each inbound.

That URL is good for **~90 minutes**, not ~5 minutes as an earlier
version of this docstring claimed: the official sample envelope has
`sessionWebhookExpiredTime - createAt = 5,402,586 ms ≈ 90.04 min`.
The distinction is architectural, not cosmetic — 90 min > Lambda's
15-min ceiling, which is exactly why the Lambda path never needs an
access_token for in-conversation replies.

So for in-conversation replies there is NO need for us to mint an
access_token ourselves.

What stays in this module:

  1. `strip_at_mention` — pure string transform on inbound text;
     no SDK / network involved.
  2. `_read_secret_env` — Secrets Manager helper used by main.py
     during startup AND by the Phase 2 push sender (which DOES need
     a global access_token because push delivery has no incoming
     context to attach to).
  3. `get_access_token` — cached access_token used ONLY by the
     push delivery path; left here as a single source of truth so
     the lambda/dingtalk_sender Phase 2 wiring can import it.

The earlier Phase 1 version of this file wrapped `send_text` /
`send_markdown` and pointed them at `/v1.0/robot/groupMessages/send`
for **in-conversation** replies. That was the wrong route for that
job — it ignores the session_webhook contract and cannot @ anybody.
Removed in Phase 1.6.

⚠️ An earlier version of this note went further and claimed that route
"requires a separately-configured robot (orgWideRobot / outgoing-only)".
That is **wrong** and has been corrected: `groupMessages/send` is the
documented route for enterprise-internal application robots; the only
prerequisite is ticking the "send message as enterprise robot" scope in
the DingTalk developer console. It is what `sender.send_group()` uses
for out-of-conversation delivery (report write-back, push), where no
session_webhook exists.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any

logger = logging.getLogger(__name__)


# ---------- Constants -----------------------------------------------------
# 5-minute safety margin before the access_token's stated expiry, since
# clock skew + retry latency can push us off the cliff otherwise.
_TOKEN_REFRESH_MARGIN_S = 300
_HTTP_TIMEOUT_SECONDS = 15
_NEW_API = "https://api.dingtalk.com"


# ---------- Inbound text shaping ------------------------------------------
def strip_at_mention(text: str) -> str:
    """Remove the leading @<bot_name> from a DingTalk message text.

    DingTalk @-mentions arrive as `@<display name>` followed by a
    space. There's no markup the way Slack inserts `<@U123>`. The
    bot's display name varies per deployment; we strip by pattern
    rather than name.

    Strategy: if the message starts with `@<token-without-spaces> `
    drop everything up to and including that first whitespace. If
    the message doesn't start with `@`, return as-is. Empty input
    returns empty.
    """
    s = (text or "").lstrip()
    if not s.startswith("@"):
        return s.strip()
    parts = s.split(None, 1)
    return parts[1].strip() if len(parts) > 1 else ""


# ---------- access_token (Phase 2 push path only) -------------------------

_TOKEN_LOCK = threading.Lock()
_token_cache: dict[str, Any] = {"token": "", "expires_at": 0.0}


def _read_secret_env(arn_env: str) -> str:
    """Read a value from Secrets Manager via an ARN env var. Falls
    back to plain env (for local dev) when the *_ARN var is empty.
    """
    arn = os.environ.get(arn_env, "")
    if arn:
        # Late-import boto3 so test imports don't pay for the boto SDK.
        import boto3
        sm = boto3.client("secretsmanager")
        return sm.get_secret_value(SecretId=arn)["SecretString"]
    raw_env = arn_env.replace("_ARN", "")
    return os.environ.get(raw_env, "")


def _fetch_access_token() -> tuple[str, float]:
    """Hit /v1.0/oauth2/accessToken with appKey + appSecret. Returns
    `(token, expires_at_unix_seconds)`."""
    app_key = _read_secret_env("DINGTALK_APP_KEY_ARN")
    app_secret = _read_secret_env("DINGTALK_APP_SECRET_ARN")
    if not app_key or not app_secret:
        raise RuntimeError(
            "DingTalk credentials missing — set DINGTALK_APP_KEY_ARN / "
            "DINGTALK_APP_SECRET_ARN to Secrets Manager ARNs.")
    body = json.dumps({"appKey": app_key, "appSecret": app_secret}).encode()
    req = urllib.request.Request(
        f"{_NEW_API}/v1.0/oauth2/accessToken",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if not (req.full_url if hasattr(req, "full_url") else str(req)).lower().startswith(("https://","http://")):
        raise ValueError("refusing non-http(s) URL")  # B310 mitigation
    with urllib.request.urlopen(req, timeout=_HTTP_TIMEOUT_SECONDS) as resp:  # nosec B310 - scheme validated above
        payload = json.loads(resp.read().decode("utf-8"))
    token = payload.get("accessToken") or ""
    expire_in = int(payload.get("expireIn", 7200))
    if not token:
        raise RuntimeError(
            f"DingTalk accessToken missing from response: {payload!r}")
    return token, time.time() + expire_in - _TOKEN_REFRESH_MARGIN_S


def get_access_token() -> str:
    """Cached access_token. Threadsafe. Used by the Phase 2 push
    delivery path (lambda/dingtalk_sender)."""
    with _TOKEN_LOCK:
        if (_token_cache["token"] and
                time.time() < _token_cache["expires_at"]):
            return _token_cache["token"]
        token, expires_at = _fetch_access_token()
        _token_cache["token"] = token
        _token_cache["expires_at"] = expires_at
        return token
