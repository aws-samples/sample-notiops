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
 *
 * ⚠️ 资源定义全部在 lib/constructs/web-chat-core.ts 的 `createWebChatCore()` 里 ——
 * 一键部署（Launch Stack）的 standalone 单栈复用同一份定义。
 * 那里导出的是**函数**而非 Construct 子类，
 * 目的就是让本栈的逻辑 ID 一个都不变（Construct 会多插一层路径 → 全量重建）。
 */
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as fs from "fs";
import * as path from "path";
import { createWebChatCore, WebChatCoreProps } from "./constructs/web-chat-core";

export interface WebChatStackProps extends cdk.StackProps, WebChatCoreProps {}

export class WebChatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebChatStackProps) {
    super(scope, id, props);

    createWebChatCore(this, { ...props, ...this.costMcpAssets() });
  }

  /**
   * 自建成本 MCP server 在**方式 B** 上的代码来源（`-c costMcpSelfHosted=true` 时才建）。
   *
   * 为什么在栈里而不是在 `web-chat-core.ts` 里：那个构件被**两条路径共用**，而
   * `Code.fromAsset` 是方式 B 专属的 —— 一键模板明令禁止它（会拉出隐式 CDK 资产，
   * 见 notiops-webchat-standalone-stack.ts 文件头）。所以资源定义共用、**资产来源各自提供**，
   * 与 `im-core.ts` 的 `code: lambda.Code` prop 同一套办法。
   */
  private costMcpAssets(): Partial<WebChatCoreProps> {
    if (String(this.node.tryGetContext("costMcpSelfHosted") ?? "") !== "true") return {};

    const repoRoot = path.join(__dirname, "..", "..");
    const layerDir = path.join(repoRoot, "lambda_layer_cost");
    // 判据而不是洁癖：层目录不存在 / 是空的时候，`fromAsset` 会**成功**打出一个空层，
    // 部署也会成功，然后 Lambda 上 `import mcp` 崩 —— 而客户侧只看到"数据源不可用"。
    // 与 im-stack.ts 那道 `REQUIRED_IN_LAYER` 校验同一条理由：不信任脏状态。
    const layerPython = path.join(layerDir, "python");
    if (!fs.existsSync(path.join(layerPython, "mcp")) || !fs.existsSync(path.join(layerPython, "mangum"))) {
      throw new Error(
        `costMcpSelfHosted=true but ${layerPython} does not contain mcp/ and mangum/. `
        + "Build the layer first:  bash scripts/build_cost_layer.sh  "
        + "(it pins every dependency from cost_mcp/requirements.txt and verifies each "
        + "native extension's ABI against the Lambda runtime).",
      );
    }

    return {
      // 资产根必须是**仓库根**（handler 是 `cost_mcp.lambda_handler.handler`，
      // 所以 `cost_mcp/` 得是资产里的一个包）。用 `*` + `!` 反选把其余全部排掉 ——
      // 比逐个列排除项可靠：新增顶层目录时不会被悄悄带进来。
      //
      // 🔴 **`*` 不匹配以点开头的名字** —— 这是实测出来的（2026-09-20）：只写 `*` 时
      // `.gitlab-ci.yml` / `.gitleaks.toml` / `.gitignore` / `.dockerignore` / `.DS_Store`
      // 以及 `.venv/.gitignore` 之类全都漏进了资产。方式 A 里这个 zip 会被下发到**客户
      // 账号**，把内部 CI 配置和 gitleaks 规则一起送出去 —— 所以 `.*` 这两条不是洁癖。
      // 判据见 tests/test_cost_mcp_asset_scope.py（断言资产里除 cost_mcp/ 外一个文件都没有）。
      costMcpCode: lambda.Code.fromAsset(repoRoot, {
        exclude: [
          "*", ".*", ".*/**",
          "!cost_mcp", "!cost_mcp/**",
          "cost_mcp/**/__pycache__/**", "cost_mcp/**/*.pyc",
        ],
      }),
      costMcpLayer: new lambda.LayerVersion(this, "CostMcpLayer", {
        code: lambda.Code.fromAsset(layerDir),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_14],
        description: "NotiOps: cost MCP server dependencies (mcp / mangum / boto3, pinned)",
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      curTable: (this.node.tryGetContext("curTable") as string) || undefined,
      // 与方式 A 对齐：`CUR_TABLE` 为空时去 notiops-config 读 finalizer 写的 READY 记录。
      //
      // 为什么方式 B 也需要：`setup.sh` 第一次跑的时候 CUR 刚建好、还在 ~24h 的首次交付
      // 等待期，那时**根本没有表名可传**。没有这条回落，客户必须在一天后重跑一次
      // setup.sh 才能真正用上 CUR —— 而"过一天记得回来再跑一次"在实践中等于不会跑，
      // 于是成本主题一直停在 Cost Explorer，客户以为 CUR 没生效是产品问题。
      curProvisionedByNotiOps: true,
      configTableName: "notiops-config",
      curPartitionStyle: (this.node.tryGetContext("curPartitionStyle") as string) || undefined,
      curVersion: (this.node.tryGetContext("curVersion") as string) || undefined,
      curBucketName: (this.node.tryGetContext("curBucketName") as string) || undefined,
      curRoleArn: (this.node.tryGetContext("curRoleArn") as string) || undefined,
      curTagKeys: (this.node.tryGetContext("curTagKeys") as string) || undefined,
      costMcpBytesScannedCutoff: this.node.tryGetContext("costMcpBytesScannedCutoff")
        ? Number(this.node.tryGetContext("costMcpBytesScannedCutoff"))
        : undefined,
    };
  }
}
