/**
 * Security 仪表盘 —— 独立 tab（对齐 FinOps/Cases 结构：landing 缩略卡 → 右侧面板）。
 * 数据源：GET /security/dashboard（bff/web-chat/security.mjs）。全部只读。
 * 3 组（subtab 级门禁）：ta-security（TA 安全检查）/ hub-score（Security Hub 发现）/ bulletins（安全公告）。
 */
import { useEffect, useState } from "react";
import { useLocale } from "../i18n";
import { getSecurityDashboard, getTaCheckResources, getGuarddutyDashboard, type SecurityDashboardData, type TaCheckResources, type GuarddutyData } from "../api/security";
import FailBanner from "./FailBanner";

interface Props {
  /**
   * 要渲染哪一个面板。**必填口径**：调用方只有 SecurityDashboardBrowser，它总是给值。
   *
   * 类型上仍是可选的（`?`）只为兼容旧签名；不给值等于四段 `show(...)` 全不成立，
   * 渲染出一个空 div —— 不会崩，但也什么都看不到。
   */
  dashboardId?: string;
  data?: SecurityDashboardData;
  can?: (key: string) => boolean;
  /** 多账号：当前查看的账号（空 = 部署账号）；用于徽标 + 下钻请求 */
  accountId?: string;
  accounts?: { accountId: string; accountName?: string }[];
  /** 调查按钮：以预填 prompt 开一个「故障调查」会话（DevOps Agent 默认开） */
  onInvestigate?: (prompt: string) => void;
  /** 「重试」时通知上层丢掉它手里的安全数据、重新拉一次（data prop 托管时必需）。 */
  onReload?: () => void;
}

const SEVC: Record<string, string> = { CRITICAL: "#d13212", HIGH: "#e8590c", MEDIUM: "#f59e0b", LOW: "#64748b", INFORMATIONAL: "var(--muted)" };
const STC: Record<string, string> = { error: "#d13212", warning: "#f59e0b", ok: "var(--green)", not_available: "var(--muted)" };

const Card = ({ children, accent, style }: { children: React.ReactNode; accent?: "red" | "green" | "info"; style?: React.CSSProperties }) => {
  const c = accent === "red" ? "#d13212" : accent === "green" ? "var(--green)" : accent === "info" ? "var(--blue)" : undefined;
  return <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 11, padding: "12px 14px", borderLeft: c ? `3px solid ${c}` : undefined, ...style }}>{children}</div>;
};
const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", margin: "14px 0 8px" }}>
    <span style={{ width: 3, height: 14, background: "var(--orange)", borderRadius: 2, display: "inline-block" }} />{children}
  </div>
);
const Label = ({ children }: { children: React.ReactNode }) => (
  <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 600, marginBottom: 6 }}>{children}</div>
);

