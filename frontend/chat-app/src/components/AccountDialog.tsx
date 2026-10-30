import { useEffect, useState } from "react";
import {
  fetchUserAttributes, updateUserAttribute, confirmUserAttribute, sendUserAttributeVerificationCode,
  updatePassword, signOut,
} from "aws-amplify/auth";
import { useT } from "../i18n";
import { cleanCode } from "../auth/totp";

/**
 * 「账户与密码」框（左下角菜单，2026-10-30，待办 #45）：邮箱、修改密码、退出所有设备。
 *
 * 全部经 Amplify 直连 Cognito（用户自己的访问令牌），不经 BFF —— 和两步验证设置框一个做法。
 *
 *   · **邮箱**是忘记密码时收验证码的地方（登录页 Forgot password? 只发给**已验证**邮箱）。绑定 / 更换：
 *     updateUserAttribute → Cognito 给新邮箱发码（24 小时有效）→ confirmUserAttribute。用户池开着「验证前保留
 *     旧邮箱」（infra/lib/constructs/web-password.ts），所以换邮箱过程中旧邮箱照常能登录、能收码，填错了也不会
 *     把自己锁在外面；新邮箱已经是别人的登录别名时，确认那一步 Cognito 会拒（AliasExistsException）。
 *   · **修改密码**：ChangePassword（要当前密码；Cognito 每人每小时最多 5 次）。
 *   · **退出所有设备**：GlobalSignOut，**包括这一台**。其它设备的刷新令牌立刻作废，已发出的令牌最长 1 小时后过期。
 *     Cognito 文档没说登录页自助重置密码会顺手退出别的设备 —— 怀疑账号被盗用就在这里点一下。
 */
type EmailPhase = { kind: "view" } | { kind: "edit" } | { kind: "code"; target: string };

