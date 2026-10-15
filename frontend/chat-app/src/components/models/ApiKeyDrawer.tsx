/**
 * Bedrock API Key 抽屉（C-7 的内容、A 的样式）。Key 单独保存、立即生效；只显示后 4 位；
 * 在用（第一来源，或网关排第一时 IM 用它）时不能清除。
 */
import { useT } from "../../i18n";
import type { LlmConfig, LlmModelEntry } from "../../api/admin";
import { inFamily } from "../modelSources";
import { Btn, Drawer, InfoTip, Select, Tag, type FocusTarget } from "./ui";
import { resultTip, resultTone, testLabel } from "./logic";

export default function ApiKeyDrawer({
  cfg, keyVal, setKey, saving, locked, msg, inUse, models, defaultAlias, onDefault, onSave, testResult, testing, onTest, onClose,
  returnFocus,
}: {
  /** `locked` = 草稿保存在路上：默认模型下拉（改草稿）禁用。 */
  cfg: LlmConfig | null; keyVal: string; setKey: (v: string) => void; saving: boolean; locked: boolean;
  msg: { ok: boolean; text: string } | null; inUse: boolean; models: LlmModelEntry[]; defaultAlias?: string;
  onDefault: (alias: string) => void; onSave: (clear: boolean) => void;
  testResult?: string; testing: boolean; onTest: () => void; onClose: () => void; returnFocus?: FocusTarget;
}) {
  const t = useT();
  const k = cfg?.bedrock_api_key;
  const configured = Boolean(k?.configured);
  const fam = models.filter((m) => m.enabled && inFamily(m, "api_key"));
  const setBy = configured && (k?.set_at || k?.set_by)
    ? t("admin.models.keySetBy").replace("{who}", k?.set_by || t("admin.models.keySetByUnknown"))
      .replace("{when}", (k?.set_at || "").slice(0, 10)) : "";
  return (
    <Drawer title={t("admin.models.src.api_key")} onClose={onClose} closeLabel={t("admin.models.close")} returnFocus={returnFocus}
      titleExtra={<Tag kind={configured ? "ok" : "gray"}>{t(configured ? "admin.models.keySet" : "admin.models.keyUnset")}</Tag>}
      sub={[t("admin.models.key.sub"), configured ? `****${k?.last_4 || ""}` : "", setBy].filter(Boolean).join(" · ")}
      footer={<><span style={{ flex: 1 }} /><Btn className="pri" onClick={onClose}>{t("admin.models.done")}</Btn></>}>
      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.key.cred")}</div>
        <div className="mdl-kv">
          <label className="k" htmlFor="mdl-key">{t("admin.models.key.field")}</label>
          {/* 谢绝自动填充，与 AdminPanel 的 SecretField 同一套属性：`autoComplete="off"` 会被 Chrome 的
              密码管理器无视，把管理员登录 NotiOps 的密码填进来、保存时当成 Key 写进 Secret。 */}
          <input id="mdl-key" name="notiops-models-bedrock-key" className="mdl-input" type="password" value={keyVal}
            autoComplete="new-password" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            data-1p-ignore data-lpignore="true" data-bwignore
            placeholder={t("admin.models.keyPh")} onChange={(e) => setKey(e.target.value)} />
        </div>
        <div className="mdl-kv" style={{ marginTop: 6 }}>
          <span className="k" />
          <div className="v">
            <Btn disabled={saving || !keyVal.trim()} onClick={() => onSave(false)}>{t("admin.models.keySave")}</Btn>
            <span className="note">{t("admin.models.key.saveHint")}</span>
          </div>
        </div>
        {/* 轮换提示（R5.6）。判定在服务端算好（`rotation_due`），前端不重算。 */}
        {configured && k?.rotation_due && (
          <div className="mdl-hint" style={{ color: "var(--mdl-warn)" }}>
            {t("admin.models.keyRotationDue").replace("{days}", String(k.age_days ?? ""))
              .replace("{limit}", String(k.rotation_days ?? 90))}
          </div>
        )}
        {msg && <div className={`mdl-msg ${msg.ok ? "ok" : "err"}`} role="status">{msg.text}</div>}
      </div>

      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.key.scope")}</div>
        <div className="mdl-mut" style={{ lineHeight: 1.7 }}>
          {t("admin.models.key.scopeText")}
          <InfoTip label={t("admin.models.key.scope")} text={t("admin.models.key.scopeTip")} side="up" align="end" />
        </div>
      </div>

      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.col.default")}</div>
        <div className="mdl-kv">
          <label className="k" htmlFor="mdl-key-default">{t("admin.models.col.default")}</label>
          <Select id="mdl-key-default" value={defaultAlias || ""} disabled={!fam.length || locked} onChange={(e) => onDefault(e.target.value)}>
            {!fam.length && <option value="">{t("admin.models.src.noModels")}</option>}
            {fam.map((m) => <option key={m.alias} value={m.alias}>{m.label || m.alias}</option>)}
          </Select>
        </div>
        <div className="mdl-kv">
          <span className="k">{t("admin.models.testBtn")}</span>
          <div className="v">
            <Btn className="sm" disabled={!configured || !defaultAlias || testing} onClick={onTest} title={t("admin.models.src.testTip")}>
              {testing ? t("admin.models.testing") : t("admin.models.gw.testDefault")}
            </Btn>
            {!configured ? <span className="note">{t("admin.models.key.testNeedKey")}</span>
              : testResult ? <Tag kind={resultTone(testResult)} title={resultTip(testResult, t)}>{testLabel(testResult, t)}</Tag> : null}
          </div>
        </div>
      </div>

      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.gw.clearBlock")}</div>
        <div className="mdl-kv">
          <span className="k" />
          <div className="v">
            <Btn className="sm danger" disabled={saving || !configured || inUse} onClick={() => onSave(true)}>{t("admin.models.keyClear")}</Btn>
            {!configured ? <span className="note">{t("admin.models.key.clearNoKey")}</span>
              : inUse ? <span className="note" title={t("admin.models.src.clearActive")}>{t("admin.models.src.clearActive")}</span> : null}
          </div>
        </div>
      </div>
    </Drawer>
  );
}
