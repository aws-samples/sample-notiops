"""
IM 默认模型优先级收敛测试（spec task 0.2 / R8.2 验收）。

验收标准：**Admin 在控制台改默认模型后，IM 端实际生效。**

收敛前的链路是 `env DEFAULT_LLM_PROVIDER → SSM /notiops/agent/model_id → 目录常量`，
DDB 目录里的 `default_model` 完全不在链上——admin 改了默认，IM 端毫无反应。
收敛后 `resolve()` 的第三级直接取 DDB 目录的 `default_model`。

同时钉住：
  * chat / dm 偏好仍优先于 admin 默认（用户显式选择不被覆盖）
  * source 三值收敛为 chat / dm / default（"env" 已退场；该值会被插进用户可见文案）
  * DDB 不可用时不抛错（llm_config 内部回退内置目录）
  * 别名桥接：DDB 存规范 alias（claude-sonnet-5），IM 侧消费短别名（claude），
    过渡期由 `_admin_default()` 负责映射（task 4.1 目录 DDB 化后此桥拆除）

不触网：DDB 读取全部 stub。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_llm_default_convergence.py
"""
from __future__ import annotations

import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")
os.environ.setdefault("CONFIG_TABLE", "test-config")

from core import llm_config as _cfg          # noqa: E402
from core import llm_pref_resolver as _pref  # noqa: E402

PASS = "✅"
FAIL = "❌"
_failed = 0

SEED = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


class _FakeConfigTable:
    """DDB stub：返回一个指定 default_model 的 llmcfg item。"""

    def __init__(self, default_model: str, raise_exc: bool = False):
        self.default_model = default_model
        self.raise_exc = raise_exc

    def get_item(self, Key=None, ConsistentRead=False):  # noqa: N803
        if self.raise_exc:
            raise RuntimeError("simulated DDB outage")
        return {"Item": {
            "PK": "llmcfg", "SK": "meta",
            "generation": int(time.time() * 1000),
            "provider": "bedrock",
            "credential_mode": "iam",
            "default_model": self.default_model,
            "models": SEED["models"],
        }}


class _FakeStateTable:
    """core.ddb_state._table stub：可控的 chat/dm 偏好行。"""

    def __init__(self, items: dict | None = None):
        self.items = items or {}

    def get_item(self, Key=None, ConsistentRead=False):  # noqa: N803
        key = Key.get("lookup_key")
        item = self.items.get(key)
        return {"Item": item} if item else {}


def _use_default(alias: str, raise_exc: bool = False) -> None:
    _cfg.reset_cache()
    _cfg._table = lambda: _FakeConfigTable(alias, raise_exc)  # noqa: SLF001


def _use_prefs(items: dict | None = None) -> None:
    _pref.ddb_state._table = _FakeStateTable(items)  # noqa: SLF001


def _im_alias_of(canonical: str) -> str:
    """DDB 规范 alias → 短别名（存量偏好行里存的就是这一种）。

    真实的 `model#chat#*` / `model#dm#*` 行是用户敲 `@bot model claude` 落下的，
    存的是**短**别名。DDB 目录键的是规范别名。测试用它模拟存量数据，验证短别名
    在目录 DDB 化之后仍然能原样往返 —— 若不能，所有历史偏好会静默失效回落默认。
    """
    entry = next((m for m in SEED["models"] if m["alias"] == canonical), None)
    return (entry.get("short") or canonical) if entry else canonical


def _resolves_to(alias: str, canonical: str) -> tuple[bool, str]:
    """`alias` 经 IM 侧 model_catalog 是否解析到 `canonical` 那个模型？

    比别名字符串相等更贴近验收意图：管理员改默认之后，IM **实际调用**的是不是
    他选的那个模型。别名走哪个命名空间（规范/短/legacy）是实现细节 —— 2026-08
    目录 DDB 化后 resolve() 改回规范别名，而这条断言不受影响。
    """
    from core import model_catalog as mc
    seed_entry = next((m for m in SEED["models"] if m["alias"] == canonical), None)
    want = ((seed_entry.get("model_id_override") or {}).get("im")
            or seed_entry["model_id"]) if seed_entry else ""
    got = mc.get(alias).model_id
    return got == want, f"alias={alias} got={got} want={want}"


# ---------------------------------------------------------------------------
def test_admin_default_takes_effect():
    """核心验收：改 DDB default_model → IM resolve() 立即跟随。"""
    print("test_admin_default_takes_effect")
    _use_prefs({})   # 无 chat/dm 偏好
    im_candidates = [m["alias"] for m in SEED["models"]
                     if m["enabled"] and "im" in m["surfaces"]]
    _check("seed has >=2 IM-capable enabled models to switch between",
           len(im_candidates) >= 2, str(im_candidates))

    for canonical in im_candidates[:3]:
        _use_default(canonical)
        alias, source = _pref.resolve(platform="feishu", chat_id="c1",
                                      user_id="u1", is_dm=False)
        ok, detail = _resolves_to(alias, canonical)
        _check(f"admin default {canonical!r} → IM actually calls that model",
               ok, detail)
        _check(f"admin default {canonical!r} → source == 'default'",
               source == "default", f"got={source}")


