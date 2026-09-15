/**
 * JWKS 抓取的四个时间常数 + token 校验 —— 全离线，自签 RS256。
 * 运行：node bff/web-chat/tests/jwt_jwks.test.mjs
 *
 * ## 守的是什么
 *
 * `getJwks()` 挂在**每一条路由**的鉴权前置上（index.mjs::authClaims）。原来的实现有四个
 * 各自独立、后果各不相同的洞：
 *
 *   ① **没有超时**（`https.get` 裸调）。BFF 是 RESPONSE_STREAM + 15 分钟 timeout +
 *      没有 reservedConcurrentExecutions —— 一次 cognito-idp 网络黑洞下，每个并发请求
 *      各自挂满 15 分钟。这不是"慢一点"，是把整个 web 端拖死，而且账单按挂着的时长算。
 *   ② **没有负缓存**（`_jwksAt` 只在成功时更新）。于是一旦失败，之后每一个请求都再打
 *      一次上游 —— 把别人的抖动放大成我们对它的一场 DDoS。
 *   ③ **失败会毁掉好缓存**（`_jwks = {}` 先清空再进循环填充）。上游回一页 HTML / 503
 *      body 时 `data.keys` 是 undefined，循环抛错，而表已经被清成空对象 —— 之后所有
 *      token 都是「unknown kid」，**一次刷新失败把服务打成全员登不上**。
 *   ④ **`{"keys":[]}` 会被当成成功**提交进缓存，把容器毒死一整个 TTL。
 *
 * 还有两个跟"放大"有关的取舍必须钉住：
 *   · kid 未命中时**刻意不**强制刷新 JWKS —— 否则「随便编一个 kid」就是一个免费的上游
 *     放大器（每个伪造 token 打一次 cognito-idp）；
 *   · kid 是攻击者可控的字符串，表必须是 `Object.create(null)` —— 普通对象上
 *     `jwks["__proto__"]` 拿到的是 `Object.prototype`（真值！），`if (!jwk)` 那道门直接失效。
 *
 * 以及 fail-closed 的方向：JWKS 拿不到时**拒绝**（抛 `jwks_unavailable`，调用方回 503），
 * 不是放行。放行版本等于"IdP 抖一下，鉴权就全线敞开"。
 *
 * ## 手法
 * 全离线：`generateKeyPairSync` 自签真 RS256 token，`globalThis.fetch` 打桩并计数，
 * `Date.now` 打桩来跨越 TTL / STALE / RETRY 三个窗口（这三个不是环境变量，只能这么控）。
 * hang 桩必须**响应 abort 信号**，否则 `AbortSignal.timeout` 根本观察不到。
 */
import { generateKeyPairSync, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/* ── 环境必须在 import 之前设好：jwt.mjs 在模块加载时就读 REGION / USER_POOL_ID ── */
const REGION = "us-east-1";
const POOL = "us-east-1_TESTPOOL";
process.env.AWS_REGION = REGION;
process.env.COGNITO_USER_POOL_ID = POOL;
process.env.JWKS_TIMEOUT_MS = "200"; // 让"有界"这条断言几百毫秒就能出结论
const ISS = `https://cognito-idp.${REGION}.amazonaws.com/${POOL}`;

/* ── 钥匙与发币 ── */
const kp = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...kp.publicKey.export({ format: "jwk" }), kid: "kid-1", alg: "RS256", use: "sig" };
const EXP = Math.floor(Date.now() / 1000) + 10 * 365 * 86400; // 十年后，免得时钟一跳就过期

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint({ kid = "kid-1", alg = "RS256", signWith = kp.privateKey, ...over } = {}) {
  const head = b64u({ alg, kid, typ: "JWT" });
  const body = b64u({ sub: "u-1", token_use: "id", iss: ISS, exp: EXP, ...over });
  const s = createSign("RSA-SHA256");
  s.update(`${head}.${body}`);
  s.end();
  return `${head}.${body}.${s.sign(signWith).toString("base64url")}`;
}
const GOOD = mint();

/* ── 时钟：TTL(1h) / STALE(24h) / RETRY(30s) 都不是环境变量，只能靠 Date.now ──
 * AbortSignal.timeout 走的是真定时器，不受这里影响 —— 所以"有界"那条断言仍然是真的。
 * 量真实耗时用 hrtime（同样不受 Date.now 打桩影响）。 */
let clock = Date.now();
Date.now = () => clock;
const elapsedMs = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;

