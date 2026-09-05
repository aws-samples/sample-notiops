/**
 * requiresEnv 门禁：能力节点声明的外部数据源未配置时，入口必须**不出现**。
 * 运行：node bff/web-chat/tests/capabilities_env_gate.test.mjs
 *
 * 背景：客户 CUR 四个 sheet（nav:finops:cur-*）依赖 COST_AGENT_MCP_URL 指向客户自建的
 * cost-agent MCP Lambda。绝大多数部署不接这个数据源，那时侧栏渲染出四个点进去空白的
 * tab 就是坏体验；反过来，配了却看不到入口同样是坏体验。两个方向都钉在这里。
 */
import { visibleTree, envConfigured, filterDashboard } from "../authz.mjs";
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

/* ── 每日异常扫描（lambda5）：requiresEnv 挡的是「这条部署路径没有写侧」 ──
   `notiops-cost-analyzer` 和它那条 01:15 UTC 的 EventBridge 规则都只在
   notiops-backend-stack.ts 里；一键部署（方式 A）的单栈不含这一族定时 Lambda，
   web-chat-core.ts 因此把 COST_ANALYZER_FUNCTION 置空。
   没有这道闸门时，方式 A 上这张卡恒在、恒停在 available:false 那支，写着
   「近 3 天没有扫描记录（每日 01:15 UTC 跑）」—— 一句在那条路上永远不会成真的话。
   它是 level=subtab，admin 的模块开关只收 level=tab，人手能关的只有整个
   nav:finops（代价是连带关掉整块看板）。所以 requiresEnv 是唯一的自动收口手段，
   删掉它必须先打挂这里。

   ⚠️ 本段依赖三处同批落地，缺一处这个文件就红：
     · config/capabilities.json 给该节点加 "requiresEnv": "COST_ANALYZER_FUNCTION"
     · bff/web-chat/capabilities.json 同步（两份逐字节一致，test_capabilities_parity.py 守）
     · web-chat-core.ts 的 BFF environment 加
       COST_ANALYZER_FUNCTION: props.staticTemplate ? "" : "notiops-cost-analyzer" */
const DAILY_KEY = "nav:finops:daily-anomaly";
ok(`${DAILY_KEY} declares requiresEnv=COST_ANALYZER_FUNCTION`,
  byKey.get(DAILY_KEY)?.requiresEnv === "COST_ANALYZER_FUNCTION");
delete process.env.COST_ANALYZER_FUNCTION;
const noScanner = await keysOf(ADMIN);
ok("no cost analyzer → admin does not see the daily-anomaly card", !noScanner.includes(DAILY_KEY));
ok("no cost analyzer → the rest of Optimization & Risk is unaffected",
  noScanner.includes("nav:finops:anomalies") && noScanner.includes("nav:finops:ri-sp"));
// 响应侧必须同源：只挡侧栏、不挡 payload，等于把死数据发给不读 /capabilities 的客户端。
const noScannerPayload = filterDashboard("nav:finops",
  { dailyAnomaly: { available: true }, potentialSavings: 1 }, ADMIN);
ok("no cost analyzer → dailyAnomaly stripped from the dashboard payload",
  !("dailyAnomaly" in noScannerPayload) && noScannerPayload.potentialSavings === 1);
process.env.COST_ANALYZER_FUNCTION = "notiops-cost-analyzer";
ok("cost analyzer present → role:finops sees it",
  (await keysOf({ grants: ["nav:chat", "nav:finops:*"], denies: [] })).includes(DAILY_KEY));
const withScannerPayload = filterDashboard("nav:finops",
  { dailyAnomaly: { available: true } }, ADMIN);
ok("cost analyzer present → dailyAnomaly kept in the payload",
  "dailyAnomaly" in withScannerPayload);
delete process.env.COST_ANALYZER_FUNCTION;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
