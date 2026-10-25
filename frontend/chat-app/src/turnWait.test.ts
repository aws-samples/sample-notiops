/**
 * 「上一轮还在进行」（待办 #30 第 ②③ 档）。
 *
 * 2026-10-15 验证账号：第一轮等模型 300 秒，期间用户刷新页面、在同一会话里重发两次，两次都被说成
 * 「本轮处理失败，请再发送一次」。现在 BFF 发 busy 事件、服务端记着「有一轮在跑」，界面进入等待状态。
 * 这里钉两件事：
 *   ① 两个纯函数（已等多久的格式、这一轮有没有 runtime 会话可停）；
 *   ② 接线（源码级）：busy 事件、刷新后查一次、轮询到结束再拉消息、停止按钮真停服务端那一轮、等待提示。
 *      这几处是纯手工同步的接线，类型系统管不到「忘了接」—— 而忘了接的症状是界面一切正常、只是又回到
 *      「请再发送一次」。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/turnWait.test.ts
 */
import { describe, it, expect } from "vitest";
import { fmtElapsed, isAgentPathTurn } from "./turnWait";
import chatAppSrc from "./pages/ChatApp.tsx?raw";
import chatApiSrc from "./api/chat.ts?raw";
import i18nSrc from "./i18n.ts?raw";

describe("fmtElapsed", () => {
  it("formats m:ss and never goes negative", () => {
    expect(fmtElapsed(0)).toBe("0:00");
    expect(fmtElapsed(61_500)).toBe("1:01");
    expect(fmtElapsed(3_723_000)).toBe("62:03");
    expect(fmtElapsed(-5_000)).toBe("0:00");
    expect(fmtElapsed(Number.NaN)).toBe("0:00");
  });
});

describe("isAgentPathTurn", () => {
  it("only the NotiOps agent path has a runtime session to stop", () => {
    expect(isAgentPathTurn({})).toBe(true);
    expect(isAgentPathTurn({ devopsChat: true })).toBe(false);
    expect(isAgentPathTurn({ starops: true })).toBe(false);
    expect(isAgentPathTurn({ deepDirect: true })).toBe(false);
  });
});

describe("wiring (source level)", () => {
  it("api: routes the busy event and talks to /turn and /stop", () => {
    expect(chatApiSrc).toMatch(/case "busy":\s*cb\.onBusy\?\.\(data \?\? \{\}\);/);
    expect(chatApiSrc).toMatch(/\/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/turn`/);
    expect(chatApiSrc).toMatch(/\/conversations\/\$\{encodeURIComponent\(conversationId\)\}\/stop`, \{\s*method: "POST"/);
  });

  it("a busy event puts the conversation into the waiting state", () => {
    expect(chatAppSrc).toMatch(/onBusy: \(info\) => setTurnWait\(\(p\) => \(\{ \.\.\.p, \[convId\]: Number\(info\?\.since\) \|\| Date\.now\(\) \}\)\)/);
  });

  it("the composer treats a waiting conversation as busy (the stop button then stops the server-side turn)", () => {
    expect(chatAppSrc).toMatch(/const busy = busyIds\.has\(activeId\) \|\| activeId in turnWait;/);
    expect(chatAppSrc).toMatch(/if \(agentTurnRef\.current\.get\(activeId\) \|\| activeId in turnWaitRef\.current\) void stopTurn\(activeId\);/);
    expect(chatAppSrc).toMatch(/agentTurnRef\.current\.set\(convId, isAgentPathTurn\(\{ devopsChat: sendDevopsChat, starops: sendStarops, deepDirect: sendDeepDirect \}\)\);/);
  });

  it("opening a conversation after a refresh asks the server whether a turn is still running", () => {
    expect(chatAppSrc).toMatch(/if \(willHydrate\) \{[\s\S]{0,200}getTurnStatus\(convId\)\.then\(\(\{ inflight \}\) => \{\s*if \(inflight\) setTurnWait/);
  });

  it("polls until the turn is gone, then reloads that conversation's messages and unlocks", () => {
    const i = chatAppSrc.indexOf("const { inflight } = await getTurnStatus(id);");
    expect(i).toBeGreaterThan(-1);
    const after = chatAppSrc.slice(i, i + 900);
    expect(after).toMatch(/await getMessages\(id\)/);
    expect(after).toMatch(/messages: toChatMessages\(id, msgs\)/);
    expect(after).toMatch(/delete n\[id\]/);
    expect(chatAppSrc).toMatch(/\}, 5000\);/);
  });

  it("shows a waiting notice with elapsed time and a new-chat way out", () => {
    expect(chatAppSrc).toMatch(/active\.id in turnWait && !busyIds\.has\(active\.id\) && \(/);
    expect(chatAppSrc).toMatch(/t\("turnwait\.text"\)\.replace\("\{t\}", fmtElapsed\(Date\.now\(\) - turnWait\[active\.id\]\)\)/);
    expect(chatAppSrc).toMatch(/onClick=\{\(\) => newConv\(active\.topic \?\? "general"\)\}>\{t\("app\.newChat"\)\}/);
    const k = i18nSrc.indexOf('"turnwait.text"');
    expect(k).toBeGreaterThan(-1);
    const entry = i18nSrc.slice(k, k + 600);
    expect((entry.match(/\{t\}/g) || []).length).toBe(2); // 中英各一处
  });
});
