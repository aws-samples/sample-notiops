/**
 * 事件收件箱列表（按 source 过滤）—— 从「通知」主题的多源收件箱抽出，供各主题面板复用。
 * 通知主题、调查/成本/安全主题面板都用它:传入自己关心的 source 列表即可只显示对应事件。
 *
 * 数据源:listNotifications()(与通知主题同一后端收件箱);markRead 也走同一后端,
 * 故任一处查看标已读,通知主题的已读游标同步(符合"两处一致"预期)。
 */
import { useEffect, useState } from "react";
import { listNotifications, markRead, type NotificationItem } from "../api/notifications";
import { useLocale, useT } from "../i18n";
import { IconInvestigate, IconExternal, IconWhatsNew, IconChevronRight } from "./icons";

function fmtTime(ts: number, locale: string): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString(locale === "en" ? "en-US" : "zh-CN", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return ""; }
}

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

/**
 * @param sources 只显示 source ∈ sources 的条目(大小写不敏感、子串匹配,兼容 "CloudWatch Alarm" 等)。
 *                不传 = 显示全部(通知主题用)。
 * @param markReadOnMount 挂载即把已读游标推到最新(清红点)。通知主题传 true;各主题面板可传 false
 *                避免在别处顺手清掉全局红点(红点仍归通知主题管)。
 */
export default function InboxList({
  sources, onInvestigate, onAsk, markReadOnMount = false, onLoaded, emptyHint,
}: {
  sources?: string[];
  onInvestigate: (query: string, title: string) => void;
  onAsk: (query: string) => void;
  markReadOnMount?: boolean;
  onLoaded?: () => void;
  emptyHint?: string;
}) {
  const { locale } = useLocale();
  const t = useT();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [lastReadTs, setLastReadTs] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stop = false;
    listNotifications().then((r) => {
      if (stop) return;
      setItems(r.items || []);
      setLastReadTs(r.lastReadTs || 0);
      setLoading(false);
      if (markReadOnMount) markRead().then(() => onLoaded?.()).catch(() => {});
    }).catch(() => { if (!stop) setLoading(false); });
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const norm = (sources || []).map((s) => s.toLowerCase());
  const filtered = norm.length
    ? items.filter((n) => norm.some((s) => (n.source || "").toLowerCase().includes(s)))
    : items;

  if (loading) return <div className="notif-health-empty">…</div>;
  if (filtered.length === 0) {
    return <div style={{ color: "var(--muted)", fontSize: 13, padding: "8px 2px" }}>{emptyHint || (locale === "en" ? "No events." : "暂无事件。")}</div>;
  }
  return (
    <div className="notif-cards">
      {filtered.map((n) => (
        <InboxEventCard key={n.id} n={n} isNew={n.ts > lastReadTs} locale={locale} t={t}
          onInvestigate={onInvestigate} onAsk={onAsk} />
      ))}
    </div>
  );
}
