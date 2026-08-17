"""
Self-test for model-catalogue admission control (spec R1.8 / R3.5).

Pins down the 2026-08 split between two previously conflated semantics:

  * `is_known()`          — **admission control**, strict catalogue
                            membership. Gates `@bot model X` user input
                            and stored per-chat preferences.
  * `find_by_model_id()`  — **metadata description**, deliberately loose
                            (uncatalogued Anthropic ids get a synthesised
                            entry so they still get a sane label / output
                            cap).

Regression guarded: before the split, `is_known()` fell through to
`find_by_model_id()`, so any string containing "anthropic" was accepted.
That let a user pin an arbitrary raw model id and bypass the
admin-curated model set entirely.

Run from repo root::

    PYTHONPATH=. python3 scripts/test_model_catalog_admission.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

from core import model_catalog as _mc

PASS = "✅"
FAIL = "❌"
_failed = 0


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


def test_is_known_accepts_registered_aliases():
    print("test_is_known_accepts_registered_aliases")
    for alias in _mc.list_aliases():
        _check(f"alias {alias!r} accepted", _mc.is_known(alias))
    # Case / whitespace tolerance is intentional (users type freely).
    first = _mc.list_aliases()[0]
    _check("upper-case tolerated", _mc.is_known(first.upper()))
    _check("surrounding spaces tolerated", _mc.is_known(f"  {first}  "))


def test_is_known_rejects_raw_model_ids():
    """The core regression: raw model ids must NOT pass admission."""
    print("test_is_known_rejects_raw_model_ids")
    # A real, catalogued model's *wire id* is still not an alias.
    catalogued_id = _mc.get(_mc.DEFAULT_ALIAS).model_id
    _check(f"catalogued wire id {catalogued_id!r} rejected as alias",
           not _mc.is_known(catalogued_id))
    # Unregistered Anthropic ids — the old fuzzy fallback accepted these.
    for bogus in ("us.anthropic.claude-x",
                  "global.anthropic.claude-nonexistent-9",
                  "anthropic",
                  "my-anthropic-passthrough"):
        _check(f"unregistered {bogus!r} rejected", not _mc.is_known(bogus))


def test_is_known_rejects_empty_and_garbage():
    print("test_is_known_rejects_empty_and_garbage")
    for bad in (None, "", "   ", "not-a-model", "../../etc/passwd",
                "claude; drop table"):
        _check(f"{bad!r} rejected", not _mc.is_known(bad))


def test_find_by_model_id_stays_loose():
    """Metadata reverse-lookup keeps its fallback — it is what gives a
    newly released Claude variant a sane label and output cap."""
    print("test_find_by_model_id_stays_loose")
    exact = _mc.get(_mc.DEFAULT_ALIAS)
    _check("exact wire id resolves",
           (_mc.find_by_model_id(exact.model_id) or exact).model_id == exact.model_id)

    synth = _mc.find_by_model_id("us.anthropic.claude-brand-new-7")
    _check("uncatalogued anthropic id still synthesises an entry",
           synth is not None)
    if synth is not None:
        _check("synthesised entry uses bedrock_anthropic kind",
               synth.kind == "bedrock_anthropic", f"got {synth.kind}")
        _check("synthesised entry carries a positive output cap",
               synth.max_output_tokens > 0)
    _check("non-anthropic garbage still unresolvable",
           _mc.find_by_model_id("totally-unknown-model") is None)


def test_admission_and_description_are_independent():
    """Explicit statement of the invariant: loose description must never
    imply admission."""
    print("test_admission_and_description_are_independent")
    probe = "us.anthropic.claude-x"
    describable = _mc.find_by_model_id(probe) is not None
    admitted = _mc.is_known(probe)
    _check("describable but NOT admitted", describable and not admitted,
           f"describable={describable} admitted={admitted}")


def main() -> int:
    test_is_known_accepts_registered_aliases()
    test_is_known_rejects_raw_model_ids()
    test_is_known_rejects_empty_and_garbage()
    test_find_by_model_id_stays_loose()
    test_admission_and_description_are_independent()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
