/**
 * 授权核心（BFF 安全边界）。
 *
 *   - PRESET_ROLES         预置角色定义（seed 用）
 *   - effective(...)       计算用户生效权限 {grants, denies}
 *   - satisfies(eff, key)  判定是否满足某 permissionKey（deny 优先、* 短路、:* 前缀通配）
 *   - authorize(...)       请求级门禁：路由→node→模块开关→satisfies；fail-closed
 *   - filterDashboard(...) dashboard 单次返回的 response-side subtab 过滤
 *   - visibleTree(...)     计算某用户可见能力子树（/api/me/capabilities 用）
 *
 * effective/satisfies 同时被 authorize 与 visibleTree 复用，避免前后端判定漂移。
 */
import { matchRoute, subtabsOf, rootTabOf, allNodes, getNode } from "./capabilities.mjs";
import { getUserPerm, getRole, getDisabledModules, getGroupMap } from "./rbac_store.mjs";

/** 预置角色。key 为角色名，值为 permissions 数组。 */
export const PRESET_ROLES = {
  "role:admin": ["*"],
  // 巡检的闲置/成本页是 finops 的直接工作面（可删可降配 + savings 估算）。
  // ⚠️ `nav:inspection:*` 的 `key === base` 分支会同时覆盖 tab 本身
  //    （见 matchesAny），所以不需要再单列 `nav:inspection`。
  "role:finops": ["nav:chat", "nav:notifications", "nav:finops:*", "nav:inspection:*"],
  // ⚠️ 巡检看板给 support 与 finops 两个角色：高负载/结构性是可靠性视角（support），
  //    闲置/成本是成本视角（finops）。只给一个会让另一半人看不到本该他们看的页。
  "role:support": ["nav:chat", "nav:notifications", "nav:investigate", "nav:cases:*", "action:cases:*", "nav:inspection:*"],
  "role:service-manager": [
    "nav:chat",
    "nav:cases:overview", "nav:cases:waiting", "nav:cases:incidents", "nav:cases:sla",
  ],
  "role:developer": ["nav:chat", "nav:skills", "action:skills:*"],
  "role:viewer": [
    "nav:chat", "nav:notifications",
    "nav:finops:*",
    // 只读角色 —— 巡检看板的六个端点全是只读，给它不引入任何写能力。
    //
    // ⚠️ `nav:inspection:*` **不会**顺带给到 `action:inspection:scope` /
    //    `action:inspection:schedule`：`matchesAny` 的前缀通配比的是
    //    `nav:inspection:`，而那两个 key 的前缀是 `action:inspection:`。
    //    两个写端点的能力节点是 level=action 且**没有子节点**，所以
    //    `authorize` 的 subtab 兜底（subs.length && …）也够不到它们。
    //
    // 🔴 三个预置角色（finops / support / viewer）**都不含**写能力 ——
    //    写入至今只有 `role:admin` 的 `*` 能满足。这是刻意的：排除清单直接
    //    决定巡检覆盖面，而「把生产库摘出巡检范围」没有任何运行时信号。
    //    要放开就在「角色」页给具体角色显式加 `action:inspection:scope`，
    //    别加进这里 —— 预置角色是所有部署的默认值，收紧比放开难得多。
    "nav:inspection:*",
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
 * 登录即可访问、无需功能级权限的路由。
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
  // 深度调查可用性：只回 {available, reason}（无 Agent Space id / 无账号清单），
  // 任何能看到输入框的用户都要用它决定「深度调查」开关是否置灰。
  /\/features\/deep-investigation$/,
];

function isLoginOnly(path) {
  return LOGIN_ONLY.some((re) => re.test(path));
}

/**
 * 能力节点声明的外部依赖（capabilities.json 的 `requiresEnv`）是否已配置。
 *
 * 用于「可选外部数据源」类能力：客户 CUR 四个 sheet 依赖 COST_AGENT_MCP_URL，
 * 客户没接这个数据源时，这些入口**不该出现在侧栏**（渲染出来再报"数据源未配置"
 * 等于把一个坏掉的界面交给用户）。
 *
 * 判据故意做严：值必须非空、且不是 `__FOO__` 形式的未替换占位符 —— CDK/部署脚本
 * 漏替换时应当表现为「功能不出现」，而不是「入口在、点了就崩」（不许静默降级）。
 * 支持多个依赖（数组或逗号分隔），全部满足才算配置好。
 */
export function envConfigured(requiresEnv, env = process.env) {
  if (!requiresEnv) return true;
  const names = Array.isArray(requiresEnv) ? requiresEnv : String(requiresEnv).split(",");
  return names.every((raw) => {
    const name = raw.trim();
    if (!name) return true;
    const v = (env[name] || "").trim();
    if (!v) return false;
    return !(v.startsWith("__") && v.endsWith("__"));
  });
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
 * admin group 兜底：属 cognito "admin" group → 直接授予 "*"（保证首次部署 admin 可用）。
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
    return { allow: false, status: 403, required: "unknown_route" }; // fail-closed
  }

  // alwaysOn 节点（chat）：任何登录用户放行（需求 schema alwaysOn）
  if (node.alwaysOn) return { allow: true };

  // 模块开关优先：node 所属顶层 tab 被关 → 拒绝
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
 * dashboard 单次返回的 response-side subtab 过滤。
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
    // 与 visibleTree 的 requiresEnv 门控同源：外部依赖没配 → 节点已从 /capabilities 树里
    // 摘掉，响应里也不该再带它的数据（否则不读 /capabilities 的客户端会画出一张死卡）。
    // 今天真实生效在 nav:finops:daily-anomaly（requiresEnv=COST_ANALYZER_FUNCTION 且带
    // responseKey）：一键部署没有 lambda5，dailyAnomaly 这一段就不进 payload。
    // 带 requiresEnv 的 4 个 CUR sheet 没有 responseKey（走各自 /cur-dash/* 路由，由
    // cur_dashboard.mjs 同一判据挡），所以这一条对它们是空转 —— 那是对的。
    if (envConfigured(node.requiresEnv) && satisfies(eff, node.key)) continue;
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
    // 依赖的外部数据源未配置 → 整个节点不下发（前端因此不渲染入口）。
    // 比"渲染了入口、点进去空白/报错"强：那种半通的界面对用户就是坏体验。
    // 这一条压在 alwaysOn 之前：没有数据源时，「恒显示」也不该显示。
    if (!envConfigured(node.requiresEnv)) return false;
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
