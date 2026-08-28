/**
 * 回复气泡页脚的契约：**只有一行**，顺序固定为 复制 → Sources → 署名(模型 · tokens) → 账号 ID。
 *
 * 为什么值得钉住：这里全是"改错了也不报错、只是看着不对"的东西，而回归的方向很具体 ——
 *   · 页脚曾经是两行（署名单独一行），谁再往回加一个 <div> 都不会有任何测试失败；
 *   · 「N 步」（usage.cycles）是产品明确要求去掉的，最容易被"顺手补回来"；
 *   · 账号徽标**只放 12 位 ID**，不放账号名（名字最长、又不能拿去定位资源 / 贴进 case）；
 *   · 「DevOps 对话」/「深度调查（直连）」的回复 m.model 是空的，署名只能靠 m.via ——
 *     一旦门条件写回 `m.model &&`，那两条路径的回复就变成"没人署名"。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ChatMessage } from "../types";
import Message from "./Message";

const base: ChatMessage = { id: "m1", role: "assistant", text: "hello", ts: 1_700_000_000_000 };

function mount(m: Partial<ChatMessage>, props: Record<string, unknown> = {}) {
  render(<Message m={{ ...base, ...m }} onOpenSources={() => {}} {...props} />);
}

const bar = () => document.querySelectorAll(".row.bot .msgbar");
/** 页脚里各元素的出现顺序（按 class 归类），用来断言"复制 → Sources → 署名 → 账号"。 */
const order = () =>
  Array.from(bar()[0].children).map((el) => {
    if (el.classList.contains("modelsig")) return "sig";
    if (el.classList.contains("mb-acct")) return "acct";
    if (el.textContent?.includes("Sources") || el.textContent?.includes("来源")) return "sources";
    return "copy";
  });

describe("回复页脚（一行）", () => {
  beforeEach(() => cleanup());

  it("四样东西在同一行，顺序=复制/Sources/署名/账号 ID", () => {
    mount(
      { model: "claude-sonnet-5", usage: { totalTokens: 137024, cycles: 4 }, sources: [{ title: "CloudWatch" }] },
      { accountLabel: "123456789012" },
    );
    expect(bar().length).toBe(1); // 不是两行
    expect(order()).toEqual(["copy", "sources", "sig", "acct"]);
  });

  it("署名带 tokens，但**不带**「N 步」", () => {
    mount({ model: "claude-sonnet-5", usage: { totalTokens: 137024, cycles: 4 } });
    const sig = document.querySelector(".modelsig")!.textContent || "";
    expect(sig).toContain("137,024 tokens");
    expect(sig).not.toContain("步");
    expect(sig.toLowerCase()).not.toContain("step");
    expect(document.querySelector(".modelsig-steps")).toBeNull();
  });

  it("账号只显示传入的 ID（父组件已不再拼账号名）", () => {
    mount({ model: "claude-sonnet-5" }, { accountLabel: "123456789012" });
    expect((document.querySelector(".mb-acct")?.textContent || "").trim()).toBe("123456789012");
  });

  it("账号是普通文字：没有外边框/胶囊底，只留一颗表示账号类型的点", () => {
    mount({ model: "claude-sonnet-5" }, { accountLabel: "123456789012", accountIsMember: true });
    const acct = document.querySelector(".mb-acct")!;
    // 曾经整块是 inline style 画出来的胶囊（border + borderRadius + padding）。样式回到 CSS 后
    // 这个元素身上不该再有任何 inline style —— 谁把边框写回来都会在这里失败。
    expect(acct.getAttribute("style")).toBeNull();
    const dot = acct.querySelector<HTMLElement>(".mb-acct-dot")!;
    expect(dot).not.toBeNull();
    expect(dot.style.background).toBe("var(--orange)"); // 成员账号=橙，部署/management=蓝
  });

  it("DevOps Agent 直答（m.model 为空、只有 m.via）也在同一行署名，且不显示 token", () => {
    mount({ via: "devops-agent", usage: undefined });
    expect(bar().length).toBe(1);
    const sig = document.querySelector(".modelsig")!.textContent || "";
    expect(sig).toBe("AWS DevOps Agent");
    expect(sig).not.toContain("tokens");
  });

  it("流式中不渲染页脚（避免答案没写完就出现复制/署名）", () => {
    mount({ model: "claude-sonnet-5", streaming: true });
    expect(bar().length).toBe(0);
  });
});
