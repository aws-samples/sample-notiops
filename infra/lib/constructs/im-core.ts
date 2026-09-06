import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";

/**
 * IM（飞书 / Slack）webhook 三件套的**唯一定义处** —— 两条部署路径共用。
 *
 *   · ingress  —— API Gateway HTTP API 收事件，验签+解密后异步投 worker，秒回 ACK
 *   · worker   —— 真正干活（确定性路由 → DevOps Agent 直连 / 发起调查 / 案例流程）
 *   · progress —— EventBridge rate(1 minute) 扫 `imtask#` 行，增量 PATCH 进度卡片
 *
 * ── 为什么抽成 construct ──────────────────────────────────────────────────────
 * 铁律：**方式A（一键 CloudFormation）与方式B（setup.sh / CDK）的功能必须一致**。
 * IM 这套东西有 ~25 个属性是"错一个就只在生产暴露"的类型（worker 900s 而不是 3s、
 * ingress 的 reservedConcurrentExecutions=10、Slack 那两个不能改名的环境变量、
 * progress 的 1 分钟节拍……）。抄一份到一键模板里，就等于给自己埋一个「改了 A 忘了 B」
 * 的长期隐患。所以两条路径都从这里生成，差异**只允许**通过下面的 props 表达。
 *
 * ── 两条路径的真实差异（就这几条，别再加）───────────────────────────────────
 *   1. 代码来源：方式B `Code.fromAsset("../")`；方式A 从 staging 桶取 Release 产物。
 *   2. 物理名：方式B 写死 `notiops-im-*`（客户文档里到处引用）；方式A 带 StackName 前缀
 *      —— 一键模板可能与 setup.sh 部署共存于同一账号，写死名字会 already-exists。
 *   3. 日志组名：方式B 显式同名（`/aws/lambda/<fn>`）；方式A **不给名字**（CFN 自己命名 +
 *      LoggingConfig 指过来）。理由见 scripts/postprocess_template.py 里那条判据：
 *      字面名会撞上 Lambda 服务自建的同名组，CFN 的 NAME_CONFLICT_VALIDATION 会让
 *      整栈在 9 秒内失败，而报错只提日志组，客户根本看不出跟 IM 有关。
 *   4. 平台开关：方式B 是**合成期**布尔（-c enabledPlatforms）；方式A 是**部署期**
 *      CfnCondition（客户在参数页下拉框里选）。
 *
 * ⚠️ 本文件里所有 `description:`（函数、角色、EventBridge 规则）必须是**纯 ASCII**。
 * 不是风格问题：这个 construct 的产物会进一键部署模板，而 CloudFormation 收模板时把
 * 客户可见字段里的非 ASCII **一律换成 `?`**（资源 Description 会出现在 Lambda /
 * EventBridge 控制台里）。`scripts/postprocess_template.py::assert_customer_text_is_ascii`
 * 会在发布流程里拦下来 —— 但那时错误信息指向的是模板 JSON，不是这里。中文注释照旧写，
 * 只有 description 的**值**受限。
 */

/** 给共用 role 授「ingress → worker 异步 invoke」权限，**按函数名拼 ARN**。
 *
 * ⚠️ 不要"顺手"改成 `workerFn.grantInvoke(ingressFn)` —— 那会造成 CloudFormation
 * 循环依赖，整栈建不起来（2026-09-01 实测：`Circular dependency between resources:
 * [ImProgress, ImProgressSchedule…, FeishuIngress, FeishuWorker, ImLambdaRoleDefaultPolicy…]`）。
 * 成因：ingress 和 worker **共用同一个 imRole**，grantInvoke 会往该 role 的
 * DefaultPolicy 里塞一条引用 `Fn::GetAtt[FeishuWorker, Arn]` 的语句
 *   → DefaultPolicy 依赖 FeishuWorker；
 * 而 CDK 又让每个 Function 依赖自己 role 的 DefaultPolicy
 *   → FeishuWorker 依赖 DefaultPolicy。成环。
 *
 * 函数名不含对函数资源的引用（方式B 是常量，方式A 是 `${AWS::StackName}-…`），
 * 所以用它拼字面 ARN 不产生资源引用，环自然断掉。权限范围与 grantInvoke 等价
 * （函数本体 + 版本/别名 `:*`）。
 */
function grantInvokeWorkerByName(role: iam.IRole, workerFnName: string) {
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ["lambda:InvokeFunction"],
    resources: [
      `arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:${workerFnName}`,
      `arn:aws:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:${workerFnName}:*`,
    ],
  }));
}

/** 把 condition 递归打到一棵子树里所有 CFN 资源上（含 CDK 自动生成的 DefaultPolicy /
 *  ApiGatewayV2::{Route,Integration,Stage} / Lambda::Permission 这些"看不见的孩子"）。
 *
 *  漏掉任何一个的症状都一样难查：客户选了「只装 web」，栈里却留下一个引用不存在
 *  资源的 Permission → CREATE_FAILED 整栈回滚。所以这里不点名、直接整棵树扫。 */
function applyConditionDeep(scope: Construct, condition: cdk.CfnCondition) {
  for (const child of scope.node.findAll()) {
    if (cdk.CfnResource.isCfnResource(child)) {
      child.cfnOptions.condition = condition;
    }
  }
}

