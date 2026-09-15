/**
 * Security 仪表盘客户端（只读，见 bff/web-chat/security.mjs）。
 * GET /security/dashboard → TA 安全检查 / Security Hub 发现 / 30 天安全公告。
 */
import { signedClient } from "./chat";

export interface TaCheck { id?: string; name: string; status: string; flaggedCount: number }
export interface HubFinding { title: string; severity: string; resource: string; product: string }
export interface Bulletin { title: string; link: string; date: string }

export interface TaCheckResources {
  checkId: string; name: string;
  metadataHeaders: string[];
  resources: { status: string; region: string; metadata: string[] }[];
  total: number;
}

export async function getTaCheckResources(checkId: string, accountId?: string): Promise<TaCheckResources | null> {
  const s = await signedClient();
  if (!s) return null;
  const q = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
  const r = await s.aws.fetch(`${s.base}/security/ta-check/${encodeURIComponent(checkId)}/resources${q}`, { headers: { "x-notiops-id-token": s.idToken } });
  if (!r.ok) return null;
  return await r.json();
}

export interface SecurityDashboardData {
  ok: boolean;
  code?: string;
  message?: string;
  trustedAdvisor?: {
    available: boolean; reason?: string;
    checks?: TaCheck[];
    summary?: { ok: number; warning: number; error: number };
  };
  securityHub?: {
    available: boolean; reason?: string;
    severity?: Record<string, number>;
    total?: number;
    top?: HubFinding[];
  };
  bulletins?: { available: boolean; reason?: string; items?: Bulletin[] };
}

export async function getSecurityDashboard(accountId?: string): Promise<SecurityDashboardData> {
  const s = await signedClient();
  if (!s) return { ok: false, code: "not_authenticated" };
  try {
    const q = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    const r = await s.aws.fetch(`${s.base}/security/dashboard${q}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { ok: false, code: "http_" + r.status };
    return await r.json();
  } catch {
    // 不带 String(e)：那串会带上请求 URL 和运行时报文，而 code 是要画到界面上的。
    return { ok: false, code: "fetch_failed" };
  }
}

// ④ GuardDuty 仪表盘
export interface GuarddutyData {
  ok: boolean; available?: boolean; reason?: string;
  severity?: Record<string, number>; total?: number;
  top?: { title: string; severity: number; type: string; resource: string; region: string }[];
}
/**
 * 失败**不再**回 null：调用方拿 `null` 当「加载中」哨兵，两者混用时一次 HTTP 500
 * 会被画成「GuardDuty 未开通」—— 那是一条关于客户环境的假事实。
 * `ok:false` = 我们没问到（可重试）；`available:false` = 问到了，答案是没开。
 */
export async function getGuarddutyDashboard(accountId?: string): Promise<GuarddutyData> {
  const s = await signedClient();
  if (!s) return { ok: false, reason: "not_authenticated" };
  try {
    const q = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    const r = await s.aws.fetch(`${s.base}/security/guardduty${q}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { ok: false, reason: "http_" + r.status };
    return await r.json();
  } catch { return { ok: false, reason: "fetch_failed" }; }
}

// Security 组织概览
export interface SecurityOrgRow { accountId: string; name: string; isDeployment?: boolean; available: boolean; gdHigh: number | null; taIssues: number | null }
export async function getSecurityOrgSummary(): Promise<{ rows: SecurityOrgRow[] } | null> {
  const s = await signedClient();
  if (!s) return null;
  try {
    const r = await s.aws.fetch(`${s.base}/security/org-summary`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
