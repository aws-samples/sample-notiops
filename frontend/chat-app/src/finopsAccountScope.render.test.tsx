/**
 * 成本主题的账号口径必须诚实 —— 渲染测试。
 *
 * ## 守的是什么
 *
 * 顶栏有一个账号选择器（`dashAccountId`）。成本看板下面挂着两类东西，它们对
 * 「选了某个成员账号」的反应**本来就不一样**：
 *
 *   ① Cost Explorer 那半边（总览 / 标签浏览器）—— 后端接口接受 `?account=`，
 *      能真的按账号取数。这一半必须**真的把账号传下去**。
 *   ② CUR 行级明细（cur-* 四张表）与成本深挖（Athena 保存查询）—— 数据源本身
 *      是 payer 级的，后端接口**根本没有** account 参数。这一半只能如实说明
 *      「这里不按你选的账号过滤」。
 *
 * 两类混在同一屏、同一个选择器下面，于是有两种不同的谎：
 *
 *   🔴 ①漏传：上半屏是成员账号的成本，标签浏览器却是**部署账号**的成本，
 *      界面上没有一个字提示。客户按着这个数去分摊账单。
 *   🔴 ②默不作声：CUR 那张「Cost - Account」图恰好按账号拆，最容易被读成
 *      「已经按我选的账号过滤过了」。数字是真的，归属是假的 —— 比报错更难发现。
 *   🔴 ②反向撒谎：给它伪造一个 `?account=`，让后端静默忽略。看着"支持了"，
 *      实际什么都没变，而且从此没人再怀疑这个口径。
 *
 * ## 为什么必须是渲染/调用测试
 *
 * 「源码里出现了 accountId」证明不了任何事：prop 声明了但某一处调用漏传（这就是
 * 修复前的真实状态：`getFinopsTagKeys()` 三处裸调用）、或者说明文案写了却挂在
 * 一个永远为假的条件里 —— 子串检查全都照过。这里断的是**实际调用参数**和
 * **实际渲染出的文字**，外加每条正例都配一条反例（不选账号时不许出现那条说明，
 * 否则「无条件挂一句免责声明」也能骗过正例）。
 *
 * ## 附带守的不变量
 *
 * deep-dive 的失败展示只许印我们自己的 reason 码，不许印 `message`
 * （客户端那条是 `String(e)`，带请求 URL）。见 docs/LOGGING_STANDARD.md。
 * 「payer 里还没建这条保存查询」是**配置缺口**，不许印成红色的「查询失败」。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ⚠️ 提升到文件顶部执行，所以工厂里不能引用外部变量。
vi.mock("./api/finops", async (orig) => ({
  ...(await orig<typeof import("./api/finops")>()),
  getFinopsDashboard: vi.fn(),
  getFinopsDeepDive: vi.fn(),
  getFinopsTagKeys: vi.fn(),
  getFinopsTagValues: vi.fn(),
  getFinopsTagCost: vi.fn(),
}));
vi.mock("./api/curdash", async (orig) => ({
  ...(await orig<typeof import("./api/curdash")>()),
  getCube: vi.fn(),
  getCredit: vi.fn(),
  getExtendedSupport: vi.fn(),
  getSavingsPlans: vi.fn(),
}));

const finops = await import("./api/finops");
const curdash = await import("./api/curdash");
const FinopsDashboard = (await import("./components/FinopsDashboard")).default;
const CurDashboard = (await import("./components/CurDashboard")).default;

const REPO = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

// ⚠️ 显式 cleanup —— RTL 自动清理只在 `globals: true` 时注册，本仓库是 false。
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const MEMBER = "111122223333";

/** 只为让 `if (loading)` 过掉，好去看下面的卡。 */
const DASH_EMPTY = {
  budgetAlerts: { available: false, budgets: [] },
  curStatus: { status: "not_configured" as const },
  devOpsAgentCost: { available: false, reason: "cur_not_ready" },
  costExplorer: {
    spendTrend: { available: false }, marketplace: { available: false }, support: { available: false },
    movers: { available: false }, forecast: { available: false }, topServices: { available: false },
    anomalies: { available: false }, coverage: { available: false },
  },
};

