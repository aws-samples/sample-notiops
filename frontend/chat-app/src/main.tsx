import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { loadConfig } from "./config";
import { initRum } from "./rum";
import { configureAuth } from "./auth/config";
import App from "./App";

// 先加载运行时配置，再初始化 RUM/认证并渲染（与 frontend-app 同款启动顺序）
loadConfig().then(() => {
  initRum();       // CloudWatch RUM：尽早初始化以捕获后续所有 JS 异常/性能
  configureAuth();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
