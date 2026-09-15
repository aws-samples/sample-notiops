/**
 * 「对话对象」选择器在**多云关着**时的契约（产品决定：多云先不对外，2026-09-15）。
 *
 * 为什么必须是单独一个文件：`ChatObjectPicker.test.tsx` 把 `MULTICLOUD_UI` mock 成了
 * `true`（它守的是「实现还在、翻开就能用」），而 vitest 的 mock 是**整文件生效**的 ——
 * 同一个文件里读不到两种开关值。
 *
 * 这里钉三条，全都是「不报错、只是错」的类型：
 *  ① 只有两段（NotiOps / DevOps Agent），没有 STAROps 段 —— 客户看不到那个入口；
 *  ② **不打** `/features/starops` 探测 —— 藏了入口还去问"配没配"，等于每个新对话首页
 *     白花一个签名请求（而且那个请求会去读阿里云凭据配置）；
 *  ③ 会话里真的存着 `starops: true` 时**退回 NotiOps** —— 否则它带着一个界面上已经
 *     看不见的对话对象继续发：客户问 AWS，答案来自阿里云，界面上没有任何地方显示它切走了。
 *     ③ 是这三条里唯一有真实历史数据打进来的（老会话、老浏览器 localStorage）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

let soProbes = 0;
vi.mock("../api/chat", () => ({
  getDeepInvestigationAvailability: () => Promise.resolve({ available: true }),
  getStarOpsAvailability: () => { soProbes += 1; return Promise.resolve({ available: true }); },
}));
vi.mock("../featureFlags", () => ({ MULTICLOUD_UI: false }));

import ChatObjectPicker from "./ChatObjectPicker";
import { STRINGS } from "../i18n";

const segs = () => Array.from(document.querySelectorAll("button.obj-seg-btn")) as HTMLButtonElement[];
const hint = () => (document.querySelector(".obj-hint")?.textContent || "").trim();
const isNotiopsHint = (s: string) =>
  s === STRINGS["obj.notiops.hint"].zh || s === STRINGS["obj.notiops.hint"].en;

describe("「对话对象」选择器：多云关着", () => {
  beforeEach(() => { cleanup(); soProbes = 0; });

  it("只剩两段，STAROps 段不渲染", () => {
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={() => {}} />);
    expect(segs().length).toBe(2);
    const names = segs().map((b) => b.textContent || "");
    expect(names.some((n) => n.includes(STRINGS["obj.starops.name"].zh))).toBe(false);
  });

  it("默认还是选中 NotiOps，提示行是 NotiOps 自己的说明", () => {
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={() => {}} />);
    expect(segs()[0].getAttribute("aria-checked")).toBe("true");
    expect(isNotiopsHint(hint())).toBe(true);
  });

  it("不打阿里云可用性探测", async () => {
    render(<ChatObjectPicker devopsChat={false} starops={false} onPick={() => {}} />);
    // 等一拍：另一条探测（DevOps Agent）是真的会打的，等它落地才说明 effect 都跑过了。
    await waitFor(() => expect(segs().length).toBe(2));
    expect(soProbes).toBe(0);
  });

  it("已经落过盘的 STAROps 会话退回 NotiOps", async () => {
    const onPick = vi.fn();
    render(<ChatObjectPicker devopsChat={false} starops onPick={onPick} />);
    await waitFor(() => expect(onPick).toHaveBeenCalledWith("notiops"));
  });
});
