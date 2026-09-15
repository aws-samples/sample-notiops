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
| `console.error("failed", e)` | `console.error("failed", e instanceof Error ? e.message : String(e))` |

## HTTP responses — a separate, stricter channel

Everything above is about **logs**. Response bodies are a different channel with
the opposite trade-off, and conflating the two is what produced four real leaks
in `bff/web-chat/`.

- **Logs go to CloudWatch, which is ours.** Keeping `e.message` there is
  deliberate — it is often the only thing that makes an AWS `AccessDenied`
  diagnosable at all.
- **Response bodies are rendered to whoever is logged in.** The Web Chat frontend
  paints `error` / `message` / `aiError` straight onto a card or a banner, so an
  SDK message ends up on a customer's screen, not tucked away in DevTools.

An AWS SDK message is English prose that routinely embeds the 12-digit account
id, the full caller role ARN, the resource ARN, the table name, and the exact
action that was missing:

```
User: arn:aws:sts::<account>:assumed-role/<stack>-BffFn.../... is not authorized
to perform: dynamodb:Query on resource: arn:aws:dynamodb:<region>:<account>:table/<table>
```

The only part an operator actually needs from that is the **exception name** —
`AccessDenied` and `NoSuchEntity` call for completely different next actions —
and the exception name carries no topology.

So the rule for the wire is: **a response body may contain only (a) prose written
by hand in this repository, (b) a machine-readable code we defined ourselves, or
(c) an exception type name.** Never an upstream message, never an upstream
response body.

[`bff/web-chat/safe_err.mjs`](../bff/web-chat/safe_err.mjs) is the single
implementation:

```javascript
safeErr(e)             // -> "AccessDeniedException/AccessDeniedException"
userError(msg, code)   // marks msg as hand-written -> safe to show verbatim
errBody(e)             // 3 tiers: userMessage -> code -> safeErr(e)
```

| Don't | Do |
|---|---|
| `return json(500, { error: String(e?.message \|\| e) })` | `return json(500, errBody(e))` |
| `return { ok: false, message: e.message }` | `return { ok: false, code, message: safeErr(e) }` |
| `throw new Error("unzip failed: " + e.message)` | `throw userError("<hand-written hint>", "bad_request")` |

Two corollaries that are easy to get backwards:

- **Do not "unify" the log lines down to exception names.** `console.error(...,
  e?.message)` stays as it is. Tightening the *open* channel is the fix;
  tightening the closed one only removes diagnosability.
- **Do not blanket-replace every `e.message`.** Hand-written validation prose
  ("the zip contains no SKILL.md") is tier (a) and must survive verbatim;
  squashing it to `Error/Error` leaves the user with nothing to act on. That is
  exactly what `userError()` exists for.

Map internal failure codes to external ones whenever the internal word would
mislead a client. A JWKS fetch failure is `jwks_unavailable` inside the BFF but
goes out as `503 idp_unavailable` — and deliberately **not** `401`, because a 401
makes the frontend sign everyone out, and signing back in goes through the same
unreachable identity provider.

Enforced by
[`bff/web-chat/tests/error_response_hygiene.test.mjs`](../bff/web-chat/tests/error_response_hygiene.test.mjs),
which sweeps every `bff/web-chat/*.mjs` for
`error|message|reason|detail|aiError: e.message` shapes — and self-tests its own
scan regex against three known-bad shapes, so the sweep cannot rot into a
permanently-green assertion.

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

Copy the **pattern at the cited line**, not the file. Remediation was done
per-call-site, so most of these files still contain pre-remediation sites too
(see *Known non-conforming call sites* below) — only `core/chat_history.py` and
`core/devops_agent.py` are clean end-to-end.

- [`core/chat_history.py`](../core/chat_history.py) and [`core/devops_agent.py`](../core/devops_agent.py) — `_safe_err(e)` on every catch; audited, zero raw-`e` log sites in either file.
- [`core/mcp_http_client.py:141`](../core/mcp_http_client.py) and [`:204`](../core/mcp_http_client.py) — `HTTP %d (%d-byte body)`: status plus body *length*, never the body. [`:213`](../core/mcp_http_client.py) does the same for JSON-RPC errors (`code=%s msg=%s`).
- [`shared/report_delivery/feishu_sender.py:94`](../shared/report_delivery/feishu_sender.py) and [`:121`](../shared/report_delivery/feishu_sender.py) — Feishu API errors as `code=%s msg=%s`, not the response dict.
- [`core/bot_llm.py:66`](../core/bot_llm.py) and [`shared/bedrock_summarizer.py:302`](../shared/bedrock_summarizer.py) — empty-completion diagnosis as `model=%s stop_reason=%s`, never the completion or the prompt.
- [`platforms/dingtalk/app/main.py:486`](../platforms/dingtalk/app/main.py) — dispatch failure as `status=%s (%d-char body)`.

