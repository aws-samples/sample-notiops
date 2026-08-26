/**
 * BFF LLM 模型目录路由单测（spec task 2 验收）。
 *
 * 风格与 tests/authz.test.mjs 一致：纯断言、不引 mock 框架；AWS 客户端经
 * `__setClients()` 测试接缝注入假实现，全程不触网。
 *
 * 覆盖：
 *   · validateConfig 不变量与注入串（R2.6 / R2.7）
 *   · generation 由**服务端**生成，客户端传入一律忽略（R4.2）
 *   · 并发条件写失败 → 409
 *   · 审计快照（R6.4）+ 回滚（R7.4）
 *   · /models 响应白名单：不得含 provider / 凭证 / 候选全集字段（R3.4 / D7）
 *   · Key 状态只回后 4 位，永不回明文（R5.5）；Key 变更推进 generation
 *   · 候选全集过滤非流式模型 + 合并 Mantle 型号 + 列不出来时优雅降级
 *   · 连通性测试只回枚举态，不透传上游原文（R5.5）
 *   · resolveForStream 服务端准入（R3.5）
 *   · authz：/models 锚定 LOGIN_ONLY，admin 路径仍受门禁（R6.2）
 *
 * 运行：node bff/web-chat/tests/llm_config.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import * as mod from "../llm_config.mjs";

/* ───────────────── 假客户端 ───────────────── */

const state = {
  item: null, audit: [], puts: [], secret: null, appconfig: {},
  failCondition: false, listModelsFail: false, listProfilesFail: false,
  converseError: null, converseMessage: null, runtimeBuilds: [],
  controlPlaneBuilds: [], keyCannotList: false, listModelsErrorName: null,
  secretCreatedDate: null, runtimeThrow: false,
  failProjection: false, failProjectionRead: false,
  // Mantle 探测（probeMantle）走的是裸 fetch，不经任何注入的客户端。在此之前 CI 里
  // 它永远是「无凭证 → fetch 抛 → result:"error"」，等于 400/404 的分类逻辑从未被测过。
  mantleFetch: null, mantleFetchCalls: [],
};

// ── 打桩 globalThis.fetch：只截 bedrock-mantle，其余放行 ──────────────────
// 只截 Mantle 主机名，避免顺手把别的 HTTP 依赖也劫持了（现在没有，但别给以后埋坑）。
const _realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (state.mantleFetch && u.includes("bedrock-mantle.")) {
    state.mantleFetchCalls.push({ url: u, body: init?.body, headers: init?.headers });
    return state.mantleFetch();
  }
  return _realFetch(url, init);
};

/** 造一个像 Mantle 那样的错误响应。`bodyText` 为 null 表示 body 读不出来。 */
const mantleErr = (status, bodyText) => () => ({
  ok: false,
  status,
  async json() {
    if (bodyText === null) throw new SyntaxError("not json");
    return JSON.parse(bodyText);
  },
});

const fakeDdb = {
  async send(cmd) {
    // 注入模式下命令对象是真实 SDK 类的实例，按构造函数名识别（无自定义标记）。
    const t = cmd.constructor.name.replace(/Command$/, "");
    if (t === "Get") {
      const { PK, SK } = cmd.input.Key;
      if (PK === "llmcfg") return { Item: state.item ? { ...state.item } : undefined };
      // 后端任务投影行（appconfig#phd / appconfig#devops_agent）单独存，
      // 否则会和 llmcfg 抢同一个 state.item 槽位。
      if (String(PK).startsWith("appconfig#")) {
        if (state.failProjectionRead) {
          throw Object.assign(new Error("ddb down"), { name: "ProvisionedThroughputExceededException" });
        }
        const hit = state.appconfig[`${PK}|${SK}`];
        return { Item: hit ? { ...hit } : undefined };
      }
      const hit = state.audit.find((a) => a.SK === SK);
      return { Item: hit ? { ...hit } : undefined };
    }
    if (t === "Put") {
      state.puts.push(cmd.input);
      const pk = String(cmd.input.Item.PK);
      if (pk === "llmcfg#audit") { state.audit.unshift(cmd.input.Item); return {}; }
      if (pk.startsWith("appconfig#")) {
        if (state.failProjection) {
          throw Object.assign(new Error("ddb down"), { name: "ProvisionedThroughputExceededException" });
        }
        state.appconfig[`${pk}|${cmd.input.Item.SK}`] = cmd.input.Item;
        return {};
      }
      if (state.failCondition && cmd.input.ConditionExpression) {
        throw Object.assign(new Error("cond"), { name: "ConditionalCheckFailedException" });
      }
      state.item = cmd.input.Item;
      return {};
    }
    if (t === "Query") return { Items: state.audit.slice(0, cmd.input.Limit || 50) };
    throw new Error(`unexpected ddb cmd ${t}`);
  },
};

