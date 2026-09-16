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

/* ── ⑥ "容器起不来"不许被渲染成"冷启动，请再发一次" ──
 *
 * 2026-09-16 的客户事故：agent 容器每次启动都在 import 阶段崩溃
 * （strands-agents 1.56.0 删掉了 bedrock-agentcore 要 import 的符号），平台把它报成
 * `Runtime initialization time exceeded` —— 与**真正的空闲冷启动一模一样**。isColdStart()
 * 分不开，于是三次尝试全挂之后，前端仍然显示「⏳ 服务仍在启动中…请再发送一次消息」。
 * 那条建议是可证伪的：我们刚刚已经替客户发了三次，每次都死在同一处。客户会一直重发到放弃，
 * 而真正的根因（一条 ImportError）就躺在容器日志里没人去看。
 *
 * 判据必须是**后台信号**而不是报文措辞：agent entrypoint 的第一帧（onReady）到过，
 * 说明容器里的代码真跑起来过。一次都没到 + 响应头也没回来 + 尝试已用尽 = 部署故障。 */
ok("有跨重试的 everOpened / everReady 标记（声明在重试循环外）",
  /let everOpened = false, everReady = false;/.test(idx));
ok("onOpen / onReady 真的会置这两个标记",
  /onOpen: \(\) => \{ everOpened = true; waitHint\.opened\(\); \}/.test(idx)
  && /onReady: \(\) => \{ everReady = true; waitHint\.ready\(\); \}/.test(idx));
ok("重试次数被记到循环外（attemptsMade）",
  /let attemptsMade = 0;/.test(idx) && /attemptsMade = attempt;/.test(idx));
ok("neverStarted 的判据 = 冷启动型报文 + 尝试用尽 + 从未 ready + 从未 opened",
  /const neverStarted = !!lastErr && isColdStart\(lastErr\)\s*\n\s*&& attemptsMade >= MAX_ATTEMPTS && !everReady && !everOpened;/.test(idx));
ok("neverStarted 时**不**再劝用户重发（岔路在冷启动文案之前）",
  idx.indexOf("const neverStarted =") > 0
  && idx.indexOf("reply = neverStarted") > idx.indexOf("const neverStarted =")
  && idx.indexOf("reply = neverStarted") < idx.indexOf("服务仍在启动中，本次未能及时响应"));
ok("neverStarted 文案指向容器日志组前缀，而不是编一个具体日志组名",
  /\/aws\/bedrock-agentcore\/runtimes\//.test(idx));
ok("neverStarted 文案点明 status: READY 不代表容器健康",
  /`status: READY` 当健康证明/.test(idx) && /not read the runtime's `status: READY` as a health signal/.test(idx));
ok("neverStarted 单独打一条日志（能与普通冷启动分开数），且只记类型不记原始报文",
  /agent runtime never became ready — attempts=\$\{attemptsMade\} `\s*\n\s*\+ `errType=\$\{lastErr\?\.name \|\| "\?"\}/.test(idx));
ok("neverStarted 文案里不出现任何原始报文变量插值（不许把 SDK 散文送进界面）",
  !/neverStarted[\s\S]{0,2600}\$\{lastErr\?\.message/.test(idx));

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
