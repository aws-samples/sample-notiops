/**
 * 闲置轮不显示「AI 判读」+ 「深入分析」必须带账号（2026-08-31 新增）。
 *
 * 两条都来自同一次实机会话，而且**互相依赖** —— 所以钉在同一个文件里：
 * 删掉闲置轮的 AI 判读块之后，「深入分析」就成了闲置资源**唯一**的深挖入口。
 * 入口带错账号 = 那个入口是坏的。
 *
 * ## ① 闲置轮不做 AI 判读
 *
 * ```
 * gating.py:48   DETERMINISTIC_RUN_TYPES = frozenset({"idle"})
 *        :601    run_type in DETERMINISTIC_RUN_TYPES
 *                  → Decision(dispatch=False, reason=DETERMINISTIC, conclusion=…)
 * ```
 *
 * 而 UI 原来对它显示的是三句**主动的错误陈述**：
 *
 * ```
 * 卡片   琥珀色「判读缺失」                    → 看起来像故障
 * 抽屉   「这条还没有 AI 判读」                → 「还没」暗示会来，而永远不会
 *        「判读是异步回来的（通常 1~3 分钟）」  → 让人去等
 *        「看『派发缺口』，>0 意味着永久回不来」 → 闲置轮从没派过，那个数**恒为 0**
 *                                              ⇒ 客户查完得出「派发正常，还在路上」
 * 顶部   「另有 16 项未做根因分析」             → 「我们没分析」，而真相是「不需要」
 * ```
 *
 * 用户原话：「到底有没有AI判读？」—— 也就是说这套显示确实产生了真实的误判。
 *
 * 🔴 判据一律带 **`kind === "idle"` 兜底**，不只看 `skip_reason` / `conclusion`。
 *    只看那两个字段的话，**升级前写下的行**（DDB 里两个字段都没有）照样落进
 *    「判读缺失」，客户升级后打开看板看到的还是一屏橙字，要等下一轮 official
 *    才好。而 `kind` 是列表本来就有的字段。
 *
 * ⚠️ 反例同样重要：高负载与配置检查那两类**必须**保留完整的三态
 *    （在等 / 真缺 / 有结论）。R12.4：「判读没回来」与「DA 说没问题」长得一样
 *    是最坏的结果。本文件对那两类各有一条反向断言。
 *
 * ## ② 深入分析必须带账号
 *
 * ```
 * 点的 finding   notiops-tb-mc-ap-northeast-1 · 111122223333
 * 聊天页顶部     Management account · 444455556666
 * ⇒ DA 在 698 里分析了 698 的**同名**资源，给出一份看起来完全正常的报告
 *   零错误码、零提示（testbed 两个账号资源同名，这是最坏的形态）
 * ```
 *
 * 根因：`onInvestigate` 的签名是 `(query: string) => void`，压根没有账号参数；
 * 宿主 `startFromNotification` 于是走 `inheritedAccount`（聊天页选择器）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FindingRow, FindingsData, OverviewData } from "./api/inspection";

vi.mock("./api/inspection", async (orig) => {
  const real = await orig<typeof import("./api/inspection")>();
  return {
    ...real,
    getInspectionOverview: vi.fn(),
    getInspectionFindings: vi.fn(),
    getInspectionFinding: vi.fn(),
    getInspectionScope: vi.fn(),
    getInspectionConfig: vi.fn(),
    // 写侧也 mock —— 不 mock 会走真 `signedClient()`，jsdom 拿不到凭证于是
    // 恒返回 not_authenticated：测试「通过」而什么都没验证到。
    triggerInspectionRun: vi.fn(),
    judgeInspectionFinding: vi.fn(),
    putInspectionExclusion: vi.fn(),
  };
});

/* ⚠️ 用 `process.cwd()` 而不是 `fileURLToPath(import.meta.url)`：这个文件跑在
   jsdom 环境里，`import.meta.url` 是 http:// 形态，`readFileSync` 会抛
   "The URL must be of scheme file"。vitest 的 cwd 是 `frontend/chat-app`。 */
const REPO = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

const api = await import("./api/inspection");
const { default: InspectionDashboard } = await import("./components/InspectionDashboard");
const { default: InspectionDashboardPanel } = await import("./components/InspectionDashboardPanel");

/**
 * 一条**闲置** finding。
 *
 * ⚠️ 字段清单抄的是 `inspection.render.test.tsx::findingsWith` 那份 ——
 *    组件会对 `idle_score` / `observed_value` 这类字段直接 `.toFixed()`，
 *    少一个就是 `Cannot read properties of undefined`，而报错发生在
 *    `<TriagePage>` 里、被 React 吞成一句 "An error occurred"，
 *    看起来像产品坏了。第一版我自己手写了一份精简 fixture，13 条全红。
 *
 * ⚠️ 默认刻意**不带** `conclusion` / `skip_reason` —— 那正是升级前写下的
 *    存量行的形态，也是实机上那 16 条的形态（`kind` 兜底就是为它们而加）。
 */
const IDLE = (over: Record<string, unknown> = {}): FindingRow => ({
  finding_id: "444455556666#us-west-2#elasticache#notiops-tb-redis-us-west-2-001#idle#composite",
  account_id: "444455556666", region: "us-west-2", service: "elasticache",
  instance_class: "cache.t4g.micro",
  instance: "notiops-tb-redis-us-west-2-001", metric: "",
  rule: "idle", kind: "idle",
  observed_value: null, threshold_value: null, headroom: null,
  unit: "", direction: "DOWN", raw_value: null, denominator: null,
  savings_usd: 15, savings_precision: "class_keyword",
  evidence_as_of: "2026-08-31",
  idle_score: 99.3, idle_weight_avail: 1,
  idle_degraded: [], idle_factors: [],
  state: "new", severity: "INFO",
  first_seen_date: "2026-08-31", last_run_date: "2026-08-31",
  days_active: 1, rule_version: "2026-08-31T02:09:52.670805+00:00",
  consecutive_hits: 1, consecutive_misses: 0, was_confirmed: false,
  da_verdict: "", da_parse_status: "",
  da_task_id: "", da_report_md_key: "", has_judgment: false,
  ...over,
} as unknown as FindingRow);

/** 一条**高负载** finding —— 反例用（那一类真的可能有可能没有判读）。 */
const HIGH = (over: Record<string, unknown> = {}): FindingRow => IDLE({
  finding_id: "444455556666#ap-northeast-1#rds#notiops-tb-rds-prod#threshold_high#cpu_utilization",
  region: "ap-northeast-1", service: "rds", instance: "notiops-tb-rds-prod",
  instance_class: "db.t4g.micro",
  rule: "threshold_high", kind: "high_load", metric: "cpu_utilization",
  observed_value: 85.3, threshold_value: 70, headroom: -0.19, unit: "%",
  savings_usd: null, savings_precision: "",
  idle_score: null, idle_weight_avail: null,
  severity: "CRITICAL", state: "active",
  ...over,
});

const FINDINGS = (rows: FindingRow[]): FindingsData => ({
  ok: true,
  run_date: "2026-08-31", run_status: "success", mode: "official",
  total: rows.length, truncated: false,
  by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, INFO: rows.length },
  without_judgment: 0, unclassified: 0,
  last_run: {
    run_date: "2026-08-31", status: "success", completeness: 1, mode: "official",
  },
  findings: rows,
} as unknown as FindingsData);

const OVERVIEW = {
  ok: true, diff: {}, dispatch_gap: 0, runs: [],
} as unknown as OverviewData;

