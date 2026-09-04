/**
 * 跨账号「我自己是谁」的解析（源码级断言）。
 * 运行：node bff/web-chat/tests/cross_account_identity.test.mjs
 *
 * ## 为什么是源码断言而不是行为测试
 *
 * `selfAccount()` 没导出，而它的调用方 `resolveTarget()` 会打 DDB + STS。
 * 要跑行为测试就得把两个 SDK 都 mock 掉 —— 那套脚手架比被测逻辑还长，
 * 而这里要守的东西恰好都能从源码上判断（**哪个 env 排第一、有没有兜底、
 * 判断有没有非空守卫**）。
 *
 * ⚠️ 源码断言的弱点是「改了写法就误报」。所以每条都只钉**语义必需**的形状，
 * 不钉格式（比如不要求 `||` 必须在同一行）。
 *
 * ## 守的是什么缺陷（2026-08-25）
 *
 * ```
 * const SELF_ACCOUNT = LOCKED_ACCOUNT_ID || AWS_ACCOUNT_ID || ""
 * ```
 *
 * 两个都可能是空：
 *
 * ```
 * LOCKED_ACCOUNT_ID   orgMode ? "" : <账号>   ← **多账号模式下就是空的**
 *                     它的语义是闸门「只允许这个账号」，解锁 = 留空
 * AWS_ACCOUNT_ID      不是 Lambda 标准注入变量，CDK 里也没注入
 * ```
 *
 * 空串的后果在 `resolveTarget()`：`id === SELF_ACCOUNT` 恒不成立，于是
 * **传部署账号自己的 ID 会走跨账号分支** —— 去 `da#<部署账号>` 拿
 * `trigger_role_arn` 然后 assume 自己，还带上 `ExternalId`。那个角色的信任
 * 策略未必有 ExternalId 条件，所以「org 模式下从 UI 选『本账号』发布 skill」
 * 可能直接失败。
 *
 * 同一个形态在 `lambda_inspection_executor/handler.py` 上也踩过一次
 * （见那里 `_deploy_account_id` 的说明），所以两处都要钉住。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "..", "devops_agent_skills.mjs"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/* ── ① 解析顺序：身份变量排在闸门变量之前 ── */
ok("DEPLOY_ACCOUNT_ID 排在 LOCKED_ACCOUNT_ID 之前（后者 orgMode 下为空）",
  /DEPLOY_ACCOUNT_ID[\s\S]{0,60}LOCKED_ACCOUNT_ID/.test(src));

/* ── ② 有 STS 兜底：不依赖 CDK 是否注入到位 ── */
ok("有 STS get-caller-identity 兜底",
  /GetCallerIdentityCommand/.test(src));
ok("兜底结果有缓存（否则每次上传都多一次 STS 往返）",
  /_selfAccountCache/.test(src));

/* ── ③ 模块级常量已删：它是「一次求值、之后永远是那个空串」的根源 ── */
ok("模块级 SELF_ACCOUNT 常量已删",
  !/^const SELF_ACCOUNT\s*=/m.test(src));

/* ── ④ 调用点用 await，不用旧常量 ── */
ok("resolveTarget 里 await selfAccount()",
  /const self = await selfAccount\(\)/.test(src));

/* ── ⑤ 非空守卫：空串不该让任何 id 命中「是我自己」 ──
 *
 * 🔴 这条最关键。少了它，`selfAccount()` 万一返回空串（STS 也失败），
 *    `id === ""` 对任何真实 12 位账号都不成立 —— 那时行为退化成
 *    「所有账号都当跨账号」，与修复前一致（不更坏）。
 *    但如果写成 `id === self || !self`（把空串当成「是自己」），
 *    就会把**成员账号**也当成自己，把 skill 传进部署账号的 space。 */
ok("self 判断有非空守卫（空串不匹配任何 id）",
  /if \(!id \|\| \(self && id === self\)\)/.test(src));

/* ── ⑥ 去重的两条判据都在 ──
 *
 * ⚠️ `agent_space_id` 那条是 `selfAccount()` 返回空串时唯一能防住
 *    「同一个 Agent Space 既以 self 又以 cross-payer 出现」的东西
 *    （客户看到两个同名目标，不知道该选哪个）。 */
ok("去重按 account_id 判（带非空守卫）",
  /if \(_self && it\.account_id === _self\) continue;/.test(src));
