/**
 * 成员账号数据可见性（账号级 RBAC）。
 *
 * 存储（复用 web-chat 单表 notiops-web-chat，延续 rbac_store 前缀约定）：
 *   用户可见账号:  PK=acctvis#user#{sub}    SK=meta  {accounts:["<12位>"| "*"], updatedAt}
 *   组可见账号:    PK=acctvis#group#{name}  SK=meta  {accounts:[...], updatedAt}
 *
 * 语义（并集模型，与 authz.mjs 的角色并集一致）：
 *   · admin（生效权限含 "*"）→ 恒可见全部账号
 *   · 用户记录 ∪ 所属各组记录 的并集；任一含 "*" → 全部
 *   · 用户与其所有组【均无记录】→ 默认可见全部（向后兼容：未配置=不限制）
 *   · 有任一记录但并集为空 → 仅部署账号（selector 回退行为）
 *
 * 部署账号（本账号）不受限制 —— 限制只作用于成员账号数据。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand, DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.WEB_CHAT_TABLE || "notiops-web-chat";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const _pk = (kind, id) => `acctvis#${kind}#${id}`;

/** 读一条可见性记录；无记录返回 null。 */
export async function getVisibility(kind, id) {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: _pk(kind, id), SK: "meta" },
  }));
  if (!r.Item) return null;
  return { kind, id, accounts: r.Item.accounts || [], updatedAt: r.Item.updatedAt };
}

/** 写/覆盖一条可见性记录。accounts: ["*"] 或 12 位账号 ID 数组。 */
export async function putVisibility(kind, id, accounts) {
  const clean = (accounts || [])
    .map((a) => String(a).trim())
    .filter((a) => a === "*" || /^[0-9]{12}$/.test(a));
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { PK: _pk(kind, id), SK: "meta", accounts: clean, updatedAt: Date.now() },
  }));
  return { kind, id, accounts: clean };
}

/** 删除记录（恢复该主体的"未配置=默认全部"语义）。 */
export async function deleteVisibility(kind, id) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE, Key: { PK: _pk(kind, id), SK: "meta" },
  })).catch(() => {});
}

/** 列出全部可见性记录（admin 管理页用；记录数小，Scan 可接受）。 */
export async function listVisibility() {
  const out = [];
  let lastKey;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(PK, :p) AND SK = :sk",
      ExpressionAttributeValues: { ":p": "acctvis#", ":sk": "meta" },
      ExclusiveStartKey: lastKey,
    }));
    for (const i of r.Items || []) {
      const rest = i.PK.slice("acctvis#".length);
      const sep = rest.indexOf("#");
      out.push({ kind: rest.slice(0, sep), id: rest.slice(sep + 1), accounts: i.accounts || [], updatedAt: i.updatedAt });
    }
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/**
 * 计算用户可见账号集合。
 * 返回 "*"（全部可见）或 Set<accountId>。
 */
export async function visibleAccountSet(sub, cognitoGroups = [], eff = []) {
  // eff 形状兼容：authz.effective() 返回 { grants: [], denies: [] }（上线事故根因：
  // 此前误当数组调 .includes → /accounts 500 + /stream 无响应）。也兼容直接传数组。
  const grants = Array.isArray(eff) ? eff
    : (eff && Array.isArray(eff.grants)) ? eff.grants : [];
  // admin 兜底：生效权限含 "*" → 全部可见
  if (grants.includes("*")) return "*";

  const recs = [];
  const userRec = await getVisibility("user", sub);
  if (userRec) recs.push(userRec);
  for (const g of cognitoGroups || []) {
    const gRec = await getVisibility("group", g);
    if (gRec) recs.push(gRec);
  }
  if (recs.length === 0) return "*"; // 未配置 = 不限制（向后兼容）

  const set = new Set();
  for (const r of recs) {
    for (const a of r.accounts || []) {
      if (a === "*") return "*";
      set.add(a);
    }
  }
  return set;
}

/** 单账号可见性判定（部署账号恒可见）。 */
export async function isAccountVisible(accountId, sub, cognitoGroups, eff, deploymentAccountId) {
  const id = String(accountId || "").trim();
  if (!id) return true;
  if (deploymentAccountId && id === String(deploymentAccountId)) return true;
  const vis = await visibleAccountSet(sub, cognitoGroups, eff);
  return vis === "*" || vis.has(id);
}

/** 过滤账号列表（/accounts 选择器用）。 */
export async function filterVisibleAccounts(accounts, sub, cognitoGroups, eff, deploymentAccountId) {
  const vis = await visibleAccountSet(sub, cognitoGroups, eff);
  if (vis === "*") return accounts;
  return (accounts || []).filter(
    (a) => vis.has(String(a.accountId)) || String(a.accountId) === String(deploymentAccountId || ""),
  );
}
