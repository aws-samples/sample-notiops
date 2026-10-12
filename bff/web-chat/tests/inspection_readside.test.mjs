/**
 * 巡检读侧：2026-10-10 交叉 review（r5 / r6）修复的那几处。
 * 运行：node bff/web-chat/tests/inspection_readside.test.mjs
 *
 * ```
 * B2 / B8   judge_in_flight / judge_retryable    与 manual_judge 同判据
 * B5        inspection_enabled                   kill switch 关着时读侧要知道
 * B6        judge_ready                          账号前置不全时不给按钮
 * B7        excluded_by                          移出范围后到正式巡检关闭之前
 * F-08      without_judgment                     只数还需要处置的
 * F-09      worstRunAcross / diffByAccount        缺席账号、试运行、不跨账号相减
 * F-10      stale                                按最近一次正式轮判，不按固定 2 天
 * ```
 */
process.env.INSPECTION_TABLE = "insp";
process.env.CONFIG_TABLE = "cfg";
process.env.AWS_REGION = "ap-northeast-1";

import assert from "node:assert";

const insp = await import("../inspection.mjs");
const {
  shapeFinding, judgeInFlight, markStale, annotateExclusions, worstRunAcross,
  diffByAccount, switchValueOn, judgeReadyOf, runTypeOfRule, getFindings,
} = insp;

let pass = 0;
const fails = [];
const pending = [];
function t(name, fn) {
  let r;
  try { r = fn(); } catch (e) { fails.push(`${name}: ${e.message}`); return; }
  if (r && typeof r.then === "function") {
    pending.push(r.then(() => { pass += 1; }, (e) => { fails.push(`${name}: ${e.message}`); }));
    return;
  }
  pass += 1;
}

const A = "111122223333";
const B = "444455556666";
const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// ── B2 / B8 ────────────────────────────────────────────────────────────────

t("judgeInFlight：没回来 / 回来的是上一个 task → 在路上", () => {
  assert.equal(judgeInFlight({}), false);
  assert.equal(judgeInFlight({ da_task_id: "t" }), true);
  assert.equal(judgeInFlight({ da_task_id: "t", da_updated_at: 5, da_dispatched_at: 9 }), true);
  assert.equal(judgeInFlight({ da_task_id: "t", da_updated_at: 9, da_dispatched_at: 9 }), false);
  assert.equal(judgeInFlight({ da_task_id: "t", da_updated_at: 9 }), false);
});

t("judge_retryable：回来了、没内容、次数没用完", () => {
  const base = { SK: `${A}#r#rds#db#threshold_high#CPUUtilization`,
    da_task_id: "t", da_updated_at: 10, da_dispatched_at: 5 };
  assert.equal(shapeFinding({ ...base, da_parse_status: "empty" }, TODAY).judge_retryable, true);
  assert.equal(shapeFinding({ ...base, da_parse_status: "no_callback" }, TODAY).judge_retryable, true);
  assert.equal(shapeFinding({ ...base, da_parse_status: "ok" }, TODAY).judge_retryable, false);
  assert.equal(shapeFinding({ ...base, da_parse_status: "skipped_by_skill" }, TODAY)
    .judge_retryable, false, "skill 的 skip 判据命中，重派结果一样");
  assert.equal(shapeFinding({ ...base, da_parse_status: "empty", judge_retries: 2 }, TODAY)
    .judge_retryable, false, "重派次数用完");
  assert.equal(shapeFinding({ ...base, da_parse_status: "empty", da_updated_at: 1 }, TODAY)
    .judge_retryable, false, "新 task 在路上");
  const f = shapeFinding({ ...base, da_parse_status: "empty" }, TODAY);
  assert.equal(f.da_dispatched_at, 5);
  assert.equal(f.judge_in_flight, false);
});

// ── F-10 ───────────────────────────────────────────────────────────────────

const row = (over = {}) => ({
  account_id: A, rule: "idle", state: "active", last_run_date: daysAgo(5),
  days_since_eval: 5, stale: false, ...over,
});
const run = (over = {}) => ({
  account_id: A, run_type: "idle", status: "success", mode: "official",
  run_date: daysAgo(5), data_date: daysAgo(5), ...over,
});

t("周度调度：最近一次正式轮评估到了它 → 不停更（哪怕是 5 天前）", () => {
  const rows = [row()];
  markStale(rows, [run()]);
  assert.equal(rows[0].stale, false);
});

t("正式轮跑了却没评估到它（region 漏扫）→ 停更", () => {
  const rows = [row({ last_run_date: daysAgo(6), days_since_eval: 6 })];
  markStale(rows, [run()]);
  assert.equal(rows[0].stale, true);
});

t("窗口里没有正式轮（定时关着，677）→ 退回距上次评估 ≥ 2 天", () => {
  const rows = [row({ last_run_date: daysAgo(27), days_since_eval: 27 }),
    row({ last_run_date: daysAgo(1), days_since_eval: 1 })];
  markStale(rows, [run({ mode: "dry_run", run_date: TODAY, data_date: TODAY })]);
  assert.deepEqual(rows.map((r) => r.stale), [true, false], "试运行不算正式轮");
});

