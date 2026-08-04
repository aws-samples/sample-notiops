/**
 * 成员账号一键接入（Web Chat Admin「账户」页；与 idle 控制台 api/routes/org_onboard.py 同构）。
 *
 * 前提: org 模式部署（setup.sh --multi-account 且管理账号/委派管理员），CDK 注入
 *   MEMBER_ONBOARDING_STACKSET_NAME + ORGANIZATION_ID 并授权 StackSets/Organizations。
 * 非 org 模式下所有函数抛 org_mode_disabled（路由层转 400）。
 *
 * 流程:
 *   listMemberAccounts  → Organizations ListAccounts(ACTIVE) × config 表接入状态
 *   onboardAccount      → CreateStackInstances(根 OU + 单账号 INTERSECTION)
 *                         + config 表预登记(enabled=false, PROVISIONING)
 *   onboardStatus       → DescribeStackSetOperation 轮询;SUCCEEDED 翻正 enabled=true
 *
 * 与 shared/queries/accounts.py 的 DDB 布局保持一致:
 *   PK=account#<id> SK=meta, GSI1PK="accounts", GSI1SK=<id>
 */
import {
  CloudFormationClient, CreateStackInstancesCommand, DeleteStackInstancesCommand,
  DescribeStackSetOperationCommand,
} from "@aws-sdk/client-cloudformation";
import {
  OrganizationsClient, paginateListAccounts, ListRootsCommand,
} from "@aws-sdk/client-organizations";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { credsFor } from "./xacct.mjs";
import {
  DynamoDBDocumentClient, DeleteCommand, GetCommand, QueryCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const CONFIG_TABLE = process.env.CONFIG_TABLE || "notiops-config";
// 与 infra/member-account-onboarding.yaml 一致：RoleName 带管理账号后缀，
// 与目标账号内可能存在的独立 NotiOps 部署解耦共存。env 由 CDK 注入。
const MEMBER_ROLE_NAME = process.env.NOTIOPS_MEMBER_ROLE_NAME || "notiops-idle-detection-role";

const cf = new CloudFormationClient({});
const org = new OrganizationsClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

let _rootIdCache = "";

function stackSetName() {
  const n = (process.env.MEMBER_ONBOARDING_STACKSET_NAME || "").trim();
  if (!n) { const e = new Error("org_mode_disabled"); e.code = "org_mode_disabled"; throw e; }
  return n;
}

async function rootId() {
  if (_rootIdCache) return _rootIdCache;
  const r = await org.send(new ListRootsCommand({}));
  if (!r.Roots || !r.Roots.length) throw new Error("organizations_no_roots");
  _rootIdCache = r.Roots[0].Id;
  return _rootIdCache;
}

async function getConfigAccount(accountId) {
  const r = await ddb.send(new GetCommand({
    TableName: CONFIG_TABLE, Key: { PK: `account#${accountId}`, SK: "meta" },
  }));
  return r.Item || null;
}

/** UpdateItem SET（if_not_exists(created_at)），与 python put_account 语义一致。 */
async function putConfigAccount(accountId, fields) {
  const now = new Date().toISOString();
  const all = {
    ...fields, GSI1PK: "accounts", GSI1SK: accountId, account_id: accountId, updated_at: now,
  };
  const names = {}; const values = { ":ca": now }; const sets = [];
  let i = 0;
  for (const [k, v] of Object.entries(all)) {
    const nk = `#f${i}`; const nv = `:v${i}`;
    names[nk] = k; values[nv] = v; sets.push(`${nk} = ${nv}`); i++;
  }
  names["#ca"] = "created_at";
  sets.push("#ca = if_not_exists(#ca, :ca)");
  await ddb.send(new UpdateCommand({
    TableName: CONFIG_TABLE,
    Key: { PK: `account#${accountId}`, SK: "meta" },
    UpdateExpression: "SET " + sets.join(", "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

/** 组织内 ACTIVE 账号 × config 表接入状态。 */
export async function listMemberAccounts() {
  stackSetName(); // org 模式校验
  const onboarded = {};
  const q = await ddb.send(new QueryCommand({
    TableName: CONFIG_TABLE, IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk",
    ExpressionAttributeValues: { ":pk": "accounts" },
  }));
  for (const it of q.Items || []) onboarded[String(it.account_id)] = it;

  // 部署账号自身不属于"成员接入"范畴（数据天然可见，无 StackSet 实例可下线）——
  // 从列表排除，避免误 Offboard 部署账号的登记记录。
  const { STSClient: _S, GetCallerIdentityCommand: _G } = await import("@aws-sdk/client-sts");
  const selfId = (await new _S({}).send(new _G({}))).Account || "";
  const items = [];
  for await (const page of paginateListAccounts({ client: org }, {})) {
    for (const a of page.Accounts || []) {
      if (a.Status !== "ACTIVE") continue;
      if (a.Id === selfId) continue; // 部署账号排除
      const cfg = onboarded[a.Id];
      items.push({
        accountId: a.Id,
        name: a.Name || "",
        email: a.Email || "",
        onboarded: !!cfg,
        enabled: !!(cfg && cfg.enabled === true),
        orgOnboardStatus: (cfg && cfg.org_onboard_status) || "",
        regions: (cfg && cfg.regions) || [],
        devopsAgentStatus: "", // 第二步（DevOps Agent 关联）状态，下方补齐
      });
    }
  }
  // 第二步状态：da#<id> 记录（idle 控制台「DevOps Agent 账户」向导写入；
  // pending → template_generated → payload_saved → tested → enabled）
  await Promise.all(items.filter((i) => i.onboarded).map(async (i) => {
    try {
      const r = await ddb.send(new GetCommand({
        TableName: CONFIG_TABLE, Key: { PK: `da#${i.accountId}`, SK: "meta" },
      }));
      i.devopsAgentStatus = (r.Item && r.Item.onboarding_status) || "";
    } catch { /* 状态未知不阻断列表 */ }
  }));

  // ── 服务端对账（自愈）：状态推进不再依赖浏览器轮询在线 ──
  // PROVISIONING/OFFBOARDING 超过 3 分钟未更新 → 用 operation 真实状态推进；
  // operation 已丢/查不到且超 30 分钟 → 判 FAILED（可重试）。每次列表加载触发，无需后台任务。
  const STALE_MS = 3 * 60 * 1000, DEAD_MS = 30 * 60 * 1000;
  await Promise.allSettled(items.map(async (i) => {
    const cfg = onboarded[i.accountId];
    if (!cfg) return;
    const age = Date.now() - Date.parse(cfg.updated_at || 0);
    const st = cfg.org_onboard_status;
    if ((st === "PROVISIONING" || st === "OFFBOARDING") && age > STALE_MS && cfg.org_onboard_operation_id) {
      try {
        const r = await onboardStatus(cfg.org_onboard_operation_id, i.accountId);
        if (r.status === "SUCCEEDED") { i.orgOnboardStatus = "ACTIVE"; i.enabled = true; }
        else if (r.status === "FAILED" || r.status === "STOPPED") { i.orgOnboardStatus = "FAILED"; }
      } catch {
        if (age > DEAD_MS) {
          await putConfigAccount(i.accountId, { org_onboard_status: "FAILED" });
          i.orgOnboardStatus = "FAILED";
        }
      }
    }
    // DA 关联同样对账
    if (i.devopsAgentStatus === "provisioning") {
      try {
        const da = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: { PK: `da#${i.accountId}`, SK: "meta" } }));
        const daRec = da.Item || {};
        const daAge = Date.now() - Date.parse(daRec.updated_at || 0);
        if (daAge > STALE_MS && daRec.da_operation_id) {
          const r = await devopsAgentAssocStatus(daRec.da_operation_id, i.accountId);
          if (r.status === "ENABLED") i.devopsAgentStatus = "enabled";
          else if (r.status === "FAILED" || r.status === "STOPPED") i.devopsAgentStatus = "failed";
        }
      } catch { /* 忽略 */ }
    }
  }));
  items.sort((x, y) => x.accountId.localeCompare(y.accountId));
  return items;
}

/** 单账号一键接入。返回 {operationId, accountId}。 */
export async function onboardAccount(accountId, regions) {
  const ss = stackSetName();
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) { const e = new Error("invalid_account_id"); e.code = "bad_request"; throw e; }
  if (!Array.isArray(regions) || regions.length === 0) { const e = new Error("regions_required"); e.code = "bad_request"; throw e; }

  const existing = await getConfigAccount(id);
  if (existing && existing.org_onboard_status === "ACTIVE") {
    const e = new Error("already_onboarded"); e.code = "bad_request"; throw e;
  }

  // 友好名：从 Organizations 取账号 Name 一并登记（selector/徽标显示用；P1 修复：
  // 此前只写 role_arn/regions，前端退化为显示账号 ID）
  let accountName = "";
  try {
    const { DescribeAccountCommand } = await import("@aws-sdk/client-organizations");
    const d = await org.send(new DescribeAccountCommand({ AccountId: id }));
    accountName = d.Account?.Name || "";
  } catch { /* 取不到名不阻断 */ }

  const deployRegion = process.env.AWS_REGION || "us-east-1";
  // 多 Region：采集 Region 同时决定 stack instance 下发范围 —— 事件转发规则(EventBridge)
  // 是 Region 级资源，只有部署了实例的 Region 的 DevOps 事件才会转回系统总线。
  // IAM 角色是全局资源，模板用 IsPrimaryRegion 条件只在主 Region(=部署 Region)创建。
  const instanceRegions = [...new Set([deployRegion, ...regions.filter((r) => /^[a-z]{2}(-[a-z]+)+-\d$/.test(r))])];
  let opId;
  try {
    const r = await cf.send(new CreateStackInstancesCommand({
      StackSetName: ss,
      DeploymentTargets: {
        OrganizationalUnitIds: [await rootId()],
        Accounts: [id],
        AccountFilterType: "INTERSECTION",
      },
      Regions: instanceRegions,
      OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 },
    }));
    opId = r.OperationId;
  } catch (err) {
    if (err.name === "OperationInProgressException") {
      const e = new Error("operation_in_progress"); e.code = "bad_request"; throw e;
    }
    throw err;
  }

  await putConfigAccount(id, {
    role_arn: `arn:aws:iam::${id}:role/${MEMBER_ROLE_NAME}`,
    account_name: accountName,
    regions,
    enabled: false,
    description: "via web chat org one-click onboarding",
    org_onboard_status: "PROVISIONING",
    org_onboard_operation_id: opId,
  });
  return { operationId: opId, accountId: id };
}

/** 轮询 StackSet operation;SUCCEEDED 时启用账号（幂等）。 */
export async function onboardStatus(operationId, accountId) {
  const ss = stackSetName();
  const r = await cf.send(new DescribeStackSetOperationCommand({
    StackSetName: ss, OperationId: operationId,
  }));
  const status = (r.StackSetOperation && r.StackSetOperation.Status) || "UNKNOWN";

  const id = String(accountId || "").trim();
  if (id) {
    const cfg = await getConfigAccount(id);
    if (cfg) {
      // ⚠ 状态机按【记录状态】分派，绝不只看 op 结果 —— 事故教训：OFFBOARD 操作的
      // SUCCEEDED 曾被当成"接入成功"，把刚下线的账号复活并触发 agent space 创建。
      if (cfg.org_onboard_status === "OFFBOARDING") {
        if (status === "SUCCEEDED") {
          await ddb.send(new DeleteCommand({ TableName: CONFIG_TABLE, Key: { PK: `account#${id}`, SK: "meta" } }));
          return { operationId, status: "REMOVED", accountId: id };
        }
        if (status === "FAILED" || status === "STOPPED") {
          await putConfigAccount(id, { org_onboard_status: "FAILED" });
        }
        return { operationId, status, accountId: id };
      }
      if (status === "SUCCEEDED" && cfg.org_onboard_status === "PROVISIONING") {
        await putConfigAccount(id, { enabled: true, org_onboard_status: "ACTIVE" });
        // 一键到底：接入成功自动串联第二步（成员 Agent Space）。失败不阻断 —
        // Admin 页保留 Associate 按钮作为重试/逃生通道。
        try { await associateDevopsAgent(id); } catch { /* best-effort */ }
      } else if ((status === "FAILED" || status === "STOPPED") && cfg.org_onboard_status === "PROVISIONING") {
        await putConfigAccount(id, { org_onboard_status: "FAILED" });
      }
    }
  }
  return { operationId, status, accountId: id };
}

/** 停用（保留成员账号资源，仅停止采集/选择器隐藏；可随时重新启用）。 */
export async function setAccountEnabled(accountId, enabled) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) { const e = new Error("invalid_account_id"); e.code = "bad_request"; throw e; }
  const cfg = await getConfigAccount(id);
  if (!cfg) { const e = new Error("account_not_registered"); e.code = "bad_request"; throw e; }
  await putConfigAccount(id, { enabled: !!enabled });
  return { accountId: id, enabled: !!enabled };
}

