"""
Skill registry — CRUD + version management for DevOps Agent skills.

A "skill" is a versioned prompt template stored in S3. The bot reads a
skill's prompt and feeds it into `webhook_dispatch.dispatch()` — DevOps
Agent runs it like any other investigation. The bot owns the full
lifecycle (create / version / list / run-specific-version / rollback);
DevOps Agent is just the execution engine.

S3-only by design — no new DynamoDB table, no new infrastructure beyond
one S3 prefix on the existing report bucket. Mirrors the prompt-versioning
pattern proven in the merged/ reference solution.

S3 layout (bucket = SKILLS_BUCKET, prefix = skills/):
  skills/<skill_id>/meta.json            index: name, desc, latest, versions[], params
  skills/<skill_id>/versions/<ver>.md    the prompt text for that version

This module is PURELY ADDITIVE. Nothing in the existing bot imports it,
so adding it changes no existing behaviour.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

BUCKET = os.environ.get("SKILLS_BUCKET", "")
PREFIX = "skills"

_s3 = boto3.client("s3")

# ── list_skills catalogue cache ──────────────────────────────────────────────
# The dispatcher calls list_skills on every @mention (hot path) and /skills list
# uses it too — each call is an S3 LIST + one GetObject per skill. A short TTL
# cache cuts that to one refresh per window. Invalidated on every write via
# _write_meta() + delete/rename, so a just-created/updated skill shows at once.
_CACHE_TTL = int(os.environ.get("SKILL_CACHE_TTL", "60"))
_list_cache: dict[str, tuple[float, list[dict]]] = {}


def _invalidate_cache() -> None:
    _list_cache.clear()


def _write_audit(action: str, skill_id: str, *, actor: str = "",
                 version: str = "", detail: str = "") -> None:
    """Append-only audit record — one immutable S3 object per mutating action,
    under skills/_audit/. Best-effort: logs on failure but never raises, so an
    audit hiccup can't block the operation. (Read via list_audit / S3 / Athena.)"""
    try:
        ts = _now()
        rec = {"ts": ts, "action": action, "skill_id": skill_id,
               "actor": actor, "version": version, "detail": detail}
        safe_ts = ts.replace(":", "").replace(".", "").replace("+", "")
        key = f"{PREFIX}/_audit/{safe_ts}_{action}_{skill_id}.json"
        _s3.put_object(Bucket=BUCKET, Key=key,
                       Body=json.dumps(rec, ensure_ascii=False).encode("utf-8"),
                       ContentType="application/json")
        logger.info("audit: action=%s skill=%s actor=%s version=%s",
                    action, skill_id, actor, version)
    except Exception as e:  # noqa: BLE001 — audit must not break the operation
        logger.error("audit write failed for %s %s: %s", action, skill_id, e)


def list_audit(skill_id: str | None = None, limit: int = 50) -> list[dict]:
    """Return audit records (newest first), optionally for one skill."""
    if not BUCKET:
        raise SkillError("SKILLS_BUCKET not configured")
    recs: list[dict] = []
    paginator = _s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=f"{PREFIX}/_audit/"):
        for obj in page.get("Contents", []):
            try:
                r = json.loads(_s3.get_object(Bucket=BUCKET, Key=obj["Key"])["Body"].read())
            except Exception:
                continue
            if skill_id and r.get("skill_id") != skill_id:
                continue
            recs.append(r)
    return sorted(recs, key=lambda r: r.get("ts", ""), reverse=True)[:limit]

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,63}$")
_VER_RE = re.compile(r"^\d+\.\d+\.\d+$")


class SkillError(Exception):
    """Raised for any skill operation that cannot be completed."""


# ── S3 key helpers ─────────────────────────────────────────────────────────

def _meta_key(skill_id: str) -> str:
    return f"{PREFIX}/{skill_id}/meta.json"


def _ver_key(skill_id: str, version: str) -> str:
    return f"{PREFIX}/{skill_id}/versions/{version}.md"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bump_patch(version: str) -> str:
    major, minor, patch = version.split(".")
    return f"{major}.{minor}.{int(patch) + 1}"


def _bump_version(version: str, level: str = "patch") -> str:
    """Bump semver by level: major (X+1.0.0), minor (x.Y+1.0), patch (x.y.Z+1)."""
    major, minor, patch = (int(p) for p in version.split("."))
    if level == "major":
        return f"{major + 1}.0.0"
    if level == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


# ── meta read/write ─────────────────────────────────────────────────────────

def _read_meta(skill_id: str) -> dict | None:
    try:
        obj = _s3.get_object(Bucket=BUCKET, Key=_meta_key(skill_id))
        return json.loads(obj["Body"].read())
    except ClientError as e:
        if e.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise


