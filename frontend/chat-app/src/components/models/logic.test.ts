/**
 * 模型页纯逻辑（logic.ts）。规则须与 BFF llm_config.mjs 一致（taskEffective ↔ backendTaskEntry、
 * HARD_FAIL_RESULTS ↔ GATEWAY_HARD_FAIL / HARD_FAIL_PROBE_RESULTS）。
 * 运行：cd frontend/chat-app && npx vitest run src/components/models/logic.test.ts
 */
import { describe, it, expect } from "vitest";
import type { LlmConfig, LlmModelEntry } from "../../api/admin";
import { resolvedDefaults } from "../modelSources";
import {
  TEST_KEY, HARD_FAIL_RESULTS, GATEWAY_HARD_FAIL_RESULTS, resultTone, resultTip, testSummary, testLabel, draftFromConfig, draftSignature, draftChanges,
  summarizeChanges, saveBlockers, blockerText, taskEffective, gatewayUpstreamName, groupByPrefix,
  applyGatewaySelection, appendWithDefault, newBedrockEntry, defaultOf, replacementsFor, sortForTable,
  filterModels, segCounts, surfaceModel, candidateRegion,
} from "./logic";
import { STRINGS } from "../../i18n";

const zh = (k: string) => STRINGS[k]?.zh ?? k;

const BR = (alias: string, over: Partial<LlmModelEntry> = {}): LlmModelEntry => ({
  alias, model_id: `global.${alias}`, label: alias.toUpperCase(), kind: "bedrock_converse", region: null,
  hard_output_limit: 8192, supports_prompt_cache: false, surfaces: ["webchat", "im"], enabled: true, ...over,
});
const GW = (id: string, over: Partial<LlmModelEntry> = {}): LlmModelEntry => ({
  alias: `gw-${id.split("/").pop()}`, model_id: id, label: id, kind: "openai_compatible", region: null,
  hard_output_limit: 8192, supports_prompt_cache: false, surfaces: ["webchat"], enabled: true, ...over,
});
const CFG = (over: Partial<LlmConfig> = {}): LlmConfig => ({
  provider: "bedrock", credential_mode: "iam", source_order: ["iam", "api_key", "gateway"],
  source_defaults: { iam: "kimi" }, default_model: "kimi", generation: 1,
  models: [BR("kimi"), BR("grok"), BR("glm", { enabled: false })], backend_tasks: { phd_translate: null },
  bedrock_api_key: { configured: false }, gateway: { configured: true, base_url: "https://gw.example.com/v1" },
  seeded: true, updated_at: "", updated_by: "", ...over,
});

