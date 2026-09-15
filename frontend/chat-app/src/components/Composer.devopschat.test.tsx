/**
 * 工具条上「谁来答这一轮」那一小排开关在 Composer 里的门控契约。
 *
 * 🔁 2026-09-13 整份重写：产品把「回答模式」下拉拆回**平铺 pill**，同时撤掉「深度调查
 * （转交）」与成本主题那项永久置灰的「FinOps」，并把「联网」改成只留图标。上一版这份测试
 * 钉的全是下拉的结构（`.modepick` / `.modemenu` / `role=option` / 「不启用」那一项），
 * 那些 DOM 现在一个都不存在了 —— 所以是重写而不是改几行断言。理由与四件事的清单见
 * ModePicker.tsx 的文件头。
 *
 * 都是产品**明确指定**的、且改错了不会报错只会显示错的东西：
 *   · 形态：**平铺 pill**，一个主题最多两枚（DevOps 对话 / 深度调查）。它们在状态上是
 *     单选（ChatApp 的 setDevopsMode 一次写四个字段），但两枚以内平铺不会让人误以为
 *     能同时开，反而省掉一层点击；
 *   · 位置：紧跟在「联网」**之后**（不是塞进 `/` 菜单，也不是排到右侧）；
 *   · 「联网」**只有图标没有文字** —— 因此它必须带 `aria-label`，否则读屏软件念到的是
 *     一个空按钮。这一条用 DOM 断言钉住（视觉上看不出来）；
 *   · 界面上只剩**一个**「深度调查」，点它走 `onToggleDevopsAgentDirect`（直连、0 token）。
 *     以前还有一枚同名的"经我们的 agent 转交"（`onToggleDevopsAgent`）—— 那一枚已撤掉，
 *     这里**反向断言**它不会再被调用：留两个入口，客户没有依据去选，选错只是更慢更贵；
 *   · 成本主题**没有**「FinOps」那一项（永久置灰的占位已删）；
 *   · 「DevOps 对话」这一项**只有故障调查**这一个主题有。通用会话（新对话）已经改成落地页
 *     上的「对话对象」分段控件（见 ChatObjectPicker.test.tsx），那里**不能**再出现它 ——
 *     一个页面上两个入口管同一个状态，客户会以为它们是两件事；
 *   · 默认全关：所有模式默认关（关着时前端不传对应字段，后端行为逐字节不变）；
 *   · 账号没接入 DevOps Agent 时置灰**并写出原因**（tooltip + 「未接入」徽标），同时把已经
 *     打开的开关自动关掉（否则用户带着一个必然失败的开关继续发）；
 *   · 开着「DevOps 对话」时输入框提示语换成"跟 DevOps Agent 对话"：答话的不是 NotiOps；
 *   · 通用会话选中 DevOps Agent 后（objMode）工具栏要瘦身：**联网与模型选择器**不渲染
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

/** 「联网」那一枚：**只有图标**，所以按 class 取而不是按文字（它没有文字）。 */
const webBtn = () =>
  document.querySelector("button.websearch-toggle.icon-only") as HTMLButtonElement | null;
/** 带文字的那些 pill 的可见文案，按 DOM 顺序（= 模式 pill，以及 objMode 下那枚「深度调查」）。
 *  刻意排掉 `.icon-only`：联网那一枚没有文字，混进来会变成一个空串项，让每条断言都要带上它。 */
const pillLabels = () =>
  Array.from(document.querySelectorAll("button.websearch-toggle:not(.icon-only)"))
    .map((b) => (b.textContent || "").trim());
/** 按可见文案取一枚 pill。置灰时项名后面还挂着「未接入」徽标，所以用前缀匹配。 */
const pill = (name: string) =>
  Array.from(document.querySelectorAll("button.websearch-toggle:not(.icon-only)"))
    .find((b) => (b.textContent || "").trim().startsWith(name)) as HTMLButtonElement | undefined;

