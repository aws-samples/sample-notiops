/**
 * 「配置飞书机器人」右侧抽屉 —— 只负责挑内容与三条文案 key，渲染与开合在
 * [ImGuideDrawer.tsx](ImGuideDrawer.tsx)（2026-09-08 加钉钉时提取的通用外壳，
 * 原因见那份文件头）。内容在 content/feishuGuide.ts。
 *
 * 对外的 props 与提取前**逐字不变**（open / onClose / webhookUrl），
 * 类名、i18n key 也不变 —— AdminPanel 与 AdminPanel.notif.test.tsx 都不用改。
 */
import { useLocale } from "../i18n";
import { FEISHU_GUIDE } from "../content/feishuGuide";
import ImGuideDrawer from "./ImGuideDrawer";

export default function FeishuGuideDrawer({ open, onClose, webhookUrl = "" }:
{ open: boolean; onClose: () => void; webhookUrl?: string }) {
  const { locale } = useLocale();
  return (
    <ImGuideDrawer
      open={open}
      onClose={onClose}
      webhookUrl={webhookUrl}
      blocks={FEISHU_GUIDE[locale]}
      titleKey="admin.notif.guideTitle"
      subKey="admin.notif.guideSub"
      urlLabelKey="admin.notif.url.label"
      urlMissingKey="admin.notif.url.missing"
    />
  );
}