beforeEach(() => {
  vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
  vi.mocked(api.getInspectionFinding).mockResolvedValue(
    { ok: false, code: "not_found" } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// ── 交互 helper（2026-09-01 改交互模型后加）─────────────────────────────────
//
// 🔴 卡片上原来有 `[详情] [移出巡检范围] [深入分析]` 三个按钮，全部删了：
//    「详情」是整卡点击的纯重复（客户原话：「整个 side panel 都已经
//    clickable，详情 button 的意义是什么？」），另两个与抽屉 footer 重复。
//    ⇒ 开抽屉 = 点卡片本身；判读 = 只在抽屉 footer 里。
//
// ⚠️ 这两个 helper 存在的意义是**让交互模型只写一遍**。上一版每条用例各写
//    `getByText("详情")`，于是这次改动一次打红 16 条 —— 而它们守的东西
//    一条都没变。

/** 打开某条 finding 的详情抽屉。整卡可点，所以点实例名所在的那张卡。 */
function openDrawer(instanceLike: RegExp | string) {
  const el = screen.getByText(instanceLike);
  const card = el.closest('[data-finding-id]');
  expect(card, `找不到 ${instanceLike} 所在的卡片`).not.toBeNull();
  fireEvent.click(card!);
}

/** 抽屉 footer 里那个「深入分析」。**只有那一处**，所以不再需要取 last。 */
function judgeBtn() {
  return screen.queryByText(/深入分析/) || screen.queryByText(/Investigate/);
}

/**
 * 确认弹窗那个 dialog。
 *
 * ⚠️ **按内容找，不按 DOM 顺序猜。** 抽屉也是 `role="dialog"`，而两者在
 * `InspectionDashboard` 里的渲染顺序不是这套用例该依赖的东西
 * （`at(-1)` 曾经拿到抽屉，然后在里面找不到「派发判读」）。
 * 判据用「里面有派发按钮」——那是弹窗的定义性特征。
 */
function judgeModalEl(): HTMLElement | null {
  return [...document.querySelectorAll('[role="dialog"]')].find((d) =>
    [...d.querySelectorAll("button")].some(
      (b) => /派发判读|Dispatch review/.test(b.textContent || ""))) as
    HTMLElement | null ?? null;
}

/**
 * 页头那个「刷新」按钮。
 *
 * ⚠️ **按 role 找，不用 `getByText`。** 按钮带 `iconLeft="⟳"`，所以它的
 * `textContent` 是 `⟳刷新` —— `/^刷新$/` 匹配不到（踩过一次）。
 */
function refreshBtn(): HTMLButtonElement | undefined {
  return [...screen.queryAllByRole("button")].find(
    (b) => /刷新|Refresh/.test(b.textContent || "")) as
    HTMLButtonElement | undefined;
}

/** 弹窗里那个按钮（`派发判读` / `取消`）。 */
function inModal(re: RegExp): HTMLButtonElement | undefined {
  const dlg = judgeModalEl();
  return [...(dlg?.querySelectorAll("button") ?? [])]
    .find((b) => re.test(b.textContent || "")) as HTMLButtonElement | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 闲置轮：不显示 AI 判读相关的任何东西
// ═══════════════════════════════════════════════════════════════════════════

describe("闲置轮的卡片不显示「判读缺失」", () => {
  it("★★★ 存量行（无 conclusion / 无 skip_reason）也不显示 —— kind 兜底", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis-us-west-2-001/)).not.toBeNull();
    });
    expect(screen.queryByText(/判读缺失/),
      "闲置 finding 上挂了「判读缺失」—— 闲置轮设计上不派 DA，"
      + "这句话让客户以为系统坏了（实机 16 条全是这样）",
    ).toBeNull();
    expect(screen.queryByText(/Analysis missing/)).toBeNull();
  });

  it("★★★ 也不显示「规则结论 ⓘ」那个空标记（对这一条没有可操作信息）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE({ skip_reason: "deterministic" } as Partial<FindingRow>)]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    // 「规则结论」这四个字只应该在**有结论文本**时出现（下一条）
    expect(screen.queryByText(/规则结论 ⓘ/)).toBeNull();
  });

  it("★★★ 反例：有确定性结论**文本**时要显示它（那是真信息）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([
      IDLE({ conclusion: "闲置判定：六维加权评分明细见本条详情。" } as Partial<FindingRow>),
    ]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/六维加权评分明细/),
        "有 conclusion 文本却不显示 —— 那是唯一说明「凭什么判它闲」的话",
      ).not.toBeNull();
    });
  });

  it("★★★ **配置检查**页的存量行同样不该显示 —— 兜底不能只覆盖 idle", async () => {
    // 🔴 2026-08-31 发现的对称缺口：兜底判据只写了 `kind === "idle"`，
    //    而配置检查页的**全部**条目都是确定性的（7 条纯属性走闲置轮的
    //    DETERMINISTIC，2 条盲区通知走 PLAYBOOK）。升级前写下的行既没有
    //    conclusion 也没有 skip_reason ⇒ 整页每条挂一个琥珀「判读缺失」。
    const STRUCT = IDLE({
      finding_id: "444455556666#ap-northeast-1#rds#notiops-tb-pg#gp2_volume#-",
      region: "ap-northeast-1", service: "rds", instance: "notiops-tb-pg",
      rule: "gp2_volume", kind: "structural", metric: "",
      savings_usd: null, savings_precision: "",
      idle_score: null, idle_weight_avail: null,
      severity: "MEDIUM", state: "active",
    } as Partial<FindingRow>);
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([STRUCT]));
    render(<InspectionDashboard dashboardId="structural" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-pg/)).not.toBeNull();
    });
    expect(screen.queryByText(/判读缺失/),
      "结构性 finding 上挂了「判读缺失」—— 那一页的条目结构上都不派 DA，"
      + "整页假告警",
    ).toBeNull();
    expect(screen.queryByText(/Analysis missing/)).toBeNull();
  });

  it("★★★ 反例：**高负载**轮真的缺判读时**必须**显示「判读缺失」", async () => {
    // 🔴 这条守的是「不能把兜底放宽到所有 kind」。高负载那一类是真的可能有
    //    可能没有，两态混淆正是 R12.4 要防的最坏结果。
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([HIGH({ skip_reason: "quota" } as Partial<FindingRow>)]));
    render(<InspectionDashboard dashboardId="high-load" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-rds-prod/)).not.toBeNull();
    });
    expect(screen.queryByText(/判读缺失/) || screen.queryByText(/Analysis missing/),
      "高负载 finding 因额度没判读，却不标出来 —— 「没判」与「判了说没问题」"
      + "长得一样（R12.4）",
    ).not.toBeNull();
  });
});

describe("「闲置与成本」页在页面级说清「不派 AI」", () => {
  it("★★★ 副标题里必须有这句 —— 16 条上各说一遍是噪音，一次都不说是困惑", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      const hit = screen.queryByText(/规则判定，不派 AI 判读/)
        || screen.queryByText(/Rule-based, no AI analysis/);
      expect(hit,
        "页面上一处都没说闲置轮不派 AI —— 客户会去每条上找判读，找不到就问"
        + "「到底有没有 AI 判读」（实机原话）",
      ).not.toBeNull();
    });
  });
});

