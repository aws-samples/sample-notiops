import { useEffect, useRef, useState } from "react";
import { useT, useLocale, useTheme, type Locale, type ThemePref } from "../i18n";
import {
  IconSettings, IconLanguage, IconChangelog,
  IconInfo, IconSignout, IconChevronRight, IconCheck, IconAppearance, IconReport,
  IconExternal,
} from "./icons";

/**
 * 菜单里三个外链的目标 —— 都指向公开仓库 aws-samples/sample-notiops。
 *
 * 为什么用 <a target="_blank"> 而不是 button + window.open()：
 *  1. window.open 会被浏览器弹窗拦截器拦掉，用户只看到"点了没反应"；<a> 不会。
 *  2. rel="noopener noreferrer" 断掉新页面的 window.opener 引用，否则打开的
 *     页面能反向导航/操作本控制台页面（reverse tabnabbing）。
 *
 * ⚠️ 这三个 URL 一律**不带任何查询参数**：GitHub issue 页是公开的,预填内容会
 * 被客户在不知情的情况下公开。account ID / 用户名 / ARN / region 等环境信息
 * 绝不能拼进 URL —— 由客户自己决定在 issue 正文里写什么。
 */
const GH_REPO = "https://github.com/aws-samples/sample-notiops";
const LINKS = {
  changelog: `${GH_REPO}/releases`,
  learnmore: GH_REPO,
  report: `${GH_REPO}/issues`,
} as const;

/** 左下角用户区 → 向上弹出的设置菜单（参考 Bedrock/Claude）。 */
export default function UserMenu({ username, onSignOut }: { username: string; onSignOut: () => void }) {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const { pref, setPref } = useTheme();
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [apprOpen, setApprOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) { setLangOpen(false); setApprOpen(false); return; }
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  const LANGS: { id: Locale; label: string }[] = [
    { id: "en", label: "English (United States)" },
    { id: "zh", label: "中文（简体）" },
  ];
  const THEMES: { id: ThemePref; key: string }[] = [
    { id: "dark", key: "menu.theme.dark" },
    { id: "light", key: "menu.theme.light" },
  ];

  const soon = (name: string) => { setOpen(false); alert(`${name} · ${t("menu.soon")}`); };

  return (
    <div className="usermenu-wrap" ref={wrapRef}>
      {open && (
        <div className="usermenu">
          <div className="um-head">NotiOps</div>
          <button className="um-item" onClick={() => soon(t("login.settings"))}>
            <IconSettings /> <span>{t("login.settings")}</span>
          </button>

          <div className="um-sub">
            <button className="um-item" onClick={() => { setApprOpen((o) => !o); setLangOpen(false); }}>
              <IconAppearance /> <span>{t("menu.appearance")}</span>
              <IconChevronRight />
            </button>
            {apprOpen && (
              <div className="um-submenu">
                {THEMES.map((th) => (
                  <button key={th.id} className="um-item" onClick={() => { setPref(th.id); setOpen(false); }}>
                    <span className="um-langlabel">{t(th.key)}</span>
                    {pref === th.id && <span className="um-check"><IconCheck /></span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="um-sub">
            <button className="um-item" onClick={() => { setLangOpen((o) => !o); setApprOpen(false); }}>
              <IconLanguage /> <span>{t("menu.language")}</span>
              <IconChevronRight />
            </button>
            {langOpen && (
              <div className="um-submenu">
                {LANGS.map((l) => (
                  <button key={l.id} className="um-item" onClick={() => { setLocale(l.id); setOpen(false); }}>
                    <span className="um-langlabel">{l.label}</span>
                    {locale === l.id && <span className="um-check"><IconCheck /></span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="um-sep" />
          {/* 三个外链：更新日志 / 了解更多 / 反馈问题 —— 都跳公开仓库。
              title 里说明会新开标签页,内网打不开 github.com 的用户至少能看到
              完整 URL,而不是"点了没反应"。 */}
          <a
            className="um-item"
            href={LINKS.changelog}
            target="_blank"
            rel="noopener noreferrer"
            title={`${t("menu.changelog")} — ${LINKS.changelog}`}
            onClick={() => setOpen(false)}
          >
            <IconChangelog /> <span>{t("menu.changelog")}</span>
            <span className="um-extlink"><IconExternal /></span>
          </a>
          <a
            className="um-item"
            href={LINKS.learnmore}
            target="_blank"
            rel="noopener noreferrer"
            title={`${t("menu.learnmore")} — ${LINKS.learnmore}`}
            onClick={() => setOpen(false)}
          >
            <IconInfo /> <span>{t("menu.learnmore")}</span>
            <span className="um-extlink"><IconExternal /></span>
          </a>
          <a
            className="um-item"
            href={LINKS.report}
            target="_blank"
            rel="noopener noreferrer"
            title={t("menu.report.hint")}
            onClick={() => setOpen(false)}
          >
            <IconReport /> <span>{t("menu.report")}</span>
            <span className="um-extlink"><IconExternal /></span>
          </a>

          <div className="um-sep" />
          <button className="um-item" onClick={() => { setOpen(false); onSignOut(); }}>
            <IconSignout /> <span>{t("login.signout")}</span>
          </button>
        </div>
      )}

      <button className="sb-foot" onClick={() => setOpen((o) => !o)}>
        <span className="avatar">{username.slice(0, 1).toUpperCase()}</span>
        <span className="um-name">{username}</span>
        <span className="um-caret">▾</span>
      </button>
    </div>
  );
}
