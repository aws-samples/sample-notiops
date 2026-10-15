/**
 * 从 Bedrock 目录添加（模态）。逻辑原样搬自旧版内联选择器：
 *
 * 原先是一个原生 <select>：90+ 条、零排序、无法搜索，找 Claude 5 只能滚动翻，而它还同时以
 * `anthropic.*` 与 `global.anthropic.*` 两种形式存在 —— 实测管理员的结论是"这个模型没有"。
 * 改成 搜索 + 按厂商分组 + 路由范围徽章。手填入口留着：候选列不出来时（跨账号 Key 指向的
 * 模型不在本账号候选里、或本栈缺 ListFoundationModels 权限）这是唯一的加模型方式。
 */
import { useId, useState } from "react";
import { useT } from "../../i18n";
import type { LlmCandidate, LlmModelEntry } from "../../api/admin";
import { Btn, Modal, Tag, type FocusTarget } from "./ui";
import { candMatches, routingScopeKey, sortCandidates } from "./logic";

export default function BedrockPicker({
  candidates, candWarn, candSource, models, onRetry, onAddCandidate, onAddManual, onClose, returnFocus,
}: {
  candidates: LlmCandidate[]; candWarn: string; candSource: string; models: LlmModelEntry[];
  onRetry: () => void; onAddCandidate: (c: LlmCandidate) => void;
  onAddManual: (id: string, label: string) => void; onClose: () => void; returnFocus?: FocusTarget;
}) {
  const t = useT();
  const [pick, setPick] = useState("");
  const [query, setQuery] = useState("");
  const [manualId, setManualId] = useState("");
  const [manualLabel, setManualLabel] = useState("");
  const [err, setErr] = useState("");
  const errId = useId();

  // 可选集与当前匹配集：「加载中 / 加载失败 / 全部已加入 / 无匹配」四个态能被区分开的前提。
  const avail = sortCandidates(candidates.filter((c) => !models.some((m) => m.model_id === c.model_id)));
  const shown = avail.filter((c) => candMatches(c, query));
  // 只有当选中项**当前可见**时才允许添加。否则会出现：搜索把选中项过滤掉了，按钮却仍然亮着、
  // 点下去加进一个屏幕上看不到的模型 —— 而它还可能被自动设为默认模型（enabled 也默认为 true）。
  const pickVisible = !!pick && shown.some((c) => c.model_id === pick);

  const addManual = () => {
    const id = manualId.trim();
    if (!id) return;
    if (models.some((m) => m.model_id === id)) { setErr(t("admin.models.alreadyInCatalogue").replace("{id}", id)); return; }
    // 带 `/` 的是网关模型名（`anthropic/claude-opus-4-7`）—— Bedrock id 里没有斜杠，加成 Bedrock
    // 条目只会在保存时被服务端拒。指到网关的添加入口。
    if (id.includes("/")) { setErr(t("admin.models.manualLooksGateway")); return; }
    onAddManual(id, manualLabel.trim());
  };

  const body = (() => {
    // 四个态必须分开说，否则管理员会误判：
    //  · 还在读     → 「正在读取…」
    //  · 读失败     → 明确说失败 + 给重试（之前这里永久停在「正在读取…」，同时下方一条红色 warning，自相矛盾）
    //  · 全部已加入 → 不是「没有匹配」（那听起来像搜索没结果）
    //  · 无匹配     → 才是真的没搜到
    if (!candidates.length) {
      return candWarn
        ? <div className="mdl-pempty"><span className="mdl-errtxt">{t("admin.models.candFailed")}</span>{" "}
          <Btn className="sm" onClick={onRetry}>{t("admin.models.retry")}</Btn></div>
        : <div className="mdl-pempty">{t("admin.models.candLoading")}</div>;
    }
    if (!avail.length) return <div className="mdl-pempty">{t("admin.models.allAdded")}</div>;
    if (!shown.length) return <div className="mdl-pempty">{t("admin.models.noMatch")}</div>;
    // 分组：保持 sortCandidates 已排好的顺序，按厂商切段
    const groups: { name: string; items: LlmCandidate[] }[] = [];
    for (const c of shown) {
      const name = c.provider_name || t("admin.models.otherProvider");
      const last = groups[groups.length - 1];
      if (last && last.name === name) last.items.push(c);
      else groups.push({ name, items: [c] });
    }
    return groups.map((g) => (
      <div key={g.name} role="group" aria-label={g.name}>
        <div className="mdl-pg">{g.name} <em>{g.items.length}</em></div>
        {g.items.map((c) => (
          <label key={c.model_id} className={`mdl-pr${pick === c.model_id ? " on" : ""}`}>
            <input type="radio" name="llm-candidate" checked={pick === c.model_id} onChange={() => setPick(c.model_id)} />
            <span className="lbl">{c.label || c.model_id}</span>
            <code className="mdl-faint">{c.model_id}</code>
            <span className="sp" />
            <Tag kind="defm" title={t("admin.models.routingTip")}>{t(routingScopeKey(c.model_id, { scope: c.scope, kind: c.kind }))}</Tag>
          </label>
        ))}
      </div>
    ));
  })();

  return (
    <Modal title={t("admin.models.bedrockPicker.title")} onClose={onClose} closeLabel={t("admin.models.close")} returnFocus={returnFocus}
      footer={(
        <>
          {candidates.length > 0 && avail.length > 0 && (
            <span className="mdl-faint mdl-smt">
              {t("admin.models.matchCount").replace("{n}", String(shown.length)).replace("{total}", String(avail.length))}
            </span>
          )}
          <span style={{ marginLeft: "auto" }} />
          <Btn onClick={onClose}>{t("admin.models.cancel")}</Btn>
          <Btn className="pri" disabled={!pickVisible}
            onClick={() => { const c = candidates.find((x) => x.model_id === pick); if (c) onAddCandidate(c); }}>
            {t("admin.models.add")}
          </Btn>
        </>
      )}>
      <div className="mdl-msearch">
        <div className="mdl-search wide">
          <input className="mdl-input" value={query} autoFocus placeholder={t("admin.models.searchPh")}
            aria-label={t("admin.models.searchPh")} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      <div className="mdl-plist">{body}</div>
      {candWarn && candidates.length > 0 && <div className="mdl-msg err" style={{ marginLeft: 0 }}>{candWarn}</div>}
      {/* 列表来源身份。`iam_fallback` 是唯一危险的情形：列表来自部署角色而推理用 Key，
          两者可能不是同一批模型 —— 管理员会选中一个 Key 调不了的模型，到生产才 403。 */}
      {candSource && (
        <div className={`mdl-msg ${candSource === "iam_fallback" ? "err" : ""}`} style={{ marginLeft: 0, color: candSource === "iam_fallback" ? undefined : "var(--muted)" }}>
          {t(candSource === "api_key" ? "admin.models.candFromKey"
            : candSource === "iam_fallback" ? "admin.models.candKeyNoListPerm" : "admin.models.candFromRole")}
        </div>
      )}
      <div className="mdl-mrow">
        <span className="mdl-mut">{t("admin.models.orManual")}</span>
        <input className="mdl-input mono" value={manualId} placeholder="global.anthropic.claude-sonnet-5" spellCheck={false}
          aria-label={t("admin.models.orManual")}
          aria-invalid={err ? true : undefined} aria-describedby={err ? errId : undefined}
          onChange={(e) => { setManualId(e.target.value); setErr(""); }} />
        <input className="mdl-input" style={{ width: 150, flex: "none" }} value={manualLabel}
          placeholder={t("admin.models.manualLabelPh")} aria-label={t("admin.models.manualLabelPh")}
          onChange={(e) => setManualLabel(e.target.value)} />
        <Btn disabled={!manualId.trim()} onClick={addManual}>{t("admin.models.add")}</Btn>
      </div>
      {/* role="alert"：报错出现时读屏当场播报（点「添加」后焦点还在按钮 / 输入框上） */}
      {err && <div id={errId} role="alert" className="mdl-msg err" style={{ marginLeft: 0 }}>{err}</div>}
      <div className="mdl-msg" style={{ marginLeft: 0, color: "var(--muted)" }}>{t("admin.models.manualHint")}</div>
    </Modal>
  );
}
