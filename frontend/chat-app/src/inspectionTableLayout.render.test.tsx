/**
 * 巡检看板改版（2026-10）：「闲置与成本」表格 + 高负载卡片去重 —— 行为测试。
 *
 * 客户原话：「每条信息一行一行的文字，不易读，很乱」。截图里的问题：
 *   ① 一句长长的「闲置判定由评分链路确定性完成……」每条一字不差
 *   ② 「已确认」「持续」每条都一样
 *   ③ 钱是第二行的小字，没法一眼比大小
 *   ④ 副标题写「不派 AI 判读」，同一屏又有「判读结论 确有劣化」
 */
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
    triggerInspectionRun: vi.fn(),
    judgeInspectionFinding: vi.fn(),
    putInspectionExclusion: vi.fn(),
  };
});

const api = await import("./api/inspection");
const { default: InspectionDashboard } = await import("./components/InspectionDashboard");

const NOTE = "闲置判定由评分链路确定性完成：按服务的多维加权评分 + 峰值与隐形负载双否决 + 成本核算。各维度得分见本条的评分明细，无需 AI 判读。";

const IDLE = (over: Record<string, unknown> = {}): FindingRow => ({
  finding_id: "123456789012#ap-northeast-1#rds#insp-mysql-m8g#idle#-",
  account_id: "123456789012", region: "ap-northeast-1", service: "rds",
  instance_class: "db.m8g.large", instance: "insp-mysql-m8g", metric: "",
  rule: "idle", kind: "idle",
  observed_value: null, threshold_value: null, headroom: null,
  unit: "", direction: "", raw_value: null, denominator: null,
  savings_usd: 387, savings_precision: "coarse_default",
  evidence_as_of: "2026-10-08", idle_score: 97, idle_weight_avail: 1,
  idle_degraded: [], idle_factors: [
    { name: "cpu", weight: 0.4, normalized: 0.98, points: 39, basis: "cpu_pct", observed: 1.9 },
  ],
  state: "active", severity: "INFO",
  first_seen_date: "2026-09-05", last_run_date: "2026-10-08",
  days_active: 33, rule_version: "v1",
  consecutive_hits: 30, consecutive_misses: 0, was_confirmed: true,
  da_verdict: "", da_parse_status: "", da_task_id: "", da_report_md_key: "",
  has_judgment: false, conclusion: NOTE, skip_reason: "deterministic",
  ...over,
} as unknown as FindingRow);

const MEMCACHED = IDLE({
  finding_id: "123456789012#us-east-1#elasticache#insp-memcached#idle#-",
  region: "us-east-1", service: "elasticache", instance: "insp-memcached",
  instance_class: "cache.m7g.large", savings_usd: 240, idle_score: 99,
  days_active: 32,
});
const REDIS_AI = IDLE({
  finding_id: "123456789012#ap-northeast-1#elasticache#insp-redis-single-001#idle#-",
  service: "elasticache", instance: "insp-redis-single-001",
  instance_class: "cache.m7g.large", savings_usd: 120, idle_score: 100,
  da_task_id: "t-1", da_parse_status: "ok", da_verdict: "real_degradation",
  has_judgment: true, da_gate_trustworthy: true, da_degradations: [],
});

const FINDINGS = (rows: FindingRow[]): FindingsData => ({
  ok: true, run_date: "2026-10-08", run_status: "success", mode: "official",
  total: rows.length, truncated: false,
  by_severity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, INFO: rows.length },
  without_judgment: 0, unclassified: 0,
  last_run: { run_date: "2026-10-08", status: "success", completeness: 1, mode: "official" },
  findings: rows,
} as unknown as FindingsData);

