/**
 * 一键部署（方式 A）删栈收尾：`StagerSite` 交给 stager 处理的**每一个**对象，stager 角色都要有
 * 处理它的权限 —— 而且这份权限在删栈时必须还活着。
 *
 * 为什么值得一组独立断言（2026-10-10 一次真实删栈，v1.0.30）：Athena 查询结果桶
 * `CostMcpResults` 被接进了 stager 的清空列表（`CostResultsBucket`），却没给 stager 角色授权。
 * 部署时一切正常；**客户删环境那一刻**才在 `ListObjectVersions` 上 AccessDenied →
 * `StagerSite` DELETE_FAILED → 94 个资源里 52 个留在账号里继续计费。「加一个要清的对象」
 * 和「给 stager 授权」写在同一个文件相隔几百行的两处，漏一处不报任何错，反馈要等到删栈。
 *
 * 判据读**合成出来的模板**，不 grep TS 源码：坏的正是「源码 → IAM」这一步（条件化的桶、
 * Fn::If、CDK 生成的 DefaultPolicy），源码里看着对不等于模板里对。
 *
 * 只认两类策略里的语句（另一半约束）：
 *   · 不带 `Condition` —— 带条件的策略在条件为假时不存在；
 *   · 在 `StagerFn` 的 `DependsOn` 里 —— 删栈时 CFN 先删 StagerSite（跑收尾）、再删 StagerFn、
 *     最后删它依赖的策略，所以只有这些策略保证「stager 干活时权限还在」。独立的、没人依赖的
 *     策略可能在收尾之前就被 CFN 删掉。
 */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { NotiOpsWebChatStandaloneStack } from "../lib/notiops-webchat-standalone-stack";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

function synth(): Json {
  const app = new cdk.App();
  const stack = new NotiOpsWebChatStandaloneStack(app, "NotiOps", {
    synthesizer: new cdk.DefaultStackSynthesizer({ generateBootstrapVersionRule: false }),
  });
  return Template.fromStack(stack).toJSON();
}

const T = synth();
const R: Record<string, Json> = T.Resources;
const logicalIdOfType = (type: string) => Object.keys(R).filter((k) => R[k].Type === type);

/** 一个值里引用到的全部逻辑 ID（Ref / GetAtt），Fn::If 两支都走。 */
function refsIn(v: Json, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => refsIn(x, out));
  else if (v && typeof v === "object") {
    if (typeof v.Ref === "string") out.push(v.Ref);
    if (Array.isArray(v["Fn::GetAtt"])) out.push(v["Fn::GetAtt"][0]);
    Object.values(v).forEach((x) => refsIn(x, out));
  }
  return out;
}

/** 条件为真时这个 Resource 元素是什么：Fn::If 取真支（对象只在条件为真时存在）。 */
function whenPresent(v: Json): Json {
  if (v && typeof v === "object" && Array.isArray(v["Fn::If"])) return whenPresent(v["Fn::If"][1]);
  return v;
}

/** `GetAtt X.Arn` → { id: X, objects: false }；`Join(GetAtt X.Arn, "/*")` → { id: X, objects: true }。 */
function arnShape(v: Json): { id: string; objects: boolean } | null {
  const e = whenPresent(v);
  if (e?.["Fn::GetAtt"]?.[1] === "Arn") return { id: e["Fn::GetAtt"][0], objects: false };
  const parts = e?.["Fn::Join"]?.[1];
  if (Array.isArray(parts) && parts.length === 2 && parts[0]?.["Fn::GetAtt"]?.[1] === "Arn" && parts[1] === "/*") {
    return { id: parts[0]["Fn::GetAtt"][0], objects: true };
  }
  return null;
}

