# `core/` — Platform-Agnostic Business Logic

Shared by every chat-platform adapter (Feishu, Slack, DingTalk, …) and by the
report-handler Lambda. Modules here own all the **business rules** that
should not be duplicated per platform.

## Hard rules

1. **No platform SDK imports.** `core/` MUST NOT `import lark_oapi`,
   `slack_sdk`, `dingtalk_stream`, or any future platform SDK. Only
   `boto3` and the standard library.
2. **No card / block / UI rendering.** Cards, blocks, modals, ActionCards
   live under `platforms/<x>/`. `core/` returns plain Python data
   (dataclasses, dicts, primitives) and lets each platform render them.
3. **`platform` is always an explicit parameter.** Never assume "feishu" or
   any default. Every cross-cutting function takes `platform: str` so the
   same code works for any future IM.
4. **TTL on every DDB write.** All rows must set the `ttl` attribute so the
   shared conversations table never grows unbounded.

## Module map

| Module | What it owns |
|---|---|
| [`bedrock_intent.py`](bedrock_intent.py) | LLM intent summary + missing-info hints |
| [`case_classifier.py`](case_classifier.py) | LLM AWS Support service/category classifier |
| [`webhook_dispatch.py`](webhook_dispatch.py) | HMAC-signed dispatch to DevOps Agent |
| [`ddb_state.py`](ddb_state.py) | Conversation state — `event#` / `incident#` / `task#` / `support#` |
| [`support_logic.py`](support_logic.py) | AWS Support case open flow (no UI) |

## Adding a new chat platform (the contract)

To add a 4th platform (e.g. Microsoft Teams, WeChat Work, Discord), an
adapter must do these and only these:

### 1. Pick a stable platform slug
e.g. `"teams"`, `"wxwork"`, `"discord"`. Lowercase, no hyphens. This slug
goes into:
  - `incident_id` prefix: `<slug>-<event_id>`
  - DDB rows: `platform=<slug>`
  - `webhook_dispatch.dispatch(..., platform=<slug>, ...)`
  - report-handler sender registry key

The slug is the only identity the rest of the system needs.

### 2. Run a long-connection client to receive events
Connect outbound to the platform's open API (no public ingress). Each
platform SDK provides this. **No HTTP webhook endpoints** — that violates
the "zero public ingress" security model.

### 3. On user message, call core in this exact order
```python
# 1. Idempotent record of the inbound event
ddb_state.put_new_event(event_id, platform=PLATFORM, chat_id=...,
                        root_message_id=..., user_id=..., raw_text=...)

# 2. LLM intent summary (returns {"intent": str, "suggestions": list[str]})
analysis = bedrock_intent.analyze_intent(raw_text)

# 3. (Render a confirmation card / block / message in YOUR platform)
ddb_state.update_intent(event_id, analysis["intent"], prompt_message_id)
```

### 4. On user confirm, dispatch to DevOps Agent
```python
incident_id = f"{PLATFORM}-{event_id}"
result = webhook_dispatch.dispatch(
    incident_id=incident_id,
    user_text=raw_text,
    platform=PLATFORM,
    user_id=...,
    chat_id=...,
)
ddb_state.link_incident(event_id, incident_id, platform=PLATFORM,
                        task_id=result.get("task_id"))
```

### 5. On "ask for human support" callback, call core
```python
from core import support_logic

if not support_logic.claim_inflight(unique_key):
    return  # already in flight
ctx = support_logic.load_support_context(incident_id)
if not ctx:
    return  # render "expired" card
result = support_logic.create_case(
    ctx, platform=PLATFORM, severity=..., language=..., extra=...,
    operator_name=...,
)
# Render `result` (CaseResult dataclass) into your platform's success/error card.
```

### 6. Add a sender in `report-handler/`
Implement `send_report(...)` and `send_live_console_link(...)` for your
platform under `report-handler/src/senders/<slug>.py` and register it in
the sender map. The handler picks the sender by reading `platform` off the
DDB row.

### What the new adapter does NOT need to do

- ❌ Add new fields to `core/ddb_state.py` schema (the existing key shapes
  cover any IM that has a chat id + a message id)
- ❌ Change `webhook_dispatch.py` (it's already platform-parameterized)
- ❌ Touch the report-handler beyond adding a new sender file
- ❌ Re-implement intent analysis, classification, or Support logic

If you find yourself reaching into `core/` to add platform-specific
behavior, stop — push it back into the platform adapter instead. `core/`
is meant to grow only when a *new business capability* is added that
applies to all IMs (e.g. multi-turn context).
