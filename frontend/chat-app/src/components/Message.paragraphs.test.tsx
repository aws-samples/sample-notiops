/**
 * 工具调用前后的两段正文在气泡里必须是两段 —— 渲染测试（气泡这一层的判据）。
 *
 * 2026-10-13 现网（v94 / Kimi K3，调查主题）：流里三段正文中间夹着工具调用，前端 `acc += delta`
 * 原样拼接，答案的第一个标题粘在旁白后面 —— `…我重试一下，再查：# 排查结果` 被 ReactMarkdown
 * 渲染成同一个段落，`#` 原样露出。修在 agent 发出端（`agent-build/…/paragraphs.py`：工具调用之后
 * 的第一段正文前面单独发一帧 "\n\n"），BFF 落库的就是这些 delta 拼起来的全文，所以实时显示与刷新
 * 后的历史回放走的是同一份文字、同一个组件（本文件）。
 *
 * 这里钉住气泡这一层的两件事：
 *   ① 粘连版（修复前落库的样子）确实渲染成"标题糊进段落"—— 记下现网症状，防止误以为是别处的问题；
 *   ② 分段版里标题是真标题、旁白各自成段 —— 也就是说渲染链路（stripThinking / linkifyCaseIds /
 *      ReactMarkdown）不会把 agent 补的空行再吃掉。
 * agent / BFF / IM 那几层的判据：tests/test_agent_paragraphs.py、bff/web-chat/tests/agentcore.test.mjs。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import type { ChatMessage } from "../types";
import Message from "./Message";

afterEach(cleanup);

const NARRATION_1 = "我先取证：查 orders-api 当前告警状态，以及最近 24 小时的部署 / 配置变更事件。";
const NARRATION_2 = "当前活跃告警里没有 orders-api 的 p99 告警，可能已恢复。我重试一下，再查：";
const ANSWER = "# 排查结果：orders-api p99 延迟\n\n## 结论\n\n最近 24 小时内**没有**发现相关部署。";

const mount = (text: string) =>
  render(<Message m={{ id: "m1", role: "assistant", text, ts: 1_700_000_000_000 } as ChatMessage}
    onOpenSources={() => {}} onOpenThinking={() => {}} />);
const paras = () => Array.from(document.querySelectorAll(".md p")).map((p) => p.textContent ?? "");

describe("工具调用前后的两段正文：气泡里是两段", () => {
  it("① 现网症状（修复前的拼接）：标题糊进上一段，# 原样露出", () => {
    mount(NARRATION_1 + NARRATION_2 + ANSWER);
    expect(document.querySelector(".md h1")).toBeNull();
    expect(paras().some((p) => p.includes("再查：# 排查结果"))).toBe(true);
  });

  it("② 修复后（agent 在工具调用之后补 \\n\\n）：标题是真标题，两段旁白各自成段", () => {
    mount(`${NARRATION_1}\n\n${NARRATION_2}\n\n${ANSWER}`);
    expect(document.querySelector(".md h1")?.textContent).toBe("排查结果：orders-api p99 延迟");
    expect(document.querySelector(".md h2")?.textContent).toBe("结论");
    expect(paras().slice(0, 2)).toEqual([NARRATION_1, NARRATION_2]);
    expect(paras().some((p) => p.includes("#"))).toBe(false);
  });
});
