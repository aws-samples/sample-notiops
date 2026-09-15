/**
 * 阿里云 V3 签名（ACS3-HMAC-SHA256）单测。运行：node bff/web-chat/tests/aliyun_signer.test.mjs
 *
 * 这个文件存在的唯一理由：**我们没有阿里云凭据可以做端到端验证**。
 * 没有可用的账号去打一次真请求，就没有"线上验证"这条退路 —— 所以算法正确性只能靠
 * 阿里云官方文档里那组**固定参数测试向量**逐字节钉住（见下面 §1）。它给了中间结果
 * （HashedCanonicalRequest）和最终 Signature 两个值，所以出错时能立刻分辨是
 * 「规范化请求拼错了」还是「HMAC 那一步错了」，而不是只知道"签名不对"。
 *
 * ⚠️ §1 里的 AccessKeyId / AccessKeySecret 是**阿里云文档里的占位串**
 *    （字面量 `YourAccessKeyId` / `YourAccessKeySecret`），不是任何真实凭据。
 *    它们必须**逐字**保持原样 —— 改一个字符，向量就不再是向量。
 *
 * 其余每一节对应 `aliyun_signer.mjs` 文件头里的一个 ⚠️。那些坑的共同点是：
 * 错了以后阿里云只回一句 `SignatureDoesNotMatch`，而客户第一反应永远是"密钥填错了"，
 * 于是去重新生成 AccessKey —— 换十次也没用。所以宁可在这里多钉几条。
 */
