/**
 * FinOps 仪表盘 —— 独立页面（不再是聊天主题的空态区块）。
 *
 * 布局对齐 reference/cost_executive_summary_dashboard_template.html 的 5 个
 * section，视觉上复用项目既有的 --card/--line/--text/--muted/--orange/--green
 * 主题变量（不引入独立配色系统，跟随应用深浅色主题自动切换）：
 *   1. Spend Overview   — Hero 卡（Total Spend + MoM）+ 6 月趋势图（recharts）
 *   2. Cost Breakdown    — Marketplace Spend 卡
 *   3. Commitments       — EDP Commitment Attainment 仪表盘（demo mock）
 *                           + DevOps Agent Credit Usage 卡（真实 CUR/Athena 数据）
 *   4. MoM Movers        — Top Cost Driver / Largest Decrease
 *   5. Ask about costs   — 底部输入框，直接复用聊天 API（不是模板里的假输入框）
 *
 * 数据源：GET /finops/dashboard（见 bff/web-chat/finops.mjs），一次拿齐所有卡片。
 */
import { useEffect, useState } from "react";
import {
  ComposedChart, Area, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  RadialBarChart, RadialBar, PolarAngleAxis,
  PieChart, Pie, Cell,
} from "recharts";
import { useLocale } from "../i18n";
import { getFinopsDashboard, getFinopsDeepDive, getFinopsTagKeys, getFinopsTagValues, getFinopsTagCost, type FinopsDashboard as FinopsDashboardData, type DeepDiveResult, type MoverRow, type TagKeysResult, type TagCostResult } from "../api/finops";
import InboxList from "./InboxList";

interface Props {
  /** 兼容旧调用；landing 输入已改用 Composer，此回调可不传。 */
  onAsk?: (prompt: string) => void;
  /** 传入则进入「单 dashboard 面板」模式，只渲染该组卡片。 */
  dashboardId?: string;
  /** landing 模式下点击缩略卡时回调，打开右侧 dashboard 面板。 */
  onOpenDashboard?: (id: string) => void;
  /** 由 ChatApp 统一拉取并传入的仪表盘数据（landing 与面板共享，避免重复查 Athena）。 */
  data?: FinopsDashboardData;
  /** 能力门禁：判断某 permissionKey 是否可见（未传=全允许，兼容旧调用）。 */
  can?: (key: string) => boolean;
}

const fmtUsd = (n: number | undefined, opts?: Intl.NumberFormatOptions) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0, ...opts }).format(n || 0);
const fmtK = (n: number | undefined) => `$${(n || 0).toFixed(1)}K`;

function SectionTitle({ children, consoleUrl, consoleLabel }: { children: React.ReactNode; consoleUrl?: string; consoleLabel?: string }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8, color: "var(--text)", fontSize: 13, fontWeight: 700,
      textTransform: "uppercase", letterSpacing: ".06em", margin: "14px 0 8px",
    }}>
      <span style={{ width: 3, height: 14, background: "var(--orange)", borderRadius: 2, display: "inline-block" }} />
      {children}
      {consoleUrl && (
        <a href={consoleUrl} target="_blank" rel="noopener noreferrer"
          style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: "var(--blue)", textTransform: "none", letterSpacing: 0, textDecoration: "none" }}>
          {consoleLabel || "Console"} ↗
        </a>
      )}
    </div>
  );
}

function Card({ children, accent, style }: { children: React.ReactNode; accent?: "green" | "red" | "info"; style?: React.CSSProperties }) {
  const accentColor = accent === "green" ? "var(--green)" : accent === "red" ? "#d13212" : accent === "info" ? "var(--blue)" : undefined;
  return (
    <div style={{
      background: "var(--card)", border: "1px solid var(--line)", borderRadius: 11, padding: "12px 14px",
      borderLeft: accentColor ? `3px solid ${accentColor}` : undefined, ...style,
    }}>{children}</div>
  );
}

function Badge({ pct, zh, label }: { pct: number | undefined; zh: boolean; label?: string }) {
  const p = pct ?? 0;
  const arrow = p > 0 ? "▲" : p < 0 ? "▼" : "→";
  const color = p > 0 ? "#d13212" : p < 0 ? "var(--green)" : "var(--muted)";
  const bg = p > 0 ? "rgba(255,107,87,.15)" : p < 0 ? "rgba(0,128,47,.12)" : "rgba(128,128,128,.12)";
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, fontWeight: 700,
      padding: "3px 9px", borderRadius: 100, marginTop: 8, color, background: bg,
    }}>{arrow} {p > 0 ? "+" : ""}{p}% {label ?? (zh ? "环比" : "MoM")}</span>
  );
}

function MoverList({ rows, zh }: { rows: MoverRow[]; zh: boolean }) {
  if (!rows || rows.length === 0) return <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>{zh ? "无" : "None"}</div>;
  return (
    <div style={{ marginTop: 4 }}>
      {rows.map((r) => (
        <div key={r.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "7px 0", borderTop: "1px dashed var(--line)" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
            <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 1 }}>{fmtK(r.priorMonthK)} → {fmtK(r.thisMonthK)}</div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: (r.deltaUsd || 0) > 0 ? "#d13212" : "var(--green)" }}>{(r.deltaUsd || 0) > 0 ? "+" : ""}{fmtUsd(r.deltaUsd)}</div>
            <div style={{ color: "var(--muted)", fontSize: 11 }}>{(r.deltaPct ?? 0) > 0 ? "+" : ""}{r.deltaPct ?? 0}%</div>
          </div>
        </div>
      ))}
    </div>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => (
  <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: ".07em", fontWeight: 600, marginBottom: 6 }}>{children}</div>
);

/**
 * 某个 dashboard 面板对该用户是否可见（group 卡在任一子卡可见时显示）。
 *
 * 导出是为了让 FinopsDashboardBrowser 的左侧列表与本组件的卡片网格用**同一判据** ——
 * 两处各写一份的结果是「侧栏列了个条目、点进去空白」，那是坏体验也是难查的漂移。
 * 未登记的 id 默认可见（如 anomaly-inbox 这类无独立 capability key 的面板）。
 */
export function finopsPanelVisible(id: string, can: (k: string) => boolean): boolean {
  const deepDive = ["cloudwatch", "datatransfer", "ec2", "s3"].some((k) => can(`nav:finops:deep-dive:${k}`));
  return ({
    spend: can("nav:finops:spend-overview") || can("nav:finops:marketplace") || can("nav:finops:top5"),
    optimization: can("nav:finops:potential-savings") || can("nav:finops:anomalies") || can("nav:finops:ri-sp"),
    progress: can("nav:finops:commitment") || can("nav:finops:devops-credit") || can("nav:finops:ai-spend"),
    movers: can("nav:finops:movers"),
    deepdive: deepDive,
    "tag-explorer": can("nav:finops:tag-explorer"),
  } as Record<string, boolean>)[id] ?? true;
}

