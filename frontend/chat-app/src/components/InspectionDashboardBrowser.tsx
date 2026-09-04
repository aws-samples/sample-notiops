import { useEffect, useRef, useState } from "react";

import { type FindingKind, isHiddenKind } from "../api/inspection";
import { deepLink } from "../deepLink";
import { useT } from "../i18n";
import InspectionDashboard from "./InspectionDashboard";
import { IconCustomize, IconInspection } from "./icons";

/**
 * 资源巡检看板「两栏浏览器」（R10.3）：左侧目录 + 右侧内容。
 *
 * 复用 `NotificationsPanel` 的 `.notif2` / `.notif-side` / `.notif-content`
 * 样式（团队一致），右侧委托给 `InspectionDashboard` 的单 dashboard 模式。
 *
 * ## 目录**三项、两分组**（R10.3）
 *
 * ```
 * 巡检   待处置          ← 默认落地：一屏列出今天要处置什么
 * 配置   巡检范围
 *        阈值与定时
 * ```
 *
 * 从六项砍到三项的理由见 `ENTRIES` 上方的说明。
 *
 * ⚠️ 两组不能合成一列。「看风险」与「改配置」是两类动作 ——
 * 混在一列会让「把生产库从巡检范围里摘掉」和「看看今天有什么风险」
 * 在导航上等价，而前者是一个会改变下一轮行为、且没有运行时信号的操作。
 *
 * ## 服务维度不进左侧导航（R10.4）
 *
 * RDS / Aurora / ElastiCache 的筛选在**右侧内容区**做（阈值页的
 * `ServiceFilter`、排除弹层的服务 chip）。放进左侧会让目录变成
 * 「服务 × 页面」的笛卡尔积，而客户的问题是「今天有什么风险」
 * 而不是「RDS 有什么风险」。
 */

type Group = "findings" | "settings";

interface Entry {
  id: string;
  group: Group;
  labelKey: string;
  icon: React.ReactNode;
  /**
   * 该页需要的能力 key。`undefined` = 跟随 tab。
   *
   * ⚠️ 必须与 `config/capabilities.json` 的 key 逐字一致。写错的表现是
   * 那一页对**有权限的人**也被隐藏（`can()` 查一个不存在的 key 恒 false），
   * 而后端照样放行 —— 所以不会有任何报错。
   */
  cap?: string;
  /**
   * 「这几个能力里有任意一个就显示」。
   *
   * ⚠️ 与 `cap` 互斥。聚合页（待处置）必须用它 —— 用单个 key 的话，
   * 只有闲置权限的人会看不到那一页，而他本该看到闲置那一类。
   */
  /**
   * 这一项对应哪个 finding kind。**只有三个规则类页有。**
   *
   * 用来接 `api/inspection.ts::HIDDEN_KINDS` 的可见性开关 —— 隐藏一类时
   * 只改那一个常量，导航项、看板请求集、深链落点三处一起跟着变。
   */
  kind?: FindingKind;
}

/**
 * 目录 6 → 3。
 *
 * 🔴 为什么砍掉三个规则类子页：「高负载 / 闲置 / 结构性」是**我们的**分类
 * 维度，不是客户的。客户的维度是严重度和「这台是不是生产库」。旧结构下
 * 要三次点击才看到第一条风险，而三页之和才是「今天要处置什么」。
 * 现在它们降为待处置页里的筛选 chip —— 同一份信息，少两次点击。
 *
 * 🔴 为什么砍掉「巡检总览」：那一页回答的是「巡检系统本身正常吗」
 * （采集完整度 / 未做根因分析 / runs 表），全是运维自检。客户原话是
 * 「点进来这个 TAB 只有一个按钮，中间红色区域都是没用的」。
 * 它的内容进了待处置页底部的「系统状态」折叠区 —— 需要时能看到，
 * 但不再占着「打开先看到什么」这个位置。
 *
 * ⚠️ 两个分组仍然保留。「看风险」与「改配置」是两类动作 —— 混成一列会让
 * 「把生产库从巡检范围里摘掉」和「看看今天有什么风险」在导航上等价，
 * 而前者会改变下一轮的行为且没有运行时信号。
 */
