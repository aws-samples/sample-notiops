/**
 * STAROps 回答 → **在线 HTML 报告**（与「深度调查（直连）」完全一样的效果）。
 *
 * 为什么需要这个模块（2026-09-13 现网实测的问题）：
 *   客户让阿里云数字员工做了一次巡检，答案末尾是员工自己给的一句
 *   「查看完整巡检报告（链接支持免密访问，7 天有效）」，点开**不是网页，而是下载一个 .md**。
 *   那条链接是**阿里云侧**生成的对象签名 URL，它的 `Content-Type` / `Content-Disposition`
 *   在阿里云那边，我们改不了。而 NotiOps 自己的深度调查报告一直是"点开即看网页"
 *   （见 `devops_investigate.mjs::saveHtmlReport`）—— 两条路径给客户的观感不一致。
 *
 * 做法：把这一轮的报告正文**网页化**一份放到 NotiOps 自己的报告 CDN 上，聊天里补一条
 * 「🌐 在线查看报告」。正文优先取阿里云那条 `.md` 的**原文全文**（免密链接，服务端 GET 即得），
 * 取不到就退回这一轮的答案正文 —— 两种情况**文案不同**，绝不把"只有摘要"说成"完整报告"。
 * 阿里云原链接**原样留在答案里**（那是客户自己账号里的产物，不替换、不隐藏）。
 *
 * 🔒 抓外链是这个模块唯一的风险点，四道闸门（顺序即代码顺序，别放松任何一条）：
 *   ① 只认 `https:`，默认 443，URL 里不许带 `user:pass@`；
 *   ② 主机名必须落在 `.aliyuncs.com`（阿里云对象存储）—— 链接来自**模型生成的文本**，
 *      不设允许清单等于让答案里任意一个 URL 指挥我们的 Lambda 去发请求（SSRF）；
 *   ③ **不跟随重定向**（`redirect:"error"`）：跟随就等于允许 302 到内网/元数据地址，
 *      前面两条闸门全部作废；
 *   ④ 体积 + 时间双上限（2 MB / 8s）—— 这一步跑在用户等答案的关键路径上。
 *  另：**永不记录整条 URL**（签名本身是凭据），日志里只出现主机名与字节数。
 *
 * 依赖注入（fetchImpl / putObject）是为了让上面四条闸门能离线单测，也为了 IM 端将来
 * 复用同一份逻辑（IM 侧同样要把巡检报告变成网页链接）。
 */

import { randomUUID } from "node:crypto";
import { renderReport } from "./report_html.mjs";

/** CDK 未替换的 `__FOO__` 占位符按"未配置"处理（与 devops_investigate.mjs::envClean 同策略）。 */
function envClean(name) {
  const v = (process.env[name] || "").trim();
  return v.startsWith("__") && v.endsWith("__") ? "" : v;
}

const REGION = process.env.AWS_REGION || "us-east-1";
const REPORTS_BUCKET = envClean("SKILLS_BUCKET");
const REPORTS_CDN_DOMAIN = envClean("REPORTS_CDN_DOMAIN");
const REPORTS_PREFIX = "reports";

/** 报告对象的生命周期：`reports/` 前缀 7 天过期（infra/lib/constructs/minimal-base-core.ts
 *  的 `expire-reports-7d`）。文案里的"7 天内有效"就是这个数，改一边必须改另一边 ——
 *  说成"长期有效"是假信息（客户第 8 天点开会拿到 CloudFront 的错误页）。 */
export const REPORT_VALID_DAYS = 7;

/** 抓外链的两条硬上限。放在导出位置是为了单测能直接引用，不用复制字面量。 */
export const FETCH_MAX_BYTES = 2 * 1024 * 1024;   // 2 MB：一份巡检 md 的量级是几十 KB
export const FETCH_TIMEOUT_MS = 8000;             // 用户正等着答案收尾，不能久等

/** 网页化的触发门槛：短答案不配报告（每条都挂一个链接是噪音，还白占对象存储）。 */
export const MIN_REPORT_CHARS = 1200;

/** 员工**没给**报告文件、只是答得长时的门槛 —— 比上面高得多。
 *  差别的理由：有报告文件时"这是一份报告"是员工自己说的，我们只是换个能看的形式；
 *  没有报告文件时那只是一段长回答，给每段长回答都挂一条链接会把链接变成背景噪音，
 *  客户于是连真报告那条也不点了。 */
