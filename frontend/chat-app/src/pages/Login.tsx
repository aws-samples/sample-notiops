import { useState } from "react";
import { signIn, confirmSignIn, updateMFAPreference, type SignInOutput } from "aws-amplify/auth";
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
 */
type Step =
  | { kind: "password" }
  | { kind: "newPassword" }
  | { kind: "totpSetup"; uri: string; secret: string }
  | { kind: "totpCode" };

export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

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
      default:
        break;
    }
    setErr(`This sign-in step is not supported here: ${ns.signInStep}`);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (step.kind === "password") {
        await advance(await signIn({ username, password }));
      } else if (step.kind === "newPassword") {
        await advance(await confirmSignIn({ challengeResponse: newPassword }));
      } else if (step.kind === "totpSetup") {
        const r = await confirmSignIn({ challengeResponse: code.trim() });
        if (r.isSignedIn) await updateMFAPreference({ totp: "PREFERRED" }).catch(() => {});
        await advance(r);
      } else {
        await advance(await confirmSignIn({ challengeResponse: code.trim() }));
      }
    } catch (e: unknown) {
      setErr((e as Error)?.message || "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setStep({ kind: "password" });
    setCode("");
    setNewPassword("");
    setErr("");
  };

  const codeInput = (
    <input value={code} onChange={(e) => setCode(cleanCode(e.target.value))}
           inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456"
           aria-label="Verification code" />
  );

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="lc-brand">
          <Logo size={28} /> NotiOps
        </div>
        <h2>{step.kind === "totpSetup" ? "Set up two-step verification"
            : step.kind === "totpCode" ? "Two-step verification" : "Sign in to NotiOps"}</h2>

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

        <button className="lc-btn" type="submit"
                disabled={busy || ((step.kind === "totpSetup" || step.kind === "totpCode") && code.trim().length !== 6)}>
          {step.kind === "totpSetup" ? "Verify and sign in" : step.kind === "totpCode" ? "Verify" : "Sign in"}
        </button>
        {step.kind !== "password" && (
          <button type="button" className="lc-link" onClick={startOver} disabled={busy}>Start over</button>
        )}
        {err && <div className="lc-err">{err}</div>}
      </form>
    </div>
  );
}
