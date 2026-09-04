/**
 * 客户 CUR 仪表盘 —— 4 个 sheet（费用趋势/Credit/扩展支持/Savings Plans）。
 *
 * 视觉对齐字节 QuickSight Dashboard：每行一张图、X 轴=日期、彩色堆叠柱、右侧图例、
 * 柱顶标总额；复用项目 CSS 变量做暗色主题。
 * 数据：BFF /cur-dash/*（当天缓存）→ cost-agent MCP Lambda → 客户 CUR（窗口 T-33 ~ T-3，封窗防未出全）。
 * 交叉筛选（费用趋势 sheet）：点图例或柱段选中维度值 → 三图联动过滤，前端内存完成。
 *
 * 双语：所有面向用户的字符串走 STR(zh)（见下），包括图表标题、表头、以及 recharts
 * 图例/tooltip 里的系列名 —— 系列名用 `name` 属性给，dataKey 一律保持 ASCII，
 * 避免"图例是中文、数据键也是中文"那种改一处漏一处的耦合。
 */
import { useEffect, useMemo, useState } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend, LabelList,
} from "recharts";
import { useLocale } from "../i18n";
import {
  getCube, getCredit, getExtendedSupport, getSavingsPlans,
  type CubeRow, type CreditData, type EsData, type SpData,
} from "../api/curdash";

/* QS 风格调色板（近似截图配色：橙/绿/红/蓝/紫/粉循环） */
const PALETTE = ["#e8710a", "#2ca02c", "#e64a4a", "#1f77b4", "#9467bd", "#e377c2",
  "#17becf", "#bcbd22", "#ff9900", "#8c564b", "#4ade80", "#f472b6", "#60a5fa", "#facc15"];

/** 本仪表盘的全部用户可见文案。新增文案一律加在这里，两种语言都要给。 */
function STR(zh: boolean) {
  return {
    asOf: (ts: string, cached?: boolean) =>
      zh ? `数据截至 ${ts} UTC${cached ? "（缓存）" : ""}` : `As of ${ts} UTC${cached ? " (cached)" : ""}`,
    to: zh ? "至" : "to",
    // 数据源缺席/故障时的唯一文案：说清是「哪一层」不可用 + **还能怎么问到答案**
    // （对话里问成本会自动降级到 Cost Explorer 口径）。不要只丢一个错误码给客户。
    srcNotice: (reason: string) =>
      reason === "not-configured"
        ? (zh
          ? "本部署没有接入客户 CUR 数据源，因此没有行级明细看板。成本问题可以直接在对话里问我 —— 会用 Cost Explorer 口径回答。"
          : "This deployment has no customer-CUR data source, so the line-item sheets are unavailable. You can still ask cost questions in chat — they are answered from Cost Explorer.")
        : (zh
          ? `客户 CUR 数据源暂时不可用（${reason}），稍后重试即可。这期间成本问题照样可以在对话里问我 —— 会自动改用 Cost Explorer 口径回答（聚合口径，可能与账单对不齐）。`
          : `The customer-CUR data source is temporarily unavailable (${reason}). Retry later. In the meantime you can ask cost questions in chat — they fall back to Cost Explorer (aggregate scope, may not reconcile with the invoice).`),
    filteredBy: (v: string) => (zh ? `已筛选：${v}（点图例取消）` : `Filtered: ${v} (click legend to clear)`),
    windowHint: zh ? "（默认 T-33 ~ T-3，最近 3 天账单未出全）"
      : "(default T-33 to T-3; the last 3 days are not fully billed)",
    filteredTotal: zh ? "筛选后合计" : "Filtered total",
    grandTotal: zh ? "全量合计" : "Total",
    clearFilters: zh ? "清除全部筛选" : "Clear all filters",
    crossFilter: zh ? "（点图例交叉筛选）" : " (click legend to cross-filter)",
    creditTotal: (n: number | string) => (zh ? `区间 Credit 总额（${n} 笔）` : `Credits in range (${n} items)`),
    creditDaily: zh ? "credit（按日 × 服务）" : "Credits (daily x service)",
    creditDetails: zh ? "credit 明细（Top 30，按金额绝对值）" : "Credit details (Top 30 by absolute amount)",
    creditCols: zh ? ["日期", "Payer", "账号", "描述", "金额"] : ["Date", "Payer", "Account", "Description", "Amount"],
    esTotal: zh ? "区间扩展支持总费用" : "Extended support total in range",
    esPrefix: zh ? "扩展支持" : "Extended Support",
    instances: zh ? "实例数量" : "Instances",
    spUtilInRange: (pct: string) => (zh ? `区间利用率 ${pct}%` : `Utilization in range ${pct}%`),
    spWasteInRange: (v: string) => (zh ? `区间浪费 ${v}` : `Waste in range ${v}`),
    spDetails: zh ? "Savings Plans（合同明细，按浪费额排序 Top 50）"
      : "Savings Plans (commitments, Top 50 by waste)",
    spCols: zh
      ? ["Payer", "Account", "Region", "机型族", "时承诺", "购买vCPU", "付款", "期限", "生效", "到期", "剩余天", "利用率%", "浪费"]
      : ["Payer", "Account", "Region", "Family", "Hourly commit", "vCPU purchased", "Payment", "Term", "Start", "End", "Days left", "Util %", "Waste"],
    utilization: zh ? "利用率" : "Utilization",
    coverage: zh ? "覆盖率" : "Coverage",
    spUtilCost: zh ? "SP利用率 - 费用" : "SP Utilization - Cost",
    spCovCost: zh ? "SP覆盖率 - 费用" : "SP Coverage - Cost",
    spUtilVcpu: zh ? "SP利用率 - vCPU" : "SP Utilization - vCPU",
    spCovVcpu: zh ? "SP覆盖率 - vCPU" : "SP Coverage - vCPU",
    spWasteCost: zh ? "SP浪费 - 费用（按 usage_type）" : "SP Waste - Cost (by usage_type)",
    spWasteVcpu: zh ? "SP浪费 - vCPU（按 usage_type）" : "SP Waste - vCPU (by usage_type)",
  };
}
type Str = ReturnType<typeof STR>;

