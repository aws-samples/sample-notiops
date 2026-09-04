/**
 * 「配置飞书机器人」右侧抽屉。Admin →「集成 IM」页的超链接打开它。
 *
 * 为什么是抽屉而不是新页/新弹窗:客户是**照着步骤填上一页的输入框**，步骤和输入框
 * 必须同屏可见 —— 弹窗会盖住表单，跳页会丢掉已填一半的凭证（本页表单没有草稿保存）。
 * 所以:桌面端右侧停靠、不遮挡左边的表单；窄屏退化为覆盖式并给遮罩（CSS 里做）。
 *
 * 内容在 content/feishuGuide.ts（按 locale 整块给），本文件只管渲染与开合。
 * Esc 关闭 —— 抽屉打开时它是最上层，键盘用户不该被困在里面。
 */
import { useEffect, useState } from "react";
import { useT, useLocale } from "../i18n";
import { FEISHU_GUIDE, type GuideBlock } from "../content/feishuGuide";

const CloseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

/** 描边图标，与全站一致（见 icons.tsx 的约定：不用彩色 emoji）。 */
const CopyIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" />
  </svg>
);

/**
 * 本部署真实的 webhook 地址 + 复制按钮。
 *
 * 为什么值得单独做一块:配飞书这条路上，除了这串 URL，其余每一步都在飞书网页和本页之间
 * 完成 —— 只有它原来要客户切到 CloudFormation 控制台去翻 Outputs。地址还长、带随机段、
 * 结尾那个 `/` 少一个就 404，**手抄是这一步最常见的出错来源**，所以给按钮而不是让人选中。
 *
 * `readOnly` 而不是纯文本:输入框能双击全选、能被密码管理器以外的工具正常处理，也天然
 * 支持 navigator.clipboard 之外的手动复制退路（Safari 老版本、非 HTTPS 预览环境）。
 * 复制失败不吞掉 —— 退回选中整串，客户至少能自己 Cmd+C。
 */
function WebhookUrlBox({ url }: { url: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  if (!url) return <div className="imd-warn">{t("admin.notif.url.missing")}</div>;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard 不可用（非 HTTPS / 权限被拒）→ 选中整串，让客户手动复制。
      const el = document.getElementById("imd-webhook-url") as HTMLInputElement | null;
      el?.select();
    }
  };

  return (
    <div className="imd-urlbox">
      <input id="imd-webhook-url" className="imd-url" readOnly value={url}
        onFocus={(e) => e.currentTarget.select()} aria-label={t("admin.notif.url.label")} />
      <button className="imd-url-copy" onClick={copy} title={t("admin.notif.url.copy")}>
        <CopyIcon /> {copied ? t("admin.notif.url.copied") : t("admin.notif.url.copy")}
      </button>
    </div>
  );
}

function Block({ b, webhookUrl }: { b: GuideBlock; webhookUrl: string }) {
  switch (b.k) {
    case "h":
      return <div className="imd-h">{b.tx}</div>;
    case "p":
      return <p className="imd-p">{b.tx}</p>;
    case "ol":
      return <ol className="imd-list">{b.items.map((x, i) => <li key={i}>{x}</li>)}</ol>;
    case "ul":
      return <ul className="imd-list">{b.items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
    case "code":
      return <pre className="imd-code">{b.tx}</pre>;
    case "warn":
      return <div className="imd-warn">{b.tx}</div>;
    case "kv":
      return (
        <div className="imd-kv">
          {b.rows.map(([k, v], i) => (
            <div className="imd-kv-row" key={i}>
              <div className="imd-kv-k">{k}</div>
              <div className="imd-kv-v">{v}</div>
            </div>
          ))}
        </div>
      );
    case "webhookUrl":
      return <WebhookUrlBox url={webhookUrl} />;
  }
}

/** `webhookUrl` 由 AdminPanel 从 GET /admin/notification-config 拿到后传进来；
 *  没装 IM / 查不到时是空串 —— 抽屉照常打开，那一块退回文字说明（见 WebhookUrlBox）。 */
export default function FeishuGuideDrawer({ open, onClose, webhookUrl = "" }:
{ open: boolean; onClose: () => void; webhookUrl?: string }) {
  const t = useT();
  const { locale } = useLocale();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <>
      <div className={"imd-overlay" + (open ? " open" : "")} onClick={onClose} />
      <aside className={"imd-panel" + (open ? " open" : "")} aria-hidden={!open}>
        <div className="imd-head">
          <div>
            <div className="imd-title">{t("admin.notif.guideTitle")}</div>
            <div className="imd-sub">{t("admin.notif.guideSub")}</div>
          </div>
          <button className="imd-close" onClick={onClose} title={t("panel.close")} aria-label={t("panel.close")}><CloseIcon /></button>
        </div>
        <div className="imd-body">
          {FEISHU_GUIDE[locale].map((b, i) => <Block b={b} webhookUrl={webhookUrl} key={i} />)}
        </div>
      </aside>
    </>
  );
}