export default function FinopsDashboard({ dashboardId, onOpenDashboard, data: dataProp, can = () => true, onAsk }: Props) {
  const { locale } = useLocale();
  const zh = locale !== "en";
  const [fetched, setFetched] = useState<FinopsDashboardData | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const data = dataProp ?? fetched;
  const loading = dataProp ? false : loadingState;

  useEffect(() => {
    if (dataProp) return; // 外部已提供数据（ChatApp 统一拉取）→ 不自拉，避免重复查 Athena
    let cancelled = false;
    getFinopsDashboard().then((d) => { if (!cancelled) { setFetched(d); setLoadingState(false); } });
    return () => { cancelled = true; };
  }, [dataProp]);

  const [ddScenario, setDdScenario] = useState<string | null>(null);
  const [ddResult, setDdResult] = useState<DeepDiveResult | null>(null);
  const [ddLoading, setDdLoading] = useState(false);

  // 成本分配标签浏览器：标签键列表(懒加载) / 选中键 / 该键的值 / 选中值 / 成本结果
  const [tagKeys, setTagKeys] = useState<TagKeysResult | null>(null);
  const [tagKeysLoading, setTagKeysLoading] = useState(false);
  const [tagKey, setTagKey] = useState<string>("");
  const [tagValues, setTagValues] = useState<string[]>([]);
  const [tagValue, setTagValue] = useState<string | null>(null); // null=全部值合计
  const [tagCost, setTagCost] = useState<TagCostResult | null>(null);
  const [tagCostLoading, setTagCostLoading] = useState(false);

  // 标签浏览器可见时，懒加载「已激活的成本分配标签键」列表（只加载一次）。
  // 面板模式(dashboardId==='tag-explorer') 或 landing 全量模式(无 dashboardId) 都需要。
  const tagSectionActive = (!dashboardId || dashboardId === "tag-explorer") && can("nav:finops:tag-explorer");
  // 依赖只放 tagSectionActive：若把 tagKeys/tagKeysLoading 放进依赖，setTagKeysLoading(true)
  // 会触发 effect 重跑 → cleanup 先把上一轮的 cancelled 置 true → 在途请求的 .then 里
  // setTagKeysLoading(false) 被跳过 → 永久 loading（竞态）。内部 guard 已足够防重复请求。
  useEffect(() => {
    if (!tagSectionActive || tagKeys !== null || tagKeysLoading) return;
    let cancelled = false;
    setTagKeysLoading(true);
    getFinopsTagKeys().then((r) => { if (!cancelled) { setTagKeys(r); setTagKeysLoading(false); } });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tagSectionActive]);

  // 选标签键 → 拉该键的值列表 + 默认查「全部值合计」的按服务成本。
  function onPickTagKey(k: string) {
    setTagKey(k);
    setTagValue(null);
    setTagValues([]);
    setTagCost(null);
    if (!k) return;
    setTagCostLoading(true);
    getFinopsTagValues(k).then((r) => setTagValues(r.available ? r.tagValues : []));
    getFinopsTagCost(k, null).then((r) => { setTagCost(r); setTagCostLoading(false); });
  }
  // 选具体标签值(或"全部值")→ 重查。valArg: null=全部值合计；字符串(含"")=该值
  function onPickTagValue(valArg: string | null) {
    setTagValue(valArg);
    setTagCost(null);
    setTagCostLoading(true);
    getFinopsTagCost(tagKey, valArg).then((r) => { setTagCost(r); setTagCostLoading(false); });
  }

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", padding: 60 }}>
        <span className="pulsewave" style={{ display: "inline-flex", gap: 2 }}><i /><i /><i /></span>
      </div>
    );
  }
  if (!data) return null;

  const ce = data.costExplorer;
  const spend = ce?.spendTrend;
  const forecast = ce?.forecast;
  const savings = data.potentialSavings;
  const anomalies = ce?.anomalies;
  const coverage = ce?.coverage;
  const topServices = ce?.topServices;
  // 预测月末环比：用「预测月末 vs 上月完整」，避免 MTD-vs-上月的部分月失真
  const forecastEomK = (spend?.available && forecast?.available)
    ? ((spend.totalThisMonthK || 0) * 1000 + (forecast.forecastRemainingUsd || 0)) / 1000
    : null;
  const priorK = spend?.totalPriorMonthK || 0;
  const momEomPct = (forecastEomK != null && priorK > 0) ? Math.round(((forecastEomK - priorK) / priorK) * 1000) / 10 : null;
  const trendRows = spend?.available
    ? (spend.categories ?? []).map((cat, i) => {
        const isCurrent = i === (spend.categories?.length ?? 0) - 1;
        let usage = spend.usage?.[i] ?? 0;
        let marketplace = spend.marketplace?.[i] ?? 0;
        // 当月是 MTD(不完整)，直接画会让曲线尾部掉下去失真。用预测把当月放大到「预测月末」。
        if (isCurrent && forecast?.available && (forecast.forecastRemainingUsd ?? 0) > 0) {
          const mtdK = usage + marketplace;
          const fullK = mtdK + (forecast.forecastRemainingUsd ?? 0) / 1000;
          const scale = mtdK > 0 ? fullK / mtdK : 1;
          usage = Math.round(usage * scale * 10) / 10;
          marketplace = Math.round(marketplace * scale * 10) / 10;
        }
        return { month: isCurrent ? `${cat}*` : cat, usage, marketplace };
      })
    : [];

  const edp = data.edpCommitment;
  const edpGaugeVal = Math.min(edp?.attainmentPct || 0, 100);
  const edpAtt = edp?.attainmentPct || 0;
  const edpExp = edp?.expectedPct || 0;
  // 风险 = 达成 vs 应达成(按合同已过月份数线性)：>=应达成 → 低(绿)；>=应达成×0.72 → 中(橙)；否则高(红)
  const edpRisk = edpExp <= 0 ? "none" : edpAtt >= edpExp ? "low" : edpAtt >= edpExp * 0.72 ? "medium" : "high";
  const edpColor = edpRisk === "high" ? "#d13212" : edpRisk === "medium" ? "#f59e0b" : "var(--green)";

  const aiSpend = ce?.aiSpend;
  const dac = data.devOpsAgentCost;
  const curStatus = data.curStatus;
  const show = (id: string) => dashboardId === id;

  // 能力门禁（Option B：每卡独立 capability key；group 卡在任一子卡可见时显示）
  const DD_SCENARIOS = ["cloudwatch", "datatransfer", "ec2", "s3"];
  const canDeepDive = DD_SCENARIOS.some((k) => can(`nav:finops:deep-dive:${k}`));
  const canTagExplorer = can("nav:finops:tag-explorer");
  const canCard = {
    spendOverview: can("nav:finops:spend-overview"),
    marketplace: can("nav:finops:marketplace"),
    top5: can("nav:finops:top5"),
    savings: can("nav:finops:potential-savings"),
    anomalies: can("nav:finops:anomalies"),
    riSp: can("nav:finops:ri-sp"),
    commitment: can("nav:finops:commitment"),
    devopsCredit: can("nav:finops:devops-credit"),
    aiSpend: can("nav:finops:ai-spend"),
    movers: can("nav:finops:movers"),
  };
  // 与左侧列表同源（见 finopsPanelVisible 的注释）。
  const cardVisible = (id: string): boolean => finopsPanelVisible(id, can);

  return (
    <div style={{ maxWidth: dashboardId ? 1200 : 900, margin: "0 auto", padding: dashboardId ? "4px 14px 20px" : "8px 24px 40px", width: "100%" }}>
      {!dashboardId && (<>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 6 }}>
        {[
          { id: "spend", label: zh ? "支出概览" : "Spend Overview", metric: spend?.available ? fmtK(spend.totalThisMonthK) : "—", sub: zh ? "本月至今" : "MTD" },
          { id: "optimization", label: zh ? "优化与风险" : "Optimization & Risk", metric: savings?.available ? fmtUsd(savings.totalMonthlyUsd) : ((anomalies?.count || 0) > 0 ? String(anomalies?.count) : "—"), sub: savings?.available ? (zh ? "可省/月" : "savings/mo") : (zh ? "异常数" : "anomalies") },
          { id: "progress", label: zh ? "关键进度" : "Key Progress", metric: (dac?.available && dac.usedPct != null) ? `${dac.usedPct}%` : (edp ? `${edp.attainmentPct}%` : "—"), sub: (dac?.available && dac.usedPct != null) ? (zh ? "credit 已用" : "credit used") : (zh ? "承诺达成" : "attainment") },
          { id: "movers", label: zh ? "环比变化" : "MoM Movers", metric: ce?.movers?.topDriver?.name || "—", sub: zh ? "涨幅最大" : "top driver" },
          { id: "deepdive", label: zh ? "成本深挖" : "Cost Deep Dive", metric: zh ? "深挖" : "Explore", sub: zh ? "点开选场景 →" : "pick a scenario →" },
          { id: "tag-explorer", label: zh ? "按标签查成本" : "Cost by Tag", metric: zh ? "标签" : "Tags", sub: zh ? "选成本分配标签 →" : "pick a tag →" },
          { id: "anomaly-inbox", label: zh ? "成本异常" : "Cost Anomalies", metric: zh ? "查看" : "View", sub: zh ? "异常告警收件箱" : "anomaly alerts inbox" },
        ].filter((d) => cardVisible(d.id)).map((d) => (
          <div key={d.id} onClick={() => onOpenDashboard?.(d.id)} role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpenDashboard?.(d.id); }}
            style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px", cursor: "pointer" }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--orange)")}
            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--line)")}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{d.label}</span>
              <span style={{ color: "var(--muted)", fontSize: 16 }}>›</span>
            </div>
            <div style={{ fontSize: d.id === "movers" || d.id === "deepdive" || d.id === "tag-explorer" ? 15 : 22, fontWeight: 800, color: "var(--text)", marginTop: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.metric}</div>
            <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>{d.sub}</div>
          </div>
        ))}
      </div>
      <div style={{ color: "var(--muted)", fontSize: 11.5, margin: "10px 2px 0" }}>{zh ? "点开卡片查看完整仪表盘 →" : "Open a card for the full dashboard →"}</div>
      </>)}

      {show('spend') && cardVisible('spend') && (<>
      {canCard.spendOverview && (<>
      {/* SECTION 1: Spend Overview */}
      <SectionTitle consoleUrl="https://console.aws.amazon.com/cost-management/home#/cost-explorer" consoleLabel={zh ? "在 Cost Explorer 查看" : "View in Cost Explorer"}>{zh ? "支出概览" : "Spend Overview"}</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "1.15fr 2fr", gap: 14 }}>
        <Card style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <Label>{zh ? "AWS 总支出（Usage + Marketplace）" : "Total AWS Spend — Usage + Marketplace"}</Label>
          {spend?.available ? (
            <>
              <div style={{ fontSize: 40, fontWeight: 800, color: "var(--text)", letterSpacing: "-.5px" }}>{fmtK(spend.totalThisMonthK)}</div>
              <div style={{ color: "var(--muted)", fontSize: 11, marginTop: 2 }}>{zh ? "本月至今 (MTD)" : "month-to-date (MTD)"}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                {momEomPct != null && <Badge pct={momEomPct} zh={zh} label={zh ? "预测环比" : "fcst MoM"} />}
                {spend.dailyAvgMomPct != null && <Badge pct={spend.dailyAvgMomPct} zh={zh} label={zh ? "日均环比" : "daily MoM"} />}
              </div>
              <div style={{ display: "flex", gap: 20, marginTop: 12, flexWrap: "wrap" }}>
                <div>
                  <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase" }}>{zh ? "预测月末" : "Forecast EOM"}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{forecast?.available ? fmtK(((spend.totalThisMonthK || 0) * 1000 + (forecast.forecastRemainingUsd || 0)) / 1000) : "—"}</div>
                </div>
                <div>
                  <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase" }}>{zh ? "上月" : "Prior Month"}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{fmtK(spend.totalPriorMonthK)}</div>
                </div>
                <div>
                  <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase" }}>{zh ? "日均" : "Daily Run-rate"}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{fmtUsd(spend.dailyRateUsd)}</div>
                </div>
                <div>
                  <div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase" }}>{zh ? "上月日均" : "Prior Daily"}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{fmtUsd(spend.dailyAvgPriorUsd)}</div>
                </div>
              </div>
              <div style={{ color: "var(--muted)", fontSize: 10.5, marginTop: 10, fontStyle: "italic" }}>
                {zh ? "*不含 support、折扣、税；成本数据约 1–2 天延迟" : "*excludes support, discount, tax; cost data lags ~1–2 days"}
              </div>
            </>
          ) : (
            <div style={{ color: "var(--muted)", fontSize: 12 }}>{zh ? "暂无数据" : "No data available"}</div>
          )}
        </Card>
        <Card>
          <Label>{zh ? "12 个月支出趋势（当月* = 预测月末）" : "12-Month Spend Trend (current month* = forecast EOM)"}</Label>
          {trendRows.length > 0 ? (
            <ResponsiveContainer width="100%" height={210}>
              <ComposedChart data={trendRows}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
                <XAxis dataKey="month" stroke="var(--muted)" tick={{ fill: "var(--muted)", fontSize: 12 }} />
                <YAxis stroke="var(--muted)" tick={{ fill: "var(--muted)", fontSize: 12 }} tickFormatter={(v) => `$${v}K`} />
                <Tooltip
                  contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--text)" }}
                  formatter={(v, name) => [`$${v}K`, name === "usage" ? (zh ? "AWS 用量" : "AWS Usage") : "Marketplace"]}
                />
                <Area type="monotone" dataKey="usage" fill="var(--orange)" fillOpacity={0.15} stroke="var(--orange)" strokeWidth={2.5} />
                <Bar dataKey="marketplace" fill="var(--blue)" radius={[3, 3, 0, 0]} barSize={18} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ color: "var(--muted)", fontSize: 12, padding: "20px 0" }}>{zh ? "暂无数据" : "No data available"}</div>
          )}
        </Card>
      </div>
      </>)}

      {canCard.marketplace && (<>
      {/* SECTION 2: Cost Breakdown */}
      <SectionTitle>{zh ? "成本明细" : "Cost Breakdown"}</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
        <Card>
          <Label>{zh ? "Marketplace 支出" : "Marketplace Spend"}</Label>
          {ce?.marketplace?.available ? (
            <>
              <div style={{ fontSize: 30, fontWeight: 800 }}>{fmtK(ce.marketplace.thisMonthK)}</div>
              <Badge pct={ce.marketplace.deltaPct} zh={zh} />
              <div style={{ display: "flex", gap: 22, marginTop: 12 }}>
                <div><div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase" }}>{zh ? "上月" : "Prior Month"}</div><div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{fmtK(ce.marketplace.priorMonthK)}</div></div>
                <div><div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase" }}>{zh ? "日均" : "Daily"}</div><div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{fmtUsd(ce.marketplace.dailyUsd)}</div></div>
              </div>
            </>
          ) : <div style={{ color: "var(--muted)", fontSize: 12 }}>{zh ? "暂无数据" : "No data available"}</div>}
        </Card>
      </div>
      </>)}
      {canCard.top5 && (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
        <Card>
          <Label>{zh ? "Top 5 服务 · 本月" : "Top 5 Services · MTD"}</Label>
          {topServices?.available && (topServices.top || []).length > 0 ? (
            <div style={{ marginTop: 4, fontSize: 12.5 }}>
              {(topServices.top || []).map((s) => (
                <div key={s.service} style={{ display: "flex", justifyContent: "space-between", marginTop: 4, gap: 8 }}>
                  <span style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.service}</span>
                  <span style={{ fontWeight: 600, flexShrink: 0 }}>{fmtUsd(s.amountUsd)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{zh ? "暂无数据" : "No data"}</div>
          )}
        </Card>
      </div>
      )}
      </>)}

      {show('optimization') && cardVisible('optimization') && (<>
      {/* SECTION: Optimization & Risk */}
      <SectionTitle consoleUrl="https://console.aws.amazon.com/cost-management/home#/cost-optimization-hub" consoleLabel={zh ? "在 Cost Optimization Hub 查看" : "View in Cost Optimization Hub"}>{zh ? "优化与风险" : "Optimization & Risk"}</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {canCard.savings && savings?.available && (
        <Card accent="green">
          <Label>{zh ? "可省成本 · Cost Optimization Hub" : "Potential Savings · COH"}</Label>
            <>
              <div style={{ fontSize: 26, fontWeight: 800, color: "var(--green)" }}>
                {fmtUsd(savings.totalMonthlyUsd)}<span style={{ fontSize: 12, fontWeight: 500, color: "var(--muted)" }}> /{zh ? "月" : "mo"}</span>
              </div>
              <div style={{ marginTop: 8 }}>
                <ResponsiveContainer width="100%" height={140}>
                  <ComposedChart data={(savings.byAction || []).map((a) => ({ action: a.action, savingsUsd: Math.round(a.savingsUsd) }))} layout="vertical" margin={{ left: 4, right: 10 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="action" width={120} tick={{ fill: "var(--muted)", fontSize: 10 }} />
                    <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--text)" }} formatter={(v) => fmtUsd(Number(v))} />
                    <Bar dataKey="savingsUsd" fill="var(--green)" radius={[0, 3, 3, 0]} barSize={12} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </>
        </Card>
        )}

        {canCard.anomalies && (
        <Card accent={(anomalies?.count || 0) > 0 ? "red" : undefined}>
          <Label>{zh ? "成本异常 · 近 30 天" : "Cost Anomalies · 30d"}</Label>
          {anomalies?.available ? (
            (anomalies.count || 0) > 0 ? (
              <>
                <div style={{ fontSize: 26, fontWeight: 800, color: "#d13212" }}>
                  {anomalies.count}<span style={{ fontSize: 12, fontWeight: 500, color: "var(--muted)" }}> {zh ? "个" : "found"}</span>
                </div>
                <div style={{ fontSize: 12.5, marginTop: 4 }}>{zh ? "总影响 " : "Impact "}<b>{fmtUsd(anomalies.totalImpactUsd)}</b></div>
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  {(anomalies.anomalies || []).slice(0, 3).map((a) => (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", marginTop: 3, gap: 8 }}>
                      <span style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.service}</span>
                      <span style={{ fontWeight: 600, flexShrink: 0 }}>{fmtUsd(a.impactUsd)}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: "var(--green)", fontWeight: 600, marginTop: 6 }}>{zh ? "近 30 天无异常" : "No anomalies (30d)"}</div>
            )
          ) : (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{zh ? "未配置异常监控" : "No anomaly monitor"}</div>
          )}
        </Card>
        )}

        {canCard.riSp && (
        <Card accent="info">
          <Label>{zh ? "RI/SP 覆盖率 · 上月" : "RI/SP Coverage · last mo"}</Label>
          {coverage?.available ? (
            <div style={{ marginTop: 4 }}>
              {[{ n: "Savings Plans", v: coverage.spCoveragePct }, { n: "Reserved Inst.", v: coverage.riCoveragePct }].map((c) => (
                <div key={c.n} style={{ marginTop: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                    <span style={{ color: "var(--muted)" }}>{c.n}</span>
                    <span style={{ fontWeight: 700 }}>{c.v != null ? `${c.v}%` : "—"}</span>
                  </div>
                  <div style={{ height: 6, background: "var(--line)", borderRadius: 4, marginTop: 3, overflow: "hidden" }}>
                    <div style={{ width: `${Math.min(c.v || 0, 100)}%`, height: "100%", background: (c.v || 0) >= 80 ? "var(--green)" : (c.v || 0) >= 50 ? "var(--blue)" : "var(--orange)", borderRadius: 4 }} />
                  </div>
                </div>
              ))}
              {coverage.spCoveragePct == null && coverage.riCoveragePct == null && (
                <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 8 }}>{zh ? "无 SP/RI 承诺" : "No SP/RI commitments"}</div>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>{zh ? "暂无数据" : "No data"}</div>
          )}
        </Card>
        )}

      </div>
      </>)}

      {show('progress') && cardVisible('progress') && (<>
      {/* SECTION 3: Commitments & Programs */}
      <SectionTitle consoleUrl="https://console.aws.amazon.com/athena/home?region=us-east-1#/query-editor" consoleLabel={zh ? "在 Athena 查看 SQL" : "View SQL in Athena"}>{zh ? "承诺与项目" : "Commitments & Programs"}</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
        {canCard.commitment && edp && (edp.expectedPct > 0 || (edp.attainmentPct || 0) > 0) && (
        <Card style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ flex: "0 0 140px", height: 120 }}>
            <ResponsiveContainer width="100%" height={120}>
              <RadialBarChart innerRadius="65%" outerRadius="100%" data={[{ value: edpGaugeVal }]} startAngle={90} endAngle={-90}>
                <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
                <RadialBar dataKey="value" fill={edpColor} background={{ fill: "var(--line)" }} cornerRadius={8} />
              </RadialBarChart>
            </ResponsiveContainer>
          </div>
          <div>
            <Label>{zh ? "承诺达成率" : "Commitment Attainment"}</Label>
            <div style={{ fontSize: 28, fontWeight: 800, color: edpColor }}>{edp?.attainmentPct}%</div>
            <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 2 }}>
              {edp?.contractPeriod} · {zh ? "应达成" : "expected"} {(edp?.expectedPct || 0).toFixed(1)}%
            </div>
            <div style={{ marginTop: 6, fontSize: 11.5, fontWeight: 700, color: edpColor }}>
              {edpRisk === "high" ? (zh ? "⚠ 高 shortfall 风险" : "⚠ High shortfall risk") : edpRisk === "medium" ? (zh ? "⚠ 中风险 · 偏慢" : "⚠ Medium risk · behind") : edpRisk === "low" ? (zh ? "✓ 进度健康" : "✓ On track") : "—"}
            </div>
          </div>
        </Card>
        )}
        {canCard.devopsCredit && (
        <Card accent="info">
          <Label>{zh ? "DevOps Agent 调用额度" : "DevOps Agent — Credit Usage"}</Label>
          {curStatus.status === "not_configured" ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>
              {zh ? "未配置 CUR/Athena 数据源。重跑 setup.sh 即可自动配置。" : "CUR/Athena not configured. Re-run setup.sh to set it up."}
            </div>
          ) : curStatus.status === "PENDING" || curStatus.status === "DELAYED" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="pulsewave" style={{ display: "inline-flex", gap: 2 }}><i /><i /><i /></span>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{zh ? "数据初始化中，预计 24 小时后可用" : "Initializing data, ready in ~24h"}</span>
            </div>
          ) : curStatus.status === "FAILED" || curStatus.status === "error" ? (
            <div style={{ fontSize: 12, color: "#d13212" }}>{zh ? "数据源配置失败，请检查后重跑 setup.sh" : "Data source setup failed"}</div>
          ) : !dac?.available ? (
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{dac?.note || (zh ? "查询未就绪，请稍后刷新" : "Not ready — refresh shortly")}</div>
          ) : (() => {
            const allowance = dac.allowanceUsd || 0;
            const used = dac.usedUsd || 0;
            const remaining = allowance - used;
            const pct = dac.usedPct != null ? dac.usedPct : (allowance > 0 ? Math.round((used / allowance) * 1000) / 10 : (used > 0 ? 100 : 0));
            const over = allowance > 0 && used > allowance;
            const usedColor = over ? "#d13212" : "var(--blue)";
            const donut = allowance > 0
              ? [{ n: "used", v: Math.min(used, allowance) }, { n: "remain", v: Math.max(allowance - used, 0) }]
              : (used > 0 ? [{ n: "used", v: 1 }, { n: "remain", v: 0 }] : [{ n: "used", v: 0 }, { n: "remain", v: 1 }]);
            return (
              <>
                <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 4 }}>
                  <div style={{ width: 112, height: 112, position: "relative", flexShrink: 0 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={donut} dataKey="v" innerRadius={36} outerRadius={52} startAngle={90} endAngle={-270} stroke="none" isAnimationActive={false}>
                          <Cell fill={usedColor} />
                          <Cell fill="var(--line)" />
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: over ? "#d13212" : "var(--text)" }}>{pct}%</div>
                      <div style={{ fontSize: 10, color: "var(--muted)" }}>{zh ? "已用" : "used"}</div>
                    </div>
                  </div>
                  <div style={{ flex: 1, fontSize: 12.5 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ color: "var(--muted)" }}>{zh ? "本月 Credit" : "Credit"}</span>
                      <span style={{ fontWeight: 700 }}>{fmtUsd(allowance)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ color: "var(--muted)" }}>{zh ? "已用" : "Used"}</span>
                      <span style={{ fontWeight: 700, color: usedColor }}>{fmtUsd(used)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                      <span style={{ color: "var(--muted)" }}>{zh ? "剩余" : "Remaining"}</span>
                      <span style={{ fontWeight: 700, color: over ? "#d13212" : "var(--green)" }}>{fmtUsd(remaining)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ color: "var(--muted)" }}>{zh ? "用量" : "Usage"}</span>
                      <span style={{ fontWeight: 600 }}>{(dac.totalHours || 0).toFixed(1)}h · {(dac.byAccount || []).length} {zh ? "账号" : "acct"}</span>
                    </div>
                  </div>
                </div>
                <div style={{ color: "var(--muted)", fontSize: 10.5, marginTop: 8 }}>
                  {over ? (zh ? "⚠ 已超本月 Credit · " : "⚠ Over monthly credit · ") : ""}
                  {allowance > 0
                    ? (zh ? "Credit = 档位% × 上月 Support 费，月底过期" : "Credit = tier% × prior-month Support, expires month-end")
                    : (zh ? "上月无付费 Support 计划 → 无 Credit" : "No paid Support last month → no credit")}
                </div>
              </>
            );
          })()}
        </Card>
        )}
        {canCard.aiSpend && (
        <Card accent="info">
          <Label>{zh ? "AI 支出监控 · AgentCore + Bedrock" : "AI Spend · AgentCore + Bedrock"}</Label>
          {aiSpend?.available ? (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <div style={{ fontSize: 28, fontWeight: 800, color: "var(--text)" }}>{fmtUsd(aiSpend.thisMonthUsd)}</div>
                <span style={{ color: "var(--muted)", fontSize: 11 }}>{zh ? "本月至今" : "MTD"}</span>
              </div>
              {(aiSpend.priorMonthUsd || 0) > 0 && <Badge pct={aiSpend.deltaPct} zh={zh} label={zh ? "预测环比" : "fcst MoM"} />}
              <div style={{ display: "flex", gap: 18, marginTop: 10 }}>
                <div><div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase" }}>{zh ? "预测月末" : "Forecast EOM"}</div><div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{fmtUsd(aiSpend.forecastEomUsd)}</div></div>
                <div><div style={{ color: "var(--muted)", fontSize: 11, textTransform: "uppercase" }}>{zh ? "上月" : "Prior"}</div><div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{fmtUsd(aiSpend.priorMonthUsd)}</div></div>
              </div>
              <div style={{ marginTop: 8, fontSize: 12 }}>
                {(aiSpend.components || []).length > 0 ? (aiSpend.components || []).map((c) => (
                  <div key={c.service} style={{ display: "flex", justifyContent: "space-between", marginTop: 3, gap: 8 }}>
                    <span style={{ color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.service}</span>
                    <span style={{ fontWeight: 600, flexShrink: 0 }}>{fmtUsd(c.amountUsd)}</span>
                  </div>
                )) : <div style={{ color: "var(--muted)" }}>{zh ? "本月暂无 AI 支出" : "No AI spend this month"}</div>}
              </div>
              <div style={{ color: "var(--muted)", fontSize: 10.5, marginTop: 8 }}>
                {zh ? "NotiOps 部署后主要新增支出项 · 按日均预测月末" : "main new spend from NotiOps · run-rate forecast"}
              </div>
            </>
          ) : <div style={{ fontSize: 12, color: "var(--muted)" }}>{zh ? "暂无数据" : "No data"}</div>}
        </Card>
        )}
      </div>
      </>)}

      {show('movers') && cardVisible('movers') && (<>
      {/* SECTION 4: MoM Movers（摊销成本口径 + 增/降 Top5 + 净变化） */}
      <SectionTitle consoleUrl="https://console.aws.amazon.com/cost-management/home#/cost-explorer" consoleLabel={zh ? "在 Cost Explorer 查看" : "View in Cost Explorer"}>{zh ? "环比变化 Top" : "Month-over-Month Movers"}</SectionTitle>
      {ce?.movers?.available ? (<>
        <div style={{ color: "var(--muted)", fontSize: 12, margin: "0 2px 10px", display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <span>{zh ? "对比" : "Comparing"} {ce.movers.baselineLabel} → {ce.movers.comparisonLabel} · {zh ? "摊销成本(已时序校正)" : "amortized (timing-corrected)"}</span>
          <span>{zh ? "净变化" : "Net Δ"}: <b style={{ color: (ce.movers.netDeltaUsd ?? 0) > 0 ? "#d13212" : "var(--green)" }}>{(ce.movers.netDeltaUsd ?? 0) > 0 ? "+" : ""}{fmtUsd(ce.movers.netDeltaUsd)}</b></span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14 }}>
          <Card accent="red">
            <Label>{zh ? "涨幅最大 ▲ Top 5" : "Top Increases ▲"}</Label>
            <MoverList rows={ce.movers.increases || []} zh={zh} />
          </Card>
          <Card accent="green">
            <Label>{zh ? "降幅最大 ▼ Top 5" : "Top Decreases ▼"}</Label>
            <MoverList rows={ce.movers.decreases || []} zh={zh} />
          </Card>
        </div>
      </>) : <div style={{ color: "var(--muted)", fontSize: 12 }}>{zh ? "暂无数据" : "No data available"}</div>}
      </>)}

      {show('deepdive') && canDeepDive && (<>
      <SectionTitle consoleUrl="https://console.aws.amazon.com/athena/home?region=us-east-1#/query-editor" consoleLabel={zh ? "SQL 在 Athena" : "SQL in Athena"}>{zh ? "成本深挖" : "Cost Deep Dive"}</SectionTitle>
      <div style={{ color: "var(--muted)", fontSize: 12, margin: "0 2px 10px", lineHeight: 1.5 }}>
        {zh ? "点击场景 → 后台跑 Athena 保存查询(CUR 明细,100% 真实数据)→ AI 出图表 + 洞察,原始数据可下载。" : "Pick a scenario → runs a saved Athena query (real CUR data) → AI chart + insight; download raw data."}
      </div>
      <div style={{ display: "grid", gap: 10 }}>
        {[
          { k: "cloudwatch", t: zh ? "CloudWatch 成本明细" : "CloudWatch cost breakdown", d: zh ? "按用量类型:Logs 摄取/存储、Metrics、API…" : "By usage type: Logs, Metrics, API…" },
          { k: "datatransfer", t: zh ? "数据传输成本明细" : "Data transfer breakdown", d: zh ? "按服务与传输方向" : "By service & direction" },
          { k: "ec2", t: zh ? "EC2 计算成本明细" : "EC2 compute breakdown", d: zh ? "按实例类型/购买方式(按需·RI·SP·Spot)" : "By instance type & purchase option" },
          { k: "s3", t: zh ? "S3 存储成本明细" : "S3 storage breakdown", d: zh ? "按存储类别/用量(Standard·IA·Glacier·请求)" : "By storage class & usage type" },
        ].filter((s) => can(`nav:finops:deep-dive:${s.k}`)).map((s) => (
          <button key={s.k} onClick={() => { setDdScenario(s.k); setDdResult(null); setDdLoading(true); getFinopsDeepDive(s.k).then((r) => { setDdResult(r); setDdLoading(false); }); }}
            style={{ textAlign: "left", background: ddScenario === s.k ? "var(--page)" : "var(--card)", border: `1px solid ${ddScenario === s.k ? "var(--orange)" : "var(--line)"}`, borderRadius: 12, padding: "12px 14px", cursor: "pointer", color: "var(--text)", font: "inherit" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13.5, fontWeight: 700 }}>{s.t}</span>
              <span style={{ color: "var(--muted)", fontSize: 15 }}>{ddScenario === s.k ? "●" : "→"}</span>
            </div>
            <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 4 }}>{s.d}</div>
          </button>
        ))}
      </div>
      {ddLoading && (
        <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
          <span className="pulsewave" style={{ display: "inline-flex", gap: 2 }}><i /><i /><i /></span>
        </div>
      )}
      {!ddLoading && ddResult && (ddResult.available ? (() => {
        const chart = ddResult.chart;
        const vk = chart?.valueKey || "cost_usd";
        const lk = chart?.labelKey || "usage_type";
        const chartRows = (ddResult.rows || []).slice(0, 12).map((r) => ({ ...r, [vk]: Number(r[vk]) || 0 }));
        const PIE = ["var(--orange)", "var(--blue)", "var(--green)", "#d13212", "#8b5cf6", "#0ea5e9", "#f59e0b", "#10b981", "#ec4899", "#64748b", "#14b8a6", "#a3a3a3"];
        const fmtUsd2 = (v: number | string) => "$" + (Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const periodTxt = ddResult.periodLabel ? (zh ? ddResult.periodLabel.zh : ddResult.periodLabel.en) : (zh ? "本月至今 (MTD)" : "Month-to-date (MTD)");
        return (
          <div style={{ marginTop: 12 }}>
            <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px" }}>
              <Label>{chart?.title || ddResult.title}</Label>
              <div style={{ color: "var(--muted)", fontSize: 11, margin: "2px 0 6px" }}>{periodTxt}</div>
              {chartRows.length > 0 ? (
                <ResponsiveContainer width="100%" height={250}>
                  {chart?.type === "pie" ? (
                    <PieChart>
                      <Pie data={chartRows} dataKey={vk} nameKey={lk} innerRadius={45} outerRadius={92} stroke="none">
                        {chartRows.map((_, i) => <Cell key={i} fill={PIE[i % PIE.length]} />)}
                      </Pie>
                      <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--text)" }} formatter={(v) => fmtUsd2(v as number)} />
                    </PieChart>
                  ) : (
                    <ComposedChart data={chartRows} layout="vertical" margin={{ left: 8, right: 16 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                      <XAxis type="number" stroke="var(--muted)" tick={{ fill: "var(--muted)", fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                      <YAxis type="category" dataKey={lk} stroke="var(--muted)" tick={{ fill: "var(--muted)", fontSize: 10 }} width={150} />
                      <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--text)" }} formatter={(v) => fmtUsd2(v as number)} />
                      <Bar dataKey={vk} fill="var(--orange)" radius={[0, 3, 3, 0]} barSize={14} />
                    </ComposedChart>
                  )}
                </ResponsiveContainer>
              ) : <div style={{ color: "var(--muted)", fontSize: 12, padding: "16px 0" }}>{zh ? "该场景本月无数据" : "No data for this scenario this month"}</div>}
            </div>
            {ddResult.insight && (
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderLeft: "3px solid var(--blue)", borderRadius: 10, padding: "10px 12px", marginTop: 10, fontSize: 12.5, lineHeight: 1.6 }}>
                <div style={{ color: "var(--muted)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{zh ? "AI 洞察(请核对)" : "AI insight (verify)"}</div>
                {ddResult.insight}
              </div>
            )}
            {ddResult.recommendations && ddResult.recommendations.length > 0 && (
              <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderLeft: "3px solid var(--green)", borderRadius: 10, padding: "10px 12px", marginTop: 8, fontSize: 12.5, lineHeight: 1.6 }}>
                <div style={{ color: "var(--muted)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{zh ? "优化建议(请核对)" : "Optimization ideas (verify)"}</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {ddResult.recommendations.map((rec, i) => <li key={i} style={{ marginTop: 3 }}>{rec}</li>)}
                </ul>
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, fontSize: 12, gap: 8 }}>
              <span style={{ color: "var(--muted)" }}>{ddResult.rowCount ?? 0} {zh ? "行 · 数值来自 Athena/CUR" : "rows · values from Athena/CUR"}{ddResult.cached ? (zh ? " · 今日缓存" : " · cached today") : ""}</span>
              {ddResult.csvUrl && <a href={ddResult.csvUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--blue)", fontWeight: 600, textDecoration: "none", flexShrink: 0 }}>{zh ? "下载原始数据 CSV ↓" : "Download raw CSV ↓"}</a>}
            </div>
          </div>
        );
      })() : (
        <div style={{ color: "#d13212", fontSize: 12, marginTop: 12 }}>{zh ? "查询失败:" : "Query failed: "}{ddResult.message || ddResult.reason}</div>
      ))}
      </>)}

      {show('tag-explorer') && canTagExplorer && (<>
      <SectionTitle consoleUrl="https://console.aws.amazon.com/cost-management/home#/cost-explorer" consoleLabel={zh ? "在 Cost Explorer" : "in Cost Explorer"}>{zh ? "按成本分配标签查成本" : "Cost by Allocation Tag"}</SectionTitle>
      <div style={{ color: "var(--muted)", fontSize: 12, margin: "0 2px 10px", lineHeight: 1.5 }}>
        {zh
          ? "选一个成本分配标签键(如 Project / Team / Environment) → 只显示打了该标签的成本,按服务分组;可再选具体标签值。口径 UnblendedCost · 本月至今。"
          : "Pick a cost-allocation tag key (e.g. Project / Team / Environment) → shows only that tag's cost, grouped by service; optionally drill into a specific value. UnblendedCost · MTD."}
      </div>
      {tagKeysLoading && (
        <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
          <span className="pulsewave" style={{ display: "inline-flex", gap: 2 }}><i /><i /><i /></span>
        </div>
      )}
      {!tagKeysLoading && tagKeys && !tagKeys.available && (
        <div style={{ color: "var(--muted)", fontSize: 12.5, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px", lineHeight: 1.6 }}>
          {zh ? "暂时读不到成本分配标签。" : "Could not load cost-allocation tags."}{tagKeys.message ? ` (${tagKeys.message})` : ""}
        </div>
      )}
      {!tagKeysLoading && tagKeys && tagKeys.available && tagKeys.tagKeys.length === 0 && (
        <div style={{ color: "var(--muted)", fontSize: 12.5, background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px", lineHeight: 1.6 }}>
          {zh
            ? "没有已激活的成本分配标签。请到「账单控制台 → 成本分配标签」激活标签后,等 24 小时数据回填再来查。"
            : "No activated cost-allocation tags. Activate tags in Billing Console → Cost Allocation Tags, then check back after ~24h of data."}
        </div>
      )}
      {!tagKeysLoading && tagKeys && tagKeys.available && tagKeys.tagKeys.length > 0 && (() => {
        const fmtUsd2 = (v: number | string) => "$" + (Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const valLabel = (v: string) => v === "" ? (zh ? "(未打标签)" : "(untagged)") : v;
        const chartRows = (tagCost?.rows || []).slice(0, 12);
        const periodTxt = tagCost?.periodLabel ? (zh ? tagCost.periodLabel.zh : tagCost.periodLabel.en) : (zh ? "本月至今 (MTD)" : "Month-to-date (MTD)");
        return (
          <div style={{ display: "grid", gap: 10 }}>
            {/* 标签键选择 */}
            <div>
              <Label>{zh ? "标签键" : "Tag key"}</Label>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {tagKeys.tagKeys.map((k) => (
                  <button key={k} onClick={() => onPickTagKey(k)}
                    style={{ background: tagKey === k ? "var(--orange)" : "var(--card)", color: tagKey === k ? "#fff" : "var(--text)", border: `1px solid ${tagKey === k ? "var(--orange)" : "var(--line)"}`, borderRadius: 100, padding: "5px 13px", cursor: "pointer", font: "inherit", fontSize: 12.5, fontWeight: 600 }}>
                    {k}
                  </button>
                ))}
              </div>
            </div>
            {/* 标签值选择（选了键才显示；含"全部值"）*/}
            {tagKey && tagValues.length > 0 && (
              <div>
                <Label>{zh ? "标签值(可选)" : "Tag value (optional)"}</Label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button onClick={() => onPickTagValue(null)}
                    style={{ background: tagValue === null ? "var(--blue)" : "var(--card)", color: tagValue === null ? "#fff" : "var(--text)", border: `1px solid ${tagValue === null ? "var(--blue)" : "var(--line)"}`, borderRadius: 100, padding: "4px 12px", cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: 600 }}>
                    {zh ? "全部值(合计)" : "All values"}
                  </button>
                  {tagValues.map((v) => (
                    <button key={v || "__untagged__"} onClick={() => onPickTagValue(v)}
                      style={{ background: tagValue === v ? "var(--blue)" : "var(--card)", color: tagValue === v ? "#fff" : "var(--text)", border: `1px solid ${tagValue === v ? "var(--blue)" : "var(--line)"}`, borderRadius: 100, padding: "4px 12px", cursor: "pointer", font: "inherit", fontSize: 12, fontWeight: v === "" ? 500 : 600, fontStyle: v === "" ? "italic" : "normal" }}>
                      {valLabel(v)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/* 结果 */}
            {tagCostLoading && (
              <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
                <span className="pulsewave" style={{ display: "inline-flex", gap: 2 }}><i /><i /><i /></span>
              </div>
            )}
            {!tagCostLoading && tagCost && (tagCost.available ? (
              <div>
                <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                    <Label>{tagCost.tagKey}{tagCost.tagValue != null ? ` = ${valLabel(tagCost.tagValue)}` : (zh ? " · 全部值" : " · all values")}</Label>
                    <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text)", whiteSpace: "nowrap" }}>{fmtUsd2(tagCost.totalUsd || 0)}</span>
                  </div>
                  <div style={{ color: "var(--muted)", fontSize: 11, margin: "2px 0 6px" }}>{periodTxt} · {zh ? "按服务" : "by service"} · UnblendedCost</div>
                  {chartRows.length > 0 ? (
                    <ResponsiveContainer width="100%" height={Math.max(160, chartRows.length * 26 + 40)}>
                      <ComposedChart data={chartRows} layout="vertical" margin={{ left: 8, right: 16 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
                        <XAxis type="number" stroke="var(--muted)" tick={{ fill: "var(--muted)", fontSize: 11 }} tickFormatter={(v) => `$${v}`} />
                        <YAxis type="category" dataKey="service" stroke="var(--muted)" tick={{ fill: "var(--muted)", fontSize: 10 }} width={150} />
                        <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, color: "var(--text)" }} formatter={(v) => fmtUsd2(v as number)} />
                        <Bar dataKey="amountUsd" fill="var(--orange)" radius={[0, 3, 3, 0]} barSize={14} />
                      </ComposedChart>
                    </ResponsiveContainer>
                  ) : <div style={{ color: "var(--muted)", fontSize: 12, padding: "16px 0" }}>{zh ? "该标签本月无成本数据" : "No cost for this tag this month"}</div>}
                </div>
                {tagCost.insight && (
                  <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderLeft: "3px solid var(--blue)", borderRadius: 10, padding: "10px 12px", marginTop: 10, fontSize: 12.5, lineHeight: 1.6 }}>
                    <div style={{ color: "var(--muted)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{zh ? "AI 洞察(请核对)" : "AI insight (verify)"}</div>
                    {tagCost.insight}
                  </div>
                )}
                {tagCost.recommendations && tagCost.recommendations.length > 0 && (
                  <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderLeft: "3px solid var(--green)", borderRadius: 10, padding: "10px 12px", marginTop: 8, fontSize: 12.5, lineHeight: 1.6 }}>
                    <div style={{ color: "var(--muted)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>{zh ? "优化建议(请核对)" : "Optimization ideas (verify)"}</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {tagCost.recommendations.map((rec, i) => <li key={i} style={{ marginTop: 3 }}>{rec}</li>)}
                    </ul>
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, fontSize: 12, gap: 8 }}>
                  <span style={{ color: "var(--muted)" }}>{(tagCost.rows || []).length} {zh ? "个服务 · 数值来自 Cost Explorer" : "services · values from Cost Explorer"}{tagCost.cached ? (zh ? " · 今日缓存" : " · cached today") : ""}</span>
                </div>
              </div>
            ) : (
              <div style={{ color: "#d13212", fontSize: 12, marginTop: 4 }}>{zh ? "查询失败:" : "Query failed: "}{tagCost.message || tagCost.reason}</div>
            ))}
            {!tagCostLoading && !tagCost && tagKey === "" && (
              <div style={{ color: "var(--muted)", fontSize: 12, padding: "4px 2px" }}>{zh ? "↑ 选一个标签键开始" : "↑ pick a tag key to start"}</div>
            )}
          </div>
        );
      })()}
      </>)}

      {/* 成本异常收件箱 —— 从通知主题分流(source=Cost Anomaly),与通知主题同源 */}
      {show("anomaly-inbox") && (<>
      <SectionTitle>{zh ? "成本异常告警" : "Cost Anomaly Alerts"}</SectionTitle>
      <InboxList
        sources={["Cost Anomaly", "CostAnomaly", "Cost Anomaly Detection"]}
        onInvestigate={(q) => onAsk?.(q)}
        onAsk={(q) => onAsk?.(q)}
        emptyHint={zh ? "暂无成本异常告警(启用 Cost Anomaly Detection 后异常会推送到这里)。" : "No cost anomaly alerts (enable Cost Anomaly Detection to see them here)."}
      />
      </>)}
    </div>
  );
}
