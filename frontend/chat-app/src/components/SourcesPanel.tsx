import { useT } from "../i18n";
import type { SourceItem } from "../api/chat";

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

// 来源项线条图标（不用彩色 emoji，符合图标规范）。文档 vs 联网用不同图标。
const DocIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h6" />
  </svg>
);
const WebIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
  </svg>
);
// 工具调用来源（透明展示借助了哪个工具/MCP）：扳手图标
const ToolIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L4 17l3 3 5.5-5.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.2-2.2 2.6-2.6Z" />
  </svg>
);
// 模型自身知识来源（未调用外部工具）：芯片图标
const ModelIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <rect x="7" y="7" width="10" height="10" rx="1.5" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
  </svg>
);

export default function SourcesPanel({ open, sources, width = 380, onClose }: { open: boolean; sources: SourceItem[]; width?: number; onClose: () => void }) {
  const t = useT();
  return (
    <>
      {/* 移动端才用遮罩（覆盖式抽屉）；桌面停靠不遮挡，见 CSS。点遮罩关闭。 */}
      <div className={"src-overlay" + (open ? " open" : "")} onClick={onClose} />
      <aside className={"src-panel" + (open ? " open" : "")} style={open ? { width } : undefined}>
        <div className="src-head">
          <span>{t("msg.sources")}</span>
          <button className="panel-btn" onClick={onClose} title={t("panel.close")}><CloseIcon /></button>
        </div>
        <div className="src-body">
          {sources.length === 0 ? (
            <div className="src-group">{t("sources.empty")}</div>
          ) : (
            sources.map((s, i) => {
              const isLink = !!s.detail && /^https?:\/\//i.test(s.detail);
              // 链接来源：标题是可点超链接，副行显示轻量域名。
              // 非链接来源（工具调用）：副行显示 detail 原文（如「awslabs Cost MCP · cost-explorer」），
              // 让客户明确看到用了哪个 MCP/数据源的哪个工具。
              const host = isLink ? (() => { try { return new URL(s.detail!).hostname.replace(/^www\./, ""); } catch { return ""; } })() : "";
              const hasTitle = !!(s.title && s.title.trim() && s.title !== s.detail);
              const subLine = isLink ? host : (hasTitle ? s.detail : "");
              return (
                <div className="src-item" key={i}>
                  <span className="src-ic">{s.icon === "web" ? <WebIcon /> : s.icon === "tool" ? <ToolIcon /> : s.icon === "model" ? <ModelIcon /> : <DocIcon />}</span>
                  <span className="src-tx">
                    {hasTitle ? (
                      isLink
                        ? <a className="st st-link" href={s.detail} target="_blank" rel="noopener noreferrer">{s.title}</a>
                        : <div className="st">{s.title}</div>
                    ) : (
                      // 无标题：URL 本身作为可点标题
                      isLink
                        ? <a className="st st-link" href={s.detail} target="_blank" rel="noopener noreferrer">{s.detail}</a>
                        : <div className="st">{s.detail || s.title}</div>
                    )}
                    {/* 副行：链接来源显示域名；工具来源显示「提供方 · 工具名」 */}
                    {subLine && <div className="sd-host">{subLine}</div>}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </aside>
    </>
  );
}
