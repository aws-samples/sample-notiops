/**
 * 「高负载」页的表格视图（2026-10，与「闲置与成本」表格对齐）。
 *
 * ## 与闲置表格同一套原则
 *
 * ```
 * ① 一行一台资源，一行一个高度     同一台多个指标越线 → 一行，最严重那条当主行，
 *                                  其余在指标列尾挂「+N」，抽屉里切换
 * ② 列表只放「比较用」的字段        资源 / 服务 / 区域 / 严重度 / 指标 / 已持续 / AI 判读
 * ③ 只显示例外，不显示常态          状态只挂 new / resolving / chronic；AI 列常态为空
 * ```
 *
 * 与闲置表格不同的一列是「指标」：高负载的主角就是「实测值 vs 阈值」，所以它在
 * 列表里（单行：指标名 · 小条 · 数值 · 高于/低于阈值），而闲置的评分明细在抽屉里。
 *
 * ## 不变的约定（与 FindingCard / IdleTable 同一套）
 *
 * - 整行是一个按钮：`role="button"` + `tabIndex` + Enter / Space；
 *   `data-finding-id` 是这一行打开的那条（primary），深链与测试靠它定位
 * - 「高于 / 低于」只读后端 `direction`（`evidenceText`），不按指标名猜
 * - 证据不是本轮的必须标出来（`staleShort`）；缺失的数字不渲染成 0
 */

import { useEffect, useRef } from "react";

import type { FindingRow } from "../../api/inspection";
import { capacityText, evidenceText, judgementState } from "./format";
import { metricName, staleShort } from "./highLoadUtil";
import { groupByResource, type ResourceGroup, serviceColor, serviceLabel } from "./idleTableUtil";
import { ExcludedTag, GoneTag, JudgementCell, SevTag, Tag } from "./tableParts";
import { C, SEV_COLOR } from "./tokens";

const ROW_H = 56;

const headCell: React.CSSProperties = {
  fontSize: 12, color: C.muted, fontWeight: 500, whiteSpace: "nowrap",
  overflow: "hidden", textOverflow: "ellipsis",
};
const cell: React.CSSProperties = {
  minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};

/**
 * 列定义。⚠️ 1360 宽窗口下内容区 1180px（`MAXW`），这一组的下限之和正好放得下：
 * 指标列要装「指标名 · 小条 · 92.4% · 高于阈值 80% · +1」约 300px，
 * 严重度列要装「高 · 长期高位」两个标签约 120px（第一版 112px，「长期高位」被切掉）。
 */
function columns(showAccount: boolean): string {
  return [
    "minmax(170px,1fr)",          // 资源
    ...(showAccount ? ["116px"] : []),
    "96px",                       // 服务
    "108px",                      // 区域
    "136px",                      // 严重度（+ 非常态的状态）
    "minmax(300px,1.6fr)",        // 指标
    "52px",                       // 已持续
    "minmax(112px,128px)",        // AI 判读
    "12px",                       // ›
  ].join(" ");
}
const GAP = 16;

export default function HighLoadTable({
  rows, zh, t, highlight, showAccount, onOpen, isJudged, goneDate,
}: {
  rows: FindingRow[];
  zh: boolean;
  t: (k: string) => string;
  highlight: string;
  showAccount: boolean;
  onOpen: (f: FindingRow) => void;
  isJudged: (f: FindingRow) => boolean;
  /** 资源已不存在时返回核实日期（可能是空串），否则 null。 */
  goneDate?: (f: FindingRow) => string | null;
}) {
  const groups = groupByResource(rows);
  const cols = columns(showAccount);

  return (
    /* ⚠️ 窄屏横向滚动，而不是把列挤坏：每列都是单行省略，列宽有下限。 */
    <div style={{
      border: `1px solid ${C.line}`, borderRadius: 10, overflowX: "auto",
      background: C.card,
    }}>
      <div style={{ minWidth: showAccount ? 1302 : 1170 }}>
        <div aria-hidden="true" style={{
          display: "grid", gridTemplateColumns: cols, columnGap: GAP,
          alignItems: "center", height: 42, padding: "0 20px",
          borderBottom: `1px solid ${C.line}`,
          background: "color-mix(in srgb, var(--text) 3%, transparent)",
        }}>
          <span style={headCell}>{zh ? "资源" : "Resource"}</span>
          {showAccount && <span style={headCell}>{zh ? "账号" : "Account"}</span>}
          <span style={headCell}>{zh ? "服务" : "Service"}</span>
          <span style={headCell}>{zh ? "区域" : "Region"}</span>
          <span style={headCell}>{zh ? "严重度" : "Severity"}</span>
          <span style={headCell}>{zh ? "指标" : "Metric"}</span>
          <span style={{ ...headCell, textAlign: "right" }}>{zh ? "已持续" : "Age"}</span>
          <span style={headCell}>{zh ? "AI 判读" : "AI analysis"}</span>
          <span />
        </div>
        {groups.map((g, i) => (
          <HighRow key={g.key} g={g} zh={zh} t={t} cols={cols}
            last={i === groups.length - 1}
            highlighted={!!highlight
              && [g.primary, ...g.others].some((f) => f.finding_id === highlight)}
            showAccount={showAccount} onOpen={() => onOpen(g.primary)}
            judged={isJudged(g.primary)} gone={goneDate?.(g.primary) ?? null} />
        ))}
      </div>
    </div>
  );
}

