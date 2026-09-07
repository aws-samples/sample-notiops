/**
 * confused-deputy 防御（role ARN 账号段校验）—— 行为测试 + 调用点普查。
 * 运行：node bff/web-chat/tests/role_guard.test.mjs
 *
 * ## 守的是什么（2026-09-06 交叉 review P1）
 *
 * config 表是本系统最弱的写入口：有管理权限的用户能写 `account#<id>.role_arn`
 * 或 `da#<id>.trigger_role_arn`。Python 侧（shared/account_scope.py）2026-08-30
 * 就全量装上了账号段校验并写明攻击链，而 JS 侧四个 AssumeRole 点零覆盖 ——
 * IAM 授权是 `arn:aws:iam::*` 账号段通配，不兜底。后果：投毒一条 role_arn 指向
 * 攻击者账号 → 跨账号看板把攻击者的数据渲染成受害账号的 / skill 传进攻击者 space。
 *
 * ## 判据结构
 * ① role_guard.mjs 本体行为（真 import 真调用，不是源码断言）
 * ② 每个「ARN 来自表数据」的 AssumeRole 点前面必须有 assertRoleBelongsTo
 * ③ AssumeRole 调用点普查：总数钉死 —— 新增一个点必须来这里分类
 *    （表数据 → 必须加防御；按账号拼出来的 ARN → 天然安全，登记进白名单）
 * ④ StackSetNotFound 的可执行报错（同一轮 review 的 P1，顺带钉在这里）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, "..", f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/* ── ① role_guard 本体行为 ── */
const { assertRoleBelongsTo, roleArnAccount } = await import("../role_guard.mjs");

ok("匹配的 ARN 放行并返回账号段",
  assertRoleBelongsTo("arn:aws:iam::111122223333:role/foo", "111122223333") === "111122223333");
ok("账号段不匹配 → 抛（默认 code=bad_request）", (() => {
  try { assertRoleBelongsTo("arn:aws:iam::444455556666:role/foo", "111122223333"); return false; }
  catch (e) { return e.code === "bad_request"; }
})());
ok("code 参数可指定", (() => {
  try { assertRoleBelongsTo("arn:aws:iam::444455556666:role/foo", "111122223333", "config_error"); return false; }
  catch (e) { return e.code === "config_error"; }
})());
ok("畸形 ARN → 拒绝（不是 role ARN 就不许 assume）", (() => {
  try { assertRoleBelongsTo("arn:aws:sts::111122223333:assumed-role/x/y", "111122223333"); return false; }
  catch { return true; }
})());
ok("空 ARN / 空账号 → 拒绝", (() => {
  try { assertRoleBelongsTo("", "111122223333"); return false; } catch { /* 继续 */ }
  try { assertRoleBelongsTo("arn:aws:iam::111122223333:role/foo", ""); return false; } catch { return true; }
})());
ok("aws-cn 分区也能解析（海外/中国区双分区）",
  roleArnAccount("arn:aws-cn:iam::111122223333:role/foo") === "111122223333");
ok("roleArnAccount 对非 role ARN 返回空串",
  roleArnAccount("arn:aws:iam::111122223333:user/foo") === "");

/* ── ② 表数据 ARN 的 AssumeRole 点必须先过防御 ── */
const accounts = read("devops_agent_accounts.mjs");
const skills = read("devops_agent_skills.mjs");
const member = read("member_accounts.mjs");

