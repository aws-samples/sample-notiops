/**
 * 模型目录状态机测试。
 *
 * 这套逻辑决定「用户在下拉框里看到什么、能不能发消息」，有 5 个服务端来源分支，且它的
 * 失败模式全是**静默**的 —— 实测踩到的就是：目录拉回来之前下拉框显示一份打包内置的旧清单
 * （看到 8 个模型，落地后变 1 个），那一秒里用户能选中管理员已停用的模型。界面、控制台、
 * BFF 日志都没有痕迹。所以这里逐个分支钉死。
 *
 * 运行：cd frontend/chat-app && npm test
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./config", () => ({
  getConfig: () => ({ chatApiBase: "https://example.test/" }),
}));

const fetchModels = vi.fn();
vi.mock("./api/chat", () => ({ fetchModels: (...a: unknown[]) => fetchModels(...a) }));

import {
  refreshModelCatalog, __resetModelCatalog, modelCatalog, defaultModelId,
  modelCatalogPhase, modelCatalogSource, modelCatalogFromServer, canSendMessage,
  modelDisplayName, isSelectableModel,
} from "./models";
import { MODELS } from "./types";

const DDB_OK = {
  models: [{ id: "claude-opus-4-6-v1", name: "Global Anthropic Claude Opus 4.6" }],
  default_model: "claude-opus-4-6-v1",
  generation: 1786364196889,
  source: "ddb",
};

beforeEach(() => {
  localStorage.clear();
  fetchModels.mockReset();
  __resetModelCatalog();
  vi.useRealTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe("初始状态", () => {
  it("加载中不给任何清单，也不许发消息", () => {
    expect(modelCatalogPhase()).toBe("loading");
    expect(modelCatalog()).toEqual([]);
    expect(canSendMessage()).toBe(false);
  });

  it("绝不把打包内置清单当作初始目录", async () => {
    // 这正是实测事故：`catalog` 的初值是 MODELS，于是加载窗口里显示一份"看起来正式"的
    // 错清单。注意**不能**只断言 __resetModelCatalog() 之后的状态 —— 那个函数自己会把
    // catalog 置空，等于把模块初值掩盖掉（这条断言最初就因此抓不到退回 MODELS 的改动）。
    // 用 resetModules + 全新 import 读真正的模块初始状态。
    vi.resetModules();
    const fresh = await import("./models");
    expect(fresh.modelCatalogPhase()).toBe("loading");
    expect(fresh.modelCatalog()).toEqual([]);
    expect(fresh.canSendMessage()).toBe(false);
  });
});

describe("source=ddb（管理员配置的目录）", () => {
  it("采用服务端目录，允许发消息", async () => {
    fetchModels.mockResolvedValue(DDB_OK);
    await refreshModelCatalog();
    expect(modelCatalogSource()).toBe("ddb");
    expect(modelCatalog().map((m) => m.id)).toEqual(["claude-opus-4-6-v1"]);
    expect(defaultModelId()).toBe("claude-opus-4-6-v1");
    expect(modelCatalogFromServer()).toBe(true);
    expect(canSendMessage()).toBe(true);
  });

  it("目录里没有的 alias 不可选（用于纠正存量会话的旧选择）", async () => {
    fetchModels.mockResolvedValue(DDB_OK);
    await refreshModelCatalog();
    expect(isSelectableModel("claude-opus-4-6-v1")).toBe(true);
    expect(isSelectableModel("claude-sonnet-5")).toBe(false);   // 已被管理员停用
  });

  it("default_model 不在启用集里时落到第一个启用项", async () => {
    fetchModels.mockResolvedValue({ ...DDB_OK, default_model: "gone" });
    await refreshModelCatalog();
    expect(defaultModelId()).toBe("claude-opus-4-6-v1");
  });

  it("管理员没为本端启用任何模型 → 报错而不是偷偷换清单", async () => {
    fetchModels.mockResolvedValue({ models: [], default_model: "", generation: 9, source: "ddb" });
    await refreshModelCatalog();
    expect(modelCatalog()).toEqual([]);          // 不得用 MODELS 顶上
    expect(canSendMessage()).toBe(false);        // 要管理员去改配置
    // 但**不需要模型**的发送路径必须放行。目前是「深度调查（直连）」：BFF 直连
    // DevOps Agent API，全程 0 token、不碰 Bedrock。拿模型目录拦它的话，管理员取消勾选
    // 全部 webchat 模型后，唯一不需要模型的功能反而用不了，提示语还指向无关的配置项。
    expect(canSendMessage({ needsModel: false })).toBe(true);
  });

  it("needsModel:false 在加载中也放行（直连路径不等目录）", async () => {
    // 目录仍在加载时，普通发送要等（避免带着一个不在启用集里的模型发出去），
    // 但直连路径没有这个风险 —— 它不带模型，等它没有意义。
    // 用 resetModules + 全新 import 读真正的模块初始状态（同上一条的理由）。
    vi.resetModules();
    const fresh = await import("./models");
    expect(fresh.modelCatalogPhase()).toBe("loading");
    expect(fresh.canSendMessage()).toBe(false);
    expect(fresh.canSendMessage({ needsModel: false })).toBe(true);
  });
});

describe("服务端明确没有目录 → 内置清单 + 放行", () => {
  for (const source of ["unseeded", "disabled", "read_error"] as const) {
    it(`source=${source}`, async () => {
      fetchModels.mockResolvedValue({ models: [], default_model: "", generation: 0, source });
      await refreshModelCatalog();
      expect(modelCatalogSource()).toBe(source);
      expect(modelCatalog()).toEqual(MODELS);
      // 尤其是 disabled：那是灰度回滚拉杆，若禁发消息就等于一拉拉杆全员发不出消息
      expect(canSendMessage()).toBe(true);
      expect(modelCatalogFromServer()).toBe(false);
    });
  }
});

describe("老版本 BFF（不返回 source）", () => {
  it("缺省当 ddb 处理，行为与改动前一致", async () => {
    // 老 BFF 不返回 source；fetchModels 会把缺省填成 "ddb"（见 api/chat.ts），
    // 所以这里模拟的是"填完缺省之后"的形状。
    fetchModels.mockResolvedValue({
      models: DDB_OK.models, default_model: DDB_OK.default_model,
      generation: DDB_OK.generation, source: "ddb",
    });
    await refreshModelCatalog();
    expect(modelCatalogSource()).toBe("ddb");
    expect(canSendMessage()).toBe(true);
  });
});

describe("请求失败", () => {
  it("保持 loading 且暂不放行（宽限期内）", async () => {
    fetchModels.mockResolvedValue(null);
    await refreshModelCatalog();
    expect(modelCatalogPhase()).toBe("loading");
    expect(canSendMessage()).toBe(false);
  });

  it("宽限期到点后降级放行 —— 拉不到目录不该等于发不出消息", async () => {
    vi.useFakeTimers();
    fetchModels.mockResolvedValue(null);
    await refreshModelCatalog();
    expect(canSendMessage()).toBe(false);
    await vi.advanceTimersByTimeAsync(3100);
    expect(modelCatalogPhase()).toBe("ready");
    expect(modelCatalog()).toEqual(MODELS);
    expect(canSendMessage()).toBe(true);
  });

  it("失败后会重试（此前是一次性的，刷新页面也救不回来）", async () => {
    vi.useFakeTimers();
    fetchModels.mockResolvedValue(null);
    await refreshModelCatalog();
    expect(fetchModels).toHaveBeenCalledTimes(1);
    fetchModels.mockResolvedValue(DDB_OK);
    await vi.advanceTimersByTimeAsync(2100);
    expect(fetchModels).toHaveBeenCalledTimes(2);
    expect(modelCatalogSource()).toBe("ddb");
  });
});

describe("本地缓存", () => {
  it("二次访问直接渲染上次的目录，没有加载窗口", async () => {
    fetchModels.mockResolvedValue(DDB_OK);
    await refreshModelCatalog();                 // 第一次：写缓存

    __resetModelCatalog();                       // 模拟重新打开页面
    expect(modelCatalogPhase()).toBe("loading");
    fetchModels.mockResolvedValue(DDB_OK);
    const p = refreshModelCatalog();             // 同步阶段应已用上缓存
    expect(modelCatalogPhase()).toBe("ready");
    expect(modelCatalogSource()).toBe("cache");
    expect(modelCatalog().map((m) => m.id)).toEqual(["claude-opus-4-6-v1"]);
    expect(canSendMessage()).toBe(true);
    await p;
    expect(modelCatalogSource()).toBe("ddb");    // 校验后转正
  });

  it("缓存的是这个部署的真实目录，不是编译期快照", async () => {
    fetchModels.mockResolvedValue(DDB_OK);
    await refreshModelCatalog();
    __resetModelCatalog();
    fetchModels.mockResolvedValue(null);         // 服务端这次拉不到
    await refreshModelCatalog();
    // 用缓存（1 条真目录），而不是 MODELS（8 条编译期快照）
    expect(modelCatalog().map((m) => m.id)).toEqual(["claude-opus-4-6-v1"]);
  });

  it("空目录不写缓存（否则会把一次错误状态固化下来）", async () => {
    fetchModels.mockResolvedValue({ models: [], default_model: "", generation: 1, source: "ddb" });
    await refreshModelCatalog();
    __resetModelCatalog();
    fetchModels.mockResolvedValue(null);
    await refreshModelCatalog();
    expect(modelCatalog()).toEqual([]);          // 没有被"空目录"缓存污染
  });
});

describe("历史消息落款", () => {
  it("已下架的模型仍显示出正常名字（MODELS 现在唯一的正当用途）", async () => {
    fetchModels.mockResolvedValue(DDB_OK);
    await refreshModelCatalog();
    expect(modelDisplayName("claude-opus-4-6-v1")).toBe("Global Anthropic Claude Opus 4.6");
    // 管理员已把它删出目录，但半年前的消息还引用它
    expect(modelDisplayName("amazon-nova-pro")).toBe("Amazon Nova Pro");
    expect(modelDisplayName("something-unknown")).toBe("something-unknown");
    expect(modelDisplayName()).toBe("");
  });
});