beforeEach(() => {
  vi.mocked(finops.getFinopsDashboard).mockResolvedValue(DASH_EMPTY);
  vi.mocked(finops.getFinopsTagKeys).mockResolvedValue({ available: true, tagKeys: ["Team"] });
  vi.mocked(finops.getFinopsTagValues).mockResolvedValue({ available: true, tagKey: "Team", tagValues: ["ads"] });
  vi.mocked(finops.getFinopsTagCost).mockResolvedValue({ available: true, tagKey: "Team", tagValue: null, rows: [], totalUsd: 0 });
  vi.mocked(finops.getFinopsDeepDive).mockResolvedValue({ available: false, reason: "no_named_queries" });
  vi.mocked(curdash.getCube).mockResolvedValue({
    raw: { available: false, reason: "not_configured" } as never, rows: [],
  });
});

describe("Cost Explorer 那半边：账号要真的传下去", () => {
  it("★★★ 兜底取数带上选中账号（原来是裸调用 → 拿的是部署账号的成本）", async () => {
    render(<FinopsDashboard dashboardId="tag-explorer" can={() => true} accountId={MEMBER} />);
    await waitFor(() => expect(finops.getFinopsDashboard).toHaveBeenCalledWith(MEMBER));
  });

  it("★★★ 标签键列表带上选中账号", async () => {
    render(<FinopsDashboard dashboardId="tag-explorer" can={() => true} accountId={MEMBER} />);
    await waitFor(() => expect(finops.getFinopsTagKeys).toHaveBeenCalledWith(MEMBER));
  });

  it("★★★ 选标签键后，值列表与成本查询都带上选中账号", async () => {
    render(<FinopsDashboard dashboardId="tag-explorer" can={() => true} accountId={MEMBER} />);
    // 标签键渲染成可点的元素后再点 —— 组件是异步拉的。
    const key = await screen.findByText("Team");
    fireEvent.click(key);
    await waitFor(() => {
      expect(finops.getFinopsTagValues).toHaveBeenCalledWith("Team", MEMBER);
      expect(finops.getFinopsTagCost).toHaveBeenCalledWith("Team", null, MEMBER);
    });
  });

  it("反例：没选账号时传空串（不是 undefined、也不能捏一个部署账号 id）", async () => {
    render(<FinopsDashboard dashboardId="tag-explorer" can={() => true} />);
    await waitFor(() => expect(finops.getFinopsTagKeys).toHaveBeenCalledWith(""));
    expect(finops.getFinopsDashboard).toHaveBeenCalledWith("");
  });

  it("★★ 切账号 → 标签浏览器重新取（否则屏上留着上一个账号的标签和成本）", async () => {
    const r = render(<FinopsDashboard dashboardId="tag-explorer" can={() => true} accountId={MEMBER} />);
    await waitFor(() => expect(finops.getFinopsTagKeys).toHaveBeenCalledWith(MEMBER));
    r.rerender(<FinopsDashboard dashboardId="tag-explorer" can={() => true} accountId="444455556666" />);
    await waitFor(() => expect(finops.getFinopsTagKeys).toHaveBeenCalledWith("444455556666"));
  });
});

describe("payer 级那半边：不按账号过滤，就得说出来", () => {
  it("★★★ 成本深挖：选了账号 → 明说本节是组织级口径、这个账号不适用", async () => {
    render(<FinopsDashboard dashboardId="deepdive" can={() => true} accountId={MEMBER} />);
    const note = await screen.findByText(new RegExp(`组织级\\(payer\\)口径.*${MEMBER}.*不适用`));
    expect(note).toBeTruthy();
  });

  it("反例：没选账号时不许挂这条说明（无条件免责声明 = 噪音）", async () => {
    render(<FinopsDashboard dashboardId="deepdive" can={() => true} />);
    await screen.findByText(/成本深挖/);
    expect(screen.queryByText(/对它不适用/)).toBeNull();
  });

  it("★★★ CUR 表：选了账号 → 明说是全组织数据", async () => {
    render(<CurDashboard sheet="cur-trend" accountId={MEMBER} />);
    expect(await screen.findByText(new RegExp(`组织级（payer）口径的 CUR.*${MEMBER}`))).toBeTruthy();
  });

  it("反例：没选账号时 CUR 表不挂那条说明", async () => {
    render(<CurDashboard sheet="cur-trend" />);
    await waitFor(() => expect(curdash.getCube).toHaveBeenCalled());
    expect(screen.queryByText(/对它不适用/)).toBeNull();
  });

  it("★★★ 不许给 deep-dive 伪造 account 参数（后端会静默忽略 → 假装支持了）", async () => {
    render(<FinopsDashboard dashboardId="deepdive" can={() => true} accountId={MEMBER} />);
    fireEvent.click(await screen.findByText("CloudWatch 成本明细"));
    await waitFor(() => expect(finops.getFinopsDeepDive).toHaveBeenCalled());
    // 只许一个实参。多传一个"账号"看着像支持了按账号深挖，其实什么都没变。
    expect(vi.mocked(finops.getFinopsDeepDive).mock.calls[0]).toEqual(["cloudwatch"]);
  });
});

