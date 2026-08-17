#!/usr/bin/env python3
"""只读诊断：各端当前生效的是哪一代配置（spec R9.4 / task 9.2）。

要解决的问题：webchat runtime 与 IM bot 都是长驻进程、各自持有独立的 TTL 缓存，所以
「混合态」——几个实例分别停在不同代上——是这套设计的**正常中间态**而非异常。它必然存在，
所以能诊断它比消除它重要。而在这之前根本无法诊断：`config_source()` 有定义但零调用方，
metric 只给计数不给 generation 的值，长驻实例也没有任何对外的管理接口。

机制与本文件要守住的性质：
  * 只在**迁移时**打一行 `llmcfg_status`（首次加载 / generation 变化 / 来源翻转）。
    每轮对话都打会淹掉日志；按代打点才既有时间线又不吵。
  * 单行 JSON —— 多行的话 Logs Insights 筛不出完整记录。
  * **绝不含凭证**（spec R5.5）。这是唯一一条会把配置内容写进日志的路径，最容易顺手
    多带一个字段出去。
  * 关闭态（LLMCFG_ENABLED=0）也要有状态，否则"为什么这端不跟随"恰好在最需要时无解。
  * BFF 侧只能权威回答 DDB 真值那一半，另一半必须给出**查得到**的办法。

Run: PYTHONPATH=. python3 scripts/test_llmcfg_status.py
"""
from __future__ import annotations

import importlib.util
import io
import json
import logging
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
    ("im", os.path.join(ROOT, "core", "llm_config.py")),
    ("webchat", os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app",
                             "NotiOpsWebChat", "core", "llm_config.py")),
)

# 诊断行允许出现的键。白名单式：多一个字段就要在这里过一遍，逼着人想清楚它是否敏感。
_ALLOWED_KEYS = {
    "surface", "enabled_flag", "generation", "source", "default_alias",
    "enabled_models", "credential_mode", "catalog_ttl_s",
    "force_refresh_min_interval_s", "output_target",
}


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


class _Capture(logging.Handler):
    def __init__(self):
        super().__init__(logging.INFO)
        self.lines: list[str] = []

    def emit(self, record):
        self.lines.append(record.getMessage())


def _with_capture(mod, fn):
    """跑 fn，返回它打出的 llmcfg_status 记录（已解析）与原始行。"""
    cap = _Capture()
    logger = logging.getLogger(mod.__name__)
    logger.addHandler(cap)
    logger.setLevel(logging.INFO)
    prev = logger.propagate
    logger.propagate = False
    try:
        fn()
    finally:
        logger.removeHandler(cap)
        logger.propagate = prev
    raw = [l for l in cap.lines if l.startswith("llmcfg_status")]
    parsed = []
    for l in raw:
        try:
            parsed.append(json.loads(l.split(" ", 1)[1]))
        except (IndexError, ValueError):
            parsed.append(None)
    return parsed, raw


def _stub(mod, generation: int | None):
    """generation=None → 让 _fetch 返回 None（来源翻转到 builtin）。"""
    if generation is None:
        mod._fetch = lambda consistent=False: None                    # noqa: SLF001
        return
    mod._fetch = lambda consistent=False: mod._normalise({            # noqa: SLF001
        "generation": generation, "provider": "bedrock", "credential_mode": "iam",
        "default_model": "claude-sonnet-5",
        "models": mod._BUILTIN_CATALOG["models"], "backend_tasks": {},   # noqa: SLF001
    })


