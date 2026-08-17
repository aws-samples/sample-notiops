/**
 * Admin API 业务逻辑（角色 / 用户 / 模块开关）。
 * 路由挂在 index.mjs，均需 nav:admin 权限（由 authz 门禁保证）。
 */
import {
  CognitoIdentityProviderClient, ListUsersCommand,
  AdminCreateUserCommand, AdminDeleteUserCommand, ListGroupsCommand,
  CreateGroupCommand, DeleteGroupCommand, ListUsersInGroupCommand,
  AdminAddUserToGroupCommand, AdminRemoveUserFromGroupCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomBytes } from "node:crypto";
import { allNodes } from "./capabilities.mjs";
import { PRESET_ROLES, DEFAULT_GROUP_ROLE_MAP, matchesAny } from "./authz.mjs";
import {
  listRoles as storeListRoles, getRole, putRole, deleteRole,
  getUserPerm, putUserPerm, listUserPerms, countUsersWithRole, deleteUserPerm,
  getDisabledModules, putDisabledModules,
  listGroupMaps, putGroupMap, deleteGroupMap,
  getEolOverrides, putEolOverrides,
} from "./rbac_store.mjs";
import { getEolTable } from "./eos.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";
const cognito = new CognitoIdentityProviderClient({ region: REGION });

const ADMIN_ROLE = "role:admin";

/* ───────────────── 全量能力清单（Admin 权限树渲染用）───────────────── */

/** 返回完整 registry 节点（不做权限过滤；Admin 勾选树据此生成，registry 驱动可扩展）。 */
export function apiAllCapabilities() {
  return allNodes().map((n) => ({
    key: n.key, level: n.level, parent: n.parent || null,
    title_zh: n.title_zh, title_en: n.title_en,
    alwaysOn: !!n.alwaysOn, adminOnly: !!n.adminOnly,
  }));
}

/* ───────────────── 角色 ───────────────── */