/* ⚠️ 判据从 `SELF_AGENT_SPACE` 放宽到 `selfSpace`（2026-09-03 合并 main）。
   main 把「本账号的 space 从哪来」换成了三态探测 `localAgentSpaceProbe()`
   （区分「确定没有」与「这次问不出来」），所以去重比的是那个探测结果而不是
   裸 env 常量。**防的是同一件事**：本部署账号既以 self 又以 cross-payer
   出现（同一个 Agent Space 列两次，客户不知道该选哪个）。

   ⚠️ 两种写法都接受，但**必须有非空守卫** —— `selfSpace` 为空时
   `it.agent_space_id === ""` 会把所有没带 space 的条目全吃掉。 */
ok("去重也按 agent_space_id 判（account_id 拿不到时的唯一防线）",
  /if \(selfSpace && it\.agent_space_id === selfSpace\) continue;/.test(src)
  || /if \(it\.agent_space_id === SELF_AGENT_SPACE\) continue;/.test(src));

/* ── ⑦ member_accounts.mjs 同一形态 ──
 *
 * 那个文件的 `SELF_ACCOUNT` 原来是 `process.env.AWS_ACCOUNT_ID || ""`，
 * 而 **`AWS_ACCOUNT_ID` 不是 Lambda 的标准注入变量**（线上实测是 None）——
 * 于是它恒为空串，每个用到它的地方都在走 STS 兜底。
 *
 * ⚠️ 这里同样**不许** fallback 到 `LOCKED_ACCOUNT_ID`：那是闸门语义，
 *    orgMode 下为空。用它当身份已经踩过两次（executor 与 skill 上传）。 */
const ma = readFileSync(join(HERE, "..", "member_accounts.mjs"), "utf8");
const maSelf = (ma.match(/const SELF_ACCOUNT = [^;]+;/) || [""])[0];
ok("member_accounts 的 SELF_ACCOUNT 优先读 DEPLOY_ACCOUNT_ID",
  /DEPLOY_ACCOUNT_ID/.test(maSelf));
ok("member_accounts 的 SELF_ACCOUNT **不**读 LOCKED_ACCOUNT_ID（闸门≠身份）",
  !/LOCKED_ACCOUNT_ID/.test(maSelf));

/* ── ⑧ **生产侧**：CDK 真的把 DEPLOY_ACCOUNT_ID 注给了 BFF ──
 *
 * 🔴 上面 ①~⑦ 全是**消费侧**断言（BFF 源码怎么读这个键）。它们结构上守不到
 *    「CDK 压根没注入」—— 2026-09-03 合并 main 时正是这么丢的：
 *
 *      这个键原来在 `web-chat-stack.ts:115`（`DEPLOY_ACCOUNT_ID: this.account`），
 *      是我方分支加的、main 侧从来没有。main 的 d7de88e 把 BFF 的资源定义
 *      抽进 `constructs/web-chat-core.ts`，迁移时把巡检那 5 个 env var 搬过去了、
 *      漏了这一个 —— 而消费侧 14 个测试文件全绿，因为它们读的是 .mjs 源码。
 *      最后靠 `cdk diff` 输出里一行 `[-] Removed: .DEPLOY_ACCOUNT_ID` 才发现。
 *
 * ⚠️ 判据读的是 **`constructs/web-chat-core.ts`**（BFF 资源的唯一定义处，
 *    两条部署路径共用），不是 `web-chat-stack.ts`（现在只剩 30 行委托壳）。
 *
 * ⚠️ 为什么不靠 golden fixture 兜：那是快照，`UPDATE_GOLDEN=1` 一跑就跟着变，
 *    删掉这个键照样"通过"。这条是显式断言，删了就红。 */
const core = readFileSync(
  join(HERE, "..", "..", "..", "infra", "lib", "constructs", "web-chat-core.ts"), "utf8");
// 自检：文件真读到了（路径漂移时上面那条会因 "" 不含关键字而恒红，但要说清原因）
ok("读到了 web-chat-core.ts（自检，防路径漂移后断言无意义）",
  /environment:\s*\{/.test(core) && core.length > 5000);
ok("CDK 把 DEPLOY_ACCOUNT_ID 注入了 BFF（生产侧，member_accounts 没有兜底）",
  /^\s*DEPLOY_ACCOUNT_ID:\s*stack\.account\s*,/m.test(core));
// 注的必须是**部署账号**本身，不是 orgSwitch 派生值 —— 身份与闸门不同语义，
// 用 orgSwitch 包一层的表现就是 org 模式下又变回空串。
ok("注入值是 stack.account 而非 orgSwitch(...)（闸门≠身份）",
  !/DEPLOY_ACCOUNT_ID:\s*orgSwitch/.test(core));

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
