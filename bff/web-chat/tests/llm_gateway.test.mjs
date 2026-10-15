/**
 * OpenAI 兼容网关来源（2026-10）单测。
 *
 * 覆盖：
 *   · base_url 规整与 SSRF（字面量私网 IP / DNS 解析到私网 / 重定向）
 *   · 「拉取模型列表」的过滤（通配符、embedding / 图像 / 语音）
 *   · PUT /admin/llm-config/gateway：先 GET /models 验证再落库、Key 不回显、推 gateway_rev
 *   · 来源次序（source_order）校验与老前端兼容（只发 credential_mode）
 *   · 切到网关的现场探测（带工具定义）：只有确定性失败拦（no_tools / upstream_auth …），
 *     限流 / 超时只警告；拒绝时回结构化 `probe`；网关排第一时加探 IM 的 Bedrock 来源
 *   · upstream_auth：chat 401 后用同一把 Key GET /models 复核（不花 token）
 *   · /models、resolveForStream 按第一来源家族过滤
 *   · 后端任务投影跟着第一来源走
 *
 * 全程不触网：DDB / Secrets / DNS / fetch 全部经 __setClients 注入。
 * 运行：node bff/web-chat/tests/llm_gateway.test.mjs
 */
import assert from "node:assert/strict";

import * as mod from "../llm_config.mjs";

const GW_SECRET = "notiops/litellm-config";
const KEY_SECRET = "notiops/bedrock-api-key";

const state = {
  item: null, audit: [], appconfig: {}, secrets: {}, failCondition: 0,
  dns: {}, fetchCalls: [], route: null, converseError: null,
};

const fakeDdb = {
  async send(cmd) {
    const t = cmd.constructor.name.replace(/Command$/, "");
    if (t === "Get") {
      const { PK, SK } = cmd.input.Key;
      if (PK === "llmcfg") return { Item: state.item ? structuredClone(state.item) : undefined };
      if (String(PK).startsWith("appconfig#")) {
        const hit = state.appconfig[`${PK}|${SK}`];
        return { Item: hit ? { ...hit } : undefined };
      }
      return { Item: state.audit.find((a) => a.SK === SK) };
    }
    if (t === "Put") {
      const pk = String(cmd.input.Item.PK);
      if (pk === "llmcfg#audit") { state.audit.unshift(cmd.input.Item); return {}; }
      if (pk.startsWith("appconfig#")) {
        state.appconfig[`${pk}|${cmd.input.Item.SK}`] = cmd.input.Item; return {};
      }
      if (state.failCondition > 0 && cmd.input.ConditionExpression) {
        state.failCondition -= 1;
        // 模拟并发保存：别人先把 generation 推了一格
        state.item = { ...state.item, generation: Number(state.item.generation) + 1 };
        throw Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" });
      }
      if (cmd.input.ConditionExpression === "generation = :g"
          && state.item && Number(state.item.generation) !== cmd.input.ExpressionAttributeValues[":g"]) {
        throw Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" });
      }
      state.item = structuredClone(cmd.input.Item);
      return {};
    }
    if (t === "Query") return { Items: [] };
    throw new Error(`unexpected ddb cmd ${t}`);
  },
};

// Secrets 按 SecretId 分槽 —— Bedrock Key 与网关是两个 Secret，混在一起就测不出串读。
const fakeSm = {
  async send(cmd) {
    const t = cmd.constructor.name.replace(/Command$/, "");
    const id = cmd.input.SecretId || cmd.input.Name;
    if (t === "GetSecretValue") {
      if (!(id in state.secrets)) throw Object.assign(new Error("nf"), { name: "ResourceNotFoundException" });
      return { SecretString: state.secrets[id], CreatedDate: new Date() };
    }
    if (t === "UpdateSecret") {
      if (!(id in state.secrets)) throw Object.assign(new Error("nf"), { name: "ResourceNotFoundException" });
      state.secrets[id] = cmd.input.SecretString; return {};
    }
    if (t === "CreateSecret") { state.secrets[id] = cmd.input.SecretString; state.created.push(cmd.input); return {}; }
    throw new Error(`unexpected sm cmd ${t}`);
  },
};

const fakeRuntimeFactory = () => ({
  async send() {
    if (state.converseError) throw Object.assign(new Error("x"), { name: state.converseError });
    return { output: {} };
  },
});

const fakeDns = async (host) => {
  if (!(host in state.dns)) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return state.dns[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

const resp = (status, body) => ({
  status, ok: status >= 200 && status < 300,
  async text() { return typeof body === "string" ? body : JSON.stringify(body); },
});

const fakeFetch = async (url, init) => {
  state.fetchCalls.push({ url: String(url), init });
  if (!state.route) throw new TypeError("fetch failed");
  return state.route(String(url), init);
};

mod.__setClients({ ddb: fakeDdb, sm: fakeSm, runtimeFactory: fakeRuntimeFactory,
                   bedrockFactory: () => ({ async send() { return {}; } }),
                   dnsLookup: fakeDns, gatewayFetch: fakeFetch });

/* ───────────────── fixtures ───────────────── */

const BEDROCK = (over = {}) => ({
  alias: "moonshot-kimi-k3", short: "kimi", aliases_legacy: [],
  model_id: "global.moonshotai.kimi-k3", label: "Kimi K3", kind: "bedrock_converse",
  region: null, hard_output_limit: 128000, supports_prompt_cache: false,
  surfaces: ["webchat", "im"], enabled: true, ...over,
});
const GW = (over = {}) => ({
  alias: "gw-claude-opus", model_id: "anthropic/claude-opus-4-7", label: "Claude Opus (gateway)",
  kind: "openai_compatible", region: null, hard_output_limit: 8192,
  supports_prompt_cache: false, surfaces: ["webchat"], enabled: true, ...over,
});
const CFG = (over = {}) => structuredClone({
  provider: "bedrock", credential_mode: "iam", source_order: ["iam", "api_key", "gateway"],
  source_defaults: { iam: "moonshot-kimi-k3", gateway: "gw-claude-opus" },
  default_model: "moonshot-kimi-k3",
  models: [BEDROCK(), GW(), GW({ alias: "gw-qwen", model_id: "Qwen/Qwen3-235B-A22B", label: "Qwen3" })],
  backend_tasks: { phd_translate: "moonshot-kimi-k3", devops_report_summarize: null },
  ...over,
});
const TO_GATEWAY = () => CFG({
  credential_mode: "gateway", source_order: ["gateway", "api_key", "iam"],
  default_model: "gw-claude-opus",
});
const ACTOR = { sub: "u-1", username: "admin@example.com" };
const BASE = "https://gw.example.com/v1";
const KEY = "sk-gateway-test-key-0001"; // gitleaks:allow (fake test value)

const okModels = (ids) => resp(200, { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "openai" })) });
const okChat = () => resp(200, { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }] });

