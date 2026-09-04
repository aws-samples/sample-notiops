"""
core/skill_authoring.py — let the model help write and update skills.

A "skill" is a reusable, versioned investigation prompt template stored in S3
(see this prototype's README for the full picture). This module turns skill
**creation and update** from "hand-write a detailed, well-structured prompt"
into "say a one-line goal, review the model's draft, click save." The team's
rule is that this review-before-save step is mandatory: every create and every
update is expanded to AWS best practice and shown to the admin for explicit
approval before anything is written to S3.

This module deliberately mirrors the sibling `core/skill_dispatcher.py` module:
  * One `core.bot_llm` call per model request, with lenient JSON parsing and a
    fail-safe fallback (same approach as `core/bedrock_intent.py`). Since
    2026-09-01 that goes over the Bedrock **Converse** API, not the hand-rolled
    Anthropic Messages body — see `core/bot_llm.py` for why.
  * 2026-09-01: the old injectable `bedrock_client=` parameter is gone (nothing
    ever passed it; `invoke_llm` builds its own client). To fake the model,
    patch `skill_authoring.bot_llm.invoke_bot_text`.
  * It returns **plain data structures only** — no finished user-facing
    sentences, and no Chinese-language string literals. Every piece of text the
    admin sees is looked up by a translation key through `core.i18n.t(...)` in
    the chat-platform layer, which keeps the bot bilingual.

Public API
----------
- enrich(goal, *, locale="en") -> dict | None
    Expand a loose goal into a structured skill draft:
    {suggested_skill_id, name, description, prompt, parameters[], tags[]}.
    Returns None on any failure (caller keeps the raw goal / asks again).

- lint(draft) -> list[dict]
    Static quality gate over a draft (or any skill payload). Returns a list of
    findings: [{code, level, param?, message_key, message_args}]. level is
    "error" (block save) or "warn" (show, allow save). Pure — no Bedrock.
    Catches the placeholder↔parameter mismatches an LLM commonly produces.

- propose_semver(current_version, old_prompt, new_prompt, *, locale="en") -> dict
    Ask the LLM to classify an update's magnitude (patch/minor/major) and
    compute the resulting version. Fail-safe: any error → patch bump (the
    safest, smallest assumption). Returns {bump_level, next_version, reason}.

- describe_draft(draft, findings, *, locale="en", mode="create",
                 current_version=None, next_version=None) -> dict
    Turn a draft + lint findings into platform-agnostic confirm-card data: a
    summary banner, the parameter table, lint warnings, the version line, and
    the three action buttons (✅ save / ✏️ edit / ❌ cancel). i18n KEYS only.

- merge_admin_edits(draft, edits) -> dict
    Fold admin-supplied field overrides (name/description/prompt/tags) back into
    a draft before save (the ✏️ edit path). Returns a NEW dict.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

from core import bot_llm
from core import skill_registry

logger = logging.getLogger(__name__)

# ── Bedrock config — same client + model family as the dispatcher / intent ───
# 2026-09-01：本模块那几处「一个 system prompt + 一段文本 → 一段（通常是 JSON 的）
# 文本」的调用，从手搓 Anthropic body 的 invoke_model 换成 core/bot_llm 的 Converse
# 统一入口。理由与取舍全在 core/bot_llm.py 的模块 docstring 里。
# 顺带删掉 `_bedrock` / `BEDROCK_REGION`：`invoke_llm` 每次调用自己建 client（比
# LazyClient 更不会拿到过期凭证），而 BEDROCK_REGION 在三条部署路径里恒等于
# `cdk.Aws.REGION` = Lambda 自己的区域 = boto3 默认区域，去掉是**零行为变化**。

# Mirror skill_registry's id rule so a suggested id never fails create_skill.
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
_PLACEHOLDER_RE = re.compile(r"\{([a-zA-Z_][a-zA-Z0-9_]*)\}")
_MIN_PROMPT_LEN = 20            # matches skill_registry.create_skill's floor

# ── Action ids + i18n keys (the platform layer renders these) ─────────────────
ACTION_SAVE_SKILL = "skill_author_save"
ACTION_EDIT_SKILL = "skill_author_edit"
ACTION_CANCEL_SKILL = "skill_author_cancel"
DRAFT_BLOCK_PREFIX = "skill_draft__"          # edit-field inputs: skill_draft__<field>

I18N_DRAFT_BANNER = "skill.author.draft"          # 🤖 expanded your goal into …
I18N_DRAFT_PARAMS = "skill.author.params"          # parameter table header
I18N_DRAFT_PARAM_ROW = "skill.author.param_row"    # one param line
I18N_DRAFT_NO_PARAMS = "skill.author.no_params"
I18N_VERSION_NEW = "skill.author.version_new"      # create: will save as v1.0.0
I18N_VERSION_BUMP = "skill.author.version_bump"    # update: v1.0.0 → v1.1.0 (minor)
I18N_LINT_HEADER = "skill.author.lint_header"
I18N_BTN_SAVE = "skill.author.btn.save"
I18N_BTN_EDIT = "skill.author.btn.edit"
I18N_BTN_CANCEL = "skill.author.btn.cancel"

# Lint message keys (one per code).
_LINT_KEYS = {
    "placeholder_without_param": "skill.author.lint.placeholder_without_param",
    "param_without_placeholder": "skill.author.lint.param_without_placeholder",
    "required_with_default":      "skill.author.lint.required_with_default",
    "prompt_too_short":           "skill.author.lint.prompt_too_short",
    "bad_skill_id":               "skill.author.lint.bad_skill_id",
    "missing_name":               "skill.author.lint.missing_name",
    "no_placeholders":            "skill.author.lint.no_placeholders",
    "unsafe_prompt":              "skill.author.lint.unsafe_prompt",
}

# Prompt-safety deny-list. A skill prompt is fed to the investigation agent
# (broad read access), so an authored prompt that tries to override the agent's
# instructions, exfiltrate secrets, or trigger mutating/destructive actions is a
# blocking error. Conservative substring/word patterns — flags for human review,
# not a security boundary on their own.
_UNSAFE_PATTERNS = re.compile(
    r"(?i)("
    r"ignore (all |the )?(previous|prior|above) (instructions|rules)"
    r"|disregard (the |all )?(previous|prior|system)"
    r"|you are now|act as (a )?(system|admin|root)"
    r"|exfiltrat|leak (the )?(secret|credential|token|password)"
    r"|print (the )?(secret|credential|env|environment variable)"
    r"|aws_secret_access_key|aws_access_key_id|secret access key"
    r"|delete |terminate |drop table|rm -rf|shutdown"
    r"|curl http|wget http|base64 -d|/dev/tcp/"
    r")")


def _scan_prompt_safety(prompt: str) -> list[str]:
    """Return distinct unsafe snippets found in the prompt (empty = clean)."""
    return sorted({m.group(0).strip() for m in _UNSAFE_PATTERNS.finditer(prompt or "")})


# ── 1. enrich: goal → structured draft ───────────────────────────────────────

def enrich(goal: str, *, locale: str = "en") -> dict | None:
    """Expand a one-line goal into a structured skill draft.

    Returns a dict {suggested_skill_id, name, description, prompt,
    parameters[], tags[]} or None on any failure (the caller falls back to
    asking the admin to write it by hand, or to retry). Never raises.
    """
    if not (goal or "").strip():
        return None
    raw = _ask_bedrock(_enrich_system_prompt(locale), goal.strip())
    if not isinstance(raw, dict):
        return None
    return _normalize_draft(raw, goal)


def _normalize_draft(raw: dict, goal: str) -> dict | None:
    """Coerce the model's JSON into a clean draft. Drop a draft whose prompt is
    unusable; otherwise repair what we safely can (ids, param shapes)."""
    prompt = (raw.get("prompt") or "").strip()
    if len(prompt) < _MIN_PROMPT_LEN:
        logger.warning("skill_author: enriched prompt too short → None")
        return None

    sid = (raw.get("suggested_skill_id") or raw.get("skill_id") or "").strip().lower()
    sid = re.sub(r"[^a-z0-9-]+", "-", sid).strip("-")
    if not _ID_RE.match(sid):
        sid = ""                # let the admin / command supply the id

    params: list[dict] = []
    seen = set()
    for p in raw.get("parameters") or []:
        if not isinstance(p, dict):
            continue
        name = (p.get("name") or "").strip()
        if not name or name in seen:
            continue
        seen.add(name)
        entry: dict = {"name": name}
        if p.get("default") is not None and str(p.get("default")).strip() != "":
            entry["default"] = str(p["default"])
        # A param with a usable default is, by definition, not "required" (it
        # always resolves) — keep the schema internally consistent.
        if p.get("required") and "default" not in entry:
            entry["required"] = True
        if p.get("description"):
            entry["description"] = str(p["description"])
        params.append(entry)

    tags = [str(t).strip() for t in (raw.get("tags") or []) if str(t).strip()]

    return {
        "suggested_skill_id": sid,
        "name": (raw.get("name") or "").strip(),
        "description": (raw.get("description") or "").strip(),
        "prompt": prompt,
        "parameters": params,
        "tags": tags[:8],
        "source_goal": goal.strip(),
    }


def _enrich_system_prompt(locale: str) -> str:
    lines = [
        "You design reusable DevOps investigation skills for an AWS support bot.",
        "Given a loose one-line goal from an admin, expand it into ONE complete,",
        "well-structured skill template that follows AWS best practice.",
        "",
        "The skill's `prompt` is what gets fed to an investigation agent. Make it:",
        "- specific about which AWS data / metrics to inspect (name real ones;",
        "  e.g. CloudWatch CPUUtilization, Cost Explorer, Trusted Advisor checks);",
        "- explicit about the output format the agent should return;",
        "- careful about anti-hallucination: tell the agent to report only what",
        "  it can verify from real data and to say so when data is missing;",
        "- parameterized with {placeholders} for anything account/region/time",
        "  specific, so the same skill is reusable across customers.",
        "",
        "For EVERY {placeholder} you put in the prompt, declare a matching entry",
        "in parameters[] with a sensible default where one exists (e.g.",
        "region=us-east-1, lookback_days=14). Mark a parameter required ONLY when",
        "there is genuinely no safe default (e.g. account_id). Never give a param",
        "both a default and required=true.",
        "",
        "Respond with ONLY a JSON object, no prose, no code fence:",
        "{",
        '  "suggested_skill_id": "<lowercase-kebab-case-id>",',
        '  "name": "<short human name>",',
        '  "description": "<one sentence on what this skill investigates>",',
        '  "prompt": "<the full templated investigation prompt with {placeholders}>",',
        '  "parameters": [',
        '    {"name": "region", "default": "us-east-1", "description": "..."},',
        '    {"name": "account_id", "required": true, "description": "..."}',
        "  ],",
        '  "tags": ["cost", "ec2"]',
        "}",
    ]
    # The prompt body + description are shown to / saved for the admin, so steer
    # their language. JSON keys and {placeholders} stay ASCII regardless.
    if locale == "zh":
        lines.append('Write "name", "description", and the prose inside "prompt" '
                     "in Simplified Chinese. Keep JSON keys and "
                     "{placeholder} names in ASCII.")
    else:
        lines.append('Write "name", "description", and "prompt" in English.')
    return "\n".join(lines)


# ── 2. lint: static quality gate (pure, no Bedrock) ──────────────────────────

def lint(draft: dict) -> list[dict]:
    """Return a list of findings about a draft (or any skill payload).

    Each finding: {code, level, message_key, message_args, param?}.
    level == "error" should block save; "warn" is advisory. This catches the
    structural mistakes an LLM commonly makes — a {placeholder} with no declared
    parameter (renders literally at run time), or a declared parameter that the
    prompt never uses (dead input the admin would be asked to fill for nothing).
    """
    findings: list[dict] = []
    prompt = (draft.get("prompt") or "")
    placeholders = set(_PLACEHOLDER_RE.findall(prompt))
    params = draft.get("parameters") or []
    param_names = {(p.get("name") or "").strip()
                   for p in params if (p.get("name") or "").strip()}

    if len((prompt or "").strip()) < _MIN_PROMPT_LEN:
        findings.append(_finding("prompt_too_short", "error",
                                 min=_MIN_PROMPT_LEN))

    if not (draft.get("name") or "").strip():
        findings.append(_finding("missing_name", "warn"))

    sid = (draft.get("suggested_skill_id") or draft.get("skill_id") or "").strip()
    if sid and not _ID_RE.match(sid):
        findings.append(_finding("bad_skill_id", "error", skill_id=sid))

    # {placeholder} present but no declared param → renders literally at run time.
    for ph in sorted(placeholders - param_names):
        findings.append(_finding("placeholder_without_param", "error",
                                 param=ph, name=ph))

    # Declared param the prompt never references → dead input.
    for name in sorted(param_names - placeholders):
        findings.append(_finding("param_without_placeholder", "warn",
                                 param=name, name=name))

    # Internal inconsistency: required AND has a default.
    for p in params:
        name = (p.get("name") or "").strip()
        if name and p.get("required") and "default" in p \
                and str(p.get("default")).strip() != "":
            findings.append(_finding("required_with_default", "warn",
                                     param=name, name=name))

    # A skill with no placeholders at all isn't reusable across customers.
    if not placeholders:
        findings.append(_finding("no_placeholders", "warn"))

    # Prompt-safety: block prompts that try to override the agent, exfiltrate
    # secrets, or trigger destructive actions (the prompt runs with the
    # investigation agent's access).
    for hit in _scan_prompt_safety(prompt):
        findings.append(_finding("unsafe_prompt", "error", match=hit))

    return findings


def _finding(code: str, level: str, *, param: str | None = None, **args) -> dict:
    f = {"code": code, "level": level,
         "message_key": _LINT_KEYS[code], "message_args": args}
    if param is not None:
        f["param"] = param
    return f


def has_blocking_findings(findings: list[dict]) -> bool:
    """True if any finding is an error (save must be blocked until fixed)."""
    return any(f.get("level") == "error" for f in findings or [])


# ── 3. propose_semver: LLM-classified update magnitude ────────────────────────

def propose_semver(current_version: str, old_prompt: str, new_prompt: str, *,
                   locale: str = "en") -> dict:
    """Classify an update's magnitude and compute the next version.

    Returns {bump_level, next_version, reason}. Fail-safe: any error / unusable
    answer → a **patch** bump (smallest, safest assumption — never silently
    inflates the version). bump_level ∈ {patch, minor, major}.
    """
    cur = current_version if _is_semver(current_version) else "1.0.0"
    fallback = {"bump_level": "patch", "next_version": _bump(cur, "patch"),
                "reason": ""}
    if (old_prompt or "") == (new_prompt or ""):
        # Identical text — nothing changed; still return a patch (caller decides).
        return fallback

    user = (f"CURRENT VERSION: {cur}\n\n--- OLD PROMPT ---\n{old_prompt or ''}\n\n"
            f"--- NEW PROMPT ---\n{new_prompt or ''}")
    raw = _ask_bedrock(_semver_system_prompt(locale), user)
    if not isinstance(raw, dict):
        return fallback
    level = str(raw.get("bump_level") or "").strip().lower()
    if level not in ("patch", "minor", "major"):
        return fallback
    return {"bump_level": level, "next_version": _bump(cur, level),
            "reason": (raw.get("reason") or "").strip()}


def _semver_system_prompt(locale: str) -> str:
    lines = [
        "You assign a semantic-version bump to an update of a DevOps skill",
        "prompt. Compare the OLD and NEW prompt and pick exactly one level:",
        "- patch: wording / typo / clarification; behavior effectively unchanged.",
        "- minor: new capability or checks added, but backward compatible (old",
        "  invocations still make sense; no parameter removed or repurposed).",
        "- major: backward-incompatible — a parameter removed/renamed/repurposed,",
        "  or the skill's scope/output changed enough to break prior expectations.",
        "",
        "Respond with ONLY a JSON object, no prose, no code fence:",
        '{ "bump_level": "patch|minor|major", "reason": "<one short sentence>" }',
    ]
    if locale == "zh":
        lines.append('Write "reason" in Simplified Chinese.')
    else:
        lines.append('Write "reason" in English.')
    return "\n".join(lines)


# ── 4. describe_draft: confirm-card data (i18n keys only) ─────────────────────

def describe_draft(draft: dict, findings: list[dict], *, locale: str = "en",
                   mode: str = "create", current_version: str | None = None,
                   next_version: str | None = None) -> dict:
    """Platform-agnostic confirm-card data for the two-step authoring flow.

    Returns:
      {
        banner: {text_key, text_args},          # 🤖 expanded "<goal>" into <name>
        params: [{name, default, required, description}],   # for a table
        params_empty_key: str,                  # shown when params is empty
        lint: [{level, message_key, message_args}],         # warnings to show
        lint_header_key: str | "",
        version: {text_key, text_args},         # v1.0.0 (create) | bump line
        buttons: [{action_id, text_key, value}],# save / edit / cancel
        blocked: bool,                          # True → disable save (errors)
      }
    """
    name = draft.get("name") or draft.get("suggested_skill_id") or ""
    banner = {"text_key": I18N_DRAFT_BANNER,
              "text_args": {"goal": (draft.get("source_goal") or "")[:120],
                            "name": name}}

    params = []
    for p in draft.get("parameters") or []:
        params.append({
            "name": p.get("name", ""),
            "default": p.get("default", ""),
            "required": bool(p.get("required")),
            "description": p.get("description", ""),
        })

    if mode == "create":
        version = {"text_key": I18N_VERSION_NEW,
                   "text_args": {"version": next_version or "1.0.0"}}
    else:
        version = {"text_key": I18N_VERSION_BUMP,
                   "text_args": {"current": current_version or "",
                                 "next": next_version or "",
                                 "level": _level_from_versions(current_version,
                                                               next_version)}}

    lint_view = [{"level": f["level"], "message_key": f["message_key"],
                  "message_args": f.get("message_args", {})}
                 for f in (findings or [])]

    blocked = has_blocking_findings(findings)
    sid = draft.get("suggested_skill_id") or draft.get("skill_id") or ""
    buttons = [
        {"action_id": ACTION_SAVE_SKILL, "text_key": I18N_BTN_SAVE, "value": sid},
        {"action_id": ACTION_EDIT_SKILL, "text_key": I18N_BTN_EDIT, "value": sid},
        {"action_id": ACTION_CANCEL_SKILL, "text_key": I18N_BTN_CANCEL, "value": sid},
    ]
    return {
        "banner": banner,
        "params": params,
        "params_empty_key": I18N_DRAFT_NO_PARAMS,
        "lint": lint_view,
        "lint_header_key": I18N_LINT_HEADER if lint_view else "",
        "version": version,
        "buttons": buttons,
        "blocked": blocked,
    }


# ── 5. merge_admin_edits: fold ✏️ edit overrides back in ──────────────────────

_EDITABLE = ("name", "description", "prompt", "suggested_skill_id")


def merge_admin_edits(draft: dict, edits: dict) -> dict:
    """Return a NEW draft with admin-supplied field overrides applied. Blank /
    missing edits leave the original value untouched. `tags` accepts a
    comma/space-separated string. Parameters are not edited here (they're
    regenerated from the prompt's placeholders by a re-lint at save time)."""
    out = dict(draft)
    for field in _EDITABLE:
        val = (edits or {}).get(field)
        if val is not None and str(val).strip() != "":
            out[field] = str(val).strip()
    if (edits or {}).get("tags"):
        out["tags"] = [t for t in re.split(r"[,\s]+", str(edits["tags"]).strip())
                       if t][:8]
    return out


# ── Bedrock call (mirrors skill_dispatcher._ask_bedrock) ──────────────────────

def _ask_bedrock(system_prompt: str, user_text: str) -> dict | None:
    """One `bot_llm` call (Converse), loose-JSON parse.
    Returns the parsed dict or None on any failure. Never raises."""
    try:
        text = bot_llm.invoke_bot_text(
            system_prompt, user_text or "",
            max_tokens=4096,   # 1500 truncated the draft JSON mid-output
        )
        logger.info("llm_audit: caller=skill_author model=%s in_len=%d out_len=%d",
                    bot_llm.get_bot_model_id(), len(user_text or ""), len(text))
        if not text:
            return None
        return _loose_load_json(text)
    except Exception as e:  # noqa: BLE001 — authoring must never crash the handler
        logger.warning("skill_author: Bedrock call failed (%s)", e)
        return None


def _loose_load_json(text: str) -> dict | None:
    """Tolerant JSON extraction (same spirit as skill_dispatcher): strip code
    fences, then fall back to the first {...} span."""
    t = (text or "").strip()
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


# ── semver helpers ────────────────────────────────────────────────────────────

def _is_semver(v) -> bool:
    return bool(v) and bool(re.match(r"^\d+\.\d+\.\d+$", str(v)))


def _bump(version: str, level: str) -> str:
    major, minor, patch = (int(x) for x in version.split("."))
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def _level_from_versions(cur: str | None, nxt: str | None) -> str:
    """Recover the bump level from two version strings (for the card label)."""
    if not (_is_semver(cur) and _is_semver(nxt)):
        return "patch"
    cM, cm, cp = (int(x) for x in cur.split("."))
    nM, nm, np_ = (int(x) for x in nxt.split("."))
    if nM > cM:
        return "major"
    if nm > cm:
        return "minor"
    return "patch"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
