/**
 * skill_tools.mjs：哪些 Skill 依赖 DevOps Agent 替代不了的 NotiOps 工具（2026-11-02）。
 * 运行：node bff/web-chat/tests/skill_tools.test.mjs
 *
 *   · 整词匹配：aws_whats_new 不会命中 aws_whats_new_report 的前半段，也不会命中 my_aws_whats_new_x 这类更长的标识符；
 *   · 规范正文 + 每份译文都看，读不到的译文跳过；
 *   · **两份清单与 agent 源码一致**：main.py 里每个 @tool 函数（含 async def）必须恰好落在「替代不了」或「能替代」之一 ——
 *     agent 加了新工具，就得有人明确判断它属于哪一类；
 *   · 只拦替代不了的那几个：`read_skill_reference`、`rds_metrics`、`aws_readonly` 这类不拦（DevOps Agent 有自己的办法）；
 *   · 预置 Skill 里只有 whats-new-report 被拦（aws-well-architected-review-devops 提到 read_skill_reference，照样能用）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { NOTIOPS_ONLY_TOOLS, SUBSTITUTABLE_TOOLS, notiopsToolsIn, skillNotiopsTools } from "../skill_tools.mjs";

let ok = 0, fails = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
}
console.log("skill_tools: Skill 用到的 NotiOps 自带工具");

await t("整词匹配、去重、排序", () => {
  assert.deepEqual(notiopsToolsIn("先用 `aws_whats_new`，超过 20 条用 aws_whats_new_report；再用 aws_whats_new"), ["aws_whats_new", "aws_whats_new_report"]);
  assert.deepEqual(notiopsToolsIn("my_aws_whats_new_x 与 web_searching 都不算"), []);
  assert.deepEqual(notiopsToolsIn("call web_search, then save_report"), ["web_search"], "save_report 能替代：不拦");
  assert.deepEqual(notiopsToolsIn("用 read_skill_reference 读 references/x.md，再用 rds_metrics、aws_readonly"), [], "能替代的都不拦");
  assert.deepEqual(notiopsToolsIn("use use_aws to call rds:DescribeDBInstances"), [], "DevOps Agent 自带工具与 AWS API 名不算");
  assert.deepEqual(notiopsToolsIn("", null, undefined), []);
});

await t("规范正文 + 译文都看；读不到的译文跳过", async () => {
  const skill = { skill_id: "s", version: "1.0.0", body: "plain", body_i18n: ["zh", "en"] };
  const getSkill = async (id, ver, loc) => {
    if (loc === "zh") return { body: "先调 `aws_whats_new`", body_locale: "zh" };
    throw new Error("s3 down");
  };
  assert.deepEqual(await skillNotiopsTools(skill, { getSkill }), ["aws_whats_new"]);
  // 译文缺失时 getSkill 回退规范正文（body_locale = ""）：不重复算
  const fallback = async () => ({ body: "plain", body_locale: "" });
  assert.deepEqual(await skillNotiopsTools({ ...skill, body: "x" }, { getSkill: fallback }), []);
  assert.deepEqual(await skillNotiopsTools(null), []);
});

await t("两份清单与 agent 源码里的 @tool 函数一致（含 async def），每个恰好落在一类", () => {
  const main = readFileSync(new URL("../../../agent-build/NotiOpsWebChat/app/NotiOpsWebChat/main.py", import.meta.url), "utf8");
  const declared = [...main.matchAll(/^@tool\s*\n(?:\s*@[^\n]*\n)*\s*(?:async\s+)?def\s+([a-z_][a-z0-9_]*)/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 20, `从 main.py 只认出 ${declared.length} 个工具，正则多半失配了`);
  const all = [...NOTIOPS_ONLY_TOOLS, ...SUBSTITUTABLE_TOOLS];
  assert.equal(new Set(all).size, all.length, "同一个工具不能两类都进");
  const missing = declared.filter((n) => !all.includes(n));
  assert.deepEqual(missing, [], `agent 新增的工具还没归类（skill_tools.mjs 两份清单之一）：${missing.join(", ")}`);
  const stale = all.filter((n) => !declared.includes(n));
  assert.deepEqual(stale, [], `清单里有 agent 已经没有的工具：${stale.join(", ")}`);
});

await t("预置 Skill：只有 whats-new-report 被拦", () => {
  const root = new URL("../preset-skills/", import.meta.url);
  const hits = {};
  for (const d of readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    const texts = ["SKILL.md", "SKILL.zh.md", "SKILL.en.md"]
      .map((f) => new URL(`${d.name}/${f}`, root)).filter((u) => existsSync(u)).map((u) => readFileSync(u, "utf8"));
    const tools = notiopsToolsIn(...texts);
    if (tools.length) hits[d.name] = tools;
  }
  assert.deepEqual(hits, { "whats-new-report": ["aws_whats_new", "aws_whats_new_report"] });
});

console.log(fails ? `\n${fails} failed` : `\n${ok} ok, 0 failed`);
process.exit(fails ? 1 : 0);
