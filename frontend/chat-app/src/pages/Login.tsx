import { useState } from "react";
import {
  signIn, confirmSignIn, updateMFAPreference, resetPassword, confirmResetPassword, type SignInOutput,
} from "aws-amplify/auth";
import Logo from "../components/Logo";
import QrCode from "../components/QrCode";
import { TOTP_ISSUER, groupSecret, cleanCode } from "../auth/totp";

/**
 * 自定义登录表单（Amplify v6 无内置 Authenticator）。
 * 登录页固定英文（无语言切换）。
 *
 * 按 Cognito（经 Amplify）返回的下一步一步步走，而且是**链式**的：管理员建的新用户第一次登录先改密码，
 * 用户池「强制两步验证」时紧接着还要绑定验证器（2026-10-29 起，见 infra/lib/constructs/web-mfa.ts）。
 * 只认这几步；遇到别的步骤照实报出名字，不猜。
 *
 * 登录时绑定（Cognito 的 MFA_SETUP）只**登记**验证器，不把它设成「已启用」：之后每次登录照样要码，但
 * AdminGetUser 里看不出他绑过 ——「管理」页门禁和左下角菜单就会当他没开，要他再绑一次（v1.0.34 RC 在验证账号上
 * 测出来的，2026-10-29）。所以绑定成功、拿到令牌后补一句「启用 + 首选」；这一句失败不影响登录，菜单里显示
 * 「未开启」，在那里开一次就好。
 *
 * 忘记密码（2026-10-30，待办 #45）：「Forgot password?」→ Cognito ForgotPassword 把验证码发到**已验证**邮箱
 * （1 小时有效）→ 输码 + 新密码（ConfirmForgotPassword）→ 回到登录这一步，用新密码正常登录（不自动登录）。
 *   · 浏览器直连 Cognito 的公开接口，和登录一样，BFF 不经手。
 *   · 用户池开着 PreventUserExistenceErrors：账号**不存在**时 Cognito 回一个**模拟的**投递结果（地址是随机的），
 *     所以成功时只说「如果有已验证邮箱，码已经发过去了」，**不显示投递地址**。
 *     ⚠️ 账号存在但**没有已验证邮箱**时，Cognito 实际回的是 InvalidParameterException（2026-10-30 临时用户池实测，
 *     和文档说的「也回模拟结果」不一样）—— 这时明说「这个账号没有已验证邮箱，请管理员重置」。这句话不比 Cognito
 *     公开接口本身多泄露什么（任何人拿 client id 直接调都能看到同一个错误），却能让没邮箱的人不白等一封不会来的信。
 *   · 两步验证不受影响：开了验证器的人，重置后登录照样要 6 位码。
 *   · Cognito 的 RESET_PASSWORD 步骤（管理员在 Cognito 控制台点过「重置密码」= AdminResetUserPassword）也落到
 *     输码这一步；原来这里会报 not supported。
 */
type Step =
  | { kind: "password" }
  | { kind: "newPassword" }
  | { kind: "totpSetup"; uri: string; secret: string }
  | { kind: "totpCode" }
  | { kind: "forgot" }
  | { kind: "resetCode"; required: boolean };

const PASSWORD_RULE = "At least 8 characters, with upper-case and lower-case letters and a digit.";
const CODE_SENT =
  "If this account has a verified email address, a verification code is on its way (valid for 1 hour). " +
  "Check your spam folder if you don't see it. Accounts without an email address need an administrator to reset the password.";

const NO_EMAIL =
  "This account has no verified email address, so a code can't be sent to it. Ask your administrator to reset your password.";

/** Cognito 报错名 → 一句能照着做的话；不认识的照原文。`resetting` = 忘记密码那两步（InvalidParameter 在那里 = 没有已验证邮箱）。 */
function friendly(e: unknown, fallback: string, resetting = false): string {
  const err = e as { name?: string; message?: string };
  if (resetting && err?.name === "InvalidParameterException") return NO_EMAIL;
  switch (err?.name) {
    case "CodeMismatchException": return "That code is not right. Check the latest email and try again.";
    case "ExpiredCodeException": return "That code has expired. Send a new one.";
    case "LimitExceededException":
    case "TooManyRequestsException":
    case "TooManyFailedAttemptsException": return "Too many attempts. Please wait a while (up to an hour) and try again.";
    case "InvalidPasswordException": return `That password does not meet the rules: ${PASSWORD_RULE}`;
    default: return err?.message || fallback;
  }
}