describe("闲置轮的详情抽屉：AI 判读整节不渲染", () => {
  const open = (row: FindingRow) => render(
    <InspectionDashboardPanel row={row}
      onClose={() => {}} />);

  it("★★★ 「AI 判读」这个小节标题**不出现**", () => {
    open(IDLE());
    expect(screen.queryByText("AI 判读"),
      "闲置轮抽屉里还有「AI 判读」小节 —— 它下面只能是错的话（「还没」/「等 1~3 分钟」）",
    ).toBeNull();
    expect(screen.queryByText("AI analysis")).toBeNull();
  });

  it("★★★ 那三句错话一个字都不许出现", () => {
    open(IDLE());
    for (const bad of [/还没有 AI 判读/, /异步回来的/, /1~3 分钟/, /派发缺口/]) {
      expect(screen.queryByText(bad),
        `抽屉里还有「${bad}」—— 判读不会来（不是「还没」），`
        + "而闲置轮从没派发过、那个「派发缺口」恒为 0，客户照着查会得出"
        + "「派发正常，那就是还在路上」然后一直等",
      ).toBeNull();
    }
  });

  it("★★★ 也不发那个注定失败的详情请求（就是「读取失败: not_found」的来源）", async () => {
    open(IDLE());
    // 🔴 断「没调」而不只断「没显示红字」：删掉那一块之后红字确实不显示了，
    //    但请求还在打 —— 每打开一条闲置 finding 一次注定失败的往返 +
    //    一条服务端错误日志。
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(api.getInspectionFinding),
      "闲置行还在请求 finding 详情 —— 前端按 da_task_id 查 invst# 行，"
      + "而闲置轮从没派过 DA，必然 not_found",
    ).not.toHaveBeenCalled();
    expect(screen.queryByText(/读取失败/)).toBeNull();
  });

  it("★★★ 评分明细**要留着** —— 它才是闲置轮的结论", () => {
    /* ⚠️ `IdleFactor` 的字段是 name/weight/normalized/points/basis/observed
       （见 `api/inspection.ts`）。我第一版按印象写了 dim/value/score ——
       组件对 `points.toFixed()` 当场抛，而报错被 React 吞成一句
       "An error occurred in <TriagePage>"，看起来像产品坏了。 */
    open(IDLE({
      idle_factors: [{
        name: "cpu", weight: 0.35, normalized: 0.997, points: 34.9,
        basis: "percent", observed: 0.25,
      }],
    }));
    // 删 AI 判读那一节时把这一节一起删掉的话，抽屉里就只剩 KV 网格了
    expect(screen.queryByText(/闲置评分明细/) || screen.queryByText(/Idle score/),
      "评分明细没了 —— 那是「凭什么说它闲」的完整回答，删了抽屉就没有结论",
    ).not.toBeNull();
  });

  it("★★★ 反例：**高负载**的抽屉照旧有「AI 判读」小节", async () => {
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "", da_updated_at: 0 } as never);
    open(HIGH());
    await waitFor(() => {
      expect(screen.queryByText("AI 判读") || screen.queryByText("AI analysis"),
        "把整节对所有 kind 都删掉了 —— 高负载那一类是真的可能有可能没有，"
        + "两态必须能区分（R12.4）",
      ).not.toBeNull();
    });
    expect(vi.mocked(api.getInspectionFinding),
      "高负载也不请求详情了 —— 那条路的判读全文就取不到了",
    ).toHaveBeenCalled();
    /**
     * 🔴 **内容也要断**，不能只断标题。
     *
     *    2026-08-31 反向注入实测：把内容那个 div 的条件单独改成 `false`
     *    （标题保留）之后，这条断言照样绿 —— 而那正是最坏的形态：
     *    高负载 finding 上有一个「AI 判读」标题，底下**什么都没有**，
     *    「判读没回来」与「DA 说没问题」于是长得一模一样（R12.4）。
     *
     *    `getInspectionFinding` 被 mock 成 `da_body: ""` ⇒ 走 else 分支
     *    ⇒ 屏幕上该出现那段「这条还没有 AI 判读」。它是**这一类**的正确文案。
     */
    await waitFor(() => {
      /* ⚠️ 文案改过两次，断言跟着改 —— 但**必须还有一句**，整个空态被删掉
         才是 R12.4 要防的。
         2026-09-01：「这条还没有 AI 判读」→「还没有判读结果」（客户：「太繁琐」）
         2026-09-02：这个 fixture（`da_task_id: ""` + 无正文 + 无 conclusion
                     + kind=high_load）在七档判据下是 `missing`，也就是
                     「本该判却没判」，文案是「判读缺失」+ 去哪儿看的指引。
                     笼统的「还没有判读结果」被拆散了：它此前同时兜着
                     pending / failed / rule / missing 四种状态，
                     而这四种的处置动作两两不同。 */
      expect(screen.queryByText(/判读缺失/)
        || screen.queryByText(/Analysis missing/),
      "「AI 判读」标题在，但底下是空的 —— 「判读没回来」与「DA 说没问题」"
      + "长得一样，这是 R12.4 明文要防的最坏结果",
      ).not.toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ② 深入分析必须带账号
// ═══════════════════════════════════════════════════════════════════════════

describe("「深入分析」= 派一次真的 DA 判读（不是跳聊天）", () => {
  /**
   * 🔴 **本节的不变量在 2026-08-31 换过一次。**
   *
   *    上一版钉的是「`onInvestigate` 把 `f.account_id` 传下去」——
   *    那修的是「跳聊天页」那条路上的账号丢失。而客户看完之后说：
   *
   *    > 现在的做法似乎没有用到任何 skill，连触发的账号也是错的，
   *    > 而且也不是触发的 DA 调查，而是 AI 分析。
   *
   *    于是那条路整个换掉了：不再跳聊天，改成走 executor →
   *    用写好的判读 skill → 真调 DA → 结果绑回这条 finding。
   *    「账号传对了」不再是一个需要单独钉的不变量 —— 判读用的是
   *    `f.account_id`，而那是**同一个函数调用里**读的字段，不跨组件传递。
   *
   *    现在钉的是四条新的：
   *
   *    ```
   *    ① 点了走 judgeInspectionFinding，而**不是**开聊天会话
   *    ② 账号用 f.account_id（跨账号列表里不能用页面选择器的值）
   *    ③ 已派过（da_task_id 非空）→ 按钮**不渲染**
   *    ④ 失败时原样显示后端的话（already_dispatched 那句是可操作的）
   *    ```
   */
  const MEMBER = "111122223333";

  /**
   * 点「深入分析」→ **在弹窗里确认** → 才真的派。
   *
   * ⚠️ 2026-08-31 中间多了一层确认弹窗（客户指出备注框离按钮 350px）。
   *    这个 helper 把两步包起来 —— 但下面「点了不直接派」那一条**刻意不用它**，
   *    否则那条断言就测不到中间这一步了。
   */
  const clickInvestigate = async () => {
    // 🔴 判读按钮只在**抽屉 footer** 里（卡片上那个 2026-09-01 删了），
    //    所以先开抽屉。
    if (!judgeBtn()) openDrawer(/notiops-tb-/);
    const btn = judgeBtn();
    expect(btn, "「深入分析」按钮没渲染").not.toBeNull();
    fireEvent.click(btn!);
    const dlg = await waitFor(() => {
      const d = document.querySelector('[role="dialog"]');
      expect(d, "点了「深入分析」没开确认弹窗").not.toBeNull();
      return d!;
    });
    fireEvent.click([...dlg.querySelectorAll("button")]
      .find((b) => /派发判读|Dispatch review/.test(b.textContent || ""))!);
  };

  it("★★★ 点了调 judgeInspectionFinding，用 finding 自己的账号", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE({ account_id: MEMBER })]));
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue(
      { ok: true, task_id: "t-1", agent_space_id: "sp-1" } as never);
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    await clickInvestigate();
    await waitFor(() => {
      expect(vi.mocked(api.judgeInspectionFinding)).toHaveBeenCalled();
    });
    const arg = vi.mocked(api.judgeInspectionFinding).mock.calls[0][0];
    expect(arg.account,
      "判读派到了别的账号 —— 统一视图下列表是跨账号的，"
      + "用页面选择器的值会让 677 那条 finding 的判读派到 698 去",
    ).toBe(MEMBER);
    expect(arg.finding_id).toBe(IDLE().finding_id);
  });

  it("★★★ **不再**跳聊天页（那条路不调 DA、不用 skill）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE({ account_id: MEMBER })]));
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue(
      { ok: true, task_id: "t-1", agent_space_id: "sp-1" } as never);
    // 🔴 判据：`InspectionDashboard` 的 Props 里**没有** onInvestigate。
    //    有它就意味着还留着「跳聊天」那条路 —— 而两个长得一样的入口做两件
    //    不同的事，正是这一版之前那个缺陷的原始形态。
    const src = REPO("src/components/InspectionDashboard.tsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l: string) => l.replace(/\/\/.*$/, "")).join("\n");
    /* ⚠️ 判据要同时覆盖**类型声明**与**解构形参**。
       2026-08-31 反向注入实测：只查 `onInvestigate?:` 时，把它加进解构
       （`…, can, onInvestigate,`）照样绿 —— 而那就足以让「跳聊天」那条路
       复活（TS 会因为未使用报错，但把它用起来就不报了）。 */
    expect(/onInvestigate/.test(src),
      "InspectionDashboard 里又出现了 onInvestigate —— 「跳聊天」那条路"
      + "（不调 DA、不用 skill、账号继承聊天页选择器）没清掉",
    ).toBe(false);
  });

  it("★★★ 已派过（da_task_id 非空）→ 按钮**不渲染**", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE({ da_task_id: "t-old" })]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    expect(judgeBtn(),
      "已派过还渲染按钮 —— 重复派发会重复烧 DA 额度，"
      + "而两份判读回填到同一行只会互相覆盖",
    ).toBeNull();
  });

  it("★★★ 没有 action:inspection:run 权限 → 按钮不渲染（而不是灰掉）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    // 只给看，不给跑
    render(<InspectionDashboard dashboardId="idle"
      can={(k) => k !== "action:inspection:run"} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    expect(judgeBtn(),
      "没权限却渲染了按钮 —— 点了拿 403，而灰着/摆着都是"
      + "「在界面上摆一个用户无法解决的问题」",
    ).toBeNull();
  });

  it("★★★ 失败时**原样**显示后端的话（那句是可操作的）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue({
      ok: false, code: "already_dispatched",
      message: "这条已经派过判读了（task t-old）。等它回来，或去 DevOps Agent 后台看进度",
    } as never);
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    await clickInvestigate();
    await waitFor(() => {
      expect(screen.queryByText(/已经派过判读了/),
        "把后端那句可操作的话换成了一句「派发失败」—— "
        + "客户看不出是「已经派过」还是真故障",
      ).not.toBeNull();
    });
  });

  it("★★★ already_dispatched 之后也要重取（否则按钮永远还在）", async () => {
    /* 🔴 不重取是个闭环：本地 `da_task_id` 空 → 按钮可点 → 点 → 后端拒
       `already_dispatched` → 本地仍然空 → 还可点 → …

       「按钮还亮着」这件事本身就是本地数据过期的证据 —— 后端说它已经有
       task 了。客户能做的只有手动刷新，而提示条里那句话（后端原文）
       没说要刷新。

       ⚠️ 其它失败码不能这样处理：`kill_switch` / `conflict` / `not_found` /
          `http_403` 都是「真的没派」，记乐观状态会让按钮永久消失。 */
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue({
      ok: false, code: "already_dispatched",
      message: "这条已经派过判读了（task t-old）",
    } as never);
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    const before = vi.mocked(api.getInspectionFindings).mock.calls.length;
    await clickInvestigate();
    await waitFor(() => {
      expect(vi.mocked(api.getInspectionFindings).mock.calls.length,
        "already_dispatched 之后没重取 —— 按钮还亮着，客户会一直点下去",
      ).toBeGreaterThan(before);
    });
  });

  it("★★★ 真失败（kill_switch）**不**记乐观状态 —— 重试入口要留着", async () => {
    /* 反例：`already_dispatched` 那条的修法不能溢出到其它失败码上。
       `kill_switch` 是「真的没派」，把按钮乐观地藏掉等于客户打开开关之后
       连重试的入口都找不到。 */
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue({
      ok: false, code: "kill_switch", message: "巡检被拉停了",
    } as never);
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    await clickInvestigate();
    await waitFor(() => {
      expect(screen.queryByText(/巡检被拉停了/)).not.toBeNull();
    });
    /* 抽屉还开着（派发只从抽屉发起），「深入分析」按钮必须还在。 */
    expect(screen.queryByText(/深入分析|Investigate/),
      "真失败之后按钮被乐观状态藏掉了 —— 客户打开开关也没法重试",
    ).not.toBeNull();
  });

  it("★★★ 成功后提示里带 task id，并触发重取（否则按钮还在）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue(
      { ok: true, task_id: "t-fresh-1", agent_space_id: "sp" } as never);
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    const before = vi.mocked(api.getInspectionFindings).mock.calls.length;
    await clickInvestigate();
    await waitFor(() => {
      expect(screen.queryByText(/t-fresh-1/), "提示里没有 task id").not.toBeNull();
    });
    // 🔴 必须重取：`da_task_id` 落在 finding 行上，不重取的话按钮还在，
    //    客户会再点一次，然后拿到 already_dispatched，以为是失败。
    await waitFor(() => {
      expect(vi.mocked(api.getInspectionFindings).mock.calls.length,
        "派发成功后没有重取列表 —— 按钮还在，客户会再点一次",
      ).toBeGreaterThan(before);
    });
  });
});

describe("宿主 ChatApp 不再给巡检传 onInvestigate", () => {
  /* 🔴 上一版这一节钉的是「ChatApp 把 opts.accountId 传进
     startFromNotification」。那条路 2026-08-31 整个删了 —— 判读不落在聊天
     会话里，所以宿主不需要给回调。

     现在钉反过来：**不许把它加回来**。加回来意味着又有了「跳聊天」那条
     不调 DA、不用 skill 的路，而两个入口长得一样。 */
  const stripped = () => REPO("src/pages/ChatApp.tsx")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l: string) => l.replace(/\/\/.*$/, "")).join("\n");

  it("★★★ ChatApp 不再给 InspectionDashboardBrowser 传 onInvestigate", () => {
    const s = stripped();
    const i = s.indexOf("<InspectionDashboardBrowser");
    expect(i, "找不到那个组件的渲染点 —— 这条断言的前提坏了").toBeGreaterThan(0);
    /* ⚠️ 用**下一个组件标签**当右界，不用 `indexOf("/>")`。
       后者在剥注释之后仍会命中 JSX 里更早出现的自闭合标签，
       于是这个块被截得太短 —— 加回来的 prop 落在块外，断言照样绿
       （2026-08-31 反向注入实测）。 */
    const rest = s.slice(i + 1);
    const nextTag = rest.search(/<[A-Z]/);
    const block = nextTag > 0 ? rest.slice(0, nextTag) : rest;
    expect(/onInvestigate/.test(block),
      "又给巡检传 onInvestigate 了 —— 那条路不调 DA、不用 skill，"
      + "而且账号继承聊天页选择器（与点的那条 finding 无关）。"
      + `块内容：${block.slice(0, 300)}`,
    ).toBe(false);
  });

  it("★★ 别的看板照旧传（那几条路是真的要跳聊天）", () => {
    // 反例：不能把 onInvestigate 从整个 ChatApp 里清掉 ——
    // Investigation / Security / FinOps 那几个看板的「调查」就是要开会话。
    expect(/onInvestigate=/.test(stripped()),
      "把所有看板的 onInvestigate 都删了 —— 别的看板要靠它开会话",
    ).toBe(true);
  });
});


