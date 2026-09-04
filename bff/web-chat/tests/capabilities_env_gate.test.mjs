/**
 * requiresEnv 门禁：能力节点声明的外部数据源未配置时，入口必须**不出现**。
 * 运行：node bff/web-chat/tests/capabilities_env_gate.test.mjs
 *
 * 背景：客户 CUR 四个 sheet（nav:finops:cur-*）依赖 COST_AGENT_MCP_URL 指向客户自建的
 * cost-agent MCP Lambda。绝大多数部署不接这个数据源，那时侧栏渲染出四个点进去空白的
 * tab 就是坏体验；反过来，配了却看不到入口同样是坏体验。两个方向都钉在这里。
 */
import { visibleTree, envConfigured } from "../authz.mjs";
import { allNodes } from "../capabilities.mjs";

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`XX ${name}`); } }

const CUR_KEYS = ["nav:finops:cur-trend", "nav:finops:cur-credit", "nav:finops:cur-es", "nav:finops:cur-sp"];
const ADMIN = { grants: ["*"], denies: [] };
const keysOf = async (eff) => (await visibleTree(eff, { disabledModules: [] })).map((n) => n.key);

/* ── 注册表自身：四个节点都存在且都声明了依赖 ── */
const byKey = new Map(allNodes().map((n) => [n.key, n]));
for (const k of CUR_KEYS) {
  ok(`${k} exists in the registry`, byKey.has(k));
  ok(`${k} declares requiresEnv=COST_AGENT_MCP_URL`, byKey.get(k)?.requiresEnv === "COST_AGENT_MCP_URL");
  ok(`${k} has both titles`, !!byKey.get(k)?.title_zh && !!byKey.get(k)?.title_en);
}

/* ── envConfigured：空 / 占位符 / 真值 ── */
ok("no requiresEnv → always configured", envConfigured(undefined, {}) === true);
ok("missing env → not configured", envConfigured("X", {}) === false);
ok("empty env → not configured", envConfigured("X", { X: "   " }) === false);
// 部署脚本漏替换时必须表现为"功能不出现"，而不是"入口在、点了就崩"（不许静默降级）。
ok("unsubstituted __PLACEHOLDER__ → not configured",
  envConfigured("COST_AGENT_MCP_URL", { COST_AGENT_MCP_URL: "__COST_AGENT_MCP_URL__" }) === false);
ok("real value → configured", envConfigured("X", { X: "https://abc.lambda-url.us-east-1.on.aws" }) === true);
ok("multi-dep needs all", envConfigured("A,B", { A: "1" }) === false);
ok("multi-dep all present", envConfigured("A,B", { A: "1", B: "2" }) === true);
ok("array form supported", envConfigured(["A", "B"], { A: "1", B: "2" }) === true);

/* ── 未配置：admin 也看不到（不是权限问题，是数据源问题）── */
delete process.env.COST_AGENT_MCP_URL;
const hidden = await keysOf(ADMIN);
ok("unconfigured → admin sees no CUR sheet", CUR_KEYS.every((k) => !hidden.includes(k)));
ok("unconfigured → the FinOps tab itself is unaffected", hidden.includes("nav:finops"));
ok("unconfigured → other finops subtabs unaffected", hidden.includes("nav:finops:tag-explorer"));

/* ── 占位符等同未配置 ── */
process.env.COST_AGENT_MCP_URL = "__COST_AGENT_MCP_URL__";
const placeholder = await keysOf(ADMIN);
ok("placeholder → still hidden", CUR_KEYS.every((k) => !placeholder.includes(k)));

/* ── 已配置：授权者看得到，未授权者仍看不到（门禁叠加，不是替代）── */
process.env.COST_AGENT_MCP_URL = "https://example.lambda-url.us-east-1.on.aws";
const shown = await keysOf(ADMIN);
ok("configured → admin sees all four CUR sheets", CUR_KEYS.every((k) => shown.includes(k)));
const finopsRole = await keysOf({ grants: ["nav:chat", "nav:finops:*"], denies: [] });
ok("configured → role:finops sees them", CUR_KEYS.every((k) => finopsRole.includes(k)));
const casesOnly = await keysOf({ grants: ["nav:cases:*"], denies: [] });
ok("configured → unrelated role still does not", CUR_KEYS.every((k) => !casesOnly.includes(k)));
const finopsOff = await visibleTree(ADMIN, { disabledModules: ["nav:finops"] });
ok("configured → module switch still outranks it",
  CUR_KEYS.every((k) => !finopsOff.map((n) => n.key).includes(k)));
delete process.env.COST_AGENT_MCP_URL;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
