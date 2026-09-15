/**
 * STAROps SSE 解析器单测（纯逻辑，不连网、不用 SDK）。
 * 运行：node bff/web-chat/tests/starops_sse.test.mjs
 *
 * 每一条断言对应 `starops_sse.mjs` 文件头里的一个 🔴 —— 那些坑全部来自 2026-09-09
 * 从阿里云 STAROps 控制台抓到的**真实事件流**，不是防御性想象。所以这个文件的价值在于：
 * 只要哪天线格式变了、或有人"顺手简化"了解析器，这里会红在**具体那一条**上。
 *
 * ⚠️ 下面的帧是从那份抓包**转录**并脱敏的（账号 UID 换成 1234567890123456）。
 *    转录可能有错字，所以它是**行为判据**，不是 golden fixture。真要做 golden fixture
 *    必须用脚本重抓一次 —— 见 docs/_aliyun-m0-evidence/starops-sse-wire-format.md §0。
 */
import {
  STAROPS_WIRE_VERSION, nsToMs, splitFrames, parseFrame, payloadKind,
  alreadySaid, summarizeToolArgs, summarizeToolResult, createStarOpsParser,
} from "../starops_sse.mjs";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`XX ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`XX ${name}`); } }

/* ── 测试用 sink：与 devops_chat.mjs::makeSink 同一契约（duck-typed）── */
function fakeSink() {
  const s = {
    reply: "", steps: [], progresses: [],
    say(t) { s.reply += t; },
    step(t, extra) { s.steps.push({ text: t, ...(extra || {}) }); },
    progress(t) { if (!s.reply) s.progresses.push(t); },
    gap() { if (s.reply && !/\n\n$/.test(s.reply)) s.say("\n\n"); },
  };
  return s;
}
const RID = "01A095CD-2D41-5843-A2E4-2280B9841CF5";
const TID = "fbd286ccccb34930a3e1f66cbcc5890e";
const THREAD = "thread-tl8ner-1owtwihkz5f6c";
const TURN = "01a095cd-35c1-7ee9-ab46-77fc7dd3c785";

/** 造一帧（`data:` 后面**没有空格** —— 与实测一致）。 */
function frame(payload, { callId = TURN, role = "assistant", version = STAROPS_WIRE_VERSION, ts = "1789219652666618780" } = {}) {
  return "data:" + JSON.stringify({
    messages: [{ parentCallId: "", callId, role, version, timestamp: ts, ...payload }],
    requestId: RID, traceId: TID,
  }) + "\n";
}
function run(frames, opts) {
  const sink = fakeSink();
  const warns = [];
  const p = createStarOpsParser(sink, { ...(opts || {}), onWarn: (m) => warns.push(m) });
  for (const f of [].concat(frames)) p.push(f);
  p.end();
  return { sink, state: p.state, warns };
}

/* ══════════════════ 1. 帧封装：`data:` 后面没有空格 ══════════════════ */

// 一条**逐字转录**的真实帧。这里刻意不用 frame() 构造 —— 它要钉住的正是"真实字节长这样"。
const RAW_SPIN = 'data:{"messages":[{"parentCallId":"","callId":"thread-tl8ner-1owtwihkz5f6c","role":"system","version":"v0.1.0","timestamp":"1789219647439710522","contents":[{"type":"spin_text","value":"让我为您查询相关信息...","append":false,"lastChunk":true}]}],"requestId":"01A095CD-2D41-5843-A2E4-2280B9841CF5","traceId":"fbd286ccccb34930a3e1f66cbcc5890e"}';
const env = parseFrame(RAW_SPIN);
ok("真实帧能解析（data: 后无空格）", !!env);
eq("requestId 取到", env.requestId, RID);
eq("traceId 取到", env.traceId, TID);
eq("载荷判别为 contents", payloadKind(env.messages[0]), "contents");
ok("SSE 规范的 `data: ` 带空格也吃", !!parseFrame('data: {"messages":[]}'));
// 反例：用 startsWith("data: ") 实现会让上面那条真实帧一条都匹配不上 —— 这就是原 bug。
ok("startsWith('data: ') 会漏掉真实帧（说明为什么用正则）", !RAW_SPIN.startsWith("data: "));

ok("非 data 行忽略（event:）", parseFrame("event: message") === null);
ok("非 data 行忽略（注释心跳）", parseFrame(": keep-alive") === null);
ok("空行忽略", parseFrame("") === null);
ok("[DONE] 忽略", parseFrame("data:[DONE]") === null);
ok("坏 JSON 静默跳过、不抛", parseFrame("data:{not json") === null);
ok("没有 messages 数组的 JSON 不算帧", parseFrame('data:{"foo":1}') === null);

/* ══════════════════ 2. chunk 边界与帧边界无关 ══════════════════ */

const sf = splitFrames("data:{}\ndata:{\"a\"");
eq("完整行切出来", sf.lines, ["data:{}"]);
eq("半行留在 rest", sf.rest, 'data:{"a"');

{
  // 把一帧从**中间**劈成两个 chunk，仍要解析出来。
  const whole = frame({ contents: [{ type: "text", value: "你好世界", append: true, lastChunk: false }] });
  const cut = Math.floor(whole.length / 2);
  const { sink } = run([whole.slice(0, cut), whole.slice(cut)]);
  eq("跨 chunk 的半帧能拼回来", sink.reply, "你好世界");
}

/* ══════════════════ 3. spin_text 是转场提示，不是正文 ══════════════════ */
{
  const { sink } = run([
    frame({ contents: [{ type: "spin_text", value: "让我为您查询相关信息...", append: false, lastChunk: true }] },
      { callId: THREAD, role: "system" }),
    frame({ contents: [{ type: "text", value: "巡检结果如下", append: true, lastChunk: false }] }),
  ]);
  eq("spin_text 进瞬态进度", sink.progresses, ["让我为您查询相关信息..."]);
  eq("spin_text **不进正文**", sink.reply, "巡检结果如下");
  ok("正文里没有 spinner 文案", !sink.reply.includes("让我为您查询"));
}

/* ══════════════════ 4. text 的 lastChunk:true 不是结束信号 ══════════════════ */
{
  // 实测形态：正文分段，每段末尾一个 value:"" + lastChunk:true，然后**继续**发正文。
  // 一轮里出现 6 次。把它当结束会在第一次工具调用处截断答案。
  const frames = [];
  for (const seg of ["第一段。", "第二段。", "第三段。"]) {
    frames.push(frame({ contents: [{ type: "text", value: seg, append: true, lastChunk: false }] }));
    frames.push(frame({ contents: [{ type: "text", value: "", append: true, lastChunk: true }] }));
  }
  const { sink, state } = run(frames);
  eq("lastChunk:true 之后的正文没丢", sink.reply, "第一段。第二段。第三段。");
  ok("没收到 stream_done → done 仍为 false", state.done === false);
}

/* ══════════════════ 5. 思考与正文交错、顺序不保证 ══════════════════ */
{
  // 🔴 实测：下面第 3 帧那条 thinking 的时间戳**晚于**第 2 帧的第一段正文（`ts` 逐位照抄自
  //    真实回放，纳秒级）。「思考结束→正文开始」的状态机会在这里丢内容。
  //    ⚠️ 注释里别再贴时间戳的**尾 12 位**：`bff/` 整目录随开源包发布，而连续 12 位数字会被
  //    publish-scan 当成疑似 AWS account id 拦下（2026-09-13 实测因此红过一次）。
  const { sink } = run([
    frame({ events: [{ type: "thinking", payload: { lastChunk: false, reasoningDelta: "The user wants " } }] }, { ts: "1789219651379893052" }),
    frame({ contents: [{ type: "text", value: "我来", append: true, lastChunk: false }] }, { ts: "1789219652666618780" }),
    frame({ events: [{ type: "thinking", payload: { lastChunk: true, reasoningDelta: "an ECS inspection." } }] }, { ts: "1789219652875586546" }),
    frame({ contents: [{ type: "text", value: "帮你查。", append: true, lastChunk: false }] }, { ts: "1789219653000000000" }),
  ]);
  eq("正文完整（交错没吃掉后半段）", sink.reply, "我来帮你查。");
  ok("思考**不进正文**", !sink.reply.includes("ECS inspection"));
  const th = sink.steps.filter((s) => s.kind === "thinking");
  eq("思考块按 lastChunk 收成一条过程行", th.length, 1);
  eq("思考增量按到达顺序拼接", th[0].text, "The user wants an ECS inspection.");
}

/* ══════════════════ 6. artifacts 是全文副本 → 必须丢 ══════════════════ */
{
  const answer = "巡检需要 region、project 和 metricstore 三个参数，请补充。";
  const { sink } = run([
    frame({ contents: [{ type: "text", value: answer, append: true, lastChunk: false }] }),
    frame({
      artifacts: [{
        artifactId: "art-redacted", name: "Result",
        metadata: { is_final: true, vibeops_send_to_user: false },
        parts: [{ kind: "text", text: answer }],
      }],
    }),
  ]);
  eq("答案只说一遍", sink.reply, answer);
}
{
  // 换行/空白有差异的全文副本也要认出来（归一化比较）。
  const { sink } = run([
    frame({ contents: [{ type: "text", value: "第一行\n第二行", append: true, lastChunk: false }] }),
    frame({ artifacts: [{ artifactId: "a", name: "Result", metadata: { is_final: true }, parts: [{ kind: "text", text: "第一行\n\n第二行\n" }] }] }),
  ]);
  eq("空白差异的副本也丢掉", sink.reply, "第一行\n第二行");
}
{
  // 失败安全：增量一条都没到时，artifact 就是**唯一的答案** —— 那时必须说出来。
  const { sink } = run([
    frame({ artifacts: [{ artifactId: "a", name: "Result", metadata: { is_final: true }, parts: [{ kind: "text", text: "只有产物没有增量" }] }] }),
  ]);
  eq("没有增量时 artifact 当答案（不许整轮空白）", sink.reply, "只有产物没有增量");
}
ok("alreadySaid 忽略空白差异", alreadySaid("abc def", "abcdef"));
ok("alreadySaid 空串不算说过", alreadySaid("abc", "") === false);

/* ══════════════════ 7. 工具：按 toolCallId 匹配，乱序也要对 ══════════════════ */
{
  const A = "call_aaaaaaaaaaaaaaaaaaaaaaaa", B = "call_bbbbbbbbbbbbbbbbbbbbbbbb";
  const { sink } = run([
    // 并行发出（时间戳几乎相同）
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: A, arguments: { command: "starops umodel list --kinds aliyun_prometheus -o json" }, status: "start" }] }, { ts: "1789219660677154749" }),
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: B, arguments: { command: "starops umodel list --kinds storage_link -o json" }, status: "start" }] }, { ts: "1789219660677227111" }),
    // 结果**乱序**回来：B 先 A 后
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: B, status: "success", contents: [{ type: "text", value: "## Exec Result\n\n**Request ID**: rq\n\n**Output**:\n```\n{\"nodes\":null}\n```\n\nExecution completed." }] }] }),
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: A, status: "success", contents: [{ type: "text", value: "## Exec Result\n\n**Request ID**: rq\n\n**Output**:\n```\n{\"links\":null}\n```\n\nExecution completed." }] }] }),
  ]);
  const res = sink.steps.filter((s) => s.kind === "tool_result");
  eq("两个结果都配上了", res.length, 2);
  eq("先回的是 B", res[0].toolCallId, B);
  eq("后回的是 A", res[1].toolCallId, A);
  ok("B 的结果体是 storage_link 那次", res[0].text.includes("nodes"));
  ok("A 的结果体是 prometheus 那次", res[1].text.includes("links"));
  ok("两次都没被判失败", res.every((r) => r.failed === false));
}

