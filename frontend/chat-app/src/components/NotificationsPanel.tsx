import { useEffect, useState } from "react";
import { useT, useLocale } from "../i18n";
import {
  listNotifications, markRead, getHealthDashboard, getHealthEventDetail,
  type NotificationItem, type Severity, type HealthDashboard, type HealthEvent, type HealthBucket, type HealthEventDetail,
} from "../api/notifications";
import { IconBell, IconInvestigate, IconExternal, IconWhatsNew, IconSecurity, IconReports, IconCases, IconChevronRight } from "./icons";
import { getEosDashboard, getEosOrgSummary, type EosDashboardData, type EosOrgRow } from "../api/eos";

/**
 * 「通知」主题主区 —— 两层目录(参考「定制」页):左侧子导航 + 右侧内容。
 * 子项:
 *   AWS Health(实时查 Health API,镜像控制台):
 *     · 服务运行状况(公共 PUBLIC issue)
 *     · 您的账户运行状况(账户 issue)
 *     · 计划的更改(scheduledChange)
 *   事件通知:
 *     · 其他事件(CloudWatch/Backup/GuardDuty 等 push 落库的收件箱)
 * 每个子项标题带计数徽章;挂载即把收件箱已读游标推到最新(markRead)清红点。
 */
type SectionKey = "service" | "account" | "scheduled" | "eos" | "other";
const RED = "#d13212";

const fmtTime = (ts: number, locale: string) => {
  const d = new Date(ts);
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000), h = Math.floor(m / 60), day = Math.floor(h / 24);
  const en = locale === "en";
  if (m < 1) return en ? "just now" : "刚刚";
  if (h < 1) return en ? `${m}m ago` : `${m} 分钟前`;
  if (day < 1) return en ? `${h}h ago` : `${h} 小时前`;
  if (day < 7) return en ? `${day}d ago` : `${day} 天前`;
  return d.toLocaleDateString();
};

const healthSeverity = (cat: string): Severity =>
  cat === "issue" ? "critical" : cat === "scheduledChange" ? "warn" : "info";

const fmtAbs = (ts?: number) => (ts ? new Date(ts).toLocaleString() : "—");

// 用完整详情拼给 Agent 的上下文(深入调查 / 就此提问共用)。带起止时间 + 受影响资源 + 描述。
function detailContext(d: HealthEventDetail): string {
  const lines = [
    `AWS Health event: ${d.eventTypeCode} (category=${d.category}) for service ${d.service} in ${d.region || "global"}.`,
    `Status: ${d.statusCode}. Start: ${fmtAbs(d.startTime)}. End: ${d.endTime ? fmtAbs(d.endTime) : "(ongoing/none)"}.`,
  ];
  const ents = d.affectedEntities || [];
  if (ents.length) {
    lines.push(`Affected resources (${ents.length}):`);
    ents.slice(0, 30).forEach((e) => lines.push(`  - ${e.value}${e.status ? ` [${e.status}]` : ""}`));
  }
  if (d.description) lines.push("", "Description:", d.description);
  return lines.join("\n");
}

/**
 * 单张 Health 事件卡:列表默认只显示摘要;点「显示完整通知」按 arn 动态拉全详情
 * (起/止时间 + 受影响资源 + 完整描述)就地展开。深入调查/就此提问也先拉全详情再发给 Agent
 * (上下文最全);拉取中禁用按钮,失败回退到摘要级信息。
 */
