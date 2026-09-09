/**
 * BFF 钉钉机器人配置单测（Admin「集成 IM」→ 钉钉分页的后端）。
 *
 * 风格与 tests/feishu_config.test.mjs 一致：纯断言、不引 mock 框架；Secrets Manager /
 * API Gateway / fetch 全部经 `__setClients()` 测试接缝注入假实现，全程不触网。
 *
 * 为什么钉钉这一份必须**单独写**、不能照抄飞书那份的断言：钉钉少了几样平台能力，
 * 而每一样缺失都把某个 bug 变成**静默失败**：
 *
 *   ① 钉钉保存回调地址时**不做任何校验**（没有飞书的 URL challenge）。所以"凭证没存进去"
 *      和"地址填错了"在客户那儿是同一个症状：机器人一句话不回。这份测试守住的是
 *      「保存了就真的存进去了」与「没动过的钥匙不会被悄悄换掉」。
 *   ② `push_webhook_url`（自定义机器人推送地址）**本身就是凭证** —— 谁拿到都能往那个群
 *      发消息，而投递 Lambda 会把调查报告全文 POST 过去。所以有三条硬契约被断言：
 *      脱敏回显、host+path 允许清单、**报错里绝不回显这个 URL**（错误响应会进浏览器
 *      控制台和前端日志）。
 *   ③ 钉钉没有「往任意群发一条测试消息」的接口 → 「测试」只能换一次 access_token。
 *      这里断言它**如实说明什么都没发**（「不许静默降级」），否则客户会等一条永远
 *      不会来的消息。
 *
 * 覆盖：
 *   · GET 脱敏：空 → ""（未配置）/ 非空 → ****后4位 / 短值整串遮掉 / 响应无明文
 *   · GET 的字段改名契约：secret 里的 `webhook_url`（凭证）→ 对外 `push_webhook_url`；
 *     对外 `webhook_url` 是**入站公开地址**，不脱敏（文件头「命名陷阱」）
 *   · PUT 合并：脱敏值 = 不变 / 新值 = 覆盖 / 空串 = 清空 / 未知字段保留（card_template_id）
 *   · PUT 校验：app_key 形状、推送地址允许清单（且报错不回显 URL）、失败不落盘
 *   · secret 不存在：GET 回空表单、PUT 走 CreateSecret
 *   · webhook_url 查找：命中（含结尾 /）、翻页、名字对不上、无 env、GetApis 抛异常
 *   · POST /test：未配置 / 凭证错 / 凭证对但没填推送地址（如实说没发）/ 推一条成功 /
 *     推送被拒 —— 且**任何一条消息里都不含推送地址**
 *
 * 运行：node bff/web-chat/tests/dingtalk_config.test.mjs
 */
import assert from "node:assert/strict";

import * as mod from "../dingtalk_config.mjs";

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

/* ───────────────── 假 API Gateway v2（入站回调地址查找）───────────────── */

const agwState = { pages: [], calls: [], throws: null };

const fakeAgw = {
  async send(cmd) {
    const t = cmd.constructor.name.replace(/Command$/, "");
    if (t !== "GetApis") throw new Error(`unexpected agw cmd ${t}`);
    if (agwState.throws) throw agwState.throws;
    agwState.calls.push(cmd.input);
    const i = cmd.input.NextToken ? Number(cmd.input.NextToken) : 0;
    return {
      Items: agwState.pages[i] || [],
      NextToken: i + 1 < agwState.pages.length ? String(i + 1) : undefined,
    };
  },
};

/* ───────────────── 假 fetch（钉钉服务端 API）───────────────── */

// 每条请求都记下来，用于断言"推送地址被调用了/没被调用"以及请求体形状。
const fetchState = { calls: [], token: "atok-1234", tokenBody: null, pushBody: null, throwOn: null };

const fakeFetch = async (url, init) => {
  fetchState.calls.push({ url, init });
  if (fetchState.throwOn && url.includes(fetchState.throwOn)) {
    throw Object.assign(new Error("boom"), { name: "TypeError" });
  }
  if (url.endsWith("/v1.0/oauth2/accessToken")) {
    const j = fetchState.tokenBody ?? { accessToken: fetchState.token, expireIn: 7200 };
    return { status: 200, async json() { return j; } };
  }
  const j = fetchState.pushBody ?? { errcode: 0, errmsg: "ok" };
  return { status: 200, async json() { return j; } };
};

