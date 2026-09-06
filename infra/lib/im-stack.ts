import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as fs from "fs";
import * as path from "path";
import { createImCore } from "./constructs/im-core";

export interface ImStackProps extends cdk.StackProps {
  metricsTableName: string;
  configTableName: string;
  conversationsTableName: string;
  skillsBucketName: string;
  /** 报告分发 CDN 域名（`REPORTS_CDN_DOMAIN`）。见 infra/bin/app.ts 里那段注释。 */
  reportsCdnDomain?: string;
  /** 排障 Agent Space id（`DEVOPS_AGENT_SPACE_ID`）。app.ts 传 `main.agentSpaceId`。
   *
   *  这是**跨栈引用**（Export/ImportValue），但不新增 Export —— WebChatStack 早就
   *  引用了同一个 `main.agentSpaceId`（app.ts:105），CDK 会复用那个 Export。
   *  语义与作用见 `im-core.ts` 的 `devopsAgentSpaceId` prop 注释。 */
  devopsAgentSpaceId?: string;
  /** 逗号分隔；默认取 -c enabledPlatforms（BotStack 同一个 context 键）。 */
  enabledPlatforms?: string[];
}

/**
 * IM 侧 Lambda + Webhook 栈（IM 重构 / M1 + M3）—— **方式B（setup.sh / CDK）**。
 *
 * 取代 BotStack 里的 ECS Fargate 常驻容器：
 *   · ingress  —— API Gateway HTTP API 收飞书/Slack 事件，验签 + 解密后异步投 worker，秒回 ACK；
 *   · worker   —— 真正干活（确定性路由 → DevOps Agent 直连 / 发起调查 / 案例流程）；
 *   · progress —— EventBridge rate(1 minute) 扫 `imtask#` 行，PATCH 调查进度卡片。
 *
 * ⚠️ 三个函数的**定义本身**在 [constructs/im-core.ts](constructs/im-core.ts)，方式A
 * （一键 CloudFormation，notiops-webchat-standalone-stack.ts）用的是同一个 construct。
 * 本文件只负责方式B 专属的三件事：依赖层构建校验、`fromAsset` 代码资产、写死的物理名。
 * **改超时/内存/环境变量/IAM 一律去 im-core.ts 改**，否则两条路径会漂移（违反
 * 「方式A/方式B 功能必须对等」）。
 *
 * ── 为什么是独立一个 Stack，而不是往 BotStack 里加 ────────────────────────────
 * BotStack 里那 5 处 `ContainerImage.fromAsset("../")` 会把**整个仓库根**当 Docker
 * build context 扫一遍（实测 594s）。IM 这三个函数跟镜像半点关系没有，塞进去等于
 * 每次改一行 Python 都要陪着等十分钟。独立栈 = `cdk deploy ImStack` 只打 zip。
 * 也让 M2「删掉 Fargate」变成删一个栈的事，而不是在同一个栈里做大手术。
 *
 * ── 公网入口为什么是 API Gateway HTTP API ────────────────────────────────────
 * 原来用的是 Lambda Function URL（`AuthType=NONE`）。2026-09-01 起换成 HTTP API ——
 * **不是为了加鉴权**（飞书/Slack 不会签 SigV4，入口注定未鉴权），而是因为
 * `Principal:"*" + lambda:InvokeFunctionUrl` 这个**策略形状**会被"公网可达"类检测
 * 判定为 world-accessible 并自动摘掉那条许可（实测：入口从此对所有人 403，IM 静默
 * 断掉）。完整推理 + 为什么 CloudFront+OAC 走不通，见 im-core.ts 的
 * `createIngressHttpApi()` 文件头注释。
 *
 * 真正的安全边界一条没变，还是那四道（见 im-core.ts 各处注释）：
 *   1. 验签/解密 fail-fast（两把钥匙缺一即冷启动失败，见 lambda_ingress.py 文件头）；
 *   2. ingress 上 reservedConcurrentExecutions=10 + HTTP API 阶段级限流 —— 公网
 *      未鉴权入口的花费上限；
 *   3. ALLOWED_CHAT_IDS 群允许清单（worker 侧）；
 *   4. 幂等去重在 worker（ddb_state.put_new_event）。
 */
export class ImStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ImStackProps) {
    super(scope, id, props);

    // 多账号(Organizations)模式：与 BotStack / BackendStack 同口径。
    const orgMode = ((this.node.tryGetContext("organizationId") as string | undefined)?.trim() || "").length > 0;
    const lockedAccountId = orgMode ? "" : cdk.Aws.ACCOUNT_ID;

