/**
 * Cases 仪表盘 —— Cases 主题独立页(对齐 FinOps 结构:landing 缩略卡 → 右侧面板)。
 * 数据源:GET /cases/dashboard(见 bff/web-chat/support.mjs casesDashboard)。
 * 4 组:overview(severity/service)/ waiting(等客户回复)/ incidents(高危未结)/ sla(响应健康启发式)。
 */
import { useEffect, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, ComposedChart, Bar, XAxis, YAxis, CartesianGrid } from "recharts";
import { useLocale } from "../i18n";
import { getCasesDashboard, getCasesTrends, type CasesDashboardData, type CasesTrendsData, type CaseRow } from "../api/cases";
import { getCasesOrgSummary, type CasesOrgSummary } from "../api/cases";

interface Props {
  dashboardId?: string;
  onOpenDashboard?: (id: string) => void;
  onAsk?: (q: string) => void;   // 两栏浏览器里的"就此提问"回调(可选,当前 cases 详情未用到)
  data?: CasesDashboardData;
  /** 能力门禁：判断某 permissionKey 是否可见（未传=全允许）。 */
  can?: (key: string) => boolean;
}

const SEV: Record<string, string> = {
  critical: "#d13212", urgent: "#e8590c", high: "#f59e0b",
  normal: "var(--blue)", low: "#64748b", unknown: "var(--muted)",
};
const sevColor = (s?: string) => SEV[(s || "unknown").toLowerCase()] || "var(--muted)";

const Card = ({ children, accent, style }: { children: React.ReactNode; accent?: "red" | "green" | "info"; style?: React.CSSProperties }) => (
  <div style={{
    background: "var(--card)", border: "1px solid var(--line)",
    borderLeft: accent ? `3px solid ${accent === "red" ? "#d13212" : accent === "green" ? "var(--green)" : "var(--blue)"}` : "1px solid var(--line)",
    borderRadius: 12, padding: "14px 16px", ...style,
  }}>{children}</div>
);
const Label = ({ children }: { children: React.ReactNode }) => (
  <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 600, marginBottom: 6 }}>{children}</div>
);
const SevChip = ({ s }: { s?: string }) => (
  <span style={{ fontSize: 10.5, fontWeight: 700, color: "#fff", background: sevColor(s), borderRadius: 100, padding: "2px 8px", textTransform: "uppercase", flexShrink: 0 }}>{s || "—"}</span>
);
const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", margin: "14px 0 8px" }}>{children}</div>
);

function CaseLine({ c, zh, right }: { c: CaseRow; zh: boolean; right: React.ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "8px 0", borderTop: "1px dashed var(--line)" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <SevChip s={c.severity} />
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.subject || (zh ? "(无标题)" : "(no subject)")}</span>
        </div>
        <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>{c.displayId}{c.status ? ` · ${c.status}` : ""}</div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>{right}</div>
    </div>
  );
}

