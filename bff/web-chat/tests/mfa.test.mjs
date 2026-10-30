/**
 * 两步验证服务端部分（mfa.mjs）单测：「管理」页门禁、/me/mfa、管理员重置、用户列表那一列。
 * 运行：node bff/web-chat/tests/mfa.test.mjs
 *
 * Cognito 客户端用假的 `{ send }` 注入（按命令类名分派），不碰网络。
 */
process.env.COGNITO_USER_POOL_ID = "us-east-1_TESTPOOL";
const {
  modeOf, mfaPolicy, totpEnrolled, adminMfaGate, apiMyMfa, apiResetUserMfa, enrolledMap, _resetMfaCaches,
} = await import("../mfa.mjs");
const { authorize } = await import("../authz.mjs");

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log(`XX ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`XX ${name}`); } }

/** 假 Cognito：pool = GetUserPoolMfaConfig 的回包；users = 用户名 → 已启用的 MFA 列表；fail = 哪些命令要抛错。 */
function fakeCognito({ pool = { MfaConfiguration: "OPTIONAL", SoftwareTokenMfaConfiguration: { Enabled: true } },
                       users = {}, fail = {} } = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      if (fail[name]) throw Object.assign(new Error(fail[name]), { name: fail[name] });
      if (name === "GetUserPoolMfaConfigCommand") return pool;
      if (name === "AdminGetUserCommand") {
        if (!(cmd.input.Username in users)) throw Object.assign(new Error("nf"), { name: "UserNotFoundException" });
        return { Username: cmd.input.Username, UserMFASettingList: users[cmd.input.Username] };
      }
      if (name === "AdminDeleteSoftwareTokenCommand") {
        if (!(cmd.input.Username in users)) throw Object.assign(new Error("nf"), { name: "UserNotFoundException" });
        if (!(users[cmd.input.Username] || []).length) throw Object.assign(new Error("none"), { name: "ResourceNotFoundException" });
        users[cmd.input.Username] = [];
        return {};
      }
      if (name === "AdminUserGlobalSignOutCommand") return {};
      throw new Error(`unexpected command ${name}`);
    },
  };
}
const count = (c, name) => c.calls.filter((x) => x.name === name).length;

/* ── 档位映射 ── */
eq("ON → REQUIRED", modeOf("ON", true), "REQUIRED");
eq("OPTIONAL → OPTIONAL", modeOf("OPTIONAL", true), "OPTIONAL");
eq("OFF → OFF", modeOf("OFF", true), "OFF");
eq("TOTP not enabled → OFF whatever the setting", modeOf("ON", false), "OFF");
eq("missing → OFF", modeOf(undefined, undefined), "OFF");

/* ── 用户池档位缓存 5 分钟 ── */
{
  _resetMfaCaches();
  const c = fakeCognito();
  eq("policy read", await mfaPolicy({ client: c, now: 0 }), { mode: "OPTIONAL" });
  await mfaPolicy({ client: c, now: 4 * 60 * 1000 });
  eq("policy cached within 5 min", count(c, "GetUserPoolMfaConfigCommand"), 1);
  await mfaPolicy({ client: c, now: 6 * 60 * 1000 });
  eq("policy re-read after 5 min", count(c, "GetUserPoolMfaConfigCommand"), 2);
}

/* ── 已绑定缓存 60 秒；没绑定**不缓存**；fresh 跳过缓存并刷新它 ── */
{
  _resetMfaCaches();
  const users = { alice: ["SOFTWARE_TOKEN_MFA"], bob: [] };
  const c = fakeCognito({ users });
  ok("alice enrolled", await totpEnrolled("alice", { client: c, now: 0 }));
  await totpEnrolled("alice", { client: c, now: 59_000 });
  eq("enrolled result cached for a minute", count(c, "AdminGetUserCommand"), 1);
  await totpEnrolled("alice", { client: c, now: 61_000 });
  eq("enrolled result re-read after a minute", count(c, "AdminGetUserCommand"), 2);
  ok("bob not enrolled", !(await totpEnrolled("bob", { client: c, now: 0 })));
  users.bob = ["SOFTWARE_TOKEN_MFA"]; // bob 刚在弹窗里绑完
  ok("not-enrolled is never cached: the very next check sees the new state", await totpEnrolled("bob", { client: c, now: 100 }));
  users.alice = []; // alice 刚自己关掉
  ok("fresh read skips the cache", !(await totpEnrolled("alice", { client: c, now: 62_000, fresh: true })));
  ok("…and the stale 'enrolled' entry is gone", !(await totpEnrolled("alice", { client: c, now: 62_001 })));
}

/* ── 真浏览器测出来的那一幕：门禁刚拦过（没绑），5 秒内绑完，/me/mfa 与下一个管理请求必须立刻看到「已绑」 ── */
{
  _resetMfaCaches();
  const users = { carol: [] };
  const c = fakeCognito({ users });
  eq("blocked before enrolling", (await adminMfaGate("carol", { client: c, now: 0 })).allow, false);
  users.carol = ["SOFTWARE_TOKEN_MFA"];
  eq("/me/mfa right after enrolling says enrolled", (await apiMyMfa("carol", { client: c, now: 1_000 })).body.enrolled, true);
  eq("next admin request right after enrolling is allowed", await adminMfaGate("carol", { client: c, now: 1_001 }), { allow: true });
}

/* ── 「管理」页门禁 ── */
{
  _resetMfaCaches();
  const c = fakeCognito({ pool: { MfaConfiguration: "OFF", SoftwareTokenMfaConfiguration: { Enabled: false } } });
  eq("OFF: allowed", await adminMfaGate("bob", { client: c }), { allow: true });
  eq("OFF: no per-user lookup", count(c, "AdminGetUserCommand"), 0);
}
{
  _resetMfaCaches();
  const c = fakeCognito({ users: { alice: ["SOFTWARE_TOKEN_MFA"], bob: [] } });
  eq("OPTIONAL + enrolled: allowed", await adminMfaGate("alice", { client: c }), { allow: true });
  eq("OPTIONAL + not enrolled: 403 mfa_required", await adminMfaGate("bob", { client: c }),
     { allow: false, status: 403, error: "mfa_required" });
  eq("no username: 403", await adminMfaGate("", { client: c }), { allow: false, status: 403, error: "mfa_required" });
}
{
  _resetMfaCaches();
  const c = fakeCognito({ pool: { MfaConfiguration: "ON", SoftwareTokenMfaConfiguration: { Enabled: true } },
                          users: { alice: ["SOFTWARE_TOKEN_MFA"] } });
  eq("REQUIRED + enrolled: allowed", await adminMfaGate("alice", { client: c }), { allow: true });
}
{
  _resetMfaCaches();
  const c = fakeCognito({ fail: { GetUserPoolMfaConfigCommand: "ThrottlingException" } });
  eq("pool config unreadable: 503 (fail closed)", await adminMfaGate("alice", { client: c }),
     { allow: false, status: 503, error: "mfa_check_unavailable" });
}
{
  _resetMfaCaches();
  const c = fakeCognito({ fail: { AdminGetUserCommand: "AccessDeniedException" } });
  eq("caller unreadable: 503 (fail closed)", await adminMfaGate("alice", { client: c }),
     { allow: false, status: 503, error: "mfa_check_unavailable" });
}

/* ── /me/mfa ── */
{
  _resetMfaCaches();
  const c = fakeCognito({ users: { bob: [] } });
  eq("me: optional, not enrolled", await apiMyMfa("bob", { client: c }),
     { status: 200, body: { mode: "OPTIONAL", enrolled: false, adminRequiresMfa: true } });
  _resetMfaCaches();
  const off = fakeCognito({ pool: { MfaConfiguration: "OFF" } });
  eq("me: off", await apiMyMfa("bob", { client: off }),
     { status: 200, body: { mode: "OFF", enrolled: false, adminRequiresMfa: false } });
  eq("me: off does not look the user up", count(off, "AdminGetUserCommand"), 0);
  _resetMfaCaches();
  const bad = fakeCognito({ fail: { GetUserPoolMfaConfigCommand: "ThrottlingException" } });
  eq("me: unreadable → nulls (menu entry hidden)", await apiMyMfa("bob", { client: bad }),
     { status: 200, body: { mode: null, enrolled: null, adminRequiresMfa: null } });
}

/* ── 管理员重置 ── */
{
  _resetMfaCaches();
  const c = fakeCognito({ users: { alice: ["SOFTWARE_TOKEN_MFA"], carol: ["SOFTWARE_TOKEN_MFA"] } });
  eq("reset: bad username", await apiResetUserMfa("a b", { username: "alice" }, { client: c }),
     { status: 400, body: { error: "invalid_username" } });
  eq("reset: self refused", await apiResetUserMfa("alice", { username: "alice" }, { client: c }),
     { status: 409, body: { error: "cannot_reset_self" } });
  eq("reset: no Cognito call for refused requests", c.calls.length, 0);

  // 先让 carol 的「已绑定」进缓存，确认重置会把它清掉
  ok("carol enrolled before", await totpEnrolled("carol", { client: c }));
  eq("reset: ok", await apiResetUserMfa("carol", { username: "alice", ip: "1.2.3.4" }, { client: c }),
     { status: 200, body: { ok: true, signedOut: true } });
  const del = c.calls.find((x) => x.name === "AdminDeleteSoftwareTokenCommand");
  eq("reset: deletes the registered authenticator", del.input, { UserPoolId: "us-east-1_TESTPOOL", Username: "carol" });
  eq("reset: does not merely turn the preference off (that keeps asking for the old code when MFA is required)",
     c.calls.filter((x) => x.name === "AdminSetUserMFAPreferenceCommand").length, 0);
  eq("reset: sessions revoked", count(c, "AdminUserGlobalSignOutCommand"), 1);
  ok("reset: cache invalidated (re-read shows not enrolled)", !(await totpEnrolled("carol", { client: c })));
  eq("reset: unknown user → 404", await apiResetUserMfa("nobody", { username: "alice" }, { client: c }),
     { status: 404, body: { error: "user_not_found" } });
}
{
  _resetMfaCaches();
  const c = fakeCognito({ users: { carol: ["SOFTWARE_TOKEN_MFA"] }, fail: { AdminUserGlobalSignOutCommand: "InternalErrorException" } });
  eq("reset: sign-out failure reported, TOTP still off", await apiResetUserMfa("carol", { username: "alice" }, { client: c }),
     { status: 200, body: { ok: true, signedOut: false } });
}
{
  _resetMfaCaches();
  const c = fakeCognito({ users: { dave: [] } });
  eq("reset: nothing registered → still ok, sessions still revoked", await apiResetUserMfa("dave", { username: "alice" }, { client: c }),
     { status: 200, body: { ok: true, signedOut: true } });
  eq("reset: sign-out still sent", count(c, "AdminUserGlobalSignOutCommand"), 1);
  const bad = fakeCognito({ users: { carol: ["SOFTWARE_TOKEN_MFA"] }, fail: { AdminDeleteSoftwareTokenCommand: "TooManyRequestsException" } });
  eq("reset: other errors → 400, no sign-out", await apiResetUserMfa("carol", { username: "alice" }, { client: bad }),
     { status: 400, body: { error: "TooManyRequestsException" } });
  eq("reset: no sign-out after a failed delete", count(bad, "AdminUserGlobalSignOutCommand"), 0);
}

/* ── 用户列表那一列 ── */
{
  _resetMfaCaches();
  const users = { u0: ["SOFTWARE_TOKEN_MFA"], u1: [] };
  for (let i = 2; i < 12; i++) users[`u${i}`] = [];
  let inFlight = 0, peak = 0;
  const base = fakeCognito({ users });
  const c = {
    calls: base.calls,
    async send(cmd) {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      try { return await base.send(cmd); } finally { inFlight--; }
    },
  };
  const m = await enrolledMap([...Object.keys(users), "ghost"], { client: c });
  eq("list: enrolled", m.get("u0"), true);
  eq("list: not enrolled", m.get("u1"), false);
  eq("list: unreadable user → null, list still returned", m.get("ghost"), null);
  ok("list: at most 5 lookups in flight", peak <= 5);
}

/* ── authz 把 adminOnly 告诉调用方；/me/mfa 是登录即可的路由 ── */
{
  const admin = { grants: ["*"], denies: [] };
  const r = await authorize({ method: "GET", path: "/api/admin/users", query: {}, body: {} }, admin, { disabledModules: [] });
  eq("authorize marks /admin/* as adminOnly", r, { allow: true, adminOnly: true });
  const chat = await authorize({ method: "GET", path: "/api/me/capabilities", query: {}, body: {} }, { grants: [], denies: [] }, { disabledModules: [] });
  ok("non-admin routes are not marked", chat.allow && !chat.adminOnly);
  const me = await authorize({ method: "GET", path: "/api/me/mfa", query: {}, body: {} }, { grants: [], denies: [] }, { disabledModules: [] });
  eq("/me/mfa allowed for any signed-in user", me, { allow: true });
}

console.log(`mfa.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
