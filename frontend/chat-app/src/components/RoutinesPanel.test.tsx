/**
 * 「更多 → 定时任务」页（RoutinesPanel）与定时任务通知卡片的界面契约（2026-10-30）。
 *
 * 钉的都是**做错了不报错、只是让人误操作或看错**的东西：
 *   · 新建框只列**已发布到 DevOps Agent** 的 Skill；目标账号只能在这个 Skill 发布到的账号里选；
 *   · 按频率拼出后端要的 schedule（weekly 带 days、hourly 带 minute、cron 带表达式），时区默认浏览器的；
 *   · 后端回的短码显示成人话（too_frequent → 「两次运行之间至少间隔 1 小时」）；
 *   · 从 Skills 页「定时运行」进来 → 新建框预选那个 Skill；
 *   · 没有管理权限 → 看得到列表、看不到「新建 / 立即运行 / 编辑 / 删除」；
 *   · 「打开会话」只给负责人（会话是按人存的）；
 *   · 定时任务的通知卡片**没有**「深入调查」（那会再发起一次收费的调查），有「查看报告」。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/RoutinesPanel.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { describeSchedule } from "../routineSchedule";

const api = vi.hoisted(() => ({
  listRoutines: vi.fn(), createRoutine: vi.fn(), updateRoutine: vi.fn(), deleteRoutine: vi.fn(),
  toggleRoutine: vi.fn(), runRoutineNow: vi.fn(), listRoutineRuns: vi.fn(),
}));
vi.mock("../api/routines", () => api);
vi.mock("../api/chat", () => ({ getDeepInvestigationAvailability: () => Promise.resolve({ available: true }) }));

import RoutinesPanel from "./RoutinesPanel";

const LIMITS = { max_enabled: 20, max_concurrent: 2, min_interval_minutes: 60, context_max: 2000,
                 run_now_per_hour: 3, max_failures: 3, report_retention_days: 30 };
const SKILLS = [
  { skill_id: "rds-check", name: "RDS 巡检", latest_version: "1.0.2",
    targets: [{ key: "self", account_id: "", uploaded_version: "1.0.2", marker: true },
              { key: "111122223333", account_id: "111122223333", uploaded_version: "1.0.1", marker: true }] },
  { skill_id: "eks-check", name: "EKS 巡检", latest_version: "2.0.0",
    targets: [{ key: "self", account_id: "", uploaded_version: "2.0.0", marker: true }] },
];
const R = (over: Record<string, unknown> = {}) => ({
  id: "rt-1", name: "每天看 RDS", skill_id: "rds-check", skill_name: "RDS 巡检", account_id: "", context: "",
  schedule: { kind: "daily", tz: "Asia/Shanghai", time: "09:00" }, enabled: true, paused_reason: null,
  next_run_at: Date.parse("2026-11-03T01:00:00Z"), active_run: null,
  last_run: { scheduled_at: 1, status: "succeeded", conv_id: "conv-1", finished_at: 2 }, owner_username: "alice", ...over,
});

beforeEach(() => {
  cleanup();
  for (const f of Object.values(api)) f.mockReset();
  api.listRoutines.mockResolvedValue({ ok: true, data: { routines: [R()], switch_on: true, limits: LIMITS, skills: SKILLS } });
  api.createRoutine.mockResolvedValue({ ok: true, data: { routine: R() } });
  api.runRoutineNow.mockResolvedValue({ ok: true, data: { ok: true, started: true } });
  api.listRoutineRuns.mockResolvedValue({ ok: true, data: { runs: [] } });
});

describe("频率的人话描述", () => {
  it("中英文描述；每月最后一天", () => {
    expect(describeSchedule({ kind: "weekly", tz: "UTC", time: "09:00", days: [1, 3] }, false)).toBe("每周周一、周三 09:00");
    expect(describeSchedule({ kind: "weekdays", tz: "UTC", time: "09:00" }, true)).toBe("Weekdays at 09:00");
    expect(describeSchedule({ kind: "monthly", tz: "UTC", time: "08:00", dom: 31 }, false)).toBe("每月最后一天 08:00");
  });
});

describe("定时任务页", () => {
  it("列表：频率、下次运行、上次结果；负责人能「打开会话」", async () => {
    const open = vi.fn();
    render(<RoutinesPanel onOpenConversation={open} currentUsername="alice" canManage />);
    await screen.findByText("每天看 RDS");
    expect(screen.getByText(/每天 09:00 · Asia\/Shanghai/)).toBeTruthy();
    expect(screen.getByText("成功")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开会话" }));
    expect(open).toHaveBeenCalledWith("conv-1");
  });

  it("不是负责人 → 没有「打开会话」；没有管理权限 → 没有新建 / 立即运行 / 编辑 / 删除", async () => {
    render(<RoutinesPanel onOpenConversation={vi.fn()} currentUsername="bob" canManage={false} />);
    await screen.findByText("每天看 RDS");
    expect(screen.queryByRole("button", { name: "打开会话" })).toBeNull();
    expect(screen.queryByRole("button", { name: /新建定时任务/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "立即运行" })).toBeNull();
    expect(screen.queryByTitle("编辑")).toBeNull();
    expect(screen.getByText(/没有管理权限/)).toBeTruthy();
  });

  it("立即运行 → 调接口并说「已发起」；后端回短码 → 人话", async () => {
    render(<RoutinesPanel onOpenConversation={vi.fn()} currentUsername="alice" canManage />);
    await screen.findByText("每天看 RDS");
    fireEvent.click(screen.getByRole("button", { name: "立即运行" }));
    await screen.findByText(/已发起/);
    expect(api.runRoutineNow).toHaveBeenCalledWith("rt-1");
    api.runRoutineNow.mockResolvedValueOnce({ ok: false, error: "run_now_rate_limited" });
    fireEvent.click(screen.getByRole("button", { name: "立即运行" }));
    await screen.findByText(/每小时最多 3 次/);
  });

  it("新建框：只列已发布的 Skill；目标账号只在发布目标里选；按频率拼 schedule；时区默认浏览器的", async () => {
    render(<RoutinesPanel onOpenConversation={vi.fn()} currentUsername="alice" canManage />);
    await screen.findByText("每天看 RDS");
    fireEvent.click(screen.getByRole("button", { name: /新建定时任务/ }));
    const skillSel = await screen.findByLabelText("Skill") as HTMLSelectElement;
    expect([...skillSel.options].map((o) => o.value)).toEqual(["", "rds-check", "eks-check"]);
    fireEvent.change(skillSel, { target: { value: "rds-check" } });
    const acct = screen.getByLabelText("目标账号") as HTMLSelectElement;
    expect([...acct.options].map((o) => o.value)).toEqual(["", "111122223333"]);
    fireEvent.change(acct, { target: { value: "111122223333" } });
    expect(screen.getByText(/Agent Space 里装的是 v1\.0\.1/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/每天早上看 prod/), { target: { value: "周会前看 RDS" } });
    fireEvent.change(screen.getByLabelText("频率"), { target: { value: "weekly" } });
    fireEvent.click(screen.getByRole("button", { name: "三" }));
    // 成本预估已按用户要求去掉（2026-10-30）：新建框里不出现金额 / 「预估」
    expect(document.body.textContent).not.toMatch(/预估|\$\s?\d/);
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(api.createRoutine).toHaveBeenCalled());
    const input = api.createRoutine.mock.calls[0][0];
    expect(input).toMatchObject({ name: "周会前看 RDS", skill_id: "rds-check", account_id: "111122223333" });
    expect(input.schedule).toMatchObject({ kind: "weekly", time: "09:00", days: [1, 3] });
    expect(input.schedule.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  });

  it("保存被拒 → 显示人话（too_frequent），框不关", async () => {
    api.createRoutine.mockResolvedValueOnce({ ok: false, error: "too_frequent" });
    render(<RoutinesPanel onOpenConversation={vi.fn()} currentUsername="alice" canManage />);
    await screen.findByText("每天看 RDS");
    fireEvent.click(screen.getByRole("button", { name: /新建定时任务/ }));
    fireEvent.change(await screen.findByLabelText("Skill"), { target: { value: "eks-check" } });
    fireEvent.change(screen.getByPlaceholderText(/每天早上看 prod/), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("频率"), { target: { value: "cron" } });
    fireEvent.change(screen.getByLabelText("cron 表达式"), { target: { value: "*/10 * * * *" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect((await screen.findByRole("alert")).textContent).toContain("至少间隔 1 小时");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("从 Skills 页「定时运行」进来 → 新建框预选那个 Skill", async () => {
    render(<RoutinesPanel prefill={{ skillId: "eks-check", n: 1 }} onOpenConversation={vi.fn()} currentUsername="alice" canManage />);
    const sel = await screen.findByLabelText("Skill") as HTMLSelectElement;
    expect(sel.value).toBe("eks-check");
  });

  it("没有已发布的 Skill → 新建框明说去哪发布", async () => {
    api.listRoutines.mockResolvedValue({ ok: true, data: { routines: [], switch_on: true, limits: LIMITS, skills: [] } });
    render(<RoutinesPanel onOpenConversation={vi.fn()} currentUsername="alice" canManage />);
    await screen.findByText(/还没有定时任务/);
    fireEvent.click(screen.getByRole("button", { name: /新建定时任务/ }));
    expect(await screen.findByText(/还没有发布到 DevOps Agent 的 Skill/)).toBeTruthy();
  });

  it("总开关关着 → 页面顶上写明", async () => {
    api.listRoutines.mockResolvedValue({ ok: true, data: { routines: [R()], switch_on: false, limits: LIMITS, skills: SKILLS } });
    render(<RoutinesPanel onOpenConversation={vi.fn()} currentUsername="alice" canManage />);
    expect(await screen.findByText(/总开关已关闭/)).toBeTruthy();
  });
});
