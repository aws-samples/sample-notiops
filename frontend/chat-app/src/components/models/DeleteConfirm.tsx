/**
 * 删除确认浮层（A-5）。只在删的是某个来源的**默认模型**时出现：当场挑一个新默认，
 * 不留一个指向已删条目的配置。没有可接替的 → 说清楚删了之后要再加一个。
 * 删的不是默认 → 不弹它，直接删（只是草稿，「放弃」可撤）。
 * 「取消」/ Esc 由调用方把焦点还给触发它的按钮（行末 ⋯ / 抽屉里的「删除」）。
 */
import { useState, type CSSProperties } from "react";
import { useT } from "../../i18n";
import type { LlmModelEntry, LlmSource } from "../../api/admin";
import { isGateway } from "../modelSources";
import { Btn, Popover, Select } from "./ui";

export default function DeleteConfirm({ entry, sources, replacements, dir, onCancel, onConfirm, style }: {
  entry: LlmModelEntry; sources: LlmSource[]; replacements: LlmModelEntry[]; dir: "up" | "down";
  onCancel: () => void; onConfirm: (newDefault: string) => void; style?: CSSProperties;
}) {
  const t = useT();
  const [pick, setPick] = useState(replacements[0]?.alias || "");
  const gw = isGateway(entry);
  const name = gw ? <code>{entry.model_id}</code> : <span>{entry.label || entry.alias}</span>;
  const [pre, post] = t("admin.models.del.title").split("{name}");
  const srcList = sources.map((s) => t(`admin.models.src.${s}`)).join(" / ");
  return (
    <Popover className={`mdl-pop ${dir}`} style={style} onEscape={onCancel}
      label={t("admin.models.del.title").replace("{name}", entry.label || entry.alias)}>
      <div className="pt">{pre}{name}{post}</div>
      {replacements.length ? (
        <>
          <div className="ps">{t("admin.models.del.isDefault").replace("{sources}", srcList)}</div>
          <Select className={gw ? "mono" : ""} aria-label={t("admin.models.default")} value={pick} autoFocus
            onChange={(e) => setPick(e.target.value)}>
            {replacements.map((m) => <option key={m.alias} value={m.alias}>{isGateway(m) ? m.model_id : (m.label || m.alias)}</option>)}
          </Select>
        </>
      ) : (
        <div className="ps">{t("admin.models.del.noOther").replace("{sources}", srcList)}</div>
      )}
      <div className="pf">
        <Btn onClick={onCancel} autoFocus={!replacements.length}>{t("admin.models.cancel")}</Btn>
        <Btn className="red" onClick={() => onConfirm(pick)}>{t("admin.models.menu.delete")}</Btn>
      </div>
    </Popover>
  );
}
