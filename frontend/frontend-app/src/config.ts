/**
 * 运行时配置加载器。
 * 优先从 /config.json（CDK 部署时自动生成）加载，
 * 回退到 .env 环境变量（本地开发用）。
 */

interface AppConfig {
  apiBase: string;
  cognitoUserPoolId: string;
  cognitoClientId: string;
}

let _config: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (_config) return _config;

  try {
    const resp = await fetch("/config.json");
    if (resp.ok) {
      _config = await resp.json();
      console.log("Loaded runtime config from /config.json");
      return _config!;
    }
  } catch {
    // config.json 不存在（本地开发），回退到 .env
  }

  _config = {
    apiBase: import.meta.env.VITE_API_BASE ?? "/api",
    cognitoUserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? "",
    cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? "",
  };
  console.log("Using .env config (local dev)");
  return _config;
}

export function getConfig(): AppConfig {
  if (!_config) {
    throw new Error("Config not loaded yet. Call loadConfig() first.");
  }
  return _config;
}
