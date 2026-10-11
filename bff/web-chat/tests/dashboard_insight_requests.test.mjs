/**
 * Dashboard 洞察（FinOps deep-dive / tag-cost、Support 6 个月汇总）的模型调用。
 *
 * 为什么值得一组独立断言：这些调用都包在 `try { … } catch { return { insight: "", …, aiError } }`
 * 里 —— 请求体有一个参数不被模型接受、或者读响应读错了位置，整段就静默降级成**空洞察**：
 * 界面上没有报错、没有 toast，只是那块内容是空的。两种都真实发生过：
 *   · 2026-08-26：三处都传了 `temperature: 0`，Sonnet 5 已弃用该参数 → ValidationException 每次必发；
 *   · 2026-09-01 起（2026-10-10 才发现）：换成 Grok 4.6 后，它把 `reasoningContent` 放在第一块，
 *     而代码读的是 `content[0].text`；就算读对了，1000 的预算也被推理用光（stopReason=max_tokens）。
 *
 * 所以这里钉三件事：请求形状（不传采样参数、有输出上限）、读响应的方式、首选 → 兜底的顺序。
 * 若将来要重新引入采样参数，先确认目标模型仍接受它，并把断言改成按模型分支，别直接删掉。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

let failed = 0;
let ok = 0;
async function t(name, fn) {
  try {
    await fn();
    ok++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${e?.message || e}`);
  }
}

// 采样参数一律不传：交给模型默认值。maxTokens 是必要的（控制成本与截断），留着。
const BANNED = ["temperature", "topP", "topK", "top_p", "top_k"];
const read = (rel) => fs.readFile(new URL(rel, import.meta.url), "utf8");

console.log("dashboard insight Converse requests");

const helperSrc = await read("../insight_llm.mjs");

await t("insight_llm.mjs: sends no sampling params in any inferenceConfig", async () => {
  const configs = helperSrc.match(/inferenceConfig:\s*\{[^}]*\}/g) || [];
  assert.ok(configs.length > 0, "insight_llm.mjs should still build the Converse request");
  for (const cfg of configs) {
    for (const banned of BANNED) {
      assert.ok(!cfg.includes(banned), `must not send ${banned} (got: ${cfg})`);
    }
  }
});

// 三个调用点只许经 invokeInsight 走：自己再 new 一个 ConverseCommand，上面这些判据就管不到它了。
for (const file of ["finops.mjs", "support.mjs"]) {
  const src = await read(`../${file}`);
  await t(`${file}: builds no Converse request of its own, reads no content[0]`, async () => {
    assert.ok(!src.includes("new ConverseCommand("), `${file} calls Converse directly -- go through invokeInsight`);
    assert.ok(!/content\?\.\[0\]|content\[0\]/.test(src), `${file} reads content[0]`);
    assert.ok(src.includes("await invokeInsight(prompt)"), `${file} no longer calls invokeInsight`);
  });
}

const { INSIGHT_MODELS, converseText, invokeInsight } = await import("../insight_llm.mjs");

await t("every insight model has an output cap", async () => {
  assert.ok(INSIGHT_MODELS.length >= 2, "need a primary and a region-proof fallback");
  for (const m of INSIGHT_MODELS) {
    assert.ok(Number.isInteger(m.maxTokens) && m.maxTokens >= 16,
              `${m.modelId}: maxTokens ${m.maxTokens} (Kimi / Grok reject < 16)`);
  }
});

await t("the last resort is the catalogue default model, and it is a cross-Region profile", async () => {
  const cat = JSON.parse(await read("../../../config/llm-model-catalog.json"));
  const def = cat.models.find((m) => m.alias === cat.default_model);
  const last = INSIGHT_MODELS[INSIGHT_MODELS.length - 1];
  assert.equal(last.modelId, def.model_id,
               "insight fallback drifted from the catalogue default_model -- update insight_llm.mjs too");
  assert.match(last.modelId, /^(global|us|eu|apac|jp|au|ca|us-gov)\./,
               "the fallback must be callable from any Region (bare ids have per-Region holes)");
  // 推理型模型在 1000 时实测一个 JSON 字都没有；给它的预算不能回到那个量级。
  assert.ok(last.maxTokens >= 4000, `fallback budget ${last.maxTokens} is too small for a reasoning model`);
});

// ── 行为：块顺序取自 2026-10-10 us-east-1 的实测响应 ───────────────────────────
const reply = (content, stopReason = "end_turn") => ({ output: { message: { role: "assistant", content } }, stopReason });
const REASONING = { reasoningContent: { reasoningText: { text: "thinking...", signature: "x" } } };

await t("converseText: reasoning first (Kimi K3 / Grok 4.6 / Grok 4.7)", async () => {
  assert.equal(converseText(reply([REASONING, { text: '{"ok":true}' }])), '{"ok":true}');
});
await t("converseText: text first (GLM 5.3)", async () => {
  assert.equal(converseText(reply([{ text: '{"ok":true}' }, REASONING])), '{"ok":true}');
});
await t("converseText: several text blocks are joined in order", async () => {
  assert.equal(converseText(reply([{ text: '{"a":' }, REASONING, { text: "1}" }])), '{"a":1}');
});
await t("converseText: no text at all -> empty string", async () => {
  assert.equal(converseText(reply([REASONING], "max_tokens")), "");
  assert.equal(converseText({}), "");
  assert.equal(converseText(undefined), "");
});

/** 按顺序回放给定结果的假 client；记下每次请求。 */
function fakeClient(outcomes) {
  const sent = [];
  return {
    sent,
    async send(cmd) {
      sent.push(cmd.input);
      const o = outcomes[sent.length - 1];
      if (o instanceof Error) throw o;
      return o;
    },
  };
}
const err = (name) => Object.assign(new Error(`${name} (message may carry an ARN)`), { name });
const quiet = async (fn) => {
  const w = console.warn; const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  try { return [await fn(), lines]; } finally { console.warn = w; }
};

