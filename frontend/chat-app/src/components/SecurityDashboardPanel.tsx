import SecurityDashboard from "./SecurityDashboard";
import type { SecurityDashboardData } from "../api/security";

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

/** Security dashboard 右侧停靠面板（复用 .src-panel 停靠/拖宽/关闭机制，同 Finops/CasesDashboardPanel）。 */
export default function SecurityDashboardPanel({
  open, dashboardId, title, width = 460, onClose, data, can,
}: {
  open: boolean;
  dashboardId: string | null;
  title: string;
  width?: number;
  onClose: () => void;
  data?: SecurityDashboardData;
  can?: (key: string) => boolean;
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
          {open && dashboardId && <SecurityDashboard dashboardId={dashboardId} data={data} can={can} />}
        </div>
      </aside>
    </>
  );
}
