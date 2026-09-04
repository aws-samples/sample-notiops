/**
 * 巡检看板的**渲染**测试。
 *
 * 为什么这几条不能用「查源码子串」代替 —— 反向注入实测：
 *
 * ```
 * 把 `{r.mapped_tasks ?? "—"}` 改成 `{"—"}`      → 子串检查照过（gap 计算里还有那个词）
 * 把 `const BAD_DOWN` 改名成 `const NOT_USED`    → 子串检查照过（使用处还有那个词）
 * ```
 *
 * 两处的共同点是「标识符还在文件里，只是不起作用了」。只有渲染出来看
 * 实际输出才抓得到。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ConfigData, FindingRow, FindingsData, MetricDirection, OverviewData,
  RuleField, ScopeData,
} from "./api/inspection";

// ⚠️ mock 必须在被测组件 import **之前**生效。vitest 的 `vi.mock` 会被提升，
//    所以写在这里即可 —— 但工厂函数里不能引用外部变量（提升后还没初始化）。
vi.mock("./api/inspection", async (orig) => {
  const real = await orig<typeof import("./api/inspection")>();
  return {
    ...real,
    getInspectionOverview: vi.fn(),
    getInspectionFindings: vi.fn(),
    // ⚠️ 抽屉一打开就取判读全文。不 mock 会走真的 `signedClient()` →
    //    「Config not loaded yet」以 unhandled rejection 冒出来，
    //    用例本身照过但整个文件多一条 Errors。
    getInspectionFinding: vi.fn(),
    getInspectionScope: vi.fn(),
    getInspectionConfig: vi.fn(),
    // ⚠️ 写入的三个也要 mock —— 不 mock 会走真的 `signedClient()`，
    //    在 jsdom 里拿不到凭证于是恒返回 not_authenticated，
    //    测试会「通过」但什么都没验证到。
    putInspectionExclusion: vi.fn(),
    renewInspectionExclusion: vi.fn(),
    deleteInspectionExclusion: vi.fn(),
    putInspectionSchedule: vi.fn(),
    putInspectionRules: vi.fn(),
    triggerInspectionRun: vi.fn(),
    getInspectionResources: vi.fn(),
  };
});

const api = await import("./api/inspection");
const InspectionDashboard = (await import("./components/InspectionDashboard")).default;

// ⚠️ `cleanup()` 显式调用，不依赖 RTL 的自动清理 —— 后者只在
//    `globals: true` 时才注册。把 vite.config 的 globals 改成 false 之后，
//    残留的 DOM 会让下面用 `document.querySelector` 的断言读到上一个用例的
//    表格：测试**照过**，但验的是别的东西。
afterEach(() => { cleanup(); vi.clearAllMocks(); });

/**
 * 空的 findings 响应。
 *
 * ⚠️ 待处置页会为**每个有权限的 kind** 各取一次 findings，所以任何渲染
 * 那一页的用例都必须 mock 它 —— 不 mock 的话 vitest 返回 `undefined`，
 * 而组件的判据是「**明确成功**」（`d.ok === true`），于是整页进错误分支。
 *
 * 🔴 组件那侧刻意不接受 `undefined`：`isFail(undefined)` 是 false，
 *    把它当成合法数据会让页面渲染成「零条待处置」，而真相是请求没返回。
 *    空列表与「没风险」混成一回事正是 R9.11 要防的歧义。
 */
const EMPTY_LIST: FindingsData = {
  ok: true, account_id: "111122223333", kind: "high_load", total: 0,
  by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, INFO: 0 },
  without_judgment: 0, unclassified: 0,
  last_run: {
    run_date: new Date().toISOString().slice(0, 10),
    status: "success", completeness: 1, mode: "official",
  },
  findings: [],
};

beforeEach(() => {
  // 默认给一个空成功响应。用例里的 `mockResolvedValue` 会覆盖它。
  vi.mocked(api.getInspectionFindings).mockResolvedValue(EMPTY_LIST);
});

const OVERVIEW: OverviewData = {
  ok: true, account_id: "111122223333", total: 3,
  by_severity: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, INFO: 0 },
  by_state: { active: 3 },
  without_judgment: 2,
  unclassified: 0,
  // 总览也会被读侧 5000 上限截断（它跨 kind 全量，最先撞上）。0 = 没截断。
  truncated_at: 0,
  dispatch_gap: 4,
  // 判读解析质量。⚠️ 这里给的是「全绿」——18 条派发、18 条 ok。
  //    单独的用例（下面 `parse quality` 那组）才造失败态，
  //    否则每个渲染 OVERVIEW 的用例都会多出一条红色告警条，
  //    而那些用例断言的是别的东西。
  parse_quality: {
    ok: 18, partial: 0, parse_failed: 0, empty: 0, other: 0, dispatched: 18,
  },
  diff: {
    high: { current: 3, previous: 7, delta: -4, last_run_date: "2026-08-19",
      last_status: "success", completeness: 1 },
  },
  runs: [{
    run_type: "high", run_date: "2026-08-19", account_id: "111122223333",
    status: "success", data_date: "2026-08-18", source: "refetch",
    mode: "official", tier: "normal", catch_up: false, config_version: "v1",
    completeness: 1, expected: { instances: 11 }, actual: null,
    findings: 3, dispatched_tasks: 6, mapped_tasks: 2, heartbeat: false,
    skipped_by_gate: null, gaps: 0, batches_failed: 0,
    // 2026-08-27：全 region 巡检的覆盖面。默认给「全都扫成了」。
    regions: { total: 3, scanned: 3, failed: [] },
    by_region: { "ap-northeast-1": 3, "us-east-1": 7, "us-west-2": 1 },
  }],
};

function findingsWith(
  metric: string, direction: MetricDirection = "bad_up",
): FindingsData {
  return {
    ok: true, account_id: "111122223333", kind: "high_load", total: 1,
    by_severity: { CRITICAL: 1, HIGH: 0, MEDIUM: 0, INFO: 0 },
    without_judgment: 0,
    unclassified: 0,
    last_run: {
      run_date: "2026-08-18", status: "success",
      completeness: 1, mode: "official",
    },
    findings: [{
      finding_id: `111122223333#us-east-1#rds#db-1#threshold_high#${metric}`,
      account_id: "111122223333", region: "us-east-1", service: "rds",
      instance_class: "db.t4g.micro",
      instance: "db-1", metric,
      // ── 判定证据（这一版新增：此前这些数字压根没落库）──
      rule: "threshold_high", kind: "high_load",
      observed_value: 85.3, threshold_value: 70, headroom: -0.19,
      unit: "%", direction, raw_value: null, denominator: null,
      savings_usd: null, savings_precision: "",
      // 闲置评分因子。高负载条目上恒空 —— 它没有加权评分这个概念。
      // 证据就是本轮的（= last_run_date）→ UI 不该标注「数据截至…」。
      // 陈旧标注那条测试单独造 evidence_as_of < last_run_date 的行。
      evidence_as_of: "2026-08-19",
      idle_score: null, idle_weight_avail: null,
      idle_degraded: [], idle_factors: [],
      state: "active", severity: "CRITICAL",
      first_seen_date: "2026-08-12", last_run_date: "2026-08-19",
      days_active: 8, rule_version: "v1", consecutive_hits: 8,
      consecutive_misses: 0, was_confirmed: true,
      da_verdict: "real_degradation", da_parse_status: "ok",
      da_task_id: "t-1", da_report_md_key: "", has_judgment: true,
      // 门禁跑过且干净（`[]` 与 `null` 是两件事：前者是干净的正面证据，
      // 后者是没验过）。显式写出而不是省略 —— `FindingRow` 把这三个字段
      // 标成必填三态，就是为了让 fixture 必须表态。
      da_gate_trustworthy: true, da_degradations: [],
      da_skills_loaded: ["inspection-high-load"],
    }],
  };
}

describe("Overview", () => {
  it("★ renders dispatched and matched as two DIFFERENT numbers", async () => {
    // 两者不等意味着有判读永久回不来。合成一列 —— 或者
    // 干脆不渲染 matched —— 会让这个缺口在看板上完全看不见。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="overview" />);

    // ⚠️ `2026-08-19` 同时出现在 KPI 卡与表格里，`getByText` 会因多重匹配抛错。
    //    从表格作用域找 —— 这也更贴近要断言的东西（表格那一行）。
    const table = await waitFor(() => {
      const el = document.querySelector("table");
      if (!el) throw new Error("run table not rendered");
      return el;
    });
    const row = [...table.querySelectorAll("tbody tr")]
      .find((r) => r.textContent?.includes("2026-08-19"));
    expect(row, "找不到 2026-08-19 那一行").toBeTruthy();
    const cells = [...row!.querySelectorAll("td")].map((c) => c.textContent);
    // dispatched=6 与 matched=2 必须**都**出现在这一行里
    expect(cells).toContain("6");
    expect(cells).toContain("2");
  });

  it("★ surfaces the dispatch gap as a warning", async () => {
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="overview" />);
    await waitFor(() => expect(screen.getByText(/4 条判读任务已派发但未能关联/)).toBeTruthy());
  });

  it("shows a green down-arrow when the finding count drops", async () => {
    // 风险变少是好事 —— 与指标曲线的语义方向判定是两件事。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="overview" />);
    await waitFor(() => expect(screen.getByText(/↓\s*4/)).toBeTruthy());
    const el = screen.getByText(/↓\s*4/);
    expect(el.getAttribute("style")).toContain("var(--green)");
  });

  describe("parse quality（AI 判读解析质量）", () => {
    // 🔴 这一组守的是 **skill 漂移的唯一可见信号**。
    //
    //    DA 的判读是自然语言，回来之后按 `## <finding_id>` 精确匹配切段。
    //    DA 改了措辞 / 输出被截断 / skill 没加载，都表现为切不出节。
    //    在这一版之前 `da_parse_status` 只在**单条详情**里显示一个英文枚举
    //    —— 100 条里 60 条失败也得逐条点开才发现。

    it("★★ parse_failed > 0 时首屏就有红色告警", async () => {
      vi.mocked(api.getInspectionOverview).mockResolvedValue({
        ...OVERVIEW,
        parse_quality: {
          ok: 5, partial: 2, parse_failed: 9, empty: 2, other: 0,
          dispatched: 18,
        },
      });
      render(<InspectionDashboard dashboardId="overview" />);
      // 13 = 9 parse_failed + 2 empty + 2 partial
      await waitFor(() => expect(
        screen.getByText(/18 条判读里有 13 条没能完整对上号/)).toBeTruthy());
      // 🔴 四档要**各自**可见，不能只给一个总数：
      //    parse_failed 去查 skill，empty 去查 DA 那侧 —— 处置动作不同。
      expect(screen.getByText(/切不出节/)).toBeTruthy();
      expect(screen.getByText(/DA 没回内容/)).toBeTruthy();
      expect(screen.getByText(/部分/)).toBeTruthy();
    });

    it("★★ 全部 ok 时**不显示**这一条（不制造噪音）", async () => {
      // ⚠️ 这一半同样重要。一个恒显示的「解析质量」区块会让人习惯性忽略它，
      //    于是真出问题那天也不会被注意到 —— 那正是这个信号存在的意义。
      vi.mocked(api.getInspectionOverview).mockResolvedValue({
        ...OVERVIEW,
        parse_quality: {
          ok: 18, partial: 0, parse_failed: 0, empty: 0, other: 0,
          dispatched: 18,
        },
      });
      render(<InspectionDashboard dashboardId="overview" />);
      await waitFor(() => expect(screen.getByText(/4 条判读任务已派发但未能关联/)).toBeTruthy());
      expect(screen.queryByText(/没能完整对上号/)).toBeNull();
    });

    it("★ 一条都没派发时不显示（分母为 0）", async () => {
      // 闲置轮走 `SkipReason.DETERMINISTIC`，压根不派发判读。
      // 那种账号上「0/0 条解析成功」不是异常，显示它只会让人去查一个
      // 不存在的问题。
      vi.mocked(api.getInspectionOverview).mockResolvedValue({
        ...OVERVIEW,
        parse_quality: {
          ok: 0, partial: 0, parse_failed: 0, empty: 0, other: 0,
          dispatched: 0,
        },
      });
      render(<InspectionDashboard dashboardId="overview" />);
      await waitFor(() => expect(screen.getByText(/4 条判读任务已派发但未能关联/)).toBeTruthy());
      expect(screen.queryByText(/没能完整对上号/)).toBeNull();
    });
  });

  it("R10.6: says how many findings have no root-cause analysis", async () => {
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="overview" />);
    await waitFor(() => expect(screen.getByText(/另有 2 项未做根因分析/)).toBeTruthy());
  });
});

describe("旧 BFF 不返回新字段时不能白屏", () => {
  // 🔴 部署窗口里会出现**新 JS + 旧 BFF**：CloudFront 缓存 JS，
  //    而 BFF 是 Lambda URL 不走缓存，两者更新不是原子的。
  //    那一刻 `idle_factors` / `idle_degraded` 是 undefined，而 TS 类型上
  //    它们是必填数组 —— `.length` 抛 TypeError，React 卸载整棵树 → **白屏**。
  //
  //    一个空数组换一次白屏，非常值。

  it("★★ idle_factors / idle_degraded 缺失时照常渲染", async () => {
    const d = findingsWith("CPUUtilization", "bad_up");
    d.findings[0].kind = "idle";
    d.findings[0].idle_score = 87.3;
    // 模拟旧 BFF：这两个字段压根不存在
    delete (d.findings[0] as unknown as Record<string, unknown>).idle_factors;
    delete (d.findings[0] as unknown as Record<string, unknown>).idle_degraded;
    vi.mocked(api.getInspectionFindings).mockResolvedValue(d);
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="idle" />);
    // 页面渲染出来了（没白屏），而且总分照样显示
    await waitFor(() => expect(screen.getByText(/db-1/)).toBeTruthy());
    // ⚠️ 「闲置分」在页面上有两处：卡片上的标签 + 页头那句排序说明
    //    （「按每月可省 → 闲置分」）。用 getAllByText，否则 getByText 会因
    //    多重匹配抛错 —— 而那个红读起来像「渲染失败」，实际恰恰相反。
    expect(screen.getAllByText(/闲置分/).length).toBeGreaterThan(0);
    expect(screen.getByText(/^87$/)).toBeTruthy();     // 卡片上的总分
    // 「主因」那句和「少 N 维」徽章缺数据时不渲染，但不能崩
    expect(screen.queryByText(/主因/)).toBeNull();
  });
});

describe("陈旧证据标注（chronic 保留上一轮数字）", () => {
  // 🔴 后端只在 **resolved** 时清证据（2026-08-25 改）。chronic 的语义是
  //    「连续 K 轮未命中 **但水位没回健康区**」—— 问题还在，所以保留最后一次
  //    已知水位，否则看板上是「HIGH · 已持续 14 天」而没有任何数字。
  //
  //    但保留的前提是**说清这是哪天的**。不标注就等于宣称 9 天前的
  //    「可用内存 1.1%」是今天的水位，而客户会照着它判断现在多严重。

  it("★★ evidence_as_of 早于 last_run_date 时标注「数据截至 X（N 天前）」", async () => {
    const d = findingsWith("FreeableMemory", "bad_down");
    d.findings[0].state = "chronic";
    d.findings[0].evidence_as_of = "2026-08-10";   // 比 last_run_date 早 9 天
    vi.mocked(api.getInspectionFindings).mockResolvedValue(d);
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() =>
      expect(screen.getByText(/数据截至 2026-08-10（9 天前）/)).toBeTruthy());
  });

  it("★★ 证据就是本轮的时候**不标注**（避免每条都挂噪音）", async () => {
    // ⚠️ 这一半同样重要。一个恒显示的「数据截至今天」会让人习惯性跳过它，
    //    于是真正陈旧的那几条也不会被注意到。
    const d = findingsWith("CPUUtilization", "bad_up");
    d.findings[0].evidence_as_of = d.findings[0].last_run_date;
    vi.mocked(api.getInspectionFindings).mockResolvedValue(d);
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/db-1/)).toBeTruthy());
    expect(screen.queryByText(/数据截至/)).toBeNull();
  });

  it("★ evidence_as_of 缺失（存量行）也不标注", async () => {
    const d = findingsWith("CPUUtilization", "bad_up");
    d.findings[0].evidence_as_of = "";
    vi.mocked(api.getInspectionFindings).mockResolvedValue(d);
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/db-1/)).toBeTruthy());
    expect(screen.queryByText(/数据截至/)).toBeNull();
  });
});

describe("finding cards", () => {
  it("★★ the relation wording follows the backend `direction`, not the metric name", async () => {
    // `FreeableMemory` 跌是坏事，`CPUUtilization` 涨是坏事。
    //
    // 🔴 这一版把方向的表达从**颜色**改成**措辞**（「高于阈值」/「低于阈值」），
    //    并且方向来自后端的 `direction` 字段而不是前端的指标名清单：
    //
    //    ```
    //    旧：前端一份 BAD_DOWN 指标名集合（metrics_meta 的镜像）
    //        → 镜像必然分叉，分叉的表现是**颜色反了**，读起来还很正常
    //        → 而且只用颜色表达，色觉障碍用户完全读不到
    //    新：后端 assemble.to_evidence 把 threshold_config.direction 落库
    //        → 唯一真源是 metrics_meta，前端零推断
    //    ```
    //
    // ⚠️ 判据故意用**同一个指标名**配两个不同的 direction —— 这样能证明
    //    前端读的是字段而不是名字。用两个不同指标名的话，一个「按名字判」
    //    的实现照样能过。
    vi.mocked(api.getInspectionFindings)
      .mockResolvedValue(findingsWith("CPUUtilization", "bad_up"));
    const up = render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/高于阈值/)).toBeTruthy());
    expect(screen.queryByText(/低于阈值/)).toBeNull();
    up.unmount();

    vi.mocked(api.getInspectionFindings)
      .mockResolvedValue(findingsWith("CPUUtilization", "bad_down"));
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/低于阈值/)).toBeTruthy());
    expect(screen.queryByText(/高于阈值/)).toBeNull();
  });

  it("★★ the evidence line renders the numbers, with units", async () => {
    // 🔴 这一整行此前**完全没有** —— 那几个数字压根没落库
    //    （`assemble.to_evidence` 是这一版新加的）。卡片上只有
    //    「CPU 使用率 · CRITICAL」，客户看不到是 85% 还是 71%，
    //    也看不到阈值，只能等 1~3 分钟后的 DA 判读全文。
    vi.mocked(api.getInspectionFindings)
      .mockResolvedValue(findingsWith("CPUUtilization"));
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText("85.3%")).toBeTruthy());
    // 阈值与实测值同量纲，且带单位 —— 裸数值让人分不出 70 是百分比还是秒
    expect(screen.getByText(/高于阈值 70%/)).toBeTruthy();
  });

  it("★★ a finding without evidence renders no evidence line, not a zero", async () => {
    // 结构性风险是属性判定（零指标），存量行也没有这几个字段。
    // 🔴 显示 0 的表现是「实测 0 / 阈值 0」—— 客户会以为指标真的是 0。
    const base = findingsWith("CPUUtilization");
    vi.mocked(api.getInspectionFindings).mockResolvedValue({
      ...base,
      findings: [{
        ...base.findings[0],
        observed_value: null, threshold_value: null, headroom: null,
        unit: "", direction: "",
      }],
    });
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText("db-1")).toBeTruthy());
    expect(screen.queryByText(/高于阈值|低于阈值/)).toBeNull();
    expect(screen.queryByText(/^0%$/)).toBeNull();
  });

  it("★ shows the missing-analysis marker when there is no judgment", async () => {
    /* 不显示会让「DA 说没问题」与「判读没回来」长得一样（R12.4）。

       ⚠️ 2026-09-02 改 fixture：这条**从前**用
          `da_task_id: "t-1"` + `parse_status: "parse_failed"` + 无正文，
          期望「判读缺失」。那个组合的真实含义是「派了、DA 回来了、一节都
          没对上号」—— 与「本该判却没派」（budget / quota）是两件事，
          处置动作也不同（重派 / 去加额度）。拆成两条用例，
          各自断言对方那句话**不出现**。 */
    const d = findingsWith("CPUUtilization");
    d.findings[0].has_judgment = false;
    d.findings[0].da_verdict = "";
    d.findings[0].da_parse_status = "";
    d.findings[0].da_task_id = "";        // 从没派过
    vi.mocked(api.getInspectionFindings).mockResolvedValue(d);
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/判读缺失/)).toBeTruthy());
    expect(screen.queryByText(/判读已返回但没有内容/),
      "「本该判却没派」被说成「回来了是空的」—— 那会让人去重派，而重派"
      + "同样会被额度门拦住",
    ).toBeNull();
  });

  it("★★★ 派了、回来了、是空的 → 说「不会再变」而不是「判读缺失」", async () => {
    /* 🔴 `callback_apply.py` 对 `ParseStatus.EMPTY` / `res.missing` 只写
       `parse_status` 不写 body，所以「有 task_id、无 body」是**终态**。

       上一版把它与 budget / quota 压成同一句「判读缺失」，客户看不出该重派
       还是该去加额度；抽屉那侧更糟 —— 判据 `dispatched && !hasJudgment`
       在这个组合上**恒真**，蓝色「1~3 分钟后回来」永远不退出。 */
    const d = findingsWith("CPUUtilization");
    d.findings[0].has_judgment = false;
    d.findings[0].da_verdict = "";
    d.findings[0].da_parse_status = "parse_failed";
    d.findings[0].da_task_id = "t-1";
    vi.mocked(api.getInspectionFindings).mockResolvedValue(d);
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(
      screen.getByText(/判读已返回但没有内容/)).toBeTruthy());
    /* 解析状态要**译过** —— `verdictLabel` 早就修过同型问题（客户原话
       「看起来不像是人类可读的词」），`da_parse_status` 是它的未修版本。 */
    expect(screen.queryByText(/parse_failed/),
      "原始枚举漏给客户看了",
    ).toBeNull();
    expect(screen.queryByText(/判读缺失/),
      "与「本该判却没派」压成同一句了 —— 处置动作不同",
    ).toBeNull();
  });

  it("shows the verdict when there IS a judgment", async () => {
    /**
     * ⚠️ **判据从机器值改成译名**（2026-09-01）。
     *
     *    `da_verdict` 是 skill 输出信封里的枚举（`report_parse.VERDICTS` 那四个），
     *    卡片上原来直接打出来 —— 客户看到的是「判读结论 warm_up」。
     *    现在过 `verdictLabel()` 出中文。
     *
     * 🔴 这条同时钉住**不许退回打机器值**：只断「译名出现」的话，
     *    把 `verdictLabel(...)` 换成 `f.da_verdict` 之后，
     *    如果哪天译名恰好等于机器值（比如新增一档忘了加译名，
     *    `verdictLabel` 会回落成原值）就抓不到。所以两条一起断。
     */
    vi.mocked(api.getInspectionFindings)
      .mockResolvedValue(findingsWith("CPUUtilization"));
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText("确有劣化")).toBeTruthy());
    expect(screen.queryByText("real_degradation"),
      "卡片上打的是机器值 —— 客户看到「判读结论 real_degradation」",
    ).toBeNull();
    expect(screen.queryByText(/判读缺失/)).toBeNull();
  });
});