await t("primary answers -> one call, fallback never touched", async () => {
  const c = fakeClient([reply([{ text: '{"insight":"x"}' }])]);
  const [txt] = await quiet(() => invokeInsight("p", { client: c }));
  assert.equal(txt, '{"insight":"x"}');
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].modelId, INSIGHT_MODELS[0].modelId);
  assert.equal(c.sent[0].inferenceConfig.maxTokens, INSIGHT_MODELS[0].maxTokens);
});

await t("primary not in this Region (ValidationException) -> fallback with its own budget", async () => {
  const c = fakeClient([err("ValidationException"), reply([REASONING, { text: '{"insight":"y"}' }])]);
  const [txt, warns] = await quiet(() => invokeInsight("p", { client: c }));
  assert.equal(txt, '{"insight":"y"}');
  assert.equal(c.sent[1].modelId, INSIGHT_MODELS[1].modelId);
  assert.equal(c.sent[1].inferenceConfig.maxTokens, INSIGHT_MODELS[1].maxTokens);
  // 日志只许有模型 id + 错误类型名
  assert.ok(warns.every((l) => !l.includes("ARN")), `warn leaked the error message: ${warns}`);
});

await t("primary stops inside its reasoning (no text) -> fallback, not an empty insight", async () => {
  const c = fakeClient([reply([REASONING], "max_tokens"), reply([{ text: '{"insight":"z"}' }])]);
  const [txt] = await quiet(() => invokeInsight("p", { client: c }));
  assert.equal(txt, '{"insight":"z"}');
  assert.equal(c.sent.length, 2);
});

await t("everything fails -> throws the last error (caller turns it into aiError)", async () => {
  const c = fakeClient([err("AccessDeniedException"), err("ThrottlingException")]);
  await assert.rejects(quiet(() => invokeInsight("p", { client: c })), { name: "ThrottlingException" });
});

await t("the prompt goes out verbatim as the only user message", async () => {
  const c = fakeClient([reply([{ text: "{}" }])]);
  await quiet(() => invokeInsight("Rows (top 40): []", { client: c }));
  assert.deepEqual(c.sent[0].messages, [{ role: "user", content: [{ text: "Rows (top 40): []" }] }]);
  for (const banned of BANNED) {
    assert.ok(!(banned in (c.sent[0].inferenceConfig || {})), `request carries ${banned}`);
  }
  assert.equal(c.sent[0].additionalModelRequestFields, undefined);
});

console.log(failed ? `\nFAILED: ${failed} check(s)` : `\nPASSED: ${ok} ok, 0 failed`);
process.exit(failed ? 1 : 0);
