/**
 * 高负载详情抽屉的正文（2026-10「结论先行」，与闲置抽屉 `IdleDetail` 对齐）。
 *
 * ## 阅读顺序
 *
 * ```
 * 实测值 vs 阈值 · 已持续多久    ← 一眼的答案
 * 一句结论                        ← 规则层面的事实
 * AI 判读结论卡                   ← 高负载轮自动派，有就置顶（含 AI 对严重度的异议）
 * 判定依据                        ← 指标 / 实测 / 阈值 / 连续命中
 * 同一台资源                      ← 同一台上另外越线的指标（表格里只占「+N」）
 * ▸ 诊断信息                      ← 规则码与状态机计数，折起来
 * ```
 *
 * ⚠️ AI 判读拆不开（老格式 / 纯散文）、还在等、回来是空的、缺判读 —— 这些情况照样
 *    渲染 `InspectionDashboardPanel` 构造好的那一节（`aiFallback`）。门禁三态、
 *    「原文可能含同批别的资源」这些判据都在那里，不在这里复制第二份。
 * ⚠️ 原来抽屉底部那行「指标曲线在后续版本提供」删了：它对这一条没有任何信息。
 */

import { useState } from "react";

import type { FindingDetail, FindingRow } from "../../api/inspection";
import { capacityText, degradationLabel, evidenceText, judgementState,
  staleEvidenceText, verdictLabel } from "./format";
import { breachText, highSummaryLine, metricName, monthDay } from "./highLoadUtil";
import { Fold } from "./IdleDetail";
import { parseJudgment, shortDate } from "./idleDetailUtil";
import { SevTag } from "./tableParts";
import { C, SEV_COLOR } from "./tokens";

const label: React.CSSProperties = { fontSize: 12, color: C.muted };
const sectionTitle: React.CSSProperties = {
  margin: "30px 0 10px", fontSize: 13, fontWeight: 700, color: C.text,
};
const pill: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, height: 22, padding: "0 8px",
  borderRadius: 6, fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", flexShrink: 0,
};

/** 顶部：实测值 vs 阈值 · 已持续多久。 */
function Hero({ row, zh, t }: { row: FindingRow; zh: boolean; t: (k: string) => string }) {
  const ev = evidenceText(row, zh);
  const breach = breachText(row, zh);
  const stale = staleEvidenceText(row, zh);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 44, flexWrap: "wrap" }}>
      <div>
        <div style={label} title={row.metric || undefined}>{metricName(row, zh)}</div>
        <div style={{
          fontSize: 30, fontWeight: 700, lineHeight: 1.2, marginTop: 4,
          letterSpacing: "-.02em", fontVariantNumeric: "tabular-nums",
          color: ev ? (SEV_COLOR[row.severity] ?? C.text) : C.muted,
        }}>
          {ev ? ev.value : "—"}
        </div>
        <div style={{ ...label, marginTop: 6 }}>
          {ev
            ? [ev.relation ? `${ev.relation} ${ev.threshold}`
              : `${zh ? "阈值" : "threshold"} ${ev.threshold}`, breach]
              .filter(Boolean).join(" · ")
            : (zh ? "这条发现没有记录实测值" : "no measured value recorded")}
        </div>
        {/* 🔴 陈旧证据的标注紧挨数字 —— 放远了等于没标，客户读到数字就已经形成判断了。 */}
        {stale && (
          <div style={{ fontSize: 12, color: C.amber, marginTop: 4 }}>{stale}</div>
        )}
      </div>
      <div style={{ paddingBottom: stale ? 22 : 2 }}>
        <div style={label}>{zh ? "已持续" : "Age"}</div>
        <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.25, marginTop: 4,
          color: C.text, fontVariantNumeric: "tabular-nums" }}>
          {row.days_active !== null ? `${row.days_active} ${zh ? "天" : "d"}` : "—"}
        </div>
        <div style={{ ...label, marginTop: 4 }}>
          {row.first_seen_date
            ? (zh ? `${shortDate(row.first_seen_date, zh)}首次发现`
              : `first seen ${shortDate(row.first_seen_date, zh)}`)
            : (row.state ? t(`insp.state.${row.state}`) : "")}
        </div>
      </div>
    </div>
  );
}

