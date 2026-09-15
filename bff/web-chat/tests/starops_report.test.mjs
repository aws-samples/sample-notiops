/**
 * STAROps 报告网页化单测。运行：node bff/web-chat/tests/starops_report.test.mjs
 *
 * 为什么这个文件值得存在：`starops_report.mjs` 会拿**模型生成的文本里的 URL** 去发一次
 * 服务端请求。那是这条路径上唯一能被外部内容牵着走的地方（SSRF），而它的失败是**静默**的
 * —— 抓错了地址，客户看不见、日志里（按设计）也不许出现 URL。所以那四道闸门只能靠这里钉住。
 *
 * 其余各节钉的是"发出去就改不了"的措辞类事实：
 *   · 抓不到完整报告时**不许**说「完整报告」（否则客户点开发现是摘要，等于我们撒谎）；
 *   · 「7 天内有效」必须与 `expire-reports-7d` 那条生命周期一致；
 *   · 未配报告 CDN 时返回 null，而不是编一个链接。
 *
 * ⚠️ 里面所有 URL 都是**构造的假串**，不含任何真实签名/桶名。
 */
import {
  REPORT_VALID_DAYS, FETCH_MAX_BYTES, MIN_REPORT_CHARS, MIN_STANDALONE_CHARS, MAX_MD_CHARS,
  extractAliyunReportUrls, isFetchableReportUrl, fetchReportMarkdown,
  clipMd, reportTitle, provenanceBlock, reportLinkLine, saveStarOpsHtmlReport,
  starOpsReportSuffix,
} from "../starops_report.mjs";
import { renderReport } from "../report_html.mjs";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { pass++; } else { fail++; console.log(`XX ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`XX ${name}`); } }

const OSS = "https://notiops-x.oss-cn-beijing.aliyuncs.com/report/abc.md?Expires=1&Signature=fake";

/* ───────────────── 闸门 ①②：允许清单（这一节是 SSRF 的全部防线）───────────────── */
{
  ok("正常的阿里云 OSS md 链接放行", isFetchableReportUrl(OSS));
  ok("允许 .markdown 扩展名", isFetchableReportUrl("https://b.oss-cn-hangzhou.aliyuncs.com/a.markdown"));

  // 主机名：必须**后缀**匹配。下面这条是最容易写错的一条 —— 用 includes/indexOf 就会放行。
  ok("aliyuncs.com.evil.tld 不放行（后缀而非包含）",
    !isFetchableReportUrl("https://aliyuncs.com.evil.tld/a.md"));
  ok("aliyuncs.com 裸域不放行（没有子域前缀）", !isFetchableReportUrl("https://aliyuncs.com/a.md"));
  ok("其它公网域名不放行", !isFetchableReportUrl("https://example.com/a.md"));

  // 协议 / 端口 / 凭据：三种经典绕过。
  ok("http 不放行", !isFetchableReportUrl("http://b.oss-cn-beijing.aliyuncs.com/a.md"));
  ok("file: 不放行", !isFetchableReportUrl("file:///etc/passwd"));
  ok("非 443 端口不放行", !isFetchableReportUrl("https://b.oss-cn-beijing.aliyuncs.com:8080/a.md"));
  ok("userinfo@ 不放行（真实主机是 @ 右边那个）",
    !isFetchableReportUrl("https://b.oss-cn-beijing.aliyuncs.com@169.254.169.254/a.md"));

  // 元数据地址（最坏情况）：既不是 https+允许域，也不是 .md，两道都拦。
  ok("EC2 元数据地址不放行", !isFetchableReportUrl("http://169.254.169.254/latest/meta-data/"));

  // 扩展名：只认 markdown。抓别的东西没有意义，也就没有理由承担风险。
  ok("非 .md 不放行", !isFetchableReportUrl("https://b.oss-cn-beijing.aliyuncs.com/a.zip"));
  ok("路径以 .md 结尾 + query 仍放行（签名参数在 query 里）",
    isFetchableReportUrl("https://b.oss-cn-beijing.aliyuncs.com/a.md?x=1"));
  ok("query 里带 .md 但路径不是 → 不放行",
    !isFetchableReportUrl("https://b.oss-cn-beijing.aliyuncs.com/a.zip?f=x.md"));
  ok("垃圾串不放行（URL 解析失败不抛）", !isFetchableReportUrl("not a url"));
  ok("空值不放行", !isFetchableReportUrl(undefined));
}

/* ───────────────── 从答案正文里挑链接 ───────────────── */
{
  const md = `巡检完成。\n\n[查看完整巡检报告](${OSS})（链接支持免密访问，7 天有效）\n\n另见 https://example.com/x.md`;
  eq("markdown 链接能取出、非允许域被丢掉", extractAliyunReportUrls(md), [OSS]);

  const dup = `${OSS} 和 ${OSS}`;
  eq("同一条链接只取一次", extractAliyunReportUrls(dup).length, 1);

  // 中文句读紧跟 URL 是常见写法：正则的收尾字符集必须把它们排除，否则 URL 尾巴粘上标点，
  // 扩展名判断随之失败 —— 表现是"明明有报告却不生成网页"。
  eq("中文句号紧跟时不把标点吃进 URL",
    extractAliyunReportUrls(`报告：https://b.oss-cn-beijing.aliyuncs.com/a.md。`),
    ["https://b.oss-cn-beijing.aliyuncs.com/a.md"]);
  eq("没有链接时返回空数组", extractAliyunReportUrls("普通回答，没有报告。"), []);
  eq("空输入不抛", extractAliyunReportUrls(undefined), []);
}

/* ───────────────── 闸门 ③④：抓取行为 ───────────────── */
{
  // 闸门 ③：必须以 redirect:"error" 发出去。跟随重定向 = 前两道闸门作废。
  let seen = null;
  await fetchReportMarkdown(OSS, {
    fetchImpl: async (u, o) => { seen = o; return { ok: true, headers: { get: () => null }, text: async () => "# hi" }; },
  });
  eq("不跟随重定向", seen?.redirect, "error");
  ok("带 AbortSignal（超时能真断）", Boolean(seen?.signal));

  // 非 200 → 空串，不抛（报告是加分项，不许毁掉答案）。
  const notOk = await fetchReportMarkdown(OSS, {
    fetchImpl: async () => ({ ok: false, status: 403, headers: { get: () => null }, text: async () => "x" }),
  });
  eq("403 → 空串", notOk, "");

  // fetch 直接抛（DNS/超时/被重定向拦下）→ 空串。
  const threw = await fetchReportMarkdown(OSS, { fetchImpl: async () => { throw new TypeError("boom"); } });
  eq("fetch 抛异常 → 空串", threw, "");

  // 闸门 ④：content-length 与 body 两道体积上限都要生效。
  const byLen = await fetchReportMarkdown(OSS, {
    maxBytes: 10,
    fetchImpl: async () => ({ ok: true, headers: { get: (k) => (k === "content-length" ? "999" : null) }, text: async () => "x".repeat(999) }),
  });
  eq("content-length 超限 → 空串", byLen, "");
  const byBody = await fetchReportMarkdown(OSS, {
    maxBytes: 10,
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, text: async () => "x".repeat(999) }),
  });
  eq("没有 content-length 时按 body 长度拦", byBody, "");

  // 不在允许清单里的 URL：**一次请求都不许发**。
  let called = 0;
  const blocked = await fetchReportMarkdown("https://evil.tld/a.md", {
    fetchImpl: async () => { called++; return { ok: true, headers: { get: () => null }, text: async () => "x" }; },
  });
  eq("非允许域一次请求都不发", called, 0);
  eq("非允许域 → 空串", blocked, "");

  // 🔒 日志里不许出现整条 URL（签名是凭据）。
  const warns = [];
  await fetchReportMarkdown(OSS, {
    fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => null }, text: async () => "" }),
    onWarn: (m) => warns.push(m),
  });
  ok("失败日志不含签名 URL", warns.length > 0 && !warns.join(" ").includes("Signature"));
  ok("失败日志含主机名与状态码（可定位）", /host=.*aliyuncs\.com/.test(warns.join(" ")) && /status=500/.test(warns.join(" ")));
}

