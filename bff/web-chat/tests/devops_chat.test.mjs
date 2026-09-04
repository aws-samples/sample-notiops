/**
 * 「DevOps 对话」（bff/web-chat/devops_chat.mjs）的流式契约测试。
 *
 * 为什么值得单测：这条路径的用户体验硬要求是"跟客户直接开 DevOps Agent 网页聊一样"，
 * 而所有能毁掉它的坑都在事件流转 SSE 这一层，且都**不会报错、只会显示错**：
 *   · 攒够一块才发 → 用户干等几十秒，看不出在动；
 *   · contentBlockStop.text 是**累积全文**，流完 deltas 再追加 = 整段答案重复；
 *   · 工具入参 jsonDelta 漏进气泡 → 用户看到一堆裸 JSON；
 *   · 把正文误判成"过程" → 气泡空白、答案藏进右侧面板。
 * 这里喂手写事件流（不连 AWS、不需要凭证）把上面每一条钉住。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeSink, consumeEvents, parseAsk, renderUserPrompt } from "../devops_chat.mjs";

let fails = 0;
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
}

/** 录一遍 emit 出去的 SSE，供断言。 */
function recorder() {
  const events = [];
  const sink = makeSink({ emit: (event, data) => events.push({ event, data }) });
  return {
    sink, events,
    /** 只看正文帧的 delta 序列 —— 逐 delta 转发的直接证据。 */
    tokens: () => events.filter((e) => e.event === "token").map((e) => e.data.delta),
    steps: () => events.filter((e) => e.event === "investigation_step").map((e) => e.data.step.text),
    progresses: () => events.filter((e) => e.event === "progress").map((e) => e.data.text),
  };
}

/** 把数组当成 SendMessageResponse.events（真实是 AsyncIterable）。 */
async function* stream(list) { for (const ev of list) yield ev; }

const textDelta = (index, text) => ({ contentBlockDelta: { index, delta: { textDelta: { text } } } });
const jsonDelta = (index, partialJson) => ({ contentBlockDelta: { index, delta: { jsonDelta: { partialJson } } } });
const SRC = readFileSync(new URL("../devops_chat.mjs", import.meta.url), "utf8");

console.log("devops_chat: 流式契约");

await t("正文 textDelta 逐 delta 转发（不缓冲、不合并）", async () => {
  const r = recorder();
  const res = await consumeEvents(stream([
    { contentBlockStart: { index: 0, type: "text" } },
    textDelta(0, "EC2 "), textDelta(0, "实例 "), textDelta(0, "i-abc 已停止。"),
    { contentBlockStop: { index: 0, type: "text", text: "EC2 实例 i-abc 已停止。" } },
    { responseCompleted: { usage: { totalTokens: 1234 } } },
  ]), r.sink);
  // 3 个 delta → 3 帧，一一对应；合并/缓冲会让这里变成 1 帧。
  assert.deepEqual(r.tokens(), ["EC2 ", "实例 ", "i-abc 已停止。"]);
  assert.equal(r.sink.reply, "EC2 实例 i-abc 已停止。");
  assert.equal(res.completed, true);
});

await t("contentBlockStop.text 不在 delta 之后重复追加（否则整段答案说两遍）", async () => {
  const r = recorder();
  await consumeEvents(stream([
    { contentBlockStart: { index: 0, type: "text" } },
    textDelta(0, "答案"), textDelta(0, "在此"),
    { contentBlockStop: { index: 0, type: "text", text: "答案在此" } },   // 累积值，不是增量
  ]), r.sink);
  assert.equal(r.sink.reply, "答案在此");
  assert.equal(r.tokens().length, 2);
});

await t("一个 delta 都没收到时，才用 stop 的累积全文兜底", async () => {
  const r = recorder();
  await consumeEvents(stream([
    { contentBlockStart: { index: 0, type: "text" } },
    { contentBlockStop: { index: 0, type: "text", text: "整块一次给的答案" } },
  ]), r.sink);
  assert.deepEqual(r.tokens(), ["整块一次给的答案"]);
});

await t("工具/思考块进面板，其文字与 jsonDelta 绝不进气泡", async () => {
  const r = recorder();
  await consumeEvents(stream([
    { contentBlockStart: { index: 0, type: "tool_use", id: "t1" } },
    jsonDelta(0, '{"instanceId":'), jsonDelta(0, '"i-abc"}'),
    textDelta(0, "DescribeInstances 返回 1 条"),
    { contentBlockStop: { index: 0, type: "tool_use", text: "…" } },
    { contentBlockStart: { index: 1, type: "thinking" } },
    textDelta(1, "先看实例状态"),
    { contentBlockStop: { index: 1, type: "thinking", text: "先看实例状态" } },
  ]), r.sink);
  assert.equal(r.sink.reply, "", "过程块的任何内容都不该出现在气泡里");
  assert.equal(r.tokens().length, 0);
  const steps = r.steps().join("\n");
  assert.match(steps, /调用工具：tool use/);
  assert.match(steps, /思考中…/);
  assert.doesNotMatch(r.sink.reply, /instanceId/);
});

