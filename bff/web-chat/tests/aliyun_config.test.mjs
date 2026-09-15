/**
 * BFF 阿里云凭据配置单测（Admin「多云」→ 阿里云分页的后端）。
 *
 * 骨架照抄 tests/dingtalk_config.test.mjs：纯断言、不引 mock 框架，Secrets Manager 经
 * `__setClients()` 注入假实现，全程不触网。
 *
 * 为什么这一份必须**单独写**，而不是给钉钉那份加几行：
 *
 *   ① 这里存的是**客户另一朵云的账号凭据**。钉钉那份泄漏一个 app_secret，攻击面止于
 *      「能往那个群发消息」；这里泄漏一组 AK/SK，攻击面是客户阿里云账号里这把钥匙能
 *      碰到的一切。所以「响应体全量扫描不含明文」这条断言在这里是硬要求，不是补充。
 *   ② `region_id` 会被拼进 `sts.<region>.aliyuncs.com`，是一道 **SSRF 闸门**。钉钉那份
 *      没有任何"会被拼进 URL 的自由文本字段"，没有对应的断言可抄。这份测试逐个喂
 *      `evil.com#`、`../`、`a.b`、带 `@` 的串，要求全部被拒**且不落盘**。
 *   ③ `auth_mode` 现在只允许 `"ak"`。将来加 OIDC 时，老前端传 `"oidc"` 必须**当场失败**，
 *      不能被悄悄当成 ak 存下去（那会让界面显示"已配置 OIDC"而实际一次调用都发不出去
 *      —— 正是「不许静默降级」要挡的）。这条也没有钉钉侧的对应物。
 *
 * 覆盖：
 *   · GET 脱敏：空 → ""（未配置，不是 ****）/ 非空 → ****后4位 / ≤4 位整串遮掉 / 响应无明文
 *   · GET 的 `configured` 语义：AK id 与 AK secret 都非空才算配好
 *   · GET 缺省：secret 不存在 → 空表单 + region 默认 cn-hangzhou
 *   · PUT 合并：脱敏值 = 不变 / 新值 = 覆盖 / 空串 = 真清空 / 表单外的键保留
 *   · PUT 校验：AK id 形状、region SSRF 闸门、auth_mode 白名单；失败一律不落盘
 *   · PUT 报错**不回显** access_key_secret，也不回显被拒的 region 串
 *   · secret 不存在 → CreateSecret 兜底，且**带 project / auto-delete 标签**
 *   · loadAliyunCredentials()：配全了才回值；缺一半回 null（调用方必须显式失败）；
 *     脏 region 回落默认值而不是把它拼进 endpoint
 *
 * 运行：node bff/web-chat/tests/aliyun_config.test.mjs
 */
import assert from "node:assert/strict";

import * as mod from "../aliyun_config.mjs";

/* ───────────────── 假 Secrets Manager ───────────────── */

const state = { secret: null, updates: [], creates: [] };

const fakeSm = {
  async send(cmd) {
    // 注入模式下命令对象是真实 SDK 类的实例，按构造函数名识别（无自定义标记）。
    const t = cmd.constructor.name.replace(/Command$/, "");
    if (t === "GetSecretValue") {
      if (state.secret === null) {
        throw Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
      }
      return { SecretString: JSON.stringify(state.secret) };
    }
    if (t === "UpdateSecret") {
      // secret 不存在时 UpdateSecret 也抛 RNFE —— 这样 CreateSecret 兜底那条分支才真被走到。
      if (state.secret === null) {
        throw Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
      }
      state.updates.push(cmd.input);
      state.secret = JSON.parse(cmd.input.SecretString);
      return {};
    }
    if (t === "CreateSecret") {
      state.creates.push(cmd.input);
      state.secret = JSON.parse(cmd.input.SecretString);
      return {};
    }
    throw new Error(`unexpected sm cmd ${t}`);
  },
};

mod.__setClients({ sm: fakeSm });

/* ───────────────── 测试骨架 ───────────────── */

