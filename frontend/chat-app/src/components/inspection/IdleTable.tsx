/**
 * 「闲置与成本」页的表格视图（2026-10 看板改版，第二版）。
 *
 * ## 这一版的三条原则
 *
 * ```
 * ① 一行一台资源，一行一个高度     多行单元格（指标两行 + 徽章一行）让每行高矮不一，
 *                                  眼睛没法沿一条水平线扫过去 —— 客户原话
 *                                  「为什么在一行 单row内要做多行的展示？」
 * ② 列表只放「比较用」的字段        资源 / 服务 / 区域 / 发现了什么 / 多久了 / 能省多少。
 *                                  指标实测值、缺了哪一维、评分怎么算的 —— 那是
 *                                  「为什么」，点开抽屉看（抽屉里本来就有完整明细）
 * ③ 只显示例外，不显示常态          「规则判定」每行都是同一句 = 零信息量，删掉；
 *                                  AI 列只在真派过 / 在派 / 缺判读时才有内容
 * ```
 *
 * 表格下方原来那两段「规则结论：……」也删了：方法说明属于单条的「为什么」，挪进
 * 抽屉（`methodNote`）；页面级的「不派 AI」在副标题里已经说过一次。
 *
 * ## 合并同一台资源
 *
 * 同一台资源的「闲置」与「内存超配」原来是两行（截图里 7 个名字各出现两次），
 * 现在是一行上的两个标签。见 `groupByResource` 的说明。
 *
 * ## 不变的约定（与 FindingCard 同一套）
 *
 * - 整行是一个按钮：`role="button"` + `tabIndex` + Enter / Space；
 *   `data-finding-id` 是这一行打开的那条（primary），深链与测试靠它定位
 * - 判读状态走 `judgementState`（七档），门禁三态判据同 FindingCard
 * - 缺失的数字不渲染成 0
 */

import { useEffect, useRef } from "react";

import type { FindingRow } from "../../api/inspection";
import {
  fmtMoney, idleBadgeKind, idleTierColor, idleTierText, isCoarse,
  judgementState, PRECISION_LABEL,
} from "./format";
import {
  CAPACITY_RULE_LABEL, groupByResource, type ResourceGroup, serviceColor, serviceLabel,
} from "./idleTableUtil";
import { ExcludedTag, GoneTag, JudgementCell, Tag } from "./tableParts";
import { C } from "./tokens";

const ROW_H = 56;

const headCell: React.CSSProperties = {
  fontSize: 12, color: C.muted, fontWeight: 500, whiteSpace: "nowrap",
  overflow: "hidden", textOverflow: "ellipsis",
};
const cell: React.CSSProperties = {
  minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};
const num: React.CSSProperties = {
  ...cell, textAlign: "right", fontVariantNumeric: "tabular-nums",
};

/** 列定义。账号列只在跨账号时出现（单账号部署下那一列恒定不变，是纯噪音）。 */
function columns(showAccount: boolean): string {
  return [
    "minmax(200px,1fr)",          // 资源
    ...(showAccount ? ["116px"] : []),
    "104px",                      // 服务
    "124px",                      // 区域
    "164px",                      // 发现
    "60px",                       // 已持续
    "92px",                       // 月节省
    "minmax(120px,150px)",        // AI 判读
    "12px",                       // ›
  ].join(" ");
}

