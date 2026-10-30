/**
 * Web 登录的两步验证（验证器 App，TOTP）—— 两条部署路径共用同一份取值与映射（2026-10-29 加）。
 *
 * 三档，对外（一键模板参数 `MfaMode` / setup.sh 的 `MFA_MODE` → `-c mfaMode=`）一律用这三个词：
 *   · OFF      —— 只用密码（v1.0.33 及更早就是这样）；
 *   · OPTIONAL —— 默认。每个人可以在左下角菜单里自己开；「管理」页（/admin/*）要求先开（BFF 判，见 bff/web-chat/mfa.mjs）；
 *   · REQUIRED —— 所有人下次登录时必须绑定，之后每次登录都要验证码。
 *
 * 只开 TOTP，不开短信 / 邮件：短信要配 SNS（有费用，新账号在沙箱里发不出去）；邮件验证码要求用户池
 * 升到 Essentials 付费档并自己配 SES。TOTP 两样都不要。
 *
 * BFF 不读这里的值：它从用户池现读（GetUserPoolMfaConfig），所以模式只配在用户池上这一处，
 * 只部署 WebChatStack 的那种更新也不会让 BFF 和用户池对不上。
 */
import * as cognito from "aws-cdk-lib/aws-cognito";

export const MFA_MODES = ["OFF", "OPTIONAL", "REQUIRED"] as const;
export type MfaMode = (typeof MFA_MODES)[number];
export const DEFAULT_MFA_MODE: MfaMode = "OPTIONAL";

/** 上下文值 → 三档之一。没给 = 默认；给了却不认识就**报错**（拼错一个字母不能悄悄变成别的档）。 */
export function parseMfaMode(raw: unknown): MfaMode {
  if (raw === undefined || raw === null || String(raw).trim() === "") return DEFAULT_MFA_MODE;
  const v = String(raw).trim().toUpperCase();
  if ((MFA_MODES as readonly string[]).includes(v)) return v as MfaMode;
  throw new Error(`mfaMode must be one of ${MFA_MODES.join(" / ")}, got ${JSON.stringify(raw)}`);
}

/** 方式 B（CDK 字面量）用的用户池属性片段。OFF 时不给 mfaSecondFactor —— CDK 才不会输出 EnabledMfas。 */
export function userPoolMfaProps(mode: MfaMode): Pick<cognito.UserPoolProps, "mfa" | "mfaSecondFactor"> {
  if (mode === "OFF") return { mfa: cognito.Mfa.OFF };
  return {
    mfa: mode === "REQUIRED" ? cognito.Mfa.REQUIRED : cognito.Mfa.OPTIONAL,
    mfaSecondFactor: { sms: false, otp: true, email: false },
  };
}