const fmtUsd = (v: number) =>
  Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;
const fmtN = (v: number) => (Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v)));

const card: React.CSSProperties = {
  background: "var(--card)", border: "1px solid var(--line)", borderRadius: 10, padding: "14px 16px", marginBottom: 14,
};
const h3: React.CSSProperties = { margin: "0 0 10px", fontSize: 14, fontWeight: 600, color: "var(--text)" };
const sub: React.CSSProperties = { fontSize: 11, color: "var(--muted)" };

/** 各 sheet 共用的首屏三态：加载中 / 数据源未接 / 端点报错。 */
const Loading = () => <div style={{ ...card, textAlign: "center", padding: 60 }}><span className="pulsewave" /></div>;
const Notice = ({ text }: { text: string }) => <div style={{ ...card, color: "var(--muted)" }}>{text}</div>;

function AsOf({ asOf, cached, s }: { asOf?: string; cached?: boolean; s: Str }) {
  if (!asOf) return null;
  return <span style={sub}>{s.asOf(asOf.slice(0, 16).replace("T", " "), cached)}</span>;
}

function isoDaysAgo(n: number) {
  // 北京时间（UTC+8）基准，与 BFF 缓存 key/预热窗口对齐
  return new Date(Date.now() + (8 * 3600 - n * 86400) * 1000).toISOString().slice(0, 10);
}

const dateInput: React.CSSProperties = {
  background: "var(--card)", color: "var(--text)", border: "1px solid var(--line)",
  borderRadius: 6, padding: "3px 8px", fontSize: 12, colorScheme: "dark",
};

/* 统一时间筛选：精确到天，默认 T-33 ~ T-3（最近 3 天 CUR 未出全） */
function DateRange({ from, to, onFrom, onTo, s }: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void; s: Str }) {
  return (
    <>
      <input type="date" value={from} max={to} onChange={(e) => onFrom(e.target.value)} style={dateInput} />
      <span style={sub}>{s.to}</span>
      <input type="date" value={to} min={from} max={isoDaysAgo(3)} onChange={(e) => onTo(e.target.value)} style={dateInput} />
    </>
  );
}

