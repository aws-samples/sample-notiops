import { useState } from "react";
import { useLocale } from "../i18n";
import SecurityDashboard from "./SecurityDashboard";
import type { SecurityDashboardData } from "../api/security";
import { IconSecurity, IconInvestigate, IconChangelog } from "./icons";

/**
 * Security 仪表盘「两栏浏览器」—— 仿「通知」主题:左侧列各仪表盘,右侧显示选中项的完整内容。
 * 复用 NotificationsPanel 的 .notif2 / .notif-side / .notif-content 样式(团队一致),
 * 右侧内容委托给 SecurityDashboard 的「单 dashboard 模式」(传 dashboardId)。
 */
const DASHBOARDS = [
  { id: "ta-security", zh: "TA 安全建议", en: "TA Security" },
  { id: "hub-score", zh: "Security Hub", en: "Security Hub" },
  { id: "bulletins", zh: "安全公告", en: "Security Bulletins" },
] as const;

const ICONS: Record<string, React.ReactNode> = {
  "ta-security": <IconSecurity size={16} />,
  "hub-score": <IconInvestigate size={16} />,
  "bulletins": <IconChangelog size={16} />,
};

export default function SecurityDashboardBrowser({
  data, can, initial = "ta-security",
  accountId, accounts, onAccountChange, onInvestigate,
}: {
  data?: SecurityDashboardData;
  can?: (key: string) => boolean;
  initial?: string;
  accountId?: string;
  accounts?: { accountId: string; accountName?: string }[];
  onAccountChange?: (id: string) => void;
  onInvestigate?: (prompt: string) => void;
}) {
  const { locale } = useLocale();
  const zh = locale !== "en";
  const [sel, setSel] = useState<string>(initial);

  return (
    <div className="notif2">
      {/* 左侧:各仪表盘列表 */}
      <div className="notif-side">
        <div className="notif-side-head">
          <div className="notif-side-title"><IconSecurity size={17} /> {zh ? "安全仪表盘" : "Security Dashboards"}</div>
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
        <SecurityDashboard dashboardId={sel} data={data} can={can}
          accountId={accountId} accounts={accounts} onAccountChange={onAccountChange} onInvestigate={onInvestigate} />
      </div>
    </div>
  );
}
