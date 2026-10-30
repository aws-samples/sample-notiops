/**
 * 定时任务写的通知（kind="routine"）在收件箱卡片上的样子（2026-10-30）：
 *   · **没有**「深入调查」—— 那会拿这条通知再发起一次收费的 DevOps Agent 调查，而结果已经有了；
 *   · 有「查看报告」（报告保留 30 天）；
 *   · 「打开会话」只给负责人（会话按人存，别人点了也打不开）；
 *   · 来源显示成「NotiOps 定时任务」，而不是英文的原始 source。
 * 其它来源的卡片不受影响（照旧有「深入调查」）。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/InboxList.routine.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const items = [
  { id: "evt#1", ts: Date.now(), source: "NotiOps Scheduled task", title: "定时任务完成：每天看 RDS", severity: "info",
    description: "RDS 连接数正常", read: false, kind: "routine", reportUrl: "https://cdn.example/routine-reports/rt-1/r.html",
    convId: "conv-9", owner: "alice", routineId: "rt-1" },
  { id: "evt#2", ts: Date.now() - 1000, source: "CloudWatch Alarm", title: "CPU 高", severity: "warn", read: false },
];
vi.mock("../api/notifications", () => ({
  listNotifications: () => Promise.resolve({ ok: true, items, lastReadTs: 0 }),
  markRead: () => Promise.resolve(),
}));

import InboxList from "./InboxList";

beforeEach(() => cleanup());

describe("定时任务通知卡片", () => {
  it("负责人：查看报告 + 打开会话，没有深入调查；其它来源照旧", async () => {
    const open = vi.fn(), inv = vi.fn();
    render(<InboxList onInvestigate={inv} onAsk={vi.fn()} onOpenConversation={open} currentUsername="alice" />);
    await screen.findByText("定时任务完成：每天看 RDS");
    expect(screen.getByText("NotiOps 定时任务")).toBeTruthy();
    const report = screen.getByRole("link", { name: /查看报告/ }) as HTMLAnchorElement;
    expect(report.href).toContain("routine-reports/rt-1/");
    fireEvent.click(screen.getByRole("button", { name: "打开会话" }));
    expect(open).toHaveBeenCalledWith("conv-9");
    // 只有那条 CloudWatch 告警还有「深入调查」
    expect(screen.getAllByRole("button", { name: /深入调查/ })).toHaveLength(1);
  });

  it("不是负责人：没有打开会话（会话打不开），报告照样能看", async () => {
    render(<InboxList onInvestigate={vi.fn()} onAsk={vi.fn()} onOpenConversation={vi.fn()} currentUsername="bob" />);
    await screen.findByText("定时任务完成：每天看 RDS");
    expect(screen.queryByRole("button", { name: "打开会话" })).toBeNull();
    expect(screen.getByRole("link", { name: /查看报告/ })).toBeTruthy();
  });
});