    const enabledPlatforms = props.enabledPlatforms
      ?? (this.node.tryGetContext("enabledPlatforms") as string || "feishu")
          .split(",").map((s: string) => s.trim().toLowerCase());

    // 群白名单（可选）。留空 = 不限制（与长连接时代行为一致）。
    const allowedChatIds = (this.node.tryGetContext("imAllowedChatIds") as string || "").trim();

    // ─── 依赖层 ───────────────────────────────────────────────────────────
    // lark_oapi + slack_sdk + boto3/botocore。**必须**用 scripts/build_im_layer.sh 构建
    // （--platform manylinux2014_x86_64），否则 Mac 上装出来的是 macOS 二进制，
    // Lambda 上 import 直接炸。层目录不存在时这里会在 synth 期就失败 —— 是有意的，
    // 比部署上去再看 ImportError 便宜。
    const imLayerDir = path.join(__dirname, "..", "..", "lambda_layer_im");
    // 显式 fail-fast，而不是让 fromAsset 抛「Cannot find asset at ...」。
    // 差别在于**可执行的下一步**：那句报错不会告诉你该跑哪个脚本，而缺层的后果
    // （Lambda 上 `import lark_oapi` 失败 → ingress 冷启动即崩 → 飞书侧只看到超时）
    // 排查成本极高。宁可 synth 期就停。
    // 这里不做「层不存在就跳过 IM」的降级 —— 那会让 enabledPlatforms=feishu 的部署
    // 静默产出一个没有 IM 的栈（违反「不许静默降级」）。
    // ⚠️ 检查的是**具体包在不在**，不是 `python/` 目录在不在。
    // 只判目录会被"空目录"骗过去 —— build_im_layer.sh 是先 `mkdir -p python/` 再
    // pip install，构建中途失败（比如断网装不到 lark-oapi）会留下一个**空的**
    // `python/`。那时 existsSync 为真 → synth 通过 → 部署上去一个 0 个包的层 →
    // Lambda 上 `import lark_oapi` 崩，而飞书侧只看到超时。2026-09-01 实测踩到。
    const required = ["lark_oapi", "slack_sdk", "botocore"];
    const present = fs.existsSync(path.join(imLayerDir, "python"))
      ? fs.readdirSync(path.join(imLayerDir, "python"))
      : [];
    const missing = required.filter((p) => !present.includes(p));
    if (missing.length > 0) {
      throw new Error(
        `IM 依赖层不完整：${imLayerDir}/python 缺 ${missing.join(", ")}。\n` +
        "先构建再部署：bash scripts/build_im_layer.sh\n" +
        "（该脚本需要能访问 PyPI；层里是 lark-oapi + slack-sdk + boto3/botocore 的 " +
        "manylinux2014_x86_64 wheel，不能用 Mac 上装的那份。）"
      );
    }
    // 层必须是**预编译过**的（带 `__pycache__/*.pyc`）。层在 Lambda 上是只读挂载，
    // CPython 写不出字节码缓存，所以没有 .pyc 时**每一次**冷启动都要把整个层（10967 个
    // .py，其中 `import lark_oapi` 一家就 9128 个模块）从源码重新编译 —— 实测 9.5~12.7s，
    // 撞上 Lambda 那条**与函数 timeout 无关的 10 秒 INIT 硬上限**：
    //   INIT_REPORT Init Duration: 9999.xx ms  Phase: init  Status: timeout
    // 然后 init 在第一次调用里重跑一遍。ingress 的 webhook 只有 ~3 秒（飞书 URL
    // challenge / 卡片按钮），所以这不是"慢一点"而是必然失败；2026-09-03 现网实测
    // ingress 因此出现过 3 次 `Runtime.Unknown`。带 .pyc 后是 2.9~5.4s。
    // 只抽查 lark_oapi —— 它是层里最大的那个包，也是这个坑唯一的来源；全量数 .pyc
    // 要走 10000+ 个文件，synth 期不值得。完整校验在 build_im_layer.sh 里。
    if (!fs.existsSync(path.join(imLayerDir, "python", "lark_oapi", "__pycache__"))) {
      throw new Error(
        `IM 依赖层没有预编译：${imLayerDir}/python/lark_oapi/__pycache__ 不存在。\n` +
        "部署上去每次冷启动都会重新编译整个层（Init > 10s → INIT timeout，" +
        "飞书 webhook 必然超时）。\n" +
        "重新构建：bash scripts/build_im_layer.sh\n" +
        "（原因与实测数字见该脚本里「预编译字节码」那段注释。）"
      );
    }
    const imLayer = new lambda.LayerVersion(this, "ImDepsLayer", {
      code: lambda.Code.fromAsset(imLayerDir),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
      // 与 scripts/build_im_layer.sh 里三个 *_VERSION 保持一致（改那边记得改这句 ——
      // 这是运维在控制台唯一能看到层里装了什么的地方）。
      description: "IM deps: lark-oapi 1.6.5 + slack-sdk 3.33.5 + boto3/botocore 1.43.65",
    });