/* ══════════════════ 8. status:"success" ≠ 工具成功 ══════════════════ */
{
  const C = "call_cccccccccccccccccccccccc";
  const { sink } = run([
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: C, arguments: { command: "starops umodel list" }, status: "start" }] }),
    // 🔴 实测：status 是 success，结果体里写着 exit code 5。
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: C, status: "success", contents: [{ type: "text", value: "## Exec Result\n\n**Request ID**: rq\n\n**Error**: exit code 5\n\n**Output**:\n```\nno workspace\n```\n\nExecution completed." }] }] }),
  ]);
  const r = sink.steps.find((s) => s.kind === "tool_result");
  ok("status:success 但结果体报错 → 判为失败", r.failed === true);
  ok("失败原因进过程行", r.text.includes("exit code 5"));
}
eq("summarizeToolResult 认出失败", summarizeToolResult("**Error**: exit code 5\n**Output**:\n").failed, true);
eq("正文里出现 Error 字样不算失败", summarizeToolResult("Read config (50 lines) no Error here").failed, false);

/* ══════════════════ 9. 入参绝不整坨 JSON 抖进面板 ══════════════════ */
eq("Bash 只报命令", summarizeToolArgs("Bash", { command: "ls -la /tmp" }), "ls -la /tmp");
eq("Read 只报路径", summarizeToolArgs("Read", { file_path: "/home/starops/skills/builtin/ecs/ecs-inspection/SKILL.md" }),
  "/home/starops/skills/builtin/ecs/ecs-inspection/SKILL.md");