let pass = 0, fail = 0;
function reset() {
  state.secret = null; state.updates = []; state.creates = [];
}
async function t(name, fn) {
  reset();
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message.split("\n")[0]}`); }
}

/** 一份「全都配好了」的 secret。
 *
 * ⚠️ 两个值都刻意含 `example`，不是「长得像真的」那种随机串：`bff/` 整个目录会随发布包
 * 外发，发布 gate 里的 gitleaks 会把高熵随机串判成 `generic-api-key`，而 `example` 是
 * gitleaks 的 stopword。把它「改得更真实一点」就会再把 gate 弄红（钉钉那份同样的坑）。 */
const AK_ID = "LTAI_example_akid";
const AK_SECRET = "aliyun-example-secret-ends-WXYZ";
const FULL = () => ({
  auth_mode: "ak",
  access_key_id: AK_ID,
  access_key_secret: AK_SECRET,
  region_id: "cn-hangzhou",
});

const put = (config) => mod.apiPutAliyunConfig({ config });
const get = () => mod.apiGetAliyunConfig();

/* ───────────────── GET 脱敏 ───────────────── */
console.log("GET — masking");

await t("未配置的 AK secret 回显空串，不是 ****", async () => {
  // 方式B 里 CDK 建出来的 secret 是空串（`secretStringTemplate` + `generateStringKey`）。
  // 回 **** 会让客户以为已经配好、跳过阿里云那边建 RAM 用户那一步，最后拿一个
  // 「什么都查不到」来排查。
  state.secret = { access_key_id: AK_ID, access_key_secret: "" };
  const r = await get();
  assert.equal(r.aliyun.access_key_secret, "", "empty secret must render as a blank field");
  assert.equal(r.aliyun.access_key_id, AK_ID, "AK id 不是凭证（签名要成对），明文回显");
  assert.equal(r.aliyun.configured, false, "少一半就不算配好");
});

await t("已配置的 AK secret 只回后 4 位", async () => {
  state.secret = FULL();
  const r = await get();
  assert.equal(r.aliyun.access_key_secret, "****WXYZ");
  assert.equal(r.aliyun.configured, true);
});

await t("长度 ≤4 的值整串遮掉（后 4 位就是全部）", async () => {
  state.secret = { ...FULL(), access_key_secret: "abcd" };
  const r = await get();
  assert.equal(r.aliyun.access_key_secret, "****");
});

await t("GET 响应里不含 AK secret 明文", async () => {
  // 全量扫描整个响应，而不是逐个字段断言 —— 以后新增字段忘了脱敏，这条会红。
  state.secret = FULL();
  const blob = JSON.stringify(await get());
  assert.ok(!blob.includes(AK_SECRET), "access_key_secret plaintext leaked in GET response");
});

await t("secret 不存在 → 空表单 + region 默认 cn-hangzhou", async () => {
  state.secret = null;
  const r = await get();
  // 逐字段列全（而不是只挑几个断言）：新增字段忘了给默认值时这条会红 —— 前端拿到
  // `undefined` 的表单字段会变成"不受控输入"，客户打字打不进去，而没人会怀疑后端。
  assert.deepEqual(r.aliyun, {
    access_key_id: "",
    access_key_secret: "",
    region_id: "cn-hangzhou",
    auth_mode: "ak",
    configured: false,
    starops_employee: "",
    starops_region: "cn-beijing",   // ⚠️ 与 region_id 的默认值**故意不同**：这是接口地域
    starops_workspace: "",
    starops_project: "",
    starops_configured: false,
  });
});

await t("只填了 AK secret 没填 id → configured 仍是 false", async () => {
  // 两个都得有才签得出请求。少一个而显示"已配置"，客户会去查网络和权限，查不到凭据这一层。
  state.secret = { access_key_id: "", access_key_secret: AK_SECRET };
  const r = await get();
  assert.equal(r.aliyun.configured, false);
});

/* ───────────────── PUT 合并语义 ───────────────── */
console.log("\nPUT — merge semantics");

await t("回传脱敏值 = 保持原值不变", async () => {
  // 真实场景：客户只想换地域，密钥框里还是 GET 回来的 ****WXYZ。
  state.secret = FULL();
  const r = await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ", region_id: "cn-beijing" });
  assert.ok(!r.error, r.error);
  assert.equal(state.secret.access_key_secret, AK_SECRET, "没动过的密钥不能被 **** 覆盖");
  assert.equal(state.secret.region_id, "cn-beijing", "非敏感字段照常更新");
});

await t("回传新值 = 覆盖", async () => {
  state.secret = FULL();
  await put({ access_key_id: AK_ID, access_key_secret: "brand-new-example-secret" });
  assert.equal(state.secret.access_key_secret, "brand-new-example-secret");
});

await t("空串不当脱敏值处理（清掉密钥仍是清掉）", async () => {
  // 客户吊销那个 RAM 用户以后必须真的能清空，否则界面继续显示"已配置"、每次调用都 403。
  state.secret = FULL();
  await put({ access_key_id: AK_ID, access_key_secret: "" });
  assert.equal(state.secret.access_key_secret, "", "empty string must not be treated as ****");
  const r = await get();
  assert.equal(r.aliyun.configured, false);
});

await t("端到端往返：写进去，再 GET 回来是脱敏形态", async () => {
  state.secret = { access_key_id: "", access_key_secret: "", region_id: "" };
  await put({ access_key_id: AK_ID, access_key_secret: "e-1111-example-9999-KEYZ", region_id: "cn-shanghai" });
  const r = await get();
  assert.equal(r.aliyun.access_key_secret, "****KEYZ");
  assert.equal(r.aliyun.region_id, "cn-shanghai");
  assert.equal(state.secret.access_key_secret, "e-1111-example-9999-KEYZ", "secret 里落的是明文");
});

await t("表单外的字段不被这次保存抹掉（CDK 的 placeholder / 将来的 role_arn）", async () => {
  // 保底口径：这个 PUT 只许改表单里那四个字段。CDK 建 secret 时生成的 `placeholder`、
  // 以及将来上 OIDC 时加的 `role_arn`，都必须原样保留。
  state.secret = { ...FULL(), placeholder: "created-by-cdk", role_arn: "acs:ram::111122223333:role/x" };
  await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ" });
  assert.equal(state.secret.placeholder, "created-by-cdk");
  assert.equal(state.secret.role_arn, "acs:ram::111122223333:role/x");
});

await t("region 不填 → 保留原值；原值也没有 → 默认 cn-hangzhou", async () => {
  state.secret = { ...FULL(), region_id: "cn-beijing" };
  await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ" });
  assert.equal(state.secret.region_id, "cn-beijing");

  state.secret = { access_key_id: "", access_key_secret: "" };
  await put({ access_key_id: AK_ID, access_key_secret: "k-example-value" });
  assert.equal(state.secret.region_id, "cn-hangzhou");
});

await t("secret 不存在 → PUT 走 CreateSecret，且带强制标签", async () => {
  // 方式A 一键模板里没有任何凭据资源，这个 secret 由 BFF 在首次保存时建出来 ——
  // 栈级 Tags 盖不到它，不在 CreateSecret 里打就永远没有标签（仓库强制标签规则）。
  state.secret = null;
  const r = await put({ access_key_id: AK_ID, access_key_secret: "k-example-value" });
  assert.ok(!r.error, r.error);
  assert.equal(state.creates.length, 1, "must fall back to CreateSecret");
  assert.equal(state.updates.length, 0);
  const tags = Object.fromEntries((state.creates[0].Tags || []).map((x) => [x.Key, x.Value]));
  assert.equal(tags.project, "notiops", "缺 project 标签");
  assert.equal(tags["auto-delete"], "no", "缺 auto-delete 标签");
});

/* ───────────────── 校验 ───────────────── */
console.log("\nPUT — validation");

await t("缺 config → 400，且不落盘", async () => {
  state.secret = FULL();
  for (const bad of [undefined, {}, { config: null }, { config: "x" }]) {
    state.updates = [];
    const r = await mod.apiPutAliyunConfig(bad);
    assert.equal(r.status, 400, `should reject: ${JSON.stringify(bad)}`);
    assert.equal(state.updates.length, 0);
  }
});

await t("AK id 形状校验（粘错整行），失败不落盘", async () => {
  state.secret = FULL();
  for (const bad of ["AccessKeyId: LTAI_example", "LTAI short", "abc", "LTAI/example/key"]) {
    state.updates = [];
    const r = await put({ access_key_id: bad, access_key_secret: "****WXYZ" });
    assert.equal(r.status, 400, `should reject: ${bad}`);
    assert.equal(state.updates.length, 0, `must not persist: ${bad}`);
    assert.equal(state.secret.access_key_id, AK_ID, "原值必须保持不变");
  }
});

await t("AK id 刻意宽松：非 LTAI 前缀的合法 key 不被误拒", async () => {
  // 阿里云 AK id 历史上有 `LTAI`（RAM 用户）、`STS.`（临时凭证）和更早的纯随机串三种，
  // 官方没承诺过格式。误拒一个合法 AK = 客户在界面上没有任何绕过手段。
  state.secret = FULL();
  for (const ok of ["STS.example-token-id", "example0123456789", "ak.example-1234"]) {
    const r = await put({ access_key_id: ok, access_key_secret: "****WXYZ" });
    assert.ok(!r.error, `should accept ${ok}: ${r.error}`);
    assert.equal(state.secret.access_key_id, ok);
  }
});

await t("region SSRF 闸门：拒一切能改写主机名的字符，且不落盘", async () => {
  // region 会被拼进 `sts.<region>.aliyuncs.com`。放过一个点号或 `#` 就能把 endpoint
  // 指到任意主机，而这条请求是由 BFF Lambda 的执行角色发出去的。
  for (const bad of [
    "cn-hangzhou.evil.example",          // 点号 → 加一级域名
    "evil.example#",                      // 用 # 把后缀吃掉
    "a@evil.example",                     // userinfo 伪装
    "cn-hangzhou/../../x",                // 路径穿越
    "cn hangzhou",                        // 空白
    "CN-HANGZHOU",                        // 大写（阿里云 region 全小写）
    "cn-hangzhou:9999",                   // 改端口
    "cn",                                 // 太短
  ]) {
    state.secret = FULL(); state.updates = [];
    const r = await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ", region_id: bad });
    assert.equal(r.status, 400, `should reject region: ${bad}`);
    assert.equal(state.updates.length, 0, `must not persist region: ${bad}`);
    assert.equal(state.secret.region_id, "cn-hangzhou", "原 region 必须保持不变");
  }
});

