/**
 * 左侧导航的顺序、「更多」折叠组与门禁契约。
 *
 * 为什么值得一份测试：这一栏是**整个产品的唯一导航**，而它出问题的方式全是「不报错」——
 *   · 2026-10-10 用户要求：一级只留 通知 / 调查 / 成本 / 案例，「巡检 / 技能 / 管理」收进「更多」。
 *     （2026-09-11 曾反过来把「管理」提到一级 —— admin 每天要点、新 admin 找不到；这次收回来，
 *     靠「当前页在组里就自动展开」+「展开态记住」兜住"找不到"。两条都在下面钉着。）
 *   · 「更多」里一项都没有时还渲染按钮 → 用户点开是个空盒子；
 *   · 「定制」露出来 → 点开是个还没实现的空壳页；
 *   · 门禁写错方向（`showAdmin` 默认 true）→ 非 admin 看到管理入口，点进去才 403；
 *   · 「安全」被补回导航 → 看起来像"顺手补全 prop"，实际是让一个已经退役的聊天主题
 *     在导航里复活（2026-09-11 产品要求去掉；看板改从「调查」的「安全态势」胶囊进）。
 *
 * 这里刻意**渲染**组件而不是 grep 源码：源码断言在重构（比如把 nav 抽成数组）后会
 * 恒真恒假两头落空，而"用户看不看得见这个按钮、它排第几"是行为，重构不该改变它。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/Sidebar.nav.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { STRINGS } from "../i18n";
import Sidebar from "./Sidebar";

const zh = (k: string) => STRINGS[k].zh;

/** Sidebar 的必填 props（会话列表相关的全给空，本测试只关心 nav）。 */
const base = {
  conversations: [],
  activeId: null,
  onSelect: vi.fn(),
  onNew: vi.fn(),
  onRename: vi.fn(),
  onTogglePin: vi.fn(),
  onDelete: vi.fn(),
  collapsed: false,
  onToggle: vi.fn(),
  username: "tester",
  onSignOut: vi.fn(),
};

/** 「更多」里能有的三项全开（巡检 / 管理默认是关的门禁）。 */
const allMore = { showInspection: true, showSkills: true, showAdmin: true };

/** `.sb-nav` 里的一级按钮文字（按 DOM 顺序）—— 子菜单项带 `subitem` 类，不算一级。 */
function navLabels(): string[] {
  const nav = document.querySelector(".sb-nav")!;
  return [...nav.querySelectorAll("button.navitem")]
    .filter((b) => !b.className.includes("subitem"))
    .map((b) => (b.textContent || "").trim());
}
/** 「更多」子菜单里的按钮文字（按 DOM 顺序）；没展开 / 没渲染时是空数组。 */
const subLabels = () =>
  [...document.querySelectorAll(".sb-submenu button.navitem.subitem")].map((b) => (b.textContent || "").trim());