eq("TodoWrite 报步数 + 当前步",
  summarizeToolArgs("TodoWrite", { steps: [{ status: "completed", step: "读技能" }, { status: "in_progress", step: "查 UModel" }, { status: "pending", step: "出结论" }] }),
  "3 步 · 查 UModel");
eq("未知工具不猜入参含义", summarizeToolArgs("SomeNewTool", { secret: "x" }), "");
{
  const D = "call_dddddddddddddddddddddddd";
  const { sink } = run([frame({ tools: [{ id: "Read", name: "Read", toolCallId: D, arguments: { file_path: "/a/b.md" }, status: "start" }] })]);
  const s = sink.steps.find((x) => x.kind === "tool");
  ok("过程行里没有裸 JSON 大括号", !/[{}]/.test(s.text));
  eq("过程行形如 名字: 摘要", s.text, "Read: /a/b.md");
}

/* ══════════════════ 10. 纳秒，不是毫秒 ══════════════════ */
eq("duration 26581599305ns = 26581.599305ms", nsToMs("26581599305"), 26581.599305);
ok("26.58 秒（不是 307 天）", Math.round(nsToMs("26581599305") / 1000) === 27);
eq("非法值退 0", nsToMs("abc"), 0);
eq("undefined 退 0", nsToMs(undefined), 0);