await t("未标类型 / 未知类型的块当正文（失败安全：宁可多显示，不能藏答案）", async () => {
  const r = recorder();
  await consumeEvents(stream([
    { contentBlockStart: { index: 0, type: "" } },
    textDelta(0, "甲"),
    { contentBlockStart: { index: 1, type: "some_future_kind" } },
    textDelta(1, "乙"),
    textDelta(2, "丙"),                                   // 压根没见过 start
  ]), r.sink);
  assert.match(r.sink.reply, /甲/);
  assert.match(r.sink.reply, /乙/);
  assert.match(r.sink.reply, /丙/);
});

await t("嵌套块（子代理的工具调用）算过程", async () => {
  const r = recorder();
  await consumeEvents(stream([
    { contentBlockStart: { index: 0, type: "custom_block", id: "c1", parentId: "p1" } },
    textDelta(0, "子代理内部输出"),
  ]), r.sink);
  assert.equal(r.sink.reply, "");
  assert.match(r.steps().join("\n"), /子代理/);
});

await t("穿插的正文块之间自动补空行（不然两段粘成一段）", async () => {
  const r = recorder();
  await consumeEvents(stream([
    { contentBlockStart: { index: 0, type: "text" } },
    textDelta(0, "第一段"),
    { contentBlockStart: { index: 1, type: "tool_use" } },
    { contentBlockStop: { index: 1, type: "tool_use", text: "工具跑完" } },
    { contentBlockStart: { index: 2, type: "text" } },
    textDelta(2, "第二段"),
  ]), r.sink);
  assert.equal(r.sink.reply, "第一段\n\n第二段");
});

await t("heartbeat 被忽略；responseCreated 只发瞬态 progress、不进正文", async () => {
  const r = recorder();
  await consumeEvents(stream([
    { heartbeat: {} }, { responseCreated: {} }, { heartbeat: {} }, { responseInProgress: {} },
  ]), r.sink);
  assert.equal(r.sink.reply, "");
  assert.equal(r.tokens().length, 0);
  assert.ok(r.progresses().length >= 1, "首答前应该有进度提示，否则用户面对空白");
});

await t("正文一开始，就不再发 progress（避免盖住答案）", async () => {
  const r = recorder();
  await consumeEvents(stream([
    { contentBlockStart: { index: 0, type: "text" } },
    textDelta(0, "开始答了"),
    { responseInProgress: {} },
    { summary: { content: "阶段小结" } },
  ]), r.sink);
  assert.equal(r.progresses().length, 0);
  assert.match(r.steps().join("\n"), /阶段小结/, "summary 仍应留在过程面板里");
});

await t("locale=en 时过程文案是英文", async () => {
  const r = recorder();
  await consumeEvents(stream([{ contentBlockStart: { index: 0, type: "tool_use" } }]), r.sink, { en: true });
  assert.match(r.steps().join("\n"), /Tool call: tool use/);
});

await t("responseFailed 带出 errorCode，且不再继续消费", async () => {
  const r = recorder();
  const res = await consumeEvents(stream([
    { responseFailed: { errorCode: "ThrottlingException", errorMessage: "raw service text" } },
    textDelta(0, "不该被读到"),
  ]), r.sink);
  assert.equal(res.failed?.errorCode, "ThrottlingException");
  assert.equal(res.completed, false);
  assert.equal(r.sink.reply, "");
});

await t("responseCompleted 之后的事件不再消费", async () => {
  const r = recorder();
  const res = await consumeEvents(stream([
    { responseCompleted: { usage: { totalTokens: 7 } } },
    textDelta(0, "尾巴"),
  ]), r.sink);
  assert.equal(res.completed, true);
  assert.equal(r.sink.reply, "");
});

await t("墙钟超时会收尾并把已生成的正文留下（timedOut，不是失败）", async () => {
  const r = recorder();
  const res = await consumeEvents(stream([textDelta(0, "半句")]), r.sink, { maxWaitSec: -1 });
  assert.equal(res.timedOut, true);
  assert.equal(res.completed, false);
});

await t("events 为空/undefined 不抛（SDK 没给流也别 500）", async () => {
  const r = recorder();
  const res = await consumeEvents(undefined, r.sink);
  assert.deepEqual(res, { completed: false, failed: null, timedOut: false });
});

console.log("devops_chat: 现网实测形状（2026-08-27 三个显示 bug 的回归）");

