/**
 * 零依赖 Cognito JWT 校验（RS256）。
 *
 * 用 Node 内置 crypto + 全局 fetch 验证 Cognito idToken：
 *   1. 拉取并缓存 user pool 的 JWKS（有超时、有负缓存、有 stale 兜底）
 *   2. 按 kid 找公钥，验签
 *   3. 校验 exp / iss / token_use
 *
 * 不引第三方库（规避 CodeArtifact 鉴权 + 减小冷启动）。仅用于读取身份；
 * 真正的授权（admin/member group）在调用方按 claims['cognito:groups'] 判断。
 */
import { createVerify, createPublicKey } from "node:crypto";

const REGION = process.env.AWS_REGION || "us-east-1";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";

/**
 * 拉 JWKS 的四个时间常数。为什么每个都必须存在：
 *   · TIMEOUT —— 原来用 https.get 且**没有超时**。BFF 是 RESPONSE_STREAM + 15 分钟
 *     timeout + 没有 reservedConcurrentExecutions，而这个请求挂在**每一条路由**的
 *     鉴权前置上（index.mjs 的 authClaims）。一次 cognito-idp 网络黑洞就能让所有并发
 *     请求各自挂 15 分钟，不是「慢一点」而是把整个 web 端拖死。
 *   · TTL —— 正常缓存窗口（本来就有）。
 *   · STALE —— TTL 过期但刷新失败时，允许继续用**旧的一份**多久。Cognito 轮换密钥的
 *     周期远大于 24h，用旧表验签仍然是安全的（验不过的照旧拒），比"IdP 抖一下就把
 *     所有人踢下线"好。
 *   · RETRY —— 失败后的**负缓存**。原来 `_jwksAt` 只在成功时更新，于是一旦失败，
 *     后面每一个请求都会再去打一次，把上游的抖动放大成一场自我 DDoS。
 */
const JWKS_TIMEOUT_MS = Number(process.env.JWKS_TIMEOUT_MS || "2000");
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h
const JWKS_STALE_MS = 24 * 60 * 60 * 1000; // 24h
const JWKS_RETRY_MS = 30 * 1000; // 失败后 30s 内不再重试

let _jwks = null; // 只在**完整可用**时才被赋值（见 fetchJwks 的 all-or-nothing）
let _jwksAt = 0; // 上一次成功的时刻
let _jwksFailAt = 0; // 上一次失败的时刻（负缓存）

/**
 * 拉一份 JWKS 并构造 kid -> jwk 表。要么返回一张**完整可用**的表，要么抛错 ——
 * 绝不返回半张表，也绝不在中途去写 `_jwks`。
 *
 * 原来的写法是 `_jwks = {}` 先清空、再进循环填充：`data.keys` 为 undefined（拿到一页
 * HTML / 503 body）时循环抛错，而缓存已经被清成空对象了 —— 一次失败的刷新会**毁掉一份
 * 本来好用的密钥表**，之后所有 token 都是「unknown kid」。
 */
