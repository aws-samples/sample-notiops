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
import { buildRuntimePayload, toSessionId, extract } from "../agentcore.mjs";

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

/* ── 会话预热（warmup）──
 *
 * 两条判据，理由都是"别把真实那一轮弄坏"：
 *   ① 不预热时 payload 必须与改动前**逐字节一致**（warmup 字段缺席，不是 false）——
 *      runtime 的分支写的是 `payload.get("warmup") is True`，多一个 false 字段虽不改
 *      行为，却会让"预热改动没有碰到正常路径"这句话不再成立（也影响 payload 快照对比）。
 *   ② 预热与真实那一轮必须落到**同一个 runtimeSessionId**：AgentCore 按它路由到具体
 *      microVM，id 不同就是热了另一个容器、白等 10s。所以 toSessionId 必须是纯函数。
 */
t("warmup flag is absent unless asked for", () => {
  assert.equal("warmup" in wire({}), false);
  assert.equal("warmup" in wire({ warmup: false }), false);
  assert.equal("warmup" in wire({ warmup: 0 }), false);
});

t("warmup:true is carried as a real boolean true", () => {
  assert.equal(wire({ warmup: true }).warmup, true);
});

t("warmup payload keeps the agent-cache-key fields (or the real turn rebuilds the agent)", () => {
  const p = wire({ warmup: true, model: "gpt-5-6", topic: "finops", accountId: "123456789012", devopsAgent: true });
  assert.equal(p.model, "gpt-5-6");
  assert.equal(p.topic, "finops");
  assert.equal(p.account_id, "123456789012");
  assert.equal(p.devops_agent, true);
});

t("same conversation id always maps to the same runtime session id", () => {
  assert.equal(toSessionId("c-abc"), toSessionId("c-abc"));
  assert.notEqual(toSessionId("c-abc"), toSessionId("c-abd"));
});

/* ── extract()：序列化失败的退化产物绝不能当正文 ──
 *
 * 实测事故（Grok 一句"你好"）：回答里出现一坨
 *   {'event': {'contentBlockDelta': {'delta': {'reasoningContent': {'redactedContent': b'rsn_…'
 * 来路：agent 转发了含 bytes 的原始 chunk（加密思考链）→ AgentCore runtime 的
 * json.dumps 抛 TypeError → 兜底 json.dumps(str(obj)) → 事件的 **Python repr** 变成一个
 * 合法 JSON 字符串发到 BFF → 这里旧代码 `typeof evt === "string"` 就当正文。
 * agent 侧已在源头丢弃（scripts/test_stream_event_filter.py），这里是第二道：
 * 任何"看起来是序列化对象"的字符串事件都不进正文。
 */
console.log("\nagentcore — extract(): 退化字符串事件不得当正文");

const LEAK = "{'event': {'contentBlockDelta': {'delta': {'reasoningContent': "
  + "{'redactedContent': b'rsn_jQzyXZIFJLlpKyfl'}}, 'contentBlockIndex': 0}}}";

t("Python repr 泄漏字符串不进正文", () => {
  assert.equal(extract(LEAK).text, "");
});

t("JSON 对象字面量字符串也不进正文（parse 失败的半截行同理）", () => {
  assert.equal(extract('{"event": {"messageStop": {}}}').text, "");
  assert.equal(extract("  [1,2,3]").text, "");
  assert.equal(extract("b'\\x00binary'").text, "");
});

t("真正的纯文本字符串事件仍当正文（兜底路径不被误杀）", () => {
  assert.equal(extract("你好！我是 NotiOps").text, "你好！我是 NotiOps");
  assert.equal(extract("plain text").text, "plain text");
});

t("正常文本增量事件照旧提取", () => {
  const e = { event: { contentBlockDelta: { delta: { text: "hi" }, contentBlockIndex: 0 } } };
  assert.equal(extract(e).text, "hi");
});

t("工具入参增量不当正文（否则 JSON 入参混进回答）", () => {
  const e = { event: { contentBlockDelta: { delta: { toolUse: { input: '{"a":1}' } } } } };
  assert.equal(extract(e).text, "");
});

t("reasoning / progress / usage 各走各的通道，不进正文", () => {
  assert.equal(extract({ reasoning: { text: "想一下" } }).text, "");
  assert.deepEqual(extract({ reasoning: { text: "想一下" } }).reasoning, { text: "想一下" });
  assert.deepEqual(extract({ progress: { text: "查文档" } }).progress, { text: "查文档" });
  assert.equal(extract({ usage: { totalTokens: 7 } }).usage.totalTokens, 7);
});

