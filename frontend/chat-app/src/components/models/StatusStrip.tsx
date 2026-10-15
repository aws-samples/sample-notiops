/**
 * 「当前生效」条（A-1）：线上此刻 Web / IM 各走哪个来源的哪个模型；草稿改动了某条路由时，
 * 右侧虚线框写「保存后 …」。只标**已保存**的状态为当前 —— 拖动但没保存不改变线上在用的是谁。
 * 草稿第一来源是网关时多一句「⚠ 内容发往网关 ⓘ」（数据去向，只在这里和网关抽屉里各说一次）。
 */
import { useT } from "../../i18n";
import type { LlmModelEntry, LlmSource } from "../../api/admin";
import { isGateway } from "../modelSources";
import { InfoTip } from "./ui";

export interface Route { source: LlmSource; model?: LlmModelEntry }

function RouteView({ name, route, im }: { name: string; route: Route; im?: boolean }) {
  const t = useT();
  const m = route.model;
  return (
    <span className="mdl-route">
      <b>{name}</b>
      {im && <InfoTip label={t("admin.models.strip.imTip")} text={t("admin.models.strip.imTip")} side="down" align="center" />}
      <span className="mdl-arr" aria-hidden>→</span>
      <span>
        {t(`admin.models.src.${route.source}`)}
        <span className="mdl-faint"> · </span>
        {m ? (isGateway(m) ? <code>{m.model_id}</code> : (m.label || m.alias)) : "—"}
      </span>
    </span>
  );
}

const same = (a: Route, b: Route) => a.source === b.source && a.model?.alias === b.model?.alias
  && a.model?.model_id === b.model?.model_id;

export default function StatusStrip({ liveWeb, liveIm, nextWeb, nextIm }: {
  liveWeb: Route; liveIm: Route; nextWeb: Route; nextIm: Route;
}) {
  const t = useT();
  const webChanged = !same(liveWeb, nextWeb);
  const imChanged = !same(liveIm, nextIm);
  return (
    <div className="mdl-strip" aria-label={t("admin.models.strip.live")}>
      <span className="k">{t("admin.models.strip.live")}</span>
      <RouteView name={t("admin.models.strip.web")} route={liveWeb} />
      <RouteView name={t("admin.models.strip.im")} route={liveIm} im />
      {(webChanged || imChanged || nextWeb.source === "gateway") && (
        <span className="mdl-tail">
          {(webChanged || imChanged) && (
            <span className="mdl-after">
              <span className="k">{t("admin.models.strip.after")}</span>
              {webChanged && <RouteView name={t("admin.models.strip.web")} route={nextWeb} />}
              {imChanged && <RouteView name={t("admin.models.strip.im")} route={nextIm} />}
            </span>
          )}
          {nextWeb.source === "gateway" && (
            <span className="mdl-warnline">
              ⚠ {t("admin.models.strip.toGateway")}
              <InfoTip label={t("admin.models.strip.toGateway")} text={t("admin.models.strip.toGatewayTip")} side="down" align="end" />
            </span>
          )}
        </span>
      )}
    </div>
  );
}
