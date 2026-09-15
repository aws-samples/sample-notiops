/**
 * 左侧一级导航的顺序与门禁契约。
 *
 * 为什么值得一份测试：这一栏是**整个产品的唯一导航**，而它出问题的方式全是「不报错」——
 *   · 「管理」被挪回折叠菜单 → admin 每天多点一次，新 admin 直接找不到（2026-09-11
 *     之前它就藏在「更多」里，这次提到一级正是因为这个）；
 *   · 「更多」重新露出来 → 用户点开只有一个还没实现的「定制」，是个空盒子；
 *   · 门禁写错方向（`showAdmin` 默认 true）→ 非 admin 看到管理入口，点进去才 403；
 *   · 「安全」被补回一级入口 → 看起来像"顺手补全 prop"，实际是让一个已经退役的聊天主题
 *     在导航里复活（2026-09-11 产品要求去掉；看板改从「调查」的「安全态势」胶囊进）。
 *
 * 这里刻意**渲染**组件而不是 grep 源码：源码断言在重构（比如把 nav 抽成数组）后会
 * 恒真恒假两头落空，而"用户看不看得见这个按钮、它排第几"是行为，重构不该改变它。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/Sidebar.nav.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

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

/** `.sb-nav` 里的一级按钮文字（按 DOM 顺序）—— 子菜单项带 `subitem` 类，不算一级。 */
function navLabels(): string[] {
  const nav = document.querySelector(".sb-nav")!;
  return [...nav.querySelectorAll("button.navitem")]
    .filter((b) => !b.className.includes("subitem"))
    .map((b) => (b.textContent || "").trim());
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
});

describe("左侧一级导航", () => {
  it("「管理」是一级入口，紧跟在 Skills 后面", () => {
    // ⚠️ 别加 showSecurity —— 那条 prop 2026-09-11 已删（见下面那条测试）。
    render(<Sidebar {...base} showAdmin showInspection />);
    const labels = navLabels();
    const skills = labels.findIndex((l) => l === zh("cz.nav.skills"));
    const admin = labels.findIndex((l) => l === zh("nav.admin"));
    expect(skills, "Skills 应当在一级导航里").toBeGreaterThanOrEqual(0);
    expect(admin, "管理应当在一级导航里，而不是子菜单里").toBeGreaterThanOrEqual(0);
    // 「紧跟」= 相邻，不是「在后面某处」—— 中间插东西就等于又把它推远了。
    expect(admin).toBe(skills + 1);
  });

  it("「管理」不在任何折叠子菜单里", () => {
    render(<Sidebar {...base} showAdmin />);
    // 子菜单容器整个不该出现（见下一条）；即便出现，管理也不该在里面。
    const subitems = [...document.querySelectorAll("button.navitem.subitem")]
      .map((b) => (b.textContent || "").trim());
    expect(subitems).not.toContain(zh("nav.admin"));
  });

  it("「更多」整组隐藏 —— 连按钮本身都不渲染", () => {
    // 定制页目前还没有实际功能，一个只有一项空壳的折叠菜单是纯噪音。
    // showCustomize 默认就是 true，所以这一条正是在验 SHOW_MORE_GROUP 那个开关生效。
    render(<Sidebar {...base} showAdmin showCustomize />);
    expect(navLabels()).not.toContain(zh("nav.more"));
    expect(screen.queryByText(zh("nav.customize"))).toBeNull();
    expect(document.querySelector(".sb-submenu")).toBeNull();
  });

  it("非 admin 看不到「管理」（门禁默认关）", () => {
    // showAdmin 不传 —— 默认 false。默认 true 会让能力还没加载完那一瞬间对所有人闪出来。
    render(<Sidebar {...base} />);
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
  // 看起来像"顺手补全"、完全不会报错，界面上却又冒出一个同名一级入口 —— 客户会以为
  // 「安全」仍是个独立的聊天主题（它已经不是了，TOPICS 里没有它）。
  it("侧栏没有「安全」这一项 —— 连 prop 都不该存在", () => {
    // 把所有门禁全开（能开的都传 true）：如果哪天有人把安全入口挂在别的开关下面，
    // 这条也能抓到。
    render(<Sidebar {...base} showAdmin showInspection showCustomize showFinops showCases
      showNotifications showInvestigation showSkills />);
    expect(navLabels()).not.toContain(zh("topic.security"));
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
    // 侧栏里真的渲染出来的就是「技能」（不是只改了表、组件读的是别的 key）。
    render(<Sidebar {...base} />);
    expect(navLabels()).toContain("技能");
  });
});
