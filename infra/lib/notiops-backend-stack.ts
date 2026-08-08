/**
 * AWS 资源闲置检测与优化系统 — CDK Stack（全自动版）。
 *
 * 一键部署所有资源：
 * - DynamoDB Tables (conversations / metrics / config)
 * - SNS Topic
 * - Cognito User Pool + 默认管理员用户
 * - Lambda1 (Collector)、Lambda2 (Analyzer)、API Lambda
 * - API Gateway REST API + Cognito Authorizer
 * - EventBridge 定时规则
 * - S3 + CloudFront 前端托管（自动注入后端配置）
 * - 管理账户 IdleDetectionRole（跨账户采集用）
 */
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as cr from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as path from "path";

export class NotiOpsBackendStack extends cdk.Stack {
  public readonly dataBucketName: string;
  // 暴露给 WebChatStack：web chat 与控制台共享同一个 Cognito 池
  public readonly userPoolId: string;
  public readonly userPoolClientId: string;
  // 报告分发 CDN 域名（CloudFront+OAC，只暴露 dataBucket 的 reports/*）——
  // 让报告链接真·长期有效、任地点打开，不受 runtime 临时凭证 presign 的 12h 限制。
  public readonly reportsCdnDomain: string;
  // 暴露给 WebChatStack：FinOps 仪表盘跨账号成本查询用它调
  // devops-agent:ListAssociations 动态发现关联账号（见 bff/web-chat/devops_agent_accounts.mjs）。
  public readonly agentSpaceId: string;
  // 暴露给 WebChatStack：idle 控制台前端 CloudFront 地址，供 web chat 侧栏「巡检&报告」外链跳转。
  public readonly consoleUrl: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ─── 多账号(Organizations)模式 ───
    // -c organizationId=o-xxxx 时启用：
    //   1. 不注入 LOCKED_ACCOUNT_ID（解锁 shared/account_scope.py 闸门，恢复多账号采集/调查）
    //   2. Custom Bus / PHD SNS Topic 的 Resource Policy 用 aws:PrincipalOrgID 整组放行，
    //      替代逐账号白名单（实际采集范围仍由 config 表 enabled 账号控制）
    //   3. API Lambda 获得 StackSets/Organizations 权限，支撑控制台一键接入
    // 未设置时保持 v1 单账号锁定行为，完全向后兼容。
    const organizationId = (this.node.tryGetContext("organizationId") as string | undefined)?.trim() || "";
    const orgMode = organizationId.length > 0;

    // ─── DynamoDB Tables ───