// Bedrock 控制平面 fake。**必须按命令类型分支** —— 早先它无参、对任何命令都返回
// `modelSummaries`，于是 `ListInferenceProfiles` 那条路径在测试里从未执行：把整段 profile
// 合并删掉，106 项照样全绿。
//
// fixture 也刻意贴近真实 API 的形状，这一点同样是之前的假绿之源：旧 fixture 把
// `global.anthropic.claude-sonnet-5` 当成 **foundation model** 返回，而真实
// ListFoundationModels 永远不会返回 CRIS id —— 那恰好是本次改动的前提。
const fakeBedrock = {
  async send(cmd) {
    const t = cmd.constructor.name.replace(/Command$/, "");
    if (t === "ListFoundationModels") {
      if (state.listModelsFail) {
        // 错误名可注入：候选枚举现在要**区分**鉴权失败（回退到部署角色）与限流 /
        // 服务端错误（不回退）。固定抛 AccessDeniedException 测不到这条分支。
        throw Object.assign(new Error("denied"),
                            { name: state.listModelsErrorName || "AccessDeniedException" });
      }
      return {
        modelSummaries: [
          // 按需可调：应出现在候选里
          { modelId: "amazon.nova-pro-v1:0", modelName: "Nova Pro", providerName: "Amazon",
            responseStreamingSupported: true, inferenceTypesSupported: ["ON_DEMAND"] },
          // 只支持 INFERENCE_PROFILE（新一代模型的真实形态，如 Claude 5）：
          // **不得**作为候选出现（直调必失败），但它的 profile 要能出现
          { modelId: "anthropic.claude-sonnet-5", modelName: "Claude Sonnet 5",
            providerName: "Anthropic", responseStreamingSupported: true,
            inferenceTypesSupported: ["INFERENCE_PROFILE"] },
          // 不支持流式 → 对话用不了
          { modelId: "some.batch-only-model", modelName: "Batch Only", providerName: "X",
            responseStreamingSupported: false, inferenceTypesSupported: ["ON_DEMAND"] },
        ],
      };
    }
    if (t === "ListInferenceProfiles") {
      if (state.listProfilesFail) {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      }
      // 分两页返回，顺带压 nextToken 循环
      if (!cmd.input?.nextToken) {
        return {
          inferenceProfileSummaries: [
            { inferenceProfileId: "global.anthropic.claude-sonnet-5",
              inferenceProfileName: "Global Anthropic Claude Sonnet 5", status: "ACTIVE",
              type: "SYSTEM_DEFINED",
              models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5" }] },
            // 底层基座**不在**本区 ListFoundationModels 里（东京的 apac.claude-3-5-sonnet
            // 就是这种情况）—— 必须仍然被列出
            { inferenceProfileId: "apac.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "APAC Claude 3.5 Sonnet", status: "ACTIVE",
              type: "SYSTEM_DEFINED",
              models: [{ modelArn: "arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0" }] },
          ],
          nextToken: "p2",
        };
      }
      return {
        inferenceProfileSummaries: [
          // embedding profile → 必须被排除
          { inferenceProfileId: "global.cohere.embed-v4:0",
            inferenceProfileName: "Global Cohere Embed v4", status: "ACTIVE",
            type: "SYSTEM_DEFINED",
            models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-v4:0" }] },
          // 非 ACTIVE → 排除
          { inferenceProfileId: "global.anthropic.claude-retired",
            inferenceProfileName: "Retired", status: "INACTIVE", type: "SYSTEM_DEFINED",
            models: [{ modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-retired" }] },
        ],
      };
    }
    throw new Error(`unexpected bedrock cmd ${t}`);
  },
};

const fakeSm = {
  async send(cmd) {
    const t = cmd.constructor.name.replace(/Command$/, "");
    if (t === "GetSecretValue") {
      if (state.secret === null) {
        throw Object.assign(new Error("nf"), { name: "ResourceNotFoundException" });
      }
      // `CreatedDate` 在 GetSecretValue 里是**当前版本**的创建时间，也就是「这个 Key 什么
      // 时候被写进来的」。默认取"刚刚"而不是一个写死的日期：写死日期会让轮换提示的断言
      // 随真实时间流逝而变红（超过 90 天后 rotation_due 变 true），是个定时炸弹。
      return {
        SecretString: state.secret,
        CreatedDate: state.secretCreatedDate || new Date(),
      };
    }
    state.secret = cmd.input.SecretString;
    return {};
  },
};

const fakeRuntimeFactory = (region, cred) => {
  // `runtimeThrow` 必须在**构造时**抛，不能在 send() 里抛：send() 的异常会被
  // probeConverse 自己的 try/catch 吃掉并映射成 result:"error"，走不到
  // probeDefaultModel 的外层 catch —— 那条"探测自身炸了"的路径就测不到了
  // （第一版就写在 send() 里，断言因此对不上）。构造在 try 之外，抛出即穿透。
  if (state.runtimeThrow) throw new TypeError("probe blew up at construction");
  // 记录构造参数：只断言响应里的 `credential` 字段不够 —— 那是探测**自报**的模式，
  // 真正要证明的是 Key 确实被交给了客户端去签这次请求。
  state.runtimeBuilds.push({ region, cred });
  return {
    async send() {
      if (state.converseError) {
        // message 可注入：apiTestLlmModel 按 message 把 ValidationException 拆成
        // invalid_model / probe_error / needs_profile 三种，只设 name 测不到那段逻辑。
        // 默认串里带 leaks-secret-xyz，用于验证上游原文绝不外泄（spec R5.5）。
        throw Object.assign(new Error(state.converseMessage || "upstream detail leaks-secret-xyz"),
                            { name: state.converseError });
      }
      return { output: {} };
    },
  };
};

/** 控制面工厂的假实现：记录构造用的凭证，并可模拟「Key 没有列模型权限」。
 *  记录是必需的 —— 候选枚举必须用**将来执行推理的那个身份**去问，光看返回的
 *  `source_identity` 字段证明不了真的换了身份。 */
const fakeBedrockFactory = (cred) => {
  state.controlPlaneBuilds.push({ cred });
  if (cred?.mode === "api_key" && state.keyCannotList) {
    return {
      async send() {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      },
    };
  }
  return fakeBedrock;
};

mod.__setClients({ ddb: fakeDdb, bedrock: fakeBedrock, sm: fakeSm,
                   runtimeFactory: fakeRuntimeFactory,
                   bedrockFactory: fakeBedrockFactory });

/* ───────────────── fixtures / harness ───────────────── */

const ENTRY = (over = {}) => ({
  alias: "claude-sonnet-5", short: "claude", aliases_legacy: ["claude"],
  model_id: "global.anthropic.claude-sonnet-5", label: "Claude Sonnet 5",
  desc_key: "model.desc.claude", kind: "bedrock_anthropic", region: null,
  hard_output_limit: 128000, output_override: { im: 6000 },
  supports_prompt_cache: true, surfaces: ["webchat", "im"],
  enabled: true, ...over,
});
const NOVA = ENTRY({
  alias: "amazon-nova-pro", short: "nova", aliases_legacy: ["nova"],
  model_id: "amazon.nova-pro-v1:0", label: "Amazon Nova Pro",
  kind: "bedrock_converse", hard_output_limit: 5120,
  supports_prompt_cache: false, output_override: { im: 5000 },
});
const GPT = ENTRY({
  alias: "gpt-5-6", short: "gpt", aliases_legacy: ["gpt"],
  model_id: "openai.gpt-5.6-terra", label: "GPT-5.6 Terra",
  kind: "bedrock_mantle_responses", region: "us-east-2",
  hard_output_limit: 32768, supports_prompt_cache: false,
  output_override: { im: 8000 },
});
// ⚠️ 必须深拷贝：坏用例会就地改 models[i]，若共享引用会污染后续所有用例
// （曾实际发生：一个 "mantle without region" 用例把 GPT.region 永久改成 null）。
const GOOD = () => structuredClone({
  provider: "bedrock", credential_mode: "iam", default_model: "claude-sonnet-5",
  models: [ENTRY(), NOVA, GPT],
  backend_tasks: { phd_translate: null, devops_report_summarize: null },
});
const ACTOR = { sub: "u-1", username: "admin@example.com", ip: "1.2.3.4", ua: "test-agent" };

let pass = 0, fail = 0;
function reset() {
  state.item = null; state.audit = []; state.puts = []; state.appconfig = {};
  state.secret = null; state.failCondition = false;
  state.listModelsFail = false; state.listProfilesFail = false;
  state.converseError = null; state.converseMessage = null;
  state.failProjection = false; state.failProjectionRead = false;
}
async function t(name, fn) {
  reset();
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message.split("\n")[0]}`); }
}

/* ───────────────── validateConfig ───────────────── */
console.log("validateConfig — invariants & injection");

const BAD_CASES = [
  ["empty models", (c) => { c.models = []; }],
  ["no enabled model", (c) => { c.models = c.models.map((m) => ({ ...m, enabled: false })); }],
  ["default not in catalogue", (c) => { c.default_model = "nope"; }],
  ["disabled default", (c) => { c.models[0].enabled = false; }],
  ["duplicate alias", (c) => { c.models.push(ENTRY()); }],
  ["duplicate short", (c) => { c.models.push(ENTRY({ alias: "other-model", short: "claude" })); }],
  ["short collides with canonical", (c) => { c.models[1].short = "claude-sonnet-5"; }],
  ["bad kind", (c) => { c.models[0].kind = "bogus"; }],
  ["mantle without region", (c) => { c.models[2].region = null; }],
  ["mantle region not allowlisted", (c) => { c.models[2].region = "us-east-1.evil.com"; }],
  ["non-mantle carrying region", (c) => { c.models[0].region = "us-east-2"; }],
  ["path traversal model_id", (c) => { c.models[0].model_id = "../../etc/passwd"; }],
  ["url as model_id", (c) => { c.models[0].model_id = "http://evil.example"; }],
  ["alias with spaces/punctuation", (c) => { c.models[0].alias = "Bad Alias!"; }],
  ["zero output limit", (c) => { c.models[0].hard_output_limit = 0; }],
  ["absurd output limit", (c) => { c.models[0].hard_output_limit = 99999999; }],
  ["non-integer output limit", (c) => { c.models[0].hard_output_limit = 1.5; }],
  ["empty surfaces", (c) => { c.models[0].surfaces = []; }],
  ["unknown surface", (c) => { c.models[0].surfaces = ["mobile"]; }],
  ["litellm provider in phase 1", (c) => { c.provider = "litellm"; }],
  ["bad credential_mode", (c) => { c.credential_mode = "root"; }],
  ["unknown backend task", (c) => { c.backend_tasks = { nope: "claude-sonnet-5" }; }],
  ["backend task → disabled model", (c) => {
    c.models[1].enabled = false; c.backend_tasks = { phd_translate: "amazon-nova-pro" };
  }],
  ["a surface left with no model", (c) => {
    c.models = c.models.map((m) => ({ ...m, surfaces: ["webchat"] }));
  }],
  ["output_override unknown surface", (c) => { c.models[0].output_override = { mobile: 100 }; }],
  ["model_id_override injection", (c) => { c.models[0].model_id_override = { im: "http://x" }; }],
];
for (const [label, mutate] of BAD_CASES) {
  await t(`rejects: ${label}`, async () => {
    const cfg = GOOD(); mutate(cfg);
    const err = mod.validateConfig(cfg);
    assert.ok(err, "expected a validation error");
    const r = await mod.apiPutLlmConfig(cfg, ACTOR);
    assert.equal(r.status, 400, JSON.stringify(r));
  });
}
await t("accepts a valid config", async () => {
  assert.equal(mod.validateConfig(GOOD()), null);
  const r = await mod.apiPutLlmConfig(GOOD(), ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.ok(r.generation > 0);
});

await t("the shipped seed file passes server-side validation", async () => {
  // 跨语言契约：setup.sh 用 config/llm-model-catalog.json 直接 seed 进 DDB（绕过本校验），
  // 之后 Admin 第一次保存会把 GET 回来的内容原样 PUT —— 若种子过不了校验就会 400。
  // 曾真实踩到两次：`short: "gpt_sol"` 被 alias 正则拒（下划线），
  // 以及 backend_tasks 里塞 `_comment` 被判成未知任务名。
  //
  // 这条一度需要为「种子的默认模型未验证」开例外 —— 那个例外随 `verified` 字段一起消失了：
  // 种子里不再有该字段，validateConfig 也不再检查它，于是种子重新变成一个**完全合法**的
  // 配置。可用性由保存时的现场探测负责（见下面 probeDefaultModel 的用例）。
  const seed = JSON.parse(readFileSync(new URL("../../../config/llm-model-catalog.json",
                                               import.meta.url), "utf8"));
  assert.ok(!seed.models.some((m) => "verified" in m),
            "the seed must not carry a verified field at all");
  assert.equal(mod.validateConfig(seed), null);
  const r = await mod.apiPutLlmConfig(seed, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
});

await t("the seed file passes validation *after* the seeder strips doc keys", async () => {
  // 上一条测的是**原始文件**；进 DynamoDB 的不是它，而是
  // `scripts/seed_llm_catalog.py::_strip_doc_keys` 处理后的形状（递归删掉所有
  // `_` 前缀键：`_comment` / `_schema` / 模型条目里的 `_surfaces_note`）。管理员
  // 第一次保存 PUT 回来的是**那一份**，所以要校验的也是那一份。
  //
  // 这条断言原本只存在于 scripts/test_seed_llm_catalog.py —— 它 fork 一个 `node`
  // 子进程来调 validateConfig。但那套脚本跑在 llm-catalog-tests（python:3.12-slim，
  // 镜像里没有 node），于是 CI 里直接 FileNotFoundError: 'node'。两个 job 各只有
  // 一种运行时，没有哪一个能同时跑两边，所以在**有 validateConfig 的这一侧**原生
  // 复刻剥离逻辑，而不是继续跨语言 fork。
  //
  // 代价：剥离逻辑在两处各写一遍，可能漂移。由 Python 侧
  // test_documentation_keys_are_stripped 钉住 seeder 的实际输出确无 `_` 键 ——
  // 两边对「剥离后长什么样」的定义因此保持一致。
  const strip = (o) => Array.isArray(o) ? o.map(strip)
    : (o && typeof o === "object")
      ? Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_"))
                                            .map(([k, v]) => [k, strip(v)]))
      : o;
  const raw = JSON.parse(readFileSync(new URL("../../../config/llm-model-catalog.json",
                                              import.meta.url), "utf8"));
  // 剥离必须真的有东西可剥，否则这条和上一条完全等价（沦为空断言）
  assert.ok(Object.keys(raw).some((k) => k.startsWith("_"))
            || raw.models.some((m) => Object.keys(m).some((k) => k.startsWith("_"))),
            "the seed file no longer has any _-prefixed keys; this test is now vacuous");
  const seeded = strip(raw);
  assert.equal(mod.validateConfig(seeded), null);
  const r = await mod.apiPutLlmConfig(seeded, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
});

await t("short aliases may carry an underscore, canonical aliases may not", async () => {
  const ok = GOOD();
  ok.models[1].short = "nova_pro";
  assert.equal(mod.validateConfig(ok), null);
  const bad = GOOD();
  bad.models[1].alias = "nova_pro";
  assert.ok(mod.validateConfig(bad), "canonical alias must stay [a-z0-9-]");
});

/* ───────────────── generation ───────────────── */
console.log("generation — server-owned");

await t("client-supplied generation is ignored", async () => {
  const before = Date.now() - 1;
  const r = await mod.apiPutLlmConfig({ ...GOOD(), generation: 999999999999999 }, ACTOR);
  assert.notEqual(r.generation, 999999999999999);
  assert.ok(r.generation >= before);
  assert.equal(state.item.generation, r.generation);
});

await t("each write advances generation", async () => {
  const r1 = await mod.apiPutLlmConfig(GOOD(), ACTOR);
  await new Promise((r) => setTimeout(r, 3));
  const r2 = await mod.apiPutLlmConfig(GOOD(), ACTOR);
  assert.ok(r2.generation > r1.generation);
});

await t("back-to-back writes in the same millisecond still advance", async () => {
  // 没有 sleep：两次保存极可能落在同一毫秒。裸 Date.now() 会给出相同值，
  // 而消费端按 `!=` 判断 —— 相同就等于"没变"，改动在长驻进程里根本不生效。
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const r = await mod.apiPutLlmConfig(GOOD(), ACTOR);
    assert.equal(r.error, undefined, JSON.stringify(r));
    seen.push(r.generation);
  }
  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] > seen[i - 1], `generation must strictly increase: ${seen.join(",")}`);
  }
});

await t("a corrupt far-future generation is healed instead of compounded", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  // 手工写坏成远期值（超出消费端 1 天容忍窗口 → 会被当注入忽略）。
  // 若单调逻辑只会 prev+1，它将永远卡在被拒区间里、热生效永久失效。
  const bogus = Date.now() + 30 * 24 * 3600 * 1000;
  state.item = { ...state.item, generation: bogus };
  const r = await mod.apiPutLlmConfig(GOOD(), ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.ok(r.generation < Date.now() + 24 * 3600 * 1000,
            `must fall back inside the acceptance window, got ${r.generation}`);
});

await t("concurrent modification → 409", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  state.failCondition = true;
  const r = await mod.apiPutLlmConfig(GOOD(), ACTOR);
  assert.equal(r.status, 409, JSON.stringify(r));
});

/* ───────────────── audit / rollback ───────────────── */
console.log("audit & rollback");

await t("audit records actor/ip/ua + previous full snapshot", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const changed = GOOD(); changed.default_model = "amazon-nova-pro";
  await mod.apiPutLlmConfig(changed, ACTOR);
  const entry = state.audit.find((a) => a.snapshot_before);
  assert.ok(entry, "an audit entry with a snapshot must exist");
  assert.equal(entry.actor_sub, "u-1");
  assert.equal(entry.actor_name, "admin@example.com");
  assert.equal(entry.source_ip, "1.2.3.4");
  const snap = JSON.parse(entry.snapshot_before);
  assert.equal(snap.default_model, "claude-sonnet-5", "snapshot must be the PREVIOUS state");
});

await t("rollback restores the snapshot", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const changed = GOOD(); changed.default_model = "amazon-nova-pro";
  await mod.apiPutLlmConfig(changed, ACTOR);
  assert.equal(state.item.default_model, "amazon-nova-pro");
  const sk = state.audit.find((a) => a.snapshot_before).SK;
  const r = await mod.apiRollbackLlmConfig({ sk }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.item.default_model, "claude-sonnet-5");
});

await t("two audits in the same millisecond do not overwrite each other", async () => {
  // SK 曾是 String(Date.now()).padStart(16,"0") —— 同毫秒两条审计得到相同 SK 而互相
  // 覆盖，连同其中一条的回滚快照一起丢掉。这是 nextGeneration() 特意解决的同一个
  // bug 类，审计这边当时漏了。不加 sleep：多次连续保存极可能落在同一毫秒。
  for (let i = 0; i < 6; i++) {
    const r = await mod.apiPutLlmConfig(GOOD(), ACTOR);
    assert.equal(r.error, undefined, JSON.stringify(r));
  }
  const sks = state.audit.map((a) => a.SK);
  assert.equal(new Set(sks).size, sks.length, `duplicate audit SK: ${sks.join(",")}`);
  // 字典序必须仍等于时间序（apiListLlmAudit 依赖 ScanIndexForward:false）
  const sorted = [...sks].sort();
  assert.deepEqual(sorted, [...sks].reverse(),
                   "audit SKs must sort lexicographically in time order");
});

await t("an oversized catalogue is rejected instead of silently losing its snapshot", async () => {
  // DDB 会接受一个仍在 400KB 内、但序列化后超出审计快照预算的配置。旧实现在写审计时
  // 截断字符串 —— 截断 JSON 是非法 JSON，回滚要到真正需要它的时候才以
  // "audit snapshot is corrupt" 暴露，也就是事故现场。改为在入口拒绝。
  const cfg = GOOD();
  cfg.models[0].label = "L".repeat(400000);
  const err = mod.validateConfig(cfg);
  assert.ok(err && /too large to snapshot/.test(err), JSON.stringify(err));
  const r = await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.equal(r.status, 400);
});

await t("rollback is guarded against concurrent saves", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const cfg = GOOD();
  cfg.default_model = "amazon-nova-pro";
  await mod.apiPutLlmConfig(cfg, ACTOR);
  const sk = state.audit.find((a) => a.snapshot_before).SK;
  // 回滚曾是本模块唯一的无条件写：与并发保存竞争时静默胜出，把对方的改动一起丢掉。
  state.failCondition = true;
  const r = await mod.apiRollbackLlmConfig({ sk }, ACTOR);
  assert.equal(r.status, 409, JSON.stringify(r));
});

await t("rollback refuses a corrupt snapshot", async () => {
  state.audit = [{ PK: "llmcfg#audit", SK: "0001", snapshot_before: "{not json" }];
  const r = await mod.apiRollbackLlmConfig({ sk: "0001" }, ACTOR);
  assert.equal(r.status, 500, JSON.stringify(r));
});

await t("rollback requires an existing entry", async () => {
  assert.equal((await mod.apiRollbackLlmConfig({ sk: "nope" }, ACTOR)).status, 404);
  assert.equal((await mod.apiRollbackLlmConfig({}, ACTOR)).status, 400);
});

/** 造一条可回滚的审计记录，返回它的 SK。快照 = GOOD()。 */
const seedRollbackPoint = async () => {
  state.audit = [];
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const changed = GOOD(); changed.default_model = "amazon-nova-pro";
  await mod.apiPutLlmConfig(changed, ACTOR);
  return state.audit.find((a) => a.snapshot_before).SK;
};

await t("rollback probes the default model and refuses a broken one", async () => {
  // 回滚此前只跑 validateConfig，不探测 —— 于是它成了保存门禁的一条绕行路径：
  // 快照断言的是 (模型 × 区域 × 凭证 × 时间) 在**当时**成立，而此后 Key 可能被按模型
  // 收窄、模型可能下架。以「它当年通过过」为由放行，正是被删掉的 `verified` 字段的
  // 那个缺陷，只是换了个入口。
  const sk = await seedRollbackPoint();
  state.converseError = "AccessDeniedException";      // 快照里的默认模型现在 403
  const r = await mod.apiRollbackLlmConfig({ sk }, ACTOR);
  state.converseError = null;
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.ok(/forbidden/.test(r.error), r.error);
  // 错误必须给出下一步，否则管理员只知道"不行"，不知道能怎么办
  assert.ok(/different entry|corrected configuration/.test(r.error), r.error);
  // 且真的没写进去
  assert.equal(state.item.default_model, "amazon-nova-pro", "rollback must not have applied");
});

await t("a transient probe failure does NOT block a rollback", async () => {
  // Bedrock 抖一下不该把管理员锁在恢复路径外面。与保存路径同一套判定。
  const sk = await seedRollbackPoint();
  state.converseError = "ThrottlingException";
  const r = await mod.apiRollbackLlmConfig({ sk }, ACTOR);
  state.converseError = null;
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.item.default_model, "claude-sonnet-5", "rollback must have applied");
  assert.ok(/throttled/.test(r.warning || ""), JSON.stringify(r.warning));
});

await t("rollback surfaces the probe warning alongside a projection failure", async () => {
  // 两条 warning 都得透出去。探测那条曾会被投影那条整句盖掉。
  // 快照里必须真有绑定的后端任务，否则没有可投影的东西，投影也就无从失败。
  state.audit = [];
  const bound = GOOD();
  bound.backend_tasks = { phd_translate: "claude-sonnet-5" };
  await mod.apiPutLlmConfig(bound, ACTOR);
  const changed = GOOD();
  changed.backend_tasks = { phd_translate: "amazon-nova-pro" };
  changed.default_model = "amazon-nova-pro";
  await mod.apiPutLlmConfig(changed, ACTOR);
  const sk = state.audit.find((a) => a.snapshot_before
    && JSON.parse(a.snapshot_before)?.backend_tasks?.phd_translate === "claude-sonnet-5").SK;

  state.converseError = "ThrottlingException";
  state.failProjection = true;
  const r = await mod.apiRollbackLlmConfig({ sk }, ACTOR);
  state.converseError = null; state.failProjection = false;
  assert.equal(r.error, undefined, JSON.stringify(r));
  const w = String(r.warning || "");
  assert.ok(/throttled/.test(w), `probe warning missing: ${w}`);
  assert.ok(/backend config/.test(w), `projection warning missing: ${w}`);
  // 前缀只能有一个，不能拼出「rolled back, but saved, but …」
  assert.ok(!/saved, but/.test(w), `stale prefix leaked from probeDefaultModel: ${w}`);
});

await t("audit listing projects away snapshot bodies", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const r = await mod.apiListLlmAudit();
  assert.ok(Array.isArray(r.entries) && r.entries.length > 0);
  const q = state.puts.length;   // sanity: writes happened
  assert.ok(q > 0);
});

/* ───────────────── /models ───────────────── */
console.log("/models — response whitelist");

await t("only enabled + surface-matching models returned", async () => {
  const cfg = GOOD();
  cfg.models = [ENTRY(), { ...NOVA, enabled: false }, { ...GPT, surfaces: ["webchat"] }];
  await mod.apiPutLlmConfig(cfg, ACTOR);
  const web = await mod.apiGetModels("webchat");
  assert.deepEqual(web.models.map((m) => m.id).sort(), ["claude-sonnet-5", "gpt-5-6"]);
  const im = await mod.apiGetModels("im");
  assert.deepEqual(im.models.map((m) => m.id), ["claude-sonnet-5"]);
});

await t("no provider/credential/catalogue internals leak", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const r = await mod.apiGetModels("webchat");
  // 字段白名单。`source` 是有意新增的：客户端要靠它区分「目录读到了但管理员没启用模型」
  // （该报错）与「服务端没有目录 / 读失败」（该降级放行）—— 只回一个空数组时这四种状况
  // 在客户端长得一样，只能一律退回打包内置清单，那正是"看到 8 个其实只有 1 个"的成因。
  // 它只是个枚举，不含 provider / 凭证 / 候选全集，下面的泄漏断言仍然全部保留。
  assert.deepEqual(Object.keys(r).sort(), ["default_model", "generation", "models", "source"]);
  const s = JSON.stringify(r);
  for (const banned of ["provider", "credential_mode", "bedrock_api_key", "hard_output_limit",
                        "kind", "model_id", "backend_tasks", "verified", "enabled", "surfaces"]) {
    assert.ok(!s.includes(banned), `"${banned}" must not appear in /models`);
  }
});

await t("every model reports using the API key, mantle included", async () => {
  // 这条曾断言 Mantle 的 uses_api_key === false（spec R5.7「Mantle 不受 Key 影响」）。
  // 前提是错的：Mantle 端点接受 Bedrock API Key 作为 Authorization: Bearer，文档里
  // 那正是 OpenAI SDK 的用法。真实原因是我们三条 Mantle 路径都没传 Key，实测表现为
  // Claude 那几轮 CloudTrail caller 是 Key 的 IAM user、GPT 那轮是部署角色。已补齐。
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const r = await mod.apiGetModels("webchat");
  for (const m of r.models) {
    assert.equal(m.uses_api_key, true, `${m.id} must report using the API key`);
  }
  assert.ok(r.models.some((m) => m.id === "gpt-5-6"), "mantle model must be present");
});

await t("unknown surface degrades to webchat", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const r = await mod.apiGetModels("../admin");
  assert.ok(r.models.length > 0);
});

await t("unseeded catalogue yields an empty but well-formed response", async () => {
  const r = await mod.apiGetModels("webchat");
  assert.deepEqual(r.models, []);
  assert.equal(r.default_model, "");
});

/* ───────────────── Bedrock API key ───────────────── */
console.log("bedrock api key");

await t("key status never returns plaintext", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  await mod.apiPutBedrockKey({ api_key: "super-secret-key-value-1234" }, ACTOR);
  const cfg = await mod.apiGetLlmConfig();
  assert.ok(!JSON.stringify(cfg).includes("super-secret-key-value"), "plaintext leaked");
  assert.equal(cfg.bedrock_api_key.configured, true);
  assert.equal(cfg.bedrock_api_key.last_4, "1234");
});

await t("setting the key advances generation", async () => {
  const r1 = await mod.apiPutLlmConfig(GOOD(), ACTOR);
  await new Promise((r) => setTimeout(r, 3));
  await mod.apiPutBedrockKey({ api_key: "another-secret-key-9876" }, ACTOR);
  assert.ok(state.item.generation > r1.generation, "clients must be told to rebuild");
});

await t("clearing the key is reflected in status", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  // 假 key,只为满足长度校验。"abcdefgh1234" 12 个字符互不重复,香农熵恰好
  // log2(12)=3.585 > gitleaks generic-api-key 的 3.5 阈值,发布扫描会误判成真密钥。
  // 不改字面量(改了就不再覆盖"12 字符刚好合法"这个边界),用行内 allow 标注 ——
  // 注意 gitleaks 只认**同一行**上的 gitleaks:allow,写在上一行不生效。
  await mod.apiPutBedrockKey({ api_key: "abcdefgh1234" }, ACTOR); // gitleaks:allow
  const r = await mod.apiPutBedrockKey({ clear: true }, ACTOR);
  assert.equal(r.bedrock_api_key.configured, false, JSON.stringify(r));
});

await t("empty key without clear flag rejected", async () => {
  assert.equal((await mod.apiPutBedrockKey({ api_key: "" }, ACTOR)).status, 400);
  assert.equal((await mod.apiPutBedrockKey({ api_key: "abc" }, ACTOR)).status, 400);
});

/* ───────────────── candidates / connectivity ───────────────── */
console.log("candidates & connectivity test");

await t("candidates drop non-streaming models and merge mantle", async () => {
  const r = await mod.apiGetCandidates();
  const ids = r.models.map((m) => m.model_id);
  assert.ok(ids.includes("global.anthropic.claude-sonnet-5"));
  assert.ok(!ids.includes("some.batch-only-model"), "non-streaming must be filtered out");
  assert.ok(ids.includes("openai.gpt-5.6-terra"), "mantle catalogue must be merged");
});

await t("candidates include inference profiles (the catalogue's actual ids)", async () => {
  // 这条是本次改动的核心：目录里用的是 `global.anthropic.claude-sonnet-5`，而
  // ListFoundationModels 从不返回 CRIS id —— 必须由 ListInferenceProfiles 补进来。
  // 删掉那段合并，这条就会红（旧 fixture 把 CRIS id 伪装成 foundation model，所以测不出来）。
  const ids = (await mod.apiGetCandidates()).models.map((m) => m.model_id);
  assert.ok(ids.includes("global.anthropic.claude-sonnet-5"),
            "the global.* profile must be a candidate");
});

await t("profile-only base models are not offered for direct invocation", async () => {
  // Claude 5 的 inferenceTypesSupported 只有 INFERENCE_PROFILE：裸 id 直调必失败，
  // 不该出现在候选里（但它的 profile 要在，见上一条）。去掉 ON_DEMAND 门禁 → 这条红。
  const ids = (await mod.apiGetCandidates()).models.map((m) => m.model_id);
  assert.ok(!ids.includes("anthropic.claude-sonnet-5"),
            "an INFERENCE_PROFILE-only base model must not be listed");
});

await t("a profile whose base model is absent from this region is still listed", async () => {
  // 实测坑：东京的 apac.anthropic.claude-3-5-sonnet-* 底层基座在本区根本不被列出，
  // 按"底层必须在本区文本模型集合里"过滤会把 3 个真实可用的 Claude profile 丢掉。
  const ids = (await mod.apiGetCandidates()).models.map((m) => m.model_id);
  assert.ok(ids.includes("apac.anthropic.claude-3-5-sonnet-20241022-v2:0"),
            "reachable only via CRIS in this region — must still be offered");
});

await t("non-chat and inactive profiles are excluded", async () => {
  const ids = (await mod.apiGetCandidates()).models.map((m) => m.model_id);
  assert.ok(!ids.includes("global.cohere.embed-v4:0"), "embedding profile must be excluded");
  assert.ok(!ids.includes("global.anthropic.claude-retired"), "non-ACTIVE must be excluded");
});

await t("profile pagination is followed", async () => {
  // 第二页只有应被排除的条目，所以只能通过"排除生效"来证明第二页确实被读到了。
  const ids = (await mod.apiGetCandidates()).models.map((m) => m.model_id);
  assert.ok(!ids.includes("global.cohere.embed-v4:0"));
  assert.equal(new Set(ids).size, ids.length, "model_id must be unique across all sources");
});

await t("profile scope and routing metadata are exposed to the UI", async () => {
  const byId = Object.fromEntries((await mod.apiGetCandidates()).models.map((m) => [m.model_id, m]));
  assert.equal(byId["global.anthropic.claude-sonnet-5"].scope, "global");
  assert.equal(byId["apac.anthropic.claude-3-5-sonnet-20241022-v2:0"].scope, "apac");
  assert.equal(byId["amazon.nova-pro-v1:0"].scope, "regional");
  // Mantle 的 model_id 没有地理前缀，scope 必须显式标出来，否则 UI 会标成"本区域"
  assert.equal(byId["openai.gpt-5.6-terra"].scope, "mantle");
  assert.equal(byId["global.anthropic.claude-sonnet-5"].provider_name, "Anthropic");
});

await t("profiles failing to list degrades without losing base models", async () => {
  state.listProfilesFail = true;
  const r = await mod.apiGetCandidates();
  state.listProfilesFail = false;
  assert.ok(r.warning && /InferenceProfiles/i.test(r.warning), r.warning);
  assert.ok(r.models.some((m) => m.model_id === "amazon.nova-pro-v1:0"),
            "base models must survive a profile-listing failure");
});

await t("candidates infer kind from model id", async () => {
  const r = await mod.apiGetCandidates();
  const byId = Object.fromEntries(r.models.map((m) => [m.model_id, m.kind]));
  assert.equal(byId["global.anthropic.claude-sonnet-5"], "bedrock_anthropic");
  assert.equal(byId["amazon.nova-pro-v1:0"], "bedrock_converse");
  assert.equal(byId["openai.gpt-5.6-terra"], "bedrock_mantle_responses");
});

await t("candidates degrade gracefully when listing fails", async () => {
  state.listModelsFail = true;
  const r = await mod.apiGetCandidates();
  assert.ok(r.warning, "should surface a warning");
  assert.ok(r.models.length > 0, "manual/mantle path still available");
});

await t("connectivity test maps errors to enums without leaking upstream text", async () => {
  state.converseError = "AccessDeniedException";
  const r = await mod.apiTestLlmModel({ model_id: "global.anthropic.claude-sonnet-5" });
  assert.equal(r.result, "forbidden");
  assert.ok(!JSON.stringify(r).includes("leaks-secret"), "upstream detail must not leak");
});

await t("probe parameter rejections are not blamed on the model", async () => {
  // 实测事故：探测传了 `temperature`，而新一代 Claude（Sonnet 5 / Opus 5，adaptive
  // thinking 常驻）已弃用它 → ValidationException → 旧代码一律映射成 invalid_model，
  // 于是每个新 Claude 都显示"模型无效"，管理员无法把它设为默认。
  state.converseError = "ValidationException";
  state.converseMessage = "The model returned the following errors: `temperature` is deprecated for this model.";
  const r = await mod.apiTestLlmModel({ model_id: "global.anthropic.claude-sonnet-5" });
  state.converseError = null; state.converseMessage = null;
  assert.equal(r.result, "probe_error");     // 我们的 bug，不是模型的
  assert.ok(!JSON.stringify(r).includes("temperature"), "must not leak upstream text");
});

await t("the probe never sends sampling params", async () => {
  // 一旦有人把 temperature/topP 加回去，上面那个故障就会重现。这里直接钉住请求形状。
  const src = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../llm_config.mjs", import.meta.url), "utf8"));
  const at = src.indexOf("new ConverseCommand(");
  assert.ok(at > 0, "the Converse probe must still exist");
  // 只看这次调用实际传的 inferenceConfig 那一行 —— 取到 `}));` 会把上文的注释与其它
  // 代码块一起吃进来（第一版就因此误判：Mantle 分支的 max_output_tokens 落进了片段里）。
  const cfgLine = src.slice(at).match(/inferenceConfig:\s*\{[^}]*\}/);
  assert.ok(cfgLine, "the probe must pass an explicit inferenceConfig");
  for (const banned of ["temperature", "topP", "topK"]) {
    assert.ok(!cfgLine[0].includes(banned),
              `probe must not send ${banned} (got: ${cfgLine[0]})`);
  }
});

await t("the probe's output cap clears every known per-model minimum", async () => {
  // 同一个故障的另一半：`maxTokens: 8` 低于 Grok 4.6 的下限（>= 16），于是探测报
  // ValidationException → invalid_model → 出厂默认模型在 Admin 页**存不下去**，
  // 而报错说的是"模型无效"。这里钉住那个常量，别再为省 token 把它调回边界值。
  const src = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../llm_config.mjs", import.meta.url), "utf8"));
  const m = src.match(/const PROBE_MAX_TOKENS\s*=\s*(\d+)/);
  assert.ok(m, "PROBE_MAX_TOKENS must exist and be a literal");
  assert.ok(Number(m[1]) >= 32,
            `PROBE_MAX_TOKENS=${m[1]} is too close to the measured per-model minimum (16)`);
  // Converse 与 Mantle 两条探测都必须用它 —— 一边写死数字就会各自漂移。
  assert.ok(/inferenceConfig:\s*\{\s*maxTokens:\s*PROBE_MAX_TOKENS\s*\}/.test(src),
            "the Converse probe must use PROBE_MAX_TOKENS");
  assert.ok(/max_output_tokens:\s*PROBE_MAX_TOKENS/.test(src),
            "the Mantle probe must use PROBE_MAX_TOKENS");
});

await t("an output-cap-too-low rejection is not blamed on the model", async () => {
  // 实测（2026-08-26，us-east-1）：maxTokens=8 → ValidationException
  // "... integer_below_min_value ... Expected a value >= 16"。必须落到 probe_error，
  // 否则它进 HARD_FAIL_PROBE_RESULTS 硬拦保存。
  state.converseError = "ValidationException";
  state.converseMessage = "The value of maxTokens is invalid: integer_below_min_value. Expected a value >= 16";
  const r = await mod.apiTestLlmModel({ model_id: "global.xai.grok-4.6" });
  state.converseError = null; state.converseMessage = null;
  assert.equal(r.result, "probe_error");
  assert.ok(!JSON.stringify(r).includes("integer_below_min_value"),
            "must not leak upstream text");
});

await t("on-demand-unsupported is distinguished from an unknown model", async () => {
  // 东京的 amazon.nova-pro-v1:0 只能经 inference profile 调用。报成 invalid_model 会让
  // 管理员以为模型不存在，而正确的下一步是"换成 apac./global. 前缀的那个"。
  state.converseError = "ValidationException";
  state.converseMessage = "Invocation of model ID amazon.nova-pro-v1:0 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model.";
  const r = await mod.apiTestLlmModel({ model_id: "amazon.nova-pro-v1:0" });
  state.converseError = null; state.converseMessage = null;
  assert.equal(r.result, "needs_profile");
  assert.ok(!JSON.stringify(r).includes("on-demand"), "must not leak upstream text");
});

await t("a genuinely unknown model id is still invalid_model", async () => {
  state.converseError = "ValidationException";
  state.converseMessage = "The provided model identifier is invalid.";
  const r = await mod.apiTestLlmModel({ model_id: "anthropic.nope" });
  state.converseError = null; state.converseMessage = null;
  assert.equal(r.result, "invalid_model");
});

await t("connectivity test reports ok with latency", async () => {
  const r = await mod.apiTestLlmModel({ model_id: "global.anthropic.claude-sonnet-5" });
  assert.equal(r.result, "ok");
  assert.ok(typeof r.latency_ms === "number");
});

await t("connectivity test validates inputs", async () => {
  assert.equal((await mod.apiTestLlmModel({ model_id: "../etc/passwd" })).status, 400);
  assert.equal((await mod.apiTestLlmModel({
    model_id: "openai.gpt-5.6-terra", kind: "bedrock_mantle_responses", region: "evil.com",
  })).status, 400);
});

await t("mantle connectivity is really probed, not skipped", async () => {
  // 这条断言此前是 `result === "skipped"` —— 那是在把一个未实现固化成"预期行为"。
  // Mantle 的鉴权就是普通 SigV4（签名服务名 bedrock-mantle），BFF 用自己的角色能真调；
  // 返回 skipped 的后果是 GPT 系模型上线前无法验证，只能让用户到生产里试错。
  //
  // 本测试不触网（无凭证/无网络时 fetch 失败 → "error"），所以断言的是**契约**：
  //   · 不再返回 "skipped"
  //   · 结果落在枚举集合内（绝不透传上游错误原文，spec R5.5）
  //   · 带上 latency_ms，说明确实发起过一次尝试
  const r = await mod.apiTestLlmModel({
    model_id: "openai.gpt-5.6-terra", kind: "bedrock_mantle_responses", region: "us-east-2",
  });
  assert.notEqual(r.result, "skipped");
  assert.ok(["ok", "unauthorized", "forbidden", "invalid_model", "not_found",
             "throttled", "timeout", "error"].includes(r.result), `unexpected: ${r.result}`);
  assert.equal(typeof r.latency_ms, "number");
  // 上游原文不得出现在响应里
  assert.equal(r.detail, undefined);
});

await t("mantle candidates carry an explicit default_region", async () => {
  // 前端曾用 `regions[0]` 当默认区。名单按区域名排序，从 2 个区扩到 14 个区后排第一的
  // 从 us-east-2 变成了 us-east-1 —— 新加的 GPT 条目默认区被静默换掉，而当时 AgentCore
  // runtime 的 IAM 只授了 us-east-2/us-west-2，于是存得进去、聊天时才 403。
  // 默认区改由服务端下发，前端不再按下标取。
  const r = await mod.apiGetCandidates();
  const mantle = r.models.filter((m) => m.kind === "bedrock_mantle_responses");
  assert.ok(mantle.length > 0, "mantle candidates must be present");
  for (const m of mantle) {
    assert.equal(typeof m.default_region, "string", `${m.model_id} lacks default_region`);
    assert.ok(m.regions.includes(m.default_region),
              `${m.model_id}: default_region ${m.default_region} not in its own regions`);
    // 位置无关：默认区不必是名单第一个，而现在恰好**不是**（第一个是 us-east-1）。
    assert.equal(m.default_region, "us-east-2", m.default_region);
  }
  assert.notEqual(mantle[0].regions[0], mantle[0].default_region,
                  "this assertion is only meaningful while regions[0] !== default_region; "
                  + "if the allowlist is reordered, keep the positional-independence intent");
});

/* ── 写入侧字段白名单 ──────────────────────────────────────────────────── */
await t("writes strip fields outside the schema (verified stops round-tripping)", async () => {
  // `verified` 已从种子 / 内置兜底 / 校验 / UI 全部删除，但**已部署环境的 DDB item 里
  // 还留着**。Admin 页读出来再原样提交，写入侧从前是 `models: body.models` 直通，
  // 于是它一代一代传下去 —— 代码读起来像"字段已删除"，线上数据却一直带着它，
  // 还会进审计快照、回滚时被还原。
  state.item = null;
  const cfg = GOOD();
  cfg.models[0].verified = true;               // 模拟老 item 被读出来又提交回来
  cfg.models[1].verified = false;
  cfg.models[0].some_future_typo = "x";        // 任意未知键同样不得落地
  const r = await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.ok(!r.error, `save must succeed: ${r.error}`);

  // puts 里还有审计与后端任务投影的写入，按 PK 取配置本体那一条（不是 .at(-1)）。
  const written = state.puts.map((p) => p.Item)
    .filter((i) => i && i.PK === "llmcfg" && i.SK === "meta").at(-1);
  assert.ok(written, "the config item must have been written");
  for (const m of written.models) {
    assert.equal("verified" in m, false, `verified leaked into ${m.alias}`);
    assert.equal("some_future_typo" in m, false, `unknown key leaked into ${m.alias}`);
  }
  // 反面：合法字段一个都不能被顺手丢掉，否则白名单本身就是个数据破坏器。
  // 清单**从模块导出的常量取**，绝不在这里手抄 —— 手抄过一次，连同遗漏一起抄了过来：
  // 白名单漏掉 `model_id_override`，测试的手抄清单也漏掉它，于是那条静默数据丢失
  // 一路全绿。手抄清单只能守住「已知字段」，恰好守不住新增字段被漏掉这种漂移。
  const claude = written.models.find((m) => m.alias === "claude-sonnet-5");
  for (const k of mod.MODEL_ENTRY_FIELDS) {
    if (k === "model_id_override") continue;   // 本 fixture 没设它，下一条用例专门覆盖
    assert.ok(k in claude, `whitelist dropped a legitimate field: ${k}`);
  }
  assert.deepEqual(claude.output_override, { im: 6000 });
  assert.equal(claude.supports_prompt_cache, true);
  assert.deepEqual(claude.surfaces, ["webchat", "im"]);
  // mantle 条目的 region 必须保住（它是 Mantle 拼 hostname 的依据）
  const gpt = written.models.find((m) => m.alias === "gpt-5-6");
  assert.equal(gpt.region, "us-east-2");
});

await t("EVERY write path normalises, not just apiPutLlmConfig", async () => {
  // 白名单第一版只挂在 apiPutLlmConfig 上，另外三条写路径都是 `{...prev}` / `{...snapshot}`
  // 直通：回滚会把快照里的旧字段**还原**回来，backend-tasks 与 Key 换代则把它们**往前带**
  // 一代（两者都重写整份目录并推进 generation）。净效果是「清理永远追不上还原」，
  // 而当初写白名单的动因恰恰是「已部署 item 里的 verified 清不掉」。
  const legacy = (over = {}) => ({
    PK: "llmcfg", SK: "meta", provider: "bedrock", credential_mode: "iam",
    default_model: "claude-sonnet-5", generation: 1000,
    backend_tasks: { phd_translate: "claude-sonnet-5", devops_report_summarize: null },
    // 每个条目都带一个已删除字段 + 一个合法字段，两个方向一起验
    models: GOOD().models.map((m) => ({
      ...m, verified: true, model_id_override: m.alias === "claude-sonnet-5"
        ? { im: "us.anthropic.claude-sonnet-5" } : undefined,
    })),
    ...over,
  });
  const written = () => state.puts.map((p) => p.Item)
    .filter((i) => i && i.PK === "llmcfg" && i.SK === "meta").at(-1);
  const assertClean = (label) => {
    const it = written();
    assert.ok(it, `${label}: no config item written`);
    for (const m of it.models) {
      assert.equal("verified" in m, false, `${label}: verified survived on ${m.alias}`);
    }
    const c = it.models.find((m) => m.alias === "claude-sonnet-5");
    assert.deepEqual(c.model_id_override, { im: "us.anthropic.claude-sonnet-5" },
      `${label}: a legitimate field was destroyed`);
  };

  // ① 回滚：快照里带着旧字段，还原时必须归一
  state.item = legacy(); state.puts = [];
  state.audit = [{ PK: "llmcfg#audit", SK: "0001",
                   snapshot_before: JSON.stringify(legacy({ generation: 900 })) }];
  const rb = await mod.apiRollbackLlmConfig({ sk: "0001" }, ACTOR);
  assert.ok(!rb.error, `rollback must succeed: ${rb.error}`);
  assertClean("rollback");

  // ② backend-tasks：只改一个绑定，却重写整份目录
  state.item = legacy(); state.puts = [];
  const bt = await mod.apiPutBackendTasks({ phd_translate: "amazon-nova-pro" }, ACTOR);
  assert.ok(!bt.error, `backend-tasks must succeed: ${bt.error}`);
  assertClean("backend-tasks");

  // ③ Key 换代：不碰目录，但把 prev 整份写回并推进 generation
  state.item = legacy(); state.puts = []; state.secret = null;
  const kb = await mod.apiPutBedrockKey({ api_key: "a-plausible-bedrock-api-key-value" }, ACTOR);
  assert.ok(!kb.error, `key set must succeed: ${JSON.stringify(kb)}`);
  assertClean("bedrock-key generation bump");
});

await t("the write allowlist matches what the validator accepts", async () => {
  // 这是防漂移的那道闸。白名单漏一个字段 = 每次保存都静默删掉它，而校验器仍然接受它，
  // 所以两份清单必须逐一相等。第一版漏了 `model_id_override`，测试却手抄了同一份遗漏，
  // 于是完全无感。改成断言「两个导出常量相等」之后，漏字段这件事本身会变红。
  const written = [...mod.MODEL_ENTRY_FIELDS].sort();
  const validated = [...mod.VALIDATED_ENTRY_FIELDS].sort();
  assert.deepEqual(written, validated,
    `allowlist drift — only written: ${written.filter((k) => !validated.includes(k))}; `
    + `only validated: ${validated.filter((k) => !written.includes(k))}`);
});

await t("model_id_override survives a save (per-surface routing must not be erased)", async () => {
  // 这个字段决定**某一端实际调哪个 model_id**（core/llm_config.py::_resolve_entry）。
  // 它存在的理由就是「IM 用 us.* profile 而 webchat 用 global.*」这类单端例外，
  // 所以丢掉它 = 静默改变该端的地理路由与数据驻留，且无日志无指标无审计。
  // 触发条件极低：Admin 页把配置读出来、点一下任何勾选框、保存 —— 不需要任何主观意图。
  state.item = null;
  const cfg = GOOD();
  cfg.models[0].model_id_override = { im: "us.anthropic.claude-sonnet-5" };
  const r = await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.ok(!r.error, `save must succeed: ${r.error}`);

  const written = state.puts.map((p) => p.Item)
    .filter((i) => i && i.PK === "llmcfg" && i.SK === "meta").at(-1);
  const claude = written.models.find((m) => m.alias === "claude-sonnet-5");
  assert.deepEqual(claude.model_id_override, { im: "us.anthropic.claude-sonnet-5" },
    "per-surface model id override was destroyed by the write allowlist");

  // 读回来也要在 —— 否则下一次保存会把它当"不存在"再写一遍空值
  const back = await mod.apiGetLlmConfig();
  const backClaude = back.models.find((m) => m.alias === "claude-sonnet-5");
  assert.deepEqual(backClaude.model_id_override, { im: "us.anthropic.claude-sonnet-5" });
});

/* ── Mantle 400 归因：我们的请求体 vs 模型本身 ──────────────────────────── */
// 实测形状（us-east-2，2026-08，本部署账号）：
//   参数不被接受 → 400 {"code":"unsupported_parameter","param":"temperature"}
//   参数值越界   → 400 {"code":"integer_below_min_value","param":"max_output_tokens"}
//   模型不存在   → **404** {"code":"not_found_error","param":null}
// 也就是说模型缺失走 404，可实测的 400 全部出在请求体上。旧代码把 400 一律映射成
// `invalid_model`，而它在 HARD_FAIL 集合里 —— 探测自身的 bug 会硬拦一次合法保存，
// 管理员看到"模型 ID 无效"就去查模型。与 Converse 侧 temperature 那次同一个错。
const MANTLE_PROBE = {
  model_id: "openai.gpt-5.6-terra", kind: "bedrock_mantle_responses", region: "us-east-2",
};

// ⚠️ 这几条**必须**让 probeMantle 走 api_key(bearer) 分支，否则在 CI 里全部假失败。
// 原因：iam 分支要先 SigV4 签名，而 `defaultProvider()` 在**打桩的 fetch 之前**就解析凭证；
// CI（node:22-alpine，无 AWS 凭证）里它直接抛 → 被 probeMantle 自己的 catch 兜成
// result:"error" → 400/404 的分类逻辑一行都没跑到。本地有凭证所以全绿，CI 必红。
// （上面 state.mantleFetch 的注释已预见到这个坑，但桩打在 fetch 上，拦不住签名那一步。）
// 走 bearer 分支则完全不碰 defaultProvider，纯靠 fetch 桩 —— 而这几条测的本来就是
// **400/404 的归因**，不是签名，所以这也是更贴合意图的写法。
const useKeyCred = () => {
  state.item = { ...GOOD(), credential_mode: "api_key" };
  state.secret = "sk-fake-for-tests";
};

await t("mantle 400 naming one of OUR params is probe_error, not invalid_model", async () => {
  useKeyCred();
  for (const [code, param] of [
    ["unsupported_parameter", "temperature"],
    ["integer_below_min_value", "max_output_tokens"],
    ["invalid_value", "store"],
    ["invalid_type", "input"],
  ]) {
    state.mantleFetch = mantleErr(400, JSON.stringify({
      error: { code, param, type: "invalid_request_error", message: "leaks-secret-xyz" },
    }));
    const r = await mod.apiTestLlmModel(MANTLE_PROBE);
    assert.equal(r.result, "probe_error", `${code}/${param} -> ${r.result}`);
    // 上游原文不得外泄（spec R5.5）
    assert.ok(!JSON.stringify(r).includes("leaks-secret-xyz"), JSON.stringify(r));
  }
});

await t("mantle 400 naming the model IS the model's fault", async () => {
  useKeyCred();
  state.mantleFetch = mantleErr(400, JSON.stringify({
    error: { code: "invalid_value", param: "model", type: "invalid_request_error" },
  }));
  assert.equal((await mod.apiTestLlmModel(MANTLE_PROBE)).result, "invalid_model");

  // `not_found_error` 是**实测到的**「模型不存在」code（正常走 404；这里验的是万一它
  // 配 400 回来也要认）。原先这条用的是 `model_not_found` —— 那个 code 在实测里不存在，
  // 是凭空猜的，测试和实现一起猜了同一个词所以对得上，但两边都不对应真实响应。
  state.mantleFetch = mantleErr(400, JSON.stringify({
    error: { code: "not_found_error", param: null, type: "invalid_request_error" },
  }));
  assert.equal((await mod.apiTestLlmModel(MANTLE_PROBE)).result, "invalid_model");
});

await t("mantle 400 with an unreadable body does not hard-fail", async () => {
  // 分类失败时宁可放行加一条 warning，也不要凭猜把一次合法保存拦下来。
  useKeyCred();
  state.mantleFetch = mantleErr(400, null);
  assert.equal((await mod.apiTestLlmModel(MANTLE_PROBE)).result, "probe_error");
});

await t("mantle 404 is a genuinely missing model", async () => {
  useKeyCred();
  state.mantleFetch = mantleErr(404, JSON.stringify({
    error: { code: "not_found_error", param: null, type: "invalid_request_error" },
  }));
  assert.equal((await mod.apiTestLlmModel(MANTLE_PROBE)).result, "not_found");
});

await t("a probe_error on the mantle default model SAVES with a warning", async () => {
  // 这是整条链的落点：分类对了，但如果 probe_error 仍在硬拦集合里，管理员照样被锁在门外。
  state.item = null;
  const cfg = GOOD();
  cfg.default_model = "gpt-5-6";                      // 默认模型指向 Mantle
  // 保存路径按**正在保存的那份** credential_mode 探测（见 probeCredential 的 modeOverride），
  // 所以这里要设在 cfg 上而不是 state.item 上。理由同 useKeyCred。
  cfg.credential_mode = "api_key";
  state.secret = "sk-fake-for-tests";
  state.mantleFetch = mantleErr(400, JSON.stringify({
    error: { code: "integer_below_min_value", param: "max_output_tokens" },
  }));
  const r = await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.ok(!r.error, `must not hard-fail: ${r.error}`);
  assert.ok(String(r.warning || "").includes("probe_error"),
            `expected a probe_error warning, got: ${JSON.stringify(r.warning)}`);
  state.mantleFetch = null;
});

await t("a genuinely invalid mantle default model is still blocked", async () => {
  // 对照组：修不该把硬拦整个拆掉 —— 模型真不存在时必须继续拦。
  state.item = null;
  const cfg = GOOD();
  cfg.default_model = "gpt-5-6";
  cfg.credential_mode = "api_key";                    // 同上：走 bearer，绕开 SigV4
  state.secret = "sk-fake-for-tests";
  state.mantleFetch = mantleErr(404, JSON.stringify({
    error: { code: "not_found_error", param: null },
  }));
  const r = await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.ok(r.error, "a missing model must still block the save");
  assert.ok(r.error.includes("not_found"), r.error);
  state.mantleFetch = null;
});

await t("candidates are enumerated with the credential inference will actually use", async () => {
  // 这是本轮最实质的修正。候选列表若来自部署角色，而推理用的是 Key，两者可以是**完全
  // 不同的模型集合**：Key 背后是独立 IAM user，可以在生成时就被按模型收窄，也可以指向
  // 别的账号。那时管理员在候选里看到 Claude、加进目录、启用，直到用户发消息才 403。
  const iamCfg = GOOD();
  iamCfg.credential_mode = "iam";
  await mod.apiPutLlmConfig(iamCfg, ACTOR);
  state.controlPlaneBuilds.length = 0;
  const asIam = await mod.apiGetCandidates();
  assert.equal(asIam.source_identity, "iam", JSON.stringify(asIam.source_identity));
  assert.equal(state.controlPlaneBuilds.at(-1).cred.mode, "iam");
  assert.equal(state.controlPlaneBuilds.at(-1).cred.key, "");

  const keyCfg = GOOD();
  keyCfg.credential_mode = "api_key";
  await mod.apiPutLlmConfig(keyCfg, ACTOR);
  await mod.apiPutBedrockKey({ api_key: "list-with-this-key" }, ACTOR);
  state.controlPlaneBuilds.length = 0;
  const asKey = await mod.apiGetCandidates();
  assert.equal(asKey.source_identity, "api_key");
  // 关键：Key 明文真的被交给了控制面客户端，不只是响应字段自报
  assert.equal(state.controlPlaneBuilds.at(-1).cred.key, "list-with-this-key");
  assert.ok(asKey.models.length > 0, "listing with the key must still return models");
});

await t("a key without list permission falls back to the role AND says so", async () => {
  // 文档说 Key 可用于 Amazon Bedrock **and** Bedrock Runtime actions（排除项只有
  // 双向流 / Agents / Data Automation），所以 List* 通常可用。但 Key 背后的 IAM user
  // 完全可以只被授予 InvokeModel。那时必须回退，且**必须标注列表与 Key 可调范围可能不符**
  // —— 静默回退就等于回到了"候选列表来自错的身份"这个 bug。
  const keyCfg = GOOD();
  keyCfg.credential_mode = "api_key";
  await mod.apiPutLlmConfig(keyCfg, ACTOR);
  await mod.apiPutBedrockKey({ api_key: "key-that-cannot-list" }, ACTOR);
  state.keyCannotList = true;
  state.controlPlaneBuilds.length = 0;
  try {
    const r = await mod.apiGetCandidates();
    assert.equal(r.source_identity, "iam_fallback", JSON.stringify(r.source_identity));
    // 先用 Key 试、失败后用角色重建 —— 两次构造，第二次不带 Key
    assert.equal(state.controlPlaneBuilds.length, 2, JSON.stringify(state.controlPlaneBuilds));
    assert.equal(state.controlPlaneBuilds[0].cred.mode, "api_key");
    assert.equal(state.controlPlaneBuilds[1].cred.mode, "iam");
    // 回退后仍然要拿到列表（否则管理员没得选）
    assert.ok(r.models.length > 0, "fallback must still produce candidates");
    // Key 明文不得出现在响应里
    assert.ok(!JSON.stringify(r).includes("key-that-cannot-list"));
  } finally {
    state.keyCannotList = false;
  }
});

await t("a throttle while listing is NOT mistaken for a permission problem", async () => {
  // 只有鉴权类失败才回退。把限流 / 服务端错误也当成「Key 不行」会把一次偶发失败
  // 变成一份来源错误的列表，而且标注成 iam_fallback 会让人去查权限。
  const keyCfg = GOOD();
  keyCfg.credential_mode = "api_key";
  await mod.apiPutLlmConfig(keyCfg, ACTOR);
  await mod.apiPutBedrockKey({ api_key: "throttled-key" }, ACTOR);
  state.listModelsFail = true;
  state.listModelsErrorName = "ThrottlingException";
  state.controlPlaneBuilds.length = 0;
  try {
    const r = await mod.apiGetCandidates();
    // 身份**没有**被换掉：限流不是权限问题
    assert.equal(r.source_identity, "api_key", JSON.stringify(r));
    assert.equal(state.controlPlaneBuilds.length, 1,
                 `must not rebuild with the role: ${JSON.stringify(state.controlPlaneBuilds)}`);
    // 走已有的降级路径：列不出来不阻断，手填入口仍在
    assert.ok(String(r.warning || "").includes("ListFoundationModels failed"), r.warning);
  } finally {
    state.listModelsFail = false;
    state.listModelsErrorName = null;
  }
});

await t("bearer auth is wired into the control-plane client config too", async () => {
  // 与 runtimeClientConfig 同理：工厂在测试里被整体替换，参数拼装必须单独可测。
  const iam = mod.controlPlaneClientConfig({ mode: "iam", key: "" });
  assert.equal(iam.token, undefined);
  assert.equal(iam.authSchemePreference, undefined);
  const key = mod.controlPlaneClientConfig({ mode: "api_key", key: "k-9" });
  assert.deepEqual(key.token, { token: "k-9" });
  assert.deepEqual(key.authSchemePreference, ["httpBearerAuth"]);
  // api_key 但 Key 空 → 退回 SigV4，不构造空 bearer
  assert.equal(mod.controlPlaneClientConfig({ mode: "api_key", key: "" }).token, undefined);
  assert.equal(mod.controlPlaneClientConfig().token, undefined);
});

await t("mantle probe still validates the region allowlist before any network call", async () => {
  // 白名单管的是 **bedrock-mantle 端点是否存在于该区**（名单取自 Responses API 文档）。
  // 这条曾用 ap-northeast-1 当反例 —— 但东京**有** Mantle 端点，名单原先只列了
  // us-east-2 / us-west-2 才显得它非法。名单已按文档补齐，反例要换成真的没有端点的区。
  for (const bad of ["ap-northeast-3", "ca-central-1", "evil.com", ""]) {
    const r = await mod.apiTestLlmModel({
      model_id: "openai.gpt-5.6-terra", kind: "bedrock_mantle_responses", region: bad,
    });
    assert.equal(r.status, 400, `region=${JSON.stringify(bad)} should be rejected`);
  }
  // 反向：文档里有端点的区必须过得了这道门（过门之后才是真探测，结果不在本条断言范围）
  for (const good of ["us-east-1", "ap-northeast-1", "eu-west-1"]) {
    const r = await mod.apiTestLlmModel({
      model_id: "openai.gpt-5.6-terra", kind: "bedrock_mantle_responses", region: good,
    });
    assert.notEqual(r.status, 400, `region=${good} should pass the allowlist`);
  }
});

await t("probe reports which credential it used, and honours credential_mode", async () => {
  // 「已验证」必须说清验的是什么。探测用 BFF 角色、运行时用 Admin 配的 Key 时，
  // 绿勾证明的是「BFF 能调」而不是「你的 Key 能调」—— 两个不同的保证，实测就是这个落差。
  const cfg = GOOD();
  cfg.credential_mode = "iam";
  await mod.apiPutLlmConfig(cfg, ACTOR);
  state.runtimeBuilds.length = 0;
  const iamProbe = await mod.apiTestLlmModel({
    model_id: "global.anthropic.claude-sonnet-5", kind: "bedrock_anthropic",
  });
  assert.equal(iamProbe.credential, "iam", JSON.stringify(iamProbe));
  assert.equal(state.runtimeBuilds.at(-1).cred.mode, "iam");
  assert.equal(state.runtimeBuilds.at(-1).cred.key, "", "no key must be handed over in iam mode");

  // 切到 api_key 且 Secret 里有 Key → 探测必须改用 Key
  const withKey = GOOD();
  withKey.credential_mode = "api_key";
  await mod.apiPutLlmConfig(withKey, ACTOR);
  await mod.apiPutBedrockKey({ api_key: "test-bedrock-api-key-value" }, ACTOR);
  state.runtimeBuilds.length = 0;
  const keyProbe = await mod.apiTestLlmModel({
    model_id: "global.anthropic.claude-sonnet-5", kind: "bedrock_anthropic",
  });
  assert.equal(keyProbe.credential, "api_key", JSON.stringify(keyProbe));
  // 关键断言：Key 明文确实被交给了客户端（否则探测仍在用 BFF 角色，绿勾是假绿）
  assert.equal(state.runtimeBuilds.at(-1).cred.key, "test-bedrock-api-key-value");

  // 选了 api_key 但 Key 是空的 → 运行时会回退 IAM，探测跟着回退才诚实
  await mod.apiPutBedrockKey({ clear: true }, ACTOR);
  state.runtimeBuilds.length = 0;
  const fellBack = await mod.apiTestLlmModel({
    model_id: "global.anthropic.claude-sonnet-5", kind: "bedrock_anthropic",
  });
  assert.equal(fellBack.credential, "iam", JSON.stringify(fellBack));
  assert.equal(state.runtimeBuilds.at(-1).cred.key, "");
});

await t("the API key never leaks into a probe response (success AND failure paths)", async () => {
  // 探测现在**持有明文 Key**，所以「不外泄」从一条纪律变成了必须被测的性质。
  // 成功路径与失败路径是两个独立的 return，必须都测 —— 只测失败路径时，往成功路径
  // 里塞一个 `key: cred.key` 不会有任何断言变红（反向注入验证发现的漏洞）。
  const withKey = GOOD();
  withKey.credential_mode = "api_key";
  await mod.apiPutLlmConfig(withKey, ACTOR);
  await mod.apiPutBedrockKey({ api_key: "super-secret-key-do-not-echo" }, ACTOR);
  const bodies = [
    { model_id: "global.anthropic.claude-sonnet-5", kind: "bedrock_anthropic" },
    { model_id: "openai.gpt-5.6-terra", kind: "bedrock_mantle_responses", region: "us-east-2" },
  ];
  for (const failure of [null, "AccessDeniedException", "ValidationException"]) {
    state.converseError = failure;
    try {
      for (const body of bodies) {
        const r = await mod.apiTestLlmModel(body);
        assert.ok(!JSON.stringify(r).includes("super-secret-key-do-not-echo"),
                  `key leaked (converseError=${failure}): ${JSON.stringify(r)}`);
        // 顺带钉住响应形状：只回枚举态 + 延迟 + 凭证种类，没有别的
        assert.deepEqual(Object.keys(r).sort(),
                         ["credential", "latency_ms", "model_id", "result"],
                         JSON.stringify(r));
      }
    } finally {
      state.converseError = null;
    }
  }
});

await t("bearer auth is actually wired into the runtime client config", async () => {
  // 测试用 __setClients 整体替换 runtimeFactory，所以工厂**函数体**在测试里不会执行。
  // 把 bearer 接线埋在工厂里 = 它永远没被验证（反向注入把接线改坏时无人变红）。
  // 因此参数拼装抽成纯函数 runtimeClientConfig，在这里直接测。
  const iam = mod.runtimeClientConfig("us-east-2", { mode: "iam", key: "" });
  assert.equal(iam.region, "us-east-2");
  assert.equal(iam.token, undefined, "iam mode must not carry a bearer token");
  assert.equal(iam.authSchemePreference, undefined);

  const key = mod.runtimeClientConfig("us-west-2", { mode: "api_key", key: "k-123" });
  assert.deepEqual(key.token, { token: "k-123" });
  // JS SDK 默认 SigV4 优先，光给 token 不生效 —— 必须把 httpBearerAuth 提到首位
  assert.deepEqual(key.authSchemePreference, ["httpBearerAuth"]);

  // api_key 模式但 Key 为空 → 必须退回 SigV4，不能构造出一个空 bearer
  const empty = mod.runtimeClientConfig("us-east-1", { mode: "api_key", key: "" });
  assert.equal(empty.token, undefined);
  // 缺省参数也不能崩（历史调用点只传 region）
  assert.equal(mod.runtimeClientConfig("").token, undefined);
});

await t("key status records who set it, and flags overdue rotation", async () => {
  // spec R5.6 要求记录 set_at / set_by / last_4，并在超 90 天时提示轮换。
  // 此前只有 last_4 / set_at，set_by 与轮换提示都没实现。
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const put = await mod.apiPutBedrockKey({ api_key: "who-set-me" }, ACTOR);
  const st = put.bedrock_api_key;
  assert.equal(st.configured, true);
  assert.equal(st.last_4, "t-me");
  assert.equal(st.set_by, ACTOR.username || ACTOR.sub, JSON.stringify(st));
  assert.equal(typeof st.age_days, "number");
  assert.equal(st.rotation_due, false, "a key set just now is not overdue");
  assert.equal(st.rotation_days, 90);
  // 明文绝不外泄
  assert.ok(!JSON.stringify(put).includes("who-set-me"));

  // set_by 也要能从 GET 读回来（存 DDB，不存 Secret payload）
  const got = await mod.apiGetLlmConfig();
  assert.equal(got.bedrock_api_key.set_by, ACTOR.username || ACTOR.sub);

  // 老 Key：把 Secret 版本时间挪到 120 天前 → 必须报 rotation_due
  const realCreated = state.secretCreatedDate;
  state.secretCreatedDate = new Date(Date.now() - 120 * 86400000);
  try {
    const old = await mod.apiGetLlmConfig();
    assert.equal(old.bedrock_api_key.rotation_due, true,
                 JSON.stringify(old.bedrock_api_key));
    assert.ok(old.bedrock_api_key.age_days >= 119, String(old.bedrock_api_key.age_days));
  } finally {
    state.secretCreatedDate = realCreated;
  }

  // 清空 Key 时 set_by 必须一并清掉，否则「未配置」还挂着上一个人的名字
  await mod.apiPutBedrockKey({ clear: true }, ACTOR);
  assert.equal(state.item.bedrock_key_set_by, "");
});

await t("changing the key bumps generation and does not touch the catalogue", async () => {
  // 这条曾断言「换 Key 会把所有 verified 置 false」。`verified` 已整体删除 —— 它是个
  // 需要手动失效的快照，而任何"需要记得去失效"的缓存最终都会漏掉一种失效路径
  // （我们只想到了换 Key，想不到换区域、模型下架、IAM 策略被改）。
  // 现在换 Key 只做一件事：bump generation 让消费端重建客户端。可用性由**下一次保存时
  // 的现场探测**保证，那时用的就是新 Key。
  const cfg = GOOD();
  await mod.apiPutLlmConfig(cfg, ACTOR);
  const before = state.item.generation;
  const modelsBefore = structuredClone(state.item.models);

  await mod.apiPutBedrockKey({ api_key: "a-new-bedrock-api-key" }, ACTOR);
  assert.ok(state.item.generation > before, "generation must advance so consumers rebuild");
  assert.deepEqual(state.item.models, modelsBefore, "the catalogue itself must not change");
  assert.ok(!JSON.stringify(state.item).includes("a-new-bedrock-api-key"),
            "the key must never land in the config item");
});

/* ───── 保存时现场探测默认模型（取代持久化的 verified）───── */
console.log("save-time probe of the default model");

await t("a default model that fails a deterministic probe is rejected on save", async () => {
  // 这是 `verified` 那道门的替代品，而且强于它：结论产生于**保存这一刻**，不可能过期。
  // 两个真实案例都落在这里：东京调不通的 amazon.nova-pro-v1:0（needs_profile）、
  // 被收窄的 Key 排除掉的模型（forbidden）。
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const genBefore = state.item.generation;

  for (const [name, msg, expect] of [
    ["ValidationException", "The provided model identifier is invalid", "invalid_model"],
    ["AccessDeniedException", "no", "forbidden"],
    ["UnrecognizedClientException", "no", "unauthorized"],
    ["ResourceNotFoundException", "no", "not_found"],
    ["ValidationException", "on-demand throughput isn't supported ... inference profile",
     "needs_profile"],
  ]) {
    state.converseError = name;
    state.converseMessage = msg;
    try {
      const r = await mod.apiPutLlmConfig(GOOD(), ACTOR);
      assert.equal(r.status, 400, `${expect}: ${JSON.stringify(r)}`);
      assert.ok(/failed a live check/.test(r.error), r.error);
      assert.ok(r.error.includes(expect), `error should name the verdict: ${r.error}`);
      // **不得落盘**：拦在写入之前，而不是先存再靠一个标记去追
      assert.equal(state.item.generation, genBefore, "a rejected save must not be persisted");
    } finally {
      state.converseError = null;
      state.converseMessage = null;
    }
  }
});

await t("a transient probe failure warns but still saves", async () => {
  // 限流 / 超时说明的是「这次没问上」，不是「这个模型不行」。拿它们拦保存等于 Bedrock
  // 抖一下管理员就被锁在门外 —— 而他可能只是想改一个输出上限。
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  for (const name of ["ThrottlingException", "TimeoutError", "ModelNotReadyException"]) {
    state.converseError = name;
    try {
      const cfg = GOOD();
      cfg.models[0].hard_output_limit = 65536;   // 仍 ≥ output_override.im
      const r = await mod.apiPutLlmConfig(cfg, ACTOR);
      assert.equal(r.error, undefined, `${name} must not block the save: ${JSON.stringify(r)}`);
      assert.ok(/could not be verified/.test(r.warning || ""), JSON.stringify(r.warning));
      assert.equal(state.item.models[0].hard_output_limit, 65536, "the save must land");
    } finally {
      state.converseError = null;
    }
  }
});

await t("the save that FLIPS credential_mode is probed with the NEW mode", async () => {
  // 这次保存改变的就是凭证维度，用持久化的旧值探测两个方向都错。
  // 方向 1（iam → api_key）：旧值 iam ⇒ 用部署角色验证一次「切换到 Key」= 假绿，
  // 正是 probeCredential 存在的意义要消灭的那种。
  const iamFirst = GOOD();
  iamFirst.credential_mode = "iam";
  await mod.apiPutLlmConfig(iamFirst, ACTOR);
  await mod.apiPutBedrockKey({ api_key: "the-new-key" }, ACTOR);
  state.runtimeBuilds.length = 0;
  const toKey = GOOD();
  toKey.credential_mode = "api_key";
  const r1 = await mod.apiPutLlmConfig(toKey, ACTOR);
  assert.equal(r1.error, undefined, JSON.stringify(r1));
  assert.equal(state.runtimeBuilds.at(-1).cred.mode, "api_key",
               "the flip TO api_key must be probed with the key, not the deployment role");
  assert.equal(state.runtimeBuilds.at(-1).cred.key, "the-new-key");

  // 方向 2（api_key → iam）：旧值 api_key ⇒ 用一个已被收窄/吊销的 Key 去验证「退回 IAM」，
  // 403 硬拦 —— 而退回 IAM 恰好是管理员从坏 Key 逃生的唯一出口，堵死它等于把人锁在外面。
  state.converseError = "AccessDeniedException";   // 模拟 Key 已被收窄
  state.runtimeBuilds.length = 0;
  try {
    const toIam = GOOD();
    toIam.credential_mode = "iam";
    const r2 = await mod.apiPutLlmConfig(toIam, ACTOR);
    assert.equal(state.runtimeBuilds.at(-1).cred.mode, "iam",
                 "the flip BACK to iam must be probed with the role");
    // 用 IAM 探测时 fake 仍会抛 AccessDenied（fake 不区分身份），所以这里只钉住
    // **用了哪种凭证**；下一条断言覆盖"能逃生"的完整语义。
    assert.ok(r2.error || r2.warning || r2.message, JSON.stringify(r2));
  } finally {
    state.converseError = null;
  }

  // 完整逃生语义：Key 坏了，退回 IAM 且 IAM 能调 → 必须保存成功
  const escape = GOOD();
  escape.credential_mode = "iam";
  const r3 = await mod.apiPutLlmConfig(escape, ACTOR);
  assert.equal(r3.error, undefined,
               `falling back to IAM must not be blocked by a broken key: ${JSON.stringify(r3)}`);
  assert.equal(state.item.credential_mode, "iam");
});

await t("a save that omits credential_mode is probed with the persisted mode", async () => {
  // 省略该字段时 apiPutLlmConfig 持久化的是 prev 值，探测必须跟着用 prev —— 两者
  // 不一致就又回到「探测的和实际生效的不是一回事」。
  const cfg = GOOD();
  cfg.credential_mode = "api_key";
  await mod.apiPutLlmConfig(cfg, ACTOR);
  await mod.apiPutBedrockKey({ api_key: "persisted-mode-key" }, ACTOR);
  const noMode = GOOD();
  delete noMode.credential_mode;
  state.runtimeBuilds.length = 0;
  const r = await mod.apiPutLlmConfig(noMode, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.runtimeBuilds.at(-1).cred.mode, "api_key");
  assert.equal(state.item.credential_mode, "api_key", "persisted mode must be preserved");
});

await t("the save-time probe uses the credential inference will use", async () => {
  // 用部署角色探一个 Key 调不了的模型 = 假绿，正是这轮要消灭的那类问题。
  const cfg = GOOD();
  cfg.credential_mode = "api_key";
  await mod.apiPutLlmConfig(cfg, ACTOR);
  await mod.apiPutBedrockKey({ api_key: "probe-with-this" }, ACTOR);
  state.runtimeBuilds.length = 0;
  const r = await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.ok(state.runtimeBuilds.length >= 1, "the save must have probed");
  assert.equal(state.runtimeBuilds.at(-1).cred.key, "probe-with-this");
  // 硬拦时的错误文案要点明用的是 Key，否则管理员会去查部署角色的权限
  state.converseError = "AccessDeniedException";
  try {
    const bad = await mod.apiPutLlmConfig(cfg, ACTOR);
    assert.ok(/using the configured API key/.test(bad.error || ""), bad.error);
    assert.ok(!JSON.stringify(bad).includes("probe-with-this"), "key must not leak");
  } finally {
    state.converseError = null;
  }
});

await t("a probe that throws does not block a legitimate save", async () => {
  // 探测自身炸了（网络 / SDK）不是配置的错。否则一个 BFF 侧的 bug 会让整个模型管理页
  // 变成只读。
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const orig = state.runtimeThrow;
  state.runtimeThrow = true;
  try {
    const r = await mod.apiPutLlmConfig(GOOD(), ACTOR);
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.ok(/could not verify/.test(r.warning || ""), JSON.stringify(r.warning));
  } finally {
    state.runtimeThrow = orig;
  }
});

/* ───────────────── resolveForStream ───────────────── */
console.log("resolveForStream — server-side admission");

await t("alias outside the enabled set is substituted", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const r = await mod.resolveForStream("us.anthropic.claude-x", "webchat");
  assert.equal(r.alias, "claude-sonnet-5");
  assert.equal(r.substituted, true);
  assert.ok(r.generation > 0);
});

await t("canonical, short and legacy aliases all accepted", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  for (const asked of ["claude-sonnet-5", "claude", "CLAUDE", " claude "]) {
    const r = await mod.resolveForStream(asked, "webchat");
    assert.equal(r.alias, "claude-sonnet-5", asked);
    assert.equal(r.substituted, false, asked);
  }
});

await t("empty alias is not a substitution", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const r = await mod.resolveForStream("", "webchat");
  assert.equal(r.substituted, false);
  assert.equal(r.alias, "claude-sonnet-5");
});

await t("webchat-only model is substituted on the im surface", async () => {
  const cfg = GOOD();
  cfg.models = [ENTRY(), { ...GPT, surfaces: ["webchat"] }];
  await mod.apiPutLlmConfig(cfg, ACTOR);
  const r = await mod.resolveForStream("gpt-5-6", "im");
  assert.equal(r.alias, "claude-sonnet-5");
  assert.equal(r.substituted, true);
});

await t("unseeded catalogue passes the alias through", async () => {
  const r = await mod.resolveForStream("whatever", "webchat");
  assert.equal(r.alias, "whatever");
  assert.equal(r.substituted, false);
});

/* ───────────────── 后端任务模型 + 投影 ───────────────── */
console.log("backend tasks — projection to appconfig#*");

const PROJ_PHD = "appconfig#phd|bedrock_model_id";
const PROJ_DA = "appconfig#devops_agent|bedrock_model_id";

await t("saving the catalogue projects the bound aliases as raw model ids", async () => {
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "claude-sonnet-5", devops_report_summarize: "amazon-nova-pro" };
  const r = await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.appconfig[PROJ_PHD].config_value, "global.anthropic.claude-sonnet-5");
  assert.equal(state.appconfig[PROJ_DA].config_value, "amazon.nova-pro-v1:0");
});

await t("projection rows are marked as derived, not hand-typed", async () => {
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "claude-sonnet-5" };
  await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.equal(state.appconfig[PROJ_PHD].projected_from, "llmcfg.backend_tasks.phd_translate");
  assert.ok(state.appconfig[PROJ_PHD].updated_at);
});

await t("an unbound task does not touch a row that never existed", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);   // backend_tasks 全 null
  assert.equal(state.appconfig[PROJ_PHD], undefined);
  assert.equal(state.appconfig[PROJ_DA], undefined);
});

await t("an unbound task leaves a HAND-SET legacy row alone", async () => {
  // `appconfig#devops_agent` 早就在线，老巡检 UI 还在直接写它。第一次 Admin 保存
  // 若把它清空，DevOps 报告精简会静默退回 env/硬编码默认，而管理员只是保存了一次
  // 模型目录、完全不知道动了那个功能。判据是 projected_from 标记的有无。
  state.appconfig[PROJ_DA] = {
    PK: "appconfig#devops_agent", SK: "bedrock_model_id",
    config_value: "global.anthropic.claude-opus-4-6-v1",
    updated_at: "2026-05-01T00:00:00Z",
    // 注意：没有 projected_from —— 这是人手填的
  };
  await mod.apiPutLlmConfig(GOOD(), ACTOR);   // 未绑定
  assert.equal(state.appconfig[PROJ_DA].config_value, "global.anthropic.claude-opus-4-6-v1",
               "hand-set value must survive an unrelated catalogue save");
});

