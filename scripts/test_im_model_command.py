#!/usr/bin/env python3
"""`@bot model` now follows the admin-enabled set .

The three `platforms/{feishu,slack,dingtalk}/app/main.py` copies were deliberately
left untouched: they already ask `model_catalog` for the candidate list
(`all_entries`), the validity hint (`list_aliases`) and admission (`is_known`).
Making `model_catalog` DDB-backed therefore changes their behaviour without
changing their code — which is better than editing the same handler three times.
This file is the evidence for that claim, plus the migration properties that
would otherwise fail silently:

  * disabling a model in the console removes it from `@bot model list`
  * ...and from the "valid: ..." hint, so the error never recommends a model
    the user cannot actually pick
  * ...and makes it inadmissible, so a stored 30-day preference for it expires
    on the next message instead of pinning a model the admin retired
  * short aliases (`claude`, `gpt_sol`) stay admissible — real preference rows
    contain those, and rejecting them would silently reset every IM chat
  * `get()` never raises and never returns None, because `bedrock_chat.respond()`
    calls it with no try block

Runs against a stubbed catalogue; no DynamoDB, no network.

Run: PYTHONPATH=. python3 scripts/test_im_model_command.py
"""
from __future__ import annotations

import copy
import json
import os
import sys

PASS, FAIL = "\u2705", "\u274c"
_failed = 0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from core import llm_config as _cfg      # noqa: E402
from core import model_catalog as _mc    # noqa: E402

SEED = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))

# Kept so the outage test can put the genuine fetch path back after the other
# tests have stubbed it out.
_real_fetch = _cfg._fetch                # noqa: SLF001


