/**
 * 深度调查（直连）/ Deep Dive (Direct) —— **0 token** 的第二条深度调查路径。
 *
 * 与老路径（「深度调查」/ Deep Dive）的关系：**完全并行、互不影响**。
 *   老：前端 devops_agent:true → BFF → agent runtime（Strands + Bedrock，烧 token）
 *       → investigate_live 工具 → core/devops_agent.py（boto3，本身 0 token）
 *   新：前端 deep_investigate_direct:true → BFF → 本模块直接调 DevOps Agent API（全程 0 token）
 *
 * 关键洞察：老链路里真正干活的 `core/devops_agent.py` 一行 LLM 调用都没有。模型只做了两件
 * 低价值的事——把用户原话抄成 title/description、调查完说一句「完成了」（实测 31,918 token）。
 * 「直连」= 把这两头的翻译层从模型换成固定代码，中间的 DevOps Agent 调查一模一样。
 *
 * ⚠️ C1 硬约束：本文件是**新增**，不改 `main.py` / `core/devops_agent.py`，agent runtime
 * 不重新部署。只需部署 WebChatStack。回滚 = 前端隐掉开关。
 *
 * SSE 事件与老路径同形（token / investigation_step / sources / followups / usage），
 * 因此前端渲染、右侧「调查过程」面板、报告链接全部零改动复用。
 */

import { randomUUID } from "node:crypto";
import { resolveTarget } from "./devops_agent_skills.mjs";
import { renderReport } from "./report_html.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const REPORTS_BUCKET = envClean("SKILLS_BUCKET");
const REPORTS_CDN_DOMAIN = envClean("REPORTS_CDN_DOMAIN");
const REPORTS_PREFIX = "reports";

// 轮询间隔与最长同步等待——与 agent 侧 investigate_live 同一套语义/默认值（840s）。
// ⚠️ BFF Lambda 上限 900s（AWS 平台硬顶）。直连路径没有模型 cycle 开销，前后只有
// 发起(~1s) + 终态后读摘要/落 S3/收尾(~5s)，比老路径余量更大，但仍保守取 840s。
// 真正的长调查靠**续查**（超时后回来点按钮，见 §resume）——调查在 AWS 侧不受此上限约束。
const POLL_INTERVAL_SEC = int(process.env.NOTIOPS_DEVOPS_POLL_SEC, 8);
const MAX_WAIT_SEC = int(process.env.NOTIOPS_DEVOPS_MAX_WAIT_SEC, 840);

const TERMINAL = new Set(["COMPLETED", "FAILED", "TIMED_OUT", "CANCELED", "SKIPPED"]);

/** CDK 未替换的 `__FOO__` 占位符按"未配置"处理（与 core/reports.py 的 _env 同策略）。 */
function envClean(name) {
  const v = (process.env[name] || "").trim();
  return v.startsWith("__") && v.endsWith("__") ? "" : v;
}
function int(v, dflt) {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : dflt;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只记异常类型 + 错误码，绝不外泄原始 message（对齐 docs/LOGGING_STANDARD.md）。 */
function safeErr(e) {
  const code = e?.name || e?.$metadata?.httpStatusCode || "unknown";
  return `${e?.constructor?.name || "Error"}/${code}`;
}

/** DevOps Agent 后台链接。⚠️ deep link 用 **taskId**（不是 executionId）。 */
function operatorUrls(agentSpaceId, taskId = "") {
  if (!agentSpaceId) return { home: "", deepLink: "" };
  const root = `https://${agentSpaceId}.aidevops.global.app.aws`;
  return { home: `${root}/`, deepLink: taskId ? `${root}/investigation/${taskId}` : `${root}/` };
}

/** 按目标账号构造 DevOps Agent client（跨账号自动 AssumeRole）。
 * ⚠️ 不要传 requestHandler 强制 IPv4——那是**本地调试**才需要的（本机无 IPv6 路由），
 * Lambda 的 IPv6 是通的，加了反而是无谓限制。也不要传 endpoint（SDK 自己加 `cp.` 前缀）。 */
async function clientFor(accountId) {
  const target = await resolveTarget(accountId);
  const { DevOpsAgentClient } = await import("@aws-sdk/client-devops-agent");
  const client = new DevOpsAgentClient({ region: target.region || REGION, credentials: target.credentials });
  return { client, target };
}

// ───────────────────────── 发起 / 轮询 / 结果（移植 core/devops_agent.py）─────────────────────────

/** 发起 INVESTIGATION 任务。返回 { ok, taskId, executionId, agentSpaceId, consoleUrl, consoleHome }。 */
async function startInvestigation({ client, agentSpaceId, title, description, priority = "MEDIUM" }) {
  const { CreateBacklogTaskCommand } = await import("@aws-sdk/client-devops-agent");
  const resp = await client.send(new CreateBacklogTaskCommand({
    agentSpaceId,
    taskType: "INVESTIGATION",
    title,
    priority,
    // 前缀标明来源，便于客户在后台区分 NotiOps 发起的任务。
    description: `[notiops-web-chat] ${description}`,
  }));
  // ⚠️ 返回体是 WRAPPED：r.task.taskId（r.taskId 不存在）——已探针确认。
  const task = resp?.task || {};
  const urls = operatorUrls(agentSpaceId, task.taskId);
  return {
    ok: true,
    taskId: task.taskId,
    executionId: task.executionId,
    agentSpaceId,
    consoleUrl: urls.deepLink,
    consoleHome: urls.home,
  };
}

/** 全量拉 journal 记录（ASC，自动翻页）。 */
async function listAllRecords(client, agentSpaceId, executionId) {
  const { ListJournalRecordsCommand } = await import("@aws-sdk/client-devops-agent");
  const out = [];
  let nextToken;
  do {
    const resp = await client.send(new ListJournalRecordsCommand({
      agentSpaceId, executionId, limit: 100, order: "ASC", nextToken,
    }));
    out.push(...(resp?.records || []));
    nextToken = resp?.nextToken;
  } while (nextToken);
  return out;
}

/** 增量轮询一次：拉 journal 渲染新行 + GetBacklogTask 判终态。无状态（seen 由调用方持有）。 */
async function pollInvestigation({ client, agentSpaceId, executionId, taskId, seen, locale }) {
  const { GetBacklogTaskCommand } = await import("@aws-sdk/client-devops-agent");
  const newLines = [];
  for (const rec of await listAllRecords(client, agentSpaceId, executionId)) {
    const rid = rec?.recordId;
    if (!rid || seen.has(rid)) continue;
    seen.add(rid);
    const line = recordProgressLine(rec, locale);
    if (line) newLines.push(line);
  }
  let status = "IN_PROGRESS";
  try {
    const t = await client.send(new GetBacklogTaskCommand({ agentSpaceId, taskId }));
    status = t?.task?.status || status;
  } catch (e) {
    // 单次 GetBacklogTask 失败不该中断整场调查——下一轮再判。
    console.warn("[direct-investigate] get_task_failed", safeErr(e));
  }
  return { status, terminal: TERMINAL.has(status), newLines };
}

/** 取最终结果，**按后台的 tab 分区**（对齐 core/devops_agent.py 的 get_investigation_result）：
 *   Summary → sections.summary（`ui_investigation_summary` 终版里的执行摘要卡：问题概要/根本原因/
 *     修复方案；退化到末条 assistant 原文）
 *   Root cause → sections.rootCause（结构化 investigation_summary：Impact/Root causes/…；
 *     退化到 investigation_summary_md 原文）
 *   Mitigation plan → sections.mitigation（`mitigation_summary_md`：Action/Reasoning/Execution
 *     Plan/Code Change Spec；退化到 ListRecommendations。有就给、没有就空）
 *   Investigation timeline → 不在这里：走 pollOnce 的 investigation_step 实时进右侧栏
 *
 * ⚠️ 数据源是**实测**校准的（2026-08-20 拿现网一次真调查的 92 条 journal 记录逐类核对）：
 * `investigation_summary_md` 其实是 `# Investigation Summary` + Symptoms/Findings/**Root Cause**，
 * 它是后台 **Root cause** 页的 md 版而非 Summary 页；Summary 页来自 `ui_investigation_summary`
 * （UI 组件树，逐步刷新、最后一条为终版）；Mitigation plan 页来自 `mitigation_summary_md`，而
 * `ListRecommendations` 那次返回 0 条 —— 故它只当退化来源。按老映射接会让 Summary 与 Root cause
 * 内容重复、缓解方案永远缺失。
 * `markdown` 保持存在（报告/聊天用），内容是三段拼好的完整文档。 */
async function getInvestigationSummary({ client, agentSpaceId, executionId, locale = "zh" }) {
  const records = await listAllRecords(client, agentSpaceId, executionId);
  const rootCause = buildStructuredReportMd(records) || mdRecordFrom(records, "investigation_summary_md");
  const summaryText = uiSummaryFrom(records) || readLastAssistant(records) || "";
  // taskId 从记录里反推（续查场景调用方手里可能只有 execution_id）。
  let taskId = "";
  for (const r of records) {
    const tid = r?.taskId || r?.task?.taskId;
    if (tid) { taskId = tid; break; }
  }
  let mitigation = mdRecordFrom(records, "mitigation_summary_md");
  if (!mitigation && taskId) {
    mitigation = await readRecommendationsMd({ client, agentSpaceId, taskId, locale });
  }
  const sections = { summary: summaryText, rootCause, mitigation };
  return { markdown: buildFullReportMd(sections, locale), sections,
           structured: Boolean(rootCause), hasMitigation: Boolean(mitigation), taskId };
}

/** 取某类 **markdown 型** journal 记录的终版原文（investigation_summary_md /
 *  mitigation_summary_md），去掉它自带的 H1（`# Investigation Summary` / `# Mitigation Summary`）
 *  —— 外面会套统一的章节标题（后台 tab 名），留着就是重复标题。没有 → ""。
 *  移植 core/devops_agent.py 的 _md_record_from_records。 */
function mdRecordFrom(records, recordType) {
  let latest = "";
  for (const r of records || []) {
    if (r?.recordType !== recordType) continue;
    const c = r.content;
    const s = typeof c === "string" ? c : (c?.text || "");
    if (s && s.trim()) latest = s;         // 记录按 ASC，最后一条即终版
  }
  if (!latest) return "";
  const lines = latest.split("\n");
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    if (lines[i].trimStart().startsWith("# ")) return lines.slice(i + 1).join("\n").trim();
    if (lines[i].trim()) break;
  }
  return latest.trim();
}

