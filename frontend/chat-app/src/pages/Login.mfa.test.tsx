/**
 * 登录页的两步验证步骤（2026-10-29）。判据：
 *   ① 用户池「强制」档、用户还没绑：signIn 回 CONTINUE_SIGN_IN_WITH_TOTP_SETUP → 页面显示**本地生成**的二维码
 *      （<svg>，不是外链图片 —— 二维码里带着密钥）+ 4 位一组的密钥 + 6 位码输入；提交的是这 6 位码；
 *   ② 已绑定：CONFIRM_SIGN_IN_WITH_TOTP_CODE → 只要 6 位码；
 *   ③ **链式**：管理员新建的用户先改密码，紧接着还要绑定 —— 改密码那一步的返回值必须继续往下走，
 *      旧代码只看 isSignedIn，到这里就卡住不动了；
 *   ④ 不认识的步骤照实报名字，不假装登录成功；
 *   ⑤ 登录时绑定成功后补一句「启用 + 首选」（只登记不启用的话，「管理」页门禁当他没绑）；只输码登录时不补；
 *      补的那一句失败也照样登录。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/pages/Login.mfa.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const amp = vi.hoisted(() => ({ signIn: vi.fn(), confirmSignIn: vi.fn(), updateMFAPreference: vi.fn() }));
vi.mock("aws-amplify/auth", () => amp);

import Login from "./Login";

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const setupStep = () => ({
  isSignedIn: false,
  nextStep: {
    signInStep: "CONTINUE_SIGN_IN_WITH_TOTP_SETUP",
    totpSetupDetails: {
      sharedSecret: SECRET,
      getSetupUri: (app: string, acct?: string) =>
        new URL(`otpauth://totp/${app}:${acct}?secret=${SECRET}&issuer=${app}`),
    },
  },
});
const done = { isSignedIn: true, nextStep: { signInStep: "DONE" } };

const typeInto = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const fillPassword = () => {
  fireEvent.change(document.querySelector("input[autocomplete=username]")!, { target: { value: "alice" } });
  fireEvent.change(document.querySelector("input[autocomplete=current-password]")!, { target: { value: "pw" } });
};
const submit = () => fireEvent.submit(document.querySelector("form")!);

beforeEach(() => {
  cleanup(); amp.signIn.mockReset(); amp.confirmSignIn.mockReset();
  amp.updateMFAPreference.mockReset(); amp.updateMFAPreference.mockResolvedValue(undefined);
});

describe("登录页：两步验证", () => {
  it("① 首次绑定：本地二维码 + 分组密钥 + 6 位码，提交的就是那 6 位", async () => {
    amp.signIn.mockResolvedValue(setupStep());
    amp.confirmSignIn.mockResolvedValue(done);
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    fillPassword();
    submit();
    await screen.findByText("Set up two-step verification");

    const qr = screen.getByRole("img", { name: "Authenticator setup QR code" });
    expect(qr.tagName.toLowerCase()).toBe("svg");
    expect(document.querySelectorAll("img").length).toBe(0); // 没有任何外链图片
    expect(screen.getByText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")).toBeTruthy();

    const verify = screen.getByRole("button", { name: "Verify and sign in" }) as HTMLButtonElement;
    expect(verify.disabled).toBe(true); // 不满 6 位不让提交
    typeInto("Verification code", "12 34-56");
    expect((screen.getByLabelText("Verification code") as HTMLInputElement).value).toBe("123456");
    submit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(amp.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: "123456" });
    expect(amp.updateMFAPreference).toHaveBeenCalledWith({ totp: "PREFERRED" });
    expect(amp.updateMFAPreference.mock.invocationCallOrder[0])
      .toBeLessThan(onSignedIn.mock.invocationCallOrder[0]); // 进应用之前就启用好，第一次 /me/mfa 就看得到
  });

  it("② 已绑定：只要 6 位码", async () => {
    amp.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" } });
    amp.confirmSignIn.mockResolvedValue(done);
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    fillPassword();
    submit();
    await screen.findByText("Two-step verification");
    expect(screen.queryByRole("img", { name: "Authenticator setup QR code" })).toBeNull();
    typeInto("Verification code", "654321");
    submit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(amp.confirmSignIn).toHaveBeenCalledWith({ challengeResponse: "654321" });
    expect(amp.updateMFAPreference).not.toHaveBeenCalled();
  });

  it("③ 链式：先改密码，接着绑定验证器，再登录成功", async () => {
    amp.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED" } });
    amp.confirmSignIn.mockResolvedValueOnce(setupStep()).mockResolvedValueOnce(done);
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    fillPassword();
    submit();
    await screen.findByText("Set a new password");
    fireEvent.change(document.querySelector("input[autocomplete=new-password]")!, { target: { value: "N3wPassword" } });
    submit();
    await screen.findByText("Set up two-step verification");
    expect(onSignedIn).not.toHaveBeenCalled();
    typeInto("Verification code", "111222");
    submit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(amp.confirmSignIn.mock.calls.map((c) => c[0])).toEqual([
      { challengeResponse: "N3wPassword" }, { challengeResponse: "111222" },
    ]);
  });

  it("⑤ 绑定后「启用 + 首选」失败：照样登录", async () => {
    amp.signIn.mockResolvedValue(setupStep());
    amp.confirmSignIn.mockResolvedValue(done);
    amp.updateMFAPreference.mockRejectedValue(new Error("TooManyRequestsException"));
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    fillPassword();
    submit();
    await screen.findByText("Set up two-step verification");
    typeInto("Verification code", "123456");
    submit();
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/TooManyRequestsException/)).toBeNull();
  });

  it("④ 不认识的步骤：照实报名字，不登录", async () => {
    amp.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_SMS_CODE" } });
    const onSignedIn = vi.fn();
    render(<Login onSignedIn={onSignedIn} />);
    fillPassword();
    submit();
    await screen.findByText(/CONFIRM_SIGN_IN_WITH_SMS_CODE/);
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it("「Start over」回到用户名密码那一步", async () => {
    amp.signIn.mockResolvedValue({ isSignedIn: false, nextStep: { signInStep: "CONFIRM_SIGN_IN_WITH_TOTP_CODE" } });
    render(<Login onSignedIn={vi.fn()} />);
    fillPassword();
    submit();
    await screen.findByText("Two-step verification");
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(screen.getByText("Sign in to NotiOps")).toBeTruthy();
    expect(document.querySelector("input[autocomplete=current-password]")).not.toBeNull();
  });
});
