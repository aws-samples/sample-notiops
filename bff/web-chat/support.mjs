/**
 * AWS Support 写操作执行器（BFF 侧，官方 @aws-sdk/client-support）。
 *
 * 写操作（创建/回复/关闭 case）由 agent 仅"提议"，用户在 UI 点确认后，前端调
 * POST /actions/execute → 本模块用 BFF 的 IAM 角色真正执行。**执行不经过 LLM**，
 * 完全确定性，且严格按用户确认的参数。Support API 是全局服务，固定 us-east-1。
 *
 * 计划不足（Basic/Developer）→ SubscriptionRequiredException，统一转成
 * {ok:false, code:"support_plan_required"} 让前端优雅提示。
 */
import {
  SupportClient,
  CreateCaseCommand,
  AddCommunicationToCaseCommand,
  ResolveCaseCommand,
  DescribeCasesCommand,
  DescribeServicesCommand,
} from "@aws-sdk/client-support";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { fillAccountNames } from "./accounts.mjs";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

// 多账号基座（BFF 侧）：按目标账号拿 SupportClient。
// account_id 缺省/部署账号 → 本地凭证（缓存复用）；其他账号 → STS AssumeRole。
// 与 agent 侧 core/aws_session.py 同语义；角色名约定一致。
const _localClient = new SupportClient({ region: "us-east-1" });
const _sts = new STSClient({ region: "us-east-1" });
const CROSS_ACCT_ROLE = process.env.NOTIOPS_CROSS_ACCOUNT_ROLE || "notiops-idle-detection-role";
const LOCKED_ACCOUNT_ID = (process.env.LOCKED_ACCOUNT_ID || "").trim();

let _deployAccount = null;
async function deployAccountId() {
  if (LOCKED_ACCOUNT_ID) return LOCKED_ACCOUNT_ID;
  if (_deployAccount === null) {
    try {
      const id = await _sts.send(new (await import("@aws-sdk/client-sts")).GetCallerIdentityCommand({}));
      _deployAccount = id.Account || "";
    } catch { _deployAccount = ""; }
  }
  return _deployAccount || null;
}

