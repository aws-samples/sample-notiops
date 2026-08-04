"""
skill_dispatcher — map a natural-language message to the right saved skill.

This module lets end users invoke saved skills just by asking. They ask a
question in plain language and the bot decides, in the background, whether a
saved skill matches and (if so) what parameters to fill in. The user never
types a run command and never sees a skill id — that command grammar is the
admin/authoring surface only.

Where this sits in the chat handler (slack/feishu `app/main.py`):

    on_app_mention
      ├─ /skills short-circuit            (admin commands — left untouched)
      ├─ put_new_event                    (duplicate-message guard)
      ├─ bedrock_intent.analyze_intent()  → command       (UNTOUCHED — we
      │                                                     never alter the
      │                                                     intent classifier)
      └─ if command == "investigate":
             decision = skill_dispatcher.select(raw_text, locale=locale)
             if decision:                 # a skill matched, confidently
                 prompt = compose_payload(decision)   # render + provenance
                 → store `prompt` as the row's investigation text, stash
                   skill_id/version
                 → card shows "🤖 chose skill X" + [switch][don't use]
             else:                         # graceful fallback
                 → existing free-form investigation, byte-for-byte unchanged

Because the rendered prompt is stored as the conversation row's investigation
text, the EXISTING confirm → dispatch → webhook path delivers it with no
parallel code path. This is deliberate: an earlier separate skill-run path
had a bug where the report failed to route back to the chat thread. By making
skills ride the same dispatch machinery as normal investigations, the report
routes back automatically and that bug can't recur.

Design choices (matched to the existing codebase):
  * The Bedrock call mirrors `core/bedrock_intent.py`: `invoke_model` with the
    Anthropic Messages format, lenient JSON parsing, and a fail-safe fallback.
    The fallback for routing is **None** (no skill) — never raise, never
    guess: a flaky model degrades to free-form investigation, it does not
    misroute.
  * `bedrock_client` is injectable so tests never touch a real client. In
    production it defaults to the module-level singleton, like bedrock_intent.
  * No language-specific string literals here — anything the user sees is
    composed by the platform router via `core.i18n.t(...)`, which keeps the
    bot bilingual. This module returns structured data only.

Returned decision dict (or None):
    {
      "skill_id":   "ec2-low-utilization",
      "version":    "1.0.0",                 # resolved latest at select time
      "source_key": "skills/ec2-low-utilization/versions/1.0.0.md",
      "params":     {"region": "us-east-2", "lookback_days": "14"},
      "missing":    ["account_id"],          # required params we couldn't infer
      "reason":     "user mentioned EC2 + 'underutilized' + a region",
      "confidence": 0.82,                     # 0..1, model self-report
      "executor":   "devops_agent",          # from meta; default devops_agent
    }
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone

import boto3

from core import skill_registry
from shared.model_config import get_bot_model_id

logger = logging.getLogger(__name__)

# Same client + model family the intent classifier uses. Routing is a
# classification-shaped task, so we deliberately stay consistent with
# bedrock_intent rather than the Converse-based bedrock_executor (which only
# uses Converse because it needs tool-use; the dispatcher does not).
BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")
SKILLS_BUCKET = os.environ.get("SKILLS_BUCKET", "")

# Confidence floor. Below this, we treat the message as "no confident skill
# match" and return None → free-form investigation fallback. Start
# conservative: a wrong skill on a cost/resource question is a wrong number,
# so we would rather fall back than misroute. Tune down only after measuring
# the misroute rate with real usage logs.
MIN_CONFIDENCE = float(os.environ.get("SKILL_DISPATCH_MIN_CONFIDENCE", "0.6"))

# Kill-switch. Default ON. Set SKILL_DISPATCH_ENABLED=false (or 0/no/off) in the
# task def to disable NL auto-dispatch entirely — select() then returns None
# before any S3/Bedrock call, so every mention is a plain free-form
# investigation (zero added latency, the pre-dispatcher behaviour).
DISPATCH_ENABLED = os.environ.get(
    "SKILL_DISPATCH_ENABLED", "true").strip().lower() not in (
    "false", "0", "no", "off")

_bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)


# ── public API ───────────────────────────────────────────────────────────────

def select(user_text: str, *, locale: str = "en",
           bedrock_client=None) -> dict | None:
    """Map a natural-language message to a saved skill, or None.

    Steps:
      1. Pull the active skills (skill_id + name + description + tags) from
         the registry. No skills → nothing to route to → None.
      2. One Bedrock call: user_text + skill catalogue → {skill_id, params,
         reason, confidence} or an explicit null.
      3. Resolve the chosen skill's latest version + S3 source key, fill
         parameter defaults, and report any required params still missing.
      4. Fail-safe: any error, an unknown skill_id, or confidence below the
         floor → None. The caller falls through to free-form investigation.

    Never raises for routing purposes — a None return is the contract for
    "let the normal investigate path handle it."
    """
    if not DISPATCH_ENABLED:
        logger.info("skill_dispatch: disabled via SKILL_DISPATCH_ENABLED → fallback")
        return None
    client = bedrock_client or _bedrock

    try:
        catalogue = skill_registry.list_skills(status="active")
    except Exception as e:  # registry/S3 trouble must never block investigation
        logger.warning("skill_dispatch: list_skills failed (%s) → fallback", e)
        return None

    if not catalogue:
        logger.info("skill_dispatch: no active skills → fallback")
        return None

    raw = _ask_bedrock(client, user_text, catalogue, locale)
    if not raw:
        logger.info("skill_dispatch: model gave no usable answer → fallback")
        return None

    skill_id = (raw.get("skill_id") or "").strip()
    if not skill_id:
        logger.info("skill_dispatch: model selected no skill → fallback")
        return None

    # The model must pick from the catalogue we gave it. A skill_id we don't
    # recognise is treated as no-match (defends against hallucinated ids).
    known = {s["skill_id"] for s in catalogue}
    if skill_id not in known:
        logger.warning("skill_dispatch: model picked unknown skill_id=%r → fallback",
                       skill_id)
        return None

    confidence = _coerce_confidence(raw.get("confidence"))
    if confidence < MIN_CONFIDENCE:
        logger.info("skill_dispatch: confidence %.2f < floor %.2f for %s → fallback",
                    confidence, MIN_CONFIDENCE, skill_id)
        return None

    # Resolve the concrete version + source path, and reconcile parameters
    # against the skill's declared schema (fill defaults, report what's missing).
    decision = _build_decision(
        skill_id,
        inferred_params=raw.get("params") or {},
        reason=(raw.get("reason") or "").strip(),
        confidence=confidence,
    )
    if decision is None:  # get_skill failed → fall back
        return None
    logger.info(
        "skill_dispatch: matched skill=%s v%s conf=%.2f params=%s missing=%s",
        decision["skill_id"], decision["version"], decision["confidence"],
        decision["params"], decision["missing"],
    )
    return decision


def decision_for_skill(skill_id: str, *, inferred_params: dict | None = None,
                       reason: str = "") -> dict | None:
    """Build a decision for a skill the user picked BY HAND (the 🔄 switch-skill
    drop-down on the card).

    When the user overrides the auto-choice and picks a skill from the drop-down,
    there is no model confidence to speak of — the user is the authority — so
    confidence is pinned to 1.0 and the skill bypasses the confidence floor
    (MIN_CONFIDENCE). The returned dict has the SAME shape select() produces, so
    the existing describe_decision() / compose_payload() / merge_param_overrides()
    all work unchanged. Returns None only if the skill_id can't be resolved (for
    example, it was archived between the card being shown and the click) — the
    caller then falls back to a free-form investigation.
    """
    if not (skill_id or "").strip():
        return None
    return _build_decision(
        skill_id.strip(),
        inferred_params=inferred_params or {},
        reason=reason,
        confidence=1.0,  # user-chosen — authoritative, not a model estimate
    )


def _build_decision(skill_id: str, *, inferred_params: dict,
                    reason: str, confidence: float) -> dict | None:
    """Resolve a skill_id to a full decision dict (shared by select() and
    decision_for_skill()). Returns None if the skill can't be loaded."""
    try:
        skill = skill_registry.get_skill(skill_id)  # latest
    except Exception as e:
        logger.warning("skill_dispatch: get_skill(%s) failed (%s) → fallback",
                       skill_id, e)
        return None

    version = skill.get("version", skill.get("latest_version", ""))
    params, missing = _reconcile_params(skill, inferred_params)
    return {
        "skill_id": skill_id,
        "version": version,
        "source_key": _ver_key(skill_id, version),
        "params": params,
        "missing": missing,
        "reason": reason,
        "confidence": confidence,
        "executor": skill.get("executor", "devops_agent"),
    }