await t("region 允许清单不写死地域名（新地域也能上车）", async () => {
  // 反向断言：不许有人把校验收紧成穷举清单 —— 阿里云会新增地域，写死清单的代价是
  // 新地域上不了车而客户无从绕过。
  state.secret = FULL();
  for (const ok of ["cn-hangzhou", "ap-southeast-1", "us-east-1", "cn-wulanchabu", "zz-future-9"]) {
    const r = await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ", region_id: ok });
    assert.ok(!r.error, `should accept region ${ok}: ${r.error}`);
    assert.equal(state.secret.region_id, ok);
  }
});

await t("auth_mode 白名单：oidc 当场失败，不许静默降级成 ak", async () => {
  // 将来加 OIDC 时这条会改。今天存下一组"填了但运行时用不上"的 OIDC 配置，界面会显示
  // "已配置"而实际一次调用都发不出去 —— 那是静默降级。
  state.secret = FULL();
  for (const bad of ["oidc", "ram-role", "", "AK"]) {
    state.updates = [];
    const r = await put({ auth_mode: bad, access_key_id: AK_ID, access_key_secret: "****WXYZ" });
    assert.equal(r.status, 400, `should reject auth_mode: ${bad}`);
    assert.equal(state.updates.length, 0);
  }
  const ok = await put({ auth_mode: "ak", access_key_id: AK_ID, access_key_secret: "****WXYZ" });
  assert.ok(!ok.error, ok.error);
});

