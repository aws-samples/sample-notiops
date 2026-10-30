import { useEffect, useState } from "react";
import Logo from "./Logo";
import { useT, useLocale } from "../i18n";
import type { Conversation, TopicKey } from "../types";
import { TOPICS } from "../types";
import {
  // IconSecurity 不在这里了 —— 侧栏没有「安全」这一项（见下方 nav 里那段注释）。
  IconNewChat, IconInvestigate, IconFinOps, IconCases,
  IconInspection, IconMore, IconSkill, IconCustomize, IconWhatsNew, IconChevronRight, IconBell,
  IconCollapseAll, IconExpandAll,
} from "./icons";
import ConvItem from "./ConvItem";
import UserMenu from "./UserMenu";
import type { MfaMode } from "../api/mfa";

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  busyIds?: Set<string>;    // 正在生成(思考/流式输出)的会话 id 集合 → 列表显活跃状态点
  unreadIds?: Set<string>;  // 后台完成、未读的会话 id 集合 → 列表显未读红点
  onSelect: (id: string) => void;
  onNew: (topic?: TopicKey) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  username: string;
  onSignOut: () => void;
  /** 两步验证档位与「打开设置框」—— 透传给左下角 UserMenu。 */
  mfaMode?: MfaMode | null;
  onTwoFactor?: () => void;
  width?: number;
  onSkills?: () => void;        // 打开独立 Skills 页（收进「更多」，中文标签「技能」）
  skillsActive?: boolean;       // Skills 页当前是否激活（高亮）
  onCustomize?: () => void;     // 打开 Customize（定制）页（收进「更多」）
  customizeActive?: boolean;    // Customize 页当前是否激活（高亮）
  onWhatsNew?: () => void;      // 打开 What's New（AWS 新发布学习空间）
  onNotifications?: () => void; // 打开「通知」收件箱
  notificationsActive?: boolean;// 通知页当前是否激活（高亮）
  notifUnread?: number;         // 未读通知数（>0 显示红点角标）
  onFinops?: () => void;        // 打开「FinOps」仪表盘独立页（不再走聊天主题）
  finopsActive?: boolean;       // FinOps 页当前是否激活（高亮）
  onCases?: () => void;         // 打开「Cases」仪表盘独立页（不再走聊天主题）
  casesActive?: boolean;        // Cases 页当前是否激活（高亮）
  onAdmin?: () => void;         // 打开「管理」页（角色/用户/模块）
  adminActive?: boolean;        // 管理页当前是否激活（高亮）
  // 2026-09-11：`onSecurity` / `securityActive` / `showSecurity` 三条已删 —— 侧栏不再有
  // 「安全」这一项（产品要求）。安全看板还在，唯一入口是**「调查」输入框上方的「安全态势」
  // 胶囊**（ChatApp 的 dashPillsFor）。要复活侧栏入口的话别只加 prop：门禁必须写成
  // `isAdmin || (capsLoaded && can("nav:security"))`，与那颗胶囊逐字一致。
  onInvestigate?: () => void;   // 打开「调查」告警仪表盘独立页
  investigateActive?: boolean;  // 调查页当前是否激活（高亮）
  onInspection?: () => void;    // 打开「资源巡检」看板独立页（站内，非外链）
  inspectionActive?: boolean;   // 巡检页当前是否激活（高亮）
  showFinops?: boolean;         // 能力门禁：是否显示 FinOps 入口（默认 true）
  showCases?: boolean;          // 能力门禁：是否显示 Cases 入口（默认 true）
  showAdmin?: boolean;          // 能力门禁：是否显示 管理 入口（默认 false，仅 admin 可见）
  showNotifications?: boolean;  // 能力门禁：Notifications（默认 true）
  showInvestigation?: boolean;  // 能力门禁：Investigation（默认 true）
  showSkills?: boolean;         // 能力门禁：Skills（默认 true）
  showCustomize?: boolean;      // 能力门禁：Customize（默认 true）
  /**
   * 能力门禁：资源巡检看板（默认 **false**，需 `nav:inspection`）。
   *
   * ⚠️ 默认 false 而不是 true —— 与 Admin 同档（Security 那一项已不在侧栏里）。巡检看板会显示
   * 客户的排除清单与阈值配置，那是运维决策而不是公开信息。
   * 默认 true 会让能力还没加载完的那一瞬间对所有人闪出这个入口。
   */
  showInspection?: boolean;
}

const PanelIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <line x1="9" y1="4" x2="9" y2="20" />
  </svg>
);

/* 「巡检 & 报告」外链已随老 idle 控制台退役（2026-09-04）——
   原先由 SHOW_INSPECTIONS=false 隐藏、代码保留；控制台整体删除后
   openConsole()/按钮/idleConsoleUrl 一并移除。站内巡检看板不受影响
   （nav:inspection 那套是独立入口）。 */

/**
 * 「更多」折叠组（2026-10-10 用户要求）：收「巡检 / 技能 / 管理」三项，一级导航只留
 * 通知 / 调查 / 成本 / 案例 四个高频入口。
 *
 * 历史：2026-09-11 曾反过来 —— 把「管理」提到一级（admin 每天要点、新 admin 找不到它），组里只剩
 * 一个还没内容的「定制」，于是整组隐藏。这次是产品决定收回来；为了不让「找不到」重演，两条规矩：
 *   · 当前页就是组里某一项时**自动展开** —— 否则人站在「管理」页上，导航里却看不见「管理」；
 *   · 展开 / 收起由用户决定并**记住**（localStorage）：admin 展开一次，以后一直是展开的。
 *   （自动展开不写回记忆 —— 那是"当前页需要"，不是用户的偏好。）
 * 三项都没有权限时连「更多」按钮都不渲染 —— 点开是空盒子比没有这个按钮更糟。
 *
 * 「定制」仍然不显示（页面还没真正的功能）：由 `SHOW_CUSTOMIZE_ITEM` 关着。⚠️ 是隐藏不是删除 ——
 * `onCustomize` / `customizeActive` / `showCustomize` 与下面的 JSX 一并保留，`ChatApp.tsx` 照旧传；
 * 定制页做出来后改成 `true` 即可，改之前先确认那一页真有内容。
 */
const SHOW_CUSTOMIZE_ITEM = false;
/** 「更多」展开态的记忆（"1" / "0"）。与会话分组的 notiops.collapsedGroups 同一套做法。 */
const MORE_OPEN_KEY = "notiops.moreOpen";

