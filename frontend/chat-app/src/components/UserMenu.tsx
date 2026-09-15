import { useEffect, useRef, useState } from "react";
import { useT, useLocale, useTheme, type Locale, type ThemePref } from "../i18n";
import {
  IconLanguage, IconSignout, IconChevronRight, IconCheck, IconAppearance, IconGitHub,
} from "./icons";

/**
 * 唯一一个外链的目标 —— 公开仓库 aws-samples/sample-notiops 主页。
 *
 * 2026-09-12（产品要求）：弹出菜单只保留 外观 / 语言 / 退出登录 三项,菜单里那三条
 * 外链（更新日志 / 了解更多 / 反馈问题）与底部那个「提 issue」图标一起下线。连带
 * 删掉只有它们在用的四个 i18n 键（`menu.changelog` / `menu.learnmore` /
 * `menu.report` / `menu.report.hint`）—— 留着会被 lint_i18n 的孤儿键检查抓到。
 * 底部「加星」那个图标**保留**。
 *
 * 为什么用 <a target="_blank"> 而不是 button + window.open()：
 *  1. window.open 会被浏览器弹窗拦截器拦掉，用户只看到"点了没反应"；<a> 不会。
 *  2. rel="noopener noreferrer" 断掉新页面的 window.opener 引用，否则打开的
 *     页面能反向导航/操作本控制台页面（reverse tabnabbing）。
 *
 * ⚠️ 这个 URL **不带任何查询参数**：目标页是公开的,account ID / 用户名 / ARN /
 * region 等环境信息绝不能拼进 URL。
 */
const GH_REPO = "https://github.com/aws-samples/sample-notiops";
const LINKS = {
  // 「给我们加星」= 仓库主页（GitHub 没有「直接加星」的免登录深链；星标按钮就在主页右上角）。
  star: GH_REPO,
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

  return (
    <div className="usermenu-wrap" ref={wrapRef}>
      {open && (
        <div className="usermenu">
          <div className="um-head">NotiOps</div>
          {/* 2026-09-11：删掉了菜单第一项「设置」。它从来没有实现，点了只弹一句
              「即将上线」——菜单里唯一一个纯占位项，让人以为这里能配什么东西。
              真正的配置入口在侧栏「管理」（角色/权限/模型/IM 凭据）与「巡检 →
              设置」，跟这里不是一回事。连带删掉只有它在用的 `soon()` 与两个
              i18n 键 `login.settings` / `menu.soon`（留着会被 lint_i18n 的
              孤儿键检查抓到）。要加真的全局设置，别复活这个占位 —— 直接接线。 */}

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
          <button className="um-item" onClick={() => { setOpen(false); onSignOut(); }}>
            <IconSignout /> <span>{t("login.signout")}</span>
          </button>
        </div>
      )}

      {/* 侧栏最底下那一行：左边是用户名（点开上面那个菜单），右边一个**纯图标**外链 —— 加星。
          （2026-09-12 起只剩这一个：旁边那个「提 issue」按产品要求下线。）
          ⚠️ 只有图标、没有可见文字：侧栏宽度可拖，窄的时候用户名已经在省略号了，
             再塞一段文字会先把用户名挤没。可读性靠 `title`（hover 出完整 URL）
             与 `aria-label`（屏幕阅读器 / 测试定位）兜住。
          ⚠️ 用 `<a target="_blank">` 而不是 button + window.open()：后者会被弹窗
             拦截器拦掉，用户只看到「点了没反应」。rel="noopener noreferrer" 的理由见文件头。 */}
      <div className="sb-footrow">
        <button className="sb-foot" onClick={() => setOpen((o) => !o)}>
          <span className="avatar">{username.slice(0, 1).toUpperCase()}</span>
          <span className="um-name">{username}</span>
          <span className="um-caret">▾</span>
        </button>
        <a
          className="sb-footlink"
          href={LINKS.star}
          target="_blank"
          rel="noopener noreferrer"
          title={t("menu.star.hint")}
          aria-label={t("menu.star")}
        >
          {/* 18 而不是 16：跟上面那列主题图标（`.navitem .ni-ic`）同尺寸，否则底部这个
              看起来比主题图标"轻一档"。GitHub mark 是实心填充，同尺寸下比描边图标略重一点，
              这是官方图形本来的样子，别为了"看起来一样"去改它的形状。 */}
          <IconGitHub size={18} />
        </a>
      </div>
    </div>
  );
}
