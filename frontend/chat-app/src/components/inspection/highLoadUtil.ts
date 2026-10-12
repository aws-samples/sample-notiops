/**
 * 高负载表格、KPI 与「结论先行」抽屉用的纯函数（2026-10 高负载页对齐闲置页）。
 *
 * ⚠️ 单独成文件：组件文件只导出组件（react-refresh 的约定）。
 * ⚠️ 这里**不许**出现 CloudWatch 指标名字面量 —— 方向、单位全部读后端给的字段
 *    （`direction` / `unit`），指标显示名走 `metricLabel`。
 */

import type { FindingRow } from "../../api/inspection";
import { metricLabel } from "../inspectionMetricLabels";
import { evidenceText, judgementState, staleEvidenceText } from "./format";

/** `2026-09-13` → `9/13`。表格一格放不下「数据截至 2026-09-13（3 天前）」。 */
export function monthDay(iso: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${Number(m[1])}/${Number(m[2])}` : (iso || "");
}

/**
 * 证据不是本轮的时候，表格里那个短标注（「截至 8/10」）。完整一句放 `title`。
 * 返回 `null` = 证据就是本轮的，**不标注**（每行都挂一个「截至今天」是噪音）。
 */
export function staleShort(f: FindingRow, zh: boolean): { short: string; full: string } | null {
  const full = staleEvidenceText(f, zh);
  if (!full) return null;
  const d = monthDay(f.evidence_as_of);
  return { short: zh ? `截至 ${d}` : `as of ${d}`, full };
}

/**
 * 越线多少。`headroom = (阈值 - 实测) / |阈值|`（方向已由后端换算过），
 * 越线时必然 ≤ 0。负值说「超出 34%」，正值才叫「余量」。
 *
 * ⚠️ 「余量 -34%」读起来像「剩余容量是负的」，客户要反应一下才明白是超了。
 */
export function breachText(f: FindingRow, zh: boolean): string {
  if (f.headroom === null || !Number.isFinite(f.headroom)) return "";
  const pct = (Math.abs(f.headroom) * 100).toFixed(0);
  if (f.headroom < 0) return zh ? `超出 ${pct}%` : `${pct}% over`;
  return zh ? `余量 ${pct}%` : `${pct}% headroom`;
}

/** 指标的显示名。没有指标名时给一个中性说法（结构性风险 / 存量行）。 */
export function metricName(f: FindingRow, zh: boolean): string {
  return f.metric ? metricLabel(f.metric, zh) : (zh ? "指标" : "Metric");
}

/**
 * 抽屉顶部那一句结论（规则层面的事实，不是 AI 的话）。
 *
 * ```
 * 内存碎片率连续 3 轮高于阈值 3，最近一次 4.02（9/13）。
 * 可用内存本轮低于阈值 10%，最近一次 4.1%（10/8）。
 * ```
 *
 * 🔴 「高于 / 低于」只来自后端 `direction`（`evidenceText` 的 `relation`）。
 *    没有方向时**不猜**，改说「越过阈值」—— 猜错的表现是 FreeableMemory 被写成
 *    「高于阈值 20%」，句子通顺，结论正好反了。
 */
export function highSummaryLine(f: FindingRow, zh: boolean): string {
  const name = metricName(f, zh);
  const ev = evidenceText(f, zh);
  const hits = f.consecutive_hits ?? 0;
  const runs = hits > 1 ? (zh ? `连续 ${hits} 轮` : ` for ${hits} runs`) : (zh ? "本轮" : "");
  if (!ev) {
    return zh ? `${name}${runs}越过阈值，这条发现没有记录实测值。`
      : `${name} crossed its threshold${runs}; no measured value was recorded.`;
  }
  const rel = ev.relation || (zh ? "越过阈值" : "past threshold");
  const when = f.evidence_as_of ? `（${monthDay(f.evidence_as_of)}）` : "";
  const stale = staleEvidenceText(f, zh)
    ? (zh ? "本轮未命中，但水位没回到健康区。" : " Not hit this run, but not back to healthy.")
    : "";
  if (zh) {
    return `${name}${runs}${rel} ${ev.threshold}，最近一次 ${ev.value}${when}。${stale}`;
  }
  return `${name} ${rel} ${ev.threshold}${runs}; latest ${ev.value}`
    + `${f.evidence_as_of ? ` (${monthDay(f.evidence_as_of)})` : ""}.${stale}`;
}

/**
 * KPI「AI 判读」那张卡的计数。按**行**（一台资源 = 它最严重的那条）算，与表格一致。
 *
 * ⚠️ `rule` / `not_needed` 不计入任何一档：沿用 / 命中已知模式的那几条有规则结论，
 *    不是「AI 说了什么」，也不是「AI 没判」。
 */
export interface AiTally {
  real: number; expected: number; warmup: number; insufficient: number;
  pending: number; missing: number; failed: number;
}

export function tallyAi(rows: FindingRow[], judged: (f: FindingRow) => boolean): AiTally {
  const n: AiTally = {
    real: 0, expected: 0, warmup: 0, insufficient: 0, pending: 0, missing: 0, failed: 0,
  };
  for (const f of rows) {
    const s = judgementState(f, { dispatched: judged(f) });
    if (s === "ok") {
      if (f.da_verdict === "real_degradation") n.real += 1;
      else if (f.da_verdict === "expected_behaviour") n.expected += 1;
      else if (f.da_verdict === "warm_up") n.warmup += 1;
      else n.insufficient += 1;
    } else if (s === "pending") n.pending += 1;
    else if (s === "missing") n.missing += 1;
    else if (s === "failed" || s === "partial") n.failed += 1;
  }
  return n;
}
