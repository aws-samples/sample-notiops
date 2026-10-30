/**
 * 定时任务的执行引擎：到点派发一次 DevOps Agent 深度调查（用一个已发布的 Skill），跑完把结果写成
 * 一个会话 + 一条站内通知 + 一条运行记录。由 EventBridge 每 5 分钟触发一次 BFF（index.mjs 里
 * `source: "notiops.routines.tick"` 那一支，在鉴权之前分流；外部 HTTP 请求带不进这个字段）。
 *
 * 为什么一条固定规则 + DynamoDB，而不是每个任务一个 EventBridge Scheduler schedule：
 *   规则由 CloudFormation 管、删栈就没了，两条部署路径都不需要在运行时建 / 删资源，
 *   BFF 也不需要 scheduler:* 与 iam:PassRole（与巡检 lambda_inspection_scheduler 同一个取舍）。
 *   代价是启动有 0–5 分钟的偏差；最快每小时一次，这点偏差可以接受（界面写明）。
 *
 * 护栏（参考 Claude Code 的 scheduled tasks，再加成本控制）：
 *   · 同一任务上一次还在跑 → 这一次**跳过**（不排队），记原因；
 *   · 定时调查同时最多 2 个（每个 Agent Space 默认同时 3 个调查，给交互式深度调查留 1 个）：
 *     满了先排队，30 分钟内等不到名额就跳过，记「并发已满」；
 *   · 错过的（tick 停了一阵）：6 小时内只补最近那一次，更早的记「已错过」；
 *   · 连续失败 3 次 → 自动暂停并发通知；配置类问题（Skill 被删 / 撤下、账号停用、负责人被删）立即暂停；
 *   · 总开关（notiops-config 的 appconfig#routines/enabled）关掉 → 不派发，进行中的照样回收；
 *   · 不自动重试调查（每次都花钱）。
 *
 * 触发时那段描述是任务创建时存好的，**不是实时的用户输入**，只当数据；DevOps Agent 调查本身只读。
 */
import { randomUUID, createHash } from "node:crypto";
import * as defaultStore from "./routines_store.mjs";
import { nextRun, latestDue } from "./routines_schedule.mjs";
import { buildSkillReference, DESCRIPTION_LIMIT } from "./devops_skill.mjs";
import { safeErr } from "./safe_err.mjs";

/** 能给前端看的失败细节：我们自己写的 userError 短码原样给，上游异常只给异常名（不外泄原始 message）。 */
function clientDetail(e) {
  const own = e?.code === "bad_request";
  return own ? String(e.message || "") : safeErr(e);
}

export const LIMITS = Object.freeze({
  maxEnabled: 20,
  maxConcurrent: 2,
  catchUpMs: 6 * 3600 * 1000,
  queueWaitMs: 30 * 60 * 1000,
  staleMs: 6 * 3600 * 1000,
  maxFailures: 3,
  runNowPerHour: 3,
  leaseMs: 270 * 1000,
  contextMax: 2000,
  nameMax: 80,
});
export const ROUTINE_PREFIX = "[notiops-routine] ";
export const REPORT_PREFIX = "routine-reports";
export const NOTIF_SOURCE = "NotiOps Scheduled task";
/** 这些原因不会自己好：直接暂停，别让它每小时失败一次。 */
const PAUSE_NOW = new Set(["skill_deleted", "skill_not_published", "account_inactive", "owner_deleted"]);
/** 晚于计划时间多久算「补跑」而不是「准点」（tick 间隔 5 分钟 + 余量）。 */
const ON_TIME_MS = 10 * 60 * 1000;

const sha = (s) => createHash("sha256").update(s).digest("hex");