# ---------------------------------------------------------------------------
def test_logs_only_on_transition() -> None:
    print("test_logs_only_on_transition")
    for label, path in READERS:
        mod = _load(path, f"_st_tr_{label}")
        mod.reset_cache(); _stub(mod, 1000)

        first, _ = _with_capture(mod, mod.get_config)
        _check(f"{label}: first load logs once", len(first) == 1, str(len(first)))

        # 同一代内反复调用不得再打（否则每轮对话一行，把日志淹掉）。
        # 注意这一条其实是被 TTL 缓存挡住的 —— 缓存命中时根本走不到 _note_status。
        same, _ = _with_capture(mod, lambda m=mod: [m.get_config() for _ in range(10)])
        _check(f"{label}: repeat calls within the same generation log nothing",
               same == [], f"{len(same)} extra line(s)")

        # 去重真正起作用的场景：**TTL 过期后重新取到同一代**。长驻进程每 60s 走一次，
        # 没有去重就变成每分钟一行 × 每个实例，时间线被自己刷没。
        # （第一版漏了这一条：把去重删掉后测试仍全绿，因为上面那条被缓存挡住了。）
        for _ in range(3):
            mod._cached_cfg_ts = 0.0                                  # noqa: SLF001 — 强制过期
            expired, _ = _with_capture(mod, mod.get_config)
            _check(f"{label}: a TTL refresh returning the same generation logs nothing",
                   expired == [], f"{len(expired)} line(s) — dedup is not working")

        # generation 变化 → 打
        mod.reset_cache(); _stub(mod, 2000)
        moved, _ = _with_capture(mod, mod.get_config)
        _check(f"{label}: a generation change logs", len(moved) == 1, str(len(moved)))
        if moved:
            _check(f"{label}: the new generation is in the line",
                   moved[0].get("generation") == 2000, str(moved[0].get("generation")))

        # 来源翻转 ddb → builtin（同样是要看见的时刻）
        mod.reset_cache(); _stub(mod, None)
        flipped, _ = _with_capture(mod, mod.get_config)
        _check(f"{label}: a source flip to builtin logs", len(flipped) == 1, str(len(flipped)))
        if flipped:
            _check(f"{label}: the line says source=builtin",
                   flipped[0].get("source") == "builtin", str(flipped[0].get("source")))


def test_line_is_single_line_json() -> None:
    """多行的话 Logs Insights 筛不出完整记录。"""
    print("test_line_is_single_line_json")
    for label, path in READERS:
        mod = _load(path, f"_st_fmt_{label}")
        mod.reset_cache(); _stub(mod, 1234)
        parsed, raw = _with_capture(mod, mod.get_config)
        _check(f"{label}: exactly one line captured", len(raw) == 1, str(len(raw)))
        if not raw:
            continue
        _check(f"{label}: no embedded newline", "\n" not in raw[0])
        _check(f"{label}: carries the greppable prefix", raw[0].startswith("llmcfg_status "))
        _check(f"{label}: the payload parses as JSON", parsed[0] is not None, raw[0][:120])
        if parsed[0]:
            _check(f"{label}: surface is tagged", parsed[0].get("surface") == label)
            _check(f"{label}: generation is present", parsed[0].get("generation") == 1234)


def test_no_credentials_or_unexpected_keys() -> None:
    """这是唯一会把配置内容写进日志的路径，最容易顺手多带一个字段出去。"""
    print("test_no_credentials_or_unexpected_keys")
    secret = "bedrock-api-key-MUST-NOT-BE-LOGGED"
    for label, path in READERS:
        mod = _load(path, f"_st_sec_{label}")
        mod.reset_cache(); _stub(mod, 7)
        mod._cached_key = secret                                       # noqa: SLF001
        parsed, raw = _with_capture(mod, mod.get_config)
        blob = " ".join(raw)
        _check(f"{label}: no key material in the line", secret not in blob)
        for bad in ("api_key", "bearer", "secretstring", "aws_access_key"):
            _check(f"{label}: no {bad!r} field name in the line",
                   bad not in blob.lower(), blob[:160])
        if parsed and parsed[0]:
            extra = set(parsed[0]) - _ALLOWED_KEYS
            _check(f"{label}: no key outside the reviewed allowlist", not extra,
                   f"new field(s) {sorted(extra)} — confirm they are not sensitive, "
                   f"then add them to _ALLOWED_KEYS")