/* ───────────────── 措辞：不许把摘要说成「完整报告」 ───────────────── */
{
  const full = reportLinkLine({ url: "https://cdn/x.html", locale: "zh", full: true });
  const part = reportLinkLine({ url: "https://cdn/x.html", locale: "zh", full: false });
  ok("抓到原文才说「完整报告」", full.includes("完整报告"));
  ok("没抓到就不说「完整」", !part.includes("完整"));
  ok("两种文案都写明 7 天内有效", full.includes(`${REPORT_VALID_DAYS} 天`) && part.includes(`${REPORT_VALID_DAYS} 天`));
  eq("生命周期与 expire-reports-7d 一致", REPORT_VALID_DAYS, 7);
  const en = reportLinkLine({ url: "https://cdn/x.html", locale: "en", full: true });
  ok("英文文案也说明有效期", /valid 7 days/.test(en) && /full report/.test(en));

  // 来源说明：这份网页挂在 NotiOps 域名下，内容却是客户自己的数字员工产的 —— 必须写清楚。
  const prov = provenanceBlock({ locale: "zh", employee: "apsara-ops", full: true });
  ok("来源块点名数字员工 ID", prov.includes("apsara-ops"));
  ok("来源块说明 NotiOps 不改写内容", prov.includes("不复核") || prov.includes("不改写"));
  ok("拿不到员工 ID 时如实说明，不留空白", provenanceBlock({ locale: "zh", full: true }).includes("未取到"));
  ok("非完整来源时说明只是本轮回答", provenanceBlock({ locale: "zh", full: false }).includes("本轮回答"));
}

/* ───────────────── 截断必须可见 ───────────────── */
{
  eq("不超长时原样返回", clipMd("abc", "zh"), "abc");
  const long = clipMd("x".repeat(MAX_MD_CHARS + 10), "zh");
  ok("超长被截断", long.length < MAX_MD_CHARS + 10 + 200 && long.length > MAX_MD_CHARS);
  ok("截断在正文里写明（不静默）", long.includes("截断"));
}

