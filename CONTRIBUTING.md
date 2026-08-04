# Contributing

Project rules new collaborators must follow. CI enforces the
mechanical bits; the rest is on the reviewer.

---

## Bilingual (zh + en) is mandatory

This bot ships globally. **Every user-visible string** must exist
in both Simplified Chinese and English, and must be reached through
the i18n facade — never hardcoded inline.

### What "user-visible" means

| User-visible (must i18n) | Internal (no i18n needed) |
|---|---|
| Slack / Feishu card text | DDB attribute names |
| Button labels | Logger messages |
| Modal titles + placeholders | Error log strings |
| Bedrock prompt **output** instructions | Bedrock prompt **input** examples (semantic detection of zh keywords) |
| Refusal / canned reply text | Internal helper var names |
| Slash-command help / status replies | Tool names sent to Bedrock Tool Use |

### How to add a new string

1. Open [`core/i18n.py`](core/i18n.py).
2. Add a key under `_TRANSLATIONS` with **both** `zh` and `en`
   values:
   ```python
   "feature.area.purpose": {
       "zh": "中文文案 {placeholder}",
       "en": "English text {placeholder}",
   },
   ```
3. At the call site, pass `locale` through the call chain (resolved
   at the top of the request via
   [`core/locale_resolver.py`](core/locale_resolver.py)) and call
   `i18n.t("feature.area.purpose", locale, placeholder=value)`.

### How to add a new function that emits user text

1. Function signature MUST take `locale: str`. No defaults to `"zh"`
   or `"en"` — the caller resolved it; you propagate it.
2. Internal Bedrock prompts: append `_locale_directive(locale)` to
   the system prompt (see [`core/bedrock_chat.py`](core/bedrock_chat.py)).
3. Cards / blocks / modals: every label / title / button / placeholder
   uses `i18n.t()`. No exceptions.

### Anti-patterns CI will catch

```python
# ❌ Bare zh literal anywhere outside core/i18n.py — fails C2 in lint.
say(text="🤔 正在理解你的指令…")

# ❌ Hardcoded literal in a chat-output call — fails C3.
client.chat_postMessage(channel=cid, text="Done")

# ❌ Adding a key without both locales — fails C1.
"new.thing": {"zh": "你好"},   # missing en
```

### The right pattern

```python
# Resolve at the entry handler:
locale, _src = locale_resolver.resolve(
    user_id=user_id, platform=PLATFORM, is_dm=is_dm,
    thread_root_id=thread_ts or "", text=raw_text,
)

# Use everywhere downstream:
say(channel=cid, text=i18n.t("ack.understanding", locale))
client.chat_postEphemeral(channel=cid, user=uid,
                          text=i18n.t("confirm.expired", locale))

# When calling Bedrock:
body = {
    "anthropic_version": "bedrock-2023-05-31",
    "max_tokens": _MAX_OUTPUT_TOKENS,
    "system": _SYSTEM_PROMPT + _locale_directive(locale),
    ...
}
```

### Local lint setup

```bash
# Install once after clone:
./scripts/install_hooks.sh

# Manual check anytime:
python scripts/lint_i18n.py
```

Wire the same `python scripts/lint_i18n.py` check into your CI so it
runs on every PR — a PR that introduces new violations should be
blocked from merging until it's clean.

### Existing-debt baseline

The repo had ~560 untranslated literals when lint was introduced
(case_flow / push_event / progress_sender legacy paths). Demanding
everyone fix all of them before contributing would block real work;
instead,
[`scripts/i18n_baseline.txt`](scripts/i18n_baseline.txt) is a
snapshot of those known-existing violations. Lint only fails on
**new** violations.

When you fix one of the baselined files, run

```bash
python scripts/lint_i18n.py --update-baseline
```

to shrink the snapshot. Number of baselined entries is a treadmill —
it can only go down.

---

## Other house rules

(More to add as the team grows. Open a PR if a rule belongs here.)

- **Don't merge to main with failing CI.** Ever.
- **Don't `--no-verify` past the pre-commit hook.** If lint is
  flagging something legitimate that needs a temporary exemption,
  add the file path to the `CJK_ALLOWLIST` set in
  `scripts/lint_i18n.py` with an inline comment explaining why,
  then file a follow-up to remove the exemption.
- **AWS resources you create must carry the `auto-delete=no` tag.**
  This is a project convention to prevent scheduled-cleanup jobs from
  sweeping live infrastructure.
