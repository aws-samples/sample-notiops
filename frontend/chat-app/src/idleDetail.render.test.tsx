/**
 * 闲置详情抽屉「结论先行」版（2026-10 第三版，mock A + A2）—— 行为测试。
 *
 * 客户原话：「side panel 里面，总感觉就是乱糟糟一行一行文字」。这一组钉住的是
 * 阅读顺序（省多少 → 为什么 → 怎么做 → 算法细节）与几处数据层面的修正。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FindingRow } from "./api/inspection";

vi.mock("./api/inspection", async (orig) => {
  const real = await orig<typeof import("./api/inspection")>();
  return { ...real, getInspectionFinding: vi.fn() };
});

const api = await import("./api/inspection");
const { default: Panel } = await import("./components/InspectionDashboardPanel");
const { parseJudgment, idleVerdictLabel, signalRows, actionSteps } =
  await import("./components/inspection/idleDetailUtil");

/** insp-mysql-m8g 的真实形态（677 账号）。 */
const MYSQL = (over: Partial<FindingRow> = {}): FindingRow => ({
  finding_id: "123456789012#ap-northeast-1#rds#insp-mysql-m8g#idle#-",
  account_id: "123456789012", region: "ap-northeast-1", service: "rds",
  instance: "insp-mysql-m8g", instance_class: "db.m8g.large",
  rule: "idle", kind: "idle", metric: "", state: "active", severity: "INFO",
  first_seen_date: "2026-09-07", last_run_date: "2026-09-13", days_active: 33,
  rule_version: "v", consecutive_hits: 7, consecutive_misses: 0, was_confirmed: true,
  observed_value: null, threshold_value: null, headroom: null, unit: "",
  raw_value: null, denominator: null, direction: "",
  savings_usd: 387, savings_precision: "table_unverified_region",
  idle_score: 97.3443, idle_weight_avail: 0.7, idle_degraded: ["connections"],
  idle_factors: [
    { name: "cpu", weight: 0.571, normalized: 0.981, points: 56.06, basis: "cpu_pct", observed: 1.899 },
    { name: "storage", weight: 0.286, normalized: 0.9452, points: 27.0, basis: "storage_free_ratio", observed: null },
    { name: "iops", weight: 0.143, normalized: 0.9997, points: 14.28, basis: "iops_over_baseline", observed: 1.03 },
  ],
  evidence_as_of: "2026-09-13",
  da_verdict: "", da_parse_status: "", da_task_id: "", da_report_md_key: "",
  has_judgment: false, conclusion: "", skip_reason: "deterministic",
  ...over,
} as unknown as FindingRow);

/** 真实 DA 判读正文（insp-redis-single-001）。 */
const BODY = `verdict: real_degradation
disposition: verify_owner
idle_reason: genuinely_unused
summary: ap-northeast-1 的单节点 Redis 7.1 primary，CurrItems 恒为 0、缓存为空、无业务数据，属真闲置；但无 operator_note 或明确归属凭据，删除授权不足。
evidence:
- CurrItems = 0.0，BytesUsedForCache 约 9.7 MB 但无键存储
- resource_role=redis_primary 非副本
recommended_action:
- action: 联系资源归属团队确认是否仍需保留；确认无主后创建最终快照并删除
  downtime: yes
  approval_or_window: yes
  caveats: resource_reachable=false，无法查询更长时间窗口排除月末或季度性批处理场景
savings: 120 USD/月（price_precision: coarse_keyword，粗估）
change_attribution: no related change found`;

const REDIS = (over: Partial<FindingRow> = {}) => MYSQL({
  finding_id: "123456789012#ap-northeast-1#elasticache#insp-redis-single-001#idle#-",
  service: "elasticache", instance: "insp-redis-single-001", instance_class: "cache.m7g.large",
  savings_usd: 120, savings_precision: "coarse_keyword", idle_score: 99.9, idle_degraded: [],
  idle_factors: [
    { name: "cpu", weight: 0.35, normalized: 0.999, points: 34.97, basis: "cpu_pct", observed: 0.09 },
    { name: "memory", weight: 0.35, normalized: 0.998, points: 34.93, basis: "memory_pct", observed: 0.19 },
    { name: "requests", weight: 0.3, normalized: 1, points: 30, basis: "requests_over_threshold", observed: 0 },
  ],
  da_task_id: "665fe1d2", da_parse_status: "ok", da_verdict: "real_degradation",
  has_judgment: true, da_gate_trustworthy: true, da_degradations: [],
  ...over,
} as Partial<FindingRow>);

