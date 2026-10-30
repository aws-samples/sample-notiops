/**
 * 「管理」页与两步验证（2026-10-29）。判据：
 *   · 还没开、而用户池要求管理页先开（mfaBlocked）：只显示门禁提示 + 「现在开启」，**一个管理请求都不发**
 *     （发了也是一排 403）；
 *   · 用户列表在「可选 / 强制」档显示每人开没开，已开的人有「重置两步验证」（不能对自己）；
 *     「关闭」档整列不显示；
 *   · api/admin.ts 收到 403 mfa_required 时广播事件（ChatApp 收到就弹设置框），并照常抛错。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/AdminPanel.mfa.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  fetchAllCapabilities: vi.fn(async () => []),
  fetchUsers: vi.fn(async () => [
    { username: "alice", sub: "s-alice", status: "CONFIRMED", roles: [], denies: [], mfa: true },
    { username: "bob", sub: "s-bob", status: "CONFIRMED", roles: [], denies: [], mfa: true },
    { username: "carol", sub: "s-carol", status: "CONFIRMED", roles: [], denies: [], mfa: false },
  ]),
  fetchRoles: vi.fn(async () => []),
  resetUserMfa: vi.fn(async () => ({ ok: true, signedOut: true })),
}));
vi.mock("../api/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/admin")>();
  return { ...actual, ...api };
});

import { STRINGS } from "../i18n";
import AdminPanel from "./AdminPanel";

const zh = (k: string) => STRINGS[k].zh;

beforeEach(() => {
  cleanup();
  for (const f of Object.values(api)) f.mockClear();
});

const openUsers = () => {
  const navBtn = Array.from(document.querySelectorAll("button.notif-navitem"))
    .find((b) => (b.textContent || "").includes(zh("admin.tab.users")))!;
  fireEvent.click(navBtn);
};

describe("「管理」页：两步验证门禁", () => {
  it("还没开：只有提示和「现在开启」，不发任何管理请求", () => {
    const onSetupMfa = vi.fn();
    render(<AdminPanel mfaMode="OPTIONAL" mfaBlocked onSetupMfa={onSetupMfa} currentUsername="alice" />);
    expect(screen.getByText(zh("mfa.gate.title"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: zh("mfa.gate.button") }));
    expect(onSetupMfa).toHaveBeenCalledTimes(1);
    expect(api.fetchAllCapabilities).not.toHaveBeenCalled();
    expect(document.querySelector("button.notif-navitem")).toBeNull();
  });

  it("两步验证状态还没回来：什么都不发，回来之后才拉", async () => {
    const { rerender } = render(<AdminPanel mfaMode={null} mfaBlocked={false} mfaPending currentUsername="alice" />);
    expect(api.fetchAllCapabilities).not.toHaveBeenCalled();
    rerender(<AdminPanel mfaMode="OPTIONAL" mfaBlocked={false} mfaPending={false} currentUsername="alice" />);
    await waitFor(() => expect(api.fetchAllCapabilities).toHaveBeenCalledTimes(1));
  });

  it("已开：正常渲染并拉能力清单", async () => {
    render(<AdminPanel mfaMode="OPTIONAL" mfaBlocked={false} currentUsername="alice" />);
    await waitFor(() => expect(api.fetchAllCapabilities).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(zh("mfa.gate.title"))).toBeNull();
  });
});

describe("用户列表：两步验证一列 + 重置", () => {
  it("显示每人开没开；已开的别人有「重置」，自己没有；确认后调 resetUserMfa", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AdminPanel mfaMode="OPTIONAL" mfaBlocked={false} currentUsername="alice" />);
    openUsers();
    await screen.findByText("bob");
    expect(screen.getAllByText(zh("admin.users.mfaOn"))).toHaveLength(2);
    expect(screen.getAllByText(zh("admin.users.mfaOff"))).toHaveLength(1);
    const resets = screen.getAllByRole("button", { name: zh("admin.users.mfaReset") });
    expect(resets).toHaveLength(1); // bob；alice 是自己，carol 没开
    fireEvent.click(resets[0]);
    await waitFor(() => expect(api.resetUserMfa).toHaveBeenCalledWith("bob"));
    await screen.findByText(zh("admin.users.mfaResetDone").replace("{name}", "bob"));
    confirm.mockRestore();
  });

  it("「关闭」档：整列不显示、没有重置按钮", async () => {
    render(<AdminPanel mfaMode="OFF" mfaBlocked={false} currentUsername="alice" />);
    openUsers();
    await screen.findByText("bob");
    expect(screen.queryByText(zh("admin.users.mfaOn"))).toBeNull();
    expect(screen.queryByRole("button", { name: zh("admin.users.mfaReset") })).toBeNull();
  });
});
