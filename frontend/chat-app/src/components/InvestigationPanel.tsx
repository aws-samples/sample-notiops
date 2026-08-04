import { useT } from "../i18n";
import type { InvestigationStep } from "../api/chat";

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);
const ExternalIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14 21 3" />
  </svg>
);

/**
 * 右侧「调查过程」面板 —— DevOps Agent 深度调查的分析过程(Observation/Finding 等)实时流。
 * 复用 Sources 面板的停靠/拖拽/移动端样式(src-* 类)。主聊天只留结论(root cause+报告+按钮),
 * 过程走这里,让主页面干净。console_url 在顶部给"去 DevOps Agent 后台"深链。
 */
export default function InvestigationPanel({
  open, steps, consoleUrl, width = 380, onClose,
}: {
  open: boolean; steps: InvestigationStep[]; consoleUrl?: string; width?: number; onClose: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className={"src-overlay" + (open ? " open" : "")} onClick={onClose} />
      <aside className={"src-panel inv-panel" + (open ? " open" : "")} style={open ? { width } : undefined}>
        <div className="src-head">
          <span>{t("inv.panel.title")}</span>
          <button className="panel-btn" onClick={onClose} title={t("panel.close")}><CloseIcon /></button>
        </div>
        {consoleUrl && (
          <a className="inv-console" href={consoleUrl} target="_blank" rel="noopener noreferrer">
            {t("inv.panel.console")} <ExternalIcon />
          </a>
        )}
        <div className="src-body inv-body">
          {steps.length === 0 ? (
            <div className="src-group">{t("inv.panel.empty")}</div>
          ) : (
            <div className="inv-timeline">
              {steps.map((s, i) => (
                <div className="inv-step" key={i}>
                  <span className="inv-dot" />
                  <div className="inv-step-tx">{s.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