beforeEach(() => { vi.mocked(api.getInspectionFinding).mockReset(); });
afterEach(() => cleanup());

describe("判读正文 → 结构化字段", () => {
  it("★★★ 拆出 verdict / disposition / idle_reason / summary / 建议与标记", () => {
    const p = parseJudgment(BODY)!;
    expect(p.verdict).toBe("real_degradation");
    expect(p.disposition).toBe("verify_owner");
    expect(p.idleReason).toBe("genuinely_unused");
    expect(p.summary).toMatch(/^ap-northeast-1 的单节点 Redis/);
    expect(p.evidence.length).toBe(2);
    expect(p.actions[0].action).toMatch(/联系资源归属团队/);
    expect(p.actions[0].downtime).toBe("yes");
    expect(p.actions[0].approval).toBe("yes");
    expect(p.actions[0].caveats).toMatch(/季度性批处理/);
  });

  it("★★ summary 续行接回去（skill 的示例就是两行）", () => {
    const p = parseJudgment("verdict: real_degradation\nsummary: 单节点 Redis primary，\n  窗口内无连接。\n")!;
    expect(p.summary).toBe("单节点 Redis primary，窗口内无连接。");
  });

  it("★★★ 拆不出结构就返回 null（调用方照原样渲染全文，不能丢字）", () => {
    expect(parseJudgment("**verdict**: warm_up\n**evidence**: …")).toBeNull();
    expect(parseJudgment("这是一段散文，没有任何 label。")).toBeNull();
    expect(parseJudgment("")).toBeNull();
  });

  it("★★★ 闲置语境下 real_degradation 叫「确认闲置」，不叫「确有劣化」", () => {
    const t = (k: string) => k;
    expect(idleVerdictLabel("real_degradation", t, true)).toBe("确认闲置");
  });
});

describe("判定依据", () => {
  it("★★★ 可用存储显示百分比，不是「—」（字节没落库，但比值就是归一化值）", () => {
    const rows = signalRows(MYSQL(), true);
    const st = rows.find((r) => r.key === "storage")!;
    expect(st.value).toBe("94.5%");
    expect(st.hint).toBe("分配的存储大多没用上");
  });

  it("★★ 缺的维度灰着列出来，说明没计入评分", () => {
    const off = signalRows(MYSQL(), true).find((r) => r.key === "off-connections")!;
    expect(off.off).toBe(true);
    expect(off.value).toBe("无数据");
    expect(off.hint).toBe("未计入评分");
  });

  it("★★ 请求数带上「/ 分钟」量纲", () => {
    const rq = signalRows(REDIS(), true).find((r) => r.key === "requests")!;
    expect(rq.value).toBe("0 / 分钟");
  });
});

describe("建议处置按服务写", () => {
  it("★★★ ElastiCache 不说「停止」（它没有这个操作）", () => {
    const txt = actionSteps(REDIS(), true).map((s) => s.title + s.sub).join();
    expect(txt).toMatch(/ElastiCache 没有「停止」/);
    expect(txt).not.toMatch(/停止观察/);
  });
  it("★★ RDS 写清停止最长 7 天", () => {
    const txt = actionSteps(MYSQL(), true).map((s) => s.sub).join();
    expect(txt).toMatch(/最长 7 天/);
  });
});

