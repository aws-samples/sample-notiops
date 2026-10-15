/**
 * `stepText.ts` 的边界（渲染层的判据在 components/ThinkingPanel.markdown.test.tsx）。
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect } from "vitest";
import { parseStepText } from "./stepText";

const flat = (text: string) => parseStepText(text).map((l) => ({
  heading: Boolean(l.heading),
  spans: l.spans.map((s) => `${s.bold ? "B" : ""}${s.code ? "C" : ""}:${s.text}`),
}));

describe("parseStepText", () => {
  it("粗体 / 代码 / 纯文本分段，原文字一个不丢", () => {
    expect(flat("看 **Observation：标题** 与 `use_aws` 结果")).toEqual([{ heading: false, spans: [
      ":看 ", "B:Observation：标题", ": 与 ", "C:use_aws", ": 结果",
    ] }]);
  });

  it("粗体里可以有代码（代码段内的 ** 不参与配对）", () => {
    expect(flat("**调用 `a**b` 完成**")).toEqual([{ heading: false, spans: [
      "B:调用 ", "BC:a**b", "B: 完成",
    ] }]);
  });

  it("相邻两段粗体各自成对", () => {
    expect(flat("**a**b**c**")).toEqual([{ heading: false, spans: ["B:a", ":b", "B:c"] }]);
  });

  it("不成对 / 两侧是空白 / 空内容 → 原样当文字", () => {
    expect(flat("a ** b ** c")).toEqual([{ heading: false, spans: [":a ** b ** c"] }]);
    expect(flat("**半截")).toEqual([{ heading: false, spans: [":**半截"] }]);
    expect(flat("****")).toEqual([{ heading: false, spans: [":****"] }]);
    expect(flat("``")).toEqual([{ heading: false, spans: [":``"] }]);
    expect(flat("`未闭合")).toEqual([{ heading: false, spans: [":`未闭合"] }]);
  });

  it("粗体不跨行：两行各有半个 ** 时都原样保留", () => {
    expect(flat("**第一行\n第二行**")).toEqual([
      { heading: false, spans: [":**第一行"] },
      { heading: false, spans: [":第二行**"] },
    ]);
  });

  it("ATX 标题：去掉井号（含收尾井号），整行标记为标题；不是标题的井号不动", () => {
    expect(flat("### 先看告警")).toEqual([{ heading: true, spans: [":先看告警"] }]);
    expect(flat("## 结论 ##")).toEqual([{ heading: true, spans: [":结论"] }]);
    expect(flat("   # 缩进三格仍是标题")).toEqual([{ heading: true, spans: [":缩进三格仍是标题"] }]);
    expect(flat("#1 号问题")).toEqual([{ heading: false, spans: [":#1 号问题"] }]);
    expect(flat("####### 七个井号不是标题")).toEqual([{ heading: false, spans: [":####### 七个井号不是标题"] }]);
    expect(flat("看 # 不在行首")).toEqual([{ heading: false, spans: [":看 # 不在行首"] }]);
  });

  it("空行保留成空行（段落结构靠它）；空串 → 空数组", () => {
    expect(flat("a\n\nb")).toEqual([
      { heading: false, spans: [":a"] }, { heading: false, spans: [] }, { heading: false, spans: [":b"] },
    ]);
    expect(parseStepText("")).toEqual([]);
  });
});
