#!/usr/bin/env python3
"""Seed the LLM model catalogue into DynamoDB (PK=llmcfg / SK=meta).

Called by `setup.sh`. Idempotent: the write is conditional on the item not
existing, so re-running a deploy never overwrites what an administrator has
configured in the console.

When the item already exists the catalogue is **reconciled** (see `_top_up`):
entries this file has and the stored item does not are appended, and entries
both have are brought back in line with this file. Without that step "already
present" -- the normal path on every re-deploy -- silently means *catalogue
changes made after the first deploy never reach the environment*. Both halves
have bitten production:

  * `zai-glm-5` was added on 2026-08-26 and was still missing from the admin
    console (and therefore from the model picker) a day later, which reads as
    "the feature was never built";
  * on 2026-09-03 two models were retired from the web picker
    (`claude-haiku-4-5` disabled, `openai-gpt-5-6-luna` narrowed to `im`) and
    production was still offering both the next day, because the old top-up
    copied stored entries byte-for-byte.

Reconciliation only runs while nobody has edited the catalogue in the console,
and it never drops an alias the stored item has and this file does not.

Why a Python helper instead of `aws dynamodb put-item` in the shell: the
catalogue is nested (a list of maps, with maps inside those), and the CLI's
low-level form needs every value wrapped in its DynamoDB attribute type
(`{"S": ...}` / `{"N": ...}` / `{"L": [...]}`). Hand-rolling that in shell for a
9-entry catalogue is how type bugs get in — a number written as `{"S": "6000"}`
passes the CLI and then silently breaks the reader's `_as_int`. boto3's resource
layer serialises native Python types correctly, and `parse_float=Decimal` keeps
DynamoDB from rejecting floats.

Without this seed every surface runs on its built-in fallback catalogue
(chat still works), but the admin console shows an empty model table and the
first save is hard to complete, because the console can only add models it can
enumerate and connectivity-test. See docs/DEPLOYMENT.md.

Exit codes:
  0  seeded, topped up, or already present (all are success for a deploy script)
  1  the file is missing / invalid, or the write failed for another reason
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from decimal import Decimal

# Documentation-only top-level keys in the JSON. They exist for humans reading
# the file; putting them in DynamoDB would just bloat the item (`_schema` is
# several KB) and they never round-trip through the admin API anyway.
_DOC_KEYS = ("_comment", "_schema")

_PK = "llmcfg"
_SK = "meta"


def _strip_doc_keys(obj):
    """Drop `_`-prefixed documentation keys, recursively through model entries."""
    if isinstance(obj, dict):
        return {k: _strip_doc_keys(v) for k, v in obj.items()
                if not (isinstance(k, str) and k.startswith("_"))}
    if isinstance(obj, list):
        return [_strip_doc_keys(v) for v in obj]
    return obj


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh, parse_float=Decimal)
    cfg = _strip_doc_keys(raw)
    for key in _DOC_KEYS:
        cfg.pop(key, None)
    return cfg


def _sanity_check(cfg: dict) -> str | None:
    """Cheap invariants, mirroring the server-side validator's core rules.

    Not a substitute for `bff/web-chat/llm_config.mjs::validateConfig` — that one
    is authoritative and runs on every admin write. This is here so a typo in the
    seed file fails the deploy loudly instead of producing a catalogue that the
    console then refuses to save (the failure would surface much later, as a 400
    on the admin's first edit, with no obvious link back to the seed).
    """
    models = cfg.get("models")
    if not isinstance(models, list) or not models:
        return "models must be a non-empty list"
    aliases = [m.get("alias") for m in models]
    if len(set(aliases)) != len(aliases):
        return f"duplicate alias in models: {aliases}"
    enabled = [m for m in models if m.get("enabled")]
    if not enabled:
        return "at least one model must be enabled"
    default = cfg.get("default_model")
    hit = next((m for m in models if m.get("alias") == default), None)
    if hit is None:
        return f"default_model {default!r} is not in the catalogue"
    if not hit.get("enabled"):
        return f"default_model {default!r} must be enabled"
    for surface in ("webchat", "im"):
        if not any(surface in (m.get("surfaces") or []) for m in enabled):
            return f"no enabled model available for surface {surface!r}"
    return None


def reconcile_models(existing: list, catalog: list) -> tuple[list, list[str], list[str]]:
    """Return (merged models, aliases added, aliases realigned).

    The invariant while `generation == 0` ("seeded, nobody has edited it") is
    *stored models == shipped catalogue*, so an alias present in both is replaced
    by the shipped entry **wholesale**. That is what makes a field-level change
    (`enabled`, `surfaces`, `label`, `model_id`, `max_tokens`) reach an
    environment that was installed before the change; the previous version copied
    stored entries byte-for-byte, which quietly made every such edit
    first-deploy-only. Missing entries are appended where the catalogue puts them
    so the admin console's ordering stays intentional.

    Aliases the stored item has and the catalogue does not are kept, at the end.
    The catalogue retires a model by setting `enabled: false`, never by deleting
    it, precisely so old messages keep resolving their model's label -- dropping
    an unknown alias here would undo that for anything an earlier release
    shipped.

    Mirrored in `infra/lambda/stager/index.py::_reconcile_models` (the one-click
    path cannot import from this repo); kept honest by
    `scripts/test_oneclick_parity.py`.
    """
    by_alias = {m.get("alias"): m for m in existing if isinstance(m, dict)}
    merged: list = []
    added: list[str] = []
    realigned: list[str] = []
    for entry in catalog:
        alias = entry.get("alias")
        if alias not in by_alias:
            merged.append(entry)
            added.append(alias)
            continue
        merged.append(entry)
        stored = by_alias[alias]
        # Field names only -- the values can be long (model_id) and this string
        # goes into the deploy log.
        drifted = sorted(k for k in set(stored) | set(entry)
                         if stored.get(k) != entry.get(k))
        if drifted:
            realigned.append(f"{alias} ({', '.join(drifted)})")
    known = {e.get("alias") for e in catalog}
    merged.extend(m for m in existing
                  if isinstance(m, dict) and m.get("alias") not in known)
    return merged, added, realigned


def default_model_drift(item: dict, cfg: dict) -> str | None:
    """Return the seed's `default_model` when the stored item disagrees, else None.

    Only returns a value that is safe to write: the alias must exist in the
    catalogue **and** be enabled (an `enabled: False` default would leave the
    surface with no usable model).

    Mirrored in `infra/lambda/stager/index.py::_default_model_drift`; kept honest
    by `scripts/test_oneclick_parity.py`.
    """
    seed_default = cfg.get("default_model")
    if not seed_default or seed_default == item.get("default_model"):
        return None
    hit = next((m for m in cfg.get("models") or []
                if isinstance(m, dict) and m.get("alias") == seed_default), None)
    if hit is None or not hit.get("enabled"):
        return None
    return seed_default


def _top_up(table, cfg: dict, dry_run: bool = False) -> int:
    """Sync what a re-deploy is allowed to sync. Returns an exit code.

    Three kinds of drift, all invisible until someone goes looking:

    1. **Models the stored item is missing** -- entries added to the catalogue
       after the first deploy. 2026-08-27 in production: `zai-glm-5` had entered
       the catalogue the day before and simply was not in the list.
    2. **Fields of models both sides have** -- 2026-09-04 in production: the web
       model picker still offered `claude-haiku-4-5` (retired via
       `enabled: false`) and `openai-gpt-5-6-luna` (narrowed to `surfaces:
       ["im"]`) a day after both landed in the catalogue. Same shape as (1) and
       the same root cause -- the top-up only ever *added* entries, so every
       edit to an entry that already existed was silently first-deploy-only.
       Retiring a model is the one catalogue edit that is *supposed* to be
       visible to users, which is exactly why it must not need a rebuild.
    3. **`default_model`** -- 2026-09-02 in production: the catalogue's default
       moved from `claude-sonnet-5` to `xai-grok-4-6`, `xai-grok-4-6` *was*
       topped up into the model list, and the default stayed on Sonnet 5. The
       old code only ever wrote `models`, with the reasoning "a new model must
       never become the default by accident". That reasoning is still right, and
       it is not what this does: the value written is the one the catalogue
       *declares* as the default, not "whatever was just added". The symptom was
       nasty because every other slot (the `/notiops/agent/model_id` SSM
       parameter, the health-checker's `BEDROCK_MODEL_ID`) *had* followed the
       change -- so the fleet looked consistent from the CLI while the web chat
       still opened on Sonnet 5.

    All three are gated on `generation == 0` ("seeded, never edited by an
    admin"). Once an administrator has saved the page it is theirs: they may have
    disabled a model -- or chosen a default -- on purpose, and a deploy
    overriding that is the same class of bug as overwriting the whole item. In
    that case say what would have changed and leave the decision to them; a
    silent no-op here is what made all of the problems above so hard to spot.
    """
    from botocore.exceptions import ClientError

    item = table.get_item(Key={"PK": _PK, "SK": _SK}).get("Item") or {}
    merged, added, realigned = reconcile_models(item.get("models") or [],
                                               cfg.get("models") or [])
    new_default = default_model_drift(item, cfg)
    if not added and not realigned and not new_default:
        print("seed_llm_catalog: catalogue already present and complete, left untouched")
        return 0

    pending = (list(added) + list(realigned)
               + ([f"default_model -> {new_default}"] if new_default else []))
    gen = item.get("generation")
    if gen is not None and int(gen) != 0:
        print(f"seed_llm_catalog: catalogue was edited in the console "
              f"(generation={int(gen)}); not applying {pending}. Change them "
              f"from the admin console if you want them.")
        return 0

    if dry_run:
        print(f"seed_llm_catalog: --dry-run, would apply {pending}")
        return 0

    # Only the drifted attributes are written: credential_mode / backend_tasks
    # stay untouched, as do stored model entries whose alias this file no longer
    # carries.
    sets, names, values = [], {}, {":zero": 0}
    if added or realigned:
        sets.append("#m = :m")
        names["#m"] = "models"
        values[":m"] = merged
    if new_default:
        sets.append("#d = :d")
        names["#d"] = "default_model"
        values[":d"] = new_default
    try:
        table.update_item(
            Key={"PK": _PK, "SK": _SK},
            UpdateExpression="SET " + ", ".join(sets),
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ConditionExpression=(
                "attribute_not_exists(generation) OR generation = :zero"),
        )
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            print("seed_llm_catalog: catalogue was edited concurrently; "
                  f"not applying {pending}")
            return 0
        print(f"seed_llm_catalog: top-up failed: "
              f"{e.response.get('Error', {}).get('Code')}", file=sys.stderr)
        return 1
    print(f"seed_llm_catalog: catalogue already present; applied {pending}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", default=os.environ.get("CONFIG_TABLE", "notiops-config"))
    ap.add_argument("--region", default=os.environ.get("AWS_REGION") or None)
    ap.add_argument("--file", default=os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "config", "llm-model-catalog.json"))
    ap.add_argument("--force", action="store_true",
                    help="overwrite an existing catalogue (DESTRUCTIVE: discards "
                         "whatever the administrator configured in the console)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be written and exit without writing "
                         "(reads the stored item; ignores --force)")
    args = ap.parse_args()

    try:
        cfg = _load(args.file)
    except Exception as e:  # noqa: BLE001
        print(f"seed_llm_catalog: cannot read {args.file}: {type(e).__name__}: {e}",
              file=sys.stderr)
        return 1

    err = _sanity_check(cfg)
    if err:
        print(f"seed_llm_catalog: {args.file} is invalid: {err}", file=sys.stderr)
        return 1

    item = {**cfg, "PK": _PK, "SK": _SK}
    # generation 0 marks "seeded, never edited by an admin". The readers accept it
    # and the BFF's nextGeneration() treats 0 as "no usable previous value", so the
    # first admin save gets a real epoch-ms.
    item.setdefault("generation", 0)

    import boto3
    from botocore.exceptions import ClientError

    kwargs = {"region_name": args.region} if args.region else {}
    table = boto3.resource("dynamodb", **kwargs).Table(args.table)

    if args.dry_run:
        if table.get_item(Key={"PK": _PK, "SK": _SK}).get("Item"):
            return _top_up(table, cfg, dry_run=True)
        print(f"seed_llm_catalog: --dry-run, would seed {len(cfg['models'])} models "
              f"(default={cfg.get('default_model')}) into {args.table}")
        return 0

    put = {"Item": item}
    if not args.force:
        put["ConditionExpression"] = "attribute_not_exists(PK)"
    try:
        table.put_item(**put)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return _top_up(table, cfg)
        print(f"seed_llm_catalog: write failed: "
              f"{e.response.get('Error', {}).get('Code')}", file=sys.stderr)
        return 1
    except Exception as e:  # noqa: BLE001
        print(f"seed_llm_catalog: write failed: {type(e).__name__}", file=sys.stderr)
        return 1

    print(f"seed_llm_catalog: seeded {len(cfg['models'])} models "
          f"(default={cfg.get('default_model')}) into {args.table}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
