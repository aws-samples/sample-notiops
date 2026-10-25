/**
 * agent 这一轮失败时给用户的话（待办 #30）：分档、会话忙、中途断了。
 * 运行：node bff/web-chat/tests/turn_errors.test.mjs
 *
 * 钉的是三处「改坏了不报错、只是用户被误导」的地方：
 *   1. 分档真值表（turn_errors.mjs）：会话忙必须单独一档、不许落进「请再发送一次」；
 *      「已自动重试」只在 BFF 真的重发过时才说；
 *   2. 中途断了：已经有正文时补一段「上面的内容不完整」，而不是静默结束；
 *   3. 接线（index.mjs 源码级）：会话忙不重试、发 busy 事件、路径记 busy；两种「断了」都补话，
 *      且落库的回答和浏览器收到的一致。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyTurnError, errorKind, isBusyError, busyText, modelFailureText, interruptedNote } from "../turn_errors.mjs";
import { AgentRuntimeStreamError } from "../agentcore.mjs";

let fails = 0;
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}

await t("分档真值表（与 agent 侧 main.py 同一口径）", () => {
  const cases = {
    ConcurrencyException: "busy",
    AccessDeniedException: "permission", ExpiredTokenException: "permission",
    ValidationException: "badRequest", ResourceNotFoundException: "badRequest",
    ReadTimeoutError: "timeout", ModelTimeoutException: "timeout", ConnectionClosedError: "timeout",
    EndpointConnectionError: "timeout",
    InternalServerException: "transient", ThrottlingException: "transient", ServiceUnavailableException: "transient",
    ProtocolError: "transient", ModelErrorException: "transient",
    EventLoopException: "other", KeyError: "other", "": "other",
  };
  for (const [kind, want] of Object.entries(cases)) assert.equal(classifyTurnError(kind), want, kind);
});

await t("错误类型名：runtime 帧的 error_type 优先，其次异常名，都没有给 UnknownError", () => {
  assert.equal(errorKind(new AgentRuntimeStreamError("ConcurrencyException", "x")), "ConcurrencyException");
  assert.equal(errorKind({ runtimeErrorType: "ReadTimeoutError", name: "Error" }), "ReadTimeoutError");
  assert.equal(errorKind({}), "UnknownError");
  assert.ok(isBusyError(new AgentRuntimeStreamError("ConcurrencyException", "")));
  assert.ok(!isBusyError(new AgentRuntimeStreamError("InternalServerException", "")));
});

await t("会话忙：说清这条没发出去、不叫人「再发一次」，给等待和新建对话两条路", () => {
  const zh = modelFailureText("zh", new AgentRuntimeStreamError("ConcurrencyException", ""));
  const en = modelFailureText("en", new AgentRuntimeStreamError("ConcurrencyException", ""));
  assert.equal(zh, busyText("zh"));
  assert.equal(en, busyText("en"));
  assert.match(zh, /上一轮还没结束/); assert.match(zh, /没有发出去/); assert.match(zh, /新建一个对话/);
  assert.match(en, /hasn't finished yet/); assert.match(en, /was not sent/); assert.match(en, /new conversation/);
  for (const s of [zh, en]) {
    assert.ok(!/再发送一次|已自动重试|retried automatically|Send the message again/.test(s), s);
    assert.ok(!/ConcurrencyException/.test(s), "不把内部异常名丢给用户");
  }
});

await t("「已自动重试」只在 BFF 真的重发过时才说（以前 transient 档无条件说）", () => {
  const e = new AgentRuntimeStreamError("InternalServerException", "");
  assert.ok(!modelFailureText("zh", e).includes("已自动重试"));
  assert.ok(modelFailureText("zh", e, { retried: true }).includes("已自动重试"));
  assert.ok(!modelFailureText("en", e).includes("retried automatically"));
  assert.ok(modelFailureText("en", e, { retried: true }).includes("retried automatically"));
});

await t("超时单独一档：叫人拆小 / 换模型，而不是「临时故障再发一次」", () => {
  const zh = modelFailureText("zh", new AgentRuntimeStreamError("ReadTimeoutError", ""));
  const en = modelFailureText("en", new AgentRuntimeStreamError("ReadTimeoutError", ""));
  assert.match(zh, /拆小/); assert.match(zh, /输入框右下角/); assert.ok(!/临时故障/.test(zh));
  assert.match(en, /Narrow the question/); assert.match(en, /bottom right of the input box/);
});

await t("中途断了：以分隔线开头、明说上面不完整、按档给下一步", () => {
  for (const [kind, zhWant, enWant] of [
    ["ReadTimeoutError", /拆小/, /Narrow the question/],
    ["InternalServerException", /直接再发一次/, /Send the message again/],
    ["EventLoopException", /直接再发一次/, /Send the message again/],
    ["AccessDeniedException", /管理员/, /administrator/],
    ["ValidationException", /新建一个对话/, /new conversation/],
  ]) {
    const zh = interruptedNote("zh", { runtimeErrorType: kind });
    const en = interruptedNote("en", { runtimeErrorType: kind });
    assert.ok(zh.startsWith("\n\n---\n") && en.startsWith("\n\n---\n"), kind);
    assert.match(zh, /上面的内容不完整/); assert.match(en, /incomplete/);
    assert.match(zh, zhWant, kind); assert.match(en, enWant, kind);
    assert.ok(zh.includes(`\`${kind}\``) && en.includes(`\`${kind}\``), "只回显类型名");
  }
});

// ── 线上的帧长什么样（真实 invokeAgent + 假 SDK 流）──
// 2026-10-23 本机用真实 main.invoke 核过：同一会话第二轮并发时，agent 只来得及发一个 ready 帧，
// 随后 strands 抛 ConcurrencyException，AgentCore 的 _stream_with_error_handling 把它写成
// {error, error_type: "ConcurrencyException"} 帧（error_type = type(e).__name__）。
const { BedrockAgentCoreClient } = await import("@aws-sdk/client-bedrock-agentcore");
const { invokeAgent } = await import("../agentcore.mjs");
async function runFrames(frames, cbs = {}) {
  const bytes = new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""));
  const orig = BedrockAgentCoreClient.prototype.send;
  BedrockAgentCoreClient.prototype.send = async () => ({ response: (async function* () { yield { chunk: { bytes } }; })() });
  try { return await invokeAgent({ conversationId: "c-turn-errors", prompt: "p", model: "m", locale: "zh" }, cbs); }
  finally { BedrockAgentCoreClient.prototype.send = orig; }
}
const td = (text) => ({ event: { contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } } });

await t("线上帧：会话忙 = 只有 ready 帧 + ConcurrencyException 错误帧 → 抛出、且认得出是会话忙", async () => {
  const seen = [];
  let thrown;
  try {
    await runFrames([{ ready: true }, { error: "Agent is already processing a request.", error_type: "ConcurrencyException", message: "x" }],
      { onRuntimeError: (e) => seen.push(e.type) });
  } catch (e) { thrown = e; }
  assert.ok(thrown, "一个字都没有时必须抛（交给 /stream 的失败分支）");
  assert.ok(isBusyError(thrown));
  assert.deepEqual(seen, ["ConcurrencyException"]);
});

await t("线上帧：正文之后来了错误帧 → 不抛（免得重试重复输出），正文照常返回、错误经回调交回", async () => {
  const seen = [];
  const full = await runFrames([{ ready: true }, td("我先查一下 AWS 官方文档……"), { error: "x", error_type: "ReadTimeoutError" }],
    { onRuntimeError: (e) => seen.push(e.type) });
  assert.equal(full, "我先查一下 AWS 官方文档……");
  assert.deepEqual(seen, ["ReadTimeoutError"]);
});

const idx = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");

await t("接线：会话忙不重试（2 秒、4 秒后重发只会再撞锁）", () => {
  assert.match(idx, /if \(streamedAny \|\| isBusyError\(e\) \|\| !isColdStart\(e\) \|\| attempt >= MAX_ATTEMPTS\) break;/);
});

await t("接线：会话忙发结构化 busy 事件、路径记成 busy（direct_context 不把它当成 agent 答过的一轮）", () => {
  assert.match(idx, /if \(lastErr && isBusyError\(lastErr\)\) \{\s*turnPath = "busy";[\s\S]{0,200}stream\.write\(sse\("busy", \{ reason: "turn_in_progress" \}\)\);/);
});

await t("接线：retried 按真实尝试次数传", () => {
  assert.match(idx, /modelFailureText\(locale, lastErr, \{ retried: attemptsMade > 1 \}\)/);
});

await t("接线：错误帧来在正文之后 → 补一段「断了」；每次尝试先清掉上一次的错误帧", () => {
  assert.match(idx, /onRuntimeError: \(err\) => \{\s*midStreamErr = \{ runtimeErrorType: err\?\.type \|\| "" \};/);
  assert.match(idx, /attemptsMade = attempt;\s*midStreamErr = null;/);
  assert.match(idx, /if \(reply && midStreamErr\) \{\s*const note = interruptedNote\(locale, midStreamErr\);\s*reply \+= note;\s*stream\.write\(sse\("token", \{ delta: note \}\)\);/);
});

await t("接线：流读到一半抛了 → 落库的是「已推给浏览器的正文 + 断了」，不是只有一句失败文案", () => {
  assert.match(idx, /onToken: \(delta\) => \{ streamedAny = true; streamedText \+= delta;/);
  assert.match(idx, /\} else if \(!reply && lastErr && streamedText\) \{\s*const note = interruptedNote\(locale, lastErr\);\s*reply = streamedText \+ note;/);
  // 补话必须在「一个字都没有」那段失败文案之前判断，否则两段都会写出去
  assert.ok(idx.indexOf("} else if (!reply && lastErr && streamedText) {") < idx.indexOf("const neverStarted = "));
});

console.log(`\n${ok} passed, ${fails} failed`);
if (fails) process.exit(1);