const matches = (granted: string, wanted: string) =>
  new RegExp("^" + granted.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(wanted);
const asList = (x: Json) => (Array.isArray(x) ? x : [x]);

const stagerRole = logicalIdOfType("AWS::IAM::Role").find((k) => k.startsWith("StagerRole"))!;
const stagerFn = R.StagerFn;
const dependsOn: string[] = asList(stagerFn?.DependsOn ?? []);

/** 删栈时一定还在的 stager 语句。 */
const liveStatements: Json[] = logicalIdOfType("AWS::IAM::Policy")
  .filter((k) => refsIn(R[k].Properties.Roles).includes(stagerRole))
  .filter((k) => !R[k].Condition && dependsOn.includes(k))
  .flatMap((k) => R[k].Properties.PolicyDocument.Statement)
  .filter((st: Json) => st.Effect === "Allow");

function granted(action: string, isTarget: (resource: Json) => boolean): boolean {
  return liveStatements.some((st) =>
    asList(st.Action).some((a: string) => matches(a, action))
    && asList(st.Resource).some((r: Json) => isTarget(r)));
}

const site = R.StagerSite.Properties;
const bucketsOf = (v: Json) => [...new Set(refsIn(v))].filter((id) => R[id]?.Type === "AWS::S3::Bucket");

describe("one-click teardown: every object StagerSite hands to the stager is actually deletable by it", () => {
  it("sanity: the template still has the shape this test reads", () => {
    expect(stagerRole).toBeDefined();
    expect(stagerFn).toBeDefined();
    expect(liveStatements.length).toBeGreaterThan(0);
    expect(site.Phase).toBe("Site");
  });

  // `_teardown_site` 用 list_object_versions + delete_objects(带 VersionId) 清桶。
  // 数据桶不在这里：它归 DataCleanup（见下一组）。
  const EMPTIED = ["SiteBucket", "StagingBucket", "CostResultsBucket"];
  for (const prop of EMPTIED) {
    it(`${prop}: stager can list versions and delete object versions`, () => {
      const ids = bucketsOf(site[prop]);
      expect(ids.length).toBe(1);
      const [id] = ids;
      expect(granted("s3:ListBucketVersions", (r) => arnShape(r)?.id === id && !arnShape(r)!.objects))
        .toBe(true);
      expect(granted("s3:DeleteObjectVersion", (r) => arnShape(r)?.id === id && arnShape(r)!.objects))
        .toBe(true);
    });
  }

  it("TableNames: stager can delete every listed table", () => {
    const ids = [...new Set(refsIn(site.TableNames))];
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(R[id].Type).toBe("AWS::DynamoDB::Table");
      expect(granted("dynamodb:DeleteTable", (r) => arnShape(r)?.id === id)).toBe(true);
    }
  });

  it("SecretNames: stager can delete every listed secret by exact name", () => {
    // 全是字面量时 toJsonString 合成成一个普通字符串；变成对象（混进了 token）就读不出名字，直接红。
    const names: string[] = typeof site.SecretNames === "string" ? JSON.parse(site.SecretNames) : [];
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(granted("secretsmanager:DeleteSecret", (r) =>
        JSON.stringify(r).includes(`:secret:${n}-*`))).toBe(true);
    }
  });

  it("LogGroupNames: every listed log group falls under a granted logs:DeleteLogGroup prefix", () => {
    const literal = JSON.stringify(site.LogGroupNames);
    expect(literal).toContain("/aws/bedrock-agentcore/runtimes/");
    expect(granted("logs:DeleteLogGroup", (r) =>
      JSON.stringify(r).includes("log-group:/aws/bedrock-agentcore/runtimes/*"))).toBe(true);
  });

  it("the grants for conditional buckets never leave an empty Resource list", () => {
    // 不装成本 MCP 时 Fn::If 落成 NoValue；一条只剩 NoValue 的语句是空 Resource，整条策略无效。
    // （另一种合法写法是假支给一个不存在的占位 ARN，如 StagerReadArtifactMirror —— 那不会变空。）
    const mayVanish = (r: Json) => Array.isArray(r?.["Fn::If"])
      && r["Fn::If"].slice(1).some((b: Json) => b?.Ref === "AWS::NoValue");
    for (const st of liveStatements) {
      const allMayVanish = asList(st.Resource).every(mayVanish);
      expect(`${st.Sid}: ${allMayVanish ? "every Resource can collapse to NoValue" : "ok"}`).toBe(`${st.Sid}: ok`);
    }
  });
});

