"""
`/skills ...` command router — keyword short-circuit for skill lifecycle.

Mirrors the `_maybe_handle_language_command` pattern: runs BEFORE the
Bedrock intent classifier, so it never touches existing investigate/case
classification. If the message isn't a `/skills` command, returns False
and the normal flow continues unchanged.

All user-facing strings go through `core.i18n.t(key, locale)` to satisfy
the repo's no-CJK-literal rule.

Grammar (one message each):
  /skills list
  /skills get <id> [version]
  /skills history <id>
  /skills run <id> [version] [k=v ...]
  /skills rollback <id> <version>
  /skills archive <id>
  /skills create <id> <name...>
  <prompt body on the following lines>
"""
from __future__ import annotations

import json
import logging
import os
import re

from core import (ddb_state, i18n, skill_authoring, skill_registry,
                  webhook_dispatch)
from core.skill_registry import SkillError
from platforms.slack.app import blocks  # Dockerfile preserves tree, PYTHONPATH=/app

logger = logging.getLogger(__name__)

PLATFORM = "slack"
_SKILLS_RE = re.compile(r"^\s*/?skills\b\s*(?P<rest>.*)$", re.IGNORECASE | re.DOTALL)

# Natural-language "list my skills" / "show skills" / "what skills do you have"
# / CJK "列出技能 / 有哪些 skill". Routes to the read-only `list` subcommand so
# users don't have to type the literal `/skills list`. CJK as \u escapes to
# satisfy the no-CJK-literal lint. Must contain skill(s)/技能 to avoid matching
# generic "list my EC2".
_NL_SKILL_LIST_RE = re.compile(
    r"(?:list|show|view|see|display|what|which|available|my|all)\b[^\n]{0,30}"
    r"\bskills?\b"
    r"|\bskills?\b[^\n]{0,20}\b(?:list|available|registered|catalog|catalogue)\b"
    r"|(?:\u5217\u51fa|\u67e5\u770b|\u663e\u793a|\u6709\u54ea\u4e9b|\u6211\u7684)"
    r"[^\n]{0,8}(?:skills?|\u6280\u80fd)",
    re.IGNORECASE,
)

# Admin allowlist for definition-mutating subcommands. UNSET/empty = open
# (backward-compatible); set SKILLS_ADMINS=user1,user2 to lock down.
_SKILLS_ADMINS = {a.strip() for a in os.environ.get("SKILLS_ADMINS", "").split(",")
                  if a.strip()}
_MUTATING = {"create", "update", "archive", "unarchive", "delete", "rename",
             "meta", "rollback", "audit"}


def _is_admin(user_id: str) -> bool:
    return not _SKILLS_ADMINS or user_id in _SKILLS_ADMINS


