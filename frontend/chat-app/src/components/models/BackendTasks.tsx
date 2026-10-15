/**
 * 后台任务（A-1 底部）：PHD 翻译与报告精简各用哪个模型。一行一个任务：名字 / 下拉 / 右侧一句结论。
 *
 * 右侧那句只说例外，优先级：上次同步失败 → 读不到后端值 → 保存后实际会换成谁 → 部署时预置 →
 * 实际用的不是所选 → 所选不属于第一来源。「实际用谁」按草稿算（taskEffective 镜像 BFF backendTaskEntry），
 * 让管理员在点保存之前就看到后果。
 */
import { useT } from "../../i18n";
import type { BackendTaskRow, LlmModelEntry, LlmSource } from "../../api/admin";
import { isGateway } from "../modelSources";
import { InfoTip, Select, Tag } from "./ui";
import { taskEffective, type Defaults } from "./logic";

const BACKEND_TASKS = ["phd_translate", "devops_report_summarize"] as const;

export default function BackendTasks({ tasks, setTask, taskRows, models, defaults, active, saved, locked }: {
  tasks: Record<string, string>; setTask: (task: string, alias: string) => void; taskRows: BackendTaskRow[];
  models: LlmModelEntry[]; defaults: Defaults; active: LlmSource;
  saved: { models: LlmModelEntry[]; defaults: Defaults; active: LlmSource; tasks: Record<string, string> } | null;
  /** 保存请求在路上：下拉禁用。 */
  locked: boolean;
}) {
  const t = useT();
  const srcName = (s: LlmSource) => t(`admin.models.src.${s}`);
  const name = (m: LlmModelEntry) => (isGateway(m) ? <code>{m.model_id}</code> : <span>{m.label || m.alias}</span>);
  const fill = (key: string, m: LlmModelEntry) => {
    const [a, b] = t(key).split("{model}");
    return <span className="mdl-mut mdl-ell">{a}{name(m)}{b}</span>;
  };

  const note = (task: string) => {
    const row = taskRows.find((r) => r.task === task);
    const bound = tasks[task] || "";
    const eff = taskEffective(models, defaults, active, bound);
    const was = saved ? taskEffective(saved.models, saved.defaults, saved.active, saved.tasks[task] || "") : eff;
    const changed = (eff?.alias || "") !== (was?.alias || "") || (eff?.model_id || "") !== (was?.model_id || "");
    if (row?.status === "drift") return <span className="mdl-errtxt mdl-ell">{t("admin.models.outOfSync")}</span>;
    if (row?.status === "unknown") return <span className="mdl-faint mdl-ell">{t("admin.models.syncUnknown")}</span>;
    if (eff && changed) return fill("admin.models.task.usesAfterSave", eff);
    // 只在页面上也是「未绑定」时说预置：管理员刚选了模型还没保存，这句就不成立了。
    if (row?.status === "preset" && !bound) {
      return (
        <div className="mdl-cells">
          <Tag kind="gray">{t("admin.models.task.presetTag")}</Tag>
          <code className="mdl-mut mdl-ell">{row.projected_model_id}</code>
          <InfoTip label={t("admin.models.task.presetTag")} side="up" align="end"
            text={t("admin.models.taskPreset").replace("{model}", row.projected_model_id)} />
        </div>
      );
    }
    if (eff && eff.alias !== bound) return fill("admin.models.task.uses", eff);
    const b = models.find((m) => m.alias === bound && m.enabled);
    if (b && !eff) return <span className="mdl-mut mdl-ell">{t("admin.models.taskOtherSource").replace("{source}", srcName(active))}</span>;
    return null;
  };

  return (
    <div className="mdl-sec" style={{ marginBottom: 0 }}>
      <div className="mdl-sh">
        <span className="t">{t("admin.models.backendTitle")}</span>
        <InfoTip label={t("admin.models.backendTitle")} text={t("admin.models.backendTip")} side="down" align="start" />
      </div>
      <div className="mdl-tbl">
        {BACKEND_TASKS.map((task) => (
          <div key={task} className="mdl-tr mdl-grid-task">
            <div className="mdl-srcname mdl-ell">{t(`admin.models.task.${task}`)}</div>
            <div>
              <Select aria-label={t(`admin.models.task.${task}`)} value={tasks[task] || ""} disabled={locked}
                onChange={(e) => setTask(task, e.target.value)}>
                <option value="">{t(active === "gateway" ? "admin.models.followGatewayDefault" : "admin.models.followDefault")}</option>
                {/* 已启用的模型全部可选，按来源家族分组，第一来源的家族在前。绑的条目不属于第一来源时，
                    后端用第一来源的默认模型（服务端投影规则，见 llm_config.mjs backendTaskEntry），右侧会说出来。 */}
                {[active === "gateway", active !== "gateway"].map((gwFirst) => {
                  const items = models.filter((m) => m.enabled && isGateway(m) === gwFirst);
                  if (!items.length) return null;
                  return (
                    <optgroup key={String(gwFirst)} label={t(gwFirst ? "admin.models.group.gateway" : "admin.models.group.bedrock")}>
                      {items.map((m) => <option key={m.alias} value={m.alias}>{isGateway(m) ? m.model_id : (m.label || m.alias)}</option>)}
                    </optgroup>
                  );
                })}
              </Select>
            </div>
            <div className="mdl-col-note" style={{ display: "flex", minWidth: 0 }}>{note(task)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