    // ─── 代码资产 ─────────────────────────────────────────────────────────
    // 排除清单在 [../im-code-exclude.txt](../im-code-exclude.txt) —— **方式A 的
    // scripts/build_im_zips.py 读的是同一个文件**。曾经两边各写一份，但漏一条/多一条
    // 只在方式A 暴露（客户账号里 ImportModuleError 或 250MB 解压上限），必然漂，
    // 所以合成了一处。每条模式为什么在那里，注释都在那个文件里（含 `.cdk-out` 兜底
    // 与 `dist/**` 两个实测踩过的坑）。
    //
    // ⚠️ 与 notiops-backend-stack.ts 里的 `lambdaCode` **只差一条**：这里**不能**
    // exclude `platforms/**` —— IM 的三个 handler 全在 platforms/ 下。抄那份 exclude
    // 列表时把 platforms/** 一起抄进来，症状是 handler not found（不是构建报错）。
    //
    // 老坑复述一遍（清单里的 `.cdk-out` 只是兜底）：cdk synth/deploy 必须带 --output
    // 指到仓库根**之外**（setup.sh:1095 用 `${TMPDIR:-/tmp}/notiops-cdk-out` —— 注意
    // **不是** `../.cdk-out`：那个路径就在仓库根里）。fromAsset("../") 打包仓库根，
    // 输出目录若落在被打包的树里 → 自引用递归复制 → ENAMETOOLONG。
    const excludeFile = path.join(__dirname, "..", "im-code-exclude.txt");
    const exclude = fs.readFileSync(excludeFile, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    // 判据而不是洁癖：这个文件被清空 / 路径写错时，`exclude: []` 会**成功**打出一个
    // 把 .venv 和 dist/ 都塞进去的资产（几百 MB，且部署到一半才报 250MB 上限）。
    // 数量下限 + 两条哨兵模式让"清单没读到"当场失败。
    const sentinels = ["dist/**", ".cdk-out", "**/node_modules/**"];
    const missingSentinels = sentinels.filter((s) => !exclude.includes(s));
    if (exclude.length < 20 || missingSentinels.length > 0) {
      throw new Error(
        `${excludeFile} 读出来只有 ${exclude.length} 条模式` +
        (missingSentinels.length ? `，且缺哨兵 ${missingSentinels.join(", ")}` : "") +
        "。IM 代码资产的排除清单必须完整 —— 否则会把 .venv/dist 一起打进 Lambda 包。"
      );
    }
    const imCode = lambda.Code.fromAsset("../", { exclude });

    const im = createImCore(this, {
      metricsTableName: props.metricsTableName,
      configTableName: props.configTableName,
      conversationsTableName: props.conversationsTableName,
      skillsBucketName: props.skillsBucketName,
      reportsCdnDomain: props.reportsCdnDomain,
      lockedAccountId,
      allowedChatIds,
      devopsAgentSpaceId: props.devopsAgentSpaceId,
      code: imCode,
      layer: imLayer,
      // 写死物理名：客户文档（docs/IM_WEBHOOK_SETUP.md 的 `aws logs tail` 命令）、
      // 运维脚本都按这些名字来。方式A 那边带 StackName 前缀，理由见 im-core.ts 文件头。
      fnName: (role) => `notiops-im-${role}`,
      explicitLogGroupNames: true,
      platforms: {
        feishu: enabledPlatforms.includes("feishu"),
        slack: enabledPlatforms.includes("slack"),
      },
      progressRuleName: "notiops-im-progress-tick",
      keepAliveRuleName: (role) => `notiops-im-keepalive-${role}`,
    });

    if (im.feishuWebhookUrl) {
      new cdk.CfnOutput(this, "FeishuWebhookUrl", {
        value: im.feishuWebhookUrl,
        description: "飞书开放平台「事件与回调 → 请求地址」填这个（卡片回调也填同一个）",
      });
    }

    if (im.slackWebhookUrl) {
      new cdk.CfnOutput(this, "SlackWebhookUrl", {
        value: im.slackWebhookUrl,
        description: "Slack App 的 Event Subscriptions / Interactivity / Slash Commands 三处都填这个",
      });
    }

    new cdk.CfnOutput(this, "ImEnabledPlatforms", {
      value: enabledPlatforms.join(",") || "none",
      description: "本栈实际创建了哪些 IM 平台的 Lambda",
    });
  }
}
