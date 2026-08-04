/**
 * 授权核心（BFF 安全边界）。
 *
 *   - PRESET_ROLES         预置角色定义（seed 用，需求 7.1）
 *   - effective(...)       计算用户生效权限 {grants, denies}
 *   - satisfies(eff, key)  判定是否满足某 permissionKey（deny 优先、* 短路、:* 前缀通配）
 *   - authorize(...)       请求级门禁：路由→node→模块开关→satisfies；fail-closed
 *   - filterDashboard(...) dashboard 单次返回的 response-side subtab 过滤
 *   - visibleTree(...)     计算某用户可见能力子树（/api/me/capabilities 用）
 *
 * effective/satisfies 同时被 authorize 与 visibleTree 复用，避免前后端判定漂移（需求 3.4）。
 */
import { matchRoute, subtabsOf, rootTabOf, allNodes, getNode } from "./capabilities.mjs";
import { getUserPerm, getRole, getDisabledModules, getGroupMap } from "./rbac_store.mjs";

/** 预置角色（需求 7.1）。key 为角色名，值为 permissions 数组。 */
export const PRESET_ROLES = {
  "role:admin": ["*"],
  "role:finops": ["nav:chat", "nav:notifications", "nav:finops:*"],
  "role:support": ["nav:chat", "nav:notifications", "nav:investigate", "nav:cases:*", "action:cases:*"],
  "role:service-manager": [
    "nav:chat",
    "nav:cases:overview", "nav:cases:waiting", "nav:cases:incidents", "nav:cases:sla",
  ],
  "role:developer": ["nav:chat", "nav:skills", "action:skills:*"],
  "role:viewer": [
    "nav:chat", "nav:notifications",
    "nav:finops:*",
    "nav:cases:overview", "nav:cases:waiting", "nav:cases:incidents", "nav:cases:sla",
  ],
};

/**
 * 默认 Cognito 组 → 角色映射（代码内置兜底）。
 * 管理员在「组映射」页保存后写入 DDB，DDB 记录优先于此默认（see effective/apiListGroups）。
 * setup.sh/CDK 预建同名 Cognito 组（见 notiops-backend-stack CfnUserPoolGroup）。
 */
export const DEFAULT_GROUP_ROLE_MAP = {
  "admin": ["role:admin"],
  "member": ["role:viewer"],
  "finops-team": ["role:finops"],
  "sre-ops": ["role:support"],
  "support-lead": ["role:support"],
  "service-manager": ["role:service-manager"],
  "read-only": ["role:viewer"],
  "dev-team": ["role:developer"],
};

/** 登录即可访问、无需功能级权限的路由（需求 2.7）。path 后缀匹配。 */
const LOGIN_ONLY = [
  /\/conversations$/,
  /\/conversations\/[^/]+$/,
  /\/accounts$/,
  /\/me\/capabilities$/,
];

function isLoginOnly(path) {
  return LOGIN_ONLY.some((re) => re.test(path));
}

/** 前缀通配匹配：p 命中 key（p===key，或 p 以 ":*" 结尾且 key 落在其子树）。 */
export function matchesAny(patterns, key) {
  for (const p of patterns || []) {
    if (p === "*") return true;
    if (p === key) return true;
    if (p.endsWith(":*")) {
      const base = p.slice(0, -2); // 去掉 ":*"
      if (key === base || key.startsWith(base + ":")) return true;
    }
  }
  return false;
}

/** deny 优先 → * 短路 → grants 通配匹配。 */
export function satisfies(eff, key) {
  if (matchesAny(eff.denies, key)) return false;
  if ((eff.grants || []).includes("*")) return true;
  return matchesAny(eff.grants, key);
}

/** 解析角色名 → 权限数组（预置角色用内存 PRESET_ROLES，其余查 DDB）。 */
async function rolePerms(roleName) {
  // DDB 里存的角色定义(含 admin 在 UI 编辑/自定义的)优先；仅当该角色从未落库时，
  // 才用内存 PRESET_ROLES 兜底。此前顺序相反 → 编辑预置角色(role:finops 等)不生效(事故根因)。
  const stored = await getRole(roleName);
  if (stored) return stored.permissions || []; // 记录存在即以其为准(含被编辑为精简权限)
  return PRESET_ROLES[roleName] || [];
}

/**
 * 计算用户生效权限（并集模型）。
 *   grants = (逐人分配角色的权限)  ∪  (cognito group 映射到的角色权限)
 *   denies = 用户记录里的 denies（deny 优先）
 * admin group 兜底：属 cognito "admin" group → 直接授予 "*"（保证首次部署 admin 可用，需求 5.5）。
 * 用户无 userperm 记录时，仍可通过 group 映射获得权限（Option B 核心）。
 */