/** IM ingress 的公网入口：**API Gateway HTTP API**（`$default` 路由 catch-all）。
 *
 * ── 为什么不是 Lambda Function URL ──────────────────────────────────────────
 * Function URL 想接收飞书/Slack 的裸 HTTP POST，只能 `AuthType=NONE`，而那等价于
 * 在函数的资源策略里写 `Principal:"*" + lambda:InvokeFunctionUrl`。这条**模式**会被
 * 一类"公网可达"检测直接判定为 world-accessible 并**自动摘掉那条许可**
 * （2026-09-01 在部署账号实测：许可被摘，Function URL 从此对所有人返回 403，
 * 包括飞书 —— IM 整条路径静默断掉，而且每次 `cdk deploy` 重新加回去就再触发一次）。
 * 检测看的是策略形状，看不到我们在**请求体层面**做了验签/解密，所以没有豁免路径。
 *
 * 换 HTTP API 之后，函数策略里的 principal 变成 `apigateway.amazonaws.com` +
 * sourceArn（不再有 `*`），Function URL 整个不建 —— 模式消失，检测不再命中。
 * **鉴权强度没有变化**：公网入口依旧未鉴权（飞书/Slack 不会给我们签 SigV4），
 * 真正的门还是 `lambda_ingress.py` 文件头「硬约束 A」那套验签 + 解密。
 *
 * ── 为什么不是 CloudFront + OAC + Function URL ─────────────────────────────
 * OAC 要求 `AuthType=AWS_IAM`，而 AWS 文档明确：对 Function URL 用 POST/PUT 时
 * **调用方**必须自己算 body 的 SHA256 并带上 `x-amz-content-sha256` 头
 * （"Lambda doesn't support unsigned payloads"）。飞书/Slack 是通用 webhook 发送方，
 * 永远不会带这个头 —— 这条路对入站 webhook 根本走不通。
 *
 * ── 为什么是 HTTP API 而不是 REST API ──────────────────────────────────────
 * 便宜（$1.00/百万请求 vs $3.50）、建得快（秒级 vs REST 的分钟级，一键部署在意这个）、
 * payload 2.0 的事件形状**与 Function URL 完全一致**（所以 `webhook_adapter.py`
 * 一行都不用改）。代价：HTTP API **不能挂 WAF**（只有 REST API 能）—— 现阶段接受，
 * 补偿是下面的阶段级限流 + ingress 的 `reservedConcurrentExecutions=10`。
 *
 * ⚠️ 返回的 `url` 形如 `https://<id>.execute-api.<region>.amazonaws.com/`，
 * **结尾带 `/`**（`$default` stage 不出现在路径里）—— 与旧的 Function URL 一致，
 * 客户文档里「结尾的 `/` 要保留」那句照旧成立。
 */
function createIngressHttpApi(
  scope: Construct,
  id: string,
  ingressFn: lambda.Function,
  apiName: string,
  /** 纯 ASCII：会进一键模板，见文件头那条约束。 */
  description: string,
): { api: apigwv2.HttpApi; url: string } {
  const api = new apigwv2.HttpApi(scope, id, {
    apiName,
    description,
    // `$default` 路由 = catch-all：任意方法任意路径都进 ingress。
    // 必须是 catch-all —— 飞书的「事件订阅」和「卡片回调」、Slack 的 events /
    // interactivity / slash commands 都填**同一个地址**，路径由平台自己决定，
    // 我们这边不做路由（真正的分派在 platforms/*/lambda_ingress.py 里）。
    defaultIntegration: new HttpLambdaIntegration(`${id}Integration`, ingressFn, {
      // 2.0 的事件形状与 Function URL 一致（requestContext.http.* / rawPath /
      // isBase64Encoded），platforms/*/webhook_adapter.py 两种都吃。
      // ⚠️ 别改 1.0：1.0 没有 `requestContext.http`，适配层会拿不到 method/path。
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    }),
  });

  // 阶段级限流：公网未鉴权入口的第一道闸。数量级远高于真实 IM 事件量（飞书一个群
  // 一秒都到不了 1 个事件），但远低于"能刷出账单"的量。被限流的请求由 API Gateway
  // 直接 429，**不进 Lambda**（比 reservedConcurrentExecutions 更早挡住，也不产生
  // Lambda 费用）。两层都留着：这层管 QPS，那层管并发。
  const cfnStage = api.defaultStage!.node.defaultChild as apigwv2.CfnStage;
  cfnStage.defaultRouteSettings = {
    throttlingRateLimit: 50,
    throttlingBurstLimit: 100,
  };

  return { api, url: api.url! };
}

/** ingress 保活：EventBridge `rate(4 minutes)` → 直接 invoke ingress，常量 input
 *  是哨兵 `{"notiops_warmup": true}`，handler 第一行就早返回。
 *
 * ── 为什么必须有 ─────────────────────────────────────────────────────────────
 * ingress 冷启动 **十几秒**，而飞书/Slack 对 webhook 的超时是 **~3s 硬上限**。
 * 两个数放在一起的结论很直白：**容器只要冻结过，用户下一次操作大概率超时**。
 * 2026-09-02 现网实测：飞书配置「请求地址」第一次点保存报「请求 3 秒超时」
 * （`Init Duration: 8441.81 ms`），立刻再点就成功（`Duration: 2.34 ms`）。
 * ⚠️ **2026-09-03 现网复测（层已带预编译字节码、layer v3）：init 仍然撞 10s 硬上限**
 * —— `Init Duration: 9999.31 ms / Phase: init / Status: timeout`，随后被挪进首发 invoke
 * 重跑（`Duration: 12555.00 ms`），端到端 ~22.5s。预编译只省掉"每次冷启动重编译整个
 * 只读层"那一段，**没有**把 init 压进 10s（这里原先写的 3~5s 是构建期估算，现网未证实）；
 * 剩下的大头是 `import lark_oapi` 本身（9128 个模块的 unmarshal + exec）。要真正压下来
 * 只能减少 init 的活 —— 把 `lark_oapi` 挪进 handler 分支懒加载，或层里只装用到的子包
 * （**尚未做**）。结论不变、而且更硬：这条保活规则依旧是主要防线，`Timeout=20` 是硬需求。
 * 配置阶段还能"再点一次"，`card.action.trigger`（用户点卡片按钮）没有这个补救动作 ——
 * 直接就是「操作失败」。
 *
 * ── 为什么是每个 ingress 一条规则，而不是一条规则挂两个 target ────────────────
 * 方式A 要按平台分别打 CfnCondition（客户可能只装飞书）。一条规则两个 target 时，
 * target 不是独立的 CFN 资源，没法只摘掉其中一个 —— 只装飞书的栈会留下一条指向
 * 不存在的 Slack 函数的 target，规则每 4 分钟失败一次（而且只在 EventBridge 的
 * FailedInvocations 指标里可见，客户根本不会去看）。
 *
 * ── 诚实的边界 ───────────────────────────────────────────────────────────────
 * 只保住 **1 个** 执行环境。真并发（多个群同时来事件）仍会扩容出冷容器。彻底消除
 * 只有 provisioned concurrency（2048MB 常驻 ≈ $21/月），不适合当开源默认值。
 *
 * 成本：10,800 次/月 × ~2ms @2048MB ≈ $0.003/月（含 EventBridge 与 Lambda 请求费）。
 */
