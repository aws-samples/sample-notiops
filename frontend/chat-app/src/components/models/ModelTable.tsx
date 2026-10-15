/**
 * 模型表（A-1）：一行一条、56px，列 = 启用 / 模型 / 来源 / Web / IM / 状态 / ⋯。
 * model_id、路由范围、输出上限只在详情抽屉里出现，不再每行重复。
 * 状态列只放例外：谁的默认、新增、保存失败、没通过的测试结果。「可用」不逐行挂（「全部测试」
 * 之后在按钮旁给一句汇总）；只有刚单测的那一行显示它，算是那一下点击的回执。⋯ 常驻。
 */
import { useState } from "react";
import { useT } from "../../i18n";
import type { LlmModelEntry, LlmSource, ModelSurface } from "../../api/admin";
import { isGateway } from "../modelSources";
import { Btn, InfoTip, MenuButton, RowMenu, Switch, Tag, type MenuItem } from "./ui";
import DeleteConfirm from "./DeleteConfirm";
import {
  defaultOf, filterModels, moreId, nameId, replacementsFor, resultTip, resultTone, segCounts, sortForTable, testLabel,
  type Defaults, type Seg,
} from "./logic";

export default function ModelTable({
  models, savedAliases, defaults, active, results, soloAlias, summary, testing, failAlias, failResult, curAlias,
  gatewayConfigured, webCount, imCount, probeNote, locked,
  onToggleEnabled, onToggleSurface, onOpen, onTest, onTestAll, onSetDefault, onRemove,
  onAddBedrock, onAddGateway,
}: {
  models: LlmModelEntry[]; savedAliases: Set<string>; defaults: Defaults; active: LlmSource;
  results: Record<string, string>;
  /** 最近一次**单测**的那一行：只有它会显示「可用」。 */
  soloAlias: string;
  /** 「全部测试」之后的汇总；没跑过 / 没有结果 → null。 */
  summary: { ok: number; bad: number } | null;
  testing: string; failAlias?: string; failResult?: string; curAlias?: string;
  gatewayConfigured: boolean; webCount: number; imCount: number;
  /** 表尾「测试用的是哪个凭证」：一行短句，细节在 ⓘ。 */
  probeNote: { text: string; tip: string; warn: boolean } | null;
  /** 保存请求在路上：改草稿的控件一律禁用（否则失败会挂在旧签名上、被吞掉）。 */
  locked: boolean;
  onToggleEnabled: (alias: string, on: boolean) => void; onToggleSurface: (m: LlmModelEntry, s: ModelSurface) => void;
  /** 打开详情抽屉；`from` = 关闭后焦点回哪里（模型名 / 该行 ⋯）。 */
  onOpen: (alias: string, from: "name" | "menu") => void; onTest: (m: LlmModelEntry) => void; onTestAll: () => void;
  onSetDefault: (s: LlmSource, alias: string) => void;
  /** 删除；`newDefault` 只在删的是默认时给（那些来源改用它）。 */
  onRemove: (alias: string, newDefault?: { sources: LlmSource[]; alias: string }) => void;
  onAddBedrock: () => void; onAddGateway: () => void;
}) {
  const t = useT();
  const [seg, setSeg] = useState<Seg>("all");
  const [query, setQuery] = useState("");
  const [foldOpen, setFoldOpen] = useState(false);
  const [menu, setMenu] = useState("");
  const [confirmDel, setConfirmDel] = useState("");

  const counts = segCounts(models);
  const sorted = filterModels(sortForTable(models, active), seg, query);
  // 「全部」且没在搜索时，未启用的折叠成一行（它们只是留着历史落款，不该和在用的抢视线）。
  const folding = seg === "all" && !query.trim();
  const off = folding ? sorted.filter((m) => !m.enabled) : [];
  // 展开后未启用的排在折叠行**下面**，不和在用的混排。
  const shown = folding ? sorted.filter((m) => m.enabled) : sorted;
  const enabledCount = models.filter((m) => m.enabled).length;
  const short = (s: LlmSource) => t(`admin.models.srcShort.${s}`);
  const focusMore = (alias: string) => document.getElementById(moreId(alias))?.focus();

  const row = (m: LlmModelEntry) => {
    const gw = isGateway(m);
    const label = m.label || m.alias;
    const defs = defaultOf(m.alias, models, defaults);
    const res = results[m.alias];
    const failed = failAlias === m.alias && failResult;
    const lockHint = locked ? t("admin.models.bar.savingLocked") : undefined;
    const items: MenuItem[] = [
      { key: "test", label: t("admin.models.testBtn"), onSelect: () => onTest(m), disabled: Boolean(testing) },
      ...((gw ? ["gateway"] : ["iam", "api_key"]) as LlmSource[])
        .filter((s) => defaults[s] !== m.alias)
        .map((s) => ({ key: `def-${s}`, label: t(`admin.models.menu.setDefault.${s}`),
                       onSelect: () => onSetDefault(s, m.alias), disabled: locked || !m.enabled,
                       hint: lockHint || (m.enabled ? undefined : t("admin.models.menu.needEnabled")) })),
      { key: "details", label: t("admin.models.menu.details"), onSelect: () => onOpen(m.alias, "menu") },
      { key: "delete", label: t("admin.models.menu.delete"), danger: true, sepBefore: true, disabled: locked, hint: lockHint,
        onSelect: () => (defs.length ? setConfirmDel(m.alias) : onRemove(m.alias)) },
    ];
    // 抽屉打开的那一行（cur）是中性的选中底色；橙条只给「保存后启用」（来源表的 pend），两者分得开。
    const cls = failed ? "fail" : curAlias === m.alias ? "cur" : "";
    const idle = gw && active !== "gateway";
    // 「可用」只给刚单测的那一行；没通过的结果才是例外，逐行保留。
    const showRes = res && (res !== "ok" || soloAlias === m.alias);
    return (
      <div key={m.alias} className={`mdl-tr mdl-grid-mdl click ${cls}${idle ? " off" : ""}${m.enabled ? "" : " dis"}`}
        title={idle ? t("admin.models.group.gwIdle") : undefined}
        onClick={() => onOpen(m.alias, "name")}>
        <div><Switch on={m.enabled} label={`${label} ${t("admin.models.col.enabled")}`} disabled={locked}
          onChange={(v) => onToggleEnabled(m.alias, v)} /></div>
        <div className="mdl-mc">
          <button type="button" id={nameId(m.alias)} className="mdl-namebtn"
            onClick={(e) => { e.stopPropagation(); onOpen(m.alias, "name"); }}>{label}</button>
          {label !== m.model_id && <span className="mdl-mid">{m.model_id}</span>}
        </div>
        <div className="mdl-col-src">
          <span className="mdl-srcc"><i className={`mdl-sd ${gw ? "gw" : "br"}`} />{t(gw ? "admin.models.seg.gateway" : "admin.models.seg.bedrock")}</span>
        </div>
        {(["webchat", "im"] as ModelSurface[]).map((s) => {
          // 网关条目：Web 是它唯一的端，锁成勾选（要下架用启用开关）；IM 原生链路不接网关，显示「—」。
          if (gw && s === "im") return <div key={s} className="mdl-c"><span className="mdl-na" title={t("admin.models.gw.noIm")}>—</span></div>;
          const webLocked = gw && s === "webchat";
          return (
            <div key={s} className="mdl-c" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" className="mdl-cb" checked={webLocked || m.surfaces.includes(s)} disabled={webLocked || locked}
                title={webLocked ? t("admin.models.gw.webOnly") : undefined}
                aria-label={`${label} ${t(`admin.models.surface.${s}`)}`}
                onChange={() => onToggleSurface(m, s)} />
            </div>
          );
        })}
        <div className="mdl-cells">
          {/* 保存没过的那一行只放失败标签：它是这一行唯一要紧的例外（来源行、保存条已经说了是哪个来源的默认），
              和「默认 · …」挤在一起时后者会被截成「Defa…」。 */}
          {failed ? <Tag kind="err" title={resultTip(failResult, t, gw)}>{testLabel(failResult, t, gw)}</Tag> : (
            <>
              {defs.length > 0 && (
                <Tag kind={defs.includes(active) ? "def" : "defm"} title={t("admin.models.defaultBadgeTip")}>
                  {t("admin.models.defaultOf").replace("{sources}", defs.map(short).join(" / "))}
                </Tag>
              )}
              {!savedAliases.has(m.alias) && <Tag kind="new">{t("admin.models.tag.new")}</Tag>}
              {testing === m.alias ? <Tag kind="gray">{t("admin.models.testing")}</Tag>
                : showRes && <Tag kind={resultTone(res, gw)} title={resultTip(res, t, gw)}>{testLabel(res, t, gw)}</Tag>}
            </>
          )}
        </div>
        <div className="mdl-c">
          <RowMenu id={moreId(m.alias)} label={`${label} ${t("admin.models.more")}`} items={items}
            open={menu === m.alias} onToggle={() => { setConfirmDel(""); setMenu((v) => (v === m.alias ? "" : m.alias)); }}
            onClose={() => setMenu((v) => (v === m.alias ? "" : v))}
            extra={confirmDel === m.alias ? (dir) => (
              <DeleteConfirm entry={m} sources={defs} replacements={replacementsFor(m.alias, models, defs)} dir={dir}
                onCancel={() => { setConfirmDel(""); focusMore(m.alias); }}
                onConfirm={(nd) => { setConfirmDel(""); onRemove(m.alias, nd ? { sources: defs, alias: nd } : undefined); }} />
            ) : undefined} />
        </div>
      </div>
    );
  };

  const SEGS: Seg[] = ["all", "bedrock", "gateway", "disabled"];
  return (
    <div className="mdl-sec">
      <div className="mdl-sh">
        <span className="t">{t("admin.models.listTitle")}</span>
        <div className="mdl-seg" role="group" aria-label={t("admin.models.listTitle")}>
          {SEGS.map((s) => (
            <button key={s} type="button" className={seg === s ? "on" : ""} aria-pressed={seg === s} onClick={() => setSeg(s)}>
              {t(`admin.models.seg.${s}`)} <em>{counts[s]}</em>
            </button>
          ))}
        </div>
        <div className="r">
          <div className="mdl-search">
            <input id="mdl-model-search" className="mdl-input" value={query} placeholder={t("admin.models.searchModels")}
              aria-label={t("admin.models.searchModels")} onChange={(e) => setQuery(e.target.value)} />
          </div>
          {summary && !testing && (
            <span className="mdl-smt mdl-tsum" role="status">
              <span className="mdl-mut">{t("admin.models.sum.ok").replace("{n}", String(summary.ok))}</span>
              {summary.bad > 0 && <> · <span className="mdl-errtxt">{t("admin.models.sum.bad").replace("{n}", String(summary.bad))}</span></>}
            </span>
          )}
          <Btn onClick={onTestAll} disabled={Boolean(testing) || !enabledCount} title={t("admin.models.testAllTip")}>
            {testing ? t("admin.models.testing") : t("admin.models.testAll")}
          </Btn>
          <div className="mdl-addw">
            <MenuButton id="mdl-add-btn" className="pri" label={t("admin.models.addModel")} disabled={locked}
              menuStyle={{ top: 38, right: 0, width: 240 }}
              items={[
                { key: "bedrock", label: t("admin.models.add.fromBedrock"), onSelect: onAddBedrock },
                { key: "gateway", label: t("admin.models.add.fromGateway"), onSelect: onAddGateway, disabled: !gatewayConfigured,
                  hint: gatewayConfigured ? undefined : t("admin.models.add.gwNotConfigured") },
              ]}>
              + {t("admin.models.addModel")} ▾
            </MenuButton>
          </div>
        </div>
      </div>
      <div className="mdl-tbl">
        <div className="mdl-tr h mdl-grid-mdl" aria-hidden>
          <div>{t("admin.models.col.enabled")}</div><div>{t("admin.models.col.model")}</div>
          <div className="mdl-col-src">{t("admin.models.col.source")}</div>
          <div className="mdl-c">{t("admin.models.surface.webchat")}</div><div className="mdl-c">{t("admin.models.surface.im")}</div>
          <div>{t("admin.models.col.status")}</div><div />
        </div>
        {shown.map(row)}
        {!shown.length && !off.length && (
          <div className="mdl-tr" style={{ display: "flex" }}><span className="mdl-mut">{t("admin.models.tableEmpty")}</span></div>
        )}
        {folding && off.length > 0 && (
          <button type="button" className="mdl-tr fold" aria-expanded={foldOpen} onClick={() => setFoldOpen((o) => !o)}>
            <span>{foldOpen ? "▾" : "▸"} {t("admin.models.foldDisabled").replace("{n}", String(off.length))}</span>
            <span className="mdl-faint">{t(foldOpen ? "admin.models.collapse" : "admin.models.expand")}</span>
          </button>
        )}
        {folding && foldOpen && off.map(row)}
      </div>
      {/* 一行：「用户可选」不收缩、不断行；凭证那句只留短句，细节进 ⓘ。 */}
      <div className="mdl-foot">
        <span className="n">{t("admin.models.availCount").replace("{web}", String(webCount)).replace("{im}", String(imCount))}</span>
        {probeNote && (
          <span className="pn">
            <span className={`mdl-ell${probeNote.warn ? " mdl-errtxt" : ""}`} title={probeNote.text}>{probeNote.text}</span>
            <InfoTip label={probeNote.text} text={probeNote.tip} side="up" align="start" />
          </span>
        )}
      </div>
    </div>
  );
}