function seedGateway() {
  state.secrets[GW_SECRET] = JSON.stringify({ base_url: BASE, api_key: KEY });
  state.dns["gw.example.com"] = ["203.0.113.10"];
}
/** TO_GATEWAY() 把 IM 放到 Bedrock API Key 上：那几条要真有一把 Key —— 没有 Key 时服务端按 not_configured
 *  拦（不再回退部署角色去探，见 IM 那一节）。 */
function seedBedrockKey() {
  state.secrets[KEY_SECRET] = JSON.stringify({ bedrock_api_key: "a-plausible-bedrock-key" });
}

let pass = 0, fail = 0;
function reset() {
  state.item = null; state.audit = []; state.appconfig = {}; state.secrets = {}; state.created = [];
  state.failCondition = 0; state.dns = {}; state.fetchCalls = []; state.route = null;
  state.converseError = null;
}
async function t(name, fn) {
  reset();
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${String(e.message).split("\n")[0]}`); }
}

/* ───────────────── base_url ───────────────── */
console.log("base_url normalisation (must match core/llm_config + shared/llm_provider)");

const NORMALISE = [
  ["https://gw.example.com", "https://gw.example.com/v1"],
  ["https://gw.example.com/", "https://gw.example.com/v1"],
  ["https://gw.example.com/v1", "https://gw.example.com/v1"],
  ["https://gw.example.com/v1/", "https://gw.example.com/v1"],
  ["https://gw.example.com/v1/chat/completions", "https://gw.example.com/v1"],
  ["https://gw.example.com/models", "https://gw.example.com/v1"],
  ["https://gw.example.com/api/openai/v1/models/", "https://gw.example.com/api/openai/v1"],
  ["https://gw.example.com:8443/v1", "https://gw.example.com:8443/v1"],
  ["  https://gw.example.com/v1  ", "https://gw.example.com/v1"],
  ["http://gw.example.com/v1", ""],
  ["https://gw.example.com/v1?x=1", ""],
  ["https://gw.example.com/v1#frag", ""],
  ["https://user:pw@gw.example.com/v1", ""],
  ["ftp://gw.example.com", ""],
  ["", ""],
  [null, ""],
  ["https://", ""],
  ["https://gw.example.com:99999/v1", ""],
  ["https://localhost/v1", ""],
  ["https://127.0.0.1/v1", ""],
  ["https://10.0.0.5/v1", ""],
  ["https://169.254.169.254/latest", ""],
  ["https://[::1]/v1", ""],
  ["https://foo.localhost/v1", ""],
];
await t("normalizeGatewayBaseUrl follows the shared table", async () => {
  for (const [raw, want] of NORMALISE) {
    assert.equal(mod.normalizeGatewayBaseUrl(raw), want, `normalize(${JSON.stringify(raw)})`);
  }
});

/* ───────────────── 模型列表过滤 ───────────────── */
console.log("gateway model listing");

await t("listing hides wildcards and non-chat models, keeps provider-prefixed chat ids", async () => {
  // 形状取自实测的 LiteLLM /models（412 条，含 `*` 通配与 embedding / dall-e / realtime）
  const ids = ["*", "anthropic/*", "bedrock/*", "groq/*", "gpt-4o-mini", "anthropic/claude-opus-4-7",
    "Qwen/Qwen3-235B-A22B", "bedrock/global.anthropic.claude-sonnet-4-6", "text-embedding-ada-002",
    "dall-e-2", "realtime-v1", "mistral-embed", "omni-moderation-latest", "tts-1", "whisper-1",
    "gpt-image-1", "gpt-4o-audio-preview", "cohere.rerank-v3-5:0", "gpt-4o-mini"];
  seedGateway();
  state.route = (url, init) => {
    assert.equal(url, `${BASE}/models`);
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
    return okModels(ids);
  };
  const r = await mod.apiGetGatewayModels();
  assert.equal(r.result, "ok", JSON.stringify(r));
  assert.deepEqual(r.models.map((m) => m.id), [
    "anthropic/claude-opus-4-7", "bedrock/global.anthropic.claude-sonnet-4-6", "gpt-4o-mini",
    "Qwen/Qwen3-235B-A22B",
  ].sort((a, b) => a.localeCompare(b)));
  const reasons = Object.fromEntries(r.hidden.map((h) => [h.id, h.reason]));
  assert.equal(reasons["*"], "wildcard");
  assert.equal(reasons["anthropic/*"], "wildcard");
  for (const id of ["text-embedding-ada-002", "dall-e-2", "realtime-v1", "mistral-embed",
    "omni-moderation-latest", "tts-1", "whisper-1", "gpt-image-1", "gpt-4o-audio-preview",
    "cohere.rerank-v3-5:0"]) {
    assert.equal(reasons[id], "non_chat", id);
  }
  assert.equal(r.total, ids.length - 1, "duplicates counted once");
  assert.ok(!JSON.stringify(r).includes(KEY), "key must never be echoed");
});

await t("listing maps upstream failures to enums", async () => {
  seedGateway();
  for (const [status, want] of [[401, "unauthorized"], [403, "forbidden"], [404, "not_found"],
    [429, "throttled"], [500, "error"], [302, "redirect"]]) {
    state.route = () => resp(status, { error: { message: `leaks ${KEY}` } });
    const r = await mod.apiGetGatewayModels();
    assert.equal(r.result, want, `${status}`);
    assert.ok(!JSON.stringify(r).includes(KEY));
  }
  state.route = () => resp(200, "<html>not json</html>");
  assert.equal((await mod.apiGetGatewayModels()).result, "bad_response");
  state.route = null;
  assert.equal((await mod.apiGetGatewayModels()).result, "unreachable");
});

await t("listing refuses a host that resolves to a private address", async () => {
  seedGateway();
  state.dns["gw.example.com"] = ["203.0.113.10", "10.1.2.3"];
  state.route = () => okModels(["gpt-4o-mini"]);
  const r = await mod.apiGetGatewayModels();
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.equal(state.fetchCalls.length, 0, "must not even connect");
});

await t("listing without saved settings is a 409, not a crash", async () => {
  assert.equal((await mod.apiGetGatewayModels()).status, 409);
});

/* ───────────────── PUT gateway ───────────────── */
console.log("PUT /admin/llm-config/gateway");

await t("saving validates with GET /models first and stores the normalised base", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000, bedrock_key_set_by: "someone" };
  state.dns["gw.example.com"] = ["203.0.113.10"];
  state.route = () => okModels(["gpt-4o-mini", "*"]);
  const r = await mod.apiPutGateway({ base_url: "https://gw.example.com/", api_key: ` ${KEY} ` }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(JSON.parse(state.secrets[GW_SECRET]), { base_url: BASE, api_key: KEY });
  assert.equal(state.fetchCalls[0].url, `${BASE}/models`, "verified against the normalised base");
  assert.equal(r.gateway.configured, true);
  assert.equal(r.gateway.last_4, KEY.slice(-4));
  assert.deepEqual(r.models.map((m) => m.id), ["gpt-4o-mini"]);
  assert.ok(!JSON.stringify(r).includes(KEY), "key must never be echoed");
  assert.ok(state.item.generation > 1000, "generation must advance");
  assert.equal(state.item.gateway_rev, state.item.generation, "gateway_rev must advance");
  assert.equal(state.item.gateway_set_by, ACTOR.username);
  assert.equal(state.item.bedrock_key_set_by, "someone", "unrelated metadata survives");
});

// 方式A 不预建这两个 secret：首次保存走 CreateSecret，标签只能在这里打（栈级 Tags 盖不到）。
const tagsOf = (input) => Object.fromEntries((input.Tags || []).map((x) => [x.Key, x.Value]));

await t("first gateway save without a pre-created secret creates it with the mandatory tags", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  state.dns["gw.example.com"] = ["203.0.113.10"];
  state.route = () => okModels(["gpt-4o-mini"]);
  const r = await mod.apiPutGateway({ base_url: BASE, api_key: KEY }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  const made = state.created.filter((c) => c.Name === GW_SECRET);
  assert.equal(made.length, 1, "UpdateSecret 404 → exactly one CreateSecret");
  assert.deepEqual(tagsOf(made[0]), { project: "notiops", "auto-delete": "no" });
});

await t("first Bedrock API key save without a pre-created secret creates it with the mandatory tags", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  const r = await mod.apiPutBedrockKey({ api_key: "a-plausible-bedrock-key" }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  const made = state.created.filter((c) => c.Name === KEY_SECRET);
  assert.equal(made.length, 1, "UpdateSecret 404 → exactly one CreateSecret");
  assert.deepEqual(tagsOf(made[0]), { project: "notiops", "auto-delete": "no" });
});

await t("a rejected key is not saved", async () => {
  state.dns["gw.example.com"] = ["203.0.113.10"];
  state.route = () => resp(401, { error: { message: "Invalid proxy server token passed" } });
  const r = await mod.apiPutGateway({ base_url: BASE, api_key: KEY }, ACTOR);
  assert.equal(r.status, 400);
  assert.equal(r.result, "unauthorized");
  assert.ok(!(GW_SECRET in state.secrets), "nothing written");
});

await t("bad inputs are rejected before any network call", async () => {
  state.dns["gw.example.com"] = ["203.0.113.10"];
  state.route = () => okModels(["gpt-4o-mini"]);
  for (const body of [
    { base_url: "http://gw.example.com/v1", api_key: KEY },
    { base_url: "https://10.0.0.1/v1", api_key: KEY },
    { base_url: "https://gw.example.com/v1?token=x", api_key: KEY },
    { base_url: BASE, api_key: "short" },
    { base_url: BASE, api_key: "sk-has a space-1234" },
    { base_url: BASE, api_key: "sk-has-newline\nX-Evil: 1" },
    { base_url: BASE },                         // no key and none stored
  ]) {
    const r = await mod.apiPutGateway(body, ACTOR);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(state.fetchCalls.length, 0);
  state.dns["evil.example.com"] = ["192.168.1.10"];
  const r = await mod.apiPutGateway({ base_url: "https://evil.example.com", api_key: KEY }, ACTOR);
  assert.equal(r.status, 400, "DNS → private must be refused");
  assert.equal(state.fetchCalls.length, 0);
});

await t("omitting api_key keeps the stored key only for the same host", async () => {
  seedGateway();
  state.route = (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
    return okModels(["gpt-4o-mini"]);
  };
  const r = await mod.apiPutGateway({ base_url: "https://gw.example.com/api/v1" }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(JSON.parse(state.secrets[GW_SECRET]),
                   { base_url: "https://gw.example.com/api/v1", api_key: KEY });
});

await t("a new host never receives the stored key (must re-enter it)", async () => {
  seedGateway();
  state.dns["attacker.example.net"] = ["203.0.113.99"];
  state.route = () => okModels(["gpt-4o-mini"]);
  const r = await mod.apiPutGateway({ base_url: "https://attacker.example.net/v1" }, ACTOR);
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.equal(r.result, "key_required");
  assert.equal(state.fetchCalls.length, 0, "the stored key must not be sent anywhere");
  assert.equal(JSON.parse(state.secrets[GW_SECRET]).base_url, BASE, "nothing changed");
});

await t("re-pointing the active gateway must still serve its default model", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000 };
  state.dns["gw2.example.com"] = ["203.0.113.11"];
  state.route = () => okModels(["claude-opus-4-7"]);         // New API 风格的名字，对不上
  const r = await mod.apiPutGateway({ base_url: "https://gw2.example.com/v1", api_key: KEY }, ACTOR);
  assert.equal(r.status, 409, JSON.stringify(r));
  assert.equal(r.result, "default_missing");
  state.route = () => okModels(["anthropic/claude-opus-4-7", "gpt-4o-mini"]);
  const ok = await mod.apiPutGateway({ base_url: "https://gw2.example.com/v1", api_key: KEY }, ACTOR);
  assert.equal(ok.error, undefined, JSON.stringify(ok));
  const audit = state.audit.find((a) => String(a.SK || "").length);
  assert.ok(audit, "an audit row was written");
  // 审计要答得出「谁在什么时候把网关从哪里改到了哪里」—— 只记主机，不记凭证。
  assert.equal(audit.note, "gateway_set:gw.example.com->gw2.example.com");
  assert.ok(!JSON.stringify(state.audit).includes(KEY), "the key never reaches the audit trail");
});

await t("a gateway change whose generation bump fails is still audited and reported, not silently 'saved'", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  state.dns["gw2.example.com"] = ["203.0.113.11"];
  state.route = () => okModels(["gpt-4o-mini"]);
  state.failCondition = 2;                        // 首次与重试都撞上并发写
  const r = await mod.apiPutGateway({ base_url: "https://gw2.example.com/v1", api_key: KEY }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.match(r.warning || "", /not notified/, "the admin must be told the change has not propagated");
  assert.equal(JSON.parse(state.secrets[GW_SECRET]).base_url, "https://gw2.example.com/v1", "the secret was written");
  assert.ok(state.audit.some((a) => a.note === "gateway_set:gw.example.com->gw2.example.com:not_propagated"),
            JSON.stringify(state.audit.map((a) => a.note)));
});

await t("the Bedrock key cannot be cleared while IM uses it under a gateway-on-top order", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000 };
  state.secrets[KEY_SECRET] = JSON.stringify({ bedrock_api_key: "a-plausible-bedrock-key" });
  assert.equal((await mod.apiPutBedrockKey({ clear: true }, ACTOR)).status, 409);
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1001 };
  const r = await mod.apiPutBedrockKey({ clear: true }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
});

await t("an invalid stored base_url is reported as host only", async () => {
  state.secrets[GW_SECRET] = JSON.stringify({ base_url: "https://user:pw@gw.example.com/v1?api_key=zzz", api_key: KEY });
  const r = await mod.apiGetLlmConfig();
  assert.equal(r.gateway.configured, false);
  assert.equal(r.gateway.base_url, "gw.example.com");
  assert.ok(!JSON.stringify(r).includes("zzz") && !JSON.stringify(r).includes("pw@"));
});

await t("a redirecting gateway is refused (no SSRF via 30x, key not forwarded)", async () => {
  state.dns["gw.example.com"] = ["203.0.113.10"];
  state.route = () => resp(302, "");
  const r = await mod.apiPutGateway({ base_url: BASE, api_key: KEY }, ACTOR);
  assert.equal(r.status, 400);
  assert.equal(r.result, "redirect");
});

await t("the gateway_rev bump retries once on a concurrent save", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  state.dns["gw.example.com"] = ["203.0.113.10"];
  state.route = () => okModels(["gpt-4o-mini"]);
  state.failCondition = 1;
  const r = await mod.apiPutGateway({ base_url: BASE, api_key: KEY }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.ok(state.item.gateway_rev > 0, "gateway_rev must land despite the conflict");
});

await t("clearing is refused while the gateway is the active source", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000 };
  assert.equal((await mod.apiPutGateway({ clear: true }, ACTOR)).status, 409);
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  const r = await mod.apiPutGateway({ clear: true }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.secrets[GW_SECRET], "{}");
  assert.equal(r.gateway.configured, false);
});

/* ───────────────── validateConfig ───────────────── */
console.log("validateConfig — sources");

await t("a valid three-source config passes", async () => {
  assert.equal(mod.validateConfig(CFG()), null);
  assert.equal(mod.validateConfig(TO_GATEWAY()), null);
});

const BAD = [
  ["gateway model on IM", (c) => { c.models[1].surfaces = ["webchat", "im"]; }],
  ["gateway model id with spaces", (c) => { c.models[1].model_id = "claude opus"; }],
  ["gateway model id with ..", (c) => { c.models[1].model_id = "a/../b"; }],
  ["gateway model with region", (c) => { c.models[1].region = "us-east-2"; }],
  ["source_order missing one", (c) => { c.source_order = ["iam", "api_key"]; }],
  ["source_order duplicate", (c) => { c.source_order = ["iam", "iam", "gateway"]; }],
  ["source_order unknown", (c) => { c.source_order = ["iam", "api_key", "openai"]; }],
  ["credential_mode != source_order[0]", (c) => { c.credential_mode = "api_key"; }],
  ["unknown credential_mode", (c) => { c.credential_mode = "litellm"; c.source_order = undefined; }],
  ["Bedrock default while gateway is on top", (c) => {
    c.credential_mode = "gateway"; c.source_order = ["gateway", "iam", "api_key"];
    c.source_defaults = {}; c.default_model = "moonshot-kimi-k3";
  }],
  ["gateway on top without any enabled gateway model", (c) => {
    c.credential_mode = "gateway"; c.source_order = ["gateway", "iam", "api_key"];
    c.models = [BEDROCK()]; c.default_model = "moonshot-kimi-k3"; c.source_defaults = {};
  }],
  ["source_defaults pointing across families", (c) => { c.source_defaults = { gateway: "moonshot-kimi-k3" }; }],
  ["source_defaults unknown source", (c) => { c.source_defaults = { openai: "gw-qwen" }; }],
  ["source_defaults not an object", (c) => { c.source_defaults = ["x"]; }],
];
for (const [label, mutate] of BAD) {
  await t(`rejects: ${label}`, async () => {
    const c = CFG(); mutate(c);
    assert.ok(mod.validateConfig(c), "expected a validation error");
  });
}

await t("IM still needs a Bedrock model even when the gateway is on top", async () => {
  const c = TO_GATEWAY();
  c.models[0].surfaces = ["webchat"];
  assert.match(mod.validateConfig(c) || "", /surface 'im'/);
});

/* ───────────────── save / switch ───────────────── */
console.log("saving and switching sources");

await t("switching to the gateway probes with a tool definition and saves on ok", async () => {
  seedGateway(); seedBedrockKey();
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000, gateway_rev: 900 };
  let probeBody = null;
  state.route = (url, init) => {
    assert.equal(url, `${BASE}/chat/completions`);
    probeBody = JSON.parse(init.body);
    return okChat();
  };
  const r = await mod.apiPutLlmConfig(TO_GATEWAY(), ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(probeBody.model, "anthropic/claude-opus-4-7", "model id passed through untouched");
  assert.equal(probeBody.stream, false);
  assert.ok(probeBody.max_tokens >= 16 && probeBody.max_tokens <= 128);
  assert.equal(probeBody.tools?.[0]?.type, "function", "probe must ask about tool support");
  assert.equal(state.item.credential_mode, "gateway");
  assert.deepEqual(state.item.source_order, ["gateway", "api_key", "iam"]);
  assert.equal(state.item.source_defaults.gateway, "gw-claude-opus");
  assert.equal(state.item.source_defaults.iam, "moonshot-kimi-k3", "the Bedrock default survives");
  assert.equal(state.item.gateway_rev, 900, "a catalogue save keeps gateway_rev");
});

await t("switching to the gateway with a transient probe failure saves and warns (no test-before-save gate)", async () => {
  // 2026-10 改版：服务端是唯一门槛，只有确定性失败拦。限流 / 超时 / 5xx 照存 + warning ——
  // 不自动降级的前提下，换上去之后真坏了，管理员在同一页把次序改回来即可。
  const timeout = () => { throw Object.assign(new Error("slow"), { name: "TimeoutError" }); };
  for (const route of [() => resp(429, { error: { message: "rate limited" } }), () => resp(502, {}), timeout]) {
    reset();
    seedGateway(); seedBedrockKey();
    state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
    state.route = route;
    const r = await mod.apiPutLlmConfig(TO_GATEWAY(), ACTOR);
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.equal(r.probe, undefined, "a saved config carries no probe failure");
    assert.match(r.warning || "", /could not be verified/);
    assert.equal(state.item.credential_mode, "gateway", "the switch was saved");
  }
});

await t("once on top, a transient probe failure only warns", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000 };
  state.route = () => resp(429, { error: { message: "rate limited" } });
  const c = TO_GATEWAY(); c.models[2].label = "Qwen3 renamed";
  const r = await mod.apiPutLlmConfig(c, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.match(r.warning || "", /could not be verified/);
});

await t("a backend without tool calling is a hard failure", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000 };
  state.route = () => resp(400, { error: { message: "This model does not support tools", type: "invalid_request_error" } });
  const r = await mod.apiPutLlmConfig(TO_GATEWAY(), ACTOR);
  assert.equal(r.status, 400);
  assert.match(r.error, /no_tools/);
});

await t("the gateway cannot go on top while it is not configured", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  const r = await mod.apiPutLlmConfig(TO_GATEWAY(), ACTOR);
  assert.equal(r.status, 400);
  assert.match(r.error, /not_configured/);
  assert.equal(state.fetchCalls.length, 0);
});

await t("escaping a broken gateway back to Bedrock is not blocked by the gateway", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000 };
  state.route = null;   // 网关已经连不上
  const r = await mod.apiPutLlmConfig(CFG(), ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.item.credential_mode, "iam");
  assert.equal(state.fetchCalls.length, 0, "the Bedrock switch must not probe the gateway");
});

await t("an old client that only sends credential_mode keeps the stored order", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...CFG({ source_order: ["iam", "gateway", "api_key"] }),
                 generation: 1000 };
  const legacy = CFG();
  delete legacy.source_order; delete legacy.source_defaults;
  legacy.credential_mode = "api_key";
  state.secrets[KEY_SECRET] = JSON.stringify({ bedrock_api_key: "a-plausible-bedrock-key" });
  const r = await mod.apiPutLlmConfig(legacy, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(state.item.source_order, ["api_key", "iam", "gateway"]);
  assert.equal(state.item.source_defaults.gateway, "gw-claude-opus", "stored defaults survive");
});

await t("a stale default for a backup source is dropped instead of blocking the save", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  const c = CFG();
  c.models = c.models.filter((m) => m.alias !== "gw-claude-opus");   // admin deleted it
  delete c.source_defaults;
  const r = await mod.apiPutLlmConfig(c, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.item.source_defaults.gateway, undefined);
});

/* ───────────────── consumers ───────────────── */
console.log("consumers follow the active source");

await t("/models lists only the active family; IM view stays on Bedrock", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000 };
  const web = await mod.apiGetModels("webchat");
  assert.deepEqual(web.models.map((m) => m.id), ["gw-claude-opus", "gw-qwen"]);
  assert.equal(web.default_model, "gw-claude-opus");
  assert.equal(web.models[0].uses_api_key, false);
  const im = await mod.apiGetModels("im");
  assert.deepEqual(im.models.map((m) => m.id), ["moonshot-kimi-k3"]);
  assert.equal(im.default_model, "moonshot-kimi-k3");
});

await t("resolveForStream swaps a stored Bedrock alias for the gateway default", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000 };
  const r = await mod.resolveForStream("kimi", "webchat");
  assert.equal(r.alias, "gw-claude-opus");
  assert.equal(r.substituted, true);
  assert.equal((await mod.resolveForStream("gw-qwen", "webchat")).alias, "gw-qwen");
  assert.equal((await mod.resolveForStream("", "webchat")).substituted, false);
});

await t("backend tasks follow the active source and come back on switch-back", async () => {
  seedGateway(); seedBedrockKey();
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  state.route = () => okChat();
  assert.equal((await mod.apiPutLlmConfig(TO_GATEWAY(), ACTOR)).error, undefined);
  const row = (task, sk) => state.appconfig[`appconfig#${task}|${sk}`]?.config_value;
  assert.equal(row("phd", "bedrock_model_id"), "anthropic/claude-opus-4-7");
  assert.equal(row("phd", "bedrock_model_kind"), "openai_compatible");
  assert.equal(row("devops_agent", "bedrock_model_id"), "anthropic/claude-opus-4-7",
               "an unbound task uses the gateway default instead of a Bedrock fallback");
  const bt = await mod.apiGetBackendTasks();
  const phd = bt.tasks.find((x) => x.task === "phd_translate");
  assert.equal(phd.alias, "moonshot-kimi-k3", "the binding itself is untouched");
  assert.equal(phd.effective_alias, "gw-claude-opus");
  assert.equal(phd.status, "in_sync");

  assert.equal((await mod.apiPutLlmConfig(CFG(), ACTOR)).error, undefined);
  assert.equal(row("phd", "bedrock_model_id"), "global.moonshotai.kimi-k3");
  assert.equal(row("phd", "bedrock_model_kind"), "bedrock_converse");
  assert.equal(row("devops_agent", "bedrock_model_id"), "", "our projection is cleared again");
});

