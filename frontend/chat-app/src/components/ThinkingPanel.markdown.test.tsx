/**
 * 右侧「思考过程」面板不许把 markdown 记号原样露给用户 —— 渲染测试。
 *
 * ## 现网现象（2026-10-13，生产 DevOps Agent 深度调查）
 *
 * 面板里出现 `**🔭 Observation：…**`、`` `use_aws` `` 这样的原始记号。来路：
 *   · BFF 直连深度调查 `bff/web-chat/devops_investigate.mjs::recordProgressLine`（以及 agent 侧
 *     同形的 `core/devops_agent.py::_record_progress_line`）把 journal 记录渲染成带 `**` / 反引号的
 *     行 —— 这一格式**是对的**：IM 卡片也读它、按 markdown 渲染，那边不能动；
 *   · 面板（ThinkingPanel）却把 `s.text` 当纯文本（pre-wrap）原样输出。
 * 同一个面板还收 DevOps 对话的过程行（`已连接 Agent Space \`…\``）和模型的明文思考（Kimi K3
 * 常带 `**小标题**`），是同一个病。
 *
 * ## 修法与这里钉住的
 *
 * 面板只渲染一个**极小、安全**的子集（`src/stepText.ts`）：`**粗体**`、`` `行内代码` ``、
 * 行首 `#` 标题（去掉 `#`、整行加粗）；其余一律当纯文本。全程只产出 React 文本节点 /
 * `<strong>` / `<code>`，不经 HTML 解析 —— 数据里夹带的 `<img onerror>` 只会被当成字。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import ThinkingPanel from "./ThinkingPanel";
import { appendStep, appendReasoning, type TimelineStep } from "../thinking";

afterEach(cleanup);

// ── 真实形状（逐字照搬生产者的模板，别改成"好看"的写法）──
// recordProgressLine：observation / finding / tool_use 三类（agent 侧 _record_progress_line 同形）。
const OBSERVATION = "\n**🔭 Observation：orders-api p99 延迟在 23:05 后陡增**\n\n"
  + "`use_aws` 返回 ALB TargetResponseTime 在 23:05 后从 120ms 升到 2.4s，与告警时间吻合。\n";
const FINDING = "\n**🔎 Finding：orders-db 连接数打满**\n\nDatabaseConnections 在 23:04 达到 max_connections。\n";
const TOOL_USE = "\n🔧 调用工具：`use_aws`\n";
// DevOps 对话（bff/web-chat/devops_chat.mjs）的首行过程。
const DEVOPS_CHAT = "已连接 Agent Space `as-0a1b2c3d`";

/** 照 ChatApp 的接线把步骤喂进时间线（onInvestigationStep → appendStep，trim 在那里做）。 */
function timeline(...texts: string[]): TimelineStep[] {
  let s: TimelineStep[] = [];
  for (const t of texts) s = appendStep(s, { text: t }, 0);
  return s;
}
const mount = (steps: TimelineStep[]) =>
  render(<ThinkingPanel open steps={steps} onClose={() => {}} />);
const panelText = () => document.querySelector(".inv-timeline")?.textContent ?? "";
const texts = (sel: string) => Array.from(document.querySelectorAll(`.inv-timeline ${sel}`)).map((e) => e.textContent);

describe("思考过程面板：markdown 记号不原样露出", () => {
  it("深度调查的 Observation / Finding / 工具行：没有 ** 与反引号，标题加粗、工具名是代码", () => {
    mount(timeline(OBSERVATION, FINDING, TOOL_USE));
    const all = panelText();
    expect(all).not.toContain("**");
    expect(all).not.toContain("`");
    expect(texts("strong")).toEqual([
      "🔭 Observation：orders-api p99 延迟在 23:05 后陡增",
      "🔎 Finding：orders-db 连接数打满",
    ]);
    expect(texts("code")).toEqual(["use_aws", "use_aws"]);
    // 内容一个字都不能丢（只去记号，不去正文）。
    expect(all).toContain("与告警时间吻合");
    expect(all).toContain("DatabaseConnections 在 23:04 达到 max_connections");
    expect(all).toContain("🔧 调用工具：use_aws");
  });

  it("DevOps 对话的过程行同样处理（Agent Space id 是代码样式）", () => {
    mount(timeline(DEVOPS_CHAT));
    expect(panelText()).toBe("已连接 Agent Space as-0a1b2c3d");
    expect(texts("code")).toEqual(["as-0a1b2c3d"]);
  });

  it("模型明文思考里的小标题与粗体也渲染（Kimi K3 常见），思考段仍是一段", () => {
    let s: TimelineStep[] = [];
    s = appendReasoning(s, "### 先看告警\n\n**关键点**：p99 从 23:05 开始，", 0);
    s = appendReasoning(s, "要查 `CloudTrail` 的变更。", 0);
    mount(s);
    expect(document.querySelectorAll(".inv-step")).toHaveLength(1);
    const all = panelText();
    expect(all).not.toMatch(/###|\*\*|`/);
    expect(texts("strong")).toEqual(["先看告警", "关键点"]);
    expect(texts("code")).toEqual(["CloudTrail"]);
  });

  it("段落结构保留：标题与分析之间的空行还在（pre-wrap 靠换行符分段）", () => {
    mount(timeline(OBSERVATION));
    const tx = document.querySelector(".inv-step-tx")?.textContent ?? "";
    expect(tx).toBe("🔭 Observation：orders-api p99 延迟在 23:05 后陡增\n\n"
      + "use_aws 返回 ALB TargetResponseTime 在 23:05 后从 120ms 升到 2.4s，与告警时间吻合。");
  });

  it("不成对的记号原样保留（宁可露一个星号，也不吞掉用户的内容）", () => {
    mount(timeline("a ** b，`未闭合，**半截"));
    expect(panelText()).toBe("a ** b，`未闭合，**半截");
    expect(document.querySelector(".inv-timeline strong, .inv-timeline code")).toBeNull();
  });

  it("不经 HTML 解析：数据里夹带的标签只当文字", () => {
    mount(timeline("**<img src=x onerror=alert(1)>** `<script>x</script>`"));
    expect(document.querySelector(".inv-timeline img, .inv-timeline script")).toBeNull();
    expect(panelText()).toBe("<img src=x onerror=alert(1)> <script>x</script>");
  });

  it("detail（工具入参摘要）仍是纯文本，不做任何解析", () => {
    mount([{ text: "调用 lookup_events", kind: "tool", detail: "filter=`x`, region=**us-east-1**" }]);
    expect(document.querySelector(".think-detail")?.textContent).toBe("filter=`x`, region=**us-east-1**");
  });
});
