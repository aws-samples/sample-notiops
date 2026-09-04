/**
 * `LLMCFG_ENABLED=0` 在 BFF 侧的语义（spec R9.1）。
 * 运行：node bff/web-chat/tests/llmcfg_disabled.test.mjs
 *
 * BFF 侧的语义与两个 Python 读取器**不同**：只旁路**消费路径**，Admin 读写必须照常
 * 可用。事故中最需要的组合是「消费端先退回内置兜底止血，同时还能改配置把它修对」——
 * 把 Admin 一起关掉就只剩手改 DDB 一条路了。
 *
 * 为什么单独一个文件而不是并进 llm_config.test.mjs：
 * `LLMCFG_ENABLED` 在 llm_config.mjs 里是**模块级 const**（见该文件 :175），import
 * 那一刻就定型了。所以必须在 import 之前设好环境变量，也就必须是独立的进程/文件 ——
 * 同一个进程里没法同时测开和关两种状态。
 *
 * 这套断言原本住在 scripts/test_llmcfg_feature_flag.py，用
 * `subprocess.run(["node", "-e", ...])` fork 出来跑；而那套脚本在 CI 跑的是
 * python:3.12-slim（镜像里没有 node），于是 FileNotFoundError: 'node' 直接崩掉整个
 * job。断言内容全是 BFF 侧的，Python 那边一个字节都没参与，所以正确的位置就是这里。
 * Python 侧仍保留三端读取器的关闭态断言（那部分是真的 Python 代码）。
 */
process.env.LLMCFG_ENABLED = "0";          // ⚠️ 必须在 import 之前

import assert from "node:assert/strict";

const mod = await import("../llm_config.mjs");

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message.split("\n")[0]}`); }
}

const ITEM = {
  PK: "llmcfg", SK: "meta", generation: 42,
  provider: "bedrock", credential_mode: "iam", default_model: "claude-sonnet-5",
  models: [{
    alias: "claude-sonnet-5", model_id: "global.anthropic.claude-sonnet-5",
    label: "Claude Sonnet 5", kind: "bedrock_anthropic", region: null,
    hard_output_limit: 128000, surfaces: ["webchat", "im"], enabled: true,
  }],
};

// 记下每一次 DDB 调用 —— 关闭态的核心断言是「一次都没碰」，所以要数得出来。
const seen = [];
mod.__setClients({
  ddb: { async send(cmd) {
    const kind = cmd.constructor.name.replace(/Command$/, "");
    seen.push(kind);
    if (kind === "Get") return { Item: ITEM };
    if (kind === "Query") return { Items: [] };
    return {};
  } },
  sm: { async send() {
    throw Object.assign(new Error("nf"), { name: "ResourceNotFoundException" });
  } },
});

console.log("LLMCFG_ENABLED=0 — consumers bypassed, admin intact");

await t("/models returns an empty set and never reads DDB", async () => {
  seen.length = 0;
  const models = await mod.apiGetModels("webchat");
  // 空集而不是报错：前端据此保留自己的内置兜底清单。
  assert.deepEqual(models.models, [],
                   "models must be empty so the SPA keeps its builtin list");
  assert.equal(models.generation, 0);
  assert.equal(seen.length, 0, "apiGetModels must not read DDB when disabled");
});

await t("resolveForStream passes the alias through and never reads DDB", async () => {
  seen.length = 0;
  const r = await mod.resolveForStream("whatever", "webchat");
  assert.equal(r.alias, "whatever", "client alias passes through untouched");
  assert.equal(r.generation, 0, "no generation injected");
  assert.equal(r.substituted, false);
  assert.equal(seen.length, 0, "resolveForStream must not read DDB when disabled");
});

// ── Admin 侧：这才是本文件的重点 ──────────────────────────────────────────
// 消费路径关掉了，但配置本身还得能读能改 —— 否则这根回滚拉杆把自救的手也一起绑住了。
await t("admin read still sees the real config (and does hit DDB)", async () => {
  seen.length = 0;
  const cfg = await mod.apiGetLlmConfig();
  assert.equal(cfg.generation, 42, "admin read must still see the real config");
  assert.ok(seen.includes("Get"), "admin read does hit DDB");
});

await t("admin write still works", async () => {
  seen.length = 0;
  const put = await mod.apiPutLlmConfig({
    provider: "bedrock", credential_mode: "iam", default_model: "claude-sonnet-5",
    models: [{
      alias: "claude-sonnet-5", model_id: "global.anthropic.claude-sonnet-5",
      label: "Claude Sonnet 5", kind: "bedrock_anthropic", region: null,
      hard_output_limit: 128000, surfaces: ["webchat", "im"], enabled: true,
    }],
  }, { sub: "u", username: "a" });
  assert.equal(put.error, undefined,
               "admin write must still work: " + JSON.stringify(put));
  assert.ok(put.generation > 0);
});

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