describe("test results", () => {
  it("upstream_auth has its own label and is a hard failure (never 「凭证无效」)", () => {
    expect(TEST_KEY.upstream_auth).toBe("admin.models.test.upstreamAuth");
    expect(HARD_FAIL_RESULTS.has("upstream_auth")).toBe(true);
    expect(testLabel("upstream_auth", zh)).toBe("网关上游未授权");
    expect(testLabel("upstream_auth", zh)).not.toBe(zh("admin.models.test.unauthorized"));
    expect(STRINGS["admin.models.test.upstreamAuth"].en).toBe("Gateway upstream not authorised");
  });
  it("labels for the common results", () => {
    expect(["ok", "unauthorized", "forbidden", "invalid_model", "no_tools", "throttled", "timeout"]
      .map((r) => testLabel(r, zh))).toEqual(["可用", "凭证无效", "无权限", "模型 ID 无效", "不支持工具调用", "限流", "超时"]);
    expect(testLabel("something_new", zh)).toBe("something_new");
  });
  it("tone: ok / deterministic → err / transient → warn", () => {
    expect(resultTone("ok")).toBe("ok");
    for (const r of ["upstream_auth", "unauthorized", "no_tools", "invalid_model"]) expect(resultTone(r)).toBe("err");
    for (const r of ["throttled", "timeout", "error", "probe_error"]) expect(resultTone(r)).toBe("warn");
  });
  it("gateway tone matches the server: probe_error is a hard failure there (GATEWAY_HARD_FAIL), transient stays amber", () => {
    expect(GATEWAY_HARD_FAIL_RESULTS.has("probe_error")).toBe(true);
    expect(HARD_FAIL_RESULTS.has("probe_error")).toBe(false);
    expect(resultTone("probe_error", true)).toBe("err");
    expect(resultTone("probe_error", false)).toBe("warn");
    for (const r of ["throttled", "timeout", "error"]) expect(resultTone(r, true)).toBe("warn");
    expect(resultTone("upstream_auth", true)).toBe("err");
  });
  it("tooltip: upstream_auth explains the upstream credential, others repeat the label", () => {
    expect(resultTip("upstream_auth", zh)).toBe(zh("admin.models.test.upstreamAuthTip"));
    expect(resultTip("upstream_auth", zh)).not.toContain(zh("admin.models.test.unauthorized"));
    expect(resultTip("throttled", zh)).toBe("限流");
    expect(resultTip(undefined, zh)).toBe("");
  });
  it("every label is a short tag (no sentence), the sentence lives in the tip (U1)", () => {
    const en = (k: string) => STRINGS[k]?.en ?? k;
    const sentence = /[，。,;；（）()]/;
    for (const gw of [false, true]) {
      for (const r of Object.keys(TEST_KEY)) {
        const z = testLabel(r, zh, gw), e = testLabel(r, en, gw);
        expect(z.replace(/\s/g, "").length, `${r} zh「${z}」`).toBeLessThanOrEqual(10);
        expect(z, r).not.toMatch(sentence);
        expect(e.split(/\s+/).length, `${r} en "${e}"`).toBeLessThanOrEqual(4);
        expect(e, r).not.toMatch(sentence);
      }
    }
    for (const r of ["needs_profile", "probe_error", "redirect", "bad_response"]) {
      expect(resultTip(r, zh).length, r).toBeGreaterThan(testLabel(r, zh).length + 10);
    }
    expect(resultTip("needs_profile", zh)).toContain("global.");
  });
  it("gateway probe_error has its own wording: the gateway rejected the request (not 「请反馈」) (U2)", () => {
    expect(testLabel("probe_error", zh, true)).toBe(zh("admin.models.test.gwProbeError"));
    expect(resultTip("probe_error", zh, true)).toBe(zh("admin.models.test.gwProbeErrorTip"));
    expect(resultTip("probe_error", zh, true)).toContain("400/422");
    expect(resultTip("probe_error", zh, true)).not.toContain("反馈");
    // Bedrock 那边的 probe_error 才是「疑似本系统的探测请求有问题」
    expect(resultTip("probe_error", zh, false)).toContain("反馈");
    // 其余结果网关与 Bedrock 同一套说法
    expect(testLabel("upstream_auth", zh, true)).toBe(testLabel("upstream_auth", zh));
  });
  it("test-all summary counts enabled entries only; nothing tested → null", () => {
    const ms = [BR("a"), BR("b"), BR("c", { enabled: false }), GW("anthropic/x")];
    expect(testSummary(ms, {})).toBeNull();
    expect(testSummary(ms, { a: "ok", b: "throttled", c: "ok", "gw-x": "upstream_auth" })).toEqual({ ok: 1, bad: 2 });
  });
});