beforeEach(() => {
  vi.mocked(api.getInspectionOverview).mockResolvedValue(
    { ok: true, diff: {}, dispatch_gap: 0, runs: [] } as unknown as OverviewData);
  vi.mocked(api.getInspectionFinding).mockResolvedValue({ ok: false, code: "not_found" } as never);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function renderIdle(rows: FindingRow[]) {
  vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS(rows));
  render(<InspectionDashboard dashboardId="idle" can={() => true} />);
  await waitFor(() => expect(document.querySelectorAll("[data-finding-id]").length)
    .toBe(rows.length));
}

const CAP_NOTE = "结构性规则按资源配置直接判定（describe 结果即可确定），不依赖指标推理，因此无需 AI 判读。";
/** 与 `IDLE()` 同一台资源（insp-mysql-m8g）上的「存储超配」。 */
const STORAGE = IDLE({
  finding_id: "123456789012#ap-northeast-1#rds#insp-mysql-m8g#oversized_storage#-",
  rule: "oversized_storage", idle_score: null, idle_factors: [], savings_usd: null,
  savings_precision: "", conclusion: CAP_NOTE,
});
/** 只有「内存超配」、没有闲置判定的一台。 */
const ONLY_CAP = IDLE({
  finding_id: "123456789012#us-west-2#elasticache#insp-valkey-001#oversized_memory#-",
  region: "us-west-2", service: "elasticache", instance: "insp-valkey-001",
  instance_class: "cache.m7g.large", rule: "oversized_memory", idle_score: null,
  idle_factors: [], savings_usd: null, savings_precision: "", conclusion: CAP_NOTE,
});

/** 每一处出现都是「某个元素自身的文字里含这句」；按最内层计数，父元素不重复算。 */
const countText = (txt: string) => [...document.querySelectorAll("*")].filter((el) =>
  (el.textContent || "").includes(txt)
  && ![...el.children].some((c) => (c.textContent || "").includes(txt))).length;

async function renderIdleRows(rows: FindingRow[], expectRows: number) {
  vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS(rows));
  render(<InspectionDashboard dashboardId="idle" can={() => true} />);
  await waitFor(() => expect(document.querySelectorAll("[data-finding-id]").length)
    .toBe(expectRows));
}

