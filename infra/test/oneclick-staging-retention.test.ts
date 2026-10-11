/**
 * 一键模板的 staging 桶**不许**给产物设过期 —— 2026-10-11 v1.0.30-rc2 在验证账号实测出来的。
 *
 * 原来桶上有一条 `expire-staged-artifacts-7d`，理由是「Lambda 与 AgentCore 都在创建 / 更新时把代码复制走」。
 * 对 AgentCore 不成立：`AWS::BedrockAgentCore::Runtime` 的任何更新（哪怕只改环境变量）都会让服务按
 * `Code.S3` 重读一次包。而只改 `EnableDeepInvestigation` / `DeployMode` / `CostAgentMcpUrl` 的 update 不会让
 * `StagerArtifacts` 重搬 ⇒ 距上次搬运超过 7 天时：
 *   Runtime UPDATE_FAILED「S3 object not found in bucket」→ 回滚又要读同一个包 → 栈卡在 UPDATE_ROLLBACK_FAILED。
 * RC2 清空 staging 桶模拟过期、只改 EnableDeepInvestigation，结果与上面一字不差。
 *
 * 这里钉三件事：桶上没有任何过期动作；Runtime 的代码确实来自这个桶（所以第一条才要紧）；
 * 以及 Runtime 依赖 StagerArtifacts（换版本时先搬再更新，桶里旧版本的包回滚时还在）。
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NotiOpsWebChatStandaloneStack } from "../lib/notiops-webchat-standalone-stack";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const app = new cdk.App();
const stack = new NotiOpsWebChatStandaloneStack(app, "NotiOps", {
  synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
});
const T: Json = Template.fromStack(stack).toJSON();
const R: Record<string, Json> = T.Resources;

const stagingId = Object.keys(R).find(
  (k) => R[k].Type === "AWS::S3::Bucket" && k.startsWith("StagingBucket"),
) as string;

describe("one-click staging bucket keeps its artifacts", () => {
  it("has a staging bucket", () => {
    expect(stagingId).toBeDefined();
  });

  it("never expires staged artifacts (an AgentCore Runtime update re-reads its package)", () => {
    const rules: Json[] = R[stagingId].Properties?.LifecycleConfiguration?.Rules ?? [];
    const expiring = rules.filter((r) =>
      r.ExpirationInDays !== undefined || r.ExpirationDate !== undefined ||
      r.NoncurrentVersionExpiration !== undefined || r.NoncurrentVersionExpirationInDays !== undefined);
    expect(expiring).toEqual([]);
  });

  it("the Runtime's code really comes from the staging bucket", () => {
    const rt = R.AgentRuntime;
    expect(rt?.Type).toBe("AWS::BedrockAgentCore::Runtime");
    const s3 = rt.Properties.AgentRuntimeArtifact.CodeConfiguration.Code.S3;
    expect(s3.Bucket).toEqual({ Ref: stagingId });
  });

  it("the Runtime is updated only after StagerArtifacts has staged the release", () => {
    const deps: string[] = [].concat(R.AgentRuntime.DependsOn ?? []);
    expect(deps).toContain("StagerArtifacts");
  });
});
