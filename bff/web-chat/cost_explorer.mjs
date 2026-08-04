/**
 * Cost Explorer 固定查询模板 —— FinOps 仪表盘的"Spend Overview / Cost Breakdown /
 * MoM Movers"三个 section 的数据源。
 *
 * 设计原则："固定参数模板，不是让模型现场拼查询"——每个导出函数对应仪表盘的一张
 * 卡片，内部固定好 Filter/GroupBy/Metric，只有时间窗口是参数。这样保证同一张卡片
 * 每次刷新的口径完全一致（不会因为 prompt 不同产生不同的过滤条件），也方便未来
 * 排查"这个数字是怎么算出来的"——直接看函数体就是唯一口径。
 *
 * 全部使用 UnblendedCost（实际发生费率），与 CMC 控制台默认口径一致（见
 * tam-steering.md §Cost Metric Selection 的默认建议）。
 */
import { CostExplorerClient, GetCostAndUsageCommand, GetCostAndUsageComparisonsCommand, GetCostForecastCommand, GetAnomaliesCommand, GetSavingsPlansCoverageCommand, GetReservationCoverageCommand, GetTagsCommand } from "@aws-sdk/client-cost-explorer";
import { findPayerAccount, getAssumedCredentialsForAccount } from "./devops_agent_accounts.mjs";

// Cost Explorer 是全局服务，SDK 端点固定 us-east-1。
// 跨账号查询：<member-account> 是 Organization 成员账号，真实历史成本大多记在 payer
// 账号上。不再硬编码 payer 账号 ID/角色 ARN——改为动态发现：查 DevOps Agent 的
// Agent Space 关联账号列表（devops_agent_accounts.mjs），找到其中被判定为
// Organization payer 的那个，用它的 assumableRoleArn 取临时凭证。找不到 payer
// 关联账号时，退回部署账号自身视角（原有行为，向后兼容）。
// 凭证有效期 1h，模块级缓存 + 到期前 5 分钟自动刷新，避免每次请求都触发 AssumeRole。
let _cachedCe = null;
let _cachedCeExpiry = 0;
let _cachedPayerAccountId = "";

async function _getCeClient() {
  const now = Date.now();
  if (_cachedCe && now < _cachedCeExpiry) return _cachedCe;

  const payer = await findPayerAccount();
  if (!payer) {
    _cachedCe = new CostExplorerClient({ region: "us-east-1" });
    _cachedCeExpiry = now + 60_000; // payer 未发现时短缓存 1 分钟，避免每次都重新拉关联列表
    _cachedPayerAccountId = "";
    return _cachedCe;
  }

  const creds = await getAssumedCredentialsForAccount(payer.accountId, payer.roleArn);
  if (!creds) {
    _cachedCe = new CostExplorerClient({ region: "us-east-1" });
    _cachedCeExpiry = now + 60_000;
    _cachedPayerAccountId = "";
    return _cachedCe;
  }

  _cachedPayerAccountId = payer.accountId;
  _cachedCe = new CostExplorerClient({ region: "us-east-1", credentials: creds });
  _cachedCeExpiry = now + (3600 - 300) * 1000; // 提前 5 分钟刷新
  return _cachedCe;
}

/** 供其它模块（如 finops.mjs 展示"数据来自哪个账号"）读取当前生效的 payer 账号 ID。
 * 未发现 payer 时返回空字符串（表示当前是部署账号自身视角）。需先调用过一次
 * _getCeClient() 才有值——各导出查询函数内部都会触发。 */
// ── 请求级账号范围（多账号）：payer 视角天然含全组织；选中成员账号时按
// LINKED_ACCOUNT 过滤出该账号的成本。GetAnomalies/RI-SP coverage/budgets 等
// 不支持该过滤的板块保持组织级，由 finops.mjs 标注 orgOnlySections。
let _acctScope = "";
export function setAccountScope(accountId) { _acctScope = String(accountId || "").trim(); }
function scoped(input) {
  if (!_acctScope) return input;
  const dim = { Dimensions: { Key: "LINKED_ACCOUNT", Values: [_acctScope] } };
  return { ...input, Filter: input.Filter ? { And: [input.Filter, dim] } : dim };
}
// 带账号范围的命令构造器（所有成本/预测查询统一走这里）
const CAU = (input) => new GetCostAndUsageCommand(scoped(input));
const FC = (input) => new GetCostForecastCommand(scoped(input));

export function currentPayerAccountId() {
  return _cachedPayerAccountId;
}