const moreBtn = () =>
  [...document.querySelectorAll(".sb-nav button.navitem")].find((b) => (b.textContent || "").trim() === zh("nav.more"));

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe("左侧导航：一级只有四个高频入口，其余收进「更多」", () => {
  it("一级顺序：通知 → 调查 → 成本 → 案例 → 更多；巡检 / 技能 / 管理不在一级", () => {
    render(<Sidebar {...base} {...allMore} />);
    expect(navLabels()).toEqual([
      zh("topic.notifications"), zh("topic.investigate"), zh("topic.cost"), zh("topic.cases"), zh("nav.more"),
    ]);
  });

  it("「更多」里的顺序：巡检 → 技能 → 管理", () => {
    render(<Sidebar {...base} {...allMore} />);
    fireEvent.click(moreBtn()!);
    expect(subLabels()).toEqual([zh("insp.title"), zh("cz.nav.skills"), zh("nav.admin")]);
  });

  it("默认收起；点开 / 再点收起，aria-expanded 跟着变", () => {
    render(<Sidebar {...base} {...allMore} />);
    const btn = moreBtn()!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".sb-submenu")).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(btn.getAttribute("aria-controls")!)).not.toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".sb-submenu")).toBeNull();
  });

  it("展开态记住：展开一次，刷新（重新挂载）后仍是展开的", () => {
    render(<Sidebar {...base} {...allMore} />);
    fireEvent.click(moreBtn()!);
    cleanup();
    render(<Sidebar {...base} {...allMore} />);
    expect(subLabels()).toContain(zh("nav.admin"));
  });

  it.each([
    ["巡检", { inspectionActive: true }, "insp.title"],
    ["技能", { skillsActive: true }, "cz.nav.skills"],
    ["管理", { adminActive: true }, "nav.admin"],
  ])("当前页是「%s」→ 自动展开（不然站在这页上，导航里却看不见它）", (_n, active, key) => {
    render(<Sidebar {...base} {...allMore} {...active} />);
    expect(moreBtn()!.getAttribute("aria-expanded")).toBe("true");
    const item = screen.getByText(zh(key)).closest("button")!;
    expect(item.className).toContain("subitem");
    expect(item.className).toContain("active");
  });

  it("没权限的页面不触发自动展开（被弹回聊天页的那一瞬间也不行）", () => {
    // 无 nav:skills 的人点了别处的「管理 Skills」→ ChatApp 先置 skillsActive，再把他弹回来。
    render(<Sidebar {...base} showSkills={false} showInspection skillsActive />);
    expect(moreBtn()!.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("notiops.moreOpen")).toBeNull();
  });

  it("自动展开不覆盖用户的选择：在组内页面上手动收起后，它保持收起", () => {
    render(<Sidebar {...base} {...allMore} skillsActive />);
    fireEvent.click(moreBtn()!);              // 用户收起
    expect(document.querySelector(".sb-submenu")).toBeNull();
  });

  it("门禁逐项生效：没权限的那项不在子菜单里", () => {
    render(<Sidebar {...base} showSkills showInspection={false} showAdmin={false} />);
    fireEvent.click(moreBtn()!);
    expect(subLabels()).toEqual([zh("cz.nav.skills")]);
  });

  it("三项都没有权限 → 连「更多」按钮都不渲染（点开是空盒子比没有更糟）", () => {
    render(<Sidebar {...base} showSkills={false} />);   // 巡检 / 管理默认就是关的
    expect(navLabels()).not.toContain(zh("nav.more"));
    expect(document.querySelector(".sb-submenu")).toBeNull();
  });

  it("「定制」任何情况下都不出现（页面还没内容；SHOW_CUSTOMIZE_ITEM 关着）", () => {
    render(<Sidebar {...base} {...allMore} showCustomize customizeActive />);
    fireEvent.click(moreBtn()!);
    expect(screen.queryByText(zh("nav.customize"))).toBeNull();
  });

  it("非 admin 看不到「管理」（门禁默认关），展开「更多」也没有", () => {
    // showAdmin 不传 —— 默认 false。默认 true 会让能力还没加载完那一瞬间对所有人闪出来。
    render(<Sidebar {...base} />);
    fireEvent.click(moreBtn()!);              // 默认还有「技能」，所以「更多」是在的
    expect(subLabels()).not.toContain(zh("nav.admin"));
    expect(navLabels()).not.toContain(zh("nav.admin"));
  });

  it("点「管理」会调 onAdmin，激活时带 active 类", () => {
    const onAdmin = vi.fn();
    render(<Sidebar {...base} showAdmin onAdmin={onAdmin} adminActive />);
    const btn = screen.getByText(zh("nav.admin")).closest("button")!;
    expect(btn.className).toContain("active");
    btn.click();
    expect(onAdmin).toHaveBeenCalledTimes(1);
  });

  // 2026-09-11：侧栏去掉「安全」。为什么钉一条测试：安全**看板**还在（只是入口挪到了
  // 「调查」输入框上方的「安全态势」胶囊），所以随手给 Sidebar 补回一个 `showSecurity`
  // 看起来像"顺手补全"、完全不会报错，界面上却又冒出一个同名入口 —— 客户会以为
  // 「安全」仍是个独立的聊天主题（它已经不是了，TOPICS 里没有它）。
  it("侧栏没有「安全」这一项 —— 一级、「更多」里都没有", () => {
    // 把所有门禁全开（能开的都传 true）：如果哪天有人把安全入口挂在别的开关下面，
    // 这条也能抓到。
    render(<Sidebar {...base} showAdmin showInspection showCustomize showFinops showCases
      showNotifications showInvestigation showSkills />);
    fireEvent.click(moreBtn()!);
    expect(navLabels()).not.toContain(zh("topic.security"));
    expect(subLabels()).not.toContain(zh("topic.security"));
    // 整个侧栏里（不只 .sb-nav）都不该出现「安全」二字：会话分组标题同源于 TOPICS，
    // 那里也不该再有安全分组。
    expect(screen.queryByText(zh("topic.security"))).toBeNull();
  });

  it("Skills 那一项中文显示「技能」、英文显示 Skills（导航标签本地化，功能名不动）", () => {
    // 2026-09-11 产品决定：这一栏是**导航标签**，兄弟全是中文（连接器 / 插件 / 通知 /
    // 调查 / 成本 / 案例 / 巡检 / 更多），夹一个英文词是这一列唯一的异类。
    // 这条同时钉住反向：产品**功能名**仍叫 Skill / Skills，不许顺手一起译过去 ——
    // 「新建 Skill」「管理 Skills」「/」菜单表头都保持原文，否则客户会以为
    // 「技能」和「Skills」是两个不同的东西。
    expect(STRINGS["cz.nav.skills"].zh).toBe("技能");
    expect(STRINGS["cz.nav.skills"].en).toBe("Skills");
    expect(STRINGS["cz.skills.new"].zh).toContain("Skill");
    expect(STRINGS["cmd.skills.manage"].zh).toContain("Skills");
    // 侧栏里真的渲染出来的就是「技能」（不是只改了表、组件读的是别的 key）—— 现在在「更多」里。
    render(<Sidebar {...base} />);
    fireEvent.click(moreBtn()!);
    expect(subLabels()).toContain("技能");
  });
});
