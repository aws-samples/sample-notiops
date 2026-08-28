/**
 * "/" 命令菜单（skill 选择器）与「谁来执行这个 skill」的界面契约。
 *
 * 钉的都是**改错了不报错、只是显示错**的东西：
 *   · 输入 "/" 要列出**全部** skill，条数写在表头。旧版是随机 3 个 + 「输入以筛选」，
 *     客户有 12 个 skill 也只看见 3 个、且每次展开都在换 —— 看起来像"我就这么点能力"；
 *   · 过滤层也不截断（旧版 slice(0,8) 会把第 9 个匹配静默藏掉）；
 *   · 打到没匹配时菜单**不消失**，如实说"没有匹配的 Skill"（消失会被读成"我打错字了"）；
 *   · ↑/↓ + Enter 能选中高亮那一行 —— 列表几十行且要滚，"Enter=第一个匹配"不够用；
 *   · 芯片上的「DevOps Agent」标记 = 这一轮**谁在执行这个 skill**，所以三条交给客户自己
 *     DevOps Agent 的路径都要打上（深度调查 / 深度调查（直连）/ DevOps 对话）。
 *     以前只认第一条，勾了「深度调查（直连）」的客户在界面上看不出 skill 会被交出去；
 *   · 未发布提示分两句：转交路径（深度调查）说"不会被激活、请先发布"；两条**直连**路径
 *     说"正文会内联过去、无需发布，只有 references/ 取不到" —— 后者套用前一句是在说
 *     一件不成立的事（BFF 明确内联了正文，见 bff/web-chat/devops_skill.mjs）。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

vi.mock("../api/chat", () => ({
  getCasesSummary: () => Promise.resolve(null),
  getDeepInvestigationAvailability: () => Promise.resolve({ available: true }),
}));

type FakeSkill = {
  skill_id: string; name: string; description: string; author?: string;
  devops_agent?: { uploads?: Record<string, unknown> };
};
/** 12 个：既超过旧版的 3（抽样）也超过旧版的 8（截断上限），两处回归都能被这一份数据抓到。 */
let SKILLS: FakeSkill[] = [];
const mkSkills = (n: number): FakeSkill[] =>
  Array.from({ length: n }, (_, i) => ({
    skill_id: `skill-${i}`, name: `技能 ${i}`, description: `描述 ${i}`, author: "me",
  }));

vi.mock("../api/skills", () => ({
  listSkills: () => Promise.resolve(SKILLS),
  skillDisplay: (s: FakeSkill) => ({ name: s.name, description: s.description }),
  isPresetSkill: (s: FakeSkill) => s.author === "notiops-system",
}));
vi.mock("../models", () => ({
  useModelCatalog: () => ({
    models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
    defaultModel: "claude-sonnet-5", fromServer: true, loading: false,
    source: "ddb", canSend: true, canSendWithoutModel: true,
  }),
}));

import Composer from "./Composer";

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <Composer model="claude-sonnet-5" onModelChange={() => {}} onSend={() => {}} busy={false}
      showSuggestions={false} topic="investigate" {...props} />,
  );
}

const ta = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(ta(), { target: { value: v } });
const rows = () => Array.from(document.querySelectorAll(".cmd-list .skill-mi"));
const head = () => document.querySelector(".cmd-head-title")?.textContent || "";