await t("GET /admin/llm-config reports sources and never the gateway key", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000, gateway_set_by: "a@b" };
  const r = await mod.apiGetLlmConfig();
  assert.deepEqual(r.source_order, ["gateway", "api_key", "iam"]);
  assert.equal(r.credential_mode, "gateway");
  assert.equal(r.im_source, "api_key");
  assert.equal(r.gateway.configured, true);
  assert.equal(r.gateway.base_url, BASE);
  assert.equal(r.gateway.set_by, "a@b");
  assert.ok(!JSON.stringify(r).includes(KEY));
  const legacy = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1 };
  delete legacy.source_order; legacy.credential_mode = "api_key";
  state.item = legacy;
  assert.deepEqual((await mod.apiGetLlmConfig()).source_order, ["api_key", "iam", "gateway"]);
});

/* ───────────────── connectivity test ───────────────── */
console.log("connectivity test");

await t("testing a gateway model classifies upstream errors without leaking text", async () => {
  seedGateway();
  const cases = [
    [() => okChat(), "ok"],
    [() => resp(401, { error: { message: `Invalid key ${KEY}` } }), "unauthorized"],
    [() => resp(400, { error: { message: "Invalid model name passed in model=nope" } }), "invalid_model"],
    [() => resp(503, { error: { message: "当前分组 default 下对于模型 nope 无可用渠道", code: "model_not_found" } }), "invalid_model"],
    [() => resp(404, { error: { message: "The model `nope` does not exist", code: "model_not_found" } }), "invalid_model"],
    [() => resp(400, { error: { message: "tools is not supported for this model" } }), "no_tools"],
    [() => resp(400, { error: { message: "max_tokens too small" } }), "probe_error"],
    [() => resp(429, {}), "throttled"],
    [() => resp(502, {}), "error"],
    [() => resp(200, { error: { message: "upstream auth failed" } }), "error"],
    [() => resp(200, { nothing: true }), "bad_response"],
  ];
  for (const [route, want] of cases) {
    state.route = route;
    const r = await mod.apiTestLlmModel({ model_id: "anthropic/claude-opus-4-7", kind: "openai_compatible" });
    assert.equal(r.result, want, `${want}: ${JSON.stringify(r)}`);
    assert.equal(r.credential, "gateway");
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.ok(!JSON.stringify(r).includes("无可用渠道"));
  }
  assert.equal((await mod.apiTestLlmModel({ model_id: "a b", kind: "openai_compatible" })).status, 400);
});