def _write_meta(meta: dict) -> None:
    _s3.put_object(
        Bucket=BUCKET, Key=_meta_key(meta["skill_id"]),
        Body=json.dumps(meta, indent=2, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json",
    )
    _invalidate_cache()


def _read_prompt(skill_id: str, version: str) -> str:
    obj = _s3.get_object(Bucket=BUCKET, Key=_ver_key(skill_id, version))
    return obj["Body"].read().decode("utf-8")


# ── public API ──────────────────────────────────────────────────────────────

def list_skills(status: str = "active") -> list[dict]:
    """Return compact meta for every skill (optionally filtered by status).
    Each entry: {skill_id, name, description, latest_version, status,
    version_count, updated_at}."""
    if not BUCKET:
        raise SkillError("SKILLS_BUCKET not configured")
    cached = _list_cache.get(status)
    if cached and (time.time() - cached[0]) < _CACHE_TTL:
        return cached[1]
    out: list[dict] = []
    paginator = _s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=f"{PREFIX}/"):
        for obj in page.get("Contents", []):
            if not obj["Key"].endswith("/meta.json"):
                continue
            try:
                meta = json.loads(_s3.get_object(Bucket=BUCKET, Key=obj["Key"])["Body"].read())
                if status and status != "all" and meta.get("status") != status:
                    continue
                if not meta.get("skill_id"):
                    raise SkillError("meta.json missing skill_id")
                out.append({
                    "skill_id": meta["skill_id"],
                    "name": meta.get("name", ""),
                    "description": meta.get("description", ""),
                    "latest_version": meta.get("latest_version", ""),
                    "status": meta.get("status", "active"),
                    "version_count": len(meta.get("versions", [])),
                    "updated_at": meta.get("updated_at", ""),
                    "run_count": int(meta.get("run_count", 0)),
                    "last_run_at": meta.get("last_run_at", ""),
                })
            except Exception as e:
                # A single malformed 3rd-party meta.json must not break the whole
                # list (or the dispatcher catalogue). Skip it with a warning.
                logger.warning("list_skills: skipping malformed meta %s (%s)",
                               obj["Key"], e)
                continue
    result = sorted(out, key=lambda s: s["skill_id"])
    _list_cache[status] = (time.time(), result)
    return result


def get_skill(skill_id: str, version: str | None = None) -> dict:
    """Return full skill: meta + resolved prompt. version=None → latest."""
    if not BUCKET:
        raise SkillError("SKILLS_BUCKET not configured")
    meta = _read_meta(skill_id)
    if not meta:
        raise SkillError(f"skill not found: {skill_id}")
    ver = version or meta.get("latest_version")
    if version and not any(v["version"] == version for v in meta.get("versions", [])):
        raise SkillError(f"version {version} not found for skill {skill_id}")
    return {**meta, "version": ver, "prompt": _read_prompt(skill_id, ver)}


def create_skill(skill_id: str, *, name: str, description: str, prompt: str,
                 parameters: list[dict] | None = None, author: str = "",
                 tags: list[str] | None = None,
                 created_channel: str = "") -> dict:
    """Create a new skill at version 1.0.0. Fails if skill_id exists."""
    if not BUCKET:
        raise SkillError("SKILLS_BUCKET not configured")
    if not _ID_RE.match(skill_id):
        raise SkillError("skill_id must be lowercase kebab-case, 2-64 chars")
    if _read_meta(skill_id):
        raise SkillError(f"skill already exists: {skill_id}")
    if len(prompt.strip()) < 20:
        raise SkillError("prompt too short (min 20 chars)")

    version = "1.0.0"
    _s3.put_object(Bucket=BUCKET, Key=_ver_key(skill_id, version),
                   Body=prompt.encode("utf-8"), ContentType="text/markdown")
    meta = {
        "skill_id": skill_id,
        "name": name or skill_id,
        "description": description,
        "parameters": parameters or [],
        "tags": tags or [],
        "latest_version": version,
        "status": "active",
        "author": author,
        "created_channel": created_channel,
        "created_at": _now(),
        "updated_at": _now(),
        "versions": [{
            "version": version,
            "changelog": "initial version",
            "bump_level": "initial",
            "prompt_hash": hashlib.sha256(prompt.encode()).hexdigest()[:12],
            "created_at": _now(),
            "created_by": author,
        }],
    }
    _write_meta(meta)
    _write_audit("create", skill_id, actor=author, version=version)
    logger.info("Created skill %s v%s (tags=%s, channel=%s)",
                skill_id, version, tags or [], created_channel)
    return meta