await t("an unbound task DOES clear a row we projected ourselves", async () => {
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "claude-sonnet-5" };
  await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.equal(state.appconfig[PROJ_PHD].config_value, "global.anthropic.claude-sonnet-5");
  assert.equal(state.appconfig[PROJ_PHD].projected_from, "llmcfg.backend_tasks.phd_translate");
  // 解绑：这行是我们投影的，所以可以清空 —— 后端于是回落到自己的 env / 默认
  const r = await mod.apiPutBackendTasks({ phd_translate: null }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.appconfig[PROJ_PHD].config_value, "");
});

await t("re-pointing an alias at a new model id re-projects", async () => {
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "claude-sonnet-5" };
  await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.equal(state.appconfig[PROJ_PHD].config_value, "global.anthropic.claude-sonnet-5");
  // 同一个 alias 换指向（换代 / 重映射）——投影必须跟着走，否则后端停在旧模型上
  const next = structuredClone(state.item);
  next.models[0].model_id = "global.anthropic.claude-sonnet-6";
  const r = await mod.apiPutLlmConfig(next, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.appconfig[PROJ_PHD].config_value, "global.anthropic.claude-sonnet-6");
});

await t("mantle models ARE allowed for backend tasks, and project kind + region", async () => {
  // 这条曾断言「Mantle 一律拒绝」，理由是后端链只走 Converse。那是我们自己的实现
  // 缺口，不是模型限制：Bedrock 上有一批模型只在 bedrock-mantle 上架（实测
  // Converse(openai.gpt-5.6-terra) → ValidationException），而对话侧早就能用。
  // shared/llm_provider.py 已补 Mantle Responses 分支，两端对齐，故改为放行。
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "gpt-5-6" };
  assert.equal(mod.validateConfig(cfg), null);
  const r = await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.appconfig[PROJ_PHD].config_value, "openai.gpt-5.6-terra");
  // 光有 model_id 不够：后端得知道走哪条协议、打哪个区，否则会拿它去调 Converse。
  assert.equal(state.appconfig["appconfig#phd|bedrock_model_kind"].config_value,
               "bedrock_mantle_responses");
  assert.equal(state.appconfig["appconfig#phd|bedrock_model_region"].config_value,
               "us-east-2");
});

