/**
 * 资源巡检看板的 BFF 侧测试（R10.10）。
 *
 * 三组：
 *   ① 键前缀与 Python 侧 `inspection/adapters/keys.py` **逐字一致**
 *   ② 六个路由都在 capabilities.json 登记、且各角色能看见
 *   ③ ★ 元断言：`index.mjs` 里**任何** endsWith 路由都必须能被 matchRoute 命中
 *      —— 这条守的是仓里此前完全真空的一类漏配
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { authorize, PRESET_ROLES, satisfies, visibleTree } from "../authz.mjs";
import { matchRoute } from "../capabilities.mjs";
import { FINDING_KINDS, worstRunAcross } from "../inspection.mjs";
import { PREFIX, allPrefixes, assertPrefixesDisjoint, SCHEDULE_PK, findingPk, runPk, scopePk, seriesPk, targetPk } from "../inspection_keys.mjs";
import {
  FIELDS as rlFIELDS, SERVICES as rlSERVICES, countFor as rlCountFor,
  describeRules as rlDescribeRules, serviceCatalog as rlServiceCatalog,
  normalizeOverrides as rlNormalizeOverrides, sectionsFor as rlSectionsFor,
  validateField as rlValidateField,
} from "../inspection_rule_limits.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

let pass = 0;
const fails = [];
const pending = [];

/**
 * ⚠️ **必须 await 异步用例**。第一版 `t()` 是同步的，于是所有 `async` 用例
 * 的断言失败变成 unhandled rejection —— 计数照样 +1，测试「通过」。
 * 本文件里 6 条 authorize 用例都是异步的，也就是说那一版**一条都没在验**。
 */
function t(name, fn) {
  let r;
  try { r = fn(); } catch (e) { fails.push(`${name}: ${e.message}`); return; }
  if (r && typeof r.then === "function") {
    pending.push(r.then(() => { pass += 1; },
      (e) => { fails.push(`${name}: ${e.message}`); }));
    return;
  }
  pass += 1;
}

// ---------------------------------------------------------------------------
// ① 键前缀与 Python 侧一致
// ---------------------------------------------------------------------------

t("prefixes are disjoint (mirror of keys.py::assert_prefixes_disjoint)", () => {
  assertPrefixesDisjoint();
  // ⚠️ 这个数字是**故意写死的绊线**：加前缀必须是一次有意识的动作。
  //    下面那条 verbatim 断言保证两侧一致，但它不会让你停下来想一想
  //    「这个前缀会不会被某个 begins_with 扫到」。
  assert.equal(allPrefixes().length, 13);
});

t("dispatch prefix is flat, not nested under inspfind#", () => {
  // 嵌套会让 begins_with("inspfind#") 把派发映射行一起扫进 finding 列表 ——
  // 看板上出现几条没有 severity、没有 state 的「幽灵 finding」。
  assert.equal(PREFIX.DISPATCH, "inspdispatch#");
  assert.ok(!PREFIX.DISPATCH.startsWith(PREFIX.FINDING));
});

t("★ prefixes match keys.py verbatim (no manual sync)", () => {
  // 直接读 Python 源正则提取，不靠人工同步。分叉的表现是**静默的**：
  // 看板按旧前缀查 → 永远空 → 不报错。
  const py = readFileSync(join(REPO, "inspection", "adapters", "keys.py"), "utf8");
  const found = [...py.matchAll(/^\s{4}[A-Z_]+ = "([a-z]+#)"$/gm)].map((m) => m[1]);
  assert.ok(found.length >= 11, `keys.py 只提取到 ${found.length} 个前缀，正则可能失配`);
  const mine = new Set(allPrefixes());
  const theirs = new Set(found);
  const missing = [...theirs].filter((p) => !mine.has(p));
  const extra = [...mine].filter((p) => !theirs.has(p));
  assert.deepEqual(missing, [], `Node 侧缺前缀: ${missing.join(", ")}`);
  assert.deepEqual(extra, [], `Node 侧多出前缀: ${extra.join(", ")}`);
});

t("key builders match the python shapes", () => {
  assert.equal(findingPk("123456789012"), "inspfind#123456789012");
  assert.equal(runPk("high", "2026-08-19"), "insprun#high#2026-08-19");
  assert.equal(seriesPk("1", "us-east-1", "rds", "db-1"),
    "inspseries#1#us-east-1#rds#db-1");
  assert.equal(scopePk("high"), "inspscope#high");
  assert.equal(targetPk("idle"), "insptarget#idle");
  assert.equal(SCHEDULE_PK, "inspsched#config");
});

t("scope/target reject anything other than high|idle", () => {
  // 拼错一个字母就会查一个永远空的 PK，而 UI 显示「没有排除项」
  for (const bad of ["High", "HIGH", "", "all", "both"]) {
    assert.throws(() => scopePk(bad), /high \/ idle/);
    assert.throws(() => targetPk(bad), /high \/ idle/);
  }
});

// ---------------------------------------------------------------------------
// ② 六个路由的门禁
// ---------------------------------------------------------------------------

/** tab 级路由：任何子页都要用的公共读取。 */
const TAB_ROUTES = [
  ["GET", "/api/chat/inspection/overview", {}],
  ["GET", "/api/chat/inspection/finding", {}],
  ["GET", "/api/chat/inspection/series", {}],
];

/** 按 kind 精确分权的三个列表子页（queryMatch）。 */
const KIND_ROUTES = [
  ["nav:inspection:high-load", "high_load"],
  ["nav:inspection:idle", "idle"],
  ["nav:inspection:structural", "structural"],
];

/** 自带 route 的两个配置类子页。 */
const SUBTAB_ROUTES = [
  ["nav:inspection:scope", "/api/chat/inspection/scope"],
  ["nav:inspection:config", "/api/chat/inspection/config"],
];

const ALL_ROUTES = [
  ...TAB_ROUTES,
  ...KIND_ROUTES.map(([, k]) => ["GET", "/api/chat/inspection/findings", { kind: k }]),
  ...SUBTAB_ROUTES.map(([, p]) => ["GET", p, {}]),
];

t("★ every inspection route resolves to a capability node", () => {
  // 没登记的路由对**所有人** 403 unknown_route（fail-closed）——
  // 表现是整个看板打不开，而不是静默放行。
  for (const [m, p, qq] of ALL_ROUTES) {
    const node = matchRoute(m, p, qq, {});
    assert.ok(node, `${m} ${p} ${JSON.stringify(qq)} 没有能力节点 → 全员 403`);
  }
});

t("★★ list pages are authorised per kind, not by the tab", () => {
  // 三个列表页的读者不同（高负载→support，闲置→finops），所以必须能分开授权。
  // ⚠️ 这依赖 tab 的 routes 里**没有** `/inspection/findings$`：
  //    tab 级 route 会遮蔽子页的 queryMatch（matchRoute 取首个命中节点），
  //    于是三页合成一个权限。
  for (const [key, kind] of KIND_ROUTES) {
    const node = matchRoute("GET", "/api/chat/inspection/findings", { kind }, {});
    assert.ok(node, `kind=${kind} 没有节点`);
    assert.equal(node.key, key, `kind=${kind} 落到了 ${node.key}`);
  }
});

t("kind must be one of the three known values", () => {
  // 未知 kind 没有节点 → 403。**这是要的**：静默回落到「全部」会让
  // 只有闲置权限的人通过 `?kind=wat` 看到高负载 finding。
  for (const bad of ["", "high", "trend", "all", "HIGH_LOAD"]) {
    const node = matchRoute("GET", "/api/chat/inspection/findings", { kind: bad }, {});
    assert.equal(node, null, `kind=${bad} 意外命中了 ${node && node.key}`);
  }
});

t("★ the kind keys match inspection.mjs verbatim", () => {
  // 两边分叉的表现：那一页对所有人 403 unknown_route。
  const declared = [...FINDING_KINDS].sort();
  const inCaps = KIND_ROUTES.map(([, k]) => k).sort();
  assert.deepEqual(declared, inCaps,
    `inspection.mjs 的 kind=${declared} 与 capabilities 的 ${inCaps} 不一致`);
});

t("every inspection route is denied without any capability", async () => {
  const eff = { grants: ["nav:chat"], denies: [] };
  for (const [m, p, qq] of ALL_ROUTES) {
    const r = await authorize({ method: m, path: p, query: qq, body: {} }, eff,
      { disabledModules: [] });
    assert.equal(r.allow, false, `${p} ${JSON.stringify(qq)} 在无权时被放行了`);
  }
});

t("the wildcard grant opens every inspection route", async () => {
  const eff = { grants: ["nav:inspection:*"], denies: [] };
  for (const [m, p, qq] of ALL_ROUTES) {
    const r = await authorize({ method: m, path: p, query: qq, body: {} }, eff,
      { disabledModules: [] });
    assert.equal(r.allow, true, `${p} ${JSON.stringify(qq)} 有通配权限时仍被拒`);
  }
});

t("★★ a list-page grant does NOT leak the other list pages", async () => {
  // 只授「闲置」的人不该看到高负载 finding。这条是按 kind 分权的**目的**。
  //
  // ⚠️ `matchRoute` 会按具体度排序（带 queryMatch 的排前面），所以即使
  //    tab 的 routes 里被加回 `/inspection/findings$`，带 kind 的请求仍走子页。
  //    真正的泄漏形态是**不带 kind** 的请求落到 tab 级门禁上 ——
  //    那一条由 `kind must be one of the three known values` 守，
  //    数据层的 `bad_kind` 是第二道。
  const eff = { grants: ["nav:inspection", "nav:inspection:idle"], denies: [] };
  const ok = await authorize({ method: "GET", path: "/api/chat/inspection/findings",
    query: { kind: "idle" }, body: {} }, eff, { disabledModules: [] });
  assert.equal(ok.allow, true, "自己那一页被拒了");
  const leak = await authorize({ method: "GET", path: "/api/chat/inspection/findings",
    query: { kind: "high_load" }, body: {} }, eff, { disabledModules: [] });
  assert.equal(leak.allow, false, "只授闲置的人看到了高负载 finding");
});

t("★ a responseKey subtab grant opens the tab endpoints (tab fallback)", async () => {
  // authorize 的 tab 兜底只对**带 responseKey** 的子页生效（subtabsOf 只收那些），
  // 而 visibleTree 的祖先补全会让任何可见子页把 tab 也显示出来。
  // ⇒ 无 responseKey 的子页会造成「侧栏看到入口、点进去 403」。
  //    这就是 `nav:inspection:high-load` 必须带 responseKey 的原因；
  //    第一版没带，实测确认了这个形态。
  for (const key of ["nav:inspection:overview", "nav:inspection:high-load"]) {
    const r = await authorize(
      { method: "GET", path: "/api/chat/inspection/overview", query: {}, body: {} },
      { grants: [key], denies: [] }, { disabledModules: [] });
    assert.equal(r.allow, true, `${key} 拿不到 tab 兜底 → 侧栏可见但点进去 403`);
  }
});

t("★ denying only the tab key is NOT enough (repo-wide semantics)", async () => {
  // 实测：`denies:["nav:inspection"]` + `grants:["*"]` 仍然放行 ——
  // 因为 tab 兜底会去看子页，而子页没被 deny。
  // finops / investigate 完全一样，这是本仓 authorize 的既有语义，不是巡检特有。
  // ⇒ 要真正关掉一个 tab，必须 deny `nav:xxx:*`（或用模块开关）。
  const tabOnly = await authorize(
    { method: "GET", path: "/api/chat/inspection/overview", query: {}, body: {} },
    { grants: ["*"], denies: ["nav:inspection"] }, { disabledModules: [] });
  assert.equal(tabOnly.allow, true, "语义变了 —— 请同步更新此处注释与运维文档");

  const withWildcard = await authorize(
    { method: "GET", path: "/api/chat/inspection/overview", query: {}, body: {} },
    { grants: ["*"], denies: ["nav:inspection", "nav:inspection:*"] },
    { disabledModules: [] });
  assert.equal(withWildcard.allow, false, "deny 通配没生效");
});

t("module switch can turn the whole tab off", async () => {
  // 模块开关是唯一「一刀切」的手段 —— 它在 satisfies 之前判，不走子页兜底。
  for (const [m, p, qq] of ALL_ROUTES) {
    const r = await authorize({ method: m, path: p, query: qq, body: {} },
      { grants: ["*"], denies: [] }, { disabledModules: ["nav:inspection"] });
    assert.equal(r.allow, false, `${p} 在模块被关时仍放行`);
  }
});

t("preset roles that should see the dashboard do", () => {
  // 高负载/结构性是可靠性视角（support），闲置/成本是成本视角（finops）。
  // 只给一个会让另一半人看不到本该他们看的页。
  for (const role of ["role:support", "role:finops", "role:viewer"]) {
    const eff = { grants: PRESET_ROLES[role], denies: [] };
    assert.ok(satisfies(eff, "nav:inspection"),
      `${role} 看不到巡检看板`);
    assert.ok(satisfies(eff, "nav:inspection:idle"),
      `${role} 看不到闲置子页`);
  }
});

t("roles without it stay without it", () => {
  for (const role of ["role:developer", "role:service-manager"]) {
    const eff = { grants: PRESET_ROLES[role], denies: [] };
    assert.equal(satisfies(eff, "nav:inspection"), false,
      `${role} 意外获得了巡检看板`);
  }
});

t("visibleTree exposes the inspection tab and its viewState", async () => {
  const eff = { grants: ["nav:inspection:*"], denies: [] };
  const tree = await visibleTree(eff, { disabledModules: [] });
  const tab = tree.find((n) => n.key === "nav:inspection");
  assert.ok(tab, "侧栏拿不到巡检 tab");
  // viewState 就是 ChatApp 的 view union 里那个字符串；不一致会让
  // 前端拿到能力却不知道该切到哪个视图。
  assert.equal(tab.viewState, "inspection");
  const subs = tree.filter((n) => n.parent === "nav:inspection");
  assert.ok(subs.length >= 6, `子页只可见 ${subs.length} 个`);
});

// ---------------------------------------------------------------------------
// ③ ★★ 元断言：index.mjs 的路由必须都在 capabilities 里有落点
// ---------------------------------------------------------------------------

