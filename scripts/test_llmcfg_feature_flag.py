#!/usr/bin/env python3
"""`LLMCFG_ENABLED=0` —— 灰度失败时的回滚拉杆（spec R9.1 / task 6.5）。

这个开关存在的意义是：出问题时不用回滚代码、不用重建镜像，改一个环境变量就能让某一端
退回本 feature 之前的行为。所以要验的**不是**「开关起作用了」，而是两件更强的事：

  1. 关闭态确实 == 旧行为。不是"某种降级"：内置兜底目录与旧的硬编码目录逐字段一致
     （由 test_llm_config_reader::test_builtin_matches_seed 双向校验），所以关掉之后
     短别名、per-model 输出上限、默认模型全都要照旧可用。如果关闭态自己也是坏的，
     这个拉杆在事故里就是空的。
  2. 关闭态**完全不做 IO**。DDB 与 Secrets Manager 一次都不能碰 —— 如果 DDB 正是故障源
     （限流、权限被改坏），一个还在读它的"关闭态"救不了任何东西。

三端独立也要验：一端关掉不得影响另一端的判断。

BFF 侧语义不同，单独验：只旁路消费路径，**Admin 读写必须照常可用** —— 事故中最需要的
组合是「消费端先退回兜底止血，同时还能改配置把它修对」。

Run: PYTHONPATH=. python3 scripts/test_llmcfg_feature_flag.py
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys

PASS, FAIL = "\u2705", "\u274c"
_failed = 0

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

READERS = (
    ("im", os.path.join(ROOT, "core", "llm_config.py"), 6000),
    ("webchat", os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                             "NotiOpsWebChat", "core", "llm_config.py"), 32768),
)


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


class _CountingTable:
    """任何访问都算一次 IO，并记录下来 —— 关闭态下这个计数必须保持 0。"""

    def __init__(self):
        self.calls = 0

    def get_item(self, **kw):
        self.calls += 1
        return {"Item": {"PK": "llmcfg", "SK": "meta", "generation": 999,
                         "provider": "bedrock", "credential_mode": "api_key",
                         "default_model": "amazon-nova-pro",
                         "models": [{"alias": "amazon-nova-pro",
                                     "model_id": "amazon.nova-pro-v1:0",
                                     "label": "SHOULD NOT BE VISIBLE",
                                     "kind": "bedrock_converse",
                                     "hard_output_limit": 5120,
                                     "surfaces": ["webchat", "im"],
                                     "enabled": True, "verified": True}]}}


# ---------------------------------------------------------------------------
def test_disabled_does_no_io_at_all() -> None:
    print("test_disabled_does_no_io_at_all")
    saved = os.environ.get("LLMCFG_ENABLED")
    try:
        os.environ["LLMCFG_ENABLED"] = "0"
        for label, path, _ in READERS:
            mod = _load(path, f"_ff_off_{label}")
            table = _CountingTable()
            mod._table = lambda t=table: t                      # noqa: SLF001
            secret_reads = {"n": 0}

            def _boom_secret(*a, **k):
                secret_reads["n"] += 1
                raise AssertionError("Secrets Manager must not be touched when disabled")

            mod.boto3 = type("_B", (), {"client": staticmethod(_boom_secret)})()
            mod.reset_cache()

            for _ in range(5):
                cfg = mod.get_config()
            _check(f"{label}: DynamoDB is never read", table.calls == 0,
                   f"{table.calls} read(s) — a 'disabled' surface that still reads DDB "
                   f"cannot rescue a DDB-caused incident")
            _check(f"{label}: source reports builtin",
                   cfg.get("_source") == "builtin", str(cfg.get("_source")))
            _check(f"{label}: the DDB item's content is NOT visible",
                   not any(m.get("label") == "SHOULD NOT BE VISIBLE"
                           for m in cfg.get("models", [])))
            _check(f"{label}: Secrets Manager is never touched",
                   mod.get_bedrock_api_key() is None and secret_reads["n"] == 0,
                   f"{secret_reads['n']} secret read(s)")
    finally:
        if saved is None:
            os.environ.pop("LLMCFG_ENABLED", None)
        else:
            os.environ["LLMCFG_ENABLED"] = saved


def test_disabled_equals_pre_feature_behaviour() -> None:
    """关闭态必须是**可用的旧行为**，不是残缺的降级态。"""
    print("test_disabled_equals_pre_feature_behaviour")
    seed = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))
    saved = os.environ.get("LLMCFG_ENABLED")
    try:
        os.environ["LLMCFG_ENABLED"] = "0"
        for label, path, target in READERS:
            mod = _load(path, f"_ff_old_{label}")
            mod._table = lambda: (_ for _ in ()).throw(                 # noqa: SLF001
                AssertionError("no DDB in disabled mode"))
            mod.reset_cache()

            # 短别名：IM 用户敲的 `@bot model claude` 与存量偏好行都是这一种
            for short in [m["short"] for m in seed["models"]
                          if m.get("short") and label in m["surfaces"] and m["enabled"]]:
                _check(f"{label}: short alias {short!r} still admitted",
                       mod.is_enabled(short))

            # per-model 输出上限：退化成本端统一目标就会重开 2026-06-05 的截断事故
            nova = mod.resolve("nova") if label == "im" else None
            if nova is not None:
                want = (next(m for m in seed["models"] if m["alias"] == "amazon-nova-pro")
                        .get("output_override") or {}).get("im")
                _check("im: nova keeps its own output cap in disabled mode",
                       nova.max_output_tokens == want,
                       f"got={nova.max_output_tokens} want={want}")

            _check(f"{label}: default model resolves",
                   mod.default_alias() == seed["default_model"],
                   f"{mod.default_alias()} != {seed['default_model']}")
            _check(f"{label}: enabled set is non-empty",
                   len(mod.enabled_entries()) >= 1)
            _check(f"{label}: per-surface target still applied",
                   mod._OUTPUT_TARGET == target, str(mod._OUTPUT_TARGET))  # noqa: SLF001

        # IM 的对外契约（model_catalog）在关闭态同样可用 —— platforms 直接依赖它
        from core import model_catalog as mc
        from core import llm_config as im_cfg
        im_cfg.reset_cache()
        _check("im: model_catalog.get() works in disabled mode",
               bool(mc.get("claude").model_id))
        _check("im: @bot model list is non-empty in disabled mode",
               len(mc.all_entries()) >= 1)
    finally:
        if saved is None:
            os.environ.pop("LLMCFG_ENABLED", None)
        else:
            os.environ["LLMCFG_ENABLED"] = saved
        from core import llm_config as im_cfg
        im_cfg.reset_cache()


def test_enabled_is_the_default() -> None:
    """不设环境变量 = 开启。默认关闭会让整个 feature 静默失效。"""
    print("test_enabled_is_the_default")
    saved = os.environ.pop("LLMCFG_ENABLED", None)
    try:
        for label, path, _ in READERS:
            mod = _load(path, f"_ff_def_{label}")
            _check(f"{label}: enabled when the variable is absent",
                   mod._ENABLED is True)                                # noqa: SLF001
        # 只接受明确的关闭值，别的写法（"no" / "off" / 空串）不该意外关掉
        for val, want in (("0", False), ("false", False), ("False", False),
                          ("1", True), ("true", True), ("", True),
                          ("no", True), ("off", True)):
            os.environ["LLMCFG_ENABLED"] = val
            mod = _load(READERS[0][1], f"_ff_val_{val or 'empty'}")
            _check(f"LLMCFG_ENABLED={val!r} → enabled={want}",
                   mod._ENABLED is want, str(mod._ENABLED))             # noqa: SLF001
    finally:
        os.environ.pop("LLMCFG_ENABLED", None)
        if saved is not None:
            os.environ["LLMCFG_ENABLED"] = saved


def test_surfaces_are_independent() -> None:
    """一端关掉不得影响另一端 —— 三个部署单元各读自己的环境变量。"""
    print("test_surfaces_are_independent")
    saved = os.environ.get("LLMCFG_ENABLED")
    try:
        # 同一进程内无法给两个副本设不同的环境变量，所以验的是"开关是**每个模块**在
        # 自己 import 时各自读取的"，而不是某个共享的全局状态。
        os.environ["LLMCFG_ENABLED"] = "0"
        off = _load(READERS[0][1], "_ff_indep_off")
        os.environ["LLMCFG_ENABLED"] = "1"
        on = _load(READERS[1][1], "_ff_indep_on")
        _check("each module captures the flag at its own import",
               off._ENABLED is False and on._ENABLED is True,             # noqa: SLF001
               f"off={off._ENABLED} on={on._ENABLED}")                    # noqa: SLF001
        for label, path, _ in READERS:
            src = open(path, encoding="utf-8").read()
            _check(f"{label}: reads the flag from its own process env",
                   'os.environ.get("LLMCFG_ENABLED"' in src)
    finally:
        os.environ.pop("LLMCFG_ENABLED", None)
        if saved is not None:
            os.environ["LLMCFG_ENABLED"] = saved


def test_bff_bypasses_consumers_but_keeps_admin() -> None:
    """BFF 侧语义不同：只旁路消费路径，Admin 读写照常可用。

    事故中最需要的组合是「消费端先退回兜底止血，同时还能改配置把它修对」。把 Admin
    也一起关掉就只剩手改 DDB 一条路。
    """
    print("test_bff_bypasses_consumers_but_keeps_admin")
    script = r'''
const assert = require("node:assert");
process.env.LLMCFG_ENABLED = "0";
import("./bff/web-chat/llm_config.mjs").then(async (m) => {
  const seen = [];
  const fake = { async send(cmd) {
    const t = cmd.constructor.name.replace(/Command$/, "");
    seen.push(t);
    if (t === "Get") return { Item: { PK: "llmcfg", SK: "meta", generation: 42,
      provider: "bedrock", credential_mode: "iam", default_model: "claude-sonnet-5",
      models: [{ alias: "claude-sonnet-5", model_id: "global.anthropic.claude-sonnet-5",
                 label: "Claude Sonnet 5", kind: "bedrock_anthropic", region: null,
                 hard_output_limit: 128000, surfaces: ["webchat", "im"],
                 enabled: true, verified: true }] } };
    if (t === "Query") return { Items: [] };
    return {};
  } };
  m.__setClients({ ddb: fake, sm: { async send() { throw Object.assign(new Error("nf"), { name: "ResourceNotFoundException" }); } } });

  // Consumer path: bypassed, and must not touch DynamoDB.
  seen.length = 0;
  const models = await m.apiGetModels("webchat");
  assert.deepEqual(models.models, [], "models must be empty so the SPA keeps its builtin list");
  assert.equal(models.generation, 0);
  assert.equal(seen.length, 0, "apiGetModels must not read DDB when disabled");

  seen.length = 0;
  const r = await m.resolveForStream("whatever", "webchat");
  assert.equal(r.alias, "whatever", "client alias passes through untouched");
  assert.equal(r.generation, 0, "no generation injected");
  assert.equal(r.substituted, false);
  assert.equal(seen.length, 0, "resolveForStream must not read DDB when disabled");

  // Admin path: must keep working — that is the whole point of the different
  // semantics on this side (bleed off the consumers, still be able to fix the config).
  seen.length = 0;
  const cfg = await m.apiGetLlmConfig();
  assert.equal(cfg.generation, 42, "admin read must still see the real config");
  assert.ok(seen.includes("Get"), "admin read does hit DDB");

  seen.length = 0;
  const put = await m.apiPutLlmConfig({
    provider: "bedrock", credential_mode: "iam", default_model: "claude-sonnet-5",
    models: [{ alias: "claude-sonnet-5", model_id: "global.anthropic.claude-sonnet-5",
               label: "Claude Sonnet 5", kind: "bedrock_anthropic", region: null,
               hard_output_limit: 128000, surfaces: ["webchat", "im"],
               enabled: true, verified: true }],
  }, { sub: "u", username: "a" });
  assert.equal(put.error, undefined, "admin write must still work: " + JSON.stringify(put));
  assert.ok(put.generation > 0);
  console.log("BFF_OK");
});
'''
    # CI 里本套跑在 python:3.12-slim，镜像内没有 node —— 无守卫时是
    # FileNotFoundError: 'node' 崩掉整个 job（真实发生过）。这段断言的内容全在 BFF 侧，
    # 已原生搬到 bff/web-chat/tests/llmcfg_disabled.test.mjs（那里由 bff-tests 真正执行，
    # 且能在 import 前设好 LLMCFG_ENABLED —— 该标志是模块级 const）。
    # 本地有 node 时仍跑，作为「两处不漂移」的交叉验证。
    if shutil.which("node") is None:
        print("  (node not on PATH, skipped -- covered natively by "
              "bff/web-chat/tests/llmcfg_disabled.test.mjs)")
        return
    proc = subprocess.run(["node", "-e", script], cwd=ROOT,
                          capture_output=True, text=True, timeout=90)
    ok = "BFF_OK" in (proc.stdout or "")
    _check("BFF: consumers bypassed, admin path intact", ok,
           ((proc.stderr or "") + (proc.stdout or "")).strip()[-400:])


def main() -> int:
    test_disabled_does_no_io_at_all()
    test_disabled_equals_pre_feature_behaviour()
    test_enabled_is_the_default()
    test_surfaces_are_independent()
    test_bff_bypasses_consumers_but_keeps_admin()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
