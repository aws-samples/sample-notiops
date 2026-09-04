/**
 * 客户 CUR 仪表盘 API 客户端（4 个 sheet：费用趋势/Credit/扩展支持/SP）。
 * 数据链路：BFF /cur-dash/* → cost-agent MCP Lambda → 客户 CUR（当天缓存）。
 */
import { signedClient } from "./chat";

/* ── 费用趋势立方体（列式编码，前端解码后内存交叉筛选） ── */
export interface CubeRaw {
  available: boolean;
  reason?: string;
  from?: string;
  to?: string;
  encoding?: string;
  dims?: { d: string[]; svc: string[]; region: string[]; account: string[] };
  rows?: [number, number, number, number, number][];
  asOf?: string;
  cached?: boolean;
}

export interface CubeRow { d: string; svc: string; region: string; account: string; cost: number }

export async function getCube(days = 30, from = "", to = ""): Promise<{ raw: CubeRaw; rows: CubeRow[] }> {
  const s = await signedClient();
  if (!s) return { raw: { available: false }, rows: [] };
  try {
    const qs = from && to ? `from=${from}&to=${to}` : `days=${days}`;
    const r = await s.aws.fetch(`${s.base}/cur-dash/cube?${qs}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { raw: { available: false, reason: `http-${r.status}` }, rows: [] };
    const raw: CubeRaw = await r.json();
    if (!raw.available || !raw.dims || !raw.rows) return { raw, rows: [] };
    const { d, svc, region, account } = raw.dims;
    const rows = raw.rows.map(([di, si, ri, ai, cost]) => ({
      d: d[di], svc: svc[si], region: region[ri], account: account[ai], cost,
    }));
    return { raw, rows };
  } catch {
    return { raw: { available: false, reason: "error" }, rows: [] };
  }
}

/* ── Credit ── */
export interface CreditData {
  available: boolean;
  reason?: string;
  month?: string;
  summary?: { type: string; amount: string }[];
  details_top30?: { type: string; payer: string; account: string; usage_date: string; description: string; amount: string }[];
  distinct_items?: string;
  asOf?: string;
}
export async function getCredit(from?: string, to?: string): Promise<CreditData> {
  const s = await signedClient();
  if (!s) return { available: false };
  try {
    const r = await s.aws.fetch(`${s.base}/cur-dash/credit${from && to ? `?from=${from}&to=${to}` : ""}`, { headers: { "x-notiops-id-token": s.idToken } });
    return r.ok ? r.json() : { available: false, reason: `http-${r.status}` };
  } catch { return { available: false, reason: "error" }; }
}

/* ── 扩展支持 ── */
export interface EsData {
  available: boolean;
  reason?: string;
  month?: string;
  total?: string;
  by_item?: { service: string; es_item: string; amortized_cost: string; avg_daily_instances: string }[];
  asOf?: string;
}
export async function getExtendedSupport(from?: string, to?: string): Promise<EsData> {
  const s = await signedClient();
  if (!s) return { available: false };
  try {
    const r = await s.aws.fetch(`${s.base}/cur-dash/extended-support${from && to ? `?from=${from}&to=${to}` : ""}`, { headers: { "x-notiops-id-token": s.idToken } });
    return r.ok ? r.json() : { available: false, reason: `http-${r.status}` };
  } catch { return { available: false, reason: "error" }; }
}

/* ── Savings Plans ── */
export interface SpData {
  available: boolean;
  reason?: string;
  month?: string;
  details?: Record<string, string>[];
  coverageDaily?: { usage_date?: string; d?: string; sp_coverage_pct?: string; coverage_pct?: string }[] | Record<string, unknown>;
  utilization?: Record<string, string>;
  coverageVcpuDaily?: { usage_date: string; sp_coverage_vcpu_pct: string }[];
  odcrVcpuDaily?: { usage_date: string; odcr_utilization_vcpu_pct: string }[] | null;
  asOf?: string;
}
export async function getSavingsPlans(from?: string, to?: string): Promise<SpData> {
  const s = await signedClient();
  if (!s) return { available: false };
  try {
    const r = await s.aws.fetch(`${s.base}/cur-dash/sp${from && to ? `?from=${from}&to=${to}` : ""}`, { headers: { "x-notiops-id-token": s.idToken } });
    return r.ok ? r.json() : { available: false, reason: `http-${r.status}` };
  } catch { return { available: false, reason: "error" }; }
}
