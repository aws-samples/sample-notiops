#!/usr/bin/env python3
"""Seeding contract for the LLM catalogue (`scripts/seed_llm_catalog.py`).

Why this file exists: the seeded item has to satisfy consumers written in two
languages and a validator it never passes through on the way in. Nothing else
checks that.

  * The write goes straight to DynamoDB, bypassing
    `bff/web-chat/llm_config.mjs::validateConfig`.
  * The admin console's first save PUTs back what `GET /admin/llm-config`
    returned — so if the seeded shape cannot pass `validateConfig`, the very
    first edit 400s, and the error points at the config the admin is editing
    rather than at the seed. That already happened twice before seeding existed
    (`short: "gpt_sol"` rejected by the alias regex; `_comment` inside
    `backend_tasks` read as an unknown task name).
    NOTE: that one check needs `node`, which the CI image (python:3.12-slim)
    does not have — it skips there. The equivalent lives in
    `bff/web-chat/tests/llm_config.test.mjs`; see the check itself for why.
  * Both Python readers must be able to `_normalise()` it, including the
    documentation keys having been stripped.

Also pins idempotency: a re-deploy must never overwrite what an administrator
configured in the console.

No AWS calls — DynamoDB is a fake.

Run: PYTHONPATH=. python3 scripts/test_seed_llm_catalog.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from decimal import Decimal

PASS, FAIL = "\u2705", "\u274c"
_failed = 0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

SEED_FILE = os.path.join(ROOT, "config", "llm-model-catalog.json")


def _check(name: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {name}")
    else:
        _failed += 1
        print(f"  {FAIL} {name}" + (f" :: {detail}" if detail else ""))


def _load_seeder():
    spec = importlib.util.spec_from_file_location(
        "seed_llm_catalog", os.path.join(ROOT, "scripts", "seed_llm_catalog.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["seed_llm_catalog"] = mod
    spec.loader.exec_module(mod)
    return mod


class _FakeTable:
    """Minimal Table stand-in honouring attribute_not_exists(PK) and the
    generation condition the top-up path writes with."""

    def __init__(self, existing: dict | None = None):
        self.item = existing
        self.puts = 0
        self.updates = 0
        self.conditions: list[str] = []

    def put_item(self, **kw):
        self.puts += 1
        cond = kw.get("ConditionExpression")
        if cond:
            self.conditions.append(cond)
        if cond == "attribute_not_exists(PK)" and self.item is not None:
            raise self._conflict("PutItem")
        self.item = kw["Item"]
        return {}

    def get_item(self, **_kw):
        return {"Item": self.item} if self.item is not None else {}

    def update_item(self, **kw):
        self.updates += 1
        self.conditions.append(kw.get("ConditionExpression"))
        gen = (self.item or {}).get("generation")
        if gen is not None and int(gen) != 0:
            raise self._conflict("UpdateItem")   # 与真表一致：条件不满足就抛
        # 只应用 UpdateExpression 真的 SET 了的属性 —— 别在这里硬编码 `:m`，
        # 否则"只写 default_model"那条路径在假表上 KeyError，而在真表上好得很。
        names = kw.get("ExpressionAttributeNames") or {}
        values = kw["ExpressionAttributeValues"]
        expr = kw["UpdateExpression"]
        assert expr.startswith("SET "), expr
        applied = {}
        for clause in expr[len("SET "):].split(","):
            lhs, rhs = (part.strip() for part in clause.split("="))
            applied[names.get(lhs, lhs)] = values[rhs]
        self.item = {**(self.item or {}), **applied}
        return {}

    @staticmethod
    def _conflict(op: str):
        from botocore.exceptions import ClientError
        return ClientError(
            {"Error": {"Code": "ConditionalCheckFailedException", "Message": "exists"}}, op)


def _run_seeder(mod, table, argv):
    """Run main() with boto3 stubbed out. Returns the exit code."""
    import boto3

    class _Res:
        def Table(self, _name):
            return table

    real = boto3.resource
    boto3.resource = lambda *a, **k: _Res()
    argv_backup = sys.argv
    sys.argv = ["seed_llm_catalog.py", *argv]
    try:
        return mod.main()
    finally:
        boto3.resource = real
        sys.argv = argv_backup


# ---------------------------------------------------------------------------
def test_seeded_shape_passes_the_server_validator() -> None:
    """The seeded item must satisfy validateConfig, which it never passes through.

    The seeder writes straight to DynamoDB and never goes through the admin PUT
    route, so nothing forces the two to agree. Checking the seed against
    ``validateConfig`` is what keeps them from drifting -- a seed the admin API
    would reject is a seed that produces a state the admin cannot save.

    This briefly needed an exception for "the seeded default model is unverified".
    That exception is gone along with the ``verified`` field itself: the admin route
    no longer gates on a stored flag, it probes the default model live at save time
    (BFF ``probeDefaultModel``). So the seed is once again expected to be a fully
    legal configuration, with no carve-outs.
    """
    print("test_seeded_shape_passes_the_server_validator")
    mod = _load_seeder()
    cfg = mod._load(SEED_FILE)                      # noqa: SLF001

    stale = [m.get("alias") for m in cfg["models"] if "verified" in m]
    _check("seed carries no verified field", not stale, str(stale))

    payload = json.dumps(cfg, default=lambda o: int(o) if isinstance(o, Decimal) else str(o))
    script = (
        'import("./bff/web-chat/llm_config.mjs").then(m=>{'
        'const cfg=JSON.parse(process.argv[1]);'
        'const e=m.validateConfig(cfg);'
        'console.log(e===null?"OK":"ERR:"+e);});'
    )
    # CI 里这一套跑在 llm-catalog-tests（python:3.12-slim），镜像里没有 node ——
    # 没有守卫时是 FileNotFoundError: 'node' 直接崩掉整个 job（真实发生过）。
    # 反向也不成立：跑 node 测试的 bff-tests 用 node:22-alpine，里面没有 python3。
    # 两个 job 各只有一种运行时，所以这条跨语言断言在 CI 里**没有**能落脚的地方。
    #
    # 因此把它原生复刻到了有 validateConfig 的那一侧：
    #   bff/web-chat/tests/llm_config.test.mjs
    #     ::"the seed file passes validation *after* the seeder strips doc keys"
    # 那一条自己剥 `_` 前缀键，覆盖的是同一个形状，且真的会在 CI 跑。
    # 这里保留本条：本地有 node 时它是权威版本（直接用 seeder 自己的 `_load`，
    # 不依赖复刻的剥离逻辑），能抓到两边漂移。
    if shutil.which("node") is None:
        print("  (node not on PATH, skipped -- covered natively by "
              "bff/web-chat/tests/llm_config.test.mjs)")
    else:
        proc = subprocess.run(["node", "-e", script, payload],
                              cwd=ROOT, capture_output=True, text=True, timeout=60)
        out = (proc.stdout or "").strip()
        _check("validateConfig accepts the seeded shape", out == "OK",
               out or (proc.stderr or "").strip()[:200])


def test_documentation_keys_are_stripped() -> None:
    print("test_documentation_keys_are_stripped")
    mod = _load_seeder()
    cfg = mod._load(SEED_FILE)                      # noqa: SLF001
    top = [k for k in cfg if k.startswith("_")]
    _check("no _-prefixed top-level keys", not top, str(top))
    inner = [k for e in cfg["models"] for k in e if k.startswith("_")]
    _check("no _-prefixed keys inside model entries", not inner, str(inner))
    raw = json.load(open(SEED_FILE))
    _check("the source file really has some (otherwise this is vacuous)",
           any(k.startswith("_") for k in raw)
           or any(k.startswith("_") for e in raw["models"] for k in e))


def test_no_floats_reach_dynamodb() -> None:
    """DynamoDB rejects Python floats; the loader must parse numbers as Decimal."""
    print("test_no_floats_reach_dynamodb")
    mod = _load_seeder()
    cfg = mod._load(SEED_FILE)                      # noqa: SLF001

    def has_float(o):
        if isinstance(o, float):
            return True
        if isinstance(o, dict):
            return any(has_float(v) for v in o.values())
        if isinstance(o, list):
            return any(has_float(v) for v in o)
        return False

    _check("no float anywhere in the loaded config", not has_float(cfg))


def test_both_readers_normalise_the_seeded_item() -> None:
    print("test_both_readers_normalise_the_seeded_item")
    mod = _load_seeder()
    cfg = mod._load(SEED_FILE)                      # noqa: SLF001
    item = {**cfg, "PK": "llmcfg", "SK": "meta"}

    for label, path in (
        ("im", os.path.join(ROOT, "core", "llm_config.py")),
        ("webchat", os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                                 "NotiOpsWebChat", "core", "llm_config.py")),
    ):
        if not os.path.exists(path):
            print(f"  (reader for {label} not present, skipped)")
            continue
        name = f"_llmcfg_{label}"
        spec = importlib.util.spec_from_file_location(name, path)
        reader = importlib.util.module_from_spec(spec)
        # 必须先注册进 sys.modules：模块里的 @dataclass 会通过 cls.__module__ 反查
        # 自己所在模块的命名空间，未注册时 exec_module 直接 AttributeError。
        # 同 scripts/test_llm_config_reader.py::_load 的做法。
        sys.modules[name] = reader
        spec.loader.exec_module(reader)
        norm = reader._normalise(item)              # noqa: SLF001
        _check(f"{label}: normalise succeeds", norm is not None)
        if norm:
            _check(f"{label}: model count survives",
                   len(norm["models"]) >= 1, str(len(norm["models"])))
            _check(f"{label}: default_model survives",
                   norm["default_model"] == cfg["default_model"],
                   f"{norm['default_model']} != {cfg['default_model']}")
            # 短别名必须活着 —— IM 的 `@bot model claude` 与存量偏好行都靠它
            shorts = [m.get("short") for m in norm["models"] if m.get("short")]
            _check(f"{label}: short aliases survive normalisation",
                   len(shorts) >= 4, str(shorts))


def test_sanity_check_catches_a_broken_seed() -> None:
    """A typo in the seed must fail the deploy, not the admin's first edit."""
    print("test_sanity_check_catches_a_broken_seed")
    mod = _load_seeder()
    good = mod._load(SEED_FILE)                     # noqa: SLF001
    _check("the shipped seed passes", mod._sanity_check(good) is None,  # noqa: SLF001
           str(mod._sanity_check(good)))            # noqa: SLF001

    import copy
    for label, mutate in (
        ("empty models", lambda c: c.update(models=[])),
        ("default not in catalogue", lambda c: c.update(default_model="nope")),
        # 必须按 **alias 找到真正的默认项**再关掉它。这里原来写的是 `models[0]`，
        # 那只在"默认模型恰好排在第一个"时才真的触发这条规则 —— default_model 从
        # claude-sonnet-5 换走之后，这个用例就变成了"关掉一个非默认模型，期望被拒绝"，
        # 于是长期假红（`accepted a broken seed`），而它本该守的那条规则反倒没人守。
        ("default disabled", lambda c: c.update(models=[
            {**m, "enabled": False} if m["alias"] == c["default_model"] else m
            for m in c["models"]])),
        ("duplicate alias", lambda c: c["models"].append(dict(c["models"][0]))),
        ("nothing enabled", lambda c: c.update(
            models=[{**m, "enabled": False} for m in c["models"]])),
        ("a surface left with no model", lambda c: c.update(
            models=[{**m, "surfaces": ["webchat"]} for m in c["models"]])),
    ):
        broken = copy.deepcopy(good)
        mutate(broken)
        err = mod._sanity_check(broken)             # noqa: SLF001
        _check(f"rejects: {label}", err is not None, "accepted a broken seed")