export async function effective(sub, cognitoGroups = []) {
  const grants = new Set();
  let denies = [];

  const rec = await getUserPerm(sub);
  if (rec) {
    for (const roleName of rec.roles || []) {
      for (const p of await rolePerms(roleName)) grants.add(p);
    }
    denies = rec.denies || [];
  }

  // group → role 映射（并集，无论是否有 userperm 记录）。
  // DDB 有记录用记录（含显式空数组=清空）；无记录用代码内置默认映射兜底。
  for (const g of cognitoGroups || []) {
    const stored = await getGroupMap(g);
    const mappedRoles = stored !== null ? stored : (DEFAULT_GROUP_ROLE_MAP[g] || []);
    for (const roleName of mappedRoles) {
      for (const p of await rolePerms(roleName)) grants.add(p);
    }
  }

  // admin group 兜底（首次部署 admin 加入 admin group 即全权限）
  if ((cognitoGroups || []).includes("admin")) grants.add("*");

  return { grants: [...grants], denies };
}

/**
 * 请求级授权。
 * @returns {Promise<{allow:boolean, status?:number, required?:string}>}
 */
export async function authorize({ method, path, query, body }, eff, { disabledModules = null } = {}) {
  if (isLoginOnly(path)) return { allow: true };
  const node = matchRoute(method, path, query, body);
  if (!node) return { allow: false, status: 403, required: "unknown_route" }; // fail-closed（需求 2.8）

  // alwaysOn 节点（chat）：任何登录用户放行（需求 schema alwaysOn）
  if (node.alwaysOn) return { allow: true };

  // 模块开关优先（需求 2.6）：node 所属顶层 tab 被关 → 拒绝
  const rootTab = rootTabOf(node.key);
  const disabled = disabledModules || (await getDisabledModules());
  if (rootTab && disabled.includes(rootTab)) {
    return { allow: false, status: 403, required: node.key };
  }
  if (satisfies(eff, node.key)) return { allow: true };
  // filtered-dashboard tab 兜底：用户有该 tab 下任一子页权限即放行。
  // 侧栏 visibleTree 只要有子页可见就显示该 tab，端点须与之一致，否则用户点开 tab 报 403。
  // 安全性：这些 tab 端点响应均经 filterDashboard 按子页裁剪 / org-summary 按账号可见性过滤，零越权泄漏。
  const subs = subtabsOf(node.key);
  if (subs.length && subs.some((s) => satisfies(eff, s.key))) return { allow: true };
  return { allow: false, status: 403, required: node.key };
}

/**
 * dashboard 单次返回的 response-side subtab 过滤（需求 2.9）。
 * 删除用户无权 subtab 的 responseKey 字段；无 responseKey 的元数据字段保留。
 */
export function filterDashboard(tabKey, payload, eff) {
  if (!payload || typeof payload !== "object") return payload;
  const deletePath = (obj, path) => {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur == null || typeof cur !== "object") return;
      cur = cur[parts[i]];
    }
    if (cur && typeof cur === "object") delete cur[parts[parts.length - 1]];
  };
  for (const node of subtabsOf(tabKey)) {
    if (satisfies(eff, node.key)) continue;
    const keys = Array.isArray(node.responseKey) ? node.responseKey : [node.responseKey];
    for (const k of keys) if (k) deletePath(payload, k); // 支持嵌套(costExplorer.anomalies)按卡剥离
  }
  return payload;
}

/**
 * 计算用户可见能力子树（/api/me/capabilities）。
 * 规则：alwaysOn 恒可见；adminOnly 需满足 nav:admin；其余按 satisfies；
 * 被 disabled 模块整棵剔除；父节点不可见则其后代不下发。
 * @returns {Promise<Array>} 扁平节点数组（含层级字段），前端自行按 parent 组树。
 */
export async function visibleTree(eff, { disabledModules = null } = {}) {
  const disabled = disabledModules || (await getDisabledModules());
  const nodes = allNodes();
  const visibleKeys = new Set();

  const isVisible = (node) => {
    const rootTab = rootTabOf(node.key);
    if (rootTab && disabled.includes(rootTab)) return false;
    if (node.alwaysOn) return true;
    if (node.adminOnly) return satisfies(eff, "nav:admin");
    return satisfies(eff, node.key);
  };

  for (const node of nodes) {
    if (isVisible(node)) visibleKeys.add(node.key);
  }
  // 祖先补全：若某节点可见(如被授权的 deep-dive 场景)，其父/祖先容器也应可见，
  // 否则下面的父过滤会把它剔除(表现为"授权了子项却看不到")。模块开关关闭的 tab 不补。
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  for (const key of [...visibleKeys]) {
    let cur = byKey.get(key);
    while (cur && cur.parent) {
      const parent = byKey.get(cur.parent);
      if (!parent) break;
      const rootTab = rootTabOf(parent.key);
      if (rootTab && disabled.includes(rootTab)) break; // 模块被关 → 不补该路径
      visibleKeys.add(parent.key);
      cur = parent;
    }
  }
  // 父不可见则剔除后代（保持子树完整性）
  const out = [];
  for (const node of nodes) {
    if (!visibleKeys.has(node.key)) continue;
    if (node.parent && !visibleKeys.has(node.parent)) continue;
    out.push({
      key: node.key, level: node.level, parent: node.parent || null,
      viewState: node.viewState || null,
      title_zh: node.title_zh, title_en: node.title_en,
    });
  }
  return out;
}

export { getNode };