describe("draft", () => {
  it("A-1: gateway dragged to #1 + 2 gateway models added = 3 changes, no separate default change", () => {
    const cfg = CFG();
    const saved = draftFromConfig(cfg);
    const cur = structuredClone(saved);
    cur.order = ["gateway", "iam", "api_key"];
    let r = appendWithDefault(cur.models, cur.srcDefaults, GW("anthropic/claude-sonnet-5-5"));
    r = appendWithDefault(r.models, r.srcDefaults, GW("bedrock/anthropic.claude-opus-5-5"));
    cur.models = r.models; cur.srcDefaults = r.srcDefaults;
    const ch = draftChanges(saved, cur);
    expect(ch).toHaveLength(3);
    expect(summarizeChanges(ch, zh)).toBe("来源次序 · 新增 2 个网关模型");
    expect(resolvedDefaults(cur.models, cur.srcDefaults).gateway).toBe("gw-claude-sonnet-5-5");
    expect(draftSignature(cur)).not.toBe(draftSignature(saved));
  });
  it("an untouched draft has no changes and the same signature", () => {
    const saved = draftFromConfig(CFG());
    const cur = draftFromConfig(CFG());
    cur.models = cur.models.map((m) => ({ ...m }));
    expect(draftChanges(saved, cur)).toEqual([]);
    expect(draftSignature(cur)).toBe(draftSignature(saved));
  });
  it("counts a changed default, edited / removed entries and tasks", () => {
    const saved = draftFromConfig(CFG());
    const cur = structuredClone(saved);
    cur.srcDefaults.iam = "grok";
    cur.models[1].hard_output_limit = 4096;
    cur.models = cur.models.filter((m) => m.alias !== "glm");
    cur.tasks.phd_translate = "kimi";
    const kinds = draftChanges(saved, cur).map((c) => c.kind).sort();
    expect(kinds).toEqual(["default", "edited", "removed", "task"]);
    expect(summarizeChanges(draftChanges(saved, cur), zh)).toBe("默认模型 · 删除 1 个模型 · 修改 1 个模型 · 后台任务");
  });
  it("disabling the default counts once (as the edit), not again as a default change", () => {
    const saved = draftFromConfig(CFG());
    const cur = structuredClone(saved);
    cur.models[0].enabled = false;
    expect(draftChanges(saved, cur).map((c) => c.kind)).toEqual(["edited"]);
  });
});

describe("saveBlockers — structural only, no test gate", () => {
  const run = (over: Partial<Parameters<typeof saveBlockers>[0]>) => {
    const cfg = CFG();
    const base = { models: cfg.models, order: cfg.source_order, defaults: resolvedDefaults(cfg.models, cfg.source_defaults), cfg };
    return saveBlockers({ ...base, ...over }).map((b) => b.key);
  };
  it("switching to a configured but untested gateway is NOT blocked", () => {
    const models = [...CFG().models, GW("anthropic/claude-opus-4-7")];
    expect(run({ models, order: ["gateway", "iam", "api_key"], defaults: resolvedDefaults(models, {}) })).toEqual([]);
  });
  it("no models / none enabled / no default for the top source", () => {
    expect(run({ models: [] })).toEqual(["admin.models.needAtLeastOne"]);
    expect(run({ models: [BR("a", { enabled: false })] })).toEqual(["admin.models.needEnabled"]);
    expect(run({ order: ["gateway", "iam", "api_key"], defaults: { iam: "kimi" } })).toContain("admin.models.needSourceModel");
  });
  it("each surface needs a model from the source it uses", () => {
    expect(run({ models: [BR("kimi", { surfaces: ["webchat"] })] })).toEqual(["admin.models.needSurface"]);
    const models = [BR("kimi", { surfaces: ["webchat"] }), GW("a/b")];
    expect(run({ models, order: ["gateway", "iam", "api_key"], defaults: resolvedDefaults(models, {}) }))
      .toEqual(["admin.models.needSurfaceImBedrock"]);
  });
  it("an entry on no surface", () => {
    const models = [...CFG().models, BR("x", { surfaces: [] })];
    expect(run({ models })).toEqual(["admin.models.needEntrySurface"]);
    expect(blockerText(saveBlockers({ models, order: ["iam", "api_key", "gateway"], defaults: { iam: "kimi" }, cfg: CFG() })[0], zh))
      .toContain("「X」");
  });
  it("an unconfigured top source / IM source", () => {
    const cfg = CFG({ gateway: { configured: false } });
    const models = [...cfg.models, GW("a/b")];
    expect(run({ cfg, models, order: ["gateway", "iam", "api_key"], defaults: resolvedDefaults(models, {}) }))
      .toEqual(["admin.models.needSourceConfigured"]);
    // 没配好的来源排第一：这条排在「先加模型」前面
    expect(run({ cfg, order: ["gateway", "iam", "api_key"], defaults: { iam: "kimi" } })[0]).toBe("admin.models.needSourceConfigured");
    expect(run({ models, order: ["gateway", "api_key", "iam"], defaults: resolvedDefaults(models, {}) }))
      .toEqual(["admin.models.needImSourceConfigured"]);
  });
});

