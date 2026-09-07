/**
 * Web 侧「案例开在哪个账号」的凭证来源（源码级断言）。
 * 运行：node bff/web-chat/tests/support_cross_account.test.mjs
 *
 * ## 为什么是源码断言而不是行为测试
 *
 * 与 `cross_account_identity.test.mjs` 同一取舍：`_registryRoleArn` /
 * `supportClientFor` 都没导出，而它们的调用链会打 DDB + STS + Support。
 * 要跑行为测试就得把三个 SDK 都 mock 掉，脚手架比被测逻辑还长；而这里要守的
 * 东西恰好都能从源码上判断（**读的是注册表还是角色名约定、有没有 enabled 闸门、
 * 有没有账号段校验、失败时会不会回落到部署账号**）。
 *
 * ⚠️ 源码断言的弱点是「改了写法就误报」，所以每条只钉**语义必需**的形状。
 *
 * ## 守的是什么（2026-09-07，案例多账号）
 *
 * 这条路以前拼 `arn:aws:iam::<acct>:role/${NOTIOPS_CROSS_ACCOUNT_ROLE}`。
 * 那个环境变量本身是**对的**（`web-chat-core.ts` 的 `orgSwitch` 在 org 模式下
 * 给的是带部署账号后缀的名字，现网实测就是这个值）—— 所以这不是一个
 * 「跨账号案例从来没通过」的 bug。换成查注册表守的是另外三件事：
 *
 *   ① 角色名约定是**第二份事实来源**：手动接入的账号允许给一个不按约定命名的
 *      `role_arn`，按约定拼就 assume 到一个不存在的角色（表现是"神秘的
 *      AccessDenied"，而表里那一行明明是好的）。
 *   ② **没有 `enabled` 闸门**：客户在 Web「账户」页停用某个成员账号后，
 *      `casesOrgSummary` 的聚合读会把它过滤掉（`_enabledAccounts`），但**点开
 *      单账号视图 / 开工单那条路照样能 assume 进去** —— 停用没停干净。
 *   ③ 没有 confused-deputy 防线：将来多一个写入方（导入 / 迁移脚本 / 人工改表）
 *      就有人能让 BFF 的执行角色 assume 到他自己账号里的角色。
 *
 * 与 agent 侧 `core/aws_session.py::role_arn_for` 是同一口径（那边由
 * `tests/test_core_tree_parity.py` 钉住两份 Python 副本允许分叉的**理由**）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "..", "support.mjs"), "utf8");

/* 只留代码行：整行注释（`//` / JSDoc 的 ` * ` / `/*` / `*​/`）全丢掉。
 * 不做行尾注释剥离 —— 那会误伤字符串里的 `//`，而本文件的判据都不需要。
 * 目的是让「文档里提到某个名字」与「代码真的读了它」分开：下面 ② / ④ 两条
 * 断的是**代码里没有**，而模块头的长注释里这两个名字都出现过。 */
const code = src.split("\n")
  .filter((l) => {
    const t = l.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  })
  .join("\n");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/* 自检：文件与剥注释后的代码都真读到了（路径漂移 / 剥错了会让下面全部恒绿）。 */
ok("读到了 support.mjs（自检）", src.length > 5000 && /async function supportClientFor/.test(src));
ok("剥注释后仍是可用代码（自检）", /async function _registryRoleArn\(acct\)/.test(code));

/* ── ① role_arn 只信注册表那一行 ── */
ok("按 `PK=account#<id>` / `SK=meta` 读注册表",
  /PK:\s*`account#\$\{acct\}`/.test(code) && /SK:\s*"meta"/.test(code));
ok("取的是 `role_arn`", /row\.role_arn/.test(code));

/* ── ② 不许按角色名约定拼 ARN ──
 *
 * 🔴 这条是本文件的核心。留着它就等于留着第二份事实来源，而两份事实**分歧时
 *    没有任何信号**：表里那一行是好的、拼出来的角色不存在，客户看到的只是
 *    AccessDenied。 */
ok("代码里不再读 NOTIOPS_CROSS_ACCOUNT_ROLE（角色名约定 = 第二份事实来源）",
  !/NOTIOPS_CROSS_ACCOUNT_ROLE/.test(code));