t("★★ every endsWith route in index.mjs resolves to a capability node", () => {
  // 这条守的是仓里此前**完全真空**的一类漏配：加了路由但忘了登记
  // capabilities.json。运行时是 fail-closed（403 unknown_route），
  // 所以后果不是提权而是「功能上线即全员打不开」——
  // 而那通常要等到部署后才被发现。
  //
  // LOGIN_ONLY 白名单里的路由不需要能力节点（会话/账号/me-capabilities）。
  const LOGIN_ONLY_OK = [
    /\/conversations$/, /\/conversations\/[^/]+$/, /\/accounts$/,
    /\/me\/capabilities$/, /\/models$/,
  ];
  const src = readFileSync(join(HERE, "..", "index.mjs"), "utf8");
  const paths = new Set(
    [...src.matchAll(/path\.endsWith\("([^"]+)"\)/g)].map((m) => m[1]));
  assert.ok(paths.size > 40, `只提取到 ${paths.size} 条路由，正则可能失配`);

  // ⚠️ 判据是「**path pattern** 有没有登记」，不是 `matchRoute(m, p, {}, {})`。
  //    后者会把用 `queryMatch` / `bodyMatch` 按参数分权的路由误报成孤儿 ——
  //    `/finops/deep-dive`（scenario=cloudwatch|datatransfer|ec2|s3）与
  //    `/actions/execute`（action.type=create_case|…）都是那种形态：
  //    path 登记了，只是空 query/body 匹配不上任何一条。
  //    第一版断言就是这么误报的两条。
  const nodes = JSON.parse(
    readFileSync(join(REPO, "config", "capabilities.json"), "utf8")).nodes;
  const patterns = [];
  for (const n of nodes) {
    for (const r of n.routes || []) patterns.push(new RegExp(r.pattern));
  }

  const orphans = [];
  for (const p of paths) {
    if (LOGIN_ONLY_OK.some((re) => re.test(p))) continue;
    if (!patterns.some((re) => re.test(p))) orphans.push(p);
  }
  assert.deepEqual(orphans, [],
    `以下路由在 capabilities.json 里没有落点，上线后对所有人 403 unknown_route:\n  `
    + orphans.join("\n  "));
});

t("★ config/capabilities.json and the bff copy are byte-identical", () => {
  // `setup.sh` 会拷贝，但本地跑测试时读的是 bff 目录那份。
  // 两份分叉的表现：本地测试全绿而部署后 403（或反之）。
  const a = readFileSync(join(REPO, "config", "capabilities.json"), "utf8");
  const b = readFileSync(join(HERE, "..", "capabilities.json"), "utf8");
  assert.equal(a, b,
    "两份 capabilities.json 不一致 —— 跑 `cp config/capabilities.json bff/web-chat/`");
});

// ---------------------------------------------------------------------------



// ---------------------------------------------------------------------------
// ④ 写入路径
//
// 🔴 写入的能力**必须与看板分开**。搭在 `nav:inspection` 上意味着任何能看
// 看板的人都能把生产库从巡检范围里摘掉，而那个操作没有任何运行时信号 ——
// 下一轮就是少了那台，报告上不会写「有一台被排除了」。
// ---------------------------------------------------------------------------

const WRITE_ROUTES = [
  ["POST", "/api/chat/inspection/scope/high", "action:inspection:scope"],
  ["POST", "/api/chat/inspection/scope/idle", "action:inspection:scope"],
  ["POST", "/api/chat/inspection/scope/high/renew", "action:inspection:scope"],
  ["PUT", "/api/chat/inspection/schedule/high", "action:inspection:schedule"],
  ["PUT", "/api/chat/inspection/schedule/idle", "action:inspection:schedule"],
  ["PUT", "/api/chat/inspection/rules/high", "action:inspection:threshold"],
  ["PUT", "/api/chat/inspection/rules/idle", "action:inspection:threshold"],
];

t("★★ write routes resolve to action:* capabilities, not nav:inspection", () => {
  for (const [m, p, want] of WRITE_ROUTES) {
    const node = matchRoute(m, p, {}, {});
    assert.ok(node, `${m} ${p} 没有能力节点`);
    assert.equal(node.key, want, `${p} 落到了 ${node.key}`);
    assert.ok(node.key.startsWith("action:"),
      `${p} 的门禁是 ${node.key} —— 写操作必须走 action:*`);
  }
});

t("★★ read-only capability does NOT open the write routes", async () => {
  // 这条是整个分权设计的**目的**。
  const eff = { grants: ["nav:inspection:*"], denies: [] };
  for (const [m, p] of WRITE_ROUTES) {
    const r = await authorize({ method: m, path: p, query: {}, body: {} }, eff,
      { disabledModules: [] });
    assert.equal(r.allow, false,
      `只有看板权限的人能调 ${m} ${p} —— 他能把生产库摘出巡检范围`);
  }
});

t("★★ the schedule grant does NOT open the threshold route", async () => {
  // 🔴 改时刻只影响「什么时候跑」；改阈值直接改变「什么算风险」——
  //    调高一档就能让一批生产告警消失，而下一轮报告上不会写「阈值被改过」。
  //    且按 R6.9 配置变更会强制 resolve 全部旧 finding 并重新计数，
  //    也就是一次操作能改写整个看板。合并授权等于白送这个能力。
  const schedOnly = { grants: ["action:inspection:schedule"], denies: [] };
  const thrOnly = { grants: ["action:inspection:threshold"], denies: [] };
  const rulesReq = { method: "PUT", path: "/api/chat/inspection/rules/high",
    query: {}, body: {} };
  const schedReq = { method: "PUT", path: "/api/chat/inspection/schedule/high",
    query: {}, body: {} };
  assert.equal((await authorize(rulesReq, schedOnly, { disabledModules: [] })).allow,
    false, "能改定时的人顺带能改阈值了");
  assert.equal((await authorize(rulesReq, thrOnly, { disabledModules: [] })).allow, true);
  assert.equal((await authorize(schedReq, thrOnly, { disabledModules: [] })).allow,
    false, "能改阈值的人顺带能改定时了");
});

t("scope grant does not open the schedule route (and vice versa)", async () => {
  const scopeOnly = { grants: ["action:inspection:scope"], denies: [] };
  const schedOnly = { grants: ["action:inspection:schedule"], denies: [] };
  const scopeReq = { method: "POST", path: "/api/chat/inspection/scope/high",
    query: {}, body: {} };
  const schedReq = { method: "PUT", path: "/api/chat/inspection/schedule/high",
    query: {}, body: {} };
  assert.equal((await authorize(scopeReq, scopeOnly, { disabledModules: [] })).allow, true);
  assert.equal((await authorize(schedReq, scopeOnly, { disabledModules: [] })).allow, false);
  assert.equal((await authorize(schedReq, schedOnly, { disabledModules: [] })).allow, true);
  assert.equal((await authorize(scopeReq, schedOnly, { disabledModules: [] })).allow, false);
});

t("no preset role gets the write actions by default", () => {
  // 写操作要管理员显式授予。预置角色里塞进去等于「凡是能看的都能改」。
  for (const [role, perms] of Object.entries(PRESET_ROLES)) {
    if (role === "role:admin") continue;      // admin 是 "*"
    const eff = { grants: perms, denies: [] };
    for (const key of ["action:inspection:scope", "action:inspection:schedule"]) {
      assert.equal(satisfies(eff, key), false,
        `${role} 默认获得了 ${key}`);
    }
  }
});

// --- 输入校验 ---------------------------------------------------------------

const insp = await import("../inspection.mjs");

t("★ exclusion requires a level (cascade would silently break without it)", async () => {
  // Python 侧 `put_exclusion` 也拦这条：「勾中集群即排除其下全部成员」靠
  // level 判，缺了级联排除会**静默失效** —— UI 上集群是勾选状态，
  // 成员却照样出现在结果里。
  const r = await insp.putExclusion("high", {
    account_id: "111122223333", service: "rds", resource_id: "db-1",
    reason: "已知", region: "us-east-1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "bad_level");
});

t("★ exclusion requires a reason (R1.3)", async () => {
  // 没有理由的排除是「白名单越积越多没人敢删」的起点。
  const r = await insp.putExclusion("high", {
    account_id: "111122223333", service: "rds", resource_id: "db-1",
    level: "instance", region: "us-east-1",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "reason_required");
});

t("★★ account-wide exclusion needs an explicit confirmation (R1.7)", async () => {
  // 只给 account_id 不给资源 = 整账号退出巡检。二次确认在 UI 上做，
  // 但后端也必须要求 —— 否则脚本或误调一次就生效了。
  const base = {
    account_id: "111122223333", service: "rds", level: "account",
    reason: "客户要求整账号停巡检",
  };
  const no = await insp.putExclusion("high", base);
  assert.equal(no.ok, false);
  assert.equal(no.code, "confirm_required");
});

t("exclusion rejects a malformed account id", async () => {
  for (const bad of ["", "123", "abcdefghijkl", "1111222233331"]) {
    const r = await insp.putExclusion("high", {
      account_id: bad, service: "rds", resource_id: "db-1",
      level: "instance", reason: "x",
    });
    assert.equal(r.code, "bad_account", `account_id=${bad} 没被拒`);
  }
});

t("exclusion rejects an unknown list kind", async () => {
  for (const bad of ["High", "all", "", "both"]) {
    const r = await insp.putExclusion(bad, {});
    assert.equal(r.code, "bad_kind", `kind=${bad} 没被拒`);
  }
});

t("★★ schedule rejects a minute that the scheduler can never hit", async () => {
  // 🔴 调度是 EventBridge 的 15 分钟 tick。填 02:07 得到一个**永远不被
  // 精确命中**的配置：只能靠 catch_up 在 02:15 被补跑，表现为
  // 「报告总是慢 8 分钟」而不是报错。
  for (const bad of ["02:07", "02:01", "23:59", "00:14"]) {
    const r = await insp.putSchedule("high", { at_utc: bad });
    assert.equal(r.code, "bad_at_utc_tick", `at_utc=${bad} 没被拒`);
  }
  // 整数倍的要放行到下一步（这里没有真 DDB，所以只验不是校验错）
  for (const good of ["02:00", "02:15", "02:30", "02:45", "00:00"]) {
    const r = await insp.putSchedule("high", { at_utc: good });
    assert.notEqual(r.code, "bad_at_utc_tick", `at_utc=${good} 被误拒`);
  }
});

t("schedule rejects a malformed time and an unknown run type", async () => {
  for (const bad of ["", "2:00", "24:00", "02:60", "0200", "02:00:00"]) {
    const r = await insp.putSchedule("high", { at_utc: bad });
    assert.equal(r.code, "bad_at_utc", `at_utc=${bad} 没被拒`);
  }
  const r = await insp.putSchedule("weekly", { at_utc: "02:00" });
  assert.equal(r.code, "bad_run_type");
});

t("★★ schedule rejects weekday 0 and 8 — the domain is isoweekday 1..7", async () => {
  // 🔴 调度器的判据是 `d.isoweekday() in weekdays`（1=周一 … 7=周日）。
  //    这里曾按 0~6 校验（当成 `weekday()` 的域），于是「周一」以 0 落库 ——
  //    而 `isoweekday()` 永不返回 0，那一类巡检**永远不跑**：
  //    run 记录里连一行都没有，看起来像调度器压根没派它，零错误信号。
  for (const bad of [[0], [8], [0, 3], [-1]]) {
    const r = await insp.putSchedule("high", { at_utc: "02:00", weekdays: bad });
    assert.equal(r.code, "bad_weekdays", `weekdays=${JSON.stringify(bad)} 没被拒`);
  }
});

t("★ the accepted weekday domain matches Python's isoweekday, verbatim", () => {
  // 元断言：两侧的域必须同源。判据查 Python 侧真的在用 `isoweekday()` ——
  // 有人把 `matches_day` 改回 `weekday()` 时这条要红。
  assert.equal(insp.WEEKDAY_MIN, 1);
  assert.equal(insp.WEEKDAY_MAX, 7);
  const py = readFileSync(
    join(HERE, "..", "..", "..", "inspection", "domain", "schedule.py"), "utf8");
  assert.ok(py.includes("d.isoweekday() in self.weekdays"),
    "调度器不再用 isoweekday —— 本文件的 1..7 域已失效");
  assert.ok(!py.includes("d.weekday() in self.weekdays"),
    "调度器改用了 weekday()（0=周一），域应改成 0..6");
});

t("renew validates the day range", async () => {
  for (const bad of [0, -1, 366, "abc", null]) {
    const r = await insp.renewExclusion("high", "k", { days: bad });
    assert.equal(r.code, "bad_days", `days=${bad} 没被拒`);
  }
  const r = await insp.renewExclusion("high", "", { days: 30 });
  assert.equal(r.code, "key_required");
});

// --- 下一轮时间（R13.5）-----------------------------------------------------

t("★★ nextRunUtc converts JS getUTCDay to isoweekday", () => {
  // 🔴 三套口径：JS `getUTCDay()` 0=周日 / Python `weekday()` 0=周一 /
  //    Python `isoweekday()` 1=周一。调度器用第三套。
  //    不换算或换错的表现是 UI 显示的下一轮时间与实际执行**差一天**，
  //    客户按 UI 上的日子等，等不到。
  const mon = insp.nextRunUtc("02:00", [1]);   // 1 = 周一（isoweekday）
  assert.ok(mon, "算不出下一轮");
  assert.equal(new Date(mon).getUTCDay(), 1,
    `${mon} 不是周一（getUTCDay=${new Date(mon).getUTCDay()}）`);

  // ★ 周日是最容易错的那一天：isoweekday 7 ↔ getUTCDay 0。
  //   少了 `=== 0 ? 7 : ...` 那一步，选周日会永远算不出下一轮（返回空串）。
  const sun = insp.nextRunUtc("02:00", [7]);
  assert.ok(sun, "选周日算不出下一轮 —— getUTCDay 0 没被换算成 isoweekday 7");
  assert.equal(new Date(sun).getUTCDay(), 0,
    `${sun} 不是周日（getUTCDay=${new Date(sun).getUTCDay()}）`);
});

t("nextRunUtc always returns a future instant", () => {
  for (const at of ["00:00", "02:00", "23:45"]) {
    const iso = insp.nextRunUtc(at, null);
    assert.ok(new Date(iso) > new Date(), `${at} → ${iso} 不在未来`);
  }
});

// --- 定时配置的读侧字段（这一版修掉的 bug）---------------------------------

t("★★ schedule shape uses at_utc, NOT cron", () => {
  // 🔴 第一版按 `cron` / `timezone` / `tier` / `updated_at` 读 —— 那四个键
  //    DDB 里**一个都没有**（`put_schedule` 只写 enabled / at_utc /
  //    catch_up_hours / weekdays）。表现是定时页四列全空，
  //    而 tsc / 测试 / 后端都不报错。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const py = readFileSync(
    join(REPO, "inspection", "adapters", "store.py"), "utf8");
  const putSched = py.slice(py.indexOf("def put_schedule"),
    py.indexOf("def put_schedule") + 1400);
  // Python 侧真正写进 item 的键
  const written = new Set(
    [...putSched.matchAll(/^\s*(?:item\[)?"([a-z_]+)"\]?[:=]/gm)].map((m) => m[1]));
  written.delete("PK"); written.delete("SK");
  for (const k of ["enabled", "at_utc", "catch_up_hours"]) {
    assert.ok(written.has(k), `正则没抓到 put_schedule 写的 ${k}`);
  }
  // 读侧必须用这些键
  assert.ok(src.includes("it.at_utc"), "读侧没有读 at_utc");
  assert.ok(src.includes("it.catch_up_hours"), "读侧没有读 catch_up_hours");
  assert.ok(!src.includes("it.cron"),
    "读侧还在读 `cron` —— DDB 里没有这个键，定时页会永远空白");
});

t("★ exclusion shape uses expires_at, NOT expires_on", () => {
  // 同一类 bug：`ExclusionEntry` 的字段是 `expires_at`。读 `expires_on`
  // 会让到期列永远空白，于是「到期提示续期」（R1.4）完全不起作用。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  assert.ok(src.includes("it.expires_at"), "读侧没有读 expires_at");
  assert.ok(!src.includes("it.expires_on"), "读侧还在读不存在的 expires_on");
  const py = readFileSync(
    join(REPO, "inspection", "domain", "scope.py"), "utf8");
  assert.ok(py.includes("expires_at:"), "scope.py 的字段名变了，请同步读侧");
  assert.ok(!py.includes("expires_on"), "scope.py 出现了 expires_on");
});

t("★ schedules always come back for both run types (defaults included)", () => {
  // 全新部署上表是空的，而 Python 侧 `_schedule_from_item` 默认
  // `enabled=True` —— 巡检**已经在按默认时刻跑**。
  // 读侧不给默认值会让 UI 显示「还没配」，与系统实际行为矛盾。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  assert.ok(src.includes("shapeSchedule(rt, null)"),
    "缺行时没有回落到默认值 —— UI 会说没配，而系统在跑");
  assert.ok(/SCHEDULE_DEFAULTS[\s\S]{0,200}enabled:\s*true/.test(src),
    "默认 enabled 不是 true —— 与 Python 侧不一致");
});

t("★ empty accountId resolves to the deployment account, not an error", () => {
  // 🔴 真实事故（东京 111122223333，部署当天）：装完第一次打开看板就是
  //    「加载失败（account_required）」，而巡检本身完全正常。
  //
  //    链条：`notiops-config` GSI1 `GSI1PK=accounts` 全新部署是 **0 条**
  //    → 前端 `accounts.length > 0` 为假 → 账号选择器**压根不渲染**
  //    → accountId 恒为 "" → 六个读端点全部 account_required。
  //
  //    而前端那个选择器把空串**定义为**「部署账号」
  //    （`<option value="">部署账号</option>`）—— 报错的一侧才是与约定
  //    分叉的那一侧。所以修的是 BFF：空值解析成部署账号。
  //
  //    当初 39 条用例全部传了具体 accountId，所以这个 bug 一条都没碰到。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  assert.ok(/async function resolveAccount\(/.test(src),
    "resolveAccount 不见了 —— 空 accountId 会退回 account_required");
  assert.ok(src.includes("selfAccountId"),
    "resolveAccount 没有兜底到部署账号");

  // 六个**读**端点都必须走它。漏一个的表现是那一页单独加载失败，
  // 而同一个看板的其它页正常 —— 最难联想到根因的形态。
  for (const fn of ["getFindings", "getFinding", "getRuns",
                    "getOverview", "getSeries", "getConfig"]) {
    // ⚠️ 窗口从 200 放宽到 1200，且允许**条件**调用。
    //    `getFindings` 2026-08-27 起支持统一视图（`allAccounts`）——
    //    那条路径**刻意不解析账号**（跨账号查询没有「哪个账号」这回事），
    //    所以写成 `allAccounts ? null : await resolveAccount(accountId)`。
    //    断言要守的不变量是「单账号那条路仍然走 resolveAccount」，
    //    而不是「这一行长什么样」。
    const m = new RegExp(
      `export async function ${fn}\\([^)]*\\)[\\s\\S]{0,1200}?` +
      `await resolveAccount\\(accountId\\)`);
    assert.ok(m.test(src), `${fn} 没有走 resolveAccount —— 无成员账号时这一页会加载失败`);
  }
  // 旧写法不得残留（除了 resolveAccount 自己内部那一处）。
  //
  // 🔴 **必须先剥注释再计数。** 这是一条否定式断言，而本仓库到此已经踩过
  //    **八次**「断言命中自己解释判据的注释」——2026-08-31 又中一次：
  //    `triggerRun` 里新写的一段注释解释了「为什么不在这里再 trim 一次」，
  //    里面引用了那个表达式的字面量 → 计数变 2 → 这条红了，
  //    而产品代码是对的。
  //
  // ⚠️ 只剥 `//` 行注释和 `/* */` 块注释，不剥字符串 —— 要数的那个模式本身
  //    含引号，剥字符串会把它一起清掉，这条断言就变成永真。
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((ln) => ln.replace(/\/\/.*$/, "")).join("\n");
  const occurrences = noComments.split('String(accountId || "").trim()').length - 1;
  assert.strictEqual(occurrences, 1,
    "除 resolveAccount 内部外还有端点在直接 trim accountId");
});
t("★ the resource inventory must NOT list EC2", () => {
  // 🔴 巡检只覆盖 RDS 与 ElastiCache：`inspection/pipeline.py::load_resources`
  //    只调 load_rds_attrs_with_groups / load_elasticache_attrs。EC2 在这套里
  //    唯一的用途是 ec2:DescribeInstanceTypes（给规格名查内存大小）。
  //
  //    列 EC2 的后果**比手填打错更难发现**：勾一台会写出一条语义合法
  //    但永不匹配的排除记录，UI 显示「已排除」，而巡检压根不看它 ——
  //    界面反馈是成功的。第一版就犯了这个错（东京实测时那个账号只有
  //    2 台 EC2，列表里全是勾了没用的条目）。
  //
  //    这条断言之所以存在：「顺手把 EC2 也列上」看起来是补全功能。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function getResources"));
  const body = fn.slice(0, fn.indexOf("\n}\n"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/DescribeInstancesCommand/.test(body),
    "资源清单列了 EC2 —— 勾出来的排除记录永不匹配，而 UI 说成功了");
  // ⚠️ 这条原来是 `!/client-ec2/` —— 太宽。它想拦的是「列 EC2 实例」，而
  //    `DescribeRegions` 也在 EC2 客户端里，跟列实例毫无关系（2026-08-27
  //    多 region 巡检要用它枚举 region）。所以改成按**命令名**拦，并把
  //    唯一允许的那个显式列出来。
  const ec2Cmds = [...body.matchAll(/(Describe[A-Za-z]+)Command/g)]
    .map((m) => m[1])
    .filter((n) => /Instances|Volumes|Snapshots|Addresses|NetworkInterfaces/.test(n));
  assert.deepEqual(ec2Cmds.filter((n) => n === "DescribeInstances"), [],
    "资源清单列了 EC2 实例 —— 勾出来的排除记录永不匹配，而 UI 说成功了");
  assert.ok(!/DescribeInstancesCommand/.test(body),
    "资源清单列了 EC2 实例");
  // 该有的两类必须在。
  assert.ok(/DescribeDBInstancesCommand/.test(body), "没有列 RDS 实例");
  assert.ok(/DescribeDBClustersCommand/.test(body), "没有列 Aurora 集群");
  assert.ok(/DescribeReplicationGroupsCommand/.test(body),
    "没有列 ElastiCache 副本组");

  // IAM 也不该给。给了就是留着一个「以后顺手就能列」的口子。
  const stack = readFileSync(
    join(REPO, "infra", "lib", "web-chat-stack.ts"), "utf8");
  const sid = stack.slice(stack.indexOf("InspectionResourceInventoryReadOnly"));
  const stmt = sid.slice(0, sid.indexOf("}),"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/ec2:DescribeInstances/.test(stmt),
    "BFF 角色仍有 ec2:DescribeInstances —— 与「不列 EC2」的决定不一致");
});
t("★ manual run is authorized separately from scope/schedule edits", async () => {
  // 🔴 `/inspection/run` 是**唯一**能被前端请求直接花钱的巡检端点：
  //    refetch 真调 CloudWatch GetMetricData，official 还会派发 DA 判读。
  //    所以它必须有自己的能力节点。
  //
  //    并进 `action:inspection:scope` 的后果：「能编辑排除清单」顺带获得
  //    「能反复烧配额」——而排除清单是 onboarding 时给运维的常规权限。
  //    搭在 `nav:inspection` 上更糟：任何能看看板的人都能烧钱。
  const caps = JSON.parse(readFileSync(join(HERE, "..", "capabilities.json"), "utf8"));
  const nodes = Array.isArray(caps) ? caps : (caps.nodes || caps.capabilities || []);
  const run = nodes.find((n) => n.key === "action:inspection:run");
  assert.ok(run, "action:inspection:run 节点不存在");
  assert.equal(run.level, "action");
  assert.equal(run.parent, "nav:inspection:actions");

  // 那条 route 只能挂在这个节点上，不能同时出现在别处。
  const owners = nodes.filter((n) => (n.routes || [])
    .some((r) => String(r.pattern).includes("/inspection/run")));
  assert.deepEqual(owners.map((n) => n.key), ["action:inspection:run"],
    "/inspection/run 被多个能力节点声明 —— 授权边界就漏了");

  // 看板权限**不足以**触发巡检。
  const { authorize } = await import("../authz.mjs");
  const viewer = { grants: ["nav:inspection", "nav:inspection:high-load",
                            "nav:inspection:idle"], denies: [] };
  const denied = await authorize(
    { method: "POST", path: "/api/chat/inspection/run" }, viewer);
  assert.ok(!denied?.ok, "只有看板权限却能触发巡检 —— 任何看板用户都能烧配额");

  // 改范围的权限也不够。
  const scoper = { grants: ["nav:inspection", "action:inspection:scope"], denies: [] };
  const denied2 = await authorize(
    { method: "POST", path: "/api/chat/inspection/run" }, scoper);
  assert.ok(!denied2?.ok,
    "action:inspection:scope 顺带放行了触发巡检 —— 两者必须分开");
});
t("★ triggerRun defaults are refetch + dry_run, and it never runs sync", () => {
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function triggerRun"));
  const whole = fn.slice(0, fn.indexOf("\n}\n"));
  // 只看**代码行**。同一段里的说明文字也含这些字面量，连注释一起匹配会让
  // 断言被注释满足 —— 实测踩过两次（getOverview 那条也是）。
  const body = whole.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  // refetch：点「立即巡检」要的是**现在的**指标。而 reuse 在全新部署上
  // 没有可复用批次 → resolve_reuse_date 按 R11.4b 直接抛 → 用户点一次
  // 得到一个失败的 run，失败原因还是「没有可复用的批次」。
  assert.ok(/b\.source \|\| "refetch"/.test(body), "source 默认不是 refetch");
  // dry_run：official 会推进 finding 状态机、参与 resolved 判定。
  // 一次手点的补跑不该改变「这条风险是否已解决」这种带日期语义的结论。
  assert.ok(/b\.mode \|\| "dry_run"/.test(body), "mode 默认不是 dry_run");
  // 异步：一轮 refetch 是分钟级，同步 invoke 会顶到 Function URL 的 30 秒
  // 上限 —— 表现是前端超时报错而巡检其实正常跑着，于是用户重复点。
  assert.ok(/InvocationType: "Event"/.test(body),
    "不是异步 invoke —— 前端会超时而巡检其实在跑，用户会重复触发");
  // 调度逻辑一条都不许在 BFF 重实现。
  for (const leak of ["try_acquire", "resolve_tier", "consumed_seconds",
                      "due_runs", "chunk_batches"]) {
    assert.ok(!body.includes(leak),
      `BFF 重实现了 scheduler 的 ${leak} —— 两处判据会漂移`);
  }
});
t("★★ parse_quality 的分母是**派发过的**条数，不是全部 finding", () => {
  // 🔴 这个指标是 skill 漂移的唯一可见信号（DA 的判读按
  //    `## <finding_id>` 精确匹配切段，措辞一变就切不出来）。
  //
  //    分母选错的后果是它**永远没人看**：闲置轮走
  //    `SkipReason.DETERMINISTIC` 压根不派发判读，把那些条目算进分母
  //    会让成功率恒低 → 首屏恒红 → 习惯性忽略 → 真出问题那天也不会被注意到。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const seg = src.slice(src.indexOf("const parseQuality"));
  const body = seg.slice(0, seg.indexOf("\n  }") + 4);
  const code = body.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  // 判据①：按 da_task_id 过滤（有 task 才算派发过）
  assert.ok(/if\s*\(!r\.da_task_id\)\s*continue/.test(code),
    "parseQuality 没有按 da_task_id 过滤 —— 未派发的条目会进分母，"
    + "于是这个指标恒红、也就恒被忽略");
  // 判据②：四档都在，且不合并
  for (const k of ["ok", "partial", "parse_failed", "empty"]) {
    assert.ok(body.includes(k), `parse_quality 少了 ${k} 档`);
  }
  // 判据③：空 status 不算进 other ——「判读还在路上」是正常中间态
  assert.ok(/else if \(s\) parseQuality\.other/.test(code),
    "空 da_parse_status 被算进 other 了 —— 刚触发的那一轮会显示成异常");
  // 判据④：透出到总览（单个 kind 页看不出「是这类特殊还是整条链坏了」）
  assert.ok(/parse_quality: findings\.parse_quality/.test(src),
    "getOverview 没有透出 parse_quality");
});
t("★ getOverview must not go through the kind-guarded public getFindings", () => {
  // 🔴 真实事故（东京，部署当天）：「巡检总览」100% 显示
  //    「加载失败（bad_kind）」。根因是 getOverview 内部写了
  //    `getFindings(acct)` —— 而那个函数强制 kind（三个子页各自分权的
  //    纵深防御），不传就直接 fail。总览要的恰恰是跨 kind 全量。
  //
  //    为什么 39 条用例没抓到：它们全是**源码断言**，没有一条真的调用
  //    getOverview。所以这条改成查调用关系，下面还有一条真调用的。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const ov = src.slice(src.indexOf("export async function getOverview"));
  const body = ov.slice(0, ov.indexOf("\n}\n"));
  // ⚠️ 必须剥掉注释行才能断言。第一版没剥，结果被**修复说明里那句**
  //    「写成 getFindings(acct) 的表现是…」命中，正确代码也报红。
  const code = body.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  // ⚠️ 允许带第二个参数：2026-08-27 起 getOverview 支持统一视图，要把
  //    `visible`（可见账号集合）传下去做越权过滤。断言守的是「走的是
  //    queryFindings 而不是 kind 强校验的 getFindings」，不是参数个数。
  assert.ok(/queryFindings\(acct[,)]/.test(code),
    "getOverview 没走 queryFindings —— 总览会恒 bad_kind");
  assert.ok(!/getFindings\(acct\)/.test(code),
    "getOverview 还在调 kind 强校验的 getFindings");
  // 内部函数不得导出：导出一个不校验 kind 的取数函数等于给越权留门。
  assert.ok(!/export\s+async\s+function\s+queryFindings/.test(src),
    "queryFindings 被导出了 —— 三个子页的分权就绕得过去了");
  // 公开端点的强校验必须还在。
  // ⚠️ 窗口从 900 放宽到 3000：`getFindings` 头部加了统一视图（`allAccounts`
  //    + 可见性硬门）的说明，把 `bad_kind` 推远了。这条断言守的是
  //    「kind 强校验还在」，不是「它出现在前 900 个字符里」。
  //    ⚠️ 但**不要**改成无窗口的 `[\s\S]*`：那样任何位置的 bad_kind 都算过，
  //       包括别的函数里的 —— 断言就废了。
  assert.ok(/export async function getFindings[\s\S]{0,3000}?bad_kind/.test(src),
    "getFindings 的 kind 纵深防御被一起删了");
});
t("★ the frontend really does define empty string as the deployment account", () => {
  // 上一条的前提。这个 option 一旦被改成传真实 ID，BFF 的兜底就成了
  // 无人经过的死代码 —— 而它是那条修复的**唯一**依据，所以钉住它。
  //
  // ⚠️ 2026-09-01：选择器从 `InspectionDashboard`（页面级）搬到了
  //    `ExclusionModal`（写入弹层内）。页面级那个已经没有任何一页在用 ——
  //    列表跨账号、阈值全局、排除清单有账号列 —— 而它长得像筛选器。
  //    这条断言跟着搬，因为它守的是「空串 = 部署账号」这个**契约**，
  //    不是「契约写在哪个文件里」。
  const dash = readFileSync(join(REPO, "frontend", "chat-app", "src",
    "components", "inspection", "ExclusionModal.tsx"), "utf8");
  // ⚠️ 必须匹配**账号选择器那一个** option（宽匹配会被别的
  //    `<option value="">` 满足 —— 实测过：把账号那个改掉仍然全绿）。
  assert.ok(/<option value="">\{zh \? "部署账号"/.test(dash),
    "账号选择器不再用空串代表部署账号 —— BFF 侧 resolveAccount 的依据消失了");
  assert.ok(/accounts\.length > 0/.test(dash),
    "选择器的渲染条件变了，请重新确认无成员账号时 accountId 是什么");
  // 🔴 那个空串必须真的走到请求上去。中间加一层
  //    `acct || DEPLOY_ID` 之类的兜底会让契约在前端就被消化掉，
  //    而 BFF 的 resolveAccount 又变成死代码。
  assert.ok(/getInspectionResources\(acct \|\| undefined\)/.test(dash),
    "空账号没有以 undefined 发出去 —— BFF 的空值兜底走不到");
});

t("★★ 页面级账号选择器已移除（它不影响任何一页的加载维度）", () => {
  // 客户实测：巡检范围页头那个选择器不过滤下面的清单，却长得像筛选器。
  // 留着它的表现是「选了 677 却看到 088 的整账号排除行」被读成「筛选坏了」，
  // 而真相是那里压根没有筛选。
  const dash = readFileSync(join(REPO, "frontend", "chat-app", "src",
    "components", "InspectionDashboard.tsx"), "utf8");
  const stripped = dash.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")
      && !l.trim().startsWith("/*")).join("\n");
  assert.ok(!/const acctPicker/.test(stripped),
    "页面级账号选择器又回来了 —— 它不影响任何一页的加载维度");
  assert.ok(!/aria-label=\{zh \? "账号"/.test(stripped),
    "InspectionDashboard 里又出现了账号选择器");
});
// ---------------------------------------------------------------------------
// ④ 判定阈值的限值表与校验（R13.4）
//
// 🔴 本侧是 `inspection/domain/rule_limits.py` 的**镜像**。逐字段比对那条
//    元断言在 Python 侧（`tests/test_inspection_rule_config.py`）——
//    因为 mjs 写成单行位置参数好解析，反过来解析多行关键字参数不可靠，
//    而 CI 的 bff job 是 node 镜像、没有 python。
// ---------------------------------------------------------------------------

t("rule limits: run types own disjoint sections", () => {
  const high = new Set(rlSectionsFor("high"));
  const idle = new Set(rlSectionsFor("idle"));
  assert.deepEqual([...high], ["threshold"]);
  assert.deepEqual([...idle].sort(), ["capacity", "idle", "structural"]);
  assert.equal([...high].filter((s) => idle.has(s)).length, 0);
  assert.deepEqual(rlSectionsFor("bogus"), []);
});

t("★ rule validation error codes are stable (BFF returns them as `code`)", () => {
  const cases = [
    ["threshold", "cpu_utilization", 85, ""],
    // 🔴 0 现在是**非法**（2026-08-26）。ThresholdRuleConfig 要求百分比阈值
    //    落在开区间 (0, 100]，而范围表原来的 min 是 0.0 —— 于是「写侧放行、
    //    读侧抛」：客户填 0 → 保存成功 → 下一轮 executor ValueError →
    //    run failed → DLQ → 两类巡检每天全失败。
    ["threshold", "cpu_utilization", 0, "below_min"],
    ["threshold", "cpu_utilization", 0.1, ""],
    ["threshold", "cpu_utilization", 100, ""],
    ["threshold", "cpu_utilization", 100.1, "above_max"],
    ["threshold", "cpu_utilization", -0.1, "below_min"],
    ["threshold", "cpu_utilization", "abc", "bad_type"],
    ["threshold", "cpu_utilization", null, "bad_type"],
    ["threshold", "cpu_utilization", "", "bad_type"],
    // 🔴 布尔必须显式拒。JS 的 Number(true)===1，不拦的话「勾了个开关」
    //    会被存成阈值 1，而 1 对多数字段都合法 —— 完全静默。
    ["threshold", "cpu_utilization", true, "bad_type"],
    ["threshold", "cpu_utilization", NaN, "bad_type"],
    ["threshold", "cpu_utilization", Infinity, "bad_type"],
    ["threshold", "nope", 1, "unknown_field"],
    ["bogus", "cpu_utilization", 1, "unknown_field"],
    ["threshold", "min_coverage_days", 0, "below_min"],
    ["threshold", "min_coverage_days", 31, "above_max"],
    ["structural", "prod_tiers", ["a", "b"], ""],
    ["structural", "prod_tiers", "notalist", "bad_type"],
    ["structural", "prod_tiers", [], "bad_type"],
  ];
  for (const [s, k, v, want] of cases) {
    const { code } = rlValidateField(s, k, v);
    assert.equal(code, want, `${s}.${k}=${JSON.stringify(v)} → ${code}`);
  }
});

t("int fields truncate rather than round", () => {
  const { value, code } = rlValidateField("threshold", "min_coverage_days", 5.9);
  assert.equal(code, "");
  assert.equal(value, 5, "5.9 天不是一个有意义的门槛");
});

t("★ a run type cannot write the other run type's section", () => {
  // R11.1：两轮独立。合成一份会让「把闲置 CPU 门槛调高」顺带影响高负载判定。
  const a = rlNormalizeOverrides("high", { idle: { candidate_cpu_avg: 5 } });
  assert.deepEqual(a.errors, ["section_not_allowed:idle"]);
  const b = rlNormalizeOverrides("idle", { threshold: { cpu_utilization: 80 } });
  assert.deepEqual(b.errors, ["section_not_allowed:threshold"]);
});

t("★ every bad field is reported, not just the first", () => {
  // 一次把问题全报回去 —— 让客户改一遍就能过，而不是挤牙膏。
  const { errors } = rlNormalizeOverrides("high", {
    threshold: { cpu_utilization: 200, min_coverage_days: 0, nope: 1 },
  });
  assert.equal(errors.length, 3);
  assert.deepEqual([...new Set(errors.map((e) => e.split(":")[0]))].sort(),
    ["above_max", "below_min", "unknown_field"]);
});

t("normalizeOverrides rejects a bad body shape", () => {
  for (const body of [null, undefined, "x", 5, []]) {
    assert.deepEqual(rlNormalizeOverrides("high", body).errors, ["bad_body"]);
  }
  assert.deepEqual(
    rlNormalizeOverrides("high", { threshold: "notanobject" }).errors,
    ["bad_section_body:threshold"]);
});

t("★ describeRules marks customized fields apart from defaults", () => {
  // 「客户填了 70」与「没配过而默认也是 70」必须能区分 —— 分不开的话，
  // 我们以后调默认值时那些其实没配过的部署不会跟着走。
  const d = rlDescribeRules("high", { threshold: { cpu_utilization: 70 } });
  const byKey = Object.fromEntries(d.threshold.map((x) => [x.key, x]));
  assert.equal(byKey.cpu_utilization.customized, true);
  assert.equal(byKey.cpu_utilization.value, 70);
  assert.equal(byKey.evictions.customized, false);
});

t("★ describeRules ships min/max/unit for every field", () => {
  // 前端 SHALL NOT 自己写死范围 —— 写死一份的表现是
  // 「UI 上填得进去、点保存报 400」。
  for (const rt of ["high", "idle"]) {
    const d = rlDescribeRules(rt, {});
    assert.deepEqual(Object.keys(d).sort(), [...rlSectionsFor(rt)].sort());
    for (const items of Object.values(d)) {
      assert.ok(items.length > 0);
      for (const it of items) {
        for (const key of ["key", "type", "value", "default", "min", "max",
                           "unit", "label_zh", "label_en", "customized"]) {
          assert.ok(key in it, `${it.key} 少了 ${key}`);
        }
        assert.ok(it.label_zh && it.label_en, `${it.key} 缺文案`);
        if (it.type !== "str_set") {
          assert.equal(typeof it.min, "number", `${it.key} 缺 min`);
          assert.equal(typeof it.max, "number", `${it.key} 缺 max`);
        }
      }
    }
  }
});

t("describeRules falls back to the default for a corrupt stored value", () => {
  const d = rlDescribeRules("high", { threshold: { cpu_utilization: "garbage" } });
  const cpu = d.threshold.find((x) => x.key === "cpu_utilization");
  assert.equal(cpu.value, 70);
});

t("★ window_days and max_workers are not customizable", () => {
  // 它们是**数据窗口 / 并发度**，与采集耦合。改成 14 而序列库只有 7 天数据
  // → 判定拿不到数，表现是「调完之后什么都不报了」。
  const keys = new Set(rlFIELDS.map((f) => `${f.section}.${f.key}`));
  assert.ok(!keys.has("idle.window_days"));
  assert.ok(![...keys].some((k) => k.endsWith(".max_workers")));
  const { errors } = rlNormalizeOverrides("idle", { idle: { window_days: 30 } });
  assert.deepEqual(errors, ["unknown_field:idle.window_days"]);
});

t("★ every rule field declares which services it applies to", () => {
  // 🔴 缺了 services 的表现:客户改 read_latency_seconds 期待 Redis 跟着变
  //    —— 而那完全不生效且**零提示**。
  const orphans = rlFIELDS.filter((f) => !f.services || f.services.length === 0);
  assert.deepEqual(orphans.map((f) => f.key), [], "这些字段没有适用服务");
  const bad = rlFIELDS.flatMap((f) =>
    (f.services || []).filter((s) => !rlSERVICES.includes(s))
      .map((s) => `${f.key}:${s}`));
  assert.deepEqual(bad, [], "这些 services 值不在 SERVICES 里");
});

t("★ service filter is a subset, never everything or nothing", () => {
  // 每组都该是真子集 —— 等于全部说明分组没意义,等于空说明该组啥也调不了。
  const total = rlCountFor("");
  assert.equal(total, rlFIELDS.length);
  for (const svc of rlSERVICES) {
    const n = rlCountFor(svc);
    assert.ok(n > 0 && n < total, `${svc} 的字段数 ${n} 不是真子集（总 ${total}）`);
  }
  // 并集必须覆盖全部 —— 否则有字段在任何视图下都看不见
  const seen = new Set();
  for (const svc of rlSERVICES) {
    for (const f of rlFIELDS) if (f.services.includes(svc)) seen.add(f.section + "." + f.key);
  }
  assert.equal(seen.size, rlFIELDS.length, "有字段在任何服务视图下都看不见");
});

t("★ serviceCatalog ships labels and per-service counts", () => {
  // 前端 SHALL NOT 自己维护服务清单 —— 那会与字段的 services 归属分叉,
  // 表现是标签说管 Redis 而其实不管。
  const cat = rlServiceCatalog();
  assert.deepEqual(cat.map((c) => c.key), [...rlSERVICES]);
  for (const c of cat) {
    for (const k of ["label_zh", "label_en", "hint_zh", "hint_en"]) {
      assert.ok(c[k], `${c.key} 缺 ${k}`);
    }
    assert.equal(c.field_count, rlCountFor(c.key));
  }
});

t("describeRules carries services on every field", () => {
  for (const rt of ["high", "idle"]) {
    for (const [section, items] of Object.entries(rlDescribeRules(rt, {}))) {
      for (const it of items) {
        assert.ok(Array.isArray(it.services) && it.services.length > 0,
          `${section}.${it.key} 没带 services`);
      }
    }
  }
});

t("★ known service→field facts (guards against a silent remap)", () => {
  // 抽查几条**有据可查**的归属。它们各自对应一个真实的 AWS 事实,
  // 改错了客户会照着标签做错判断。
  const svc = (key) => {
    const f = rlFIELDS.find((x) => x.key === key && x.section === "threshold")
      || rlFIELDS.find((x) => x.key === key);
    return [...f.services].sort();
  };
  // Aurora 存储自动扩展 → 没有 FreeStorageSpace
  assert.deepEqual(svc("free_storage_pct"), ["rds"]);
  // Redis 主线程单线程 → 单独的引擎 CPU 门槛；Memcached 没这个指标
  assert.deepEqual(svc("engine_cpu_utilization"), ["redis"]);
  assert.deepEqual(svc("database_memory_usage_pct"), ["redis"]);
  // 驱逐是两种 ElastiCache 引擎都有的
  assert.deepEqual(svc("evictions"), ["memcached", "redis"]);
  // ElastiCache 不管理 CA 证书
  assert.deepEqual(svc("ca_cert_lead_days"), ["aurora", "rds"]);
  // IOPS 否决只在 veto._check_rds 里
  assert.deepEqual(svc("iops_total"), ["aurora", "rds"]);
  // CPU 与 Swap 四组都有
  assert.deepEqual(svc("cpu_utilization"), ["aurora", "memcached", "rds", "redis"]);
  assert.deepEqual(svc("swap_usage_bytes"), ["aurora", "memcached", "rds", "redis"]);
});

t("★ the threshold route is registered in capabilities.json", () => {
  // 漏了这条的表现是上线后该端点对**所有人** 403 unknown_route（fail-closed）。
  const node = matchRoute("PUT", "/api/chat/inspection/rules/high", {}, {});
  assert.ok(node, "PUT /inspection/rules/high 没有能力节点");
  assert.equal(node.key, "action:inspection:threshold");
});

// ---------------------------------------------------------------------------
// ④ finding_id 的 `<rule>` 段 → 看板页（这一版修掉的 bug）
// ---------------------------------------------------------------------------

/** 从 `dto.py` 里正则抽一个 `str, Enum` 的全部值。不靠人工同步。 */
function pyEnumValues(src, className) {
  const at = src.indexOf(`class ${className}(str, Enum):`);
  assert.ok(at > 0, `dto.py 里找不到 class ${className}(str, Enum)`);
  // 到下一个顶层 class 为止
  const rest = src.slice(at + 10);
  const end = rest.search(/\nclass /);
  const body = end < 0 ? rest : rest.slice(0, end);
  const vals = [...body.matchAll(/^\s{4}[A-Z0-9_]+\s*=\s*"([a-z0-9_]+)"/gm)]
    .map((m) => m[1]);
  assert.ok(vals.length > 0, `${className} 一个值都没抽到 —— 正则失效了`);
  return vals;
}

t("★★ KIND_RULES matches the rule segment Python actually writes", () => {
  // 🔴 这一版修掉的 bug：`KIND_REASONS.structural` 是 `["structural"]`，
  //    而 `dto.py::Finding.finding_id` 第 5 段是 `self.rule.value`
  //    （`gp2_volume` / `engine_eol` / …）。`"gp2_volume" !== "structural"`
  //    于是 `queryFindings` 的过滤把它们**全部丢掉**：
  //
  //      结构性风险页恒 0 条；容量 finding（oversized_*）三页都看不到；
  //      而总览不带 kind 不过滤 → 「总览说 12 条，三页加起来 4 条」。
  //
  //    11 类规则里 9 类的 finding 在界面上到不了，且零错误信号。
  //    根因是**两套词汇表同名**：payload 的 hit_reason 四个值 vs
  //    finding_id 的 rule 段。这条断言钉住后者。
  const dto = readFileSync(
    join(REPO, "inspection", "domain", "dto.py"), "utf8");
  const expected = new Set([
    ...pyEnumValues(dto, "StructuralRule"),
    ...pyEnumValues(dto, "CapacityRule"),
    // 这两个由 assemble.py 直接拼进 finding_id，不是枚举
    "threshold_high", "idle",
  ]);
  assert.deepEqual([...new Set(insp.KNOWN_RULES)].sort(), [...expected].sort(),
    "KIND_RULES 覆盖的 rule 段与 Python 侧写出来的不一致");
});

t("★★ assemble.py really hardcodes those two non-enum rule segments", () => {
  // 上面那条把 threshold_high / idle 当成已知值放行，这条验证前提 ——
  // 哪天 assemble.py 换了写法，上面那条会变成「验了一个假设」。
  const asm = readFileSync(join(REPO, "inspection", "assemble.py"), "utf8");
  assert.ok(asm.includes('iid, "threshold_high", metric'),
    "高负载 finding_id 的 rule 段不再是 threshold_high");
  assert.ok(asm.includes("s.instance_id, pl.HIT_IDLE"),
    "闲置 finding_id 的 rule 段不再是 pl.HIT_IDLE");
  // `chronic_high` **不在** finding_id 里 —— 写进 KIND_RULES 是死值。
  assert.ok(!insp.KNOWN_RULES.includes("chronic_high"),
    "chronic_high 不会出现在 finding_id 第 5 段，登记它是一条永不命中的死值");
});

t("★★ every known rule maps to exactly one kind", () => {
  // 重叠会让同一条 finding 在两页都出现（计数重复）；
  // 遗漏会让它一页都不出现。两种都没有运行时信号。
  const seen = new Map();
  for (const r of insp.KNOWN_RULES) {
    const k = insp.kindOfFinding({ rule: r });
    assert.ok(insp.FINDING_KINDS.includes(k), `${r} 映射到了未知 kind ${k}`);
    assert.ok(!seen.has(r), `${r} 出现在多个 kind 里`);
    seen.set(r, k);
  }
  // 容量归**闲置页**而不是结构性页：它读指标（dto.py::CapacityRule 的注释）
  assert.equal(seen.get("oversized_storage"), "idle");
  assert.equal(seen.get("oversized_memory"), "idle");
  // 七项结构性风险全部归结构性页
  assert.equal(seen.get("gp2_volume"), "structural");
  assert.equal(seen.get("engine_eol"), "structural");
  assert.equal(seen.get("ca_cert_expiring"), "structural");
  assert.equal(seen.get("threshold_high"), "high_load");
  assert.equal(seen.get("idle"), "idle");
});

t("★ kindOfFinding falls back to the SK segment, and fails closed", () => {
  // 存量行万一没有 `rule` 属性时靠 SK 兜底
  assert.equal(insp.kindOfFinding({
    finding_id: "1#ap-northeast-1#rds#db-1#gp2_volume#-" }), "structural");
  // 🔴 认不出来必须返回 ""，让调用方 403 —— 放行等于对新规则完全无授权
  assert.equal(insp.kindOfFinding({ rule: "brand_new_rule" }), "");
  assert.equal(insp.kindOfFinding({}), "");
  assert.equal(insp.kindOfFinding(null), "");
});

t("★★ the finding detail endpoint re-checks the kind (G1)", () => {
  // `/inspection/finding` 挂在 **tab 级** route 上。只有 nav:inspection:idle
  // 的人拿一个高负载 finding 的 id 就能读到它的 da_body 判读全文。
  // 列表没这个问题（另有 queryMatch 分权），详情有。
  const src = readFileSync(join(HERE, "..", "index.mjs"), "utf8");
  assert.ok(src.includes("kindOfFinding"),
    "详情端点没有按 kind 复核 —— 只有闲置权限的人能读高负载判读全文");
  assert.ok(src.includes("forbidden_kind"), "复核不通过没有返回 403");
  assert.ok(/INSPECTION_KIND_NAV\s*=\s*Object\.freeze/.test(src),
    "kind → 能力键的映射不见了");
  // 三个 kind 的能力键必须都在 capabilities.json 里存在，否则这道复核
  // 会把**所有人**挡在外面（satisfies 对不存在的 key 恒 false）。
  const caps = JSON.parse(
    readFileSync(join(HERE, "..", "capabilities.json"), "utf8")).nodes;
  const keys = new Set(caps.map((n) => n.key));
  for (const [navKey] of KIND_ROUTES) {
    assert.ok(keys.has(navKey), `capabilities.json 里没有 ${navKey}`);
    assert.ok(src.includes(navKey),
      `INSPECTION_KIND_NAV 里没有 ${navKey} —— 那一类详情会对所有人 403`);
  }
  // 映射的 kind 键与 KIND_RULES 三方一致
  for (const [, kind] of KIND_ROUTES) {
    assert.ok(insp.FINDING_KINDS.includes(kind),
      `capabilities 的 queryMatch kind=${kind} 不在 FINDING_KINDS 里`);
  }
});

t("★ the finding row exposes `rule`/`kind`, not `hit_reason`", () => {
  // `hit_reason` 在这套系统里专指 payload 给 DA 的那四个判读分类
  // （payload.py::VALID_HIT_REASONS）。读侧沿用这个名字正是本 bug 的来源。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  assert.ok(!/^\s*hit_reason:/m.test(src),
    "读侧还在返回 hit_reason —— 它与 payload 的同名字段是两套词汇表");
  assert.ok(src.includes("kind: kindOfFinding("),
    "行里没有带 kind —— 前端就得自己写一份 rule → 页 的映射");
  // 而 skill 那边的 hit_reason **是对的**，不要顺手改掉
  const guard = readFileSync(
    join(REPO, "inspection", "skills", "_shared", "GUARDRAILS.md"), "utf8");
  assert.ok(guard.includes("threshold_high"),
    "GUARDRAILS 的 hit_reason 词汇表被改了 —— 那是给 DA 的，不该动");
});

t("putRules 的 merge 基线读失败时拒写（不静默清空客户的自定义阈值）", () => {
  // 🔴 `loadRuleOverrides` 原来对任何异常都 `return {}`，而 `{}` 有两个完全
  //    不同的含义：「没配过」（全新部署的正常态）与「读不到」（故障）。
  //    读路径压成一个值是对的；写路径的 merge 基线压成一个值是**数据丢失**：
  //
  //    客户只改一个字段并保存 → 基线读失败 → prev={} → merged 只剩这一个字段
  //    → 写出全量快照 → 之前所有自定义阈值回到默认 → 返回 ok:true
  //    → 下一轮按默认阈值判，一批被调高压掉的告警全部重新报出来
  //
  //    这是 08-23 那个数据丢失缺陷的原样复现（那次修的是「不做全量覆盖」，
  //    这条 catch 把它造回来了 —— 基线错了，全量快照就是错的）。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  assert.ok(/async function loadRuleOverrides\(runType, \{ strict = false \} = \{\}\)/
    .test(src), "loadRuleOverrides 没有 strict 参数");
  assert.ok(/code: "merge_base_unavailable"/.test(src),
    "strict 模式下没有专门的错误码 —— 运维无从区分「拒写」与其他 400");
  // putRules 侧必须传 strict
  const put = src.slice(src.indexOf("export async function putRules"));
  const body = put.slice(0, put.indexOf("\n}\n") + 1);
  assert.ok(/loadRuleOverrides\(runType, \{ strict: true \}\)/.test(body),
    "putRules 的 merge 基线没传 strict —— 读失败会静默清空客户的配置");
});

t("getConfig 的读路径**不**传 strict（配置页不该因为一次限流打不开）", () => {
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const get = src.slice(src.indexOf("export async function getConfig"));
  const body = get.slice(0, get.indexOf("\n}\n") + 1);
  assert.ok(/loadRuleOverrides\(rt\)/.test(body),
    "读路径也传了 strict —— 一次限流就让整个阈值页打不开，"
    + "而显示默认值 + 一个提示是更好的降级");
});

t("sortedDeep 递归数组（config_hash 的跨语言一致性依赖它）", () => {
  // ⚠️ 逐字节一致性由 tests/test_inspection_config_hash.py 跨语言验；
  //    这里只钉住 BFF 侧的形状，免得有人「优化」回 `return v`。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  assert.ok(/if \(Array\.isArray\(v\)\) return v\.map\(sortedDeep\);/.test(src),
    "sortedDeep 对数组直接返回了 —— 数组里嵌的 map 键序不排，"
    + "与 Python 侧的 json.dumps(sort_keys=True) 不一致，"
    + "而 config_hash 现在是 R6.9 的判据（哈希不等 → 全部 finding 被强制 resolve）");
});

t("instance_class 透到读侧（闲置条目的处置价值几乎全看规格）", () => {
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  assert.ok(/instance_class: String\(item\.instance_class \|\| ""\)/.test(src),
    "读侧没透 instance_class —— 「db.t4g.micro 闲置」与「db.r8g.4xlarge 闲置」"
    + "在卡片上长得一模一样，而处置价值差两个数量级");
});

t("★★★ 跨账号查询没拿到可见账号集合时**拒绝**（不是放行）", () => {
  // 🔴 统一视图会把所有账号的 finding 摊开：实例名、预计月省金额、AI 判读结论。
  //    而账号可见性是配置项（管理 → 账号数据可见性）。
  //
  //    路由层那道门禁只认 `q.account` / `body.account_id` / `body.key`，
  //    而统一视图**压根不传账号** → 那道门自然放行。所以数据层必须自己有门。
  //
  // ⚠️ 做成「不给就拒」而不是「不给就放行」：后者在忘记接线时**静默越权**，
  //    而这一轮审计里最贵的几条缺陷全是那个形态
  //    （今天刚在 renewExclusion 上踩过：key 里带账号而门禁不认）。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  assert.ok(/visibility_required/.test(src),
    "跨账号查询没有「缺可见集合就拒」的硬门 —— 忘了接线就是静默越权");
  const gf = src.slice(src.indexOf("export async function getFindings"));
  const body = gf.slice(0, gf.indexOf("\n}\n") + 1);
  assert.ok(/if \(allAccounts\)[\s\S]{0,300}?visibility_required/.test(body),
    "那道硬门不在 allAccounts 分支里 —— 单账号路径不该被它挡住");
  // 过滤真的发生在数据层
  assert.ok(/visible\.has\(String\(it\.account_id/.test(src),
    "拿到 items 之后没有按可见账号过滤");
});

t("★★ 统一视图走 GSI1，键与 Python 侧一致", () => {
  const keys = readFileSync(join(HERE, "..", "inspection_keys.mjs"), "utf8");
  const py = readFileSync(
    join(REPO, "inspection", "adapters", "keys.py"), "utf8");
  // 🔴 写侧在 Python（`_finding_to_item`），读侧在 BFF。两边对不上的表现是
  //    统一视图**永远是空的**，而查询成功、不报错。
  const mjs = (keys.match(/FINDING_GSI1PK = "([^"]+)"/) || [])[1];
  const pyv = (py.match(/FINDING_GSI1PK = "([^"]+)"/) || [])[1];
  assert.ok(mjs, "BFF 侧没有 FINDING_GSI1PK");
  assert.strictEqual(mjs, pyv,
    `GSI1 分区键两侧不一致：BFF=${mjs} Python=${pyv} —— 统一视图会永远是空的`);
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  assert.ok(/IndexName: FINDING_GSI1_INDEX/.test(src),
    "读侧没用 GSI —— 跨账号查询会退回全表扫或报错");
});

// ---------------------------------------------------------------------------
// 排除标注的 region 匹配（2026-08-27）
//
// 🔴 这一组存在的理由：把匹配改回裸 `resource_id` 之后，原来那 75 条
//    **全绿** —— 唯一相关的断言是「资源清单不列 EC2」那条源码文本检查。
//    而这个缺陷会让客户从 UI 上永久排不掉某个 region 的资源。
// ---------------------------------------------------------------------------
t("★★★ 排除标注按 <region>#<service>#<id> 匹配，不跨 region", async () => {
  const { exclusionKeys, rowIsExcluded } = await import("../inspection.mjs");
  const keys = exclusionKeys([
    { resource_id: "prod-mysql", region: "us-east-1", service: "rds" },
  ]);
  const iad = { resource_id: "prod-mysql", region: "us-east-1", service: "rds" };
  const nrt = { resource_id: "prod-mysql", region: "ap-northeast-1", service: "rds" };
  assert.equal(rowIsExcluded(iad, keys), true, "自己那个 region 该命中");
  assert.equal(rowIsExcluded(nrt, keys), false,
    "东京那台被 us-east-1 的排除记录连带标成已排除 —— "
    + "UI 会把它的 checkbox 锁掉，而巡检照常在报它");
});

t("★★★ 键含 service —— 同 region 同名的 RDS 与 EC 不互相标", async () => {
  /* 🔴 `notiops-tb-*` 这种多服务同前缀部署一撞就中。`scope.py` 四层索引
     每一层的键**都**含 service（`(acct, svc, id)`），少这一段就是过度匹配
     —— 也就是「UI 说已排除、checkbox 灰掉、而后端照常巡检」，那台资源
     从界面上再也排不掉。 */
  const { exclusionKeys, rowIsExcluded } = await import("../inspection.mjs");
  const keys = exclusionKeys([
    { resource_id: "notiops-tb", region: "ap-northeast-1", service: "rds" },
  ]);
  const rds = { resource_id: "notiops-tb", region: "ap-northeast-1", service: "rds" };
  const ec = { resource_id: "notiops-tb", region: "ap-northeast-1",
               service: "elasticache" };
  assert.equal(rowIsExcluded(rds, keys), true);
  assert.equal(rowIsExcluded(ec, keys), false,
    "同名的 ElastiCache 被 RDS 的排除记录标成已排除 —— 再也排不掉");
});

t("★★ region 为空的老条目跨区域生效（与 scope.py::covers_region 一致）", async () => {
  const { exclusionKeys, rowIsExcluded } = await import("../inspection.mjs");
  // scope.py: `return not self.region or self.region == region`
  const keys = exclusionKeys([
    { resource_id: "prod-mysql", region: "", service: "rds" },
  ]);
  for (const reg of ["us-east-1", "ap-northeast-1", "eu-west-1"]) {
    assert.equal(rowIsExcluded(
      { resource_id: "prod-mysql", region: reg, service: "rds" }, keys),
    true, `region="" 的条目该覆盖 ${reg}`);
  }
});

t("★ 没有 resource_id 的条目不产生键", async () => {
  const { exclusionKeys } = await import("../inspection.mjs");
  assert.equal(exclusionKeys([{ region: "us-east-1" }, {}]).size, 0);
});

// ---------------------------------------------------------------------------
// 通配（整服务 / 整账号）—— 老代码生成 `*#*` 这种键，而查的是
// `<region>#<真实资源名>`，**永远不可能相等**。表现是整账号排除在选择器里
// 零信号：客户明明整账号退出了巡检，每一行还是「未排除」+ checkbox 可勾，
// 于是又逐台勾一遍（写进去一堆冗余条目），而真正生效的是那条 `*` 行。
// ---------------------------------------------------------------------------
t("★★★ 整账号排除（service=* / resource_id=*）标到该账号每一行", async () => {
  const { exclusionKeys, rowIsExcluded } = await import("../inspection.mjs");
  const keys = exclusionKeys([
    { resource_id: "*", service: "*", region: "", level: "account" },
  ]);
  for (const row of [
    { resource_id: "a", service: "rds", region: "us-east-1" },
    { resource_id: "b", service: "elasticache", region: "ap-northeast-1" },
  ]) {
    assert.equal(rowIsExcluded(row, keys), true,
      "整账号排除在选择器里零信号 —— 客户会再逐台勾一遍");
  }
});

t("★★★ 整服务排除只标那个 service", async () => {
  const { exclusionKeys, rowIsExcluded } = await import("../inspection.mjs");
  const keys = exclusionKeys([
    { resource_id: "*", service: "rds", region: "", level: "service" },
  ]);
  assert.equal(rowIsExcluded(
    { resource_id: "a", service: "rds", region: "us-east-1" }, keys), true);
  assert.equal(rowIsExcluded(
    { resource_id: "a", service: "elasticache", region: "us-east-1" }, keys),
  false, "整 RDS 的排除把 ElastiCache 也标了");
});

t("★★ 整服务排除带 region 时只在那个 region 生效", async () => {
  const { exclusionKeys, rowIsExcluded } = await import("../inspection.mjs");
  const keys = exclusionKeys([
    { resource_id: "*", service: "rds", region: "us-east-1", level: "service" },
  ]);
  assert.equal(rowIsExcluded(
    { resource_id: "a", service: "rds", region: "us-east-1" }, keys), true);
  assert.equal(rowIsExcluded(
    { resource_id: "a", service: "rds", region: "ap-northeast-1" }, keys), false);
});

t("★★★ service 认不出的通配行**不生成键**（宁可匹配不足）", async () => {
  /* `put_exclusion` 会拒写 service 为空的行，但历史行可能是空的。
     那时「它排了多大范围」是不确定的 —— 按整账号算会把整个账号锁死
     （过度匹配 = 再也排不掉），所以这里选择零信号。 */
  const { exclusionKeys } = await import("../inspection.mjs");
  assert.equal(exclusionKeys([{ resource_id: "*", service: "", region: "" }]).size,
    0, "service 空的通配行被当成整账号了 —— 会把整个账号的 checkbox 锁死");
});

t("★★★ 集群/副本组级排除连带成员，实例级的不连带", async () => {
  /* `scope.py` 的 `by_container` 索引**只收** level ∈ {cluster, group}。
     查 `inst:` 会让「某台实例名恰好等于另一个集群名」时整个集群被标死。 */
  const { exclusionKeys, rowIsExcluded } = await import("../inspection.mjs");
  const grp = exclusionKeys([{ resource_id: "rg-1", region: "us-east-1",
                               service: "elasticache", level: "group" }]);
  const member = { resource_id: "rg-1-001", service: "elasticache",
                   region: "us-east-1", cluster_id: "rg-1" };
  assert.equal(rowIsExcluded(member, grp), true, "副本组成员没被连带标上");
  // 副本组那一行自己（cluster_id 为空）也要命中 —— 那正是客户点的那一行。
  assert.equal(rowIsExcluded({ resource_id: "rg-1", service: "elasticache",
                               region: "us-east-1", cluster_id: "" }, grp), true);

  const inst = exclusionKeys([{ resource_id: "rg-1", region: "us-east-1",
                                service: "elasticache", level: "instance" }]);
  assert.equal(rowIsExcluded(member, inst), false,
    "实例级条目连带标了整个集群 —— 同名实例与集群一撞，整组再也排不掉");
});

// ---------------------------------------------------------------------------
// 过期 —— `ExclusionIndex.build` 第一件事就是 `if not e.is_active(today)`。
// R1.3 的默认有效期是 30 天，也就是说**每一条排除都会走到这个状态**。
// ---------------------------------------------------------------------------
t("★★★ 过期条目不参与匹配（expired 由 shapeExclusion 算好）", async () => {
  const { exclusionKeys } = await import("../inspection.mjs");
  assert.equal(exclusionKeys([{
    resource_id: "prod-mysql", region: "us-east-1", service: "rds",
    expires_at: "2026-08-01", expired: true,
  }]).size, 0, "过期条目还在标「已排除」—— 徽标在、checkbox 灰着，"
    + "而巡检已经在报它了");
});

t("★★★ 没带 expired 字段时按 today >= expires_at 自己算", async () => {
  /* 与 `is_active` 的 `today < expires_at` 互为反面，**边界那一天算失效**
     （`shared/queries/whitelist.py` 同口径：该日起失效，不含当日）。 */
  const { exclusionKeys } = await import("../inspection.mjs");
  const row = (expires) => ({
    resource_id: "prod-mysql", region: "us-east-1", service: "rds",
    expires_at: expires,
  });
  const opts = { today: "2026-09-02" };
  assert.equal(exclusionKeys([row("2026-09-02")], opts).size, 0, "边界当天该失效");
  assert.equal(exclusionKeys([row("2026-09-01")], opts).size, 0);
  assert.equal(exclusionKeys([row("2026-09-03")], opts).size, 1, "还没到期就该生效");
  assert.equal(exclusionKeys([row("")], opts).size, 1, "永不过期的被算成过期了");
});

t("★★★ exclusionLayer 回传命中的层级（读侧要用它决定说什么话）", async () => {
  /* 🔴 整账号 / 整服务 / 集群级排除会让选择器里 checkbox 变灰，而客户在那个
     弹层里**撤不掉**它们（只能去排除清单删那一行）。只回布尔值的话界面
     只能说「已排除」—— 等于摆一个用户无法解决的问题，而客户会以为是
     自己勾错了，反复点那个灰掉的 checkbox。 */
  const { exclusionKeys, exclusionLayer } = await import("../inspection.mjs");
  const row = { resource_id: "db-1", service: "rds", region: "us-east-1",
                cluster_id: "aur-1" };
  const cases = [
    [{ resource_id: "db-1", service: "rds", region: "us-east-1" }, "instance"],
    [{ resource_id: "aur-1", service: "rds", region: "us-east-1",
       level: "cluster" }, "container"],
    [{ resource_id: "*", service: "rds", region: "" }, "service"],
    [{ resource_id: "*", service: "*", region: "" }, "account"],
  ];
  for (const [entry, want] of cases) {
    assert.equal(exclusionLayer(row, exclusionKeys([entry])), want);
  }
  assert.equal(exclusionLayer(row, exclusionKeys([])), "", "没命中该回空串");
});

t("★★★ 层级顺序即优先级 —— 越具体越先返回（UI 显示最精确那条的理由）", async () => {
  const { exclusionKeys, exclusionLayer } = await import("../inspection.mjs");
  const row = { resource_id: "db-1", service: "rds", region: "us-east-1",
                cluster_id: "aur-1" };
  // 四条同时存在时，`scope.py::is_excluded` 返回 instance 那一条。
  const keys = exclusionKeys([
    { resource_id: "*", service: "*", region: "" },
    { resource_id: "*", service: "rds", region: "" },
    { resource_id: "aur-1", service: "rds", region: "us-east-1", level: "cluster" },
    { resource_id: "db-1", service: "rds", region: "us-east-1" },
  ]);
  assert.equal(exclusionLayer(row, keys), "instance");
});

t("★★★ rowIsExcluded 只是 exclusionLayer 的布尔壳（不许各写一份）", async () => {
  /* 两份判据分叉的表现是「徽标说整账号排除、而 checkbox 可勾」这种
     自相矛盾，而两边各自的用例都是绿的。 */
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const i = src.indexOf("export function rowIsExcluded(");
  assert.ok(i > 0, "rowIsExcluded 不在了");
  const body = src.slice(i, src.indexOf("\n}", i));
  assert.ok(/return Boolean\(exclusionLayer\(/.test(body),
    "rowIsExcluded 里又写了一份判据");
  assert.ok(!/keys\.has\(/.test(body), "rowIsExcluded 里还在自己查键");
});

t("★★★ getResources 回传 excluded_by，且与 excluded_in 成对", async () => {
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const i = src.indexOf("export async function getResources(");
  const body = src.slice(i);
  assert.ok(/r\.excluded_by/.test(body), "没回传 excluded_by");
  /* `excluded_in` 必须**从 `excluded_by` 推导**，不许再各算一遍 ——
     两处分叉就是「灰着但徽标说没排除」。 */
  assert.ok(/excluded_in = \["high", "idle"\]\.filter\(\(k\) => r\.excluded_by\[k\]\)/
    .test(body), "excluded_in 没有从 excluded_by 推导");
});

t("★★★ getResources 调 exclusionKeys 时要传 today", async () => {
  // 不传的话「没带 expired 字段」那一路静默失效 —— 而那是将来新调用点的形态。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const i = src.indexOf("export async function getResources(");
  assert.ok(i > 0);
  const body = src.slice(i);
  const call = /exclusionKeys\(scope\.exclusions\?\.\[kind\] \|\| \[\],\s*\{\s*today:/
    .test(body);
  assert.ok(call, "getResources 调 exclusionKeys 没传 today");
});

t("★★ getResources 用的是这两个纯函数，没有另写一份匹配", async () => {
  // ⚠️ 抽出纯函数之后最容易的退化是「函数在，但 getResources 里还留着
  //    一份裸 resource_id 的旧逻辑」。查调用点。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function getResources"));
  const body = fn.slice(0, fn.indexOf("\n}\n"))
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(/exclusionKeys\(/.test(body), "getResources 没有调 exclusionKeys");
  /* ⚠️ 2026-09-02 起调的是 `exclusionLayer`（`rowIsExcluded` 变成它的布尔壳）
     —— 因为读侧要知道**命中的是哪一层**才能说清「这条在这里撤不掉」。
     两个都接受，但必须是这两个之一，不许在 getResources 里自己查键。 */
  assert.ok(/exclusionLayer\(|rowIsExcluded\(/.test(body),
    "getResources 既没调 exclusionLayer 也没调 rowIsExcluded");
  assert.ok(!/excluded\[k\]\.has\(r\.resource_id\)/.test(body),
    "getResources 里还留着裸 resource_id 的匹配");
  /* 键里含 region 与 service —— 少任一段都是过度匹配（UI 说已排除、
     checkbox 灰掉、而后端照常巡检 → 那台资源再也排不掉）。 */
  assert.ok(!/`\$\{[^`]*\}#\$\{r\.resource_id\}`/.test(body),
    "getResources 里又拼了一份键 —— 键的形状只该由 exclusionKeys 决定");
});

// ═══════════════════════════════════════════════════════════════════════════
// 排除清单的账号可见性（2026-09-01）
//
// 🔴 `/inspection/scope` 原来**完全不管账号**：PK 是 `inspscope#<kind>`，
//    账号只在 SK 第一段里，一次 Query 拿到全组织的排除条目。三重后果：
//      ① 越权   只能看 A 的人读到 B 的资源名 / 排除原因 / 创建人
//      ② 误导   页头选中 677，列表里混着 088 的整账号 `*` 行且无账号列
//      ③ 锁死   getResources 拿它标「已排除」并 disable checkbox，
//               而 exclusionKeys 的键里没有账号 → 另一账号的同名资源
//               把这一行锁死，从 UI 上再也排不掉（后端照常巡检、照常花钱）
//
// ⚠️ 与 `worstRunAcross` 那组同一个理由：过滤判据抽成纯函数才测得到。
//    留在 getScope 里就只有源码文本断言 —— 而这是一道**越权门**。
// ═══════════════════════════════════════════════════════════════════════════

const _ex = (acct, rid = "db-1", reg = "us-east-1") => ({
  SK: [acct, reg, "rds", rid].join("#"),
  account_id: acct, region: reg, service: "rds", resource_id: rid,
});

t("★★★ 只保留可见账号的排除条目", async () => {
  const { filterScopeRows } = await import("../inspection.mjs");
  const rows = [_ex("111111111111"), _ex("222222222222"), _ex("999999999999")];
  const got = filterScopeRows(rows, { visible: new Set(["111111111111"]) });
  assert.deepEqual(got.map((r) => r.account_id), ["111111111111"],
    "不可见账号的排除条目被读出来了 —— 资源名 / 原因 / 创建人全泄漏");
});

t("★★ visible=\"*\" （admin）不过滤", async () => {
  const { filterScopeRows } = await import("../inspection.mjs");
  const rows = [_ex("111111111111"), _ex("222222222222")];
  assert.equal(filterScopeRows(rows, { visible: "*" }).length, 2);
});

t("★★★ 指定 account 时只留那一个账号（页内筛选）", async () => {
  const { filterScopeRows } = await import("../inspection.mjs");
  const rows = [_ex("111111111111"), _ex("222222222222")];
  const got = filterScopeRows(rows, {
    account: "222222222222", visible: "*",
  });
  assert.deepEqual(got.map((r) => r.account_id), ["222222222222"],
    "选中 677 却看到 088 的条目 —— 客户实测到的那个形态");
});

t("★★★ account 参数不能绕过 visible", async () => {
  // 门禁在路由层（`q.account` 走 isAccountVisible），这里是纵深防御：
  // 两道门都过才留下。只判 account 的实现会让路由层一处漏配变成越权。
  const { filterScopeRows } = await import("../inspection.mjs");
  const got = filterScopeRows([_ex("999999999999")], {
    account: "999999999999", visible: new Set(["111111111111"]),
  });
  assert.deepEqual(got, [], "指定一个不可见的账号就读到了它的条目");
});

t("★★★ 认不出账号的存量行一律丢（fail-closed）", async () => {
  const { filterScopeRows, accountOfRow } = await import("../inspection.mjs");
  // 没有 account_id 属性，但 SK 首段是账号 → 回退认得出
  const legacy = { SK: "111111111111#us-east-1#rds#db-1" };
  assert.equal(accountOfRow(legacy), "111111111111");
  assert.equal(
    filterScopeRows([legacy], { visible: new Set(["111111111111"]) }).length, 1);
  // 两处都认不出 → 丢。放行是「只在存量数据上触发」的泄漏口：
  // 新写的行都有账号，所以测试与日常使用全绿。
  for (const junk of [{ SK: "garbage" }, { SK: "" }, {}, { account_id: "12" }]) {
    assert.deepEqual(filterScopeRows([junk], { visible: "*" }), [],
      `认不出账号的行被放行了: ${JSON.stringify(junk)}`);
  }
});

t("★★★ getScope 不给 visible 就拒（不给就放行 = 静默越权）", async () => {
  const { getScope } = await import("../inspection.mjs");
  const r = await getScope();
  assert.equal(r.ok, false);
  assert.equal(r.code, "visibility_required",
    "忘记接线时必须报错而不是返回全组织的数据");
  const r2 = await getScope({ account: "111111111111" });
  assert.equal(r2.code, "visibility_required", "只给 account 也要拒");
});

t("★★ getScope 校验 account 形状", async () => {
  const { getScope } = await import("../inspection.mjs");
  const r = await getScope({ account: "abc", visible: "*" });
  assert.equal(r.code, "bad_account");
});

// ---------------------------------------------------------------------------
// ★★★ 写入端点的账号可见性硬门（2026-09-02 review 抓到的 Critical 越权）
//
// 路由层把四个键名合成**一个标量**（`||` 短路），谁靠前谁遮住后面，
// 而后面那个才是端点真正用的。于是三条写入路都能绕：
//
//   POST /inspection/scope/high?account=<可见A>
//     body { account_id: "<不可见B>", level: "account", confirm_account_wide: true }
//     → 门禁看到 A 放行 → putExclusion 写 B ⇒ 把 B 整账号摘出巡检
//
// 数据层这道门是「不给 visible 就拒」，与 getScope / getFindings 同一套。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ★★★ worstRunAcross：partial 不是成功，且要说得出「少了哪个 region」
// ---------------------------------------------------------------------------

t("★★★ worstRunAcross 把 partial 排在 success 之前", async () => {
  const { worstRunAcross } = await import("../inspection.mjs");
  const today = new Date().toISOString().slice(0, 10);
  const mk = (acct, status, extra = {}) => ({
    run_type: "high", run_date: today, account_id: acct, status,
    completeness: 1, mode: "official", regions: null, ...extra,
  });
  // 🔴 partial 的语义是「有 region 没扫成」，而那些实例**压根没进 expected**
  //    → completeness 仍是 1.0 → 前端「完整度不足」那句补充语不出现
  //    → 上一版把它归到最后一档，界面给绿色 ✓「本轮未发现风险」。
  const got = worstRunAcross([mk("111111111111", "success"),
    mk("222222222222", "partial")], { runType: "high" });
  assert.equal(got.status, "partial",
    "partial 必须压过 success —— 否则漏扫一整个 region 会显示成「未发现风险」");
});

t("★★★ worstRunAcross 回传没扫成的 region 名字", async () => {
  const { worstRunAcross } = await import("../inspection.mjs");
  const today = new Date().toISOString().slice(0, 10);
  const got = worstRunAcross([{
    run_type: "high", run_date: today, account_id: "111111111111",
    status: "partial", completeness: 1, mode: "official",
    regions: { total: 3, scanned: 2, failed: ["us-west-2"] },
  }], { runType: "high" });
  assert.deepEqual(got.regions_failed, ["us-west-2"],
    "失败的 region 在 by_region 里连键都没有 —— 这是唯一能回答"
    + "「哪个 region 漏了」的地方");
});

t("★★ worstRunAcross 没有失败 region 时给空数组（不是 undefined）", async () => {
  const { worstRunAcross } = await import("../inspection.mjs");
  const today = new Date().toISOString().slice(0, 10);
  const got = worstRunAcross([{
    run_type: "high", run_date: today, account_id: "111111111111",
    status: "success", completeness: 1, mode: "official", regions: null,
  }], { runType: "high" });
  // 空数组 = 「都扫成了」；字段缺失 = 「存量 BFF，不知道」。两者要可区分。
  assert.deepEqual(got.regions_failed, []);
});

t("★★ 前后端的 run 状态 rank 同序（分叉会让空态文案与真实原因错位）", async () => {
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const fe = readFileSync(join(HERE, "..", "..", "..", "frontend", "chat-app",
    "src", "components", "InspectionDashboard.tsx"), "utf8");
  for (const [label, body] of [["BFF", src], ["前端", fe]]) {
    assert.ok(/status === "partial"\) return 4/.test(body),
      `${label} 的 rank 没把 partial 排在第 4 档 —— 两边必须同序`);
    assert.ok(/return 5;/.test(body),
      `${label} 的 rank 最后一档应当是 5（partial 插进来之后 success 后移）`);
  }
});

t("★★★ putExclusion 不给 visible 就拒（不给就放行 = 静默越权）", async () => {
  const { putExclusion } = await import("../inspection.mjs");
  const r = await putExclusion("high", {
    account_id: "111111111111", service: "rds", resource_id: "db-1",
    region: "us-east-1", level: "instance", reason: "x",
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, "visibility_required",
    "忘记接线时必须拒，而不是替调用方放行");
});

t("★★★ putExclusion 拒写不可见账号（body.account_id 那条越权路）", async () => {
  const { putExclusion } = await import("../inspection.mjs");
  // 这正是绕过路由层的那个请求体 —— 与前端 `submitWide` 发的形状一致
  // （service/resource_id 显式传 `*`，level=account，带二次确认标记）。
  const r = await putExclusion("high", {
    account_id: "999999999999", service: "*", resource_id: "*",
    level: "account", reason: "越权尝试", confirm_account_wide: true,
  }, { visible: new Set(["111111111111"]) });
  assert.equal(r.ok, false);
  assert.equal(r.code, "account_forbidden",
    "整账号排除没有任何运行时信号 —— 漏掉这道门 30 天里没人会发现");
});

t("★★★ putExclusion 的门在 normalizeExclusion **之后**", async () => {
  // 🔴 `level: "account"` 会被归一成双通配，而账号来自 body.account_id。
  //    门放在归一**之前**就又变成「校验一个、写另一个」。
  //    这里用一个可见账号 + level=account 验证归一后的账号仍被校验通过，
  //    而上一条用不可见账号验证会被拒 —— 两条合起来钉住「门读的是 item」。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function putExclusion"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  const iNorm = body.indexOf("normalizeExclusion(");
  const iGate = body.indexOf("denyIfInvisible(");
  assert.ok(iNorm >= 0 && iGate >= 0, "两者都该在 putExclusion 里");
  assert.ok(iGate > iNorm,
    "denyIfInvisible 必须在 normalizeExclusion 之后 —— "
    + "归一那一步才把 body.account_id 变成真正会写的 item.account_id");
  assert.ok(/denyIfInvisible\(item\.account_id/.test(body),
    "门必须校验 item.account_id（端点真正写的那个），不是 body 里任何字段");
});

for (const [name, fnName] of [["renewExclusion", "renewExclusion"],
  ["deleteExclusion", "deleteExclusion"]]) {
  t(`★★★ ${name} 不给 visible 就拒`, async () => {
    const mod = await import("../inspection.mjs");
    const r = await mod[fnName]("high", "111111111111#us-east-1#rds#db-1");
    assert.equal(r.ok, false);
    assert.equal(r.code, "visibility_required");
  });

  t(`★★★ ${name} 按 key 首段校验账号，不看请求体`, async () => {
    const mod = await import("../inspection.mjs");
    const r = await mod[fnName]("high", "999999999999#us-east-1#rds#db-1",
      { visible: new Set(["111111111111"]) });
    assert.equal(r.ok, false);
    assert.equal(r.code, "account_forbidden",
      "路由层的 || 链会让 body.account_id 遮住 key —— "
      + "数据层必须只认 key 首段（那是真正会改的那一行）");
  });
}

t("★★★ deleteExclusion 漏门是越权**读**（响应带被删行的属性）", async () => {
  // 响应回传 account_id / resource_id / level / reason —— 也就是说
  // 一次「删不存在的 key」都能探到别人账号的排除内容。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function deleteExclusion"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(/denyIfInvisible\(/.test(body), "deleteExclusion 丢了可见性门");
  const iGate = body.indexOf("denyIfInvisible(");
  const iSend = body.indexOf("ddb.send(");
  assert.ok(iGate < iSend, "门必须在打 DDB 之前 —— 之后就已经读到了");
});

t("★★★ 三个写入端点的路由都把 visible 传下去了", async () => {
  const src = readFileSync(join(HERE, "..", "index.mjs"), "utf8");
  for (const [label, re] of [
    ["scope", /putInspectionExclusion\([\s\S]{0,220}?visibleAccountSet\(/],
    ["renew", /renewInspectionExclusion\([\s\S]{0,220}?visibleAccountSet\(/],
    ["delete", /deleteInspectionExclusion\([\s\S]{0,220}?visibleAccountSet\(/],
  ]) {
    assert.ok(re.test(src),
      `/${label} 路由没有把 visibleAccountSet 传给数据层 —— `
      + "数据层那道门就成了摆设（它会直接 visibility_required，"
      + "表现是那个功能整个用不了，所以这条会被立刻发现；"
      + "但反过来把门删掉就是静默越权）");
  }
});

t("★★★ 门禁逐个校验账号候选，不是 || 取第一个真值", async () => {
  // 🔴 `||` 短路是那条 Critical 越权的根因：q.account 靠前，
  //    于是 body.account_id 永远不被校验。
  const src = readFileSync(join(HERE, "..", "index.mjs"), "utf8");
  const i = src.indexOf("accountCandidates");
  assert.ok(i > 0, "门禁应当有一个 accountCandidates 数组并逐个校验");
  const seg = src.slice(i, i + 900);
  assert.ok(/for \(const cand of accountCandidates\)/.test(seg),
    "必须逐个遍历校验");
  assert.ok(/isAccountVisible\(id,/.test(seg), "每个候选都要过 isAccountVisible");
  // 反向：不许再出现把候选合成一个标量的老写法
  assert.ok(!/const requestedAccount = String\(\s*\(q && q\.account\)\s*\|\|/
    .test(src),
    "`requestedAccount = a || b || c` 的老写法回来了 —— "
    + "那正是越权的根因（靠前的键遮住后面的）");
});

t("★★ getScope 真的调了 filterScopeRows，没有另写一份过滤", async () => {
  // ⚠️ 抽出纯函数之后最容易的退化是「函数在，但 getScope 里还是裸 map」。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function getScope"));
  const body = fn.slice(0, fn.indexOf("\n}\n"))
    .split("\n").filter((l) => !l.trim().startsWith("//")
      && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");
  assert.ok(/filterScopeRows\(/.test(body), "getScope 没有调 filterScopeRows");
  assert.ok(/visibility_required/.test(body), "getScope 丢了 visible 硬门");
});

t("★★★ getResources 标「已排除」时只取当前账号的清单", async () => {
  // exclusionKeys 的键里没有账号，所以拿全组织的清单来标 = 另一个账号的
  // 同名资源把这一行锁死。`notiops-tb-*` 这种多账号同名部署一撞就中。
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const fn = src.slice(src.indexOf("export async function getResources"));
  const body = fn.slice(0, fn.indexOf("\n}\n"))
    .split("\n").filter((l) => !l.trim().startsWith("//")
      && !l.trim().startsWith("*")).join("\n");
  const call = /getScope\(\s*\{([^}]*)\}\s*\)/.exec(body);
  assert.ok(call, "getResources 里的 getScope 调用不带参数 —— 会拿到全组织的清单");
  assert.ok(/account:\s*acct/.test(call[1]),
    `getScope 调用没有把当前账号传下去: ${call[1]}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// last_run 的跨账号聚合（R9.11，2026-08-31）
//
// 🔴 finding 列表**默认就是跨账号的**（前端 `getInspectionFindings(kind)`
//    不传账号 → `all=1`），而 run 记录的 SK 是账号 —— 一次 Query 拿到的是
//    所有账号那一轮的记录。原来取「按日期降序的第一条」= 任意一个账号最新的
//    那次，于是「A 跑了、B 没跑」被显示成「跑过了 → 本轮未发现风险」。
// ═══════════════════════════════════════════════════════════════════════════

const _TODAY = new Date().toISOString().slice(0, 10);
const _YDAY = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const _run = (o) => ({
  run_type: "high", status: "success", completeness: 1, mode: "official",
  run_date: _TODAY, ...o,
});
const _VIS2 = () => new Set(["111111111111", "222222222222"]);

t("★★★ 跨账号：一个账号连 run 行都没有 → 不能报「跑过了」", () => {
  const runs = [_run({ account_id: "111111111111" })];
  const got = worstRunAcross(runs, {
    runType: "high", crossAccount: true, visible: _VIS2(),
  });
  assert.equal(got.run_date, "",
    "B 没有任何 run 记录，却报出了 A 的 run_date —— 前端会渲染"
    + "「本轮未发现风险」，而 B 从来没被巡检过（R9.11）");
});

t("★★★ 跨账号：一个账号今天没跑 → 取那个落后的", () => {
  const runs = [
    _run({ account_id: "111111111111", run_date: _TODAY }),
    _run({ account_id: "222222222222", run_date: _YDAY }),
  ];
  const got = worstRunAcross(runs, {
    runType: "high", crossAccount: true, visible: _VIS2(),
  });
  assert.equal(got.run_date, _YDAY, "取的是最新那条而不是最落后那条");
});

t("★★★ 跨账号：任一账号 failed 优先报出来", () => {
  const runs = [
    _run({ account_id: "111111111111" }),
    _run({ account_id: "222222222222", status: "failed" }),
  ];
  const got = worstRunAcross(runs, {
    runType: "high", crossAccount: true, visible: _VIS2(),
  });
  assert.equal(got.status, "failed",
    "有账号跑失败却报 success —— 空列表会被解释成「没有风险」");
});

t("★★ 跨账号：按可见账号过滤（与 finding 列表那一侧一致）", () => {
  const runs = [
    _run({ account_id: "111111111111" }),
    _run({ account_id: "999999999999", status: "failed" }),   // 不可见
  ];
  const got = worstRunAcross(runs, {
    runType: "high", crossAccount: true,
    visible: new Set(["111111111111"]),
  });
  assert.equal(got.status, "success",
    "不可见账号的运行状态漏出来了（finding 那一侧是显式过滤过的）");
});

t("★★ 全部跑完且都是今天 → success", () => {
  const runs = [
    _run({ account_id: "111111111111" }),
    _run({ account_id: "222222222222" }),
  ];
  const got = worstRunAcross(runs, {
    runType: "high", crossAccount: true, visible: _VIS2(),
  });
  assert.equal(got.status, "success");
  assert.equal(got.run_date, _TODAY);
});

t("★★ 单账号路径不做跨账号聚合", () => {
  const runs = [_run({ account_id: "111111111111" })];
  const got = worstRunAcross(runs, { runType: "high", crossAccount: false });
  assert.equal(got.run_date, _TODAY);
  assert.equal(got.status, "success");
});

t("★★ 只挑本轮类型；那一类一条都没有 → null（前端说「状态未知」）", () => {
  const runs = [_run({ account_id: "111111111111", run_type: "idle" })];
  assert.equal(
    worstRunAcross(runs, { runType: "high", crossAccount: false }), null,
    "拿不到记录必须是 null —— 前端据此说「状态未知」而不是「没风险」");
});

t("★★★ rank 分档与前端 TriageEmpty 的 rank 逐档一致", () => {
  // 🔴 两处必须**同序**，否则 BFF 挑出「最值得说」的那条之后前端又按另一套
  //    重排 —— 表现是「BFF 认为最该说的是 failed，前端认为是没跑」，
  //    空态文案与真实原因错位。
  //
  // ⚠️ 判据是从**两边的源码**各抽一份 `(条件 → 档位)` 序列再比对，
  //    不是在测试里手写期望值。手写的话两边一起改错了照样绿。
  const here = dirname(fileURLToPath(import.meta.url));
  const pick = (src, re, what) => {
    const m = src.match(re);
    assert.ok(m, `${what} 里找不到 rank —— 这条断言的前提坏了`);
    const pairs = [...m[1].matchAll(/if \((.*?)\) return (\d+);/g)]
      .map(([, cond, n]) => [cond.replace(/\s+/g, ""), Number(n)]);
    assert.ok(pairs.length >= 4, `${what} 的 rank 只抽到 ${pairs.length} 档`);
    return pairs;
  };
  const front = pick(
    readFileSync(join(here,
      "../../../frontend/chat-app/src/components/InspectionDashboard.tsx"), "utf8"),
    /const rank = \(r: FindingsData\["last_run"\]\) => \{([\s\S]*?)\n {2}\};/,
    "前端 TriageEmpty");
  const back = pick(
    readFileSync(join(here, "../inspection.mjs"), "utf8"),
    /const rank = \(r\) => \{([\s\S]*?)\n {2}\};/,
    "BFF worstRunAcross");
  assert.deepEqual(back, front,
    "BFF 与前端的 rank 分档不一致：\n"
    + `  BFF ：${JSON.stringify(back)}\n`
    + `  前端：${JSON.stringify(front)}\n`
    + "BFF 挑出的「最值得说」那条会被前端按另一套重排，空态文案与真实原因错位");
});

// ═══════════════════════════════════════════════════════════════════════════
// 运维信号的聚合（2026-09-02 review #6）
//
// 共同点：`shapeRun` 早就把 `skipped_by_gate` / `gaps` / `batches_failed`
// 逐行带出来了，但没有任何聚合，读侧也零渲染 —— 这个仓库里反复批评的
// 「算好了没人取」。
// ═══════════════════════════════════════════════════════════════════════════
t("★★★ getOverview 回传 runs_total（截断前的轮数）与 runs_limit", async () => {
  /* 🔴 前端那句「显示 N / M 轮」的 M 原来取 `runs.length` —— 也就是已经被
     `slice(0, 20)` 截过的数。于是它说「显示 3 / 20 轮」而真实可能是 137 轮。
     findings 侧有 `truncated_at` 专门解决这件事，runs 侧是静默截断。 */
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const i = src.indexOf("export async function getOverview(");
  assert.ok(i > 0);
  const body = src.slice(i);
  assert.ok(/runs_total: runs\.length/.test(body), "没回传 runs_total");
  assert.ok(/runs_limit: RUNS_LIMIT/.test(body), "没回传 runs_limit");
  /* ⚠️ `runs_total` 必须在 `slice` **之前**取 —— 取 slice 之后的等于没修。 */
  assert.ok(/runs: runs\.slice\(0, RUNS_LIMIT\)/.test(body),
    "截断没走 RUNS_LIMIT 常量（前端要靠它说「只回传最近 N 轮」）");
});

t("★★★ getOverview 聚合 skipped_by_gate / gaps / batches_failed", async () => {
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const i = src.indexOf("export async function getOverview(");
  const body = src.slice(i);
  for (const f of ["skipped_by_gate: skippedByGate", "gaps: gapsTotal",
    "batches_failed: batchesFailed"]) {
    assert.ok(body.includes(f), `getOverview 没回传 ${f}`);
  }
  /* 🔴 聚合口径必须是**未截断**的 runs（与 dispatch_gap 一致）——
     用 slice 之后的会让「派发缺口 37」在 20 行里加不出来，
     而那个数本身反而变小了（少报）。 */
  const agg = body.slice(0, body.indexOf("return {"));
  /* ⚠️ 判据要**否定 slice**，不能只查 `for (const r of runs)` 字面 ——
     `for (const r of runs.slice(0, RUNS_LIMIT))` 里含那个子串，
     反向注入实测这条会绿（第一版就是，19/20）。 */
  assert.ok(/for \(const r of runs\)/.test(agg),
    "skipped_by_gate 的聚合不是在未截断的 runs 上做的");
  assert.ok(!/of runs\.slice\(/.test(agg),
    "聚合在**截断后**的 runs 上做 —— 那几个总数会变小（少报），"
    + "而客户看到的「派发缺口 N」本该是全部轮的累计");
  /* `gaps` / `batches_failed` 也要在未截断的 runs 上累加。 */
  for (const f of ["r.gaps", "r.batches_failed"]) {
    const line = agg.split("\n").find((l) => l.includes(f)) || "";
    assert.ok(/runs\.reduce\(/.test(line),
      `${f} 的累加不是在未截断的 runs 上做的：${line.trim()}`);
  }
});

t("★★★ queryFindings 按 skip_reason 拆 without_judgment", async () => {
  /* 🔴 `gating.SkipReason` 的 docstring：「缺任何一种都会退化成『这条没有
     AI 分析』这句无信息的话，而客户接着就会问『是坏了还是省钱』—— 那是
     两个完全不同的答案」。后端分了六档，读侧压成一个数字。 */
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  assert.ok(/without_judgment_by_reason: withoutJudgmentByReason/.test(src),
    "queryFindings 没回传 without_judgment_by_reason");
  /* 分档必须从**同一批** finding 上数 —— 各自过滤一遍会让总数与分档之和不等。 */
  assert.ok(/const missingJudgment = rows\.filter\(/.test(src),
    "总数与分档不是从同一批 finding 上算的");
  assert.ok(/const withoutJudgment = missingJudgment\.length/.test(src),
    "without_judgment 没有从 missingJudgment 推导");
  /* `unknown` 而不是空串键：JSON 里空字符串键能表达但读起来像 bug。 */
  assert.ok(/\|\| "unknown"/.test(src), "空 skip_reason 没有归到 unknown");
});

t("★★★ 汇总之后不许再有用例（否则它们静默不执行）", async () => {
  /* 🔴 这个文件顶部的注释已经记着这个坑：「汇总必须在文件最末尾。它带
     `process.exit(1)`，放在中间会让后面的用例根本不执行 —— 而计数只报
     前半部分，看起来『全部通过』。实测踩过：追加 18 条用例后仍然只报
     20 passed。」

     而我 2026-09-02 又踩了一次（追加 4 条，计数不变）。**注释挡不住**，
     所以改成结构断言：汇总之后不许再出现 `t(` 调用。

     ⚠️ 判据是「汇总那行 `console.log` 之后」而不是「`process.exit` 之后」——
        失败路径才走 exit，成功路径是走到 log 就结束。 */
  const self = readFileSync(new URL(import.meta.url), "utf8");
  /* ⚠️ `lastIndexOf` 而不是 `indexOf`：这一行本身就包含那个搜索串，
     用 `indexOf` 会命中**这条测试自己**，于是 `tail` 从这里开始，
     把它下面所有正常的用例都误报成 orphan（第一次写就是这样，
     它立刻「抓到」了一条根本没问题的用例）。 */
  const i = self.lastIndexOf("console.log(`inspection.test.mjs: ${pass} passed");
  assert.ok(i > 0, "汇总那行不在了 —— 这条测试的前提坏了");
  const tail = self.slice(i);
  const orphans = tail.split("\n").filter((l) => /^t\(/.test(l.trim()));
  assert.equal(orphans.length, 0,
    `汇总之后还有 ${orphans.length} 条用例，它们**不会执行**：\n`
    + orphans.map((l) => "  " + l.slice(0, 60)).join("\n"));
});

t("★★★ NEEDS_NO_AI 那几档不该出现在 without_judgment_by_reason 里", async () => {
  /* 它们本来就不需要判读，不算「缺」—— 上面的过滤已经排除了。
     出现在分档里的表现是界面说「deterministic 12」，而那 12 条完全正常。 */
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const i = src.indexOf("const missingJudgment = rows.filter(");
  const j = src.indexOf("const withoutJudgmentByReason", i);
  const filt = src.slice(i, j);
  assert.ok(/NEEDS_NO_AI\.has/.test(filt), "过滤里不看 NEEDS_NO_AI 了");
  assert.ok(/DETERMINISTIC_KINDS\.has/.test(filt),
    "过滤里不看 DETERMINISTIC_KINDS 了（存量行会被算成缺判读）");
});

// ═══════════════════════════════════════════════════════════════════════════
// 下一轮时刻与停用（2026-09-02 review #6b：D12 / D13）
// ═══════════════════════════════════════════════════════════════════════════
t("★★★ nextRunFor 停用时返回空串（不照算一个时刻）", async () => {
  /* 🔴 原来 PUT 无条件算 —— 于是「取消启用 → 保存」的结果是 header 上一个
     红色「已停用」徽章，正下方一条绿色「下一轮: 02:00」，两句直接矛盾，
     而 `schedule.py` 的 `if not cfg.enabled: continue` 说明那一轮压根不跑。 */
  const { nextRunFor, nextRunUtc } = await import("../inspection.mjs");
  assert.equal(nextRunFor(false, "02:00", null), "", "停用了还算下一轮");
  // 启用时必须与 nextRunUtc 完全一致（不是另写一份）
  assert.equal(nextRunFor(true, "02:00", null), nextRunUtc("02:00", null));
});

t("★★★ GET 与 PUT 走同一个 nextRunFor（不许各写一份）", async () => {
  /* 两处各写一遍的表现是「保存后说不跑、刷新后又说跑」这种自相矛盾，
     而 UI 那侧只有一个渲染门，它信任这个字段。 */
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.split("//")[0]).join("\n");
  const calls = (code.match(/nextRunFor\(/g) || []).length;
  assert.ok(calls >= 2, `nextRunFor 只被调用 ${calls} 次 —— GET 或 PUT 有一处没走它`);
  /* PUT 那侧不许再直接调 nextRunUtc（绕过停用判据）。 */
  const putIdx = code.indexOf("next_run_utc: nextRunFor");
  assert.ok(putIdx > 0, "PUT 没走 nextRunFor");
  assert.ok(!/next_run_utc: nextRunUtc\(/.test(code),
    "有一处 next_run_utc 直接调 nextRunUtc，绕过了停用判据");
});

t("★★★ shapeSchedule 回传 next_run_utc（GET 也要有）", async () => {
  /* 🔴 此前只有 PUT 回传它 —— 于是「下一轮」只在刚保存完那一下存在，
     刷新页面就没了。而 `at_utc` / `weekdays` 一直在手上。 */
  const src = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
  const i = src.indexOf("function shapeSchedule(");
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf("\n}", i));
  assert.ok(/next_run_utc: nextRunFor\(/.test(body),
    "shapeSchedule 没回传 next_run_utc");
  /* enabled 的缺省要与那一行的 `enabled` 字段同口径（默认 true）——
     两处不一致会让「库里没有这一行」时下一轮显示成空。 */
  assert.ok(/SCHEDULE_DEFAULTS\.enabled/.test(body),
    "next_run_utc 的 enabled 判据没走 SCHEDULE_DEFAULTS");
});

// ---------------------------------------------------------------------------
// D22：skill 门禁结论的读侧接线（`shapeFinding` 的三个新字段）
// ---------------------------------------------------------------------------
//
// 🔴 `shapeFinding` 是**逐字段白名单**转换 —— 未列出的属性直接丢。所以
//    「后端落库了」与「前端拿得到」是两件独立的事，而差别在本地完全不可见
//    （库里有值、接口里没有、界面于是显示未知）。这正是同一文件里
//    `by_region` / `gaps` / `skipped_by_gate` 那几处「算好了没人取」的成因。
//
// ⚠️ `shapeFinding` 没有导出（它是模块内部函数），所以这几条是**源码级**断言。
//    与本文件里 `keys.py` 前缀对齐那条同一套做法。

const INSP_SRC = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");

t("shapeFinding 带出门禁三字段（不带出=库里有值而接口里没有）", () => {
  for (const f of ["da_gate_trustworthy", "da_degradations", "da_skills_loaded"]) {
    assert.ok(new RegExp(`\\b${f}:`).test(INSP_SRC),
      `shapeFinding 没列 ${f} —— 白名单转换会把它直接丢掉`);
  }
});

t("da_gate_trustworthy 的 absent 落成 null 而不是 false", () => {
  // 取出该字段的赋值表达式（到下一个属性名之前）
  const m = /da_gate_trustworthy:\s*([\s\S]{0,220}?)\n\s{4}\/\*\*/.exec(INSP_SRC);
  assert.ok(m, "抓不到 da_gate_trustworthy 的赋值表达式（写法改了就要同步改这条）");
  const expr = m[1];
  assert.ok(/===\s*undefined/.test(expr) && /===\s*null/.test(expr),
    "没有显式区分 undefined/null —— 存量行会被折成 false，"
    + "于是**每一条**存量 finding 都显示「判读不可信」，那是噪音不是信号");
  assert.ok(!/^\s*Boolean\(item\.da_gate_trustworthy\)\s*,?\s*$/m.test(expr),
    "退化成裸 Boolean() —— 把「不知道」说成「不可信」，"
    + "与后端 ApplyOutcome.journal_trustworthy 默认 True 的用意正好相反");
});

t("da_degradations / da_skills_loaded 的 absent 落成 null 而不是空数组", () => {
  for (const f of ["da_degradations", "da_skills_loaded"]) {
    const m = new RegExp(`${f}:\\s*Array\\.isArray\\(item\\.${f}\\)([\\s\\S]{0,160}?),\\n`)
      .exec(INSP_SRC);
    assert.ok(m, `抓不到 ${f} 的赋值表达式`);
    assert.ok(/:\s*null/.test(m[1]),
      `${f} 的 else 分支不是 null —— 「门禁跑过且干净（空数组）」与`
      + "「门禁没跑（缺失）」会混成一件事，于是看板永远说不出"
      + "「这条判读的方法论确认生效了」");
    assert.ok(!/\|\|\s*\[\]/.test(m[1]),
      `${f} 用了 || [] 兜底 —— 同上，那会把「没验过」说成「验过且干净」`);
  }
});

t("门禁三字段不在 getFinding 的详情专属段里（列表也要有）", () => {
  // 详情端点在 shapeFinding 之外**额外**加 da_body / da_updated_at。
  // 门禁三字段必须在 shapeFinding 里（列表就能拿到），否则卡片上的徽标
  // 要等点开详情才出现 —— 而它的全部用处就是在列表上一眼看出哪条不可信。
  const i = INSP_SRC.indexOf("export async function getFinding(");
  assert.ok(i > 0);
  const detail = INSP_SRC.slice(i, i + 1200);
  for (const f of ["da_gate_trustworthy", "da_degradations", "da_skills_loaded"]) {
    assert.ok(!new RegExp(`\\n\\s+${f}:`).test(detail),
      `${f} 被挪进了详情专属段 —— 列表卡片就拿不到，徽标要点开才出现`);
  }
});

t("★★ gate_quality 的三态聚合：分母是判读已回来的，unknown 不与 clean 合并", () => {
  // 🔴 D22 第二步。与 parse_quality 那条同一套源码判据 —— 这个聚合是
  //    「skill 没加载 / 账号没关联」这类**全局**故障的唯一聚合视图，
  //    单条徽标（第一步）抓不到「100 条里 60 条不可信」。
  const seg = INSP_SRC.slice(INSP_SRC.indexOf("const gateQuality"));
  const body = seg.slice(0, seg.indexOf("\n  }") + 4);
  const code = body.split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
  // 判据①：分母 = 判读**已回来**（有 parse_status），在途的不算 ——
  // 门禁结论与判读同一次 UpdateItem 落库，「派了没回来」算进 unknown
  // 会让刚触发的那一轮显示成「N 条未验证」。
  assert.ok(/if\s*\(!r\.da_task_id\s*\|\|\s*!r\.da_parse_status\)\s*continue/
    .test(code),
    "gateQuality 没有按「判读已回来」过滤 —— 在途的会被数成 unknown，"
    + "刚触发的那一轮看起来像出了故障");
  // 判据②：三态判据必须是 === false / === true，truthy 会把存量行全数成
  // untrusted（shapeFinding 对缺失发的是 null）。
  assert.ok(/da_gate_trustworthy\s*===\s*false/.test(code)
    && /da_gate_trustworthy\s*===\s*true/.test(code),
    "gateQuality 不是显式三态判据 —— null（存量/没验过）会被折进某一档");
  // 判据③：四档都在。clean 与 unknown 分开 ——「验过且干净」是正面证据，
  // 与「不知道」合并会让看板永远说不出「方法论确认生效了」。
  for (const k of ["untrusted", "degraded", "clean", "unknown"]) {
    assert.ok(body.includes(k), `gate_quality 少了 ${k} 档`);
  }
  // 判据④：透出到总览（与 parse_quality 同理 —— 全局故障要在全局看）。
  assert.ok(/gate_quality: findings\.gate_quality/.test(INSP_SRC),
    "getOverview 没有透出 gate_quality");
});

// ---------------------------------------------------------------------------
// ⚠️ 汇总**必须在文件最末尾**。它带 `process.exit(1)`，放在中间会让后面
//    的用例根本不执行 —— 而计数只报前半部分，看起来「全部通过」。
//    实测踩过：追加 18 条用例后仍然只报 20 passed。
// ---------------------------------------------------------------------------
await Promise.all(pending);

if (fails.length) {
  console.error(`inspection.test.mjs: ${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.error("  ✗ " + f);
  process.exit(1);
}
// ⚠️ 成功行必须含 `, 0 failed` —— `package.json` 的 test 脚本对**每个**测试
//    文件都 `grep -q ', 0 failed'`，用来堵「守卫之前 process.exit(0) ⇒ rc=0
//    且完全静默」这个盲区（2026-08-30 实测：那时 `npm test` 的 `&&` 会继续
//    往下跑并退 0）。这个文件此前打的是 `N passed`，不含那个串。
console.log(`inspection.test.mjs: ${pass} passed, 0 failed`);