describe("闲置与成本：表格视图（2026-10 第二版：一行一台资源）", () => {
  it("★★★ 规则说明的长句不在列表页出现 —— 行里没有、表格下方也没有", async () => {
    // 客户截图里圈出来的那两段「规则结论：……」（第一版放在表格下方）。
    await renderIdle([IDLE(), MEMCACHED, ONLY_CAP]);
    expect(countText(NOTE)).toBe(0);
    expect(countText(CAP_NOTE)).toBe(0);
    expect(screen.queryByText(/规则结论/)).toBeNull();
  });

  it("★★★ 常态「规则判定」不逐行写（每行都一样 = 零信息量）", async () => {
    await renderIdle([IDLE(), MEMCACHED]);
    expect(screen.queryByText("规则判定")).toBeNull();
    expect(screen.queryByText("rule-based")).toBeNull();
  });

  it("★★★ 行里不放指标实测值（那是「为什么」，在抽屉里）", async () => {
    // IDLE() 的 cpu 实测 1.9 —— 第一版在行里画成「CPU 均值 ▬ 1.9%」两行一格。
    await renderIdle([IDLE()]);
    const row = document.querySelector("[data-finding-id]")!;
    expect(row.textContent || "").not.toMatch(/1\.9%|CPU/);
  });

  it("★★★ 每一行是固定的单行高度", async () => {
    await renderIdle([IDLE(), MEMCACHED]);
    for (const r of document.querySelectorAll<HTMLElement>("[data-finding-id]")) {
      expect(r.style.height, "行高不固定 —— 多行单元格会让每行高矮不一").toBe("56px");
    }
  });

  it("★★★ 同一台资源的「闲置」与「存储超配」合并成一行、两个标签", async () => {
    await renderIdleRows([IDLE(), STORAGE, MEMCACHED], 2);
    expect(screen.getAllByText("insp-mysql-m8g").length).toBe(1);
    const row = screen.getByText("insp-mysql-m8g").closest("[data-finding-id]")!;
    // 点开的是闲置那条（带金额与评分明细），不是超配那条
    expect(row.getAttribute("data-finding-id")).toMatch(/#idle#/);
    expect(row.textContent).toMatch(/闲置/);
    expect(row.textContent).toMatch(/存储超配/);
  });

  it("★★★ 只有超配、没有闲置判定的资源照样一行，金额「—」且不挂「未判定」", async () => {
    await renderIdleRows([IDLE(), ONLY_CAP], 2);
    const row = screen.getByText("insp-valkey-001").closest("[data-finding-id]")!;
    expect(row.textContent).toMatch(/内存超配/);
    expect(row.textContent).toMatch(/—/);
    expect(screen.queryByText("未判定")).toBeNull();
  });

  it("★★★ 页头与 KPI 按台计，金额不因同一台的两条发现重复计", async () => {
    // 同一台上再挂一条**有金额**的超配：下线与降配二选一，只能取大的那笔。
    const priced = { ...STORAGE, savings_usd: 100, savings_precision: "coarse_default" } as FindingRow;
    await renderIdleRows([IDLE(), priced, MEMCACHED], 2);
    expect(screen.getByText("$627")).toBeTruthy();        // 387 + 240，不是 727
    expect(screen.getByText(/3 条发现/)).toBeTruthy();
    expect(screen.getByText(/1 台同时容量超配/)).toBeTruthy();
  });

  it("★★ 服务列显示服务名", async () => {
    await renderIdle([IDLE(), MEMCACHED]);
    const row = screen.getByText("insp-memcached").closest("[data-finding-id]")!;
    expect(row.textContent).toMatch(/ElastiCache/);
  });

  it("★★ 非 active 的状态仍要显示（new / resolving / chronic 各意味着不同动作）", async () => {
    await renderIdle([IDLE({ state: "resolving" }), MEMCACHED]);
    expect(screen.getByText("缓解中")).toBeTruthy();
  });

  it("★★★ 「已确认」「持续」不再逐行挂着", async () => {
    await renderIdle([IDLE(), MEMCACHED]);
    expect(screen.queryByText("已确认")).toBeNull();
    expect(screen.queryByText("持续")).toBeNull();
  });

  it("★★★ 手动派过 AI 的闲置条目要标「手动」（否则与副标题「不派 AI」矛盾）", async () => {
    await renderIdle([IDLE(), REDIS_AI]);
    const row = screen.getByText("insp-redis-single-001").closest("[data-finding-id]")!;
    expect(row.textContent).toMatch(/确有劣化/);
    expect(row.textContent).toMatch(/手动/);
    expect(screen.getByText(/手动派一次 AI 判读/),
      "副标题没说可以手动派 —— 同一屏上的「AI 结论」就成了自相矛盾").toBeTruthy();
  });

  it("★★ 行仍是可键盘操作的按钮，点开抽屉", async () => {
    await renderIdle([IDLE()]);
    const row = document.querySelector("[data-finding-id]") as HTMLElement;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(row, { key: "Enter" });
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  });

  it("★★★ 抽屉里能切到同一台资源的另一条发现（它在列表里不再单独占一行）", async () => {
    await renderIdleRows([IDLE(), STORAGE], 1);
    fireEvent.click(document.querySelector("[data-finding-id]")!);
    const dlg = await waitFor(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) throw new Error("抽屉没开");
      return d as HTMLElement;
    });
    expect(dlg.textContent).toMatch(/同一台资源/);
    expect(dlg.textContent).toMatch(/分配的存储远大于实际占用/);
    fireEvent.click([...dlg.querySelectorAll("button")].find((b) => /查看/.test(b.textContent || ""))!);
    await waitFor(() => {
      const d = document.querySelector('[role="dialog"]')!;
      // 切过去之后一句结论说的是容量审计，反向入口指回闲置那条
      expect(d.textContent).toMatch(/容量审计判定为存储超配/);
      expect(d.textContent).toMatch(/被判定闲置，评分 97/);
    });
  });

  it("★★★ 抽屉里「判定方式」用界面文案，不读库里那句可能过时的 conclusion", async () => {
    // 2026-10 之前写进库的闲置结论还在承诺「降配目标」（没有代码算过那个数）。
    const STALE = "闲置判定由评分链路确定性完成：结论与降配目标见本条的评分明细，无需 AI 判读。";
    await renderIdle([IDLE({ conclusion: STALE })]);
    fireEvent.click(document.querySelector("[data-finding-id]")!);
    // 判定方式收在「评分明细」折叠里（结论先行：算法细节默认不占版面）
    const fold = await waitFor(() => screen.getByRole("button", { name: /评分明细/ }));
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    await waitFor(() => expect(screen.getByText("判定方式")).toBeTruthy());
    expect(screen.queryByText(/降配目标/)).toBeNull();
  });

  it("★★ 服务筛选是单选分段控件，计数按台，点了只剩那一类", async () => {
    await renderIdle([IDLE(), MEMCACHED]);
    const seg = [...document.querySelectorAll("button")]
      .find((b) => /^ElastiCache 1$/.test((b.textContent || "").trim()))!;
    expect(seg).toBeTruthy();
    expect(seg.closest('[role="group"]'), "不是一组互斥按钮").not.toBeNull();
    fireEvent.click(seg);
    await waitFor(() => expect(document.querySelectorAll("[data-finding-id]").length).toBe(1));
    expect(screen.queryByText("insp-mysql-m8g")).toBeNull();
  });

  it("★★★ 全部粗估时 KPI 说「全部」，逐行不再挂「粗估」", async () => {
    await renderIdle([IDLE(), MEMCACHED]);
    expect(screen.getByText(/全部为粗估/)).toBeTruthy();
    expect(screen.queryByText("粗估")).toBeNull();
  });

  it("★★★ 混合精度时不许说「全部为粗估」（那是一句假话），逐行标出粗估的", async () => {
    const exact = { ...MEMCACHED, savings_precision: "exact_api" } as FindingRow;
    await renderIdle([IDLE(), exact]);
    expect(screen.queryByText(/全部为粗估/)).toBeNull();
    expect(screen.getByText(/其中 1 台为粗估/)).toBeTruthy();
    expect(screen.getAllByText("粗估").length).toBe(1);
  });
});

