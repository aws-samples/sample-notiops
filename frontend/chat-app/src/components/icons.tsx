/**
 * 线性单色描边图标（ChatGPT 风格）—— 替代彩色 emoji。
 * 统一 currentColor + 细描边、无填充。尺寸默认 18，跟随父级 color。
 */
import type { ComponentType } from "react";
type P = { size?: number };
const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconNewChat = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);

// 故障调查 — 放大镜
export const IconInvestigate = ({ size = 18 }: P) => (
  <svg {...base(size)}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
);

// 发布到 DevOps Agent — 云上传（比放大镜直观：把 Skill 推到 DevOps Agent 的云端 Agent Space）
export const IconPublish = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M7 18a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6-1.36A3.75 3.75 0 0 1 17 16" /><path d="M12 21v-8M9 15l3-3 3 3" /></svg>
);

// FinOps — 金额/趋势（带美元的圆）
export const IconFinOps = ({ size = 18 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="M14.5 9.2c-.6-.8-1.6-1.2-2.6-1.2-1.4 0-2.4.8-2.4 1.9 0 2.6 5 1.3 5 4 0 1.2-1.1 2-2.6 2-1.1 0-2.1-.4-2.7-1.3" /><path d="M12 6.2v1.6M12 16.2v1.6" /></svg>
);

// Cases — 工单/卡片
export const IconCases = ({ size = 18 }: P) => (
  <svg {...base(size)}><rect x="3.5" y="5" width="17" height="14" rx="2.2" /><path d="M3.5 9.5h17" /><path d="M8 5V3.6M16 5V3.6" /></svg>
);

// 安全 — 盾牌
export const IconSecurity = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M12 3 5 6v5c0 4.2 2.9 7.5 7 9 4.1-1.5 7-4.8 7-9V6Z" /><path d="m9.5 12 1.8 1.8 3.2-3.6" /></svg>
);

// 巡检&报告 — 折线图/报告
export const IconReports = ({ size = 18 }: P) => (
  <svg {...base(size)}><rect x="3.5" y="3.5" width="17" height="17" rx="2.2" /><path d="M7.5 14.5 10.5 11l2.5 2.5L16.5 9" /></svg>
);

export const IconMore = ({ size = 18 }: P) => (
  <svg {...base(size)}><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></svg>
);

// 会话历史项 — 气泡
export const IconChatBubble = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 16 0Z" /></svg>
);

// 外链小箭头
export const IconExternal = ({ size = 13 }: P) => (
  <svg {...base(size)}><path d="M14 4h6v6" /><path d="M20 4 10 14" /><path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" /></svg>
);

// 用户菜单：设置 / 语言 / 推理配置 / 更新日志 / 了解更多 / 退出 / 子菜单箭头
export const IconSettings = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" /></svg>
);
export const IconLanguage = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18" /></svg>
);
// 外观：半明半暗的圆（appearance/主题）
export const IconAppearance = ({ size = 16 }: P) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" /></svg>
);
export const IconSliders = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>
);
export const IconChangelog = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M9 4H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-4-4Z" /><path d="M14 4v4h4" /><path d="M8 13h8M8 17h5" /></svg>
);
export const IconInfo = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /></svg>
);
export const IconSignout = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>
);
export const IconReport = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" /></svg>
);
export const IconChevronRight = ({ size = 14 }: P) => (
  <svg {...base(size)}><path d="m9 6 6 6-6 6" /></svg>
);
export const IconCheck = ({ size = 15 }: P) => (
  <svg {...base(size)}><path d="m5 12 5 5L20 7" /></svg>
);