/* ── extract()：runtime 流内异常帧必须被认出来 ──
 *
 * 事故（2026-08-25 现网）：Grok 4.6 这轮 Bedrock ConverseStream 连续 InternalServerException，
 * 异常冒到 AgentCore，runtime 按 `_sync_stream_with_error_handling` 的约定发一帧
 * {error, error_type, message} 然后**正常结束流**（HTTP 早已 200）。旧 extract 不认识这帧 →
 * invokeAgent 返回空串且不抛 → /stream 的 lastErr 是 undefined → 用户只看到「（无响应）」。
 * 判据必须锚在 error_type：工具/业务返回里 `{"error": "..."}` 很常见，不能当成 runtime 崩了。
 */
console.log("\nagentcore — extract(): runtime 异常帧");

t("识别 AgentCore 的 {error, error_type} 帧", () => {
  const e = extract({
    error: "An error occurred (InternalServerException) …",
    error_type: "EventStreamError",
    message: "An error occurred during streaming",
  });
  assert.equal(e.error.type, "EventStreamError");
  assert.equal(e.text, "");
});

t("业务/工具返回里的 error 字段不误判成 runtime 崩了", () => {
  assert.equal(extract({ error: "bucket not found" }).error, undefined);
  assert.equal(extract({ event: { contentBlockDelta: { delta: { text: '{"error":"x"}' } } } }).error, undefined);
  assert.equal(extract({ error_type: "" }).error, undefined);
});

t("正常事件不带 error", () => {
  assert.equal(extract({ event: { contentBlockDelta: { delta: { text: "hi" } } } }).error, undefined);
});

/* ── extract()：via（答案来源）──
 *
 * agent 的内置确定性回答（「你能做什么」，见 capability.py）**一个 token 都不过模型**。
 * 若这一帧丢了，前端会按缺省把它署名成「AWS Bedrock (某模型)」—— 把一段产品文案说成
 * 模型生成的能力自述，等于把来源说错（与 via="devops-agent" 同一个道理）。
 * 所以这里既要认得 via，也要保证它**不进正文**、不被别的字段误触发。
 */
console.log("\nagentcore — extract(): via（答案来源）");

t("认得 via 帧且不当正文", () => {
  const e = extract({ via: "builtin" });
  assert.equal(e.via, "builtin");
  assert.equal(e.text, "");
});

t("没有 via 的事件不凭空产生 via", () => {
  assert.equal(extract({ event: { contentBlockDelta: { delta: { text: "hi" } } } }).via, undefined);
  assert.equal(extract("plain text").via, undefined);
});

t("空/非字符串 via 一律忽略（宁可回落缺省署名，也不写一个空来源）", () => {
  for (const bad of ["", null, 0, false, {}, [], 1]) {
    assert.equal(extract({ via: bad }).via, undefined, `via=${JSON.stringify(bad)} leaked`);
  }
});

t("warmup ack 帧不产生任何正文（否则会被吐进聊天窗口）", () => {
  const e = extract({ warmup: "ok" });
  assert.equal(e.text, "");
  assert.equal(e.via, undefined);
  assert.equal(e.error, undefined);
});

t("thinking_step 帧被提取出来（右侧「思考过程」面板的数据源）", () => {
  const e = extract({ thinking_step: { text: "调用 get_cost_and_usage", kind: "tool" } });
  assert.equal(e.thinkingStep.text, "调用 get_cost_and_usage");
  assert.equal(e.thinkingStep.kind, "tool");
  assert.equal(e.text, "", "过程记录不许混进答案正文");
});

t("非对象的 thinking_step 一律忽略（宁可没有过程，也不给面板喂脏数据）", () => {
  for (const bad of ["x", 1, true, null]) {
    assert.equal(extract({ thinking_step: bad }).thinkingStep, null, `thinking_step=${JSON.stringify(bad)} leaked`);
  }
});

t("ready 帧只在 ready===true 时为真，且不产生正文（它只切等待期提示的阶段）", () => {
  const e = extract({ ready: true });
  assert.equal(e.ready, true);
  assert.equal(e.text, "");
  for (const bad of ["true", 1, {}, undefined]) {
    assert.equal(extract({ ready: bad }).ready, false, `ready=${JSON.stringify(bad)} 被当成就绪`);
  }
  // 普通正文帧不许被误判成 ready —— 否则等待期提示会在冷启动时提前切到"已连接"。
  assert.equal(extract({ event: { contentBlockDelta: { delta: { text: "hi" } } } }).ready, false);
});

console.log(`\n${fail === 0 ? "PASSED" : "FAILED"}: ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