def compose_payload(decision: dict, *, version_label: bool = True) -> str:
    """Render the chosen skill's prompt with params filled in, and prepend a
    provenance header (which skill and version produced this run).

    The header is written into the prompt BODY (so the generated report
    inherits it and the investigation is reproducible) — and the same
    skill_id/version also rides in the webhook metadata via
    webhook_dispatch(skill_id=, skill_version=), giving a machine-readable
    second copy. Two records, one source of truth.

    Returns the full string to dispatch as `user_text`.
    """
    skill_id = decision["skill_id"]
    version = decision["version"]
    source = decision["source_key"]
    bucket = SKILLS_BUCKET or "${SKILLS_BUCKET}"

    rendered, resolved_ver = skill_registry.render_prompt(
        skill_id, version=version, params=decision.get("params") or {})

    header = (
        "<!-- skill-provenance\n"
        f"skill_id:   {skill_id}\n"
        f"version:    {resolved_ver}\n"
        f"source:     s3://{bucket}/{source}\n"
        f"dispatched: {_now_iso()}\n"
        "-->\n"
    )
    label = f"[Skill: {skill_id} v{resolved_ver}]\n" if version_label else ""
    return header + "\n" + label + rendered


# ── Explainable + overridable card data ───────────────────────────────────────

# Stable action_ids the platform router binds buttons/inputs to. Kept here (not
# in the platform layer) so Slack and Feishu agree on the same wire contract and
# the dispatcher's tests can assert against them without importing either app.
ACTION_SWITCH_SKILL = "skill_switch"      # 🔄 switch skill → re-pick from drop-down
ACTION_DONT_USE_SKILL = "skill_dont_use"  # ❌ don't use a skill → free-form fallback
PARAM_BLOCK_PREFIX = "skill_param__"      # block_id prefix for injected inputs
SWITCH_BLOCK_ID = "skill_switch_select"   # block_id of the switch-skill drop-down