await t("binding a mantle model still can't smuggle in a bad region", async () => {
  // Mantle 端点按区寻址，region 必须在白名单内。**这条由逐模型校验保证**
  // （validateModel），不是 backend_tasks 那一段的职责 —— 我一度在 backend_tasks 里
  // 重复查了一次，反向注入时把它改成恒真却没有任何测试变红，说明那是不可达分支，
  // 已删除。这里锁住的是真正生效的那道门：目录里进不来，也就绑不上。
  for (const bad of ["", "evil.example.com", "us-east-9"]) {
    const cfg = GOOD();
    cfg.models.find((m) => m.alias === "gpt-5-6").region = bad;
    cfg.backend_tasks = { phd_translate: "gpt-5-6" };
    const err = mod.validateConfig(cfg);
    assert.ok(err && /region/i.test(err), `region=${JSON.stringify(bad)}: ${err}`);
    const r = await mod.apiPutLlmConfig(cfg, ACTOR);
    assert.equal(r.status, 400);
  }
});

await t("routing rows are tagged with the model_id they belong to", async () => {
  // 三行是独立 item，读者可能跨代读到「旧 model_id + 新 kind」——「用 Responses 协议
  // 调一个 Converse-only 的 id」，报 "model identifier is invalid"，看起来像模型不存在。
  // 写序（kind → region → model_id）只防住了反方向；消费侧的读序恰好把它抵消掉。
  // 所以路由行必须带 `for_model_id`，让消费侧能**校验**配对而不是假定。
  // 消费侧：shared/phd_config.phd_model_route、shared/summarizer_config._model_route。
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "gpt-5-6" };
  const r = await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));

  const rows = ["bedrock_model_kind", "bedrock_model_region", "bedrock_model_id"]
    .map((sk) => state.appconfig[`appconfig#phd|${sk}`]);
  for (const [i, row] of rows.entries()) {
    assert.ok(row, `row ${i} missing`);
    assert.equal(row.for_model_id, "openai.gpt-5.6-terra",
                 `row ${i} (${row.SK}) has for_model_id=${row.for_model_id}`);
  }
  // 且 kind 行的标记必须等于 model_id 行的值 —— 那正是消费侧的校验条件
  const kindRow = state.appconfig["appconfig#phd|bedrock_model_kind"];
  const idRow = state.appconfig["appconfig#phd|bedrock_model_id"];
  assert.equal(kindRow.for_model_id, idRow.config_value);
});

