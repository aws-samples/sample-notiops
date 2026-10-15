/**
 * 模型详情抽屉（A-4）。行内放不下的东西都在这里：显示名、model_id、路由范围（数据驻留）、
 * Mantle 区域、端、输出上限、单测。改动直接写进草稿（保存条随之出现），「完成」只是关抽屉。
 */
import { useRef, useState } from "react";
import { useT } from "../../i18n";
import type { LlmModelEntry, LlmSource, ModelSurface } from "../../api/admin";
import { isGateway } from "../modelSources";
import { Btn, Drawer, InfoTip, Switch, Tag, type FocusTarget } from "./ui";
import DeleteConfirm from "./DeleteConfirm";
import { defaultOf, replacementsFor, resultTip, resultTone, routingScopeKey, testLabel, type Defaults } from "./logic";

export default function ModelDrawer({
  m, models, defaults, bedrockSrc, keyConfigured, gwHost, result, testing, locked,
  onPatch, onToggleSurface, onTest, onRemove, onClose, returnFocus,
}: {
  m: LlmModelEntry; models: LlmModelEntry[]; defaults: Defaults; bedrockSrc: LlmSource; keyConfigured: boolean;
  gwHost: string; result?: string; testing: boolean;
  /** 保存请求在路上：改草稿的控件禁用（测试、复制、完成不受影响）。 */
  locked: boolean;
  onPatch: (p: Partial<LlmModelEntry>) => void; onToggleSurface: (s: ModelSurface) => void;
  onTest: (source?: "iam" | "api_key") => void;
  onRemove: (newDefault?: { sources: LlmSource[]; alias: string }) => void; onClose: () => void;
  returnFocus?: FocusTarget;
}) {
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const delBtn = useRef<HTMLButtonElement>(null);
  const gw = isGateway(m);
  const label = m.label || m.alias;
  const defs = defaultOf(m.alias, models, defaults);
  const srcName = (s: LlmSource) => t(`admin.models.src.${s}`);
  const testVia = gw ? t("admin.models.src.gateway") : srcName(bedrockSrc);
  const other: "iam" | "api_key" = bedrockSrc === "iam" ? "api_key" : "iam";
  const copy = () => {
    navigator.clipboard?.writeText(m.model_id).then(() => setCopied(true), () => { /* 剪贴板不可用：静默 */ });
  };
  const del = () => (defs.length ? setConfirm(true) : onRemove());

  return (
    <Drawer title={label} onClose={onClose} closeLabel={t("admin.models.close")} returnFocus={returnFocus}
      sub={gw ? t("admin.models.drawer.subGateway").replace("{host}", gwHost || t("admin.models.src.gateway"))
        : t("admin.models.drawer.subBedrock")}
      footer={(
        <>
          <span style={{ position: "relative" }}>
            <Btn className="danger" ref={delBtn} onClick={del} disabled={locked}>{t("admin.models.menu.delete")}</Btn>
            {confirm && (
              <DeleteConfirm entry={m} sources={defs} replacements={replacementsFor(m.alias, models, defs)} dir="up"
                style={{ left: -6, right: "auto", bottom: 42 }}
                onCancel={() => { setConfirm(false); delBtn.current?.focus(); }}
                onConfirm={(nd) => { setConfirm(false); onRemove(nd ? { sources: defs, alias: nd } : undefined); }} />
            )}
          </span>
          <span style={{ flex: 1 }} />
          <Btn className="pri" onClick={onClose}>{t("admin.models.done")}</Btn>
        </>
      )}>
      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.drawer.basic")}</div>
        <div className="mdl-kv">
          <span className="k">{t("admin.models.col.enabled")}</span>
          <div className="v">
            <Switch on={m.enabled} label={`${label} ${t("admin.models.col.enabled")}`} disabled={locked}
              onChange={(v) => onPatch({ enabled: v })} />
            <span className="mdl-mut mdl-smt">{t("admin.models.drawer.enabledHint")}</span>
          </div>
        </div>
        <div className="mdl-kv">
          <label className="k" htmlFor={`mdl-label-${m.alias}`}>{t("admin.models.drawer.label")}</label>
          <input id={`mdl-label-${m.alias}`} className="mdl-input" value={m.label} disabled={locked}
            onChange={(e) => onPatch({ label: e.target.value })} />
        </div>
        <div className="mdl-kv">
          <span className="k">{t("admin.models.infoModelId")}</span>
          <div className="v">
            <code className="mdl-ell" style={{ fontSize: 12.5 }} title={m.model_id}>{m.model_id}</code>
            <button type="button" className="mdl-i" aria-label={t("admin.models.drawer.copy")} title={t("admin.models.drawer.copy")}
              onClick={copy}>{copied ? "✓" : "⧉"}</button>
          </div>
        </div>
        <div className="mdl-kv">
          <span className="k">{t("admin.models.infoRouting")}</span>
          <div className="v">
            <b style={{ fontWeight: 600 }}>{t(routingScopeKey(m.model_id, { kind: m.kind }))}</b>
            <InfoTip label={t("admin.models.infoRouting")} side="down" align="center"
              text={gw ? t("admin.models.routing.gatewayTip").replace("{host}", gwHost || t("admin.models.src.gateway"))
                : t("admin.models.routingTip")} />
          </div>
        </div>
        {m.kind === "bedrock_mantle_responses" && (
          <div className="mdl-kv">
            <span className="k">{t("admin.models.infoRegion")}</span>
            <div className="v">
              <code>{m.region || "—"}</code>
              <InfoTip label={t("admin.models.infoRegion")} text={t("admin.models.infoMantle")} side="down" align="center" />
            </div>
          </div>
        )}
      </div>

      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.drawer.where")}</div>
        <div className="mdl-kv">
          <span className="k">{t("admin.models.drawer.surfaces")}</span>
          <div className="v" style={{ gap: 22 }}>
            {(["webchat", "im"] as ModelSurface[]).map((s) => {
              const webLocked = gw && s === "webchat";
              const na = gw && s === "im";
              return (
                <label key={s} className="mdl-chk" title={na ? t("admin.models.gw.noIm") : webLocked ? t("admin.models.gw.webOnly") : undefined}>
                  <input type="checkbox" className="mdl-cb" checked={webLocked || (!na && m.surfaces.includes(s))}
                    disabled={webLocked || na || locked} onChange={() => onToggleSurface(s)} />
                  <span className={na ? "mdl-faint" : ""}>{t(s === "webchat" ? "admin.models.strip.web" : "admin.models.strip.im")}</span>
                </label>
              );
            })}
          </div>
        </div>
        {gw && <div className="mdl-hint">{t("admin.models.gw.noIm")}</div>}
      </div>

      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.drawer.capBlock")}</div>
        <div className="mdl-kv">
          <label className="k" htmlFor={`mdl-cap-${m.alias}`}>{t("admin.models.cap")}</label>
          <div className="v">
            <input id={`mdl-cap-${m.alias}`} className="mdl-input" type="number" min={1} style={{ width: 140 }}
              value={m.hard_output_limit} disabled={locked} onChange={(e) => onPatch({ hard_output_limit: Number(e.target.value) || 0 })} />
            <span className="mdl-mut">{t("admin.models.capUnit")}</span>
          </div>
        </div>
        <div className="mdl-hint">{t("admin.models.drawer.capHint")}</div>
      </div>

      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.drawer.conn")}</div>
        <div className="mdl-kv">
          <span className="k">{t("admin.models.testBtn")}</span>
          <div className="v">
            <Btn className="sm" disabled={testing} onClick={() => onTest(gw ? undefined : bedrockSrc as "iam" | "api_key")}
              title={gw ? t("admin.models.testTipGateway") : t("admin.models.testTip")}>
              {testing ? t("admin.models.testing") : t("admin.models.testBtn")}
            </Btn>
            {result ? (
              <Tag kind={resultTone(result, gw)} title={resultTip(result, t, gw)}>
                {testLabel(result, t, gw)}
              </Tag>
            ) : (
              <span className="note">{t("admin.models.drawer.untested").replace("{source}", testVia)}</span>
            )}
          </div>
        </div>
        {!gw && keyConfigured && (
          <div className="mdl-kv">
            <span className="k" />
            <div className="v">
              <Btn className="sm" disabled={testing} onClick={() => onTest(other)}>
                {t("admin.models.drawer.testWithOther").replace("{source}", srcName(other))}
              </Btn>
            </div>
          </div>
        )}
        {result === "upstream_auth" && <div className="mdl-hint">{t("admin.models.test.upstreamAuthTip")}</div>}
      </div>
    </Drawer>
  );
}
