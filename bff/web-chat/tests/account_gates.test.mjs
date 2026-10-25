/**
 * 待办 #38 ⑤⑥⑦：BFF 三处账号 / 分页的小缺口（2026-10-22 通读发现、只读核实过）。
 * 运行：node bff/web-chat/tests/account_gates.test.mjs
 *
 *   ⑤ 停用的成员账号仍能被看板查询：`xacct.mjs::credsFor` 只看 role_arn、不看 enabled ——
 *      账号下拉里它已经消失了（accounts.mjs 只列 enabled），但接口带上它的 id 照样 AssumeRole 进去；
 *   ⑥ org 模式下 payer 成本角色那条路被跳过：`devops_agent_accounts.mjs` 只读 LOCKED_ACCOUNT_ID，
 *      而 org 模式下它被故意置空；
 *   ⑦ Deep Dive 读保存查询不翻页：ListNamedQueries 只看第一页（50 条）。
 * 全部用 SDK 原型打桩跑真代码，不碰 AWS。
 */
import assert from "node:assert/strict";

process.env.DEPLOY_ACCOUNT_ID = "111111111111";
process.env.LOCKED_ACCOUNT_ID = "";          // org 模式：故意置空

let fails = 0;
let ok = 0;
async function t(name, fn) {
  try { await fn(); ok++; console.log(`  ok   ${name}`); }
  catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e?.message}`); }
}

const { STSClient } = await import("@aws-sdk/client-sts");
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { AthenaClient } = await import("@aws-sdk/client-athena");
const { OrganizationsClient } = await import("@aws-sdk/client-organizations");

let row = null;
const assumed = [];
STSClient.prototype.send = async function (cmd) {
  const n = cmd.constructor.name;
  if (n === "GetCallerIdentityCommand") return { Account: "111111111111" };
  if (n === "AssumeRoleCommand") {
    assumed.push(cmd.input.RoleArn);
    return { Credentials: { AccessKeyId: "AK", SecretAccessKey: "SK", SessionToken: "ST", Expiration: new Date(Date.now() + 3600e3) } };
  }
  throw new Error(`unexpected STS ${n}`);
};
DynamoDBDocumentClient.prototype.send = async function (cmd) {
  if (cmd.constructor.name === "GetCommand") return { Item: row || undefined };
  throw new Error(`unexpected DDB ${cmd.constructor.name}`);
};

const { credsFor } = await import("../xacct.mjs");

await t("⑤ 停用（enabled=false）的成员账号：拒绝，不 AssumeRole", async () => {
  row = { PK: "account#222222222222", SK: "meta", enabled: false, role_arn: "arn:aws:iam::222222222222:role/notiops-cross-account-role-111111111111" };
  assumed.length = 0;
  await assert.rejects(() => credsFor("222222222222"), (e) => e.code === "cross_account_unavailable" && /disabled/.test(e.message));
  assert.equal(assumed.length, 0);
});

await t("⑤ 没有 enabled 字段的行同样拒绝（界面上它也按停用显示：member_accounts.mjs 的 enabled === true）", async () => {
  row = { PK: "account#222222222222", SK: "meta", role_arn: "arn:aws:iam::222222222222:role/notiops-cross-account-role-111111111111" };
  await assert.rejects(() => credsFor("222222222222"), (e) => e.code === "cross_account_unavailable");
});

await t("⑤ 启用的账号照常；Admin 接入流程的 allowDisabled 放行；部署账号自身不走跨账号", async () => {
  row = { PK: "account#333333333333", SK: "meta", enabled: true, role_arn: "arn:aws:iam::333333333333:role/notiops-cross-account-role-111111111111" };
  assumed.length = 0;
  assert.ok(await credsFor("333333333333"));
  assert.equal(assumed[0], row.role_arn);
  row = { ...row, enabled: false };
  assert.ok(await credsFor("333333333333", { allowDisabled: true }));
  assert.equal(await credsFor("111111111111"), null);
  assert.equal(await credsFor(""), null);
});

// ── ⑥ ──
let master = "999999999999";
OrganizationsClient.prototype.send = async () => ({ Organization: { MasterAccountId: master } });
const { findPayerAccount } = await import("../devops_agent_accounts.mjs");

await t("⑥ org 模式（LOCKED_ACCOUNT_ID 为空）部署在成员账号里：照样按 DEPLOY_ACCOUNT_ID 拼出 payer 的成本角色", async () => {
  master = "999999999999";
  const p = await findPayerAccount();
  assert.deepEqual(p, {
    accountId: "999999999999",
    roleArn: "arn:aws:iam::999999999999:role/DevOpsAgentRole-AgentSpace-notiOps-111111111111",
    isPayer: true, assumable: true, source: "organizations",
  });
});

await t("⑥ 部署账号就是管理账号（现网就是这种）→ null，走本账号 CE 视角", async () => {
  master = "111111111111";
  assert.equal(await findPayerAccount(), null);
});

// ── ⑦ ──
const { findNamedQuery } = await import("../finops.mjs");
function athenaPages(pages) {
  AthenaClient.prototype.send = async function (cmd) {
    const n = cmd.constructor.name;
    if (n === "ListNamedQueriesCommand") {
      const i = cmd.input.NextToken ? Number(cmd.input.NextToken) : 0;
      return { NamedQueryIds: pages[i] || [], NextToken: i + 1 < pages.length ? String(i + 1) : undefined };
    }
    if (n === "BatchGetNamedQueryCommand") {
      assert.ok(cmd.input.NamedQueryIds.length <= 50, "BatchGetNamedQuery 一次最多 50 个 id");
      return { NamedQueries: cmd.input.NamedQueryIds.map((id) => ({ NamedQueryId: id, Name: `q-${id}`, QueryString: "select 1", Database: "d" })) };
    }
    throw new Error(`unexpected Athena ${n}`);
  };
}

await t("⑦ 目标查询在第二页：翻页找到（以前只看第一页 → named_query_not_found）", async () => {
  const p1 = Array.from({ length: 50 }, (_, i) => `a${i}`);
  athenaPages([p1, ["b0", "target"]]);
  const r = await findNamedQuery("q-target");
  assert.equal(r.any, true);
  assert.equal(r.nq?.NamedQueryId, "target");
});

await t("⑦ 一个都没有 → any=false；有但没这个 → any=true、nq=null", async () => {
  athenaPages([[]]);
  assert.deepEqual(await findNamedQuery("q-x"), { nq: null, any: false });
  athenaPages([["a"], ["b"]]);
  assert.deepEqual(await findNamedQuery("q-x"), { nq: null, any: true });
});

await t("⑦ 最多翻 20 页（防一个异常工作组把看板请求拖到超时）", async () => {
  let listCalls = 0;
  AthenaClient.prototype.send = async function (cmd) {
    if (cmd.constructor.name === "ListNamedQueriesCommand") { listCalls++; return { NamedQueryIds: ["x"], NextToken: "more" }; }
    return { NamedQueries: [{ NamedQueryId: "x", Name: "other" }] };
  };
  const r = await findNamedQuery("q-x");
  assert.equal(r.nq, null);
  assert.equal(listCalls, 20);
});

console.log(`\n${ok} passed, ${fails} failed`);
if (fails) process.exit(1);
