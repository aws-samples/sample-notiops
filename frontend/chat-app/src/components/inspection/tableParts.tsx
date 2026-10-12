/**
 * 闲置表格与高负载表格共用的小部件（2026-10 高负载页对齐闲置页时从 IdleTable 拆出）。
 *
 * ⚠️ 只导出组件（react-refresh 的约定）。纯函数在 `idleTableUtil.ts` / `highLoadUtil.ts`。
 */

import type { FindingRow, Severity } from "../../api/inspection";
import { degradeTitle, judgementState, parseStatusLabel, verdictLabel } from "./format";
import { C, SEV_COLOR } from "./tokens";

/** 单行的小标签。比 `Badge` 高一点、带底色 —— 它是这一列的主要内容，不是附注。 */
export function Tag({ children, tone, title, ariaLabel }: {
  children: React.ReactNode;
  tone: "neutral" | "amber" | "idle";
  title?: string;
  ariaLabel?: string;
}) {
  const s: React.CSSProperties = tone === "amber"
    ? { color: C.amber, background: "color-mix(in srgb, #b7791f 12%, transparent)" }
    : tone === "idle"
      ? { color: C.text, background: "color-mix(in srgb, var(--orange) 13%, transparent)" }
      : { color: C.muted, background: "color-mix(in srgb, var(--text) 7%, transparent)" };
  return (
    <span title={title} aria-label={ariaLabel ?? title} style={{
      ...s, display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0,
      height: 24, padding: "0 9px", borderRadius: 6, fontSize: 12, fontWeight: 500,
    }}>{children}</span>
  );
}

/**
 * 严重度标签：色点 + 文字，淡底色。与闲置页「闲置 97」标签同一形状。
 *
 * ⚠️ 文字色单独取一档更深的：`SEV_COLOR.MEDIUM`（#f59e0b）直接当文字色在浅底上
 *    对比度只有 2:1 左右，读不清。色点仍用 `SEV_COLOR`，与 KPI 分段条一致。
 * ⚠️ 档位靠文字表达（「紧急 / 高 / 中」），颜色只是辅助。
 */
const SEV_TEXT: Record<Severity, string> = {
  CRITICAL: "#d13212", HIGH: "#c2410c", MEDIUM: "#b7791f", INFO: "var(--muted)",
};

export function SevTag({ sev, label, small = false }: {
  sev: Severity; label: string; small?: boolean;
}) {
  const c = SEV_COLOR[sev] ?? SEV_COLOR.INFO;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
      height: small ? 22 : 24, padding: "0 9px", borderRadius: 6,
      fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
      color: SEV_TEXT[sev] ?? C.muted,
      background: `color-mix(in srgb, ${c} 12%, transparent)`,
    }}>
      <span aria-hidden="true" style={{
        width: 7, height: 7, borderRadius: "50%", background: c, flexShrink: 0,
      }} />
      {label}
    </span>
  );
}

/**
 * 「已不存在」标签（2026-10-10）。资源被删除后它的 finding 在下一次正式巡检前还挂着，
 * 行上必须一眼看得出来 —— 否则客户照着「每月可省 $387」去找一台已经没了的库。
 */
export function GoneTag({ on, zh }: { on: string; zh: boolean }) {
  const title = zh
    ? `${on ? `${on} 核实：` : ""}账号里查不到这台资源，它已经被删除。不计入合计。`
    : `${on ? `Checked ${on}: ` : ""}this resource no longer exists in the account.`;
  return <Tag tone="amber" title={title}>{zh ? "已不存在" : "Gone"}</Tag>;
}

/**
 * 已「移出巡检范围」、正式巡检还没关掉它（review B7）。不计入合计、不给「深入分析」。
 * ⚠️ 中性色不是琥珀：这是客户自己的决定，不是问题。
 */
export function ExcludedTag({ until, zh }: { until: string; zh: boolean }) {
  const title = zh
    ? `已移出巡检范围${until ? `（到 ${until}）` : ""}，不计入合计。`
    : `Removed from scope${until ? ` until ${until}` : ""}; not counted.`;
  return <Tag tone="neutral" title={title}>{zh ? "已移出范围" : "Out of scope"}</Tag>;
}

/** 判读那一格。七档判据与 FindingCard 同源（`judgementState`）。 */
export function JudgementCell({ f, zh, t, state }: {
  f: FindingRow; zh: boolean; t: (k: string) => string;
  state: ReturnType<typeof judgementState>;
}) {
  if (state === "ok") {
    // 🔴 闲置轮**不自动派** AI（`gating.DETERMINISTIC_RUN_TYPES`）。那一页上出现的
    //    判读一定是客户在详情里手点派的 —— 标「手动」，否则与副标题的
    //    「规则判定，不派 AI 判读」直接矛盾（2026-10 客户截图里就是这样）。
    //    高负载轮本来就自动派，不标。
    const caveats = f.da_gate_trustworthy === true && (f.da_degradations?.length ?? 0) > 0;
    return (
      <>
        <b title={f.da_verdict} style={{ fontWeight: 600, color: C.text,
          overflow: "hidden", textOverflow: "ellipsis" }}>
          {verdictLabel(f.da_verdict, t)}
        </b>
        {f.kind === "idle" && (
          <span style={{ fontSize: 11, color: C.muted, flexShrink: 0 }}>
            {zh ? "手动" : "manual"}
          </span>
        )}
        {f.da_gate_trustworthy === false && (
          <span title={degradeTitle(f, zh, t)} style={{ color: C.red, fontSize: 12, flexShrink: 0 }}>
            {t("insp.gate.badgeUntrusted")}
          </span>
        )}
        {caveats && (
          /* 门禁有保留意见：细节在抽屉里逐条列，这里只给一个能悬停的提示。
             ⚠️ 条数进 `aria-label`（读屏与测试按它找），面上只留一个 ⚠ ——
                一格 150px 放不下「判读有降级 2 ⓘ」与结论并排。 */
          <span title={degradeTitle(f, zh, t)}
            aria-label={t("insp.gate.badgeCaveats")
              .replace("{n}", String(f.da_degradations?.length ?? 0))}
            style={{ color: C.amber, flexShrink: 0 }}>⚠</span>
        )}
      </>
    );
  }
  if (state === "pending") {
    return <span style={{ color: C.amber }} title={t("insp.judge.dispatched")}>{t("insp.judge.badge")}</span>;
  }
  if (state === "failed") {
    return (
      <span style={{ color: C.amber, overflow: "hidden", textOverflow: "ellipsis" }}
        title={f.da_parse_status ? parseStatusLabel(f.da_parse_status, t) : undefined}>
        {t("insp.judge.failed")}
      </span>
    );
  }
  if (state === "partial") {
    return (
      <span style={{ color: C.amber, overflow: "hidden", textOverflow: "ellipsis" }}
        title={f.da_parse_status ? parseStatusLabel(f.da_parse_status, t) : undefined}>
        {t("insp.degraded.partialNoVerdict")}
      </span>
    );
  }
  // 🔴 常态：规则判定（闲置轮恒为这一档；高负载里是沿用 / 命中已知模式）。
  //    每行都一样 = 零信息量，不渲染 —— 那句结论在抽屉里。
  if (state === "rule" || state === "not_needed") return null;
  // 真的缺判读（budget / quota / kill_switch）—— R12.4 要求标出来。
  return (
    <span style={{ color: C.amber }} title={f.skip_reason || undefined}>
      {t("insp.degraded.title")}
    </span>
  );
}
