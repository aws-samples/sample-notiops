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
import { buildSkillContent, skillLabel, isPublishedToDevopsAgent, MAX_SKILL_BODY,
         DESCRIPTION_LIMIT, skillMarker, withSkillMarker, buildSkillReference,
         buildInvestigationDescription } from "../devops_skill.mjs";
import { uploadRecordFor } from "../devops_agent_skills.mjs";

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
  // 调查：CreateBacklogTask 的 description 必须是加工后的 description（内联或引用，见下面那组用例）。
  assert.ok(/built = buildInvestigationDescription\(/.test(INV));
  assert.ok(/description = built\.description/.test(INV));
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

/* ── 深度调查的描述上限（CreateBacklogTask.description ≤ 10,000 字）──
 * 原来深度调查照 MAX_SKILL_BODY（24,000）内联，预置的 aws-well-architected-review-devops（约 19,000 字）
 * 一选就 413。现在：放得下照旧内联；放不下而已发布 → 引用 Agent Space 里安装的那份；都不行 → 不发起。 */
const big = (n) => skill({ body: "x".repeat(n) });
const UP = { asset_id: "a-1", agent_space_id: "sp-1", uploaded_version: "1.1.0", marker: true };

await t("触发标记：追加一次、压成单行、已有就不重复", () => {
  assert.equal(skillMarker("rds-health-check"), "NOTIOPS_SKILL:rds-health-check");
  const d = withSkillMarker("查 RDS\n连接数", "rds-health-check");
  assert.ok(!d.includes("\n"), "描述必须是单行（SKILL.md frontmatter）");
  assert.ok(d.startsWith("查 RDS 连接数 "));
  assert.ok(d.endsWith("NOTIOPS_SKILL:rds-health-check."));
  assert.equal(withSkillMarker(d, "rds-health-check"), d);
  assert.equal(withSkillMarker("", "x1"), "Use this skill when the task description contains NOTIOPS_SKILL:x1.");
});

await t("放得下 → 照旧内联（用的是最新版正文）", () => {
  const r = buildInvestigationDescription({ text: "看下 RDS", skill: skill(), upload: UP });
  assert.equal(r.mode, "inline");
  assert.ok(r.description.includes("先看连接数") && r.description.endsWith("看下 RDS"));
});

await t("放不下、已发布 → 引用安装的那份：标记 + 名称 + 已安装版本 + 原话，不带正文", () => {
  const r = buildInvestigationDescription({ text: "看下 RDS", skill: big(12000), upload: UP });
  assert.equal(r.mode, "reference");
  assert.ok(r.description.startsWith("NOTIOPS_SKILL:rds-health-check\n"));
  assert.ok(r.description.includes("RDS 巡检") && r.description.includes("v1.1.0"));
  assert.ok(!r.description.includes("xxxxxxxxxx"), "引用模式不该再带正文");
  assert.ok(r.description.endsWith("看下 RDS"));
  assert.ok(r.description.length <= DESCRIPTION_LIMIT);
  assert.ok(buildInvestigationDescription({ text: "q", skill: big(12000), upload: UP, en: true })
    .description.includes("installed in this Agent Space"));
});

await t("放不下、没发布 → SkillTooLong（published:false），不截断硬发", () => {
  assert.throws(() => buildInvestigationDescription({ text: "看下 RDS", skill: big(12000), upload: null }),
    (e) => e.name === "SkillTooLong" && e.published === false && e.size > DESCRIPTION_LIMIT);
});

await t("已发布但原话本身太长 → SkillTooLong（published:true）", () => {
  assert.throws(() => buildInvestigationDescription({ text: "y".repeat(DESCRIPTION_LIMIT), skill: big(12000), upload: UP }),
    (e) => e.name === "SkillTooLong" && e.published === true);
});

await t("真实的预置 skill：aws-well-architected-review-devops 超过上限 → 必须先发布", () => {
  const body = readFileSync(new URL("../preset-skills/aws-well-architected-review-devops/SKILL.md", import.meta.url), "utf8");
  const s = skill({ skill_id: "aws-well-architected-review-devops", name: "WAR", body });
  assert.ok(body.length > DESCRIPTION_LIMIT, "这份预置 skill 变短了 —— 用例的前提不成立，换一个更长的样本");
  assert.throws(() => buildInvestigationDescription({ text: "做一次 WAR", skill: s, upload: null }), (e) => e.name === "SkillTooLong");
  assert.equal(buildInvestigationDescription({ text: "做一次 WAR", skill: s, upload: UP }).mode, "reference");
});

await t("超长时不发起调查：SkillTooLong 分支在 startInvestigation 之前 return", () => {
  const seg = INV.split("skill_too_long")[1] || "";
  assert.ok(/finishUsage\(\);\s*return reply;/.test(seg.slice(0, 2600)), "SkillTooLong 之后没有直接返回");
  assert.ok(INV.indexOf("skill_too_long") < INV.indexOf("started = await startInvestigation("),
    "SkillTooLong 的判断必须在发起调查之前");
});

await t("buildSkillReference 的 lead 放在标记之后、说明之前（定时任务写第几次运行用）", () => {
  const s = buildSkillReference({ text: "q", skill: skill(), upload: UP, lead: "[定时任务 X · 第 3 次]\n" });
  assert.ok(s.startsWith("NOTIOPS_SKILL:rds-health-check\n[定时任务 X · 第 3 次]\n["));
});

/* ── 上传记录查找 / 发布时带标记 / 回查状态 ── */
const SKILLS_SRC = readFileSync(new URL("../devops_agent_skills.mjs", import.meta.url), "utf8");

await t("uploadRecordFor：规范键优先，否则按 Agent Space id 命中历史键，都没有 → null", () => {
  const sk = { devops_agent: { uploads: { self: { agent_space_id: "sp-self", uploaded_version: "1.0.0" },
                                          "111122223333": { agent_space_id: "sp-m", uploaded_version: "2.0.0" } } } };
  assert.equal(uploadRecordFor(sk, { scope: "self", agentSpaceId: "sp-self" }).uploaded_version, "1.0.0");
  assert.equal(uploadRecordFor(sk, { scope: "cross-payer", accountId: "111122223333", agentSpaceId: "sp-m" }).uploaded_version, "2.0.0");
  const legacy = { devops_agent: { uploads: { "444455556666": { agent_space_id: "sp-self", uploaded_version: "0.9.0" } } } };
  assert.equal(uploadRecordFor(legacy, { scope: "self", agentSpaceId: "sp-self" }).uploaded_version, "0.9.0");
  assert.equal(uploadRecordFor(sk, { scope: "cross-payer", accountId: "999", agentSpaceId: "sp-x" }), null);
  assert.equal(uploadRecordFor({}, { scope: "self", agentSpaceId: "sp-self" }), null);
});

await t("发布：发出去的 SKILL.md 与 metadata 都用带标记的描述，记账写 marker:true", () => {
  assert.ok(/const daDescription = withSkillMarker\(/.test(SKILLS_SRC));
  assert.ok(/buildSkillMd\(\{ \.\.\.skill, description: daDescription \}\)/.test(SKILLS_SRC));
  assert.ok(/description: daDescription,/.test(SKILLS_SRC));
  assert.ok(/marker: true,/.test(SKILLS_SRC));
});

await t("回查状态：只有 ResourceNotFoundException 才清记账，其它错误只报 check_failed", () => {
  const fn = SKILLS_SRC.split("export async function checkSkillDevopsStatus")[1].split("\nexport ")[0];
  assert.ok(/GetAssetCommand/.test(fn));
  assert.ok(/e\?\.name === "ResourceNotFoundException"[\s\S]{0,200}missing\.push\(key\)/.test(fn));
  assert.ok(/check_failed/.test(fn));
  assert.ok(/if \(missing\.length\)[\s\S]{0,160}setSkillDevopsStatus/.test(fn));
});

console.log(fails ? `\n${fails} failed` : `\n${ok} ok, 0 failed`);
process.exit(fails ? 1 : 0);
