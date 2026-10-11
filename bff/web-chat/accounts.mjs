/**
 * 多账号：从 notiops 的 config 表读已注册账号，供前端账号选择器。
 *
 * 登记沿用 idle 时代的 config 表布局（PK=account#<id>, GSI1PK="accounts"）。成员账号的写侧现在是
 * Web Chat「更多 → 管理 → 账户」（member_accounts.mjs：组织内一键接入 / 手动接入；目标账号里的
 * 采集角色由接入时部署的 CloudFormation 栈建出）。
 * 部署账号默认不在这份登记里：部署时（CDK 的 AutoOnboardResource / 一键部署的 stager）只写它的
 * da# 行（GSI1PK="da#accounts"，listAccounts 那条 GSI 查询读不到）。它的 account# 行通常只在管理员
 * 给部署账号配巡检 region 时由 member_accounts.mjs::setAccountRegions 建出；有人对部署账号走过
 * 「手动接入账号」时 member_accounts.mjs::manualPayloadSave 也会写这一行（那个函数不拒部署账号）；
 * 2026-09-04 退役的老 Dashboard「目标账户管理」可以手工登记任意账号，存量部署里也可能留着一行。
 * 这几种写法都带 GSI1PK="accounts" —— 所以下面列表时仍按 selfAccountId 排除。
 * 老 idle Dashboard 的接入页已于 2026-09-04 随老控制台退役。
 * 这里只**读** enabled 账号，绝不改。表名由环境变量 CONFIG_TABLE 注入（CDK）。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { OrganizationsClient, ListParentsCommand, DescribeOrganizationalUnitCommand, paginateListAccounts } from "@aws-sdk/client-organizations";

// OU 名缓存（selector 分组树用；org 结构变化低频，容器级缓存 1h）
const _org = new OrganizationsClient({});
const _ouCache = new Map(); // accountId -> {ou, at}
const OU_TTL = 3600_000;

// 账号名缓存：一次 Organizations ListAccounts 拿全组织 id→name（容器级 1h）。
// 兜底解决"config 行没存 account_name → selector/rollup 显示 accountId"的问题（任何接入路径通用）。
let _nameMap = null, _nameAt = 0;
const NAME_TTL = 3600_000;
export async function orgAccountNameMap() {
  if (_nameMap && Date.now() - _nameAt < NAME_TTL) return _nameMap;
  const m = new Map();
  try {
    for await (const page of paginateListAccounts({ client: _org }, {})) {
      for (const a of page.Accounts || []) if (a.Id) m.set(String(a.Id), a.Name || "");
    }
    _nameMap = m; _nameAt = Date.now();
  } catch { if (!_nameMap) _nameMap = m; }  // 无 org 权限 → 空 map（保持 accountId 兜底）
  return _nameMap;
}
/** 解析单个账号友好名；取不到返回 ""（调用方保留 accountId 兜底）。 */
export async function orgAccountName(id) {
  if (!id) return "";
  return (await orgAccountNameMap()).get(String(id)) || "";
}
/** 行内名兜底：name 缺失或等于 accountId 时，用 org 名回填。就地改 rows（含 name/accountId 字段）。 */
export async function fillAccountNames(rows, { idKey = "accountId", nameKey = "name" } = {}) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const needs = rows.some((r) => !r[nameKey] || String(r[nameKey]) === String(r[idKey]));
  if (!needs) return rows;
  const m = await orgAccountNameMap();
  for (const r of rows) {
    const id = String(r[idKey] || "");
    if (id && (!r[nameKey] || String(r[nameKey]) === id)) {
      const nm = m.get(id);
      if (nm) r[nameKey] = nm;
    }
  }
  return rows;
}

async function ouNameOf(accountId) {
  const hit = _ouCache.get(accountId);
  if (hit && Date.now() - hit.at < OU_TTL) return hit.ou;
  let ou = "";
  try {
    const p = await _org.send(new ListParentsCommand({ ChildId: accountId }));
    const parent = (p.Parents || [])[0];
    if (parent?.Type === "ORGANIZATIONAL_UNIT") {
      const d = await _org.send(new DescribeOrganizationalUnitCommand({ OrganizationalUnitId: parent.Id }));
      ou = d.OrganizationalUnit?.Name || "";
    } else if (parent?.Type === "ROOT") {
      ou = "Root";
    }
  } catch { /* 非 org 部署/无权限 → 平铺展示 */ }
  _ouCache.set(accountId, { ou, at: Date.now() });
  return ou;
}

const TABLE = process.env.CONFIG_TABLE || "notiops-config";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/** 列出已启用账号：[{accountId, accountName}]。表不可用/查询失败 → []（前端回退到仅部署账号）。 */
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
let _selfId = "";
/**
 * 部署账号 ID（本 Lambda 跑在哪个账号）。带进程内缓存。
 *
 * ⚠️ 导出给 `inspection.mjs` 用：巡检看板的账号选择器把**空字符串定义为
 * 「部署账号」**（`<option value="">部署账号</option>`），而全新部署的
 * 成员账号登记表是空的 → 选择器压根不渲染 → accountId 恒为空。
 * 所以巡检那侧必须把空值解析成这个 ID，否则每个新部署第一次打开看板
 * 都是 `account_required`。
 */
export async function selfAccountId() {
  if (_selfId) return _selfId;
  try { _selfId = (await new STSClient({}).send(new GetCallerIdentityCommand({}))).Account || ""; } catch { /* 空=不过滤 */ }
  return _selfId;
}

export async function deploymentInfo() {
  const id = await selfAccountId();
  let name = "";
  try {
    const { OrganizationsClient, DescribeAccountCommand } = await import("@aws-sdk/client-organizations");
    if (id) name = (await new OrganizationsClient({}).send(new DescribeAccountCommand({ AccountId: id })))?.Account?.Name || "";
  } catch { /* 取不到用兜底 */ }
  return { accountId: id, accountName: name || "Management account" };
}

export async function listAccounts() {
  try {
    const r = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": "accounts" },
    }));
    const accts = (r.Items || [])
      .filter((it) => it.enabled === true)
      .map((it) => ({
        accountId: String(it.account_id || it.GSI1SK || ""),
        accountName: String(it.account_name || it.name || it.account_id || ""),
        ou: "",
      }))
      .filter((a) => a.accountId);
    // 部署账号排除：选择器已有内置"部署账号"默认项，登记记录重复出现会造成双选项混淆
    const self = await selfAccountId();
    const filtered = self ? accts.filter((a) => a.accountId !== self) : accts;
    // 名兜底：config 没存 account_name 的账号（显示成 id）用 Organizations 名回填
    await fillAccountNames(filtered, { idKey: "accountId", nameKey: "accountName" });
    // OU 分组（selector 分组树）；单个失败不阻断
    await Promise.allSettled(filtered.map(async (a) => { a.ou = await ouNameOf(a.accountId); }));
    return filtered;
  } catch {
    return [];
  }
}
