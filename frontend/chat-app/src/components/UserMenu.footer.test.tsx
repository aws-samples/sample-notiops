/**
 * 左下角用户区的契约：弹出菜单**只有** 外观 / 语言 / 退出登录，底部那一行**只有**
 * 用户名 + 一个「加星」纯图标外链。
 *
 * 2026-09-12（产品要求）：菜单里那三条外链（更新日志 / 了解更多 / 反馈问题）与底部
 * 那个「提 issue」图标一起下线。这份测试因此有两半：
 *
 * ## 一、下线的东西不许复活
 *   · 菜单里再出现任何 `<a>` → 又变回"一个装外链的抽屉"，而客户明确要求只留三项；
 *   · 底部那一行再出现第二个链接 → 「提 issue」以另一种形态回来了；
 *   · 任何指向 `/issues` 的 href → 同上（改个图标 / 改个位置也算复活）。
 * ⚠️ 这一半刻意**不**按 i18n key 定位：`menu.report` / `menu.changelog` /
 *    `menu.learnmore` / `menu.report.hint` 四个键已经删了，`zh("menu.report")` 会
 *    直接 undefined 崩掉 —— 而崩掉不等于"证明它没了"。所以断 DOM 结构与 href。
 *
 * ## 二、留下的那一个仍然要对
 *   · href 写错 → 想加星的人落到别的页；
 *   · 漏掉 `target="_blank"` → 在**当前标签页**跳走，用户正在进行的调查会话没了；
 *   · 漏掉 `rel="noopener"` → 新开的页面拿到 window.opener，能反向导航/伪装本控制台
 *     （reverse tabnabbing）—— 这条纯安全，界面上完全看不出来；
 *   · 给图标补上可见文字 → 侧栏拖窄时先把用户名挤没（所以刻意只有图标）；
 *   · 把它塞进弹出菜单里 → 得先点开菜单才能点，等于没搬出来；
 *   · 把 GitHub 官方 mark「统一」成我们自己那套描边图标 → 画出个空心怪形状，
 *     而且违反 GitHub 的商标条款（不许改形）—— 见 docs/ATTRIBUTION.md。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/UserMenu.footer.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { STRINGS } from "../i18n";
import UserMenu from "./UserMenu";

const zh = (k: string) => STRINGS[k].zh;
/** 公开仓库地址。⚠️ 与 UserMenu.tsx 的 GH_REPO 一致；改了那边这里必须一起改。 */
const REPO = "https://github.com/aws-samples/sample-notiops";

/** 按 aria-label 取那个图标链接 —— 它没有可见文字，只能这么定位。 */
const link = (label: string) => screen.getByLabelText(label) as HTMLAnchorElement;

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe("侧栏底部：用户名 + 加星（只剩这一个链接）", () => {
  it("加星跳仓库主页，且是新标签页 + noopener noreferrer", () => {
    render(<UserMenu username="tester" onSignOut={vi.fn()} />);
    const a = link(zh("menu.star"));
    expect(a.getAttribute("href")).toBe(REPO);
    expect(a.getAttribute("target")).toBe("_blank");
    const rel = a.getAttribute("rel") || "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("URL 上不带任何查询参数（目标页是公开的，别把环境信息带出去）", () => {
    render(<UserMenu username="tester" onSignOut={vi.fn()} />);
    const href = link(zh("menu.star")).getAttribute("href") || "";
    expect(href.includes("?")).toBe(false);
    expect(href.includes("#")).toBe(false);
  });

  it("★★★ 底部那一行只有一个链接 —— 「提 issue」不许以任何形态回来", () => {
    render(<UserMenu username="tester" onSignOut={vi.fn()} />);
    const links = Array.from(document.querySelectorAll(".sb-footrow a"));
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("aria-label")).toBe(zh("menu.star"));
  });

  it("★★★ 整个组件里没有任何指向 /issues 的 href（菜单开着也算）", () => {
    render(<UserMenu username="tester" onSignOut={vi.fn()} />);
    fireEvent.click(document.querySelector("button.sb-foot")!);
    const hrefs = Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href") || "");
    expect(hrefs.some((h) => h.includes("/issues"))).toBe(false);
  });

  it("只有图标、没有可见文字，用户名那一格照旧完整渲染", () => {
    render(<UserMenu username="a-very-long-user-name" onSignOut={vi.fn()} />);
    expect(link(zh("menu.star")).textContent).toBe("");
    expect(document.querySelector(".sb-foot .um-name")!.textContent).toBe("a-very-long-user-name");
  });

  it("它在底部一行里，不在弹出菜单里 —— 菜单关着就能点", () => {
    render(<UserMenu username="tester" onSignOut={vi.fn()} />);
    expect(document.querySelector(".usermenu")).toBeNull();  // 菜单默认关着
    const a = link(zh("menu.star"));
    expect(a.closest(".usermenu")).toBeNull();
    expect(a.closest(".sb-footrow")).not.toBeNull();
  });

  it("加星那个是 GitHub 官方 mark：16 viewBox + 实心填充，不是被改成描边的仿制品", () => {
    render(<UserMenu username="tester" onSignOut={vi.fn()} />);
    const svg = link(zh("menu.star")).querySelector("svg")!;
    // ⚠️ 刻意**不**断言 d 字符串：那等于把 721 字符的第三方数据抄进测试，
    //    升级 octicons 时会红成一片假故障。钉的是「它还是官方那个形状语言」——
    //    官方文件是 16×16 viewBox 且 path 上既无 fill 也无 stroke（实心，nonzero）。
    //    真正的复发方式是有人为了和其余图标"风格统一"，给它套上 base(size)：
    //    那一下 viewBox 会变 24、并被加上 fill="none" + stroke，画出个空心怪形状。
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("stroke")).toBeNull();
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.querySelector("path")!.getAttribute("stroke")).toBeNull();
  });

  it("它是 18px —— 与上面那列主题图标（.navitem .ni-ic）同一档视觉重量", () => {
    render(<UserMenu username="tester" onSignOut={vi.fn()} />);
    const svg = link(zh("menu.star")).querySelector("svg")!;
    // 16px 是改之前的值，客户的原话就是这个"比主题图标轻一档"。
    expect(svg.getAttribute("width")).toBe("18");
    expect(svg.getAttribute("height")).toBe("18");
  });
});