/** 列出角色：DDB 记录 + 未落库的预置角色（内存兜底），去重。 */
export async function apiListRoles() {
  const stored = await storeListRoles();
  const names = new Set(stored.map((r) => r.name));
  const merged = [...stored];
  for (const [name, permissions] of Object.entries(PRESET_ROLES)) {
    if (!names.has(name)) merged.push({ name, permissions, preset: true, updatedAt: 0 });
  }
  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

/** 校验 permissions 中每个 key 都存在于 registry（* 与 X:* 通配特殊处理）。返回非法 key 数组。 */
function invalidKeys(permissions) {
  const bad = [];
  const keys = new Set(allNodes().map((n) => n.key));
  // X:* 合法的判定：X 本身是节点，或存在任意节点落在 X 之下（key === X 或以 "X:" 开头）。
  // 这样像 action:cases:*（无 action:cases 中间节点，但有 action:cases:create 等）也算合法。
  const anyUnder = (base) => {
    for (const k of keys) if (k === base || k.startsWith(base + ":")) return true;
    return false;
  };
  for (const p of permissions || []) {
    if (p === "*") continue;
    if (p.endsWith(":*")) {
      const base = p.slice(0, -2);
      if (!anyUnder(base)) bad.push(p);
      continue;
    }
    if (!keys.has(p)) bad.push(p);
  }
  return bad;
}

/** 会顺带吞掉 `nav:admin` 的通配（如 `nav:*`）。返回这类 pattern 数组。
 *
 * `satisfiesAdmin()` 已经在判定侧堵住了它们（通配不再跨界），所以这里纯粹是入口侧的
 * 提醒：否则保存静默成功、角色定义里躺着一条看起来给了 admin 的 `nav:*`，下一个读它的
 * 人只能靠猜。要给管理权限就该用 role:admin，而不是靠通配捎带。
 * 显式点名 admin 的写法（`nav:admin`、`nav:admin:*`）不在此列 —— 那是明确的意图表达。
 */
export function adminSwallowingWildcards(permissions) {
  return (permissions || []).filter(
    (p) => typeof p === "string" && p !== "*" && p.endsWith(":*")
      && !p.startsWith("nav:admin")
      && matchesAny([p], "nav:admin"));
}

/** 建/改角色。role:admin 恒为 * 不可改（需求 4.5）；key 必须存在（需求 4.4）。 */
export async function apiSaveRole(name, permissions) {
  if (!name || !/^[A-Za-z0-9:_-]{2,64}$/.test(name)) {
    return { status: 400, body: { error: "invalid_role_name" } };
  }
  if (name === ADMIN_ROLE) {
    return { status: 400, body: { error: "cannot_modify_admin_role" } };
  }
  const perms = Array.isArray(permissions) ? permissions : [];
  const bad = invalidKeys(perms);
  if (bad.length) return { status: 400, body: { error: "unknown_permission_keys", keys: bad } };
  const swallow = adminSwallowingWildcards(perms);
  if (swallow.length) {
    return { status: 400, body: { error: "wildcard_would_grant_admin", keys: swallow,
                                  hint: "use role:admin to grant administration" } };
  }
  await putRole(name, perms);
  return { status: 200, body: { name, permissions: perms } };
}

/** 删角色。role:admin 不可删；被引用则 409（需求 4.5）。 */
export async function apiDeleteRole(name) {
  if (name === ADMIN_ROLE) return { status: 400, body: { error: "cannot_delete_admin_role" } };
  const inUse = await countUsersWithRole(name);
  if (inUse > 0) return { status: 409, body: { error: "role_in_use", users: inUse } };
  await deleteRole(name);
  return { status: 200, body: { ok: true } };
}

/* ───────────────── 用户 ───────────────── */

/** 列 Cognito 用户 + 合并其 roles/denies。 */
export async function apiListUsers() {
  const perms = await listUserPerms();
  const bySub = new Map(perms.map((p) => [p.sub, p]));
  const users = [];
  let token;
  do {
    const r = await cognito.send(new ListUsersCommand({
      UserPoolId: USER_POOL_ID, Limit: 60, PaginationToken: token,
    }));
    for (const u of r.Users || []) {
      const sub = (u.Attributes || []).find((a) => a.Name === "sub")?.Value || u.Username;
      const p = bySub.get(sub) || { roles: [], denies: [] };
      users.push({
        username: u.Username,
        sub,
        enabled: u.Enabled,
        status: u.UserStatus,
        roles: p.roles || [],
        denies: p.denies || [],
      });
    }
    token = r.PaginationToken;
  } while (token);
  return users;
}

/** 生成满足密码策略（min8/大写/小写/数字，无需符号）的临时密码。 */
function genTempPassword() {
  return "Aa1" + randomBytes(6).toString("hex"); // 含大写A/小写a/数字1 + 12位hex，长度15
}

/**
 * 创建 Cognito 用户（AdminCreateUser）。username 必填、email 选填。
 * 自动生成临时密码，MessageAction=SUPPRESS 不发邮件；用户首次登录强制改密。
 * @returns {status, body:{username, email?, tempPassword}}
 */
export async function apiCreateUser({ username, email } = {}) {
  const u = (username || "").trim();
  if (!u || !/^[A-Za-z0-9._@+-]{1,128}$/.test(u)) {
    return { status: 400, body: { error: "invalid_username" } };
  }
  const tempPassword = genTempPassword();
  const attrs = [];
  if (email && email.trim()) {
    attrs.push({ Name: "email", Value: email.trim() });
    attrs.push({ Name: "email_verified", Value: "true" }); // 免二次验证（autoVerify email 已开）
  }
  try {
    await cognito.send(new AdminCreateUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: u,
      TemporaryPassword: tempPassword,
      MessageAction: "SUPPRESS",
      ...(attrs.length ? { UserAttributes: attrs } : {}),
    }));
    return { status: 200, body: { username: u, email: email || "", tempPassword } };
  } catch (e) {
    const name = e?.name || "error";
    if (name === "UsernameExistsException") return { status: 409, body: { error: "user_exists" } };
    return { status: 400, body: { error: name } };
  }
}

