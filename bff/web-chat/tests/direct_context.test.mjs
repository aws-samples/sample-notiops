/**
 * 「直连那几轮 agent 看不见」（待办 #33）：BFF 挑出 agent 没见过的直连轮次带给它。
 *
 * 背景：2026-10-21 现网实测，跑完一次深度调查（直连，不经 agent）后说「针对上面的问题开一个案例」，
 * agent 恢复记忆 0 条，回了一张空白建案卡。这里钉三件事，都属于"改坏了不报错、只是上文悄悄没了"：
 *   1. 挑选的真值表（direct_context.mjs）：只挑最近一次 agent 回答之后的直连轮次、截断方向、上限；
 *   2. payload：没有直连轮次时 payload 一个字节都不变；有就带 `direct_turns`；
 *   3. 接线（源码级）：各分支记 turnPath、深度调查把编号交回来、落库与读回带上 path / investigation、
 *      agent 分支把挑出来的轮次传给 invokeAgent。这几处是纯手工同步的接线，类型系统管不到"忘了传"。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { engineOf, pickUnseenDirectTurns, LIMITS } from "../direct_context.mjs";
import { buildRuntimePayload } from "../agentcore.mjs";

let fails = 0;
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}

const U = (text) => ({ role: "user", text });
const A = (text, extra = {}) => ({ role: "assistant", text, ...extra });
const INV = "🚀 **深度调查已发起**（直连，0 token）\n\n（调查编号：`[[investigation:3f2a9c1e-1111-2222-3333-444455556666]]`）";

await t("engineOf：新消息看 path；老消息靠 via 和正文里的调查编号推断", () => {
  assert.equal(engineOf(A("x", { path: "agent" })), "agent");
  assert.equal(engineOf(A(INV, { path: "agent" })), "agent");               // path 优先于正文
  assert.equal(engineOf(A("x", { via: "starops" })), "starops");
  assert.equal(engineOf(A(INV)), "deep-direct");                             // 调查主题里直连那轮 via 为空
  assert.equal(engineOf(A("答案", { via: "devops-agent" })), "devops-chat");
  assert.equal(engineOf(A("答案")), "agent");
  assert.equal(engineOf(U("问题")), "");
});

await t("10-21 那种会话：直连调查一轮 + 本轮「开个案例」→ 带上那一轮，编号来自落库字段", () => {
  const msgs = [
    U("调查 i-07ec 过去 24 小时 CPU"),
    A(INV + "\n\n## Root cause\nCPU 被一个 cron 任务打满", { path: "deep-direct", investigation: { task_id: "3f2a9c1e-1111-2222-3333-444455556666", execution_id: "exe-ops1-abcdef12" } }),
    U("针对上面的问题 开一个案例"),                                          // 本轮（已先落库）
  ];
  const got = pickUnseenDirectTurns(msgs);
  assert.equal(got.length, 1);
  assert.equal(got[0].engine, "deep-direct");
  assert.equal(got[0].question, "调查 i-07ec 过去 24 小时 CPU");
  assert.match(got[0].answer, /Root cause/);
  assert.deepEqual(got[0].investigation, { task_id: "3f2a9c1e-1111-2222-3333-444455556666", execution_id: "exe-ops1-abcdef12" });
  assert.ok(!JSON.stringify(got).includes("开一个案例"), "本轮的提问不能当成上文");
});

await t("只挑最近一次 agent 回答之后的直连轮次（更早的已经随注入进了 agent 记忆）", () => {
  const msgs = [
    U("q1"), A("DevOps 答 1", { path: "devops-chat" }),
    U("q2"), A("agent 答 2", { path: "agent" }),
    U("q3"), A("DevOps 答 3", { path: "devops-chat" }),
    U("q4"),
  ];
  const got = pickUnseenDirectTurns(msgs);
  assert.deepEqual(got.map((x) => x.question), ["q3"]);
  assert.equal(pickUnseenDirectTurns([U("q"), A("a", { path: "agent" }), U("now")]), undefined, "没有直连轮次 → undefined");
  assert.equal(pickUnseenDirectTurns([]), undefined);
  assert.equal(pickUnseenDirectTurns(undefined), undefined);
});

await t("STAROps / echo 不算直连上文（另一朵云 / 不是任何引擎）", () => {
  const msgs = [U("q"), A("阿里云答", { path: "starops" }), U("q2"), A("echo", { path: "echo" }), U("now")];
  assert.equal(pickUnseenDirectTurns(msgs), undefined);
});

await t("截断：深度调查留尾（结论在末尾），DevOps 对话留头；老消息的编号从正文里取 taskId", () => {
  const long = "开" + "x".repeat(LIMITS.maxAnswerChars + 50) + "结论在这里";
  const got = pickUnseenDirectTurns([U("q1"), A(INV + long), U("q2"), A("头" + "y".repeat(LIMITS.maxAnswerChars + 50), { via: "devops-agent" }), U("now")]);
  assert.equal(got.length, 2);
  assert.ok(got[0].answer.endsWith("结论在这里") && got[0].answer.startsWith("… "), "深度调查要保留末尾");
  assert.deepEqual(got[0].investigation, { task_id: "3f2a9c1e-1111-2222-3333-444455556666" });
  assert.ok(got[1].answer.startsWith("头") && got[1].answer.endsWith(" …"), "DevOps 对话要保留开头");
  assert.equal(got[1].investigation, undefined);
});

await t("上限：最多 3 轮；总长超了从最旧的丢，至少留一轮", () => {
  const many = [];
  for (let i = 1; i <= 5; i++) many.push(U(`q${i}`), A(`a${i}`, { path: "devops-chat" }));
  many.push(U("now"));
  assert.deepEqual(pickUnseenDirectTurns(many).map((x) => x.question), ["q3", "q4", "q5"]);
  const big = [];
  for (let i = 1; i <= 3; i++) big.push(U(`q${i}`), A("z".repeat(LIMITS.maxAnswerChars), { path: "devops-chat" }));
  big.push(U("now"));
  const got = pickUnseenDirectTurns(big);
  assert.ok(JSON.stringify(got).length <= LIMITS.maxTotalChars || got.length === 1);
  assert.equal(got[got.length - 1].question, "q3", "最近那一轮必须留下");
});

await t("payload：没有直连轮次时一个字节都不变；有就带 direct_turns", () => {
  const base = { prompt: "p", model: "m", topic: "investigate" };
  assert.equal(JSON.stringify(buildRuntimePayload(base)), JSON.stringify(buildRuntimePayload({ ...base, directTurns: [] })));
  assert.ok(!("direct_turns" in JSON.parse(JSON.stringify(buildRuntimePayload(base)))));
  const dt = [{ engine: "deep-direct", question: "q", answer: "a" }];
  assert.deepEqual(buildRuntimePayload({ ...base, directTurns: dt }).direct_turns, dt);
});

const idx = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
const store = readFileSync(new URL("../store.mjs", import.meta.url), "utf8");
const inv = readFileSync(new URL("../devops_investigate.mjs", import.meta.url), "utf8");
const ac = readFileSync(new URL("../agentcore.mjs", import.meta.url), "utf8");

await t("接线：四个分支的第一行都记 turnPath", () => {
  for (const [branch, path] of [["if (staropsDirect) {", "starops"], ["} else if (chatDirect) {", "devops-chat"],
    ["} else if (directInvestigate) {", "deep-direct"], ["} else if (agentRuntimeConfigured()) {", "agent"]]) {
    const i = idx.indexOf(branch);
    assert.ok(i > -1, `找不到分支 ${branch}`);
    assert.ok(idx.slice(i, i + 120).includes(`turnPath = "${path}";`), `${branch} 第一行没有 turnPath = "${path}"`);
  }
});

await t("接线：深度调查把编号交回来；agent 分支挑上文并传给 invokeAgent；invokeAgent 再交给 payload", () => {
  assert.match(idx, /onRef: \(r\) => \{ directRef = r; \}/);
  assert.match(idx, /pickUnseenDirectTurns\(await listMessagesForContext\(conversationId, \d+\)\)/);
  assert.match(idx, /skillId, skillVersion, directTurns \},\s*callbacks/);
  assert.match(ac, /skillId, skillVersion, directTurns,\s*\}\)\)\),/);
  assert.match(inv, /reportRef\(taskId, executionId\);/);
  assert.match(inv, /reportRef\(resolved\.taskId, resolved\.executionId\);/);
});

await t("接线：助手消息落库带 path / investigation，服务端内部读回也带（direct_context 靠它们判断）", () => {
  assert.match(idx, /role: "assistant", text: reply, ts, model,\s*path: turnPath \|\| undefined,/);
  assert.match(store, /path: msg\.path,\s*investigation: msg\.investigation,/);
  // 读回只走服务端内部那条（listMessagesForContext）；回前端的 listMessages 投影不加这两个字段。
  assert.match(store, /role: i\.role, text: i\.text, via: i\.via, path: i\.path, investigation: i\.investigation \}\)/);
});

console.log(`\n${ok} passed, ${fails} failed`);
if (fails) process.exit(1);
