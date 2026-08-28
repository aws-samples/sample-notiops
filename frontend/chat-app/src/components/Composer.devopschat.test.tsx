/**
 * 「DevOps 对话」在 Composer 里的门控契约。
 *
 * 都是产品**明确指定**的、且改错了不会报错只会显示错的东西：
 *   · 位置：平铺在「联网搜索」**之后**（不是塞进某个菜单，也不是排到深度调查后面）；
 *   · 可见性：**只有故障调查**这一个主题有这个平铺开关。通用会话（新对话）已经改成
 *     落地页上的「对话对象」分段控件（见 ChatObjectPicker.test.tsx），那里**不能**再出现开关 ——
 *     一个页面上两个入口管同一个状态，客户会以为它们是两件事；
 *   · 账号没接入 DevOps Agent 时置灰，并把已经打开的开关自动关掉（否则用户带着一个
 *     必然失败的开关继续发）；
 *   · 开着它时输入框提示语换成"跟 DevOps Agent 对话"：答话的不是 NotiOps；
 *   · 通用会话选中 DevOps Agent 后（objMode）工具栏要瘦身：**联网搜索与模型选择器**不渲染
 *     —— 这条路径由客户自己的 Agent 答，这两样点了都不生效。
 *     `/`（skill）**必须保留**：BFF 会把 skill 正文内联进发给 DevOps Agent 的那段话
 *     （bff/web-chat/devops_skill.mjs），所以它是真生效的，藏掉等于白丢一个能力。
 *     （输入框上方的身份条已按产品要求去掉：锁定后的身份说明只留标题栏的 tag。）
 *   · objMode 下**唯一保留**的开关是「深度调查」（每轮修饰，默认不勾）：勾上这一轮才让
 *     DevOps Agent 发起一次直连深度调查。默认勾上的后果是每句话都要等几分钟。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

let availability: { available: boolean; reason?: string } = { available: true };
vi.mock("../api/chat", () => ({
  getCasesSummary: () => Promise.resolve(null),
  getDeepInvestigationAvailability: () => Promise.resolve(availability),
}));
vi.mock("../api/skills", () => ({
  listSkills: () => Promise.resolve([]),
  skillDisplay: (s: { name: string }) => ({ name: s.name, description: "" }),
  isPresetSkill: () => false,
}));
vi.mock("../models", () => ({
  useModelCatalog: () => ({
    models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5" }],
    defaultModel: "claude-sonnet-5", fromServer: true, loading: false,
    source: "ddb", canSend: true, canSendWithoutModel: true,
  }),
}));

import Composer from "./Composer";
// objMode 的「深度调查」勾选**不能**把对话对象一起灭掉 —— 那段互斥逻辑在 ChatApp 里，
// 类型系统管不到"退回 setDevopsMode('direct')"这种回归，所以做源码级断言（同 deepdive.test.ts）。
import chatAppSrc from "../pages/ChatApp.tsx?raw";

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <Composer model="claude-sonnet-5" onModelChange={() => {}} onSend={() => {}} busy={false}
      showSuggestions={false} topic="investigate" {...props} />,
  );
}

/** 工具栏上按钮的可见文案顺序（模型选择器在右侧，不在这一串里）。 */
const toggleLabels = () =>
  Array.from(document.querySelectorAll("button.websearch-toggle"))
    .map((b) => (b.textContent || "").trim());
/** objMode 里那枚「深度调查」勾选（objMode 下工具栏只剩它，故按文案精确匹配即可）。 */
const deepBtn = () =>
  Array.from(document.querySelectorAll("button.websearch-toggle"))
    .find((b) => (b.textContent || "").trim() === "深度调查") as HTMLButtonElement;

