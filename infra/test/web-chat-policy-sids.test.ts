/**
 * 同一份 IAM 策略里 Sid 不许重复（待办 #38 ⑧，2026-10-23）。
 *
 * web-chat-core.ts 里 BFF 角色的 org 一键接入（OrgOnboardStackSets / OrgOnboardListAccounts）、
 * SecOpsDashboardsReadOnly、sts:AssumeRole、AgentCore Runtime 这一组语句曾经**逐字写了两遍**。
 * 部署出去一直只有一份 —— CDK 合成时把完全相同的语句去重了 —— 所以模板、现网都看不出来。
 * 真正的风险在下一次改动：只改一处，两份内容就不再相同，CDK 不再去重，同一个 Sid 在同一份策略里
 * 出现两次，IAM 拒收整份策略（MalformedPolicyDocument），整栈更新回滚。
 *
 * 两层判据：
 *   1. 源码：web-chat-core.ts 里每个 `sid: "…"` 字面量只出现一次（挡住「抄一份语句块」本身）；
 *   2. 模板：WebChatStack（单账号 / 组织模式）与一键部署单栈里，每一份策略文档的 Sid 都不重复
 *      （挡住两处语句内容已经不同、CDK 去重失效的情况）。
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as fs from "fs";
import * as path from "path";
import { WebChatStack } from "../lib/web-chat-stack";
import { NotiOpsWebChatStandaloneStack } from "../lib/notiops-webchat-standalone-stack";

interface Statement { Sid?: string }
interface PolicyDoc { Statement?: Statement[] }

function documents(template: { Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }> }): Array<{ where: string; doc: PolicyDoc }> {
  const out: Array<{ where: string; doc: PolicyDoc }> = [];
  for (const [id, r] of Object.entries(template.Resources ?? {})) {
    const p = r.Properties ?? {};
    if (r.Type === "AWS::IAM::Policy" || r.Type === "AWS::IAM::ManagedPolicy") {
      out.push({ where: id, doc: p.PolicyDocument as PolicyDoc });
    } else if (r.Type === "AWS::IAM::Role") {
      for (const inline of (p.Policies as Array<{ PolicyName: string; PolicyDocument: PolicyDoc }> | undefined) ?? []) {
        out.push({ where: `${id}/${inline.PolicyName}`, doc: inline.PolicyDocument });
      }
    }
  }
  return out;
}

function duplicateSids(template: Parameters<typeof documents>[0]): string[] {
  const bad: string[] = [];
  for (const { where, doc } of documents(template)) {
    const seen = new Map<string, number>();
    for (const st of doc?.Statement ?? []) if (st.Sid) seen.set(st.Sid, (seen.get(st.Sid) ?? 0) + 1);
    for (const [sid, n] of seen) if (n > 1) bad.push(`${where}: Sid ${sid} ×${n}`);
  }
  return bad;
}

function webChatTemplate(context: Record<string, string>) {
  const app = new cdk.App({
    context: {
      enabledPlatforms: "none",
      agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:444455556666:runtime/NotiOpsWebChat-fixture",
      ...context,
    },
  });
  const stack = new WebChatStack(app, "WebChatStack", {
    env: { account: "444455556666", region: "us-east-1" },
    userPoolId: "us-east-1_FIXTUREPOOL",
    userPoolClientId: "fixtureuserpoolclientid00",
    skillsBucketName: "notiops-data-444455556666-us-east-1",
    agentSpaceId: "fixture-agent-space",
    reportsCdnDomain: "reports.example.invalid",
  });
  return Template.fromStack(stack).toJSON();
}

describe("同一份 IAM 策略里 Sid 不许重复", () => {
  test("源码：web-chat-core.ts 里每个 sid 字面量只出现一次", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "lib", "constructs", "web-chat-core.ts"), "utf-8");
    const counts = new Map<string, number>();
    for (const m of src.matchAll(/\bsid:\s*"([^"]+)"/g)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    expect(counts.size).toBeGreaterThan(10);   // 正则没失效
    expect([...counts].filter(([, n]) => n > 1)).toEqual([]);
  });

  test("WebChatStack（单账号）", () => {
    expect(duplicateSids(webChatTemplate({}))).toEqual([]);
  });

  test("WebChatStack（组织模式：OrgOnboard* 两条在）", () => {
    const t = webChatTemplate({ organizationId: "o-exampleorg01" });
    expect(JSON.stringify(t)).toContain("OrgOnboardStackSets");
    expect(duplicateSids(t)).toEqual([]);
  });

  test("一键部署单栈", () => {
    const app = new cdk.App();
    const stack = new NotiOpsWebChatStandaloneStack(app, "NotiOps", {
      synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
    });
    expect(duplicateSids(Template.fromStack(stack).toJSON())).toEqual([]);
  });
});