export default function AccountDialog({ onClose, onEmailChanged, onSignedOut }: {
  onClose: () => void;
  /** 邮箱验证成功后通知上层（菜单上「没绑邮箱」的提示点要消失）。 */
  onEmailChanged: (verified: boolean) => void;
  /** 退出所有设备之后回到登录页。 */
  onSignedOut: () => void;
}) {
  const t = useT();
  const [email, setEmail] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<EmailPhase>({ kind: "view" });
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [pwOpen, setPwOpen] = useState(false);
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [newPw2, setNewPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  const load = async () => {
    try {
      const a = await fetchUserAttributes();
      setEmail(a.email || null);
      const v = !!a.email && a.email_verified === "true";
      setVerified(v);
      return v;
    } catch (e) {
      setErr(errText(e));
      return null;
    } finally {
      setLoaded(true);
    }
  };
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Cognito 报错名 → 人话（键直接写在 t(`…${}`) 里：i18n 检查按这个形状认动态键的前缀）。 */
  function errText(e: unknown): string {
    const name = (e as { name?: string })?.name || "";
    const msg = t(`account.err.${name}`);
    if (name && msg !== `account.err.${name}`) return msg;
    return t("account.err.generic").replace("{msg}", (e as Error)?.message || String(e));
  }

  const run = async (fn: () => Promise<void>) => {
    setErr(""); setOk("");
    setBusy(true);
    try { await fn(); }
    catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };

  const sendToNew = () => run(async () => {
    const target = newEmail.trim();
    const r = await updateUserAttribute({ userAttribute: { attributeKey: "email", value: target } });
    if (r.nextStep.updateAttributeStep === "DONE") {
      // 不需要验证就生效了（用户池没开自动验证时才会这样；这套部署开着）—— 照实刷新
      const v = await load();
      onEmailChanged(!!v);
      setPhase({ kind: "view" });
      setOk(t("account.email.done"));
      return;
    }
    setCode("");
    setPhase({ kind: "code", target });
    setOk(t("account.email.codeSent").replace("{email}", target));
  });

  /** 已经有邮箱但还没验证（比如别的途径填进来的）：给它发码，不换地址。 */
  const verifyCurrent = () => run(async () => {
    await sendUserAttributeVerificationCode({ userAttributeKey: "email" });
    setCode("");
    setPhase({ kind: "code", target: email || "" });
    setOk(t("account.email.codeSent").replace("{email}", email || ""));
  });

  const confirmCode = () => run(async () => {
    await confirmUserAttribute({ userAttributeKey: "email", confirmationCode: code.trim() });
    const v = await load();
    onEmailChanged(!!v);
    setPhase({ kind: "view" });
    setNewEmail(""); setCode("");
    setOk(t("account.email.done"));
  });

  const resend = () => run(async () => {
    await sendUserAttributeVerificationCode({ userAttributeKey: "email" });
    setOk(t("account.email.codeSent").replace("{email}", phase.kind === "code" ? phase.target : ""));
  });

  const changePassword = () => {
    if (newPw !== newPw2) { setOk(""); setErr(t("account.password.mismatch")); return; }
    void run(async () => {
      await updatePassword({ oldPassword: oldPw, newPassword: newPw });
      setOldPw(""); setNewPw(""); setNewPw2(""); setPwOpen(false);
      setOk(t("account.password.done"));
    });
  };

  const signOutEverywhere = () => {
    if (!window.confirm(t("account.signout.confirm"))) return;
    void run(async () => {
      await signOut({ global: true });
      onSignedOut();
    });
  };

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail.trim());

  return (
    <div className="cz-overlay" onClick={() => { if (!busy && phase.kind !== "code") onClose(); }}>
      <div className="cz-dialog mfa-dialog acct-dialog" role="dialog" aria-modal="true" aria-labelledby="acct-dialog-title"
           onClick={(e) => e.stopPropagation()}>
        <div className="cz-dialog-head">
          <div className="cz-dialog-title" id="acct-dialog-title">{t("account.title")}</div>
        </div>

        <div className="mfa-body">
          {/* ── 邮箱 ── */}
          <div className="acct-section">
            <div className="mfa-label">{t("account.email.title")}</div>
            {!loaded ? (
              <p className="mfa-text muted">{t("account.loading")}</p>
            ) : (
              <p className="mfa-text">
                {email ? <span className="acct-email">{email}</span> : <span className="muted">{t("account.email.none")}</span>}
                {email && (
                  <span className={`mfa-pill ${verified ? "on" : "off"}`}>
                    {t(verified ? "account.email.verified" : "account.email.unverified")}
                  </span>
                )}
              </p>
            )}
            <p className="mfa-text muted">{t(verified ? "account.email.hint" : "account.email.hintMissing")}</p>

            {phase.kind === "view" && loaded && (
              <div className="mfa-actions">
                <button className={`mfa-btn ${email ? "" : "primary"}`} disabled={busy}
                        onClick={() => { setNewEmail(""); setErr(""); setOk(""); setPhase({ kind: "edit" }); }}>
                  {t(email ? "account.email.change" : "account.email.add")}
                </button>
                {email && !verified && (
                  <button className="mfa-btn primary" disabled={busy} onClick={verifyCurrent}>{t("account.email.verifyNow")}</button>
                )}
              </div>
            )}
            {phase.kind === "edit" && (
              <form onSubmit={(e) => { e.preventDefault(); if (emailValid) void sendToNew(); }}>
                <input className="acct-input" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)}
                       autoFocus autoComplete="email" placeholder="name@example.com" aria-label={t("account.email.newLabel")} />
                <div className="mfa-actions">
                  <button type="submit" className="mfa-btn primary" disabled={busy || !emailValid}>{t("account.email.send")}</button>
                  <button type="button" className="mfa-btn" disabled={busy} onClick={() => setPhase({ kind: "view" })}>{t("account.cancel")}</button>
                </div>
              </form>
            )}
            {phase.kind === "code" && (
              <form onSubmit={(e) => { e.preventDefault(); if (code.length === 6) void confirmCode(); }}>
                <input className="mfa-code" value={code} onChange={(e) => setCode(cleanCode(e.target.value))}
                       inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456"
                       aria-label={t("account.email.codeLabel")} />
                <div className="mfa-actions">
                  <button type="submit" className="mfa-btn primary" disabled={busy || code.length !== 6}>{t("account.email.confirm")}</button>
                  <button type="button" className="mfa-btn" disabled={busy} onClick={resend}>{t("account.email.resend")}</button>
                  <button type="button" className="mfa-btn" disabled={busy} onClick={() => { setPhase({ kind: "view" }); setOk(""); }}>{t("account.cancel")}</button>
                </div>
              </form>
            )}
          </div>

          {/* ── 密码 ── */}
          <div className="acct-section">
            <div className="mfa-label">{t("account.password.title")}</div>
            {!pwOpen ? (
              <div className="mfa-actions">
                <button className="mfa-btn" disabled={busy} onClick={() => { setErr(""); setOk(""); setPwOpen(true); }}>{t("account.password.change")}</button>
              </div>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); changePassword(); }}>
                <input className="acct-input" type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)}
                       autoComplete="current-password" placeholder={t("account.password.old")} aria-label={t("account.password.old")} />
                <input className="acct-input" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)}
                       autoComplete="new-password" placeholder={t("account.password.new")} aria-label={t("account.password.new")} />
                <input className="acct-input" type="password" value={newPw2} onChange={(e) => setNewPw2(e.target.value)}
                       autoComplete="new-password" placeholder={t("account.password.confirm")} aria-label={t("account.password.confirm")} />
                <p className="mfa-text muted">{t("account.password.rule")}</p>
                <div className="mfa-actions">
                  <button type="submit" className="mfa-btn primary" disabled={busy || !oldPw || !newPw || !newPw2}>{t("account.password.save")}</button>
                  <button type="button" className="mfa-btn" disabled={busy} onClick={() => { setPwOpen(false); setErr(""); }}>{t("account.cancel")}</button>
                </div>
              </form>
            )}
          </div>

          {/* ── 登录设备 ── */}
          <div className="acct-section">
            <div className="mfa-label">{t("account.signout.title")}</div>
            <p className="mfa-text muted">{t("account.signout.note")}</p>
            <div className="mfa-actions">
              <button className="mfa-btn danger" disabled={busy} onClick={signOutEverywhere}>{t("account.signout.button")}</button>
            </div>
          </div>

          {ok && <div className="acct-ok" role="status">{ok}</div>}
          <div className="mfa-actions">
            <button className="mfa-btn" disabled={busy} onClick={onClose}>{t("account.close")}</button>
          </div>
        </div>

        {err && <div className="mfa-err" role="alert">{err}</div>}
      </div>
    </div>
  );
}
