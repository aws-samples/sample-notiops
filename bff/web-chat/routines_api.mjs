/**
 * 「更多 → 定时任务」的 API（权限：看 = nav:routines；改 / 删 / 启停 / 立即运行 = action:routines:manage，
 * 默认只有管理员有，见 capabilities.json）。
 *
 *   GET    /routines                 列表 + 上限 + 总开关状态
 *   POST   /routines                 新建
 *   PUT    /routines/{id}            修改（只改传了的字段）
 *   DELETE /routines/{id}            删除（已经生成的会话与报告不删）
 *   POST   /routines/{id}/toggle     启用 / 暂停 {enabled}
 *   POST   /routines/{id}/run        立即运行（不改下一次的计划时间；每个任务每小时最多 3 次）
 *   GET    /routines/{id}/runs       最近的运行记录
 *
 * 新建 / 修改时要求所选 Skill **已发布到目标账号的 Agent Space 并且确实还在**（GetAsset）——
 * 运行时不贴 Skill 正文，只引用安装的那份（devops_skill.mjs 的 buildSkillReference）。
 * account_id 由 index.mjs 的统一门禁按账号可见性校验（body.account_id）。
 */
import { randomUUID } from "node:crypto";
import * as defaultStore from "./routines_store.mjs";
import { validateSchedule, nextRun, MIN_INTERVAL_MINUTES } from "./routines_schedule.mjs";
import { engine as defaultEngine, LIMITS } from "./routines_run.mjs";

const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const ACCOUNT_RE = /^\d{12}$/;

let _store = defaultStore, _engine = null, _now = () => Date.now(), _listSkills = null;
/** 仅供测试：注入假的存储 / 引擎 / 时钟 / Skill 列表。 */
export function _inject({ store, engine, now, listSkills } = {}) {
  if (store) _store = store;
  if (engine) _engine = engine;
  if (now) _now = now;
  if (listSkills) _listSkills = listSkills;
}

/** 已发布到 DevOps Agent 的 Skill（新建框的下拉用）。由这里给而不是让前端调 /skills：那条要 nav:skills，
 *  只被授了定时任务权限的人会拿不到。只回展示要的几个字段；是否真的还在由保存时的 GetAsset 判。 */
async function publishableSkills() {
  const list = _listSkills ? await _listSkills() : await (await import("./skills.mjs")).listSkills();
  return (list || [])
    .filter((s) => Object.keys(s?.devops_agent?.uploads || {}).length)
    .map((s) => ({
      skill_id: s.skill_id, name: s.name || s.skill_id, latest_version: s.latest_version || "",
      targets: Object.entries(s.devops_agent.uploads).map(([key, u]) => ({
        key, account_id: key === "self" ? "" : (u?.account_id || key),
        uploaded_version: u?.uploaded_version || "", marker: !!u?.marker,
      })),
    }));
}
const eng = () => _engine || defaultEngine();

const bad = (error, extra = {}) => ({ status: 400, body: { error, ...extra } });

/** 回前端的形状（去掉 owner_sub / version 这类内部字段）。 */
export function publicRoutine(r) {
  if (!r) return null;
  const { owner_sub, version, ...rest } = r;
  return rest;
}

/** 校验并归一可改的字段；`partial` = 只校验传了的。返回 { fields } 或 { error }。 */
export function normalizeInput(body, { partial = false, now = Date.now() } = {}) {
  const b = body && typeof body === "object" ? body : {};
  const f = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (!partial || has("name")) {
    const name = String(b.name ?? "").trim();
    if (!name || name.length > LIMITS.nameMax) return { error: "invalid_name" };
    f.name = name;
  }
  if (!partial || has("skill_id")) {
    const id = String(b.skill_id ?? "").trim();
    if (!SKILL_ID_RE.test(id)) return { error: "invalid_skill" };
    f.skill_id = id;
  }
  if (!partial || has("account_id")) {
    const a = String(b.account_id ?? "").trim();
    if (a && !ACCOUNT_RE.test(a)) return { error: "invalid_account" };
    f.account_id = a;
  }
  if (!partial || has("context")) {
    const c = String(b.context ?? "").trim();
    if (c.length > LIMITS.contextMax) return { error: "context_too_long", limit: LIMITS.contextMax };
    f.context = c;
  }
  if (!partial || has("schedule")) {
    try { f.schedule = validateSchedule(b.schedule, { now }); }
    catch (e) { return { error: e.reason || "invalid_schedule" }; }
  }
  if (has("locale")) f.locale = b.locale === "en" ? "en" : "zh";
  return { fields: f };
}

const enabledCount = (list, exceptId = "") => list.filter((r) => r.enabled && r.id !== exceptId && r.next_run_at).length;

function audit(event, data) {
  console.log(JSON.stringify({ audit: event, ...data }));
}

export async function apiListRoutines() {
  const [list, switchOn, skills] = await Promise.all([
    _store.listRoutines(), _store.routinesEnabled(),
    publishableSkills().catch((e) => { console.warn(`[routines] list skills failed: ${e?.name || "Error"}`); return null; }),
  ]);
  list.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  return {
    status: 200,
    body: {
      routines: list.map(publicRoutine),
      switch_on: switchOn,
      // null = 这次没列出来（S3 抖动）：前端说「读不到」，别画成「没有已发布的 Skill」。
      skills,
      limits: { max_enabled: LIMITS.maxEnabled, max_concurrent: LIMITS.maxConcurrent,
                min_interval_minutes: MIN_INTERVAL_MINUTES, context_max: LIMITS.contextMax,
                run_now_per_hour: LIMITS.runNowPerHour, max_failures: LIMITS.maxFailures,
                report_retention_days: 30 },
    },
  };
}

