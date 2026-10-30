/**
 * 定时任务（routines）在两条部署路径上的基础设施是同一套（2026-10-30）。
 *
 *   · tick 规则：rate(5 minutes) → BFF，事件体 {source:"notiops.routines.tick"}（BFF 在鉴权前按它分流）；
 *     方式 A 不给物理名（同账号里可能已有 setup.sh 部署的同名规则，撞名整栈回滚）；
 *   · 报告：routine-reports/ 前缀 30 天生命周期 —— 必须在 reports/（7 天）之外，生命周期规则没有排除；
 *     ReportsPathGuard 放行 /routine-reports/（别的前缀照样 403）；
 *   · BFF：s3:PutObject routine-reports/*、aidevops:GetAsset（核 Skill 是否真的已发布）。
 *
 * 方式 B 的 WebChatStack 读 golden fixture（web-chat-golden.test.ts 钉着它与真合成一致），数据桶在 NotiOpsBackendStack。
 */
import * as fs from "fs";
import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NotiOpsBackendStack } from "../lib/notiops-backend-stack";
import { NotiOpsWebChatStandaloneStack } from "../lib/notiops-webchat-standalone-stack";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const oneClick: Json = (() => {
  const app = new cdk.App();
  const stack = new NotiOpsWebChatStandaloneStack(app, "RoutinesOneClick", {
    synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
  });
  return Template.fromStack(stack).toJSON();
})();
const webChatB: Json = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "web-chat-stack.golden.json"), "utf8"));
const backendB: Json = (() => {
  // 关掉资产暂存：只看桶与 CloudFront Function，不需要把每个 Lambda 的代码目录拷进 cdk.out（/tmp 的 inode）。
  const app = new cdk.App({ context: { "aws:cdk:disable-asset-staging": true } });
  const stack = new NotiOpsBackendStack(app, "RoutinesBackend", { env: { account: "111122223333", region: "us-east-1" } });
  return Template.fromStack(stack).toJSON();
})();

const ofType = (t: Json, type: string) => Object.entries<Json>(t.Resources).filter(([, r]) => r.Type === type);
const str = (x: Json) => JSON.stringify(x);

function tickRule(t: Json) {
  const rules = ofType(t, "AWS::Events::Rule").filter(([, r]) => str(r.Properties.Targets || []).includes("notiops.routines.tick"));
  expect(rules).toHaveLength(1);
  return rules[0][1].Properties;
}
function bffFunctionLogicalId(t: Json) {
  const fns = ofType(t, "AWS::Lambda::Function").filter(([id]) => /WebChatBff[0-9A-F]{8}$/.test(id));
  expect(fns).toHaveLength(1);
  return fns[0][0];
}
function dataBucketRules(t: Json) {
  const b = ofType(t, "AWS::S3::Bucket").filter(([id]) => id.startsWith("DataBucket"));
  expect(b).toHaveLength(1);
  return b[0][1].Properties.LifecycleConfiguration.Rules;
}
function guardCode(t: Json) {
  const f = ofType(t, "AWS::CloudFront::Function").filter(([id]) => id.startsWith("ReportsPathGuard"));
  expect(f).toHaveLength(1);
  return f[0][1].Properties.FunctionCode;
}
function bffActions(t: Json) {
  const out: Array<{ a: string; r: string }> = [];
  // 溢出的语句在 OverflowPolicyN 里：方式 A 是 AWS::IAM::ManagedPolicy，两种都要看。
  for (const [, p] of [...ofType(t, "AWS::IAM::Policy"), ...ofType(t, "AWS::IAM::ManagedPolicy")]) {
    if (!str(p.Properties.Roles || []).includes("WebChatBffServiceRole")) continue;
    for (const st of [].concat(p.Properties.PolicyDocument.Statement)) {
      const s: Json = st;
      for (const a of [].concat(s.Action)) out.push({ a, r: str(s.Resource) });
    }
  }
  return out;
}

describe.each([["one-click (A)", oneClick], ["setup.sh WebChatStack (B)", webChatB]])("tick rule — %s", (_name, t) => {
  it("rate(5 minutes) → the BFF, with the fixed source the BFF routes on before auth", () => {
    const p = tickRule(t);
    expect(p.ScheduleExpression).toBe("rate(5 minutes)");
    expect(p.State ?? "ENABLED").toBe("ENABLED");
    expect(p.Targets).toHaveLength(1);
    expect(JSON.parse(p.Targets[0].Input)).toEqual({ source: "notiops.routines.tick" });
    expect(str(p.Targets[0].Arn)).toContain(bffFunctionLogicalId(t));
  });
  it("EventBridge may invoke the BFF", () => {
    const perms = ofType(t, "AWS::Lambda::Permission").filter(([, r]) =>
      r.Properties.Principal === "events.amazonaws.com" && str(r.Properties.SourceArn).includes("RoutinesTick"));
    expect(perms.length).toBeGreaterThanOrEqual(1);
  });
  it("the BFF can write routine reports and check published skills", () => {
    const acts = bffActions(t);
    expect(acts.some((x) => x.a === "s3:PutObject" && x.r.includes("routine-reports/*"))).toBe(true);
    expect(acts.some((x) => x.a === "aidevops:GetAsset")).toBe(true);
  });
});

it("one-click rule has no physical name; setup.sh rule is notiops-routines-tick", () => {
  expect(tickRule(oneClick).Name).toBeUndefined();
  expect(tickRule(webChatB).Name).toBe("notiops-routines-tick");
});

describe.each([["one-click (A)", oneClick], ["setup.sh NotiOpsBackendStack (B)", backendB]])("data bucket + CDN — %s", (_name, t) => {
  it("routine-reports/ expires after 30 days; reports/ still after 7", () => {
    const rules = dataBucketRules(t);
    const byId = Object.fromEntries(rules.map((r: Json) => [r.Id, r]));
    expect(byId["expire-routine-reports-30d"]).toMatchObject({ Prefix: "routine-reports/", ExpirationInDays: 30, Status: "Enabled" });
    expect(byId["expire-reports-7d"]).toMatchObject({ Prefix: "reports/", ExpirationInDays: 7 });
  });
  it("ReportsPathGuard lets /reports/ and /routine-reports/ through and nothing else", () => {
    const code = guardCode(t);
    // eslint-disable-next-line no-new-func
    const handler = new Function(`${code}; return handler;`)();
    const req = (uri: string) => handler({ request: { uri } });
    expect(req("/reports/investigation/x.html")).toEqual({ uri: "/reports/investigation/x.html" });
    expect(req("/routine-reports/rt-1/x.html")).toEqual({ uri: "/routine-reports/rt-1/x.html" });
    for (const u of ["/skills/a/meta.json", "/onboarding/x", "/cur-dash-cache/x", "/routine-reportsX/y", "/"]) {
      expect(req(u).statusCode).toBe(403);
    }
  });
});

it("the two guard functions are byte-identical", () => {
  expect(guardCode(oneClick)).toBe(guardCode(backendB));
});
