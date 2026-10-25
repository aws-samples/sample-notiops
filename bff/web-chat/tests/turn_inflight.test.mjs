/**
 * 「有一轮在跑」的服务端记录 + 真停止（待办 #30 第 ②③ 档）。
 * 运行：node bff/web-chat/tests/turn_inflight.test.mjs
 *
 * 钉四件事：
 *   1. store 的 turn 那一行（用一个只懂这几条表达式的内存假 DDB 跑真代码）：空闲能占、被占且没过期占不到、
 *      持有者死了（过期）能接手、只放自己那一行、停止 = 记一笔并把过期时间收短；
 *   2. stopAgentSession：发的是 StopRuntimeSession、会话 id 与 invoke 同一个派生；会话不在 = 已停；别的错误不抛；
 *   3. 鉴权：两个新路由挂在 nav:chat（alwaysOn）下 —— 不挂的话 authorize 对未知路由 fail-closed，任何人都 403；
 *   4. index.mjs 接线（源码级）：占不到就不进 runtime、在落库之后放掉、停止后落库成「已停止」、两个路由先做对象级门禁。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.AGENT_RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/NotiOpsWebChat_x";

let fails = 0;
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}

// ── 内存假 DDB：只实现 store.mjs 里 turn 那几条命令用到的表达式 ──
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const rows = new Map();
const k = (key) => `${key.PK}|${key.SK}`;
const ccf = () => Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
DynamoDBDocumentClient.prototype.send = async function (cmd) {
  const n = cmd.constructor.name;
  const i = cmd.input;
  if (n === "PutCommand") {
    const cur = rows.get(k(i.Item));
    if (i.ConditionExpression === "attribute_not_exists(PK) OR expiresAt < :now OR stopRequested = :y") {
      const v = i.ExpressionAttributeValues;
      if (cur && !(cur.expiresAt < v[":now"]) && cur.stopRequested !== v[":y"]) throw ccf();
    } else if (i.ConditionExpression) throw new Error(`unexpected condition ${i.ConditionExpression}`);
    rows.set(k(i.Item), { ...i.Item });
    return {};
  }
  if (n === "GetCommand") return { Item: rows.get(k(i.Key)) };
  if (n === "DeleteCommand") {
    const cur = rows.get(k(i.Key));
    if (i.ConditionExpression === "turnId = :t" && (!cur || cur.turnId !== i.ExpressionAttributeValues[":t"])) throw ccf();
    rows.delete(k(i.Key));
    return {};
  }
  if (n === "UpdateCommand") {
    const cur = rows.get(k(i.Key));
    const v = i.ExpressionAttributeValues;
    if (!cur || !(cur.expiresAt > v[":now"])) throw ccf();
    rows.set(k(i.Key), { ...cur, stopRequested: v[":y"], expiresAt: v[":e"] });
    return {};
  }
  throw new Error(`unexpected command ${n}`);
};
const store = await import("../store.mjs");

await t("占 turn：空闲能占；被占且没过期占不到（并报出上一轮的开始时间）；只有持有者能放", async () => {
  rows.clear();
  assert.deepEqual(await store.claimTurn("c1", "tA", { now: 1000 }), { claimed: true });
  const busy = await store.claimTurn("c1", "tB", { now: 2000 });
  assert.equal(busy.claimed, false);
  assert.equal(busy.inflight.startedAt, 1000);
  await store.releaseTurn("c1", "tB");                         // 不是自己的，删不掉（也不抛）
  assert.equal((await store.getInflightTurn("c1", { now: 2000 })).startedAt, 1000);
  await store.releaseTurn("c1", "tA");
  assert.equal(await store.getInflightTurn("c1", { now: 2000 }), null);
  assert.deepEqual(await store.claimTurn("c1", "tB", { now: 3000 }), { claimed: true });
});

await t("持有者死了（Lambda 超时走不到 release）：过期以后别人能接手，过期的行查询时当不存在", async () => {
  rows.clear();
  await store.claimTurn("c2", "tA", { now: 0 });
  const later = store.TURN_MAX_MS + 1;
  assert.equal(await store.getInflightTurn("c2", { now: later }), null);
  assert.deepEqual(await store.claimTurn("c2", "tB", { now: later }), { claimed: true });
  assert.ok(store.TURN_MAX_MS >= 15 * 60 * 1000, "不能短于 BFF Lambda 的 15 分钟超时，否则活着的一轮会被别人接手");
});

await t("停止：记一笔 stopRequested、过期时间收短到宽限期；没有进行中的一轮 → false", async () => {
  rows.clear();
  assert.equal(await store.requestTurnStop("c3", { now: 0 }), false);
  await store.claimTurn("c3", "tA", { now: 0 });
  assert.equal(await store.requestTurnStop("c3", { now: 10, graceMs: 30000 }), true);
  const cur = await store.getInflightTurn("c3", { now: 20 });
  assert.equal(cur.stopRequested, true);
  assert.equal(await store.getInflightTurn("c3", { now: 30011 }), null, "宽限期过了就不再挡新的一轮");
  await store.releaseTurn("c3", "tA");                          // 持有者还活着时照常能放
  assert.equal(rows.size, 0);
});

await t("停止之后马上能开下一轮（runtime 会话已经停了）；老持有者放不掉新行、能看出自己是被停的", async () => {
  rows.clear();
  await store.claimTurn("c4", "tOld", { now: 0 });
  await store.requestTurnStop("c4", { now: 5 });
  assert.deepEqual(await store.claimTurn("c4", "tNew", { now: 6 }), { claimed: true });
  const row = await store.getTurnRow("c4");
  assert.equal(row.turnId, "tNew");
  assert.ok(row.turnId !== "tOld", "老持有者据此判断自己被停掉了");
  await store.releaseTurn("c4", "tOld");
  assert.equal((await store.getTurnRow("c4")).turnId, "tNew", "老持有者的 release 不许删掉新的一轮");
});

// ── stopAgentSession ──
const { BedrockAgentCoreClient } = await import("@aws-sdk/client-bedrock-agentcore");
const { stopAgentSession, toSessionId } = await import("../agentcore.mjs");
async function withSend(fn, body) {
  const orig = BedrockAgentCoreClient.prototype.send;
  BedrockAgentCoreClient.prototype.send = fn;
  try { return await body(); } finally { BedrockAgentCoreClient.prototype.send = orig; }
}

await t("stopAgentSession：StopRuntimeSession、会话 id 与 invoke 同一个派生", async () => {
  const seen = [];
  const r = await withSend(async (cmd) => { seen.push(cmd); return {}; }, () => stopAgentSession("conv-123-1"));
  assert.deepEqual(r, { ok: true });
  assert.equal(seen[0].constructor.name, "StopRuntimeSessionCommand");
  assert.equal(seen[0].input.runtimeSessionId, toSessionId("conv-123-1"));
  assert.equal(seen[0].input.agentRuntimeArn, process.env.AGENT_RUNTIME_ARN);
});

await t("stopAgentSession：会话已不在 = 已停；权限不够之类的错误只回 code、不抛", async () => {
  const nf = await withSend(async () => { throw Object.assign(new Error("x"), { name: "ResourceNotFoundException" }); }, () => stopAgentSession("c"));
  assert.deepEqual(nf, { ok: true, code: "not_running" });
  const ad = await withSend(async () => { throw Object.assign(new Error("x"), { name: "AccessDeniedException" }); }, () => stopAgentSession("c"));
  assert.deepEqual(ad, { ok: false, code: "AccessDeniedException" });
});

// ── 鉴权 ──
const { authorize } = await import("../authz.mjs");
await t("两个新路由挂在 nav:chat（alwaysOn）下：没有任何功能权限的登录用户也能用（对象级门禁在路由里）", async () => {
  const none = { grants: [], denies: [] };
  assert.equal((await authorize({ method: "GET", path: "/api/chat/conversations/c1/turn", query: null, body: null }, none)).allow, true);
  assert.equal((await authorize({ method: "POST", path: "/api/chat/conversations/c1/stop", query: null, body: null }, none)).allow, true);
  // 方法对不上的仍然 fail-closed
  assert.equal((await authorize({ method: "DELETE", path: "/api/chat/conversations/c1/stop", query: null, body: null }, none)).allow, false);
  const a = readFileSync(new URL("../capabilities.json", import.meta.url), "utf8");
  const b = readFileSync(new URL("../../../config/capabilities.json", import.meta.url), "utf8");
  assert.equal(a, b, "bff/web-chat/capabilities.json 必须与 config/ 那份逐字节一致");
});

// ── index.mjs 接线 ──
const idx = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");

await t("接线：占不到 turn 就不进 runtime（会话忙那一支排在 agent 分支之前）", () => {
  const busyAt = idx.indexOf("} else if (agentRuntimeConfigured() && !(await claimAgentTurn())) {");
  const agentAt = idx.indexOf("} else if (agentRuntimeConfigured()) {");
  assert.ok(busyAt > -1 && agentAt > busyAt);
  const busyBranch = idx.slice(busyAt, agentAt);
  assert.match(busyBranch, /turnPath = "busy";/);
  assert.match(busyBranch, /stream\.write\(sse\("busy", \{ reason: "turn_in_progress", since: busySince \|\| undefined \}\)\);/);
  assert.match(busyBranch, /reply = busyText\(locale\);/);
  assert.ok(!busyBranch.includes("invokeAgent("), "会话忙那一支不许调 runtime");
});

await t("接线：claimTurn 出错 fail-open；占到了才记 heldTurnId", () => {
  assert.match(idx, /const c = await claimTurn\(conversationId, turnId\);\s*if \(!c\.claimed\) \{ busySince = Number\(c\.inflight\?\.startedAt\) \|\| 0; return false; \}\s*\} catch \(e\) \{\s*console\.warn\(`\[BFF\] \/stream claimTurn failed \(fail-open\)/);
  assert.match(idx, /heldTurnId = turnId;\s*return true;/);
});

await t("接线：turn 在 done 帧与落库之后才放（前端轮询看到结束时回答已经拉得到）", () => {
  const fin = idx.lastIndexOf("} finally {");
  const doneAt = idx.indexOf('sse("done"', fin);
  const relAt = idx.indexOf("await releaseTurn(conversationId, heldTurnId)", fin);
  assert.ok(fin > 0 && doneAt > fin && relAt > doneAt);
  assert.ok(idx.indexOf("await appendMessage(conversationId, {\n      role: \"assistant\"") < fin);
});

await t("接线：被停的那一轮落库成「正文 + 已停止」，不报「中途断了」也不给失败文案", () => {
  assert.match(idx, /const turnRow = heldTurnId \? await getTurnRow\(conversationId\)\.catch\(\(\) => null\) : null;\s*if \(turnRow && \(turnRow\.turnId !== heldTurnId \|\| turnRow\.stopRequested\)\) \{[\s\S]{0,400}reply = body \+ note;[\s\S]{0,200}lastErr = undefined;\s*midStreamErr = null;/);
  assert.ok(idx.indexOf("if (turnRow && (turnRow.turnId !== heldTurnId") < idx.indexOf("if (reply && midStreamErr) {"), "停止判断要在「中途断了」之前");
});

await t("接线：/turn 与 /stop 先做对象级门禁（不是自己的会话一律 404），stop 无论有没有 turn 行都去停 runtime", () => {
  const i = idx.indexOf("const turnMatch = /\\/conversations\\/([^/]+)\\/(turn|stop)$/.exec(path);");
  assert.ok(i > -1);
  const block = idx.slice(i, i + 1800);
  assert.match(block, /if \(!\(await conversationOwnedBy\(sub, turnMatch\[1\]\)\)\) return json\(404, \{ error: "not_found" \}\);/);
  assert.ok(block.indexOf("conversationOwnedBy") < block.indexOf("getInflightTurn"));
  assert.match(block, /const rt = await stopAgentSession\(turnMatch\[1\]\);/);
});

console.log(`\n${ok} passed, ${fails} failed`);
if (fails) process.exit(1);
