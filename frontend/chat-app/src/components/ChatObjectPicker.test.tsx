/**
 * 「对话对象」分段控件（通用会话新对话主页）的契约。
 *
 * 改错了都不报错、只是显示错，而且错的方向都很贵：
 *   · **默认选中 NotiOps**（可跳过）：不选直接打字必须还是老行为，否则所有老用户的第一句
 *     都变成走别人的 Agent；
 *   · 两段是 radiogroup（二选一），不是两个独立开关；
 *   · 这个部署/账号没接入 DevOps Agent 时那一段**置灰 + 写清原因**：不然客户选了它，
 *     发一轮才收到 no_local_agent_space；
 *   · 置灰时把**已选中**的 DevOps Agent 退回 NotiOps：那一段已经点不动了，客户自己回不来。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

let availability: { available: boolean; reason?: string } = { available: true };
vi.mock("../api/chat", () => ({
  getDeepInvestigationAvailability: () => Promise.resolve(availability),
}));

import ChatObjectPicker from "./ChatObjectPicker";

const segs = () => Array.from(document.querySelectorAll("button.obj-seg-btn")) as HTMLButtonElement[];
/** [NotiOps 段, DevOps Agent 段] —— 顺序是产品指定的（默认那个在左）。 */
const notiopsSeg = () => segs()[0];
const devopsSeg = () => segs()[1];
const hint = () => (document.querySelector(".obj-hint")?.textContent || "").trim();

describe("「对话对象」分段控件", () => {
  beforeEach(() => { availability = { available: true }; cleanup(); });

  it("两段组成一个 radiogroup，默认选中 NotiOps", async () => {
    render(<ChatObjectPicker devopsChat={false} onPick={() => {}} />);
    await waitFor(() => expect(segs().length).toBe(2));
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    expect(notiopsSeg().getAttribute("aria-checked")).toBe("true");
    expect(devopsSeg().getAttribute("aria-checked")).toBe("false");
    expect(notiopsSeg().className).toContain("sel");
  });

  it("选中 DevOps Agent 时选中态跟着走，回调 devops，提示行也跟着换", async () => {
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={false} onPick={onPick} />);
    await waitFor(() => expect(segs().length).toBe(2));
    const notiopsHint = hint();
    expect(notiopsHint.length).toBeGreaterThan(0);
    devopsSeg().click();
    expect(onPick).toHaveBeenCalledWith("devops");

    cleanup();
    render(<ChatObjectPicker devopsChat={true} onPick={onPick} />);
    await waitFor(() => expect(devopsSeg().getAttribute("aria-checked")).toBe("true"));
    expect(notiopsSeg().getAttribute("aria-checked")).toBe("false");
    expect(hint()).not.toBe(notiopsHint);
    notiopsSeg().click();
    expect(onPick).toHaveBeenCalledWith("notiops");
  });

  it("选中态不写「已选」二字（靠填充表达），提示行也不解释计费机制", async () => {
    render(<ChatObjectPicker devopsChat={true} onPick={() => {}} />);
    await waitFor(() => expect(segs().length).toBe(2));
    const tx = document.querySelector(".obj-pick")?.textContent || "";
    expect(tx).not.toContain("已选");
    expect(tx).not.toContain("0 token");
  });

  // 产品指定：DevOps Agent 那一侧的提示行必须写「免模型配置」——这是这条路径对客户最实际的
  // 一句好处（模型还没在 Bedrock 开通好的部署，选这边就能直接用），不是"0 token"这种机制话。
  it("选中 DevOps Agent 时提示行写明「免模型配置」", async () => {
    render(<ChatObjectPicker devopsChat={true} onPick={() => {}} />);
    await waitFor(() => expect(segs().length).toBe(2));
    expect(hint()).toContain("免模型配置");
  });

  it("没接入 DevOps Agent：那一段置灰、点不动，原因写在提示行里", async () => {
    availability = { available: false, reason: "account_not_onboarded_to_devops_agent" };
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={false} onPick={onPick} accountId="123456789012" />);
    await waitFor(() => expect(devopsSeg().disabled).toBe(true));
    expect(devopsSeg().className).toContain("disabled");
    // 原因要出现在界面上（而不是只藏在 title 里）。
    expect(hint().length).toBeGreaterThan(10);
    expect(devopsSeg().getAttribute("title")).toBeTruthy();
    devopsSeg().click();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("探到不可用时把已选中的 DevOps Agent 退回 NotiOps", async () => {
    availability = { available: false, reason: "no_local_agent_space" };
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={true} onPick={onPick} />);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("notiops"));
  });

  it("探测失败/可用时不动已有选择（探测不确定一律按可用处理）", async () => {
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={true} onPick={onPick} />);
    await waitFor(() => expect(segs().length).toBe(2));
    expect(devopsSeg().disabled).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });
});
