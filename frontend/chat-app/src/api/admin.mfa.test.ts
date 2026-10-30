/**
 * api/admin.ts：BFF 以 403 mfa_required 拒绝管理请求时广播 MFA_REQUIRED_EVENT（ChatApp 据此弹出设置框），
 * 并照常抛错；别的 403 不广播。
 *
 * 运行：cd frontend/chat-app && npx vitest run src/api/admin.mfa.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({ status: 403, body: { error: "mfa_required" } as Record<string, unknown> }));
vi.mock("./chat", () => ({
  signedClient: async () => ({
    base: "https://bff.example",
    idToken: "tok",
    aws: { fetch: async () => new Response(JSON.stringify(state.body), { status: state.status }) },
  }),
}));

import { fetchUsers, resetUserMfa } from "./admin";
import { MFA_REQUIRED_EVENT } from "./mfa";

beforeEach(() => { state.status = 403; state.body = { error: "mfa_required" }; });

describe("管理请求被两步验证门禁拒绝", () => {
  it("广播事件，并照常抛错", async () => {
    const seen = vi.fn();
    window.addEventListener(MFA_REQUIRED_EVENT, seen);
    await expect(fetchUsers()).rejects.toThrow("mfa_required");
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener(MFA_REQUIRED_EVENT, seen);
  });

  it("别的 403（没有管理权限）不广播", async () => {
    state.body = { error: "forbidden", required: "nav:admin" };
    const seen = vi.fn();
    window.addEventListener(MFA_REQUIRED_EVENT, seen);
    await expect(fetchUsers()).rejects.toThrow("forbidden");
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener(MFA_REQUIRED_EVENT, seen);
  });

  it("重置走 DELETE /admin/users/{u}/mfa", async () => {
    state.status = 200; state.body = { ok: true, signedOut: true };
    await expect(resetUserMfa("bob")).resolves.toEqual({ ok: true, signedOut: true });
  });
});
