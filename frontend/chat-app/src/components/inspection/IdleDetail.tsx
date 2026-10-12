/**
 * 闲置页详情抽屉的正文（2026-10 第三版「结论先行」，mock A + A2）。
 *
 * ## 为什么重排
 *
 * 第二版是「三张摘要卡 → 关联发现 → 评分表 → 列头说明 → 丢弃维度 → 归一化依据 →
 * 判定方式 → AI 判读 → 诊断信息」从上到下平铺，每块的视觉分量一样。客户原话：
 * 「总感觉就是乱糟糟一行一行文字」。看的人要自己拼出「到底要不要动它、怎么动」，
 * 而「生效权重 57%」「贡献分 56.1」这类算法细节排在「CPU 1.9%」这种事实前面。
 *
 * 现在按回答问题的顺序排：
 *
 * ```
 * 省多少 · 持续多久            ← 一眼的答案
 * 一句结论                      ← 为什么
 * AI 判读结论卡（派过才有）     ← 有 AI 时它就是答案，置顶
 * 判定依据（实测值 + 白话）     ← 证据
 * 同一台资源                    ← 另一条发现
 * 建议处置（AI 给了就不显示）   ← 怎么做
 * ▸ 评分明细  ▸ 诊断信息         ← 算法与排查细节，折起来
 * ```
 *
 * ⚠️ 评分明细、AI 判读的兜底区、判读原文、诊断信息这几块的**内容**仍由
 *    `InspectionDashboardPanel` 构造后作为 slot 传进来 —— 它们与高负载抽屉共用
 *    判据，而且 `inspection.test.ts` 有几条元断言钉在那个文件的源码上
 *    （progressbar 的值语义、门禁三态）。这里只负责**排版**。
 */

import { useState } from "react";

import type { FindingDetail, FindingRow } from "../../api/inspection";
import {
  degradationLabel, fmtMoney, idleTierColor, isCoarse, judgementState, PRECISION_LABEL,
} from "./format";
import {
  actionSteps, dispositionLabel, idleReasonLabel, idleVerdictLabel, parseJudgment,
  PRECISION_SHORT, relatedNote, shortDate, signalRows, summaryLine,
} from "./idleDetailUtil";
import { CAPACITY_RULE_LABEL } from "./idleTableUtil";
import { C } from "./tokens";

const label: React.CSSProperties = { fontSize: 12, color: C.muted };
const sectionTitle: React.CSSProperties = {
  margin: "30px 0 10px", fontSize: 13, fontWeight: 700, color: C.text,
};
const pill: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 4, height: 22, padding: "0 8px",
  borderRadius: 6, fontSize: 12, fontWeight: 500, whiteSpace: "nowrap", flexShrink: 0,
};

/** 与表格「发现」列同形的小标签。`JudgeModal` 也用它，两处长得一样。 */
export function FindingTag({ f, zh }: { f: FindingRow; zh: boolean }) {
  const cap = CAPACITY_RULE_LABEL[f.rule];
  if (cap || f.idle_score === null) {
    return (
      <span style={{ ...pill, color: C.muted,
        background: "color-mix(in srgb, var(--text) 7%, transparent)" }}>
        {cap ? cap[zh ? "zh" : "en"] : (zh ? "闲置" : "Idle")}
      </span>
    );
  }
  return (
    <span style={{ ...pill, color: C.text,
      background: "color-mix(in srgb, var(--orange) 13%, transparent)" }}>
      {zh ? "闲置" : "Idle"}
      <b style={{ color: idleTierColor(f.idle_score) }}>{f.idle_score.toFixed(0)}</b>
    </span>
  );
}

/** 折叠行。比 `Expandable` 轻：一条分隔线 + 标题 + 右侧一句摘要，不套框。高负载抽屉也用它。 */
export function Fold({ title, right, children }: {
  title: string; right?: string; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: `1px solid ${C.line}` }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", gap: 10, width: "100%",
          padding: "15px 0", background: "transparent", border: 0, cursor: "pointer",
          color: C.text, fontSize: 13.5, fontWeight: 600, textAlign: "left",
        }}>
        <span aria-hidden="true" style={{ color: C.muted, fontSize: 11, width: 10 }}>
          {open ? "▾" : "▸"}
        </span>
        {title}
        {right && (
          <span style={{ marginLeft: "auto", color: C.muted, fontSize: 12, fontWeight: 400 }}>
            {right}
          </span>
        )}
      </button>
      {open && <div style={{ padding: "0 0 18px" }}>{children}</div>}
    </div>
  );
}

