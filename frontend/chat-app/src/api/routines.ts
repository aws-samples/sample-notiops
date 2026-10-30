/**
 * 定时任务（更多 → 定时任务）的数据层 —— 接 BFF 的 /routines 一组路由（bff/web-chat/routines_api.mjs）。
 * 都走 SigV4（复用 chat.ts 的 signedClient）。失败一律回 `{ ok:false, error }`，error 是后端的短码
 * （invalid_schedule / too_frequent / skill_not_published …），界面按码给中英文提示（i18n 的 rt.err.*）。
 */
import { signedClient } from "./chat";

export type ScheduleKind = "once" | "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "cron";

export interface RoutineSchedule {
  kind: ScheduleKind;
  tz: string;
  time?: string;        // "09:00"：once / daily / weekdays / weekly / monthly
  minute?: number;      // hourly：每小时第几分
  days?: number[];      // weekly：ISO 周几（1=周一 … 7=周日）
  dom?: number;         // monthly：几号（小月没有就取最后一天）
  date?: string;        // once："2026-11-05"
  cron?: string;        // cron：5 段数字，按 tz 解释
  start_date?: string;
  end_date?: string;
}

export interface RoutineRunRef {
  sk?: string;
  scheduled_at: number;
  status: string;
  reason?: string;
  finished_at?: number;
  conv_id?: string;
  report_url?: string;
  skill_loaded?: boolean | null;
}

export interface ActiveRun {
  sk: string;
  scheduled_at: number;
  status: "running" | "queued";
  trigger?: string;
  started_at?: number;
  queued_at?: number;
  console_url?: string;
}

export interface Routine {
  id: string;
  name: string;
  skill_id: string;
  skill_name?: string;
  account_id: string;
  context: string;
  schedule: RoutineSchedule;
  locale?: "zh" | "en";
  enabled: boolean;
  paused_reason?: string | null;
  next_run_at: number | null;
  active_run: ActiveRun | null;
  last_run: RoutineRunRef | null;
  consecutive_failures?: number;
  run_count?: number;
  owner_username?: string;
  created_at?: number;
  updated_at?: number;
}

export interface RoutineRun {
  sk: string;
  scheduled_at: number;
  trigger?: "schedule" | "catch_up" | "manual" | string;
  status: "queued" | "starting" | "running" | "succeeded" | "failed" | "skipped" | string;
  reason?: string;
  detail?: string;
  started_at?: number;
  finished_at?: number;
  conv_id?: string;
  report_url?: string;
  trace_url?: string;
  console_url?: string;
  skill_loaded?: boolean | null;
}

export interface RoutineLimits {
  max_enabled: number;
  max_concurrent: number;
  min_interval_minutes: number;
  context_max: number;
  run_now_per_hour: number;
  max_failures: number;
  report_retention_days: number;
}

/** 已发布到 DevOps Agent 的 Skill（新建框的下拉用；由 /routines 一并给，不依赖 nav:skills）。 */
export interface PublishableSkill {
  skill_id: string;
  name: string;
  latest_version: string;
  targets: Array<{ key: string; account_id: string; uploaded_version: string; marker: boolean }>;
}

export interface RoutinesList {
  routines: Routine[];
  switch_on: boolean;
  limits: RoutineLimits;
  /** null = 这次没列出来（不是「没有」）。 */
  skills: PublishableSkill[] | null;
}

export type RoutineInput = Pick<Routine, "name" | "skill_id" | "account_id" | "context" | "schedule"> & {
  locale?: "zh" | "en";
  enabled?: boolean;
};

type Res<T> = { ok: true; data: T } | { ok: false; error: string; status?: number };

async function call<T>(method: string, path: string, body?: unknown): Promise<Res<T>> {
  const s = await signedClient();
  if (!s) return { ok: false, error: "not_signed_in" };
  try {
    const r = await s.aws.fetch(`${s.base}${path}`, {
      method,
      headers: { "x-notiops-id-token": s.idToken, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: String(data?.error || `http_${r.status}`), status: r.status };
    return { ok: true, data: data as T };
  } catch {
    return { ok: false, error: "network" };
  }
}

export const listRoutines = () => call<RoutinesList>("GET", "/routines");
export const createRoutine = (input: RoutineInput) => call<{ routine: Routine }>("POST", "/routines", input);
export const updateRoutine = (id: string, input: Partial<RoutineInput>) =>
  call<{ routine: Routine }>("PUT", `/routines/${encodeURIComponent(id)}`, input);
export const deleteRoutine = (id: string) => call<{ ok: true }>("DELETE", `/routines/${encodeURIComponent(id)}`);
export const toggleRoutine = (id: string, enabled: boolean) =>
  call<{ routine: Routine }>("POST", `/routines/${encodeURIComponent(id)}/toggle`, { enabled });
export const runRoutineNow = (id: string) =>
  call<{ ok: true; started?: boolean; queued?: boolean }>("POST", `/routines/${encodeURIComponent(id)}/run`, {});
export const listRoutineRuns = (id: string) => call<{ runs: RoutineRun[] }>("GET", `/routines/${encodeURIComponent(id)}/runs`);