export default function IdleTable({
  rows, zh, t, highlight, showAccount, onOpen, isJudged, markCoarse, goneDate,
}: {
  rows: FindingRow[];
  zh: boolean;
  t: (k: string) => string;
  highlight: string;
  showAccount: boolean;
  onOpen: (f: FindingRow) => void;
  isJudged: (f: FindingRow) => boolean;
  /** 页面上有粗估也有非粗估时才逐行标「粗估」；全部粗估时 KPI 上已说过。 */
  markCoarse: boolean;
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
      <div style={{ minWidth: showAccount ? 1176 : 1040 }}>
        <div aria-hidden="true" style={{
          display: "grid", gridTemplateColumns: cols, columnGap: 18,
          alignItems: "center", height: 42, padding: "0 20px",
          borderBottom: `1px solid ${C.line}`,
          background: "color-mix(in srgb, var(--text) 3%, transparent)",
        }}>
          <span style={headCell}>{zh ? "资源" : "Resource"}</span>
          {showAccount && <span style={headCell}>{zh ? "账号" : "Account"}</span>}
          <span style={headCell}>{zh ? "服务" : "Service"}</span>
          <span style={headCell}>{zh ? "区域" : "Region"}</span>
          <span style={headCell}>{zh ? "发现" : "Finding"}</span>
          {/* ⚠️ 不写「持续」：那是状态机一档的名字（`insp.state.active`），
              列头用同一个词会让人以为这一列是状态。 */}
          <span style={{ ...headCell, textAlign: "right" }}>{zh ? "已持续" : "Age"}</span>
          <span style={{ ...headCell, textAlign: "right" }}>{zh ? "月节省" : "Monthly"}</span>
          <span style={headCell}>{zh ? "AI 判读" : "AI analysis"}</span>
          <span />
        </div>
        {groups.map((g, i) => (
          <IdleRow key={g.key} g={g} zh={zh} t={t} cols={cols}
            last={i === groups.length - 1}
            highlighted={!!highlight
              && [g.primary, ...g.others].some((f) => f.finding_id === highlight)}
            showAccount={showAccount} onOpen={() => onOpen(g.primary)}
            judged={isJudged(g.primary)} markCoarse={markCoarse}
            gone={goneDate?.(g.primary) ?? null} />
        ))}
      </div>
    </div>
  );
}

function IdleRow({
  g, zh, t, cols, last, highlighted, showAccount, onOpen, judged, markCoarse, gone,
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
  markCoarse: boolean;
  gone: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const f = g.primary;
  const state = judgementState(f, { dispatched: judged });
  // 金额精度跟着「金额是从哪条来的」走（`saving` 取的是最大那条）。
  const pricedBy = [f, ...g.others].find((x) => x.savings_usd === g.saving);

  // 深链落地时滚到可见（与 FindingCard 同一个约定）。
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
        display: "grid", gridTemplateColumns: cols, columnGap: 18,
        alignItems: "center", height: ROW_H, padding: "0 20px",
        borderBottom: last ? undefined : `1px solid ${C.line}`,
        // 深链落地的那一行：左侧蓝条 + 淡蓝底（不靠 outline —— 它会盖住上下两条分隔线）。
        boxShadow: highlighted ? `inset 3px 0 0 ${C.blue}` : undefined,
        background: highlighted ? "color-mix(in srgb, var(--blue) 7%, transparent)" : undefined,
      }}>
      {/* ── 资源：名字 + 规格同一行 ── */}
      <div style={{ ...cell, display: "flex", alignItems: "baseline", gap: 8 }}>
        {/* ⚠️ 空间不够时**先压规格、后压名字**（flexShrink 1 vs 100）：名字是这一行的
            身份，`insp-redis-sharded-0002-…` 被截掉而规格完整显示是反的。 */}
        {/* ⚠️ 名字 `flex: none` + `maxWidth: 100%`：flex-shrink 是按「基准宽 × 系数」分摊的，

            1:100 也会让名字跟着缩一点（实测 `insp-redis-sharded-0002-0…`）。名字不参与收缩，

            只有它自己比整列还宽时才截断；规格吃掉剩下的空间，不够就整段省略。 */}

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

      {/* ── 服务 ── */}
      <div style={{ ...cell, display: "flex", alignItems: "center", gap: 7, fontSize: 12.5,
        color: C.text }}>
        <span aria-hidden="true" style={{
          width: 7, height: 7, borderRadius: 2, flexShrink: 0,
          background: serviceColor(f.service),
        }} />
        {serviceLabel(f.service)}
      </div>

      {/* ── 区域 ── */}
      <div style={{ ...cell, fontSize: 12.5, color: C.muted }}>{f.region}</div>

      {/* ── 发现：每条 finding 一个标签 ── */}
      <div style={{ ...cell, display: "flex", alignItems: "center", gap: 6 }}>
        {/* 🔴 资源已不存在：放在最前面，压过其余标签（它们说的都是一台已经没了的机器）。 */}
        {gone !== null && <GoneTag on={gone} zh={zh} />}
        {gone === null && f.excluded_by && <ExcludedTag until={f.excluded_until || ""} zh={zh} />}
        {[f, ...g.others].map((x) => <FindingTag key={x.finding_id} f={x} zh={zh} t={t} />)}
        {/* 常态（active）不显示；new / resolving / chronic 各意味着不同的动作。 */}
        {gone === null && !f.excluded_by && f.state && f.state !== "active" && (
          <Tag tone="neutral">{t(`insp.state.${f.state}`)}</Tag>
        )}
      </div>

      {/* ── 已持续 ── */}
      <div style={{ ...num, fontSize: 12.5, color: C.text }}
        title={f.first_seen_date
          ? `${t("insp.field.firstSeen")} ${f.first_seen_date}` : undefined}>
        {f.days_active !== null ? `${f.days_active}${t("insp.field.days")}` : "—"}
      </div>

      {/* ── 月节省 ── */}
      <div style={num}>
        {gone !== null || f.excluded_by ? (
          /* 删掉的库省不出钱 —— 不显示金额，也不计入 KPI 合计。 */
          <span style={{ fontSize: 12.5, color: C.muted }}
            title={gone !== null
              ? (zh ? "资源已不存在（未计入合计）" : "resource gone (excluded from total)")
              : (zh ? "已移出巡检范围（未计入合计）" : "out of scope (excluded from total)")}>—</span>
        ) : g.saving !== null ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            {markCoarse && pricedBy?.savings_precision && isCoarse(pricedBy.savings_precision) && (
              <span style={{ fontSize: 11, color: C.amber }}
                title={PRECISION_LABEL[pricedBy.savings_precision]?.[zh ? "zh" : "en"]
                  || pricedBy.savings_precision}>
                {zh ? "粗估" : "coarse"}
              </span>
            )}
            <span style={{ fontSize: 14, fontWeight: 600, color: C.green }}>
              {fmtMoney(g.saving)}
            </span>
          </span>
        ) : (
          <span style={{ fontSize: 12.5, color: C.muted }}
            title={zh ? "估不出价（未计入合计）" : "no price estimate (excluded from total)"}>
            —
          </span>
        )}
      </div>

      {/* ── AI 判读：只有例外才有内容 ── */}
      <div style={{ ...cell, display: "flex", alignItems: "center", gap: 5, fontSize: 12.5 }}>
        <JudgementCell f={f} zh={zh} t={t} state={state} />
      </div>

      <span aria-hidden="true" className="insp-chev"
        style={{ color: C.muted, fontSize: 16, lineHeight: 1 }}>›</span>
    </div>
  );
}

