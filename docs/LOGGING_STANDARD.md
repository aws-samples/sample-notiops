# Logging Standard — Sensitive Data Handling

> Established during the security review for open-source publication. It
> codifies the "log metadata, never payloads" rule across the whole
> repository, so that new code stays consistent with the remediated
> hot-path files.

## The rule

**Never log raw exception objects, response bodies, or user-derived dicts.**
An exception message or an API response can embed the very request payload
(account IDs, resource ARNs, prompts, secrets fragments) that triggered the
error. Log only *metadata that describes what failed*, not *the data that
failed*.

| Don't | Do |
|---|---|
| `logger.warning("x failed: %s", e)` | `logger.warning("x failed: %s", _safe_err(e))` |
| `logger.error("api error: %s", data)` | `logger.error("api error: code=%s msg=%s", data.get("code"), data.get("msg"))` |
| `logger.warning("http %d body=%r", status, body)` | `logger.warning("http %d (%d-byte body)", status, len(body))` |
| `console.error("failed", e)` | `console.error("failed", errMsg(e))` |

## Python backend

For `except` blocks, log the exception **type** (and the AWS error code for
`botocore.ClientError`) — never `str(e)`:

```python
def _safe_err(e: Exception) -> str:
    """Return the exception type (plus AWS error code for ClientError),
    never the raw message/response body which can embed user data."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__

# usage
except Exception as e:
    logger.warning("chat_history put failed for %s#%s: %s",
                   platform, chat_id, _safe_err(e))
```

If you genuinely need the full body/message for local debugging, gate it
behind `if logger.isEnabledFor(logging.DEBUG):` — never at INFO/WARNING/ERROR.

### Reference implementations
- [`core/mcp_http_client.py`](../core/mcp_http_client.py) — HTTP client: logs status + content-length only.
- [`shared/report_delivery/feishu_sender.py`](../shared/report_delivery/feishu_sender.py) — API errors as `code=%s msg=%s`.
- [`core/devops_agent.py`](../core/devops_agent.py) / [`core/chat_history.py`](../core/chat_history.py) — `_safe_err(e)` on every catch.
- [`core/bedrock_intent.py`](../core/bedrock_intent.py) — logs `stop_reason` + block count, not the response.
- [`platforms/dingtalk/app/main.py`](../platforms/dingtalk/app/main.py) — dispatch failure as status + body length.

## Frontend (React / TypeScript)

Use the shared helper instead of passing the raw error to `console.error`:

```typescript
import { errMsg } from "../utils/errMsg";   // frontend/frontend-app
// ...
catch (e) {
  console.error("Failed to load X", errMsg(e));  // message string only
}
```

`errMsg()` ([`frontend/frontend-app/src/utils/errMsg.ts`](../frontend/frontend-app/src/utils/errMsg.ts))
returns `e.message` for `Error`, the string itself for strings, and
`"unknown error"` otherwise — so a thrown response object never lands in the
browser console.

## Scanner suppressions

Some Semgrep "credential-disclosure" hits are false positives where the format
string merely *names* a secret ("Failed to read API Key: %s", e) but logs the
exception, not the value. Those are acceptable and were dispositioned during
the security review as scanner noise — do not add secret values to satisfy or
silence them. When a genuine suppression is warranted, use `# nosemgrep: <rule-id>`
with a one-line justification (Semgrep ignores Bandit's `# nosec`).
