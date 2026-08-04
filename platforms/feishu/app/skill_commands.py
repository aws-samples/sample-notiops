"""
`/skills ...` command router for Feishu — parallel to platforms/slack/skill_commands.py.
All user-facing strings via core.i18n.t() (no CJK literals).
"""
from __future__ import annotations

import json
import logging
import os
import re

from core import (ddb_state, i18n, skill_authoring, skill_registry,
                  webhook_dispatch)
from core.skill_registry import SkillError

# `feishu_utils` lives next to this file in the container — Dockerfile
# Dockerfile preserves tree structure with PYTHONPATH=/app.
from platforms.feishu.app import feishu_utils
from lark_oapi.event.callback.model.p2_card_action_trigger import (
    P2CardActionTriggerResponse,
)

logger = logging.getLogger(__name__)


# Local card-action response builders (mirror case_flow.py — each flow module
# owns its own, so we never `from main import` and accidentally re-import the
# __main__ module + its module-level side effects).
def _toast(text: str) -> P2CardActionTriggerResponse:
    return P2CardActionTriggerResponse({"toast": {"type": "info", "content": text}})


def _build_response(toast: str, new_card: dict) -> P2CardActionTriggerResponse:
    return P2CardActionTriggerResponse({
        "toast": {"type": "info", "content": toast},
        "card": {"type": "raw", "data": new_card},
    })

PLATFORM = "feishu"
_SKILLS_RE = re.compile(r"^\s*/?skills\b\s*(?P<rest>.*)$", re.IGNORECASE | re.DOTALL)

# Admin allowlist for definition-mutating subcommands. UNSET/empty = open
# (backward-compatible); set SKILLS_ADMINS=user1,user2 to lock down.
_SKILLS_ADMINS = {a.strip() for a in os.environ.get("SKILLS_ADMINS", "").split(",")
                  if a.strip()}
_MUTATING = {"create", "update", "archive", "unarchive", "delete", "rename",
             "meta", "rollback", "audit"}


def _is_admin(user_id: str) -> bool:
    return not _SKILLS_ADMINS or user_id in _SKILLS_ADMINS


