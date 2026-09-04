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

/**
 * StackSet 一键接入可不可用（= 是否 org 模式部署）。
 *
 * 🔴 这个判据原本是**靠 `listMemberAccounts()` 抛 `org_mode_disabled`** 传给
 * 前端的。那样耦合了两件不同的事：
 *
 * ```
 * 能不能一键接入（要 StackSet + 管理账号）     ← 这个
 * 能不能列出账号（要 organizations:ListAccounts） ← 另一个，partner-resold 客户没有
 * ```
 *
 * 合在一个错误里，导致「列不出账号」被当成「整页不可用」，
 * 而跨 payer 流程（两者都不需要）也被一起挡掉。现在分开报。
 */
export function oneClickOnboardAvailable() {
  return Boolean((process.env.MEMBER_ONBOARDING_STACKSET_NAME || "").trim());
}

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
/**
 * 成员账号列表。
 *
 * ## 🔴 两条硬依赖都改成了**可降级**（2026-08-25）
 *
 * 原来第一行 `stackSetName()`（非 org 模式直接抛），后面又
 * `paginateListAccounts(org)`（`organizations:ListAccounts` 只有管理账号或
 * 委派管理员能调）。于是两类客户完全用不了这一页：
 *
 * ```
 * 非 org 模式部署        整页只剩一句「请用 --multi-account 重新部署」
 * partner-resold 客户   手里没有 payer 账号，系统部署在某个 linked account 上
 *                       → ListAccounts 是 AccessDenied
 * ```
 *
 * 而后者恰恰是**跨 payer 流程要服务的人**：那条流程（生成模板 URL → 客户在
 * 自己账号部署 → 回填）六个函数**一个都不碰 Organizations API**。账号存进
 * DDB 了却在列表里看不到，等于加进去了没法继续配（巡检前置区块挂在列表行上）。
 *
 * ## 降级后的行为
 *
 * ```
 * 能列出 Org        以 Org 为主表，DDB 记录做增强（原行为，不变）
 * 列不出（无权/非 org）  **只列 DDB 里我们自己写过的账号**
 *                   account# 记录（跨 payer 回填 / StackSet 接入都会写）
 *                   name/email 从 DDB 的 account_name 取，没有就显示账号 ID
 * ```
 *
 * ⚠️ 降级**不是静默**的：返回项带 `orgListable: false`，UI 据此提示
 * 「只显示已登记的账号，从组织里挑账号不可用」——否则客户会以为
 * 「组织里只有这几个账号」。
 */
