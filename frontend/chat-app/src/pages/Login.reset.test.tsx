/**
 * 登录页：忘记密码（2026-10-30，待办 #45）。判据：
 *   ① 「Forgot password?」→ 用户名带过去 → Send code 调 resetPassword；之后只显示通用提示，**不显示投递地址**
 *      （用户池开着 PreventUserExistenceErrors，不存在的账号 Cognito 也回一个随机的模拟地址）；
 *   ①b 账号存在但没有已验证邮箱：Cognito 回 InvalidParameterException（临时用户池实测）→ 明说请管理员重置，停在这一步；
 *   ② 两次新密码不一致 → 当场拦下、不调接口；一致 → confirmResetPassword(用户名, 码, 新密码) → 回到登录这一步，
 *      用户名已填好、提示「已重置，用新密码登录」，**不自动登录**；
 *   ③ Cognito 报错名 → 能照着做的话（码不对 / 过期 / 次数太多 / 密码不合规）；
 *   ④ signIn 回 RESET_PASSWORD（管理员在 Cognito 控制台点过「重置密码」）→ 直接到输码这一步，并能重新发码；
 *      原来这里报 not supported。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/pages/Login.reset.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const amp = vi.hoisted(() => ({
  signIn: vi.fn(), confirmSignIn: vi.fn(), updateMFAPreference: vi.fn(),
  resetPassword: vi.fn(), confirmResetPassword: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => amp);

import Login from "./Login";

const sent = {
  isPasswordReset: false,
  nextStep: {
    resetPasswordStep: "CONFIRM_RESET_PASSWORD_WITH_CODE",
    codeDeliveryDetails: { deliveryMedium: "EMAIL", destination: "r***@x***", attributeName: "email" },
  },
};
const submit = () => fireEvent.submit(document.querySelector("form")!);
const typeInto = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const goForgot = (username = "alice") => {
  fireEvent.change(document.querySelector("input[autocomplete=username]")!, { target: { value: username } });
  fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
};

beforeEach(() => {
  cleanup();
  for (const f of Object.values(amp)) f.mockReset();
  amp.resetPassword.mockResolvedValue(sent);
  amp.confirmResetPassword.mockResolvedValue(undefined);
});

describe("登录页：忘记密码", () => {
  it("① 发码：用户名带过去；只给通用提示，不显示投递地址", async () => {
    render(<Login onSignedIn={vi.fn()} />);
    goForgot();
    expect(screen.getByText("Reset your password")).toBeTruthy();
    expect((screen.getByLabelText("Username or email") as HTMLInputElement).value).toBe("alice");
    submit();
    await waitFor(() => expect(amp.resetPassword).toHaveBeenCalledWith({ username: "alice" }));
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/If this account has a verified email address/);
    expect(document.body.textContent).not.toContain("r***@x***");
    expect(screen.getByLabelText("Verification code")).toBeTruthy();
  });

  it("①b 没有已验证邮箱（InvalidParameterException）→ 明说找管理员，停在这一步", async () => {
    amp.resetPassword.mockRejectedValueOnce(Object.assign(new Error("Cannot reset password for the user as there is no registered/verified email or phone_number"), { name: "InvalidParameterException" }));
    render(<Login onSignedIn={vi.fn()} />);
    goForgot("bob");
    submit();
    expect(await screen.findByText(/has no verified email address/)).toBeTruthy();
    expect(screen.getByText(/Ask your administrator to reset your password/)).toBeTruthy();
    expect(screen.getByLabelText("Username or email")).toBeTruthy();
    expect(screen.queryByLabelText("Verification code")).toBeNull();
  });

  it("② 两次密码不一致当场拦下；一致才提交，回到登录这一步且不自动登录", async () => {
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    goForgot();
    submit();
    await screen.findByLabelText("Verification code");
    typeInto("Verification code", "123456");
    typeInto("New password", "NewPass123");
    typeInto("Confirm new password", "NewPass124");
    submit();
    expect(await screen.findByText("The two passwords do not match.")).toBeTruthy();
    expect(amp.confirmResetPassword).not.toHaveBeenCalled();

    typeInto("Confirm new password", "NewPass123");
    submit();
    await waitFor(() => expect(amp.confirmResetPassword).toHaveBeenCalledWith(
      { username: "alice", confirmationCode: "123456", newPassword: "NewPass123" }));
    expect(await screen.findByText("Sign in to NotiOps")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Your password has been reset");
    expect((document.querySelector("input[autocomplete=username]") as HTMLInputElement).value).toBe("alice");
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(amp.signIn).not.toHaveBeenCalled();
  });

  it("③ Cognito 报错 → 人话", async () => {
    render(<Login onSignedIn={vi.fn()} />);
    goForgot();
    submit();
    await screen.findByLabelText("Verification code");
    typeInto("Verification code", "000000");
    typeInto("New password", "NewPass123");
    typeInto("Confirm new password", "NewPass123");
    for (const [name, text] of [
      ["CodeMismatchException", /That code is not right/],
      ["ExpiredCodeException", /That code has expired/],
      ["LimitExceededException", /Too many attempts/],
      ["InvalidPasswordException", /does not meet the rules/],
    ] as const) {
      amp.confirmResetPassword.mockRejectedValueOnce(Object.assign(new Error("raw"), { name }));
      submit();
      expect(await screen.findByText(text)).toBeTruthy();
    }
  });

  it("④ RESET_PASSWORD 步骤（管理员在控制台点过重置）→ 输码这一步，能重新发码", async () => {
    amp.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: "RESET_PASSWORD" } });
    render(<Login onSignedIn={vi.fn()} />);
    fireEvent.change(document.querySelector("input[autocomplete=username]")!, { target: { value: "bob" } });
    fireEvent.change(document.querySelector("input[autocomplete=current-password]")!, { target: { value: "old" } });
    submit();
    expect(await screen.findByText(/Your password has to be reset before you can sign in/)).toBeTruthy();
    expect(screen.queryByText(/not supported/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    await waitFor(() => expect(amp.resetPassword).toHaveBeenCalledWith({ username: "bob" }));
  });

  it("「Back to sign in」回到登录这一步", async () => {
    render(<Login onSignedIn={vi.fn()} />);
    goForgot();
    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(screen.getByText("Sign in to NotiOps")).toBeTruthy();
  });
});
