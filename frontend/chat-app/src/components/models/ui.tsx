/**
 * 模型页的 UI 基件：抽屉、模态、标签、开关、ⓘ 提示、菜单、按钮、下拉。
 * 只导出组件（react-refresh 规则）；样式全在 styles.css 的 `.mdl-*`。
 *
 * 焦点规矩（键盘 / 读屏用户的「不迷路」）：
 *   · 打开：子元素已经 autoFocus（焦点已在框里）就不动它；否则聚焦标题。二选一，不互相覆盖。
 *   · 关闭：焦点回到调用方**显式指定**的目标（`returnFocus`）；没指定或它已不在文档里 →
 *     回到打开那一刻持焦点的元素（**渲染期**取，早于子元素 autoFocus、也早于触发它的菜单项卸载）。
 *   · 模态（挑选器）Tab / Shift+Tab 在框内环绕；抽屉是非模态的，不环绕。
 *   · Esc 只关最上层（escStack）：菜单、删除浮层、悬停提示、抽屉、模态都在同一个栈里。
 */
import {
  useEffect, useId, useLayoutEffect, useRef, useState,
  type ComponentProps, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject,
  type SelectHTMLAttributes,
} from "react";
import { flushSync } from "react-dom";

/* Esc 只关最上层的那一个（抽屉上叠着挑选器时，Esc 先关挑选器）。按打开顺序入栈，按身份出栈。 */
const escStack: { current: () => void }[] = [];
function onDocKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || !escStack.length) return;
  escStack[escStack.length - 1].current();
}
function useEscapeLayer(handler: () => void) {
  const ref = useRef(handler);
  useEffect(() => { ref.current = handler; });
  useEffect(() => {
    const layer = { current: () => ref.current() };
    escStack.push(layer);
    if (escStack.length === 1) document.addEventListener("keydown", onDocKey);
    return () => {
      const i = escStack.indexOf(layer);
      if (i >= 0) escStack.splice(i, 1);
      if (!escStack.length) document.removeEventListener("keydown", onDocKey);
    };
  }, []);
}

/** 挂载期间占一层 Esc。给「条件渲染」的浮层用（悬停提示）：显示时入栈、消失时出栈。 */
function EscLayer({ onEscape }: { onEscape: () => void }) {
  useEscapeLayer(onEscape);
  return null;
}

/** 还焦点的目标：调用方在关闭那一刻解析（按 id 找，行被删掉时返回 null 即可）。 */
export type FocusTarget = () => HTMLElement | null | undefined;

const FOCUSABLE = 'input:not([type="hidden"]),select,textarea,button,[href],[tabindex]:not([tabindex="-1"])';

function useFocusReturn(boxRef: RefObject<HTMLElement | null>, titleRef: RefObject<HTMLElement | null>,
                        returnFocus?: FocusTarget) {
  // 渲染期取「打开它的那个元素」：effect 里再取就晚了 —— 子元素 autoFocus 已经把焦点拿走，
  // 或者触发它的菜单项已经卸载（焦点掉在 body）。
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement as HTMLElement | null));
  const retRef = useRef(returnFocus);
  useEffect(() => { retRef.current = returnFocus; });
  useEffect(() => {
    // 子元素 autoFocus 了（搜索框、删除浮层的下拉）就尊重它；没有才聚焦标题（读屏先读到这是什么）。
    if (!boxRef.current?.contains(document.activeElement)) titleRef.current?.focus();
    return () => {
      const want = retRef.current?.();
      const target = want && document.contains(want) ? want
        : opener && opener !== document.body && document.contains(opener) ? opener : null;
      target?.focus();
    };
  }, [boxRef, titleRef, opener]);
}