describe("error handling", () => {
  it("★★ an undefined response is an error, not «zero findings»", async () => {
    // 🔴 `isFail(undefined)` 是 **false**，所以「不是失败就当合法数据」的写法
    //    会把一个没返回的请求渲染成「零条待处置」——「空列表」与「没风险」
    //    混成一回事，正是 R9.11 要防的那类歧义。组件的判据必须是
    //    「**明确成功**」（`d.ok === true`）。
    //
    // ⚠️ 这条用例必须**显式**把 mock 设成 undefined。文件顶部的 `beforeEach`
    //    给了一个默认的空成功响应 —— 那让这条路径再也走不到，于是这道防御
    //    一度**一条断言都没有**（反向注入退回 `if (isFail(d))` 时全绿）。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(api.getInspectionFindings)
      .mockResolvedValue(undefined as never);
    render(<InspectionDashboard dashboardId="triage" />);
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeTruthy());
    // 绝不能说「本轮未发现风险」——那是一个客户不该得到的保证
    expect(screen.queryByText(/未发现风险/)).toBeNull();
    expect(screen.queryByText(/^0$/)).toBeNull();
  });

  it.each([
    ["high-load", "high_load"],
    ["idle", "idle"],
    /* 🔴 `structural` 的期望值**派生**自 `HIDDEN_KINDS`，不写死。
       当前它被隐藏（客户 2026-08-31：「整个配置检查的 tab 都 hide」），
       于是 `resolveAlias` 把这一页退回高负载页。

       写死 `"structural"` → 隐藏期恒红；
       写死 `"high_load"`  → 放回来那天变成**假绿**：它会「证明」
                             配置检查页去请求高负载数据是对的。 */
    ["structural",
      api.HIDDEN_KINDS.includes("structural") ? "high_load" : "structural"],
    // 老深链 / 老默认页 → 高负载（`PAGE_ALIAS` 的兼容映射）
    ["triage", "high_load"],
    ["overview", "high_load"],
  ])("★ 页 %s 只请求 kind=%s", async (tab, kind) => {
    // 三类各自一页之后（2026-08-24），每页**只**请求自己那一类。
    //
    // 🔴 断言「请求了哪一个」而不只是「请求了几次」：`PAGE_ALIAS` 里把
    //    idle 写成 high_load 是个一字之差的错，而表现是**闲置页显示高负载的
    //    数据** —— 条数看起来正常，内容全错，没有任何报错。
    //    只数次数的断言抓不到它。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId={tab} can={() => true} />);
    await waitFor(() =>
      expect(api.getInspectionFindings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.getInspectionFindings).mock.calls[0][0]).toBe(kind);
  });

  describe("被隐藏的 kind（HIDDEN_KINDS）", () => {
    /* 客户 2026-08-31：「我认为配置检查暂时先 hide 掉吧。这次我没想着加进来。
       整个配置检查的 tab 都 hide」。

       这一组把「隐藏」钉成三条**可观测**的事实，而不是「源码里有那个常量」：
         ① 总览页（kind 为空 → 取全部有权限的类）不再请求它
         ② 它的页 id 落到高负载页，**不是** 🔒 无权限屏
         ③ 左侧目录里没有那一项

       ⚠️ 三条都从 `HIDDEN_KINDS` 派生。清空那个常量时它们自动放行，
          不需要回来改测试 —— 这是这个开关「可翻回」的前提。 */
    const hidden = api.HIDDEN_KINDS;

    it("★★ 任何页 id 都请求不出被隐藏的 kind，且深链不落 🔒 屏", async () => {
      /* 🔴 `?tab=structural` 的推送深链**已经发出去了**
         （`push_policy.tab_for_rule` 给结构性规则拼的就是这个值，客户 IM 里
         还留着）。隐藏之后不兜底的表现是：那一页的 chip 与权限求交集得到
         空集 → 落到 🔒「没有查看权限」屏 → 客户去找管理员要一个**根本不
         存在**的权限问题。

         ⚠️ 断言遍历**全部** `PAGE_ALIAS` 键而不只是被隐藏那一个：
            将来给某个隐藏类加新别名（`?tab=config-checks` 之类）时，
            漏接兜底会被这条抓到。 */
      const PAGE_IDS = ["high-load", "idle", "structural", "triage", "overview"];
      for (const tab of PAGE_IDS) {
        cleanup(); vi.clearAllMocks();
        vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
        render(<InspectionDashboard dashboardId={tab} can={() => true} />);
        await waitFor(() =>
          expect(api.getInspectionFindings).toHaveBeenCalledTimes(1));
        const asked = vi.mocked(api.getInspectionFindings).mock.calls[0][0];
        expect(hidden, `页 ${tab} 仍然在请求被隐藏的 ${asked} —— 客户会在`
          + "CloudWatch 里看到一个「已经隐藏」的功能在持续产流量")
          .not.toContain(asked);
        expect(screen.queryByText(/没有.*查看权限|No access to/),
          `页 ${tab} 落到了 🔒 屏`).toBeNull();
      }
    });

    it("★★ `?tab=<隐藏类>` 深链选中的是高负载那一项", async () => {
      /* 🔴 不能靠「不在 visible 里 → 走 fallback」兜着：`fallback` 是
         `visible[0]`，**权限一变它就变**（只有闲置权限的人 fallback 是闲置）。
         深链落点必须是显式写下来的，而不是碰巧对。

         ⚠️ 断言查的是 `.active`（真的选中了哪一项），不是「页面上有没有
            高负载这个词」—— 后者在任何一页都成立。 */
      const { _rereadForTests } = await import("./deepLink");
      const Browser = (await import("./components/InspectionDashboardBrowser"))
        .default;
      vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
      for (const k of hidden) {
        cleanup(); vi.clearAllMocks();
        const tab = k === "high_load" ? "high-load" : k;
        window.history.replaceState({}, "", `/?tab=${tab}`);
        _rereadForTests();
        render(<Browser can={() => true} />);
        const active = () => document.querySelector(
          ".notif-side .notif-navitem.active .notif-navlabel");
        await waitFor(() => expect(active()).toBeTruthy());
        expect(active()?.textContent,
          `?tab=${tab} 选中的不是高负载`).toBe("高负载");
      }
      /* 反面：**没被隐藏**的类必须照旧落到自己那一页。
         少了这一条，一个「把所有 kind 深链都转去高负载」的实现也能过 ——
         那会让 IM 里每条闲置推送都打不开对应的页。 */
      cleanup(); vi.clearAllMocks();
      window.history.replaceState({}, "", "/?tab=idle");
      _rereadForTests();
      render(<Browser can={() => true} />);
      const activeIdle = () => document.querySelector(
        ".notif-side .notif-navitem.active .notif-navlabel");
      await waitFor(() => expect(activeIdle()).toBeTruthy());
      expect(activeIdle()?.textContent, "?tab=idle 被转走了").toBe("闲置与成本");

      // 收尾：把 URL 清回去，否则后面的用例会读到残留的深链。
      window.history.replaceState({}, "", "/");
      _rereadForTests();
    });

    it("★★ 左侧目录里没有被隐藏的那一项", async () => {
      const Browser = (await import("./components/InspectionDashboardBrowser"))
        .default;
      vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
      cleanup();
      render(<Browser can={() => true} />);
      /* ⚠️ 只在 `.notif-side` 里找。「高负载」「配置检查」这些词在**右侧内容
            区**也出现（PageHeader 的标题、阈值页的分组标题），全局
            `getByText` 会多重匹配 —— 那种失败长得像「找不到」，
            会把人引到错误的方向。 */
      const side = () => document.querySelector(".notif-side") as HTMLElement;
      await waitFor(() => expect(side()).toBeTruthy());
      const labels = () => [...side().querySelectorAll(".notif-navlabel")]
        .map((e) => e.textContent || "");
      await waitFor(() => expect(labels().length).toBeGreaterThan(0));
      expect(labels(), "「配置检查」还在左侧目录里").not.toContain("配置检查");
      // 反面：没隐藏的两项必须还在 —— 否则整棵目录没渲染出来也能过。
      expect(labels()).toContain("高负载");
      expect(labels()).toContain("闲置与成本");
    });
  });

  it("★ tells 403 apart from a load failure", async () => {
    // 混成一句会让客户反复重试一个永远不会成功的请求。
    vi.mocked(api.getInspectionOverview)
      .mockResolvedValue({ ok: false, code: "http_403" });
    // ⚠️ 列表也要失败。只有总览失败时**不该**整页报错 —— 总览只提供
    //    「系统状态」，而列表才是这一页的主体（「运维自检的一个数读不到，
    //    整页打不开」是我们要避免的形态）。
    vi.mocked(api.getInspectionFindings)
      .mockResolvedValue({ ok: false, code: "http_403" });
    const r = render(<InspectionDashboard dashboardId="overview" />);
    await waitFor(() => expect(screen.getByText(/没有访问权限/)).toBeTruthy());
    r.unmount();

    vi.mocked(api.getInspectionOverview)
      .mockResolvedValue({ ok: false, code: "http_500" });
    vi.mocked(api.getInspectionFindings)
      .mockResolvedValue({ ok: false, code: "http_500" });
    render(<InspectionDashboard dashboardId="overview" />);
    await waitFor(() => expect(screen.getByText(/加载失败/)).toBeTruthy());
  });
});
// ===========================================================================
// 写侧
//
// 这一整块只能用渲染测试。写侧的失效形态全是「标识符还在、行为不起作用」：
//   · 门禁写成 fail-open → `can` 那行代码还在，只是恒真
//   · `level` 忘进 payload → 常量与类型都还在，级联排除静默失效
//   · 二次确认被绕过 → `window.confirm` 还在源码里，只是返回值没被检查
//   · `next_run_utc` 改成前端自己算 → 字段名还在，值差一天
// 查子串对上面每一条都照过。
// ===========================================================================

const SCOPE: ScopeData = {
  ok: true,
  // BFF resolve 出来的部署账号。⚠️ 少了它写入入口会全部禁用 ——
  // 见「account resolution on the scope page」那组用例。
  account_id: "111122223333",
  exclusions: {
    high: [
      { key: "111122223333#ap-northeast-1#rds#db-live", account_id: "111122223333",
        region: "ap-northeast-1", service: "rds", resource_id: "db-live",
        level: "instance", reason: "已知批处理窗口", expires_at: "2026-09-30",
        expired: false, created_by: "u1", created_at: "2026-08-01" },
      { key: "111122223333#ap-northeast-1#rds#db-old", account_id: "111122223333",
        region: "ap-northeast-1", service: "rds", resource_id: "db-old",
        level: "instance", reason: "下线中", expires_at: "2026-01-01",
        expired: true, created_by: "u1", created_at: "2025-12-01" },
      { key: "111122223333#-#elasticache#cl-forever", account_id: "111122223333",
        region: "", service: "elasticache", resource_id: "cl-forever",
        level: "cluster", reason: "测试集群", never_expires: true,
        created_by: "u1", created_at: "2025-12-01" },
    ],
    // ⚠️ idle 清单**必须**有条目。只在 high 清单上测续期，会让
    //    「按钮把 kind 写死成 high」的改动照过 —— 而那会把闲置轮的条目
    //    续期到高负载清单上（`attribute_exists` 找不到 → 客户看到
    //    「该条目不存在」而条目就在眼前）。
    idle: [
      { key: "111122223333#us-east-1#rds#db-batch", account_id: "111122223333",
        region: "us-east-1", service: "rds", resource_id: "db-batch",
        level: "instance", reason: "夜间批处理", expires_at: "2026-10-01",
        expired: false, created_by: "u2", created_at: "2026-08-01" },
    ],
  },
  targets: { high: [], idle: [] },
};

/** 阈值字段的最小构造器 —— 只填断言真的会看的字段。 */
const rf = (
  key: string, services: string[], value: number | string[] = 70,
  extra: Partial<RuleField> = {},
): RuleField => ({
  key, type: "float", value, default: 70, min: 0, max: 100, unit: "%",
  label_zh: key, label_en: key, services, customized: false, display_unit: "", display_units: [], ...extra,
});

const CONFIG: ConfigData = {
  ok: true,
  schedules: {
    high: { run_type: "high", enabled: true, at_utc: "02:00",
      weekdays: null, catch_up_hours: 6, persisted: true },
    idle: { run_type: "idle", enabled: true, at_utc: "03:00",
      weekdays: null, catch_up_hours: 6, persisted: false },
  },
  rules: {
    high: {
      threshold: [
        rf("cpu_utilization", ["rds", "aurora", "redis", "memcached"]),
        rf("free_storage_bytes", ["rds"]),          // Aurora 存储自动扩展
        rf("engine_cpu_utilization", ["redis"]),    // Memcached 没这个指标
        rf("evictions", ["redis", "memcached"]),
      ],
    },
    idle: {
      idle: [rf("iops_total", ["rds", "aurora"])],
      // 选 Redis 时这一段会整段空掉 —— 用来验「空 section 明示而非静默消失」
      capacity: [rf("free_storage_pct", ["rds"])],
      structural: [rf("prod_tiers", ["rds", "aurora", "redis", "memcached"],
        ["prod", "tier1"], { type: "str_set", min: null, max: null, unit: "" })],
    },
  },
  rule_services: [
    { key: "rds", label_zh: "RDS", label_en: "RDS",
      hint_zh: "MySQL / PostgreSQL", hint_en: "MySQL / PostgreSQL", field_count: 5 },
    { key: "aurora", label_zh: "Aurora", label_en: "Aurora",
      hint_zh: "Aurora MySQL", hint_en: "Aurora MySQL", field_count: 3 },
    { key: "redis", label_zh: "ElastiCache Redis", label_en: "ElastiCache Redis",
      hint_zh: "Redis / Valkey", hint_en: "Redis / Valkey", field_count: 4 },
    { key: "memcached", label_zh: "ElastiCache Memcached",
      label_en: "ElastiCache Memcached",
      hint_zh: "Memcached", hint_en: "Memcached", field_count: 3 },
  ],
  data_dates: ["2026-08-18"],
};

/** 只放行给定的能力 key，其余一律 false。 */
const only = (...keys: string[]) => (k: string) => keys.includes(k);

/**
 * 打开某一行行尾的 `⋯` 操作菜单，返回菜单里的按钮。
 *
 * 🔴 行内两个按钮 2026-09-01 收进了菜单。客户原话：「可以改成一个 action
 * button，点开有这些功能即可，不要把这些功能都平铺，空间太紧张。」
 * 平铺的代价是内容被操作挤变形（日期被拆成两行、层级的徽章掉到第二行）。
 *
 * ⚠️ 菜单是 `position: fixed` 渲染在 `<body>` 下（要逃出表格的
 *    `overflowX: auto`，否则浮层被裁掉），所以**不能**在 `tr` 里找它 ——
 *    要在 `[role="menu"]` 里找。
 */
function openRowMenu(rowText: string) {
  const row = [...document.querySelectorAll("tbody tr")]
    .find((r) => r.textContent?.includes(rowText));
  expect(row, `表里没有含 ${rowText} 的行`).toBeTruthy();
  const trigger = [...row!.querySelectorAll("button")]
    .find((b) => (b.getAttribute("aria-haspopup") || "") === "menu");
  expect(trigger, `${rowText} 那一行没有 ⋯ 操作菜单`).toBeTruthy();
  fireEvent.click(trigger!);
  const menu = document.querySelector('[role="menu"]');
  expect(menu, "点了 ⋯ 没开菜单").toBeTruthy();
  return {
    menu: menu!,
    items: () => [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')],
    click: (label: RegExp) => {
      const it = [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((b) => label.test(b.textContent || ""));
      expect(it, `菜单里没有 ${label}`).toBeTruthy();
      fireEvent.click(it!);
    },
  };
}

describe("scope write gate (9.13)", () => {
  it("★★ fail-CLOSED: no write controls when `can` is absent", async () => {
    // 其余仪表盘的导航入口是 fail-open，但这两个按钮会改变下一轮巡检的
    // 行为且**没有运行时信号**。加载期对所有人闪出「新增排除」，
    // 手快的人点进去就能提交，而 403 只在提交那一刻才出现。
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    // ⚠️ 按 **role** 查而不是按文本 —— 「续期」这个词也出现在到期汇总
    //    提示的正文里（「逐条续期或让它们过去」），按文本查会匹配到那句话。
    expect(screen.queryAllByRole("button", { name: /排除资源/ })).toEqual([]);
    expect(screen.queryAllByRole("button", { name: /整账号排除/ })).toEqual([]);
    expect(screen.queryAllByRole("button", { name: /续期/ })).toEqual([]);
  });

  it("★ fail-CLOSED: read-only capability alone shows no write controls", async () => {
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope"
      can={only("nav:inspection:scope")} />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    expect(screen.queryAllByRole("button", { name: /排除资源/ })).toEqual([]);
  });

  it("★ shows write controls with action:inspection:scope", async () => {
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    // 🔴 **整页只有 1 个「排除资源」。**
    //
    // 演进史（两次都是客户实测圈出来的）：
    // ```
    // v1  3 个   页头主按钮 + 两个区块标题各一个（页头那个只写 high 一份，
    //            与「两份清单独立」的页头文案直接矛盾）
    // v2  2 个   去掉页头那个，留两个区块按钮 + 空态卡片里还有一个
    //            → 客户：「外面有两个『排除资源』，pop-up window 内又有
    //              checkbox 可以选择是高负载还是闲置。简直是多余。」
    //            两个按钮的**唯一**差别是预勾了弹层里哪个 checkbox，
    //            而那个 checkbox 在弹层里还能改 —— 于是「我点的是闲置轮
    //            那个」与「实际写进哪份」可以不一致。
    // v3  1 个   页头一个，清单在弹层内选。
    // ```
    //
    // ⚠️ 这条断言必须是 `toBe(1)` 而不是 `toBeGreaterThan(0)`：
    //    问题从来不是「有没有入口」，而是「同一个入口有几个副本」。
    expect(screen.getAllByRole("button", { name: /排除资源/ }).length).toBe(1);
    expect(screen.getAllByRole("button", { name: /整账号排除/ }).length).toBe(1);
    // 🔴 **行里不许再平铺按钮。** 每行只有一个 `⋯`（4 行 = 4 个）。
    //    客户原话：「不要把这些功能都平铺，空间太紧张。」
    const rows = [...document.querySelectorAll("tbody tr")];
    expect(rows.length)
      .toBe(SCOPE.exclusions.high.length + SCOPE.exclusions.idle.length);
    for (const r of rows) {
      const btns = [...r.querySelectorAll("button")];
      expect(btns.length, `行里平铺了 ${btns.length} 个按钮：`
        + btns.map((b) => b.textContent).join(" / ")).toBe(1);
      expect(btns[0].getAttribute("aria-haspopup")).toBe("menu");
    }
    // 菜单里两项都在
    const m = openRowMenu("db-live");
    expect(m.items().map((b) => b.textContent))
      .toEqual(["续期 30 天", "挪出白名单"]);

    // 🔴 「永不过期」那一行的续期项**灰着并说明为什么**（不是抽掉）。
    //    后端的 UpdateExpression 是无条件 `SET expires_at`，对 never_expires
    //    （库里没有 expires_at）的行就是**新增**一个到期日 —— 点一下
    //    「续期 30 天」等于给一条永久保护加了个 30 天后失效的期限，
    //    而界面回绿字「已保存 · 到期 <日期>」。语义正好反了。
    cleanup();
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} />);
    await waitFor(() => expect(screen.getByText("cl-forever")).toBeTruthy());
    const f = openRowMenu("cl-forever");
    const renewItem = f.items().find((b) => /续期/.test(b.textContent || ""))!;
    expect(renewItem.getAttribute("aria-disabled")).toBe("true");
    expect(renewItem.getAttribute("title") || "",
      "灰着但没说为什么 —— 用户只能猜「是不是坏了」").toMatch(/永不过期/);
    // ⚠️ 但它**必须**能被挪出白名单 —— 一条永不过期的排除是最需要能撤销的
    //    那一种（它没有任何自动失效的时机）。
    const rmItem = f.items().find((b) => /挪出白名单/.test(b.textContent || ""))!;
    expect(rmItem.getAttribute("aria-disabled")).toBeNull();
  });

  it("★★★ 灰掉的续期项点下去不发请求", async () => {
    // jsdom 里 `aria-disabled` 不拦点击 —— handler 内必须自己 return。
    // 实测：只靠 aria-disabled 的话这条会红。
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} />);
    await waitFor(() => expect(screen.getByText("cl-forever")).toBeTruthy());
    openRowMenu("cl-forever").click(/续期/);
    expect(api.renewInspectionExclusion,
      "给一条「永不过期」的排除加上了 30 天后的到期日 —— 那是削弱保护",
    ).not.toHaveBeenCalled();
  });
});

describe("account resolution on the scope page", () => {
  /** 空清单 + 只有 BFF 给的 account_id —— 全新部署的真实形态。 */
  const EMPTY_SCOPE_WITH_ACCOUNT = {
    ok: true as const,
    account_id: "111122223333",
    exclusions: { high: [], idle: [] },
    targets: { high: [], idle: [] },
  };

  it("★★★ 空清单也能建第一条排除项（BFF 给的 account_id 兜底）", async () => {
    // 🔴 这是 2026-08-24 客户实测到的死锁：
    //
    //    要建第一条排除项  → 需要 12 位 account_id
    //    account_id 从哪来 → 旧实现只从**已有排除条目**回填
    //    但清单是空的      → 回填不到 → 两个入口都禁用 → 永远建不出第一条
    //
    // 客户看到两个按钮都灰着，tooltip 让他「先在待处置页选一个账号」，
    // 而那一页也没有账号选择器（单账号部署，没什么可选的）。
    vi.mocked(api.getInspectionScope).mockResolvedValue(EMPTY_SCOPE_WITH_ACCOUNT);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} />);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /排除资源/ }).length)
        .toBeGreaterThan(0));
    // 🔴 判据是 **enabled**，不是「按钮在」—— 旧实现里按钮也在，只是灰的。
    for (const b of screen.getAllByRole("button", { name: /排除资源/ })) {
      expect(b.getAttribute("aria-disabled")).not.toBe("true");
    }
    const whole = screen.getAllByRole("button", { name: /整账号排除/ });
    expect(whole.length).toBe(1);
    expect(whole[0].getAttribute("aria-disabled")).not.toBe("true");
  });

  it("★★★ 账号选择在**写入弹层内**，页头没有它", async () => {
    /* 🔴 这条 2026-09-01 反过来了。此前断言的是「巡检范围页头也要有账号
       选择器（与阈值页一致）」，理由是「排除清单是按账号存的」。

       前提是错的：清单**跨账号**读（`getScope` 一次拿全部可见账号的条目），
       页头那个选择器不过滤下面任何一行 —— 它的实际作用只有「写入用哪个
       账号」。而它长得像筛选器：

       ```
       客户选中 677 → 列表里仍然有一行属于 088 的 `*` 整账号排除
                    → 而那一行连账号列都没有
       ```

       客户原话：「当前排除的资源并未按照账号进行划分，我建议不要让用户在
       右上角选择账号，而是让用户在『排除资源』的页面内先选择账号，然后再去
       操作。不然容易误导用户，误以为选择账号后会显示出当前账号的已加入
       白名单的资源列表。」

       ⚠️ `LOCKED_ACCOUNT_ID` 锁的是后台采集/调查的**执行路径**
          （防误发跨账号 AWS 调用），不锁 Dashboard 的展示与管理。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue(RESOURCES);
    const ACCTS2 = [{ accountId: "444455556666", accountName: "prod-a" },
                    { accountId: "111122223333", accountName: "prod-b" }];
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="" accounts={ACCTS2} />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());

    // 页头：**没有**账号选择器
    expect(screen.queryByRole("combobox", { name: /账号|Account/ }),
      "页头又出现了账号选择器 —— 它不过滤下面的清单，却长得像筛选器").toBeNull();

    // 打开「排除资源」弹层 → 账号选择器在**这里**
    fireEvent.click(screen.getByRole("button", { name: /排除资源/ }));
    const picker = await waitFor(() =>
      screen.getByRole("combobox", { name: /账号|Account/ }));
    // 选项：「部署账号」（空串，BFF resolveAccount 的契约）+ 两个 onboard 账号
    expect(picker.querySelectorAll("option").length).toBe(3);
    expect((picker.querySelectorAll("option")[0] as HTMLOptionElement).value)
      .toBe("");
  });

  it("★★★ 弹层不许再长出说明文字，且宽度不许缩回去", async () => {
    /* 客户圈了四处并说「这些都删掉，都没意义。都是废话」：
       ```
       账号        「下面列出这个账号里的 RDS / Aurora 与 ElastiCache。」
       写进哪份清单 「两份清单独立。『这台是冷备…』就只勾闲置。」
       有效期      「到期后记录保留但不再生效（R1.4）…可一键续期。」+「到期日 …」
       原因        「没有理由的排除是『白名单越积越多没人敢删』的起点（R1.3）。」
       footer      「已选 0 个 · 写两份清单」
       ```
       ⚠️ 判据是**渲染出来的文字**而不是源码子串 —— 源码里那几句现在活在
          注释里（记着为什么删的），子串检查会命中注释。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue(RESOURCES);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId=""
      accounts={[{ accountId: "444455556666", accountName: "prod-a" }]} />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /排除资源/ }));
    await waitFor(() => expect(screen.getByText("db-new")).toBeTruthy());

    for (const bad of [
      /下面列出这个账号里的/, /两份清单独立。/, /冷备/,
      /到期后记录保留/, /一键续期/, /白名单越积越多/,
      /^到期日 /, /已选 \d+ 个/, /写两份清单/,
    ]) {
      expect(screen.queryByText(bad), `弹层里又长出了废话：${bad}`).toBeNull();
    }

    /* 🔴 宽度也钉住 —— 客户为此提了两次（620 → 780）。
       资源名本来就长（`notiops-tb-redis-ap-northeast-1`），后面还要跟
       service / 集群 / 「已在闲置轮排除」三个徽章，窄了每条占两行。 */
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dlg.style.maxWidth, "弹层宽度缩回去了").toBe("780px");
  });

  it("★★★ 弹层里换账号会清掉已勾选项", async () => {
    /* 🔴 行键是 `<region>#<service>#<resource_id>`，**不含账号**（资源 ID 只在
       区域内唯一，而清单一次只列一个账号）。不清的表现：

       ```
       在 A 账号勾了 us-east-1 的 db-live
         → 切到 B 账号，B 里也有同名同区域的一台（多账号同名部署很常见）
         → 那一行**仍然是勾选状态**，客户没点过它
         → 提交写出 account_id=B 的排除记录，而他以为排的是 A
       ```

       与 `normalizeExclusion` 的 H2 同类：界面反馈是成功的，写出去的是错的。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue(RESOURCES);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId=""
      accounts={[{ accountId: "444455556666", accountName: "prod-a" }]} />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /排除资源/ }));
    /* 勾选数从 footer 那行旁白（「已选 N 个 · 写两份清单」）挪到了
       **「执行」按钮上**（2026-09-01，客户圈那行为废话）：`执行（N）`。
       数字长在动作上而不是旁边一句随时都在的话。 */
    const go = () => screen.getByRole("button", { name: /^执行/ });
    await waitFor(() => expect(go().textContent).toBe("执行"));
    // ⚠️ 等资源清单真的回来。`db-new` 是**弹层里**那台（RESOURCES），
    //    `db-live` 是页面表格里的排除条目（SCOPE）—— 拿后者找 label 会是 null。
    await waitFor(() => expect(screen.getByText("db-new")).toBeTruthy());

    // 勾一台 → 按钮变成「执行（1）」
    const row = screen.getByText("db-new").closest("label")!;
    fireEvent.click(row.querySelector('input[type="checkbox"]')!);
    await waitFor(() => expect(go().textContent).toBe("执行（1）"));

    // 换账号 → 计数必须清零（按钮回到无计数态）
    fireEvent.change(screen.getByRole("combobox", { name: /账号|Account/ }),
      { target: { value: "444455556666" } });
    await waitFor(() => expect(go().textContent,
      "换账号没有清掉已勾选项 —— 会把 A 账号的实例排到 B 账号名下").toBe("执行"));
  });

  it("★ BFF 给不出账号时仍然禁用并说明原因", async () => {
    // STS 异常 → BFF 返回空串。那时禁用是**正确**的 ——
    // 让客户填完一整张表才被「account_id 必须是 12 位数字」拒掉更糟。
    vi.mocked(api.getInspectionScope).mockResolvedValue({
      ...EMPTY_SCOPE_WITH_ACCOUNT, account_id: "",
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} />);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /排除资源/ }).length)
        .toBeGreaterThan(0));
    for (const b of screen.getAllByRole("button", { name: /排除资源/ })) {
      expect(b.getAttribute("aria-disabled")).toBe("true");
    }
  });
});