/** AI 判读结论卡（正文拆得开时）。 */
function AiCard({ row, detail, zh, t, rawBody }: {
  row: FindingRow;
  detail: FindingDetail;
  zh: boolean;
  t: (k: string) => string;
  rawBody: React.ReactNode;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const p = parseJudgment(detail.da_body)!;
  const act = p.actions[0];
  const when = detail.da_updated_at
    ? shortDate(new Date(detail.da_updated_at * 1000).toISOString().slice(0, 10), zh) : "";
  const codes = row.da_degradations ?? [];
  const divider: React.CSSProperties = {
    marginTop: 14, paddingTop: 14,
    borderTop: "1px solid color-mix(in srgb, var(--blue) 16%, var(--line))",
  };
  const tagStyle: React.CSSProperties = {
    ...pill, color: C.muted, background: C.card, border: `1px solid ${C.line}`,
  };
  return (
    <div style={{
      marginTop: 22, borderRadius: 12, padding: "18px 20px",
      border: "1px solid color-mix(in srgb, var(--blue) 26%, var(--line))",
      background: "color-mix(in srgb, var(--blue) 6%, var(--card))",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ ...pill, color: C.blue,
          background: "color-mix(in srgb, var(--blue) 13%, transparent)" }}>
          {zh ? "AI 判读" : "AI analysis"}
        </span>
        <b style={{ fontSize: 15, color: C.text }} title={row.da_verdict || p.verdict}>
          {verdictLabel(row.da_verdict || p.verdict, t)}
        </b>
        {when && <span style={{ marginLeft: "auto", ...label }}>{when}</span>}
      </div>
      {p.summary && (
        <p style={{ margin: "12px 0 0", fontSize: 13.5, lineHeight: 1.75, color: C.text }}>
          {p.summary}
        </p>
      )}
      {/* AI 对严重度定级的异议。skill 规定「不同意才写」—— 有这一段就是在说
          「这条的严重度定高了 / 定低了」，处置优先级要跟着变，所以单独成段。
          ⚠️ 严重度本身不改（那是判定层的事），这里只展示 AI 的意见。 */}
      {p.severityDispute && (
        <div style={divider}>
          <div style={{ ...label, marginBottom: 6 }}>
            {zh ? "AI 对严重度的意见" : "AI on the severity"}
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.7, color: C.text }}>
            {p.severityDispute}
          </div>
        </div>
      )}
      {act && (
        <div style={divider}>
          <div style={{ ...label, marginBottom: 6 }}>{zh ? "建议" : "Recommendation"}</div>
          <div style={{ fontSize: 13.5, lineHeight: 1.7, color: C.text }}>{act.action}</div>
          {(act.downtime === "yes" || act.approval === "yes") && (
            <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              {act.downtime === "yes" && (
                <span style={tagStyle}>{zh ? "需要停机" : "downtime"}</span>)}
              {act.approval === "yes" && (
                <span style={tagStyle}>{zh ? "需要审批 / 变更窗口" : "needs approval"}</span>)}
            </div>
          )}
          {act.caveats && (
            <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.65, color: C.amber }}>
              ⚠ {act.caveats}
            </div>
          )}
        </div>
      )}
      {/* 门禁结论（判读可不可信）。三态，`null` 不渲染 —— 与表格那一格同一条规则。 */}
      {row.da_gate_trustworthy === false && (
        <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.65, color: C.red }}>
          {t("insp.gate.headUntrusted")}
          {codes.length > 0 && `：${codes.map((c) => degradationLabel(c, t)).join("；")}`}
        </div>
      )}
      {row.da_gate_trustworthy === true && codes.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.65, color: C.amber }}>
          {t("insp.gate.headDegraded")}：{codes.map((c) => degradationLabel(c, t)).join("；")}
        </div>
      )}
      <button type="button" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw}
        style={{
          marginTop: 12, padding: 0, border: 0, background: "transparent", cursor: "pointer",
          color: C.blue, fontSize: 12.5, fontWeight: 600,
        }}>
        {showRaw ? (zh ? "收起完整判读" : "Hide full analysis")
          : (zh ? "查看完整判读 ›" : "Full analysis ›")}
      </button>
      {showRaw && <div style={{ marginTop: 10 }}>{rawBody}</div>}
    </div>
  );
}

/** 「判定依据」一行。 */
function EvRow({ k, v, hint, hintTone }: {
  k: string; v: React.ReactNode; hint?: string; hintTone?: "amber";
}) {
  return (
    <div style={{
      display: "flex", alignItems: "baseline", gap: 14, padding: "12px 0",
      borderBottom: `1px solid ${C.line}`, fontSize: 13.5,
    }}>
      <span style={{ width: 110, flex: "none", color: C.muted }}>{k}</span>
      <span style={{ fontWeight: 600, color: C.text, fontVariantNumeric: "tabular-nums" }}>
        {v}
      </span>
      {hint && (
        <span style={{ marginLeft: "auto", fontSize: 12, textAlign: "right",
          color: hintTone === "amber" ? C.amber : C.muted }}>{hint}</span>
      )}
    </div>
  );
}