/** 返回针对 account_id 的 SupportClient；跨账号闸门拒绝/AssumeRole 失败 → null。 */
async function supportClientFor(accountId) {
  const acct = (accountId || "").toString().trim();
  const deploy = await deployAccountId();
  if (!acct || (deploy && acct === deploy)) return _localClient; // 部署账号
  if (LOCKED_ACCOUNT_ID && acct !== LOCKED_ACCOUNT_ID) return null; // 跨账号 disabled
  try {
    const out = await _sts.send(new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${acct}:role/${CROSS_ACCT_ROLE}`,
      RoleSessionName: `NotiOpsWebChat-${acct}`,
      DurationSeconds: 3600,
    }));
    const c = out.Credentials;
    return new SupportClient({
      region: "us-east-1",
      credentials: { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken },
    });
  } catch {
    return null;
  }
}

function wrapErr(e) {
  const code = e?.name || e?.Code || "SupportError";
  if (code === "SubscriptionRequiredException") {
    return { ok: false, code: "support_plan_required",
             message: "AWS Support API 需要 Business / Enterprise On-Ramp / Enterprise 支持计划。" };
  }
  return { ok: false, code, message: String(e?.message || e) };
}

/**
 * 只读：拉一次 case 列表，汇总成 L2 动态推荐 prompt 需要的数据。
 * 返回 {ok, openCount, totalCount, latest:{displayId,subject,severity}, bySeverity:{...}}。
 * 计划不足/失败 → {ok:false, code}，前端据此回退 L1 模板。
 */
export async function casesSummary(accountId) {
  try {
    const cli = await supportClientFor(accountId);
    if (!cli) return { ok: false, code: "cross_account_unavailable" };
    const out = await cli.send(new DescribeCasesCommand({
      includeResolvedCases: true,
      includeCommunications: false,
      maxResults: 100,
    }));
    const cases = out.cases || [];
    const isOpen = (c) => !["resolved", "closed"].includes((c.status || "").toLowerCase());
    const open = cases.filter(isOpen);
    // 最近一个（timeCreated 倒序）；describe_cases 通常已倒序，这里稳妥再排一次
    const sorted = [...cases].sort((a, b) => String(b.timeCreated || "").localeCompare(String(a.timeCreated || "")));
    const latest = sorted[0];
    const bySeverity = {};
    for (const c of open) {
      const s = (c.severityCode || "unknown").toLowerCase();
      bySeverity[s] = (bySeverity[s] || 0) + 1;
    }
    return {
      ok: true,
      openCount: open.length,
      totalCount: cases.length,
      latest: latest ? {
        displayId: latest.displayId || latest.caseId,
        subject: latest.subject || "",
        severity: latest.severityCode || "",
        status: latest.status || "",
      } : null,
      bySeverity,
    };
  } catch (e) {
    return wrapErr(e);
  }
}

// ES 响应时间目标(小时)——用于 SLA 启发式(非官方 SLA,DescribeCases 不返回 SLA 字段)
const SEV_TARGET_HOURS = { critical: 0.25, urgent: 1, high: 4, normal: 12, low: 24 };
function _sevRank(s) { return ({ critical: 5, urgent: 4, high: 3, normal: 2, low: 1 })[(s || "").toLowerCase()] || 0; }

/**
 * Cases 仪表盘数据(只读):一次 DescribeCases → 4 块:
 *   overview(按 severity/service)、waiting(等客户回复)、incidents(高危未结)、sla(响应健康启发式)。
 * SLA 说明:AWS Support API 不返回 SLA 字段,这里用「距最后一条往来的时长 vs 按 severity 的 ES 响应目标」估算,
 *   前端标注为估算值,非官方 SLA。
 */
export async function casesDashboard(accountId) {
  try {
    const cli = await supportClientFor(accountId);
    if (!cli) return { ok: false, code: "cross_account_unavailable" };
    const out = await cli.send(new DescribeCasesCommand({
      includeResolvedCases: true,
      includeCommunications: true, // 需要最近往来时间算 SLA/等待时长
      maxResults: 100,
    }));
    const cases = out.cases || [];
    const now = Date.now();
    const isOpen = (c) => !["resolved", "closed"].includes((c.status || "").toLowerCase());
    const open = cases.filter(isOpen);
    const daysSince = (iso) => iso ? Math.max(0, Math.round(((now - Date.parse(iso)) / 86400000) * 10) / 10) : null;
    const hoursSince = (iso) => iso ? Math.max(0, (now - Date.parse(iso)) / 3600000) : null;
    // recentCommunications 通常按时间倒序,[0] 即最新一条往来;缺则回退建案时间
    const lastActivity = (c) => (c.recentCommunications?.communications || [])[0]?.timeCreated || c.timeCreated;

    // 1) overview
    const bySeverity = {};
    for (const c of open) { const s = (c.severityCode || "unknown").toLowerCase(); bySeverity[s] = (bySeverity[s] || 0) + 1; }
    const svcMap = {};
    for (const c of open) { const s = c.serviceCode || "unknown"; svcMap[s] = (svcMap[s] || 0) + 1; }
    const byService = Object.entries(svcMap).map(([service, count]) => ({ service, count })).sort((a, b) => b.count - a.count).slice(0, 5);

    // 2) waiting on customer —— status = pending-customer-action(AWS 在等客户回)
    const waiting = open.filter((c) => (c.status || "").toLowerCase() === "pending-customer-action")
      .map((c) => ({ displayId: c.displayId || c.caseId, subject: c.subject || "", severity: c.severityCode || "", waitingDays: daysSince(lastActivity(c)), ageDays: daysSince(c.timeCreated) }))
      .sort((a, b) => (b.waitingDays || 0) - (a.waitingDays || 0));

    // 3) incidents —— 高危(critical/urgent/high)未结
    const INC = new Set(["critical", "urgent", "high"]);
    const incidents = open.filter((c) => INC.has((c.severityCode || "").toLowerCase()))
      .map((c) => ({ displayId: c.displayId || c.caseId, subject: c.subject || "", severity: c.severityCode || "", status: c.status || "", ageDays: daysSince(c.timeCreated) }))
      .sort((a, b) => _sevRank(b.severity) - _sevRank(a.severity) || (b.ageDays || 0) - (a.ageDays || 0));

    // 4) SLA/响应健康(启发式):距最后往来时长 vs severity 目标
    let onTrack = 0, atRisk = 0, breached = 0;
    const worst = [];
    for (const c of open) {
      const sev = (c.severityCode || "normal").toLowerCase();
      const target = SEV_TARGET_HOURS[sev] ?? 12;
      const h = hoursSince(lastActivity(c));
      if (h == null) continue;
      let state;
      if (h <= target) { state = "on-track"; onTrack++; }
      else if (h <= target * 2) { state = "at-risk"; atRisk++; }
      else { state = "breached"; breached++; }
      worst.push({ displayId: c.displayId || c.caseId, subject: c.subject || "", severity: c.severityCode || "", hoursSinceActivity: Math.round(h * 10) / 10, targetHours: target, state });
    }
    worst.sort((a, b) => (b.hoursSinceActivity / b.targetHours) - (a.hoursSinceActivity / a.targetHours));

    return {
      ok: true,
      openCount: open.length,
      totalCount: cases.length,
      bySeverity,
      byService,
      waiting: { count: waiting.length, cases: waiting.slice(0, 6) },
      incidents: { count: incidents.length, cases: incidents.slice(0, 6) },
      sla: { onTrack, atRisk, breached, worst: worst.slice(0, 6) },
    };
  } catch (e) {
    return wrapErr(e);
  }
}

/** 6 个月 support case 趋势聚合 + AI 建议（service manager 视角）。只读。 */
export async function getCasesTrends(accountId) {
  try {
    const cli = await supportClientFor(accountId);
    if (!cli) return { ok: false, code: "cross_account_unavailable" };
    const afterTime = new Date(Date.now() - 183 * 86400000).toISOString(); // ~6 个月
    const cases = [];
    let nextToken;
    let pages = 0;
    do {
      const out = await cli.send(new DescribeCasesCommand({
        includeResolvedCases: true,
        includeCommunications: false,
        afterTime,
        maxResults: 100,
        nextToken,
      }));
      cases.push(...(out.cases || []));
      nextToken = out.nextToken;
      pages++;
    } while (nextToken && pages < 20); // 上限 2000 case，避免超时

    const monthKey = (iso) => { const d = new Date(iso); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
    const sevMap = {}, svcMap = {}, monthMap = {}, statusMap = {};
    let resolved = 0, pendingCustomer = 0;
    for (const c of cases) {
      const sev = (c.severityCode || "unknown").toLowerCase(); sevMap[sev] = (sevMap[sev] || 0) + 1;
      const svc = c.serviceCode || "unknown"; svcMap[svc] = (svcMap[svc] || 0) + 1;
      const st = (c.status || "unknown").toLowerCase(); statusMap[st] = (statusMap[st] || 0) + 1;
      if (["resolved", "closed"].includes(st)) resolved++;
      if (st === "pending-customer-action") pendingCustomer++;
      if (c.timeCreated) { const m = monthKey(c.timeCreated); monthMap[m] = (monthMap[m] || 0) + 1; }
    }
    const bySeverity = Object.entries(sevMap).map(([severity, count]) => ({ severity, count })).sort((a, b) => b.count - a.count);
    const byService = Object.entries(svcMap).map(([service, count]) => ({ service, count })).sort((a, b) => b.count - a.count).slice(0, 8);
    const byMonth = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(); d.setUTCMonth(d.getUTCMonth() - i);
      const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      byMonth.push({ month: m, count: monthMap[m] || 0 });
    }
    const agg = {
      total: cases.length, resolved, open: cases.length - resolved,
      pendingCustomer, pendingCustomerPct: cases.length ? Math.round((pendingCustomer / cases.length) * 1000) / 10 : 0,
      bySeverity, byService, byMonth, periodMonths: 6,
    };
    const ai = await _casesTrendInsight(agg);
    return { ok: true, ...agg, insight: ai.insight, recommendations: ai.recommendations, aiError: ai.aiError };
  } catch (e) {
    return wrapErr(e);
  }
}

/** 对 6 个月 case 聚合出 service-manager 视角的洞察 + 建议（grounded，只用真实计数）。 */
async function _casesTrendInsight(agg) {
  try {
    const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
    const prompt = `You are an AWS Support operations analyst advising a Service Manager focused on process quality and vendor management. Below is a 6-month aggregation of this account's AWS Support cases (real counts, never invent numbers). Return STRICT JSON:
{"insight":"<2-3 sentences: which services and severities dominate the support load over the 6 months, cite the real counts, note any month-over-month trend and the pending-customer ratio>","recommendations":["<actionable recommendations for a service manager: e.g. concentrated <service> cases -> invest team enablement/training in that area; high pending-customer ratio -> tighten internal response process; recurring high-sev -> architecture review with the service team. 2-4 items, most impactful first, tie each to a real number>"]}
Data: ${JSON.stringify(agg)}
Return ONLY the JSON object, no markdown.`;
    const resp = await bedrock.send(new ConverseCommand({
      // 注：这里的 model 是**硬编码**、不走 llmcfg 目录 —— 它是 dashboard 洞察生成，
      // 不是用户可选的对话模型。已与目录口径对齐到 global.*（决策 2026-07）；
      // 2026-09-01 随产品默认模型一起改成 Grok 4.6（= 目录的 default_model）。
      // 若要纳入 Admin 管理，应作为一类 backend_task 加进目录（现有的只有
      // phd_translate / devops_report_summarize 两个），而不是在这里各自写死。
      modelId: "global.xai.grok-4.6",
      messages: [{ role: "user", content: [{ text: prompt }] }],
      // **不要传 temperature**（换成 Grok 之后这条依然成立，别"顺手加回来"）。
      // 教训来自 Sonnet 5：它弃用了该参数（adaptive thinking 常驻），传了整个请求
      // ValidationException:「`temperature` is deprecated for this model」—— 而这一段的
      // 异常被兜进 aiError，界面表现只是"洞察是空的"，没有任何报错。实测 2026-08-26
      // 确认：带 temperature 必失败，去掉即正常。这里的模型是可改的（见上），所以不能
      // 依赖"当前这个模型接受 temperature"；确定性也不靠采样参数，靠提示词里的
      // STRICT JSON 约束。同一个坑在 llm_config.mjs 的探测里踩过一次，那次至少有
      // 枚举态可查，这里连状态都没有。
      inferenceConfig: { maxTokens: 900 },
    }));
    const txt = resp.output?.message?.content?.[0]?.text || "";
    const parsed = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    return {
      insight: String(parsed.insight || ""),
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String).slice(0, 5) : [],
    };
  } catch (e) {
    return { insight: "", recommendations: [], aiError: String(e?.message || e) };
  }
}

/**
 * 写操作后回查 case 真实状态，用于"验证执行是否真的成功"。
 * 返回 {found, status, subject, latestMatches}。失败/读不到 → found:false（不抛）。
 * @param opts.latestBody 若提供，校验该 case 最新一条往来是否包含此内容（回复验证用）。
 */
async function verifyCase(cli, caseId, opts = {}) {
  if (!caseId || !cli) return { found: false };
  try {
    const out = await cli.send(new DescribeCasesCommand({
      caseIdList: [caseId],
      includeResolvedCases: true,
      includeCommunications: Boolean(opts.latestBody),
    }));
    const c = (out.cases || [])[0];
    if (!c) return { found: false };
    let latestMatches = true;
    if (opts.latestBody) {
      const comms = (c.recentCommunications && c.recentCommunications.communications) || [];
      const newest = comms[0]?.body || "";
      // 宽松匹配：最新往来里包含我们发的内容片段即视为已落库
      const probe = String(opts.latestBody).slice(0, 40);
      latestMatches = newest.includes(probe);
    }
    // displayId 是控制台/用户面向的短标识；caseId 是内部长 ID（创建时只返回 caseId）。
    return { found: true, status: c.status, subject: c.subject,
             displayId: c.displayId, caseId: c.caseId, latestMatches };
  } catch {
    return { found: false };
  }
}

// AWS Support 的 ResolveCase / AddCommunicationToCase 只认**内部长 caseId**
// (形如 case-<12位账号>-mu..-<年>-...)，但用户/agent 常给的是**显示短 ID**(纯数字, 如
// 178307825600138)。这里把给定 id 统一解析成内部 caseId:
//  - 已是内部格式(含连字符/以 case- 开头)→ 原样用;
//  - 纯数字(displayId)→ 用 DescribeCases 的 displayId 过滤查回内部 caseId。
// 解析不到 → 返回原值(让底层报错, 附带清晰信息)。
async function resolveCaseId(cli, given) {
  const id = String(given || "").trim();
  if (!id) return id;
  if (id.startsWith("case-") || id.includes("-")) return id; // 已是内部 ID
  if (!/^\d+$/.test(id)) return id;                            // 非纯数字, 不是 displayId, 原样
  try {
    const out = await cli.send(new DescribeCasesCommand({
      displayId: id, includeResolvedCases: true, includeCommunications: false,
    }));
    const c = (out.cases || [])[0];
    return (c && c.caseId) ? c.caseId : id;
  } catch {
    return id;
  }
}

/** 执行一个已被用户确认的写操作。action = {type, params, account_id}。
 *  按 account_id 拿目标账号 client（缺省=部署账号）。 */
export async function executeAction(action) {
  const type = action?.type;
  const p = action?.params || {};
  // 目标账号：action.account_id（agent 提议时写入），缺省=部署账号
  const reqAcct = (action?.account_id || "").toString().trim();
  // 审计（防御性可观测）：写操作明确记录落到哪个账号。空 account_id = 部署账号(单账号
  // 常态,合法),不作硬失败——但若前端漏传(历史 bug: confirmAction 重建 toExec 丢 account_id)
  // 导致 linked-account 写操作误落部署账号,这行日志能第一时间暴露,便于回归定位。
  const deploy = await deployAccountId();
  const effAcct = reqAcct || deploy || "(deploy)";
  console.log(`[executeAction] type=${type} requestedAccount=${reqAcct || "(empty→deploy)"} effectiveAccount=${effAcct}`);
  const cli = await supportClientFor(reqAcct);
  if (!cli) return { ok: false, code: "cross_account_unavailable",
                     message: "无法访问目标 AWS 账号（未注册/角色未部署/单账号锁定）。" };
  try {
    if (type === "create_case") {
      const out = await cli.send(new CreateCaseCommand({
        subject: p.subject,
        communicationBody: p.communication_body,
        serviceCode: p.service_code,
        categoryCode: p.category_code,
        severityCode: p.severity_code || "low",
        issueType: p.issue_type || "technical",  // technical / customer-service / service-limit-increase
        language: p.language || "en",
        ...(Array.isArray(p.cc_email_addresses) && p.cc_email_addresses.length
          ? { ccEmailAddresses: p.cc_email_addresses.slice(0, 10) } : {}),
      }));
      const v = await verifyCase(cli, out.caseId);
      return { ok: true, verified: v.found, type, caseId: out.caseId,
               displayId: v.displayId || out.caseId, status: v.status, subject: v.subject };
    }
    if (type === "add_communication") {
      // 统一把 displayId(纯数字)解析成内部 caseId(API 只认内部 ID)。
      const cid = await resolveCaseId(cli, p.case_id);
      const out = await cli.send(new AddCommunicationToCaseCommand({
        caseId: cid,
        communicationBody: p.communication_body,
        ...(Array.isArray(p.cc_email_addresses) && p.cc_email_addresses.length
          ? { ccEmailAddresses: p.cc_email_addresses.slice(0, 10) } : {}),
      }));
      const apiOk = Boolean(out.result ?? true);
      const v = await verifyCase(cli, cid, { latestBody: p.communication_body });
      return { ok: apiOk, verified: v.found && v.latestMatches, type, caseId: cid,
               displayId: v.displayId || p.case_id, status: v.status };
    }
    if (type === "resolve_case") {
      const cid = await resolveCaseId(cli, p.case_id);
      const out = await cli.send(new ResolveCaseCommand({ caseId: cid }));
      const finalStatus = out.finalCaseStatus;
      const v = await verifyCase(cli, cid);
      const closed = ["resolved", "closed"].includes((v.status || finalStatus || "").toLowerCase());
      return { ok: true, verified: v.found && closed, type, caseId: cid,
               displayId: v.displayId || p.case_id,
               initialStatus: out.initialCaseStatus, finalStatus: finalStatus || v.status, status: v.status };
    }
    return { ok: false, code: "unknown_action", message: `未知操作类型: ${type}` };
  } catch (e) {
    return wrapErr(e);
  }
}

// 服务目录缓存（进程内）：AWS Support 服务/类别目录很大且几乎不变，按 language 缓存
// 避免每次开卡都拉一遍。缺省 language=en（服务/类别 code 与语言无关，label 才有）。
const _svcCache = new Map(); // language -> {ts, services:[{code,name,categories:[{code,name}]}]}
const _SVC_TTL_MS = 6 * 3600 * 1000;

/** 创建案例卡片的**服务/类别下拉数据源**：describe-services 全量目录。
 *  仅读、按 language 缓存。计划不足/失败 → {ok:false,...}，前端可回退让客户手填 serviceCode。 */
export async function describeServices(language = "en") {
  const lang = (language || "en").toString();
  const hit = _svcCache.get(lang);
  if (hit && Date.now() - hit.ts < _SVC_TTL_MS) return { ok: true, services: hit.services, cached: true };
  try {
    // Support API 是全局服务，用部署账号本地凭证即可（服务目录与目标账号无关）。
    const out = await _localClient.send(new DescribeServicesCommand({ language: lang }));
    const services = (out.services || []).map((s) => ({
      code: s.code,
      name: s.name,
      categories: (s.categories || []).map((c) => ({ code: c.code, name: c.name })),
    })).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    _svcCache.set(lang, { ts: Date.now(), services });
    return { ok: true, services };
  } catch (e) {
    return wrapErr(e);
  }
}


// ─── 组织级 Cases 汇总（预聚合 v1：DDB 缓存 + 受限并发扇出）───
// 100+ 账号的终局形态是 EventBridge 定时聚合；
// v1 用请求触发 + 15 分钟 DDB 缓存，账号数 ≤~20 时延迟可接受，且缓存命中后毫秒级。
import { DynamoDBClient as _AggDdbClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient as _AggDoc, GetCommand as _AggGet, PutCommand as _AggPut, QueryCommand as _AggQuery } from "@aws-sdk/lib-dynamodb";
const _aggDdb = _AggDoc.from(new _AggDdbClient({}), { marshallOptions: { removeUndefinedValues: true } });
const _AGG_TABLE = process.env.WEB_CHAT_TABLE || "notiops-web-chat";
const _CFG_TABLE = process.env.CONFIG_TABLE || "notiops-config";
const _AGG_TTL_MS = 15 * 60 * 1000;

async function _enabledAccounts() {
  const r = await _aggDdb.send(new _AggQuery({
    TableName: _CFG_TABLE, IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "accounts" },
  }));
  // 排除部署账号登记行（rollup 已有内置 "(deployment account)" 行，重复会双计）
  const self = await deployAccountId();
  return (r.Items || []).filter((it) => it.enabled === true && String(it.account_id) !== String(self || ""))
    .map((it) => ({ accountId: String(it.account_id), name: String(it.account_name || it.name || it.account_id) }));
}

/** 组织级汇总：部署账号 + 全部 enabled 成员账号的 open cases 概览 + Top-N 问题账号。
 *  visibleSet: "*" 或 Set<accountId>（可见性 RBAC 过滤聚合读）。 */
export async function casesOrgSummary(visibleSet) {
  // 缓存读
  const cacheKey = { PK: "agg#cases", SK: "__rollup__" };
  try {
    const hit = await _aggDdb.send(new _AggGet({ TableName: _AGG_TABLE, Key: cacheKey }));
    if (hit.Item && Date.now() - (hit.Item.at || 0) < _AGG_TTL_MS) {
      return _filterRollup(hit.Item.data, visibleSet);
    }
  } catch { /* 缓存不可用不阻断 */ }

  const members = await _enabledAccounts();
  const self = await deployAccountId();
  // 部署账号名（config 有则用，否则 Organizations DescribeAccount，兜底 Management account）
  let selfName = "";
  try {
    const cfg = await _aggDdb.send(new _AggGet({ TableName: _CFG_TABLE, Key: { PK: `account#${self}`, SK: "meta" } }));
    selfName = (cfg.Item && cfg.Item.account_name) || "";
    if (!selfName && self) {
      const { OrganizationsClient, DescribeAccountCommand } = await import("@aws-sdk/client-organizations");
      selfName = (await new OrganizationsClient({}).send(new DescribeAccountCommand({ AccountId: self })))?.Account?.Name || "";
    }
  } catch { /* 兜底 */ }
  selfName = selfName || "Management account";
  const targets = [{ accountId: "", queryId: "", name: selfName, selfId: self }, ...members.map((m) => ({ ...m, queryId: m.accountId }))];
  // 受限并发扇出（每批 5）
  const perAccount = [];
  for (let i = 0; i < targets.length; i += 5) {
    const batch = targets.slice(i, i + 5);
    const settled = await Promise.allSettled(batch.map(async (a) => {
      const r = await casesSummary(a.queryId);
      return { accountId: a.queryId || a.selfId || "", name: a.name, isDeployment: !a.queryId, ...r };
    }));
    for (const x of settled) if (x.status === "fulfilled") perAccount.push(x.value);
  }
  const rows = perAccount.map((r) => ({
    accountId: r.accountId, name: r.name, isDeployment: !!r.isDeployment,
    open: r.openCount || 0,
    high: r.bySeverity ? ((r.bySeverity.critical || 0) + (r.bySeverity.urgent || 0) + (r.bySeverity.high || 0)) : 0,
    available: r.ok !== false,
  }));
  const data = {
    generatedAt: new Date().toISOString(),
    accountsCovered: rows.filter((x) => x.available).length,
    accountsFailed: rows.filter((x) => !x.available).map((x) => x.accountId),
    totalOpen: rows.reduce((s2, x) => s2 + (x.open || 0), 0),
    topAccounts: [...rows].sort((a, b) => (b.high - a.high) || (b.open - a.open)).slice(0, 5),
    perAccount: rows,
  };
  try { await _aggDdb.send(new _AggPut({ TableName: _AGG_TABLE, Item: { ...cacheKey, at: Date.now(), data, ttl: Math.floor(Date.now() / 1000) + 86400 } })); } catch { /* 忽略 */ } // ttl: 表已启用 TTL，聚合行 24h 自清
  await fillAccountNames(data.perAccount || []);
  return _filterRollup(data, visibleSet);
}

function _filterRollup(data, visibleSet) {
  if (!data) return data;
  if (!visibleSet || visibleSet === "*") return data;
  const vis = (x) => x.isDeployment || !x.accountId || visibleSet.has(String(x.accountId));
  const perAccount = (data.perAccount || []).filter(vis);
  return {
    ...data,
    perAccount,
    topAccounts: (data.topAccounts || []).filter(vis),
    totalOpen: perAccount.reduce((s2, x) => s2 + (x.open || 0), 0),
  };
}