describe("判读的三处细节（反向注入补的）", () => {
  const MEMBER = "111122223333";

  it("★★★ 备注提示必须写清「它是背景不是指令」", async () => {
    /* 🔴 不写的话客户会输入「这台没问题别报了」，而严重度是判定层的事。
       skill 那侧有第 6 条硬边界兜着（把它当**待核实的主张**），
       但界面上也要先说 —— 否则客户以为写了就能关掉这条 finding，
       结果报告里 AI 照样报，他会认为「填了没用」。 */
    const { STRINGS } = await import("./i18n");
    const h = STRINGS["insp.judge.noteHint"];
    expect(h, "i18n key 不在了").toBeTruthy();
    expect(h.zh, "没说清它不是指令").toMatch(/不是指令|背景/);
    expect(h.zh, "没说清它不会改变严重度 / 不会让 finding 消失")
      .toMatch(/严重度|消失/);
    expect(h.en.toLowerCase()).toMatch(/context, not an instruction/);
  });

  it("★★★ 等待态只出现一次，抽屉宽度不许缩回去", async () => {
    /* 客户截图里这一屏是（2026-09-01）：

       ```
       ⚠ 判读已派发，1~3 分钟后回来。点右上角「刷新」查看。
         task: 93c22b0c-…
       AI 判读
       ○ 这条还没有 AI 判读
         判读是异步回来的（通常 1~3 分钟）。如果一直没有，回到「高负载」
         页底部展开「系统状态」看「派发缺口」——那个数 >0 意味着…
         task: 93c22b0c-…
       ```

       同一件事两遍、task id 两次、外加三行排障指引 —— 而这是刚派发 10 秒的
       **正常等待态**。客户原话：「这一大堆太繁琐了。我希望简洁、干净、精准
       的 UI。」 独立的琥珀块删了，并进「AI 判读」一节。 */
    const { default: Panel } = await import("./components/InspectionDashboardPanel");
    const { STRINGS } = await import("./i18n");
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "" } as never);
    render(<Panel row={IDLE({ da_task_id: "t-dup-1" })} onClose={() => {}} />);

    await waitFor(() => expect(
      screen.getAllByText(STRINGS["insp.judge.dispatched"].zh).length).toBe(1));
    // task id 只出现一次（原来琥珀块与空态 Alert 各一次）
    expect(screen.getAllByText(/t-dup-1/).length, "task id 出现了多次").toBe(1);
    // 等待态里**不给**排障指引：那是给「永久回不来」准备的，不是给刚派发 10 秒的
    expect(screen.queryByText(/派发缺口/),
      "对一个刚派发的判读说「如果一直没有就去查缺口」是吓唬人").toBeNull();
    expect(screen.queryByText(/还没有判读结果/),
      "等待态与「没派过」的空态同时出现了 —— 同一件事说两遍").toBeNull();

    // 🔴 宽度钉住（客户要求「更宽一些」）。判读正文里常有 GFM 表格。
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dlg.style.maxWidth, "抽屉宽度缩回去了").toBe("680px");
  });

  it("★★★ 详情面板读判读全文用**这条 finding 的**账号，不是页面选中的", async () => {
    /* 🔴 客户实测（2026-09-01）：刚点「深入分析」派发成功，抽屉里的
       「AI 判读」立刻红字「读取失败：not_found」—— 看起来像判读失败了，
       而实际那条判读正在跑（DDB 里 `da_task_id` 已经写上了）。

       根因：详情端点的主键是 `PK=inspfind#<账号>` + `SK=<finding_id>`，
       而 finding 列表是**跨账号**取的（`getInspectionFindings(kind)` 不传账号）。
       面板原来拿的是**页面选中的账号**：

       ```
       卡片上那条属于 111122223333，页面选中管理账号 444455556666
         → 查 PK=inspfind#444455556666 + SK=111122223333#…#idle#-
         → PK 与 SK 里的账号对不上 → 必然 not_found
       ```

       ⚠️ 断言查的是**发出去的账号参数**，不是「界面上有没有报错」——
          后者在 mock 返回成功时永远是绿的，抓不到传错账号。 */
    const { default: Panel } = await import("./components/InspectionDashboardPanel");
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "正文" } as never);
    // `da_task_id` 非空 → `showAi` 为真 → 才会真的去取详情
    const row = IDLE({ account_id: MEMBER, da_task_id: "t-1" });
    render(<Panel row={row} onClose={() => {}} />);
    await waitFor(() =>
      expect(vi.mocked(api.getInspectionFinding)).toHaveBeenCalled());
    const [id, acct] = vi.mocked(api.getInspectionFinding).mock.calls[0];
    expect(id).toBe(row.finding_id);
    expect(acct,
      "详情用了页面选中的账号 —— 会去查错分区，表现是「刚派发就 not_found」",
    ).toBe(MEMBER);
  });

  it("★★★ `account_id` 属性缺失时回退 finding_id 首段（存量行）", async () => {
    /* `shapeFinding` 是 `String(it.account_id || "")` —— 存量行缺这个属性时
       是空串，而空串会被当成「部署账号」兜底，于是又回到查错分区。
       `finding_id` 的第一段**就是**账号，所以它在任何情况下都指向对的分区。 */
    const { default: Panel } = await import("./components/InspectionDashboardPanel");
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "正文" } as never);
    const row = IDLE({ account_id: "", da_task_id: "t-1" });
    // 前提自检：finding_id 首段真的是账号（形状变了这条断言就没意义了）
    expect(row.finding_id.split("#")[0]).toMatch(/^\d{12}$/);
    render(<Panel row={row} onClose={() => {}} />);
    await waitFor(() =>
      expect(vi.mocked(api.getInspectionFinding)).toHaveBeenCalled());
    expect(vi.mocked(api.getInspectionFinding).mock.calls[0][1])
      .toBe(row.finding_id.split("#")[0]);
  });

  it("★★★ 详情面板：已派过时按钮不渲染、只给状态", async () => {
    const { default: Panel } = await import("./components/InspectionDashboardPanel");
    const judged = vi.fn();
    /* 🔴 必须显式 mock 成「没有正文」。`vi.clearAllMocks()` 只清调用记录、
       **不清实现** —— 上面两条用例把 `getInspectionFinding` 设成了
       `{ ok: true, da_body: "正文" }`，泄漏过来的话这一条会渲染判读全文
       而不是等待态，断言就变成了「测另一件事」。 */
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "" } as never);
    render(<Panel row={IDLE({ da_task_id: "t-old-9" })}
      onClose={() => {}} onJudge={judged} />);
    expect(judgeBtn(),
      "详情面板里已派过还给按钮 —— 重复派发会重复烧额度，"
      + "而两份判读回填到同一行只会互相覆盖",
    ).toBeNull();
    /* 而且要给出状态与 task id，否则客户不知道「已经在跑了」。
       ⚠️ 要 `waitFor`（2026-09-01）：等待态并进了「AI 判读」一节，
          在详情请求 settle 之后才渲染 —— 原来那个独立琥珀块是同步的。
       ⚠️ task id 断言在**同一个状态行里**：那次合并的动机之一就是
          它原来出现两次（琥珀块一次、空态 Alert 一次）。 */
    await waitFor(() => {
      expect(screen.queryByText(/判读已派发/) || screen.queryByText(/已派发/),
        "既不给按钮也不给状态 —— 客户看不出这条已经在跑了",
      ).not.toBeNull();
    });
    expect(screen.getAllByText(/t-old-9/).length,
      "task id 出现了多次 —— 合并等待态的动机之一就是它原来重复").toBe(1);
  });

  it("★★★ 详情面板：没派过时给按钮（备注入口已挪进弹窗）", async () => {
    const { default: Panel } = await import("./components/InspectionDashboardPanel");
    render(<Panel row={IDLE()} onClose={() => {}}
      onJudge={vi.fn()} />);
    expect(judgeBtn(),
      "没派过却不给按钮 —— 那这个功能压根没入口",
    ).not.toBeNull();
    /* ⚠️ 备注入口**不该**再出现在面板正文里（2026-08-31 挪进 `JudgeModal`）。
       它留在正文里就是「离按钮 350px」那个问题的根源 —— 客户原话：
       「这两个相隔这么远，用户知道他俩是一起的吗？」 */
    expect(screen.queryByText(/补充一句背景/),
      "备注入口还在面板正文里 —— 那个距离问题没解决",
    ).toBeNull();
    expect(document.querySelector("textarea"),
      "面板正文里还有 textarea —— 备注该在弹窗里",
    ).toBeNull();
  });

  it("★★★ 派发中按钮进 loading（否则客户会连点）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    // 让它挂住不返回 —— 模拟「正在派发」
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.judgeInspectionFinding).mockReturnValue(
      new Promise((res) => { release = res; }) as never);
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    openDrawer(/notiops-tb-/);
    fireEvent.click(judgeBtn()!);
    await waitFor(() => {
      expect(judgeModalEl(), "确认弹窗没开").not.toBeNull();
    });
    fireEvent.click(inModal(/派发判读|Dispatch review/)!);
    /* 🔴 判据是 `aria-disabled` —— `Btn` 的 `loading` 走它（本仓库刻意不用
       原生 disabled，见 ui.tsx 那段说明）。
       没有 loading 的表现：判读是同步 invoke（1~3 秒），客户以为没反应连点
       三次，第二次开始拿 `already_dispatched`，看起来像失败。
       ⚠️ 现在 loading 在**弹窗的派发按钮**上（弹窗在派发中不关，
          正是为了让人看到这个状态）。 */
    await waitFor(() => {
      const el = [...document.querySelectorAll('[role="dialog"] button')]
        .find((b) => /派发判读|Dispatch review/.test(b.textContent || ""));
      expect(el?.getAttribute("aria-disabled"),
        "派发中按钮没进 loading —— 客户会连点，第二次开始拿 already_dispatched",
      ).toBe("true");
    });
    release({ ok: true, task_id: "t", agent_space_id: "s" });
  });

  it("★★★ 三处 OPERATOR_NOTE_LIMIT 必须一致（前端 / BFF / Python）", async () => {
    const fe = (await import("./api/inspection")).OPERATOR_NOTE_LIMIT;
    const bff = REPO("../../bff/web-chat/inspection.mjs");
    const py = REPO("../../inspection/domain/payload.py");
    const mb = /OPERATOR_NOTE_LIMIT = ([0-9_]+)/.exec(bff);
    const mp = /OPERATOR_NOTE_LIMIT = ([0-9_]+)/.exec(py);
    expect(mb, "BFF 侧的常量不在了").not.toBeNull();
    expect(mp, "Python 侧的常量不在了").not.toBeNull();
    const nb = Number(mb![1].replace(/_/g, ""));
    const np = Number(mp![1].replace(/_/g, ""));
    /* 🔴 前端松的表现是输入框放你写 5000 字，点提交才被 BFF 拒 ——
       而那时你已经写完了。三处一致才能让 `maxLength` 与计数器说真话。 */
    expect(fe, `前端 ${fe} / BFF ${nb} / Python ${np} 三处不一致`).toBe(nb);
    expect(fe, `前端 ${fe} / Python ${np} 不一致`).toBe(np);
  });
});