/** 删除 Cognito 用户 + 清理其权限记录。末位 admin 保护由前端 + putUser 覆盖；此处不允许删自己。 */
export async function apiDeleteUser(username, sub, currentUsername) {
  const u = (username || "").trim();
  if (!u) return { status: 400, body: { error: "invalid_username" } };
  if (currentUsername && u === currentUsername) {
    return { status: 409, body: { error: "cannot_delete_self" } };
  }
  try {
    await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: u }));
    if (sub) await deleteUserPerm(sub);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    return { status: 400, body: { error: e?.name || "error" } };
  }
}

/**
 * 写用户 roles/denies。末位 admin 保护（需求 5.4）：
 * 若此次变更会导致系统中 role:admin 持有者归零 → 409。
 * @param currentSub 发起操作者的 sub（阻止自我降权为最后 admin）
 */
export async function apiPutUser(sub, { roles = [], denies = [] } = {}, currentSub = null) {
  const before = await getUserPerm(sub);
  const hadAdmin = (before?.roles || []).includes(ADMIN_ROLE);
  const willHaveAdmin = (roles || []).includes(ADMIN_ROLE);

  if (hadAdmin && !willHaveAdmin) {
    const totalAdmins = await countUsersWithRole(ADMIN_ROLE);
    // 该用户当前算 1 个 admin；移除后剩 totalAdmins-1
    if (totalAdmins <= 1) {
      return { status: 409, body: { error: "cannot_remove_last_admin" } };
    }
    if (currentSub && currentSub === sub) {
      return { status: 409, body: { error: "cannot_self_demote_admin" } };
    }
  }
  await putUserPerm(sub, { roles, denies });
  return { status: 200, body: { sub, roles, denies } };
}

/* ───────────────── 组→角色映射（Option B）───────────────── */

/** 列出 Cognito groups + 各自映射到的角色（合并 groupmap 存储）。 */
export async function apiListGroups() {
  const maps = await listGroupMaps();
  const byName = new Map(maps.map((m) => [m.groupName, m.roles]));
  const groups = [];
  let token;
  do {
    const r = await cognito.send(new ListGroupsCommand({ UserPoolId: USER_POOL_ID, Limit: 60, NextToken: token }));
    for (const g of r.Groups || []) {
      const stored = byName.has(g.GroupName) ? byName.get(g.GroupName) : null;
      const roles = stored !== null ? stored : (DEFAULT_GROUP_ROLE_MAP[g.GroupName] || []);
      groups.push({ name: g.GroupName, description: g.Description || "", roles });
    }
    token = r.NextToken;
  } while (token);
  return groups;
}

/** 写某 group → 角色映射。校验角色名存在（预置或 DDB）。 */
export async function apiPutGroupMap(groupName, roles) {
  if (!groupName) return { status: 400, body: { error: "invalid_group" } };
  const list = Array.isArray(roles) ? roles : [];
  const known = new Set([...Object.keys(PRESET_ROLES), ...(await storeListRoles()).map((r) => r.name)]);
  const bad = list.filter((rn) => !known.has(rn));
  if (bad.length) return { status: 400, body: { error: "unknown_roles", roles: bad } };
  await putGroupMap(groupName, list);
  return { status: 200, body: { groupName, roles: list } };
}

const PROTECTED_GROUPS = new Set(["admin", "member"]);

/** 创建 Cognito 组（实时写 Cognito）。 */
export async function apiCreateGroup(name, description) {
  const g = (name || "").trim();
  if (!g || !/^[A-Za-z0-9._-]{1,128}$/.test(g)) return { status: 400, body: { error: "invalid_group_name" } };
  try {
    await cognito.send(new CreateGroupCommand({
      UserPoolId: USER_POOL_ID, GroupName: g, ...(description ? { Description: description } : {}),
    }));
    return { status: 200, body: { name: g } };
  } catch (e) {
    if (e?.name === "GroupExistsException") return { status: 409, body: { error: "group_exists" } };
    return { status: 400, body: { error: e?.name || "error" } };
  }
}

