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
import * as lambdaEventSources from "aws-cdk-lib/aws-lambda-event-sources";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as cr from "aws-cdk-lib/custom-resources";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as path from "path";
import { WEB_CHAT_TABLE_NAME } from "./constructs/web-chat-core";
// 「通知」生产端的唯一真源 —— 一键部署（方式 A）的单栈 import 的是同一份。
import {
  WEB_NOTIF_FUNCTION_DESCRIPTION,
  WEB_NOTIF_FUNCTION_NAME,
  WEB_NOTIF_HANDLER,
  WEB_NOTIF_SOURCES,
  webNotifEnv,
  webNotifRuleDescription,
  webNotifRuleName,
} from "./constructs/web-notif-sources";

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
  // 资源巡检专用 Agent Space（与上面那个隔离，见 spec R12.5c）。
  // 隔离的三个理由：并发配额是 per space（批量派发会占满 3 个位、拖慢客户的交互式深度调查）；
  // skill 是 per space（巡检 skill 不该被排障调查误加载）；
  // 事件里的 agent_space_id 直接成为「这是巡检」的分流判据。
  // ⚠️ 与 `agentSpaceId` 是**两个独立标量**，SHALL NOT 合成 list —— 后者有 20+ 个
  // 标量读取点（shared/devops_agent.py · core/ · devops_agent_callback/ ·
  // shared/report_delivery/ · 前端），改多值等于重写整条排障链路。
  public readonly inspectionAgentSpaceId: string;
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

    /**
     * 巡检判读的语言。**巡检 space 的 `locale` 与 executor 的
     * `INSPECTION_REPORT_LOCALE` 共用这一个值** —— 两处各写一遍
     * `tryGetContext` 会漂移，那时 space 说英文、payload 说中文，
     * 而判读听哪个不确定。
     *
     * ⚠️ 取值格式实测确认 `"zh"` 可用（`UpdateAgentSpace` 接受）。
     * 换英文用 `-c inspectionReportLocale=en`（`setup.sh` 读
     * `$INSPECTION_REPORT_LOCALE` 转成这个 context）。
     *
     * ⚠️ 这是**全局**的，刻意不做 per-account / per-查看者：
     * 判读一条只生成一次、多处复用（推给多个 IM 群 + Web 看板），
     * 按查看者变就得为同一条 finding 生成 N 份判读 —— N 倍 LLM 额度。
     * 推送**外壳**的语言是另一层，由 `ChatTarget.locale` 决定。
     */
    const inspectionReportLocale =
      (this.node.tryGetContext("inspectionReportLocale") as string | undefined)
      ?? "zh";

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

    // ─── 资源巡检表 ───────────────────────────────
    // 单独建表而非复用 notiops-metrics：后者已列入删除计划，且序列库有自己的
    // TTL 策略（data_date + 35 天，**不等于**窗口长度 7 天）。混在一张表里
    // 会让删除动作互相牵制。
    //
    // 七个 PK 前缀共用这一张表，靠「互不为前缀」区分：
    //   inspseries# · insprun# · inspfind# · inspscope# · insptarget# ·
    //   inspchat# · cfgver#     （唯一来源是 inspection/adapters/keys.py 的 Prefix 枚举）
    // ⚠️ 它们安全的原因是**公共词根 insp 后不接分隔符**（inspseries# 而非
    //    insp#series#）。要分子空间时另起平级前缀（inspdispatch#），
    //    SHALL NOT 嵌套成 inspfind#dispatch# —— 那会让
    //    begins_with("inspfind#") 把它一起扫出来。
    //    keys.assert_prefixes_disjoint() 把这条固化成测试（R14.1b）。
    const inspectionTable = new dynamodb.Table(this, "InspectionTable", {
      tableName: "notiops-inspection",
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // ⚠️ RETAIN 而非 DESTROY：finding 的状态机跨天累积
      // （first_seen_date / consecutive_misses / was_confirmed）。
      // 删表重建会让全部历史 finding 以 new 重新冒出一遍，客户看到
      // 「今天新增 200 项风险」，而 R6.5 的「已持续 N 天」全部归 1。
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });
    // ─── GSI1：跨账号统一视图 ───
    //
    // 🔴 看板的语义是「今天我要处置什么」—— 跨账号一起按严重度排。而主键是
    //    `inspfind#<账号>`，每个账号一个分区，读侧必须先选账号。于是页面顶部那个
    //    账号选择器从「筛选」退化成了「决定加载哪个分区」，客户看到的是
    //    「一次只能看一个账号」，而那与统一视图的目的相反。
    //
    //    GSI1 让一次 Query 拿到全部账号：
    //      GSI1PK = "inspfind"（常量，所有 finding 一个分区）
    //      GSI1SK = "<严重度序>#<账号>#<finding_id>"
    //
    // ⚠️ 严重度**在 SK 最前**，为的是截断时先保住最严重的（读侧有 5000 条上限）。
    //    账号放前面会让截断变成「按账号字典序切一刀」—— 账号 ID 小的把配额吃光，
    //    而那与严重程度无关。完整说明见 `inspection/adapters/keys.py`。
    //
    // ⚠️ **稀疏索引**：只有 finding 行带 GSI1PK。表里有 12 种前缀
    //    （insprun# / inspseries# / cfgver# / …），它们不带这两个属性，
    //    所以索引里只有 finding，不会被别的记录类型污染，也不额外花钱。
    //
    // ⚠️ 投影用 ALL：读侧要的是完整 finding（严重度/证据/判读/持续天数都在卡片上）。
    //    KEYS_ONLY 或 INCLUDE 会让每条都要回主表再取一次 —— 那正是这个 GSI
    //    要省掉的往返。代价是索引存一份副本（finding 行约 1KB，量级可忽略）。
    //
    // ⚠️ **存量行没有 GSI1PK，不会出现在索引里。** 升级后要跑
    //    `scripts/backfill_finding_gsi.py`，否则统一视图看不到旧 finding，
    //    而那个缺失是静默的（查询成功、只是少了行）。
    inspectionTable.addGlobalSecondaryIndex({
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
      // PITR：这张表现在是**五个独立部署单元**的配置真源（web chat runtime / IM bot /
      // 后端 Lambda / BFF / 前端），里面既有 RBAC 角色与用户权限，也有 LLM 模型目录、
      // 纳管账号、通知配置。RETAIN 只防栈删除时丢表，防不住"一次写坏"——而模型目录
      // 的写入路径包含整份 PUT 与回滚，人为写错的面不小。
      // llmcfg 有 llmcfg#audit 里的变更前快照可回滚，但那只覆盖模型目录这一个 PK，
      // 且快照本身也存在同一张表里。PITR 是唯一的表级恢复手段。
      // `pointInTimeRecovery` 已废弃，用 Specification 形式（也支持 recoveryPeriodInDays，
      // 此处不传 = AWS 默认 35 天）。
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
      description: "Members: web chat only",
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
        // 🔴 Aurora 用的是**集群**而不是实例。缺这条的后果（东京实测）：
        //    `load_rds_attrs` 的 describe_db_clusters 拿到 AccessDenied →
        //    `loaded 0 RDS attrs` → `范围: 0 台资源` → 看板「本轮未发现风险」。
        //    整轮巡检**成功结束**、零错误码，只在日志里留两行 WARNING。
        //    另外 rollup 的分母也退化：集群成员展开失败 → 覆盖率按已评估数算，
        //    于是「漏了一半实例」会显示成 100% 完整。
        "rds:DescribeDBClusters",
        // 变更事件抑制（R2.5）：刚扩容/刚重启的实例本轮不报。
        // 缺它不会让巡检失败，但会让「昨天刚改过配置」这个抑制条件恒不成立
        // → 客户在维护窗口后第一天收到一批本该被压掉的告警。
        "rds:DescribeEvents",
        // 引擎 EOL 判定（结构性风险页的「版本即将停止支持」）。
        // 缺它的表现是 `loaded 0 engine major-version lifecycles` ——
        // 那一整类 finding **永远为空**，而页面上与「没有 EOL 风险」无法区分。
        // 东京实测：四个引擎各报一次 AccessDenied，然后静静地算完。
        "rds:DescribeDBMajorEngineVersions",
        "rds:DescribeDBEngineVersions",
        // CA 证书到期规则（ca_cert_expiring）。缺它 `load_ca_certs` 只记一行
        // WARNING 并返回**空表** → 那条规则永远不命中，而页面上与「没有证书
        // 风险」无法区分。RDS CA 到期是硬期限（到点连不上），漏报代价很高。
        // 东京实测（2026-08-22，e2e 链路测试）：闲置轮报 AccessDenied。
        "rds:DescribeCertificates",
        "rds:ListTagsForResource",
        "elasticache:DescribeCacheClusters",
        "elasticache:DescribeReplicationGroups",
        // 与 RDS 侧同理：EC 的变更事件也参与抑制判定。
        "elasticache:DescribeEvents",
        "elasticache:ListTagsForResource",
        // 🔴 **内存类判定的分母。** `freeable_memory_pct` /
        //    `database_memory_usage_pct` 都是「占实例规格的百分比」
        //    （R2.1.2），分母来自 `ec2:DescribeInstanceTypes` 的
        //    `MemoryInfo.SizeInMiB`（RDS/EC 的规格名去掉 `db.` / `cache.`
        //    前缀就是 EC2 机型）。
        //
        //    缺它的表现（2026-08-25 东京实测，14 台真实资源）：
        //    `resolved memory for 0/5 instance types` → 全部 attrs 的
        //    `memory_bytes` 留 None → **内存类规则一条都不命中**，
        //    而看板上与「内存都很健康」完全无法区分。
        //    整轮巡检 `status=success` / `completeness=100%`，零错误码。
        //
        //    ⚠️ 与 `web-chat-stack.ts` 里那句「**没有** ec2:DescribeInstances」
        //    不矛盾：那条说的是**不列举 EC2 实例**（巡检不覆盖 EC2 这个服务）。
        //    这里要的是**机型规格表**，一个静态的公共目录，与账号里有什么
        //    实例无关。
        //
        //    ⚠️ 不支持资源级限定（API 要求 `*`）。只读。
        "ec2:DescribeInstanceTypes",
        // 🔴 **巡检的 region 枚举**（2026-08-27，`scan_regions()`）。
        //
        //    在这之前巡检的 region 是执行 Lambda 的 `AWS_REGION`
        //    （AWS 注入、不可配），也就是部署 region 一个。验证账号
        //    的 4 台 RDS 全在 us-east-1、部署在 ap-northeast-1 →
        //    `expected.instances = 0` → `completeness = 0 ÷ 0 = 1` →
        //    看板显示「跑过了、没风险」。零错误、零告警、零日志。
        //
        //    ⚠️ 缺这条权限时 `scan_regions()` **抛异常**而不是回落成
        //    「只扫部署 region」—— 回落会让上面那个缺陷静默复活，而
        //    `dispatched` 计数看起来完全正常。
        //
        //    ⚠️ 不支持资源级限定。只读、只回本账号已启用的 region。
        "ec2:DescribeRegions",
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
    // ⚠️ 巡检表也要授权 —— 漏了的表现是运行时 AccessDeniedException，
    // 而巡检 Lambda 的失败是**静默的**：run 记录写不进去 → 对账扫不到这一轮
    // → 既不报「失败」也不报「成功」，看板上那天直接空白。
    inspectionTable.grantReadWriteData(lambdaRole);

    // Bedrock 权限（Lambda3 Converse + API Lambda ListInferenceProfiles/ListFoundationModels）
    // bedrock:InvokeModel 同时覆盖 Converse API，无需单独声明 bedrock:Converse
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        "arn:aws:bedrock:*::foundation-model/*",
        // Global CRIS（`global.*` inference profile）授权时呈现的是 region 段为空的
        // foundation-model ARN；上面那条里的 `*` 理论上能匹配空段，但判断错的后果是
        // 生产全部 Bedrock 调用 AccessDenied，故显式写出。
        // 见 https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
        "arn:aws:bedrock:::foundation-model/*",
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
        // 与 lambdaRole 保持一致 —— 这个角色是**成员账号**那侧的对应物。
        // 只补部署账号会让「本账号有 Aurora 就巡检得到、成员账号有就巡检不到」，
        // 而两边的表现都是「本轮未发现风险」，差别只在日志里。
        "rds:DescribeDBClusters",
        "rds:DescribeEvents",
        "rds:DescribeDBMajorEngineVersions",
        "rds:DescribeDBEngineVersions",
        // CA 证书到期规则（ca_cert_expiring）。缺它 `load_ca_certs` 只记一行
        // WARNING 并返回**空表** → 那条规则永远不命中，而页面上与「没有证书
        // 风险」无法区分。RDS CA 到期是硬期限（到点连不上），漏报代价很高。
        // 东京实测（2026-08-22，e2e 链路测试）：闲置轮报 AccessDenied。
        "rds:DescribeCertificates",
        "rds:ListTagsForResource",
        "elasticache:DescribeCacheClusters",
        "elasticache:DescribeReplicationGroups",
        "elasticache:DescribeEvents",
        "elasticache:ListTagsForResource",
        // 🔴 **内存类判定的分母。** `freeable_memory_pct` /
        //    `database_memory_usage_pct` 都是「占实例规格的百分比」
        //    （R2.1.2），分母来自 `ec2:DescribeInstanceTypes` 的
        //    `MemoryInfo.SizeInMiB`（RDS/EC 的规格名去掉 `db.` / `cache.`
        //    前缀就是 EC2 机型）。
        //
        //    缺它的表现（2026-08-25 东京实测，14 台真实资源）：
        //    `resolved memory for 0/5 instance types` → 全部 attrs 的
        //    `memory_bytes` 留 None → **内存类规则一条都不命中**，
        //    而看板上与「内存都很健康」完全无法区分。
        //    整轮巡检 `status=success` / `completeness=100%`，零错误码。
        //
        //    ⚠️ 与 `web-chat-stack.ts` 里那句「**没有** ec2:DescribeInstances」
        //    不矛盾：那条说的是**不列举 EC2 实例**（巡检不覆盖 EC2 这个服务）。
        //    这里要的是**机型规格表**，一个静态的公共目录，与账号里有什么
        //    实例无关。
        //
        //    ⚠️ 不支持资源级限定（API 要求 `*`）。只读。
        "ec2:DescribeInstanceTypes",
        // 🔴 与 `lambdaRole` 保持一致（本文件上面那份）。巡检的 region 枚举
        //    走 `ec2:DescribeRegions`（`inspection/adapters/regions.py`）。
        //
        // ⚠️ 当前链路走不到这个角色 —— `_session_for` 对**部署账号**直接
        //    `return boto3.Session()`（`target == deploy` 时不 assume）。
        //    补它是因为这两份清单该一致，而「两份该一致的清单漂移了」是这个
        //    仓库反复踩的形态：下一个照它建角色的人会缺权限，
        //    表现是整轮 `RegionDiscoveryError`（好在这个是抛的，不静默）。
        "ec2:DescribeRegions",
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
      // 🔴 部署账号 ID，**恒有值**，与 orgMode 无关。
      //
      // 与 LOCKED_ACCOUNT_ID 的区别是语义：
      //
      // ```
      // LOCKED_ACCOUNT_ID   闸门：「只允许这个账号」。orgMode 下留空 = 解锁
      // DEPLOY_ACCOUNT_ID   身份：「我自己是谁」。任何模式下都要知道
      // ```
      //
      // 巡检 executor 靠它判断「这个 task 的目标账号是不是我自己」——
      // 是则用 Lambda 自身角色，否则 AssumeRole 进成员账号
      // （见 `lambda_inspection_executor/handler._session_for`）。
      //
      // ⚠️ 第一版复用了 LOCKED_ACCOUNT_ID 做这件事，于是**恰好在 orgMode
      //    下失效**：那时它是空串，executor 判不出自己是谁，只能保守退化成
      //    单账号 —— 也就是「开了多账号模式反而不跨账号」。
      DEPLOY_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
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
        "lambda_layer/**", "lambda_layer_im/**", "cdk.out/**", ".cdk-out", ".cdk-out/**", "**/__pycache__/**",
        // ⚠️ dist/** 是一键部署（方式A）的产物目录（dist/oneclick + dist/verify，
        // 各 ~290MB 的 zip）。不排掉它，「代码资产 + 依赖层」解压后会超 Lambda 的
        // 250MB 上限，部署到一半才报 `Unzipped size must be smaller than 262144000
        // bytes`（2026-09-01 实测：ImStack 整栈回滚）。本地跑过一键构建的人才会中，
        // 极易误判成"依赖层太大"。四处 fromAsset("../") 都要有这一条。
        "dist/**",
        "platforms/**", "*.md", "mcp_server/**",
        ".hypothesis/**", ".pytest_cache/**",
        "phd_event_forwarder/**", "devops_agent_callback/**",
        // 🔴 **必须把判读 skill 放回来。** `"*.md"` 在 GLOB 模式下排除的是
        //    **所有深度**的 `.md`，不只是仓库根那几个 —— 2026-08-31 从线上
        //    Lambda 包里 unzip 出来实测：包内 `.md` 文件数 = **0**。
        //
        //    后果是 `inspection/adapters/skill_upload.py::ensure_skills()`
        //    在 Lambda 里**找不到任何 skill**，而它的约定是「从不抛」——
        //    返回一个 `skipped:` / `failed:` 字符串就过去了。于是：
        //
        //    ```
        //    CreateBacklogTask 照样成功
        //      → DA 那侧没有 inspection-cost-idle / inspection-high-load
        //      → 用**通用提示词**自由发挥
        //      → 报告照样出得来，格式大致像那么回事
        //      → 而 finding_id 分节、severity 不得改写、四档 unavailable 语义
        //        这些契约一条都没生效
        //    ```
        //
        //    从外面完全看不出来（`task_builder.py` 的注释早就写过这个形态：
        //    「两份都不加载…报告照样出，只是退化成 DA 的通用发挥」）。
        //
        // ⚠️ 放在 `"*.md"` **之后** —— GLOB 模式按顺序求值，后面的否定式胜出。
        //    放前面无效。
        // ⚠️ 只放回 `inspection/skills/`，不是所有 `.md`：仓库里那些
        //    README / 设计文档进包只是白占空间（包越大冷启越慢）。
        "!inspection/skills/**",
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

    // 与 config/llm-model-catalog.json 的 default_model 一致（2026-09-01 起为 Grok 4.6）。
    // lambda3 走 `client.converse()`（见 lambda3_health_checker/bedrock_invoker.py），
    // 而 Grok 的目录 kind 就是 `bedrock_converse` —— 协议原生对得上（换成任何
    // Converse 可调的模型都行；**不要**换成只走 Mantle Responses 的 GPT-5.6 系列）。
    lambda3.addEnvironment("BEDROCK_MODEL_ID", "global.xai.grok-4.6");
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
    // Signing Secret —— **webhook 路径专用**（IM 重构 M3）。Socket Mode 用不到它
    // （长连接由 App Token 鉴权），改成 HTTP webhook 后它是**唯一**的请求真伪凭据：
    // ingress 用它算 HMAC-SHA256 校验 `X-Slack-Signature`。
    // 与 App Token 并存而不是替换：M3 阶段 Fargate（Socket Mode）还留着做回滚目标。
    const slackSigningSecret = new secretsmanager.Secret(this, "SlackSigningSecret", {
      secretName: "notiops/slack-signing-secret",
      description: "Slack Signing Secret — HTTP webhook 请求验签（Basic Information 页）",
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

    // 这一条不是"对话默认模型"，而是 IM 侧一批**内部工具调用**的模型：意图分类 /
    // 下一步建议 / 进度卡叙述 / 案例分类 / 技能派发 / 技能编写
    // （shared/model_config.py::get_bot_model_id 的 8 个调用点）。
    //
    // 历史（留着，因为它解释了为什么这里长期落后于目录默认）：那 8 处原先都是手搓
    // Anthropic 原生 body（"anthropic_version": "bedrock-2023-05-31"）的 `invoke_model`，
    // 所以这里**必须**是 Claude —— 换任何非 Claude 模型都会 ValidationException，表现
    // 成"机器人一说话就报错"。这条约束在 2026-09-01 解除了：8 处已统一到
    // core/bot_llm.py → shared/llm_provider.py::invoke_llm（Bedrock Converse），
    // 目录里任何 Converse 可调的 Bedrock 模型都能绑，于是这里跟随目录默认改成 Grok 4.6。
    //
    // 更正一处旧注释的事实错误：这里曾写"那 8 处现在各自设了 temperature（分类器靠低温
    // 保证确定性）"—— 不实，8 处 body 里从来没有 temperature（2026-09-01 grep 实证），
    // `invoke_llm` 也没有这个参数。所以那次迁移在采样参数上是零行为变化。
    //
    // ⚠️ 仍有一条约束：只在 bedrock-mantle 上架的模型（GPT-5.6 系列）**不能**绑到这里 ——
    // `core/bot_llm.py` 恒走 Converse，不按 model_id 猜协议（猜错报
    // "model identifier is invalid"，读起来像模型不存在，归因极贵）。
    // 见 core/llm_pref_resolver.py 顶部对同一约束的说明（spec R8）。
    const agentModelIdParam = new ssm.StringParameter(this, "AgentModelIdParam", {
      parameterName: "/notiops/agent/model_id",
      stringValue: "global.xai.grok-4.6",
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

    // 只读：后端 Lambda（health checker / notifier / summarizer）需要**读** Key 注入
    // Bedrock 调用，但**不再写** —— Key 的唯一写入方是 webchat 管理页（web-chat-stack 的
    // BFF 角色持 PutSecretValue）。历史上后端也持 PutSecretValue，成了第二条写路径：
    // rds/elasticache 巡检配置页与 webchat 抢写同一个 Secret、后写覆盖先写。写入侧的
    // 路由已改为拒绝（api/routes/*_health_check.py），这里同步撤掉 IAM 写权限，双保险
    // （R6.6）。
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: "BedrockApiKeySecretAccess",
      actions: ["secretsmanager:GetSecretValue"],
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
    // ─── Operator App（Web App）的角色 ───
    //
    // 🔴 **角色名跟随 main（`notiops-agent-webapp-…`）。**
    //    本分支曾把它改成 `notiops-agent-operator-…` —— 那是一次没有理由的分叉：
    //    这个角色本身是 main 的 `fb560db` 引入的，改名不带来任何功能。
    //    2026-09-03 第二轮合并时收敛回 main：
    //      · 留着它，每轮合并都要在这里冲突一次；
    //      · 更要紧的是这条分支并回 main 时会把**所有** main 系部署一起改名，
    //        而改名 = 改 space 的 operatorAppRoleArn = 下面那次整栈回滚的形态。
    //    收敛的代价只落在本分支的验证账号上（一次性迁移，见下面 A/B 两条出路）。
    //
    // 🔴 不配 `operatorApp` 的后果（2026-08-27 实测）：
    //    `https://<spaceId>.aidevops.global.app.aws/investigation/<taskId>`
    //    返回 **Invalid or unregistered domain** —— 那个子域名只有在 space 配了
    //    OperatorApp 之后才被注册。而我们在**四个地方**往客户面前放这条链接：
    //      core/devops_agent.py                             聊天回复里的「查看进度」
    //      shared/report_delivery/{feishu,slack}_sender.py   IM 推送正文
    //      core/support_logic.py                            support case 的 operator_url
    //    也就是说不开 Web App 等于在每一条推送里放一个死链。
    //
    // ⚠️ 与 `primaryRole` 是**两件事**（官方文档的分工）：
    //      primaryRole       DA 服务 AssumeRole 进来**读资源**
    //      operatorAppRole   **人**在 web app 里能做什么（发起调查/看结果/开 case）
    //

    // Operator App(web app)角色：免掉控制台上「Agent Space → Access →
    // Operator access → Configure web app」那一次手点。没点过的话
    // `https://<spaceId>.aidevops.global.app.aws` 域名不存在，CreateBacklogTask /
    // CreateChat 一律报 `Invalid or unregistered domain`，深度调查/直连/DevOps 对话/
    // 发布 Skill 四样全废。形状照控制台自己建的那个角色(两个账号各取一份核对过)：
    //   · `sts:TagSession` 不能省 —— AIDevOpsOperatorAppAccessPolicy 的资源写成
    //     `agentspace/${aws:PrincipalTag/AgentSpaceId}`，靠 session tag 授权。
    //   · `ArnLike .../agentspace/*` 而不是精确 ARN —— 后者会让角色与 space 互相
    //     引用，CFN 判循环依赖。收口靠 aws:SourceAccount，与下面 primaryRole 同一套。
    // ⚠️ 老部署逃生口。space 已存在、且 web app 当初是**在控制台手点**开的时候，
    // 模板里 `operatorApp` 从「没有」变成「有」→ CFN 走 update handler 去 Enable 一次
    // → 服务侧直接拒：`Operator App with IAM configuration to AgentSpace with
    // agentSpaceId <id> is already enabled. Disable it first or use a different auth
    // flow.`（2026-09-01 在一个已有部署的账号上实测，整栈 UPDATE_ROLLBACK —— 那一批 42 个
    // 资源的改动**一个都没落地**，所以这不是"顺带失败一个资源"，是整次部署白跑。）
    //
    // 两条出路，按「能不能停几分钟 web app」选：
    //   A. `-c operatorAppAlreadyEnabled=true` —— 本次部署**不接管** web app，
    //      控制台建的那份配置（角色 `DevOpsAgentRole-WebappAdmin-*`）继续用，
    //      域名和功能都不动。代价：web app 配置不在 CFN 里，删栈不回收；
    //      想让 CFN 接管得走 B。
    //   B. 先 `aws devops-agent disable-operator-app --agent-space-id <id> --auth-flow iam`，
    //      再部署。域名由 spaceId 派生，关掉重开**不换 URL**；但中间几分钟 web app
    //      不可用，期间 BFF 的 DevOps 直连 / 深度调查会报
    //      `Invalid or unregistered domain`。
    //      2026-09-02 在同一个账号走通了这条：停机 ~2.5 分钟（disable → 部署完
    //      95s → 服务侧 Enable 落地），space id / URL 都没变，之后 web app 配置就归
    //      CFN 管了（角色换成 `notiops-agent-webapp-<acct>`）。`--auth-flow` 是必填的，
    //      漏了报 `Auth flow must be one of iam, idc, idp`。
    //      ⚠️ 顺序很要紧：**先确认模板已就绪再 disable** —— disable 那一刻 web app 就
    //      废了，把 synth 的几分钟放在停机窗口里纯属白停。
    //      ⚠️ 控制台建的那个老角色（`DevOpsAgentRole-WebappAdmin-*`）走完 B 就没人用了，
    //      但**别顺手删** —— 它不是这个栈的资源，删它属于动生产，要单独确认。
    //
    // ⚠️⚠️ 逃生口 A 只在**重新 synth** 时有效。`cdk deploy --app <某个 cdk.out 目录>`
    // 走的是**已经 synth 好的** cloud assembly，CDK 直接读目录里的模板，
    // `-c operatorAppAlreadyEnabled=true` **会被静默忽略** —— 你以为躲开了，实际部下去
    // 的还是带 `operatorApp` 的那份模板，照样整栈回滚。要用 A 就得带着这个 -c
    // （以及**全部**其它 -c，见 DEPLOYMENT.md）重新 synth 一次。
    //
    // 新部署（space 由本栈创建）两者都不用管：create handler 一把开好，默认即 false。
    const operatorAppAlreadyEnabled =
      String(this.node.tryGetContext("operatorAppAlreadyEnabled") ?? "").toLowerCase() === "true";

    const operatorAppRole = operatorAppAlreadyEnabled ? undefined : new iam.Role(this, "DevOpsAgentOperatorAppRole", {
      roleName: `notiops-agent-webapp-${cdk.Aws.ACCOUNT_ID}`,
      assumedBy: new iam.ServicePrincipal("aidevops.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": cdk.Aws.ACCOUNT_ID },
          ArnLike: {
            "aws:SourceArn": `arn:aws:aidevops:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agentspace/*`,
          },
        },
      }).withSessionTags(),   // ← 这就是那条 sts:TagSession（等价于手写 addStatements）
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AIDevOpsOperatorAppAccessPolicy"),
      ],
      description: "Assumed by humans in the DevOps Agent web app",
    });

    const agentSpace = new devopsAgentModule.CfnAgentSpace(this, "DevOpsAgentSpace", {
      name: `notiops-devops-${cdk.Aws.ACCOUNT_ID}`,
      description: "NotiOps - auto-created by CDK for the deploy account",
      // 建 space 时一并开好 web app：CFN 的 create handler 替我们调
      // aidevops:EnableOperatorApp，delete handler 调 DisableOperatorApp。
      // 只走 `iam` 认证流（BFF 是 SigV4 直连）；IdC / IdP 留给客户自己选。
      //
      // ⚠️ **老部署升级到本版本**（space 已存在、且当初是在控制台手点开的 web app）：
      // 这条属性从「没有」变成「有」会让 CFN 去 Enable 一次，服务侧报 already enabled
      // 并回滚整栈 —— 已实测。逃生口 `-c operatorAppAlreadyEnabled=true` 见上面
      // operatorAppRole 处的长注释（含 A/B 两条出路的取舍）。
      ...(operatorAppRole ? { operatorApp: { iam: { operatorAppRoleArn: operatorAppRole.roleArn } } } : {}),
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

    // ─── 巡检专用 Agent Space（第二个）───────────────────────────────────────
    // 为什么要第二个而不是共用上面那个（见 spec R12.5c）：
    //   ① 并发配额是 **per agent space**（Concurrent investigations = 3）。实测一次并发
    //      发 6 条 → 恰好 3 IN_PROGRESS + 3 PENDING_START，配额是执行调度上的限制。
    //      巡检批量派发会占满 3 个位 → 客户此刻点「深度调查」要排在巡检后面，
    //      界面上就是卡着不动。后台批处理不该抢占前台交互。
    //   ② skill 是 **per agent space** 的（全部 Asset API 都必填 agentSpaceId）。
    //      巡检的两份判读 skill 待在这里，碰不到排障 space —— 否则客户的排障调查
    //      可能误加载它们（实测 skill 激活是 description 语义匹配，命中并不精确），
    //      或被它们的 skip criteria 跳过（Investigation Skipped）。
    //   ③ 事件里的 detail.metadata.agent_space_id 直接成为「这是巡检」的判据，
    //      不必依赖我们自己预注册 DDB 行成功（那条路一旦写失败是完全静默的）。
    // 成本：credits 是**账号级**的（GetAccountUsage → monthlyAccountInvestigationHours），
    // 拆两个 space 不多花钱也不多给额度，只是把并发拆开。
    //
    // ⚠️ 命名 SHALL NOT 用 `notiops-devops-${account}` —— core/devops_agent.py 的
    // _discover_space() 把那个名字当 preferred 匹配用，撞名会让排障调查的 space
    // 选择变歧义（且选错没有任何信号）。
    // 🔴 `locale` **必须显式设**，而且要与 executor 的
    //    `INSPECTION_REPORT_LOCALE` 同源。
    //
    //    2026-08-25 实测：两个 space 的 locale 都是 `None`（从没设过），
    //    判读之所以出中文，靠的是 skill 里那句
    //    `Answer in locale; default to Chinese` —— 也就是**在对抗服务默认值**。
    //    哪天 skill 被改坏、或者 DA 更严格地遵守 space 级设置，输出就变英文，
    //    而这**不会报错**：客户只会看到判读突然变成英文。
    //
    //    取值格式实测确认是 `"zh"`（`UpdateAgentSpace` 接受它，
    //    `zh_CN` / `zh-CN` 都没试到就成功了，所以只知道 `zh` 可用）。
    //
    // ⚠️ **排障 space 刻意不设 locale**（下面那个 `agentSpace` 与
    //    `member-devops-agent.yaml` 的都不设）。排障是**交互式**的：
    //    web chat 按 `body.locale`（当前用户的 UI 语言）组装，英文用户提问
    //    就该拿英文回答。给 space 钉死一个语言可能覆盖那个 per-request 行为。
    //    巡检相反 —— 它是批处理，一条判读推给多个人，语言必须是全局的。
    const inspectionAgentSpace = new devopsAgentModule.CfnAgentSpace(
      this, "InspectionAgentSpace", {
        name: `notiops-inspection-${cdk.Aws.ACCOUNT_ID}`,
        description: "NotiOps resource inspection - isolated from incident RCA space",
        locale: inspectionReportLocale,
        // 与排障 space 共用同一个操作员角色（信任策略里 agentspace/* 通配）。
        // ⚠️ 巡检 space 也要开：判读结论里的深链指向的是**这个** space，
        //    不开的话那些链接和排障那边一样是死的。
        //
        // 🔴 与排障 space 一样走 `operatorAppRole ? … : {}` —— `operatorAppRole`
        //    在 `-c operatorAppAlreadyEnabled=true` 时是 **undefined**
        //    （见上面那个逃生口）。原来这里是无条件 `operatorAppRole.roleArn`，
        //    那是本分支加巡检 space 时抄的排障 space 的**旧形态**，而 main 后来
        //    给排障那边加了守卫、巡检这边没跟上（2026-09-03 第二轮合并时补的）。
        //    不补的话开着逃生口部署就是 TypeError，整个 synth 失败。
        ...(operatorAppRole
          ? { operatorApp: { iam: { operatorAppRoleArn: operatorAppRole.roleArn } } }
          : {}),
      });
    this.inspectionAgentSpaceId = inspectionAgentSpace.attrAgentSpaceId;

    // 复用同一个 primaryRole：巡检与排障读的是同一个账号的同一批资源，
    // 权限需求完全相同（AIDevOpsAgentAccessPolicy 只读）。再建一个角色只会多一份要维护的东西。
    const inspectionAssociation = new devopsAgentModule.CfnAssociation(
      this, "InspectionAgentSpaceAssociation", {
        agentSpaceId: inspectionAgentSpace.attrAgentSpaceId,
        serviceId: "aws",
        configuration: {
          aws: {
            accountId: cdk.Aws.ACCOUNT_ID,
            accountType: "monitor",
            assumableRoleArn: primaryRole.roleArn,
          },
        },
      });
    inspectionAssociation.node.addDependency(inspectionAgentSpace);
    inspectionAssociation.node.addDependency(primaryRole);

    // 两个 agent space 的 ARN —— trigger role 的授权范围。
    const agentSpaceArns = [
      agentSpace.attrArn,
      inspectionAgentSpace.attrArn,
    ].filter((a): a is string => Boolean(a));

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
        // ── 巡检需要的四个（R12.5c / R13.13a，方案丙）──
        // 上传两份判读 skill（Asset API，assetType=skill）。
        // ⚠️ 没有 ListAssets 就无法查重 → 每次上传都 Create → 同一个 skill
        //    在 space 里堆出多份，DA 可能加载到旧的那份。
        "aidevops:CreateAsset",
        "aidevops:UpdateAsset",
        "aidevops:ListAssets",
        // 读任务终态做对账兜底（事件丢失时按 status 核实，R13.13a）；
        // 也是涓流派发数「在飞条数」的依据（R12.5b：IN_PROGRESS + PENDING_START）。
        "aidevops:GetBacklogTask",
        "aidevops:ListBacklogTasks",
      ],
      // ⚠️ 两个 agent space 的 ARN 都要授权。
      // 原来只有 `[agentSpace.attrArn || <通配兜底>]` —— 而 `attrArn` 是 CDK token，
      // **恒为真值**，所以那个 `||` 兜底永远不生效。漏掉巡检 space 的 ARN
      // 会让对它的每次调用直接 AccessDenied，且错误发生在派发时而不是部署时。
      // 兜底放在数组为空时（而不是逐项 ||）—— 逐项写的话 filter 掉全部后会得到
      // 空 resources，那是非法的 IAM 语句。
      resources: agentSpaceArns.length > 0
        ? agentSpaceArns
        : [`arn:aws:aidevops:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agentspace/*`],
    }));

    // 🔴 巡检的两个 Lambda 直连 DevOps Agent，用的是**共享 lambdaRole**，
    // 不是上面那个 triggerRole。
    //
    // 部署账号本身走「直连 + 自己的角色」是既有惯例（见
    // `core/devops_agent.py` 的 `is_deploy` 分支：`boto3.client("devops-agent")`
    // 不 AssumeRole）。而 `lambdaRole` 此前**只有** ListJournalRecords /
    // GetJournalRecord —— 于是：
    //
    //   执行器 `da.create_backlog_task(...)`   → AccessDenied
    //   而调用点是 `except Exception: logger.exception(...); continue`
    //   → `dispatched_tasks = 0`，run 状态仍然是 **success**
    //   → 看板上只显示「另有 N 项未做根因分析」
    //
    // 也就是说部署下去之后**判读一条都派不出去，且没有任何报错信号**。
    // 这两条权限是巡检能工作的前提，不是优化。
    //
    // ⚠️ 这里原来只有 `CreateBacklogTask` / `GetBacklogTask` 两个动作，注释写着
    //    「`CreateAsset` / `UpdateAsset` 是 setup.sh 用操作者凭证跑
    //     `scripts/upload_inspection_skills.py` 时用的，不该进 Lambda 角色」。
    //
    // 🔴 那句话在 2026-08-30 就**过期**了：`2a574b8` 把 skill 下发搬进了
    //    Lambda（`skill_upload.ensure_skills()`，在每次派发前跑），
    //    理由是那个函数此前**生产零调用点** —— skill 从来没被下发过。
    //    但那次**只搬了实现，没搬权限**。
    //
    //    2026-08-31 实机踩到（客户点了「深入分析」等不到结果）：
    //
    //    ```
    //    ensure_skills → aidevops:ListAssets   AccessDenied
    //                  → aidevops:CreateAsset  AccessDenied
    //                  → 2/2 份 skill 上传失败
    //                  → 「继续派发」（设计如此，skill 失败不该让判读整个没有）
    //                  → DA 那侧没有 inspection-cost-idle
    //                  → 用**通用调查格式**回答（598 字符的 JSON，
    //                    还去读了它自己的 memory 而不是我们给的载荷）
    //                  → 切不出 `## <finding_id>` → da_parse_status=parse_failed
    //                  → 界面上：一直等，而额度已经花了
    //    ```
    //
    //    整条链每一步都按设计工作（`ensure_skills` 从不抛、失败不阻断、
    //    callback 保留原文并标 parse_failed），所以**完全静默**。
    //
    // ⚠️ `DeleteAsset` 不给：`ensure_skills` 只做 create/update
    //    （`find_existing_asset_id` → 有就 update、没有就 create）。
    //    给了它就等于让一个自动化路径能删掉客户 space 里别的 asset。
    // ⚠️ `ListBacklogTasks` 等 R12.5b 的涓流派发实现了再加。
    lambdaRole.addToPolicy(new iam.PolicyStatement({
      sid: "InspectionDevOpsAgentDispatch",
      actions: [
        // 执行器派发判读任务。
        "aidevops:CreateBacklogTask",
        // 对账 Lambda 核实终态（R13.13a）。
        "aidevops:GetBacklogTask",
        // 判读 skill 的自动下发（`skill_upload.ensure_skills()`）。
        // ⚠️ 三个都要：`ListAssets` 用来判「这份 skill 已经在里面了吗」，
        //    缺了它会退化成「每次直接 Create」→ 同一份 skill 在 space 里
        //    堆出多份，而 DA 匹配到哪一份不确定。
        "aidevops:ListAssets",
        "aidevops:CreateAsset",
        "aidevops:UpdateAsset",
        // 🔴 上传后的**回验**（`skill_upload.py:464` 的 `_asset_exists`）。
        //    那段注释逐字写着「拿到 asset_id 不等于 space 里真有这份 skill」——
        //    create 返回 200 而 asset 之后不存在的情况实测过（幂等 token 撞车）。
        //
        //    缺这个权限的表现（2026-08-31 实机日志）：
        //    「skill 回验跳过（GetAsset 失败，可能缺 devops-agent:GetAsset 权限）」
        //    ⇒ 上传照样报成功，而**回验这道防线是空的** —— 传上去一份被截断
        //      或压根不存在的 skill 也看不出来，然后判读静默退化成通用发挥。
        "aidevops:GetAsset",
      ],
      resources: agentSpaceArns.length > 0
        ? agentSpaceArns
        : [`arn:aws:aidevops:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agentspace/*`],
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
                # 资源巡检专用 space（与上面那个隔离，见 spec R12.5c）。
                # 新字段而非把 agent_space_id 改成 list —— 后者有 20+ 个标量读取点。
                'inspect_agent_space_id': os.environ['INSPECT_AGENT_SPACE_ID'],
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
        INSPECT_AGENT_SPACE_ID: inspectionAgentSpace.attrAgentSpaceId,
        TRIGGER_ROLE_ARN: triggerRole.roleArn,
        DEPLOY_REGION: cdk.Aws.REGION,
      },
      timeout: cdk.Duration.seconds(30),
    });
    configTable.grantWriteData(onboardFn);
    onboardFn.node.addDependency(agentSpace);
    onboardFn.node.addDependency(inspectionAgentSpace);
    onboardFn.node.addDependency(triggerRole);

    new cdk.CustomResource(this, "AutoOnboardResource", {
      serviceToken: onboardFn.functionArn,
      properties: {
        triggerRoleArn: triggerRole.roleArn,
        agentSpaceId: agentSpace.attrAgentSpaceId,
        inspectionAgentSpaceId: inspectionAgentSpace.attrAgentSpaceId,
        // 每次部署都变 → CustomResource 每次都重跑,自愈补写 da# 记录。
        // 修复:配置表若被删/重建(如 SpringClean),静态 property 会让 CFN 判定"无变化"
        // 而不重跑,导致 da# 上车记录永久丢失 → IM 端派发报"未上车"。put_item 整条覆盖、
        // 幂等,且这条是 auto 管理记录(account_alias="deploy-account (auto)"),重写无害。
        timestamp: Date.now().toString(),
      },
    });

    // ⚠️ **这个 OutputKey 的含义 SHALL NOT 改** —— setup.sh:1062 读它
    // (`jq .NotiOpsBackendStack.AgentSpaceId`) 回填成 agent runtime 的
    // `DEVOPS_AGENT_SPACE_ID`，那是**排障**调查用的 space。指向改了会让 IM 侧的
    // 深度调查被静默路由到巡检 space。巡检的 id 走下面那个**新** output。
    new cdk.CfnOutput(this, "AgentSpaceId", {
      value: agentSpace.attrAgentSpaceId,
      description: "DevOps Agent Space ID (部署账号, 自动创建) — 排障根因调查用",
    });

    new cdk.CfnOutput(this, "InspectionAgentSpaceId", {
      value: inspectionAgentSpace.attrAgentSpaceId,
      description: "DevOps Agent Space ID — 资源巡检专用（与排障隔离，见 spec R12.5c）",
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

    // ─── Custom Event Bus 的资源策略（改动②，2026-08-29 重写）───
    //
    // 判据从「你是哪个账号」换成「你是不是我们模板建出来的转发角色 + 事件是不是
    // DA 服务署名的」。
    //
    // 🔴 **为什么要换掉原来那个白名单。** 原来是
    //    `StringEquals aws:PrincipalAccount ∈ <CDK context 的常量列表>`，
    //    而那个列表由 setup.sh 用 `-c` 传进来、**烧进 CFN 模板**。于是接入一个
    //    子账号的代价是「改 setup.sh 的变量 → 重跑 ./setup.sh → CDK 更新整个
    //    NotiOpsBackendStack（Lambda/DDB/API GW/CloudFront）」。在几十个账号的
    //    量级上不可接受。现在加账号**零部署**：客户的栈建出那个角色就能投递。
    //
    // 🔴 **原来还有个 `length > 0` 门控** —— 白名单为空就整条策略不创建。
    //    实测 2026-08-29：生产总线的 `Policy` 就是 `None`（从来没配过白名单），
    //    也就是说跨账号事件回传**一直是死的**，而 UI 上照样能 onboard。
    //    现在策略恒创建。
    //
    // ⚠️ 三个 Condition 各自不可省：
    //
    //  ① ArnLike aws:PrincipalArn —— **必须是 iam 形态**，不是 sts。
    //     IAM 官方：「For IAM roles, the request context returns the ARN of the
    //     role」「Do not specify the assumed role session ARN as a value for this
    //     condition key」。写 sts:assumed-role 形态**永不匹配**，而不匹配的表现
    //     是事件静默不到（零错误码）。
    //     实测确认（scripts/probe_arnlike_bus_policy.py）：iam 到、sts 不到。
    //     partition 用 ${AWS::Partition} 而不是 `arn:*:` —— 跨 partition 根本投
    //     不到，通配零收益；而硬写 `arn:aws:` 会让中国区部署直接失效。
    //
    //  ② events:source == "aws.aidevops" —— 这一条**是真边界**。
    //     `aws.` 是保留前缀：实测 PutEvents(Source="aws.aidevops") 直接返回
    //     NotAuthorizedForSourceException「Not authorized for the source.」
    //     （该错误码不在 PutEvents 的官方错误表里，只能实测出来）。
    //     ⇒ 攻击者伪造不出这个 source；而服务产生的保留前缀 source **能**被
    //       跨账号转发（同一份实测的 C 段用 aws.events 验过）。
    //     残留面只剩「转发他自己账号里真实产生的 aws.aidevops 事件」，那种事件
    //     的顶层 account 是他自己的（服务盖章），callback 的账号校验会拒。
    //
    //  ③ Null events:source = "false" —— 防空集为真。
    //     EventBridge UG 明写 `ForAllValues` 不配 `Null` 检查时，缺键会在空集上
    //     求值并返回 true，「A principal can therefore bypass the intended source
    //     restriction」。
    //
    // ⚠️ Principal 只能是 `{ AWS: "*" }` —— Principal 元素不支持部分通配
    //    （官方：「You cannot use a wildcard to match part of a principal name
    //    or ARN」），收紧只能靠 Condition。
    //
    // ⚠️ 角色名必须与两份成员模板里的一致：
    //    member-account-onboarding.yaml 的 notiops-devops-forwarder-role-<账号>，
    //    以及改动① 要往 member-devops-agent.yaml 加的那个（带 -m<系统账号> 后缀）。
    //    通配 `-*` 同时覆盖两种形态。
    new events.CfnEventBusPolicy(this, "DevOpsAgentEventBusPolicy", {
      eventBusName: devopsEventBus.eventBusName,
      statementId: "AllowNotiOpsForwarderRolesPutAidevopsEvents",
      statement: {
        Effect: "Allow",
        Principal: { AWS: "*" },
        Action: "events:PutEvents",
        Resource: devopsEventBus.eventBusArn,
        Condition: {
          ArnLike: {
            "aws:PrincipalArn":
              `arn:${cdk.Aws.PARTITION}:iam::*:role/notiops-devops-forwarder-role-*`,
          },
          "ForAllValues:StringEquals": { "events:source": "aws.aidevops" },
          Null: { "events:source": "false" },
          // 🔴 **不加 `aws:PrincipalOrgID`。这一条我加过又撤回了，理由记在这里。**
          //
          //    2026-08-30 上午按 review 建议加了它（「orgMode 下追加保留是可以
          //    不降的降级」）。当天下午另一轮 review 抓出：**它把整个功能的核心
          //    场景堵死了。**
          //
          //    这四个 Condition 在**同一条语句**里 ⇒ AND。而：
          //
          //    ```
          //    部署账号是组织管理账号 → setup.sh 自动置 ORG_MODE=true（无交互）
          //    「手动接入」存在的**全部理由**就是**组织外**账号
          //      （partner-resold 多 payer：客户没有 payer 权限，
          //        organizations:ListAccounts AccessDenied，StackSets 不可用）
          //    ⇒ 那些账号的 PrincipalOrgID 必然对不上 ⇒ 事件 100% 到不了
          //    ⇒ 转发角色建了、规则建了、总线 ARN 预填对了，零错误码
          //    ```
          //
          //    实测确认：拟部署账号在 o-ddddeeeeff，要手动接入的那个成员
          //    账号在 o-aaaabbbbcc —— 两个不同的 org，正是这个形态。
          //
          // ⚠️ 拆成两条语句（一条给 org 内、一条给组织外）也没有意义：
          //    组织外那条必然是 `ArnLike + source`，而它是 org 内那条的超集
          //    ⇒ 等价于不加。
          //
          // ⚠️ 所以残留面是**设计接受**的，不是遗漏：外部人猜到总线 ARN
          //    （`arn:aws:events:<区>:<部署账号>:event-bus/notiops-devops-events`，
          //    名字是硬编码常量）+ 在自己账号建一个 `notiops-devops-forwarder-role-*`
          //    的角色，就能把他账号里**真实产生**的 aws.aidevops 事件转过来。
          //    伪造不了（`PutEvents` 拒 `aws.` 保留前缀，实测；⚠️ 该行为
          //    **AWS 未文档化**，且依赖大小写敏感 —— `AWS.aidevops` 能过
          //    PutEvents，只是过不了下面这条 `StringEquals` 与规则的 pattern）。
          //    callback 的 step 2 会拒未登记账号，代价上限是一次 Lambda invoke。
          //    ⚠️ 那条通道**仍然没有告警** —— 见 §五 的「已知未处理」。
        },
      },
    });

    new cdk.CfnOutput(this, "DevOpsAgentBusPolicyJudgement", {
      // 值保持纯 ASCII：它会被 setup.sh 用 jq 取出后直接 echo，含中文/em-dash
      // 会在部分终端显示为乱码。中文说明放 description。
      value:
        "ArnLike aws:PrincipalArn arn:<partition>:iam::*:role/"
        + "notiops-devops-forwarder-role-* AND events:source=aws.aidevops",
      description:
        "Custom Event Bus 的跨账号 PutEvents 判据。加账号无需重新部署 —— "
        + "客户栈建出该名字的转发角色即可投递（原来的账号白名单已废弃）",
    });

    // ═══════════════════════════════════════════════════════════════════
    // 资源巡检（spec resource-inspection，Phase 5）
    // ═══════════════════════════════════════════════════════════════════
    //
    //   EventBridge (rate 15 min) ──► 调度器 Lambda
    //                                    │  读定时配置（DDB，不是每客户一条 Rule）
    //                                    │  抢 run 锁 → 快照配置 → 查额度
    //                                    ▼
    //                                 SQS ──► 执行 Lambda ──► DLQ
    //
    // ⚠️ 为什么不给每个客户建 Rule：老系统把 cron 写死在 CDK 里（下面那 5 条
    //    DailyXxxRule），客户改巡检时间必须改代码重新部署。代价是调度粒度
    //    = 15 分钟，所以 UI 必须把可选时刻限制成 15 分钟整数倍。

    // ─── 巡检任务队列 + DLQ ───
    // ⚠️ 两个队列都没显式写 `encryption` —— CDK 默认就是 SSE-SQS
    //    （见 aws-cdk-lib.aws_sqs 文档「By default queues are encrypted using
    //    SSE-SQS」）。所以 synth 产物里看不到 SqsManagedSseEnabled 不是漏配，
    //    而是服务端默认值。`enforceSSL` 管的是**传输中**（Deny 非 TLS 请求），
    //    与静态加密是两件事，两个都要。
    const inspectionDlq = new sqs.Queue(this, "InspectionDlq", {
      queueName: "notiops-inspection-dlq",
      // 14 天 = SQS 上限。DLQ 里的消息是要人来看的，短了会在假期后消失。
      retentionPeriod: cdk.Duration.days(14),
      enforceSSL: true,
    });

    const inspectionQueue = new sqs.Queue(this, "InspectionQueue", {
      queueName: "notiops-inspection-tasks",
      // ⚠️ visibilityTimeout 必须 ≥ 执行 Lambda 的 timeout（这里 15 分钟）。
      //    小于它会让还在跑的消息重新可见 → 同一账号被并发巡检两次。
      //    真正的互斥靠 DDB 条件写的 run 锁，但那时第二次会白跑一遍
      //    GetMetricData（有费用）才被拒。
      visibilityTimeout: cdk.Duration.minutes(16),
      retentionPeriod: cdk.Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: {
        queue: inspectionDlq,
        // 3 次：一次瞬时限流能自愈，真正的坏消息 3 次后进 DLQ 不无限重放。
        maxReceiveCount: 3,
      },
    });
    inspectionQueue.grantSendMessages(lambdaRole);
    inspectionQueue.grantConsumeMessages(lambdaRole);

    // ─── 调度器 Lambda ───
    const logGroupInspectionScheduler = createLogGroup(
      "LogGroupInspectionScheduler",
      "notiops-inspection-scheduler",
    );
    const inspectionSchedulerLambda = new lambda.Function(
      this,
      "InspectionSchedulerLambda",
      {
        functionName: "notiops-inspection-scheduler",
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: "lambda_inspection_scheduler.handler.handler",
        code: lambdaCode,
        logGroup: logGroupInspectionScheduler,
        role: lambdaRole,
        // 只做「读配置 → 抢锁 → 发消息」，不拉指标。60 秒足够 100 个账号。
        timeout: cdk.Duration.seconds(120),
        memorySize: 256,
        layers: [depsLayer],
        environment: {
          ...lambdaEnv,
          INSPECTION_TABLE: inspectionTable.tableName,
          INSPECTION_QUEUE_URL: inspectionQueue.queueUrl,
          // 排障 space + 巡检 space 都要，pace 必须跨两个求和（R12.5c）：
          // CloudWatch 的维度是 AgentSpaceUUID，一个 space 一条曲线，
          // 而 credits 是账号级的。只读一个会系统性低估 pace。
          DEVOPS_AGENT_SPACE_ID: agentSpace.attrAgentSpaceId,
          INSPECT_AGENT_SPACE_ID: inspectionAgentSpace.attrAgentSpaceId,
          // 月度 DA 判读额度上限（秒）。R12.2 的**分母**。
          //
          // 🔴 缺省 `-1` = 「上限未知」。那时 `BudgetState.used_ratio` 恒为 0、
          // tier 恒为 NORMAL（即**不启用预算护栏**），且打点侧不发
          // `DaQuotaUsedRatio` —— P3 那条 Alarm 会停在 INSUFFICIENT_DATA，
          // 明示「额度没有被监控」而不是假装健康。
          //
          // ⚠️ 之前这个 env **压根没设**，于是 `_env("MONTHLY_LIMIT_SECONDS","-1")`
          // 恒取兜底值 —— 预算护栏在所有部署里都是关着的，而没有任何信号说明
          // 这一点。Phase 0 的 0.4b（额度的权威读法）有结论后应改为自动填。
          MONTHLY_LIMIT_SECONDS: String(
            this.node.tryGetContext("monthlyLimitSeconds") ?? "-1"),
        },
        description:
          "资源巡检调度器 — 每 15 分钟判定该跑哪些 (类型 × 账号)，抢锁后 fan-out 到 SQS",
      },
    );

    // ─── 一条 Rule 管全部客户（R11.1a）───
    new events.Rule(this, "InspectionSchedulerRule", {
      ruleName: "notiops-inspection-scheduler",
      description:
        "资源巡检调度器 — 每 15 分钟一次；具体时刻存 DDB，改时间不需要重新部署",
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(inspectionSchedulerLambda)],
    });

    // ─── 执行 Lambda（SQS 消费者）───
    const logGroupInspectionExecutor = createLogGroup(
      "LogGroupInspectionExecutor",
      "notiops-inspection-executor",
    );
    const inspectionExecutorLambda = new lambda.Function(
      this,
      "InspectionExecutorLambda",
      {
        functionName: "notiops-inspection-executor",
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: "lambda_inspection_executor.handler.handler",
        code: lambdaCode,
        logGroup: logGroupInspectionExecutor,
        role: lambdaRole,
        // 15 分钟：一轮要拉 GetMetricData（400/批、并发 8）+ DescribeEvents +
        // 判定 + 落库。⚠️ 必须 < 队列的 visibilityTimeout(16 分钟)，
        // 否则还在跑的消息会重新可见 → 同账号被并发巡检。
        timeout: cdk.Duration.minutes(15),
        // 1024 MB：Lambda 的 CPU 配额随内存线性增长，而这个函数是
        // 并发 8 路 HTTP + JSON 解析，CPU 是瓶颈而非内存。
        memorySize: 1024,
        layers: [depsLayer],
        environment: {
          ...lambdaEnv,
          INSPECTION_TABLE: inspectionTable.tableName,
          DEVOPS_AGENT_SPACE_ID: agentSpace.attrAgentSpaceId,
          INSPECT_AGENT_SPACE_ID: inspectionAgentSpace.attrAgentSpaceId,
          // 🔴 DA 判读**正文**的语言（R11b.10）。随载荷下发，
          // skill 照它输出。此前没设，一直吃 `judge_findings(locale="zh")`
          // 的默认值 —— 对当前客户恰好是对的，但那是巧合。
          // ⚠️ 不复用 `DEFAULT_LOCALE`：那个在 report_delivery/push_handler
          // 里的兜底是 "en"，共用会把巡检报告拖成英文。
          // ⚠️ 推送外壳的语言是**另一层**，由每个投递目标的 `locale` 决定
          // （判读一条一份、多个 chat 共享，按目标定必然出现
          //  「外壳中文、正文英文」的混合卡片）。
          // ⚠️ 与巡检 space 的 `locale` **同一个值**（见那里的说明）。
          //    两处各写一遍 tryGetContext 会漂移 —— 那时 space 说英文、
          //    payload 说中文，而判读听哪个不确定。
          INSPECTION_REPORT_LOCALE: inspectionReportLocale,
        },
        description: "资源巡检执行器 — 采集指标、跑判定、落 finding",
      },
    );

    inspectionExecutorLambda.addEventSource(
      new lambdaEventSources.SqsEventSource(inspectionQueue, {
        // ⚠️ batchSize=1。一条消息 = 一个账号一整轮巡检（最长 15 分钟），
        //    批量取多条只会让第一条之后的全部超时。
        batchSize: 1,
        // ★ 必须开。不开的话「函数抛异常」会让**整批**重新可见 ——
        //   包括已经跑完的消息，那意味着重复付 GetMetricData、重复派 DA 调查。
        //   handler 侧对应地返回 {batchItemFailures: [{itemIdentifier: id}]}。
        //   ⚠️ 官方文档明列：键名写错 / 值为空串 / 值指向不存在的 messageId
        //   都会让整批被判失败，所以 handler 那侧有专门的测试钉住形状。
        reportBatchItemFailures: true,
        // 同一时刻最多 3 个账号在跑。取 3 而不是更多：DA 的 custom agent
        // 并发是 1，派再多也只是排队，而排队会让客户的交互式深度调查等在后面。
        maxConcurrency: 3,
      }),
    );

    new cdk.CfnOutput(this, "InspectionQueueUrl", {
      value: inspectionQueue.queueUrl,
      description: "巡检任务队列 URL",
    });

    // ─── 对账 Lambda（每小时；R13.13）───
    //
    // ⚠️ 设计写的是「扩展既有对账 Lambda（不新建）」，**那个前提是错的**：
    // 本仓没有对账 Lambda。全部 EventBridge Rule 都是每日 cron 或事件驱动，
    // 没有任何 `rate(1 hour)`；`devops_agent_callback` 是纯事件驱动、无定时。
    // 早期设计里画的「对账 Lambda（每小时，扩展既有实现）」指向一个不存在
    // 的组件。⇒ 这里新建。
    //
    // 它做两件事：
    //   ① 已派发但判读没回来的 task → GetBacklogTask 核实（补事件丢失）
    //   ② 今天该跑的账号有没有 run 行 / 跑了的完整度够不够
    // 两者都**只判定不重投** —— 按墙钟时长判死会开正反馈，见
    // `inspection/domain/dispatch_recon.py` 的模块 docstring。
    const logGroupInspectionReconciler = createLogGroup(
      "LogGroupInspectionReconciler",
      "notiops-inspection-reconciler",
    );
    const inspectionReconcilerLambda = new lambda.Function(
      this,
      "InspectionReconcilerLambda",
      {
        functionName: "notiops-inspection-reconciler",
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: "lambda_inspection_reconciler.handler.handler",
        code: lambdaCode,
        logGroup: logGroupInspectionReconciler,
        role: lambdaRole,
        // 只做「Query → GetBacklogTask → UpdateItem」，不拉指标、不跑判定。
        // 上界由 handler 里的 MAX_PROBES_PER_RUN 控制（200 次 probe）。
        timeout: cdk.Duration.minutes(5),
        memorySize: 256,
        layers: [depsLayer],
        environment: {
          ...lambdaEnv,
          INSPECTION_TABLE: inspectionTable.tableName,
          // 派发映射行里通常带 agent_space_id；这个 env 是兜底
          // （老行没有那个字段时用它）。
          INSPECT_AGENT_SPACE_ID: inspectionAgentSpace.attrAgentSpaceId,
          // 🔴 补齐重投要往队列发消息（R13.15）。没有它对账
          // 只检测不补齐 —— handler 会记一条 warning 说明这一点，
          // 而不是静默（否则「为什么缺口一直在」查不到「补齐压根没配」）。
          INSPECTION_QUEUE_URL: inspectionQueue.queueUrl,
        },
        description:
          "资源巡检对账 — 每小时核实已派发判读的终态，并检查采集覆盖缺口",
      },
    );

    new events.Rule(this, "InspectionReconcilerRule", {
      ruleName: "notiops-inspection-reconciler",
      description:
        "资源巡检对账 — 每小时一次；补 EventBridge 事件丢失 + 查采集缺口",
      // ⚠️ 每小时，不是每天。改成每天会让「判读回不来」最长晚一天才被发现，
      // 而巡检报告是当天要交付的。
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      targets: [new targets.LambdaFunction(inspectionReconcilerLambda)],
    });

    // ─── 推送 Lambda（每 15 分钟；R11b.1~R11b.10）───
    //
    // 🔴 **独立于巡检的 cron，不是巡检跑完顺手发**（R11b.6）。挂在巡检末尾
    // 的话推送时刻 = 巡检完成时刻，而那是配置好的凌晨批处理时间；更麻烦的是
    // 巡检是逐账号 fan-out（一账号一条 SQS 消息），顺手发意味着 50 个账号
    // 发 50 次，而 R11b.3 的模型是「一个 chat 一份摘要」。
    //
    // ⚠️ Rule 是 15 分钟一次，**真正的时段窗口在代码里判**
    // （`inspection/domain/push_policy.in_push_window`，默认工作日 03:00 UTC
    // = 北京 11:00，即巡检默认时刻 02:00 UTC 之后一小时）。与调度器同思路：
    // cron 粗、判定细 —— 让客户改推送时间不需要重新部署。
    //
    // ⚠️ `WEB_BASE_URL` 空着**不是错误**：没配就不放深链（R11b.7 的链接会
    // 被省掉），照 `bff/web-chat/devops_investigate.mjs` 对
    // REPORTS_CDN_DOMAIN 的处理。它取 WebChat 前端的 CloudFront 域名，
    // 而那个 distribution 在**另一个 stack**（WebChatStack）里 ——
    // 走 context 而不是跨栈引用，避免给共享后端栈加一条部署顺序依赖。
    const logGroupInspectionPush = createLogGroup(
      "LogGroupInspectionPush",
      "notiops-inspection-push",
    );
    const inspectionWebBaseUrl =
      (this.node.tryGetContext("webBaseUrl") as string | undefined) ?? "";
    if (!inspectionWebBaseUrl) {
      cdk.Annotations.of(this).addInfo(
        "巡检推送未配置 webBaseUrl —— 推送正文里不会有「查看详情 / 查看全部」深链。" +
        "部署完 WebChatStack 后用 -c webBaseUrl=<ChatUrl 输出值> 重新部署即可补上。",
      );
    }
    const inspectionPushLambda = new lambda.Function(
      this,
      "InspectionPushLambda",
      {
        functionName: "notiops-inspection-push",
        runtime: lambda.Runtime.PYTHON_3_14,
        handler: "lambda_inspection_push.handler.handler",
        code: lambdaCode,
        logGroup: logGroupInspectionPush,
        role: lambdaRole,
        // 只做「Query → 拼 markdown → 调 IM API」，不拉指标、不跑判定。
        // 逐账号一次 Query finding + 一次 Query 推送状态。
        timeout: cdk.Duration.minutes(5),
        memorySize: 512,
        layers: [depsLayer],
        environment: {
          ...lambdaEnv,
          INSPECTION_TABLE: inspectionTable.tableName,
          WEB_BASE_URL: inspectionWebBaseUrl,
          // 三个 platform sender 各自从 Secrets Manager 读凭证；
          // 名字与 DevOpsCallbackLambda 那一份保持一致，否则
          // `is_configured()` 返回 false → 整平台静默不投。
          // ⚠️ 飞书传 **ARN**、Slack 传 **name** —— 这不是笔误，
          //    `slack_sender.py` 把这个 env 的值直接当 SecretId 用，而
          //    BotStack 传给 bot 容器的也是 name，契约统一在 name 上。
          //    照抄成 secretArn 不会报错（GetSecretValue 两者都吃），
          //    但会与 BotStack 分叉。
          FEISHU_SECRET_ARN: feishuSecret.secretArn,
          SLACK_BOT_TOKEN_ARN: slackBotTokenSecret.secretName,
        },
        description:
          "资源巡检推送 — 工作日按时段窗口把当日变化投递给各 IM 群（分级节奏 + 退避重推）",
      },
    );

    new events.Rule(this, "InspectionPushRule", {
      ruleName: "notiops-inspection-push",
      description:
        "资源巡检推送 — 每 15 分钟检查是否进入推送时段窗口（默认工作日 03:00 UTC）",
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(inspectionPushLambda)],
    });

    // ═══════════════════════════════════════════════════════════════════
    // 巡检告警（R11c.2 / R11c.3）
    // ═══════════════════════════════════════════════════════════════════
    //
    // 数据源是 EMF：`inspection/adapters/metrics.py` 往 stdout 写一行合规 JSON，
    // CloudWatch 自动抽取。所以这些 Alarm **不需要** PutMetricData 权限。
    //
    // ⚠️ 下面每个 `new cloudwatch.Metric` 都**不带 dimensionsMap** ——
    // 它匹配的是打点侧那个**空 DimensionSet** 生成的指标（跨 run_type 聚合）。
    // 打点侧一旦把空集删掉，这些 Alarm 全部查不到数据点 → 假绿灯。
    // 那一条由 `tests/test_inspection_observability.py` 的断言守住。
    //
    // 🔴 命名前缀 `notiops-inspection-` 不是装饰：客户推送规则靠它排除我们的
    // 运维告警（见下面 OPS_ALARM_NAME_PREFIX 的使用处）。改前缀等于把运维
    // 告警推给客户。

    const OPS_ALARM_NAME_PREFIX = "notiops-inspection-";
    const INSPECTION_METRIC_NAMESPACE = "NotiOps/Inspection";

    // ── ops 告警通道：**必须**独立于客户推送通道（R11c.2）──
    //
    // 🔴 为什么不复用 `notiops-alerts`（上面那个 snsTopic）：
    //   ① 它的 displayName 是「闲置资源告警」，语义上是客户面的；
    //   ② 它的 publish 权限已经给了共享的 `lambdaRole`，任何采集 Lambda 都能发；
    //   ③ 它的 ARN 在 `lambdaEnv` 里对**所有** Lambda 可见。
    // 运维告警混进去，客户就会收到我们的内部故障 —— R11c.2 明确禁止。
    //
    // ⚠️ 这个 topic 的 ARN **刻意不放进 `lambdaEnv`**。那个 env 块被每个采集
    // Lambda 共享，放进去等于把「谁能往运维通道发东西」重新变成所有人。
    const opsAlertTopic = new sns.Topic(this, "InspectionOpsAlertTopic", {
      topicName: "notiops-inspection-ops-alerts",
      displayName: "巡检运维告警（内部，勿转客户）",
    });

    // 收件人由部署方决定：`-c opsAlertEmail=sre@example.com`。
    // ⚠️ 不填也要建 topic —— Alarm 必须有 action，否则它只在控制台变红，
    // 而「没人看控制台」正是 R11c.3 存在的原因。不填时至少 topic 在，
    // 事后订阅一下即可，不用重新部署。
    const opsAlertEmail = this.node.tryGetContext("opsAlertEmail") as string | undefined;
    if (opsAlertEmail) {
      opsAlertTopic.addSubscription(new subscriptions.EmailSubscription(opsAlertEmail));
    } else {
      cdk.Annotations.of(this).addInfo(
        "巡检运维告警 topic 已创建但无订阅者 —— 告警只会在控制台变红。" +
        "传 -c opsAlertEmail=<邮箱> 或事后手动订阅 notiops-inspection-ops-alerts。",
      );
    }

    const opsAction = new cwActions.SnsAction(opsAlertTopic);

    /** 建一条巡检指标。**不带维度** —— 见上面的说明。 */
    const inspMetric = (metricName: string, statistic: string,
                        period: cdk.Duration) =>
      new cloudwatch.Metric({
        namespace: INSPECTION_METRIC_NAMESPACE,
        metricName,
        statistic,
        period,
      });

    const mkAlarm = (
      id: string, name: string,
      props: Omit<cloudwatch.AlarmProps, "alarmName">,
    ) => {
      const a = new cloudwatch.Alarm(this, id, {
        alarmName: `${OPS_ALARM_NAME_PREFIX}${name}`,
        ...props,
      });
      a.addAlarmAction(opsAction);
      // OK 也通知：只在 ALARM 时通知会让「恢复了没有」只能靠人去看控制台，
      // 而值班的人需要知道事情结束了。
      a.addOkAction(opsAction);
      return a;
    };

    // ── P1：连续 2 天全账号失败（含「压根没跑」）──
    //
    // 判据是「成功数 < 1」而不是「失败数 > 0」：后者在部分账号成功时也会响，
    // 而那是 P2 的职责（completeness）。
    //
    // 🔴 `treatMissingData: BREACHING` 是刻意的。巡检整体停摆（调度器挂了 /
    // kill switch 被拉了 / EventBridge 规则被删）时**一个数据点都不会有**，
    // 而那正是这条告警最该抓的形态。用 NOT_BREACHING 会让「彻底没跑」显示成绿的。
    //
    // ⚠️ 代价要知道：**全新部署在还没登记任何账号时这条会红**（没有 run →
    // 无数据 → BREACHING）。这是有意的取舍 —— 第一天一次误报，
    // 换「永远不会静默」。topic 默认无订阅者，所以不会真的吵到人。
    mkAlarm("InspectionAllAccountsFailedAlarm", "all-accounts-failed", {
      alarmDescription:
        "P1 连续 2 天没有任何一轮巡检成功（全账号失败，或调度整体停摆）。" +
        "排查顺序：kill switch(appconfig#inspection/enabled) → 调度器日志 → SQS DLQ。",
      metric: inspMetric("RunSucceeded", "Sum", cdk.Duration.days(1)),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    // ── P1：run success 但零产出 ──
    //
    // 判据在打点侧（`observability.signals_from_stats`）：success + 评估过实例
    // + `series_written == 0`。**不是**「零 finding」—— 后者可能是真健康。
    mkAlarm("InspectionZeroOutputAlarm", "zero-output", {
      alarmDescription:
        "P1 有 run 报告 success 但一条指标序列都没写入 —— 典型成因是指标名/维度写错" +
        "（GetMetricData 返回 200 空数据点，批次不算失败，于是 status 是绿的）。",
      metric: inspMetric("RunZeroOutput", "Sum", cdk.Duration.days(1)),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // 没跑不是这条的职责（上面那条管），所以缺数据按不违规处理。
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── P2：单账号 completeness < 95% ──
    //
    // ⚠️ 用 `Minimum` 而不是 `Average`：平均值会把一个 60% 的账号
    // 稀释进十个 100% 里，于是「有账号采集不全」永远不响。
    // 这也是为什么 account_id **不需要**进维度（那会造出 N 条曲线）。
    mkAlarm("InspectionLowCompletenessAlarm", "low-completeness", {
      alarmDescription:
        "P2 至少有一个账号本轮采集完整度低于 95%。看板「巡检总览」的 run 表" +
        "可以定位到具体账号；EMF 行里的 account_id 字段亦可用 Logs Insights 查。",
      metric: inspMetric("Completeness", "Minimum", cdk.Duration.days(1)),
      threshold: 95,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── P2：派发失败率 > 10% ──
    //
    // ⚠️ 打点侧对 `dry_run` 轮**不发**这个指标：预演刻意「照常算、不真发」，
    // built>0 而 dispatched==0 → 失败率 100%。灰度第 ① 段每天都在做预演，
    // 不豁免就是每天误报一次。
    mkAlarm("InspectionDispatchFailureAlarm", "dispatch-failure-ratio", {
      alarmDescription:
        "P2 CreateBacklogTask 派发失败率超过 10%。看 executor 日志里的" +
        "「派发 task 失败」；额度耗尽走的是另一条路径（不算失败，走 skipped_by_gate）。",
      metric: inspMetric("DispatchFailureRatio", "Maximum", cdk.Duration.days(1)),
      threshold: 10,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── P2：派发出去但没落映射（R11c.3 之外**额外加的一条**）──
    //
    // 为什么值得单独一条：这不是「没发出去」，而是**发出去了、额度花了、
    // 判读永久回不来**。它与派发失败的处置完全不同 ——
    // 前者要查响应解析，后者要查 API/额度。合进上面那条会让两种成因
    // 在告警上无法区分，而看板已经把它单独标红了（dispatch_gap）。
    mkAlarm("InspectionDispatchUnmappedAlarm", "dispatch-unmapped", {
      alarmDescription:
        "P2 有判读任务已派发但未能记录 taskId → 那些分析结果永久无法回填，" +
        "而额度已经消耗。查 executor 日志「派发成功但响应里没有 taskId」。",
      metric: inspMetric("DispatchUnmapped", "Sum", cdk.Duration.days(1)),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // ── P3：DA 额度 > 80% ──
    //
    // 🔴 `treatMissingData: MISSING` 是这条的关键，不是随手选的。
    //
    // 打点侧在 `MONTHLY_LIMIT_SECONDS <= 0`（= 当前所有部署的状态，
    // 因为 Phase 0 的 0.4b「额度的权威读法」还没结论）时**不发**这个指标。
    // 那时：
    //   · NOT_BREACHING → 显示 OK  ← **假绿灯**，我们压根没在监控额度
    //   · BREACHING     → 显示 ALARM ← 天天红，两周后没人看
    //   · MISSING       → INSUFFICIENT_DATA ← 「我们不知道」，视觉上与另两者都不同
    // 见 https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html
    //
    // 想让它真正工作：`-c monthlyLimitSeconds=<秒>`（见调度器 env）。
    mkAlarm("InspectionDaQuotaAlarm", "da-quota-high", {
      alarmDescription:
        "P3 本月 DA 判读额度已用超 80%。停在 INSUFFICIENT_DATA 表示额度上限未配置" +
        "（-c monthlyLimitSeconds=…），那时额度完全没有被监控。",
      metric: inspMetric("DaQuotaUsedRatio", "Maximum", cdk.Duration.hours(1)),
      threshold: 80,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });

    // ─── 对账兜底的两条告警（2026-08-30 补）───
    //
    // 🔴 在此之前那 6 条告警**一条都不看** probe_failed / no_mapping /
    //    da_target_unresolved。而对账是「判读结果回不来」时的唯一兜底 ——
    //    它自己坏掉了没有任何人会发现，因为它的既有约定就是
    //    「拿不到状态什么都不做」（那是刻意的：按墙钟判死重投会形成正反馈）。
    mkAlarm("InspectionReconDaTargetAlarm", "recon-da-target-unresolved", {
      alarmDescription:
        "P2 有账号的判读目标解析不出来（缺 inspect_agent_space_id / "
        + "AssumeRole 失败），那些账号的对账兜底整条不工作。"
        + "去管理页看那一行有没有「待更新栈」徽章，或点「测试连接」看 AWS 原话。",
      // ⚠️ 指标名写**字面量**（与本文件其余 8 条一致）。一致性由
      //    `scripts/test_inspection_infra_wired.py` 的那条元断言守着：
      //    「每个 CDK 指标名都必须在发射器的 ALL_METRICS 里」。
      metric: inspMetric("ReconcileDaTargetUnresolved", "Maximum",
                         cdk.Duration.hours(1)),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // ⚠️ 缺数据当正常：对账每小时一轮，没有账号解析失败时这个指标是 0 而不是
      //    不发射（emit_reconcile 把映射里的键全打出去）—— 但对账整轮没跑时
      //    确实缺数据，那种情况由 zero-output 那条盖。
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    mkAlarm("InspectionReconProbeFailedAlarm", "recon-probe-failed", {
      alarmDescription:
        "P2 对账 probe 失败（GetBacklogTask 拿不到状态）。"
        + "⚠️ 本模块刻意「拿不到状态什么都不做」（按墙钟判死重投会形成正反馈："
        + "队列更长→更多被判死→额度烧光且永不收敛），所以这条告警是唯一信号。"
        + "常见原因：space id 错、跨账号 region 错、DA API 限流。",
      metric: inspMetric("ReconcileProbeFailed", "Sum",
                         cdk.Duration.hours(1)),
      // ⚠️ 阈值不是 0：偶发一次限流不值得叫人。连续一小时 >3 条才是真问题。
      threshold: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cdk.CfnOutput(this, "InspectionOpsAlertTopicArn", {
      value: opsAlertTopic.topicArn,
      description:
        "巡检运维告警 SNS Topic ARN（内部通道，勿订阅到客户群）",
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
        "lambda_layer/**", "lambda_layer_im/**", "cdk.out/**", ".cdk-out", ".cdk-out/**", "**/__pycache__/**",
        "dist/**",   // 见上面 lambdaCode 处的长注释：漏了会撞 Lambda 250MB 解压上限
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
      // 🔴 **函数级 DLQ**（2026-08-29 实测补上）。
      //
      //    实测：`AsyncEventsReceived (76) == Invocations (76)` ——
      //    EventBridge 对这个函数的每一次调用都是**异步**的。于是：
      //
      //      EventBridge 的 retryAttempts:2 + 那个 callbackDlq
      //        → 只兜「**投不进去**」（Invoke 拿不到 202）
      //      函数内抛异常
      //        → Lambda 自己异步重试 2 次 → **丢弃**，落点为 None
      //
      //    也就是说 `handler` docstring 里那句「顶层不吞异常 …让 EventBridge
      //    重试 → DLQ」**在函数抛异常这条路上不成立**：事件被静默丢掉。
      //    而 `_inspect_space_ids()` 选择「读 DDB 失败就抛」的理由正是
      //    「抛 → DLQ → 可重投（可逆）」—— 那个理由靠这一行才成立。
      //
      // ⚠️ 复用同一个 `callbackDlq`：两类失败（投不进去 / 函数抛）落同一个队列，
      //    排查时只有一个地方要看。CDK 会自动给函数角色补 sqs:SendMessage。
      deadLetterQueue: callbackDlq,
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
        // 巡检表 —— callback 要把判读文本按 finding_id 回拼到 finding 行
        // （R9.6）。权限走 lambdaRole，第 318 行已 grant。
        //
        // ⚠️ 不注入的后果是**静默的**：全部巡检判读永久回不来，
        // 现象是「finding 旁边总是空的」，而那与「DA 说这条没问题」
        // 在看板上长得一样。handler 侧对空值记 ERROR 兜住。
        INSPECTION_TABLE: inspectionTable.tableName,
        // 巡检 space id —— callback 靠它区分「这次调查是巡检的还是排障的」
        // （R12.5d）。两类事件走**同一个** callback：
        // EventBridge 规则只按 source + detail-type 匹配，没有 space 维度。
        //
        // ⚠️ 不注入的后果是**静默的**：`callback_route.route_of()` 判据恒为空 →
        // 全部按排障处理 → 巡检判读事件白跑一次 Bedrock 摘要 + 写一条没有
        // 消费者的 progress 行，而且「CDK 没重新部署」会表现成
        // 「巡检 callback 从来没触发过」。domain 侧对空值记 ERROR 兜住这点。
        INSPECT_AGENT_SPACE_ID: inspectionAgentSpace.attrAgentSpaceId,
      },
      description:
        "DevOps Agent 调查结果回调 — Custom Event Bus 触发，AssumeRole 拉摘要 → Bedrock 精简 → 入 DDB",
    });

    // LITELLM Secret env
    devopsCallbackLambda.addEnvironment(
      "LITELLM_CONFIG_SECRET_ARN",
      liteLlmConfigSecret.secretName,
    );

    // ─── callback 的两条告警（2026-08-29 补）───
    //
    // 🔴 在此之前 callback 这条链路**一条告警都没有**：那 6 条巡检告警全挂在
    //    `NotiOps/Inspection` 自定义指标上，没有 log metric filter、没有函数
    //    Errors 告警、也没有 DLQ 深度告警。于是所有「记 ERROR 然后继续」和
    //    「抛出去」的处置都只存在于日志流里，没有人会发现。
    //
    // ⚠️ `AsyncEventsDropped` 是这类丢弃**唯一**会留下的痕迹（实测确认
    //    EventBridge 对这个函数是异步调用：AsyncEventsReceived == Invocations）。
    //    加了函数级 DLQ 之后正常情况下它应该恒为 0 —— 非 0 意味着连 DLQ 都没写进去。
    mkAlarm("DevOpsCallbackAsyncDroppedAlarm", "callback-async-dropped", {
      alarmDescription:
        "P1 DevOps Agent callback 有异步事件被丢弃（连 DLQ 都没落）。"
        + "每一条都是一次判读结果永久丢失：巡检那边表现为 finding 旁边一直是空的，"
        + "排障那边表现为调查跑完了但卡片不来。",
      metric: new cloudwatch.Metric({
        namespace: "AWS/Lambda",
        metricName: "AsyncEventsDropped",
        dimensionsMap: { FunctionName: "notiops-devops-callback" },
        statistic: "Sum",
        period: cdk.Duration.minutes(5),
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      // ⚠️ 没有丢弃时这个指标**不发射**，所以缺数据必须当「正常」——
      //    当 BREACHING 会让告警长期红着，值班的人很快就学会忽略它。
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    mkAlarm("DevOpsCallbackDlqAlarm", "callback-dlq-nonempty", {
      alarmDescription:
        "P1 DevOps Agent callback 的 DLQ 里有消息。函数抛异常（Lambda 异步重试 "
        + "2 次后落 DLQ）或 EventBridge 投递失败都会到这里。"
        + "⚠️ 保留期 14 天 —— 过了就没了，要在那之前重投。",
      metric: callbackDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: "Maximum",
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

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
          // R13.13b：官方语义是「matched skip criteria defined in
          // a skill」，而巡检自己上传两份判读 skill → 这条路径**真实可达**。
          // 少了它，SKIPPED 只能等对账 Lambda 每小时一次去 GetBacklogTask 才
          // 发现 —— 在那之前 finding 上一直显示「判读缺失（原因未知）」。
          //
          // ⚠️ 判据取自官方文档的 10 个 detail-type，**不是** EventBridge
          // schema registry。实测 registry 里**没有** InvestigationSkipped
          // （2026-07 查 ap-northeast-1 与 us-east-1 都只有 9 个 Investigation
          // schema）—— registry 滞后于文档。本文件上方那句「判据:schema
          // registry 里存在该 schema」对新事件类型不可靠。
          "Investigation Skipped",
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
          // R13.13b：官方语义是「matched skip criteria defined in
          // a skill」，而巡检自己上传两份判读 skill → 这条路径**真实可达**。
          // 少了它，SKIPPED 只能等对账 Lambda 每小时一次去 GetBacklogTask 才
          // 发现 —— 在那之前 finding 上一直显示「判读缺失（原因未知）」。
          //
          // ⚠️ 判据取自官方文档的 10 个 detail-type，**不是** EventBridge
          // schema registry。实测 registry 里**没有** InvestigationSkipped
          // （2026-07 查 ap-northeast-1 与 us-east-1 都只有 9 个 Investigation
          // schema）—— registry 滞后于文档。本文件上方那句「判据:schema
          // registry 里存在该 schema」对新事件类型不可靠。
          "Investigation Skipped",
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
      }, {
        // 客户 CUR 仪表盘的当天缓存（cube/es/sp 超 DDB 400KB 单条上限，只能落 S3）。
        // key 带日期、次日自然失效，但对象不会自己消失 —— 每天 4 个 panel × ~数 MB，
        // 不清理就是一年几 GB 的纯垃圾。3 天而不是 1 天：给"翻看前两天缓存"留余量。
        id: "expire-cur-dash-cache-3d",
        prefix: "cur-dash-cache/",
        expiration: cdk.Duration.days(3),
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
        "lambda_layer/**", "lambda_layer_im/**", "cdk.out/**", ".cdk-out", ".cdk-out/**", "**/__pycache__/**",
        "dist/**",   // 见上面 lambdaCode 处的长注释：漏了会撞 Lambda 250MB 解压上限
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

    // 🔴 R11c.2：客户通道**必须**排除我们自己的运维告警。
    //
    // 我们在同一个账号同一个区建了 6 条 `notiops-inspection-*` Alarm。它们的
    // 状态变更发出的正是 `aws.cloudwatch` / `CloudWatch Alarm State Change`
    // 事件 —— 与下面这条规则的 pattern **逐字匹配**，于是默认就会被捞走推给
    // 客户。R11c.2 明确禁止：「客户不应收到我们的运维告警」。
    //
    // ⚠️ 光换 SNS topic 不够。Alarm 的 EventBridge 事件与 alarmActions 是两条
    // 独立的投递路径，换 topic 只管住后者。
    //
    // 判据用 `anything-but` + `prefix`（EventBridge 支持，见
    // https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-pattern-operators.html ）
    // 而不是把客户的告警名逐个列白名单 —— 后者要求我们预先知道客户建了什么告警。
    const excludeOwnOpsAlarms = {
      alarmName: [{ "anything-but": { prefix: OPS_ALARM_NAME_PREFIX } }],
    };

    for (const src of pushRuleSources) {
      const isAlarmSource = src.source === "aws.cloudwatch";
      new events.Rule(this, `PushRule${src.id}`, {
        ruleName: `notiops-push-${src.id.toLowerCase()}`,
        eventPattern: {
          source: [src.source],
          detailType: [src.detailType],
          ...(isAlarmSource ? { detail: excludeOwnOpsAlarms } : {}),
        },
        targets: [new targets.LambdaFunction(pushLambda)],
        enabled: false, // 默认 DISABLED,需在控制台或 CDK context 启用
      });
    }

    // ─── Web Chat 通知收件箱(主动观察 push → web 端持久化收件箱)───
    // 与 IM push 复用同一 core.push_event normalizer,但 sink 是写 notiops-web-chat
    // 表的 notif# 段(账号级共享收件箱),不自动发起调查。
    // web chat 页面 60s 轮询 BFF 拿增量;离线时事件仍在库里,进来即可回顾。
    // 日志组显式建、由本栈管:否则 Lambda 服务会自己建一个 `/aws/lambda/<函数名>`,
    // 那个组**不属于任何栈** —— 永不过期(白留日志费),删栈也不消失,而且方式 A 的模板
    // 里同名日志组是栈内资源,于是同一账号里跑过 setup.sh 之后一键部署会在
    // NAME_CONFLICT_VALIDATION 上整栈失败(2026-08-28 实测)。给了 logGroup,CDK 会
    // 写 LoggingConfig,函数只往这个组里写,不再自建同名组。
    const webNotifLogs = new logs.LogGroup(this, "WebNotifHandlerLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const webNotifLambda = new lambda.Function(this, "WebNotifHandlerLambda", {
      ...commonLambdaProps,
      functionName: WEB_NOTIF_FUNCTION_NAME,
      logGroup: webNotifLogs,
      handler: WEB_NOTIF_HANDLER,
      code: pushLambdaCode, // 与 IM push 同一份 asset(含 core/)
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: { ...lambdaEnv, ...webNotifEnv(WEB_CHAT_TABLE_NAME) },
      description: WEB_NOTIF_FUNCTION_DESCRIPTION,
    } as lambda.FunctionProps);

    // 授权写 notiops-web-chat 表(表在 WebChatStack;用固定名拼 ARN,避免跨 stack 依赖)。
    webNotifLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:PutItem"],
      resources: [`arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${WEB_CHAT_TABLE_NAME}`],
    }));

    // Web 通知的 EventBridge 规则。事件源那张表在
    // `infra/lib/constructs/web-notif-sources.ts` —— **一键部署（方式 A）import 的是同一份**，
    // 别把它抄回这里（抄一份 = 以后加源只在一条路径上生效，而症状是静默的）。
    //
    // 这条路径独有的是「开关方式」：合成期 `-c webNotif<Id>=on|off`。
    // 方式 A 的静态模板没有 context，它的开关是 EventBridge 控制台上 Enable/Disable
    // 那条规则（同名同源，见那份共享模块的文件头）。
    //
    // globalOnly 的那两个是**全局服务**，只在 us-east-1 发 EventBridge 事件
    // (TA 见 https://docs.aws.amazon.com/awssupport/latest/user/cloudwatch-events-ta.html;
    //  Cost Anomaly 事件的 region = 其 home region,通常 us-east-1)。
    // 部署在别的 region 时规则建了也永不触发,所以下面会 addWarning 明确告知,
    // 而不是让用户以为"开了就有"。
    for (const src of WEB_NOTIF_SOURCES) {
      const override = this.node.tryGetContext(`webNotif${src.id}`) as string | undefined;
      const enabled = override ? override === "on" : src.on;
      // 🔴 R11c.2：排除我们自己的 `notiops-inspection-*` 运维告警。
      //
      // 这条比 IM push 那条更要紧 —— CloudWatchAlarm 在本清单里是
      // **默认开启**（`on: true`），而 sink 是客户的 web 通知收件箱。
      // 不排除的表现是：巡检一出运维故障，客户的收件箱里就多一条
      // 「notiops-inspection-zero-output 进入 ALARM」——
      // 那是我们的内部缺陷，客户既看不懂也无法处置。
      const isAlarmSource = src.source === "aws.cloudwatch";
      const rule = new events.Rule(this, `WebNotifRule${src.id}`, {
        // 规则名与描述走 `web-notif-sources.ts` 的两个函数（main 抽出去的）——
        // 一键部署那条路（standalone 单栈）要复用同一套命名，各写一遍会漂。
        ruleName: webNotifRuleName(src.id),
        description: webNotifRuleDescription(src),
        eventPattern: {
          source: [src.source],
          detailType: [src.detailType],
          // 🔴 R11c.2：排除**我们自己**的 `notiops-inspection-*` 运维告警。
          //    不排的话巡检自己的告警会当成客户的事件推给客户 ——
          //    而「没人看控制台」正是 R11c.3 存在的原因。
          ...(isAlarmSource ? { detail: excludeOwnOpsAlarms } : {}),
        },
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
          "lambda_layer/**", "lambda_layer_im/**", "cdk.out/**", ".cdk-out", ".cdk-out/**", "**/__pycache__/**",
        "dist/**",   // 见上面 lambdaCode 处的长注释：漏了会撞 Lambda 250MB 解压上限
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
          // MODEL_ID 现在只是**兜底**：真值走 DDB appconfig#phd（Admin「后端任务模型」写入，
          // 由 BFF 从模型目录解析 alias 后投影过去）。保留 env 是为了 DDB 不可用 / 未 seed
          // 时仍能推送，见 shared/phd_config.py 的三级降级。
          MODEL_ID: "global.xai.grok-4.6",
          CONFIG_TABLE: configTable.tableName,
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
          // Global CRIS（`global.*` inference profile）授权时呈现的是 region 段为空的
          // foundation-model ARN；上面那条里的 `*` 理论上能匹配空段，但判断错的后果是
          // 生产全部 Bedrock 调用 AccessDenied，故显式写出。
          // 见 https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-prereq.html
          "arn:aws:bedrock:::foundation-model/*",
          `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        ],
      }));

      bedrockApiKeySecret.grantRead(phdLambda);
      feishuSecret.grantRead(phdLambda);

      // 只读 notiops-config：取 appconfig#phd / SK=bedrock_model_id（Admin 配的翻译模型）。
      // PHD Lambda 用的是自己的 role（不是共享 lambdaRole），所以这条必须单独授予。
      // 只需读 —— 这张表的写入方是 BFF 与 API Lambda。
      configTable.grantReadData(phdLambda);

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
    new cdk.CfnOutput(this, "SlackSigningSecretArn", {
      value: slackSigningSecret.secretArn,
      description: "Slack Signing Secret ARN — HTTP webhook 验签（IM 重构 M3）",
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
