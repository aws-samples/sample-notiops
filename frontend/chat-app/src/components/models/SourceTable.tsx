/**
 * 来源表（A-1 / A-3 / A-6）：三种来源一行一个，次序就是优先级（只用第一个，不自动降级）。
 *
 *   ⠿ 把手：鼠标拖拽（HTML5，只从把手拖 —— 整行可拖时在下拉框里选字会被当成拖动）；
 *          键盘 ↑ / ↓ 移动，焦点跟着那个来源，aria-live 播报新位置。
 *   状态列只放例外，一行最多一个主标签：保存失败 → 红；测过且没通过 → 按色调；已保存的第一 →「当前使用」；
 *          草稿第一且变了 →「保存后启用」；没配置 →「未配置」。Key 超轮换期另加琥珀「建议轮换」。
 *   凭证不在行下展开：网关 / Key 的「设置 / 配置」打开右侧抽屉。
 */
import { useRef, useState } from "react";
import { useT } from "../../i18n";
import type { LlmConfig, LlmModelEntry, LlmSource } from "../../api/admin";
import { gatewayHost, inFamily, isGateway } from "../modelSources";
import { Btn, InfoTip, Select, Tag } from "./ui";
import { resultTip, resultTone, sourceConfigured, testLabel, type Defaults } from "./logic";

