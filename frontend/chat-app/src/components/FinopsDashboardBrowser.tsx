import { useState } from "react";
import { useLocale } from "../i18n";
import FinopsDashboard, { finopsPanelVisible } from "./FinopsDashboard";
import CurDashboard from "./CurDashboard";
import type { FinopsDashboard as FinopsData } from "../api/finops";
import { IconFinOps, IconReports, IconInvestigate } from "./icons";

/**
 * FinOps 仪表盘「两栏浏览器」—— 仿「通知」主题:左侧列各仪表盘,右侧显示选中项的完整内容。
 * 复用 NotificationsPanel 的 .notif2 / .notif-side / .notif-content 样式(团队一致),
 * 右侧内容直接委托给 FinopsDashboard 的「单 dashboard 模式」(传 dashboardId),零卡片重复。
 *
 * 左侧列表的可见性有两条**不同**的判据，别混：
 *   · 无 cap 的条目 → finopsPanelVisible(权限)，与 landing 卡片网格同源；
 *   · 带 cap 的条目（客户 CUR 四个 sheet）→ hasCapNode(数据源 + 权限)，不对 admin fail-open。
 * 后者的理由见下面 CUR_* 条目的注释。
 */
const DASHBOARDS = [
  { id: "spend", zh: "支出概览", en: "Spend Overview" },
  // 客户 CUR 四个 sheet：依赖客户自建的 cost-agent MCP 数据源（BFF 的 COST_AGENT_MCP_URL）。
  // cap 指向能力节点；该节点在数据源未配置时被服务端从能力树里摘掉（authz.mjs 的 requiresEnv），
  // 所以这里用 hasCapNode 判定 —— 不能用 can()，因为 can() 对 admin fail-open，
  // 那会让管理员看到四个「数据源未配置」的空 tab。
  { id: "cur-trend", zh: "费用趋势（CUR）", en: "Cost Trend (CUR)", cap: "nav:finops:cur-trend" },
  { id: "cur-credit", zh: "Credit（CUR）", en: "Credits (CUR)", cap: "nav:finops:cur-credit" },
  { id: "cur-es", zh: "扩展支持（CUR）", en: "Extended Support (CUR)", cap: "nav:finops:cur-es" },
  { id: "cur-sp", zh: "Savings Plans（CUR）", en: "Savings Plans (CUR)", cap: "nav:finops:cur-sp" },
  { id: "optimization", zh: "优化与风险", en: "Optimization & Risk" },
  { id: "progress", zh: "关键进度", en: "Key Progress" },
  { id: "movers", zh: "环比变化", en: "MoM Movers" },
  { id: "deepdive", zh: "成本深挖", en: "Cost Deep Dive" },
  { id: "tag-explorer", zh: "按标签查成本", en: "Cost by Tag" },
  { id: "anomaly-inbox", zh: "成本异常", en: "Cost Anomalies" },
] as const;

const ICONS: Record<string, React.ReactNode> = {
  spend: <IconFinOps size={16} />,
  "cur-trend": <IconFinOps size={16} />,
  "cur-credit": <IconFinOps size={16} />,
  "cur-es": <IconFinOps size={16} />,
  "cur-sp": <IconFinOps size={16} />,
  optimization: <IconInvestigate size={16} />,
  progress: <IconReports size={16} />,
  movers: <IconFinOps size={16} />,
  deepdive: <IconInvestigate size={16} />,
  "tag-explorer": <IconFinOps size={16} />,
  "anomaly-inbox": <IconInvestigate size={16} />,
};

export default function FinopsDashboardBrowser({
  data, onAsk, initial = "spend", can = () => true, hasCapNode = () => false,
}: {
  data?: FinopsData;
  onAsk?: (q: string) => void;
  initial?: string;
  /** 权限判定（与 ChatApp 的 can 同一个：对 admin / 能力加载失败 fail-open）。 */
  can?: (key: string) => boolean;
  /** 服务端能力树里是否真有这个节点（权限 + 数据源双满足，不 fail-open）。 */
  hasCapNode?: (key: string) => boolean;
}) {
  const { locale } = useLocale();
  const zh = locale !== "en";
  const [sel, setSel] = useState<string>(initial);

  const visible = DASHBOARDS.filter((d) =>
    "cap" in d && d.cap ? hasCapNode(d.cap) : finopsPanelVisible(d.id, can));
  // 选中项不可见（如 / 命令直接跳到未配置的 CUR sheet）→ 落到第一个可见项，
  // 而不是渲染一个空白右栏。
  const effSel = visible.some((d) => d.id === sel) ? sel : (visible[0]?.id ?? "");

  return (
    <div className="notif2">
      {/* 左侧:各仪表盘列表 */}
      <div className="notif-side">
        <div className="notif-side-head">
          <div className="notif-side-title"><IconFinOps size={17} /> {zh ? "成本仪表盘" : "Cost Dashboards"}</div>
        </div>
        <div className="notif-side-group">{zh ? "仪表盘" : "Dashboards"}</div>
        {visible.map((d) => (
          <button key={d.id} className={"notif-navitem" + (effSel === d.id ? " active" : "")} onClick={() => setSel(d.id)}>
            <span className="notif-navic">{ICONS[d.id]}</span>
            <span className="notif-navlabel">{zh ? d.zh : d.en}</span>
          </button>
        ))}
      </div>

      {/* 右侧:选中仪表盘的完整内容（cur-* 走客户 CUR 仪表盘，其余走原有 FinopsDashboard） */}
      <div className="notif-content">
        {!effSel ? (
          <div style={{ padding: 24, color: "var(--muted)" }}>
            {zh ? "当前账号没有可见的成本仪表盘。" : "No cost dashboards are available for your account."}
          </div>
        ) : effSel.startsWith("cur-") ? <CurDashboard sheet={effSel} /> :
        <FinopsDashboard dashboardId={effSel} onAsk={onAsk} data={data} can={can} />}
      </div>
    </div>
  );
}
