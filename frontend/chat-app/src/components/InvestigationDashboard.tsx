/**
 * Investigation 告警仪表盘 —— 独立 tab（对齐 FinOps/Cases/Security）。只读。
 * 数据源：GET /investigate/alarms（bff/web-chat/alarms.mjs）。
 * 3 组（subtab 级门禁）：alarm-overview / alarm-active / alarm-history。
 * 每条 ALARM 可「调查」(复用 DevOps Agent 调查流) 或「通知」(生成摘要草稿)。不创建/修改告警。
 */
import { useEffect, useState } from "react";
import { useLocale } from "../i18n";
import { getAlarmDashboard, type AlarmDashboardData } from "../api/alarms";
import { getBackupDashboard, getAlarmOrgSummary, type BackupData, type AlarmOrgRow } from "../api/alarms";
import { getHealthDashboard, type HealthDashboard } from "../api/notifications";
import { getEosDashboard, type EosDashboardData } from "../api/eos";
import InboxList from "./InboxList";

interface Props {
  dashboardId?: string;
  onOpenDashboard?: (id: string) => void;
  /** 多账号：Backup 卡按该账号视角（空 = 部署账号） */
  accountId?: string;
  accounts?: { accountId: string; accountName?: string }[];
  onAccountChange?: (id: string) => void;
  data?: AlarmDashboardData;
  can?: (key: string) => boolean;
  /** 「调查」：以告警上下文发起 DevOps Agent 调查（复用 startFromNotification(query,"investigate")）。
   *  opts.deep=true 表示 query 是后端给 DevOps Agent 备好的调查描述（事件收件箱卡片的
   *  dispatchQuery），新会话应直接开「深度调查（直连）」；本面板自己那几个「调查」按钮的
   *  文案是写给大模型看的（要它列受影响资源、给下一步建议），故不带 deep。 */
  onInvestigate?: (query: string, opts?: { deep?: boolean }) => void;
  /** 「通知」：以告警上下文生成摘要草稿（复用聊天）。 */
  onNotify?: (query: string) => void;
}

const Card = ({ children, accent, style }: { children: React.ReactNode; accent?: "red" | "green" | "info"; style?: React.CSSProperties }) => {
  const c = accent === "red" ? "#d13212" : accent === "green" ? "var(--green)" : accent === "info" ? "var(--blue)" : undefined;
  return <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 11, padding: "12px 14px", borderLeft: c ? `3px solid ${c}` : undefined, ...style }}>{children}</div>;
};
const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", margin: "14px 0 8px" }}>
    <span style={{ width: 3, height: 14, background: "var(--orange)", borderRadius: 2, display: "inline-block" }} />{children}
  </div>
);