def maybe_handle_skill_command(client, *, channel_id: str, thread_ts: str | None,
                               event_ts: str, user_id: str,
                               raw_text: str, locale: str = "en") -> bool:
    """Return True if `raw_text` was a `/skills` command (and handle it)."""
    m = _SKILLS_RE.match(raw_text or "")
    if m:
        rest = (m.group("rest") or "").strip()
    elif _NL_SKILL_LIST_RE.search(raw_text or ""):
        rest = "list"          # NL "list my skills" → handle as /skills list
    else:
        return False
    first_line, _, body = rest.partition("\n")
    parts = first_line.split()
    sub = parts[0].lower() if parts else "list"
    args = parts[1:]

    def reply(text: str) -> None:
        client.chat_postMessage(channel=channel_id, thread_ts=thread_ts, text=text)

    if sub in _MUTATING and not _is_admin(user_id):
        reply(i18n.t("skill.admin.denied", locale))
        return True

    try:
        if sub == "list":
            reply(_fmt_list(skill_registry.list_skills(), locale))
        elif sub == "get" and args:
            reply(_fmt_get(skill_registry.get_skill(
                args[0], args[1] if len(args) > 1 else None), locale))
        elif sub == "history" and args:
            reply(_fmt_history(args[0],
                               skill_registry.get_versions(args[0]), locale))
        elif sub == "rollback" and len(args) >= 2:
            skill_registry.rollback_skill(args[0], args[1], actor=user_id)
            reply(i18n.t("skill.rolled_back", locale,
                         skill_id=args[0], version=args[1]))
        elif sub == "archive" and args:
            skill_registry.archive_skill(args[0], actor=user_id)
            reply(i18n.t("skill.archived", locale, skill_id=args[0]))
        elif sub == "create" and args:
            # Never save raw text — always enrich first (LLM → lint → confirm).
            # The whole text is the goal; the skill id comes from the LLM's
            # suggested_skill_id (skill_id="" so a natural-language goal's first
            # word isn't mistaken for the id). User can `rename` afterwards.
            goal = (" ".join(args) + ("\n" + body if body.strip() else "")).strip()
            begin_authoring(client, channel_id=channel_id, thread_ts=thread_ts,
                            event_ts=event_ts, user_id=user_id, locale=locale,
                            mode="create", skill_id="", goal=goal)
        elif sub == "update" and args:
            goal = (" ".join(args[1:]) + ("\n" + body if body.strip() else "")).strip()
            begin_authoring(client, channel_id=channel_id, thread_ts=thread_ts,
                            event_ts=event_ts, user_id=user_id, locale=locale,
                            mode="update", skill_id=args[0], goal=goal)
        elif sub == "unarchive" and args:
            skill_registry.unarchive_skill(args[0], actor=user_id)
            reply(i18n.t("skill.unarchived", locale, skill_id=args[0]))
        elif sub == "delete" and args:
            skill_registry.delete_skill(args[0], actor=user_id)
            reply(i18n.t("skill.deleted", locale, skill_id=args[0]))
        elif sub == "rename" and len(args) >= 2:
            skill_registry.rename_skill(args[0], args[1], actor=user_id)
            reply(i18n.t("skill.renamed", locale, old=args[0], new=args[1]))
        elif sub == "meta" and len(args) >= 3:
            _handle_meta(args, reply, locale, user_id)
        elif sub == "diff" and len(args) >= 3:
            p1, p2 = skill_registry.diff_versions(args[0], args[1], args[2])
            reply(_fmt_diff(args[0], args[1], args[2], p1, p2, locale))
        elif sub == "audit":
            reply(_fmt_audit(skill_registry.list_audit(args[0] if args else None),
                             locale))
        elif sub == "stale":
            days = int(args[0]) if args and args[0].isdigit() else 30
            reply(_fmt_stale(skill_registry.stale_skills(days), days, locale))
        elif sub == "run" and args:
            _run_skill(channel_id, thread_ts, event_ts, user_id, args,
                       reply, locale)
        else:
            reply(i18n.t("skill.usage", locale))
    except SkillError as e:
        reply(i18n.t("skill.error", locale, message=str(e)))
    except Exception:  # noqa: BLE001 — surface to user, don't crash handler
        logger.exception("skill command failed")  # Security: detail → CloudWatch only
        reply(i18n.t("skill.error.unexpected", locale))
    return True


def _handle_meta(args, reply, locale: str, actor: str = "") -> None:
    """`/skills meta <id> <name|desc|tags> <value...>` — patch metadata, no new version."""
    skill_id, field = args[0], args[1].lower()
    value = " ".join(args[2:])
    if field == "name":
        skill_registry.set_metadata(skill_id, name=value, actor=actor)
    elif field in ("desc", "description"):
        skill_registry.set_metadata(skill_id, description=value, actor=actor)
    elif field == "tags":
        tags = [t.strip() for t in re.split(r"[,\s]+", value) if t.strip()]
        skill_registry.set_metadata(skill_id, tags=tags, actor=actor)
    else:
        reply(i18n.t("skill.usage", locale))
        return
    reply(i18n.t("skill.meta_updated", locale, skill_id=skill_id))


def _fmt_audit(records: list[dict], locale: str) -> str:
    if not records:
        return i18n.t("skill.audit.empty", locale)
    lines = [i18n.t("skill.audit.header", locale)]
    for r in records[:30]:
        lines.append(i18n.t("skill.audit.row", locale, ts=r.get("ts", ""),
                            action=r.get("action", ""), skill_id=r.get("skill_id", ""),
                            actor=r.get("actor", "") or "?",
                            version=f"v{r['version']}" if r.get("version") else ""))
    return "\n".join(lines)


def _fmt_stale(skills: list[dict], days: int, locale: str) -> str:
    if not skills:
        return i18n.t("skill.stale.empty", locale)
    lines = [i18n.t("skill.stale.header", locale, days=days)]
    for s in skills:
        lines.append(i18n.t("skill.stale.row", locale, skill_id=s["skill_id"],
                            run_count=s.get("run_count", 0),
                            last_run_at=s.get("last_run_at") or "never"))
    return "\n".join(lines)


