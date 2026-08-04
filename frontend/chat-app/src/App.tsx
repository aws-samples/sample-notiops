import { useEffect, useState } from "react";
import { getCurrentUser } from "aws-amplify/auth";
import { LocaleContext, ThemeContext, detectLocale, saveLocale, detectThemePref, saveThemePref, resolveTheme, type Locale, type ThemePref } from "./i18n";
import Login from "./pages/Login";
import ChatApp from "./pages/ChatApp";

export default function App() {
  const [locale, setLocaleState] = useState<Locale>(detectLocale());
  const [pref, setPrefState] = useState<ThemePref>(detectThemePref());
  const theme = resolveTheme(pref); // dark / light
  const [authed, setAuthed] = useState<boolean | null>(null); // null = 检查中

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    saveLocale(l);
    document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
  };

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    saveThemePref(p);
    document.documentElement.setAttribute("data-theme", resolveTheme(p));
  };

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
  }, [locale]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  useEffect(() => {
    // 本地开发跳过登录开关（仅 dev；.env.local 设 VITE_DEV_SKIP_AUTH=true）。
    // 用于在未部署 Cognito/BFF 时预览登录后的完整 chat UI。
    if (import.meta.env.DEV && import.meta.env.VITE_DEV_SKIP_AUTH === "true") {
      setAuthed(true);
      return;
    }
    getCurrentUser()
      .then(() => setAuthed(true))
      .catch(() => setAuthed(false));
  }, []);

  return (
    <ThemeContext.Provider value={{ pref, theme, setPref }}>
      <LocaleContext.Provider value={{ locale, setLocale }}>
        {authed === null ? null : authed ? (
          <ChatApp onSignOut={() => setAuthed(false)} />
        ) : (
          <Login onSignedIn={() => setAuthed(true)} />
        )}
      </LocaleContext.Provider>
    </ThemeContext.Provider>
  );
}
