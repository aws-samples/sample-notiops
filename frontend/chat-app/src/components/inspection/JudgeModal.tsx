/**
 * 「深入分析」的确认弹窗 —— 派一次 DA 判读（2026-08-31）。
 *
 * ## 为什么要有这个弹窗
 *
 * 上一版把备注输入框放在详情面板**正文中间**，而 `[深入分析]` 钉在面板底部的
 * footer 里 —— 两者隔了约 350px，中间还夹着「指标曲线在后续版本提供」这种无关
 * 内容。用户原话：「这两个相隔这么远，用户知道他俩是一起的吗？」不知道。
 *
 * 弹窗一次解决三件事，不只是那个距离问题：
 *
 * ```
 * ① 备注与动作在同一块里     绑定关系是视觉上的，不靠文案解释
 * ② 卡片点与面板点行为一致    上一版卡片上那个按钮压根没有备注入口
 * ③ 花钱的动作有确认         按秒计费，而且派了之后不给再派（已派过就不渲染按钮）
 * ```
 *
 * ## 这里**不发任何请求**
 *
 * 顶部那几行（资源名 / 账号 / 闲置分 / 预计月省）全部读 `row` 上已有的字段。
 * 弹窗要立刻出来 —— 打开时转个圈再显示内容，等于把「确认」这件事变成一次等待。
 */

import { useState } from "react";

import { type FindingRow, OPERATOR_NOTE_LIMIT } from "../../api/inspection";
import { useLocale, useT } from "../../i18n";
import { fmtMoney } from "./format";
import { Btn, Modal } from "./ui";
import { C } from "./tokens";

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

  const kv = (label: string, value: React.ReactNode) => (
    <div style={{ display: "flex", gap: 8, fontSize: 12.5, lineHeight: 1.9 }}>
      <span style={{ color: C.muted, minWidth: 76 }}>{label}</span>
      <span style={{ color: C.text }}>{value}</span>
    </div>
  );

  return (
    <Modal width={560}
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
            disabledReason={busy ? (zh ? "正在派发…" : "Dispatching…") : ""}>
            {t("insp.act.cancel")}
          </Btn>
          <Btn variant="primary" loading={busy}
            onClick={() => onConfirm(note.trim())}>
            {t("insp.judge.go")}
          </Btn>
        </>
      }>

      {/* ── 这一条是什么 ──
          ⚠️ 全部读 `row` 上已有的字段，**不发请求**。 */}
      <div style={{
        border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px",
      }}>
        <div style={{ fontWeight: 600, fontSize: 13.5, color: C.text,
          wordBreak: "break-all" }}>
          {row.instance}
        </div>
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
          {[row.service, row.region, row.account_id].filter(Boolean).join(" · ")}
        </div>
        <div style={{ marginTop: 7 }}>
          {/* 🔴 闲置分与金额只在**有值**时渲染。高负载 / 配置检查那两类没有
              这两个概念，补一个 0 会让「没有这个数」与「这个数是 0」混掉。 */}
          {row.idle_score !== null && kv(
            zh ? "闲置分" : "Idle score", `${row.idle_score.toFixed(1)}/100`)}
          {row.savings_usd !== null && kv(
            zh ? "预计月省" : "Est. saving",
            <b style={{ color: C.green }}>{fmtMoney(row.savings_usd)}</b>)}
          {row.metric && row.metric !== "-" && row.observed_value !== null && kv(
            row.metric,
            `${row.observed_value}${row.unit || ""}`
            + (row.threshold_value !== null
              ? `（阈值 ${row.threshold_value}${row.unit || ""}）` : ""))}
        </div>
      </div>

      {/* ── 会做什么 ──
          🔴 「在哪个账号里跑」必须写出来，而且要写**真实的账号号**。
             客户实测时问过「我这个深入分析是在哪个账号内进行的」——
             旧实现的答案是「聊天页顶部选择器选的那个账号」（与这条 finding
             无关，是个缺陷）。现在行为对了，但文案原来写的是「这个资源所在的
             账号」—— 一个抽象指代等于没回答那个问题。 */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text,
          marginBottom: 4 }}>
          {zh ? "会做什么" : "What happens"}
        </div>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.75,
          whiteSpace: "pre-line" }}>
          {t("insp.judge.what").replace(
            "{where}",
            [row.account_id, row.region].filter(Boolean).join(" · "))}
        </div>
      </div>

      {/* ── 补充背景（可选）── */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text,
          marginBottom: 4 }}>
          {t("insp.judge.noteLabel")}
        </div>
        <textarea value={note}
          onChange={(e) => setNote(e.target.value.slice(0, OPERATOR_NOTE_LIMIT))}
          maxLength={OPERATOR_NOTE_LIMIT}
          placeholder={t("insp.judge.notePlaceholder")}
          rows={3}
          style={{
            width: "100%", boxSizing: "border-box", padding: "8px 10px",
            borderRadius: 8, border: `1px solid ${C.line}`,
            background: "var(--bg)", color: C.text, fontSize: 12.5,
            lineHeight: 1.6, resize: "vertical",
          }} />
        {/* 🔴 计数器要显示 —— 上限是硬的（描述总长 10000，单条载荷本身占
            1200~3700）。不显示的话客户写到被截断都不知道。 */}
        <div style={{ fontSize: 11, color: C.muted, textAlign: "right",
          marginTop: 2 }}>
          {note.length}/{OPERATOR_NOTE_LIMIT}
        </div>
        {/* 🔴 「它是背景不是指令」这句必须在。不说的话客户会写「这台没问题
            别报了」，而严重度是判定层的事 —— skill 那侧的第 6 条硬边界就是
            为此加的（它把这句话当成**待核实的主张**），但界面上要先说清，
            否则客户以为填了就能关掉这条 finding，结果照样被报，
            他会认为「填了没用」。 */}
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6,
          whiteSpace: "pre-line" }}>
          {t("insp.judge.noteHint")}
        </div>
      </div>
    </Modal>
  );
}