mod.__setClients({ sm: fakeSm, agw: fakeAgw, fetch: fakeFetch });

/* ───────────────── 测试骨架 ───────────────── */

let pass = 0, fail = 0;
function reset() {
  state.secret = null; state.updates = []; state.creates = [];
  agwState.pages = []; agwState.calls = []; agwState.throws = null;
  fetchState.calls = []; fetchState.token = "atok-1234";
  fetchState.tokenBody = null; fetchState.pushBody = null; fetchState.throwOn = null;
  delete process.env.IM_INGRESS_API_NAME_PREFIX;
  // 地址查找结果在进程内缓存（同一个 Lambda 容器里 API 名不会变），测试之间必须清掉，
  // 否则第一条用例的结果会污染后面所有用例。
  mod.__setClients({ resetCache: true });
}
async function t(name, fn) {
  reset();
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n         ${e.message.split("\n")[0]}`); }
}

/** 一份「全都配好了」的 secret。注意 secret 里那个 `webhook_url` 是**推送凭证**。
 *
 * ⚠️ `app_key` 刻意写成 `ding_example_appkey` 而不是「长得像真的」那种
 * `ding` + 16 位随机字母数字：`bff/` 整个目录会随发布包外发，发布 gate 里的
 * gitleaks 会把后者判成 `generic-api-key`（实测熵 3.75，6 处全红），而
 * `example` 是 gitleaks 的 stopword。把它「改得更真实一点」就会再把 gate 弄红。 */
const PUSH = "https://oapi.dingtalk.com/robot/send?access_token=abcdef0123456789send";
const FULL = () => ({
  app_key: "ding_example_appkey",
  app_secret: "s3cret-value-ends-WXYZ",
  webhook_url: PUSH,
});

const put = (config) => mod.apiPutDingtalkConfig({ platform: "dingtalk", config });
const test = () => mod.apiTestDingtalkSend({ platform: "dingtalk" });

/* ───────────────── GET 脱敏 ───────────────── */
console.log("GET — masking");

await t("未配置的敏感字段回显空串，不是 ****", async () => {
  // 与飞书同一条契约：CDK 建出来的 secret 里 app_secret 是空串。回 **** 会让客户以为
  // 已经配好、跳过钉钉那边的凭证复制 —— 而钉钉连回调地址都不校验，之后没有任何提示。
  state.secret = { app_key: "ding_example_appkey" };
  const r = await mod.apiGetDingtalkConfig();
  assert.equal(r.dingtalk.app_secret, "", "empty app_secret must render as a blank field");
  assert.equal(r.dingtalk.push_webhook_url, "", "未配置的推送地址必须是空白框");
  assert.equal(r.dingtalk.app_key, "ding_example_appkey", "app_key 不是凭证（换 token 要成对），明文回显");
});

await t("已配置的敏感字段只回后 4 位", async () => {
  state.secret = FULL();
  const r = await mod.apiGetDingtalkConfig();
  assert.equal(r.dingtalk.app_secret, "****WXYZ");
  assert.equal(r.dingtalk.push_webhook_url, "****send");
});

await t("长度 ≤4 的值整串遮掉（后 4 位就是全部）", async () => {
  state.secret = { ...FULL(), app_secret: "abcd" };
  const r = await mod.apiGetDingtalkConfig();
  assert.equal(r.dingtalk.app_secret, "****");
});

await t("GET 响应里不含 app_secret / 推送地址的明文", async () => {
  // 全量扫描整个响应，而不是逐个字段断言 —— 以后新增字段忘了脱敏，这条会红。
  state.secret = FULL();
  const blob = JSON.stringify(await mod.apiGetDingtalkConfig());
  assert.ok(!blob.includes(FULL().app_secret), "app_secret plaintext leaked in GET response");
  assert.ok(!blob.includes(PUSH), "push webhook (a credential) leaked in GET response");
  assert.ok(!blob.includes("access_token"), "推送地址的 query 一个字符都不该出现");
});

await t("字段改名契约：secret.webhook_url → 对外 push_webhook_url（脱敏）", async () => {
  // 文件头「命名陷阱」：两个方向相反的东西同名一次就会把凭证当公开地址明文回显。
  // 这条断言把改名钉住 —— 对外的 `webhook_url` 必须是**入站**地址（此处查不到 = 空串）。
  state.secret = FULL();
  const r = await mod.apiGetDingtalkConfig();
  assert.equal(r.dingtalk.push_webhook_url, "****send");
  assert.equal(r.dingtalk.webhook_url, "", "对外 webhook_url 是入站地址，与推送凭证无关");
  assert.equal(r.dingtalk.dingtalk_webhook_url, undefined);
});

await t("secret 不存在 → 空表单（首次配置）", async () => {
  state.secret = null;
  const r = await mod.apiGetDingtalkConfig();
  assert.deepEqual(r.dingtalk, {
    app_key: "", app_secret: "", push_webhook_url: "",
    // 只读回带字段。没设 prefix（reset() 已删掉 env）→ 空串，界面退回「去 Outputs 里找」。
    webhook_url: "",
  });
});

/* ───────────────── PUT 合并语义 ───────────────── */
console.log("\nPUT — merge semantics");

await t("回传脱敏值 = 保持原值不变", async () => {
  // 真实场景：客户只想改 App Key，表单里两个密钥框都还是 GET 回来的 ****xxxx。
  state.secret = FULL();
  const r = await put({
    app_key: "dingzzzzzzzz9999",
    app_secret: "****WXYZ",
    push_webhook_url: "****send",
  });
  assert.ok(!r.error, r.error);
  assert.equal(state.secret.app_secret, FULL().app_secret);
  assert.equal(state.secret.webhook_url, PUSH, "推送地址没动过就不能被改掉");
  assert.equal(state.secret.app_key, "dingzzzzzzzz9999", "非敏感字段照常更新");
});

await t("回传新值 = 覆盖", async () => {
  state.secret = FULL();
  await put({
    app_key: FULL().app_key,
    app_secret: "brand-new-app-secret",
    push_webhook_url: "****send",
  });
  assert.equal(state.secret.app_secret, "brand-new-app-secret");
  assert.equal(state.secret.webhook_url, PUSH, "没改的那个仍保持原值");
});

await t("空串不当脱敏值处理（清掉推送地址仍是清掉）", async () => {
  // 客户撤掉自定义机器人时必须真的能清空，否则投递 Lambda 会继续往一个作废的群发报告。
  state.secret = FULL();
  await put({ app_key: FULL().app_key, app_secret: "****WXYZ", push_webhook_url: "" });
  assert.equal(state.secret.webhook_url, "", "empty string must not be treated as ****");
  assert.equal(state.secret.app_secret, FULL().app_secret);
});

await t("端到端往返：写进去，再 GET 回来是脱敏形态", async () => {
  state.secret = { app_key: "", app_secret: "", webhook_url: "" };
  await put({ app_key: "ding_example_appkey", app_secret: "e-1111-9999999999-KEYZ", push_webhook_url: PUSH });
  const r = await mod.apiGetDingtalkConfig();
  assert.equal(r.dingtalk.app_secret, "****KEYZ");
  assert.equal(r.dingtalk.push_webhook_url, "****send");
  assert.equal(state.secret.app_secret, "e-1111-9999999999-KEYZ", "secret 里落的是明文");
});

await t("表单外的字段不被这次保存抹掉（card_template_id / placeholder）", async () => {
  // Tier 2 卡片模板 id 是**可选**字段，不在这个表单里。⚠️ 当前版本它是**惰性的**：
  // 没有任何部署路径会写它（CDK 只 seed `app_key` / `app_secret`），也没有任何代码读它
  // （`shared/dingtalk_api.card_template_id()` 零调用点，钉钉进度走的是
  // `platforms/dingtalk/append_progress.py` 的追加式消息）。所以这条断言测的不是"抹掉会
  // 出 bug"，而是**保底口径**：这个 PUT 只许改表单里那几个字段，secret 里其它键（含以后
  // 真上 Tier 2 时人工填进去的模板 id、CDK 那个 `placeholder`）一律原样保留。
  state.secret = { ...FULL(), card_template_id: "tpl-xyz", placeholder: "created-by-cdk" };
  await put({ app_key: FULL().app_key, app_secret: "****WXYZ", push_webhook_url: "****send" });
  assert.equal(state.secret.card_template_id, "tpl-xyz");
  assert.equal(state.secret.placeholder, "created-by-cdk");
});

await t("secret 不存在 → PUT 走 CreateSecret", async () => {
  state.secret = null;
  const r = await put({ app_key: "ding_example_appkey", app_secret: "k", push_webhook_url: "" });
  assert.ok(!r.error, r.error);
  assert.equal(state.creates.length, 1, "must fall back to CreateSecret");
  assert.equal(state.updates.length, 0);
});

/* ───────────────── 校验 ───────────────── */
console.log("\nPUT — validation");

await t("platform 必须是 dingtalk（飞书那份的 body 不能落进这个 secret）", async () => {
  state.secret = FULL();
  const r = await mod.apiPutDingtalkConfig({ platform: "feishu", config: {} });
  assert.equal(r.status, 400);
  assert.equal(state.updates.length, 0);
});

await t("app_key 形状校验，且失败时不写 secret", async () => {
  state.secret = FULL();
  // 粘错整行（带 `:` / 空格）是最常见的输入错误。
  const r = await put({ app_key: "AppKey: ding_example_appkey", app_secret: "****WXYZ" });
  assert.equal(r.status, 400);
  assert.equal(state.updates.length, 0, "校验失败不能落盘");
});

await t("app_key 刻意宽松：非 ding 前缀的合法 key 不被误拒", async () => {
  // 钉钉的 AppKey 历史上有 `ding` / `suite` 前缀和纯随机串三种，官方没承诺过格式。
  // 误拒一个合法 key = 客户在界面上没有任何绕过手段，比放过一个错值贵得多。
  state.secret = FULL();
  const r = await put({ app_key: "suite_ABCdef0123456789", app_secret: "****WXYZ", push_webhook_url: "****send" });
  assert.ok(!r.error, r.error);
  assert.equal(state.secret.app_key, "suite_ABCdef0123456789");
});

await t("推送地址允许清单：拒非法 host / 非 https / 错路径，且不落盘", async () => {
  // 能往这里写任意 URL 的人，就能把调查报告全文外发到自己的服务器上
  //（投递 Lambda 会 POST 报告过去）。管理台有 nav:admin 门禁，但"管理员填错一个域名"
  // 与"报告被静默外发"之间不该只隔一层门禁。
  for (const bad of [
    "https://evil.example/robot/send?access_token=x",     // host 不对
    "http://oapi.dingtalk.com/robot/send?access_token=x",  // 不是 https
    "https://oapi.dingtalk.com/robot/sendv2?access_token=x", // 路径不对
    "https://oapi.dingtalk.com.evil.example/robot/send",   // 后缀伪装
    "not-a-url",
  ]) {
    state.secret = FULL(); state.updates = [];
    const r = await put({ app_key: FULL().app_key, app_secret: "****WXYZ", push_webhook_url: bad });
    assert.equal(r.status, 400, `should reject: ${bad}`);
    assert.equal(state.updates.length, 0, `must not persist: ${bad}`);
    assert.equal(state.secret.webhook_url, PUSH, "原来那个推送地址必须保持不变");
  }
});

await t("允许清单的报错**不回显**客户填的 URL", async () => {
  // 客户很可能是把一个**有效**的推送地址填错了位置（比如粘进了 App Secret 那个框、
  // 或者 host 打错一个字母）。错误响应会进浏览器控制台和前端日志 —— 那串地址本身就是
  // 凭证，不能出现在里面。只说要求是什么。
  state.secret = FULL();
  const leak = "https://evil.example/robot/send?access_token=SUPERSECRETTOKEN";
  const r = await put({ app_key: FULL().app_key, app_secret: "****WXYZ", push_webhook_url: leak });
  assert.equal(r.status, 400);
  assert.ok(!r.error.includes("SUPERSECRETTOKEN"), "错误里泄漏了 access_token");
  assert.ok(!r.error.includes("evil.example"), "错误里回显了客户填的 URL");
  assert.match(r.error, /oapi\.dingtalk\.com\/robot\/send/, "得告诉客户正确形态是什么");
});

/* ───────────────── 入站回调地址查找（抽屉第 3 步）───────────────── */
console.log("\nGET — inbound webhook url lookup");

// 抽屉里那串地址是客户唯一需要**手工搬运**到钉钉开放平台的东西。查不到的四种情形对客户
// 是同一件事：界面退回文字说明 —— 所以重点不是「查得到」，而是**查不到时不许抛**。
const API = (name, ep) => ({ Name: name, ApiId: name, ApiEndpoint: ep });
// API id 是**占位**。别贴真实部署的 webhook 地址进来：这个仓要外发，而 IM webhook
// 是公网未鉴权入口，贴真值等于把某个部署的入口发到公网上。
const EP = "https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com";

await t("按名字命中 → 回 ApiEndpoint 且补上结尾的 /", async () => {
  // 结尾那个 `/` 是契约：与 CfnOutput DingtalkWebhookUrl 一字不差（$default stage 不入路径）。
  // 钉钉保存这个地址时**不校验**，所以少一个字符不会有任何提示，只是机器人不回话。
  process.env.IM_INGRESS_API_NAME_PREFIX = "notiops-im-ingress-";
  agwState.pages = [[API("notiops-im-ingress-feishu", "https://other.example"),
                     API("notiops-im-ingress-dingtalk", EP)]];
  state.secret = FULL();
  const r = await mod.apiGetDingtalkConfig();
  assert.equal(r.dingtalk.webhook_url, `${EP}/`);
});

await t("不能错拿飞书那个入口（同前缀、只差平台后缀）", async () => {
  // 两个平台的 API 名只差后缀。拿错的后果最刁：钉钉照样发过去，飞书那个 ingress 验签
  // 失败返回 401，客户看到的仍然只是"机器人不回话"。
  process.env.IM_INGRESS_API_NAME_PREFIX = "notiops-im-ingress-";
  agwState.pages = [[API("notiops-im-ingress-feishu", EP)]];
  state.secret = FULL();
  const r = await mod.apiGetDingtalkConfig();
  assert.equal(r.dingtalk.webhook_url, "", "只装了飞书 → 钉钉这一项必须是空串");
});

await t("翻页后才命中（API 多于一页时不能只看第一页）", async () => {
  process.env.IM_INGRESS_API_NAME_PREFIX = "notiops-im-ingress-";
  agwState.pages = [
    [API("unrelated-api-1", "https://a.example")],
    [API("unrelated-api-2", "https://b.example")],
    [API("notiops-im-ingress-dingtalk", EP)],
  ];
  state.secret = FULL();
  const r = await mod.apiGetDingtalkConfig();
  assert.equal(r.dingtalk.webhook_url, `${EP}/`);
  assert.equal(agwState.calls.length, 3, "必须一直翻到命中为止");
});

await t("没设 env（只装了 web 的栈）→ 空串，且完全不调 GetApis", async () => {
  agwState.pages = [[API("notiops-im-ingress-dingtalk", EP)]];
  state.secret = FULL();
  const r = await mod.apiGetDingtalkConfig();
  assert.equal(r.dingtalk.webhook_url, "");
  assert.equal(agwState.calls.length, 0, "没装 IM 时不该白调一次 API Gateway");
});

await t("GetApis 抛异常（无权限）→ 空串，配置读取照常成功", async () => {
  process.env.IM_INGRESS_API_NAME_PREFIX = "notiops-im-ingress-";
  agwState.throws = Object.assign(new Error("nope"), { name: "AccessDeniedException" });
  state.secret = FULL();
  const r = await mod.apiGetDingtalkConfig();
  assert.equal(r.dingtalk.webhook_url, "");
  assert.equal(r.dingtalk.app_key, FULL().app_key, "地址查不到不能影响表单本身");
});

await t("入站 webhook_url 不脱敏 —— 它是公开入口地址，不是凭证", async () => {
  // 反向断言：万一有人照着旁边两个字段的样子给它套上 mask()，客户复制到的就是 ****...，
  // 而钉钉保存时不校验，这条路上没有任何报错会告诉他为什么机器人一直不回话。
  process.env.IM_INGRESS_API_NAME_PREFIX = "notiops-im-ingress-";
  agwState.pages = [[API("notiops-im-ingress-dingtalk", EP)]];
  state.secret = FULL();
  const r = await mod.apiGetDingtalkConfig();
  assert.ok(!r.dingtalk.webhook_url.includes("****"), "inbound webhook_url must not be masked");
});

await t("PUT 忽略只读的 webhook_url（不许覆盖推送凭证）", async () => {
  // 前端 GET 回来的对象里带着只读的 `webhook_url`（入站地址）。要是有人把整个对象原样
  // PUT 回来，而后端又把它写进 secret 的 `webhook_url` —— 那就是**用公开入口地址覆盖了
  // 推送凭证**，投递从此静默失败。字段改名（push_webhook_url）正是为了挡这个。
  state.secret = FULL();
  await put({ app_key: FULL().app_key, app_secret: "****WXYZ", push_webhook_url: "****send", webhook_url: `${EP}/` });
  assert.equal(state.secret.webhook_url, PUSH, "只读字段不能覆盖推送凭证");
});

/* ───────────────── POST /test（凭证校验，能推就顺手推一条）───────────────── */
console.log("\nPOST /test — credential check");

await t("platform 必须是 dingtalk", async () => {
  const r = await mod.apiTestDingtalkSend({ platform: "feishu" });
  assert.equal(r.status, 400);
});

await t("未配置凭证 → 明确说没配，且不发任何请求", async () => {
  state.secret = { app_key: "", app_secret: "", webhook_url: "" };
  const r = await test();
  assert.equal(r.success, false);
  assert.match(r.message, /not configured/i);
  assert.equal(fetchState.calls.length, 0, "凭证都没有就不该去调钉钉");
});

await t("凭证正确 + 没填推送地址 → 如实说「什么都没发」（不许静默降级）", async () => {
  // 钉钉**没有**"往任意群发测试消息"的接口。假装"已发送到你的群里"的代价是客户等一条
  // 永远不会来的消息，然后去查回调地址 —— 而那一步钉钉也不报错。
  state.secret = { ...FULL(), webhook_url: "" };
  const r = await test();
  assert.equal(r.success, true, "凭证有效就是成功（access token 是权威判据）");
  assert.match(r.message, /nothing was sent/i, "必须说清什么都没发");
  assert.match(r.message, /@-mention/i, "必须给出端到端验证的替代动作");
  assert.equal(fetchState.calls.length, 1, "只换了一次 token");
  assert.match(fetchState.calls[0].url, /\/v1\.0\/oauth2\/accessToken$/);
  assert.deepEqual(JSON.parse(fetchState.calls[0].init.body), {
    appKey: FULL().app_key, appSecret: FULL().app_secret,
  });
});

await t("凭证错误 → 回钉钉自己的 errcode，且不去碰推送地址", async () => {
  state.secret = FULL();
  fetchState.tokenBody = { code: "Forbidden.AccessTokenInvalid", message: "appSecret is invalid" };
  const r = await test();
  assert.equal(r.success, false);
  assert.match(r.message, /credential check failed/i);
  assert.match(r.message, /AccessTokenInvalid/);
  assert.equal(fetchState.calls.length, 1, "换 token 失败就不该继续往群里发");
});

await t("凭证正确 + 推送成功 → 明说真发了一条", async () => {
  state.secret = FULL();
  const r = await test();
  assert.equal(r.success, true);
  assert.match(r.message, /pushed/i);
  assert.equal(fetchState.calls.length, 2);
  assert.equal(fetchState.calls[1].url, PUSH);
  const sent = JSON.parse(fetchState.calls[1].init.body);
  assert.equal(sent.msgtype, "markdown", "自定义机器人只吃固定的几种 msgtype");
  assert.ok(sent.markdown.title && sent.markdown.text);
});

await t("推送被钉钉拒（加签/关键词）→ 区分「凭证有效」与「推送失败」", async () => {
  // 这两件事的修法完全不同（一个回第 2 步、一个回第 7 步），合成一句"失败"会让客户
  // 把已经对的凭证再删一遍重填。
  state.secret = FULL();
  fetchState.pushBody = { errcode: 300005, errmsg: "keywords not in content" };
  const r = await test();
  assert.equal(r.success, false);
  assert.match(r.message, /Credentials are valid/);
  assert.match(r.message, /300005/);
});

await t("推送请求本身抛异常 → 不崩，只报异常类型名", async () => {
  state.secret = FULL();
  fetchState.throwOn = "oapi.dingtalk.com";
  const r = await test();
  assert.equal(r.success, false);
  assert.match(r.message, /Credentials are valid/);
  assert.match(r.message, /TypeError/, "只记异常类型名，不记原始报文");
});

await t("/test 的任何一条消息里都不含推送地址或 app_secret", async () => {
  // 这些消息直接画在管理台上、也会进前端日志。推送地址本身就是凭证。
  state.secret = FULL();
  const msgs = [];
  msgs.push((await test()).message);
  fetchState.pushBody = { errcode: 300001, errmsg: "token is not exist" };
  msgs.push((await test()).message);
  fetchState.throwOn = "oapi.dingtalk.com";
  msgs.push((await test()).message);
  fetchState.tokenBody = { code: "Forbidden", message: "nope" };
  msgs.push((await test()).message);
  for (const m of msgs) {
    assert.ok(!m.includes(PUSH), `push webhook leaked: ${m}`);
    assert.ok(!m.includes("access_token"), `push webhook query leaked: ${m}`);
    assert.ok(!m.includes(FULL().app_secret), `app_secret leaked: ${m}`);
  }
});

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
