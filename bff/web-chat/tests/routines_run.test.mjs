/**
 * 定时任务的执行引擎与 API（routines_run.mjs / routines_api.mjs）—— 用内存存储 + 假 DevOps Agent 跑通每一条护栏。
 *
 * 这些规则写错了不会报错，只会**多花钱**（重叠、并发失控、失败无限重跑）或者**静默不跑**（错过、暂停没人知道）：
 *   · 到点派发：描述里是触发标记 + 引用已安装的 Skill + 上下文；clientToken 对同一次计划运行稳定；
 *   · 跑完：一次运行一个会话（能接着追问）+ 一条站内通知 + 运行记录；没加载 Skill 要明说；
 *   · 上一次还在跑 → 跳过；同时最多 2 个 → 第 3 个排队，30 分钟等不到就跳过；
 *   · 总开关关了 → 不派发，但进行中的照样回收；
 *   · 停了几小时 → 只补最近一次；超过 6 小时 → 记「已错过」；
 *   · 连续失败 3 次 → 暂停并通知；Skill 被撤下这类配置问题 → 立即暂停；
 *   · 6 小时还没终态 → 按未完成收尾，不无限挂着；
 *   · 「立即运行」每小时 3 次；
 *   · API：输入校验、20 个上限、恢复前再核一遍 Skill、回前端的对象不带内部字段。
 *
 * 运行：cd bff/web-chat && node tests/routines_run.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeEngine, LIMITS, buildRoutineDescription, ROUTINE_PREFIX } from "../routines_run.mjs";
import * as api from "../routines_api.mjs";
import { loadedSkillBundles, operatorUrls, investigationRef } from "../devops_investigate.mjs";
import { uploadRecordFor } from "../devops_agent_skills.mjs";

let fails = 0, ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.stack?.split("\n").slice(0, 3).join("\n       ") || e}`); }
}

const MIN = 60000, HOUR = 3600000;
const T0 = Date.parse("2026-11-02T01:00:00Z"); // 上海 09:00

function memStore() {
  const defs = new Map(); const runs = new Map(); let lease = null; let switchOn = true;
  const runSk = (ms) => `run#${new Date(ms).toISOString()}`;
  return {
    runSk, defs, runs, setSwitch: (v) => { switchOn = v; },
    async listRoutines() { return [...defs.values()].map((x) => structuredClone(x)); },
    async getRoutine(id) { const r = defs.get(id); return r ? structuredClone(r) : null; },
    async createRoutine(r) { const it = { ...r, version: 1 }; defs.set(r.id, it); return structuredClone(it); },
    async saveRoutine(r) {
      const cur = defs.get(r.id);
      if (!cur || cur.version !== r.version) throw Object.assign(new Error("c"), { name: "RoutineConflict" });
      const it = { ...r, version: r.version + 1 }; defs.set(r.id, it); return structuredClone(it);
    },
    async updateRoutine(id, mutate) {
      const cur = defs.get(id); if (!cur) return null;
      const next = mutate(structuredClone(cur)); if (!next) return structuredClone(cur);
      return this.saveRoutine(next);
    },
    async deleteRoutine(id) { defs.delete(id); },
    async putRun(id, run) {
      const k = `${id}|${runSk(run.scheduled_at)}`;
      if (runs.has(k)) return false;
      runs.set(k, { ...run, sk: runSk(run.scheduled_at) }); return true;
    },
    async updateRun(id, sk, f) { const k = `${id}|${sk}`; if (!runs.has(k)) return null; runs.set(k, { ...runs.get(k), ...f }); return runs.get(k); },
    async listRuns(id, limit = 50) {
      return [...runs.entries()].filter(([k]) => k.startsWith(`${id}|`)).map(([, v]) => v)
        .sort((a, b) => b.scheduled_at - a.scheduled_at).slice(0, limit);
    },
    async acquireLease(now, ttl, owner) { if (lease && lease.until >= now) return false; lease = { until: now + ttl, owner }; return true; },
    async releaseLease(owner) { if (lease?.owner === owner) lease = null; },
    async routinesEnabled() { return switchOn; },
    _holdLease(now) { lease = { until: now + HOUR, owner: "someone-else" }; },
  };
}

const SKILL = {
  skill_id: "rds-check", name: "RDS 巡检", latest_version: "1.0.2",
  devops_agent: { uploads: { self: { asset_id: "a-1", agent_space_id: "sp-1", uploaded_version: "1.0.2", marker: true } } },
};

function harness({ now = T0 } = {}) {
  const store = memStore();
  const clock = { now };
  const calls = { start: [], conv: [], msgs: [], notif: [] };
  const status = new Map();     // taskId -> status
  let seq = 0;
  const env = {
    skill: structuredClone(SKILL), assetExists: true, startError: null, bundles: ["rds-check"], ownerExists: true,
    accountActive: true,
  };
  const deps = {
    now: () => clock.now, store,
    clientFor: async () => ({ client: {}, target: { agentSpaceId: "sp-1", scope: "self", accountId: "111122223333" } }),
    startInvestigation: async (p) => {
      if (env.startError) throw Object.assign(new Error("x"), { name: env.startError });
      calls.start.push(p); const id = `task-${++seq}`; status.set(id, "IN_PROGRESS");
      return { taskId: id, executionId: `exe-${seq}`, consoleUrl: `https://sp-1.aidevops.global.app.aws/investigation/${id}` };
    },
    getTaskStatus: async ({ taskId }) => ({ status: status.get(taskId) || "IN_PROGRESS" }),
    collectInvestigation: async ({ keyPrefix }) => ({
      markdown: "# s", chatMd: "## Summary\nRDS 连接数正常", report: { url: `https://cdn/${keyPrefix}/r.html` },
      trace: { url: `https://cdn/${keyPrefix}/r-trace.html` },
      records: [{ recordType: "utilization", content: JSON.stringify({ data: { skills: { bundles: env.bundles.map((name) => ({ name })) } } }) }],
    }),
    loadedSkillBundles, operatorUrls, investigationRef, uploadRecordFor,
    getSkill: async (id) => (id === env.skill?.skill_id ? structuredClone(env.skill) : null),
    assetExists: async () => env.assetExists,
    accountActive: async () => env.accountActive,
    ownerExists: async () => env.ownerExists,
    ensureConversation: async (sub, id, title, topic) => { calls.conv.push({ sub, id, title, topic }); },
    appendMessage: async (id, m) => { calls.msgs.push({ id, ...m }); },
    touchConversation: async () => {},
    putNotification: async (n) => { calls.notif.push(n); },
  };
  const eng = makeEngine(deps);
  api._inject({ store, engine: eng, now: () => clock.now });
  const add = (over = {}) => {
    const r = {
      id: `rt-${store.defs.size + 1}`, name: "每天看 RDS", skill_id: "rds-check", skill_name: "RDS 巡检", account_id: "",
      context: "重点看 prod", locale: "zh", owner_sub: "sub-1", owner_username: "alice",
      schedule: { kind: "daily", tz: "Asia/Shanghai", time: "09:00" }, enabled: true, paused_reason: null,
      next_run_at: T0, active_run: null, last_run: null, consecutive_failures: 0, run_count: 0, version: 1, ...over,
    };
    store.defs.set(r.id, r); return r.id;
  };
  return { store, clock, calls, status, env, eng, add };
}

console.log("routines_run: 执行引擎与 API");

await t("到点派发：描述 = 标记 + 计划时间 + 引用安装的 Skill + 上下文；clientToken 稳定；下一次排到明天", async () => {
  const h = harness();
  const id = h.add();
  const s = await h.eng.tick();
  assert.equal(s.started, 1);
  const p = h.calls.start[0];
  assert.equal(p.prefix, ROUTINE_PREFIX);
  assert.ok(p.description.startsWith("NOTIOPS_SKILL:rds-check\n[NotiOps 定时任务「每天看 RDS」，计划时间 2026-11-02 09:00 (Asia/Shanghai)]"));
  assert.ok(p.description.includes("v1.0.2") && p.description.includes("重点看 prod"));
  assert.ok(!p.description.includes("=== Skill:"), "不贴正文");
  assert.equal(p.clientToken.length, 64);
  const r = await h.store.getRoutine(id);
  assert.equal(r.active_run.status, "running");
  assert.equal(new Date(r.next_run_at).toISOString(), "2026-11-03T01:00:00.000Z");
  assert.equal([...h.store.runs.values()][0].status, "running");
  // 同一次计划运行再算一遍 clientToken → 一样（重试不会建出第二场调查）
  const again = buildRoutineDescription({ routine: r, skill: SKILL, upload: SKILL.devops_agent.uploads.self, scheduledAt: T0 });
  assert.equal(again, p.description);
});

await t("跑完：一个会话（故障调查主题、可追问）+ 一条通知（查看报告 / 打开会话）+ 运行记录成功", async () => {
  const h = harness();
  const id = h.add();
  await h.eng.tick();
  h.clock.now += 5 * MIN;
  assert.equal((await h.eng.tick()).collected, 0, "还在跑就不收");
  h.status.set("task-1", "COMPLETED");
  h.clock.now += 5 * MIN;
  assert.equal((await h.eng.tick()).collected, 1);
  assert.equal(h.calls.conv.length, 1);
  assert.equal(h.calls.conv[0].topic, "investigate");
  assert.equal(h.calls.conv[0].sub, "sub-1");
  const [u, a] = h.calls.msgs;
  assert.equal(u.role, "user");
  assert.ok(u.text.includes("每天看 RDS") && u.text.includes("重点看 prod"));
  assert.equal(a.role, "assistant");
  assert.equal(a.path, "deep-direct");
  assert.equal(a.via, "devops-agent");
  assert.deepEqual(a.investigation, { task_id: "task-1", execution_id: "exe-1" });
  assert.ok(a.text.includes("✅") && a.text.includes("RDS 连接数正常") && a.text.includes("保留 30 天"));
  assert.ok(a.text.includes("[[investigation:task-1]]"));
  const n = h.calls.notif[0];
  assert.equal(n.severity, "info");
  assert.ok(n.title.includes("每天看 RDS"));
  assert.ok(n.report_url.includes(`routine-reports/${id}/`), "报告落 30 天保留的 routine-reports/ 前缀");
  assert.equal(n.conv_id, h.calls.conv[0].id);
  assert.equal(n.owner, "alice");
  const r = await h.store.getRoutine(id);
  assert.equal(r.active_run, null);
  assert.equal(r.last_run.status, "succeeded");
  assert.equal(r.last_run.skill_loaded, true);
  const run = (await h.store.listRuns(id))[0];
  assert.equal(run.status, "succeeded");
  assert.equal(run.conv_id, n.conv_id);
});

await t("没加载 Skill → 运行照算完成，但会话里明说、通知降为 warn", async () => {
  const h = harness();
  h.env.bundles = ["some-other-skill"];
  const id = h.add();
  await h.eng.tick();
  h.status.set("task-1", "COMPLETED");
  h.clock.now += 5 * MIN;
  await h.eng.tick();
  assert.ok(h.calls.msgs[1].text.includes("没有确认加载 Skill「RDS 巡检」"));
  assert.equal(h.calls.notif[0].severity, "warn");
  assert.equal((await h.store.getRoutine(id)).last_run.skill_loaded, false);
});

await t("上一次还在跑 → 这一次跳过（不排队），记原因", async () => {
  const h = harness();
  const id = h.add({ schedule: { kind: "hourly", tz: "Asia/Shanghai", minute: 0 } });
  await h.eng.tick();
  h.clock.now += HOUR;
  const s = await h.eng.tick();
  assert.equal(s.skipped, 1);
  const runs = await h.store.listRuns(id);
  assert.equal(runs[0].status, "skipped");
  assert.equal(runs[0].reason, "previous_running");
  assert.equal(h.calls.start.length, 1);
});

await t("同时最多 2 个：第 3 个排队；名额空出来就跑；30 分钟等不到就跳过", async () => {
  const h = harness();
  const a = h.add(), b = h.add(), c = h.add(), d4 = h.add();
  const s = await h.eng.tick();
  assert.equal(s.started, LIMITS.maxConcurrent);
  assert.equal(s.queued, 2);
  // 第一个跑完 → 下一轮收尾后，排队最久的那个开始
  h.status.set("task-1", "COMPLETED");
  h.clock.now += 5 * MIN;
  const s2 = await h.eng.tick();
  assert.equal(s2.collected, 1);
  assert.equal(s2.started, 1);
  const states = await Promise.all([a, b, c, d4].map((x) => h.store.getRoutine(x)));
  assert.equal(states.filter((r) => r.active_run?.status === "running").length, 2);
  // 剩下那个一直等不到 → 30 分钟后跳过
  h.clock.now += 31 * MIN;
  const s3 = await h.eng.tick();
  assert.equal(s3.skipped, 1);
  const waited = states.find((r) => r.active_run?.status === "queued");
  const last = (await h.store.listRuns(waited.id))[0];
  assert.equal(last.status, "skipped");
  assert.equal(last.reason, "concurrency_full");
});

await t("总开关关了 → 不派发（记 kill_switch），进行中的照样回收", async () => {
  const h = harness();
  const a = h.add();
  await h.eng.tick();
  h.store.setSwitch(false);
  const b = h.add();
  h.status.set("task-1", "COMPLETED");
  h.clock.now += 5 * MIN;
  const s = await h.eng.tick();
  assert.equal(s.collected, 1);
  assert.equal(s.started, 0);
  assert.equal((await h.store.listRuns(b))[0].reason, "kill_switch");
  assert.equal((await h.store.getRoutine(a)).last_run.status, "succeeded");
});

await t("停了 3 小时：只跑最近那一次，更早的记一条「已错过」；超过 6 小时只记错过", async () => {
  const h = harness({ now: T0 + 3 * HOUR + 2 * MIN });
  const id = h.add({ schedule: { kind: "hourly", tz: "Asia/Shanghai", minute: 0 }, next_run_at: T0 });
  await h.eng.tick();
  assert.equal(h.calls.start.length, 1, "只跑一次");
  const runs = await h.store.listRuns(id);
  const ran = runs.find((x) => x.status === "running");
  assert.equal(new Date(ran.scheduled_at).toISOString(), "2026-11-02T04:00:00.000Z");
  assert.equal(ran.trigger, "schedule");
  assert.ok(runs.some((x) => x.status === "skipped" && x.reason === "missed"));
  const h2 = harness({ now: T0 + 8 * HOUR });
  const id2 = h2.add({ next_run_at: T0 });
  await h2.eng.tick();
  assert.equal(h2.calls.start.length, 0);
  assert.equal((await h2.store.listRuns(id2))[0].reason, "missed");
  assert.equal(new Date((await h2.store.getRoutine(id2)).next_run_at).toISOString(), "2026-11-03T01:00:00.000Z");
});

await t("发起失败 3 次 → 自动暂停 + 通知；Skill 被撤下 → 第一次就暂停", async () => {
  const h = harness();
  h.env.startError = "ThrottlingException";
  const id = h.add({ schedule: { kind: "hourly", tz: "Asia/Shanghai", minute: 0 } });
  for (let i = 0; i < 3; i++) { await h.eng.tick(); h.clock.now += HOUR; }
  const r = await h.store.getRoutine(id);
  assert.equal(r.enabled, false);
  assert.equal(r.paused_reason, "consecutive_failures");
  assert.ok(h.calls.notif.some((n) => n.title.includes("已暂停")));
  const h2 = harness();
  h2.env.assetExists = false;
  const id2 = h2.add();
  await h2.eng.tick();
  const r2 = await h2.store.getRoutine(id2);
  assert.equal(r2.enabled, false);
  assert.equal(r2.paused_reason, "skill_not_published");
  assert.equal((await h2.store.listRuns(id2))[0].reason, "skill_not_published");
});

await t("负责人被删 / 账号停用 → 立即暂停，不再发起调查", async () => {
  const h = harness();
  h.env.ownerExists = false;
  const id = h.add();
  await h.eng.tick();
  assert.equal(h.calls.start.length, 0);
  assert.equal((await h.store.getRoutine(id)).paused_reason, "owner_deleted");
  const h2 = harness();
  h2.env.accountActive = false;
  const id2 = h2.add({ account_id: "111122223333" });
  await h2.eng.tick();
  assert.equal((await h2.store.getRoutine(id2)).paused_reason, "account_inactive");
});

await t("6 小时还没终态 → 按未完成收尾（会话里写明），失败计数 +1", async () => {
  const h = harness();
  const id = h.add();
  await h.eng.tick();
  h.clock.now += 6 * HOUR + MIN;
  const s = await h.eng.tick();
  assert.equal(s.collected, 1);
  const r = await h.store.getRoutine(id);
  assert.equal(r.last_run.status, "failed");
  assert.equal(r.last_run.reason, "no_terminal_state");
  assert.equal(r.consecutive_failures, 1);
  assert.ok(h.calls.msgs[1].text.includes("6 小时内没有结束"));
});

await t("tick 租约被别人拿着 → 这一轮什么都不做", async () => {
  const h = harness();
  h.add();
  h.store._holdLease(h.clock.now);
  assert.deepEqual(await h.eng.tick(), { skipped: "lease_held" });
  assert.equal(h.calls.start.length, 0);
});

await t("立即运行：不改下一次计划；上一次在跑 → 409；每小时 3 次；名额满 → 排队", async () => {
  const h = harness({ now: T0 - 2 * HOUR });
  const id = h.add({ next_run_at: T0 });
  const r1 = await api.apiRunRoutineNow(id, { username: "alice" });
  assert.equal(r1.status, 200);
  assert.equal((await h.store.getRoutine(id)).next_run_at, T0);
  assert.equal((await api.apiRunRoutineNow(id, {})).body.error, "previous_running");
  h.status.set("task-1", "COMPLETED"); h.clock.now += 5 * MIN; await h.eng.tick();
  await api.apiRunRoutineNow(id, {}); h.status.set("task-2", "COMPLETED"); h.clock.now += 5 * MIN; await h.eng.tick();
  await api.apiRunRoutineNow(id, {}); h.status.set("task-3", "COMPLETED"); h.clock.now += 5 * MIN; await h.eng.tick();
  const r4 = await api.apiRunRoutineNow(id, {});
  assert.equal(r4.status, 429);
  const h2 = harness();
  const x = h2.add({ next_run_at: T0 + HOUR }), y = h2.add({ next_run_at: T0 + HOUR }), z = h2.add({ next_run_at: T0 + HOUR });
  await api.apiRunRoutineNow(x, {}); await api.apiRunRoutineNow(y, {});
  const rq = await api.apiRunRoutineNow(z, {});
  assert.equal(rq.status, 202);
  assert.equal((await h2.store.getRoutine(z)).active_run.status, "queued");
});

await t("API 新建：校验输入、Skill 必须已发布、20 个上限；回前端不带 owner_sub / version", async () => {
  const h = harness();
  const base = { name: "看 RDS", skill_id: "rds-check", account_id: "", context: "c",
                 schedule: { kind: "daily", tz: "Asia/Shanghai", time: "09:00" } };
  assert.equal((await api.apiCreateRoutine({ ...base, name: "" }, {})).body.error, "invalid_name");
  assert.equal((await api.apiCreateRoutine({ ...base, schedule: { kind: "cron", tz: "Asia/Shanghai", cron: "*/10 * * * *" } }, {})).body.error, "too_frequent");
  assert.equal((await api.apiCreateRoutine({ ...base, context: "x".repeat(LIMITS.contextMax + 1) }, {})).body.error, "context_too_long");
  assert.equal((await api.apiCreateRoutine({ ...base, account_id: "12" }, {})).body.error, "invalid_account");
  h.env.assetExists = false;
  assert.equal((await api.apiCreateRoutine(base, {})).body.error, "skill_not_published");
  h.env.assetExists = true;
  const ok1 = await api.apiCreateRoutine(base, { sub: "sub-9", username: "bob" });
  assert.equal(ok1.status, 200);
  assert.equal(ok1.body.routine.owner_username, "bob");
  assert.equal(ok1.body.routine.owner_sub, undefined);
  assert.equal(ok1.body.routine.version, undefined);
  assert.equal(new Date(ok1.body.routine.next_run_at).toISOString(), "2026-11-03T01:00:00.000Z");
  for (let i = 0; i < LIMITS.maxEnabled - 1; i++) h.add({ next_run_at: T0 + HOUR });
  assert.equal((await api.apiCreateRoutine(base, {})).status, 409);
  assert.equal((await api.apiCreateRoutine({ ...base, enabled: false }, {})).status, 200, "暂停状态的不占名额");
});