def _fmt_diff(skill_id: str, v1: str, v2: str, p1: str, p2: str,
              locale: str) -> str:
    import difflib
    diff = "\n".join(difflib.unified_diff(
        p1.splitlines(), p2.splitlines(),
        fromfile=f"v{v1}", tofile=f"v{v2}", lineterm=""))
    header = i18n.t("skill.diff.header", locale, skill_id=skill_id, v1=v1, v2=v2)
    return f"{header}\n```\n{diff or '(identical)'}\n```"


def _run_skill(channel_id, thread_ts, event_ts, user_id, args, reply,
               locale: str) -> None:
    """Render skill prompt and dispatch — report routes back via existing flow."""
    skill_id = args[0]
    version = args[1] if len(args) > 1 and re.match(r"^\d+\.\d+\.\d+$", args[1]) else None
    params = dict(kv.split("=", 1) for kv in args[1:] if "=" in kv)

    # Don't dispatch with unfilled required params (would leave {placeholder}
    # literal in the prompt). Report what's missing so the admin can re-run.
    skill = skill_registry.get_skill(skill_id, version)
    missing = [p["name"] for p in skill.get("parameters", [])
               if p.get("required") and "default" not in p and p["name"] not in params]
    if missing:
        reply(i18n.t("skill.run.missing_params", locale,
                     params=", ".join(missing), skill_id=skill_id, first=missing[0]))
        return

    prompt, resolved_ver = skill_registry.render_prompt(skill_id, version, params)
    logger.info("skill run: id=%s version=%s params=%s prompt_len=%d",
                skill_id, resolved_ver, params, len(prompt))

    # BUG-1 fix: strip the "." from the Slack ts. The report-handler recovers
    # incident_id from the journal tag with regex [a-zA-Z0-9_\-]+ (no dot), and
    # the normal investigate path also strips it (main.py: event_ts.replace(".","")).
    # Leaving the dot here produced an unrecoverable incident_id → report
    # generated but never routed back to the thread.
    event_id = f"skill-{skill_id}-{event_ts.replace('.', '')}"
    ddb_state.put_new_event(
        event_id, platform=PLATFORM, chat_id=channel_id,
        root_message_id=thread_ts or event_ts, user_id=user_id,
        raw_text=f"[skill:{skill_id}@{resolved_ver}] {prompt[:200]}",
        locale=locale)

    incident_id = f"{PLATFORM}-{event_id}"
    result = webhook_dispatch.dispatch(
        incident_id=incident_id, user_text=prompt, platform=PLATFORM,
        user_id=user_id, chat_id=channel_id,
        skill_id=skill_id, skill_version=resolved_ver)

    if not result.get("ok"):
        logger.warning("skill dispatch failed: incident_id=%s status=%s",
                       incident_id, result.get("status"))
        reply(i18n.t("skill.run.dispatch_failed", locale,
                     status=result.get("status"),
                     body=(result.get("body") or "")[:300]))
        return
    ddb_state.link_incident(event_id, incident_id, platform=PLATFORM,
                            task_id=result.get("task_id"))
    skill_registry.record_run(skill_id)
    logger.info("skill dispatched: incident_id=%s task_id=%s skill=%s@%s",
                incident_id, result.get("task_id"), skill_id, resolved_ver)
    reply(i18n.t("skill.run.dispatched", locale,
                 skill_id=skill_id, version=resolved_ver))


# ── formatters (compose i18n strings; no literals) ──────────────────────────

def _fmt_list(skills: list[dict], locale: str) -> str:
    if not skills:
        return i18n.t("skill.list.empty", locale)
    lines = [i18n.t("skill.list.header", locale)]
    for s in skills:
        lines.append(i18n.t("skill.list.entry", locale,
                            skill_id=s["skill_id"],
                            version=s["latest_version"],
                            count=s["version_count"],
                            name=s["name"]))
    return "\n".join(lines)


def _fmt_get(skill: dict, locale: str) -> str:
    params_list = ", ".join(p["name"] for p in skill.get("parameters", []))
    params_text = params_list or i18n.t("skill.params.none", locale)
    return i18n.t("skill.detail.body", locale,
                  name=skill["name"],
                  skill_id=skill["skill_id"],
                  version=skill["version"],
                  latest=skill["latest_version"],
                  status=skill["status"],
                  params=params_text,
                  description=skill.get("description", ""),
                  prompt=skill["prompt"][:800])


