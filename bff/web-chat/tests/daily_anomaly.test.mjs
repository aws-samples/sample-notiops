/**
 * 每日成本异常扫描（lambda5 产数）读侧的判据（2026-09-04，老控制台退役后
 * lambda5 唯一的界面读侧）。
 *
 * 四件必须钉住的事：
 *   1. **跨账号不给 visible 就拒**（fail-closed）—— 行上带 account_id，
 *      org 视图不过滤就是把别人账号的成本异常端给受限用户。
 *   2. **键形状与 Python 写侧逐字对齐**（shared/queries/cost_anomaly.py）——
 *      漂移的表现是这页永远「无数据」而 lambda5 每天在写。
 *   3. **三态**：没跑/读失败 ≠ 无异常（与巡检 R9.11 同一条纪律）。
 *   4. 路由层给 /finops/dashboard 传 visible，finops.mjs 透传给
 *      getDailyAnomalies —— 漏一环，数据层的硬门就把整段打成不可用。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.error(`  FAIL ${name}`); }
};

// SigV4/SDK 构造需要 env 凭证（不发真请求）
process.env.AWS_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
process.env.AWS_SECRET_ACCESS_KEY = "test-secret-not-a-real-key";
process.env.AWS_REGION = "us-east-1";

const m = await import("../daily_anomaly.mjs");
const SRC = readFileSync(join(HERE, "..", "daily_anomaly.mjs"), "utf8");
const PY = readFileSync(
  join(HERE, "..", "..", "..", "shared", "queries", "cost_anomaly.py"), "utf8");

// ── 1. fail-closed（行为测试：硬门在任何 DDB 调用之前，零网络）──
{
  const r = await m.getDailyAnomalies("", {});
  ok("跨账号不给 visible → 拒（不是放行）",
    r.available === false && r.reason === "visibility_required");
  const r2 = await m.getDailyAnomalies("", { visible: null });
  ok("visible 显式 null → 同样拒", r2.available === false
    && r2.reason === "visibility_required");
}

// ── 2. 键形状与 Python 写侧对齐（跨语言钉住）──
{
  ok("summary 的 GSI1PK 前缀两侧一致",
    SRC.includes("`anomalysum#${d}`")
    && PY.includes('f"anomalysum#{date}"'));
  ok("result 的 GSI1PK 前缀两侧一致",
    SRC.includes("`anomaly#${date}`") && PY.includes('f"anomaly#{date}"'));
  ok("读的是 GSI1（写侧建的那个索引名）",
    /IndexName:\s*"GSI1"/.test(SRC) && PY.includes("GSI1PK"));
  // 高分段口径与每日通知一致（>= 60）—— 两处漂移会让「通知里有、
  // 看板里没有」这种最难排查的差异
  ok("明细分数线 60 与 lambda4 同口径", SRC.includes(">= 60"));
}

// ── 3. 三态：不可用的两个 reason 都存在，且不会被渲染成「无异常」──
{
  ok("「没跑」有独立 reason（no_recent_run）", SRC.includes("no_recent_run"));
  ok("「读失败」有独立 reason（query_failed）", SRC.includes("query_failed"));
  ok("回退窗口只有 3 天 —— 不端着一周前的数字装新鲜",
    /i < 3/.test(SRC));
}

// ── 4. 接线：路由层算 visible → finops 透传 ──
{
  const INDEX = readFileSync(join(HERE, "..", "index.mjs"), "utf8");
  const FINOPS = readFileSync(join(HERE, "..", "finops.mjs"), "utf8");
  const seg = INDEX.slice(INDEX.indexOf('path.endsWith("/finops/dashboard")'));
  ok("/finops/dashboard 计算并传 visible",
    /visibleAccountSet\(sub, groups, eff\)/.test(seg.slice(0, 600))
    && /getFinopsDashboard\(q\.account \|\| "", \{ visible: /.test(seg.slice(0, 700)));
  ok("finops.mjs 把 visible 透传给 getDailyAnomalies",
    /getDailyAnomalies\(accountId, \{ visible \}\)/.test(FINOPS));
  ok("dailyAnomaly 不在 orgOnlySections（它是真的账号级口径）",
    !/orgOnlySections:[^\]]*dailyAnomaly/.test(FINOPS));
}

// ── 5. 可见账号过滤真的作用在两类行上（源码断言：inScope 同时用于
//       summaries 与 details —— 只过滤一半是最容易犯的形态）──
{
  const inScopeUses = (SRC.match(/\.filter\(inScope\)/g) || []).length;
  ok(`inScope 同时作用于 summaries 与 details（${inScopeUses} 处）`,
    inScopeUses >= 2);
}

console.log(fail ? `daily_anomaly.test.mjs: ${pass} passed, ${fail} FAILED`
  : `daily_anomaly.test.mjs: ${pass} passed, 0 failed`);
if (fail) process.exit(1);
