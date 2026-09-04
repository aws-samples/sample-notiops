/**
 * 手动接入流程的**闭环**断言（源码级）。
 * 运行：node bff/web-chat/tests/manual_onboard_flow.test.mjs
 *
 * ## 守的场景（2026-08-25）
 *
 * partner-resold 客户：手里没有 payer 账号，系统部署在某个 linked account 上，
 * 要把**同组织的另一个 linked account** 加进来。
 *
 * ```
 * organizations:ListAccounts   AccessDenied（不是管理账号）
 * CloudFormation StackSets     不可用（同上）
 * 跨 payer / 手动接入那条路     ✓ 六个函数一个都不碰 Organizations API
 * ```
 *
 * 这条路上曾有**三个断点**，每一个都让流程「看起来成功但配不下去」：
 *
 * ```
 * ① listMemberAccounts 第一行 stackSetName() 抛 org_mode_disabled
 *    → 前端整页 early return，连手动接入的入口都看不到
 * ② 同函数后面 paginateListAccounts(org) 无权 → 整个列表拿不到
 * ③ manualPayloadSave 只写 da# 记录，而降级列表读的是 account#
 *    → 账号存进去了却不出现在列表里，而巡检前置区块挂在列表行上
 * ```
 */
// 🔴 **必须在任何 `await import("../member_accounts.mjs")` 之前设。**
//    那个模块顶部有 `const BUCKET = process.env.SKILLS_BUCKET ||
//    process.env.DATA_BUCKET || ""`（:779）与另外五个模块级 env 常量 ——
//    模块加载之后再设环境变量对它们**完全无效**（ESM 的 const 只求值一次）。
//    2026-08-30 踩过：串联测试报 `DATA_BUCKET not configured`。
process.env.DATA_BUCKET = process.env.DATA_BUCKET || "notiops-test-bucket";
process.env.INSPECT_AGENT_SPACE_ID =
  process.env.INSPECT_AGENT_SPACE_ID || "cccccccc-1111-2222-3333-444444444444";
// 🔴 **无条件覆盖**，不是 `||`。下面「默认 region 是部署 region」那条断言
//    此前用 `process.env.AWS_REGION || "us-east-1"` 算期望值 —— 与产品代码
//    **同一个表达式**，也就是重言式。而开发机上 `AWS_REGION=us-east-1` 很常见
//    （AWS 自己的默认），那时把产品代码改成硬写 `["us-east-1"]` 照样 90 ok 全绿。
//    2026-08-30 审查实测：`unset AWS_REGION` 再跑那条才红。
process.env.AWS_REGION = "ap-northeast-1";
// 部署账号：不设的话 `generateLaunchStackUrl` 会去调 STS GetCallerIdentity（真网络）。
process.env.DEPLOY_ACCOUNT_ID = process.env.DEPLOY_ACCOUNT_ID || "111122223333";
// 模板从**仓库里的真文件**读（不设的话会去 process.cwd()/infra 找，
// 而测试的 cwd 是 bff/web-chat）。走真文件也顺手验了「模板存在且可读」。
process.env.DA_TEMPLATE_PATH = process.env.DA_TEMPLATE_PATH
  || new URL("../../../infra/member-devops-agent.yaml", import.meta.url).pathname;
// ⚠️ 假静态凭证：`getSignedUrl` 要签名（本地计算，不打网络），
//    不给的话它会去解析开发机的真凭证 —— 测试不该依赖那个。
process.env.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || "AKIATEST";
process.env.AWS_SECRET_ACCESS_KEY =
  process.env.AWS_SECRET_ACCESS_KEY || "test-secret";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "..", "member_accounts.mjs"), "utf8");
