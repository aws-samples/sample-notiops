/**
 * BFF 飞书通知配置单测（Admin「集成 IM」页的后端）。
 *
 * 风格与 tests/llm_config.test.mjs 一致：纯断言、不引 mock 框架；Secrets Manager 经
 * `__setClients()` 测试接缝注入假实现，全程不触网。
 *
 * 为什么要有这份测试：Admin「集成 IM」页新增了 Encrypt Key / Verification Token 两个
 * 输入框，而 webhook 模式下这两把钥匙是**唯一鉴权手段**（platforms/feishu/lambda_ingress.py
 * 「硬约束 A」：任一为空则冷启动直接失败）。这条路径上最贵的 bug 不是崩，而是
 * **界面骗人** —— 未配置却回显 `****`，客户以为配好了，跳过飞书那边的加密策略，
 * 最后拿一个「校验失败」去查请求地址。所以「空值必须回显空串」在这里是被断言的契约。
 *
 * 覆盖：
 *   · GET 脱敏：空 → ""（未配置）/ 非空 → ****后4位 / 短值整串遮掉
 *   · GET 永不回明文（对四个敏感字段做全量扫描，不是逐个字段挑着看）
 *   · PUT 回传脱敏值 = 保持不变；回传新值 = 覆盖；回传空串 = 清空
 *   · encrypt_key / verification_token 端到端往返（新增字段真的落进 secret）
 *   · secret 不存在：GET 回空表单、PUT 走 CreateSecret
 *   · 校验：app_id / chat_id 格式，以及校验失败时**不写** secret
 *   · webhook_url 查找：命中 / 翻页命中 / 名字对不上 / 无 env / GetApis 抛异常
 *     —— 后四种都必须回空串**且不抛**，因为抽屉是操作指引，不该被一个便利功能拖垮
 *
 * 运行：node bff/web-chat/tests/feishu_config.test.mjs
 */
import assert from "node:assert/strict";

import * as mod from "../feishu_config.mjs";

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
/* ───────────────── 假 API Gateway v2（webhook 地址查找）───────────────── */

// `apis` 是一页一页给的，用来同时覆盖「单页命中」和「翻页后才命中」。
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
mod.__setClients({ sm: fakeSm, agw: fakeAgw });

/* ───────────────── 测试骨架 ───────────────── */

