import { useEffect, useRef, useState } from "react";
import { useT, useLocale, useTheme, type Locale, type ThemePref } from "../i18n";
import {
  IconSettings, IconLanguage, IconChangelog,
  IconInfo, IconSignout, IconChevronRight, IconCheck, IconAppearance, IconReport,
} from "./icons";

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
          <button className="um-item" onClick={() => soon(t("menu.changelog"))}>
            <IconChangelog /> <span>{t("menu.changelog")}</span>
          </button>
          <button className="um-item" onClick={() => soon(t("menu.learnmore"))}>
            <IconInfo /> <span>{t("menu.learnmore")}</span>
            <IconChevronRight />
          </button>
          <button className="um-item" onClick={() => soon(t("menu.report"))}>
            <IconReport /> <span>{t("menu.report")}</span>
          </button>

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