describe("taskEffective mirrors BFF backendTaskEntry", () => {
  // 与 llm_gateway.test.mjs「backend tasks follow the active source」同一组输入
  const models = [BR("moonshot-kimi-k3"), GW("anthropic/claude-opus-4-7", { alias: "gw-claude-opus" }),
    GW("Qwen/Qwen3-235B-A22B", { alias: "gw-qwen" })];
  const defaults = { iam: "moonshot-kimi-k3", gateway: "gw-claude-opus" };
  it("gateway on top: a Bedrock binding / no binding uses the gateway default", () => {
    expect(taskEffective(models, defaults, "gateway", "moonshot-kimi-k3")?.alias).toBe("gw-claude-opus");
    expect(taskEffective(models, defaults, "gateway", "")?.alias).toBe("gw-claude-opus");
    expect(taskEffective(models, defaults, "gateway", "gw-qwen")?.alias).toBe("gw-qwen");
  });
  it("Bedrock on top: the binding if it is Bedrock, otherwise the backend's own fallback", () => {
    expect(taskEffective(models, defaults, "iam", "moonshot-kimi-k3")?.alias).toBe("moonshot-kimi-k3");
    expect(taskEffective(models, defaults, "iam", "gw-qwen")).toBeNull();
    expect(taskEffective(models, defaults, "iam", "")).toBeNull();
  });
});

describe("gateway helpers", () => {
  it("upstream provider names", () => {
    expect(gatewayUpstreamName("anthropic/claude-sonnet-5-5")).toBe("Anthropic");
    expect(gatewayUpstreamName("vertex_ai/gemini-3")).toBe("Vertex AI");
    expect(gatewayUpstreamName("bedrock/anthropic.claude-opus-5-5")).toBe("Bedrock");
    expect(gatewayUpstreamName("gpt-4o-mini")).toBeNull();
    expect(gatewayUpstreamName("acme/model")).toBeNull();
  });
  it("groups by prefix, other last", () => {
    expect(groupByPrefix(["bedrock/x", "anthropic/a", "solo", "anthropic/b"], "其他")).toEqual([
      { name: "anthropic/", ids: ["anthropic/a", "anthropic/b"] }, { name: "bedrock/", ids: ["bedrock/x"] },
      { name: "其他", ids: ["solo"] },
    ]);
  });
  it("selection is symmetric: add, remove, alias collision, default moves to what is left", () => {
    const models = [BR("kimi"), GW("anthropic/claude-sonnet-5-5"),
      GW("bedrock/anthropic.claude-opus-5-5", { alias: "gw-anthropic-claude-opus-5-5" })];
    const sd = { iam: "kimi", gateway: "gw-claude-sonnet-5-5" };
    const r = applyGatewaySelection(models, sd, ["bedrock/anthropic.claude-opus-5-5", "openai/claude-sonnet-5-5"]);
    expect(r.removed).toEqual(["anthropic/claude-sonnet-5-5"]);
    expect(r.added).toEqual(["openai/claude-sonnet-5-5"]);
    // 被移出的 alias 不在同一次操作里回收 —— 否则原默认会悄悄指向新加的那个
    expect(r.models.map((m) => m.alias)).toEqual(["kimi", "gw-anthropic-claude-opus-5-5", "gw-claude-sonnet-5-5-2"]);
    expect(resolvedDefaults(r.models, r.srcDefaults).gateway).toBe("gw-anthropic-claude-opus-5-5");
    // 别名避撞：再加一个同尾段的
    const r2 = applyGatewaySelection(r.models, r.srcDefaults, [...r.models.filter((m) => m.kind === "openai_compatible").map((m) => m.model_id), "x/claude-sonnet-5-5"]);
    expect(r2.models.at(-1)?.alias).toBe("gw-claude-sonnet-5-5");
  });
  it("the first gateway model added becomes the gateway default", () => {
    const r = applyGatewaySelection([BR("kimi")], { iam: "kimi" }, ["anthropic/a", "anthropic/b"]);
    expect(resolvedDefaults(r.models, r.srcDefaults).gateway).toBe("gw-a");
  });
});

