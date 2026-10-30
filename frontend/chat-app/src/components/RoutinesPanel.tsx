/**
 * 「更多 → 定时任务」页（参考 Claude Code 的 scheduled tasks，原名 Routines）：
 *   列表（频率 / 下次运行 / 上次结果 / 启停 / 立即运行）、新建与编辑、每个任务的运行记录。
 *
 * 后端：bff/web-chat/routines_api.mjs；执行：routines_run.mjs（每 5 分钟一次 tick）。
 * 只能选**已发布到 DevOps Agent** 的 Skill —— 运行时用的是 Agent Space 里安装的那一份，不贴正文。
 * 每次运行的结果写成负责人名下的一个会话（「打开会话」只对负责人有效：会话是按人存的）。
 */
import { useEffect, useMemo, useState } from "react";
import { useT, useLocale } from "../i18n";
import {
  listRoutines, createRoutine, updateRoutine, deleteRoutine, toggleRoutine, runRoutineNow, listRoutineRuns,
  type Routine, type RoutineRun, type RoutinesList, type RoutineSchedule, type ScheduleKind, type PublishableSkill,
} from "../api/routines";
import { getDeepInvestigationAvailability } from "../api/chat";
import {
  SCHEDULE_KINDS, COMMON_TIMEZONES, browserTimezone, describeSchedule, formatInTz,
} from "../routineSchedule";
import { IconClock, IconPlus, IconClose, IconRename, IconTrash, IconExternal } from "./icons";

type T = (k: string) => string;

/** 后端短码 → 一句人话（带上限数字）。 */
export function routineErrorText(t: T, code: string, limits?: RoutinesList["limits"]): string {
  // 键直接写在 t(`…${}`) 里：i18n 检查按这个形状认动态键的前缀（scripts/lint_i18n.py）。
  const msg = t(`rt.err.${code}`);
  if (msg === `rt.err.${code}`) return t("rt.err.generic").replace("{code}", code);
  const n = code === "too_many_routines" ? limits?.max_enabled : code === "run_now_rate_limited" ? limits?.run_now_per_hour : undefined;
  return msg.replace("{n}", String(n ?? ""));
}

function reasonText(t: T, reason?: string): string {
  if (!reason) return "";
  const v = t(`rt.reason.${reason}`);
  return v === `rt.reason.${reason}` ? reason : v;
}

function statusText(t: T, status: string): string {
  const v = t(`rt.status.${status}`);
  return v === `rt.status.${status}` ? status : v;
}