function HighRow({
  g, zh, t, cols, last, highlighted, showAccount, onOpen, judged, gone,
}: {
  g: ResourceGroup;
  zh: boolean;
  t: (k: string) => string;
  cols: string;
  last: boolean;
  highlighted: boolean;
  showAccount: boolean;
  onOpen: () => void;
  judged: boolean;
  gone: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const f = g.primary;
  const state = judgementState(f, { dispatched: judged });

  useEffect(() => {
    if (!highlighted || !ref.current) return;
    ref.current.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [highlighted]);

  return (
    <div ref={ref} data-finding-id={f.finding_id}
      data-highlighted={highlighted ? "1" : undefined}
      className="insp-trow"
      role="button" tabIndex={0}
      aria-label={zh ? `${f.instance} 的巡检详情` : `Inspection details for ${f.instance}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen();
      }}
      style={{
        display: "grid", gridTemplateColumns: cols, columnGap: GAP,
        alignItems: "center", height: ROW_H, padding: "0 20px",
        borderBottom: last ? undefined : `1px solid ${C.line}`,
        boxShadow: highlighted ? `inset 3px 0 0 ${C.blue}` : undefined,
        background: highlighted ? "color-mix(in srgb, var(--blue) 7%, transparent)" : undefined,
      }}>
      {/* ── 资源：名字 + 规格同一行（名字不参与收缩，规格先省略）── */}
      <div style={{ ...cell, display: "flex", alignItems: "baseline", gap: 8 }}>
        <span title={f.instance} style={{
          fontSize: 13.5, fontWeight: 600, color: C.text, flex: "none", maxWidth: "100%",
          overflow: "hidden", textOverflow: "ellipsis",
        }}>{f.instance}</span>
        {f.instance_class && (
          <span title={f.instance_class} style={{
            fontSize: 12, color: C.muted, flex: "0 100 auto", minWidth: 0,
            overflow: "hidden", textOverflow: "ellipsis",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}>{f.instance_class}</span>
        )}
      </div>

      {showAccount && (
        <div style={{ ...cell, fontSize: 12.5, color: C.muted,
          fontVariantNumeric: "tabular-nums" }} title={zh ? "所属账号" : "Account"}>
          {f.account_id || "—"}
        </div>
      )}

      <div style={{ ...cell, display: "flex", alignItems: "center", gap: 7, fontSize: 12.5,
        color: C.text }}>
        <span aria-hidden="true" style={{
          width: 7, height: 7, borderRadius: 2, flexShrink: 0,
          background: serviceColor(f.service),
        }} />
        {serviceLabel(f.service)}
      </div>

      <div style={{ ...cell, fontSize: 12.5, color: C.muted }}>{f.region}</div>

      {/* ── 严重度 + 非常态的状态 ── */}
      <div style={{ ...cell, display: "flex", alignItems: "center", gap: 6 }}>
        <SevTag sev={f.severity} label={t(`insp.sev.${f.severity}`)} />
        {gone !== null && <GoneTag on={gone} zh={zh} />}
        {gone === null && f.excluded_by && <ExcludedTag until={f.excluded_until || ""} zh={zh} />}
        {/* 常态（active）不显示；new / resolving / chronic 各意味着不同的动作。 */}
        {gone === null && !f.excluded_by && f.state && f.state !== "active" && (
          <Tag tone="neutral">{t(`insp.state.${f.state}`)}</Tag>
        )}
      </div>

      <MetricCell f={f} others={g.others} zh={zh} />

      <div style={{ ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums",
        fontSize: 12.5, color: C.text }}
        title={f.first_seen_date
          ? `${t("insp.field.firstSeen")} ${f.first_seen_date}` : undefined}>
        {f.days_active !== null ? `${f.days_active}${t("insp.field.days")}` : "—"}
      </div>

      <div style={{ ...cell, display: "flex", alignItems: "center", gap: 5, fontSize: 12.5 }}>
        <JudgementCell f={f} zh={zh} t={t} state={state} />
      </div>

      <span aria-hidden="true" className="insp-chev"
        style={{ color: C.muted, fontSize: 16, lineHeight: 1 }}>›</span>
    </div>
  );
}

/**
 * 指标那一格：`指标名 ▬▬| 92.4% 高于阈值 80% [截至 8/10] [+1]`，单行。
 *
 * ⚠️ 空间不够时指标名与「高于阈值 …」一起收缩（都有 title），但指标名至少留 4 个字宽 ——
 *    第一版只压指标名，「CPU 使用率」被压成「CP…」。数值永远不收缩：截掉的是
 *    「85.3%」的话这一列就没有意义了。
 */
function MetricCell({ f, others, zh }: { f: FindingRow; others: FindingRow[]; zh: boolean }) {
  const ev = evidenceText(f, zh);
  const stale = staleShort(f, zh);
  const cap = capacityText(f);
  const color = SEV_COLOR[f.severity] ?? C.muted;
  return (
    <div style={{ ...cell, display: "flex", alignItems: "center", gap: 8 }}>
      <span title={f.metric || undefined} style={{
        fontSize: 12.5, color: C.muted, flex: "0 1 auto", minWidth: "4.2em",
        overflow: "hidden", textOverflow: "ellipsis",
      }}>{metricName(f, zh)}</span>
      {/* 百分比指标给一根带阈值刻度的小条。⚠️ 只对 `%` 画 —— 字节 / 计数 / 秒
          没有 0~100 的天然刻度，硬画会误导。 */}
      {ev && f.unit === "%" && f.observed_value !== null && f.threshold_value !== null && (
        <span aria-hidden="true" style={{
          width: 44, height: 6, borderRadius: 3, flex: "none",
          background: C.line, position: "relative", overflow: "hidden",
        }}>
          <span style={{
            position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 3,
            width: `${Math.max(2, Math.min(100, f.observed_value))}%`, background: color,
          }} />
          <span style={{
            position: "absolute", top: 0, bottom: 0, width: 2,
            left: `calc(${Math.max(0, Math.min(100, f.threshold_value))}% - 1px)`,
            background: "var(--text)", opacity: .5,
          }} />
        </span>
      )}
      {ev && (
        <>
          <b title={cap ?? undefined} style={{ flex: "none", fontSize: 14, fontWeight: 700,
            color, fontVariantNumeric: "tabular-nums" }}>{ev.value}</b>
          {/* 🔴 `relation` 为空 = 后端没给 `direction`，只说阈值是多少，不猜方向。 */}
          {(() => {
            const rel = ev.relation
              ? `${ev.relation} ${ev.threshold}`
              : (zh ? `阈值 ${ev.threshold}` : `threshold ${ev.threshold}`);
            return (
              <span title={rel} style={{ flex: "0 1 auto", minWidth: 0, fontSize: 12,
                color: C.muted, overflow: "hidden", textOverflow: "ellipsis" }}>{rel}</span>
            );
          })()}
        </>
      )}
      {/* 🔴 证据不是本轮的 —— chronic / resolving 保留的是最后一次命中时的数字，
          不标注就等于宣称那是今天的水位。 */}
      {stale && (
        <span title={stale.full} aria-label={stale.full}
          style={{ flex: "none", fontSize: 11.5, color: C.amber }}>{stale.short}</span>
      )}
      {/* 比 `Tag` 窄一号：它只是「还有几条」的提示，不该和数值抢位置。 */}
      {others.length > 0 && (
        <span title={(zh ? "同一台还有：" : "Also on this resource: ")
            + others.map((x) => metricName(x, zh)).join(zh ? "、" : ", ")}
          style={{
            flex: "none", height: 20, padding: "0 6px", borderRadius: 5,
            display: "inline-flex", alignItems: "center", fontSize: 11.5, fontWeight: 500,
            color: C.muted, background: "color-mix(in srgb, var(--text) 7%, transparent)",
          }}>+{others.length}</span>
      )}
    </div>
  );
}