describe('"/" 命令菜单：列全部 + 可滚动', () => {
  beforeEach(() => { SKILLS = mkSkills(12); cleanup(); });

  it("输入 / 列出全部 skill（不抽样、不截断），表头写出真实条数", async () => {
    renderComposer();
    await waitFor(() => expect(ta()).toBeTruthy());
    type("/");
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    expect(rows()).toHaveLength(12);
    expect(head()).toBe("技能 (12)");
    // 滚动容器必须存在：这是"只藏像素、不藏能力"的实现前提。
    expect(document.querySelector(".cmd-list")).toBeTruthy();
  });

  it("过滤层同样不截断，条数跟着筛选结果走", async () => {
    SKILLS = mkSkills(12);
    renderComposer();
    await waitFor(() => expect(ta()).toBeTruthy());
    type("/skill-1");           // skill-1 / skill-10 / skill-11 → 3 个
    await waitFor(() => expect(rows().length).toBe(3));
    expect(head()).toBe("技能 (3)");
  });

  it("打到没匹配时菜单还在，并如实说明是没匹配（不是静默消失）", async () => {
    renderComposer();
    await waitFor(() => expect(ta()).toBeTruthy());
    type("/zzzz");
    await waitFor(() => expect(document.querySelector(".cmd-menu")).toBeTruthy());
    expect(document.querySelector(".cmd-empty")?.textContent).toBe("没有匹配的 Skill");
  });

  it("一个 skill 都没有时说「还没有 Skill」，且管理/新建两个出口仍在", async () => {
    SKILLS = [];
    renderComposer();
    await waitFor(() => expect(ta()).toBeTruthy());
    type("/");
    await waitFor(() => expect(document.querySelector(".cmd-empty")).toBeTruthy());
    expect(document.querySelector(".cmd-empty")?.textContent).toBe("还没有 Skill");
    const outs = Array.from(document.querySelectorAll(".cmd-mi-name")).map((e) => e.textContent);
    expect(outs).toContain("管理 Skills");
    expect(outs).toContain("新建 Skill");
  });

  it("↓ 移动高亮、Enter 选中高亮那一行（不是永远选第一个）", async () => {
    renderComposer();
    await waitFor(() => expect(ta()).toBeTruthy());
    type("/");
    await waitFor(() => expect(rows().length).toBe(12));
    expect(rows()[0].className).toContain("active");
    fireEvent.keyDown(ta(), { key: "ArrowDown" });
    await waitFor(() => expect(rows()[1].className).toContain("active"));
    fireEvent.keyDown(ta(), { key: "Enter" });
    // 选中即挂芯片，输入框换成可直接发送的预填文字（"/xxx" 那串命令不会被发出去）。
    await waitFor(() => expect(document.querySelector(".skill-active")).toBeTruthy());
    expect(document.querySelector(".skill-active")?.textContent).toContain("技能 1");
    expect(ta().value).toBe("使用 Skill「技能 1」");
  });

  it("Esc 关掉菜单（留着输入的文字，不误清）", async () => {
    renderComposer();
    await waitFor(() => expect(ta()).toBeTruthy());
    type("/");
    await waitFor(() => expect(document.querySelector(".cmd-menu")).toBeTruthy());
    fireEvent.keyDown(ta(), { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".cmd-menu")).toBeNull());
    expect(ta().value).toBe("/");
  });
});

describe("激活芯片：这一轮谁来执行这个 skill", () => {
  beforeEach(() => { SKILLS = mkSkills(3); cleanup(); });

  /** 选中第一个 skill（点行），返回芯片元素。 */
  async function pickFirst() {
    await waitFor(() => expect(ta()).toBeTruthy());
    type("/");
    await waitFor(() => expect(rows().length).toBe(3));
    fireEvent.click(rows()[0]);
    await waitFor(() => expect(document.querySelector(".skill-active")).toBeTruthy());
    return document.querySelector(".skill-active") as HTMLElement;
  }

  it("三条交给 DevOps Agent 的路径都打「DevOps Agent」标记", async () => {
    for (const flag of ["devopsAgent", "devopsAgentDirect", "devopsChat"] as const) {
      cleanup();
      renderComposer({ [flag]: true });
      const chip = await pickFirst();
      expect(chip.querySelector(".skill-active-mode")?.textContent, flag).toContain("DevOps Agent");
    }
  });

  it("三个都关时不打标记（那一轮是我们的 agent 在执行）", async () => {
    renderComposer();
    const chip = await pickFirst();
    expect(chip.querySelector(".skill-active-mode")).toBeNull();
  });

  it("未发布 + 深度调查（转交）→ 说「不会被激活、请先发布」", async () => {
    renderComposer({ devopsAgent: true });
    await pickFirst();
    const tx = document.querySelector(".skill-needs-devops")?.textContent || "";
    expect(tx).toContain("尚未发布");
    expect(tx).toContain("不会被激活");
  });

  it("未发布 + 直连路径 → 说「正文内联、无需发布」，不说「不会被激活」", async () => {
    for (const flag of ["devopsAgentDirect", "devopsChat"] as const) {
      cleanup();
      renderComposer({ [flag]: true });
      await pickFirst();
      const tx = document.querySelector(".skill-needs-devops")?.textContent || "";
      expect(tx, flag).toContain("无需发布");
      expect(tx, flag).not.toContain("不会被激活");
    }
  });

  it("已发布到 Agent Space 的 skill 不再提示（那边有完整一份）", async () => {
    SKILLS = [{ skill_id: "s0", name: "技能 0", description: "描述 0", author: "me",
      devops_agent: { uploads: { "space-1": { asset_id: "a" } } } }];
    renderComposer({ devopsAgent: true });
    await waitFor(() => expect(ta()).toBeTruthy());
    type("/");
    await waitFor(() => expect(rows().length).toBe(1));
    fireEvent.click(rows()[0]);
    await waitFor(() => expect(document.querySelector(".skill-active")).toBeTruthy());
    expect(document.querySelector(".skill-needs-devops")).toBeNull();
  });
});