export default function CasesDashboard({ dashboardId, onOpenDashboard, data: dataProp, can = () => true }: Props) {
  // 组织概览（Top-N 问题账号）：landing 顶部，预聚合 v1（BFF 15min 缓存 + 可见性过滤）
  const [orgSum, setOrgSum] = useState<CasesOrgSummary | null>(null);
  useEffect(() => { getCasesOrgSummary().then(setOrgSum).catch(() => {}); }, []);
  const { locale } = useLocale();
  const zh = locale !== "en";
  const [fetched, setFetched] = useState<CasesDashboardData | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const data = dataProp ?? fetched;
  const loading = dataProp ? false : loadingState;

  useEffect(() => {
    if (dataProp) return;
    let cancelled = false;
    getCasesDashboard().then((d) => { if (!cancelled) { setFetched(d); setLoadingState(false); } });
    return () => { cancelled = true; };
  }, [dataProp]);

  // 趋势数据：独立端点(6 个月 + AI)，进入 trends 分区时懒加载
  const [trends, setTrends] = useState<CasesTrendsData | null>(null);
  const [trendsLoading, setTrendsLoading] = useState(false);
  useEffect(() => {
    if (dashboardId !== "trends" || trends) return;
    let cancelled = false;
    setTrendsLoading(true);
    getCasesTrends().then((d) => { if (!cancelled) { setTrends(d); setTrendsLoading(false); } });
    return () => { cancelled = true; };
  }, [dashboardId, trends]);

  if (loading) {
    return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><span className="pulsewave" style={{ display: "inline-flex", gap: 2 }}><i /><i /><i /></span></div>;
  }
  if (!data) return null;
  if (!data.ok) {
    const msg = data.code === "support_plan_required"
      ? (zh ? "AWS Support API 需要 Business / Enterprise 支持计划。" : "AWS Support API requires a Business/Enterprise plan.")
      : (data.message || (zh ? "暂无数据" : "No data"));
    return <div style={{ maxWidth: 1200, margin: "0 auto", padding: "12px 24px", color: "var(--muted)", fontSize: 13 }}>{msg}</div>;
  }

  const sev = data.bySeverity || {};
  const donut = Object.entries(sev).map(([name, value]) => ({ name, value }));
  const waiting = data.waiting || { count: 0, cases: [] };
  const incidents = data.incidents || { count: 0, cases: [] };
  const sla = data.sla || { onTrack: 0, atRisk: 0, breached: 0, worst: [] };
  const show = (id: string) => dashboardId === id;
  // 能力门禁：cases 卡片与 nav:cases:<id> 1:1 映射
  // 组织概览卡（landing 与 overview 下钻两处复用）
  const orgOverviewCard = orgSum && orgSum.perAccount.some((a) => a.accountId) && ( // 有任一成员账号行即显示
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", marginTop: 6 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>
              {zh ? "组织概览" : "Org overview"} · {orgSum.accountsCovered} {zh ? "个账号" : "accounts"} · {orgSum.totalOpen} {zh ? "个进行中案例" : "open cases"}
            </span>
            <span style={{ fontSize: 10.5, color: "var(--muted)" }}>
              {orgSum.accountsFailed.length > 0 && (
                <span style={{ color: "#e8590c", marginRight: 8 }} title={orgSum.accountsFailed.join(", ")}>
                  ⚠ {orgSum.accountsFailed.length} {zh ? "个账号不可用（无 Support 计划/未接入）" : "accounts unavailable (no support plan / not onboarded)"}
                </span>
              )}
              {zh ? "15 分钟缓存" : "15-min cache"}
            </span>
          </div>
          {orgSum.topAccounts.filter((a) => a.open > 0 || a.high > 0).slice(0, 5).map((a) => (
            <div key={a.accountId || "self"} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderTop: "1px dashed var(--line)", fontSize: 12 }}>
              <span style={{ color: "var(--text)" }}>{(() => { const nm = a.name || ""; return nm && a.accountId ? `${nm} · ${a.accountId}` : (nm || a.accountId || (zh ? "部署账号" : "Deployment account")); })()}</span>
              <span style={{ color: "var(--muted)" }}>
                {a.high > 0 && <span style={{ color: "#d13212", fontWeight: 700, marginRight: 8 }}>{a.high} {zh ? "高危" : "high"}</span>}
                {a.open} {zh ? "进行中" : "open"}
              </span>
            </div>
          ))}
          {orgSum.topAccounts.every((a) => !a.open && !a.high) && (
            <div style={{ color: "var(--green)", fontSize: 12, fontWeight: 600 }}>{zh ? "全组织无进行中案例 ✓" : "No open cases org-wide ✓"}</div>
          )}
        </div>
      );

  const cardVisible = (id: string) => can(`nav:cases:${id}`);

  return (
    <div style={{ maxWidth: dashboardId ? 1200 : 900, margin: "0 auto", padding: dashboardId ? "4px 14px 20px" : "8px 24px 40px", width: "100%" }}>
      {!dashboardId && (<>
      {orgOverviewCard}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 6 }}>
        {[
          { id: "overview", label: zh ? "未结案例" : "Open Cases", metric: String(data.openCount ?? 0), sub: zh ? `共 ${data.totalCount ?? 0} 个` : `${data.totalCount ?? 0} total`, accent: undefined as ("red" | undefined) },
          { id: "waiting", label: zh ? "等你回复" : "Waiting on You", metric: String(waiting.count), sub: zh ? "待客户回复" : "pending your reply", accent: waiting.count > 0 ? "red" as const : undefined },
          { id: "incidents", label: zh ? "高危/Incident" : "Incidents", metric: String(incidents.count), sub: zh ? "高危未结" : "high-sev open", accent: incidents.count > 0 ? "red" as const : undefined },
          { id: "sla", label: zh ? "响应健康" : "Response Health", metric: sla.breached > 0 ? String(sla.breached) : "✓", sub: sla.breached > 0 ? (zh ? "超目标" : "breached") : (zh ? "健康" : "healthy"), accent: sla.breached > 0 ? "red" as const : undefined },
          { id: "trends", label: zh ? "趋势分析" : "Trends", metric: zh ? "6 个月" : "6-mo", sub: zh ? "服务/严重度/AI 建议 →" : "service/severity/AI →", accent: undefined as ("red" | undefined) },
        ].filter((d) => cardVisible(d.id)).map((d) => (
          <div key={d.id} onClick={() => onOpenDashboard?.(d.id)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpenDashboard?.(d.id); }}
            style={{ background: "var(--card)", border: `1px solid ${d.accent === "red" ? "#d13212" : "var(--line)"}`, borderRadius: 12, padding: "12px 14px", cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--orange)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = d.accent === "red" ? "#d13212" : "var(--line)")}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{d.label}</span>
              <span style={{ color: "var(--muted)", fontSize: 16 }}>›</span>
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: d.accent === "red" ? "#d13212" : "var(--text)", marginTop: 6 }}>{d.metric}</div>
            <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>{d.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ color: "var(--muted)", fontSize: 11.5, margin: "10px 2px 0" }}>{zh ? "点开卡片查看详情 →" : "Open a card for details →"}</div>
      </>)}

      {show("overview") && cardVisible("overview") && (<>
      <SectionTitle>{zh ? "未结案例概览" : "Open Cases Overview"}</SectionTitle>
      {orgOverviewCard}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <Card>
          <Label>{zh ? "按严重级别" : "By Severity"}</Label>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ fontSize: 40, fontWeight: 800, color: "var(--text)" }}>{data.openCount ?? 0}</div>
            <div style={{ color: "var(--muted)", fontSize: 12 }}>{zh ? `未结 / 共 ${data.totalCount ?? 0}` : `open / ${data.totalCount ?? 0} total`}</div>
          </div>
          {donut.length > 0 ? (
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie data={donut} dataKey="value" nameKey="name" innerRadius={42} outerRadius={70} stroke="none">
                  {donut.map((d) => <Cell key={d.name} fill={sevColor(d.name)} />)}
                </Pie>
                <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--text)" }} />
              </PieChart>
            </ResponsiveContainer>
          ) : <div style={{ color: "var(--green)", fontSize: 13, fontWeight: 600, marginTop: 10 }}>{zh ? "无未结案例 🎉" : "No open cases 🎉"}</div>}
        </Card>
        <Card>
          <Label>{zh ? "按服务 Top5" : "By Service · Top5"}</Label>
          {(data.byService || []).length > 0 ? (data.byService || []).map((s) => (
            <div key={s.service} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginTop: 6, gap: 8 }}>
              <span style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.service}</span>
              <span style={{ fontWeight: 700, flexShrink: 0 }}>{s.count}</span>
            </div>
          )) : <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>{zh ? "暂无" : "None"}</div>}
        </Card>
      </div>
      </>)}

      {show("waiting") && cardVisible("waiting") && (<>
      <SectionTitle>{zh ? "等你回复(AWS 在等客户)" : "Waiting on You (AWS awaiting customer)"}</SectionTitle>
      <Card accent="red">
        <Label>{zh ? `待客户回复 · ${waiting.count} 个` : `Pending customer action · ${waiting.count}`}</Label>
        {waiting.cases.length > 0 ? waiting.cases.map((c) => (
          <CaseLine key={c.displayId} c={c} zh={zh} right={
            <div style={{ fontSize: 13, fontWeight: 700, color: (c.waitingDays || 0) >= 3 ? "#d13212" : "var(--text)" }}>
              {zh ? "已等 " : "waiting "}{c.waitingDays ?? c.ageDays ?? 0}{zh ? " 天" : "d"}
            </div>
          } />
        )) : <div style={{ color: "var(--green)", fontSize: 13, fontWeight: 600, marginTop: 6 }}>{zh ? "没有等待你回复的案例 ✓" : "Nothing waiting on you ✓"}</div>}
        <div style={{ color: "var(--muted)", fontSize: 10.5, marginTop: 10 }}>{zh ? "这些案例在等你/客户回复,回复前不会推进 —— 优先处理避免拖长解决时间。" : "These stall until the customer replies — clear them to avoid long resolution times."}</div>
      </Card>
      </>)}

      {show("incidents") && cardVisible("incidents") && (<>
      <SectionTitle>{zh ? "高危 / 进行中 Incident" : "High-severity / Active Incidents"}</SectionTitle>
      <Card accent={incidents.count > 0 ? "red" : undefined}>
        <Label>{zh ? `高危未结 · ${incidents.count} 个` : `High-sev open · ${incidents.count}`}</Label>
        {incidents.cases.length > 0 ? incidents.cases.map((c) => (
          <CaseLine key={c.displayId} c={c} zh={zh} right={
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{c.ageDays ?? 0}{zh ? " 天" : "d"}</div>
          } />
        )) : <div style={{ color: "var(--green)", fontSize: 13, fontWeight: 600, marginTop: 6 }}>{zh ? "无高危未结案例 ✓" : "No high-sev open cases ✓"}</div>}
      </Card>
      </>)}

      {show("sla") && cardVisible("sla") && (<>
      <SectionTitle>{zh ? "响应健康(估算)" : "Response Health (estimated)"}</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        {[
          { k: zh ? "达标" : "On-track", v: sla.onTrack, c: "var(--green)" },
          { k: zh ? "临界" : "At-risk", v: sla.atRisk, c: "#f59e0b" },
          { k: zh ? "超目标" : "Breached", v: sla.breached, c: "#d13212" },
        ].map((x) => (
          <Card key={x.k} style={{ textAlign: "center" }}>
            <div style={{ fontSize: 30, fontWeight: 800, color: x.c }}>{x.v}</div>
            <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 2 }}>{x.k}</div>
          </Card>
        ))}
      </div>
      <Card style={{ marginTop: 12 }}>
        <Label>{zh ? "最需关注(距目标最远)" : "Worst (furthest past target)"}</Label>
        {sla.worst.length > 0 ? sla.worst.map((c) => (
          <CaseLine key={c.displayId} c={c} zh={zh} right={
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: c.state === "breached" ? "#d13212" : c.state === "at-risk" ? "#f59e0b" : "var(--green)" }}>{c.state}</div>
              <div style={{ color: "var(--muted)", fontSize: 11 }}>{c.hoursSinceActivity}h / {zh ? "目标" : "target"} {c.targetHours}h</div>
            </div>
          } />
        )) : <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>{zh ? "暂无未结案例" : "No open cases"}</div>}
        <div style={{ color: "var(--muted)", fontSize: 10.5, marginTop: 10, fontStyle: "italic" }}>
          {zh ? "* 基于「距最后往来时长 vs 按严重级别的 ES 响应目标」估算,非官方 SLA。" : "* Estimated from time-since-last-activity vs per-severity ES response targets — not an official SLA."}
        </div>
      </Card>
      </>)}

      {show("trends") && cardVisible("trends") && (<>
      <SectionTitle>{zh ? "6 个月趋势分析" : "6-Month Trend Analysis"}</SectionTitle>
      {trendsLoading ? (
        <div style={{ display: "flex", justifyContent: "center", padding: 30 }}><span className="pulsewave" style={{ display: "inline-flex", gap: 2 }}><i /><i /><i /></span></div>
      ) : !trends || !trends.ok ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{trends?.message || (zh ? "暂无数据" : "No data")}</div>
      ) : (<>
        {/* 概览数字 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 10, marginBottom: 12 }}>
          {[
            { k: zh ? "总案例" : "Total", v: String(trends.total ?? 0) },
            { k: zh ? "已解决" : "Resolved", v: String(trends.resolved ?? 0) },
            { k: zh ? "未结" : "Open", v: String(trends.open ?? 0) },
            { k: zh ? "待客户占比" : "Pending-cust", v: `${trends.pendingCustomerPct ?? 0}%` },
          ].map((x) => (
            <Card key={x.k} style={{ textAlign: "center" }}>
              <div style={{ fontSize: 26, fontWeight: 800, color: "var(--text)" }}>{x.v}</div>
              <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 2 }}>{x.k}</div>
            </Card>
          ))}
        </div>
        {/* 按月趋势 */}
        <Card style={{ marginBottom: 12 }}>
          <Label>{zh ? "按月案例量" : "Cases per Month"}</Label>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={trends.byMonth || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
              <XAxis dataKey="month" stroke="var(--muted)" tick={{ fill: "var(--muted)", fontSize: 11 }} />
              <YAxis stroke="var(--muted)" tick={{ fill: "var(--muted)", fontSize: 11 }} allowDecimals={false} />
              <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--text)" }} />
              <Bar dataKey="count" fill="var(--blue)" radius={[3, 3, 0, 0]} barSize={26} />
            </ComposedChart>
          </ResponsiveContainer>
        </Card>
        {/* 按服务 + 按严重度 */}
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12, marginBottom: 12 }}>
          <Card>
            <Label>{zh ? "Top 服务（6 个月）" : "Top Services (6-mo)"}</Label>
            {(trends.byService || []).length > 0 ? (trends.byService || []).map((s) => {
              const max = Math.max(...(trends.byService || []).map((x) => x.count), 1);
              return (
                <div key={s.service} style={{ marginTop: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                    <span style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.service}</span>
                    <span style={{ fontWeight: 700 }}>{s.count}</span>
                  </div>
                  <div style={{ height: 6, background: "var(--line)", borderRadius: 4, marginTop: 3 }}>
                    <div style={{ width: `${(s.count / max) * 100}%`, height: "100%", background: "var(--orange)", borderRadius: 4 }} />
                  </div>
                </div>
              );
            }) : <div style={{ color: "var(--muted)", fontSize: 12 }}>{zh ? "暂无" : "None"}</div>}
          </Card>
          <Card>
            <Label>{zh ? "按严重度" : "By Severity"}</Label>
            {(trends.bySeverity || []).length > 0 ? (trends.bySeverity || []).map((s) => (
              <div key={s.severity} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: "1px dashed var(--line)", fontSize: 12.5 }}>
                <span style={{ color: sevColor(s.severity), fontWeight: 600 }}>{s.severity}</span>
                <span style={{ fontWeight: 700 }}>{s.count}</span>
              </div>
            )) : <div style={{ color: "var(--muted)", fontSize: 12 }}>{zh ? "暂无" : "None"}</div>}
          </Card>
        </div>
        {/* AI 建议 */}
        {trends.insight && (
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderLeft: "3px solid var(--blue)", borderRadius: 10, padding: "10px 12px", marginBottom: 8, fontSize: 12.5, lineHeight: 1.6 }}>
            <div style={{ color: "var(--muted)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{zh ? "AI 洞察（请核对）" : "AI insight (verify)"}</div>
            {trends.insight}
          </div>
        )}
        {trends.recommendations && trends.recommendations.length > 0 && (
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderLeft: "3px solid var(--green)", borderRadius: 10, padding: "10px 12px", fontSize: 12.5, lineHeight: 1.6 }}>
            <div style={{ color: "var(--muted)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{zh ? "给 Service Manager 的建议（请核对）" : "For the Service Manager (verify)"}</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {trends.recommendations.map((r, i) => <li key={i} style={{ marginTop: 3 }}>{r}</li>)}
            </ul>
          </div>
        )}
      </>)}
      </>)}
    </div>
  );
}
