import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@cloudscape-design/global-styles/index.css";
import "./App.css";
import { loadConfig } from "./config";
import { configureAuth } from "./auth/config";
import App from "./App";

// 先加载运行时配置，再初始化认证和渲染
loadConfig().then(() => {
  configureAuth();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
