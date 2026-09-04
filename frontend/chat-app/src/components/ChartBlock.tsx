/**
 * ChartBlock — 聊天消息里的内联图表。
 *
 * agent 在回答里输出 ```chart 围栏代码块（JSON 规格），本组件解析并用 recharts 渲染：
 *   ```chart
 *   {"type":"line|bar|pie","title":"...","x":"月份","series":[{"name":"费用","data":[["2026-05",1.2],["2026-06",1.5]]}]}
 *   ```
 * 设计约束：
 *   - 规格解析失败 → 原样展示代码块（fail-open，绝不因图表吞掉数据）；
 *   - 只读展示，不引入新依赖（recharts 已在 package.json，Dashboard 在用）；
 *   - 数值轴从 0 开始（成本图表纪律：不截轴制造视觉误导）。
 */
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, CartesianGrid,
} from "recharts";
// memo 按 spec 序列化对比：同一图表在父组件重渲时不重建（防闪）。

const COLORS = ["#0073bb", "#ff9900", "#2ca02c", "#d62728", "#9467bd", "#8c564b", "#e377c2", "#7f7f7f"];

type SeriesSpec = { name: string; data: [string | number, number][] };
type ChartSpec = { type: "line" | "bar" | "pie"; title?: string; x?: string; series: SeriesSpec[] };

export function tryParseChartSpec(raw: string): ChartSpec | null {
  try {
    const spec = JSON.parse(raw);
    if (!spec || !["line", "bar", "pie"].includes(spec.type)) return null;
    if (!Array.isArray(spec.series) || spec.series.length === 0) return null;
    for (const s of spec.series) {
      if (!Array.isArray(s.data) || s.data.length === 0) return null;
    }
    return spec as ChartSpec;
  } catch {
    return null;
  }
}

import { memo } from "react";

function ChartBlockInner({ spec }: { spec: ChartSpec }) {
  // 多 series 合并成 recharts 的行式数据：[{x: "2026-05", 费用: 1.2, 台数: 300}, ...]
  const keys = spec.series.map((s) => s.name);
  const rows: Record<string, string | number>[] = [];
  const idx = new Map<string | number, Record<string, string | number>>();
  for (const s of spec.series) {
    for (const [x, y] of s.data) {
      if (!idx.has(x)) {
        const r: Record<string, string | number> = { __x: x };
        idx.set(x, r);
        rows.push(r);
      }
      idx.get(x)![s.name] = y;
    }
  }

  const title = spec.title ? (
    <div style={{ fontSize: 13, fontWeight: 600, margin: "4px 0 8px", opacity: 0.85 }}>{spec.title}</div>
  ) : null;

  if (spec.type === "pie") {
    const first = spec.series[0];
    const pieData = first.data.map(([name, value]) => ({ name: String(name), value }));
    return (
      <div style={{ margin: "8px 0" }}>
        {title}
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie data={pieData} dataKey="value" nameKey="name" outerRadius={90} label>
              {pieData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip /><Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    );
  }

  const Axis = (
    <>
      <CartesianGrid strokeDasharray="3 3" opacity={0.35} />
      <XAxis dataKey="__x" name={spec.x} fontSize={11} />
      <YAxis fontSize={11} domain={[0, "auto"]} tickFormatter={(v: number) =>
        Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v)} />
      <Tooltip /><Legend />
    </>
  );

  return (
    <div style={{ margin: "8px 0" }}>
      {title}
      <ResponsiveContainer width="100%" height={260}>
        {spec.type === "line" ? (
          <LineChart data={rows}>{Axis}
            {keys.map((k, i) => <Line key={k} dataKey={k} stroke={COLORS[i % COLORS.length]} dot={false} strokeWidth={2} />)}
          </LineChart>
        ) : (
          <BarChart data={rows}>{Axis}
            {keys.map((k, i) => <Bar key={k} dataKey={k} fill={COLORS[i % COLORS.length]} />)}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}


const ChartBlock = memo(ChartBlockInner, (a, b) => JSON.stringify(a.spec) === JSON.stringify(b.spec));
export default ChartBlock;