const ENTRIES: Entry[] = [
  // ── 看风险：三类各自一页 ───────────────────────────────────────────
  //
  // 上一版把三类合成一页「待处置」+ 筛选 chip。合并的理由（少两次点击）
  // 站得住，但它让**排序无解**：一页只能有一个排序键，而
  //
  // ```
  // 高负载   按紧急度排   CRITICAL 的 CPU 打满要在最上面
  // 闲置     按金额排     省 $400 的比省 $12 的值得先看
  // ```
  //
  // 合并页选了 severity 序，而闲置类的 severity **恒为 INFO**
  // （`assemble.idle_findings` 写死），于是闲置条目永远沉在列表底部 ——
  // 那一页唯一能立刻拿走的收益被排到了看不见的地方。
  // 处置节奏也不同：高负载「现在看一眼」，闲置「本月排期降配」。
  // ⚠️ 三个规则类页**都要**标 `kind`，不能只标当前被隐藏的那一个。
  //    只标一个的表现：`landingFor` / `visible` 里的 `e.kind` 判断对另两项
  //    恒为 undefined，于是那两条分支从没被真正执行过 —— 哪天换成隐藏
  //    「闲置」，机制会静默失效（导航项照样显示、深链照样落过去）。
  {
    id: "high-load", group: "findings", labelKey: "insp.tab.highLoad",
    icon: <IconInspection size={16} />, cap: "nav:inspection:high-load",
    kind: "high_load",
  },
  {
    id: "idle", group: "findings", labelKey: "insp.tab.idle",
    icon: <IconInspection size={16} />, cap: "nav:inspection:idle",
    kind: "idle",
  },
  {
    id: "structural", group: "findings", labelKey: "insp.tab.structural",
    icon: <IconInspection size={16} />, cap: "nav:inspection:structural",
    /* 🔴 **当前隐藏**（2026-08-31，客户要求「整个配置检查的 tab 都 hide」）。
       条目留在表里而不是删掉 —— 见 `hiddenKind` 的说明：放回来只需清空
       `api/inspection.ts::HIDDEN_KINDS`，这里不用再改一次。 */
    kind: "structural",
  },
  // ── 改配置 ────────────────────────────────────────────────────────
  {
    id: "scope", group: "settings", labelKey: "insp.tab.scope",
    icon: <IconCustomize size={16} />, cap: "nav:inspection:scope",
  },
  {
    id: "config", group: "settings", labelKey: "insp.tab.config",
    icon: <IconCustomize size={16} />, cap: "nav:inspection:config",
  },
];

/**
 * 老子页 id → 新 id。
 *
 * 🔴 **已经发出去的 IM 深链还在客户手里。** 推送里每条 finding 后面挂的
 * 链接形如 `?account=…&finding=…&tab=high-load`（`adapters/links.py` 拼，
 * `push_policy.tab_for_rule` 决定 tab 值）。导航里没有这些 id 了，但链接
 * 必须继续能用 —— 落不到位的表现是客户点开推送里的「详情」，看到的是
 * 默认页而不是那条 finding，且没有任何提示。
 *
 * `InspectionDashboard` 那侧按老 id 决定预选哪个 chip / 是否展开系统状态。
 */
const LEGACY_TAB: Record<string, string> = {
  // 三类各自一页之后（2026-08-24），`high-load` / `idle` / `structural`
  // **就是**正式 id，不需要映射 —— 深链天然落到对的那一页。
  // 只剩这两个老 id 需要转：
  overview: "high-load",   // 老「巡检总览」页，内容已进高负载页底部的「系统状态」
  triage: "high-load",     // 合并页时代的默认落地页
};

