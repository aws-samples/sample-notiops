import { useEffect, useRef } from "react";
import { useT } from "../i18n";
import type { TimelineStep } from "../thinking";

/**
 * 右侧「思考过程」面板 —— **所有**路径的过程展示（模型思考 + 工具调用/返回摘要）。
 *
 * 2026-09-04 起这是唯一一个过程面板：原来 DevOps Agent 走独立的 InvestigationPanel（标题
 * 「调查过程」、圆点、没有「进行中」脉冲、不自动滚底），普通对话走这个，两边样式行为都不一样。
 * 客户明确要求两个 agent 的过程展示保持一致 → 删掉那个组件，DevOps 的 investigationSteps 映射成
 * TimelineStep 后也进这里（见 ChatApp 的两处 <ThinkingPanel>）。**不要再拆回两个组件。**
 * 复用 Sources 面板的停靠/拖拽/移动端样式（src-* 类）。
 *
 * live=本轮仍在进行 → 顶部一个脉冲点 + 自动滚到底（跟着最新一步走）。用户一旦手动上滚，
 * 就停止自动跟随（isFollowing），避免"想看前面却被拽回底部"。
 * consoleUrl=DevOps Agent 后台深链（只有 DevOps 那条有；这是两条路径唯一的差异，属能力差异不是样式差异）。
 */
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

// 每类过程一个线性图标（与产品"全用线性图标、不用彩色 emoji"的规范一致）。
function StepIcon({ kind }: { kind?: TimelineStep["kind"] }) {
  const p = { viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind === "tool") return <svg {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.1-2.1z" /></svg>;
  if (kind === "result") return <svg {...p}><path d="M20 6 9 17l-5-5" /></svg>;
  // thought / status：一个"想"的气泡
  return <svg {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>;
}

export default function ThinkingPanel({
  open, steps, live = false, width = 380, consoleUrl, onClose,
}: {
  open: boolean; steps: TimelineStep[]; live?: boolean; width?: number; consoleUrl?: string; onClose: () => void;
}) {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true); // 停在底部才自动跟随；用户上滚即停

  // 新一步进来时，若仍在跟随则滚到底。依赖 steps 长度 + 最后一步文本（思考增量会原地变长）。
  const lastLen = steps.length;
  const lastTx = steps[steps.length - 1]?.text || "";
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !open || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [open, lastLen, lastTx]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    // 距底 40px 内算"停在底部"。
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <>
      <div className={"src-overlay" + (open ? " open" : "")} onClick={onClose} />
      <aside className={"src-panel think-panel" + (open ? " open" : "")} style={open ? { width } : undefined}>
        <div className="src-head">
          <span>
            {t("think.panel.title")}
            {live && <span className="think-live"><span className="think-live-dot" />{t("think.panel.live")}</span>}
          </span>
          <button className="panel-btn" onClick={onClose} title={t("panel.close")}><CloseIcon /></button>
        </div>
        {/* DevOps Agent 那条才有：去后台看完整调查。普通思考过程没有这个链接。 */}
        {consoleUrl && (
          <a className="inv-console" href={consoleUrl} target="_blank" rel="noopener noreferrer">
            {t("inv.panel.console")} <ExternalIcon />
          </a>
        )}
        <div ref={bodyRef} className="src-body inv-body" onScroll={onScroll}>
          {steps.length === 0 ? (
            <div className="src-group">{t("think.panel.empty")}</div>
          ) : (
            <div className="inv-timeline">
              {steps.map((s, i) => (
                <div className={"inv-step think-step think-" + (s.kind || "status")} key={i}>
                  <span className="think-ic"><StepIcon kind={s.kind} /></span>
                  <div className="inv-step-tx">
                    {s.text}
                    {s.repeat && s.repeat > 1 && (
                      <span className="think-repeat">{t("think.repeat").replace("{n}", String(s.repeat))}</span>
                    )}
                    {s.detail && <span className="think-detail">{s.detail}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
