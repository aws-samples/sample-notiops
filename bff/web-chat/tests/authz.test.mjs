/**
 * authz 核心逻辑单测（纯逻辑，不触 DDB）。
 * 运行：node bff/web-chat/tests/authz.test.mjs
 */
import { matchesAny, satisfies, satisfiesAdmin, filterDashboard, visibleTree, authorize, PRESET_ROLES } from "../authz.mjs";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`XX ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`XX ${name}`); } }

/* ── matchesAny：前缀通配 ── */
ok("wildcard * matches all", matchesAny(["*"], "nav:finops:deep-dive:s3"));
ok("prefix :* matches descendant", matchesAny(["nav:finops:*"], "nav:finops:deep-dive:athena"));
ok("prefix :* matches base itself", matchesAny(["nav:finops:*"], "nav:finops"));
ok("exact match", matchesAny(["nav:cases:sla"], "nav:cases:sla"));
ok("no false prefix (finops-x)", !matchesAny(["nav:finops:*"], "nav:finopsx"));
ok("unrelated no match", !matchesAny(["nav:cases:*"], "nav:finops"));

/* ── satisfies：deny 优先、* 短路 ── */
ok("deny beats grant", satisfies({ grants: ["nav:finops:*"], denies: ["nav:finops:ai-spend"] }, "nav:finops:ai-spend") === false);
ok("deny prefix beats grant", satisfies({ grants: ["*"], denies: ["nav:cases:*"] }, "nav:cases:sla") === false);
ok("* grants pass", satisfies({ grants: ["*"], denies: [] }, "anything:here"));
ok("grant within prefix", satisfies({ grants: ["nav:finops:*"], denies: [] }, "nav:finops:spend-overview"));
ok("no grant → deny", satisfies({ grants: ["nav:cases:*"], denies: [] }, "nav:finops") === false);

/* ── filterDashboard：response-side 删字段 ── */
const casesPayload = { overview: 1, waiting: 2, incidents: 3, sla: 4, _meta: "keep" };
const filtered = filterDashboard("nav:cases", { ...casesPayload },
  { grants: ["nav:cases:overview", "nav:cases:sla"], denies: [] });
eq("filter keeps granted subtabs", { overview: 1, sla: 4, _meta: "keep" }, filtered);

const finopsPayload = { costExplorer: 1, budgetAlerts: 2, devOpsAgentCost: 3, potentialSavings: 4, edpCommitment: 5, curStatus: "meta" };
const finF = filterDashboard("nav:finops", { ...finopsPayload },
  { grants: ["nav:finops:spend-overview"], denies: [] });
eq("finops keeps only spend-overview + meta", { costExplorer: 1, curStatus: "meta" }, finF);

/* ── visibleTree（传 disabledModules 避免 DDB）── */
const vtViewer = await visibleTree({ grants: ["nav:chat", "nav:cases:*"], denies: [] }, { disabledModules: [] });
const vKeys = vtViewer.map((n) => n.key);
ok("viewer sees chat", vKeys.includes("nav:chat"));
ok("viewer sees cases + subtabs", vKeys.includes("nav:cases") && vKeys.includes("nav:cases:sla"));
ok("viewer NOT see finops", !vKeys.includes("nav:finops"));
ok("viewer NOT see admin", !vKeys.includes("nav:admin"));

const vtAdmin = await visibleTree({ grants: ["*"], denies: [] }, { disabledModules: [] });
ok("admin sees admin tab", vtAdmin.map((n) => n.key).includes("nav:admin"));

const vtDisabled = await visibleTree({ grants: ["*"], denies: [] }, { disabledModules: ["nav:finops"] });
ok("disabled finops hidden even for admin", !vtDisabled.map((n) => n.key).includes("nav:finops"));
ok("disabled finops hides subtabs too", !vtDisabled.map((n) => n.key).includes("nav:finops:spend-overview"));

/* ── authorize：白名单 + alwaysOn + fail-closed（不触模块开关分支时不查 DDB）── */
const wl = await authorize({ method: "GET", path: "/api/chat/conversations", query: null, body: null }, { grants: [], denies: [] });
ok("whitelist conversations allowed w/o perms", wl.allow === true);
const meCap = await authorize({ method: "GET", path: "/api/me/capabilities", query: null, body: null }, { grants: [], denies: [] });
ok("me/capabilities whitelisted", meCap.allow === true);
const chatStream = await authorize({ method: "POST", path: "/api/chat/stream", query: null, body: null }, { grants: [], denies: [] });
ok("chat stream alwaysOn allowed", chatStream.allow === true);
const unknown = await authorize({ method: "GET", path: "/api/totally/unknown", query: null, body: null }, { grants: ["*"], denies: [] });
ok("unknown route fail-closed", unknown.allow === false && unknown.status === 403);

/* ── authorize：/actions/execute 按 body.action.type（真实请求体形状）── */
const resolveBody = { action: { type: "resolve_case", params: {} } };
const canResolve = await authorize({ method: "POST", path: "/api/actions/execute", query: null, body: resolveBody },
  { grants: ["action:cases:resolve"], denies: [] }, { disabledModules: [] });
ok("support can resolve case", canResolve.allow === true);
const noResolve = await authorize({ method: "POST", path: "/api/actions/execute", query: null, body: resolveBody },
  { grants: ["nav:cases:*"], denies: [] }, { disabledModules: [] });
ok("viewer (nav only) cannot resolve case", noResolve.allow === false && noResolve.required === "action:cases:resolve");

/* ── authorize：模块开关优先于个人权限 ── */
const finopsDash = { method: "GET", path: "/api/finops/dashboard", query: null, body: null };
const finopsOpen = await authorize(finopsDash, { grants: ["nav:finops:*"], denies: [] }, { disabledModules: [] });
ok("finops allowed when module on", finopsOpen.allow === true);
const finopsClosed = await authorize(finopsDash, { grants: ["*"], denies: [] }, { disabledModules: ["nav:finops"] });
ok("finops denied when module disabled even for admin", finopsClosed.allow === false);

/* ─────────────────────────────────────────────────────────────────────────────
 * 权限矩阵：adminOnly 节点（spec task 8.3）
 *
 * `/admin/llm-config*` 全部落在 `nav:admin`（adminOnly）这一个能力节点上，所以
 * 「非 Admin 拿不到模型目录与 API Key」这件事完全由 adminOnly 的判定承载。
 *
 * 这里钉住的核心是：**通配 grant 不得跨界拿到 admin**。`nav:*` 字面意思是「所有导航
 * 页」，而按前缀通配规则它会命中 `nav:admin` —— 曾因此让持 `nav:*` 者拿到整个
 * `/admin/.+`：改模型目录、写 Bedrock API Key，以及 `PUT /admin/users/:id/permissions`
 * （给自己改成 `*`，完整提权）。权限选择器本就特意过滤掉 adminOnly 节点，说明
 * 「admin 不作为可授予的 nav 权限」是设计意图，通配绕过的正是这个意图。
 * ─────────────────────────────────────────────────────────────────────────── */
const LLM_ADMIN_ROUTES = [
  ["GET", "/admin/llm-config"],
  ["PUT", "/admin/llm-config"],
  ["PUT", "/admin/llm-config/api-key"],
  ["POST", "/admin/llm-config/rollback"],
  ["PUT", "/admin/llm-config/backend-tasks"],
  ["GET", "/admin/llm-config/audit"],
];

async function allowsAll(eff) {
  for (const [method, path] of LLM_ADMIN_ROUTES) {
    const r = await authorize({ method, path, query: null, body: null }, eff, { disabledModules: [] });
    if (!r.allow) return false;
  }
  return true;
}
async function deniesAll(eff) {
  for (const [method, path] of LLM_ADMIN_ROUTES) {
    const r = await authorize({ method, path, query: null, body: null }, eff, { disabledModules: [] });
    if (r.allow || r.status !== 403 || r.required !== "nav:admin") return false;
  }
  return true;
}

// 五个非 admin 预置角色：六条路由全 403（含只读的 GET —— 目录里有 provider/凭证模式）
for (const [role, perms] of Object.entries(PRESET_ROLES)) {
  const eff = { grants: perms, denies: [] };
  if (role === "role:admin") {
    ok(`${role} reaches every llm-config route`, await allowsAll(eff));
  } else {
    ok(`${role} is denied on every llm-config route`, await deniesAll(eff));
  }
}

// 通配不得跨界
ok("nav:* does NOT reach llm-config", await deniesAll({ grants: ["nav:*"], denies: [] }));
ok("nav:* does NOT satisfy admin", satisfiesAdmin({ grants: ["nav:*"], denies: [] }) === false);
ok("action:* does NOT satisfy admin", satisfiesAdmin({ grants: ["action:*"], denies: [] }) === false);
ok("a bare nav grant does NOT satisfy admin",
  satisfiesAdmin({ grants: ["nav:chat", "nav:finops:*"], denies: [] }) === false);
ok("no false prefix (nav:administrators)",
  satisfiesAdmin({ grants: ["nav:administrators"], denies: [] }) === false);

// 显式点名仍然可以
ok("* still satisfies admin", satisfiesAdmin({ grants: ["*"], denies: [] }));
ok("explicit nav:admin satisfies admin", satisfiesAdmin({ grants: ["nav:admin"], denies: [] }));
ok("explicit nav:admin:* satisfies admin", satisfiesAdmin({ grants: ["nav:admin:*"], denies: [] }));
ok("explicit nav:admin reaches llm-config", await allowsAll({ grants: ["nav:admin"], denies: [] }));

// deny 一侧保持宽匹配：拒绝宁可过宽
ok("deny nav:admin beats *", satisfiesAdmin({ grants: ["*"], denies: ["nav:admin"] }) === false);
ok("broad deny nav:* still vetoes admin", satisfiesAdmin({ grants: ["*"], denies: ["nav:*"] }) === false);
ok("denied admin gets 403 on llm-config", await deniesAll({ grants: ["*"], denies: ["nav:admin"] }));

// 其余通配语义**不受**这次收紧影响
ok("nav:finops:* still reaches the finops dashboard",
  (await authorize({ method: "GET", path: "/api/finops/dashboard", query: null, body: null },
    { grants: ["nav:finops:*"], denies: [] }, { disabledModules: [] })).allow === true);
ok("nav:cases:* still satisfies a cases subtab",
  satisfies({ grants: ["nav:cases:*"], denies: [] }, "nav:cases:sla"));

// 侧栏与端点必须同源，否则用户看得见点不开
const vtNavStar = await visibleTree({ grants: ["nav:*"], denies: [] }, { disabledModules: [] });
ok("nav:* does not render the admin tab either",
  !vtNavStar.map((n) => n.key).includes("nav:admin"));
const vtExplicit = await visibleTree({ grants: ["nav:admin"], denies: [] }, { disabledModules: [] });
ok("explicit nav:admin renders the admin tab",
  vtExplicit.map((n) => n.key).includes("nav:admin"));

// 模块开关仍优先于 admin 判定（顺序不能被这次改动挪动）
const adminDisabled = await authorize({ method: "GET", path: "/admin/llm-config", query: null, body: null },
  { grants: ["*"], denies: [] }, { disabledModules: ["nav:admin"] });
ok("module switch still outranks admin grant", adminDisabled.allow === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