/* ───────────────── upstream_auth ───────────────── */
console.log("upstream_auth: the gateway accepts the key but has no upstream credential");

// LiteLLM 上游缺凭证时的 401 形态。响应体里带着 Key 片段与上游原文 —— 两样都不许外传。
const UPSTREAM_TEXT = "AnthropicException - Missing Anthropic API Key";
const upstream401 = () => resp(401, { error: {
  message: `litellm.AuthenticationError: ${UPSTREAM_TEXT}. Received key=${KEY.slice(0, 10)}`,
  type: "auth_error", code: "401" } });
const onChat = (chat, models) => (url, init) => (url.endsWith("/chat/completions") ? chat(url, init) : models(url, init));

await t("chat 401 + GET /models 200 with the same key → upstream_auth", async () => {
  seedGateway();
  state.route = onChat(upstream401, () => okModels(["anthropic/claude-opus-4-7"]));
  const r = await mod.apiTestLlmModel({ model_id: "anthropic/claude-opus-4-7", kind: "openai_compatible" });
  assert.equal(r.result, "upstream_auth", JSON.stringify(r));
  assert.equal(r.credential, "gateway");
  assert.deepEqual(state.fetchCalls.map((c) => `${c.init.method} ${c.url}`),
                   [`POST ${BASE}/chat/completions`, `GET ${BASE}/models`]);
  assert.equal(state.fetchCalls[1].init.headers.authorization, `Bearer ${KEY}`, "same key on the follow-up");
  assert.equal(state.fetchCalls[1].init.body, undefined, "the follow-up is a bare GET (no tokens)");
  assert.ok(state.fetchCalls[1].init.signal, "the follow-up has a timeout");
  const s = JSON.stringify(r);
  assert.ok(!s.includes(KEY) && !s.includes(KEY.slice(0, 10)), "no key fragment");
  assert.ok(!s.includes(UPSTREAM_TEXT) && !s.includes("litellm."), "no upstream text");
});