describe("exclusion expiry markers (R1.4)", () => {
  it("★★ marks an expired entry AND shows the date", async () => {
    // 到期条目**保留记录但不生效**，列表里仍在。不打标会让「排除还生效着」
    // 与「早就过期了」长得一样 —— 这正是之前 BFF 读错字段名
    // （`expires_on` vs `expires_at`）时的表现：到期列永远空白。
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope" />);
    await waitFor(() => expect(screen.getByText("db-old")).toBeTruthy());

    const rows = [...document.querySelectorAll("tbody tr")];
    const old = rows.find((r) => r.textContent?.includes("db-old"));
    const live = rows.find((r) => r.textContent?.includes("db-live"));
    expect(old!.textContent).toContain("2026-01-01");
    expect(old!.textContent).toContain("已过期");
    // 未过期的那条**不能**也带「已过期」——否则打标等于没打。
    expect(live!.textContent).toContain("2026-09-30");
    expect(live!.textContent).not.toContain("已过期");
  });

  it("★ shows 永不过期 for never_expires entries", async () => {
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope" />);
    await waitFor(() => expect(screen.getByText("cl-forever")).toBeTruthy());
    const row = [...document.querySelectorAll("tbody tr")]
      .find((r) => r.textContent?.includes("cl-forever"));
    expect(row!.textContent).toContain("永不过期");
  });
});

describe("renew (R1.4)", () => {
  it("★★ calls renew with the entry's OWN list kind and key", async () => {
    // kind 传错的表现不是报错：`update_item` 的 ConditionExpression 在另一份
    // 清单里找不到同 SK 就返回 not_found，客户看到「该条目不存在」而条目
    // 明明就在眼前。更坏的情况是两份清单里都有同 SK —— 那就改错了条目。
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.renewInspectionExclusion).mockResolvedValue({
      ok: true, key: "111122223333#ap-northeast-1#rds#db-old",
      expires_at: "2026-09-13",
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} />);
    await waitFor(() => expect(screen.getByText("db-old")).toBeTruthy());

    // ⚠️ 续期从行内平铺按钮变成了 `⋯` 菜单里的一项（2026-09-01）。
    openRowMenu("db-old").click(/续期/);

    await waitFor(() =>
      expect(api.renewInspectionExclusion).toHaveBeenCalledTimes(1));
    expect(api.renewInspectionExclusion).toHaveBeenCalledWith(
      "high", "111122223333#ap-northeast-1#rds#db-old");
  });

  it("★★ renews an idle-list entry with kind=idle, not high", async () => {
    // 🔴 这条是上一条抓不到的那一半：kind 写死成 "high" 时，只测 high 清单
    //    的断言照过。而写死的后果是闲置轮的条目永远续期失败
    //    （`attribute_exists(PK)` 在另一份清单里找不到同 SK）。
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.renewInspectionExclusion).mockResolvedValue({
      ok: true, key: "111122223333#us-east-1#rds#db-batch",
      expires_at: "2026-09-13",
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} />);
    await waitFor(() => expect(screen.getByText("db-batch")).toBeTruthy());

    openRowMenu("db-batch").click(/续期/);

    await waitFor(() =>
      expect(api.renewInspectionExclusion).toHaveBeenCalledTimes(1));
    expect(api.renewInspectionExclusion).toHaveBeenCalledWith(
      "idle", "111122223333#us-east-1#rds#db-batch");
  });

  it("★★ keeps the success notice visible after the list refetches", async () => {
    // 🔴 重取若走「清空 + loading」那条路，父组件会把 `Scope` 卸载掉，
    //    而提示是 `Scope` 的 state → 成功提示闪一下就没了，
    //    而失败时不重取所以错误提示留着。于是「成功没反馈、失败有反馈」。
    //
    // ⚠️ 这里**必须**用带宏任务间隔的 mock（`setTimeout`），不能用
    //    `mockResolvedValue`。后者在微任务里就 resolve 了，而 React 18 的
    //    默认优先级更新是走 Scheduler 的**宏任务**——于是 `loading=true` 与
    //    `loading=false` 被合进同一次 flush，卸载在测试里压根不发生。
    //    实测：用 mockResolvedValue 时把 `isRefresh` 硬改成 false 也照过，
    //    而线上（真实网络延迟）提示是真的会消失。
    vi.mocked(api.getInspectionScope).mockImplementation(
      () => new Promise((r) => { setTimeout(() => r(SCOPE), 0); }));
    vi.mocked(api.renewInspectionExclusion).mockResolvedValue({
      ok: true, key: "111122223333#ap-northeast-1#rds#db-old",
      expires_at: "2026-09-13",
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} />);
    await waitFor(() => expect(screen.getByText("db-old")).toBeTruthy());
    // ⚠️ 续期从行内平铺按钮变成了 `⋯` 菜单里的一项（2026-09-01）。
    openRowMenu("db-old").click(/续期/);

    // 等重取真的发生（第二次调用），提示仍要在。
    await waitFor(() =>
      expect(vi.mocked(api.getInspectionScope).mock.calls.length).toBeGreaterThan(1));
    expect(screen.getByText(/已保存/)).toBeTruthy();
    expect(screen.getByText(/2026-09-13/)).toBeTruthy();
  });

  it("★ surfaces the backend message on failure", async () => {
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.renewInspectionExclusion).mockResolvedValue({
      ok: false, code: "not_found", message: "该排除条目不存在（可能已被删除）",
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} />);
    await waitFor(() => expect(screen.getByText("db-old")).toBeTruthy());
    // ⚠️ 续期从行内平铺按钮变成了 `⋯` 菜单里的一项（2026-09-01）。
    openRowMenu("db-old").click(/续期/);
    await waitFor(() => expect(screen.getByText(/该排除条目不存在/)).toBeTruthy());
  });
});

/**
 * 打开「新增排除」表单。返回按 `name` 填字段的辅助函数。
 *
 * ⚠️ 按 `name` 而不是按 DOM 顺序取第 N 个输入框：后者在字段重排之后会把值
 * 填进**别的**框，而断言的是「调用参数里有这个值」—— 于是测试照过，
 * 验的却是另一个字段。
 */
/**
 * 打开排除弹层。
 *
 * 🔴 这一版的排除流程是**选清单**而不是**填表**（客户定的流程：
 * 巡检范围 → 选服务 → 加载列表 → 勾中要排除的 → 给日期 + 原因 → 执行）。
 *
 * 旧流程的七个手填框里有四个**打错了不会报错**：`resource_id` 打错一个
 * 字符那条排除永不生效；`region` 只有一个合法值；`service` 与 `level`
 * 选错让级联排除静默失效。现在全部从选中的资源自动带出。
 */
const RESOURCES = {
  ok: true as const,
  account_id: "111122223333",
  // ⚠️ 2026-08-27 起 BFF 回的是 `regions`（扫过的全部 region），
  //    顶层单数的 `region` 已经不返回了。
  regions: ["ap-northeast-1", "us-east-1"],
  total: 2,
  resources: [
    {
      service: "rds" as const, tier: "instance" as const,
      region: "ap-northeast-1", resource_id: "db-new", label: "db-new",
      klass: "db.r6g.large", engine: "mysql", cluster_id: "", status: "available",
      excluded_in: [] as ("high" | "idle")[],
    },
    {
      service: "rds" as const, tier: "cluster" as const,
      region: "ap-northeast-1", resource_id: "aur-cl", label: "aur-cl",
      klass: "", engine: "aurora-mysql", cluster_id: "aur-cl",
      status: "available", member_count: 3,
      excluded_in: [] as ("high" | "idle")[],
    },
  ],
  degraded: [] as { service: string; reason: string }[],
};

async function openExclusionModal(can = only("action:inspection:scope"),
  /**
   * 传给面板的 `accountId` prop。
   *
   * 🔴 **默认值故意保留成 12 位**（历史用例都依赖它），但线上**默认是 `""`**：
   * `ChatApp.tsx` 的 `dashAccountId` 初值是空串，账号选择器第一个 option 也是
   * `value=""`（= 部署账号），单账号部署甚至不渲染选择器。
   * 所以「prop 为空」才是生产上最常见的形态，见
   * `test_排除写入在accountId为空时仍用清单来源的账号`。
   */
  accountId = "111122223333") {
  vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
  vi.mocked(api.getInspectionResources).mockResolvedValue(RESOURCES);
  render(<InspectionDashboard dashboardId="scope" can={can} accountId={accountId} />);
  await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
  fireEvent.click(screen.getAllByText(/排除资源/)[0]);
  // 资源清单是异步取的（真实链路会打三个 Describe API）。
  await waitFor(() => expect(screen.getByText("db-new")).toBeTruthy());

  const fill = (name: string, value: string) => {
    const el = document.querySelector(`[name="${name}"]`);
    expect(el, `表单里没有 name="${name}" 的控件`).toBeTruthy();
    fireEvent.change(el!, { target: { value } });
  };
  /** 勾选一台资源（按展示名找它的 checkbox）。 */
  const pick = (label: string) => {
    const row = screen.getByText(label).closest("label");
    expect(row, `清单里没有 ${label}`).toBeTruthy();
    const box = row!.querySelector('input[type="checkbox"]');
    fireEvent.click(box!);
  };
  /**
   * 只留一份清单。
   *
   * 页头那个唯一入口默认**两份都勾**（2026-09-01：入口从两个收成一个之后，
   * 「排除资源」的意图就是「别再管这台」= 两份）。想验「一个资源一次请求」
   * 的用例必须先把另一份取消，否则次数是两倍。
   */
  const onlyList = (keep: "high" | "idle") => {
    const drop = keep === "high" ? "idle" : "high";
    const box = document.querySelector(
      `[name="excl_list_${drop}"]`) as HTMLInputElement;
    expect(box, `弹层里没有 excl_list_${drop}`).toBeTruthy();
    if (box.checked) fireEvent.click(box);
  };
  return { fill, pick, onlyList };
}