export async function listMemberAccounts() {
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
  const mk = (id, cfg, name = "", email = "") => ({
    accountId: id,
    /**
     * 显示名。**人手填过的 alias 优先级最高**，其余照旧。
     *
     * ```
     * cfg.alias_source === "manual"   人在管理页填的  → 它赢
     * name                            Organizations 的实时 Account.Name
     * cfg.account_name                接入那一刻复制的一份（可能已过期）
     * ""                              前端落回账号号
     * ```
     *
     * 🔴 **必须靠 `alias_source` 分岔，不能简单地把 `cfg.account_name` 提到最前。**
     *
     *    `account_name` 有两个来源：人手填的，和接入那一刻从
     *    `DescribeAccount` 复制的一份。后者是**快照** —— 客户在 Organizations
     *    里给账号改了名之后，DDB 里那份就过期了。无条件让它赢的表现是列表上
     *    永远显示旧名字，而客户在 AWS 控制台里看到的是新名字，两边对不上而
     *    没有任何线索说明为什么。
     *
     *    所以只有**显式标记过 manual** 的才压过 org 名。
     *    `setAccountAlias()` 是唯一会写那个标记的地方。
     */
    name: (cfg && cfg.alias_source === "manual" && cfg.account_name)
      || name || (cfg && cfg.account_name) || "",
    /** 这一行的名字是不是人手填的 —— UI 据此显示「自定义」标记与「改名」按钮的初值。 */
    aliasManual: !!(cfg && cfg.alias_source === "manual" && cfg.account_name),
    email,
    onboarded: !!cfg,
    enabled: !!(cfg && cfg.enabled === true),
    orgOnboardStatus: (cfg && cfg.org_onboard_status) || "",
    // ⚠️ 读时默认成 `us-east-1`（见 `DEFAULT_COLLECT_REGIONS`）。库里那些
    //    已上车账号的 `regions` 实测都是 `[]`，而老采集链路对空列表是
    //    「一个 region 都不采」—— 呈现一个确定值比呈现空好。
    regions: (cfg && cfg.regions && cfg.regions.length)
      ? cfg.regions : [...DEFAULT_COLLECT_REGIONS],
    devopsAgentStatus: "", // 第二步（DevOps Agent 关联）状态，下方补齐
    /**
     * 这个账号需不需要重新部署 CFN 栈才能做巡检判读（改动①）。
     *
     * ⚠️ 这里给 `false` 而不是留 undefined —— 下面那段补齐只覆盖
     * `onboarded === true` 的行，留 undefined 会让前端对未接入的行也渲染徽章
     * （`undefined` 在 JSX 条件里是假值，但类型上会变成可选，前端容易漏判）。
     */
    needsStackUpdate: false,
    // 组织外账号（跨 Payer 接入）。默认 false —— 与 needsStackUpdate 同理：
    // 留 undefined 会让前端的 `?` 判不出来。上面 org 分支之后会覆盖它。
    outOfOrg: false,
    /**
     * 接入方式：`"manual"`（客户自己部署 CFN）| `""`（一键接入 / 老记录）。
     *
     * 🔴 一定要传到前端，因为**下线的回收范围按它分岔**：一键接入的能删掉成员
     * 账号里的栈，手动接入的碰不到那个栈（只能清本地登记）。原来这个字段写进
     * 了库却从来没被读过 —— 于是两种账号在列表里长得一模一样，客户点「下线」
     * 得到的结果完全不同而界面上没有任何区别。
     */
    onboardSource: (cfg && cfg.onboard_source) || "",
  });

  // ⚠️ 先试 Org，失败就降级 —— **不抛**。见函数 docstring：
  //    partner-resold 客户（无 payer 权限）与非 org 模式部署都会走到这里，
  //    而他们恰恰是跨 payer 流程要服务的人。
  let orgListable = true;
  try {
    for await (const page of paginateListAccounts({ client: org }, {})) {
      for (const a of page.Accounts || []) {
        if (a.Status !== "ACTIVE") continue;
        if (a.Id === selfId) continue; // 部署账号排除
        items.push(mk(a.Id, onboarded[a.Id], a.Name || "", a.Email || ""));
      }
    }
  } catch (e) {
    orgListable = false;
    // 只列 DDB 里我们自己登记过的账号。⚠️ 仍然排除部署账号自己
    //（它不属于「成员接入」范畴，误 offboard 会删掉它的登记记录）。
    for (const [id, cfg] of Object.entries(onboarded)) {
      if (!id || id === selfId) continue;
      items.push(mk(id, cfg));
    }
    console.warn(
      `listMemberAccounts: organizations:ListAccounts 不可用（${e?.name || e}），`
      + `降级为只列 DDB 已登记的 ${items.length} 个账号`);
  }

  // ── 🔴 组织外的已登记账号也要列出来（2026-08-30 补）──────────────────
  //
  // 上面那个 try 成功时（部署账号是 org 管理账号，这是最常见的形态），
  // `items` 里**只有本 org 的成员**。而「跨 Payer 接入」这个功能存在的全部
  // 理由就是接**别的 org / 独立**账号 —— 它们接进来之后 `ListAccounts`
  // 永远看不到，于是它们的行**永远不渲染**。
  //
  // 实例：某成员账号属于 o-aaaabbbbcc，部署账号属于
  // o-ddddeeeeff（**两个不同的 org**）。该成员账号手动接入成功、
  // `da#<账号>` 与 `account#<账号>` 都写好、
  // 巡检也照常扇出它（`enabled_accounts()` 读 `da#accounts` GSI，与 org 无关）
  // —— 而管理页上它不存在。
  //
  // 🔴 连带失去的全部挂在列表行上：
  //    · 「待更新栈」徽章       → 巡检 space 没回填看不出来
  //    · 改采集 Region 内联编辑 → regions 锁死在回填时写的部署 Region。
  //                              而客户资源不在那个区时 expected=0 →
  //                              completeness=1 → run success →
  //                              看板「跑过了、没风险」。零错误码。
  //    · 启用 / 停用 / 下线      → 没有入口
  //    · ①采集角色「验证并登记」重试 → IAM 传播延迟导致首次自动验证失败时
  //                              没有第二次机会 → role_arn 为空 →
  //                              executor 抛 RuntimeError，整轮该账号失败
  //    · 账号数据可见性勾选      → 无法授予/限制
  //
  // ⚠️ 手动接入流程本身**全绿**（返回 `status: "active"`、页面提示「已保存
  //    并激活」），所以运维看到成功、然后在列表里找不到这个账号 —— 而列表
  //    也不会说「有 N 个账号因为不在本 org 而没显示」（`orgListable` 只在
  //    降级时为 false）。这是「工作了但完全不可观测」。
  //
  // ⚠️ 仍然排除部署账号自己（与上面两处一致）。
  const listed = new Set(items.map((i) => i.accountId));
  for (const [id, cfg] of Object.entries(onboarded)) {
    if (!id || id === selfId || listed.has(id)) continue;
    const row = mk(id, cfg);
    // 🔴 打个标记让前端能说清「这个账号不在本组织里」—— 否则运维会以为
    //    列表串了账号。一键接入对它不可用（StackSet 覆盖不到），
    //    前端据此不渲染那个按钮。
    row.outOfOrg = true;
    items.push(row);
  }
  // 第二步状态：da#<id> 记录（idle 控制台「DevOps Agent 账户」向导写入；
  // pending → template_generated → payload_saved → tested → enabled）
  await Promise.all(items.filter((i) => i.onboarded).map(async (i) => {
    try {
      const r = await ddb.send(new GetCommand({
        TableName: CONFIG_TABLE, Key: { PK: `da#${i.accountId}`, SK: "meta" },
      }));
      i.devopsAgentStatus = (r.Item && r.Item.onboarding_status) || "";
      // 🔴 **存量账号的升级信号**（改动① 之后必需）。
      //
      //    per-account 之后每个成员账号在自己账号里有**两个** space：排障 +
      //    巡检。判据是「排障那个登记了，巡检那个没有」：
      //
      //      agent_space_id 有 + inspect_agent_space_id 空
      //        → 这个账号部署的是**旧模板**（没有第二个 space），
      //          或者部署了新模板但回填时那一栏留空了
      //
      //    两种读法的处置动作**相同**（重新部署栈 + 回填），所以一个标志够用，
      //    但提示文案要把两种都覆盖到。
      //
      // 🔴 不给这个信号的后果：那些账号采集照跑（enabled_accounts 读 da# 行、
      //    与这个字段无关）、花 GetMetricData、而判读永远为空 —— 而看板上
      //    「N 条未做根因分析」与「DA 说这些没问题」长得一样。
      //    管理页是唯一能看出「这个账号需要重新部署栈」的地方。
      //
      // ⚠️ 只对 `onboarding_status === "active"` 的账号报 —— 还在接入过程中的
      //    账号本来就还没回填，报了是噪音。
      const daItem = r.Item || {};
      i.needsStackUpdate = Boolean(
        String(daItem.onboarding_status || "") === "active"
        && String(daItem.agent_space_id || "").trim()
        && !String(daItem.inspect_agent_space_id || "").trim());
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
  // 🔴 把降级**说出来**，UI 据此提示「只显示已登记的账号」——
  //    不说的话客户会以为「组织里只有这几个账号」。
  //
  // ⚠️ 返回对象而**不是**把标记挂在数组上：`JSON.stringify([...])` 会
  //    静默丢掉数组的自有属性，于是那个标记永远到不了前端。
  return { items, orgListable };
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
  // ⚠️ `*`（巡检的「全部 region」哨兵，见 `ALL_REGIONS`）在这里被那个正则
  //    滤掉，所以填 `*` 时 stack instance **只下发到部署 Region**。这是刻意的：
  //    下发到 17 个 Region 是一次几分钟的批量操作、且大部分 Region 里没有
  //    任何资源。代价是那些 Region 的 DevOps 事件转发规则不存在 —— 对
  //    **巡检**没影响（判读派进部署账号的 space、结果走系统总线），对
  //    「客户在那个 Region 自己发起的调查」有影响。
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
/**
 * 已上车账号在 `regions` 为空时的默认值。
 *
 * 🔴 空 `regions` 的语义在两条链路上不一样，这就是它存在的理由：
 *
 * ```
 * 老采集链路（lambda1_collector）  `for region in account.regions` → 空就是
 *                                 **一个 region 都不采**（静默零产出）
 * 资源巡检（2026-08-27 起）        不读这个字段，扫账号下全部已启用 region
 * ```
 *
 * 实测两个已上车账号的 `regions` 都是 `[]` —— 也就是说老链路对它们一直是空跑。
 * 给一个 `us-east-1` 的默认值让它至少有确定行为，而不是「配置看起来是空的、
 * 行为是零」。
 *
 * ⚠️ 这是**读时默认**，不是数据迁移：不改库里已有的行，只在读出来是空时
 * 对外呈现它。客户第一次编辑那个框时才会真的写进去。写库迁移会把
 * 「客户从来没配过」与「客户配的就是 us-east-1」永久混成一件事。
 */
export const DEFAULT_COLLECT_REGIONS = ["us-east-1"];

const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/**
 * `regions` 里填这个 = 巡检扫**全部** region。
 *
 * 读侧在 `inspection/adapters/accounts.py::ALL_REGIONS`（Python）。两处是
 * 同一个约定的两半，改一处必须改另一处。
 *
 * ⚠️ 老采集链路（`lambda1_collector`）读同一个字段，而它是
 * `for region in account.regions` 直接建客户端 —— 它在
 * `lambda1_collector/accounts.py::_clean_regions` 里把 `*` 滤掉了。
 */
export const ALL_REGIONS = "*";

/**
 * 只改 `regions`，不触发任何 StackSet 下发。
 *
 * 🔴 **不能拿 `onboardAccount` 当编辑用**：那个函数会
 * `CreateStackInstances` 重新下发两个 StackSet（几分钟、会改成员账号里的
 * 资源）。客户想改的只是「采哪些 region」这一个字段。
 *
 * ⚠️ 逐个校验 region 形状并**明确拒绝**非法值。静默过滤掉打错的那个
 * （比如 `us-east1`）会让客户以为存进去了 —— 而那条链路的表现是「那个
 * region 一直没被采」，与「region 名打错了」在界面上完全一样。
 *
 * ⚠️ 空列表也拒。`regions: []` 在老采集链路上就是「一个都不采」，而客户
 * 清空输入框的意图几乎肯定不是那个（他要么想全采、要么手滑）。
 *
 * ⚠️ `*` 是合法输入（= 巡检扫全部 region，见 `ALL_REGIONS`）。它**不是**
 * 一个 region 名，所以不能进 `REGION_RE` 那道形状校验。
 */
export async function setAccountRegions(accountId, regions) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) {
    const e = new Error("invalid_account_id"); e.code = "bad_request"; throw e;
  }
  const cfg = await getConfigAccount(id);
  if (!cfg) {
    const e = new Error("account_not_registered"); e.code = "bad_request"; throw e;
  }
  const list = [...new Set(
    (Array.isArray(regions) ? regions : String(regions || "").split(/[,;\s]+/))
      .map((r) => String(r || "").trim().toLowerCase())
      .filter(Boolean))];
  if (!list.length) {
    const e = new Error(
      "regions_required: 至少给一个 region（老采集链路里空列表 = 一个都不采）");
    e.code = "bad_request"; throw e;
  }
  const bad = list.filter((r) => r !== ALL_REGIONS && !REGION_RE.test(r));
  if (bad.length) {
    const e = new Error(
      `invalid_region: ${bad.join(", ")} —— 形如 us-east-1 / ap-northeast-1，`
      + `或 ${ALL_REGIONS} 表示所有 region。`
      + "打错的 region 不会报错，只会让那个区一直没被采集，"
      + "所以这里拒写而不是静默过滤。");
    e.code = "bad_request"; throw e;
  }
  // ⚠️ 混填 `us-east-1,*` 时**归一成 `["*"]`** 再落库。留着两个值不算错
  //    （读侧 `scan_region_scope` 见到 `*` 就返回「全部」），但库里那行会
  //    让下一个人以为是「取交集」。存进去的东西应该和生效的语义一致。
  const norm = list.includes(ALL_REGIONS) ? [ALL_REGIONS] : list;
  await putConfigAccount(id, { regions: norm });
  return { accountId: id, regions: norm };
}

/** alias 的长度上限。超过这个长度在 IM 推送的标题行里会换行、把时间挤下去。 */
const ALIAS_MAX = 64;

/**
 * 改账号的显示名（alias）。
 *
 * ## 为什么要有这个入口
 *
 * 字段本来就存在，缺的只是「能改」：
 *
 * ```
 * account#<id>.account_name    → listAccounts() → 聊天页顶部账号选择器
 *                              → 管理页列表、各看板的账号列
 * da#<id>.account_alias        → lambda4_notifier 的推送标签
 *                                （`label = account_alias or f"账号 {id}"`）
 *                              → investigation 记录的 account_alias 字段
 *                              → DevOps Agent 调查列表的筛选键
 * ```
 *
 * 而这两个值此前**只在接入那一刻写一次**，来源是
 * `organizations:DescribeAccount` 的 `Account.Name`。跨组织接入的账号那个调用
 * 拿不到东西（账号不在本组织里）→ 两个字段都是空 → 客户在选择器和推送里
 * 看到的是**十二位数字**，而他手里可能有五个这样的账号。
 *
 * 🔴 **两行必须一起写。** 只写 `account#` 的表现是：页面上改好了、看板列也对了，
 *    而 IM 推送里仍然是旧名字（或者数字）—— 推送是客户看得最多的那一面。
 *    这与 `setAccountEnabled` 踩过的坑是**同一形态**（那次只写 `account#`，
 *    结果「停用」对巡检完全不起作用而界面反馈是成功的）。
 *
 * ⚠️ `da#` 行可能不存在（只 onboard 了、还没做 DevOps Agent 关联）。那时用条件写
 *    **跳过**，绝不建桩行 —— 一个只有 `account_alias` 的 `da#` 行会被
 *    `enabled_accounts` 当成可巡检账号（`_is_active` 对缺失的 `onboarding_status`
 *    放行），而它压根没有 agent space。同 `setAccountEnabled` 的处理。
 *
 * ⚠️ **空串是合法输入**，语义是「清空，回退到自动来源」：
 *      account_name 空 → `fillAccountNames()` 用 Organizations 名回填
 *      account_alias 空 → notifier 落到 `账号 <id>`
 *    所以不能像 regions 那样「空就拒」。这里两个字段都写空串而不是
 *    `REMOVE`，让读侧的 `||` 兜底链正常工作。
 *
 * ⚠️ **不会重命名已经建好的 agent space。** space 名字在创建时由
 *    `api/routes/devops_agent.py::_sanitize_agent_space_name(account_alias, id)`
 *    定死，之后没有 rename API。UI 的提示里写了这件事 —— 不写的话客户改完
 *    alias 会去 DevOps Agent 控制台找那个新名字，找不到。
 */
export async function setAccountAlias(accountId, alias) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) {
    const e = new Error("invalid_account_id"); e.code = "bad_request"; throw e;
  }
  const cfg = await getConfigAccount(id);
  if (!cfg) {
    const e = new Error("account_not_registered"); e.code = "bad_request"; throw e;
  }
  // ⚠️ `alias` 可能是 undefined（请求体里没这个键）。那与「显式传空串」在
  //    意图上完全不同，但这里都归成空串 —— 因为唯一的写侧是那个内联输入框，
  //    它总会传一个字符串。真正要防的是把 `undefined` 落成 `"undefined"`。
  let name = String(alias == null ? "" : alias);
  /**
   * 🔴 换行与控制字符必须清掉，不能只 trim 两头。
   *
   *    这个值会被拼进 IM 推送的标题行（飞书 / Slack / 钉钉）。一个粘进去的
   *    换行会把那条消息拆成两行，而卡片的标题字段在飞书上**只渲染第一行**
   *    —— 表现是推送标题变成半截账号名，且没有任何报错。
   */
  //    ⚠️ 用 `\u` 转义而不是把控制字符直接打进正则字面量 —— 后者在源码里
  //       不可见，下一个人会以为这个字符类是空的然后把它删掉（而它也会让整个文件被 grep 当成二进制）。
  name = name.replace(/[\u0000-\u001f\u007f]/g, " ")
    // 多个空白归一：粘贴进来的 `prod \t\n db` 不应该变成 `prod   db`。
    .replace(/\s+/g, " ").trim();
  if (name.length > ALIAS_MAX) {
    const e = new Error(
      `alias_too_long: 最多 ${ALIAS_MAX} 个字符（收到 ${name.length}）。`
      + "这个名字会进 IM 推送的标题行，太长会换行把时间挤下去。");
    e.code = "bad_request"; throw e;
  }
  /**
   * ⚠️ **纯数字的 alias 要拒**，而且要拒 12 位以外的也一样。
   *
   *    列表和选择器上的格式是「<名字> · <账号号>」。alias 是数字时那一行会长成
   *    `123456789012 · 111122223333` —— 两串数字并排，没人分得出哪个是账号号。
   *    而排查跨账号问题时「账号号」是唯一可靠的抓手。
   */
  if (name && /^[0-9]+$/.test(name)) {
    const e = new Error(
      "alias_numeric: alias 不能是纯数字 —— 列表里显示成「<alias> · <账号号>」，"
      + "两串数字并排没人分得出哪个是账号号。");
    e.code = "bad_request"; throw e;
  }

  /**
   * 🔴 `alias_source` 决定这个名字**压不压过** Organizations 的实时账号名
   *    （见 `mk()` 里那段说明）。
   *
   *    清空时写回 `"auto"` 而不是留着 `"manual"` —— 留着的表现是：客户清空
   *    输入框想「回退到 AWS 上的账号名」，而 `mk()` 里 `manual && account_name`
   *    的第二个条件为假，于是**恰好**落到了 org 名，看起来是对的。
   *    但下一次接入回填又把 `account_name` 写成一个快照值，那时它就以
   *    「人手填的」身份赢了 —— 一个客户从没输入过的名字。
   */
  await putConfigAccount(id, {
    account_name: name,
    alias_source: name ? "manual" : "auto",
  });

  // da# 行：**只在它已存在时**更新（条件写），不建桩行。见上面的说明。
  let daUpdated = false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: CONFIG_TABLE,
      Key: { PK: `da#${id}`, SK: "meta" },
      UpdateExpression: "SET account_alias = :a, updated_at = :t",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":a": name, ":t": new Date().toISOString() },
    }));
    daUpdated = true;
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    // da# 行不存在 = 还没做 DevOps Agent 关联 → 它本来就不进推送，不需要动。
  }
  // 🔴 回传 `pushLabelUpdated` —— UI 要能说清「IM 推送里的名字改了没有」。
  //    不回传的话「改了但推送还是旧名字」与「都改好了」在界面上一样。
  return { accountId: id, alias: name, pushLabelUpdated: daUpdated };
}

