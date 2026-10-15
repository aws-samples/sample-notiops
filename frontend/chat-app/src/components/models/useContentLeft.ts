/**
 * 保存条是 `position: fixed` 的，左边沿要对齐内容栏（`.notif-content`），而不是视口 ——
 * 否则它会盖住管理页左侧的子导航。内容栏的左边沿会随主侧栏收起 / 展开、窗口缩放而变，
 * 所以订阅 resize 与内容栏自身的 ResizeObserver（右边沿固定，左边沿一动宽度就变）。
 *
 * 入参是元素本身（callback ref 存进 state），不是 ref 对象：渲染期读 `ref.current` 会被
 * react-hooks/refs 拦下，而且元素换了也得重新订阅。
 */
import { useCallback, useSyncExternalStore } from "react";

export function useContentLeft(rootEl: HTMLElement | null): number {
  const host = rootEl ? (rootEl.closest(".notif-content") as HTMLElement | null) : null;
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener("resize", cb);
    const ro = host && typeof ResizeObserver !== "undefined" ? new ResizeObserver(cb) : null;
    if (ro && host) ro.observe(host);
    return () => { window.removeEventListener("resize", cb); ro?.disconnect(); };
  }, [host]);
  const snap = useCallback(() => (host ? Math.round(host.getBoundingClientRect().left) : 0), [host]);
  return useSyncExternalStore(subscribe, snap, () => 0);
}