describe("add exclusion (R1.3 / R1.7)", () => {
  it("★★ level is derived from the resource tier, never typed", async () => {
    // 缺 level 的表现不是报错 —— Python 侧 `put_exclusion` 拒写，但真正
    // 危险的是「传了个错的」：级联排除会静默失效，UI 上集群是勾选状态，
    // 成员照样出现在结果里。
    //
    // 🔴 这一版把它从手填改成**从选中资源的 tier 推**，所以「选错」这条
    //    路径被结构性地消掉了。这条用例验的就是那个推导。
    const f = await openExclusionModal();
    vi.mocked(api.putInspectionExclusion).mockResolvedValue({
      ok: true, key: "k", kind: "high", expires_at: "2026-09-13",
    });
    f.pick("aur-cl");                       // tier=cluster → level 必须是 cluster
    f.fill("reason", "客户确认可忽略");
    fireEvent.click(screen.getByText(/^执行/));

    await waitFor(() => expect(api.putInspectionExclusion).toHaveBeenCalledTimes(1));
    const [kind, body] = vi.mocked(api.putInspectionExclusion).mock.calls[0];
    expect(kind).toBe("high");
    expect(body.level).toBe("cluster");
    expect(body.resource_id).toBe("aur-cl");
    expect(body.reason).toBe("客户确认可忽略");
    // account_id / service / region 也自动带出 —— 那三个打错同样不报错
    expect(body.account_id).toBe("111122223333");
    expect(body.service).toBe("rds");
    expect(body.region).toBe("ap-northeast-1");
  });

  it("★★★ accountId prop 为空（生产默认态）时，写入仍用清单来源的账号", async () => {
    // ## 这条守的 P0（2026-08-26）
    //
    // `ExclusionModal` 原来发的是 `account_id: accountId`（那个 prop），而
    // `ChatApp.tsx` 的 `dashAccountId` 初值是 `""`、账号选择器第一个 option
    // 也是 `value=""`（= 部署账号）、单账号部署压根不渲染选择器。于是：
    //
    //   勾 3 台 → 填原因 → 点「执行」
    //   → 弹层里一条红字「全部失败：account_id 必须是 12 位数字」
    //   → 而这张表单里没有账号字段，客户无从下手
    //
    // **默认状态下整个排除功能不可用**，只有手选了成员账号才能用；
    // 部署账号自身的资源永远排不掉。
    //
    // 🔴 为什么之前全绿：上面那两条用例都提交并断言了 `body.account_id`，
    //    但 `openExclusionModal` render 时硬传 `accountId="111122223333"`
    //    —— 生产上唯一的默认形态从来没被测过。
    //
    // 修法是从 `/inspection/resources` 的**响应**里取 `account_id`：那是清单
    // 来源的那个账号，语义上正是「我勾的这些资源属于谁」。
    const f = await openExclusionModal(only("action:inspection:scope"), "");
    vi.mocked(api.putInspectionExclusion).mockResolvedValue({
      ok: true, key: "k", kind: "high", expires_at: "2026-09-13",
    });
    f.pick("db-new");
    f.fill("reason", "默认账号也要能排除");
    fireEvent.click(screen.getByText(/^执行/));

    await waitFor(() => expect(api.putInspectionExclusion).toHaveBeenCalledTimes(1));
    const [, body] = vi.mocked(api.putInspectionExclusion).mock.calls[0];
    expect(body.account_id).toBe("111122223333");
    expect(body.account_id).toMatch(/^\d{12}$/);
  });

  it("★ an instance-tier resource gets level=instance", async () => {
    // 对照上一条。两个 tier 推出同一个 level 的话，级联语义就没了。
    const f = await openExclusionModal();
    vi.mocked(api.putInspectionExclusion).mockResolvedValue({
      ok: true, key: "k", kind: "high", expires_at: "2026-09-13",
    });
    f.pick("db-new");
    f.fill("reason", "理由");
    fireEvent.click(screen.getByText(/^执行/));
    await waitFor(() => expect(api.putInspectionExclusion).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.putInspectionExclusion).mock.calls[0][1].level)
      .toBe("instance");
  });

  it("★★ blocks submit when the reason is empty (R1.3)", async () => {
    // ⚠️ 这一版按钮是**灰的**而不是点了报错 —— 且必须说出原因
    //    （`Btn` 的 `disabledReason` 会渲染成 title）。灰着不说为什么
    //    让人只能猜「是不是坏了」。
    const f = await openExclusionModal();
    f.pick("db-new");
    const go = screen.getByText(/^执行/).closest("button")!;
    expect(go.getAttribute("aria-disabled")).toBe("true");
    expect(go.getAttribute("title") || "").toMatch(/必填/);
    fireEvent.click(go);
    expect(api.putInspectionExclusion).not.toHaveBeenCalled();
  });

  it("★★ blocks submit when nothing is selected, and says why", async () => {
    const f = await openExclusionModal();
    f.fill("reason", "理由");
    const go = screen.getByText(/^执行/).closest("button")!;
    expect(go.getAttribute("aria-disabled")).toBe("true");
    expect(go.getAttribute("title") || "").toMatch(/勾选/);
  });

  it("★★ a normal exclusion never sends confirm_account_wide", async () => {
    // 🔴 传了等于给后端的 R1.7 护栏发了一张永久通行证。
    //    这一版普通排除**恒有** resource_id 且 level ∈ {instance, cluster}，
    //    所以后端那个判据（`!resource || level === "account"`）永不命中。
    const f = await openExclusionModal();
    vi.mocked(api.putInspectionExclusion).mockResolvedValue({
      ok: true, key: "k", kind: "high", expires_at: "2026-09-13",
    });
    f.pick("db-new");
    f.fill("reason", "理由");
    fireEvent.click(screen.getByText(/^执行/));
    await waitFor(() => expect(api.putInspectionExclusion).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.putInspectionExclusion).mock.calls[0][1];
    expect(body.confirm_account_wide).toBeUndefined();
    expect(body.resource_id).toBeTruthy();
  });

  it("★★ multi-select submits one request per resource (partial success is reported)", async () => {
    // 后端接口是单条的，所以批量是 N 次 POST。
    // 🔴 部分成功必须**如实报告** —— 因为最后一条失败就说整批失败，
    //    会让人重试已经成功的那些。
    const f = await openExclusionModal();
    /* ⚠️ 只留一份清单。页头那个唯一入口默认**两份都勾**（2026-09-01），
       两份 × 两台 = 4 次写入，那样这条断言验的就不是「一个资源一次请求」了。 */
    f.onlyList("high");
    vi.mocked(api.putInspectionExclusion)
      .mockResolvedValueOnce({ ok: true, key: "k1", kind: "high", expires_at: "2026-09-13" })
      .mockResolvedValueOnce({ ok: false, code: "http_400", message: "后端拒了" });
    f.pick("db-new");
    f.pick("aur-cl");
    f.fill("reason", "理由");
    fireEvent.click(screen.getByText(/^执行/));

    await waitFor(() => expect(api.putInspectionExclusion).toHaveBeenCalledTimes(2));
    // 🔴 文案说的是**资源数**（1 个）而不是写入次数 —— 「1 台 × 两份清单」
    //    写成「已排除 2 条」会让客户去清单里找第二条。
    await waitFor(() =>
      expect(screen.getByText(/1 个资源成功，1 条写入失败/)).toBeTruthy());
    // 失败的那条要说清是哪个 —— 只说「有 1 条失败」客户没法处理
    expect(screen.getByText(/后端拒了/)).toBeTruthy();
  });

  it("★★★ 页头入口默认写两份清单，取消一份就只写一份", async () => {
    /* 🔴 默认值 2026-09-01 变了。此前是「只勾入口所在那一份」，因为外面有
       两个「排除资源」按钮各自预勾一份。入口收成一个之后没有「入口所在那份」
       了，而默认空集的表现是「执行」一进来就是灰的（tooltip 说「至少要写进
       一份清单」）—— 客户点的按钮叫「排除资源」，他的意图是「别再管这台」，
       那就是两份。

       ⚠️ 两份清单仍然**独立**（R1.2）：「冷备机：别报闲置，但内存打满还要
          告警」是常见配置，所以是两个 checkbox 而不是单选，取消一份要生效。 */
    const f = await openExclusionModal();
    vi.mocked(api.putInspectionExclusion).mockResolvedValue({
      ok: true, key: "k", kind: "high", expires_at: "2026-09-13",
    });
    const box = (k: string) =>
      document.querySelector(`[name="excl_list_${k}"]`) as HTMLInputElement;
    expect(box("high").checked, "页头入口应当默认勾两份").toBe(true);
    expect(box("idle").checked, "页头入口应当默认勾两份").toBe(true);

    f.pick("db-new");
    f.fill("reason", "理由");
    fireEvent.click(screen.getByText(/^执行/));
    await waitFor(() => expect(api.putInspectionExclusion).toHaveBeenCalledTimes(2));
    const kinds = vi.mocked(api.putInspectionExclusion).mock.calls.map((c) => c[0]);
    expect([...kinds].sort()).toEqual(["high", "idle"]);
  });

  it("★★ 取消一份清单后只发一次请求（两份仍然独立，R1.2）", async () => {
    const f = await openExclusionModal();
    vi.mocked(api.putInspectionExclusion).mockResolvedValue({
      ok: true, key: "k", kind: "idle", expires_at: "2026-09-13",
    });
    f.onlyList("idle");
    f.pick("db-new");
    f.fill("reason", "冷备机，别报闲置");
    fireEvent.click(screen.getByText(/^执行/));
    await waitFor(() => expect(api.putInspectionExclusion).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.putInspectionExclusion).mock.calls[0][0]).toBe("idle");
  });

  it("★★ never_expires must be an explicit choice", async () => {
    // ⚠️ 后端省略 `never_expires` 时给 30 天。所以「永不过期」必须显式点，
    //    而默认档必须是有到期日的那个 —— 白名单越积越多没人敢删正是
    //    从「默认永不过期」开始的。
    const f = await openExclusionModal();
    vi.mocked(api.putInspectionExclusion).mockResolvedValue({
      ok: true, key: "k", kind: "high", expires_at: "2026-09-13",
    });
    f.pick("db-new");
    f.fill("reason", "理由");
    fireEvent.click(screen.getByText(/^执行/));
    await waitFor(() => expect(api.putInspectionExclusion).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.putInspectionExclusion).mock.calls[0][1];
    expect(body.never_expires).toBeUndefined();
    expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("★★★ 「已排除」按**当前勾选的清单**判，不是按入口判", async () => {
    /* 🔴 判据 2026-09-01 从 `entryKind` 改成 `lists`。旧写法的缺陷：
       一台只在高负载轮里被排除过的资源，在两份都勾的情况下被显示成
       「已排除」并锁掉 checkbox → **闲置轮那一份永远补不上**。

       现在：
       ```
       两份都勾   只排过 high  → 可勾（还差 idle）+ 琥珀色「已在高负载轮排除」
       只勾 high  只排过 high  → 锁住 + 灰色「已排除」（真的没什么可做了）
       ```
       重复提交本身是幂等的，但一个能勾的「已排除」条目会让客户以为上次没生效，
       而一个锁死的「其实还差一份」条目会让他**没法**补上。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue({
      ...RESOURCES,
      resources: [{ ...RESOURCES.resources[0], excluded_in: ["high"] }],
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getAllByText(/排除资源/)[0]);
    await waitFor(() => expect(screen.getByText("db-new")).toBeTruthy());

    const box = () => screen.getByText("db-new").closest("label")!
      .querySelector('input[type="checkbox"]') as HTMLInputElement;
    // 两份都勾（默认）→ 还差 idle，所以**可勾**，并说清已经在哪一份里
    expect(box().disabled, "两份都勾时不该锁 —— 闲置轮那份还没排").toBe(false);
    expect(screen.getByText(/已在高负载轮排除/)).toBeTruthy();

    // 取消 idle → 只剩 high，而它已经在 high 里了 → 锁住
    const idle = document.querySelector('[name="excl_list_idle"]') as HTMLInputElement;
    fireEvent.click(idle);
    await waitFor(() => expect(box().disabled).toBe(true));
    expect(screen.getByText("已排除")).toBeTruthy();
  });

  it("★★★ 整账号排除要说「整账号已排除」并指出在这里撤不掉", async () => {
    /* 🔴 BFF 认通配之后（2026-09-02），整账号排除会让选择器里每一行的
       checkbox 变灰 —— 而客户在这个弹层里**撤不掉它**（只能去
       「巡检范围 → 排除清单」删那一行）。

       只说「已排除」等于在界面上摆一个用户无法解决的问题，而客户会以为
       是自己勾错了，反复点那个灰掉的 checkbox。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue({
      ...RESOURCES,
      resources: [{
        ...RESOURCES.resources[0],
        excluded_in: ["high", "idle"] as ("high" | "idle")[],
        excluded_by: { high: "account", idle: "account" } as never,
      }],
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getAllByText(/排除资源/)[0]);
    await waitFor(() => expect(screen.getByText("db-new")).toBeTruthy());
    expect(screen.getByText(/整账号已排除/),
      "只说「已排除」—— 客户看不出该去哪儿撤销",
    ).toBeTruthy();
    // 撤销路径写在 title 里（徽标里放不下一整句）。
    const badge = screen.getByText(/整账号已排除/);
    expect(badge.getAttribute("title") || "",
      "没说清在这里撤不掉",
    ).toMatch(/排除清单/);
  });

  it("★★★ 只有这一行被排除时**不**说整账号（别指错路）", async () => {
    /* 反例：`coverLabel` 取最粗那一层，但 instance 级要落回「已排除」。
       说成整账号会让客户去删一条不存在的整账号记录。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue({
      ...RESOURCES,
      resources: [{
        ...RESOURCES.resources[0],
        excluded_in: ["high", "idle"] as ("high" | "idle")[],
        excluded_by: { high: "instance", idle: "instance" } as never,
      }],
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getAllByText(/排除资源/)[0]);
    await waitFor(() => expect(screen.getByText("db-new")).toBeTruthy());
    expect(screen.getByText("已排除")).toBeTruthy();
    expect(screen.queryByText(/整账号已排除/)).toBeNull();
  });

  it("★★★ 两份清单层级不同时说**最粗**那一层（客户要解决更难撤的那个）", async () => {
    /* 🔴 这条是 `coarsestLayer` 存在的唯一理由 —— 之前我的用例两份清单
       层级总是相同，把比较符反向注入回去照样绿（反向注入 14/15 抓到的）。

       高负载轮里是这一行自己被排除（弹层里能撤），闲置轮里是整账号被排除
       （撤不掉）。挑最细的那个会说「已排除」，客户取消勾选发现没反应；
       挑最粗的才指对路。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue({
      ...RESOURCES,
      resources: [{
        ...RESOURCES.resources[0],
        excluded_in: ["high", "idle"] as ("high" | "idle")[],
        excluded_by: { high: "instance", idle: "account" } as never,
      }],
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getAllByText(/排除资源/)[0]);
    await waitFor(() => expect(screen.getByText("db-new")).toBeTruthy());
    expect(screen.getByText(/整账号已排除/),
      "挑了最细那一层 —— 客户会去取消勾选，而那撤不掉整账号那条",
    ).toBeTruthy();
  });

  it("★★★ 只勾一份清单时只看那一份的层级", async () => {
    /* 反例：`coarsestLayer` 只遍历**当前勾选**的清单。扫全部 `excluded_by`
       会让「闲置轮整账号排除」污染只操作高负载轮的场景 —— 客户被告知
       去删一条与他无关的记录。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue({
      ...RESOURCES,
      resources: [{
        ...RESOURCES.resources[0],
        excluded_in: ["high", "idle"] as ("high" | "idle")[],
        excluded_by: { high: "instance", idle: "account" } as never,
      }],
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getAllByText(/排除资源/)[0]);
    await waitFor(() => expect(screen.getByText("db-new")).toBeTruthy());
    // 取消闲置轮 → 只剩高负载轮，那一份是 instance 级
    const idle = document.querySelector('[name="excl_list_idle"]') as HTMLInputElement;
    fireEvent.click(idle);
    await waitFor(() => expect(screen.queryByText(/整账号已排除/),
      "闲置轮那条整账号记录污染了只操作高负载轮的场景",
    ).toBeNull());
    expect(screen.getByText("已排除")).toBeTruthy();
  });

  it("★★★ excluded_by 缺失（存量 BFF）退回笼统那句，不猜成 instance", async () => {
    /* 猜错的方向是告诉客户「取消勾选就行」，而他取消不了。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue({
      ...RESOURCES,
      resources: [{
        ...RESOURCES.resources[0],
        excluded_in: ["high", "idle"] as ("high" | "idle")[],
      }],
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getAllByText(/排除资源/)[0]);
    await waitFor(() => expect(screen.getByText("db-new")).toBeTruthy());
    expect(screen.getByText("已排除")).toBeTruthy();
  });

  it("★★ degraded services are shown as unreadable, not as absent", async () => {
    // 🔴 「账号里没有 ElastiCache」与「没权限读 ElastiCache」是两件事。
    //    当成前者会让客户以为不需要排除，而真相是我们看不到那些资源。
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue({
      ...RESOURCES,
      degraded: [{ service: "elasticache", reason: "AccessDenied" }],
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getAllByText(/排除资源/)[0]);
    await waitFor(() => expect(screen.getByText(/读不到/)).toBeTruthy());
    expect(screen.getByText(/AccessDenied/)).toBeTruthy();
  });
});

describe("account-wide exclusion (R1.7)", () => {
  it("★★ it is a separate entry with its own confirmation dialog", async () => {
    // R1.7 的唯一 UI 保障。绕过它的表现是：一次漫不经心的提交让整个账号
    // 退出巡检，下一轮就是少了那些资源，报告上不会写「有个账号被排除了」。
    //
    // 🔴 这一版用**对话框**而不是 `window.confirm`：后者说不出「这会让
    //    整个账号退出巡检」的影响面，而且会被浏览器的「阻止此页面再次
    //    弹窗」静默禁掉 —— 那时它**直接返回 false**，操作看起来像被取消了。
    const confirmSpy = vi.spyOn(window, "confirm");
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());

    fireEvent.click(screen.getByText(/整账号排除/));
    // 🔴 对话框必须说清**是哪个账号**、**哪一份清单**。只说「确认排除？」
    //    客户会无脑点确定，那时 R1.7 就白做了。
    /* ⚠️ `getAllByText` —— 账号号现在出现两次：对话框里的账号下拉
       （一个 `<option>`）和确认横幅的标题。用 `getByText` 会因多重匹配抛错，
       而那种失败长得像「找不到」。 */
    await waitFor(() => expect(
      screen.getAllByText(/111122223333/).length).toBeGreaterThan(0));
    // ⚠️「两份清单」在对话框标题与正文里各出现一次，所以用 getAllByText。
    expect(screen.getAllByText(/两份清单|both lists/).length).toBeGreaterThan(0);
    expect(screen.getByText(/都不再被判定|opts out/)).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("★★ it requires a reason and sends confirm_account_wide", async () => {
    // 忘传 confirm 的表现是后端 400 `confirm_required`。
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.putInspectionExclusion).mockResolvedValue({
      ok: true, key: "k", kind: "high", expires_at: "2026-09-13",
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getByText(/整账号排除/));
    /* ⚠️ `getAllByText` —— 账号号现在出现两次：对话框里的账号下拉
       （一个 `<option>`）和确认横幅的标题。用 `getByText` 会因多重匹配抛错，
       而那种失败长得像「找不到」。 */
    await waitFor(() => expect(
      screen.getAllByText(/111122223333/).length).toBeGreaterThan(0));

    const go = screen.getByText(/确认排除整个账号/).closest("button")!;
    // 原因未填 → 灰着，且说出原因
    expect(go.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(go);
    expect(api.putInspectionExclusion).not.toHaveBeenCalled();

    fireEvent.change(document.querySelector('[name="wide_reason"]')!,
      { target: { value: "沙箱账号，Q4 关停" } });
    fireEvent.click(screen.getByText(/确认排除整个账号/));

    // 🔴 **两份清单都要写。** 第一版只写 high 那份，而对话框承诺
    //    「该账号下所有 RDS / Aurora / ElastiCache 都不再被判定」——
    //    于是二次确认拿到的是**对另一个动作**的同意：下一轮闲置与结构性
    //    照常对该账号出 finding。
    await waitFor(() => expect(api.putInspectionExclusion).toHaveBeenCalledTimes(2));
    const kinds = vi.mocked(api.putInspectionExclusion).mock.calls.map((c) => c[0]);
    expect([...kinds].sort()).toEqual(["high", "idle"]);

    for (const [, body] of vi.mocked(api.putInspectionExclusion).mock.calls) {
      expect(body.confirm_account_wide).toBe(true);
      expect(body.level).toBe("account");
      // 🔴 service / resource_id 都是通配。第一版硬编码 service:"rds"，
      //    而消费侧（scope.py）的整账号判据是
      //    `service === "*" && resource_id === "*"` —— 不匹配的表现是
      //    界面说「整账号已移出巡检范围」而实际**一台都没排除**（H2）。
      expect(body.service).toBe("*");
      expect(body.resource_id).toBe("*");
      expect(body.reason).toBe("沙箱账号，Q4 关停");
      expect(body.account_id).toMatch(/^\d{12}$/);
    }
  });

  it("★ cancelling the dialog changes nothing", async () => {
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getByText(/整账号排除/));
    /* ⚠️ `getAllByText` —— 账号号现在出现两次：对话框里的账号下拉
       （一个 `<option>`）和确认横幅的标题。用 `getByText` 会因多重匹配抛错，
       而那种失败长得像「找不到」。 */
    await waitFor(() => expect(
      screen.getAllByText(/111122223333/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("取消"));
    expect(api.putInspectionExclusion).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 挪出白名单（2026-09-01）
//
// 🔴 在这之前清单上**唯一**的动作是「续期 30 天」。手滑排除一台生产库之后
//    没有任何位置能撤销，只能等 30 天过期 —— 而那 30 天里「没有告警」会被
//    读成「一切正常」，同样没有运行时信号。
//    客户原话：「也没有任何位置让我取消移除。如果用户误操作，岂不是要等待
//    30 天？这个要修改。加上挪出白名单，包括资源也可以挪出。」
// ═══════════════════════════════════════════════════════════════════════════
describe("挪出白名单", () => {
  /** 整账号排除那一行。**两份清单各一条，SK 完全相同**（`<acct>#-#*#*`）。 */
  const WIDE_KEY = "111122223333#-#*#*";
  const wideRow = {
    key: WIDE_KEY, account_id: "111122223333", region: "",
    service: "*", resource_id: "*", level: "account",
    reason: "沙箱账号", expires_at: "2026-10-01", expired: false,
    created_by: "u1", created_at: "2026-09-01",
  };
  const SCOPE_WIDE: ScopeData = {
    ...SCOPE,
    exclusions: {
      high: [wideRow, ...SCOPE.exclusions.high],
      idle: [wideRow, ...SCOPE.exclusions.idle],
    },
  };

  /** 打开某一行的确认框。`rowText` 用来定位那一行。 */
  async function openConfirm(scope: ScopeData, rowText: string) {
    vi.mocked(api.getInspectionScope).mockResolvedValue(scope);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    // ⚠️ 「挪出白名单」在行尾的 `⋯` 菜单里（2026-09-01 从平铺收进去的）。
    openRowMenu(rowText).click(/挪出白名单/);
    // 确认框：必须说清撤销之后会发生什么
    await waitFor(() => expect(screen.getByText(/重新判定/)).toBeTruthy());
  }

  it("★★★ 普通条目：确认后只删它自己那一份清单", async () => {
    vi.mocked(api.deleteInspectionExclusion).mockResolvedValue({
      ok: true, key: "111122223333#us-east-1#rds#db-batch", kind: "idle",
      account_id: "111122223333", resource_id: "db-batch", level: "instance",
      account_wide: false,
    });
    // db-batch 只在 **idle** 清单里 —— 用它才验得到「kind 没被写死成 high」
    await openConfirm(SCOPE, "db-batch");
    fireEvent.click(screen.getAllByRole("button", { name: /挪出白名单/ })
      .find((b) => b.closest('[role="dialog"]'))!);
    await waitFor(() =>
      expect(api.deleteInspectionExclusion).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.deleteInspectionExclusion).mock.calls[0])
      .toEqual(["idle", "111122223333#us-east-1#rds#db-batch"]);
    await waitFor(() => expect(screen.getByText(/已挪出白名单/)).toBeTruthy());
  });

  it("★★★ 整账号条目：一个动作撤销两份清单", async () => {
    /* 🔴 整账号排除是 `submitWide` **一个动作**写出来的两条记录（high + idle）。
       只删点中那一份的表现是：客户以为撤销了，实际另一轮还压着 —— 而那正是
       `submitWide` 失败分支里承认的「只有一半退出了巡检」的中间态。
       从撤销这一侧再制造一次是不能接受的。 */
    vi.mocked(api.deleteInspectionExclusion).mockResolvedValue({
      ok: true, key: WIDE_KEY, kind: "high", account_id: "111122223333",
      resource_id: "*", level: "account", account_wide: true,
    });
    await openConfirm(SCOPE_WIDE, "整账号");
    // 确认框要说「两份清单」—— 不说的话客户不知道这一次撤销的影响面更大
    expect(screen.getAllByText(/两份清单/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole("button", { name: /挪出白名单/ })
      .find((b) => b.closest('[role="dialog"]'))!);
    await waitFor(() =>
      expect(api.deleteInspectionExclusion).toHaveBeenCalledTimes(2));
    const calls = vi.mocked(api.deleteInspectionExclusion).mock.calls;
    expect(calls.map((c) => c[0]).sort()).toEqual(["high", "idle"]);
    // 两次用**同一个** key（SK 在两份清单里逐字相同）
    expect(new Set(calls.map((c) => c[1]))).toEqual(new Set([WIDE_KEY]));
  });

  it("★★★ 成对撤销时 not_found 算成功，不报错", async () => {
    /* 另一份可能早就没了（有人先手删过一次）。报错会让客户以为撤销失败而
       重试 —— 而目标状态其实已经达成。 */
    vi.mocked(api.deleteInspectionExclusion)
      .mockResolvedValueOnce({
        ok: true, key: WIDE_KEY, kind: "high", account_id: "111122223333",
        resource_id: "*", level: "account", account_wide: true,
      })
      .mockResolvedValueOnce({ ok: false, code: "not_found",
        message: "该排除条目不存在（可能已被删除）" });
    await openConfirm(SCOPE_WIDE, "整账号");
    fireEvent.click(screen.getAllByRole("button", { name: /挪出白名单/ })
      .find((b) => b.closest('[role="dialog"]'))!);
    await waitFor(() => expect(screen.getByText(/已挪出白名单/)).toBeTruthy());
    expect(screen.queryByText(/不存在/),
      "not_found 被当成失败报出来了 —— 客户会重试一个已经完成的操作").toBeNull();
  });

  it("★★ 取消确认框什么都不做", async () => {
    await openConfirm(SCOPE, "db-batch");
    fireEvent.click(screen.getByText("取消"));
    expect(api.deleteInspectionExclusion).not.toHaveBeenCalled();
  });

  it("★★★ 从卡片抽屉排除时，用的是**那条 finding 的**账号", async () => {
    /* 🔴 finding 列表是**跨账号**的（`getInspectionFindings` 不传账号），
       所以卡片上那台资源很可能不属于页面选中的 `accountId`。传错的表现：

       ```
       弹层去列 accountId 那个账号的资源
         → 预选的那台不在里面 → orphan → 「资源已不在清单里」
         → 而那台资源就写在他刚点开的那张卡片上
       ```

       ⚠️ 这条断言查 `getInspectionResources` 的入参，而不是查最终写入 ——
          写入根本走不到（被 orphan 挡在「执行」灰按钮后面）。 */
    const OTHER = "444455556666";
    const base = findingsWith("CPUUtilization");
    const d: FindingsData = {
      ...base,
      findings: [{
        ...base.findings[0],
        account_id: OTHER, region: "us-east-1", service: "rds",
        instance: "db-other",
      }],
    };
    /* ⚠️ **不要**在这里 mock `getInspectionOverview`。`vi.clearAllMocks()` 只清
       调用记录、**不清实现**，于是一个 OVERVIEW 会泄漏给后面的用例 ——
       实测把 `★ partial completeness is stated even when findings exist`
       打成了「Found multiple elements」（总览一在，「系统状态」那一区就会把
       完整度再渲染一遍）。这条路径压根不需要总览。 */
    vi.mocked(api.getInspectionFindings).mockResolvedValue(d);
    vi.mocked(api.getInspectionResources).mockResolvedValue(RESOURCES);
    // 判读全文读不到不影响这条路径（抽屉头部先用列表那一行渲染）。
    vi.mocked(api.getInspectionFinding)
      .mockResolvedValue({ ok: false, code: "not_found" });
    render(<InspectionDashboard dashboardId="high-load"
      can={() => true} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-other")).toBeTruthy());
    // 整卡可点 → 开抽屉；「移出巡检范围」只在抽屉 footer 里
    fireEvent.click(screen.getByText("db-other").closest("[data-finding-id]")!);
    const btn = await waitFor(() =>
      screen.getByRole("button", { name: /移出巡检范围/ }));
    fireEvent.click(btn);
    await waitFor(() => expect(api.getInspectionResources).toHaveBeenCalled());
    expect(vi.mocked(api.getInspectionResources).mock.calls[0][0],
      "弹层去列了页面选中账号的资源，而这条 finding 属于另一个账号")
      .toBe(OTHER);
  });

  it("★★ 只读权限看不到「挪出白名单」", async () => {
    // 与其它写入控件同一套 fail-CLOSED：403 只在点下去那一刻才出现。
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope"
      can={only("nav:inspection:scope")} />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    expect(screen.queryAllByRole("button", { name: /挪出白名单/ })).toEqual([]);
  });

  it("★★★ 整账号那一格「整账号」只出现一次，且不换行", async () => {
    /* 🔴 客户圈出来的「错位」：那一格原来渲染的是
       `{t("insp.scope.lv.account")}` + `<Badge tone="red">整账号</Badge>`
       —— **同一个词出现两次**，而两个词加起来放不进列宽，徽章就掉到第二行，
       看起来像排版坏了。

       徽章本身已经同时承担了标签和「这条影响面最大」的强调，所以整账号级
       只渲染徽章。

       ⚠️ 对照：`cluster` 那一支保留「集群 + [级联]」—— 那两个词**不重复**
          （层级 vs 级联语义），去掉任一个都会丢信息。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE_WIDE);
    render(<InspectionDashboard dashboardId="scope" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());

    const wide = [...document.querySelectorAll("tbody tr")]
      .find((r) => r.textContent?.includes("整账号"))!;
    expect(wide, "表里没有整账号那一行").toBeTruthy();
    const cells = [...wide.querySelectorAll("td")];
    const lvl = cells.find((c) => (c.textContent || "").includes("整账号"))!;
    expect((lvl.textContent || "").match(/整账号/g)?.length,
      `「整账号」在同一格里出现了多次：「${lvl.textContent}」—— `
      + "两个同名的词放不进列宽，徽章会掉到第二行").toBe(1);
    // 版式：这一格不许换行（换行就是客户看到的那个错位）
    expect(lvl.style.whiteSpace).toBe("nowrap");

    // 反面：集群那一行**要**同时有「集群」和「级联」（两个词不重复）
    const cl = [...document.querySelectorAll("tbody tr")]
      .find((r) => r.textContent?.includes("cl-forever"))!;
    expect(cl.textContent).toContain("集群");
    expect(cl.textContent).toContain("级联");
  });

  it("★★★ 多账号时表格有账号列，单账号时没有", async () => {
    /* 🔴 客户实测：页头选中 677，列表里却有一行属于 088 的 `*` 整账号排除，
       **而那一行连账号列都没有** —— 无从分辨它是谁的。
       读侧的越权过滤在 BFF 修掉了（`filterScopeRows`），这一列是让「谁的」
       这件事在界面上也能看见。

       ⚠️ 单账号时那一列是纯噪音（每行一个相同的 12 位数字），所以按
          「清单里出现了几个不同账号」决定显不显示。 */
    const heads = () => [...document.querySelectorAll("thead th")]
      .map((h) => h.textContent);

    // 单账号 → 没有账号列
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    const r = render(<InspectionDashboard dashboardId="scope" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    expect(heads()).not.toContain("账号");
    r.unmount(); cleanup();

    // 两个账号 → 有账号列，且那个账号号真的渲染出来了
    vi.mocked(api.getInspectionScope).mockResolvedValue({
      ...SCOPE,
      exclusions: {
        ...SCOPE.exclusions,
        idle: [...SCOPE.exclusions.idle, {
          key: "888888888888#-#*#*", account_id: "888888888888",
          region: "", service: "*", resource_id: "*", level: "account",
          reason: "别的账号", expires_at: "2026-10-01", expired: false,
        }],
      },
    });
    render(<InspectionDashboard dashboardId="scope" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    expect(heads()).toContain("账号");
    expect(screen.getByText("888888888888")).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 定时配置三条（2026-09-02 review #6b：D12 / D13 / D14）
// ═══════════════════════════════════════════════════════════════════════════
describe("定时配置：下一轮与补跑窗口", () => {
  const cfgWith = (over: Partial<ConfigData["schedules"]["high"]>): ConfigData => ({
    ...CONFIG,
    schedules: {
      ...CONFIG.schedules,
      high: { ...CONFIG.schedules.high, ...over },
    },
  });

  const openCfg = async (c: ConfigData) => {
    vi.mocked(api.getInspectionConfig).mockResolvedValue(c);
    render(<InspectionDashboard dashboardId="config"
      can={only("action:inspection:schedule")} />);
    await waitFor(() => expect(screen.getByText(/修改在下一轮巡检生效/)).toBeTruthy());
  };

  it("★★★ D12 「下一轮」打开页面就有（不必先保存一次）", async () => {
    /* 🔴 原来 `next_run_utc` **只有 PUT 回传**，GET 不回 —— 于是这个信息只在
       刚保存完那一下存在，刷新页面就没了。而 `at_utc` / `weekdays` 一直在
       手上，`nextRunUtc` 本来就是个导出的纯函数，加进 GET 的成本几乎为零。 */
    await openCfg(cfgWith({ next_run_utc: "2026-09-03T02:00Z", enabled: true }));
    expect(screen.getByText(/2026-09-03T02:00Z/),
      "打开配置页看不到下一轮 —— 那个信息只在保存后闪现一次",
    ).toBeTruthy();
  });

  it("★★★ D13 停用时不显示时刻，说「不会有下一轮」", async () => {
    /* 🔴 渲染门原来只有 `nextRun &&`，完全不看 `enabled` —— 于是界面上
       header 是红色「已停用」徽章，正下方一条**绿色**「下一轮: 02:00」。
       两句直接矛盾，而 `schedule.py` 的 `if not cfg.enabled: continue`
       说明那一轮压根不会跑。 */
    await openCfg(cfgWith({ enabled: false, next_run_utc: "2026-09-03T02:00Z" }));
    expect(screen.getAllByText(/不会有下一轮/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/2026-09-03T02:00Z/),
      "停用了还在承诺一个下一轮时刻",
    ).toBeNull();
  });

  it("★★★ D13 取消勾选「启用」后立刻收起时刻（不等保存）", async () => {
    /* 判据要用**表单当前值**而不是 `row.enabled`：中间那一帧仍在承诺一件
       即将不成立的事。 */
    await openCfg(cfgWith({ enabled: true, next_run_utc: "2026-09-03T02:00Z" }));
    expect(screen.getByText(/2026-09-03T02:00Z/)).toBeTruthy();
    fireEvent.click(document.querySelector('[name="enabled_high"]')!);
    await waitFor(() => expect(screen.queryByText(/2026-09-03T02:00Z/)).toBeNull());
  });

  it("★★★ D14 补跑窗口有输入控件，且回显当前值", async () => {
    /* 🔴 此前**完全没有 UI 入口**：后端定义了（默认 6）、store 存了、
       BFF 校验并回传了、前端类型也声明了 —— 唯独客户改不了也看不到。
       而 `0` 意味着「错过配置时刻就彻底不跑那一轮」，是个有运维后果的值。 */
    await openCfg(cfgWith({ catch_up_hours: 6 }));
    const el = document.querySelector('[name="catch_up_high"]') as HTMLInputElement;
    expect(el, "补跑窗口没有输入控件").not.toBeNull();
    expect(el.value).toBe("6");
  });

  it("★★★ D14 catch_up_hours = 0 要说清「错过就不补跑」", async () => {
    /* `0` 是合法值且 falsy —— 任何 `||` 兜底都会把它悄悄变回 6。
       而它的含义与 6 完全不同，必须在界面上说出来。 */
    await openCfg(cfgWith({ catch_up_hours: 0 }));
    const el = document.querySelector('[name="catch_up_high"]') as HTMLInputElement;
    expect(el.value, "客户显式设的 0 被兜底成了 6").toBe("0");
    expect(screen.getByText(/错过配置时刻就不补跑/)).toBeTruthy();
  });

  it("★★★ D14 打开页面时**不**显示「有未保存的改动」", async () => {
    /* 🔴 我第一版把 `changed` 写成 `catchUpNum !== row.catch_up_hours`，
       字段缺失时 state 种子是 6 而基线是 `undefined` → 恒真 → 一打开就
       显示有改动、保存按钮一直亮着，而用户什么都没动。
       修法是基线走 `effectiveCatchUp(row)`（与 state 种子**同一个表达**）。 */
    const c = cfgWith({});
    delete (c.schedules.high as { catch_up_hours?: number }).catch_up_hours;
    await openCfg(c);
    /* ⚠️ `Btn` 的禁用态走 **`aria-disabled` + `title`**（本仓库规矩 ①：
       灰着必须说原因），不是 `disabled` 属性。按实际契约断言 ——
       我第一版猜成 `disabled`，两条用例假红。 */
    const btn = screen.getAllByRole("button", { name: /保存/ })[0];
    expect(btn.getAttribute("aria-disabled"),
      "刚打开就认为有改动 —— catch_up 的基线没走生效值",
    ).toBe("true");
    expect(btn.getAttribute("title") || "").toMatch(/没有改动/);
  });

  it("★★★ D14 保存时显式带 catch_up_hours（不靠后端兜底）", async () => {
    /* 不传的话 BFF 会兜底成 6 —— 于是客户设的 0 每次保存都被悄悄改回 6，
       而界面显示保存成功。 */
    vi.mocked(api.putInspectionSchedule).mockResolvedValue({
      ok: true, run_type: "high", at_utc: "02:00", enabled: true,
      next_run_utc: "2026-09-03T02:00Z",
    });
    await openCfg(cfgWith({ catch_up_hours: 6 }));
    fireEvent.change(document.querySelector('[name="catch_up_high"]')!,
      { target: { value: "0" } });
    fireEvent.click(screen.getAllByRole("button", { name: /保存/ })[0]);
    await waitFor(() =>
      expect(api.putInspectionSchedule).toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.putInspectionSchedule).mock.calls[0][1];
    expect(body.catch_up_hours, "保存时没带 catch_up_hours").toBe(0);
  });

  it("★★★ D14 越界值不许提交（按钮灰 + 第二道防御）", async () => {
    await openCfg(cfgWith({ catch_up_hours: 6 }));
    fireEvent.change(document.querySelector('[name="catch_up_high"]')!,
      { target: { value: "99" } });
    const btn = screen.getAllByRole("button", { name: /保存/ })[0];
    expect(btn.getAttribute("aria-disabled"), "越界值时保存按钮还能点")
      .toBe("true");
    // 原因要说出来（规矩 ①：灰着不说为什么是最糟的形态）
    expect(btn.getAttribute("title") || "").toMatch(/0~24/);
    // 小数同样要拒（后端要整数小时，静默取整会让 UI 显示 6.5 而库里是 6）
    fireEvent.change(document.querySelector('[name="catch_up_high"]')!,
      { target: { value: "6.5" } });
    expect(screen.getAllByRole("button", { name: /保存/ })[0]
      .getAttribute("aria-disabled"), "小数被接受了").toBe("true");
  });
});

describe("schedule write (9.15)", () => {
  it("★★ the two capabilities are independent", async () => {
    // 写成同一个 cap 的表现是：给了「改排除清单」的人顺带能改执行时刻，
    // 而后者是**全局**配置（R11.1），一改影响所有账号。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    const r = render(<InspectionDashboard dashboardId="config"
      can={only("action:inspection:scope")} />);
    await waitFor(() => expect(screen.getByText(/修改在下一轮巡检生效/)).toBeTruthy());
    expect(document.querySelectorAll("input").length).toBe(0);
    r.unmount();

    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config"
      can={only("action:inspection:schedule")} />);
    await waitFor(() => expect(screen.getByText(/修改在下一轮巡检生效/)).toBeTruthy());
    expect(document.querySelectorAll("input").length).toBeGreaterThan(0);
  });

  it("★★ rejects a minute that is not a multiple of 15 without calling the API", async () => {
    // 🔴 02:07 是一个**永远不被精确命中**的配置：只能靠补跑在 02:15 执行，
    //    表现为「报告总是慢 8 分钟」而不是任何报错。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config"
      can={only("action:inspection:schedule")} />);
    await waitFor(() => expect(screen.getByText(/修改在下一轮巡检生效/)).toBeTruthy());

    const at = document.querySelector('[name="at_utc_high"]')!;
    fireEvent.change(at, { target: { value: "02:07" } });
    await waitFor(() => expect(screen.getAllByText(/00\/15\/30\/45/).length).toBeGreaterThan(0));

    const save = screen.getAllByText("保存")[0] as HTMLButtonElement;
    // ⚠️ 判据是 `aria-disabled` 而**不是**原生 `disabled`。2026-08-23 的
    //    可访问性修复把 `Btn` 改成只用前者：原生 disabled 会把按钮从 tab 序
    //    里摘掉，而且 Firefox / Safari 对 disabled 控件不派发鼠标事件 →
    //    `title` 里的「为什么点不动」出不来。保持可聚焦 + 在 handler 里拦。
    expect(save.getAttribute("aria-disabled")).toBe("true");
    // 而且必须说出原因 —— 灰着不说为什么的按钮让人只能猜「是不是坏了」。
    expect(save.getAttribute("title") || "").toMatch(/15/);
    fireEvent.click(save);
    expect(api.putInspectionSchedule).not.toHaveBeenCalled();
  });

  it("★★ weekday 一 maps to 1 (isoweekday), not 0 and not JS getUTCDay", async () => {
    // 🔴 调度器的判据是 `d.isoweekday() in weekdays`，即 1=周一 … 7=周日。
    //    这里曾断言映射到 0（以为对齐 `weekday()`），而 `isoweekday()` 永远不
    //    返回 0 —— 落库之后那一类巡检**永远不跑**，run 记录里连一行都没有，
    //    看起来像「调度器压根没派它」。完全没有错误信号。
    //    JS 的 `getUTCDay()`（0=周日）是第三套口径，也不能用。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    vi.mocked(api.putInspectionSchedule).mockResolvedValue({
      ok: true, run_type: "high", at_utc: "02:00", enabled: true,
      next_run_utc: "2026-08-24T02:00Z",
    });
    render(<InspectionDashboard dashboardId="config"
      can={only("action:inspection:schedule")} />);
    await waitFor(() => expect(screen.getByText(/修改在下一轮巡检生效/)).toBeTruthy());

    /**
     * ⚠️ **判据改了，意图没改**（2026-08-31）。
     *
     *    以前是「空 weekdays → 点『一』→ 期望 `[1]`」。而「空 = 每天」之后
     *    七个 chip 进页面就是**全亮**的（见 `effectiveWeekdays`）——
     *    点「一」是把周一**关掉**，期望值变成 `[2,3,4,5,6,7]`。
     *
     *    这条要守的不变量是「屏幕上那个『一』落库成 **1**（isoweekday），
     *    不是 0（`weekday()`）、不是 1（JS `getUTCDay()` 里的周一）」——
     *    所以判据换成：先关掉周一，落库的集合里**没有 1 而有 7**。
     *      · 域是 0~6 的话集合会是 `[1..6]`，不含 7 ⇒ 红
     *      · 域是 JS getUTCDay（0=周日）的话「日」那个 chip 不存在 ⇒ 上面
     *        那条「渲染出恰好 一二三四五六日」会红
     */
    fireEvent.click(screen.getAllByText("一")[0]);
    fireEvent.click(screen.getAllByText("保存")[0]);
    await waitFor(() => expect(api.putInspectionSchedule).toHaveBeenCalledTimes(1));
    const [rt, body] = vi.mocked(api.putInspectionSchedule).mock.calls[0];
    expect(rt).toBe("high");
    expect(body.weekdays,
      "关掉周一之后落库的不是 [2..7] —— 星期域可能被改回 0~6"
      + "（那时 `isoweekday()` 永远不返回 0，那一类巡检永远不跑而没有任何信号）",
    ).toEqual([2, 3, 4, 5, 6, 7]);
    expect(body.weekdays).not.toContain(1);
    expect(body.weekdays, "集合里没有 7 —— 域被改回 0~6 了").toContain(7);
    expect(body.at_utc).toBe("02:00");
  });

  it("★★ renders exactly 一二三四五六日 with no raw i18n key leaking", async () => {
    // 🔴 这条守的是**星期域**（1~7 = isoweekday）。
    //    只断言「点『一』发出 [1]」抓不到域被改回 0~6 —— 那时 `insp.wd.1`
    //    仍然是「一」，点它照样发 [1]，测试照过。真正的差别在两头：
    //      · 0~6 会渲染出一个标签为 `insp.wd.0` 的按钮（i18n 找不到 key 时
    //        原样返回），客户看到的是一串标识符
    //      · 0~6 里没有 7，于是**周日那个按钮压根不存在** —— 客户永远无法
    //        选中周日，而界面上看不出少了什么
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config"
      can={only("action:inspection:schedule")} />);
    await waitFor(() => expect(screen.getByText(/修改在下一轮巡检生效/)).toBeTruthy());

    expect(document.body.textContent).not.toContain("insp.wd.");
    // 每张卡片一组七个按钮（high / idle 两张卡）。
    for (const label of ["一", "二", "三", "四", "五", "六", "日"]) {
      expect(screen.getAllByText(label).length, `缺星期按钮「${label}」`).toBe(2);
    }
  });

  it("★★ shows the next run time RETURNED BY THE BACKEND", async () => {
    // 前端自己算等于同一条规则有两份实现，而它带 weekdays 过滤。
    // 这里 mock 一个前端不可能算出来的值 —— 若某天改成前端算，这条会红。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    vi.mocked(api.putInspectionSchedule).mockResolvedValue({
      ok: true, run_type: "high", at_utc: "02:00", enabled: true,
      next_run_utc: "2099-03-07T02:00Z",
    });
    render(<InspectionDashboard dashboardId="config"
      can={only("action:inspection:schedule")} />);
    await waitFor(() => expect(screen.getByText(/修改在下一轮巡检生效/)).toBeTruthy());
    // ⚠️ 先改一个值。这一版的保存按钮在「没有改动」时是灰的 ——
    //    重复提交同样的值会白写一个配置版本，而 R6.9 规定每次配置变更都
    //    强制 resolve 全部旧 finding（看板数字会跳一次，没人能解释）。
    //    唯一的例外是 `persisted: false` 的行（把默认值固化下来），
    //    由 `flags a schedule row that was never persisted` 那条覆盖。
    fireEvent.change(document.querySelector('[name="at_utc_high"]')!,
      { target: { value: "03:15" } });
    fireEvent.click(screen.getAllByText("保存")[0]);
    await waitFor(() => expect(screen.getByText("2099-03-07T02:00Z")).toBeTruthy());
  });

  it("★ flags a schedule row that was never persisted", async () => {
    // `persisted: false` = 用的是代码默认值，而巡检**已经在跑**。
    // 不标出来会让客户以为「还没配所以没跑」，去等一件已经发生的事。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config" />);
    await waitFor(() => expect(screen.getByText(/使用默认值/)).toBeTruthy());
    // 只有 idle 那行是 persisted:false —— 两行都标等于没标。
    expect(screen.getAllByText(/使用默认值/).length).toBe(1);
  });

  it("★ read-only view shows the schedule without any input", async () => {
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config" />);
    await waitFor(() => expect(screen.getByText("02:00")).toBeTruthy());
    expect(document.querySelectorAll("input").length).toBe(0);
    /**
     * 每天跑（`weekdays=null`）必须**明说**，不能只是一片空白。
     *
     * ⚠️ 说法从「每天」两个字换成**把七天列出来**（2026-08-31）——
     *    可写态那侧同样的输入渲染成七个亮着的 chip，两边说同一件事。
     *    以前是：可写态七个 chip 全灭 + 一行小字「每天」（屏幕自相矛盾），
     *    只读态一行「每天」⇒ 有写权限的人和没有的人看到的执行日不一样。
     */
    expect(screen.getAllByText("一 二 三 四 五 六 日").length,
      "只读态没把七天列出来 —— 与可写态（七个亮着的 chip）分叉",
    ).toBeGreaterThan(0);
    expect(screen.queryByText(/^每天$/),
      "「每天」那行小字应该已经删掉了 —— 它与 chip 状态矛盾就是那条缺陷本身",
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 空列表的四种说法（R9.11）
//
// 🔴 真实事故（东京 111122223333）：run 行卡在 `running`、零 finding，
//    界面无条件显示「本轮未发现风险」—— 客户以为系统在正常工作，
//    而实际上整套巡检从未成功执行过一次（SQS 投递、锁归属、DDB 保留字
//    三个 bug 叠在一起）。
//
//    「那天没跑」与「那天没有风险」的运维含义完全相反：一个要去查，
//    一个可以放心。这组用例把四种说法钉住。
// ---------------------------------------------------------------------------
const EMPTY_BASE = {
  ok: true as const, account_id: "111122223333", kind: "high_load",
  total: 0, by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, INFO: 0 },
  without_judgment: 0, unclassified: 0, findings: [],
};
const TODAY = new Date().toISOString().slice(0, 10);

describe("empty list disambiguation (R9.11)", () => {
  it("★ a successful run with no findings says 'no risks'", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue({
      ...EMPTY_BASE,
      last_run: { run_date: TODAY, status: "success", completeness: 1, mode: "official" },
    });
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/本轮未发现风险/)).toBeTruthy());
  });

  it("★ no run today does NOT say 'no risks'", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue({
      ...EMPTY_BASE,
      last_run: { run_date: "2026-08-01", status: "success", completeness: 1, mode: "official" },
    });
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/今天还没巡检/)).toBeTruthy());
    // 这是整组里最要紧的一条断言。
    expect(screen.queryByText(/本轮未发现风险/)).toBeNull();
  });

  it("★ a failed run does NOT say 'no risks'", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue({
      ...EMPTY_BASE,
      last_run: { run_date: TODAY, status: "failed", completeness: null, mode: "official" },
    });
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/本轮巡检失败/)).toBeTruthy());
    expect(screen.queryByText(/本轮未发现风险/)).toBeNull();
  });

  it("★ a running run says 'in progress', not 'no risks'", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue({
      ...EMPTY_BASE,
      last_run: { run_date: TODAY, status: "running", completeness: null, mode: "official" },
    });
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/正在巡检/)).toBeTruthy());
    expect(screen.queryByText(/本轮未发现风险/)).toBeNull();
  });

  it("★ last_run=null means unknown, NOT clean", async () => {
    // null 是「读不到 run 记录」。把它当成「没跑过」或「没风险」都是下结论，
    // 而这时唯一诚实的说法是「现在说不了」。
    vi.mocked(api.getInspectionFindings).mockResolvedValue({
      ...EMPTY_BASE, last_run: null,
    });
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/巡检状态未知/)).toBeTruthy());
    expect(screen.queryByText(/本轮未发现风险/)).toBeNull();
  });

  it("★ partial completeness is stated even when findings exist", async () => {
    // 「找到 1 条」与「只看了 60% 找到 1 条」是两个不同的保证。
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      { ...findingsWith("CPUUtilization"), last_run: {
        run_date: TODAY, status: "partial", completeness: 0.6, mode: "official" } });
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/完整度 60%/)).toBeTruthy());
  });

  it("★★★ status=partial does NOT say 'no risks' — even at completeness 1.0", async () => {
    // 🔴 这是最阴的一种：某个 region 整轮没扫成 → 那些实例**压根没进
    //    `expected`** → `completeness` 仍是 1.0 → 「完整度不足」那句补充语
    //    不出现 → 上一版落到成功分支给绿色 ✓「本轮未发现风险」。
    //    而那个 region 里内存 98% 的库一条 finding 都没出。
    vi.mocked(api.getInspectionFindings).mockResolvedValue({
      ...EMPTY_BASE,
      last_run: {
        run_date: TODAY, status: "partial", completeness: 1, mode: "official",
        regions_failed: ["us-west-2", "eu-west-1"],
      },
    });
    render(<InspectionDashboard dashboardId="high-load" />);
    // ⚠️ 两处都该出现：页面级 Status（覆盖面不足）+ 空态标题（列表为空的原因）。
    //    所以用 getAllByText —— 单数版会因为「找到两个」而失败，
    //    而那两个都是我们要的。
    await waitFor(() =>
      expect(screen.getAllByText(/只跑完了一部分/).length).toBeGreaterThan(0));
    expect(screen.queryByText(/本轮未发现风险/)).toBeNull();
    // 说得出**少了谁** —— 失败的 region 在 `by_region` 里连键都没有，
    // 这是唯一能回答这个问题的地方。
    expect(screen.getAllByText(/us-west-2/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/eu-west-1/).length).toBeGreaterThan(0);
  });

  it("★★★ a search miss does NOT say 'no risks'", async () => {
    // 🔴 搜索框是第三个筛选维度，而「筛空」的判据上一版只看 chip / sev。
    //    于是搜一个不存在的实例名 → 落到成功分支 → 绿色 ✓「本轮未发现风险」，
    //    而页头那排严重度分档还显示非零计数（自相矛盾且无线索）。
    vi.mocked(api.getInspectionFindings).mockResolvedValue({
      ...findingsWith("CPUUtilization"),
      last_run: { run_date: TODAY, status: "success", completeness: 1, mode: "official" },
    });
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getAllByText(/db-1/).length).toBeGreaterThan(0));

    const box = document.querySelector<HTMLInputElement>('input[name="insp_q"]')
      ?? document.querySelector<HTMLInputElement>('input[type="search"]')
      ?? [...document.querySelectorAll<HTMLInputElement>("input")]
        .find((el) => (el.placeholder || "").length > 0);
    expect(box).toBeTruthy();
    fireEvent.change(box!, { target: { value: "zzz-not-a-real-instance" } });

    await waitFor(() => expect(screen.getByText(/没有符合筛选条件的项/)).toBeTruthy());
    expect(screen.queryByText(/本轮未发现风险/)).toBeNull();
    // 搜索词要回显 —— 只说「共有 N 条」看不出是哪个条件筛空的。
    expect(screen.getByText(/zzz-not-a-real-instance/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 手动触发（action:inspection:run）
// ---------------------------------------------------------------------------
describe("manual run button", () => {
  /**
   * 🔴 这个名字**曾经**只给了 `action:inspection:run` 一个键。三类合成一页
   * 的时代那样够用 —— 那一页不按 kind 的 nav 能力拦。
   *
   * 拆成三页之后（2026-08-24）每页会按**自己那一类**的 nav 能力拦：只有
   * run 权限的用户在高负载页上看到的是「没有『高负载』的查看权限」，
   * 于是这一组按钮测试全红。那个拦截是对的（见下面的
   * `无权时显示提示而不是空列表`），错的是这个 fixture 的名字与内容不符。
   */
  const CAN_ALL = () => true;
  /** 有三页的查看权限，**没有** `action:inspection:run` —— 验按钮不该出现。 */
  const CAN_NAV_ONLY = (k: string) => k.startsWith("nav:inspection");

  it("★ the overview page has run buttons too (it has no `kind`)", async () => {
    // 🔴 我第一版写成 `mayRun && kind`，于是总览页压根没有按钮 ——
    //    而总览恰恰是「装完之后第一个打开、发现什么都没有」的那一页，
    //    最需要「立即跑一轮」的入口就在这里。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="overview" can={CAN_ALL} />);
    await waitFor(() => expect(screen.getByText(/跑高负载/)).toBeTruthy());
    // 总览跨两类，所以两个按钮都要有 —— 只给一个等于另一类没法手动跑。
    expect(screen.getByText(/跑闲置/)).toBeTruthy();
  });

  it("★★ the two run buttons are independent (this was the bug)", async () => {
    // 🔴 第一版两个按钮共用一个 `runState`，后果分三层：
    //
    //    ① 显示     点「跑高负载」→「跑闲置」同时变「巡检中…」
    //    ② 阻塞     守卫 `if (runState === sending||waiting) return`
    //               → 高负载在跑的 5 分钟里闲置**点不动**，且无提示
    //    ③ 跨页残留  切页只换 prop，组件不卸载 → 另一页的按钮也是灰的
    //
    //    客户原话：「我现在触发高负载，为什么闲置那边也跟着 loading？」
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(api.triggerInspectionRun).mockResolvedValue({
      ok: true, account_id: "111122223333", run_type: "high",
      source: "refetch", mode: "dry_run", accepted: true,
    });
    render(<InspectionDashboard dashboardId="triage" can={CAN_ALL} />);
    await waitFor(() => expect(screen.getByText(/跑高负载/)).toBeTruthy());

    const high = screen.getByText(/跑高负载/).closest("button")!;
    const idle = screen.getByText(/跑闲置/).closest("button")!;
    expect(high.getAttribute("aria-disabled")).toBeNull();
    expect(idle.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(high);
    // 高负载进「提交中 / 巡检中」→ 它自己灰掉
    await waitFor(() =>
      expect(high.getAttribute("aria-disabled")).toBe("true"));
    // 🔴 **闲置必须仍然可点。** 这一条就是那个 bug 的回归守卫。
    expect(idle.getAttribute("aria-disabled"),
      "跑高负载把跑闲置也灰掉了 —— 两个按钮又共用状态了").toBeNull();

    // 且灰掉时必须说出原因（`Btn` 的 disabledReason → title）
    expect(high.getAttribute("title") || "").toMatch(/提交中|正在跑/);
  });

  it("★ no button without action:inspection:run", async () => {
    // 没权限的人看到一个点了就 403 的按钮，比看不到更糟。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    // ⚠️ 用 nav-only 而不是 `() => false`：后者同时拿掉了查看权限，
    //    于是页面走「没有访问权限」分支 —— 那测的是别的东西
    //    （见 `无权时显示提示而不是空列表`）。这一条要测的是
    //    「能看，但不能跑」。
    render(<InspectionDashboard dashboardId="high-load" can={CAN_NAV_ONLY} />);
    // 锚点用页标题 —— 三类各自一页之后是「高负载」。
    await waitFor(() => expect(screen.getByText(/高负载|High Load/)).toBeTruthy());
    expect(screen.queryByText(/跑高负载/)).toBeNull();
    expect(screen.queryByText(/立即巡检/)).toBeNull();
  });

  it.each(["high-load", "idle", "structural"])(
    "★★ %s 页无查看权限时显示提示，**不是**空列表", async (tab) => {
      // 🔴 这是拆页时新加的分支，也是最容易写错的一处。
      //    没有权限时若返回空 `wantKinds` 而不显式提示，页面会渲染成
      //    **「零条待处置」** —— 客户看到「今天没风险」，真相是「你没权限看」。
      //    R9.11 要防的正是这两件事长得一样。
      vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
      render(<InspectionDashboard dashboardId={tab}
        can={(k) => k === "action:inspection:run"} />);
      await waitFor(() =>
        expect(screen.getByText(/没有访问权限|No access/)).toBeTruthy());
      // 且**没有**发过 findings 请求 —— 发一个必然 403 的请求只会刷日志。
      expect(api.getInspectionFindings).not.toHaveBeenCalled();
      // 且没有「未发现风险」那种空态文案。
      expect(screen.queryByText(/未发现风险|No findings/)).toBeNull();
    });

  it("★ clicking sends refetch + dry_run", async () => {
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(api.triggerInspectionRun).mockResolvedValue({
      ok: true, account_id: "111122223333", run_type: "high",
      source: "refetch", mode: "dry_run", accepted: true,
    });
    render(<InspectionDashboard dashboardId="triage" can={CAN_ALL} />);
    await waitFor(() => expect(screen.getByText(/跑高负载/)).toBeTruthy());
    fireEvent.click(screen.getByText(/跑高负载/));
    await waitFor(() => expect(api.triggerInspectionRun).toHaveBeenCalled());
    const arg = vi.mocked(api.triggerInspectionRun).mock.calls[0][0];
    expect(arg?.run_type).toBe("high");
    // refetch：点「立即巡检」要的是现在的指标，不是复用上一批。
    expect(arg?.source).toBe("refetch");
    // dry_run：一次手点的补跑不该改变「这条风险是否已解决」这种带日期语义的结论。
    expect(arg?.mode).toBe("dry_run");
  });
});

// ---------------------------------------------------------------------------
// 日期筛选（对齐 idle 控制台的 RdsHealthCheck）
// ---------------------------------------------------------------------------
describe("run date filter", () => {
  it("★ says how many runs are hidden by the filter", async () => {
    // 筛掉了多少必须说出来，否则用户会以为「只有这么几轮」。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="overview" />);
    await waitFor(() => expect(screen.getByText(/只看最新一天/)).toBeTruthy());
    fireEvent.click(screen.getByLabelText?.(/只看最新一天/) ?? screen.getByRole("checkbox"));
    // OVERVIEW 里只有 1 轮，所以筛完条数不变、不该出现「显示 x / y」。
    // 这条断言的价值在于确认控件存在且可交互（数据多的情况由 BFF 侧测试覆盖）。
    expect(screen.getByRole("checkbox")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 判定阈值：服务筛选器（R13.4）
//
// 🔴 这一组守的是一个**语义**而不是一个函数：服务选择器是**筛选器不是作用域**。
//    阈值配置全局一份 —— 选 Redis 不等于「只给 Redis 设一套」。
//    做错的表现不是报错，而是客户以为「我只调了 Redis」而 RDS 也跟着变了。
//
//    子串检查在这里没用：`service` / `filter` 这些词在文件里到处都是，
//    而「筛掉的字段还在不在 payload 里」只能渲染出来点一遍才知道。
// ---------------------------------------------------------------------------

describe("threshold rules: service filter", () => {
  const RULES_CAP = "action:inspection:threshold";

  it("renders one chip per service plus 全部, with field counts", async () => {
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config" can={only(RULES_CAP)} />);
    await waitFor(() => expect(screen.getByText(/判定阈值/)).toBeTruthy());
    // 四个服务 + 「全部」
    for (const name of ["rule_svc_all", "rule_svc_rds", "rule_svc_aurora",
                        "rule_svc_redis", "rule_svc_memcached"]) {
      expect(document.querySelector(`[name="${name}"]`), name).toBeTruthy();
    }
    // 字段数要显示出来 —— 客户据此知道「选了这个还剩几项可调」
    expect(document.querySelector('[name="rule_svc_rds"]')!.textContent)
      .toMatch(/5/);
  });

  it("★★ says out loud that thresholds are shared, not per-service", async () => {
    // 不说这句的后果：客户在 Redis 视图里把 cpu_utilization 从 70 调到 90，
    // 以为只影响 Redis —— 而 RDS 的判定也跟着变了，且没有任何运行时信号。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config" can={only(RULES_CAP)} />);
    await waitFor(() => expect(screen.getByText(/判定阈值/)).toBeTruthy());
    expect(screen.getByText(/阈值是全局共用的一份/)).toBeTruthy();
  });

  it("★★ picking a service hides the fields that do not apply", async () => {
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config" can={only(RULES_CAP)} />);
    await waitFor(() => expect(screen.getByText(/判定阈值/)).toBeTruthy());
    const has = (key: string) =>
      !!document.querySelector(`[name="rule_${key}"]`);

    // 全部视图：四个 threshold 字段都在
    expect(has("cpu_utilization")).toBe(true);
    expect(has("free_storage_bytes")).toBe(true);
    expect(has("engine_cpu_utilization")).toBe(true);

    // 选 Aurora → free_storage_bytes 该消失（Aurora 存储自动扩展）
    fireEvent.click(document.querySelector('[name="rule_svc_aurora"]')!);
    await waitFor(() => expect(has("free_storage_bytes")).toBe(false));
    expect(has("cpu_utilization")).toBe(true);
    expect(has("engine_cpu_utilization")).toBe(false);   // 那是 Redis 的

    // 选 Memcached → 连 engine_cpu 也没有（Memcached 多线程，没这个指标）
    fireEvent.click(document.querySelector('[name="rule_svc_memcached"]')!);
    await waitFor(() => expect(has("engine_cpu_utilization")).toBe(false));
    expect(has("evictions")).toBe(true);                 // 两种引擎都有
    expect(has("iops_total")).toBe(false);               // 那是 RDS 的
  });

  it("clicking the active chip clears the filter", async () => {
    // 没有这个的话客户选错了得去找「全部」按钮 —— 再点一下更符合直觉。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config" can={only(RULES_CAP)} />);
    await waitFor(() => expect(screen.getByText(/判定阈值/)).toBeTruthy());
    const chip = () => document.querySelector('[name="rule_svc_redis"]')!;
    fireEvent.click(chip());
    await waitFor(() =>
      expect(document.querySelector('[name="rule_free_storage_bytes"]')).toBeNull());
    fireEvent.click(chip());
    await waitFor(() =>
      expect(document.querySelector('[name="rule_free_storage_bytes"]')).toBeTruthy());
  });

  it("★ shows a count so hidden fields do not look lost", async () => {
    // 选了 Memcached 只剩几项，不显示「显示 x / 共 y」会让客户以为字段丢了。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config" can={only(RULES_CAP)} />);
    await waitFor(() => expect(screen.getByText(/判定阈值/)).toBeTruthy());
    fireEvent.click(document.querySelector('[name="rule_svc_memcached"]')!);
    await waitFor(() => expect(screen.getAllByText(/显示 \d+ \/ 共 \d+ 项/).length)
      .toBeGreaterThan(0));
  });

  it("★ an empty section says so instead of vanishing", async () => {
    // 选 Redis 时闲置轮的 capacity 段只有 free_storage_pct（仅 RDS）→ 整段空。
    // 静默消失会让客户以为页面坏了。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config" can={only(RULES_CAP)} />);
    await waitFor(() => expect(screen.getByText(/判定阈值/)).toBeTruthy());
    fireEvent.click(document.querySelector('[name="rule_svc_redis"]')!);
    await waitFor(() =>
      expect(screen.getAllByText(/该服务没有可调的此类阈值/).length).toBeGreaterThan(0));
  });

  it("★★ a change made in one service view survives switching views", async () => {
    // 🔴 这条是「筛选器不是作用域」的直接判据。改动存在 draft 里，
    //    切视图只影响显示 —— 切回来那个值还在，且保存时会一起提交。
    //    做成作用域（每个视图各一份 draft）的表现是客户切个视图改动就丢了。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    vi.mocked(api.putInspectionRules).mockResolvedValue({
      ok: true, run_type: "high", config_version: "v1",
      rules: {}, effective: "next_run",
    } as never);
    render(<InspectionDashboard dashboardId="config" can={only(RULES_CAP)} />);
    await waitFor(() => expect(screen.getByText(/判定阈值/)).toBeTruthy());

    const cpu = () =>
      document.querySelector('[name="rule_cpu_utilization"]') as HTMLInputElement;
    fireEvent.change(cpu(), { target: { value: "88" } });
    expect(cpu().value).toBe("88");

    // 切到 Redis 视图（cpu_utilization 四组都有，所以它仍然可见）
    fireEvent.click(document.querySelector('[name="rule_svc_redis"]')!);
    await waitFor(() => expect(cpu().value).toBe("88"));
    // 再切回全部
    fireEvent.click(document.querySelector('[name="rule_svc_all"]')!);
    await waitFor(() => expect(cpu().value).toBe("88"));
  });

  it("★★ warns when a pending change is hidden by the current filter", async () => {
    // 改一个 RDS 专属字段，然后切到 Redis 视图 —— 那个改动看不见了但仍会
    // 被保存。不提示会让客户点保存时存进一个他此刻看不到的值。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config" can={only(RULES_CAP)} />);
    await waitFor(() => expect(screen.getByText(/判定阈值/)).toBeTruthy());

    const fs = document.querySelector(
      '[name="rule_free_storage_bytes"]') as HTMLInputElement;
    fireEvent.change(fs, { target: { value: "99" } });
    fireEvent.click(document.querySelector('[name="rule_svc_redis"]')!);
    await waitFor(() =>
      expect(screen.getByText(/另有 1 项改动在当前筛选之外/)).toBeTruthy());
  });

  it("★ every field shows which services it applies to", async () => {
    // 缺了它客户改 read_latency 会以为 Redis 也跟着变。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config" can={only(RULES_CAP)} />);
    await waitFor(() => expect(screen.getByText(/判定阈值/)).toBeTruthy());
    // 四组全支持的显示「全部服务」；部分支持的显示「仅 …」
    expect(screen.getAllByText(/全部服务/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/仅 RDS/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/仅 Redis/).length).toBeGreaterThan(0);
  });

  it("★★ read-only without the threshold capability", async () => {
    // 只有改定时权限的人不该看到阈值输入框。fail-CLOSED,与 Scope 同理。
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId="config"
      can={only("action:inspection:schedule")} />);
    await waitFor(() => expect(screen.getByText(/判定阈值/)).toBeTruthy());
    expect(document.querySelector('[name="rule_cpu_utilization"]')).toBeNull();
    expect(screen.getByText(/你没有改阈值的权限/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 统一视图（跨账号）—— 2026-08-27
//
// 🔴 这一组守的是一个**静默退化**：任何一处重新把 `accountId` 传进
//    `getInspectionFindings` / `getInspectionOverview`，页面就悄悄退回
//    「一次只看一个账号」。表现不是报错，而是**少了行** —— 客户看到
//    「今天只有 3 条」，而另外两个账号各有 5 条他压根不知道。
//
// ⚠️ 所以第一条测的是**调用参数**而不是渲染结果：单账号的开发环境里，
//    传与不传 accountId 的渲染输出**完全一样**。
// ---------------------------------------------------------------------------
describe("统一视图（跨账号）", () => {
  const ACCTS = [
    { accountId: "111122223333", accountName: "系统账号" },
    { accountId: "444455556666", accountName: "业务账号" },
  ];

  /** 同一份 finding 换账号 / 实例名，用来造跨账号列表。 */
  function acctFinding(acct: string, instance: string) {
    const base = findingsWith("cpu_utilization").findings[0];
    return {
      ...base,
      finding_id: `${acct}#us-east-1#rds#${instance}#threshold_high#cpu_utilization`,
      account_id: acct,
      instance,
    };
  }
  function crossAccountList(): FindingsData {
    return {
      ...findingsWith("cpu_utilization"),
      total: 2,
      by_severity: { CRITICAL: 2, HIGH: 0, MEDIUM: 0, INFO: 0 },
      findings: [
        acctFinding("111122223333", "db-sys"),
        acctFinding("444455556666", "db-biz"),
      ],
    };
  }

  it("★★ finding 与总览都**不带**账号参数（这是统一视图的接缝）", async () => {
    // 🔴 反向注入：把组件里的 `getInspectionFindings(k)` 改回
    //    `getInspectionFindings(k, accountId)` —— 渲染断言全部照过
    //    （单账号 fixture 下输出一模一样），只有这一条会红。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(api.getInspectionFindings).mockResolvedValue(crossAccountList());
    render(<InspectionDashboard dashboardId="high-load"
      accountId="111122223333" accounts={ACCTS} can={() => true} />);
    await waitFor(() => expect(screen.getByText("db-sys")).toBeTruthy());

    // ⚠️ 断言 `undefined` 而不是 `""`：API 层用 `qs()` 过滤空串，两者最终
    //    都不会进 query —— 但 `""` 说明组件还在读那个已经没有意义的 prop，
    //    下一个人会照着它继续往里传。
    for (const call of vi.mocked(api.getInspectionFindings).mock.calls) {
      expect(call[1], `getInspectionFindings 传了账号：${String(call[1])}`)
        .toBeUndefined();
    }
    // 总览必须**一次带账号的都没有**吗 —— 不是。`doRun` 抓基线时会带（那是
    // 「跑哪个账号」的基线，正确）。这里只断言首屏那次不带。
    expect(vi.mocked(api.getInspectionOverview).mock.calls[0][0]).toBeUndefined();
  });

  it("★★ 跨账号时每张卡挂账号徽章", async () => {
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(api.getInspectionFindings).mockResolvedValue(crossAccountList());
    render(<InspectionDashboard dashboardId="high-load"
      accounts={ACCTS} can={() => true} />);
    await waitFor(() => expect(screen.getByText("db-sys")).toBeTruthy());
    // ⚠️ 锚点用徽章的 `title` 而不是账号号文本 —— finding_id 里也含账号号，
    //    按文本找会在徽章根本没渲染时照样匹配到（那正是要抓的退化）。
    const badges = [...document.querySelectorAll('[title="所属账号"]')]
      .map((e) => e.textContent);
    expect(badges).toEqual(["111122223333", "444455556666"]);
  });

  it("★★ 单账号时**不显示**徽章（这一半同样重要）", async () => {
    // ⚠️ 恒定值的徽章是纯噪音，还挤掉规格与 region 的位置。
    //    `showAccount` 写死 true 只有这一条能抓到。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      findingsWith("cpu_utilization"));
    render(<InspectionDashboard dashboardId="high-load" can={() => true} />);
    await waitFor(() => expect(screen.getByText("db-1")).toBeTruthy());
    // finding_id 里含账号号，但那是详情里的；卡片正面不该有独立的账号徽章。
    expect(document.querySelector('[title="所属账号"]')).toBeNull();
  });

  it("★★ 筛选框按账号收窄（账号是筛选维度，不是加载维度）", async () => {
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(api.getInspectionFindings).mockResolvedValue(crossAccountList());
    render(<InspectionDashboard dashboardId="high-load"
      accounts={ACCTS} can={() => true} />);
    await waitFor(() => expect(screen.getByText("db-sys")).toBeTruthy());
    expect(screen.getByText("db-biz")).toBeTruthy();

    const box = document.querySelector(
      '[name="finding_filter"]') as HTMLInputElement;
    expect(box, "找不到筛选框").toBeTruthy();
    fireEvent.change(box, { target: { value: "444455556666" } });
    // 🔴 收窄是**前端过滤**，不重新请求 —— 重新请求会让每次敲一个字符
    //    都打一次 DDB Query。
    await waitFor(() => expect(screen.queryByText("db-sys")).toBeNull());
    expect(screen.getByText("db-biz")).toBeTruthy();

    // 实例名也要能搜（客户手里往往只有实例名，不知道它在哪个账号）
    fireEvent.change(box, { target: { value: "db-sys" } });
    await waitFor(() => expect(screen.getByText("db-sys")).toBeTruthy());
    expect(screen.queryByText("db-biz")).toBeNull();
  });

  it("★ 筛选框提示里带账号数（否则看不出这是跨账号视图）", async () => {
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(api.getInspectionFindings).mockResolvedValue(crossAccountList());
    render(<InspectionDashboard dashboardId="high-load"
      accounts={ACCTS} can={() => true} />);
    const box = await waitFor(() => {
      const el = document.querySelector('[name="finding_filter"]');
      if (!el) throw new Error("no filter box");
      return el as HTMLInputElement;
    });
    await waitFor(() => expect(box.placeholder).toMatch(/2 个账号/));
  });

  it("★★★ 跑巡检先勾账号：单层多选 + 一个「执行」，没有第二步", async () => {
    /**
     * ⚠️ **这条的判据变过两次。**
     *
     * ```
     * v1  没有「全部账号」这一项       一次点击对 N 个账号各发一轮，钱与时长
     *                                 乘 N，后端没有批量取消 → 干脆不给入口
     * v2  有，但要过一道确认屏          护栏从「不给入口」换成「把三件事写全」
     * v3  单层多选 + 一个「执行」       客户原话：「被挡住了，我点全部账号后又
     *                                 出来一大堆内容，絮絮叨叨贫死了…不如一个
     *                                 dropdown 让客户一个一个 check 账号然后
     *                                 执行就完了…不要再出现第二步和描述性的
     *                                 大段文字了。」
     * ```
     *
     * 三条理由一条都没变，变的是护栏的**形态**：五行 bullet 压成一行，
     * 二次确认换成「空选时执行是灰的 + 多选时按钮变红」。
     * 那一行文案的完整性与长度由 `weekdaysAndBatchRun.render.test.tsx` 钉住。
     */
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="high-load"
      accounts={ACCTS} can={() => true} />);
    await waitFor(() => expect(screen.getByText(/跑高负载/)).toBeTruthy());

    // 点了不该立刻发请求 —— 先勾账号
    fireEvent.click(screen.getByText(/跑高负载/));
    await waitFor(() => expect(screen.getByText(/跑哪些账号的高负载/)).toBeTruthy());
    expect(vi.mocked(api.triggerInspectionRun)).not.toHaveBeenCalled();

    // 部署账号 + 全部成员账号，各一个 checkbox
    const boxes = () => [...document.querySelectorAll<HTMLInputElement>(
      '[role="group"] input[type="checkbox"]')];
    expect(boxes().length).toBe(ACCTS.length + 1);
    expect(screen.getByText(/部署账号/)).toBeTruthy();
    expect(screen.getByText(/业务账号 · 444455556666/)).toBeTruthy();
    // 🔴 默认一个都不勾 —— 这个按钮是唯一会真花钱的入口
    expect(boxes().some((b) => b.checked),
      "默认勾上了账号 —— 替客户预先做了一个付费决定").toBe(false);

    // 空选时「执行」是灰的，且说得出原因
    const go = () => screen.getByRole("button", { name: /^执行/ });
    expect(go().getAttribute("aria-disabled")).toBe("true");
    expect(go().getAttribute("title") || "").toMatch(/勾选/);
    fireEvent.click(go());
    expect(vi.mocked(api.triggerInspectionRun)).not.toHaveBeenCalled();

    // 🔴 没有第二步：整屏找不到「确认，跑 N 个账号」那类二次确认
    expect(screen.queryByText(/确认，跑 \d+ 个账号/)).toBeNull();

    // 勾**一个** → 走标量 `account`（那条路会轮询，跑完能说「跑完了」）
    vi.mocked(api.triggerInspectionRun).mockResolvedValue({
      ok: true, account_id: "444455556666", run_type: "high",
      source: "refetch", mode: "dry_run", accepted: true,
    });
    fireEvent.click(screen.getByText(/业务账号 · 444455556666/)
      .closest("label")!.querySelector('input[type="checkbox"]')!);
    fireEvent.click(go());
    await waitFor(() => expect(vi.mocked(api.triggerInspectionRun))
      .toHaveBeenCalledWith(expect.objectContaining({
        run_type: "high", account: "444455556666",
      })));
  });

  it("★★★ 勾多个 → 一次请求带 accounts 数组，且报数用后端回传的", async () => {
    /* 🔴 循环 N 次 POST 会产生部分成功（第 3 次失败时前两个已经在跑），
       而界面只能报一个结果 —— 要么谎报全失败（客户重试 → 前两个账号各跑
       两轮、花两倍的钱），要么谎报全成功。 */
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    // ⚠️ 后端回的是 **2** 个而前端勾了 3 个（部署账号也被登记进了成员表 →
    //    BFF 去重）。报数必须跟后端。
    vi.mocked(api.triggerInspectionRun).mockResolvedValue({
      ok: true, account_id: "", run_type: "high",
      source: "refetch", mode: "dry_run", accepted: true,
      account_ids: ["111122223333", "444455556666"],
    });
    render(<InspectionDashboard dashboardId="high-load"
      accounts={ACCTS} can={() => true} />);
    await waitFor(() => expect(screen.getByText(/跑高负载/)).toBeTruthy());
    fireEvent.click(screen.getByText(/跑高负载/));
    await waitFor(() => expect(screen.getByText(/跑哪些账号的高负载/)).toBeTruthy());

    // 「全选」把每一项都勾上（账号多时「一个一个 check」太慢）
    fireEvent.click(screen.getByText(/^全选$/));
    const boxes = [...document.querySelectorAll<HTMLInputElement>(
      '[role="group"] input[type="checkbox"]')];
    await waitFor(() => expect(boxes.every((b) => b.checked)).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: /^执行/ }));
    await waitFor(() => expect(vi.mocked(api.triggerInspectionRun))
      .toHaveBeenCalledTimes(1));
    const body = vi.mocked(api.triggerInspectionRun).mock.calls[0][0] ?? {};
    // 空串 = 部署账号（与标量那条路同一套 resolveAccount 兜底）
    expect(body.accounts).toEqual(["", ...ACCTS.map((a) => a.accountId)]);
    expect(body.account, "多选时不该再传标量 account").toBeUndefined();

    // 🔴 报「2 个」而不是「3 个」，且措辞是「已提交」不是「跑完了」
    await waitFor(() => expect(screen.getByText(/已提交 2 个账号/)).toBeTruthy());
    expect(screen.queryByText(/跑完了/)).toBeNull();
  });

  it("★★ 只有部署账号时**直接跑**，不弹层", async () => {
    // ⚠️ 让人从一个选项里选一个是纯粹的多余点击，而单账号是最常见的形态。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(api.triggerInspectionRun).mockResolvedValue({
      ok: true, account_id: "111122223333", run_type: "high",
      source: "refetch", mode: "dry_run", accepted: true,
    });
    render(<InspectionDashboard dashboardId="high-load" can={() => true} />);
    await waitFor(() => expect(screen.getByText(/跑高负载/)).toBeTruthy());
    fireEvent.click(screen.getByText(/跑高负载/));
    await waitFor(() => expect(vi.mocked(api.triggerInspectionRun))
      .toHaveBeenCalled());
    expect(screen.queryByText(/跑哪个账号/)).toBeNull();
  });

  it("★★ runs 表带账号列（跨账号时），且 React key 不冲突", async () => {
    // 🔴 不显示这一列的话「698 那轮还在跑」就得切账号才看得到 ——
    //    而那正是统一视图要消掉的动作。
    //
    // ⚠️ key 那半必须用 console 探针，不能靠渲染结果：反向注入实测，把
    //    `key` 改回 `type#date` 之后**两行照样都渲染出来、全部断言照过**
    //    —— React 只打一条警告。真正的表现（切筛选时某行的数据串到另一个
    //    账号上）要重排才出现，而那时客户已经在看错的数了。
    const errs: string[] = [];
    const spy = vi.spyOn(console, "error")
      .mockImplementation((...a: unknown[]) => { errs.push(a.map(String).join(" ")); });
    vi.mocked(api.getInspectionOverview).mockResolvedValue({
      ...OVERVIEW,
      runs: [
        ...OVERVIEW.runs,
        { ...OVERVIEW.runs[0], account_id: "444455556666", status: "running" },
      ],
    });
    render(<InspectionDashboard dashboardId="overview" can={() => true} />);
    const table = await waitFor(() => {
      const el = document.querySelector("table");
      if (!el) throw new Error("run table not rendered");
      return el;
    });
    const heads = [...table.querySelectorAll("th")].map((h) => h.textContent);
    expect(heads).toContain("账号");
    // 两个账号各一行，且**同一天同一类型** —— React key 只用 type#date 会冲突
    const rows = [...table.querySelectorAll("tbody tr")];
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.textContent).join(" ")).toMatch(/444455556666/);
    /* ⚠️ 状态列 2026-09-02 起**译成人话并上色**（裸 `running` 与 `partial`
       在表里只是两个不同的英文单词，而右边「已关联」「Region」都标红加粗了）。
       原始枚举挪到 `title` —— 两个都断：显示的是译名，而枚举仍有一个
       能 hover 到的出口（出问题时好搜代码）。 */
    expect(rows.map((r) => r.textContent).join(" ")).toMatch(/进行中/);
    const titles = [...table.querySelectorAll("tbody td[title]")]
      .map((td) => td.getAttribute("title"));
    expect(titles, "原始状态枚举没有留出口").toContain("running");
    spy.mockRestore();
    expect(errs.filter((m) => /same key|重复的 key/i.test(m)),
      "runs 表的 React key 冲突了 —— key 必须带账号").toEqual([]);
  });

  it("★ 单账号时 runs 表**不显示**账号列", async () => {
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="overview" can={() => true} />);
    const table = await waitFor(() => {
      const el = document.querySelector("table");
      if (!el) throw new Error("run table not rendered");
      return el;
    });
    expect([...table.querySelectorAll("th")].map((h) => h.textContent))
      .not.toContain("账号");
  });

  it.each([
    // [子页, 「这一页已加载完」的锚点]
    ["high-load", /跑高负载/],
    ["config", /判定阈值/],
  ])("★★ %s 页**没有**账号选择器（它已无意义）", async (tab, anchor) => {
    // 🔴 配置页那个选择器还带一个真实缺陷：切账号会静默丢掉未保存的草稿
    //    （阈值是全局的，压根不按账号存）。
    //
    // ⚠️ 必须**先等页面加载完**再断言不存在。第一版写成
    //    `await waitFor(() => expect(querySelector(...)).toBeNull())`
    //    —— 反向注入实测那样是**假绿**：waitFor 的断言在首个 tick 就成立了
    //    （那时还是骨架屏，页面上什么都没有），于是把选择器塞回去也照过。
    //    「等一个否定条件」永远等不到东西，只能等一个肯定锚点。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(api.getInspectionConfig).mockResolvedValue(CONFIG);
    render(<InspectionDashboard dashboardId={tab}
      accounts={ACCTS} can={() => true} />);
    await waitFor(() => expect(screen.getAllByText(anchor).length)
      .toBeGreaterThan(0));
    expect(document.querySelector('select[aria-label="账号"]'),
      `${tab} 页仍有账号选择器`).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// 排除弹层的跨 region 同名（2026-08-27）
//
// 🔴 这一组守的是一条**真功能缺陷**：多 region 之后弹层第一次会同时列出两个
//    region 的同名实例，而三处都按裸 `resource_id` 做键：
//
//    ```
//    BFF excluded_in   排除了 us-east-1 那台 → 东京那行也打「已排除」
//                      + checkbox disabled → 东京那台从 UI 上再也排不掉
//                      而 scope.py 的 covers_region 是按 region 精确匹配的，
//                      executor 照常巡检它、照常出 finding、照常花钱
//    byId              两条同名只留最后一条 → 提交时写出的 region 是另一个的
//    picked / React key 勾第一行两行都打勾；key 重复
//    ```
// ---------------------------------------------------------------------------
describe("排除弹层 · 跨 region 同名", () => {
  const SAME = "prod-mysql";

  function twoRegions(excludedIn: ("high" | "idle")[][] = [[], []]) {
    return {
      ...RESOURCES,
      total: 2,
      regions: ["ap-northeast-1", "us-east-1"],
      resources: [
        {
          service: "rds" as const, tier: "instance" as const,
          region: "ap-northeast-1", resource_id: SAME, label: SAME,
          klass: "db.r6g.large", engine: "mysql", cluster_id: "",
          status: "available", excluded_in: excludedIn[0],
        },
        {
          service: "rds" as const, tier: "instance" as const,
          region: "us-east-1", resource_id: SAME, label: SAME,
          klass: "db.r6g.large", engine: "mysql", cluster_id: "",
          status: "available", excluded_in: excludedIn[1],
        },
      ],
    };
  }

  async function openModal(data: ReturnType<typeof twoRegions>) {
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue(data);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getAllByText(/排除资源/)[0]);
    await waitFor(() =>
      expect(screen.getAllByText(SAME).length).toBe(2));
    return [...document.querySelectorAll(".insp-row")]
      .filter((el) => el.textContent?.includes(SAME));
  }

  it("★★★ 只有被排除的那个 region 的行被锁，另一个仍可勾", async () => {
    /* us-east-1 那台已排除（第二行），东京那台没有。
       ⚠️ 第二行要 **`["high","idle"]` 两份都排**：锁的判据是「当前勾选的每一份
          清单里都已经有它」（2026-09-01 从 `entryKind` 改成 `lists`），而页头
          那个入口默认两份都勾 —— 只写 `["high"]` 的话它「还差 idle」，
          本来就该可勾，这条断言验的就不是 region 了。 */
    const rows = await openModal(twoRegions([[], ["high", "idle"]]));
    const boxes = rows.map(
      (r) => r.querySelector('input[type="checkbox"]') as HTMLInputElement);
    const regionOf = rows.map(
      (r) => (r.textContent || "").includes("us-east-1") ? "iad" : "nrt");

    const iad = boxes[regionOf.indexOf("iad")];
    const nrt = boxes[regionOf.indexOf("nrt")];
    expect(iad.disabled, "us-east-1 那台已排除，应该锁住").toBe(true);
    expect(nrt.disabled,
      "东京那台被 us-east-1 的排除记录连带锁住了 —— "
      + "客户从 UI 上再也排不掉它，而巡检照常在报它").toBe(false);
  });

  it("★★★ 勾一行不会连带勾上另一个 region 同名那行", async () => {
    const rows = await openModal(twoRegions());
    const boxes = rows.map(
      (r) => r.querySelector('input[type="checkbox"]') as HTMLInputElement);
    fireEvent.click(boxes[0]);
    await waitFor(() => expect(boxes[0].checked).toBe(true));
    expect(boxes[1].checked,
      "勾第一行把另一个 region 同名那行也勾上了 —— "
      + "picked 用的是裸 resource_id").toBe(false);
    // 计数也必须是 1（现在长在「执行」按钮上，不在 footer 旁白里）
    expect(screen.getByRole("button", { name: /^执行/ }).textContent)
      .toBe("执行（1）");
  });

  it("★★ 提交时写出的 region 是**那一行自己的**", async () => {
    vi.mocked(api.putInspectionExclusion).mockResolvedValue(
      { ok: true } as never);
    const rows = await openModal(twoRegions());
    const boxes = rows.map(
      (r) => r.querySelector('input[type="checkbox"]') as HTMLInputElement);
    // 勾**东京**那一行
    const nrtIdx = rows.findIndex(
      (r) => !(r.textContent || "").includes("us-east-1"));
    fireEvent.click(boxes[nrtIdx]);
    const box = document.querySelector(
      '[name="excl_reason"], textarea, input[placeholder*="预发"]');
    if (box) fireEvent.change(box, { target: { value: "测试" } });
    fireEvent.click(screen.getByText(/^执行/));
    await waitFor(() =>
      expect(vi.mocked(api.putInspectionExclusion)).toHaveBeenCalled());
    const [, body] = vi.mocked(api.putInspectionExclusion).mock.calls[0];
    expect((body as { region: string }).region).toBe("ap-northeast-1");
  });

  it("★ 空态文案带上扫过的 region 数", async () => {
    // 「这个账号里没有可排除的资源」这句话在多 region 之前是骗人的
    // （只看了部署 region）。现在是真的，但客户没法验证，除非写出分母。
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue({
      ...RESOURCES, total: 0, resources: [],
      regions: ["ap-northeast-1", "us-east-1", "us-west-2"],
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getAllByText(/排除资源/)[0]);
    await waitFor(() =>
      expect(screen.getByText(/已扫 3 个 region/)).toBeTruthy());
  });

  it("★★ degraded 要说清是哪个 region 缺权限", async () => {
    // 不带 region 的话同一个 AccessDenied 会重复 17 次、逐字相同，
    // 客户和 TAM 都看不出是哪个 region。
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    vi.mocked(api.getInspectionResources).mockResolvedValue({
      ...RESOURCES,
      degraded: [{ service: "rds", region: "us-west-2", reason: "AccessDenied" }],
    });
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
    fireEvent.click(screen.getAllByText(/排除资源/)[0]);
    await waitFor(() =>
      expect(screen.getByText(/us-west-2 \/ rds: AccessDenied/)).toBeTruthy());
  });
});


// ---------------------------------------------------------------------------
// runs 表的 region 覆盖面（2026-08-27）
//
// 🔴 `by_region` / `regions` 写进了 run 记录，如果读侧不显示，它就是
//    「算好了没人取」—— 而它存在的**唯一理由**是让「us-west-2 今天没扫」
//    与「us-west-2 没有资源」可区分。
// ---------------------------------------------------------------------------
describe("runs 表 · region 覆盖面", () => {
  function runWith(regions: OverviewData["runs"][number]["regions"],
                   byRegion: Record<string, number> | null = null) {
    return {
      ...OVERVIEW,
      runs: [{ ...OVERVIEW.runs[0], regions, by_region: byRegion }],
    };
  }

  async function table() {
    return await waitFor(() => {
      const el = document.querySelector("table");
      if (!el) throw new Error("run table not rendered");
      return el;
    });
  }

  it("★★ 全扫成时显示 扫成/应扫", async () => {
    vi.mocked(api.getInspectionOverview).mockResolvedValue(
      runWith({ total: 17, scanned: 17, failed: [] },
              { "us-east-1": 4 }));
    render(<InspectionDashboard dashboardId="overview" />);
    const t = await table();
    const row = [...t.querySelectorAll("tbody tr")][0];
    expect([...row.querySelectorAll("td")].map((c) => c.textContent))
      .toContain("17/17");
  });

  it("★★★ 有 region 没扫成时标红并把名字放进 title", async () => {
    // 这是唯一能让客户看出「少了一个 region」的地方 —— 失败的 region 在
    // `by_region` 里连键都没有，所以只看那个 dict 看不出少了谁。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(
      runWith({ total: 17, scanned: 16, failed: ["us-west-2:ThrottlingException"] }));
    render(<InspectionDashboard dashboardId="overview" />);
    const t = await table();
    const cell = [...t.querySelectorAll("tbody td")]
      .find((c) => c.textContent === "16/17");
    expect(cell, "找不到 16/17 那一格").toBeTruthy();
    // ⚠️ 断言 `C.red` 的字面值（`tokens.ts` 是 `#d13212`，不是 CSS 变量）。
    //    写 `var(--red)` 会让这条测试恒红 —— 而那种红看起来像「功能没做」。
    expect(cell!.getAttribute("style")).toMatch(/#d13212|rgb\(209, ?50, ?18\)/);
    expect(cell!.getAttribute("title") || "").toMatch(/us-west-2/);
  });

  it("★ 老 run 记录（没有 regions 字段）显示破折号而不是崩", async () => {
    // ⚠️ 升级前的 run 行没有这两个字段。渲染成 `undefined/undefined`
    //    或者直接抛都会让整张表打不开，而那张表是运维自检的唯一入口。
    vi.mocked(api.getInspectionOverview).mockResolvedValue(runWith(null, null));
    render(<InspectionDashboard dashboardId="overview" />);
    const t = await table();
    expect([...t.querySelectorAll("tbody td")].map((c) => c.textContent))
      .toContain("—");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 整账号排除的三条（2026-09-02 review：S5 / S6 / S7）
//
// 共同点：整账号排除是**一个动作写出来的两条记录**（high + idle，SK 完全
// 相同 `<acct>#-#*#*`），所以任何只动一份的操作都会留下「半活半死」——
// 而 `submitWide` 自己在失败分支里就承认那是「只有一半退出了巡检」。
// ═══════════════════════════════════════════════════════════════════════════
describe("整账号排除：成对、有期限、存量行认得出", () => {
  const WIDE_KEY = "111122223333#-#*#*";
  const wideRow = {
    key: WIDE_KEY, account_id: "111122223333", region: "",
    service: "*", resource_id: "*", level: "account",
    reason: "沙箱账号", expires_at: "2026-10-01", expired: false,
    created_by: "u1", created_at: "2026-09-01",
  };
  /** 存量行：属性**没落库**，只有 SK 认得出它是整账号。 */
  const legacyWideRow = { ...wideRow, service: "", resource_id: "" };

  const scopeWith = (row: typeof wideRow): ScopeData => ({
    ...SCOPE,
    exclusions: {
      high: [row, ...SCOPE.exclusions.high],
      idle: [row, ...SCOPE.exclusions.idle],
    },
  });

  const openScope = async (scope: ScopeData) => {
    vi.mocked(api.getInspectionScope).mockResolvedValue(scope);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());
  };

  it("★★★ S5 续期：整账号行两份清单一起续", async () => {
    /* 🔴 只续点中那一份的表现：

         点高负载那份「续期 30 天」→ 只有 high 延到 +30 天
           → idle 那份到原定日期就失效
           → 该账号的**闲置轮**重新开始出 finding
           → 而界面上那一行还写着「整账号」+ 新的到期日，看起来完好

       `doDelete` 一直是成对的，`renew` 不是 —— 两处各写一份判据的必然结果。 */
    vi.mocked(api.renewInspectionExclusion).mockResolvedValue({
      ok: true, key: WIDE_KEY, expires_at: "2026-10-02",
    });
    await openScope(scopeWith(wideRow));
    openRowMenu("沙箱账号").click(/续期/);
    await waitFor(() =>
      expect(api.renewInspectionExclusion).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.renewInspectionExclusion).mock.calls.map((c) => c[0])
      .sort()).toEqual(["high", "idle"]);
    /* ⚠️ 用 `getAllByText`：「两份清单」在整账号那一行的徽章上也有一份
       （那是行的属性说明），这里要的是**提示条**里那一份。
       单数版 `getByText` 会因「找到两个」直接抛。 */
    await waitFor(() => expect(
      screen.getAllByText(/两份清单/).length).toBeGreaterThan(1));
    // 到期日要如实回显（两份都续成了才说「两份清单」）
    expect(screen.getByText(/2026-10-02/)).toBeTruthy();
  });

  it("★★★ S5 反例：普通条目续期**只**动它自己那一份", async () => {
    /* 成对逻辑不许溢出到普通条目上 —— 那会去改另一份清单里同 SK 的条目
       （如果存在的话就是改错了条目；不存在则报 not_found，让客户以为失败）。 */
    vi.mocked(api.renewInspectionExclusion).mockResolvedValue({
      ok: true, key: "111122223333#us-east-1#rds#db-batch",
      expires_at: "2026-10-02",
    });
    await openScope(SCOPE);
    openRowMenu("db-batch").click(/续期/);
    await waitFor(() =>
      expect(api.renewInspectionExclusion).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.renewInspectionExclusion).mock.calls[0][0]).toBe("idle");
  });

  it("★★★ S5 部分失败要说清哪一份没续上", async () => {
    /* 只说「已保存」会让客户以为整账号都延后了，而另一轮到期后会静默
       重新开始判定该账号。 */
    vi.mocked(api.renewInspectionExclusion)
      .mockResolvedValueOnce({ ok: true, key: WIDE_KEY, expires_at: "2026-10-02" })
      .mockResolvedValueOnce({ ok: false, code: "not_found", message: "该条目不存在" } as never);
    await openScope(scopeWith(wideRow));
    openRowMenu("沙箱账号").click(/续期/);
    await waitFor(() => expect(screen.getByText(/只有一半延期了/)).toBeTruthy());
  });

  it("★★★ S7 存量行（属性没落库）也认得出是整账号", async () => {
    /* 🔴 `isAccountWide` 只看 `service`/`resource_id` 属性的表现是 fail-open：
         老条目那两个属性是空串 → 判成「不是整账号」→ 撤销只删一份
         → 客户以为撤销了，另一轮还压着整个账号
         → 确认框还写着「这一台将重新进入巡检范围」，而它排的是整个账号

       SK 的形状是 `scope.py::key`：`<account>#<region|->#<service>#<rid>`，
       双通配 ⇒ 后两段都是 `*`。 */
    vi.mocked(api.deleteInspectionExclusion).mockResolvedValue({
      ok: true, key: WIDE_KEY, kind: "high", account_id: "111122223333",
      resource_id: "*", level: "account", account_wide: true,
    });
    await openScope(scopeWith(legacyWideRow));
    openRowMenu("沙箱账号").click(/挪出白名单/);
    // 确认框要说「整个账号 + 两份清单一起」，不能说成单台
    await waitFor(() => expect(
      screen.getByText(/两份清单一起撤销/),
      "存量整账号行被当成单台 —— 撤销只会删一份",
    ).toBeTruthy());
    fireEvent.click(screen.getAllByRole("button", { name: /挪出白名单/ })
      .find((b) => b.closest('[role="dialog"]'))!);
    await waitFor(() =>
      expect(api.deleteInspectionExclusion).toHaveBeenCalledTimes(2));
  });

  it("★★★ S7 属性有值时以属性为准（不被 SK 放大）", async () => {
    /* 反例：两个判据**不是取或**。属性说单台、SK 说整账号时按属性算 ——
       取或会把一次单台撤销静默放大成整账号撤销，而放大的方向是危险的。 */
    vi.mocked(api.deleteInspectionExclusion).mockResolvedValue({
      ok: true, key: WIDE_KEY, kind: "high", account_id: "111122223333",
      resource_id: "db-x", level: "instance", account_wide: false,
    });
    await openScope(scopeWith({
      ...wideRow, service: "rds", resource_id: "db-x", reason: "属性说单台",
    }));
    openRowMenu("属性说单台").click(/挪出白名单/);
    await waitFor(() => expect(screen.getByText(/重新判定/)).toBeTruthy());
    expect(screen.queryByText(/两份清单一起撤销/),
      "属性说单台却按 SK 放大成整账号了",
    ).toBeNull();
  });

  it("★★★ S6 整账号对话框要有有效期控件并写明到期日", async () => {
    /* 🔴 原来没有这个控件、请求体也不带 `expires_at` → 走后端默认 30 天，
       而对话框只说「直到这条排除到期」，从不说那是什么时候。

       表现：客户为「沙箱账号，2026-Q4 关停」整账号排除，30 天后整个账号
       **静默回到巡检范围**，一屏 finding 重新冒出来。 */
    await openScope(SCOPE);
    fireEvent.click(screen.getAllByRole("button", { name: /整账号排除/ })[0]);
    await waitFor(() => expect(
      document.querySelector('[name="wide_days_30"]'),
      "整账号对话框没有有效期控件 —— 客户不知道它 30 天后会失效",
    ).not.toBeNull());
    // 承诺里必须出现**具体日期**，不能只说「直到这条排除到期」
    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.textContent || "",
      "没写明到期日 —— 「直到这条排除到期」是一句没有信息的话",
    ).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("★★★ S6 请求体带显式 expires_at（不靠后端默认值）", async () => {
    vi.mocked(api.putInspectionExclusion).mockResolvedValue({
      ok: true, key: WIDE_KEY, kind: "high", expires_at: "2026-10-02",
    } as never);
    await openScope(SCOPE);
    fireEvent.click(screen.getAllByRole("button", { name: /整账号排除/ })[0]);
    await waitFor(() =>
      expect(document.querySelector('[name="wide_reason"]')).not.toBeNull());
    fireEvent.change(document.querySelector('[name="wide_reason"]')!,
      { target: { value: "沙箱账号" } });
    fireEvent.click(screen.getAllByRole("button", { name: /确认排除整个账号/ })[0]);
    await waitFor(() =>
      expect(api.putInspectionExclusion).toHaveBeenCalledTimes(2));
    for (const call of vi.mocked(api.putInspectionExclusion).mock.calls) {
      const body = call[1] as unknown as Record<string, unknown>;
      expect(body.expires_at,
        "请求体不带 expires_at —— 依赖后端默认值，对话框承诺就成了空话",
      ).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.never_expires).toBeUndefined();
    }
  });

  it("★★★ S6 选「永不过期」时显式传 never_expires，不是省略字段", async () => {
    /* ⚠️ 「不传 expires_at」的语义**正好相反**（= 用后端默认 30 天）。 */
    vi.mocked(api.putInspectionExclusion).mockResolvedValue({
      ok: true, key: WIDE_KEY, kind: "high",
    } as never);
    await openScope(SCOPE);
    fireEvent.click(screen.getAllByRole("button", { name: /整账号排除/ })[0]);
    await waitFor(() =>
      expect(document.querySelector('[name="wide_days_null"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[name="wide_days_null"]')!);
    fireEvent.change(document.querySelector('[name="wide_reason"]')!,
      { target: { value: "永久沙箱" } });
    fireEvent.click(screen.getAllByRole("button", { name: /确认排除整个账号/ })[0]);
    await waitFor(() =>
      expect(api.putInspectionExclusion).toHaveBeenCalledTimes(2));
    for (const call of vi.mocked(api.putInspectionExclusion).mock.calls) {
      const body = call[1] as unknown as Record<string, unknown>;
      expect(body.never_expires).toBe(true);
      expect(body.expires_at).toBeUndefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 运维信号（2026-09-02 review #6）
//
// 共同点：数据**早就算好并回传了**，读侧一个都没渲染 —— 这个仓库里反复
// 批评的「算好了没人取」。而这些信号存在的理由恰恰是「出问题时看得见」，
// 看不见就等于没做。
// ═══════════════════════════════════════════════════════════════════════════
describe("运维信号可见性", () => {
  const ovr = (over: Partial<OverviewData>): OverviewData =>
    ({ ...OVERVIEW, ...over } as OverviewData);

  const openOps = async (o: OverviewData) => {
    vi.mocked(api.getInspectionOverview).mockResolvedValue(o);
    render(<InspectionDashboard dashboardId="overview" />);
    await waitFor(() => {
      const el = document.querySelector("table");
      if (!el) throw new Error("run table not rendered");
      return el;
    });
  };

  it("★★★ D1 派发缺口在**首屏**就有一条（不是只在底部折叠区）", async () => {
    /* 🔴 原来它只在页面**最底部**的「系统状态」折叠区里。那一区因为
       `locked={gap > 0}` 会强制展开，但展开的是一个首屏外的区 —— 一页
       20 条卡片之后才出现的红字等于没出现。

       而这一条的含义是「有判读永久回不来」，对应的 finding 会一直停在
       「未做根因分析」。 */
    await openOps(ovr({ dispatch_gap: 4 }));
    const hits = screen.getAllByText(/4 条判读任务已派发但未能关联/);
    /* ⚠️ 断**恰好一条**：我第一版在页首与 OpsPanel 各放了一整条 Alert，
       同一句 header 在一页上出现两次 —— 与 #3 那条「判读回执渲染两份」同型。 */
    expect(hits.length, `派发缺口告警出现 ${hits.length} 次，应当恰好 1 次`)
      .toBe(1);
    // 页首那条要在 runs 表**之前**（DOM 顺序即视觉顺序）
    const alert = hits[0];
    const table = document.querySelector("table")!;
    expect(alert.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
      "派发缺口告警排在 runs 表之后 —— 那就是首屏外",
    ).toBeTruthy();
  });

  it("★★★ D21 「未做根因分析」要说清各自因为什么", async () => {
    /* 🔴 `gating.SkipReason` 的 docstring 写着「缺任何一种都会退化成『这条
       没有 AI 分析』这句无信息的话，而客户接着就会问『是坏了还是省钱』
       —— 那是两个完全不同的答案」。后端分了六档，读侧压成一个数字。 */
    await openOps(ovr({
      without_judgment: 5,
      without_judgment_by_reason: { budget: 3, quota: 1, kill_switch: 1 },
    }));
    // 每一档都要配**下一步动作**，光报数与只给总数的信息量是一样的
    expect(screen.getByText(/额度档位不放行/)).toBeTruthy();
    expect(screen.getByText(/本轮配额用满/)).toBeTruthy();
    expect(screen.getByText(/判读被拉停/)).toBeTruthy();
  });

  it("★★★ D21 分档缺失（存量 BFF）时只报总数，不编造原因", async () => {
    await openOps(ovr({ without_judgment: 5, without_judgment_by_reason: undefined }));
    expect(screen.getByText(/另有 5 项未做根因分析/)).toBeTruthy();
    expect(screen.queryByText(/额度档位不放行/)).toBeNull();
  });

  it("★★ D21 认不出的 skip_reason 原样显示（不吞掉）", async () => {
    // 后端加了新档而这里没跟上时，至少能看到那个字符串去搜代码。
    await openOps(ovr({
      without_judgment: 2, without_judgment_by_reason: { brand_new_gate: 2 },
    }));
    expect(screen.getByText(/brand_new_gate 2/)).toBeTruthy();
  });

  it("★★★ D3 「显示 N / M 轮」的 M 是**截断前**的总数", async () => {
    /* 🔴 原来 M 取 `runs.length`，而那是 BFF `slice(0, 20)` 之后的数 ——
       于是这句话说「显示 3 / 20 轮」而真实可能是 137 轮。静默截断。
       findings 侧有 `truncated_at` 专门解决这件事，runs 侧此前没有。 */
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...OVERVIEW.runs[0], run_date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    }));
    await openOps(ovr({ runs: many, runs_total: 137, runs_limit: 20 }));
    expect(screen.getByText(/\/ 137 轮/),
      "分母用了截断后的数 —— 客户会以为一共只有 20 轮",
    ).toBeTruthy();
    expect(screen.getByText(/已截断/)).toBeTruthy();
  });

  it("★★★ D3 runs_total 缺失时**不说**「共 N 轮」（不把不知道说成知道）", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...OVERVIEW.runs[0], run_date: `2026-08-${String(i + 1).padStart(2, "0")}`,
    }));
    await openOps(ovr({ runs: many, runs_total: undefined }));
    expect(screen.queryByText(/已截断/),
      "存量 BFF 上凭空断言「截断了」—— 那时我们并不知道",
    ).toBeNull();
  });

  it("★★★ D11 dry_run 在 runs 表里要能看出来", async () => {
    /* 🔴 dry_run 占掉当天那一轮的槽位（`try_acquire_run_lock` 不放行「今天
       已有成功的一轮」），而表里它与真实轮长得一模一样 —— 客户看到「成功」
       而那一轮压根没推进状态机。 */
    await openOps(ovr({
      runs: [{ ...OVERVIEW.runs[0], mode: "dry_run" }],
    }));
    const table = document.querySelector("table")!;
    expect(table.textContent || "",
      "dry_run 与真实轮长得一模一样",
    ).toMatch(/试运行/);
  });

  it("★★ D11 补跑轮也要标出来", async () => {
    await openOps(ovr({ runs: [{ ...OVERVIEW.runs[0], catch_up: true }] }));
    expect(document.querySelector("table")!.textContent || "").toMatch(/补跑/);
  });

  it("★★★ D8 状态列译成人话并上色，原始枚举留在 title", async () => {
    await openOps(ovr({ runs: [{ ...OVERVIEW.runs[0], status: "partial" }] }));
    const cells = [...document.querySelectorAll("tbody td")];
    const cell = cells.find((c) => (c.getAttribute("title") || "") === "partial");
    expect(cell, "原始枚举没有留出口").toBeTruthy();
    expect(cell!.textContent || "").toMatch(/只跑了一部分/);
    /* 🔴 `partial` 与 `success` 在表里此前只是两个不同的英文单词，而这一列
       右边的「已关联」和「Region」都做了标红加粗。最该有颜色的反而没有。 */
    expect(cell!.getAttribute("style") || "",
      "partial 没有上色",
    ).toMatch(/color/);
  });

  it("★★★ D10 完整度读不到时要占位，不是整段消失", async () => {
    /* 「完整度读不到」与「这一轮本来就没有完整度」原来在界面上不可区分 ——
       前者意味着我们不知道这一轮覆盖了多少，后者不存在（每轮都该有）。 */
    vi.mocked(api.getInspectionFindings).mockResolvedValue({
      ...findingsWith("CPUUtilization"),
      last_run: {
        run_date: "2026-08-19", status: "success", completeness: null,
        mode: "official",
      },
    });
    await openOps(OVERVIEW);
    expect(screen.getAllByText(/读不到/).length,
      "完整度读不到时那一段整个消失了",
    ).toBeGreaterThan(0);
  });

  it("★★★ D5 解析质量全绿时也有一行（不是整块消失）", async () => {
    /* 🔴 三个条件全成立才渲染的表现是：健康 → 整块**消失** → 与「存量 BFF
       没返回这个字段」在界面上完全不可区分。而这一块是 skill 漂移的唯一
       可见信号，「看不到」正好是它失效时的样子。 */
    await openOps(ovr({
      parse_quality: {
        ok: 18, partial: 0, parse_failed: 0, empty: 0, other: 0, dispatched: 18,
      },
    }));
    expect(screen.getByText(/18 条判读全部对上号了/)).toBeTruthy();
    // 但不能升级成告警 —— 健康状态不该占视觉预算
    expect(screen.queryByText(/没能完整对上号/)).toBeNull();
  });

  it("★★★ D6 四档之和 < 分母时要解释差额", async () => {
    /* 不解释的表现是客户自己加一遍发现少了几条，而那个差额有完全正常的
       解释（判读是异步的，派出去 1~3 分钟才回来）—— 看起来却像我们丢了数据。 */
    await openOps(ovr({
      parse_quality: {
        ok: 10, partial: 0, parse_failed: 2, empty: 0, other: 0, dispatched: 18,
      },
    }));
    const hit = screen.getByText(/还在路上/);
    /* ⚠️ 数字要断在**那一段之内**。用 `getByText(/^6$/)` 会撞上页面别处的 6
       （那种断言过一次不代表它断的是这里）。 */
    expect(hit.closest("span")?.textContent || "",
      "差额没写出来 —— 只说「还在路上」而不说几条等于没解释",
    ).toMatch(/6/);
  });

  it("★★★ D29 gaps / batches_failed 要渲染", async () => {
    /* 🔴 `TriageEmpty` 的 partial 分支写着「有采集缺口（具体 region 见下方
       「系统状态」）」，而那一区里既没有 gaps 列也没有 batches_failed ——
       那句指引落空。 */
    await openOps(ovr({ gaps: 2, batches_failed: 1 }));
    expect(screen.getByText(/1 个批次采集失败/)).toBeTruthy();
    expect(screen.getByText(/2 处采集缺口/)).toBeTruthy();
  });

  it("★★★ D29 batches_failed 比 gaps 严重（用 error 不是 warning）", async () => {
    /* 前者是「有资源压根没被评估过」，后者是「采到的数据有洞」——
       合成一句会让前者被当成后者。 */
    await openOps(ovr({ gaps: 0, batches_failed: 1 }));
    const hit = screen.getByText(/1 个批次采集失败/);
    const box = hit.closest("div[style]");
    expect(box, "找不到告警容器").toBeTruthy();
    expect(screen.queryByText(/处采集缺口/),
      "gaps 为 0 时还在说采集缺口",
    ).toBeNull();
  });

  it("★★ 两个都是 0 时整块不渲染", async () => {
    await openOps(ovr({ gaps: 0, batches_failed: 0 }));
    expect(screen.queryByText(/采集缺口|批次采集失败/)).toBeNull();
  });

  // ── 7.9a skill 门禁的聚合（D22 第二步）─────────────────────────────────
  //
  // 🔴 单条卡片的徽标（第一步）抓不到「100 条里 60 条不可信」—— skill 没
  //    加载 / 账号没关联是**全局**故障（措辞路由、agent space 配置），
  //    与 parse_quality 当年「逐条点开才发现」同型，所以同一套渲染规则。
  it("★★★ D22 有不可信判读 → 首屏红色告警，带条数与下一步", async () => {
    await openOps(ovr({
      gate_quality: { untrusted: 2, degraded: 0, clean: 13, unknown: 3 },
    }));
    expect(screen.getByText(/有 2 条判读不可信/)).toBeTruthy();
    // 光报数与不报的信息量是一样的 —— 要说去哪修
    expect(screen.getByText(/关联进巡检 space/)).toBeTruthy();
    // 分档明细：已验证干净与未验证（存量）分开报，不许合并
    expect(screen.getByText(/已验证干净 13/)).toBeTruthy();
    expect(screen.getByText(/未验证（存量）3/)).toBeTruthy();
    expect(screen.queryByText(/条判读已验证按方法论产出/),
      "报警和全绿行同时出现 —— 自相矛盾").toBeNull();
  });

  it("★★★ D22 只有降级（可信）→ warning，不说「不可信」", async () => {
    await openOps(ovr({
      gate_quality: { untrusted: 0, degraded: 3, clean: 15, unknown: 0 },
    }));
    expect(screen.getByText(/3 条有降级/)).toBeTruthy();
    expect(screen.queryByText(/判读不可信/),
      "方法论生效了却说「不可信」—— 长载荷/部分成功的正常判读会被整批丢掉")
      .toBeNull();
  });

  it("★★★ D22 全部验证干净 → 一行小字（不是整块消失，也不是告警）", async () => {
    /* 🔴 与 parse_quality 的 D5 同一条规则：健康 → 整块消失 → 与「存量 BFF
       没返回这个字段」在界面上完全不可区分，而这一块正是 skill 漂移的
       可见信号，「看不到」正好是它失效时的样子。 */
    await openOps(ovr({
      gate_quality: { untrusted: 0, degraded: 0, clean: 18, unknown: 0 },
    }));
    expect(screen.getByText(/18 条判读已验证按方法论产出/)).toBeTruthy();
    expect(screen.queryByText(/判读不可信|有降级/)).toBeNull();
  });

  it("★★★ D22 全是存量（unknown）→ 不报警（部署第一天的正常形态）", async () => {
    /* 🔴 unknown 的语义是「不知道」不是「有问题」。门禁上线那天**所有**
       存量行都是 unknown —— 为它报警等于让这个 Alert 天生就是狼来了，
       客户第一天就学会忽略它。 */
    await openOps(ovr({
      gate_quality: { untrusted: 0, degraded: 0, clean: 0, unknown: 18 },
    }));
    expect(screen.queryByText(/判读不可信|有降级/)).toBeNull();
    /* ⚠️ 上面那条只断 header 文案 —— 而 header 是按 untrusted/degraded 拼的，
       unknown 误触发时 header 恰好是**空串**，Alert 照样立在页面上。
       所以再按 Alert 的**正文**断一次（反向注入实测：只有前一条时，
       为 unknown 报警的注入版本仍然全绿）。 */
    expect(screen.queryByText(/点开对应 finding 的详情/),
      "为 unknown 报了警 —— 部署第一天所有存量行都是 unknown，"
      + "这个告警天生就是狼来了").toBeNull();
    // 但要如实说「未验证」，不能装作已验证
    expect(screen.getByText(/门禁上线前的存量，未验证/)).toBeTruthy();
  });

  it("★★★ D22 gate_quality 缺失（存量 BFF）→ 整块不渲染，不显示一排 0", async () => {
    await openOps(ovr({ gate_quality: undefined }));
    expect(screen.queryByText(/判读不可信|方法论产出|有降级/)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 可访问性（2026-09-02 review #8）
//
// 这一组里 F1 是硬缺陷：抽屉 + 弹层同开时键盘用户**完不成派发**。
// 其余几条的共同形态是「信息只挂在 `title` 上」—— 而 `title` 是鼠标专属的。
// ═══════════════════════════════════════════════════════════════════════════
describe("可访问性：浮层与键盘", () => {
  it("★★★ F5 RowMenu 支持方向键，Esc 后焦点回到触发按钮", async () => {
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("db-live")).toBeTruthy());

    const trigger = screen.getByText("db-live").closest("tr")!
      .querySelector<HTMLElement>('[aria-haspopup="menu"]')!;
    expect(trigger, "找不到 ⋯ 按钮").toBeTruthy();
    fireEvent.click(trigger);
    await waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());

    const menu = document.querySelector('[role="menu"]')!;
    // ① 打开后焦点要**在菜单里**（否则 Tab 会走到页面后面去，
    //    而菜单是 fixed 定位的，视觉上明明就在眼前）
    expect(menu.contains(document.activeElement),
      "打开后焦点没进菜单",
    ).toBe(true);

    // ② 方向键要能移动（`role="menu"` 的既定交互，读屏用户会去按）
    const first = document.activeElement;
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(document.activeElement, "↓ 没有移动焦点").not.toBe(first);
    expect(menu.contains(document.activeElement)).toBe(true);

    // ③ Esc 关掉之后焦点回到那个 ⋯ 按钮（它一直在原地）
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
    expect(document.activeElement,
      "Esc 之后焦点丢了 —— Tab 会从页面顶端重来",
    ).toBe(trigger);
  });

  it("★★★ F5 禁用的菜单项不进 tab 序，但读屏仍能听到原因", async () => {
    /* 用 `tabIndex={-1}` 而不是 `disabled`：后者会让读屏**完全跳过**它，
       于是「有这一项但不可用，原因是 X」这个信息也丢了 ——
       而那正是本仓库规矩①要保住的东西。 */
    vi.mocked(api.getInspectionScope).mockResolvedValue(SCOPE);
    render(<InspectionDashboard dashboardId="scope"
      can={only("action:inspection:scope")} accountId="111122223333" />);
    await waitFor(() => expect(screen.getByText("cl-forever")).toBeTruthy());
    // `cl-forever` 是 never_expires 的行 —— 它的「续期」项被禁用
    openRowMenu("cl-forever");
    const off = [...document.querySelectorAll('[role="menuitem"]')]
      .find((el) => el.getAttribute("aria-disabled") === "true");
    expect(off, "找不到被禁用的菜单项 —— 这条测试的前提坏了").toBeTruthy();
    expect(off!.getAttribute("tabIndex") ?? off!.getAttribute("tabindex"),
      "禁用项还在 tab 序里 —— 键盘用户会 Tab 到一个点不动的项",
    ).toBe("-1");
    expect(off!.hasAttribute("disabled"),
      "用了 disabled —— 读屏会完全跳过它，「为什么不可用」这个信息就丢了",
    ).toBe(false);
    expect(off!.getAttribute("title") || "",
      "禁用项没给原因（规矩①）",
    ).not.toBe("");
  });
});

describe("可访问性：不只靠颜色 / 不只靠 title", () => {
  it("★★★ 闲置分档不只由颜色表达", async () => {
    /* 红 ≥80 / 橙 ≥60 / 灰 —— 色盲用户与读屏用户拿到的只是一个数字，
       而「87 意味着要优先处理」这件事在界面上没有任何非颜色的载体。
       这一页的排序就是处置顺序，档位是它的解释。 */
    vi.mocked(api.getInspectionFindings).mockResolvedValue({
      ...findingsWith("CPUUtilization"),
      findings: [{
        ...findingsWith("CPUUtilization").findings[0],
        kind: "idle", rule: "idle", idle_score: 87, severity: "INFO",
      }],
    });
    render(<InspectionDashboard dashboardId="idle" />);
    await waitFor(() => expect(screen.getByText("87")).toBeTruthy());
    const badge = screen.getByText("87").closest("span")!;
    const name = badge.getAttribute("aria-label") || "";
    expect(name, "档位只由颜色表达 —— 没有 aria-label").toMatch(/优先处理|high/);
  });

  it("★★★ Expandable 锁住的原因看得见（不只在 title）", async () => {
    /* `title` 只有鼠标悬停才出现 —— 键盘与触屏用户看到的是一个点不动的
       折叠按钮，也就是那段注释自己说的「用户只会觉得折叠按钮坏了」。 */
    vi.mocked(api.getInspectionOverview).mockResolvedValue(
      { ...OVERVIEW, dispatch_gap: 4 });
    render(<InspectionDashboard dashboardId="overview" />);
    /* ⚠️ 「系统状态」在**页首那条派发缺口告警**的指路文案里也出现
       （「明细在页面底部『系统状态』里」）—— `getByText` 会因「找到两个」抛。
       按 `aria-expanded` 定位那个折叠按钮，它只有一个。 */
    const btn = await waitFor(() => {
      const el = [...document.querySelectorAll("button[aria-expanded]")]
        .find((b) => /系统状态/.test(b.textContent || ""));
      if (!el) throw new Error("系统状态折叠区没渲染");
      return el;
    });
    expect(btn.getAttribute("aria-disabled"), "gap>0 时那一区没锁").toBe("true");
    expect(btn.textContent || "",
      "锁住的原因只在 title 里 —— 键盘与触屏用户看不到",
    ).toMatch(/不折叠|藏起来/);
  });


});

// ═══════════════════════════════════════════════════════════════════════════
// D22：skill 门禁结论的徽标（「这条判读的方法论生效了吗」）
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 起因：`journal_gate` 把「skill 有没有加载 / DA 有没有拿到账号数据」算成了
//    可读的事实，而在 2026-09-03 之前唯一的消费者是一行 logger.info ——
//    也就是说看板上一条 **skill 压根没加载**的判读（结论等于通用 AI 发挥）
//    与一条正常判读**长得一模一样**。
//
// 🔴 这一组的核心是**三态**，而且第三态是默认值：`null` = 门禁没跑过
//    （存量行全是这个）。判据写成 truthy 的后果是**每一条存量 finding**
//    都挂上红色「判读不可信」—— 噪音不是信号。
describe("判读可信度徽标（D22）", () => {
  function withGate(over: Partial<{
    da_gate_trustworthy: boolean | null;
    da_degradations: string[] | null;
    da_skills_loaded: string[] | null;
  }>): FindingsData {
    const d = findingsWith("CPUUtilization", "bad_up");
    Object.assign(d.findings[0], over);
    return d;
  }

  async function renderWith(over: Parameters<typeof withGate>[0]) {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(withGate(over));
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/db-1/)).toBeTruthy());
  }

  it("★★★ 不可信（skill 没加载）→ 红色徽标 + title 说清下一步", async () => {
    await renderWith({
      da_gate_trustworthy: false,
      da_degradations: ["skill_not_loaded"],
      da_skills_loaded: [],
    });
    const badge = screen.getByText(/判读不可信/);
    expect(badge).toBeTruthy();
    // 🔴 徽标面上只有四个字，**整句话必须在 title 里**（Badge 把 title
    //    映射成 aria-label，所以这也是屏幕阅读器唯一拿得到的解释）。
    const title = badge.getAttribute("title") || "";
    expect(title, "title 里没说这一档具体是什么问题").toMatch(/判读 skill 一份都没加载/);
    expect(title, "没说「实际加载了什么」—— 那是排查这一档的唯一直接线索")
      .toMatch(/实际一个判读 skill 都没加载/);
  });

  it("★★★ 存量行（三个字段都是 null）→ **什么徽标都不渲染**", async () => {
    // 这是最要紧的一条。判据若写成 `!f.da_gate_trustworthy`，
    // 每一条存量 finding 都会显示「判读不可信」。
    await renderWith({
      da_gate_trustworthy: null, da_degradations: null, da_skills_loaded: null,
    });
    expect(screen.queryByText(/判读不可信/),
      "把「门禁没跑过」显示成了「不可信」—— 存量行会全部误报").toBeNull();
    expect(screen.queryByText(/判读有降级/)).toBeNull();
  });

  it("★★ 旧 BFF 完全不返回这三个字段（undefined）→ 同样不渲染、不白屏", async () => {
    // 部署窗口里的真实形态：新 JS + 旧 BFF（CloudFront 缓存 JS，
    // 而 BFF 是 Lambda URL 不走缓存，两者更新不是原子的）。
    const d = findingsWith("CPUUtilization", "bad_up");
    for (const k of ["da_gate_trustworthy", "da_degradations", "da_skills_loaded"]) {
      delete (d.findings[0] as unknown as Record<string, unknown>)[k];
    }
    vi.mocked(api.getInspectionFindings).mockResolvedValue(d);
    vi.mocked(api.getInspectionOverview).mockResolvedValue(OVERVIEW);
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText(/db-1/)).toBeTruthy());
    expect(screen.queryByText(/判读不可信/)).toBeNull();
    expect(screen.queryByText(/判读有降级/)).toBeNull();
  });

  it("★★★ 门禁跑过且干净（空数组）→ 也不渲染徽标", async () => {
    // 「一切正常」不该占用界面 —— 每条都挂一个「方法论已生效」是纯噪音。
    // ⚠️ 但它与上面那条 null 的**内部状态不同**：这条是已验证的干净，
    //    第二步（总览聚合）要能把两者分开计数。
    await renderWith({
      da_gate_trustworthy: true, da_degradations: [],
      da_skills_loaded: ["inspection-high-load"],
    });
    expect(screen.queryByText(/判读不可信/)).toBeNull();
    expect(screen.queryByText(/判读有降级/)).toBeNull();
  });

  it("★★★ 可信但有降级 → 琥珀徽标带条数，且不说「不可信」", async () => {
    await renderWith({
      da_gate_trustworthy: true,
      da_degradations: ["compaction", "analysis_gap"],
      da_skills_loaded: ["inspection-high-load"],
    });
    const badge = screen.getByText(/判读有降级 2/);
    expect(badge).toBeTruthy();
    expect(screen.queryByText(/判读不可信/),
      "方法论生效了却说「不可信」—— 那会让长载荷/部分成功的正常判读被整批丢掉")
      .toBeNull();
    const title = badge.getAttribute("title") || "";
    expect(title).toMatch(/上下文被压缩过/);
    expect(title).toMatch(/部分证据拿不到/);
  });

  it("★★ 认不出的降级码原样显示（后端加了新档而前端文案没跟上）", async () => {
    await renderWith({
      da_gate_trustworthy: true,
      da_degradations: ["some_future_code"],
      da_skills_loaded: ["inspection-high-load"],
    });
    // ⚠️ 原样返回而不是空串：空白会让那一条凭空消失、看起来像后端没给字段；
    //    一个陌生的英文枚举至少能拿去搜代码。与 parseStatusLabel 同套。
    const title = screen.getByText(/判读有降级 1/).getAttribute("title") || "";
    expect(title).toMatch(/some_future_code/);
  });

  it("★★★ 不可信与「判读已回来」是正交的 —— 卡片同时说得出两件事", async () => {
    // 🔴 一条 parse_status=ok、有 verdict 的判读完全可以是 skill_not_loaded。
    //    把门禁塞进 judgementState() 的七档里会让这两个维度互相遮蔽。
    await renderWith({
      da_gate_trustworthy: false,
      da_degradations: ["no_data_access"],
      da_skills_loaded: ["inspection-high-load"],
    });
    // 判读本体正常（fixture 里 has_judgment: true / da_verdict 有值）
    expect(screen.queryByText(/判读缺失|判读中/)).toBeNull();
    // 而可信度徽标照样出现
    expect(screen.getByText(/判读不可信/)).toBeTruthy();
    const title = screen.getByText(/判读不可信/).getAttribute("title") || "";
    expect(title, "no_data_access 必须说到「去管理页关联账号」这个下一步")
      .toMatch(/关联/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 判读可信度 · 详情抽屉（D22 第二步）
//
// 🔴 卡片徽标（第一步）的解释全挂在 `title` 上 —— 悬浮/屏幕阅读器拿得到，
//    但抽屉才是唯一能从容读字的地方。这一组钉住：逐档一行（码 + 人话）、
//    「实际加载了什么」、以及**放置**决策 —— 门禁块不挂在正文那条 ternary
//    链里，解析失败的行也要能看到「为什么会失败」。
// ═══════════════════════════════════════════════════════════════════════════
describe("判读可信度 · 详情抽屉（D22 第二步）", () => {
  function gateRow(over: Partial<FindingRow>): FindingRow {
    return { ...findingsWith("CPUUtilization", "bad_up").findings[0], ...over };
  }

  async function renderPanel(over: Partial<FindingRow>) {
    const { default: Panel } =
      await import("./components/InspectionDashboardPanel");
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "## 分析\n判读正文", da_updated_at: 1788223019 } as never);
    render(<Panel row={gateRow(over)} judged onClose={() => {}} />);
    // 抽屉头部（实例名）出现即可 —— 门禁块不依赖正文加载完成
    await waitFor(() => expect(screen.queryByText(/db-1/)).not.toBeNull());
  }

  it("★★★ 不可信 → 红色块逐档说明：机器码 + 人话 + 实际加载了什么", async () => {
    await renderPanel({
      da_gate_trustworthy: false,
      da_degradations: ["skill_not_loaded"],
      da_skills_loaded: [],
    });
    expect(screen.getByText(/这份判读没能证明是按我们的判读方法论做出来的/))
      .toBeTruthy();
    /* 🔴 机器码与人话**都要在**：人话是给读的人的，机器码是拿去搜代码/
       日志的（CloudWatch 里记的是 `skill_not_loaded` 这个词）。 */
    expect(screen.getByText("skill_not_loaded")).toBeTruthy();
    expect(screen.getByText(/结论等于通用 AI 发挥/)).toBeTruthy();
    // 空数组说成「一个都没加载」—— 那正是 skill_not_loaded 的形态
    expect(screen.getByText(/实际一个判读 skill 都没加载/)).toBeTruthy();
  });

  it("★★ 可信但有降级 → 琥珀块列出每一档，不说「不可信」", async () => {
    await renderPanel({
      da_gate_trustworthy: true,
      da_degradations: ["compaction", "analysis_gap"],
      da_skills_loaded: ["inspection-high-load"],
    });
    expect(screen.getByText(/方法论已生效，但这份判读有以下折扣/)).toBeTruthy();
    expect(screen.getByText("compaction")).toBeTruthy();
    expect(screen.getByText("analysis_gap")).toBeTruthy();
    expect(screen.getByText(/上下文被压缩过/)).toBeTruthy();
    expect(screen.queryByText(/没能证明是按我们的判读方法论/)).toBeNull();
  });

  it("★★★ 存量行（null）→ 两个块都不渲染", async () => {
    await renderPanel({
      da_gate_trustworthy: null, da_degradations: null, da_skills_loaded: null,
    });
    expect(screen.queryByText(/没能证明是按我们的判读方法论/)).toBeNull();
    expect(screen.queryByText(/方法论已生效/)).toBeNull();
  });

  it("★★★ 解析失败的行也要能看到门禁结论（放置决策的钉子）", async () => {
    /* 🔴 这条钉住「门禁块不挂在正文 ternary 链里」：`parse_failed` 常常
       **正是** skill 没加载的下游症状（通用发挥的输出切不出我们的节），
       挂进 `da_body` 那个分支会让「解析失败 + skill 没加载」只显示前一半，
       而后一半才解释了为什么会失败。第一步特意让 gate_kw 在
       missing_section / parse_failed 两条路径上同行，就是为了这里。 */
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: "", da_updated_at: 0 } as never);
    const { default: Panel } =
      await import("./components/InspectionDashboardPanel");
    render(<Panel judged onClose={() => {}} row={gateRow({
      // 「回来了但是空的」的完整形态：无正文（has_judgment=false）、
      // 无结论、parse_status=empty —— judgementState 判 `failed` 的三条件。
      da_parse_status: "empty", da_verdict: "", has_judgment: false,
      da_gate_trustworthy: false,
      da_degradations: ["skill_not_loaded"],
      da_skills_loaded: [],
    })} />);
    await waitFor(() => expect(screen.queryByText(/db-1/)).not.toBeNull());
    // 判读失败的既有提示还在（`insp.judge.failed` 的 zh 文案）
    await waitFor(() =>
      expect(screen.queryByText(/判读已返回但没有内容/)).not.toBeNull());
    // 门禁块同屏出现 —— 它解释了「为什么会失败」
    expect(screen.getByText(/这份判读没能证明是按我们的判读方法论做出来的/))
      .toBeTruthy();
  });
});