/**
 * 管理页的启停开关。
 *
 * 🔴 **必须同时写 `account#` 与 `da#` 两行**（2026-08-29 修）。
 *
 * 两行的分工是刻意的：
 *
 * ```
 * account#<id>   role_arn / regions        → **用什么凭证进去**
 * da#<id>        agent_space_id / enabled  → **跑不跑它**
 * ```
 *
 * 而巡检的账号扇出读的是 **`da#` 行**：
 * `inspection/adapters/accounts.py::enabled_accounts` 查
 * `GSI1PK = "da#accounts"`，再对每行过 `_is_enabled(item)`。
 *
 * 这个函数原来只写 `account#`（`putConfigAccount`）。后果：
 *
 * ```
 * 客户在管理页点「停用」
 *   → account#<id>.enabled = false
 *   → 界面上那个账号显示「已停用」
 *   → 而 da#<id> 那行一个字没动
 *   → enabled_accounts 照样返回它（`_is_enabled` 对缺失字段还**默认启用**）
 *   → 第二天照常巡检它、照常付 GetMetricData、照常派 DA 判读
 * ```
 *
 * ⚠️ 这个开关是「让某个账号别再被巡检」的**唯一** UI 入口，也就是说在这之前
 *    它对巡检完全不起作用 —— 而界面反馈是成功的。
 *    排查清单里那句「管理页的启停开关控制这个 [da#]」此前是错的，现在才成立。
 *
 * ⚠️ `da#` 行可能不存在（只做了 onboard、还没做 DevOps Agent 关联）。那时
 *    **不建行** —— 建一个只有 `enabled` 的桩行会让 `enabled_accounts` 把它
 *    当成一个可巡检账号（`_is_active` 对缺失的 `onboarding_status` 也放行），
 *    而它压根没有 agent space。用条件写：行不存在就跳过。
 */
export async function setAccountEnabled(accountId, enabled) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) { const e = new Error("invalid_account_id"); e.code = "bad_request"; throw e; }
  const cfg = await getConfigAccount(id);
  if (!cfg) { const e = new Error("account_not_registered"); e.code = "bad_request"; throw e; }
  await putConfigAccount(id, { enabled: !!enabled });

  // da# 行：**只在它已存在时**更新（条件写），不建桩行。
  let daUpdated = false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: CONFIG_TABLE,
      Key: { PK: `da#${id}`, SK: "meta" },
      UpdateExpression: "SET #e = :e, updated_at = :t",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: { "#e": "enabled" },
      ExpressionAttributeValues: { ":e": !!enabled, ":t": new Date().toISOString() },
    }));
    daUpdated = true;
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    // da# 行不存在 = 这个账号还没做 DevOps Agent 关联 → 它本来就不在
    // enabled_accounts 里，不需要动。
  }
  // 🔴 回传 `daUpdated` —— UI 要能说清「巡检那侧生效了没有」。
  //    不回传的话「停用了但巡检照跑」与「停用生效了」在界面上一样。
  return { accountId: id, enabled: !!enabled, inspectionToggled: daUpdated };
}

/**
 * 下线：回收成员账号内的资源（能回收的话）+ 删除本地登记。
 *
 * ## 两种账号，回收范围不一样 —— 而这件事必须告诉客户
 *
 * ```
 * 一键接入（StackSets）  DeleteStackInstances × 2 → 成员账号里的栈**真的被删**
 *                        角色 / 事件转发 / agent space 全部回收
 *
 * 手动接入（客户自己部署 CFN）
 *                        StackSet 里没有它的 instance → 我们碰不到那个栈
 *                        只能删本地登记；成员账号里的 agent space + 3 个 IAM
 *                        角色**原样留着**，要客户自己去删那个栈
 * ```
 *
 * 返回 `stackRetained` + `stackName` 让 UI 说清楚 —— 不说的话客户点完以为清
 * 干净了，而 agent space 还在那儿（它是计费资源）。
 *
 * 🔴 **不要求 org 模式**。原来第一行就是 `stackSetName()`，非 org 部署下它抛
 *    `org_mode_disabled`，于是后面清登记的代码**一行都没跑到** —— 客户点「下线」
 *    只看到一个 `org_mode_disabled`，账号原样留在列表里，而这个部署里压根没有
 *    StackSet 可删。
 *    （同一形态在 `listMemberAccounts` 上踩过一次：第一行 `stackSetName()`
 *    让整个账号页 early return，连手动接入的入口都看不到。）
 */
