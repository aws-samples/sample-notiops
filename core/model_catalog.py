"""Catalogue of LLM aliases the bot supports — **adapter over the DDB catalogue**.

Since 2026-08 (spec task 4.1) this module no longer owns a model list. The
single source of truth is DynamoDB `PK=llmcfg`, read through
`core/llm_config.py`, which the admin edits in the web console
("Admin → Models"). This module keeps the small, stable surface that the IM
code already speaks —

    get / is_known / list_aliases / all_entries / find_by_model_id / DEFAULT_ALIAS

— so `bedrock_chat.py` and the three `platforms/*/app/main.py` copies did not
have to change. What *did* change is the meaning of the answers: they now
reflect the admin-enabled set for the `im` surface, so disabling a model in the
console removes it from `@bot model list` and makes stored preferences for it
expire on the next message.

Why an adapter instead of deleting this module and calling `llm_config`
directly from five call sites:
  * `get()` must never raise and never return None — `bedrock_chat.respond()`
    calls it without a try block, so an exception there swallows the whole
    reply. Concentrating that guarantee in one place is safer than trusting
    five call sites.
  * `ModelEntry` (frozen dataclass, `.alias/.label/.kind/.max_output_tokens`)
    is what the platform code renders. `llm_config` speaks dicts and
    `ResolvedModel`. The translation belongs somewhere.

Two alias namespaces coexist on purpose
---------------------------------------
The DDB catalogue is keyed on *canonical* aliases (`claude-sonnet-5`), while IM
users type — and 30-day preference rows in DynamoDB already store — *short*
ones (`claude`, `opus`, `gpt_sol`). `llm_config.is_enabled()` /
`llm_config.resolve()` accept canonical, short and `aliases_legacy` forms, so
both keep working; had admission control accepted canonical names only, every
stored preference row would have silently expired the moment this shipped.
User-facing lists still show the short form (`ModelEntry.alias` below), so
`@bot model` reads exactly as it did before.

Fail-safety is inherited, not reimplemented: `llm_config.get_config()` falls
back to its own builtin catalogue snapshot when DynamoDB is unreachable and
never raises. That is why there is no local `_CATALOG` copy any more — a second
hardcoded list is a second thing to drift.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

from . import llm_config

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ModelEntry:
    alias: str       # short, lowercase — what users type and what lists show
    model_id: str    # what the wire format expects in `modelId`
    label: str       # human-friendly footer / list display
    kind: str        # bedrock_anthropic / bedrock_converse / bedrock_mantle_responses
    # Output token cap passed to the model on every call. Now computed by
    # `llm_config` as min(model's documented hard limit, this surface's target)
    # with an explicit per-surface override where a model needs more. The
    # reasons those numbers are per-model, not one constant, still hold:
    #   - Nova Pro's documented output limit is ~5K. A single "max of all
    #     models" constant leaves it at the ceiling and the trailing `📚 来源`
    #     URL list gets clipped (2026-06-05 incident: an `[AWS 官方网站](`
    #     link cut mid-URL).
    #   - Claude supports far more, but high caps just enable runaways; IM
    #     replies are chat-sized, so 6000 gives headroom over Nova without
    #     inviting a wall of text.
    #   - The GPT-5.6 family needs 8000 specifically because its tool-use
    #     turns spend most of the budget on hidden reasoning before emitting
    #     `function_call.arguments`; truncating that JSON was the 2026-06-05
    #     protocol-leak incident.
    max_output_tokens: int


# Last-resort alias. Deliberately the *short* form: it is also the `short` of
# the seed's default (`claude-sonnet-5`), and `llm_config` accepts short
# aliases, so this resolves even when DynamoDB is unreachable.
DEFAULT_ALIAS = "claude"

# Absolute floor, used only if `llm_config` itself somehow fails (it is written
# not to raise, but `get()` is on the critical path of every reply and must not
# be the thing that breaks it).
# `max_output_tokens` is the IM surface target, not the model's ceiling: Sonnet
# 5's documented hard limit is 128000 and its catalogue entry carries
# `output_override.im = 6000`, so the normal path resolves to 6000 — the floor
# must match that, not the model card.
_FLOOR = ModelEntry(
    alias=DEFAULT_ALIAS,
    model_id="global.anthropic.claude-sonnet-5",
    label="Claude Sonnet 5",
    kind="bedrock_anthropic",
    max_output_tokens=6000,
)


def _display_alias(raw: dict) -> str:
    """Short alias when the catalogue defines one, else the canonical alias.

    Keeps `@bot model list` and the `model.unknown` hint reading the way they
    always have (`claude`, `opus`, `nova`, `gpt`…) even though the catalogue is
    keyed canonically.
    """
    return str(raw.get("short") or raw.get("alias") or "")


def _entry_from(raw: dict, cfg: dict | None = None) -> ModelEntry:
    """Raw catalogue dict → ModelEntry, with surface resolution applied.

    `llm_config.resolve()` is what applies the per-surface model_id and output
    cap; the raw dict is only consulted for `short`, which `ResolvedModel` does
    not carry.

    `cfg` is threaded through by the list-walking callers so a whole listing is
    resolved against **one** snapshot. Without it, each entry re-enters
    `get_config()`, and a TTL expiry mid-loop yields a torn listing — entry 0
    resolved under generation N, entry 5 under N+1.
    """
    # `resolve_entry` 而非 `resolve`：后者会把不在启用集内的 alias 换成默认模型，
    # 用来描述一个已停用条目会得到默认模型的 model_id 和上限（正是 find_by_model_id
    # 要避免的）。这里已经拿着条目本身，不需要查找、更不需要替换。
    del cfg  # 不再需要快照：解析只依赖 raw 本身，因此整份列表天然同代
    resolved = llm_config.resolve_entry(raw)
    return ModelEntry(
        alias=_display_alias(raw) or resolved.alias,
        model_id=resolved.model_id,
        label=resolved.label,
        kind=resolved.kind,
        max_output_tokens=resolved.max_output_tokens,
    )


def get(alias: str | None) -> ModelEntry:
    """Resolve an alias to a model entry. **Never raises, never returns None.**

    Accepts canonical, short and legacy aliases. Anything not in the
    admin-enabled set for this surface resolves to the enabled default rather
    than failing — including stored preferences for a model the admin has since
    disabled (spec R3.3). Callers that need to *know* whether a substitution
    happened should ask `llm_config.was_substituted()`.
    """
    try:
        resolved = llm_config.resolve(alias)
        # Recover the short form for display: resolve() answers canonically.
        raw = _find_raw(resolved.alias)
        return ModelEntry(
            alias=(_display_alias(raw) if raw else resolved.alias),
            model_id=resolved.model_id,
            label=resolved.label,
            kind=resolved.kind,
            max_output_tokens=resolved.max_output_tokens,
        )
    except Exception as e:  # noqa: BLE001 — respond() has no try around this
        logger.warning("model_catalog.get(%r) failed (%s); using floor entry",
                       alias, type(e).__name__)
        return _FLOOR


def _find_raw(canonical_alias: str) -> dict | None:
    for m in llm_config.enabled_entries():
        if str(m.get("alias")) == canonical_alias:
            return m
    return None


def is_known(alias: str | None) -> bool:
    """**Admission control** — is this alias in the admin-enabled set?

    Gates user input (`@bot model X`) and stored preferences
    (`llm_pref_resolver._read_alias` / `_write_alias`). Accepts canonical,
    short and legacy aliases; rejects everything else, including raw model ids.

    Why strict (2026-08, spec R1.8/R3.5): this used to fall through to
    `find_by_model_id()`, whose "anything containing `anthropic` is fine"
    fallback let users pin *arbitrary* model ids — the admin-curated set could
    be bypassed by typing a raw id. Admission control must not share a code
    path with metadata reverse-lookup.

    Fails closed: if the catalogue cannot be read at all, nothing is admitted
    and callers fall back to the default model.
    """
    try:
        return llm_config.is_enabled(alias)
    except Exception as e:  # noqa: BLE001
        logger.warning("model_catalog.is_known(%r) failed (%s); denying",
                       alias, type(e).__name__)
        return False


def list_aliases() -> list[str]:
    """Enabled aliases in display form — feeds the `model.unknown` hint.

    Must stay in step with `all_entries()`: if this listed models the user
    cannot actually select, the error message would recommend a dead option.
    """
    try:
        return [_display_alias(m) for m in llm_config.enabled_entries()]
    except Exception as e:  # noqa: BLE001
        logger.warning("model_catalog.list_aliases failed (%s)", type(e).__name__)
        return [DEFAULT_ALIAS]


def all_entries() -> list[ModelEntry]:
    """Enabled entries, catalogue order — renders `@bot model list`."""
    try:
        cfg = llm_config.get_config()
        return [_entry_from(m, cfg) for m in llm_config.enabled_entries(cfg)]
    except Exception as e:  # noqa: BLE001
        logger.warning("model_catalog.all_entries failed (%s)", type(e).__name__)
        return [_FLOOR]


def find_by_model_id(model_id: str) -> ModelEntry | None:
    """Reverse lookup — **metadata description only, NOT admission control.**

    Given a model id we already trust, return an entry carrying its label /
    kind / max_output_tokens. Exact match against the enabled set first; then a
    deliberately loose fallback so an uncatalogued Anthropic id still gets a
    sane label and output cap instead of the conservative global default (see
    `bedrock_chat._max_output_tokens_for`, which otherwise clamps to 3000).

    ⚠️ MUST NOT validate user input — the loose fallback accepts arbitrary ids
    and would bypass the curated set. Use `is_known()` for that (spec R1.8/R3.5).
    """
    try:
        # **全集**，含已停用条目。停用一个模型不该让在途请求的输出上限退化到
        # `bedrock_chat._MAX_OUTPUT_TOKENS_FALLBACK`（3000）—— 那正是 2026-06-05
        # 来源块被截断那次事故的成因。准入仍由 `is_known()` 严格把关，二者分离。
        cfg = llm_config.get_config()
        for raw in llm_config.entries(cfg):
            entry = _entry_from(raw, cfg)
            if entry.model_id == model_id:
                return entry
    except Exception as e:  # noqa: BLE001
        logger.warning("model_catalog.find_by_model_id lookup failed (%s)",
                       type(e).__name__)
    if "anthropic" in (model_id or "").lower():
        return ModelEntry(
            alias=DEFAULT_ALIAS,
            model_id=model_id,
            label=_anthropic_label(model_id),
            kind="bedrock_anthropic",
            max_output_tokens=6000,
        )
    return None


def _anthropic_label(model_id: str) -> str:
    """Derive a human-friendly label from an Anthropic model id.
    e.g. 'global.anthropic.claude-sonnet-5' → 'Claude Sonnet 5'"""
    name = model_id.lower()
    for prefix in ("global.", "us.", "eu.", "apac."):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    name = name.removeprefix("anthropic.")
    return name.replace("-", " ").title()


__all__ = [
    "ModelEntry",
    "DEFAULT_ALIAS",
    "get",
    "is_known",
    "list_aliases",
    "all_entries",
    "find_by_model_id",
]