/* ───────────────── 标题 ───────────────── */
{
  eq("取首句", reportTitle("帮我做一次全账号巡检。然后给结论", "zh"), "帮我做一次全账号巡检");
  eq("空输入有兜底标题", reportTitle("", "zh"), "STAROps 报告");
  eq("空输入英文兜底", reportTitle("   ", "en"), "STAROps report");
  ok("超长被截到 80 以内", reportTitle("巡".repeat(200), "zh").length <= 80);
}

/* ───────────────── 未配置报告 CDN → null（不编链接）───────────────── */
{
  const before = { b: process.env.SKILLS_BUCKET, c: process.env.REPORTS_CDN_DOMAIN };
  delete process.env.SKILLS_BUCKET; delete process.env.REPORTS_CDN_DOMAIN;
  // ⚠️ 模块顶层就读掉了这两个环境变量，重设也不会生效 —— 这里断的是**当前进程**的实际配置：
  // CI 里两者都没配，因此必须返回 null。这条同时守住"缺配置也不许崩"。
  const r = await saveStarOpsHtmlReport({ markdown: "# x", title: "t", locale: "zh", putObject: async () => {} });
  eq("未配 CDN → null", r, null);
  if (before.b) process.env.SKILLS_BUCKET = before.b;
  if (before.c) process.env.REPORTS_CDN_DOMAIN = before.c;
}

/* ───────────────── 触发门槛 + 整条流程 ───────────────── */
{
  // 短答案 + 无报告链接 → 不出网页（每条都挂链接是噪音）。
  let putCalls = 0;
  const noop = await starOpsReportSuffix({
    reply: "一切正常。", question: "巡检", locale: "zh",
    putObject: async () => { putCalls++; },
    fetchImpl: async () => { throw new Error("不该调"); },
  });
  eq("短答案不出报告", noop, "");
  eq("短答案不写对象存储", putCalls, 0);

  eq("门槛就是 MIN_REPORT_CHARS", MIN_REPORT_CHARS, 1200);
  ok("没有报告文件时门槛更高（长回答不等于报告）", MIN_STANDALONE_CHARS > MIN_REPORT_CHARS);

  // 有报告链接 → 就算正文不到 MIN_STANDALONE_CHARS 也要出网页（"这是报告"是员工说的）。
  let fetchCalls = 0;
  await starOpsReportSuffix({
    reply: `巡检完成，详见 ${OSS}`, question: "巡检", locale: "zh",
    fetchImpl: async () => { fetchCalls++; return { ok: true, headers: { get: () => null }, text: async () => "# 报告\n" + "内容".repeat(800) }; },
  });
  eq("有报告链接时会去抓原文（不看答案长短）", fetchCalls, 1);
  ok("体积上限是 2 MB", FETCH_MAX_BYTES === 2 * 1024 * 1024);

  // 有报告链接但抓取失败 → 仍然出网页（用答案正文），且**不说**「完整」。
  // 这一节靠 saveStarOpsHtmlReport 在 CI 里返回 null 来验证"失败不抛"，
  // 链接文案由上面 reportLinkLine 那一节单独钉。
  const s = await starOpsReportSuffix({
    reply: "报告正文".repeat(400) + `\n[完整报告](${OSS})`,
    question: "做一次全账号巡检", locale: "zh",
    fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => "" }),
  });
  eq("落盘不可用时返回空串而不是抛", s, "");
}

/* ───────────────── 模板：空 meta 不出空格子；落款可改 ───────────────── */
{
  const html = renderReport("# 标题\n正文", {
    title: "巡检", subtitle: "阿里云 STAROps 报告", meta: {}, status: "COMPLETED", priority: "",
    footer: "Generated by NotiOps",
  });
  ok("没有 AWS 概念的空格子（Execution ID）", !html.includes("Execution ID"));
  ok("没有 Agent Space 空格子", !html.includes("Agent Space"));
  ok("priority 为空时不出 Priority 徽标", !html.includes("Priority:"));
  // 只看 footer 那个 div：模板里另有一处 HTML 注释提到 "Deep Dive"，整页 includes 会误判。
  eq("落款可覆盖（不写成 Deep Dive）",
    (html.match(/<div class="footer">([^<]*)<\/div>/) || [])[1], "Generated by NotiOps");
  ok("副标题出现在页头", html.includes("阿里云 STAROps 报告"));

  // 老路径（DevOps 直连）行为不变：给了 meta 就照旧渲染，落款仍是 Deep Dive。
  const old = renderReport("x", {
    title: "t", subtitle: "Investigation Report",
    meta: { task_id: "T1", execution_id: "E1", agent_space_id: "S1", created_at: "a", updated_at: "b" },
    status: "COMPLETED", priority: "",
  });
  ok("DevOps 报告仍渲染 5 个元信息格子",
    ["T1", "E1", "S1", "Task ID", "Execution ID", "Agent Space"].every((s) => old.includes(s)));
  ok("DevOps 报告默认落款不变", old.includes("Generated by NotiOps Deep Dive"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