describe("派发之后：列表上要看得出是哪一条（客户实测提的）", () => {
  /* 🔴 客户原话：「这里也没有标注出来哪一条 finding 触发了深度分析。
     我认为 findings 这一行至少有一个醒目的标识，证明他已经被触发了 DA 调查呀」

     派发之后列表回到 N 条一模一样的卡片，唯一的痕迹是顶部那条会被关掉的
     绿色提示条。于是客户不知道自己派过哪一条，会重复点 —— 而后端会拒，
     看起来像失败。 */

  it("★★★ 已派发但判读还没回来 → 卡片上有「判读中」徽章", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE({ da_task_id: "t-1", has_judgment: false })]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      const hit = screen.queryAllByText(/判读中|Reviewing/);
      /* 🔴 断**恰好 1 次**，两个方向都要红：

         0 次 = 已派发的 finding 在列表上没有任何标识，客户不知道自己派过
                哪一条，会重复点（后端会拒，看起来像失败）—— 客户原话报的
                就是这条；
         2 次 = 顶部 ⏳ 徽章和第四行都打了同一句（我 2026-09-02 修等待态时
                真写成这样），一张卡上重复一遍不增加任何信息。

         这条同时钉住「徽章与第四行成对」：判据同为 `state === "pending"`，
         谁删了徽章就得把第四行补回来。 */
      expect(hit.length,
        `「判读中」出现 ${hit.length} 次，应当恰好 1 次`,
      ).toBe(1);
    });
  });

  it("★★★ 判读**已经回来** → 不要那个徽章（内容自己会说话）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE({ da_task_id: "t-1", has_judgment: true,
                       da_verdict: "真闲置，可删" })]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    expect(screen.queryByText(/判读中/),
      "判读回来了还挂着「判读中」—— 「在跑」与「跑完了」长得一样",
    ).toBeNull();
  });

  it("★★★ 没派过 → 没有徽章（反例，否则对所有条目都报）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    expect(screen.queryByText(/判读中/)).toBeNull();
  });
});

describe("确认弹窗（备注与按钮不再隔 350px）", () => {
  /* 🔴 客户原话：「这两个相隔这么远，用户知道他俩是一起的吗？」
     上一版备注框在详情面板正文中间，`[深入分析]` 钉在 footer 里。 */

  const openModal = async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    // 判读按钮只在抽屉 footer 里 —— 先开抽屉（抽屉本身也是 role=dialog，
    // 所以下面等的是**第二个** dialog）。
    openDrawer(/notiops-tb-/);
    await waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    });
    fireEvent.click(judgeBtn()!);
    await waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]').length,
        "弹窗没打开").toBe(2);
    });
  };

  it("★★★ 点「深入分析」先开弹窗，**不直接派**", async () => {
    await openModal();
    expect(vi.mocked(api.judgeInspectionFinding),
      "点了就直接派了 —— 确认这一步被绕过，而这个动作按秒计费且不能撤",
    ).not.toHaveBeenCalled();
  });

  it("★★★ 弹窗里备注框与派发按钮在同一个 dialog 内", async () => {
    await openModal();
    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.querySelector("textarea"),
      "弹窗里没有备注框 —— 那它又回到了「离按钮 350px」那个状态",
    ).not.toBeNull();
    const btns = [...dlg.querySelectorAll("button")].map((b) => b.textContent || "");
    expect(btns.some((x) => /派发判读|Dispatch review/.test(x)),
      `弹窗里没有派发按钮：${btns}`,
    ).toBe(true);
  });

  it("★★★ 弹窗里要说清「在这个资源所在的账号里」", async () => {
    /* 客户实测问过「我这个深入分析是在哪个账号内进行的」——
       现在答案是对的，但不明说就没人知道。 */
    await openModal();
    const txt = document.querySelector('[role="dialog"]')!.textContent || "";
    // 🔴 2026-09-01 文案改成**直接写账号号 · region**，不再用「这个资源所在的
    //    账号」这种抽象指代 —— 客户当初问的就是「在哪个账号内进行」，
    //    给个指代等于没回答。
    expect(txt.includes(IDLE().account_id),
      `弹窗里没写出真实账号号，只有：${txt.slice(0, 200)}`,
    ).toBe(true);
    expect(txt.includes(IDLE().region), "弹窗里没写 region").toBe(true);
    // 也要说清按秒计费 + 不能撤 + 不能重复派
    expect(/按秒计费|per second/.test(txt), "没说计费").toBe(true);
    expect(/不能撤回|cannot be cancelled/.test(txt), "没说不能撤").toBe(true);
  });

  it("★★★ 弹窗顶部显示这一条是谁（读 row，不发请求）", async () => {
    await openModal();
    const txt = document.querySelector('[role="dialog"]')!.textContent || "";
    expect(txt).toContain("notiops-tb-redis-us-west-2-001");
    expect(txt).toContain("444455556666");
    // ⚠️ 不发请求 —— 弹窗要立刻出来，转圈等于把「确认」变成一次等待
    expect(vi.mocked(api.getInspectionFinding),
      "弹窗打开时发了请求 —— 它显示的字段全在 row 上",
    ).not.toHaveBeenCalled();
  });

  it("★★★ 确认后才带着备注派发", async () => {
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue(
      { ok: true, task_id: "t-9", agent_space_id: "sp" } as never);
    await openModal();
    const dlg = document.querySelector('[role="dialog"]')!;
    fireEvent.change(dlg.querySelector("textarea")!,
      { target: { value: "  这台是灾备备库  " } });
    fireEvent.click([...dlg.querySelectorAll("button")]
      .find((b) => /派发判读|Dispatch review/.test(b.textContent || ""))!);
    await waitFor(() => {
      expect(vi.mocked(api.judgeInspectionFinding)).toHaveBeenCalled();
    });
    const arg = vi.mocked(api.judgeInspectionFinding).mock.calls[0][0];
    expect(arg.note, "备注没传下去，或者没 trim").toBe("这台是灾备备库");
  });

  it("★★★ 派发完弹窗要关掉（成功与失败都要）", async () => {
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue(
      { ok: false, code: "kill_switch", message: "巡检已被 kill switch 停用" } as never);
    await openModal();
    const dlg = document.querySelector('[role="dialog"]')!;
    fireEvent.click([...dlg.querySelectorAll("button")]
      .find((b) => /派发判读|Dispatch review/.test(b.textContent || ""))!);
    /* 🔴 失败时也要关：错误提示条在弹窗**后面**的页面上（弹窗有遮罩），
       留着弹窗客户看不见它，只觉得点了没反应。 */
    await waitFor(() => {
      // ⚠️ 抽屉**留着**是对的（派完要让人看到「已派发」那一行），
      //    所以判据是「只剩抽屉这一个 dialog」，不是「一个都没有」。
      expect(document.querySelectorAll('[role="dialog"]').length,
        "派发失败后弹窗还开着 —— 错误提示条在遮罩后面，客户看不见",
      ).toBe(1);
    });
    await waitFor(() => {
      expect(screen.queryByText(/kill switch/)).not.toBeNull();
    });
  });

  it("★★ 取消不派发", async () => {
    await openModal();
    fireEvent.click(inModal(/取消|Cancel/)!);
    await waitFor(() => {
      // 关掉弹窗之后**抽屉还在**（它不是这个动作的一部分）。
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    });
    expect(vi.mocked(api.judgeInspectionFinding)).not.toHaveBeenCalled();
  });
});