// ── ui_investigation_summary：后台 Summary 页的数据源（一棵 UI 组件树，不是 markdown）──────────
// 实测终版树：container > [card#summary（执行摘要：标题+状态/严重性徽章+问题概要/根本原因/修复方案）,
// card（调查发现与证据 = Root cause tab）, container（指标小卡）, card（缓解方案 = Mitigation tab）]。
// Summary 区**只取第一张卡**，否则三个区互相重复。移植 _ui_summary_from_records / _flatten_ui。
const UI_HEADING_TYPES = new Set(["title", "card-title"]);

/** 深度优先收集 [type, text] 叶子文本。 */
function uiLeaves(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (typeof node.text === "string" && node.text.trim()) {
    out.push([(node.type || "").toLowerCase(), node.text.trim()]);
  }
  for (const ch of node.children || []) uiLeaves(ch, out);
  return out;
}

/** UI 组件树 → markdown 行（正文原文透传，只映射层级/列表符号）；标题从 `###` 起。 */
function flattenUi(node, out) {
  if (!node || typeof node !== "object") return;
  const t = (node.type || "").toLowerCase();
  const txt = (node.text || "").trim();
  if (t === "card-header" || t === "accordion-trigger") {
    const leaves = uiLeaves(node);
    const heads = leaves.filter(([k]) => UI_HEADING_TYPES.has(k) || k === "text").map(([, s]) => s);
    const badges = leaves.filter(([k]) => k === "badge").map(([, s]) => s);
    const descs = leaves.filter(([k]) => k === "card-description" || k === "markdown").map(([, s]) => s);
    let line = heads.length ? `**${heads[0]}**` : "";
    if (badges.length) line = (line ? `${line} ` : "") + badges.map((b) => `\`${b}\``).join(" · ");
    if (line) out.push(line);
    out.push(...descs);
    return;
  }
  if (t === "title") {
    const lvl = Number(node.props?.level);
    const n = Number.isFinite(lvl) ? Math.max(3, Math.min(6, lvl)) : 3;
    if (txt) out.push(`${"#".repeat(n)} ${txt}`);
    return;
  }
  if (t === "markdown" || t === "text" || t === "paragraph" || t === "code") {
    if (txt) out.push(txt);
    return;
  }
  if (t === "badge") { if (txt) out.push(`\`${txt}\``); return; }
  if (t === "list-item") { if (txt) out.push(`- ${txt}`); return; }
  if (txt) out.push(txt);
  for (const ch of node.children || []) flattenUi(ch, out);
}

