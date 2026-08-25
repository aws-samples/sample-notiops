/**
 * WebChatStack 模板 golden 测试 —— 「抽 Construct 不许动现网资源」。
 *
 * 为什么需要它：一键部署（Launch Stack）要让 standalone 单栈与现有 WebChatStack
 * 共用同一份资源定义。抽取时**最危险的做法
 * 是抽成 Construct 子类** —— `new WebChatCore(this, "Core")` 会在每个构件路径里
 * 插一层 id，于是所有逻辑 ID 全变，CloudFormation 对在服务的栈做 delete + recreate
 * （DDB 表虽然 RETAIN，但 Function URL / CloudFront 域名 / Identity Pool 全部换新，
 * 等于一次事故）。所以 lib/constructs/web-chat-core.ts 导出的是**函数**。
 *
 * 本测试把 WebChatStack 的合成模板与 fixtures/ 下的 golden 对比，任何
 * 逻辑 ID / 资源属性的漂移都会红。归一化只做两件事（见 normalize）：
 *   · 资产哈希（`<64hex>.zip`）—— 随 BFF 代码 / 前端 dist / aws-cdk-lib 版本变化
 *   · `ChatConfig.timestamp` —— 源码里是 `Date.now()`（web-chat-core.ts 的已知坑，
 *     §6.2 会改成 ReleaseTag；在那之前它每次 synth 都不同）
 *
 * 更新 golden（**仅在确实有意改动资源时**）：
 *     cd infra && UPDATE_GOLDEN=1 npx jest test/web-chat-golden.test.ts
 * 提交时必须在 MR 里说明模板差异是预期的哪一处改动。
 *
 * fixture 里的账号是 **111122223333**（RFC 5737 风格的示例账号），不是真账号 ——
 * `publish/include.txt` 把整个 `infra/` 目录列入公开发布白名单，这个 fixture 会
 * 原样进 aws-samples 的公开仓。
 *
 * ⚠️ 前置条件：`frontend/chat-app/dist` 必须存在（不必是真构建产物）。web-chat-core.ts:701
 * 会按它在不在切换两种 `BucketDeployment` 源 —— 存在走 `Source.asset`，不存在退化成
 * `Source.data` 占位页，**模板结构不同**（后者多一个 `SourceMarkers`）。golden 钉的是
 * setup.sh 实际部署出来的那一种（asset），所以 dist 缺失时本测试直接抛错说明原因，
 * 而不是丢一份几千行的 diff。CI 里由 job 造一个占位 dist（内容无关：资产哈希被归一化）。
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as path from "path";
import { WebChatStack } from "../lib/web-chat-stack";

const FIXTURE = path.join(__dirname, "fixtures", "web-chat-stack.golden.json");

/** 与 bin/app.ts 保持一致的示例环境（固定值，保证可复现）。 */
const FIXTURE_ACCOUNT = "111122223333";
const FIXTURE_REGION = "us-east-1";

const ASSET_HASH = /^[0-9a-f]{64}(\.zip)?$/;

/** 递归归一化：排序对象键（让 diff 稳定）+ 抹掉资产哈希。 */
function normalize(node: unknown): unknown {
  if (typeof node === "string") return ASSET_HASH.test(node) ? "<ASSET>" : node;
  if (Array.isArray(node)) return node.map(normalize);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>).sort()) {
      out[key] = normalize((node as Record<string, unknown>)[key]);
    }
    return out;
  }
  return node;
}

/** 见文件头「前置条件」：dist 在不在会改变 BucketDeployment 的模板结构。 */
function requireFrontendDist(): void {
  const dist = path.join(__dirname, "..", "..", "frontend", "chat-app", "dist");
  if (fs.existsSync(dist)) return;
  throw new Error(
    `golden 测试要求 ${path.relative(process.cwd(), dist)} 存在（内容不限，哈希已归一化）。\n` +
      "本地：cd frontend/chat-app && npm run build；\n" +
      "或造占位：mkdir -p frontend/chat-app/dist && echo x > frontend/chat-app/dist/index.html\n" +
      "原因：web-chat-core.ts 在 dist 缺失时改用 Source.data 占位页，模板结构与实际部署的不同。",
  );
}

