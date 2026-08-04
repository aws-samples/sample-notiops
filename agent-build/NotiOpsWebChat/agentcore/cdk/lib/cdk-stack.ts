import {
  AgentCoreApplication,
  AgentCoreMcp,
  AgentCorePaymentManager,
  AgentCorePaymentConnector,
  type AgentCoreProjectSpec,
  type AgentCoreMcpSpec,
  type CustomJWTAuthorizerConfig,
  type HarnessDeploymentConfig,
} from '@aws/agentcore-cdk';
import { CfnOutput, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * Harness deployment config: role-scoped fields (for IAM role + container build)
 * plus the full validated spec + its config directory so the L3 construct can
 * synthesize the AWS::BedrockAgentCore::Harness resource.
 */
export type HarnessConfig = HarnessDeploymentConfig;

export interface PaymentConnectorSpec {
  name: string;
  provider: 'CoinbaseCDP' | 'StripePrivy';
  credentialProviderArn: string;
}

export interface PaymentSpec {
  name: string;
  description?: string;
  authorizerType: 'AWS_IAM' | 'CUSTOM_JWT';
  authorizerConfiguration?: { customJWTAuthorizer: CustomJWTAuthorizerConfig };
  autoPayment?: boolean;
  paymentToolAllowlist?: string[];
  networkPreferences?: string[];
  connectors: PaymentConnectorSpec[];
}

export interface AgentCoreStackProps extends StackProps {
  /**
   * The AgentCore project specification containing agents, memories, and credentials.
   */
  spec: AgentCoreProjectSpec;
  /**
   * The MCP specification containing gateways and servers.
   */
  mcpSpec?: AgentCoreMcpSpec;
  /**
   * Credential provider ARNs from deployed state, keyed by credential name.
   */
  credentials?: Record<string, { credentialProviderArn: string; clientSecretArn?: string }>;
  /**
   * Harness role configurations.
   */
  harnesses?: HarnessConfig[];
  /**
   * Parsed connectorParameters for non-S3 KB data sources, keyed by
   * connectorConfigFile path. Forwarded to AgentCoreApplication.
   */
  connectorParametersByFile?: Record<string, Record<string, unknown>>;
  /**
   * Payment specifications with resolved credential provider ARNs.
   */
  paymentSpec?: PaymentSpec[];
}

function toCdkId(name: string): string {
  return name.replace(/_/g, '');
}

/**
 * Decide whether a deployed runtime should receive payment env vars + IAM grants.
 * Payments today only ships a runtime shim for Python HTTP runtimes; injecting
 * AGENTCORE_PAYMENT_* env vars into TypeScript / MCP / A2A / AGUI runtimes
 * would surface env vars they cannot consume and would dilute least-privilege
 * IAM grants for runtimes that never call ProcessPayment.
 */
function isPaymentEligibleAgent(agent: { entrypoint?: string; protocol?: string }): boolean {
  if (agent.protocol && agent.protocol !== 'HTTP') {
    return false;
  }
  const entrypoint = typeof agent.entrypoint === 'string' ? agent.entrypoint : '';
  const entrypointFile = entrypoint.split(':')[0] ?? '';
  return entrypointFile.endsWith('.py');
}

/**
 * CDK Stack that deploys AgentCore infrastructure.
 *
 * This is a thin wrapper that instantiates L3 constructs.
 * All resource logic and outputs are contained within the L3 constructs.
 */
export class AgentCoreStack extends Stack {
  /** The AgentCore application containing all agent environments */
  public readonly application: AgentCoreApplication;

  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    const { spec, mcpSpec, credentials, harnesses, connectorParametersByFile, paymentSpec } = props;

    // Create AgentCoreApplication with all agents and harness roles
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const appProps: Record<string, unknown> = { spec };
    if (harnesses?.length) {
      appProps.harnesses = harnesses;
    }
    if (connectorParametersByFile && Object.keys(connectorParametersByFile).length > 0) {
      appProps.connectorParametersByFile = connectorParametersByFile;
    }
    if (credentials) {
      appProps.credentials = credentials;
    }
    this.application = new AgentCoreApplication(this, 'Application', appProps as any);

    // ── NotiOps：给所有 runtime 执行角色授予 Bedrock Mantle 权限（GPT-5.4 经 Mantle 调用）──
    // GPT-5.4 走 Bedrock Mantle（OpenAI Responses API，us-east-2）。runtime 执行角色默认
    // 没有 mantle 权限，缺了会在 SSE 流里报 401（CreateInference / CallWithBearerToken）。
    // 在 CDK 里授予 → 客户首次部署即生效，无需手动 put-role-policy。
    // 关闭 GPT-5.4 也无副作用（仅多了未用到的权限）。区域写死 us-east-2/us-west-2（GPT-5.4 可用区）。
    const MANTLE_REGIONS = ['us-east-2', 'us-west-2'];
    for (const env of this.application.environments.values()) {
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NotiOpsBedrockMantleInference',
          actions: ['bedrock-mantle:CreateInference', 'bedrock-mantle:GetInference'],
          resources: MANTLE_REGIONS.map((r) => `arn:aws:bedrock-mantle:${r}:${this.account}:*`),
        })
      );
      // CallWithBearerToken 不支持资源级限定，必须 "*"
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NotiOpsBedrockMantleBearer',
          actions: ['bedrock-mantle:CallWithBearerToken'],
          resources: ['*'],
        })
      );
      // ── NotiOps Web Search：允许 agent 调用 AgentCore Gateway（含内置 web-search 连接器）──
      // agent 经 MCP+SigV4 调 Gateway 做联网搜索（数据不出 AWS）。范围限本账号本区的 gateway/*，
      // 因为 Gateway 是 deploy 之外单独 provision 的（ARN 不在此 CDK），用通配避免硬编码 ARN。
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NotiOpsInvokeWebSearchGateway',
          actions: ['bedrock-agentcore:InvokeGateway'],
          resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`],
        })
      );
      // ── NotiOps Skills：agent 只读共享数据桶的 skills/ 前缀（客户自定义能力，与 IM/web 共享）──
      // 桶名 notiops-data-<account>-<region>（NotiOpsBackendStack 的 dataBucket）。
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NotiOpsSkillsRead',
          actions: ['s3:GetObject', 's3:ListBucket'],
          resources: [
            `arn:aws:s3:::notiops-data-${this.account}-${this.region}`,
            `arn:aws:s3:::notiops-data-${this.account}-${this.region}/skills/*`,
          ],
        })
      );
      // ── NotiOps Reports：agent 把"长报告"（如完整新发布列表/摘要）写到 reports/ 前缀，
      //   再生成 presigned GET 链接给用户下载。聊天里只展示节选，完整版放 S3（控制输出量）。
      //   PutObject 写、GetObject 供 presign（presign 用本角色凭证，故需 GetObject 权限）。
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NotiOpsReportsWrite',
          actions: ['s3:PutObject', 's3:GetObject'],
          resources: [
            `arn:aws:s3:::notiops-data-${this.account}-${this.region}/reports/*`,
          ],
        })
      );
      // ── NotiOps FinOps：官方 awslabs cost+pricing MCP 所需的**只读**权限 ──
      // 覆盖白名单工具用到的服务：Cost Explorer（含 RI/SP 利用率）、Cost Optimization Hub、
      // Compute Optimizer、Budgets、AWS Pricing（Price List）、Free Tier、S3 Storage Lens、
      // 成本分配标签、CUR。这些 API 多不支持资源级限定，故 Resource 用 "*"。全只读、
      // 客户首次部署即生效。跨账号查别的账号时，目标账号的 notiops-idle-detection-role
      // 也需同等只读权限（已在 notiops-backend-stack 一并授予）。
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NotiOpsFinOpsReadOnly',
          actions: [
            // Cost Explorer（cost-explorer / cost-comparison / cost-anomaly / RI&SP 表现）
            'ce:Get*',
            'ce:List*',
            'ce:Describe*',
            // Cost Optimization Hub（cost-optimization / rec-details）
            'cost-optimization-hub:ListRecommendations',
            'cost-optimization-hub:ListRecommendationSummaries',
            'cost-optimization-hub:GetRecommendation',
            'cost-optimization-hub:ListEnrollmentStatuses',
            'cost-optimization-hub:GetPreferences',
            // Compute Optimizer（compute-optimizer）
            'compute-optimizer:Get*',
            'compute-optimizer:Describe*',
            // Budgets（budgets）
            'budgets:ViewBudget',
            'budgets:DescribeBudgets',
            // AWS Pricing / Price List（get_pricing 等）
            'pricing:GetProducts',
            'pricing:DescribeServices',
            'pricing:GetAttributeValues',
            'pricing:ListPriceLists',
            'pricing:GetPriceListFileUrl',
            // Free Tier（free-tier-usage）
            'freetier:GetFreeTierUsage',
            // S3 Storage Lens（storage-lens）
            'storagelens:Get*',
            'storagelens:List*',
            's3:GetStorageLensConfiguration',
            's3:ListStorageLensConfigurations',
            // 成本分配标签（list-cost-allocation-tags）
            'ce:ListCostAllocationTags',
            // CUR（session-sql 可能读 CUR 元数据）
            'cur:DescribeReportDefinitions',
          ],
          resources: ['*'],
        })
      );

      // ── NotiOps 资源巡检：只读 RDS / CloudWatch（配合 rds-health-check skill）──
      // 精选只读白名单：覆盖 core/resources.py 的 4 个 RDS 巡检工具实际调用的 API。
      // 每条 action 都对应具体工具：
      //   rds_list_instances/describe_instance → rds:DescribeDBInstances/DescribeDBClusters
      //   rds_recent_events                    → rds:DescribeEvents
      //   (标签/补充)                          → rds:ListTagsForResource
      //   rds_metrics                          → cloudwatch:GetMetricStatistics/ListMetrics
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NotiOpsResourceInspectReadOnly',
          actions: [
            'rds:DescribeDBInstances',
            'rds:DescribeDBClusters',
            'rds:DescribeEvents',
            'rds:ListTagsForResource',
            'cloudwatch:GetMetricStatistics',
            'cloudwatch:ListMetrics',
          ],
          resources: ['*'], // 这些只读 Describe/Get 多不支持资源级限定
        })
      );

      // ── NotiOps 故障调查：只读 CloudWatch / Logs / CloudTrail / EC2 ──
      // 配合 investigation_mcp(CloudWatch+CloudTrail MCP) + core/resources.py 的 EC2 工具。
      // 每条 action 对应能力：
      //   CloudWatch MCP（告警/指标/日志）→ cloudwatch:Describe*/Get*/List* + logs:*Query*/Describe*/Get*
      //   CloudTrail MCP（谁改了什么）     → cloudtrail:LookupEvents + Lake(StartQuery/GetQueryResults/...)
      //   EC2 只读工具（实例/安全组排障）   → ec2:DescribeInstances/DescribeSecurityGroups/...
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NotiOpsInvestigationReadOnly',
          actions: [
            // CloudWatch 告警/指标
            'cloudwatch:DescribeAlarms',
            'cloudwatch:DescribeAlarmHistory',
            'cloudwatch:GetMetricData',
            'cloudwatch:ListMetrics',
            // CloudWatch Logs（含 Logs Insights）
            'logs:DescribeLogGroups',
            'logs:DescribeQueryDefinitions',
            'logs:ListLogAnomalyDetectors',
            'logs:ListAnomalies',
            'logs:StartQuery',
            'logs:GetQueryResults',
            'logs:StopQuery',
            // CloudTrail（事件查询 + Lake）
            'cloudtrail:LookupEvents',
            'cloudtrail:ListEventDataStores',
            'cloudtrail:GetEventDataStore',
            'cloudtrail:StartQuery',
            'cloudtrail:DescribeQuery',
            'cloudtrail:GetQueryResults',
            // EC2 只读（实例状态 / 安全组排障）
            'ec2:DescribeInstances',
            'ec2:DescribeInstanceStatus',
            'ec2:DescribeSecurityGroups',
          ],
          resources: ['*'], // 这些只读 API 多不支持资源级限定
        })
      );

      // ── NotiOps DevOps Agent 深度调查 ──
      // (a) **部署账号直连**：Agent Space 就在本账号（IM 部署时自动建），runtime 角色直接
      //     调 devops-agent（IAM action 前缀 aidevops:*）：发现 Agent Space、创建调查任务、
      //     读 journal 拉摘要。见 core/devops_agent.py 的 _client_and_space(部署账号分支)。
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NotiOpsDevOpsAgentDirect',
          actions: [
            'aidevops:ListAgentSpaces',
            'aidevops:GetAgentSpace',
            'aidevops:CreateBacklogTask',
            'aidevops:GetBacklogTask',
            'aidevops:ListJournalRecords',
            'aidevops:GetJournalRecord',
            // 缓解方案（Generate mitigation plan 按钮的等价能力）：CreateChat + SendMessage
            // 起一个可对话 execution 让 agent 基于根因产出缓解方案；ListRecommendations/ListExecutions
            // 读推荐与执行列表。见 core/devops_agent.generate_mitigation。
            'aidevops:CreateChat',
            'aidevops:SendMessage',
            'aidevops:ListRecommendations',
            'aidevops:GetRecommendation',
            'aidevops:ListExecutions',
            'aidevops:ListPendingMessages',
          ],
          resources: ['*'], // ListAgentSpaces 不支持资源级限定；其余按 agentspace/* 也可，统一用 *
        })
      );
      // (b) **跨账号（可选）**：目标≠部署账号时走 AssumeRole trigger role（config 表配），留口。
      env.runtime.role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'NotiOpsDevOpsAgentAssume',
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::*:role/notiops-agent-trigger-*`],
        })
      );

      // ── 默认授予 AWS 托管 ReadOnlyAccess（用户决定：默认 ReadOnlyAccess，客户可选关掉只用精选白名单）──
      // 一次到位：以后新增任何只读巡检能力都无需再改 IAM。合规严格的客户可在部署时传
      // `-c notiopsReadOnlyAccess=false` 关掉，则仅依赖上面精选的 FinOps + 资源巡检只读白名单。
      // 多账号：agent 工具跨账号 AssumeRole 进成员采集角色（cases/资源巡检按目标账号取数）。
      // 缺此权限的事故：跨账号被拒 → 模型退化用部署账号数据回答（错误归因）。
      env.runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'AssumeMemberIdleDetectionRoles',
        actions: ['sts:AssumeRole'],
        resources: ['arn:aws:iam::*:role/notiops-idle-detection-role*'],
      }));

      // 跨账号取数前需先读 config 表拿目标账号的 role_arn（core/aws_session._role_arn_for）。
      // 缺此权限的事故：读 config 被拒 → _role_arn_for 返回 None → 工具报 cross_account_unavailable
      // （表面像"未接入"，实为运行时无权查 config）。CONFIG_TABLE 默认 notiops-config。
      env.runtime.role.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'ReadNotiOpsConfigForCrossAccount',
        actions: ['dynamodb:GetItem', 'dynamodb:Query'],
        resources: [
          'arn:aws:dynamodb:*:*:table/notiops-config',
          'arn:aws:dynamodb:*:*:table/notiops-config/index/*',
        ],
      }));

      const useReadOnly = this.node.tryGetContext('notiopsReadOnlyAccess');
      if (useReadOnly === undefined || useReadOnly === true || useReadOnly === 'true') {
        env.runtime.role.addManagedPolicy(
          iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')
        );
      }
    }

    // Create AgentCoreMcp if there are gateways configured
    if (mcpSpec?.agentCoreGateways && mcpSpec.agentCoreGateways.length > 0) {
      new AgentCoreMcp(this, 'Mcp', {
        projectName: spec.name,
        mcpSpec,
        agentCoreApplication: this.application,
        credentials,
        projectTags: spec.tags,
      });
    }

    // Create payment infrastructure via CFN constructs
    if (paymentSpec && paymentSpec.length > 0) {
      for (const payment of paymentSpec) {
        const mgrId = toCdkId(payment.name);
        const manager = new AgentCorePaymentManager(this, `Payment${mgrId}`, {
          projectName: spec.name,
          name: payment.name,
          authorizerType: payment.authorizerType,
          description: payment.description,
          authorizerConfiguration: payment.authorizerConfiguration,
          tags: spec.tags,
        });

        const prefix = `AGENTCORE_PAYMENT_${payment.name.toUpperCase().replace(/-/g, '_')}`;

        // Wire env vars from construct output tokens into eligible agent environments only.
        // See isPaymentEligibleAgent — non-Python or non-HTTP runtimes have no shim that
        // can consume these env vars, and giving them sts:AssumeRole on the
        // ProcessPaymentRole would broaden the privilege surface unnecessarily.
        for (const env of this.application.environments.values()) {
          if (!isPaymentEligibleAgent(env.agent)) {
            continue;
          }
          env.runtime.addEnvironmentVariable(`${prefix}_MANAGER_ARN`, manager.paymentManagerArn);
          env.runtime.addEnvironmentVariable(`${prefix}_PROCESS_PAYMENT_ROLE_ARN`, manager.processPaymentRoleArn);

          // Grant runtime execution role permission to assume the ProcessPaymentRole.
          // The ProcessPaymentRole's trust policy allows AccountRootPrincipal, but the
          // caller still needs sts:AssumeRole on its own role to perform the assumption.
          env.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: ['sts:AssumeRole'],
              resources: [manager.processPaymentRoleArn],
            })
          );

          // Grant payment data-plane actions directly to the runtime role.
          //
          // NOTE: This deviates from the canonical role model in the AgentCore Payments
          // beta guide, which assigns Get/List/Create instrument+session actions to a
          // separate ManagementRole and limits the agent's role to ProcessPayment only.
          // The current SDK plugin (AgentCorePaymentsPlugin.generate_payment_header)
          // calls GetPaymentInstrument internally during the 402 auto-pay path, so the
          // runtime role needs read access. CreatePaymentSession is included so
          // `agentcore invoke --auto-session` works without a separate ManagementRole
          // call. Tighten this if the SDK is updated to accept pre-fetched instrument
          // details and split create-session into a backend-only flow.
          env.runtime.role.addToPrincipalPolicy(
            new iam.PolicyStatement({
              actions: [
                'bedrock-agentcore:GetPaymentInstrument',
                'bedrock-agentcore:ListPaymentInstruments',
                'bedrock-agentcore:GetPaymentInstrumentBalance',
                'bedrock-agentcore:GetPaymentSession',
                'bedrock-agentcore:ListPaymentSessions',
                'bedrock-agentcore:CreatePaymentSession',
                'bedrock-agentcore:ProcessPayment',
              ],
              resources: [manager.paymentManagerArn, `${manager.paymentManagerArn}/*`],
            })
          );

          if (payment.autoPayment !== undefined) {
            env.runtime.addEnvironmentVariable(`${prefix}_AUTO_PAYMENT`, String(payment.autoPayment));
          }
          if (payment.paymentToolAllowlist) {
            env.runtime.addEnvironmentVariable(`${prefix}_TOOL_ALLOWLIST`, payment.paymentToolAllowlist.join(','));
          }
          if (payment.networkPreferences) {
            env.runtime.addEnvironmentVariable(`${prefix}_NETWORK_PREFERENCES`, payment.networkPreferences.join(','));
          }
          if (payment.authorizerType === 'CUSTOM_JWT') {
            env.runtime.addEnvironmentVariable(`${prefix}_AUTH_MODE`, 'bearer');
          }
        }

        // Create connectors for this manager
        for (const connector of payment.connectors) {
          const connId = toCdkId(connector.name);
          const conn = new AgentCorePaymentConnector(this, `Payment${mgrId}${connId}`, {
            projectName: spec.name,
            paymentManager: manager,
            connectorName: connector.name,
            connectorType: connector.provider,
            credentialProviderArn: connector.credentialProviderArn,
          });

          // Wire first connector's ID as env var (eligible agents only)
          if (connector === payment.connectors[0]) {
            for (const env of this.application.environments.values()) {
              if (!isPaymentEligibleAgent(env.agent)) continue;
              env.runtime.addEnvironmentVariable(`${prefix}_CONNECTOR_ID`, conn.paymentConnectorId);
            }
          }

          new CfnOutput(this, `Payment${mgrId}${connId}ConnectorId`, {
            value: conn.paymentConnectorId,
          });
        }

        // CFN Outputs for post-deploy state parsing
        new CfnOutput(this, `Payment${mgrId}ManagerArn`, {
          value: manager.paymentManagerArn,
        });
        new CfnOutput(this, `Payment${mgrId}ManagerId`, {
          value: manager.paymentManagerId,
        });
        new CfnOutput(this, `Payment${mgrId}ProcessPaymentRoleArn`, {
          value: manager.processPaymentRoleArn,
        });
        new CfnOutput(this, `Payment${mgrId}ResourceRetrievalRoleArn`, {
          value: manager.resourceRetrievalRoleArn,
        });
      }
    }

    // Stack-level output
    new CfnOutput(this, 'StackNameOutput', {
      description: 'Name of the CloudFormation Stack',
      value: this.stackName,
    });
  }
}
