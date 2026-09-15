import { useState } from "react";
import { useLocale } from "../i18n";
import SecurityDashboard from "./SecurityDashboard";
import type { SecurityDashboardData } from "../api/security";
import { IconSecurity, IconInvestigate, IconChangelog, IconInspection } from "./icons";

/**
 * Security 仪表盘「两栏浏览器」—— 仿「通知」主题:左侧列各仪表盘,右侧显示选中项的完整内容。
 * 复用 NotificationsPanel 的 .notif2 / .notif-side / .notif-content 样式(团队一致),
 * 右侧内容委托给 SecurityDashboard 的「单 dashboard 模式」(传 dashboardId)。
 *
 * 入口有两个,都落在这里:
 *   ① 侧栏「安全」——「安全」2026-09-11 起不再是聊天主题(聊天并入「调查」),侧栏那一项
 *      就是**看板直达**,没有落地页。
 *   ② 「调查」输入框上方的「安全态势」胶囊。
 */
interface Dash {
  id: string;
  zh: string;
  en: string;
  /**
   * 该面板需要的能力 key。
   *
   * ⚠️ 必须与 `config/capabilities.json` 的 key 逐字一致。写错的表现是那一页对
   * **有权限的人**也被隐藏(`can()` 查不存在的 key 恒 false),而后端照样放行 ——
   * 不会有任何报错。
   */
  cap: string;
}

const DASHBOARDS: Dash[] = [
  { id: "ta-security", zh: "TA 安全建议", en: "TA Security", cap: "nav:security:ta-security" },
  { id: "hub-score", zh: "Security Hub", en: "Security Hub", cap: "nav:security:hub-score" },
  // GuardDuty 面板 2026-09-11 才接进目录。在这之前 SecurityDashboard 里那一段
  // (`show("guardduty")`)**永远选不中** —— 面板、接口、IAM 权限全都在,只是没有
  // 任何入口能把 dashboardId 设成 "guardduty"。能力 key 一直都下发着。
  { id: "guardduty", zh: "GuardDuty", en: "GuardDuty", cap: "nav:security:guardduty" },
  { id: "bulletins", zh: "安全公告", en: "Security Bulletins", cap: "nav:security:bulletins" },
];

const ICONS: Record<string, React.ReactNode> = {
  "ta-security": <IconSecurity size={16} />,
  "hub-score": <IconInvestigate size={16} />,
  "guardduty": <IconInspection size={16} />,
  "bulletins": <IconChangelog size={16} />,
};

export default function SecurityDashboardBrowser({
  data, can, initial = "ta-security",
  accountId, accounts, onInvestigate, onReload,
}: {
  data?: SecurityDashboardData;
  can?: (key: string) => boolean;
  initial?: string;
  accountId?: string;
  accounts?: { accountId: string; accountName?: string }[];
  onInvestigate?: (prompt: string) => void;
  /** 安全数据由上层托管（data prop）时，「重试」要请上层重取。 */
  onReload?: () => void;
}) {
  const { locale } = useLocale();
  const zh = locale !== "en";

  // 只列有权限的面板。`can` 未传(宿主还没拿到能力)时全显示 —— 后端仍会 403,
  // 这里 fail-open 只影响入口可见性,不影响数据。
  // 🔴 之前这里不做门禁:管理员在能力树里关掉某个安全面板后,目录里那一项照样在,
  //    点进去右侧一片空白(内容组件那侧有 cardVisible,会把整段渲染掉) —— 客户看到的
  //    是「点了没反应」,而不是「你没这个权限」。
  const visible = DASHBOARDS.filter((d) => !can || can(d.cap));
  const [picked, setPicked] = useState<string | null>(null);

  // ⚠️ 选中项是**派生值**,不是 effect 里纠偏的 state(与 InspectionDashboardBrowser 同口径):
  //    `initial` / `picked` 都可能指向当前用户无权的面板(降权、或能力异步到达后 visible 缩小),
  //    在 effect 里纠会先渲染一帧无权页 → 真的去打接口拿 403 → 错误提示闪一下再消失。
  const wanted = picked ?? initial;
  const sel = visible.some((d) => d.id === wanted) ? wanted : (visible[0]?.id ?? "");

  return (
    <div className="notif2">
      {/* 左侧:各仪表盘列表 */}
      <div className="notif-side">
        <div className="notif-side-head">
          <div className="notif-side-title"><IconSecurity size={17} /> {zh ? "安全仪表盘" : "Security Dashboards"}</div>
        </div>
        {visible.length > 0 && <div className="notif-side-group">{zh ? "仪表盘" : "Dashboards"}</div>}
        {visible.map((d) => (
          <button key={d.id} className={"notif-navitem" + (sel === d.id ? " active" : "")} onClick={() => setPicked(d.id)}>
            <span className="notif-navic">{ICONS[d.id]}</span>
            <span className="notif-navlabel">{zh ? d.zh : d.en}</span>
          </button>
        ))}
      </div>

      {/* 右侧:选中仪表盘的完整内容 */}
      <div className="notif-content">
        {sel ? (
          <SecurityDashboard dashboardId={sel} data={data} can={can}
            accountId={accountId} accounts={accounts} onInvestigate={onInvestigate} onReload={onReload} />
        ) : (
          /* 四个面板全被关掉。整个「安全」入口本来就该跟着一起隐藏(ChatApp 的
             showSecurity 门禁 nav:security),走到这里说明只关了子面板没关模块 ——
             给一句话,别留一片空白让人以为加载失败。 */
          <div style={{ color: "var(--muted)", fontSize: 13, padding: "40px 24px", textAlign: "center" }}>
            {zh ? "没有可查看的安全面板（请联系管理员开启）" : "No security panels available (ask your administrator to enable them)"}
          </div>
        )}
      </div>
    </div>
  );
}
