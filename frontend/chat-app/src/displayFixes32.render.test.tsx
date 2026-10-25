/**
 * 待办 #32 里核实为真的三处网页显示问题（2026-10-19 讲解 deck 改版时读源码发现，10-23 修）：
 *
 *   ② 等待行「……」：进度文字自带「…」，后面又跟着会动的 `.tk-dots`（单元判据在 thinking.test.ts，
 *      这里钉渲染出来的那一行）；
 *   ⑥ 侧栏主题没有选中态：Sidebar.tsx 一直给当前项加 `active`，styles.css 却没有 `.navitem.active`；
 *   ⑦ 成本「支出概览」里 Marketplace 卡与 Top 5 卡贴在一起：两张卡在两个 grid 里，gap 管不到容器之间。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/displayFixes32.render.test.tsx
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage } from "./types";

vi.mock("./api/finops", async (orig) => ({
  ...(await orig<typeof import("./api/finops")>()),
  getFinopsDashboard: vi.fn(),
  getFinopsTagKeys: vi.fn(),
}));
const finops = await import("./api/finops");
const FinopsDashboard = (await import("./components/FinopsDashboard")).default;
const Message = (await import("./components/Message")).default;

// ⚠️ 显式 cleanup —— RTL 自动清理只在 `globals: true` 时注册，本仓库是 false。
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const CSS = readFileSync(join(process.cwd(), "src", "styles.css"), "utf8");

describe("⑥ 侧栏当前主题有选中态", () => {
  it("styles.css 里有 `.navitem.active`，而且真的改了底色（不只是 expanded 那条的字色）", () => {
    const rule = /\.navitem\.active\s*\{([^}]*)\}/.exec(CSS);
    expect(rule, ".navitem.active 规则不见了").toBeTruthy();
    expect(rule![1]).toMatch(/background:\s*var\(--sidebar-hover\)/);
  });
});

describe("⑦ Marketplace 卡与 Top 5 卡之间有间距", () => {
  it("Top 5 那个 grid 带 marginTop（两个 grid 之间 gap 不起作用）", async () => {
    vi.mocked(finops.getFinopsDashboard).mockResolvedValue({
      budgetAlerts: { available: false, budgets: [] },
      curStatus: { status: "not_configured" as const },
      devOpsAgentCost: { available: false, reason: "cur_not_ready" },
      costExplorer: {
        spendTrend: { available: false }, marketplace: { available: false }, support: { available: false },
        movers: { available: false }, forecast: { available: false }, topServices: { available: false },
        anomalies: { available: false }, coverage: { available: false },
      },
    } as never);
    render(<FinopsDashboard dashboardId="spend" can={() => true} />);
    await screen.findByText("Top 5 服务 · 本月");
    await waitFor(() => {
      const grid = document.querySelector<HTMLElement>("[data-testid='finops-top5-grid']");
      expect(grid?.style.marginTop).toBe("14px");
    });
    // Marketplace 卡也在：两张卡确实是上下相邻的两个容器
    expect(screen.getByText("Marketplace 支出")).toBeTruthy();
  });
});

describe("② 等待行只有一个省略号", () => {
  const base: ChatMessage = { id: "m1", role: "assistant", text: "", ts: 1_700_000_000_000 };
  const waitingLine = () => document.querySelector(".thinking .tk-dots")?.parentElement?.textContent ?? "";

  it("进度文字自带「…」时去掉，留给后面那个会动的 `.tk-dots`", () => {
    render(<Message m={{ ...base, thinking: true, progress: "DevOps Agent 正在思考…" } as ChatMessage}
                    onOpenSources={() => {}} onOpenThinking={() => {}} />);
    expect(waitingLine()).toBe("DevOps Agent 正在思考");
    expect(document.querySelector(".thinking .tk-dots")).toBeTruthy();
  });

  it("没有进度时照旧显示「思考中」", () => {
    render(<Message m={{ ...base, thinking: true } as ChatMessage} onOpenSources={() => {}} onOpenThinking={() => {}} />);
    expect(waitingLine()).toBe("思考中");
  });
});
