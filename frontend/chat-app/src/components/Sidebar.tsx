import { useState } from "react";
import Logo from "./Logo";
import { useT, useLocale } from "../i18n";
import type { Conversation, TopicKey } from "../types";
import { TOPICS } from "../types";
import {
  IconNewChat, IconInvestigate, IconFinOps, IconCases, IconSecurity,
  IconInspection, IconMore, IconSkill, IconCustomize, IconWhatsNew, IconChevronRight, IconBell,
  IconCollapseAll, IconExpandAll,
} from "./icons";
import ConvItem from "./ConvItem";
import UserMenu from "./UserMenu";

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
  width?: number;
  onSkills?: () => void;        // 打开独立 Skills 页（一级入口）
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
  onSecurity?: () => void;      // 打开「安全」仪表盘独立页
  securityActive?: boolean;     // 安全页当前是否激活（高亮）
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
  showSecurity?: boolean;       // 能力门禁：Security（默认 false，需 nav:security）
  /**
   * 能力门禁：资源巡检看板（默认 **false**，需 `nav:inspection`）。
   *
   * ⚠️ 默认 false 而不是 true —— 与 Security / Admin 同档。巡检看板会显示
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

export default function Sidebar({ conversations, activeId, busyIds, unreadIds, onSelect, onNew, onRename, onTogglePin, onDelete, collapsed, onToggle, username, onSignOut, width = 264, onSkills, skillsActive, onCustomize, customizeActive, onWhatsNew, onNotifications, notificationsActive, notifUnread = 0, onFinops, finopsActive, onCases, casesActive, onAdmin, adminActive, showFinops = true, showCases = true, showAdmin = false, showNotifications = true, showInvestigation = true, showSkills = true, showCustomize = true, onSecurity, securityActive, showSecurity = false, onInvestigate, investigateActive, onInspection, inspectionActive, showInspection = false }: Props) {
  const t = useT();
  const { locale } = useLocale();
  // "更多"子菜单展开态（收纳 安全 / 巡检&报告 等非高频入口）
  const [moreOpen, setMoreOpen] = useState(false);
  // 子菜单里到底还剩没剩东西：都没了就连「更多」按钮一起藏，别让用户点开一个空菜单
  const hasMoreItems = showAdmin || showCustomize;

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
        {showSecurity && <button className={"navitem" + (securityActive ? " active" : "")} onClick={() => onSecurity?.()}><span className="ni-ic"><IconSecurity /></span>{t("topic.security")}</button>}
        {showCases && <button className={"navitem" + (casesActive ? " active" : "")} onClick={onCases}><span className="ni-ic"><IconCases /></span>{t("topic.cases")}</button>}
        {/* 巡检：站内看板（2026-09-04 从「资源巡检」改名并挪到 案例/Skills
            之间 —— 用户指定的位置；老外链入口已随 idle 控制台退役）。 */}
        {showInspection && <button className={"navitem" + (inspectionActive ? " active" : "")} onClick={() => onInspection?.()}><span className="ni-ic"><IconInspection /></span>{t("insp.title")}</button>}
        {/* Skills：独立一级入口。点开进独立 Skills 管理页（非「定制」外壳）。 */}
        {showSkills && (
          <button className={"navitem" + (skillsActive ? " active" : "")} onClick={() => onSkills?.()}>
            <span className="ni-ic"><IconSkill /></span>{t("cz.nav.skills")}
          </button>
        )}
        {/* 「更多」：可展开子菜单，收纳非高频入口（巡检&报告 / 管理 / 定制）。
            子菜单三项全被门禁挡掉时不渲染「更多」本身 —— 否则用户点开是个空盒子。
            （隐藏巡检&报告后，非 admin 且无 nav:customize 的用户就会撞上这种情况。） */}
        {hasMoreItems && (
          <button className={"navitem" + (moreOpen ? " expanded" : "")} onClick={() => setMoreOpen((v) => !v)}>
            <span className="ni-ic"><IconMore /></span>{t("nav.more")}
            <span className={"ni-caret" + (moreOpen ? " open" : "")}><IconChevronRight size={15} /></span>
          </button>
        )}
        {hasMoreItems && moreOpen && (
          <div className="sb-submenu">
            {/* 管理：仅 admin 可见（后端 nav:admin 门禁 + 前端能力过滤）。角色/用户/模块。从一级收进「更多」。 */}
            {showAdmin && (
              <button className={"navitem subitem" + (adminActive ? " active" : "")} onClick={() => onAdmin?.()}>
                <span className="ni-ic"><IconCustomize /></span>{t("nav.admin")}
              </button>
            )}
            {/* 定制（连接器/插件等）：从一级收进「更多」。 */}
            {showCustomize && (
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
            {/* 置顶组混合各主题 → 保留主题 tag（showTag 默认 true）便于区分 */}
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
        {/* 主题分组：组标题已标明主题，组内会话不再重复显示 tag（showTag=false）。
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

      <UserMenu username={username} onSignOut={onSignOut} />
    </aside>
  );
}
