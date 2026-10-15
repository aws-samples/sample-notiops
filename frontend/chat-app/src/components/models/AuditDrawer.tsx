/**
 * 变更记录抽屉：谁在何时改过这份配置，每一条都能「回滚到此前」。
 * 回滚同样经过服务端现场探测（与保存同一套判定）；被拒时带结构化 `probe` 的给本地化原因。
 */
import { useT } from "../../i18n";
import type { fetchLlmAudit } from "../../api/admin";
import { Btn, Drawer, type FocusTarget } from "./ui";

export type AuditEntry = Awaited<ReturnType<typeof fetchLlmAudit>>["entries"][number];

/** 把服务端记的 `note` 换成一句人话；认不出的原样显示（只有主机与动作，不含凭证）。 */
export function auditNoteText(note: string | undefined, t: (k: string) => string): string {
  const n = String(note || "");
  if (!n) return "";
  const lag = n.endsWith(":not_propagated");
  const base = lag ? n.slice(0, -":not_propagated".length) : n;
  const m = /^(gateway_set|gateway_cleared):(.*?)->(.*)$/.exec(base);
  const host = (h: string) => (h && h !== "-" ? h : "—");
  let text = base;
  if (m && m[1] === "gateway_set") text = t("admin.models.audit.note.gatewaySet").replace("{from}", host(m[2])).replace("{to}", host(m[3]));
  else if (m) text = t("admin.models.audit.note.gatewayCleared").replace("{from}", host(m[2]));
  else if (base === "key_set") text = t("admin.models.audit.note.keySet");
  else if (base === "key_cleared") text = t("admin.models.audit.note.keyCleared");
  else if (base === "backend_tasks") text = t("admin.models.audit.note.backendTasks");
  else if (base.startsWith("rollback_to:")) text = t("admin.models.audit.note.rollback");
  return lag ? text + t("admin.models.audit.note.notPropagated") : text;
}

export default function AuditDrawer({ entries, loading, saving, msg, onRollback, onClose, returnFocus }: {
  entries: AuditEntry[]; loading: boolean; saving: boolean; msg: { ok: boolean; text: string } | null;
  onRollback: (sk: string) => void; onClose: () => void; returnFocus?: FocusTarget;
}) {
  const t = useT();
  return (
    <Drawer title={t("admin.models.audit")} onClose={onClose} closeLabel={t("admin.models.close")} returnFocus={returnFocus}
      footer={<><span style={{ flex: 1 }} /><Btn className="pri" onClick={onClose}>{t("admin.models.done")}</Btn></>}>
      {msg && <div className={`mdl-msg ${msg.ok ? "ok" : "err"}`} style={{ margin: "0 0 12px" }} role="status">{msg.text}</div>}
      {loading ? <div className="mdl-mut">{t("admin.models.loading")}</div>
        : !entries.length ? <div className="mdl-mut">{t("admin.models.auditEmpty")}</div> : (
          <div role="table" aria-label={t("admin.models.audit")}>
            <div className="mdl-audit h" role="row">
              <span role="columnheader">{t("admin.models.audit.when")}</span>
              <span role="columnheader">{t("admin.models.audit.who")}</span>
              <span role="columnheader">{t("admin.models.audit.gen")}</span>
              <span />
            </div>
            {entries.map((a) => (
              <div key={a.SK} className="mdl-audit" role="row">
                <span className="mdl-ell" role="cell">{(a.at || "").replace("T", " ").slice(0, 19)}</span>
                <span className="mdl-ell" role="cell">
                  {a.actor_name || a.actor_sub || "—"}
                  {a.note && <span className="mdl-faint mdl-ell" style={{ display: "block" }} title={auditNoteText(a.note, t)}>{auditNoteText(a.note, t)}</span>}
                </span>
                <span className="mdl-ell mdl-faint" role="cell" title={`${a.generation_before ?? ""} → ${a.generation_after ?? ""}`}>
                  …{String(a.generation_before ?? "").slice(-5)} → …{String(a.generation_after ?? "").slice(-5)}
                </span>
                <span role="cell">
                  <Btn className="sm" disabled={saving} onClick={() => onRollback(a.SK)}>{t("admin.models.rollback")}</Btn>
                </span>
              </div>
            ))}
          </div>
        )}
    </Drawer>
  );
}