def maybe_handle_skill_command(msg, *, chat_id: str, user_id: str,
                               event_id: str, raw_text: str,
                               locale: str = "en") -> bool:
    """Return True if `raw_text` was a `/skills` command (and handle it)."""
    m = _SKILLS_RE.match(raw_text or "")
    if not m:
        return False

    rest = (m.group("rest") or "").strip()
    first_line, _, body = rest.partition("\n")
    parts = first_line.split()
    sub = parts[0].lower() if parts else "list"
    args = parts[1:]

    def reply(text: str) -> None:
        feishu_utils.reply_text(msg.message_id, text)

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
            goal = (" ".join(args) + ("\n" + body if body.strip() else "")).strip()
            begin_authoring(msg, chat_id=chat_id, user_id=user_id,
                            event_id=event_id, locale=locale,
                            mode="create", skill_id="", goal=goal)
        elif sub == "update" and args:
            goal = (" ".join(args[1:]) + ("\n" + body if body.strip() else "")).strip()
            begin_authoring(msg, chat_id=chat_id, user_id=user_id,
                            event_id=event_id, locale=locale,
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
            _run_skill(chat_id, user_id, event_id, args, reply, locale)
        else:
            reply(i18n.t("skill.usage", locale))
    except SkillError as e:
        reply(i18n.t("skill.error", locale, message=str(e)))
    except Exception:  # noqa: BLE001 — surface to user, don't crash handler
        logger.exception("skill command failed")  # Security: detail → CloudWatch only
        reply(i18n.t("skill.error.unexpected", locale))
    return True


def _run_skill(chat_id, user_id, event_id, args, reply, locale: str) -> None:
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

    # Match the Slack BUG-1 fix: keep incident_id free of dots so the
    # report-handler recovery regex ([a-zA-Z0-9_\-]+) can read it. Feishu
    # message_id has no dot today, but sanitize defensively for consistency.
    skill_event_id = f"skill-{skill_id}-{event_id}".replace(".", "")
    ddb_state.put_new_event(
        skill_event_id, platform=PLATFORM, chat_id=chat_id,
        root_message_id=event_id, user_id=user_id,
        raw_text=f"[skill:{skill_id}@{resolved_ver}] {prompt[:200]}",
        locale=locale)

    incident_id = f"{PLATFORM}-{skill_event_id}"
    result = webhook_dispatch.dispatch(
        incident_id=incident_id, user_text=prompt, platform=PLATFORM,
        user_id=user_id, chat_id=chat_id,
        skill_id=skill_id, skill_version=resolved_ver)

    if not result.get("ok"):
        logger.warning("skill dispatch failed: incident_id=%s status=%s",
                       incident_id, result.get("status"))
        reply(i18n.t("skill.run.dispatch_failed", locale,
                     status=result.get("status"),
                     body=(result.get("body") or "")[:300]))
        return
    ddb_state.link_incident(skill_event_id, incident_id, platform=PLATFORM,
                            task_id=result.get("task_id"))
    skill_registry.record_run(skill_id)
    logger.info("skill dispatched: incident_id=%s task_id=%s skill=%s@%s",
                incident_id, result.get("task_id"), skill_id, resolved_ver)
    reply(i18n.t("skill.run.dispatched", locale,
                 skill_id=skill_id, version=resolved_ver))


# ── formatters ───────────────────────────────────────────────────────────────

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


# ── Authoring flow: enrich → draft card → confirm ─────────────────────────────
# Same core/skill_authoring.py calls + same describe_draft() data as Slack; only
# the Feishu v2 card JSON + the on_card_action routing differ. The 4 handlers are
# invoked from main.on_card_action (see the main.py wiring) and return a
# P2CardActionTriggerResponse via main._build_response (imported lazily).

ACTION_SAVE = skill_authoring.ACTION_SAVE_SKILL
ACTION_EDIT = skill_authoring.ACTION_EDIT_SKILL
ACTION_CANCEL = skill_authoring.ACTION_CANCEL_SKILL
ACTION_EDIT_SUBMIT = "skill_author_edit_submit"


def _author_event_id(event_id: str) -> str:
    return f"skillauthor-{event_id}".replace(".", "")


def begin_authoring(msg, *, chat_id, user_id, event_id, locale, mode,
                    skill_id, goal):
    """Enrich a goal into a draft, lint it, persist it, send the confirm card."""
    def reply(text):
        feishu_utils.reply_text(msg.message_id, text)

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
    if skill_id:
        draft["suggested_skill_id"] = skill_id

    findings = skill_authoring.lint(draft)
    if mode == "update":
        sem = skill_authoring.propose_semver(current_version, old_prompt,
                                             draft["prompt"], locale=locale)
        next_version = sem["next_version"]
    else:
        next_version = "1.0.0"

    card_data = skill_authoring.describe_draft(
        draft, findings, locale=locale, mode=mode,
        current_version=current_version, next_version=next_version)

    author_event = _author_event_id(event_id)
    ddb_state.put_new_event(
        author_event, platform=PLATFORM, chat_id=chat_id,
        root_message_id=event_id, user_id=user_id,
        raw_text=f"[authoring:{mode}:{draft['suggested_skill_id']}]",
        locale=locale)
    _persist_draft(author_event, draft, mode=mode, next_version=next_version,
                   current_version=current_version)
    logger.info("authoring: mode=%s id=%s next=%s blocked=%s",
                mode, draft["suggested_skill_id"], next_version,
                card_data["blocked"])

    feishu_utils.send_card(chat_id, _build_author_card(card_data, author_event,
                                                       locale), root_id=event_id)


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
    """describe_draft() data → Feishu v2 card. Buttons carry {action, event_id}
    in behaviors:callback so on_card_action routes them (body-level, no form)."""
    body = []
    banner = card["banner"]
    body.append({"tag": "markdown",
                 "content": i18n.t(banner["text_key"], locale, **banner["text_args"])})
    ver = card["version"]
    body.append({"tag": "markdown",
                 "content": i18n.t(ver["text_key"], locale, **ver["text_args"])})
    if card["params"]:
        rows = [i18n.t(skill_authoring.I18N_DRAFT_PARAMS, locale)]
        for p in card["params"]:
            req = " *" if p["required"] else ""
            dft = f" = `{p['default']}`" if p["default"] else ""
            rows.append(i18n.t(skill_authoring.I18N_DRAFT_PARAM_ROW, locale,
                               name=p["name"], required=req, default=dft,
                               description=p["description"]))
        body.append({"tag": "markdown", "content": "\n".join(rows)})
    else:
        body.append({"tag": "markdown",
                     "content": i18n.t(card["params_empty_key"], locale)})
    if card["lint"]:
        lines = [i18n.t(card["lint_header_key"], locale)]
        for f in card["lint"]:
            lines.append(i18n.t(f["message_key"], locale, **f["message_args"]))
        body.append({"tag": "markdown", "content": "\n".join(lines)})
    btn_elems = []
    for b in card["buttons"]:
        if b["action_id"] == ACTION_SAVE and card["blocked"]:
            continue
        btn_elems.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": i18n.t(b["text_key"], locale)},
            "type": "primary" if b["action_id"] == ACTION_SAVE else "default",
            "behaviors": [{"type": "callback",
                           "value": {"action": b["action_id"],
                                     "event_id": event_id}}],
        })
    body.append({"tag": "action", "actions": btn_elems})
    return {"schema": "2.0", "body": {"elements": body}}