/** 右侧抽屉：非模态（无遮罩，不挡保存条），同一时刻最多一个（由调用方保证）。 */
export function Drawer({ title, titleExtra, sub, onClose, closeLabel, footer, returnFocus, children }: {
  title: ReactNode; titleExtra?: ReactNode; sub?: ReactNode; onClose: () => void; closeLabel: string;
  footer?: ReactNode; returnFocus?: FocusTarget; children: ReactNode;
}) {
  const id = useId();
  const box = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(onClose);
  useFocusReturn(box, titleRef, returnFocus);
  return (
    <aside className="mdl-drawer" role="dialog" aria-labelledby={id} ref={box}>
      <div className="mdl-dh">
        <div>
          <div className="t" ref={titleRef} tabIndex={-1}><span className="nm" id={id}>{title}</span>{titleExtra}</div>
          {sub && <div className="s">{sub}</div>}
        </div>
        <button type="button" className="mdl-x" aria-label={closeLabel} onClick={onClose}>✕</button>
      </div>
      <div className="mdl-db">{children}</div>
      {footer && <div className="mdl-df">{footer}</div>}
    </aside>
  );
}

/** 当前打开的模态，按打开顺序；只有最上面那个环绕 Tab。 */
const modalStack: RefObject<HTMLElement | null>[] = [];

/**
 * 模态弹窗（挑选器）：带遮罩，点遮罩 = 取消。
 *
 * 🔴 Tab 必须在框内环绕：`aria-modal="true"` 只影响读屏的虚拟光标，**拦不住 Tab** —— 不环绕的话
 * 焦点会走到遮罩后面的来源表 / 模型表上，键盘用户可能在一个看不见的下拉框上改掉默认模型
 * （同一个坑 `inspection/ui.tsx::useOverlay` 早就修过一次）。
 */
export function Modal({ title, sub, onClose, closeLabel, footer, returnFocus, children }: {
  title: ReactNode; sub?: ReactNode; onClose: () => void; closeLabel: string; footer?: ReactNode;
  returnFocus?: FocusTarget; children: ReactNode;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(onClose);
  useFocusReturn(box, titleRef, returnFocus);
  useEffect(() => {
    modalStack.push(box);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || modalStack[modalStack.length - 1] !== box || !box.current) return;
      // 不按可见性过滤（offsetParent 在 jsdom 里恒为 null）：框里没有 display:none 的可聚焦元素。
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute("aria-hidden") !== "true");
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = Boolean(active && box.current.contains(active));
      const i = active ? items.indexOf(active) : -1;
      if (e.shiftKey) {
        // 第一个往前、或停在标题（tabIndex=-1，不在列表里）往前 → 最后一个
        if (!inside || i <= 0) { e.preventDefault(); last.focus(); }
      } else if (!inside || i === items.length - 1) {
        e.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const k = modalStack.indexOf(box);
      if (k >= 0) modalStack.splice(k, 1);
    };
  }, []);
  return (
    <>
      <div className="mdl-scrim" onClick={onClose} aria-hidden />
      <div className="mdl-modal" role="dialog" aria-modal="true" aria-labelledby={id} ref={box}>
        <div className="mdl-mh">
          <div>
            <div className="t" id={id} ref={titleRef} tabIndex={-1}>{title}</div>
            {sub && <div className="s">{sub}</div>}
          </div>
          <button type="button" className="mdl-x" aria-label={closeLabel} onClick={onClose}>✕</button>
        </div>
        <div className="mdl-mb">{children}</div>
        {footer && <div className="mdl-mf">{footer}</div>}
      </div>
    </>
  );
}