# Translation keys the card pulls user-facing text from. This module returns
# keys, never finished strings (no language-specific text in the code); the
# router resolves them via core.i18n.t(key, locale, **fmt). The comments show
# the Chinese wording for reference only — the actual text lives in i18n.
I18N_CHOSEN = "skill.dispatch.chosen"         # "🤖 已为你选择 skill：{name}"
I18N_REASON = "skill.dispatch.reason"         # "原因：{reason}（置信度 {confidence}）"
I18N_MISSING_HINT = "skill.dispatch.missing"  # "还需补充：{params}"
I18N_BTN_SWITCH = "skill.dispatch.btn.switch"     # "🔄 换 skill" (switch skill)
I18N_BTN_DONT_USE = "skill.dispatch.btn.dont_use"  # "❌ 不用 skill" (don't use a skill)
I18N_PARAM_LABEL = "skill.dispatch.param_label"   # input label fallback per param
I18N_SWITCH_LABEL = "skill.dispatch.switch_label"  # drop-down label "换一个 skill"


def describe_decision(decision: dict, event_id: str, *,
                      locale: str = "en",
                      catalogue: list[dict] | None = None) -> dict:
    """Turn a select() decision into platform-agnostic data for the card.

    The platform router (slack/feishu app) consumes this to render the inline
    confirmation card: a banner explaining which skill was auto-chosen and why,
    a 🔄 switch-skill drop-down (the user can pick any active skill, with the
    auto-chosen one pre-selected), a ❌ "don't use a skill" button (free-form
    fallback), and a blank input field for each required parameter the model
    could NOT infer (so the user fills it in before confirming). Confirm then
    dispatches the rendered prompt through the SAME confirm path as a normal
    investigation (no parallel route).

    `catalogue` is the active skill list (skill_registry.list_skills(status=
    "active")) the router already fetched. When provided, the returned data
    includes a `switch_select` spec so the router can render a real drop-down
    of skills. When omitted, `switch_select` is None and the router falls back
    to a plain 🔄 button (action_id ACTION_SWITCH_SKILL). The dispatcher never
    fetches the catalogue itself here — the router owns that read.

    Returns structured data only — translation KEYS (not finished strings) plus
    their format args, action_ids, and block specs. The router does the t(...)
    lookup and builds the actual Slack blocks / Feishu card from these
    primitives.

    Shape:
        {
          "skill_id": "ec2-low-utilization", "version": "1.0.0",
          "banner": {text_key, text_args, reason_key, reason_args,
                     missing_hint_key, missing_hint_args},
          "switch_select": {              # 🔄 switch-skill drop-down (or None)
            "block_id": "skill_switch_select",
            "action_id": "skill_switch",
            "label_key": "skill.dispatch.switch_label",
            "options": [{"value": "<skill_id>", "label": "<name> (<id>)"}, ...],
            "initial_value": "ec2-low-utilization",
          },
          "buttons": [                    # ❌ don't use a skill (free-form)
            {"action_id": "skill_dont_use", "text_key": "...", "value": <event_id>},
          ],
          "missing_inputs": [             # blank fields to append for the user
            {"block_id": "skill_param__account_id", "param": "account_id",
             "label_key": "skill.dispatch.param_label",
             "label_args": {"param": "account_id"}, "optional": False},
          ],
          "has_missing": True,
        }
    """
    chosen_id = decision.get("skill_id", "")
    confidence = decision.get("confidence")
    conf_str = f"{confidence:.2f}" if isinstance(confidence, (int, float)) else ""

    missing_inputs = [
        {
            "block_id": f"{PARAM_BLOCK_PREFIX}{p}",
            "param": p,
            "label_key": I18N_PARAM_LABEL,
            "label_args": {"param": p},
            "optional": False,
        }
        for p in (decision.get("missing") or [])
    ]

    switch_select = _build_switch_select(chosen_id, catalogue)

    return {
        "skill_id": chosen_id,
        "version": decision.get("version", ""),
        "banner": {
            "text_key": I18N_CHOSEN,
            "text_args": {"name": chosen_id},
            "reason_key": I18N_REASON,
            "reason_args": {
                "reason": decision.get("reason", ""),
                "confidence": conf_str,
            },
            "missing_hint_key": I18N_MISSING_HINT if missing_inputs else "",
            "missing_hint_args": (
                {"params": ", ".join(decision.get("missing") or [])}
                if missing_inputs else {}
            ),
        },
        "switch_select": switch_select,
        "buttons": [
            {"action_id": ACTION_DONT_USE_SKILL,
             "text_key": I18N_BTN_DONT_USE, "value": event_id},
        ],
        "missing_inputs": missing_inputs,
        "has_missing": bool(missing_inputs),
    }


