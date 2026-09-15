/**
 * Capability Registry 加载器（BFF 侧）。
 *
 * 读取 config/capabilities.json（Lambda 构建时由 setup.sh 复制进本目录 ——
 * 打包策略见 setup.sh 里那一步的注释），构建三类索引供 authz / 渲染 /
 * 过滤消费：
 *   - matchRoute(method, path, query, body) → 命中的 Capability_Node（含所需 permissionKey）
 *   - subtabsOf(tabKey)                     → 该 tab 下带 responseKey 的 subtab（response-side 过滤用）
 *   - rootTabOf(key)                        → 某 key 的顶层 tab key（模块开关判定用）
 *   - allNodes / byKey                      → 供 /api/me/capabilities 过滤与前端下发
 *
 * 纯函数式、无副作用、无第三方依赖（对齐 BFF 其余 mjs）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 优先读同目录（Lambda 打包后），本地开发回退到 repo 根的 config/。
function loadRaw() {
  const candidates = [
    join(__dirname, "capabilities.json"),
    join(__dirname, "..", "..", "config", "capabilities.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      /* try next */
    }
  }
  throw new Error("capabilities.json not found in " + candidates.join(", "));
}

const doc = loadRaw();
const NODES = Array.isArray(doc) ? doc : doc.nodes || [];

const byKey = new Map();
for (const n of NODES) byKey.set(n.key, n);

/** 编译每条 route 的 pattern 为 RegExp（后缀匹配，对齐 index.mjs 的 endsWith/exec 习惯）。 */
const COMPILED = [];
for (const node of NODES) {
  for (const r of node.routes || []) {
    COMPILED.push({
      node,
      method: (r.method || "GET").toUpperCase(),
      re: new RegExp(r.pattern),
      queryMatch: r.queryMatch || null,
      bodyMatch: r.bodyMatch || null,
    });
  }
}

function queryOk(rule, query) {
  if (!rule.queryMatch) return true;
  const q = query || {};
  return Object.entries(rule.queryMatch).every(([k, v]) => (q[k] || "") === v);
}
function bodyOk(rule, body) {
  if (!rule.bodyMatch) return true;
  const b = body || {};
  const resolve = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
  return Object.entries(rule.bodyMatch).every(([k, v]) => resolve(b, k) === v);
}

/**
 * 反查请求对应的 Capability_Node。带 queryMatch/bodyMatch 的规则优先于不带的，
 * 避免 /actions/execute（bodyMatch）被某个宽松规则误命中。
 * @returns {object|null}
 */
export function matchRoute(method, path, query, body) {
  const m = (method || "GET").toUpperCase();
  const cands = COMPILED.filter((c) => c.method === m && c.re.test(path));
  if (cands.length === 0) return null;
  // 具体优先：有 query/body 约束的排前面
  cands.sort((a, b) => {
    const sa = (a.queryMatch ? 1 : 0) + (a.bodyMatch ? 1 : 0);
    const sb = (b.queryMatch ? 1 : 0) + (b.bodyMatch ? 1 : 0);
    return sb - sa;
  });
  for (const c of cands) {
    if (queryOk(c, query) && bodyOk(c, body)) return c.node;
  }
  // 命中路径但 query/body 不匹配任何具体规则 → 视为未授权路由（fail-closed 交给调用方）
  return null;
}

/** 某 key 的顶层 tab key（沿 parent 上溯）。 */
export function rootTabOf(key) {
  let cur = byKey.get(key);
  while (cur && cur.parent) cur = byKey.get(cur.parent);
  return cur ? cur.key : null;
}

/** 某 tab 下带 responseKey 的直接 subtab（response-side 过滤用）。 */
export function subtabsOf(tabKey) {
  // 递归收集该 tab 下所有带 responseKey 的后代（支持分组节点嵌套：卡片可挂在 group 下）
  const out = [];
  const walk = (parent) => {
    for (const n of NODES) {
      if (n.parent === parent) {
        if (n.responseKey) out.push(n);
        walk(n.key);
      }
    }
  };
  walk(tabKey);
  return out;
}

/**
 * 可被 Admin「模块」页开关的顶层 tab。
 *
 * 排除三类：
 *   - `alwaysOn`（nav:chat）—— 关掉它等于关掉整个产品；
 *   - `adminOnly`（nav:admin）—— 关掉它就再也打不开这一页去开回来；
 *   - `moduleToggle: false` —— 「是个 tab，但不是客户眼里的一个模块」。今天只有
 *     `nav:security`：它已经不在侧栏里，只是「运行概览」下的一颗看板胶囊。
 *
 * ⚠️ 这三类的语义**互不相同**，别用 `alwaysOn` 去实现第三类：`alwaysOn` 在
 *    authorize() 里是「任何登录用户放行」，那会把安全看板放给 viewer。
 */
export function toggleableTabs() {
  return NODES.filter((n) => n.level === "tab" && !n.alwaysOn && !n.adminOnly && n.moduleToggle !== false);
}

/**
 * 该 key 是否**显式声明**了不参与模块开关（`moduleToggle: false`）。
 *
 * 🔴 authz 侧必须用它把存量 disabled 记录里的这类 key 剔掉，否则会留下一个**改不回来**
 *    的状态：某个管理员在 2026-09-12 之前关掉了「安全」→ `tenantcfg#modules` 里躺着
 *    `nav:security` → 开关行没了 → 界面上再也没有地方把它打开，而看板永久隐身、
 *    没有任何提示。宁可让它恢复显示（权限门禁 nav:security 照旧管着谁能看）。
 *
 * ⚠️ 只剔这一类，**不**剔 alwaysOn / adminOnly：那两类同样不可写入，但「模块开关优先于
 *    个人权限（含 admin）」是一条被测试钉住的既有顺序语义（authz.test.mjs 用
 *    `disabledModules:["nav:admin"]` 守它），这次改动不该顺手动它。
 */
export function isModuleToggleOptOut(key) {
  const n = byKey.get(key);
  return !!n && n.moduleToggle === false;
}

/** 全部节点（供 /api/me/capabilities 过滤 + 前端下发）。 */
export function allNodes() {
  return NODES;
}
export function getNode(key) {
  return byKey.get(key) || null;
}
