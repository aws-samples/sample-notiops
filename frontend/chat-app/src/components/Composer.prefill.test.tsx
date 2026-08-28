/**
 * Composer 的「外部预填（prefill）」契约测试。
 *
 * 为什么值得单测：prefill 的状态**不在本组件里**（在 ChatApp 的 `themePrefill[topic]` /
 * `homePrefill[convId]`），它活得比 Composer 实例久 —— 主题 landing 挂在 `view` 上，
 * 点一次主题就整棵子树卸载重挂。2026-08-27 现网反馈的 bug 正是这个错配：
 * 从主题起始页问完一句话，再点回这个主题，输入框里还留着刚问过的那句（强刷才消失）。
 * 这类回归**不会报错、只会显示错**，靠肉眼 review 看不出来，所以钉在这里。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../api/chat", () => ({
  getCasesSummary: () => Promise.resolve(null),
  getDeepInvestigationAvailability: () => Promise.resolve({ ok: false }),
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

/** 只渲染必需 props；prefill / convKey 由各用例给。 */
function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <Composer model="claude-sonnet-5" onModelChange={() => {}} onSend={props.onSend ?? (() => {})}
      busy={false} showSuggestions={false} topic="investigate" {...props} />,
  );
}

const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

describe("Composer prefill", () => {
  it("seq 从 0 变 1 时把卡片文案填进输入框", async () => {
    const { rerender } = renderComposer({ prefill: { text: "", seq: 0 }, convKey: "landing:investigate" });
    expect(box().value).toBe("");
    rerender(
      <Composer model="claude-sonnet-5" onModelChange={() => {}} onSend={() => {}} busy={false}
        showSuggestions={false} topic="investigate" convKey="landing:investigate"
        prefill={{ text: "帮我排查 EC2 无法连接", seq: 1 }} />,
    );
    expect(box().value).toBe("帮我排查 EC2 无法连接");
    cleanup();
  });

  it("重挂时不重放已消费的 seq —— 回到主题输入框必须是空的（现网 bug）", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    // 1) 起始页：点卡片 → prefill(seq=1) 填入
    const prefill = { text: "帮我排查 EC2 无法连接", seq: 1 };
    const { rerender } = renderComposer({ prefill: { text: "", seq: 0 }, convKey: "landing:investigate", onSend });
    rerender(
      <Composer model="claude-sonnet-5" onModelChange={() => {}} onSend={onSend} busy={false}
        showSuggestions={false} topic="investigate" convKey="landing:investigate" prefill={prefill} />,
    );
    expect(box().value).toBe(prefill.text);

    // 2) 发送 → 输入框清空（ChatApp 随后切 view，landing 整棵卸载）
    await user.click(screen.getByLabelText("Send"));
    expect(onSend).toHaveBeenCalledWith(prefill.text, undefined);
    expect(box().value).toBe("");
    cleanup();

    // 3) 再点这个主题 → landing 重挂，**prefill 仍是那个 seq=1 的对象**（ChatApp 的 state 没变）。
    //    这里必须是空的：否则用户看到的是上次已经问过的那句话。
    renderComposer({ prefill, convKey: "landing:investigate", onSend });
    expect(box().value).toBe("");
  });

  it("重挂后再点一次卡片（seq 递增）依然能填入", async () => {
    const prefill = { text: "帮我排查 EC2 无法连接", seq: 1 };
    const { rerender } = renderComposer({ prefill, convKey: "landing:investigate" });
    expect(box().value).toBe("");            // 重挂：不重放
    rerender(
      <Composer model="claude-sonnet-5" onModelChange={() => {}} onSend={() => {}} busy={false}
        showSuggestions={false} topic="investigate" convKey="landing:investigate"
        prefill={{ text: "帮我排查 EC2 无法连接", seq: 2 }} />,
    );
    expect(box().value).toBe("帮我排查 EC2 无法连接");
  });

  it("手输后切走再切回同一会话仍保留草稿（草稿隔离不受本次修复影响）", async () => {
    const user = userEvent.setup();
    const { rerender } = renderComposer({ convKey: "conv-a" });
    await user.type(box(), "还没发的草稿");
    const props = { model: "claude-sonnet-5", onModelChange: () => {}, onSend: () => {}, busy: false,
                    showSuggestions: false as const, topic: "investigate" };
    rerender(<Composer {...props} convKey="conv-b" />);
    expect(box().value).toBe("");
    rerender(<Composer {...props} convKey="conv-a" />);
    expect(box().value).toBe("还没发的草稿");
  });
});
