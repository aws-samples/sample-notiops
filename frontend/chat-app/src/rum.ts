/**
 * CloudWatch RUM（前端 APM/RUM）初始化。
 * 自动采集 JS 未捕获异常、性能、HTTP 失败、会话/页面浏览，写入 CloudWatch RUM
 * （+ cwLogEnabled 写 CloudWatch Logs，便于与 BFF 日志关联定位根因）。
 * 配置由 config.json 注入（见 infra/lib/constructs/web-chat-core.ts 的 RUM 段
 * —— 2026-09 那次重构把资源定义从 web-chat-stack.ts 搬到了这里）。未配置则静默跳过。
 */
import { AwsRum, type AwsRumConfig } from "aws-rum-web";
import { getConfig } from "./config";

let _rum: AwsRum | null = null;

export function initRum(): void {
  if (_rum) return;
  let cfg;
  try { cfg = getConfig(); } catch { return; }
  const appId = cfg.rumAppMonitorId;
  const idPool = cfg.rumIdentityPoolId;
  const guestRole = cfg.rumGuestRoleArn;
  const region = cfg.rumRegion || cfg.region;
  if (!appId || !idPool || !guestRole || !region) return; // 未配置 RUM → 跳过

  try {
    const rumConfig: AwsRumConfig = {
      sessionSampleRate: 1,
      identityPoolId: idPool,
      guestRoleArn: guestRole,
      endpoint: `https://dataplane.rum.${region}.amazonaws.com`,
      telemetries: ["errors", "performance", "http"],
      allowCookies: true,
      enableXRay: false,
    };
    _rum = new AwsRum(appId, "1.0.0", region, rumConfig);
  } catch (e) {
    // RUM 初始化失败绝不影响应用本身
    console.warn("[NotiOps] RUM init skipped:", e);
  }
}

/** 手动上报一个错误（如 ErrorBoundary 捕获的组件异常）。 */
export function recordRumError(error: unknown): void {
  try { _rum?.recordError(error as Error); } catch { /* ignore */ }
}
