/**
 * 定时任务的时间规则（纯函数，无 I/O）：校验用户填的频率、算「下一次什么时候跑」。
 *
 * 时间一律按任务自己的 IANA 时区（默认浏览器时区）解释，存储和比较用 UTC 毫秒。
 * 夏令时：
 *   · 不存在的本地时刻（春季拨快，例如 02:30 那一小时没有）→ 顺延到那一刻之后第一个真实存在的时刻；
 *   · 重复的本地时刻（秋季拨慢，01:30 出现两次）→ 取第一次。
 * 每月几号：小月没有 31 号时取那个月最后一天（「每月 31 号」= 每月最后一天）。
 *
 * 频率下限：两次运行之间至少 60 分钟（与 Claude Code 的 scheduled tasks 一致；深度调查按秒计费）。
 * cron 只认 5 段数字写法（分 时 日 月 周，周日 = 0 或 7），按任务时区解释；不认 JAN / MON 这类名字。
 */

export const MIN_INTERVAL_MINUTES = 60;
export const KINDS = ["once", "hourly", "daily", "weekdays", "weekly", "monthly", "cron"];

const DAY_MS = 86400000;
const MIN_MS = 60000;

const err = (code) => Object.assign(new Error(code), { code: "bad_request", reason: code });

/* ───────────────────────── 时区换算 ───────────────────────── */

const _fmtCache = new Map();
function fmt(tz) {
  let f = _fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short",
    });
    _fmtCache.set(tz, f);
  }
  return f;
}
const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** 时区是否合法（Intl 认得）。 */
export function validTimezone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try { fmt(tz).format(0); return true; } catch { return false; }
}

/** UTC 毫秒 → 该时区的墙上时间 {y, m(1-12), d, h, mi, wd(ISO 1=周一..7=周日)}。 */
export function zonedParts(ms, tz) {
  const out = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) {
    if (p.type === "year") out.y = +p.value;
    else if (p.type === "month") out.m = +p.value;
    else if (p.type === "day") out.d = +p.value;
    else if (p.type === "hour") out.h = +p.value % 24;
    else if (p.type === "minute") out.mi = +p.value;
    else if (p.type === "weekday") out.wd = WD[p.value];
  }
  return out;
}

/** 该时刻在这个时区的 UTC 偏移（毫秒，东八区 = +8h）。 */
function offsetAt(ms, tz) {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / MIN_MS) * MIN_MS;
}

/** 墙上时间（该时区）→ UTC 毫秒。不存在的时刻顺延，重复的取第一次（见文件头）。 */
export function zonedToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const o1 = offsetAt(guess, tz);
  const o2 = offsetAt(guess - o1, tz);
  // 两个候选：按「之前」和「之后」的偏移各算一次；墙上时间对得上的就是答案（重复时刻两个都对，取早的）。
  const cands = [...new Set([guess - o1, guess - o2])].sort((a, b) => a - b);
  for (const t of cands) {
    const p = zonedParts(t, tz);
    if (p.y === y && p.m === m && p.d === d && p.h === h && p.mi === mi) return t;
  }
  // 不存在的时刻（落在拨快的那一段里）：顺延到它之后第一个存在的分钟。
  let t = Math.min(...cands);
  for (let i = 0; i < 180; i++, t += MIN_MS) {
    const p = zonedParts(t, tz);
    const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    if (wall >= guess) return t;
  }
  return Math.max(...cands);
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** 本地日期（y,m,d）加 n 天。 */
function addDays({ y, m, d }, n) {
  const t = new Date(Date.UTC(y, m - 1, d) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(),
           wd: ((t.getUTCDay() + 6) % 7) + 1 };
}
const ymd = ({ y, m, d }) => y * 10000 + m * 100 + d;
function parseDate(s) {
  const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!mm) return null;
  const y = +mm[1], m = +mm[2], d = +mm[3];
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}
function parseTime(s) {
  const mm = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  if (!mm) return null;
  const h = +mm[1], mi = +mm[2];
  return h <= 23 && mi <= 59 ? { h, mi } : null;
}

