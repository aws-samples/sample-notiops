/**
 * 仪表盘「没问到」与「答案是没有」必须分开画 —— 渲染测试。
 *
 * ## 守的是什么
 *
 * 每张卡都有两条完全不同的坏路径：
 *   `ok:false`        = 我们这边没请求成功（未登录 / http_5xx / 网络断）→ 重试。
 *   `available:false` = 后端答了，答案是「你环境里没有 / 用不了」→ 别等了。
 *
 * 混成一态时，一次 HTTP 500 会被画成一句**关于客户环境的具体假话**：
 * 「你没在用 AWS Backup」「需 Business/Enterprise Support」「Security Hub 未开通」，
 * 最危险的是绿色的「当前无告警 ✓」—— 服务挂掉时告诉用户一切正常。
 * 用户会当真：不重试、不报障、甚至去升级支持计划或开一个已经开着的服务。
 *
 * ## 为什么必须是渲染测试
 *
 * 「源码里有 FailBanner 这个词」证明不了任何事：
 *   把 `data.ok === false` 写成 `data.ok === undefined` → 子串检查照过，失败态永不出现；
 *   把 `!failed` 门禁漏在某张卡上          → 子串检查照过，500 时那张卡照样画绿勾。
 * 两者都只有真渲染出来看输出才抓得到。所以每条正例都配一条**反例**：
 * 真的 `available:false` 仍要画「不可用」，真的 0 告警仍要画绿勾 ——
 * 否则「一律画加载失败」也能骗过正例。
 *
 * ## 附带守的不变量
 *
 * 界面上**只许**出现我们自己的错误码（`http_500` / `fetch_failed` / `not_authenticated`）
 * 或后端回的异常**类型名**。`message` 字段（客户端那条是 `String(e)`，带请求 URL；
 * 服务端那条可能带账号 id / ARN / 表名）绝不许渲染。见 docs/LOGGING_STANDARD.md。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ⚠️ mock 必须在被测组件 import **之前**生效。`vi.mock` 会被提升到文件顶部，
//    所以写在这里即可 —— 但工厂函数里不能引用外部变量（提升后还没初始化）。
vi.mock("./api/alarms", async (orig) => ({
  ...(await orig<typeof import("./api/alarms")>()),
  getAlarmDashboard: vi.fn(),
  getBackupDashboard: vi.fn(),
}));
vi.mock("./api/notifications", async (orig) => ({
  ...(await orig<typeof import("./api/notifications")>()),
  getHealthDashboard: vi.fn(),
}));
vi.mock("./api/eos", async (orig) => ({
  ...(await orig<typeof import("./api/eos")>()),
  getEosDashboard: vi.fn(),
}));
vi.mock("./api/security", async (orig) => ({
  ...(await orig<typeof import("./api/security")>()),
  getSecurityDashboard: vi.fn(),
  getGuarddutyDashboard: vi.fn(),
  getTaCheckResources: vi.fn(),
}));

const alarms = await import("./api/alarms");
const notifications = await import("./api/notifications");
const eosApi = await import("./api/eos");
const security = await import("./api/security");
const InvestigationDashboard = (await import("./components/InvestigationDashboard")).default;
const SecurityDashboard = (await import("./components/SecurityDashboard")).default;

// ⚠️ `cleanup()` 显式调用，不依赖 RTL 的自动清理 —— 后者只在 `globals: true` 时注册，
//    本仓库是 false。残留 DOM 会让 `screen.queryByText(...)` 读到上一个用例的节点：
//    用例**照过**，验的却是别的东西。
afterEach(() => { cleanup(); vi.clearAllMocks(); });

/** 告警卡的一份「正常成功」响应 —— 只为让组件过掉 `if (loading)`，好去看别的卡。 */
const ALARM_OK = { ok: true, available: true, overview: { ALARM: 0, OK: 3, INSUFFICIENT_DATA: 0 }, active: [], recent: [] };

beforeEach(() => {
  // 每个 fetcher 都要有默认实现：`vi.fn()` 不给实现时返回 undefined，
  // 组件里的 `.then(...)` 会抛 TypeError —— 那会变成一条与本用例无关的失败。
  vi.mocked(alarms.getAlarmDashboard).mockResolvedValue(ALARM_OK);
  vi.mocked(alarms.getBackupDashboard).mockResolvedValue({ ok: true, available: true, totalJobs: 0, failedCount: 0, vaults: 0, failed: [] });
  vi.mocked(notifications.getHealthDashboard).mockResolvedValue({
    ok: true, available: true,
    serviceIssues: { items: [], moreCount: 0 }, accountIssues: { items: [], moreCount: 0 }, scheduledChanges: { items: [], moreCount: 0 },
  });
  vi.mocked(eosApi.getEosDashboard).mockResolvedValue({ ok: true, available: true, atRisk: 0, total: 0, upcoming: [] });
  vi.mocked(security.getSecurityDashboard).mockResolvedValue({ ok: true });
  vi.mocked(security.getGuarddutyDashboard).mockResolvedValue({ ok: true, available: true, severity: {}, total: 0, top: [] });
});