def test_idempotent_and_force() -> None:
    print("test_idempotent_and_force")
    mod = _load_seeder()

    fresh = _FakeTable(existing=None)
    rc = _run_seeder(mod, fresh, ["--table", "t", "--region", "us-east-1"])
    _check("fresh table: seeds and exits 0", rc == 0 and fresh.puts == 1, f"rc={rc}")
    _check("fresh table: writes PK=llmcfg / SK=meta",
           fresh.item and fresh.item.get("PK") == "llmcfg" and fresh.item.get("SK") == "meta")
    _check("fresh table: generation starts at 0 (unedited seed)",
           fresh.item.get("generation") == 0, str(fresh.item.get("generation")))
    _check("fresh table: the write is conditional",
           fresh.conditions == ["attribute_not_exists(PK)"], str(fresh.conditions))

    # 管理员已经在控制台里改过 —— 重跑部署绝不能覆盖
    admin_edited = {"PK": "llmcfg", "SK": "meta", "generation": 1760000000000,
                    "default_model": "amazon-nova-pro", "models": []}
    occupied = _FakeTable(existing=dict(admin_edited))
    rc = _run_seeder(mod, occupied, ["--table", "t", "--region", "us-east-1"])
    _check("existing catalogue: exits 0 (a re-deploy is not an error)", rc == 0, f"rc={rc}")
    _check("existing catalogue: left byte-for-byte untouched",
           occupied.item == admin_edited, "the admin's config was overwritten")

    forced = _FakeTable(existing=dict(admin_edited))
    rc = _run_seeder(mod, forced, ["--table", "t", "--region", "us-east-1", "--force"])
    _check("--force overwrites and drops the condition",
           rc == 0 and forced.conditions == [] and forced.item.get("generation") == 0,
           f"rc={rc} conds={forced.conditions}")