/** 下线：删除成员账号内的 Stack Instances（角色 + 事件转发全部回收），完成后删除登记。 */
export async function offboardAccount(accountId) {
  const ss = stackSetName();
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) { const e = new Error("invalid_account_id"); e.code = "bad_request"; throw e; }
  let opId = "";
  try {
    const r = await cf.send(new DeleteStackInstancesCommand({
      StackSetName: ss,
      DeploymentTargets: {
        OrganizationalUnitIds: [await rootId()],
        Accounts: [id],
        AccountFilterType: "INTERSECTION",
      },
      Regions: await instanceRegionsOf(id),
      RetainStacks: false,
      OperationPreferences: { FailureTolerancePercentage: 100, MaxConcurrentPercentage: 100 },
    }));
    opId = r.OperationId;
  } catch (err) {
    if (err.name === "OperationInProgressException") {
      const e = new Error("operation_in_progress"); e.code = "bad_request"; throw e;
    }
    // 无实例（手动接入/已删）→ 直接清登记
    if (err.name !== "StackInstanceNotFoundException") throw err;
  }
  // DA 关联实例一并回收（space + trigger 角色）；失败不阻断数据侧下线
  try {
    await cf.send(new DeleteStackInstancesCommand({
      StackSetName: DA_STACKSET,
      DeploymentTargets: { OrganizationalUnitIds: [await rootId()], Accounts: [id], AccountFilterType: "INTERSECTION" },
      Regions: [process.env.AWS_REGION || "us-east-1"],
      RetainStacks: false,
    }));
  } catch { /* 无 DA 实例/操作冲突 → 忽略 */ }
  try { await ddb.send(new DeleteCommand({ TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" } })); } catch { /* 忽略 */ }
  if (opId) {
    await putConfigAccount(id, { enabled: false, org_onboard_status: "OFFBOARDING", org_onboard_operation_id: opId });
    return { operationId: opId, accountId: id, status: "OFFBOARDING" };
  }
  await ddb.send(new DeleteCommand({ TableName: CONFIG_TABLE, Key: { PK: `account#${id}`, SK: "meta" } }));
  return { operationId: "", accountId: id, status: "REMOVED" };
}

/** 该账号现有 stack instance 的 Region 列表（下线时全量删除）。 */
async function instanceRegionsOf(accountId) {
  const { ListStackInstancesCommand } = await import("@aws-sdk/client-cloudformation");
  const r = await cf.send(new ListStackInstancesCommand({
    StackSetName: stackSetName(), StackInstanceAccount: accountId,
  }));
  const regions = [...new Set((r.Summaries || []).map((x) => x.Region))];
  return regions.length ? regions : [process.env.AWS_REGION || "us-east-1"];
}


// ─── Phase 2: DevOps Agent 一键关联（per-member-space，全自动）───
const DA_STACKSET = process.env.MEMBER_DA_STACKSET_NAME || "notiops-member-devops-agent";

/** 第二步一键关联：在成员账号下发 Agent Space + Trigger Role（DA StackSet 实例）。 */
export async function associateDevopsAgent(accountId) {
  stackSetName(); // org 模式校验
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) { const e = new Error("invalid_account_id"); e.code = "bad_request"; throw e; }
  const cfg = await getConfigAccount(id);
  if (!cfg || cfg.org_onboard_status !== "ACTIVE") {
    const e = new Error("complete_step1_first"); e.code = "bad_request"; throw e;
  }
  let opId;
  try {
    const r = await cf.send(new CreateStackInstancesCommand({
      StackSetName: DA_STACKSET,
      DeploymentTargets: {
        OrganizationalUnitIds: [await rootId()],
        Accounts: [id],
        AccountFilterType: "INTERSECTION",
      },
      Regions: [process.env.AWS_REGION || "us-east-1"],
      OperationPreferences: { FailureTolerancePercentage: 0, MaxConcurrentPercentage: 100 },
    }));
    opId = r.OperationId;
  } catch (err) {
    if (err.name === "OperationInProgressException") {
      const e = new Error("operation_in_progress"); e.code = "bad_request"; throw e;
    }
    throw err;
  }
  // da# 记录：provisioning（与 idle 控制台向导同一张表同一状态机）。
  // schema 与老向导(api/routes/devops_agent.py _create_account)对齐：补 GSI1PK/GSI1SK
  // (老列表页靠 GSI1 查询,缺了会在老页面隐形)、account_alias(推送展示用)、region
  // (shared/devops_agent.py:229 硬下标 mapping["region"],缺了 KeyError)。
  const now = new Date().toISOString();
  await ddb.send(new UpdateCommand({
    TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" },
    UpdateExpression: "SET onboarding_status = :s, da_operation_id = :o, account_id = :a, updated_at = :u, " +
      "GSI1PK = :g1, GSI1SK = if_not_exists(GSI1SK, :now), account_alias = if_not_exists(account_alias, :alias), " +
      "#rg = :rg, created_at = if_not_exists(created_at, :now)",
    ExpressionAttributeNames: { "#rg": "region" },
    ExpressionAttributeValues: {
      ":s": "provisioning", ":o": opId, ":a": id, ":u": now, ":now": now,
      ":g1": "da#accounts", ":alias": (cfg && cfg.account_name) || "",
      ":rg": process.env.AWS_REGION || "us-east-1",
    },
  }));
  return { operationId: opId, accountId: id };
}

/** 关联进度轮询：SUCCEEDED 后跨账号读 stack outputs → 自动登记 payload → enabled。 */
export async function devopsAgentAssocStatus(operationId, accountId) {
  const id = String(accountId || "").trim();
  const r = await cf.send(new DescribeStackSetOperationCommand({
    StackSetName: DA_STACKSET, OperationId: operationId,
  }));
  const status = (r.StackSetOperation && r.StackSetOperation.Status) || "UNKNOWN";
  if (status !== "SUCCEEDED" || !id) {
    if ((status === "FAILED" || status === "STOPPED") && id) {
      await ddb.send(new UpdateCommand({
        TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" },
        UpdateExpression: "SET onboarding_status = :s, updated_at = :u",
        ExpressionAttributeValues: { ":s": "failed", ":u": new Date().toISOString() },
      }));
    }
    return { operationId, status, accountId: id };
  }
  // 读回 outputs：成员数据角色有 cloudformation:DescribeStacks（模板 v4）
  const { ListStackInstancesCommand, DescribeStacksCommand } = await import("@aws-sdk/client-cloudformation");
  const inst = await cf.send(new ListStackInstancesCommand({
    StackSetName: DA_STACKSET, StackInstanceAccount: id,
  }));
  const stackId = inst.Summaries?.[0]?.StackId;
  if (!stackId) return { operationId, status, accountId: id, note: "instance_not_found" };
  const creds = await credsFor(id);
  const cfMember = new CloudFormationClient({ region: process.env.AWS_REGION || "us-east-1", credentials: creds || undefined });
  const st = await cfMember.send(new DescribeStacksCommand({ StackName: stackId }));
  const outs = Object.fromEntries((st.Stacks?.[0]?.Outputs || []).map((o) => [o.OutputKey, o.OutputValue]));
  if (!outs.AgentSpaceId || !outs.TriggerRoleArn) {
    return { operationId, status, accountId: id, note: "outputs_missing" };
  }
  // 自动登记 payload（等价于向导的 _save_onboarding_payload + enable）。
  // onboarding_status 必须写 "active"（老向导终态字面量）——shared/devops_agent.py:80 的
  // 消费判定是 status=="active" AND enabled==True，之前误写 "enabled" 导致新接入账号
  // 对 Lambda4 主动调查链路隐形（判"未上车"）。
  const now = new Date().toISOString();
  await ddb.send(new UpdateCommand({
    TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" },
    UpdateExpression: "SET agent_space_id = :asi, agent_space_arn = :asa, trigger_role_arn = :tra, " +
      "onboarding_status = :s, enabled = :e, account_id = :a, updated_at = :u",
    ExpressionAttributeValues: {
      ":asi": outs.AgentSpaceId, ":asa": outs.AgentSpaceArn || "", ":tra": outs.TriggerRoleArn,
      ":s": "active", ":e": true, ":a": id, ":u": now,
    },
  }));
  return { operationId, status: "ENABLED", accountId: id, agentSpaceId: outs.AgentSpaceId };
}

// ─── 跨 Payer 接入(组织外账号:模板分发 + 手工回填 + 测试连接)───────────────
// 与 StackSet 路径(同 org)互补——覆盖组织外/不同 payer 的成员账号。
// 流程:生成 Launch Stack URL → 客户自行部署 → 管理员回填 Outputs → 测试连接 → active。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const TEMPLATE_KEY = "onboarding-templates/member-devops-agent.yaml";
const BUCKET = process.env.SKILLS_BUCKET || process.env.DATA_BUCKET || "";
const SELF_ACCOUNT = process.env.AWS_ACCOUNT_ID || "";

/** 生成 Launch Stack URL: 把 member-devops-agent.yaml 上传到 dataBucket,presign,拼 Launch Stack 深链。 */
export async function generateLaunchStackUrl(accountId) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) throw Object.assign(new Error("invalid_account_id"), { code: "bad_request" });
  if (!BUCKET) throw Object.assign(new Error("DATA_BUCKET not configured"), { code: "config_error" });

  // 把模板上传到 dataBucket(幂等覆盖)
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const s3 = new S3Client({});

  // 读模板源(Lambda zip 内打包,或从本地 infra/ 读取);运行时用 env 指定路径
  let tmplBody;
  const tmplPath = process.env.DA_TEMPLATE_PATH || join(process.cwd(), "infra", "member-devops-agent.yaml");
  try { tmplBody = readFileSync(tmplPath, "utf-8"); } catch {
    // Lambda 环境:模板 inline 存 S3 (由部署脚本/CDK custom resource 预置)
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: TEMPLATE_KEY }));
      tmplBody = await r.Body.transformToString();
    } catch (e) {
      throw Object.assign(new Error(`template not found at ${tmplPath} or s3://${BUCKET}/${TEMPLATE_KEY}: ${e.message}`), { code: "config_error" });
    }
  }

  // 上传到客户可访问的 presigned 位置
  const uploadKey = `onboarding-templates/member-devops-agent-${id}.yaml`;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: uploadKey, Body: tmplBody, ContentType: "text/yaml" }));

  // presign 12 小时
  const presignedUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: uploadKey }), { expiresIn: 43200 });

  // 拼 Launch Stack URL (us-east-1 为默认;客户可切区域)
  const sysAcct = SELF_ACCOUNT || (await new (await import("@aws-sdk/client-sts")).STSClient({}).send(
    new (await import("@aws-sdk/client-sts")).GetCallerIdentityCommand({}))).Account;
  const region = process.env.AWS_REGION || "us-east-1";
  const launchUrl = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create/review`
    + `?templateURL=${encodeURIComponent(presignedUrl)}`
    + `&stackName=notiops-devops-agent-${id}`
    + `&param_SystemAccountId=${sysAcct}`
    + `&param_OrganizationId=`;  // 留空 → TriggerRole 不带 org 条件,允许跨 payer

  return { accountId: id, templateUrl: presignedUrl, launchStackUrl: launchUrl, expiresHours: 12 };
}

/** 手工回填 Outputs(跨 payer:客户部署完把 AgentSpaceId/TriggerRoleArn 贴回来)+ 校验。 */
export async function manualPayloadSave(accountId, payload) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) throw Object.assign(new Error("invalid_account_id"), { code: "bad_request" });
  const { agent_space_id, trigger_role_arn } = payload || {};
  if (!agent_space_id || typeof agent_space_id !== "string") throw Object.assign(new Error("agent_space_id required"), { code: "bad_request" });
  if (!trigger_role_arn || !trigger_role_arn.startsWith("arn:aws:iam::")) throw Object.assign(new Error("invalid trigger_role_arn (must start with arn:aws:iam::)"), { code: "bad_request" });
  // ARN 账号段必须 == 目标账号(防误贴错账号的 role)
  const arnAccount = trigger_role_arn.split(":")[4];
  if (arnAccount !== id) throw Object.assign(new Error(`trigger_role_arn account (${arnAccount}) does not match target account (${id})`), { code: "bad_request" });

  const now = new Date().toISOString();
  const accountName = (await getConfigAccount(id))?.account_name || "";
  await ddb.send(new UpdateCommand({
    TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" },
    UpdateExpression: "SET agent_space_id = :asi, trigger_role_arn = :tra, onboarding_status = :s, " +
      "enabled = :e, account_id = :a, updated_at = :u, #rg = :rg, GSI1PK = :g1, " +
      "GSI1SK = if_not_exists(GSI1SK, :now), account_alias = if_not_exists(account_alias, :alias), " +
      "created_at = if_not_exists(created_at, :now)",
    ExpressionAttributeNames: { "#rg": "region" },
    ExpressionAttributeValues: {
      ":asi": agent_space_id, ":tra": trigger_role_arn, ":s": "active", ":e": true,
      ":a": id, ":u": now, ":rg": process.env.AWS_REGION || "us-east-1", ":now": now,
      ":g1": "da#accounts", ":alias": accountName || id,
    },
  }));
  return { accountId: id, status: "active", message: "Payload saved and account activated" };
}

/** 测试连接(跨 payer):AssumeRole → GetAgentSpace → 确认可达。 */
export async function testDaConnection(accountId) {
  const id = String(accountId || "").trim();
  const daRec = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" } }));
  const cfg = daRec.Item;
  if (!cfg || !cfg.trigger_role_arn || !cfg.agent_space_id) {
    throw Object.assign(new Error("account not configured (missing trigger_role_arn or agent_space_id)"), { code: "bad_request" });
  }
  const sts = new STSClient({});
  let creds;
  try {
    const r = await sts.send(new AssumeRoleCommand({
      RoleArn: cfg.trigger_role_arn, RoleSessionName: "notiops-test-conn",
      ExternalId: id, DurationSeconds: 900,
    }));
    creds = { accessKeyId: r.Credentials.AccessKeyId, secretAccessKey: r.Credentials.SecretAccessKey, sessionToken: r.Credentials.SessionToken };
  } catch (e) {
    return { success: false, step: "AssumeRole", error: e.message || String(e) };
  }
  // Step 2: GetAgentSpace
  try {
    const { DevOpsAgentClient, GetAgentSpaceCommand } = await import("@aws-sdk/client-devops-agent");
    const dac = new DevOpsAgentClient({ region: cfg.region || process.env.AWS_REGION || "us-east-1", credentials: creds });
    await dac.send(new GetAgentSpaceCommand({ agentSpaceId: cfg.agent_space_id }));
  } catch (e) {
    return { success: false, step: "GetAgentSpace", error: e.message || String(e) };
  }
  // 写测试成功时间(审计)
  await ddb.send(new UpdateCommand({
    TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" },
    UpdateExpression: "SET last_test_at = :t, last_test_result = :r, updated_at = :t",
    ExpressionAttributeValues: { ":t": new Date().toISOString(), ":r": "success" },
  }));
  return { success: true, accountId: id, agentSpaceId: cfg.agent_space_id };
}