await t("任何一条错误消息都不回显 AK secret，也不回显被拒的 region 串", async () => {
  // 错误响应会被前端原样画在页面上、也会进浏览器控制台。
  // region 那条尤其要注意：一个被拒的 region 串可能正是一次注入尝试，原样回显等于
  // 把它反射给浏览器。
  state.secret = FULL();
  const LEAK = "aliyun-example-SUPERSECRETVALUE";
  const msgs = [];
  msgs.push((await put({ access_key_id: "bad id", access_key_secret: LEAK })).error);
  msgs.push((await put({ access_key_id: AK_ID, access_key_secret: LEAK, region_id: "evil.example#" })).error);
  msgs.push((await put({ auth_mode: "oidc", access_key_id: AK_ID, access_key_secret: LEAK })).error);
  for (const m of msgs) {
    assert.ok(typeof m === "string" && m.length > 0, "校验失败必须给出可读原因");
    assert.ok(!m.includes(LEAK), `access_key_secret leaked: ${m}`);
    assert.ok(!m.includes("SUPERSECRET"), `access_key_secret leaked: ${m}`);
    assert.ok(!m.includes("evil.example"), `回显了客户填的 region: ${m}`);
  }
});

/* ───────────────── STAROps 数字员工子配置 ─────────────────
 * 这四个字段与 AK/SK **同住一个 secret**，所以它们的 bug 全是"互相冒充"型：
 *   · 用同一个 `configured` 判两件事 → 「多云已连通」冒充「STAROps 对话可用」
 *   · 用 `||` 合并 → 客户清空了字段却被粘回旧值，界面显示的和实际用的不是一个员工
 *   · 地域放宽成 REGION_RE → cn-hangzhou 能存进去，然后每次对话一个语义不明的 404
 */
