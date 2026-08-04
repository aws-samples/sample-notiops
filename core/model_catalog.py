"""Catalogue of LLM aliases the bot supports.

This is the single source of truth for the user-facing `@bot model X`
command and the `DefaultLlmProvider` CFN parameter. Each alias maps to:

  - model_id:   the wire-level identifier (Bedrock model id, or
                "<provider>:<id>" for non-Bedrock backends like
                GPT-5.4 on Bedrock Mantle Responses)
  - label:      friendly name surfaced to users in the footer / chat
                replies (e.g. "Claude Sonnet 4.6")
  - kind:       which API backend this is. Today:
                  - "bedrock_anthropic" → InvokeModel + Anthropic body
                                          (Claude Sonnet 4.6)
                  - "bedrock_converse"  → Bedrock Converse API
                                          (Amazon Nova family)
                  - "bedrock_mantle_responses"
                                        → SigV4-signed POST to
                                          bedrock-mantle.<region>.api.aws/openai/v1
                                          (GPT-5.4 / GPT-5.5)
                The `kind` decides which code path inside
                `bedrock_chat.py` runs the request. Only the first two
                are implemented in `bedrock_chat.py`;
                `bedrock_mantle_responses` is implemented via the
                separate `core/openai_responses_client.py` (SigV4-
                signed cross-region POST to bedrock-mantle).

Adding a new alias is a single dict entry below + (if needed) a new
`kind` handler in `bedrock_chat.py`. No CFN change required when the
alias maps to an existing kind.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelEntry:
    alias: str       # short, lowercase, [a-z0-9_]
    model_id: str    # what the wire format expects in `modelId`
    label: str       # human-friendly footer / list display
    kind: str        # API backend: bedrock_anthropic / bedrock_converse / bedrock_mantle_responses
    # Output token cap passed to the model on every call. Sized per
    # model based on (a) the API's documented hard limit and (b) what
    # a "long-but-not-runaway" reply needs in this app — markdown
    # body + `📚 来源` block (3-6 URLs) + `🔧 调用的 MCP 工具` trailer.
    # Reason for per-entry instead of a single constant:
    #   - Nova Pro's documented output limit is 5K. Setting a single
    #     constant equal to "all models' max" leaves Nova at the
    #     ceiling with no headroom and the TR header / URL list at
    #     the end gets clipped (2026-06-05 user incident: a `[AWS
    #     官方网站](` link in the Nova reply was cut mid-URL).
    #   - Claude Sonnet 4.6 supports 64K output. We don't want to use
    #     all of that — high caps just enable runaways — but we do
    #     want headroom over Nova so multi-region pricing tables /
    #     WA pillar deep dives never clip.
    #   - GPT-5.4 needs 8K specifically because its tool-use turns
    #     spend most of the budget on hidden reasoning before the
    #     `function_call.arguments` JSON; truncating the JSON was
    #     the 2026-06-05 protocol-leak incident.
    max_output_tokens: int


# Insertion order = display order in `@bot model list`.
_CATALOG: dict[str, ModelEntry] = {
    "claude": ModelEntry(
        alias="claude",
        model_id="us.anthropic.claude-sonnet-5",
        label="Claude Sonnet 5",
        kind="bedrock_anthropic",
        max_output_tokens=6000,
    ),
    "opus": ModelEntry(
        alias="opus",
        # Claude Opus 5: strongest model, for deep root-cause / complex
        # analysis. Same bedrock_anthropic invoke path as Sonnet. Hard
        # output cap is 128K (verified 2026-07), but IM replies are chat
        # -sized so we keep the same 6000 headroom as Sonnet — enough for
        # the body + citation block, no runaways.
        model_id="us.anthropic.claude-opus-5",
        label="Claude Opus 5",
        kind="bedrock_anthropic",
        max_output_tokens=6000,
    ),
    "nova": ModelEntry(
        alias="nova",
        model_id="amazon.nova-pro-v1:0",
        label="Amazon Nova Pro",
        kind="bedrock_converse",
        # Nova Pro's documented hard cap is 5000. Sit at the ceiling
        # so concept Q&A with full citation block fits.
        max_output_tokens=5000,
    ),
    "gpt": ModelEntry(
        alias="gpt",
        # dotted form is the canonical model id at
        # https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses.
        model_id="openai.gpt-5.6-terra",
        label="GPT-5.6 Terra",
        kind="bedrock_mantle_responses",
        max_output_tokens=8000,
    ),
    # GPT-5.6 Sol / Luna: same GPT-5.6 family, same Bedrock Mantle Responses
    # path + region (GPT_REGION, us-east-2) as Terra — only the model_id
    # differs. Same 8K output cap for the same tool-use-reasoning reason.
    "gpt_sol": ModelEntry(
        alias="gpt_sol",
        model_id="openai.gpt-5.6-sol",
        label="GPT-5.6 Sol",
        kind="bedrock_mantle_responses",
        max_output_tokens=8000,
    ),
    "gpt_luna": ModelEntry(
        alias="gpt_luna",
        model_id="openai.gpt-5.6-luna",
        label="GPT-5.6 Luna",
        kind="bedrock_mantle_responses",
        max_output_tokens=8000,
    ),
}

DEFAULT_ALIAS = "claude"


def get(alias: str | None) -> ModelEntry:
    """Resolve an alias to a model entry. If `alias` isn't a known
    catalogue key, treat it as a raw model_id and attempt a reverse
    lookup (supports dynamic SSM-configured models like claude-sonnet-5
    without needing an explicit catalogue entry). Falls back to the
    default alias only if both lookups fail."""
    a = (alias or "").strip().lower()
    entry = _CATALOG.get(a)
    if entry:
        return entry
    # Not a known alias — maybe it's a raw model_id from SSM/env.
    entry = find_by_model_id(a)
    if entry:
        return entry
    return _CATALOG[DEFAULT_ALIAS]


def is_known(alias: str | None) -> bool:
    """Membership test: accepts both catalogue aliases AND raw model_ids
    that find_by_model_id can resolve (so SSM-configured models pass
    validation without explicit catalogue registration)."""
    a = (alias or "").strip().lower()
    if a in _CATALOG:
        return True
    return find_by_model_id(a) is not None


def list_aliases() -> list[str]:
    return list(_CATALOG)


def all_entries() -> list[ModelEntry]:
    """Used by `@bot model list` to render the full table."""
    return list(_CATALOG.values())


def find_by_model_id(model_id: str) -> ModelEntry | None:
    """Reverse lookup — find the catalogue entry for a Bedrock model id.

    Exact match first; then fallback: Anthropic model ids that aren't
    explicitly catalogued get a dynamic entry with bedrock_anthropic kind
    (same invoke path as all Claude models). This avoids needing a code
    change every time AWS adds a new Claude variant."""
    for entry in _CATALOG.values():
        if entry.model_id == model_id:
            return entry
    # Fallback for uncatalogued Anthropic models (e.g. claude-sonnet-5)
    if "anthropic" in (model_id or "").lower():
        return ModelEntry(
            alias="claude",
            model_id=model_id,
            label=_anthropic_label(model_id),
            kind="bedrock_anthropic",
            max_output_tokens=6000,
        )
    return None


def _anthropic_label(model_id: str) -> str:
    """Derive a human-friendly label from an Anthropic model id.
    e.g. 'global.anthropic.claude-sonnet-5' → 'Claude Sonnet 5'"""
    # Strip prefix (us./eu./global./apac. + anthropic.)
    name = model_id.lower()
    for prefix in ("global.", "us.", "eu.", "apac."):
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    name = name.removeprefix("anthropic.")
    # claude-sonnet-5 → Claude Sonnet 5
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