async function fetchJwks() {
  const url = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`;
  // 与仓库其他出网调用一致（cur_dashboard.mjs / llm_config.mjs）：全局 fetch + AbortSignal.timeout。
  const resp = await fetch(url, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`jwks_http_${resp.status}`);
  const data = await resp.json();
  const keys = Array.isArray(data?.keys) ? data.keys : null;
  if (!keys) throw new Error("jwks_malformed");
  // Object.create(null)：kid 是攻击者可控的字符串，普通对象上 `jwks["__proto__"]`
  // 会拿到 Object.prototype 而不是 undefined，`if (!jwk)` 那道门就形同虚设。
  const table = Object.create(null);
  let n = 0;
  for (const k of keys) {
    if (!k || typeof k.kid !== "string" || !k.kid) continue;
    table[k.kid] = k;
    n += 1;
  }
  // 空表也算失败：`{"keys":[]}` 提交进缓存会把这个容器毒死一整个 TTL。
  if (n === 0) throw new Error("jwks_empty");
  return table;
}

/**
 * 取 JWKS。三档：新鲜 → 直接用；过期但刷新失败 → 在 STALE 窗口内继续用旧的；
 * 什么都没有 → 抛 `jwks_unavailable`（**fail closed**，调用方回 503，不是放行）。
 */
async function getJwks() {
  const now = Date.now();
  if (_jwks && now - _jwksAt < JWKS_TTL_MS) return _jwks;
  // 负缓存：刚失败过就不要再打上游；有旧表就先用旧表顶着。
  if (now - _jwksFailAt < JWKS_RETRY_MS) {
    if (_jwks && now - _jwksAt < JWKS_STALE_MS) return _jwks;
    const err = new Error("jwks_unavailable");
    err.code = "jwks_unavailable";
    throw err;
  }
  try {
    const table = await fetchJwks();
    _jwks = table;
    _jwksAt = now;
    _jwksFailAt = 0;
    return _jwks;
  } catch (e) {
    _jwksFailAt = now;
    // 只记异常类型名 —— 上游 body 里可能带 user pool id / 内部报文（docs/LOGGING_STANDARD.md）。
    console.error(`auth: jwks fetch failed type=${e?.constructor?.name || "Error"}`);
    if (_jwks && now - _jwksAt < JWKS_STALE_MS) return _jwks;
    const err = new Error("jwks_unavailable");
    err.code = "jwks_unavailable";
    throw err;
  }
}

function b64urlToBuf(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function jwkToPem(jwk) {
  // 用 Node 内置：从 JWK 直接造公钥对象
  return createPublicKey({ key: jwk, format: "jwk" });
}

/**
 * 校验并解析 idToken。成功返回 claims；失败抛错。
 */
export async function verifyToken(token) {
  if (!token) throw new Error("missing token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(b64urlToBuf(headB64).toString("utf8"));
  const claims = JSON.parse(b64urlToBuf(payloadB64).toString("utf8"));

  if (header.alg !== "RS256") throw new Error("unexpected alg");

  const jwks = await getJwks();
  // 刻意**不**在 kid 未命中时强制刷新 JWKS：那会把「随便编一个 kid」变成一个免费的
  // 上游放大器（每个伪造 token 打一次 cognito-idp）。密钥轮换靠上面的 TTL 自然过期。
  const jwk = typeof header.kid === "string" ? jwks[header.kid] : undefined;
  if (!jwk) throw new Error("unknown kid");

  // 验签
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headB64}.${payloadB64}`);
  verifier.end();
  const ok = verifier.verify(jwkToPem(jwk), b64urlToBuf(sigB64));
  if (!ok) throw new Error("bad signature");

  // 校验 claims
  const now = Math.floor(Date.now() / 1000);
  // 缺 exp / exp 不是数字都必须拒。原来写的是 `claims.exp && claims.exp < now`，
  // 一个不带 exp 的 token 会被当成"永不过期"直接放过去。
  if (!Number.isFinite(claims.exp) || claims.exp < now) throw new Error("token expired");
  const expectIss = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
  if (claims.iss !== expectIss) throw new Error("bad issuer");
  if (claims.token_use !== "id") throw new Error("not an id token");

  return claims;
}

/**
 * 取用户 idToken。
 * Function URL 用 AWS_IAM 鉴权时 Authorization 头被 SigV4 占用，故用户身份走
 * 自定义头 x-notiops-id-token（前端用 aws4fetch 签名时一并签上）。
 * 兼容回退：也认 Authorization: Bearer（本地/旧调用）。
 */
export function bearerFrom(headers) {
  if (!headers) return "";
  const custom = headers["x-notiops-id-token"] || headers["X-Notiops-Id-Token"];
  if (custom) return String(custom);
  const h = headers.authorization || headers.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : "";
}
