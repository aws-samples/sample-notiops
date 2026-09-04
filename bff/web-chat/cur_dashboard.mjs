/**
 * 客户 CUR 仪表盘数据端点 —— 4 个新 sheet（费用趋势/Credit/扩展支持/SP）的数据源。
 *
 * 链路：前端 → 本模块（DynamoDB 当天缓存）→ cost-agent MCP Lambda（SigV4 调用，跑 Athena 查客户 CUR）。
 * 缓存：notiops-web-chat 表，PK=cur-dash#<panel>，SK=<UTC日期>；当天命中直接返回，
 *       次日自然过期（与 finops.mjs 的 deep-dive-cache 同模式）。TTL 属性 48h 兜底清理。
 * 配置：COST_AGENT_MCP_URL（缺省时端点返回 available:false，前端不渲染这些 sheet）。
 *
 * 失败安全（**这个可选数据源绝不许拖垮别的功能**）：
 *   · 未配置        → available:false, reason:"not-configured"（侧栏本就隐藏这 4 个 sheet）。
 *   · 挂了/超时/403 → available:false, reason:"unavailable"（HTTP 200），只有这 4 个 sheet
 *     显示「暂时不可用」，FinOps 其余仪表盘和聊天照常；不抛到全局 catch 变 500。
 *   · 每次 MCP 调用都带超时，否则一个挂住的 Lambda URL 能让前端一直转圈到 BFF 超时。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SignatureV4 } from "@smithy/signature-v4";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Sha256 } from "@aws-crypto/sha256-js";
import { envConfigured } from "./authz.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
// envConfigured（authz.mjs，requiresEnv 门控的同一个判据）顺手挡掉未替换的
// `__COST_AGENT_MCP_URL__` 占位符：与 devops_agent_skills.mjs / devops_investigate.mjs
// 的 envClean、core/cost_agent_mcp.py::_env 同策略。
// 少了这一步，`__COST_AGENT_MCP_URL__` 是 truthy → 下面 `if (!MCP_URL) throw` 拦不住，
// 于是 4 个 CUR sheet 不显示「数据源未配置」而是转圈后报一个签名/DNS 错误。
// 走 envConfigured 而不是就地写正则，是为了让「侧栏隐不隐这 4 个 sheet」与
// 「数据路由认不认这个 URL」永远同一判据 —— 否则会出现入口在、点进去报错。
const MCP_URL = envConfigured("COST_AGENT_MCP_URL")
  ? (process.env.COST_AGENT_MCP_URL || "").trim().replace(/\/$/, "")
  : "";
const TABLE = process.env.WEB_CHAT_TABLE || "notiops-web-chat";
const DATA_BUCKET = process.env.SKILLS_BUCKET || process.env.DATA_BUCKET || "";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

// 超时：initialize 是控制面调用（不跑 Athena）给 20s；工具调用跑 Athena 给 120s。
const INIT_TIMEOUT_MS = Number(process.env.COST_AGENT_MCP_INIT_TIMEOUT_MS || 20000);
const CALL_TIMEOUT_MS = Number(process.env.COST_AGENT_MCP_TIMEOUT_MS || 120000);

let _mcpInit = false;

async function mcpPost(payload, timeoutMs = CALL_TIMEOUT_MS) {
  const url = new URL(MCP_URL + "/mcp");
  const body = JSON.stringify(payload);
  const signer = new SignatureV4({ credentials: defaultProvider(), region: REGION, service: "lambda", sha256: Sha256 });
  const signed = await signer.sign({
    method: "POST", protocol: "https:", hostname: url.hostname, path: url.pathname,
    headers: { host: url.hostname, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
  });
  const resp = await fetch(url.href, {
    method: "POST", headers: signed.headers, body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`mcp HTTP ${resp.status}`);
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(text);
}

async function callTool(name, args = {}) {
  if (!MCP_URL) throw new Error("COST_AGENT_MCP_URL not configured");
  if (!_mcpInit) {
    await mcpPost({ jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "notiops-bff", version: "1" } } },
      INIT_TIMEOUT_MS);
    _mcpInit = true;
  }
  const r = await mcpPost({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  if (r.error) throw new Error(r.error.message || "tool error");
  const text = (r.result?.content || []).map((c) => c.text || "").join("");
  return JSON.parse(text);
}

// 日期基准统一北京时间（UTC+8）：预热跑在北京 6:00（UTC 22:00，UTC 日期未翻），
// 若按 UTC 算 key，北京 8:00 后（UTC 过 0 点）用户请求的 key 变"新一天"→ 预热缓存全 miss。
const day = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

async function cached(panel, fetcher) {
  const key = { PK: `cur-dash#${panel}`, SK: day() };
  try {
    const hit = await ddb.send(new GetCommand({ TableName: TABLE, Key: key }));
    if (hit.Item?.payload) return { ...JSON.parse(hit.Item.payload), cached: true, asOf: hit.Item.asOf };
  } catch { /* 缓存读失败 → 现查 */ }
  const data = await fetcher();
  const asOf = new Date().toISOString();
  try {
    await ddb.send(new PutCommand({ TableName: TABLE, Item: {
      ...key, payload: JSON.stringify(data), asOf,
      ttl: Math.floor(Date.now() / 1000) + 48 * 3600,
    } }));
  } catch { /* 缓存写失败不影响返回 */ }
  return { ...data, cached: false, asOf };
}