const fmtDuration = (a?: number, b?: number) => {
  if (!a || !b || b < a) return "—";
  const m = Math.round((b - a) / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export default function RoutinesPanel({ prefill, onOpenConversation, currentUsername, canManage }: {
  /** 从 Skills 页「定时运行」进来：{skillId, n}（n 变了就再打开一次新建框）。 */
  prefill?: { skillId: string; n: number } | null;
  onOpenConversation: (id: string) => void;
  currentUsername: string;
  canManage: boolean;
}) {
  const t = useT();
  const { locale } = useLocale();
  const en = locale === "en";
  const [data, setData] = useState<RoutinesList | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [prefillSkill, setPrefillSkill] = useState("");
  const [openRuns, setOpenRuns] = useState("");
  const [busy, setBusy] = useState("");
  const [flash, setFlash] = useState<{ ok: boolean; text: string } | null>(null);
  const [daOk, setDaOk] = useState(true);

  useEffect(() => {
    let stop = false;
    listRoutines().then((r) => {
      if (stop) return;
      if (r.ok) { setData(r.data); setFailed(false); } else setFailed(true);
    });
    return () => { stop = true; };
  }, [reload]);
  useEffect(() => {
    getDeepInvestigationAvailability("").then((a) => setDaOk(a.available !== false)).catch(() => {});
  }, []);
  useEffect(() => {
    if (prefill?.skillId && canManage) { setPrefillSkill(prefill.skillId); setEditing("new"); }
  }, [prefill?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => setReload((n) => n + 1);
  const show = (ok: boolean, text: string) => { setFlash({ ok, text }); window.setTimeout(() => setFlash(null), 6000); };

  const act = async (id: string, fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, okText = "") => {
    setBusy(id);
    const r = await fn();
    setBusy("");
    if (!r.ok) show(false, routineErrorText(t, r.error || "generic", data?.limits));
    else if (okText) show(true, okText);
    refresh();
    return r;
  };

  const onRunNow = (r: Routine) => act(r.id, async () => {
    const res = await runRoutineNow(r.id);
    if (res.ok) show(true, res.data.queued ? t("rt.runQueued") : t("rt.runStarted"));
    return res;
  });
  const onToggle = (r: Routine) => act(r.id, () => toggleRoutine(r.id, !r.enabled));
  const onDelete = (r: Routine) => {
    const msg = (r.active_run ? t("rt.confirmDeleteRunning") : t("rt.confirmDelete")).replace("{name}", r.name);
    if (!window.confirm(msg)) return;
    act(r.id, () => deleteRoutine(r.id));
  };

  const routines = data?.routines || [];
  return (
    <div className="rt-panel">
      <div className="rt-head">
        <div className="rt-head-tx">
          <div className="rt-title"><IconClock size={18} /> {t("rt.title")}</div>
          <div className="rt-sub">{t("rt.subtitle")}</div>
        </div>
        {canManage && (
          <button className="cz-btn-primary" disabled={!daOk} onClick={() => { setPrefillSkill(""); setEditing("new"); }}>
            <IconPlus size={15} /> {t("rt.new")}
          </button>
        )}
      </div>

      {!daOk && <div className="rt-banner warn">{t("rt.daUnavailable")}</div>}
      {data && data.switch_on === false && <div className="rt-banner warn">{t("rt.switchOff")}</div>}
      {!canManage && data && <div className="rt-banner">{t("rt.readonly")}</div>}
      {flash && <div className={"rt-banner " + (flash.ok ? "ok" : "warn")} role="status">{flash.text}</div>}

      {failed ? (
        <div className="rt-empty">{t("rt.loadFailed")} <button className="cz-btn-ghost sm" onClick={refresh}>{t("rt.retry")}</button></div>
      ) : !data ? (
        <div className="rt-empty">…</div>
      ) : routines.length === 0 ? (
        <div className="rt-empty">{t("rt.empty")}</div>
      ) : (
        <div className="rt-list">
          {routines.map((r) => (
            <RoutineCard key={r.id} r={r} en={en} t={t} busy={busy === r.id} canManage={canManage}
              runsOpen={openRuns === r.id} onToggleRuns={() => setOpenRuns(openRuns === r.id ? "" : r.id)}
              onRunNow={() => onRunNow(r)} onToggle={() => onToggle(r)} onEdit={() => setEditing(r)} onDelete={() => onDelete(r)}
              onOpenConversation={onOpenConversation} currentUsername={currentUsername} />
          ))}
        </div>
      )}

      {editing && data && (
        <RoutineEditor
          initial={editing === "new" ? null : editing}
          prefillSkill={editing === "new" ? prefillSkill : ""}
          skills={data.skills}
          limits={data.limits}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function RoutineCard({ r, en, t, busy, canManage, runsOpen, onToggleRuns, onRunNow, onToggle, onEdit, onDelete, onOpenConversation, currentUsername }: {
  r: Routine; en: boolean; t: T; busy: boolean; canManage: boolean; runsOpen: boolean; onToggleRuns: () => void;
  onRunNow: () => void; onToggle: () => void; onEdit: () => void; onDelete: () => void;
  onOpenConversation: (id: string) => void; currentUsername: string;
}) {
  const tz = r.schedule?.tz || "UTC";
  const done = r.enabled && !r.next_run_at;
  const state = r.active_run ? (r.active_run.status === "queued" ? "queued" : "running") : done ? "done" : r.enabled ? "enabled" : "paused";
  const last = r.last_run;
  const mine = !!currentUsername && r.owner_username === currentUsername;
  return (
    <div className={"rt-card state-" + state}>
      <div className="rt-card-top">
        <div className="rt-card-name">{r.name}</div>
        <span className={"rt-chip " + state}>{t(`rt.state.${state}`)}</span>
      </div>
      <div className="rt-meta">
        <div><span className="rt-k">{t("rt.col.skill")}</span>{r.skill_name || r.skill_id}</div>
        <div><span className="rt-k">{t("rt.col.account")}</span>{r.account_id || t("rt.selfAccount")}</div>
        <div><span className="rt-k">{t("rt.col.schedule")}</span>{describeSchedule(r.schedule, en)} · {tz}</div>
        <div><span className="rt-k">{t("rt.col.next")}</span>{r.enabled ? formatInTz(r.next_run_at, tz, en) : "—"}</div>
        <div>
          <span className="rt-k">{t("rt.col.last")}</span>
          {r.active_run ? (r.active_run.status === "queued" ? t("rt.queuedSince")
            : t("rt.runningSince").replace("{t}", formatInTz(r.active_run.started_at, tz, en)))
            : last ? (
              <span className={"rt-st " + last.status}>
                {statusText(t, last.status)}{last.reason ? ` · ${reasonText(t, last.reason)}` : ""}
                {last.skill_loaded === false ? ` · ${t("rt.skillLoaded.no")}` : ""}
              </span>
            ) : "—"}
        </div>
        <div><span className="rt-k">{t("rt.col.owner")}</span>{r.owner_username || "—"}</div>
      </div>
      {!r.enabled && r.paused_reason && r.paused_reason !== "paused_by_user" && (
        <div className="rt-banner warn small">{reasonText(t, r.paused_reason)}</div>
      )}
      <div className="rt-actions">
        {canManage && (
          <>
            <button className="cz-btn-ghost sm" disabled={busy || !!r.active_run} onClick={onRunNow}>{t("rt.act.runNow")}</button>
            <button className="cz-btn-ghost sm" disabled={busy} onClick={onToggle}>{r.enabled ? t("rt.act.pause") : t("rt.act.resume")}</button>
            <button className="cz-icon-btn" title={t("rt.act.edit")} disabled={busy} onClick={onEdit}><IconRename size={15} /></button>
            <button className="cz-icon-btn" title={t("rt.act.delete")} disabled={busy} onClick={onDelete}><IconTrash size={15} /></button>
          </>
        )}
        {last?.conv_id && mine && (
          <button className="cz-btn-ghost sm" onClick={() => onOpenConversation(last.conv_id!)}>{t("rt.act.openChat")}</button>
        )}
        <button className="cz-btn-ghost sm rt-runs-btn" onClick={onToggleRuns}>{runsOpen ? t("rt.act.hideHistory") : t("rt.act.history")}</button>
      </div>
      {runsOpen && <RunsList routine={r} en={en} t={t} mine={mine} onOpenConversation={onOpenConversation} />}
    </div>
  );
}

function RunsList({ routine, en, t, mine, onOpenConversation }: {
  routine: Routine; en: boolean; t: T; mine: boolean; onOpenConversation: (id: string) => void;
}) {
  const [runs, setRuns] = useState<RoutineRun[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    listRoutineRuns(routine.id).then((r) => { if (r.ok) setRuns(r.data.runs); else setFailed(true); });
  }, [routine.id, routine.last_run?.finished_at]);
  const tz = routine.schedule?.tz || "UTC";
  const thirtyDays = 30 * 86400000;
  if (failed) return <div className="rt-runs-empty">{t("rt.loadFailed")}</div>;
  if (!runs) return <div className="rt-runs-empty">…</div>;
  if (!runs.length) return <div className="rt-runs-empty">{t("rt.history.empty")}</div>;
  return (
    <table className="rt-runs">
      <thead>
        <tr>
          <th>{t("rt.history.scheduled")}</th><th>{t("rt.history.status")}</th>
          <th>{t("rt.history.duration")}</th><th>{t("rt.history.skill")}</th><th />
        </tr>
      </thead>
      <tbody>
        {runs.map((x) => {
          const expired = !!x.finished_at && Date.now() - x.finished_at > thirtyDays;
          return (
            <tr key={x.sk}>
              <td>
                {formatInTz(x.scheduled_at, tz, en)}
                {x.trigger === "manual" && <span className="rt-muted"> {t("rt.history.manual")}</span>}
                {x.trigger === "catch_up" && <span className="rt-muted"> {t("rt.history.catchUp")}</span>}
              </td>
              <td className={"rt-st " + x.status}>
                {statusText(t, x.status)}{x.reason ? <span className="rt-muted"> · {reasonText(t, x.reason)}</span> : null}
              </td>
              <td>{fmtDuration(x.started_at, x.finished_at)}</td>
              <td>{x.skill_loaded === true ? t("rt.skillLoaded.yes") : x.skill_loaded === false ? <span className="rt-warn">{t("rt.skillLoaded.no")}</span> : "—"}</td>
              <td className="rt-links">
                {x.conv_id && (mine
                  ? <button className="rt-link" onClick={() => onOpenConversation(x.conv_id!)}>{t("rt.act.openChat")}</button>
                  : <span className="rt-muted" title={t("rt.history.notOwner").replace("{owner}", routine.owner_username || "")}>{t("rt.act.openChat")}</span>)}
                {x.report_url && (expired
                  ? <span className="rt-muted">{t("rt.history.expired")}</span>
                  : <a className="rt-link" href={x.report_url} target="_blank" rel="noreferrer">{t("rt.act.report")} <IconExternal size={11} /></a>)}
                {x.console_url && <a className="rt-link" href={x.console_url} target="_blank" rel="noreferrer">{t("rt.act.console")} <IconExternal size={11} /></a>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** 新建 / 编辑框。 */
export function RoutineEditor({ initial, prefillSkill, skills, limits, onClose, onSaved }: {
  initial: Routine | null;
  prefillSkill?: string;
  skills: PublishableSkill[] | null;
  limits: RoutinesList["limits"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const en = locale === "en";
  const s0 = initial?.schedule;
  const [name, setName] = useState(initial?.name || "");
  const [skillId, setSkillId] = useState(initial?.skill_id || prefillSkill || "");
  const [accountId, setAccountId] = useState(initial?.account_id || "");
  const [context, setContext] = useState(initial?.context || "");
  const [kind, setKind] = useState<ScheduleKind>(s0?.kind || "daily");
  const [time, setTime] = useState(s0?.time || "09:00");
  const [minute, setMinute] = useState(String(s0?.minute ?? 0));
  const [days, setDays] = useState<number[]>(s0?.days || [1]);
  const [dom, setDom] = useState(String(s0?.dom ?? 1));
  const [date, setDate] = useState(s0?.date || "");
  const [cron, setCron] = useState(s0?.cron || "0 9 * * 1-5");
  const [tz, setTz] = useState(s0?.tz || browserTimezone());
  const [startDate, setStartDate] = useState(s0?.start_date || "");
  const [endDate, setEndDate] = useState(s0?.end_date || "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const skill = useMemo(() => (skills || []).find((s) => s.skill_id === skillId) || null, [skills, skillId]);
  const targets = skill?.targets || [];
  // 选了 Skill 之后，目标账号只能在它发布到的那几个里选；当前值不在里面就落到第一个。
  useEffect(() => {
    if (!skill) return;
    if (!targets.some((x) => x.account_id === accountId)) setAccountId(targets[0]?.account_id ?? "");
  }, [skillId]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = targets.find((x) => x.account_id === accountId);
  const stale = !!skill && !!target && !!skill.latest_version && !!target.uploaded_version && target.uploaded_version !== skill.latest_version;

  const schedule: RoutineSchedule = useMemo(() => {
    const s: RoutineSchedule = { kind, tz: tz.trim() };
    if (["once", "daily", "weekdays", "weekly", "monthly"].includes(kind)) s.time = time;
    if (kind === "hourly") s.minute = Number(minute);
    if (kind === "weekly") s.days = [...days].sort();
    if (kind === "monthly") s.dom = Number(dom);
    if (kind === "once") s.date = date;
    if (kind === "cron") s.cron = cron.trim();
    if (startDate) s.start_date = startDate;
    if (endDate) s.end_date = endDate;
    return s;
  }, [kind, tz, time, minute, days, dom, date, cron, startDate, endDate]);

  const save = async () => {
    setErr("");
    if (!skillId) { setErr(routineErrorText(t, "invalid_skill", limits)); return; }
    setSaving(true);
    const input = { name: name.trim(), skill_id: skillId, account_id: accountId, context: context.trim(), schedule, locale: en ? "en" as const : "zh" as const };
    const r = initial ? await updateRoutine(initial.id, input) : await createRoutine(input);
    setSaving(false);
    if (!r.ok) { setErr(routineErrorText(t, r.error, limits)); return; }
    onSaved();
  };

  const toggleDay = (d: number) => setDays((xs) => (xs.includes(d) ? xs.filter((x) => x !== d) : [...xs, d]));
  const WD = en ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] : ["一", "二", "三", "四", "五", "六", "日"];

  return (
    <div className="cz-overlay" onClick={() => { if (!saving) onClose(); }}>
      <div className="cz-dialog rt-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="cz-dialog-head">
          <div className="cz-dialog-title"><IconClock size={18} /> {initial ? t("rt.ed.titleEdit") : t("rt.ed.titleNew")}</div>
          <button className="cz-icon-btn" onClick={onClose} title={t("rt.ed.cancel")}><IconClose size={18} /></button>
        </div>
        <div className="rt-form">
          <label className="rt-field">
            <span>{t("rt.ed.name")}</span>
            <input value={name} maxLength={80} placeholder={t("rt.ed.namePh")} onChange={(e) => setName(e.target.value)} />
          </label>

          <label className="rt-field">
            <span>{t("rt.ed.skill")}</span>
            {skills && skills.length === 0 ? (
              <div className="rt-hint warn">{t("rt.ed.noPublished")}</div>
            ) : (
              <select value={skillId} onChange={(e) => setSkillId(e.target.value)} aria-label={t("rt.ed.skill")}>
                <option value="">{t("rt.ed.skillPick")}</option>
                {(skills || []).map((s) => <option key={s.skill_id} value={s.skill_id}>{s.name}</option>)}
              </select>
            )}
            <div className="rt-hint">{t("rt.ed.skillHint")}</div>
            {stale && <div className="rt-hint warn">{t("rt.ed.staleSkill").split("{have}").join(target!.uploaded_version).replace("{latest}", skill!.latest_version)}</div>}
          </label>

          {skill && (
            <label className="rt-field">
              <span>{t("rt.ed.account")}</span>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label={t("rt.ed.account")}>
                {targets.map((x) => <option key={x.key} value={x.account_id}>{x.account_id || t("rt.selfAccount")}</option>)}
              </select>
              <div className="rt-hint">{t("rt.ed.accountHint")}</div>
            </label>
          )}

          <label className="rt-field">
            <span>{t("rt.ed.context")} <span className="rt-muted">{context.length}/{limits.context_max}</span></span>
            <textarea rows={3} value={context} maxLength={limits.context_max} placeholder={t("rt.ed.contextPh")} onChange={(e) => setContext(e.target.value)} />
          </label>

          <div className="rt-row">
            <label className="rt-field">
              <span>{t("rt.ed.kind")}</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as ScheduleKind)} aria-label={t("rt.ed.kind")}>
                {SCHEDULE_KINDS.map((k) => <option key={k} value={k}>{t(`rt.kind.${k}`)}</option>)}
              </select>
            </label>
            {["once", "daily", "weekdays", "weekly", "monthly"].includes(kind) && (
              <label className="rt-field">
                <span>{t("rt.ed.time")}</span>
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label={t("rt.ed.time")} />
              </label>
            )}
            {kind === "hourly" && (
              <label className="rt-field">
                <span>{t("rt.ed.minute")}</span>
                <input type="number" min={0} max={59} value={minute} onChange={(e) => setMinute(e.target.value)} aria-label={t("rt.ed.minute")} />
              </label>
            )}
            {kind === "monthly" && (
              <label className="rt-field">
                <span>{t("rt.ed.dom")}</span>
                <input type="number" min={1} max={31} value={dom} onChange={(e) => setDom(e.target.value)} aria-label={t("rt.ed.dom")} />
              </label>
            )}
            {kind === "once" && (
              <label className="rt-field">
                <span>{t("rt.ed.date")}</span>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("rt.ed.date")} />
              </label>
            )}
          </div>
          {kind === "weekly" && (
            <div className="rt-field">
              <span>{t("rt.ed.days")}</span>
              <div className="rt-days">
                {WD.map((label, i) => (
                  <button type="button" key={i} className={"rt-day" + (days.includes(i + 1) ? " on" : "")}
                    aria-pressed={days.includes(i + 1)} onClick={() => toggleDay(i + 1)}>{label}</button>
                ))}
              </div>
            </div>
          )}
          {kind === "monthly" && <div className="rt-hint">{t("rt.ed.domHint")}</div>}
          {kind === "cron" && (
            <label className="rt-field">
              <span>{t("rt.ed.cron")}</span>
              <input value={cron} onChange={(e) => setCron(e.target.value)} spellCheck={false} aria-label={t("rt.ed.cron")} />
              <div className="rt-hint">{t("rt.ed.cronHint")}</div>
            </label>
          )}

          <label className="rt-field">
            <span>{t("rt.ed.tz")}</span>
            <input list="rt-tz-list" value={tz} onChange={(e) => setTz(e.target.value)} spellCheck={false} aria-label={t("rt.ed.tz")} />
            <datalist id="rt-tz-list">{[...new Set([browserTimezone(), ...COMMON_TIMEZONES])].map((z) => <option key={z} value={z} />)}</datalist>
          </label>

          <details className="rt-adv" open={!!(startDate || endDate)}>
            <summary>{t("rt.ed.advanced")}</summary>
            <div className="rt-row">
              <label className="rt-field"><span>{t("rt.ed.start")}</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label={t("rt.ed.start")} /></label>
              <label className="rt-field"><span>{t("rt.ed.end")}</span><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-label={t("rt.ed.end")} /></label>
            </div>
          </details>

          <div className="rt-hint">{t("rt.ed.startsHint")}</div>
          {/* 这里原来有一行每月成本预估，用户 2026-10-30 要求去掉 —— 别再加回来。 */}
          {err &&<div className="cz-up-err" role="alert">{err}</div>}
        </div>
        <div className="cz-dialog-foot">
          <button className="cz-btn-ghost" disabled={saving} onClick={onClose}>{t("rt.ed.cancel")}</button>
          <button className="cz-btn-primary" disabled={saving || !name.trim() || !skillId} onClick={save}>
            {saving ? t("rt.ed.saving") : initial ? t("rt.ed.save") : t("rt.ed.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