describe("弹窗必须压在抽屉**之上**", () => {
  /* 🔴 2026-08-31 实机踩到：从详情抽屉里点「深入分析」，确认弹窗渲染出来了，
     但压在抽屉**下面**，还被抽屉的遮罩盖成灰色 —— 看起来像「弹窗坏了」。

     根因：`Modal` 与 `Drawer` 共用 `scrim`（同 `zIndex: 1000`）。同层时靠 DOM
     顺序决定叠放，而抽屉在弹窗之后渲染。

     ⚠️ 既有的绕法是「开弹窗前先关抽屉」（ExclusionModal 那处）。那治单个实例，
        治不了这一类 —— 而判读这个弹窗**需要**抽屉留着（派完要让人看到抽屉里
        那行「已派发 task <id>」）。 */

  it("★★★ 抽屉开着时点「深入分析」，弹窗的 z-index 更高", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    // 先开抽屉
    openDrawer(/notiops-tb-/);
    await waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]').length).toBeGreaterThan(0);
    });
    const btns = screen.queryAllByText(/深入分析/);
    fireEvent.click(btns[btns.length - 1]);

    await waitFor(() => {
      // 现在页面上有两层：抽屉 + 弹窗
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(2);
    });
    /* 判据：**弹窗那一层的 z-index 严格大于抽屉那一层**。
       两个都是 `role="dialog"`，各自的遮罩是它的父元素。 */
    const zs = [...document.querySelectorAll('[role="dialog"]')].map((d) => {
      const scrim = d.parentElement as HTMLElement;
      return Number(scrim?.style.zIndex || 0);
    });
    expect(zs.length).toBe(2);
    expect(Math.max(...zs) > Math.min(...zs),
      `两层的 z-index 相同（${zs}）—— 同层时靠 DOM 顺序叠放，`
      + "而抽屉在弹窗之后渲染 ⇒ 弹窗被压在下面、还被抽屉的遮罩盖成灰色",
    ).toBe(true);
    /* 🔴 而且**更高的那个必须是弹窗**。只断「不相等」的话把抽屉调高也能过，
       而那正是错的方向。判据：含 textarea 的那一层（备注框只在弹窗里）。 */
    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const modal = dialogs.find((d) => d.querySelector("textarea"))!;
    const drawer = dialogs.find((d) => d !== modal)!;
    const zOf = (d: Element) =>
      Number((d.parentElement as HTMLElement)?.style.zIndex || 0);
    expect(zOf(modal) > zOf(drawer),
      `弹窗 z=${zOf(modal)} 不高于抽屉 z=${zOf(drawer)}`,
    ).toBe(true);
  });

  it("★★★ 抽屉**不关掉** —— 派完要让人看到抽屉里那行「已派发」", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    openDrawer(/notiops-tb-/);
    await waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    });
    const btns = screen.queryAllByText(/深入分析/);
    fireEvent.click(btns[btns.length - 1]);
    await waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]').length,
        "开弹窗时把抽屉关掉了 —— 那是 ExclusionModal 的绕法，"
        + "而判读派完需要抽屉留着显示「已派发 task <id>」",
      ).toBe(2);
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// ④ 手动判读回来之后的显示（2026-09-01 客户实测报的三条）
//
// 实机数据（444455556666 / notiops-tb-redis-us-west-2-001）：
//   DA COMPLETED · da_parse_status=ok · da_verdict=warm_up · da_body 1833 字符
// 也就是**后端全对**，三条都是纯 UI：
//   ① 卡片显示「判读结论 warm_up」—— 机器枚举直接打出来
//   ② 抽屉仍显示「判读已派发，等结果回来」—— 已经回来了
//   ③ 闲置类的判读正文**无处显示** —— 抽屉对 kind=idle 整节不渲染，
//      而手动「深入分析」恰恰能给闲置类派真 DA
// ═══════════════════════════════════════════════════════════════════════════

/** 一条**已经拿到判读**的闲置 finding（照实机字段）。 */
const IDLE_JUDGED = (over: Record<string, unknown> = {}): FindingRow => IDLE({
  da_task_id: "11111111-2222-3333-4444-555555555555",
  da_parse_status: "ok",
  da_verdict: "warm_up",
  has_judgment: true,
  ...over,
});

describe("判读回来之后的显示", () => {
  it("★★★ verdict 显示译名，不是机器枚举 warm_up", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE_JUDGED()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    expect(screen.queryByText(/预热期/),
      "verdict 没有译名 —— 客户看到「判读结论 warm_up」（用户原话："
      + "「看起来不像是人类可读的词」）",
    ).not.toBeNull();
    // 原始枚举不该作为**可见文本**出现（挂在 title 上是可以的）
    const raw = screen.queryAllByText("warm_up");
    expect(raw.length, "机器枚举 warm_up 还在界面上").toBe(0);
  });

  it("★★★ 认不出的 verdict 原样显示，不显示空白", async () => {
    // DA 换了措辞 / 加了第五档而 i18n 没跟上 —— 显示英文枚举至少能拿去搜代码，
    // 空白则那一行凭空消失、看起来像后端没给。
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE_JUDGED({ da_verdict: "brand_new_verdict" })]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    expect(screen.queryByText(/brand_new_verdict/)).not.toBeNull();
  });

  it("★★★ 判读回来后抽屉**不再**显示「等结果回来」", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE_JUDGED()]));
    vi.mocked(api.getInspectionFinding).mockResolvedValue({
      ok: true, da_body: "**verdict**: warm_up\n**evidence**: …",
      da_updated_at: 1788223019,
    } as never);
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    openDrawer(/notiops-tb-/);
    await waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    });
    /* 🔴 断言查的是**那句话的 i18n 值本身**，不是一个手抄的片段。
       原来查的是 `/等结果回来/` —— 2026-09-01 把等待态文案换成
       「判读已派发，1~3 分钟后回来…」之后那个片段再也不出现，
       于是这条变成了**恒绿的空断言**（反向注入实测：把判据退回只判
       `dispatched`，它照样过）。从 STRINGS 取值就不会再有这种漂移。 */
    const { STRINGS } = await import("./i18n");
    const waiting = STRINGS["insp.judge.dispatched"].zh;
    expect(screen.queryByText(waiting),
      "判读早就回来了（da_parse_status=ok / da_verdict / da_body 都有），"
      + `抽屉还在说「${waiting}」—— 客户在等一个已经到了的东西。`
      + "同一屏上卡片已经写着「判读结论 …」，两处自相矛盾",
    ).toBeNull();
    // 也不许出现 task id：那一行只属于等待态
    expect(screen.queryByText(/759e09ed/),
      "判读回来了还挂着 task id —— 那是等待态的东西").toBeNull();
  });

  it("★★★ 闲置类手动派过判读后，正文**必须**能显示出来", async () => {
    // 🔴 最严重的那条：抽屉对 kind=idle 整节不渲染，而手动「深入分析」
    //    能给闲置类派真 DA ⇒ 额度花了、结果回来了、库里有，界面上到不了。
    const BODY = "这是 DA 返回的判读正文，客户必须能看到它。";
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE_JUDGED()]));
    vi.mocked(api.getInspectionFinding).mockResolvedValue({
      ok: true, da_body: BODY, da_updated_at: 1788223019,
    } as never);
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    openDrawer(/notiops-tb-/);
    await waitFor(() => {
      expect(screen.queryByText(new RegExp(BODY.slice(0, 12))),
        "闲置 finding 手动派的判读正文没有任何地方显示 —— "
        + "客户花了 DA 额度拿不到结果",
      ).not.toBeNull();
    });
  });

  it("★★★ 反例：闲置类**没派过**判读时，那一节仍然整节不渲染", async () => {
    // 定时闲置轮从不派 DA，那一节的三句话全是主动的错误陈述（见 ① 那组）。
    // 放宽判据不能把这个也放开。
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    openDrawer(/notiops-tb-/);
    await waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    });
    expect(screen.queryByText(/这条还没有 AI 判读/),
      "没派过判读的闲置 finding 又出现了「这条还没有 AI 判读」—— "
      + "判读不会来（不是「还没」），这句话会让客户一直等",
    ).toBeNull();
    // 而且**一个请求都不该发**（注定 not_found + 一条服务端错误日志）
    expect(vi.mocked(api.getInspectionFinding)).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 交互模型（2026-09-01 客户实测提的三条）
// ═══════════════════════════════════════════════════════════════════════════

describe("卡片与页头的交互", () => {
  it("★★★ 卡片上没有任何动作按钮 —— 包括那个纯重复的「详情」", async () => {
    // 用户原话：「UI dashboard和side panel内的功能键很重复」+
    //          「整个 side panel 都已经 clickable，详情 button 的意义是什么？」
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    const card = screen.getByText(/notiops-tb-redis/)
      .closest("[data-finding-id]")!;
    expect(card.querySelectorAll("button").length,
      "卡片上还有按钮 —— 动作应当只在抽屉 footer 里，"
      + "每张卡一行按钮会让一屏少装 4~5 条",
    ).toBe(0);
    expect(screen.queryByText("详情"), "「详情」按钮还在（整卡点击的重复）")
      .toBeNull();
  });

  it("★★★ 点卡片任意位置打开抽屉（键盘 Enter 也要能开）", async () => {
    // 🔴 键盘那一半必须测：上一版的键盘入口就是「详情」按钮，删掉它之后
    //    如果不给卡片补 role/tabIndex/onKeyDown，纯键盘用户**完全打不开抽屉**。
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    const card = screen.getByText(/notiops-tb-redis/)
      .closest("[data-finding-id]")! as HTMLElement;
    expect(card.getAttribute("role"), "卡片不是可聚焦控件").toBe("button");
    expect(card.getAttribute("tabindex"), "卡片进不了 Tab 序").toBe("0");
    fireEvent.keyDown(card, { key: "Enter" });
    await waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]').length,
        "键盘 Enter 打不开抽屉 —— 删掉「详情」按钮之后这是唯一的键盘入口",
      ).toBe(1);
    });
  });

  it("★★★ 页头有「刷新」按钮", async () => {
    // 用户原话：「整个页面我也没有看到 刷新 button。执行了一些操作后，
    //           当前dashboard的内容也不会自己刷新」
    // `reload()` 与 `refreshing` 一直都有，只是没有任何控件触发它 ——
    // 客户只能按浏览器刷新（整页重载：丢滚动、丢筛选、丢抽屉）。
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    expect(refreshBtn(), "页头没有刷新按钮").not.toBeUndefined();
  });

  it("★★★ 点刷新会重新取数", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    const before = vi.mocked(api.getInspectionFindings).mock.calls.length;
    fireEvent.click(refreshBtn()!);
    await waitFor(() => {
      expect(vi.mocked(api.getInspectionFindings).mock.calls.length,
        "点了刷新没有重新取数").toBeGreaterThan(before);
    });
  });

  it("★★★ 「另有 N 项未做根因分析」用后端算的数，不在前端重算", async () => {
    // 🔴 前端原来自己 `openRows.filter((f) => !f.has_judgment).length`，
    //    绕过了 BFF 那四条判据（conclusion / skip_reason / DETERMINISTIC_KINDS）。
    //    后果：闲置页顶上恒挂「另有 N 项未做根因分析」，而那一页没有一条需要
    //    AI 判读。同一页另一处（系统状态区）用的是对的 without_judgment。
    const d = FINDINGS([IDLE(), IDLE({
      finding_id: "444455556666#us-east-1#elasticache#other-1#idle#-",
      instance: "other-1",
    } as Partial<FindingRow>)]);
    // 后端说「0 项未做」（闲置类结构上不需要 AI），而两条都 has_judgment=false
    (d as unknown as { without_judgment: number }).without_judgment = 0;
    vi.mocked(api.getInspectionFindings).mockResolvedValue(d);
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    expect(screen.queryByText(/未做根因分析/),
      "后端说 0 项未做根因分析，前端还是按 !has_judgment 自己算出了 2 项 —— "
      + "闲置类结构上不需要 AI 判读",
    ).toBeNull();
  });

  it("★★★ 反例：后端说有未做的，就要显示出来", async () => {
    const d = FINDINGS([HIGH({ skip_reason: "quota" } as Partial<FindingRow>)]);
    (d as unknown as { without_judgment: number }).without_judgment = 1;
    vi.mocked(api.getInspectionFindings).mockResolvedValue(d);
    render(<InspectionDashboard dashboardId="high-load" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-rds-prod/)).not.toBeNull();
    });
    expect(screen.queryByText(/未做根因分析/),
      "后端说有 1 项未做根因分析却不显示 —— 客户会以为看板就是全部（R10.6）",
    ).not.toBeNull();
  });

  it("★★★ 抽屉 footer 里没有「取消」（它是只读视图，不是表单）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([IDLE()]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    openDrawer(/notiops-tb-/);
    await waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    });
    const dlg = document.querySelector('[role="dialog"]')!;
    const cancel = [...dlg.querySelectorAll("button")]
      .find((b) => /^取消$|^Cancel$/.test((b.textContent || "").trim()));
    expect(cancel,
      "抽屉 footer 里还有「取消」——「取消」暗示刚才的操作会被撤销，"
      + "而它只是关闭；✕ / Esc / 点遮罩已经是三条关闭路径",
    ).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 判读全文与评分条（2026-09-01 客户实测的两条）
