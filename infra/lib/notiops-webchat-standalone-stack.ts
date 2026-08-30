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
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as fs from "fs";
import * as path from "path";
import { createMinimalBase } from "./constructs/minimal-base-core";
import { createWebChatCore } from "./constructs/web-chat-core";
// 「通知」生产端 —— 与 `notiops-backend-stack.ts`（方式 B）**共用同一份**事件源定义。
import {
  WEB_NOTIF_ARTIFACT,
  WEB_NOTIF_FUNCTION_DESCRIPTION,
  WEB_NOTIF_FUNCTION_NAME,
  WEB_NOTIF_HANDLER,
  WEB_NOTIF_SOURCES,
  webNotifEnv,
  webNotifRuleDescription,
  webNotifRuleName,
} from "./constructs/web-notif-sources";

const INFRA_DIR = path.join(__dirname, "..");

/** AgentCore Runtime 名（只允许字母数字下划线，不能带连字符）。 */
const RUNTIME_NAME = "notiops_web_chat";

/** `_` 开头的键是**文档键**（里面写的是中文说明），递归剥掉。 */
function stripDocKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDocKeys);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([k]) => !k.startsWith("_"))
        .map(([k, v]) => [k, stripDocKeys(v)]),
    );
  }
  return node;
}

/**
 * synth 期读进来的出厂模型目录，作为 `StagerSite` 的一个属性内联进模板。
 *
 * 为什么能内联而不是让 Lambda 去下载：剥掉文档键之后它只有 ~3.5KB，且**纯 ASCII**
 * （中文全在 `_` 开头的说明键里）。这一点很关键 —— CFN 收模板时会把 `Code.ZipFile`
 * 之外的非 ASCII 字符换成 `?`，所以这里显式断言一次，宁可 synth 失败也不要发出一份
 * 客户拿到就是乱码的模板（`scripts/postprocess_template.py` 有同款全局断言，这里是
 * 更早、错误信息更具体的那一道）。
 */
const llmCatalogJson = (() => {
  const raw = fs.readFileSync(
    path.join(INFRA_DIR, "..", "config", "llm-model-catalog.json"), "utf-8");
  const json = JSON.stringify(stripDocKeys(JSON.parse(raw)));
  // eslint-disable-next-line no-control-regex
  const bad = json.match(/[^\x00-\x7F]/g);
  if (bad) {
    throw new Error(
      "config/llm-model-catalog.json contains non-ASCII characters outside of " +
      `underscore-prefixed doc keys (${JSON.stringify(bad.slice(0, 8))}). ` +
      "CloudFormation replaces those with '?' when a template is submitted, so " +
      "they cannot be inlined. Move the prose into a \"_\"-prefixed key.");
  }
  return json;
})();

/**
 * `Mappings` 里那份「本模板对应哪个 Release」的占位值。
 * `scripts/postprocess_template.py` 会把它改写成真实的 tag。
 * 故意用一个明显不是版本号的值：万一有人直接部署未经 postprocess 的裸 synth 产物，
 * 报错里会带上 `0.0.0-UNPROCESSED`，一眼看出漏了哪一步。
 */
/**
 * Bedrock Mantle（GPT 系模型的调用面）可用区域。
 *
 * ⚠️ 这份名单必须 **⊇ Admin 可保存的 Mantle 区域白名单**
 * （`bff/web-chat/llm_config.mjs::MANTLE_REGIONS` 是权威源）。少一个区，管理员就能存下一条
 * 该区的 GPT 条目（校验过、保存时的连通性探测也过 —— 探测用的是 BFF 的角色），
 * 但用户真发消息时是 runtime 的角色在调 → 403。`scripts/test_mantle_regions_consistent.py`
 * 会断言本文件、agentcore CDK、BFF、grant_mantle_permissions.sh 四处不漂移。
 */