describe("Composer 工具条上的「DevOps 对话 / 深度调查」（平铺 pill）", () => {
  beforeEach(() => { availability = { available: true }; cleanup(); });

  it("紧跟在「联网」之后平铺；不再有任何下拉", async () => {
    renderComposer();
    await waitFor(() => expect(pill("深度调查")).toBeTruthy());
    // 故障调查主题就这两项（顺序也是产品指定：先"直接问答"，再"发起调查"）。
    expect(pillLabels()).toEqual(["DevOps 对话", "深度调查"]);
    // 🔴 下拉整体退役：`.modepick` 出现就说明有人把它加回来了，而两枚 pill 藏进一个
    //    要点开的下拉是纯负收益（多一层点击、不省宽度）。
    expect(document.querySelector(".modepick")).toBeNull();
    expect(document.querySelector(".modemenu")).toBeNull();
    // DOM 顺序：联网（图标）→ DevOps 对话 → 深度调查。
    const bar = document.querySelector(".cbar")!;
    const order = Array.from(bar.querySelectorAll("button.websearch-toggle"));
    expect(order[0].className).toContain("icon-only");
    expect((order[1].textContent || "").trim()).toBe("DevOps 对话");
    expect((order[2].textContent || "").trim()).toBe("深度调查");
  });

  it("「联网」只留图标 —— 因此必须有 aria-label（读屏软件唯一能念的那句）", async () => {
    renderComposer();
    await waitFor(() => expect(webBtn()).toBeTruthy());
    const b = webBtn()!;
    // 产品要求：去掉「联网」这两个字，只留地球仪。
    expect((b.textContent || "").trim()).toBe("");
    expect(b.querySelector("svg")).toBeTruthy();
    // 没有文字的按钮如果连 aria-label 都没有，读屏软件念出来就是个空按钮。
    expect(b.getAttribute("aria-label")).toBe("联网搜索");
    // tooltip 仍然要把完整那句给到（鼠标用户看这个）。
    expect(b.getAttribute("title") || "").toContain("联网搜索");
  });

  it("界面上只有**一个**「深度调查」，点它走直连（转交那一枚已撤掉）", async () => {
    const onToggleDevopsAgent = vi.fn();
    const onToggleDevopsAgentDirect = vi.fn();
    renderComposer({ topic: "investigate", onToggleDevopsAgent, onToggleDevopsAgentDirect });
    await waitFor(() => expect(pill("深度调查")).toBeTruthy());
    // 同名两枚 = 客户没有依据去选，而选错的那一枚只是更慢更贵。
    expect(pillLabels().filter((s) => s.startsWith("深度调查"))).toHaveLength(1);
    pill("深度调查")!.click();
    expect(onToggleDevopsAgentDirect).toHaveBeenCalledTimes(1);
    // 🔴 反向断言：撤掉的是**界面入口**，字段与 BFF 那条链路都还活着 —— 一旦有人把
    //    这枚 pill 接回 onToggleDevopsAgent，客户会拿到一条先烧 token 再转交的慢路径。
    expect(onToggleDevopsAgent).not.toHaveBeenCalled();
  });

  it("「DevOps 对话」只在故障调查出现；其余主题只剩深度调查，三个排除主题一枚都没有", async () => {
    renderComposer({ topic: "investigate" });
    await waitFor(() => expect(pillLabels()).toContain("DevOps 对话"));

    // 还提供深度调查、但没有「DevOps 对话」的主题。
    // 2026-09-11 起这里只剩 finops —— 原来还列了 "security"，而「安全」已经不是聊天主题
    // （并入 investigate，只留看板入口），拿它当用例等于在钉一段**产品里不存在**的行为；
    // 真要覆盖"未知主题"的回落，看 types.normalizeTopic 的测试。
    for (const topic of ["finops"]) {
      cleanup();
      renderComposer({ topic });
      // 等工具栏渲染完（深度调查探测是异步的），再断言。
      await waitFor(() => expect(pill("深度调查")).toBeTruthy());
      expect(pillLabels()).toEqual(["深度调查"]);
    }
    // 一个模式都没有的主题（general 不给入口；cases 是 Case 生命周期管理、whats-new 与用户
    // 环境无关，两者都被 DEVOPS_TOPICS_EXCLUDED 排除）→ 一枚都不渲染。
    for (const topic of ["general", "cases", "whats-new"]) {
      cleanup();
      renderComposer({ topic });
      await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
      expect(pillLabels(), `${topic} 不该有任何模式 pill`).toEqual([]);
    }
  });

  it("成本主题里没有「FinOps」那一项（永久置灰的占位已删）", async () => {
    renderComposer({ topic: "finops" });
    await waitFor(() => expect(pill("深度调查")).toBeTruthy());
    // 一个永远点不动的项，除了让客户点一下发现点不动之外没有别的作用。
    expect(pillLabels().some((n) => n.startsWith("FinOps"))).toBe(false);
    // 顺带钉住"永久置灰"这类占位不许再出现在这一排里。
    expect(document.querySelector("button.websearch-toggle:not(.icon-only)[disabled]")).toBeNull();
  });

  it("默认全关 —— 两种模式都不许替客户预先打开", async () => {
    renderComposer({ topic: "investigate" });
    await waitFor(() => expect(pill("深度调查")).toBeTruthy());
    for (const name of ["DevOps 对话", "深度调查"]) {
      expect(pill(name)!.getAttribute("aria-pressed"), name).toBe("false");
      expect(pill(name)!.className).not.toContain(" on");
    }
  });

  it("点「DevOps 对话」走 onToggleDevopsChat（互斥仍由 ChatApp 保证）", async () => {
    const onToggleDevopsChat = vi.fn();
    renderComposer({ topic: "investigate", onToggleDevopsChat });
    await waitFor(() => expect(pill("DevOps 对话")).toBeTruthy());
    pill("DevOps 对话")!.click();
    expect(onToggleDevopsChat).toHaveBeenCalledTimes(1);
  });

  it("开着它时输入框提示语指向 DevOps Agent，而不是 NotiOps", async () => {
    renderComposer({ devopsChat: true });
    await waitFor(() => expect(pill("DevOps 对话")).toBeTruthy());
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.placeholder).toContain("DevOps Agent");
    expect(ta.placeholder).not.toContain("NotiOps");
    cleanup();
    renderComposer({ devopsChat: false });
    await waitFor(() => expect(pill("DevOps 对话")).toBeTruthy());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).placeholder).toContain("NotiOps");
  });

  it("账号没接入 DevOps Agent 时置灰**并写出原因**，同时自动关掉已打开的开关", async () => {
    availability = { available: false, reason: "account_not_onboarded_to_devops_agent" };
    const onToggleDevopsChat = vi.fn();
    renderComposer({ devopsChat: true, onToggleDevopsChat });
    await waitFor(() => expect(onToggleDevopsChat).toHaveBeenCalledTimes(1));
    // 两项都靠同一个 Agent Space，所以两项一起置灰（不只「DevOps 对话」）。
    for (const name of ["DevOps 对话", "深度调查"]) {
      const b = pill(name)!;
      expect(b.disabled, name).toBe(true);
      expect(b.getAttribute("aria-disabled"), name).toBe("true");
      // 置灰要给原因：tooltip 里必须有"为什么点不动"，不能只挂一个「未接入」徽标。
      expect((b.getAttribute("title") || "").length, name).toBeGreaterThan("深度调查".length);
      expect(b.querySelector(".toggle-soon")?.textContent, name).toBe("未接入");
    }
  });

  it("开着时 pill 亮起且 aria-pressed 如实反映（前端不传 = 后端行为不变的前提）", async () => {
    renderComposer({ devopsChat: false });
    await waitFor(() => expect(pill("DevOps 对话")).toBeTruthy());
    expect(pill("DevOps 对话")!.getAttribute("aria-pressed")).toBe("false");

    cleanup();
    renderComposer({ devopsChat: true });
    await waitFor(() => expect(pill("DevOps 对话")).toBeTruthy());
    expect(pill("DevOps 对话")!.className).toContain("on");
    expect(pill("DevOps 对话")!.getAttribute("aria-pressed")).toBe("true");
    // 另一枚不许跟着亮（单选画成两枚平铺，唯一的风险就是这个）。
    expect(pill("深度调查")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("再点一次亮着的 pill 就是关（没有「不启用」那一项了，退路只能是它自己）", async () => {
    const onToggleDevopsChat = vi.fn();
    renderComposer({ devopsChat: true, onToggleDevopsChat });
    await waitFor(() => expect(pill("DevOps 对话")).toBeTruthy());
    pill("DevOps 对话")!.click();
    // ChatApp 的 toggleDevopsChat 本身就是"再点一次就关"，所以这里只需确认它被调到。
    expect(onToggleDevopsChat).toHaveBeenCalledTimes(1);
  });
});

describe("通用会话选了 DevOps Agent 之后的 Composer（objMode）", () => {
  beforeEach(() => { availability = { available: true }; cleanup(); });

  it("工具栏瘦身：联网与模型选择器不渲染", async () => {
    renderComposer({ topic: "general", devopsChat: true });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    expect(webBtn()).toBeNull();
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
    expect(webBtn()).toBeTruthy();
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
    await waitFor(() => expect(pillLabels()).toContain("深度调查"));
    // objMode 下工具条上只剩它这一枚带文字的按钮。
    expect(pillLabels()).toEqual(["深度调查"]);
    const btn = pill("深度调查")!;
    // 默认不勾是产品硬要求：深度调查要跑几分钟，替客户默认选上等于每句话都等几分钟。
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    btn.click();
    expect(onToggleDevopsAgentDirect).toHaveBeenCalledTimes(1);
  });

  it("勾上后如实反映 aria-pressed（这一轮才走深度调查）", async () => {
    renderComposer({ topic: "general", devopsChat: true, devopsAgentDirect: true });
    await waitFor(() => expect(pillLabels()).toContain("深度调查"));
    expect(pill("深度调查")!.getAttribute("aria-pressed")).toBe("true");
  });

  it("对象是 NotiOps 的通用会话里没有这个勾选（那条路径没有直连深度调查）", async () => {
    renderComposer({ topic: "general", devopsChat: false });
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    expect(pillLabels()).not.toContain("深度调查");
  });

  it("故障调查开着 DevOps 对话时**不**瘦身（那里是每轮开关，不是会话对象）", async () => {
    renderComposer({ topic: "investigate", devopsChat: true });
    await waitFor(() => expect(pill("深度调查")).toBeTruthy());
    expect(document.querySelector("button.cmd-btn")).toBeTruthy();
    expect(webBtn()).toBeTruthy();
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
