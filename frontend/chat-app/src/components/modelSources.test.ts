/**
 * 模型来源纯逻辑（modelSources.ts）。规则须与 BFF llm_config.mjs / core/llm_config.py 一致。
 * 运行：cd frontend/chat-app && npx vitest run src/components/modelSources.test.ts
 */
import { describe, it, expect } from "vitest";
import type { LlmModelEntry } from "../api/admin";
import {
  normalizeOrder, moveSource, imSource, inFamily, sourceDefault, resolvedDefaults,
  gatewayAlias, newGatewayEntry, gatewayHost, matchesQuery, GATEWAY_MODEL_ID_RE,
} from "./modelSources";

const E = (alias: string, kind: LlmModelEntry["kind"], enabled = true): LlmModelEntry => ({
  alias, model_id: alias, label: alias, kind, hard_output_limit: 8192,
  supports_prompt_cache: false, surfaces: ["webchat"], enabled,
});

describe("source order", () => {
  it("normalises like the BFF: legacy credential_mode first, unknown and duplicates dropped", () => {
    expect(normalizeOrder(undefined, "api_key")).toEqual(["api_key", "iam", "gateway"]);
    expect(normalizeOrder(undefined, undefined)).toEqual(["iam", "api_key", "gateway"]);
    expect(normalizeOrder(["gateway"], "iam")).toEqual(["gateway", "iam", "api_key"]);
    expect(normalizeOrder(["openai", "iam", "iam"], "gateway")).toEqual(["iam", "api_key", "gateway"]);
  });
  it("moves a source and ignores out-of-range moves", () => {
    expect(moveSource(["iam", "api_key", "gateway"], 2, 0)).toEqual(["gateway", "iam", "api_key"]);
    expect(moveSource(["iam", "api_key", "gateway"], 0, 1)).toEqual(["api_key", "iam", "gateway"]);
    const o = ["iam", "api_key", "gateway"] as const;
    expect(moveSource([...o], 0, -1)).toEqual([...o]);
    expect(moveSource([...o], 2, 3)).toEqual([...o]);
  });
  it("IM uses the first Bedrock source", () => {
    expect(imSource(["gateway", "api_key", "iam"])).toBe("api_key");
    expect(imSource(["gateway", "iam", "api_key"])).toBe("iam");
    expect(imSource(["api_key", "gateway", "iam"])).toBe("api_key");
  });
});

describe("families and defaults", () => {
  const models = [E("kimi", "bedrock_converse"), E("gpt", "bedrock_mantle_responses"),
    E("gw-a", "openai_compatible"), E("gw-off", "openai_compatible", false)];
  it("splits Bedrock and gateway entries", () => {
    expect(models.filter((m) => inFamily(m, "gateway")).map((m) => m.alias)).toEqual(["gw-a", "gw-off"]);
    expect(models.filter((m) => inFamily(m, "iam")).map((m) => m.alias)).toEqual(["kimi", "gpt"]);
  });
  it("a default must be an enabled member of its family, else the family's first enabled", () => {
    expect(sourceDefault(models, "gateway", "gw-a")).toBe("gw-a");
    expect(sourceDefault(models, "gateway", "gw-off")).toBe("gw-a");
    expect(sourceDefault(models, "gateway", "kimi")).toBe("gw-a");
    expect(sourceDefault(models, "iam", "gw-a")).toBe("kimi");
    expect(sourceDefault([E("kimi", "bedrock_converse")], "gateway", "")).toBe("");
  });
  it("resolvedDefaults drops sources with no usable model", () => {
    expect(resolvedDefaults([E("kimi", "bedrock_converse")], { gateway: "gw-a", api_key: "kimi" }))
      .toEqual({ iam: "kimi", api_key: "kimi" });
  });
});

describe("gateway entries", () => {
  it("suggests gw- aliases from the last path segment and avoids collisions", () => {
    const taken = new Set(["gw-claude-opus-4-7"]);
    expect(gatewayAlias("anthropic/claude-opus-4-7", (a) => taken.has(a))).toBe("gw-claude-opus-4-7-2");
    expect(gatewayAlias("Qwen/Qwen3-235B-A22B", () => false)).toBe("gw-qwen3-235b-a22b");
    expect(gatewayAlias("gpt-4o-mini", () => false)).toBe("gw-gpt-4o-mini");
    expect(gatewayAlias("bedrock/global.anthropic.claude-sonnet-4-6", () => false))
      .toBe("gw-global-anthropic-claude-sonnet-4-6");
    expect(/^[a-z0-9][a-z0-9-]{0,63}$/.test(gatewayAlias("x/" + "a".repeat(200), () => false))).toBe(true);
  });
  it("a new gateway entry is web-only, enabled, with the default cap", () => {
    const e = newGatewayEntry("anthropic/claude-opus-4-7", () => false);
    expect(e).toMatchObject({ kind: "openai_compatible", surfaces: ["webchat"], enabled: true,
                              hard_output_limit: 8192, model_id: "anthropic/claude-opus-4-7", region: null });
  });
  it("accepts the model id shapes LiteLLM / New API use, rejects junk", () => {
    for (const ok of ["gpt-4o-mini", "anthropic/claude-opus-4-7", "Qwen/Qwen3-235B-A22B",
      "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0", "models/gemini-2.5-pro", "deepseek-r1@2025+fast"]) {
      expect(GATEWAY_MODEL_ID_RE.test(ok)).toBe(true);
    }
    for (const bad of ["", "a b", "a/../b", "-x", "\"x\"", "x\ny"]) {
      expect(GATEWAY_MODEL_ID_RE.test(bad)).toBe(false);
    }
  });
  it("shows only the host of a gateway URL", () => {
    expect(gatewayHost("https://gw.example.com/v1")).toBe("gw.example.com");
    expect(gatewayHost("https://gw.example.com:8443/api/v1")).toBe("gw.example.com:8443");
    expect(gatewayHost("")).toBe("");
  });
  it("search matches every token", () => {
    expect(matchesQuery("anthropic/claude-opus-4-7", "claude opus")).toBe(true);
    expect(matchesQuery("anthropic/claude-opus-4-7", "claude 5")).toBe(false);
    expect(matchesQuery("anthropic/claude-opus-4-7", "")).toBe(true);
  });
});
