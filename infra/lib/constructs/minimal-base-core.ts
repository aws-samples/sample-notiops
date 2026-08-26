/**
 * 「最小底座」—— 一键部署（Launch Stack）单栈里那几个 Web Chat 必需、但原本由
 * `NotiOpsBackendStack` 提供的共享资源：Cognito 用户池 + `notiops-config` 表 + 共享数据桶。
 *
 * 为什么不直接复用 `NotiOpsBackendStack`：那个栈还带着 IM bot、巡检 Lambda、EventBridge、
 * SNS、Athena/CUR、报告 CDN 等一整套（1400+ 行），一键部署 M1 的定位是**只上 Web Chat**。
 * 把整个后端栈塞进一键模板会让首次部署时间、失败面、权限要求都成倍上升。
 *
 * ⚠️ 三处必须与 `notiops-backend-stack.ts` 保持**一模一样**（不是"差不多"）：
 *   1. 物理名（`notiops-config` / `notiops-users` / `notiops-web` / `notiops-data-<账号>-<区域>`）
 *      —— BFF、agent、前端都是按名字找它们的，写死在代码与 IAM 策略里；
 *   2. 表的键与 GSI（PK/SK + GSI1 + GSI2）—— 少一个 GSI，读路径直接 ValidationException；
 *   3. 用户组（8 个）与 precedence —— 组名是 RBAC 的输入（authz.mjs DEFAULT_GROUP_ROLE_MAP）。
 * 构件 id 也刻意与后端栈**同名**（`ConfigTable` / `IdleDetectorUserPool` / …）：将来客户想从
 * 一键部署"毕业"到完整部署时，两边逻辑 ID 一致才有可能做栈间资源导入/迁移，而不是重建。
 *
 * ⚠️ 与 `web-chat-core.ts` 同样是**导出函数**而不是 Construct 子类 —— 理由见那个文件的文件头
 * （多一层构件会让所有逻辑 ID 漂移）。这里虽然是新栈、没有历史包袱，但保持同一种写法，
 * 免得下一个人以为两者有本质区别。
 */
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";

export interface MinimalBase {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  configTable: dynamodb.Table;
  dataBucket: s3.Bucket;
  /** 8 个用户组的构件 —— StagerFn 把管理员加进 `admin` 组，必须等组建好（DependsOn）。 */
  groups: cognito.CfnUserPoolGroup[];
  /** 报告分发 CDN 的域名（`REPORTS_CDN_DOMAIN`）。与后端栈的 `reportsCdnDomain` 同义。 */
  reportsCdnDomain: string;
}

