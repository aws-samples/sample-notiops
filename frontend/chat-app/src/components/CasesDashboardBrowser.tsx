import { useState } from "react";
import { useLocale } from "../i18n";
import CasesDashboard from "./CasesDashboard";
import type { CasesDashboardData } from "../api/cases";
import { IconCases, IconInvestigate, IconReports, IconSecurity } from "./icons";

/**
 * 案例仪表盘「两栏浏览器」—— 仿「通知」主题(与成本仪表盘 FinopsDashboardBrowser 一致):
 * 左侧列各仪表盘,右侧显示选中项的完整内容。复用 .notif2 / .notif-side / .notif-content 样式。
 */
const DASHBOARDS = [
  { id: "overview", zh: "未结案例概览", en: "Open Cases Overview" },
  { id: "waiting", zh: "等你回复", en: "Waiting on You" },
  { id: "incidents", zh: "高危 / Incident", en: "Incidents" },
  { id: "sla", zh: "响应健康", en: "Response Health" },
] as const;

const ICONS: Record<string, React.ReactNode> = {
  overview: <IconCases size={16} />,
  waiting: <IconReports size={16} />,
  incidents: <IconSecurity size={16} />,
  sla: <IconInvestigate size={16} />,
};

export default function CasesDashboardBrowser({
  data, onAsk, initial = "overview",
}: {
  data?: CasesDashboardData;
  onAsk?: (q: string) => void;
  initial?: string;
}) {
  const { locale } = useLocale();
  const zh = locale !== "en";
  const [sel, setSel] = useState<string>(initial);

  return (
    <div className="notif2">
      <div className="notif-side">
        <div className="notif-side-head">
          <div className="notif-side-title"><IconCases size={17} /> {zh ? "案例仪表盘" : "Case Dashboards"}</div>
        </div>
        <div className="notif-side-group">{zh ? "仪表盘" : "Dashboards"}</div>
        {DASHBOARDS.map((d) => (
          <button key={d.id} className={"notif-navitem" + (sel === d.id ? " active" : "")} onClick={() => setSel(d.id)}>
            <span className="notif-navic">{ICONS[d.id]}</span>
            <span className="notif-navlabel">{zh ? d.zh : d.en}</span>
          </button>
        ))}
      </div>
      <div className="notif-content">
        <CasesDashboard dashboardId={sel} onAsk={onAsk} data={data} />
      </div>
    </div>
  );
}
