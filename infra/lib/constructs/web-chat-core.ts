/**
 * Web Chat 核心资源（DDB + BFF + 前端 S3/CloudFront + RUM + config.json 注入）。
 *
 * ⚠️ 这里导出的是**函数**而不是 Construct 子类，这是刻意的：
 *   `new WebChatCore(this, "Core")` 会在每个构件路径里插一层 id
 *   （`WebChatStack/WebChatTable/Resource` → `WebChatStack/Core/WebChatTable/Resource`），
 *   于是**所有逻辑 ID 全部改变** → CFN 对在服务的栈做 delete + recreate。
 *   函数式直接在传入的 scope 上建资源，构件路径、逻辑 ID、`aws:cdk:path`
 *   元数据逐字节不变。判据见 infra/test/web-chat-golden.test.ts。
 *
 * 两个调用方共用这一份定义：
 *   · infra/lib/web-chat-stack.ts —— 现有 `setup.sh` / CDK 部署路径（scope = WebChatStack）
 *   · infra/lib/notiops-webchat-standalone-stack.ts —— 一键部署（Launch Stack）的单栈模板
 */
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rum from "aws-cdk-lib/aws-rum";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as cr from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as path from "path";
import * as fs from "fs";

/** infra/ 目录与仓库根 —— 本文件比原来的 lib/web-chat-stack.ts 深一层，
 *  资产路径必须显式算，不能照抄原来的相对层数（多一层就 synth 失败）。 */
const INFRA_DIR = path.join(__dirname, "..", "..");
const REPO_ROOT = path.join(INFRA_DIR, "..");

/**
 * Web Chat 单表的物理名。**固定名**（不是 CFN 生成名）：栈外的东西按名字找它 ——
 * 「通知」生产端那个 Lambda（方式 B 里它在另一个栈，只能拼 ARN，见
 * `notiops-backend-stack.ts`）、运维时手查数据、文档里的排查步骤。
 * 导出而不是各处写字面量：改名时必须一处改、全处跟着走。
 */
export const WEB_CHAT_TABLE_NAME = "notiops-web-chat";

export interface WebChatCoreProps {
  userPoolId: string;
  userPoolClientId: string;
  /** 共享数据桶名（NotiOpsBackendStack 的 dataBucket）——Skills 存其 skills/ 前缀，与 IM 端共享。 */
  skillsBucketName?: string;
  /** NotiOpsBackendStack 创建的 DevOps Agent Space ID——FinOps 仪表盘跨账号成本
   * 查询用它动态发现关联账号（devops-agent:ListAssociations），不再硬编码 payer
   * 账号 ID/角色 ARN（见 bff/web-chat/devops_agent_accounts.mjs）。 */
  agentSpaceId?: string;
  /** idle 控制台前端 CloudFront 地址（NotiOpsBackendStack.consoleUrl）——写入 config.json，
   * 供 chat-app 侧栏「巡检 & 报告」外链跳转。 */
  idleConsoleUrl?: string;
  /** 报告 CDN 域名（NotiOpsBackendStack.reportsCdnDomain，CloudFront + OAC，只暴露 reports/*）。
   * 「深度调查（直连）」把 HTML 报告落到 dataBucket 的 reports/ 前缀后，用它拼**不过期**的链接。
   * 缺省时直连路径只是少一个报告链接（摘要仍在聊天里），不报错。 */
  reportsCdnDomain?: string;

  /**
   * AgentCore Runtime ARN。缺省时读 `-c agentRuntimeArn=...`（CDK / setup.sh 路径：agent 由
   * `agentcore deploy` 单独部署，部署完再把 ARN 传回来）。
   * 一键部署的 standalone 单栈里 Runtime 是**同栈资源**，这里直接传它的 `GetAtt`（一个 CFN
   * token）—— 因为那条路径上根本没有「先部署 agent 再拿 ARN」这个人工步骤。
   */
  agentRuntimeArn?: string;

  /**
   * Function URL 的 CORS 白名单。缺省时读 `-c allowedOrigins=a,b`，仍为空则回退 `["*"]` 并告警。
   * 传值时**不告警**（调用方已经明确表态了）。standalone 单栈传的是一个
   * `CommaDelimitedList` 参数的 `valueAsList`，值在部署期才知道，synth 期无从校验。
   */
  corsAllowedOrigins?: string[];

  /**
   * 多账号（Organizations）模式的**部署期**表达 —— 一键部署（静态模板）专用。
   *
   * CDK / setup.sh 路径**不传**这个，仍走 synth 期的 `-c organizationId=o-xxxx`
   * （下面那个 `orgMode` 布尔）。静态模板里「单账号还是多账号」是客户在
   * CloudFormation 参数页选的，synth 期无从得知，所以受它影响的 env var 只能落成
   * `Fn::If`，不能是 TS 的三元表达式。
   */
  multiAccount?: {
    /** `o-xxxx`。这里传的是 CFN token（某个 Parameter 的 `valueAsString`）。 */
    organizationId: string;
    /** 「客户选了多账号」那个 `CfnCondition` 的逻辑 ID。 */
    conditionLogicalId: string;
  };

  /**
   * 一键部署（Launch Stack）的**静态模板**模式。默认 `false` = 现有 CDK / setup.sh 路径。
   *
   * `true` 时去掉 4 个**隐式 CDK Lambda**（`Custom::LogRetention`、
   * `Custom::S3AutoDeleteObjects`、`Custom::CDKBucketDeployment`、`ChatConfigProvider`
   * framework），它们的活由 standalone 栈里那个 StagerFn 接管（§6.2 / §6.4）。
   * 为什么必须是**开关**而不是直接改掉：
   *   · 这 4 件事在 CDK 路径下都是**必需**的（BucketDeployment 是前端唯一的上传途径，
   *     去掉它 setup.sh 部署出来就是一个空网站桶）；
   *   · `logRetention:` → 显式 `logGroup:` 会让现网那个在服务的栈**新建**一个
   *     `AWS::Logs::LogGroup`。若沿用 `/aws/lambda/<固定函数名>` 这种名字，而该 log group
   *     已由 Lambda 运行时建过（现网正是如此），CREATE 会因 already exists 失败 → 回滚。
   *     所以静态模板模式里让 CFN 自己生成 log group 名（不写 logGroupName）。
   *
   * 副作用（有意）：显式 log group 是**栈内资源**，删栈时一并删除 —— 顺手解掉 §6.5 障碍 3
   * 里 BFF 那一份「Lambda 自建 log group 会残留」（实测：一次完整删栈后账号里剩下的孤儿
   * 恰好全是 log group）。
   */
  staticTemplate?: boolean;
}

