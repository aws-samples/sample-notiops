/**
 * 退役主题的入口归一（topic.mjs 的 normalizeTopic）+ **两个入口都接上了**的源码级断言。
 *
 * 背景（2026-09-11）：「安全」不再是聊天主题，并入「调查」。前端已经在读会话时归一，
 * 但那只覆盖新加载的 bundle —— 已经打开的旧标签页会继续发 `topic:"security"`，并且能靠
 * `ensureConversation`（带 `attribute_not_exists(SK)`）在库里**新建**一条永远改不掉的
 * `topic:"security"` 会话头。所以 BFF 必须自己再归一一次。
 *
 * 这份测试钉三件事，都属于"改坏了不报错、只是能力悄悄退回去了"：
 *
 *   1. **security → investigate**。漏了这条，老会话继续按 security 走 agent：
 *      工具只挂 core 8 个（investigate 是 22 个，独有 lake_query / analyze_metric /
 *      execute_cwl_insights_batch），客户在同一个输入框里问同一句话拿到更差的答案。
 *   2. **其余值原样透传、不做 allowlist**。BFF 至今对 topic 没有任何校验，突然开始 4xx
 *      会把老客户端打死；未知值在 agent 侧只是拿不到 focus 段，本来就是安全的。
 *   3. **两个入口都要归一**（POST /stream 与 POST /warmup）。agent 侧 LRU 缓存键**包含 topic**
 *      （main.py 的 `_agent_cache.build_key`），只归一一个 = 预热建出来的 agent 挂在一个
 *      真实请求永不命中的 key 上：那 ~10s 冷启动原价回来，而且哪儿都不报错。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeTopic } from "../topic.mjs";

let fails = 0;
// ⚠️ `ok` 是**通过数**，收尾必须和 `0 failed` 一起打 —— package.json 的 test 脚本靠
//    `grep -q ', 0 failed'` 判「这个文件真的跑了」；只打「0 failed」的话「一条都没跑」
//    也是 0 failed，那正是那个守卫要防的盲区。
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}

await t("security 归一成 investigate", () => {
  assert.equal(normalizeTopic("security"), "investigate");
});

await t("其余主题原样透传（不做 allowlist，别把老客户端打死）", () => {
  for (const k of ["general", "investigate", "finops", "cases", "whats-new"]) {
    assert.equal(normalizeTopic(k), k);
  }
  // 未知值也透传：agent 侧 `.get(topic, "")` 只是拿不到 focus，不会崩。
  assert.equal(normalizeTopic("a-topic-we-never-shipped"), "a-topic-we-never-shipped");
});

await t("空值回落 general（与 store.mjs 写入时的默认值一致）", () => {
  assert.equal(normalizeTopic(undefined), "general");
  assert.equal(normalizeTopic(null), "general");
  assert.equal(normalizeTopic(""), "general");
});

await t("原型链上的名字不算别名（topic:\"constructor\" 不许查出函数）", () => {
  // 别名表若是普通对象字面量，这几个会查到 Object.prototype 上的函数（truthy），
  // 于是 normalizeTopic 返回一个**函数**，JSON.stringify 时整个 topic 字段消失。
  for (const evil of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    const got = normalizeTopic(evil);
    assert.equal(typeof got, "string", `normalizeTopic("${evil}") 返回了 ${typeof got}`);
    assert.equal(got, evil);
  }
});

await t("/stream 与 /warmup 两个入口都调了 normalizeTopic", () => {
  const src = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ normalizeTopic \} from "\.\/topic\.mjs"/,
    "index.mjs 没有 import normalizeTopic");
  const hits = src.match(/normalizeTopic\(/g) || [];
  // import 那一行不含 `(`，所以这里数到的全是调用点：/warmup 一处 + streamChat 一处。
  assert.ok(hits.length >= 2,
    `normalizeTopic 只被调用了 ${hits.length} 次；/stream 与 /warmup 都必须归一，` +
    `否则预热的 agent 挂在一个真实请求永不命中的 LRU key 上（agent 缓存键含 topic）`);
});

console.log(`\n${ok} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