def test_status_works_when_disabled() -> None:
    """关闭态也要能报状态 —— 「为什么这端不跟随」恰好在最需要时不能无解。"""
    print("test_status_works_when_disabled")
    saved = os.environ.get("LLMCFG_ENABLED")
    try:
        os.environ["LLMCFG_ENABLED"] = "0"
        for label, path in READERS:
            mod = _load(path, f"_st_off_{label}")
            mod._table = lambda: (_ for _ in ()).throw(               # noqa: SLF001
                AssertionError("disabled mode must not read DDB"))
            mod.reset_cache()
            st = mod.status()
            _check(f"{label}: enabled_flag reports False", st["enabled_flag"] is False)
            _check(f"{label}: source is builtin", st["source"] == "builtin", st["source"])
            _check(f"{label}: still names a usable default",
                   bool(st["default_alias"]), st["default_alias"])
            _check(f"{label}: still reports a non-empty enabled set",
                   st["enabled_models"] >= 1, str(st["enabled_models"]))
    finally:
        if saved is None:
            os.environ.pop("LLMCFG_ENABLED", None)
        else:
            os.environ["LLMCFG_ENABLED"] = saved


def test_status_snapshot_matches_effective_config() -> None:
    """status() 必须反映**真正生效**的值，不是重新推一遍。"""
    print("test_status_snapshot_matches_effective_config")
    for label, path in READERS:
        mod = _load(path, f"_st_snap_{label}")
        mod.reset_cache(); _stub(mod, 555)
        cfg = mod.get_config()
        st = mod.status()
        _check(f"{label}: generation matches get_config()",
               st["generation"] == mod._as_int(cfg.get("generation")))      # noqa: SLF001
        _check(f"{label}: source matches config_source()",
               st["source"] == mod.config_source())
        _check(f"{label}: default_alias matches default_alias()",
               st["default_alias"] == mod.default_alias())
        _check(f"{label}: enabled_models matches enabled_entries()",
               st["enabled_models"] == len(mod.enabled_entries()))
        _check(f"{label}: output_target is the per-surface constant",
               st["output_target"] == mod._OUTPUT_TARGET)                   # noqa: SLF001