/** 「加载失败」条在不在。文案是 FailBanner 自己那一段，与各卡的「不可用」不同形状。 */
const failBanner = () => screen.queryByText("加载失败");
/** 界面上任何地方都不许出现这段 message。 */
const expectNoLeak = (needle: string) =>
  expect(document.body.textContent || "").not.toContain(needle);

describe("告警卡：ok:false 是加载失败，不是「当前无告警 ✓」", () => {
  it("http_500 → 画加载失败 + 重试，绝不画绿色的「当前无告警 ✓」", () => {
    render(<InvestigationDashboard dashboardId="alarm-active" data={{ ok: false, reason: "http_500" }} />);
    expect(failBanner()).toBeTruthy();
    expect(screen.getByText(/\(http_500\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
    // 🔴 这一条是整份测试的核心：服务挂掉时说「一切正常」比任何错误提示都危险。
    expect(screen.queryByText("当前无告警 ✓")).toBeNull();
  });

  it("http_500 → 总览卡的 ALARM / OK 计数一个都不画（0 会被读成「真的没有」）", () => {
    render(<InvestigationDashboard dashboardId="alarm-overview" data={{ ok: false, reason: "http_500" }} />);
    expect(failBanner()).toBeTruthy();
    expect(screen.queryByText("ALARM")).toBeNull();
    expect(screen.queryByText("OK")).toBeNull();
  });

  it("反例：available:false 仍画「不可用」，不画加载失败", () => {
    render(<InvestigationDashboard dashboardId="alarm-active" data={{ ok: true, available: false }} />);
    expect(screen.getByText("CloudWatch 告警不可用（无权限或本区域无告警）。")).toBeTruthy();
    expect(failBanner()).toBeNull();
  });

  it("反例：真的 0 条告警仍画绿色的「当前无告警 ✓」", () => {
    render(<InvestigationDashboard dashboardId="alarm-active" data={ALARM_OK} />);
    expect(screen.getByText("当前无告警 ✓")).toBeTruthy();
    expect(failBanner()).toBeNull();
  });

  it("「重试」是真接线的：data 由上层托管时请上层重取（onReload）", () => {
    const onReload = vi.fn();
    render(<InvestigationDashboard dashboardId="alarm-active" data={{ ok: false, reason: "fetch_failed" }} onReload={onReload} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});

describe("Backup 卡：ok:false 不是「你没在用 AWS Backup」", () => {
  it("http_502 → 加载失败，绝不断言客户没接 AWS Backup", async () => {
    vi.mocked(alarms.getBackupDashboard).mockResolvedValue({ ok: false, reason: "http_502" });
    render(<InvestigationDashboard dashboardId="backup" data={ALARM_OK} />);
    await waitFor(() => expect(failBanner()).toBeTruthy());
    expect(screen.queryByText(/未用 AWS Backup/)).toBeNull();
    expect(screen.queryByText("无失败任务 ✓")).toBeNull();
  });

  it("反例：available:false（真的没接）仍画「Backup 数据不可用」", async () => {
    vi.mocked(alarms.getBackupDashboard).mockResolvedValue({ ok: true, available: false, reason: "not_configured" });
    render(<InvestigationDashboard dashboardId="backup" data={ALARM_OK} />);
    await waitFor(() => expect(screen.getByText(/未用 AWS Backup 或无权限/)).toBeTruthy());
    expect(failBanner()).toBeNull();
  });
});

describe("AWS Health 卡：ok:false 不是「需 Business/Enterprise Support」", () => {
  it("http_500 → 加载失败；不许给出「升级支持计划」这条具体且错误的诊断", async () => {
    const leak = "AccessDenied at https://health.us-east-1.amazonaws.com/ for arn:aws:iam::111122223333:role/x";
    vi.mocked(notifications.getHealthDashboard).mockResolvedValue({ ok: false, available: false, reason: "http_500", message: leak });
    render(<InvestigationDashboard dashboardId="health" data={ALARM_OK} />);
    await waitFor(() => expect(failBanner()).toBeTruthy());
    expect(screen.queryByText(/需 Business\/Enterprise Support/)).toBeNull();
    // 不变量：只画我们自己的码，不画 message。
    expect(screen.getByText(/\(http_500\)/)).toBeTruthy();
    expectNoLeak(leak);
  });

  it("反例：subscription_required 仍如实画「需 Business/Enterprise Support」", async () => {
    vi.mocked(notifications.getHealthDashboard).mockResolvedValue({ ok: true, available: false, reason: "subscription_required" });
    render(<InvestigationDashboard dashboardId="health" data={ALARM_OK} />);
    await waitFor(() => expect(screen.getByText(/需 Business\/Enterprise Support/)).toBeTruthy());
    expect(failBanner()).toBeNull();
  });
});

describe("EOL 卡：拉取失败 ≠ 没有 EOL 风险", () => {
  it("http_500 → 加载失败，绝不画「无临近停服的资源 ✓」", async () => {
    const leak = "TypeError: fetch failed https://example.execute-api/prod/investigate/eos";
    vi.mocked(eosApi.getEosDashboard).mockResolvedValue({ ok: false, code: "http_500", upcoming: [] } as never);
    render(<InvestigationDashboard dashboardId="eos" data={ALARM_OK} />);
    await waitFor(() => expect(failBanner()).toBeTruthy());
    expect(screen.queryByText("无临近停服的资源 ✓")).toBeNull();
    expectNoLeak(leak);
  });

  it("「重试」绕服务端缓存重扫（refresh=true），不是只把 UI 刷一遍", async () => {
    vi.mocked(eosApi.getEosDashboard).mockResolvedValue({ ok: false, code: "http_500" });
    render(<InvestigationDashboard dashboardId="eos" data={ALARM_OK} />);
    await waitFor(() => expect(failBanner()).toBeTruthy());
    expect(eosApi.getEosDashboard).toHaveBeenLastCalledWith("", false);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(eosApi.getEosDashboard).toHaveBeenLastCalledWith("", true));
  });

  it("反例：真的没有临近停服资源仍画绿勾", async () => {
    vi.mocked(eosApi.getEosDashboard).mockResolvedValue({ ok: true, available: true, atRisk: 0, total: 5, upcoming: [] });
    render(<InvestigationDashboard dashboardId="eos" data={ALARM_OK} />);
    await waitFor(() => expect(screen.getByText("无临近停服的资源 ✓")).toBeTruthy());
    expect(failBanner()).toBeNull();
  });
});

describe("安全态势：ok:false 整页只画加载失败", () => {
  it("fetch_failed → 不画任何一张卡（每张卡的兜底文案都是关于客户环境的断言）", () => {
    const leak = "boom at https://example.execute-api.us-east-1.amazonaws.com/prod/security/dashboard";
    render(<SecurityDashboard dashboardId="hub-score" data={{ ok: false, code: "fetch_failed", message: leak }} />);
    expect(failBanner()).toBeTruthy();
    expect(screen.queryByText("Security Hub 未开通。")).toBeNull();
    expect(screen.queryByText("不可用")).toBeNull();
    expect(screen.queryByText(/需 Business \/ Enterprise Support 计划/)).toBeNull();
    expectNoLeak(leak);
  });

  it("反例：not_enabled 仍如实画「Security Hub 未开通。」", () => {
    render(<SecurityDashboard dashboardId="hub-score" data={{ ok: true, securityHub: { available: false, reason: "not_enabled" } }} />);
    expect(screen.getByText("Security Hub 未开通。")).toBeTruthy();
    expect(failBanner()).toBeNull();
  });

  it("GuardDuty：http_500 → 加载失败，不画「GuardDuty 未开通。」", async () => {
    vi.mocked(security.getGuarddutyDashboard).mockResolvedValue({ ok: false, reason: "http_500" });
    render(<SecurityDashboard dashboardId="guarddufy-typo-guard" data={{ ok: true }} />);
    // 先证明 guardduty 卡是按 dashboardId 惰性拉的（拼错的 id 不该触发请求）。
    expect(security.getGuarddutyDashboard).not.toHaveBeenCalled();
    cleanup();
    render(<SecurityDashboard dashboardId="guardduty" data={{ ok: true }} />);
    await waitFor(() => expect(failBanner()).toBeTruthy());
    expect(screen.queryByText(/GuardDuty 未开通/)).toBeNull();
  });

  it("「重试」是真接线的（onReload）", () => {
    const onReload = vi.fn();
    render(<SecurityDashboard dashboardId="hub-score" data={{ ok: false, code: "http_500" }} onReload={onReload} />);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