// ═══════════════════════════════════════════════════════════════════════════

describe("判读全文按 markdown 渲染", () => {
  const MD = [
    "**verdict**: real_degradation",
    "",
    "**evidence**:",
    "- 从 `elasticache:DescribeCacheClusters` 调用确认状态为 available",
    "- CurrItems 持续为 0.0",
  ].join("\n");

  const openWithBody = async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE({
        da_task_id: "t-1", has_judgment: true, da_verdict: "real_degradation",
        da_parse_status: "ok",
      } as Partial<FindingRow>)]));
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: MD, da_updated_at: 1788223019 } as never);
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    openDrawer(/notiops-tb-/);
    await waitFor(() => {
      expect(document.querySelector(".insp-md"), "判读全文那一块没渲染")
        .not.toBeNull();
    });
    return document.querySelector(".insp-md")!;
  };

  it("★★★ 不能把 markdown 源码字面显示给客户", async () => {
    // 客户实测原话：「灰色的AI判读结果，貌似是md格式，但这里没有转译成正常的格式」
    const box = await openWithBody();
    const txt = box.textContent || "";
    expect(txt.includes("**verdict**"),
      "星号字面显示了 —— 客户读到的是 markdown 源码，"
      + "而这段文字是花 DA 额度换来的唯一产物",
    ).toBe(false);
    expect(txt.includes("`elasticache:"), "反引号字面显示了").toBe(false);
  });

  it("★★★ 加粗 / 代码 / 列表都真的成了元素", async () => {
    const box = await openWithBody();
    expect(box.querySelector("strong"), "`**verdict**` 没变成 <strong>")
      .not.toBeNull();
    expect(box.querySelector("code"), "反引号没变成 <code>").not.toBeNull();
    expect(box.querySelectorAll("li").length,
      "`- ` 列表没变成 <li>").toBeGreaterThan(0);
    // 正文内容本身不能丢
    expect((box.textContent || "").includes("CurrItems 持续为 0.0")).toBe(true);
  });
});

