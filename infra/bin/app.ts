#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { NotiOpsBackendStack } from "../lib/notiops-backend-stack";
import { ImStack } from "../lib/im-stack";
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

// 报告 CDN 域名（在线报告链接：Web 端「深度调查（直连）」+ IM 端长回答落报告）。
// 默认取 main.reportsCdnDomain（跨栈引用，一次全量部署即自动打通）；也可用
// `-c reportsCdnDomain=<域名>` 显式给值。
// 为什么留这个口子：跨栈引用会给 NotiOpsBackendStack **新增一条 CFN Export**，也就是说
// 只想单独更新 WebChatStack / ImStack 时，也被迫先 update 主栈（会顺带带上主栈上所有未部署
// 的改动）。传 -c 后这两个栈不再引用主栈的这个属性，可以真正 `deploy <栈> --exclusively`。
// ⚠️ 声明位置必须在 ImStack 之前 —— 它现在也要这个值。放在下面（老位置）会是
// `undefined`（TDZ 在 `const` 上是运行时错误，但这里 ImStack 的构造在同一个模块顶层
// 之前执行，拿到的就是 ReferenceError / 或改成 let 之后的 undefined），症状是 IM 侧
// REPORTS_CDN_DOMAIN 永远为空 —— 而那是**静默降级**（回退 presigned，12h 后死链）。
const reportsCdnDomainCtx = (app.node.tryGetContext("reportsCdnDomain") as string | undefined)?.trim();
const reportsCdnDomain = reportsCdnDomainCtx || main.reportsCdnDomain;

// ImStack 条件实例化：enabledPlatforms=none 时整个 IM 侧不部署。
// setup.sh 选"暂不部署 IM"时传 -c enabledPlatforms=none。
//
// ── BotStack（Fargate 长连接）已于 M2 退役，不再实例化 ────────────────────────
// IM 侧现在只有一条路径：Webhook → Lambda（ImStack）。M1 阶段两个栈同时存在，是
// 因为用户只有一个飞书 App，「长连接 → 将事件发送至开发者服务器」这个开关一翻就是
// 切换本身，所以要留着 Fargate 做回滚。现网跑通后（2026-09-03）撤掉。
//
// 撤掉之后的两个直接收益：
//   1. **方式B 不再需要 Docker / Finch** —— 那 5 处 `ContainerImage.fromAsset("../")`
//      是全仓唯一需要容器构建工具的地方（其余 fromAsset 都是普通 zip 资产）。
//   2. synth 快一个量级 —— 不再把整个仓库根当 Docker build context 算 hash
//      （实测 594s → 12s）。
//
// `infra/lib/bot-stack.ts` 与三个 Dockerfile **故意留在仓库里**（不再被任何 app
// 引用）：真要回长连接时，重新 `new BotStack(...)` 比从头重建 VPC/ECS + 重写镜像
// 便宜得多。teardown.sh 仍按名字删 BotStack，好让老装机能清干净。
const enabledPlatforms = app.node.tryGetContext("enabledPlatforms") || "feishu";
if (enabledPlatforms !== "none") {
  // ImStack —— IM 侧的 Lambda + Webhook 实现（IM 重构 M1/M3）。
  // 表与 skills 桶都由 NotiOpsBackendStack 创建（按名字引用），故依赖 main。
  const imStack = new ImStack(app, "ImStack", {
    env,
    description: "NotiOps IM Webhook (Lambda: ingress + worker + progress)",
    metricsTableName: "notiops-metrics",
    configTableName: "notiops-config",
    conversationsTableName: "notiops-conversations",
    skillsBucketName: main.dataBucketName,
    // IM 侧长回答超出卡片正文上限时落 HTML 报告，链接走这个 CDN（见 im-core.ts）。
    reportsCdnDomain,
    // 排障 Agent Space —— **与 WebChatStack 传的是同一个值**（见下面 :105），
    // 所以 IM 与 web 必然指向同一个 space。不传的后果不是报错，是让 IM 侧退回
    // 「按名字 ListAgentSpaces 碰运气」，账号里多一个 space 就全线判成未接入。
    devopsAgentSpaceId: main.agentSpaceId,
  });
  imStack.addStackDependency(main);
}

// WebChatStack：面向客户的 agentic Web Chat。
// 复用 NotiOpsBackendStack 的 Cognito 池（认证统一），故依赖 main。
const webChat = new WebChatStack(app, "WebChatStack", {
  env,
  description: "NotiOps Web Chat (agentic) — BFF streaming + chat-app frontend",
  userPoolId: main.userPoolId,
  userPoolClientId: main.userPoolClientId,
  skillsBucketName: main.dataBucketName, // Skills 存共享 dataBucket 的 skills/ 前缀
  agentSpaceId: main.agentSpaceId, // FinOps 跨账号成本查询动态发现关联账号用
  // 巡检 space（与排障那个是两个）——管理页引导「跨账号巡检要把成员账号
  // 加进哪个 space 作为 monitor account」。前端不硬编码，每次重建栈 id 都会变。
  inspectionAgentSpaceId: main.inspectionAgentSpaceId,
  inspectionAgentSpaceName: `notiops-inspection-${main.account}`,
  // ⚠️ `idleConsoleUrl` 已随老控制台（idle 控制台 + ApiLambda + FrontendCDN）
  //    一起退役（2026-09-04）：巡检看板与管理页都在 web chat 站内，
  //    侧栏那个外链本来就被 SHOW_INSPECTIONS=false 关着。
  reportsCdnDomain, // 「深度调查（直连）」报告链接（CloudFront+OAC，只暴露 reports/*）
});
// 🔴 这条依赖决定了 `cdk deploy --all` **先更主栈**。首装是对的（要先有
//    Cognito 池），但**升级**时它是一个陷阱：主栈上那些 `ExportsOutput…` 是
//    CDK 为跨栈引用自动生成的 CFN Export，退役一个引用（比如上面 2026-09-04
//    退掉的 `idleConsoleUrl` / FrontendCDN）就意味着主栈这一版要**删**那条
//    export；而那一刻客户机器上已装的**老** WebChatStack 还持有
//    `Fn::ImportValue`，CloudFormation 硬拒：
//
//        Export <name> cannot be deleted as it is in use by WebChatStack
//
//    主栈随即 `UPDATE_ROLLBACK_COMPLETE`、后续栈全 SKIPPED，而且**平淡重跑
//    永远撞同一堵墙**（CDK CLI 把 `UPDATE_ROLLBACK_COMPLETE` 归为
//    `isRollbackSuccess`，不会 delete-and-recreate）。
//
//    ⚠️ 所以**别**靠改这里的顺序来治它 —— 首装依然需要主栈先出 Cognito 池。
//    治法在部署侧：`setup.sh` 在 `cdk deploy --all` 之前跑
//    `scripts/export_retire_plan.py`，发现有 export 要退役就先单独
//    `cdk deploy <消费者栈> --exclusively` 把引用放开。改动这里的跨栈引用
//    （新增/删除 `main.xxx` 的传参）会动到 export 集合，CI 上的
//    `scripts/check_cfn_exports.py` + `infra/exports.golden.json` 会拦你一下，
//    让你确认升级路径：golden diff 里只有新增 → 直接发；一旦出现删除，先单独
//    部署消费者栈放开引用，再发主栈。
webChat.addStackDependency(main);
