import { useState } from "react";
import { setUpTOTP, verifyTOTPSetup, updateMFAPreference } from "aws-amplify/auth";
import { useT } from "../i18n";
import QrCode from "./QrCode";
import { TOTP_ISSUER, groupSecret, cleanCode } from "../auth/totp";
import type { MfaMode } from "../api/mfa";

/**
 * 两步验证设置框（左下角菜单「两步验证」，或「管理」页要求先开时弹出）。
 *
 * 全部经 Amplify 直连 Cognito（用户自己的访问令牌），不经 BFF：
 *   开启 / 换一个 = setUpTOTP → 扫码 → verifyTOTPSetup(6 位码) → updateMFAPreference(totp: PREFERRED)；
 *   关闭        = updateMFAPreference(totp: DISABLED)，只在用户池「可选」档给（「强制」档关了下次登录又要绑）。
 * 状态（档位、绑没绑）以 BFF 的 /me/mfa 为准（它读的是 Cognito 里此刻的状态），每次改完调 onChanged 刷新。
 *
 * 扫码这一步点遮罩**不**关闭 —— 误点一下就得重新生成密钥、重新扫。
 */
type Phase =
  | { kind: "status" }
  | { kind: "setup"; uri: string; secret: string; rebind: boolean }
  | { kind: "done"; msgKey: string };

export default function TwoFactorDialog({ mode, enrolled, username, reason, onClose, onChanged }: {
  mode: MfaMode | null;
  enrolled: boolean | null;
  username: string;
  /** "admin" = 「管理」页要求先开时弹出的，顶上多一句为什么。 */
  reason: "menu" | "admin";
  onClose: () => void;
  onChanged: () => void | Promise<void>;
}) {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "status" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setErr("");
    setBusy(true);
    try { await fn(); }
    catch (e) { setErr(t("mfa.failed").replace("{msg}", (e as Error)?.message || String(e))); }
    finally { setBusy(false); }
  };

  const startSetup = () => run(async () => {
    const d = await setUpTOTP();
    setCode("");
    setPhase({ kind: "setup", uri: d.getSetupUri(TOTP_ISSUER, username).toString(), secret: d.sharedSecret, rebind: !!enrolled });
  });

  const verify = (rebind: boolean) => run(async () => {
    await verifyTOTPSetup({ code });
    await updateMFAPreference({ totp: "PREFERRED" });
    await onChanged();
    setPhase({ kind: "done", msgKey: rebind ? "mfa.rebindOk" : "mfa.enabledOk" });
  });

  const disable = () => {
    if (!window.confirm(t("mfa.confirmDisable"))) return;
    void run(async () => {
      await updateMFAPreference({ totp: "DISABLED" });
      await onChanged();
      setPhase({ kind: "done", msgKey: "mfa.disabledOk" });
    });
  };

  const canDisable = enrolled === true && mode === "OPTIONAL";

  return (
    <div className="cz-overlay" onClick={() => { if (phase.kind !== "setup" && !busy) onClose(); }}>
      <div className="cz-dialog mfa-dialog" role="dialog" aria-modal="true" aria-labelledby="mfa-dialog-title"
           onClick={(e) => e.stopPropagation()}>
        <div className="cz-dialog-head">
          <div>
            <div className="cz-dialog-title" id="mfa-dialog-title">{t("mfa.title")}</div>
            {phase.kind === "status" && enrolled !== null && (
              <div className="cz-dialog-sub">
                <span className={`mfa-pill ${enrolled ? "on" : "off"}`}>{t(enrolled ? "mfa.statusOn" : "mfa.statusOff")}</span>
              </div>
            )}
          </div>
        </div>

        {phase.kind === "status" && (
          <div className="mfa-body">
            {reason === "admin" && <p className="mfa-reason">{t("mfa.adminReason")}</p>}
            {mode === null ? (
              <p className="mfa-text">{t("mfa.unavailable")}</p>
            ) : (
              <>
                <p className="mfa-text">{t("mfa.intro")}</p>
                {mode === "REQUIRED" && <p className="mfa-text muted">{t("mfa.requiredNote")}</p>}
              </>
            )}
            <div className="mfa-actions">
              {mode !== null && mode !== "OFF" && enrolled === false && (
                <button className="mfa-btn primary" disabled={busy} onClick={startSetup}>{t("mfa.enable")}</button>
              )}
              {mode !== null && mode !== "OFF" && enrolled === true && (
                <button className="mfa-btn" disabled={busy} onClick={startSetup}>{t("mfa.rebind")}</button>
              )}
              {canDisable && <button className="mfa-btn danger" disabled={busy} onClick={disable}>{t("mfa.disable")}</button>}
              <button className="mfa-btn" disabled={busy} onClick={onClose}>{t("mfa.cancel")}</button>
            </div>
          </div>
        )}

        {phase.kind === "setup" && (
          <form className="mfa-body" onSubmit={(e) => { e.preventDefault(); if (code.length === 6) void verify(phase.rebind); }}>
            <p className="mfa-text">{t("mfa.scan")}</p>
            <div className="mfa-qr"><QrCode value={phase.uri} label={t("mfa.qrLabel")} /></div>
            <div className="mfa-label">{t("mfa.secretLabel")}</div>
            <code className="mfa-secret">{groupSecret(phase.secret)}</code>
            <div className="mfa-label">{t("mfa.codeLabel")}</div>
            <input className="mfa-code" value={code} onChange={(e) => setCode(cleanCode(e.target.value))}
                   inputMode="numeric" autoComplete="one-time-code" autoFocus placeholder="123456"
                   aria-label={t("mfa.codeLabel")} />
            <div className="mfa-actions">
              <button type="submit" className="mfa-btn primary" disabled={busy || code.length !== 6}>{t("mfa.verify")}</button>
              <button type="button" className="mfa-btn" disabled={busy} onClick={() => { setPhase({ kind: "status" }); setErr(""); }}>{t("mfa.cancel")}</button>
            </div>
          </form>
        )}

        {phase.kind === "done" && (
          <div className="mfa-body">
            <p className="mfa-text">{t(phase.msgKey)}</p>
            <div className="mfa-actions">
              <button className="mfa-btn primary" onClick={onClose}>{t("mfa.done")}</button>
            </div>
          </div>
        )}

        {err && <div className="mfa-err" role="alert">{err}</div>}
      </div>
    </div>
  );
}