export default function SourceTable({
  order, savedActive, defaults, models, cfg, failSource, failResult, srcResult, openSource, locked,
  onMove, onDefault, onOpen, liveMsg,
}: {
  order: LlmSource[]; savedActive: LlmSource; defaults: Defaults; models: LlmModelEntry[]; cfg: LlmConfig | null;
  failSource?: LlmSource; failResult?: string; srcResult: (s: LlmSource) => string | undefined;
  openSource: LlmSource | null;
  /** 保存请求在路上：把手与默认下拉禁用（调序 / 换默认都是草稿改动）。 */
  locked: boolean;
  onMove: (from: number, to: number) => void; onDefault: (s: LlmSource, alias: string) => void;
  onOpen: (s: "gateway" | "api_key") => void; liveMsg: string;
}) {
  const t = useT();
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const handles = useRef<Partial<Record<LlmSource, HTMLButtonElement | null>>>({});
  const srcName = (s: LlmSource) => t(`admin.models.src.${s}`);
  const activeChanged = order[0] !== savedActive;

  const keyMove = (i: number, dir: -1 | 1) => {
    const to = i + dir;
    if (to < 0 || to >= order.length) return;
    const s = order[i];
    onMove(i, to);
    // 重新渲染后那一行换了位置，把焦点放回它自己的把手上（不能掉回 body）
    requestAnimationFrame(() => handles.current[s]?.focus());
  };

  const conn = (s: LlmSource) => {
    if (s === "iam") return <span className="mdl-mut mdl-ell">{t("admin.models.src.iamStatus")}</span>;
    if (s === "api_key") {
      const k = cfg?.bedrock_api_key;
      return k?.configured ? <span className="mdl-mut mdl-ell">****{k.last_4 || ""}</span> : <span className="mdl-faint">—</span>;
    }
    const g = cfg?.gateway;
    if (g?.configured) {
      // 窄的时候截主机名，Key 后 4 位不截（它才是「是不是那把 Key」的识别信息）；
      // 列再窄（英文 + 两条侧栏）就只留后 4 位、最后整格不显示（styles.css 的容器查询）—— 全文在 title 与抽屉里。
      return (
        <span className="mdl-conn mdl-mut" title={`${g.base_url} · ****${g.last_4 || ""}`}>
          <span className="h mdl-ell">{gatewayHost(g.base_url)}</span><span className="k"><span className="sep">· </span>****{g.last_4 || ""}</span>
        </span>
      );
    }
    if (g?.base_url && g.base_url_valid === false) return <span className="mdl-errtxt mdl-ell">{t("admin.models.gw.badStored")}</span>;
    return <span className="mdl-faint">—</span>;
  };

  const status = (s: LlmSource, i: number) => {
    const tags = [];
    const tested = srcResult(s);
    const gw = s === "gateway";
    if (failSource === s && failResult) {
      tags.push(<Tag key="f" kind="err" title={resultTip(failResult, t, gw)}>{testLabel(failResult, t, gw)}</Tag>);
    } else if (tested && tested !== "ok") {
      tags.push(<Tag key="r" kind={resultTone(tested, gw)} title={resultTip(tested, t, gw)}>{testLabel(tested, t, gw)}</Tag>);
    } else if (s === savedActive) tags.push(<Tag key="l" kind="live">{t("admin.models.src.active")}</Tag>);
    else if (i === 0 && activeChanged) tags.push(<Tag key="p" kind="pend">{t("admin.models.src.pending")}</Tag>);
    else if (!sourceConfigured(s, cfg)) tags.push(<Tag key="u" kind="gray">{t("admin.models.keyUnset")}</Tag>);
    if (s === "api_key" && cfg?.bedrock_api_key?.configured && cfg.bedrock_api_key.rotation_due) {
      tags.push(<Tag key="k" kind="warn" title={t("admin.models.keyRotationDue")
        .replace("{days}", String(cfg.bedrock_api_key.age_days ?? ""))
        .replace("{limit}", String(cfg.bedrock_api_key.rotation_days ?? 90))}>{t("admin.models.key.rotateTag")}</Tag>);
    }
    return <div className="mdl-cells">{tags}</div>;
  };

  return (
    <div className="mdl-sec">
      <div className="mdl-sh">
        <span className="t">{t("admin.models.sources")}</span>
        <InfoTip label={t("admin.models.sources")} text={t("admin.models.sourcesSub")} side="down" align="start" />
        <span className="mdl-faint mdl-smt">{t("admin.models.dragHint")}</span>
      </div>
      <div className="mdl-sr" aria-live="polite">{liveMsg}</div>
      <div className="mdl-tbl" role="list" aria-label={t("admin.models.sources")}>
        <div className="mdl-tr h mdl-grid-src" aria-hidden>
          <div /><div>#</div><div>{t("admin.models.col.source")}</div>
          <div className="mdl-col-conn"><span className="mdl-colh">{t("admin.models.col.conn")}</span></div>
          <div>{t("admin.models.col.default")}</div><div /><div />
        </div>
        {order.map((s, i) => {
          const fam = models.filter((m) => m.enabled && inFamily(m, s));
          // fail（红条）/ pend（橙条，保存后启用）是行的状态；cur（抽屉开着）是中性的选中底色，可以叠在前两者上。
          const cls = `${failSource === s ? "fail" : i === 0 && activeChanged ? "pend" : ""}${openSource === s ? " cur" : ""}`;
          const drop = dragFrom !== null && dragOver === i && dragFrom !== i ? (dragFrom > i ? " drop-above" : " drop-below") : "";
          return (
            <div key={s} role="listitem" className={`mdl-tr mdl-grid-src ${cls}${dragFrom === i ? " drag" : ""}${drop}`}
              onDragOver={(e) => { if (dragFrom !== null) { e.preventDefault(); setDragOver(i); } }}
              onDragLeave={() => setDragOver((v) => (v === i ? null : v))}
              onDrop={(e) => { e.preventDefault(); if (dragFrom !== null) onMove(dragFrom, i); setDragFrom(null); setDragOver(null); }}>
              <div>
                <button type="button" className="mdl-handle" draggable={!locked} disabled={locked}
                  ref={(el) => { handles.current[s] = el; }}
                  aria-label={`${srcName(s)} · ${t("admin.models.dragTip")}`} title={t("admin.models.dragTip")}
                  aria-keyshortcuts="ArrowUp ArrowDown"
                  onKeyDown={(e) => {
                    if (e.key === "ArrowUp") { e.preventDefault(); keyMove(i, -1); }
                    if (e.key === "ArrowDown") { e.preventDefault(); keyMove(i, 1); }
                  }}
                  onDragStart={(e) => {
                    setDragFrom(i);
                    e.dataTransfer.effectAllowed = "move";
                    // Firefox 不 setData 就不发起 HTML5 拖拽
                    e.dataTransfer.setData("text/plain", s);
                  }}
                  onDragEnd={() => { setDragFrom(null); setDragOver(null); }}>⠿</button>
              </div>
              <div className="mdl-rank">{i + 1}</div>
              <div className="mdl-srcname mdl-ell">{srcName(s)}</div>
              <div className="mdl-col-conn" style={{ display: "flex", minWidth: 0 }}>{conn(s)}</div>
              <div>
                <Select id={`src-default-${s}`} aria-label={`${srcName(s)} ${t("admin.models.default")}`}
                  className={`${s === "gateway" ? "mono" : ""}${failSource === s ? " err" : ""}`}
                  value={defaults[s] || ""} disabled={!fam.length || locked}
                  onChange={(e) => onDefault(s, e.target.value)}>
                  {!fam.length && <option value="">{t("admin.models.src.noModels")}</option>}
                  {fam.map((m) => <option key={m.alias} value={m.alias}>{isGateway(m) ? m.model_id : (m.label || m.alias)}</option>)}
                </Select>
              </div>
              {status(s, i)}
              <div>
                {s !== "iam" && (
                  <Btn className="sm" id={`src-settings-${s}`} aria-label={`${srcName(s)} ${t("admin.models.src.settings")}`}
                    aria-expanded={openSource === s}
                    onClick={() => onOpen(s)}>
                    {sourceConfigured(s, cfg) ? t("admin.models.src.settings") : t("admin.models.src.configure")}
                  </Btn>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