/** 顶部：省多少 · 持续多久。 */
function Hero({ row, zh }: { row: FindingRow; zh: boolean }) {
  const priced = row.savings_usd !== null;
  const coarse = priced && !!row.savings_precision && isCoarse(row.savings_precision);
  const full = PRECISION_LABEL[row.savings_precision]?.[zh ? "zh" : "en"];
  const short = PRECISION_SHORT[row.savings_precision]?.[zh ? "zh" : "en"];
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 44, flexWrap: "wrap" }}>
      <div>
        <div style={label}>{zh ? "每月可省" : "Monthly saving"}</div>
        <div style={{
          fontSize: 30, fontWeight: 700, lineHeight: 1.2, marginTop: 4,
          letterSpacing: "-.02em", fontVariantNumeric: "tabular-nums",
          color: priced ? C.green : C.muted,
        }}>
          {priced ? fmtMoney(row.savings_usd) : "—"}
          {priced && (
            <span style={{ fontSize: 14, fontWeight: 500, color: C.muted, marginLeft: 3,
              letterSpacing: 0 }}>{zh ? "/月" : "/mo"}</span>
          )}
        </div>
        {coarse ? (
          <span title={full} style={{
            ...pill, marginTop: 8, color: C.amber,
            background: "color-mix(in srgb, #b7791f 14%, transparent)",
          }}>
            {zh ? "粗估" : "coarse"}{short ? ` · ${short}` : ""}
          </span>
        ) : !priced ? (
          <div style={{ ...label, marginTop: 6 }}>
            {CAPACITY_RULE_LABEL[row.rule]
              ? (zh ? "能省多少还没有估算" : "saving not estimated yet")
              : (zh ? "估不出价" : "no price estimate")}
          </div>
        ) : null}
      </div>
      <div style={{ paddingBottom: coarse ? 4 : 2 }}>
        <div style={label}>{zh ? "已持续" : "Age"}</div>
        <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.25, marginTop: 4,
          color: C.text, fontVariantNumeric: "tabular-nums" }}>
          {row.days_active !== null ? `${row.days_active} ${zh ? "天" : "d"}` : "—"}
        </div>
        <div style={{ ...label, marginTop: 4 }}>
          {row.first_seen_date
            ? (zh ? `${shortDate(row.first_seen_date, zh)}首次发现`
              : `first seen ${shortDate(row.first_seen_date, zh)}`)
            : ""}
        </div>
      </div>
    </div>
  );
}