/* ───────────────────────── cron（5 段，数字）───────────────────────── */

function parseField(f, lo, hi) {
  const out = new Set();
  for (const part of String(f).split(",")) {
    const mm = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part.trim());
    if (!mm) throw err("invalid_cron");
    let a = lo, b = hi;
    if (mm[1] !== "*") {
      const [x, y] = mm[1].split("-").map(Number);
      a = x; b = y ?? (mm[2] ? hi : x);
    }
    const step = mm[2] ? +mm[2] : 1;
    if (a < lo || b > hi || a > b || step < 1) throw err("invalid_cron");
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** "m h dom mon dow" → 解析结果。周日 0 和 7 都认（统一成 7，与 ISO 周对齐）。 */
export function parseCron(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) throw err("invalid_cron");
  const dowRaw = parseField(f[4], 0, 7);
  const dow = new Set([...dowRaw].map((v) => (v === 0 ? 7 : v)));
  return {
    minutes: parseField(f[0], 0, 59), hours: parseField(f[1], 0, 23),
    dom: parseField(f[2], 1, 31), months: parseField(f[3], 1, 12), dow,
    domAny: f[2] === "*", dowAny: f[4] === "*",
  };
}

/** cron 的日期是否命中。日和周都限定时按 cron 惯例取「或」。 */
function cronDayMatch(c, day) {
  if (!c.months.has(day.m)) return false;
  const domHit = c.dom.has(day.d), dowHit = c.dow.has(day.wd);
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return dowHit;
  if (c.dowAny) return domHit;
  return domHit || dowHit;
}

/* ───────────────────────── 校验 ───────────────────────── */

/**
 * 校验并归一用户填的频率。返回只含有效字段的新对象；不合法抛 `{code:"bad_request", reason}`。
 * reason ∈ invalid_kind / invalid_timezone / invalid_time / invalid_minute / invalid_days /
 *          invalid_dom / invalid_date / invalid_cron / end_before_start / too_frequent / no_future_run
 */
export function validateSchedule(raw, { now = Date.now() } = {}) {
  const s = raw && typeof raw === "object" ? raw : {};
  const kind = String(s.kind || "");
  if (!KINDS.includes(kind)) throw err("invalid_kind");
  const tz = String(s.tz || "").trim();
  if (!validTimezone(tz)) throw err("invalid_timezone");
  const out = { kind, tz };
  if (["once", "daily", "weekdays", "weekly", "monthly"].includes(kind)) {
    if (!parseTime(s.time)) throw err("invalid_time");
    const t = parseTime(s.time);
    out.time = `${String(t.h).padStart(2, "0")}:${String(t.mi).padStart(2, "0")}`;
  }
  if (kind === "hourly") {
    const mi = Number(s.minute);
    if (!Number.isInteger(mi) || mi < 0 || mi > 59) throw err("invalid_minute");
    out.minute = mi;
  }
  if (kind === "weekly") {
    const days = [...new Set((Array.isArray(s.days) ? s.days : []).map(Number))].filter((v) => v >= 1 && v <= 7).sort();
    if (!days.length) throw err("invalid_days");
    out.days = days;
  }
  if (kind === "monthly") {
    const dom = Number(s.dom);
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) throw err("invalid_dom");
    out.dom = dom;
  }
  if (kind === "once") {
    if (!parseDate(s.date)) throw err("invalid_date");
    out.date = String(s.date);
  }
  if (kind === "cron") {
    parseCron(s.cron);
    out.cron = String(s.cron).trim().replace(/\s+/g, " ");
  }
  if (s.start_date) {
    if (!parseDate(s.start_date)) throw err("invalid_date");
    out.start_date = String(s.start_date);
  }
  if (s.end_date) {
    if (!parseDate(s.end_date)) throw err("invalid_date");
    out.end_date = String(s.end_date);
  }
  if (out.start_date && out.end_date && out.end_date < out.start_date) throw err("end_before_start");
  // 频率下限只需要查 cron：其余几种按定义就不会比「每小时」更密。
  // 按**墙上时间**算名义频率（换成 UTC 时区、去掉起止日期）：夏令时切换那天，「每小时 :30」会因为
  // 02:30 不存在而顺延到 03:00，与 03:30 只隔 30 分钟 —— 那是时钟的事，不是用户填得太密。
  if (kind === "cron" && minGapMinutes({ kind, tz: "UTC", cron: out.cron }, now) < MIN_INTERVAL_MINUTES) {
    throw err("too_frequent");
  }
  if (nextRun(out, now) === null) throw err("no_future_run");
  return out;
}