def _check(name: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {name}")
    else:
        _failed += 1
        print(f"  {FAIL} {name}" + (f" :: {detail}" if detail else ""))


def _install(models: list[dict], default_model: str = "claude-sonnet-5") -> None:
    """Pin the catalogue `llm_config` hands out, bypassing DynamoDB."""
    cfg = {
        "generation": 1,
        "provider": "bedrock",
        "credential_mode": "iam",
        "default_model": default_model,
        "models": copy.deepcopy(models),
        "backend_tasks": {},
    }
    _cfg.reset_cache()

    def _fake_fetch(consistent: bool = False):
        return _cfg._normalise(cfg)

    _cfg._fetch = _fake_fetch          # noqa: SLF001 — test seam, same as sibling scripts
    _cfg.get_config()                  # prime the TTL cache


def _seed_models() -> list[dict]:
    return copy.deepcopy(SEED["models"])


def _im_enabled(models: list[dict]) -> list[dict]:
    return [m for m in models if m["enabled"] and "im" in m["surfaces"]]


# ---------------------------------------------------------------------------
def test_list_shows_only_enabled_im_models() -> None:
    """`@bot model list` renders `all_entries()`; webchat-only models must not appear."""
    print("test_list_shows_only_enabled_im_models")
    models = _seed_models()
    _install(models)

    shown = {e.alias for e in _mc.all_entries()}
    expect = {(m.get("short") or m["alias"]) for m in _im_enabled(models)}
    _check("list == enabled ∩ im", shown == expect,
           f"shown={sorted(shown)} expect={sorted(expect)}")

    webchat_only = {(m.get("short") or m["alias"]) for m in models
                    if m["enabled"] and "im" not in m["surfaces"]}
    _check("webchat-only models are not offered on IM",
           not (shown & webchat_only), f"leaked={sorted(shown & webchat_only)}")
    _check("seed actually has a webchat-only model (otherwise the check is vacuous)",
           bool(webchat_only), "no webchat-only model in seed")

    disabled = {(m.get("short") or m["alias"]) for m in models if not m["enabled"]}
    _check("disabled models are not offered", not (shown & disabled),
           f"leaked={sorted(shown & disabled)}")


def test_disabling_a_model_removes_it_everywhere() -> None:
    """One console toggle must hit the list, the hint and admission together."""
    print("test_disabling_a_model_removes_it_everywhere")
    models = _seed_models()
    victim = next(m for m in _im_enabled(models) if m["alias"] != "claude-sonnet-5")
    short = victim.get("short") or victim["alias"]

    _install(models)
    _check(f"{short!r} admissible while enabled", _mc.is_known(short))
    _check(f"{short!r} listed while enabled", short in _mc.list_aliases())

    for m in models:
        if m["alias"] == victim["alias"]:
            m["enabled"] = False
    _install(models)

    _check(f"{short!r} no longer admissible", not _mc.is_known(short))
    _check(f"{short!r} gone from the candidate list",
           short not in {e.alias for e in _mc.all_entries()})
    _check(f"{short!r} gone from the 'valid: ...' hint",
           short not in _mc.list_aliases(),
           "the error message would recommend a model the user cannot pick")
    _check(f"canonical {victim['alias']!r} also inadmissible "
           "(no back door via the other namespace)",
           not _mc.is_known(victim["alias"]))


def test_stored_short_aliases_survive_the_migration() -> None:
    """Real preference rows hold short aliases. They must keep working."""
    print("test_stored_short_aliases_survive_the_migration")
    models = _seed_models()
    _install(models)
    for m in _im_enabled(models):
        short = m.get("short")
        if not short:
            continue
        _check(f"stored short alias {short!r} still admitted", _mc.is_known(short))
        _check(f"stored short alias {short!r} resolves to its own model",
               _mc.get(short).model_id == m["model_id"],
               f"got={_mc.get(short).model_id} want={m['model_id']}")
        for legacy in m.get("aliases_legacy") or []:
            _check(f"legacy alias {legacy!r} still admitted", _mc.is_known(legacy))


def test_retired_preference_falls_back_not_pins() -> None:
    """A pref for a since-disabled model resolves to the default, not to itself."""
    print("test_retired_preference_falls_back_not_pins")
    models = _seed_models()
    victim = next(m for m in _im_enabled(models) if m["alias"] != "claude-sonnet-5")
    short = victim.get("short") or victim["alias"]
    for m in models:
        if m["alias"] == victim["alias"]:
            m["enabled"] = False
    _install(models)

    entry = _mc.get(short)
    _check("retired preference no longer resolves to the retired model",
           entry.model_id != victim["model_id"], f"still={entry.model_id}")
    _check("retired preference resolves to the default instead",
           entry.model_id == next(m["model_id"] for m in models
                                  if m["alias"] == "claude-sonnet-5"),
           f"got={entry.model_id}")


def test_disabled_model_keeps_its_output_cap() -> None:
    """停用某模型后，`find_by_model_id` 仍要能给出它的真实输出上限。

    `find_by_model_id` 是**描述**用途，喂给 `bedrock_chat._max_output_tokens_for()`，
    而那是每个 Bedrock body 的唯一上限来源。若它只看启用集，停用一个模型会让在途请求
    掉到 `_MAX_OUTPUT_TOKENS_FALLBACK`（3000）——2026-06-05 来源块被截断那次事故正是
    上限过低造成的。准入（`is_known`）仍必须拒绝它，两件事分离。
    """
    print("test_disabled_model_keeps_its_output_cap")
    models = _seed_models()
    victim = next(m for m in _im_enabled(models) if m["alias"] == "amazon-nova-pro")
    want_cap = (victim.get("output_override") or {}).get("im")
    for m in models:
        if m["alias"] == victim["alias"]:
            m["enabled"] = False
    _install(models)

    entry = _mc.find_by_model_id(victim["model_id"])
    _check("disabled model is still describable", entry is not None)
    if entry:
        _check(f"its cap is still {want_cap}, not the conservative fallback",
               entry.max_output_tokens == want_cap,
               f"got={entry.max_output_tokens} want={want_cap}")
    _check("but it is NOT admissible", not _mc.is_known(victim.get("short") or victim["alias"]))
    _check("and it is not offered in the candidate list",
           (victim.get("short") or victim["alias"]) not in _mc.list_aliases())


def test_listing_is_resolved_against_one_snapshot() -> None:
    """整份候选列表必须在同一代配置下解析出来。

    `all_entries()` 逐条调 `resolve()`；每条各自 `get_config()` 时，TTL 若在循环中途
    到期就会得到混合结果（entry 0 用旧代、entry 5 用新代）。这里数一下 `get_config`
    被调了几次：传 cfg 之后应当只有一次。
    """
    print("test_listing_is_resolved_against_one_snapshot")
    _install(_seed_models())
    calls = {"n": 0}
    real = _cfg.get_config

    def counting(payload_generation=None):
        calls["n"] += 1
        return real(payload_generation)

    _cfg.get_config = counting
    try:
        entries = _mc.all_entries()
    finally:
        _cfg.get_config = real
    _check("all_entries() takes exactly one config snapshot",
           calls["n"] == 1, f"get_config called {calls['n']}x for {len(entries)} entries")


def test_get_never_raises_never_none() -> None:
    """`bedrock_chat.respond()` calls get() with no try — it must always answer."""
    print("test_get_never_raises_never_none")
    _install(_seed_models())
    for probe in (None, "", "   ", "not-a-model", "../../etc/passwd",
                  "claude; drop table", "CLAUDE", " claude ",
                  "global.anthropic.claude-sonnet-5", 0, [], {}):
        try:
            entry = _mc.get(probe)  # type: ignore[arg-type]
            ok = entry is not None and bool(entry.model_id) and entry.max_output_tokens > 0
            _check(f"get({probe!r}) yields a usable entry", ok, repr(entry))
        except Exception as e:  # noqa: BLE001
            _check(f"get({probe!r}) does not raise", False, repr(e))


def test_catalogue_outage_still_serves_a_model() -> None:
    """DDB unreachable → builtin snapshot, not an empty list or an exception.

    The outage is injected at the *table* level, not by making `_fetch` raise:
    the real `_fetch` swallows DynamoDB errors and returns None so the caller
    falls back to the builtin catalogue. Stubbing `_fetch` to raise would test a
    path that cannot happen in production — and would have hidden whether the
    builtin snapshot is actually complete, which is the whole point here.
    """
    print("test_catalogue_outage_still_serves_a_model")
    _cfg.reset_cache()
    _cfg._fetch = _real_fetch          # noqa: SLF001 — restore the genuine path

    def _dead_table():
        raise RuntimeError("ddb down")

    _cfg._table = _dead_table          # noqa: SLF001
    try:
        entries = _mc.all_entries()
        _check("outage still yields candidates", len(entries) >= 1, str(len(entries)))
        _check("outage keeps short aliases working (builtin has them)",
               _mc.is_known("claude") and _mc.is_known("nova"),
               "builtin catalogue is missing short/aliases_legacy")
        _check("outage keeps per-model output caps (nova != the surface target)",
               _mc.get("nova").max_output_tokens == 5000,
               f"got={_mc.get('nova').max_output_tokens}")
        _check("outage get() still resolves", bool(_mc.get("claude").model_id))
    except Exception as e:  # noqa: BLE001
        _check("outage does not raise", False, repr(e))


def test_platform_handlers_were_not_forked() -> None:
    """The three copies must keep going through model_catalog, not around it.

    If someone later inlines a model list into a platform handler, the console
    toggle stops governing that platform and nothing else in this suite notices.
    """
    print("test_platform_handlers_were_not_forked")
    for platform in ("feishu", "slack", "dingtalk"):
        path = os.path.join(ROOT, "platforms", platform, "app", "main.py")
        src = open(path).read()
        _check(f"{platform}: candidates come from model_catalog.all_entries()",
               "model_catalog.all_entries()" in src)
        _check(f"{platform}: admission goes through model_catalog.is_known()",
               "model_catalog.is_known(" in src)
        _check(f"{platform}: hint comes from model_catalog.list_aliases()",
               "model_catalog.list_aliases()" in src)


def main() -> int:
    test_list_shows_only_enabled_im_models()
    test_disabling_a_model_removes_it_everywhere()
    test_stored_short_aliases_survive_the_migration()
    test_retired_preference_falls_back_not_pins()
    test_disabled_model_keeps_its_output_cap()
    test_listing_is_resolved_against_one_snapshot()
    test_get_never_raises_never_none()
    test_catalogue_outage_still_serves_a_model()
    test_platform_handlers_were_not_forked()
    _cfg.reset_cache()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
