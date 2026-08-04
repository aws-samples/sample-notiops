/**
 * 应用根组件 — 路由配置。
 * 路由与侧边导航统一定义在 src/features.tsx（feature 注册表），
 * 新增页面请在那里注册，不要直接改本文件。
 */
import { BrowserRouter, Routes, Route } from "react-router-dom";
import AuthGuard from "./auth/AuthGuard";
import AppLayout from "./components/AppLayout";
import Login from "./pages/Login";
import { FEATURE_ROUTES } from "./features";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <AuthGuard>
              <AppLayout />
            </AuthGuard>
          }
        >
          {FEATURE_ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={r.element} />
          ))}
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