export default function InvestigationDashboard({ dashboardId, onOpenDashboard, data: dataProp, can = () => true, onInvestigate, onNotify, accountId = "", accounts = [], onAccountChange }: Props) {
  const { locale } = useLocale();
  const zh = locale !== "en";
  const [fetched, setFetched] = useState<AlarmDashboardData | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const data = dataProp ?? fetched;
  const loading = dataProp ? false : loadingState;

  useEffect(() => {
    if (dataProp) return;
    let cancelled = false;
    getAlarmDashboard().then((d) => { if (!cancelled) { setFetched(d); setLoadingState(false); } });
    return () => { cancelled = true; };
  }, [dataProp]);

  // ④ Backup 任务健康（账号感知）—— hooks 必须在任何条件 return 之前
  // （事故根因：曾放在 early-return 之后 → 切账号时 hooks 数量变化 → React #310 crash）
  const [bu, setBu] = useState<BackupData | null>(null);
  // 多账号：告警 org 汇总（Top-N 问题账号）；仅 org 视角拉取
  const [orgRows, setOrgRows] = useState<AlarmOrgRow[] | null>(null);
  useEffect(() => {
    if (accountId) { setOrgRows(null); return; }
    let cancelled = false;
    getAlarmOrgSummary().then((r) => { if (!cancelled) setOrgRows(r?.rows ?? []); });
    return () => { cancelled = true; };
  }, [accountId]);
  useEffect(() => {
    let cancelled = false;
    setBu(null);
    getBackupDashboard(accountId).then((d) => { if (!cancelled) setBu(d); });
    return () => { cancelled = true; };
  }, [accountId]);

  // AWS Health（服务/账户/计划变更）—— 从「通知」主题分流来的精简版卡片，账号感知。
  const [hd, setHd] = useState<HealthDashboard | null>(null);
  const [healthTab, setHealthTab] = useState<"service" | "account" | "scheduled">("service");
  useEffect(() => {
    let cancelled = false;
    setHd(null);
    getHealthDashboard(accountId).then((d) => { if (!cancelled) setHd(d); });
    return () => { cancelled = true; };
  }, [accountId]);

  // EOL/停服风险 —— 从「通知」主题分流来（懒加载：仅打开 eos 卡时拉，跨账号扫描较慢）。
  const [eos, setEos] = useState<EosDashboardData | null>(null);
  const [eosLoading, setEosLoading] = useState(false);
  const [eosTimedOut, setEosTimedOut] = useState(false);
  const [eosRefresh, setEosRefresh] = useState(0); // >0 = 重试按钮触发强刷（绕服务端缓存）
  useEffect(() => { setEos(null); setEosTimedOut(false); setEosRefresh(0); }, [accountId]);
  useEffect(() => {
    if (dashboardId !== "eos" || eos !== null || eosLoading) return;
    setEosLoading(true);
    setEosTimedOut(false);
    let done = false;
    // 超时兜底：首扫仍是多 region 重扫描（后端已加 60min 结果缓存，二次打开秒返，但首扫/强刷
    // 仍可能超前端/网关超时）。加 45s 超时，超时后停 loading 并提示可重试，绝不永久卡。
    const timer = setTimeout(() => { if (!done) { setEosLoading(false); setEosTimedOut(true); } }, 45000);
    getEosDashboard(accountId, eosRefresh > 0)
      .then((d) => { if (!done) { done = true; clearTimeout(timer); setEos(d); setEosLoading(false); } })
      .catch(() => { if (!done) { done = true; clearTimeout(timer); setEosLoading(false); } });
    return () => { done = true; clearTimeout(timer); };
  }, [dashboardId, eos, eosLoading, accountId, eosRefresh]);

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><span className="pulsewave" style={{ display: "inline-flex", gap: 2 }}><i /><i /><i /></span></div>;
  if (!data) return null;

  const ov = data.overview || { ALARM: 0, OK: 0, INSUFFICIENT_DATA: 0 };
  const active = data.active || [];
  const recent = data.recent || [];
  const show = (id: string) => dashboardId === id;
  const cardVisible = (id: string) => can(`nav:investigate:${id}`);

  const invQuery = (a: { name: string; metric: string; namespace: string; reason: string }) =>
    (zh ? `请调查 CloudWatch 告警「${a.name}」（指标 ${a.namespace}/${a.metric}）。原因：${a.reason}` :
          `Investigate CloudWatch alarm "${a.name}" (metric ${a.namespace}/${a.metric}). Reason: ${a.reason}`);
  const notifyQuery = (a: { name: string }) =>
    (zh ? `为 CloudWatch 告警「${a.name}」起草一段面向团队的通知摘要（状态、影响、下一步）。` :
          `Draft a team notification summary for CloudWatch alarm "${a.name}" (status, impact, next steps).`);

  // 「检查受影响资源」：让 agent 拿这条 Health 事件的服务/区域，去查客户环境里哪些资源受影响，
  // 给受影响清单 + 下一步建议。prompt 明确要求 agent 先取事件详情(含 affectedEntities)、
  // 再按 service+region 列客户资源、交叉判断，最后给清单和建议。
  const affectedResourcesQuery = (e: { service: string; eventTypeCode: string; region: string; category: string; arn?: string }) =>
    (zh
      ? `AWS Health 事件「${e.eventTypeCode}」（服务 ${e.service}，区域 ${e.region || "global"}，类别 ${e.category}）。`
        + `请检查我当前 AWS 环境里哪些资源可能受此事件影响：\n`
        + `1) 若能获取该 Health 事件的受影响实体(affected entities)，优先列出；\n`
        + `2) 再按受影响的服务(${e.service})和区域(${e.region || "所有区域"})列出我账号里的相关资源；\n`
        + `3) 交叉判断出「可能受影响的资源清单」（资源 ID/名称、类型、区域）；\n`
        + `4) 给出针对性的下一步建议（如切换可用区、检查健康、启用备用、联系 Support 等）。\n`
        + `全程只读，不修改任何资源。`
      : `AWS Health event "${e.eventTypeCode}" (service ${e.service}, region ${e.region || "global"}, category ${e.category}). `
        + `Check which resources in my current AWS environment may be affected:\n`
        + `1) If the event's affected entities are available, list them first;\n`
        + `2) Then list my account's resources for the affected service (${e.service}) in ${e.region || "all regions"};\n`
        + `3) Cross-reference to produce a "likely affected resources" list (resource ID/name, type, region);\n`
        + `4) Give targeted next-step recommendations (e.g. failover AZ, health checks, standby, contact Support).\n`
        + `Read-only throughout; do not modify any resource.`);

  const unavailable = data.available === false;

  return (
    <div style={{ maxWidth: dashboardId ? 1200 : 900, margin: "0 auto", padding: dashboardId ? "4px 14px 20px" : "8px 24px 40px", width: "100%" }}>
      {!dashboardId && (<>
      {!accountId && orgRows && orgRows.some((r) => r.accountId) && (
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", marginTop: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>
            {zh ? "组织概览 · 按账号告警分布（点击下钻）" : "Org overview · alarms by account (click to drill down)"}
          </div>
          {orgRows.map((r) => (
            <div key={r.accountId || "self"} onClick={() => r.accountId && onAccountChange?.(r.accountId)} role={r.accountId ? "button" : undefined}
              style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderTop: "1px dashed var(--line)", fontSize: 12, cursor: r.accountId && onAccountChange ? "pointer" : undefined }}>
              <span style={{ color: "var(--text)" }}>{(() => { const nm = accounts.find((a) => a.accountId === r.accountId)?.accountName || r.name || ""; return nm && r.accountId ? `${nm} · ${r.accountId}` : (nm || r.accountId || (zh ? "部署账号" : "Deployment account")); })()}</span>
              <span style={{ color: "var(--muted)" }}>
                {!r.available ? (zh ? "不可用" : "unavailable") : (<>
                  {r.ALARM > 0 && <span style={{ color: "#d13212", fontWeight: 700, marginRight: 8 }}>{r.ALARM} ALARM</span>}
                  {r.total} {zh ? "个告警" : "alarms"}
                </>)}
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 6 }}>
        {[
          { id: "alarm-overview", label: zh ? "告警总览" : "Alarm Overview", metric: unavailable ? "—" : String(data.total ?? 0), sub: zh ? "告警总数" : "total alarms", accent: undefined },
          { id: "alarm-active", label: zh ? "当前告警" : "Active Alarms", metric: unavailable ? "—" : String(ov.ALARM), sub: zh ? "处于 ALARM" : "in ALARM", accent: ov.ALARM > 0 ? "red" as const : undefined },
          { id: "alarm-history", label: zh ? "最近变更" : "Recent Changes", metric: unavailable ? "—" : String(recent.length), sub: zh ? "状态变更" : "state changes", accent: undefined },
          { id: "backup", label: "Backup", metric: bu?.available ? String(bu.failedCount ?? 0) : "—", sub: bu?.available ? (zh ? "7 天失败任务" : "failed jobs 7d") : (zh ? "不可用" : "n/a"), accent: (bu?.failedCount || 0) > 0 ? "red" as const : undefined },
          { id: "health", label: zh ? "AWS Health" : "AWS Health", metric: hd?.available ? String((hd.serviceIssues?.items.length ?? 0) + (hd.accountIssues?.items.length ?? 0)) : "—", sub: zh ? "服务/账户/计划变更" : "service/account/scheduled", accent: ((hd?.serviceIssues?.items.length ?? 0) > 0 ? "red" as const : undefined) },
          { id: "eos", label: zh ? "EOL 风险" : "EOL Risk", metric: eos?.atRisk != null ? String(eos.atRisk) : "—", sub: zh ? "临近停服" : "approaching EOL", accent: (eos?.atRisk || 0) > 0 ? "red" as const : undefined },
          { id: "inbox", label: zh ? "事件收件箱" : "Event Inbox", metric: zh ? "查看" : "View", sub: zh ? "CloudWatch/Backup 等" : "CloudWatch/Backup…", accent: undefined },
        ].filter((d) => cardVisible(d.id)).map((d) => (
          <div key={d.id} onClick={() => onOpenDashboard?.(d.id)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpenDashboard?.(d.id); }}
            style={{ background: "var(--card)", border: "1px solid var(--line)", borderLeft: d.accent === "red" ? "3px solid #d13212" : undefined, borderRadius: 12, padding: "12px 14px", cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--orange)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line)")}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{d.label}</span><span style={{ color: "var(--muted)", fontSize: 16 }}>›</span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "var(--text)", marginTop: 6 }}>{d.metric}</div>
            <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>{d.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ color: "var(--muted)", fontSize: 11.5, margin: "10px 2px 0" }}>{zh ? "点开卡片查看详情 →" : "Open a card for details →"}</div>
      </>)}

      {unavailable && dashboardId && <div style={{ color: "var(--muted)", fontSize: 13 }}>{zh ? "CloudWatch 告警不可用（无权限或本区域无告警）。" : "CloudWatch alarms unavailable (no permission or none in region)."}</div>}

      {show("alarm-overview") && cardVisible("alarm-overview") && !unavailable && (<>
      <SectionTitle>{zh ? "告警总览" : "Alarm Overview"}</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {[{ k: "ALARM", v: ov.ALARM, c: "#d13212" }, { k: "OK", v: ov.OK, c: "var(--green)" }, { k: zh ? "数据不足" : "INSUFFICIENT", v: ov.INSUFFICIENT_DATA, c: "#f59e0b" }].map((x) => (
          <Card key={x.k} style={{ textAlign: "center" }}><div style={{ fontSize: 30, fontWeight: 800, color: x.c }}>{x.v}</div><div style={{ color: "var(--muted)", fontSize: 12 }}>{x.k}</div></Card>
        ))}
      </div>
      </>)}

      {show("alarm-active") && cardVisible("alarm-active") && !unavailable && (<>
      <SectionTitle>{zh ? "当前告警（ALARM）" : "Active Alarms (ALARM)"}</SectionTitle>
      {active.length > 0 ? active.map((a) => (
        <Card key={a.name} accent="red" style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>{a.name}</div>
          <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 2 }}>{a.namespace}{a.metric ? ` · ${a.metric}` : ""}{a.updated ? ` · ${new Date(a.updated).toLocaleString(zh ? "zh-CN" : "en-US")}` : ""}</div>
          {a.reason && <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>{a.reason}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="navitem" style={{ width: "auto", padding: "4px 12px", borderRadius: 6 }} onClick={() => onInvestigate?.(invQuery(a))}>{zh ? "调查" : "Investigate"}</button>
            <button className="navitem" style={{ width: "auto", padding: "4px 12px", borderRadius: 6 }} onClick={() => onNotify?.(notifyQuery(a))}>{zh ? "通知" : "Notify"}</button>
          </div>
        </Card>
      )) : <div style={{ color: "var(--green)", fontSize: 13, fontWeight: 600 }}>{zh ? "当前无告警 ✓" : "No active alarms ✓"}</div>}
      </>)}

      {show("alarm-history") && cardVisible("alarm-history") && !unavailable && (<>
      <SectionTitle>{zh ? "最近状态变更" : "Recent State Changes"}</SectionTitle>
      <Card>
        {recent.length > 0 ? recent.map((h, i) => (
          <div key={i} style={{ padding: "6px 0", borderBottom: "1px dashed var(--line)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 12.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.name}</span>
              <span style={{ flexShrink: 0, color: "var(--muted)", fontSize: 11 }}>{h.date ? new Date(h.date).toLocaleString(zh ? "zh-CN" : "en-US") : ""}</span>
            </div>
            {h.summary && <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 1 }}>{h.summary}</div>}
          </div>
        )) : <div style={{ color: "var(--muted)", fontSize: 12 }}>{zh ? "近期无状态变更" : "No recent changes"}</div>}
      </Card>
      </>)}

      {show("backup") && (<>
      <SectionTitle>{zh ? "Backup 任务健康（近 7 天）" : "Backup Job Health (7d)"}</SectionTitle>
      {!bu?.available ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{zh ? "Backup 数据不可用（未用 AWS Backup 或无权限）。" : "Backup data unavailable."}</div>
      ) : (
      <Card>
        <div style={{ display: "flex", gap: 16, marginBottom: 10, fontSize: 12.5, color: "var(--muted)" }}>
          <span>{zh ? "任务总数" : "Total jobs"}: <b style={{ color: "var(--text)" }}>{bu.totalJobs}</b></span>
          <span>{zh ? "失败" : "Failed"}: <b style={{ color: (bu.failedCount || 0) > 0 ? "#d13212" : "var(--green)" }}>{bu.failedCount}</b></span>
          <span>Vaults: <b style={{ color: "var(--text)" }}>{bu.vaults}</b></span>
        </div>
        {(bu.failed || []).map((j, i) => (
          <div key={i} style={{ padding: "6px 0", borderTop: "1px dashed var(--line)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontSize: 12.5, color: "var(--text)" }}>{j.resourceType} · {j.resource}</span>
              <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: "#d13212" }}>{j.state}</span>
                {onInvestigate && <button style={{ fontSize: 11, fontWeight: 700, padding: "2px 10px", borderRadius: 100, border: "1px solid var(--orange)", background: "rgba(255,153,0,.10)", color: "var(--text)", cursor: "pointer" }}
                  onClick={() => onInvestigate(`Backup job ${j.state} for ${j.resourceType} ${j.resource}: ${j.message}. Investigate root cause and remediation.`)}>{zh ? "调查" : "Investigate"}</button>}
              </span>
            </div>
            {j.message && <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 1 }}>{j.message}</div>}
          </div>
        ))}
        {(bu.failed || []).length === 0 && <div style={{ color: "var(--green)", fontSize: 13, fontWeight: 600 }}>{zh ? "无失败任务 ✓" : "No failed jobs ✓"}</div>}
      </Card>
      )}
      </>)}

      {/* AWS Health（1 卡 3 tab：服务/账户/计划变更）—— 从通知主题分流的精简版 */}
      {show("health") && (<>
      <SectionTitle>{zh ? "AWS Health" : "AWS Health"}</SectionTitle>
      {!hd?.available ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          {zh ? "AWS Health 不可用（需 Business/Enterprise Support）。" : "AWS Health unavailable (requires Business/Enterprise Support)."}
          {hd?.links?.home && <a href={hd.links.home} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>{zh ? "打开控制台" : "Open console"} ↗</a>}
        </div>
      ) : (
      <Card>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {([["service", zh ? "服务健康" : "Service", hd.serviceIssues?.items.length ?? 0],
             ["account", zh ? "账户健康" : "Account", hd.accountIssues?.items.length ?? 0],
             ["scheduled", zh ? "计划变更" : "Scheduled", hd.scheduledChanges?.items.length ?? 0]] as const).map(([k, lbl, n]) => (
            <button key={k} onClick={() => setHealthTab(k)}
              style={{ fontSize: 12, fontWeight: 700, padding: "4px 12px", borderRadius: 100, cursor: "pointer",
                border: "1px solid " + (healthTab === k ? "var(--orange)" : "var(--line)"),
                background: healthTab === k ? "rgba(255,153,0,.10)" : "transparent", color: "var(--text)" }}>
              {lbl}{n > 0 ? ` (${n})` : ""}
            </button>
          ))}
        </div>
        {(() => {
          const bucket = healthTab === "service" ? hd.serviceIssues : healthTab === "account" ? hd.accountIssues : hd.scheduledChanges;
          const items = bucket?.items ?? [];
          if (items.length === 0) return <div style={{ color: "var(--muted)", fontSize: 12.5 }}>{zh ? "暂无事件" : "No events"}</div>;
          return items.map((e, i) => (
            <div key={i} style={{ padding: "6px 0", borderTop: i ? "1px dashed var(--line)" : undefined }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 600 }}>{e.service} · {e.eventTypeCode}</span>
                <span style={{ fontSize: 11, color: "var(--muted)" }}>{e.region || "global"}</span>
              </div>
              {e.description && <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 1 }}>{e.description.slice(0, 200)}</div>}
              {onInvestigate && (
                <button style={{ fontSize: 11, fontWeight: 700, padding: "2px 10px", borderRadius: 100, border: "1px solid var(--orange)", background: "rgba(255,153,0,.10)", color: "var(--text)", cursor: "pointer", marginTop: 4 }}
                  onClick={() => onInvestigate(affectedResourcesQuery(e))}>{zh ? "调查" : "Investigate"}</button>
              )}
            </div>
          ));
        })()}
        {hd.links?.home && <div style={{ marginTop: 8 }}><a href={hd.links.home} target="_blank" rel="noreferrer" style={{ fontSize: 11.5, color: "var(--muted)" }}>{zh ? "在 Health 控制台查看全部 ↗" : "View all in Health console ↗"}</a></div>}
      </Card>
      )}
      </>)}

      {/* EOL/停服风险 —— 从通知主题分流（懒加载） */}
      {show("eos") && (<>
      <SectionTitle>{zh ? "EOL / 停服风险" : "EOL / End-of-Support Risk"}</SectionTitle>
      {eosLoading ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{zh ? "扫描中…（多区域扫描较慢，最长约 45 秒）" : "Scanning… (multi-region scan, up to ~45s)"}</div>
      ) : eosTimedOut ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>
          {zh ? "扫描超时（多区域资源较多）。" : "Scan timed out (many resources across regions)."}
          <button onClick={() => { setEos(null); setEosTimedOut(false); }}
            style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, padding: "2px 10px", borderRadius: 100, border: "1px solid var(--orange)", background: "rgba(255,153,0,.10)", color: "var(--text)", cursor: "pointer" }}>
            {zh ? "重试" : "Retry"}</button>
        </div>
      ) : eos === null ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{zh ? "扫描中…" : "Scanning…"}</div>
      ) : !(eos.available ?? eos.ok) ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{zh ? "EOL 数据不可用。" : "EOL data unavailable."}</div>
      ) : (
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 10, fontSize: 12.5, color: "var(--muted)" }}>
          <span>{zh ? "临近停服" : "At risk"}: <b style={{ color: (eos.atRisk || 0) > 0 ? "#d13212" : "var(--green)" }}>{eos.atRisk ?? 0}</b></span>
          <span>{zh ? "总计" : "Total"}: <b style={{ color: "var(--text)" }}>{eos.total ?? 0}</b></span>
          {eos.supportedPct != null && <span>{zh ? "受支持" : "Supported"}: <b style={{ color: "var(--text)" }}>{eos.supportedPct}%</b></span>}
          {/* 缓存态 + 刷新：命中 60min 服务端缓存时提示，点击强刷重扫 */}
          <button
            title={zh ? "重新扫描（绕缓存）" : "Rescan (bypass cache)"}
            onClick={() => { setEos(null); setEosTimedOut(false); setEosRefresh((n) => n + 1); }}
            style={{ marginLeft: "auto", fontSize: 11.5, padding: "2px 9px", borderRadius: 100, border: "1px solid var(--line)", background: "transparent", color: "var(--muted)", cursor: "pointer" }}>
            {eos.cached ? (zh ? "缓存 · 刷新" : "Cached · Refresh") : (zh ? "刷新" : "Refresh")}
          </button>
        </div>
        {(eos.upcoming || []).slice(0, 20).map((r, i) => (
          <div key={i} style={{ padding: "6px 0", borderTop: "1px dashed var(--line)", display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span style={{ fontSize: 12.5, color: "var(--text)" }}>{r.service} {r.version || r.engine || ""} · {r.name}</span>
            <span style={{ fontSize: 11.5, color: "#d13212" }}>{r.eolDate || ""}{r.daysLeft != null ? (zh ? ` (${r.daysLeft} 天)` : ` (${r.daysLeft}d)`) : ""}</span>
          </div>
        ))}
        {(eos.upcoming || []).length === 0 && <div style={{ color: "var(--green)", fontSize: 13 }}>{zh ? "无临近停服的资源 ✓" : "No resources approaching EOL ✓"}</div>}
      </Card>
      )}
      </>)}

      {/* 事件收件箱（CloudWatch/Backup/EC2 Spot/Config 等 push）—— 复用 InboxList，与通知主题同源 */}
      {show("inbox") && (<>
      <SectionTitle>{zh ? "事件收件箱" : "Event Inbox"}</SectionTitle>
      <InboxList
        sources={["CloudWatch", "Backup", "EC2 Spot", "Auto Scaling", "Config"]}
        onInvestigate={(q, _title, opts) => onInvestigate?.(q, opts)}
        onAsk={(q) => onNotify?.(q)}
        emptyHint={zh ? "暂无运维事件（CloudWatch/Backup 等 push 会出现在这里）。" : "No ops events yet (CloudWatch/Backup pushes appear here)."}
      />
      </>)}
    </div>
  );
}