/* ── fetch 桩 ── */
let mode = "ok";
let fetchCount = 0;
let abortedBySignal = 0; // 有几次 hang 是**真的**被 AbortSignal.timeout 掐掉的
const seen = [];
const GUARD_MS = 1500;
globalThis.fetch = async (url, opts) => {
  fetchCount += 1;
  seen.push({ url: String(url), hasSignal: !!opts?.signal });
  if (mode === "hang") {
    // ⚠️ 必须真的挂上 abort 监听。返回一个永不 settle 的 Promise 而不理信号的话，
    //    AbortSignal.timeout 就永远观察不到 —— 那"有界"这条断言变得毫无意义。
    return new Promise((_res, rej) => {
      // 另一个坑：Node 里 AbortSignal.timeout 的内部定时器是 **unref** 的，事件循环里
      // 只剩它的时候进程会被判定为空闲直接退出（报 "unsettled top-level await"，测试
      // 一条断言都不跑就"成功"了）。这个 ref 的兜底定时器把循环撑住，同时它也是
      // "信号压根没接上"的安全网 —— 靠 abortedBySignal 能区分是谁掐的。
      const guard = setTimeout(
        () => rej(Object.assign(new Error("stub_guard"), { name: "StubGuardError" })), GUARD_MS);
      opts?.signal?.addEventListener("abort", () => {
        clearTimeout(guard);
        abortedBySignal += 1;
        rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
      }, { once: true });
    });
  }
  if (mode === "http500") return { ok: false, status: 500, json: async () => ({}) };
  if (mode === "html") return { ok: true, status: 200, json: async () => ({ message: "not json keys" }) };
  if (mode === "empty") return { ok: true, status: 200, json: async () => ({ keys: [] }) };
  return { ok: true, status: 200, json: async () => ({ keys: [JWK] }) };
};

const jwt = await import("../jwt.mjs");

/** 调 verifyToken，把结果收成 {claims} 或 {err}。 */
async function verify(token) {
  try { return { claims: await jwt.verifyToken(token) }; }
  catch (e) { return { err: e }; }
}

/* ── ① 冷启动 + 上游黑洞：fail closed、有界、只打一次 ─────────────────── */
{
  mode = "hang";
  const t0 = process.hrtime.bigint();
  const { claims, err } = await verify(GOOD);
  const ms = elapsedMs(t0);
  ok("★★★ 拿不到 JWKS 时**拒绝**（fail closed）—— 放行版本等于 IdP 抖一下鉴权就全线敞开",
    !claims && err?.code === "jwks_unavailable");
  ok(`★★★ 有界：${Math.round(ms)}ms 就返回（原来没超时，会挂满 Lambda 的 15 分钟 timeout，`
    + "而这个调用在每一条路由的鉴权前置上 —— 一次网络黑洞就能拖死整个 web 端)",
    ms < 5000);
  ok("只打了一次上游", fetchCount === 1);
  ok("请求带了 abort 信号（「有界」是靠它实现的，不是靠运气）", seen[0].hasSignal === true);
  ok(`★★★ 真的是 AbortSignal.timeout(${process.env.JWKS_TIMEOUT_MS}ms) 掐掉的，`
    + `不是测试桩自己那个 ${GUARD_MS}ms 兜底（没这条，超时压根没接上也能骗过上面那条"有界"）`,
    abortedBySignal === 1 && ms < GUARD_MS);
  ok("URL 是标准 well-known 路径",
    seen[0].url === `${ISS}/.well-known/jwks.json`);
}

/* ── ② 负缓存：刚失败过就不要再打上游 ────────────────────────────────── */
{
  const { err } = await verify(GOOD);
  ok("★★★ 失败后 30s 内不再打上游（没有这条，一次上游抖动会被我们放大成一场自我 DDoS）",
    err?.code === "jwks_unavailable" && fetchCount === 1);
}

/* ── ③ 退避窗口过后自动恢复 ──────────────────────────────────────────── */
{
  clock += 31 * 1000;
  mode = "ok";
  const { claims, err } = await verify(GOOD);
  ok("★★ 退避窗口过去后会重试并恢复（负缓存不能变成永久熔断）",
    !err && claims?.sub === "u-1" && fetchCount === 2);
}

/* ── ④ 不是放大器：未知 kid 绝不触发重新拉取 ─────────────────────────── */
{
  const before = fetchCount;
  const { err } = await verify(mint({ kid: "kid-does-not-exist" }));
  ok("★★★ 未知 kid → 拒，且**不**去刷新 JWKS（否则「随便编个 kid」就是一个免费的上游放大器）",
    /unknown kid/.test(String(err?.message)) && fetchCount === before);
}

/* ── ⑤ kid 是攻击者可控的字符串：原型链键不许变成"命中" ──────────────── */
for (const kid of ["__proto__", "constructor", "toString", "valueOf"]) {
  const { claims, err } = await verify(mint({ kid }));
  ok(`★★★ kid="${kid}" → unknown kid（普通对象上这些键取到的是 Object.prototype 上的真值，`
    + "`if (!jwk)` 那道门会直接失效；表必须是 Object.create(null)）",
    !claims && /unknown kid/.test(String(err?.message)));
}

/* ── ⑥ 刷新失败不许毁掉好表，且在 STALE 窗口内继续用旧表 ─────────────── */
{
  clock += 61 * 60 * 1000; // 过了 TTL(1h)，还在 STALE(24h) 内
  mode = "html"; // 上游回一页非 JWKS 的 JSON —— data.keys 是 undefined
  const before = fetchCount;
  const { claims, err } = await verify(GOOD);
  ok("★★★ 刷新失败**不**毁掉已有的好表（原来是先 `_jwks = {}` 再填充：上游回一页 HTML "
    + "就把表清空，之后所有 token 都成了 unknown kid —— 一次刷新失败把服务打成全员登不上）",
    !err && claims?.sub === "u-1");
  ok("确实去试过刷新（不是压根没到那一步）", fetchCount === before + 1);
}

