/**
 * 左下角菜单的「两步验证」一项（2026-10-29，用户批准的方案：菜单加这一项）。
 * UserMenu.footer.test.tsx 钉的「只有 外观 / 语言 / 退出登录」仍然成立 —— 那是用户池「关闭」两步验证
 * （或读不到档位）时的样子；这里钉另一半：「可选 / 强制」档时恰好多这一项、位置在退出登录之前。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/UserMenu.mfa.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { STRINGS } from "../i18n";
import UserMenu from "./UserMenu";

const zh = (k: string) => STRINGS[k].zh;
const items = () => Array.from(document.querySelectorAll(".usermenu .um-item")).map((el) => (el.textContent || "").trim());
const open = () => fireEvent.click(document.querySelector("button.sb-foot")!);

beforeEach(() => { cleanup(); localStorage.clear(); });

describe("菜单里的「两步验证」", () => {
  for (const mode of ["OPTIONAL", "REQUIRED"] as const) {
    it(`${mode}：恰好多一项，在退出登录之前；点了调 onTwoFactor 并收起菜单`, () => {
      const onTwoFactor = vi.fn();
      render(<UserMenu username="alice" onSignOut={vi.fn()} mfaMode={mode} onTwoFactor={onTwoFactor} />);
      open();
      expect(items()).toEqual([zh("menu.appearance"), zh("menu.language"), zh("mfa.title"), zh("login.signout")]);
      fireEvent.click(screen.getByText(zh("mfa.title")).closest("button")!);
      expect(onTwoFactor).toHaveBeenCalledTimes(1);
      expect(document.querySelector(".usermenu")).toBeNull();
    });
  }
  for (const mode of ["OFF", null] as const) {
    it(`${mode ?? "读不到"}：不显示`, () => {
      render(<UserMenu username="alice" onSignOut={vi.fn()} mfaMode={mode} onTwoFactor={vi.fn()} />);
      open();
      expect(items()).toEqual([zh("menu.appearance"), zh("menu.language"), zh("login.signout")]);
    });
  }
});