await t("API 启停：恢复前再核一遍 Skill；恢复后从现在起算下一次、清掉失败计数", async () => {
  const h = harness();
  const id = h.add({ enabled: false, paused_reason: "consecutive_failures", consecutive_failures: 3, next_run_at: T0 - HOUR });
  h.env.assetExists = false;
  assert.equal((await api.apiToggleRoutine(id, { enabled: true }, {})).body.error, "skill_not_published");
  h.env.assetExists = true;
  const r = await api.apiToggleRoutine(id, { enabled: true }, {});
  assert.equal(r.body.routine.enabled, true);
  assert.equal(r.body.routine.consecutive_failures, 0);
  assert.equal(r.body.routine.paused_reason, null);
  assert.ok(r.body.routine.next_run_at > T0);
  const p = await api.apiToggleRoutine(id, { enabled: false }, {});
  assert.equal(p.body.routine.paused_reason, "paused_by_user");
});

await t("API 列表：一并回已发布的 Skill（不依赖 nav:skills），没发布的不列；读不到 → null 而不是空", async () => {
  const h = harness();
  h.add();
  api._inject({ listSkills: async () => [
    { skill_id: "rds-check", name: "RDS 巡检", latest_version: "1.0.2",
      devops_agent: { uploads: { self: { uploaded_version: "1.0.2", marker: true },
                                 "111122223333": { account_id: "111122223333", uploaded_version: "1.0.1" } } } },
    { skill_id: "draft", name: "草稿", devops_agent: { uploads: {} } },
  ] });
  const r = await api.apiListRoutines();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.skills.map((s) => s.skill_id), ["rds-check"]);
  assert.deepEqual(r.body.skills[0].targets.map((x) => x.account_id), ["", "111122223333"]);
  assert.equal(r.body.limits.report_retention_days, 30);
  assert.equal(r.body.routines[0].owner_sub, undefined);
  api._inject({ listSkills: async () => { throw Object.assign(new Error("x"), { name: "InternalError" }); } });
  assert.equal((await api.apiListRoutines()).body.skills, null);
});

await t("接线：tick 分支在鉴权之前、只认固定 source；权限节点是新前缀，不在 action:skills 下", async () => {
  const INDEX = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.ok(INDEX.indexOf('event.source === "notiops.routines.tick"') < INDEX.indexOf("claims = await authClaims(event)"));
  const caps = JSON.parse(readFileSync(new URL("../capabilities.json", import.meta.url), "utf8"));
  const node = (k) => caps.nodes.find((n) => n.key === k);
  assert.ok(node("nav:routines") && node("action:routines:manage"));
  assert.ok(!caps.nodes.some((n) => n.key.startsWith("action:skills:") && JSON.stringify(n.routes || []).includes("/routines")));
  const pats = node("action:routines:manage").routes.map((r) => `${r.method} ${r.pattern}`);
  for (const want of ["POST /routines$", "PUT /routines/[^/]+$", "DELETE /routines/[^/]+$", "POST /routines/[^/]+/run$", "POST /routines/[^/]+/toggle$"]) {
    assert.ok(pats.includes(want), `缺 ${want}`);
  }
});

console.log(fails ? `\n${fails} failed` : `\n${ok} ok, 0 failed`);
process.exit(fails ? 1 : 0);
