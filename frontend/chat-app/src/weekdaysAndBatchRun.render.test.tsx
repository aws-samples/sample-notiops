/**
 * 「执行日空选 = 每天」与「全部账号」批量触发的**渲染**测试（2026-08-31 新增）。
 *
 * ## ③ 执行日：这条缺陷长什么样
 *
 * 库里的语义是「`weekdays` 为空 / 缺失 = 不做过滤 = 每天都跑」
 * （`lambda_inspection_scheduler` 只在非空时才比 `isoweekday()`）。
 * 而 UI 照着库里的值渲染：
 *
 * ```
 * 一个从没配过 weekdays 的账号
 *   → 七个 chip **全灭**
 *   → 旁边一行小字写「每天」
 * ⇒ 屏幕上说「一天都不跑」，小字说「天天跑」，两者矛盾，而正确的是小字
 * ```
 *
 * 而它的第二段更糟：客户一路点亮几个再点灭，回到零个 → 保存成 `undefined`
 * → **变成天天跑**，与他的意图完全相反，而七个 chip 在保存后又全亮回来。
 *
 * 🔴 **为什么不能用「查源码子串」代替**：`WEEKDAYS.map` / `wd.includes(d)`
 *    这些标识符改坏之后**还在文件里**。把 state 初值改回 `row.weekdays ?? []`
 *    是一个字符级的改动，源码断言抓不到，而屏幕上七个 chip 全灭。
 *    2026-08-31 实测：本文件的注入全部抓住。
 *
 * ## ② 「全部账号」：护栏就是那个二次确认屏
 *
 * 后端不做数量限制（`capabilities.json` 里 `action:inspection:run` 也没有
 * 账号维度的授权），所以「一次点击对 N 个账号各跑一轮 refetch、花的钱与时长
 * 乘 N、中途撤不回来」这三件事**只有这一屏会说**。
 * 少了它就是一个按钮点下去无声地花 N 倍的钱。
 *
 * ⚠️ 后端那侧（`*` 怎么展开、一次 invoke 还是 N 次）有 54 条断言钉在
 *    `bff/web-chat/tests/alias_and_batch_run.test.mjs`。本文件只管 UI 这一跳。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScheduleRow } from "./api/inspection";

vi.mock("./api/inspection", async (orig) => {
  const real = await orig<typeof import("./api/inspection")>();
  return {
    ...real,
    // ⚠️ 写侧必须 mock —— 不 mock 会走真的 `signedClient()`，jsdom 里拿不到
    //    凭证于是恒返回 not_authenticated：测试「通过」而什么都没验证到。
    putInspectionSchedule: vi.fn(),
    triggerInspectionRun: vi.fn(),
    getInspectionOverview: vi.fn(),
  };
});

const api = await import("./api/inspection");
const { STRINGS } = await import("./i18n");
const { ScheduleCard } = await import("./components/inspection/ConfigPage");

/**
 * 🔴 `t` 必须走**真的** STRINGS，不能用 `(k) => k`。
 *
 *    用恒等函数时 chip 上渲染的是 `insp.wd.1` 而不是「一」—— 于是
 *    「找那七个 chip」这一步就找不到，而更坏的情况是找得到但断言的是
 *    key 的存在而非真实标签：i18n key 缺失（`useT()` 找不到时原样返回 key）
 *    这类缺陷会整个漏掉。
 *
 * ⚠️ 缺失的 key **落回 key 本身**，与生产的 `useT()` 同行为 ——
 *    所以下面那几条「某个文案不该出现」的断言把 key 和文案都查一遍。
 */
const t = (k: string) => STRINGS[k]?.zh ?? k;

/* ⚠️ 用 `process.cwd()` 而不是 `fileURLToPath(import.meta.url)`：
   这个文件跑在 jsdom 环境里，`import.meta.url` 是 http:// 形态，
   `readFileSync` 直接抛 "The URL must be of scheme file"。
   （`inspection.test.ts` 用 import.meta.url 是可以的 —— 它跑在 node 环境。）
   vitest 的 cwd 是 `frontend/chat-app`。 */