function createIngressKeepAlive(
  scope: Construct,
  id: string,
  ingressFn: lambda.Function,
  ruleName: string | undefined,
  /** 纯 ASCII：会进一键模板，见文件头那条约束。 */
  description: string,
): events.Rule {
  return new events.Rule(scope, id, {
    ruleName,
    description,
    // 4 分钟：比 Lambda 回收空闲执行环境更勤（回收没有 SLA，实测普遍 > 5 分钟）。
    // 别放宽到 10 分钟省那 $0.002 —— 放宽多少，"第一次点按钮就失败"的概率就回来多少。
    schedule: events.Schedule.rate(cdk.Duration.minutes(4)),
    targets: [new targets.LambdaFunction(ingressFn, {
      // ⚠️ 哨兵字符串与 `platforms/common/warmup.py::_SENTINEL` 是一处契约，两边一起改。
      // 必须走 EventBridge 的常量 input（= 整个 `event` 的顶层），**不是** body：
      // warmup.is_warmup() 只认顶层键，正是为了让公网请求（body 由攻击者控制）
      // 构造不出这条早返回路径。
      event: events.RuleTargetInput.fromObject({ notiops_warmup: true }),
    })],
  });
}

export interface ImCoreProps {
  metricsTableName: string;
  configTableName: string;
  conversationsTableName: string;
  skillsBucketName: string;
  /** 报告分发 CDN 域名（`REPORTS_CDN_DOMAIN`；CloudFront + OAC，只暴露 `reports/*`）。
   *
   *  不给 / 给空串 → `core/reports.py` 回退 presigned URL，而 IM 侧 Lambda 用的是
   *  **临时角色凭证**签名，实际寿命被凭证截断（12h）。也就是说：漏传的症状不是报错，
   *  是客户第二天点「查看完整报告」拿到 `AccessDenied` —— 静默降级，别让它发生。 */
  reportsCdnDomain?: string;
  /** 单账号模式下锁定的账号；多账号（Organizations）模式传空串。 */
  lockedAccountId: string;
  /**
   * 排障用的 DevOps Agent Space id（`DEVOPS_AGENT_SPACE_ID`）。与 `web-chat-core.ts`
   * 的 `agentSpaceId` 是同一个值、同一个语义 —— 之前**只有 web 侧注了**，IM 侧漏了。
   *
   * 漏传的后果不是报错，是**看名字碰运气**：`core/devops_agent.py::_discover_space`
   * 在 env 为空时回退 `ListAgentSpaces`，只认 `notiops-devops-<account>` 这个名字。
   *   · 方式B 的 space 就叫这个名 → 撞上了，能用；
   *   · 方式A 的 space 叫 `notiops-oneclick-<account>` → **永远不匹配**，只靠
   *     「账号里恰好只有一个 space」那条兜底活着。客户账号里一旦出现第二个
   *     agent space（自己建的、或后来装了巡检），`_discover_space` 就按设计**拒绝
   *     猜测**返回 None → 每一次深度调查都回「该账号未接入」。已有客户命中。
   *
   * 传了之后 `_SPACE_ENV` 是最高优先级，两条路径都变成确定性引用，且**少一次
   * ListAgentSpaces**。空串 = 没配（例如方式A 关掉了深度调查），回退自动发现。
   */
  devopsAgentSpaceId?: string;
  /** 群/频道允许清单，逗号分隔。留空 = 不限制。 */
  allowedChatIds: string;
  /** 三个函数共用的代码。 */
  code: lambda.Code;
  /** lark-oapi + slack-sdk + boto3（manylinux2014_x86_64）。 */
  layer: lambda.ILayerVersion;
  /** 物理函数名生成器。方式B: `notiops-im-${role}`；方式A: `${StackName}-im-${role}`。 */
  fnName: (role: string) => string;
  /** true = 显式建 `/aws/lambda/<fnName>` 同名日志组（方式B）；false = 交给 CFN 命名（方式A）。 */
  explicitLogGroupNames: boolean;
  /** 合成期是否生成该平台的资源。方式A 两个都给 true，靠 conditions 在部署期决定。 */
  platforms: { feishu: boolean; slack: boolean };
  /** 方式A：部署期条件。方式B 不传。anyPlatform 盖住共用资源（role / progress / 节拍）。 */
  conditions?: {
    feishu?: cdk.CfnCondition;
    slack?: cdk.CfnCondition;
    anyPlatform?: cdk.CfnCondition;
  };
  /** EventBridge 规则物理名。方式A 不传（让 CFN 命名，避免与 setup.sh 部署撞名）。 */
  progressRuleName?: string;
  /** ingress 保活规则的物理名生成器（`role` 形如 `ingress-feishu`）。方式A 不传，同上。 */
  keepAliveRuleName?: (role: string) => string;
  /** Secret 名。两条路径目前一致，留成参数是为了让"改名"这件事只能改一处。 */
  secretNames?: { feishu?: string; slackBotToken?: string; slackSigningSecret?: string };
}

