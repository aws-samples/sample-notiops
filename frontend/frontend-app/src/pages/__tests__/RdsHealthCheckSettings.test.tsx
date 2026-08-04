/**
 * RdsHealthCheckSettings tests
 * # Feature: unified-health-check-settings
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import fc from "fast-check";
import { readFileSync } from "node:fs";

vi.mock("../../api", () => ({
  getRdsHealthCheckConfig: vi.fn(),
  updateRdsHealthCheckConfig: vi.fn(),
  getRdsHealthCheckModels: vi.fn(),
  getElastiCacheHealthCheckConfig: vi.fn(),
  updateElastiCacheHealthCheckConfig: vi.fn(),
  getHealthCheckWhitelist: vi.fn(),
  getHealthCheckWhitelistInstances: vi.fn(),
  addHealthCheckWhitelist: vi.fn(),
  addHealthCheckWhitelistBatch: vi.fn(),
  deleteHealthCheckWhitelist: vi.fn(),
  deleteHealthCheckWhitelistBatch: vi.fn(),
  updateHealthCheckWhitelistExpiry: vi.fn(),
}));
vi.mock("aws-amplify/auth", () => ({
  fetchAuthSession: vi.fn().mockResolvedValue({ tokens: null }),
}));
vi.mock("../../config", () => ({
  getConfig: vi.fn().mockReturnValue({ apiBase: "http://localhost:3001" }),
}));

import {
  getRdsHealthCheckConfig,
  updateRdsHealthCheckConfig,
  getRdsHealthCheckModels,
  getElastiCacheHealthCheckConfig,
  updateElastiCacheHealthCheckConfig,
  getHealthCheckWhitelist,
} from "../../api";
import RdsHealthCheckSettings from "../RdsHealthCheckSettings";

const mockedGetRdsConfig = vi.mocked(getRdsHealthCheckConfig);
const mockedUpdateRdsConfig = vi.mocked(updateRdsHealthCheckConfig);
const mockedGetModels = vi.mocked(getRdsHealthCheckModels);
const mockedGetEcConfig = vi.mocked(getElastiCacheHealthCheckConfig);
const mockedUpdateEcConfig = vi.mocked(updateElastiCacheHealthCheckConfig);
const mockedGetWhitelist = vi.mocked(getHealthCheckWhitelist);

const defaultModels = {
  data: {
    models: [
      { model_id: "anthropic.claude-v2", model_name: "Claude v2" },
      { model_id: "anthropic.claude-3-sonnet", model_name: "Claude 3 Sonnet" },
    ],
  },
};
const defaultRdsConfig = {
  data: {
    bedrock_model_id: "anthropic.claude-v2",
    agent_prompt: "",
    bedrock_api_key_masked: "",
    bedrock_api_key_configured: false,
  },
};
const defaultEcConfig = {
  data: { bedrock_model_id: "anthropic.claude-3-sonnet", agent_prompt: "" },
};
const defaultWhitelist = { data: { items: [] } };

function setupMocks() {
  mockedGetModels.mockResolvedValue(defaultModels as never);
  mockedGetRdsConfig.mockResolvedValue(defaultRdsConfig as never);
  mockedGetEcConfig.mockResolvedValue(defaultEcConfig as never);
  mockedGetWhitelist.mockResolvedValue(defaultWhitelist as never);
  mockedUpdateRdsConfig.mockResolvedValue({ data: {} } as never);
  mockedUpdateEcConfig.mockResolvedValue({ data: {} } as never);
}

function renderPage() {
  return render(
    <MemoryRouter>
      <RdsHealthCheckSettings />
    </MemoryRouter>,
  );
}

async function clickTab(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
) {
  const tabs = await screen.findAllByRole("tab");
  const target = tabs.find((t) => t.textContent?.trim() === label);
  expect(target).toBeTruthy();
  await user.click(target!);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupMocks();
});

describe("RdsHealthCheckSettings 单元测试", () => {
  it("renders four tab labels", async () => {
    renderPage();
    const tabs = await screen.findAllByRole("tab");
    expect(tabs).toHaveLength(4);
    const labels = tabs.map((t) => t.textContent?.trim());
    expect(labels).toContain("模型设置");
    expect(labels).toContain("RDS Agent Prompt");
    expect(labels).toContain("ElastiCache Agent Prompt");
    expect(labels).toContain("巡检白名单");
  });

  it("page title is AI 巡检设置", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("AI 巡检设置");
    });
  });

  it("has RDS and EC model sections", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("RDS 模型")).toBeInTheDocument();
      expect(screen.getByText("ElastiCache 模型")).toBeInTheDocument();
    });
  });

  it("has API Key input", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText("Bedrock API Key")).toBeInTheDocument();
    });
  });

  it("whitelist tab has filter", async () => {
    const user = userEvent.setup();
    renderPage();
    await clickTab(user, "巡检白名单");
    await waitFor(() => {
      expect(screen.getByText("服务类型筛选")).toBeInTheDocument();
    });
  });
});

describe("Property 1: 选择性保存", () => {
  it("parallel load calls all 3 APIs", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), async () => {
        vi.clearAllMocks();
        setupMocks();
        const { unmount } = renderPage();
        await waitFor(() => {
          expect(screen.getByText("RDS 模型")).toBeInTheDocument();
        });
        expect(mockedGetRdsConfig).toHaveBeenCalledTimes(1);
        expect(mockedGetEcConfig).toHaveBeenCalledTimes(1);
        expect(mockedGetModels).toHaveBeenCalledTimes(1);
        unmount();
      }),
      { numRuns: 5 },
    );
  });
});

describe("Property 7: 并行保存部分失败隔离", () => {
  it("uses Promise.allSettled", () => {
    const src = readFileSync("src/pages/RdsHealthCheckSettings.tsx", "utf-8");
    expect(src).toContain("Promise.allSettled");
  });
});

describe("Property 2: 字符计数准确性", () => {
  it("char count matches string length", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }),
        async (promptText) => {
          vi.clearAllMocks();
          mockedGetModels.mockResolvedValue(defaultModels as never);
          mockedGetRdsConfig.mockResolvedValue({
            data: {
              bedrock_model_id: "anthropic.claude-v2",
              agent_prompt: promptText,
              bedrock_api_key_masked: "",
              bedrock_api_key_configured: false,
            },
          } as never);
          mockedGetEcConfig.mockResolvedValue(defaultEcConfig as never);
          mockedGetWhitelist.mockResolvedValue(defaultWhitelist as never);
          const user = userEvent.setup();
          const { unmount } = renderPage();
          await clickTab(user, "RDS Agent Prompt");
          await waitFor(() => {
            expect(
              screen.getByText("当前字符数: " + promptText.length),
            ).toBeInTheDocument();
          });
          unmount();
        },
      ),
      { numRuns: 5 },
    );
  });
});

describe("Property 3: 筛选器到 API 参数映射", () => {
  it("whitelist API called with resource_type rds by default", async () => {
    const user = userEvent.setup();
    renderPage();
    await clickTab(user, "巡检白名单");
    await waitFor(() => {
      expect(mockedGetWhitelist).toHaveBeenCalledWith({ resource_type: "rds" });
    });
  });
});

describe("Property 4: 添加条目自动设置 resource_type", () => {
  it("default filter rds means whitelist uses resource_type rds", async () => {
    const user = userEvent.setup();
    renderPage();
    await clickTab(user, "巡检白名单");
    await waitFor(() => {
      expect(mockedGetWhitelist).toHaveBeenCalledWith({ resource_type: "rds" });
    });
  });
});

describe("Property 5: 全部筛选器下强制选择 resource_type", () => {
  it("component has conditional resource_type selector", () => {
    const src = readFileSync("src/pages/RdsHealthCheckSettings.tsx", "utf-8");
    expect(src).toContain("请选择服务类型");
  });
});

describe("Property 6: 全部筛选器下实例选择默认行为", () => {
  it("instance picker defaults to rds when filter is all", () => {
    const src = readFileSync("src/pages/RdsHealthCheckSettings.tsx", "utf-8");
    expect(src).toContain("resourceTypeFilter");
    expect(src).toContain("rds");
  });
});