    const conversationsTable = new dynamodb.Table(this, "ConversationsTable", {
      tableName: "notiops-conversations",
      partitionKey: { name: "lookup_key", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: "ttl",
    });

    const metricsTable = new dynamodb.Table(this, "MetricsTable", {
      tableName: "notiops-metrics",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: "ttl",
    });
    metricsTable.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const configTable = new dynamodb.Table(this, "ConfigTable", {
      tableName: "notiops-config",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
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

    // ─── SNS Topic ───
    const snsTopic = new sns.Topic(this, "AlertTopic", {
      topicName: "notiops-alerts",
      displayName: "闲置资源告警",
    });

    // ─── Cognito User Pool ───
    const userPool = new cognito.UserPool(this, "IdleDetectorUserPool", {
      userPoolName: "notiops-users",
      selfSignUpEnabled: false,
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
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      preventUserExistenceErrors: true,
    });

    // ─── 角色分级（认证统一、授权分级）───
    // 同一个池既服务 web chat 又服务控制台；用 group 区分能干什么：
    //   admin  → 可进控制台改阈值/目标账户/通知配置
    //   member → 只用 web chat
    // chat BFF 与控制台 API 各自校验同一 JWT 的 cognito:groups。
    new cognito.CfnUserPoolGroup(this, "AdminGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "admin",
      description: "Full admin access; can modify configuration (thresholds / target accounts / notifications)",
      precedence: 1,
    });
    new cognito.CfnUserPoolGroup(this, "MemberGroup", {
      userPoolId: userPool.userPoolId,
      groupName: "member",
      description: "Members — web chat only",
      precedence: 10,
    });

    // ─── Web Chat RBAC 默认组（对应 authz.mjs DEFAULT_GROUP_ROLE_MAP）───
    // 预建常见团队组，开箱即用；组→角色映射默认由代码内置，管理员可在「组映射」页覆盖。
    // 成员管理（谁在组里）在 NotiOps 用户/组页操作（实时写 Cognito）。
    const defaultGroups: Array<{ id: string; name: string; desc: string; precedence: number }> = [
      { id: "FinopsTeamGroup", name: "finops-team", desc: "FinOps team: Chat + Notifications + all FinOps", precedence: 20 },
      { id: "SreOpsGroup", name: "sre-ops", desc: "SRE/Ops: Chat + Notifications + all Cases", precedence: 21 },
      { id: "SupportLeadGroup", name: "support-lead", desc: "Support Lead: can act on Cases (create/reply/resolve)", precedence: 22 },
      { id: "ServiceManagerGroup", name: "service-manager", desc: "Service Manager: read-only Cases + Chat", precedence: 23 },
      { id: "DevTeamGroup", name: "dev-team", desc: "Dev team: Chat + Skills management", precedence: 24 },
      { id: "ReadOnlyGroup", name: "read-only", desc: "Read-only: all dashboards read-only, no write actions", precedence: 30 },
    ];
    for (const g of defaultGroups) {
      new cognito.CfnUserPoolGroup(this, g.id, {
        userPoolId: userPool.userPoolId,
        groupName: g.name,
        description: g.desc,
        precedence: g.precedence,
      });
    }


    // ─── Lambda IAM Role ───
    // roleName 固定为 notiops-lambda-execution-role（R2.6 / R13.6）
    // 业务账户的 DevOpsAgentTrigger-* Role 信任策略直接引用此 Role ARN，
    // 若 CDK 自动生成随机后缀会导致信任策略失效。
    // 破坏性变更：首次升级到本架构需手工删除旧 Role 再部署（详见迁移文档）。
    const lambdaRole = new iam.Role(this, "LambdaExecutionRole", {
      roleName: "notiops-lambda-execution-role",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });

    // STS AssumeRole 权限（跨账户采集：Lambda1 Collector / Lambda5 CostAnalyzer 对目标账户 IdleDetectionRole AssumeRole；
    // Lambda4 Notifier / Callback Lambda 对目标账户 DevOpsAgentTrigger-* AssumeRole 触发 DevOps Agent 调查 / 拉取摘要）
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [
        // 只匹配两种合法形态：无后缀(自身/遗留) 与 -<12位账号>(org 模式成员账号)。
        // 带 -12位 边界避免旧的 role* 松散通配误匹配 ...roleFOO 之类名字。
        "arn:aws:iam::*:role/notiops-idle-detection-role", // 无后缀=自身/遗留手动接入
        "arn:aws:iam::*:role/notiops-idle-detection-role-*", // 带账号后缀=org 模式成员账号（见 member-account-onboarding.yaml）
        "arn:aws:iam::*:role/notiops-agent-trigger-*",
      ],
    }));

    // CloudWatch 读取权限
    // NOTE: cloudwatch:GetMetricData / GetMetricStatistics / ListMetrics do NOT
    // support resource-level permissions — IAM requires "*" for these read APIs
    // (see AWS "Actions, resources, and condition keys for CloudWatch"). All are read-only.
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "cloudwatch:GetMetricData",
        "cloudwatch:GetMetricStatistics",
        "cloudwatch:ListMetrics",
      ],
      resources: ["*"],
    }));

    // RDS / ElastiCache 描述权限
    // NOTE: Describe*/ListTagsForResource on RDS & ElastiCache do NOT support
    // resource-level scoping for the collection-level describes — "*" is required
    // by the API. Read-only.
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "rds:DescribeDBInstances",
        "rds:ListTagsForResource",
        "elasticache:DescribeCacheClusters",
        "elasticache:DescribeReplicationGroups",
        "elasticache:ListTagsForResource",
      ],
      resources: ["*"],
    }));

    // Trusted Advisor / Support API 权限（EC2 低利用率检测）
    // NOTE: AWS Support / Trusted Advisor APIs do NOT support resource-level
    // permissions — "*" is mandated by the service. Read-only (Describe*).
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "support:DescribeTrustedAdvisorCheckResult",
        "support:DescribeTrustedAdvisorChecks",
      ],
      resources: ["*"],
    }));

    // Cost Explorer 权限（lambda5 部署账号本地路径需要）
    // NOTE: Cost Explorer (ce:*) does NOT support resource-level permissions —
    // "*" is required by the API. Read-only.
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ce:GetCostAndUsage", "ce:GetCostForecast"],
      resources: ["*"],
    }));

    // DevOps Agent Journal API（callback Lambda 拉调查日志 + 恢复 incident_id）
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ["aidevops:ListJournalRecords", "aidevops:GetJournalRecord"],
      resources: [`arn:aws:aidevops:${this.region}:${this.account}:agentspace/*`],
    }));

    // Lambda 调用权限 — 收窄到本账号/本区域的函数(最小权限;跨账号调用不需要)。
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:*`],
    }));

    // SNS 发布权限
    snsTopic.grantPublish(lambdaRole);

    // DynamoDB 权限
    metricsTable.grantReadWriteData(lambdaRole);
    configTable.grantReadWriteData(lambdaRole);
    conversationsTable.grantReadWriteData(lambdaRole);

    // Bedrock 权限（Lambda3 Converse + API Lambda ListInferenceProfiles/ListFoundationModels）
    // bedrock:InvokeModel 同时覆盖 Converse API，无需单独声明 bedrock:Converse
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        "arn:aws:bedrock:*::foundation-model/*",
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
      ],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ["bedrock:ListInferenceProfiles", "bedrock:ListFoundationModels"],
      resources: ["*"],
    }));

    // ─── 管理账户自身的 IdleDetectionRole ───
    const idleDetectionRole = new iam.Role(this, "IdleDetectionRole", {
      roleName: "notiops-idle-detection-role",
      assumedBy: new iam.CompositePrincipal(
        new iam.ArnPrincipal(lambdaRole.roleArn),
      ),
      description: "Allows idle detection system to read RDS/ElastiCache/CloudWatch data",
    });

    idleDetectionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "rds:DescribeDBInstances",
        "rds:ListTagsForResource",
        "elasticache:DescribeCacheClusters",
        "elasticache:DescribeReplicationGroups",
        "elasticache:ListTagsForResource",
        "cloudwatch:GetMetricData",
        "cloudwatch:GetMetricStatistics",
        "support:DescribeTrustedAdvisorCheckResult",
        "support:DescribeTrustedAdvisorChecks",
        "ce:GetCostAndUsage",
        // NotiOps Web Chat FinOps（官方 cost+pricing MCP，跨账号只读）：被纳管账号经此角色
        // 查成本/定价/优化/异常/RI&SP 等。与 agentcore CDK 的 NotiOpsFinOpsReadOnly 对齐。
        "ce:Get*",
        "ce:List*",
        "ce:Describe*",
        "cost-optimization-hub:ListRecommendations",
        "cost-optimization-hub:GetRecommendation",
        "cost-optimization-hub:ListEnrollmentStatuses",
        "cost-optimization-hub:GetPreferences",
        "compute-optimizer:Get*",
        "compute-optimizer:Describe*",
        "budgets:ViewBudget",
        "budgets:DescribeBudgets",
        "pricing:GetProducts",
        "pricing:DescribeServices",
        "pricing:GetAttributeValues",
        "pricing:ListPriceLists",
        "pricing:GetPriceListFileUrl",
        "freetier:GetFreeTierUsage",
        "storagelens:Get*",
        "storagelens:List*",
        "s3:GetStorageLensConfiguration",
        "s3:ListStorageLensConfigurations",
        "cur:DescribeReportDefinitions",
      ],
      resources: ["*"],
    }));

    // ─── Lambda 公共环境变量 ───
    const lambdaEnv: Record<string, string> = {
      METRICS_TABLE: metricsTable.tableName,
      CONFIG_TABLE: configTable.tableName,
      CONVERSATIONS_TABLE: conversationsTable.tableName,
      SNS_TOPIC_ARN: snsTopic.topicArn,
      // 跨账号闸门(本期):把所有后台采集/调查锁死在【系统部署账号】内。
      // idle 原生是无条件多账号(lambda1/lambda5 遍历 config 表 + STS AssumeRole;
      // create_investigation 跨账号)。本期"跨账号 disabled",只 focus 部署账号。
      // 留空即可恢复多账号(零侵入、可逆)。见 shared/account_scope.py。
      // orgMode(-c organizationId=...)时留空 = 解锁多账号。
      LOCKED_ACCOUNT_ID: orgMode ? "" : cdk.Aws.ACCOUNT_ID,
    };

    // ─── Python 依赖 Layer ───
    const depsLayer = new lambda.LayerVersion(this, "PythonDepsLayer", {
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "..", "lambda_layer")),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
      description: "Python dependencies for Lambda functions",
    });

    // ─── Lambda 函数 ───

    // 显式创建 LogGroup（Stack 删除时自动清理，避免隐式创建的 LogGroup 残留）
    const createLogGroup = (id: string, fnName: string) =>
      new logs.LogGroup(this, id, {
        logGroupName: `/aws/lambda/${fnName}`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

    const logGroupCollector = createLogGroup("LogGroupCollector", "notiops-collector");
    const logGroupAnalyzer = createLogGroup("LogGroupAnalyzer", "notiops-analyzer");
    const logGroupApi = createLogGroup("LogGroupApi", "notiops-api");
    const logGroupHealthChecker = createLogGroup("LogGroupHealthChecker", "notiops-health-checker");
    const logGroupNotifier = createLogGroup("LogGroupNotifier", "notiops-notifier");
    const logGroupCostAnalyzer = createLogGroup("LogGroupCostAnalyzer", "notiops-cost-analyzer");
    const logGroupCurFinalizer = createLogGroup("LogGroupCurFinalizer", "notiops-cur-finalizer");

    const commonLambdaProps: Partial<lambda.FunctionProps> = {
      runtime: lambda.Runtime.PYTHON_3_14,
      role: lambdaRole,
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      environment: lambdaEnv,
      layers: [depsLayer],
    };

    // GLOB exclude with `/**` patterns. IMPORTANT: cdk synth/deploy MUST run
    // with --output pointing OUTSIDE the repo root (setup.sh passes
    // --output ../.cdk-out via a path outside ../). Reason: fromAsset("../")
    // packages the repo root, and if the CDK output dir (infra/cdk.out) sits
    // inside that source tree, the asset copy self-references recursively →
    // ENAMETOOLONG. Excluding "infra/**" is not enough because the copy
    // races with the output being written. Keeping output outside the source
    // is the robust fix; the excludes below keep the package lean (~few MB).
    const lambdaCode = lambda.Code.fromAsset("../", {
      exclude: [
        "frontend/**", "infra/**", ".venv*/**", "**/node_modules/**",
        "agent-build/**", "promo/**", "agent/**", "bff/**", "**/.cache/**",
        ".git/**", "tests/**", "docs/**", ".kiro/**",
        "lambda_layer/**", "cdk.out/**", "**/__pycache__/**",
        "platforms/**", "*.md", "mcp_server/**",
        ".hypothesis/**", ".pytest_cache/**",
        "phd_event_forwarder/**", "devops_agent_callback/**",
      ],
    });

    // Lambda1 - Collector
    const lambda1 = new lambda.Function(this, "Lambda1Collector", {
      ...commonLambdaProps,
      functionName: "notiops-collector",
      handler: "lambda1_collector.handler.handler",
      code: lambdaCode,
      logGroup: logGroupCollector,
      description: "资源发现、白名单过滤、CloudWatch 指标采集和数据入库（阶段一至三）",
    } as lambda.FunctionProps);

    // Lambda2 - Analyzer
    const lambda2 = new lambda.Function(this, "Lambda2Analyzer", {
      ...commonLambdaProps,
      functionName: "notiops-analyzer",
      handler: "lambda2_analyzer.handler.handler",
      code: lambdaCode,
      logGroup: logGroupAnalyzer,
      description: "深度分析判定、评分和报告生成（阶段四）",
    } as lambda.FunctionProps);

    lambda1.addEnvironment("LAMBDA2_FUNCTION_NAME", lambda2.functionName);

    // API Lambda
    const apiLambda = new lambda.Function(this, "ApiLambda", {
      ...commonLambdaProps,
      functionName: "notiops-api",
      handler: "api.handler.handler",
      logGroup: logGroupApi,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      code: lambdaCode,
      description: "REST API — Dashboard、报告、白名単、阈值、账户管理",
    } as lambda.FunctionProps);

    // Lambda3 - HealthChecker (AI 智能巡检)
    const lambda3 = new lambda.Function(this, "Lambda3HealthChecker", {
      ...commonLambdaProps,
      functionName: "notiops-health-checker",
      handler: "lambda3_health_checker.handler.handler",
      code: lambdaCode,
      logGroup: logGroupHealthChecker,
      timeout: cdk.Duration.seconds(600),
      memorySize: 512,
      description: "RDS/ElastiCache AI 智能巡检 — Bedrock 分析与报告生成（路径 C）",
    } as lambda.FunctionProps);

    lambda3.addEnvironment("BEDROCK_MODEL_ID", "global.anthropic.claude-sonnet-5");
    apiLambda.addEnvironment("HEALTH_CHECKER_FUNCTION_NAME", lambda3.functionName);
    apiLambda.addEnvironment("COLLECTOR_FUNCTION_NAME", "notiops-collector");

    // ─── 多账号一键接入（控制台「账户接入」Tab，orgMode 专属）───
    // API Lambda 通过 StackSets 向成员账号下发 member-account-onboarding.yaml，
    // 并用 Organizations ListAccounts 填充账号下拉列表。
    if (orgMode) {
      const onboardingStackSetName = "notiops-member-onboarding";
      apiLambda.addEnvironment("MEMBER_ONBOARDING_STACKSET_NAME", onboardingStackSetName);
      apiLambda.addEnvironment("NOTIOPS_MEMBER_ROLE_NAME", `notiops-idle-detection-role-${this.account}`);
      apiLambda.addEnvironment("ORGANIZATION_ID", organizationId);
      lambdaRole.addToPolicy(new iam.PolicyStatement({
        sid: "OrgOnboardStackSets",
        actions: [
          "cloudformation:CreateStackInstances",
          "cloudformation:DescribeStackSet",
          "cloudformation:DescribeStackSetOperation",
          "cloudformation:ListStackInstances",
        ],
        resources: [
          `arn:aws:cloudformation:${this.region}:${this.account}:stackset/${onboardingStackSetName}:*`,
          `arn:aws:cloudformation:*:*:stackset-target/${onboardingStackSetName}:*`,
          "arn:aws:cloudformation:*::type/resource/*",
        ],
      }));
      // CloudWatch OAM Sink（跨账号 observability 管理侧入口）：成员账号经 member
      // 模板的 oam:Link 把 metrics/logs/traces 共享进来（调查/告警关联分析用）。
      // ⚠ OAM 限制：每账号每 Region 只允许 1 个 Sink。已有 Sink（如客户自配的
      // multi-account monitoring）时用 -c oamSinkArn=<arn> 复用，跳过创建；
      // setup.sh org 段自动发现并注入。
      const existingOamSinkArn = (this.node.tryGetContext("oamSinkArn") as string | undefined)?.trim() || "";
      if (existingOamSinkArn) {
        new cdk.CfnOutput(this, "ObservabilitySinkArn", { value: existingOamSinkArn });
      } else {
      const oamSink = new cdk.CfnResource(this, "ObservabilitySink", {
        type: "AWS::Oam::Sink",
        properties: {
          Name: "notiops-observability-sink",
          Policy: {
            Version: "2012-10-17",
            Statement: [{
              Effect: "Allow",
              Principal: "*",
              Action: ["oam:CreateLink", "oam:UpdateLink"],
              Resource: "*",
              Condition: {
                StringEquals: { "aws:PrincipalOrgID": organizationId },
                "ForAllValues:StringEquals": {
                  "oam:ResourceTypes": ["AWS::CloudWatch::Metric", "AWS::Logs::LogGroup", "AWS::XRay::Trace"],
                },
              },
            }],
          },
        },
      });
      new cdk.CfnOutput(this, "ObservabilitySinkArn", { value: oamSink.getAtt("Arn").toString() });
      }

      lambdaRole.addToPolicy(new iam.PolicyStatement({
        sid: "OrgOnboardListAccounts",
        actions: [
          "organizations:ListAccounts",
          "organizations:DescribeOrganization",
        ],
        resources: ["*"],
      }));
    }

    // Lambda4 - Notifier（定时推送巡检报告和闲置资源通知到飞书）
    const lambda4 = new lambda.Function(this, "Lambda4Notifier", {
      ...commonLambdaProps,
      functionName: "notiops-notifier",
      handler: "lambda4_notifier.handler.handler",
      code: lambdaCode,
      logGroup: logGroupNotifier,
      timeout: cdk.Duration.minutes(10),
      memorySize: 256,
      description: "定时推送巡检报告和闲置资源通知到飞书",
    } as lambda.FunctionProps);

    // Lambda5 - CostAnalyzer（每日成本异常分析）
    const lambda5 = new lambda.Function(this, "Lambda5CostAnalyzer", {
      ...commonLambdaProps,
      functionName: "notiops-cost-analyzer",
      handler: "lambda5_cost_analyzer.handler.handler",
      code: lambdaCode,
      logGroup: logGroupCostAnalyzer,
      timeout: cdk.Duration.minutes(15),
      memorySize: 512,
      description: "每日成本异常分析 — Cost Explorer 数据采集与多因子评分",
    } as lambda.FunctionProps);

    // Lambda6 - CurFinalizer（一次性：CUR 首次交付后自动部署 Athena 集成 CFN 模板）
    // 由 setup.sh 创建 CUR ReportDefinition 时同步创建的 EventBridge Scheduler
    // 一次性 schedule（T+25h）触发，见 §CurFinalizerScheduler 相关 IAM/角色定义。
    // 独立 Role（而非复用 lambdaRole）：需要的权限（cloudformation:CreateStack +
    // iam:CreateRole 等）权限面明显更宽，不应该混进日常采集 Lambda 的执行角色里。
    const curFinalizerRole = new iam.Role(this, "CurFinalizerRole", {
      roleName: "notiops-cur-finalizer-role",
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    curFinalizerRole.addToPolicy(new iam.PolicyStatement({
      // 只读 CUR 交付桶。复用既有 CUR 时，桶名由客户自定义、部署期不可知，故放开到 *
      // （仅 List/Get 只读，用于读取 crawler-cfn.yml 模板 + 发现数据路径）。
      actions: ["s3:ListBucket", "s3:GetObject"],
      resources: ["*"],
    }));
    curFinalizerRole.addToPolicy(new iam.PolicyStatement({
      // 部署 AWS 官方生成的 Athena 集成 CFN 模板（内含 IAM Role/Glue/Lambda），
      // 名称范围限定为本 Lambda 自己创建的 stack（notiops-cur-athena-<account_id>）。
      actions: ["cloudformation:CreateStack", "cloudformation:DescribeStacks", "cloudformation:DescribeStackResources", "cloudformation:DeleteStack"],
      resources: ["arn:aws:cloudformation:*:*:stack/notiops-cur-athena-*/*"],
    }));
    // 该 CFN 模板会创建 3 个 IAM Role + Glue DB/Crawler + 2 个 Lambda + S3 通知；
    // create_stack 调用者本身需要具备这些创建权限（CFN 以调用者角色执行，不是 CFN
    // 服务角色）。按资源类型分组、能按 ARN 收窄的都收窄（IAM/Lambda 用命名前缀），
    // 只有官方模板内部动态命名、部署前不可预知的 Glue 资源保留 * 并显式说明。
    //
    // (1) IAM：官方 Athena 集成模板创建的 Role 名带 CUR/Athena 前缀，收窄到本项目相关的
    //     role 命名前缀，避免对任意 IAM Role 的写权限。
    curFinalizerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "iam:CreateRole", "iam:PutRolePolicy", "iam:GetRole", "iam:PassRole",
        "iam:AttachRolePolicy", "iam:TagRole",
        "iam:DeleteRole", "iam:DeleteRolePolicy", "iam:DetachRolePolicy",
      ],
      resources: [
        `arn:aws:iam::${this.account}:role/notiops-cur-*`,
        `arn:aws:iam::${this.account}:role/AWSCUR*`,
        `arn:aws:iam::${this.account}:role/*Athena*`,
      ],
    }));
    // (2) Lambda：官方模板建的函数名带 CUR/Athena 前缀，按函数名 ARN 前缀收窄（本账号本区）。
    curFinalizerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "lambda:CreateFunction", "lambda:GetFunction", "lambda:AddPermission",
        "lambda:InvokeFunction", "lambda:TagResource",
        "lambda:DeleteFunction", "lambda:RemovePermission",
        "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency",
      ],
      resources: [
        `arn:aws:lambda:*:${this.account}:function:notiops-cur-*`,
        `arn:aws:lambda:*:${this.account}:function:*Athena*`,
        `arn:aws:lambda:*:${this.account}:function:*aws-cur*`,
      ],
    }));
    // (3) Glue + S3 通知：⚠️ 官方 crawler-cfn.yml 内部动态生成 Glue Database/Crawler/Table 名
    //     （部署前不可预知），无法按 ARN 收窄；且 s3:PutBucketNotification 作用于客户自有的
    //     CUR 交付桶（桶名部署期未知）。故这两类保留 resources:["*"]，收紧到 action 层面。
    //     安全警告：这是 AWS 官方 Athena-集成模板本身要求的最小权限面
    //     （见 docs.aws.amazon.com/cur/latest/userguide/use-athena-cf.md）；该角色仅由一次性
    //     lambda6_cur_finalizer 使用、只在 CUR 首次交付后触发一次，非常驻。
    curFinalizerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "glue:CreateDatabase", "glue:CreateCrawler", "glue:GetDatabase", "glue:GetCrawler",
        "glue:TagResource",
        "glue:GetDatabases", "glue:GetTables", "glue:GetTable", "glue:StartCrawler", "glue:StopCrawler",
        "glue:CreateTable", "glue:UpdateTable", "glue:DeleteTable",
        "glue:DeleteDatabase", "glue:DeleteCrawler",
        "s3:PutBucketNotification", "s3:GetBucketNotification",
      ],
      resources: ["*"],
    }));
    // CUR 翻成 READY 的同一时刻，finalizer 幂等下发 6 条 FinOps 保存查询（Cost Deep Dive 后端，
    // 见 lambda6_cur_finalizer/athena_saved_queries.py）+ 给 primary workgroup 设结果输出位置。
    // Athena 保存查询 / workgroup 属账号级资源（无法按细粒度 ARN 收窄），收紧到 action 层面。
    curFinalizerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "athena:ListNamedQueries", "athena:BatchGetNamedQuery", "athena:CreateNamedQuery",
        "athena:GetWorkGroup", "athena:UpdateWorkGroup",
      ],
      resources: ["*"],
    }));

    const lambda6CurFinalizer = new lambda.Function(this, "Lambda6CurFinalizer", {
      runtime: lambda.Runtime.PYTHON_3_14,
      role: curFinalizerRole,
      handler: "lambda6_cur_finalizer.handler.handler",
      code: lambdaCode,
      logGroup: logGroupCurFinalizer,
      timeout: cdk.Duration.minutes(10),
      memorySize: 256,
      environment: { CONFIG_TABLE: configTable.tableName },
      description: "一次性：CUR 首次交付后自动部署 Athena 集成 CFN 模板（由 EventBridge Scheduler T+25h 触发）",
    });
    configTable.grantWriteData(lambda6CurFinalizer);
    configTable.grantReadData(lambda6CurFinalizer);

    // EventBridge Scheduler 需要一个可以 InvokeFunction 的角色（scheduler.amazonaws.com
    // 假设该角色去调用 lambda6）。一次性 schedule 由 setup.sh 用 boto3 scheduler
    // create_schedule 创建（不在 CDK 里静态声明 CfnSchedule ——每个客户账号的触发时间
    // 是动态的 T+25h，属于运行时数据而非部署时常量，CDK 只负责建好可复用的调用角色）。
    const curSchedulerRole = new iam.Role(this, "CurFinalizerSchedulerRole", {
      roleName: "notiops-cur-finalizer-scheduler-role",
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    curSchedulerRole.addToPolicy(new iam.PolicyStatement({
      actions: ["lambda:InvokeFunction"],
      resources: [lambda6CurFinalizer.functionArn],
    }));

    new cdk.CfnOutput(this, "CurFinalizerFunctionArn", {
      value: lambda6CurFinalizer.functionArn,
      description: "setup.sh 创建 EventBridge Scheduler 一次性 schedule 时作为 Target",
    });
    new cdk.CfnOutput(this, "CurFinalizerSchedulerRoleArn", {
      value: curSchedulerRole.roleArn,
      description: "setup.sh 创建 EventBridge Scheduler 一次性 schedule 时作为 RoleArn",
    });

    // ─── API Gateway ───
    const api = new apigateway.RestApi(this, "IdleDetectorApi", {
      restApiName: "notiops-api",
      description: "AWS 资源闲置检测系统 REST API",
      deployOptions: { stageName: "prod" },
      // CORS：优先用部署方通过 `-c allowedOrigins=https://a.com,https://b.com` 指定的可信域名白名单。
      // 未指定时回退到 ALL_ORIGINS —— 说明：① 该 API 的每个数据类端点都要求 Cognito User Pool
      // 授权（下方 authorizer + IAM/SigV4），浏览器 CORS 不是这里的主要信任边界;② 前端 CloudFront
      // 域名是每次部署动态生成的、部署期未知,示例仓库无法预置固定白名单。生产部署应显式传
      // allowedOrigins 收窄到自己的前端域名。
      defaultCorsPreflightOptions: {
        allowOrigins: (() => {
          const raw = (this.node.tryGetContext("allowedOrigins") as string) || "";
          const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
          if (!list.length) {
            cdk.Annotations.of(this).addWarning(
              "CORS allowOrigins 回退到 '*'（所有来源）。生产部署请传 " +
              "`-c allowedOrigins=https://<你的前端域名>` 收窄到可信域名。" +
              "接口仍由 Cognito 授权，但收窄 CORS 是纵深防御的推荐做法。",
            );
            return apigateway.Cors.ALL_ORIGINS;
          }
          return list;
        })(),
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ["Content-Type", "Authorization"],
      },
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, "CognitoAuth", {
      cognitoUserPools: [userPool],
      authorizerName: "notiops-cognito-auth",
    });

    const authOpts: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };

    const integration = new apigateway.LambdaIntegration(apiLambda);
    const apiRes = api.root.addResource("api");

    // 使用 {proxy+} 代理模式，避免 Lambda 资源策略超过 20KB 限制
    // 所有 /api/* 请求统一转发到 API Lambda，由 Python handler 内部路由
    apiRes.addProxy({
      defaultIntegration: integration,
      defaultMethodOptions: authOpts,
      anyMethod: true,
    });

    // ─── EventBridge 定时规则 ───
    new events.Rule(this, "DailyCollectionRule", {
      ruleName: "notiops-daily-collection",
      description: "每天 00:00 UTC 触发 Lambda1-Collector",
      schedule: events.Schedule.cron({ minute: "0", hour: "0" }),
      targets: [new targets.LambdaFunction(lambda1)],
    });

    // Lambda3 每天定时 RDS 巡检（在 Lambda1 采集完成后执行，00:30 UTC）
    new events.Rule(this, "DailyHealthCheckRule", {
      ruleName: "notiops-daily-health-check",
      description: "每天 00:30 UTC 触发 Lambda3-HealthChecker 执行 RDS AI 巡检",
      schedule: events.Schedule.cron({ minute: "30", hour: "0" }),
      targets: [new targets.LambdaFunction(lambda3)],
    });

    // Lambda3 每天定时 ElastiCache 巡检（在 RDS 巡检之后，01:00 UTC）
    new events.Rule(this, "DailyElastiCacheHealthCheckRule", {
      ruleName: "notiops-daily-elasticache-health-check",
      description: "每天 01:00 UTC 触发 ElastiCache AI 巡检",
      schedule: events.Schedule.cron({ minute: "0", hour: "1" }),
      targets: [new targets.LambdaFunction(lambda3, {
        event: events.RuleTargetInput.fromObject({
          resource_type: "elasticache",
        }),
      })],
    });

    // Lambda5 每天定时成本异常分析（在 Lambda3 之后、Lambda4 之前，01:15 UTC）
    new events.Rule(this, "DailyCostAnalysisRule", {
      ruleName: "notiops-daily-cost-analysis",
      description: "每天 01:15 UTC 触发 Lambda5-CostAnalyzer 执行成本异常分析",
      schedule: events.Schedule.cron({ minute: "15", hour: "1" }),
      targets: [new targets.LambdaFunction(lambda5)],
    });

    // Lambda4 每天定时推送通知（在 Lambda3 巡检完成后执行，02:00 UTC）
    new events.Rule(this, "DailyNotificationRule", {
      ruleName: "notiops-daily-notification",
      description: "每天 02:00 UTC 触发 Lambda4-Notifier 推送巡检报告和闲置资源通知",
      schedule: events.Schedule.cron({ minute: "0", hour: "2" }),
      targets: [new targets.LambdaFunction(lambda4)],
    });

    // ─── S3 + CloudFront 前端托管 ───
    const siteBucket = new s3.Bucket(this, "FrontendBucket", {
      bucketName: `notiops-frontend-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,  // Security: 显式 SSE(与 dataBucket 一致)
      enforceSSL: true,                            // Security: 拒绝非 TLS 请求
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const oai = new cloudfront.OriginAccessIdentity(this, "OAI");
    siteBucket.grantRead(oai);

    const distribution = new cloudfront.Distribution(this, "FrontendCDN", {
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
    this.consoleUrl = `https://${distribution.distributionDomainName}`;

    // ─── 前端配置注入 + 构建 + 部署 ───
    // 创建 runtime config JSON，前端在运行时加载
    const configInitFn = new lambda.Function(this, "FrontendConfigFunction", {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "frontend-config")),
      timeout: cdk.Duration.minutes(2),
      memorySize: 256,
      environment: {
        BUCKET_NAME: siteBucket.bucketName,
        API_BASE: api.url + "api",
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
      },
    });

    siteBucket.grantWrite(configInitFn);

    const configProvider = new cr.Provider(this, "FrontendConfigProvider", {
      onEventHandler: configInitFn,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // 先部署前端静态文件
    const frontendDeployment = new s3deploy.BucketDeployment(this, "DeployFrontend", {
      sources: [s3deploy.Source.asset("../frontend/frontend-app/dist")],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // 再写入 runtime config（覆盖 .env 中的占位值）
    const configResource = new cdk.CustomResource(this, "FrontendConfig", {
      serviceToken: configProvider.serviceToken,
      properties: {
        apiBase: api.url + "api",
        userPoolId: userPool.userPoolId,
        clientId: userPoolClient.userPoolClientId,
        timestamp: Date.now().toString(),
      },
    });

    configResource.node.addDependency(frontendDeployment);

    // ─── Secrets Manager (IM Bot credentials) ───
    const feishuSecret = new secretsmanager.Secret(this, "FeishuBotSecret", {
      secretName: "notiops/im-bot-feishu",
      description: "飞书机器人凭证（app_id, app_secret, verification_token, encrypt_key）",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          app_id: "",
          app_secret: "",
          verification_token: "",
          encrypt_key: "",
        }),
        generateStringKey: "placeholder",
      },
    });

    // ─── Slack bot tokens (DingTalk retired) ───
    const slackBotTokenSecret = new secretsmanager.Secret(this, "SlackBotTokenSecret", {
      secretName: "notiops/slack-bot-token",
      description: "Slack bot token (xoxb-)",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const slackAppTokenSecret = new secretsmanager.Secret(this, "SlackAppTokenSecret", {
      secretName: "notiops/slack-app-token",
      description: "Slack app-level token (xapp-) for Socket Mode",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const bedrockApiKeySecret = new secretsmanager.Secret(this, "BedrockApiKeySecret", {
      secretName: "notiops/bedrock-api-key",
      description: "Bedrock API Key — 跨账号模型调用认证（部署后手动填充实际 Key）",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ bedrock_api_key: "" }),
        generateStringKey: "placeholder",
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const liteLlmConfigSecret = new secretsmanager.Secret(this, "LiteLlmConfigSecret", {
      secretName: "notiops/litellm-config",
      description:
        "LiteLLM Proxy config (base_url / api_key / default_model). Filled in via Dashboard → AI 认证 → LiteLLM.",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          base_url: "",
          api_key: "",
          default_model: "",
        }),
        generateStringKey: "placeholder",
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // SSM Parameters
    const llmProviderParam = new ssm.StringParameter(this, "LlmProviderParam", {
      parameterName: "/notiops/llm/provider",
      stringValue: "bedrock",
      description:
        "Current LLM provider (\"bedrock\" or \"litellm\"). Writable via Dashboard.",
      tier: ssm.ParameterTier.STANDARD,
    });
    llmProviderParam.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const agentModelIdParam = new ssm.StringParameter(this, "AgentModelIdParam", {
      parameterName: "/notiops/agent/model_id",
      stringValue: "global.anthropic.claude-sonnet-5",
      description: "Current Bedrock model ID used by the Strands Agent (writable via dashboard)",
      tier: ssm.ParameterTier.STANDARD,
    });
    agentModelIdParam.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    // ─── Secrets / SSM IAM for Lambda role ───
    feishuSecret.grantRead(lambdaRole);
    feishuSecret.grantWrite(lambdaRole);

    // Slack bot token: read-only — the callback Lambda needs it to push
    // live-investigation cards / final reports back to the originating
    // Slack channel. Without this grant `slack_sender.is_configured()`
    // returns False (no env var) and the Lambda silently drops every
    // Slack-bound IM push.
    slackBotTokenSecret.grantRead(lambdaRole);

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: "BedrockApiKeySecretAccess",
      actions: ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
      resources: [bedrockApiKeySecret.secretArn],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: "LlmProviderParamRead",
      actions: ["ssm:GetParameter", "ssm:PutParameter"],
      resources: [llmProviderParam.parameterArn],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: "AgentModelIdParamReadWrite",
      actions: ["ssm:GetParameter", "ssm:PutParameter"],
      resources: [agentModelIdParam.parameterArn],
    }));

    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: "LiteLlmConfigSecretAccess",
      actions: [
        "secretsmanager:GetSecretValue",
        "secretsmanager:PutSecretValue",
        "secretsmanager:CreateSecret",
        "secretsmanager:DescribeSecret",
      ],
      resources: [
        liteLlmConfigSecret.secretArn,
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:notiops/litellm-config-*`,
      ],
    }));

    // Lambda env vars for secrets
    lambda3.addEnvironment("BEDROCK_API_KEY_SECRET_ARN", bedrockApiKeySecret.secretArn);
    lambda4.addEnvironment("BEDROCK_API_KEY_SECRET_ARN", bedrockApiKeySecret.secretArn);
    apiLambda.addEnvironment("BEDROCK_API_KEY_SECRET_ARN", bedrockApiKeySecret.secretArn);
    lambda3.addEnvironment("LITELLM_CONFIG_SECRET_ARN", liteLlmConfigSecret.secretName);
    lambda4.addEnvironment("LITELLM_CONFIG_SECRET_ARN", liteLlmConfigSecret.secretName);
    apiLambda.addEnvironment("LITELLM_CONFIG_SECRET_ARN", liteLlmConfigSecret.secretName);
    lambda4.addEnvironment("FEISHU_SECRET_ARN", feishuSecret.secretArn);
    // Same Slack token wiring as the callback Lambda (see comment above)
    // — without this lambda4's idle/cost-report push to Slack channels
    // silently no-ops via slack_sender.is_configured() == False.
    lambda4.addEnvironment("SLACK_BOT_TOKEN_ARN", slackBotTokenSecret.secretName);

    // ─── DevOps Agent 集成（按账户独立 Agent Space 架构）───
    //
    // 架构变更（spec: devops-agent-per-account-architecture）：
    // - 每个业务账户在自身账户部署独立 Agent Space + Trigger Role（DevOpsAgentTrigger-*）
    // - Lambda4 / Callback Lambda 统一通过 STS AssumeRole 到
    //   目标账户的 DevOpsAgentTrigger-* Role，再调用 DevOps Agent API
    // - Business Account 通过跨账号 EventBridge 转发把 `aws.aidevops` 事件投递到
    //   System Account 的 Custom Event Bus `notiops-devops-events`
    // - Callback Lambda 需要访问 DDB 表

    // ─── DevOps Agent Space(部署账号自动创建 + onboard)───
    // 部署账号的 Agent Space 由 CDK 自动创建,无需手动 onboard。
    // 其他业务账号仍需 Dashboard 手动上车(跨账号 onboarding 流程)。
    const devopsAgentModule = require("aws-cdk-lib/aws-devopsagent");
    const agentSpace = new devopsAgentModule.CfnAgentSpace(this, "DevOpsAgentSpace", {
      name: `notiops-devops-${cdk.Aws.ACCOUNT_ID}`,
      description: "NotiOps - auto-created by CDK for the deploy account",
    });
    this.agentSpaceId = agentSpace.attrAgentSpaceId;

    // Primary Role: DevOps Agent 服务自身 AssumeRole 进来读取账号资源。
    // 权限通过 AWS 官方 Managed Policy AIDevOpsAgentAccessPolicy 授予，
    // 和 notiops onboarding 模板 (business_account_agentspace.yaml.j2) 一致。
    const primaryRole = new iam.Role(this, "DevOpsAgentPrimaryRole", {
      roleName: `notiops-agent-primary-${cdk.Aws.ACCOUNT_ID}`,
      assumedBy: new iam.ServicePrincipal("aidevops.amazonaws.com", {
        conditions: {
          StringEquals: {
            "aws:SourceAccount": cdk.Aws.ACCOUNT_ID,
          },
          ArnLike: {
            "aws:SourceArn": `arn:aws:aidevops:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agentspace/*`,
          },
        },
      }),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AIDevOpsAgentAccessPolicy"),
      ],
      description: "Primary role assumed by DevOps Agent service to investigate deploy account resources",
    });
    primaryRole.addToPolicy(new iam.PolicyStatement({
      actions: ["iam:CreateServiceLinkedRole"],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/aws-service-role/resource-explorer-2.amazonaws.com/AWSServiceRoleForResourceExplorer`],
      conditions: {
        StringEquals: {
          "iam:AWSServiceName": "resource-explorer-2.amazonaws.com",
        },
      },
    }));

    // Deep-dive 时让 DevOps Agent 直接查 CUR（成本深挖到资源级）：Athena 查询 + Glue
    // 目录只读 + CUR 数据只读；查询结果写按 athena-results/ 前缀收紧。CUR 桶名客户
    // 自定义、部署期不可知，故 CUR 数据读放开到 *（只读）。
    primaryRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "athena:StartQueryExecution", "athena:GetQueryExecution", "athena:GetQueryResults", "athena:StopQueryExecution",
        "glue:GetDatabase", "glue:GetDatabases", "glue:GetTable", "glue:GetTables", "glue:GetPartitions",
        "s3:GetObject", "s3:ListBucket",
      ],
      resources: ["*"],
    }));
    primaryRole.addToPolicy(new iam.PolicyStatement({
      actions: ["s3:PutObject", "s3:GetObject"],
      resources: ["arn:aws:s3:::*/athena-results/*"],
    }));

    // Association: 把部署账号绑定到 Agent Space（让 Agent 知道它可以调查此账号）
    // 日后跨账号 onboard 时,业务账号各自创建独立 Association（不影响此处）。
    const association = new devopsAgentModule.CfnAssociation(this, "DevOpsAgentAssociation", {
      agentSpaceId: agentSpace.attrAgentSpaceId,
      serviceId: "aws",
      configuration: {
        aws: {
          accountId: cdk.Aws.ACCOUNT_ID,
          accountType: "monitor",
          assumableRoleArn: primaryRole.roleArn,
        },
      },
    });
    association.node.addDependency(agentSpace);
    association.node.addDependency(primaryRole);

    // Trigger Role: Lambda/ECS AssumeRole 到本账号调 DevOps Agent API
    const triggerRole = new iam.Role(this, "DevOpsAgentTriggerRole", {
      roleName: `notiops-agent-trigger-${cdk.Aws.ACCOUNT_ID}`,
      assumedBy: new iam.AccountPrincipal(cdk.Aws.ACCOUNT_ID),
      description: "Assumed by Lambda/ECS to call DevOps Agent API on the deploy account",
    });
    triggerRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "aidevops:CreateBacklogTask",
        "aidevops:GetAgentSpace",
        "aidevops:ListJournalRecords",
        "aidevops:GetJournalRecord",
      ],
      resources: [agentSpace.attrArn || `arn:aws:aidevops:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agentspace/*`],
    }));

    // Auto-onboard: 用 Custom Resource 在部署时写 DDB config 表
    const onboardFn = new lambda.Function(this, "AutoOnboardFunction", {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "index.handler",
      code: lambda.Code.fromInline(`
import boto3, os, json, urllib.request
def send_cfn(event, context, status, data={}):
    body = json.dumps({
        'Status': status,
        'Reason': str(data.get('Error', 'OK')),
        'PhysicalResourceId': context.log_stream_name,
        'StackId': event['StackId'],
        'RequestId': event['RequestId'],
        'LogicalResourceId': event['LogicalResourceId'],
        'Data': data,
    }).encode()
    req = urllib.request.Request(event['ResponseURL'], data=body,
                                 headers={'Content-Type': ''}, method='PUT')
    urllib.request.urlopen(req)

def handler(event, context):
    if event['RequestType'] == 'Delete':
        send_cfn(event, context, 'SUCCESS')
        return
    try:
        table = boto3.resource('dynamodb').Table(os.environ['CONFIG_TABLE'])
        account_id = os.environ['ACCOUNT_ID']
        table.put_item(
            Item={
                'PK': f'da#{account_id}',
                'SK': 'meta',
                'GSI1PK': 'da#accounts',
                'GSI1SK': account_id,
                'account_id': account_id,
                'account_alias': 'deploy-account (auto)',
                'agent_space_id': os.environ['AGENT_SPACE_ID'],
                'agent_space_arn': os.environ['AGENT_SPACE_ARN'],
                'trigger_role_arn': os.environ['TRIGGER_ROLE_ARN'],
                'region': os.environ['DEPLOY_REGION'],
                'onboarding_status': 'active',
                'enabled': True,
                'related_business_accounts': [],
            },
        )
        send_cfn(event, context, 'SUCCESS', {'AccountId': account_id})
    except Exception as e:
        send_cfn(event, context, 'FAILED', {'Error': str(e)})
`),
      environment: {
        CONFIG_TABLE: configTable.tableName,
        ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        AGENT_SPACE_ID: agentSpace.attrAgentSpaceId,
        AGENT_SPACE_ARN: agentSpace.attrArn || "",
        TRIGGER_ROLE_ARN: triggerRole.roleArn,
        DEPLOY_REGION: cdk.Aws.REGION,
      },
      timeout: cdk.Duration.seconds(30),
    });
    configTable.grantWriteData(onboardFn);
    onboardFn.node.addDependency(agentSpace);
    onboardFn.node.addDependency(triggerRole);

    new cdk.CustomResource(this, "AutoOnboardResource", {
      serviceToken: onboardFn.functionArn,
      properties: {
        triggerRoleArn: triggerRole.roleArn,
        agentSpaceId: agentSpace.attrAgentSpaceId,
        // 每次部署都变 → CustomResource 每次都重跑,自愈补写 da# 记录。
        // 修复:配置表若被删/重建(如 SpringClean),静态 property 会让 CFN 判定"无变化"
        // 而不重跑,导致 da# 上车记录永久丢失 → IM 端派发报"未上车"。put_item 整条覆盖、
        // 幂等,且这条是 auto 管理记录(account_alias="deploy-account (auto)"),重写无害。
        timestamp: Date.now().toString(),
      },
    });

    new cdk.CfnOutput(this, "AgentSpaceId", {
      value: agentSpace.attrAgentSpaceId,
      description: "DevOps Agent Space ID (部署账号, 自动创建)",
    });

    // ─── Seed Data: 初始阈值 + v3 prompt + 默认模型 ───
    // 幂等写入(attribute_not_exists)——不覆盖用户已修改的值。
    // 解决原 notiops schema-init INSERT 迁移后丢失的问题。
    // seed-data.json 存完整 v3 prompt(~7KB)，作为 Lambda asset 部署，不走环境变量。
    const seedDataFn = new lambda.Function(this, "SeedDataFunction", {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "index.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "..", "lambda", "seed-data")),
      environment: {
        CONFIG_TABLE: configTable.tableName,
      },
      timeout: cdk.Duration.seconds(30),
    });
    configTable.grantWriteData(seedDataFn);

    const seedDataResource = new cdk.CustomResource(this, "SeedDataResource", {
      serviceToken: seedDataFn.functionArn,
      properties: {
        // 版本号变更会触发 CustomResource 在部署时重跑(用于 seed 新增内容)。
        // v5:移除本 Lambda 的 skill seed(改由 BFF seedPresetSkills 统一负责,消除双写分叉)。
        version: "5-no-skill-seed",
      },
    });

    // ─── Custom Event Bus：聚合所有 Business Account 转发的 aws.aidevops 事件 ───
    const devopsEventBus = new events.EventBus(this, "DevOpsAgentEventBus", {
      eventBusName: "notiops-devops-events",
    });

    // API Lambda 需要 PutEvents 到 Custom Event Bus（测试连接 Step 3 + 未来可能的手动触发）
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: "PutEventsToDevOpsCustomBus",
      actions: ["events:PutEvents"],
      resources: [devopsEventBus.eventBusArn],
    }));

    // Resource policy 双重条件（R5.6, R5.9, R13.3）：
    //  1. aws:PrincipalAccount ∈ CDK context devopsAgentBusinessAccounts 白名单
    //  2. events:source 等于 "aws.aidevops"
    const devopsAgentBusinessAccountsRaw = this.node.tryGetContext(
      "devopsAgentBusinessAccounts",
    ) as string | undefined;
    const devopsAgentBusinessAccounts = (devopsAgentBusinessAccountsRaw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[0-9]{12}$/.test(s));

    if (orgMode) {
      // 多账号(Organizations)模式：整组放行，双重条件
      //  1. aws:PrincipalOrgID == 本组织 — 只有组织内账号能投递
      //  2. events:source == "aws.aidevops" — 只接受 DevOps Agent 调查事件
      // 免去逐账号白名单维护；实际采集/调查范围仍由 config 表 enabled 账号控制。
      new events.CfnEventBusPolicy(this, "DevOpsAgentEventBusPolicy", {
        eventBusName: devopsEventBus.eventBusName,
        statementId: "AllowOrgAccountsForwardAidevopsEvents",
        statement: {
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action: "events:PutEvents",
          Resource: devopsEventBus.eventBusArn,
          Condition: {
            StringEquals: {
              "aws:PrincipalOrgID": organizationId,
              "events:source": "aws.aidevops",
            },
          },
        },
      });
    } else if (devopsAgentBusinessAccounts.length > 0) {
      new events.CfnEventBusPolicy(this, "DevOpsAgentEventBusPolicy", {
        eventBusName: devopsEventBus.eventBusName,
        statementId: "AllowWhitelistedBusinessAccountsForwardAidevopsEvents",
        statement: {
          Effect: "Allow",
          Principal: { AWS: "*" },
          Action: "events:PutEvents",
          Resource: devopsEventBus.eventBusArn,
          Condition: {
            StringEquals: {
              "aws:PrincipalAccount": devopsAgentBusinessAccounts,
              "events:source": "aws.aidevops",
            },
          },
        },
      });
    }

    new cdk.CfnOutput(this, "DevOpsAgentBusinessAccountsWhitelist", {
      // 值保持纯 ASCII：它会被 setup.sh 用 jq 取出后直接 echo，含中文/em-dash 会在部分终端显示为乱码。
      // 中文说明放在双语标签(setup.sh 的 t())与本 output 的 description 里，不进入 value 本身。
      value:
        devopsAgentBusinessAccounts.length > 0
          ? devopsAgentBusinessAccounts.join(",")
          : "(none configured; Custom Bus accepts only same-account IAM principals)",
      description: "Custom Event Bus 允许跨账户 PutEvents 的业务账户白名单（来自 CDK context devopsAgentBusinessAccounts）",
    });

    // ─── SQS DLQ：Custom Bus Rule → Callback Lambda 投递失败落到此队列 ───
    const callbackDlq = new sqs.Queue(this, "DevOpsAgentCallbackDlq", {
      queueName: "notiops-devops-callback-dlq",
      retentionPeriod: cdk.Duration.days(14),
    });

    // ─── Callback Lambda 独立代码包 ───
    // GLOB exclude; requires --output outside repo root (see lambdaCode note).
    const devopsCallbackCode = lambda.Code.fromAsset("../", {
      exclude: [
        "frontend/**", "infra/**", "tests/**", ".venv*/**",
        "agent-build/**", "promo/**", "agent/**", "bff/**", "**/.cache/**",
        "**/node_modules/**", ".git/**", ".hypothesis/**",
        "*.md", ".pytest_cache/**", ".kiro/**",
        "lambda_layer/**", "cdk.out/**", "**/__pycache__/**",
        "platforms/**", "agent/**",
        "api/**", "lambda1_collector/**", "lambda2_analyzer/**",
        "lambda3_health_checker/**", "lambda4_notifier/**",
        "lambda5_cost_analyzer/**",
        "phd_event_forwarder/**",
        "mcp_server/**", "scripts/**", "docs/**",
        "generated-diagrams/**",
      ],
    });

    // ─── Callback Lambda ───
    const logGroupCallback = createLogGroup("LogGroupCallback", "notiops-devops-callback");
    const devopsCallbackLambda = new lambda.Function(this, "DevOpsCallbackLambda", {
      functionName: "notiops-devops-callback",
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: "devops_agent_callback.handler.handler",
      code: devopsCallbackCode,
      logGroup: logGroupCallback,
      role: lambdaRole,
      timeout: cdk.Duration.seconds(120),
      memorySize: 256,
      layers: [depsLayer],
      environment: {
        ...lambdaEnv,
        FEISHU_SECRET_ARN: feishuSecret.secretArn,
        // shared/report_delivery/slack_sender.py keys off this env var
        // for is_configured() AND uses the value as the SecretId in
        // GetSecretValue. Use the secret name (not ARN) — both work,
        // and the name matches what BotStack passes to the bot
        // containers, keeping the contract uniform.
        SLACK_BOT_TOKEN_ARN: slackBotTokenSecret.secretName,
        BEDROCK_API_KEY_SECRET_ARN: bedrockApiKeySecret.secretArn,
      },
      description:
        "DevOps Agent 调查结果回调 — Custom Event Bus 触发，AssumeRole 拉摘要 → Bedrock 精简 → 入 DDB",
    });

    // LITELLM Secret env
    devopsCallbackLambda.addEnvironment(
      "LITELLM_CONFIG_SECRET_ARN",
      liteLlmConfigSecret.secretName,
    );

    // ─── EventBridge Rule on Custom Bus → Callback Lambda（带 DLQ + 2 次重试）───
    new events.Rule(this, "DevOpsAgentCallbackCustomRule", {
      ruleName: "devops-agent-callback-custom",
      eventBus: devopsEventBus,
      description:
        "DevOps Agent 调查结果回调 — Investigation Completed/Failed/Timed Out（Custom Bus）",
      eventPattern: {
        source: ["aws.aidevops"],
        detailType: [
          "Investigation Created",
          "Investigation Completed",
          "Investigation Failed",
          "Investigation Timed Out",
          "Investigation Cancelled",
          "Investigation Linked",
        ],
      },
      targets: [
        new targets.LambdaFunction(devopsCallbackLambda, {
          deadLetterQueue: callbackDlq,
          retryAttempts: 2,
        }),
      ],
    });

    // ─── EventBridge Rule on DEFAULT Bus → Callback Lambda ───
    // 本账号的 DevOps Agent 把事件发到 default bus(不是 Custom Bus)。
    // Custom Bus 是给跨账号转发用的;本账号需要在 default bus 也有 rule。
    // 原 notiops-devops SAM 就是在 default bus 上建的 EventBridgeRule。
    new events.Rule(this, "DevOpsAgentCallbackDefaultRule", {
      ruleName: "devops-agent-callback-default",
      description:
        "DevOps Agent 调查事件(本账号 default bus) → Callback Lambda",
      eventPattern: {
        source: ["aws.aidevops"],
        detailType: [
          "Investigation Created",
          "Investigation Completed",
          "Investigation Failed",
          "Investigation Timed Out",
          "Investigation Cancelled",
          "Investigation Linked",
        ],
      },
      targets: [
        new targets.LambdaFunction(devopsCallbackLambda, {
          deadLetterQueue: callbackDlq,
          retryAttempts: 2,
        }),
      ],
    });

    // ─── S3 Bucket：共用业务桶(前缀分区:onboarding/ + skills/ + 将来 reports/)───
    // 只创建 1 个桶,避免客户账号里 S3 桶膨胀。不同功能用前缀隔离。
    const dataBucket = new s3.Bucket(this, "DataBucket", {
      bucketName: `notiops-data-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{
        id: "expire-onboarding-templates-7d",
        prefix: "onboarding/",
        expiration: cdk.Duration.days(7),
      }, {
        // 报告 7 天生命周期：兑现"报告链接 7 天内有效"承诺（到期对象删除、CDN 链接自然失效），
        // 且避免客户调查报告长期堆积在桶里。
        id: "expire-reports-7d",
        prefix: "reports/",
        expiration: cdk.Duration.days(7),
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    this.dataBucketName = dataBucket.bucketName;
    this.userPoolId = userPool.userPoolId;
    this.userPoolClientId = userPoolClient.userPoolClientId;

    // ─── 报告分发 CDN（CloudFront + OAC，只暴露 reports/*）───────────────────
    // 目的：报告链接真·长期有效、任地点浏览器打开，不受 runtime 临时凭证 presign 的 12h 限制。
    // 安全模型：URL 即凭证（与旧 presigned 一致，只是不过期），key 用不可猜的 UUID；
    // 用 CloudFront Function 把非 /reports/ 前缀的请求一律 403，避免暴露桶内其它内容
    // （skills/、cost 缓存、onboarding 等），OAC 只读私有桶（不放开桶的公共访问）。
    const reportsPathGuard = new cloudfront.Function(this, "ReportsPathGuard", {
      code: cloudfront.FunctionCode.fromInline(
        "function handler(event){var u=event.request.uri;" +
        "if(u.indexOf('/reports/')!==0){return {statusCode:403,statusDescription:'Forbidden'};}" +
        "return event.request;}"
      ),
    });
    const reportsCdn = new cloudfront.Distribution(this, "ReportsCDN", {
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
    this.reportsCdnDomain = reportsCdn.distributionDomainName;
    new cdk.CfnOutput(this, "ReportsCdnDomain", { value: reportsCdn.distributionDomainName });

    // Dashboard API Lambda 读写 onboarding 模板 + skill(管理端)
    dataBucket.grantReadWrite(apiLambda);
    apiLambda.addEnvironment("ONBOARDING_TEMPLATES_BUCKET", dataBucket.bucketName);
    apiLambda.addEnvironment("SKILLS_BUCKET", dataBucket.bucketName);
    // DATA_BUCKET：调查详情按需从 S3 读 investigations/<task_id>/report.md
    // （report pipeline refactor）。代码侧解析顺序 S3_BUCKET → DATA_BUCKET →
    // SKILLS_BUCKET，三者均指向同一数据桶。
    apiLambda.addEnvironment("DATA_BUCKET", dataBucket.bucketName);

    // 注:seedDataFn 不再写 S3 skill(预置 skill 改由 BFF 运行时 seedPresetSkills 统一 seed),
    // 故此处不再给它注入 SKILLS_BUCKET / 授予 dataBucket 读写 / 加 dataBucket 依赖(最小权限)。
    // 它只写 DynamoDB 配置(阈值/prompt/模型),权限在 seedDataFn 定义处已用 configTable.grantWriteData 授予。

    // Callback Lambda 读写报告(HTML report + trace 上传到 reports/ 前缀)
    dataBucket.grantReadWrite(devopsCallbackLambda);
    devopsCallbackLambda.addEnvironment("DATA_BUCKET", dataBucket.bucketName);

    // CUR finalizer 在下发 FinOps 保存查询时，把 primary workgroup 结果输出位置设到
    // 数据桶的 athena-results/ 前缀（Athena 控制台手跑查询需要）。dataBucket 此处才建，
    // 故 env 在这里补齐（lambda6CurFinalizer 定义在前）。
    lambda6CurFinalizer.addEnvironment("DATA_BUCKET", dataBucket.bucketName);

    new cdk.CfnOutput(this, "DataBucketName", {
      value: dataBucket.bucketName,
      description: "共用业务 S3 Bucket(onboarding/ + skills/ 前缀分区)",
    });


    // ─── Push Handler：多源实时事件推送(CloudWatch/Backup/GuardDuty/CostAnomaly/TA)───
    // 原 notiops-devops 的实时推送功能。默认 DISABLED,需在 Dashboard 或 CDK context 启用。
    // 每个事件源独立 Rule,可单独 enable/disable。
    const pushLambdaCode = lambda.Code.fromAsset("../", {
      exclude: [
        "frontend/**", "infra/**", ".venv*/**", "**/node_modules/**",
        "agent-build/**", "promo/**", "agent/**", "bff/**", "**/.cache/**",
        ".git/**", "tests/**", "docs/**", ".kiro/**",
        "lambda_layer/**", "cdk.out/**", "**/__pycache__/**",
        "platforms/**", "*.md", "mcp_server/**",
        ".hypothesis/**", ".pytest_cache/**",
      ],
    });

    const pushLambda = new lambda.Function(this, "PushHandlerLambda", {
      ...commonLambdaProps,
      functionName: "notiops-push-handler",
      handler: "shared.report_delivery.push_handler.lambda_handler",
      code: pushLambdaCode,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ...lambdaEnv,
        FEISHU_SECRET_ARN: feishuSecret.secretArn,
        DATA_BUCKET: dataBucket.bucketName,
      },
      description: "多源 AWS 事件实时推送到 IM(CloudWatch Alarm / Backup / GuardDuty / Cost Anomaly / Trusted Advisor）",
    } as lambda.FunctionProps);

    dataBucket.grantRead(pushLambda);
    pushLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:notiops/im-bot-feishu-*`],
    }));

    // EventBridge Rules — 默认 DISABLED(需显式启用)
    // source / detailType 必须逐字匹配 AWS 实际发出的事件,写错了规则永不触发、
    // 且没有任何报错。判据:EventBridge schema registry(aws.events 注册表)里
    // 存在 `<source>@<DetailTypeWithoutSpaces>` 这个 schema。
    const pushRuleSources = [
      { id: "CloudWatchAlarm", source: "aws.cloudwatch", detailType: "CloudWatch Alarm State Change" },
      { id: "BackupJob", source: "aws.backup", detailType: "Backup Job State Change" },
      { id: "GuardDuty", source: "aws.guardduty", detailType: "GuardDuty Finding" },
      // Cost Anomaly:source 是 aws.ce(不是 aws.costexplorer —— 那个 source 不存在),
      // detail-type 是 "Anomaly Detected"。见 core/push_event.py from_cost_anomaly 的注释。
      { id: "CostAnomaly", source: "aws.ce", detailType: "Anomaly Detected" },
      // Trusted Advisor:唯一真实存在的 detail-type 是 "...Refresh Notification"
      // (控制台标签写作 "Check Item Refresh Status")。
      { id: "TrustedAdvisor", source: "aws.trustedadvisor", detailType: "Trusted Advisor Check Item Refresh Notification" },
    ];

    for (const src of pushRuleSources) {
      new events.Rule(this, `PushRule${src.id}`, {
        ruleName: `notiops-push-${src.id.toLowerCase()}`,
        eventPattern: { source: [src.source], detailType: [src.detailType] },
        targets: [new targets.LambdaFunction(pushLambda)],
        enabled: false, // 默认 DISABLED,需在控制台或 CDK context 启用
      });
    }

    // ─── Web Chat 通知收件箱(主动观察 push → web 端持久化收件箱)───
    // 与 IM push 复用同一 core.push_event normalizer,但 sink 是写 notiops-web-chat
    // 表的 notif# 段(账号级共享收件箱),不自动发起调查。
    // web chat 页面 60s 轮询 BFF 拿增量;离线时事件仍在库里,进来即可回顾。
    const webNotifLambda = new lambda.Function(this, "WebNotifHandlerLambda", {
      ...commonLambdaProps,
      functionName: "notiops-web-notif-handler",
      handler: "shared.report_delivery.web_push_handler.lambda_handler",
      code: pushLambdaCode, // 与 IM push 同一份 asset(含 core/)
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ...lambdaEnv,
        WEB_CHAT_TABLE: "notiops-web-chat",
        NOTIF_INBOX_KEY: "account", // 一期:账号级共享一份收件箱
        NOTIF_TTL_DAYS: "90",
      },
      description: "多源 AWS 事件 → Web Chat 通知收件箱(默认开:Health / CloudWatch Alarm / Cost Anomaly / Trusted Advisor / GuardDuty;可选:Backup / Spot / Auto Scaling / RDS / Config)",
    } as lambda.FunctionProps);

    // 授权写 notiops-web-chat 表(表在 WebChatStack;用固定名拼 ARN,避免跨 stack 依赖)。
    webNotifLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [`arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/notiops-web-chat`],
    }));

    // Web 通知的 EventBridge 规则。
    //
    // 默认开这 5 个(运维价值最高、噪音可控):
    //   AWS Health · CloudWatch 告警 · Cost Anomaly · Trusted Advisor · GuardDuty
    // 其余 5 个默认关:Backup / EC2 Spot / Auto Scaling / RDS / Config
    //   —— 要么量大易刷屏(Backup 每次作业、Spot、RDS),要么需客户先开通付费服务
    //   且合规类噪音大(Config)。需要时 -c webNotif<Id>=on 单独打开。
    //
    // GuardDuty 默认开但**需客户先启用 GuardDuty**(付费服务)。没启用时
    // 没有 detector、不会有任何 finding,规则处于"开着但收不到事件"的状态 ——
    // 无害且零成本,一旦客户启用就立刻生效,不用再回来改部署。
    //
    // globalOnly 标记:这两个是**全局服务**,只在 us-east-1 发 EventBridge 事件
    // (TA 见 https://docs.aws.amazon.com/awssupport/latest/user/cloudwatch-events-ta.html;
    //  Cost Anomaly 事件的 region = 其 home region,通常 us-east-1)。
    // 部署在别的 region 时规则建了也永不触发,所以下面会 addWarning 明确告知,
    // 而不是让用户以为"开了就有"。
    const webNotifSources = [
      { id: "Health", source: "aws.health", detailType: "AWS Health Event", on: true },
      { id: "CloudWatchAlarm", source: "aws.cloudwatch", detailType: "CloudWatch Alarm State Change", on: true },
      { id: "CostAnomaly", source: "aws.ce", detailType: "Anomaly Detected", on: true, globalOnly: true },
      { id: "TrustedAdvisor", source: "aws.trustedadvisor", detailType: "Trusted Advisor Check Item Refresh Notification", on: true, globalOnly: true },
      { id: "GuardDuty", source: "aws.guardduty", detailType: "GuardDuty Finding", on: true },
      { id: "BackupJob", source: "aws.backup", detailType: "Backup Job State Change", on: false },
      { id: "Ec2Spot", source: "aws.ec2", detailType: "EC2 Spot Instance Interruption Warning", on: false },
      { id: "AutoScalingFail", source: "aws.autoscaling", detailType: "EC2 Instance Launch Unsuccessful", on: false },
      { id: "Rds", source: "aws.rds", detailType: "RDS DB Instance Event", on: false },
      { id: "Config", source: "aws.config", detailType: "Config Rules Compliance Change", on: false },
    ];

    for (const src of webNotifSources) {
      const override = this.node.tryGetContext(`webNotif${src.id}`) as string | undefined;
      const enabled = override ? override === "on" : src.on;
      const rule = new events.Rule(this, `WebNotifRule${src.id}`, {
        ruleName: `notiops-web-notif-${src.id.toLowerCase()}`,
        eventPattern: { source: [src.source], detailType: [src.detailType] },
        targets: [new targets.LambdaFunction(webNotifLambda)],
        enabled,
      });
      // 全局服务源部署到非 us-east-1:规则永不触发。合成期就喊出来,
      // 免得客户开了开关却等不到通知,还以为是 NotiOps 坏了。
      if (enabled && src.globalOnly && this.region !== "us-east-1") {
        cdk.Annotations.of(rule).addWarning(
          `${src.id} is a global service that only emits EventBridge events in ` +
          `us-east-1; this stack is in ${this.region}, so rule ` +
          `notiops-web-notif-${src.id.toLowerCase()} will never fire. ` +
          `To receive these notifications, deploy NotiOps in us-east-1, or ` +
          `forward the events from us-east-1 to this region via a cross-region ` +
          `EventBridge rule. Silence this by deploying with ` +
          `-c webNotif${src.id}=off.`
        );
      }
    }


    // ─── PHD 事件跨账号聚合转发（可通过 -c skipPhd=true 跳过）───
    const skipPhd = this.node.tryGetContext("skipPhd") === "true";

    if (!skipPhd) {
      // SNS Topic：聚合所有账号的 PHD 事件
      const phdTopic = new sns.Topic(this, "PhdEventsTopic", {
        topicName: "phd-events",
        displayName: "PHD 事件聚合",
      });

      // SNS Resource Policy — 跨账号
      const phdLinkedAccountsStr = this.node.tryGetContext("phdLinkedAccounts") as string | undefined;
      if (orgMode) {
        // 多账号(Organizations)模式：整组放行，双重条件
        //  1. aws:PrincipalOrgID == 本组织
        //  2. ArnLike phd-event-forwarder-role-* — 只有成员账号里 StackSet 下发的转发角色能 Publish
        phdTopic.addToResourcePolicy(new iam.PolicyStatement({
          sid: "AllowOrgAccountsPhdPublish",
          actions: ["sns:Publish"],
          principals: [new iam.StarPrincipal()],
          resources: [phdTopic.topicArn],
          conditions: {
            StringEquals: {
              "aws:PrincipalOrgID": organizationId,
            },
            ArnLike: {
              "aws:PrincipalArn": "arn:aws:iam::*:role/phd-event-forwarder-role-*",
            },
          },
        }));
      } else if (phdLinkedAccountsStr) {
        const accountIds = phdLinkedAccountsStr.split(",").map(s => s.trim()).filter(s => s);
        if (accountIds.length > 0) {
          const allowedRoleArns = accountIds.map(
            acctId => `arn:aws:iam::${acctId}:role/phd-event-forwarder-role-${acctId}`
          );
          phdTopic.addToResourcePolicy(new iam.PolicyStatement({
            sid: "AllowLinkedAccountRolePublish",
            actions: ["sns:Publish"],
            principals: [new iam.StarPrincipal()],
            resources: [phdTopic.topicArn],
            conditions: {
              ArnLike: {
                "aws:PrincipalArn": allowedRoleArns,
              },
            },
          }));
        }
      }

      // 系统账号 EventBridge Rule — 匹配本账号 PHD 事件
      new events.Rule(this, "PhdEventRule", {
        ruleName: "phd-event-to-sns",
        eventPattern: {
          source: ["aws.health"],
          detailType: ["AWS Health Event"],
        },
        targets: [new targets.SnsTopic(phdTopic)],
      });

      // PHD Lambda 独立代码包
      // GLOB exclude; requires --output outside repo root (see lambdaCode note).
      const phdLambdaCode = lambda.Code.fromAsset("../", {
        exclude: [
          "frontend/**", "infra/**", "tests/**", ".venv*/**",
          "agent-build/**", "promo/**", "agent/**", "bff/**", "**/.cache/**",
          "**/node_modules/**", ".git/**", ".hypothesis/**",
          "*.md", ".pytest_cache/**", ".kiro/**",
          "lambda_layer/**", "cdk.out/**", "**/__pycache__/**",
          "platforms/**", "agent/**",
          "api/**", "lambda1_collector/**", "lambda2_analyzer/**",
          "lambda3_health_checker/**", "lambda4_notifier/**",
          "lambda5_cost_analyzer/**", "docs/**",
        ],
      });

      // PHD Lambda
      const logGroupPhd = createLogGroup("LogGroupPhd", "notiops-phd-forwarder");
      const phdLambda = new lambda.Function(this, "PhdForwarderLambda", {
        functionName: "notiops-phd-forwarder",
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: "phd_event_forwarder.handler.handler",
        code: phdLambdaCode,
        logGroup: logGroupPhd,
        timeout: cdk.Duration.seconds(90),
        memorySize: 128,
        layers: [depsLayer],
        environment: {
          BEDROCK_API_KEY_SECRET_ARN: bedrockApiKeySecret.secretArn,
          LITELLM_CONFIG_SECRET_ARN: liteLlmConfigSecret.secretName,
          FEISHU_SECRET_ARN: feishuSecret.secretArn,
          MODEL_ID: "global.anthropic.claude-sonnet-5",
        },
        description: "PHD 事件转发 — SNS 触发,LLM 翻译摘要(Bedrock/LiteLLM 可切换),推送飞书",
      });

      // PHD Lambda IAM
      phdLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [llmProviderParam.parameterArn],
      }));
      liteLlmConfigSecret.grantRead(phdLambda);

      phdLambda.addToRolePolicy(new iam.PolicyStatement({
        actions: ["bedrock:InvokeModel"],
        resources: [
          "arn:aws:bedrock:*::foundation-model/*",
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }));

      bedrockApiKeySecret.grantRead(phdLambda);
      feishuSecret.grantRead(phdLambda);

      // SNS → Lambda 订阅
      phdTopic.addSubscription(new subscriptions.LambdaSubscription(phdLambda));

      new cdk.CfnOutput(this, "PhdSnsTopicArn", {
        value: phdTopic.topicArn,
        description: "PHD 事件聚合 SNS Topic ARN — Linked Account 部署时使用",
      });
    } // end if (!skipPhd)

    // ─── Outputs ───
    new cdk.CfnOutput(this, "CloudFrontUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "前端访问地址",
    });
    new cdk.CfnOutput(this, "ApiUrl", {
      value: api.url,
      description: "API Gateway URL",
    });
    new cdk.CfnOutput(this, "UserPoolId", {
      value: userPool.userPoolId,
      description: "Cognito User Pool ID",
    });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
      description: "Cognito App Client ID",
    });
    new cdk.CfnOutput(this, "LambdaExecutionRoleArn", {
      value: lambdaRole.roleArn,
      description: "Lambda 执行 Role ARN — 用于目标账户 IdleDetectionRole 的信任策略",
    });
    new cdk.CfnOutput(this, "IdleDetectionRoleArn", {
      value: idleDetectionRole.roleArn,
      description: "管理账户 IdleDetectionRole ARN — 在 Dashboard 目标账户管理中添加",
    });
    new cdk.CfnOutput(this, "FrontendBucketName", {
      value: siteBucket.bucketName,
      description: "前端 S3 Bucket",
    });
    new cdk.CfnOutput(this, "DistributionId", {
      value: distribution.distributionId,
      description: "CloudFront Distribution ID",
    });
    new cdk.CfnOutput(this, "DevOpsAgentEventBusArn", {
      value: devopsEventBus.eventBusArn,
      description:
        "DevOps Agent Custom Event Bus ARN — Business Account 配置跨账号 EventBridge 转发时使用",
    });
    new cdk.CfnOutput(this, "FeishuSecretArn", {
      value: feishuSecret.secretArn,
      description: "飞书机器人凭证 Secret ARN",
    });
    new cdk.CfnOutput(this, "SlackBotTokenSecretArn", {
      value: slackBotTokenSecret.secretArn,
      description: "Slack bot token (xoxb-) Secret ARN",
    });
    new cdk.CfnOutput(this, "SlackAppTokenSecretArn", {
      value: slackAppTokenSecret.secretArn,
      description: "Slack app-level token (xapp-) Secret ARN — Socket Mode",
    });
    new cdk.CfnOutput(this, "BedrockApiKeySecretArn", {
      value: bedrockApiKeySecret.secretArn,
      description: "Bedrock API Key Secret ARN — 部署后填充实际 API Key",
    });
    new cdk.CfnOutput(this, "LiteLlmConfigSecretArn", {
      value: liteLlmConfigSecret.secretArn,
      description: "LiteLLM Config Secret ARN — Dashboard 填充 base_url / api_key / default_model",
    });
  }
}