await t("chat 401 stays unauthorized unless GET /models is a plain 200", async () => {
  seedGateway();
  for (const [label, models] of [
    ["401", () => resp(401, { error: { message: "Invalid proxy server token passed" } })],
    ["302", () => resp(302, "")],
    ["500", () => resp(500, {})],
    ["network", () => { throw new TypeError("fetch failed"); }],
  ]) {
    state.fetchCalls = [];
    state.route = onChat(upstream401, models);
    const r = await mod.apiTestLlmModel({ model_id: "anthropic/claude-opus-4-7", kind: "openai_compatible" });
    assert.equal(r.result, "unauthorized", `${label}: ${JSON.stringify(r)}`);
    assert.equal(state.fetchCalls.length, 2, `${label}: exactly one follow-up`);
  }
});

await t("only a real HTTP 401 triggers the follow-up", async () => {
  seedGateway();
  state.route = () => resp(403, { error: { message: "key not allowed for this model" } });
  let r = await mod.apiTestLlmModel({ model_id: "anthropic/claude-opus-4-7", kind: "openai_compatible" });
  assert.equal(r.result, "forbidden");
  assert.equal(state.fetchCalls.length, 1, "403 is not re-checked");
  state.fetchCalls = [];
  state.route = () => resp(200, { error: { message: "upstream auth failed" } });
  r = await mod.apiTestLlmModel({ model_id: "anthropic/claude-opus-4-7", kind: "openai_compatible" });
  assert.equal(r.result, "error");
  assert.equal(state.fetchCalls.length, 1, "a 200-with-error is not re-checked");
});

