/**
 * 巡检看板的 UI 原子层。**照 AWS Console（Cloudscape）的交互规范做**，
 * 用本仓既有的 CSS 变量取色，不引任何组件库。
 *
 * ## 为什么单独一层
 *
 * 第一版把按钮、徽章、空态直接内联在 1900 行的主组件里，结果是同一个
 * 「保存」按钮在四处有四种宽度和四种 disabled 表现 —— 而 disabled 的
 * **原因**一处都没有。抽出来之后，「一个按钮该怎么表现」只有一个答案。
 *
 * ## 六条贯穿全层的规矩
 *
 * ```
 * ① disabled 必须给原因      灰着但不说为什么的按钮是最糟的形态：
 *                            用户只能猜「是不是坏了」。所以 Btn 的
 *                            disabled 走 `disabledReason`，它同时渲染
 *                            title 与 aria-disabled
 * ② 加载分三种，不混用       首次 → 骨架屏（保住布局，不跳）
 *                            刷新 → 顶部细条（不动内容，用户正在看）
 *                            操作 → 按钮内转圈（焦点不离开按钮）
 * ③ 状态不能只靠颜色         StatusIndicator 一律 图标 + 文字 + 颜色。
 *                            只给色块的话色觉障碍用户读不出严重度
 * ④ 写操作的结果不自动消失   Alert 要手动关。自动消失会让用户在
 *                            切标签回来后以为「我到底点没点」
 * ⑤ 影响面大的操作用 Modal   不用 window.confirm —— 它没法说明
 *                            「这会影响 12 台资源」，而那恰恰是
 *                            用户做决定需要的信息
 * ⑥ 空态要给下一步动作       只说「暂无数据」的空态等于把用户扔在原地
 * ```
 */

import { useEffect, useId, useRef, useState } from "react";

import { C, SEV_COLOR } from "./tokens";

// ⚠️ **不 re-export** 那些令牌。`react-refresh/only-export-components`
//    把转出去的常量也算「非组件导出」，而那会让这个文件的热更新退化成
//    整页刷新（改一个按钮样式，正在填的表单被清空）。
//    调用方直接 `from "./tokens"`。

// ---------------------------------------------------------------------------
// 版式
// ---------------------------------------------------------------------------

/** 页头：标题 + 说明 + 右侧操作区。AWS Console 每一页都是这个结构。 */
export function PageHeader({ title, count, description, actions }: {
  title: React.ReactNode;
  /** 标题后面的计数，AWS 的写法是 `实例 (12)`。`undefined` = 不显示。 */
  count?: number;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 16,
      flexWrap: "wrap", marginBottom: 14,
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{
          fontSize: 19, fontWeight: 700, color: C.text, lineHeight: 1.3,
        }}>
          {title}
          {count !== undefined && (
            <span style={{ color: C.muted, fontWeight: 400, marginLeft: 6 }}>
              ({count})
            </span>
          )}
        </div>
        {description && (
          <div style={{
            color: C.muted, fontSize: 12.5, marginTop: 4, lineHeight: 1.6,
            maxWidth: 760,
          }}>{description}</div>
        )}
      </div>
      {actions && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {actions}
        </div>
      )}
    </div>
  );
}