export async function offboardAccount(accountId) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) { const e = new Error("invalid_account_id"); e.code = "bad_request"; throw e; }
  // org 模式没开 → 没有 StackSet 可删，直接走「只清登记」那条路。
  let ss = "";
  try { ss = stackSetName(); } catch { ss = ""; }
  let opId = "";
  try {
    if (!ss) throw Object.assign(new Error("no stackset"), { name: "StackInstanceNotFoundException" });
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
    if (!DA_STACKSET) throw new Error("no da stackset");
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
  // 🔴 走到这里说明**没有**可删的 StackSet 实例 —— 也就是手动接入的账号。
  //    成员账号里那个栈我们碰不到，必须明说，否则客户以为下线就清干净了。
  //    栈名是 `generateLaunchStackUrl` 里写死的 `notiops-devops-agent-<id>`，
  //    所以能直接告诉他要删哪个。
  return {
    operationId: "", accountId: id, status: "REMOVED",
    stackRetained: true,
    stackName: `notiops-devops-agent-${id}`,
    stackRegion: process.env.AWS_REGION || "",
  };
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
  // 巡检判读用的第二个 space（模板输出 InspectionAgentSpaceId，改动①）。
  //
  // 🔴 **org 这条路也要写**，不只手动那条。第一版设计文档只提了手动回填 ——
  //    漏掉这里的后果是「一键接入的账号巡检判读为空、手动接入的正常」，
  //    又一次按接入方式分裂的行为。
  //
  // ⚠️ 存量账号部署的是旧模板（没有这个输出）→ 值为空 → **不写这个字段**。
  //    空串写进去与「没这个字段」在读侧同结果（`inspect_space_ids` 只收非空），
  //    但会让 DDB 上多一个看起来配过的空字段，排查时误导。
  let inspectSpaceId = String(outs.InspectionAgentSpaceId || "").trim();
  // ⚠️ 与手动那条路**同样的两道校验**。这条路的值来自 CFN 输出而不是人手贴，
  //    所以贴错的概率低 —— 但「读错输出名」这种代码级错误会把**排障** space 的
  //    id 写进巡检字段，后果与人贴错一样：该账号每一次排障调查都被判成巡检
  //    判读，客户点了深度调查而卡片永远不来。
  // 🔴 这里**不抛**（与手动那条不同）：这是轮询状态的函数，抛会让整个接入流程
  //    卡在 PROVISIONING。丢掉那个值 + 记 ERROR 更合适 —— 巡检判读缺失是可以
  //    在管理页看出来的（「待更新栈」徽章），而接入卡住不好排查。
  if (inspectSpaceId && inspectSpaceId === String(outs.AgentSpaceId || "").trim()) {
    console.error(
      `devopsAgentAssocStatus: account ${id} 的 InspectionAgentSpaceId 与 `
      + "AgentSpaceId 相同 —— 模板输出名读错了？已丢弃该值。"
      + "写进去会让这个账号的排障调查全部被判成巡检判读（卡片不来）。");
    inspectSpaceId = "";
  }
  if (inspectSpaceId
      && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
        .test(inspectSpaceId)) {
    console.error(
      `devopsAgentAssocStatus: account ${id} 的 InspectionAgentSpaceId `
      + `形状不对（${inspectSpaceId}）—— 要的是 UUID。已丢弃该值。`);
    inspectSpaceId = "";
  }
  await ddb.send(new UpdateCommand({
    TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" },
    UpdateExpression: "SET agent_space_id = :asi, agent_space_arn = :asa, trigger_role_arn = :tra, " +
      "onboarding_status = :s, enabled = :e, account_id = :a, updated_at = :u"
      + (inspectSpaceId ? ", inspect_agent_space_id = :isi" : ""),
    ExpressionAttributeValues: {
      ":asi": outs.AgentSpaceId, ":asa": outs.AgentSpaceArn || "", ":tra": outs.TriggerRoleArn,
      ":s": "active", ":e": true, ":a": id, ":u": now,
      ...(inspectSpaceId ? { ":isi": inspectSpaceId } : {}),
    },
  }));
  return {
    operationId, status: "ENABLED", accountId: id,
    agentSpaceId: outs.AgentSpaceId,
    inspectionAgentSpaceId: inspectSpaceId,
  };
}

// ─── 跨 Payer 接入(组织外账号:模板分发 + 手工回填 + 测试连接)───────────────
// 与 StackSet 路径(同 org)互补——覆盖组织外/不同 payer 的成员账号。
// 流程:生成 Launch Stack URL → 客户自行部署 → 管理员回填 Outputs → 测试连接 → active。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const TEMPLATE_KEY = "onboarding-templates/member-devops-agent.yaml";
const BUCKET = process.env.SKILLS_BUCKET || process.env.DATA_BUCKET || "";
/**
 * 部署账号 ID。
 *
 * 🔴 `AWS_ACCOUNT_ID` **不是 Lambda 的标准注入变量**（实测线上是 None），
 * 所以这个常量一直是空串 —— 每个用到它的地方都在走 STS 兜底，每次调用多一次
 * 往返。`DEPLOY_ACCOUNT_ID` 是 CDK 显式注入的（2026-08-25 加），恒有值。
 *
 * ⚠️ **不要**在这里 fallback 到 `LOCKED_ACCOUNT_ID`：那个变量的语义是闸门
 * （「只允许这个账号」），orgMode 下它是**空串**。拿它当身份用过一次了 ——
 * 见 `devops_agent_skills.mjs::selfAccount()` 与
 * `lambda_inspection_executor/handler.py::_deploy_account_id` 的说明。
 *
 * ⚠️ 空串时各调用点仍有 STS 兜底（行为与修复前一致），所以这只是省往返，
 * 不是修 bug。
 */
