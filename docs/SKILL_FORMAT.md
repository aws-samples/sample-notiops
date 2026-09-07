# Skill format (S3 layout) — drop-in 3rd-party skills

> 🗑️ **Status (2026-09-06): the IM entry points described here are gone.** The
> skill feature was retired from the IM side entirely — `/skills` and every
> `/skills <sub>` command, both `app/skill_commands.py` files and
> `core/skill_authoring.py` are deleted; typing `/skills` now returns the `/help`
> menu at 0 tokens. **Skills live on in full in the web console** (upload, list,
> version, run), and this on-disk/S3 layout is still exactly what the web side
> reads — so the format sections below remain authoritative. Only the `/skills …`
> command examples are dead; read them as "the equivalent action in the web
> console". The auto-dispatch machinery (`core/skill_dispatcher.py`,
> `core/skill_registry.py`) still exists but only on the **undeployed** Fargate
> message path, and goes away with it.

A skill is **just files in S3**. The reader picks them up at runtime — no code
change, no redeploy. Drop a correctly-formatted skill into the bucket and it is
**immediately** usable: it shows up in the web console's Skills list and can be
run from there.

Bucket: the value of the `SKILLS_BUCKET` env var. This is the deploy-generated
data bucket, whose name includes your AWS account ID and region so it is globally
unique, e.g. `notiops-data-<ACCOUNT_ID>-<REGION>`. Do not hardcode a fixed bucket
name — a predictable name can be pre-registered by someone else (S3 bucket
squatting). The deployment (CDK) creates and injects this value for you.

## Layout

```
s3://<SKILLS_BUCKET>/skills/<skill-id>/
├── meta.json                      # required — the skill's metadata
└── versions/
    ├── 1.0.0.md                   # required — prompt body for v1.0.0
    └── 1.1.0.md                   # one .md per version listed in meta.json
```

- `<skill-id>` MUST be lowercase kebab-case, 2–64 chars (e.g. `ecs-perf-review`).
- The file for `meta.json.latest_version` MUST exist under `versions/`.

## `meta.json` schema

```json
{
  "skill_id": "ecs-perf-review",          // REQUIRED, must equal the folder name
  "name": "ECS Performance Review",       // shown in list/cards
  "description": "Analyze ECS cluster ...", // REQUIRED for good NL matching — describe WHEN to use it
  "parameters": [                          // declared {placeholders} the prompt uses
    {"name": "cluster",    "required": true,  "description": "ECS cluster name"},
    {"name": "region",     "default": "us-east-1", "description": "AWS region"},
    {"name": "lookback_days", "default": "14", "description": "Window in days"}
  ],
  "tags": ["ecs", "performance"],          // optional — boosts NL matching
  "latest_version": "1.0.0",               // REQUIRED — which versions/<v>.md is current
  "status": "active",                      // "active" (discoverable) or "archived" (hidden, still runnable)
  "author": "thirdparty",
  "created_at": "2026-06-02T00:00:00Z",
  "updated_at": "2026-06-02T00:00:00Z",
  "versions": [                            // history; each needs a matching versions/<version>.md
    {"version": "1.0.0", "changelog": "initial", "created_at": "2026-06-02T00:00:00Z"}
  ]
}
```

**Minimum to be usable**: `skill_id`, `description`, `latest_version`, `status:"active"`,
and the matching `versions/<latest_version>.md`. Everything else is optional but
improves NL matching (`name`, `description`, `tags`) and parameter handling.

## Version file (`versions/<v>.md`)

Plain markdown — the investigation prompt. Use `{placeholder}` for anything
account/region/time-specific, and declare each one in `parameters[]`:

```markdown
Analyze ECS cluster {cluster} in {region} over the last {lookback_days} days.
Report CPU/memory utilization, task health, and scaling events. Use only real
CloudWatch/ECS data — do not invent metrics. Output: a short summary + a table.
```

Rules:
- Every `{placeholder}` SHOULD have a matching `parameters[]` entry. A parameter
  with a `default` is auto-filled; one marked `required` with no default is
  asked of the user before dispatch. An undeclared `{placeholder}` is left
  literally in the prompt (bad) — declare it.
- Prompt must be ≥ 20 characters.

## Robustness

`list_skills` skips a malformed `meta.json` with a logged warning rather than
failing the whole list — so one bad 3rd-party skill won't break the list or hide
the others. Check the logs for `list_skills: skipping malformed meta ...` if a
dropped-in skill doesn't appear.

## Quick validation after dropping a skill in

In the **web console → Skills** (the IM `/skills …` commands these steps used to
name were retired on 2026-09-06 — see the banner at the top):

1. The list → your skill appears with its `latest_version`.
2. Open it → name, description, parameters look right.
3. Run it with the parameters filled in → the report comes back and is
   downloadable.