/* ══════════════════ 11. 收尾：stream_done 是唯一结束信号 ══════════════════ */
{
  const { sink, state } = run([
    frame({ contents: [{ type: "text", value: "答案", append: true, lastChunk: true }] }),
    frame({ events: [{ type: "task_finished", payload: { statistics: { duration: 26581599305 }, success: true } }] }, { callId: THREAD, role: "system" }),
    frame({ events: [{ type: "stream_done", payload: null }] }, { callId: THREAD, role: "system" }),
  ]);
  ok("stream_done → done", state.done === true);
  eq("task_finished 的墙钟换成毫秒", Math.round(state.durationMs), 26582);
  eq("success 记下来", state.success, true);
  eq("正文不受收尾帧影响", sink.reply, "答案");
}
{
  // payload:null 不许崩（stream_done 实测就是 null，不是 {}）
  let threw = false;
  try { run([frame({ events: [{ type: "stream_done", payload: null }] })]); } catch { threw = true; }
  ok("payload:null 不抛", threw === false);
}
{
  const { state } = run([frame({ events: [{ type: "task_finished", payload: { statistics: { duration: 1e9 }, success: false } }] })]);
  eq("success:false 如实记录", state.success, false);
}

/* ══════════════════ 12. 版本变化：大声，但不丢答案 ══════════════════ */
{
  const { sink, warns } = run([
    frame({ contents: [{ type: "text", value: "新版本的答案", append: true, lastChunk: false }] }, { version: "v0.2.0" }),
    frame({ contents: [{ type: "text", value: "继续", append: true, lastChunk: false }] }, { version: "v0.2.0" }),
  ]);
  ok("未知版本发出告警", warns.some((w) => w.includes("v0.2.0")));
  eq("告警只发一次（不是每帧一条）", warns.filter((w) => w.includes("unexpected wire version")).length, 1);
  ok("面板上有一条显眼提示", sink.steps.some((s) => s.kind === "warning"));
  eq("答案照旧完整（不丢答案）", sink.reply, "新版本的答案继续");
}

