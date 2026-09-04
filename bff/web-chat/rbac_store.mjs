/**
 * RBAC 持久化（复用 web-chat 单表 notiops-web-chat，新增前缀）。
 *
 *   角色:       PK=role#{name}         SK=meta   {permissions:[], preset:bool, updatedAt}
 *   用户权限:   PK=userperm#{sub}      SK=meta   {roles:[], denies:[], updatedAt}
 *   模块开关:   PK=tenantcfg#modules   SK=meta   {disabled:[tabKey], updatedAt}
 *
 * 自托管 = 天然单租户，故不带 tenant 维度。用运行时预装 AWS SDK v3。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand, DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.WEB_CHAT_TABLE || "notiops-web-chat";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/* ───────────────── 角色 ───────────────── */

export async function listRoles() {
  const items = await scanByPrefix("role#");
  return items.map((i) => ({
    name: i.PK.slice("role#".length),
    permissions: i.permissions || [],
    preset: !!i.preset,
    updatedAt: i.updatedAt,
  }));
}

/** 扫描某 PK 前缀的所有 meta 记录（角色/用户权限数量小，Scan 可接受）。 */
async function scanByPrefix(prefix) {
  const out = [];
  let lastKey;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(PK, :p) AND SK = :sk",
      ExpressionAttributeValues: { ":p": prefix, ":sk": "meta" },
      ExclusiveStartKey: lastKey,
    }));
    out.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

export async function getRole(name) {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `role#${name}`, SK: "meta" },
  }));
  if (!r.Item) return null;
  return { name, permissions: r.Item.permissions || [], preset: !!r.Item.preset, updatedAt: r.Item.updatedAt };
}

export async function putRole(name, permissions, { preset = false } = {}) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { PK: `role#${name}`, SK: "meta", permissions: permissions || [], preset, updatedAt: Date.now() },
  }));
  return { name, permissions, preset };
}

export async function deleteRole(name) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `role#${name}`, SK: "meta" } }));
}

/** seed 预置角色：仅当不存在时写入（幂等）。返回被写入的角色名。 */
export async function seedRoleIfAbsent(name, permissions) {
  const existing = await getRole(name);
  if (existing) return null;
  await putRole(name, permissions, { preset: true });
  return name;
}

/* ───────────────── 用户权限 ───────────────── */

export async function getUserPerm(sub) {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `userperm#${sub}`, SK: "meta" },
  }));
  if (!r.Item) return null;
  return { sub, roles: r.Item.roles || [], denies: r.Item.denies || [], updatedAt: r.Item.updatedAt };
}

export async function putUserPerm(sub, { roles = [], denies = [] } = {}) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { PK: `userperm#${sub}`, SK: "meta", roles, denies, updatedAt: Date.now() },
  }));
  return { sub, roles, denies };
}

export async function listUserPerms() {
  const items = await scanByPrefix("userperm#");
  return items.map((i) => ({ sub: i.PK.slice("userperm#".length), roles: i.roles || [], denies: i.denies || [] }));
}

/** 删除某用户的权限记录（删用户时清理）。 */
export async function deleteUserPerm(sub) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `userperm#${sub}`, SK: "meta" } })).catch(() => {});
}

/** 统计持有某角色的用户数（删角色/末位 admin 保护用）。 */
export async function countUsersWithRole(roleName) {
  const all = await listUserPerms();
  return all.filter((u) => (u.roles || []).includes(roleName)).length;
}

/* ───────────────── 模块开关 ───────────────── */

export async function getDisabledModules() {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: "tenantcfg#modules", SK: "meta" },
  })).catch(() => null);
  return (r && r.Item && r.Item.disabled) || [];
}

export async function putDisabledModules(disabled) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { PK: "tenantcfg#modules", SK: "meta", disabled: disabled || [], updatedAt: Date.now() },
  }));
  return { disabled: disabled || [] };
}

/* ── EOL 人工覆盖（tenantcfg#eol）：admin 手动改的 EOS 日期，优先级最高。结构 {service:{versionKey:"YYYY-MM-DD"}} ── */
export async function getEolOverrides() {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: "tenantcfg#eol", SK: "meta" },
  })).catch(() => null);
  return (r && r.Item && r.Item.overrides) || {};
}

export async function putEolOverrides(overrides) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { PK: "tenantcfg#eol", SK: "meta", overrides: overrides || {}, updatedAt: Date.now() },
  }));
  return { overrides: overrides || {} };
}

/* ───────────────── 组→角色映射（Cognito group → roles，Option B）───────────────── */

/** 取某 Cognito group 映射到的角色名数组。无记录 → null（区分"未配置"与"配置为空"）。 */
export async function getGroupMap(groupName) {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { PK: `groupmap#${groupName}`, SK: "meta" },
  })).catch(() => null);
  if (!r || !r.Item) return null;
  return r.Item.roles || [];
}

/** 写某 group 的角色映射。 */
export async function putGroupMap(groupName, roles) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { PK: `groupmap#${groupName}`, SK: "meta", roles: roles || [], updatedAt: Date.now() },
  }));
  return { groupName, roles: roles || [] };
}

/** 列出所有已配置的 group→role 映射。 */
export async function listGroupMaps() {
  const items = await scanByPrefix("groupmap#");
  return items.map((i) => ({ groupName: i.PK.slice("groupmap#".length), roles: i.roles || [] }));
}

/** 删除某 group 的映射记录（删组时清理）。 */
export async function deleteGroupMap(groupName) {
  await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `groupmap#${groupName}`, SK: "meta" } })).catch(() => {});
}
