/**
 * 保存条（A-1 / A-3）：固定在内容栏底部，**只在**有未保存修改、保存失败、刚保存完时出现。
 *
 * 三种态：
 *   dirty   「N 处未保存的修改」+ 摘要 + 「保存时自动检查…ⓘ」+ 放弃 / 保存。
 *           结构性预检没过时，右边那句换成「还不能保存 · 第一条原因」（红、可截断、全文在 title），
 *           并禁用保存（取代旧版那个大红框）。
 *   fail    服务端保存时现场探测没过（A-3）：哪一个来源的哪一个模型、什么结果、为什么（ⓘ 默认展开），
 *           出路：换默认模型 /（第一来源被改过时）只保存模型改动、来源仍以原来的第一 / 重试保存
 *           （在页面外修好了原因 —— 网关补了上游凭证、网络恢复 —— 同一份草稿要能再存）。409 → 重新载入。
 *   notice  刚保存完：成功（5 秒后自动消失）/ 保存了但有提醒（手动关）。
 *
 * 版面：左边说明（`.l`）+ 右边按钮（`.r`）。放不下一行时右边整组换到第二行（右对齐），
 * 而不是把按钮挤出屏幕或压到抽屉底下；说明里先截前面那句，实在放不下再截 model_id / 红标签
 * （带省略号，全文在 title）。红标签是短词，整句原因在 ⓘ 里。
 * 保存请求在路上时（locked）页面上改草稿的控件全部禁用，左边说明换成「保存中，暂时不能修改」——
 * 否则途中改的那一处会让失败挂在旧签名上、被吞掉。
 *   fail 态的「只保存模型改动」按**已保存的次序**再跑一遍结构性预检，不成立就禁用并说出原因。
 */
import { useLocale, useT } from "../../i18n";
import type { LlmSaveProbe, LlmSource } from "../../api/admin";
import { Btn, InfoTip, Tag } from "./ui";
import { gatewayUpstreamName, resultTip, testLabel } from "./logic";

export type SaveBarState =
  /** `saving` 禁用按钮（凭证保存也算）；`locked` = 这一份草稿正在保存：按钮显示「正在检查…」，左边说明换成「保存中」。 */
  | { mode: "dirty"; count: number; summary: string; gwFirst: boolean; blockers: string[]; saving: boolean; locked: boolean;
      onDiscard: () => void; onSave: () => void }
  /** `keepBlocked` = 按已保存次序算出的结构性预检原因；非空时「只保存模型改动」禁用并说出原因（它必然被服务端拒）。 */
  | { mode: "fail"; probe?: LlmSaveProbe; message: string; conflict: boolean; keepOrder: LlmSource | null;
      keepBlocked: string[]; saving: boolean; onChangeDefault: () => void; onKeepOrder: () => void; onRetry: () => void;
      onReload: () => void; onDiscard: () => void }
  | { mode: "notice"; kind: "ok" | "warn"; text: string; onClose: () => void };

