/**
 * 一键部署（Launch Stack）的 **standalone 单栈** —— 客户点一个链接就把 NotiOps Web Chat
 * 整套装起来：最小底座（Cognito + notiops-config + 数据桶）+ Web Chat（BFF/前端/CDN/RUM）
 * + AgentCore Runtime，全在一个 CloudFormation 模板里，不需要 `cdk bootstrap`、
 * 不需要本地装工具链、不需要 AKSK。对客说明见 docs/DEPLOYMENT_ONECLICK.md。
 *
 * ⚠️ 这个栈**只用于**生成静态模板，不参与 `setup.sh` / `cdk deploy` 那条路径。
 * 它的合成入口是 `infra/bin/standalone.ts`（**不带 env**，于是账号/区域都落成
 * `AWS::AccountId` / `AWS::Region` 伪参数，同一份模板任意账号任意区域可用）。
 * 合成后必须再跑 `scripts/postprocess_template.py`（Step 2）才是可发布的模板。
 *
 * ── 三条它与普通 CDK 栈的根本差别 ─────────────────────────────────────────────
 * 1. **不能有任何 CDK 资产（asset）。** 客户账号没有 bootstrap 出来的资产桶。
 *    唯一的例外是 BFF 那个 `Code.fromAsset`：它的 `S3Bucket` 由 postprocess 改写成
 *    `!Ref StagingBucket`，代码本体由 StagerFn 从 GitHub Release 搬进那个桶。
 *    因此本文件里**不要**用 `BucketDeployment`、`autoDeleteObjects`、`logRetention`、
 *    `cr.Provider`、`NodejsFunction`、`Code.fromAsset` —— 它们全都会拉出隐式资产。
 *    这也正是 `createWebChatCore({ staticTemplate: true })` 那个开关的全部意义。
 * 2. **可变项走 CFN Parameters，不走 `-c` context。** 模板是预先合成好发布出去的，
 *    合成时不知道客户的邮箱/域名，只有部署期才知道。
 * 3. **删栈要自己收尾。** 没有 `Custom::S3AutoDeleteObjects`，桶非空就删不掉；
 *    `Retain` 的数据资源 CFN 根本不碰。都由 StagerFn 的 Delete 阶段处理。
 */
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as fs from "fs";
import * as path from "path";
import { createMinimalBase } from "./constructs/minimal-base-core";
import { createWebChatCore } from "./constructs/web-chat-core";

const INFRA_DIR = path.join(__dirname, "..");

/** AgentCore Runtime 名（只允许字母数字下划线，不能带连字符）。 */
const RUNTIME_NAME = "notiops_web_chat";

/**
 * `Mappings` 里那份「本模板对应哪个 Release」的占位值。
 * `scripts/postprocess_template.py` 会把它改写成真实的 tag。
 * 故意用一个明显不是版本号的值：万一有人直接部署未经 postprocess 的裸 synth 产物，
 * 报错里会带上 `0.0.0-UNPROCESSED`，一眼看出漏了哪一步。
 */
const RELEASE_TAG_PLACEHOLDER = "0.0.0-UNPROCESSED";
const RELEASE_BASEURL_PLACEHOLDER =
  `https://github.com/aws-samples/sample-notiops/releases/download/${RELEASE_TAG_PLACEHOLDER}`;

export class NotiOpsWebChatStandaloneStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ══ Parameters ════════════════════════════════════════════════════════════
    const adminEmail = new cdk.CfnParameter(this, "AdminEmail", {
      type: "String",
      description:
        "First administrator's email. Cognito emails a temporary password to this address " +
        "after the stack completes; the login name is 'admin'. Must be a real mailbox -- " +
        "it is the only way in.",
      allowedPattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
      constraintDescription: "Must be a valid email address.",
    });

    // CORS 白名单。默认 "*" 的理由与 CDK 路径一致（端点已由 AWS_IAM/SigV4 鉴权，
    // 且前端 CloudFront 域名是部署期才生成的、模板里无从预置）。一键部署这条路上
    // 尤其无解：模板必须先算出 Function URL 的 CORS 配置，而 CloudFront 分配在它之后
    // 才创建（资源顺序不能动，见 web-chat-core.ts 的逻辑 ID 说明）。
    // 客户想收窄：第一次部署完拿到 ChatUrl，再更新栈把这个参数填成那个域名。
    const allowedOrigins = new cdk.CfnParameter(this, "AllowedOrigins", {
      type: "CommaDelimitedList",
      default: "*",
      description:
        "CORS allowed origins for the chat API. Defaults to * (the endpoint is already " +
        "protected by AWS_IAM/SigV4). After the first deploy you can update the stack and " +
        "set this to the ChatUrl output for defence in depth.",
    });

    const teardownMode = new cdk.CfnParameter(this, "TeardownMode", {
      type: "String",
      default: "KeepData",
      allowedValues: ["KeepData", "DeleteEverything"],
      description:
        "What happens to your data when you delete this stack. KeepData: the notiops-config " +
        "table, the chat history table and the data bucket survive. DeleteEverything: they are " +
        "deleted too. IMPORTANT: CloudFormation hands custom resources the values from the last " +
        "successful deploy, so to switch to DeleteEverything you must UPDATE the stack first, " +
        "then delete it.",
    });

    const artifactBaseUrl = new cdk.CfnParameter(this, "ArtifactBaseUrl", {
      type: "String",
      default: "",
      description:
        "Optional. Where to download the release artifacts from, if this account cannot reach " +
        "GitHub. Mirror bff.zip / chat-dist.zip / agent-code.zip somewhere reachable and put the " +
        "base here: either s3://my-bucket/my/prefix (read with your own credentials -- no public " +
        "access needed, also set the bucket name below) or https://host/path (plain unauthenticated " +
        "GET). Leave empty to use the public GitHub release.",
    });

    // s3:// 镜像要读得到，就得给 StagerFn 的角色 GetObject —— 而桶名只有客户知道。
    // 为什么单列一个参数、不从 ArtifactBaseUrl 里解析出桶名：CFN 没有字符串切分，
    // 解析只能在 Lambda 里做，而 IAM 策略是模板期就要定下来的东西。
    // 为什么不干脆授 `arn:aws:s3:::*/*`：那是一张"读本账号任意桶任意对象"的通行证，
    // 装在一个客户点两下就开起来的模板里，安全 review 第一条就该拦下来。
    const artifactMirrorBucket = new cdk.CfnParameter(this, "ArtifactMirrorBucket", {
      type: "String",
      default: "",
      description:
        "Only needed when the artifact base above is an s3:// URI: the name of that bucket. " +
        "The deployment helper is granted s3:GetObject on this bucket and nothing else.",
    });

    const agentReadOnlyAccess = new cdk.CfnParameter(this, "AgentReadOnlyAccess", {
      type: "String",
      default: "Yes",
      allowedValues: ["Yes", "No"],
      description:
        "Attach the AWS-managed ReadOnlyAccess policy to the agent so it can answer questions " +
        "about any resource in this account. Choose No to restrict the agent to the explicit " +
        "read-only grants below (cost, logs, metrics, RDS/EC2 describe) -- some questions will " +
        "then fail with an access-denied message naming the missing action.",
    });

    // 深度调查（AWS DevOps Agent）—— 要在本账号建一个 Agent Space。
    // 给开关而不是一律建：DevOps Agent 只在部分区域可用，且它是**另一个计费服务**
    // （按 agent-second 计费；空 Agent Space 不产生费用，但客户仍有权选择不建）。
    const enableDeepInvestigation = new cdk.CfnParameter(this, "EnableDeepInvestigation", {
      type: "String",
      default: "Yes",
      allowedValues: ["Yes", "No"],
      description:
        "Create an AWS DevOps Agent Agent Space so the assistant can run deep root-cause " +
        "investigations. Billed per agent-second only while an investigation runs; an idle " +
        "Agent Space costs nothing. Silently skipped in Regions where AWS DevOps Agent is not " +
        "available yet -- the stack still deploys and everything else works.",
    });

    // ── 单账号 / 多账号 ──
    // 为什么这是**部署期**参数而不是合成期 context：模板是预先发布出去的一份静态文件，
    // 合成时不知道客户有没有 Organizations。于是受它影响的一切都得落成 Condition。
    const deployMode = new cdk.CfnParameter(this, "DeployMode", {
      type: "String",
      default: "SingleAccount",
      allowedValues: ["SingleAccount", "MultiAccount"],
      description:
        "SingleAccount: NotiOps only looks at the account you deploy into. MultiAccount: also " +
        "inspect and investigate other accounts in your AWS Organization -- you then onboard them " +
        "one click at a time from the admin console. MultiAccount REQUIRES that you deploy into " +
        "the organization management account (or a CloudFormation StackSets delegated " +
        "administrator) and that you fill in the organization id below.",
    });

    const organizationId = new cdk.CfnParameter(this, "OrganizationId", {
      type: "String",
      default: "",
      allowedPattern: "^(o-[a-z0-9]{10,32})?$",
      constraintDescription: "Must be an AWS Organizations id (o-xxxx...) or empty.",
      description:
        "Required when the deployment mode above is MultiAccount, ignored otherwise. Find it with " +
        "'aws organizations describe-organization'. It is used to scope the cross-account trust " +
        "policies to your organization (aws:PrincipalOrgID), so leaving it out is not just " +
        "inconvenient -- MultiAccount stays off without it.",
    });

    // 控制台参数分组 —— 一键部署的门面就是那个参数页，顺序/分组直接决定客户观感。
    this.templateOptions.metadata = {
      "AWS::CloudFormation::Interface": {
        ParameterGroups: [
          { Label: { default: "Required" }, Parameters: [adminEmail.logicalId] },
          {
            Label: { default: "Scope" },
            Parameters: [deployMode.logicalId, organizationId.logicalId, enableDeepInvestigation.logicalId],
          },
          {
            Label: { default: "Security (safe defaults -- change only if you know why)" },
            Parameters: [agentReadOnlyAccess.logicalId, allowedOrigins.logicalId],
          },
          {
            Label: { default: "Lifecycle & advanced" },
            Parameters: [teardownMode.logicalId, artifactBaseUrl.logicalId, artifactMirrorBucket.logicalId],
          },
        ],
        ParameterLabels: {
          [adminEmail.logicalId]: { default: "Administrator email" },
          [deployMode.logicalId]: { default: "Deployment mode" },
          [organizationId.logicalId]: { default: "AWS Organizations id (MultiAccount only)" },
          [enableDeepInvestigation.logicalId]: { default: "Enable deep investigation (AWS DevOps Agent)?" },
          [agentReadOnlyAccess.logicalId]: { default: "Give the agent account-wide read-only access?" },
          [allowedOrigins.logicalId]: { default: "CORS allowed origins" },
          [teardownMode.logicalId]: { default: "On stack delete" },
          [artifactBaseUrl.logicalId]: { default: "Artifact base URL override" },
          [artifactMirrorBucket.logicalId]: { default: "Artifact mirror bucket name (s3:// only)" },
        },
      },
    };

    // ══ Conditions ════════════════════════════════════════════════════════════
    // AWS DevOps Agent 只在这些区域可用（docs.aws.amazon.com/devopsagent →
    // "Supported Regions"）。为什么要把区域也编进条件、而不是只给客户一个 Yes/No：
    // 在不支持的区域建 Agent Space 会 CREATE_FAILED，**整栈回滚** —— 一键部署的客户
    // 大概率不知道这个限制，那就是"点一下、等 5 分钟、什么都没有"。硬编码这份清单会
    // 随 AWS 开区变旧，但它旧的方向是安全的：新开的区域先按"不支持"处理（拿不到深度
    // 调查，其余功能全在），下个 Release 补上即可。Fn::Or 最多 10 项，故拆两段。
    const daRegionsA = ["us-east-1", "us-west-2", "ca-central-1", "sa-east-1", "ap-south-1", "ap-southeast-1"];
    const daRegionsB = ["ap-southeast-2", "ap-northeast-1", "eu-central-1", "eu-west-1", "eu-west-2"];
    const inRegions = (id: string, regions: string[]) =>
      new cdk.CfnCondition(this, id, {
        expression: cdk.Fn.conditionOr(...regions.map((r) => cdk.Fn.conditionEquals(cdk.Aws.REGION, r))),
      });
    // 拆出「客户要了」这个单独的条件，Outputs 才分得清"你自己关的"和"这个区没有"。
    const deepInvestigationRequested = new cdk.CfnCondition(this, "DeepInvestigationRequested", {
      expression: cdk.Fn.conditionEquals(enableDeepInvestigation.valueAsString, "Yes"),
    });
    const deepInvestigationEnabled = new cdk.CfnCondition(this, "DeepInvestigationEnabled", {
      expression: cdk.Fn.conditionAnd(
        deepInvestigationRequested,
        // CfnCondition 本身就是一个 ICfnConditionExpression，resolve 成 `{Condition: id}`
        // —— 于是这里是"引用另一个命名条件"，不是把表达式再抄一遍。
        cdk.Fn.conditionOr(
          inRegions("DevOpsAgentRegionsA", daRegionsA),
          inRegions("DevOpsAgentRegionsB", daRegionsB),
        ),
      ),
    });

    // 多账号：**两个**都要满足。少了 OrganizationId 那半，跨账号信任策略就没有
    // aws:PrincipalOrgID 可以收口，成员账号的角色会退化成"信任系统账号 root"而没有
    // 组织边界 —— 不如干脆不开，并在 Outputs 里说清为什么没开。
    const multiAccountRequested = new cdk.CfnCondition(this, "MultiAccountRequested", {
      expression: cdk.Fn.conditionEquals(deployMode.valueAsString, "MultiAccount"),
    });
    const isMultiAccount = new cdk.CfnCondition(this, "IsMultiAccount", {
      expression: cdk.Fn.conditionAnd(
        multiAccountRequested,
        cdk.Fn.conditionNot(cdk.Fn.conditionEquals(organizationId.valueAsString, "")),
      ),
    });

    // ══ Mappings：本模板绑定的 Release ═════════════════════════════════════════
    // 为什么用 Mappings 而不是 Parameter：客户**不该**能随便换版本 —— 模板结构与产物
    // 是一套发出去的（agent zip 里的 main.py 要对得上模板给的环境变量、前端要对得上 BFF
    // 的接口）。给成参数就等于允许任意组合，出问题无从复现。
    // tag 同时进 S3 key（`agent/<tag>/agent-code.zip`）：CFN **不会**检测 S3 对象内容变化，
    // key 不变就等于「无变更」→ 客户升级后跑的还是旧 agent 代码。key 里带版本才治得住。
    // 顶层键叫 `Current` 而**不能**叫 `Default`：CloudFormation 把 Mappings 里名为
    // `Default` 的那一项当成 `Fn::FindInMap` 增强查找的兜底值（必须是字符串），
    // 于是 `Default: { Tag, BaseUrl }` 直接被判为模板格式错误
    // （"Every Mappings Default must be a String"）—— cdk synth 与 tsc 都看不出来，
    // 只有 `aws cloudformation validate-template` / 真开栈会报。别改回去。
    new cdk.CfnMapping(this, "NotiOpsRelease", {
      mapping: {
        Current: {
          Tag: RELEASE_TAG_PLACEHOLDER,
          BaseUrl: RELEASE_BASEURL_PLACEHOLDER,
        },
      },
    });
    const releaseTag = cdk.Fn.findInMap("NotiOpsRelease", "Current", "Tag");
    const releaseBaseUrl = cdk.Fn.findInMap("NotiOpsRelease", "Current", "BaseUrl");
    const chatDistKey = `frontend/${releaseTag}/chat-dist.zip`;
    const agentCodeKey = `agent/${releaseTag}/agent-code.zip`;

    // ══ Staging 桶：Release 产物在客户账号里的落脚点 ═══════════════════════════
    // Lambda 的 `Code.S3Bucket` 与 AgentCore 的 `Code.S3.Bucket` 都只接受**同区域**的
    // S3 对象，不能直接指向 GitHub，所以必须在客户账号本区先落一份。
    // DESTROY + 由 StagerFn 清空（不能用 autoDeleteObjects，见文件头第 1 条）。
    const stagingBucket = new s3.Bucket(this, "StagingBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // 桶名交给 CFN 生成：固定名会让「删栈后立刻重建」撞上 S3 桶名回收延迟。
      lifecycleRules: [
        // 产物搬完就只有 Lambda/AgentCore 首次拉取会读它。7 天后清掉旧版本产物省钱，
        // 同时**不影响**已经部署好的 Lambda —— Lambda 在创建/更新时就把代码复制走了，
        // 运行期不再回读这个桶（AgentCore 同理）。
        { id: "expire-staged-artifacts-7d", expiration: cdk.Duration.days(7) },
      ],
    });

    // ══ 最小底座 ══════════════════════════════════════════════════════════════
    const base = createMinimalBase(this);

    // ══ StagerFn：单栈里唯一的搬运工 ═══════════════════════════════════════════
    // 代码**内联**（`Code.ZipFile`，官方上限 4MB）—— 它自己不能依赖任何桶，否则就是
    // 「谁来搬搬运工」的死循环。
    // 必须用 L1 `CfnFunction`：L2 的 `Code.fromInline` 卡在 4096 **字符**（不是 4MB），
    // 这个 handler 远超。
    const stagerSource = fs.readFileSync(path.join(INFRA_DIR, "lambda", "stager", "index.py"), "utf-8");
    const stagerFnName = `${cdk.Aws.STACK_NAME}-stager`;

    const stagerRole = new iam.Role(this, "StagerRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "NotiOps one-click deploy stager",
    });

    // 显式 log group（栈内资源 → 删栈时一并删掉，不留孤儿）。
    // 名字必须精确等于 Lambda 会用的那个，且必须**先**于函数创建 —— 否则 Lambda 运行时
    // 会自己建一个同名的，之后 CFN 再建就 already exists。DependsOn 在下面加。
    const stagerLogs = new logs.LogGroup(this, "StagerLogs", {
      logGroupName: `/aws/lambda/${stagerFnName}`,
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    stagerLogs.grantWrite(stagerRole);
    stagerRole.addToPolicy(new iam.PolicyStatement({
      sid: "StagerOwnLogStreams",
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [stagerLogs.logGroupArn, `${stagerLogs.logGroupArn}:*`],
    }));

    const stagerFn = new lambda.CfnFunction(this, "StagerFn", {
      functionName: stagerFnName,
      role: stagerRole.roleArn,
      runtime: "python3.13",
      handler: "index.handler",
      code: { zipFile: stagerSource },
      // 15 分钟（Lambda 上限）：agent zip 现网 144 MiB，要从 GitHub 拉下来再传进 S3。
      // 实测远快于此，但一键部署的客户网络千差万别，给足余量比让整栈回滚划算。
      timeout: 900,
      // 1024MB：不为内存，为**网络与 CPU 份额**（Lambda 两者都随内存线性增长），
      // 直接决定 144 MiB 那个 zip 搬多久。handler 本身是流式的，常量内存。
      memorySize: 1024,
    });
    stagerFn.addDependency(stagerLogs.node.defaultChild as cdk.CfnResource);
    stagerFn.addDependency(stagerRole.node.defaultChild as cdk.CfnResource);
    // Role 的内联策略是**独立资源**，不加这条依赖，函数可能先建好、首次调用时还没权限。
    const stagerPolicy = stagerRole.node.tryFindChild("DefaultPolicy")?.node.defaultChild;
    if (stagerPolicy) stagerFn.addDependency(stagerPolicy as cdk.CfnResource);

    // ── Phase=Artifacts：把 Release 产物搬进 staging 桶 ──
    // 只依赖 staging 桶，所以能排在 BFF / Runtime **之前**。
    // `Artifacts` 是占位空清单，由 postprocess 注入真实的 name/key/sha256 —— handler 见到
    // 空清单会直接失败并说清是漏跑了 postprocess，而不是让下游报一个看不懂的 S3 404。
    stagingBucket.grantReadWrite(stagerRole);
    stagingBucket.grantDelete(stagerRole);

    // s3:// 镜像的读权限。语句**恒存在**、只是 Resource 随条件切换：IAM 不接受空的
    // Resource 数组，而用 Fn::If 把整条语句换成 AWS::NoValue 要落到 L1 上手改
    // PolicyDocument（那份文档由 CDK 生成，改它就得和生成逻辑赛跑）。
    // 未配置时指向一个**不存在**的桶名，等价于没有授权，且在客户读策略时一眼看得懂。
    const hasArtifactMirror = new cdk.CfnCondition(this, "HasArtifactMirror", {
      expression: cdk.Fn.conditionNot(cdk.Fn.conditionEquals(artifactMirrorBucket.valueAsString, "")),
    });
    stagerRole.addToPolicy(new iam.PolicyStatement({
      sid: "StagerReadArtifactMirror",
      actions: ["s3:GetObject"],
      resources: [
        cdk.Fn.conditionIf(
          hasArtifactMirror.logicalId,
          `arn:${cdk.Aws.PARTITION}:s3:::${artifactMirrorBucket.valueAsString}/*`,
          `arn:${cdk.Aws.PARTITION}:s3:::notiops-artifact-mirror-not-configured/*`,
        ).toString(),
      ],
    }));

    const stagerArtifacts = new cdk.CfnResource(this, "StagerArtifacts", {
      type: "Custom::NotiOpsStagerArtifacts",
      properties: {
        ServiceToken: stagerFn.attrArn,
        Phase: "Artifacts",
        StagingBucket: stagingBucket.bucketName,
        DefaultArtifactBaseUrl: releaseBaseUrl,
        ArtifactBaseUrlOverride: artifactBaseUrl.valueAsString,
        // postprocess 改写这里；同时它天然是「版本变了就重搬」的触发器
        // （sha256 变 → 属性变 → CFN 发 Update）。
        Artifacts: "[]",
      },
    });
    stagerArtifacts.addDependency(stagerFn);

    // ══ 深度调查：AWS DevOps Agent Agent Space（可选，同栈资源）════════════════
    // `setup.sh` 那条路径在 notiops-backend-stack.ts 里建同样的三件套；这里必须自己建，
    // 否则 BFF/agent 的 DEVOPS_AGENT_SPACE_ID 为空 → 「深度调查」一按就 no_local_agent_space。
    // 三个资源都带 Condition，客户关掉（或区域不支持）时整块不存在。
    //
    // 与 `setup.sh` 路径的两处刻意差异：
    //   · 名字带 `-oneclick`：README 明说两条部署路径可以先后跑在同一个账号里，
    //     撞上 `notiops-devops-<account>` 就会 CREATE_FAILED。
    //   · PrimaryRole **不指定 roleName**（交给 CFN 生成）：同理，固定名会和
    //     `notiops-agent-primary-<account>` 撞。角色名没有任何东西按字面引用它。
    const devopsAgent = require("aws-cdk-lib/aws-devopsagent");
    const agentSpace = new devopsAgent.CfnAgentSpace(this, "DevOpsAgentSpace", {
      name: `notiops-oneclick-${cdk.Aws.ACCOUNT_ID}`,
      description: "NotiOps deep investigation (one-click deployment)",
    });
    agentSpace.cfnOptions.condition = deepInvestigationEnabled;

    const daPrimaryRole = new iam.Role(this, "DevOpsAgentPrimaryRole", {
      assumedBy: new iam.ServicePrincipal("aidevops.amazonaws.com", {
        // confused-deputy 防护：只有本账号、且只有本账号的 agentspace 能把这个角色用起来。
        conditions: {
          StringEquals: { "aws:SourceAccount": cdk.Aws.ACCOUNT_ID },
          ArnLike: { "aws:SourceArn": `arn:${this.partition}:aidevops:${this.region}:${this.account}:agentspace/*` },
        },
      }),
      description: "Assumed by AWS DevOps Agent to investigate this account (read-only)",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AIDevOpsAgentAccessPolicy")],
    });
    // Resource Explorer 的服务关联角色 —— DevOps Agent 靠它做资源发现，缺了调查会瘸。
    daPrimaryRole.addToPolicy(new iam.PolicyStatement({
      sid: "CreateResourceExplorerSlr",
      actions: ["iam:CreateServiceLinkedRole"],
      resources: [`arn:${this.partition}:iam::${this.account}:role/aws-service-role/resource-explorer-2.amazonaws.com/AWSServiceRoleForResourceExplorer`],
      conditions: { StringEquals: { "iam:AWSServiceName": "resource-explorer-2.amazonaws.com" } },
    }));
    // 刻意**不给** Athena/Glue/CUR 那组（`setup.sh` 路径有）：一键部署不含 CUR-Athena
    // FinOps，给了就是一组用不上的宽权限。
    //
    // 角色的内联策略是**另一个资源**，条件必须一起打 —— 只给 Role 打条件的话，
    // 客户关掉深度调查时会剩下一条引用不存在角色的 AWS::IAM::Policy，直接部署失败。
    const applyCondition = (role: iam.Role, condition: cdk.CfnCondition) => {
      (role.node.defaultChild as iam.CfnRole).cfnOptions.condition = condition;
      const inlinePolicy = role.node.tryFindChild("DefaultPolicy")?.node.defaultChild;
      if (inlinePolicy) (inlinePolicy as cdk.CfnResource).cfnOptions.condition = condition;
    };
    applyCondition(daPrimaryRole, deepInvestigationEnabled);

    const daAssociation = new devopsAgent.CfnAssociation(this, "DevOpsAgentAssociation", {
      agentSpaceId: agentSpace.attrAgentSpaceId,
      serviceId: "aws",
      configuration: { aws: { accountId: this.account, accountType: "monitor", assumableRoleArn: daPrimaryRole.roleArn } },
    });
    daAssociation.cfnOptions.condition = deepInvestigationEnabled;
    daAssociation.node.addDependency(agentSpace);
    daAssociation.node.addDependency(daPrimaryRole);

    // 关掉/区域不支持时是空串（**不是** AWS::NoValue）：这两处消费方都是普通字符串
    // 环境变量，空串就是"没配"，见 core/devops_agent.py 与 bff 的 SELF_AGENT_SPACE。
    const agentSpaceIdOrEmpty = cdk.Fn.conditionIf(
      deepInvestigationEnabled.logicalId, agentSpace.attrAgentSpaceId, "",
    ).toString();

    // ══ AgentCore Runtime（同栈资源）══════════════════════════════════════════
    // 这是一键部署与 `setup.sh` 路径最大的结构差异：那条路上 agent 是用
    // `agentcore deploy` 单独部署、再把 ARN 用 `-c agentRuntimeArn=` 传回 CDK 的（两步、
    // 要装 CLI）。这里 Runtime 就是栈里的一个资源，ARN 直接 GetAtt 给 BFF。
    // 顺带解掉一个现网痛点：`agentcore deploy` 偶发丢 envVars（见 scripts/deploy_agent.sh §5
    // 的强制回填），CFN 原生声明不存在这个问题。
    //
    // 执行角色照抄现网那份合成模板（agent-build/.../cdk.out），逐条对齐，
    // 只去掉 M1 里**没有对应资源**的授权：AgentCore Memory（本栈不建 Memory —— grep 过
    // core/ 与 agent/，没有任何代码读 MEMORY_* 环境变量）、WebSearch Gateway（M1 不带）、
    // Bedrock API key secret（M1 不建 secret）、跨账号 AssumeRole（M1 单账号）。
    const runtimeRole = new iam.Role(this, "AgentRuntimeRole", {
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com"),
      description: "AgentCore Runtime execution role",
      managedPolicies: [
        // Fn::If 返回 AWS::NoValue 时，这个数组元素直接消失（不是变成 null）——
        // 这是在 L2 上做「可选托管策略」的标准办法。
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "AgentReadOnlyAccessPolicy",
          cdk.Fn.conditionIf(
            new cdk.CfnCondition(this, "AgentReadOnlyEnabled", {
              expression: cdk.Fn.conditionEquals(agentReadOnlyAccess.valueAsString, "Yes"),
            }).logicalId,
            `arn:${this.partition}:iam::aws:policy/ReadOnlyAccess`,
            cdk.Aws.NO_VALUE,
          ).toString(),
        ),
      ],
    });

    // 基础：模型调用 + 遥测 + 自己的日志 + configuration bundle（AgentCore 托管运行时自用）
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ["bedrock:CountTokens", "bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [
        `arn:${this.partition}:bedrock:*:${this.account}:inference-profile/*`,
        `arn:${this.partition}:bedrock:*::foundation-model/*`,
      ],
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: ["logs:DescribeLogGroups", "xray:PutTelemetryRecords", "xray:PutTraceSegments"],
      resources: ["*"],
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "logs:CreateLogGroup", "logs:CreateLogStream", "logs:DescribeLogStreams",
        "logs:FilterLogEvents", "logs:GetLogEvents", "logs:PutLogEvents", "logs:PutResourcePolicy",
      ],
      resources: [`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`],
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "bedrock-agentcore:CreateConfigurationBundle", "bedrock-agentcore:DeleteConfigurationBundle",
        "bedrock-agentcore:GetConfigurationBundle", "bedrock-agentcore:GetConfigurationBundleVersion",
        "bedrock-agentcore:ListConfigurationBundleVersions", "bedrock-agentcore:ListConfigurationBundles",
        "bedrock-agentcore:UpdateConfigurationBundle",
      ],
      resources: [`arn:${this.partition}:bedrock-agentcore:*:*:configuration-bundle/*`],
    }));
    // 无区域 ARN 的全球 CRIS —— 这是 Claude 全球推理配置唯一能匹配上的 ARN 形式，
    // 少了它模型下拉里的 global.* 全部 AccessDenied（判据在 scripts/test_llm_iam_grants.py）。
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsBedrockGlobalCris",
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [`arn:${this.partition}:bedrock:::foundation-model/*`],
    }));
    // Skills 读 / 报告写 —— 共享数据桶的两个前缀，与 IM 端同一个桶。
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsSkillsRead",
      actions: ["s3:GetObject", "s3:ListBucket"],
      resources: [base.dataBucket.bucketArn, base.dataBucket.arnForObjects("skills/*")],
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsReportsWrite",
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [base.dataBucket.arnForObjects("reports/*")],
    }));
    // FinOps / 资源巡检 / 故障调查三块只读工具面。**只读**是产品承诺，不是省事：
    // 客户交出来的是生产账号，任何写动作都得走「先提议、人确认」而不是靠 IAM 放开。
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsFinOpsReadOnly",
      actions: [
        "budgets:DescribeBudgets", "budgets:ViewBudget",
        "ce:Describe*", "ce:Get*", "ce:List*",
        "compute-optimizer:Describe*", "compute-optimizer:Get*",
        "cost-optimization-hub:GetPreferences", "cost-optimization-hub:GetRecommendation",
        "cost-optimization-hub:ListEnrollmentStatuses", "cost-optimization-hub:ListRecommendationSummaries",
        "cost-optimization-hub:ListRecommendations",
        "cur:DescribeReportDefinitions", "freetier:GetFreeTierUsage",
        "pricing:DescribeServices", "pricing:GetAttributeValues", "pricing:GetPriceListFileUrl",
        "pricing:GetProducts", "pricing:ListPriceLists",
        "s3:GetStorageLensConfiguration", "s3:ListStorageLensConfigurations",
        "storagelens:Get*", "storagelens:List*",
      ],
      resources: ["*"],
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsResourceInspectReadOnly",
      actions: [
        "cloudwatch:GetMetricStatistics", "cloudwatch:ListMetrics",
        "rds:DescribeDBClusters", "rds:DescribeDBInstances", "rds:DescribeEvents", "rds:ListTagsForResource",
      ],
      resources: ["*"],
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsInvestigationReadOnly",
      actions: [
        "cloudtrail:DescribeQuery", "cloudtrail:GetEventDataStore", "cloudtrail:GetQueryResults",
        "cloudtrail:ListEventDataStores", "cloudtrail:LookupEvents", "cloudtrail:StartQuery",
        "cloudwatch:DescribeAlarmHistory", "cloudwatch:DescribeAlarms",
        "cloudwatch:GetMetricData", "cloudwatch:ListMetrics",
        "ec2:DescribeInstanceStatus", "ec2:DescribeInstances", "ec2:DescribeSecurityGroups",
        "logs:DescribeLogGroups", "logs:DescribeQueryDefinitions", "logs:GetQueryResults",
        "logs:ListAnomalies", "logs:ListLogAnomalyDetectors", "logs:StartQuery", "logs:StopQuery",
      ],
      resources: ["*"],
    }));
    // DevOps Agent（GA 服务）直连 —— 客户没开通时这些 API 报错、功能优雅降级，
    // 授权本身无副作用，所以照给，省掉一次「开通后还要改 IAM」的往返。
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsDevOpsAgentDirect",
      actions: [
        "aidevops:CreateBacklogTask", "aidevops:CreateChat", "aidevops:GetAgentSpace",
        "aidevops:GetBacklogTask", "aidevops:GetJournalRecord", "aidevops:GetRecommendation",
        "aidevops:ListAgentSpaces", "aidevops:ListExecutions", "aidevops:ListJournalRecords",
        "aidevops:ListPendingMessages", "aidevops:ListRecommendations", "aidevops:SendMessage",
      ],
      resources: ["*"],
    }));
    // 模型目录 / RBAC 等配置（agent 侧也要读，例如按角色裁剪工具）。
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadNotiOpsConfig",
      actions: ["dynamodb:GetItem", "dynamodb:Query"],
      resources: [base.configTable.tableArn, `${base.configTable.tableArn}/index/*`],
    }));
    // 多账号：agent 唯一需要跨账号的动作 —— 到成员账号的 trigger 角色去发起深度调查
    // （core/devops_agent.py `_assume_client`，角色 ARN 来自 Admin 接入时写的 da# 配置行）。
    // 单账号模式下这个资源整块不存在，所以是真的一条权限都不给：
    // 用**独立的 AWS::IAM::Policy**（不是 role.addToPolicy）才做得到——DefaultPolicy 那份
    // 文档由 CDK 生成，往里塞 Fn::If 就得跟生成逻辑赛跑。
    const runtimeCrossAccount = new iam.Policy(this, "AgentRuntimeCrossAccount", {
      roles: [runtimeRole],
      statements: [new iam.PolicyStatement({
        sid: "AssumeMemberDevOpsAgentTriggerRole",
        actions: ["sts:AssumeRole"],
        resources: [`arn:${this.partition}:iam::*:role/notiops-agent-trigger-*`],
      })],
    });
    (runtimeCrossAccount.node.defaultChild as cdk.CfnResource).cfnOptions.condition = isMultiAccount;

    const runtime = new cdk.CfnResource(this, "AgentRuntime", {
      type: "AWS::BedrockAgentCore::Runtime",
      properties: {
        AgentRuntimeName: RUNTIME_NAME,
        Description: "NotiOps Web Chat agent (one-click deployment)",
        AgentRuntimeArtifact: {
          CodeConfiguration: {
            Code: { S3: { Bucket: stagingBucket.bucketName, Prefix: agentCodeKey } },
            // 与现网合成模板逐字一致。`opentelemetry-instrument` 前缀是 AgentCore 托管
            // 运行时做分布式追踪的方式，去掉就没有 trace。
            EntryPoint: ["opentelemetry-instrument", "main.py"],
            Runtime: "PYTHON_3_13",
          },
        },
        NetworkConfiguration: { NetworkMode: "PUBLIC" },
        RoleArn: runtimeRole.roleArn,
        // 必须显式写：AgentCore 的默认 idle 是 **900 秒**，而 NotiOps 要的是 1 小时。
        // 900 秒下，用户离开十几分钟回来提问就吃一次冷启动（~30s，BFF 那边只能靠
        // "再发一次"的提示兜），体验明显退化。老路径（setup.sh）靠部署后
        // `scripts/backfill_runtime_env.sh SET_IDLE=3600` 纠偏；这条路径是原生 CFN
        // 属性（非 createOnly，可原地更新），直接在模板里定死，不需要部署后补。
        // 两个值与 `agent-build/NotiOpsWebChat/agentcore/agentcore.json` 保持一致。
        LifecycleConfiguration: {
          IdleRuntimeSessionTimeout: 3600,
          MaxLifetime: 28800,
        },
        EnvironmentVariables: {
          // 只给 M1 真的有的那几个。空串在部分 AgentCore 校验下会被拒，
          // 缺省项一律**不写**（agent 侧都是 os.environ.get(..., "")）。
          SKILLS_BUCKET: base.dataBucket.bucketName,
          // 同上：关掉深度调查时整个键消失，绝不写空串。
          // 不写这个键时 agent 会走 ListAgentSpaces 自动发现（core/devops_agent.py），
          // 显式给了就少一次 API、也不会挑错（同账号里可能还有别的 Agent Space）。
          DEVOPS_AGENT_SPACE_ID: cdk.Fn.conditionIf(
            deepInvestigationEnabled.logicalId, agentSpace.attrAgentSpaceId, cdk.Aws.NO_VALUE,
          ),
        },
      },
    });
    // 代码在 staging 桶里，必须等搬完。
    runtime.addDependency(stagerArtifacts);

    // ══ Web Chat 主体 ═════════════════════════════════════════════════════════
    const webchat = createWebChatCore(this, {
      staticTemplate: true,
      userPoolId: base.userPool.userPoolId,
      userPoolClientId: base.userPoolClient.userPoolClientId,
      skillsBucketName: base.dataBucket.bucketName,
      // 同栈资源，直接 GetAtt —— 不走 `-c agentRuntimeArn=`（那条路是给两步部署用的）。
      agentRuntimeArn: runtime.getAtt("AgentRuntimeArn").toString(),
      corsAllowedOrigins: allowedOrigins.valueAsList,
      // 关掉深度调查时是空串 → BFF 侧 SELF_AGENT_SPACE 为空 → 「深度调查」相关路由
      // 返回 no_local_agent_space（前端已按能力位置灰，见 Composer）。
      agentSpaceId: agentSpaceIdOrEmpty,
      // 「单账号还是多账号」是部署期才知道的，所以传条件而不是布尔 —— 受影响的 6 个
      // BFF 环境变量在 web-chat-core.ts 里落成 Fn::If。
      multiAccount: { organizationId: organizationId.valueAsString, conditionLogicalId: isMultiAccount.logicalId },
      // M1 不带：IM 巡检控制台、报告 CDN（都属于完整部署）。
    });
    // BFF 的代码 zip 也在 staging 桶里（`S3Bucket` 由 postprocess 改写成 !Ref StagingBucket），
    // 所以它也必须等搬完。放在 CDK 里声明而不是让 postprocess 补 DependsOn：
    // 依赖关系属于栈的语义，越少交给正则改写越好。
    (webchat.bff.node.defaultChild as lambda.CfnFunction).addDependency(stagerArtifacts);

    // ── Phase=Site：前端 + config.json + 第一个管理员 ──
    // 为什么必须与 Artifacts 分成两个自定义资源：`configJson` 里含 BFF 的 Function URL
    // ⇒ 本资源依赖 BFF；而 BFF 的代码在 staging 桶里 ⇒ BFF 依赖 Artifacts。
    // 合成一个资源就是环。
    webchat.siteBucket.grantReadWrite(stagerRole);
    webchat.siteBucket.grantDelete(stagerRole);
    stagerRole.addToPolicy(new iam.PolicyStatement({
      sid: "InvalidateChatCdn",
      actions: ["cloudfront:CreateInvalidation"],
      resources: [`arn:${this.partition}:cloudfront::${this.account}:distribution/${webchat.distribution.distributionId}`],
    }));
    stagerRole.addToPolicy(new iam.PolicyStatement({
      sid: "CreateFirstAdmin",
      actions: ["cognito-idp:AdminCreateUser", "cognito-idp:AdminAddUserToGroup"],
      resources: [base.userPool.userPoolArn],
    }));
    // 删栈收尾用的权限。都是**精确资源**，不给通配 —— 这个角色在客户生产账号里，
    // 一个 `logs:DeleteLogGroup` on `*` 就意味着「部署工具能删光你所有日志」。
    stagerRole.addToPolicy(new iam.PolicyStatement({
      sid: "TeardownDeleteOwnLogGroups",
      actions: ["logs:DeleteLogGroup"],
      resources: [
        `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/*`,
      ],
    }));
    // DeleteEverything 时才用到；`Retain` 的数据资源 CFN 不碰，只有这里会动它们。
    stagerRole.addToPolicy(new iam.PolicyStatement({
      sid: "TeardownDeleteRetainedData",
      actions: ["dynamodb:DeleteTable"],
      resources: [base.configTable.tableArn, webchat.table.tableArn],
    }));
    base.dataBucket.grantRead(stagerRole);
    base.dataBucket.grantDelete(stagerRole);
    stagerRole.addToPolicy(new iam.PolicyStatement({
      sid: "TeardownDeleteDataBucket",
      actions: ["s3:ListBucket", "s3:ListBucketVersions", "s3:DeleteBucket"],
      resources: [base.dataBucket.bucketArn],
    }));

    const stagerSite = new cdk.CfnResource(this, "StagerSite", {
      type: "Custom::NotiOpsStagerSite",
      properties: {
        ServiceToken: stagerFn.attrArn,
        Phase: "Site",
        StagingBucket: stagingBucket.bucketName,
        SiteBucket: webchat.siteBucket.bucketName,
        ChatDistKey: chatDistKey,
        ConfigJson: webchat.configJson,
        DistributionId: webchat.distribution.distributionId,
        UserPoolId: base.userPool.userPoolId,
        AdminEmail: adminEmail.valueAsString,
        // 每个 Release 都重发一次前端（tag 进了 ChatDistKey，这里再显式带一次，
        // 便于人在 CFN 事件里一眼看出装的是哪个版本）。
        ReleaseTag: releaseTag,
        // ── 删栈时才用到的属性 ──
        // 自定义资源的 Delete 事件带的是**上一次成功部署**时的属性，所以要删什么必须
        // 在部署期就写死在这里，删栈时才有得读。
        TeardownMode: teardownMode.valueAsString,
        DataBucket: base.dataBucket.bucketName,
        TableNames: cdk.Stack.of(this).toJsonString([base.configTable.tableName, webchat.table.tableName]),
        // 只精确点名本次部署自己那个 AgentCore 运行时日志组 —— **绝不**按前缀扫描后批量删。
        // BFF 与 StagerFn 的日志组都是栈内资源（DESTROY），CFN 自己会删，不用列在这里。
        LogGroupNames: cdk.Stack.of(this).toJsonString([
          `/aws/bedrock-agentcore/runtimes/${runtime.getAtt("AgentRuntimeId").toString()}-DEFAULT`,
        ]),
      },
    });
    stagerSite.addDependency(stagerArtifacts);
    // 管理员要放进 `admin` 组 → 组必须先建好。CfnUserPoolGroup 与用户池之间只有
    // `Ref userPoolId` 的隐式依赖，与本资源之间没有，必须显式声明。
    base.groups.forEach((g) => stagerSite.addDependency(g));
    if (stagerPolicy) stagerSite.addDependency(stagerPolicy as cdk.CfnResource);

    // ══ 多账号落地（Phase=OrgSetup，仅 MultiAccount）═══════════════════════════
    // 两个成员账号 StackSet 的模板在**合成期**读进来、当字符串内联 —— 不是 CDK 资产
    // （客户账号没有资产桶，见文件头第 1 条）。`setup.sh` 那条路径用的是同两份文件，
    // 于是两条部署路径下发给成员账号的东西逐字相同。
    const onboardingStackSetName = "notiops-member-onboarding";
    const devopsStackSetName = "notiops-member-devops-agent";
    const memberTemplate = (f: string) => fs.readFileSync(path.join(INFRA_DIR, f), "utf-8");

    // 权限用**独立的 AWS::IAM::Policy**挂到 StagerRole 上，好处就是能整块带 Condition：
    // 客户选单账号时，这个搬运工角色一条 organizations/StackSet 权限都没有。
    const stagerOrgPolicy = new iam.Policy(this, "StagerOrgSetupPolicy", {
      roles: [stagerRole],
      statements: [
        new iam.PolicyStatement({
          sid: "EnableStackSetsTrustedAccess",
          // Organizations 这三个 API 都不支持资源级限定（只能 *）。EnableAWSServiceAccess
          // 是本模板里**唯一**一个组织级写动作，只开 StackSets 那一个 service principal
          // （handler 里写死，不从属性取）。
          actions: [
            "organizations:DescribeOrganization",
            "organizations:EnableAWSServiceAccess",
            "organizations:ListAWSServiceAccessForOrganization",
          ],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "ManageMemberStackSets",
          actions: [
            "cloudformation:CreateStackSet",
            "cloudformation:DescribeStackSet",
            "cloudformation:UpdateStackSet",
          ],
          // 精确到我们自己那两个 StackSet（名字写死）—— 不给「管理本账号任意 StackSet」。
          resources: [
            `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stackset/${onboardingStackSetName}:*`,
            `arn:${this.partition}:cloudformation:${this.region}:${this.account}:stackset/${devopsStackSetName}:*`,
            `arn:${this.partition}:cloudformation:*::type/resource/*`,
          ],
        }),
      ],
    });
    (stagerOrgPolicy.node.defaultChild as cdk.CfnResource).cfnOptions.condition = isMultiAccount;

    const stagerOrgSetup = new cdk.CfnResource(this, "StagerOrgSetup", {
      type: "Custom::NotiOpsStagerOrgSetup",
      properties: {
        ServiceToken: stagerFn.attrArn,
        Phase: "OrgSetup",
        SystemAccountId: this.account,
        OrganizationId: organizationId.valueAsString,
        // 成员账号只在主区（=本栈所在区）建 IAM 角色；其余区只建转发规则，而一键部署
        // 不开转发，所以实际上就是「只有主区有东西」。见 member-account-onboarding.yaml。
        PrimaryRegion: this.region,
        OnboardingStackSetName: onboardingStackSetName,
        OnboardingTemplateBody: memberTemplate("member-account-onboarding.yaml"),
        DevOpsStackSetName: devopsStackSetName,
        DevOpsTemplateBody: memberTemplate("member-devops-agent.yaml"),
      },
    });
    stagerOrgSetup.cfnOptions.condition = isMultiAccount;
    stagerOrgSetup.addDependency(stagerFn);
    stagerOrgSetup.addDependency(stagerOrgPolicy.node.defaultChild as cdk.CfnResource);
    if (stagerPolicy) stagerOrgSetup.addDependency(stagerPolicy as cdk.CfnResource);

    // ══ Outputs ══════════════════════════════════════════════════════════════
    // `ChatUrl` / `ChatBffUrl` / `WebChatTableName` 已由 createWebChatCore 输出。
    new cdk.CfnOutput(this, "NextSteps", {
      description: "How to log in",
      value: cdk.Fn.join("", [
        "Cognito emailed a temporary password to ",
        adminEmail.valueAsString,
        ". Open the ChatUrl output and sign in as 'admin' (or with that email address), ",
        "then set a new password.",
      ]),
    });
    new cdk.CfnOutput(this, "InstalledRelease", { description: "NotiOps release deployed by this stack", value: releaseTag });
    new cdk.CfnOutput(this, "DataRetentionOnDelete", {
      description: "What deleting this stack does to your data",
      value: cdk.Fn.join("", [
        "TeardownMode=", teardownMode.valueAsString,
        ". KeepData keeps the notiops-config table, the chat history table and ",
        base.dataBucket.bucketName,
        "; the Cognito user pool is always deleted. To switch modes, update the stack first, then delete it.",
      ]),
    });

    // 两个「你选的到底生效了吗」输出。没有它们，两种最容易踩的情况都是**静默**的：
    // 区域不支持 DevOps Agent、以及选了 MultiAccount 但没填 org id。
    // Agent Space id 单独一个**带条件**的 Output，而不是拼进下面那句话：Output 的 Value 里
    // 引用条件资源、只靠 `Fn::If` 挡着，CFN 的模板校验会告警（它看不出分支同条件）。
    const agentSpaceIdOutput = new cdk.CfnOutput(this, "DevOpsAgentSpaceId", {
      description: "AWS DevOps Agent space created for deep investigation",
      value: agentSpace.attrAgentSpaceId,
    });
    agentSpaceIdOutput.condition = deepInvestigationEnabled;
    new cdk.CfnOutput(this, "DeepInvestigationStatus", {
      description: "Deep investigation (AWS DevOps Agent)",
      value: cdk.Fn.conditionIf(
        deepInvestigationEnabled.logicalId,
        "Enabled. See the DevOpsAgentSpaceId output.",
        cdk.Fn.conditionIf(
          deepInvestigationRequested.logicalId,
          "Skipped: AWS DevOps Agent is not available in this Region, so no agent space was created. "
            + "Everything else in this deployment works; redeploy in a supported Region to get it.",
          "Off (EnableDeepInvestigation=No). Update the stack to turn it on later.",
        ).toString(),
      ).toString(),
    });
    new cdk.CfnOutput(this, "DeployModeStatus", {
      description: "Single-account or multi-account (AWS Organizations)",
      value: cdk.Fn.conditionIf(
        isMultiAccount.logicalId,
        cdk.Fn.join("", [
          "MultiAccount. Member StackSets notiops-member-onboarding and ",
          "notiops-member-devops-agent were created in this account; onboard member accounts from ",
          "the Admin panel. Deleting this stack does NOT delete those StackSets or the roles they ",
          "created in member accounts - delete them by hand if you want them gone.",
        ]),
        cdk.Fn.conditionIf(
          multiAccountRequested.logicalId,
          "SingleAccount: you chose MultiAccount but left the AWS Organizations id empty, so it stays off. "
            + "Update the stack with a valid o-xxxx id to enable it.",
          "SingleAccount. This deployment only inspects the account it runs in.",
        ).toString(),
      ).toString(),
    });
  }
}