/** 非模态的小浮层（删除确认）占一层 Esc。 */
export function Popover({ className, style, label, onEscape, children }: {
  className: string; style?: CSSProperties; label: string; onEscape: () => void; children: ReactNode;
}) {
  useEscapeLayer(onEscape);
  return (
    <div className={className} style={style} role="dialog" aria-label={label} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

export function Tag({ kind, title, children }: { kind: string; title?: string; children: ReactNode }) {
  return <span className={`mdl-tag ${kind}`} title={title}>{children}</span>;
}

export function Btn({ className = "", ...rest }: ComponentProps<"button">) {
  return <button type="button" className={`mdl-btn ${className}`.trim()} {...rest} />;
}

/** 原生 select + 统一外观（▾ 由 CSS 画）。 */
export function Select({ className = "", ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <span className="mdl-selw"><select className={`mdl-select ${className}`.trim()} {...rest} /></span>;
}

/** 开关。点击不冒泡（行本身点击会开抽屉）。 */
export function Switch({ on, label, onChange, disabled }: {
  on: boolean; label: string; onChange: (v: boolean) => void; disabled?: boolean;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      className={`mdl-sw${on ? " on" : ""}`}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }} />
  );
}

/** ⓘ：悬停 / 聚焦 / 点击打开，Esc 与外部点击关闭。说明文字只在这里出现，页面上不铺段落。
 *  显示着就占一层 Esc —— 悬停弹出时焦点不在 ⓘ 上也能用 Esc 关（WCAG 1.4.13）。 */
export function InfoTip({ text, title, label, side = "up", align = "center", defaultOpen = false }: {
  text: ReactNode; title?: ReactNode; label: string; side?: "up" | "down"; align?: "start" | "center" | "end";
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [peek, setPeek] = useState(false);
  const shown = open || peek;
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  // 贴着视口边的 ⓘ（保存条最右、窄屏）：提示框整体往里挪，箭头反向挪回去，仍然指着 ⓘ。
  useLayoutEffect(() => {
    const el = tip.current;
    if (!shown || !el) return;
    el.style.setProperty("--mdl-tip-dx", "0px");
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth || window.innerWidth;
    let dx = 0;
    if (r.right > vw - 8) dx = vw - 8 - r.right;
    if (r.left + dx < 8) dx = 8 - r.left;
    if (dx) el.style.setProperty("--mdl-tip-dx", `${Math.round(dx)}px`);
  });
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", f);
    return () => document.removeEventListener("mousedown", f);
  }, [open]);
  return (
    <span className="mdl-tipw" ref={wrap} onMouseEnter={() => setPeek(true)} onMouseLeave={() => setPeek(false)}
      onClick={(e) => e.stopPropagation()}>
      <button type="button" className="mdl-i" aria-label={label} aria-expanded={open}
        aria-describedby={shown ? id : undefined}
        onClick={() => setOpen((o) => !o)} onFocus={() => setPeek(true)} onBlur={() => setPeek(false)}>
        ⓘ
      </button>
      {shown && (
        <span role="tooltip" id={id} ref={tip} className={`mdl-tip ${side} ${align}`}>
          {title && <b>{title}</b>}{text}
        </span>
      )}
      {shown && <EscLayer onEscape={() => { setOpen(false); setPeek(false); }} />}
    </span>
  );
}

export interface MenuItem {
  key: string; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; sepBefore?: boolean;
  /** 禁用原因：作为菜单项里**可见**的第二行小字，并经 aria-describedby 读出（不只放在 title 里）。 */
  hint?: string;
}

/**
 * 弹出菜单本体。挂载即把焦点放到第一个可用项；↑ / ↓ / Home / End 移动；Esc（经 escStack，只关最上层）、
 * 外部点击、Tab 离开都会关闭并把焦点还给触发按钮。
 * 选中某项：**先**把焦点还给触发按钮、关菜单，**再**执行动作 —— 动作若打开抽屉 / 挑选器，
 * 它们关闭后焦点也会回到这里，而不是掉到 <body>。
 * 禁用项按 WAI-ARIA APG 的菜单模式处理：`aria-disabled`、仍可聚焦（方向键不跳过它），点击不执行；
 * 原因写在它自己的第二行，键盘 / 读屏用户和鼠标用户看到的是同一句。
 */