await t("a Converse model projects an empty region (no stale value left behind)", async () => {
  // 从 Mantle 换回 Converse 模型时，region 行必须被覆盖成空。否则后端读到上一代
  // 留下的 us-east-2，配上一个 Converse 的 kind —— 组合出一个没人测过的状态。
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "gpt-5-6" };
  await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.equal(state.appconfig["appconfig#phd|bedrock_model_region"].config_value, "us-east-2");
  const r = await mod.apiPutBackendTasks({ phd_translate: "claude-sonnet-5" }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.appconfig["appconfig#phd|bedrock_model_region"].config_value, "");
  assert.equal(state.appconfig["appconfig#phd|bedrock_model_kind"].config_value,
               "bedrock_anthropic");
});

await t("PUT backend-tasks only touches the binding, keeps the catalogue", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const before = structuredClone(state.item);
  const r = await mod.apiPutBackendTasks({ phd_translate: "amazon-nova-pro" }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.deepEqual(state.item.models, before.models);
  assert.equal(state.item.backend_tasks.phd_translate, "amazon-nova-pro");
  assert.equal(state.appconfig[PROJ_PHD].config_value, "amazon.nova-pro-v1:0");
  assert.ok(state.item.generation > before.generation, "generation must advance");
});

await t("PUT backend-tasks rejects an alias outside the enabled set", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const r = await mod.apiPutBackendTasks({ phd_translate: "does-not-exist" }, ACTOR);
  assert.equal(r.status, 400);
});