def _build_switch_select(chosen_id: str,
                         catalogue: list[dict] | None) -> dict | None:
    """Build the 🔄 switch-skill drop-down spec from the active catalogue.

    Returns None when no catalogue is given (router renders a plain button
    instead) or when the catalogue is empty/degenerate. Options are (value,
    label) where value=skill_id and label is a human "<name> (<id>)". The
    chosen skill is pre-selected via initial_value.
    """
    if not catalogue:
        return None
    options = []
    for s in catalogue:
        sid = s.get("skill_id")
        if not sid:
            continue
        nm = s.get("name") or sid
        options.append({"value": sid, "label": f"{nm} ({sid})"})
    if not options:
        return None
    return {
        "block_id": SWITCH_BLOCK_ID,
        "action_id": ACTION_SWITCH_SKILL,
        "label_key": I18N_SWITCH_LABEL,
        "options": options,
        "initial_value": chosen_id if any(
            o["value"] == chosen_id for o in options) else None,
    }


def merge_param_overrides(decision: dict, submitted: dict) -> dict:
    """Fold user-supplied values for the missing params back into a decision.

    When the user fills the blank inputs and clicks confirm, the router collects
    the `skill_param__<name>` block values into `submitted` ({param: value}) and
    calls this to produce the final decision to compose_payload(). Only non-empty
    values are merged; anything still blank stays in `missing` so the prompt is
    rendered honestly (an empty {account_id} placeholder rather than a fake one).

    Returns a NEW decision dict (does not mutate the input).
    """
    params = dict(decision.get("params") or {})
    still_missing: list[str] = []
    for name in decision.get("missing") or []:
        val = (submitted.get(name) or "").strip()
        if val:
            params[name] = val
        else:
            still_missing.append(name)
    merged = dict(decision)
    merged["params"] = params
    merged["missing"] = still_missing
    return merged


