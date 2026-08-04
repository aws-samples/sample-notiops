import InvestigationDashboard from "./InvestigationDashboard";
import type { AlarmDashboardData } from "../api/alarms";

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

/** Investigation 告警仪表盘右侧停靠面板（复用 .src-panel 机制，同其它 dashboard 面板）。 */
export default function InvestigationDashboardPanel({
  open, dashboardId, title, width = 460, onClose, data, can, onInvestigate, onNotify,
}: {
  open: boolean;
  dashboardId: string | null;
  title: string;
  width?: number;
  onClose: () => void;
  data?: AlarmDashboardData;
  can?: (key: string) => boolean;
  onInvestigate?: (query: string) => void;
  onNotify?: (query: string) => void;
}) {
  return (
    <>
      <div className={"src-overlay" + (open ? " open" : "")} onClick={onClose} />
      <aside className={"src-panel" + (open ? " open" : "")} style={open ? { width } : undefined}>
        <div className="src-head">
          <span>{title}</span>
          <button className="panel-btn" onClick={onClose} title="close"><CloseIcon /></button>
        </div>
        <div className="src-body" style={{ padding: 0 }}>
          {open && dashboardId && <InvestigationDashboard dashboardId={dashboardId} data={data} can={can} onInvestigate={onInvestigate} onNotify={onNotify} />}
        </div>
      </aside>
    </>
  );
}
