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

/**
 * 登录即可访问、无需功能级权限的路由（需求 2.7）。
 *
 * ⚠️ 这些是**后缀**正则，而 index.mjs 的路由分发**也是**后缀匹配。两个后缀匹配器
 * 叠在一起意味着：一个路径可以同时满足这里的某条正则、又落到某个特权 handler 上。
 * 所以本清单**只在 `matchRoute()` 找不到能力节点时**才被查询（见 `authorize()`），
 * 绝不能反过来 —— 反过来就是特权路由被免鉴权清单遮蔽。
 *
 * 实际发生过：加入 `/\/models$/` 后，`DELETE /admin/roles/models`、
 * `DELETE /admin/groups/models`、`PUT /admin/users/models`、`DELETE /skills/models`
 * 全部对任意登录用户放行 —— 因为旧实现先查本清单就直接 return 了。
 * `$` 锚点只挡住路径**中段**匹配（`/models/admin/...`），对这种尾段碰撞无效；
 * 此处曾把这条理由写反，见 git history。
 */
const LOGIN_ONLY = [
  /\/conversations$/,
  /\/conversations\/[^/]+$/,
  /\/accounts$/,
  /\/me\/capabilities$/,
  // 可选模型清单：只返回 admin 已启用的模型（无 provider / 凭证 / 候选全集字段），
  // 任何登录用户都要用它渲染模型下拉（spec R6.2）。
  /\/models$/,
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

/** adminOnly 节点的判定：**通配不得跨界**，grant 必须显式点名 admin（或全局 `*`）。
 *
 * 为什么不能直接用 `satisfies(eff, "nav:admin")`：`nav:*` 的字面意思是「所有导航页」，
 * 但按前缀通配规则它会命中 `nav:admin`，于是拿到 `nav:*` 的人得到整个 `/admin/.+`
 * —— 包括改模型目录、写 Bedrock API Key，以及 `PUT /admin/users/:id/permissions`
 * （即可给自己改成 `*`，完整提权）。
 *
 * 而权限选择器**特意过滤掉 adminOnly 节点**（admin.mjs 的 assignableTabs / allTabKeys），
 * 也就是说「admin 不作为一个可授予的 nav 权限」本就是设计意图；`nav:finops:*` 这类写法
 * 又是预置角色里的既有惯用法，管理员照着扩成 `nav:*` 表达"所有页面"非常自然。两者相撞
 * 就是一个看起来安全的提权动作。这里把判定收紧到「显式点名」，其余通配语义不变。
 *
 * deny 一侧**保持宽匹配**（`denies:["nav:*"]` 仍能否决 admin）：拒绝宁可过宽。
 */
export function satisfiesAdmin(eff) {
  if (matchesAny(eff.denies, "nav:admin")) return false;
  return ((eff && eff.grants) || []).some(
    (p) => p === "*" || p === "nav:admin" || p.startsWith("nav:admin:"));
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
  // 能力节点反查**必须先做**。LOGIN_ONLY 是后缀正则，只有在没有任何能力节点覆盖该
  // 请求时才有资格放行 —— 否则 `/admin/roles/models` 这类尾段碰撞会让免鉴权清单
  // 遮蔽掉特权路由（见 LOGIN_ONLY 上方注释里的实际案例）。
  const node = matchRoute(method, path, query, body);
  if (!node) {
    if (isLoginOnly(path)) return { allow: true };
    return { allow: false, status: 403, required: "unknown_route" }; // fail-closed（需求 2.8）
  }

  // alwaysOn 节点（chat）：任何登录用户放行（需求 schema alwaysOn）
  if (node.alwaysOn) return { allow: true };

  // 模块开关优先（需求 2.6）：node 所属顶层 tab 被关 → 拒绝
  const rootTab = rootTabOf(node.key);
  const disabled = disabledModules || (await getDisabledModules());
  if (rootTab && disabled.includes(rootTab)) {
    return { allow: false, status: 403, required: node.key };
  }
  // adminOnly 节点单独判：通配派生的匹配不算，必须显式点名（见 satisfiesAdmin）。
  // 放在这里而不是塞进 satisfies()：只收紧 adminOnly 节点，不动其余通配语义。
  // 也不能落到下面的 subtab 兜底 —— nav:admin 没有子节点，落下去等于把判定绕开。
  if (node.adminOnly) {
    if (satisfiesAdmin(eff)) return { allow: true };
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
    // 与 authorize() 同源：侧栏若显示了 admin 但端点 403，用户点进去就是白屏 + 403。
    if (node.adminOnly) return satisfiesAdmin(eff);
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