/**
 * 深链带的 tab → 真正要落的页。
 *
 * 除了上面那张老 id 映射表，还要处理**被隐藏的那一类**：
 * `push_policy.tab_for_rule` 给结构性规则拼的就是 `?tab=structural`，
 * 这些链接已经在客户 IM 里了。隐藏之后不转的表现是 `picked` 停在一个
 * 不在 `visible` 里的 id，于是走 `fallback` —— 结果虽然对，但靠的是
 * 「碰巧」而不是「写清楚了」，而 `fallback` 是 `visible[0]`（权限一变就变）。
 */
function landingFor(tab: string): string {
  const id = LEGACY_TAB[tab] || tab;
  const e = ENTRIES.find((x) => x.id === id);
  if (e?.kind && isHiddenKind(e.kind)) return "high-load";
  return id;
}

const GROUP_LABEL: Record<Group, string> = {
  findings: "insp.group.findings",
  settings: "insp.group.settings",
};

export default function InspectionDashboardBrowser({
  can, onNavigate, initial = "high-load",
  accountId, accounts, onAccountChange,
}: {
  can?: (key: string) => boolean;
  /* ⚠️ `onInvestigate` 已删（2026-08-31）：「深入分析」改成派 DA 判读，
     实现留在 `InspectionDashboard` 内，不需要宿主给回调。 */
  /** 把当前子页回传给宿主（ChatApp 存它，切走再回来能停在原页）。 */
  onNavigate?: (id: string) => void;
  initial?: string;
  accountId?: string;
  accounts?: { accountId: string; accountName?: string }[];
  onAccountChange?: (id: string) => void;
}) {
  const t = useT();
  // 只显示有权限的页。`can` 未传（宿主还没拿到能力）时全显示 ——
  // 后端仍会 403，这里 fail-open 只影响入口可见性，不影响数据。
  const visible = ENTRIES.filter((e) => {
    // 被隐藏的规则类页先出局 —— 这一层与权限无关，`can` 未到也照样隐藏。
    if (e.kind && isHiddenKind(e.kind)) return false;
    if (!can) return true;              // 能力还没到 → fail-open，只影响入口可见性
    return !e.cap || can(e.cap);
  });

  const fallback = visible[0]?.id ?? "high-load";
  /**
   * 手动选中的子页。
   *
   * ⚠️ 深链带的 tab 走**惰性初始值**而不是 effect 里 setState ——
   * 后者会触发级联渲染（eslint 的 `react-hooks/set-state-in-effect`），
   * 而且会先渲染一帧默认页再跳走，视觉上闪一下。
   * `deepLink` 是模块级读一次的常量，所以在初始值里读它是安全的。
   */
  const [picked, setPicked] = useState<string | null>(
    () => (deepLink.tab ? landingFor(deepLink.tab) : null));

  // ── 推送深链（R11b.7）────────────────────────────────
  //
  // 🔴 只在**首次挂载**生效，之后客户手动切换不受影响。`deepLink` 是模块级
  //    读一次的常量（读完就把参数从 URL 上摘掉），所以这里不需要防抖 ——
  //    但仍然用 ref 记「已消费」，因为 onAccountChange 会让宿主重渲染，
  //    而重渲染时 deepLink.account 还在（同一个模块常量）。
  const linkUsed = useRef(false);
  useEffect(() => {
    if (linkUsed.current) return;
    linkUsed.current = true;
    // ⚠️ 这个 effect 现在**只做一件事**：把深链带的账号回传给宿主。
    //    tab 走上面的惰性初始值 —— 在 effect 里 setState 会级联渲染。
    if (deepLink.account && onAccountChange) onAccountChange(deepLink.account);
  }, [onAccountChange]);

  // ⚠️ 选中项是**派生值**而不是 effect 里纠偏的 state。
  //    用 `useEffect(() => { if (无权) setSel(fallback) })` 会：
  //      ① 触发级联渲染（eslint 的 react-hooks 规则直接报错）
  //      ② 先渲染一帧「无权的那一页」再纠回 —— 那一帧会真的去打接口，
  //         拿回 403，于是错误提示闪一下再消失
  //    派生的写法两个问题都没有：无权时压根不会被选中。
  //
  //    `initial` 可能指向当前用户无权的页（降权后从宿主 state 恢复过来），
  //    `picked` 同理（能力异步到达后 visible 会缩小）。
  const wanted = picked ?? initial;
  const sel = visible.some((e) => e.id === wanted) ? wanted : fallback;

  /**
   * 用户手动导航过没有。
   *
   * ⚠️ 与 `picked !== null` **不等价** —— 深链会把 `picked` 设成初始值。
   * 只有真的点过左侧目录才算「手动」。
   */
  const [navigated, setNavigated] = useState(false);

  const go = (id: string) => {
    setNavigated(true);
    setPicked(id);
    onNavigate?.(id);
  };

  const groups: Group[] = ["findings", "settings"];

  return (
    <div className="notif2">
      <div className="notif-side">
        <div className="notif-side-head">
          <div className="notif-side-title">
            <IconInspection size={17} /> {t("insp.title")}
          </div>
        </div>
        {groups.map((g) => {
          const items = visible.filter((e) => e.group === g);
          // 空组不渲染标题 —— 一个只有标题没有条目的分组看起来像加载失败。
          if (items.length === 0) return null;
          return (
            <div key={g}>
              <div className="notif-side-group">{t(GROUP_LABEL[g])}</div>
              {items.map((e) => (
                <button key={e.id}
                  className={"notif-navitem" + (sel === e.id ? " active" : "")}
                  onClick={() => go(e.id)}>
                  <span className="notif-navic">{e.icon}</span>
                  <span className="notif-navlabel">{t(e.labelKey)}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>

      <div className="notif-content">
        <InspectionDashboard
          /*
           * 三类各自一页之后，`high-load` / `idle` / `structural` 已经是正式
           * id —— 深链天然落到对的那一页，`sel` 本身就是要传的值。
           *
           * 只有 `?tab=overview` 还需要把**原值**传下去：它映射到高负载页，
           * 而内容组件要靠原值决定「系统状态」区默认展开
           * （那一区是老「巡检总览」页的全部内容，客户点老链接是为了看它）。
           *
           * 🔴 `navigated` 那一项是必须的。`deepLink` 是模块级常量，值留一整个
           * SPA 会话；不看「用户后来有没有手动导航过」的话，切到「巡检范围」
           * 再切回来，「系统状态」又会被展开一次 —— 客户手动折叠的动作
           * 在整个会话里都不生效。
           */
          dashboardId={
            !navigated && sel === "high-load" && deepLink.tab === "overview"
              ? "overview" : sel
          }
          can={can}
          /* ⚠️ **不再往下传 `onAccountChange`**（2026-09-01）：内容组件里那个
             页面级账号选择器已经删了（三页都不以账号为加载维度）。
             本组件自己的 `onAccountChange` 保留 —— 深链 `?account=` 靠它
             回传给 ChatApp。 */
          accountId={accountId} accounts={accounts}
          /* 🔴 与上面 `dashboardId` 同一个守卫。`deepLink.finding` 是模块级
             常量（会话内恒定），而 `linkConsumed` 是 TriagePage 的 state ——
             切到「巡检范围 / 阈值」时 TriagePage 真的卸载，state 重置为 false。

             表现：点推送里的「详情」→ 抽屉自动打开那条 finding → 客户关掉、
             去「巡检范围」看一眼 → 切回「高负载」→ **抽屉又弹开同一条**，
             卡片又高亮又滚动。整个 SPA 会话里每次回到风险页都来一遍。

             ⚠️ `?tab=overview` 那条路径已经为同一个陷阱加了 `navigated` 守卫
             （见上面那段注释），`?finding=` 漏了。 */
          highlight={navigated ? "" : deepLink.finding} />
      </div>
    </div>
  );
}