/** 任务时区里的本地时间，例如 "2026-11-02 09:00"。 */
export function formatLocal(ms, tz) {
  try {
    const p = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(new Date(ms));
    const g = (t) => p.find((x) => x.type === t)?.value || "";
    return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}`;
  } catch { return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC"; }
}

/** 发给 DevOps Agent 的描述：触发标记 + 「哪个定时任务、哪个计划时间」 + 引用已安装的 Skill + 账号 + 上下文。 */
export function buildRoutineDescription({ routine, skill, upload, scheduledAt }) {
  const en = routine.locale === "en";
  const when = `${formatLocal(scheduledAt, routine.schedule?.tz || "UTC")} (${routine.schedule?.tz || "UTC"})`;
  const lead = en
    ? `[NotiOps scheduled task "${routine.name}", scheduled for ${when}]\n`
    : `[NotiOps 定时任务「${routine.name}」，计划时间 ${when}]\n`;
  const ctx = String(routine.context || "").trim() || (en ? "(none)" : "（无）");
  const parts = [];
  if (routine.account_id) parts.push(en ? `Target account: ${routine.account_id}` : `目标账号：${routine.account_id}`);
  parts.push(en ? `Context from the task owner:\n${ctx}` : `任务负责人补充的上下文：\n${ctx}`);
  return buildSkillReference({ text: parts.join("\n\n"), skill, en, upload, lead });
}

/** 真实依赖（懒加载：单测用 makeEngine 注入假的）。 */
async function realDeps() {
  const inv = await import("./devops_investigate.mjs");
  const das = await import("./devops_agent_skills.mjs");
  const sk = await import("./skills.mjs");
  const conv = await import("./store.mjs");
  const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
  const { DynamoDBDocumentClient, GetCommand, PutCommand } = await import("@aws-sdk/lib-dynamodb");
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  const CONFIG_TABLE = process.env.CONFIG_TABLE || "notiops-config";
  const WEB_TABLE = process.env.WEB_CHAT_TABLE || "notiops-web-chat";
  const NOTIF_KEY = process.env.NOTIF_INBOX_KEY || "account";
  return {
    now: () => Date.now(),
    store: defaultStore,
    clientFor: inv.clientFor,
    startInvestigation: inv.startInvestigation,
    getTaskStatus: inv.getTaskStatus,
    collectInvestigation: inv.collectInvestigation,
    loadedSkillBundles: inv.loadedSkillBundles,
    operatorUrls: inv.operatorUrls,
    investigationRef: inv.investigationRef,
    getSkill: (id) => sk.getSkill(id),
    uploadRecordFor: das.uploadRecordFor,
    /** GetAsset：true = 在；false = 确定不在；null = 这次没查成（不据此暂停）。 */
    assetExists: async (client, agentSpaceId, assetId) => {
      try {
        const { GetAssetCommand } = await import("@aws-sdk/client-devops-agent");
        await client.send(new GetAssetCommand({ agentSpaceId, assetId }));
        return true;
      } catch (e) {
        if (e?.name === "ResourceNotFoundException") return false;
        console.warn(`[routines] GetAsset failed: ${e?.name || "Error"}`);
        return null;
      }
    },
    /** 成员账号必须仍是 active 且没被停用；本账号恒为 true。读失败 → null（不据此暂停）。 */
    accountActive: async (accountId) => {
      if (!accountId) return true;
      try {
        const r = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: { PK: `da#${accountId}`, SK: "meta" } }));
        const it = r.Item;
        if (!it) return false;
        return it.onboarding_status === "active" && it.enabled !== false;
      } catch { return null; }
    },
    /** 负责人还在不在（AdminGetUser）。读失败 → null（不据此暂停）。 */
    ownerExists: async (username) => {
      if (!username) return null;
      try {
        const { CognitoIdentityProviderClient, AdminGetUserCommand } = await import("@aws-sdk/client-cognito-identity-provider");
        const pool = process.env.COGNITO_USER_POOL_ID || "";
        if (!pool) return null;
        await new CognitoIdentityProviderClient({}).send(new AdminGetUserCommand({ UserPoolId: pool, Username: username }));
        return true;
      } catch (e) { return e?.name === "UserNotFoundException" ? false : null; }
    },
    ensureConversation: conv.ensureConversation,
    appendMessage: conv.appendMessage,
    touchConversation: conv.touchConversation,
    putNotification: async (n) => {
      const ts = n.ts || Date.now();
      await ddb.send(new PutCommand({
        TableName: WEB_TABLE,
        Item: {
          PK: `notif#${NOTIF_KEY}`,
          SK: `evt#${String(ts).padStart(13, "0")}#${n.dedupe || randomUUID().slice(0, 8)}`,
          ts, read: false, ttl: Math.floor(ts / 1000) + 90 * 86400,
          source: NOTIF_SOURCE, kind: "routine",
          title: n.title, severity: n.severity || "info", description: n.description || "",
          account: n.account || "", region: n.region || "", resource: n.resource || "",
          console_url: n.console_url || "", report_url: n.report_url || "",
          conv_id: n.conv_id || "", owner: n.owner || "", routine_id: n.routine_id || "",
        },
      }));
    },
  };
}

