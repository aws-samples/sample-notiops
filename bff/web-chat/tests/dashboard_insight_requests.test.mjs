/**
 * Dashboard 洞察那几个**硬编码模型**的 Converse 请求形状。
 *
 * 为什么值得一条独立断言：这些调用（FinOps deep-dive / tag-cost、Support 6 个月汇总）
 * 都包在 `try { … } catch { return { insight: "", …, aiError } }` 里。请求体只要有一个
 * 参数不被模型接受，整段就静默降级成**空洞察** —— 界面上没有报错、没有 toast，
 * 只是那块内容是空的。实测撞到过：三处都传了 `temperature: 0`，而 Sonnet 5
 * （adaptive thinking 常驻）已弃用该参数，于是 ValidationException 每次必发，
 * 「AI 洞察」在这三处**长期整体失效**（2026-08-26 实测确认）。
 *
 * 因此这里钉的是**源码里的请求形状**，不是 mock 出来的行为：故障的性质是"参数不合法"，
 * 而能防住它复发的最小手段就是"别再把采样参数加回去"。
 *
 * 同类事故在 llm_config.mjs 的探测里发生过一次（那次至少留下了一个枚举态可查）。
 * 若将来要重新引入采样参数，先确认目标模型仍接受它，并把这条断言改成按模型分支，
 * 别直接删掉。
 */
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";

let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${e?.message || e}`);
  }
}

// 采样参数一律不传：交给模型默认值。maxTokens 是必要的（控制成本与截断），留着。
const BANNED = ["temperature", "topP", "topK", "top_p", "top_k"];

const FILES = ["finops.mjs", "support.mjs"];

console.log("dashboard insight Converse requests");

for (const file of FILES) {
  const src = await fs.readFile(new URL(`../${file}`, import.meta.url), "utf8");

  await t(`${file}: sends no sampling params in any inferenceConfig`, async () => {
    const configs = src.match(/inferenceConfig:\s*\{[^}]*\}/g) || [];
    assert.ok(configs.length > 0, `${file} should still build Converse requests`);
    for (const cfg of configs) {
      for (const banned of BANNED) {
        assert.ok(!cfg.includes(banned),
                  `${file} must not send ${banned} (got: ${cfg})`);
      }
    }
  });

  await t(`${file}: every insight request still caps its output`, async () => {
    const configs = src.match(/inferenceConfig:\s*\{[^}]*\}/g) || [];
    for (const cfg of configs) {
      assert.match(cfg, /maxTokens:\s*\d+/,
                   `${file}: an unbounded insight request would be a cost surprise`);
    }
  });
}

console.log(failed ? `\nFAILED: ${failed} check(s)` : "\nPASSED");
process.exit(failed ? 1 : 0);
