/**
 * 定时任务的「频率」在界面上的样子：人话描述、按任务时区显示时间。
 * 真正的「下一次什么时候跑」以后端为准（bff/web-chat/routines_schedule.mjs 的 nextRun），这里不重算。
 * 不做成本预估（用户 2026-10-30 要求去掉）。
 */
import type { RoutineSchedule, ScheduleKind } from "./api/routines";

export const SCHEDULE_KINDS: ScheduleKind[] = ["daily", "weekdays", "weekly", "monthly", "hourly", "once", "cron"];

/** 浏览器所在时区（新建任务的默认值）。 */
export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

/** 常用时区（下拉里先列这些；也可以手填任意 IANA 时区）。 */
export const COMMON_TIMEZONES = [
  "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul",
  "UTC", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles",
];

const WD_ZH = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WD_EN = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 「每个工作日 09:00」/ "Weekdays at 09:00"（不含时区）。 */
export function describeSchedule(s: RoutineSchedule | undefined, en: boolean): string {
  if (!s) return "";
  const at = s.time || "";
  switch (s.kind) {
    case "once": return en ? `Once, ${s.date || ""} ${at}` : `一次性，${s.date || ""} ${at}`;
    case "hourly": return en ? `Hourly at :${String(s.minute ?? 0).padStart(2, "0")}` : `每小时第 ${s.minute ?? 0} 分`;
    case "daily": return en ? `Daily at ${at}` : `每天 ${at}`;
    case "weekdays": return en ? `Weekdays at ${at}` : `每个工作日 ${at}`;
    case "weekly": {
      const days = (s.days || []).map((d) => (en ? WD_EN : WD_ZH)[d]).join(en ? ", " : "、");
      return en ? `Weekly on ${days} at ${at}` : `每周${days} ${at}`;
    }
    case "monthly":
      return s.dom === 31
        ? (en ? `Monthly on the last day at ${at}` : `每月最后一天 ${at}`)
        : (en ? `Monthly on day ${s.dom} at ${at}` : `每月 ${s.dom} 号 ${at}`);
    case "cron": return `cron ${s.cron || ""}`;
    default: return "";
  }
}

/** 按任务时区显示一个时刻："11-03 09:00"（跨年才带年份）。 */
export function formatInTz(ms: number | null | undefined, tz: string, en: boolean): string {
  if (!ms) return "—";
  try {
    const d = new Date(ms);
    const sameYear = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(d)
      === new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric" }).format(new Date());
    return new Intl.DateTimeFormat(en ? "en-US" : "zh-CN", {
      timeZone: tz, hourCycle: "h23",
      ...(sameYear ? {} : { year: "numeric" }), month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).format(d);
  } catch { return new Date(ms).toISOString().slice(0, 16).replace("T", " "); }
}
