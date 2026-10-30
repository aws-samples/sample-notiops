/**
 * 忘记密码 / 重置密码的服务端部分（passwords.mjs）+ 新建用户邮箱必填（admin.mjs::apiCreateUser）单测（2026-10-30）。
 * 运行：node bff/web-chat/tests/passwords.test.mjs
 *
 * Cognito 客户端用假的 `{ send }` 注入（按命令类名分派），不碰网络。
 */
process.env.COGNITO_USER_POOL_ID = "us-east-1_TESTPOOL";
const { validEmail, genTempPassword, apiResetUserPassword, apiSetUserEmail, emailUsedBy } = await import("../passwords.mjs");
const { apiCreateUser } = await import("../admin.mjs");
const { authorize } = await import("../authz.mjs");

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`XX ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`XX ${name}`); } }

/** 假 Cognito：users = 已存在的用户名；emails = 用户名 → 邮箱（ListUsers 按邮箱过滤，不分大小写，与真 Cognito 一致）；
 *  aliases = 已被占用的邮箱别名；fail = 哪些命令要抛哪个错。 */
function fakeCognito({ users = ["alice", "bob"], emails = {}, aliases = [], fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      if (fail[name]) throw Object.assign(new Error(fail[name]), { name: fail[name] });
      if (name === "ListUsersCommand") {
        const m = /^email = "(.*)"$/.exec(cmd.input.Filter || "");
        const want = (m?.[1] || "").toLowerCase();
        return { Users: Object.entries(emails).filter(([, e]) => e.toLowerCase() === want).map(([u]) => ({ Username: u })) };
      }
      const exists = users.includes(cmd.input.Username);
      const emailOf = (attrs) => (attrs || []).find((a) => a.Name === "email")?.Value;
      if (name === "AdminSetUserPasswordCommand" || name === "AdminUserGlobalSignOutCommand") {
        if (!exists) throw Object.assign(new Error("nf"), { name: "UserNotFoundException" });
        return {};
      }
      if (name === "AdminUpdateUserAttributesCommand") {
        if (!exists) throw Object.assign(new Error("nf"), { name: "UserNotFoundException" });
        if (aliases.includes(emailOf(cmd.input.UserAttributes))) throw Object.assign(new Error("alias"), { name: "AliasExistsException" });
        return {};
      }
      if (name === "AdminCreateUserCommand") {
        if (exists) throw Object.assign(new Error("exists"), { name: "UsernameExistsException" });
        if (aliases.includes(emailOf(cmd.input.UserAttributes))) throw Object.assign(new Error("alias"), { name: "AliasExistsException" });
        return { User: { Username: cmd.input.Username } };
      }
      throw new Error(`unexpected command ${name}`);
    },
  };
}
const named = (c, name) => c.calls.filter((x) => x.name === name);

/** 截住 console.log / console.error，看审计行里有什么。 */
async function captureLogs(fn) {
  const lines = [];
  const [log, err] = [console.log, console.error];
  console.log = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  try { return { result: await fn(), lines }; } finally { console.log = log; console.error = err; }
}

/* ── 邮箱格式、临时密码符合密码策略 ── */
ok("plain email ok", validEmail("alice@example.com"));
ok("trimmed email ok", validEmail("  alice@example.com "));
ok("no @ rejected", !validEmail("alice.example.com"));
ok("no dot in domain rejected", !validEmail("alice@example"));
ok("space rejected", !validEmail("ali ce@example.com"));
ok("empty rejected", !validEmail(""));
ok("non-string rejected", !validEmail(undefined));
ok("too long rejected", !validEmail(`${"a".repeat(250)}@x.io`));
ok("quote rejected (goes into the ListUsers filter)", !validEmail('a"b@example.com'));
ok("backslash rejected", !validEmail("a\\b@example.com"));
for (let i = 0; i < 20; i++) {
  const p = genTempPassword();
  if (!(p.length >= 8 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p))) { fail++; console.log(`XX temp password breaks policy: ${p}`); break; }
  if (i === 19) pass++;
}
ok("temp passwords differ", genTempPassword() !== genTempPassword());

/* ── 管理员替人重置密码 ── */
{
  const c = fakeCognito();
  const { result: r, lines } = await captureLogs(() =>
    apiResetUserPassword("bob", { username: "alice", ip: "10.0.0.1" }, { client: c, gen: () => "Aa1TEMPPASSWORD" }));
  eq("reset → 200 + temp password returned once", r, { status: 200, body: { username: "bob", tempPassword: "Aa1TEMPPASSWORD", signedOut: true } });
  const set = named(c, "AdminSetUserPasswordCommand");
  eq("temporary, not permanent (next sign-in must change it)", set.map((x) => [x.input.Username, x.input.Password, x.input.Permanent]),
     [["bob", "Aa1TEMPPASSWORD", false]]);
  eq("pool id from env", set[0].input.UserPoolId, "us-east-1_TESTPOOL");
  eq("all their sessions signed out", named(c, "AdminUserGlobalSignOutCommand").map((x) => x.input.Username), ["bob"]);
  const audit = lines.find((l) => l.includes('"audit":"password_reset"'));
  ok("audit line written", !!audit && audit.includes('"target":"bob"') && audit.includes('"by":"alice"') && audit.includes("10.0.0.1"));
  ok("audit line never contains the password", !lines.some((l) => l.includes("Aa1TEMPPASSWORD")));
}
{
  const c = fakeCognito();
  eq("cannot reset yourself", await apiResetUserPassword("alice", { username: "alice" }, { client: c }), { status: 409, body: { error: "cannot_reset_self" } });
  eq("…and nothing was sent", c.calls.length, 0);
  eq("unknown user → 404", await apiResetUserPassword("carol", { username: "alice" }, { client: c }), { status: 404, body: { error: "user_not_found" } });
  eq("…and no sign-out attempted", named(c, "AdminUserGlobalSignOutCommand").length, 0);
  eq("bad username → 400", await apiResetUserPassword("a/b", { username: "alice" }, { client: c }), { status: 400, body: { error: "invalid_username" } });
}
{
  const c = fakeCognito({ fail: { AdminUserGlobalSignOutCommand: "TooManyRequestsException" } });
  const { result: r } = await captureLogs(() => apiResetUserPassword("bob", { username: "alice" }, { client: c, gen: () => "Aa1X" }));
  eq("sign-out failure is reported, password still reset", [r.status, r.body.signedOut, r.body.tempPassword], [200, false, "Aa1X"]);
}
{
  const c = fakeCognito({ fail: { AdminSetUserPasswordCommand: "InvalidPasswordException" } });
  eq("Cognito rejects the password → 400 with its code", await apiResetUserPassword("bob", {}, { client: c }), { status: 400, body: { error: "InvalidPasswordException" } });
}

/* ── 管理员给用户设邮箱（直接标已验证）── */
{
  const c = fakeCognito();
  const { result: r, lines } = await captureLogs(() => apiSetUserEmail("bob", " bob@example.com ", { username: "alice" }, { client: c }));
  eq("set email → 200", r, { status: 200, body: { username: "bob", email: "bob@example.com", emailVerified: true } });
  eq("email + email_verified=true in one request (no code sent)",
     named(c, "AdminUpdateUserAttributesCommand")[0].input.UserAttributes,
     [{ Name: "email", Value: "bob@example.com" }, { Name: "email_verified", Value: "true" }]);
  ok("audit line written without the address", lines.some((l) => l.includes('"audit":"email_set"')) && !lines.some((l) => l.includes("bob@example.com")));
}
{
  // ⚠️ 真 Cognito 不拦这种设置，会把别名从 alice 那里抢过来（2026-10-30 临时用户池实测）—— 必须是我们先查出来拦下
  const c = fakeCognito({ emails: { alice: "Alice@Example.com" } });
  eq("email belongs to someone else (any case) → 409", await apiSetUserEmail("bob", "alice@example.com", {}, { client: c }), { status: 409, body: { error: "email_in_use" } });
  eq("…and nothing was updated", named(c, "AdminUpdateUserAttributesCommand").length, 0);
  eq("…the check filtered by that email", named(c, "ListUsersCommand")[0].input.Filter, 'email = "alice@example.com"');
  eq("keeping your own email is fine", (await apiSetUserEmail("alice", "alice@example.com", {}, { client: c })).status, 200);
  eq("emailUsedBy ignores the user themselves", await emailUsedBy("alice@example.com", "alice", { client: c }), []);
}
{
  const c = fakeCognito({ aliases: ["taken@example.com"] });
  eq("Cognito's own alias check still maps to 409", await apiSetUserEmail("bob", "taken@example.com", {}, { client: c }), { status: 409, body: { error: "email_in_use" } });
  eq("empty → email_required", await apiSetUserEmail("bob", "", {}, { client: c }), { status: 400, body: { error: "email_required" } });
  eq("malformed → invalid_email", await apiSetUserEmail("bob", "bob@", {}, { client: c }), { status: 400, body: { error: "invalid_email" } });
  eq("unknown user → 404", await apiSetUserEmail("carol", "c@example.com", {}, { client: c }), { status: 404, body: { error: "user_not_found" } });
}

/* ── 新建用户：邮箱必填（2026-10-30 起）── */
{
  const c = fakeCognito();
  eq("no email → email_required", await apiCreateUser({ username: "dave" }, { client: c }), { status: 400, body: { error: "email_required" } });
  eq("blank email → email_required", await apiCreateUser({ username: "dave", email: "  " }, { client: c }), { status: 400, body: { error: "email_required" } });
  eq("malformed email → invalid_email", await apiCreateUser({ username: "dave", email: "dave" }, { client: c }), { status: 400, body: { error: "invalid_email" } });
  eq("…and nothing was created", named(c, "AdminCreateUserCommand").length, 0);
  const r = await apiCreateUser({ username: "dave", email: " dave@example.com " }, { client: c });
  eq("created with trimmed email", [r.status, r.body.username, r.body.email, typeof r.body.tempPassword], [200, "dave", "dave@example.com", "string"]);
  const input = named(c, "AdminCreateUserCommand")[0].input;
  eq("email marked verified, no invitation email", [input.UserAttributes, input.MessageAction],
     [[{ Name: "email", Value: "dave@example.com" }, { Name: "email_verified", Value: "true" }], "SUPPRESS"]);
}
{
  // 真 Cognito 对「别人的已验证邮箱」回 UsernameExistsException，和用户名重了同一句话 —— 先查出来才能说清是邮箱
  const c = fakeCognito({ emails: { alice: "alice@example.com" } });
  eq("email already used by someone → 409 email_in_use", await apiCreateUser({ username: "erin", email: "ALICE@example.com" }, { client: c }), { status: 409, body: { error: "email_in_use" } });
  eq("…and nothing was created", named(c, "AdminCreateUserCommand").length, 0);
  eq("username taken → 409 user_exists", await apiCreateUser({ username: "bob", email: "b2@example.com" }, { client: c }), { status: 409, body: { error: "user_exists" } });
}

/* ── 两条新路由都在 /admin/ 下：管理员才行，并且被标成 adminOnly（要过两步验证门禁）── */
{
  const admin = { grants: ["*"], denies: [] };
  const member = { grants: ["nav:chat"], denies: [] };
  for (const [method, path] of [["POST", "/api/admin/users/bob/password"], ["PUT", "/api/admin/users/bob/email"]]) {
    eq(`${method} ${path} admin → allowed + adminOnly`, await authorize({ method, path, query: {}, body: {} }, admin, { disabledModules: [] }), { allow: true, adminOnly: true });
    const r = await authorize({ method, path, query: {}, body: {} }, member, { disabledModules: [] });
    ok(`${method} ${path} non-admin → denied`, r.allow === false);
  }
}

console.log(`passwords.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