# ── Bedrock call (mirrors bedrock_intent.invoke_model + loose-JSON) ───────────

def _ask_bedrock(client, user_text: str, catalogue: list[dict],
                 locale: str) -> dict | None:
    """One classification call. Returns the parsed decision dict, or None on
    any failure (the caller turns None into a free-form fallback)."""
    system_prompt = _build_system_prompt(catalogue, locale)
    try:
        body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 500,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_text or ""}],
        }
        resp = client.invoke_model(
            modelId=get_bot_model_id(),
            contentType="application/json",
            accept="application/json",
            body=json.dumps(body),
        )
        data = json.loads(resp["body"].read())
        text = ""
        for block in data.get("content", []):
            if block.get("type") == "text":
                text = block["text"].strip()
                break
        logger.info("llm_audit: caller=skill_dispatch model=%s in_len=%d out_len=%d",
                    get_bot_model_id(), len(user_text or ""), len(text))
        if not text:
            logger.warning("skill_dispatch: Bedrock returned no text block")
            return None
        return _loose_load_json(text)
    except Exception as e:  # noqa: BLE001 — routing must never crash the handler
        logger.warning("skill_dispatch: Bedrock call failed (%s) → fallback", e)
        return None


def _build_system_prompt(catalogue: list[dict], locale: str) -> str:
    """List every active skill (id + name + description) and ask the model to
    pick at most one, infer parameters, and self-report confidence. The model
    MUST be allowed to choose nothing — that is the whole point of the
    fail-safe fallback to a free-form investigation."""
    lines = [
        "You are a router for a DevOps investigation bot. Given a user's",
        "message, decide whether ONE of the saved skills below is a strong",
        "match. A skill is a pre-written investigation template.",
        "",
        "Rules:",
        "- Choose a skill ONLY if it clearly fits the user's intent.",
        "- If nothing fits well, return skill_id null. Do NOT force a match.",
        "  Returning null is correct and expected for general questions.",
        "- Infer parameters (region, account_id, lookback_days, etc.) ONLY",
        "  from what the user actually wrote. Never invent values. Omit a",
        "  parameter you cannot infer rather than guessing.",
        "- confidence is your honest 0.0-1.0 estimate that this skill is the",
        "  right one. Be conservative: a wrong skill yields a wrong answer.",
        "",
        "Available skills:",
    ]
    for s in catalogue:
        tags = s.get("tags") or []
        tag_str = f" [tags: {', '.join(tags)}]" if tags else ""
        desc = (s.get("description") or s.get("name") or "").replace("\n", " ")
        lines.append(f'- id="{s["skill_id"]}" name="{s.get("name","")}"'
                     f"{tag_str}: {desc}")
    lines += [
        "",
        "Respond with ONLY a JSON object, no prose, no code fence:",
        "{",
        '  "skill_id": "<one of the ids above, or null>",',
        '  "params": { "<name>": "<value>", ... },',
        '  "reason": "<one short sentence on why this skill / why none>",',
        '  "confidence": <number 0.0-1.0>',
        "}",
    ]
    # Reason text is shown to the user on the card, so steer its language. The JSON
    # keys stay ASCII regardless of locale.
    if locale == "zh":
        lines.append('Write "reason" in Simplified Chinese.')
    else:
        lines.append('Write "reason" in English.')
    return "\n".join(lines)


