"""Compose the user_text payload sent to DevOps Agent.

Two entry points:
  - `compose_simple(intent_or_raw)` — used by the "✅ 直接派发" path.
    Just trims the original ask. Same as the legacy behavior.
  - `compose_edited(...)` — used by the "📝 编辑后派发" submit handler.
    Stitches the user-edited details + starting point + per-suggestion
    fills into a single markdown blob with stable section headers, so
    DevOps Agent's investigator can pattern-match them as needed.

We keep this tiny + functional + side-effect-free so both Slack and
Feishu submit handlers can rely on identical formatting. Also makes
the unit test surface trivial.
"""
from __future__ import annotations

from . import i18n


_MAX_TOTAL_CHARS = 8000  # generous; anything bigger is almost certainly noise


def compose_simple(raw_text: str) -> str:
    """Direct-dispatch path. Returns the message as-is, trimmed."""
    return (raw_text or "").strip()


def compose_edited(*,
                   details: str,
                   starting_point: str = "",
                   suggestion_fills: list[tuple[str, str]] | None = None,
                   log_snippet: str = "",
                   locale: str = "en") -> str:
    """Stitch the edit-modal fields into a single markdown payload.

    Args:
        details:   The "Investigation details" textarea contents — the
                   user's main ask (often pre-filled with `intent`).
        starting_point: Optional starting-point textarea (alarm / log /
                   metric snippet). Rendered under a `## Starting point`
                   header when non-empty.
        suggestion_fills: Optional list of `(suggestion_label, user_fill)`
                   tuples — one per chip the user filled in. Rendered as
                   bullets under `## Additional context`. Empty fills
                   are skipped.
        log_snippet: Optional logs / error blob. Auto-wrapped in a
                   triple-backtick fence so DevOps Agent can parse it
                   as a literal block instead of free text. Empty →
                   section omitted.
        locale:    Controls section-header language. Bullet labels stay
                   in whatever the suggestion was authored in (zh).

    Returns the assembled markdown string, trimmed and length-capped.
    """
    parts: list[str] = []

    details = (details or "").strip()
    if details:
        parts.append(details)

    sp = (starting_point or "").strip()
    if sp:
        parts.append(i18n.t("edit.payload.starting_point_header", locale))
        parts.append(sp)

    fills = [(label, val) for (label, val) in (suggestion_fills or [])
             if (val or "").strip()]
    if fills:
        parts.append(i18n.t("edit.payload.context_header", locale))
        for label, val in fills:
            label = (label or "").strip().rstrip(":")
            val = val.strip()
            if not label:
                parts.append(f"- {val}")
            else:
                parts.append(f"- **{label}**: {val}")

    log = (log_snippet or "").strip()
    if log:
        # Strip user-supplied triple-backticks so we don't break out of
        # our own fence. Replace any inner ``` with `` (rare; pasted
        # log lines that happen to contain a fence) — non-destructive
        # since DevOps Agent reads this as literal text.
        log = log.replace("```", "``")
        parts.append(i18n.t("edit.payload.logs_header", locale))
        parts.append("```\n" + log + "\n```")

    payload = "\n\n".join(parts).strip()
    if len(payload) > _MAX_TOTAL_CHARS:
        payload = payload[:_MAX_TOTAL_CHARS] + "\n\n[truncated]"
    return payload