await t("the follow-up re-checks the public host and is skipped if it no longer resolves publicly", async () => {
  seedGateway();
  state.route = onChat(() => {
    state.dns["gw.example.com"] = ["10.0.0.9"];       // DNS 在两次请求之间被换成内网
    return upstream401();
  }, () => okModels([]));
  const r = await mod.apiTestLlmModel({ model_id: "anthropic/claude-opus-4-7", kind: "openai_compatible" });
  assert.equal(r.result, "unauthorized");
  assert.equal(state.fetchCalls.length, 1, "no request to a private address");
});

await t("non-401 upstream-credential text classifies as upstream_auth; a bare 401 does not", async () => {
  // 有的 LiteLLM 版本把「缺上游 Key」包成 500 / 400，而不是 401
  assert.equal(mod.classifyGatewayError(500, { error: { message: "litellm.InternalServerError: Missing Anthropic API Key" } }), "upstream_auth");
  assert.equal(mod.classifyGatewayError(400, { error: { message: "Missing credentials. Please pass an api_key" } }), "upstream_auth");
  assert.equal(mod.classifyGatewayError(403, { error: { message: "litellm.AuthenticationError: VertexAIException" } }), "upstream_auth");
  // 401 由 probeGateway 用 GET /models 复核，不凭文字下结论
  assert.equal(mod.classifyGatewayError(401, { error: { message: "litellm.AuthenticationError: x" } }), "unauthorized");
  assert.equal(mod.classifyGatewayError(500, { error: { message: "upstream exploded" } }), "error");
});