def test_bff_status_endpoint() -> None:
    """BFF 只能权威回答 DDB 真值那一半；另一半必须给出**查得到**的办法。"""
    print("test_bff_status_endpoint")
    script = r'''
const assert = require("node:assert");
import("./bff/web-chat/llm_config.mjs").then(async (m) => {
  const fake = { async send(cmd) {
    const t = cmd.constructor.name.replace(/Command$/, "");
    if (t === "Get") return { Item: { PK: "llmcfg", SK: "meta", generation: 4242,
      provider: "bedrock", credential_mode: "iam", default_model: "claude-sonnet-5",
      updated_at: "2026-08-01T00:00:00Z", updated_by: "admin@example.com",
      models: [
        { alias: "claude-sonnet-5", model_id: "global.anthropic.claude-sonnet-5",
          label: "Claude Sonnet 5", kind: "bedrock_anthropic", region: null,
          hard_output_limit: 128000, surfaces: ["webchat", "im"], enabled: true, verified: true },
        { alias: "gpt-5-6", model_id: "openai.gpt-5.6-terra", label: "GPT",
          kind: "bedrock_mantle_responses", region: "us-east-2",
          hard_output_limit: 32768, surfaces: ["webchat"], enabled: true, verified: true },
        { alias: "off-one", model_id: "amazon.nova-pro-v1:0", label: "Off",
          kind: "bedrock_converse", region: null, hard_output_limit: 5120,
          surfaces: ["webchat", "im"], enabled: false, verified: true }] } };
    return {};
  } };
  m.__setClients({ ddb: fake, sm: { async send() {
    throw Object.assign(new Error("nf"), { name: "ResourceNotFoundException" }); } } });

  const s = await m.apiGetLlmStatus();

  // The half the BFF can answer authoritatively: DynamoDB truth.
  assert.equal(s.catalogue.generation, 4242);
  assert.equal(s.catalogue.seeded, true);
  assert.equal(s.catalogue.models_total, 3);
  assert.equal(s.catalogue.models_enabled, 2);
  // Split per surface: step one of diagnosing a mixed state is
  // "how many models does THIS surface actually have available".
  assert.equal(s.catalogue.enabled_by_surface.webchat, 2);
  assert.equal(s.catalogue.enabled_by_surface.im, 1);
  assert.equal(s.catalogue.updated_by, "admin@example.com");
  // Credentials: status only, never plaintext.
  assert.equal(s.catalogue.bedrock_api_key.configured, false);
  assert.ok(!JSON.stringify(s).toLowerCase().includes("secretstring"));

  // The BFF's own state — this is what explains why a surface may not be following.
  assert.equal(typeof s.bff.enabled_flag, "boolean");
  assert.ok(s.bff.note && s.bff.note.length > 0);

  // The other half: a runnable query, not "go look at the logs".
  const d = s.per_surface_diagnosis;
  assert.ok(d.logs_insights_query.includes("llmcfg_status"),
            "the query must filter on the marker the readers actually log");
  assert.ok(Array.isArray(d.where_to_look) && d.where_to_look.length >= 3,
            "all three long-lived surfaces must be listed");
  assert.ok(d.metrics_namespace && d.metrics_hint,
            "point at the metric that says a surface is NOT on the DDB catalogue");
  console.log("BFF_STATUS_OK");
});
'''
    # 同下一条：CI 的 python:3.12-slim 没有 node。已原生搬到
    # bff/web-chat/tests/llm_config.test.mjs（"status reports DDB truth ..."）。
    if shutil.which("node") is None:
        print("  (node not on PATH, skipped -- covered natively by "
              "bff/web-chat/tests/llm_config.test.mjs)")
        return
    proc = subprocess.run(["node", "-e", script], cwd=ROOT,
                          capture_output=True, text=True, timeout=90)
    _check("BFF status reports DDB truth + a runnable cross-surface query",
           "BFF_STATUS_OK" in (proc.stdout or ""),
           ((proc.stderr or "") + (proc.stdout or "")).strip()[-400:])


def test_bff_status_is_admin_gated() -> None:
    print("test_bff_status_is_admin_gated")
    script = r'''
const assert = require("node:assert");
import("./bff/web-chat/authz.mjs").then(async (m) => {
  const p = "/api/chat/admin/llm-config/status";
  const viewer = await m.authorize({ method: "GET", path: p, query: {}, body: {} },
                                   { grants: ["nav:chat"], denies: [] }, { disabledModules: [] });
  const admin = await m.authorize({ method: "GET", path: p, query: {}, body: {} },
                                  { grants: ["*"], denies: [] }, { disabledModules: [] });
  assert.equal(viewer.allow, false, "status exposes provider / credential mode / operator name");
  assert.equal(admin.allow, true);
  console.log("GATE_OK");
});
'''
    # 同上。已原生搬到 bff/web-chat/tests/llm_config.test.mjs
    # （"status endpoint is admin-only"）。
    if shutil.which("node") is None:
        print("  (node not on PATH, skipped -- covered natively by "
              "bff/web-chat/tests/llm_config.test.mjs)")
        return
    proc = subprocess.run(["node", "-e", script], cwd=ROOT,
                          capture_output=True, text=True, timeout=60)
    _check("status endpoint is admin-only", "GATE_OK" in (proc.stdout or ""),
           ((proc.stderr or "") + (proc.stdout or "")).strip()[-300:])


def main() -> int:
    test_logs_only_on_transition()
    test_line_is_single_line_json()
    test_no_credentials_or_unexpected_keys()
    test_status_works_when_disabled()
    test_status_snapshot_matches_effective_config()
    test_bff_status_endpoint()
    test_bff_status_is_admin_gated()
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