/* ══════════════════ 13. 未知类型 → 当正文（失败安全）══════════════════ */
{
  const { sink, warns } = run([frame({ contents: [{ type: "markdown_v2", value: "这是答案", append: true }] })]);
  eq("未知 content 类型当正文（宁可多显示，不能把答案藏进面板）", sink.reply, "这是答案");
  ok("同时发告警", warns.some((w) => w.includes("markdown_v2")));
}
{
  const { sink, warns } = run([frame({ events: [{ type: "brand_new_event", payload: {} }] })]);
  eq("未知 event 不进正文", sink.reply, "");
  ok("未知 event 发告警", warns.some((w) => w.includes("brand_new_event")));
}
{
  // 真服务每轮都发 thread_title_updated（2026-09-13 对 cn-beijing 实测）。
  // 它不是未知帧 —— 不显式认掉就是每轮一条假告警。
  const { sink, warns } = run([frame({ events: [{ type: "thread_title_updated", payload: { title: "ECS 巡检" } }] })]);
  eq("会话标题帧不进正文（标题由 store.mjs 自己管）", sink.reply, "");
  eq("会话标题帧不发告警", warns.length, 0);
}
eq("四个载荷都空 → 无载荷帧，不崩", run([frame({ contents: [] })]).sink.reply, "");

/* ══════════════════ 14. 流被掐断：工具没回来要说出来 ══════════════════ */
{
  const { sink, state } = run([
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: "call_e", arguments: { command: "x" }, status: "start" }] }),
    frame({ tools: [{ id: "Read", name: "Read", toolCallId: "call_f", arguments: { file_path: "/y" }, status: "start" }] }),
  ]);
  ok("没有 stream_done → done 为 false（调用方据此告诉用户这轮不完整）", state.done === false);
  const w = sink.steps.find((s) => s.kind === "warning");
  ok("残留的 pending 工具被报出来", !!w && w.text.includes("2 个"));
  ok("报出具体是哪两个", w.text.includes("Bash") && w.text.includes("Read"));
}
{
  const { sink } = run([frame({ events: [{ type: "thinking", payload: { lastChunk: false, reasoningDelta: "half a thought" } }] })]);
  eq("流断了也要把未收口的思考块吐出来", sink.steps.filter((s) => s.kind === "thinking").length, 1);
}

/* ══════════════════ 15. 英文界面 ══════════════════ */
{
  const { sink } = run([frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: "call_g", arguments: { command: "x" }, status: "start" }] })], { en: true });
  const w = sink.steps.find((s) => s.kind === "warning");
  ok("英文下告警是英文", !!w && /did not return/.test(w.text));
}
{
  // 🔴 工具**结果行**原来是中文硬编码（`失败:` / `完成`），英文界面下面板中英混排。
  //    这两句是每轮都出现好几次的行 —— 漏翻的可见度比告警高得多。
  const G = "call_gggggggggggggggggggggggg", H = "call_hhhhhhhhhhhhhhhhhhhhhhhh";
  const { sink } = run([
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: G, arguments: { command: "x" }, status: "start" }] }),
    // 结果体为空 → 走"没摘要"那一档（中文是「完成」）
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: G, status: "success", contents: [] }] }),
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: H, arguments: { command: "y" }, status: "start" }] }),
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: H, status: "success", contents: [{ type: "text", value: "**Error**: exit code 5" }] }] }),
  ], { en: true });
  const res = sink.steps.filter((s) => s.kind === "tool_result");
  eq("英文下「完成」→ done", res[0].text, "Bash → done");
  eq("英文下「失败:」→ failed:", res[1].text, "Bash failed: exit code 5");
  ok("英文界面里不许出现中文", !/[一-鿿]/.test(res.map((r) => r.text).join("")));
}
{
  // 反向：中文界面照旧是中文（别把上面那条修成"永远英文"）。
  const I = "call_iiiiiiiiiiiiiiiiiiiiiiii";
  const { sink } = run([
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: I, arguments: { command: "x" }, status: "start" }] }),
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: I, status: "success", contents: [] }] }),
  ]);
  eq("中文界面照旧", sink.steps.find((s) => s.kind === "tool_result").text, "Bash → 完成");
}

