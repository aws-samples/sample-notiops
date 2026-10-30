/**
 * Web 登录两步验证（验证器 App，TOTP）的服务端部分（2026-10-29 加）。
 *
 * 绑定验证器、登录时输验证码，全在浏览器里经 Amplify 直连 Cognito 完成，BFF 不经手密钥和验证码。
 * 这里只做三件事：
 *
 *   1. **「管理」页门禁**：nav:admin 覆盖的全部 /admin/* 路由，要求调用者**已绑定**验证器。用户池「可选」时
 *      就靠这一道让管理员先开；「强制」时人人都已绑定，这道门自然放行；「关闭」时用户池不让绑定，门不生效。
 *      判据是 Cognito 里**此刻**的状态（AdminGetUser 的 UserMFASettingList），不是令牌：Cognito 的 idToken
 *      里没有「这次登录用了 MFA」的声明。绑定之后 Cognito 每次登录都会要验证码，所以「已绑定」等价于
 *      「绑定之后的每次登录都过了验证码」。
 *      ⚠️ 这和 Cognito 自己「强制」档的首次绑定一样是先到先得：知道某个**还没绑定**的管理员密码的人，
 *         能抢先绑上自己的验证器。门禁缩短的是这个窗口（管理员第一次进管理页就得绑），不是消灭它。
 *   2. `/me/mfa`：告诉前端用户池是哪一档、自己绑了没有（菜单里显示「两步验证」、能不能关）。
 *   3. 管理员替丢了手机的人**重置**：删掉他登记的验证器（AdminDeleteSoftwareToken；下次登录重新绑定，
 *      「可选」档下在他重新绑定之前只靠密码），并让他所有会话失效（刷新令牌作废，已发出的访问令牌最长 1 小时后过期）。
 *      ⚠️ 不能只关偏好（AdminSetUserMFAPreference Enabled=false）：「强制」档下验证器还登记着，Cognito 照样要
 *      旧验证器的码 —— v1.0.34 RC 在验证账号上测出来的（2026-10-29）。
 *
 * 用户池的模式从 Cognito 现读（GetUserPoolMfaConfig，缓存 5 分钟），**不**经环境变量：模式只配在用户池上
 * 这一处（方式 A 的 MfaMode 参数 / 方式 B 的 mfaMode 上下文），BFF 不会和它漂移。
 *
 * 读不到（Cognito 抖动 / 缺权限）时 fail closed：门禁回 503 `mfa_check_unavailable`，不放行也不登出 ——
 * 与 jwt.mjs 拉不到 JWKS 时同一个口径（「稍后再试」，不是「你没权限」）。
 */
