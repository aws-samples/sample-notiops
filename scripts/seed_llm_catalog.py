#!/usr/bin/env python3
"""Seed the LLM model catalogue into DynamoDB (PK=llmcfg / SK=meta).

Called by `setup.sh`. Idempotent: the write is conditional on the item not
existing, so re-running a deploy never overwrites what an administrator has
configured in the console.

When the item already exists the catalogue is **topped up**: entries that this
file has and the stored item does not are appended (see `_top_up`). Without that
step "already present" -- the normal path on every re-deploy -- silently means
*models added to the catalogue after the first deploy never reach the
environment*. That really happened: `zai-glm-5` was added on 2026-08-26 and was
still missing from the production admin console (and therefore from the model
picker) a day later, which reads as "the feature was never built". The top-up is
additive only, and only while nobody has edited the catalogue in the console.

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


def merge_missing_models(existing: list, catalog: list) -> tuple[list, list[str]]:
    """Return (merged models, aliases added). **Additive only.**

    Kept deliberately dumb: an entry already in the stored item is copied over
    byte-for-byte (never re-enabled, re-labelled or re-pointed at another
    model_id), and entries the stored item has but this file does not are kept at
    the end. The only edit is appending the missing ones, positioned where the
    catalogue puts them so the admin console's ordering stays intentional.

    Mirrored in `infra/lambda/stager/index.py::_merge_missing_models` (the
    one-click path cannot import from this repo); kept honest by
    `scripts/test_oneclick_parity.py`.
    """
    by_alias = {m.get("alias"): m for m in existing if isinstance(m, dict)}
    merged: list = []
    added: list[str] = []
    for entry in catalog:
        alias = entry.get("alias")
        if alias in by_alias:
            merged.append(by_alias[alias])
        else:
            merged.append(entry)
            added.append(alias)
    known = {e.get("alias") for e in catalog}
    merged.extend(m for m in existing
                  if isinstance(m, dict) and m.get("alias") not in known)
    return merged, added


def _top_up(table, cfg: dict) -> int:
    """Add catalogue entries the stored item is missing. Returns an exit code.

    Gated on `generation == 0` ("seeded, never edited by an admin"). Once an
    administrator has saved the page it is theirs: they may have removed a model
    on purpose, and a deploy resurrecting it would be the same class of bug as
    overwriting the whole item. In that case say which aliases are missing and
    leave the decision to them -- a silent no-op here is what made the original
    problem so hard to spot.
    """
    from botocore.exceptions import ClientError

    item = table.get_item(Key={"PK": _PK, "SK": _SK}).get("Item") or {}
    merged, added = merge_missing_models(item.get("models") or [],
                                        cfg.get("models") or [])
    if not added:
        print("seed_llm_catalog: catalogue already present and complete, left untouched")
        return 0

    gen = item.get("generation")
    if gen is not None and int(gen) != 0:
        print(f"seed_llm_catalog: catalogue was edited in the console "
              f"(generation={int(gen)}); not adding {added}. Add them from "
              f"the admin console if you want them.")
        return 0

    try:
        table.update_item(
            Key={"PK": _PK, "SK": _SK},
            # Only `models` is touched: default_model / credential_mode /
            # backend_tasks stay exactly as they are. A new model must never
            # become the default by accident.
            UpdateExpression="SET #m = :m",
            ExpressionAttributeNames={"#m": "models"},
            ExpressionAttributeValues={":m": merged, ":zero": 0},
            ConditionExpression=(
                "attribute_not_exists(generation) OR generation = :zero"),
        )
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            print("seed_llm_catalog: catalogue was edited concurrently; "
                  f"not adding {added}")
            return 0
        print(f"seed_llm_catalog: top-up failed: "
              f"{e.response.get('Error', {}).get('Code')}", file=sys.stderr)
        return 1
    print(f"seed_llm_catalog: catalogue already present; added missing model(s) {added}")
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
