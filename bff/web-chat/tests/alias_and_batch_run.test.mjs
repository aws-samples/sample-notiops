/**
 * 账号 alias + 「全部账号」批量触发（2026-08-31 新增）。
 * 运行：node bff/web-chat/tests/alias_and_batch_run.test.mjs
 *
 * ## ① alias：为什么这个入口必须存在
 *
 * 两个字段本来就有，缺的只是「能改」：
 *
 * ```
 * account#<id>.account_name    → listAccounts() → 聊天页顶部账号选择器
 *                              → 管理页列表、各看板的账号列
 * da#<id>.account_alias        → lambda4_notifier 的推送标签
 *                                （`label = account_alias or f"账号 {id}"`）
 *                              → investigation 记录、DA 调查列表的筛选键
 * ```
 *
 * 而这两个值此前**只在接入那一刻写一次**，来源是
 * `organizations:DescribeAccount` 的 `Account.Name`。跨组织接入的账号那个调用
 * 拿不到东西（账号不在本组织里）→ 两个字段都是空 → 客户在选择器和 IM 推送里
 * 看到的是**十二位数字**。本项目实机就是这个形态（111122223333 属于
 * o-aaaabbbbcc，部署账号 444455556666 属于 o-ddddeeeeff）。
 *
 * 🔴 本文件钉住三件互相独立的事，缺一件都会退回一种**静默**状态：
 *
 * ```
 * 两行一起写      只写 account# → 页面改好了而 IM 推送还是旧名字
 *                （与 setAccountEnabled 踩过的坑同形态）
 * alias_source   无条件让 DDB 的 account_name 赢 → org 改名后列表永远显示旧名
 * da# 用条件写    建桩行 → enabled_accounts 把一个没有 agent space 的账号
 *                当成可巡检账号
 * ```
 *
 * ## ② 「全部账号」：为什么判据是「一次 invoke」而不是「N 次」
 *
 * scheduler 那侧本来就按列表扇出
 * （`[DueRun(manual.run_type, a, now.date()) for a in manual.account_ids]`），
 * 所以给数组是它的原生形态。循环 invoke N 次的坏处是**部分成功**：
 * 第 3 次抛 AccessDenied 时前两个已经在跑了，而这个函数只能返回一个结果 ——
 * 要么谎报全失败（客户重试 → 前两个账号各跑两轮、花两倍的钱），要么谎报全成功。
 *
 * ⚠️ 这个端点在 `capabilities.json` 里**没有账号维度的授权**
 *    （`action:inspection:run` 只有 `POST /inspection/run$` 一条路由，
 *    任何拿到它的人本来就能指定任意 account_id）。所以「全部账号」不放大权限
 *    —— 它放大的是**钱和时长**，护栏在前端那个二次确认屏上，
 *    由 `frontend/chat-app/src/inspection.test.ts` 钉住。
 */