/** 现网实测的一轮问答（"hi"）：text 流完 → final_response 整段重发 → chat_title。 */
const REAL_TURN = (answer, title = "New Conversation Started") => [
  { responseCreated: {} }, { responseInProgress: {} },
  { contentBlockStart: { index: 0, type: "text", id: "b0" } },
  ...answer.map((chunk) => textDelta(0, chunk)),
  { contentBlockStop: { index: 0, type: "text", text: "", last: true } },
  { contentBlockStart: { index: 1, type: "context_usage", id: "b1" } },
  jsonDelta(1, '{"data": {"context_window": {"utilization": 3.8}}}'),
  { contentBlockStop: { index: 1, type: "context_usage", text: "" } },
  { contentBlockStart: { index: 2, type: "final_response", id: "b2" } },
  textDelta(2, answer.join("")),                        // ★ 全量重发同一段答案
  { contentBlockStop: { index: 2, type: "final_response", text: "" } },
  { contentBlockStart: { index: 3, type: "chat_title", id: "b3" } },
  textDelta(3, title),
  { contentBlockStop: { index: 3, type: "chat_title", text: "" } },
  { responseCompleted: { usage: { inputTokens: 2, outputTokens: 86 } } },
];

await t("final_response 的整段重发不再进气泡（线上现象：每轮答案说两遍）", async () => {
  const r = recorder();
  await consumeEvents(stream(REAL_TURN(["Hey there! ", "I'm your AWS DevOps Agent — ", "what's on your mind?"])), r.sink);
  assert.equal(r.sink.reply, "Hey there! I'm your AWS DevOps Agent — what's on your mind?");
  assert.equal((r.sink.reply.match(/DevOps Agent/g) || []).length, 1, "答案只能出现一次");
});

await t("chat_title 是元数据，不进气泡也不进面板（线上现象：答案尾巴多一句莫名的标题）", async () => {
  const r = recorder();
  await consumeEvents(stream(REAL_TURN(["答案"], "Starting a conversation with AWS DevOps")), r.sink);
  assert.doesNotMatch(r.sink.reply, /Starting a conversation/);
  assert.doesNotMatch(r.steps().join("\n"), /Starting a conversation/);
});

await t("只有 final_response 带内容时仍然显示（失败安全：不能因为去重把唯一答案丢了）", async () => {
  const r = recorder();
  await consumeEvents(stream([
    { contentBlockStart: { index: 0, type: "final_response" } },
    textDelta(0, "这是本轮唯一的答案"),
    { contentBlockStop: { index: 0, type: "final_response", text: "" } },
  ]), r.sink);
  assert.equal(r.sink.reply.trim(), "这是本轮唯一的答案");
});

/** 现网实测：agent 用 ask_user 反问用户 —— 问题在 tool_summary 的入参里，
 *  也在 user_prompt 块的 JSON 里；整轮**没有** text 块。 */
const ASK_JSON = JSON.stringify({
  question: "你想从哪方面开始?",
  options: [
    { label: "调查问题", description: "针对告警、故障或异常创建或查看根因调查", recommended: true },
    { label: "查看基础设施", description: "查询账户中的资源、拓扑结构或当前状态" },
  ],
  interrupt_id: "v1:tool_call:tooluse_x:abc",
});
const ASK_TURN = [
  { contentBlockStart: { index: 0, type: "tool_summary", id: "t0" } },
  textDelta(0, "Asking user: 你想从哪方面开始?"),
  jsonDelta(0, JSON.stringify({ type: "tool_call", name: "ask_user", input: JSON.parse(ASK_JSON) })),
  { contentBlockStart: { index: 1, type: "user_prompt", id: "t1" } },
  jsonDelta(1, ASK_JSON),
  { contentBlockStop: { index: 1, type: "user_prompt", text: "" } },
  { contentBlockStop: { index: 0, type: "tool_summary", text: "" } },
  { responseCompleted: { usage: {} } },
];

await t("agent 反问用户时气泡里有问题+选项（线上现象：「本轮没有返回内容」）", async () => {
  const r = recorder();
  await consumeEvents(stream(ASK_TURN), r.sink);
  assert.match(r.sink.reply, /你想从哪方面开始/);
  assert.match(r.sink.reply, /调查问题/);
  assert.match(r.sink.reply, /查看基础设施/);
  assert.match(r.sink.reply, /推荐/, "recommended 选项要标出来");
});

await t("同一个反问只说一遍（tool_summary 入参 + user_prompt 块都带它）", async () => {
  const r = recorder();
  await consumeEvents(stream(ASK_TURN), r.sink);
  assert.equal((r.sink.reply.match(/你想从哪方面开始/g) || []).length, 1);
});

await t("面板行不外泄 ask_user 的入参 JSON（线上现象：侧边栏抖出一坨 tool_call）", async () => {
  const r = recorder();
  await consumeEvents(stream(ASK_TURN), r.sink);
  const steps = r.steps().join("\n");
  assert.doesNotMatch(steps, /tool_call|interrupt_id|\\u5/, "面板只放人话，不放 JSON");
  assert.match(steps, /Asking user/);
});