describe("高负载：表格 + 结论先行抽屉（2026-10，与闲置页对齐）", () => {
  const HIGH = IDLE({
    finding_id: "123456789012#ap-northeast-1#rds#insp-pg#threshold_high#cpu",
    rule: "threshold_high", kind: "high_load", metric: "CPUUtilization",
    observed_value: 85.3, threshold_value: 70, headroom: -0.219, unit: "%", direction: "bad_up",
    severity: "HIGH", savings_usd: null, savings_precision: "", idle_score: null,
    idle_factors: [], instance: "insp-pg", conclusion: "", skip_reason: "",
    consecutive_hits: 3, da_task_id: "t-h1", da_parse_status: "ok",
    da_verdict: "real_degradation", has_judgment: true,
    da_gate_trustworthy: true, da_degradations: [],
  });
  /** 同一台（insp-pg）上的另一条：更严重的连接数。 */
  const CONN = { ...HIGH,
    finding_id: "123456789012#ap-northeast-1#rds#insp-pg#threshold_high#conn",
    metric: "DatabaseConnections", observed_value: 95, threshold_value: 80, headroom: -0.19,
    severity: "CRITICAL", da_verdict: "expected_behaviour" } as FindingRow;
  /** 另一台：只有一条 HIGH。 */
  const OTHER = { ...HIGH,
    finding_id: "123456789012#us-west-2#elasticache#insp-valkey-001#threshold_high#frag",
    region: "us-west-2", service: "elasticache", instance: "insp-valkey-001",
    instance_class: "cache.m7g.large", metric: "MemoryFragmentationRatio",
    observed_value: 4.02, threshold_value: 3, unit: "", headroom: -0.34,
    state: "new", da_task_id: "", da_parse_status: "", da_verdict: "", has_judgment: false,
    skip_reason: "budget" } as FindingRow;

  /** 后端按严重度 → 天数排好（`sortForKind` 前端也会再排一次）。 */
  async function renderHigh(rows: FindingRow[], expectRows: number) {
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS(rows));
    render(<InspectionDashboard dashboardId="high-load" can={() => true} />);
    await waitFor(() => expect(document.querySelectorAll("[data-finding-id]").length)
      .toBe(expectRows));
  }

  it("★★★ 「已确认」「持续」不再逐行挂着，实测值仍在", async () => {
    await renderHigh([HIGH], 1);
    expect(screen.queryByText("已确认")).toBeNull();
    expect(screen.queryByText("持续")).toBeNull();
    expect(screen.getByText("85.3%")).toBeTruthy();
    expect(screen.getByText(/高于阈值 70%/)).toBeTruthy();
  });

  it("★★★ 一行一台资源：同一台两个指标越线 → 一行，主行是最严重那条，挂「+1」", async () => {
    await renderHigh([HIGH, CONN, OTHER], 2);
    expect(screen.getAllByText("insp-pg").length).toBe(1);
    const row = screen.getByText("insp-pg").closest("[data-finding-id]")!;
    expect(row.getAttribute("data-finding-id"), "主行不是最严重的那条").toMatch(/#conn$/);
    expect(row.textContent).toMatch(/紧急/);
    expect(row.textContent).toMatch(/\+1/);
    // 另一条的指标名在「+1」的 title 里（悬浮可见），不在行面上
    const plus = [...row.querySelectorAll("span")].find((e) => e.textContent === "+1")!;
    expect(plus.getAttribute("title")).toMatch(/CPU/);
  });

  it("★★★ 每一行是固定的单行高度", async () => {
    await renderHigh([HIGH, OTHER], 2);
    for (const r of document.querySelectorAll<HTMLElement>("[data-finding-id]")) {
      expect(r.style.height).toBe("56px");
    }
  });

  it("★★★ KPI 按台计：台数 / 条数 / 新增 / 严重度分布 / AI 确有劣化", async () => {
    await renderHigh([HIGH, CONN, OTHER], 2);
    expect(screen.getByText(/3 条发现/)).toBeTruthy();
    expect(screen.getByText(/1 台新增/)).toBeTruthy();
    // insp-pg 的主行（连接数）判读是「预期行为」→ 确有劣化 0 台；OTHER 缺判读
    expect(screen.getByText("台确有劣化").parentElement!.textContent).toMatch(/^0/);
    expect(screen.getByText(/预期行为 1/)).toBeTruthy();
    expect(screen.getByText(/缺判读 1/)).toBeTruthy();
    // 旧版那四个可点的严重度大按钮不在了
    expect(document.querySelector('button[name="sev_MEDIUM"]'),
      "数是 0 的档位也画出来了 —— 只列有数的").toBeNull();
  });

  it("★★★ 严重度筛选按**行**（每台最严重的那条），计数与表格行数一致", async () => {
    await renderHigh([HIGH, CONN, OTHER], 2);
    const high = document.querySelector<HTMLButtonElement>('button[name="sev_HIGH"]')!;
    expect(high.textContent).toMatch(/高\s*1/);
    fireEvent.click(high);
    // insp-pg 最严重的是紧急 —— 它不该以「CPU 那条」的身份出现在「高」里
    await waitFor(() => expect(document.querySelectorAll("[data-finding-id]").length).toBe(1));
    expect(screen.queryByText("insp-pg")).toBeNull();
    expect(screen.getByText("insp-valkey-001")).toBeTruthy();
  });

  it("★★★ 抽屉：实测值 vs 阈值在顶部，一句结论，AI 结论卡含严重度意见", async () => {
    vi.mocked(api.getInspectionFinding).mockResolvedValue({
      ok: true, da_updated_at: 1788223019,
      da_body: [
        "## 123456789012#ap-northeast-1#rds#insp-pg#threshold_high#cpu",
        "verdict: real_degradation",
        // 实机见过 skill 在字段里写 markdown 加粗 —— 纯文本节点里星号会字面显示。
        "summary: CPU 连续三天越线，**峰值与业务高峰重合**。",
        "root_cause_hypothesis: 慢查询堆积",
        "blast_radius: CPU 打满后连接排队",
        "recommended_action:",
        "- action: 先定位慢查询再考虑升配",
        "  downtime: no",
        "  approval_or_window: no",
        "change_attribution: no related change found",
        "severity_dispute: HIGH 偏低，峰值时已影响写入",
      ].join("\n"),
    } as never);
    await renderHigh([HIGH], 1);
    fireEvent.click(document.querySelector("[data-finding-id]")!);
    const dlg = await waitFor(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) throw new Error("抽屉没开");
      return d as HTMLElement;
    });
    expect(dlg.textContent).toMatch(/85\.3%/);
    expect(dlg.textContent).toMatch(/超出 22%/);
    expect(dlg.textContent).toMatch(/CPU 使用率连续 3 轮高于阈值 70%，最近一次 85\.3%/);
    await waitFor(() => expect(dlg.textContent).toMatch(/CPU 连续三天越线，峰值与业务高峰重合/));
    expect(dlg.textContent, "markdown 星号漏给客户看了").not.toMatch(/\*\*/);
    expect(dlg.textContent).toMatch(/AI 对严重度的意见/);
    expect(dlg.textContent).toMatch(/HIGH 偏低/);
    expect(dlg.textContent).toMatch(/先定位慢查询再考虑升配/);
    // 指标曲线那行占位删了
    expect(dlg.textContent).not.toMatch(/指标曲线/);
    // 诊断信息默认折起
    const fold = screen.getByRole("button", { name: /诊断信息/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
  });

  it("★★★ 抽屉里能切到同一台资源上另一个越线的指标", async () => {
    vi.mocked(api.getInspectionFinding).mockResolvedValue({ ok: true, da_body: "" } as never);
    await renderHigh([HIGH, CONN], 1);
    fireEvent.click(document.querySelector("[data-finding-id]")!);
    const dlg = await waitFor(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) throw new Error("抽屉没开");
      return d as HTMLElement;
    });
    expect(dlg.textContent).toMatch(/同一台资源/);
    fireEvent.click([...dlg.querySelectorAll("button")].find((b) => /查看/.test(b.textContent || ""))!);
    await waitFor(() => expect(document.querySelector('[role="dialog"]')!.textContent)
      .toMatch(/CPU 使用率连续 3 轮高于阈值 70%/));
  });
});