export default function SaveBar({ state, left, withDrawer }: { state: SaveBarState; left: number; withDrawer: boolean }) {
  const t = useT();
  const { locale } = useLocale();
  const cls = `mdl-bar ${state.mode}${state.mode === "fail" ? " err" : ""}${withDrawer ? " with-drawer" : ""}`;
  const style = { left };

  if (state.mode === "notice") {
    return (
      <div className={cls} style={style} role="status">
        <div className="l">
          <span className={state.kind === "ok" ? "mdl-oki" : "mdl-warni"} aria-hidden>{state.kind === "ok" ? "✓" : "!"}</span>
          <span className="mid" title={state.text}>{state.text}</span>
        </div>
        <div className="r"><Btn className="sm" onClick={state.onClose}>{t("admin.models.close")}</Btn></div>
      </div>
    );
  }

  if (state.mode === "fail") {
    const p = state.probe;
    let body;
    if (state.conflict) {
      body = <span className="mid" title={t("admin.models.conflict")}>{t("admin.models.conflict")}</span>;
    } else if (p) {
      const gw = p.source === "gateway";
      const label = testLabel(p.result, t, gw);
      const tip = resultTip(p.result, t, gw);
      const up = p.result === "upstream_auth" ? gatewayUpstreamName(p.model_id) : null;
      // 标签是短词；整句（为什么、该怎么办）放进 ⓘ。
      const why = p.result === "upstream_auth"
        ? (up ? t("admin.models.fail.upstreamAuth").replaceAll("{upstream}", up) : t("admin.models.fail.upstreamAuthGeneric"))
        : [t("admin.models.saveProbeFailed").replace("{source}", t(`admin.models.src.${p.source}`)).replace("{result}", label),
           tip !== label ? tip : ""].filter(Boolean).join(locale === "en" ? " " : "");
      const checked = t(`admin.models.bar.checked.${p.source}`);
      body = (
        <>
          {/* 位置不够时先截前面那句说明，再截 model_id / 标签（都带省略号，全文在 title）—— 按钮永远不被挤出去 */}
          <span className="mid mdl-mut" title={checked}>{checked}</span>
          <code className="id" title={p.model_id}>{p.model_id}</code>
          <Tag kind="err" title={label}>{label}</Tag>
          <InfoTip label={label} title={label} text={why} defaultOpen side="up" align="center" />
        </>
      );
    } else {
      body = <span className="mid mdl-errtxt" title={state.message}>{state.message}</span>;
    }
    const keep = p && state.keepOrder ? t(`admin.models.bar.keepOrder.${state.keepOrder}`) : "";
    const keepBlocked = keep ? state.keepBlocked : [];
    return (
      <div className={cls} style={style} role="alert">
        <div className="l">
          <span className="mdl-xi" aria-hidden>✕</span>
          <b className="hd">{t("admin.models.bar.notSaved")}</b>
          {body}
        </div>
        <div className="r">
          {state.conflict ? (
            <Btn className="pri" onClick={state.onReload}>{t("admin.models.bar.reload")}</Btn>
          ) : (
            <>
              <Btn onClick={state.onDiscard} disabled={state.saving}>{t("admin.models.bar.discard")}</Btn>
              <Btn className={p ? "" : "pri"} onClick={state.onRetry} disabled={state.saving}>
                {state.saving ? t("admin.models.bar.checking") : t("admin.models.bar.retry")}
              </Btn>
              {p && <Btn className="pri" onClick={state.onChangeDefault} disabled={state.saving}>{t("admin.models.bar.changeDefault")}</Btn>}
              {/* 按已保存的次序这份草稿不成立（比如 Bedrock 条目的 Web 都取消了）：按钮禁用，原因写在它旁边 */}
              {keepBlocked.length > 0 && (
                <span className="blocked" role="status" title={keepBlocked.join("\n")}>{keepBlocked[0]}</span>
              )}
              {keep && (
                <Btn className="shrink" onClick={state.onKeepOrder} disabled={state.saving || keepBlocked.length > 0}
                  title={keepBlocked.length ? `${keep}\n${keepBlocked.join("\n")}` : keep}>
                  <span className="mdl-ell">{keep}</span>
                </Btn>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  const blocked = state.blockers.length > 0;
  const probeKey = state.gwFirst ? "admin.models.bar.probeGw" : "admin.models.bar.probe";
  const blockText = blocked ? `${t("admin.models.cannotSave")} · ${state.blockers[0]}` : "";
  const lockText = t("admin.models.bar.savingLocked");
  return (
    <div className={cls} style={style}>
      <div className="l">
        <span className="mdl-dot" aria-hidden />
        <b className="hd" title={state.summary || undefined}>{t("admin.models.bar.dirty").replace("{n}", String(state.count))}</b>
        {/* 保存请求在路上：页面上改草稿的控件都已禁用，这里说一声为什么（抽屉开着也显示） */}
        {state.locked && <span className="mid mdl-mut" role="status" title={lockText}>{lockText}</span>}
        {!state.locked && !withDrawer && state.summary && <span className="mid mdl-mut" title={state.summary}>{state.summary}</span>}
        {/* 抽屉开着时摘要不显示，「还不能保存」挪到左边那一格（可截断），按钮组保持只有两个按钮 */}
        {blocked && withDrawer && <span className="mid blocked" role="status" title={state.blockers.join("\n")}>{blockText}</span>}
      </div>
      <div className="r">
        {blocked && !withDrawer && <span className="blocked" role="status" title={state.blockers.join("\n")}>{blockText}</span>}
        {!blocked && !withDrawer && (
          <>
            <span className="hint mdl-faint mdl-smt" title={t(probeKey)}>{t(probeKey)}</span>
            <InfoTip label={t(probeKey)} text={t(state.gwFirst ? "admin.models.bar.probeGwTip" : "admin.models.bar.probeTip")}
              side="up" align="end" />
          </>
        )}
        <Btn onClick={state.onDiscard} disabled={state.saving}>{t("admin.models.bar.discard")}</Btn>
        <Btn className="pri" onClick={state.onSave} disabled={state.saving || blocked}>
          {state.locked ? t("admin.models.bar.checking") : t("admin.models.save")}
        </Btn>
      </div>
    </div>
  );
}
