/**
 * web 深度调查（直连）的「调查过程（Trace）」页（trace_html.mjs + devops_investigate.mjs 的
 * uiTimelineFrom / 收尾那段）。
 *
 * 背景（2026-10-13，用户报的）：IM 报告卡一直有「🔍 调查过程 Trace」，web 调查结束只有
 * 「在线查看报告」。web 改成自己渲染同一个页面（trace_template.py 的逐行移植）。
 *
 * 这份测试钉住移植时最容易「改坏了不报错」的几处：
 *   1. **emoji 不能被删**。Python 版的 `_esc` 去掉所有 \ud800-\udfff，在 Python 里只会碰到
 *      落单代理项；JS 字符串里 emoji 本身就是代理对，照抄就把 emoji 全删了。
 *   2. **先转义再套记号**（mdLite），否则就是 XSS。
 *   3. **时间线卡不许退化到第一张卡**：那是执行摘要卡，退化会让调查过程页显示报告正文的复制品。
 *   4. 收尾时真的把链接发出去、而且生成失败时**明说**（不静默少一个链接）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let fails = 0;
// ⚠️ `ok` 是**通过数**，收尾必须和 `0 failed` 一起打（package.json 的守卫靠它判「真的跑了」）。
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}

const { renderTrace, mdLite, __test } = await import("../trace_html.mjs");
const { uiTimelineFrom } = await import("../devops_investigate.mjs");
const { esc, cpSlice, parseRecord, typeToCss } = __test;

const rec = (recordType, content, extra = {}) => ({
  recordType, recordId: `rec-${recordType}-0123456789abcdef`, createdAt: new Date("2026-10-13T04:05:06Z"),
  content: typeof content === "string" ? content : JSON.stringify(content), ...extra,
});

await t("esc 保留 emoji、只去掉落单代理项", () => {
  assert.equal(esc("🔍 调查"), "🔍 调查");
  assert.equal(esc("a\uD800b"), "ab");            // 落单高代理
  assert.equal(esc("a\uDC00b"), "ab");            // 落单低代理
  assert.equal(esc(`<b a="1">&'`), "&lt;b a=&quot;1&quot;&gt;&amp;'");   // 与 Python 版同：不转单引号
});

await t("按码点截断，不把 emoji 劈成两半", () => {
  assert.equal(cpSlice("😀😀😀", 2), "😀😀");
  assert.equal(cpSlice("abc", 5), "abc");
});

await t("mdLite：先转义再套记号", () => {
  const html = mdLite("### **步骤** `<script>`\n- 查 <img src=x onerror=alert(1)>\n普通段落");
  assert.ok(html.includes("<h3><strong>步骤</strong> <code>&lt;script&gt;</code></h3>"), html);
  assert.ok(html.includes("<ul>\n<li>查 &lt;img src=x onerror=alert(1)&gt;</li>\n</ul>"), html);
  assert.ok(html.includes("<p>普通段落</p>"), html);
  assert.ok(!html.includes("<script>") && !html.includes("<img"), html);
  assert.equal(mdLite("   "), "");
});

await t("parseRecord：五种 content block 与截断", () => {
  const [role, , body] = parseRecord(JSON.stringify({
    role: "assistant",
    content: [
      { type: "text", text: "结论 <x>" },
      { type: "thinking", thinking: "想".repeat(2500) },
      { type: "tool_use", tool_name: "aws_cli", input: { cmd: "ec2 describe-instances" } },
      { type: "tool_result", id: "t1", content: [{ text: "r".repeat(10500) }] },
      { type: "weird", foo: 1 },
    ],
  }), "message");
  assert.equal(role, "assistant");
  assert.ok(body.includes("<b>[text]</b>\n结论 &lt;x&gt;"), "text 块要转义");
  assert.ok(body.includes("... (2500 chars total)"), "thinking 超 2000 要标总长");
  assert.ok(body.includes("<b>[tool_use: aws_cli]</b>") && body.includes("&quot;cmd&quot;"), "tool_use 带入参 JSON");
  assert.ok(body.includes("... (10500 chars total, truncated)"), "tool_result 超 10000 要截断");
  assert.ok(body.includes("<b>[weird]</b>"), "未知块类型原样标出");
  // 不是 JSON 的 content → 原文转义
  assert.deepEqual(parseRecord("<raw>", "note"), ["note", "note", "&lt;raw&gt;"]);
});

await t("typeToCss 与 Python 版同口径", () => {
  assert.equal(typeToCss("user"), "user");
  assert.equal(typeToCss("TOOL_USE_REQUEST"), "tool-use");
  assert.equal(typeToCss("tool-result"), "tool-result");
  assert.equal(typeToCss("agent_thinking"), "thinking");
  assert.equal(typeToCss("system_event"), "system");
  assert.equal(typeToCss("investigation_summary_md"), "other");
});

await t("整页：标题 / 元数据转义、两段标题、长正文折叠", () => {
  const html = renderTrace({
    records: [rec("message", { role: "user", content: "查一下 <CPU>" }),
              rec("message", { role: "assistant", content: [{ type: "text", text: "x".repeat(800) }] })],
    status: "COMPLETED", taskId: "task-<1>", executionId: "exe-1", agentSpaceId: "as-1",
    title: "为什么 <script>alert(1)</script> CPU 打满  了", timelineMd: "### 第一步\n- 看指标",
    detailType: "Investigation Completed", locale: "zh",
  });
  assert.ok(!html.includes("<script>alert(1)"), "标题必须转义");
  assert.ok(html.includes("为什么 &lt;script&gt;alert(1)&lt;/script&gt; CPU 打满 了"), "标题空白要归一");
  assert.ok(html.includes("task-&lt;1&gt;"), "task id 要转义");
  assert.ok(html.includes("<h2>Investigation Timeline</h2>") && html.includes("<h2>Raw Journal Records</h2>"),
    "有 DA 时间线时下面那段改叫 Raw Journal Records");
  assert.ok(html.includes("Total steps: <strong>2</strong>"));
  assert.ok(html.includes("04:05:06"), "Date 型 createdAt 取 UTC 的 HH:MM:SS");
  assert.ok(html.includes("entry-body collapsed") && html.includes("toggle-btn"), "超 500 字符的正文默认折叠");
  assert.ok(html.includes("#10b981"), "COMPLETED 用绿色徽章");
});

await t("没有 DA 时间线卡时只有一段、沿用原标题", () => {
  const html = renderTrace({ records: [rec("message", { role: "user", content: "hi" })], status: "FAILED" });
  assert.ok(!html.includes("Raw Journal Records") && html.includes("<h2>Investigation Timeline</h2>"));
  assert.ok(html.includes("#ef4444"));
});

await t("空态：「取失败」和「确实没有」是两句不同的话（中英）", () => {
  const none = renderTrace({ records: [], locale: "zh" });
  assert.ok(none.includes("本次调查没有留下逐步记录"), none);
  const failed = renderTrace({ records: [], fetchErrors: ["AccessDenied <x>"], locale: "en" });
  assert.ok(failed.includes("Could not read the investigation records") && failed.includes("AccessDenied &lt;x&gt;"));
  assert.ok(!failed.includes("本次调查"), "英文界面不该出中文");
});

const tree = (cards) => rec("ui_investigation_summary", { content: { type: "container", children: cards } });
const card = (id, text) => ({ type: "card", id, children: [{ type: "markdown", text }] });

await t("uiTimelineFrom 取 id 前缀为 records 的那张卡、取最后一条记录", () => {
  const recs = [
    tree([card("summary__x", "旧摘要"), card("records__acc", "旧时间线")]),
    tree([card("summary__x", "执行摘要"), card("records__acc", "第 1 步：看 CPU")]),
  ];
  assert.equal(uiTimelineFrom(recs), "第 1 步：看 CPU");
});

await t("uiTimelineFrom 没有时间线卡时返回空，**不**退化成摘要卡", () => {
  assert.equal(uiTimelineFrom([tree([card("summary__x", "执行摘要")])]), "");
  assert.equal(uiTimelineFrom([]), "");
});

// ── 收尾那段：真的发链接，失败时明说（源码层断言 —— 那段要真 S3 才跑得起来）──
const src = readFileSync(new URL("../devops_investigate.mjs", import.meta.url), "utf8");

await t("收尾把调查过程链接发出去（聊天正文 + Sources）", () => {
  assert.ok(src.includes("saveTraceHtml({ records: summary.records"), "收尾没调 saveTraceHtml");
  assert.ok(src.includes("[调查过程 Trace](${trace.url})") && src.includes("[Investigation trace](${trace.url})"),
    "聊天里没有调查过程链接（中英都要有）");
  assert.ok(/sources\.push\(\{ icon: "file", title: dv\(`DevOps Agent 调查过程/.test(src), "Sources 里没有调查过程");
});

await t("调查过程页没生成出来时明说，不静默少一个链接", () => {
  assert.ok(src.includes("调查过程页这次没生成出来") && src.includes("could not be generated this time"));
});

await t("报告与调查过程共用完整 UUID 的 key（URL 即凭证）", () => {
  assert.ok(src.includes("-${randomUUID()}`"), "key 里应是完整 UUID");
  assert.ok(!src.includes("randomUUID().slice(0, 8)"), "还在用 8 位截断的 UUID");
  assert.ok(src.includes("`${keyBase}-trace.html`") && src.includes("`${keyBase}.html`"));
});

await t("getInvestigationSummary 把 journal 记录带出来（收尾不再拉第二遍）", () => {
  assert.ok(/taskId, records \};/.test(src), "summary 里没有 records");
});

console.log(fails ? `\n${fails} FAILED` : `\nPASSED: ${ok} ok, 0 failed`);
process.exit(fails ? 1 : 0);