describe("弹出菜单：只有 外观 / 语言 / 退出登录", () => {
  it("用户名入口仍能点开菜单，退出登录还在里面", () => {
    const onSignOut = vi.fn();
    render(<UserMenu username="tester" onSignOut={onSignOut} />);
    expect(screen.queryByText(zh("login.signout"))).toBeNull();
    // 用 fireEvent 而不是裸 `.click()`：裸 click 的 setState 不会被包进 act，
    // 菜单不会重渲染出来，这条就会假 fail 在「找不到退出登录」上。
    fireEvent.click(document.querySelector("button.sb-foot")!);
    fireEvent.click(screen.getByText(zh("login.signout")).closest("button")!);
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("★★★ 菜单里就三项，一项不多（子菜单都收着时）", () => {
    render(<UserMenu username="tester" onSignOut={vi.fn()} />);
    fireEvent.click(document.querySelector("button.sb-foot")!);
    const labels = Array.from(document.querySelectorAll(".usermenu .um-item"))
      .map((el) => (el.textContent || "").trim());
    expect(labels).toEqual([zh("menu.appearance"), zh("menu.language"), zh("login.signout")]);
  });

  it("★★★ 菜单里没有任何外链 —— 三条 GitHub 链接已下线，别当「顺手」加回来", () => {
    render(<UserMenu username="tester" onSignOut={vi.fn()} />);
    fireEvent.click(document.querySelector("button.sb-foot")!);
    expect(document.querySelector(".usermenu")).not.toBeNull();  // 菜单确实开着
    expect(document.querySelectorAll(".usermenu a")).toHaveLength(0);
    const text = document.querySelector(".usermenu")!.textContent || "";
    for (const gone of ["更新日志", "了解更多", "反馈问题"]) expect(text).not.toContain(gone);
  });

  // 2026-09-11：菜单第一项那个从未实现的「设置」占位已下线（点它只弹「即将上线」）。
  // 这条钉住两件事：①菜单里再没有「设置」这一项；②打开菜单不再有任何 alert 占位。
  // 为什么用文字而不是 i18n key：`login.settings` / `menu.soon` 两个键已经删了，
  // `zh("login.settings")` 会直接 undefined 崩掉 —— 而崩掉不等于"证明它没了"。
  it("没有「设置」占位项，也没有 alert 占位", () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<UserMenu username="tester" onSignOut={vi.fn()} />);
    fireEvent.click(document.querySelector("button.sb-foot")!);
    // 菜单确实开着（否则下面的"找不到设置"是假绿）
    expect(screen.queryByText(zh("login.signout"))).not.toBeNull();
    const items = Array.from(document.querySelectorAll(".usermenu .um-item"));
    expect(items.length).toBeGreaterThan(0);
    for (const el of items) expect(el.textContent || "").not.toContain("设置");
    // 剩下的每一项都点一遍：不许再有"点了只弹个提示框"的占位
    for (const el of items) fireEvent.click(el);
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});