const REPO = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

/** 中英都可能（i18n 跟随浏览器 locale）—— 两个都接受。 */
const WD_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const WD_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** 找七个执行日 chip 的 DOM 节点，按周一…周日的顺序返回。 */
function wdChips(): HTMLElement[] {
  return WD_ZH.map((zh, i) => {
    const el = screen.queryByText(zh) || screen.queryByText(WD_EN[i]);
    if (!el) throw new Error(`第 ${i + 1} 个执行日 chip 没渲染（${zh}/${WD_EN[i]}）`);
    // Chip 把文字放在 button 里 —— 取到那个可点击的祖先。
    return (el.closest("button") || el) as HTMLElement;
  });
}

/**
 * 一个 chip 是不是「亮着」。
 *
 * 🔴 判据是 `aria-pressed`，不是背景色。
 *
 *    第一版按 `style.background` 判 —— 那是把**主题的具体色值**写进测试：
 *    换一次配色方案这条就红，而功能一点没变。而 `aria-pressed` 是这个控件
 *    对外声明「我是不是选中态」的那一位，屏幕阅读器读的也是它 ——
 *    它错了才是真的用户可见缺陷。
 */
function lit(el: HTMLElement): boolean {
  return el.getAttribute("aria-pressed") === "true";
}

/**
 * 一条定时配置的 fixture。
 *
 * ⚠️ `...over` **必须展开**。第一版漏了它 —— 于是 `ROW({ weekdays: [1,3,5] })`
 *    和 `ROW({ persisted: false })` 全都退化成同一个默认行，而那几条断言的
 *    表现是「产品代码把所有情况都当成空 weekdays」。这类 fixture 缺陷比
 *    产品缺陷更难发现：测试红了，而红的原因在测试自己身上。
 */
const ROW = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  run_type: "high",
  enabled: true,
  at_utc: "02:00",
  weekdays: undefined,
  persisted: true,
  ...over,
} as unknown as ScheduleRow);

const noop = () => {};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════
// ③ 执行日
// ═══════════════════════════════════════════════════════════════════════════

describe("执行日：空 = 每天 → 七个 chip 全亮", () => {
  it("★★★ weekdays 缺失 → 七个 chip **全亮**（此前是全灭 + 一行「每天」小字）", () => {
    render(<ScheduleCard row={ROW({ weekdays: undefined })}
      mayWrite reload={noop} zh t={t} />);
    const chips = wdChips();
    expect(chips.length).toBe(7);
    const off = chips.filter((c) => !lit(c)).length;
    expect(off,
      `${off} 个 chip 是灭的 —— 库里「空 = 每天」，全灭的界面说的是`
      + "「一天都不跑」，与实际执行完全相反",
    ).toBe(0);
  });

  it("★★★ weekdays 是空数组 → 同样七个全亮（`[]` 与缺失在库里同义）", () => {
    render(<ScheduleCard row={ROW({ weekdays: [] })}
      mayWrite reload={noop} zh t={t} />);
    expect(wdChips().filter((c) => !lit(c)).length).toBe(0);
  });

  it("★★★ 「每天」那行小字**不再出现** —— 它与 chip 状态矛盾就是这条缺陷本身", () => {
    render(<ScheduleCard row={ROW({ weekdays: undefined })}
      mayWrite reload={noop} zh t={t} />);
    // 用 i18n key 当 t()，所以真出现了会渲染成这个 key 本身
    expect(screen.queryByText("insp.config.everyDay")).toBeNull();
    expect(screen.queryByText("每天")).toBeNull();
    expect(screen.queryByText("Every day")).toBeNull();
  });

  it("★★★ 反例：显式配了几天 → **只有那几天**亮（不能一律全亮）", () => {
    render(<ScheduleCard row={ROW({ weekdays: [1, 3, 5] })}
      mayWrite reload={noop} zh t={t} />);
    const chips = wdChips();
    // 索引 0/2/4 = 周一/三/五
    expect(chips.map(lit)).toEqual([true, false, true, false, true, false, false]);
  });
});

