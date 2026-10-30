/**
 * 定时任务的时间规则（routines_schedule.mjs）。
 *
 * 这些算错了不会报错，只会**在错的时间跑、或者干脆不跑**，而且要等到那个时间点才看得出来：
 *   · 时区：「每天 09:00 · 上海」必须是 UTC 01:00，不是服务器的 09:00；
 *   · 夏令时：不存在的 02:30 顺延、重复的 01:30 只跑第一次；
 *   · 每月 31 号在二月 = 二月最后一天，不是「二月不跑」；
 *   · 工作日 / 每周几 / cron 的日与周「或」语义；
 *   · 频率下限 60 分钟，且夏令时那天的「每小时」不会被误判成太密；
 *   · 起止日期、一次性任务过了就没有下一次。
 *
 * 运行：cd bff/web-chat && node tests/routines_schedule.test.mjs
 */
import assert from "node:assert/strict";
import {
  validateSchedule, nextRun, latestDue, zonedToUtc, zonedParts, parseCron, minGapMinutes, validTimezone,
} from "../routines_schedule.mjs";

let fails = 0, ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
}
const U = (s) => Date.parse(s);           // ISO（带 Z）→ 毫秒
const iso = (ms) => (ms === null ? null : new Date(ms).toISOString().slice(0, 16) + "Z");
const reason = (fn) => { try { fn(); return "no-error"; } catch (e) { return e.reason || e.message; } };
const SH = "Asia/Shanghai", NY = "America/New_York";

console.log("routines_schedule: 时间规则");

await t("时区：上海每天 09:00 = UTC 01:00；已过当天就排到明天", () => {
  const s = { kind: "daily", tz: SH, time: "09:00" };
  assert.equal(iso(nextRun(s, U("2026-11-02T00:30:00Z"))), "2026-11-02T01:00Z");
  assert.equal(iso(nextRun(s, U("2026-11-02T01:00:00Z"))), "2026-11-03T01:00Z", "严格晚于 after");
});

await t("工作日跳过周末；每周几按 ISO（1=周一，7=周日）", () => {
  const wd = { kind: "weekdays", tz: SH, time: "09:00" };
  // 2026-11-06 是周五
  assert.equal(iso(nextRun(wd, U("2026-11-06T02:00:00Z"))), "2026-11-09T01:00Z", "周五之后是下周一");
  const wk = { kind: "weekly", tz: SH, time: "18:30", days: [3, 7] };
  assert.equal(iso(nextRun(wk, U("2026-11-02T00:00:00Z"))), "2026-11-04T10:30Z", "周三");
  assert.equal(iso(nextRun(wk, U("2026-11-04T10:30:00Z"))), "2026-11-08T10:30Z", "周日");
});

await t("每月 31 号：小月取最后一天（二月 = 28 号），不是「这个月不跑」", () => {
  const s = { kind: "monthly", tz: SH, time: "08:00", dom: 31 };
  assert.equal(iso(nextRun(s, U("2027-01-31T01:00:00Z"))), "2027-02-28T00:00Z");
  assert.equal(iso(nextRun(s, U("2027-02-28T00:00:00Z"))), "2027-03-31T00:00Z");
});

await t("每小时第 15 分；一次性任务过了就没有下一次", () => {
  const h = { kind: "hourly", tz: SH, minute: 15 };
  assert.equal(iso(nextRun(h, U("2026-11-02T03:20:00Z"))), "2026-11-02T04:15Z");
  const once = { kind: "once", tz: SH, time: "10:00", date: "2026-11-05" };
  assert.equal(iso(nextRun(once, U("2026-11-01T00:00:00Z"))), "2026-11-05T02:00Z");
  assert.equal(nextRun(once, U("2026-11-05T02:00:00Z")), null);
});

await t("起止日期：开始日期之前不跑，结束日期之后没有下一次", () => {
  const s = { kind: "daily", tz: SH, time: "09:00", start_date: "2026-11-10", end_date: "2026-11-11" };
  assert.equal(iso(nextRun(s, U("2026-11-01T00:00:00Z"))), "2026-11-10T01:00Z");
  assert.equal(iso(nextRun(s, U("2026-11-10T01:00:00Z"))), "2026-11-11T01:00Z");
  assert.equal(nextRun(s, U("2026-11-11T01:00:00Z")), null);
});

await t("cron：按任务时区；日与周都限定时取「或」", () => {
  const s = { kind: "cron", tz: SH, cron: "0 9 * * 1-5" };
  assert.equal(iso(nextRun(s, U("2026-11-07T00:00:00Z"))), "2026-11-09T01:00Z", "周六之后是周一 09:00 上海");
  // 每月 1 号 或 每周日
  const or = { kind: "cron", tz: "UTC", cron: "0 12 1 * 0" };
  assert.equal(iso(nextRun(or, U("2026-10-31T13:00:00Z"))), "2026-11-01T12:00Z"); // 11-01 既是 1 号也是周日
  assert.equal(iso(nextRun(or, U("2026-11-01T12:00:00Z"))), "2026-11-08T12:00Z"); // 下一个周日
  assert.equal(parseCron("0 0 * * 0").dow.has(7), true, "周日写 0 也认");
});

