/**
 * API 客户端 — 自动附加 Cognito JWT Token。
 * 从运行时 config 加载 API 地址。
 */
import axios from "axios";
import { fetchAuthSession } from "aws-amplify/auth";
import { getConfig } from "../config";

const client = axios.create({
  timeout: 30_000, // 30 秒超时
});

// 延迟设置 baseURL（等 config 加载完成）
client.interceptors.request.use(async (config) => {
  // 设置 baseURL
  if (!config.baseURL) {
    const appConfig = getConfig();
    config.baseURL = appConfig.apiBase;
  }

  // 附加 JWT Token
  try {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // 未登录时不附加 token
  }
  return config;
});

// 响应拦截器：统一错误分类，附加 userMessage 字段
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.code === "ECONNABORTED") {
      error.userMessage = "请求超时，请重试";
    } else if (!error.response) {
      error.userMessage = "网络连接失败，请检查网络后重试";
    } else {
      error.userMessage =
        error.response?.data?.message ||
        `请求失败 (${error.response.status})`;
    }
    return Promise.reject(error);
  }
);

export default client;