export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [code, setCode] = useState("");
  const [resetUser, setResetUser] = useState("");
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [notice, setNotice] = useState("");

  const advance = async (r: SignInOutput): Promise<void> => {
    if (r.isSignedIn) { onSignedIn(); return; }
    const ns = r.nextStep;
    switch (ns.signInStep) {
      case "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED":
        setStep({ kind: "newPassword" });
        return;
      case "CONTINUE_SIGN_IN_WITH_TOTP_SETUP": {
        const d = ns.totpSetupDetails;
        setCode("");
        setStep({ kind: "totpSetup", uri: d.getSetupUri(TOTP_ISSUER, username).toString(), secret: d.sharedSecret });
        return;
      }
      case "CONFIRM_SIGN_IN_WITH_TOTP_CODE":
        setCode("");
        setStep({ kind: "totpCode" });
        return;
      case "CONTINUE_SIGN_IN_WITH_MFA_SELECTION":
      case "CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION":
        // 这套部署只开 TOTP，正常到不了这里；用户池若被人额外开了别的因子，直接选 TOTP。
        if ((ns.allowedMFATypes || []).includes("TOTP")) {
          await advance(await confirmSignIn({ challengeResponse: "TOTP" }));
          return;
        }
        break;
      case "RESET_PASSWORD":
        // 管理员要求重置（Cognito 控制台「重置密码」）：旧密码已作废，验证码若有已验证邮箱就已经发了
        setResetUser(username.trim());
        setCode(""); setNewPassword(""); setConfirmPassword("");
        setStep({ kind: "resetCode", required: true });
        return;
      default:
        break;
    }
    setErr(`This sign-in step is not supported here: ${ns.signInStep}`);
  };

  const sendCode = async (who: string) => {
    await resetPassword({ username: who });
    setNotice(CODE_SENT);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (step.kind === "password") {
        setNotice("");
        await advance(await signIn({ username, password }));
      } else if (step.kind === "newPassword") {
        await advance(await confirmSignIn({ challengeResponse: newPassword }));
      } else if (step.kind === "totpSetup") {
        const r = await confirmSignIn({ challengeResponse: code.trim() });
        if (r.isSignedIn) await updateMFAPreference({ totp: "PREFERRED" }).catch(() => {});
        await advance(r);
      } else if (step.kind === "totpCode") {
        await advance(await confirmSignIn({ challengeResponse: code.trim() }));
      } else if (step.kind === "forgot") {
        const who = resetUser.trim();
        await sendCode(who);
        setResetUser(who);
        setCode(""); setNewPassword(""); setConfirmPassword("");
        setStep({ kind: "resetCode", required: false });
      } else {
        if (newPassword !== confirmPassword) { setErr("The two passwords do not match."); return; }
        await confirmResetPassword({ username: resetUser, confirmationCode: code.trim(), newPassword });
        setUsername(resetUser);
        setPassword(""); setNewPassword(""); setConfirmPassword(""); setCode("");
        setStep({ kind: "password" });
        setNotice("Your password has been reset. Sign in with your new password.");
      }
    } catch (e: unknown) {
      const inReset = step.kind === "forgot" || step.kind === "resetCode";
      setErr(friendly(e, inReset ? "Password reset failed" : "Sign-in failed", inReset));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setErr("");
    setBusy(true);
    try { await sendCode(resetUser); }
    catch (e: unknown) { setErr(friendly(e, "Could not send a new code", true)); }
    finally { setBusy(false); }
  };

  const startOver = () => {
    setStep({ kind: "password" });
    setCode("");
    setNewPassword("");
    setConfirmPassword("");
    setErr("");
    setNotice("");
  };

  const forgot = () => {
    setResetUser(username.trim());
    setErr("");
    setNotice("");
    setStep({ kind: "forgot" });
  };

  const codeInput = (
    <input value={code} onChange={(e) => setCode(cleanCode(e.target.value))}
           inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456"
           aria-label="Verification code" />
  );
  const resetting = step.kind === "forgot" || step.kind === "resetCode";
  const codeStep = step.kind === "totpSetup" || step.kind === "totpCode" || step.kind === "resetCode";

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="lc-brand">
          <Logo size={28} /> NotiOps
        </div>
        <h2>{step.kind === "totpSetup" ? "Set up two-step verification"
            : step.kind === "totpCode" ? "Two-step verification"
            : resetting ? "Reset your password" : "Sign in to NotiOps"}</h2>

        {step.kind === "password" && (
          <>
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </>
        )}
        {step.kind === "newPassword" && (
          <>
            <label>Set a new password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoFocus autoComplete="new-password" />
            <p className="lc-note">{PASSWORD_RULE}</p>
          </>
        )}
        {step.kind === "totpSetup" && (
          <>
            <p className="lc-note">
              Your administrator requires two-step verification. Scan this code with an authenticator app
              (for example Google Authenticator, Microsoft Authenticator or 1Password), then enter the
              6-digit code it shows.
            </p>
            <div className="lc-qr"><QrCode value={step.uri} label="Authenticator setup QR code" /></div>
            <label>Or enter this key manually</label>
            <code className="lc-secret">{groupSecret(step.secret)}</code>
            <label>6-digit code</label>
            {codeInput}
          </>
        )}
        {step.kind === "totpCode" && (
          <>
            <p className="lc-note">Enter the 6-digit code from your authenticator app.</p>
            <label>6-digit code</label>
            {codeInput}
          </>
        )}
        {step.kind === "forgot" && (
          <>
            <p className="lc-note">
              Enter your username or the email address on your account. If the account has a verified email
              address, we'll send a verification code to it.
            </p>
            <label>Username or email</label>
            <input value={resetUser} onChange={(e) => setResetUser(e.target.value)} autoFocus autoComplete="username"
                   aria-label="Username or email" />
          </>
        )}
        {step.kind === "resetCode" && (
          <>
            {step.required && (
              <p className="lc-note">
                Your password has to be reset before you can sign in. If your account has a verified email address,
                use the code we emailed you or send a new one; otherwise ask your administrator to reset your password.
              </p>
            )}
            <label>Verification code</label>
            {codeInput}
            <label>New password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                   autoComplete="new-password" aria-label="New password" />
            <label>Confirm new password</label>
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                   autoComplete="new-password" aria-label="Confirm new password" />
            <p className="lc-note">{PASSWORD_RULE}</p>
          </>
        )}

        {notice && <div className="lc-notice" role="status">{notice}</div>}

        <button className="lc-btn" type="submit"
                disabled={busy
                  || (codeStep && code.trim().length !== 6)
                  || (step.kind === "forgot" && !resetUser.trim())
                  || (step.kind === "resetCode" && (!newPassword || !confirmPassword))}>
          {step.kind === "totpSetup" ? "Verify and sign in"
            : step.kind === "totpCode" ? "Verify"
            : step.kind === "forgot" ? "Send code"
            : step.kind === "resetCode" ? "Reset password" : "Sign in"}
        </button>
        {step.kind === "password" && (
          <button type="button" className="lc-link" onClick={forgot} disabled={busy}>Forgot password?</button>
        )}
        {step.kind === "resetCode" && (
          <button type="button" className="lc-link" onClick={resend} disabled={busy || !resetUser}>Send a new code</button>
        )}
        {step.kind !== "password" && (
          <button type="button" className="lc-link" onClick={startOver} disabled={busy}>
            {resetting ? "Back to sign in" : "Start over"}
          </button>
        )}
        {err && <div className="lc-err">{err}</div>}
      </form>
    </div>
  );
}