function synthTemplate(): Record<string, unknown> {
  requireFrontendDist();
  const app = new cdk.App({
    context: {
      // cdk CLI 默认会打开它（`cdk synth` 的模板里每个资源都带
      // Metadata["aws:cdk:path"]）；进程内 synth 默认关闭，必须显式开 ——
      // 构件路径正是本测试要守的东西（多一层 Construct 就体现在这里）。
      "aws:cdk:enable-path-metadata": true,
      // 与 setup.sh 的 "暂不部署 IM" 组合一致；agentRuntimeArn 给固定假值。
      enabledPlatforms: "none",
      agentRuntimeArn: `arn:aws:bedrock-agentcore:${FIXTURE_REGION}:${FIXTURE_ACCOUNT}:runtime/NotiOpsWebChat-fixture`,
    },
  });
  // bin/app.ts 在 App 级打的强制标签 —— 会传播进模板，必须一起复现。
  cdk.Tags.of(app).add("auto-delete", "no");
  cdk.Tags.of(app).add("project", "notiops");

  const stack = new WebChatStack(app, "WebChatStack", {
    env: { account: FIXTURE_ACCOUNT, region: FIXTURE_REGION },
    description: "NotiOps Web Chat (agentic) — BFF streaming + chat-app frontend",
    // 真实部署时这些来自 NotiOpsBackendStack 的跨栈引用；fixture 用字面值，
    // 目的是把本测试与主栈解耦（主栈 synth 慢且有 40MB Layer 资产）。
    userPoolId: `${FIXTURE_REGION}_FIXTUREPOOL`,
    userPoolClientId: "fixtureuserpoolclientid00",
    skillsBucketName: `notiops-data-${FIXTURE_ACCOUNT}-${FIXTURE_REGION}`,
    agentSpaceId: "fixture-agent-space",
    idleConsoleUrl: "https://console.example.invalid",
    reportsCdnDomain: "reports.example.invalid",
  });

  const template = Template.fromStack(stack).toJSON() as Record<string, unknown>;
  // 源码里的 Date.now() 触发器（web-chat-core.ts）—— 每次 synth 都不同。
  const resources = template.Resources as Record<string, { Properties: Record<string, unknown> }>;
  resources.ChatConfig.Properties.timestamp = "<TIMESTAMP>";
  return normalize(template) as Record<string, unknown>;
}

describe("WebChatStack golden template", () => {
  const template = synthTemplate();

  it("与 fixture 逐字节一致（逻辑 ID 不许漂移）", () => {
    const serialized = JSON.stringify(template, null, 2) + "\n";
    if (process.env.UPDATE_GOLDEN === "1") {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, serialized);
      console.warn(`[golden] 已重写 ${path.relative(process.cwd(), FIXTURE)}`);
      return;
    }
    expect(fs.existsSync(FIXTURE)).toBe(true);
    expect(serialized).toEqual(fs.readFileSync(FIXTURE, "utf-8"));
  });

  it("没有多出中间构件层（抽成 Construct 会让所有逻辑 ID 重建）", () => {
    // 只要有人把 createWebChatCore 改回 `new WebChatCore(this, "Core")`，
    // 这里的 aws:cdk:path 会变成 WebChatStack/Core/WebChatTable/Resource。
    const resources = template.Resources as Record<string, { Metadata?: Record<string, string> }>;
    expect(resources.WebChatTable02103F86.Metadata?.["aws:cdk:path"]).toBe(
      "WebChatStack/WebChatTable/Resource",
    );
    expect(resources.WebChatBffF9213199.Metadata?.["aws:cdk:path"]).toBe(
      "WebChatStack/WebChatBff/Resource",
    );
  });

  it("会话表保持 Retain（删栈不带走客户会话数据）", () => {
    const resources = template.Resources as Record<string, Record<string, unknown>>;
    expect(resources.WebChatTable02103F86.DeletionPolicy).toBe("Retain");
    expect(resources.WebChatTable02103F86.UpdateReplacePolicy).toBe("Retain");
  });

  it("BFF Function URL 是 AWS_IAM + RESPONSE_STREAM（不得退回公开端点）", () => {
    const url = (template.Resources as Record<string, { Properties: Record<string, unknown> }>)
      .WebChatBffFunctionUrl88DBBB67.Properties;
    expect(url.AuthType).toBe("AWS_IAM");
    expect(url.InvokeMode).toBe("RESPONSE_STREAM");
  });

  it("模板里不出现真实账号 ID（fixture 会随 infra/ 一起公开发布）", () => {
    expect(JSON.stringify(template)).not.toMatch(/\b533734273591\b/);
  });
});