export default function HighLoadDetail({
  row, zh, t, related, onOpenRelated, state, detail, aiFallback, rawBody, diagnostics,
}: {
  row: FindingRow;
  zh: boolean;
  t: (k: string) => string;
  related: FindingRow[];
  onOpenRelated?: (f: FindingRow) => void;
  state: ReturnType<typeof judgementState>;
  detail: FindingDetail | null;
  /** 拆不开 / 等待 / 失败 / 缺判读时用的原「AI 判读」一节。 */
  aiFallback: React.ReactNode;
  rawBody: React.ReactNode;
  diagnostics: React.ReactNode;
}) {
  const parsed = state === "ok" && detail?.da_body ? parseJudgment(detail.da_body) : null;
  const ev = evidenceText(row, zh);
  const cap = capacityText(row);
  const stale = staleEvidenceText(row, zh);
  const hits = row.consecutive_hits;

  return (
    <>
      <Hero row={row} zh={zh} t={t} />
      <p style={{ margin: "20px 0 0", fontSize: 14, lineHeight: 1.75, color: C.text }}>
        {highSummaryLine(row, zh)}
      </p>

      {parsed && detail
        ? <AiCard row={row} detail={detail} zh={zh} t={t} rawBody={rawBody} />
        : <div style={{ marginTop: 6 }}>{aiFallback}</div>}

      <div style={sectionTitle}>{zh ? "判定依据" : "Evidence"}</div>
      <div style={{ borderTop: `1px solid ${C.line}` }}>
        <EvRow k={zh ? "指标" : "Metric"} v={metricName(row, zh)}
          hint={row.metric && row.metric !== metricName(row, zh) ? row.metric : undefined} />
        {ev && (
          <>
            <EvRow k={zh ? "实测值" : "Observed"}
              v={cap ? `${ev.value}（${cap}）` : ev.value}
              hint={stale ?? (row.evidence_as_of
                ? (zh ? `${monthDay(row.evidence_as_of)} 那一轮` : `run of ${monthDay(row.evidence_as_of)}`)
                : undefined)}
              hintTone={stale ? "amber" : undefined} />
            {/* 🔴 「高于 / 低于即命中」只读后端 `direction`，缺方向时不写。 */}
            <EvRow k={zh ? "阈值" : "Threshold"} v={ev.threshold}
              hint={row.direction === "bad_up" ? (zh ? "高于即命中" : "breach when above")
                : row.direction === "bad_down" ? (zh ? "低于即命中" : "breach when below")
                  : undefined} />
          </>
        )}
        {hits !== null && hits > 0 && (
          <EvRow k={zh ? "连续命中" : "Consecutive hits"}
            v={zh ? `${hits} 轮` : `${hits} runs`}
            hint={row.was_confirmed ? (zh ? "已确认" : "confirmed") : undefined} />
        )}
      </div>

      {related.length > 0 && (
        <>
          <div style={sectionTitle}>{zh ? "同一台资源" : "Same resource"}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {related.map((f) => {
              const e = evidenceText(f, zh);
              return (
                <div key={f.finding_id} style={{
                  display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
                  border: `1px solid ${C.line}`, borderRadius: 10, fontSize: 13,
                }}>
                  <SevTag sev={f.severity} label={t(`insp.sev.${f.severity}`)} small />
                  <span style={{ color: C.text, fontWeight: 600 }}>{metricName(f, zh)}</span>
                  {e && (
                    <span style={{ color: C.muted, minWidth: 0 }}>
                      {e.value}{" "}
                      {e.relation ? `${e.relation} ${e.threshold}`
                        : `${zh ? "阈值" : "threshold"} ${e.threshold}`}
                    </span>
                  )}
                  {onOpenRelated && (
                    <button type="button" onClick={() => onOpenRelated(f)} style={{
                      marginLeft: "auto", flex: "none", padding: 0, border: 0,
                      background: "transparent", cursor: "pointer", whiteSpace: "nowrap",
                      color: C.blue, fontWeight: 600, fontSize: 12.5,
                    }}>{zh ? "查看 ›" : "View ›"}</button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <div style={{ marginTop: 30, borderBottom: `1px solid ${C.line}` }}>
        <Fold title={zh ? "诊断信息" : "Diagnostics"}
          right={zh ? "规则码 · 版本 · 状态机计数" : "rule · version · counters"}>
          {diagnostics}
        </Fold>
      </div>
    </>
  );
}