await t("夏令时：不存在的 02:30 顺延到 03:00；重复的 01:30 只取第一次", () => {
  // 2026-03-08 纽约 02:00 拨到 03:00
  const spring = zonedToUtc(2026, 3, 8, 2, 30, NY);
  assert.equal(iso(spring), "2026-03-08T07:00Z");
  assert.deepEqual([zonedParts(spring, NY).h, zonedParts(spring, NY).mi], [3, 0]);
  // 2026-11-01 纽约 02:00 拨回 01:00：01:30 出现两次，取 EDT 那一次
  assert.equal(iso(zonedToUtc(2026, 11, 1, 1, 30, NY)), "2026-11-01T05:30Z");
  const daily = { kind: "daily", tz: NY, time: "01:30" };
  assert.equal(iso(nextRun(daily, U("2026-11-01T05:30:00Z"))), "2026-11-02T06:30Z", "同一天不跑第二次");
});

await t("频率下限：cron 比每小时密 → too_frequent；每小时整点可以；夏令时那天不误判", () => {
  const now = U("2026-11-02T00:00:00Z");
  assert.equal(reason(() => validateSchedule({ kind: "cron", tz: SH, cron: "*/30 * * * *" }, { now })), "too_frequent");
  assert.equal(reason(() => validateSchedule({ kind: "cron", tz: SH, cron: "0,30 9 * * *" }, { now })), "too_frequent");
  assert.equal(reason(() => validateSchedule({ kind: "cron", tz: SH, cron: "0 * * * *" }, { now })), "no-error");
  // 夏令时前一刻：纽约「每小时 :30」按真实时刻会出现 30 分钟的间隔，但它不是用户填得太密
  const nearDst = U("2026-03-08T05:00:00Z");
  assert.equal(reason(() => validateSchedule({ kind: "hourly", tz: NY, minute: 30 }, { now: nearDst })), "no-error");
  assert.equal(reason(() => validateSchedule({ kind: "cron", tz: NY, cron: "30 * * * *" }, { now: nearDst })), "no-error");
  assert.ok(minGapMinutes({ kind: "hourly", tz: NY, minute: 30 }, nearDst) < 60, "前提：真实时刻里确实有 30 分钟的间隔");
});

await t("校验：各种不合法输入给出明确的 reason", () => {
  const now = U("2026-11-02T00:00:00Z");
  const v = (s) => reason(() => validateSchedule(s, { now }));
  assert.equal(v({ kind: "yearly", tz: SH }), "invalid_kind");
  assert.equal(v({ kind: "daily", tz: "Mars/Olympus", time: "09:00" }), "invalid_timezone");
  assert.equal(v({ kind: "daily", tz: SH, time: "24:00" }), "invalid_time");
  assert.equal(v({ kind: "hourly", tz: SH, minute: 60 }), "invalid_minute");
  assert.equal(v({ kind: "weekly", tz: SH, time: "09:00", days: [] }), "invalid_days");
  assert.equal(v({ kind: "monthly", tz: SH, time: "09:00", dom: 0 }), "invalid_dom");
  assert.equal(v({ kind: "once", tz: SH, time: "09:00", date: "2026-02-30" }), "invalid_date");
  assert.equal(v({ kind: "cron", tz: SH, cron: "0 9 * *" }), "invalid_cron");
  assert.equal(v({ kind: "cron", tz: SH, cron: "0 9 * JAN *" }), "invalid_cron", "不认名字");
  assert.equal(v({ kind: "daily", tz: SH, time: "09:00", start_date: "2026-12-02", end_date: "2026-12-01" }), "end_before_start");
  assert.equal(v({ kind: "once", tz: SH, time: "09:00", date: "2026-10-01" }), "no_future_run");
  assert.equal(v({ kind: "cron", tz: SH, cron: "0 0 30 2 *" }), "no_future_run", "二月 30 号永远不命中");
  assert.equal(validTimezone("Asia/Shanghai"), true);
});

await t("归一：只留这个频率用得上的字段，时间补零", () => {
  const out = validateSchedule({ kind: "weekly", tz: SH, time: "9:05", days: [5, "3", 3, 9], minute: 7, cron: "x" },
                               { now: U("2026-11-02T00:00:00Z") });
  assert.deepEqual(out, { kind: "weekly", tz: SH, time: "09:05", days: [3, 5] });
});

await t("latestDue：错过的那一串里只取最近一次（补跑用）", () => {
  const s = { kind: "hourly", tz: "UTC", minute: 0 };
  assert.equal(iso(latestDue(s, U("2026-11-02T00:00:00Z"), U("2026-11-02T05:30:00Z"))), "2026-11-02T05:00Z");
  assert.equal(latestDue(s, U("2026-11-02T05:01:00Z"), U("2026-11-02T05:30:00Z")), null);
});

console.log(fails ? `\n${fails} failed` : `\n${ok} ok, 0 failed`);
process.exit(fails ? 1 : 0);
