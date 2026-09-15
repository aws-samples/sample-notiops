/**
 * Admin 左导航与 `MULTICLOUD_UI` 的关系 —— 「多云先不对外」这个产品决定的判据。
 *
 * 为什么单独一个文件：`AdminPanel.aliyun.test.tsx` 把开关 mock 成了 `true`（它守的是
 * 「实现还在、翻开就能用」），所以那里读不到**真实**开关值。这份**故意不 mock**
 * `featureFlags`，跟着仓库里那个字面量走：
 *   · 关着 → 「多云」不在左导航里（客户看不到入口）；
 *   · 开着 → 它必须回来（否则 `AliyunView` 成了永远打不开的死代码）。
 *
 * 两个方向都断言，是因为这次改动**故意**造出了「视图代码都在、导航里点不到」这个状态，
 * 而 `AdminPanel.tsx` 里那个 `_navCoversAllTabs` 编译期检查原本正是防它的 —— 检查被
 * 一个运行期 filter 绕过去了，那道防线就得在这里补上。
 *
 * ⚠️ 只断言「多云」这一条。同时断言「其它条还在」是必要的：把整组 filter 写错
 * （比如条件写反、或把 `cloud` 组整组过滤掉）的症状是导航少一大片，而只看多云那条
 * 的用例照样绿。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";

import { STRINGS } from "../i18n";
import { MULTICLOUD_UI } from "../featureFlags";

vi.mock("../api/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/admin")>();
  return { ...actual, fetchAllCapabilities: vi.fn(async () => []) };
});

import AdminPanel from "./AdminPanel";

const zh = (k: string) => STRINGS[k].zh;
const navLabels = () =>
  Array.from(document.querySelectorAll("button.notif-navitem .notif-navlabel"))
    .map((s) => s.textContent || "");

describe("Admin 左导航", () => {
  beforeEach(() => { cleanup(); });

  it("「多云」这一条的可见性跟着 MULTICLOUD_UI", () => {
    render(<AdminPanel />);
    expect(navLabels().includes(zh("admin.tab.aliyun"))).toBe(MULTICLOUD_UI);
  });

  it("其余各条一条都没少（别把整组一起过滤掉了）", () => {
    render(<AdminPanel />);
    const labels = navLabels();
    for (const k of ["roles", "users", "groups", "accounts", "lifecycle",
                     "modules", "notifications", "models"]) {
      expect(labels, k).toContain(zh(`admin.tab.${k}`));
    }
  });
});
