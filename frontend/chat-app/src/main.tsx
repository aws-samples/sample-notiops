import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { loadConfig } from "./config";
import { initRum } from "./rum";
import { configureAuth } from "./auth/config";
import App from "./App";
import { refreshModelCatalog } from "./models";

// 先加载运行时配置，再初始化 RUM/认证并渲染（与 frontend-app 同款启动顺序）
loadConfig().then(() => {
  initRum();       // CloudWatch RUM：尽早初始化以捕获后续所有 JS 异常/性能
  configureAuth();
  // 认证配好就立刻开始拉模型目录，不等 ChatApp 挂载 —— 那段等待就是"下拉框显示打包内置
  // 清单"的窗口（实测：先看到 8 个模型，目录落地后变 1 个）。提前发起把窗口压到最小；
  // 期间下拉框显示「正在读取可用模型…」而不是一份可选的错清单。
  // 不 await：它失败不该阻塞渲染，models.ts 自带退避重试。
  void refreshModelCatalog();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
