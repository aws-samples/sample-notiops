/**
 * 巡检看板的**设计令牌**：颜色、尺寸、共用的内联样式对象。
 *
 * ## 为什么与组件分开一个文件
 *
 * `react-refresh/only-export-components` —— 一个文件里既导出组件又导出常量
 * 会让 Vite 的热更新退化成整页刷新（改一个颜色，正在填的表单被清空）。
 * 拆开之后组件文件只导出组件。
 *
 * ## 取色只从 CSS 变量来
 *
 * 深浅两套主题靠 `styles.css` 里的 `--card` / `--line` / `--text` 切换。
 * 在这里写死 `#171b21` 的表现是**浅色主题下整块变黑**，而 tsc 与 lint
 * 都不会报。唯一的例外是四档严重度色与几个语义色 —— 它们在两套主题里
 * 是同一个值（AWS 的 red-600 / orange-500 …），且必须与
 * `SecurityDashboard` 的 `SEVC` 保持一致。
 */

/** 四档严重度色。与 SecurityDashboard 的 SEVC 同一套值，保持团队一致。 */
export const SEV_COLOR = {
  CRITICAL: "#d13212", HIGH: "#e8590c", MEDIUM: "#f59e0b", INFO: "#5f6b7a",
} as const;

export const C = {
  red: "#d13212",
  amber: "#b7791f",
  green: "var(--green)",
  blue: "var(--blue)",
  muted: "var(--muted)",
  text: "var(--text)",
  line: "var(--line)",
  card: "var(--card)",
} as const;

/**
 * 内容区最大宽度。
 *
 * 🔴 没有它的表现是**两位数的输入框被拉到 1800px 宽**（`auto-fit
 * minmax(190px,1fr)` 在超宽屏上把每列拉满），而一个填「70」的框有
 * 1800px 宽时，label 和值离得太远，读起来要来回扫视。
 * AWS Console 的表单区同样是定宽（它用 `max-width: 800px` 一档）。
 */
export const MAXW = 1180;
/** 表单区更窄 —— 一行两列时每列约 340px，正好是一个数值输入框的舒适宽度。 */
export const FORM_MAXW = 760;

export const page: React.CSSProperties = {
  padding: "16px 20px 32px", overflowY: "auto", height: "100%",
};
export const inner: React.CSSProperties = { maxWidth: MAXW, margin: "0 auto" };

export const input: React.CSSProperties = {
  background: "var(--page)", color: C.text,
  border: `1px solid ${C.line}`, borderRadius: 8,
  padding: "6px 9px", fontSize: 13, width: "100%",
  boxSizing: "border-box", minWidth: 0,
};

export const th: React.CSSProperties = {
  textAlign: "left", color: C.muted, fontSize: 11, fontWeight: 600,
  textTransform: "uppercase", letterSpacing: ".06em",
  padding: "8px 12px", borderBottom: `1px solid ${C.line}`, whiteSpace: "nowrap",
  background: C.card,
};

export const td: React.CSSProperties = {
  padding: "9px 12px", borderBottom: `1px solid ${C.line}`,
  fontSize: 13, color: C.text, verticalAlign: "top",
};