export interface ImCoreResult {
  imRole: iam.Role;
  /** 飞书 webhook 地址 = HTTP API `$default` stage 的 URL（未启用飞书时 undefined）。 */
  feishuWebhookUrl?: string;
  slackWebhookUrl?: string;
  /** 本次实际创建的全部 IM 函数。
   *
   *  方式A 需要它来给每个函数挂 `addDependency(StagerArtifacts)` —— 代码在 staging 桶里，
   *  而那个桶是 StagerFn 在同一次部署中填的。少一条依赖的症状是**偶发**的
   *  `Error occurred while GetObject. S3 Error Code: NoSuchKey`：CFN 会并行创建，
   *  函数可能比产物先到。方式B 用 fromAsset（资产在 cdk deploy 前就上传好了），不需要。 */
  functions: lambda.Function[];
  /** 三个 IM 函数共用的那份环境变量（表名 / 区域 / 桶 / CDN …）。
   *
   *  方式A 的 **DevOps Agent 调查回调** Lambda 建在栈里（方式B 建在自己那个栈层），
   *  它读的表和桶与 IM 侧是同一批。暴露出来让那边直接 `...im.commonEnv` 展开，而不是
   *  在栈里再抄一份：抄一份的症状是静默的 —— 少注一个表名，回调就把报告写到"没有
   *  消费者"的地方，IM 面板照样显示调查已结束。*/
  commonEnv: Record<string, string>;
  /** 本次实际生效的 Secret 名（props 没给就是默认值）。
   *
   *  同上：回调 Lambda 要靠 `FEISHU_SECRET_NAME` / `SLACK_BOT_TOKEN_ARN` 才发得出卡片，
   *  而 `imRole` 的 secretsmanager 语句是按**这三个名字**收窄的。两处必须同源。 */
  secretNames: { feishu: string; slackBotToken: string; slackSigningSecret: string };
}

