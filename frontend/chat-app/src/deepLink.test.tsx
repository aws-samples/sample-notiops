/**
 * 推送深链落地（R11b.7 / R11b.9）。
 *
 * IM 推送里每条 finding 后面挂
 * `?account=<acct>&finding=<finding_id>&tab=<子页>`。这一套守三件事：
 *
 * ```
 * 🔴 读一次就把参数摘掉    不摘 → 客户手动切账号后自己跳回去，看起来像选择器坏了
 * 🔴 高亮而不是筛选        筛掉其余 → 客户以为「今天只有这一条」
 * 🔴 tab 认不出要静默兜底  抛异常 → 一个手改的链接把整个看板打白
 * ```
 *
 * ⚠️ `deepLink` 是**模块级读一次**的常量，所以每个用例都要先改 URL 再
 * `_rereadForTests()`。做成 hook 会让「谁先渲染谁生效」——那种顺序依赖
 * 在测试里表现正常、在生产里随机失效。
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FindingRow, FindingsData } from "./api/inspection";

vi.mock("./api/inspection", async (orig) => {
  const real = await orig<typeof import("./api/inspection")>();
  return {
    ...real,
    getInspectionOverview: vi.fn(),
    getInspectionFindings: vi.fn(),
    // ⚠️ 抽屉会调它。深链现在**自动打开详情**（R11b.7「一跳到具体
    //    finding，不是跳列表页让客户自己翻」），不 mock 的话它会走真的
    //    `signedClient()` → jsdom 里 `getConfig()` 抛「Config not loaded」。
    getInspectionFinding: vi.fn(),
    getInspectionScope: vi.fn(),
    getInspectionConfig: vi.fn(),
  };
});

const api = await import("./api/inspection");
const dl = await import("./deepLink");
const InspectionDashboard = (await import("./components/InspectionDashboard")).default;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
  dl._rereadForTests();
});

const FID_A = "111122223333#us-east-1#rds#db-1#threshold_high#CPUUtilization";
const FID_B = "111122223333#us-east-1#rds#db-2#threshold_high#CPUUtilization";

function twoFindings(): FindingsData {
  const base: Omit<FindingRow, "finding_id" | "instance"> = {
    account_id: "111122223333", region: "us-east-1", service: "rds",
    instance_class: "db.t4g.micro",
    metric: "CPUUtilization",
      // ── 判定证据（这一版新增：此前这些数字压根没落库）──
      rule: "threshold_high", kind: "high_load",
      observed_value: 85.3, threshold_value: 70, headroom: -0.19,
      unit: "%", direction: "bad_up", raw_value: null, denominator: null,
      savings_usd: null, savings_precision: "",
      // 闲置评分因子。高负载条目上恒空 —— 它没有加权评分这个概念。
      // 证据就是本轮的（= last_run_date）→ UI 不该标注「数据截至…」。
      // 陈旧标注那条测试单独造 evidence_as_of < last_run_date 的行。
      evidence_as_of: "2026-08-19",
      idle_score: null, idle_weight_avail: null,
      idle_degraded: [], idle_factors: [],
    state: "active" as const, severity: "CRITICAL" as const,
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
  };
  return {
    ok: true, account_id: "111122223333", kind: "high_load", total: 2,
    by_severity: { CRITICAL: 2, HIGH: 0, MEDIUM: 0, INFO: 0 },
    without_judgment: 0, unclassified: 0,
    last_run: {
      run_date: "2026-08-19", status: "success",
      completeness: 1, mode: "official",
    },
    findings: [
      { ...base, finding_id: FID_A, instance: "db-1" },
      { ...base, finding_id: FID_B, instance: "db-2" },
    ],
  };
}

function go(search: string) {
  window.history.replaceState({}, "", search);
  return dl._rereadForTests();
}

describe("deepLink parsing", () => {
  it("reads account / finding / tab", () => {
    const link = go(`/?account=111122223333&finding=${encodeURIComponent(FID_A)}&tab=idle`);
    expect(link.account).toBe("111122223333");
    expect(link.finding).toBe(FID_A);
    expect(link.tab).toBe("idle");
  });

  it("🔴 strips the params from the URL after reading them", () => {
    // 不摘的表现：客户点开深链落在账号 A，手动切到 B，任何一次重渲染都会把
    // account=A 再读一遍 —— 账号自己跳回去，看起来像选择器坏了。
    go("/?account=111122223333&finding=x&tab=idle");
    expect(window.location.search).toBe("");
  });

  it("keeps other query params that are not ours", () => {
    go("/?foo=bar&account=1&baz=2");
    const rest = new URLSearchParams(window.location.search);
    expect(rest.get("foo")).toBe("bar");
    expect(rest.get("baz")).toBe("2");
    expect(rest.has("account")).toBe(false);
  });

  it("a bare URL yields empty strings, not undefined", () => {
    const link = go("/");
    expect(link).toEqual({ account: "", finding: "", tab: "" });
  });

  it("🔴 an empty read does not leak the previous values", () => {
    // 第一版把「空」做成一个共享常量并 `return EMPTY`，于是模块加载时
    // （正常访问，URL 上没有参数）`deepLink` 与 EMPTY 变成同一个对象，
    // 之后任何一次写入都污染那个常量 —— 后续的空返回带着别人的值。
    go("/?account=999999999999&tab=idle");
    const after = go("/");
    expect(after.account).toBe("");
    expect(after.tab).toBe("");
  });

  it("percent-encoded finding ids round-trip", () => {
    // finding_id 有六段 `#`。裸着放进 query 会被当成 fragment 分隔符，
    // `?finding=` 后面整段丢失 —— 而链接看起来是好的。
    const link = go(`/?finding=${encodeURIComponent(FID_A)}`);
    expect(link.finding).toBe(FID_A);
    expect(link.finding.split("#")).toHaveLength(6);
  });
});

describe("highlighting the linked finding", () => {
  it("★ marks the linked card and leaves the others alone", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(twoFindings());
    render(<InspectionDashboard dashboardId="high-load" highlight={FID_A} />);
    // ⚠️ 用 `data-finding-id` 定位而不是文本 —— 深链会自动打开详情抽屉，
    //    而抽屉标题里也有实例名，按文本查会撞上「找到多个」。
    await waitFor(() =>
      expect(document.querySelectorAll("[data-finding-id]").length).toBe(2));

    const marked = document.querySelectorAll('[data-highlighted="1"]');
    expect(marked).toHaveLength(1);
    expect(marked[0].getAttribute("data-finding-id")).toBe(FID_A);
  });

  it("🔴 highlights but does NOT filter out the others", async () => {
    // 筛掉其余条目会让客户以为「今天只有这一条」，而深链的语义是
    // 「先看这条」而不是「只有这条」。
    vi.mocked(api.getInspectionFindings).mockResolvedValue(twoFindings());
    render(<InspectionDashboard dashboardId="high-load" highlight={FID_A} />);
    await waitFor(() =>
      expect(document.querySelectorAll("[data-finding-id]").length).toBe(2));
    // 两张卡都在 —— 深链是「先看这条」而不是「只有这条」
    expect(document.querySelector(`[data-finding-id="${FID_B}"]`)).toBeTruthy();

    // ⚠️ 并且详情抽屉自动打开了那一条（R11b.7 要求一跳到具体 finding）。
    //    只高亮不打开的表现是客户点开推送里的「详情」，看到的是一个列表，
    //    还得自己在里面找那条 —— 而深链的整个意义就是省掉这一步。
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("an unknown finding id highlights nothing and does not crash", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(twoFindings());
    render(<InspectionDashboard dashboardId="high-load"
      highlight="does#not#exist#at#all#here" />);
    await waitFor(() =>
      expect(document.querySelectorAll("[data-finding-id]").length).toBe(2));
    expect(document.querySelectorAll('[data-highlighted="1"]')).toHaveLength(0);
    // 认不出的 id **不该**弹一个空抽屉 —— 那会让人以为「这条被删了」
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("no highlight prop → nothing marked", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(twoFindings());
    render(<InspectionDashboard dashboardId="high-load" />);
    await waitFor(() => expect(screen.getByText("db-1")).toBeTruthy());
    expect(document.querySelectorAll('[data-highlighted="1"]')).toHaveLength(0);
  });

  it("scrolls the linked card into view when the browser supports it", async () => {
    // ⚠️ jsdom 没有 scrollIntoView。代码里必须判在不在（`?.`），
    //    不判会让所有渲染这张卡的测试整片红，而失败原因与被测行为无关。
    const spy = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown })
      .scrollIntoView = spy;
    try {
      vi.mocked(api.getInspectionFindings).mockResolvedValue(twoFindings());
      render(<InspectionDashboard dashboardId="high-load" highlight={FID_A} />);
      await waitFor(() => expect(spy).toHaveBeenCalled());
      expect(spy.mock.calls[0][0]).toMatchObject({ block: "center" });
    } finally {
      delete (Element.prototype as unknown as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
  });
});