function HealthEventCard({
  e, locale, t, tpl, onInvestigate, onAsk,
}: {
  e: HealthEvent;
  locale: string;
  t: (k: string) => string;
  tpl: (k: string, v: Record<string, string | number>) => string;
  onInvestigate: (query: string, title: string) => void;
  onAsk: (query: string) => void;
}) {
  const sev = healthSeverity(e.category);
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<HealthEventDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // 懒加载:第一次需要详情时才拉,拉到后缓存复用(展开/调查/提问共用一份)。
  const ensureDetail = async (): Promise<HealthEventDetail | null> => {
    if (detail) return detail;
    setLoading(true); setFailed(false);
    const d = await getHealthEventDetail(e.arn);
    setLoading(false);
    if (!d || d.available === false) { setFailed(true); return null; }
    setDetail(d);
    return d;
  };

  const toggle = async () => {
    if (!expanded && !detail) await ensureDetail();
    setExpanded((v) => !v);
  };

  // 「深入调查」：拉详情后，让 agent 检查客户环境受影响资源 + 给受影响清单和下一步建议(只读)。
  const doInvestigate = async () => {
    const d = await ensureDetail();
    const zh = locale !== "en";
    const svc = e.service || "the affected service";
    const region = e.region || (zh ? "所有区域" : "all regions");
    const base = d ? detailContext(d) : `AWS Health event ${e.eventTypeCode} (${e.category}) for service ${e.service} in ${e.region || "global"}.`;
    const q = zh
      ? `${base}\n\n请检查我当前 AWS 环境里哪些资源可能受此事件影响：\n`
        + `1) 若有受影响实体(affected entities)，优先列出；\n`
        + `2) 再按受影响服务(${svc})和区域(${region})列出我账号里的相关资源；\n`
        + `3) 交叉判断出「可能受影响的资源清单」（资源 ID/名称、类型、区域）；\n`
        + `4) 给出针对性的下一步建议。全程只读，不修改任何资源。`
      : `${base}\n\nCheck which resources in my current AWS environment may be affected by this event:\n`
        + `1) If affected entities are available, list them first;\n`
        + `2) Then list my account's resources for the affected service (${svc}) in ${region};\n`
        + `3) Cross-reference to produce a "likely affected resources" list (ID/name, type, region);\n`
        + `4) Give targeted next-step recommendations. Read-only; do not modify any resource.`;
    onInvestigate(q, e.eventTypeCode);
  };

  // 「Ask about this」：拉详情(含 affected entities)后，让 agent 先检查客户环境里哪些资源
  // 可能受此 Health 事件影响，给受影响清单 + 下一步建议(只读)。
  const doAsk = async () => {
    const d = await ensureDetail();
    const zh = locale !== "en";
    const svc = e.service || "the affected service";
    const region = e.region || (zh ? "所有区域" : "all regions");
    const base = d ? detailContext(d) : `AWS Health event ${e.eventTypeCode} (${e.category}) for service ${e.service} in ${e.region || "global"}.`;
    const q = zh
      ? `${base}\n\n请检查我当前 AWS 环境里哪些资源可能受此事件影响：\n`
        + `1) 若有受影响实体(affected entities)，优先列出；\n`
        + `2) 再按受影响服务(${svc})和区域(${region})列出我账号里的相关资源；\n`
        + `3) 交叉判断出「可能受影响的资源清单」（资源 ID/名称、类型、区域）；\n`
        + `4) 给出针对性的下一步建议。全程只读，不修改任何资源。`
      : `${base}\n\nCheck which resources in my current AWS environment may be affected by this event:\n`
        + `1) If affected entities are available, list them first;\n`
        + `2) Then list my account's resources for the affected service (${svc}) in ${region};\n`
        + `3) Cross-reference to produce a "likely affected resources" list (ID/name, type, region);\n`
        + `4) Give targeted next-step recommendations. Read-only; do not modify any resource.`;
    onAsk(q);
  };

  return (
    <div className={"notif-card sev-" + sev}>
      <span className="notif-sevbar" />
      <div className="notif-card-body">
        <div className="notif-card-top">
          <span className="notif-src">{e.service || "AWS"}</span>
          <span className={"notif-sevtag sev-" + sev}>{t(`notif.sev.${sev}`)}</span>
          <span className="notif-time">{fmtTime(e.lastUpdatedTime || e.startTime, locale)}</span>
        </div>
        <div className="notif-card-title">{e.eventTypeCode}</div>
        <div className="notif-card-meta">
          {e.region && <span className="notif-region">{e.region}</span>}
          <span className="notif-region">{e.statusCode}</span>
        </div>

        {/* 就地展开的完整详情 */}
        {expanded && (
          <div className="notif-detail">
            {loading && !detail ? (
              <div className="notif-detail-loading">{t("notif.detail.loading")}</div>
            ) : failed ? (
              <div className="notif-detail-loading">{t("notif.detail.failed")}</div>
            ) : detail ? (
              <>
                <div className="notif-detail-times">
                  <span><b>{t("notif.detail.start")}:</b> {fmtAbs(detail.startTime)}</span>
                  <span><b>{t("notif.detail.end")}:</b> {detail.endTime ? fmtAbs(detail.endTime) : "—"}</span>
                  <span><b>{t("notif.detail.updated")}:</b> {fmtAbs(detail.lastUpdatedTime)}</span>
                </div>
                <div className="notif-detail-affected">
                  <div className="notif-detail-label">{t("notif.detail.affected")}</div>
                  {detail.affectedEntities && detail.affectedEntities.length ? (
                    <ul className="notif-affected-list">
                      {detail.affectedEntities.slice(0, 30).map((a, i) => (
                        <li key={i}><span className="notif-affected-val" title={a.value}>{a.value}</span>{a.status && <span className="notif-affected-st">{a.status}</span>}</li>
                      ))}
                      {detail.affectedEntities.length > 30 && (
                        <li className="notif-affected-more">{tpl("notif.detail.affectedMore", { n: 30 })}</li>
                      )}
                    </ul>
                  ) : (
                    <div className="notif-detail-none">{t("notif.detail.affectedNone")}</div>
                  )}
                </div>
                {detail.description && (
                  <div className="notif-detail-desc">
                    <div className="notif-detail-label">{t("notif.detail.description")}</div>
                    <div className="notif-detail-desctext">{detail.description}</div>
                  </div>
                )}
              </>
            ) : null}
          </div>
        )}

        <div className="notif-card-actions">
          <button className="notif-act primary" onClick={doInvestigate} disabled={loading}>
            <IconInvestigate size={14} /> {t("notif.investigate")}
          </button>
          <button className="notif-act" onClick={doAsk} disabled={loading}>
            <IconWhatsNew size={14} /> {t("notif.ask")}
          </button>
          <button className="notif-act notif-act-expand" onClick={toggle}>
            <span className={"notif-expand-caret" + (expanded ? " open" : "")}><IconChevronRight size={13} /></span>
            {expanded ? t("notif.detail.hide") : t("notif.detail.show")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 收件箱事件卡(其他事件源)。详情已随记录落库(description/resource/region),
 * 「显示完整通知」就地展开完整描述,无需再拉后台。深入调查/就此提问带上完整描述。
 */
function InboxEventCard({
  n, isNew, locale, t, onInvestigate, onAsk,
}: {
  n: NotificationItem;
  isNew: boolean;
  locale: string;
  t: (k: string) => string;
  onInvestigate: (query: string, title: string) => void;
  onAsk: (query: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasDetail = !!(n.description && n.description.trim());
  return (
    <div className={"notif-card sev-" + n.severity + (isNew ? " is-new" : "")}>
      <span className="notif-sevbar" />
      <div className="notif-card-body">
        <div className="notif-card-top">
          <span className="notif-src">{n.source}</span>
          <span className={"notif-sevtag sev-" + n.severity}>{t(`notif.sev.${n.severity}`)}</span>
          {isNew && <span className="notif-newtag">{t("notif.new")}</span>}
          <span className="notif-time">{fmtTime(n.ts, locale)}</span>
        </div>
        <div className="notif-card-title">{n.title}</div>
        {(n.resource || n.region) && (
          <div className="notif-card-meta">
            {n.resource && <span className="notif-res" title={n.resource}>{n.resource}</span>}
            {n.region && <span className="notif-region">{n.region}</span>}
          </div>
        )}
        {expanded && hasDetail && (
          <div className="notif-detail">
            <div className="notif-detail-desctext">{n.description}</div>
          </div>
        )}
        <div className="notif-card-actions">
          <button className="notif-act primary" onClick={() => onInvestigate(n.dispatchQuery || n.title, n.title)}>
            <IconInvestigate size={14} /> {t("notif.investigate")}
          </button>
          <button className="notif-act" onClick={() => onAsk(`${n.title}\n\n${n.description || ""}`)}>
            <IconWhatsNew size={14} /> {t("notif.ask")}
          </button>
          {n.consoleUrl && (
            <a className="notif-act" href={n.consoleUrl} target="_blank" rel="noreferrer">
              {t("notif.console")} <IconExternal size={12} />
            </a>
          )}
          {hasDetail && (
            <button className="notif-act notif-act-expand" onClick={() => setExpanded((v) => !v)}>
              <span className={"notif-expand-caret" + (expanded ? " open" : "")}><IconChevronRight size={13} /></span>
              {expanded ? t("notif.detail.hide") : t("notif.detail.show")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function NotificationsPanel({
  onInvestigate, onAsk, onLoaded, can = () => true, accountId = "", accounts = [], onAccountChange,
}: {
  onInvestigate: (query: string, title: string) => void;
  onAsk: (query: string) => void;
  onLoaded?: () => void;
  can?: (key: string) => boolean;
  /** 多账号：Health/EOS 区按该账号视角（空 = org 汇总/部署账号） */
  accountId?: string;
  accounts?: { accountId: string; accountName?: string; ou?: string }[];
  onAccountChange?: (id: string) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [lastReadTs, setLastReadTs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<HealthDashboard | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  const [section, setSection] = useState<SectionKey>("service");
  // 计划变更视图：列表 / 时间轴（F4）
  const [schedView, setSchedView] = useState<"calendar" | "list" | "timeline">("calendar");
  // ③b 多账号：Scheduled changes 的账号 chip 过滤（org 视图事件带 account 字段；"" = 全部）
  const [schedAcct, setSchedAcct] = useState("");
  // ③c 多账号：EOS org 汇总表（懒加载：进 EOS 区且 org 视角时拉一次）
  const [eosOrg, setEosOrg] = useState<EosOrgRow[] | null>(null);
  const [calCursor, setCalCursor] = useState<{ y: number; m: number } | null>(null);
  const [calDay, setCalDay] = useState<string>("");
  const [eosData, setEosData] = useState<EosDashboardData | null>(null);
  const [eosLoading, setEosLoading] = useState(false);

  const load = () => {
    setLoading(true);
    listNotifications().then((r) => {
      setItems(r.items); setLastReadTs(r.lastReadTs); setLoading(false);
    }).catch(() => setLoading(false));
    setHealthLoading(true);
    getHealthDashboard(accountId).then((h) => { setHealth(h); setHealthLoading(false); }).catch(() => setHealthLoading(false));
  };

  useEffect(() => {
    load();
    markRead().then(() => onLoaded?.()).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tpl = (key: string, vars: Record<string, string | number>) =>
    Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key));

  // 各子项计数(徽章)。bucket 计数含 moreCount(反映真实总数)。
  const cnt = (b?: HealthBucket) => b ? b.items.length + b.moreCount : 0;
  const counts: Record<SectionKey, number> = {
    service: cnt(health?.serviceIssues),
    account: cnt(health?.accountIssues),
    scheduled: cnt(health?.scheduledChanges),
    eos: eosData?.atRisk ?? 0,
    other: items.length,
  };

  // section 切到 EOS 时懒加载(多 region 扫描较慢，只在需要时拉)；账号切换即失效重取
  useEffect(() => {
    if (section === "eos" && !accountId && eosOrg === null) {
      getEosOrgSummary().then((r) => setEosOrg(r?.rows ?? [])).catch(() => setEosOrg([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, accountId]);
  useEffect(() => {
    if (section === "eos" && eosData === null && !eosLoading) {
      setEosLoading(true);
      getEosDashboard(accountId).then((d) => { setEosData(d); setEosLoading(false); }).catch(() => setEosLoading(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, eosData, accountId]);
  useEffect(() => {
    // 账号切换 → EOS + Health 数据失效重取
    setEosData(null);
    setHealthLoading(true);
    getHealthDashboard(accountId).then((h) => { setHealth(h); setHealthLoading(false); }).catch(() => setHealthLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  const renderHealthEvent = (e: HealthEvent) => (
    <HealthEventCard key={e.arn} e={e} locale={locale} t={t} tpl={tpl}
      onInvestigate={onInvestigate} onAsk={onAsk} />
  );

  // ── Health 分块列表:标题 + 控制台链接 + 列表/空态 + "更多去控制台" ──
  const renderHealthBucket = (
    title: string, bucket: HealthBucket | undefined, emptyKey: string,
    subLink: { href: string; label: string }, moreLink: string,
  ) => {
    if (healthLoading) return <div className="notif-health-empty">…</div>;
    if (!health || health.available === false) {
      return (
        <div className="notif-health-unavail">
          {t("notif.health.unavailable")}
          {health?.links?.home && (
            <a href={health.links.home} target="_blank" rel="noreferrer"> {t("notif.health.openConsole")} <IconExternal size={12} /></a>
          )}
        </div>
      );
    }
    return (
      <div className="notif-pane">
        <div className="notif-pane-head">
          <div className="notif-pane-title">{title}</div>
          <a href={subLink.href} target="_blank" rel="noreferrer" className="notif-health-sublink">
            {subLink.label} <IconExternal size={12} />
          </a>
        </div>
        {!bucket || bucket.items.length === 0 ? (
          <div className="notif-health-empty">{t(emptyKey)}</div>
        ) : (
          <div className="notif-list">
            {bucket.items.map(renderHealthEvent)}
            {bucket.moreCount > 0 && (
              <a className="notif-health-more" href={moreLink} target="_blank" rel="noreferrer">
                {tpl("notif.health.moreInConsole", { n: bucket.moreCount })} <IconExternal size={12} />
              </a>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── 计划变更：列表 / 时间轴切换（F4，纯前端布局，复用 Health 数据）──
  const renderScheduled = () => {
    const L = health?.links;
    const subHref = L?.scheduledChanges || "#";
    if (healthLoading) return <div className="notif-health-empty">…</div>;
    if (!health || health.available === false) {
      return (
        <div className="notif-health-unavail">
          {t("notif.health.unavailable")}
          {health?.links?.home && (
            <a href={health.links.home} target="_blank" rel="noreferrer"> {t("notif.health.openConsole")} <IconExternal size={12} /></a>
          )}
        </div>
      );
    }
    const bucket = health?.scheduledChanges;
    const allItems = bucket?.items ?? [];
    // 按账号 chip 过滤（org 汇总视图下才有意义；单账号视角 chips 不显示）
    const items = schedAcct ? allItems.filter((e: { account?: string }) => e.account === schedAcct) : allItems;
    const schedByAcct = new Map<string, number>();
    for (const e of allItems as { account?: string }[]) {
      if (e.account) schedByAcct.set(e.account, (schedByAcct.get(e.account) || 0) + 1);
    }
    const now = Date.now();
    const DAY = 86400000;
    const inWin = (d: number) => items.filter((e) => e.startTime >= now && e.startTime <= now + d * DAY).length;
    const counts = [
      { d: 7, n: inWin(7), k: "notif.sched.window7" },
      { d: 30, n: inWin(30), k: "notif.sched.window30" },
      { d: 60, n: inWin(60), k: "notif.sched.window60" },
    ];
    const chipStyle = (active: boolean): React.CSSProperties => ({
      display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 11px", borderRadius: 100, cursor: "pointer",
      border: `1px solid ${active ? "var(--orange)" : "var(--line)"}`, background: active ? "rgba(255,153,0,.10)" : "transparent",
      fontSize: 11.5, fontWeight: active ? 700 : 500, color: active ? "var(--text)" : "var(--muted)",
    });
    const acctChips = !accountId && schedByAcct.size > 0 && (
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "0 0 10px" }}>
        <span style={chipStyle(schedAcct === "")} onClick={() => setSchedAcct("")} role="button">
          {t("notif.sched.allAccounts")} · {allItems.length}
        </span>
        {[...schedByAcct.entries()].sort((a, b) => b[1] - a[1]).map(([acct, n]) => (
          <span key={acct} style={chipStyle(schedAcct === acct)} onClick={() => setSchedAcct(schedAcct === acct ? "" : acct)} role="button">
            {accounts.find((a) => a.accountId === acct)?.accountName || acct} · {n}
          </span>
        ))}
      </div>
    );
    // 时间轴：按开始日期分组，日期升序，组内按 startTime 升序
    const groups = new Map<string, HealthEvent[]>();
    for (const ev of [...items].sort((a, b) => a.startTime - b.startTime)) {
      const key = new Date(ev.startTime).toLocaleDateString(locale === "en" ? "en-US" : "zh-CN", { year: "numeric", month: "short", day: "numeric" });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(ev);
    }
    // 日历：按当前游标月渲染，事件落到起始日
    const loc = locale === "en" ? "en-US" : "zh-CN";
    const today = new Date();
    const cur = calCursor ?? { y: today.getFullYear(), m: today.getMonth() };
    const first = new Date(cur.y, cur.m, 1);
    const startW = first.getDay();
    const dim = new Date(cur.y, cur.m + 1, 0).getDate();
    const evByDay = new Map<number, HealthEvent[]>();
    for (const ev of items) {
      const d = new Date(ev.startTime);
      if (d.getFullYear() === cur.y && d.getMonth() === cur.m) {
        const day = d.getDate();
        if (!evByDay.has(day)) evByDay.set(day, []);
        evByDay.get(day)!.push(ev);
      }
    }
    const wdFmt = new Intl.DateTimeFormat(loc, { weekday: "short" });
    const weekdays = [...Array(7)].map((_, i) => wdFmt.format(new Date(2023, 0, 1 + i))); // 2023-01-01 = 周日
    const monthTitle = new Intl.DateTimeFormat(loc, { year: "numeric", month: "long" }).format(first);
    const cells: (number | null)[] = [...Array(startW).fill(null), ...[...Array(dim)].map((_, i) => i + 1)];
    const isToday = (day: number) => today.getFullYear() === cur.y && today.getMonth() === cur.m && today.getDate() === day;
    const dayEvents = calDay ? (evByDay.get(Number(calDay)) || []) : [];
    const shiftMonth = (delta: number) => { const nm = new Date(cur.y, cur.m + delta, 1); setCalCursor({ y: nm.getFullYear(), m: nm.getMonth() }); setCalDay(""); };
    return (
      <div className="notif-pane">
        <div className="notif-pane-head">
          <div className="notif-pane-title">{t("notif.health.scheduledChanges")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ display: "inline-flex", gap: 2, border: "1px solid var(--line)", borderRadius: 6, overflow: "hidden" }}>
              {(["calendar", "list", "timeline"] as const).map((v) => (
                <button key={v} className={"navitem" + (schedView === v ? " active" : "")} style={{ width: "auto", padding: "3px 10px", borderRadius: 0, fontSize: 12 }} onClick={() => setSchedView(v)}>{t(`notif.health.view${v[0].toUpperCase() + v.slice(1)}`)}</button>
              ))}
            </div>
            <a href={subHref} target="_blank" rel="noreferrer" className="notif-health-sublink">{t("notif.health.openConsole")} <IconExternal size={12} /></a>
          </div>
        </div>
        {acctChips}
        {/* 计数卡：未来 7 / 30 / 60 天 */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, margin: "4px 0 14px" }}>
          {counts.map((c) => (
            <div key={c.d} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".05em" }}>{t(c.k)}</div>
              <div style={{ fontSize: 24, fontWeight: 800, color: c.n > 0 ? "var(--orange)" : "var(--text)" }}>{c.n}<span style={{ fontSize: 11, fontWeight: 500, color: "var(--muted)" }}> {t("notif.sched.changes")}</span></div>
            </div>
          ))}
        </div>
        {items.length === 0 ? (
          <div className="notif-health-empty">{t("notif.health.noScheduled")}</div>
        ) : schedView === "calendar" ? (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <button className="navitem" style={{ width: "auto", padding: "3px 12px", borderRadius: 6, fontSize: 15 }} onClick={() => shiftMonth(-1)}>‹</button>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{monthTitle}</div>
              <button className="navitem" style={{ width: "auto", padding: "3px 12px", borderRadius: 6, fontSize: 15 }} onClick={() => shiftMonth(1)}>›</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
              {weekdays.map((w, i) => <div key={"w" + i} style={{ textAlign: "center", fontSize: 11, color: "var(--muted)", fontWeight: 600, padding: "2px 0" }}>{w}</div>)}
              {cells.map((day, i) => {
                if (day === null) return <div key={"b" + i} />;
                const evs = evByDay.get(day) || [];
                const sel = calDay === String(day);
                return (
                  <button key={day} onClick={() => setCalDay(sel ? "" : String(day))} style={{
                    minHeight: 46, borderRadius: 8, padding: "4px 0 3px", cursor: "pointer",
                    border: `1px solid ${sel ? "var(--orange)" : "var(--line)"}`,
                    background: sel ? "rgba(255,153,0,.10)" : evs.length ? "var(--card)" : "transparent",
                    color: "var(--text)",
                  }}>
                    <div style={{ fontSize: 12, fontWeight: isToday(day) ? 800 : 500, color: isToday(day) ? "var(--blue)" : "var(--text)" }}>{day}</div>
                    {evs.length > 0 && <div style={{ marginTop: 2, fontSize: 10, fontWeight: 700, color: "#fff", background: "var(--orange)", borderRadius: 100, display: "inline-block", padding: "0 6px" }}>{evs.length}</div>}
                  </button>
                );
              })}
            </div>
            {calDay && dayEvents.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--muted)", marginBottom: 6 }}>{monthTitle} · {calDay}</div>
                <div className="notif-list">{dayEvents.map(renderHealthEvent)}</div>
              </div>
            )}
          </div>
        ) : schedView === "list" ? (
          <div className="notif-list">
            {items.map(renderHealthEvent)}
            {bucket && bucket.moreCount > 0 && (
              <a className="notif-health-more" href={subHref} target="_blank" rel="noreferrer">
                {tpl("notif.health.moreInConsole", { n: bucket.moreCount })} <IconExternal size={12} />
              </a>
            )}
          </div>
        ) : (
          <div className="notif-timeline">
            {[...groups.entries()].map(([day, evs]) => (
              <div key={day} className="notif-tl-group" style={{ marginBottom: 14 }}>
                <div className="notif-tl-date" style={{ fontWeight: 600, fontSize: 13, borderLeft: "3px solid var(--blue)", paddingLeft: 8, marginBottom: 6 }}>{day}</div>
                <div className="notif-list" style={{ paddingLeft: 11 }}>{evs.map(renderHealthEvent)}</div>
              </div>
            ))}
            {bucket && bucket.moreCount > 0 && (
              <a className="notif-health-more" href={subHref} target="_blank" rel="noreferrer">
                {tpl("notif.health.moreInConsole", { n: bucket.moreCount })} <IconExternal size={12} />
              </a>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── 生命周期 / EOS 小节 ──
  const renderEos = () => {
    const eosOrgTable = !accountId && eosOrg && eosOrg.length > 1 && (
      <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", margin: "0 0 12px" }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>{t("notif.eos.orgTable")}</div>
        {eosOrg.map((r) => (
          <div key={r.accountId || "self"} onClick={() => r.accountId && onAccountChange?.(r.accountId)} role={r.accountId ? "button" : undefined}
            style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderTop: "1px dashed var(--line)", fontSize: 12, cursor: r.accountId && onAccountChange ? "pointer" : undefined }}>
            <span style={{ color: "var(--text)" }}>{(() => { const nm = accounts.find((a) => a.accountId === r.accountId)?.accountName || r.name || ""; return nm && r.accountId ? `${nm} · ${r.accountId}` : (nm || r.accountId || t("notif.acct.deployScope")); })()}</span>
            <span style={{ color: "var(--muted)" }}>
              {!r.available ? <span style={{ color: "var(--muted)" }}>{t("notif.eos.unavail")}</span> : (<>
                {r.past > 0 && <span style={{ color: "#d13212", fontWeight: 700, marginRight: 8 }}>{r.past} {t("notif.eos.pastEol")}</span>}
                {r.in90 > 0 && <span style={{ color: "#e8590c", fontWeight: 700, marginRight: 8 }}>{r.in90} {t("notif.eos.in90riskShort")}</span>}
                {r.total} {t("notif.eos.resources")}
              </>)}
            </span>
          </div>
        ))}
      </div>
    );
    if (eosLoading) return <div className="notif-health-empty">…</div>;
    if (!eosData || eosData.available === false || eosData.ok === false) {
      return <div className="notif-health-unavail">{t("notif.eos.unavailable")}</div>;
    }
    const c = eosData.counts || { past: 0, in7: 0, in30: 0, in90: 0 };
    const cards = [
      { k: "notif.eos.past", n: c.past, color: RED },
      { k: "notif.eos.in7", n: c.in7, color: RED },
      { k: "notif.eos.in30", n: c.in30, color: "var(--orange)" },
      { k: "notif.eos.in90", n: c.in90, color: "var(--orange)" },
    ];
    const svc = Object.entries(eosData.byService || {});
    const up = eosData.upcoming || [];
    return (
      <div className="notif-pane">
        <div className="notif-pane-head">
          <div className="notif-pane-title">{t("notif.eos.title")}</div>
          <span style={{ fontSize: 11, color: "var(--muted)" }}>{tpl("notif.eos.regions", { n: eosData.regionsScanned ?? 0 })}</span>
        </div>
        {eosOrgTable}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 12 }}>
          {cards.map((cd) => (
            <div key={cd.k} style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px" }}>
              <div style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".04em" }}>{t(cd.k)}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: cd.n > 0 ? cd.color : "var(--text)" }}>{cd.n}</div>
            </div>
          ))}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr", gap: 10, marginBottom: 14 }}>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase" }}>{t("notif.eos.supported")}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "var(--green)" }}>{eosData.supportedPct != null ? `${eosData.supportedPct}%` : "—"}</div>
            <div style={{ fontSize: 11, color: "var(--muted)" }}>{eosData.supported ?? 0}/{eosData.total ?? 0} {t("notif.eos.resources")}</div>
          </div>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 10.5, color: "var(--muted)", textTransform: "uppercase", marginBottom: 4 }}>{t("notif.eos.byService")}</div>
            {svc.length === 0 ? <div style={{ fontSize: 12, color: "var(--muted)" }}>—</div> : svc.map(([s, v]) => (
              <div key={s} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "2px 0" }}>
                <span>{s}</span>
                <span style={{ fontWeight: 600, color: v.atRisk > 0 ? "var(--orange)" : "var(--muted)" }}>{v.atRisk}/{v.total}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", fontWeight: 600, margin: "2px 0 6px" }}>{t("notif.eos.upcoming")}</div>
        {up.length === 0 ? (
          <div className="notif-health-empty">{t("notif.eos.none")}</div>
        ) : (
          <div className="notif-list">
            {up.map((r, i) => {
              const dl = r.daysLeft ?? 0;
              return (
                <div key={r.service + r.id + i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "7px 0", borderTop: i ? "1px dashed var(--line)" : "none" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name} <span style={{ color: "var(--muted)", fontWeight: 400 }}>· {r.service} · {r.region}</span></div>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>{r.engine} {r.version} · EOL {r.eolDate}</div>
                  </div>
                  <span style={{ flexShrink: 0, fontSize: 12, fontWeight: 700, color: dl <= 0 ? RED : dl <= 30 ? "var(--orange)" : "var(--text)" }}>
                    {dl <= 0 ? tpl("notif.eos.overdue", { n: Math.abs(dl) }) : tpl("notif.eos.daysLeft", { n: dl })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        {(eosData.healthNotices || []).length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", fontWeight: 600, margin: "2px 0 6px" }}>{t("notif.eos.health")}</div>
            <div className="notif-list">
              {(eosData.healthNotices || []).map((h, i) => (
                <div key={h.eventTypeCode + i} style={{ padding: "6px 0", borderTop: i ? "1px dashed var(--line)" : "none", fontSize: 12.5, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontWeight: 700 }}>{h.service}</span>
                  <code style={{ fontSize: 11, color: "var(--muted)" }}>{h.eventTypeCode}</code>
                  <span style={{ color: "var(--muted)" }}>· {h.region}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── 右侧内容按选中的子项渲染 ──
  const renderContent = () => {
    const L = health?.links;
    switch (section) {
      case "service": {
        // 汇总卡（多账号重构 ①）：open 计数 + 受影响账号 Top（org 视图数据已带 affectedAccounts/account）
        const svcItems = health?.serviceIssues?.items || [];
        const acctItems = health?.accountIssues?.items || [];
        const allOpen = svcItems.length + acctItems.length + (health?.serviceIssues?.moreCount || 0) + (health?.accountIssues?.moreCount || 0);
        const scopeLabel = (health as { scope?: string })?.scope === "organization" ? t("notif.acct.orgScope") : (accountId || t("notif.acct.deployScope"));
        const topAffected = [...svcItems, ...acctItems]
          .filter((e: { affectedAccounts?: number | null }) => typeof e.affectedAccounts === "number" && e.affectedAccounts! > 0)
          .sort((a: { affectedAccounts?: number | null }, b: { affectedAccounts?: number | null }) => (b.affectedAccounts || 0) - (a.affectedAccounts || 0))
          .slice(0, 3);
        return (<>
          <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", margin: "0 0 12px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
              <span style={{ fontSize: 26, fontWeight: 800, color: allOpen > 0 ? "#e8590c" : "var(--green)" }}>{allOpen}</span>
              <span style={{ fontSize: 12.5, color: "var(--muted)" }}>{t("notif.summary.openEvents")} · {scopeLabel}</span>
            </div>
            {topAffected.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 11.5, color: "var(--muted)" }}>
                {t("notif.summary.widest")}: {topAffected.map((e: { service?: string; affectedAccounts?: number | null }, i: number) => (
                  <span key={i} style={{ marginRight: 10 }}>{e.service} <b style={{ color: "#e8590c" }}>{e.affectedAccounts} accts</b></span>
                ))}
              </div>
            )}
          </div>
          {renderHealthBucket(
            t("notif.health.serviceHealth"), health?.serviceIssues, "notif.health.noIssues",
            { href: L?.serviceHistory || "#", label: t("notif.health.statusHistory") },
            L?.serviceOpenIssues || "#")}
        </>);
      }
      case "account": {
        // 多账号重构 ②：org 视图下按账号分组计数条（点击账号 = 下钻该账号视角）
        const items = health?.accountIssues?.items || [];
        const byAcct = new Map<string, number>();
        for (const e of items as { account?: string }[]) {
          const k = e.account || "";
          if (k) byAcct.set(k, (byAcct.get(k) || 0) + 1);
        }
        const rows = [...byAcct.entries()].sort((a, b) => b[1] - a[1]);
        const maxN = rows.length ? rows[0][1] : 1;
        return (<>
          {!accountId && rows.length > 0 && (
            <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", margin: "0 0 12px" }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--muted)", textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>{t("notif.summary.byAccount")}</div>
              {rows.slice(0, 8).map(([acct, n]) => (
                <div key={acct} onClick={() => onAccountChange?.(acct)} role="button"
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "3px 0", cursor: onAccountChange ? "pointer" : undefined }}>
                  <span style={{ fontSize: 11.5, color: "var(--text)", width: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {accounts.find((a) => a.accountId === acct)?.accountName || acct}
                  </span>
                  <span style={{ height: 8, borderRadius: 4, background: "#e8590c", width: `${Math.max(8, (n / maxN) * 160)}px`, display: "inline-block" }} />
                  <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{n}</span>
                </div>
              ))}
            </div>
          )}
          {renderHealthBucket(
            t("notif.health.accountHealth"), health?.accountIssues, "notif.health.noIssues",
            { href: L?.openIssues || "#", label: t("notif.health.openConsole") },
            L?.openIssues || "#")}
        </>);
      }
      case "scheduled":
        return renderScheduled();
      case "eos":
        return renderEos();
      case "other":
      default:
        return (
          <div className="notif-pane">
            <div className="notif-pane-head">
              <div className="notif-pane-title">{t("notif.section.other")}</div>
              <div className="notif-pane-sub">{t("notif.section.otherSub")}</div>
            </div>
            {loading ? (
              <div className="notif-health-empty">…</div>
            ) : items.length === 0 ? (
              <div className="notif-empty">
                <div className="notif-empty-ic"><IconBell size={36} /></div>
                <div className="notif-empty-sub">{t("notif.empty")}</div>
              </div>
            ) : (
              <div className="notif-list">
                {items.map((n) => {
                  const isNew = n.ts > lastReadTs;
                  return (
                    <InboxEventCard key={n.id} n={n} isNew={isNew} locale={locale} t={t}
                      onInvestigate={onInvestigate} onAsk={onAsk} />
                  );
                })}
              </div>
            )}
          </div>
        );
    }
  };

  const NavItem = ({ k, icon, label }: { k: SectionKey; icon: React.ReactNode; label: string }) => (
    <button className={"notif-navitem" + (section === k ? " active" : "")} onClick={() => setSection(k)}>
      <span className="notif-navic">{icon}</span>
      <span className="notif-navlabel">{label}</span>
      {counts[k] > 0 && <span className="notif-navcount">{counts[k]}</span>}
    </button>
  );

  return (
    <div className="notif2">
      {/* 左侧子导航(两层目录) */}
      <div className="notif-side">
        <div className="notif-side-head">
          <div className="notif-side-title"><IconBell size={17} /> {t("notif.title")}</div>
          <button className="notif-refresh-mini" onClick={load} title={t("notif.refresh")}>↻</button>
        </div>
        {/* 账号选择器已上移到 Notifications 顶栏（与 Investigation 统一）；此处不再重复 */}
        <div className="notif-side-group">{t("notif.nav.group.health")}</div>
        <NavItem k="service" icon={<IconSecurity size={16} />} label={t("notif.health.serviceHealth")} />
        <NavItem k="account" icon={<IconReports size={16} />} label={t("notif.health.accountHealth")} />
        <NavItem k="scheduled" icon={<IconCases size={16} />} label={t("notif.health.scheduledChanges")} />
        {can("nav:notifications:eos") && <NavItem k="eos" icon={<IconReports size={16} />} label={t("notif.eos.title")} />}
        <div className="notif-side-group">{t("notif.nav.group.events")}</div>
        <NavItem k="other" icon={<IconBell size={16} />} label={t("notif.section.other")} />
      </div>

      {/* 右侧内容 */}
      <div className="notif-content">{renderContent()}</div>
    </div>
  );
}
