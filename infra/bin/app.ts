#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { NotiOpsBackendStack } from "../lib/notiops-backend-stack";
import { BotStack } from "../lib/bot-stack";
import { WebChatStack } from "../lib/web-chat-stack";

const app = new cdk.App();

// 强制项目标签：NotiOps 部署的所有云资源都打 auto-delete=no，
// 防止被自动清理/回收器误删。在 App 级打一次即可向下传播到所有可打标签的资源。
cdk.Tags.of(app).add("auto-delete", "no");
// project=notiops：统一项目归属标签（成本分摊 / 资源筛选 / 批量清理定位）。
// 同样在 App 级传播到所有可打标签的资源。
cdk.Tags.of(app).add("project", "notiops");

// Region resolution — fail-fast if nothing is set so we never silently
// deploy to the wrong region. Precedence: DEPLOY_REGION (set by setup.sh)
// > CDK_DEFAULT_REGION (cdk-cli's --profile default) > AWS_REGION /
// AWS_DEFAULT_REGION (shell env). If your shell has a stale AWS_REGION
// pointing at a different region than the one you're deploying to, prefer
// running with an explicit DEPLOY_REGION=<region> to avoid surprises.
const region =
  process.env.DEPLOY_REGION ||
  process.env.CDK_DEFAULT_REGION ||
  process.env.AWS_REGION ||
  process.env.AWS_DEFAULT_REGION;
if (!region) {
  throw new Error(
    "No deploy region resolved. Set DEPLOY_REGION (preferred) or " +
    "CDK_DEFAULT_REGION / AWS_REGION before running cdk."
  );
}
const account = process.env.CDK_DEFAULT_ACCOUNT;
if (!account) {
  throw new Error(
    "No AWS account resolved. Run `aws sts get-caller-identity` to " +
    "verify your credentials before running cdk."
  );
}
// Print once at synth time so a region mismatch is loud, not silent.
console.error(`[cdk] deploying to account=${account} region=${region}`);
const env = { account, region };

const main = new NotiOpsBackendStack(app, "NotiOpsBackendStack", {
  env,
  description: "AWS resource idle-detection & optimization system (fully automated deployment)",
});

// BotStack 条件实例化：enabledPlatforms=none 时跳过 BotStack，
// 避免 fromAsset("../") 扫描整个 repo root 计算 asset hash（594s → 12s）。
// setup.sh 选"暂不部署 IM"时传 -c enabledPlatforms=none。
const enabledPlatforms = app.node.tryGetContext("enabledPlatforms") || "feishu";
if (enabledPlatforms !== "none") {
  const botStack = new BotStack(app, "BotStack", {
    env,
    description: "NotiOps ECS Bot (Feishu + Slack)",
    metricsTableName: "notiops-metrics",
    configTableName: "notiops-config",
    conversationsTableName: "notiops-conversations",
    skillsBucketName: main.dataBucketName,
  });

  // BotStack consumes the DynamoDB tables created by NotiOpsBackendStack
  // (by name), so the main stack must be deployed first.
  // addStackDependency 是 Stack#addDependency 的新名字（后者自 aws-cdk-lib 2.26x
  // 起标记 deprecated，v3 会删）。Construct 级的 node.addDependency 不受影响。
  botStack.addStackDependency(main);
}

// 报告 CDN 域名（「深度调查（直连）」在线报告链接）。默认取 main.reportsCdnDomain
// （跨栈引用，一次全量部署即自动打通）；也可用 `-c reportsCdnDomain=<域名>` 显式给值。
// 为什么留这个口子：跨栈引用会给 NotiOpsBackendStack **新增一条 CFN Export**，也就是说
// 只想单独更新 WebChatStack 时，也被迫先 update 主栈（会顺带带上主栈上所有未部署的改动）。
// 传 -c 后 WebChatStack 不再引用主栈的这个属性，可以真正 `deploy WebChatStack --exclusively`。
const reportsCdnDomainCtx = (app.node.tryGetContext("reportsCdnDomain") as string | undefined)?.trim();

// WebChatStack：面向客户的 agentic Web Chat。
// 复用 NotiOpsBackendStack 的 Cognito 池（认证统一），故依赖 main。
const webChat = new WebChatStack(app, "WebChatStack", {
  env,
  description: "NotiOps Web Chat (agentic) — BFF streaming + chat-app frontend",
  userPoolId: main.userPoolId,
  userPoolClientId: main.userPoolClientId,
  skillsBucketName: main.dataBucketName, // Skills 存共享 dataBucket 的 skills/ 前缀
  agentSpaceId: main.agentSpaceId, // FinOps 跨账号成本查询动态发现关联账号用
  idleConsoleUrl: main.consoleUrl, // 侧栏「巡检 & 报告」外链
  reportsCdnDomain: reportsCdnDomainCtx || main.reportsCdnDomain, // 「深度调查（直连）」报告链接（CloudFront+OAC，只暴露 reports/*）
});
webChat.addStackDependency(main);