const SELF_ACCOUNT = (process.env.DEPLOY_ACCOUNT_ID
  || process.env.AWS_ACCOUNT_ID || "").trim();

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
  // 🔴 `charset=utf-8` **必须写上**。2026-08-26 实测：只写 `text/yaml` 时，
  //    S3 上的字节是正常 UTF-8（下载回来中文完好），但 CloudFormation 控制台
  //    把模板里所有中文渲染成 `?`：
  //
  //    ```
  //    堆栈描述  NotiOps member account DevOps Agent onboarding … ????????? Agent Space
  //    参数      OrganizationId  (???????) AWS Organizations ID (o-xxxx)?????
  //    ```
  //
  //    客户看到的就是这一屏 —— 一堆问号，完全看不出这个模板要建什么、
  //    参数该填什么。而这不报错。
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: uploadKey, Body: tmplBody, ContentType: "text/yaml; charset=utf-8" }));

  // presign 12 小时
  const presignedUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: uploadKey }), { expiresIn: 43200 });

  // 拼 Launch Stack URL (us-east-1 为默认;客户可切区域)
  const sysAcct = SELF_ACCOUNT || (await new (await import("@aws-sdk/client-sts")).STSClient({}).send(
    new (await import("@aws-sdk/client-sts")).GetCallerIdentityCommand({}))).Account;
  const region = process.env.AWS_REGION || "us-east-1";
  // 🔴 巡检 space 的**完整 ARN**（不是 id）预填进去 —— 模板用它当
  //    `aws:SourceArn` 信任条件。ARN 里带 region，而客户可能把栈部署在与系统
  //    账号不同的 region；模板里拿 `${AWS::Region}` 拼就会拼出一个永远不成立
  //    的条件，DA assume 不进来，且**不报错**（表现是判读拿不到该账号数据）。
  //
  // ⚠️ 空串时不拼这个参数（模板默认值也是空）→ 只建根因调查那套，不建巡检
  //    的两个角色。单账号部署（没有巡检 space）就是这条路。
  const inspectArn = INSPECT_SPACE_ID
    ? `arn:aws:aidevops:${region}:${sysAcct}:agentspace/${INSPECT_SPACE_ID}`
    : "";
  // 🔴 判读结果回传用的 custom bus ARN，**预填**进模板（改动①）。
  //
  //    不预填的后果：客户要手贴一个 ARN，而贴错区/贴错账号的表现是
  //    **事件静默不到** —— 客户侧零反馈，我们侧只是「那个账号的判读一直空着」。
  //
  // ⚠️ 与上面的 inspectArn 同一手法：**拼出来**，不从 env 传。
  //    总线名在 CDK 里是硬编码常量（notiops-devops-events），
  //    多拉一条 env 要动 NotiOpsBackendStack 与 WebChatStack 两个栈的接口。
  //    ⚠️ 代价是名字在两处各写一遍 —— 由
  //      `tests/test_member_template_inspection_space.py::test_总线名两处一致`
  //      钉住。漂了的表现同样是事件静默不到。
  // 🔴 **org 已接入的账号要留空**，不是忘了传。那些账号的转发由
  //    `member-account-onboarding.yaml`（StackSets 下发那份）建，两份都建会让
  //    同一批事件被投**两次** —— callback 跑两遍、双份 Bedrock 摘要、重复的
  //    progress 行，而且**不报错**（两份模板的 7 个 detail-type 逐条相同）。
  //
  // ⚠️ 判据用 `account#<id>.org_onboard_status` —— 它是 org 一键接入那条路写的
  //    （`onboardAccount` 写 PROVISIONING，`onboardStatus` 推到 ACTIVE）。
  //    非空 = 走过一键接入 = 已经有转发规则。
  //    手动接入的账号这个字段是空的（`manualPayloadSave` 不写它）。
  const cfgForBus = await getConfigAccount(id);
  // 🔴 **判据是 `org_onboard_operation_id`，不是 `org_onboard_status`。**
  //
  //    2026-08-30 修：原来用 `org_onboard_status` 非空判「走过一键接入」，而
  //    `manualPayloadSave` **自己就写** `org_onboard_status: "ACTIVE"`
  //    （同函数 :1031）→ 手动接入的账号被判成一键接入 → 总线 ARN 不预填 →
  //    模板的 `EnableEventForwarding` 为假 → **不建转发规则** →
  //    判读与排障事件永远回不到系统账号。
  //
  //    而这条**只在「存量账号重新生成链接」时踩** —— 第一次接入时
  //    `account#` 行还不存在，判据为假、照常预填。而「存量升级」正是
  //    §五 那一节要解决的场景，管理页的「待更新栈」徽章就是引导客户走这条路。
  //    更糟的是：回填成功之后徽章会消失 → 看起来修好了。零错误码。
  //
  // ⚠️ `org_onboard_operation_id` 只有 `onboardAccount`（StackSet 那条路）写
  //    （那里是 `org_onboard_operation_id: opId`），`manualPayloadSave` 不写它。
  //    ⚠️ 不用 `onboard_source !== "manual"`：`manualPayloadSave` 会**无条件**
  //      把它改写成 "manual"，所以一个先被一键接入、后来又手动回填过的账号
  //      会丢掉「StackSet 已经下发过转发规则」这个事实。
  const wentThroughOneClick = Boolean(
    String((cfgForBus || {}).org_onboard_operation_id || "").trim());
  // 🔴 **部署账号自己也要留空** —— 否则是「同账号自转」，客户会收到**两张**报告卡。
  //
  //    路径（review 抓出来的，比「两份模板并存」更容易踩）：
  //      DA 事件落部署账号的 default bus
  //        → CDK 那条 default bus 规则命中 → callback（第 1 次）
  //        → 本模板新加的转发规则把它转给**同账号**的 custom bus
  //          → CDK 那条 custom bus 规则命中 → callback（第 2 次）
  //    两条规则指向同一个 Lambda。而 IM 发起的调查**全部钉死在部署账号**
  //    （DEFAULT_INVESTIGATION_ACCOUNT_ID = 部署账号），那里 chat target
  //    真实存在 ⇒ 客户真的会看到两张卡（`_deliver_report` 是发新消息，
  //    不是原地更新实时卡）。
  //
  // ⚠️ 本函数原来**没有** `id === SELF_ACCOUNT` 守卫（只校验 12 位数字），
  //    而同文件列账号时是显式排除部署账号的 —— 两处标准不一致。
  const isSelfAccount = Boolean(sysAcct) && id === String(sysAcct);
  const devopsBusArn = (wentThroughOneClick || isSelfAccount)
    ? ""
    : `arn:aws:events:${region}:${sysAcct}:event-bus/${DEVOPS_BUS_NAME}`;
  const launchUrl = `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create/review`
    + `?templateURL=${encodeURIComponent(presignedUrl)}`
    + `&stackName=notiops-devops-agent-${id}`
    + `&param_SystemAccountId=${sysAcct}`
    + `&param_OrganizationId=`  // 留空 → TriggerRole 不带 org 条件,允许跨 payer
    // 巡检①采集角色：手动接入的账号一定要建（StackSets 没覆盖到它）。
    // 同 Org 已被一键接入下发过同名角色的账号要在控制台上改成 no，否则撞名。
    + `&param_CreateCollectionRole=yes`
    // 巡检②：控制台「添加辅助云来源」向导第 1~6 步（手建角色 + 抄信任策略）
    // 由模板代劳，客户只剩最后一步「连接到代理」。
    + `&param_InspectionAgentSpaceArn=${encodeURIComponent(inspectArn)}`
    // 事件转发：填了这个参数模板才建转发角色+规则（Condition EnableEventForwarding）。
    // 空串 → 模板不建（见上面 wentThroughOneClick 的判据）。
    + `&param_DevOpsEventBusArn=${encodeURIComponent(devopsBusArn)}`;

  return {
    accountId: id, templateUrl: presignedUrl, launchStackUrl: launchUrl,
    expiresHours: 12,
    // 前端据此决定要不要显示②那段收尾提示（没有巡检 space 就不该提巡检）
    inspectionAgentSpaceId: INSPECT_SPACE_ID,
    inspectionAgentSpaceArn: inspectArn,
    devopsEventBusArn: devopsBusArn,
    // ⚠️ 让前端能说清「这个账号为什么没预填总线 ARN」——
    //    否则运维看到参数是空的会以为生成链接出错了。
    eventForwardingFromOneClick: wentThroughOneClick,
    // ⚠️ 部署账号自己：不填总线 ARN（同账号自转会双投）
    isDeployAccount: isSelfAccount,
  };
}