def _build_edit_form_card(draft, event_id, locale):
    """✏️ edit step: a v2 FORM card with name/description/prompt/tags inputs +
    submit. Submit fires ACTION_EDIT_SUBMIT; handler folds edits, re-renders."""
    P = skill_authoring.DRAFT_BLOCK_PREFIX
    fields = [
        ("name", draft.get("name", ""), False),
        ("description", draft.get("description", ""), False),
        ("prompt", draft.get("prompt", ""), True),
        ("tags", " ".join(draft.get("tags", [])), False),
    ]
    form_inner = []
    for f, val, multi in fields:
        form_inner.append({
            "tag": "input",
            "name": f"{P}{f}",
            "label": {"tag": "plain_text",
                      "content": i18n.t(f"skill.author.field.{f}", locale)},
            "default_value": val,
            "input_type": "multiline_text" if multi else "text",
            "max_length": 4000 if multi else 1000,
            "required": (f == "prompt"),
        })
    form_inner.append({
        "tag": "button",
        "text": {"tag": "plain_text", "content": i18n.t("skill.author.btn.save", locale)},
        "type": "primary",
        "form_action_type": "submit",
        "behaviors": [{"type": "callback",
                       "value": {"action": ACTION_EDIT_SUBMIT, "event_id": event_id}}],
    })
    return {"schema": "2.0", "body": {"elements": [
        {"tag": "markdown", "content": i18n.t("skill.author.edit_title", locale)},
        {"tag": "form", "name": "skill_author_edit_form", "elements": form_inner},
    ]}}


def handle_author_save(action_value, event, event_id):
    draft, convo = _load_draft(event_id)
    locale = convo.get("locale", "en")
    if not draft:
        return _toast(i18n.t("confirm.expired", locale))
    if skill_authoring.has_blocking_findings(skill_authoring.lint(draft)):
        return _toast(i18n.t("skill.author.blocked", locale))
    sid = draft.get("suggested_skill_id") or draft.get("skill_id", "")
    mode = convo.get("skill_draft_mode", "create")
    user_id = convo.get("user_id", "")
    chat_id = convo.get("chat_id", "")
    try:
        if mode == "update":
            level = skill_authoring._level_from_versions(
                convo.get("skill_draft_current"), convo.get("skill_draft_next"))
            meta = skill_registry.update_skill(
                sid, prompt=draft["prompt"], author=user_id, bump_level=level,
                parameters=draft.get("parameters"), updated_channel=chat_id)
        else:
            meta = skill_registry.create_skill(
                sid, name=draft.get("name") or sid,
                description=draft.get("description", ""),
                prompt=draft["prompt"], parameters=draft.get("parameters"),
                author=user_id, tags=draft.get("tags"), created_channel=chat_id)
    except SkillError as e:
        return _toast(i18n.t("skill.error", locale, message=str(e)))
    text = i18n.t("skill.created", locale, skill_id=meta["skill_id"],
                  version=meta["latest_version"])
    return _build_response(text, {"schema": "2.0", "body": {"elements": [
        {"tag": "markdown", "content": text}]}})


def handle_author_edit(action_value, event, event_id):
    draft, convo = _load_draft(event_id)
    locale = convo.get("locale", "en")
    if not draft:
        return _toast(i18n.t("confirm.expired", locale))
    return _build_response(i18n.t("skill.author.edit_title", locale),
                           _build_edit_form_card(draft, event_id, locale))


def handle_author_edit_submit(action_value, event, event_id):
    draft, convo = _load_draft(event_id)
    locale = convo.get("locale", "en")
    if not draft:
        return _toast(i18n.t("confirm.expired", locale))
    form_value = {}
    try:
        form_value = event.event.action.form_value or {}
    except AttributeError:
        pass
    P = skill_authoring.DRAFT_BLOCK_PREFIX
    edits = {f: (form_value.get(f"{P}{f}") or "")
             for f in ("name", "description", "prompt", "tags")}
    new_draft = skill_authoring.merge_admin_edits(draft, edits)
    findings = skill_authoring.lint(new_draft)
    mode = convo.get("skill_draft_mode", "create")
    next_version = convo.get("skill_draft_next") or "1.0.0"
    current_version = convo.get("skill_draft_current") or None
    card_data = skill_authoring.describe_draft(
        new_draft, findings, locale=locale, mode=mode,
        current_version=current_version, next_version=next_version)
    _persist_draft(event_id, new_draft, mode=mode, next_version=next_version,
                   current_version=current_version)
    return _build_response(
        i18n.t(card_data["banner"]["text_key"], locale,
               **card_data["banner"]["text_args"]),
        _build_author_card(card_data, event_id, locale))


def handle_author_cancel(action_value, event, event_id):
    _, convo = _load_draft(event_id)
    locale = convo.get("locale", "en")
    text = i18n.t("skill.author.cancelled", locale)
    return _build_response(text, {"schema": "2.0", "body": {"elements": [
        {"tag": "markdown", "content": text}]}})