export function Container({ header, footer, children, style, padded = true }: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
  /** 表格要贴边，所以给 `padded={false}`。 */
  padded?: boolean;
}) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.line}`, borderRadius: 10,
      overflow: "hidden", ...style,
    }}>
      {header && (
        <div style={{
          padding: "11px 14px", borderBottom: `1px solid ${C.line}`,
          display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        }}>{header}</div>
      )}
      <div style={padded ? { padding: "13px 14px" } : undefined}>{children}</div>
      {footer && (
        <div style={{
          padding: "10px 14px", borderTop: `1px solid ${C.line}`,
          display: "flex", justifyContent: "flex-end", gap: 8,
        }}>{footer}</div>
      )}
    </div>
  );
}

export function SectionHeading({ children, actions, sub }: {
  children: React.ReactNode; actions?: React.ReactNode; sub?: React.ReactNode;
}) {
  return (
    <div style={{ margin: "20px 0 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{children}</div>
        <div style={{ flex: 1 }} />
        {actions}
      </div>
      {sub && (
        <div style={{ color: C.muted, fontSize: 12, marginTop: 3, lineHeight: 1.6 }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * 折叠区。header 常显计数，**不把「有多少东西被折起来了」藏掉**。
 *
 * 🔴 `locked` 用于「这里面有必须被看到的东西」（比如派发缺口 >0）——
 * 折叠一个已知的数据缺口等于把它藏起来。锁住时**必须给原因**，
 * 否则用户只会觉得折叠按钮坏了。
 */
export function Expandable({
  title, count, badge, children, open, onToggle, locked = false, lockedReason = "",
}: {
  title: React.ReactNode;
  count?: number;
  badge?: React.ReactNode;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  locked?: boolean;
  lockedReason?: string;
}) {
  return (
    <div style={{
      border: `1px solid ${C.line}`, borderRadius: 10, background: C.card,
      marginTop: 14, overflow: "hidden",
    }}>
      <button onClick={locked ? undefined : onToggle} aria-expanded={open}
        aria-disabled={locked || undefined} title={locked ? lockedReason : undefined}
        style={{
          display: "flex", alignItems: "center", gap: 8, width: "100%",
          background: "transparent", border: "none",
          cursor: locked ? "default" : "pointer",
          padding: "10px 14px", color: C.text, fontSize: 13.5,
          fontWeight: 600, textAlign: "left",
        }}>
        <span style={{ color: C.muted, fontSize: 11, width: 10 }}>
          {/* ⚠️ `locked` 时**恒为展开态**（`opsShown = ops || gap > 0`），
              所以不需要为它单独一支 —— 原来写的是
              `locked ? "▾" : open ? "▾" : "▸"`，前两支给的是同一个字符。 */}
          {open ? "▾" : "▸"}
        </span>
        {title}
        {count !== undefined && (
          <span style={{ color: C.muted, fontWeight: 400 }}>({count})</span>
        )}
        {badge}
        {/* 🔴 **锁住的原因要看得见**，不能只在 `title` 里。
            `title` 只有鼠标悬停才出现 —— 键盘与触屏用户永远看不到，
            而他们看到的是一个点不动的折叠按钮（`aria-disabled`），
            也就是这段注释自己说的「用户只会觉得折叠按钮坏了」。
            ⚠️ 同时留 `title`：鼠标用户悬停就有，不必扫到行尾。 */}
        {locked && lockedReason && (
          <span style={{
            marginLeft: "auto", fontSize: 11, fontWeight: 400, color: C.muted,
            textAlign: "right", maxWidth: "52%",
          }}>
            {lockedReason}
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: "0 14px 14px", borderTop: `1px solid ${C.line}` }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 按钮
// ---------------------------------------------------------------------------

type Variant = "primary" | "normal" | "link" | "danger";

/**
 * 按钮。
 *
 * 🔴 **`disabledReason` 而不是 `disabled`。** 一个灰着的按钮不说明原因，
 * 用户只能猜「是不是坏了 / 是不是我没权限 / 是不是还在加载」。
 * 所以这里的 API 强迫调用方给出理由，理由同时进 `title` 与 `aria-label`。
 *
 * ⚠️ `loading` 时按钮**保持可见宽度**（转圈替换掉图标位，文字不变）——
 * 文字换成「提交中…」会让按钮宽度跳一下，一排按钮跟着位移。
 *
 * ⚠️ 没权限时调用方应当**不渲染**这个按钮，而不是传 disabledReason。
 * 「点了就 403」和「灰着说你没权限」都比看不见更糟：前者是错误，
 * 后者是在界面上给一个用户无法解决的问题。
 */
export function Btn({
  children, onClick, variant = "normal", loading = false,
  disabledReason = "", size = "normal", iconLeft, title, name, full = false,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: Variant;
  loading?: boolean;
  disabledReason?: string;
  size?: "normal" | "small";
  iconLeft?: React.ReactNode;
  title?: string;
  name?: string;
  full?: boolean;
}) {
  const off = !!disabledReason || loading;
  const pad = size === "small" ? "3px 9px" : "5px 13px";
  const fs = size === "small" ? 12 : 13;

  const base: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    gap: 6, padding: pad, fontSize: fs, borderRadius: 8, lineHeight: 1.5,
    cursor: off ? "not-allowed" : "pointer", whiteSpace: "nowrap",
    fontWeight: variant === "primary" ? 600 : 500,
    width: full ? "100%" : undefined,
    // ⚠️ 只降到 0.5 而不是更低：AWS 的 disabled 仍然要可读 ——
    //    读不出文字的按钮用户连「它本来是干什么的」都不知道。
    opacity: off ? 0.5 : 1,
    transition: "opacity .12s",
  };
  const skin: Record<Variant, React.CSSProperties> = {
    primary: { background: C.blue, color: "#fff", border: `1px solid ${C.blue}` },
    normal: { background: "transparent", color: C.text, border: `1px solid ${C.line}` },
    link: { background: "transparent", color: C.blue, border: "1px solid transparent" },
    danger: { background: "transparent", color: C.red, border: `1px solid ${C.red}` },
  };

  return (
    <button type="button" name={name}
      // 🔴 **只用 `aria-disabled`，不用原生 `disabled`。**
      //
      //    原生 `disabled` 会把按钮从 tab 序里摘掉，而且 Firefox / Safari
      //    对 disabled 表单控件**不派发鼠标事件** → `title` tooltip 出不来。
      //    于是「disabled 必须给原因」这套设计在那几种情况下全部失效：
      //    键盘用户、屏幕阅读器（多数直接跳过 disabled 按钮）、
      //    Firefox/Safari 的鼠标用户。Chrome 上能看到，所以自测时最容易漏。
      //
      //    保持可聚焦 + 在 handler 里拦，理由就读得到了。
      onClick={off ? (e) => e.preventDefault() : onClick}
      aria-disabled={off || undefined}
      aria-busy={loading || undefined}
      // ⚠️ 理由同时进 `title`（鼠标）与 `aria-label`（屏幕阅读器）——
      //    只给 title 的话 AT 用户听不到为什么点不动。
      title={disabledReason || title}
      aria-label={disabledReason
        ? `${typeof children === "string" ? children : ""}（${disabledReason}）`
        : undefined}
      style={{ ...base, ...skin[variant] }}>
      {loading ? <span className="insp-spin" aria-hidden /> : iconLeft}
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// 状态与徽章
// ---------------------------------------------------------------------------

export type StatusType =
  | "success" | "error" | "warning" | "info" | "pending" | "in-progress";

const STATUS_FACE: Record<StatusType, { icon: string; color: string }> = {
  success: { icon: "✓", color: C.green },
  error: { icon: "✕", color: C.red },
  warning: { icon: "⚠", color: C.amber },
  info: { icon: "ℹ", color: C.blue },
  pending: { icon: "○", color: C.muted },
  "in-progress": { icon: "◐", color: C.blue },
};

/**
 * 状态指示。**图标 + 文字 + 颜色三者齐全。**
 *
 * 🔴 只用颜色表达状态过不了可访问性：约 8% 的男性有红绿色觉障碍，
 * 而这套看板里「成功/失败」正好是绿/红。图标是那部分用户唯一的线索。
 */
export function Status({ type, children, bold = false }: {
  type: StatusType; children: React.ReactNode; bold?: boolean;
}) {
  const f = STATUS_FACE[type];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      color: f.color, fontSize: 12.5, fontWeight: bold ? 600 : 400,
    }}>
      <span aria-hidden style={{ fontSize: 12 }}>{f.icon}</span>
      <span>{children}</span>
    </span>
  );
}

/**
 * 小徽标。
 *
 * 🔴 `title` 是**鼠标专属**的 —— 键盘与触屏用户永远看不到它，读屏也不一定念。
 * 所以凡是「徽标上写着 `ⓘ`、细节在 title 里」的用法都必须同时给
 * `aria-label`，否则那个细节对辅助技术**完全不存在**。
 *
 * 本仓库里这一类有两处：卡片上的「粗估 ⓘ」（哪一档粗估）与「少 N 维 ⓘ」
 * （具体少了哪几维）。两者的细节都直接影响「这个数字能不能信」。
 *
 * ⚠️ 不把细节铺到可见文本里：那会让一屏装不下几条卡片，而这一页的全部意义
 *    是扫读密度（客户原话「空间太紧张」）。给 AT 完整信息 + 给鼠标 title
 *    是同一份内容的两个出口，不是两套文案。
 */
export function Badge({ children, tone = "neutral", title, ariaLabel }: {
  children: React.ReactNode;
  tone?: "neutral" | "blue" | "red" | "amber" | "green";
  title?: string;
  /**
   * 给读屏的完整说明。**省略时自动用 `title`** —— 绝大多数调用点两者
   * 应当是同一句话，让它们各写一份只会漂开。
   */
  ariaLabel?: string;
}) {
  const tones = {
    neutral: { color: C.muted, border: C.line },
    blue: { color: C.blue, border: C.blue },
    red: { color: C.red, border: C.red },
    amber: { color: C.amber, border: C.amber },
    green: { color: C.green, border: C.green },
  }[tone];
  return (
    <span title={title} aria-label={ariaLabel ?? title} style={{
      display: "inline-block", border: `1px solid ${tones.border}`,
      color: tones.color, borderRadius: 6, padding: "0 6px",
      fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

/** 严重度徽章：实心色块 + 大写文字。列表里靠它一眼分档。 */
export function SevBadge({ sev, label }: {
  sev: keyof typeof SEV_COLOR; label: string;
}) {
  const c = SEV_COLOR[sev];
  return (
    <span style={{
      display: "inline-block", background: c, color: "#fff",
      borderRadius: 5, padding: "0 7px", fontSize: 10.5, fontWeight: 700,
      letterSpacing: ".06em", textTransform: "uppercase", lineHeight: "18px",
    }}>{label}</span>
  );
}

// ---------------------------------------------------------------------------
// 提示条
// ---------------------------------------------------------------------------

/**
 * 提示条（AWS 的 Alert / Flashbar）。
 *
 * ⚠️ **不自动消失。** 写操作的结果自动消失会让用户切个标签回来就不知道
 * 「我到底点没点、成没成」。要关就手动关。
 */
export function Alert({ type, header, children, onDismiss, action }: {
  type: StatusType;
  header?: React.ReactNode;
  children?: React.ReactNode;
  onDismiss?: () => void;
  action?: React.ReactNode;
}) {
  const f = STATUS_FACE[type];
  return (
    <div role={type === "error" ? "alert" : "status"} style={{
      display: "flex", gap: 10, alignItems: "flex-start",
      border: `1px solid ${f.color}`, borderLeft: `3px solid ${f.color}`,
      borderRadius: 8, padding: "9px 12px", margin: "0 0 12px",
      background: C.card, fontSize: 12.5, lineHeight: 1.6,
    }}>
      <span aria-hidden style={{ color: f.color, fontSize: 13, marginTop: 1 }}>
        {f.icon}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {header && (
          <div style={{ fontWeight: 600, color: C.text, marginBottom: children ? 3 : 0 }}>
            {header}
          </div>
        )}
        {children && <div style={{ color: C.muted }}>{children}</div>}
        {action && <div style={{ marginTop: 8 }}>{action}</div>}
      </div>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="dismiss" style={{
          background: "transparent", border: "none", color: C.muted,
          cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 2,
        }}>✕</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 加载态
// ---------------------------------------------------------------------------

/**
 * 骨架屏。**首次加载**用它 —— 它保住了最终布局的几何，内容到达时不跳。
 *
 * ⚠️ 用既有的 `.sk` 类（`styles.css` 里已有 `--sk-bg` + skpulse +
 * prefers-reduced-motion 的处理），不自己再造一份灰块。
 */
export function Skeleton({ w = "100%", h = 13, style }: {
  w?: number | string; h?: number; style?: React.CSSProperties;
}) {
  return <div className="sk" style={{ width: w, height: h, ...style }} />;
}

/** 卡片列表的骨架：三张卡的轮廓。行数固定 3 —— 骨架的作用是占位不是猜数量。 */
export function SkeletonCards({ n = 3 }: { n?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} style={{
          border: `1px solid ${C.line}`, borderRadius: 10, background: C.card,
          padding: "13px 14px",
        }}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <Skeleton w={72} h={18} />
            <Skeleton w={140} h={18} />
          </div>
          <Skeleton w="60%" h={13} />
          <Skeleton w="40%" h={13} style={{ marginTop: 7 }} />
        </div>
      ))}
    </div>
  );
}

/**
 * 刷新条。**不遮挡内容** —— 刷新期把内容换成骨架会让页面跳一下，
 * 而用户此刻正在看那些内容（他刚点了保存）。
 */
export function RefreshBar({ on }: { on: boolean }) {
  return <div className={on ? "insp-bar" : undefined} style={{ height: 2, marginBottom: 8 }} />;
}

// ---------------------------------------------------------------------------
// 空态
// ---------------------------------------------------------------------------

/**
 * 空态。**必须给下一步动作**（AWS Console 的空态一律带一个主按钮）。
 * 只说「暂无数据」等于把用户扔在原地。
 */
export function Empty({ icon = "○", title, hint, action, tone = C.muted }: {
  icon?: string;
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
  tone?: string;
}) {
  return (
    <div style={{
      textAlign: "center", padding: "34px 20px", color: C.muted,
      border: `1px dashed ${C.line}`, borderRadius: 10,
    }}>
      <div aria-hidden style={{ fontSize: 22, color: tone, marginBottom: 8 }}>
        {icon}
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{title}</div>
      {hint && (
        <div style={{
          fontSize: 12.5, marginTop: 6, lineHeight: 1.7,
          maxWidth: 460, marginLeft: "auto", marginRight: "auto",
        }}>{hint}</div>
      )}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 表单
// ---------------------------------------------------------------------------


/**
 * 表单字段。AWS 的顺序是 **label → description → 控件 → error**。
 *
 * ⚠️ 错误信息在控件**下方**而不是上方：上方的错误会把控件往下推，
 * 用户正在打字时输入框会跳走。
 */
export function Field({ label, description, error, children, required = false, hint }: {
  label: React.ReactNode;
  description?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
  required?: boolean;
  /** 控件下方的常态说明（与 error 互斥显示，error 优先）。 */
  hint?: React.ReactNode;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{
        fontSize: 12.5, fontWeight: 600, color: C.text, marginBottom: 3,
      }}>
        {label}
        {required && <span style={{ color: C.red, marginLeft: 3 }}>*</span>}
      </div>
      {description && (
        <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 5, lineHeight: 1.55 }}>
          {description}
        </div>
      )}
      {children}
      {(error || hint) && (
        <div style={{
          fontSize: 11.5, marginTop: 4, lineHeight: 1.5,
          color: error ? C.red : C.muted,
        }}>{error || hint}</div>
      )}
    </div>
  );
}

/**
 * 表格行尾的**操作菜单**（AWS Console 的行内 `⋯`）。
 *
 * ## 为什么不平铺按钮
 *
 * 客户原话（2026-09-01）：「可以改成一个 action button，点开有这些功能即可，
 * 不要把这些功能都平铺，空间太紧张。」
 *
 * 排除清单一行有 6 列（账号 / 资源 / 区域 / 层级 / 原因 / 到期），再平铺两个
 * 按钮之后：日期列被挤到换行（`2026-10-` + `01`）、原因列换行、层级列的徽章
 * 掉到第二行。**内容被操作挤变形**，而内容才是这一页的主体。
 *
 * ## 🔴 用 `position: fixed` 而不是 `absolute`
 *
 * 这个菜单开在表格里，而表格的容器是 `overflowX: auto`（窄屏要能横向滚）。
 * `absolute` 定位的浮层会被那个 overflow **裁掉** —— 表现是点了 `⋯` 只看到
 * 半个菜单，或者什么都看不到。`fixed` + `getBoundingClientRect()` 逃出容器。
 *
 * ⚠️ 代价是它**不跟随滚动**。所以滚动 / 改窗口大小时直接关掉 ——
 * 一个飘在错位置的菜单比没有菜单更糟（点下去命中的是另一行）。
 */
export function RowMenu({ items, label = "操作" }: {
  items: {
    key: string;
    label: React.ReactNode;
    onClick: () => void;
    /** 危险动作（红字）。撤销类放这里。 */
    danger?: boolean;
    /** 非空 = 这一项不可用，并把原因写进 title（规矩 ①）。 */
    disabledReason?: string;
    /** 这一项正在跑 —— 菜单不关，显示「…」。 */
    loading?: boolean;
  }[];
  label?: string;
}) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 关掉的三条路：点外面、Esc、滚动/改窗口大小（见上面 fixed 那段）。
  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    };
    /**
     * 🔴 键盘操作。原来只有 Esc（而且**不还焦点**）。缺的三件事：
     *
     * ```
     * ① 打开后焦点不进菜单  → 键盘用户按 Tab 会走到页面后面去，
     *                        而菜单是 `position: fixed` 的，视觉上明明就在眼前
     * ② 没有方向键          → `role="menu"` 的既定交互是 ↑↓，读屏用户会去按
     * ③ Esc 后焦点丢失      → 菜单卸载，焦点掉回 `<body>`，Tab 从页面顶端重来。
     *                        而这一行的「操作」按钮就在原地，焦点本该回到它
     * ```
     *
     * ⚠️ `Home` / `End` 也接上：`role="menu"` 的键盘约定里它们是标准动作，
     *    少了会让长菜单要按很多次方向键。
     */
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        // 焦点还给触发按钮 —— 它一直在原地，不还的话 Tab 从页面顶端重来。
        btnRef.current?.focus();
        return;
      }
      const box = menuRef.current;
      if (!box) return;
      const cells = [...box.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .filter((el) => el.getAttribute("aria-disabled") !== "true");
      if (cells.length === 0) return;
      const at = cells.indexOf(document.activeElement as HTMLElement);
      const go = (i: number) => {
        e.preventDefault();
        cells[(i + cells.length) % cells.length].focus();
      };
      if (e.key === "ArrowDown") go(at + 1);
      else if (e.key === "ArrowUp") go(at <= 0 ? cells.length - 1 : at - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(cells.length - 1);
      else if (e.key === "Tab") {
        /* Tab 从菜单里出去 = 关掉它（原生 menu 的行为）。
           ⚠️ **不** preventDefault：让浏览器把焦点移到下一个元素，
              拦住它会让键盘用户卡在一个已经关掉的菜单上。 */
        if (box.contains(document.activeElement)) close();
      }
    };
    /* 打开后把焦点送进第一项。⚠️ 放在这个 effect 里而不是 `toggle()` ——
       `toggle` 里菜单还没渲染（`pos` 是这一次 setState 的目标值）。 */
    menuRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    // ⚠️ `capture: true` —— 滚的可能是内层容器，冒泡阶段在 window 上收不到。
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [pos]);

  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // 右对齐到按钮右缘，向下 4px。`right` 用视口右边距算 —— fixed 定位下
    // `right` 比 `left` 稳：菜单宽度变化时不会越过屏幕右边。
    setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
  };

  return (
    <>
      <button ref={btnRef} type="button" onClick={toggle}
        aria-label={label} aria-haspopup="menu" aria-expanded={!!pos}
        title={label}
        style={{
          background: "transparent", border: `1px solid ${C.line}`,
          borderRadius: 6, color: C.text, cursor: "pointer",
          padding: "2px 7px", fontSize: 14, lineHeight: 1.2,
        }}>
        ⋯
      </button>
      {pos && (
        <div ref={menuRef} role="menu" aria-label={label}
          style={{
            position: "fixed", top: pos.top, right: pos.right, zIndex: 60,
            background: C.card, border: `1px solid ${C.line}`, borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,.16)", padding: 4, minWidth: 150,
          }}>
          {items.map((it) => {
            const off = !!it.disabledReason;
            return (
              <button key={it.key} type="button" role="menuitem"
                className={off ? undefined : "insp-row"}
                onClick={() => {
                  if (off) return;
                  // 🔴 先关菜单再执行：动作会触发 reload()，那时这一行可能
                  //    已经不存在了，而菜单是挂在它上面的。
                  setPos(null);
                  it.onClick();
                }}
                aria-disabled={off || undefined}
                /* ⚠️ 禁用项从 tab 序里摘出去（`aria-disabled` 只告诉读屏，
                   不影响焦点）。留着的表现是键盘用户 Tab 到一个点不动的项，
                   而屏幕上它是灰的 —— 看起来像界面卡住了。
                   ⚠️ 用 `-1` 而不是 `disabled`：后者会让读屏**完全跳过**它，
                      于是「有这一项但不可用，原因是 X」这个信息也丢了，
                      而那正是本仓库规矩①要保住的东西。 */
                tabIndex={off ? -1 : 0}
                title={it.disabledReason || undefined}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  background: "transparent", border: "none", borderRadius: 6,
                  padding: "6px 9px", fontSize: 12.5, whiteSpace: "nowrap",
                  cursor: off ? "not-allowed" : "pointer",
                  opacity: off ? 0.45 : 1,
                  color: it.danger ? C.red : C.text,
                }}>
                {it.loading ? "…" : it.label}
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}

/** 一排 chip 筛选器。选中态实心，未选描边。 */
export function Chip({ active, onClick, children, disabled = false, name, title }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
  disabled?: boolean; name?: string; title?: string;
}) {
  return (
    <button type="button" name={name} onClick={disabled ? undefined : onClick}
      aria-pressed={active} disabled={disabled} title={title}
      style={{
        border: `1px solid ${active ? C.blue : C.line}`,
        background: active ? C.blue : "transparent",
        color: active ? "#fff" : (disabled ? C.muted : C.text),
        borderRadius: 999, padding: "3px 12px", fontSize: 12.5,
        cursor: disabled ? "default" : "pointer", lineHeight: 1.7,
        whiteSpace: "nowrap", opacity: disabled ? 0.55 : 1,
        fontWeight: active ? 600 : 400,
      }}>{children}</button>
  );
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------


/** 详情里的键值对（AWS 的 KeyValuePairs）。label 小灰在上，值在下。 */
export function KV({ label, children, mono = false }: {
  label: React.ReactNode; children: React.ReactNode; mono?: boolean;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ color: C.muted, fontSize: 11.5, marginBottom: 2 }}>{label}</div>
      <div style={{
        fontSize: 13, color: C.text, wordBreak: "break-word",
        fontFamily: mono ? "var(--mono, ui-monospace, monospace)" : undefined,
      }}>{children}</div>
    </div>
  );
}

export function KVGrid({ children, cols = 3 }: {
  children: React.ReactNode; cols?: number;
}) {
  return (
    <div style={{
      display: "grid", gap: 12,
      gridTemplateColumns: `repeat(auto-fit, minmax(${Math.floor(680 / cols)}px, 1fr))`,
    }}>{children}</div>
  );
}

// ---------------------------------------------------------------------------
// 浮层
// ---------------------------------------------------------------------------

const FOCUSABLE = 'input:not([type="hidden"]),select,textarea,button,[href],[tabindex]:not([tabindex="-1"])';

/**
 * 浮层的基本可用性：Esc 关闭 · 自动聚焦 · **焦点环绕** · 锁背景滚动 ·
 * 关闭后把焦点还给打开它的那个元素。
 *
 * 🔴 少了焦点环绕的表现：打开弹层 → 一直按 Tab → 焦点走出对话框，落到
 * 背后被遮罩盖住的账号选择器、chip、卡片上（`aria-modal="true"` 只对 AT
 * 生效，**不拦 Tab**）→ 用户在一个看不见的控件上打字或回车。
 *
 * 🔴 `onClose` 走 ref 而不是进 deps。调用方全部传内联箭头，每次父渲染都是
 * 新身份 → effect 重跑 → 重新 `focus()` 第一个控件：
 *
 * ```
 * 点「跑闲置」→ 打开排除弹层 → 在「原因」里打字
 *   → 那一轮跑完时轮询 setSlot + reload() 让父组件重渲染
 *   → 焦点跳回顶部的「全部」chip，后面敲的字进不了输入框
 * ```
 *
 * `lockClose` 用于「提交中不许关」，`dirty` 用于「有未保存内容时遮罩点击不关」。
 */
/**
 * 当前打开着的浮层，**按打开顺序**。最后一个是最上层。
 *
 * 🔴 存在的理由：`useOverlay` 把 `keydown` 挂在 `document` 上，所以抽屉与弹层
 * 同开时**两个 handler 都会跑**，而它们各自都想把焦点抢回自己的框里。
 * 实际后果（2026-09-02 review 抓到，键盘用户完不成派发）：
 *
 * ```
 * 抽屉先挂载（handler A），弹窗后挂载（handler B）
 * 按 Tab
 *   → A 先跑：activeElement 在弹窗里 → A 的 box 不 contains 它
 *             → preventDefault() + 抽屉第一个元素 .focus()
 *   → B 再跑：activeElement 现在在抽屉里 → B 的 box 也不 contains
 *             → preventDefault() + 弹窗第一个元素 .focus()
 * ⇒ 每按一次 Tab 焦点都被重置回弹窗的**第一个**元素，永远到不了「确认」按钮
 * ```
 *
 * Esc 同样：一次按键让两层各自调 `onClose()` —— 关弹窗顺带把抽屉也关了，
 * 而抽屉本该留着（派发完要让人看到里面那行「已派发 task <id>」）。
 *
 * ⚠️ 用模块级数组而不是 context：`Modal` / `Drawer` 可以挂在任意组件树位置
 *    （`ExclusionModal` 就在 `ScopePage` 里），套一个 provider 会要求所有
 *    调用点改结构，而这是纯粹的「谁在最上面」的全局事实。
 *
 * ⚠️ 卸载时按**身份**移除而不是 `pop()`：React 的卸载顺序不保证与挂载顺序
 *    严格相反（Strict Mode 下会双挂载），`pop()` 会移错人。
 */
const overlayStack: React.RefObject<HTMLDivElement | null>[] = [];

function useOverlay(onClose: () => void, { lockClose = false } = {}) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const lockRef = useRef(lockClose);
  // ⚠️ 在 effect 里同步而不是渲染期赋值（React 19 的 `react-hooks/refs`）。
  //    这两个 effect 每次渲染都跑，但只做赋值，没有副作用。
  useEffect(() => { closeRef.current = onClose; });
  useEffect(() => { lockRef.current = lockClose; });

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    overlayStack.push(box);

    const onKey = (e: KeyboardEvent) => {
      /* 🔴 **只有最上层那个浮层响应键盘。** 见 `overlayStack` 的说明 ——
         不判这一条的话抽屉与弹层同开时两个 handler 互相抢焦点，
         每按一次 Tab 都被重置回第一个元素，键盘用户永远到不了「确认」。
         Esc 也一样：一次按键会把两层一起关掉。 */
      if (overlayStack[overlayStack.length - 1] !== box) return;
      if (e.key === "Escape") {
        if (!lockRef.current) closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((el) => el.offsetParent !== null
          && el.getAttribute("aria-disabled") !== "true");
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // 环绕：最后一个往后 → 回到第一个；第一个往前 → 到最后一个。
      if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!box.current.contains(active)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);

    // ⚠️ 自动聚焦到浮层内部，否则 Tab 会从页面顶部开始 —— 键盘用户要
    //    穿过整个页面才能到达刚打开的对话框。
    box.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      // 按**身份**移除（见 `overlayStack` 的说明，不能 pop）。
      const i = overlayStack.indexOf(box);
      if (i >= 0) overlayStack.splice(i, 1);
      /* ⚠️ `overflow` 只在**最后一个**浮层关闭时还原。抽屉+弹层同开时，
         关掉弹窗就把 `overflow` 还成 `visible` 会让身后的页面重新能滚 ——
         而抽屉还开着，滚动会把它拖离视口。
         判据是「栈空了」而不是 `prevOverflow`：后者在第二层上捕获到的是
         第一层设的 `hidden`，还原它等于什么都没做（那是巧合的正确，
         而巧合会在某天有人调整挂载顺序时失效）。 */
      if (overlayStack.length === 0) document.body.style.overflow = prevOverflow;
      /* 焦点归还 —— 不还的话 Tab 从页面最顶端重新开始。

         🔴 **要先确认那个节点还在文档里。** 焦点来源常常是一个「点完就不再
         渲染」的按钮：抽屉里的「深入分析」派发成功后整个按钮消失
         （判据是 `!dispatched`），于是这里 `.focus()` 打在一个已卸载的节点上
         —— 静默无效，焦点掉回 `<body>`，Tab 从页面顶端重新开始。
         那正是「焦点归还」要防的那件事，只是换了个成因。

         ⚠️ 节点没了就**什么都不做**，不去猜一个替代目标。乱抢焦点比丢焦点
            更糟：读屏用户会被带到一个他没请求的位置。浏览器把焦点留在
            `<body>` 时 Tab 至少从头开始，行为是可预期的。 */
      if (prevFocus && document.contains(prevFocus)) prevFocus.focus?.();
    };
  }, []);        // ← 挂载时一次。onClose / lockClose 走 ref（见上）。
  return box;
}

const scrim: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.45)",
  zIndex: 1000, display: "flex",
};

/**
 * 对话框的层级 —— **必须高于抽屉**。
 *
 * 🔴 2026-08-31 实机踩到：从详情抽屉里点「深入分析」，确认弹窗渲染出来了，
 *    但压在抽屉**下面**，而且被抽屉的遮罩盖成灰色 —— 看起来像「弹窗坏了」。
 *
 *    根因：`Modal` 与 `Drawer` 共用 `scrim`（同 `zIndex: 1000`）。同层时靠
 *    DOM 顺序决定叠放，而抽屉是在弹窗**之后**渲染的（它挂在组件树更下面）。
 *
 * ⚠️ 既有的绕法是「开弹窗前先关抽屉」（`ExclusionModal` 那处的
 *    `closeDrawer()`）。那治得了单个实例，治不了这一类 —— 而且有些弹窗
 *    **需要**抽屉留着（判读派发完要让人看到抽屉里那行「已派发 task <id>」）。
 *
 * ⚠️ 差值只要 +1 就够，但用 +10 留出余量：将来抽屉里再套一层（比如弹窗里
 *    再开一个确认）时不必再改这里。
 */
const MODAL_Z = 1010;

/**
 * 对话框。
 *
 * 🔴 用它替掉 `window.confirm`：后者没法说明「这会影响 12 台资源」，
 * 而那恰恰是用户做决定需要的信息。它还会被浏览器的「阻止此页面再次弹窗」
 * 静默禁掉 —— 那时确认会**直接返回 false**，操作看起来像被取消了。
 */
export function Modal({
  title, children, onClose, footer, width = 560, lockClose = false, dirty = false,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  width?: number;
  /** 提交中 —— Esc 与遮罩都不关（剩下的请求还在发）。 */
  lockClose?: boolean;
  /** 有未保存内容 —— 遮罩点击不关（Cloudscape 同规矩）。 */
  dirty?: boolean;
}) {
  const box = useOverlay(onClose, { lockClose });
  /**
   * 🔴 `role="dialog"` **必须有可访问名**，否则读屏只念「对话框」——
   * 而这个产品的对话框恰恰都是「你确定要让整个账号退出巡检吗」这一类，
   * 名字就是全部信息。用 `aria-labelledby` 指向标题节点（而不是
   * `aria-label` 复制一份文案）：标题是 `ReactNode`，复制不出来，
   * 而复制得出来的那部分也会随时漂开。
   */
  const titleId = useId();
  const scrimClose = () => { if (!lockClose && !dirty) onClose(); };
  return (
    <div style={{ ...scrim, zIndex: MODAL_Z,
      alignItems: "flex-start", justifyContent: "center" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) scrimClose(); }}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId}
        style={{
          background: C.card, border: `1px solid ${C.line}`, borderRadius: 12,
          /* ⚠️ 同 `Drawer`：不用 `min()`，jsdom 解析不了它（整条声明被丢弃，
             宽度在测试里不可观测）。`width:100% + maxWidth` 在 flex 容器里
             等价，两侧 16px 的 margin 由 flex-shrink 吸收。 */
          width: "100%", maxWidth: `${width}px`, margin: "8vh 16px",
          maxHeight: "82vh", display: "flex", flexDirection: "column",
          boxShadow: "0 18px 48px rgba(0,0,0,.4)",
        }}>
        <div style={{
          padding: "13px 16px", borderBottom: `1px solid ${C.line}`,
          display: "flex", alignItems: "center", gap: 10,
        }}>
          <div id={titleId}
            style={{ fontSize: 15, fontWeight: 700, color: C.text, flex: 1 }}>
            {title}
          </div>
          <Btn variant="link" size="small" onClick={onClose}
            disabledReason={lockClose
              ? "正在提交，请稍候（剩下的请求还在发）" : ""}>✕</Btn>
        </div>
        <div style={{ padding: "14px 16px", overflowY: "auto", flex: 1 }}>
          {children}
        </div>
        {footer && (
          <div style={{
            padding: "11px 16px", borderTop: `1px solid ${C.line}`,
            display: "flex", justifyContent: "flex-end", gap: 8,
          }}>{footer}</div>
        )}
      </div>
    </div>
  );
}

/** 右侧抽屉。详情用它 —— 列表留在原位，关掉抽屉不用重新找刚才看的那条。 */
export function Drawer({ title, subtitle, children, onClose, footer, width = 520 }: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  width?: number;
}) {
  const box = useOverlay(onClose);
  // 见 `Modal` 里同名常量的说明 —— dialog 必须有可访问名。
  const titleId = useId();
  return (
    <div style={{ ...scrim, justifyContent: "flex-end" }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={titleId}
        /* ⚠️ `width: 100% + maxWidth` 而不是 `min(${width}px, 100vw)`。
           两者在 flex 容器里等价（父级是铺满视口的 scrim，flex-shrink 默认 1），
           但 **jsdom 不解析 `min()`** —— 它会把整条声明丢掉，于是
           `el.style.width` 是空串，宽度这件事在测试里**完全不可观测**。
           客户为宽度提了两次，得能钉住。 */
        style={{
          background: "var(--page)", borderLeft: `1px solid ${C.line}`,
          width: "100%", maxWidth: `${width}px`, height: "100%",
          display: "flex", flexDirection: "column",
          boxShadow: "-12px 0 32px rgba(0,0,0,.35)",
        }}>
        <div style={{
          padding: "13px 16px", borderBottom: `1px solid ${C.line}`,
          display: "flex", alignItems: "flex-start", gap: 10,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div id={titleId}
              style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{title}</div>
            {subtitle && (
              <div style={{ color: C.muted, fontSize: 12, marginTop: 3 }}>{subtitle}</div>
            )}
          </div>
          <button onClick={onClose} aria-label="close" style={{
            background: "transparent", border: "none", color: C.muted,
            cursor: "pointer", fontSize: 16, lineHeight: 1,
          }}>✕</button>
        </div>
        <div style={{ padding: "14px 16px", overflowY: "auto", flex: 1 }}>
          {children}
        </div>
        {footer && (
          <div style={{
            padding: "11px 16px", borderTop: `1px solid ${C.line}`,
            display: "flex", gap: 8, flexWrap: "wrap",
          }}>{footer}</div>
        )}
      </div>
    </div>
  );
}