/** 一条 finding 的标签：闲置（带分）/ 判据不足 / 超配。 */
function FindingTag({ f, zh, t }: { f: FindingRow; zh: boolean; t: (k: string) => string }) {
  const cap = CAPACITY_RULE_LABEL[f.rule];
  if (cap) return <Tag tone="neutral">{zh ? cap.zh : cap.en}</Tag>;
  const kind = idleBadgeKind(f);
  if (kind === "undecided") {
    return <Tag tone="amber" title={t("insp.idle.undecidedWhy")}>{t("insp.idle.undecided")}</Tag>;
  }
  if (kind === "score" && f.idle_score !== null) {
    /* 档位进 aria-label（不只靠颜色表达）。 */
    const label = `${zh ? "闲置分" : "Idle score"} ${f.idle_score.toFixed(0)}/100`
      + `（${idleTierText(f.idle_score, zh)}）`;
    /* ⚠️ 分数用 `<b>` 不用 `<span>`：读屏 / 测试从数字往上找最近的 span，
       要落到带 aria-label 的那个标签上，而不是一个没有名字的内层 span。 */
    return (
      <Tag tone="idle" title={label} ariaLabel={label}>
        {zh ? "闲置" : "Idle"}
        <b style={{ color: idleTierColor(f.idle_score), fontWeight: 700,
          fontVariantNumeric: "tabular-nums" }}>
          {f.idle_score.toFixed(0)}
        </b>
      </Tag>
    );
  }
  return <Tag tone="neutral">{f.rule || "—"}</Tag>;
}