/** 手工回填 Outputs(跨 payer:客户部署完把 AgentSpaceId/TriggerRoleArn 贴回来)+ 校验。 */
export async function manualPayloadSave(accountId, payload) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) throw Object.assign(new Error("invalid_account_id"), { code: "bad_request" });
  const { agent_space_id, trigger_role_arn } = payload || {};
  if (!agent_space_id || typeof agent_space_id !== "string") throw Object.assign(new Error("agent_space_id required"), { code: "bad_request" });
  // 巡检判读用的第二个 space（模板输出 InspectionAgentSpaceId，改动①）。
  //
  // 🔴 **这个字段的读取函数早就存在**（`inspection/adapters/accounts.py::
  //    inspect_space_id` / `inspect_space_ids`），缺的一直是写入面 ——
  //    于是成员账号的它永远是空，而 executor 的新形状是「读不到就报错」。
  //
  // ⚠️ **可选**，不是必填。存量账号部署的是旧模板（没有第二个 space），
  //    强制必填会让他们连排障那半都回填不了。空的后果是那个账号不派巡检判读，
  //    而 `enabled_accounts` 仍然会扇出它 —— 采集照跑、判读为空。
  //    那个组合由 executor 侧显式报错兜住（不是静默）。
  const inspectSpaceId = typeof (payload || {}).inspect_agent_space_id === "string"
    ? payload.inspect_agent_space_id.trim() : "";
  // 🔴 **贴成排障那个 space 的 id 会静默切断这个账号的排障链路。**
  //
  //    诱因很实：CFN Outputs 里 `AgentSpaceId` 与 `InspectionAgentSpaceId`
  //    形态一模一样（都是 UUID），管理页两个输入框的 placeholder 也一样。
  //
  //    失败链（逐环都在代码里）：
  //      da#<账号>.inspect_agent_space_id == agent_space_id
  //        → accounts.inspect_space_ids 把它收进集合
  //        → callback_route.route_of 对该账号**每一次**排障调查都判 INSPECTION
  //        → CardMode.SKIP + 巡检 S3 前缀 + 跳过 progress 行与 IM 投递
  //    客户看到：点了深度调查、调查真跑完了，**卡片永远不来、进度不动、
  //    报告在排障列表里找不到**。零错误码，日志里只有一行 INFO。
  //
  // ⚠️ 两个值相等是**一行的成本**就能拒掉的 —— 它们就在同一个 payload 里。
  if (inspectSpaceId && inspectSpaceId === String(agent_space_id).trim()) {
    throw Object.assign(new Error(
      "inspect_agent_space_id must differ from agent_space_id: 这两个是**不同**"
      + "的 space（排障 / 巡检）。贴成同一个会让这个账号的排障调查全部被当成"
      + "巡检判读处理 —— 卡片不来、进度不动、报告进错前缀，而且不报错。"
      + "去 CFN Outputs 里分别取 AgentSpaceId 与 InspectionAgentSpaceId。"),
      { code: "bad_request" });
  }
  // ⚠️ 形状校验：agent space id 是 UUID。贴 ARN / 贴 space 名字都会让判据永不
  //    命中（事件里 AWS 给的是 id），而那个后果是「这个账号的判读一直空着」——
  //    与「DA 说这些没问题」在看板上长得一样。宁可写侧拒掉。
  if (inspectSpaceId
      && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
        .test(inspectSpaceId)) {
    throw Object.assign(new Error(
      `invalid inspect_agent_space_id (${inspectSpaceId}): 要的是 CFN Outputs 里`
      + " InspectionAgentSpaceId 的值（UUID 形态），不是 ARN、不是 space 名字。"),
      { code: "bad_request" });
  }
  if (!trigger_role_arn || !trigger_role_arn.startsWith("arn:aws:iam::")) throw Object.assign(new Error("invalid trigger_role_arn (must start with arn:aws:iam::)"), { code: "bad_request" });
  // ARN 账号段必须 == 目标账号(防误贴错账号的 role)
  const arnAccount = trigger_role_arn.split(":")[4];
  if (arnAccount !== id) throw Object.assign(new Error(`trigger_role_arn account (${arnAccount}) does not match target account (${id})`), { code: "bad_request" });

  const now = new Date().toISOString();
  const accountName = (await getConfigAccount(id))?.account_name || "";
  await ddb.send(new UpdateCommand({
    TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" },
    // ⚠️ 巡检 space id 只在**给了值**时写 —— 空串写进去与「没这个字段」在读侧
    //    是同一个结果（`inspect_space_ids` 只收非空），但会让 DDB 上多一个
    //    看起来配过的空字段，排查时误导。
    UpdateExpression: "SET agent_space_id = :asi, trigger_role_arn = :tra, onboarding_status = :s, " +
      "enabled = :e, account_id = :a, updated_at = :u, #rg = :rg, GSI1PK = :g1, " +
      "GSI1SK = if_not_exists(GSI1SK, :now), account_alias = if_not_exists(account_alias, :alias), " +
      "created_at = if_not_exists(created_at, :now)"
      + (inspectSpaceId ? ", inspect_agent_space_id = :isi" : ""),
    ExpressionAttributeNames: { "#rg": "region" },
    ExpressionAttributeValues: {
      ":asi": agent_space_id, ":tra": trigger_role_arn, ":s": "active", ":e": true,
      ":a": id, ":u": now, ":rg": process.env.AWS_REGION || "us-east-1", ":now": now,
      ":g1": "da#accounts", ":alias": accountName || id,
      ...(inspectSpaceId ? { ":isi": inspectSpaceId } : {}),
    },
  }));
  // 🔴 **同时登记一条 `account#<id>` 记录**，否则这个账号在管理页的列表里
  //    看不见。
  //
  //    上面写的是 `da#`（GSI1PK=da#accounts，DevOps Agent 那一族）。而账号
  //    列表读的是 `account#`（GSI1PK=accounts）—— 有 Organizations 权限时
  //    列表以 Org 为主表所以看得到，但 partner-resold 客户（手里只有 linked
  //    account、读不到 ListAccounts）走的是降级路径，那条路只列 `account#`。
  //
  //    结果就是「手动接入成功了，账号却不出现在列表里」——
  //    而巡检的跨账号前置区块挂在列表行上，于是也配不了。
  //
  // ⚠️ **不写 `role_arn`**。那是巡检的采集角色，必须经
  //    `verifyAndRegisterCollectionRole()` 真 AssumeRole 通过之后才登记 ——
  //    在这里顺手填一个推导值会让管理页显示「已登记」而实际 assume 不进去。
  //
  // ⚠️ `enabled` 用 `if_not_exists`：这条记录的 enabled 是给**老系统与列表**
  //    看的，而巡检扇出看的是 `da#` 那条（上面已置 true）。不覆盖已有值，
  //    避免把客户手动 disable 过的账号又打开。
  await ddb.send(new UpdateCommand({
    TableName: CONFIG_TABLE, Key: { PK: `account#${id}`, SK: "meta" },
    UpdateExpression:
      "SET account_id = :a, GSI1PK = :g1, GSI1SK = :a, updated_at = :u, "
      + "org_onboard_status = :st, onboard_source = :src, "
      + "account_name = if_not_exists(account_name, :alias), "
      + "enabled = if_not_exists(enabled, :e), "
      // 🔴 **采集 Region 必须写一个值**（2026-08-30 补）。
      //
      //    这条路原来**从不写** `regions`，于是读侧落到默认
      //    `DEFAULT_SCAN_REGIONS = ("us-east-1",)` —— 客户资源不在那个区时：
      //      expected.instances = 0 → completeness = 0÷0 = 1 → run success
      //      → 看板显示「跑过了、没风险」。零错误码、零告警。
      //
      //    ⚠️ org 那条路（`onboardAccount(accountId, regions)`）**是**收 regions
      //      的 —— 两条接入路的 UX 本来就不一致，这里补齐。
      //
      // ⚠️ 默认值用**部署 Region** 而不是 us-east-1：运维就在那个区工作，
      //    客户的主要资源大概率也在那儿。这仍然是个猜测 —— 所以管理页每一行
      //    都显示它并带「改 Region」内联编辑，i18n 提示里也说了填 `*` 表示全部。
      //
      // ⚠️ `if_not_exists`：**绝不覆盖**运维已经配过的值。重新回填一次
      //    （存量升级那条路会做）不该把人家改过的 region 冲掉。
      + "#rg = if_not_exists(#rg, :rg), "
      + "created_at = if_not_exists(created_at, :now)",
    ExpressionAttributeNames: { "#rg": "regions" },
    ExpressionAttributeValues: {
      ":a": id, ":g1": "accounts", ":u": now, ":now": now,
      ":rg": [process.env.AWS_REGION || "us-east-1"],
      // ⚠️ 标成 ACTIVE：这条路径没有 StackSet operation 可轮询，
      //    留 PROVISIONING 会让列表里的自愈对账逻辑一直去查一个不存在的
      //    operation，然后 30 分钟后判 FAILED。
      ":st": "ACTIVE",
      ":src": "manual",
      ":alias": accountName || id,
      ":e": true,
    },
  }));
  // ── 顺手把巡检①的采集角色验一次并登记 ──
  //
  // 客户刚部署的那个栈（合并后的 member-devops-agent.yaml）已经把
  // `notiops-idle-detection-role-<系统账号>` 建好了，角色名是模板固定的、
  // 我们能推导出来。所以这里直接 AssumeRole 一次：通了就登记，①那一栏在页面
  // 上自己变绿，客户不用再点一次「验证并登记」。
  //
  // 🔴 **失败不阻断保存**。三种失败都是正常状态，不该让「保存并激活」报错：
  //    · 客户的栈是合并前的老模板部署的（没有采集角色）
  //    · 部署时把 CreateCollectionRole 选成了 no
  //    · IAM 角色刚建完还没传播到 STS（几秒内 AssumeRole 会 AccessDenied）
  //    前两种要客户去补，第三种点一次「验证并登记」就好 —— 两者都靠 UI 上
  //    那一栏的状态引导，而状态本来就会显示「缺失」。
  //
  // ⚠️ 仍然是**真** AssumeRole，没有绕过 `verifyAndRegisterCollectionRole`
  //    「不验不写」那条原则。省掉的只是那一次点击。
  let collection = null;
  try {
    collection = await verifyAndRegisterCollectionRole(id);
  } catch (e) {
    collection = { ok: false, error: `${e?.name || ""} ${e?.message || e}`.trim() };
  }

  return {
    accountId: id, status: "active",
    message: "Payload saved and account activated",
    collectionRole: collection,
    // ⚠️ 回传**存进去的**巡检 space id。不回传的后果是管理员贴错之后没有任何
    //    渠道能看出库里存的是什么：表单不回填现有值，而「待更新栈」徽章的判据
    //    只看「有没有值」—— 填了错值的账号有值，不报警。
    //    （org 那条路 `devopsAgentAssocStatus` 已经在回传了，两边对齐。）
    inspectionAgentSpaceId: inspectSpaceId,
  };
}

/**
 * 测试连接(跨 payer):AssumeRole → GetAgentSpace → 确认可达。
 *
 * ## 可以直接测「还没保存的值」
 *
 * `probe` 传了就用它，不读库。🔴 原来只读 `da#<id>` 记录，于是客户填完两个
 * 输入框先点「测试连接」（两个按钮并排，很自然的顺序）就会拿到
 * 「account not configured (missing trigger_role_arn or agent_space_id)」——
 * 而他**明明刚填了那两个值**，这个报错读起来完全莫名。
 *
 * 「测试」的语义本该是「测我填的这些对不对」，而不是「测我保存过的」。
 * 而且先测后存更安全：测不通就不该写库。
 *
 * ⚠️ 审计时间戳（`last_test_at`）只在**记录已存在**时写 —— 用 probe 测一个
 * 还没保存的账号时不建记录，否则会留下一条只有测试时间、没有配置的半条记录。
 */
