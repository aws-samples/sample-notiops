/**
 * 通知收件箱客户端（主动观察 push 的 web 端）。
 *
 * 后端由 shared/report_delivery/web_push_handler.py 把 EventBridge 事件落库到
 * notiops-web-chat 表的 notif# 段；BFF 暴露三个只读/游标接口：
 *   GET  /notifications          列出通知（倒序）+ 已读游标
 *   GET  /notifications/unread   未读数（60s 轮询红点用，轻量）
 *   POST /notifications/read     标记已读（upto_ts 缺省=最新）
 *
 * 设计：持久化收件箱可靠、进来即可回顾；
 * 实时红点靠前端 60s 轮询 unread —— 不引入 WebSocket。
 */
import { signedClient } from "./chat";

export type Severity = "info" | "warn" | "critical";

export interface NotificationItem {
  id: string;              // SK，稳定唯一
  ts: number;              // 事件写入时间（ms）
  source: string;          // "CloudWatch Alarm" / "GuardDuty" ...
  title: string;
  severity: Severity;
  resource?: string;
  region?: string;
  account?: string;
  description?: string;    // markdown 多行上下文
  consoleUrl?: string;     // 深链到 AWS 控制台
  dispatchQuery?: string;  // 「深入调查」时发给 DevOps Agent 的文本
  read: boolean;
}

export interface NotificationsResponse {
  items: NotificationItem[];
  lastReadTs: number;
  /** 收件箱真实总条数。被截断时由后端聚合得出；null = 查不到（不谎报）。 */
  total?: number | null;
  /** true = items 只是最新一页，还有更老的通知未返回（前端须如实提示，勿静默截断）。 */
  truncated?: boolean;
  /** 各事件类型在**整个**收件箱里的条数，键 = 落库的 source 标签（"CloudWatch Alarm" 等）。
   *  分组徽章用它，才不会在截断时把各组数字一起报小。null = 未知。 */
  bySource?: Record<string, number> | null;
}

/** 列出通知（倒序）。失败/未登录 → 空。 */
export async function listNotifications(): Promise<NotificationsResponse> {
  const empty = { items: [], lastReadTs: 0, total: 0, truncated: false, bySource: {} };
  const s = await signedClient();
  if (!s) return empty;
  try {
    const r = await s.aws.fetch(`${s.base}/notifications`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return empty;
    return await r.json();
  } catch { return empty; }
}

/** 未读数（轻量，供 60s 轮询）。失败 → 0。 */
export async function unreadCount(): Promise<{ unread: number; latestTs: number; total: number }> {
  const s = await signedClient();
  if (!s) return { unread: 0, latestTs: 0, total: 0 };
  try {
    const r = await s.aws.fetch(`${s.base}/notifications/unread`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return { unread: 0, latestTs: 0, total: 0 };
    return await r.json();
  } catch { return { unread: 0, latestTs: 0, total: 0 }; }
}

/** 标记已读到 uptoTs（缺省=现在=全部已读）。 */
export async function markRead(uptoTs?: number): Promise<void> {
  const s = await signedClient();
  if (!s) return;
  try {
    await s.aws.fetch(`${s.base}/notifications/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-notiops-id-token": s.idToken },
      body: JSON.stringify({ upto_ts: uptoTs ?? Date.now() }),
    });
  } catch { /* ignore */ }
}

/* ───────────────── AWS Health Dashboard（通知主题重点区块）───────────────── */

export interface HealthEvent {
  arn: string;
  service: string;
  eventTypeCode: string;
  category: "issue" | "scheduledChange" | "accountNotification" | "investigation" | string;
  region: string;
  statusCode: string;
  scope: string;
  startTime: number;
  lastUpdatedTime: number;
  description?: string;
  affectedAccounts?: number | null; // org 视图：受影响账号数
  account?: string; // org 视图：来源账号
}
export interface HealthBucket { items: HealthEvent[]; moreCount: number }
export interface HealthLinks {
  home: string;
  serviceOpenIssues: string; serviceHistory: string;
  openIssues: string; scheduledChanges: string;
  otherNotifications: string; eventLog: string;
}
export interface HealthDashboard {
  available: boolean;
  reason?: string;            // subscription_required | error
  message?: string;
  serviceIssues?: HealthBucket;
  accountIssues?: HealthBucket;
  scheduledChanges?: HealthBucket;
  otherCount?: number;
  links: HealthLinks;
}

/** 拉取 Health Dashboard(服务运行状况 / 账户运行状况 / 计划变更)。失败/未登录 → available:false。 */
export async function getHealthDashboard(accountId?: string): Promise<HealthDashboard | null> {
  const s = await signedClient();
  if (!s) return null;
  try {
    const r = await s.aws.fetch(`${s.base}/health/dashboard${accountId ? `?account=${encodeURIComponent(accountId)}` : ""}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export interface HealthAffectedEntity { value: string; status: string; lastUpdatedTime: number }
export interface HealthEventDetail {
  available: boolean;
  reason?: string;
  arn?: string;
  service?: string;
  eventTypeCode?: string;
  category?: string;
  region?: string;
  statusCode?: string;
  startTime?: number;
  endTime?: number;
  lastUpdatedTime?: number;
  description?: string;
  affectedEntities?: HealthAffectedEntity[];
}

/** 拉单个 Health 事件的完整详情(渐进式加载:点"显示完整通知"/深入调查时)。 */
export async function getHealthEventDetail(arn: string): Promise<HealthEventDetail | null> {
  const s = await signedClient();
  if (!s) return null;
  try {
    const r = await s.aws.fetch(`${s.base}/health/event?arn=${encodeURIComponent(arn)}`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** 轻量:未处理 issue 数(红点/轮询用)。 */
export async function healthOpenIssueCount(): Promise<number> {
  const s = await signedClient();
  if (!s) return 0;
  try {
    const r = await s.aws.fetch(`${s.base}/health/dashboard/count`, { headers: { "x-notiops-id-token": s.idToken } });
    if (!r.ok) return 0;
    const j = await r.json();
    return j.openIssues || 0;
  } catch { return 0; }
}