def update_skill(skill_id: str, *, prompt: str, changelog: str = "",
                 author: str = "", bump_level: str = "patch",
                 parameters: list[dict] | None = None,
                 updated_channel: str = "") -> dict:
    """Save a new version and point latest at it.

    bump_level (model-chosen) controls the semver bump: major/minor/patch
    (default patch). When `parameters` is provided it replaces the declared
    parameter schema. Records updated_by/updated_channel for audit."""
    if not BUCKET:
        raise SkillError("SKILLS_BUCKET not configured")
    meta = _read_meta(skill_id)
    if not meta:
        raise SkillError(f"skill not found: {skill_id}")
    if len(prompt.strip()) < 20:
        raise SkillError("prompt too short (min 20 chars)")

    new_version = _bump_version(meta["latest_version"], bump_level)
    _s3.put_object(Bucket=BUCKET, Key=_ver_key(skill_id, new_version),
                   Body=prompt.encode("utf-8"), ContentType="text/markdown")
    meta["versions"].append({
        "version": new_version,
        "changelog": changelog or "updated",
        "bump_level": bump_level,
        "prompt_hash": hashlib.sha256(prompt.encode()).hexdigest()[:12],
        "created_at": _now(),
        "created_by": author,
    })
    if parameters is not None:
        meta["parameters"] = parameters
    meta["latest_version"] = new_version
    meta["updated_by"] = author
    meta["updated_channel"] = updated_channel
    meta["updated_at"] = _now()
    _write_meta(meta)
    _write_audit("update", skill_id, actor=author, version=new_version,
                 detail=bump_level)
    logger.info("Updated skill %s → v%s (%s bump)", skill_id, new_version, bump_level)
    return meta


def rollback_skill(skill_id: str, version: str, *, actor: str = "") -> dict:
    """Point latest at an existing earlier version (no new version made)."""
    meta = _read_meta(skill_id)
    if not meta:
        raise SkillError(f"skill not found: {skill_id}")
    if not any(v["version"] == version for v in meta.get("versions", [])):
        raise SkillError(f"version {version} not found for skill {skill_id}")
    meta["latest_version"] = version
    meta["updated_at"] = _now()
    _write_meta(meta)
    _write_audit("rollback", skill_id, actor=actor, version=version)
    logger.info("Rolled back skill %s → v%s", skill_id, version)
    return meta


def archive_skill(skill_id: str, *, actor: str = "") -> dict:
    """Soft-delete: status=archived. Hidden from default list, still runnable."""
    meta = _read_meta(skill_id)
    if not meta:
        raise SkillError(f"skill not found: {skill_id}")
    meta["status"] = "archived"
    meta["updated_at"] = _now()
    _write_meta(meta)
    _write_audit("archive", skill_id, actor=actor)
    return meta


def get_versions(skill_id: str) -> list[dict]:
    """Return version history, newest first."""
    meta = _read_meta(skill_id)
    if not meta:
        raise SkillError(f"skill not found: {skill_id}")
    return list(reversed(meta.get("versions", [])))


def render_prompt(skill_id: str, version: str | None = None,
                  params: dict | None = None) -> tuple[str, str]:
    """Resolve a skill's prompt with {param} substitution.
    Returns (rendered_prompt, resolved_version).

    Substitution rules:
      1. Every key in `params` replaces `{key}` in the prompt verbatim.
      2. Declared parameters in meta with a `default` are filled in when
         the caller didn't pass them.
    Unmatched `{placeholders}` are left untouched (caller can decide
    whether that's an error)."""
    skill = get_skill(skill_id, version)
    prompt = skill["prompt"]
    effective = dict(params or {})
    # Fill defaults for declared parameters the caller didn't provide.
    for p in skill.get("parameters", []):
        key = p["name"]
        if key not in effective and "default" in p:
            effective[key] = p["default"]
    # Substitute any {key} in the prompt with its provided value.
    for key, value in effective.items():
        prompt = prompt.replace(f"{{{key}}}", str(value))
    return prompt, skill["version"]


# ── maintenance ops (P2: lifecycle completeness) ─────────────────────────────

def unarchive_skill(skill_id: str, *, actor: str = "") -> dict:
    """Reactivate an archived skill (status → active)."""
    meta = _read_meta(skill_id)
    if not meta:
        raise SkillError(f"skill not found: {skill_id}")
    meta["status"] = "active"
    meta["updated_at"] = _now()
    _write_meta(meta)
    _write_audit("unarchive", skill_id, actor=actor)
    logger.info("Unarchived skill %s", skill_id)
    return meta