// 会话项操作：⋯ / 置顶 / 重命名 / 删除
export const IconKebab = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="5" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="12" cy="19" r="1.3" /></svg>
);
export const IconPin = ({ size = 15 }: P) => (
  <svg {...base(size)}><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z" /><path d="M12 15v5" /></svg>
);
export const IconRename = ({ size = 15 }: P) => (
  <svg {...base(size)}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
export const IconTrash = ({ size = 15 }: P) => (
  <svg {...base(size)}><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /></svg>
);
export const IconGlobe = ({ size = 16 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" /></svg>
);
export const IconCustomize = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>
);
export const IconSkill = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M5 4h11a2 2 0 0 1 2 2v13a1 1 0 0 1-1 1H7a2 2 0 0 1-2-2V4Z" /><path d="M5 4a2 2 0 0 0-2 2v0a2 2 0 0 0 2 2" /><path d="M9 9h6M9 13h6" /></svg>
);
export const IconConnector = ({ size = 16 }: P) => (
  <svg {...base(size)}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><path d="M17.5 14v-1M14 17.5h7" /></svg>
);
export const IconPlugin = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M10 3v4M14 3v4" /><path d="M7 7h10v5a5 5 0 0 1-5 5v0a5 5 0 0 1-5-5V7Z" /><path d="M12 17v4" /></svg>
);
export const IconPlus = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconFileText = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5M9 13h6M9 17h6M9 9h1" /></svg>
);
export const IconUpload = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" /><path d="M12 4v12M7 9l5-5 5 5" /></svg>
);
export const IconClose = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IconWhatsNew = ({ size = 16 }: P) => (
  <svg {...base(size)}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" /><path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z" /></svg>
);
export const IconBell = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
);

// ─────────────────────────────────────────────────────────────────────────
// 预置 Skill 的主题图标（线性单色，跟随 currentColor）。按 skill_id 映射，见 skillIcon()。
// 客户自建 skill 无匹配时回退 IconSkill。
// ─────────────────────────────────────────────────────────────────────────

// AWS Health 事件核查 — 屏幕里的心电/脉搏线
export const IconHeartPulse = ({ size = 18 }: P) => (
  <svg {...base(size)}><rect x="3" y="5" width="18" height="14" rx="2.2" /><path d="M6 12.5h3l1.4-3 2.2 6 1.4-3H18" /></svg>
);

// 成本突增排查 — 折线图里的尖峰
export const IconCostSpike = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M4 4v16h16" /><path d="M7 14l2.5 1 2-7 3 9 2.5-4" /></svg>
);

// EKS 运维审查 — 容器/集群(六边形+内部连接)
export const IconCluster = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M12 3l7.5 4.3v8.4L12 21l-7.5-4.3V7.3L12 3Z" /><circle cx="12" cy="12" r="1.4" /><path d="M12 10.6V8M13.2 12.7l2.2 1.3M10.8 12.7l-2.2 1.3" /></svg>
);

// 闲置资源扫描 — 月牙(闲置/休眠)
export const IconIdle = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" /></svg>
);

// RDS 健康审查 — 数据库圆柱
export const IconDatabase = ({ size = 18 }: P) => (
  <svg {...base(size)}><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" /><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></svg>
);

// 服务配额检查 — 仪表盘/量表
export const IconGauge = ({ size = 18 }: P) => (
  <svg {...base(size)}><path d="M4 16a8 8 0 0 1 16 0" /><path d="M12 16l4.5-3.5" /><circle cx="12" cy="16" r="1.1" /><path d="M4.6 12.5h.01M8 7.6h.01M12 6h.01M16 7.6h.01M19.4 12.5h.01" /></svg>
);

// SP/RI 覆盖率分析 — 圆里的百分号(承诺折扣/覆盖率)
export const IconPercent = ({ size = 18 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9" /><path d="M8.5 8.5h.01M15.5 15.5h.01M15.5 8.5l-7 7" /></svg>
);

// Support case 历史 RCA — 救生圈(支持)
export const IconLifebuoy = ({ size = 18 }: P) => (
  <svg {...base(size)}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3.4" /><path d="M5.6 5.6l3.8 3.8M14.6 14.6l3.8 3.8M18.4 5.6l-3.8 3.8M9.4 14.6l-3.8 3.8" /></svg>
);

// 按预置 skill_id 选主题图标；客户自建 / 未知 id 回退到通用 IconSkill。
// key 用稳定的 skill_id（即 SKILL.md 的 name），与后端预置一致。
const SKILL_ICONS: Record<string, ComponentType<P>> = {
  "aws-health-events": IconHeartPulse,
  "cost-spike-triage": IconCostSpike,
  "eks-operation-review": IconCluster,
  "idle-resource-scan": IconIdle,
  "rds-health-review": IconDatabase,
  "security-posture-review": IconSecurity,
  "service-quota-check": IconGauge,
  "sp-ri-coverage-analysis": IconPercent,
  "support-case-history-rca": IconLifebuoy,
  "whats-new-report": IconWhatsNew,
};
export function skillIcon(skillId: string): ComponentType<P> {
  return SKILL_ICONS[skillId] || IconSkill;
}