/** 从 ui_investigation_summary 终版里取**执行摘要卡**并摊平成 markdown（拿不到 → ""）。 */
function uiSummaryFrom(records) {
  let tree = null;
  for (const r of records || []) {
    if (r?.recordType !== "ui_investigation_summary") continue;
    const obj = parseContent(r.content);
    if (obj && typeof obj === "object") tree = (obj.content && typeof obj.content === "object") ? obj.content : obj;
  }
  if (!tree) return "";
  // 优先按 id 命中执行摘要卡（后台稳定用 "summary" 前缀），否则退化到树里第一张 card。
  const findCard = (n, byId) => {
    if (!n || typeof n !== "object") return null;
    if ((n.type || "").toLowerCase() === "card") {
      if (!byId || String(n.id || "").split("__")[0] === "summary") return n;
    }
    for (const ch of n.children || []) {
      const got = findCard(ch, byId);
      if (got) return got;
    }
    return null;
  };
  const card = findCard(tree, true) || findCard(tree, false);
  if (!card) return "";
  const lines = [];
  flattenUi(card, lines);
  return lines.filter(Boolean).join("\n\n").trim();
}

/** Mitigation plan 区：后台 ListRecommendations（不是每次调查都生成 → 没有就空串）。
 *  失败安全：任何异常都只是"这次没有缓解方案"，绝不让它掀翻整场调查收尾。 */
async function readRecommendationsMd({ client, agentSpaceId, taskId, locale }) {
  let recs = [];
  try {
    const { ListRecommendationsCommand } = await import("@aws-sdk/client-devops-agent");
    const resp = await client.send(new ListRecommendationsCommand({ agentSpaceId, taskId }));
    recs = resp?.recommendations || [];
  } catch (e) {
    console.warn("[direct-investigate] list_recommendations_failed", safeErr(e));
    return "";
  }
  if (!recs.length) return "";
  const en = locale === "en";
  const out = [""];
  [...recs].sort((a, b) => (a?.rankPosition ?? 999) - (b?.rankPosition ?? 999)).forEach((r, i) => {
    const n = i + 1;
    const title = r?.title || (en ? `Recommendation ${n}` : `建议 ${n}`);
    const pri = r?.priority ? (en ? ` (priority: ${r.priority})` : `（优先级：${r.priority}）`) : "";
    const c = r?.content;
    const body = typeof c === "string" ? c : (c?.text || "");
    out.push(`### ${n}. ${title}${pri}`);
    if (body) out.push(String(body));
    out.push("");
  });
  return out.join("\n");
}

/** ATX 标题整体降 `times` 级（`## X` → `### X`），把自带标题层级的区块嵌到 `## <tab 名>` 之下。
 *  跳过 ``` 围栏内的行（shell 注释里的 `#` 不是标题）。移植 core/devops_agent.py 的 _demote_md。 */
