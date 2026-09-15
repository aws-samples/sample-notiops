/**
 * Investigation 告警仪表盘客户端（只读，见 bff/web-chat/alarms.mjs）。
 * GET /investigate/alarms → 告警总览 / 当前 ALARM / 最近状态变更。
 */
import { signedClient } from "./chat";

export interface AlarmRow { name: string; state: string; metric: string; namespace: string; reason: string; updated: string }
export interface AlarmHistoryRow { name: string; summary: string; date: string }

export interface AlarmDashboardData {
  ok: boolean;
  available?: boolean;
  reason?: string;
  overview?: { ALARM: number; OK: number; INSUFFICIENT_DATA: number };
  total?: number;
  active?: AlarmRow[];
  recent?: AlarmHistoryRow[];
}

/**
 * `ok:false` = 没拿到（可重试）；`available:false` = 拿到了、后端说读不到告警。
 * 界面必须分开画 —— 两态混一态时 HTTP 500 会被渲染成「ALARM 0 / 当前无告警 ✓」。
 *
 * `reason` 只放我们自己的码（`http_NNN` / `fetch_failed`），**不放** `String(e)`：
 * 那串会带上请求 URL 和运行时报文，而它是要画到界面上的。见 docs/LOGGING_STANDARD.md。
 */
export async function getAlarmDashboard(accountId?: string): Promise<AlarmDashboardData> {
  const s = await signedClient();
  if (!s) return { ok: false, reason: "not_authenticated" };
  try {
    const q = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    const r = await s.aws.fetch(`${s.base}/investigate/alarms${q}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { ok: false, reason: "http_" + r.status };
    return await r.json();
  } catch {
    return { ok: false, reason: "fetch_failed" };
  }
}

// ④ Backup 仪表盘
export interface BackupData {
  ok: boolean; available?: boolean; reason?: string;
  windowDays?: number; totalJobs?: number; byState?: Record<string, number>;
  failedCount?: number; vaults?: number;
  failed?: { resource: string; resourceType: string; state: string; message: string; createdAt: string }[];
}

/**
 * 失败**不再**回 null。
 *
 * 原来「没登录 / HTTP 5xx / 网络断」和后端如实回的 `available:false`（真的没接 AWS
 * Backup）三种情况全都回 null，界面只有一句"Backup 数据不可用（未用 AWS Backup 或
 * 无权限）" —— 于是一次 500 被画成"你没在用这个服务"。用户据此**不会**去重试，也不会
 * 去查权限，他会以为这是自己环境的事实。
 *
 * 现在 `ok:false` = 我们没问到（可重试），`available:false` = 问到了、答案是没有。
 * 两者语义不同，界面必须分开画。
 */
export async function getBackupDashboard(accountId?: string): Promise<BackupData> {
  const s = await signedClient();
  if (!s) return { ok: false, reason: "not_authenticated" };
  try {
    const q = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    const r = await s.aws.fetch(`${s.base}/investigate/backup${q}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { ok: false, reason: "http_" + r.status };
    return await r.json();
  } catch { return { ok: false, reason: "fetch_failed" }; }
}

export interface AlarmOrgRow { accountId: string; name: string; available: boolean; total: number; ALARM: number; OK: number; INSUFFICIENT_DATA: number }
export async function getAlarmOrgSummary(): Promise<{ rows: AlarmOrgRow[] } | null> {
  const s = await signedClient();
  if (!s) return null;
  try {
    const r = await s.aws.fetch(`${s.base}/investigate/alarms/org-summary`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
