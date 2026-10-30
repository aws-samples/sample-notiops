/**
 * 「账户与密码」框（2026-10-30，待办 #45）。判据：
 *   · 没绑邮箱：写明「还没有绑定」+ 为什么要绑；绑定 = updateUserAttribute → 输码 → confirmUserAttribute，
 *     成功后通知上层（菜单上的提示点消失）；新邮箱是别人的登录别名 → 人话；
 *   · 修改密码：两次不一致当场拦下；一致才 updatePassword(旧, 新)；旧密码不对（NotAuthorized）→ 人话；
 *   · 退出所有设备：确认后 signOut({ global: true })，再回到登录页。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/AccountDialog.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const amp = vi.hoisted(() => ({
  fetchUserAttributes: vi.fn(), updateUserAttribute: vi.fn(), confirmUserAttribute: vi.fn(),
  sendUserAttributeVerificationCode: vi.fn(), updatePassword: vi.fn(), signOut: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => amp);

import { STRINGS } from "../i18n";
import AccountDialog from "./AccountDialog";

const zh = (k: string) => STRINGS[k].zh;
const props = () => ({ onClose: vi.fn(), onEmailChanged: vi.fn(), onSignedOut: vi.fn() });

beforeEach(() => {
  cleanup();
  for (const f of Object.values(amp)) f.mockReset();
  amp.updateUserAttribute.mockResolvedValue({ isUpdated: false, nextStep: { updateAttributeStep: "CONFIRM_ATTRIBUTE_WITH_CODE" } });
  amp.confirmUserAttribute.mockResolvedValue(undefined);
  amp.updatePassword.mockResolvedValue(undefined);
  amp.signOut.mockResolvedValue(undefined);
});

describe("账户与密码：邮箱", () => {
  it("没绑邮箱 → 绑定：发码、输码、确认，成功后通知上层", async () => {
    amp.fetchUserAttributes
      .mockResolvedValueOnce({ sub: "s1" })
      .mockResolvedValueOnce({ sub: "s1", email: "me@example.com", email_verified: "true" });
    const p = props();
    render(<AccountDialog {...p} />);
    expect(await screen.findByText(zh("account.email.none"))).toBeTruthy();
    expect(screen.getByText(zh("account.email.hintMissing"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: zh("account.email.add") }));
    fireEvent.change(screen.getByLabelText(zh("account.email.newLabel")), { target: { value: "me@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: zh("account.email.send") }));
    await waitFor(() => expect(amp.updateUserAttribute).toHaveBeenCalledWith({ userAttribute: { attributeKey: "email", value: "me@example.com" } }));
    fireEvent.change(await screen.findByLabelText(zh("account.email.codeLabel")), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: zh("account.email.confirm") }));
    await waitFor(() => expect(amp.confirmUserAttribute).toHaveBeenCalledWith({ userAttributeKey: "email", confirmationCode: "123456" }));
    await waitFor(() => expect(p.onEmailChanged).toHaveBeenCalledWith(true));
    expect(await screen.findByText("me@example.com")).toBeTruthy();
    expect(screen.getByText(zh("account.email.verified"))).toBeTruthy();
  });

  it("新邮箱已经是别人的登录别名 → 人话", async () => {
    amp.fetchUserAttributes.mockResolvedValue({ email: "old@example.com", email_verified: "true" });
    amp.confirmUserAttribute.mockRejectedValueOnce(Object.assign(new Error("raw"), { name: "AliasExistsException" }));
    render(<AccountDialog {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: zh("account.email.change") }));
    fireEvent.change(screen.getByLabelText(zh("account.email.newLabel")), { target: { value: "taken@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: zh("account.email.send") }));
    fireEvent.change(await screen.findByLabelText(zh("account.email.codeLabel")), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: zh("account.email.confirm") }));
    expect(await screen.findByText(zh("account.err.AliasExistsException"))).toBeTruthy();
  });
});

describe("账户与密码：密码与登录设备", () => {
  beforeEach(() => { amp.fetchUserAttributes.mockResolvedValue({ email: "me@example.com", email_verified: "true" }); });

  it("修改密码：不一致拦下；一致才提交；旧密码不对 → 人话", async () => {
    render(<AccountDialog {...props()} />);
    fireEvent.click(await screen.findByRole("button", { name: zh("account.password.change") }));
    fireEvent.change(screen.getByLabelText(zh("account.password.old")), { target: { value: "OldPass123" } });
    fireEvent.change(screen.getByLabelText(zh("account.password.new")), { target: { value: "NewPass123" } });
    fireEvent.change(screen.getByLabelText(zh("account.password.confirm")), { target: { value: "NewPass12" } });
    fireEvent.click(screen.getByRole("button", { name: zh("account.password.save") }));
    expect(await screen.findByText(zh("account.password.mismatch"))).toBeTruthy();
    expect(amp.updatePassword).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(zh("account.password.confirm")), { target: { value: "NewPass123" } });
    amp.updatePassword.mockRejectedValueOnce(Object.assign(new Error("raw"), { name: "NotAuthorizedException" }));
    fireEvent.click(screen.getByRole("button", { name: zh("account.password.save") }));
    expect(await screen.findByText(zh("account.err.NotAuthorizedException"))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: zh("account.password.save") }));
    await waitFor(() => expect(amp.updatePassword).toHaveBeenLastCalledWith({ oldPassword: "OldPass123", newPassword: "NewPass123" }));
    expect(await screen.findByText(zh("account.password.done"))).toBeTruthy();
  });

  it("退出所有设备：确认后全局登出并回到登录页；取消则什么都不做", async () => {
    const p = props();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<AccountDialog {...p} />);
    const btn = await screen.findByRole("button", { name: zh("account.signout.button") });
    fireEvent.click(btn);
    expect(amp.signOut).not.toHaveBeenCalled();
    fireEvent.click(btn);
    await waitFor(() => expect(amp.signOut).toHaveBeenCalledWith({ global: true }));
    await waitFor(() => expect(p.onSignedOut).toHaveBeenCalled());
    confirm.mockRestore();
  });
});
