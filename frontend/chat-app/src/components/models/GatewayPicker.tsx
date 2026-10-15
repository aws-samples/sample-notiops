/**
 * 从网关添加模型（A-2）。列表来自 GET {base}/models（不花 token）。
 *
 * **增删对称**：打开时勾选态 = 目录里已有的网关 model_id；「完成」按差集增删（勾上 = 加，
 * 取消勾选 = 移出目录）；「取消」丢弃本次勾选。按前缀分组；通配符 / 非对话模型由服务端滤掉，只报个数。
 * 列表没滚到底时底部渐隐一行「还有 N 个匹配 · 向下滚动」—— 固定高度的滚动区里，下面还有没有东西
 * 只靠被切开的那一行去猜是不够的。
 */
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../../i18n";
import type { GatewayModelList, LlmModelEntry } from "../../api/admin";
import { GATEWAY_MODEL_ID_RE, isGateway, matchesQuery } from "../modelSources";
import { Btn, InfoTip, Modal, Tag, type FocusTarget } from "./ui";
import { groupByPrefix, testLabel } from "./logic";

/** 一次最多渲染这么多行：网关上千个模型时一次性画出来会卡，用搜索缩小范围。 */
const MAX_ROWS = 400;

export default function GatewayPicker({ host, list, listing, models, defaultModelId, onRetry, onCancel, onDone, returnFocus }: {
  host: string; list: GatewayModelList | null; listing: boolean; models: LlmModelEntry[];
  defaultModelId?: string; onRetry: () => void; onCancel: () => void; onDone: (selected: string[]) => void;
  returnFocus?: FocusTarget;
}) {
  const t = useT();
  const [sel, setSel] = useState<string[]>(() => models.filter(isGateway).map((m) => m.model_id));
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [manualErr, setManualErr] = useState("");
  const errId = useId();
  /** 滚动区下沿以下还有几行（没滚到底时才显示提示）。 */
  const [below, setBelow] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const ok = list?.result === "ok";
  const all = ok ? list.models.map((m) => m.id) : [];
  const shown = all.filter((id) => matchesQuery(id, query));
  // 手填的、或目录里已有但网关列表里没有的，也要能在这里取消勾选。
  const extra = sel.filter((id) => !all.includes(id) && matchesQuery(id, query));
  const visible = [...shown, ...extra];
  const groups = groupByPrefix(visible.slice(0, MAX_ROWS), t("admin.models.otherProvider"));
  const offscreen = sel.filter((id) => !visible.includes(id)).length;
  const toggle = (id: string) => setSel((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  /** 数一数滚动区下沿以下的行。行的 offsetTop 相对 `.mdl-plist`（它是 position: relative）。 */
  const measure = () => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollTop + el.clientHeight;
    let n = 0;
    el.querySelectorAll<HTMLElement>(".mdl-pr").forEach((r) => { if (r.offsetTop + r.offsetHeight / 2 > bottom) n += 1; });
    setBelow(n);
  };
  const measureRef = useRef(measure);
  useEffect(() => { measureRef.current = measure; });
  // 内容高度随搜索变化 → ResizeObserver 回调里重新数（回调是异步的，不在 effect 的同步路径上）。
  useEffect(() => {
    const el = listRef.current, inner = innerRef.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureRef.current());
    ro.observe(el); ro.observe(inner);
    return () => ro.disconnect();
  }, []);

  const addManual = () => {
    const id = manual.trim();
    if (!GATEWAY_MODEL_ID_RE.test(id)) { setManualErr(t("admin.models.gw.badId")); return; }
    if (sel.includes(id)) { setManualErr(t("admin.models.alreadyInCatalogue").replace("{id}", id)); return; }
    setSel((p) => [...p, id]); setManual(""); setManualErr("");
  };

  const hidden = ok ? list.hidden : [];
  return (
    <Modal title={t("admin.models.gw.pickerTitle")} onClose={onCancel} closeLabel={t("admin.models.close")}
      returnFocus={returnFocus}
      sub={ok ? t("admin.models.gw.pickerSub").replace("{host}", host).replace("{n}", String(all.length)) : host}
      footer={(
        <>
          <span>{t("admin.models.gw.selected").split("{n}")[0]}<b>{sel.length}</b>{t("admin.models.gw.selected").split("{n}")[1]}</span>
          <span className="mdl-faint mdl-smt mdl-ell">
            {offscreen > 0 && <>· {t("admin.models.gw.offscreen").replace("{n}", String(offscreen))} </>}
            · {t("admin.models.gw.uncheckRemoves")}
          </span>
          <span style={{ marginLeft: "auto" }} />
          <Btn onClick={onCancel}>{t("admin.models.cancel")}</Btn>
          <Btn className="pri" onClick={() => onDone(sel)}>{t("admin.models.done")}</Btn>
        </>
      )}>
      <div className="mdl-msearch">
        <div className="mdl-search wide">
          <input className="mdl-input" value={query} autoFocus placeholder={t("admin.models.gw.searchPh")}
            aria-label={t("admin.models.gw.searchPh")} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {ok && <span className="mdl-mut" style={{ whiteSpace: "nowrap" }}>{t("admin.models.gw.matchCount").replace("{n}", String(shown.length))}</span>}
      </div>
      <div className="mdl-plistw">
        <div className="mdl-plist" ref={listRef} onScroll={measure}>
          <div ref={innerRef}>
            {listing && <div className="mdl-pempty">{t("admin.models.gw.listing")}</div>}
            {!listing && list && !ok && (
              <div className="mdl-pempty">
                <span className="mdl-errtxt">{t("admin.models.gw.listFailed")}（{testLabel(list.result, t, true)}）</span>{" "}
                <Btn className="sm" onClick={onRetry}>{t("admin.models.retry")}</Btn>
              </div>
            )}
            {!listing && ok && !visible.length && <div className="mdl-pempty">{t("admin.models.tableEmpty")}</div>}
            {!listing && groups.map((g) => (
              <div key={g.name} role="group" aria-label={g.name}>
                <div className="mdl-pg">{g.name} <em>{g.ids.length}</em></div>
                {g.ids.map((id) => {
                  const on = sel.includes(id);
                  return (
                    <label key={id} className={`mdl-pr${on ? " on" : ""}`}>
                      <input type="checkbox" className="mdl-cb" checked={on} onChange={() => toggle(id)} />
                      <code>{id}</code>
                      {id === defaultModelId && <Tag kind="def">{t("admin.models.gw.defaultTag")}</Tag>}
                    </label>
                  );
                })}
              </div>
            ))}
            {visible.length > MAX_ROWS && (
              <div className="mdl-pempty">{t("admin.models.gw.more").replace("{n}", String(visible.length - MAX_ROWS))}</div>
            )}
          </div>
        </div>
        {!listing && below > 0 && (
          <div className="mdl-pmore" aria-hidden>{t("admin.models.gw.moreBelow").replace("{n}", String(below))}</div>
        )}
      </div>
      {ok && hidden.length > 0 && (
        <div className="mdl-mrow mdl-faint mdl-smt">
          {t("admin.models.gw.hiddenCount").replace("{n}", String(hidden.length))}
          <InfoTip label={t("admin.models.gw.hiddenCount").replace("{n}", String(hidden.length))} side="up" align="start"
            text={<code style={{ wordBreak: "break-all" }}>{hidden.slice(0, 50).map((h) => h.id).join("  ")}{hidden.length > 50 ? " …" : ""}</code>} />
        </div>
      )}
      <div className="mdl-mrow">
        <span className="mdl-mut">{t("admin.models.gw.notInList")}</span>
        <input className="mdl-input mono" value={manual} spellCheck={false} placeholder={t("admin.models.gw.manualPh")}
          aria-label={t("admin.models.gw.manualLabel")}
          aria-invalid={manualErr ? true : undefined} aria-describedby={manualErr ? errId : undefined}
          onChange={(e) => { setManual(e.target.value); setManualErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") addManual(); }} />
        <Btn onClick={addManual} disabled={!manual.trim()}>{t("admin.models.add")}</Btn>
      </div>
      {/* 焦点还在输入框里：role="alert" 让读屏当场播报，否则按 Enter 之后什么也听不到 */}
      {manualErr && <div id={errId} role="alert" className="mdl-msg err" style={{ marginLeft: 0 }}>{manualErr}</div>}
    </Modal>
  );
}