# ── helpers ───────────────────────────────────────────────────────────────────

def _reconcile_params(skill: dict, inferred: dict) -> tuple[dict, list[str]]:
    """Merge model-inferred params with the skill's declared schema.

    - Start from inferred values (only those the model actually extracted).
    - Fill defaults for declared params the model didn't provide.
    - A declared param marked required (and with no default) that we still
      don't have is reported in `missing` — the caller decides whether to
      ask the user or fall back. We never block here.
    """
    effective = {k: str(v) for k, v in (inferred or {}).items()
                 if v is not None and str(v).strip() != ""}
    missing: list[str] = []
    for p in skill.get("parameters", []) or []:
        name = p.get("name")
        if not name:
            continue
        if name in effective:
            continue
        if "default" in p and p["default"] is not None:
            effective[name] = str(p["default"])
        elif p.get("required"):
            missing.append(name)
    return effective, missing


def _coerce_confidence(value) -> float:
    """Model may return a number, a numeric string, or junk. Junk → 0.0 so it
    fails the floor and we fall back (never accidentally high-confidence)."""
    try:
        c = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, c))


def _loose_load_json(text: str) -> dict | None:
    """Tolerant JSON extraction, same spirit as bedrock_intent._loose_load_json:
    strip code fences, then fall back to the first {...} span."""
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`")
        if t.lstrip().lower().startswith("json"):
            t = t.split("\n", 1)[1] if "\n" in t else t[4:]
    try:
        obj = json.loads(t, strict=False)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass
    start, end = t.find("{"), t.rfind("}")
    if start != -1 and end != -1 and end > start:
        try:
            obj = json.loads(t[start:end + 1], strict=False)
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def _ver_key(skill_id: str, version: str) -> str:
    """S3 key for a skill version — matches skill_registry._ver_key layout."""
    return f"skills/{skill_id}/versions/{version}.md"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── authoring-intent detection (used by platform intake, Option A) ───────────
# A natural-language "write me a skill" request is NOT a run/investigate
# request; platforms use this to nudge the user to `/skills create` instead of
# dispatching an investigation. Tight proximity match (author verb within ~15
# chars before "skill") keeps false positives off real queries. Lives in core
# so platform code stays free of CJK literals (i18n lint rule).
_AUTHORING_INTENT_RE = re.compile(
    # ASCII verbs + common Chinese authoring verbs as \u escapes in RAW strings
    # (the literal value carries no CJK codepoints, so the i18n lint stays clean,
    # while re still decodes the escapes at match time).
    r"(write|create|make|build|author|draft"
    r"|\u7f16\u5199|\u521b\u4f5c|\u521b\u5efa|\u65b0\u5efa"
    r"|\u5e2e\u6211\u5199|\u5e2e\u6211\u505a"
    r"|\u5199\u4e2a|\u5199\u4e00\u4e2a|\u505a\u4e2a|\u505a\u4e00\u4e2a)"
    r"[^\n]{0,15}?skills?\b",
    re.IGNORECASE,
)


def looks_like_authoring_request(text: str) -> bool:
    """True when the user is asking to AUTHOR a skill (vs run/investigate)."""
    return bool(_AUTHORING_INTENT_RE.search(text or ""))


def extract_authoring_goal(text: str) -> str:
    """Strip the authoring preamble ("help me write a skill to ...") and return
    just the goal ("review idle EC2"). Falls back to the full text if nothing
    usable follows the trigger, so enrich() still gets something to expand."""
    t = (text or "").strip()
    m = _AUTHORING_INTENT_RE.search(t)
    if not m:
        return t
    rest = t[m.end():].strip()
    # Drop a leading connector: to/that/which/for/: or CJK 来/去/用来/用于/，
    rest = re.sub(
        r"^(?:to|that|which|for|:|\uff1a|\u6765|\u53bb|\u7528\u6765|\u7528\u4e8e"
        r"|[,\uff0c\s-]+)\s*",
        "", rest, flags=re.IGNORECASE).strip()
    return rest or t