describe("抽屉排版：结论先行", () => {
  it("★★★ 顶部先给答案：金额、粗估短标签、天数、一句结论", () => {
    render(<Panel row={MYSQL()} onClose={() => {}} onJudge={() => {}} />);
    expect(screen.getByText("$387")).toBeTruthy();
    expect(screen.getByText("粗估 · 区域未核对")).toBeTruthy();
    expect(screen.getByText("33 天")).toBeTruthy();
    expect(screen.getByText(/CPU 长期接近零.*规则评分 97 \/ 100，判定为闲置。/)).toBeTruthy();
  });

  it("★★★ 评分明细与诊断信息默认折起，点开才有表", () => {
    render(<Panel row={MYSQL()} onClose={() => {}} />);
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    const fold = screen.getByRole("button", { name: /评分明细/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    expect(document.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: /诊断信息/ }).getAttribute("aria-expanded"))
      .toBe("false");
  });

  it("★★★ 没派过 AI：给通用步骤，并提示可以派（有入口时）", () => {
    render(<Panel row={MYSQL()} onClose={() => {}} onJudge={() => {}} />);
    expect(screen.getByText("建议处置")).toBeTruthy();
    expect(screen.getByText("确认归属")).toBeTruthy();
    expect(screen.getByText(/拿不准？/)).toBeTruthy();
  });

  it("★★ 没有派 AI 的权限 → 不提示去点一个不存在的按钮", () => {
    render(<Panel row={MYSQL()} onClose={() => {}} />);
    expect(screen.queryByText(/拿不准？/)).toBeNull();
  });
});

describe("抽屉排版：派过 AI（A2）", () => {
  it("★★★ 结论卡置顶：闲置语境标签 + 原因 + 一句总结 + 建议与标记", async () => {
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: BODY, da_updated_at: 1757700000 } as never);
    render(<Panel row={REDIS()} judged onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("确认闲置 · 没人在用")).toBeTruthy());
    expect(screen.getByText(/CurrItems 恒为 0/)).toBeTruthy();
    expect(screen.getByText(/联系资源归属团队/)).toBeTruthy();
    expect(screen.getByText("需要停机")).toBeTruthy();
    expect(screen.getByText("需要审批 / 变更窗口")).toBeTruthy();
    expect(screen.getByText(/季度性批处理/)).toBeTruthy();
    expect(screen.queryByText("确有劣化"), "闲置条目上还在说「确有劣化」").toBeNull();
  });

  it("★★★ AI 给了建议 → 不再摆一份通用步骤（两份建议会互相矛盾）", async () => {
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: BODY, da_updated_at: 1757700000 } as never);
    render(<Panel row={REDIS()} judged onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("确认闲置 · 没人在用")).toBeTruthy());
    expect(screen.queryByText("建议处置")).toBeNull();
  });

  it("★★★ 原文折在「查看完整判读」里，点开能看到全文", async () => {
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: BODY, da_updated_at: 1757700000 } as never);
    render(<Panel row={REDIS()} judged onClose={() => {}} />);
    const btn = await waitFor(() => screen.getByRole("button", { name: /查看完整判读/ }));
    expect(document.querySelector(".insp-md")).toBeNull();
    fireEvent.click(btn);
    expect(document.querySelector(".insp-md")?.textContent).toMatch(/change_attribution/);
  });

  it("★★★ 拆不出结构的老正文 → 退回原来的「AI 判读」一节，全文照样显示", async () => {
    const OLD = "这是一段老格式的判读正文，没有 label。";
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: OLD, da_updated_at: 1757700000 } as never);
    render(<Panel row={REDIS()} judged onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(OLD)).toBeTruthy());
    expect(screen.getByText("AI 判读")).toBeTruthy();
    // 拆不出建议 → 通用步骤保留
    expect(screen.getByText("建议处置")).toBeTruthy();
  });

  it("★★ 门禁说不可信 → 卡片里标红", async () => {
    vi.mocked(api.getInspectionFinding).mockResolvedValue(
      { ok: true, da_body: BODY, da_updated_at: 1757700000 } as never);
    render(<Panel row={REDIS({ da_gate_trustworthy: false, da_degradations: ["analysis_gap"] } as Partial<FindingRow>)}
      judged onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("确认闲置 · 没人在用")).toBeTruthy());
    const { STRINGS } = await import("./i18n");
    expect(screen.getByText(new RegExp(STRINGS["insp.gate.headUntrusted"].zh))).toBeTruthy();
  });
});
