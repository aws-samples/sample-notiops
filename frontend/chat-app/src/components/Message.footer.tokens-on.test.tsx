/**
 * 双生文件：把 `SHOW_TOKEN_USAGE` 翻成 `true` 之后页脚长什么样。
 *
 * 为什么必须是**单独一个文件**：`vi.mock` 是整文件级的，同一个文件里没法同时有
 * "开关关着"和"开关开着"两组断言。既有的 `Message.footer.test.tsx` 钉当前发版值
 * （`false`，不显示 token），这一份钉打开之后的样子。仓库里已有同样的双生先例
 * （`ChatObjectPicker.test.tsx` / `.hidden.test.tsx`）。
 *
 * 为什么值得单独钉：token 用量现在是**藏起来**而不是删掉 —— 用量照样收、照样落库，
 * 只有拼串那一步被开关挡住。这类"藏起来的实现"最典型的死法是：几个月后有人做清理，看到
 * `usage` 在界面上完全没用到，就把拼串那两行、乃至 `usage` 字段一起删了；等到产品想把它
 * 放出来，发现要重写一遍（还要重新踩一遍 `toLocaleString` 千分位、`> 0` 才显示这些坑）。
 * 有这份测试，那种删法会当场失败，而不是等到要用时才发现。
 *
 * 注意这里**不重复**钉「不带 N 步」「STAROps/DevOps 0 token」那些与开关无关的契约 ——
 * 它们在 `Message.footer.test.tsx` 里，且在两种开关值下都成立（那三条路径根本不带 usage）。
 * 唯一例外是 STAROps 那条：它必须在**开关打开时也**不显示 token，见下面最后一条。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("../featureFlags", () => ({ SHOW_TOKEN_USAGE: true, MULTICLOUD_UI: false }));

import type { ChatMessage } from "../types";
import Message from "./Message";

const base: ChatMessage = { id: "m1", role: "assistant", text: "hello", ts: 1_700_000_000_000 };

function mount(m: Partial<ChatMessage>) {
  render(<Message m={{ ...base, ...m }} onOpenSources={() => {}} />);
}

const sigText = () => document.querySelector(".modelsig")?.textContent || "";

describe("页脚 token 用量（开关打开后）", () => {
  beforeEach(() => cleanup());

  it("署名 = 模型 · 千分位 tokens", () => {
    mount({ model: "claude-sonnet-5", usage: { totalTokens: 137024, cycles: 4 } });
    expect(sigText()).toBe("AWS Bedrock (Claude Sonnet 5) · 137,024 tokens");
  });

  // 0 与 undefined 都不显示那一段：拼一个 "· 0 tokens" 出来会被读成"这轮没花钱"，
  // 而实际含义是"这一轮的用量没回来"（后端没发 usage 事件）—— 两件事不能显示成同一件。
  it("usage 缺失或为 0 时，只有模型、不拼出「· 0 tokens」", () => {
    mount({ model: "claude-sonnet-5", usage: undefined });
    expect(sigText()).toBe("AWS Bedrock (Claude Sonnet 5)");
    cleanup();
    mount({ model: "claude-sonnet-5", usage: { totalTokens: 0 } });
    expect(sigText()).toBe("AWS Bedrock (Claude Sonnet 5)");
  });

  // 开关只管「我们这边花的 token」。STAROps / DevOps Agent 那两条路径的用量记在**客户自己**
  // 的阿里云 / DevOps Agent 额度里，我们这边是 0 —— 把开关打开也绝不能让它们冒出一串数字，
  // 否则就是我们在替客户的另一份账单说话。这条断言在开关的两种取值下都必须成立。
  it("即便开关打开，STAROps / DevOps Agent 的署名仍不带 token", () => {
    mount({ via: "starops", usage: { totalTokens: 4096 } });
    expect(sigText()).toBe("Alibaba Cloud STAROps");
    cleanup();
    mount({ via: "devops-agent", usage: { totalTokens: 4096 } });
    expect(sigText()).toBe("AWS DevOps Agent");
  });
});
