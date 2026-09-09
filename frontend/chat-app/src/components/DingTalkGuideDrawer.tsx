/**
 * 「配置钉钉机器人」右侧抽屉 —— 与 FeishuGuideDrawer 同构的壳，渲染与开合在
 * [ImGuideDrawer.tsx](ImGuideDrawer.tsx)，内容在 content/dingtalkGuide.ts。
 *
 * 三条 key 与飞书那份不同,不是可以将就复用的:
 *   · guideTitle / guideSub —— 平台名要对;
 *   · url.label / url.missing —— 取不到地址时要指向 **DingtalkWebhookUrl** 这个 Output
 *     名字。指错名字的代价是客户在 Outputs 里翻不到、以为部署漏了东西。
 */
import { useLocale } from "../i18n";
import { DINGTALK_GUIDE } from "../content/dingtalkGuide";
import ImGuideDrawer from "./ImGuideDrawer";

export default function DingTalkGuideDrawer({ open, onClose, webhookUrl = "" }:
{ open: boolean; onClose: () => void; webhookUrl?: string }) {
  const { locale } = useLocale();
  return (
    <ImGuideDrawer
      open={open}
      onClose={onClose}
      webhookUrl={webhookUrl}
      blocks={DINGTALK_GUIDE[locale]}
      titleKey="admin.notif.dt.guideTitle"
      subKey="admin.notif.dt.guideSub"
      urlLabelKey="admin.notif.dt.url.label"
      urlMissingKey="admin.notif.dt.url.missing"
    />
  );
}