function MenuList({ label, items, trigger, onClose, className, style }: {
  label: string; items: MenuItem[]; trigger: RefObject<HTMLButtonElement | null>; onClose: () => void;
  className: string; style?: CSSProperties;
}) {
  const uid = useId();
  const box = useRef<HTMLDivElement>(null);
  // onClose 每次渲染都是新函数；放进 ref，免得菜单开着时每渲染一次就重跑 effect、把焦点抢回第一项。
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  useEscapeLayer(() => { closeRef.current(); trigger.current?.focus(); });
  useEffect(() => {
    const f = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!trigger.current?.contains(n) && !box.current?.contains(n)) closeRef.current();
    };
    document.addEventListener("mousedown", f);
    const all = box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    (box.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])') || all?.[0])?.focus();
    return () => document.removeEventListener("mousedown", f);
  }, [trigger]);
  const move = (e: ReactKeyboardEvent) => {
    const list = Array.from(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || []);
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    if (e.key === "Home") { e.preventDefault(); list[0]?.focus(); }
    if (e.key === "End") { e.preventDefault(); list[list.length - 1]?.focus(); }
    // Tab 离开：焦点先回触发按钮、菜单同步卸载，浏览器的 Tab 再从触发按钮往后走（不会落进正在消失的菜单）。
    if (e.key === "Tab") { trigger.current?.focus(); flushSync(() => closeRef.current()); }
  };
  return (
    <div ref={box} role="menu" aria-label={label} className={`mdl-menu ${className}`} style={style} onKeyDown={move}
      onClick={(e) => e.stopPropagation()}>
      {items.map((it) => {
        const lid = `${uid}-${it.key}-l`, hid = `${uid}-${it.key}-h`;
        return (
          <div key={it.key}>
            {it.sepBefore && <div className="mdl-sep" />}
            <button type="button" role="menuitem" className={`mdl-mi${it.danger ? " red" : ""}${it.hint ? " has-hint" : ""}`}
              aria-disabled={it.disabled || undefined} aria-labelledby={lid} aria-describedby={it.hint ? hid : undefined}
              onClick={() => {
                if (it.disabled) return;
                trigger.current?.focus(); closeRef.current(); it.onSelect();
              }}>
              <span id={lid}>{it.label}</span>
              {it.hint && <span id={hid} className="sub">{it.hint}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** 行末的 ⋯ 菜单 —— **常驻**（每行都显示，不是悬停才出现）。受控：哪一行开着由调用方决定。
 *  靠近视口底部（会被保存条盖住）时向上展开。`id` 给调用方还焦点用（删除浮层取消后、抽屉关闭后）。 */
export function RowMenu({ id, label, items, open, onToggle, onClose, extra }: {
  id?: string; label: string; items: MenuItem[]; open: boolean; onToggle: () => void; onClose: () => void;
  /** 菜单位置上替代菜单显示的东西（删除确认浮层）。 */
  extra?: (dir: "up" | "down") => ReactNode;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [dir, setDir] = useState<"up" | "down">("down");
  const ex = extra?.(dir);
  return (
    <>
      <button type="button" id={id} ref={btn} className={`mdl-more${open || ex ? " on" : ""}`} aria-label={label}
        aria-haspopup="menu" aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          const r = btn.current?.getBoundingClientRect();
          setDir(r && r.bottom + 230 > window.innerHeight - 64 ? "up" : "down");
          onToggle();
        }}>⋯</button>
      {open && <MenuList label={label} items={items} trigger={btn} onClose={onClose} className={dir} />}
      {ex}
    </>
  );
}

/** 普通按钮 + 下拉菜单（「+ 添加模型 ▾」）。与 ⋯ 菜单同一套键盘与 Esc 规矩。 */
export function MenuButton({ id, className, label, items, menuStyle, disabled, children }: {
  id?: string; className?: string; label: string; items: MenuItem[]; menuStyle?: CSSProperties; disabled?: boolean;
  children: ReactNode;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Btn id={id} ref={btn} className={className} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        onClick={() => setOpen((o) => !o)}>{children}</Btn>
      {open && !disabled && <MenuList label={label} items={items} trigger={btn} onClose={() => setOpen(false)} className="down"
        style={menuStyle} />}
    </>
  );
}