describe("闲置评分条的满格分数", () => {
  /** ElastiCache 三维：CPU 35% / 内存 35% / 请求数 30%。 */
  const EC_FACTORS = [
    { name: "cpu", weight: 0.35, value: 0.997, points: 34.9,
      basis: "cpu_pct", observed: 0.26 },
    { name: "memory", weight: 0.35, value: 0.983, points: 34.4,
      basis: "memory_pct", observed: 1.7 },
    { name: "requests", weight: 0.30, value: 1, points: 30.0,
      basis: "requests_over_threshold", observed: 0 },
  ];

  const openScores = async (factors: unknown[]) => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([IDLE({
        idle_score: 99.3, idle_factors: factors,
      } as unknown as Partial<FindingRow>)]));
    render(<InspectionDashboard dashboardId="idle" can={() => true} />);
    await waitFor(() => {
      expect(screen.queryByText(/notiops-tb-redis/)).not.toBeNull();
    });
    openDrawer(/notiops-tb-/);
    await waitFor(() => {
      expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
    });
  };

  it("★★★ ElastiCache 的满格是 35 不是写死的 40", async () => {
    // 🔴 写死 40 时 ElastiCache **没有一条条能满**（三维上限 35/35/30），
    //    而列头还告诉客户「满格 40」。客户实测原话：
    //    「这里 30 分是满分，为什么仍然没有沾满绿色进度条？」
    await openScores(EC_FACTORS);
    expect(screen.queryByText(/满格 35/),
      "列头还写着写死的「满格 40」—— ElastiCache 任何一维都到不了 40",
    ).not.toBeNull();
    expect(screen.queryByText(/满格 40/)).toBeNull();
  });

  it("★★★ 权重最大那一维满格时条是 100%", async () => {
    await openScores(EC_FACTORS);
    const bars = [...document.querySelectorAll('[role="dialog"] div')]
      .filter((d) => (d as HTMLElement).style.background === "var(--green)"
        || /rgb|#/.test((d as HTMLElement).style.background))
      .map((d) => (d as HTMLElement).style.width)
      .filter((w) => w.endsWith("%"));
    expect(bars.length, "找不到评分条").toBeGreaterThan(0);
    const max = Math.max(...bars.map((w) => parseFloat(w)));
    expect(max, `最长那条只有 ${max}% —— 权重最大的维度满格时应当接近 100%`)
      .toBeGreaterThan(95);
  });

  it("★★★ 条宽按贡献分，**不按归一化值** —— 权重小的维度满格时条要更短", async () => {
    // 🔴 这条守的是「别把分母改成每一维自己的上限」。那样改之后所有满格的
    //    维度都画成 100%，于是权重 30% 的请求数与权重 35% 的 CPU 看起来
    //    贡献相同 —— 而它对总分的影响少 1/7。
    //    条宽存在的意义就是回答「谁把这个分推上去的」。
    await openScores(EC_FACTORS);
    const widths = [...document.querySelectorAll('[role="dialog"] div')]
      .map((d) => (d as HTMLElement).style.width)
      .filter((w) => w.endsWith("%"))
      .map((w) => parseFloat(w))
      .sort((a, b) => b - a);
    expect(widths.length, "找不到评分条").toBeGreaterThanOrEqual(3);
    // 三维都接近各自的归一化满值（0.997 / 0.983 / 1.0），所以如果分母是
    // 「每一维自己的上限」，三条会几乎一样长。正确实现下最短那条明显更短。
    const [a, , c] = widths;
    expect(a - c,
      `最长 ${a}% 与最短 ${c}% 只差 ${(a - c).toFixed(1)}% —— `
      + "看起来像按归一化值画的：权重 30% 的维度满格时不该与权重 35% 的一样长",
    ).toBeGreaterThan(8);
  });

  it("★★ RDS 四维时满格回到 40", async () => {
    await openScores([
      { name: "cpu", weight: 0.40, value: 1, points: 40, basis: "cpu_pct",
        observed: 0.1 },
      { name: "iops", weight: 0.10, value: 1, points: 10,
        basis: "iops_over_baseline", observed: 0 },
    ]);
    expect(screen.queryByText(/满格 40/),
      "RDS 的满格应当是 40（单维最高权重 0.40）").not.toBeNull();
  });

  it("★★ 权重全缺（老数据）时回落到 40，不崩", async () => {
    await openScores([
      { name: "cpu", weight: null, value: null, points: 34.9,
        basis: "cpu_pct", observed: 0.26 },
    ]);
    expect(screen.queryByText(/满格 40/)).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 判读回来之后：抽屉必须自己收敛（2026-09-02 review）
// ═══════════════════════════════════════════════════════════════════════════
describe("抽屉的判读等待态", () => {
  const HIGH_ROW = (over: Record<string, unknown> = {}) => HIGH(over);

  it("★★★ 判读落库后抽屉重取详情（不能停在打开那一刻的空正文）", async () => {
    /* 🔴 这是「深入分析」这条功能的**终点动作**。缺 effect 依赖的表现：

         点「深入分析」→ 1~3 分钟后判读落库 → 列表 reload 拿到
           has_judgment: true → 抽屉四个依赖一个都没变
           → detail 仍是打开那一刻的空 da_body → 显示等待态

       而 `insp.judge.dispatched` 的文案正是「1~3 分钟后回来。点右上角
       『刷新』查看」—— 客户照做，看到的还是等待态，正文必须关掉抽屉
       重开才出现。 */
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "", da_updated_at: 0 } as never);
    const row = HIGH_ROW({ da_task_id: "t-1" });
    const { rerender } = render(
      <InspectionDashboardPanel row={row} judged onClose={() => {}} />);
    await waitFor(() => {
      expect(vi.mocked(api.getInspectionFinding)).toHaveBeenCalled();
    });
    const before = vi.mocked(api.getInspectionFinding).mock.calls.length;

    // 判读回来了：列表那层 reload 之后把新的 row 传下来。
    vi.mocked(api.getInspectionFinding).mockResolvedValue({
      ok: true, da_body: "## 分析\n真的在降级", da_updated_at: 1,
    } as never);
    rerender(<InspectionDashboardPanel judged onClose={() => {}}
      row={HIGH_ROW({
        da_task_id: "t-1", has_judgment: true,
        da_verdict: "real_degradation", da_parse_status: "ok",
      })} />);

    await waitFor(() => {
      expect(vi.mocked(api.getInspectionFinding).mock.calls.length,
        "判读回来了抽屉没重取 —— 客户点「刷新」也看不到正文",
      ).toBeGreaterThan(before);
    });
    await waitFor(() => {
      expect(screen.queryByText(/真的在降级/), "正文没渲染出来").not.toBeNull();
    });
  });

  it("★★★ 派了、回来了、是空的 → 说「不会再变」，不是蓝色等待", async () => {
    /* 🔴 `callback_apply.py` 对 EMPTY / missing_section 只写 parse_status
       不写 body，所以「有 task_id、无 body」是**终态**。老判据
       `dispatched && !hasJudgment` 在它上面恒真 → 蓝色「1~3 分钟后回来」
       永不退出，客户一直刷新等一个已经确定失败的东西。 */
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "", da_updated_at: 0 } as never);
    render(<InspectionDashboardPanel judged onClose={() => {}}
      row={HIGH_ROW({ da_task_id: "t-1", da_parse_status: "empty" })} />);
    await waitFor(() => {
      expect(screen.queryByText(/判读已返回但没有内容/),
        "终态被说成等待态 —— 那个状态永远不会退出",
      ).not.toBeNull();
    });
    expect(screen.queryByText(/1~3 分钟/),
      "同时还挂着「1~3 分钟后回来」—— 两句话矛盾",
    ).toBeNull();
    // 机器枚举要译过。
    expect(screen.queryByText(/\bempty\b/), "原始枚举漏出来了").toBeNull();
  });

  it("★★★ 解析失败时正文要带「这可能是别人的分析」警告", async () => {
    /* 🔴 `parse_failed` 时 `da_body` 是**整份报告原文**，而一个 task 最多
       装 6 条 finding —— 里面可能是同批别的资源的分析。

       上一版只判 `detail?.da_body` 非空就直接渲染，客户在 db-A 的抽屉里
       读到 db-B 的分析，还配着「AI 判读」标题和时间徽章，看起来完全成功。
       `report_parse.py` 的注释写着「宁可让它退化成 PARSE_FAILED（原文仍
       保留，人一眼能看出来）」—— 前提是 UI 会标出来，而 UI 没标。 */
    vi.mocked(api.getInspectionFinding).mockResolvedValue({
      ok: true, da_updated_at: 1,
      da_body: "## db-OTHER\n这台的 CPU 是 12%，没问题",
    } as never);
    render(<InspectionDashboardPanel judged onClose={() => {}}
      row={HIGH_ROW({ da_task_id: "t-1", da_parse_status: "parse_failed" })} />);
    await waitFor(() => {
      expect(screen.queryByText(/整份报告原文/),
        "原文当成本条结论渲染了 —— 客户会照着别的资源的分析做处置",
      ).not.toBeNull();
    });
    // 原文仍然要给（它是花额度换来的唯一产物），只是要标注。
    expect(screen.queryByText(/这台的 CPU 是 12%/)).not.toBeNull();
  });

  it("★★★ reused / playbook 不说「判读缺失」（那是正常状态）", async () => {
    /* 抽屉此前**完全不读** `conclusion` / `skip_reason`，于是 reused /
       playbook 覆盖的高负载 finding 显示「还没有判读结果…一直没有的话
       看派发缺口」—— 把正常状态说成疑似故障。 */
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "", da_updated_at: 0 } as never);
    render(<InspectionDashboardPanel onClose={() => {}}
      row={HIGH_ROW({ skip_reason: "reused", conclusion: "形态没变，沿用上次" })} />);
    await waitFor(() => {
      expect(screen.queryByText(/形态没变，沿用上次/),
        "确定性结论没渲染 —— 抽屉不读 conclusion",
      ).not.toBeNull();
    });
    expect(screen.queryByText(/判读缺失/),
      "正常状态被说成缺判读",
    ).toBeNull();
  });

  it("★★★ 派发回执在抽屉里可见（列表那份被抽屉遮住）", async () => {
    /* 🔴 `judgeMsg` 原来只渲染在列表区，而抽屉 zIndex 1000 盖住它、
       派发又只能从抽屉里发起 —— 那条提示 100% 落在看不见的地方。
       `http_403` / `kill_switch` / `conflict` 这些永远不会自己变的失败
       在抽屉里就是点了没反应。 */
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "", da_updated_at: 0 } as never);
    render(<InspectionDashboardPanel onClose={() => {}} row={HIGH_ROW()}
      judgeMsg={{ type: "error", text: "没有派判读的权限（action:inspection:run）" }} />);
    await waitFor(() => {
      expect(screen.queryByText(/没有派判读的权限/),
        "抽屉里看不到回执 —— 客户只觉得点了没反应",
      ).not.toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 可访问性：双浮层（2026-09-02 review #8 的 F1 / F2 / F3）
//
// 🔴 F1 是硬缺陷：抽屉 + 弹层同开时键盘用户**完不成派发**。
//    放在这个文件是因为「抽屉里开确认弹窗」这条路的 helper 与 fixture 都在
//    这里（`openDrawer` / `judgeBtn` / `IDLE`），在别处重写一遍交互模型
//    正是这两个 helper 存在要避免的事。
// ═══════════════════════════════════════════════════════════════════════════
describe("双浮层的键盘与可访问名", () => {
  /** 开抽屉 → 从抽屉里开确认弹窗。返回时两层都在。 */
  const openBoth = async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([HIGH({ da_task_id: "" })]));
    render(<InspectionDashboard dashboardId="high-load" can={() => true} />);
    await waitFor(() => expect(
      screen.queryByText(/notiops-tb-rds-prod/)).not.toBeNull());
    openDrawer(/notiops-tb-rds-prod/);
    await waitFor(() => expect(
      document.querySelectorAll('[role="dialog"]').length).toBe(1));
    const btn = judgeBtn();
    expect(btn, "「深入分析」按钮没渲染 —— 这组用例的前提坏了").not.toBeNull();
    fireEvent.click(btn!);
    await waitFor(() => expect(
      document.querySelectorAll('[role="dialog"]').length).toBe(2));
  };

  it("★★★ F1 抽屉+弹层同开时 Tab 不被锁死", async () => {
    /* 🔴 `useOverlay` 把 `keydown` 挂在 `document` 上，所以两层同开时**两个
       handler 都会跑**，而它们各自都想把焦点抢回自己的框里：

         抽屉先挂载（A），弹窗后挂载（B）
         按 Tab → A 先跑：activeElement 在弹窗里 → A 的 box 不 contains 它
                          → preventDefault() + 抽屉第一个元素 .focus()
                 → B 再跑：activeElement 现在在抽屉里 → B 也不 contains
                          → preventDefault() + 弹窗第一个元素 .focus()
       ⇒ 每按一次 Tab 焦点都被重置回弹窗的**第一个**元素，
         永远到不了「确认」按钮 —— 键盘用户完不成派发。

       修法是浮层栈：只有最上层响应键盘。 */
    await openBoth();

    const dialogs = [...document.querySelectorAll('[role="dialog"]')];
    const modal = dialogs[dialogs.length - 1];
    const inModal = [...modal.querySelectorAll<HTMLElement>(
      'button, input, textarea, [tabindex="0"]')]
      .filter((el) => el.getAttribute("aria-disabled") !== "true");
    expect(inModal.length, "弹窗里没有可聚焦元素 —— 这条测试的前提坏了")
      .toBeGreaterThan(1);

    /* ⚠️ **jsdom 不实现 Tab 的原生焦点移动** —— `fireEvent.keyDown` 只派发
       事件，不会自己把焦点往后挪。所以「Tab 之后焦点前进了」在这里根本
       观测不到（第一版就是这么写的，假红）。

       能观测的是**有没有 handler 抢焦点**：
         坏的实现 → 下层抽屉的 handler 看到 activeElement 不在自己框里
                    → preventDefault() + 强行 focus() → 焦点被**挪动**
         好的实现 → 只有最上层响应，而焦点已在它框内 → 三个分支都不命中
                    → 焦点**原地不动**，交给浏览器自己走

       所以从**中间**那个元素出发（不是第一个）：坏实现会把它拽回弹窗第一个
       元素，好实现一动不动。 */
    const start = inModal[Math.min(1, inModal.length - 1)];
    expect(start, "弹窗里只有一个可聚焦元素 —— 这条用例区分不出对错")
      .not.toBe(inModal[0]);
    start.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement,
      "按 Tab 之后焦点被 handler 挪走了 —— 抽屉与弹窗在互相抢，"
      + "键盘用户每按一次都被拽回第一个元素，到不了「确认」按钮",
    ).toBe(start);
    // 顺带确认焦点没被抢到下层抽屉里去（那是同一个缺陷的另一半症状）。
    expect(modal.contains(document.activeElement),
      "焦点被下层抽屉抢走了",
    ).toBe(true);
  });

  it("★★★ F1 Esc 只关最上面那一层", async () => {
    /* 一次 Esc 让两层各自 `onClose()` —— 关弹窗顺带把抽屉也关了，
       而抽屉本该留着（派发完要让人看到里面那行「已派发 task <id>」，
       `InspectionDashboard` 那处注释明写着「**不 closeDrawer()**」）。 */
    await openBoth();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(
      document.querySelectorAll('[role="dialog"]').length,
      "一次 Esc 把抽屉也关了 —— 派发回执就没人看得到了",
    ).toBe(1));
  });

  it("★★★ F2 两种浮层的 dialog 都有可访问名", async () => {
    /* `role="dialog"` 没有名字时读屏只念「对话框」—— 而这个产品的对话框
       恰恰都是「你确定要让整个账号退出巡检吗」这一类，名字就是全部信息。 */
    await openBoth();

    for (const d of document.querySelectorAll('[role="dialog"]')) {
      const id = d.getAttribute("aria-labelledby");
      expect(id, "dialog 没有 aria-labelledby").toBeTruthy();
      const label = document.getElementById(id!);
      expect(label, `aria-labelledby 指向的 #${id} 不存在`).not.toBeNull();
      expect((label!.textContent || "").trim().length,
        "可访问名是空的（指对了节点但那里没有文字）",
      ).toBeGreaterThan(0);
    }
  });
});
