/**
 * 确认卡「点过一次就锁死」+「回放的既有结果要明说」—— 渲染测试。
 *
 * ## 守的是什么
 *
 * 三张确认卡（只读建案 / 可编辑建案 / 通用写操作）背后都是**不可逆**的 AWS 写请求。
 * 宿主（`ChatApp.confirmAction`）要 `await executeActionApi(...)` 回来才把 `action.done`
 * 置上，那段窗口里卡还是「待确认」状态：
 *   双击 = 真的开**两个**案例 / 发**两条**回复，而界面只留后一次的结果 ——
 *   用户不知道自己开了两个，AWS 侧却实实在在有两条。
 * 所以每张卡都有一位本地 `sending`：点下即禁用、文案改成「创建中…/执行中…」，
 * 并且把「取消」「返回修改」一起禁掉（取消会把「未执行：已取消」盖到一个正在成功的
 * 写操作上；返回修改会重置这一位＝把锁解开）。
 *
 * 前端这一位只挡「同一张卡上的连点」。刷新页面 / 另开标签页后卡会重新变成「待确认」
 * （`patchMsgIn` 不回写后端），那条路由 BFF 的幂等层挡住并**回放既有结果**；
 * 回放必须在卡上明说，否则用户以为自己刚刚又开了一个案例。
 * → 见 bff/web-chat/support.mjs 的幂等段 + tests/action_idempotency.test.mjs。
 *
 * ## 为什么必须是渲染测试
 *
 * 「源码里有 setSending」证明不了任何事：`disabled={sending}` 漏在任何一个按钮上、
 * 或者 `onClick` 里 setSending 写在 onConfirm **之后**（同一 tick 内不生效）——
 * 子串检查全都照过。只有真点两下、数 onConfirm 被调了几次才抓得到。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, ProposedAction } from "./types";

// ⚠️ mock 必须在被测组件 import **之前**生效（`vi.mock` 会被提升；工厂里不能引用外部变量）。
//    CaseFormCard 一挂载就拉服务目录，不 mock 会走真的 `signedClient()` →
//    "Config not loaded yet" 以 unhandled rejection 冒出来。
vi.mock("./api/chat", async (orig) => ({
  ...(await orig<typeof import("./api/chat")>()),
  getSupportServices: vi.fn(),
}));

const chatApi = await import("./api/chat");
const Message = (await import("./components/Message")).default;

// ⚠️ 显式 `cleanup()` —— RTL 自动清理只在 `globals: true` 时注册，本仓库是 false。
afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  // 空目录：serviceValid / categoryValid 走「目录没加载到就不阻断」的宽松分支，
  // 于是 canSubmit 只取决于 subject + service_code + 正文，用例好造。
  vi.mocked(chatApi.getSupportServices).mockResolvedValue({ services: [] });
});

const msgWith = (actions: ProposedAction[]): ChatMessage => ({
  id: "m1", role: "assistant", text: "ok", ts: 1_700_000_000_000, actions,
});

const renderMsg = (actions: ProposedAction[], onConfirm = vi.fn(), onCancel = vi.fn()) => {
  render(<Message m={msgWith(actions)} onOpenSources={() => {}}
    onConfirmAction={onConfirm} onCancelAction={onCancel} />);
  return { onConfirm, onCancel };
};

const CASE_PARAMS = {
  subject: "RDS 连接超时", communication_body: "详细描述", service_code: "amazon-relational-database-service",
  service_name: "Amazon RDS", category_code: "performance", severity_code: "urgent",
  issue_type: "technical", language: "zh",
};

describe("只读建案卡（create_case_review）", () => {
  it("连点两次「确认创建」只发一次 —— 建案不可逆", () => {
    const { onConfirm } = renderMsg([{ type: "create_case_review", params: CASE_PARAMS }]);
    const btn = screen.getByRole("button", { name: "确认创建" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("点下后按钮变禁用 + 文案「创建中…」，取消也一起禁掉", () => {
    renderMsg([{ type: "create_case_review", params: CASE_PARAMS }]);
    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    const sending = screen.getByRole("button", { name: "创建中…" });
    expect(sending).toBeTruthy();
    expect((sending as HTMLButtonElement).disabled).toBe(true);
    // 「取消」若还能点，就会把「未执行：已取消」盖到一个正在成功的写操作上。
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("执行中点「取消」不会调宿主的 onCancelAction", () => {
    const { onCancel } = renderMsg([{ type: "create_case_review", params: CASE_PARAMS }]);
    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("BFF 回放的既有结果要明说「没有重复创建」", () => {
    renderMsg([{ type: "create_case_review", params: CASE_PARAMS, done: true,
      result: { ok: true, verified: true, displayId: "case-123", duplicate: true } }]);
    expect(screen.getByText("这是同一请求的既有结果 —— 没有重复创建。")).toBeTruthy();
  });

  it("反例：普通（非回放）成功结果不许加那句话", () => {
    renderMsg([{ type: "create_case_review", params: CASE_PARAMS, done: true,
      result: { ok: true, verified: true, displayId: "case-123" } }]);
    expect(screen.getByText(/已成功创建 Support 案例/)).toBeTruthy();
    expect(screen.queryByText(/没有重复创建/)).toBeNull();
  });
});

describe("通用写操作卡（ActionCard）", () => {
  it("连点两次「确认执行」只发一次", () => {
    const { onConfirm } = renderMsg([{ type: "add_communication", params: { case_id: "1", communication_body: "x" } }]);
    const btn = screen.getByRole("button", { name: "确认执行" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const sending = screen.getByRole("button", { name: "执行中…" });
    expect((sending as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "取消" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("回放的既有结果要明说「没有重复执行」", () => {
    renderMsg([{ type: "add_communication", params: { case_id: "1" }, done: true,
      result: { ok: true, duplicate: true } }]);
    expect(screen.getByText("这是同一请求的既有结果 —— 没有重复执行。")).toBeTruthy();
  });
});

describe("可编辑建案卡（create_case_form）", () => {
  /** 走到预览页 —— 「确认创建」只在那一页上。 */
  const toPreview = async (onConfirm = vi.fn()) => {
    const r = renderMsg([{ type: "create_case_form", params: CASE_PARAMS }], onConfirm);
    // 目录请求是异步的；`预览` 在编辑页上，不依赖目录返回（空目录=宽松放行）。
    fireEvent.click(await screen.findByRole("button", { name: "预览" }));
    return r;
  };

  it("连点两次「确认创建」只提交一次", async () => {
    const { onConfirm } = await toPreview();
    const btn = screen.getByRole("button", { name: "确认创建" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("执行中「返回修改」禁用 —— 回编辑页会把锁解开", async () => {
    await toPreview();
    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    expect((screen.getByRole("button", { name: "创建中…" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "返回修改" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("回放的既有结果要明说「没有重复创建」", () => {
    renderMsg([{ type: "create_case_form", params: CASE_PARAMS, done: true,
      result: { ok: true, displayId: "case-456", duplicate: true } }]);
    expect(screen.getByText("这是同一请求的既有结果 —— 没有重复创建。")).toBeTruthy();
  });
});
