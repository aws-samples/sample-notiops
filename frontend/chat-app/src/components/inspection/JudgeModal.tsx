/**
 * 「深入分析」的确认弹窗 —— 派一次 DA 判读（2026-08-31，2026-10 文案重写）。
 *
 * ## 为什么要有这个弹窗
 *
 * 上一版把备注输入框放在详情面板**正文中间**，而 `[深入分析]` 钉在面板底部的
 * footer 里 —— 两者隔了约 350px。用户原话：「这两个相隔这么远，用户知道他俩是
 * 一起的吗？」弹窗把备注与动作放进同一块，并给这个花钱的动作一次确认
 * （按秒计费，派了之后不给再派）。
 *
 * ## 2026-10 重写：客户原话「这里面废话真多」
 *
 * 旧版一屏是：资源卡（小写 `rds`、`97.3/100`）→「会做什么」标题 + 两行
 * （「回填」「派」这类内部词）→ 备注框 → 单独一行 `0/1000` → 两行提示。
 * 现在只回答确认前要知道的三件事：
 *
 * ```
 * 分析的是哪一条        资源卡：名字 + 标签 / 服务 · 规格 · region / 省多少或实测值
 * 会发生什么            一句话（写出真实账号号）+ 一行「时长 · 计费 · 不可撤回」
 * 我能补充什么          备注框 + 一行提示（计数器在右侧，开始输入才出现）
 * ```
 *
 * ## 这里**不发任何请求**
 *
 * 全部读 `row` 上已有的字段。弹窗要立刻出来 —— 打开时转个圈再显示内容，
 * 等于把「确认」这件事变成一次等待。
 */

import { useState } from "react";

import { type FindingRow, OPERATOR_NOTE_LIMIT } from "../../api/inspection";
import { useLocale, useT } from "../../i18n";
import { metricLabel } from "../inspectionMetricLabels";
import { evidenceText, fmtMoney, isCoarse, PRECISION_LABEL } from "./format";
import { FindingTag } from "./IdleDetail";
import { PRECISION_SHORT } from "./idleDetailUtil";
import { CAPACITY_RULE_LABEL, serviceLabel } from "./idleTableUtil";
import { Btn, Modal, SevBadge } from "./ui";
import { C, input } from "./tokens";

const muted: React.CSSProperties = { fontSize: 12, color: C.muted };

/**
 * 按 finding 类型选文案档位 ——「会发生什么」那一句与备注框的示例都按它分。
 * 🔴 闲置的问法与示例（「灾备备库，平时没流量」）放到一条高负载上是错话。
 */
function variant(row: FindingRow): "idle" | "capacity" | "high_load" | "structural" {
  if (row.kind === "idle") return CAPACITY_RULE_LABEL[row.rule] ? "capacity" : "idle";
  return row.kind === "high_load" ? "high_load" : "structural";
}

/** 资源卡第三行：闲置给「每月可省」，别的给「实测值 vs 阈值」。都没有就不渲染。 */
function KeyFact({ row, zh }: { row: FindingRow; zh: boolean }) {
  if (row.kind === "idle") {
    // 🔴 金额只在**有值**时渲染。补一个 0 会让「没有这个数」与「这个数是 0」混掉。
    if (row.savings_usd === null) return null;
    const coarse = !!row.savings_precision && isCoarse(row.savings_precision);
    const short = PRECISION_SHORT[row.savings_precision]?.[zh ? "zh" : "en"];
    return (
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 12 }}>
        <span style={muted}>{zh ? "每月可省" : "Monthly saving"}</span>
        <b style={{ fontSize: 17, color: C.green, fontVariantNumeric: "tabular-nums" }}>
          {fmtMoney(row.savings_usd)}
        </b>
        {coarse && (
          <span title={PRECISION_LABEL[row.savings_precision]?.[zh ? "zh" : "en"]}
            style={{ fontSize: 12, color: C.amber }}>
            {zh ? "粗估" : "coarse"}{short ? ` · ${short}` : ""}
          </span>
        )}
      </div>
    );
  }
  const ev = evidenceText(row, zh);
  if (!ev) return null;
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 12,
      flexWrap: "wrap" }}>
      <span style={muted} title={row.metric || undefined}>
        {row.metric ? metricLabel(row.metric, zh) : (zh ? "实测值" : "Observed")}
      </span>
      <b style={{ fontSize: 15, color: C.text, fontVariantNumeric: "tabular-nums" }}>
        {ev.value}
      </b>
      <span style={muted}>
        {ev.relation ? `${ev.relation} ${ev.threshold}` : `${zh ? "阈值" : "threshold"} ${ev.threshold}`}
      </span>
    </div>
  );
}

