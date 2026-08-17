#!/usr/bin/env python3
"""Metric emission for the model catalogue (spec R9.5 / task 6.4).

Every degradation in `llm_config` is silent by design — DynamoDB unreachable
falls back to the builtin catalogue, a retired model is swapped for the default,
a 401 drops back to the IAM role. Chat keeps working, one WARN goes to the log,
and nobody greps for it. "Every surface is running on the builtin catalogue"
is in fact the *default* state of a fresh deploy (before the catalogue is
seeded), which is exactly the state that most needs to be visible.

What this file pins:
  * the four spec'd signals actually fire, at the right moments, and NOT at the
    wrong ones (a metric that also counts the happy path is a traffic counter);
  * the emitted line is valid EMF — CloudWatch extracts nothing from a
    near-miss, and the failure is silent, so a shape regression would look like
    "the metric just isn't there";
  * dimension cardinality stays bounded. Putting `alias` or `model_id` in a
    dimension is billed per combination and blows up the metric count; those
    belong in non-dimension fields;
  * emission never raises. Observability must not become a new failure mode;
  * no credential material is ever in a metric line (spec R5.5).

Run: PYTHONPATH=. python3 scripts/test_llm_metrics.py
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import sys
from contextlib import redirect_stdout

PASS, FAIL = "\u2705", "\u274c"
_failed = 0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

READERS = (
    ("im", os.path.join(ROOT, "core", "llm_config.py")),
    ("webchat", os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                             "NotiOpsWebChat", "core", "llm_config.py")),
)

# Dimensions must stay low-cardinality. This is the allowlist; anything else
# appearing as a dimension is a cost/limit bug, not a style preference.
_ALLOWED_DIMENSIONS = {"Surface", "reason", "requested_kind"}


def _check(name: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {name}")
    else:
        _failed += 1
        print(f"  {FAIL} {name}" + (f" :: {detail}" if detail else ""))


def _load(path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def _capture(fn) -> list[dict]:
    """Run `fn`, returning the EMF lines it printed (non-JSON lines ignored)."""
    buf = io.StringIO()
    with redirect_stdout(buf):
        fn()
    out = []
    for line in buf.getvalue().splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict) and "_aws" in obj:
            out.append(obj)
    return out


def _assert_valid_emf(label: str, rec: dict, surface: str) -> None:
    """The EMF shape rules that decide whether CloudWatch extracts anything."""
    aws = rec.get("_aws") or {}
    _check(f"{label}: has _aws.Timestamp in ms", isinstance(aws.get("Timestamp"), int)
           and aws["Timestamp"] > 1_600_000_000_000, str(aws.get("Timestamp")))
    defs = aws.get("CloudWatchMetrics") or []
    _check(f"{label}: exactly one metric directive", len(defs) == 1, str(len(defs)))
    if not defs:
        return
    d = defs[0]
    _check(f"{label}: namespace is set", bool(d.get("Namespace")), str(d.get("Namespace")))
    metrics = d.get("Metrics") or []
    _check(f"{label}: declares exactly one metric", len(metrics) == 1, str(metrics))
    if metrics:
        mname = metrics[0].get("Name")
        _check(f"{label}: unit is Count", metrics[0].get("Unit") == "Count",
               str(metrics[0].get("Unit")))
        # 最容易错的一条：指标名必须**同时**作为顶层字段存在，否则 CloudWatch 什么都抽不到
        _check(f"{label}: the metric name is also a top-level field",
               mname in rec, f"{mname} missing from {sorted(rec)}")
        _check(f"{label}: its value is numeric", isinstance(rec.get(mname), (int, float)),
               repr(rec.get(mname)))
    dims = d.get("Dimensions") or []
    _check(f"{label}: one dimension set", len(dims) == 1, str(dims))
    if dims:
        names = dims[0]
        # 每个维度名都必须作为顶层字段出现，否则该维度被丢弃
        missing = [n for n in names if n not in rec]
        _check(f"{label}: every dimension has a matching field", not missing, str(missing))
        _check(f"{label}: Surface dimension present and correct",
               rec.get("Surface") == surface, f"{rec.get('Surface')} != {surface}")
        extra = set(names) - _ALLOWED_DIMENSIONS
        _check(f"{label}: no high-cardinality dimension", not extra,
               f"unexpected dimensions {sorted(extra)} — these are billed per combination")


# ---------------------------------------------------------------------------
def test_emf_shape_and_cardinality() -> None:
    print("test_emf_shape_and_cardinality")
    for surface, path in READERS:
        if not os.path.exists(path):
            print(f"  (reader for {surface} not present, skipped)")
            continue
        mod = _load(path, f"_m_{surface}")
        recs = _capture(lambda m=mod: m._emit("FallbackBuiltin", reason="not_seeded"))  # noqa: SLF001
        _check(f"{surface}: emits exactly one line", len(recs) == 1, str(len(recs)))
        if recs:
            _assert_valid_emf(surface, recs[0], surface)
            _check(f"{surface}: the line is a single log event (no embedded newline)",
                   "\n" not in json.dumps(recs[0], separators=(",", ":")))


def _assert_dimensions_bounded(label: str, recs: list[dict]) -> None:
    """维度白名单必须对**每一条**发出的指标行成立，不只是一条探针。

    第一版只在一个探针上检查，于是把 alias 塞进维度的回归没被抓到 —— 而这正是最容易
    发生的那种改动（"顺手把 alias 加上，排障方便"）。CloudWatch 按维度组合计费，
    alias 作维度会让指标数随模型数与用户输入增长。
    """
    for rec in recs:
        for d in rec.get("_aws", {}).get("CloudWatchMetrics", []):
            for names in d.get("Dimensions", []):
                extra = set(names) - _ALLOWED_DIMENSIONS
                _check(f"{label}: dimensions stay bounded", not extra,
                       f"unexpected dimensions {sorted(extra)} — billed per combination")


def test_all_four_signals_fire_at_the_right_moment() -> None:
    print("test_all_four_signals_fire_at_the_right_moment")
    mod = _load(READERS[0][1], "_m_signals")
    seen_all: list[dict] = []

    def names(fn):
        recs = _capture(fn)
        seen_all.extend(recs)
        return sorted({d["_aws"]["CloudWatchMetrics"][0]["Metrics"][0]["Name"]
                       for d in recs})

    # 1) 目录未 seed → FallbackBuiltin(reason=not_seeded)
    mod.reset_cache()
    mod._table = lambda: type("T", (), {"get_item": lambda *a, **k: {}})()  # noqa: SLF001
    recs = _capture(mod.get_config)
    seen_all.extend(recs)
    got = [r for r in recs if "FallbackBuiltin" in r]
    _check("unseeded catalogue emits FallbackBuiltin", bool(got), str(names(mod.get_config)))
    _check("...with reason=not_seeded",
           bool(got) and got[0].get("reason") == "not_seeded",
           got[0].get("reason") if got else "")

    # 2) DDB 读失败 → FallbackBuiltin(reason=read_error)
    mod.reset_cache()

    def boom():
        raise RuntimeError("ddb down")

    mod._table = boom                                     # noqa: SLF001
    recs = _capture(mod.get_config)
    seen_all.extend(recs)
    got = [r for r in recs if "FallbackBuiltin" in r]
    _check("a failed read emits FallbackBuiltin", bool(got))
    _check("...with reason=read_error",
           bool(got) and got[0].get("reason") == "read_error",
           got[0].get("reason") if got else "")

    # 3) 被下架的模型 → ModelSubstituted；而未指定模型（走默认）**不得**计数
    mod.reset_cache()
    mod._fetch = lambda consistent=False: mod._normalise({  # noqa: SLF001
        "generation": 1, "provider": "bedrock", "credential_mode": "iam",
        "default_model": "claude-sonnet-5",
        "models": mod._BUILTIN_CATALOG["models"], "backend_tasks": {},   # noqa: SLF001
    })
    mod.get_config()
    _check("an unknown alias emits ModelSubstituted",
           "ModelSubstituted" in names(lambda: mod.resolve("no-such-model")))
    _check("an EMPTY alias does NOT (that is the plain default path)",
           "ModelSubstituted" not in names(lambda: mod.resolve("")),
           "counting the happy path turns this into a traffic counter")
    _check("a valid alias does NOT",
           "ModelSubstituted" not in names(lambda: mod.resolve("claude")))

    # 4) Key 401 → KeyAuthFail
    _check("invalidate_api_key emits KeyAuthFail",
           "KeyAuthFail" in names(mod.invalidate_api_key))

    # 维度白名单对本函数里发出的**每一条**行成立
    _assert_dimensions_bounded("signals", seen_all)
    _check("the signals test actually captured lines (otherwise vacuous)",
           len(seen_all) >= 4, str(len(seen_all)))


def test_refresh_failure_is_distinguishable() -> None:
    """强刷失败要能与普通 TTL 读失败区分：它之后有一整个限速窗口拿不到新配置。"""
    print("test_refresh_failure_is_distinguishable")
    mod = _load(READERS[0][1], "_m_refresh")
    mod.reset_cache()
    ok = {"generation": 1000, "provider": "bedrock", "credential_mode": "iam",
          "default_model": "claude-sonnet-5",
          "models": mod._BUILTIN_CATALOG["models"], "backend_tasks": {}}   # noqa: SLF001
    mod._fetch = lambda consistent=False: mod._normalise(ok)               # noqa: SLF001
    mod.get_config()                                                       # 预热

    mod._fetch = lambda consistent=False: None                             # noqa: SLF001
    mod._last_forced_refresh_ts = 0.0                                      # noqa: SLF001
    recs = _capture(lambda: mod.get_config(2000))          # generation 不同 → 强刷
    got = [r for r in recs if "RefreshFail" in r]
    _check("a failed forced refresh emits RefreshFail", bool(got),
           str([sorted(r) for r in recs]))


def test_emission_never_raises_and_can_be_disabled() -> None:
    print("test_emission_never_raises_and_can_be_disabled")
    mod = _load(READERS[0][1], "_m_safe")

    class _Unserialisable:
        def __repr__(self):
            raise RuntimeError("boom")

    try:
        _capture(lambda: mod._emit("X", value=_Unserialisable()))          # noqa: SLF001
        _check("an unserialisable value does not raise", True)
    except Exception as e:  # noqa: BLE001
        _check("an unserialisable value does not raise", False, repr(e))

    saved = mod._METRICS_ENABLED                                           # noqa: SLF001
    try:
        mod._METRICS_ENABLED = False                                       # noqa: SLF001
        _check("LLMCFG_METRICS=0 silences emission",
               _capture(lambda: mod._emit("FallbackBuiltin")) == [])       # noqa: SLF001
    finally:
        mod._METRICS_ENABLED = saved                                       # noqa: SLF001


def test_no_credential_material_in_metric_lines() -> None:
    """KeyAuthFail 是唯一与凭证相关的信号 —— 它绝不能携带 Key 的任何片段（spec R5.5）。"""
    print("test_no_credential_material_in_metric_lines")
    mod = _load(READERS[0][1], "_m_secret")
    secret = "bedrock-api-key-SHOULD-NEVER-APPEAR"
    mod._cached_key = secret                                               # noqa: SLF001
    recs = _capture(mod.invalidate_api_key)
    blob = json.dumps(recs)
    _check("no key material in the emitted line", secret not in blob)
    _check("no obvious credential field names either",
           not any(k.lower() in blob.lower()
                   for k in ("api_key", "bearer", "secretstring")), blob[:200])


def test_bff_emitter_matches_the_python_one() -> None:
    """BFF 侧是另一种语言的实现，namespace 与 EMF 形状必须一致，否则指标割裂成两套。"""
    print("test_bff_emitter_matches_the_python_one")
    src = open(os.path.join(ROOT, "bff", "web-chat", "llm_config.mjs"),
               encoding="utf-8").read()
    py = open(READERS[0][1], encoding="utf-8").read()
    _check("BFF has an emit() helper", "function emit(" in src)
    for needle in ("NotiOps/LLMConfig", "CloudWatchMetrics", '"Count"', "_aws"):
        _check(f"BFF emitter contains {needle}", needle in src)
    _check("both sides default to the same namespace",
           "NotiOps/LLMConfig" in py and "NotiOps/LLMConfig" in src)
    _check("BFF tags its own surface", 'Surface: "bff"' in src)
    _check("BFF emits ModelSubstituted where substitution happens",
           'emit("ModelSubstituted"' in src)
    # 高基数字段必须走非维度参数（emit 的第 4 个参数），不能进维度
    i = src.find('emit("ModelSubstituted"')
    call = src[i:i + 220]
    _check("BFF passes alias as a non-dimension field, not a dimension",
           "{}," in call and "requested:" in call, call[:160])


def main() -> int:
    test_emf_shape_and_cardinality()
    test_all_four_signals_fire_at_the_right_moment()
    test_refresh_failure_is_distinguishable()
    test_emission_never_raises_and_can_be_disabled()
    test_no_credential_material_in_metric_lines()
    test_bff_emitter_matches_the_python_one()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
