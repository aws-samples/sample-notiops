/**
 * Amplify / Cognito 认证配置。
 * 从运行时 config 加载（CDK 部署时自动注入）。
 */
import { Amplify } from "aws-amplify";
import { getConfig } from "../config";

export function configureAuth() {
  const config = getConfig();
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: config.cognitoUserPoolId,
        userPoolClientId: config.cognitoClientId,
      },
    },
  });
}
