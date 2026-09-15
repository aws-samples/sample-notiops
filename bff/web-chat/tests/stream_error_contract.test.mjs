/**
 * `/stream` 出错时的响应契约 —— 三件必须同时成立的事。
 * 运行：node bff/web-chat/tests/stream_error_contract.test.mjs
 *
 * ## 守的是什么
 *
 * `streamChat()` 是个 async 函数，handler 原来是**裸 return**（不 await）。于是这一轮
 * 里任何一处抛异常（模型调用、工具、深度调查、落库），控制流直接跳出函数：
 *   · `sse("done")` 和 `stream.end()` 永远执行不到 → 前端的流**永远不结束**，
 *     那个转圈一直转，用户只能刷新；
 *   · keepalive 定时器不停 → 继续往一条没人管的流里写；
 *   · Promise 变成 unhandled rejection → Lambda 的 Errors 指标上**看不到**这次失败。
 *
 * 而"只补一个 await"会把病换个方向：handler 的 catch 会拿 `errBody(e)` 去调 `json()`，
 * 而 SSE 序幕（200 + text/event-stream）已经发出去了 —— 那一段 JSON 会被**灌进 SSE 流体**，
 * 前端解析成一条垃圾事件，同时把上游异常的原文（AWS SDK 的散文，含账号 id / ARN）
 * 送到用户屏幕上。
 *
 * 所以修法是**不可分割的三件事**，本文件逐条钉住：
 *   ① `streamChat` 内部 try / catch / finally 包住整轮，`sse("done")` + `end()` 在 finally 里；
 *   ② handler 里的 `json()` 在 SSE 序幕之后变成**空操作**（`sseStarted` 闸门）；
 *   ③ handler 用 `return await streamChat(...)`（纵深防御：让异常落进 handler 的 catch，
 *      从而进 CloudWatch 与 Errors 指标，而不是变成 unhandled rejection）。
 * 少任何一条，要么流不结束，要么原文外泄。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const idx = readFileSync(join(HERE, "..", "index.mjs"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/* ── ① finally 里收流 ── */
const finallyAt = idx.lastIndexOf("} finally {");
const doneAt = idx.indexOf('sse("done"', finallyAt);
const endAt = idx.indexOf("stream.end();", finallyAt);
const stopKaAt = idx.indexOf("stopKeepalive();", finallyAt);

ok("streamChat 里有 finally 块", finallyAt > 0);
ok('sse("done") 在 finally 里', finallyAt > 0 && doneAt > finallyAt);
ok("stream.end() 在 finally 里", finallyAt > 0 && endAt > finallyAt);
ok("stopKeepalive() 也在 finally 里", finallyAt > 0 && stopKaAt > finallyAt);
ok("stopKeepalive 排在 end() 之前（否则定时器会写进已关闭的流）",
  stopKaAt > 0 && endAt > stopKaAt);
ok("turn 级 catch 在流已开时把失败**写进流体**而不是换响应头",
  /catch \(e\) \{[\s\S]{0,400}\/stream turn failed after SSE started[\s\S]{0,400}stream\.write\(sse\("token"/.test(idx));
ok("finally 里的 write/end 自己也包了 try（流可能已被对端断开）",
  /\} finally \{[\s\S]{0,300}try \{[\s\S]{0,200}stream\.end\(\);[\s\S]{0,200}\} catch/.test(idx));

/* ── ② json() 的 sseStarted 闸门 ── */
ok("handler 作用域里有 sseStarted", /let sseStarted = false;/.test(idx));
ok("json() 第一行就检查 sseStarted（SSE 序幕之后必须闭嘴）",
  /const json = \(status, obj\) => \{[\s\S]{0,600}if \(sseStarted \|\| responseStream\.writableEnded \|\| responseStream\.destroyed\) return;/.test(idx));
ok("闸门由 streamChat 通过 onSseStart 回调置位（不是猜的）",
  /onSseStart: \(\) => \{ sseStarted = true; \}/.test(idx));
ok("streamChat 收 onSseStart 参数并在序幕后立刻调用",
  /async function streamChat\(event, responseStream, \{ sub, groups, onSseStart \}\)/.test(idx)
  && /onSseStart\?\.\(\);/.test(idx));

/* ── ③ return await ── */
ok("handler 用 return await streamChat（不是裸 return）",
  /return await streamChat\(event, responseStream, \{/.test(idx));
ok("不存在裸 `return streamChat(`",
  !/[^t] return streamChat\(/.test(idx) && !/\n\s*return streamChat\(/.test(idx));

/* ── ④ 落库失败不许再掀翻这一轮 ──
 * ensureConversation / appendMessage 抛错时，用户的问题已经答完了。让它把整轮
 * 打掉（进而不发 done）是把一次"历史没存上"升级成"这次对话白问了"。 */
ok("ensureConversation 失败只记日志",
  /await ensureConversation\([\s\S]{0,200}\.catch\(\(e\) => console\.error\(/.test(idx));
ok("appendMessage(user) 失败只记日志",
  /appendMessage\(conversationId, \{ role: "user"[\s\S]{0,200}\.catch\(\(e\) => console\.error\(/.test(idx));
ok("appendMessage(assistant) 失败只记日志",
  /appendMessage\(assistant\) failed/.test(idx));
ok("这三条日志走 safeErr（不把 SDK 散文塞进日志行的可读部分之外的地方）",
  (idx.match(/failed — \$\{safeErr\(e\)\}/g) || []).length >= 3);

/* ── ⑤ wait-hint 的 emit 也要挡住写已关闭的流 ──
 * emit 是从 setInterval 的回调里调的 —— 它跑在另一个 tick 上，**不在** try 的
 * 覆盖范围内，所以必须自己 catch，并且要把定时器停掉（createWaitHint 不自愈）。 */
ok("wait-hint 的 emit 包了 try 并在失败时 stop()",
  /emit: \(text, kind\) => \{[\s\S]{0,900}try \{ stream\.write\(sse\("progress"[\s\S]{0,80}catch \{ waitHint\.stop\(\); \}/.test(idx));

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
