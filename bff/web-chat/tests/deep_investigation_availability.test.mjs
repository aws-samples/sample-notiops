/**
 * 「深度调查」能力探测（devops_investigate.mjs 的 deepInvestigationAvailability）。
 *
 * 为什么值得单测：它决定客户看到的是**一个能点的开关**还是**一个置灰的开关**。
 * 判错方向的代价不对称 ——
 *   · 误判成"不可用"：把一个明明能用的功能藏起来（客户没有任何自救办法，开关点不动）；
 *   · 误判成"可用"：客户点了、发一轮，看到真实报错（退回改动前的行为）。
 * 所以这里把"只有确定没有 Agent Space 才置灰、其余一律放行"这条钉死。
 *
 * 不连 AWS：DEVOPS_AGENT_SPACE_ID 在**导入前**注入即可让 self 分支短路（不调
 * ListAgentSpaces）。跨账号分支要读 DDB，留给结构性断言覆盖。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let fails = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}

console.log("deep investigation availability");

// 必须在 import 之前设置：模块加载时读一次 env。
process.env.DEVOPS_AGENT_SPACE_ID = "as-test-space";
const { deepInvestigationAvailability } = await import("../devops_investigate.mjs");
const { localAgentSpaceProbe, resolveTarget } = await import("../devops_agent_skills.mjs");

await t("env 注入了 Agent Space → self 分支不调 ListAgentSpaces 就判可用", async () => {
  const r = await deepInvestigationAvailability("");
  assert.equal(r.available, true);
  assert.equal(r.scope, "self");
});

await t("localAgentSpaceProbe: env 优先且不算 inconclusive", async () => {
  const p = await localAgentSpaceProbe();
  assert.equal(p.spaceId, "as-test-space");
  assert.equal(p.inconclusive, false);
});

await t("resolveTarget 的 self 分支返回该 space、不带凭证", async () => {
  const target = await resolveTarget("");
  assert.equal(target.agentSpaceId, "as-test-space");
  assert.equal(target.scope, "self");
  assert.equal(target.credentials, undefined);
});

await t("返回的是副本 —— 调用方改不动缓存", async () => {
  const first = await deepInvestigationAvailability("");
  first.available = false;
  const second = await deepInvestigationAvailability("");
  assert.equal(second.available, true, "缓存被调用方污染了");
});

/* ── 结构性断言：把"什么算确定不可用"钉在源码里 ──
   这两条 reason 是 resolveTarget 用 code:"bad_request" 抛出的、含义明确的判据；
   其它任何异常（DDB 抖动、缺 aidevops:ListAgentSpaces、超时）都必须 fail-open。 */
const src = readFileSync(new URL("../devops_investigate.mjs", import.meta.url), "utf8");
const definitiveLine = src.split("\n").find((l) => l.includes("const definitive ="));

await t("只有两条 reason 算确定不可用", async () => {
  assert.ok(definitiveLine, "找不到 definitive 判据行");
  assert.ok(definitiveLine.includes("no_local_agent_space"));
  assert.ok(definitiveLine.includes("account_not_onboarded_to_devops_agent"));
});

await t("探测本身失败（agent_space_probe_failed）不算不可用 —— 必须 fail-open", async () => {
  // 老路径（agent runtime）是用**另一个角色**去发现 Agent Space 的，BFF 这边问不出来
  // 不代表功能不可用；据此置灰等于凭空砍掉一个能用的功能。
  assert.ok(!definitiveLine.includes("agent_space_probe_failed"));
  assert.ok(/probe_error/.test(src), "非确定失败必须带 probe_error 放行");
});

/* ── 路由白名单：这个探测接口任何登录用户都要用（不然开关渲染不出来） ── */
const authzSrc = readFileSync(new URL("../authz.mjs", import.meta.url), "utf8");
const loginOnlyBlock = authzSrc.slice(authzSrc.indexOf("const LOGIN_ONLY"),
                                     authzSrc.indexOf("function isLoginOnly"));
await t("/features/deep-investigation 在 LOGIN_ONLY 里且带 $ 锚点", async () => {
  assert.ok(/\/\\\/features\\\/deep-investigation\$\//.test(loginOnlyBlock),
            "必须是锚定的 /\\/features\\/deep-investigation$/ 正则");
});

console.log(fails ? `\nFAILED: ${fails}` : "\nPASSED: all ok");
process.exit(fails ? 1 : 0);
