/**
 * 忘记密码 / 重置密码 —— 两条部署路径共用的用户池属性（2026-10-30 加，待办 #45）。
 *
 * 三项在 CloudFormation 里都是「No interruption」的原地更新：升级不替换用户池、不丢用户、不动任何人的
 * 密码 / 两步验证 / 组。
 *
 *   · accountRecovery = EMAIL_ONLY：找回密码只走**已验证**邮箱。原来没写，CDK 默认「先手机后邮箱」——
 *     这套部署没配短信，手机那一档本来就走不通，写明意图、去掉一条死路。
 *   · userVerification：找回密码（ForgotPassword）和验证邮箱（改邮箱后收码）**共用**这一个模板。Cognito
 *     默认文案是「Verify your new account / The verification code to your new account is」，重置密码的人
 *     会以为在注册新账号，甚至当成钓鱼。
 *   · keepOriginal.email：用户自己换邮箱时，新邮箱验证之前**旧邮箱照常能登录、能收码**。不设的话一改就失效
 *     （邮箱是这个池的登录别名），填错一个字母就把自己锁在外面。
 *
 * 邮件只用 ASCII：一键模板里的非 ASCII 会被 CloudFormation 收模板时换成 `?`（scripts/postprocess_template.py
 * 的全局断言就是为这个），所以和邀请邮件一样只写英文。Cognito 的邮件按 HTML 渲染，换行用 <p>。
 *
 * 判据：infra/test/web-password.test.ts（两条路径的用户池这三项逐字节一致、只有 ASCII、有 {####}）。
 */
import * as cognito from "aws-cdk-lib/aws-cognito";

export const VERIFICATION_EMAIL_SUBJECT = "Your NotiOps verification code";
export const VERIFICATION_EMAIL_BODY =
  "<p>Your NotiOps verification code is <b>{####}</b></p>" +
  "<p>If you asked to reset your password, the code is valid for 1 hour. " +
  "If you are adding or changing your email address, it is valid for 24 hours.</p>" +
  "<p>If you did not ask for this, you can ignore this email; please let your NotiOps administrator know.</p>";

/** 两个用户池（方式 A 的 minimal-base-core.ts、方式 B 的 notiops-backend-stack.ts）都展开这一份。 */
export function userPoolRecoveryProps(): Pick<cognito.UserPoolProps, "accountRecovery" | "userVerification" | "keepOriginal"> {
  return {
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    userVerification: {
      emailStyle: cognito.VerificationEmailStyle.CODE,
      emailSubject: VERIFICATION_EMAIL_SUBJECT,
      emailBody: VERIFICATION_EMAIL_BODY,
    },
    keepOriginal: { email: true },
  };
}
