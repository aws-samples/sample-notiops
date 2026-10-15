/**
 * 消息时间标签（messageTime.ts）。
 *
 * 背景（2026-10-13 用户报的）：老会话里的消息全写着「今天 HH:MM」—— 原来的 fmtTime 把前缀写死成
 * 「今天」，历史消息的日期因此全是假的（时间戳本身没错）。这里用**本地时间**构造日期，所以断言
 * 与跑测试那台机器的时区无关。
 */
import { describe, it, expect } from "vitest";
import { formatMessageTime } from "./messageTime";

// 「现在」= 2026-10-13 10:30（本地时间）
const NOW = new Date(2026, 9, 13, 10, 30).getTime();
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();

describe("formatMessageTime", () => {
  it("今天只给时分（与改动前一样）", () => {
    expect(formatMessageTime(at(2026, 10, 13, 9, 5), "zh", NOW)).toBe("今天 9:05");
    expect(formatMessageTime(at(2026, 10, 13, 9, 5), "en", NOW)).toBe("Today 9:05");
  });

  it("历史消息不许再写「今天」—— 用户报的就是这个", () => {
    const old = at(2026, 8, 20, 14, 7);
    expect(formatMessageTime(old, "zh", NOW)).toBe("8月20日 14:07");
    expect(formatMessageTime(old, "zh", NOW)).not.toContain("今天");
    expect(formatMessageTime(old, "en", NOW)).toBe("Aug 20 14:07");
  });

  it("按本地日历日算昨天，不按 24 小时差", () => {
    expect(formatMessageTime(at(2026, 10, 12, 23, 59), "zh", NOW)).toBe("昨天 23:59");
    expect(formatMessageTime(at(2026, 10, 12, 0, 1), "en", NOW)).toBe("Yesterday 0:01");
    // 凌晨看昨晚：相差不到 1 小时也是「昨天」
    const justAfterMidnight = new Date(2026, 9, 13, 0, 10).getTime();
    expect(formatMessageTime(at(2026, 10, 12, 23, 50), "zh", justAfterMidnight)).toBe("昨天 23:50");
  });

  it("往年要带年份", () => {
    expect(formatMessageTime(at(2025, 12, 31, 23, 0), "zh", NOW)).toBe("2025年12月31日 23:00");
    expect(formatMessageTime(at(2025, 12, 31, 23, 0), "en", NOW)).toBe("Dec 31, 2025 23:00");
  });

  it("时间戳无效时不显示（不显示一个假的时间）", () => {
    expect(formatMessageTime(Number.NaN, "zh", NOW)).toBe("");
    expect(formatMessageTime(undefined as unknown as number, "zh", NOW)).toBe("");
  });

  it("默认拿当前时间当「现在」", () => {
    expect(formatMessageTime(Date.now(), "zh")).toMatch(/^今天 \d{1,2}:\d{2}$/);
  });
});