/** 从 now 起往后取若干次运行，返回相邻两次的最小间隔（分钟）。取不到两次 → Infinity。 */
export function minGapMinutes(schedule, now = Date.now(), samples = 60) {
  let prev = nextRun(schedule, now);
  let min = Infinity;
  for (let i = 0; i < samples && prev !== null; i++) {
    const n = nextRun(schedule, prev);
    if (n === null) break;
    min = Math.min(min, (n - prev) / MIN_MS);
    prev = n;
  }
  return min;
}

/* ───────────────────────── 下一次运行 ───────────────────────── */

/** 某个本地日期上，这条规则的所有运行时刻（本地 h/mi，升序）。 */
function timesOn(s, day, cron) {
  const at = (t) => [{ h: t.h, mi: t.mi }];
  switch (s.kind) {
    case "hourly": return Array.from({ length: 24 }, (_, h) => ({ h, mi: s.minute }));
    case "daily": return at(parseTime(s.time));
    case "weekdays": return day.wd <= 5 ? at(parseTime(s.time)) : [];
    case "weekly": return s.days.includes(day.wd) ? at(parseTime(s.time)) : [];
    case "monthly": return day.d === Math.min(s.dom, daysInMonth(day.y, day.m)) ? at(parseTime(s.time)) : [];
    case "once": {
      const d = parseDate(s.date);
      return d && ymd(d) === ymd(day) ? at(parseTime(s.time)) : [];
    }
    case "cron": {
      if (!cronDayMatch(cron, day)) return [];
      const out = [];
      for (const h of [...cron.hours].sort((a, b) => a - b)) {
        for (const mi of [...cron.minutes].sort((a, b) => a - b)) out.push({ h, mi });
      }
      return out;
    }
    default: return [];
  }
}

/**
 * 严格晚于 `after`（UTC 毫秒）的下一次运行（UTC 毫秒）；没有了（一次性已过、到了结束日期）→ null。
 * 往后最多看 400 天（cron 写成「2 月 30 号」这种永远不命中的，会在这里得到 null）。
 */
export function nextRun(schedule, after) {
  const s = schedule;
  const tz = s.tz;
  const cron = s.kind === "cron" ? parseCron(s.cron) : null;
  const start = s.start_date ? parseDate(s.start_date) : null;
  const end = s.end_date ? parseDate(s.end_date) : null;
  // 从 after 所在的本地日期前一天开始（跨时区边界时不漏掉当天）。
  const p = zonedParts(after, tz);
  let day = addDays({ y: p.y, m: p.m, d: p.d }, -1);
  for (let i = 0; i < 400; i++, day = addDays(day, 1)) {
    if (start && ymd(day) < ymd(start)) continue;
    if (end && ymd(day) > ymd(end)) return null;
    for (const t of timesOn(s, day, cron)) {
      const ms = zonedToUtc(day.y, day.m, day.d, t.h, t.mi, tz);
      if (ms > after) return ms;
    }
  }
  return null;
}

/** 不晚于 `now` 的最近一次计划时刻（≥ `since`）；没有 → null。补跑「错过的最近一次」用。 */
export function latestDue(schedule, since, now) {
  let t = nextRun(schedule, since - 1);
  let last = null;
  for (let i = 0; t !== null && t <= now && i < 1000; i++) {
    last = t;
    t = nextRun(schedule, t);
  }
  return last;
}