export default function JudgeModal({
  row, onCancel, onConfirm, busy = false,
}: {
  row: FindingRow;
  onCancel: () => void;
  /** 确认派发。`note` 已 trim；空串表示不带备注。 */
  onConfirm: (note: string) => void;
  /** 派发中 —— 按钮 loading，且遮罩/Esc 都不关（请求还在发）。 */
  busy?: boolean;
}) {
  const t = useT();
  const { locale } = useLocale();
  const zh = locale !== "en";
  const [note, setNote] = useState("");
  const nearLimit = note.length >= OPERATOR_NOTE_LIMIT * 0.9;
  const v = variant(row);

  return (
    <Modal width={540}
      title={zh ? "深入分析" : "Investigate"}
      onClose={onCancel}
      /* 🔴 `lockClose` 在派发中挡住 Esc 与遮罩点击 —— 请求还在发，
            关掉之后 `onConfirm` 的回调仍然会跑，而那时组件已经卸载。
         🔴 `dirty` 在填了备注时挡住**遮罩点击**（Esc 仍可关）——
            误点遮罩丢掉一段刚写的背景说明是纯粹的损失。 */
      lockClose={busy}
      dirty={note.trim().length > 0}
      footer={
        <>
          <Btn variant="link" onClick={onCancel}
            disabledReason={busy ? (zh ? "正在提交…" : "Submitting…") : ""}>
            {t("insp.act.cancel")}
          </Btn>
          <Btn variant="primary" loading={busy}
            onClick={() => onConfirm(note.trim())}>
            {t("insp.judge.go")}
          </Btn>
        </>
      }>

      {/* ── 分析的是哪一条 ──
          ⚠️ 名字在前、标签在后，与表格一行、抽屉标题的读序一致。
          ⚠️ 服务名走 `serviceLabel`（`rds` → `RDS`），闲置分走 `FindingTag`
             （`闲置 97`）—— 旧版的 `97.3/100` 精度对确认这一步没有意义。 */}
      <div style={{
        borderRadius: 10, padding: "14px 16px",
        background: "color-mix(in srgb, var(--text) 4%, transparent)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: C.text,
            wordBreak: "break-all", flex: 1, minWidth: 0 }}>
            {row.instance}
          </span>
          {row.kind === "idle"
            ? <FindingTag f={row} zh={zh} />
            : <SevBadge sev={row.severity} label={t(`insp.sev.${row.severity}`)} />}
        </div>
        <div style={{ ...muted, marginTop: 4 }}>
          {[serviceLabel(row.service), row.instance_class, row.region]
            .filter(Boolean).join(" · ")}
        </div>
        <KeyFact row={row} zh={zh} />
      </div>

      {/* ── 会发生什么 ──
          🔴 必须写出**真实的账号号**。客户实测时问过「我这个深入分析是在哪个
             账号内进行的」—— 旧实现用的是聊天页顶部选择器的账号（缺陷，已修）；
             之后的文案写「这个资源所在的账号」，一个抽象指代等于没回答。
          🔴 「按秒计费 · 不能撤回」那一行也必须在：这是确认弹窗存在的理由。 */}
      <div style={{ marginTop: 18, fontSize: 13, lineHeight: 1.7, color: C.text }}>
        {t(`insp.judge.what.${v}`).replace("{where}", row.account_id || "—")}
      </div>
      <div style={{ ...muted, marginTop: 6, lineHeight: 1.6 }}>
        {t("insp.judge.terms")}
      </div>

      {/* ── 补充说明（可选）── */}
      <label style={{ display: "block", marginTop: 20 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>
          {t("insp.judge.noteLabel")}
        </div>
        <textarea value={note}
          onChange={(e) => setNote(e.target.value.slice(0, OPERATOR_NOTE_LIMIT))}
          maxLength={OPERATOR_NOTE_LIMIT}
          placeholder={t(`insp.judge.notePlaceholder.${v}`)}
          rows={3}
          style={{
            ...input, padding: "9px 11px", fontSize: 13, lineHeight: 1.6,
            resize: "vertical", fontFamily: "inherit",
          }} />
      </label>
      {/* 🔴 「它是背景不是指令」这层意思必须在。不说的话客户会写「这台没问题
          别报了」，而严重度是判定层的事 —— skill 那侧的第 6 条硬边界把这句话当成
          **待核实的主张**，但界面上要先说清，否则客户以为填了就能关掉这条，
          结果照样被报，他会认为「填了没用」。
          🔴 计数器：上限是硬的（描述总长 10000，单条载荷本身占 1200~3700），
          所以开始输入就显示、接近上限变琥珀色；空着时不显示 —— 一个孤零零的
          `0/1000` 只是噪音。 */}
      <div style={{ display: "flex", gap: 12, marginTop: 6, alignItems: "baseline" }}>
        <span style={{ ...muted, flex: 1 }}>{t("insp.judge.noteHint")}</span>
        {note.length > 0 && (
          <span style={{ fontSize: 11.5, fontVariantNumeric: "tabular-nums",
            color: nearLimit ? C.amber : C.muted }}>
            {note.length}/{OPERATOR_NOTE_LIMIT}
          </span>
        )}
      </div>
    </Modal>
  );
}