await t("switching to a gateway whose default hits upstream_auth is refused with a structured probe", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  state.route = onChat(upstream401, () => okModels(["anthropic/claude-opus-4-7"]));
  const r = await mod.apiPutLlmConfig(TO_GATEWAY(), ACTOR);
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.match(r.error, /upstream_auth/);
  assert.deepEqual(r.probe, { source: "gateway", model_id: "anthropic/claude-opus-4-7",
                              alias: "gw-claude-opus", result: "upstream_auth" });
  const s = JSON.stringify(r);
  assert.ok(!s.includes(KEY) && !s.includes(KEY.slice(0, 10)), "no key fragment");
  assert.ok(!s.includes(UPSTREAM_TEXT), "no upstream text");
  assert.equal(state.item.credential_mode, "iam", "nothing changed");
  assert.equal(state.item.generation, 1000, "nothing written");
});

await t("upstream_auth is a hard failure even when the gateway is already on top", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000 };
  state.route = onChat(upstream401, () => okModels(["anthropic/claude-opus-4-7"]));
  const c = TO_GATEWAY(); c.models[2].label = "Qwen3 renamed";
  const r = await mod.apiPutLlmConfig(c, ACTOR);
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.equal(r.probe?.result, "upstream_auth");
});

await t("rollback refuses an upstream_auth gateway default and carries the probe", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  state.audit = [{ PK: "llmcfg#audit", SK: "0001", snapshot_before: JSON.stringify(TO_GATEWAY()) }];
  state.route = onChat(upstream401, () => okModels(["anthropic/claude-opus-4-7"]));
  const r = await mod.apiRollbackLlmConfig({ sk: "0001" }, ACTOR);
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.equal(r.probe?.source, "gateway");
  assert.equal(r.probe?.result, "upstream_auth");
  assert.equal(state.item.credential_mode, "iam");
});