export default function SecurityDashboard({ dashboardId, data: dataProp, can = () => true, accountId = "", accounts = [], onInvestigate, onReload }: Props) {
  const { locale } = useLocale();
  const zh = locale !== "en";
  const [fetched, setFetched] = useState<SecurityDashboardData | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  // 「重试」计数：+1 = 各卡重新拉一次（安全数据由上层托管时还要请上层重取，见 onReload）。
  const [reload, setReload] = useState(0);
  // TA 下钻：展开的 checkId + 各 check 的 flagged resources 缓存
  const [expanded, setExpanded] = useState<string | null>(null);
  const [taRes, setTaRes] = useState<Record<string, TaCheckResources | "loading" | "error">>({});
  // ④ GuardDuty（独立拉取，账号感知）——**只在真的看这一页时拉**。
  // 以前是无条件拉：每次挂载 + 每次切账号都打一次 GetFindings，而当时
  // `show("guardduty")` 压根选不中（目录里没这一项），所以 100% 的请求都白打。
  // 现在按 dashboardId 惰性拉（与 InvestigationDashboard 的 eos 面板同口径）。
  const [gd, setGd] = useState<GuarddutyData | null>(null);
  const wantGd = dashboardId === "guardduty";
  useEffect(() => {
    if (!wantGd) return;
    let cancelled = false;
    setGd(null);
    getGuarddutyDashboard(accountId).then((d) => { if (!cancelled) setGd(d); });
    return () => { cancelled = true; };
  }, [wantGd, accountId, reload]);
  const data = dataProp ?? fetched;
  const loading = dataProp ? false : loadingState;

  useEffect(() => {
    if (dataProp) return;
    let cancelled = false;
    setLoadingState(true);
    getSecurityDashboard(accountId).then((d) => { if (!cancelled) { setFetched(d); setLoadingState(false); } });
    return () => { cancelled = true; };
  }, [dataProp, accountId, reload]);

  if (loading) return <div style={{ display: "flex", justifyContent: "center", padding: 60 }}><span className="pulsewave" style={{ display: "inline-flex", gap: 2 }}><i /><i /><i /></span></div>;
  if (!data) return null;

  /** 「重试」：本地各卡重拉；数据若由上层托管（dataProp）则请上层重取。 */
  const retry = () => {
    setReload((n) => n + 1);
    if (dataProp) onReload?.();
  };

  /* 整个响应都没拿到（未登录 / http_NNN / 网络断）。
   *
   * 这时 trustedAdvisor / securityHub / bulletins 全是 undefined，而下面每张卡的兜底
   * 文案是「不可用」「Security Hub 未开通」「需 Business / Enterprise Support 计划」——
   * 全是**关于客户环境的具体断言**。一次 500 会让人以为自己没开 Security Hub、
   * 或者支持计划不够。所以这里整页只画「加载失败 + 重试」，不画任何一张卡。 */
  if (data.ok === false) {
    return (
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "14px 14px 20px", width: "100%" }}>
        <FailBanner zh={zh} what={zh ? "安全态势数据" : "security posture data"} code={data.code} onRetry={retry} />
      </div>
    );
  }

  const ta = data.trustedAdvisor;
  const hub = data.securityHub;
  const bul = data.bulletins;
  const show = (id: string) => dashboardId === id;
  const cardVisible = (id: string) => can(`nav:security:${id}`);

  // 账号上下文徽标：明确当前数据属于哪个账号（多账号防混淆）
  const acctLabel = accountId
    ? `${accounts.find((a) => a.accountId === accountId)?.accountName || accountId} · ${accountId}`
    : (zh ? "部署账号" : "Deployment account");
  const acctBadge = (
    <span title={zh ? "当前数据所属账号（在下方输入框的账号选择器切换）" : "Account this data belongs to (switch via the account selector)"}
      style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 100, padding: "2px 10px", marginLeft: 8, verticalAlign: "middle" }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: accountId ? "var(--orange)" : "var(--green)", display: "inline-block" }} />
      {acctLabel}
    </span>
  );

  const toggleExpand = (checkId?: string) => {
    if (!checkId) return;
    if (expanded === checkId) { setExpanded(null); return; }
    setExpanded(checkId);
    if (!taRes[checkId]) {
      setTaRes((prev) => ({ ...prev, [checkId]: "loading" }));
      getTaCheckResources(checkId, accountId).then((r) =>
        setTaRes((prev) => ({ ...prev, [checkId]: r || "error" })));
    }
  };
  const acctPhrase = accountId ? `account ${accountId}` : "the deployment account";
  const investigateTaCheckPrompt = (checkName: string, status: string, flaggedCount: number) =>
    `Security deep dive: Trusted Advisor security check "${checkName}" is in ${status.toUpperCase()} state with ${flaggedCount} flagged resource(s) in ${acctPhrase}. ` +
    `Please investigate: 1) enumerate the flagged resources and their exposure, 2) prioritize by risk, 3) concrete remediation steps for each, 4) prevention recommendations.`;
  const investigateTaPrompt = (checkName: string, resMeta: string[]) =>
    `Security deep dive: Trusted Advisor security check "${checkName}" flagged resource [${resMeta.filter(Boolean).join(" | ")}] in ${acctPhrase}. ` +
    `Please investigate: 1) what the exposure/risk is, 2) likely root cause and how long it has existed, 3) concrete remediation steps with least-privilege/config examples, 4) how to prevent recurrence.`;
  const investigateHubPrompt = (f: { title: string; severity: string; resource: string }) =>
    `Security deep dive: Security Hub ${f.severity} finding "${f.title}" on resource ${f.resource || "(unknown)"} in ${acctPhrase}. ` +
    `Please investigate: 1) exposure assessment, 2) root cause, 3) concrete remediation steps, 4) prevention recommendations.`;
  const invBtnStyle: React.CSSProperties = { flexShrink: 0, fontSize: 11, fontWeight: 700, padding: "2px 10px", borderRadius: 100, border: "1px solid var(--orange)", background: "rgba(255,153,0,.10)", color: "var(--text)", cursor: "pointer" };

  return (
    /* 单面板模式是**唯一**模式。以前这里还有一个 `!dashboardId` 的缩略卡落地页
       （四张卡 + 组织概览），2026-09-11 删掉：唯一的调用方 SecurityDashboardBrowser
       总是传 dashboardId，那一段从接进两栏浏览器起就再没被渲染过。
       组织概览（getSecurityOrgSummary）只在那一段里用 → 一起删；接口本身还在，
       将来要做「按账号安全态势」时从 api/security.ts 直接取。 */
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "4px 14px 20px", width: "100%" }}>

      {show("ta-security") && cardVisible("ta-security") && (<>
      <SectionTitle>{zh ? "Trusted Advisor 安全检查" : "Trusted Advisor — Security"}{acctBadge}</SectionTitle>
      {!ta?.available ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{ta?.reason === "support_plan_required" ? (zh ? "需 Business / Enterprise Support 计划。" : "Requires Business/Enterprise Support.") : (zh ? "不可用" : "Unavailable")}</div>
      ) : (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 12 }}>
          {[{ k: zh ? "错误" : "Error", v: ta.summary?.error || 0, c: "#d13212" }, { k: zh ? "警告" : "Warning", v: ta.summary?.warning || 0, c: "#f59e0b" }, { k: "OK", v: ta.summary?.ok || 0, c: "var(--green)" }].map((x) => (
            <Card key={x.k} style={{ textAlign: "center" }}><div style={{ fontSize: 28, fontWeight: 800, color: x.c }}>{x.v}</div><div style={{ color: "var(--muted)", fontSize: 12 }}>{x.k}</div></Card>
          ))}
        </div>
        <Card>
          {(ta.checks || []).length > 0 ? (ta.checks || []).map((c) => (
            <div key={c.id || c.name} style={{ borderBottom: "1px dashed var(--line)" }}>
              <div onClick={() => c.flaggedCount > 0 && toggleExpand(c.id)} role={c.flaggedCount > 0 ? "button" : undefined}
                style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", cursor: c.flaggedCount > 0 ? "pointer" : undefined }}>
                <span style={{ fontSize: 12.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginRight: 8 }}>
                  {c.flaggedCount > 0 && <span style={{ color: "var(--muted)", marginRight: 5 }}>{expanded === c.id ? "▾" : "▸"}</span>}{c.name}
                </span>
                <span style={{ flexShrink: 0, display: "inline-flex", gap: 8, alignItems: "center" }}>
                  {c.flaggedCount > 0 && <span style={{ fontSize: 11, color: "var(--muted)" }}>{c.flaggedCount} {zh ? "项" : "flagged"}</span>}
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: STC[c.status] || "var(--muted)" }}>{c.status}</span>
                  {onInvestigate && (c.status === "error" || c.status === "warning") && (
                    <button style={invBtnStyle} title={zh ? "对整个检查项发起 DevOps Agent 调查" : "Investigate this whole check with DevOps Agent"}
                      onClick={(e) => { e.stopPropagation(); onInvestigate(investigateTaCheckPrompt(c.name, c.status, c.flaggedCount)); }}>
                      {zh ? "调查" : "Investigate"}
                    </button>
                  )}
                </span>
              </div>
              {expanded === c.id && (
                <div style={{ padding: "2px 0 8px 16px" }}>
                  {taRes[c.id!] === "loading" && <div style={{ color: "var(--muted)", fontSize: 12 }}>{zh ? "加载被标记资源…" : "Loading flagged resources…"}</div>}
                  {taRes[c.id!] === "error" && <div style={{ color: "#d13212", fontSize: 12 }}>{zh ? "加载失败" : "Failed to load"}</div>}
                  {typeof taRes[c.id!] === "object" && (taRes[c.id!] as TaCheckResources).resources.map((r, ri) => (
                    <div key={ri} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "4px 0" }}>
                      <span style={{ fontSize: 11.5, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.region && <span style={{ marginRight: 6, color: "var(--text)", fontWeight: 600 }}>{r.region}</span>}
                        {r.metadata.filter(Boolean).slice(0, 4).join(" · ")}
                      </span>
                      {onInvestigate && (
                        <button style={invBtnStyle} onClick={(e) => { e.stopPropagation(); onInvestigate(investigateTaPrompt(c.name, [r.region, ...r.metadata])); }}>
                          {zh ? "调查" : "Investigate"}
                        </button>
                      )}
                    </div>
                  ))}
                  {typeof taRes[c.id!] === "object" && (taRes[c.id!] as TaCheckResources).total > (taRes[c.id!] as TaCheckResources).resources.length && (
                    <div style={{ color: "var(--muted)", fontSize: 11 }}>{zh ? `仅显示前 ${(taRes[c.id!] as TaCheckResources).resources.length} / 共 ${(taRes[c.id!] as TaCheckResources).total} 项` : `Showing ${(taRes[c.id!] as TaCheckResources).resources.length} of ${(taRes[c.id!] as TaCheckResources).total}`}</div>
                  )}
                </div>
              )}
            </div>
          )) : <div style={{ color: "var(--muted)", fontSize: 12 }}>{zh ? "无安全检查项" : "No checks"}</div>}
        </Card>
      </>)}
      </>)}

      {show("hub-score") && cardVisible("hub-score") && (<>
      <SectionTitle>{zh ? "Security Hub 活跃发现" : "Security Hub — Active Findings"}{acctBadge}</SectionTitle>
      {!hub?.available ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{hub?.reason === "not_enabled" ? (zh ? "Security Hub 未开通。" : "Security Hub not enabled.") : (zh ? "不可用" : "Unavailable")}</div>
      ) : (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8, marginBottom: 12 }}>
          {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((s) => (
            <Card key={s} style={{ textAlign: "center" }}><div style={{ fontSize: 24, fontWeight: 800, color: SEVC[s] }}>{hub.severity?.[s] || 0}</div><div style={{ color: "var(--muted)", fontSize: 11 }}>{s}</div></Card>
          ))}
        </div>
        <Card>
          <Label>{zh ? "Top 高危发现" : "Top High-Severity Findings"}</Label>
          {(hub.top || []).length > 0 ? (hub.top || []).map((f, i) => (
            <div key={i} style={{ padding: "6px 0", borderBottom: "1px dashed var(--line)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 12.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.title}</span>
                <span style={{ flexShrink: 0, display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: SEVC[(f.severity || "").toUpperCase()] || "var(--muted)" }}>{f.severity}</span>
                  {onInvestigate && <button style={invBtnStyle} onClick={() => onInvestigate(investigateHubPrompt(f))}>{zh ? "调查" : "Investigate"}</button>}
                </span>
              </div>
              {f.resource && <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.resource}</div>}
            </div>
          )) : <div style={{ color: "var(--green)", fontSize: 13, fontWeight: 600 }}>{zh ? "无高危发现 ✓" : "No high-severity findings ✓"}</div>}
        </Card>
      </>)}
      </>)}

      {/* 🔴 `cardVisible` 以前漏在这里：另外三段都有，GuardDuty 没有。当时不出问题只因为
             这一段永远选不中；一接进目录就等于把一个管理员已关掉的面板照样渲染出来。 */}
      {show("guardduty") && cardVisible("guardduty") && (<>
      <SectionTitle>{zh ? "GuardDuty 活跃发现" : "GuardDuty — Active Findings"}{acctBadge}</SectionTitle>
      {gd === null ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{zh ? "加载中…" : "Loading…"}</div>
      ) : gd.ok === false ? (
        /* 没问到 ≠ 未开通。后者是关于客户环境的断言，画错了用户会去开一个已经开着的服务。 */
        <FailBanner zh={zh} what={zh ? "GuardDuty 数据" : "GuardDuty data"} code={gd.reason} onRetry={retry} />
      ) : !gd.available ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{gd.reason === "not_enabled" ? (zh ? "GuardDuty 未开通。" : "GuardDuty not enabled.") : (zh ? "不可用" : "Unavailable")}{gd.reason && gd.reason !== "not_enabled" ? ` (${gd.reason})` : ""}</div>
      ) : (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8, marginBottom: 12 }}>
          {["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((sv) => (
            <Card key={sv} style={{ textAlign: "center" }}><div style={{ fontSize: 24, fontWeight: 800, color: SEVC[sv] }}>{gd.severity?.[sv] || 0}</div><div style={{ color: "var(--muted)", fontSize: 11 }}>{sv}</div></Card>
          ))}
        </div>
        <Card>
          <Label>{zh ? "Top 高危发现" : "Top High-Severity Findings"}</Label>
          {(gd.top || []).length > 0 ? (gd.top || []).map((f, i) => (
            <div key={i} style={{ padding: "6px 0", borderBottom: "1px dashed var(--line)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <span style={{ fontSize: 12.5, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.title}</span>
                <span style={{ flexShrink: 0, display: "inline-flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: f.severity >= 9 ? SEVC.CRITICAL : SEVC.HIGH }}>{f.severity.toFixed(1)}</span>
                  {onInvestigate && <button style={invBtnStyle} onClick={() => onInvestigate(`Security deep dive: GuardDuty finding "${f.title}" (type ${f.type}, severity ${f.severity}) on ${f.resource} in ${acctPhrase}. Investigate exposure, root cause, remediation, prevention.`)}>{zh ? "调查" : "Investigate"}</button>}
                </span>
              </div>
              <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 1 }}>{f.type} · {f.region}</div>
            </div>
          )) : <div style={{ color: "var(--green)", fontSize: 13, fontWeight: 600 }}>{zh ? "无高危发现 ✓" : "No high-severity findings ✓"}</div>}
        </Card>
      </>)}
      </>)}

      {show("bulletins") && cardVisible("bulletins") && (<>
      <SectionTitle>{zh ? "AWS 安全公告 · 近 30 天" : "AWS Security Bulletins · 30d"}</SectionTitle>
      {!bul?.available ? (
        <div style={{ color: "var(--muted)", fontSize: 13 }}>{zh ? "公告源暂不可用" : "Bulletins source unavailable"}</div>
      ) : (bul.items || []).length > 0 ? (
        <Card>
          {(bul.items || []).map((b, i) => (
            <a key={i} href={b.link} target="_blank" rel="noopener noreferrer" style={{ display: "block", padding: "7px 0", borderBottom: "1px dashed var(--line)", textDecoration: "none", color: "var(--text)" }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{b.title}</div>
              <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 1 }}>{b.date}</div>
            </a>
          ))}
        </Card>
      ) : <div style={{ color: "var(--muted)", fontSize: 13 }}>{zh ? "近 30 天无公告" : "No bulletins in last 30 days"}</div>}
      </>)}
    </div>
  );
}
