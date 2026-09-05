/**
 * FinOps 仪表盘客户端（FinOps 主题空态区块，独立于聊天/LLM，见 bff/web-chat/finops.mjs）。
 *
 * GET /finops/dashboard 一次拿齐三块数据：
 *   - budgetAlerts:   AWS Budgets 预算 vs 实际支出 + 预测超支（实时查）
 *   - curStatus:      CUR/Athena 集成状态（not_configured | PENDING | READY | DELAYED | FAILED）
 *   - devOpsAgentCost: DevOps Agent 调用成本明细（仅 curStatus.status="READY" 时有数据）
 */
import { signedClient } from "./chat";

export type BudgetStatus = "on_track" | "forecast_exceed" | "exceeded";

export interface BudgetAlert {
  name: string;
  unit: string;
  limit: number;
  actualSpend: number;
  forecastedSpend: number;
  pctActual: number;
  pctForecast: number;
  status: BudgetStatus;
  timeUnit: string;
}

export interface BudgetAlertsResponse {
  available: boolean;
  reason?: string;
  message?: string;
  budgets: BudgetAlert[];
}

export type CurAthenaStatusValue = "not_configured" | "PENDING" | "READY" | "DELAYED" | "FAILED" | "unknown" | "error";

export interface CurAthenaStatus {
  status: CurAthenaStatusValue;
  bucket?: string;
  reportName?: string;
  athenaDatabase?: string;
  createdAt?: string;
  updatedAt?: string;
  error?: string;
  note?: string;
  message?: string;
}

export interface DevOpsAgentCostByAccount {
  accountId: string;
  totalHours: number;
  impliedCostUsd: number;
}

export interface DevOpsAgentCostSummary {
  available: boolean;
  reason?: string;
  message?: string;
  month?: string;
  priorMonth?: string;
  byAccount?: DevOpsAgentCostByAccount[];
  totalHours?: number;
  totalCostUsd?: number; // 向后兼容 = usedUsd
  // credit：额度（档位% × 上月 Support 费用）/ 已用 / 剩余（月底过期）
  allowanceUsd?: number;
  usedUsd?: number;
  remainingUsd?: number;
  usedPct?: number | null;
  note?: string;
}

export interface SpendTrend {
  available: boolean;
  reason?: string;
  message?: string;
  categories?: string[];
  usage?: number[];
  marketplace?: number[];
  totalThisMonthK?: number;
  totalPriorMonthK?: number;
  deltaPct?: number;
  dailyRateUsd?: number;
  dailyAvgPriorUsd?: number;
  dailyAvgMomPct?: number;
  daysElapsed?: number;
  daysInThisMonth?: number;
  daysInPriorMonth?: number;
}

export interface MarketplaceSpend {
  available: boolean;
  reason?: string;
  message?: string;
  thisMonthK?: number;
  priorMonthK?: number;
  deltaPct?: number;
  dailyUsd?: number;
}

export interface SupportFees {
  available: boolean;
  reason?: string;
  message?: string;
  feeK?: number;
  feeUsd?: number;
  plan?: string;
  tier?: "enterprise" | "business" | "none";
}

export interface SpendForecast {
  available: boolean;
  reason?: string;
  message?: string;
  forecastRemainingUsd?: number;
}

export interface MoverRow {
  name: string;
  thisMonthK: number;
  priorMonthK: number;
  deltaUsd: number;
  thisMonthUsd?: number;
  priorMonthUsd?: number;
  deltaPct?: number;
}

export interface TopMovers {
  available: boolean;
  reason?: string;
  message?: string;
  metric?: string;
  baselineLabel?: string;
  comparisonLabel?: string;
  netDeltaUsd?: number;
  increases?: MoverRow[];
  decreases?: MoverRow[];
  topDriver?: MoverRow;
  topDrop?: MoverRow;
}

export interface TopServiceRow { service: string; amountUsd: number; }
export interface TopServices { available: boolean; reason?: string; message?: string; top?: TopServiceRow[]; totalUsd?: number; }

export interface AnomalyRow { id?: string; startDate?: string; service?: string; impactUsd?: number; }
export interface CostAnomalies { available: boolean; reason?: string; message?: string; count?: number; totalImpactUsd?: number; anomalies?: AnomalyRow[]; }