console.log("\nSTAROps — digital employee sub-config");

await t("GET 原样回显（都不是凭证，客户必须看得见自己填了哪个员工）", async () => {
  state.secret = {
    ...FULL(),
    starops_employee: "aliyun-starops", starops_region: "ap-southeast-1",
    starops_workspace: "ws-example-1", starops_project: "proj-example-1",
  };
  const r = await get();
  assert.equal(r.aliyun.starops_employee, "aliyun-starops");
  assert.equal(r.aliyun.starops_region, "ap-southeast-1");
  assert.equal(r.aliyun.starops_workspace, "ws-example-1");
  assert.equal(r.aliyun.starops_project, "proj-example-1");
  assert.equal(r.aliyun.starops_configured, true);
});

await t("starops_configured 与 configured 是两个判据，不许互相冒充", async () => {
  // ① AK 配好、员工名没填 → 多云连通了，但对话发不出去。
  state.secret = { ...FULL(), starops_employee: "" };
  let r = await get();
  assert.equal(r.aliyun.configured, true, "AK 齐了就是齐了");
  assert.equal(r.aliyun.starops_configured, false, "少了员工名，对话不可用");

  // ② 填了员工名、AK 没配全 → 同样不可用（签名要 id+secret 成对）。
  state.secret = { access_key_id: AK_ID, access_key_secret: "", starops_employee: "aliyun-starops" };
  r = await get();
  assert.equal(r.aliyun.configured, false);
  assert.equal(r.aliyun.starops_configured, false, "光有员工名签不出请求");
});

await t("三个名字字段能被真正清空（`??` 而不是 `||`）", async () => {
  // 客户换数字员工时会先清掉旧的。用 `||` 合并会把旧值粘回来 —— 他按了保存、界面回显
  // 也变了（因为前端用的是自己的 state），但下一轮对话仍然打到旧员工上。
  state.secret = {
    ...FULL(), starops_employee: "old-emp",
    starops_workspace: "old-ws", starops_project: "old-proj",
  };
  await put({
    access_key_id: AK_ID, access_key_secret: "****WXYZ",
    starops_employee: "", starops_workspace: "", starops_project: "",
  });
  assert.equal(state.secret.starops_employee, "", "员工名必须真的被清空");
  assert.equal(state.secret.starops_workspace, "");
  assert.equal(state.secret.starops_project, "");
  const r = await get();
  assert.equal(r.aliyun.starops_configured, false);
});

await t("没传这三个字段 → 保留原值（只改地域的场景）", async () => {
  state.secret = { ...FULL(), starops_employee: "keep-me", starops_workspace: "keep-ws" };
  await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ", region_id: "cn-beijing" });
  assert.equal(state.secret.starops_employee, "keep-me");
  assert.equal(state.secret.starops_workspace, "keep-ws");
});

