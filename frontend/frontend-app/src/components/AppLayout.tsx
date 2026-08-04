/**
 * 应用主布局 — Cloudscape AppLayout + 侧边导航。
 */
import { useState } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { signOut } from "aws-amplify/auth";
import AppLayoutBase from "@cloudscape-design/components/app-layout";
import SideNavigation from "@cloudscape-design/components/side-navigation";
import { NAV_ITEMS } from "../features";
import TopNavigation from "@cloudscape-design/components/top-navigation";
import Box from "@cloudscape-design/components/box";

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const [navOpen, setNavOpen] = useState(true);

  const handleFollow = (e: CustomEvent<{ href: string; external?: boolean }>) => {
    e.preventDefault();
    navigate(e.detail.href);
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/login", { replace: true });
  };

  return (
    <>
      <div id="top-nav">
        <TopNavigation
          identity={{ title: "NotiOps", href: "/" }}
          utilities={[
            {
              type: "button",
              text: "登出",
              onClick: handleSignOut,
            },
          ]}
        />
      </div>
      <AppLayoutBase
        navigation={
          <div style={{ overflow: "auto", height: "100%" }}>
            <SideNavigation
              activeHref={location.pathname}
              items={NAV_ITEMS}
              onFollow={handleFollow}
            />
          </div>
        }
        navigationOpen={navOpen}
        onNavigationChange={({ detail }) => setNavOpen(detail.open)}
        toolsHide
        content={
          <Box padding="l">
            <Outlet />
          </Box>
        }
      />
    </>
  );
}
