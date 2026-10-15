/**
 * 网关设置抽屉（A-6）。地址与 Key 单独保存、立即生效（服务端先 GET /models 验证，不花 token）；
 * 数据去向只在这里说一次；默认模型与来源行是同一个状态；「测试默认模型」会真调一次。
 */
import { useT } from "../../i18n";
import type { LlmConfig, LlmModelEntry } from "../../api/admin";
import { gatewayHost, inFamily } from "../modelSources";
import { Btn, Drawer, Select, Tag, type FocusTarget } from "./ui";
import { resultTip, resultTone, testLabel } from "./logic";

const hostOf = (u?: string) => { try { return u ? new URL(u.trim()).host.toLowerCase() : ""; } catch { return (u || "").trim(); } };

export default function GatewayDrawer({
  cfg, url, setUrl, keyVal, setKey, saving, locked, msg, inUse, models, defaultAlias, onDefault, onSave, onManage,
  testResult, testing, onTest, onClose, returnFocus,
}: {
  cfg: LlmConfig | null; url: string; setUrl: (v: string) => void; keyVal: string; setKey: (v: string) => void;
  /** `locked` = 草稿保存在路上：默认模型下拉与「管理网关模型」（都改草稿）禁用。 */
  saving: boolean; locked: boolean; msg: { ok: boolean; text: string } | null; inUse: boolean; models: LlmModelEntry[];
  defaultAlias?: string; onDefault: (alias: string) => void; onSave: (clear: boolean) => void; onManage: () => void;
  testResult?: string; testing: boolean; onTest: () => void; onClose: () => void; returnFocus?: FocusTarget;
}) {
  const t = useT();
  const g = cfg?.gateway;
  const configured = Boolean(g?.configured);
  const host = gatewayHost(g?.base_url) || hostOf(url);
  // 换了主机就必须重填 Key：沿用旧 Key 等于把它发给一个新的、由管理员随手填的地址（服务端同样拒）。
  const hostChanged = Boolean(g?.base_url) && hostOf(url) !== hostOf(g?.base_url);
  const canSave = !saving && Boolean(url.trim()) && (Boolean(keyVal.trim()) || (Boolean(g?.has_key) && !hostChanged));
  const fam = models.filter((m) => m.enabled && inFamily(m, "gateway"));
  const added = models.filter((m) => inFamily(m, "gateway")).length;
  const setBy = configured && g?.set_by
    ? t("admin.models.keySetBy").replace("{who}", g.set_by).replace("{when}", (g.set_at || "").slice(0, 10)) : "";

  return (
    <Drawer title={t("admin.models.src.gateway")} onClose={onClose} closeLabel={t("admin.models.close")} returnFocus={returnFocus}
      titleExtra={<Tag kind={configured ? "ok" : "gray"}>{t(configured ? "admin.models.keySet" : "admin.models.keyUnset")}</Tag>}
      sub={configured ? [gatewayHost(g?.base_url), `****${g?.last_4 || ""}`, setBy].filter(Boolean).join(" · ") : undefined}
      footer={<><span style={{ flex: 1 }} /><Btn className="pri" onClick={onClose}>{t("admin.models.done")}</Btn></>}>
      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.gw.conn")}</div>
        <div className="mdl-kv">
          <label className="k" htmlFor="mdl-gw-url">{t("admin.models.gw.url")}</label>
          <input id="mdl-gw-url" className="mdl-input" value={url} spellCheck={false} autoComplete="off"
            placeholder="https://gateway.example.com/v1" onChange={(e) => setUrl(e.target.value)} />
        </div>
        {g?.base_url && g.base_url_valid === false
          ? <div className="mdl-hint err">{t("admin.models.gw.badStored")}</div>
          : <div className="mdl-hint">{t("admin.models.gw.hint")}</div>}
        <div className="mdl-kv" style={{ marginTop: 8 }}>
          <label className="k" htmlFor="mdl-gw-key">{t("admin.models.gw.key")}</label>
          {/* 谢绝自动填充（同 ApiKeyDrawer）：被填进来的登录密码会在「保存并验证」时发给外部网关。 */}
          <input id="mdl-gw-key" name="notiops-models-gateway-key" className="mdl-input" type="password" value={keyVal}
            autoComplete="new-password" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            data-1p-ignore data-lpignore="true" data-bwignore
            placeholder={g?.has_key && !hostChanged
              ? t("admin.models.gw.keyKeepPh").replace("{last4}", `****${g.last_4 || ""}`) : t("admin.models.gw.keyPh")}
            onChange={(e) => setKey(e.target.value)} />
        </div>
        {hostChanged && !keyVal.trim() && <div className="mdl-hint err">{t("admin.models.gw.hostChangedNeedKey")}</div>}
        <div className="mdl-kv" style={{ marginTop: 6 }}>
          <span className="k" />
          <div className="v">
            <Btn disabled={!canSave} onClick={() => onSave(false)}>{t("admin.models.gw.save")}</Btn>
            <span className="note">{t("admin.models.gw.saveHint")}</span>
          </div>
        </div>
        {msg && <div className={`mdl-msg ${msg.ok ? "ok" : "err"}`} role="status">{msg.text}</div>}
      </div>

      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.gw.dataOut")}</div>
        <div className="mdl-callout warn">
          {t("admin.models.gw.dataOutText").replace("{host}", host || t("admin.models.src.gateway"))}
        </div>
      </div>

      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.gw.models")}</div>
        <div className="mdl-kv">
          <label className="k" htmlFor="mdl-gw-default">{t("admin.models.col.default")}</label>
          <Select id="mdl-gw-default" className="mono" value={defaultAlias || ""} disabled={!fam.length || locked}
            onChange={(e) => onDefault(e.target.value)}>
            {!fam.length && <option value="">{t("admin.models.src.noModels")}</option>}
            {fam.map((m) => <option key={m.alias} value={m.alias}>{m.model_id}</option>)}
          </Select>
        </div>
        <div className="mdl-kv">
          <span className="k">{t("admin.models.gw.added")}</span>
          <div className="v">
            <span>{t("admin.models.gw.addedCount").replace("{n}", String(added))}</span>
            <Btn className="sm" id="mdl-gw-manage" disabled={!configured || locked} onClick={onManage}>{t("admin.models.gw.manage")}</Btn>
          </div>
        </div>
        <div className="mdl-kv">
          <span className="k">{t("admin.models.testBtn")}</span>
          <div className="v">
            <Btn className="sm" disabled={!configured || !defaultAlias || testing} onClick={onTest}
              title={t("admin.models.src.testTip")}>
              {testing ? t("admin.models.testing") : t("admin.models.gw.testDefault")}
            </Btn>
            {testResult
              ? <Tag kind={resultTone(testResult, true)} title={resultTip(testResult, t, true)}>{testLabel(testResult, t, true)}</Tag>
              : <span className="note">{t("admin.models.gw.testHint")}</span>}
          </div>
        </div>
        {testResult === "upstream_auth" && <div className="mdl-hint">{t("admin.models.test.upstreamAuthTip")}</div>}
      </div>

      <div className="mdl-blk">
        <div className="mdl-bt">{t("admin.models.gw.clearBlock")}</div>
        <div className="mdl-kv">
          <span className="k" />
          <div className="v">
            <Btn className="danger sm" disabled={saving || !configured || inUse} onClick={() => onSave(true)}>
              {t("admin.models.gw.clear")}
            </Btn>
            {inUse && configured && <span className="note">{t("admin.models.gw.clearInUse")}</span>}
          </div>
        </div>
      </div>
    </Drawer>
  );
}
