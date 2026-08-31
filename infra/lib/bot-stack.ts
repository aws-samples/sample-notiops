import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as ssm from "aws-cdk-lib/aws-ssm";

export interface BotStackProps extends cdk.StackProps {
  metricsTableName: string;
  configTableName: string;
  conversationsTableName: string;
  skillsBucketName: string;
  enabledPlatforms?: string[];
}

export class BotStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BotStackProps) {
    super(scope, id, props);

    // 多账号(Organizations)模式：-c organizationId=o-xxxx 时不锁定账号
    // （解锁 shared/account_scope.py 闸门）。见 notiops-backend-stack.ts 同名说明。
    const orgMode = ((this.node.tryGetContext("organizationId") as string | undefined)?.trim() || "").length > 0;
    const lockedAccountId = orgMode ? "" : cdk.Aws.ACCOUNT_ID;

    const enabledPlatforms = props.enabledPlatforms
      ?? (this.node.tryGetContext("enabledPlatforms") as string || "feishu")
          .split(",").map((s: string) => s.trim().toLowerCase());

    // Minimal VPC (public subnets only, no NAT)
    const vpc = new ec2.Vpc(this, "BotVpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      ],
    });

    const cluster = new ecs.Cluster(this, "BotCluster", { vpc });

    // ─── MCP sidecar helper ─────────────────────────────────────────
    // Each bot task ships with two MCP sidecars (pricing on :8001,
    // cost on :8003) so general_qa / chitchat can ground LLM answers
    // in real AWS pricing + cost-explorer data without leaving the
    // task. Containers in the same Fargate task share a network
    // namespace, so the bot reaches them via 127.0.0.1 — no cross-
    // task discovery / SG / DNS rules needed.
    //
    // Resource sizing: each sidecar is a Python FastMCP server
    // (~80MB pricing, ~120MB cost), bot itself ~150MB. Bumped task
    // size 256→512 CPU / 512→1024 MB to leave headroom under load.
    const addMcpSidecars = (td: ecs.FargateTaskDefinition,
                             label: string): void => {
      // Build context = the sidecar directory itself (contains both
      // Dockerfile and entrypoint.py). Using the repo root as context
      // breaks the `COPY entrypoint.py` line in each sidecar
      // Dockerfile because entrypoint.py is relative to the Dockerfile
      // dir, not the build context.
      td.addContainer(`${label}McpPricing`, {
        image: ecs.ContainerImage.fromAsset("../sidecars/aws-pricing-mcp", {
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
        essential: false,  // bot stays alive if sidecar crashes
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: `${label.toLowerCase()}-mcp-pricing` }),
        environment: {
          AWS_REGION: cdk.Aws.REGION,
          FASTMCP_HOST: "127.0.0.1",
          FASTMCP_PORT: "8001",
        },
      });
      td.addContainer(`${label}McpCost`, {
        image: ecs.ContainerImage.fromAsset("../sidecars/aws-cost-mcp", {
          platform: ecr_assets.Platform.LINUX_AMD64,
        }),
        essential: false,
        logging: ecs.LogDrivers.awsLogs({ streamPrefix: `${label.toLowerCase()}-mcp-cost` }),
        environment: {
          AWS_REGION: cdk.Aws.REGION,
          FASTMCP_HOST: "127.0.0.1",
          FASTMCP_PORT: "8003",
        },
      });
    };

    // Each task role needs read-only access to AWS Pricing + Cost
    // Explorer + Compute Optimizer + Budgets so the sidecars can
    // serve the LLM's tool calls. Centralized here to keep all 3
    // task roles in lockstep.
    const grantMcpReadOnly = (taskRole: iam.IRole): void => {
      taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
        // pricing-mcp: AWS Price List Query API
        actions: [
          "pricing:DescribeServices",
          "pricing:GetAttributeValues",
          "pricing:GetProducts",
          "pricing:ListPriceLists",
          "pricing:GetPriceListFileUrl",
        ],
        resources: ["*"],
      }));
      taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
        // cost-mcp: cost-explorer / budgets / compute-optimizer /
        // cost-optimization-hub (ReadOnly subset). Resources are "*"
        // because all of these APIs are account-scoped, not
        // resource-scoped.
        actions: [
          "ce:Describe*", "ce:Get*", "ce:List*",
          "budgets:Describe*", "budgets:View*",
          "compute-optimizer:Describe*", "compute-optimizer:Get*",
          "cost-optimization-hub:GetPreferences",
          "cost-optimization-hub:GetRecommendation",
          "cost-optimization-hub:ListEnrollmentStatuses",
          "cost-optimization-hub:ListRecommendations",
          "cost-optimization-hub:ListRecommendationSummaries",
          "freetier:GetFreeTierUsage",
          "savingsplans:Describe*", "savingsplans:List*",
        ],
        resources: ["*"],
      }));
    };

    // Task definition for Feishu bot
    const taskDef = new ecs.FargateTaskDefinition(this, "FeishuBotTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    taskDef.addContainer("app", {
      image: ecs.ContainerImage.fromAsset("../", {
        file: "platforms/feishu/Dockerfile",
        platform: ecr_assets.Platform.LINUX_AMD64,
      }),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "feishu-bot" }),
      environment: {
        AWS_REGION: cdk.Aws.REGION,
        BEDROCK_REGION: cdk.Aws.REGION,
        DEVOPS_AGENT_REGION: cdk.Aws.REGION,
        AGENTIC_CHAT_MODE: "enabled",
        AWS_MCP_MODE: "docs_only",
        CONVERSATIONS_TABLE: props.conversationsTableName,
        METRICS_TABLE: props.metricsTableName,
        CONFIG_TABLE: props.configTableName,
        FEISHU_SECRET_NAME: "notiops/im-bot-feishu",
        DEFAULT_INVESTIGATION_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        LOCKED_ACCOUNT_ID: lockedAccountId,
        SKILLS_BUCKET: props.skillsBucketName,
        SKILL_DISPATCH_ENABLED: "false",  // 暂时隐藏:调查时不自动弹 skill 选择卡(用户要求);/skills 显式管理不受影响。恢复改回 "true"。
        // MCP sidecars run on these ports in the same task; default
        // values match `core/aws_pricing_mcp.py` + `core/aws_cost_mcp.py`,
        // set explicitly here for clarity.
        AWS_PRICING_MCP_ENDPOINT: "http://127.0.0.1:8001/mcp",
        AWS_COST_MCP_ENDPOINT: "http://127.0.0.1:8003/mcp",
        // Per-sidecar enable flags — default OFF in code (so a deploy
        // without sidecars doesn't surface broken tools to the LLM).
        // We ship sidecars by default, so flip these ON.
        AWS_MCP_PRICING_ENABLED: "true",
        AWS_MCP_COST_ENABLED: "true",
      },
    });
    addMcpSidecars(taskDef, "Feishu");

    // ECS Service
    new ecs.FargateService(this, "FeishuBotService", {
      cluster,
      taskDefinition: taskDef,
      desiredCount: enabledPlatforms.includes("feishu") ? 1 : 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Grant DDB access
    const role = taskDef.taskRole;
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      // 最小权限：bot 只做 item 级读写 + Query（不需要 DeleteTable/UpdateTable 等控制面）。
      actions: [
        "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan",
        "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem",
        "dynamodb:ConditionCheckItem", "dynamodb:DescribeTable",
      ],
      resources: [
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.metricsTableName}`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.metricsTableName}/*`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.configTableName}`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.configTableName}/*`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.conversationsTableName}`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.conversationsTableName}/*`,
      ],
    }));

    // Bedrock access
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        // GPT-5.x via Bedrock Mantle Responses API. The endpoint is
        // region-addressed and may differ from the bot's runtime region,
        // so this is deliberately not narrowed by region: the admin can
        // repoint a Mantle model at any allowlisted region at runtime
        // (bff/web-chat/llm_config.mjs::MANTLE_REGIONS) without a redeploy,
        // and an IAM grant narrower than that allowlist yields a config
        // that saves but cannot be invoked.
        //
        // NOTE: an earlier version of this comment claimed Mantle "is
        // account-scoped, no resource-ARN dimension". That is wrong --
        // CreateInference takes a required `project` resource type (see
        // service-authorization/latest/reference/list_bedrock-mantle.html,
        // and the AWS managed policy AmazonBedrockMantleInferenceAccess,
        // which scopes it to arn:aws:bedrock-mantle:*:*:project/*).
        // `*` here is a deliberate width, not a forced one.
        "bedrock-mantle:CreateInference",
      ],
      resources: ["*"],
    }));

    // STS AssumeRole — create_investigation needs to AssumeRole into
    // the target account's Trigger Role (even self-account = self-assume).
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/notiops-agent-trigger-*`],
    }));

    // DevOps Agent (aidevops) — progress poller reads journal records
    // to update live investigation cards in IM. Scoped to the deploy account's
    // agent spaces. Original SAM template had the same grant.
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["aidevops:ListJournalRecords", "aidevops:GetJournalRecord"],
      resources: [`arn:aws:aidevops:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agentspace/*`],
    }));

    // AWS Support API — case management (create/list/view/reply/resolve)
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        "support:CreateCase",
        "support:DescribeCases",
        "support:DescribeCommunications",
        "support:AddCommunicationToCase",
        "support:ResolveCase",
        "support:DescribeServices",
        "support:DescribeSeverityLevels",
        "support:DescribeTrustedAdvisorChecks",
      ],
      resources: ["*"],
    }));

    // S3 — skill registry (skills/ prefix in shared bucket)
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [`arn:aws:s3:::${props.skillsBucketName}`],
      conditions: { StringLike: { "s3:prefix": ["skills/*", "skills/"] } },
    }));
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${props.skillsBucketName}/skills/*`],
    }));

    // S3 — MCP 规格快照（mcp-snapshots/ 前缀，见 core/mcp_snapshot.py）
    // 为什么 IM 侧也要：三个 MCP 模块（finops / investigation / aws_api）是**两棵树共用
    // 同一份源码**（有单元测试锁两棵树字节一致），所以 IM 容器同样会先试着
    // 读快照。没有这条授权时它会 AccessDenied → 失败安全退回"先拉起子进程"（慢但对），
    // 但每次容器启动会留下 6 条 AccessDenied，看起来像故障而其实不是。
    // 收益比 web 侧小得多（Fargate 容器长驻，冷启动只在部署/换任务时付一次），但同样是真的。
    // 快照键含包版本指纹，IM 与 web-chat 装的包一致时天然共用、不一致时自动分键。
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${props.skillsBucketName}/mcp-snapshots/*`],
    }));

    // SSM read (model_id config)
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/notiops/*`],
    }));

    // Secrets Manager read (Feishu credentials via Dashboard UI)
    // Bedrock API Key（spec R5.2 / task 4.5）：Admin 在 webchat 管理页存进 Secrets Manager，
    // IM 侧 `core/bedrock_credentials` 读它并在 bedrock 客户端构造前注入
    // `AWS_BEARER_TOKEN_BEDROCK`。缺此授权的失败模式是**静默的**：读 secret 被拒 → 回退
    // IAM 角色 → 对话照常但 Key 永不生效。只读、只到这一个 secret（写入方是 BFF）。
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [
        `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:notiops/im-bot-feishu-*`,
        `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:notiops/bedrock-api-key-*`,
      ],
    }));

    // MCP sidecars (pricing + cost) call AWS APIs using the task role's
    // credentials, so the role needs read perms for the relevant
    // services. Centralized in `grantMcpReadOnly` to keep all 3 task
    // roles in lockstep.
    grantMcpReadOnly(role);

    // ─── Slack Bot Service ───
    const slackTaskDef = new ecs.FargateTaskDefinition(this, "SlackBotTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    slackTaskDef.addContainer("app", {
      image: ecs.ContainerImage.fromAsset("../", {
        file: "platforms/slack/Dockerfile",
        platform: ecr_assets.Platform.LINUX_AMD64,
      }),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "slack-bot" }),
      environment: {
        AWS_REGION: cdk.Aws.REGION,
        BEDROCK_REGION: cdk.Aws.REGION,
        DEVOPS_AGENT_REGION: cdk.Aws.REGION,
        AGENTIC_CHAT_MODE: "enabled",
        AWS_MCP_MODE: "docs_only",
        CONVERSATIONS_TABLE: props.conversationsTableName,
        METRICS_TABLE: props.metricsTableName,
        CONFIG_TABLE: props.configTableName,
        SLACK_BOT_TOKEN_ARN: "notiops/slack-bot-token",
        SLACK_APP_TOKEN_ARN: "notiops/slack-app-token",
        DEFAULT_INVESTIGATION_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        LOCKED_ACCOUNT_ID: lockedAccountId,
        SKILLS_BUCKET: props.skillsBucketName,
        SKILL_DISPATCH_ENABLED: "false",  // 暂时隐藏:调查时不自动弹 skill 选择卡(用户要求);/skills 显式管理不受影响。恢复改回 "true"。
        AWS_PRICING_MCP_ENDPOINT: "http://127.0.0.1:8001/mcp",
        AWS_COST_MCP_ENDPOINT: "http://127.0.0.1:8003/mcp",
        // Per-sidecar enable flags — default OFF in code (so a deploy
        // without sidecars doesn't surface broken tools to the LLM).
        // We ship sidecars by default, so flip these ON.
        AWS_MCP_PRICING_ENABLED: "true",
        AWS_MCP_COST_ENABLED: "true",
      },
    });
    addMcpSidecars(slackTaskDef, "Slack");

    new ecs.FargateService(this, "SlackBotService", {
      cluster,
      taskDefinition: slackTaskDef,
      desiredCount: enabledPlatforms.includes("slack") ? 1 : 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Grant Slack task role same permissions
    const slackRole = slackTaskDef.taskRole;
    slackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      // 最小权限：bot 只做 item 级读写 + Query（不需要 DeleteTable/UpdateTable 等控制面）。
      actions: [
        "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan",
        "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem",
        "dynamodb:ConditionCheckItem", "dynamodb:DescribeTable",
      ],
      resources: [
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.metricsTableName}`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.metricsTableName}/*`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.configTableName}`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.configTableName}/*`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.conversationsTableName}`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.conversationsTableName}/*`,
      ],
    }));
    slackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        // GPT-5.x via Bedrock Mantle Responses API. The endpoint is
        // region-addressed and may differ from the bot's runtime region,
        // so this is deliberately not narrowed by region: the admin can
        // repoint a Mantle model at any allowlisted region at runtime
        // (bff/web-chat/llm_config.mjs::MANTLE_REGIONS) without a redeploy,
        // and an IAM grant narrower than that allowlist yields a config
        // that saves but cannot be invoked.
        //
        // NOTE: an earlier version of this comment claimed Mantle "is
        // account-scoped, no resource-ARN dimension". That is wrong --
        // CreateInference takes a required `project` resource type (see
        // service-authorization/latest/reference/list_bedrock-mantle.html,
        // and the AWS managed policy AmazonBedrockMantleInferenceAccess,
        // which scopes it to arn:aws:bedrock-mantle:*:*:project/*).
        // `*` here is a deliberate width, not a forced one.
        "bedrock-mantle:CreateInference",
      ],
      resources: ["*"],
    }));
    // STS AssumeRole — create_investigation (same as Feishu role)
    slackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/notiops-agent-trigger-*`],
    }));
    // DevOps Agent (aidevops) — progress poller (same as Feishu role)
    slackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["aidevops:ListJournalRecords", "aidevops:GetJournalRecord"],
      resources: [`arn:aws:aidevops:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agentspace/*`],
    }));
    // AWS Support API — case management (same as Feishu role)
    slackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        "support:CreateCase",
        "support:DescribeCases",
        "support:DescribeCommunications",
        "support:AddCommunicationToCase",
        "support:ResolveCase",
        "support:DescribeServices",
        "support:DescribeSeverityLevels",
        "support:DescribeTrustedAdvisorChecks",
      ],
      resources: ["*"],
    }));
    slackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/notiops/*`],
    }));

    // S3 — skill registry (same as Feishu/DingTalk)
    slackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [`arn:aws:s3:::${props.skillsBucketName}`],
      conditions: { StringLike: { "s3:prefix": ["skills/*", "skills/"] } },
    }));
    slackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${props.skillsBucketName}/skills/*`],
    }));
    // MCP 规格快照 —— 理由见 Feishu 角色处那段注释。
    slackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${props.skillsBucketName}/mcp-snapshots/*`],
    }));

    // Secrets Manager read (Slack bot + app tokens, created in NotiOpsBackendStack)
    slackRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [
        `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:notiops/slack-*`,
        // Bedrock API Key（task 4.5）—— 见 Feishu 角色处的说明（失败模式为静默回退 IAM）。
        `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:notiops/bedrock-api-key-*`,
      ],
    }));
    grantMcpReadOnly(slackRole);

    // ─── DingTalk Bot Service ───
    const dingtalkTaskDef = new ecs.FargateTaskDefinition(this, "DingtalkBotTask", {
      cpu: 512,
      memoryLimitMiB: 1024,
    });

    dingtalkTaskDef.addContainer("app", {
      image: ecs.ContainerImage.fromAsset("../", {
        file: "platforms/dingtalk/Dockerfile",
        platform: ecr_assets.Platform.LINUX_AMD64,
      }),
      essential: true,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "dingtalk-bot" }),
      environment: {
        AWS_REGION: cdk.Aws.REGION,
        BEDROCK_REGION: cdk.Aws.REGION,
        DEVOPS_AGENT_REGION: cdk.Aws.REGION,
        AGENTIC_CHAT_MODE: "enabled",
        AWS_MCP_MODE: "docs_only",
        CONVERSATIONS_TABLE: props.conversationsTableName,
        METRICS_TABLE: props.metricsTableName,
        CONFIG_TABLE: props.configTableName,
        DINGTALK_APP_KEY_ARN: "notiops/dingtalk-app-key",
        DINGTALK_APP_SECRET_ARN: "notiops/dingtalk-app-secret",
        DEFAULT_INVESTIGATION_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
        LOCKED_ACCOUNT_ID: lockedAccountId,
        SKILLS_BUCKET: props.skillsBucketName,
        SKILL_DISPATCH_ENABLED: "false",  // 暂时隐藏:调查时不自动弹 skill 选择卡(用户要求);/skills 显式管理不受影响。恢复改回 "true"。
        AWS_PRICING_MCP_ENDPOINT: "http://127.0.0.1:8001/mcp",
        AWS_COST_MCP_ENDPOINT: "http://127.0.0.1:8003/mcp",
        // Per-sidecar enable flags — default OFF in code (so a deploy
        // without sidecars doesn't surface broken tools to the LLM).
        // We ship sidecars by default, so flip these ON.
        AWS_MCP_PRICING_ENABLED: "true",
        AWS_MCP_COST_ENABLED: "true",
      },
    });
    addMcpSidecars(dingtalkTaskDef, "Dingtalk");

    new ecs.FargateService(this, "DingtalkBotService", {
      cluster,
      taskDefinition: dingtalkTaskDef,
      desiredCount: enabledPlatforms.includes("dingtalk") ? 1 : 0,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
    });

    // Grant DingTalk task role same permissions as Feishu/Slack
    const dingtalkRole = dingtalkTaskDef.taskRole;
    dingtalkRole.addToPrincipalPolicy(new iam.PolicyStatement({
      // 最小权限：bot 只做 item 级读写 + Query（不需要 DeleteTable/UpdateTable 等控制面）。
      actions: [
        "dynamodb:GetItem", "dynamodb:BatchGetItem", "dynamodb:Query", "dynamodb:Scan",
        "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:BatchWriteItem",
        "dynamodb:ConditionCheckItem", "dynamodb:DescribeTable",
      ],
      resources: [
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.metricsTableName}`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.metricsTableName}/*`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.configTableName}`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.configTableName}/*`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.conversationsTableName}`,
        `arn:aws:dynamodb:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:table/${props.conversationsTableName}/*`,
      ],
    }));
    dingtalkRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        // GPT-5.x via Bedrock Mantle Responses API. The endpoint is
        // region-addressed and may differ from the bot's runtime region,
        // so this is deliberately not narrowed by region: the admin can
        // repoint a Mantle model at any allowlisted region at runtime
        // (bff/web-chat/llm_config.mjs::MANTLE_REGIONS) without a redeploy,
        // and an IAM grant narrower than that allowlist yields a config
        // that saves but cannot be invoked.
        //
        // NOTE: an earlier version of this comment claimed Mantle "is
        // account-scoped, no resource-ARN dimension". That is wrong --
        // CreateInference takes a required `project` resource type (see
        // service-authorization/latest/reference/list_bedrock-mantle.html,
        // and the AWS managed policy AmazonBedrockMantleInferenceAccess,
        // which scopes it to arn:aws:bedrock-mantle:*:*:project/*).
        // `*` here is a deliberate width, not a forced one.
        "bedrock-mantle:CreateInference",
      ],
      resources: ["*"],
    }));
    dingtalkRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/notiops-agent-trigger-*`],
    }));
    dingtalkRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["aidevops:ListJournalRecords", "aidevops:GetJournalRecord"],
      resources: [`arn:aws:aidevops:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agentspace/*`],
    }));
    dingtalkRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        "support:CreateCase", "support:DescribeCases",
        "support:DescribeCommunications", "support:AddCommunicationToCase",
        "support:ResolveCase", "support:DescribeServices",
        "support:DescribeSeverityLevels", "support:DescribeTrustedAdvisorChecks",
      ],
      resources: ["*"],
    }));
    dingtalkRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/notiops/*`],
    }));
    dingtalkRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:ListBucket"],
      resources: [`arn:aws:s3:::${props.skillsBucketName}`],
      conditions: { StringLike: { "s3:prefix": ["skills/*", "skills/"] } },
    }));
    dingtalkRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${props.skillsBucketName}/skills/*`],
    }));
    // MCP 规格快照 —— 理由见 Feishu 角色处那段注释。
    dingtalkRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [`arn:aws:s3:::${props.skillsBucketName}/mcp-snapshots/*`],
    }));
    dingtalkRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ["secretsmanager:GetSecretValue"],
      resources: [
        `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:notiops/dingtalk-*`,
        // Bedrock API Key（task 4.5）—— 见 Feishu 角色处的说明（失败模式为静默回退 IAM）。
        `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:notiops/bedrock-api-key-*`,
      ],
    }));
    grantMcpReadOnly(dingtalkRole);
  }
}