### Known non-conforming call sites (backend)

Named so nobody copies them and so the remaining work is visible. Normalize
each when you next touch that code path:

- Raw exception object at WARNING/ERROR (`%s", e`): [`core/bedrock_intent.py:774`](../core/bedrock_intent.py), [`:777`](../core/bedrock_intent.py), [`:868`](../core/bedrock_intent.py); [`core/mcp_http_client.py:92`](../core/mcp_http_client.py) (`e.reason`), [`:95`](../core/mcp_http_client.py); [`shared/report_delivery/feishu_sender.py:61`](../shared/report_delivery/feishu_sender.py), [`:90`](../shared/report_delivery/feishu_sender.py), [`:124`](../shared/report_delivery/feishu_sender.py), [`:169`](../shared/report_delivery/feishu_sender.py), [`:923`](../shared/report_delivery/feishu_sender.py), [`:952`](../shared/report_delivery/feishu_sender.py); [`platforms/dingtalk/app/main.py:256`](../platforms/dingtalk/app/main.py), [`:371`](../platforms/dingtalk/app/main.py), [`:398`](../platforms/dingtalk/app/main.py).
- Raw response body: [`shared/report_delivery/feishu_sender.py:166`](../shared/report_delivery/feishu_sender.py) logs up to 1000 characters of the Feishu error body — should be `(%d-char body)`.
- **User question text at INFO** (the worst class — it is user-derived content, banned by *The rule* above): [`core/bedrock_intent.py:857`](../core/bedrock_intent.py) logs `text[:60]` and [`:904`](../core/bedrock_intent.py) logs `text[:80]`. Both are intent-routing diagnostics; the routing decision is the useful part, the question text is not. (Line numbers point at the argument, not at the `logger.info(` that opens the call four lines earlier — grep for `text[:` if they drift.)

This list is a snapshot of the *cited* files, not a scanner result. A heuristic
repo-wide sweep counts **341 sites across 80 files** as of 2026-09-05 — the
largest concentrations are `platforms/slack/app/main.py` (23),
`platforms/feishu/app/main.py` (19), `shared/report_delivery/report_handler.py`
(18) and `core/bedrock_chat.py` (16). Remediation was scoped to the hot paths
that handle user payloads; the rest is known debt. Do not add to it.

The exact criterion, so the number is re-derivable instead of trusted: over
`git ls-files '*.py'`, a `logger.warning` / `logger.error` / `logger.exception`
call whose next 4 lines contain a bare `e` argument or `e.reason`, and contain
neither `_safe_err` nor `type(e)`. **Sweep the git index, not the working
tree** — walking the filesystem pulls in `.venv/`, the built `lambda_layer_im/`
(vendored `lark_oapi`) and `agent-build/**/staging/` (vendored
`bedrock_agentcore` SDK), which together inflate the same sweep to ~930 sites
across ~236 files. None of those are ours to fix.

## Frontend (React / TypeScript)

There is one frontend: [`frontend/chat-app/`](../frontend/chat-app/) (the Web
Chat). The rule is the same as on the backend — **log a message string, never
the raw thrown value**, because a rejected `fetch` response or an API error
object can carry the user's own question text and account identifiers into the
browser console, where screenshots and screen-shares pick it up:

```typescript
const msg = e instanceof Error ? e.message : String(e);
console.error("[models] GET /models failed", msg);   // message string only
```

> Earlier revisions of this document pointed at a shared `errMsg()` helper in
> `frontend/frontend-app/src/utils/errMsg.ts`. **That helper no longer exists** —
> it lived in the old admin/dashboard console, which was retired together with
> its REST API; `frontend/frontend-app/` is gone from the repository. Inline the
> two-line narrowing above (or add a local helper) rather than importing it.

Known non-conforming call sites in `frontend/chat-app`, to normalize when you
next touch them: [`src/api/chat.ts:382`](../frontend/chat-app/src/api/chat.ts)
and [`:394`](../frontend/chat-app/src/api/chat.ts) still pass the raw response /
error object, and
[`src/components/ErrorBoundary.tsx:19`](../frontend/chat-app/src/components/ErrorBoundary.tsx)
passes the React error plus component stack (intentional — that one is the
crash reporter and has no user payload).

## Scanner suppressions

Some Semgrep "credential-disclosure" hits are false positives where the format
string merely *names* a secret ("Failed to read API Key: %s", e) but logs the
exception, not the value. Those are acceptable and were dispositioned during
the security review as scanner noise — do not add secret values to satisfy or
silence them. When a genuine suppression is warranted, use `# nosemgrep: <rule-id>`
with a one-line justification (Semgrep ignores Bandit's `# nosec`).
