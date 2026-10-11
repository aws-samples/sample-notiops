/**
 * 一条回复**只有一个**「查看思考过程」入口 —— 侧边栏那个（Message.tsx 入口规矩 3）。
 *
 * 2026-10-10 现网：默认模型换成 Kimi K3 后，每条回复出现两个同名的「查看思考过程」—— 气泡里一个
 * 折叠灰字（m.reasoning），正文上方一个侧边栏入口（thinkingSteps），内容还是同一份思考。Grok 的
 * 思考链是加密的、一直被丢弃，所以这个重复此前没人看见；GLM 5.3 也是明文，同样中招。
 * 修法是删掉气泡里那份，思考只并进侧边栏的时间线。这里钉住「不管哪个模型、什么形状，只出一个」。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ChatMessage } from "../types";
import Message from "./Message";

const base: ChatMessage = { id: "m1", role: "assistant", text: "答案", ts: 1_700_000_000_000 };
const mount = (m: Partial<ChatMessage>) =>
  render(<Message m={{ ...base, ...m }} onOpenSources={() => {}} onOpenThinking={() => {}} />);
/** 页面上所有写着「查看思考过程」（或英文界面的同义词）的可点元素。 */
const entries = () =>
  Array.from(document.querySelectorAll("button")).filter((b) => /查看思考过程|View thinking|Show reasoning/.test(b.textContent ?? ""));

afterEach(cleanup);

describe("思考过程入口：一条回复只有一个", () => {
  it("明文思考（Kimi / GLM 那种）：只有侧边栏入口，没有气泡里的折叠灰字", () => {
    // 现网出问题那一刻的形状：流式时 m.reasoning 与 thinkingSteps **两样都写了**。字段已从类型里删掉，
    // 但老数据 / 别处的代码仍可能带着它 —— 带着它也只能出一个入口。
    mount({ thinkingSteps: [{ text: "先算 17×23……", kind: "thought" }],
            ...({ reasoning: "先算 17×23……" } as Partial<ChatMessage>) });
    expect(entries()).toHaveLength(1);
    expect(entries()[0].classList.contains("think-entry")).toBe(true);
    expect(document.querySelector(".reasoning, .reasoning-toggle")).toBeNull();
  });

  it("思考 + 工具步骤：仍然只有一个入口，计数是全部步骤", () => {
    mount({ thinkingSteps: [
      { text: "想一下", kind: "thought" },
      { text: "调用 lambda list-functions", kind: "tool" },
      { text: "工具已返回", kind: "result" },
    ] });
    expect(entries()).toHaveLength(1);
    expect(entries()[0].textContent).toContain("3");
  });

  it("DevOps Agent 的调查步骤：同一个入口（不是第二个）", () => {
    mount({ investigationSteps: [{ text: "已发起调查" }, { text: "分析中" }] as ChatMessage["investigationSteps"] });
    expect(entries()).toHaveLength(1);
  });

  it("没有任何过程（Grok 加密思考、寒暄快路径）：一个入口都不出", () => {
    mount({});
    expect(entries()).toHaveLength(0);
  });
});
