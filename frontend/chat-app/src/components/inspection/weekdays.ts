/**
 * 执行日（`weekdays`）的域与换算。**独立成文件**，不放在 `ConfigPage.tsx` 里。
 *
 * ⚠️ 理由是 lint 的 `react-refresh/only-export-components`：一个 `.tsx` 里
 *    混着组件与普通函数的导出会让 Vite 的 fast refresh 失效（改一行样式整页
 *    重载、丢掉编辑中的表单状态）。规则有真实成本，不用 disable 绕。
 *
 * ## 这一层为什么必须存在
 *
 * 库里和屏幕上是**两套表示**，而它们的「空」含义相反：
 *
 * ```
 * 库里   []/缺失  = 不做过滤 = 每天都跑
 *                  （lambda_inspection_scheduler 只在非空时才比 isoweekday()）
 * 屏幕上 七个 chip 全灭 = 看起来「一天都不跑」
 * ```
 *
 * 直接把库里的值渲染出去就是这条缺陷：七个 chip 全灭、旁边一行小字写「每天」，
 * 屏幕上两个说法互相矛盾，而正确的是那行小字。
 *
 * 🔴 这个文件是两套表示之间的**唯一**换算点。分叉的表现是屏幕上写的执行日与
 *    实际执行的不是一回事，而它不报任何错。
 */

/** **1 = 周一 … 7 = 周日**，对齐调度器的 `date.isoweekday()`。
 *
 * 🔴 不是 `weekday()`（0=周一），也不是 JS 的 `getUTCDay()`（0=周日）。
 *    用 0 存进去的那一类巡检**永远不跑**（`isoweekday()` 永远不返回 0），
 *    run 记录里连一行都没有，看起来像「调度器压根没派它」—— 零错误信号。
 */
export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * 库里的 `weekdays` → 屏幕上该亮哪几天。空 / 缺失展开成七天。
 *
 * 与它成对的是保存那一侧：**七天全选 → 传 `undefined`**（库里仍是「没有这个
 * 字段」）。落成 `[1..7]` 的调度行为完全一致，但会让库里多一个「配过了」的
 * 显式值，而下一个人看到它会以为这是客户刻意逐个勾出来的七天，不敢动。
 */
export function effectiveWeekdays(weekdays?: number[] | null): number[] {
  return weekdays && weekdays.length > 0 ? [...weekdays] : [...WEEKDAYS];
}

/**
 * 屏幕上的选择 → 该往库里写什么。`undefined` = 不写这个字段（每天）。
 *
 * ⚠️ 判据是「等于七」，不是「非空」。`wd` 在 UI 里**永远非空**
 *   （见 `effectiveWeekdays` 与 ConfigPage 的 state 初值），所以
 *   `wd.length > 0 ? wd : undefined` 这个老判据在新语义下恒真。
 */
export function weekdaysForSave(wd: number[]): number[] | undefined {
  return wd.length === WEEKDAYS.length ? undefined : wd;
}
