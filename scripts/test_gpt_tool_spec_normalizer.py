"""
Pin down the contract between our internal tool spec and the OpenAI
Responses API strict-mode requirements.

Backstory: when GPT-5.4 was first wired in (2026-06-05) we shipped
flat-shape tool specs without `strict: true`. The model intermittently
leaked OpenAI internal CoT markers like `to=functions.aws_docs_read`
into `output_text` instead of emitting them as proper
`function_call` blocks. Per the OpenAI Responses API docs:

  - Strict mode forces the model to invoke functions via the
    structured `function_call` channel rather than free text.
  - In the Responses API, omitting `strict` causes the schema to be
    normalized into strict mode automatically, BUT the schema must
    already satisfy the strict requirements: `additionalProperties:
    false` AND all properties present in `required`. A non-compliant
    schema silently degrades the path (matches our observation).

This test makes sure every tool we ship to GPT now satisfies strict.

Run from repo root::

    PYTHONPATH=. python3 scripts/test_gpt_tool_spec_normalizer.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.dirname(os.path.dirname(__file__))))

# Stub DDB so bedrock_chat imports cleanly in a bare env.
os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")

import unittest.mock as mock
import boto3
boto3.resource = mock.MagicMock()
boto3.client = mock.MagicMock()

from core import bedrock_chat as _bc  # noqa: E402

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


def _walk_objects(schema: dict):
    """Yield every object-typed sub-schema in a JSON Schema tree."""
    if not isinstance(schema, dict):
        return
    if schema.get("type") == "object":
        yield schema
        for sub in (schema.get("properties") or {}).values():
            yield from _walk_objects(sub)
    if "items" in schema:
        yield from _walk_objects(schema["items"])


# ---------- Normalizer-only unit tests ------------------------------------

def test_normalizer_adds_additionalProperties_false():
    print("test_normalizer_adds_additionalProperties_false")
    schema = {
        "type": "object",
        "properties": {"q": {"type": "string"}},
        "required": ["q"],
    }
    out = _bc._normalize_to_strict_object_schema(schema)
    _check("root has additionalProperties:false",
           out.get("additionalProperties") is False)
    # Original must not be mutated.
    _check("input not mutated",
           "additionalProperties" not in schema)


def test_normalizer_promotes_optional_to_required_via_nullable():
    print("test_normalizer_promotes_optional_to_required_via_nullable")
    schema = {
        "type": "object",
        "properties": {
            "regions": {"type": "array", "items": {"type": "string"}},
            "resource_type": {"type": "string"},
            "filters": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["regions", "resource_type"],
    }
    out = _bc._normalize_to_strict_object_schema(schema)
    _check("all properties listed in `required`",
           sorted(out.get("required") or [])
           == ["filters", "regions", "resource_type"])
    # The originally-optional `filters` should be made nullable so it
    # can legitimately be "absent in spirit" while still satisfying
    # strict mode's all-required rule.
    filters_type = out["properties"]["filters"]["type"]
    _check("optional `filters` is now nullable union",
           isinstance(filters_type, list) and "null" in filters_type,
           f"got type={filters_type!r}")


def test_normalizer_recurses_into_arrays_of_objects():
    print("test_normalizer_recurses_into_arrays_of_objects")
    schema = {
        "type": "object",
        "properties": {
            "filters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "field": {"type": "string"},
                        "op": {"type": "string"},
                    },
                    "required": ["field"],
                },
            },
        },
        "required": ["filters"],
    }
    out = _bc._normalize_to_strict_object_schema(schema)
    item = out["properties"]["filters"]["items"]
    _check("nested array-of-object got additionalProperties:false",
           item.get("additionalProperties") is False)
    _check("nested array-of-object required covers all props",
           sorted(item.get("required") or []) == ["field", "op"])


def test_normalizer_passes_through_non_objects():
    print("test_normalizer_passes_through_non_objects")
    _check("None/non-dict left alone (None)",
           _bc._normalize_to_strict_object_schema(None) is None)
    _check("string-type schema unchanged",
           _bc._normalize_to_strict_object_schema(
               {"type": "string"})["type"] == "string")


# ---------- End-to-end: every Tier-1 tool produces a strict-compliant spec

def test_every_tier1_tool_is_strict_compliant():
    print("test_every_tier1_tool_is_strict_compliant")
    bot_tools = list(_bc._TIER1_TOOLS)
    fn_tools = _bc._bot_tools_to_openai_function_spec(bot_tools)
    _check("at least one tier-1 tool surfaced", len(fn_tools) >= 1,
           f"got {len(fn_tools)}")

    for spec in fn_tools:
        name = spec.get("name", "?")
        _check(f"[{name}] type==function",
               spec.get("type") == "function")
        _check(f"[{name}] strict==true",
               spec.get("strict") is True)
        params = spec.get("parameters") or {}
        _check(f"[{name}] parameters is object schema",
               params.get("type") == "object")
        # Walk every nested object — each must declare additionalProperties:false
        # AND list all its properties in `required`.
        for obj in _walk_objects(params):
            _check(f"[{name}] every nested object has "
                   f"additionalProperties:false",
                   obj.get("additionalProperties") is False,
                   f"obj={obj!r}")
            props_keys = sorted((obj.get("properties") or {}).keys())
            req = sorted(obj.get("required") or [])
            _check(f"[{name}] every property is in required "
                   f"(props={props_keys}, required={req})",
                   props_keys == req,
                   f"props={props_keys}, required={req}")


# ---------- Regression: leakage signatures we observed ---------------------

def test_normalizer_handles_the_real_culprit_schema():
    """The aws_regional_availability tool was the 2026-06-05 sample
    that triggered the leak — `filters` was in `properties` but not
    in `required`. Make sure our normalizer fixes precisely this."""
    print("test_normalizer_handles_the_real_culprit_schema")
    name = _bc._TOOL_NAME_REGIONAL_AVAILABILITY
    bot_tools = [t for t in _bc._TIER1_TOOLS if t.get("name") == name]
    _check("found regional_availability tool in catalogue",
           len(bot_tools) == 1)
    if not bot_tools:
        return
    fn = _bc._bot_tools_to_openai_function_spec(bot_tools)[0]
    params = fn["parameters"]
    _check("filters now in required",
           "filters" in (params.get("required") or []))
    _check("filters type is nullable",
           "null" in params["properties"]["filters"]["type"])


def test_strict_eligibility_predicate():
    """Pin down which schema shapes are eligible for strict mode and
    which ones we have to ship as best-effort. Was added after the
    2026-06-05 PM pricing-leak — `awslabs.aws-pricing-mcp-server`
    schemas use `$defs` / `anyOf:[type, null]` / `additionalProperties:
    true`, none of which are strict-friendly."""
    print("test_strict_eligibility_predicate")

    # Eligible: simple object with leaf properties.
    _check("simple {string} eligible",
           _bc._is_strict_eligible({
               "type": "object",
               "properties": {"q": {"type": "string"}},
               "required": ["q"],
           }))

    # Eligible: array of leaf strings.
    _check("array<string> eligible",
           _bc._is_strict_eligible({
               "type": "object",
               "properties": {
                   "regions": {"type": "array",
                                "items": {"type": "string"}}
               },
               "required": ["regions"],
           }))

    # Ineligible: $defs / $ref.
    _check("schema with $defs ineligible",
           not _bc._is_strict_eligible({
               "type": "object",
               "$defs": {"Foo": {"type": "string"}},
               "properties": {"foo": {"$ref": "#/$defs/Foo"}},
           }))

    # Ineligible: anyOf — what awslabs uses for nullable.
    _check("schema with property using anyOf ineligible",
           not _bc._is_strict_eligible({
               "type": "object",
               "properties": {
                   "x": {"anyOf": [{"type": "string"},
                                    {"type": "null"}]}
               },
           }))

    # Ineligible: additionalProperties: true.
    _check("schema with additionalProperties:true ineligible",
           not _bc._is_strict_eligible({
               "type": "object",
               "properties": {"x": {"type": "string"}},
               "additionalProperties": True,
           }))

    # Ineligible: oneOf at top level.
    _check("schema with oneOf ineligible",
           not _bc._is_strict_eligible({
               "oneOf": [{"type": "object"}, {"type": "string"}],
           }))


def test_converter_falls_back_to_best_effort_for_complex_schemas():
    """The 2026-06-05 PM pricing leak signature: awslabs sidecar
    schemas with $defs/anyOf are now shipped non-strict so Mantle's
    auto-strict-normalize doesn't degrade them."""
    print("test_converter_falls_back_to_best_effort_for_complex_schemas")
    awslabs_like = {
        "name": "aws_pricing_get_pricing",
        "description": "AWS Price List query",
        "input_schema": {
            "$defs": {
                "PricingFilter": {
                    "type": "object",
                    "properties": {
                        "Field": {"type": "string"},
                        "Value": {
                            "anyOf": [{"type": "string"},
                                       {"type": "array",
                                        "items": {"type": "string"}}],
                        },
                    },
                    "required": ["Field", "Value"],
                },
            },
            "properties": {
                "service_code": {"type": "string"},
                "region": {"anyOf": [{"type": "string"},
                                      {"type": "null"}], "default": None},
            },
            "required": ["service_code"],
            "type": "object",
        },
    }
    spec = _bc._bot_tools_to_openai_function_spec([awslabs_like])[0]
    _check("complex schema kept raw (parameters preserved verbatim)",
           spec["parameters"] is awslabs_like["input_schema"]
           or spec["parameters"] == awslabs_like["input_schema"])
    _check("complex schema ships strict=False",
           spec.get("strict") is False)


def test_simple_tool_still_gets_strict_true():
    """Regression guard: don't accidentally drop strict on simple
    tools. The whole reason we set strict explicitly was to prevent
    the model from leaking `to=functions.<tool>` chain-of-thought."""
    print("test_simple_tool_still_gets_strict_true")
    bot_tools = [t for t in _bc._TIER1_TOOLS
                  if t.get("name") in (_bc._TOOL_NAME_DOCS_SEARCH,
                                        _bc._TOOL_NAME_DOCS_READ)]
    fn_tools = _bc._bot_tools_to_openai_function_spec(bot_tools)
    for spec in fn_tools:
        _check(f"[{spec['name']}] still strict=True",
               spec.get("strict") is True)


def main() -> int:
    test_normalizer_adds_additionalProperties_false()
    test_normalizer_promotes_optional_to_required_via_nullable()
    test_normalizer_recurses_into_arrays_of_objects()
    test_normalizer_passes_through_non_objects()
    test_every_tier1_tool_is_strict_compliant()
    test_normalizer_handles_the_real_culprit_schema()
    test_strict_eligibility_predicate()
    test_converter_falls_back_to_best_effort_for_complex_schemas()
    test_simple_tool_still_gets_strict_true()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
