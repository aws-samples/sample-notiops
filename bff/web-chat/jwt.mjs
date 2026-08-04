/**
 * 零依赖 Cognito JWT 校验（RS256）。
 *
 * 用 Node 20 内置 crypto + https 验证 Cognito idToken：
 *   1. 拉取并缓存 user pool 的 JWKS
 *   2. 按 kid 找公钥，验签
 *   3. 校验 exp / iss / token_use
 *
 * 不引第三方库（规避 CodeArtifact 鉴权 + 减小冷启动）。仅用于读取身份；
 * 真正的授权（admin/member group）在调用方按 claims['cognito:groups'] 判断。
 */
import { createVerify, createPublicKey } from "node:crypto";
import https from "node:https";

const REGION = process.env.AWS_REGION || "us-east-1";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";

let _jwks = null;
let _jwksAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function getJwks() {
  const now = Date.now();
  if (_jwks && now - _jwksAt < JWKS_TTL_MS) return _jwks;
  const url = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}/.well-known/jwks.json`;
  const data = await fetchJson(url);
  _jwks = {};
  for (const k of data.keys) _jwks[k.kid] = k;
  _jwksAt = now;
  return _jwks;
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
  const jwk = jwks[header.kid];
  if (!jwk) throw new Error("unknown kid");

  // 验签
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headB64}.${payloadB64}`);
  verifier.end();
  const ok = verifier.verify(jwkToPem(jwk), b64urlToBuf(sigB64));
  if (!ok) throw new Error("bad signature");

  // 校验 claims
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) throw new Error("token expired");
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