export async function apiCreateRoutine(body, actor = {}) {
  const now = _now();
  const { fields, error, ...extra } = normalizeInput(body, { now });
  if (error) return bad(error, extra);
  const enabled = body?.enabled !== false;
  if (enabled && enabledCount(await _store.listRoutines()) >= LIMITS.maxEnabled) {
    return { status: 409, body: { error: "too_many_routines", limit: LIMITS.maxEnabled } };
  }
  const v = await eng().verifyPublished(fields.skill_id, fields.account_id);
  if (!v.ok) return bad(v.reason);
  const routine = {
    id: `rt-${now.toString(36)}-${randomUUID().slice(0, 6)}`,
    ...fields,
    locale: fields.locale || "zh",
    skill_name: v.skill?.name || fields.skill_id,
    owner_sub: actor.sub || "", owner_username: actor.username || "",
    enabled, paused_reason: enabled ? null : "paused_by_user",
    next_run_at: nextRun(fields.schedule, now),
    active_run: null, last_run: null, consecutive_failures: 0, run_count: 0,
    created_at: now, created_by: actor.username || "", updated_at: now, updated_by: actor.username || "",
  };
  const saved = await _store.createRoutine(routine);
  audit("routine_create", { id: saved.id, by: actor.username || "", skill: saved.skill_id,
                            account: saved.account_id || "self", schedule: saved.schedule?.kind, ip: actor.ip || "" });
  return { status: 200, body: { routine: publicRoutine(saved) } };
}

export async function apiUpdateRoutine(id, body, actor = {}) {
  const now = _now();
  const cur = await _store.getRoutine(id);
  if (!cur) return { status: 404, body: { error: "not_found" } };
  const { fields, error, ...extra } = normalizeInput(body, { partial: true, now });
  if (error) return bad(error, extra);
  const skillId = fields.skill_id ?? cur.skill_id;
  const accountId = fields.account_id ?? cur.account_id ?? "";
  let skillName = cur.skill_name;
  if (skillId !== cur.skill_id || accountId !== (cur.account_id || "")) {
    const v = await eng().verifyPublished(skillId, accountId);
    if (!v.ok) return bad(v.reason);
    skillName = v.skill?.name || skillId;
  }
  const saved = await _store.updateRoutine(id, (r) => {
    Object.assign(r, fields);
    r.skill_name = skillName;
    if (fields.schedule) r.next_run_at = r.enabled ? nextRun(fields.schedule, now) : r.next_run_at;
    r.updated_at = now; r.updated_by = actor.username || "";
    return r;
  });
  audit("routine_update", { id, by: actor.username || "", fields: Object.keys(fields), ip: actor.ip || "" });
  return { status: 200, body: { routine: publicRoutine(saved) } };
}

export async function apiDeleteRoutine(id, actor = {}) {
  const cur = await _store.getRoutine(id);
  if (!cur) return { status: 404, body: { error: "not_found" } };
  await _store.deleteRoutine(id);
  audit("routine_delete", { id, by: actor.username || "", name: cur.name, had_active_run: !!cur.active_run, ip: actor.ip || "" });
  return { status: 200, body: { ok: true } };
}

export async function apiToggleRoutine(id, body, actor = {}) {
  const now = _now();
  const cur = await _store.getRoutine(id);
  if (!cur) return { status: 404, body: { error: "not_found" } };
  const enable = body?.enabled === true;
  if (enable) {
    if (enabledCount(await _store.listRoutines(), id) >= LIMITS.maxEnabled) {
      return { status: 409, body: { error: "too_many_routines", limit: LIMITS.maxEnabled } };
    }
    const next = nextRun(cur.schedule, now);
    if (next === null) return { status: 409, body: { error: "no_future_run" } };
    // 暂停的原因可能正是 Skill 被撤下 / 账号停用 —— 恢复之前再核一遍，别恢复成一个注定失败的任务。
    const v = await eng().verifyPublished(cur.skill_id, cur.account_id || "");
    if (!v.ok) return bad(v.reason);
  }
  const saved = await _store.updateRoutine(id, (r) => {
    r.enabled = enable;
    if (enable) {
      r.paused_reason = null; r.consecutive_failures = 0; r.next_run_at = nextRun(r.schedule, now);
    } else {
      r.paused_reason = "paused_by_user";
    }
    r.updated_at = now; r.updated_by = actor.username || "";
    return r;
  });
  audit(enable ? "routine_resume" : "routine_pause", { id, by: actor.username || "", ip: actor.ip || "" });
  return { status: 200, body: { routine: publicRoutine(saved) } };
}

export async function apiRunRoutineNow(id, actor = {}) {
  const res = await eng().runNow(id);
  audit("routine_run_now", { id, by: actor.username || "", result: res.body?.error || (res.body?.queued ? "queued" : "started"),
                             ip: actor.ip || "" });
  return res;
}

export async function apiListRoutineRuns(id) {
  const cur = await _store.getRoutine(id);
  if (!cur) return { status: 404, body: { error: "not_found" } };
  return { status: 200, body: { runs: await _store.listRuns(id, 50) } };
}
