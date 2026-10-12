/**
 * 运行时配置加载器。
 * 从 /config.json（CDK 部署时自动生成）加载；只有本地开发（`vite dev`）
 * 才回退到 .env 环境变量，生产构建里加载失败就抛错（见 loadConfig）。
 *
 * 与 frontend/frontend-app/src/config.ts 同款模式。chatApiBase 指向
 * Web Chat BFF（Lambda Function URL streaming）；cognito* 与控制台
 * 共享同一个 user pool。
 */

interface AppConfig {
  chatApiBase: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
  cognitoIdentityPoolId: string;
  region: string;
  rumAppMonitorId?: string;
  rumIdentityPoolId?: string;
  rumGuestRoleArn?: string;
  rumRegion?: string;
}

let _config: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (_config) return _config;

  let why = "";
  try {
    const resp = await fetch("/config.json");
    if (resp.ok) {
      _config = await resp.json();
      console.log("Loaded runtime config from /config.json");
      return _config!;
    }
    why = `HTTP ${resp.status}`;
  } catch (e) {
    // config.json 不存在（本地开发）时走这里
    why = (e as Error)?.name || "fetch failed";
  }

  // 只有本地开发（`vite dev`）才回退到 .env。生产构建里这几个 `import.meta.env.VITE_*` 来自
  // **打包那台机器**上被 git 忽略的 .env.local —— 曾经把一套早已删掉的旧环境的 BFF 地址和用户池 ID
  // 烘进过发布包与现网 bundle（2026-10-11 查出）。拉不到 /config.json 时静默连过去，用户只会看到一次
  // 说不清原因的登录失败，所以生产里直接报「配置没加载出来」。`import.meta.env.DEV` 在生产构建里是
  // 字面量 false，整段连同那几个值都会被打包器删掉。
  if (import.meta.env.DEV) {
    _config = {
      chatApiBase: import.meta.env.VITE_CHAT_API_BASE ?? "/api/chat",
      cognitoUserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "",
      cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "",
      cognitoIdentityPoolId: import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID ?? "",
      region: import.meta.env.VITE_AWS_REGION ?? "us-east-1",
    };
    console.log("Using .env config (local dev)");
    return _config;
  }
  throw new Error(`NotiOps: could not load /config.json (${why})`);
}

export function getConfig(): AppConfig {
  if (!_config) {
    throw new Error("Config not loaded yet. Call loadConfig() first.");
  }
  return _config;
}
