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

export async function getAlarmDashboard(accountId?: string): Promise<AlarmDashboardData> {
  const s = await signedClient();
  if (!s) return { ok: false };
  try {
    const q = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    const r = await s.aws.fetch(`${s.base}/investigate/alarms${q}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { ok: false, reason: "http_" + r.status };
    return await r.json();
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

// ④ Backup 仪表盘
export interface BackupData {
  ok: boolean; available?: boolean; reason?: string;
  windowDays?: number; totalJobs?: number; byState?: Record<string, number>;
  failedCount?: number; vaults?: number;
  failed?: { resource: string; resourceType: string; state: string; message: string; createdAt: string }[];
}
export async function getBackupDashboard(accountId?: string): Promise<BackupData | null> {
  const s = await signedClient();
  if (!s) return null;
  try {
    const q = accountId ? `?account=${encodeURIComponent(accountId)}` : "";
    const r = await s.aws.fetch(`${s.base}/investigate/backup${q}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
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