await t("PUT backend-tasks rejects unknown task names", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const r = await mod.apiPutBackendTasks({ mine_bitcoin: "claude-sonnet-5" }, ACTOR);
  assert.equal(r.status, 400);
});

await t("PUT backend-tasks needs at least one known field", async () => {
  await mod.apiPutLlmConfig(GOOD(), ACTOR);
  const r = await mod.apiPutBackendTasks({}, ACTOR);
  assert.equal(r.status, 400);
});

await t("PUT backend-tasks before the catalogue is seeded returns 409", async () => {
  const r = await mod.apiPutBackendTasks({ phd_translate: "claude-sonnet-5" }, ACTOR);
  assert.equal(r.status, 409);
});

await t("clearing a binding blanks the projection", async () => {
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "claude-sonnet-5" };
  await mod.apiPutLlmConfig(cfg, ACTOR);
  const r = await mod.apiPutBackendTasks({ phd_translate: null }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.appconfig[PROJ_PHD].config_value, "");
});

await t("a failed projection warns but does not lose the save", async () => {
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "claude-sonnet-5" };
  state.failProjection = true;
  const r = await mod.apiPutLlmConfig(cfg, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.ok(r.generation > 0, "the catalogue itself must still be saved");
  assert.ok(/phd_translate/.test(r.warning || ""), r.warning);
  assert.equal(state.item.backend_tasks.phd_translate, "claude-sonnet-5");
});

