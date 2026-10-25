/**
 * 输出崩坏守卫（agent degeneration.py，待办 #2）在 BFF 这一侧：书签与丢弃。
 * 运行：node bff/web-chat/tests/collapse_discard.test.mjs
 *
 * agent 在每次模型调用开头发 {"call_start": n}；某次调用被判成乱码时发 {"discard": {call, retry, signal}}，
 * 然后自动重试一次。钉三件事：
 *   1. extract 认这两种帧（认不出的不算：老 agent / 乱帧原样放过）；
 *   2. invokeAgent 返回的全文（= 落库的回答）退回书签处，重试那次的输出接着拼；回调拿到退回后的全文；
 *   3. 接线（index.mjs 源码级）：书签与丢弃都转给浏览器，streamedText 跟着退回 —— 否则「流读到一半断了」
 *      那支（turn_errors）会把乱码当成「已推给浏览器的正文」落库。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extract } from "../agentcore.mjs";

let fails = 0;
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}

await t("extract：书签与丢弃帧；认不出的一律不算", () => {
  assert.equal(extract({ call_start: 2 }).callStart, 2);
  assert.deepEqual(extract({ discard: { call: 2, retry: true, signal: "glue" } }).discard, { call: 2, retry: true, signal: "glue" });
  for (const bad of [{ call_start: "2" }, { call_start: 1.5 }, { call_start: true }, {}]) {
    assert.equal(extract(bad).callStart, undefined, JSON.stringify(bad));
  }
  for (const bad of [{ discard: true }, { discard: {} }, { discard: { call: "2" } }, {}]) {
    assert.equal(extract(bad).discard, null, JSON.stringify(bad));
  }
  // 两种帧都不是正文
  assert.equal(extract({ call_start: 1 }).text, "");
  assert.equal(extract({ discard: { call: 1 } }).text, "");
});

const { BedrockAgentCoreClient } = await import("@aws-sdk/client-bedrock-agentcore");
const { invokeAgent } = await import("../agentcore.mjs");
async function runFrames(frames, cbs = {}) {
  const bytes = new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""));
  const orig = BedrockAgentCoreClient.prototype.send;
  BedrockAgentCoreClient.prototype.send = async () => ({ response: (async function* () { yield { chunk: { bytes } }; })() });
  try { return await invokeAgent({ conversationId: "c-collapse-discard", prompt: "p", model: "m", locale: "zh" }, cbs); }
  finally { BedrockAgentCoreClient.prototype.send = orig; }
}
const td = (text) => ({ event: { contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } } });

await t("全文退回书签处，重试那次接着拼；回调拿到书签号与退回后的全文", async () => {
  const seen = [];
  const tokens = [];
  const full = await runFrames([
    { ready: true },
    { call_start: 1 }, td("我先查一下官方文档……"),
    { call_start: 2 }, td("勒-何-时间-唯一-"), td("ex-comp-per-nas"),
    { discard: { call: 2, retry: true, signal: "glue" } },
    { progress: { text: "⚠️ 已丢弃，正在重试…", kind: "status" } },
    { call_start: 3 }, td("结论：nodejs22.x 最先过期。"),
  ], {
    onToken: (d) => tokens.push(d),
    onCallStart: (n) => seen.push(["call", n]),
    onDiscard: (d) => seen.push(["discard", d]),
  });
  assert.equal(full, "我先查一下官方文档……结论：nodejs22.x 最先过期。");
  assert.deepEqual(seen, [["call", 1], ["call", 2],
    ["discard", { call: 2, retry: true, text: "我先查一下官方文档……" }], ["call", 3]]);
  assert.ok(tokens.includes("勒-何-时间-唯一-"), "乱码当时确实推给过浏览器 —— 所以浏览器也要按书签退回");
});

await t("第二次也崩：退回之后接的是 agent 的说明文字，全文里没有乱码", async () => {
  const full = await runFrames([
    { call_start: 1 }, td(" @ @ @ @"),
    { discard: { call: 1, retry: true, signal: "repeat" } },
    { call_start: 2 }, td(" @ @"),
    { discard: { call: 2, retry: false, signal: "repeat" } },
    td("\n\n---\n⚠️ 模型的输出连续两次崩成了乱码，本轮已停止。"),
  ]);
  assert.equal(full, "\n\n---\n⚠️ 模型的输出连续两次崩成了乱码，本轮已停止。");
});

await t("没有书签的丢弃（老 agent / 帧乱序）：原样不动，宁可留着也不乱删", async () => {
  const full = await runFrames([td("正文"), { discard: { call: 9, retry: false } }]);
  assert.equal(full, "正文");
});

const idx = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");

await t("接线：书签转给浏览器；丢弃时 streamedText 跟着退回、再转给浏览器", () => {
  assert.match(idx, /onCallStart: \(call\) => \{ stream\.write\(sse\("call_start", \{ call \}\)\); \}/);
  assert.match(idx, /onDiscard: \(d\) => \{\s*if \(typeof d\?\.text === "string"\) streamedText = d\.text;[\s\S]{0,300}stream\.write\(sse\("discard", \{ call: d\?\.call, retry: d\?\.retry === true \}\)\);/);
});

console.log(`\n${ok} passed, ${fails} failed`);
if (fails) process.exit(1);