function ymFirst(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`; }
function monthsAgo(n) { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - n); return d; }
function monthLabel(d) { return d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }); }

/**
 * 1. Total AWS Spend —— 近 6 个月月度总花费（Usage + Marketplace，排除 Support/
 *    Discount/Tax，与模板 hero 卡的口径一致："*excludes support, discount, tax"）。
 *    返回：{ categories, usage[], marketplace[], totalThisMonth, totalPriorMonth, dailyRate }
 */
export async function getSpendTrend() {
  const start = ymFirst(monthsAgo(12));
  const end = ymFirst(monthsAgo(-1)); // 下月 1 号（CE end 是 exclusive，覆盖到本月）
  const filter = {
    Not: {
      Dimensions: { Key: "RECORD_TYPE", Values: ["Credit", "Refund", "Tax", "Support"] },
    },
  };
  const r = await (await _getCeClient()).send(CAU({
    TimePeriod: { Start: start, End: end },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    Filter: filter,
    GroupBy: [{ Type: "DIMENSION", Key: "BILLING_ENTITY" }],
  }));

  const byMonth = new Map(); // "YYYY-MM" -> { usage, marketplace }
  for (const period of r.ResultsByTime || []) {
    const key = (period.TimePeriod?.Start || "").slice(0, 7);
    const entry = byMonth.get(key) || { usage: 0, marketplace: 0 };
    for (const g of period.Groups || []) {
      const entity = g.Keys?.[0] || "";
      const amount = Number(g.Metrics?.UnblendedCost?.Amount || 0);
      if (entity === "AWS Marketplace") entry.marketplace += amount;
      else entry.usage += amount;
    }
    byMonth.set(key, entry);
  }

  const MONTHS = 12;
  const categories = [];
  const usage = [];
  const marketplace = [];
  for (let i = MONTHS - 1; i >= 0; i--) {
    const d = monthsAgo(i);
    const key = ymFirst(d).slice(0, 7);
    const entry = byMonth.get(key) || { usage: 0, marketplace: 0 };
    categories.push(monthLabel(d));
    usage.push(Math.round(entry.usage / 100) / 10); // → $K，一位小数
    marketplace.push(Math.round(entry.marketplace / 100) / 10);
  }

  const last = categories.length - 1;
  const thisMonthTotal = (usage[last] || 0) + (marketplace[last] || 0);           // K，本月至今 MTD
  const priorMonthTotal = (usage[last - 1] || 0) + (marketplace[last - 1] || 0);  // K，上月完整
  const now = new Date();
  const daysElapsed = now.getUTCDate();
  const daysInThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const priorD = monthsAgo(1);
  const daysInPriorMonth = new Date(Date.UTC(priorD.getUTCFullYear(), priorD.getUTCMonth() + 1, 0)).getUTCDate();
  const dailyRate = daysElapsed > 0 ? (thisMonthTotal * 1000) / daysElapsed : 0;                    // 本月日均 run-rate
  const dailyAvgPriorUsd = daysInPriorMonth > 0 ? (priorMonthTotal * 1000) / daysInPriorMonth : 0;  // 上月日均
  const dailyAvgMomPct = dailyAvgPriorUsd > 0 ? Math.round(((dailyRate - dailyAvgPriorUsd) / dailyAvgPriorUsd) * 1000) / 10 : 0;

  return {
    categories, usage, marketplace,
    totalThisMonthK: thisMonthTotal,
    totalPriorMonthK: priorMonthTotal,
    // legacy：MTD vs 上月完整（部分月会失真）。前端已改用「预测月末环比」+「日均环比」两种不失真口径。
    deltaPct: priorMonthTotal > 0 ? Math.round(((thisMonthTotal - priorMonthTotal) / priorMonthTotal) * 1000) / 10 : 0,
    dailyRateUsd: Math.round(dailyRate),
    dailyAvgPriorUsd: Math.round(dailyAvgPriorUsd),
    dailyAvgMomPct,
    daysElapsed, daysInThisMonth, daysInPriorMonth,
  };
}

/**
 * 2. Marketplace Spend —— 本月 vs 上月（独立卡片，模板里单独一块）。
 */
export async function getMarketplaceSpend() {
  const start = ymFirst(monthsAgo(1));
  const end = ymFirst(monthsAgo(-1));
  const r = await (await _getCeClient()).send(CAU({
    TimePeriod: { Start: start, End: end },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    Filter: { Dimensions: { Key: "BILLING_ENTITY", Values: ["AWS Marketplace"] } },
  }));
  const amounts = (r.ResultsByTime || []).map((p) => Number(p.Total?.UnblendedCost?.Amount || 0));
  const priorK = Math.round((amounts[0] || 0) / 100) / 10;
  const thisK = Math.round((amounts[1] || 0) / 100) / 10;
  const now = new Date();
  const dailyUsd = now.getUTCDate() > 0 ? Math.round((thisK * 1000) / now.getUTCDate()) : 0;
  return {
    thisMonthK: thisK,
    priorMonthK: priorK,
    deltaPct: priorK > 0 ? Math.round(((thisK - priorK) / priorK) * 1000) / 10 : 0,
    dailyUsd,
  };
}

/**
 * 3. Support Fees —— 本月 Enterprise/Business Support 费用 + 占比说明。
 *    RECORD_TYPE 里没有直接的百分比字段，这里只展示金额（与模板 metric-list 一致，
 *    百分比留给客户合同信息，不在 CE 里，暂显示 "—"，前端按 note 展示固定文案）。
 */
export async function getSupportFees() {
  const start = ymFirst(monthsAgo(1));
  const end = ymFirst(monthsAgo(0));
  // 不写死 service 名：各账号 Support 在 CE 里命名不一（"AWS Support (Enterprise)"、
  // "AWS Support (Business)"、"AWS Business Support+"、"AWS Enterprise Support+" 等）。
  // 取全部 service，JS 侧筛出名字含 "support" 的行求和，并据名字判档位。
  const r = await (await _getCeClient()).send(CAU({
    TimePeriod: { Start: start, End: end },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  }));
  let feeUsd = 0;
  let plan = "";
  for (const g of r.ResultsByTime?.[0]?.Groups || []) {
    const name = g.Keys?.[0] || "";
    if (!/support/i.test(name)) continue;
    const amount = Number(g.Metrics?.UnblendedCost?.Amount || 0);
    feeUsd += amount;
    if (amount > 0 && !plan) plan = name;
  }
  // tier: 名字含 Enterprise → enterprise(75%)；含 Business → business(30%)；否则 none。
  const tier = /enterprise/i.test(plan) ? "enterprise" : /business/i.test(plan) ? "business" : "none";
  return { feeK: Math.round(feeUsd / 100) / 10, feeUsd: Math.round(feeUsd * 100) / 100, plan: plan || "—", tier };
}

/**
 * 4. MoM Movers —— 本月 vs 上月，按 SERVICE 维度找涨幅最大 / 降幅最大的服务。
 *    走 getCostAndUsageComparisons（专为月度对比设计的 API，官方推荐用于这个场景，
 *    见 tam-steering.md 对该 API 的说明：仅支持整月对比，起止必须是月初）。
 */
export async function getTopMovers() {
  // MoM 对比必须用两个「完整」月：GetCostAndUsageComparisons 不接受未结束的当前月
  // （会报错/返回空）。所以取「上上月 vs 上月」，而不是「上月 vs 本月(不完整)」。
  const baselineStart = ymFirst(monthsAgo(2));
  const baselineEnd = ymFirst(monthsAgo(1));
  const comparisonStart = ymFirst(monthsAgo(1));
  const comparisonEnd = ymFirst(monthsAgo(0));

  const r = await (await _getCeClient()).send(new GetCostAndUsageComparisonsCommand({
    BaselineTimePeriod: { Start: baselineStart, End: baselineEnd },
    ComparisonTimePeriod: { Start: comparisonStart, End: comparisonEnd },
    MetricForComparison: "AmortizedCost", // SOP：摊销成本为主口径（按会计标准做了时序校正，避免预付/RI/SP 时点失真）
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
    MaxResults: 50,
  }));

  const rows = (r.CostAndUsageComparisons || []).map((c) => {
    const service = c.CostAndUsageSelector?.Dimensions?.Values?.[0] || c.CostAndUsageSelector?.Keys?.[0] || "Unknown";
    const baseline = Number(c.Metrics?.AmortizedCost?.BaselineTimePeriodAmount || 0);
    const comparison = Number(c.Metrics?.AmortizedCost?.ComparisonTimePeriodAmount || 0);
    return { service, baseline, comparison, delta: comparison - baseline };
  }).filter((r) => r.baseline > 1 || r.comparison > 1); // 过滤噪声级服务

  const netDeltaUsd = Math.round(rows.reduce((s, x) => s + x.delta, 0));
  const fmtRow = (row) => row && {
    name: row.service,
    thisMonthUsd: Math.round(row.comparison * 100) / 100,
    priorMonthUsd: Math.round(row.baseline * 100) / 100,
    thisMonthK: Math.round(row.comparison / 100) / 10,
    priorMonthK: Math.round(row.baseline / 100) / 10,
    deltaUsd: Math.round(row.delta),
    deltaPct: row.baseline > 0 ? Math.round((row.delta / row.baseline) * 1000) / 10 : (row.comparison > 0 ? 100 : 0),
  };

  const increases = rows.filter((r) => r.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5).map(fmtRow);
  const decreases = rows.filter((r) => r.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5).map(fmtRow);

  return {
    metric: "AmortizedCost",
    baselineLabel: monthLabel(monthsAgo(2)),   // 上上月
    comparisonLabel: monthLabel(monthsAgo(1)), // 上月
    netDeltaUsd,
    increases,
    decreases,
    topDriver: increases[0] || null, // 缩略卡兼容
    topDrop: decreases[0] || null,
  };
}

/**
 * 汇总入口：一次调用拿齐 Spend Overview / Cost Breakdown / Movers 三块数据。
 * 任一子查询失败不影响其它——分别 catch，返回 available:false 让前端优雅降级。
 */
/**
 * 月末预测：GetCostForecast 预测「今天 → 下月 1 号」的 UnblendedCost（只能预测未来）。
 * 前端把它 + 本月至今实际(MTD) 合成"预测月末总额"。数据不足/已是月末最后一天 → 预测 0。
 */
export async function getSpendForecast() {
  const now = new Date();
  const start = now.toISOString().slice(0, 10);   // 今天（GetCostForecast 要求 Start ≥ 今天）
  const end = ymFirst(monthsAgo(-1));              // 下月 1 号（exclusive，覆盖到本月末）
  if (start >= end) return { forecastRemainingUsd: 0 }; // 已是月末最后一天，无剩余可预测
  const r = await (await _getCeClient()).send(FC({
    TimePeriod: { Start: start, End: end },
    Metric: "UNBLENDED_COST",
    Granularity: "MONTHLY",
  }));
  return { forecastRemainingUsd: Math.round(Number(r.Total?.Amount || 0) * 100) / 100 };
}

/**
 * 本月 Top 5 服务（按 UnblendedCost）。返回 top[] + 全部服务总额（算占比用）。
 */
export async function getTopServices() {
  const start = ymFirst(monthsAgo(0));
  const end = ymFirst(monthsAgo(-1));
  const r = await (await _getCeClient()).send(CAU({
    TimePeriod: { Start: start, End: end },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  }));
  const rows = (r.ResultsByTime?.[0]?.Groups || [])
    .map((g) => ({ service: g.Keys?.[0] || "Unknown", amountUsd: Number(g.Metrics?.UnblendedCost?.Amount || 0) }))
    .filter((x) => x.amountUsd > 0)
    .sort((a, b) => b.amountUsd - a.amountUsd);
  const totalUsd = rows.reduce((s, x) => s + x.amountUsd, 0);
  return {
    top: rows.slice(0, 5).map((x) => ({ service: x.service, amountUsd: Math.round(x.amountUsd * 100) / 100 })),
    totalUsd: Math.round(totalUsd * 100) / 100,
  };
}

/**
 * 近 30 天成本异常（CE Anomaly Detection）。需账号已配 anomaly monitor（否则返回空）。
 * 按影响金额倒序，返回总数 + 总影响 + Top5。
 */
export async function getCostAnomalies() {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  const r = await (await _getCeClient()).send(new GetAnomaliesCommand({
    DateInterval: { StartDate: start, EndDate: end },
    MaxResults: 50,
  }));
  const anomalies = (r.Anomalies || [])
    .map((a) => ({
      id: a.AnomalyId,
      startDate: a.AnomalyStartDate || "",
      service: a.RootCauses?.[0]?.Service || a.DimensionValue || "—",
      impactUsd: Math.round(Number(a.Impact?.TotalImpact || 0) * 100) / 100,
    }))
    .filter((x) => x.impactUsd > 0)
    .sort((a, b) => b.impactUsd - a.impactUsd);
  const totalImpactUsd = anomalies.reduce((s, x) => s + x.impactUsd, 0);
  return { count: anomalies.length, totalImpactUsd: Math.round(totalImpactUsd * 100) / 100, anomalies: anomalies.slice(0, 5) };
}

/**
 * 上月 SP + RI 覆盖率（各自 try/catch，无 SP/RI 则为 null，前端显示"无承诺"）。
 */
export async function getRiSpCoverage() {
  const start = ymFirst(monthsAgo(1));
  const end = ymFirst(monthsAgo(0));
  const client = await _getCeClient();
  let spCoveragePct = null, riCoveragePct = null;
  try {
    const sp = await client.send(new GetSavingsPlansCoverageCommand({ TimePeriod: { Start: start, End: end }, Granularity: "MONTHLY" }));
    const c = sp.SavingsPlansCoverages?.[0]?.Coverage;
    if (c?.CoveragePercentage != null) spCoveragePct = Math.round(Number(c.CoveragePercentage) * 10) / 10;
  } catch { /* 无 SP / 无权限 → null */ }
  try {
    const ri = await client.send(new GetReservationCoverageCommand({ TimePeriod: { Start: start, End: end }, Granularity: "MONTHLY" }));
    const c = ri.CoveragesByTime?.[0]?.Total?.CoverageHours;
    if (c?.CoverageHoursPercentage != null) riCoveragePct = Math.round(Number(c.CoverageHoursPercentage) * 10) / 10;
  } catch { /* 无 RI / 无权限 → null */ }
  return { spCoveragePct, riCoveragePct };
}

/**
 * NotiOps / AI 支出监控：本月(至今) + 上月 AgentCore + Bedrock 模型用量成本。
 * NotiOps 部署后主要新增的是 AI 类支出（Bedrock 模型 + AgentCore Runtime）。
 */
export async function getAiSpend() {
  const start = ymFirst(monthsAgo(1));
  const end = ymFirst(monthsAgo(-1)); // 上月 + 本月
  const r = await (await _getCeClient()).send(CAU({
    TimePeriod: { Start: start, End: end },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  }));
  const AI = /bedrock|agentcore/i;
  const sumP = (p) => (p?.Groups || []).filter((g) => AI.test(g.Keys?.[0] || "")).reduce((s, g) => s + Number(g.Metrics?.UnblendedCost?.Amount || 0), 0);
  const compsP = (p) => (p?.Groups || []).filter((g) => AI.test(g.Keys?.[0] || ""))
    .map((g) => ({ service: g.Keys?.[0] || "", amountUsd: Math.round(Number(g.Metrics?.UnblendedCost?.Amount || 0) * 100) / 100 }))
    .filter((x) => x.amountUsd > 0).sort((a, b) => b.amountUsd - a.amountUsd);
  const periods = r.ResultsByTime || [];
  const thisP = periods[periods.length - 1];
  const priorP = periods.length > 1 ? periods[periods.length - 2] : null;
  const thisUsd = sumP(thisP);
  const priorUsd = priorP ? sumP(priorP) : 0;
  const now = new Date();
  const daysElapsed = now.getUTCDate();
  const daysInThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const forecastEomUsd = daysElapsed > 0 ? (thisUsd / daysElapsed) * daysInThisMonth : thisUsd; // 按日均 run-rate 预测月末
  return {
    thisMonthUsd: Math.round(thisUsd * 100) / 100,
    priorMonthUsd: Math.round(priorUsd * 100) / 100,
    forecastEomUsd: Math.round(forecastEomUsd * 100) / 100,
    deltaPct: priorUsd > 0 ? Math.round(((forecastEomUsd - priorUsd) / priorUsd) * 1000) / 10 : (thisUsd > 0 ? 100 : 0), // 预测月末环比(不受部分月失真)
    components: compsP(thisP),
  };
}

export async function getCostExplorerDashboard() {
  const safe = async (fn, fallback) => {
    try { return { available: true, ...(await fn()) }; }
    catch (e) { return { available: false, reason: "error", message: String(e?.message || e), ...fallback }; }
  };
  const [spendTrend, marketplace, support, movers, forecast, topServices, anomalies, coverage, aiSpend] = await Promise.all([
    safe(getSpendTrend, {}),
    safe(getMarketplaceSpend, {}),
    safe(getSupportFees, {}),
    safe(getTopMovers, {}),
    safe(getSpendForecast, {}),
    safe(getTopServices, {}),
    safe(getCostAnomalies, {}),
    safe(getRiSpCoverage, {}),
    safe(getAiSpend, {}),
  ]);
  return { spendTrend, marketplace, support, movers, forecast, topServices, anomalies, coverage, aiSpend };
}

/* ───────────────── 成本分配标签浏览器（Cost Allocation Tag Explorer）─────────────────
 * 客户先选一个「成本分配标签键」（如 Project / Team / Environment），可再选具体标签值，
 * 我们只显示打了该标签的成本，并按服务(SERVICE)分组。口径与其它卡片一致 = UnblendedCost。
 *
 * ⚠️ 前提：标签必须在「账单控制台 → 成本分配标签」里被**激活**，Cost Explorer 才会把它
 * 当作可分组/可过滤的维度暴露；未激活的标签这里查不到（GetTags 只返回已激活的）。
 * 未打该标签的成本会归到「(untagged)」——CE 用空字符串键表示，前端展示为 (untagged)。
 */

/**
 * 列出「近 N 个月内出现过的、已激活的成本分配标签键」。
 * 默认时间窗：上月月初 → 下月月初（覆盖上月 + 本月至今），够用来发现在用的标签。
 * 返回：{ tagKeys: string[] }
 */
export async function listCostAllocationTagKeys() {
  const start = ymFirst(monthsAgo(1));
  const end = ymFirst(monthsAgo(-1));
  const r = await (await _getCeClient()).send(new GetTagsCommand({
    TimePeriod: { Start: start, End: end },
  }));
  // GetTags 不传 TagKey 时返回「所有已激活标签键」；返回值在 r.Tags（键名列表）。
  const tagKeys = (r.Tags || []).filter((k) => typeof k === "string" && k.length > 0).sort((a, b) => a.localeCompare(b));
  return { tagKeys };
}

/**
 * 列出某个标签键在近期出现过的「标签值」（供前端做二级下拉）。
 * 返回：{ tagKey, tagValues: string[] }（含空值时以 "" 表示 untagged，前端自行展示）。
 */
export async function listCostAllocationTagValues(tagKey) {
  const key = String(tagKey || "").trim();
  if (!key) return { tagKey: "", tagValues: [] };
  const start = ymFirst(monthsAgo(1));
  const end = ymFirst(monthsAgo(-1));
  const r = await (await _getCeClient()).send(new GetTagsCommand({
    TimePeriod: { Start: start, End: end },
    TagKey: key,
  }));
  const tagValues = (r.Tags || []).map((v) => String(v ?? "")).sort((a, b) => a.localeCompare(b));
  return { tagKey: key, tagValues };
}

/**
 * 按「成本分配标签」查成本，并按服务(SERVICE)分组。
 *   - tagKey 必填：要筛选/分组的标签键。
 *   - tagValue 选填：只看该标签的这个值（不传 = 看该标签所有值的合计，仍按服务分组）。
 * 时间窗：本月至今（MTD，与 Top5/深挖口径一致）。
 * 口径：UnblendedCost。返回按服务倒序的行 + 总额 + 时间窗标签。
 * 返回：{ tagKey, tagValue, period, periodLabel, rows:[{service, amountUsd}], totalUsd }
 */
export async function getCostByTag(tagKey, tagValue) {
  const key = String(tagKey || "").trim();
  if (!key) return { available: false, reason: "missing_tag_key" };
  const val = tagValue == null ? null : String(tagValue); // "" 表示 untagged（有意义，保留）
  const start = ymFirst(monthsAgo(0));  // 本月 1 号
  const end = ymFirst(monthsAgo(-1));   // 下月 1 号（exclusive → 覆盖本月至今）
  // 标签过滤：选了具体值 → 按该值过滤；只选了键 → 不加值过滤（看全部值，按服务分组即可）。
  const tagFilter = val != null ? { Tags: { Key: key, Values: [val] } } : null;
  const input = {
    TimePeriod: { Start: start, End: end },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
  };
  if (tagFilter) input.Filter = tagFilter;
  const r = await (await _getCeClient()).send(CAU(input));
  const rows = (r.ResultsByTime?.[0]?.Groups || [])
    .map((g) => ({ service: g.Keys?.[0] || "Unknown", amountUsd: Number(g.Metrics?.UnblendedCost?.Amount || 0) }))
    .filter((x) => x.amountUsd > 0)
    .sort((a, b) => b.amountUsd - a.amountUsd)
    .map((x) => ({ service: x.service, amountUsd: Math.round(x.amountUsd * 100) / 100 }));
  const totalUsd = Math.round(rows.reduce((s, x) => s + x.amountUsd, 0) * 100) / 100;
  return {
    available: true,
    tagKey: key,
    tagValue: val,
    metric: "UnblendedCost",
    period: "current calendar month to date (MTD)",
    periodLabel: { zh: "本月至今 (MTD)", en: "Month-to-date (MTD)" },
    rows,
    totalUsd,
  };
}