describe("one-click teardown: the data bucket goes only after the reports CDN that serves it", () => {
  // 2026-10-25（发 v1.0.33 前）：数据桶原来由 StagerSite 的 Delete 删，而 StagerSite 经 AgentRuntime
  // （环境变量带 REPORTS_CDN_DOMAIN）间接依赖 ReportsCDN ⇒ 删栈时桶先没，分发还要再删 6 分钟左右，这段时间
  // 它指向一个不存在、名字可预测的桶（全局命名空间，可被抢注）。验证账号两次 RC 删栈都被内部的 dangling
  // CloudFront 检测抓到。CFN 的删除顺序 = 依赖的反向 ⇒ 让分发依赖删桶的那个资源，分发就先删完。
  const dc = R.DataCleanup;
  const dataBucketId = logicalIdOfType("AWS::S3::Bucket").find((k) => R[k].DeletionPolicy === "Retain"
    && JSON.stringify(R[k].Properties?.BucketName ?? "").includes("notiops-data-"))!;
  const servedBy = logicalIdOfType("AWS::CloudFront::Distribution").filter((k) =>
    (R[k].Properties.DistributionConfig.Origins as Json[]).some((o) => refsIn(o.DomainName).includes(dataBucketId)));

  it("sanity: the data bucket and the distribution serving it are found", () => {
    expect(dataBucketId).toBeDefined();
    expect(servedBy.length).toBe(1);
  });

  it("StagerSite no longer hands the data bucket to the stager", () => {
    expect(site.DataBucket).toBeUndefined();
    expect(bucketsOf(site)).not.toContain(dataBucketId);
  });

  it("DataCleanup is a stager custom resource for exactly the data bucket, driven by TeardownMode", () => {
    expect(dc?.Type).toBe("Custom::NotiOpsDataCleanup");
    expect(dc.Properties.Phase).toBe("DataCleanup");
    expect(dc.Properties.ServiceToken).toEqual(R.StagerSite.Properties.ServiceToken);
    expect(dc.Properties.TeardownMode).toEqual(site.TeardownMode);
    expect(bucketsOf(dc.Properties.DataBucket)).toEqual([dataBucketId]);
    expect(dc.Condition).toBeUndefined();
  });

  it("every distribution whose origin is the data bucket DependsOn DataCleanup (deleted before the bucket is)", () => {
    for (const k of servedBy) expect(asList(R[k].DependsOn ?? [])).toContain("DataCleanup");
  });

  it("DataCleanup does not itself (transitively) depend on such a distribution — that would be a cycle CFN rejects", () => {
    // 这正是数据桶不能留在 StagerSite 上的原因（StagerSite 经 AgentRuntime 依赖 ReportsCDN）。环在合成时不报，
    // 要到 CFN 校验模板时才炸，所以在这里算一遍：Ref / GetAtt / Fn::Sub 里的 ${X} / DependsOn。
    const direct = (id: string): string[] => {
      const r = R[id];
      const subs = JSON.stringify(r.Properties ?? {}).match(/\$\{([A-Za-z0-9]+)(\.[A-Za-z0-9.]+)?\}/g) ?? [];
      return [...refsIn(r.Properties ?? {}), ...asList(r.DependsOn ?? []),
              ...subs.map((m) => m.slice(2, -1).split(".")[0])].filter((x) => x in R);
    };
    const seen = new Set<string>();
    const stack = ["DataCleanup"];
    while (stack.length) {
      const id = stack.pop()!;
      for (const d of direct(id)) if (!seen.has(d)) { seen.add(d); stack.push(d); }
    }
    expect(servedBy.filter((k) => seen.has(k))).toEqual([]);
  });

  it("stager can empty and delete the data bucket (it is Retain, CFN will not)", () => {
    const id = dataBucketId;
    expect(granted("s3:ListBucketVersions", (r) => arnShape(r)?.id === id && !arnShape(r)!.objects)).toBe(true);
    expect(granted("s3:DeleteObjectVersion", (r) => arnShape(r)?.id === id && arnShape(r)!.objects)).toBe(true);
    expect(granted("s3:DeleteBucket", (r) => arnShape(r)?.id === id && !arnShape(r)!.objects)).toBe(true);
  });

  it("StagerFn waits for no CloudFront distribution (else ReportsCDN, via DataCleanup, is created only after the chat CDN)", () => {
    // CFN 让依赖方等被依赖方（连同它的传递依赖）完全建好。DefaultPolicy 里曾有一条引用聊天 CDN 的 CreateInvalidation
    // ⇒ StagerFn 等聊天 CDN 建完 ⇒ ReportsCDN 也只能在那之后才开始建：v1.0.33-rc2 实测建栈 393s → 664s。
    const seen = new Set<string>();
    const stack = ["StagerFn"];
    while (stack.length) {
      const id = stack.pop()!;
      const r = R[id];
      for (const d of [...refsIn(r.Properties ?? {}), ...asList(r.DependsOn ?? [])].filter((x) => x in R)) {
        if (!seen.has(d)) { seen.add(d); stack.push(d); }
      }
    }
    expect([...seen].filter((k) => R[k].Type === "AWS::CloudFront::Distribution")).toEqual([]);
  });

  it("stager can read its own stack's status (it deletes the bucket only while the whole stack is going away)", () => {
    expect(granted("cloudformation:DescribeStacks", (r) => r?.Ref === "AWS::StackId")).toBe(true);
  });
});

