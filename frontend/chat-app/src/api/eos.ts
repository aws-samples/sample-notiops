/**
 * 生命周期/EOS 仪表盘客户端（只读，见 bff/web-chat/eos.mjs）。
 * GET /lifecycle/eos → 多 region 扫描资源版本 → 7/30/90 天到期 + 受支持比例 + 按服务。
 */
import { signedClient } from "./chat";

export interface EosResource {
  service: string;
  region: string;
  id: string;
  name: string;
  engine?: string;
  version?: string;
  eolDate: string | null;
  daysLeft?: number;
  source?: string;
}

export interface EosDashboardData {
  available?: boolean;
  ok?: boolean;
  code?: string;
  asOf?: string;
  regionsScanned?: number;
  total?: number;
  counts?: { past: number; in7: number; in30: number; in90: number };
  atRisk?: number;
  supported?: number;
  supportedPct?: number | null;
  byService?: Record<string, { total: number; atRisk: number }>;
  upcoming?: EosResource[];
  eolTableAsOf?: string | null;
  healthNotices?: { service: string; eventTypeCode: string; region: string; statusCode: string; startTime: number | null }[];
  healthNoticeCount?: number;
  cached?: boolean;       // true = 命中 60min 服务端缓存（秒返）
  cachedAt?: string;      // 缓存生成时间（ISO）
}

// refresh=true → 绕过服务端缓存强制重扫（前端「重试」按钮用）。
export async function getEosDashboard(accountId?: string, refresh = false): Promise<EosDashboardData> {
  const s = await signedClient();
  if (!s) return { ok: false, code: "not_authenticated" };
  try {
    const params = new URLSearchParams();
    if (accountId) params.set("account", accountId);
    if (refresh) params.set("refresh", "1");
    const q = params.toString() ? `?${params.toString()}` : "";
    const r = await s.aws.fetch(`${s.base}/lifecycle/eos${q}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { ok: false, code: "http_" + r.status };
    return await r.json();
  } catch (e) {
    return { ok: false, code: "error", message: String(e) } as EosDashboardData;
  }
}

export interface EosOrgRow { accountId: string; name: string; available: boolean; past: number; in90: number; total: number }
export async function getEosOrgSummary(): Promise<{ rows: EosOrgRow[] } | null> {
  const s = await signedClient();
  if (!s) return null;
  try {
    const r = await s.aws.fetch(`${s.base}/lifecycle/eos/org-summary`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
