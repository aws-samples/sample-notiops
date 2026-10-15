/**
 * 页头：标题 + 一句副标题；右侧「{when} 由 {who} 保存」（悬停看配置版本）+「变更记录」。
 * 配置版本是 epoch-ms，原样摆 13 位数字没有可读性，所以只进 title。
 */
import { useT } from "../../i18n";
import type { LlmConfig } from "../../api/admin";
import { Btn } from "./ui";

export default function PageHeader({ cfg, onAudit, auditOpen }: {
  cfg: LlmConfig | null; onAudit: () => void; auditOpen: boolean;
}) {
  const t = useT();
  const when = (cfg?.updated_at || "").slice(0, 10);
  const who = cfg?.updated_by || t("admin.models.keySetByUnknown");
  return (
    <div className="mdl-hd">
      <div>
        <div className="mdl-title">{t("admin.models.title")}</div>
        <div className="mdl-sub">{t("admin.models.sub")}</div>
      </div>
      <div className="mdl-hbtns">
        {cfg && when && (
          <span className="mdl-faint mdl-smt" title={`${t("admin.models.generation")} ${cfg.generation}`}>
            {t("admin.models.savedBy").replace("{when}", when).replace("{who}", who)}
          </span>
        )}
        <Btn id="mdl-audit-btn" onClick={onAudit} aria-expanded={auditOpen}>{t("admin.models.audit")}</Btn>
      </div>
    </div>
  );
}