def _fmt_history(skill_id: str, versions: list[dict], locale: str) -> str:
    lines = [i18n.t("skill.history.header", locale, skill_id=skill_id)]
    for v in versions:
        lines.append(i18n.t("skill.history.entry", locale,
                            version=v["version"],
                            changelog=v.get("changelog", ""),
                            date=v.get("created_at", "")[:10]))
    return "\n".join(lines)


# ── Authoring flow: enrich → draft card → confirm (app-free builders) ─────────
# The ✅/✏️/❌ button handlers live in main.py (it owns `app`), mirroring how the
# dispatcher's on_skill_switch handler lives there. These builders are shared.

def _author_event_id(event_ts: str) -> str:
    return f"skillauthor-{event_ts}".replace(".", "")


def begin_authoring(client, *, channel_id, thread_ts, event_ts, user_id,
                    locale, mode, skill_id, goal):
    """Enrich a goal into a draft, lint it, persist it, and post the confirm
    card. `mode` is "create" or "update". For update we diff against the
    skill's current latest prompt so the LLM can pick the semver bump."""
    def reply(text):
        client.chat_postMessage(channel=channel_id, thread_ts=thread_ts, text=text)

    if mode == "update":
        try:
            current = skill_registry.get_skill(skill_id)
        except SkillError as e:
            reply(i18n.t("skill.error", locale, message=str(e)))
            return
        old_prompt = current.get("prompt", "")
        current_version = current.get("latest_version", "1.0.0")
    else:
        old_prompt, current_version = "", None

    draft = skill_authoring.enrich(goal, locale=locale)
    if not draft:
        reply(i18n.t("skill.author.enrich_failed", locale))
        return
    if skill_id:                      # admin-typed id wins over the LLM's guess
        draft["suggested_skill_id"] = skill_id

    findings = skill_authoring.lint(draft)
    if mode == "update":
        sem = skill_authoring.propose_semver(current_version, old_prompt,
                                             draft["prompt"], locale=locale)
        next_version = sem["next_version"]
    else:
        next_version = "1.0.0"

    card = skill_authoring.describe_draft(
        draft, findings, locale=locale, mode=mode,
        current_version=current_version, next_version=next_version)

    event_id = _author_event_id(event_ts)
    ddb_state.put_new_event(
        event_id, platform=PLATFORM, chat_id=channel_id,
        root_message_id=thread_ts or event_ts, user_id=user_id,
        raw_text=f"[authoring:{mode}:{draft['suggested_skill_id']}]",
        locale=locale)
    _persist_draft(event_id, draft, mode=mode, next_version=next_version,
                   current_version=current_version)
    logger.info("authoring: mode=%s id=%s next=%s blocked=%s",
                mode, draft["suggested_skill_id"], next_version, card["blocked"])

    client.chat_postMessage(
        channel=channel_id, thread_ts=thread_ts,
        text=i18n.t(card["banner"]["text_key"], locale, **card["banner"]["text_args"]),
        blocks=_build_author_card(card, event_id, locale))


def _persist_draft(event_id, draft, *, mode, next_version, current_version):
    ddb_state._table.update_item(
        Key={"lookup_key": f"event#{event_id}"},
        UpdateExpression="SET skill_draft = :d, skill_draft_mode = :m, "
                         "skill_draft_next = :n, skill_draft_current = :c",
        ExpressionAttributeValues={
            ":d": json.dumps(draft, ensure_ascii=False),
            ":m": mode, ":n": next_version or "", ":c": current_version or "",
        },
    )


def _load_draft(event_id):
    convo = ddb_state.get_by_event(event_id) or {}
    raw = convo.get("skill_draft")
    if not raw:
        return None, convo
    try:
        return json.loads(raw), convo
    except Exception:
        return None, convo