/* ── ⑦ `{"keys":[]}` 不许进缓存 ─────────────────────────────────────── */
{
  clock += 31 * 1000; // 越过负缓存窗口，让它再试一次
  mode = "empty";
  const before = fetchCount;
  const { claims, err } = await verify(GOOD);
  ok("★★★ 空表算失败、旧表照旧可用（把 {\"keys\":[]} 当成功提交进去，"
    + "会把这个容器毒死一整个 TTL）",
    !err && claims?.sub === "u-1" && fetchCount === before + 1);
}

/* ── ⑧ 超过 STALE 窗口 → 回到 fail closed ───────────────────────────── */
{
  clock += 25 * 60 * 60 * 1000; // 旧表已经 26h 前的了，超出 STALE(24h)
  mode = "hang";
  const { claims, err } = await verify(GOOD);
  ok("★★★ 旧表超过 24h 后不再兜底 —— 回到拒绝（stale 兜底是有窗口的权衡，不是无限期放行）",
    !claims && err?.code === "jwks_unavailable");
}

/* ── ⑨ claims 与签名校验（表是新鲜的，以下都不该再打上游）────────────── */
{
  clock += 31 * 1000;
  mode = "ok";
  const warm = await verify(GOOD);
  ok("先把表烤热", !warm.err);
  const before = fetchCount;

  const cases = [
    ["缺 exp → 拒（原来写的是 `claims.exp && claims.exp < now`，不带 exp 的 token 被当成永不过期）",
      mint({ exp: undefined }), /token expired/],
    ["exp 不是数字 → 拒（「abc」 < now 在 JS 里是 false，一样能混过去）",
      mint({ exp: "abc" }), /token expired/],
    ["exp 是 NaN → 拒", mint({ exp: Number.NaN }), /token expired/],
    ["已过期 → 拒", mint({ exp: Math.floor(clock / 1000) - 10 }), /token expired/],
    ["iss 不对 → 拒（别的 user pool 签的 token 不能进来）",
      mint({ iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EVIL" }), /bad issuer/],
    ["accessToken 冒充 idToken → 拒", mint({ token_use: "access" }), /not an id token/],
    ["alg=none → 拒", mint({ alg: "none" }), /unexpected alg/],
    ["★★ alg=HS256 → 拒（经典的算法混淆：拿公钥当 HMAC 密钥签一个自己造的 token）",
      mint({ alg: "HS256" }), /unexpected alg/],
    ["★★ 用别的私钥签 → 拒（验签真的在跑，不是只看 header）",
      mint({ signWith: other.privateKey }), /bad signature/],
    ["不是三段 → 拒", "a.b", /malformed token/],
    ["空 token → 拒", "", /missing token/],
  ];
  for (const [name, tok, re] of cases) {
    const { claims, err } = await verify(tok);
    ok(name, !claims && re.test(String(err?.message)));
  }
  ok("★★ 以上失败一次都没去打上游（伪造 token 不该成为上游流量）", fetchCount === before);

  const { claims } = await verify(GOOD);
  ok("合法 token 仍然通过，claims 原样返回", claims?.sub === "u-1" && claims?.token_use === "id");
}

/* ── ⑩ 日志不许带上游 body ──────────────────────────────────────────── */
const src = readFileSync(join(HERE, "..", "jwt.mjs"), "utf8");
ok("失败日志只记异常**类型名**（上游 body 里可能带 user pool id / 内部报文）",
  /jwks fetch failed type=\$\{e\?\.constructor\?\.name/.test(src)
  && !/jwks fetch failed[\s\S]{0,80}e\?\.message/.test(src));
ok("★★ fetchJwks 只有一个调用点（getJwks）—— 多一个入口就意味着多一条绕过负缓存的路",
  (src.match(/fetchJwks\(/g) || []).length === 2);
ok("表用 Object.create(null) 建（第 ⑤ 组断言的实现依据）",
  /Object\.create\(null\)/.test(src));

/* ── ⑪ bearerFrom：Function URL 用 AWS_IAM 时 Authorization 被 SigV4 占了 ── */
ok("优先取自定义头 x-notiops-id-token",
  jwt.bearerFrom({ "x-notiops-id-token": "T1", authorization: "Bearer T2" }) === "T1");
ok("大小写变体也认", jwt.bearerFrom({ "X-Notiops-Id-Token": "T3" }) === "T3");
ok("回退认 Authorization: Bearer（本地/旧调用）",
  jwt.bearerFrom({ authorization: "Bearer T4" }) === "T4");
ok("Bearer 大小写不敏感", jwt.bearerFrom({ Authorization: "bearer T5" }) === "T5");
ok("什么都没有 → 空串（不抛）", jwt.bearerFrom({}) === "" && jwt.bearerFrom(null) === "");

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