export function createImCore(scope: Construct, props: ImCoreProps): ImCoreResult {
  const feishuSecret = props.secretNames?.feishu ?? "notiops/im-bot-feishu";
  const slackTokenSecret = props.secretNames?.slackBotToken ?? "notiops/slack-bot-token";
  const slackSigningSecret = props.secretNames?.slackSigningSecret ?? "notiops/slack-signing-secret";

  // ─── 公共环境变量 ─────────────────────────────────────────────────────────
  // 对齐 BotStack 里 Fargate 容器的 environment，**去掉** MCP sidecar 那两个
  // endpoint/enable：Lambda 里没有 sidecar，留着 enable=true 只会让 LLM 看到
  // 一批必然超时的工具。IM 侧的 chat 现在直连 DevOps Agent（0 token），本来也不需要。
  const commonEnv: Record<string, string> = {
    BEDROCK_REGION: cdk.Aws.REGION,
    DEVOPS_AGENT_REGION: cdk.Aws.REGION,
    AGENTIC_CHAT_MODE: "enabled",
    AWS_MCP_MODE: "docs_only",
    CONVERSATIONS_TABLE: props.conversationsTableName,
    METRICS_TABLE: props.metricsTableName,
    CONFIG_TABLE: props.configTableName,
    DEFAULT_INVESTIGATION_ACCOUNT_ID: cdk.Aws.ACCOUNT_ID,
    LOCKED_ACCOUNT_ID: props.lockedAccountId,
    SKILLS_BUCKET: props.skillsBucketName,
    SKILL_DISPATCH_ENABLED: "false",
    // 排障 Agent Space（深度调查 / 直连问答都用它）。与 web 侧
    // `web-chat-core.ts` 的 `DEVOPS_AGENT_SPACE_ID` 逐字同源。空串 = 回退
    // `ListAgentSpaces` 自动发现（见上面 prop 注释里那条已命中客户的坑）。
    DEVOPS_AGENT_SPACE_ID: props.devopsAgentSpaceId ?? "",
    AWS_MCP_PRICING_ENABLED: "false",
    AWS_MCP_COST_ENABLED: "false",
    // 长回答落 HTML 报告的链接域名（`core/reports.py`）。空串 = 回退 presigned。
    // ⚠️ 与 IM **调查报告**那条链路无关 —— 那个落 `investigations/<task_id>/`，
    // CDN 只放行 `reports/*`，所以调查报告注定是 presigned（见 §3.18，别当回归）。
    REPORTS_CDN_DOMAIN: props.reportsCdnDomain ?? "",
  };
  // 注：AWS_REGION 是 Lambda 运行时保留环境变量，显式设会被 CFN 拒（Fargate 上没这限制）。

  // ─── 共用 IAM 角色 ────────────────────────────────────────────────────────
  // 与 BotStack 的 Fargate task role 逐条对齐（DDB / Bedrock / STS / aidevops /
  // support / S3 / SSM / SecretsManager），**不含** grantMcpReadOnly：那批
  // pricing/ce/compute-optimizer 权限只服务 MCP sidecar，Lambda 上没有 sidecar。
  const imRole = new iam.Role(scope, "ImLambdaRole", {
    assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
    description: "NotiOps IM Lambda (ingress/worker/progress) execution role",
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
    ],
  });

  imRole.addToPrincipalPolicy(new iam.PolicyStatement({
    // 最小权限：item 级读写 + Query（不需要 DeleteTable/UpdateTable 等控制面）。
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

  // Bedrock —— IM 侧只有**案例路径**还调 LLM（意图抽取/分类）。
  // 三个 kind 都要能跑（bedrock_anthropic / bedrock_converse / bedrock_mantle_responses），
  // 否则换模型后 IM 案例路径会 AccessDenied 而 web 端正常，排查起来极其误导。
  // 资源宽度与 BotStack 一致，理由见那边的长注释（Mantle 的 project 资源维度）。
  imRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock-mantle:CreateInference",
    ],
    resources: ["*"],
  }));

  // STS AssumeRole —— create_investigation 需要 assume 目标账号的 Trigger Role
  // （本账号也要自 assume）。
  imRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ["sts:AssumeRole"],
    resources: [`arn:aws:iam::${cdk.Aws.ACCOUNT_ID}:role/notiops-agent-trigger-*`],
  }));

  // DevOps Agent —— progress Lambda 读 journal 增量刷卡片；worker 发起调查 + 直连对话。
  // 比 BotStack 宽：Fargate 时代发起调查走 AssumeRole 后的 Trigger Role 凭证，所以
  // task role 上只要 journal 读权限。M1 的「发起调查 / 对话直连」是**用本函数自己的
  // 凭证**打 DevOps Agent 的（0 token 的关键：不再经 LLM 中转），所以本角色必须自己拿得到。
  //
  // ⚠️⚠️ 动作名必须是 **DevOps Agent 真实 API 名**，逐条对应 core/ 里的 boto3 调用：
  //   CreateBacklogTask   ← devops_agent.start_investigation   (client.create_backlog_task)
  //   GetBacklogTask      ← devops_agent.poll_investigation    (client.get_backlog_task)
  //   ListJournalRecords  ← devops_agent._list_all_records     (client.list_journal_records)
  //   ListRecommendations ← devops_agent.get_recommendations_md(client.list_recommendations)
  //   CreateChat          ← devops_chat.new_chat               (client.create_chat)
  //   SendMessage         ← devops_chat.stream_once            (client.send_message)
  //   ListPendingMessages ← devops_chat（探"是否在等人工确认"）(client.list_pending_messages)
  // 2026-09-02 之前这里写的是 CreateTask / GetTask / ListTasks / StartTaskExecution /
  // GetTaskExecution / ListTaskExecutions / SendTaskMessage —— **这七个动作名根本不存在**。
  // IAM 不校验动作名拼写，`cdk deploy` 和策略校验器全都过，症状只在运行时出现：
  // 飞书「深度调查」→「发起调查失败：AccessDeniedException/AccessDeniedException」，
  // 而 web 端一切正常（web 走 web-chat-core.ts 里那份**名字对的**授权）。现网实测踩到。
  // 判据在 [tests/test_im_devops_agent_iam.py](../../../tests/test_im_devops_agent_iam.py)：
  // 把这份清单与 core/ 里真实的 boto3 调用做**双向**比对（少了 = 运行时 AccessDenied，
  // 多了 = 拼错的名字或权限蔓延）。加新调用时先看那个测试的报错。
  imRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: [
      "aidevops:CreateBacklogTask",
      "aidevops:GetBacklogTask",
      "aidevops:ListJournalRecords",
      "aidevops:ListRecommendations",
      "aidevops:CreateChat",
      "aidevops:SendMessage",
      "aidevops:ListPendingMessages",
    ],
    resources: [`arn:aws:aidevops:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:agentspace/*`],
  }));
  // ListAgentSpaces 是账号级动作（没有 agentspace 资源维度可挂），单独放一条。
  imRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ["aidevops:ListAgentSpaces"],
    resources: ["*"],
  }));

  // AWS Support API —— 案例全生命周期。
  imRole.addToPrincipalPolicy(new iam.PolicyStatement({
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

  // S3 —— skill 注册表（skills/ 前缀）+ MCP 规格快照（mcp-snapshots/ 前缀）
  // + 长回答落的 HTML 报告（reports/ 前缀，`core/reports.py`）。
  //
  // ⚠️ `reports/*` 上 **GetObject 也要**，不只是 PutObject（web 端的 BFF 只给了 Put）。
  // 差别在读法：web 端一律走 ReportsCDN（OAC 用的是 CloudFront 自己的身份），而 IM 侧
  // 在**没有** REPORTS_CDN_DOMAIN 时要回退 presigned GET —— presigned URL 携带的是
  // **签名者的权限**，签名方缺 GetObject 时链接照样生成，点开才 AccessDenied。
  imRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ["s3:ListBucket"],
    resources: [`arn:aws:s3:::${props.skillsBucketName}`],
    conditions: { StringLike: { "s3:prefix": ["skills/*", "skills/"] } },
  }));
  imRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ["s3:GetObject", "s3:PutObject"],
    resources: [
      `arn:aws:s3:::${props.skillsBucketName}/skills/*`,
      `arn:aws:s3:::${props.skillsBucketName}/mcp-snapshots/*`,
      `arn:aws:s3:::${props.skillsBucketName}/reports/*`,
    ],
  }));

  // SSM —— model_id 等配置。
  imRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ["ssm:GetParameter"],
    resources: [`arn:aws:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter/notiops/*`],
  }));

  // Secrets Manager —— 飞书凭证 + Slack token + Bedrock API Key。
  // 缺 bedrock-api-key 那条的失败模式是**静默的**（回退 IAM 角色，对话照常但 Key 永不生效）。
  imRole.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ["secretsmanager:GetSecretValue"],
    resources: [
      `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${feishuSecret}-*`,
      `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${slackTokenSecret}-*`,
      `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:${slackSigningSecret}-*`,
      `arn:aws:secretsmanager:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:secret:notiops/bedrock-api-key-*`,
    ],
  }));

  // 显式建 LogGroup。不给的话 Lambda 服务自建一个 `/aws/lambda/<名>` —— 那个组
  // **不属于任何栈**：永不过期(白留日志费)、删栈不消失。方式A 走"建组但不指定名字 +
  // LoggingConfig 指过来"（见文件头差异表第 3 条）。
  const createLogGroup = (id: string, fnName: string) =>
    new logs.LogGroup(scope, id, {
      logGroupName: props.explicitLogGroupNames ? `/aws/lambda/${fnName}` : undefined,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

  const commonFnProps = {
    runtime: lambda.Runtime.PYTHON_3_14,
    role: imRole,
    code: props.code,
    layers: [props.layer],
    architecture: lambda.Architecture.X86_64,  // 层是 manylinux2014_x86_64
  };

  const result: ImCoreResult = {
    imRole,
    functions: [],
    commonEnv,
    secretNames: {
      feishu: feishuSecret,
      slackBotToken: slackTokenSecret,
      slackSigningSecret,
    },
  };

  // ─── 飞书 ──────────────────────────────────────────────────────────────
  if (props.platforms.feishu) {
    const workerName = props.fnName("worker-feishu");
    const workerFn = new lambda.Function(scope, "FeishuWorker", {
      ...commonFnProps,
      functionName: workerName,
      handler: "platforms.feishu.lambda_worker.handler",
      logGroup: createLogGroup("FeishuWorkerLogs", workerName),
      // 900s：worker 要 join main.py 里起的后台线程（confirm_dispatch 等），
      // 并且案例路径含多次 LLM 调用。见 lambda_worker._THREAD_JOIN_TIMEOUT=600。
      timeout: cdk.Duration.seconds(900),
      memorySize: 1024,
      environment: {
        ...commonEnv,
        FEISHU_SECRET_NAME: feishuSecret,
        ALLOWED_CHAT_IDS: props.allowedChatIds,
      },
      description: "NotiOps Feishu IM worker -- deterministic routing to DevOps Agent chat / investigation / support cases",
    });
    result.functions.push(workerFn);

    const ingressFn = new lambda.Function(scope, "FeishuIngress", {
      ...commonFnProps,
      functionName: props.fnName("ingress-feishu"),
      handler: "platforms.feishu.lambda_ingress.handler",
      logGroup: createLogGroup("FeishuIngressLogs", props.fnName("ingress-feishu")),
      // 20s / 2048MB —— 这两个数都是**冷启动**决定的，不是干活决定的（干活只有验签
      // + 异步投递，warm 路径几十毫秒）。
      //
      // ⚠️ 2026-09-02 现网实测，别往下调。`import lark_oapi`（+ boto3 + 读 secret）
      // 是重 import，而 Lambda 的 **INIT 阶段有 10s 硬上限**（不受函数 timeout 影响）。
      // 撞上限的日志形态是：
      //   INIT_REPORT ... Phase: init   Status: timeout   (10s 硬上限)
      // 之后 Lambda 会把 init 挪到**首次 invoke 里重跑**，那一次才受函数 timeout 约束。
      // 实测三档（现网 notiops-im-ingress-feishu）：
      //   512MB / 10s  → init 撞上限，重跑又撞函数 timeout（也是 10s）→ 对外一律
      //                  `HTTP 500 {"message":"Internal Server Error"}`，而且**日志里
      //                  没有任何异常**（只有两行 timeout），极难定位。
      //   1024MB / 20s → init 仍然撞 10s 上限；重跑用了 **11.7s** 才跑完 —— 靠 20s
      //                  timeout 兜住了，但冷启动那一次对外要等 ~22s（10s 白烧 + 11.7s），
      //                  飞书保存请求地址时的 URL challenge 等不了这么久。
      //   2048MB / 20s → 当前值。曾经量到 init **8.65s 跑完**（`Phase: init Status: error`
      //                  而不是 `Status: timeout`），勉强压回 10s 上限内。
      //
      // ⚠️ 2048 基本就是"加内存"这条路的**天花板**，别指望往上堆能再快：Lambda 到
      // **1769MB 就给满 1 个 vCPU**，再往上是给第 2 个 vCPU，而 Python import 是
      // **单线程串行**的 —— 3072 / 4096 对这段几乎没有收益，只是多花钱。
      //
      // ── 2026-09-03 补记：上面那个 8.65s 是**侥幸值，已经回不去了** ──────────────
      // 现网近 7 天 10 次冷启动里，7 次 `Phase: init Status: timeout`（9999.xx ms），
      // 其中 3 次重跑死在 `Phase: invoke Status: error  Error Type: Runtime.Unknown`。
      // 也就是说"加内存"这条路已经走到头了，真正的根因在别处：
      //   层在 Lambda 上是**只读挂载** → CPython 写不出 `__pycache__` → **每一次**冷启动
      //   都要把整个层从 .py 重新编译，而 `import lark_oapi` 一家就是 **9128 个模块**
      //   （SDK 的 `__init__.py` 里 `from .api import *` 把 54 个业务 namespace 全 eager
      //   import，我们只用 `im`）。本机 python 3.14.5 实测：无 .pyc 9.5~12.7s，
      //   有 .pyc 2.9~5.4s（3.3 倍）。
      // 修法是在构建期预编译（`scripts/build_im_layer.sh` 的「预编译字节码」段 +
      // `im-stack.ts` 的 synth 期门禁），**不动 SDK 一行源码**；层 87MB → 152MB。
      // 所以这里的 20s / 2048MB 保持不变：它们是那次实验留下的安全余量，不是根治手段。
      // 还想再压的话，剩下的 lever 是"减少 init 本身的活"：把 GetSecretValue 挪进
      // handler（用全局变量缓存）—— 仍然 fail-closed（第一次调用就崩），但会把 fail-fast
      // 从"冷启动即崩"变成"首次调用即崩"，动它之前先想清楚 lambda_ingress.py 文件头
      // 「硬约束 A」还算不算成立。（"从 lark_oapi 里只 import 用到的符号"这条**已经验证
      // 走不通**：`EventDispatcherHandler` 自己就硬 import 22 个 namespace 的 processor，
      // 把 `api/__init__.py` + `client.py` 改成 lazy 也只从 9128 降到 6012 个模块。）
      // 20s 保留作第二道保险：万一某次 init 还是超 10s，重跑的那次有余量跑完并正常
      // 响应，而不是给飞书一个 500。
      // 成本：warm 调用只有几十毫秒，2048MB 的 GB-s 差异在真实 IM 事件量下可忽略。
      // 飞书 card.action.trigger 的 ~3s 硬超时与这里无关 —— 那要求的是 warm 路径
      // 快速 ACK，冷启动那一次本来就赶不上（worker 会补一条「再试一次」）。
      timeout: cdk.Duration.seconds(20),
      memorySize: 2048,
      // 公网未鉴权入口的并发（=花费）上限，与 HTTP API 的阶段级限流互补：
      // 那层管 QPS、这层管同时在跑的实例数。飞书正常事件量远低于 10 并发；
      // 被刷时超出的请求直接 429，不产生费用。
      reservedConcurrentExecutions: 10,
      environment: {
        ...commonEnv,
        FEISHU_SECRET_NAME: feishuSecret,
        FEISHU_WORKER_FUNCTION: workerFn.functionName,
        // ingress 也要这份群允许清单：它在投完 worker 之后给用户那条消息贴一个
        // "收到了"的表情（platforms/common/quick_ack.py）。不给的话，配了清单的客户
        // 会在**清单外**的群里看到表情却等不到回复。worker 侧那份仍是权威判定。
        ALLOWED_CHAT_IDS: props.allowedChatIds,
      },
      description: "NotiOps Feishu IM ingress -- HTTP API webhook: verify + decrypt, invoke the worker asynchronously, ACK immediately",
    });
    result.functions.push(ingressFn);
    grantInvokeWorkerByName(imRole, workerName);

    const feishuApi = createIngressHttpApi(
      scope,
      "FeishuIngressApi",
      ingressFn,
      props.fnName("ingress-feishu"),
      "NotiOps Feishu IM webhook front door -- catch-all route to the ingress Lambda",
    );
    result.feishuWebhookUrl = feishuApi.url;

    const feishuKeepAlive = createIngressKeepAlive(
      scope,
      "FeishuIngressKeepAlive",
      ingressFn,
      props.keepAliveRuleName?.("ingress-feishu"),
      "Keeps the NotiOps Feishu IM ingress Lambda warm -- Feishu times out webhooks at ~3s while a cold start blows the 10s init limit and lands at ~22s end to end (measured 2026-09-03)",
    );

    if (props.conditions?.feishu) {
      applyConditionDeep(workerFn, props.conditions.feishu);
      applyConditionDeep(ingressFn, props.conditions.feishu);
      // 规则本体 + 它给 ingress 加的那条 AWS::Lambda::Permission（挂在函数子树里，
      // 上一行已捞到）。漏了规则的症状：只装 web 的栈里留一条指向不存在函数的规则。
      applyConditionDeep(feishuKeepAlive, props.conditions.feishu);
      applyConditionDeep(workerFn.logGroup as unknown as Construct, props.conditions.feishu);
      applyConditionDeep(ingressFn.logGroup as unknown as Construct, props.conditions.feishu);
      // HTTP API 那棵子树：Api / Route / Integration / Stage，以及集成给 ingress
      // 加的那条 AWS::Lambda::Permission（它挂在 **Route** 底下，不在函数子树里 ——
      // 上面两行捞不到它，漏了就是「选 web 却留下引用不存在 API 的 Permission」）。
      applyConditionDeep(feishuApi.api, props.conditions.feishu);
    }
  }

  // ─── Slack（M3）─────────────────────────────────────────────────────────
  if (props.platforms.slack) {
    const slackWorkerName = props.fnName("worker-slack");
    const slackWorkerFn = new lambda.Function(scope, "SlackWorker", {
      ...commonFnProps,
      functionName: slackWorkerName,
      handler: "platforms.slack.lambda_worker.handler",
      logGroup: createLogGroup("SlackWorkerLogs", slackWorkerName),
      timeout: cdk.Duration.seconds(900),
      memorySize: 1024,
      environment: {
        ...commonEnv,
        // ⚠️ 变量名沿用 BotStack 的 `SLACK_BOT_TOKEN_ARN`（值其实是 secret **名**，
        // GetSecretValue 两种都吃）。改名会打掉 platforms/slack/app/progress_sender.py
        // 里 `os.environ.get("SLACK_BOT_TOKEN_ARN")` 那条读取 —— 那个模块 worker 复用。
        SLACK_BOT_TOKEN_ARN: slackTokenSecret,
        SLACK_SIGNING_SECRET_ARN: slackSigningSecret,
        // Slack 侧的群白名单变量名是 `ALLOWED_CHANNEL_IDS`（飞书那边叫
        // ALLOWED_CHAT_IDS）—— 沿用 platforms/slack/app/main.py:110 的既有口径，
        // 别为了"统一"改名：改了等于给 Fargate 回滚路径埋一个空白名单。
        ALLOWED_CHANNEL_IDS: props.allowedChatIds,
      },
      description: "NotiOps Slack IM worker -- shares platforms/common/router.py with the Feishu worker",
    });
    result.functions.push(slackWorkerFn);

    const slackIngressFn = new lambda.Function(scope, "SlackIngress", {
      ...commonFnProps,
      functionName: props.fnName("ingress-slack"),
      handler: "platforms.slack.lambda_ingress.handler",
      logGroup: createLogGroup("SlackIngressLogs", props.fnName("ingress-slack")),
      // Slack 的硬超时是 3s（events + interactivity 都是），同飞书 —— 但这两个数
      // 同样是冷启动定的，理由与上面飞书 ingress 那段完全一致（SDK import 撞 Lambda
      // 的 10s INIT 硬上限 → 对外 500 且日志无异常；1024MB 仍然不够）。
      // 两边必须一起改，别只改一边：Slack 这条路的 import（slack_sdk + boto3）
      // 量级与 lark_oapi 相当。
      timeout: cdk.Duration.seconds(20),
      memorySize: 2048,
      reservedConcurrentExecutions: 10,
      environment: {
        ...commonEnv,
        // signing secret 用来验签；bot token 用来在投完 worker 之后给用户那条消息贴
        // 一个"收到了"的表情（`reactions.add`，见 platforms/common/quick_ack.py）——
        // 2026-09-03 之前这里的注释写着"ingress 不发消息"，现在**发**这一件事。
        SLACK_BOT_TOKEN_ARN: slackTokenSecret,
        SLACK_SIGNING_SECRET_ARN: slackSigningSecret,
        SLACK_WORKER_FUNCTION: slackWorkerFn.functionName,
        // 同飞书 ingress：贴表情前要过一遍群允许清单，否则清单外的群会看到表情却没回复。
        ALLOWED_CHANNEL_IDS: props.allowedChatIds,
      },
      description: "NotiOps Slack IM ingress -- HTTP API webhook: verify the signature, invoke the worker asynchronously, ACK immediately",
    });
    result.functions.push(slackIngressFn);
    grantInvokeWorkerByName(imRole, slackWorkerName);

    const slackApi = createIngressHttpApi(
      scope,
      "SlackIngressApi",
      slackIngressFn,
      props.fnName("ingress-slack"),
      "NotiOps Slack IM webhook front door -- catch-all route to the ingress Lambda",
    );
    result.slackWebhookUrl = slackApi.url;

    const slackKeepAlive = createIngressKeepAlive(
      scope,
      "SlackIngressKeepAlive",
      slackIngressFn,
      props.keepAliveRuleName?.("ingress-slack"),
      "Keeps the NotiOps Slack IM ingress Lambda warm -- Slack times out webhooks at 3s while a cold start blows the 10s init limit and lands at ~22s end to end (measured 2026-09-03)",
    );

    if (props.conditions?.slack) {
      applyConditionDeep(slackWorkerFn, props.conditions.slack);
      applyConditionDeep(slackIngressFn, props.conditions.slack);
      applyConditionDeep(slackKeepAlive, props.conditions.slack);
      applyConditionDeep(slackWorkerFn.logGroup as unknown as Construct, props.conditions.slack);
      applyConditionDeep(slackIngressFn.logGroup as unknown as Construct, props.conditions.slack);
      applyConditionDeep(slackApi.api, props.conditions.slack);
    }
  }

  // ─── 调查进度轮询（平台无关）───────────────────────────────────────────
  // 取代 Fargate 里的 progress_poller 常驻线程。1 分钟一跳；没有在飞的调查时
  // list_im_tasks 返回空、函数 ~100ms 结束（月成本 < $0.02）。
  // 只要启用了任一 IM 平台就需要它。
  if (props.platforms.feishu || props.platforms.slack) {
    const progressName = props.fnName("progress");
    const progressFn = new lambda.Function(scope, "ImProgress", {
      ...commonFnProps,
      functionName: progressName,
      // 平台无关：一个函数服务飞书 + Slack（imtask# 是跨平台共享的一张表，
      // 每平台各起一个函数只会互相抢着改同一批行）。分派表见该模块文件头。
      handler: "platforms.common.lambda_progress.handler",
      logGroup: createLogGroup("ImProgressLogs", progressName),
      // 一跳最多扫 50 行（list_im_tasks(limit=50)），每行一次 poll_investigation。
      timeout: cdk.Duration.seconds(300),
      memorySize: 512,
      environment: {
        ...commonEnv,
        FEISHU_SECRET_NAME: feishuSecret,
        // Slack 分支走 platforms/slack/caps.py::get_client（chat.update 要 bot token）。
        // 少了这条的失败模式：飞书进度正常、Slack 的进度卡片永远停在「已发起」，
        // 而日志里只有一行 warning —— 所以哪个平台没启用都照样给。
        SLACK_BOT_TOKEN_ARN: slackTokenSecret,
      },
      description: "NotiOps IM investigation progress poller (Feishu + Slack) -- scans imtask# rows and patches the progress card",
    });
    result.functions.push(progressFn);

    const rule = new events.Rule(scope, "ImProgressSchedule", {
      ruleName: props.progressRuleName,
      description: "Ticks the NotiOps IM investigation progress poller every minute",
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [new targets.LambdaFunction(progressFn)],
    });

    if (props.conditions?.anyPlatform) {
      // 顺序无关，但**都要**：progress 函数、它的日志组、规则本体，以及规则给函数
      // 加的那条 AWS::Lambda::Permission（挂在函数子树里，靠 applyConditionDeep 捞）。
      applyConditionDeep(progressFn, props.conditions.anyPlatform);
      applyConditionDeep(progressFn.logGroup as unknown as Construct, props.conditions.anyPlatform);
      applyConditionDeep(rule, props.conditions.anyPlatform);
      applyConditionDeep(imRole, props.conditions.anyPlatform);
    }
  }

  return result;
}
