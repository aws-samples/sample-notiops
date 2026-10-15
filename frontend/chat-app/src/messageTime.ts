// 消息气泡上的时间标签（Message.tsx 的 `.ts` 那一格）。
//
// 🔴 2026-10-13 用户报的：老会话里的消息全写着「今天 HH:MM」。原来的 fmtTime 只取时分、
//    前缀**写死**成「今天 / Today」—— 存储里的时间戳本来就对（BFF 落库时记的是那一刻，
//    读历史原样返回），错的只是这一格的日期。翻回一段上个月的排障记录时，「今天」是假信息。
//
// 口径（按**本地**日历日算，不按 24 小时差算 —— 昨晚 23:50 的消息今早 00:10 看是「昨天」）：
//   今天 → 「今天 9:05」   昨天 → 「昨天 23:59」   今年更早 → 「10月1日 8:00」
//   往年 → 「2025年12月31日 23:00」；英文 Today / Yesterday / Oct 1 / Dec 31, 2025。
//   时间戳无效（老数据缺字段）→ 空串：宁可不显示，也不显示一个假的时间。
// 月份缩写用固定数组，不走 toLocaleString —— 显示不随浏览器区域设置漂。

const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

const startOfLocalDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function formatMessageTime(ts: number, locale: string, now: number = Date.now()): string {
  const d = new Date(ts);
  if (typeof ts !== "number" || !Number.isFinite(d.getTime())) return "";
  const en = locale === "en";
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const n = new Date(now);
  // Math.round：夏令时那天一天是 23 / 25 小时，直接整除会差一天。
  const days = Math.round((startOfLocalDay(n) - startOfLocalDay(d)) / DAY_MS);
  if (days === 0) return (en ? "Today " : "今天 ") + hm;
  if (days === 1) return (en ? "Yesterday " : "昨天 ") + hm;
  const sameYear = d.getFullYear() === n.getFullYear();
  if (en) {
    const md = `${MONTHS_EN[d.getMonth()]} ${d.getDate()}`;
    return sameYear ? `${md} ${hm}` : `${md}, ${d.getFullYear()} ${hm}`;
  }
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  return sameYear ? `${md} ${hm}` : `${d.getFullYear()}年${md} ${hm}`;
}
