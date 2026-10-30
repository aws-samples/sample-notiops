/**
 * 忘记密码 / 重置密码：两条部署路径的用户池落到**同一组**找回相关属性，而且升级**不替换**用户池（2026-10-30）。
 *
 *   · 方式 B（setup.sh → NotiOpsBackendStack）和方式 A（一键模板）各建一个用户池，都展开
 *     constructs/web-password.ts 的 userPoolRecoveryProps()；这里逐字节比两边的结果。
 *   · 邮件文案只能是 ASCII（一键模板里的非 ASCII 会被 CloudFormation 换成 `?`），而且必须带 `{####}`
 *     （Cognito 的验证码占位符，少了它 Cognito 直接拒这个模板）。
 *   · 用户池的逻辑 ID 钉死：一改就是 CloudFormation 删旧池、建新池 —— 所有用户、密码、两步验证全没了。
 *     别名 / 自动验证这两项也钉住：这次只该改找回相关的三项。
 *   · BFF 角色（两条路径共用 web-chat-core.ts）有管理员重置密码、设邮箱要的两个动作。
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NotiOpsBackendStack } from "../lib/notiops-backend-stack";
import { NotiOpsWebChatStandaloneStack } from "../lib/notiops-webchat-standalone-stack";
import { VERIFICATION_EMAIL_BODY, VERIFICATION_EMAIL_SUBJECT } from "../lib/constructs/web-password";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const poolOf = (t: Json): { id: string; props: Json } => {
  const ids = Object.keys(t.Resources).filter((k) => t.Resources[k].Type === "AWS::Cognito::UserPool");
  expect(ids).toHaveLength(1);
  return { id: ids[0], props: t.Resources[ids[0]].Properties };
};

// 关掉资产暂存：只看用户池和 IAM，不需要把每个 Lambda 的代码目录拷进 cdk.out（见 web-mfa.test.ts 的说明）。
const backend: Json = (() => {
  const app = new cdk.App({ context: { "aws:cdk:disable-asset-staging": true } });
  const stack = new NotiOpsBackendStack(app, "PwTestBackend", { env: { account: "111122223333", region: "us-east-1" } });
  return Template.fromStack(stack).toJSON();
})();
const oneClick: Json = (() => {
  const app = new cdk.App();
  const stack = new NotiOpsWebChatStandaloneStack(app, "PwTestOneClick", {
    synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
  });
  return Template.fromStack(stack).toJSON();
})();

const RECOVERY_KEYS = ["AccountRecoverySetting", "VerificationMessageTemplate", "UserAttributeUpdateSettings",
                       "EmailVerificationMessage", "EmailVerificationSubject"];
const pick = (p: Json) => Object.fromEntries(RECOVERY_KEYS.map((k) => [k, p[k]]));

describe("both deployment paths give the user pool the same password-recovery settings", () => {
  const b = poolOf(backend).props;
  const a = poolOf(oneClick).props;

  it("identical on both paths", () => {
    expect(pick(a)).toEqual(pick(b));
  });

  it("recovery goes to a verified email only (no SMS: this deployment has no SNS set up)", () => {
    expect(b.AccountRecoverySetting).toEqual({ RecoveryMechanisms: [{ Name: "verified_email", Priority: 1 }] });
  });

  it("verification email (also used for forgot-password codes) has the code placeholder and is ASCII", () => {
    const t = b.VerificationMessageTemplate;
    expect(t.DefaultEmailOption).toBe("CONFIRM_WITH_CODE");
    expect(t.EmailSubject).toBe(VERIFICATION_EMAIL_SUBJECT);
    expect(t.EmailMessage).toBe(VERIFICATION_EMAIL_BODY);
    expect(t.EmailMessage).toContain("{####}");
    for (const s of [t.EmailSubject, t.EmailMessage]) expect(/^[\x20-\x7e]+$/.test(s)).toBe(true);
    // 不再是 Cognito 默认那句「新账号」文案 —— 重置密码的人会以为在注册
    expect(t.EmailMessage).not.toMatch(/new account/i);
  });

  it("changing an email keeps the old one active until the new one is verified", () => {
    expect(b.UserAttributeUpdateSettings).toEqual({ AttributesRequireVerificationBeforeUpdate: ["email"] });
  });
});

describe("the upgrade keeps the existing user pool (no replacement, no lost users)", () => {
  it("logical IDs are unchanged on both paths", () => {
    // 钉的是已经部署出去的 ID（现网 NotiOpsBackendStack 与一键模板同名）。改了它 = CloudFormation 建新池、删旧池。
    expect(poolOf(backend).id).toBe("IdleDetectorUserPool48FD3565");
    expect(poolOf(oneClick).id).toBe("IdleDetectorUserPool48FD3565");
  });

  it("sign-in aliases and auto-verified attributes are unchanged", () => {
    for (const t of [backend, oneClick]) {
      const p = poolOf(t).props;
      expect(p.AliasAttributes).toEqual(["email"]);
      expect(p.AutoVerifiedAttributes).toEqual(["email"]);
      expect(p.UsernameAttributes).toBeUndefined();
    }
  });
});

describe("the BFF can reset passwords and set emails (both paths share web-chat-core)", () => {
  it("one-click BFF role has AdminSetUserPassword and AdminUpdateUserAttributes on the user pool", () => {
    const actions = new Set<string>();
    for (const r of Object.values<Json>(oneClick.Resources)) {
      if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::ManagedPolicy") continue;
      if (!JSON.stringify(r.Properties.Roles || []).includes("WebChatBff")) continue;
      for (const st of [].concat(r.Properties.PolicyDocument.Statement)) {
        const s: Json = st;
        if (JSON.stringify(s.Resource).includes("userpool/")) for (const x of [].concat(s.Action)) actions.add(x);
      }
    }
    expect(actions.has("cognito-idp:AdminSetUserPassword")).toBe(true);
    expect(actions.has("cognito-idp:AdminUpdateUserAttributes")).toBe(true);
    // 刻意不用：它走邮件验证码，对没有已验证邮箱的人直接报错（见 bff/web-chat/passwords.mjs 文件头）
    expect(actions.has("cognito-idp:AdminResetUserPassword")).toBe(false);
  });
});