/** 只含字面量 + Ref 伪参数的 Fn::Join 渲染成字符串，用来比对「命名日志组」那种写法。 */
function render(v: Json): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof v.Ref === "string") return "${" + v.Ref + "}";
  if (v && typeof v === "object" && Array.isArray(v["Fn::Join"])) {
    const [sep, parts] = v["Fn::Join"];
    return (parts as Json[]).map(render).join(sep);
  }
  return JSON.stringify(v);
}

describe("one-click teardown: every Lambda function writes to a log group the stack owns", () => {
  // 不归栈管的日志组 = Lambda 首次调用时自建的 /aws/lambda/<名字>：删栈不删、默认永不过期。
  // 2026-10-10 一次干净的删栈之后，v1.0.30 新加的三个函数（成本 MCP、CUR 阶段一 / 阶段二）的
  // 日志组就这样留在了账号里 —— 其余 12 个函数早就按这个约定写了，新加的漏了。
  const namedLogGroups = new Map(
    logicalIdOfType("AWS::Logs::LogGroup")
      .filter((k) => R[k].Properties?.LogGroupName)
      .map((k) => [render(R[k].Properties.LogGroupName), k] as const));

  for (const fnId of logicalIdOfType("AWS::Lambda::Function")) {
    it(`${fnId}: has a stack-owned log group (retention set, deleted with the stack, same condition)`, () => {
      const fn = R[fnId];
      const viaConfig = fn.Properties?.LoggingConfig?.LogGroup?.Ref;
      const viaName = fn.Properties?.FunctionName
        ? namedLogGroups.get("/aws/lambda/" + render(fn.Properties.FunctionName)) : undefined;
      const lgId = viaConfig ?? viaName;
      expect(`${fnId} -> ${lgId ?? "Lambda auto-created log group (not stack-owned)"}`).toBe(`${fnId} -> ${lgId}`);
      const lg = R[lgId!];
      expect(lg.Type).toBe("AWS::Logs::LogGroup");
      expect(lg.DeletionPolicy ?? "Delete").toBe("Delete");
      expect(lg.Properties.RetentionInDays).toBeGreaterThan(0);
      // 函数带条件而日志组不带：不选装时多出一个空日志组；反过来则函数引用一个不存在的组 → 部署失败。
      expect(lg.Condition ?? "-").toBe(fn.Condition ?? "-");
    });
  }
});