export interface RiSpCoverage { available: boolean; reason?: string; message?: string; spCoveragePct?: number | null; riCoveragePct?: number | null; }

export interface AiSpendComponent { service: string; amountUsd: number; }
export interface AiSpend { available: boolean; reason?: string; message?: string; thisMonthUsd?: number; priorMonthUsd?: number; forecastEomUsd?: number; deltaPct?: number; components?: AiSpendComponent[]; }

export interface SavingsActionRow { action: string; savingsUsd: number; count: number; }
export interface PotentialSavings { available: boolean; reason?: string; message?: string; totalMonthlyUsd?: number; byAction?: SavingsActionRow[]; currency?: string; }

export interface CostExplorerDashboard {
  spendTrend: SpendTrend;
  marketplace: MarketplaceSpend;
  support: SupportFees;
  movers: TopMovers;
  forecast?: SpendForecast;
  topServices?: TopServices;
  anomalies?: CostAnomalies;
  coverage?: RiSpCoverage;
  aiSpend?: AiSpend;
}

export interface EdpCommitment {
  annualCommitmentUsd: number;
  discountRate: number;
  marketplaceCapRatio: number;
  contractPeriod: string;
  attainmentPct: number;
  expectedPct: number;
  remainingUsd: number;
  remainingMarketplaceUsd: number;
}

/**
 * 每日多因子成本异常扫描（lambda5 产数，01:15 UTC）。
 *
 * ⚠️ 与 `costExplorer.anomalies`（AWS Cost Anomaly Detection）是**两套
 * 引擎**：那套要配 monitor，这套自建基线每天全账号跑。两张卡并排展示，
 * 合并会让两套口径的数字对不上任何一边的控制台。
 *
 * 🔴 `available:false` = 没跑/读失败（**不是**「无异常」）；
 *    `available:true, totalAnomalies:0` 才是「跑了且干净」。
 */
export interface DailyAnomalyRow {
  accountId: string; service: string; score: number; confidence: string;
  type: string; baselineDailyUsd: number | null;
  recent3dDailyUsd: number | null; projected7dExtraUsd: number; trend: string;
}
export interface DailyAnomaly {
  available: boolean; reason?: string; date?: string;
  totalAnomalies?: number; projected7dExtraUsd?: number; accounts?: number;
  details?: DailyAnomalyRow[];
}

export interface FinopsDashboard {
  budgetAlerts: BudgetAlertsResponse;
  curStatus: CurAthenaStatus;
  devOpsAgentCost: DevOpsAgentCostSummary;
  costExplorer: CostExplorerDashboard;
  edpCommitment: EdpCommitment;
  potentialSavings?: PotentialSavings;
  /** 可选：存量 BFF 不返回 → 整卡不渲染（不显示一排 0）。 */
  dailyAnomaly?: DailyAnomaly;
}

const EMPTY: FinopsDashboard = {
  budgetAlerts: { available: false, budgets: [] },
  curStatus: { status: "not_configured" },
  devOpsAgentCost: { available: false, reason: "cur_not_ready" },
  costExplorer: {
    spendTrend: { available: false },
    marketplace: { available: false },
    support: { available: false },
    movers: { available: false },
    forecast: { available: false },
    topServices: { available: false },
    anomalies: { available: false },
    coverage: { available: false },
  },
  potentialSavings: { available: false },
  dailyAnomaly: { available: false },
  edpCommitment: {
    annualCommitmentUsd: 0, discountRate: 0, marketplaceCapRatio: 0, contractPeriod: "",
    attainmentPct: 0, expectedPct: 0, remainingUsd: 0, remainingMarketplaceUsd: 0,
  },
};

