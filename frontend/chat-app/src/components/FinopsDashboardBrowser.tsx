import { useState } from "react";
import { useLocale } from "../i18n";
import FinopsDashboard from "./FinopsDashboard";
import type { FinopsDashboard as FinopsData } from "../api/finops";
import { IconFinOps, IconReports, IconInvestigate } from "./icons";

/**
 * FinOps 仪表盘「两栏浏览器」—— 仿「通知」主题:左侧列各仪表盘,右侧显示选中项的完整内容。
 * 复用 NotificationsPanel 的 .notif2 / .notif-side / .notif-content 样式(团队一致),
 * 右侧内容直接委托给 FinopsDashboard 的「单 dashboard 模式」(传 dashboardId),零卡片重复。
 */
const DASHBOARDS = [
  { id: "spend", zh: "支出概览", en: "Spend Overview" },
  { id: "optimization", zh: "优化与风险", en: "Optimization & Risk" },
  { id: "progress", zh: "关键进度", en: "Key Progress" },
  { id: "movers", zh: "环比变化", en: "MoM Movers" },
  { id: "deepdive", zh: "成本深挖", en: "Cost Deep Dive" },
  { id: "tag-explorer", zh: "按标签查成本", en: "Cost by Tag" },
  { id: "anomaly-inbox", zh: "成本异常", en: "Cost Anomalies" },
] as const;

const ICONS: Record<string, React.ReactNode> = {
  spend: <IconFinOps size={16} />,
  optimization: <IconInvestigate size={16} />,
  progress: <IconReports size={16} />,
  movers: <IconFinOps size={16} />,
  deepdive: <IconInvestigate size={16} />,
  "tag-explorer": <IconFinOps size={16} />,
  "anomaly-inbox": <IconInvestigate size={16} />,
};

export default function FinopsDashboardBrowser({
  data, onAsk, initial = "spend",
}: {
  data?: FinopsData;
  onAsk?: (q: string) => void;
  initial?: string;
}) {
  const { locale } = useLocale();
  const zh = locale !== "en";
  const [sel, setSel] = useState<string>(initial);

  return (
    <div className="notif2">
      {/* 左侧:各仪表盘列表 */}
      <div className="notif-side">
        <div className="notif-side-head">
          <div className="notif-side-title"><IconFinOps size={17} /> {zh ? "成本仪表盘" : "Cost Dashboards"}</div>
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
        <FinopsDashboard dashboardId={sel} onAsk={onAsk} data={data} />
      </div>
    </div>
  );
}