export const MIN_STANDALONE_CHARS = 3000;

/** 正文进 HTML 前的字符上限：模板把 markdown 塞进一个客户端 JS 模板字面量里，
 *  一份几 MB 的正文会让网页在手机上打不开。截断时**在正文里说清楚**（见 clipMd）。 */
export const MAX_MD_CHARS = 300_000;

/**
 * 从答案正文里挑出**可抓取的阿里云报告链接**。
 *
 * 纯函数（这是四道闸门里的 ①②，也是单测的主战场）。刻意只认 `.md` / `.markdown`：
 * 这一步的全部目的是"把一个下载文件变成网页"，别的东西（图片、压缩包、控制台页面）
 * 抓下来也无从渲染，抓了只是白担风险。
 *
 * @param {string} text 答案正文（markdown）
 * @returns {string[]} 去重后的 URL（最多 2 条：一轮里出现第 3 个报告链接的情况没见过，
 *                     多抓只是给关键路径加延迟）
 */
export function extractAliyunReportUrls(text) {
  const out = [];
  const seen = new Set();
  // markdown 链接与裸 URL 都要认（员工两种写法都出现过）。以空白/右括号/中英文标点收尾。
  for (const m of String(text || "").matchAll(/https:\/\/[^\s()<>[\]"'，。；、]+/g)) {
    const raw = m[0].replace(/[.,;:!?)]+$/, "");   // 句末标点不属于 URL
    if (seen.has(raw)) continue;
    seen.add(raw);
    if (!isFetchableReportUrl(raw)) continue;
    out.push(raw);
    if (out.length >= 2) break;
  }
  return out;
}

/** 闸门 ①②：协议 / 端口 / 凭据 / 主机允许清单 / 扩展名。任一不满足 → false（不解释、不放行）。 */
export function isFetchableReportUrl(u) {
  let url;
  try { url = new URL(String(u)); } catch { return false; }
  if (url.protocol !== "https:") return false;
  if (url.port && url.port !== "443") return false;
  if (url.username || url.password) return false;          // `https://user:pass@host` 型绕过
  const host = url.hostname.toLowerCase();
  // 允许清单：阿里云对象存储（`<bucket>.oss-cn-<region>.aliyuncs.com` 等）。
  // ⚠️ 必须用 `.aliyuncs.com` 结尾比较，不能用 includes —— `aliyuncs.com.evil.tld` 会过。
  if (!host.endsWith(".aliyuncs.com")) return false;
  const path = url.pathname.toLowerCase();
  return path.endsWith(".md") || path.endsWith(".markdown");
}

/**
 * 闸门 ③④：抓一条报告 md。失败一律返回 ""（**不抛**）—— 报告网页化是锦上添花，
 * 不许因为它把客户已经拿到的答案毁掉。
 *
 * @param {string} url
 * @param {{fetchImpl?: Function, maxBytes?: number, timeoutMs?: number,
 *          onWarn?: (msg: string) => void}} [opts]
 */
export async function fetchReportMarkdown(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const maxBytes = opts.maxBytes || FETCH_MAX_BYTES;
  const warn = typeof opts.onWarn === "function" ? opts.onWarn : () => {};
  if (typeof fetchImpl !== "function" || !isFetchableReportUrl(url)) return "";
  const host = (() => { try { return new URL(url).hostname; } catch { return "?"; } })();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  try {
    const r = await fetchImpl(url, {
      method: "GET",
      redirect: "error",      // 闸门 ③：不跟随跳转
      signal: ac.signal,
      headers: { accept: "text/markdown, text/plain, */*" },
    });
    if (!r || !r.ok) {
      // 🔒 只记主机名与状态码，绝不记整条 URL（签名是凭据）。
      warn(`starops_report fetch_not_ok host=${host} status=${r?.status ?? "?"}`);
      return "";
    }
    const len = Number(r.headers?.get?.("content-length") || 0);
    if (len && len > maxBytes) {
      warn(`starops_report too_large host=${host} bytes=${len}`);
      return "";
    }
    const body = await r.text();
    if (body.length > maxBytes) {          // 没有 content-length 时的第二道体积闸门
      warn(`starops_report too_large_body host=${host} bytes=${body.length}`);
      return "";
    }
    return body;
  } catch (e) {
    // 超时 / DNS / 被重定向拦下都走这里。只记类型名（LOGGING_STANDARD）。
    warn(`starops_report fetch_failed host=${host} err=${e?.name || "Error"}`);
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/** 正文超长时截断，并**在正文里说明**（静默截断=让客户以为报告就这么长）。 */
export function clipMd(md, locale, max = MAX_MD_CHARS) {
  const s = String(md || "");
  if (s.length <= max) return s;
  const note = locale === "en"
    ? `\n\n---\n\n> ⚠️ This report was truncated at ${max.toLocaleString("en-US")} characters for web rendering. The original file on Alibaba Cloud holds the full text.\n`
    : `\n\n---\n\n> ⚠️ 为了网页可读，本报告在 ${max.toLocaleString("en-US")} 字符处截断。完整原文在阿里云侧那份文件里。\n`;
  return s.slice(0, max) + note;
}

/** 报告标题：取用户原话首行/首句（≤80），与 devops_investigate::deriveTitle 同一口径。 */
export function reportTitle(question, locale) {
  const firstLine = String(question || "").split("\n").map((l) => l.trim()).find(Boolean) || "";
  const m = /^(.{6,80}?)(?:[。．.!!?？；;]|$)/.exec(firstLine);
  const t = (m ? m[1] : firstLine).trim().slice(0, 80);
  const dflt = locale === "en" ? "STAROps report" : "STAROps 报告";
  return t || dflt;
}

/** S3 key 用的 slug（与 devops_investigate::slug 同实现：保留 CJK）。 */
function slug(s) {
  return (String(s || "").trim().toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)) || "report";
}

/** 报告正文前面那段来源说明。**必须有**：这份网页挂在 NotiOps 的域名下，但内容是
 *  客户自己的阿里云数字员工生成的 —— 不写清楚，客户会以为是 NotiOps 的结论。 */
export function provenanceBlock({ locale, employee, full }) {
  const emp = employee ? `\`${employee}\`` : (locale === "en" ? "(id unavailable)" : "（未取到 ID）");
  if (locale === "en") {
    return [
      `> Generated by **your own** Alibaba Cloud STAROps digital employee ${emp}.`,
      `> NotiOps only renders it as a web page -- the content is not reviewed or rewritten by NotiOps.`,
      full
        ? `> Source: the full report file produced by the digital employee.`
        : `> Source: the answer text of this turn (the digital employee did not expose a full report file).`,
      "",
    ].join("\n");
  }
  return [
    `> 本报告由**客户自有的**阿里云 STAROps 数字员工 ${emp} 生成。`,
    `> NotiOps 只做网页化呈现，不复核、不改写内容。`,
    full
      ? `> 来源：数字员工产出的完整报告文件。`
      : `> 来源：本轮回答正文（数字员工这一轮没有给出可读取的完整报告文件）。`,
    "",
  ].join("\n");
}

/**
 * 把报告写成自包含 HTML 落 S3，返回可点开的 CDN 链接。
 *
 * ⚠️ 与 `devops_investigate.mjs::saveHtmlReport` **有意各写一份**（那边只差前缀与标题）：
 * 引它会把整条 AWS DevOps Agent 依赖链（`devops_agent_skills` → SDK）拖进这条纯阿里云
 * 路径的冷启动里，而两条路径本来就该互不牵连。改动时两处都看一眼。
 *
 * 只走 PutObject，**不做 presigned 分支**：报告 CDN 是 CloudFront + OAC，
 * `https://<cdn>/reports/...` 直接可读；退化成 presign 只会得到更短的有效期。
 * CDN 未配置 → 返回 null（聊天里少一条链接，不报错、不编一个链接）。
 */
export async function saveStarOpsHtmlReport({ markdown, title, locale, putObject }) {
  if (!REPORTS_BUCKET || !REPORTS_CDN_DOMAIN) {
    console.warn("[starops-report] report_link_skipped bucket=%s cdn=%s",
      Boolean(REPORTS_BUCKET), Boolean(REPORTS_CDN_DOMAIN));
    return null;
  }
  try {
    const html = renderReport(markdown, {
      title,
      subtitle: locale === "en" ? "Alibaba Cloud STAROps Report" : "阿里云 STAROps 报告",
      meta: {},          // 阿里云侧没有 task/execution/space 这些概念，宁可空着也不塞错标签的值
      status: "COMPLETED",
      priority: "",
      // 落款不能沿用默认的 "NotiOps Deep Dive" —— 那是 AWS DevOps Agent 深度调查的名字，
      // 印在阿里云报告上会让客户去找一个跟本报告无关的入口。
      footer: "Generated by NotiOps -- Alibaba Cloud STAROps",
    });
    const today = new Date().toISOString().slice(0, 10);
    const key = `${REPORTS_PREFIX}/starops/${today}-${slug(title)}-${randomUUID().slice(0, 8)}.html`;
    const put = putObject || (async (params) => {
      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const s3 = new S3Client({ region: REGION });
      await s3.send(new PutObjectCommand(params));
    });
    await put({
      Bucket: REPORTS_BUCKET,
      Key: key,
      Body: Buffer.from(html, "utf-8"),
      ContentType: "text/html; charset=utf-8",
      ContentDisposition: "inline",   // 点开即看网页，而不是下载文件 —— 这就是本模块存在的理由
    });
    const base = REPORTS_CDN_DOMAIN.startsWith("http") ? REPORTS_CDN_DOMAIN : `https://${REPORTS_CDN_DOMAIN}`;
    return { url: `${base.replace(/\/+$/, "")}/${key}`, key };
  } catch (e) {
    console.warn(`[starops-report] save_failed ${e?.name || "Error"}`);
    return null;
  }
}

/** 追加进答案的那一行（也是落库文本的一部分，刷新后仍在）。
 *  `full` 决定说"完整报告"还是"本轮回答" —— 这两个词不许混用。 */
export function reportLinkLine({ url, locale, full }) {
  if (locale === "en") {
    return full
      ? `\n\n---\n🌐 [View the full report online (web page, valid ${REPORT_VALID_DAYS} days)](${url})\n`
      : `\n\n---\n🌐 [View this answer as an online report (web page, valid ${REPORT_VALID_DAYS} days)](${url})\n`;
  }
  return full
    ? `\n\n---\n🌐 [在线查看完整报告（网页，${REPORT_VALID_DAYS} 天内有效）](${url})\n`
    : `\n\n---\n🌐 [在线查看本轮报告（网页，${REPORT_VALID_DAYS} 天内有效）](${url})\n`;
}

/**
 * 整条收尾流程：判断该不该出报告 → 尽力抓阿里云原文 → 落 HTML → 回一段要追加进答案的
 * markdown（没有报告就回 ""）。**任何一步失败都只是回 ""**。
 *
 * @param {{reply:string, question:string, locale:string, employee?:string,
 *          emit?:(evt:string,data:object)=>void, fetchImpl?:Function,
 *          putObject?:Function}} a
 * @returns {Promise<string>} 要 append 到答案末尾的 markdown（含前导分隔线）
 */
export async function starOpsReportSuffix({ reply, question, locale, employee, emit, fetchImpl, putObject }) {
  const answer = String(reply || "");
  const urls = extractAliyunReportUrls(answer);
  // 门槛：员工给了报告文件 → 只要正文够一份报告就出网页；没给 → 要求答案**明显**是报告体量。
  if (urls.length === 0 && answer.length < MIN_STANDALONE_CHARS) return "";

  let fetched = "";
  for (const u of urls) {
    fetched = await fetchReportMarkdown(u, {
      fetchImpl,
      onWarn: (m) => console.warn(`[starops-report] ${m}`),
    });
    if (fetched.trim()) break;
  }
  const full = Boolean(fetched.trim());
  // 没抓到就用答案正文。此时**没有**"完整报告"这回事，文案跟着变（见 reportLinkLine）。
  const body = full ? fetched : answer;
  if (body.trim().length < MIN_REPORT_CHARS && !full) return "";

  const title = reportTitle(question, locale);
  const markdown = provenanceBlock({ locale, employee, full }) + "\n" + clipMd(body, locale);
  const saved = await saveStarOpsHtmlReport({ markdown, title, locale, putObject });
  if (!saved?.url) return "";

  // Sources 面板里也挂一条（与深度调查（直连）一致：报告是一条"来源"）。
  try {
    emit?.("sources", {
      sources: [{
        icon: "file",
        title: title + (locale === "en" ? " (online report)" : "（在线报告）"),
        detail: saved.url,
      }],
    });
  } catch { /* 面板挂不上不影响链接本身 */ }
  return reportLinkLine({ url: saved.url, locale, full });
}
