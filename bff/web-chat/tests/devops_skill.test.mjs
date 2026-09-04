/**
 * `/skill` 在**两条直连 DevOps Agent 的路径**上真的生效（bff/web-chat/devops_skill.mjs）。
 *
 * 为什么值得单测：这条缺陷最贵的地方在于它**完全不报错**。前端一直都会把 skill_id 传上来，
 * 但直连路径此前直接把它丢掉 —— 客户点了 skill、发出去、答案照常回来，只是那份作业指导
 * 压根没参与。没有报错、没有日志，只有"这个 skill 好像不太灵"。所以这里钉的是：
 *   · skill 正文**确实进了**发给 DevOps Agent 的那段文字；
 *   · 用户原话**仍在**（skill 是"怎么做"，原话是"做什么"，丢了原话就答错题）；
 *   · 附属文件（references/）取不到时**如实说明**，而不是让 DevOps Agent 按半份指导硬答；
 *   · 正文超长**截断 + 明说**，而不是撞 ValidationException 让整轮报废；
 *   · 没选 skill 时**原文一字不动**（绝不能给每一轮都套一层壳）；
 *   · 两条直连分支都把 skillId 交了下去（源码级断言：少接一条就是"那一路悄悄没生效"）。
 *
 * 运行：cd bff/web-chat && npm test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSkillContent, skillLabel, isPublishedToDevopsAgent, MAX_SKILL_BODY } from "../devops_skill.mjs";

let fails = 0;
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message || e}`); }
}

const skill = (over = {}) => ({
  skill_id: "rds-health-check",
  name: "RDS 巡检",
  version: "1.2.0",
  body: "## 步骤\n1. 先看连接数\n2. 再看慢查询",
  ...over,
});

console.log("devops_skill: /skill 在直连路径上生效");

await t("没选 skill → 原话一字不动（绝不给普通轮次套壳）", () => {
  assert.equal(buildSkillContent({ text: "帮我看下 RDS", skill: null }), "帮我看下 RDS");
  assert.equal(buildSkillContent({ text: "帮我看下 RDS", skill: { name: "x" } }), "帮我看下 RDS");
});

await t("选了 skill → 正文进入 content，且用户原话仍在末尾", () => {
  const out = buildSkillContent({ text: "帮我看下 db-prod", skill: skill() });
  assert.ok(out.includes("1. 先看连接数"), "skill 正文没进去 = 又回到静默不生效");
  assert.ok(out.includes("RDS 巡检"), "没写 skill 名字，用户无从确认用了哪份指导");
  assert.ok(out.includes("v1.2.0"));
  assert.ok(out.trimEnd().endsWith("帮我看下 db-prod"), "用户原话必须在末尾");
});

await t("chat 模式要求 DevOps Agent 声明在用哪个 skill、并跟随用户语言", () => {
  const zh = buildSkillContent({ text: "看一下", skill: skill(), mode: "chat" });
  assert.ok(zh.includes("说明正在使用该 Skill"));
  assert.ok(zh.includes("与用户提问相同的语言"));
  const en = buildSkillContent({ text: "check it", skill: skill(), en: true, mode: "chat" });
  assert.ok(/SAME language/i.test(en));
});

await t("investigate 模式的措辞是「按这份指导执行本次调查」", () => {
  const out = buildSkillContent({ text: "查一下抖动", skill: skill(), mode: "investigate" });
  assert.ok(out.includes("执行本次调查"));
  assert.ok(out.includes("1. 先看连接数"));
});

await t("有 references/ 但未发布到 DevOps Agent → 如实说明取不到", () => {
  const s = skill({ files: ["references/limits.md", "references/runbook.md"] });
  assert.equal(isPublishedToDevopsAgent(s), false);
  const out = buildSkillContent({ text: "看一下", skill: s });
  assert.ok(out.includes("2 个参考文件"));
  assert.ok(out.includes("取不到"), "不说明就等于让它按半份指导硬答");
});

await t("已发布到该 Agent Space → 提示读它本地安装的那份", () => {
  const s = skill({ files: ["references/limits.md"], devops_agent: { uploads: { "SKILL.md": "s3://x" } } });
  assert.equal(isPublishedToDevopsAgent(s), true);
  const out = buildSkillContent({ text: "看一下", skill: s });
  assert.ok(out.includes("本地安装"));
  assert.ok(!out.includes("取不到"));
});

await t("没有附属文件 → 不多说一句（零噪音）", () => {
  const out = buildSkillContent({ text: "看一下", skill: skill() });
  assert.ok(!out.includes("参考文件"));
});

await t("正文超长 → 截断并明说被截断（不撞 ValidationException 让整轮报废）", () => {
  const out = buildSkillContent({ text: "看一下", skill: skill({ body: "步".repeat(MAX_SKILL_BODY + 500) }) });
  assert.ok(out.includes("已被截断"));
  // 截断后的正文长度必须真的收在上限内（否则"截断"只是句空话）。
  assert.ok(out.length < MAX_SKILL_BODY + 2000, `content 仍然超长：${out.length}`);
});

await t("skillLabel 优先 name、兜底 skill_id（气泡里不能出现 undefined）", () => {
  assert.equal(skillLabel(skill()), "RDS 巡检");
  assert.equal(skillLabel({ skill_id: "wafr" }), "wafr");
  assert.equal(skillLabel(null), "");
});

// ── 源码级：两条直连分支都必须把 skillId 交下去 ────────────────────────────────
// 这里钉源码而不是行为：真正的回归是"某次重构把参数漏了"，而漏了之后一切照常运行，
// 只是那一路的 skill 又变回静默不生效 —— 类型系统和端到端测试都抓不到。
const INDEX = readFileSync(new URL("../index.mjs", import.meta.url), "utf8");
const CHAT = readFileSync(new URL("../devops_chat.mjs", import.meta.url), "utf8");
const INV = readFileSync(new URL("../devops_investigate.mjs", import.meta.url), "utf8");

await t("index.mjs 把 skillId 传给「DevOps 对话」与「深度调查（直连）」两条分支", () => {
  const chatCall = INDEX.match(/runDevopsChat\(\{[\s\S]{0,400}?\}\)/)?.[0] || "";
  assert.ok(/skillId/.test(chatCall), "runDevopsChat 没收到 skillId");
  assert.ok(/skillVersion/.test(chatCall), "runDevopsChat 没收到 skillVersion");
  const invCall = INDEX.match(/runDirectInvestigation\(\{[\s\S]{0,400}?\}\)/)?.[0] || "";
  assert.ok(/skillId/.test(invCall), "runDirectInvestigation 没收到 skillId");
  assert.ok(/skillVersion/.test(invCall), "runDirectInvestigation 没收到 skillVersion");
});

await t("两条路径都把 skill 内联进真正发出去的那段文字", () => {
  // 对话：SendMessage 的 content 必须是加工后的 content，不能又写回 String(text)。
  assert.ok(/content = buildSkillContent\(/.test(CHAT));
  assert.ok(/content,?\s*$|content\s*\}/m.test(CHAT.match(/new SendMessageCommand\(\{[\s\S]{0,300}?\}\)/)?.[0] || ""),
    "SendMessage 没有发加工后的 content");
  // 调查：CreateBacklogTask 的 description 必须是加工后的 description。
  assert.ok(/description = buildSkillContent\(/.test(INV));
});

await t("读 skill 失败必须让用户看见（不是只写一条 step）", () => {
  assert.ok(/skill_load_failed/.test(CHAT) && /say\(/.test(CHAT.split("skill_load_failed")[1].slice(0, 300)),
    "devops_chat 读失败没往气泡里说");
  assert.ok(/skill_load_failed/.test(INV) && /say\(/.test(INV.split("skill_load_failed")[1].slice(0, 300)),
    "devops_investigate 读失败没往气泡里说");
});

await t("调查气泡回显用户原话，而不是把整份 skill 正文倒进去", () => {
  assert.ok(/\$\{userText\}\$\{skillLine\}/.test(INV),
    "banner 又用回了 description —— 整份 skill 正文会出现在聊天气泡里");
});

console.log(fails ? `\n${fails} failed` : `\n${ok} ok, 0 failed`);
process.exit(fails ? 1 : 0);
