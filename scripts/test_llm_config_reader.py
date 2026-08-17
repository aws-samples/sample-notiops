"""
LLM 目录读取器测试（spec task 1.2 / 1.3 验收）。

覆盖 webchat（agent-build）与 IM（core）两份对等实现的共同契约：

  * generation 校验（R4.2）—— 负数 / 1e308 / 字符串 / None / bool 一律忽略，
    只有合法 epoch-ms（或 seed 的 0）才触发强刷；防被污染的 generation 打成
    DDB 放大读、并防「与本地不同」恒真导致 TTL 兜底失效。
  * 强刷限速（R4.4）
  * 失败安全（R7.1）—— DDB 不可用 / item 缺失 / 结构损坏 → 内置兜底目录
  * 不变量兜底 —— default_model 不存在或未启用时自动落到第一个启用项
  * 启用集准入（R3.5）+ 别名解析（规范 alias / short / legacy）
  * per-surface 解析（R1.4）—— model_id_override 与 output_override 生效
  * 两份实现的内置兜底目录彼此一致、且与 config/llm-model-catalog.json 一致

不触网：所有 DDB / Secrets 调用都被 stub 掉。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_llm_config_reader.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")
os.environ.setdefault("CONFIG_TABLE", "test-config")

PASS = "✅"
FAIL = "❌"
_failed = 0

AGENT_READER = os.path.join(
    ROOT, "agent-build", "NotiOpsWebChat", "app", "NotiOpsWebChat",
    "core", "llm_config.py")
IM_READER = os.path.join(ROOT, "core", "llm_config.py")


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


def _load(path: str, name: str):
    """按文件路径加载模块（两份实现同名，不能靠 import 区分）。"""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


class _FakeTable:
    """最小 DDB Table stub：可控返回 item / 抛异常，并记录 ConsistentRead 次数。"""

    def __init__(self, item=None, raise_exc=False):
        self.item = item
        self.raise_exc = raise_exc
        self.calls = 0
        self.consistent_calls = 0

    def get_item(self, Key=None, ConsistentRead=False):  # noqa: N803 (boto3 signature)
        self.calls += 1
        if ConsistentRead:
            self.consistent_calls += 1
        if self.raise_exc:
            raise RuntimeError("simulated DDB outage")
        return {"Item": self.item} if self.item is not None else {}


def _patch_table(mod, table):
    mod.reset_cache()
    mod._table = lambda: table  # noqa: SLF001 — test seam
    return table


def _now_ms() -> int:
    return int(time.time() * 1000)


def _seed_item(generation=None, default="claude-sonnet-5", models=None):
    """构造一个 DDB item 形态的配置（数值用 int，_as_int 也接受 Decimal）。"""
    seed = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))
    item = {
        "PK": "llmcfg", "SK": "meta",
        "generation": _now_ms() if generation is None else generation,
        "provider": "bedrock",
        "credential_mode": "iam",
        "default_model": default,
        "models": models if models is not None else seed["models"],
        "backend_tasks": {"phd_translate": None, "devops_report_summarize": None},
    }
    return item


# ---------------------------------------------------------------------------
def test_generation_validation(mod, surface):
    print(f"test_generation_validation[{surface}]")
    table = _patch_table(mod, _FakeTable(_seed_item()))
    mod.get_config()                      # 预热缓存
    baseline_calls = table.calls

    # 非法值：一律不得触发强刷（也不得抛错）
    far_future = _now_ms() + 30 * 24 * 3600 * 1000   # 30 天后：超出允许时钟偏移
    for bad in (-1, "abc", None, True, False, 1e308, float("inf"), float("nan"),
                10 ** 20, [], {}, "12.5", far_future):
        before = table.calls
        try:
            mod.get_config(bad)
        except Exception as e:  # noqa: BLE001
            _check(f"illegal generation {bad!r} does not raise", False, repr(e))
            continue
        _check(f"illegal generation {bad!r} triggers no forced read",
               table.calls == before, f"calls {before}->{table.calls}")

    _check("cache still served after illegal input", table.calls == baseline_calls)


def test_forced_refresh_and_rate_limit(mod, surface):
    print(f"test_forced_refresh_and_rate_limit[{surface}]")
    base_gen = _now_ms() - 5000
    table = _patch_table(mod, _FakeTable(_seed_item(generation=base_gen)))
    mod.get_config()
    calls_after_warm = table.calls

    # 不同的合法 generation → 强一致读一次
    next_gen = base_gen + 1000
    table.item = _seed_item(generation=next_gen)
    mod.get_config(next_gen)
    _check("differing generation forces a read",
           table.calls == calls_after_warm + 1, f"calls={table.calls}")
    _check("forced read uses ConsistentRead", table.consistent_calls >= 1)

    # 限速：紧接着再来一个不同 generation，不应再读
    calls_now = table.calls
    mod.get_config(next_gen + 2000)
    _check("second forced refresh is rate-limited",
           table.calls == calls_now, f"calls {calls_now}->{table.calls}")

    # 相同 generation → 不强刷
    calls_now = table.calls
    mod.get_config(mod.generation())
    _check("identical generation triggers no read", table.calls == calls_now)

    # 强刷限速间隔必须**严格小于** TTL。两者相等时，一次强刷之后的整个 TTL 窗口内
    # `fresh` 为真而 `force` 被拒 —— 于是「保存后下一条消息即生效」只在前一个窗口内
    # 没发生过强刷时成立，强刷路径对最坏情况零改善。实测过：连续两次 Admin 保存，
    # 第二次对消费端不可见，要等满 TTL。
    _check("force-refresh interval is strictly below the TTL",
           mod._FORCED_REFRESH_MIN_INTERVAL < mod._CATALOG_TTL,   # noqa: SLF001
           f"force={mod._FORCED_REFRESH_MIN_INTERVAL} ttl={mod._CATALOG_TTL}")  # noqa: SLF001

    # 限速窗口过去之后，第二次保存必须能被看见（这正是「两次连续保存」的场景）。
    mod._last_forced_refresh_ts = 0.0     # noqa: SLF001 — 模拟限速窗口已过
    third_gen = next_gen + 5000
    table.item = _seed_item(generation=third_gen)
    calls_now = table.calls
    mod.get_config(third_gen)
    _check("a later save is picked up once the rate-limit window passes",
           table.calls == calls_now + 1, f"calls {calls_now}->{table.calls}")
    _check("and the newly read generation is the one in effect",
           mod.generation() == third_gen, f"got={mod.generation()} want={third_gen}")


def test_ttl_cache(mod, surface):
    print(f"test_ttl_cache[{surface}]")
    table = _patch_table(mod, _FakeTable(_seed_item()))
    mod.get_config()
    first = table.calls
    for _ in range(5):
        mod.get_config()
    _check("repeat reads within TTL hit cache", table.calls == first,
           f"calls {first}->{table.calls}")


def test_failure_safety(mod, surface):
    print(f"test_failure_safety[{surface}]")
    # DDB 抛异常
    _patch_table(mod, _FakeTable(raise_exc=True))
    cfg = mod.get_config()
    _check("DDB outage falls back to builtin", cfg.get("_source") == "builtin",
           str(cfg.get("_source")))
    _check("builtin still yields a usable default",
           mod.resolve(None).model_id != "")

    # item 缺失
    _patch_table(mod, _FakeTable(item=None))
    _check("missing item falls back to builtin",
           mod.get_config().get("_source") == "builtin")

    # 结构损坏：models 非列表
    _patch_table(mod, _FakeTable(item={"PK": "llmcfg", "SK": "meta", "models": "oops"}))
    _check("malformed models falls back to builtin",
           mod.get_config().get("_source") == "builtin")

    # 部分条目损坏：坏条目被丢弃，好条目保留
    good = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))["models"][0]
    _patch_table(mod, _FakeTable(item=_seed_item(
        default=good["alias"],
        models=[good, {"alias": "", "model_id": "x", "kind": "bogus_kind"}])))
    cfg = mod.get_config()
    _check("malformed entry dropped, good entry kept",
           cfg.get("_source") == "ddb" and len(cfg["models"]) == 1,
           f"source={cfg.get('_source')} n={len(cfg.get('models', []))}")


def test_default_model_invariant(mod, surface):
    print(f"test_default_model_invariant[{surface}]")
    seed = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))
    models = [dict(m) for m in seed["models"] if surface in m["surfaces"]]
    # 默认模型指向不存在的 alias → 自动落到第一个启用项
    _patch_table(mod, _FakeTable(_seed_item(default="does-not-exist", models=models)))
    cfg = mod.get_config()
    _check("nonexistent default_model repaired",
           cfg["default_model"] in [m["alias"] for m in models if m["enabled"]],
           cfg["default_model"])

    # 默认模型存在但被禁用 → 同样修复
    models2 = [dict(m) for m in models]
    models2[0] = {**models2[0], "enabled": False}
    _patch_table(mod, _FakeTable(_seed_item(default=models2[0]["alias"], models=models2)))
    cfg = mod.get_config()
    _check("disabled default_model repaired",
           cfg["default_model"] != models2[0]["alias"], cfg["default_model"])


def test_admission_and_alias_resolution(mod, surface):
    print(f"test_admission_and_alias_resolution[{surface}]")
    seed = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))
    _patch_table(mod, _FakeTable(_seed_item()))

    canonical = next(m for m in seed["models"]
                     if m["enabled"] and surface in m["surfaces"] and m.get("short"))
    _check(f"canonical alias {canonical['alias']!r} admitted",
           mod.is_enabled(canonical["alias"]))
    _check(f"short alias {canonical['short']!r} admitted",
           mod.is_enabled(canonical["short"]))
    for legacy in canonical.get("aliases_legacy", []):
        _check(f"legacy alias {legacy!r} admitted", mod.is_enabled(legacy))
    _check("unknown alias rejected", not mod.is_enabled("us.anthropic.claude-x"))
    _check("empty alias rejected", not mod.is_enabled(""))
    _check("None alias rejected", not mod.is_enabled(None))

    # 禁用条目不得进启用集
    disabled = [m for m in seed["models"] if not m["enabled"]]
    for m in disabled:
        _check(f"disabled {m['alias']!r} not admitted", not mod.is_enabled(m["alias"]))

    # 别名解析到同一条目
    r_canon = mod.resolve(canonical["alias"])
    r_short = mod.resolve(canonical["short"])
    _check("short alias resolves to same model",
           r_canon.model_id == r_short.model_id and r_canon.alias == r_short.alias)

    # 不在启用集 → 回退默认 + 标记替换
    fallback = mod.resolve("us.anthropic.claude-x")
    _check("unknown alias falls back to default",
           fallback.alias == mod.default_alias(), fallback.alias)
    _check("substitution is reported", mod.was_substituted("us.anthropic.claude-x"))
    _check("valid alias reports no substitution",
           not mod.was_substituted(canonical["alias"]))


def test_per_surface_resolution(mod, surface, output_target):
    print(f"test_per_surface_resolution[{surface}]")
    seed = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))
    _patch_table(mod, _FakeTable(_seed_item()))

    for m in seed["models"]:
        if surface not in m["surfaces"] or not m["enabled"]:
            continue
        r = mod.resolve(m["alias"])
        expect_mid = (m.get("model_id_override") or {}).get(surface) or m["model_id"]
        _check(f"{m['alias']}: model_id per surface", r.model_id == expect_mid,
               f"got={r.model_id} want={expect_mid}")
        ov = (m.get("output_override") or {}).get(surface)
        expect_out = ov if ov is not None else min(m["hard_output_limit"], output_target)
        _check(f"{m['alias']}: output cap {r.max_output_tokens} == {expect_out}",
               r.max_output_tokens == expect_out)
        _check(f"{m['alias']}: prompt cache flag",
               r.supports_prompt_cache == m["supports_prompt_cache"])
        if m["kind"] == "bedrock_mantle_responses":
            _check(f"{m['alias']}: mantle flagged and region carried",
                   r.is_mantle and r.region == m["region"])
        else:
            _check(f"{m['alias']}: not flagged mantle", not r.is_mantle)

    # 本端不支持的模型不得出现在启用集
    other = "im" if surface == "webchat" else "webchat"
    only_other = [m for m in seed["models"]
                  if surface not in m["surfaces"] and other in m["surfaces"]]
    for m in only_other:
        _check(f"{m['alias']} (other-surface only) not admitted",
               not mod.is_enabled(m["alias"]))


def test_backend_task_alias(mod, surface):
    print(f"test_backend_task_alias[{surface}]")
    seed = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))
    enabled = next(m["alias"] for m in seed["models"]
                   if m["enabled"] and surface in m["surfaces"])
    item = _seed_item()
    item["backend_tasks"] = {"phd_translate": enabled,
                             "devops_report_summarize": "not-a-model"}
    _patch_table(mod, _FakeTable(item))
    _check("configured backend task alias honoured",
           mod.backend_task_alias("phd_translate") == enabled)
    _check("invalid backend task alias falls back to default",
           mod.backend_task_alias("devops_report_summarize") == mod.default_alias())
    _check("unset backend task falls back to default",
           mod.backend_task_alias("nope") == mod.default_alias())


def test_api_key_gating(mod, surface):
    print(f"test_api_key_gating[{surface}]")
    item = _seed_item()
    item["credential_mode"] = "iam"
    _patch_table(mod, _FakeTable(item))
    _check("credential_mode=iam yields no key (never reads Secrets)",
           mod.get_bedrock_api_key() is None)

    item2 = _seed_item()
    item2["credential_mode"] = "api_key"
    _patch_table(mod, _FakeTable(item2))
    _check("credential_mode reported as api_key", mod.credential_mode() == "api_key")
    # 不 stub secretsmanager：读取必然失败 → 必须回退 None 而非抛错
    try:
        got = mod.get_bedrock_api_key()
        _check("secret read failure degrades to None (IAM fallback)", got is None, repr(got))
    except Exception as e:  # noqa: BLE001
        _check("secret read failure does not raise", False, repr(e))
    mod.invalidate_api_key()
    _check("invalidate_api_key is safe to call", True)


def test_builtin_matches_seed(mod, surface):
    """两份实现的内置兜底必须与规范种子一致（避免兜底态与正常态行为漂移）。"""
    print(f"test_builtin_matches_seed[{surface}]")
    seed = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))
    seed_by_alias = {m["alias"]: m for m in seed["models"]}
    builtin = {m["alias"]: m for m in mod._BUILTIN_CATALOG["models"]}  # noqa: SLF001

    _check("builtin default_model matches seed",
           mod._BUILTIN_CATALOG["default_model"] == seed["default_model"])  # noqa: SLF001
    _check("builtin covers every seed model",
           set(builtin) == set(seed_by_alias),
           f"missing={set(seed_by_alias) - set(builtin)} extra={set(builtin) - set(seed_by_alias)}")
    for alias, b in builtin.items():
        s = seed_by_alias.get(alias)
        if not s:
            continue
        # 兜底目录内嵌的是**本端已解析**的 model_id，故与种子的 surface 解析值比较。
        # 目前没有任何条目用 model_id_override（IM 曾对 Claude 用 us.* profile，
        # 2026-07 已统一到 global.*），但保留这层解析：将来真有单端例外时本测试仍成立。
        expect_mid = (s.get("model_id_override") or {}).get(surface) or s["model_id"]
        _check(f"{alias}.model_id matches seed (surface-resolved)",
               b.get("model_id") == expect_mid,
               f"builtin={b.get('model_id')} seed={expect_mid}")
        for field in ("label", "kind", "region",
                      "hard_output_limit", "supports_prompt_cache", "enabled"):
            _check(f"{alias}.{field} matches seed", b.get(field) == s.get(field),
                   f"builtin={b.get(field)} seed={s.get(field)}")
        _check(f"{alias}.surfaces matches seed",
               sorted(b.get("surfaces", [])) == sorted(s.get("surfaces", [])))
        # short / aliases_legacy / output_override 曾被从兜底目录里漏掉（只在 DDB
        # 不可达时暴露）：短别名 `@bot model nova` 当场全部失效，per-model 上限退化成
        # 本端统一目标（nova 5000→6000，来源块被截断）。这三条把它钉住。
        _check(f"{alias}.short matches seed",
               (b.get("short") or None) == (s.get("short") or None),
               f"builtin={b.get('short')!r} seed={s.get('short')!r}")
        _check(f"{alias}.aliases_legacy matches seed",
               sorted(b.get("aliases_legacy") or []) == sorted(s.get("aliases_legacy") or []),
               f"builtin={b.get('aliases_legacy')} seed={s.get('aliases_legacy')}")
        _check(f"{alias}.output_override matches seed",
               (b.get("output_override") or {}) == (s.get("output_override") or {}),
               f"builtin={b.get('output_override')} seed={s.get('output_override')}")


def test_no_cross_surface_model_id_drift(resolved: dict[str, dict[str, str]]) -> None:
    """一个 alias 在所有端必须解析到**同一个** model_id。

    IM 曾对 Claude 用 `us.*` inference profile 而 webchat 用 `global.*`，于是
    "claude-sonnet-5" 在两端其实是两种地理路由 —— 同名不同物，用户和审计都看不出来。
    2026-07 裁决统一到 `global.*`。这条断言把它钉住：谁想再引入 per-surface 的
    model_id_override，必须先让本测试失败、从而被迫走一次数据驻留决策。
    """
    print("test_no_cross_surface_model_id_drift")
    if len(resolved) < 2:
        print("  (only one surface loaded, skipped)")
        return
    (s1, m1), (s2, m2) = list(resolved.items())[:2]
    for alias in sorted(set(m1) | set(m2)):
        a, b = m1.get(alias), m2.get(alias)
        if a is None or b is None:
            continue  # 该 alias 不在两端都启用，属正常
        _check(f"{alias} resolves identically on {s1} and {s2}", a == b,
               f"{s1}={a} {s2}={b}")


def main() -> int:
    surfaces = [
        ("webchat", AGENT_READER, "llm_config_webchat", 32768),
        ("im", IM_READER, "llm_config_im", 6000),
    ]
    resolved_by_surface: dict[str, dict[str, str]] = {}
    for surface, path, modname, target in surfaces:
        if not os.path.exists(path):
            print(f"\n--- {surface}: {os.path.relpath(path, ROOT)} not present yet, skipped ---")
            continue
        print(f"\n=== reader: {os.path.relpath(path, ROOT)} (surface={surface}) ===")
        mod = _load(path, modname)
        _check("surface constant matches file location", mod._SURFACE == surface,  # noqa: SLF001
               mod._SURFACE)  # noqa: SLF001
        test_generation_validation(mod, surface)
        test_forced_refresh_and_rate_limit(mod, surface)
        test_ttl_cache(mod, surface)
        test_failure_safety(mod, surface)
        test_default_model_invariant(mod, surface)
        test_admission_and_alias_resolution(mod, surface)
        test_per_surface_resolution(mod, surface, target)
        test_backend_task_alias(mod, surface)
        test_api_key_gating(mod, surface)
        test_builtin_matches_seed(mod, surface)
        resolved_by_surface[surface] = {
            m["alias"]: m["model_id"] for m in mod._BUILTIN_CATALOG["models"]  # noqa: SLF001
        }
        mod.reset_cache()

    test_no_cross_surface_model_id_drift(resolved_by_surface)

    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