describe("资源已经不存在 / 停更（2026-10-10，677 实测）", () => {
  /* 资源 9/14 就删了，抽屉里「深入分析」还在，点了才被告知「资源不存在」，
     再点还是同一句；KPI 合计里还算着它；页面上没有任何一处说数据停在 9/13。 */
  const GONE = IDLE({ resource_missing_on: "2026-10-10", last_run_date: "2026-09-13",
    days_since_eval: 27 });

  const openDrawerOf = async (name: string) => {
    fireEvent.click(screen.getByText(name).closest("[data-finding-id]")!);
    return waitFor(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) throw new Error("抽屉没开");
      return d as HTMLElement;
    });
  };

  it("★★★ 已不存在：行上有标签、金额不计入合计、抽屉不给深入分析且写清楚", async () => {
    await renderIdle([GONE, MEMCACHED]);
    const row = screen.getByText("insp-mysql-m8g").closest("[data-finding-id]")!;
    expect(row.textContent).toMatch(/已不存在/);
    expect(row.textContent, "删掉的库还显示可省金额").not.toMatch(/\$387/);
    // KPI 合计只剩 MEMCACHED 那台（$240，出现在合计 / 按服务 / 行上），而不是 387 + 240
    expect(screen.queryByText("$627"), "合计里还算着已删除那台").toBeNull();
    expect(screen.getByText(/1 台已不存在（未计入）/)).toBeTruthy();

    const dlg = await openDrawerOf("insp-mysql-m8g");
    expect(dlg.textContent).toMatch(/这台资源已经不存在/);
    expect(dlg.textContent).toMatch(/123456789012/);
    expect(dlg.textContent).toMatch(/2026-10-10 核实/);
    const btns = [...dlg.querySelectorAll("button")].map((b) => b.textContent || "");
    expect(btns.some((x) => /深入分析/.test(x)), "资源都没了还给「深入分析」").toBe(false);
    expect(btns.some((x) => /移出巡检范围/.test(x))).toBe(false);
    expect(dlg.textContent, "对一台删掉的库还摆「确认归属 → 删除」").not.toMatch(/建议处置/);
  });

  it("★★★ 点深入分析回 resource_gone：按钮立刻消失、写清资源已不存在、不挂红条", async () => {
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue({
      ok: false, code: "resource_gone",
      message: "这台资源已经不存在了：在账号 123456789012 的 ap-northeast-1 里查不到 insp-mysql-m8g",
    } as never);
    await renderIdle([IDLE(), MEMCACHED]);
    const dlg = await openDrawerOf("insp-mysql-m8g");
    fireEvent.click([...dlg.querySelectorAll("button")].find((b) => /深入分析/.test(b.textContent || ""))!);
    await waitFor(() => expect(document.querySelectorAll('[role="dialog"]').length).toBe(2));
    const modal = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector("textarea"))!;
    fireEvent.click([...modal.querySelectorAll("button")].find((b) => /开始分析/.test(b.textContent || ""))!);
    await waitFor(() => expect(document.querySelector('[role="dialog"]')!.textContent)
      .toMatch(/这台资源已经不存在/));
    const drawer = document.querySelector('[role="dialog"]')!;
    expect([...drawer.querySelectorAll("button")].some((b) => /深入分析/.test(b.textContent || "")),
      "回了 resource_gone 按钮还在 —— 客户会一直点").toBe(false);
    // 后端原话（「…已经不存在了：…」）不再挂成一条提示 —— 顶部那段说明就是回答
    expect(drawer.textContent, "同一句话说了两遍（提示条 + 顶部说明）").not.toMatch(/已经不存在了：/);
  });

  it("★★ describe 没列全（describe_incomplete）：不说已删除，按钮留着可以重试", async () => {
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue({
      ok: false, code: "describe_incomplete", message: "暂时确认不了 insp-mysql-m8g 还在不在",
    } as never);
    await renderIdle([IDLE()]);
    const dlg = await openDrawerOf("insp-mysql-m8g");
    fireEvent.click([...dlg.querySelectorAll("button")].find((b) => /深入分析/.test(b.textContent || ""))!);
    await waitFor(() => expect(document.querySelectorAll('[role="dialog"]').length).toBe(2));
    const modal = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector("textarea"))!;
    fireEvent.click([...modal.querySelectorAll("button")].find((b) => /开始分析/.test(b.textContent || ""))!);
    await waitFor(() => expect(screen.getByText(/暂时确认不了/)).toBeTruthy());
    const drawer = document.querySelector('[role="dialog"]')!;
    expect(drawer.textContent).not.toMatch(/这台资源已经不存在/);
    expect([...drawer.querySelectorAll("button")].some((b) => /深入分析/.test(b.textContent || ""))).toBe(true);
  });

  it("★★★ 停更：页面一行说清数据停在哪天，抽屉里也说", async () => {
    const STALE = IDLE({ last_run_date: "2026-09-13", days_since_eval: 27 });
    await renderIdle([STALE, MEMCACHED]);
    expect(screen.getByText(/1 台资源的数据停在 2026-09-13/)).toBeTruthy();
    const dlg = await openDrawerOf("insp-mysql-m8g");
    expect(dlg.textContent).toMatch(/最后一次评估是 2026-09-13（27 天前）/);
  });

  it("★★ 今天评估过的不提示停更（阈值 2 天，避免 00:00~02:00 误报）", async () => {
    await renderIdle([IDLE({ days_since_eval: 1 }), MEMCACHED]);
    expect(screen.queryByText(/数据停在/)).toBeNull();
  });

  it("★★ 高负载表格：已不存在的资源在严重度旁挂标签", async () => {
    const HIGH = IDLE({
      finding_id: "123456789012#ap-northeast-1#rds#insp-pg#threshold_high#cpu",
      rule: "threshold_high", kind: "high_load", metric: "CPUUtilization",
      observed_value: 85.3, threshold_value: 70, unit: "%", direction: "bad_up",
      severity: "HIGH", savings_usd: null, idle_score: null, idle_factors: [],
      instance: "insp-pg", conclusion: "", skip_reason: "",
      resource_missing_on: "2026-10-10" });
    vi.mocked(api.getInspectionFindings).mockResolvedValue(FINDINGS([HIGH]));
    render(<InspectionDashboard dashboardId="high-load" can={() => true} />);
    await waitFor(() => expect(screen.getByText("insp-pg")).toBeTruthy());
    expect(screen.getByText("insp-pg").closest("[data-finding-id]")!.textContent).toMatch(/已不存在/);
    expect(screen.getByText(/1 台已不存在/)).toBeTruthy();
  });
});


