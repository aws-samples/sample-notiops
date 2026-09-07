/**
 * requiresEnv 门禁：能力节点声明的外部数据源未配置时，入口必须**不出现**。
 * 运行：node bff/web-chat/tests/capabilities_env_gate.test.mjs
 *
 * 背景：客户 CUR 四个 sheet（nav:finops:cur-*）依赖 COST_AGENT_MCP_URL 指向客户自建的
 * cost-agent MCP Lambda。绝大多数部署不接这个数据源，那时侧栏渲染出四个点进去空白的
 * tab 就是坏体验；反过来，配了却看不到入口同样是坏体验。两个方向都钉在这里。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/* ── 巡检（2026-09-07 现网反馈）：方式A 上整个 tab 必须消失 ────────────────────
   客户实测到的症状：一键部署（方式A）的环境里侧栏有「巡检」，点进去是
   「! 加载失败 (ddb_error)」—— 一个永不会成功的请求，客户会以为是自己配错了。
   `notiops-inspection` 表与那一族 Lambda 只在 notiops-backend-stack.ts 里，
   一键单栈不含它们。

   🔴 这一条与前面几条**形态不同**：requiresEnv 挂在 **tab** 上（前面几条都是
      subtab）。tab 级有一个独有的失效方式 —— `visibleTree` 的**祖先补全**会把
      任何可见子页的父节点补回来，于是 tab 自己那道 requiresEnv 空转。
      修法在 `authz.mjs` 的祖先补全里加 `envConfigured(parent.requiresEnv)`；
      下面第二条断言（8 个子页也一起消失）就是钉这个的 —— 只钉 tab 会被
      "tab 没了、子页还在" 的半修状态骗过去。

   ⚠️ 本段依赖四处同批落地，缺一处就红：
     · config/capabilities.json 给 nav:inspection 加 "requiresEnv": "INSPECTION_TABLE"
     · bff/web-chat/capabilities.json 同步（test_capabilities_parity.py 守逐字节一致）
     · web-chat-core.ts: INSPECTION_TABLE: props.staticTemplate ? "" : "notiops-inspection"
     · inspection.mjs **不许**写 `process.env.INSPECTION_TABLE || "notiops-inspection"`
       —— 那个兜底会把空串填回表名，闸门再次空转 */
const INSP_TAB = "nav:inspection";
ok(`${INSP_TAB} declares requiresEnv=INSPECTION_TABLE`,
  byKey.get(INSP_TAB)?.requiresEnv === "INSPECTION_TABLE");
delete process.env.INSPECTION_TABLE;
const noInsp = await keysOf(ADMIN);
ok("no inspection backend → admin does not see the tab", !noInsp.includes(INSP_TAB));
ok("no inspection backend → **no subtab leaks either**（祖先补全不许把 tab 补回来）",
  noInsp.filter((k) => k.startsWith("nav:inspection:")).length === 0);
ok("no inspection backend → the other tabs are unaffected",
  noInsp.includes("nav:chat") && noInsp.includes("nav:cases")
  && noInsp.includes("nav:finops"));
process.env.INSPECTION_TABLE = "notiops-inspection";
const withInsp = await keysOf(ADMIN);
ok("inspection backend present → the tab is back", withInsp.includes(INSP_TAB));
ok("inspection backend present → all subtabs are back",
  withInsp.filter((k) => k.startsWith("nav:inspection:")).length >= 6);
// 门禁叠加而非替代：配好了也仍然按角色收。
const noRights = await keysOf({ grants: ["nav:chat"], denies: [] });
ok("inspection backend present → an unrelated role still does not see it",
  !noRights.includes(INSP_TAB));
delete process.env.INSPECTION_TABLE;

/* ── 兜底口径：BFF 侧的 `inspectionConfigured()` 与前端 tab 判据同源 ──
   前端不渲染入口是**第一层**；直接打 API（老缓存的前端 bundle / 脚本）时必须拿到
   一个诚实的错误码，而不是 `ddb_error`（那是"数据库出错了"的意思，会让客户重试）。 */
const inspSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "inspection.mjs"), "utf8");
ok("inspection.mjs 没有把空串兜底成表名（那会让上面整段闸门空转）",
  !/INSPECTION_TABLE\s*\|\|\s*["'`]notiops-inspection/.test(inspSrc));
ok("inspection.mjs 导出 inspectionConfigured()（路由层的判据来源）",
  /export const inspectionConfigured/.test(inspSrc));
const idxSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "index.mjs"), "utf8");
ok("index.mjs 在 /inspection/* 之前有一道 inspection_not_deployed 门",
  /inspectionConfigured\(\)[\s\S]{0,200}inspection_not_deployed/.test(idxSrc));
ok("那个码不是 ddb_error（客户会以为是自己配错了，反复重试）",
  /code: "inspection_not_deployed"/.test(idxSrc));
{
  process.env.INSPECTION_TABLE = "";
  const { inspectionConfigured } = await import("../inspection.mjs");
  ok("空串 → inspectionConfigured() 为 false", inspectionConfigured() === false);
  process.env.INSPECTION_TABLE = "   ";
  ok("空白 → 仍是 false", inspectionConfigured() === false);
  process.env.INSPECTION_TABLE = "notiops-inspection";
  ok("真表名 → true", inspectionConfigured() === true);
  delete process.env.INSPECTION_TABLE;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
