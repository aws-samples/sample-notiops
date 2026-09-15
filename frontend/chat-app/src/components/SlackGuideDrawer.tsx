import { useLocale } from "../i18n";
import { SLACK_GUIDE } from "../content/slackGuide";
import ImGuideDrawer from "./ImGuideDrawer";

/**
 * Slack 配置指南抽屉。壳与飞书 / 钉钉那两个逐字同构（内容在 content/slackGuide.ts，
 * 布局在 ImGuideDrawer），区别只有 blocks 与四个文案 key。
 *
 * ⚠️ 同一时刻只能挂一个 ImGuideDrawer（它里面的 `imd-webhook-url` 是固定 id）——
 * NotificationsView 按分页只渲染当前平台的那一个，别在别处再挂一份。
 */
export default function SlackGuideDrawer({ open, onClose, webhookUrl = "" }:
{ open: boolean; onClose: () => void; webhookUrl?: string }) {
  const { locale } = useLocale();
  return (
    <ImGuideDrawer
      open={open}
      onClose={onClose}
      webhookUrl={webhookUrl}
      blocks={SLACK_GUIDE[locale]}
      titleKey="admin.notif.sl.guideTitle"
      subKey="admin.notif.sl.guideSub"
      urlLabelKey="admin.notif.sl.url.label"
      urlMissingKey="admin.notif.sl.url.missing"
    />
  );
}