def test_tops_up_models_added_after_the_first_deploy() -> None:
    """Models added to the catalogue later must reach already-seeded environments.

    The conditional write makes "already present" the normal path on every
    re-deploy, so before the top-up existed a new catalogue entry simply never
    arrived: the admin console's model table and the chat model picker kept
    showing the old list, with no error anywhere. That is exactly how `zai-glm-5`
    was missing from production a day after being added (2026-08-27).

    The top-up is additive and gated on `generation == 0`: an administrator who
    has saved that page may have dropped a model deliberately, and a deploy
    resurrecting it would be the same defect as overwriting their config.
    """
    print("test_tops_up_models_added_after_the_first_deploy")
    mod = _load_seeder()
    cfg = mod._load(SEED_FILE)                      # noqa: SLF001
    aliases = [m["alias"] for m in cfg["models"]]

    # 老环境：seed 的时候目录里还没有最后那个模型
    stale = {"PK": "llmcfg", "SK": "meta", "generation": 0,
             "default_model": cfg["default_model"],
             "models": [dict(m) for m in cfg["models"][:-1]]}
    table = _FakeTable(existing=dict(stale, models=[dict(m) for m in stale["models"]]))
    rc = _run_seeder(mod, table, ["--table", "t", "--region", "us-east-1"])
    _check("stale catalogue: exits 0", rc == 0, f"rc={rc}")
    _check("stale catalogue: the missing model is added",
           [m["alias"] for m in table.item["models"]] == aliases,
           str([m["alias"] for m in table.item["models"]]))
    _check("stale catalogue: default_model untouched",
           table.item["default_model"] == cfg["default_model"])
    _check("stale catalogue: the top-up write is conditional on generation",
           any("generation = :zero" in (c or "") for c in table.conditions),
           str(table.conditions))

    # 已经齐了 → 一个写都不该有
    complete = _FakeTable(existing={"PK": "llmcfg", "SK": "meta", "generation": 0,
                                    "default_model": cfg["default_model"],
                                    "models": [dict(m) for m in cfg["models"]]})
    rc = _run_seeder(mod, complete, ["--table", "t", "--region", "us-east-1"])
    _check("complete catalogue: no update at all",
           rc == 0 and complete.updates == 0, f"rc={rc} updates={complete.updates}")

    # 管理员改过（generation>0）→ 不补，只提示
    edited = _FakeTable(existing={"PK": "llmcfg", "SK": "meta",
                                  "generation": 1760000000000,
                                  "default_model": cfg["default_model"],
                                  "models": [dict(m) for m in cfg["models"][:-1]]})
    rc = _run_seeder(mod, edited, ["--table", "t", "--region", "us-east-1"])
    _check("admin-edited catalogue: nothing is added back",
           rc == 0 and edited.updates == 0
           and len(edited.item["models"]) == len(cfg["models"]) - 1, f"rc={rc}")

    # 只增不改：库里已有的条目（哪怕被关掉了）逐字段保留，目录里没有的留在末尾
    kept = [dict(m) for m in cfg["models"][:-1]]
    kept[0] = {**kept[0], "enabled": False, "label": "renamed by admin"}
    kept.append({"alias": "custom-model", "enabled": True})
    additive = _FakeTable(existing={"PK": "llmcfg", "SK": "meta", "generation": 0,
                                    "default_model": cfg["default_model"],
                                    "models": kept})
    _run_seeder(mod, additive, ["--table", "t", "--region", "us-east-1"])
    merged = additive.item["models"]
    first = next(m for m in merged if m["alias"] == aliases[0])
    _check("existing entries are copied verbatim (a disabled model stays disabled)",
           first["enabled"] is False and first["label"] == "renamed by admin")
    _check("entries absent from the catalogue survive at the end",
           merged[-1]["alias"] == "custom-model", str([m["alias"] for m in merged]))


