/**
 * 「配置阿里云只读凭据」右侧抽屉 —— 与三个 IM 抽屉同构的壳，渲染与开合在
 * [ImGuideDrawer.tsx](ImGuideDrawer.tsx)，内容在 content/aliyunGuide.ts。
 *
 * ⚠️ 刻意**不传** `webhookUrl` / `urlLabelKey` / `urlMissingKey`。
 *    那三个 prop 服务的是「把**我们的**回调地址交给对方后台」这件事，是 IM 三个平台
 *    特有的。配阿里云是反方向:全程只有「从阿里云控制台复制到本页」，我们这边没有任何
 *    要交出去的地址。ALIYUN_GUIDE 里也就没有 `webhookUrl` 块 —— 两件事必须一致，
 *    这条不变量由 AdminPanel.aliyun.test.tsx 断言（块不在内容里 = 不渲染，靠人看不出来）。
 *
 * 名字里没有 `Im` 前缀但复用了 ImGuideDrawer:那个壳干的是「右侧抽屉 + Esc 关闭 +
 * GuideBlock 渲染」，与 IM 无关，只是先为 IM 写的。不为了名字整齐再复制一份 130 行。
 */
import { useLocale } from "../i18n";
import { ALIYUN_GUIDE } from "../content/aliyunGuide";
import ImGuideDrawer from "./ImGuideDrawer";

export default function AliyunGuideDrawer({ open, onClose }:
{ open: boolean; onClose: () => void }) {
  const { locale } = useLocale();
  return (
    <ImGuideDrawer
      open={open}
      onClose={onClose}
      blocks={ALIYUN_GUIDE[locale]}
      titleKey="admin.aliyun.guideTitle"
      subKey="admin.aliyun.guideSub"
    />
  );
}
