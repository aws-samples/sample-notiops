"""
Pin down the per-sidecar default-on behavior for `_sidecar_enabled`.

Until 2026-06-10 the function defaulted OFF for every sidecar — operators
had to flip env vars after deploying the sidecar containers manually.
After the BotStack sidecar bundle landed, the right default became ON
(for sidecars actually shipped by default: pricing, cost). This test
locks down which sidecars default ON vs OFF and checks that explicit
`false` overrides still work for incident response.

Run from repo root::

    PYTHONPATH=. python3.13 scripts/test_sidecar_enabled_defaults.py
"""
from __future__ import annotations

import os
import sys
import unittest.mock as mock

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

# bedrock_chat constructs a boto3 client at import time and ddb_state
# (transitively imported) reads CONVERSATIONS_TABLE from env. Stub
# both so we run offline.
import boto3 as _boto3
_boto3.client = mock.MagicMock()
_boto3.resource = mock.MagicMock()
os.environ.setdefault("CONVERSATIONS_TABLE", "stub-table")
os.environ.setdefault("METRICS_TABLE", "stub-metrics")
os.environ.setdefault("CONFIG_TABLE", "stub-config")

from core import bedrock_chat  # noqa: E402

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


def _with_env(env: dict[str, str]):
    """Wipe relevant env vars then apply `env`, restore on context exit."""
    keys = ("AWS_MCP_PRICING_ENABLED", "AWS_MCP_COST_ENABLED",
            "AWS_MCP_WA_ENABLED", "AWS_MCP_FOO_ENABLED")
    return mock.patch.dict(os.environ,
                            {k: env.get(k, "") for k in keys},
                            clear=False)


def test_pricing_defaults_on():
    print("test_pricing_defaults_on")
    with _with_env({}):
        # Make sure the env var really is unset (mock.patch.dict
        # leaves "" which os.environ.get treats as set-but-empty).
        os.environ.pop("AWS_MCP_PRICING_ENABLED", None)
        _check("unset → enabled (default-on)",
               bedrock_chat._sidecar_enabled("pricing") is True)


def test_cost_defaults_on():
    print("test_cost_defaults_on")
    with _with_env({}):
        os.environ.pop("AWS_MCP_COST_ENABLED", None)
        _check("unset → enabled (default-on)",
               bedrock_chat._sidecar_enabled("cost") is True)


def test_wa_defaults_off():
    """WA sidecar was retired 2026-05-30; keep it default-off so an
    accidental setting can't bring it back."""
    print("test_wa_defaults_off")
    with _with_env({}):
        os.environ.pop("AWS_MCP_WA_ENABLED", None)
        _check("unset → disabled (default-off)",
               bedrock_chat._sidecar_enabled("wa") is False)


def test_unknown_sidecar_defaults_off():
    """Defense-in-depth: a misspelled sidecar name should NOT come up
    enabled by accident."""
    print("test_unknown_sidecar_defaults_off")
    with _with_env({}):
        os.environ.pop("AWS_MCP_FOO_ENABLED", None)
        _check("unknown name → disabled",
               bedrock_chat._sidecar_enabled("foo") is False)


def test_explicit_false_overrides_default_on():
    """Operator can disable a default-on sidecar for incident response."""
    print("test_explicit_false_overrides_default_on")
    with _with_env({"AWS_MCP_PRICING_ENABLED": "false"}):
        _check("pricing + 'false' → disabled",
               bedrock_chat._sidecar_enabled("pricing") is False)
    with _with_env({"AWS_MCP_COST_ENABLED": "0"}):
        _check("cost + '0' → disabled",
               bedrock_chat._sidecar_enabled("cost") is False)
    with _with_env({"AWS_MCP_PRICING_ENABLED": "off"}):
        _check("pricing + 'off' → disabled",
               bedrock_chat._sidecar_enabled("pricing") is False)


def test_explicit_true_works_too():
    """Redundant on a default-on sidecar but should still be honoured."""
    print("test_explicit_true_works_too")
    with _with_env({"AWS_MCP_PRICING_ENABLED": "true"}):
        _check("pricing + 'true' → enabled",
               bedrock_chat._sidecar_enabled("pricing") is True)
    with _with_env({"AWS_MCP_WA_ENABLED": "1"}):
        _check("wa + '1' → enabled (manual opt-in)",
               bedrock_chat._sidecar_enabled("wa") is True)


def test_garbage_values_fall_back_to_default():
    """Anything we don't recognise treats the var as unset."""
    print("test_garbage_values_fall_back_to_default")
    with _with_env({"AWS_MCP_PRICING_ENABLED": "garbage"}):
        _check("pricing + 'garbage' → default-on",
               bedrock_chat._sidecar_enabled("pricing") is True)
    with _with_env({"AWS_MCP_WA_ENABLED": "garbage"}):
        _check("wa + 'garbage' → default-off",
               bedrock_chat._sidecar_enabled("wa") is False)


def main() -> int:
    test_pricing_defaults_on()
    test_cost_defaults_on()
    test_wa_defaults_off()
    test_unknown_sidecar_defaults_off()
    test_explicit_false_overrides_default_on()
    test_explicit_true_works_too()
    test_garbage_values_fall_back_to_default()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
