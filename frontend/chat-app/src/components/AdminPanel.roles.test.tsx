/**
 * 管理 → 角色 → 「新建角色」的契约。
 *
 * 为什么值得一份测试：客户实测报的是「点了以后没有反应，无法创建」。根因不是按钮没接线，
 * 而是**每一种失败都写进了一个当时没有渲染的状态**：`err` 只出现在右侧权限树里，而右侧
 * 只在选中了某个角色时才存在 —— 刚进这一页什么都没选，于是空名字（静默 return）、
 * 中文名（后端 400 invalid_role_name）、重名，三条路径在界面上一模一样：什么都不发生。
 *
 * 还钉住一条更贵的：`POST /admin/roles` 是 upsert。拿一个**已存在**的角色名去「新建」，
 * 后端会把那个角色的权限清空（预置角色则被一条空权限的 DDB 记录盖掉，因为 authz 解析
 * DDB 优先于内存 PRESET_ROLES）。界面上只表现为"没建出来"，实际是一次静默的权限回收 ——
 * 所以重名必须在**前端**就拦住，不能只靠"客户不会那么做"。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/components/AdminPanel.roles.test.tsx
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import { STRINGS } from "../i18n";

/** 后端已有的角色：一个预置 + 一个自建。 */
const ROLES = [
  { name: "role:admin", permissions: ["*"], preset: true },
  { name: "role:viewer", permissions: ["nav:investigate"], preset: true },
  { name: "sre-oncall", permissions: [] },
];

const saveSpy = vi.fn(async (_name: string, _perms: string[]) => ({ name: _name, permissions: _perms }));

vi.mock("../api/admin", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/admin")>();
  return {
    ...actual,
    fetchAllCapabilities: vi.fn(async () => []),
    fetchRoles: vi.fn(async () => ROLES),
    saveRole: (name: string, perms: string[]) => saveSpy(name, perms),
    fetchNotificationConfig: vi.fn(async () => ({
      feishu: { app_id: "", app_secret: "", verification_token: "", encrypt_key: "", notify_chat_ids: "" },
    })),
  };
});

import AdminPanel from "./AdminPanel";

const zh = (k: string) => STRINGS[k].zh;

/** 角色页是默认 tab，渲染完等角色列表到位即可。 */
async function openRoles() {
  render(<AdminPanel />);
  await waitFor(() => expect(screen.getByText("sre-oncall")).toBeTruthy());
}
const nameInput = () => screen.getByPlaceholderText(zh("admin.roles.name")) as HTMLInputElement;
const newBtn = () => Array.from(document.querySelectorAll("button"))
  .find((b) => b.textContent === zh("admin.roles.new")) as HTMLButtonElement;

beforeEach(() => {
  cleanup();
  saveSpy.mockClear();
  localStorage.clear();
});

describe("管理 → 角色 → 新建角色", () => {
  it("命名规则在出错**之前**就写在输入框下面（不是等失败了才说）", async () => {
    await openRoles();
    expect(screen.getByText(zh("admin.roles.nameRule"))).toBeTruthy();
  });

  it("名字留空点新建 → 给出提示，而不是静默什么都不做", async () => {
    await openRoles();
    fireEvent.click(newBtn());
    await waitFor(() => expect(screen.getByText(zh("admin.roles.err.empty"))).toBeTruthy());
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("中文名 / 带空格 / 单个字符 → 前端就说清原因，不发请求", async () => {
    await openRoles();
    for (const bad of ["运维值班", "sre oncall", "a", "ops/lead"]) {
      fireEvent.change(nameInput(), { target: { value: bad } });
      fireEvent.click(newBtn());
      await waitFor(() => expect(screen.getByText(zh("admin.roles.err.name"))).toBeTruthy());
    }
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("重名 → 拦住并选中已有角色，绝不发出会清空它权限的那个请求", async () => {
    await openRoles();
    fireEvent.change(nameInput(), { target: { value: "role:viewer" } });
    fireEvent.click(newBtn());
    await waitFor(() => expect(
      screen.getByText(zh("admin.roles.err.exists").replace("{name}", zh("admin.role.viewer"))),
    ).toBeTruthy());
    // 最关键的一条：一个 saveRole(name, []) 就等于把 role:viewer 的权限清空了。
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("合法的新名字 → 真的发出创建请求（权限为空），并选中它", async () => {
    await openRoles();
    fireEvent.change(nameInput(), { target: { value: "sre-secondary" } });
    fireEvent.click(newBtn());
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith("sre-secondary", []));
    // 选中后右侧权限树出现（不再是"从左侧选择一个角色"那句占位）
    await waitFor(() => expect(screen.queryByText(zh("admin.roles.pick"))).toBeNull());
    expect(nameInput().value).toBe("");   // 输入框清空 = 创建成功的可见反馈
  });

  it("回车等同于点按钮（客户打完名字第一反应是敲回车）", async () => {
    await openRoles();
    fireEvent.change(nameInput(), { target: { value: "sre-tertiary" } });
    fireEvent.keyDown(nameInput(), { key: "Enter" });
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith("sre-tertiary", []));
  });

  it("改动输入框会清掉上一条错误（否则改对了还挂着旧报错）", async () => {
    await openRoles();
    fireEvent.click(newBtn());
    await waitFor(() => expect(screen.getByText(zh("admin.roles.err.empty"))).toBeTruthy());
    fireEvent.change(nameInput(), { target: { value: "s" } });
    expect(screen.queryByText(zh("admin.roles.err.empty"))).toBeNull();
  });
});