describe("catalogue helpers", () => {
  it("appending a Bedrock entry only fills empty defaults", () => {
    const e = newBedrockEntry("global.zai.glm-5.3", "GLM 5.3", "bedrock_converse", null, () => false);
    expect(e).toMatchObject({ enabled: true, surfaces: ["webchat", "im"], hard_output_limit: 8192 });
    expect(appendWithDefault([BR("kimi")], { iam: "kimi" }, e).srcDefaults).toEqual({ iam: "kimi" });
    expect(appendWithDefault([], {}, e).srcDefaults).toEqual({ iam: e.alias, api_key: e.alias });
  });
  it("candidate region: Mantle uses the server default, never a list position", () => {
    expect(candidateRegion({ kind: "bedrock_mantle_responses", default_region: "us-west-2" })).toBe("us-west-2");
    expect(candidateRegion({ kind: "bedrock_mantle_responses" })).toBe("us-east-2");
    expect(candidateRegion({ kind: "bedrock_converse" })).toBeNull();
  });
  it("defaultOf / replacementsFor", () => {
    const models = [BR("kimi"), BR("grok"), GW("a/b"), GW("a/c", { enabled: false })];
    const d = { iam: "kimi", api_key: "kimi", gateway: "gw-b" };
    expect(defaultOf("kimi", models, d)).toEqual(["iam", "api_key"]);
    expect(defaultOf("grok", models, d)).toEqual([]);
    expect(replacementsFor("gw-b", models, ["gateway"])).toEqual([]);
    expect(replacementsFor("kimi", models, ["iam", "api_key"]).map((m) => m.alias)).toEqual(["grok"]);
  });
  it("table order, filters and counts", () => {
    const models = [BR("kimi"), BR("glm", { enabled: false }), GW("anthropic/x")];
    expect(sortForTable(models, "gateway").map((m) => m.alias)).toEqual(["gw-x", "kimi", "glm"]);
    expect(sortForTable(models, "iam").map((m) => m.alias)).toEqual(["kimi", "glm", "gw-x"]);
    expect(filterModels(models, "disabled", "").map((m) => m.alias)).toEqual(["glm"]);
    expect(filterModels(models, "all", "KIMI").map((m) => m.alias)).toEqual(["kimi"]);
    expect(filterModels(models, "gateway", "").map((m) => m.alias)).toEqual(["gw-x"]);
    expect(segCounts(models)).toEqual({ all: 3, bedrock: 2, gateway: 1, disabled: 1 });
  });
  it("surfaceModel follows apiGetModels: the default if it is on that surface, else the first", () => {
    const models = [BR("kimi", { surfaces: ["webchat"] }), BR("grok")];
    expect(surfaceModel(models, { iam: "kimi" }, "iam", "webchat")?.alias).toBe("kimi");
    expect(surfaceModel(models, { iam: "kimi" }, "iam", "im")?.alias).toBe("grok");
    expect(surfaceModel(models, {}, "gateway", "webchat")).toBeUndefined();
  });
});