export function createMinimalBase(scope: Construct): MinimalBase {
  const stack = cdk.Stack.of(scope);

  // ─── notiops-config：全局配置真源（RBAC / 模型目录 / 纳管账号 / 通知配置）───
  // 与后端栈逐字段一致，包括 RETAIN 与 PITR：
  //   · RETAIN —— 删栈不丢配置（一键部署的 `TeardownMode=DeleteEverything` 时由 StagerFn
  //     显式删表，见 §6.5 障碍 2；默认的 KeepData 就是靠这条 RETAIN 兑现的）；
  //   · PITR —— 写坏了能按时间点恢复（模型目录的写入路径是整份 PUT）。
  const configTable = new dynamodb.Table(scope, "ConfigTable", {
    tableName: "notiops-config",
    partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
  });
  configTable.addGlobalSecondaryIndex({
    indexName: "GSI1",
    partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });
  configTable.addGlobalSecondaryIndex({
    indexName: "GSI2",
    partitionKey: { name: "GSI2PK", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "GSI2SK", type: dynamodb.AttributeType.STRING },
    projectionType: dynamodb.ProjectionType.ALL,
  });

  // ─── Cognito：认证统一（web chat 与控制台同一个池）───
  const userPool = new cognito.UserPool(scope, "IdleDetectorUserPool", {
    userPoolName: "notiops-users",
    selfSignUpEnabled: false, // 管理员创建用户；一键部署里第一个管理员由 StagerFn 建
    signInAliases: { username: true, email: true },
    autoVerify: { email: true },
    passwordPolicy: {
      minLength: 8,
      requireLowercase: true,
      requireUppercase: true,
      requireDigits: true,
      requireSymbols: false,
    },
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const userPoolClient = userPool.addClient("IdleDetectorWebClient", {
    userPoolClientName: "notiops-web",
    authFlows: { userPassword: true, userSrp: true },
    preventUserExistenceErrors: true,
  });

  // 组名与 precedence 与后端栈一致 —— 见文件头第 3 条。
  const groupSpecs: Array<{ id: string; name: string; desc: string; precedence: number }> = [
    { id: "AdminGroup", name: "admin", desc: "Full admin access; can modify configuration (thresholds / target accounts / notifications)", precedence: 1 },
    { id: "MemberGroup", name: "member", desc: "Members: web chat only", precedence: 10 },
    { id: "FinopsTeamGroup", name: "finops-team", desc: "FinOps team: Chat + Notifications + all FinOps", precedence: 20 },
    { id: "SreOpsGroup", name: "sre-ops", desc: "SRE/Ops: Chat + Notifications + all Cases", precedence: 21 },
    { id: "SupportLeadGroup", name: "support-lead", desc: "Support Lead: can act on Cases (create/reply/resolve)", precedence: 22 },
    { id: "ServiceManagerGroup", name: "service-manager", desc: "Service Manager: read-only Cases + Chat", precedence: 23 },
    { id: "DevTeamGroup", name: "dev-team", desc: "Dev team: Chat + Skills management", precedence: 24 },
    { id: "ReadOnlyGroup", name: "read-only", desc: "Read-only: all dashboards read-only, no write actions", precedence: 30 },
  ];
  const groups = groupSpecs.map((g) => new cognito.CfnUserPoolGroup(scope, g.id, {
    userPoolId: userPool.userPoolId,
    groupName: g.name,
    description: g.desc,
    precedence: g.precedence,
  }));

  // ─── 共享数据桶：skills/ + reports/ + onboarding/ 前缀分区（只建 1 个桶）───
  // 与后端栈的差别只有一处，且是**有意**的：这里是 RETAIN + 不开 autoDeleteObjects。
  //   · autoDeleteObjects 会拉起 Custom::S3AutoDeleteObjects（隐式 CDK asset Lambda），
  //     而一键模板里不能有任何 CDK 资产（客户账号没 bootstrap 桶）；
  //   · 因此清桶/删桶改由 StagerFn 在 `TeardownMode=DeleteEverything` 时做。
  // 代价（文档必须写清楚）：默认 KeepData 删栈后这个桶**留着**，而桶名是固定的
  // `notiops-data-<账号>-<区域>` —— 同账号同区域重新部署会撞 BucketAlreadyOwnedByYou。
  const dataBucket = new s3.Bucket(scope, "DataBucket", {
    bucketName: `notiops-data-${stack.account}-${stack.region}`,
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    lifecycleRules: [
      { id: "expire-onboarding-templates-7d", prefix: "onboarding/", expiration: cdk.Duration.days(7) },
      // 报告 7 天生命周期：兑现「报告链接 7 天内有效」的承诺，也避免报告长期堆积。
      { id: "expire-reports-7d", prefix: "reports/", expiration: cdk.Duration.days(7) },
    ],
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  // ─── 报告分发 CDN（CloudFront + OAC，只暴露 reports/*）───────────────────
  // 与 `notiops-backend-stack.ts` 的 ReportsCDN 逐字一致（构件 id 也同名）。**不是可选项**：
  // 缺了它 `REPORTS_CDN_DOMAIN` 为空，core/reports.py 退回 presigned URL（12h 过期），
  // 而产品承诺与桶生命周期都是 7 天 —— 客户第二天点报告链接就 403，且看不出原因。
  // BFF 的「深度调查（直连）」更严格：devops_investigate.mjs 没有 presign 分支，
  // 域名为空时直接不产出报告链接。
  //
  // 安全模型：URL 即凭证（与 presigned 一致，只是不过期），key 用不可猜的 UUID；
  // CloudFront Function 把非 /reports/ 前缀一律 403，避免暴露桶内其它前缀
  // （skills/、onboarding/ 等）；OAC 只读私有桶，不放开桶的公共访问。
  //
  // 一键模板的「不能有 CDK 资产」约束在这里是满足的：`FunctionCode.fromInline` 不产生
  // 资产，Distribution 也只多出一个 AWS::CloudFront::OriginAccessControl + 桶策略。
  const reportsPathGuard = new cloudfront.Function(scope, "ReportsPathGuard", {
    code: cloudfront.FunctionCode.fromInline(
      "function handler(event){var u=event.request.uri;" +
      "if(u.indexOf('/reports/')!==0){return {statusCode:403,statusDescription:'Forbidden'};}" +
      "return event.request;}"
    ),
  });
  const reportsCdn = new cloudfront.Distribution(scope, "ReportsCDN", {
    comment: "NotiOps DevOps/What's New reports (reports/* only)",
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessControl(dataBucket),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      functionAssociations: [{
        function: reportsPathGuard,
        eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
      }],
    },
  });

  return {
    userPool, userPoolClient, configTable, dataBucket, groups,
    reportsCdnDomain: reportsCdn.distributionDomainName,
  };
}
