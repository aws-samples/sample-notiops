/**
 * 2026-10-10 交叉 review（r5 / r6）在前端的那几处修复。
 *
 * ```
 * B2   回来了但没内容 → 「重新分析」              （judge_retryable）
 * B5   kill switch 关着 → 不给「跑一轮」/「深入分析」，页头一句「已暂停」
 * B6   账号接入不全 → 不给按钮，改成一行原因      （judge_ready）
 * B7   已移出巡检范围 → 标签 + 不计入 + 不给按钮  （excluded_by）
 * B8   pending 超过 30 分钟 → 不再说「1~3 分钟」
 * B15  5xx → 结果未知，刷新确认，不说「失败」
 * B21  英文界面不显示后端中文
 * F-10 停更按 BFF 的 stale 判
 * F-12 已不存在 / 移出范围的不进计数、沉底
 * ```
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FindingRow, FindingsData, OverviewData } from "./api/inspection";
import { isStale, judgementState, judgeSlowMinutes } from "./components/inspection/format";

vi.mock("./api/inspection", async (orig) => {
  const real = await orig<typeof import("./api/inspection")>();
  return {
    ...real,
    getInspectionOverview: vi.fn(),
    getInspectionFindings: vi.fn(),
    getInspectionFinding: vi.fn(),
    getInspectionScope: vi.fn(),
    getInspectionConfig: vi.fn(),
    triggerInspectionRun: vi.fn(),
    judgeInspectionFinding: vi.fn(),
    putInspectionExclusion: vi.fn(),
  };
});

const api = await import("./api/inspection");
const { default: InspectionDashboard } = await import("./components/InspectionDashboard");
const { default: InspectionDashboardPanel } = await import("./components/InspectionDashboardPanel");

const TODAY = new Date().toISOString().slice(0, 10);

const HIGH = (over: Record<string, unknown> = {}): FindingRow => ({
  finding_id: "444455556666#ap-northeast-1#rds#db-a#threshold_high#CPUUtilization",
  account_id: "444455556666", region: "ap-northeast-1", service: "rds",
  instance_class: "db.t4g.micro", instance: "db-a", metric: "CPUUtilization",
  rule: "threshold_high", kind: "high_load",
  observed_value: 85.3, threshold_value: 70, headroom: -0.19, unit: "%",
  direction: "bad_up", raw_value: null, denominator: null,
  savings_usd: null, savings_precision: "", evidence_as_of: TODAY,
  idle_score: null, idle_weight_avail: null, idle_degraded: [], idle_factors: [],
  state: "active", severity: "CRITICAL",
  first_seen_date: TODAY, last_run_date: TODAY, days_active: 1, days_since_eval: 0,
  rule_version: "v", consecutive_hits: 2, consecutive_misses: 0, was_confirmed: true,
  da_verdict: "", da_parse_status: "", da_task_id: "", da_report_md_key: "",
  has_judgment: false, skip_reason: "budget",
  ...over,
} as unknown as FindingRow);

const FINDINGS = (rows: FindingRow[], over: Record<string, unknown> = {}): FindingsData => ({
  ok: true, account_id: "", kind: "high_load", total: rows.length,
  by_severity: { CRITICAL: rows.length, HIGH: 0, MEDIUM: 0, INFO: 0 },
  without_judgment: 0, unclassified: 0,
  last_run: { run_date: TODAY, status: "success", completeness: 1, mode: "official" },
  findings: rows,
  ...over,
} as unknown as FindingsData);

beforeEach(() => {
  vi.mocked(api.getInspectionOverview).mockResolvedValue(
    { ok: true, diff: {}, dispatch_gap: 0, runs: [] } as unknown as OverviewData);
  vi.mocked(api.getInspectionFinding).mockResolvedValue(
    { ok: true, da_body: "", da_updated_at: null } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const judgeBtnText = () => screen.queryByText(/^深入分析$/);

// ── 纯函数 ─────────────────────────────────────────────────────────────────

describe("format 里的新判据", () => {
  it("isStale：有 BFF 的 stale 就用它，没有回退到 ≥ 2 天", () => {
    expect(isStale({ stale: false, days_since_eval: 6 })).toBe(false);
    expect(isStale({ stale: true, days_since_eval: 1 })).toBe(true);
    expect(isStale({ days_since_eval: 2 })).toBe(true);
    expect(isStale({ days_since_eval: 1 })).toBe(false);
  });
  it("judgeSlowMinutes：30 分钟以内不算慢", () => {
    const now = 1_760_000_000_000;
    expect(judgeSlowMinutes({ da_dispatched_at: now / 1000 - 10 * 60 }, now)).toBeNull();
    expect(judgeSlowMinutes({ da_dispatched_at: now / 1000 - 45 * 60 }, now)).toBe(45);
    expect(judgeSlowMinutes({ da_dispatched_at: null }, now)).toBeNull();
  });
  it("新 task 在路上时，行上旧的 parse_status 不算「失败」", () => {
    const row = HIGH({ da_task_id: "t", da_parse_status: "empty", judge_in_flight: true });
    expect(judgementState(row, { dispatched: true })).toBe("pending");
    expect(judgementState({ ...row, judge_in_flight: false }, { dispatched: true }))
      .toBe("failed");
  });
});

// ── 抽屉 ───────────────────────────────────────────────────────────────────

describe("抽屉：重新分析 / 前置不全 / 已移出范围 / 等太久", () => {
  it("★★★ 回来了没内容且可重派 → 「重新分析」（B2）", async () => {
    render(<InspectionDashboardPanel judged retryable onJudge={() => {}} onClose={() => {}}
      row={HIGH({ da_task_id: "t-1", da_parse_status: "empty", judge_retryable: true })} />);
    await waitFor(() => expect(screen.queryByText("重新分析")).not.toBeNull());
    expect(screen.queryByText(/再次计费/)).not.toBeNull();
  });

  it("★★★ 重派用完 → 不给按钮，说清为什么", async () => {
    render(<InspectionDashboardPanel judged onJudge={() => {}} onClose={() => {}}
      row={HIGH({ da_task_id: "t-1", da_parse_status: "empty", judge_retries: 2 })} />);
    await waitFor(() => expect(screen.queryByText(/已经重新分析过 2 次/)).not.toBeNull());
    expect(screen.queryByText("重新分析")).toBeNull();
  });

  it("★★★ 前置不全 → 一行原因，不给「深入分析」（B5 / B6）", async () => {
    render(<InspectionDashboardPanel onJudge={() => {}} onClose={() => {}}
      judgeBlock="这个账号还没有巡检 Agent Space" row={HIGH()} />);
    await waitFor(() => expect(screen.queryByText(/还没有巡检 Agent Space/)).not.toBeNull());
    expect(judgeBtnText()).toBeNull();
  });

  it("★★★ 已移出巡检范围 → 横幅 + 不给两个动作（B7）", async () => {
    render(<InspectionDashboardPanel onJudge={() => {}} onExclude={() => {}} onClose={() => {}}
      row={HIGH({ excluded_by: "instance", excluded_until: "2099-01-01" })} />);
    await waitFor(() => expect(screen.queryByText(/已移出巡检范围（到 2099-01-01）/)).not.toBeNull());
    expect(judgeBtnText()).toBeNull();
    expect(screen.queryByText("移出巡检范围")).toBeNull();
  });

  it("★★ pending 超过 30 分钟 → 不再说「1~3 分钟」（B8）", async () => {
    render(<InspectionDashboardPanel judged onClose={() => {}}
      row={HIGH({ da_task_id: "t-9", da_dispatched_at: Date.now() / 1000 - 3600 })} />);
    await waitFor(() => expect(screen.queryByText(/比预期慢/)).not.toBeNull());
    expect(screen.queryByText(/1~3 分钟/)).toBeNull();
  });

  it("★★ 停更按 BFF 的 stale：周度调度下 6 天前评估过也不提示（F-10）", async () => {
    render(<InspectionDashboardPanel onClose={() => {}}
      row={HIGH({ days_since_eval: 6, stale: false })} />);
    await waitFor(() => expect(screen.queryByText(/db-a/)).not.toBeNull());
    expect(screen.queryByText(/最后一次评估是/)).toBeNull();
  });
});

// ── 页面 ───────────────────────────────────────────────────────────────────

describe("页面：kill switch / 已不存在 / 5xx / 英文", () => {
  it("★★★ kill switch 关着 → 页头「已暂停」，没有「跑高负载」（B5）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(
      FINDINGS([HIGH()], { inspection_enabled: false }));
    render(<InspectionDashboard dashboardId="high_load" can={() => true} />);
    await waitFor(() => expect(screen.queryByText("巡检已被管理员暂停")).not.toBeNull());
    expect(screen.queryByText("跑高负载")).toBeNull();
  });

  it("★★★ 已不存在 / 已移出范围的不进「待处置资源」，沉到表格底部（F-12）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([
      HIGH({ instance: "db-gone", finding_id: "444455556666#ap-northeast-1#rds#db-gone#threshold_high#CPUUtilization",
        resource_missing_on: TODAY }),
      HIGH({ instance: "db-excl", finding_id: "444455556666#ap-northeast-1#rds#db-excl#threshold_high#CPUUtilization",
        excluded_by: "instance" }),
      HIGH({ instance: "db-live", severity: "HIGH",
        finding_id: "444455556666#ap-northeast-1#rds#db-live#threshold_high#CPUUtilization" }),
    ]));
    render(<InspectionDashboard dashboardId="high_load" can={() => true} />);
    await waitFor(() => expect(screen.queryByText("db-live")).not.toBeNull());
    expect(screen.queryByText(/另有 1 台已不存在/)).not.toBeNull();
    expect(screen.queryByText(/1 台已移出巡检范围/)).not.toBeNull();
    const order = [...document.querySelectorAll("[data-finding-id]")]
      .map((e) => e.getAttribute("data-finding-id") || "")
      .map((id) => id.split("#")[3]);
    expect(order.indexOf("db-live")).toBeLessThan(order.indexOf("db-gone"));
    expect(order.indexOf("db-live")).toBeLessThan(order.indexOf("db-excl"));
    expect(screen.queryByText("已移出范围")).not.toBeNull();
  });

  it("★★★ 派发返回 5xx → 琥珀「结果未知」并刷新，不说失败（B15）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([HIGH()]));
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue(
      { ok: false, code: "http_504", message: "请求失败：HTTP 504" } as never);
    render(<InspectionDashboard dashboardId="high_load" can={() => true} />);
    await waitFor(() => expect(screen.queryByText("db-a")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-finding-id]")!);
    await waitFor(() => expect(judgeBtnText()).not.toBeNull());
    const calls = vi.mocked(api.getInspectionFindings).mock.calls.length;
    fireEvent.click(judgeBtnText()!);
    const start = await waitFor(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => /开始分析/.test(x.textContent || ""));
      expect(b).toBeTruthy();
      return b!;
    });
    fireEvent.click(start);
    await waitFor(() => expect(screen.queryByText(/结果未知/)).not.toBeNull());
    expect(screen.queryByText(/HTTP 504/)).toBeNull();
    await waitFor(() => expect(vi.mocked(api.getInspectionFindings).mock.calls.length)
      .toBeGreaterThan(calls));
  });

  it("★★ 试运行的空态不说「本轮未发现风险」（F-02）", async () => {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([], {
      last_run: { run_date: TODAY, status: "success", completeness: 1, mode: "dry_run",
        dry_run_new_hits: 3 },
    }));
    render(<InspectionDashboard dashboardId="high_load" can={() => true} />);
    await waitFor(() => expect(screen.queryByText(/最近一轮是试运行/)).not.toBeNull());
    expect(screen.queryByText(/算出 3 条新发现/)).not.toBeNull();
    expect(screen.queryByText("本轮未发现风险")).toBeNull();
  });
});