export default function Sidebar({ conversations, activeId, busyIds, unreadIds, onSelect, onNew, onRename, onTogglePin, onDelete, collapsed, onToggle, username, onSignOut, mfaMode = null, onTwoFactor, width = 264, onSkills, skillsActive, onCustomize, customizeActive, onWhatsNew, onNotifications, notificationsActive, notifUnread = 0, onFinops, finopsActive, onCases, casesActive, onAdmin, adminActive, showFinops = true, showCases = true, showAdmin = false, showNotifications = true, showInvestigation = true, showSkills = true, showCustomize = true, onInvestigate, investigateActive, onInspection, inspectionActive, showInspection = false }: Props) {
  const t = useT();
  const { locale } = useLocale();
  // 「更多」子菜单的展开态：用户上次的选择（默认收起）。
  const [moreOpen, setMoreOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(MORE_OPEN_KEY) === "1"; } catch { return false; }
  });
  const toggleMore = () =>
    setMoreOpen((v) => {
      const next = !v;
      try { localStorage.setItem(MORE_OPEN_KEY, next ? "1" : "0"); } catch { /* 忽略：隐私模式等 */ }
      return next;
    });
  // 当前页在组里 → 展开（只在"进入"那一刻展开一次；之后用户再收起就尊重他，不会被反复弹开）。
  // 每一项都要**连同它的门禁**一起算：无权限的人点了「管理 Skills」这类别处的入口，ChatApp 会先
  // 置 skillsActive、再在同一轮 effect 里把他弹回聊天页 —— 只看 active 的话，「更多」会被凭空展开，
  // 而且展开的是一个他看不见那一项的菜单（2026-10-10 独立审查发现）。
  const moreChildActive = Boolean((showInspection && inspectionActive) || (showSkills && skillsActive)
    || (showAdmin && adminActive) || (SHOW_CUSTOMIZE_ITEM && showCustomize && customizeActive));
  useEffect(() => { if (moreChildActive) setMoreOpen(true); }, [moreChildActive]);
  // 子菜单里到底有没有东西：一项都没有就连「更多」按钮一起藏，别让用户点开一个空菜单。
  const hasMoreItems = showInspection || showSkills || showAdmin || (SHOW_CUSTOMIZE_ITEM && showCustomize);

  // 主题会话分组的收起态：记录**已收起**的组 key（默认全部展开）。持久化到 localStorage，跨刷新保留。
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("notiops.collapsedGroups");
      return raw ? new Set<string>(JSON.parse(raw)) : new Set<string>();
    } catch { return new Set<string>(); }
  });
  // 收起态写回 localStorage 的唯一出口（单组 toggle 与「全部折叠/展开」共用，避免两处各写一遍）
  const persistCollapsed = (next: Set<string>) => {
    try { localStorage.setItem("notiops.collapsedGroups", JSON.stringify([...next])); } catch { /* 忽略：隐私模式等 */ }
    return next;
  };
  const toggleGroup = (key: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return persistCollapsed(next);
    });

  // 会话列表按"最近活动时间"(updatedAt)降序——发过消息/刚打开的排在最前，
  // 而不是固定的创建顺序。置顶组同样按活动时间排。
  const byRecent = (a: Conversation, b: Conversation) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
  const pinned = conversations.filter((c) => c.pinned).sort(byRecent);
  const recent = conversations.filter((c) => !c.pinned).sort(byRecent);

  // 非置顶会话按主题分组：主题组顺序与上方主题导航一致（TOPICS 顺序），
  // 但**通用组排在最前**（在「调查」之上）—— 新建会话默认落 general，放最上面才好找，
  // 不用每次滚到底。组内按最近活动时间降序。
  // 空组不渲染标题。置顶组独立在最上，不参与主题分组。
  const groups: { key: string; labelKey: string; items: Conversation[] }[] = [
    { key: "general", labelKey: "topic.general", items: [] as Conversation[] },
    ...TOPICS.map((tp) => ({ key: tp.key, labelKey: tp.labelKey, items: [] as Conversation[] })),
  ];
  const groupIndex = new Map(groups.map((g, i) => [g.key, i]));
  for (const c of recent) {
    const gi = groupIndex.get(c.topic ?? "general") ?? groupIndex.get("general")!;
    groups[gi].items.push(c);
  }

  // 「一键折叠/展开全部」：只针对**当前可见**（非空）的组。空组不渲染标题，
  // 把它们算进来会让按钮状态和用户看到的画面不一致（比如全部收起了却还显示"折叠全部"）。
  const visibleGroups = groups.filter((g) => g.items.length > 0);
  const allCollapsed = visibleGroups.length > 0 && visibleGroups.every((g) => collapsedGroups.has(g.key));
  // 只有 ≥2 个可见组时才值得给批量按钮（1 个组时点标题就够了）
  const showBulkToggle = visibleGroups.length > 1;
  const toggleAllGroups = () =>
    setCollapsedGroups((prev) => {
      // 已全部收起 → 展开全部：只删可见组的 key，保留不可见组的收起态
      // （否则某主题的会话被删空又新建时，用户之前给它设的收起态会被悄悄清掉）
      const next = new Set(prev);
      if (allCollapsed) visibleGroups.forEach((g) => next.delete(g.key));
      else visibleGroups.forEach((g) => next.add(g.key));
      return persistCollapsed(next);
    });


  // 点主题入口 = 新建一个带该主题 tag 的会话（通用能力 + 主题上下文/分类）。
  // 后续每个主题可在 agent 侧按 topic 做特定微调；当前共享同一通用 agent。

  return (
    <aside className={"sidebar" + (collapsed ? " collapsed" : "")} style={collapsed ? undefined : { width }}>
      <div className="sb-brand">
        <span className="sb-brandname">
          <Logo /> NotiOps
        </span>
        <button className="panel-btn" title={t("sidebar.collapse")} onClick={onToggle}>
          <PanelIcon />
        </button>
      </div>

      <button className="sb-new" onClick={() => onNew()}><span className="ni-ic"><IconNewChat /></span>{t("app.newChat")}</button>

      <nav className="sb-nav">
        {/* 通知（主动观察 push）：置顶一级入口，未读时右侧红点角标 —— 运维最先关心的信息流。 */}
        {showNotifications && (
          <button className={"navitem" + (notificationsActive ? " active" : "")} onClick={() => onNotifications?.()}>
            <span className="ni-ic"><IconBell /></span>{t("topic.notifications")}
            {notifUnread > 0 && <span className="ni-badge">{notifUnread > 99 ? "99+" : notifUnread}</span>}
          </button>
        )}
        {/* 主题入口（②）：点击将在右侧打开该主题的定制 chat 页。 */}
        {showInvestigation && <button className={"navitem" + (investigateActive ? " active" : "")} onClick={() => onInvestigate?.()}><span className="ni-ic"><IconInvestigate /></span>{t("topic.investigate")}</button>}
        {showFinops && <button className={"navitem" + (finopsActive ? " active" : "")} onClick={onFinops}><span className="ni-ic"><IconFinOps /></span>{t("topic.cost")}</button>}
        {/* ⚠️ 这里**没有**「安全」——2026-09-11 产品要求从侧栏去掉（安全已并入「调查」，
            留一个同名一级入口会让人以为它还是个独立的聊天主题）。安全**看板**没删，
            入口是「调查」输入框上方的「安全态势」胶囊。别顺手补回来。 */}
        {showCases && <button className={"navitem" + (casesActive ? " active" : "")} onClick={onCases}><span className="ni-ic"><IconCases /></span>{t("topic.cases")}</button>}
        {/* 「更多」：巡检 / 技能 / 管理 收在这里（2026-10-10，见文件头 SHOW_CUSTOMIZE_ITEM 上那段）。
            三项各自的门禁不变；一项都没有时整个按钮不渲染。 */}
        {hasMoreItems && (
          <button className={"navitem" + (moreOpen ? " expanded" : "")} onClick={toggleMore}
            aria-expanded={moreOpen} aria-controls="sb-more-menu">
            <span className="ni-ic"><IconMore /></span>{t("nav.more")}
            <span className={"ni-caret" + (moreOpen ? " open" : "")}><IconChevronRight size={15} /></span>
          </button>
        )}
        {hasMoreItems && moreOpen && (
          <div className="sb-submenu" id="sb-more-menu">
            {/* 巡检：站内看板（需 nav:inspection；方式A 没有巡检后端，那里压根不出现）。 */}
            {showInspection && (
              <button className={"navitem subitem" + (inspectionActive ? " active" : "")} onClick={() => onInspection?.()}>
                <span className="ni-ic"><IconInspection /></span>{t("insp.title")}
              </button>
            )}
            {/* 技能（Skills 管理页）：中文导航标签是「技能」，功能名仍叫 Skill。 */}
            {showSkills && (
              <button className={"navitem subitem" + (skillsActive ? " active" : "")} onClick={() => onSkills?.()}>
                <span className="ni-ic"><IconSkill /></span>{t("cz.nav.skills")}
              </button>
            )}
            {/* 管理：仅 admin 可见（后端 nav:admin 门禁 + 前端能力过滤）。角色 / 用户 / 模块。 */}
            {showAdmin && (
              <button className={"navitem subitem" + (adminActive ? " active" : "")} onClick={() => onAdmin?.()}>
                <span className="ni-ic"><IconCustomize /></span>{t("nav.admin")}
              </button>
            )}
            {/* 定制：页面还没内容，SHOW_CUSTOMIZE_ITEM 关着（接线保留）。 */}
            {SHOW_CUSTOMIZE_ITEM && showCustomize && (
              <button className={"navitem subitem" + (customizeActive ? " active" : "")} onClick={() => onCustomize?.()}>
                <span className="ni-ic"><IconCustomize /></span>{t("nav.customize")}
              </button>
            )}
          </div>
        )}
      </nav>

      <div className="sb-divider" />
      <div className="sb-list">
        {pinned.length > 0 && (
          <>
            <div className="sb-sec">{t("sidebar.pinned")}</div>
            {/* 置顶组混合各主题；showTag 默认 true → 连不知道对话对象的老通用会话也标「通用」 */}
            {pinned.map((c) => (
              <ConvItem key={c.id} conv={c} active={c.id === activeId}
                busy={busyIds?.has(c.id)} unread={unreadIds?.has(c.id)}
                onSelect={() => onSelect(c.id)}
                onRename={(title) => onRename(c.id, title)}
                onTogglePin={() => onTogglePin(c.id)}
                onDelete={() => onDelete(c.id)} />
            ))}
          </>
        )}
        {/* 一键折叠/展开全部分组：组多了逐个点太烦。只在 ≥2 个非空组时出现。
            与单组 toggle 共用同一份 collapsedGroups 持久化。 */}
        {showBulkToggle && (
          <div className="sb-groups-bar">
            <button className="sb-groups-toggle" onClick={toggleAllGroups}
              title={t(allCollapsed ? "sidebar.expandAll" : "sidebar.collapseAll")}
              aria-label={t(allCollapsed ? "sidebar.expandAll" : "sidebar.collapseAll")}>
              {allCollapsed ? <IconExpandAll size={14} /> : <IconCollapseAll size={14} />}
              <span>{t(allCollapsed ? "sidebar.expandAll" : "sidebar.collapseAll")}</span>
            </button>
          </div>
        )}
        {/* 主题分组：每条会话右侧一枚 tag，口径与顶栏一致（用户 2026-10-13，见 ConvItem）——
            主题会话显示主题 tag（调查 / 成本 / 案例 / What's New），通用会话显示「对话对象」tag
            （NotiOps / DevOps / STAROps：「通用」这一组全靠它才分得开）。
            ⚠️ showTag=false 只影响**不知道对话对象**的老通用会话：组标题已写着「通用」，不再重复。
            标题可点击收起/展开该组（caret 指示，收起态持久化）。 */}
        {groups.map((g) => {
          if (g.items.length === 0) return null;
          const isCollapsed = collapsedGroups.has(g.key);
          return (
            <div key={g.key}>
              <button className={"sb-sec sb-sec-btn" + (isCollapsed ? " collapsed" : "")}
                onClick={() => toggleGroup(g.key)}
                title={isCollapsed ? (locale === "en" ? "Expand" : "展开") : (locale === "en" ? "Collapse" : "收起")}>
                <span className={"sb-sec-caret" + (isCollapsed ? "" : " open")}><IconChevronRight size={13} /></span>
                <span className="sb-sec-label">{t(g.labelKey)}</span>
              </button>
              {!isCollapsed && g.items.map((c) => (
                <ConvItem key={c.id} conv={c} active={c.id === activeId}
                  busy={busyIds?.has(c.id)} unread={unreadIds?.has(c.id)}
                  showTag={false}
                  onSelect={() => onSelect(c.id)}
                  onRename={(title) => onRename(c.id, title)}
                  onTogglePin={() => onTogglePin(c.id)}
                  onDelete={() => onDelete(c.id)} />
              ))}
            </div>
          );
        })}
      </div>

      {/* What's New 卡片入口（仿 Claude Cowork 左下角卡片）：点开进入 AWS 新发布学习空间 */}
      <button className="sb-whatsnew" onClick={() => onWhatsNew?.()}>
        <span className="wn-ic"><IconWhatsNew size={20} /></span>
        <span className="wn-tx">
          <span className="wn-title">{t("whatsnew.card")}</span>
          <span className="wn-sub">{t("whatsnew.cardSub")}</span>
        </span>
        <span className="wn-arrow"><IconChevronRight size={18} /></span>
      </button>

      <UserMenu username={username} onSignOut={onSignOut} mfaMode={mfaMode} onTwoFactor={onTwoFactor} />
    </aside>
  );
}