export async function testDaConnection(accountId, probe = null) {
  const id = String(accountId || "").trim();
  const daRec = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" } }));
  const saved = daRec.Item;
  // probe 优先：客户在输入框里填的值。缺任一项时落回已保存的记录。
  const cfg = (probe && probe.trigger_role_arn && probe.agent_space_id)
    ? { ...(saved || {}), ...probe }
    : saved;
  if (!cfg || !cfg.trigger_role_arn || !cfg.agent_space_id) {
    throw Object.assign(new Error(
      "account not configured — fill in Agent Space ID and Trigger Role ARN "
      + "(or click Save first)"), { code: "bad_request" });
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
  // 写测试成功时间(审计)。
  // ⚠️ 条件写 `attribute_exists(PK)`：用 probe 测一个**还没保存**的账号时
  //    不要建记录 —— 否则库里会留一条只有 last_test_at、没有 agent_space_id
  //    的半条记录，而 `enabled_accounts()` / 列表都会把它当成一个真账号。
  try {
    await ddb.send(new UpdateCommand({
      TableName: CONFIG_TABLE, Key: { PK: `da#${id}`, SK: "meta" },
      UpdateExpression: "SET last_test_at = :t, last_test_result = :r, updated_at = :t",
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeValues: { ":t": new Date().toISOString(), ":r": "success" },
    }));
  } catch (e) {
    // 记录还不存在（先测后存的正常路径）→ 跳过审计写，不影响测试结果
    if (e?.name !== "ConditionalCheckFailedException") throw e;
  }
  return { success: true, accountId: id, agentSpaceId: cfg.agent_space_id };
}

// ---------------------------------------------------------------------------
// 跨账号巡检的前置状态（2026-08-25）
//
// 巡检要跑成员账号，需要两件互相独立的东西。这个模块只**报告状态**，
// 不代客户做 —— 两件都要在目标账号里部署 CFN，那必须由账号所有者点。
//
// ```
// ① 采集凭证   account#<id>/meta 的 role_arn
//              → executor 用它 AssumeRole 进去 describe / 读 CloudWatch
//              ⚠️ **必需**。缺了整轮直接失败（不再静默用部署账号凭证代跑）
//
// ② 判读深度   把该账号作为 monitor account 关联进**部署账号的巡检 space**
//              → DA 判读时能主动查它的 PI / events
//              ⚠️ 可选。缺了判读仍然出结论（payload 里有 7 天指标），
//                 只是少了主动深挖那一半
// ```
//
// 🔴 巡检**共用部署账号的一个 space**，根因调查才是每账号一个。
//    所以 ② 是「把成员账号加进那一个 space」，不是「给它建自己的 space」。
// ---------------------------------------------------------------------------

/** 巡检 space 的 id / name（CDK 注入）。空 = 主栈还没部署到位。 */
const INSPECT_SPACE_ID = process.env.INSPECT_AGENT_SPACE_ID || "";

/** 系统账号那条 custom event bus 的名字。
 *
 * 🔴 与 `infra/lib/notiops-backend-stack.ts` 里 `eventBusName:
 * "notiops-devops-events"` **必须一致**。这里重复一遍是为了不给 BFF 多拉一条
 * env（那要动 NotiOpsBackendStack 与 WebChatStack 两个栈的接口）。
 * 漂了的表现是**事件静默不到**：客户的栈往一个不存在的总线投递，
 * EventBridge 侧失败、我们侧只看到「那个账号的判读一直空着」。
 * `tests/test_member_template_inspection_space.py` 钉住两处一致。
 */
const DEVOPS_BUS_NAME = "notiops-devops-events";
const INSPECT_SPACE_NAME = process.env.INSPECT_AGENT_SPACE_NAME || "";

/**
 * 采集角色的 ARN —— **推导，不让客户手填**。
 *
 * 角色名由 `member-account-onboarding.yaml` 固定（`RoleName: !Sub
 * "notiops-idle-detection-role-${SystemAccountId}"`），客户没有选择余地。
 * 让他贴 ARN 只会引入贴错账号、贴成 trigger role 之类的错。
 *
 * ⚠️ 与 `MEMBER_ROLE_NAME` 同源：那个常量在非 org 模式下会 fallback 成
 * 不带后缀的名字，而模板建的**永远带后缀** —— 所以这里不复用它，直接按
 * 模板的规则拼。
 */
export function collectionRoleArn(accountId, systemAccountId) {
  return `arn:aws:iam::${accountId}:role/notiops-idle-detection-role-${systemAccountId}`;
}

/** 跨账号巡检的前置状态 + 引导信息。**只读。** */
/**
 * association 记录里的账号 ID —— 两种 configuration 形状都要认。
 *
 * 🔴 `aws`（accountType=monitor）是 space **自己那个账号**；
 *    `sourceAws`（accountType=source）才是**追加进来的辅助账号**，
 *    控制台「添加辅助云来源」向导建的正是这一种。
 *    原来只读 `configuration.aws.accountId` —— 于是客户照向导做完了，
 *    管理页照样显示「未关联（判读会降级）」，他会以为白做了一遍。
 */
function associationAccountId(a) {
  return String(a?.configuration?.sourceAws?.accountId
    || a?.configuration?.aws?.accountId || "");
}

/**
 * 巡检②那个角色的 ARN —— 由 `infra/member-devops-agent.yaml` 的
 * `InspectionMonitorRole` 固定命名，所以能推导，不让客户手贴。
 *
 * ⚠️ 改这里就要同步改模板的 `RoleName`（两边都带 `-m<系统账号>` 后缀，
 *    为的是同一个成员账号能被多个 NotiOps 部署纳管而不撞名）。
 */
function inspectionMonitorRoleArn(accountId, systemAccountId) {
  return `arn:aws:iam::${accountId}:role/notiops-inspection-monitor-`
    + `${accountId}-m${systemAccountId}`;
}

/**
 * 把成员账号关联进**系统账号**的巡检 Agent Space（辅助云来源）。
 *
 * ## 为什么这一步能由我们代做，而角色不能
 *
 * ```
 * 成员账号侧的角色   要在成员账号里建 IAM      → 只能客户自己部署 CFN
 * space 上的关联     是系统账号的 API 调用     → BFF 就跑在系统账号里 ✓
 * ```
 *
 * 控制台那个向导把两件事串在一起（第 1~6 步建角色、第 7 步连接），所以看着
 * 像整件事都得客户做。拆开之后：角色由合并后的模板建，关联由这里一个按钮做。
 *
 * ## 2026-08-26 在一次性 agent space 上实测的三条语义
 *
 * ```
 * ① sourceAws/source 与 aws/monitor **并存**
 *    文档写 "overwrites the existing association of the same service"，读着像
 *    会把部署账号自己那条 monitor 关联顶掉。实测不会 —— 覆盖是按账号算的。
 *    （这条不确认不敢上：顶掉的话部署账号自己的巡检判读当场断。）
 * ② 同账号再关联一次 → ValidationException "AWS association with accountId
 *    ... already exists for this agent space"。**不幂等**，要当成功处理，
 *    否则客户手动关联过、或按钮点两下，都会看到一个红色报错。
 * ③ 成员账号那个角色不存在时 → 关联能建，状态 pending-confirmation，
 *    validate 一次变 invalid。所以要在这里 validate 并把状态带回去，
 *    不然会显示「已关联 ✓」而其实 DA 进不去。
 * ```
 */
export async function associateInspectionSource(accountId) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) {
    throw Object.assign(new Error("invalid_account_id"), { code: "bad_request" });
  }
  if (!INSPECT_SPACE_ID) {
    throw Object.assign(
      new Error("INSPECT_AGENT_SPACE_ID not configured - this deployment has no "
        + "inspection agent space"), { code: "config_error" });
  }
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const sysAcct = SELF_ACCOUNT
    || (await new STSClient({}).send(new GetCallerIdentityCommand({}))).Account;
  if (id === sysAcct) {
    throw Object.assign(
      new Error("deployment account is already the primary account of this space"),
      { code: "bad_request" });
  }
  const roleArn = inspectionMonitorRoleArn(id, sysAcct);

  const { DevOpsAgentClient, AssociateServiceCommand,
    ValidateAwsAssociationsCommand, ListAssociationsCommand } =
    await import("@aws-sdk/client-devops-agent");
  const da = new DevOpsAgentClient({});

  let created = false;
  try {
    await da.send(new AssociateServiceCommand({
      agentSpaceId: INSPECT_SPACE_ID,
      serviceId: "aws",
      configuration: {
        sourceAws: { accountId: id, accountType: "source", assumableRoleArn: roleArn },
      },
    }));
    created = true;
  } catch (e) {
    // 已存在 = 目标状态已达成（客户可能自己在控制台做过了）
    if (!/already exists/i.test(String(e?.message || ""))) {
      const err = new Error(
        `关联失败：${e?.name || ""} ${e?.message || e}`.trim());
      err.code = "cross_account_unavailable";
      throw err;
    }
  }

  // 让服务端真去 assume 一次并把状态落下来。失败不阻断 —— 关联本身已经建了。
  try {
    await da.send(new ValidateAwsAssociationsCommand({
      agentSpaceId: INSPECT_SPACE_ID,
    }));
  } catch { /* 无此权限/限流 → 状态留在 pending-confirmation，UI 会显示 */ }

  let status = "";
  try {
    const r = await da.send(new ListAssociationsCommand({
      agentSpaceId: INSPECT_SPACE_ID,
    }));
    const hit = (r.associations || []).find((a) => associationAccountId(a) === id);
    status = String(hit?.status || "");
  } catch { /* 忽略 */ }

  return { ok: true, accountId: id, created, roleArn, status,
    spaceId: INSPECT_SPACE_ID };
}