import {
  rfc3986, hexSha256, canonicalQueryString, canonicalHeaders, roaPath,
  acsDate, acsNonce, signRequest, buildUrl, EMPTY_BODY_SHA256,
} from "../aliyun_signer.mjs";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`XX ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`XX ${name}`); } }
function throws(name, fn, re) {
  try { fn(); fail++; console.log(`XX ${name}: 没抛`); }
  catch (e) { if (re.test(String(e?.message || ""))) pass++; else { fail++; console.log(`XX ${name}: message=${e?.message}`); } }
}

/* ══════════════════ 1. 官方固定参数测试向量（唯一的正确性来源）══════════════════ */

const VECTOR = {
  method: "POST",
  host: "ecs.cn-shanghai.aliyuncs.com",
  canonicalUri: "/",
  query: {
    ImageId: "win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd",
    RegionId: "cn-shanghai",
  },
  body: "",                                     // 参数全在 query 里，body 为空
  action: "RunInstances",
  version: "2014-05-26",
  accessKeyId: "YourAccessKeyId",               // ← 官方文档的占位串，勿改（见文件头 ⚠️）
  accessKeySecret: "YourAccessKeySecret",       // ← 同上
  date: "2023-10-26T10:22:32Z",
  nonce: "3156853299f313e23d1673dc12e1703d",
};
const EXPECT_HASHED_CANONICAL = "7ea06492da5221eba5297e897ce16e55f964061054b7695beedaac1145b1e259";
const EXPECT_SIGNATURE = "06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0";

const v = signRequest(VECTOR);

// 先比中间结果：这一条红了 = CanonicalRequest 拼错（顺序/换行/编码），与 HMAC 无关。
eq("官方向量：HashedCanonicalRequest 逐字节一致", hexSha256(v.canonicalRequest), EXPECT_HASHED_CANONICAL);
// 再比最终值：上一条绿、这一条红 = HMAC 那一步或 StringToSign 前缀错了。
eq("官方向量：Signature 逐字节一致", v.signature, EXPECT_SIGNATURE);

// 把规范化请求整段钉住，出错时能直接看出是哪一行不对（比只有一个 hash 好定位得多）。
eq("官方向量：CanonicalRequest 全文", v.canonicalRequest, [
  "POST",
  "/",
  "ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai",
  "host:ecs.cn-shanghai.aliyuncs.com\n" +
  "x-acs-action:RunInstances\n" +
  `x-acs-content-sha256:${EMPTY_BODY_SHA256}\n` +
  "x-acs-date:2023-10-26T10:22:32Z\n" +
  "x-acs-signature-nonce:3156853299f313e23d1673dc12e1703d\n" +
  "x-acs-version:2014-05-26\n",
  "host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version",
  EMPTY_BODY_SHA256,
].join("\n"));
eq("StringToSign 前缀就是算法名 + 换行", v.stringToSign, `ACS3-HMAC-SHA256\n${EXPECT_HASHED_CANONICAL}`);
eq("Authorization 三段、逗号后无空格", v.headers.Authorization,
  `ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version,Signature=${EXPECT_SIGNATURE}`);
// 空 body 时不该凭空多一个 content-type（多签一个头就不是这个向量了）。
ok("空 body 不带 content-type", v.headers["content-type"] === undefined);

/* ══════════════════ 2. RFC3986 ≠ encodeURIComponent（⚠️1）══════════════════ */

eq("空格 → %20（不是 +）", rfc3986("a b"), "a%20b");
eq("星号 → %2A", rfc3986("*"), "%2A");
eq("波浪线保持原样（unreserved，编了就错）", rfc3986("~"), "~");
eq("!'() 都要编", rfc3986("!'()"), "%21%27%28%29");
eq("unreserved 一个都不编", rfc3986("aZ09-_.~"), "aZ09-_.~");
eq("斜杠要编（值里的 / 不是路径分隔符）", rfc3986("a/b"), "a%2Fb");
eq("中文按 UTF-8 编", rfc3986("巡检"), "%E5%B7%A1%E6%A3%80");
// 反例：只用 encodeURIComponent 的实现会在这三个字符上过关，然后线上 SignatureDoesNotMatch。
ok("encodeURIComponent 确实放过了 *!'()（说明为什么要包一层）",
  encodeURIComponent("*!'()") === "*!'()");

/* ══════════════════ 3. body hash（⚠️4 / ⚠️5）══════════════════ */

eq("空串的 SHA256 = 常量", hexSha256(""), EMPTY_BODY_SHA256);
{
  const body = JSON.stringify({ digitalEmployeeName: "aliyun-starops", action: "create" });
  const r = signRequest({ ...VECTOR, method: "POST", canonicalUri: "/chat", query: {}, body });
  eq("x-acs-content-sha256 == body 的 hash", r.headers["x-acs-content-sha256"], hexSha256(body));
  ok("有 body → content-type 自动补上", /application\/json/.test(r.headers["content-type"]));
  ok("content-type **在签名头集合里**（最常见的漏签）", r.canonicalRequest.includes("content-type:application/json"));
  ok("SignedHeaders 里也有 content-type",
    r.canonicalRequest.split("\n").some((l) => l.startsWith("content-type;")));
}
{
  // body 真的参与签名：改一个字，签名必须变。
  const a = signRequest({ ...VECTOR, canonicalUri: "/chat", query: {}, body: '{"a":1}' });
  const b = signRequest({ ...VECTOR, canonicalUri: "/chat", query: {}, body: '{"a":2}' });
  ok("body 变 → 签名变", a.signature !== b.signature);
}
throws("对象 body 直接拒（否则签的和发的可能不是同一串）",
  () => signRequest({ ...VECTOR, body: { a: 1 } }), /body_must_be_string/);

/* ══════════════════ 4. CanonicalQueryString ══════════════════ */

eq("按参数名升序（不是插入顺序）", canonicalQueryString({ b: "2", a: "1", C: "3" }), "C=3&a=1&b=2");
eq("名和值都编码", canonicalQueryString({ "a b": "c d" }), "a%20b=c%20d");
eq("没有参数 → 空串", canonicalQueryString({}), "");
eq("undefined 的参数整条丢掉", canonicalQueryString({ a: "1", b: undefined }), "a=1");
eq("null 同上", canonicalQueryString({ a: "1", b: null }), "a=1");
// 「没传」与「传了空值」签名不同 —— 合并处理会让一半请求签错。
eq("空串是传了但为空，保留", canonicalQueryString({ a: "1", b: "" }), "a=1&b=");
eq("数字值不特殊对待", canonicalQueryString({ maxResults: 100 }), "maxResults=100");
{
  const q = { nextToken: "a/b+c=", maxResults: 100 };
  ok("URL 与签名用同一套编码（两处各写一份必漂移）",
    buildUrl({ host: "h", canonicalUri: "/x", query: q }).endsWith("?" + canonicalQueryString(q)));
  eq("无 query 时 URL 不带问号", buildUrl({ host: "h", canonicalUri: "/x" }), "https://h/x");
}

/* ══════════════════ 5. CanonicalHeaders / SignedHeaders（⚠️3）══════════════════ */
{
  const h = canonicalHeaders({
    Host: "H.example.com", "X-Acs-Action": "A", "Content-Type": "application/json",
    Authorization: "should-not-be-signed", "x-request-id": "not-signed-either",
    "x-acs-empty": "", "x-acs-pad": "  v  ",
  });
  eq("只签 x-acs-* / host / content-type，名字小写、升序",
    h.signed, "content-type;host;x-acs-action;x-acs-pad");
  ok("Authorization 自己不参与签名", !h.canonical.includes("should-not-be-signed"));
  ok("非 x-acs 的自定义头不签", !h.canonical.includes("x-request-id"));
  ok("空值的头丢掉（发不出去的头不能进签名）", !h.canonical.includes("x-acs-empty"));
  ok("值要 trim", h.canonical.includes("x-acs-pad:v\n"));
  ok("每条后面都有换行", h.canonical.endsWith("\n"));
  // host 的**值**不做小写化（只有头名小写）；域名本来就小写，但不许多此一举地改值。
  ok("头值原样保留大小写", h.canonical.includes("host:H.example.com"));
}
{
  const r = signRequest({ ...VECTOR, securityToken: "sts-token-placeholder" });
  ok("STS 临时凭据的 token 进头", r.headers["x-acs-security-token"] === "sts-token-placeholder");
  ok("并且被签", r.canonicalRequest.includes("x-acs-security-token:sts-token-placeholder"));
  ok("不带 securityToken 时不该凭空多这个头", v.headers["x-acs-security-token"] === undefined);
}
{
  const r = signRequest({ ...VECTOR, extraHeaders: { "x-acs-instance-id": "i-1" } });
  ok("extraHeaders 里的 x-acs-* 也会被签", r.canonicalRequest.includes("x-acs-instance-id:i-1"));
}

/* ══════════════════ 6. ROA 路径：编一次，原样参与签名（⚠️2）══════════════════ */

eq("驼峰模板逐字保留（thread 系列是驼峰）",
  roaPath("/digitalEmployee/{name}/thread", { name: "aliyun-starops" }),
  "/digitalEmployee/aliyun-starops/thread");
// 同一个产品里 GetDigitalEmployee 用的是中划线 —— 阿里云自己不自洽，我们只能逐字抄。
eq("中划线模板也逐字保留（GetDigitalEmployee 是中划线）",
  roaPath("/digital-employee/{name}", { name: "aliyun-starops" }),
  "/digital-employee/aliyun-starops");
eq("多个占位符都替换",
  roaPath("/digitalEmployee/{name}/thread/{threadId}/data", { name: "e", threadId: "t-1" }),
  "/digitalEmployee/e/thread/t-1/data");
eq("路径参数里的斜杠被编码（不许穿越出这一段）",
  roaPath("/x/{n}", { n: "a/b" }), "/x/a%2Fb");
eq("空格编成 %20", roaPath("/x/{n}", { n: "a b" }), "/x/a%20b");
throws("缺路径参数当场抛（而不是拼出 /undefined/ 换一个语义不明的 404）",
  () => roaPath("/x/{n}", {}), /missing_path_param:n/);
throws("空串也算缺", () => roaPath("/x/{n}", { n: "" }), /missing_path_param:n/);
{
  // 已编码的 pathname 原样进签名：再编一次会变成 %252F，症状是"密钥错"。
  const p = roaPath("/x/{n}", { n: "a/b" });
  const r = signRequest({ ...VECTOR, canonicalUri: p, query: {} });
  eq("CanonicalURI 就是那个已编码的 pathname，一字不改", r.canonicalRequest.split("\n")[1], "/x/a%2Fb");
  ok("没有被二次编码", !r.canonicalRequest.includes("%252F"));
}

/* ══════════════════ 7. 时间与 nonce（⚠️6 / ⚠️7）══════════════════ */

eq("毫秒必须削掉（服务端只认秒级）", acsDate(new Date("2026-09-13T01:02:03.456Z")), "2026-09-13T01:02:03Z");
eq("已经是秒级的不受影响", acsDate("2023-10-26T10:22:32Z"), "2023-10-26T10:22:32Z");
ok("格式是 yyyy-MM-ddTHH:mm:ssZ", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(acsDate(new Date())));
ok("默认用当前时间（不传 date 也能签）", /^\d{4}-/.test(signRequest({ ...VECTOR, date: undefined }).headers["x-acs-date"]));
{
  const n1 = acsNonce(), n2 = acsNonce();
  ok("nonce 是 32 位十六进制", /^[0-9a-f]{32}$/.test(n1));
  ok("每次都不同（服务端拿它防重放）", n1 !== n2);
  const a = signRequest({ ...VECTOR, nonce: undefined });
  const b = signRequest({ ...VECTOR, nonce: undefined });
  ok("不传 nonce 时两次请求的签名不同", a.signature !== b.signature);
}
{
  // 同样的输入必须得到同样的签名 —— 否则单测本身没有意义。
  const a = signRequest(VECTOR), b = signRequest(VECTOR);
  eq("确定性：同输入同签名", a.signature, b.signature);
}

/* ══════════════════ 8. 缺参数 / 日志纪律 ══════════════════ */

throws("缺凭据当场抛", () => signRequest({ ...VECTOR, accessKeySecret: "" }), /missing_credentials/);
throws("缺 host", () => signRequest({ ...VECTOR, host: "" }), /missing_host/);
throws("缺 action", () => signRequest({ ...VECTOR, action: "" }), /missing_action_or_version/);
throws("缺 version", () => signRequest({ ...VECTOR, version: "" }), /missing_action_or_version/);
{
  // 🔒 异常 message 里绝不能出现密钥（哪怕是占位串）—— 它会被上层 safeErr 打进日志。
  let msg = "";
  try { signRequest({ ...VECTOR, host: "" }); } catch (e) { msg = String(e.message); }
  ok("异常 message 不含 AccessKeySecret", !msg.includes(VECTOR.accessKeySecret));
  ok("异常 message 是固定串、不回显入参", msg === "aliyun_signer_missing_host");
  // 签名里当然有 AccessKey **ID**（协议要求），但密钥本身任何一处都不该出现。
  ok("Authorization 不含密钥", !v.headers.Authorization.includes(VECTOR.accessKeySecret));
  ok("CanonicalRequest 不含密钥", !v.canonicalRequest.includes(VECTOR.accessKeySecret));
  ok("StringToSign 不含密钥", !v.stringToSign.includes(VECTOR.accessKeySecret));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