await t("starops_region 是穷举允许清单（只有两个接口地域），失败不落盘", async () => {
  // 它会被拼进 `starops.<region>.aliyuncs.com`。STAROps 官方元数据里 endpoints 只有这两条，
  // 能穷举就穷举 —— 比 REGION_RE 那种字符集限制更严的一道 SSRF 闸门。
  for (const bad of [
    "cn-hangzhou",              // ⚠️ 合法的阿里云地域，但 STAROps 没有 → 最容易填错的一个
    "us-east-1", "cn-beijing.evil.example", "evil.example#", "CN-BEIJING", "cn-beijing ",
  ]) {
    state.secret = { ...FULL(), starops_region: "cn-beijing" }; state.updates = [];
    const r = await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ", starops_region: bad });
    assert.equal(r.status, 400, `should reject starops_region: ${bad}`);
    assert.equal(state.updates.length, 0, `must not persist: ${bad}`);
    assert.equal(state.secret.starops_region, "cn-beijing", "原值必须保持不变");
  }
  for (const good of ["cn-beijing", "ap-southeast-1"]) {
    state.secret = FULL();
    const r = await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ", starops_region: good });
    assert.ok(!r.error, `should accept ${good}: ${r.error}`);
    assert.equal(state.secret.starops_region, good);
  }
});

await t("starops_region 空串 = 没选，落回默认 cn-beijing（下拉框不该存空值）", async () => {
  state.secret = { access_key_id: "", access_key_secret: "" };
  await put({ access_key_id: AK_ID, access_key_secret: "k-example-value", starops_region: "" });
  assert.equal(state.secret.starops_region, "cn-beijing");
});

await t("员工名 / workspace / project 形状校验（粘错整行），失败不落盘", async () => {
  for (const k of ["starops_employee", "starops_workspace", "starops_project"]) {
    for (const bad of [
      "aliyun starops",        // 空格：从控制台整行复制的典型
      "emp/../other",          // 会改写 URL 路径语义
      "emp:1", "emp#frag", "emp?q=1",
      "-leading-hyphen",       // 首字符必须是字母或数字
      "x".repeat(200),         // 超长
    ]) {
      state.secret = { ...FULL(), [k]: "good-value" }; state.updates = [];
      const r = await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ", [k]: bad });
      assert.equal(r.status, 400, `should reject ${k}: ${bad}`);
      assert.equal(state.updates.length, 0, `must not persist ${k}: ${bad}`);
      assert.equal(state.secret[k], "good-value", "原值必须保持不变");
    }
  }
});