export async function getFinopsDashboard(accountId?: string): Promise<FinopsDashboard> {
  const s = await signedClient();
  if (!s) return EMPTY;
  try {
    const r = await s.aws.fetch(`${s.base}/finops/dashboard${accountId ? `?account=${encodeURIComponent(accountId)}` : ""}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return EMPTY;
    return await r.json();
  } catch {
    return EMPTY;
  }
}

export interface DeepDiveChart { type: "bar" | "pie"; labelKey: string; valueKey: string; title?: string; }
export interface DeepDiveResult {
  available: boolean;
  reason?: string;
  message?: string;
  scenario?: string;
  title?: string;
  rowCount?: number;
  rows?: Record<string, string | null>[];
  period?: string;
  periodLabel?: { zh: string; en: string };
  insight?: string;
  recommendations?: string[];
  chart?: DeepDiveChart;
  csvUrl?: string;
  cached?: boolean;
  cachedAt?: string;
}

/** Cost Deep Dive：跑 Athena 保存查询(grounded CUR) → Bedrock insight/chart + CSV 下载 URL。 */
export async function getFinopsDeepDive(scenario: string): Promise<DeepDiveResult> {
  const s = await signedClient();
  if (!s) return { available: false, reason: "no_auth" };
  try {
    const r = await s.aws.fetch(`${s.base}/finops/deep-dive?scenario=${encodeURIComponent(scenario)}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { available: false, reason: "http_" + r.status };
    return await r.json();
  } catch (e) {
    return { available: false, reason: "error", message: String(e) };
  }
}

/* ───────────────── 成本分配标签浏览器（Cost Allocation Tag Explorer）───────────────── */
export interface TagKeysResult {
  available: boolean;
  reason?: string;
  message?: string;
  tagKeys: string[];
  accountScope?: string;
  costDataSourceAccountId?: string;
}
export interface TagValuesResult {
  available: boolean;
  reason?: string;
  message?: string;
  tagKey: string;
  tagValues: string[];
}
export interface TagCostRow { service: string; amountUsd: number; }
export interface TagCostResult {
  available: boolean;
  reason?: string;
  message?: string;
  tagKey?: string;
  tagValue?: string | null; // null=全部值合计；""=untagged
  metric?: string;
  period?: string;
  periodLabel?: { zh: string; en: string };
  rows?: TagCostRow[];
  totalUsd?: number;
  insight?: string;
  recommendations?: string[];
  cached?: boolean;
  cachedAt?: string;
  costDataSourceAccountId?: string;
  accountScope?: string;
}

/** 列出已激活的成本分配标签键。 */
export async function getFinopsTagKeys(accountId?: string): Promise<TagKeysResult> {
  const s = await signedClient();
  if (!s) return { available: false, reason: "no_auth", tagKeys: [] };
  try {
    const r = await s.aws.fetch(`${s.base}/finops/tag-keys${accountId ? `?account=${encodeURIComponent(accountId)}` : ""}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { available: false, reason: "http_" + r.status, tagKeys: [] };
    return await r.json();
  } catch (e) {
    return { available: false, reason: "error", message: String(e), tagKeys: [] };
  }
}

/** 列出某标签键的可选值（二级下拉）。 */
export async function getFinopsTagValues(tagKey: string, accountId?: string): Promise<TagValuesResult> {
  const s = await signedClient();
  if (!s) return { available: false, reason: "no_auth", tagKey, tagValues: [] };
  try {
    const qs = new URLSearchParams();
    if (accountId) qs.set("account", accountId);
    qs.set("key", tagKey);
    const r = await s.aws.fetch(`${s.base}/finops/tag-values?${qs.toString()}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { available: false, reason: "http_" + r.status, tagKey, tagValues: [] };
    return await r.json();
  } catch (e) {
    return { available: false, reason: "error", message: String(e), tagKey, tagValues: [] };
  }
}

/** 按标签查成本(按服务分组)。tagValue 省略=全部值合计；传 ""=untagged。 */
export async function getFinopsTagCost(tagKey: string, tagValue?: string | null, accountId?: string): Promise<TagCostResult> {
  const s = await signedClient();
  if (!s) return { available: false, reason: "no_auth" };
  try {
    const qs = new URLSearchParams();
    if (accountId) qs.set("account", accountId);
    qs.set("key", tagKey);
    if (tagValue != null) qs.set("value", tagValue); // 传了(含空串)才带 value；不传=合计
    const r = await s.aws.fetch(`${s.base}/finops/tag-cost?${qs.toString()}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { available: false, reason: "http_" + r.status };
    return await r.json();
  } catch (e) {
    return { available: false, reason: "error", message: String(e) };
  }
}