def _build_author_card(card, event_id, locale):
    """Render describe_draft() data as Slack blocks. i18n keys → strings here."""
    out = [blocks.section(i18n.t(card["banner"]["text_key"], locale,
                                 **card["banner"]["text_args"]))]
    out.append(blocks.section(i18n.t(card["version"]["text_key"], locale,
                                     **card["version"]["text_args"])))
    if card["params"]:
        rows = [i18n.t(skill_authoring.I18N_DRAFT_PARAMS, locale)]
        for p in card["params"]:
            req = " *" if p["required"] else ""
            dft = f" = `{p['default']}`" if p["default"] else ""
            rows.append(i18n.t(skill_authoring.I18N_DRAFT_PARAM_ROW, locale,
                               name=p["name"], required=req, default=dft,
                               description=p["description"]))
        out.append(blocks.section("\n".join(rows)))
    else:
        out.append(blocks.context(i18n.t(card["params_empty_key"], locale)))
    if card["lint"]:
        lines = [i18n.t(card["lint_header_key"], locale)]
        for f in card["lint"]:
            lines.append(i18n.t(f["message_key"], locale, **f["message_args"]))
        out.append(blocks.section("\n".join(lines)))
    # Save is omitted when blocked (errors) — the admin must ✏️ Edit first.
    val = json.dumps({"event_id": event_id})
    btns = []
    for b in card["buttons"]:
        if b["action_id"] == skill_authoring.ACTION_SAVE_SKILL and card["blocked"]:
            continue
        btns.append(blocks.button(i18n.t(b["text_key"], locale),
                                  b["action_id"], value=val))
    out.append(blocks.actions(*btns, block_id="skill_author_actions"))
    return out


def save_authored_skill(event_id, channel_id, msg_ts, client):
    """✅ Save — re-lint defensively, then create_skill/update_skill with the
    LLM-chosen bump + channel metadata. Called by the main.py button handler."""
    draft, convo = _load_draft(event_id)
    locale = convo.get("locale", "en")
    if not draft:
        client.chat_postMessage(channel=channel_id,
                                text=i18n.t("confirm.expired", locale))
        return
    if skill_authoring.has_blocking_findings(skill_authoring.lint(draft)):
        client.chat_postMessage(channel=channel_id,
                                text=i18n.t("skill.author.blocked", locale))
        return
    sid = draft.get("suggested_skill_id") or draft.get("skill_id", "")
    mode = convo.get("skill_draft_mode", "create")
    user_id = convo.get("user_id", "")
    try:
        if mode == "update":
            level = skill_authoring._level_from_versions(
                convo.get("skill_draft_current"), convo.get("skill_draft_next"))
            meta = skill_registry.update_skill(
                sid, prompt=draft["prompt"], author=user_id, bump_level=level,
                parameters=draft.get("parameters"), updated_channel=channel_id)
        else:
            meta = skill_registry.create_skill(
                sid, name=draft.get("name") or sid,
                description=draft.get("description", ""),
                prompt=draft["prompt"], parameters=draft.get("parameters"),
                author=user_id, tags=draft.get("tags"),
                created_channel=channel_id)
    except SkillError as e:
        client.chat_postMessage(channel=channel_id,
                                text=i18n.t("skill.error", locale, message=str(e)))
        return
    text = i18n.t("skill.created", locale, skill_id=meta["skill_id"],
                  version=meta["latest_version"])
    if msg_ts:
        client.chat_update(channel=channel_id, ts=msg_ts, text=text, blocks=[])
    else:
        client.chat_postMessage(channel=channel_id, text=text)


def apply_authoring_edits(event_id, edits, client):
    """Fold modal edits into the draft, re-lint, re-persist, post refreshed card.
    Called by the main.py edit-modal submit handler."""
    draft, convo = _load_draft(event_id)
    locale = convo.get("locale", "en")
    if not draft:
        logger.warning("authoring edit-submit: draft %s expired/missing", event_id)
        return
    new_draft = skill_authoring.merge_admin_edits(draft, edits)
    findings = skill_authoring.lint(new_draft)
    mode = convo.get("skill_draft_mode", "create")
    next_version = convo.get("skill_draft_next") or "1.0.0"
    current_version = convo.get("skill_draft_current") or None
    card = skill_authoring.describe_draft(
        new_draft, findings, locale=locale, mode=mode,
        current_version=current_version, next_version=next_version)
    _persist_draft(event_id, new_draft, mode=mode, next_version=next_version,
                   current_version=current_version)
    client.chat_postMessage(
        channel=convo.get("chat_id", ""), thread_ts=convo.get("root_message_id", ""),
        text=i18n.t(card["banner"]["text_key"], locale, **card["banner"]["text_args"]),
        blocks=_build_author_card(card, event_id, locale))