await t("index.mjs passes the structured probe through on PUT and rollback rejections", async () => {
  // 路由层没有 handler 级的测试桩；只钉住「两条拒绝出口都把 probe 透传给前端」这一件事 ——
  // 漏了它，前端只剩一句英文、标不出是哪一行。
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  const route = (needle) => {
    const i = src.indexOf(needle);
    assert.ok(i > 0, `route not found: ${needle}`);
    return src.slice(i, src.indexOf("\n    }\n", i));
  };
  assert.match(route('path.endsWith("/admin/llm-config")) {\n      const r = await apiPutLlmConfig'), /probe: r\.probe/);
  assert.match(route('path.endsWith("/admin/llm-config/rollback")'), /probe: r\.probe/);
});

/* ───────────────── IM 那条 Bedrock 链路 ───────────────── */
console.log("save-time probe of the IM Bedrock source while the gateway is on top");

await t("moving the gateway on top also probes the Bedrock source IM will use", async () => {
  seedGateway(); seedBedrockKey();
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  state.route = () => okChat();
  state.converseError = "AccessDeniedException";
  const r = await mod.apiPutLlmConfig(TO_GATEWAY(), ACTOR);    // IM 从 iam 换到 api_key
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.deepEqual(r.probe, { source: "api_key", model_id: "global.moonshotai.kimi-k3",
                              alias: "moonshot-kimi-k3", result: "forbidden" });
  assert.equal(state.item.credential_mode, "iam", "nothing changed");
});

await t("a transient IM probe failure only warns", async () => {
  seedGateway(); seedBedrockKey();
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  state.route = () => okChat();
  state.converseError = "ThrottlingException";
  const r = await mod.apiPutLlmConfig(TO_GATEWAY(), ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.match(r.warning || "", /IM default/);
  assert.equal(state.item.credential_mode, "gateway");
});

await t("an unchanged IM route is not re-probed on a catalogue save", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...TO_GATEWAY(), generation: 1000 };
  state.route = () => okChat();
  state.converseError = "AccessDeniedException";              // 若被探到就会 400
  const c = TO_GATEWAY(); c.models[2].label = "Qwen3 renamed";
  const r = await mod.apiPutLlmConfig(c, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
});

await t("changing the IM Bedrock default while the gateway stays on top is probed", async () => {
  seedGateway(); seedBedrockKey();
  const before = TO_GATEWAY();
  before.models.push(BEDROCK({ alias: "glm-5-3", short: null, model_id: "global.zai.glm-5.3", label: "GLM 5.3" }));
  state.item = { PK: "llmcfg", SK: "meta", ...before, generation: 1000 };
  state.route = () => okChat();
  state.converseError = "AccessDeniedException";
  const c = structuredClone(before);
  c.source_defaults = { ...c.source_defaults, api_key: "glm-5-3" };
  const r = await mod.apiPutLlmConfig(c, ACTOR);
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.equal(r.probe?.alias, "glm-5-3", JSON.stringify(r));
  assert.equal(r.probe?.source, "api_key");
});

await t("IM landing on an unconfigured Bedrock API key is refused as not_configured (no IAM fallback probe)", async () => {
  // 以前这一条只有前端 needImSourceConfigured 在挡：服务端经 probeCredential 回退部署角色去探，判 ok 照存
  // —— 直接调 API / 老前端就能把 IM 存到一把没配的 Key 上，运行时再静默退回 IAM（不自动降级的反面）。
  seedGateway();                                              // 只有网关，没有 Bedrock Key
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  state.route = () => okChat();
  const r = await mod.apiPutLlmConfig(TO_GATEWAY(), ACTOR);   // IM 从 iam 换到 api_key
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.deepEqual(r.probe, { source: "api_key", model_id: "global.moonshotai.kimi-k3",
                              alias: "moonshot-kimi-k3", result: "not_configured" });
  assert.match(r.error, /not_configured/);
  assert.equal(state.item.generation, 1000, "nothing written");
});

await t("a Bedrock key secret read failure on the IM probe only warns", async () => {
  seedGateway();
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  state.route = () => okChat();
  const realSend = fakeSm.send;
  fakeSm.send = async (cmd) => {
    if ((cmd.input.SecretId || cmd.input.Name) === KEY_SECRET) throw Object.assign(new Error("x"), { name: "InternalServiceError" });
    return realSend(cmd);
  };
  try {
    const r = await mod.apiPutLlmConfig(TO_GATEWAY(), ACTOR);
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.match(r.warning || "", /IM default moonshot-kimi-k3 could not be verified right now \(error\)/);
    assert.equal(state.item.credential_mode, "gateway");
  } finally { fakeSm.send = realSend; }
});

await t("testing the api_key source without a key says so instead of using the role", async () => {
  state.item = { PK: "llmcfg", SK: "meta", ...CFG(), generation: 1000 };
  const r = await mod.apiTestLlmModel({ model_id: "global.moonshotai.kimi-k3", kind: "bedrock_converse",
                                        source: "api_key" });
  assert.equal(r.result, "not_configured");
});

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