t("停更按 rule 所属的那一类 run 判（no_capacity_metadata 归高负载轮）", () => {
  const rows = [row({ rule: "no_capacity_metadata" })];
  markStale(rows, [run({ run_type: "idle", run_date: TODAY, data_date: TODAY })]);
  assert.equal(rows[0].stale, true, "闲置轮跑了不代表高负载轮评估到了它");
  assert.equal(runTypeOfRule("no_capacity_metadata"), "high");
  assert.equal(runTypeOfRule("gp2_volume"), "idle");
});

t("已解决的行不标停更", () => {
  const rows = [row({ state: "resolved", days_since_eval: 30 })];
  markStale(rows, []);
  assert.equal(rows[0].stale, false);
});

// ── B7 ─────────────────────────────────────────────────────────────────────

t("annotateExclusions：标层级与到期日，只认本账号、本类型的清单", () => {
  const ex = (over) => ({ account_id: A, region: "ap-northeast-1", service: "rds",
    resource_id: "db-1", level: "instance", expires_at: "2026-11-01", ...over });
  const byAcct = new Map([[A, { high: [], idle: [ex({})] }]]);
  const rows = [
    { account_id: A, rule: "idle", instance: "db-1", service: "rds", region: "ap-northeast-1" },
    { account_id: A, rule: "threshold_high", instance: "db-1", service: "rds", region: "ap-northeast-1" },
    { account_id: B, rule: "idle", instance: "db-1", service: "rds", region: "ap-northeast-1" },
    { account_id: A, rule: "idle", instance: "db-1", service: "elasticache", region: "ap-northeast-1" },
  ].map((r) => ({ ...r, excluded_by: "", excluded_until: "" }));
  annotateExclusions(rows, byAcct, "2026-10-10");
  assert.deepEqual(rows.map((r) => r.excluded_by), ["instance", "", "", ""]);
  assert.equal(rows[0].excluded_until, "2026-11-01");
});

// ── F-09 ───────────────────────────────────────────────────────────────────

t("worstRunAcross：可见集合是 * 时用已启用账号补缺席检查", () => {
  const runs = [run({ run_date: TODAY, data_date: TODAY })];
  const r = worstRunAcross(runs, { runType: "idle", crossAccount: true, visible: "*",
    expected: [A, B] });
  assert.equal(r.run_date, "", "B 一条 run 都没有，统一视图不能说「跑过了」");
  const ok = worstRunAcross(runs, { runType: "idle", crossAccount: true, visible: "*",
    expected: [A] });
  assert.equal(ok.run_date, TODAY);
});

t("worstRunAcross：试运行排在成功之前，并带出算出的条数", () => {
  const runs = [
    run({ run_date: TODAY, findings: 2 }),
    run({ account_id: B, run_date: TODAY, mode: "dry_run", findings: 9, dry_run_new_hits: 3 }),
  ];
  const r = worstRunAcross(runs, { runType: "idle", crossAccount: true, visible: "*" });
  assert.equal(r.mode, "dry_run");
  assert.equal(r.account_id, B);
  assert.equal(r.dry_run_new_hits, 3);
});

t("diffByAccount：不跨账号相减", () => {
  const runs = [
    { account_id: A, run_type: "high", run_date: TODAY, findings: 2, status: "success" },
    { account_id: B, run_type: "high", run_date: TODAY, findings: 9, status: "success", mode: "dry_run" },
    { account_id: A, run_type: "high", run_date: daysAgo(1), findings: 3, status: "success" },
  ];
  const { diff, byAccount } = diffByAccount(runs);
  assert.equal(byAccount[A].high.delta, -1);
  assert.equal(byAccount[B].high.delta, null);
  assert.equal(diff.high.current, 11);
  assert.equal(diff.high.delta, null, "B 没有上一轮，加总的 delta 说不出来");
  assert.equal(diff.high.mode, "dry_run");
  const single = diffByAccount(runs.filter((r) => r.account_id === A));
  assert.equal(single.diff.high.delta, -1);
});

