/**
 * 「管理 → 用户」：新建用户邮箱必填、邮箱一列、替人重置密码、给用户设邮箱（2026-10-30，待办 #45）。判据：
 *   · 新建用户：没填邮箱「新建」按钮就是灰的；填了不像邮箱的 → 人话报错、不发请求；填对了 → createUser(用户名, 邮箱)；
 *   · 列表：有已验证邮箱的人显示邮箱；没有的显示「未绑定邮箱」（忘了密码只能由管理员重置）；
 *   · 重置密码：别人有按钮、自己没有；确认后调 resetUserPassword，临时密码就显示在**那个人的卡片里**；
 *   · 展开编辑里「保存邮箱」→ setUserEmail(用户名, 邮箱)；服务端回 email_in_use → 人话。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/AdminPanel.password.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const api = vi.hoisted(() => ({
  fetchAllCapabilities: vi.fn(async () => []),
  fetchUsers: vi.fn(async () => [
    { username: "alice", sub: "s-alice", status: "CONFIRMED", roles: [], denies: [], email: "alice@example.com", emailVerified: true },
    { username: "bob", sub: "s-bob", status: "CONFIRMED", roles: [], denies: [], email: null, emailVerified: false },
  ]),
  fetchRoles: vi.fn(async () => []),
  createUser: vi.fn(async (username: string, email: string) => ({ username, email, tempPassword: "Aa1NEWUSER" })),
  resetUserPassword: vi.fn(async (username: string) => ({ username, tempPassword: "Aa1RESETPW", signedOut: true })),
  setUserEmail: vi.fn(async (username: string, email: string) => ({ username, email, emailVerified: true })),
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

const openUsers = async () => {
  render(<AdminPanel mfaMode="OFF" mfaBlocked={false} currentUsername="alice" />);
  const navBtn = Array.from(document.querySelectorAll("button.notif-navitem"))
    .find((b) => (b.textContent || "").includes(zh("admin.tab.users")))!;
  fireEvent.click(navBtn);
  await screen.findByText("bob");
};
const newBtn = () => screen.getByRole("button", { name: zh("admin.users.new") }) as HTMLButtonElement;

describe("新建用户：邮箱必填", () => {
  it("没填邮箱按钮是灰的；不像邮箱 → 人话、不发请求；填对了才建", async () => {
    await openUsers();
    fireEvent.change(screen.getByPlaceholderText(zh("admin.users.username")), { target: { value: "dave" } });
    expect(newBtn().disabled).toBe(true);
    expect(zh("admin.users.email")).toContain("必填");

    fireEvent.change(screen.getByLabelText(zh("admin.users.email")), { target: { value: "dave" } });
    fireEvent.click(newBtn());
    expect(await screen.findByText(zh("admin.users.err.invalid_email"))).toBeTruthy();
    expect(api.createUser).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(zh("admin.users.email")), { target: { value: " dave@example.com " } });
    fireEvent.click(newBtn());
    await waitFor(() => expect(api.createUser).toHaveBeenCalledWith("dave", "dave@example.com"));
    expect(await screen.findByText("Aa1NEWUSER")).toBeTruthy();
  });

  it("服务端说邮箱被别人用了 → 人话", async () => {
    api.createUser.mockRejectedValueOnce(new Error("email_in_use"));
    await openUsers();
    fireEvent.change(screen.getByPlaceholderText(zh("admin.users.username")), { target: { value: "erin" } });
    fireEvent.change(screen.getByLabelText(zh("admin.users.email")), { target: { value: "alice@example.com" } });
    fireEvent.click(newBtn());
    expect(await screen.findByText(zh("admin.users.err.email_in_use"))).toBeTruthy();
  });
});

describe("用户列表：邮箱一列 + 重置密码 + 设邮箱", () => {
  it("有已验证邮箱显示邮箱，没有的标「未绑定邮箱」", async () => {
    await openUsers();
    expect(screen.getByText("alice@example.com")).toBeTruthy();
    const pill = screen.getByText(zh("admin.users.emailNone"));
    expect(pill.getAttribute("title")).toBe(zh("admin.users.emailNoneHint"));
  });

  it("重置密码：只有别人有按钮；确认后调接口，临时密码显示在他的卡片里", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openUsers();
    const btns = screen.getAllByRole("button", { name: zh("admin.users.pwReset") });
    expect(btns).toHaveLength(1); // bob；alice 是自己
    fireEvent.click(btns[0]);
    await waitFor(() => expect(api.resetUserPassword).toHaveBeenCalledWith("bob"));
    expect(confirm.mock.calls[0][0]).toContain("bob");
    const code = await screen.findByText("Aa1RESETPW");
    expect(screen.getByText(zh("admin.users.pwResetNote"))).toBeTruthy();
    expect(code.closest("div")?.parentElement?.parentElement?.textContent).toContain("bob");
    confirm.mockRestore();
  });

  it("取消确认 → 不调接口", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openUsers();
    fireEvent.click(screen.getByRole("button", { name: zh("admin.users.pwReset") }));
    expect(api.resetUserPassword).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("展开编辑里给没邮箱的人设邮箱 → setUserEmail", async () => {
    await openUsers();
    fireEvent.click(screen.getByText("bob"));
    const input = await screen.findByLabelText(zh("admin.users.emailLabel"));
    fireEvent.change(input, { target: { value: "bob@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: zh("admin.users.emailSave") }));
    await waitFor(() => expect(api.setUserEmail).toHaveBeenCalledWith("bob", "bob@example.com"));
    expect(await screen.findByText(zh("admin.users.emailSaved"))).toBeTruthy();
  });
});
