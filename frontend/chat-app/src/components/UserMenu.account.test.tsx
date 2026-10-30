/**
 * 左下角菜单的「账户与密码」一项 + 没绑邮箱的提示点（2026-10-30，待办 #45）。
 * UserMenu.footer / UserMenu.mfa 两个测试钉的菜单项清单在**不传 onAccount** 时照旧成立；这里钉传了之后的样子：
 *   · 多一项「账户与密码」，在「两步验证」之前；点了调 onAccount 并收起菜单；
 *   · 没有已验证邮箱（accountNudge）：头像和这一项上各一个提示点，菜单里多一句为什么要绑；有邮箱时都没有。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/UserMenu.account.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { STRINGS } from "../i18n";
import UserMenu from "./UserMenu";

const zh = (k: string) => STRINGS[k].zh;
const items = () => Array.from(document.querySelectorAll(".usermenu .um-item")).map((el) => (el.textContent || "").trim());
const open = () => fireEvent.click(document.querySelector("button.sb-foot")!);

beforeEach(() => { cleanup(); localStorage.clear(); });

describe("菜单里的「账户与密码」", () => {
  it("多一项，在两步验证之前；点了调 onAccount 并收起菜单", () => {
    const onAccount = vi.fn();
    render(<UserMenu username="alice" onSignOut={vi.fn()} mfaMode="OPTIONAL" onTwoFactor={vi.fn()} onAccount={onAccount} />);
    open();
    expect(items()).toEqual([zh("menu.appearance"), zh("menu.language"), zh("menu.account"), zh("mfa.title"), zh("login.signout")]);
    fireEvent.click(screen.getByText(zh("menu.account")).closest("button")!);
    expect(onAccount).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".usermenu")).toBeNull();
  });

  it("没绑邮箱：头像和菜单项上有提示点，并说明为什么要绑", () => {
    render(<UserMenu username="alice" onSignOut={vi.fn()} onAccount={vi.fn()} accountNudge />);
    expect(document.querySelector(".sb-foot .avatar-dot")).toBeTruthy();
    expect(document.querySelector(".sb-foot .avatar")?.getAttribute("title")).toBe(zh("menu.account.nudge"));
    open();
    expect(document.querySelector(".usermenu .um-dot")).toBeTruthy();
    expect(screen.getByText(zh("menu.account.nudge"))).toBeTruthy();
  });

  it("有邮箱：没有提示点", () => {
    render(<UserMenu username="alice" onSignOut={vi.fn()} onAccount={vi.fn()} accountNudge={false} />);
    expect(document.querySelector(".sb-foot .avatar-dot")).toBeNull();
    open();
    expect(document.querySelector(".usermenu .um-dot")).toBeNull();
    expect(screen.queryByText(zh("menu.account.nudge"))).toBeNull();
  });
});