/**
 * 造一个引擎。`deps` 缺省 = 真实依赖；单测传假的（见 tests/routines_run.test.mjs）。
 * @returns {{ tick, runNow, verifyPublished }}
 */
export function makeEngine(depsOverride = null) {
  let _deps = depsOverride;
  const deps = async () => (_deps ||= await realDeps());

  const dv = (r, zh, en) => (r.locale === "en" ? en : zh);

  /** 一次运行能不能发起、发起成功拿到什么。失败不抛，返回 { ok:false, reason, detail }。 */
  async function startRun(routine, scheduledAt) {
    const d = await deps();
    const fail = (reason, detail = "") => ({ ok: false, reason, detail });
    if ((await d.ownerExists(routine.owner_username)) === false) return fail("owner_deleted");
    if ((await d.accountActive(routine.account_id || "")) === false) return fail("account_inactive");
    let skill;
    try { skill = await d.getSkill(routine.skill_id); }
    catch (e) { return fail("skill_read_failed", e?.name || "Error"); }
    if (!skill) return fail("skill_deleted");
    let client, target;
    try { ({ client, target } = await d.clientFor(routine.account_id || "")); }
    catch (e) { return fail("target_unavailable", clientDetail(e)); }
    const upload = d.uploadRecordFor(skill, target);
    if (!upload?.asset_id) return fail("skill_not_published");
    if ((await d.assetExists(client, target.agentSpaceId, upload.asset_id)) === false) return fail("skill_not_published");
    const description = buildRoutineDescription({ routine, skill, upload, scheduledAt });
    if (description.length + ROUTINE_PREFIX.length > DESCRIPTION_LIMIT) return fail("description_too_long");
    try {
      const s = await d.startInvestigation({
        client, agentSpaceId: target.agentSpaceId,
        title: `⏰ ${routine.name}`.slice(0, 120), description, prefix: ROUTINE_PREFIX,
        clientToken: sha(`${routine.id}#${scheduledAt}`).slice(0, 64),
      });
      return { ok: true, taskId: s.taskId, executionId: s.executionId, agentSpaceId: target.agentSpaceId,
               accountId: routine.account_id || "", consoleUrl: s.consoleUrl || "",
               skillVersion: upload.uploaded_version || "", skillName: skill.name || routine.skill_id };
    } catch (e) {
      console.warn(`[routines] start failed ${routine.id}: ${e?.name || "Error"}`);
      return fail("start_failed", e?.name || "Error");
    }
  }

  /** 记一次没跑成（跳过 / 发起失败）的运行，并按规则更新任务（失败计数、是否暂停）。 */
  async function recordNotRun(routine, scheduledAt, { status, reason, detail = "", trigger, now }) {
    const d = await deps();
    const fields = { scheduled_at: scheduledAt, trigger, status, reason, detail, finished_at: now };
    // 排队过的那次已经有记录（status=queued/starting）：写不进新记录就把那条更新掉，别丢失败原因。
    if (!(await d.store.putRun(routine.id, fields))) await d.store.updateRun(routine.id, d.store.runSk(scheduledAt), fields);
    const failed = status === "failed";
    let paused = false;
    const updated = await d.store.updateRoutine(routine.id, (r) => {
      r.last_run = { sk: d.store.runSk(scheduledAt), scheduled_at: scheduledAt, status, reason, finished_at: now };
      if (failed) {
        r.consecutive_failures = (r.consecutive_failures || 0) + 1;
        if (PAUSE_NOW.has(reason) || r.consecutive_failures >= LIMITS.maxFailures) {
          r.enabled = false;
          r.paused_reason = PAUSE_NOW.has(reason) ? reason : "consecutive_failures";
          paused = true;
        }
      }
      r.updated_at = now;
      return r;
    });
    if (paused && updated) await notifyPaused(updated, now);
    return updated;
  }

  async function notifyPaused(r, now) {
    const d = await deps();
    const why = {
      consecutive_failures: dv(r, `连续 ${LIMITS.maxFailures} 次没有成功`, `${LIMITS.maxFailures} runs in a row did not succeed`),
      skill_deleted: dv(r, "用到的 Skill 已被删除", "its skill was deleted"),
      skill_not_published: dv(r, "用到的 Skill 不在 DevOps Agent 里了（被撤下或没发布）", "its skill is no longer published to DevOps Agent"),
      account_inactive: dv(r, "目标账号已停用或已移除接入", "the target account was disabled or removed"),
      owner_deleted: dv(r, "任务负责人的账号已被删除", "the task owner's user was deleted"),
    }[r.paused_reason] || r.paused_reason;
    await d.putNotification({
      ts: now, dedupe: `routine-paused-${r.id}-${now}`, severity: "warn",
      title: dv(r, `定时任务已暂停：${r.name}`, `Scheduled task paused: ${r.name}`),
      description: dv(r, `原因：${why}。处理之后在「更多 → 定时任务」里重新启用。`,
                         `Reason: ${why}. After fixing it, turn the task back on under More → Scheduled tasks.`),
      account: r.account_id || "", owner: r.owner_username || "", routine_id: r.id,
    }).catch((e) => console.warn(`[routines] notify paused failed: ${e?.name || "Error"}`));
  }

  /** 发起一次运行（准点 / 补跑 / 排队后 / 立即运行），成功则把它挂到任务的 active_run 上。 */
  async function launch(routine, scheduledAt, trigger, now) {
    const d = await deps();
    const res = await startRun(routine, scheduledAt);
    if (!res.ok) {
      await recordNotRun(routine, scheduledAt, { status: "failed", reason: res.reason, detail: res.detail, trigger, now });
      return { started: false, reason: res.reason };
    }
    const sk = d.store.runSk(scheduledAt);
    const wrote = await d.store.putRun(routine.id, {
      scheduled_at: scheduledAt, trigger, status: "running", started_at: now,
      task_id: res.taskId, execution_id: res.executionId, agent_space_id: res.agentSpaceId,
      account_id: res.accountId, skill_version: res.skillVersion, console_url: res.consoleUrl,
    });
    if (!wrote) {
      // 同一个计划时间已经有记录（极少见：并发）。把这条记录覆盖成真实状态，别丢掉已经发起的调查。
      await d.store.updateRun(routine.id, sk, { status: "running", started_at: now, task_id: res.taskId, execution_id: res.executionId });
    }
    await d.store.updateRoutine(routine.id, (r) => {
      r.active_run = { sk, scheduled_at: scheduledAt, trigger, status: "running", started_at: now,
                       task_id: res.taskId, execution_id: res.executionId, agent_space_id: res.agentSpaceId,
                       account_id: res.accountId, console_url: res.consoleUrl, skill_version: res.skillVersion };
      r.run_count = (r.run_count || 0) + 1;
      r.skill_name = res.skillName;
      r.updated_at = now;
      return r;
    });
    return { started: true };
  }

  /** 回收一次进行中的运行：没到终态就等下一轮；到了终态（或超过 6 小时）就收尾。 */
  async function collect(routine, now) {
    const d = await deps();
    const a = routine.active_run;
    let status = "IN_PROGRESS";
    let client = null;
    try {
      ({ client } = await d.clientFor(a.account_id || ""));
      status = (await d.getTaskStatus({ client, agentSpaceId: a.agent_space_id, taskId: a.task_id })).status;
    } catch (e) {
      console.warn(`[routines] poll failed ${routine.id}: ${e?.name || "Error"}`);
    }
    const TERMINAL = ["COMPLETED", "FAILED", "TIMED_OUT", "CANCELED", "CANCELLED", "SKIPPED"];
    if (!TERMINAL.includes(status)) {
      if (now - (a.started_at || now) < LIMITS.staleMs) return { done: false };
      status = "NO_TERMINAL_STATE";
    }
    return finalize(routine, status, client, now);
  }

  /** 收尾：取结论、落报告、写会话 / 通知 / 运行记录、更新任务。任一步失败都尽量把记录写完整。 */
  async function finalize(routine, status, client, now) {
    const d = await deps();
    const a = routine.active_run;
    const en = routine.locale === "en";
    const tz = routine.schedule?.tz || "UTC";
    let collected = { markdown: "", chatMd: "", report: null, trace: null, records: [] };
    if (client && status !== "NO_TERMINAL_STATE") {
      try {
        collected = await d.collectInvestigation({
          client, space: a.agent_space_id, executionId: a.execution_id, taskId: a.task_id, status,
          title: routine.name, locale: en ? "en" : "zh", keyPrefix: `${REPORT_PREFIX}/${routine.id}`,
        });
      } catch (e) {
        console.warn(`[routines] collect failed ${routine.id}: ${e?.name || "Error"}`);
      }
    }
    const hasUtil = (collected.records || []).some((r) => r?.recordType === "utilization");
    const skillLoaded = hasUtil ? d.loadedSkillBundles(collected.records).includes(routine.skill_id) : null;
    const succeeded = status === "COMPLETED";
    const reason = succeeded ? "" : String(status).toLowerCase();
    const consoleUrl = a.console_url || d.operatorUrls(a.agent_space_id, a.task_id).deepLink;
    const ref = d.investigationRef(a.task_id, a.execution_id);
    const when = formatLocal(a.scheduled_at, tz);

    // —— 会话：一次运行一个会话，打开就能接着追问 ——
    let convId = "";
    try {
      convId = `conv-${now}-rt${randomUUID().slice(0, 6)}`;
      const title = `⏰ ${routine.name} · ${when.slice(0, 10)}`;
      await d.ensureConversation(routine.owner_sub, convId, title, "investigate");
      const userText = en
        ? `⏰ Scheduled task “${routine.name}” (scheduled for ${when} ${tz})\n\nSkill: ${routine.skill_name || routine.skill_id}\nTarget account: ${routine.account_id || "this account"}\n\n${routine.context || "(no extra context)"}`
        : `⏰ 定时任务「${routine.name}」（计划时间 ${when} ${tz}）\n\nSkill：${routine.skill_name || routine.skill_id}\n目标账号：${routine.account_id || "本账号"}\n\n${routine.context || "（没有补充上下文）"}`;
      await d.appendMessage(convId, { role: "user", text: userText, ts: a.started_at || now });
      let reply = "";
      if (status === "NO_TERMINAL_STATE") {
        reply += en ? "⚠️ The investigation reached no final state within 6 hours, so this run was closed. Check it in the DevOps Agent console.\n"
                    : "⚠️ 这次调查 6 小时内没有结束，已按未完成收尾。可以去 DevOps Agent 后台看它的进展。\n";
      } else if (!succeeded) {
        reply += en ? `⚠️ The investigation ended with status **${status}**.\n` : `⚠️ 调查以状态 **${status}** 结束。\n`;
      } else {
        reply += en ? "✅ **Investigation complete**\n" : "✅ **调查完成**\n";
      }
      if (skillLoaded === false) {
        reply += en
          ? `\n⚠️ This investigation did not confirm loading the skill “${routine.skill_name || routine.skill_id}”, so the conclusion may be DevOps Agent's general analysis.\n`
          : `\n⚠️ 这次调查没有确认加载 Skill「${routine.skill_name || routine.skill_id}」，结论可能是 DevOps Agent 的通用分析。\n`;
      }
      if (collected.chatMd) reply += `\n${collected.chatMd}\n`;
      else if (succeeded) reply += en ? "\nNo summary was available.\n" : "\n暂未取到摘要内容。\n";
      const sources = [];
      if (collected.report?.url) {
        reply += en ? `\n🌐 [View the online report](${collected.report.url}) (kept for 30 days)\n`
                    : `\n🌐 [在线查看报告](${collected.report.url})（保留 30 天）\n`;
        sources.push({ icon: "file", title: en ? "Online report" : "在线报告", detail: collected.report.url });
      }
      if (collected.trace?.url) {
        reply += en ? `\n🔍 [Investigation trace](${collected.trace.url})\n` : `\n🔍 [调查过程 Trace](${collected.trace.url})\n`;
        sources.push({ icon: "file", title: en ? "Investigation trace" : "调查过程", detail: collected.trace.url });
      }
      if (ref) reply += en ? `\n(Investigation id: \`${ref}\`)` : `\n（调查编号：\`${ref}\`）`;
      if (consoleUrl) reply += en ? `\n\n🔗 [DevOps Agent console](${consoleUrl})\n` : `\n\n🔗 [DevOps Agent 后台](${consoleUrl})\n`;
      await d.appendMessage(convId, {
        role: "assistant", text: reply, ts: now, path: "deep-direct",
        investigation: { task_id: a.task_id || undefined, execution_id: a.execution_id || undefined },
        sources: sources.length ? sources : undefined, via: "devops-agent",
        accountId: a.account_id || undefined,
      });
      await d.touchConversation(routine.owner_sub, convId, a.account_id || "", "devops");
    } catch (e) {
      console.warn(`[routines] conversation write failed ${routine.id}: ${e?.name || "Error"}`);
      convId = convId || "";
    }

    // —— 运行记录 + 任务 ——
    await d.store.updateRun(routine.id, a.sk, {
      status: succeeded ? "succeeded" : "failed", reason, da_status: status, finished_at: now,
      conv_id: convId, report_url: collected.report?.url || "", trace_url: collected.trace?.url || "",
      skill_loaded: skillLoaded,
    });
    let paused = false;
    const updated = await d.store.updateRoutine(routine.id, (r) => {
      r.active_run = null;
      r.last_run = { sk: a.sk, scheduled_at: a.scheduled_at, status: succeeded ? "succeeded" : "failed", reason,
                     finished_at: now, conv_id: convId, report_url: collected.report?.url || "", skill_loaded: skillLoaded };
      r.consecutive_failures = succeeded ? 0 : (r.consecutive_failures || 0) + 1;
      if (!succeeded && r.consecutive_failures >= LIMITS.maxFailures && r.enabled) {
        r.enabled = false; r.paused_reason = "consecutive_failures"; paused = true;
      }
      r.updated_at = now;
      return r;
    });

    // —— 通知（账号级收件箱）——
    const summaryLine = String(collected.chatMd || "").replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim().slice(0, 600);
    await d.putNotification({
      ts: now, dedupe: `routine-${routine.id}-${a.scheduled_at}`,
      severity: succeeded && skillLoaded !== false ? "info" : "warn",
      title: succeeded ? dv(routine, `定时任务完成：${routine.name}`, `Scheduled task finished: ${routine.name}`)
                       : dv(routine, `定时任务没有成功：${routine.name}`, `Scheduled task did not succeed: ${routine.name}`),
      description: summaryLine || (succeeded ? "" : `${status}`),
      account: a.account_id || "", console_url: consoleUrl, report_url: collected.report?.url || "",
      conv_id: convId, owner: routine.owner_username || "", routine_id: routine.id,
    }).catch((e) => console.warn(`[routines] notify failed ${routine.id}: ${e?.name || "Error"}`));
    if (paused && updated) await notifyPaused(updated, now);
    return { done: true, status, convId };
  }

  /** 一次 tick：先回收、再放行排队的、再派发到期的。返回本轮的统计（进日志）。 */
  async function tick() {
    const d = await deps();
    const now = d.now();
    const owner = randomUUID();
    if (!(await d.store.acquireLease(now, LIMITS.leaseMs, owner))) return { skipped: "lease_held" };
    const stats = { collected: 0, started: 0, queued: 0, skipped: 0, failed: 0 };
    try {
      const switchOn = await d.store.routinesEnabled();
      // ① 回收进行中的
      for (const r of await d.store.listRoutines()) {
        if (r.active_run?.status !== "running") continue;
        const res = await collect(r, now).catch((e) => { console.warn(`[routines] collect ${r.id}: ${e?.name}`); return {}; });
        if (res?.done) stats.collected++;
      }
      let routines = await d.store.listRoutines();
      let running = routines.filter((r) => r.active_run?.status === "running").length;

      // ② 排队的，先来先跑
      const queued = routines.filter((r) => r.active_run?.status === "queued")
        .sort((x, y) => (x.active_run.queued_at || 0) - (y.active_run.queued_at || 0));
      for (const r of queued) {
        const q = r.active_run;
        const drop = !switchOn ? "kill_switch" : (now - (q.queued_at || now) > LIMITS.queueWaitMs ? "concurrency_full" : "");
        if (drop) {
          await d.store.updateRun(r.id, q.sk, { status: "skipped", reason: drop, finished_at: now });
          await d.store.updateRoutine(r.id, (x) => {
            x.active_run = null;
            x.last_run = { sk: q.sk, scheduled_at: q.scheduled_at, status: "skipped", reason: drop, finished_at: now };
            return x;
          });
          stats.skipped++;
          continue;
        }
        if (running >= LIMITS.maxConcurrent) continue;
        await d.store.updateRoutine(r.id, (x) => { x.active_run = null; return x; });
        const fresh = await d.store.getRoutine(r.id);
        await d.store.updateRun(r.id, q.sk, { status: "starting" });
        const res = await launch(fresh, q.scheduled_at, q.trigger || "schedule", now);
        if (res.started) { running++; stats.started++; } else stats.failed++;
      }

      // ③ 到期的
      routines = await d.store.listRoutines();
      for (const r of routines) {
        if (!r.enabled || !r.next_run_at || r.next_run_at > now) continue;
        const due = latestDue(r.schedule, r.next_run_at, now) ?? r.next_run_at;
        const nextAt = nextRun(r.schedule, now);
        const trigger = now - due > ON_TIME_MS ? "catch_up" : "schedule";
        const setNext = (x) => { x.next_run_at = nextAt; x.updated_at = now; return x; };
        if (due !== r.next_run_at) {
          // 中间错过了好几次：只补最近一次，更早的记一条「已错过」（不逐条刷屏）
          await d.store.putRun(r.id, { scheduled_at: r.next_run_at, trigger: "schedule", status: "skipped",
                                       reason: "missed", finished_at: now });
        }
        if (now - due > LIMITS.catchUpMs) {
          await d.store.putRun(r.id, { scheduled_at: due, trigger, status: "skipped", reason: "missed", finished_at: now });
          await d.store.updateRoutine(r.id, setNext);
          stats.skipped++;
          continue;
        }
        if (r.active_run) {
          await d.store.putRun(r.id, { scheduled_at: due, trigger, status: "skipped", reason: "previous_running", finished_at: now });
          await d.store.updateRoutine(r.id, setNext);
          stats.skipped++;
          continue;
        }
        if (!switchOn) {
          await d.store.putRun(r.id, { scheduled_at: due, trigger, status: "skipped", reason: "kill_switch", finished_at: now });
          await d.store.updateRoutine(r.id, setNext);
          stats.skipped++;
          continue;
        }
        if (running >= LIMITS.maxConcurrent) {
          const sk = d.store.runSk(due);
          await d.store.putRun(r.id, { scheduled_at: due, trigger, status: "queued", queued_at: now });
          await d.store.updateRoutine(r.id, (x) => {
            x.active_run = { sk, scheduled_at: due, trigger, status: "queued", queued_at: now };
            return setNext(x);
          });
          stats.queued++;
          continue;
        }
        await d.store.updateRoutine(r.id, setNext);
        const res = await launch(await d.store.getRoutine(r.id), due, trigger, now);
        if (res.started) { running++; stats.started++; } else stats.failed++;
      }
    } finally {
      await d.store.releaseLease(owner);
    }
    return stats;
  }

  /** 「立即运行」：不改下一次的计划时间。返回 { status, body }（给 API 层直接回）。 */
  async function runNow(routineId) {
    const d = await deps();
    const now = d.now();
    const r = await d.store.getRoutine(routineId);
    if (!r) return { status: 404, body: { error: "not_found" } };
    if (r.active_run) return { status: 409, body: { error: "previous_running" } };
    if (!(await d.store.routinesEnabled())) return { status: 409, body: { error: "kill_switch" } };
    const recent = (await d.store.listRuns(routineId, 20))
      .filter((x) => x.trigger === "manual" && now - (x.scheduled_at || 0) < 3600 * 1000);
    if (recent.length >= LIMITS.runNowPerHour) return { status: 429, body: { error: "run_now_rate_limited", limit: LIMITS.runNowPerHour } };
    const running = (await d.store.listRoutines()).filter((x) => x.active_run?.status === "running").length;
    if (running >= LIMITS.maxConcurrent) {
      const sk = d.store.runSk(now);
      await d.store.putRun(r.id, { scheduled_at: now, trigger: "manual", status: "queued", queued_at: now });
      await d.store.updateRoutine(r.id, (x) => {
        x.active_run = { sk, scheduled_at: now, trigger: "manual", status: "queued", queued_at: now };
        return x;
      });
      return { status: 202, body: { ok: true, queued: true } };
    }
    const res = await launch(r, now, "manual", now);
    if (!res.started) return { status: 409, body: { error: res.reason } };
    return { status: 200, body: { ok: true, started: true } };
  }

  /** 创建 / 修改任务时用：这个 Skill 在目标 Agent Space 里是不是真的已发布。 */
  async function verifyPublished(skillId, accountId) {
    const d = await deps();
    const skill = await d.getSkill(skillId);
    if (!skill) return { ok: false, reason: "skill_not_found" };
    if ((await d.accountActive(accountId || "")) === false) return { ok: false, reason: "account_inactive" };
    let client, target;
    try { ({ client, target } = await d.clientFor(accountId || "")); }
    catch (e) {
      const detail = clientDetail(e);
      return { ok: false, reason: "target_unavailable", detail };
    }
    const upload = d.uploadRecordFor(skill, target);
    if (!upload?.asset_id) return { ok: false, reason: "skill_not_published" };
    const exists = await d.assetExists(client, target.agentSpaceId, upload.asset_id);
    if (exists === false) return { ok: false, reason: "skill_not_published" };
    return { ok: true, skill, upload };
  }

  return { tick, runNow, verifyPublished, _startRun: startRun, _finalize: finalize };
}

let _engine = null;
/** 生产用的单例。 */
export const engine = () => (_engine ||= makeEngine());