describe("执行日：保存时的换算", () => {
  it("★★★ 七天全选 → `weekdays` 传 **undefined**（库里仍是「没这个字段」）", async () => {
    vi.mocked(api.putInspectionSchedule).mockResolvedValue(
      { ok: true, next_run_utc: "2026-09-01T02:00Z" } as never);
    // `persisted: false` 让保存按钮在「没有改动」时也可点（既有语义）
    render(<ScheduleCard row={ROW({ weekdays: undefined, persisted: false })}
      mayWrite reload={noop} zh t={t} />);
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(api.putInspectionSchedule).toHaveBeenCalled());
    const [, body] = vi.mocked(api.putInspectionSchedule).mock.calls[0];
    expect(body.weekdays,
      "七天全选却落成 [1..7] —— 调度行为一样，但库里多一个「配过了」的显式值，"
      + "下一个人会以为这是客户刻意逐个勾出来的七天，不敢动",
    ).toBeUndefined();
  });

  it("★★★ 点灭一天 → 传剩下的六天（不是 undefined）", async () => {
    vi.mocked(api.putInspectionSchedule).mockResolvedValue(
      { ok: true, next_run_utc: "x" } as never);
    render(<ScheduleCard row={ROW({ weekdays: undefined })}
      mayWrite reload={noop} zh t={t} />);
    fireEvent.click(wdChips()[6]);           // 点灭周日
    fireEvent.click(screen.getByText("保存"));
    await waitFor(() => expect(api.putInspectionSchedule).toHaveBeenCalled());
    const [, body] = vi.mocked(api.putInspectionSchedule).mock.calls[0];
    expect(body.weekdays).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("★★★ 点灭最后一天被**拒**，并给出为什么", () => {
    render(<ScheduleCard row={ROW({ weekdays: [3] })}
      mayWrite reload={noop} zh t={t} />);
    const chips = wdChips();
    expect(chips[2] && lit(chips[2])).toBe(true);
    fireEvent.click(chips[2]);
    // 🔴 判据是**它还亮着** + 屏幕上出现了原因。
    //    静默忽略这次点击也「不会变成每天」，但客户会以为界面卡了，反复点。
    expect(lit(wdChips()[2]),
      "点灭了最后一天 —— 库里「空 = 每天」，保存后会变成天天跑，与意图相反",
    ).toBe(true);
    expect(screen.queryByText(/至少留一天/),
      "拒了但没说为什么 —— 客户只看到点了没反应",
    ).not.toBeNull();
  });

  it("★★ 「有未保存的改动」不能在打开页面时就为真", () => {
    // 🔴 `changed` 比的是**生效集合**。直接比 row.weekdays（undefined）
    //    与 wd（已展开成七天）会让保存按钮一直亮着、一直显示有改动，
    //    而用户什么都没动。
    render(<ScheduleCard row={ROW({ weekdays: undefined, persisted: true })}
      mayWrite reload={noop} zh t={t} />);
    const save = screen.getByText("保存").closest("button")!;
    expect(save.getAttribute("aria-disabled"),
      "刚打开就认为有改动 —— `changed` 没比生效集合",
    ).toBe("true");
  });
});

describe("执行日：只读态与可写态显示同一件事", () => {
  it("★★★ 没有写权限时，空 weekdays 也显示成七天而不是「每天」", () => {
    render(<ScheduleCard row={ROW({ weekdays: undefined })}
      mayWrite={false} reload={noop} zh t={t} />);
    // 🔴 两边分叉的表现是：有写权限的人和没写权限的人看同一个账号，
    //    看到的执行日不一样。
    //
    // ⚠️ 断**整串**而不是逐个字。逐个 `queryByText(/日/)` 会撞上字段标题
    //    「执行**日**」（testing-library 报 "Found multiple elements"）——
    //    那是我的判据有漏，不是产品问题。
    expect(screen.queryByText(WD_ZH.join(" ")),
      "只读态没把七天列出来 —— 与可写态分叉：有写权限的人看到七个亮着的 chip，"
      + "没写权限的人看到「每天」两个字",
    ).not.toBeNull();
    expect(screen.queryByText("insp.config.everyDay")).toBeNull();
    expect(screen.queryByText("每天")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 「全部账号」的二次确认
// ═══════════════════════════════════════════════════════════════════════════

describe("「全部账号」的护栏（i18n 文案层）", () => {
  /* ⚠️ 这一节查文案而不是渲染：**护栏的全部内容就是这一行字**，
        少一件事就是客户不知道自己在买什么。
        「弹层长什么样」那一跳由下面的源码断言守。 */
  it("★★★ 护栏一行里必须写全四件事：花什么钱 / 占槽位 / 撤不回来 / 会跳过", async () => {
    const { STRINGS } = await import("./i18n");
    const s = STRINGS["insp.run.costLine"];
    expect(s, "i18n key 不在了").toBeTruthy();
    expect(s.zh, "没说会真调 GetMetricData（这是按指标数计费的）")
      .toMatch(/GetMetricData/);
    expect(s.zh, "没说会派 AI 判读（按秒计费）").toMatch(/判读/);
    expect(s.zh, "没说撤不回来 —— 后端没有批量取消").toMatch(/撤不回来|取消/);
    expect(s.zh, "没说会占掉今天的巡检槽位").toMatch(/槽位/);
    // 今天已跑过的账号会被 run 锁静默跳过 —— 不说的话客户以为都重采了
    expect(s.zh, "没说今天已成功跑过的账号会被静默跳过").toMatch(/跳过/);
    for (const lang of ["zh", "en"] as const) {
      expect(s[lang], `${lang} 少了`).toBeTruthy();
    }
  });

  it("★★★ 护栏必须**是一行**，不许再长回去", async () => {
    /* 🔴 这条与上一条**成对**存在，缺一不可。
       上一版是五行 bullet 的确认屏，客户原话：「我点全部账号后又出来一大堆
       内容，絮絮叨叨贫死了。能不能别加这么多文字？不要再出现第二步和描述性
       的大段文字了。」—— 而一段没人读的说明等于没有护栏，它还挡住了下面的
       账号列表。

       只钉「四件事都在」的话，下一个人会用五行重新满足它；
       只钉「要短」的话，护栏会被一句「会花钱」糊过去。 */
    const { STRINGS } = await import("./i18n");
    const s = STRINGS["insp.run.costLine"];
    expect(s.zh, "护栏里有换行 —— 又变成多行说明了").not.toMatch(/\n/);
    expect(s.en).not.toMatch(/\n/);
    expect(s.zh.length, `护栏 ${s.zh.length} 字，超过 80 —— 压回一句话`)
      .toBeLessThanOrEqual(80);
    // 🔴 五行确认屏那两个 key 必须**真的没了**。留着它们的表现是有人把
    //    第二步又接回去，而上面那些断言查的是新 key，不会红。
    expect(STRINGS["insp.run.allConfirm"], "五行确认屏的文案又回来了")
      .toBeUndefined();
    expect(STRINGS["insp.run.allGo"], "「确认，跑 N 个账号」那一步又回来了")
      .toBeUndefined();
  });

  it("★★★ 「已提交」不能说成「跑完了」—— 这条路不轮询", async () => {
    const { STRINGS } = await import("./i18n");
    const s = STRINGS["insp.run.allSubmitted"];
    expect(s).toBeTruthy();
    expect(s.zh, "说成「跑完了」等于替后端做了一个我们没有证据的承诺")
      .not.toMatch(/跑完|完成了/);
    expect(s.zh, "没说清「这里不显示每个账号的结果」").toMatch(/不显示|不做轮询/);
    expect(s.zh, "没告诉客户下一步怎么看结果").toMatch(/刷新|单独/);
  });

  it("★★★ 哨兵两侧必须逐字一致（前端 `*` ↔ BFF ALL_ACCOUNTS）", async () => {
    const { ALL_ACCOUNTS_SENTINEL } = await import("./api/inspection");
    const bff = REPO("../../bff/web-chat/inspection.mjs");
    const m = /export const ALL_ACCOUNTS = "([^"]*)"/.exec(bff);
    expect(m, "BFF 那侧的 ALL_ACCOUNTS 不见了").not.toBeNull();
    // 🔴 分叉的表现：前端发 `account: "all"`，BFF 把它当成一个**账号号**去查，
    //    查不到 → 那一轮什么都没跑，而接口返回 accepted:true → 界面显示「已提交」。
    //    零错误、零日志。
    expect(ALL_ACCOUNTS_SENTINEL,
      `前端 "${ALL_ACCOUNTS_SENTINEL}" != BFF "${m![1]}" —— 那一轮什么都不会跑，`
      + "而界面显示「已提交」",
    ).toBe(m![1]);
  });
});

describe("「全部账号」在触发弹层里的接线（源码层）", () => {
  const src = () => REPO("src/components/InspectionDashboard.tsx");
  /** 剥掉注释。否定式断言必须用它 —— 本仓库踩过八次「断言命中自己的注释」。 */
  const stripped = () => src()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((ln) => ln.replace(/\/\/.*$/, "")).join("\n");

  /** 批量分支（多选 + 哨兵合并成的那一支）的函数体。 */
  const batchBranch = () => {
    const s = stripped();
    const i = s.indexOf(
      "if ((runList && runList.length > 0) || runAcct === ALL_ACCOUNTS_SENTINEL) {");
    expect(i, "批量分支不见了 —— 那就是走了单账号那套轮询").toBeGreaterThan(0);
    return s.slice(i, s.indexOf("\n    }\n", i));
  };

  it("★★★ 多选走一次请求带数组，不循环 POST", () => {
    /* 🔴 循环 N 次会产生**部分成功**：第 3 次失败时前两个已经在跑，而界面
       只能报一个结果 —— 要么谎报全失败（客户重试 → 前两个账号各跑两轮、
       花两倍的钱），要么谎报全成功。scheduler 那侧本来就按列表扇出。 */
    const b = batchBranch();
    expect(/accounts: runList/.test(b),
      "多选没走 accounts 数组 —— 大概是在前端循环 POST").toBe(true);
    expect(/for \(const .* of runList\)/.test(b),
      "多选在前端循环了 —— 会出现部分成功而界面只能报一个结果").toBe(false);
  });

  it("★★★ 勾一个走标量（要轮询），勾多个才走数组（不轮询）", () => {
    /* 单账号那条会抓基线 + 轮询，跑完弹绿条「跑完了」—— 那个确认是这个按钮
       最有价值的部分（客户点它就是因为不信看板上的数）。全部塞进数组等于
       把它一起丢掉。 */
    const s = stripped();
    const i = s.indexOf("const runGo = ");
    expect(i, "runGo 不见了").toBeGreaterThan(0);
    const fn = s.slice(i, s.indexOf("\n  };", i));
    expect(/list\.length === 1/.test(fn),
      "没有区分「勾一个」—— 单账号的轮询确认被丢掉了").toBe(true);
    expect(/doRun\(rt, list\[0\]\)/.test(fn)).toBe(true);
    expect(/doRun\(rt, "", list\)/.test(fn)).toBe(true);
    // 空选不许提交（按钮那侧是 disabledReason，这里守 handler 内的 guard ——
    // jsdom 里点 disabled 按钮不触发 handler，所以两道都要有）
    expect(/if \(list\.length === 0\) return;/.test(fn),
      "handler 里没有空选守卫").toBe(true);
  });

  it("★★★ 批量那条路**不轮询**（不抓 baseline、不起 setInterval）", () => {
    const branch = batchBranch();
    // 🔴 一个槽位盯不了 N 个账号：只盯第一个 → 它 5 秒后完成就报「跑完了」，
    //    另外 N-1 个还在跑。
    expect(/setInterval/.test(branch), "批量分支里起了轮询").toBe(false);
    expect(/getInspectionOverview/.test(branch), "批量分支里抓了单账号基线").toBe(false);
    expect(/phase: "submitted"/.test(branch),
      "批量分支没用 submitted 相位 —— 会落到 done（绿色 ✓「跑完了」）",
    ).toBe(true);
  });

  it("★★★ 哨兵 `\"*\"` 仍然落在不轮询那一支", () => {
    /* UI 不再产生 `"*"`（多选换掉了「全部账号」按钮），但 API 层还支持它
       （IM / 脚本用）。掉到单账号那套轮询里会去 poll 一个叫 `*` 的账号 ——
       那个请求永远不会显示完成，进度条卡在「巡检中…」直到超时。 */
    expect(/runAcct === ALL_ACCOUNTS_SENTINEL/.test(batchBranch())).toBe(true);
  });

  it("★★★ 报数用**后端回传的** account_ids，不用前端勾选数", () => {
    const branch = batchBranch();
    /* ⚠️ 断言查的是**那个 `{n}` 填进去的表达式**，不是「分支里有没有出现
       runList」—— 分支的 `if` 条件本身就含 `runList.length`，扫整段会误报。
       这类「否定式断言命中了别处的同名标识符」本仓库已经踩过多次。 */
    expect(/\.replace\("\{n\}", String\(\(r\.account_ids \|\| \[\]\)\.length\)\)/
      .test(branch), "报数没用后端回传的 account_ids").toBe(true);
    // 前端的勾选数与实际扇出可能差一个（部署账号可能也被登记进了成员表，
    // BFF 会去重）—— 报一个客户没法核对的数字就是撒谎。
    expect(/\.replace\("\{n\}", String\((runSel|runList|allTargetCount)/.test(branch),
      "提交后的报数用了前端勾选数 —— 与实际扇出的账号数可能不符",
    ).toBe(false);
  });

  it("★★★ 默认一个都不勾，且「执行」在空选时灰掉并说明原因", () => {
    const s = stripped();
    // 🔴 这个按钮是唯一会真花钱的入口。预先勾上一个等于替客户做了一个付费决定。
    expect(/useState<Set<string>>\(\(\) => new Set\(\)\)/.test(s),
      "runSel 有默认勾选项 —— 替客户预先做了一个付费决定").toBe(true);
    // 每次打开弹层都重置 —— 上次的勾选留着会让人不看列表就点「执行」
    expect(/setRunSel\(new Set\(\)\); setRunPick\(rt\)/.test(s),
      "打开弹层时没重置勾选").toBe(true);
    expect(/disabledReason=\{runSel\.size === 0/.test(s),
      "空选时「执行」没有灰掉 / 没说原因").toBe(true);
  });

  it("★★★ 没有第二步确认屏了", () => {
    /* 客户原话：「不要再出现第二步和描述性的大段文字了。」
       ⚠️ 判据是那个 state 不存在，而不是「文案变短了」—— 第二屏可以用别的
          文案重新长出来。 */
    const s = stripped();
    expect(/confirmAll/.test(s), "第二步确认屏又回来了").toBe(false);
  });

  it("★★★ `submitted` 相位显示成 warning 而不是 success（绿色 ✓）", () => {
    const s = stripped();
    expect(/phase === "timeout" \|\| runs\[rt\]\.phase === "submitted"\)\s*\n?\s*\? "warning"/
      .test(s),
    "submitted 落到了 success —— 绿色 ✓「已提交」读起来就是「跑完了」，"
    + "而我们对每个账号跑成没跑成一无所知",
    ).toBe(true);
  });
});