describe("deep-dive 的坏路径：未配置 ≠ 查询失败，且不许印 message", () => {
  it("★★★ no_named_queries → 说「尚未配置」，不印红色的「查询失败」", async () => {
    vi.mocked(finops.getFinopsDeepDive).mockResolvedValue({ available: false, reason: "no_named_queries" });
    render(<FinopsDashboard dashboardId="deepdive" can={() => true} />);
    fireEvent.click(await screen.findByText("EC2 计算成本明细"));
    expect(await screen.findByText(/本场景尚未配置/)).toBeTruthy();
    // 🔴 印成"查询失败"的后果：客户以为是自己环境/权限坏了，去翻 Athena 日志。
    expect(screen.queryByText(/查询失败/)).toBeNull();
  });

  it("反例：真的查询失败仍要报错（不能一律说成「尚未配置」）", async () => {
    const leak = "TypeError: fetch failed https://example.execute-api.us-east-1.amazonaws.com/prod/finops/deep-dive";
    vi.mocked(finops.getFinopsDeepDive).mockResolvedValue({ available: false, reason: "http_500", message: leak });
    render(<FinopsDashboard dashboardId="deepdive" can={() => true} />);
    fireEvent.click(await screen.findByText("S3 存储成本明细"));
    expect(await screen.findByText(/查询失败/)).toBeTruthy();
    expect(screen.queryByText(/本场景尚未配置/)).toBeNull();
    // 不变量：印码不印 message。
    expect(document.body.textContent || "").toContain("http_500");
    expect(document.body.textContent || "").not.toContain(leak);
  });
});

describe("接线：账号必须从顶栏一路走到这两个组件", () => {
  /* 这一节只能读源码 —— 整个 ChatApp 渲染要 Amplify 会话 + 十几个接口。
     取「组件标签 → 下一个大写标签」之间的块，避免 indexOf("/>") 截太短
     （剥注释后会命中更早的自闭合标签，加回来的 prop 落在块外，断言照样绿）。 */
  const blockAfter = (src: string, tag: string) => {
    const s = src.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    const i = s.indexOf(tag);
    expect(i, `找不到 ${tag} 的渲染点 —— 这条断言的前提坏了`).toBeGreaterThan(0);
    const rest = s.slice(i + tag.length);
    const next = rest.search(/<[A-Z]/);
    return next > 0 ? rest.slice(0, next) : rest;
  };

  it("★★★ ChatApp 把 dashAccountId 传给 FinopsDashboardBrowser", () => {
    const block = blockAfter(REPO("src/pages/ChatApp.tsx"), "<FinopsDashboardBrowser");
    expect(/accountId=\{dashAccountId\}/.test(block),
      `成本看板没拿到顶栏账号 —— 整条链断在第一节。块内容：${block.slice(0, 300)}`,
    ).toBe(true);
  });

  it("★★★ FinopsDashboardBrowser 同时转给 CurDashboard 和 FinopsDashboard", () => {
    const src = REPO("src/components/FinopsDashboardBrowser.tsx");
    // 两个都要 —— 一个用来真过滤，一个用来挂说明；漏哪个都是一种谎。
    expect(/<CurDashboard[^>]*accountId=\{accountId\}/.test(src),
      "CUR 表没拿到账号 → 选了账号也不会有那条组织级口径说明").toBe(true);
    expect(/<FinopsDashboard[^>]*accountId=\{accountId\}/.test(src),
      "FinopsDashboard 没拿到账号 → 标签浏览器仍查部署账号").toBe(true);
  });
});
