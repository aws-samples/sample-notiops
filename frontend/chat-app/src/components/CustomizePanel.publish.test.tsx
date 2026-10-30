/**
 * 「发布到 DevOps Agent」对话框如实反映 Agent Space 里的真实状态（2026-10-30）。
 *
 * 钉的都是**界面上看不出来、却会让后面的功能空转**的情形：
 *   · Agent Space 里装的不是最新版 → 写明「里面是 vX，最新是 vY」，「重新发布」变成主按钮；
 *   · 在 DevOps Agent 控制台里被删了 → 不再显示「已发布」，写明原因，回到「发布」按钮；
 *   · 旧版本发布、没带触发标记（NOTIOPS_SKILL:<id>）→ 提示重新发布一次（深度调查引用、定时任务都靠它选中）；
 *   · 卡片上：有目标装的不是最新版 → 「已发布」药丸带提示。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/CustomizePanel.publish.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

type Up = { asset_id: string; agent_space_id: string; scope: string; account_id: string; uploaded_version?: string; marker?: boolean };
let SKILL: { skill_id: string; name: string; description: string; author: string; latest_version: string;
             devops_agent: { uploads: Record<string, Up> } };
let STATUS: { latest_version: string; statuses: Record<string, Record<string, unknown>> } | null = null;

const api = vi.hoisted(() => ({
  listSkills: vi.fn(), listDevopsTargets: vi.fn(), getSkillDevopsStatus: vi.fn(),
}));
vi.mock("../api/skills", async (orig) => {
  const real = await orig<typeof import("../api/skills")>();
  return {
    ...real,
    listSkills: api.listSkills,
    listDevopsTargets: api.listDevopsTargets,
    getSkillDevopsStatus: api.getSkillDevopsStatus,
    uploadSkillToDevops: vi.fn(() => Promise.resolve({ ok: true, assetId: "a-2", agentSpaceId: "sp-self" })),
    removeSkillFromDevops: vi.fn(() => Promise.resolve()),
  };
});

import CustomizePanel from "./CustomizePanel";

const up = (over: Partial<Up> = {}): Up => ({
  asset_id: "a-1", agent_space_id: "sp-self", scope: "self", account_id: "111122223333", uploaded_version: "1.0.2", ...over,
});

beforeEach(() => {
  cleanup();
  SKILL = { skill_id: "rds-check", name: "RDS 巡检", description: "查 RDS", author: "me", latest_version: "1.0.2",
            devops_agent: { uploads: { self: up({ marker: true }) } } };
  STATUS = null;
  api.listSkills.mockImplementation(() => Promise.resolve([SKILL]));
  api.listDevopsTargets.mockImplementation(() => Promise.resolve([
    { account_id: "111122223333", agent_space_id: "sp-self", scope: "self", label: "本账号 (This account)" }]));
  api.getSkillDevopsStatus.mockImplementation(() => Promise.resolve(STATUS));
});

async function openPublish() {
  render(<CustomizePanel only="skills" />);
  await screen.findByText("RDS 巡检");
  fireEvent.click(document.querySelector(".cz-da-btn") as HTMLElement);
  await screen.findByText(/本账号 \(This account\)/);
}

describe("发布对话框：按 Agent Space 的真实状态说话", () => {
  it("装的是旧版本 → 写明两边的版本号，「重新发布」是主按钮；卡片药丸带提示", async () => {
    SKILL.devops_agent.uploads.self = up({ uploaded_version: "1.0.0", marker: true });
    STATUS = { latest_version: "1.0.2", statuses: { self: { published: true, uploaded_version: "1.0.0", stale: true, marker: true } } };
    render(<CustomizePanel only="skills" />);
    await screen.findByText("RDS 巡检");
    expect(document.querySelector(".cz-skill-pub.stale")).not.toBeNull();
    fireEvent.click(document.querySelector(".cz-da-btn") as HTMLElement);
    expect(await screen.findByText(/v1\.0\.0.*v1\.0\.2|v1\.0\.0[\s\S]*v1\.0\.2/)).toBeTruthy();
    const btn = screen.getByRole("button", { name: /重新发布|Re-publish/ });
    expect(btn.className).toContain("cz-btn-primary");
  });

  it("在控制台被删了 → 不再显示「已发布」，写明原因，回到「发布」按钮", async () => {
    STATUS = { latest_version: "1.0.2", statuses: { self: { published: false, reason: "asset_missing" } } };
    await openPublish();
    expect(await screen.findByText(/已经没有这份了|No longer in this Agent Space/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /重新发布|Re-publish/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^发布$|^Publish$/ })).toBeTruthy();
  });

  it("旧版本发布、没带触发标记 → 回查确认还在之后，提示重新发布一次", async () => {
    SKILL.devops_agent.uploads.self = up({ marker: undefined });
    STATUS = { latest_version: "1.0.2", statuses: { self: { published: true, uploaded_version: "1.0.2", stale: false } } };
    await openPublish();
    expect(await screen.findByText(/没有带触发标记|without the trigger marker/)).toBeTruthy();
  });

  it("最新版、带标记、确认还在 → 不多说一句", async () => {
    STATUS = { latest_version: "1.0.2", statuses: { self: { published: true, uploaded_version: "1.0.2", stale: false, marker: true } } };
    await openPublish();
    await screen.findByText(/已发布 · v1\.0\.2|Published · v1\.0\.2/);
    expect(document.querySelector(".cz-pub-note")).toBeNull();
    expect(document.querySelector(".cz-skill-pub.stale")).toBeNull();
  });
});