await t("报错里说清楚是**哪个**字段错了，且不回显客户填的值", async () => {
  // 「保存失败」而不说哪一项，客户会把整块表单重填一遍（包括已经对的 AK）。
  state.secret = FULL();
  const LEAK = "evil.example#injection-attempt";
  const e1 = (await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ", starops_employee: LEAK })).error;
  assert.ok(e1.includes("starops_employee"), `没指出字段名: ${e1}`);
  assert.ok(!e1.includes("evil.example"), `回显了客户填的值: ${e1}`);
  const e2 = (await put({ access_key_id: AK_ID, access_key_secret: "****WXYZ", starops_region: "cn-hangzhou" })).error;
  assert.ok(e2.includes("starops_region"), `没指出字段名: ${e2}`);
  // 这一条**可以**回显合法取值 —— 那是我们自己的常量，不是客户输入。
  assert.ok(e2.includes("cn-beijing") && e2.includes("ap-southeast-1"), `没告诉客户能填什么: ${e2}`);
});

await t("STAROPS_REGIONS 是导出的单一事实来源（前端下拉框 / 传输层共用）", async () => {
  // 校验、endpoint 拼接、前端下拉框三处必须读同一份清单。各写一份必漂移，
  // 而漂移的表现是"界面上能选、保存也成功、一对话就 404"。
  assert.deepEqual(mod.STAROPS_REGIONS, ["cn-beijing", "ap-southeast-1"]);
});

await t("🔒 workspace 值不进日志（它嵌着阿里云账号 UID）", async () => {
  // 只能靠"读的时候不打日志"来保证 —— 这里断言 loadAliyunCredentials 走通时
  // 一行 console 都没有（有日志就说明有人顺手打了整个配置对象）。
  state.secret = { ...FULL(), starops_employee: "e", starops_workspace: "ws-uid-embedded-1" };
  const orig = { log: console.log, warn: console.warn, info: console.info };
  const seen = [];
  console.log = console.warn = console.info = (...a) => seen.push(a.join(" "));
  try { await mod.loadAliyunCredentials(); } finally { Object.assign(console, orig); }
  assert.equal(seen.length, 0, `成功路径不该打日志，实际打了: ${seen.join(" | ")}`);
});

await t("脏 starops_region 落回默认值，绝不把它拼进 endpoint", async () => {
  // 纵深防御：有人绕过 PUT 直接改了 secret（控制台手改 / 旧版本写进去的值）时，
  // 数据面也不许把它当主机名用。与上面 region_id 那条同一口径。
  state.secret = { ...FULL(), starops_region: "evil.example#" };
  const c = await mod.loadAliyunCredentials();
  assert.equal(c.staropsRegion, "cn-beijing");
});

await t("STAROps 字段首尾空白被 trim（从控制台复制常带空格）", async () => {
  state.secret = { ...FULL(), starops_employee: "  aliyun-starops \n", starops_workspace: " ws-1 " };
  const c = await mod.loadAliyunCredentials();
  assert.equal(c.staropsEmployee, "aliyun-starops");
  assert.equal(c.staropsWorkspace, "ws-1");
});

await t("AK 缺失时 loadAliyunCredentials 仍回 null（哪怕员工名填了）", async () => {
  // STAROps 字段不改变"没凭据就发不出请求"这个事实。这里回 null 是对的，
  // "缺哪一项"的细分由 starops_chat.mjs 的 loadStarOpsConfig 负责。
  state.secret = { access_key_id: AK_ID, access_key_secret: "", starops_employee: "aliyun-starops" };
  assert.equal(await mod.loadAliyunCredentials(), null);
});

/* ───────────────── 进程内明文读取 ───────────────── */
console.log("\nloadAliyunCredentials — plaintext read for the data plane");

await t("配全了 → 回明文凭据 + STAROps 子配置", async () => {
  state.secret = FULL();
  const c = await mod.loadAliyunCredentials();
  assert.deepEqual(c, {
    accessKeyId: AK_ID, accessKeySecret: AK_SECRET, regionId: "cn-hangzhou",
    // STAROps 字段没配也要**在返回值里出现**（空串），不能是 undefined：调用方要靠
    // "哪一项是空的"给出"缺哪一项"的提示，`undefined` 会让它分不清"没配"和"没这个字段"。
    staropsEmployee: "", staropsRegion: "cn-beijing", staropsWorkspace: "", staropsProject: "",
  });
});

await t("缺一半 / secret 不存在 → null（调用方必须显式失败，不许跳过）", async () => {
  for (const s of [null, { access_key_id: AK_ID, access_key_secret: "" }, { access_key_id: "", access_key_secret: AK_SECRET }, {}]) {
    state.secret = s;
    assert.equal(await mod.loadAliyunCredentials(), null, `should be null for ${JSON.stringify(s)}`);
  }
});

await t("脏 region 回落默认值，绝不把它拼进 endpoint", async () => {
  // 纵深防御：即使有人绕过 PUT 直接改了 secret（控制台手改、或旧版本写进去的值），
  // 数据面也不许把它当主机名用。
  state.secret = { ...FULL(), region_id: "evil.example#" };
  const c = await mod.loadAliyunCredentials();
  assert.equal(c.regionId, "cn-hangzhou");
});

await t("首尾空白被 trim（客户从控制台复制常带空格）", async () => {
  state.secret = { ...FULL(), access_key_id: `  ${AK_ID}  `, access_key_secret: ` ${AK_SECRET}\n` };
  const c = await mod.loadAliyunCredentials();
  assert.equal(c.accessKeyId, AK_ID);
  assert.equal(c.accessKeySecret, AK_SECRET);
});

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