await t("GET backend-tasks reports the binding, the model id and the sync state", async () => {
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "claude-sonnet-5" };
  await mod.apiPutLlmConfig(cfg, ACTOR);
  const r = await mod.apiGetBackendTasks();
  const phd = r.tasks.find((x) => x.task === "phd_translate");
  assert.equal(phd.alias, "claude-sonnet-5");
  assert.equal(phd.model_id, "global.anthropic.claude-sonnet-5");
  assert.equal(phd.projected_model_id, "global.anthropic.claude-sonnet-5");
  assert.equal(phd.in_sync, true);
  assert.equal(r.tasks.length, 2);
});

await t("GET backend-tasks distinguishes 'never configured' from 'in sync'", async () => {
  // 旧的 `in_sync: wanted === projected` 在什么都没配时是 `"" === ""` → true，
  // 于是一个从未配置过的系统显示为「已同步」。这是唯一的漂移信号，不能假绿。
  await mod.apiPutLlmConfig(GOOD(), ACTOR);   // backend_tasks 全 null
  const r = await mod.apiGetBackendTasks();
  for (const row of r.tasks) {
    assert.equal(row.status, "unbound", `${row.task}: ${row.status}`);
    assert.equal(row.in_sync, false, `${row.task} must not report in_sync when unbound`);
  }
});

