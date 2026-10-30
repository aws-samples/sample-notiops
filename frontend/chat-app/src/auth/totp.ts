/** 两步验证（验证器 App）界面共用的两个小工具 —— 登录页（强制档的首次绑定）与 TwoFactorDialog（自己开 / 换）。 */

/** 验证器 App 里显示的发行方名称。 */
export const TOTP_ISSUER = "NotiOps";

/** 密钥按 4 位一组显示，手动输入时不容易抄错。 */
export const groupSecret = (s: string) => s.replace(/(.{4})/g, "$1 ").trim();

/** 只留数字、最多 6 位（粘贴进来的「123 456」也能用）。 */
export const cleanCode = (s: string) => s.replace(/\D/g, "").slice(0, 6);