/* ══════════════════ 17. agents[]：官方 schema 的第 5 个数组 ══════════════════ */
//
// 🔴 第一版的 payloadKind 只列了 4 个数组、switch 的 default 直接 break —— 于是服务端一发
//    `agents[]`（多数字员工协作），这一帧就**一声不响地整帧丢掉**。我们没实测过它的字段
//    形状，所以口径是"认得出来、说一句、但不当正文渲染"。
eq("agents 进了判别式", payloadKind({ agents: [{ name: "x" }] }), "agents");
eq("载荷判别顺序不变（contents 优先）", payloadKind({ contents: [{ type: "text", value: "a" }], agents: [{ name: "x" }] }), "contents");
eq("空 agents 不算载荷", payloadKind({ agents: [] }), null);
{
  const { sink, warns } = run([
    frame({ agents: [{ name: "ecs-inspector" }, { digitalEmployeeName: "rds-inspector" }] }),
    frame({ contents: [{ type: "text", value: "答案照旧", append: true, lastChunk: false }] }),
  ]);
  ok("发告警（调用方日志里能看到）", warns.some((w) => w.includes("unhandled payload kind: agents")));
  const w = sink.steps.find((s) => s.kind === "warning");
  ok("面板上如实说一句", !!w && w.text.includes("agents"));
  ok("两个名字都报出来", w.text.includes("ecs-inspector") && w.text.includes("rds-inspector"));
  ok("**不猜字段形状去渲染正文**", !sink.reply.includes("ecs-inspector"));
  eq("正文只有真的正文（没被这一帧带偏）", sink.reply, "答案照旧");
}
{
  // 多数字员工场景下它可能每帧都来 —— 只警告一次，否则面板刷一屏。
  const f = frame({ agents: [{ name: "a" }] });
  const { sink, warns } = run([f, f, f]);
  eq("告警只发一次", warns.filter((w) => w.includes("agents")).length, 1);
  eq("面板也只有一条", sink.steps.filter((s) => s.kind === "warning").length, 1);
}
{
  const { sink } = run([frame({ agents: [{ name: "a" }] })], { en: true });
  ok("英文界面是英文", /multi-agent frame/.test(sink.steps.find((s) => s.kind === "warning").text));
}
{
  // 名字一个都取不到时不许留个空冒号（`：` 后面什么都没有）。
  const { sink } = run([frame({ agents: [{}, "junk", null] })]);
  const w = sink.steps.find((s) => s.kind === "warning");
  ok("拿不到名字也不崩", !!w);
  ok("没有悬空的冒号", !/：\s*。$/.test(w.text) && !w.text.includes("：。"));
}

/* ══════════════════ 16. 工具穿插时正文段落不粘连 ══════════════════ */
{
  const { sink } = run([
    frame({ contents: [{ type: "text", value: "先说一段", append: true, lastChunk: true }] }),
    frame({ tools: [{ id: "Bash", name: "Bash", toolCallId: "call_h", arguments: { command: "x" }, status: "start" }] }),
    frame({ artifacts: [{ artifactId: "a", name: "Result", metadata: { is_final: true }, parts: [{ kind: "text", text: "完全不同的最终产物" }] }] }),
  ]);
  ok("段落之间插了空行", sink.reply.includes("\n\n"));
  eq("两段都在", sink.reply, "先说一段\n\n完全不同的最终产物");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