def _all_keys(skill_id: str) -> list[str]:
    """Every S3 key under skills/<id>/ (meta + all version files)."""
    keys: list[str] = []
    paginator = _s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=BUCKET, Prefix=f"{PREFIX}/{skill_id}/"):
        keys.extend(o["Key"] for o in page.get("Contents", []))
    return keys


def delete_skill(skill_id: str, *, actor: str = "", audit: bool = True) -> None:
    """Hard-delete a skill: remove meta + every version object from S3.
    Irreversible — prefer archive_skill for anything but test/junk skills."""
    if not _read_meta(skill_id):
        raise SkillError(f"skill not found: {skill_id}")
    if audit:                                  # record BEFORE the data is gone
        _write_audit("delete", skill_id, actor=actor)
    keys = _all_keys(skill_id)
    if keys:
        _s3.delete_objects(
            Bucket=BUCKET,
            Delete={"Objects": [{"Key": k} for k in keys], "Quiet": True})
    _invalidate_cache()
    logger.info("Deleted skill %s (%d objects)", skill_id, len(keys))


def rename_skill(old_id: str, new_id: str, *, actor: str = "") -> dict:
    """Rename a skill (its S3 prefix). Copies meta + all versions to the new id,
    updates meta.skill_id, then deletes the old prefix."""
    if not _ID_RE.match(new_id):
        raise SkillError("new skill_id must be lowercase kebab-case, 2-64 chars")
    meta = _read_meta(old_id)
    if not meta:
        raise SkillError(f"skill not found: {old_id}")
    if _read_meta(new_id):
        raise SkillError(f"skill already exists: {new_id}")
    # Copy every version file to the new prefix.
    for v in meta.get("versions", []):
        ver = v["version"]
        _s3.copy_object(
            Bucket=BUCKET, Key=_ver_key(new_id, ver),
            CopySource={"Bucket": BUCKET, "Key": _ver_key(old_id, ver)})
    meta["skill_id"] = new_id
    meta["updated_at"] = _now()
    _write_meta(meta)                       # writes new meta + invalidates cache
    delete_skill(old_id, actor=actor, audit=False)   # remove old prefix (no dup audit)
    _write_audit("rename", new_id, actor=actor, detail=f"from {old_id}")
    logger.info("Renamed skill %s → %s", old_id, new_id)
    return meta


def set_metadata(skill_id: str, *, name: str | None = None,
                 description: str | None = None,
                 tags: list[str] | None = None, actor: str = "") -> dict:
    """Patch a skill's metadata (name / description / tags) WITHOUT cutting a
    new version — the prompt is unchanged. Only provided fields are updated."""
    meta = _read_meta(skill_id)
    if not meta:
        raise SkillError(f"skill not found: {skill_id}")
    if name is not None:
        meta["name"] = name
    if description is not None:
        meta["description"] = description
    if tags is not None:
        meta["tags"] = tags
    meta["updated_at"] = _now()
    _write_meta(meta)
    _write_audit("meta", skill_id, actor=actor)
    logger.info("Updated metadata for skill %s", skill_id)
    return meta


def diff_versions(skill_id: str, v1: str, v2: str) -> tuple[str, str]:
    """Return (prompt_v1, prompt_v2) so the caller can show what changed
    between two versions. Raises if either version doesn't exist."""
    meta = _read_meta(skill_id)
    if not meta:
        raise SkillError(f"skill not found: {skill_id}")
    known = {v["version"] for v in meta.get("versions", [])}
    for v in (v1, v2):
        if v not in known:
            raise SkillError(f"version {v} not found for skill {skill_id}")
    return _read_prompt(skill_id, v1), _read_prompt(skill_id, v2)


def record_run(skill_id: str) -> None:
    """Best-effort usage counter: bump run_count + last_run_at. Never raises —
    a counter failure must not break a dispatch. Powers stale-skill detection."""
    try:
        meta = _read_meta(skill_id)
        if not meta:
            return
        meta["run_count"] = int(meta.get("run_count", 0)) + 1
        meta["last_run_at"] = _now()
        _write_meta(meta)
    except Exception as e:  # noqa: BLE001 — usage tracking is non-critical
        logger.warning("record_run(%s) failed: %s", skill_id, e)


def stale_skills(days: int = 30) -> list[dict]:
    """Active skills that are never-run or whose last run is older than `days`.
    Powers /skills stale for pruning. Entries carry run_count + last_run_at."""
    from datetime import timedelta
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    out = []
    for s in list_skills(status="active"):
        last = s.get("last_run_at", "")
        if not s.get("run_count"):
            out.append(s)
            continue
        try:
            if datetime.fromisoformat(last) < cutoff:
                out.append(s)
        except (ValueError, TypeError):
            out.append(s)
    return out