/** createWebChatCore 的返回值 —— standalone 单栈需要拿这些引用继续接线。 */
export interface WebChatCore {
  table: dynamodb.Table;
  bff: lambda.Function;
  fnUrl: lambda.FunctionUrl;
  siteBucket: s3.Bucket;
  distribution: cloudfront.Distribution;
  identityPool: cognito.CfnIdentityPool;
  rumIdentityPool: cognito.CfnIdentityPool;
  rumGuestRole: iam.Role;
  appMonitor: rum.CfnAppMonitor;
  /** `config.json` 的内容（CFN 侧 JSON 字符串，含各资源引用）。
   *  静态模板模式下由 standalone 栈交给 StagerFn 写进网站桶（§6.2）。 */
  configJson: string;
}

/**
 * 在 `scope`（必须是一个 Stack）上直接创建全部 Web Chat 资源。
 * 不新增中间构件层 —— 见文件头的逻辑 ID 说明。
 */
export function createWebChatCore(scope: Construct, props: WebChatCoreProps): WebChatCore {
  const stack = cdk.Stack.of(scope);

  // 多账号(Organizations)模式：-c organizationId=o-xxxx。
  // 解锁 LOCKED_ACCOUNT_ID 闸门 + 启用 Admin「账户」页一键接入（StackSets）。
  const organizationId = (scope.node.tryGetContext("organizationId") as string | undefined)?.trim() || "";
  const orgMode = organizationId.length > 0;

  // 两条路径共用一个开关点：`props.multiAccount` 在（一键部署的静态模板里）→ 部署期
  // `Fn::If`；不在（CDK / setup.sh）→ synth 期的 `orgMode` 布尔。所有受多账号影响的
  // env var 都从这个函数取值，避免两套分支各写一遍写歪。
  const orgSwitch = (whenMulti: string, whenSingle: string): string =>
    props.multiAccount
      ? cdk.Fn.conditionIf(props.multiAccount.conditionLogicalId, whenMulti, whenSingle).toString()
      : orgMode
        ? whenMulti
        : whenSingle;
  // 「这份部署有可能是多账号」——静态模板里恒为真（选没选由部署期条件决定），
  // CDK 路径下等于 orgMode。只用来决定**授权**给不给（见下方 IAM 段的理由）。
  const mayBeOrgMode = orgMode || props.multiAccount !== undefined;

  // ─── DynamoDB：会话/消息单表（§4.3）───
  const table = new dynamodb.Table(scope, "WebChatTable", {
    tableName: WEB_CHAT_TABLE_NAME,
    partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
    sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    timeToLiveAttribute: "ttl",
  });

  // AgentCore Runtime ARN —— agent 由 `agentcore deploy` 单独部署（见 agent/README.md），
  // 部署后把 ARN 通过 -c agentRuntimeArn=... 传进来；为空则 BFF 回退到 echo。
  const agentRuntimeArn = props.agentRuntimeArn || (scope.node.tryGetContext("agentRuntimeArn") as string) || "";

  // ─── Web Chat BFF：streaming Lambda + Function URL ───
  // node_modules 随 asset 一起打包（含 bedrock-agentcore 客户端，不在 Lambda
  // 运行时预装集）。部署前需在 bff/web-chat 跑过 `npm install --omit=dev`
  // （setup.sh 会做；本地已装）。免 Docker bundling。
  const bff = new lambda.Function(scope, "WebChatBff", {
    functionName: "notiops-web-chat-bff",
    // nodejs24.x：nodejs20.x 已于 2026-04-30 弃用（CDK synth 的 validation-report 会明确
    // 报出来），且 **2027-02-01 起禁止新建函数、2027-03-03 起禁止更新** —— 对一个公开
    // sample 来说那天之后 `./setup.sh` 与一键模板会直接建栈失败，而不是"用着旧 runtime"。
    // 本仓库其余 Lambda 早已是 nodejs24.x，只有 BFF 落后（见 golden fixture 的对比）。
    // 这个 construct 被**两条部署路径共用**（setup.sh 的 CDK 与一键模板的 synth 源），
    // 所以改这一处两边同时生效，不会出现方式 A / 方式 B 的 runtime 不一致。
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: "index.handler",
    code: lambda.Code.fromAsset(path.join(REPO_ROOT, "bff", "web-chat")),
    timeout: cdk.Duration.minutes(15), // 长任务（调查）需要长超时
    memorySize: 512,
    environment: {
      WEB_CHAT_TABLE: table.tableName,
      COGNITO_USER_POOL_ID: props.userPoolId,
      AGENT_RUNTIME_ARN: agentRuntimeArn,
      // 多账号：config 表名（复用 notiops-config）+ 跨账号角色名 + 单账号锁定
      CONFIG_TABLE: "notiops-config",
      NOTIOPS_CROSS_ACCOUNT_ROLE: orgSwitch(`notiops-idle-detection-role-${stack.account}`, "notiops-idle-detection-role"),
      // 多账号：解锁，多账号选择器可切换到成员账号。
      // 单账号：锁定部署账号，跨账号 disabled（可在 onboard 后放开）。
      LOCKED_ACCOUNT_ID: orgSwitch("", stack.account),
      // 多账号：Admin「账户」页一键接入用（StackSets）；单账号留空 = 功能禁用
      // （BFF 侧 stackSetName() 见空就抛 org_mode_disabled，不会走到 API 调用）。
      MEMBER_ONBOARDING_STACKSET_NAME: orgSwitch("notiops-member-onboarding", ""),
      NOTIOPS_MEMBER_ROLE_NAME: orgSwitch(`notiops-idle-detection-role-${stack.account}`, ""),
      MEMBER_DA_STACKSET_NAME: orgSwitch("notiops-member-devops-agent", ""),
      ORGANIZATION_ID: orgSwitch(props.multiAccount?.organizationId ?? organizationId, ""),
      // Skills 存共享数据桶的 skills/ 前缀（与 IM 端共享）；缺省时 BFF skills 路由会报未配置
      SKILLS_BUCKET: props.skillsBucketName ?? "",
      // Athena 查询结果落共享数据桶的 athena-results/ 前缀（FinOps 仪表盘 CUR 查询）
      ATHENA_RESULTS_BUCKET: props.skillsBucketName ?? "",
      // 跨账号成本查询目标角色（见 §1c）；空值 = BFF 只查部署账号自身视角。
      // FinOps 跨账号成本查询用它调 devops-agent:ListAssociations 动态发现
      // 关联账号（找 payer），不再硬编码账号 ID/角色 ARN（见
      // bff/web-chat/devops_agent_accounts.mjs）。空值 = 查询回退到部署账号自身视角。
      DEVOPS_AGENT_SPACE_ID: props.agentSpaceId ?? "",
      // 「深度调查（直连）」报告链接：报告落 SKILLS_BUCKET 的 reports/ 前缀，用此 CDN 域名拼
      // 直读链接（CloudFront + OAC，**不过期**）。空值 = 直连路径不给报告链接（不报错）。
      REPORTS_CDN_DOMAIN: props.reportsCdnDomain ?? "",
      // AWS_REGION 由 Lambda 运行时自动注入
    },
    // 两种模式给的是**同一个保留期**，区别只在谁来设：CDK 路径用 logRetention（会带出一个
    // Custom::LogRetention Lambda），静态模板路径用显式 LogGroup 资源。名字交给 CFN 生成 ——
    // 见 props.staticTemplate 的注释（固定名会撞上 Lambda 已经建好的那个）。
    logRetention: props.staticTemplate ? undefined : logs.RetentionDays.TWO_WEEKS,
    logGroup: props.staticTemplate
      ? new logs.LogGroup(scope, "WebChatBffLogs", {
          retention: logs.RetentionDays.TWO_WEEKS,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        })
      : undefined,
  });
  table.grantReadWriteData(bff);

  // Admin 用户管理：列出/创建/删除 Cognito 用户池中的用户（限定本 user pool）。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "cognito-idp:ListUsers", "cognito-idp:AdminCreateUser", "cognito-idp:AdminDeleteUser",
        "cognito-idp:ListGroups", "cognito-idp:CreateGroup", "cognito-idp:DeleteGroup",
        "cognito-idp:ListUsersInGroup", "cognito-idp:AdminAddUserToGroup", "cognito-idp:AdminRemoveUserFromGroup",
      ],
      resources: [`arn:aws:cognito-idp:${stack.region}:${stack.account}:userpool/${props.userPoolId}`],
    }),
  );

  // BFF 读 config 表（notiops-config）列出已注册账号供选择器（只读）
  // + org 模式下 Admin「账户」页一键接入需要 UpdateItem 预登记/翻正账号
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
      resources: [
        `arn:aws:dynamodb:${stack.region}:${stack.account}:table/notiops-config`,
        `arn:aws:dynamodb:${stack.region}:${stack.account}:table/notiops-config/index/*`,
      ],
    }),
  );

  // org 模式：Admin「账户」页一键接入 —— StackSets 下发成员账号资源 + Organizations 账号列表
  //
  // 静态模板下这两条语句**无条件**授予（`mayBeOrgMode` 恒真），不跟着部署期条件走。理由：
  //   · 把整条语句换成 `AWS::NoValue` 得手改 CDK 生成的那份 PolicyDocument，等于跟生成
  //     逻辑赛跑（同一顾虑见下方 StagerReadArtifactMirror 的注释）；
  //   · 客户选了单账号时这两条其实什么都拿不到 —— 两个成员账号 StackSet 只在多账号条件
  //     成立时才由 StagerFn 的 OrgSetup 阶段建出来，压根不存在（资源级 ARN 指空），
  //     `organizations:List*/Describe*` 是纯只读元数据，且 BFF 侧 env 为空会先抛
  //     `org_mode_disabled`，调用根本发不出去。
  if (mayBeOrgMode) {
    const onboardingStackSetName = "notiops-member-onboarding";
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "OrgOnboardStackSets",
        actions: [
          "cloudformation:CreateStackInstances",
          "cloudformation:DeleteStackInstances",
          "cloudformation:DescribeStackSet",
          "cloudformation:DescribeStackSetOperation",
          "cloudformation:ListStackInstances",
        ],
        resources: [
          `arn:aws:cloudformation:${stack.region}:${stack.account}:stackset/${onboardingStackSetName}:*`,
          `arn:aws:cloudformation:*:*:stackset-target/${onboardingStackSetName}:*`,
          `arn:aws:cloudformation:${stack.region}:${stack.account}:stackset/notiops-member-devops-agent:*`,
          `arn:aws:cloudformation:*:*:stackset-target/notiops-member-devops-agent:*`,
          "arn:aws:cloudformation:*::type/resource/*",
        ],
      }),
    );
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        sid: "OrgOnboardListAccounts",
        actions: ["organizations:ListAccounts", "organizations:ListRoots", "organizations:DescribeOrganization", "organizations:ListParents", "organizations:DescribeOrganizationalUnit"],
        resources: ["*"],
      }),
    );
  }

  // ④ SecOps 仪表盘（部署账号自身视角；成员账号经 AssumeRole 走成员角色权限）
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      sid: "SecOpsDashboardsReadOnly",
      actions: [
        "guardduty:ListDetectors", "guardduty:GetFindingsStatistics",
        "guardduty:ListFindings", "guardduty:GetFindings",
        "backup:ListBackupJobs", "backup:ListBackupVaults", "backup:ListProtectedResources",
      ],
      resources: ["*"],
    }),
  );

  // 多账号：BFF 可 AssumeRole 进目标账号的 notiops 跨账号角色（执行写操作）
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      // 只匹配两种合法形态，避免 role* 松散通配误匹配 ...roleFOO：
      resources: [
        "arn:aws:iam::*:role/notiops-idle-detection-role", // 无后缀=部署账号自身/遗留手动接入
        "arn:aws:iam::*:role/notiops-idle-detection-role-*", // 带账号后缀=org 模式成员账号
        // 跨 payer DevOps Agent 接入：testDaConnection AssumeRole 进成员账号的触发角色
        // （member-devops-agent.yaml 建的 notiops-agent-trigger-<acct>-m<sys>）。
        "arn:aws:iam::*:role/notiops-agent-trigger-*",
      ],
    }),
  );

  // BFF 需要调 AgentCore Runtime
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["bedrock-agentcore:InvokeAgentRuntime"],
      // ARN 在部署后才有；用通配限定到本账户的 runtime（避免越权到别处）
      resources: [`arn:aws:bedrock-agentcore:${stack.region}:${stack.account}:runtime/*`],
    }),
  );

  // Admin「通知」板块：读写飞书机器人配置（Secrets Manager 单 secret）。
  // 按**字面名**限定到 notiops/im-bot-feishu*（Secrets Manager ARN 带随机后缀故加 *），
  // 不做跨栈 CFN import —— 老管理前端未来 sunset 时本栈零依赖、零影响。
  // CreateSecret 用于 secret 尚不存在的首次配置场景（如未部署过 IM bot 栈）。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret"],
      resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:notiops/im-bot-feishu*`],
    }),
  );
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["secretsmanager:CreateSecret"],
      resources: [`arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:notiops/im-bot-feishu*`],
    }),
  );

  // BFF 读 AWS Health Dashboard（通知主题重点区块，实时查）。Health API 只读，
  // 不支持资源级限定（只能 *）；需账号有 Business+/Enterprise Support 计划。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["health:DescribeEvents", "health:DescribeEventDetails", "health:DescribeAffectedEntities"],
      resources: ["*"],
    }),
  );

  // ─── FinOps 仪表盘（§13 CUR + Athena FinOps 数据源）───
  // 1) AWS Budgets：预算 vs 实际支出 + AWS 侧预测超支，实时查，不落库
  //    （budgets:ViewBudget 不支持资源级限定，只能 *；账号级只读）。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["budgets:ViewBudget", "budgets:DescribeBudgets"],
      resources: ["*"],
    }),
  );
  // 1b) Cost Explorer：Spend Overview / Marketplace / Support Fees / MoM Movers
  //     四张卡片的数据源（固定查询模板，见 bff/web-chat/cost_explorer.mjs）。
  //     ce:* 只读 API 不支持资源级限定。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "ce:GetCostAndUsage", "ce:GetCostAndUsageComparisons", "ce:GetCostComparisonDrivers",
        "ce:GetCostForecast", "ce:GetAnomalies", "ce:GetAnomalyMonitors", "ce:GetAnomalySubscriptions",
        "ce:GetReservationCoverage", "ce:GetReservationUtilization",
        "ce:GetSavingsPlansCoverage", "ce:GetSavingsPlansUtilization",
        "ce:GetDimensionValues", "ce:GetTags", "ce:GetCostCategories",
      ],
      resources: ["*"],
    }),
  );
  // Cost Optimization Hub（Potential Savings 卡）——只读。COH 是全局服务(us-east-1)，
  // 需账号先开通（enrollment）；未开通时 API 返回空，前端优雅降级为"未开通"。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "cost-optimization-hub:ListEnrollmentStatuses",
        "cost-optimization-hub:GetRecommendation",
        "cost-optimization-hub:ListRecommendations",
        "cost-optimization-hub:ListRecommendationSummaries",
      ],
      resources: ["*"],
    }),
  );
  // 1c) 跨账号成本查询：<member-account> 是 Organization 成员账号，真实历史成本/预算
  //     大多记在 payer 账号上（Cost Explorer 默认只返回调用者所在账号自身的
  //     视角，不会自动汇总到 payer 层级）。复用已有的
  //     DevOpsAgentRole-AgentSpace-notiOps-<account> （DevOps Agent 业务账号
  //     onboarding 时在 payer 账号创建，已挂 AIDevOpsAgentAccessPolicy，内含
  //     budgets:*／ce:*／cur:* 只读权限）——不新建角色，只需让 BFF 能 AssumeRole
  //     过去。Trust Policy 需在 payer 账号侧手动追加信任本 BFF Role（见
  // 1c) 跨账号成本查询：<member-account> 是 Organization 成员账号，真实历史成本/预算
  //     大多记在 payer 账号上（Cost Explorer 默认只返回调用者所在账号自身的
  //     视角，不会自动汇总到 payer 层级）。不再硬编码目标角色 ARN——BFF 动态
  //     调 devops-agent:ListAssociations 读 Agent Space 的关联账号列表，找到
  //     其中的 Organization payer 账号，再 AssumeRole 过去查真实成本（见
  //     bff/web-chat/devops_agent_accounts.mjs）。这两类权限缺一不可：
  //       · devops-agent:ListAssociations —— 读本账号 Agent Space 的关联列表
  //       · sts:AssumeRole —— 假设关联账号的 assumableRoleArn（各关联账号在
  //         onboarding 时创建，例如 DevOpsAgentRole-AgentSpace-notiOps-<account>），
  //         Resource 用 * 是因为角色 ARN 属于其它账号、CDK synth 时不可知；
  //         真正的访问边界由对方账号 Trust Policy 决定（对方必须显式信任本
  //         BFF Role 才能被 assume——见 docs/DEPLOYMENT.md §14 跨账号成本查询）。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      // NOTE: SDK client-devops-agent 的 ListAssociations 在 IAM 里授权命名空间是
      // aidevops:（与 resource ARN 的 arn:aws:aidevops:... 一致），不是 devops-agent:。
      // 写成 devops-agent: 会 AccessDenied，拖垮 FinOps 仪表盘取数（500）。
      //
      // Asset API（skill 发布到本账号 Agent Space；见 bff/web-chat/devops_agent_skills.mjs）：
      //   CreateAsset/UpdateAsset/DeleteAsset/ListAsset(s) —— 把「文档型 skill」zip 装进
      //   Agent Space，激活由 DevOps Agent 自行判断（read-only 边界不受影响）。跨 payer
      //   成员账号的上传走 AssumeRole 进 notiops-agent-trigger-* 触发角色，权限在成员
      //   模板 member-devops-agent.yaml 里授予，不在此 BFF Role。
      // 「深度调查（直连）」（bff/web-chat/devops_investigate.mjs）：BFF 不经 agent runtime
      // 直接发起并跟踪 DevOps Agent 调查 —— CreateBacklogTask 建 INVESTIGATION 任务、
      // GetBacklogTask 判终态、ListJournalRecords 拉分析过程与最终摘要、ListRecommendations
      // 备缓解建议。这是老「深度调查」链路里 core/devops_agent.py 用的同一组 API（0 token），
      // 只是搬到了 BFF 侧执行。跨 payer 成员账号仍走 AssumeRole（权限在成员模板里）。
      // 「DevOps 对话」（bff/web-chat/devops_chat.mjs）：BFF 直连 DevOps Agent **控制面对话 API**，
      // 由客户自己的 DevOps Agent 回答（NotiOps 侧 0 token）—— CreateChat 建会话、SendMessage
      // 发一轮并接事件流、ListPendingMessages 探"是否在等人工确认"（只提示、绝不代批准）。
      // 缺 ListPendingMessages 的后果：答案照出，但需要确认的动作会静默卡住、用户不知道要去后台点。
      actions: [
        "aidevops:ListAssociations",
        "aidevops:CreateAsset", "aidevops:UpdateAsset",
        "aidevops:DeleteAsset", "aidevops:ListAssets",
        "aidevops:CreateBacklogTask", "aidevops:GetBacklogTask",
        "aidevops:ListJournalRecords", "aidevops:ListRecommendations",
        "aidevops:CreateChat", "aidevops:SendMessage", "aidevops:ListPendingMessages",
      ],
      resources: [`arn:aws:aidevops:${stack.region}:${stack.account}:agentspace/*`],
    }),
  );
  // Agent Space **自动发现**（bff/web-chat/devops_agent_skills.mjs 的 localAgentSpaceProbe）：
  // DEVOPS_AGENT_SPACE_ID 只在「主栈 + WebChatStack 一起部署」时才被跨栈引用注入，单独
  // 部署 WebChatStack 等场景会是空串 —— 此时回退到 ListAgentSpaces 找 notiops-devops-<account>，
  // 与 agent runtime 侧（core/devops_agent.py 的 _discover_space）行为一致，避免"账号里明明
  // 有 Agent Space，深度调查却报 no_local_agent_space"。
  // List 类 API 不接受资源级限定（列的就是"本账号有哪些"），只能 *；它是只读且不返回任何
  // Agent Space 内的数据（只有 id/name），扩权面很小。
  bff.addToRolePolicy(
    new iam.PolicyStatement({ actions: ["aidevops:ListAgentSpaces"], resources: ["*"] }),
  );
  // 动态发现 Organization payer（管理账号）——FinOps 跨账号成本查询用它拿到 payer
  // 账号 ID，再 AssumeRole 进 payer 的成本只读角色（见 bff/web-chat/devops_agent_accounts.mjs
  // 的 findPayerAccount）。DescribeOrganization 不支持资源级限定，只能 *。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["organizations:DescribeOrganization"],
      resources: ["*"],
    }),
  );
  // （已移除 sts:AssumeRole Resource:"*" 的过度授权——单账号部署下 BFF 不需要
  //   assume 任何跨账号角色：findPayerAccount 在 payer==自己时短路为「本账号 CE 视角」，
  //   Cost Explorer 直接用 BFF 自身的 ce:* 权限查本账号（部署账号=payer 时即真实成本）。
  //   若将来要做真正的跨账号成本聚合，再按最小权限加回「具体 payer 角色 ARN」的 AssumeRole。）
  // 2) CUR/Athena 状态：读 notiops-config 表的 cur-athena-status# 记录
  //    （setup.sh 创建 CUR 时写入，lambda6_cur_finalizer 更新为 READY/DELAYED/FAILED）
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["dynamodb:GetItem"],
      resources: [`arn:aws:dynamodb:${stack.region}:${stack.account}:table/notiops-config`],
    }),
  );
  // 3) Athena 查询 CUR 表（DevOps Agent 调用成本等只有 CUR 明细才能查到的维度）。
  //    结果桶用共享数据桶下的 athena-results/ 前缀（不新建桶，复用现有 dataBucket）。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults",
        "athena:StopQueryExecution",
        "athena:ListNamedQueries", "athena:BatchGetNamedQuery", "athena:GetNamedQuery",
      ],
      resources: [`arn:aws:athena:${stack.region}:${stack.account}:workgroup/primary`],
    }),
  );
  // Bedrock 推理。两个用途：
  //  1. Cost Deep Dive —— 对【已 grounded 的 Athena 结果行】生成 insight + 图型 spec。
  //  2. Admin「模型」页的连通性测试 —— 对目录里任一候选模型发一次最小 Converse
  //     探测（POST /admin/llm-config/test）。
  // 用途 2 要求 foundation-model 不能只限 anthropic.claude-*：原先那样收窄的话，测
  // Nova / DeepSeek 一律返回 forbidden → UI 永不置 verified → validateConfig 拒绝把
  // 未 verified 的模型设为默认 → **任何非 Claude 模型都无法成为默认模型**。
  // 探测请求本身极小（maxTokens 8），且该端点受 nav:admin 门禁。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      sid: "BedrockInferenceAndConnectivityProbe",
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        "arn:aws:bedrock:*::foundation-model/*",
        // Global CRIS（`global.*` inference profile，本目录 Claude 条目全部在用）在授权
        // 时呈现的是一个**region 段为空**的 foundation-model ARN，配合
        // `aws:RequestedRegion == "unspecified"`。上面那条里的 `*` 理论上能匹配空段
        // （IAM 通配符匹配零个或多个字符），但这条判断错的后果是生产环境全部 Bedrock
        // 调用 AccessDenied，不值得赌语义细节 —— 显式写出来，也让意图可读。
        // 参见 https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
        "arn:aws:bedrock:::foundation-model/*",
        `arn:aws:bedrock:*:${stack.account}:inference-profile/*`,
      ],
    }),
  );

  // Mantle（GPT 系）连通性探测：Admin「模型」页点「测试」时，BFF 用自己的角色 SigV4 签
  // 一次最小 Responses 请求（签名服务名 bedrock-mantle）。
  // **必须单独一条语句**：`bedrock-mantle:*` 的资源不可能匹配上面那条
  // `arn:aws:bedrock:...` 的语句 —— 一次 Allow 要求 action 与 resource **同时**命中。
  // 写错的后果是探测恒返回 forbidden，于是 GPT 系模型永远通不过保存时的默认模型校验。
  //
  // resources 为 "*" 是**有意为宽**，不是被迫：探测的目标区域由管理员在 Admin 页选，
  // 取值范围是 llm_config.mjs::MANTLE_REGIONS（14 个区），随时可改且不需要重新部署。
  // 早先这里的注释写「Mantle 是账号级服务、无资源维度」—— 那是错的：CreateInference
  // 有必填的 `project` 资源类型（见 service-authorization 的 list_bedrock-mantle，
  // AWS 托管策略 AmazonBedrockMantleInferenceAccess 就收窄到
  // arn:aws:bedrock-mantle:*:*:project/*）。
  //
  // ⚠️ 注意本条与 AgentCore runtime 角色的**不对称**：这里是 "*"（全区），
  // agent-build/.../cdk/lib/cdk-stack.ts 按区收窄。所以「保存时探测通过」不等于
  // 「聊天时调得通」—— 探测用的是 BFF 这个角色。两者的区域集必须保持
  // runtime ⊇ 白名单，由 scripts/test_mantle_regions_consistent.py 守。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      sid: "BedrockMantleConnectivityProbe",
      actions: ["bedrock-mantle:CreateInference"],
      resources: ["*"],
    }),
  );

  // Admin「模型」页的候选全集：GET /admin/llm-config/candidates 需要**两个** List：
  //   · ListFoundationModels  —— 本区域的基座模型（`anthropic.claude-sonnet-5` 这类）
  //   · ListInferenceProfiles —— 跨区域路由 profile（`global.*` / `apac.*` / `jp.*`）
  // 两者缺一不可：本系统目录默认用 Global CRIS（`global.anthropic.claude-sonnet-5`），
  // 而 ListFoundationModels **不返回** profile。只有基座模型时，候选里看到的是
  // `anthropic.claude-sonnet-5`，与目录里实际生效的 ID 对不上号，管理员会以为模型没上。
  // 两个 API 都不支持资源级限定，只能是 "*"（纯读、不含模型内容）。
  // 缺 ListFoundationModels 时 apiGetCandidates 只回 3 个 Mantle 型号 + warning；
  // 缺 ListInferenceProfiles 时基座模型仍在，但 global.* 全部消失（附 warning）。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      sid: "BedrockListFoundationModels",
      actions: ["bedrock:ListFoundationModels", "bedrock:ListInferenceProfiles"],
      resources: ["*"],
    }),
  );

  // Admin「模型」页的 Bedrock API Key：读状态（是否已配置 + 后 4 位）与写入 / 清除。
  // Secret 由 NotiOpsBackendStack 创建（notiops/bedrock-api-key），故这里按**字面名**
  // 限定（Secrets Manager ARN 带随机后缀，所以带 *）。CreateSecret 兜住 backend 栈
  // 尚未部署过的场景。
  // 缺这条时：keyStatus() 吞掉 AccessDenied 报「未配置」（即使已配置），而
  // apiPutBedrockKey 的 UpdateSecret 抛的不是 ResourceNotFoundException，
  // 于是穿透到 500 —— API Key 页面直接报错且无可操作信息。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      sid: "BedrockApiKeySecretAccess",
      actions: [
        "secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue",
        "secretsmanager:UpdateSecret", "secretsmanager:DescribeSecret",
        "secretsmanager:CreateSecret",
      ],
      resources: [
        `arn:aws:secretsmanager:${stack.region}:${stack.account}:secret:notiops/bedrock-api-key*`,
      ],
    }),
  );
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      // Glue Data Catalog 是 Athena 查询 CUR 表的底层依赖；限定到 lambda6 建的
      // Athena 集成栈会用到的 database/table（athena_database 名 = report_name
      // 小写下划线化，见 lambda6_cur_finalizer.handler；此处用通配兜底，因为
      // report_name 可能被用户在复用既有 CUR 时自定义）。
      actions: ["glue:GetDatabase", "glue:GetTable", "glue:GetTables", "glue:GetPartitions"],
      resources: [
        `arn:aws:glue:${stack.region}:${stack.account}:catalog`,
        `arn:aws:glue:${stack.region}:${stack.account}:database/*`,
        `arn:aws:glue:${stack.region}:${stack.account}:table/*/*`,
      ],
    }),
  );
  if (props.skillsBucketName) {
    // Athena 查询结果落 athena-results/ 前缀（复用共享数据桶，不新建桶）；
    // CUR 数据本身在 notiops-cur-* 专用桶（setup.sh 建），需要单独授予读权限。
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        // Athena StartQueryExecution 会对结果输出桶做 GetBucketLocation 校验——缺它会报
        // "Unable to verify/create the output bucket"，查询根本启动不了。
        actions: ["s3:GetObject", "s3:PutObject", "s3:ListBucket", "s3:GetBucketLocation"],
        resources: [
          `arn:aws:s3:::${props.skillsBucketName}`,
          `arn:aws:s3:::${props.skillsBucketName}/athena-results/*`,
        ],
      }),
    );
  }
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      // Athena 查 CUR 时需读 CUR parquet 所在桶。复用既有 CUR 时桶名由客户自定义、
      // 部署期不可知（且 Athena 结果桶另有精确授权），故 CUR 数据只读放开到 *。
      actions: ["s3:GetObject", "s3:ListBucket"],
      resources: ["*"],
    }),
  );

  // Skills：BFF 读写共享数据桶的 skills/ 前缀（与 IM 端共享同一份 skills）。
  // 限定到 skills/* 对象，并允许 List（带前缀）以枚举 skill。
  if (props.skillsBucketName) {
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        resources: [`arn:aws:s3:::${props.skillsBucketName}/skills/*`],
      }),
    );
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:ListBucket"],
        resources: [`arn:aws:s3:::${props.skillsBucketName}`],
        conditions: { StringLike: { "s3:prefix": ["skills/*", "skills/"] } },
      }),
    );
    // 「深度调查（直连）」报告落盘：HTML 报告写共享数据桶的 reports/ 前缀，读取走
    // ReportsCDN（CloudFront + OAC，ReportsPathGuard 把非 /reports/ 一律 403），
    // 因此**只需写权限、不需要 presign**（CDN 链接直读且不过期）。
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:PutObject"],
        resources: [`arn:aws:s3:::${props.skillsBucketName}/reports/*`],
      }),
    );
    // 跨 payer 接入：generateLaunchStackUrl 读模板源(onboarding-templates/member-devops-agent.yaml)
    // 并把带账号后缀的副本 Put 回同前缀，再 presign 出 Launch Stack 深链。
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [`arn:aws:s3:::${props.skillsBucketName}/onboarding-templates/*`],
      }),
    );
  }

  // BFF 执行用户已确认的 Support 写操作（创建/回复/关闭 case）。Support API 是
  // 全局服务，resource 只能用 *。写操作仅在用户 UI 确认后由 /actions/execute 触发。
  // NOTE: AWS Support API actions do NOT support resource-level permissions — IAM
  // requires "*" for both the read (Describe*) and write (CreateCase/
  // AddCommunicationToCase/ResolveCase) actions. Access control is enforced at the
  // application layer via Cognito user authentication + explicit in-UI confirmation
  // before any write is dispatched.
  // See: https://docs.aws.amazon.com/service-authorization/latest/reference/list_awssupport.html
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "support:CreateCase",
        "support:AddCommunicationToCase",
        "support:ResolveCase",
        "support:DescribeCases",
        "support:DescribeCommunications",
        "support:DescribeServices",       // 创建案例卡片的服务/类别下拉数据源
        "support:DescribeSeverityLevels", // 严重级别下拉（按计划可用级别）
        "support:DescribeTrustedAdvisorChecks",       // Security 仪表盘 — TA 安全检查（只读）
        "support:DescribeTrustedAdvisorCheckResult",  // Security 仪表盘 — TA 检查结果（只读）
      ],
      resources: ["*"],
    }),
  );

  // Investigation 告警仪表盘 — CloudWatch 告警只读（DescribeAlarms/History；绝不写告警）。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["cloudwatch:DescribeAlarms", "cloudwatch:DescribeAlarmHistory"],
      resources: ["*"],
    }),
  );

  // 生命周期/EOS 仪表盘 — 多 region 只读发现资源版本 + 版本 EOL(RDS/EKS 有实时 API)。全 describe/list 只读。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: [
        "ec2:DescribeRegions",
        "rds:DescribeDBInstances", "rds:DescribeDBClusters", "rds:DescribeDBEngineVersions",
        "eks:ListClusters", "eks:DescribeCluster", "eks:DescribeClusterVersions",
        "lambda:ListFunctions",
        "elasticache:DescribeCacheClusters",
        "es:ListDomainNames", "es:DescribeDomains",
        "elasticmapreduce:ListClusters", "elasticmapreduce:DescribeCluster",
      ],
      resources: ["*"],
    }),
  );

  // Security 仪表盘 — Security Hub 活跃发现（只读）。未开通时 API 返回错误，前端优雅降级。
  bff.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["securityhub:GetFindings", "securityhub:GetInsights"],
      resources: ["*"],
    }),
  );

  // Function URL，response streaming + AWS_IAM 鉴权（不再 world-accessible，
  // 满足安全基线/Epoxy）。前端用 Cognito Identity Pool 拿临时凭证、SigV4 签名调用。
  // 用户身份（idToken→sub）走请求体，由 handler 校验（Authorization 已被 SigV4 占用）。
  // CORS：优先用部署方通过 `-c allowedOrigins=https://a.com,https://b.com` 指定的可信域名白名单。
  // 未指定时回退 ["*"] —— 说明：① 端点已由 AWS_IAM/SigV4 鉴权，浏览器 CORS 不是主要信任边界；
  // ② 前端 CloudFront 域名每次部署动态生成、部署期未知，示例仓库无法预置固定白名单。
  // 生产部署应显式传 allowedOrigins 收窄到自己的前端域名。
  const corsAllowedOrigins = (() => {
    if (props.corsAllowedOrigins?.length) return props.corsAllowedOrigins;
    const raw = (scope.node.tryGetContext("allowedOrigins") as string) || "";
    const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (!list.length) {
      cdk.Annotations.of(scope).addWarning(
        "Function URL CORS allowedOrigins 回退到 ['*']（所有来源）。生产部署请传 " +
        "`-c allowedOrigins=https://<你的前端域名>` 收窄到可信域名。" +
        "端点仍由 AWS_IAM/SigV4 鉴权，但收窄 CORS 是纵深防御的推荐做法。",
      );
      return ["*"];
    }
    return list;
  })();
  const fnUrl = bff.addFunctionUrl({
    authType: lambda.FunctionUrlAuthType.AWS_IAM,
    invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    cors: {
      allowedOrigins: corsAllowedOrigins,
      allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST, lambda.HttpMethod.PUT, lambda.HttpMethod.DELETE, lambda.HttpMethod.PATCH],
      allowedHeaders: [
        "content-type", "authorization",
        "x-amz-date", "x-amz-security-token", "x-amz-content-sha256",
        "x-notiops-id-token", // 用户身份头（被 SigV4 签名，跨域需放行）
      ],
    },
  });

  // ─── Cognito Identity Pool：把 User Pool 登录换成临时 AWS 凭证（用于 SigV4）───
  const identityPool = new cognito.CfnIdentityPool(scope, "ChatIdentityPool", {
    identityPoolName: "notiops-web-chat",
    allowUnauthenticatedIdentities: false,
    cognitoIdentityProviders: [
      {
        clientId: props.userPoolClientId,
        providerName: `cognito-idp.${stack.region}.amazonaws.com/${props.userPoolId}`,
      },
    ],
  });

  // 已登录用户的角色：只允许调这个 BFF Function URL
  const authRole = new iam.Role(scope, "ChatAuthRole", {
    assumedBy: new iam.FederatedPrincipal(
      "cognito-identity.amazonaws.com",
      {
        StringEquals: { "cognito-identity.amazonaws.com:aud": identityPool.ref },
        "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" },
      },
      "sts:AssumeRoleWithWebIdentity",
    ),
  });
  // AWS_IAM 类型的 Function URL 调用，AWS 要求调用方同时具备 lambda:InvokeFunctionUrl
  // 和 lambda:InvokeFunction 两个权限（见 https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html
  // “Using the AWS_IAM auth type”）。只给 InvokeFunctionUrl 会导致签名有效、身份被识别，
  // 但授权阶段因缺 InvokeFunction 被拒 → AccessDeniedException / 前端 403（见 pitfalls #33）。
  // 注：等价于 CDK 的 fnUrl.grantInvokeUrl(authRole)（同账号仅授 identity InvokeFunctionUrl），
  //     这里显式两条以补齐 grantInvokeUrl 不含的 lambda:InvokeFunction。
  authRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["lambda:InvokeFunctionUrl"],
      resources: [bff.functionArn],
      conditions: { StringEquals: { "lambda:FunctionUrlAuthType": "AWS_IAM" } },
    }),
  );
  // InvokeFunction 用 lambda:InvokedViaFunctionUrl 条件限定为“仅经由 Function URL 调用”，
  // 避免这个前端角色被用来直接 InvokeFunction。注意：InvokeFunction 的授权上下文里
  // 没有 lambda:FunctionUrlAuthType 键，因此不能沿用上面那个条件（否则条件不匹配又被拒）。
  authRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [bff.functionArn],
      conditions: { Bool: { "lambda:InvokedViaFunctionUrl": "true" } },
    }),
  );

  new cognito.CfnIdentityPoolRoleAttachment(scope, "ChatIdentityPoolRoles", {
    identityPoolId: identityPool.ref,
    roles: { authenticated: authRole.roleArn },
  });

  // ─── chat-app 前端：S3 + CloudFront ───
  const siteBucket = new s3.Bucket(scope, "ChatFrontendBucket", {
    bucketName: `notiops-chat-frontend-${stack.account}-${stack.region}`,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    encryption: s3.BucketEncryption.S3_MANAGED,   // 显式服务端加密（对齐 dataBucket；安全要求）
    enforceSSL: true,                              // 强制传输层 TLS（拒绝明文 HTTP 请求）
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    // 静态模板模式下清桶由 StagerFn 的 Delete 阶段做（§6.5 障碍 1）——
    // autoDeleteObjects 会拉起一个 Custom::S3AutoDeleteObjects Lambda（隐式 asset）。
    // 两种模式都必须有人清空，否则 DESTROY 的桶因非空而删不掉、整个删栈卡住。
    autoDeleteObjects: props.staticTemplate ? false : true,
  });

  const oai = new cloudfront.OriginAccessIdentity(scope, "ChatOAI");
  siteBucket.grantRead(oai);

  const distribution = new cloudfront.Distribution(scope, "ChatCDN", {
    defaultBehavior: {
      origin: origins.S3BucketOrigin.withOriginAccessIdentity(siteBucket, { originAccessIdentity: oai }),
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    },
    defaultRootObject: "index.html",
    errorResponses: [
      { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.minutes(5) },
      { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html", ttl: cdk.Duration.minutes(5) },
    ],
  });

  // 部署前端静态文件（chat-app/dist 必须已由 setup.sh 提前构建）。
  // 静态模板模式：整个 BucketDeployment 不建 —— 前端 dist 是从 GitHub Release 下来的
  // chat-dist.zip，由 StagerFn 解压进这个桶（§4.1）。
  const distPath = path.join(REPO_ROOT, "frontend", "chat-app", "dist");
  const hasDist = fs.existsSync(distPath);
  const deployment = props.staticTemplate
    ? undefined
    : new s3deploy.BucketDeployment(scope, "DeployChatFrontend", {
        // dist 未构建时用占位，避免 synth 失败；setup.sh 会先构建再部署
        sources: [hasDist ? s3deploy.Source.asset(distPath) : s3deploy.Source.data("index.html", "<!doctype html><title>NotiOps</title>build chat-app first")],
        destinationBucket: siteBucket,
        distribution,
        distributionPaths: ["/*"],
      });

  // 跨 payer 接入模板预置：把 member-devops-agent.yaml 推到共享数据桶的
  // onboarding-templates/ 前缀。BFF generateLaunchStackUrl 在 Lambda 里读不到
  // 本地 infra/ 路径，会回退到 s3://<skillsBucket>/onboarding-templates/member-devops-agent.yaml
  // 拿模板源（见 bff/web-chat/member_accounts.mjs）。缺它则跨 payer 生成链接报 config_error。
  //
  // 静态模板模式同样跳过（又一个 BucketDeployment）。代价说清楚：**跨 payer 接入链接生成
  // 会报 config_error**。这只影响多账号(org)模式下的「一键接入其它 payer」，M1 一键部署
  // 的定位是单账号起步，所以接受；真要用时走 setup.sh 路径或手工上传该模板。
  if (props.skillsBucketName && !props.staticTemplate) {
    const tmplPath = path.join(INFRA_DIR, "member-devops-agent.yaml");
    if (fs.existsSync(tmplPath)) {
      const onboardingBucket = s3.Bucket.fromBucketName(scope, "OnboardingTemplatesBucket", props.skillsBucketName);
      new s3deploy.BucketDeployment(scope, "DeployOnboardingTemplate", {
        sources: [s3deploy.Source.data("member-devops-agent.yaml", fs.readFileSync(tmplPath, "utf-8"))],
        destinationBucket: onboardingBucket,
        destinationKeyPrefix: "onboarding-templates",
        prune: false, // 只管这一个模板，不清理该前缀下其它对象（含 BFF 生成的带账号后缀副本）
      });
    }
  }

  // ─── CloudWatch RUM（前端 APM/RUM：JS 未捕获异常/性能/HTTP 采集，问题排查）───
  // 专用 guest identity pool（unauth）→ 登录前后都能上报（含登录页/初始化错误）。
  // cwLogEnabled → RUM 事件同时写 CloudWatch Logs，便于与 BFF 日志关联定位根因。
  const rumAppMonitorName = "notiops-web-chat";
  const rumIdentityPool = new cognito.CfnIdentityPool(scope, "RumIdentityPool", {
    identityPoolName: "notiops-web-chat-rum",
    allowUnauthenticatedIdentities: true,
  });
  const rumGuestRole = new iam.Role(scope, "RumGuestRole", {
    assumedBy: new iam.FederatedPrincipal(
      "cognito-identity.amazonaws.com",
      {
        StringEquals: { "cognito-identity.amazonaws.com:aud": rumIdentityPool.ref },
        "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "unauthenticated" },
      },
      "sts:AssumeRoleWithWebIdentity",
    ),
  });
  rumGuestRole.addToPolicy(
    new iam.PolicyStatement({
      actions: ["rum:PutRumEvents"],
      resources: [`arn:aws:rum:${stack.region}:${stack.account}:appmonitor/${rumAppMonitorName}`],
    }),
  );
  new cognito.CfnIdentityPoolRoleAttachment(scope, "RumIdentityPoolRoles", {
    identityPoolId: rumIdentityPool.ref,
    roles: { unauthenticated: rumGuestRole.roleArn },
  });
  const appMonitor = new rum.CfnAppMonitor(scope, "ChatRumAppMonitor", {
    name: rumAppMonitorName,
    domain: distribution.distributionDomainName,
    cwLogEnabled: true,
    appMonitorConfiguration: {
      identityPoolId: rumIdentityPool.ref,
      guestRoleArn: rumGuestRole.roleArn,
      allowCookies: true,
      enableXRay: false,
      sessionSampleRate: 1,
      telemetries: ["errors", "performance", "http"],
    },
  });

  // ─── config.json 注入（运行时配置：chatApiBase + cognito）───
  //
  // chatApiBase = Function URL（形如 https://xxx.lambda-url.region.on.aws/，含末尾 /）。
  // 前端 src/api/chat.ts 会规范化末尾 / 再拼 /stream、/conversations。
  //
  // 内容两种模式共用（都是 CFN 侧的 Fn::Join，含各资源的 Ref/GetAtt）；区别只在**谁写**：
  //   · CDK 路径 —— 下面那个 ChatConfigFunction + cr.Provider（framework Lambda = 隐式 asset）
  //   · 静态模板路径 —— 原样返回给 standalone 栈，由 StagerFn 一并写进网站桶（§6.2）
  const configJson = stack.toJsonString({
    chatApiBase: fnUrl.url,
    cognitoUserPoolId: props.userPoolId,
    cognitoClientId: props.userPoolClientId,
    cognitoIdentityPoolId: identityPool.ref,
    region: stack.region,
    idleConsoleUrl: props.idleConsoleUrl ?? "",
    rumAppMonitorId: appMonitor.attrId,
    rumIdentityPoolId: rumIdentityPool.ref,
    rumGuestRoleArn: rumGuestRole.roleArn,
    rumRegion: stack.region,
  });

  if (props.staticTemplate) {
    // ─── Outputs（与下面 CDK 路径那份保持一致）───
    new cdk.CfnOutput(scope, "ChatUrl", { value: `https://${distribution.distributionDomainName}`, description: "Web Chat frontend URL" });
    new cdk.CfnOutput(scope, "ChatBffUrl", { value: fnUrl.url, description: "Web Chat BFF Function URL (streaming)" });
    new cdk.CfnOutput(scope, "WebChatTableName", { value: table.tableName });
    return { table, bff, fnUrl, siteBucket, distribution, identityPool, rumIdentityPool, rumGuestRole, appMonitor, configJson };
  }

  const configFn = new lambda.Function(scope, "ChatConfigFunction", {
    runtime: lambda.Runtime.PYTHON_3_14,
    handler: "index.handler",
    code: lambda.Code.fromAsset(path.join(INFRA_DIR, "lambda", "chat-config")),
    timeout: cdk.Duration.minutes(2),
    memorySize: 256,
  });
  siteBucket.grantWrite(configFn);
  configFn.addToRolePolicy(
    new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: [siteBucket.arnForObjects("*")] }),
  );

  const configProvider = new cr.Provider(scope, "ChatConfigProvider", {
    onEventHandler: configFn,
    logRetention: logs.RetentionDays.ONE_WEEK,
  });

  const configResource = new cdk.CustomResource(scope, "ChatConfig", {
    serviceToken: configProvider.serviceToken,
    properties: {
      bucketName: siteBucket.bucketName,
      config: configJson,
      // synth 时刻的时间戳 = 「每次 cdk deploy 都重写一遍 config.json」。在 CDK 路径下这是
      // 对的（synth 与 deploy 同一次执行）。§6.2 提到的坑是**静态模板**路径：在那里会固化成
      // 一个常量。上面的 staticTemplate 分支根本不建这个资源（config 由 StagerFn 按
      // ReleaseTag 重写），所以此处保持原样。
      timestamp: Date.now().toString(),
    },
  });
  configResource.node.addDependency(deployment!);

  // ─── Outputs ───
  new cdk.CfnOutput(scope, "ChatUrl", { value: `https://${distribution.distributionDomainName}`, description: "Web Chat frontend URL" });
  new cdk.CfnOutput(scope, "ChatBffUrl", { value: fnUrl.url, description: "Web Chat BFF Function URL (streaming)" });
  new cdk.CfnOutput(scope, "WebChatTableName", { value: table.tableName });

  return { table, bff, fnUrl, siteBucket, distribution, identityPool, rumIdentityPool, rumGuestRole, appMonitor, configJson };
}
