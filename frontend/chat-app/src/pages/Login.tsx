import { useState } from "react";
import { signIn, confirmSignIn } from "aws-amplify/auth";
import Logo from "../components/Logo";

/**
 * 自定义登录表单（Amplify v6 无内置 Authenticator）。
 * 登录页固定英文（无语言切换）。
 */
export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [needNewPw, setNeedNewPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (needNewPw) {
        const r = await confirmSignIn({ challengeResponse: newPassword });
        if (r.isSignedIn) onSignedIn();
      } else {
        const r = await signIn({ username, password });
        if (r.isSignedIn) {
          onSignedIn();
        } else if (r.nextStep?.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
          setNeedNewPw(true);
        } else {
          setErr(`需要额外验证步骤: ${r.nextStep?.signInStep ?? "unknown"}`);
        }
      }
    } catch (e: unknown) {
      setErr((e as Error)?.message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="lc-brand">
          <Logo size={28} /> NotiOps
        </div>
        <h2>Sign in to NotiOps</h2>

        {!needNewPw ? (
          <>
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
            <label>Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </>
        ) : (
          <>
            <label>Set a new password</label>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoFocus autoComplete="new-password" />
          </>
        )}

        <button className="lc-btn" type="submit" disabled={busy}>
          Sign in
        </button>
        {err && <div className="lc-err">{err}</div>}
      </form>
    </div>
  );
}