await t("反问块没等到 stop（流提前结束）也要补出来", async () => {
  const r = recorder();
  await consumeEvents(stream([
    { contentBlockStart: { index: 0, type: "user_prompt" } },
    jsonDelta(0, ASK_JSON),
    { responseCompleted: { usage: {} } },
  ]), r.sink);
  assert.match(r.sink.reply, /你想从哪方面开始/);
});

await t("parseAsk 只认 ask_user，别的工具入参不当成对用户说的话", () => {
  assert.equal(parseAsk(JSON.stringify({ type: "tool_call", name: "ec2_describe_instance", input: { question: "x" } })), null);
  assert.equal(parseAsk("not json"), null);
  assert.equal(parseAsk(""), null);
  assert.deepEqual(parseAsk(ASK_JSON).question, "你想从哪方面开始?");
});

await t("反问 JSON 解析失败时给可操作提示，绝不把裸 JSON 倒进气泡", () => {
  const out = renderUserPrompt("{oops", false);
  assert.doesNotMatch(out, /oops/);
  assert.match(out, /补充信息/);
});

console.log("devops_chat: 契约（结构性）");

await t("NotiOps 侧 usage 恒为 0 token（前端据此不渲染 token 徽章）", () => {
  assert.match(SRC, /usage:\s*\{\s*totalTokens:\s*0,\s*cycles:\s*0,\s*direct:\s*true\s*\}/);
});

await t("只记错误码、不记服务端原始 message（docs/LOGGING_STANDARD.md）", () => {
  assert.match(SRC, /code=\$\{code\}/);
  assert.doesNotMatch(SRC, /errorMessage/, "errorMessage 一旦进日志/气泡就可能带出服务端细节");
});

await t("待确认动作只提示、绝不代客户批准（无 RespondToPendingMessage 之类写操作）", () => {
  assert.match(SRC, /ListPendingMessagesCommand/);
  assert.doesNotMatch(SRC, /RespondTo|ApproveP|SendPending/i);
});

await t("过期 executionId 只在还没吐字时重试一次（否则会重复输出）", () => {
  // 判据从 `!sink.reply` 改成"与 prelude 相比没变"：/skill 读失败时我们会先往气泡里写一句
  // ⚠️ 提示，那之后 sink.reply 就不为空了 —— 沿用 `!sink.reply` 会把这唯一一次合法重试
  // 也一起废掉（客户拿到的是"会话过期"而不是答案）。
  assert.match(SRC, /const prelude = sink\.reply;/);
  assert.match(SRC, /const stale = reused && sink\.reply === prelude && STALE_RE\.test/);
});

await t("BFF 三条 DevOps 路径互斥，且老客户端不传字段时永不进新分支", () => {
  const idx = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(idx, /const objDevops = body\.devops_chat_direct === true;/);
  assert.match(idx, /const deepDirectAsked = body\.deep_investigate_direct === true;/);
  // 「深度调查」是**这一轮的修饰**，两个字段同时为真时它优先 —— 否则通用会话里客户勾了
  // 深度调查，答回来的还是普通直答（不报错，只是没照做）。
  assert.match(idx, /const chatDirect = objDevops && !deepDirectAsked;/);
  // 同一轮仍然只能进一条分支：deep 被勾上 → chatDirect 恒 false；「转人工」那轮两条直连都让位
  // 给计费的 agent 路径（escalateFallback → devopsAgent），否则 escalate 的 prompt 会被当成
  // 一句普通问话发给 DevOps Agent。
  assert.match(idx, /const directInvestigate = deepDirectAsked && !escalateFallback;/);
  // 答案来源要落库，否则刷新后历史回复被错误署名成本地模型，且通用会话的「对话对象」锁
  // 失去唯一依据。「转人工」那轮真由我们的 agent 答，
  // 就该署我们的模型名。
  //
  // 回落分支是 `agentVia`（agent 自己报的来源，目前只有 "builtin" —— 内置确定性回答，
  // 0 token、未调模型）。写成两条断言而不是逐字匹配整行，是因为这一行会随新的来源类型
  // 增长，而**必须不变**的只有这两点：devops-agent 这个署名仍然只由
  // `objDevops && !escalateFallback` 决定；其余情况下的署名来自流里报的 via，不许在
  // 这里硬编码任何模型名/来源名。
  assert.match(idx, /via: objDevops && !escalateFallback \? "devops-agent" :/);
  assert.match(idx, /via: objDevops && !escalateFallback \? "devops-agent" : \(agentVia \|\| undefined\)/);
});

console.log(fails ? `\nFAILED: ${fails}` : `\nPASSED: ${ok} ok, 0 failed`);
process.exit(fails ? 1 : 0);
