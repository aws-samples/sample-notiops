/**
 * 忘记密码 / 重置密码的服务端部分（2026-10-30 加，待办 #45）。
 *
 * 自助找回（登录页 Forgot password?）、修改密码、绑定 / 更换邮箱，全在浏览器里经 Amplify 直连 Cognito 完成
 * （Cognito 的公开接口 / 用户自己的访问令牌），BFF 不经手，也就没有任何免登录的服务端入口。
 * 这里只有管理员的两件事，路由都在 /admin/ 下 —— 落在 nav:admin 里：默认只有管理员，并且要过
 * 「管理页必须已绑定验证器」那道门禁（见 mfa.mjs）：
 *
 *   1. **替人重置密码**：AdminSetUserPassword(Permanent=false) 设一次性临时密码 → 状态 FORCE_CHANGE_PASSWORD，
 *      他下次登录走登录页已有的「设新密码」一步（临时密码 7 天不用就失效，再重置一次即可）；
 *      再 AdminUserGlobalSignOut 让他所有设备上的登录失效（刷新令牌立刻作废；已签发的 ID 令牌 BFF 是本地验签，
 *      最长 1 小时后过期）。两步验证不动 —— 忘了密码 ≠ 丢了手机，后者另有「重置两步验证」。
 *      ⚠️ 不用 AdminResetUserPassword：它走的是邮件验证码，对没有已验证邮箱的人直接报 InvalidParameterException
 *         （2026-10-30 临时用户池实测）—— 而要管理员出手的恰恰是这些人（老部署里很多：setup.sh 建的 admin 就没有）。
 *   2. **给用户设邮箱**：AdminUpdateUserAttributes(email, email_verified=true)。管理员填的即视为已验证，与新建用户
 *      时填邮箱同一口径（带 email_verified=true 时 Cognito 立即生效、不发验证码）。邮箱已经是别人的登录别名 →
 *      **先查重**：⚠️ Cognito 不拦 —— 带 email_verified=true 把别人的已验证邮箱设给另一个人，会**把登录别名从那个人那里
 *      抢过来**（他的 email_verified 变成 false，之后用这个邮箱登录 / 收找回验证码的就成了新的那个人；2026-10-30
 *      临时用户池实测）。所以先 ListUsers 按邮箱查（这个过滤不分大小写），别人在用就 409 email_in_use。
 *
 * 临时密码只出现在那一次响应里交给管理员（界面一次性显示），不进日志、不发邮件；审计行只记谁、何时、从哪、替谁。
 */
import {
  CognitoIdentityProviderClient, AdminSetUserPasswordCommand, AdminUserGlobalSignOutCommand,
  AdminUpdateUserAttributesCommand, ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { randomBytes } from "node:crypto";

const REGION = process.env.AWS_REGION || "us-east-1";
const defaultClient = new CognitoIdentityProviderClient({ region: REGION });
const poolId = () => process.env.COGNITO_USER_POOL_ID || "";

const USERNAME_RE = /^[A-Za-z0-9._@+-]{1,128}$/;
// 只挡明显不是邮箱的输入（Cognito 自己还会再校验一次），不做 RFC 全量校验。引号和反斜杠也不收：
// 邮箱要拼进 ListUsers 的过滤表达式（email = "…"）。
const EMAIL_RE = /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/;

/** 看起来像一个邮箱地址（≤254 字符、有 @ 和点、没有空白）。 */
export function validEmail(email) {
  const e = typeof email === "string" ? email.trim() : "";
  return e.length > 0 && e.length <= 254 && EMAIL_RE.test(e);
}

/**
 * 除了 `exceptUsername` 之外，还有谁的邮箱是这个（不论验没验证）。新建用户和设邮箱之前都查一遍：
 *   · 新建：Cognito 对「别人的已验证邮箱」回 UsernameExistsException「User account already exists」，和用户名重了是
 *     同一句话，管理员分不清；
 *   · 设邮箱：Cognito 根本不拦，会把别名抢过来（见文件头）。
 * ListUsers 的 email 过滤不分大小写（实测）。
 */
export async function emailUsedBy(email, exceptUsername, { client = defaultClient } = {}) {
  const r = await client.send(new ListUsersCommand({
    UserPoolId: poolId(), Filter: `email = "${String(email).trim()}"`, Limit: 10,
  }));
  return (r.Users || []).map((u) => u.Username).filter((u) => u !== exceptUsername);
}

/** 生成满足密码策略（至少 8 位、含大写 / 小写 / 数字，不要求符号）的临时密码。新建用户和重置密码共用。 */
export function genTempPassword() {
  return "Aa1" + randomBytes(6).toString("hex"); // 15 位：大写 A + 小写 a + 数字 1 + 12 位十六进制
}

/** POST /admin/users/{u}/password —— 替忘了密码的人设一次性临时密码并作废他的会话。不许对自己做（自己用菜单里的「修改密码」）。 */
export async function apiResetUserPassword(username, actor = {}, { client = defaultClient, gen = genTempPassword } = {}) {
  const u = String(username || "").trim();
  if (!USERNAME_RE.test(u)) return { status: 400, body: { error: "invalid_username" } };
  if (actor.username && u === actor.username) return { status: 409, body: { error: "cannot_reset_self" } };
  const tempPassword = gen();
  try {
    await client.send(new AdminSetUserPasswordCommand({
      UserPoolId: poolId(), Username: u, Password: tempPassword, Permanent: false,
    }));
  } catch (e) {
    if (e?.name === "UserNotFoundException") return { status: 404, body: { error: "user_not_found" } };
    return { status: 400, body: { error: e?.name || "error" } };
  }
  let signedOut = true;
  try {
    await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: poolId(), Username: u }));
  } catch (e) {
    signedOut = false; // 密码已经换了；会话作废失败只影响「立刻踢下线」，照实回给管理员
    console.error(`password reset: global sign-out failed (${e?.name || "error"})`);
  }
  // 审计：谁、何时、从哪里替谁重置（不含临时密码）
  console.log(JSON.stringify({ audit: "password_reset", target: u, by: actor.username || "", ip: actor.ip || "", signedOut }));
  return { status: 200, body: { username: u, tempPassword, signedOut } };
}

/** PUT /admin/users/{u}/email —— 管理员给用户设（或换）邮箱，直接标已验证。 */
export async function apiSetUserEmail(username, email, actor = {}, { client = defaultClient } = {}) {
  const u = String(username || "").trim();
  if (!USERNAME_RE.test(u)) return { status: 400, body: { error: "invalid_username" } };
  const e = String(email || "").trim();
  if (!e) return { status: 400, body: { error: "email_required" } };
  if (!validEmail(e)) return { status: 400, body: { error: "invalid_email" } };
  try {
    if ((await emailUsedBy(e, u, { client })).length) return { status: 409, body: { error: "email_in_use" } };
    await client.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: poolId(), Username: u,
      UserAttributes: [{ Name: "email", Value: e }, { Name: "email_verified", Value: "true" }],
    }));
  } catch (err) {
    const name = err?.name || "error";
    if (name === "UserNotFoundException") return { status: 404, body: { error: "user_not_found" } };
    if (name === "AliasExistsException") return { status: 409, body: { error: "email_in_use" } };
    return { status: 400, body: { error: name } };
  }
  // 审计：不记邮箱地址本身（个人信息），只记谁替谁改过
  console.log(JSON.stringify({ audit: "email_set", target: u, by: actor.username || "", ip: actor.ip || "" }));
  return { status: 200, body: { username: u, email: e, emailVerified: true } };
}
