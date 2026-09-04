/**
 * 角色权限保存的入口校验（的写入侧）。
 *
 * 守的是：会顺带吞掉 `nav:admin` 的通配（`nav:*`）在保存时就被拒。判定侧已由
 * `satisfiesAdmin()` 堵住（见 authz.test.mjs 的权限矩阵），入口侧再拦一层是为了不让
 * 角色定义里躺着一条看起来给了 admin 的 `nav:*` —— 静默存下来，下一个读它的人只能靠猜。
 *
 * ⚠️ 密闭性：`apiSaveRole()` 一旦通过校验就会去写 DynamoDB。所以这里把 DDB endpoint
 * 钉在一个必然拒连的本地端口（**必须在 import admin.mjs 之前设**，客户端在模块加载时
 * 就构造好了）。这样即使守卫被改坏、用例意外走到写库路径，也只会在 ~10ms 内本地
 * ECONNREFUSED，绝不会碰到真实 AWS —— 之前用真凭证跑这个文件时就打出去过一次请求。
 * 通配规则本身另有对纯函数 `adminSwallowingWildcards()` 的直接断言，不依赖写库路径。
 */
process.env.AWS_ENDPOINT_URL_DYNAMODB = "http://127.0.0.1:1";
process.env.AWS_REGION ||= "us-east-1";
process.env.AWS_ACCESS_KEY_ID ||= "test";
process.env.AWS_SECRET_ACCESS_KEY ||= "test";
process.env.AWS_MAX_ATTEMPTS = "1";

const { apiSaveRole, adminSwallowingWildcards } = await import("../admin.mjs");

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`XX ${name}`); } }

/* ── 规则本身（纯函数，不碰任何 IO）── */
const swallows = (perms) => adminSwallowingWildcards(perms);
ok("nav:* is flagged", JSON.stringify(swallows(["nav:*"])) === JSON.stringify(["nav:*"]));
ok("nav:* is flagged among legitimate keys",
  JSON.stringify(swallows(["nav:chat", "nav:finops:*", "nav:*"])) === JSON.stringify(["nav:*"]));
ok("* is NOT flagged (that is the intended admin grant)", swallows(["*"]).length === 0);
ok("explicit nav:admin is NOT flagged", swallows(["nav:admin"]).length === 0);
ok("explicit nav:admin:* is NOT flagged", swallows(["nav:admin:*"]).length === 0);
ok("action:* is NOT flagged (does not cover nav:admin)", swallows(["action:*"]).length === 0);
ok("nav:finops:* is NOT flagged", swallows(["nav:finops:*"]).length === 0);
ok("nav:cases:* is NOT flagged", swallows(["nav:cases:*"]).length === 0);
ok("empty / junk input does not throw",
  swallows([]).length === 0 && swallows(null).length === 0 && swallows([null, 42]).length === 0);

/* ── 已接进保存路径（这些用例都在写库之前就返回）── */
async function rejects(name, roleName, perms, expectedError) {
  let r;
  try {
    r = await apiSaveRole(roleName, perms);
  } catch (e) {
    // 走到这里说明校验没拦住、请求继续去写库了（endpoint 被钉在死端口，所以是
    // ECONNREFUSED 而不是真的落库）。这本身就是断言失败，报清楚而不是崩栈。
    ok(`${name} → ${expectedError}`, false);
    console.log(`   guard did not stop the write; reached the store: ${e?.code || e?.name || e}`);
    return { body: {} };
  }
  const good = r.status === 400 && r.body?.error === expectedError;
  ok(`${name} → ${expectedError}`, good);
  if (!good) console.log(`   got ${r.status}/${r.body?.error}`);
  return r;
}

const navStar = await rejects("nav:* alone", "role:test", ["nav:*"], "wildcard_would_grant_admin");
ok("the offending pattern is named back to the caller",
  JSON.stringify(navStar.body?.keys) === JSON.stringify(["nav:*"]));
ok("the error hints at role:admin instead", /role:admin/.test(navStar.body?.hint || ""));
await rejects("nav:* mixed with legitimate keys", "role:test",
  ["nav:chat", "nav:finops:*", "nav:*"], "wildcard_would_grant_admin");

/* ── 既有校验不得被新规则挤掉，也不得被它误伤 ──
 * 用一个不存在的 key 让这些请求停在 unknown_permission_keys：既证明既有校验还在，
 * 也证明 action:* / nav:finops:* 没被误判成提权通配。 */
await rejects("action:* is not treated as an admin wildcard", "role:test",
  ["action:*", "nav:does-not-exist"], "unknown_permission_keys");
await rejects("nav:finops:* is not treated as an admin wildcard", "role:test",
  ["nav:finops:*", "nav:does-not-exist"], "unknown_permission_keys");
await rejects("unknown key still rejected", "role:test", ["nav:nope"], "unknown_permission_keys");
await rejects("role:admin stays immutable", "role:admin", ["nav:chat"], "cannot_modify_admin_role");
await rejects("bad role name still rejected", "bad name!", ["nav:chat"], "invalid_role_name");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