/* ═══ 通用：QS 风格「日期 × 维度」堆叠柱（一行一图，右侧图例，柱顶总额） ═══ */
interface StackedProps {
  title: string;
  rows: { d: string; key: string; value: number }[];  // 明细三元组
  money?: boolean;                                     // 金额格式 vs 数量格式
  topN?: number;                                       // 图例保留 TopN，其余合并 Other
  selected?: string | null;                            // 交叉筛选选中值
  onSelect?: (v: string | null) => void;
  xTop?: boolean;                                      // 全负值图（credit）：0 线在图顶，X 轴贴 0 线
}
function StackedDaily({ title, rows, money = true, topN = 10, selected, onSelect, xTop = false }: StackedProps) {
  const { locale } = useLocale();
  const s = STR(locale !== "en");
  const { data, keys, step } = useMemo(() => {
    const sumByKey = new Map<string, number>();
    for (const r of rows) sumByKey.set(r.key, (sumByKey.get(r.key) || 0) + Math.abs(r.value));
    const top = [...sumByKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([k]) => k);
    const topSet = new Set(top);
    const byDay = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const k = topSet.has(r.key) ? r.key : "Other";
      if (!byDay.has(r.d)) byDay.set(r.d, {});
      const rec = byDay.get(r.d)!;
      rec[k] = (rec[k] || 0) + r.value;
    }
    const keys = [...top, ...(rows.some((r) => !topSet.has(r.key)) ? ["Other"] : [])];
    const data = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([d, rec], i) => ({ d: d.slice(5), ...rec, __total: Object.values(rec).reduce((s, v) => s + v, 0), __i: i }));
    // 柱顶总额抽稀：点多时隔根标注，防遮挡
    const step = data.length > 24 ? 3 : data.length > 12 ? 2 : 1;
    return { data, keys, step };
  }, [rows, topN]);

  const fmt = money ? fmtUsd : fmtN;
  return (
    <div style={card}>
      <div style={h3}>{title}{selected ? <span style={{ ...sub, marginLeft: 8 }}>{s.filteredBy(selected)}</span> : null}</div>
      <ResponsiveContainer width="100%" height={320}>
        <BarChart data={data} margin={xTop ? { top: 8, left: 8, right: 8, bottom: 24 } : { top: 18, left: 8, right: 8, bottom: 40 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" vertical={false} />
          <XAxis dataKey="d" fontSize={10} tick={{ fill: "var(--muted)" }} angle={-40} textAnchor={xTop ? "start" : "end"} interval={0} height={52} orientation={xTop ? "top" : "bottom"} />
          <YAxis fontSize={11} tick={{ fill: "var(--muted)" }} tickFormatter={fmt} domain={["auto", "auto"]} />
          <Tooltip formatter={(v, name) => [fmt(Number(v)), String(name)]}
            contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", fontSize: 12 }} />
          <Legend layout="vertical" align="right" verticalAlign="top"
            wrapperStyle={{ fontSize: 11, maxHeight: 280, overflowY: "auto", paddingLeft: 12, cursor: onSelect ? "pointer" : "default" }}
            onClick={onSelect ? ((e: { value?: string | number }) => { const v = String(e?.value ?? ""); onSelect(selected === v ? null : v); }) : undefined} />
          {keys.map((k, i) => (
            <Bar key={k} dataKey={k} stackId="s" fill={PALETTE[i % PALETTE.length]}
              opacity={selected && selected !== k ? 0.25 : 0.9}>
              {i === keys.length - 1 && (
                <LabelList dataKey="__total" position="top"
                  content={(props) => {
                    const { x, y, width, height, index, value } = props as { x?: number; y?: number; width?: number; height?: number; index?: number; value?: number };
                    if (index == null || index % step !== 0 || value == null) return null;
                    const neg = Number(value) < 0;
                    return <text x={(x ?? 0) + (width ?? 0) / 2} y={neg ? (y ?? 0) + (height ?? 0) + 12 : (y ?? 0) - 4} textAnchor="middle"
                      fontSize={9} fill="var(--muted)">{fmt(Number(value))}</text>;
                  }} />
              )}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ═══════════ Sheet 1：费用趋势（交叉筛选，三图各一行） ═══════════ */

function TrendSheet() {
  const { locale } = useLocale();
  const s = STR(locale !== "en");
  const [from, setFrom] = useState(isoDaysAgo(33));
  const [to, setTo] = useState(isoDaysAgo(3));
  const [rows, setRows] = useState<CubeRow[]>([]);
  const [meta, setMeta] = useState<{ asOf?: string; cached?: boolean; available?: boolean; reason?: string; from?: string; to?: string }>({});
  const [loading, setLoading] = useState(true);
  const [selSvc, setSelSvc] = useState<string | null>(null);
  const [selRegion, setSelRegion] = useState<string | null>(null);
  const [selAccount, setSelAccount] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    getCube(30, from, to).then(({ raw, rows }) => {
      setRows(rows);
      setMeta({ asOf: raw.asOf, cached: raw.cached, available: raw.available, reason: raw.reason, from: raw.from, to: raw.to });
      setLoading(false);
    });
  }, [from, to]);

  const filtered = useMemo(() => rows.filter((r) =>
    (!selSvc || r.svc === selSvc) && (!selRegion || r.region === selRegion) && (!selAccount || r.account === selAccount)
  ), [rows, selSvc, selRegion, selAccount]);

  const total = useMemo(() => filtered.reduce((s, r) => s + r.cost, 0), [filtered]);
  const anyFilter = selSvc || selRegion || selAccount;

  const svcRows = useMemo(() => filtered.map((r) => ({ d: r.d, key: r.svc, value: r.cost })), [filtered]);
  const regionRows = useMemo(() => filtered.map((r) => ({ d: r.d, key: r.region, value: r.cost })), [filtered]);
  const accountRows = useMemo(() => filtered.map((r) => ({ d: r.d, key: r.account, value: r.cost })), [filtered]);

  if (loading) return <Loading />;
  if (!meta.available) return <Notice text={s.srcNotice(meta.reason || "unknown")} />;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
        <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} s={s} />
        <span style={sub}>{s.windowHint}</span>
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{fmtUsd(total)}</span>
        <span style={sub}>{anyFilter ? s.filteredTotal : s.grandTotal}</span>
        {anyFilter && (
          <button onClick={() => { setSelSvc(null); setSelRegion(null); setSelAccount(null); }}
            style={{ background: "none", border: "1px solid var(--line)", color: "var(--blue)", borderRadius: 6, padding: "2px 10px", fontSize: 12, cursor: "pointer" }}>
            {s.clearFilters}
          </button>
        )}
        <AsOf asOf={meta.asOf} cached={meta.cached} s={s} />
      </div>
      <StackedDaily title={`Cost - Service${s.crossFilter}`} rows={svcRows} selected={selSvc} onSelect={setSelSvc} />
      <StackedDaily title={`Cost - Region${s.crossFilter}`} rows={regionRows} selected={selRegion} onSelect={setSelRegion} />
      <StackedDaily title={`Cost - Account${s.crossFilter}`} rows={accountRows} selected={selAccount} onSelect={setSelAccount} topN={12} />
    </div>
  );
}

/* ═══════════ Sheet 2：Credit ═══════════ */

function CreditSheet() {
  const { locale } = useLocale();
  const s = STR(locale !== "en");
  const [from, setFrom] = useState(isoDaysAgo(33));
  const [to, setTo] = useState(isoDaysAgo(3));
  const [data, setData] = useState<(CreditData & { daily_by_service?: { d: string; svc: string; amount: string }[] }) | null>(null);
  useEffect(() => { setData(null); getCredit(from, to).then(setData as (d: CreditData) => void); }, [from, to]);

  if (!data) return <Loading />;
  if (!data.available) return <Notice text={s.srcNotice(data.reason || "unknown")} />;
  const total = Number(data.summary?.[0]?.amount ?? 0);
  const rows = data.details_top30 || [];
  const dailyRows = (data.daily_by_service || []).map((r) => ({ d: r.d, key: r.svc, value: Number(r.amount) }));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} s={s} />
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--green)" }}>{fmtUsd(Math.abs(total))}</span>
        <span style={sub}>{s.creditTotal(data.distinct_items || rows.length)}</span>
        <AsOf asOf={data.asOf} s={s} />
      </div>
      <StackedDaily title={s.creditDaily} rows={dailyRows} xTop />
      <div style={card}>
        <div style={h3}>{s.creditDetails}</div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead><tr style={{ color: "var(--muted)", textAlign: "left" }}>
              {s.creditCols.map((h, i) => (
                <th key={h} style={i === 0 ? { padding: "6px 8px" } : i === s.creditCols.length - 1 ? { textAlign: "right" } : undefined}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--line)", color: "var(--text)" }}>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{r.usage_date}</td>
                  <td>{r.payer}</td><td>{r.account}</td>
                  <td style={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={r.description}>{r.description}</td>
                  <td style={{ textAlign: "right", color: "var(--green)", whiteSpace: "nowrap" }}>{fmtUsd(Number(r.amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ═══════════ Sheet 3：扩展支持（对齐 QS 4 图：UsageType×2 + Service×2，全部日粒度堆叠） ═══════════ */

function EsSheet() {
  const { locale } = useLocale();
  const s = STR(locale !== "en");
  const [from, setFrom] = useState(isoDaysAgo(33));
  const [to, setTo] = useState(isoDaysAgo(3));
  const [data, setData] = useState<(EsData & { daily?: { d: string; usage_type: string; service: string; cost: string; instances: string }[] }) | null>(null);
  useEffect(() => { setData(null); getExtendedSupport(from, to).then(setData as (d: EsData) => void); }, [from, to]);

  if (!data) return <Loading />;
  if (!data.available) return <Notice text={s.srcNotice(data.reason || "unknown")} />;
  const daily = data.daily || [];
  const short = (u: string) => u.replace("ExtendedSupport:", "").replace("AmazonEKS-Hours:", "EKS:");
  const utCost = daily.map((r) => ({ d: r.d, key: short(r.usage_type), value: Number(r.cost) }));
  const utInst = daily.map((r) => ({ d: r.d, key: short(r.usage_type), value: Number(r.instances) }));
  const svcCost = daily.map((r) => ({ d: r.d, key: r.service, value: Number(r.cost) }));
  const svcInst = daily.map((r) => ({ d: r.d, key: r.service, value: Number(r.instances) }));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} s={s} />
        <span style={{ fontSize: 15, fontWeight: 700, color: "var(--orange)" }}>{fmtUsd(Number(data.total || 0))}</span>
        <span style={sub}>{s.esTotal}</span>
        <AsOf asOf={data.asOf} s={s} />
      </div>
      <StackedDaily title={`${s.esPrefix} - Usage Type - Cost`} rows={utCost} />
      <StackedDaily title={`${s.esPrefix} - Usage Type - ${s.instances}`} rows={utInst} money={false} />
      <StackedDaily title={`${s.esPrefix} - Service - Cost`} rows={svcCost} />
      <StackedDaily title={`${s.esPrefix} - Service - ${s.instances}`} rows={svcInst} money={false} />
    </div>
  );
}

/* ═══════════ Sheet 4：Savings Plans（对齐 QS Dashboard 7 元素，一行一图） ═══════════ */

/** 百分比折线。dataKey 固定 "v"（ASCII），系列名走 `name` → 图例/tooltip 显示本地化文案。 */
function SpLine({ title, label, data, color }: { title: string; label: string; data: { d: string; v: number }[]; color: string }) {
  return (
    <div style={card}>
      <div style={h3}>{title}</div>
      <ResponsiveContainer width="100%" height={260}>
        <LineChart data={data} margin={{ left: 8, right: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
          <XAxis dataKey="d" fontSize={10} tick={{ fill: "var(--muted)" }} angle={-40} textAnchor="end" interval={0} height={48} />
          <YAxis fontSize={11} tick={{ fill: "var(--muted)" }} domain={[0, 100]} ticks={[0, 20, 40, 60, 80, 100]} tickFormatter={(v: number) => `${v}%`} />
          <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", fontSize: 12 }} />
          <Line type="monotone" dataKey="v" name={label} stroke={color} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

interface SpExtra {
  utilizationDaily?: { d: string; utilization_pct: string }[];
  utilizationVcpuDaily?: { d: string; utilization_vcpu_pct: string }[];
  wasteCostDaily?: { d: string; usage_type: string; waste: string }[];
  wasteVcpuDaily?: { d: string; usage_type: string; waste_vcpu: string }[];
}

function SpSheet() {
  const { locale } = useLocale();
  const s = STR(locale !== "en");
  const [from, setFrom] = useState(isoDaysAgo(33));
  const [to, setTo] = useState(isoDaysAgo(3));
  const [data, setData] = useState<(SpData & SpExtra) | null>(null);
  useEffect(() => { setData(null); getSavingsPlans(from, to).then(setData as (d: SpData) => void); }, [from, to]);

  if (!data) return <Loading />;
  if (!data.available) return <Notice text={s.srcNotice(data.reason || "unknown")} />;

  const covRows = Array.isArray(data.coverageDaily) ? data.coverageDaily : [];
  const covCost = covRows.map((r: Record<string, unknown>) => ({
    d: String(r.usage_date || r.d || "").slice(5, 10),
    v: Number(r.sp_coverage_pct ?? r.coverage_pct ?? NaN),
  })).filter((r) => r.d && !Number.isNaN(r.v));
  const covVcpu = (data.coverageVcpuDaily || []).map((r) => ({ d: String(r.usage_date).slice(5, 10), v: Number(r.sp_coverage_vcpu_pct) }));
  const utilDaily = (data.utilizationDaily || []).map((r) => ({ d: String(r.d).slice(5, 10), v: Number(r.utilization_pct) }));
  const utilVcpu = (data.utilizationVcpuDaily || []).map((r) => ({ d: String(r.d).slice(5, 10), v: Number(r.utilization_vcpu_pct) }));
  const shortUt = (u: string) => u.replace(/^[A-Z0-9]+-EC2SP:/, "").replace("ComputeSP:", "CSP:");
  const wasteCost = (data.wasteCostDaily || []).map((r) => ({ d: r.d, key: shortUt(r.usage_type), value: Number(r.waste) }));
  const wasteVcpu = (data.wasteVcpuDaily || []).map((r) => ({ d: r.d, key: shortUt(r.usage_type), value: Number(r.waste_vcpu) }));
  const util = data.utilization || {};
  const details = data.details || [];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} s={s} />
        {util.sp_utilization_pct && <span style={{ fontSize: 15, fontWeight: 700, color: "var(--green)" }}>{s.spUtilInRange(String(util.sp_utilization_pct))}</span>}
        {util.total_waste && <span style={{ ...sub, color: "var(--orange)" }}>{s.spWasteInRange(fmtUsd(Number(util.total_waste)))}</span>}
        <AsOf asOf={data.asOf} s={s} />
      </div>
      <div style={card}>
        <div style={h3}>{s.spDetails}</div>
        <div style={{ overflowX: "auto", maxHeight: 420, overflowY: "auto" }}>
          <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse", whiteSpace: "nowrap" }}>
            <thead><tr style={{ color: "var(--muted)", textAlign: "left", position: "sticky", top: 0, background: "var(--card)" }}>
              {s.spCols.map((h) => <th key={h} style={{ padding: "5px 8px" }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {details.map((r, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--line)", color: "var(--text)" }}>
                  <td style={{ padding: "5px 8px" }}>{r.payer}</td><td>{r.account}</td>
                  <td>{r.region}</td><td>{r.family}</td>
                  <td>${r.hourly_commitment}/h</td><td>{r.purchased_vcpu}</td>
                  <td>{r.payment}</td><td>{r.term}</td>
                  <td>{r.start_date}</td><td>{r.end_date}</td><td>{r.days_to_expire}</td>
                  <td>{r.utilization_pct}%</td>
                  <td style={{ color: "var(--orange)" }}>{fmtUsd(Number(r.wasted_cost || 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <SpLine title={s.spUtilCost} label={s.utilization} data={utilDaily} color="#e8710a" />
      <SpLine title={s.spCovCost} label={s.coverage} data={covCost} color="#e8710a" />
      <SpLine title={s.spUtilVcpu} label={s.utilization} data={utilVcpu} color="#1f77b4" />
      <SpLine title={s.spCovVcpu} label={s.coverage} data={covVcpu} color="#1f77b4" />
      <StackedDaily title={s.spWasteCost} rows={wasteCost} />
      <StackedDaily title={s.spWasteVcpu} rows={wasteVcpu} money={false} />
    </div>
  );
}

/* ═══════════ 出口 ═══════════ */

export default function CurDashboard({ sheet }: { sheet: string }) {
  switch (sheet) {
    case "cur-trend": return <TrendSheet />;
    case "cur-credit": return <CreditSheet />;
    case "cur-es": return <EsSheet />;
    case "cur-sp": return <SpSheet />;
    default: return null;
  }
}
