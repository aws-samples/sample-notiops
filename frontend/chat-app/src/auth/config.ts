/**
 * Amplify / Cognito 认证配置。
 * 从运行时 config 加载（CDK 部署时自动注入）。
 * 与控制台共享同一个 Cognito user pool。
 */
import { Amplify } from "aws-amplify";
import { getConfig } from "../config";

export function configureAuth() {
  const config = getConfig();
  // Identity Pool：把 User Pool 登录换成临时 AWS 凭证，用于对 BFF Function URL 做 SigV4。
  // 部署时 config 一定带 identityPoolId；用 cast 让类型通过（Amplify 类型要求非空）。
  const cognito = {
    userPoolId: config.cognitoUserPoolId,
    userPoolClientId: config.cognitoClientId,
    identityPoolId: config.cognitoIdentityPoolId,
  };
  Amplify.configure({ Auth: { Cognito: cognito } } as Parameters<typeof Amplify.configure>[0]);
}
