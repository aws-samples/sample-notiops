/**
 * 两步验证设置框（2026-10-29）。判据：
 *   · 开启 = setUpTOTP → 本地二维码 → verifyTOTPSetup(6 位码) → updateMFAPreference(totp: PREFERRED) → onChanged；
 *     **顺序不能乱**：没验证过就设 PREFERRED，Cognito 会拒；验证完不设 PREFERRED，「可选」档下登录不会要验证码；
 *   · 「关闭」只在「可选」档 + 已开启时出现；「强制」档没有关闭、只有一句说明；
 *   · 「管理」页弹出的（reason=admin）顶上多一句为什么；
 *   · 扫码这一步点遮罩不关（误点就得重新生成密钥）；
 *   · 失败照实显示，不装成功。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/TwoFactorDialog.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

const amp = vi.hoisted(() => ({ setUpTOTP: vi.fn(), verifyTOTPSetup: vi.fn(), updateMFAPreference: vi.fn() }));
vi.mock("aws-amplify/auth", () => amp);

import { STRINGS } from "../i18n";
import TwoFactorDialog from "./TwoFactorDialog";

const zh = (k: string) => STRINGS[k].zh;
const SECRET = "ABCDEFGHABCDEFGH";
const details = {
  sharedSecret: SECRET,
  getSetupUri: (app: string, acct?: string) => new URL(`otpauth://totp/${app}:${acct}?secret=${SECRET}&issuer=${app}`),
};
const btn = (k: string) => screen.getByRole("button", { name: zh(k) }) as HTMLButtonElement;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  amp.setUpTOTP.mockReset().mockResolvedValue(details);
  amp.verifyTOTPSetup.mockReset().mockResolvedValue(undefined);
  amp.updateMFAPreference.mockReset().mockResolvedValue(undefined);
});

describe("两步验证设置框", () => {
  it("开启：扫码 → 输码 → 验证 → 设为首选 → 刷新状态，按这个顺序", async () => {
    const order: string[] = [];
    amp.verifyTOTPSetup.mockImplementation(async () => { order.push("verify"); });
    amp.updateMFAPreference.mockImplementation(async () => { order.push("prefer"); });
    const onChanged = vi.fn(async () => { order.push("refresh"); });
    render(<TwoFactorDialog mode="OPTIONAL" enrolled={false} username="alice" reason="menu"
                            onClose={vi.fn()} onChanged={onChanged} />);
    fireEvent.click(btn("mfa.enable"));
    await screen.findByText(zh("mfa.scan"));
    expect(screen.getByRole("img", { name: zh("mfa.qrLabel") }).tagName.toLowerCase()).toBe("svg");
    expect(screen.getByText("ABCD EFGH ABCD EFGH")).toBeTruthy();
    expect(btn("mfa.verify").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(zh("mfa.codeLabel")), { target: { value: "123456" } });
    fireEvent.click(btn("mfa.verify"));
    await screen.findByText(zh("mfa.enabledOk"));
    expect(amp.verifyTOTPSetup).toHaveBeenCalledWith({ code: "123456" });
    expect(amp.updateMFAPreference).toHaveBeenCalledWith({ totp: "PREFERRED" });
    expect(order).toEqual(["verify", "prefer", "refresh"]);
  });

  it("验证码错了：照实报错，不设首选、不刷新", async () => {
    amp.verifyTOTPSetup.mockRejectedValue(new Error("Code mismatch"));
    const onChanged = vi.fn();
    render(<TwoFactorDialog mode="OPTIONAL" enrolled={false} username="alice" reason="menu"
                            onClose={vi.fn()} onChanged={onChanged} />);
    fireEvent.click(btn("mfa.enable"));
    await screen.findByText(zh("mfa.scan"));
    fireEvent.change(screen.getByLabelText(zh("mfa.codeLabel")), { target: { value: "000000" } });
    fireEvent.click(btn("mfa.verify"));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("Code mismatch");
    expect(amp.updateMFAPreference).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("「可选」档、已开启：有「换一个验证器」和「关闭」；关闭要确认", async () => {
    const onChanged = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TwoFactorDialog mode="OPTIONAL" enrolled={true} username="alice" reason="menu"
                            onClose={vi.fn()} onChanged={onChanged} />);
    expect(btn("mfa.rebind")).toBeTruthy();
    fireEvent.click(btn("mfa.disable"));
    await screen.findByText(zh("mfa.disabledOk"));
    expect(confirm).toHaveBeenCalled();
    expect(amp.updateMFAPreference).toHaveBeenCalledWith({ totp: "DISABLED" });
    expect(onChanged).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });

  it("「强制」档：没有「关闭」，有一句说明", () => {
    render(<TwoFactorDialog mode="REQUIRED" enrolled={true} username="alice" reason="menu"
                            onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: zh("mfa.disable") })).toBeNull();
    expect(screen.getByText(zh("mfa.requiredNote"))).toBeTruthy();
  });

  it("「管理」页弹出的：顶上说明为什么", () => {
    render(<TwoFactorDialog mode="OPTIONAL" enrolled={false} username="alice" reason="admin"
                            onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText(zh("mfa.adminReason"))).toBeTruthy();
  });

  it("扫码这一步点遮罩不关；状态页点遮罩会关", async () => {
    const onClose = vi.fn();
    render(<TwoFactorDialog mode="OPTIONAL" enrolled={false} username="alice" reason="menu"
                            onClose={onClose} onChanged={vi.fn()} />);
    fireEvent.click(document.querySelector(".cz-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(btn("mfa.enable"));
    await screen.findByText(zh("mfa.scan"));
    fireEvent.click(document.querySelector(".cz-overlay")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("读不到状态（mode=null）：只说稍后再试，不给开启按钮", () => {
    render(<TwoFactorDialog mode={null} enrolled={null} username="alice" reason="menu"
                            onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByText(zh("mfa.unavailable"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: zh("mfa.enable") })).toBeNull();
  });
});