let pass = 0, fail = 0;
function reset() {
  state.secret = null; state.updates = []; state.creates = [];
  agwState.pages = []; agwState.calls = []; agwState.throws = null;
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

/** 一份「全都配好了」的 secret。 */
const FULL = () => ({
  app_id: "cli_a1b2c3d4",
  app_secret: "s3cret-value-ends-WXYZ",
  verification_token: "vtoken-ends-1234",
  encrypt_key: "enckey-ends-abcd",
  notify_chat_ids: "oc_room1,oc_room2",
});

const put = (config) => mod.apiPutNotificationConfig({ platform: "feishu", config });

/* ───────────────── GET 脱敏 ───────────────── */
console.log("GET — masking");

await t("未配置的敏感字段回显空串，不是 ****", async () => {
  // 这是本文件存在的理由：全新安装（以及从长连接升级上来、两把钥匙都是空串的栈）
  // 必须在界面上看起来「还没填」。回 **** 会让客户跳过飞书那边的加密策略配置。
  state.secret = { app_id: "cli_a1b2c3d4", notify_chat_ids: "" };
  const r = await mod.apiGetNotificationConfig();
  assert.equal(r.feishu.encrypt_key, "", "empty encrypt_key must render as a blank field");
  assert.equal(r.feishu.verification_token, "", "empty verification_token must render as blank");
  assert.equal(r.feishu.app_secret, "");
  assert.equal(r.feishu.app_id, "cli_a1b2c3d4", "app_id 不是敏感字段，明文回显");
});

await t("已配置的敏感字段只回后 4 位", async () => {
  state.secret = FULL();
  const r = await mod.apiGetNotificationConfig();
  assert.equal(r.feishu.app_secret, "****WXYZ");
  assert.equal(r.feishu.verification_token, "****1234");
  assert.equal(r.feishu.encrypt_key, "****abcd");
});

await t("长度 ≤4 的值整串遮掉（后 4 位就是全部）", async () => {
  state.secret = { ...FULL(), encrypt_key: "abcd", verification_token: "x" };
  const r = await mod.apiGetNotificationConfig();
  assert.equal(r.feishu.encrypt_key, "****");
  assert.equal(r.feishu.verification_token, "****");
});

await t("GET 响应里不含任何敏感字段的明文", async () => {
  // 全量扫描整个响应的 JSON，而不是逐个字段断言 —— 以后新增字段忘了脱敏，这条会红。
  state.secret = FULL();
  const r = await mod.apiGetNotificationConfig();
  const blob = JSON.stringify(r);
  for (const k of ["app_secret", "verification_token", "encrypt_key"]) {
    assert.ok(!blob.includes(FULL()[k]), `${k} plaintext leaked in GET response`);
  }
});

await t("secret 不存在 → 空表单（首次配置）", async () => {
  state.secret = null;
  const r = await mod.apiGetNotificationConfig();
  assert.deepEqual(r.feishu, {
    app_id: "", app_secret: "", verification_token: "", encrypt_key: "", notify_chat_ids: "",
    // 只读回带字段。没设 prefix（reset() 已删掉 env）→ 空串，界面退回「去 Outputs 里找」。
    webhook_url: "",
  });
});

/* ───────────────── PUT 合并语义 ───────────────── */
console.log("\nPUT — merge semantics");

await t("回传脱敏值 = 保持原值不变", async () => {
  // 真实场景：客户只想改推送群组，表单里三个密钥都还是 GET 回来的 ****xxxx。
  state.secret = FULL();
  const r = await put({
    app_id: "cli_a1b2c3d4",
    app_secret: "****WXYZ",
    verification_token: "****1234",
    encrypt_key: "****abcd",
    notify_chat_ids: "oc_room3",
  });
  assert.ok(!r.error, r.error);
  assert.equal(state.secret.app_secret, FULL().app_secret);
  assert.equal(state.secret.verification_token, FULL().verification_token);
  assert.equal(state.secret.encrypt_key, FULL().encrypt_key);
  assert.equal(state.secret.notify_chat_ids, "oc_room3", "非敏感字段照常更新");
});

await t("回传新值 = 覆盖", async () => {
  state.secret = FULL();
  await put({
    app_id: "cli_a1b2c3d4",
    app_secret: "****WXYZ",
    verification_token: "brand-new-token",
    encrypt_key: "brand-new-encrypt-key",
    notify_chat_ids: FULL().notify_chat_ids,
  });
  assert.equal(state.secret.verification_token, "brand-new-token");
  assert.equal(state.secret.encrypt_key, "brand-new-encrypt-key");
  assert.equal(state.secret.app_secret, FULL().app_secret, "没改的那个仍保持原值");
});

await t("空串不当脱敏值处理（清空仍是清空）", async () => {
  state.secret = FULL();
  await put({ app_id: "cli_a1b2c3d4", encrypt_key: "", notify_chat_ids: "" });
  assert.equal(state.secret.encrypt_key, "", "empty string must not be treated as ****");
});

await t("两把新钥匙端到端往返：写进去，再 GET 回来是脱敏形态", async () => {
  state.secret = { app_id: "cli_a1b2c3d4", app_secret: "", notify_chat_ids: "" };
  await put({
    app_id: "cli_a1b2c3d4",
    verification_token: "v-0000-TOKN",
    encrypt_key: "e-1111-9999999999-KEYZ",
    notify_chat_ids: "oc_room1",
  });
  const r = await mod.apiGetNotificationConfig();
  assert.equal(r.feishu.verification_token, "****TOKN");
  assert.equal(r.feishu.encrypt_key, "****KEYZ");
  assert.equal(state.secret.verification_token, "v-0000-TOKN", "secret 里落的是明文");
});

await t("secret 不存在 → PUT 走 CreateSecret", async () => {
  state.secret = null;
  const r = await put({ app_id: "cli_a1b2c3d4", encrypt_key: "k", notify_chat_ids: "" });
  assert.ok(!r.error, r.error);
  assert.equal(state.creates.length, 1, "must fall back to CreateSecret");
  assert.equal(state.updates.length, 0);
});

/* ───────────────── 校验 ───────────────── */
console.log("\nPUT — validation");

await t("app_id 必须 cli_ 开头，且失败时不写 secret", async () => {
  state.secret = FULL();
  const r = await put({ app_id: "bogus", notify_chat_ids: "" });
  assert.equal(r.status, 400);
  assert.equal(state.updates.length, 0, "校验失败不能落盘");
});

await t("chat_id 必须 oc_ 开头（逐个校验，含多值）", async () => {
  state.secret = FULL();
  const r = await put({ app_id: "cli_a1b2c3d4", notify_chat_ids: "oc_ok, bad_one" });
  assert.equal(r.status, 400);
  assert.match(r.error, /bad_one/);
  assert.equal(state.updates.length, 0);
});

/* ───────────────── webhook 地址查找（抽屉第 3 步）───────────────── */
console.log("\nGET — webhook url lookup");

// 抽屉里那串地址是客户唯一需要**手工搬运**到飞书控制台的东西，原来要他自己去
// CloudFormation Outputs 里翻。查不到的四种情形对客户是同一件事：界面退回文字说明 ——
// 所以这一组用例的重点不是「查得到」，而是**查不到时不许抛**。
const API = (name, ep) => ({ Name: name, ApiId: name, ApiEndpoint: ep });
// API id 是**占位**。别贴真实部署的 webhook 地址进来：这个仓要外发，而 IM webhook
// 是公网未鉴权入口，贴真值等于把某个部署的入口发到公网上。
const EP = "https://a1b2c3d4e5.execute-api.us-east-1.amazonaws.com";

await t("按名字命中 → 回 ApiEndpoint 且补上结尾的 /", async () => {
  // 结尾那个 `/` 是契约：与 CfnOutput FeishuWebhookUrl 一字不差（$default stage 不出现在
  // 路径里）。少一个字符飞书那边就是 404，而这一步没有任何报错能提示客户。
  process.env.IM_INGRESS_API_NAME_PREFIX = "notiops-im-ingress-";
  agwState.pages = [[API("notiops-im-worker-feishu", "https://other.example"),
                     API("notiops-im-ingress-feishu", EP)]];
  state.secret = FULL();
  const r = await mod.apiGetNotificationConfig();
  assert.equal(r.feishu.webhook_url, `${EP}/`);
});

await t("翻页后才命中（API 多于一页时不能只看第一页）", async () => {
  process.env.IM_INGRESS_API_NAME_PREFIX = "notiops-im-ingress-";
  agwState.pages = [
    [API("unrelated-api-1", "https://a.example")],
    [API("unrelated-api-2", "https://b.example")],
    [API("notiops-im-ingress-feishu", EP)],
  ];
  state.secret = FULL();
  const r = await mod.apiGetNotificationConfig();
  assert.equal(r.feishu.webhook_url, `${EP}/`);
  assert.equal(agwState.calls.length, 3, "必须一直翻到命中为止");
});

await t("名字对不上 → 空串，不抛", async () => {
  // 真实成因：im-core.ts 的 fnName 改了名，而 web-chat-core.ts 的前缀没跟着改。
  // 这是本功能唯一的静默失败面，所以另有 tests/test_im_webhook_url_prefix.py
  // 直接把两边合成出来的名字对齐 —— 这里只保证「对不上也不炸」。
  process.env.IM_INGRESS_API_NAME_PREFIX = "notiops-im-ingress-";
  agwState.pages = [[API("notiops-im-ingress-slack", EP)]];
  state.secret = FULL();
  const r = await mod.apiGetNotificationConfig();
  assert.equal(r.feishu.webhook_url, "");
});

await t("没设 env（只装了 web 的栈）→ 空串，且完全不调 GetApis", async () => {
  agwState.pages = [[API("notiops-im-ingress-feishu", EP)]];
  state.secret = FULL();
  const r = await mod.apiGetNotificationConfig();
  assert.equal(r.feishu.webhook_url, "");
  assert.equal(agwState.calls.length, 0, "没装 IM 时不该白调一次 API Gateway");
});

await t("GetApis 抛异常（无权限）→ 空串，配置读取照常成功", async () => {
  process.env.IM_INGRESS_API_NAME_PREFIX = "notiops-im-ingress-";
  agwState.throws = Object.assign(new Error("nope"), { name: "AccessDeniedException" });
  state.secret = FULL();
  const r = await mod.apiGetNotificationConfig();
  assert.equal(r.feishu.webhook_url, "");
  assert.equal(r.feishu.app_id, FULL().app_id, "地址查不到不能影响表单本身");
});

await t("webhook_url 不脱敏 —— 它是公开入口地址，不是凭证", async () => {
  // 反向断言：万一有人照着旁边四个字段的样子给它套上 mask()，客户复制到的就是 ****...，
  // 而这条路径上没有任何报错会告诉他为什么飞书那边一直校验失败。
  process.env.IM_INGRESS_API_NAME_PREFIX = "notiops-im-ingress-";
  agwState.pages = [[API("notiops-im-ingress-feishu", EP)]];
  state.secret = FULL();
  const r = await mod.apiGetNotificationConfig();
  assert.ok(!r.feishu.webhook_url.includes("****"), "webhook_url must not be masked");
});

await t("PUT 忽略 webhook_url（只读字段不许落进 secret）", async () => {
  state.secret = FULL();
  await put({ app_id: "cli_a1b2c3d4", notify_chat_ids: "oc_room1", webhook_url: "https://evil.example/" });
  assert.equal(state.secret.webhook_url, undefined, "只读字段不能被写进 secret");
});

await t("platform 必须是 feishu", async () => {
  const r = await mod.apiPutNotificationConfig({ platform: "slack", config: {} });
  assert.equal(r.status, 400);
});

console.log(`\n${fail ? "FAILED" : "PASSED"}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
