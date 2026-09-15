import { useState } from "react";
import { useLocale } from "../i18n";
import InvestigationDashboard from "./InvestigationDashboard";
import type { AlarmDashboardData } from "../api/alarms";
import { IconInvestigate, IconReports, IconChangelog, IconCases, IconBell, IconWhatsNew } from "./icons";

/**
 * Investigation 仪表盘「两栏浏览器」—— 仿「通知」主题:左侧列各仪表盘,右侧显示选中项的完整内容。
 * 复用 NotificationsPanel 的 .notif2 / .notif-side / .notif-content 样式(团队一致),
 * 右侧内容委托给 InvestigationDashboard 的「单 dashboard 模式」(传 dashboardId)。
 */
const DASHBOARDS = [
  { id: "alarm-overview", zh: "告警总览", en: "Alarm Overview" },
  { id: "alarm-active", zh: "当前告警", en: "Active Alarms" },
  { id: "alarm-history", zh: "最近变更", en: "Recent Changes" },
  { id: "backup", zh: "Backup 健康", en: "Backup Health" },
  { id: "health", zh: "AWS Health", en: "AWS Health" },
  { id: "eos", zh: "EOL 风险", en: "EOL Risk" },
  { id: "inbox", zh: "事件收件箱", en: "Event Inbox" },
] as const;

const ICONS: Record<string, React.ReactNode> = {
  "alarm-overview": <IconInvestigate size={16} />,
  "alarm-active": <IconReports size={16} />,
  "alarm-history": <IconChangelog size={16} />,
  "backup": <IconCases size={16} />,
  "health": <IconBell size={16} />,
  "eos": <IconChangelog size={16} />,
  "inbox": <IconWhatsNew size={16} />,
};

export default function InvestigationDashboardBrowser({
  data, can, onInvestigate, onNotify, onReload, initial = "alarm-overview",
  accountId,
}: {
  data?: AlarmDashboardData;
  can?: (key: string) => boolean;
  // opts 原样转给 ChatApp：事件收件箱卡片会带 { deep: true } 要求开「深度调查（直连）」。
  onInvestigate?: (query: string, opts?: { deep?: boolean }) => void;
  onNotify?: (query: string) => void;
  /** 告警数据由上层托管（data prop）时，「重试」要请上层重取；不传则内容组件本地重拉。 */
  onReload?: () => void;
  initial?: string;
  /** 多账号：转给内容组件（Backup / Health / EOL 按该账号视角）。
   *  切账号只有一个入口 —— 顶栏的账号选择器；看板内部原来那个「组织概览点行下钻」
   *  已随缩略卡落地页一起删了，所以这里不再需要 accounts / onAccountChange。 */
  accountId?: string;
}) {
  const { locale } = useLocale();
  const zh = locale !== "en";
  const [sel, setSel] = useState<string>(initial);

  return (
    <div className="notif2">
      {/* 左侧:各仪表盘列表 */}
      <div className="notif-side">
        <div className="notif-side-head">
          <div className="notif-side-title"><IconInvestigate size={17} /> {zh ? "调查仪表盘" : "Investigation Dashboards"}</div>
        </div>
        <div className="notif-side-group">{zh ? "仪表盘" : "Dashboards"}</div>
        {DASHBOARDS.map((d) => (
          <button key={d.id} className={"notif-navitem" + (sel === d.id ? " active" : "")} onClick={() => setSel(d.id)}>
            <span className="notif-navic">{ICONS[d.id]}</span>
            <span className="notif-navlabel">{zh ? d.zh : d.en}</span>
          </button>
        ))}
      </div>

      {/* 右侧:选中仪表盘的完整内容 */}
      <div className="notif-content">
        <InvestigationDashboard dashboardId={sel} data={data} can={can} onInvestigate={onInvestigate} onNotify={onNotify}
          onReload={onReload} accountId={accountId} />
      </div>
    </div>
  );
}