ok("代码里没有手拼 `:role/` 的 ARN 模板",
  !/arn:aws:iam::\$\{/.test(code) && !/:role\/\$\{/.test(code));

/* ── ③ enabled 闸门：Web 上停用 = 这条路也进不去 ── */
ok("`enabled !== true` 直接拒（停用要停干净）",
  /row\.enabled\s*!==\s*true/.test(code));

/* ── ④ 绝不拿 trigger_role_arn 当采集角色 ──
 *
 * ⚠️ `trigger_role_arn` 是「关联 DevOps Agent」那一步写的**另一个**角色
 *    （信任策略与权限都不同）。两个字段都在同一行里，取错不报错、只是
 *    AccessDenied，所以钉住"代码里根本没提它"。 */
ok("代码里完全不碰 trigger_role_arn", !/trigger_role_arn/.test(code));

/* ── ⑤ confused-deputy：ARN 的账号段必须等于目标账号 ──
 *
 * 走 `role_guard.mjs` 的 `roleArnAccount`，**不许**在这里手写第二份解析：
 * 手写的 `startsWith("arn:aws:iam::")` + `split(":")[4]` 两头都漏 —— aws-cn
 * 分区的合法 ARN 会被拒（中国区开不了工单），而 `…:user/x` 这种非 role ARN
 * 反倒放过去。`tests/role_guard.test.mjs` 的调用点普查也盯着这一处。 */
ok("账号段校验走 role_guard 那一份（不许手写第二份解析）",
  /roleArnAccount\(arn\)\s*!==\s*acct/.test(code));
ok("import 的就是 role_guard.mjs", /from "\.\/role_guard\.mjs"/.test(code));

/* ── ⑥ 拿不到凭证 → null，**绝不**回落到部署账号 ──
 *
 * 🔴 回落不是"少了个功能"，而是**在部署账号里**执行了一次本该落在成员账号的
 *    写操作，而用户看到的是"提交成功" —— 一张开错账号的工单。 */
ok("没有 `|| _localClient` / `?? _localClient` 这类兜底",
  !/(\|\||\?\?)\s*_localClient/.test(code));
ok("`_registryRoleArn` 拿不到就 return null",
  /if \(!roleArn\) return null;/.test(code));
ok("AssumeRole 失败也 return null（catch 里不回落）",
  /catch \{\s*return null;\s*\}/.test(code));
/* `_localClient` 在代码里只许出现三次：声明、部署账号那一支、
 * `DescribeServices`（服务目录是全局只读数据，与账号无关）。多出来的第四处
 * 极可能就是一次回落。 */
ok("代码里 `_localClient` 只出现 3 次（声明 / 部署账号分支 / DescribeServices）",
  (code.match(/_localClient/g) || []).length === 3);

/* ── ⑦ 所有 Support 调用都走 supportClientFor ──
 *
 * `new SupportClient(` 只许有两处：模块级的 `_localClient` 与
 * `supportClientFor` 里那个带临时凭证的。第三处 = 有人绕过了闸门。 */
ok("`new SupportClient(` 只有 2 处（绕过闸门就会变多）",
  (code.match(/new SupportClient\(/g) || []).length === 2);
ok("读侧与写侧都取 `await supportClientFor(`",
  (code.match(/await supportClientFor\(/g) || []).length >= 4);

/* ── ⑧ **生产侧**：CDK 真的把 CONFIG_TABLE 注给了 BFF ──
 *
 * 🔴 上面全是消费侧断言。`_registryRoleArn` 读的表名来自 `CONFIG_TABLE`，
 *    这个键要是没注入，代码里的默认值 `"notiops-config"` 会让它在**改过表名**
 *    的部署上读一张不存在的表 → `catch` → 一律 null → 所有跨账号案例操作都报
 *    `cross_account_unavailable`，而日志里只有一次 DDB 404。
 *    同一形态（消费侧 14 个测试全绿、CDK 侧漏注入）在 DEPLOY_ACCOUNT_ID 上
 *    真踩过一次，见 `cross_account_identity.test.mjs` 第 ⑧ 条。 */
const core = readFileSync(
  join(HERE, "..", "..", "..", "infra", "lib", "constructs", "web-chat-core.ts"), "utf8");
ok("读到了 web-chat-core.ts（自检，防路径漂移后断言无意义）",
  /environment:\s*\{/.test(core) && core.length > 5000);
ok("CDK 把 CONFIG_TABLE 注入了 BFF", /^\s*CONFIG_TABLE:\s*"notiops-config"\s*,/m.test(core));

/* ── ⑨ **门禁侧**：`action.account_id` 必须过集中的账号可见性门 ──
 *
 * 🔴 这是「开案例卡上的账号下拉」的**硬前置**。`/actions/execute` 的请求体把目标
 *    账号**嵌一层**（`{action: {type, params, account_id}}`），而 index.mjs 那道
 *    集中门原来只看三个**平铺**键名（`q.account` / `body.account_id` /
 *    `body.account`）→ 这个端点整个不过门。
 *
 *    在下拉出现之前这只是"难以触达"：前端只回传 agent 自己提议的那个账号。
 *    2026-09-07 之后这个键**由客户直接控制** —— 一个手写的 `curl`（或改一下下拉
 *    的 option value）就能在一个自己无权看到的账号里开工单 / 回复 / 关单。
 *
 * ⚠️ 上面 ①-⑧ 那些数据层断言**挡不住这一类**：`supportClientFor` 只问
 *    「注册表里有这个账号、enabled、role_arn 合法吗」，它不问「**这个登录用户**
 *    能不能看到这个账号」。多账号部署里那两件事不是一回事 —— 一个只被授予了
 *    账号 A 的用户，对账号 B 照样满足数据层的全部条件。 */
const idx = readFileSync(join(HERE, "..", "index.mjs"), "utf8");
ok("读到了 index.mjs（自检）",
  idx.length > 20000 && /const accountCandidates = \[/.test(idx));
const gate = idx.slice(idx.indexOf("const accountCandidates = ["));
const gateBody = gate.slice(0, gate.indexOf("\n      ]"));
ok("门禁的候选里有 `action.account_id`（/actions/execute 的形状）",
  /authBody && authBody\.action && authBody\.action\.account_id/.test(gateBody));
ok("候选是逐个校验（不是 `a || b || c` 合成一个标量）",
  /for \(const cand of accountCandidates\)/.test(gate.slice(0, 900))
  && /isAccountVisible\(id,/.test(gate.slice(0, 900)));
/* 前端也要真的按这个键名发（键名对不上 = 门在空转，而客户仍能选账号）。 */
const msg = readFileSync(
  join(HERE, "..", "..", "..", "frontend", "chat-app", "src", "api", "chat.ts"),
  "utf8");
ok("前端 executeAction 把整个 action 对象发上去（account_id 嵌在里面）",
  /actions\/execute/.test(msg) && /JSON\.stringify\(\{ action/.test(msg));

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