def test_resolved_alias_is_consumable():
    """resolve() 的返回值必须能被 IM 侧 model_catalog 解析成正确条目
    （别名桥接的意义：否则会静默落回硬编码默认，admin 的选择丢失）。"""
    print("test_resolved_alias_is_consumable")
    from core import model_catalog as mc
    _use_prefs({})
    for canonical in [m["alias"] for m in SEED["models"]
                      if m["enabled"] and "im" in m["surfaces"]][:3]:
        _use_default(canonical)
        alias, _ = _pref.resolve(platform="feishu", chat_id="c1",
                                 user_id="u1", is_dm=False)
        entry = mc.get(alias)
        seed_entry = next(m for m in SEED["models"] if m["alias"] == canonical)
        expect_mid = (seed_entry.get("model_id_override") or {}).get("im") \
            or seed_entry["model_id"]
        _check(f"{canonical}: model_catalog resolves to the intended model",
               entry.model_id == expect_mid,
               f"alias={alias} got={entry.model_id} want={expect_mid}")


def test_user_preference_outranks_admin_default():
    print("test_user_preference_outranks_admin_default")
    im_models = [m for m in SEED["models"] if m["enabled"] and "im" in m["surfaces"]]
    admin_choice, user_choice = im_models[0]["alias"], im_models[1]["alias"]
    user_alias = _im_alias_of(user_choice)
    _use_default(admin_choice)

    # 群偏好
    _use_prefs({f"model#chat#feishu:c1": {"alias": user_alias}})
    alias, source = _pref.resolve(platform="feishu", chat_id="c1",
                                  user_id="u1", is_dm=False)
    _check("chat preference wins over admin default",
           alias == user_alias and source == "chat", f"alias={alias} src={source}")

    # DM 偏好
    _use_prefs({f"model#dm#feishu:u1": {"alias": user_alias}})
    alias, source = _pref.resolve(platform="feishu", chat_id="", user_id="u1", is_dm=True)
    _check("dm preference wins over admin default",
           alias == user_alias and source == "dm", f"alias={alias} src={source}")

    # 偏好被清掉 → 回落 admin 默认
    _use_prefs({})
    alias, source = _pref.resolve(platform="feishu", chat_id="c1",
                                  user_id="u1", is_dm=False)
    ok, detail = _resolves_to(alias, admin_choice)
    _check("cleared preference falls back to admin default",
           ok and source == "default", f"{detail} src={source}")


def test_env_source_retired():
    """'env' 不再作为 source 出现（该值会被插进用户可见文案）。"""
    print("test_env_source_retired")
    _use_prefs({})
    for canonical in [m["alias"] for m in SEED["models"]
                      if m["enabled"] and "im" in m["surfaces"]][:2]:
        _use_default(canonical)
        _, source = _pref.resolve(platform="feishu", chat_id="c1",
                                  user_id="u1", is_dm=False)
        _check(f"source is one of chat/dm/default (got {source!r})",
               source in ("chat", "dm", "default"))
    src = open(os.path.join(ROOT, "core", "llm_pref_resolver.py")).read()
    _check("legacy env level removed from code",
           "DEFAULT_LLM_PROVIDER" not in src.split('"""', 2)[2]
           if src.count('"""') >= 2 else True)
    _check("_env_default no longer exists", "_env_default" not in src)


def test_ddb_outage_is_safe():
    print("test_ddb_outage_is_safe")
    _use_prefs({})
    _use_default("claude-sonnet-5", raise_exc=True)
    try:
        alias, source = _pref.resolve(platform="feishu", chat_id="c1",
                                      user_id="u1", is_dm=False)
        _check("DDB outage does not raise", True)
        _check("DDB outage still yields a usable alias", bool(alias), repr(alias))
        _check("DDB outage source is default", source == "default", source)
        from core import model_catalog as mc
        _check("fallback alias resolves in model_catalog",
               mc.get(alias).model_id != "")
    except Exception as e:  # noqa: BLE001
        _check("DDB outage does not raise", False, repr(e))


def main() -> int:
    test_admin_default_takes_effect()
    test_resolved_alias_is_consumable()
    test_user_preference_outranks_admin_default()
    test_env_source_retired()
    test_ddb_outage_is_safe()
    _cfg.reset_cache()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
