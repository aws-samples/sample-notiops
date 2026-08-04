/**
 * WebChatStack — NotiOps 面向客户的 agentic Web Chat。
 *
 * Phase 0 部署：
 *   - notiops-web-chat DDB 表（会话/消息，单表 + TTL）
 *   - Web Chat BFF：Node 20 Lambda + Function URL（response streaming, SSE）
 *   - chat-app 前端：S3 + CloudFront
 *   - config.json 注入（chatApiBase = Function URL；cognito* 复用 idle 池）
 *
 * 认证复用 NotiOpsBackendStack 的 Cognito 池（props 传入 userPoolId/clientId）。
 * Phase 1 起 BFF 内部改为调用 AgentCore Runtime（本 stack 结构不变）。
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

export interface WebChatStackProps extends cdk.StackProps {
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
}

export class WebChatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebChatStackProps) {
    super(scope, id, props);

    // 多账号(Organizations)模式：-c organizationId=o-xxxx。
    // 解锁 LOCKED_ACCOUNT_ID 闸门 + 启用 Admin「账户」页一键接入（StackSets）。
    const organizationId = (this.node.tryGetContext("organizationId") as string | undefined)?.trim() || "";
    const orgMode = organizationId.length > 0;

    // ─── DynamoDB：会话/消息单表（§4.3）───
    const table = new dynamodb.Table(this, "WebChatTable", {
      tableName: "notiops-web-chat",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: "ttl",
    });

    // AgentCore Runtime ARN —— agent 由 `agentcore deploy` 单独部署（见 agent/README.md），
    // 部署后把 ARN 通过 -c agentRuntimeArn=... 传进来；为空则 BFF 回退到 echo。
    const agentRuntimeArn = (this.node.tryGetContext("agentRuntimeArn") as string) || "";

    // ─── Web Chat BFF：streaming Lambda + Function URL ───
    // node_modules 随 asset 一起打包（含 bedrock-agentcore 客户端，不在 Lambda
    // 运行时预装集）。部署前需在 bff/web-chat 跑过 `npm install --omit=dev`
    // （setup.sh 会做；本地已装）。免 Docker bundling。
    const bff = new lambda.Function(this, "WebChatBff", {
      functionName: "notiops-web-chat-bff",
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "bff", "web-chat")),
      timeout: cdk.Duration.minutes(15), // 长任务（调查）需要长超时
      memorySize: 512,
      environment: {
        WEB_CHAT_TABLE: table.tableName,
        COGNITO_USER_POOL_ID: props.userPoolId,
        AGENT_RUNTIME_ARN: agentRuntimeArn,
        // 多账号：config 表名（复用 notiops-config）+ 跨账号角色名 + 单账号锁定
        CONFIG_TABLE: "notiops-config",
        NOTIOPS_CROSS_ACCOUNT_ROLE: orgMode ? `notiops-idle-detection-role-${this.account}` : "notiops-idle-detection-role",
        LOCKED_ACCOUNT_ID: orgMode
          ? "" // 多账号(Organizations)模式：解锁，多账号选择器可切换到成员账号
          : this.account, // 默认锁定部署账号，跨账号 disabled（可在 onboard 后放开）
        // 多账号(org 模式)：Admin「账户」页一键接入用（StackSets）；非 org 模式留空 = 功能禁用
        MEMBER_ONBOARDING_STACKSET_NAME: orgMode ? "notiops-member-onboarding" : "",
        NOTIOPS_MEMBER_ROLE_NAME: orgMode ? `notiops-idle-detection-role-${this.account}` : "",
        MEMBER_DA_STACKSET_NAME: orgMode ? "notiops-member-devops-agent" : "",
        ORGANIZATION_ID: orgMode ? organizationId : "",
        // Skills 存共享数据桶的 skills/ 前缀（与 IM 端共享）；缺省时 BFF skills 路由会报未配置
        SKILLS_BUCKET: props.skillsBucketName ?? "",
        // Athena 查询结果落共享数据桶的 athena-results/ 前缀（FinOps 仪表盘 CUR 查询）
        ATHENA_RESULTS_BUCKET: props.skillsBucketName ?? "",
        // 跨账号成本查询目标角色（见 §1c）；空值 = BFF 只查部署账号自身视角。
        // FinOps 跨账号成本查询用它调 devops-agent:ListAssociations 动态发现
        // 关联账号（找 payer），不再硬编码账号 ID/角色 ARN（见
        // bff/web-chat/devops_agent_accounts.mjs）。空值 = 查询回退到部署账号自身视角。
        DEVOPS_AGENT_SPACE_ID: props.agentSpaceId ?? "",
        // AWS_REGION 由 Lambda 运行时自动注入
      },
      logRetention: logs.RetentionDays.TWO_WEEKS,
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
        resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${props.userPoolId}`],
      }),
    );

    // BFF 读 config 表（notiops-config）列出已注册账号供选择器（只读）
    // + org 模式下 Admin「账户」页一键接入需要 UpdateItem 预登记/翻正账号
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["dynamodb:Query", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
        resources: [
          `arn:aws:dynamodb:${this.region}:${this.account}:table/notiops-config`,
          `arn:aws:dynamodb:${this.region}:${this.account}:table/notiops-config/index/*`,
        ],
      }),
    );

    // org 模式：Admin「账户」页一键接入 —— StackSets 下发成员账号资源 + Organizations 账号列表
    if (orgMode) {
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
            `arn:aws:cloudformation:${this.region}:${this.account}:stackset/${onboardingStackSetName}:*`,
            `arn:aws:cloudformation:*:*:stackset-target/${onboardingStackSetName}:*`,
            `arn:aws:cloudformation:${this.region}:${this.account}:stackset/notiops-member-devops-agent:*`,
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
        resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`],
      }),
    );

    // Admin「通知」板块：读写飞书机器人配置（Secrets Manager 单 secret）。
    // 按**字面名**限定到 notiops/im-bot-feishu*（Secrets Manager ARN 带随机后缀故加 *），
    // 不做跨栈 CFN import —— 老管理前端未来 sunset 时本栈零依赖、零影响。
    // CreateSecret 用于 secret 尚不存在的首次配置场景（如未部署过 IM bot 栈）。
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue", "secretsmanager:UpdateSecret"],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:notiops/im-bot-feishu*`],
      }),
    );
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:CreateSecret"],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:notiops/im-bot-feishu*`],
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
        actions: [
          "aidevops:ListAssociations",
          "aidevops:CreateAsset", "aidevops:UpdateAsset",
          "aidevops:DeleteAsset", "aidevops:ListAssets",
        ],
        resources: [`arn:aws:aidevops:${this.region}:${this.account}:agentspace/*`],
      }),
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
        resources: [`arn:aws:dynamodb:${this.region}:${this.account}:table/notiops-config`],
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
        resources: [`arn:aws:athena:${this.region}:${this.account}:workgroup/primary`],
      }),
    );
    // Cost Deep Dive：BFF 对【已 grounded 的 Athena 结果行】调用 Bedrock(Sonnet) 生成 insight + 图型 spec。
    bff.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
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
          `arn:aws:glue:${this.region}:${this.account}:catalog`,
          `arn:aws:glue:${this.region}:${this.account}:database/*`,
          `arn:aws:glue:${this.region}:${this.account}:table/*/*`,
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
      const raw = (this.node.tryGetContext("allowedOrigins") as string) || "";
      const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
      if (!list.length) {
        cdk.Annotations.of(this).addWarning(
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
    const identityPool = new cognito.CfnIdentityPool(this, "ChatIdentityPool", {
      identityPoolName: "notiops-web-chat",
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: props.userPoolClientId,
          providerName: `cognito-idp.${this.region}.amazonaws.com/${props.userPoolId}`,
        },
      ],
    });

    // 已登录用户的角色：只允许调这个 BFF Function URL
    const authRole = new iam.Role(this, "ChatAuthRole", {
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

    new cognito.CfnIdentityPoolRoleAttachment(this, "ChatIdentityPoolRoles", {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authRole.roleArn },
    });

    // ─── chat-app 前端：S3 + CloudFront ───
    const siteBucket = new s3.Bucket(this, "ChatFrontendBucket", {
      bucketName: `notiops-chat-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,   // 显式服务端加密（对齐 dataBucket；安全要求）
      enforceSSL: true,                              // 强制传输层 TLS（拒绝明文 HTTP 请求）
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const oai = new cloudfront.OriginAccessIdentity(this, "ChatOAI");
    siteBucket.grantRead(oai);

    const distribution = new cloudfront.Distribution(this, "ChatCDN", {
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

    // 部署前端静态文件（chat-app/dist 必须已由 setup.sh 提前构建）
    const distPath = path.join(__dirname, "..", "..", "frontend", "chat-app", "dist");
    const hasDist = fs.existsSync(distPath);
    const deployment = new s3deploy.BucketDeployment(this, "DeployChatFrontend", {
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
    if (props.skillsBucketName) {
      const tmplPath = path.join(__dirname, "..", "member-devops-agent.yaml");
      if (fs.existsSync(tmplPath)) {
        const onboardingBucket = s3.Bucket.fromBucketName(this, "OnboardingTemplatesBucket", props.skillsBucketName);
        new s3deploy.BucketDeployment(this, "DeployOnboardingTemplate", {
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
    const rumIdentityPool = new cognito.CfnIdentityPool(this, "RumIdentityPool", {
      identityPoolName: "notiops-web-chat-rum",
      allowUnauthenticatedIdentities: true,
    });
    const rumGuestRole = new iam.Role(this, "RumGuestRole", {
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
        resources: [`arn:aws:rum:${this.region}:${this.account}:appmonitor/${rumAppMonitorName}`],
      }),
    );
    new cognito.CfnIdentityPoolRoleAttachment(this, "RumIdentityPoolRoles", {
      identityPoolId: rumIdentityPool.ref,
      roles: { unauthenticated: rumGuestRole.roleArn },
    });
    const appMonitor = new rum.CfnAppMonitor(this, "ChatRumAppMonitor", {
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
    const configFn = new lambda.Function(this, "ChatConfigFunction", {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "chat-config")),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
    });
    siteBucket.grantWrite(configFn);
    configFn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ["s3:PutObject"], resources: [siteBucket.arnForObjects("*")] }),
    );

    const configProvider = new cr.Provider(this, "ChatConfigProvider", {
      onEventHandler: configFn,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // chatApiBase = Function URL（形如 https://xxx.lambda-url.region.on.aws/，含末尾 /）。
    // 前端 src/api/chat.ts 会规范化末尾 / 再拼 /stream、/conversations。
    const configResource = new cdk.CustomResource(this, "ChatConfig", {
      serviceToken: configProvider.serviceToken,
      properties: {
        bucketName: siteBucket.bucketName,
        config: cdk.Stack.of(this).toJsonString({
          chatApiBase: fnUrl.url,
          cognitoUserPoolId: props.userPoolId,
          cognitoClientId: props.userPoolClientId,
          cognitoIdentityPoolId: identityPool.ref,
          region: this.region,
          idleConsoleUrl: props.idleConsoleUrl ?? "",
          rumAppMonitorId: appMonitor.attrId,
          rumIdentityPoolId: rumIdentityPool.ref,
          rumGuestRoleArn: rumGuestRole.roleArn,
          rumRegion: this.region,
        }),
        timestamp: Date.now().toString(),
      },
    });
    configResource.node.addDependency(deployment);

    // ─── Outputs ───
    new cdk.CfnOutput(this, "ChatUrl", { value: `https://${distribution.distributionDomainName}`, description: "Web Chat 前端地址" });
    new cdk.CfnOutput(this, "ChatBffUrl", { value: fnUrl.url, description: "Web Chat BFF Function URL（streaming）" });
    new cdk.CfnOutput(this, "WebChatTableName", { value: table.tableName });
  }
}