const MANTLE_REGIONS = [
  "us-east-1", "us-east-2", "us-west-2",
  "ap-northeast-1", "ap-south-1", "ap-southeast-2", "ap-southeast-3",
  "eu-central-1", "eu-north-1", "eu-south-1", "eu-west-1", "eu-west-2",
  "sa-east-1", "us-gov-west-1",
];

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
    // 参数名留作 EnableDeepInvestigation（改名会让已部署的栈更新时丢值），但它现在
    // 是**全部四项** DevOps Agent 能力的总闸 —— 描述里必须说清，否则客户以为关掉它
    // 只是少一个「深度调查」，实际连「DevOps 对话」也一起没了（置灰、不报错）。
    const enableDeepInvestigation = new cdk.CfnParameter(this, "EnableDeepInvestigation", {
      type: "String",
      default: "Yes",
      allowedValues: ["Yes", "No"],
      description:
        "Create an AWS DevOps Agent Agent Space. One Agent Space powers every DevOps Agent " +
        "capability in the chat: deep root-cause investigation, its token-free Direct variant, " +
        "DevOps Chat (your own agent answers a general chat directly), and publishing a Skill " +
        "to DevOps Agent. Choose No and all four stay greyed out. Billed per agent-second only " +
        "while your agent is working; an idle Agent Space costs nothing. Silently skipped in " +
        "Regions where AWS DevOps Agent is not available yet -- the stack still deploys and " +
        "everything else works.",
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
          // 标签只影响控制台显示（不是改参数名，栈更新不会丢值）—— 写成「所有
          // AWS DevOps Agent 能力」，因为 v1.0.16 起它管的不只是「深度调查」。
          [enableDeepInvestigation.logicalId]: {
            default: "Enable AWS DevOps Agent features (deep investigation, DevOps Chat)?",
          },
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

    // 联网搜索（AgentCore web search，GA 2026）目前**只有 us-east-1**。别的区不是"降级"
    // 而是根本没有这个 API，所以整块（服务角色 + Gateway）都不建 —— 与深度调查同一套做法：
    // 不支持就啥也不建、栈照样成功、`WebSearchStatus` 输出说清为什么。
    // 界面上那个开关是**无条件**渲染的（Composer.tsx，两条部署路径都一样），所以这里
    // 唯一的差别是"点了以后有没有结果"，不需要往前端传能力位。
    const webSearchSupported = new cdk.CfnCondition(this, "WebSearchSupported", {
      expression: cdk.Fn.conditionEquals(cdk.Aws.REGION, "us-east-1"),
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
    // 「通知」生产端的代码（见下方 WebNotifFn）。它只有 5 个文件、几十 KB，本来最想内联
    // 成 `Code.ZipFile` 省掉一次搬运 —— 但内联只能放**单文件**源码，而这个 handler
    // `from core import push_event`（679 行）。所以走和 BFF 一样的产物路径。
    const webNotifKey = `notif/${releaseTag}/${WEB_NOTIF_ARTIFACT}`;

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

    // ══ 联网搜索：AgentCore Web Search Gateway ═════════════════════════════════
    // AgentCore 的 web search 没有独立 API：只能建一个 **Gateway**（MCP 协议 + AWS_IAM
    // 鉴权）挂一个 `web-search` connector target，agent 再用自己的身份 SigV4 调它的
    // /mcp 端点。查询文本全程不出 AWS。`setup.sh` 那条路径靠
    // `scripts/provision_websearch_gateway.sh` 干这件事；这条路径没有本地 shell，所以搬到
    // StagerFn 的 Phase=WebSearch（同一套参数，见那边的注释）。
    //
    // 为什么必须是自定义资源而不是 L1：CloudFormation **没有** AgentCore Gateway 资源类型，
    // 而 target 的 `mcp.connector` 配置又新到需要 botocore>=1.43.36 —— 一键部署既不能带
    // Lambda layer 也不能 pip install，所以 stager 直接手签 SigV4 打 rest-json。
    const webSearchGatewayRole = new iam.Role(this, "WebSearchGatewayRole", {
      // **不指定 roleName**：物理名交给 CFN 生成，才不会撞上 `setup.sh` 路径手建的
      // `notiops-websearch-gateway-role`。两条路径本就不共存于同一账号+区域，但客户完全
      // 可能先跑过一次 setup.sh 再来试一键部署，留出这点余量比省一个可读名字值。
      assumedBy: new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com", {
        // 混淆代理（confused deputy）收口：只有**本账号本区**的 gateway 能扮演它。
        conditions: {
          StringEquals: { "aws:SourceAccount": this.account },
          ArnLike: {
            "aws:SourceArn": `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
          },
        },
      }),
      description: "NotiOps AgentCore Gateway service role for Web Search",
      // 内联策略落在 AWS::IAM::Role 资源**内部**，于是下面那行 Condition 一并盖住它，
      // 不用再操心「策略建好了但角色没建」的顺序问题。
      inlinePolicies: {
        NotiOpsWebSearchGateway: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "InvokeGateway",
              actions: ["bedrock-agentcore:InvokeGateway"],
              resources: [`arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:gateway/*`],
            }),
            // 内建搜索工具是 AWS 拥有的资源（账号位固定写 `aws`），不是客户账号里的东西。
            new iam.PolicyStatement({
              sid: "InvokeWebSearch",
              actions: ["bedrock-agentcore:InvokeWebSearch"],
              resources: [`arn:${this.partition}:bedrock-agentcore:${this.region}:aws:tool/web-search.v1`],
            }),
          ],
        }),
      },
    });
    (webSearchGatewayRole.node.defaultChild as cdk.CfnResource).cfnOptions.condition = webSearchSupported;

    // 搬运工的建/删权限。同 `StagerOrgSetupPolicy` 一样用**独立的 AWS::IAM::Policy**，
    // 这样非 us-east-1 的栈里搬运工一条 agentcore 权限都没有。
    const stagerWebSearchPolicy = new iam.Policy(this, "StagerWebSearchPolicy", {
      roles: [stagerRole],
      statements: [
        new iam.PolicyStatement({
          // Create/List 这两个动作在授权时还没有资源可指（gateway 尚未存在），只能 `*`。
          sid: "ProvisionWebSearchGateway",
          actions: [
            "bedrock-agentcore:CreateGateway",
            "bedrock-agentcore:ListGateways",
            // 建 gateway 时同时打 auto-delete=no / project=notiops 标签（与栈内其它资源一致）。
            "bedrock-agentcore:TagResource",
          ],
          resources: ["*"],
        }),
        new iam.PolicyStatement({
          sid: "ManageWebSearchGateway",
          actions: [
            "bedrock-agentcore:GetGateway",
            "bedrock-agentcore:DeleteGateway",
            "bedrock-agentcore:CreateGatewayTarget",
            "bedrock-agentcore:ListGatewayTargets",
            "bedrock-agentcore:DeleteGatewayTarget",
          ],
          resources: [`arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:gateway/*`],
        }),
        // 建 Gateway 会**顺带**在默认 workload identity 目录里建一条身份（gateway 用它
        // 换 workload access token）。这一步是服务端拿**调用者的身份**做的，所以少了这条
        // 权限不会让 CreateGateway 报错 —— 它返回 200，然后 gateway 异步变成 FAILED：
        // 「Failed to create gateway dependencies: ... not authorized to perform:
        // bedrock-agentcore:CreateWorkloadIdentity」。`setup.sh` 那条路径踩不到，因为它用的是
        // 部署者（通常是管理员）的凭证。收口到 `default` 这一个目录。
        new iam.PolicyStatement({
          sid: "ManageWebSearchWorkloadIdentity",
          actions: [
            "bedrock-agentcore:CreateWorkloadIdentity",
            "bedrock-agentcore:GetWorkloadIdentity",
            "bedrock-agentcore:DeleteWorkloadIdentity",
          ],
          resources: [
            `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default`,
            `arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:workload-identity-directory/default/workload-identity/*`,
          ],
        }),
        // CreateGateway 带 roleArn → 必须能把这个角色交给 agentcore。收口到这一个角色 +
        // 这一个服务，搬运工拿不到「把任意角色交给任意服务」。
        new iam.PolicyStatement({
          sid: "PassGatewayServiceRole",
          actions: ["iam:PassRole"],
          resources: [webSearchGatewayRole.roleArn],
          conditions: { StringEquals: { "iam:PassedToService": "bedrock-agentcore.amazonaws.com" } },
        }),
      ],
    });
    (stagerWebSearchPolicy.node.defaultChild as cdk.CfnResource).cfnOptions.condition = webSearchSupported;

    // 幂等：同名 gateway 已存在就复用（于是先跑过 `setup.sh` 的账号不会多出第二个），
    // 且删栈时**只删本栈建的那个** —— 归属编码在 PhysicalResourceId 里，见 stager 的
    // `_pid_owns_gateway`。
    // Gateway 名与 `scripts/provision_websearch_gateway.sh` 的 `GW_NAME` 保持一致，
    // 复用判断才认得出对方建的那个。
    const stagerWebSearch = new cdk.CfnResource(this, "StagerWebSearch", {
      type: "Custom::NotiOpsStagerWebSearch",
      properties: {
        ServiceToken: stagerFn.attrArn,
        Phase: "WebSearch",
        GatewayName: "notiops-websearch-gw",
        // target 名决定 agent 侧看到的工具名（`<target>___WebSearch`），必须与
        // core/agentcore_search.py 的 `_TOOL_NAME` 默认值一致。
        TargetName: "web-search-tool",
        ServiceRoleArn: webSearchGatewayRole.roleArn,
        // 每个 Release 都重跑一次这个 Phase。没有它，属性一个都不变 → CFN 根本不调
        // 自定义资源的 Update → 「升级到新版模板」永远拿不到 provisioning 侧的修复，
        // 上一次建失败的部署也没有任何自愈机会（同 Site Phase 的 ReleaseTag）。
        ReleaseTag: releaseTag,
      },
    });
    stagerWebSearch.cfnOptions.condition = webSearchSupported;
    stagerWebSearch.addDependency(stagerFn);
    stagerWebSearch.addDependency(stagerWebSearchPolicy.node.defaultChild as cdk.CfnResource);
    if (stagerPolicy) stagerWebSearch.addDependency(stagerPolicy as cdk.CfnResource);

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

    // Operator App(web app)的角色。这一条替客户免掉了控制台上的
    // 「Agent Space → Access → Operator access → Configure web app」那一次手点 ——
    // 没点过的话 `https://<spaceId>.aidevops.global.app.aws` 域名不存在，
    // CreateBacklogTask / CreateChat 一律报 `Invalid or unregistered domain`，
    // 四样 DevOps Agent 能力(深度调查、直连、DevOps 对话、发布 Skill)全废。
    //
    // 形状是从控制台自己建的那个角色反推来的(两个账号各取一份、逐字段一致)：
    //   · `sts:TagSession` **不能省** —— AIDevOpsOperatorAppAccessPolicy 把资源写成
    //     `agentspace/${aws:PrincipalTag/AgentSpaceId}`，session tag 就是它的授权依据，
    //     少了这条动作，web app 一开就是 AccessDenied。
    //   · `ArnLike .../agentspace/*` 而**不是**控制台那样的 `ArnEquals <精确 ARN>`：
    //     精确 ARN 会让角色引用 space、space 引用角色，CFN 直接判循环依赖。收口靠
    //     `aws:SourceAccount` + 服务/区域前缀，与上面 daPrimaryRole 同一套写法。
    //   · 不指定 roleName：同 daPrimaryRole，固定名会挡住同账号里的第二个栈。
    //
    // 权限范围值得说清楚(客户安全 review 会问)：该托管策略的主体是 `aidevops:*` 且
    // 收口在本账号自己的那一个 agentspace 上，**碰不到客户其它资源**；另有三条
    // Resource:* 的旁支(support 读、transcribe 流、secretsmanager:CreateSecret)——
    // 最后一条是写权限。这个角色只被 aidevops 服务用于它自己的 web app，不是 agent
    // 用的角色；且与客户手点那个按钮建出来的角色**完全一致**，自动化没有让姿态变差。
    const daOperatorAppRole = new iam.Role(this, "DevOpsAgentOperatorAppRole", {
      assumedBy: new iam.ServicePrincipal("aidevops.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": cdk.Aws.ACCOUNT_ID },
          ArnLike: { "aws:SourceArn": `arn:${this.partition}:aidevops:${this.region}:${this.account}:agentspace/*` },
        },
      }).withSessionTags(),  // ← 这就是那条 sts:TagSession
      description: "Assumed by AWS DevOps Agent for its per-Agent-Space operator web app",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AIDevOpsOperatorAppAccessPolicy")],
    });

    const agentSpace = new devopsAgent.CfnAgentSpace(this, "DevOpsAgentSpace", {
      name: `notiops-oneclick-${cdk.Aws.ACCOUNT_ID}`,
      description: "NotiOps deep investigation (one-click deployment)",
      // 建 space 的同时把 web app 开好(CFN 的 create handler 替我们调
      // aidevops:EnableOperatorApp，delete handler 调 DisableOperatorApp —— 删栈自动收尾)。
      // 只走 `iam` 认证流：我们的 BFF 是 SigV4 直连；IdC / IdP 是客户自己的选择，不替他们定。
      operatorApp: { iam: { operatorAppRoleArn: daOperatorAppRole.roleArn } },
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
    // Operator App 角色同理 —— 它没有内联策略（只挂托管策略），helper 里的
    // tryFindChild("DefaultPolicy") 拿不到东西就跳过，不用特殊照顾。
    applyCondition(daOperatorAppRole, deepInvestigationEnabled);

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
    // 执行角色与 `setup.sh` 那条路径的 runtime 执行角色**逐条对齐**（权威源是
    // agent-build/NotiOpsWebChat/agentcore/cdk/lib/cdk-stack.ts:116-396）。两条路径的 web
    // 功能必须一致 —— 少一条授权的后果不是"功能没做"，而是"界面上有开关、点了静默失败"。
    // `scripts/test_oneclick_parity.py` 会断言这两份清单不漂移。
    //
    // 唯一有意不给的是 AgentCore Memory：本栈不建 Memory 资源，而 grep 过 core/ 与 agent/，
    // 没有任何代码读 MEMORY_* 环境变量 —— 那条授权在两条路径上都是死权限。
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
    // Bedrock Mantle —— 模型目录里的 GPT 系（10 条里 3 条）走 Mantle，不是 bedrock:InvokeModel。
    // 缺了这两条的失败模式：Admin 里能把 GPT 存成默认模型、保存时的连通性探测也过
    // （探测用 **BFF** 的角色），但用户一发消息就 401/403 —— 存得进去、调不出去。
    // CreateInference/GetInference 的资源类型是 `project`（必填），CallWithBearerToken 是
    // permission-only action（资源类型一列为空）→ 只能 "*"。理由与区域名单见
    // agent-build/NotiOpsWebChat/agentcore/cdk/lib/cdk-stack.ts:116-156。
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsBedrockMantleInference",
      actions: ["bedrock-mantle:CreateInference", "bedrock-mantle:GetInference"],
      resources: MANTLE_REGIONS.map((r) => `arn:${this.partition}:bedrock-mantle:${r}:${this.account}:*`),
    }));
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsBedrockMantleBearer",
      actions: ["bedrock-mantle:CallWithBearerToken"],
      resources: ["*"],
    }));
    // Bedrock API Key（Admin → 凭证方式选 "API Key"）。写入方是 BFF（web-chat-core.ts 的
    // `BedrockApiKeySecretAccess`，两条路径都有），读取方是这里：core/llm_config
    // .get_bedrock_api_key() → model/load.py 注入 AWS_BEARER_TOKEN_BEDROCK。
    // 缺这一条的失败模式是**静默的**：GetSecretValue 被拒 → 回退 IAM 角色 → 对话照常，
    // 管理员在 UI 上看不出 Key 从未生效。secret 由 BFF 按需创建（栈里不预建），
    // 名字尾部有 Secrets Manager 加的 6 位随机后缀，故用 `-*`。
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadBedrockApiKeySecret",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:${this.partition}:secretsmanager:${this.region}:${this.account}:secret:notiops/bedrock-api-key-*`],
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
    // MCP 规格快照（core/mcp_snapshot.py）—— 冷启动优化的落盘位置。
    // AgentCore 按 session 隔离，每个新会话都是真冷启动；而挂工具前必须先有 schema，
    // 今天只能把 5 个 stdio MCP server 全拉起来再 list_tools（最慢那个现网实测 9.3s，
    // 整段落在用户看到第一个字之前）。快照到 S3 之后，新会话直接读快照挂工具，子进程
    // 推到后台预热。键里含包版本指纹 → 某个 MCP server 升版就自动 miss 重建，所以
    // Put 与 Get 都要。全失败安全：读不到/写不了都只是回到今天的慢路径。
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsMcpSnapshotCache",
      actions: ["s3:GetObject", "s3:PutObject"],
      resources: [base.dataBucket.arnForObjects("mcp-snapshots/*")],
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
    // 联网搜索：agent 用**自己的**身份 SigV4 调 Gateway 的 MCP 端点
    // （core/agentcore_search.py）。与 `setup.sh` 路径的 `NotiOpsInvokeWebSearchGateway`
    // 同一条授权，**同样不带条件** —— 授权本身无副作用，而带上条件反而会让
    // 「先在别的区部署、之后再迁到 us-east-1」这类情况多出一次 IAM 往返。
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "NotiOpsInvokeWebSearchGateway",
      actions: ["bedrock-agentcore:InvokeGateway"],
      resources: [`arn:${this.partition}:bedrock-agentcore:${this.region}:${this.account}:gateway/*`],
    }));
    // 模型目录 / RBAC 等配置（agent 侧也要读，例如按角色裁剪工具）。
    runtimeRole.addToPolicy(new iam.PolicyStatement({
      sid: "ReadNotiOpsConfig",
      actions: ["dynamodb:GetItem", "dynamodb:Query"],
      resources: [base.configTable.tableArn, `${base.configTable.tableArn}/index/*`],
    }));
    // 多账号：agent 要跨账号的两个动作。单账号模式下这个资源整块不存在，所以是真的一条
    // 权限都不给：用**独立的 AWS::IAM::Policy**（不是 role.addToPolicy）才做得到——
    // DefaultPolicy 那份文档由 CDK 生成，往里塞 Fn::If 就得跟生成逻辑赛跑。
    const runtimeCrossAccount = new iam.Policy(this, "AgentRuntimeCrossAccount", {
      roles: [runtimeRole],
      statements: [
        // (a) 所有跨账号**取数**（cases / 资源巡检 / FinOps 按目标账号取数）都经这个角色。
        //     成员账号里的它由 StackSet `notiops-member-onboarding` 下发（见 Phase=OrgSetup）。
        //     缺这一条：接入向导会成功、目标账号在下拉里能选，但每个跨账号问题都失败 ——
        //     最坏情况是模型退化用**部署账号**的数据回答（错误归因）。
        new iam.PolicyStatement({
          sid: "AssumeMemberIdleDetectionRoles",
          actions: ["sts:AssumeRole"],
          resources: [`arn:${this.partition}:iam::*:role/notiops-idle-detection-role*`],
        }),
        // (b) 到成员账号的 trigger 角色去发起深度调查（core/devops_agent.py `_assume_client`，
        //     角色 ARN 来自 Admin 接入时写的 da# 配置行）。
        new iam.PolicyStatement({
          sid: "AssumeMemberDevOpsAgentTriggerRole",
          actions: ["sts:AssumeRole"],
          resources: [`arn:${this.partition}:iam::*:role/notiops-agent-trigger-*`],
        }),
      ],
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
        // 900 秒下，用户离开十几分钟回来提问就吃一次冷启动（实测 ~10s，BFF 那边只能靠
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
          // 报告分发 CDN。缺这个键 core/reports.py 退回 12h presigned URL，与「7 天有效」
          // 的产品承诺和桶生命周期都不符（见 minimal-base-core.ts 的 ReportsCDN）。
          REPORTS_CDN_DOMAIN: base.reportsCdnDomain,
          // 同上：关掉深度调查时整个键消失，绝不写空串。
          // 不写这个键时 agent 会走 ListAgentSpaces 自动发现（core/devops_agent.py），
          // 显式给了就少一次 API、也不会挑错（同账号里可能还有别的 Agent Space）。
          DEVOPS_AGENT_SPACE_ID: cdk.Fn.conditionIf(
            deepInvestigationEnabled.logicalId, agentSpace.attrAgentSpaceId, cdk.Aws.NO_VALUE,
          ),
          // 跨账号闸门（core/aws_session.py `_is_locked_out`）。它是**默认拒绝**的：既没设
          // LOCKED_ACCOUNT_ID、也没设这个键时，只允许部署账号，跨账号一律拒。所以多账号模式
          // 必须显式打开 —— 否则接入向导成功、下拉里能选成员账号、每个问题都被闸门挡掉。
          // 单账号模式下整个键消失（安全默认），与 scripts/deploy_agent.sh 的出厂值一致。
          NOTIOPS_ALLOW_CROSS_ACCOUNT: cdk.Fn.conditionIf(isMultiAccount.logicalId, "1", cdk.Aws.NO_VALUE),
          // 联网搜索的 Gateway /mcp 端点（core/agentcore_search.py）。不支持的区里整个键
          // 消失；us-east-1 里 provision 失败时 stager 回的是字面量 "unavailable"
          // （**不能**回空串：AgentCore Runtime 拒绝空字符串环境变量，而那时已经在部署
          // 中途、没法再把这个键整个删掉），agent 侧只认 https:// 开头的值。
          AGENTCORE_WEBSEARCH_GATEWAY_URL: cdk.Fn.conditionIf(
            webSearchSupported.logicalId, stagerWebSearch.getAtt("GatewayUrl").toString(), cdk.Aws.NO_VALUE,
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
      // 报告分发 CDN（同栈资源，见 minimal-base-core.ts）。BFF 的「深度调查（直连）」
      // 没有 presign 分支，域名为空就不产出报告链接。
      reportsCdnDomain: base.reportsCdnDomain,
      // 不带的只有 `idleConsoleUrl`：它指向完整部署才有的管理仪表盘，而侧边栏那个入口
      // 本来就被 `SHOW_INSPECTIONS = false` 隐藏（Sidebar.tsx），AdminPanel 里也只是一个
      // 可选的 ↗ 外链 —— 空串是正确取值，不是缺口。
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
    // Bedrock API Key 的 secret 是 BFF 按需建的、不在栈里（见 web-chat-core.ts 的
    // `BedrockApiKeySecretAccess`），CFN 不会删它 —— DeleteEverything 时由 StagerFn 收尾。
    // 精确到这一个名字：不给「删本账号任意 secret」。
    stagerRole.addToPolicy(new iam.PolicyStatement({
      sid: "TeardownDeleteBedrockApiKeySecret",
      actions: ["secretsmanager:DeleteSecret"],
      resources: [`arn:${this.partition}:secretsmanager:${this.region}:${this.account}:secret:notiops/bedrock-api-key-*`],
    }));

    // 出厂模型目录的种子（`PK=llmcfg / SK=meta`）。`setup.sh` 用
    // `scripts/seed_llm_catalog.py` 写这一条；一键路径原先**根本不写**，于是管理员
    // 打开「管理 → 模型」看到的是一张空表（实测 2026-08-26，方式 A 部署的环境）。
    // 条件写在 handler 里，覆盖不了管理员改过的配置。
    // GetItem/UpdateItem 是给"已存在时补新增模型"那一步用的（`_top_up_llm_catalog`）：
    // 只有 PutItem 的话，首次部署之后再进目录的模型永远到不了这个环境 —— 不报错，
    // 只是管理台和模型选择器里少一个（2026-08-27 现网的 zai-glm-5 就是这么丢的）。
    stagerRole.addToPolicy(new iam.PolicyStatement({
      sid: "SeedLlmCatalog",
      actions: ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem"],
      resources: [base.configTable.tableArn],
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
        ConfigTable: base.configTable.tableName,
        LlmCatalog: llmCatalogJson,
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
        // BFF 按需创建的 secret（栈外资源）。名字与 bff/web-chat/llm_config.mjs::SECRET_ID
        // 和 core/llm_config.py::_BEDROCK_KEY_SECRET 的默认值一致。
        SecretNames: cdk.Stack.of(this).toJsonString(["notiops/bedrock-api-key"]),
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

    // ══ 「通知」生产端 ═════════════════════════════════════════════════════════
    // 读端（`notif#` 段、BFF 的 `/notifications*`、侧栏红点）本来就在 createWebChatCore
    // 里，两条部署路径自动对等；**生产端过去只有方式 B 有** —— 于是一键部署出来的环境
    // 里「通知」页面永远是空的：不报错、不写日志，客户只会以为这个功能是假的
    // （实测 2026-08-27 的现网一键模板，0 条 EventBridge 规则）。
    //
    // 事件源清单、Lambda 名、handler、规则名、环境变量全部 import 自
    // `constructs/web-notif-sources.ts`，与方式 B 逐字同源。两条路径**唯一**的差别是
    // 「怎么关掉某一个源」：方式 B 是合成期 `-c webNotif<Id>=off`，这里没有 context
    // （模板是预先合成发布的），客户去 EventBridge 控制台 Disable 那条规则即可 ——
    // 升级模板不会把它改回来，因为规则属性本身不随版本变化，CFN 判定为无变更。
    // 日志组**不写死名字**，而是让 CFN 自己命名、再用 LoggingConfig 把函数指过来
    // （同 BFF 的做法）。写死 `/aws/lambda/<函数名>` 的代价是致命的：Lambda 服务
    // 自己建的那种同名组**不属于任何栈**（方式 B 就是这样留下的），于是同一个账号里
    // 只要曾经跑过 setup.sh，一键部署就在 CFN 的 NAME_CONFLICT_VALIDATION 上
    // **9 秒内整栈失败**："Resource of type 'AWS::Logs::LogGroup' with identifier
    // '/aws/lambda/notiops-web-notif-handler' already exists."（2026-08-28 实测，
    // v1.0.16 模板；错误里只有日志组，客户完全看不出这跟「通知」有什么关系。）
    // LoggingConfig 一并解决了原先写死名字要解决的那件事：函数只会往这个组里写，
    // 不会再在首次调用时自建一个同名组。
    const webNotifLogs = new logs.LogGroup(this, "WebNotifLogs", {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 栈内资源 → 删栈一并删掉
    });

    const webNotifRole = new iam.Role(this, "WebNotifRole", {
      assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
      description: "NotiOps web notification producer",
    });
    webNotifRole.addToPolicy(new iam.PolicyStatement({
      sid: "WebNotifOwnLogStreams",
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [webNotifLogs.logGroupArn, `${webNotifLogs.logGroupArn}:*`],
    }));
    // 只给 PutItem，且只给这一张表。handler 只做两件写操作：去重标记与收件箱条目，
    // 两者都是 PutItem（去重那次带 ConditionExpression，条件写不需要额外权限）。
    webNotifRole.addToPolicy(new iam.PolicyStatement({
      sid: "WebNotifWriteInbox",
      actions: ["dynamodb:PutItem"],
      resources: [webchat.table.tableArn],
    }));
    const webNotifRolePolicy = webNotifRole.node.tryFindChild("DefaultPolicy")?.node.defaultChild;

    // L1：代码在 staging 桶里（同 BFF），而 L2 的 `Code.fromBucket` 会引入
    // 版本参数/资产语义上的额外包袱；这里直接给 s3Bucket/s3Key 最省事也最好读。
    const webNotifFn = new lambda.CfnFunction(this, "WebNotifFn", {
      functionName: WEB_NOTIF_FUNCTION_NAME,
      role: webNotifRole.roleArn,
      runtime: "python3.13",
      handler: WEB_NOTIF_HANDLER,
      code: { s3Bucket: stagingBucket.bucketName, s3Key: webNotifKey },
      // 一次调用 = 解析一个事件 + 最多两次 PutItem。60s/256MB 与方式 B 一致
      // （方式 B 走的是 commonLambdaProps + 显式覆盖，值相同）。
      timeout: 60,
      memorySize: 256,
      environment: { variables: webNotifEnv(webchat.table.tableName) },
      description: WEB_NOTIF_FUNCTION_DESCRIPTION,
      // 指到上面那个 CFN 命名的日志组 —— 见 WebNotifLogs 处的注释。
      loggingConfig: { logGroup: webNotifLogs.logGroupName },
    });
    webNotifFn.addDependency(webNotifLogs.node.defaultChild as cdk.CfnResource);
    webNotifFn.addDependency(webNotifRole.node.defaultChild as cdk.CfnResource);
    if (webNotifRolePolicy) webNotifFn.addDependency(webNotifRolePolicy as cdk.CfnResource);
    // 代码在 staging 桶里 → 必须等 StagerFn 搬完。
    // （`scripts/postprocess_template.py::assert_clean` 也会强制校验这条依赖存在。）
    webNotifFn.addDependency(stagerArtifacts);

    // 一条通配 Permission 覆盖全部规则，而不是每条规则一个 ——
    // 10 个 `AWS::Lambda::Permission` 换成 1 个，且以后加事件源不用再动这里。
    // 通配只到我们自己的规则名前缀，不是「本账号任意 EventBridge 规则都能调它」。
    new lambda.CfnPermission(this, "WebNotifInvokeByEvents", {
      action: "lambda:InvokeFunction",
      functionName: webNotifFn.attrArn,
      principal: "events.amazonaws.com",
      sourceArn: `arn:${this.partition}:events:${this.region}:${this.account}:rule/${webNotifRuleName("")}*`,
    });

    for (const src of WEB_NOTIF_SOURCES) {
      new events.CfnRule(this, `WebNotifRule${src.id}`, {
        name: webNotifRuleName(src.id),
        description: webNotifRuleDescription(src),
        eventPattern: { source: [src.source], "detail-type": [src.detailType] },
        state: src.on ? "ENABLED" : "DISABLED",
        targets: [{ id: "WebNotifTarget", arn: webNotifFn.attrArn }],
      });
    }

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
        // 每个 Release 都重跑一次这个 Phase（同 Site / WebSearch 的 ReleaseTag）。
        // 少了它，只有**成员账号模板本身**改了才会有属性变化 —— 两份 yaml 是在合成期
        // 读进来内联的，所以它们变了确实会触发 Update。但 handler 侧的修复（`_org_setup`
        // / `_stackset_upsert` 里的逻辑）不体现为任何属性变化 → CFN 根本不发 Update →
        // 已有的多账号部署升级到新模板时拿不到那些修复，也没有任何自愈机会
        // （上一次 StackSet 建失败的部署尤其：它会一直失败下去）。
        ReleaseTag: releaseTag,
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
    // 联网搜索同理：不写清楚的话，「开关点了没结果」这种情况客户只能猜。
    // **拆成两个 Output**，理由和上面 DevOpsAgentSpaceId 一样：真结果只有那个带条件的自定义
    // 资源知道，而在 Output 的 Value 里引用条件资源、只靠 `Fn::If` 挡着会让 CFN 模板校验告警。
    // 于是「这个区有没有这个能力」放常在的 WebSearchStatus，「到底建成了没有」放带条件的
    // WebSearchProvisioning。
    //
    // 这里**不能**由 WebSearchStatus 直接说 "Enabled"：provisioning 是**故意不抛异常**的
    // （联网搜索挂了不该让整栈回滚，见 stager 的 `_websearch`），所以栈 CREATE_COMPLETE
    // 完全可能配着一个建失败的 gateway —— 静态文案会当着客户的面把失败说成成功。
    new cdk.CfnOutput(this, "WebSearchStatus", {
      description: "Web search (AWS-native AgentCore web search)",
      value: cdk.Fn.conditionIf(
        webSearchSupported.logicalId,
        "Supported in this Region: the stack provisions an AgentCore gateway named "
          + "notiops-websearch-gw (or reuses an existing one) and queries stay inside AWS. "
          + "Whether that actually succeeded is in the WebSearchProvisioning output: 'enabled' "
          + "means the toggle works, 'unavailable (<code>)' means it returns nothing.",
        "Not available: AgentCore web search only exists in us-east-1, so nothing was created. "
          + "Everything else in this deployment works; the web-search toggle just returns no results.",
      ).toString(),
    });
    // `Status` 是 stager 在成功和失败两条路径上**都会**写的 key（失败时是
    // `unavailable (<code>)`）；别在这里 GetAtt 别的 key —— 只在成功时才有的 key 会让
    // Output 解析直接失败，把「可选能力挂了」升级成「整栈挂了」。
    const webSearchProvisioning = new cdk.CfnOutput(this, "WebSearchProvisioning", {
      description: "Did the web-search gateway actually get provisioned",
      value: stagerWebSearch.getAtt("Status").toString(),
    });
    webSearchProvisioning.condition = webSearchSupported;
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
