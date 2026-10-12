/**
 * 运行配置加载:生产构建里拉不到 /config.json 要报错,不许静默回退到打包机器上的 .env(2026-10-11)。
 *
 * 回退值来自打包那台机器上被 git 忽略的 .env.local —— 曾经把一套早已删掉的旧环境的 BFF 地址和
 * 用户池 ID 烘进过发布包与现网 bundle。只有本地开发(`vite dev`,DEV=true)才允许回退。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

async function freshConfigModule() {
  vi.resetModules(); // config.ts 把结果缓存在模块级变量里,每条测试都要一份新的
  return import("./config");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("loadConfig", () => {
  it("uses /config.json when it loads", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ chatApiBase: "https://bff.example", cognitoUserPoolId: "p", cognitoClientId: "c",
                           cognitoIdentityPoolId: "i", region: "us-east-1" }),
    })));
    const { loadConfig } = await freshConfigModule();
    await expect(loadConfig()).resolves.toMatchObject({ chatApiBase: "https://bff.example" });
  });

  it("throws in a production build when /config.json is missing, instead of using baked-in values", async () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_CHAT_API_BASE", "https://stale-env.example");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const { loadConfig, getConfig } = await freshConfigModule();
    await expect(loadConfig()).rejects.toThrow(/config\.json.*HTTP 404/);
    expect(() => getConfig()).toThrow(); // 没有偷偷存下一份回退配置
  });

  it("throws in a production build when the fetch itself fails", async () => {
    vi.stubEnv("DEV", false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    const { loadConfig } = await freshConfigModule();
    await expect(loadConfig()).rejects.toThrow(/config\.json.*TypeError/);
  });

  it("still falls back to .env in local dev", async () => {
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_CHAT_API_BASE", "http://localhost:8787");
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    const { loadConfig } = await freshConfigModule();
    await expect(loadConfig()).resolves.toMatchObject({ chatApiBase: "http://localhost:8787" });
  });
});