t("补齐轮的 run 行（<账号>#bf<n>）归到基础账号，不被当成缺席（2026-10-11 698 实测）", () => {
  const { runAccountOf, collapseRuns } = insp;
  assert.deepEqual(runAccountOf(`${A}#bf2`), { account: A, backfill: 2 });
  assert.deepEqual(runAccountOf(A), { account: A, backfill: 0 });
  const rows = [
    run({ run_date: TODAY, data_date: TODAY, account_id: A, backfill: 1, findings: 1 }),
    run({ run_date: TODAY, data_date: TODAY, account_id: A, backfill: 2, findings: 2 }),
    run({ run_date: TODAY, data_date: TODAY, account_id: B, findings: 0 }),
  ];
  assert.equal(collapseRuns(rows).length, 2);
  assert.equal(collapseRuns(rows).find((r) => r.account_id === A).backfill, 2,
    "没有原轮时用序号最大的那次补齐");
  const withBase = [...rows, run({ run_date: TODAY, data_date: TODAY, account_id: A, findings: 5 })];
  assert.equal(collapseRuns(withBase).find((r) => r.account_id === A).backfill ?? 0, 0,
    "有原轮用原轮");
  const r = worstRunAcross(rows, { runType: "idle", crossAccount: true, visible: "*",
    expected: [A, B] });
  assert.equal(r.run_date, TODAY, "A 只有补齐行也算跑过");
  const { byAccount } = diffByAccount(rows);
  assert.equal(byAccount[A].idle.previous, null, "同一天的 bf1 / bf2 不是「本轮 vs 上一轮」");
});

// ── B5 / B6 ────────────────────────────────────────────────────────────────

t("switchValueOn 与 switches._as_bool 同判据", () => {
  for (const v of [undefined, null, "", " ", "1", "true", true, 1]) {
    assert.equal(switchValueOn(v), true, String(v));
  }
  for (const v of ["0", "false", "FALSE", " off ", "no", "disabled", "n", "f", false, 0]) {
    assert.equal(switchValueOn(v), false, String(v));
  }
});

t("judgeReadyOf：缺采集角色 / 缺巡检 space 各自一个原因", () => {
  assert.deepEqual(judgeReadyOf(null, null), { ok: false, reason: "no_collect_role" });
  assert.deepEqual(judgeReadyOf({ role_arn: "arn" }, { trigger_role_arn: "x" }),
    { ok: false, reason: "no_inspect_space" });
  assert.deepEqual(judgeReadyOf({ role_arn: "arn" },
    { inspect_agent_space_id: "s", trigger_role_arn: "x" }), { ok: true, reason: "" });
});

// ── 端到端（DDB 打桩）：F-08 + B5 + B6 + B7 ────────────────────────────────

t("getFindings：without_judgment 只数还要处置的；excluded_by / judge_ready / kill switch", async () => {
  const lib = await import("@aws-sdk/lib-dynamodb");
  const sts = await import("@aws-sdk/client-sts");
  const origSend = lib.DynamoDBDocumentClient.prototype.send;
  const origSts = sts.STSClient.prototype.send;
  sts.STSClient.prototype.send = async () => ({ Account: "999999999999" });
  const f = (inst, over = {}) => ({
    PK: `inspfind#${A}`, SK: `${A}#ap-northeast-1#rds#${inst}#threshold_high#CPUUtilization`,
    account_id: A, rule: "threshold_high", state: "active", severity: "HIGH",
    first_seen_date: daysAgo(3), last_run_date: TODAY, skip_reason: "budget", ...over,
  });
  lib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    const n = cmd?.constructor?.name || "";
    const inp = cmd.input || {};
    if (n === "GetCommand") {
      const pk = inp.Key.PK;
      if (pk === "appconfig#inspection") return { Item: { config_value: "0" } };
      if (pk === `account#${A}`) return { Item: { role_arn: "arn:aws:iam::1:role/x" } };
      if (pk === `da#${A}`) return { Item: { trigger_role_arn: "arn" } };
      return {};
    }
    if (n === "QueryCommand") {
      const pk = inp.ExpressionAttributeValues?.[":pk"] || "";
      if (pk === `inspfind#${A}`) {
        return { Items: [
          f("db-open"),
          f("db-resolved", { state: "resolved", resolution_kind: "fixed" }),
          f("db-gone", { resource_missing_on: TODAY }),
          f("db-excl"),
        ] };
      }
      if (pk === "inspscope#high") {
        return { Items: [{ SK: `${A}#ap-northeast-1#rds#db-excl`, account_id: A,
          region: "ap-northeast-1", service: "rds", resource_id: "db-excl",
          level: "instance", expires_at: "2099-01-01" }] };
      }
      return { Items: [] };
    }
    return {};
  };
  try {
    const d = await getFindings(A, { kind: "high_load" });
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.without_judgment, 1, "只有 db-open 还需要判读");
    const ex = d.findings.find((x) => x.instance === "db-excl");
    assert.equal(ex.excluded_by, "instance");
    assert.equal(ex.excluded_until, "2099-01-01");
    assert.equal(d.inspection_enabled, false);
    assert.deepEqual(d.judge_ready[A], { ok: false, reason: "no_inspect_space" });
  } finally {
    lib.DynamoDBDocumentClient.prototype.send = origSend;
    sts.STSClient.prototype.send = origSts;
  }
});

await Promise.all(pending);
if (fails.length) {
  console.error(`inspection_readside.test.mjs: ${pass} passed, ${fails.length} FAILED`);
  for (const x of fails) console.error("  ✗ " + x);
  process.exit(1);
}
console.log(`inspection_readside.test.mjs: ${pass} passed, 0 failed`);
