/**
 * 「事件通知 → 深入调查」必须开「深度调查（直连）」—— 这条链的回归测试。
 *
 * 为什么值得一个测试文件：这是一个**已经发生过**的静默缺陷。事件卡的正文来自后端
 * `core/push_event.py` 的 `dispatch_query`，那个字段的注释写的就是 "text to send to
 * DevOps Agent for follow-up investigation"；`ChatApp.startFromNotification` 的注释也写着
 * 「默认开 DevOps Agent」。但代码从未设置过任何一个开关 —— 用户点「深入调查」，跳进去
 * Composer 里「深度调查（直连）」没勾，那一轮走的是普通问答（还照常计费）。
 * 界面没有任何异常：会话起来了、消息发出去了、也有回答。
 *
 * 链路有 4 段，任一段断掉都复现同样的静默失败，所以逐段钉：
 *   ① 决策函数 deepDiveTogglesFor 的真值表（含两开关互斥、不适用主题一律关）
 *   ② 两处事件卡（NotificationsPanel / InboxList）的按钮必须传 { deep: true }
 *   ③ ChatApp 的通知面板调用点必须把 opts.deep 兑换成 deepDiveTogglesFor(...)
 *   ④ handleSend 必须优先读 target 会话的开关（否则开关勾上了但第一条消息仍走老路）
 * ②③④ 是**源码级**断言：这三处是纯手工同步的接线，类型系统管不到"忘了传"，
 * 而它们恰好就是这次漏掉的地方。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect } from "vitest";
import { deepDiveTogglesFor, topicHasDevopsAgent } from "./types";
// 源码级断言读的是 `?raw` 文本，不是 node:fs —— tsconfig.app.json 只带 `vite/client`
// 类型（不含 node），用 fs 会让 `npm run build` 的 tsc 阶段直接报 TS2307。
import notificationsPanelSrc from "./components/NotificationsPanel.tsx?raw";
import inboxListSrc from "./components/InboxList.tsx?raw";
import chatAppSrc from "./pages/ChatApp.tsx?raw";

describe("deepDiveTogglesFor", () => {
  it("turns on the direct (0-token) path, not the billed agent path", () => {
    expect(deepDiveTogglesFor("investigate")).toEqual({
      devopsAgent: false, devopsAgentDirect: true,
    });
  });

  it("covers every topic that renders the toggle", () => {
    for (const topic of ["investigate", "finops", "security"]) {
      expect(topicHasDevopsAgent(topic)).toBe(true);
      expect(deepDiveTogglesFor(topic).devopsAgentDirect).toBe(true);
    }
  });

  // 不提供深度调查的主题必须两个都关：开了也没有开关可显示，用户既看不到也关不掉。
  it("leaves both off where the toggle does not exist", () => {
    for (const topic of ["general", "cases", "whats-new", undefined]) {
      expect(topicHasDevopsAgent(topic)).toBe(false);
      expect(deepDiveTogglesFor(topic)).toEqual({
        devopsAgent: false, devopsAgentDirect: false,
      });
    }
  });

  // 两个开关同时为 true 会让同一轮既走 agent 又走直连。
  it("never returns both toggles on", () => {
    for (const topic of ["investigate", "finops", "security", "general", "cases"]) {
      const t = deepDiveTogglesFor(topic);
      expect(t.devopsAgent && t.devopsAgentDirect).toBe(false);
    }
  });
});

describe("the notification -> deep dive wiring", () => {
  // ② 两处事件卡的主按钮。两份卡片是历史上抽出复用时复制的，改一份漏一份正是这次的形态。
  it.each([
    ["NotificationsPanel.tsx（通知主题 · 事件通知）", notificationsPanelSrc],
    ["InboxList.tsx（各主题面板 · 事件收件箱）", inboxListSrc],
  ])("%s passes { deep: true } from the event card", (label, body) => {
    const call = body.match(/onInvestigate\(n\.dispatchQuery \|\| n\.title[^)]*\)/);
    expect(call, `${label}: 找不到事件卡的 onInvestigate(n.dispatchQuery ...) 调用`).not.toBeNull();
    expect(call![0], `${label}: 事件卡「深入调查」没有带 { deep: true }，` +
      `点进去 Composer 里「深度调查（直连）」不会勾上`).toContain("deep: true");
  });

  // ③ ChatApp 的两个调用点：拿到 opts.deep 后必须真的兑换成会话开关。
  it("ChatApp turns opts.deep into conversation toggles", () => {
    expect(chatAppSrc).toContain("deepDiveTogglesFor, ");           // 真的 import 了
    const uses = chatAppSrc.match(/opts\?\.deep \? deepDiveTogglesFor\("investigate"\)/g) || [];
    expect(uses.length, "ChatApp 应有两处（通知面板 + 调查仪表盘浏览器）把 opts.deep "
      + "兑换成 deepDiveTogglesFor(...)").toBe(2);
  });

  // ④ 第一条消息是 startFromNotification 自动发的，此时新会话可能还没 flush 进 state；
  //    handleSend 必须从传入的 target 读开关，否则开关显示为开、实际仍走普通问答。
  it("handleSend reads the flag off the target conversation first", () => {
    expect(chatAppSrc).toMatch(/devopsAgentDirect:\s*targetConv\?\.devopsAgentDirect\s*\?\?/);
  });
});