const idx = readFileSync(join(HERE, "..", "index.mjs"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  // ⚠️ `cond` 也接受 thunk：写成 `ok(name, () => expr)` 时 expr 抛异常不会
  //    把整个进程带走，而是记一条 FAIL。裸值形式仍然支持（大量既有调用）。
  let v;
  try { v = typeof cond === "function" ? cond() : cond; }
  catch (e) { fail++; console.log(`  FAIL ${name}  (threw: ${e?.message || e})`); return; }
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/**
 * **总数守卫。**
 *
 * ⚠️ 先说它**不**管什么：顶层未捕获异常会让 node 当场退出，这一行根本执行不到。
 * 但那种情形**不是静默的** —— 实测 exit=1，而 `package.json` 的 test 脚本用
 * `&&` 串联，会当场停在这个文件上。所以「崩了」是看得见的
 * （今晚现场发生过一次：新加的 UUID 校验让一条旧 fixture 抛异常）。
 *
 * 它管的是另一类：断言被 `if` / `try` 跳过、或者被谁删掉 ——
 * 那些情形下 `PASSED: n ok, 0 failed` 照样打印，条数变少没人会注意。
 *
 * ⇒ 数字变了就来改这里。这一步是**刻意的摩擦**：它让「我加了断言」和
 *   「我把断言跑掉了」不再长得一样。
 *
 * ⚠️ 它管不了**第三类**：如果谁在这道守卫**之前** `process.exit(0)`，
 *    整个脚本 rc=0 且 `PASSED:` 行压根不打印，`npm test` 的 `&&` 会继续
 *    往下跑并退 0 —— 完全静默。2026-08-30 审查实测确认。
 *    ⇒ `package.json` 的 test 脚本给这一条接了
 *      `| tee /dev/stderr | grep -q ', 0 failed'`：
 *      那行没打印出来 ⇒ grep 不匹配 ⇒ 整条命令 rc=1。
 *      （grep 里刻意**不**写条数 —— 条数只在这个文件里有一处，
 *        否则加一条断言要改两个文件。）
 */
const EXPECTED_TOTAL = 104;

/** 剥掉行注释，专给「不该出现某个字符串」这类**否定式**断言用。
 *
 * 🔴 这个项目在同一批工作里踩了**六次**「断言命中自己解释判据的注释」：
 *    org 回填、setup.sh、`da = da_target`、`org_onboard_status`、
 *    `PrincipalOrgID`、`needsStackUpdate`。
 *    肯定式断言用原文（注释里出现也算写对了意图）；否定式必须用这个。
 *
 * ⚠️ 只剥 `//` 行注释，不剥块注释与字符串。`test_devops_bus_policy.py` 那侧
 *    还踩过一次「先剥注释再剥字符串」的顺序问题（URL 里的 `//`）——
 *    这里不剥字符串，所以不会有那个问题。
 */
const stripComments = (code) => code.split("\n")
  .map((ln) => ln.replace(/\/\/.*$/, "")).join("\n");

const listFn = src.slice(src.indexOf("export async function listMemberAccounts"));
const listBody = listFn.slice(0, listFn.indexOf("\n}\n"));
/** 同一段，**剥掉注释**。下面的否定式断言（`!/.../`）一律用这个。
 *
 * 🔴 2026-08-30 审查实测的误报：在 `listMemberAccounts` 里加一句完全无害的
 *    注释 `// ⚠️ 这里刻意不调 stackSetName() —— 非 org 部署会抛。`
 *    → `PASSED: 93 ok, 1 failed`。
 *    而「刻意不 X，理由是…」正是这个代码库到处都在写的形态，撞上只是时间问题。
 *
 * ⚠️ 肯定式断言（`/.../`）继续用 `listBody` —— 注释里出现也算写对了意图。
 */
const listCode = stripComments(listBody);

/* ── ① 列表不再靠抛错传递「org 模式没开」 ── */
ok("listMemberAccounts 不再调 stackSetName()（那会整页挡掉手动接入）",
  !/stackSetName\(\)/.test(listCode));
ok("一键接入可不可用改成独立导出的判据",
  /export function oneClickOnboardAvailable/.test(src));

/* ── ② ListAccounts 无权时降级，而不是抛 ── */
ok("ListAccounts 包在 try 里",
  /try \{[\s\S]{0,400}paginateListAccounts/.test(listBody));
ok("降级时改列 DDB 已登记的账号",
  /orgListable = false;[\s\S]{0,400}Object\.entries\(onboarded\)/.test(listBody));
ok("降级**不静默** —— 返回 orgListable 标记",
  /return \{ items, orgListable \}/.test(listBody));
// 🔴 标记不能挂在数组上：JSON.stringify 会静默丢掉数组的自有属性
ok("标记走对象而不是挂数组属性",
  !/items\.orgListable = /.test(listCode));
ok("路由把两个标记都透出去",
  /orgListable: r\.orgListable !== false/.test(idx)
  && /oneClickOnboard: oneClickOnboardAvailable\(\)/.test(idx));

/* ── ③ 手动接入要让账号出现在列表里 ── */
const saveFn = src.slice(src.indexOf("export async function manualPayloadSave"));
const saveBody = saveFn.slice(0, saveFn.indexOf("\n}\n"));
ok("manualPayloadSave 写 da# 记录（DA 关联）",
  /PK: `da#\$\{id\}`/.test(saveBody));
ok("manualPayloadSave **也**写 account# 记录（否则降级列表里看不到）",
  /PK: `account#\$\{id\}`/.test(saveBody));
ok('account# 记录带 GSI1PK="accounts"（列表按它查）',
  /":g1": "accounts"/.test(saveBody));
// ⚠️ 采集角色必须经真 AssumeRole 验证才登记 —— 这里顺手填会让管理页
//    显示「已登记」而实际 assume 不进去。
//    🔴 判据只看 **account# 那一段**：同一个函数里 `trigger_role_arn = :tra`
//       是 DA 的触发角色（该写），不是巡检的采集角色。
const acctSeg = saveBody.slice(saveBody.indexOf("PK: `account#"));
ok("account# 记录里**不**写 role_arn（要经真 AssumeRole 验证才登记）",
  !/\brole_arn\b/.test(acctSeg));
// 这条路没有 StackSet operation 可轮询，留 PROVISIONING 会被自愈逻辑判 FAILED
ok("org_onboard_status 直接置 ACTIVE（没有 operation 可轮询）",
  /":st": "ACTIVE"/.test(saveBody));

/* ── ④ 跨 payer 那六个函数不许引入 Organizations 依赖 ── */
for (const fn of ["generateLaunchStackUrl", "generateCollectionStackUrl",
                  "manualPayloadSave", "inspectionCrossAccountStatus",
                  "verifyAndRegisterCollectionRole"]) {
  const f = src.slice(src.indexOf(`export async function ${fn}`));
  const body = f.slice(0, f.indexOf("\n}\n"));
  const code = body.split("\n").filter((l) => !l.trim().startsWith("//")
    && !l.trim().startsWith("*")).join("\n");
  ok(`${fn} 不依赖 Organizations API`,
    !/org\.send|paginateListAccounts|stackSetName\(|rootId\(/.test(code));
}


/* ── 下线不许硬依赖 org 模式（2026-08-26 线上实测的死路）── */

/* 🔴 `offboardAccount` 第一行原来是 `const ss = stackSetName();`，而
 *    `stackSetName()` 在 `MEMBER_ONBOARDING_STACKSET_NAME` 为空时**抛**
 *    `org_mode_disabled`。于是非 org 部署下点「下线」：
 *
 *    · 后面清 DDB 登记的代码**一行都没跑到**
 *    · 客户只看到一个 `org_mode_disabled`，账号原样留在列表里
 *    · 而这个部署里压根没有 StackSet 可删 —— 报错本身也毫无意义
 *
 *    同一形态在 `listMemberAccounts` 上踩过一次（第一行 `stackSetName()`
 *    让整个账号页 early return）。这是第二次，所以钉住。 */
{
  const fn = src.slice(src.indexOf("export async function offboardAccount"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  ok("offboardAccount 里的 stackSetName() 被 try 包住（不抛穿）",
    /try \{ ss = stackSetName\(\); \} catch/.test(body));
  ok("没有 StackSet 时跳过 DeleteStackInstances 而不是照打",
    /if \(!ss\) throw/.test(body));
  ok("返回值带 stackRetained（告诉 UI 成员账号那个栈没被删）",
    /stackRetained: true/.test(body));
  ok("返回值带要客户自己删的栈名",
    /stackName: `notiops-devops-agent-\$\{id\}`/.test(body));
}

/* ── association 的账号 ID 必须认 sourceAws ── */

/* 🔴 控制台「添加辅助云来源」建的是 `configuration.sourceAws`（accountType
 *    = source），而 `configuration.aws`（monitor）是 space **自己那个账号**。
 *    原来只读后者 —— 于是客户照向导做完了，管理页照样显示「未关联（判读会
 *    降级）」，他会以为白做了一遍，然后再做一遍（第二次会撞 already exists）。 */
ok("associationAccountId 先读 sourceAws.accountId",
  /sourceAws\?\.accountId[\s\S]{0,80}configuration\?\.aws\?\.accountId/
    .test(src));
ok("状态里带出 association 的 status（invalid ≠ 未关联）",
  /monitorStatus = String\(hit\?\.status \|\| ""\)/.test(src));

/* ── 一键关联：三条实测语义都要落到代码里 ── */
{
  const fn = src.slice(src.indexOf("export async function associateInspectionSource"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  // ① 用 sourceAws/source，不是 aws/monitor —— 后者会顶掉部署账号自己那条
  ok("关联用 sourceAws / accountType=source", /accountType: "source"/.test(body));
  ok("**不**用 aws/monitor（那是 space 自己那个账号，会顶掉它）",
    !/accountType: "monitor"/.test(body));
  // ② 不幂等：同账号再关联一次抛 ValidationException "already exists"
  ok("「已存在」当成功处理（客户可能自己在控制台做过 / 按钮点两下）",
    /already exists/i.test(body));
  // ③ 角色缺失时状态是 pending-confirmation，validate 一次才变 invalid
  ok("跟一次 ValidateAwsAssociations 把状态落实",
    /ValidateAwsAssociationsCommand/.test(body));
  ok("把最终 status 带回前端（不是只报调用成功）",
    /status = String\(hit\?\.status \|\| ""\)/.test(body));
  // 角色 ARN 推导，不让客户手贴
  ok("角色 ARN 由代码推导（与模板 RoleName 对齐）",
    /inspectionMonitorRoleArn\(id, sysAcct\)/.test(body));
}

/* ── 手动接入的账号要能在列表里被认出来 ── */
ok("listMemberAccounts 带出 onboardSource（下线回收范围按它分岔）",
  /onboardSource: \(cfg && cfg\.onboard_source\) \|\| ""/.test(src));

/* ── 保存并激活顺带把采集角色验掉 ── */
{
  const fn = src.slice(src.indexOf("export async function manualPayloadSave"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  ok("保存成功后自动验证并登记采集角色", /verifyAndRegisterCollectionRole\(id\)/.test(body));
  ok("验证失败**不**阻断保存（老模板 / 选了 no / IAM 还没传播都是正常态）",
    /catch \(e\) \{\n    collection = \{ ok: false/.test(body));
}

/* ── Launch Stack 链接预填巡检参数 ── */
ok("预填 CreateCollectionRole=yes（手动接入必须建采集角色）",
  /param_CreateCollectionRole=yes/.test(src));
ok("预填巡检 space 的**完整 ARN**（不是 id —— 模板拼 region 会拼错）",
  /param_InspectionAgentSpaceArn=\$\{encodeURIComponent\(inspectArn\)\}/.test(src));
ok("ARN 用 BFF 所在 region 拼（= 系统账号 space 所在 region）",
  /arn:aws:aidevops:\$\{region\}:\$\{sysAcct\}:agentspace\/\$\{INSPECT_SPACE_ID\}/
    .test(src));

/* ── 采集 Region 的编辑（2026-08-27）──
 *
 * 🔴 这一组守三件事：
 *    ① **不能**拿 onboardAccount 当编辑用（那个会 CreateStackInstances 重新
 *       下发两个 StackSet，几分钟、会动成员账号里的资源）
 *    ② 打错形状的 region 要**拒**而不是静默过滤 —— 静默过滤会让客户以为存
 *       进去了，而运行时的表现是「那个区一直没被采」，与「打错了」看不出区别
 *    ③ 空 regions 读出来要有默认值（老采集链路对空列表是「一个都不采」）
 */
{
  const body = src.slice(src.indexOf("export async function setAccountRegions"));
  const fn = body.slice(0, body.indexOf("\n}\n"));

  ok("setAccountRegions 存在（编辑走独立函数，不复用 onboardAccount）",
    fn.length > 0);
  ok("★★ **不**调 StackSet —— 编辑 region 不该重新下发资源",
    !/CreateStackInstances|stackSetName\(/.test(fn));
  // ⚠️ 只钉「写的字段只有 regions」，不钉那个变量叫什么 —— 变量名从
  //    `list` 变成 `norm`（`*` 归一）时这条断言红过一次，而它想保证的
  //    事情完全没变。
  ok("★★ 走 putConfigAccount 只写 regions 一个字段",
    /putConfigAccount\(id, \{ regions: \w+ \}\)/.test(fn));
  ok("★★ 非法 region **抛**而不是过滤掉",
    /invalid_region/.test(fn) && /REGION_RE\.test/.test(fn));
  ok("★★ 空列表也拒（老链路里空 = 一个都不采）",
    /regions_required/.test(fn));
  ok("★ 去重 + 小写归一（客户会填 US-EAST-1 或重复项）",
    /new Set\(/.test(fn) && /toLowerCase\(\)/.test(fn));

  ok("★★ listMemberAccounts 对空 regions 给读时默认，而不是回空数组",
    /cfg\.regions && cfg\.regions\.length/.test(src)
    && /DEFAULT_COLLECT_REGIONS/.test(src));
  ok("★ 默认值就是 us-east-1",
    /DEFAULT_COLLECT_REGIONS = \["us-east-1"\]/.test(src));

  // 路由必须挂上，否则前端调了 404 —— 而 404 在 UI 上只显示 http_404
  const idx = readFileSync(join(HERE, "..", "index.mjs"), "utf8");
  ok("★★ PUT /admin/member-accounts/<12位>/regions 路由已挂",
    /member-accounts\\\/\(\[0-9\]\{12\}\)\\\/regions/.test(idx)
    && /setAccountRegions\(/.test(idx));
  ok("★★ 那条路由是 PUT，且**不**落到 onboard 那条 POST 上",
    /method === "PUT" && memberRegionsMatch/.test(idx));
}

/* ── 真的**调用** setAccountRegions（不是查源码）──
 *
 * 🔴 上面那 12 条全是源码文本断言。2026-08-27 的交叉 review 抓到的 P0
 *    （`keys.run_sk` 调了一个不存在的函数）就是这么漏过去的：3235 条测试全绿，
 *    因为没有一条真的执行那段代码。所以这里真跑一遍。
 *
 * ⚠️ DDB 用假实现。校验与归一化是纯逻辑，不需要真表。
 */
{
  process.env.CONFIG_TABLE = process.env.CONFIG_TABLE || "t";
  process.env.AWS_REGION = "ap-northeast-1";   // 与文件头一致，见那里的说明

  const writes = [];
  const { mockClient } = await import("aws-sdk-client-mock").catch(() => ({}));

  // 没有 aws-sdk-client-mock 就用最小猴补：直接替掉模块里的 ddb.send。
  const mod = await import("../member_accounts.mjs");
  const ddbInternal = await import("@aws-sdk/lib-dynamodb");
  const origSend = ddbInternal.DynamoDBDocumentClient.prototype.send;
  ddbInternal.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    const name = cmd?.constructor?.name || "";
    if (name === "GetCommand") {
      // 账号已登记
      return { Item: { PK: `account#${cmd.input.Key.PK.split("#")[1]}`, enabled: true } };
    }
    if (name === "UpdateCommand") { writes.push(cmd.input); return {}; }
    return {};
  };

  try {
    // ① 正常：去重 + 小写归一 + 只写 regions
    writes.length = 0;
    const r = await mod.setAccountRegions("444455556666",
      ["US-EAST-1", "us-east-2", "us-east-1", "  ap-northeast-1 "]);
    ok("★★★ 真调通了，且去重+归一（US-EAST-1 与 us-east-1 算一个）",
      JSON.stringify(r.regions) ===
        JSON.stringify(["us-east-1", "us-east-2", "ap-northeast-1"]));
    ok("★★ 只写了一次 UpdateCommand，且值就是归一后的列表",
      writes.length === 1
      && JSON.stringify(Object.values(writes[0].ExpressionAttributeValues)
           .find((v) => Array.isArray(v)))
         === JSON.stringify(["us-east-1", "us-east-2", "ap-northeast-1"]));

    // ② 打错形状 → 抛，且错误里点名是哪个
    let caught = "";
    try { await mod.setAccountRegions("444455556666", ["us-east1"]); }
    catch (e) { caught = String(e.message || e); }
    ok("★★★ `us-east1` 被拒（不是静默过滤），且错误里点名了它",
      /invalid_region/.test(caught) && /us-east1/.test(caught));

    // ③ 空列表 → 抛
    caught = "";
    try { await mod.setAccountRegions("444455556666", []); }
    catch (e) { caught = String(e.message || e); }
    ok("★★ 空列表被拒", /regions_required/.test(caught));

    // ④ 账号 ID 形状
    caught = "";
    try { await mod.setAccountRegions("69836193585", ["us-east-1"]); }
    catch (e) { caught = String(e.message || e); }
    ok("★ 11 位账号 ID 被拒", /invalid_account_id/.test(caught));

    // ⑤ `*` 是合法输入 —— 它不是 region 名，不能进形状校验（2026-08-29）
    //    🔴 拒掉它的话「怎么让巡检扫全部 region」在界面上无路可走：
    //       读侧 `scan_region_scope` 认的就是这一个哨兵。
    writes.length = 0;
    const all = await mod.setAccountRegions("444455556666", ["*"]);
    ok("★★★ `*` 被接受（= 巡检扫全部 region）",
      JSON.stringify(all.regions) === JSON.stringify(["*"]));

    // ⑥ `*` 与具体 region 混填 → 归一成 ["*"]
    //    ⚠️ 留着 `["us-east-1","*"]` 不算错（读侧见 `*` 就返回「全部」），
    //       但库里那行会让下一个人以为是「取交集」。
    writes.length = 0;
    const mixed = await mod.setAccountRegions(
      "444455556666", ["us-east-1", "*", "us-west-2"]);
    ok("★★★ `us-east-1,*` 归一成 [\"*\"] 再落库（不留成看起来像交集的两个值）",
      JSON.stringify(mixed.regions) === JSON.stringify(["*"])
      && JSON.stringify(Object.values(writes[0].ExpressionAttributeValues)
           .find((v) => Array.isArray(v))) === JSON.stringify(["*"]));

    // ⑦ 错误提示必须把 `*` 这条路说出来 —— 客户填错时那句话是他唯一的线索
    caught = "";
    try { await mod.setAccountRegions("444455556666", ["all"]); }
    catch (e) { caught = String(e.message || e); }
    ok("★★ 拒绝非法值时提示里带上 `*` 这个选项", /\*/.test(caught));
  } finally {
    ddbInternal.DynamoDBDocumentClient.prototype.send = origSend;
    void mockClient;
  }
}

/* ── 启停开关必须同时动 da# 行（2026-08-29）──
 *
 * 🔴 巡检的账号扇出读的是 **da# 行**
 *    （`inspection/adapters/accounts.py::enabled_accounts` 查
 *     `GSI1PK = "da#accounts"` 再过 `_is_enabled`），
 *    而这个开关原来只写 `account#`。后果：客户点「停用」，界面显示已停用，
 *    而第二天照常巡检、照常付 GetMetricData、照常派 DA 判读。
 *    这个开关是「让某个账号别再被巡检」的唯一 UI 入口。
 */
{
  const body = src.slice(src.indexOf("export async function setAccountEnabled"));
  const fn = body.slice(0, body.indexOf("\n}\n"));

  ok("★★★ setAccountEnabled 同时更新 da# 行（否则对巡检不起作用）",
    /Key: \{ PK: `da#\$\{id\}`, SK: "meta" \}/.test(fn));
  ok("★★ 用条件写，**不建桩行**（只有 enabled 的 da# 行会被当成可巡检账号）",
    /ConditionExpression: "attribute_exists\(PK\)"/.test(fn));
  ok("★★ ConditionalCheckFailed 之外的异常要抛（不能把真错误吞成「行不存在」）",
    /e\?\.name !== "ConditionalCheckFailedException"\) throw e/.test(fn));
  ok("★ 回传 inspectionToggled —— UI 要能说清巡检那侧生效没有",
    /inspectionToggled: daUpdated/.test(fn));
  ok("★ account# 那半仍然写（凭证与列表显示靠它）",
    /putConfigAccount\(id, \{ enabled: !!enabled \}\)/.test(fn));
}

/* ── 真调一次：两行都写到了 ── */
{
  process.env.CONFIG_TABLE = process.env.CONFIG_TABLE || "t";
  const mod = await import("../member_accounts.mjs");
  const lib = await import("@aws-sdk/lib-dynamodb");
  const orig = lib.DynamoDBDocumentClient.prototype.send;
  const keys = [];
  lib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    const n = cmd?.constructor?.name || "";
    if (n === "GetCommand") return { Item: { enabled: true } };
    if (n === "UpdateCommand") { keys.push(cmd.input.Key.PK); return {}; }
    return {};
  };
  try {
    const r = await mod.setAccountEnabled("444455556666", false);
    ok("★★★ 真调：account# 与 da# **两行**都被写了",
      keys.includes("account#444455556666") && keys.includes("da#444455556666"));
    ok("★★ 真调：回传 inspectionToggled=true", r.inspectionToggled === true);
  } finally {
    lib.DynamoDBDocumentClient.prototype.send = orig;
  }
}

/* ── 巡检 space id 的写入面（改动①，2026-08-29）───────────────────────────
 *
 * 🔴 `da#<账号>.inspect_agent_space_id` 的**读取函数早就存在**
 *    （`inspection/adapters/accounts.py::inspect_space_id` / `inspect_space_ids`），
 *    缺的一直是写入面 —— 于是成员账号的它永远是空，callback 分流的集合里
 *    只有部署账号那一个，成员账号的判读全部被判成排障、静默丢掉。
 *
 * ⚠️ **两条接入路都要写**。只接手动那条的后果是「一键接入的账号巡检判读为空、
 *    手动接入的正常」—— 又一次按接入方式分裂的行为。
 */
{
  const saveSrc = src.slice(src.indexOf("export async function manualPayloadSave"));
  const saveBody = saveSrc.slice(0, saveSrc.indexOf("\n}\n"));
  ok("★★★ 手动回填接受 inspect_agent_space_id",
    /inspect_agent_space_id/.test(saveBody));
  ok("★★ 空值时**不写**那个字段（写进去与没有它同结果，但会让排查误导）",
    /inspectSpaceId \?/.test(saveBody));

  const orgSrc = src.slice(src.indexOf("export async function devopsAgentAssocStatus"));
  const orgBody = orgSrc.slice(0, orgSrc.indexOf("\n}\n"));
  ok("★★★ org 一键接入那条路**也**写它（不然按接入方式分裂）",
    /InspectionAgentSpaceId/.test(orgBody)
    && /inspect_agent_space_id/.test(orgBody));
  ok("★★ org 那条同样对空值不写",
    /inspectSpaceId \?/.test(orgBody));
}

/* ── 真调一次手动回填，确认字段真的进了 UpdateExpression ── */
{
  const mod = await import("../member_accounts.mjs");
  const lib = await import("@aws-sdk/lib-dynamodb");
  const orig = lib.DynamoDBDocumentClient.prototype.send;
  const writes = [];
  lib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    const name = cmd.constructor?.name || "";
    if (name === "GetCommand") return { Item: { PK: cmd.input.Key.PK } };
    if (name === "UpdateCommand") { writes.push(cmd.input); return {}; }
    return {};
  };
  try {
    writes.length = 0;
    // ⚠️ 值必须是合法 UUID —— 加了校验之后随便一个字符串会被拒
    //    （那正是 P0-3 的修复）。这里前后带空格是为了顺带验 trim。
    await mod.manualPayloadSave("444455556666", {
      agent_space_id: "aaaaaaaa-1111-2222-3333-444444444444",
      trigger_role_arn: "arn:aws:iam::444455556666:role/notiops-agent-trigger-x",
      inspect_agent_space_id: "  bbbbbbbb-1111-2222-3333-444444444444  ",
    });
    const daWrite = writes.find((w) => w.Key.PK === "da#444455556666");
    ok("★★★ 真调：给了值 → inspect_agent_space_id 进了 UpdateExpression（且 trim 过）",
      !!daWrite && /inspect_agent_space_id = :isi/.test(daWrite.UpdateExpression)
      && daWrite.ExpressionAttributeValues[":isi"]
         === "bbbbbbbb-1111-2222-3333-444444444444");

    writes.length = 0;
    await mod.manualPayloadSave("444455556666", {
      agent_space_id: "aaaaaaaa-1111-2222-3333-444444444444",
      trigger_role_arn: "arn:aws:iam::444455556666:role/notiops-agent-trigger-x",
    });
    const daWrite2 = writes.find((w) => w.Key.PK === "da#444455556666");
    ok("★★★ 真调：没给值 → **完全不出现**那个字段（不是写空串）",
      !!daWrite2 && !/inspect_agent_space_id/.test(daWrite2.UpdateExpression)
      && !(":isi" in daWrite2.ExpressionAttributeValues));
  } finally {
    lib.DynamoDBDocumentClient.prototype.send = orig;
  }
}

/* ── 存量账号的「待更新栈」信号 ──────────────────────────────────────────
 *
 * 🔴 上一版这一块是 **4 条对 `listBody` 的 regex**，而 `listBody` 是
 *    `src.slice(...)` —— **没剥注释**。2026-08-30 审查实测：把整段三项 AND
 *    判据挖成 `i.needsStackUpdate = false;`、**注释一字不动** → 4 条**全部**
 *    仍为 true。因为那段注释里逐字写着
 *      「agent_space_id 有 + inspect_agent_space_id 空」
 *      「⚠️ 只对 `onboarding_status === "active"` 的账号报」
 *    这是同一批工作里第**六**次「断言命中自己解释判据的注释」。
 *
 * ⇒ 改成真跑 `listMemberAccounts()` 断 6 行真值表。源码 regex 只留一条
 *   （`mk()` 的默认值），并且**剥注释**。
 *
 * 后果（那段注释自己写的）：管理页永不显示「待更新栈」→ 存量账号不知道要
 * 重新部署栈 → 采集照跑（`enabled_accounts` 读 da# 行，与这个字段无关）、
 * 花 GetMetricData、而判读永远为空。看板上「N 条未做根因分析」与
 * 「DA 说这些没问题」长得一样。
 */
{
  const listSrc = stripComments(src.slice(
    src.indexOf("export async function listMemberAccounts")));
  const listBody = listSrc.slice(0, listSrc.indexOf("\nexport "));
  ok("★ mk() 里给了 false 默认值（不留 undefined，前端 `?` 判不出来）",
    /needsStackUpdate: false/.test(listBody));

  const mod = await import("../member_accounts.mjs");
  const lib = await import("@aws-sdk/lib-dynamodb");
  const orgLib = await import("@aws-sdk/client-organizations");
  const stsLib = await import("@aws-sdk/client-sts");
  const origDdb = lib.DynamoDBDocumentClient.prototype.send;
  const origOrg = orgLib.OrganizationsClient.prototype.send;
  const origSts = stsLib.STSClient.prototype.send;

  // 六行真值表：`da#` 行的三个字段 × 「该不该报」
  const CASES = [
    ["222222222222", { onboarding_status: "active", agent_space_id: "s-rca" },
     true,  "active + 有排障 space + 没巡检 space ⇒ 正是要报的那种"],
    ["333333333333", { onboarding_status: "active", agent_space_id: "s-rca",
                       inspect_agent_space_id: "s-insp" },
     false, "两个 space 都有 ⇒ 已经是新模板，不报"],
    ["555555555555", { onboarding_status: "active" },
     false, "连排障 space 都没有 ⇒ 还在接入中，报了是噪音"],
    ["666666666666", { onboarding_status: "provisioning",
                       agent_space_id: "s-rca" },
     false, "provisioning ⇒ 第二步还在跑，本来就还没回填"],
    ["777777777777", { onboarding_status: "failed", agent_space_id: "s-rca" },
     false, "failed ⇒ 该显示的是 failed，不是「待更新栈」"],
    ["888888888888", { onboarding_status: "active", agent_space_id: "s-rca",
                       inspect_agent_space_id: "   " },
     true,  "巡检字段是纯空白 ⇒ 等于没回填（判据必须 trim）"],
  ];

  try {
    stsLib.STSClient.prototype.send = async function () {
      return { Account: "111122223333" };
    };
    orgLib.OrganizationsClient.prototype.send = async function () {
      return { Accounts: CASES.map(([id]) => ({
        Id: id, Status: "ACTIVE", Name: `acct-${id}`, Email: `${id}@x.test`,
      })).concat([
        // 未登记的账号：`items.filter(i => i.onboarded)` 会跳过它，
        // 所以它必须拿到 `mk()` 的默认 false（不是 undefined）。
        { Id: "999999999999", Status: "ACTIVE", Name: "never-onboarded",
          Email: "n@x.test" },
      ]) };
    };
    lib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
      const n = cmd.constructor?.name || "";
      if (n === "QueryCommand") {
        // `account#` 行：只有 CASES 里那 6 个算「已接入」
        return { Items: CASES.map(([id]) => ({
          account_id: id, enabled: true, onboarding_status: "active",
          regions: ["ap-northeast-1"],
        })) };
      }
      if (n === "GetCommand") {
        const pk = String(cmd.input.Key?.PK || "");
        const hit = CASES.find(([id]) => pk === `da#${id}`);
        return hit ? { Item: hit[1] } : {};
      }
      return {};
    };

    const { items } = await mod.listMemberAccounts();
    const by = Object.fromEntries(items.map((i) => [i.accountId, i]));

    for (const [id, , want, why] of CASES) {
      const got = by[id]?.needsStackUpdate;
      ok(`★★★ needsStackUpdate 真值表：${why}`, got === want);
    }
    ok("★★ 从未接入的账号拿到 false（不是 undefined —— 前端拿 undefined "
       + "判不出来，徽章会消失而不是不显示）",
      by["999999999999"]?.needsStackUpdate === false);

    /* ── 组织外的已登记账号必须也在列表里（2026-08-30 补）──────────────
     *
     * 🔴 上面那个 stub 让 ListAccounts **成功**（部署账号是 org 管理账号，
     *    最常见的形态）。此时 items 里只有 org 返回的账号 —— 而「跨 Payer
     *    接入」这个功能存在的全部理由就是接**别的 org / 独立**账号。
     *
     *    实例：111122223333 属于 o-aaaabbbbcc，部署账号 444455556666 属于
     *    o-ddddeeeeff。该成员账号手动接入成功、两行都写好、巡检也照常扇出它
     *    （enabled_accounts 读 da#accounts GSI，与 org 无关）—— 而管理页上
     *    它不存在。手动接入流程本身全绿、页面提示「已保存并激活」，
     *    所以运维看到成功、然后在列表里找不到它。
     *
     *    连带失去的全部挂在列表行上：「待更新栈」徽章、改采集 Region、
     *    启用/停用/下线、①采集角色「验证并登记」重试、数据可见性勾选。
     *    ⇒ regions 锁死在回填时写的部署 Region；客户资源不在那个区时
     *      expected=0 → completeness=1 → run success →「跑过了、没风险」。
     */
    // ⚠️ 这个子块把 selfId 改成 698 —— 与真实形态一致（部署账号 698 是
    //    o-ddddeeeeff 的管理账号，成员账号属于另一个 org o-aaaabbbbcc）。
    //    上面那个 stub 返回的是 677，而 677 正是我要当「组织外账号」的那个
    //    ⇒ 它会被 `if (a.Id === selfId) continue` 当成部署账号排除掉，
    //    三条断言全红。这是我第一版的 bug，记在这里免得后人再踩。
    const OUT = "111122223333";
    stsLib.STSClient.prototype.send = async function () {
      return { Account: "444455556666" };
    };
    lib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
      const n = cmd.constructor?.name || "";
      if (n === "QueryCommand") {
        return { Items: [
          // org 里的那个（ListAccounts 会返回它）
          { account_id: "222222222222", enabled: true,
            onboarding_status: "active", regions: ["ap-northeast-1"] },
          // 🔴 组织外那个 —— ListAccounts **不会**返回它
          { account_id: OUT, enabled: true, onboarding_status: "active",
            regions: ["ap-northeast-1"], onboard_source: "manual" },
        ] };
      }
      if (n === "GetCommand") {
        const pk = String(cmd.input.Key?.PK || "");
        if (pk === `da#${OUT}`) {
          return { Item: { onboarding_status: "active",
                           agent_space_id: "s-rca" } };   // 巡检字段空 → 该报
        }
        if (pk === "da#222222222222") {
          return { Item: { onboarding_status: "active", agent_space_id: "s-rca",
                           inspect_agent_space_id: "s-insp" } };
        }
        return {};
      }
      return {};
    };
    orgLib.OrganizationsClient.prototype.send = async function () {
      // 只返回 org 内的那一个 —— 677 不在
      return { Accounts: [{ Id: "222222222222", Status: "ACTIVE",
                            Name: "in-org", Email: "a@x.test" }] };
    };

    const r2 = await mod.listMemberAccounts();
    const ids = r2.items.map((i) => i.accountId);
    ok("★★★ 组织外的已登记账号出现在列表里（否则它永远不可运维）",
      ids.includes(OUT));
    const out = r2.items.find((i) => i.accountId === OUT);
    ok("★★★ 且带 outOfOrg 标记（前端据此说清「不在本组织」+ 不渲染一键接入）",
      out?.outOfOrg === true);
    ok("★★ org 内的账号 outOfOrg 是 false（不是 undefined）",
      r2.items.find((i) => i.accountId === "222222222222")?.outOfOrg === false);
    ok("★★★ 组织外账号也算 onboarded，所以「待更新栈」等徽章对它生效",
      out?.onboarded === true && out?.needsStackUpdate === true);
    ok("★★ orgListable 仍是 true（ListAccounts 是成功的，不该报成降级）",
      r2.orgListable === true);
    ok("★★ 不重复：org 内那个只出现一次",
      ids.filter((x) => x === "222222222222").length === 1);
    ok("★★★ 部署账号自己不会被塞进来（误 offboard 会删掉它的登记记录）",
      !ids.includes("444455556666"));
  } finally {
    lib.DynamoDBDocumentClient.prototype.send = origDdb;
    orgLib.OrganizationsClient.prototype.send = origOrg;
    stsLib.STSClient.prototype.send = origSts;
  }
}

/* ── 巡检 space id 的**校验**（review 的 P0-3）──────────────────────────────
 *
 * 🔴 贴成**排障**那个 space 的 id 会静默切断这个账号的排障链路：
 *    da#<账号>.inspect_agent_space_id == agent_space_id
 *      → accounts.inspect_space_ids 收进集合
 *      → callback_route 对该账号每一次排障调查都判 INSPECTION
 *      → CardMode.SKIP + 巡检 S3 前缀 + 跳过 progress 行与 IM 投递
 *    客户看到：点了深度调查、调查真跑完了，卡片永远不来、报告在排障列表里
 *    找不到。零错误码。
 *
 * ⚠️ 诱因很实：CFN Outputs 里 AgentSpaceId 与 InspectionAgentSpaceId 形态
 *    一模一样，管理页两个输入框的 placeholder 也一样。
 */
{
  const mod = await import("../member_accounts.mjs");
  const lib = await import("@aws-sdk/lib-dynamodb");
  const orig = lib.DynamoDBDocumentClient.prototype.send;
  lib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    const n = cmd.constructor?.name || "";
    if (n === "GetCommand") return { Item: { PK: cmd.input.Key.PK } };
    return {};
  };
  const base = {
    agent_space_id: "aaaaaaaa-1111-2222-3333-444444444444",
    trigger_role_arn: "arn:aws:iam::444455556666:role/notiops-agent-trigger-x",
  };
  const expectReject = async (label, payload, re) => {
    let msg = "";
    try { await mod.manualPayloadSave("444455556666", payload); }
    catch (e) { msg = String(e.message || e); }
    ok(label, re.test(msg));
  };
  try {
    await expectReject(
      "★★★ 贴成与排障 space 同一个 id → 拒（否则该账号排障链路静默断掉）",
      { ...base, inspect_agent_space_id: base.agent_space_id },
      /must differ/);
    await expectReject(
      "★★ 贴了 ARN → 拒（事件里 AWS 给的是 id，永不命中）",
      { ...base, inspect_agent_space_id:
        "arn:aws:aidevops:ap-northeast-1:444455556666:agentspace/bbbb" },
      /invalid inspect_agent_space_id/);
    await expectReject(
      "★★ 贴了 space 名字 → 拒",
      { ...base, inspect_agent_space_id: "notiops-inspection-444455556666" },
      /invalid inspect_agent_space_id/);
    // 合法 UUID 要放行
    let threw = false;
    try {
      await mod.manualPayloadSave("444455556666", {
        ...base,
        inspect_agent_space_id: "bbbbbbbb-1111-2222-3333-444444444444",
      });
    } catch (e) { threw = String(e.message || e); }
    ok("★★ 合法 UUID 且与排障 space 不同 → 放行", threw === false);
  } finally {
    lib.DynamoDBDocumentClient.prototype.send = orig;
  }
}

/* ── 总线 ARN 的三个「不该预填」的情形（review 的 P1-8 + 同账号自转）── */
{
  const genSrc = src.slice(src.indexOf("export async function generateLaunchStackUrl"));
  const genBody = genSrc.slice(0, genSrc.indexOf("\nexport "));
  // 🔴 **剥注释后的版本**，专给否定式断言用。理由见文件头 `stripComments`。
  const genCode = stripComments(genBody);
  ok("★★★ org 已接入的账号不预填总线 ARN（两份模板都建会双投，且不报错）",
    /wentThroughOneClick/.test(genBody)
    // 🔴 判据必须是 org_onboard_operation_id —— org_onboard_status 会被
    //    manualPayloadSave 自己写成 "ACTIVE"，用它会把手动接入的账号判成
    //    一键接入 → 不预填总线 ARN → 不建转发规则 → 事件永远回不来。
    && /org_onboard_operation_id/.test(genBody));
  ok("★★★ **不**用 org_onboard_status 做判据（manualPayloadSave 自己写它）",
    !/org_onboard_status/.test(genCode));
  ok("★★★ **部署账号自己**也不预填（同账号自转 → 客户收到两张报告卡）",
    /isSelfAccount/.test(genBody) && /SELF_ACCOUNT|sysAcct/.test(genBody));
  ok("★★ 两种情形合起来决定 devopsBusArn，不是只判一种",
    /\(wentThroughOneClick \|\| isSelfAccount\)/.test(genCode));
  ok("★ 回传两个标志，让前端能解释「为什么这个参数是空的」",
    /eventForwardingFromOneClick/.test(genBody) && /isDeployAccount/.test(genBody));
}

/* ── org 那条接入路的**真调**测试（review 的 P1-1）─────────────────────────
 *
 * 🔴 那条路原来只有 4 条源码 regex 断言，review 实测**三种坏法全绿**：
 *      空值也写空串进 DDB          → 绿
 *      整段不写                    → 绿
 *      读错输出名（把排障 space id 写进巡检字段）→ 绿
 *    其中一条 regex 命中的还是函数里的**注释**（「模板输出 InspectionAgentSpaceId」）。
 *
 * ⚠️ 第三种最坏：该账号每一次排障调查都被判 INSPECTION → 客户点了深度调查，
 *    卡片永远不来。
 */
{
  const mod = await import("../member_accounts.mjs");
  const lib = await import("@aws-sdk/lib-dynamodb");
  const cfnLib = await import("@aws-sdk/client-cloudformation");
  const stsLib = await import("@aws-sdk/client-sts");
  const origDdb = lib.DynamoDBDocumentClient.prototype.send;
  const origCfn = cfnLib.CloudFormationClient.prototype.send;
  const origSts = stsLib.STSClient.prototype.send;
  // ⚠️ `credsFor`（xacct.mjs）走 STS AssumeRole。ESM 的导出是只读的，
  //    patch 不了那个函数本身 —— 所以 patch 它底下的 STSClient。
  stsLib.STSClient.prototype.send = async function () {
    return { Credentials: {
      AccessKeyId: "AKIAFAKE", SecretAccessKey: "fake",
      SessionToken: "fake", Expiration: new Date(Date.now() + 3600e3),
    } };
  };
  const writes = [];

  const runOrg = async (outputs) => {
    writes.length = 0;
    lib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
      const n = cmd.constructor?.name || "";
      if (n === "UpdateCommand") { writes.push(cmd.input); return {}; }
      // ⚠️ `credsFor`（xacct.mjs）会读 `account#<id>.role_arn` —— 没有它就抛
      //    cross_account_unavailable，整个函数走不到我们要测的那一段。
      if (n === "GetCommand") {
        return { Item: {
          PK: cmd.input.Key.PK,
          role_arn: "arn:aws:iam::444455556666:role/notiops-idle-detection-role-x",
        } };
      }
      return {};
    };
    cfnLib.CloudFormationClient.prototype.send = async function (cmd) {
      const n = cmd.constructor?.name || "";
      if (n === "DescribeStackSetOperationCommand") {
        return { StackSetOperation: { Status: "SUCCEEDED" } };
      }
      if (n === "ListStackInstancesCommand") {
        return { Summaries: [{ StackId: "arn:aws:cloudformation:x:y:stack/s/1" }] };
      }
      if (n === "DescribeStacksCommand") {
        return { Stacks: [{ Outputs: Object.entries(outputs)
          .map(([k, v]) => ({ OutputKey: k, OutputValue: v })) }] };
      }
      return {};
    };
    const r = await mod.devopsAgentAssocStatus("op-1", "444455556666");
    const w = writes.find((x) => x.Key?.PK === "da#444455556666");
    return { r, w };
  };

  const RCA = "aaaaaaaa-1111-2222-3333-444444444444";
  const INSP = "bbbbbbbb-1111-2222-3333-444444444444";
  const TRA = "arn:aws:iam::444455556666:role/notiops-agent-trigger-x";
  try {
    let { w } = await runOrg({ AgentSpaceId: RCA, TriggerRoleArn: TRA,
                              InspectionAgentSpaceId: INSP });
    ok("★★★ 真调 org 路：有巡检 space → 写进 UpdateExpression",
      !!w && /inspect_agent_space_id = :isi/.test(w.UpdateExpression)
      && w.ExpressionAttributeValues[":isi"] === INSP);

    ({ w } = await runOrg({ AgentSpaceId: RCA, TriggerRoleArn: TRA }));
    ok("★★★ 真调 org 路：旧模板没那个输出 → **字段完全不出现**（不是空串）",
      !!w && !/inspect_agent_space_id/.test(w.UpdateExpression)
      && !(":isi" in w.ExpressionAttributeValues));

    ({ w } = await runOrg({ AgentSpaceId: RCA, TriggerRoleArn: TRA,
                            InspectionAgentSpaceId: RCA }));
    ok("★★★ 真调 org 路：输出名读错（= 排障 space id）→ 丢弃，不写",
      !!w && !/inspect_agent_space_id/.test(w.UpdateExpression));

    ({ w } = await runOrg({ AgentSpaceId: RCA, TriggerRoleArn: TRA,
                            InspectionAgentSpaceId:
                              "arn:aws:aidevops:x:y:agentspace/zz" }));
    ok("★★ 真调 org 路：形状不对（ARN）→ 丢弃，不写",
      !!w && !/inspect_agent_space_id/.test(w.UpdateExpression));
  } finally {
    lib.DynamoDBDocumentClient.prototype.send = origDdb;
    cfnLib.CloudFormationClient.prototype.send = origCfn;
    stsLib.STSClient.prototype.send = origSts;
  }
}

/* ── 手动回填之后**重新**生成链接，总线 ARN 必须还在（review 的 P0-2）──
 *
 * 🔴 这是「存量账号升级」那条路的钥匙，而它此前**零覆盖**：
 *    `manualPayloadSave` 写 org_onboard_status="ACTIVE"（有测试钉着），
 *    `generateLaunchStackUrl` 用 org_onboard_status 判「走过一键接入」（也有测试
 *    钉着）—— 两条断言互相矛盾，而**没有任何测试把两个函数串起来跑**。
 *
 * 后果链：管理页显示「待更新栈」→ 客户按提示重新部署 → 链接里总线 ARN 是空 →
 * 模板 EnableEventForwarding=false → 不建转发规则 → 事件永远回不来。
 * 而 InspectionAgentSpaceId 回填成功 → 徽章消失 → **看起来修好了**。零错误码。
 */
{
  const mod = await import("../member_accounts.mjs");
  const lib = await import("@aws-sdk/lib-dynamodb");
  const s3lib = await import("@aws-sdk/client-s3");
  const origDdb = lib.DynamoDBDocumentClient.prototype.send;
  const origS3 = s3lib.S3Client.prototype.send;

  // 一个极简的内存 config 表：manualPayloadSave 写进去，generateLaunchStackUrl 读出来
  const rows = new Map();
  lib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    const n = cmd.constructor?.name || "";
    const pk = cmd.input?.Key?.PK;
    if (n === "GetCommand") return { Item: rows.get(pk) || undefined };
    if (n === "UpdateCommand") {
      const cur = rows.get(pk) || { PK: pk };
      const names = cmd.input.ExpressionAttributeNames || {};
      const vals = cmd.input.ExpressionAttributeValues || {};
      // ⚠️ **要认三件事**，否则这个 stub 会静默漏掉真实写入：
      //    ① `#alias` → ExpressionAttributeNames 解析
      //    ② `if_not_exists(x, :v)` → 已有值时不覆盖
      //    ③ 普通 `field = :v`
      //    第一版只认 ③ —— 于是 `#rg = if_not_exists(#rg, :rg)` 完全没被解析，
      //    测试报「regions 是 undefined」，看起来像产品代码没写它。
      const resolve = (k) => (k.startsWith("#") ? (names[k] || k) : k);
      for (const m of cmd.input.UpdateExpression.matchAll(
             /(#?[a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*if_not_exists\(\s*#?[a-zA-Z_][a-zA-Z0-9_]*\s*,\s*(:[a-zA-Z0-9_]+)\s*\)/g)) {
        const f = resolve(m[1]);
        if (cur[f] === undefined) cur[f] = vals[m[2]];
      }
      for (const m of cmd.input.UpdateExpression.matchAll(
             /(#?[a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(:[a-zA-Z0-9_]+)(?!\s*\))/g)) {
        cur[resolve(m[1])] = vals[m[2]];
      }
      rows.set(pk, cur);
      return {};
    }
    return {};
  };
  s3lib.S3Client.prototype.send = async function () { return { Body: null }; };

  try {
    // ① 手动回填（会写 account# 与 da# 两行）
    await mod.manualPayloadSave("444455556666", {
      agent_space_id: "aaaaaaaa-1111-2222-3333-444444444444",
      trigger_role_arn: "arn:aws:iam::444455556666:role/notiops-agent-trigger-x",
      inspect_agent_space_id: "bbbbbbbb-1111-2222-3333-444444444444",
    });
    const acctRow = rows.get("account#444455556666") || {};
    ok("★★ 前提确认：manualPayloadSave 确实写了 org_onboard_status=ACTIVE",
      acctRow.org_onboard_status === "ACTIVE");
    // 🔴 采集 Region 必须写一个值。不写的话读侧落到 us-east-1 默认 →
    //    客户资源不在那个区 → expected=0 → completeness=1 → run success
    //    → 看板「跑过了、没风险」。零错误码。
    ok("★★★ 手动接入写了 regions（不写会让巡检只扫 us-east-1 且静默）",
      Array.isArray(acctRow.regions) && acctRow.regions.length > 0);
    ok("★★ 默认值是**部署 Region**，不是硬编码的 us-east-1",
      Array.isArray(acctRow.regions)
      && acctRow.regions[0] === "ap-northeast-1");   // ⚠️ 断**字面量**
    ok("★★ 前提确认：它**不**写 org_onboard_operation_id（那是 StackSet 那条路写的）",
      !acctRow.org_onboard_operation_id);

    // ⚠️ 再回填一次（存量升级那条路会做）**不能**冲掉运维改过的 region
    rows.get("account#444455556666").regions = ["eu-west-1", "ap-south-1"];
    await mod.manualPayloadSave("444455556666", {
      agent_space_id: "aaaaaaaa-1111-2222-3333-444444444444",
      trigger_role_arn: "arn:aws:iam::444455556666:role/notiops-agent-trigger-x",
    });
    ok("★★★ 重复回填**不覆盖**运维改过的 regions（if_not_exists）",
      JSON.stringify(rows.get("account#444455556666").regions)
        === JSON.stringify(["eu-west-1", "ap-south-1"]));

    // ② 重新生成链接 —— 这一步以前会把总线 ARN 吞成空串
    const r = await mod.generateLaunchStackUrl("444455556666");
    ok("★★★ 手动接入过的账号重新生成链接：总线 ARN **仍然**预填",
      typeof r.devopsEventBusArn === "string"
      && r.devopsEventBusArn.includes("event-bus/notiops-devops-events")
      && r.launchStackUrl.includes("param_DevOpsEventBusArn=arn"));
    ok("★★ 且没被判成「走过一键接入」",
      r.eventForwardingFromOneClick === false);
  } finally {
    lib.DynamoDBDocumentClient.prototype.send = origDdb;
    s3lib.S3Client.prototype.send = origS3;
  }
}

/* ── PUT /admin/member-accounts/<id>/regions（2026-08-31 实机暴露的 500）──────
 *
 * 🔴 那条路由写的是 `(body || {}).regions`，而这个块里请求体叫 `authBody`
 *    （index.mjs:103 解析的）。`body` 在那个作用域**不存在** ⇒
 *    `ReferenceError: body is not defined` ⇒ 500。
 *
 * ⚠️ `(body || {})` 这个写法**看起来**已经防过 undefined 了 —— 但 `||` 防不了
 *    **未声明的标识符**，那是 ReferenceError 不是 undefined。这就是它能一直
 *    躺在代码里的原因。
 *
 * ⚠️ 现场表现：管理页点「改 Region」→「确认接入」→ 500，前端当成网络错误
 *    重试了十几次，每次都 500。而 `npm test` 全绿 —— 这条路由**零覆盖**。
 */
{
  const idx = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../index.mjs", import.meta.url), "utf8"));
  const idxCode = stripComments(idx);

  // ① 静态判据：那一行必须用 authBody
  const m = /memberRegionsMatch\[1\],\s*\(([A-Za-z_$][\w$]*)\s*\|\|/.exec(idxCode);
  ok("★★★ regions 路由取的是 authBody（不是不存在的 body）",
    !!m && m[1] === "authBody");

  /* ② 更值钱的一条：**整个 admin 块里不许出现裸标识符 `body`**。
   *
   * 这是通用判据 —— 它能抓住「下一个人在这个块里又写了 body」，
   * 而 ① 只钉住这一行。ReferenceError 类的错在 JS 里不到运行时不报，
   * 所以必须静态钉。
   */
  const adminStart = idxCode.indexOf("let authBody = {}");
  const adminEnd = idxCode.indexOf("const parseBody = ()");
  ok("★★ 前提：能定位 admin 块的范围",
    adminStart > 0 && adminEnd > adminStart);
  const adminBlock = idxCode.slice(adminStart, adminEnd);
  /* 剥掉 event.body / authBody / 对象字面量的 `body:` key，以及**块注释**。
   *
   * ⚠️ `stripComments` 只剥 `//` 行注释 —— 这个块里还有一句
   *    `} catch { /* 非 JSON body（如无 body 的 GET）→ 空对象 *\/ }`，
   *    里面两个「body」是中文说明。第一版没剥它，判据报「实际 2 处」，
   *    是我的判据有漏、不是产品问题。 */
  const stripped = adminBlock
    .replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释
    .replace(/(?:event|auth|parse|req|res)\s*\.\s*body/g, "")
    .replace(/\bauthBody\b/g, "")
    .replace(/\bbody\s*:/g, "");         // `{ body: authBody }` 这种 key
  const bare = stripped.match(/(?<![.\w$])body(?![\w$])/g) || [];
  ok(`★★★ admin 块里没有裸用 body（实际 ${bare.length} 处）`,
    bare.length === 0);
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