import {
  CognitoIdentityProviderClient, GetUserPoolMfaConfigCommand, AdminGetUserCommand,
  AdminDeleteSoftwareTokenCommand, AdminUserGlobalSignOutCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const REGION = process.env.AWS_REGION || "us-east-1";
const defaultClient = new CognitoIdentityProviderClient({ region: REGION });
const poolId = () => process.env.COGNITO_USER_POOL_ID || "";

const POLICY_TTL_MS = 5 * 60 * 1000;
// 已绑定的结果缓存 1 分钟：被管理员重置后，这个 Lambda 实例最多再放行这么久（重置同时作废了他的会话）。
// 「没绑定」**不缓存**：用户刚在弹窗里绑完，紧接着的 /me/mfa 和管理请求就必须看到新状态 —— 原来缓存 5 秒，
// 验证账号上真浏览器测出来：5 秒内绑完，门禁提示就一直不消失（2026-10-29）。没绑的人被拦下的请求本来就少。
const ENROLLED_TTL_MS = 60 * 1000;

let policyCache = null; // { at, value }
const enrolledCache = new Map(); // username -> { at, value }

/** 仅供测试：清掉两份缓存。 */
export function _resetMfaCaches() {
  policyCache = null;
  enrolledCache.clear();
}

/** Cognito 的 MfaConfiguration + TOTP 开关 → 对外三档（OFF / OPTIONAL / REQUIRED）。 */
export function modeOf(mfaConfiguration, totpEnabled) {
  if (!totpEnabled) return "OFF"; // 只开了短信 / 邮件之类：对这套界面来说等于没有 TOTP
  if (mfaConfiguration === "ON") return "REQUIRED";
  if (mfaConfiguration === "OPTIONAL") return "OPTIONAL";
  return "OFF";
}

/** 用户池此刻是哪一档。抛错 = 读不到（调用方按 fail closed 处理）。 */
export async function mfaPolicy({ client = defaultClient, now = Date.now() } = {}) {
  if (policyCache && now - policyCache.at < POLICY_TTL_MS) return policyCache.value;
  const r = await client.send(new GetUserPoolMfaConfigCommand({ UserPoolId: poolId() }));
  const value = { mode: modeOf(r.MfaConfiguration, !!r.SoftwareTokenMfaConfiguration?.Enabled) };
  policyCache = { at: now, value };
  return value;
}

/**
 * 某个用户是否已绑定验证器。抛错 = 读不到。
 * `fresh: true` 跳过缓存（并用读到的值刷新缓存）—— /me/mfa 用：它只在打开页面和刚改完设置时调，必须是此刻的状态。
 */
export async function totpEnrolled(username, { client = defaultClient, now = Date.now(), fresh = false } = {}) {
  const hit = enrolledCache.get(username);
  if (!fresh && hit && now - hit.at < ENROLLED_TTL_MS) return hit.value;
  const r = await client.send(new AdminGetUserCommand({ UserPoolId: poolId(), Username: username }));
  const value = (r.UserMFASettingList || []).includes("SOFTWARE_TOKEN_MFA");
  if (value) enrolledCache.set(username, { at: now, value });
  else enrolledCache.delete(username);
  return value;
}

/**
 * 「管理」页门禁。只对 adminOnly 路由调用（index.mjs 在 authorize 放行之后）。
 * @returns {Promise<{allow: true} | {allow: false, status: number, error: string}>}
 */
export async function adminMfaGate(username, deps = {}) {
  let policy;
  try {
    policy = await mfaPolicy(deps);
  } catch (e) {
    console.error(`mfa gate: cannot read the user pool MFA config (${e?.name || "error"})`);
    return { allow: false, status: 503, error: "mfa_check_unavailable" };
  }
  if (policy.mode === "OFF") return { allow: true };
  if (!username) return { allow: false, status: 403, error: "mfa_required" };
  try {
    if (await totpEnrolled(username, deps)) return { allow: true };
  } catch (e) {
    console.error(`mfa gate: cannot read the caller's MFA settings (${e?.name || "error"})`);
    return { allow: false, status: 503, error: "mfa_check_unavailable" };
  }
  return { allow: false, status: 403, error: "mfa_required" };
}

/** GET /me/mfa —— 前端据此显示菜单项、决定能不能关。读不到时回 mode=null，前端就不显示入口。 */
export async function apiMyMfa(username, deps = {}) {
  try {
    const { mode } = await mfaPolicy(deps);
    const enrolled = mode === "OFF" || !username ? false : await totpEnrolled(username, { ...deps, fresh: true });
    return { status: 200, body: { mode, enrolled, adminRequiresMfa: mode !== "OFF" } };
  } catch (e) {
    console.error(`/me/mfa: ${e?.name || "error"}`);
    return { status: 200, body: { mode: null, enrolled: null, adminRequiresMfa: null } };
  }
}

/**
 * 一批用户各自是否已绑定（管理页用户列表的「两步验证」一列）。ListUsers 不带这项，只能逐个 AdminGetUser；
 * 并发 5、单个失败记成 null（「未知」），不让整张列表因为一个人读不到而失败。
 */
export async function enrolledMap(usernames, deps = {}) {
  const out = new Map();
  const queue = [...usernames];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      try { out.set(u, await totpEnrolled(u, deps)); } catch { out.set(u, null); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker));
  return out;
}

const USERNAME_RE = /^[A-Za-z0-9._@+-]{1,128}$/;

/** DELETE /admin/users/{u}/mfa —— 关掉某人的 TOTP 并作废他的会话。不许对自己做（自己用菜单里的「两步验证」）。 */
export async function apiResetUserMfa(username, actor = {}, { client = defaultClient } = {}) {
  const u = String(username || "").trim();
  if (!USERNAME_RE.test(u)) return { status: 400, body: { error: "invalid_username" } };
  if (actor.username && u === actor.username) return { status: 409, body: { error: "cannot_reset_self" } };
  try {
    await client.send(new AdminDeleteSoftwareTokenCommand({ UserPoolId: poolId(), Username: u }));
  } catch (e) {
    if (e?.name === "UserNotFoundException") return { status: 404, body: { error: "user_not_found" } };
    // 他本来就没登记验证器：没东西可删，照样让他的会话失效（管理员要的结果已经成立）
    if (e?.name !== "ResourceNotFoundException") return { status: 400, body: { error: e?.name || "error" } };
  }
  enrolledCache.delete(u);
  let signedOut = true;
  try {
    await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: poolId(), Username: u }));
  } catch (e) {
    signedOut = false; // TOTP 已经关了；会话作废失败只影响「立刻踢下线」，照实回给管理员
    console.error(`mfa reset: global sign-out failed (${e?.name || "error"})`);
  }
  // 审计：谁、何时、从哪里替谁重置（不含任何密钥 / 令牌）
  console.log(JSON.stringify({ audit: "mfa_reset", target: u, by: actor.username || "", ip: actor.ip || "", signedOut }));
  return { status: 200, body: { ok: true, signedOut } };
}
