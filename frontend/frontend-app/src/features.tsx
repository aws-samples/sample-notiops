/**
 * Feature 注册表 — 路由 + 侧边导航的唯一来源。
 *
 * 新增一个 Tab 只需两步：
 *   1. 新建 src/pages/YourPage.tsx
 *   2. 在本文件注册（FEATURE_ROUTES 加一行 + NAV_ITEMS 加一项）
 * App.tsx 与 AppLayout.tsx 均从这里消费，无需再改。
 *
 * 页面全部 React.lazy 按需加载（code-splitting），首屏包体不随 Tab 数量增长。
 */
import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import Spinner from "@cloudscape-design/components/spinner";
import Box from "@cloudscape-design/components/box";
import type { SideNavigationProps } from "@cloudscape-design/components/side-navigation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lz = (fn: () => Promise<{ default: ComponentType<any> }>) => lazy(fn);

const Dashboard = lz(() => import("./pages/Dashboard"));
const WasteOverview = lz(() => import("./pages/WasteOverview"));
const WasteRDS = lz(() => import("./pages/WasteRDS"));
const WasteElastiCache = lz(() => import("./pages/WasteElastiCache"));
const WasteDetail = lz(() => import("./pages/WasteDetail"));
const Ec2Underutilized = lz(() => import("./pages/Ec2Underutilized"));
const Ec2UnderutilizedDetail = lz(() => import("./pages/Ec2UnderutilizedDetail"));
const RdsHealthCheck = lz(() => import("./pages/RdsHealthCheck"));
const RdsHealthCheckDetail = lz(() => import("./pages/RdsHealthCheckDetail"));
const ElastiCacheHealthCheck = lz(() => import("./pages/ElastiCacheHealthCheck"));
const ElastiCacheHealthCheckDetail = lz(() => import("./pages/ElastiCacheHealthCheckDetail"));
const OptimizationPlaceholder = lz(() => import("./pages/OptimizationPlaceholder"));
const OptimizationReport = lz(() => import("./pages/OptimizationReport"));
const OptimizationRDS = lz(() => import("./pages/OptimizationRDS"));
const OptimizationElastiCache = lz(() => import("./pages/OptimizationElastiCache"));
const Whitelist = lz(() => import("./pages/Whitelist"));
const ThresholdSettings = lz(() => import("./pages/ThresholdSettings"));
const AccountSettings = lz(() => import("./pages/AccountSettings"));
const OrgOnboarding = lz(() => import("./pages/OrgOnboarding"));
const NotificationSettings = lz(() => import("./pages/NotificationSettings"));
const DevopsAgentAccounts = lz(() => import("./pages/DevopsAgentAccounts"));
const AiSettings = lz(() => import("./pages/AiSettings"));
const DevopsAgentInvestigations = lz(() => import("./pages/DevopsAgentInvestigations"));
const HelpCenter = lz(() => import("./pages/HelpCenter"));

const fallback = (
  <Box textAlign="center" padding="xxl">
    <Spinner size="large" />
  </Box>
);

const wrap = (node: ReactNode): ReactNode => (
  <Suspense fallback={fallback}>{node}</Suspense>
);

export interface FeatureRoute {
  path: string;
  element: ReactNode;
}

