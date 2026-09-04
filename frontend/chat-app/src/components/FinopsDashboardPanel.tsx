import FinopsDashboard from "./FinopsDashboard";
import type { FinopsDashboard as FinopsData } from "../api/finops";

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

/**
 * FinOps dashboard 右侧停靠面板。复用 SourcesPanel/ThinkingPanel 的 .src-panel
 * 停靠 + 可拖宽 + 可关机制（团队一致）。内部直接复用 FinopsDashboard 组件的
 * 「单 dashboard 面板」模式（传 dashboardId），零卡片代码重复。关闭只关面板。
 */
export default function FinopsDashboardPanel({
  open, dashboardId, title, width = 460, onClose, onAsk, data, can,
}: {
  open: boolean;
  dashboardId: string | null;
  title: string;
  width?: number;
  onClose: () => void;
  onAsk: (q: string) => void;
  data?: FinopsData;
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
          {open && dashboardId && <FinopsDashboard dashboardId={dashboardId} onAsk={onAsk} data={data} can={can} />}
        </div>
      </aside>
    </>
  );
}