/** 删除 Cognito 组 + 清理映射。保护 admin/member 不可删。 */
export async function apiDeleteGroup(name) {
  const g = (name || "").trim();
  if (PROTECTED_GROUPS.has(g)) return { status: 400, body: { error: "protected_group" } };
  try {
    await cognito.send(new DeleteGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: g }));
    await deleteGroupMap(g);
    return { status: 200, body: { ok: true } };
  } catch (e) {
    return { status: 400, body: { error: e?.name || "error" } };
  }
}

/** 列出某组的成员用户名。 */
export async function apiListGroupMembers(group) {
  const g = (group || "").trim();
  if (!g) return { status: 400, body: { error: "invalid_group" } };
  const members = [];
  let token;
  try {
    do {
      const r = await cognito.send(new ListUsersInGroupCommand({ UserPoolId: USER_POOL_ID, GroupName: g, Limit: 60, NextToken: token }));
      for (const u of r.Users || []) members.push(u.Username);
      token = r.NextToken;
    } while (token);
    return { status: 200, body: { group: g, members } };
  } catch (e) {
    return { status: 400, body: { error: e?.name || "error" } };
  }
}

/** 把用户加入组（实时写 Cognito）。 */
export async function apiAddUserToGroup(username, group) {
  const u = (username || "").trim(); const g = (group || "").trim();
  if (!u || !g) return { status: 400, body: { error: "invalid_args" } };
  try {
    await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId: USER_POOL_ID, Username: u, GroupName: g }));
    return { status: 200, body: { ok: true } };
  } catch (e) { return { status: 400, body: { error: e?.name || "error" } }; }
}

/** 把用户移出组（实时写 Cognito）。 */
export async function apiRemoveUserFromGroup(username, group) {
  const u = (username || "").trim(); const g = (group || "").trim();
  if (!u || !g) return { status: 400, body: { error: "invalid_args" } };
  try {
    await cognito.send(new AdminRemoveUserFromGroupCommand({ UserPoolId: USER_POOL_ID, Username: u, GroupName: g }));
    return { status: 200, body: { ok: true } };
  } catch (e) { return { status: 400, body: { error: e?.name || "error" } }; }
}

/* ───────────────── 模块开关 ───────────────── */

/** 可开关的顶层模块（tab 级，排除 chat/admin 恒开）。 */
export async function apiGetModules() {
  const disabled = await getDisabledModules();
  const toggleable = allNodes()
    .filter((n) => n.level === "tab" && !n.alwaysOn && !n.adminOnly)
    .map((n) => ({ key: n.key, title_zh: n.title_zh, title_en: n.title_en, disabled: disabled.includes(n.key) }));
  return { disabled, toggleable };
}

/** 写模块开关。只接受合法的可开关 tab key。 */
export async function apiPutModules(disabled) {
  const valid = new Set(
    allNodes().filter((n) => n.level === "tab" && !n.alwaysOn && !n.adminOnly).map((n) => n.key),
  );
  const clean = (Array.isArray(disabled) ? disabled : []).filter((k) => valid.has(k));
  await putDisabledModules(clean);
  return { status: 200, body: { disabled: clean } };
}

/* ── EOL/生命周期人工覆盖 ── */

/** 返回内置兜底表 + admin 覆盖（供 Admin「生命周期」子页展示与编辑）。 */
export async function apiGetEol() {
  const [overrides, table] = await Promise.all([getEolOverrides(), Promise.resolve(getEolTable())]);
  return { overrides, table };
}

/** 写 EOL 覆盖。校验：{service:{versionKey:"YYYY-MM-DD"}}，非法日期丢弃，空服务清理。 */
export async function apiPutEol(overrides) {
  const clean = {};
  for (const [svc, vers] of Object.entries(overrides || {})) {
    if (!vers || typeof vers !== "object") continue;
    const bucket = {};
    for (const [v, d] of Object.entries(vers)) {
      if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d).getTime())) bucket[v] = d;
    }
    if (Object.keys(bucket).length) clean[svc] = bucket;
  }
  await putEolOverrides(clean);
  return { status: 200, body: { overrides: clean } };
}