describe("2026-10-10 交叉 review 第 1 批", () => {
  const openDrawerOf = async (name: string) => {
    fireEvent.click(screen.getByText(name).closest("[data-finding-id]")!);
    return waitFor(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) throw new Error("抽屉没开");
      return d as HTMLElement;
    });
  };

  it("★★★ B3/F-06：已解决行上的「已不存在」标记不污染同一台资源上开着的新发现", async () => {
    // 删库 → resolve_gone 关掉 idle 那条（带标记）→ 同名恢复后只有存储超配重新打开
    const OLD = IDLE({ state: "resolved", resolution_kind: "resource_gone",
      resource_missing_on: "2026-09-14" });
    const NOW = IDLE({
      finding_id: "123456789012#ap-northeast-1#rds#insp-mysql-m8g#oversized_storage#-",
      rule: "oversized_storage", idle_score: null, idle_factors: [], savings_usd: 120 });
    await renderIdleRows([OLD, NOW], 1);
    const row = screen.getByText("insp-mysql-m8g").closest("[data-finding-id]")!;
    expect(row.textContent, "在跑的资源被标成「已不存在」").not.toMatch(/已不存在/);
    const dlg = await openDrawerOf("insp-mysql-m8g");
    expect(dlg.textContent).not.toMatch(/这台资源已经不存在/);
    expect([...dlg.querySelectorAll("button")].some((b) => /深入分析/.test(b.textContent || "")))
      .toBe(true);
  });

  it("★★★ B1：「已解决」里点开的发现不给「深入分析」（后端必拒 conflict）", async () => {
    await renderIdleRows([IDLE(), IDLE({
      finding_id: "123456789012#us-east-1#elasticache#insp-old#idle#-",
      region: "us-east-1", service: "elasticache", instance: "insp-old",
      state: "resolved", resolution_kind: "fixed" })], 1);
    fireEvent.click(document.querySelector('button[name="chip_resolved"]')!);
    await waitFor(() => expect(screen.getByText("insp-old")).toBeTruthy());
    const dlg = await openDrawerOf("insp-old");
    expect([...dlg.querySelectorAll("button")].some((b) => /深入分析/.test(b.textContent || "")),
      "已解决的还给「深入分析」").toBe(false);
  });

  it("★★ 因资源不存在而关闭的，在「已解决」里用过去时说一句", async () => {
    await renderIdleRows([IDLE(), IDLE({
      finding_id: "123456789012#us-east-1#elasticache#insp-old#idle#-",
      region: "us-east-1", service: "elasticache", instance: "insp-old",
      state: "resolved", resolution_kind: "resource_gone", resource_missing_on: "2026-10-10",
      last_run_date: "2026-10-10" })], 1);
    fireEvent.click(document.querySelector('button[name="chip_resolved"]')!);
    const dlg = await openDrawerOf("insp-old");
    expect(dlg.textContent).toMatch(/已于 2026-10-10 关闭/);
    expect(dlg.textContent, "已经关了还说「这台资源已经不存在」+ 承诺会关").not.toMatch(/这台资源已经不存在/);
  });

  it("★★ B18：回 conflict 时重取列表，按钮跟着真实状态走", async () => {
    vi.mocked(api.judgeInspectionFinding).mockResolvedValue(
      { ok: false, code: "conflict", message: "这条 finding 已标记为「已解决」" } as never);
    await renderIdle([IDLE()]);
    const before = vi.mocked(api.getInspectionFindings).mock.calls.length;
    const dlg = await openDrawerOf("insp-mysql-m8g");
    fireEvent.click([...dlg.querySelectorAll("button")].find((b) => /深入分析/.test(b.textContent || ""))!);
    await waitFor(() => expect(document.querySelectorAll('[role="dialog"]').length).toBe(2));
    const modal = [...document.querySelectorAll('[role="dialog"]')].find((d) => d.querySelector("textarea"))!;
    fireEvent.click([...modal.querySelectorAll("button")].find((b) => /开始分析/.test(b.textContent || ""))!);
    await waitFor(() => expect(vi.mocked(api.getInspectionFindings).mock.calls.length)
      .toBeGreaterThan(before));
  });

  it("★★ 横幅与标签不再承诺「下一次正式巡检会关闭」", async () => {
    await renderIdle([IDLE({ resource_missing_on: "2026-10-10" }), MEMCACHED]);
    const dlg = await openDrawerOf("insp-mysql-m8g");
    expect(dlg.textContent).not.toMatch(/下一次正式巡检/);
    expect(document.querySelector('[title*="下一次正式巡检"]')).toBeNull();
  });
});