function demoteMd(md, times = 1) {
  if (times <= 0) return String(md || "");
  let fenced = false;
  return String(md || "").split("\n").map((ln) => {
    const s = ln.trimStart();
    if (s.startsWith("```") || s.startsWith("~~~")) { fenced = !fenced; return ln; }
    if (fenced || !s.startsWith("#")) return ln;
    const lvl = s.length - s.replace(/^#+/, "").length;
    return "#".repeat(Math.min(6 - lvl, times)) + ln;
  }).join("\n");
}

/** 一段 markdown 里最浅的 ATX 标题层级（围栏内的 `#` 不算）；没有标题 → 0。 */
function minHeadingLevel(md) {
  let lo = 0, fenced = false;
  for (const ln of String(md || "").split("\n")) {
    const s = ln.trimStart();
    if (s.startsWith("```") || s.startsWith("~~~")) { fenced = !fenced; continue; }
    if (fenced || !s.startsWith("#")) continue;
    const n = s.length - s.replace(/^#+/, "").length;
    const rest = s.slice(n);
    if (n > 6 || (rest && !rest.startsWith(" "))) continue;  // 不是合法 ATX 标题（如 `#tag`）
    lo = lo === 0 ? n : Math.min(lo, n);
  }
  return lo;
}

/** 把区块标题层级整体压到 `target` 及更深，让它干净嵌在 `##` 章节标题下。各区来源层级不同
 *  （结构化根因 `##` 起、mitigation_summary_md `##` 起、recommendations/UI 摘要 `###` 起），
 *  统一按**实测最浅层级**归一，不再硬编码"哪个区要降级"。移植 _fit_under_section。 */
function fitUnderSection(md, target = 3) {
  const lo = minHeadingLevel(md);
  return (lo > 0 && lo < target) ? demoteMd(md, target - lo) : String(md || "");
}

// 章节标题 = **后台的 tab 名**，让正文与客户在后台看到的一致。
const SECTION_TITLES = {
  summary:    ["## 调查摘要（Summary）", "## Summary"],
  rootCause:  ["## 根因分析（Root cause）", "## Root cause"],
  mitigation: ["## 缓解方案（Mitigation plan）", "## Mitigation plan"],
};

/** 按 Summary → Root cause → Mitigation plan 拼成一篇 markdown；空区段跳过。
 *  clip：**逐区**字符上限（聊天气泡控长用）—— 整篇截断会把后两段整段吃掉。 */
function buildFullReportMd(sections, locale = "zh", clip = null) {
  const en = locale === "en";
  const parts = [];
  for (const key of ["summary", "rootCause", "mitigation"]) {
    let body = String((sections || {})[key] || "").trim();
    if (!body) continue;
    // 层级归一（**先归一再截断**：截断可能切断 ``` 围栏，之后再判标题会把代码注释当标题）。
    body = fitUnderSection(body, 3);
    const limit = clip?.[key];
    if (limit && body.length > limit) {
      body = body.slice(0, limit);
      // 截断点可能落在 ``` 围栏里 —— 不补收尾围栏，后面全被渲染成代码块。
      if ((body.match(/```/g) || []).length % 2) body += "\n```";
      body += (en ? "\n\n… (truncated; see the full report below)"
                  : "\n\n…（此处截断，完整内容见下方在线报告）");
    }
    parts.push(`${SECTION_TITLES[key][en ? 1 : 0]}\n\n${body}`);
  }
  return parts.join("\n\n").trim();
}

// ───────────────────────── journal 记录 → 进度行（移植 _record_progress_line）─────────────────────────

/** journal 的 content 是 **string**，渲染前必须 JSON.parse（parse 失败就当纯文本用）。 */
function parseContent(content) {
  if (typeof content !== "string") return content;
  try { return JSON.parse(content); } catch { return content; }
}
/** 去 HTML 标签 + 压空白。非字符串一律返回 ""。 */
function plain(s) {
  if (typeof s !== "string") return "";
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function clip(s, n) { return s.length <= n ? s : s.slice(0, n) + "…"; }
function toolNameFrom(content) {
  const d = parseContent(content);
  if (!d || typeof d !== "object") return "";
  return d.name || d.toolName || d.toolUse?.name || "";
}
function assistantText(content) {
  const d = parseContent(content);
  if (!d || typeof d !== "object") return typeof d === "string" ? d : "";
  if (d.role && d.role !== "assistant") return "";
  const c = d.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b?.text || "")).filter(Boolean).join("\n");
  return "";
}

// 噪声类型：不进右侧「调查过程」面板（与 agent 侧过滤集完全一致）。
const NOISE_TYPES = new Set([
  "system", "metadata", "context", "checkpoint", "heartbeat", "tool_result", "utilization",
]);

/** 把一条 journal 记录渲染成一行进度文本（不该显示的返回 null）。 */
function recordProgressLine(rec, locale) {
  const en = locale === "en";
  const rt = rec?.recordType || "";
  const content = rec?.content;
  const obj = parseContent(content);
  if (NOISE_TYPES.has(rt)) return null;

  if (rt === "thinking") {
    const body = plain(typeof obj === "string" ? obj : (obj && typeof obj === "object" ? obj.text : ""));
    return body ? `\n🤔 ${clip(body, 400)}\n` : null;
  }
  if (rt === "tool_use") {
    const name = toolNameFrom(content);
    if (!name) return null;
    return en ? `\n🔧 Calling tool: \`${name}\`\n` : `\n🔧 调用工具：\`${name}\`\n`;
  }
  if (rt === "observation") {
    if (obj && typeof obj === "object") {
      const title = (obj.title || "").trim();
      const analysis = plain(obj.analysis || "");
      if (title) {
        let out = en ? `\n**🔭 Observation: ${title}**\n` : `\n**🔭 Observation：${title}**\n`;
        if (analysis) out += `\n${clip(analysis, 700)}\n`;
        return out;
      }
    }
    return null;
  }
  if (rt === "finding") {
    if (obj && typeof obj === "object") {
      const title = (obj.title || "").trim();
      const desc = plain(obj.description || "");
      if (title) {
        let out = en ? `\n**🔎 Finding: ${title}**\n` : `\n**🔎 Finding：${title}**\n`;
        if (desc) out += `\n${clip(desc, 900)}\n`;
        return out;
      }
    }
    return null;
  }
  if (rt === "message") {
    const body = plain(assistantText(content));
    return body ? `\n💬 ${clip(body, 600)}\n` : null;
  }
  if (rt === "investigation_result") {
    return en ? "\n📄 Investigation summary generated.\n" : "\n📄 调查摘要已生成。\n";
  }
  if (rt === "investigation_summary_md") {
    return en ? "\n📄 Generating investigation summary…\n" : "\n📄 正在生成调查摘要…\n";
  }
  return null;
}

// ───────────────────────── 结构化报告 markdown（移植 build_structured_report_md）─────────────────────────

/** 取最后一条 investigation_summary 记录的结构化内容。 */
function structuredSummaryFrom(records) {
  let found = null;
  for (const r of records) {
    if (r?.recordType !== "investigation_summary") continue;
    const obj = parseContent(r.content);
    if (obj && typeof obj === "object") found = obj;   // 取最后一条
  }
  return found;
}

function emitFinding(lines, f, idx) {
  const title = (f?.title || "").trim();
  const desc = (f?.description || "").trim();
  lines.push(`### ${idx}. ${title || "Finding"}`, "");
  if (desc) lines.push(desc, "");
  const obs = Array.isArray(f?.observations) ? f.observations : [];
  if (obs.length) {
    lines.push("**Supporting observations:**", "");
    for (const o of obs) {
      const ot = (o?.title || "").trim();
      const oa = (o?.analysis || "").trim();
      if (!ot && !oa) continue;
      lines.push(ot ? `- **${ot}** — ${oa}` : `- ${oa}`);
    }
    lines.push("");
  }
}

/** 结构化摘要 → 报告 markdown（Impact / Root causes / Key findings / Investigation gaps）。
 * 无结构化摘要时返回 ""，由调用方退化到纯文本摘要。 */
function buildStructuredReportMd(records) {
  const s = structuredSummaryFrom(records);
  if (!s) return "";
  const lines = [];

  const symptoms = Array.isArray(s.symptoms) ? s.symptoms : [];
  if (symptoms.length) {
    lines.push("## Impact", "");
    symptoms.forEach((sym, i) => {
      const t = (sym?.title || "").trim();
      const d = (sym?.description || "").trim();
      lines.push(`### ${i + 1}. ${t || "Symptom"}`, "");
      if (d) lines.push(d, "");
    });
  }

  const findings = Array.isArray(s.findings) ? s.findings : [];
  const roots = findings.filter((f) => f?.type === "root_cause");
  const others = findings.filter((f) => f?.type !== "root_cause");
  if (roots.length) {
    lines.push("## Root causes", "");
    roots.forEach((f, i) => emitFinding(lines, f, i + 1));
  }
  if (others.length) {
    lines.push("## Key findings", "");
    others.forEach((f, i) => emitFinding(lines, f, i + 1));
  }

  const gaps = Array.isArray(s.gaps) ? s.gaps : [];
  if (gaps.length) {
    lines.push("## Investigation gaps", "");
    for (const g of gaps) {
      const gt = (g?.title || "").trim();
      const gd = (g?.description || "").trim();
      if (!gt && !gd) continue;
      lines.push(gt ? `- **${gt}** — ${gd}` : `- ${gd}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

// （原 readSummaryMd 已由 mdRecordFrom(records, "investigation_summary_md") 取代：那条记录是
//   后台 Root cause 页的 md 版，且需要剥掉自带 H1，见 getInvestigationSummary 的实测说明。）

/** 退化路径②：读最后一条 assistant message。 */
function readLastAssistant(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.recordType !== "message") continue;
    const txt = assistantText(records[i].content);
    if (txt && txt.trim()) return txt;
  }
  return "";
}

// ───────────────────────── 报告落 S3（移植 core/reports.py 的 save_html_report）─────────────────────────

function slug(s) {
  // 保留 CJK，其余非字母数字压成连字符（与 Python 版 _slug 一致）。
  return (String(s || "").trim().toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)) || "report";
}

/**
 * 渲染 HTML 报告并落 S3，返回可直接点开的链接。
 * ⚠️ 只用 PutObject，**不做 presigned URL 分支**：ReportsCDN 是 CloudFront + OAC，
 * `https://<cdn>/reports/...` 直接可读且**不过期**；退化成 presign 只会得到 12h 有效期，
 * 比老路径更差。CDN 域名缺失（未配置）时直接返回 null，聊天里只是少一个链接，不报错。
 */
async function saveHtmlReport({ markdown, title, meta, status }) {
  if (!REPORTS_BUCKET || !REPORTS_CDN_DOMAIN) {
    console.warn("[direct-investigate] report_link_skipped bucket=%s cdn=%s",
      Boolean(REPORTS_BUCKET), Boolean(REPORTS_CDN_DOMAIN));
    return null;
  }
  try {
    const html = renderReport(markdown, { title, subtitle: "Investigation Report", meta, status, priority: "" });
    const today = new Date().toISOString().slice(0, 10);
    const key = `${REPORTS_PREFIX}/investigation/${today}-${slug(title)}-${randomUUID().slice(0, 8)}.html`;
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = new S3Client({ region: REGION });
    await s3.send(new PutObjectCommand({
      Bucket: REPORTS_BUCKET,
      Key: key,
      Body: Buffer.from(html, "utf-8"),
      ContentType: "text/html; charset=utf-8",
      ContentDisposition: "inline",   // 点开即看网页，而不是下载文件
    }));
    const base = REPORTS_CDN_DOMAIN.startsWith("http") ? REPORTS_CDN_DOMAIN : `https://${REPORTS_CDN_DOMAIN}`;
    return { url: `${base.replace(/\/+$/, "")}/${key}`, key };
  } catch (e) {
    // 报告落盘失败不该毁掉整场调查——摘要已在聊天里给出了。
    console.warn("[direct-investigate] save_report_failed", safeErr(e));
    return null;
  }
}

// ───────────────────────── 请求文本 → title / description（替代模型那层翻译）─────────────────────────

/** 从用户原话切出 title（首行/首句，≤80 字符）；description 用**原文透传**。
 * 这就是「直连」省掉的那 3 万 token 干的事——固定代码替代模型改写。代价：description
 * 质量略降（模型会补"请自行定位相关资源"之类的提示），换来完全可预测 + 0 成本。 */
function deriveTitle(text) {
  const firstLine = String(text || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  // 首句：中英文句末标点都算断点。
  const m = /^(.{8,80}?)(?:[。．.!!?？；;]|$)/.exec(firstLine);
  const t = (m ? m[1] : firstLine).trim();
  return (t || firstLine || "AWS investigation").slice(0, 120);
}

/** 结构化报告的固定小节名——它们不是"问题"，选标题时必须跳过。 */
const GENERIC_HEADINGS = new Set([
  "impact", "root causes", "key findings", "investigation gaps", "summary", "overview",
]);

/** 从调查摘要里推一个人类可读的问题标题（续查场景用：手上没有用户原话）。
 * 优先取第一个**非小节名**的 markdown 标题（结构化报告里就是第一条 symptom/root cause，
 * 正好是一句话说清的问题），退化到第一行非空正文。**纯字符串处理 → 0 token**。
 *
 * ⚠️ 为什么不让模型"从上文结论归纳"：直连路径压根没经过 agent runtime，那条会话在
 * AgentCore Memory 里**没有任何历史**——模型看不到上面的调查结论，让它归纳只会得到空话。
 * 案例正文不受影响：`escalate_to_support` 在服务端用 execution_id 重新取原文摘要来拼 body。 */
function titleFromSummary(md) {
  const lines = String(md || "").split("\n");
  for (const raw of lines) {
    const h = /^#{1,6}\s+(.+)$/.exec(raw.trim());
    if (!h) continue;
    // "### 1. Xxx" → "Xxx"（结构化报告给 finding 编了号）
    const t = h[1].replace(/^\d+[.、)]\s*/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();
    if (t && t.length >= 4 && !GENERIC_HEADINGS.has(t.toLowerCase())) return t.slice(0, 80);
  }
  for (const raw of lines) {
    const t = raw.replace(/^\s*(?:[-*+]|\d+[.、)])\s+/, "")   // 列表符号
      .replace(/[*_`>#|]/g, " ").replace(/\s+/g, " ").trim();
    if (t.length >= 4 && !GENERIC_HEADINGS.has(t.toLowerCase())) return t.slice(0, 80);
  }
  return "";
}

/**
 * 「转人工支持」识别：这个 followup **必须回退到老（计费）路径**——直连没有模型，判不了
 * service_code/severity_code，而 `escalate_to_support` 是 agent 侧的工具（设计文档 §5 方案 a）。
 *
 * ⚠️ 为什么必须在**服务端**识别：followup 是 prompt 型，点击 = 在同一会话里再发一轮，
 * 而会话的「直连」开关仍然开着 → 请求又落回 `runDirectInvestigation`；更糟的是该 prompt 里带
 * `execution_id=`，会被 `extractExecutionId()` 判成"续查"，于是把同一份报告再贴一遍就结束了
 * （用户看到的现象：闪一下文字、然后没反应）。所以由 `index.mjs` 在分流前拦下来改走老路径。
 *
 * 判据取工具名 `escalate_to_support` —— 它只出现在我们自己生成的这个 prompt 里（与
 * `emitFollowups` 同文件，改文案不会漂移），不会误伤用户自然语言提问。
 */
export function isEscalateRequest(text) {
  return /escalate_to_support/i.test(String(text || ""));
}

/** 续查识别：消息里带 execution_id → 不发起新调查，直接续拉已有调查的结果（同样 0 token）。
 * 支持两种写法：`execution_id=xxx`（我们自己的 followup 按钮生成的）和裸 `exe-...` id。 */
export function extractExecutionId(text) {
  const s = String(text || "");
  let m = /execution[_\s-]?id\s*[=:：]\s*`?([A-Za-z0-9][A-Za-z0-9._-]{7,})`?/i.exec(s);
  if (m) return m[1];
  m = /\b(exe-[A-Za-z0-9-]{8,})\b/.exec(s);
  return m ? m[1] : "";
}

/* ───────────────────────── 能力探测（前端据此决定开关能不能点）─────────────────────────
 *
 * 为什么需要：两个「深度调查」开关此前只按主题显示，点了才知道这个部署/这个账号根本没有
 * DevOps Agent Agent Space —— 用户看到的是一句 `no_local_agent_space`
 * / `account_not_onboarded_to_devops_agent`（老路径则是 agent 回一段 not_onboarded 文案），
 * 白等一轮。前端拿到 available:false 就把开关置灰并写明原因，点不下去。
 *
 * 判据直接复用 resolveTarget（probeOnly，不做 AssumeRole）：调查能不能发起，取决的正是
 * "能不能解析出目标 Agent Space"。不另写一套判断，避免两处漂移。
 */
const _availCache = new Map();   // key(账号或"self") -> { at, val }
const AVAIL_TTL_MS = 5 * 60 * 1000;

/** 这个账号能不能做深度调查。{ available, reason }。reason ∈
 *  no_local_agent_space | account_not_onboarded_to_devops_agent | <其它错误名>。 */
export async function deepInvestigationAvailability(accountId, { useCache = true } = {}) {
  const key = String(accountId || "").trim() || "self";
  const hit = useCache ? _availCache.get(key) : null;
  // Date.now 在 Lambda 里没问题（这里不是 workflow 脚本），只用于 TTL。
  if (hit && Date.now() - hit.at < AVAIL_TTL_MS) return { ...hit.val };

  let val;
  try {
    const t = await resolveTarget(key === "self" ? "" : key, { probeOnly: true });
    val = { available: true, scope: t.scope };
  } catch (e) {
    const reason = String(e?.message || "unknown");
    // 只有"确定没有"才算不可用。其它异常（DDB 抖动、权限、超时）**放行** —— 宁可让用户
    // 点进去看到真实报错，也不要因为一次抖动把功能藏起来（和建案能力探测同一取舍）。
    const definitive = reason === "no_local_agent_space" || reason === "account_not_onboarded_to_devops_agent";
    if (!definitive) return { available: true, probe_error: e?.name || "Error" };
    val = { available: false, reason };
  }
  _availCache.set(key, { at: Date.now(), val });
  return { ...val };
}

// ───────────────────────── 主流程 ─────────────────────────

/**
 * 「深度调查（直连）」主流程。**全程 0 token**（不经 Bedrock / agent runtime）。
 *
 * @param {object} p
 * @param {string} p.text        用户原话
 * @param {string} p.locale      "zh" | "en"
 * @param {string} p.accountId   目标账号（空=部署账号自身）
 * @param {function} p.emit      (event, data) => void，写一条 SSE（形状与老路径完全一致）
 * @returns {Promise<string>}    落库用的 assistant 正文
 */
export async function runDirectInvestigation({ text, locale, accountId, emit }) {
  const en = locale === "en";
  const dv = (zh, enStr) => (en ? enStr : zh);
  let reply = "";
  /** 写正文：既流给前端，也累积进 reply 供落库。 */
  const say = (s) => { reply += s; emit("token", { delta: s }); };

  // 0 token 是本路径的核心卖点——总是显式声明（前端对 totalTokens:0 不渲染 token 徽章）。
  const finishUsage = () => emit("usage", { usage: { totalTokens: 0, cycles: 0, direct: true } });

  emit("progress", { text: dv("正在发起深度调查（直连，0 token）…", "Starting deep investigation (direct, 0 tokens)…") });

  let client, target;
  try {
    ({ client, target } = await clientFor(accountId));
  } catch (e) {
    const code = e?.code === "bad_request" ? e.message : safeErr(e);
    console.warn("[direct-investigate] resolve_target_failed", code);
    say(dv(
      `\n⚠️ 无法定位该账号的 DevOps Agent Agent Space（${code}）。请确认该账号已接入 DevOps Agent。\n`,
      `\n⚠️ Could not resolve the DevOps Agent Agent Space for this account (${code}). Please confirm the account is onboarded to DevOps Agent.\n`));
    finishUsage();
    return reply;
  }
  const space = target.agentSpaceId;

  // —— 续查分支：消息里带 execution_id → 接着上次那场调查拉结果，不新建任务 ——
  // 复用同一条 /stream + 同一个开关，因此**不需要**新增 BFF 路由（也就不用动 authz/capabilities
  // 白名单）：只要开关还开着，「查看调查结果」按钮天然仍走直连 → 依旧 0 token。
  const resumeId = extractExecutionId(text);
  if (resumeId) {
    await resumeInvestigation({ client, space, executionId: resumeId, locale, emit, say });
    finishUsage();
    return reply;
  }

  // —— 发起新调查 ——
  const title = deriveTitle(text);
  const description = String(text || "").trim();
  let started;
  try {
    started = await startInvestigation({ client, agentSpaceId: space, title, description });
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    const unregistered = msg.includes("unregistered domain") || (msg.includes("invalid") && msg.includes("domain"));
    console.warn("[direct-investigate] start_failed", safeErr(e), unregistered ? "unregistered_domain" : "");
    say(unregistered
      ? dv("\n⚠️ 该 Agent Space 还没有注册域名，无法发起调查。请到 DevOps Agent 控制台（https://console.aws.amazon.com/aidevops/home#/agent-spaces）→ 你的 Agent Space → Configure web app 完成配置后重试。\n",
           "\n⚠️ This Agent Space has no registered domain yet, so the investigation cannot start. Open the DevOps Agent console (https://console.aws.amazon.com/aidevops/home#/agent-spaces) → your Agent Space → Configure web app, then retry.\n")
      : dv(`\n⚠️ 发起调查失败：${safeErr(e)}\n`, `\n⚠️ Failed to start the investigation: ${safeErr(e)}\n`));
    finishUsage();
    return reply;
  }
  const { taskId, executionId, consoleUrl } = started;

  // 开场横幅：主聊天只放**结论线**（发起了什么 + 后台链接 + 一句"过程在右侧栏看"）；
  // 分析过程走 investigation_step → 右侧「调查过程」面板（与老路径一致）。
  let open = dv(`\n\n🚀 **深度调查已发起**（直连，0 token）\n\n**${title}**\n\n${description}\n\n`,
                `\n\n🚀 **Deep investigation started** (direct, 0 tokens)\n\n**${title}**\n\n${description}\n\n`);
  open += dv(`（execution_id: \`${executionId}\`）`, `(execution_id: \`${executionId}\`)`);
  if (consoleUrl) {
    open += dv(`\n\n🔗 可点开 DevOps Agent 后台实时查看进度：[${consoleUrl}](${consoleUrl})`,
               `\n\n🔗 Watch live progress in the DevOps Agent console: [${consoleUrl}](${consoleUrl})`);
  }
  open += dv("\n\n_分析过程正在右侧「调查过程」面板实时更新；这里将给出根因结论与报告。_\n",
             "\n\n_The analysis streams live in the “Investigation” panel on the right; the root-cause conclusion and report will appear here._\n");
  say(open);

  // 首条进度事件带 console_url → 前端右侧面板顶部也放一个"后台查看"链接。
  emit("investigation_step", {
    step: { text: dv(`🚀 已发起：${title}`, `🚀 Started: ${title}`), console_url: consoleUrl || undefined },
  });

  // —— 轮询 ——
  // 活跃度心跳（每 ~40s 一条瞬态 progress）：一次调查里常有**几分钟没有任何新 timeline 行**，
  // 那几分钟里用户只看到上面那句"过程在右侧栏实时更新"一动不动，无法区分"在跑"还是"已经断了"。
  // 走 progress 通道 = 纯瞬态（收到正文即清空、不入库），只报"还在跑 + 已用时长"，不编造进展。
  // ⚠️ 这只解决**观感**；防连接被中间跳空闲回收的是 index.mjs 里的全程 keepalive（`: ka`）。
  const HB_EVERY = Math.max(1, Math.floor(40 / Math.max(1, POLL_INTERVAL_SEC)));
  const seen = new Set();
  let waited = 0;
  let ticks = 0;
  let status = "IN_PROGRESS";
  while (waited < MAX_WAIT_SEC) {
    try {
      const poll = await pollInvestigation({ client, agentSpaceId: space, executionId, taskId, seen, locale });
      for (const line of poll.newLines) emit("investigation_step", { step: { text: line } });
      status = poll.status;
      if (poll.terminal) break;
    } catch (e) {
      // 单轮拉取失败（限流/瞬时错误）不中断——下一轮重试。
      console.warn("[direct-investigate] poll_failed", safeErr(e));
    }
    await sleep(POLL_INTERVAL_SEC * 1000);
    waited += POLL_INTERVAL_SEC;
    if (++ticks % HB_EVERY === 0) {
      const m = Math.floor(waited / 60), s = waited % 60;
      emit("progress", {
        text: dv(`深度调查进行中…已用 ${m} 分 ${s} 秒（分析过程见右侧「调查过程」面板）`,
                 `Deep investigation running… ${m}m ${s}s elapsed (steps stream in the “Investigation” panel)`),
        kind: "investigation",
      });
    }
  }

  // —— 优雅超时：不报错，明确说明调查仍在 AWS 侧继续跑，并给一个 0-token 的续查按钮 ——
  if (!TERMINAL.has(status)) {
    const mins = Math.floor(waited / 60);
    say(dv(
      `\n\n⏳ **调查仍在进行中**（已实时跟踪 ${mins} 分钟）。深度调查有时需要更长时间，为避免长时间占用会话，先在这里暂告一段落——\n\n` +
      `> **调查并没有停止，它仍在 AWS 侧继续运行。**\n` +
      `> 调查编号（execution_id）：\`${executionId}\`\n\n` +
      `过几分钟后点下方「查看调查结果」，我就会拉回完整结论并生成可下载的报告（同样 0 token）。\n`,
      `\n\n⏳ **Investigation still in progress** (tracked live for ${mins} min). Deep investigations sometimes take longer, so let's pause here to avoid holding the session open —\n\n` +
      `> **The investigation has NOT stopped; it keeps running on the AWS side.**\n` +
      `> Investigation id (execution_id): \`${executionId}\`\n\n` +
      `In a few minutes, click “Check investigation result” below and I'll pull back the full conclusion and generate a downloadable report (also 0 tokens).\n`));
    emitFollowups({ emit, locale, consoleUrl, executionId, title, description, resumable: true });
    finishUsage();
    return reply;
  }

  // —— 终态：读摘要 + 落报告 ——
  await finishAndReport({ client, space, executionId, taskId, status, title, description, consoleUrl, locale, emit, say });
  finishUsage();
  return reply;
}

/** 续查：只读拉取已有调查的进度/结论（0 token），形状与首查完全一致。 */
async function resumeInvestigation({ client, space, executionId, locale, emit, say }) {
  const en = locale === "en";
  const dv = (zh, enStr) => (en ? enStr : zh);

  let summary;
  try {
    summary = await getInvestigationSummary({ client, agentSpaceId: space, executionId, locale });
  } catch (e) {
    console.warn("[direct-investigate] resume_read_failed", safeErr(e));
    say(dv(`\n⚠️ 读取调查结果失败：${safeErr(e)}\n`, `\n⚠️ Failed to read the investigation result: ${safeErr(e)}\n`));
    return;
  }
  const taskId = summary.taskId;
  const consoleUrl = operatorUrls(space, taskId).deepLink;

  // 判终态（拿不到 taskId 就只按有无摘要判断）。
  let status = summary.markdown ? "COMPLETED" : "IN_PROGRESS";
  if (taskId) {
    try {
      const { GetBacklogTaskCommand } = await import("@aws-sdk/client-devops-agent");
      const t = await client.send(new GetBacklogTaskCommand({ agentSpaceId: space, taskId }));
      status = t?.task?.status || status;
    } catch (e) {
      console.warn("[direct-investigate] resume_get_task_failed", safeErr(e));
    }
  }

  if (!TERMINAL.has(status) && !summary.markdown) {
    say(dv(
      `\n\n⏳ 调查仍在进行中（execution_id: \`${executionId}\`），暂无摘要。请稍后再点一次「查看调查结果」。\n`,
      `\n\n⏳ The investigation is still running (execution_id: \`${executionId}\`) and no summary is available yet. Please click “Check investigation result” again shortly.\n`));
    emitFollowups({ emit, locale, consoleUrl, executionId, title: "", description: "", resumable: true });
    return;
  }

  await finishAndReport({
    client, space, executionId, taskId, status,
    title: dv("深度调查续查", "Deep investigation (resumed)"), description: "",
    // ⚠️ 上面那个 title 只是**报告标题**的占位；续查手上没有用户原话，故不能把它当"问题"
    // 喂给转人工按钮（否则建案主题会变成「深度调查续查」这种毫无信息量的词）。
    // origTitle:"" → 由 finishAndReport 用 titleFromSummary(md) 从摘要里确定性地推一个。
    origTitle: "",
    consoleUrl, locale, emit, say, preloaded: summary,
  });
}

/** 终态收尾：摘要写进聊天 + HTML 报告落 S3 + sources/followups。
 * @param {string} p.title      报告标题用（续查场景是占位词）
 * @param {string} [p.origTitle] 转人工按钮用的**用户原始问题**；缺省=同 title，显式传 "" 表示
 *                               "手上没有原话"，此时从摘要里推一个（见 titleFromSummary）。 */
async function finishAndReport({ client, space, executionId, taskId, status, title, description, consoleUrl, locale, emit, say, preloaded, origTitle }) {
  const en = locale === "en";
  const dv = (zh, enStr) => (en ? enStr : zh);

  let summary = preloaded;
  if (!summary) {
    try {
      summary = await getInvestigationSummary({ client, agentSpaceId: space, executionId, locale });
    } catch (e) {
      console.warn("[direct-investigate] read_summary_failed", safeErr(e));
      summary = { markdown: "", sections: {}, structured: false, hasMitigation: false, taskId };
    }
  }
  const md = summary.markdown || "";
  // 转人工按钮的建案主题：有用户原话就用原话；续查场景（origTitle:""）从摘要里推一个
  // 确定性的问题标题——不能让模型"从上文归纳"（直连会话在 AgentCore Memory 里没有历史）。
  const escTitle = (origTitle === undefined ? title : origTitle) || titleFromSummary(md);

  if (status !== "COMPLETED") {
    say(dv(`\n\n⚠️ 调查以状态 **${status}** 结束。\n`, `\n\n⚠️ Investigation ended with status **${status}**.\n`));
  }
  if (!md) {
    say(dv("\n\n调查结束，但暂未取到摘要内容。可稍后再查。\n",
           "\n\nThe investigation finished, but no summary was available yet. You can check again shortly.\n"));
    // 摘要还没落地 → 续查按钮**有意义**（过一会儿再点能拉到内容）。
    emitFollowups({ emit, locale, consoleUrl, executionId, title: escTitle, description, resumable: true });
    return;
  }

  // 忠实透传 DevOps Agent 的原文（不做二次总结——那才是要花 token 的事），只按后台的 tab 名
  // 分章节：Summary / Root cause / Mitigation plan（Investigation timeline 在右侧栏）。
  // **按区截断**而不是整篇截断：整篇截断时 Summary 一长，后面两段会被整段吃掉。
  const chatMd = summary.sections
    ? buildFullReportMd(summary.sections, locale, { summary: 4000, rootCause: 6000, mitigation: 4000 })
    : md.slice(0, 8000);
  say(dv("\n\n✅ **调查完成**\n\n", "\n\n✅ **Investigation complete**\n\n") + chatMd + "\n");

  const repTitle = dv(`DevOps Agent 深度调查报告 - ${title.slice(0, 40)}`,
                      `DevOps Agent Deep Investigation Report - ${title.slice(0, 40)}`);
  const saved = await saveHtmlReport({
    markdown: md,
    title: repTitle,
    meta: { execution_id: executionId, task_id: taskId || summary.taskId || "", agent_space_id: space },
    status,
  });
  if (saved?.url) {
    emit("sources", {
      sources: [{ icon: "file", title: repTitle + dv("（在线报告）", " (online report)"), detail: saved.url }],
    });
    say(dv(`\n\n🌐 [在线查看报告](${saved.url})\n`, `\n\n🌐 [View the online report](${saved.url})\n`));
  }
  // 已出结论 → **不给**续查按钮（点了只是把同一份报告再刷一遍）；与老路径完成时一致：只有
  // ①去后台生成缓解方案 + ③转人工支持。
  emitFollowups({ emit, locale, consoleUrl, executionId, title: escTitle, description,
                  hasMitigation: Boolean(summary.hasMitigation) });
}

/** 末尾快捷操作。
 * ① 生成缓解方案 → 跳 DevOps Agent 后台（url 型，新标签打开；与老路径一致）。
 * ② 查看调查结果 → prompt 带 execution_id，仍走**直连**路径的续查分支 → 0 token。
 *    ⚠️ **只在还查得到新东西时才给**（`resumable`）：调查已完成、摘要都贴出来了还挂这个按钮，
 *    点下去只是把同一份报告再瞬间刷一遍（表现为"闪一下、什么也没发生"），且老路径完成时
 *    也只有 ①③ 两个按钮——保持一致。
 * ③ 转人工支持 → prompt 型，**故意回退到老路径**（agent 调 escalate_to_support 智能建案）。
 *    直连路径没有模型，无法自己判断 service_code/severity_code；这是用户主动点击才发生的
 *    一次计费，且行为与今天完全一致（设计文档 §5 方案 a）。
 *    ⚠️ 回退是由 `index.mjs` 的 `isEscalateRequest()` 在**服务端**识别并分流的（见那里的注释）——
 *    prompt 里带 `execution_id=` 会被 `extractExecutionId()` 误判成"续查"，那样永远到不了模型。
 *
 * @param {boolean} p.resumable  本次调查还没出结论（超时/仍在跑/暂无摘要）→ 才给 ② 续查按钮
 * @param {string}  p.title      建案主题用的问题描述：用户原话，或从摘要里推出来的（titleFromSummary）。
 *                               为空 = 连摘要都还没有 → ③ 的 prompt 改成"先取结论再建案"。
 */
function emitFollowups({ emit, locale, consoleUrl, executionId, title, description, resumable = false,
                        hasMitigation = false }) {
  const en = locale === "en";
  const dv = (zh, enStr) => (en ? enStr : zh);
  const fups = [];
  if (consoleUrl) {
    // Operator App 是纯前端切 tab（URL 不变）、无法深链直达 Root cause 页，故文案里明确提示。
    // 正文已经带 Mitigation plan 区时换文案 —— 再叫"生成"会让用户以为后台还没生成。
    fups.push({
      label: hasMitigation
        ? dv("🛠️ 在 DevOps Agent 后台查看本次调查（含缓解方案）",
             "🛠️ Open this investigation in the DevOps Agent console (incl. the mitigation plan)")
        : dv("🛠️ 去 DevOps Agent 后台生成缓解方案（打开后切到 Root cause 页）",
             "🛠️ Generate a mitigation plan in the DevOps Agent console (open, then switch to the Root cause tab)"),
      url: consoleUrl,
    });
  }
  if (resumable && executionId) {
    fups.push({
      label: dv("🔄 查看调查结果（0 token）", "🔄 Check investigation result (0 tokens)"),
      prompt: dv(`查一下这次调查的结果，execution_id=${executionId}`,
                 `Check the result of this investigation, execution_id=${executionId}`),
    });
  }
  if (executionId) {
    // ⚠️ prompt 里必须**自带** problem_title/background：点击后走的是老路径，但那是一条
    // 全新的模型回合，它看不到本次直连调查的任何上下文（直连不经过 agent runtime，
    // AgentCore Memory 里没有历史）——不能写"从上面的结论归纳"，那样只会得到空话。
    // 摘要还没落地（title 为空）时，让模型先用 get_investigation_result 取结论再建案。
    const escPrompt = title
      ? dv(
        `把刚才这次调查转人工支持，用 escalate_to_support 建案。execution_id=${executionId}；`
        + `problem_title=「${title}」；background=「${description || title}」。`
        + `请据此判断受影响服务的 service_code 和 severity_code（按影响严重性），language 按用户语言。`,
        `Escalate this investigation to human support using escalate_to_support. execution_id=${executionId}; `
        + `problem_title="${title}"; background="${description || title}". `
        + `Infer the affected service_code and severity_code (by impact), and set language to the user's language.`)
      : dv(
        `把这次调查转人工支持。先用 get_investigation_result 取 execution_id=${executionId} 的结论，`
        + `再用 escalate_to_support 建案：problem_title 用一句话概括结论里的实际问题（不要用 execution_id）；`
        + `background 用结论里的关键症状/资源/时间窗；`
        + `请据此判断受影响服务的 service_code 和 severity_code（按影响严重性），language 按用户语言。`,
        `Escalate this investigation to human support. First call get_investigation_result for `
        + `execution_id=${executionId}, then call escalate_to_support: for problem_title, summarize the ACTUAL `
        + `problem from that conclusion in one line (never the execution_id); for background, use its key `
        + `symptoms / resources / time window. Infer the affected service_code and severity_code (by impact), `
        + `and set language to the user's language.`);
    fups.push({
      label: dv("🆘 转人工支持（AWS Support）", "🆘 Escalate to human support (AWS Support)"),
      prompt: escPrompt,
    });
  }
  if (fups.length) emit("followups", { followups: fups });
}