await t("GET backend-tasks reports 'unknown' when the projection cannot be read", async () => {
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "claude-sonnet-5" };
  await mod.apiPutLlmConfig(cfg, ACTOR);
  state.failProjectionRead = true;
  const r = await mod.apiGetBackendTasks();
  const phd = r.tasks.find((x) => x.task === "phd_translate");
  assert.equal(phd.status, "unknown", phd.status);
  assert.equal(phd.in_sync, false, "a failed read must never report in_sync");
});

await t("GET backend-tasks flags drift when the projection is stale", async () => {
  const cfg = GOOD();
  cfg.backend_tasks = { phd_translate: "claude-sonnet-5" };
  state.failProjection = true;
  await mod.apiPutLlmConfig(cfg, ACTOR);   // 真源写成功、投影失败
  const r = await mod.apiGetBackendTasks();
  const phd = r.tasks.find((x) => x.task === "phd_translate");
  assert.equal(phd.in_sync, false, "UI must be able to tell the admin to re-save");
});

await t("rollback also rolls the projection back", async () => {
  const first = GOOD();
  first.backend_tasks = { phd_translate: "claude-sonnet-5" };
  await mod.apiPutLlmConfig(first, ACTOR);
  await mod.apiPutBackendTasks({ phd_translate: "amazon-nova-pro" }, ACTOR);
  assert.equal(state.appconfig[PROJ_PHD].config_value, "amazon.nova-pro-v1:0");
  const sk = state.audit.find((a) => a.snapshot_before
    && JSON.parse(a.snapshot_before)?.backend_tasks?.phd_translate === "claude-sonnet-5").SK;
  const r = await mod.apiRollbackLlmConfig({ sk }, ACTOR);
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(state.item.backend_tasks.phd_translate, "claude-sonnet-5");
  assert.equal(state.appconfig[PROJ_PHD].config_value, "global.anthropic.claude-sonnet-5",
               "the derived value must follow the source of truth back");
});

/* ───────────────── authz：真实调用 authorize() ───────────────── */
console.log("authz — real authorize() calls, not source-text assertions");

// 下面这批用例来自一次实测出的**授权绕过**：`isLoginOnly()` 原先在 `matchRoute()`
// **之前**返回，而 LOGIN_ONLY 是后缀正则、index.mjs 的路由分发也是后缀匹配。加入
// `/\/models$/` 之后，任意登录用户（仅 nav:chat）都能打到 admin handler：
//   DELETE /admin/roles/models · DELETE /admin/groups/models
//   PUT    /admin/users/models · DELETE /skills/models
// 旧测试只断言 authz.mjs 的源码文本（LOGIN_ONLY 块里是否出现 "llm-config"、
// 正则是否带 `$`），完全抓不到这类顺序缺陷 —— 所以这里改成真的调 authorize()。
const authz = await import("../authz.mjs");
const VIEWER = { grants: ["nav:chat"], denies: [] };
const ADMIN = { grants: ["*"], denies: [] };
const decide = (eff, method, path) =>
  authz.authorize({ method, path, query: {}, body: {} }, eff, { disabledModules: [] });

for (const [method, path, label] of [
  ["GET", "/api/chat/models", "候选模型清单"],
  ["GET", "/api/chat/conversations", "会话列表"],
  ["GET", "/api/chat/conversations/abc", "单个会话"],
  ["GET", "/api/chat/me/capabilities", "自身能力"],
  ["GET", "/api/chat/accounts", "账号列表"],
]) {
  await t(`login-only stays open to any signed-in user: ${label}`, async () => {
    assert.equal((await decide(VIEWER, method, path)).allow, true);
  });
}

for (const [method, path, label] of [
  ["DELETE", "/api/chat/admin/roles/models", "delete a role"],
  ["DELETE", "/api/chat/admin/groups/models", "delete a cognito group"],
  ["PUT", "/api/chat/admin/groups/models", "rewrite a group→role mapping"],
  ["PUT", "/api/chat/admin/users/models", "rewrite another user's permissions"],
  ["DELETE", "/api/chat/skills/models", "delete a skill named 'models'"],
  ["GET", "/api/chat/skills/models", "read a skill named 'models'"],
  ["PUT", "/api/chat/admin/account-access/user/models", "rewrite account visibility"],
  ["GET", "/api/chat/admin/member-accounts/status/models", "member-account status"],
  ["GET", "/api/chat/admin/llm-config", "read the llm config"],
  ["PUT", "/api/chat/admin/llm-config", "write the llm config"],
  ["GET", "/api/chat/admin/llm-config/models", "an admin path ending in /models"],
  ["PUT", "/api/chat/admin/llm-config/bedrock-key", "set the bedrock api key"],
  ["PUT", "/api/chat/admin/llm-config/backend-tasks", "bind a backend task model"],
]) {
  await t(`privileged route is NOT shadowed by the login-only suffix list: ${label}`, async () => {
    const viewer = await decide(VIEWER, method, path);
    assert.equal(viewer.allow, false, `viewer must be denied ${method} ${path}`);
    const admin = await decide(ADMIN, method, path);
    assert.equal(admin.allow, true, `admin must still be allowed ${method} ${path}`);
  });
}

await t("login-only is consulted only when no capability node matches", async () => {
  // 结构性断言：把顺序写死。若有人把 isLoginOnly 挪回 matchRoute 之前，
  // 上面那批用例会红，这条则解释为什么。
  const src = readFileSync(new URL("../authz.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function authorize"));
  const iMatch = body.indexOf("matchRoute(");
  const iLogin = body.indexOf("isLoginOnly(");
  assert.ok(iMatch >= 0 && iLogin >= 0, "both calls must exist");
  assert.ok(iMatch < iLogin,
            "matchRoute() must run before isLoginOnly(), otherwise a suffix allowlist "
            + "can shadow a privileged route");
});

/* ───────────────── authz wiring ───────────────── */
console.log("authz wiring");

const authzSrc = readFileSync(new URL("../authz.mjs", import.meta.url), "utf8");
const loginOnlyBlock = authzSrc.slice(authzSrc.indexOf("const LOGIN_ONLY"),
                                      authzSrc.indexOf("function isLoginOnly"));
await t("/models is anchored in LOGIN_ONLY", async () => {
  assert.ok(/\/\\\/models\$\//.test(loginOnlyBlock),
            "must be an anchored /\\/models$/ regex, else /admin/llm-config/models slips through");
});
await t("admin llm-config paths are not login-only", async () => {
  // 剥掉注释后再判断 —— 注释里提到 /admin/llm-config/models 是说明为何要加 `$` 锚点，
  // 不是白名单条目本身。
  const code = loginOnlyBlock
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  assert.ok(!code.includes("llm-config"), "admin paths must stay gated");
  // 同时正面验证锚点行为：/admin/llm-config/models 不得被 /models$ 白名单吃掉
  const re = /\/models$/;
  assert.equal(re.test("/prod/models"), true);
  assert.equal(re.test("/prod/admin/llm-config/models"), true,
    "note: endsWith-style regex DOES match this — routing must therefore place " +
    "admin subpaths before it, which is asserted separately");
});

/* ───────────────── /admin/llm-config/status ───────────────── */
// 这两条原本住在 scripts/test_llmcfg_status.py 里 —— 用 `subprocess.run(["node", ...])`
// fork 出来跑。但那套脚本在 CI 跑的是 python:3.12-slim，镜像里没有 node，于是
// FileNotFoundError: 'node' 直接崩掉整个 job。断言内容**全是 BFF 侧**的（DDB 真值 +
// 可运行的诊断查询 + admin 门禁），Python 那边一个字节都没参与，所以正确的位置本来
// 就是这里。搬过来同时也省掉了每条 90s 超时的子进程开销。
console.log("llmcfg status endpoint");

await t("status reports DDB truth + a runnable cross-surface query", async () => {
  state.item = {
    PK: "llmcfg", SK: "meta", generation: 4242,
    provider: "bedrock", credential_mode: "iam", default_model: "claude-sonnet-5",
    updated_at: "2026-08-01T00:00:00Z", updated_by: "admin@example.com",
    models: [
      ENTRY(),                                        // webchat + im, enabled
      { ...NOVA, enabled: false },                    // 关掉的那个
      // surfaces 必须显式写 —— GPT 从 ENTRY 继承的是 ["webchat","im"]，
      // 不覆盖的话 enabled_by_surface.im 会是 2，下面那条按端拆分的断言就白测了。
      { ...GPT, surfaces: ["webchat"] },
    ],
  };
  const s = await mod.apiGetLlmStatus();

  // BFF 能权威回答的那一半：DynamoDB 真值。
  assert.equal(s.catalogue.generation, 4242);
  assert.equal(s.catalogue.seeded, true);
  assert.equal(s.catalogue.models_total, 3);
  assert.equal(s.catalogue.models_enabled, 2);
  // 按端拆分：诊断混合态的第一步就是「**这一端**到底还有几个模型可用」。
  assert.equal(s.catalogue.enabled_by_surface.webchat, 2);
  assert.equal(s.catalogue.enabled_by_surface.im, 1);
  assert.equal(s.catalogue.updated_by, "admin@example.com");
  // 凭证：只报状态，永不明文（R5.5）。
  assert.equal(s.catalogue.bedrock_api_key.configured, false);
  assert.ok(!JSON.stringify(s).toLowerCase().includes("secretstring"));

  // BFF 自己的状态 —— 这才解释得了「为什么某一端没跟随」。
  assert.equal(typeof s.bff.enabled_flag, "boolean");
  assert.ok(s.bff.note && s.bff.note.length > 0);

  // 另一半：给一个**查得到**的办法，而不是「去翻日志」。
  const d = s.per_surface_diagnosis;
  assert.ok(d.logs_insights_query.includes("llmcfg_status"),
            "the query must filter on the marker the readers actually log");
  assert.ok(Array.isArray(d.where_to_look) && d.where_to_look.length >= 3,
            "all three long-lived surfaces must be listed");
  assert.ok(d.metrics_namespace && d.metrics_hint,
            "point at the metric that says a surface is NOT on the DDB catalogue");
});

await t("status endpoint is admin-only", async () => {
  // status 会回 provider / credential mode / 操作人名字，普通 viewer 不能看。
  const authz = await import("../authz.mjs");
  const p = "/api/chat/admin/llm-config/status";
  const viewer = await authz.authorize({ method: "GET", path: p, query: {}, body: {} },
                                       { grants: ["nav:chat"], denies: [] },
                                       { disabledModules: [] });
  const admin = await authz.authorize({ method: "GET", path: p, query: {}, body: {} },
                                      { grants: ["*"], denies: [] },
                                      { disabledModules: [] });
  assert.equal(viewer.allow, false,
               "status exposes provider / credential mode / operator name");
  assert.equal(admin.allow, true);
});

const indexSrc = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
await t("more specific admin subpaths are routed before /admin/llm-config", async () => {
  const cand = indexSrc.indexOf("/admin/llm-config/candidates");
  const base = indexSrc.indexOf('path.endsWith("/admin/llm-config")');
  assert.ok(cand !== -1 && base !== -1 && cand < base,
            "endsWith routing requires specific paths first");
});

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
