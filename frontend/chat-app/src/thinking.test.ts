/**
 * 「思考过程」时间线累积的三条硬规则回归（见 thinking.ts 的模块注释）。
 * 运行：cd frontend/chat-app && npm test
 *
 * 这些是纯函数，React 那层（ChatApp 累积 / ThinkingPanel 渲染）不在这里测；这里只钉
 * 累积逻辑本身，因为 bug 都藏在合并/去重/过滤这些边界上，而它们与 UI 无关、最该单测。
 */
import { describe, it, expect } from "vitest";
import { appendStep, appendReasoning, isWaitHint, hasThinking, MAX_THINKING_STEPS, type TimelineStep } from "./thinking";

const T = 1_700_000_000_000;

describe("appendStep", () => {
  it("收进普通进度/工具步骤，返回新数组（引用变化以触发渲染）", () => {
    const a: TimelineStep[] = [];
    const b = appendStep(a, { text: "调用 get_cost_and_usage", kind: "tool" }, T);
    expect(b).not.toBe(a);
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ text: "调用 get_cost_and_usage", kind: "tool", ts: T });
  });

  it("规则 1：BFF 等待期提示（coldstart/working）一律不进时间线", () => {
    let s: TimelineStep[] = [];
    s = appendStep(s, { text: "正在启动服务…", kind: "coldstart" }, T);
    s = appendStep(s, { text: "已连接，正在分析…", kind: "working" }, T);
    expect(s).toHaveLength(0);
    // isWaitHint 是判据本身
    expect(isWaitHint("coldstart")).toBe(true);
    expect(isWaitHint("working")).toBe(true);
    expect(isWaitHint("tool")).toBe(false);
    expect(isWaitHint(undefined)).toBe(false);
  });

  it("规则 3：连续完全相同的行只记一次并计数（多区域轮询同一 API 常见）", () => {
    let s: TimelineStep[] = [];
    s = appendStep(s, { text: "查询区域资源", kind: "tool" }, T);
    s = appendStep(s, { text: "查询区域资源", kind: "tool" }, T + 1);
    s = appendStep(s, { text: "查询区域资源", kind: "tool" }, T + 2);
    expect(s).toHaveLength(1);
    expect(s[0].repeat).toBe(3);
  });

  it("升级：同文的第二条带 detail、第一条没有 → 原地长出 detail，不新增行、不计 repeat", () => {
    let s: TimelineStep[] = [];
    s = appendStep(s, { text: "分析成本数据", kind: "tool" }, T);              // contentBlockStart：无 detail
    s = appendStep(s, { text: "分析成本数据", kind: "tool", detail: "region=us-east-1" }, T + 1); // message 事件：带入参
    expect(s).toHaveLength(1);
    expect(s[0].detail).toBe("region=us-east-1");
    expect(s[0].repeat).toBeUndefined();
  });

  it("升级只发生一次方向：已有 detail 时再来同文（无 detail）走 repeat，不抹掉 detail", () => {
    let s: TimelineStep[] = [];
    s = appendStep(s, { text: "x", kind: "tool", detail: "d" }, T);
    s = appendStep(s, { text: "x", kind: "tool" }, T + 1);
    expect(s).toHaveLength(1);
    expect(s[0].detail).toBe("d");
    expect(s[0].repeat).toBe(2);
  });

  it("同文不同类不合并（是两件事）", () => {
    let s: TimelineStep[] = [];
    s = appendStep(s, { text: "x", kind: "tool" }, T);
    s = appendStep(s, { text: "x", kind: "result" }, T);
    expect(s).toHaveLength(2);
  });

  it("空文本 / 全空白 一律忽略（不给面板喂空行）", () => {
    let s: TimelineStep[] = [];
    s = appendStep(s, { text: "" }, T);
    s = appendStep(s, { text: "   " }, T);
    s = appendStep(s, {}, T);
    expect(s).toHaveLength(0);
  });

  it("未知 kind 归一到 status（面板据此选图标，不至于崩）", () => {
    const s = appendStep([], { text: "x", kind: "weird" }, T);
    expect(s[0].kind).toBe("status");
  });

  it("超过上限时丢最旧的（新的更有用），长度封顶", () => {
    let s: TimelineStep[] = [];
    for (let i = 0; i < MAX_THINKING_STEPS + 50; i++) s = appendStep(s, { text: "step-" + i, kind: "tool" }, T + i);
    expect(s).toHaveLength(MAX_THINKING_STEPS);
    expect(s[s.length - 1].text).toBe("step-" + (MAX_THINKING_STEPS + 49));
    expect(s[0].text).not.toBe("step-0"); // 最旧的被挤掉了
  });
});

describe("appendReasoning", () => {
  it("规则 2：连续思考增量并进最后一段（不碎成几百行）", () => {
    let s: TimelineStep[] = [];
    s = appendReasoning(s, "先看", T);
    s = appendReasoning(s, "真实花费", T + 1);
    s = appendReasoning(s, "和优化建议。", T + 2);
    expect(s).toHaveLength(1);
    expect(s[0].kind).toBe("thought");
    expect(s[0].text).toBe("先看真实花费和优化建议。");
  });

  it("中间插了工具行 → 之后的思考另起一段（确是新一轮想）", () => {
    let s: TimelineStep[] = [];
    s = appendReasoning(s, "想法A", T);
    s = appendStep(s, { text: "调用工具", kind: "tool" }, T + 1);
    s = appendReasoning(s, "想法B", T + 2);
    expect(s.map((x) => x.kind)).toEqual(["thought", "tool", "thought"]);
    expect(s[2].text).toBe("想法B");
  });

  it("空增量不产生新数组（避免无谓重渲染）", () => {
    const a: TimelineStep[] = [];
    expect(appendReasoning(a, "", T)).toBe(a);
  });
});

describe("hasThinking", () => {
  it("空/未定义 → false；有内容 → true", () => {
    expect(hasThinking(undefined)).toBe(false);
    expect(hasThinking([])).toBe(false);
    expect(hasThinking([{ text: "x", kind: "tool" }])).toBe(true);
  });
});