/** 大 payload（>DDB 400KB 单条上限）走 S3 当天缓存。 */
async function cachedS3(name, fetcher) {
  const key = `cur-dash-cache/${name}-${day()}.json`;
  if (DATA_BUCKET) {
    try {
      const hit = await s3.send(new GetObjectCommand({ Bucket: DATA_BUCKET, Key: key }));
      const text = await hit.Body.transformToString();
      return { ...JSON.parse(text), cached: true };
    } catch { /* miss → 现查 */ }
  }
  const data = { ...(await fetcher()), asOf: new Date().toISOString() };
  if (DATA_BUCKET) {
    try {
      await s3.send(new PutObjectCommand({ Bucket: DATA_BUCKET, Key: key,
        Body: JSON.stringify(data), ContentType: "application/json" }));
    } catch { /* 写失败不影响返回 */ }
  }
  return { ...data, cached: false };
}

/** 可选数据源的失败边界：任何异常都收敛成 available:false（HTTP 200），不冒泡成 500。
 *  日志只留异常类型 / mcp HTTP 状态 —— 不记 URL、不记 payload、不记查询参数。 */
async function soft(panel, fn) {
  try {
    return await fn();
  } catch (e) {
    const code = typeof e?.message === "string" && e.message.startsWith("mcp HTTP")
      ? e.message : (e?.name || "Error");
    console.warn(`cur-dash ${panel}: source unavailable (${code})`);
    return { available: false, reason: "unavailable" };
  }
}

/** GET /cur-dash/cube?days=30[&from=YYYY-MM-DD&to=YYYY-MM-DD] —— 费用趋势立方体（~1.2MB → S3 缓存） */
export async function curCube(days = 30, dateFrom = "", dateTo = "") {
  if (!MCP_URL) return { available: false, reason: "not-configured" };
  const rangeKey = dateFrom && dateTo ? `${dateFrom}_${dateTo}` : `d${days}`;
  return soft("cube", () => cachedS3(`cube-${rangeKey}`, async () => {
    const args = dateFrom && dateTo ? { date_from: dateFrom, date_to: dateTo } : { days: Number(days) || 30 };
    const r = await callTool("get_cost_cube", args);
    return { available: true, ...r.data, caliber: r.caliber_note };
  }));
}

/** 统一 date-range 参数：from/to 都传用之；否则默认 T-33 ~ T-3（CUR 封窗）。 */
function rangeOf(from, to) {
  const d = (n) => new Date(Date.now() + (8 * 3600 - n * 86400) * 1000).toISOString().slice(0, 10);
  return from && to ? { from, to } : { from: d(33), to: d(3) };
}

/** GET /cur-dash/credit?from=YYYY-MM-DD&to=YYYY-MM-DD —— Credit 明细与汇总 */
export async function curCredit(from, to) {
  if (!MCP_URL) return { available: false, reason: "not-configured" };
  const r0 = rangeOf(from, to);
  const args = { date_from: r0.from, date_to: r0.to, kind: "credit" };
  return soft("credit", () => cached(`credit-${r0.from}_${r0.to}`, async () => {
    const [r, d] = await Promise.all([
      callTool("get_adjustments", args),
      callTool("get_adjustments", { ...args, granularity: "daily" }),
    ]);
    return { available: true, ...r0, ...r.data, daily_by_service: d.data?.daily_by_service ?? [], caliber: r.caliber_note };
  }));
}

/** GET /cur-dash/extended-support?from=&to= —— 日明细 ~3300 行超 DDB 400KB → S3 缓存 */
export async function curExtendedSupport(from, to) {
  if (!MCP_URL) return { available: false, reason: "not-configured" };
  const r0 = rangeOf(from, to);
  const args = { date_from: r0.from, date_to: r0.to };
  return soft("extended-support", () => cachedS3(`es-${r0.from}_${r0.to}`, async () => {
    const [r, d] = await Promise.all([
      callTool("get_extended_support", args),
      callTool("get_extended_support", { ...args, granularity: "daily" }),
    ]);
    return { available: true, ...r0, ...r.data, daily: d.data?.daily ?? [], caliber: r.caliber_note };
  }));
}

/** GET /cur-dash/sp?from=YYYY-MM-DD&to=YYYY-MM-DD —— SP 明细表 + 利用率/覆盖率/浪费 日趋势（QS 6 图数据）。
 *  浪费两组各 ~2600 行，超 DDB 400KB → S3 缓存。 */
export async function curSavingsPlans(from, to) {
  if (!MCP_URL) return { available: false, reason: "not-configured" };
  const r0 = rangeOf(from, to);
  const args = { date_from: r0.from, date_to: r0.to };
  return soft("sp", () => cachedS3(`sp-${r0.from}_${r0.to}`, async () => {
    const [details, covDaily, util, covVcpu, dash] = await Promise.all([
      callTool("get_sp_details", { ...args, top_n: 50 }),
      callTool("get_sp_coverage", { ...args, granularity: "daily" }),
      callTool("get_sp_utilization", args),
      callTool("get_vcpu_metrics", { ...args, metric: "sp_coverage", granularity: "daily" }),
      callTool("get_sp_dashboard_daily", args),
    ]);
    return {
      available: true, ...r0,
      details: details.data, coverageDaily: covDaily.data, utilization: util.data,
      coverageVcpuDaily: covVcpu.data,
      utilizationDaily: dash.data?.utilization_daily ?? [],
      utilizationVcpuDaily: dash.data?.utilization_vcpu_daily ?? [],
      wasteCostDaily: dash.data?.waste_cost_daily ?? [],
      wasteVcpuDaily: dash.data?.waste_vcpu_daily ?? [],
      caliber: details.caliber_note,
    };
  }));
}
