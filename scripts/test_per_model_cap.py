"""
Self-test for the per-model output-token cap (`_max_output_tokens_for`)
introduced after the 2026-06-05 PM Nova mid-URL truncation incident.

Note: all models here (Claude, Nova, GPT) are accessed through Amazon Bedrock
(managed security, compliance monitoring, and cost controls); third-party
models run via Bedrock, not direct vendor APIs.

Pins down:

  * The cap is sourced from `core.model_catalog.ModelEntry.max_output_tokens`,
    not a single bedrock_chat constant.
  * Nova's cap is set to 5000 (its documented hard cap), Claude's to
    6000+ (sonnet 4.6 supports 64K but we don't want to enable
    runaways), GPT's to 8000 (the value already pinned in the
    2026-06-05 morning protocol-leak fix).
  * Unknown / empty model id falls back to the conservative 3000
    default, NOT to 0 / None.

Run from repo root::

    PYTHONPATH=. python3 scripts/test_per_model_cap.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

# bedrock_chat imports boto3 + several DDB-backed modules; stub the
# bedrock client and the table-backed env vars so import works in a
# bare environment.
os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")
from core import bedrock_chat as _bc
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


def test_catalogue_caps_are_per_model():
    print("test_catalogue_caps_are_per_model")
    claude = _mc.get("claude")
    nova = _mc.get("nova")
    gpt = _mc.get("gpt")

    _check("claude cap >= 6000 (room for long markdown)",
           claude.max_output_tokens >= 6000,
           f"got {claude.max_output_tokens}")
    _check("nova cap == 5000 (Nova Pro documented max)",
           nova.max_output_tokens == 5000,
           f"got {nova.max_output_tokens}")
    _check("gpt cap == 8000 (matches Mantle protocol-leak fix)",
           gpt.max_output_tokens == 8000,
           f"got {gpt.max_output_tokens}")
    _check("nova cap > 3000 (would have prevented 06-05 PM clip)",
           nova.max_output_tokens > 3000)


def test_helper_resolves_via_model_id():
    print("test_helper_resolves_via_model_id")
    # 用 catalog 实际 model_id(不写死版本号,模型升级后测试仍有效)。
    cases = [
        (_mc.get("claude").model_id, _mc.get("claude").max_output_tokens),
        (_mc.get("nova").model_id,   _mc.get("nova").max_output_tokens),
        (_mc.get("gpt").model_id,    _mc.get("gpt").max_output_tokens),
    ]
    for model_id, expected in cases:
        actual = _bc._max_output_tokens_for(model_id)
        _check(f"{model_id} → {expected}", actual == expected,
               f"got {actual}")


def test_helper_unknown_id_falls_back():
    print("test_helper_unknown_id_falls_back")
    fallback = _bc._MAX_OUTPUT_TOKENS_FALLBACK
    _check("None → fallback",  _bc._max_output_tokens_for(None) == fallback)
    _check("\"\" → fallback",   _bc._max_output_tokens_for("") == fallback)
    _check("unknown id → fallback",
           _bc._max_output_tokens_for("not-a-real-model") == fallback)
    _check("fallback is conservative (≤ 3500)",
           fallback <= 3500, f"fallback={fallback}")


def test_no_dangling_constant_ref_in_chat():
    """Make sure the old monolithic constant isn't accidentally
    referenced anywhere in bedrock_chat — every call site must go
    through `_max_output_tokens_for(model_id)` so per-model values
    actually take effect."""
    print("test_no_dangling_constant_ref_in_chat")
    src_path = os.path.join(os.path.dirname(__file__), "..",
                            "core", "bedrock_chat.py")
    with open(src_path) as f:
        src = f.read()
    # The old name was `_MAX_OUTPUT_TOKENS` (without the _FALLBACK suffix).
    # We only allow `_MAX_OUTPUT_TOKENS_FALLBACK` mentions now.
    bad = []
    for line_no, line in enumerate(src.splitlines(), 1):
        # Skip pure comments — the migration note legitimately mentions
        # the old name.
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if "_MAX_OUTPUT_TOKENS" in line and "_FALLBACK" not in line:
            bad.append((line_no, line.strip()))
    _check("no bare _MAX_OUTPUT_TOKENS references in code",
           not bad, f"found {bad}")


def main() -> int:
    test_catalogue_caps_are_per_model()
    test_helper_resolves_via_model_id()
    test_helper_unknown_id_falls_back()
    test_no_dangling_constant_ref_in_chat()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
