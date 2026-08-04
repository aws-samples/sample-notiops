/**
 * 认证守卫 — 未登录重定向到登录页。
 */
import { useEffect, useState, type ReactNode } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { useNavigate } from "react-router-dom";

export default function AuthGuard({ children }: { children: ReactNode }) {
  const [checked, setChecked] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    getCurrentUser()
      .then(() => setChecked(true))
      .catch(() => navigate("/login", { replace: true }));
  }, [navigate]);

  if (!checked) return null;
  return <>{children}</>;
}