/** 派过 AI 且正文拆得开时的结论卡（mock A2）。 */
function AiCard({ row, detail, zh, t, rawBody }: {
  row: FindingRow;
  detail: FindingDetail;
  zh: boolean;
  t: (k: string) => string;
  rawBody: React.ReactNode;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const p = parseJudgment(detail.da_body)!;
  const verdict = idleVerdictLabel(row.da_verdict || p.verdict, t, zh);
  const reason = idleReasonLabel(p.idleReason, zh);
  const disp = dispositionLabel(p.disposition, zh);
  const act = p.actions[0];
  const when = detail.da_updated_at
    ? shortDate(new Date(detail.da_updated_at * 1000).toISOString().slice(0, 10), zh) : "";
  const codes = row.da_degradations ?? [];
  const tagStyle: React.CSSProperties = {
    ...pill, height: 22, color: C.muted, background: C.card, border: `1px solid ${C.line}`,
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
          {verdict}{reason ? ` · ${reason}` : ""}
        </b>
        <span style={{ marginLeft: "auto", ...label }}>
          {zh ? "手动派发" : "requested manually"}{when ? ` · ${when}` : ""}
        </span>
      </div>
      {p.summary && (
        <p style={{ margin: "12px 0 0", fontSize: 13.5, lineHeight: 1.75, color: C.text }}>
          {p.summary}
        </p>
      )}
      {act && (
        <div style={{
          marginTop: 14, paddingTop: 14,
          borderTop: "1px solid color-mix(in srgb, var(--blue) 16%, var(--line))",
        }}>
          <div style={{ ...label, marginBottom: 6 }}>
            {zh ? "建议" : "Recommendation"}{disp ? ` · ${disp}` : ""}
          </div>
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
      {/* 门禁结论（判读可不可信）。三态，`null` 不渲染 —— 与卡片徽标同一条规则。 */}
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

export default function IdleDetail({
  row, zh, t, related, onOpenRelated, dispatched, canJudge, state, detail,
  breakdown, methodBox, aiFallback, rawBody, diagnostics, gone = false,
}: {
  row: FindingRow;
  zh: boolean;
  t: (k: string) => string;
  related: FindingRow[];
  onOpenRelated?: (f: FindingRow) => void;
  dispatched: boolean;
  /** 有没有「派 AI 判读」的入口（权限 + 回调）。没有就不提示去点它。 */
  canJudge: boolean;
  state: ReturnType<typeof judgementState>;
  detail: FindingDetail | null;
  /** 评分明细的表格（没有因子时为 null）。 */
  breakdown: React.ReactNode;
  /** 「判定方式」那一块。 */
  methodBox: React.ReactNode;
  /** 派过 AI 但拆不出结构（或还在等 / 失败）时用的原「AI 判读」一节。 */
  aiFallback: React.ReactNode;
  /** 判读原文（markdown）。 */
  rawBody: React.ReactNode;
  diagnostics: React.ReactNode;
  /** 资源已经不存在 —— 不再给「建议处置」（没有东西可处置了）。 */
  gone?: boolean;
}) {
  const parsed = state === "ok" && detail?.da_body ? parseJudgment(detail.da_body) : null;
  const signals = signalRows(row, zh);
  const steps = actionSteps(row, zh);
  const nFactors = (row.idle_factors ?? []).length;

  return (
    <>
      <Hero row={row} zh={zh} />
      <p style={{ margin: "20px 0 0", fontSize: 14, lineHeight: 1.75, color: C.text }}>
        {summaryLine(row, zh)}
      </p>

      {/* AI 判读：拆得开 → 结论卡置顶；拆不开 / 等待 / 失败 → 原来那一节照样渲染。 */}
      {dispatched && (parsed && detail
        ? <AiCard row={row} detail={detail} zh={zh} t={t} rawBody={rawBody} />
        : <div style={{ marginTop: 6 }}>{aiFallback}</div>)}

      <div style={sectionTitle}>{zh ? "判定依据" : "Evidence"}</div>
      {signals.length > 0 ? (
        <div style={{ borderTop: `1px solid ${C.line}` }}>
          {signals.map((s) => (
            <div key={s.key} style={{
              display: "flex", alignItems: "baseline", gap: 14, padding: "12px 0",
              borderBottom: `1px solid ${C.line}`, fontSize: 13.5,
            }}>
              <span style={{ width: 128, flex: "none", color: C.muted }}>{s.label}</span>
              <span style={{
                fontWeight: s.off ? 400 : 600, color: s.off ? C.muted : C.text,
                fontVariantNumeric: "tabular-nums",
              }}>{s.value}</span>
              {s.hint && (
                <span style={{ marginLeft: "auto", fontSize: 12, color: C.muted,
                  textAlign: "right" }}>{s.hint}</span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.7 }}>
          {zh ? "这条发现没有附带实测占用数据。判据见下方「判定方式」。"
            : "No measured usage was recorded on this finding. See \"How this was decided\" below."}
        </div>
      )}

      {related.length > 0 && (
        <>
          <div style={sectionTitle}>{zh ? "同一台资源" : "Same resource"}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {related.map((f) => (
              <div key={f.finding_id} style={{
                display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
                border: `1px solid ${C.line}`, borderRadius: 10, fontSize: 13,
              }}>
                <FindingTag f={f} zh={zh} />
                <span style={{ color: C.muted, minWidth: 0 }}>{relatedNote(f, zh)}</span>
                {onOpenRelated && (
                  <button type="button" onClick={() => onOpenRelated(f)} style={{
                    marginLeft: "auto", flex: "none", padding: 0, border: 0,
                    background: "transparent", cursor: "pointer", whiteSpace: "nowrap",
                    color: C.blue, fontWeight: 600, fontSize: 12.5,
                  }}>{zh ? "查看 ›" : "View ›"}</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* 建议处置：AI 已经给了针对这台的建议，就不再摆一份通用流程。
          资源已经不存在时也不摆 —— 「确认归属 → 建快照 → 删除」对一台删掉的库是空话。 */}
      {!parsed?.actions.length && !gone && (
        <>
          <div style={sectionTitle}>{zh ? "建议处置" : "Suggested steps"}</div>
          <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {steps.map((s, i) => (
              <li key={s.title} style={{ display: "flex", gap: 12, padding: "8px 0" }}>
                <span aria-hidden="true" style={{
                  flex: "none", width: 22, height: 22, borderRadius: "50%", marginTop: 1,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 12, fontWeight: 700, color: C.muted,
                  background: "color-mix(in srgb, var(--text) 7%, transparent)",
                }}>{i + 1}</span>
                <span>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: C.text }}>{s.title}</div>
                  <div style={{ fontSize: 12.5, color: C.muted, marginTop: 2, lineHeight: 1.6 }}>
                    {s.sub}
                  </div>
                </span>
              </li>
            ))}
          </ol>
          {!dispatched && canJudge && (
            <div style={{ marginTop: 6, fontSize: 12.5, color: C.muted, lineHeight: 1.65 }}>
              {/* ⚠️ 不说「近期变更」（review B22）：手动载荷里没有变更事件，成员账号的
                  DA 也够不到那个账号去取。 */}
              {zh ? "拿不准？用下方按钮派一次 AI 判读，结合这台的指标与配置给出处置建议。"
                : "Not sure? Request an AI analysis below for advice based on this resource's metrics and configuration."}
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 30, borderBottom: `1px solid ${C.line}` }}>
        {breakdown ? (
          <Fold title={zh ? "评分明细" : "Score breakdown"}
            right={row.idle_score !== null
              ? (zh ? `${row.idle_score.toFixed(1)} / 100 · ${nFactors} 维计分`
                : `${row.idle_score.toFixed(1)}/100 · ${nFactors} dimensions`)
              : undefined}>
            {breakdown}
            {methodBox}
          </Fold>
        ) : methodBox ? (
          <Fold title={zh ? "判定方式" : "How this was decided"}>{methodBox}</Fold>
        ) : null}
        <Fold title={zh ? "诊断信息" : "Diagnostics"}
          right={zh ? "规则码 · 版本 · 状态机计数" : "rule · version · counters"}>
          {diagnostics}
        </Fold>
      </div>
    </>
  );
}
