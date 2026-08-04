/**
 * authz 核心逻辑单测（纯逻辑，不触 DDB）。
 * 运行：node bff/web-chat/tests/authz.test.mjs
 */
import { matchesAny, satisfies, filterDashboard, visibleTree, authorize } from "../authz.mjs";

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
