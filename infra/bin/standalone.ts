#!/usr/bin/env node
/**
 * 一键部署（Launch Stack）模板的**合成入口** —— 与 `bin/app.ts` 完全分开。
 *
 * 为什么另起一个入口而不是往 app.ts 里加一个栈：
 *   1. `bin/app.ts` 开头就 fail-fast 要求 `CDK_DEFAULT_ACCOUNT` / region（那是对的：
 *      真部署时静默部错账号是灾难）。而这里要的恰恰相反 —— **不能**绑定账号/区域，
 *      模板要在任意客户账号任意区域都能用。
 *   2. app.ts 还会顺带实例化 BotStack / NotiOpsBackendStack，合成一次好几分钟
 *      （BotStack 的 asset 要扫整个仓库）。发模板不需要它们。
 *
 * 用法：
 *   npm run synth:standalone            # 产物在 /tmp/notiops-cdk-out/
 *   python3 ../scripts/postprocess_template.py <合成产物> <发布用模板>
 * 合成出来的**裸模板不能直接给客户**：它还带着 CDK bootstrap 的痕迹（资产桶名、
 * BootstrapVersion 参数）和空的产物清单，必须过一遍 postprocess。
 */
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { NotiOpsWebChatStandaloneStack } from "../lib/notiops-webchat-standalone-stack";

const app = new cdk.App();

// 与 bin/app.ts 一致的强制标签（团队规定：NotiOps 建的每个云资源都要带这两个）。
cdk.Tags.of(app).add("auto-delete", "no");
cdk.Tags.of(app).add("project", "notiops");

new NotiOpsWebChatStandaloneStack(app, "NotiOps", {
  // 刻意**不传 env** —— 于是 stack.account / stack.region 落成 AWS::AccountId /
  // AWS::Region 伪参数，一份模板通吃所有账号和区域。
  // 客户可见的字符串**只能用 ASCII**：CloudFormation 在收模板时会把非 ASCII 字符
  // 一律替换成 `?`（实测 `em—dash 前端` 进去、`em?dash ??` 出来），于是控制台上
  // 客户看到的是一串问号。破折号用 `--`，别用 `—`。
  description:
    "NotiOps Web Chat -- one-click deployment (chat UI + BFF + AgentCore agent, read-only by design)",
  // 不生成 bootstrap 版本校验 Rule：客户账号没跑过 cdk bootstrap，那条 Rule 会让
  // 开栈直接失败。资产桶名的痕迹由 postprocess 改写。
  synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
});