describe("one-click teardown: no function can re-create its own log group after the stack deletes it", () => {
  // 2026-10-10 v1.0.30 RC 真机往返：删栈时 CFN 调完 CurProvisionerFn 的 Delete、5 秒后删掉它的
  // 日志组，1 秒后日志组又出现了 —— Lambda 的日志是**异步投递**的，晚到的那几行借执行角色的
  // `logs:CreateLogGroup`（AWSLambdaBasicExecutionRole 带的，资源 `*`）把组重新建了出来：不归栈管、
  // 永不过期。StagerFn / WebNotifFn 从一开始就只有「往自己那个组写」的权限，所以从没留下过。
  //
  // KNOWN_DEBT：这几个函数有同样的暴露，但 ① 都不是 custom resource 的 handler —— CFN 删栈时不调
  // 它们，只有 keep-alive / 预热恰好落在删组前几秒才会留下（RC 那次一个都没留）；② 定义它们的
  // construct 与方式 B（现网）共用，改 IAM 不该在发版当天做，作为已知技术债单独跟踪。
  // 这份名单**只许缩短**：最后一条断言保证名单里每一项都还真有这条权限 —— 修好一个就必须删掉它。
  const KNOWN_DEBT = ["WebChatBff", "FeishuWorker", "FeishuIngress", "SlackWorker", "SlackIngress",
                      "DingtalkWorker", "DingtalkIngress", "ImProgress", "DevOpsCallbackFn"];
  const isDebt = (id: string) => KNOWN_DEBT.some((p) => id.startsWith(p));

  const roleOf = (fnId: string): string => R[fnId].Properties.Role["Fn::GetAtt"][0];
  const statementsOf = (roleId: string): Json[] => logicalIdOfType("AWS::IAM::Policy")
    .filter((pid) => refsIn(R[pid].Properties.Roles).includes(roleId))
    .flatMap((pid) => ([] as Json[]).concat(R[pid].Properties.PolicyDocument.Statement).map(whenPresent))
    .filter((st) => st && st.Effect === "Allow");
  const actionsOf = (st: Json): string[] => ([] as string[]).concat(st.Action);

  /** 角色能不能建日志组：托管策略 BasicExecutionRole，或任一挂在它上面的策略放行了 CreateLogGroup。 */
  function createLogGroupVia(roleId: string): string | null {
    const managed = (R[roleId].Properties?.ManagedPolicyArns ?? []) as Json[];
    if (managed.some((m) => /AWSLambdaBasicExecutionRole/.test(JSON.stringify(m)))) return "AWSLambdaBasicExecutionRole";
    const st = statementsOf(roleId).find((s) => actionsOf(s).some((a) => ["logs:CreateLogGroup", "logs:*", "*"].includes(a)));
    return st ? `statement ${st.Sid ?? "(no sid)"}` : null;
  }

  const fns = logicalIdOfType("AWS::Lambda::Function");

  for (const fnId of fns.filter((id) => !isDebt(id))) {
    it(`${fnId}: its role cannot create log groups (late log delivery would re-create a deleted one)`, () => {
      expect(`${fnId} -> ${createLogGroupVia(roleOf(fnId)) ?? "no CreateLogGroup"}`).toBe(`${fnId} -> no CreateLogGroup`);
    });
  }

  for (const fnId of fns.filter((id) => !isDebt(id) && R[id].Properties?.LoggingConfig?.LogGroup?.Ref)) {
    it(`${fnId}: can still write to its own stack-owned log group`, () => {
      const lgId = R[fnId].Properties.LoggingConfig.LogGroup.Ref;
      const writes = statementsOf(roleOf(fnId)).some((st) =>
        ["logs:CreateLogStream", "logs:PutLogEvents"].every((a) => actionsOf(st).includes(a))
        && refsIn(st.Resource).includes(lgId));
      expect(`${fnId} -> ${writes ? "writes to " + lgId : "cannot write to " + lgId}`).toBe(`${fnId} -> writes to ${lgId}`);
    });
  }

  it("KNOWN_DEBT only lists functions that exist and still carry CreateLogGroup (the list may only shrink)", () => {
    const stale = KNOWN_DEBT.filter((p) => {
      const hits = fns.filter((id) => id.startsWith(p));
      return hits.length === 0 || hits.every((id) => createLogGroupVia(roleOf(id)) === null);
    });
    expect(stale).toEqual([]);
  });
});
