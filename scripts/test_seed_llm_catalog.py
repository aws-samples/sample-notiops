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
    """Minimal Table stand-in honouring attribute_not_exists(PK)."""

    def __init__(self, existing: dict | None = None):
        self.item = existing
        self.puts = 0
        self.conditions: list[str] = []

    def put_item(self, **kw):
        self.puts += 1
        cond = kw.get("ConditionExpression")
        if cond:
            self.conditions.append(cond)
        if cond == "attribute_not_exists(PK)" and self.item is not None:
            from botocore.exceptions import ClientError
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException", "Message": "exists"}},
                "PutItem")
        self.item = kw["Item"]
        return {}


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
        ("default disabled", lambda c: c["models"].__setitem__(
            0, {**c["models"][0], "enabled": False})),
        ("duplicate alias", lambda c: c["models"].append(dict(c["models"][0]))),
        ("nothing enabled", lambda c: c.update(
            models=[{**m, "enabled": False} for m in c["models"]])),
        ("a surface left with no model", lambda c: c.update(
            models=[{**m, "surfaces": ["webchat"]} for m in c["models"]])),
    ):
        broken = copy.deepcopy(good)
        mutate(broken)
        # `default disabled` 需要默认项确实是 models[0]
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
    test_setup_sh_wires_it_up()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