export const FEATURE_ROUTES: FeatureRoute[] = [
  { path: "/", element: wrap(<Dashboard />) },
  { path: "/waste-report", element: wrap(<WasteOverview />) },
  { path: "/waste-report/rds", element: wrap(<WasteRDS />) },
  { path: "/waste-report/elasticache", element: wrap(<WasteElastiCache />) },
  { path: "/waste-report/ec2", element: wrap(<Ec2Underutilized />) },
  { path: "/ec2-underutilized", element: wrap(<Ec2Underutilized />) },
  { path: "/ec2-underutilized/:accountId/:instanceId", element: wrap(<Ec2UnderutilizedDetail />) },
  { path: "/rds-health-check", element: wrap(<RdsHealthCheck />) },
  { path: "/rds-health-check/settings", element: <Navigate to="/settings/ai-config" replace /> },
  { path: "/rds-health-check/:id", element: wrap(<RdsHealthCheckDetail />) },
  { path: "/elasticache-health-check", element: wrap(<ElastiCacheHealthCheck />) },
  { path: "/elasticache-health-check/:id", element: wrap(<ElastiCacheHealthCheckDetail />) },
  { path: "/waste-report/elb", element: wrap(<OptimizationPlaceholder serviceName="ELB" />) },
  { path: "/waste-report/ebs", element: wrap(<OptimizationPlaceholder serviceName="EBS" />) },
  { path: "/waste-report/detail/:accountId/:instanceId", element: wrap(<WasteDetail />) },
  { path: "/waste-report/:accountId/:instanceId", element: wrap(<WasteDetail />) },
  { path: "/whitelist", element: wrap(<Whitelist />) },
  { path: "/settings/thresholds", element: wrap(<ThresholdSettings />) },
  { path: "/settings/accounts", element: wrap(<AccountSettings />) },
  { path: "/settings/org-onboarding", element: wrap(<OrgOnboarding />) },
  { path: "/settings/notifications", element: wrap(<NotificationSettings />) },
  { path: "/settings/devops-agent-accounts", element: wrap(<DevopsAgentAccounts />) },
  { path: "/settings/devops-agent-config", element: <Navigate to="/settings/ai-config" replace /> },
  { path: "/settings/ai-config", element: wrap(<AiSettings />) },
  { path: "/devops-agent-investigations", element: wrap(<DevopsAgentInvestigations />) },
  { path: "/optimization-report", element: wrap(<OptimizationReport />) },
  { path: "/optimization-report/rds", element: wrap(<OptimizationRDS />) },
  { path: "/optimization-report/elasticache", element: wrap(<OptimizationElastiCache />) },
  { path: "/optimization-report/ec2", element: wrap(<OptimizationPlaceholder serviceName="EC2" />) },
  { path: "/optimization-report/elb", element: wrap(<OptimizationPlaceholder serviceName="ELB" />) },
  { path: "/optimization-report/ebs", element: wrap(<OptimizationPlaceholder serviceName="EBS" />) },
  { path: "/help", element: wrap(<HelpCenter />) },
];

export const NAV_ITEMS: SideNavigationProps.Item[] = [
  { type: "link", text: "数据大盘", href: "/" },
  {
    type: "section",
    text: "闲置资源报告",
    defaultExpanded: false,
    items: [
      { type: "link", text: "总览", href: "/waste-report" },
      { type: "link", text: "RDS", href: "/waste-report/rds" },
      { type: "link", text: "ElastiCache", href: "/waste-report/elasticache" },
      { type: "link", text: "EC2", href: "/waste-report/ec2" },
      { type: "link", text: "ELB", href: "/waste-report/elb" },
      { type: "link", text: "EBS", href: "/waste-report/ebs" },
    ],
  },
  {
    type: "section",
    text: "潜在优化资源报告",
    defaultExpanded: false,
    items: [
      { type: "link", text: "总览", href: "/optimization-report" },
      { type: "link", text: "RDS", href: "/optimization-report/rds" },
      { type: "link", text: "ElastiCache", href: "/optimization-report/elasticache" },
      { type: "link", text: "EC2", href: "/optimization-report/ec2" },
      { type: "link", text: "ELB", href: "/optimization-report/elb" },
      { type: "link", text: "EBS", href: "/optimization-report/ebs" },
    ],
  },
  {
    type: "section",
    text: "AI 智能巡检",
    defaultExpanded: true,
    items: [
      { type: "link", text: "RDS 巡检报告", href: "/rds-health-check" },
      { type: "link", text: "ElastiCache 巡检报告", href: "/elasticache-health-check" },
    ],
  },
  { type: "link", text: "白名单管理", href: "/whitelist" },
  { type: "divider" },
  {
    type: "section",
    text: "设置",
    items: [
      { type: "link", text: "AI 配置", href: "/settings/ai-config" },
      { type: "link", text: "阈值配置", href: "/settings/thresholds" },
      { type: "link", text: "目标账户", href: "/settings/accounts" },
      { type: "link", text: "账户接入 (Organizations)", href: "/settings/org-onboarding" },
      { type: "link", text: "通知设置", href: "/settings/notifications" },
      { type: "link", text: "DevOps Agent 账户", href: "/settings/devops-agent-accounts" },
    ],
  },
  { type: "divider" },
  { type: "link", text: "DevOps Agent 调查历史", href: "/devops-agent-investigations" },
  { type: "divider" },
  { type: "link", text: "帮助中心", href: "/help" },
];