export async function inspectionCrossAccountStatus(accountId) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) {
    throw Object.assign(new Error("invalid_account_id"), { code: "bad_request" });
  }
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const sysAcct = SELF_ACCOUNT
    || (await new STSClient({}).send(new GetCallerIdentityCommand({}))).Account;

  const acct = await getConfigAccount(id);
  const roleArn = String(acct?.role_arn || "");
  const expected = collectionRoleArn(id, sysAcct);

  // ② 的状态：查巡检 space 上有没有指向这个账号的 association。
  //
  // ⚠️ 读不到就报 unknown，**不报 false** —— 「没关联」和「我们没权限查」
  //    对客户是不同的动作（一个去关联，一个来找我们）。
  let monitorLinked = null;
  let monitorStatus = "";
  if (INSPECT_SPACE_ID) {
    try {
      const { DevOpsAgentClient, ListAssociationsCommand } =
        await import("@aws-sdk/client-devops-agent");
      const da = new DevOpsAgentClient({});
      const r = await da.send(new ListAssociationsCommand({
        agentSpaceId: INSPECT_SPACE_ID,
      }));
      const items = r.associations || r.items || [];
      const hit = items.find((a) => associationAccountId(a) === id);
      monitorLinked = Boolean(hit);
      // valid / invalid / pending-confirmation。
      // 🔴 `invalid` 与「没关联」完全不同：关联建了但成员账号那个角色不存在
      //    （或信任策略不对），DA assume 不进去。2026-08-26 实测：角色缺失时
      //    associate 返回 pending-confirmation，validate 一次就变 invalid。
      //    只报「已关联 ✓」会把这种情况说成好的。
      monitorStatus = String(hit?.status || "");
    } catch { /* 权限/SDK 缺失 → 留 null = unknown */ }
  }

  return {
    ok: true,
    accountId: id,
    systemAccountId: sysAcct,
    /** 巡检共用的那一个 space。前端 SHALL NOT 硬编码 —— 重建栈会变。 */
    inspectionSpace: {
      id: INSPECT_SPACE_ID,
      name: INSPECT_SPACE_NAME,
      // 控制台里按名字找比按 id 快；region 用 BFF 所在 region（= 部署 region）
      region: process.env.AWS_REGION || "",
    },
    /** ① 采集凭证 */
    collection: {
      // `registered` 只表示**登记过**，不代表 assume 通得过 ——
      // 后者要真的 STS 调用一次，见 verifyCollectionRole。
      registered: Boolean(roleArn),
      roleArn: roleArn || "",
      expectedRoleArn: expected,
      /** 登记的与模板会建的不一致 —— 常见于手工贴错，或换过部署账号。 */
      mismatch: Boolean(roleArn) && roleArn !== expected,
    },
    /** ② 判读深度 */
    monitorAssociation: {
      // null = 查不到（无权/SDK 缺），不是「没关联」
      linked: monitorLinked,
      /** "" | valid | invalid | pending-confirmation */
      status: monitorStatus,
      /** 模板建出来的角色名是固定的，所以能推导 —— 不让客户手贴 */
      expectedRoleArn: inspectionMonitorRoleArn(id, sysAcct),
    },
  };
}

/**
 * 验证并登记采集角色。**真的 AssumeRole 一次**，通了才写库。
 *
 * 🔴 不验就写的后果：库里有一个看起来对的 role_arn，而 executor 每轮
 * assume 失败一次。那时错误出现在**后台**（run 记录里），而客户在管理页
 * 看到的是「已登记 ✓」—— 两边说的不是一回事。
 */
export async function verifyAndRegisterCollectionRole(accountId) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) {
    throw Object.assign(new Error("invalid_account_id"), { code: "bad_request" });
  }
  const { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } =
    await import("@aws-sdk/client-sts");
  const sts = new STSClient({});
  const sysAcct = SELF_ACCOUNT
    || (await sts.send(new GetCallerIdentityCommand({}))).Account;
  if (id === sysAcct) {
    throw Object.assign(
      new Error("deployment account needs no cross-account role"),
      { code: "bad_request" });
  }
  const roleArn = collectionRoleArn(id, sysAcct);

  try {
    await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: "notiops-verify-collection-role",
      DurationSeconds: 900,
    }));
  } catch (e) {
    // 把 AWS 的原话带出去 —— 「AccessDenied」与「NoSuchEntity」指向完全不同的动作
    const err = new Error(
      `AssumeRole ${roleArn} 失败：${e?.name || ""} ${e?.message || e}`);
    err.code = "cross_account_unavailable";
    throw err;
  }

  // 通了才登记。⚠️ 不动 `enabled` —— 那是独立的开关，由客户在列表里控制。
  await putConfigAccount(id, {
    role_arn: roleArn,
    inspection_collection_verified_at: new Date().toISOString(),
  });
  return { ok: true, accountId: id, roleArn, verified: true };
}

/**
 * 采集角色的 Launch Stack URL —— **跨 Org 场景的第一步**。
 *
 * ## 为什么需要它（而不是复用 generateLaunchStackUrl）
 *
 * 跨 payer 接入要**两个**模板，它们建的东西完全不同：
 *
 * ```
 * member-devops-agent.yaml        AgentSpace + PrimaryRole + TriggerRole
 *   → 根因调查用（每账号一个自己的 space）
 *   → 已有 URL（generateLaunchStackUrl）
 *
 * member-account-onboarding.yaml  notiops-idle-detection-role-<系统账号>
 *   + DevOps Agent 事件转发 +（可选）PHD 转发
 *   → **巡检采集**用 —— executor AssumeRole 进去读 RDS/EC/CloudWatch
 *   → 此前只有 StackSet 那条路会下发它，跨 Org 场景**没有任何 UI 入口**
 * ```
 *
 * 客户原话：「不是应该给我一个 CFN url，我从被加入的账号点开，创建 iam role
 * 和 agent space 吗」—— 是，但需要两个 URL，因为 role 和 space 在两个模板里。
 *
 * ## 参数怎么来
 *
 * ```
 * SystemAccountId      部署账号（STS 或 env）
 * DevOpsEventBusArn    **必填**（模板有 AllowedPattern 校验）——
 *                      推导成 arn:aws:events:<region>:<部署账号>:event-bus/notiops-devops-events
 *                      （CDK 建的那个 custom bus，名字固定）
 * OrganizationId       跨 payer 场景**留空**：留空时模板不给信任策略加
 *                      aws:PrincipalOrgID 条件，否则组织外账号永远 assume 不进来
 * PrimaryRegion        部署 region（IAM 是全局资源，模板用它决定只在主区建角色）
 * ```
 */
export async function generateCollectionStackUrl(accountId) {
  const id = String(accountId || "").trim();
  if (!/^[0-9]{12}$/.test(id)) {
    throw Object.assign(new Error("invalid_account_id"), { code: "bad_request" });
  }
  if (!BUCKET) {
    throw Object.assign(new Error("DATA_BUCKET not configured"),
      { code: "config_error" });
  }
  const { S3Client, PutObjectCommand, GetObjectCommand } =
    await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const s3 = new S3Client({});

  const KEY = "onboarding-templates/member-account-onboarding.yaml";
  let tmplBody;
  const tmplPath = process.env.COLLECTION_TEMPLATE_PATH
    || join(process.cwd(), "infra", "member-account-onboarding.yaml");
  try { tmplBody = readFileSync(tmplPath, "utf-8"); } catch {
    // Lambda 环境：模板由部署脚本预置到 S3（与 DA 模板同一套机制）
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
      tmplBody = await r.Body.transformToString();
    } catch (e) {
      throw Object.assign(new Error(
        `template not found at ${tmplPath} or s3://${BUCKET}/${KEY}: ${e.message}`),
        { code: "config_error" });
    }
  }

  const uploadKey = `onboarding-templates/member-account-onboarding-${id}.yaml`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET, Key: uploadKey, Body: tmplBody, ContentType: "text/yaml; charset=utf-8" }));
  const presignedUrl = await getSignedUrl(
    s3, new GetObjectCommand({ Bucket: BUCKET, Key: uploadKey }),
    { expiresIn: 43200 });

  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const sysAcct = SELF_ACCOUNT
    || (await new STSClient({}).send(new GetCallerIdentityCommand({}))).Account;
  const region = process.env.AWS_REGION || "us-east-1";
  // ⚠️ event bus 名字与 CDK 里那个 custom bus 一致（`notiops-devops-events`）。
  //    写错的表现是 CFN 创建成功但事件转发规则指向一个不存在的 bus，
  //    而巡检采集（这个模板的主要目的）照常工作 —— 所以错了不容易发现。
  const busArn =
    `arn:aws:events:${region}:${sysAcct}:event-bus/notiops-devops-events`;

  const launchUrl =
    `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/create/review`
    + `?templateURL=${encodeURIComponent(presignedUrl)}`
    + `&stackName=notiops-collection-${sysAcct}`
    + `&param_SystemAccountId=${sysAcct}`
    + `&param_DevOpsEventBusArn=${encodeURIComponent(busArn)}`
    + `&param_PrimaryRegion=${region}`
    // 🔴 跨 payer 必须留空 —— 非空会给信任策略加 aws:PrincipalOrgID 条件，
    //    而组织外账号不在我们的 Org 里，那个条件永远不成立。
    + `&param_OrganizationId=`;

  return {
    accountId: id,
    templateUrl: presignedUrl,
    launchStackUrl: launchUrl,
    expiresHours: 12,
    /** 部署完之后要登记的角色 ARN（供 UI 直接显示，不让客户手抄）。 */
    expectedRoleArn: collectionRoleArn(id, sysAcct),
  };
}
