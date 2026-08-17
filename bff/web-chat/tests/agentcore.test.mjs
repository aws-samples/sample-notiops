/**
 * AgentCore payload 契约单测（纯逻辑，不触网）。
 * 运行：node bff/web-chat/tests/agentcore.test.mjs
 *
 * 只盯一件事：generation 字段的**存在性契约**。
 * runtime 侧 `_sane_generation` 把 0 当合法值（未 seed 的目录 generation 就是 0），
 * 所以「BFF 读目录失败」必须表达为**字段缺席**而不是 0 —— 传 0 会让 runtime 的
 * "与本地缓存不同" 恒真，每条消息都打一次 ConsistentRead，TTL 兜底形同虚设。
 */
import assert from "node:assert/strict";
import { buildRuntimePayload, toSessionId } from "../agentcore.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const BASE = { prompt: "hi", model: "claude-sonnet-5", locale: "zh", now: "2026-07-14" };
/** payload 过一遍 JSON 序列化 —— undefined 的丢弃发生在这一步，必须一起验。 */
const wire = (over = {}) => JSON.parse(JSON.stringify(buildRuntimePayload({ ...BASE, ...over })));

console.log("agentcore — runtime payload contract");

t("a real generation is carried through", () => {
  const p = wire({ generation: 1_760_000_000_000 });
  assert.equal(p.generation, 1_760_000_000_000);
});

t("generation 0 is omitted, not sent as 0", () => {
  const p = wire({ generation: 0 });
  assert.equal("generation" in p, false);
});

t("missing generation is omitted", () => {
  const p = wire({});
  assert.equal("generation" in p, false);
});

t("junk generation is omitted rather than forwarded", () => {
  for (const bad of [undefined, null, "", "abc", NaN, Infinity, -1, -1_760_000_000_000, {}, []]) {
    const p = wire({ generation: bad });
    assert.equal("generation" in p, false, `generation=${JSON.stringify(bad)} leaked`);
  }
});

t("numeric string generation is normalised to a number", () => {
  const p = wire({ generation: "1760000000000" });
  assert.equal(p.generation, 1_760_000_000_000);
});

t("model is passed verbatim (BFF already did admission)", () => {
  assert.equal(wire({ model: "gpt-5-6" }).model, "gpt-5-6");
});

t("defaults stay stable for the untouched fields", () => {
  const p = wire({});
  assert.equal(p.topic, "general");
  assert.equal(p.allowed_accounts, "*");
  assert.equal(p.account_id, "");
  assert.equal(p.skill_id, "");
  assert.equal(p.skill_version, "");
  assert.equal(p.web_search, false);
  assert.equal(p.finops_agent, false);
  assert.equal(p.devops_agent, false);
});

t("boolean flags are coerced, never passed as truthy junk", () => {
  const p = wire({ webSearch: "yes", finopsAgent: 1, devopsAgent: null });
  assert.equal(p.web_search, true);
  assert.equal(p.finops_agent, true);
  assert.equal(p.devops_agent, false);
});

t("session id meets the 33-char runtime minimum", () => {
  assert.ok(toSessionId("c-1").length >= 33);
  assert.ok(toSessionId("").length >= 33);
});

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