// 🔴 **必须在任何 `await import()` 之前设**：那两个模块顶部有模块级
//    `const CONFIG_TABLE = process.env.CONFIG_TABLE || ...`，
//    模块加载之后再设对它们完全无效（ESM 的 const 只求值一次）。
process.env.CONFIG_TABLE = process.env.CONFIG_TABLE || "t";
process.env.AWS_REGION = "ap-northeast-1";
process.env.INSPECTION_SCHEDULER_FUNCTION = "notiops-inspection-scheduler";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const memberSrc = readFileSync(join(HERE, "..", "member_accounts.mjs"), "utf8");
const inspSrc = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
const idxSrc = readFileSync(join(HERE, "..", "index.mjs"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  let v;
  try { v = typeof cond === "function" ? cond() : cond; }
  catch (e) { fail++; console.log(`  FAIL ${name}  (threw: ${e?.message || e})`); return; }
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/**
 * **总数守卫。** 断言被 `if` / `try` 跳过或被谁删掉时，
 * `PASSED: n ok, 0 failed` 照样打印而条数变少 —— 没人会注意。
 * 数字变了就来改这里；这一步是刻意的摩擦。
 *
 * ⚠️ 它管不了「在这道守卫之前 process.exit(0)」那种情形。
 *    `package.json` 的 test 脚本给每个文件接了
 *    `| tee /dev/stderr | grep -q ', 0 failed'` 来兜那一类。
 */
const EXPECTED_TOTAL = 71;

/** 剥掉 `//` 行注释。**否定式**断言（`!/.../`）一律用它。
 *
 * 🔴 这个仓库踩过**七次**「断言命中自己解释判据的注释」。而这个文件要断言的
 *    每一条判据，在产品代码里旁边都写着一段解释它的注释 —— 撞上只是时间问题。
 */
const strip = (code) => code.split("\n")
  .map((ln) => ln.replace(/\/\/.*$/, "")).join("\n");

/** 取一个顶层导出函数的函数体（到第一个行首 `}` 为止）。 */
function bodyOf(src, name) {
  const i = src.indexOf(`export async function ${name}`);
  if (i < 0) return "";
  const rest = src.slice(i);
  const end = rest.indexOf("\n}\n");
  return end < 0 ? rest : rest.slice(0, end);
}

// ═══════════════════════════════════════════════════════════════════════════
// ① alias —— 真调
// ═══════════════════════════════════════════════════════════════════════════

const member = await import("../member_accounts.mjs");
const lib = await import("@aws-sdk/lib-dynamodb");

/**
 * 真调 `setAccountAlias` 一次，把每条 DDB 写入都录下来。
 *
 * @param alias        传给函数的值
 * @param opts.daExists  `da#` 行存不存在（false → 条件写抛
 *                       ConditionalCheckFailedException，与真 DDB 同形）
 * @param opts.cfg     `GetCommand` 返回的 `account#` 行（null → 未登记）
 */
async function callAlias(alias, { daExists = true, cfg = { enabled: true } } = {}) {
  const orig = lib.DynamoDBDocumentClient.prototype.send;
  const writes = [];
  lib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    const n = cmd?.constructor?.name || "";
    if (n === "GetCommand") return { Item: cfg };
    if (n === "UpdateCommand") {
      const pk = cmd.input.Key.PK;
      /**
       * 🔴 判据是**这条命令自己带没带** `attribute_exists(PK)`，
       *    不是「pk 以 da# 开头」。
       *
       *    第一版按 `daExists` 直接抛 —— 于是把产品代码里那句
       *    `ConditionExpression: "attribute_exists(PK)"` **整行删掉**之后测试
       *    照样全绿（52 ok, 0 failed，2026-08-31 实测）。mock 替产品代码
       *    实现了那道条件，测的是我自己的 mock。
       *
       *    真 DDB 的行为是：没有 ConditionExpression 就无条件 upsert
       *    —— 也就是**建出一个只有 account_alias 的桩行**，而
       *    `enabled_accounts` 会把它当成可巡检账号（`_is_active` 对缺失的
       *    `onboarding_status` 放行），那个账号压根没有 agent space。
       *
       * ⚠️ 抛的是真 DDB 的错误**名**（`name`），不是 `message` ——
       *    产品代码判的是 `e?.name !== "ConditionalCheckFailedException"`。
       */
      const guarded = /attribute_exists\(PK\)/.test(
        cmd.input.ConditionExpression || "");
      if (guarded && !daExists) {
        const e = new Error("The conditional request failed");
        e.name = "ConditionalCheckFailedException";
        throw e;
      }
      writes.push({ pk, input: cmd.input });
      return {};
    }
    return {};
  };
  try {
    const r = await member.setAccountAlias("111122223333", alias);
    return { r, writes, threw: null };
  } catch (e) {
    return { r: null, writes, threw: e };
  } finally {
    lib.DynamoDBDocumentClient.prototype.send = orig;
  }
}

/** 从一条 UpdateCommand 的 input 里取某个字段的值（putConfigAccount 用 #f0/:v0 编号）。 */
function fieldValue(input, key) {
  const names = input.ExpressionAttributeNames || {};
  const slot = Object.keys(names).find((k) => names[k] === key);
  if (!slot) return undefined;
  // `#f3 = :v3` → 取 `:v3`
  const m = new RegExp(`${slot}\\s*=\\s*(:\\w+)`).exec(input.UpdateExpression || "");
  return m ? (input.ExpressionAttributeValues || {})[m[1]] : undefined;
}

/* ── 两行一起写 ─────────────────────────────────────────────────────────── */
{
  const { r, writes } = await callAlias("生产-游戏1");
  const pks = writes.map((w) => w.pk);
  ok("★★★ 真调：account# 与 da# **两行**都被写了 —— 只写一行的表现是"
    + "「页面改好了而 IM 推送还是旧名字」",
    pks.includes("account#111122223333") && pks.includes("da#111122223333"));

  const acct = writes.find((w) => w.pk.startsWith("account#"));
  ok("★★★ account# 那行写的是 account_name（listAccounts() 读的就是它）",
    fieldValue(acct.input, "account_name") === "生产-游戏1");

  const da = writes.find((w) => w.pk.startsWith("da#"));
  ok("★★★ da# 那行写的是 account_alias（lambda4_notifier 的推送标签读它）",
    /account_alias = :a/.test(da.input.UpdateExpression)
    && da.input.ExpressionAttributeValues[":a"] === "生产-游戏1");

  ok("★★ 回传 pushLabelUpdated=true —— UI 要能说清推送标签改了没有",
    r.pushLabelUpdated === true);
  ok("★★ 回传归一后的 alias（不是原始输入）", r.alias === "生产-游戏1");
}

/* ── alias_source：这条决定 org 改名后列表跟不跟着变 ──────────────────────── */
{
  const { writes } = await callAlias("我起的名");
  const acct = writes.find((w) => w.pk.startsWith("account#"));
  ok("★★★ 非空 alias → alias_source=manual（否则 mk() 里那个名字压不过 org 名，"
    + "客户填了没反应）",
    fieldValue(acct.input, "alias_source") === "manual");
}
{
  const { r, writes } = await callAlias("");
  const acct = writes.find((w) => w.pk.startsWith("account#"));
  ok("★★★ 清空 → alias_source **写回 auto**。留着 manual 的表现是："
    + "下次接入回填把 account_name 写成一个快照值，那时它以「人手填的」身份赢了"
    + " —— 一个客户从没输入过的名字",
    fieldValue(acct.input, "alias_source") === "auto");
  ok("★★ 清空是合法操作（不抛），语义是回退到自动来源", r && r.alias === "");
  ok("★★ 清空时 account_name 写空串而不是 REMOVE（读侧的 `||` 兜底链靠它）",
    fieldValue(acct.input, "account_name") === "");
}

/* ── da# 行不存在时**跳过**，不建桩行 ────────────────────────────────────── */
{
  const { r, writes } = await callAlias("只接入了没关联", { daExists: false });
  ok("★★★ da# 行不存在 → 不抛，account# 那半照常写完",
    r !== null && writes.some((w) => w.pk.startsWith("account#")));
  ok("★★★ 回传 pushLabelUpdated=false —— 不回传的话「改了但推送还是旧名字」"
    + "与「都改好了」在界面上一样",
    r.pushLabelUpdated === false);
  ok("★★★ **没有**建 da# 桩行。建了会让 enabled_accounts 把一个没有 agent space "
    + "的账号当成可巡检账号（`_is_active` 对缺失的 onboarding_status 放行）",
    !writes.some((w) => w.pk.startsWith("da#")));
}

/* ── 未登记的账号要拒 ──────────────────────────────────────────────────── */
{
  const { threw, writes } = await callAlias("x", { cfg: null });
  ok("★★★ 账号没登记 → 抛 account_not_registered，且**一个字都不写**",
    threw && /account_not_registered/.test(threw.message) && writes.length === 0);
  ok("★★ 错误带 code=bad_request（路由层据此转 400 而不是 500）",
    threw?.code === "bad_request");
}

/* ── 输入校验的真值表 ──────────────────────────────────────────────────── */
{
  const bad = [
    ["a".repeat(65), "超过 64 个字符 —— 会在 IM 推送标题行里换行把时间挤下去"],
    ["123456789012", "★ 纯数字 —— 列表显示成「<alias> · <账号号>」，两串数字并排"],
    ["7", "纯数字（短的也一样）"],
  ];
  for (const [v, why] of bad) {
    const { threw, writes } = await callAlias(v);
    ok(`★★★ 拒：${why}`, threw !== null && writes.length === 0);
    if (threw) {
      ok(`★★ 上一条的错误信息说清了「为什么」（${v.slice(0, 6)}…）`,
        threw.message.length > 30 && threw.code === "bad_request");
    } else {
      ok(`★★ 上一条的错误信息说清了「为什么」（${v.slice(0, 6)}…）`, false);
    }
  }
}
{
  const good = [
    ["a".repeat(64), "刚好 64 个 —— 边界不能一起拒掉"],
    ["prod-1", "带数字但不是纯数字"],
    ["生产 游戏1", "中文 + 空格"],
    ["  两头有空格  ", "trim"],
  ];
  for (const [v, why] of good) {
    const { r, threw } = await callAlias(v);
    ok(`★★★ 放行：${why}`, threw === null && r !== null);
  }
}
{
  // 🔴 换行与控制字符必须清掉，不能只 trim 两头。这个值会被拼进 IM 推送的
  //    标题行，而飞书的卡片标题字段**只渲染第一行** —— 一个粘进去的换行会让
  //    推送标题变成半截账号名，且没有任何报错。
  const { r } = await callAlias("prod\n\tdb");
  ok("★★★ 换行/制表符被清掉（飞书卡片标题只渲染第一行 → 半截账号名，无报错）",
    r && !/[\n\t]/.test(r.alias));
  ok("★★ 归一成单个空格而不是直接拼起来（`prod\\t\\ndb` → `prod db`）",
    r?.alias === "prod db");
}
{
  /**
   * 🔴 **非空白**控制字符要单独喂一遍。
   *
   *    产品代码是两步：`replace(/[\u0000-\u001f\u007f]/g, " ")` 再
   *    `replace(/\s+/g, " ")`。而 `\n` / `\t` **两步都能清**（它们属于 `\s`）
   *    —— 也就是说上面那条断言碰不到第一步独有的部分。
   *
   *    2026-08-31 实测：把第一个字符类改成只剩空格（`/[\u0020]/g`），
   *    上面那条照样绿。第一步真正独有的是 `\s` 覆盖不到的那些：
   *    `\u0000`-`\u0008`、`\u000b`、`\u000e`-`\u001f`、`\u007f`。
   *
   *    这些字符进了 DDB 是合法的（DynamoDB 的 String 是 UTF-8，不禁控制字符），
   *    然后被原样拼进飞书 / Slack 的 JSON payload —— `\u0000` 会让某些
   *    HTTP 客户端直接截断字符串，`\u007f` 在终端和部分 IM 客户端里不可见。
   *    表现是账号名莫名少了几个字，或者整条推送发不出去而只有一条 4xx。
   */
  const { r } = await callAlias("pro\u0007d\u007fb");
  ok("★★★ 非空白控制字符（BEL / DEL）也被清掉 —— `\\s` 覆盖不到它们，"
    + "而它们能进 DDB、然后被原样拼进 IM 的 JSON payload",
    r && !/[\u0000-\u001f\u007f]/.test(r.alias));
  ok("★★ 清成空格并归一（`pro\\u0007d\\u007fb` → `pro d b`）",
    r?.alias === "pro d b");
}
{
  const { r } = await callAlias(undefined);
  ok('★★ alias 为 undefined（请求体没这个键）→ 落成空串，不是字符串 "undefined"',
    r?.alias === "");
}
{
  const orig = lib.DynamoDBDocumentClient.prototype.send;
  lib.DynamoDBDocumentClient.prototype.send = async () => ({ Item: { enabled: true } });
  try {
    let threw = null;
    try { await member.setAccountAlias("67727609931", "x"); }
    catch (e) { threw = e; }
    ok("★★★ 非 12 位账号号要拒（11 位）",
      threw && /invalid_account_id/.test(threw.message));
  } finally { lib.DynamoDBDocumentClient.prototype.send = orig; }
}

/* ── mk() 的取名优先级 ───────────────────────────────────────────────────── */
{
  const mkStart = memberSrc.indexOf("const mk = (id, cfg, name");
  const mkBody = memberSrc.slice(mkStart, mkStart + 2600);
  const mkCode = strip(mkBody);
  ok("★★★ mk() 里人手填的 alias 优先（alias_source === \"manual\"）",
    /cfg\.alias_source === "manual" && cfg\.account_name\)\s*\n?\s*\|\| name/
      .test(mkCode));
  // 🔴 否定式：不能简单地把 cfg.account_name 提到 name 前面。
  //    `account_name` 有两个来源（人手填的、接入那刻从 DescribeAccount 复制的
  //    快照）。无条件让它赢 → org 改名后列表永远显示旧名字，而客户在 AWS
  //    控制台看到的是新名字，两边对不上且没有任何线索。
  ok("★★★ **没有**无条件让 cfg.account_name 压过 org 的实时 name",
    !/name:\s*\(cfg && cfg\.account_name\)\s*\|\| name/.test(mkCode));
  ok("★★ 把 aliasManual 透给前端（「自定义名」徽章 + 改名输入框的预填判据靠它）",
    /aliasManual: !!\(cfg && cfg\.alias_source === "manual"/.test(mkCode));
}

/* ── 路由 ──────────────────────────────────────────────────────────────── */
{
  const idxCode = strip(idxSrc);
  ok("★★★ 有 PUT /admin/member-accounts/<12位>/alias 这条路由",
    /\/admin\\\/member-accounts\\\/\(\[0-9\]\{12\}\)\\\/alias\$/.test(idxCode));
  ok("★★★ 路由读的是 `authBody` 而不是裸 `body`。"
    + "regions 那条刚踩过：`body` 未声明 → ReferenceError → 500（不是 undefined，"
    + "`(body || {})` 防不住未声明的标识符）",
    /setAccountAlias\(\s*\n?\s*memberAliasMatch\[1\], \(authBody \|\| \{\}\)\.alias\)/
      .test(idxCode));
  // `nav:admin` 的 `PUT /admin/.+$` 覆盖它 —— 不用改 capabilities.json。
  ok("★★ 门禁沿用 nav:admin 的 /admin/.+ 通配（capabilities.json 无需改）",
    /"method": "PUT", "pattern": "\/admin\/\.\+\$"/.test(
      readFileSync(join(HERE, "..", "capabilities.json"), "utf8")));
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 「全部账号」批量触发 —— 真调
// ═══════════════════════════════════════════════════════════════════════════

const insp = await import("../inspection.mjs");

ok("★★★ 哨兵是 `*`，不是空串。空串在这个模块里**已经有含义**了"
  + "（resolveAccount 把它解析成部署账号）—— 复用它会让「跑部署账号」"
  + "变成「跑全部账号」，而那是花钱乘 N 且撤不回来的操作",
  insp.ALL_ACCOUNTS === "*");

/**
 * 真调 `triggerRun` 一次，录下发给 Lambda 的 payload。
 *
 * ⚠️ patch `LambdaClient.prototype.send`：`triggerRun` 是在函数体里
 *    `await import("@aws-sdk/client-lambda")` 的，所以 patch 原型有效。
 */
/**
 * @param body    额外的请求体字段（`accounts: [...]` 多选走这里）
 * @param visible 可见账号集合。**默认 `"*"`（admin）** —— `triggerRun` 现在
 *                「不给 visible 就拒」（2026-09-01 的越权门），所以每个调用点
 *                都必须显式给。给 `"*"` 让本组既有断言保持原语义。
 */
async function callTrigger(account, {
  members = [], self = "444455556666", body = {}, visible = "*",
} = {}) {
  const lam = await import("@aws-sdk/client-lambda");
  const acctMod = await import("../accounts.mjs");
  const origLam = lam.LambdaClient.prototype.send;
  const origList = acctMod.listAccounts;
  const origSelf = acctMod.selfAccountId;
  const sent = [];
  lam.LambdaClient.prototype.send = async function (cmd) {
    sent.push(JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8")));
    return {};
  };
  // ⚠️ ESM 的导出是只读绑定，改不了 —— 所以这里 patch DDB/STS 那一层，
  //    让真的 `listAccounts()` / `selfAccountId()` 跑通并返回我们要的数据。
  //    这样连「listAccounts 排除了部署账号所以要手动加回来」那一跳也一起验了。
  const ddbLib = await import("@aws-sdk/lib-dynamodb");
  const stsLib = await import("@aws-sdk/client-sts");
  const orgLib = await import("@aws-sdk/client-organizations");
  const origDdb = ddbLib.DynamoDBDocumentClient.prototype.send;
  const origSts = stsLib.STSClient.prototype.send;
  const origOrg = orgLib.OrganizationsClient.prototype.send;
  ddbLib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    const n = cmd?.constructor?.name || "";
    if (n === "QueryCommand") {
      return { Items: members.map((id) => ({
        account_id: id, GSI1SK: id, enabled: true, account_name: `n-${id}`,
      })) };
    }
    return {};
  };
  stsLib.STSClient.prototype.send = async () => ({ Account: self });
  // ⚠️ Organizations 一律失败 —— 测试不该打真网络，而 `listAccounts()` 对
  //    org 不可用是降级处理（保留 accountId 兜底）。
  orgLib.OrganizationsClient.prototype.send = async () => {
    throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
  };
  try {
    const r = await insp.triggerRun(
      account, { run_type: "high", ...body }, { actor: "t", visible });
    return { r, sent };
  } finally {
    lam.LambdaClient.prototype.send = origLam;
    ddbLib.DynamoDBDocumentClient.prototype.send = origDdb;
    stsLib.STSClient.prototype.send = origSts;
    orgLib.OrganizationsClient.prototype.send = origOrg;
    void origList; void origSelf;
  }
}

{
  const { r, sent } = await callTrigger("*",
    { members: ["111122223333", "012345678901"], self: "444455556666" });
  ok("★★★ `*` 展开成 部署账号 + 全部已启用成员账号（3 个）",
    r.ok === true && (r.account_ids || []).length === 3);
  ok("★★★ **部署账号在里面**。listAccounts() 刻意排除了它（选择器有内置项），"
    + "漏掉的表现是「全部账号」独独不跑系统账号本身，而那通常是资源最多的那个",
    (r.account_ids || []).includes("444455556666"));
  ok("★★★ 成员账号都在里面", (r.account_ids || []).includes("111122223333")
    && (r.account_ids || []).includes("012345678901"));
  ok("★★★ **一次** invoke 带全部账号，不是 N 次。循环 invoke 的坏处是部分成功："
    + "第 3 次抛 AccessDenied 时前两个已经在跑了，而这个函数只能返回一个结果"
    + " —— 只能谎报全失败（客户重试 → 花两倍的钱）或谎报全成功",
    sent.length === 1);
  ok("★★★ payload 里 account_ids 是**数组**（scheduler 那侧按它扇出："
    + "`[DueRun(rt, a, today) for a in account_ids]`）",
    Array.isArray(sent[0]?.manual_trigger?.account_ids)
    && sent[0].manual_trigger.account_ids.length === 3);
  ok("★★ 回传 all_accounts=true —— 前端据此跳过单账号轮询",
    r.all_accounts === true);
  ok("★★★ 批量时 account_id 是空串。给它一个值会让前端那套单账号轮询"
    + "（baseline / startedFor / polls[rt]）盯着其中一个账号，"
    + "它先完成就报「跑完了」，而另外 N-1 个还在跑",
    r.account_id === "");
}
{
  // 去重：部署账号被登记进成员表（历史数据）时不能扇出两次。
  const { r, sent } = await callTrigger("*",
    { members: ["444455556666", "111122223333"], self: "444455556666" });
  ok("★★★ 去重：部署账号也在成员表里时只出现一次（否则 scheduler 对同一账号"
    + "扇出两次）",
    (r.account_ids || []).length === 2
    && sent[0].manual_trigger.account_ids.length === 2);
}
{
  // 单账号那条主路径不能被改坏。
  const { r, sent } = await callTrigger("111122223333", { members: [] });
  ok("★★★ 反例：单账号照旧 —— account_id 仍是那个字符串"
    + "（前端轮询读它，改成数组会让主路径的进度条永远不完成）",
    r.account_id === "111122223333");
  ok("★★ 单账号时 all_accounts=false", r.all_accounts === false);
  ok("★★ 单账号时 payload 里就那一个",
    sent[0].manual_trigger.account_ids.length === 1
    && sent[0].manual_trigger.account_ids[0] === "111122223333");
}
{
  // 空 account 仍然解析成部署账号（既有语义，`resolveAccount` 的兜底）。
  const { r } = await callTrigger("", { members: ["111122223333"], self: "444455556666" });
  ok("★★★ 反例：空串仍是**部署账号**，不是「全部账号」。"
    + "这条兜底是「全新部署打开看板就是加载失败」那个修复的唯一依据",
    r.account_id === "444455556666" && r.all_accounts === false);
}
/**
 * 一个目标都解析不出来 → 明确报错，不能静默 invoke 一个空数组。
 *（scheduler 那侧 `if not accounts: raise FanoutError`，消息进 DLQ，
 *  而前端拿到 `accepted: true` 显示「已提交」。）
 *
 * 🔴 **必须在子进程里跑。** `accounts.mjs` 的 `selfAccountId()` 有模块级缓存
 *    `_selfId`，上面那几条已经把它填成 `444455556666` 了 —— 在同一个进程里
 *    再让 STS 返回空是无效的。
 *
 *    第一版我把这条放在这一节最前面（缓存还是冷的）就过了 ——
 *    那是一条**顺序依赖**的测试：谁把断言重排一下它就无声地变成
 *    「测了另一件事」。这个仓库上一轮刚踩过同款
 *    （`test_手动重跑单_region…` 只在别的测试跑过之后才绿）。
 */
{
  const { execFileSync } = await import("node:child_process");
  const script = `
    process.env.CONFIG_TABLE = "t";
    process.env.AWS_REGION = "ap-northeast-1";
    process.env.INSPECTION_SCHEDULER_FUNCTION = "f";
    const insp = await import(${JSON.stringify(join(HERE, "..", "inspection.mjs"))});
    const lam = await import("@aws-sdk/client-lambda");
    const ddbLib = await import("@aws-sdk/lib-dynamodb");
    const stsLib = await import("@aws-sdk/client-sts");
    let invokes = 0;
    lam.LambdaClient.prototype.send = async () => { invokes++; return {}; };
    // 成员表空 + STS 拿不到部署账号 ⇒ 一个目标都没有
    ddbLib.DynamoDBDocumentClient.prototype.send = async () => ({ Items: [] });
    stsLib.STSClient.prototype.send = async () => { throw new Error("no creds"); };
    const r = await insp.triggerRun(
      "*", { run_type: "high" }, { actor: "t", visible: "*" });
    console.log(JSON.stringify({ ok: r.ok, code: r.code, invokes }));
  `;
  let out = null;
  try {
    out = JSON.parse(execFileSync(
      process.execPath, ["--input-type=module", "-e", script],
      { cwd: join(HERE, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim().split("\n").pop());
  } catch (e) {
    console.log(`  (子进程失败: ${e?.stderr || e?.message || e})`);
  }
  ok("★★★ 一个目标都没解析出来 → 报错 account_required，而**不** invoke。"
    + "invoke 一个空数组的表现是 scheduler 抛 FanoutError 进 DLQ，"
    + "而前端拿到 accepted:true 显示「已提交」",
    out && out.ok === false && out.code === "account_required" && out.invokes === 0);
}

/* ══════════════════════════════════════════════════════════════════════════
   显式多选 `accounts: [...]`（2026-09-01）
   ────────────────────────────────────────────────────────────────────────
   看板的触发弹层从「选一个 / 全部账号 + 二次确认屏」换成单层多选。
   多选必须**一次请求带数组** —— 前端循环 N 次 POST 会产生部分成功，
   而界面只能报一个结果（谎报全失败 → 客户重试 → 前两个账号各跑两轮）。
   ══════════════════════════════════════════════════════════════════════════ */
{
  const { r, sent } = await callTrigger("", {
    self: "444455556666",
    body: { accounts: ["111122223333", "012345678901"] },
  });
  ok("★★★ accounts 数组 → 一次 invoke 带这两个账号",
    r.ok === true && sent.length === 1
    && sent[0].manual_trigger.account_ids.length === 2);
  ok("★★★ 多选时 account_id 是空串。给它一个值会让前端那套单账号轮询盯着"
    + "其中一个账号，它先完成就报「跑完了」，而另外 N-1 个还在跑",
    r.account_id === "");
  ok("★★ all_accounts=false —— 多选不是「全部账号」那条路（可见性口径不同）",
    r.all_accounts === false);
}
{
  // 空串 = 部署账号，与标量 `account` 同一套 resolveAccount 兜底。
  // 🔴 前端拿不到部署账号的 12 位 ID（总览跨账号取时后端回 account_id: null），
  //    所以数组里必须认这一档 —— 让 UI 去猜一个 ID，猜错就是对**另一个**
  //    账号跑一轮并计费。
  const { r, sent } = await callTrigger("", {
    self: "444455556666", body: { accounts: ["", "111122223333"] },
  });
  ok("★★★ accounts 里的空串解析成部署账号，且排第一",
    r.ok === true
    && sent[0].manual_trigger.account_ids[0] === "444455556666"
    && sent[0].manual_trigger.account_ids.length === 2);
}
{
  // 去重：部署账号同时以空串和真实 ID 出现（客户在弹层里两行都勾了）。
  const { r } = await callTrigger("", {
    self: "444455556666", body: { accounts: ["", "444455556666"] },
  });
  ok("★★★ 去重：空串与它自己的真实 ID 只扇出一次（否则同一账号跑两轮）",
    (r.account_ids || []).length === 1);
}
{
  const { r, sent } = await callTrigger("", {
    body: { accounts: ["not-an-account"] },
  });
  ok("★★ 形状校验：非 12 位数字被拒，且**不** invoke",
    r.ok === false && r.code === "bad_account" && sent.length === 0);
}
{
  const { r, sent } = await callTrigger("", { body: { accounts: [] } });
  ok("★★ 空数组被拒（不能静默 invoke 一个空扇出）",
    r.ok === false && r.code === "account_required" && sent.length === 0);
}
/* ── 🔴 越权门：这条路以前不存在，而「批量」曾经比「单个」权限更大 ─────── */
{
  const { r, sent } = await callTrigger("", {
    body: { accounts: ["111122223333", "012345678901"] },
    visible: new Set(["111122223333"]),
  });
  ok("★★★ accounts 里有不可见的账号 → 拒，且**不** invoke。"
    + "数组不在路由层门禁认的四个键名里（那四个都是标量），"
    + "不管的话它自然放行 —— 而这个端点会真调 GetMetricData 并派 DA 判读",
    r.ok === false && r.code === "account_forbidden" && sent.length === 0);
}
{
  const { r } = await callTrigger("", {
    body: { accounts: ["111122223333"] },
    visible: new Set(["111122223333"]),
  });
  ok("★★ 反面：可见的账号照常放行（不是一律拒）", r.ok === true);
}
{
  // 🔴 既有越权：`"*"` 走 allTriggerTargets()，它读**全组织**的成员账号表，
  //    而 `"*"` 不是 12 位数字 → 路由层门禁认不出 → 只被允许看账号 A 的人
  //    能对所有账号各跑一轮 refetch，而他直传账号 B 是会被 403 的。
  const { r } = await callTrigger("*", {
    members: ["111122223333", "012345678901"], self: "444455556666",
    visible: new Set(["111122223333"]),
  });
  ok("★★★ `\"*\"` 与可见集合**取交集**，不是展开全组织",
    r.ok === true && (r.account_ids || []).join() === "111122223333");
}
{
  const { r, sent } = await callTrigger("*", {
    members: ["012345678901"], self: "444455556666",
    visible: new Set(["999999999999"]),
  });
  ok("★★ `\"*\"` 交集为空 → 拒，不 invoke",
    r.ok === false && r.code === "account_forbidden" && sent.length === 0);
}
{
  const { r, sent } = await callTrigger("111122223333", {
    visible: new Set(["012345678901"]),
  });
  ok("★★★ 标量 account 也过同一道门（纵深防御：路由层漏配时数据层还挡着）",
    r.ok === false && r.code === "account_forbidden" && sent.length === 0);
}
{
  const { r, sent } = await callTrigger("111122223333", { visible: null });
  ok("★★★ 不给 visible 就**拒**（不给就放行 = 忘记接线时静默越权）",
    r.ok === false && r.code === "visibility_required" && sent.length === 0);
}
{
  // 空串 = 部署账号，**不过**可见性门禁 —— 与标量那条路一致（门禁那侧
  // `requestedAccount` 为空时直接跳过）。把系统自己挡在外面会让受限用户
  // 连自己的看板都刷不了。
  const { r } = await callTrigger("", {
    self: "444455556666", body: { accounts: [""] },
    visible: new Set(["111122223333"]),
  });
  ok("★★★ 部署账号（空串）不受可见性限制 —— 与标量 account:\"\" 同口径",
    r.ok === true && (r.account_ids || []).join() === "444455556666");
}
/* ── 路由层：数组要被门禁看见（纵深防御的第一层）─────────────────────── */
{
  // ⚠️ `idxCode` 是上面那个块的块级常量，这里重新取一次（别指望它跨块可见 ——
  //    实测就是这么红的）。
  const s = strip(idxSrc);
  // ⚠️ 正则**锚到行首的 `if (`**，不是「文件里出现过这个表达式」。
  //    反向注入实测：`if (false && Array.isArray(...))` 会让宽匹配照过 ——
  //    标识符还在文件里，只是不起作用了。这是本仓库反复踩到的那一类。
  ok("★★★ 门禁认 `body.accounts`（数组是第五种形状，前四个键名都是标量）",
    /\n\s*if \(Array\.isArray\(authBody && authBody\.accounts\)\) \{/.test(s));
  ok("★★★ 逐个查可见性并 403（只查第一个等于给后面的留门）",
    /for \(const a of authBody\.accounts\)[\s\S]{0,240}account_forbidden/.test(s));
  ok("★★★ `/inspection/run` 路由把 visible 传下去（数据层「不给就拒」）",
    /triggerInspectionRun\([\s\S]{0,160}visible: vis/.test(s));
}

/* ── 源码级：展开的来源必须与页面上的选择器同源 ─────────────────────────── */
{
  const fn = bodyOf(inspSrc, "allTriggerTargets");
  ok("★★ allTriggerTargets 存在且导出", fn.length > 0);
  ok("★★★ 展开用 listAccounts()（与账号选择器**同一个来源**）。用别的来源"
    + "（比如 da#accounts）的表现是「弹层写着 5 个账号，实际跑了 7 个」，"
    + "多出来的两个客户在界面上完全看不到而钱是真花的",
    /listAccounts/.test(fn));
  ok("★★★ 拿不到部署账号 ID 时**不**塞空串（scheduler 会拿它建 run 行，"
    + "落成一条 account 为空的记录）",
    /if \(self\) out\.push\(self\)/.test(strip(fn)));
  ok("★★ 去重", /new Set\(out\)/.test(fn));
}

const total = pass + fail;
if (total !== EXPECTED_TOTAL) {
  console.log(
    `\n  FAIL 断言总数 ${total} != 预期 ${EXPECTED_TOTAL} —— `
    + "要么少跑了（顶层异常把进程带走过），要么加了断言没改 EXPECTED_TOTAL。");
  fail++;
}

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
