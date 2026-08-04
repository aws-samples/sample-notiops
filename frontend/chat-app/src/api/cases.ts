/**
 * Cases 仪表盘客户端（Cases 主题空态区块，只读，见 bff/web-chat/support.mjs casesDashboard）。
 * GET /cases/dashboard?account= → 概览 / 等你回复 / incident / SLA(启发式)。
 */
import { signedClient } from "./chat";

export interface CaseRow {
  displayId: string;
  subject: string;
  severity: string;
  status?: string;
  ageDays?: number | null;
  waitingDays?: number | null;
  hoursSinceActivity?: number;
  targetHours?: number;
  state?: "on-track" | "at-risk" | "breached";
}

export interface CasesDashboardData {
  ok: boolean;
  code?: string;
  message?: string;
  openCount?: number;
  totalCount?: number;
  bySeverity?: Record<string, number>;
  byService?: { service: string; count: number }[];
  waiting?: { count: number; cases: CaseRow[] };
  incidents?: { count: number; cases: CaseRow[] };
  sla?: { onTrack: number; atRisk: number; breached: number; worst: CaseRow[] };
}

export const CASES_EMPTY: CasesDashboardData = { ok: false };

export async function getCasesDashboard(accountId?: string): Promise<CasesDashboardData> {
  const s = await signedClient();
  if (!s) return CASES_EMPTY;
  try {
    const q = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    const r = await s.aws.fetch(`${s.base}/cases/dashboard${q}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { ok: false, code: "http_" + r.status };
    return await r.json();
  } catch (e) {
    return { ok: false, code: "error", message: String(e) };
  }
}

export interface CasesTrendsData {
  ok: boolean;
  code?: string;
  message?: string;
  total?: number;
  resolved?: number;
  open?: number;
  pendingCustomer?: number;
  pendingCustomerPct?: number;
  bySeverity?: { severity: string; count: number }[];
  byService?: { service: string; count: number }[];
  byMonth?: { month: string; count: number }[];
  periodMonths?: number;
  insight?: string;
  recommendations?: string[];
  aiError?: string;
}

export async function getCasesTrends(accountId?: string): Promise<CasesTrendsData> {
  const s = await signedClient();
  if (!s) return { ok: false, code: "not_authenticated" };
  try {
    const q = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    const r = await s.aws.fetch(`${s.base}/cases/trends${q}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { ok: false, code: "http_" + r.status };
    return await r.json();
  } catch (e) {
    return { ok: false, code: "error", message: String(e) };
  }
}

export interface CasesOrgSummary {
  generatedAt: string; accountsCovered: number; accountsFailed: string[];
  totalOpen: number;
  topAccounts: { accountId: string; name: string; open: number; high: number; available: boolean }[];
  perAccount: { accountId: string; name: string; open: number; high: number; available: boolean }[];
}
export async function getCasesOrgSummary(): Promise<CasesOrgSummary | null> {
  const s = await signedClient();
  if (!s) return null;
  try {
    const r = await s.aws.fetch(`${s.base}/cases/org-summary`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