describe("Composer 的「DevOps 对话」开关", () => {
  beforeEach(() => { availability = { available: true }; cleanup(); });

  it("紧跟在「联网搜索」之后（产品指定的平铺位置）", async () => {
    renderComposer();
    await waitFor(() => expect(toggleLabels()).toContain("DevOps 对话"));
    const labels = toggleLabels();
    expect(labels[0]).toBe("联网");        // composer.websearch.short
    expect(labels[1]).toBe("DevOps 对话");
  });

  it("只在故障调查出现；通用会话交给落地页的分段控件，其余主题一律没有", async () => {
    renderComposer({ topic: "investigate" });
    await waitFor(() => expect(toggleLabels()).toContain("DevOps 对话"));
    for (const topic of ["general", "finops", "cases", "security", "whats-new"]) {
      cleanup();
      renderComposer({ topic });
      // 等工具栏渲染完（深度调查探测是异步的），再断言 DevOps 对话不在其中。
      await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
      expect(toggleLabels()).not.toContain("DevOps 对话");
    }
  });

  it("开着它时输入框提示语指向 DevOps Agent，而不是 NotiOps", async () => {
    renderComposer({ devopsChat: true });
    await waitFor(() => expect(toggleLabels()).toContain("DevOps 对话"));
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.placeholder).toContain("DevOps Agent");
    expect(ta.placeholder).not.toContain("NotiOps");
    cleanup();
    renderComposer({ devopsChat: false });
    await waitFor(() => expect(toggleLabels()).toContain("DevOps 对话"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toContain("NotiOps");
  });

  it("账号没接入 DevOps Agent 时置灰，并自动关掉已打开的开关", async () => {
    availability = { available: false, reason: "account_not_onboarded_to_devops_agent" };
    const onToggleDevopsChat = vi.fn();
    renderComposer({ devopsChat: true, onToggleDevopsChat });
    await waitFor(() => expect(onToggleDevopsChat).toHaveBeenCalledTimes(1));
    const btn = Array.from(document.querySelectorAll("button.websearch-toggle"))
      .find((b) => (b.textContent || "").includes("DevOps 对话")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("可用时开关状态如实反映 aria-pressed（前端不传 = 后端行为不变的前提）", async () => {
    renderComposer({ devopsChat: false });
    await waitFor(() => expect(toggleLabels()).toContain("DevOps 对话"));
    const off = Array.from(document.querySelectorAll("button.websearch-toggle"))
      .find((b) => (b.textContent || "").includes("DevOps 对话"))!;
    expect(off.getAttribute("aria-pressed")).toBe("false");
    cleanup();
    renderComposer({ devopsChat: true });
    await waitFor(() => expect(toggleLabels()).toContain("DevOps 对话"));
    const on = Array.from(document.querySelectorAll("button.websearch-toggle"))
      .find((b) => (b.textContent || "").includes("DevOps 对话"))!;
    expect(on.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("通用会话选了 DevOps Agent 之后的 Composer（objMode）", () => {
  beforeEach(() => { availability = { available: true }; cleanup(); });

  it("工具栏瘦身：联网搜索与模型选择器不渲染", async () => {
    renderComposer({ topic: "general", devopsChat: true });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    expect(toggleLabels()).not.toContain("联网");
    expect(document.querySelector(".modelsel")).toBeNull();
  });

  it("`/`（skill）保留且可用 —— 这条路径上 skill 是真生效的（BFF 内联进 DevOps Agent 的输入）", async () => {
    renderComposer({ topic: "general", devopsChat: true });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    const btn = document.querySelector("button.cmd-btn") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    // 点开=进入 "/" 过滤态并弹出命令菜单（不是一个装饰按钮）。
    await waitFor(() => expect(document.querySelector(".cmd-menu")).toBeTruthy());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("/");
  });

  it("同一个主题选回 NotiOps 时联网与模型选择器都回来（瘦身只对 DevOps Agent 生效）", async () => {
    renderComposer({ topic: "general", devopsChat: false });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    expect(document.querySelector("button.cmd-btn")).toBeTruthy();
    expect(toggleLabels()).toContain("联网");
    expect(document.querySelector(".modelsel")).toBeTruthy();
  });

  it("免责声明主语跟着对象换：DevOps Agent 可能出错，而不是 NotiOps", async () => {
    renderComposer({ topic: "general", devopsChat: true });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    const tx = document.querySelector(".chint")?.textContent || "";
    expect(tx).toContain("DevOps Agent");
    expect(tx).not.toContain("NotiOps"); // 张冠李戴：这段对话答话的不是 NotiOps

    cleanup();
    renderComposer({ topic: "general", devopsChat: false });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    expect(document.querySelector(".chint")?.textContent || "").toContain("NotiOps");
  });

  it("保留「深度调查」勾选：默认不勾，点它走 onToggleDevopsAgentDirect", async () => {
    const onToggleDevopsAgentDirect = vi.fn();
    renderComposer({ topic: "general", devopsChat: true, onToggleDevopsAgentDirect });
    await waitFor(() => expect(toggleLabels()).toContain("深度调查"));
    const btn = deepBtn();
    // 默认不勾是产品硬要求：深度调查要跑几分钟，替客户默认选上等于每句话都等几分钟。
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    btn.click();
    expect(onToggleDevopsAgentDirect).toHaveBeenCalledTimes(1);
  });

  it("勾上后如实反映 aria-pressed（这一轮才走深度调查）", async () => {
    renderComposer({ topic: "general", devopsChat: true, devopsAgentDirect: true });
    await waitFor(() => expect(toggleLabels()).toContain("深度调查"));
    expect(deepBtn().getAttribute("aria-pressed")).toBe("true");
  });

  it("对象是 NotiOps 的通用会话里没有这个勾选（那条路径没有直连深度调查）", async () => {
    renderComposer({ topic: "general", devopsChat: false });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    expect(toggleLabels()).not.toContain("深度调查");
  });

  it("故障调查开着 DevOps 对话时**不**瘦身（那里是每轮开关，不是会话对象）", async () => {
    renderComposer({ topic: "investigate", devopsChat: true });
    await waitFor(() => expect(toggleLabels()).toContain("DevOps 对话"));
    expect(document.querySelector("button.cmd-btn")).toBeTruthy();
    expect(document.querySelector(".modelsel")).toBeTruthy();
  });
});

describe("objMode 勾「深度调查」时的互斥（ChatApp 接线，源码级）", () => {
  // 这里是**同一个字段两种语义**的接缝：故障调查主题里 devopsAgentDirect 是三选一之一
  // （点亮它要灭掉 devopsChat），通用会话里它是每轮修饰（绝不能灭 devopsChat）。
  // 写回 setDevopsMode("direct") 是最自然的回归写法，而它的后果是静默的：客户勾一下
  // 「深度调查」，这段对话的对象被悄悄换回 NotiOps 来答（还照常计费），界面只是标题栏
  // tag 变了一下。类型系统对此毫无办法，所以钉源码。
  it("通用会话 + 对象是 DevOps Agent 时只翻 devopsAgentDirect，不清 devopsChat", () => {
    expect(chatAppSrc).toMatch(/if \(devopsChat && \(active\.topic \?\? "general"\) === "general"\) \{/);
    expect(chatAppSrc).toMatch(/devopsAgentDirect: !\(c\.devopsAgentDirect \?\? false\), devopsAgent: false/);
  });

  it("其余主题仍是三选一（setDevopsMode 分支保留）", () => {
    expect(chatAppSrc).toMatch(/setDevopsMode\(devopsAgentDirect \? "off" : "direct"\)/);
  });
});
