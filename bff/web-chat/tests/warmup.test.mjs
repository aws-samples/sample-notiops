/**
 * 会话预热（`POST …/warmup`，0 token）的**纪律闸门**。
 * 运行：node bff/web-chat/tests/warmup.test.mjs
 *
 * 这条路由与别的路由不同：它由前端**自动**发出（用户进一个空会话就发，没点任何东西）。
 * 所以三件事必须被钉住，因为它们出错时**没有任何症状**给人看：
 *
 *   ① **不写任何会话数据**。写了就会造出用户没说过话的空会话、把侧栏「最近」的时间戳
 *      搅乱。表现是"莫名多出来的对话"，很难联想到预热。
 *   ② **必须 await 那次 runtime 调用**。Lambda 一返回就冻结容器 —— 发了不等等于请求
 *      被掐断，预热完全没发生，而接口照样回 200 {ok:true}。这是最"安静"的失效方式。
 *   ③ **门禁挂在 nav:chat 节点上**（与 /stream 同节点），不许丢进 LOGIN_ONLY。
 *      LOGIN_ONLY 会绕开模块开关：管理员关掉聊天之后，前端仍会每进一个会话就拉起一次
 *      agent runtime —— 一个已关闭的功能在持续花钱。
 *
 * ①②③ 都是"代码形状"层面的约束，所以这里直接扫源码。行为层面的补充：
 * `warmupAgent` 在任何情况下都不许抛（预热失败的唯一后果应当是首字回到原来的延迟）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "..", "index.mjs"), "utf8");
const caps = JSON.parse(readFileSync(join(HERE, "..", "capabilities.json"), "utf8"));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

console.log("warmup — 路由纪律");

/** 取出 `/warmup` 路由处理体（从 if 行到该 if 块结束的 `}`）。 */
function warmupBlock() {
  const start = src.indexOf('path.endsWith("/warmup")');
  assert.ok(start > 0, "index.mjs 里找不到 /warmup 路由 —— 它被删了还是改名了？");
  const from = src.lastIndexOf("if (", start);
  // 处理体缩进是 4 空格（handler 内的一层 if），所以块尾就是第一个行首 4 空格的 `}`。
  const end = src.indexOf("\n    }", from);
  assert.ok(end > from, "解析 /warmup 处理体失败");
  return src.slice(from, end);
}

const block = warmupBlock();

t("① 不写任何会话数据", () => {
  for (const w of ["ensureConversation", "appendMessage", "touchConversation",
                   "putMessage", "saveMessage", "setTitle", "renameConversation"]) {
    assert.ok(!block.includes(w),
      `/warmup 处理体里出现了 ${w}() —— 预热不许落库（会造出空会话、搅乱侧栏时间戳）`);
  }
});

t("② await 了那次 runtime 调用（Lambda 一返回就冻结）", () => {
  assert.match(block, /await\s+warmupAgent\(/,
    "/warmup 必须 await warmupAgent —— 不等就等于没预热，而接口照样回 200");
});

t("② 之二：不建 SSE、不回模型产出，只回 {ok}", () => {
  assert.ok(!block.includes("responseStream"), "/warmup 不该碰 responseStream");
  assert.ok(!block.includes("invokeAgent("), "/warmup 不该走真实对话那条路");
  assert.match(block, /json\(200,\s*\{\s*ok\s*\}\s*\)/, "/warmup 应当只回 {ok}");
});

t("缺 conversationId 时明确报错，而不是随便热一个容器", () => {
  assert.match(block, /conversation_id required/,
    "没有 conversationId 就对不上 runtimeSessionId（热到别的 microVM = 白花 10s）");
});

console.log("\nwarmup — 门禁");

t("③ /warmup 与 /stream 挂在同一个能力节点上", () => {
  const flat = [];
  (function walk(nodes) {
    for (const n of nodes || []) { flat.push(n); walk(n.children); }
  })(caps.tree || caps.nodes || []);
  const owners = flat.filter((n) => (n.routes || []).some((r) => String(r.pattern || "").includes("/warmup")));
  assert.equal(owners.length, 1, `/warmup 应当只属于一个能力节点，实际 ${owners.length} 个`);
  const node = owners[0];
  assert.equal(node.key, "nav:chat", `/warmup 挂在了 ${node.key}，应当是 nav:chat（与 /stream 同节点）`);
  assert.ok((node.routes || []).some((r) => String(r.pattern || "").includes("/stream")),
    "nav:chat 上找不到 /stream —— 两条路由必须同节点，模块开关才能一起管住");
  for (const r of node.routes || []) {
    if (String(r.pattern || "").includes("/warmup")) assert.equal(r.method, "POST");
  }
});

t("③ 之二：/warmup 不在 authz 的 LOGIN_ONLY 里（那会绕开模块开关）", () => {
  const authz = readFileSync(join(HERE, "..", "authz.mjs"), "utf8");
  const m = authz.match(/LOGIN_ONLY\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(m, "authz.mjs 里找不到 LOGIN_ONLY");
  assert.ok(!m[1].includes("warmup"), "/warmup 被放进了 LOGIN_ONLY —— 它会绕开聊天模块开关");
});

console.log("\nwarmup — warmupAgent 的失败语义");

t("没配 RUNTIME_ARN 时返回 false 且不抛", async () => {
  const prev = process.env.AGENT_RUNTIME_ARN;
  delete process.env.AGENT_RUNTIME_ARN;
  const { warmupAgent } = await import("../agentcore.mjs");
  const r = await warmupAgent({ conversationId: "c-1" });
  assert.equal(r, false);
  if (prev !== undefined) process.env.AGENT_RUNTIME_ARN = prev;
});

// 顶层 await：上面最后一个用例是 async，等它跑完再收尾。
await new Promise((r) => setTimeout(r, 0));
console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