def test_follows_default_model_changes_in_the_catalogue() -> None:
    """A changed `default_model` must reach already-seeded environments too.

    2026-09-02 in production: the catalogue's default moved from
    `claude-sonnet-5` to `xai-grok-4-6`. The top-up added `xai-grok-4-6` to the
    model list and the stored `default_model` stayed on Sonnet 5, because the
    write only ever touched `models`. Every other slot -- the
    `/notiops/agent/model_id` SSM parameter, the health-checker's
    `BEDROCK_MODEL_ID` -- had followed the change, so the environment looked
    consistent from the CLI while the web chat still opened on Sonnet 5.

    Note what is NOT being tested: "the newest model wins". The value written is
    the one the catalogue *declares* as its default; a model merely being added
    must still never become the default.
    """
    print("test_follows_default_model_changes_in_the_catalogue")
    mod = _load_seeder()
    cfg = mod._load(SEED_FILE)                      # noqa: SLF001
    seed_default = cfg["default_model"]
    other = next(m["alias"] for m in cfg["models"]
                 if m["alias"] != seed_default and m.get("enabled"))

    # 现网那个形态：模型列表已经齐了，只有 default_model 落后
    drifted = _FakeTable(existing={"PK": "llmcfg", "SK": "meta", "generation": 0,
                                   "default_model": other,
                                   "models": [dict(m) for m in cfg["models"]]})
    rc = _run_seeder(mod, drifted, ["--table", "t", "--region", "us-east-1"])
    _check("drifted default: exits 0", rc == 0, f"rc={rc}")
    _check("drifted default: follows the catalogue",
           drifted.item["default_model"] == seed_default,
           str(drifted.item["default_model"]))
    _check("drifted default: the write is conditional on generation",
           any("generation = :zero" in (c or "") for c in drifted.conditions),
           str(drifted.conditions))
    _check("drifted default: generation stays 0 (still seed-managed)",
           drifted.item.get("generation") == 0, str(drifted.item.get("generation")))
    _check("drifted default: models left byte-for-byte alone",
           [m["alias"] for m in drifted.item["models"]]
           == [m["alias"] for m in cfg["models"]])

    # 管理员**故意**选了别的默认模型 → 升级不许改回来
    admin = _FakeTable(existing={"PK": "llmcfg", "SK": "meta",
                                 "generation": 1760000000000,
                                 "default_model": other,
                                 "models": [dict(m) for m in cfg["models"]]})
    rc = _run_seeder(mod, admin, ["--table", "t", "--region", "us-east-1"])
    _check("admin-chosen default: not overridden by a re-deploy",
           rc == 0 and admin.updates == 0 and admin.item["default_model"] == other,
           f"rc={rc} updates={admin.updates} default={admin.item['default_model']}")

    # 目录默认指向一个 disabled 的模型 → 不写（否则这个 surface 没有可用模型）
    bad = dict(cfg, default_model="deliberately-disabled",
               models=[*[dict(m) for m in cfg["models"]],
                       {"alias": "deliberately-disabled", "enabled": False}])
    item = {"PK": "llmcfg", "SK": "meta", "generation": 0, "default_model": other,
            "models": [dict(m) for m in cfg["models"]]}
    _check("a disabled default is never written",
           mod.default_model_drift(item, bad) is None)
    _check("an unknown default is never written",
           mod.default_model_drift(item, dict(cfg, default_model="no-such-model")) is None)
    _check("no drift when they already agree",
           mod.default_model_drift(dict(item, default_model=seed_default), cfg) is None)


def test_setup_sh_wires_it_up() -> None:
    """setup.sh must actually call the seeder, and tolerate its failure."""
    print("test_setup_sh_wires_it_up")
    src = open(os.path.join(ROOT, "setup.sh"), encoding="utf-8").read()
    _check("setup.sh invokes the seeder", "scripts/seed_llm_catalog.py" in src)
    _check("setup.sh does not use --force (a re-deploy must not clobber)",
           "seed_llm_catalog.py --force" not in src
           and "--force" not in src.split("seed_llm_catalog.py")[1][:200])
    _check("setup.sh guards on python3 being present",
           "command -v python3" in src)


def main() -> int:
    test_seeded_shape_passes_the_server_validator()
    test_documentation_keys_are_stripped()
    test_no_floats_reach_dynamodb()
    test_both_readers_normalise_the_seeded_item()
    test_sanity_check_catches_a_broken_seed()
    test_idempotent_and_force()
    test_tops_up_models_added_after_the_first_deploy()
    test_follows_default_model_changes_in_the_catalogue()
    test_setup_sh_wires_it_up()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