// getAssumedCredentialsForAccount：防御在 AssumeRole 之前，且失败走 return null（契约是绝不抛）
{
  const i = accounts.indexOf("assertRoleBelongsTo(arn, accountId)");
  const j = accounts.indexOf("RoleSessionName: \"notiops-web-chat-bff-cost-query\"");
  ok("getAssumedCredentialsForAccount 有防御且在 AssumeRole 之前", i > -1 && j > i);
  ok("该点防御失败返回 null（不抛，守住「绝不拖垮 FinOps 整页」契约）",
    /assertRoleBelongsTo\(arn, accountId\);[\s\S]{0,120}catch \(e\) \{[\s\S]{0,160}return null/.test(accounts));
}
// skill 上传
{
  const i = skills.indexOf("assertRoleBelongsTo(cfg.trigger_role_arn, id)");
  const j = skills.indexOf("RoleSessionName: \"notiops-skill-upload\"");
  ok("skill 上传的 AssumeRole 有防御且在前", i > -1 && j > i);
}
// testDaConnection：分步结果约定 → 防御失败要返回结构化 step
{
  ok("testDaConnection 有 RoleArnCheck 前置步",
    /step: "RoleArnCheck"/.test(member)
    && member.indexOf("step: \"RoleArnCheck\"") < member.indexOf("RoleSessionName: \"notiops-test-conn\""));
}
// org 一键路径的 da# 写入（callback 白名单最强判据行）
{
  const i = member.indexOf("assertRoleBelongsTo(outs.TriggerRoleArn, id");
  const j = member.indexOf("SET agent_space_id = :asi");
  ok("da# 行写入前校验 TriggerRoleArn 账号段（org 路径与手动路径标准一致）",
    i > -1 && j > i);
}

/* ── ③ AssumeRole 调用点普查：总数钉死 ── */
const files = ["devops_agent_accounts.mjs", "devops_agent_skills.mjs",
  "member_accounts.mjs", "support.mjs", "xacct.mjs", "devops_investigate.mjs",
  "inspection.mjs", "accounts.mjs"];
let sites = 0;
for (const f of files) {
  try { sites += (read(f).match(/new AssumeRoleCommand\(\{/g) || []).length; }
  catch { /* 文件不存在就算 0 */ }
}
// 6 个已知点：accounts×2（getAssumedCredentialsForAccount 与 _assumeAndCheckPayer，
// 均已防御）、skills×1（已防御）、member×2（testDaConnection 已防御；
// verifyCollectionRole 的 ARN 由 collectionRoleArn(id,...) 按账号拼出，天然账号
// 匹配）、support×1（2026-09-07 开案例支持多账号后 ARN 改成从注册表读，已防御）。
ok(`AssumeRole 调用点总数 = 6（实际 ${sites}）—— 新增调用点必须来本判据分类：`
  + "ARN 来自表数据就加 assertRoleBelongsTo，按账号拼出来的登记进上面的白名单注释",
  sites === 6);
ok("_assumeAndCheckPayer 也有防御（ARN 来自 DA 关联配置，同属外部数据）",
  /assertRoleBelongsTo\(roleArn, accountId\)/.test(accounts));
// 白名单两处「拼出来」的形状还在（防止有人改成从表里读而绕开普查）
// support.mjs 曾经是「按账号拼出、安全 by construction」那一类；2026-09-07 开案例
// 打通多账号后它的 ARN 来自 config 表的 `account#<id>.role_arn`，于是落回「表数据」
// 那一类 —— 必须过 role_guard 的解析。这里盯的是**用共享那一份**：手写
// startsWith+split 的版本会拒掉 aws-cn 的合法 ARN，又放过非 role ARN。
ok("support.mjs 的注册表 ARN 过 role_guard 校验账号段（不许手写第二份）",
  /roleArnAccount\(arn\) !== acct/.test(read("support.mjs"))
  && /from "\.\/role_guard\.mjs"/.test(read("support.mjs")));
ok("verifyCollectionRole 的 ARN 仍来自 collectionRoleArn(id",
  /const roleArn = collectionRoleArn\(id/.test(member));

/* ── ④ StackSetNotFound → 可执行的报错 ── */
ok("onboardAccount 把 StackSetNotFoundException 翻译成带出路的 config_error",
  /StackSetNotFoundException[\s\S]{0,600}--multi-account[\s\S]{0,300}手动接入/.test(member));
ok("associateDevopsAgent 同样翻译",
  (member.match(/StackSetNotFoundException/g) || []).length >= 2);

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
