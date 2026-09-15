/**
 * 阿里云 POP 网关签名 **ACS3-HMAC-SHA256**（V3 签名）—— 纯函数，只用 `node:crypto`。
 *
 * 为什么手写而不是装 `@alicloud/*` SDK：BFF 是个 Lambda zip，阿里云官方 Node SDK 一装
 * 就是一整棵 darabonba 依赖树（十几个包），而我们全部需求只有「给一个 ROA 请求算一个
 * Authorization 头」。这段算法是**公开且固定**的，官方还给了固定参数测试向量，所以自己
 * 实现 + 用那个向量钉住，比多背一棵依赖树更可控（也不用担心 SDK 漂移，见「不许静默降级」）。
 *
 * ⚠️ 这个文件是整条阿里云链路唯一「错一个字节就全废、而且报错还会指错方向」的地方：
 *    签名不对时阿里云回的是 `SignatureDoesNotMatch`，客户第一反应永远是「密钥填错了」，
 *    于是去重新生成 AccessKey —— 换十次也没用。所以每一条容易错的细节都在下面写清楚，
 *    并且都有 `tests/aliyun_signer.test.mjs` 里的一条断言看着：
 *
 *  1. **RFC3986 ≠ encodeURIComponent**。后者放过 `!'()*`。必须再把 `*` 编成 `%2A`、
 *     把 `%7E` 还原成 `~`（`~` 是 unreserved，编了就不对）。
 *  2. **ROA 的 CanonicalURI 是「已经编码好的 pathname」，原样参与签名，不许再编一次**。
 *     所以路径参数在**拼接时**编码（`roaPath()`），拼完的字符串既拿去发请求、也拿去签名。
 *     再编一次 = `%2F` 变 `%252F` = 签名失败，症状同上（指向"密钥错")。
 *  3. **`content-type` 必须进签名头集合**。它不是 `x-acs-*`，最容易被漏掉；带 JSON body
 *     却不签 content-type，必然 `SignatureDoesNotMatch`。
 *  4. **`x-acs-content-sha256` 必须等于 body 的 hash，并且它自己也要被签**。
 *  5. **body 要按发出去的**字节**算 hash**。所以本模块只接受**字符串** body ——
 *     调用方 `JSON.stringify` 一次，同一个字符串既算 hash 又发出去。传对象进来会导致
 *     "签的是一种序列化、发的是另一种"，键顺序一变就挂。
 *  6. **`x-acs-date` 必须是 `yyyy-MM-ddTHH:mm:ssZ`（UTC、无毫秒）**，且与服务端时钟差
 *     不得超过 15 分钟。`new Date().toISOString()` 带 `.000` 毫秒 —— 必须削掉。
 *  7. **nonce 每个请求都必须不同**（服务端拿它防重放）。
 *
 * 🔒 日志纪律（docs/LOGGING_STANDARD.md）：本模块**不打任何日志**。
 *    `accessKeySecret` 不进日志、不进异常 message、**连长度都不记**。抛出的错误只有
 *    固定字符串（`aliyun_signer_missing_credentials` 之类），绝不回显任何入参值。
 *    `canonicalRequest` / `stringToSign` 会被返回（单测要逐字节比），但它们只是**给测试用**的
 *    —— 生产代码路径上不许打印（里面有 AccessKey **ID** 和请求体 hash）。
 *
 * ARCC 未查询（MCP server 连接失败）—— 按标准做法处理凭据：只读内存、不落盘、不日志。
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

/** 空 body 的 SHA256（十六进制小写）。写成常量是为了让「空 body 也要有 content-sha256」
 *  这件事在代码里显眼 —— 漏了这个头就是签名失败。 */
export const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** RFC3986 百分号编码。unreserved = `A-Za-z0-9 - _ . ~`，其余全编。
 *  见文件头 ⚠️1：`encodeURIComponent` 放过 `!'()*`，`*` 必须编成 `%2A`。 */
export function rfc3986(v) {
  return encodeURIComponent(String(v ?? ""))
    .replace(/[!'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/\*/g, "%2A")
    .replace(/%7E/g, "~");
}

/** 十六进制小写 SHA256。入参是**字符串**（见文件头 ⚠️5）。 */
export function hexSha256(payload = "") {
  return createHash("sha256").update(String(payload ?? ""), "utf8").digest("hex");
}

/**
 * CanonicalQueryString：按参数名升序，名和值都 RFC3986 编码，`=` 连接、`&` 拼接。
 * 无查询参数时是**空字符串**（不是 `?`、也不是省略这一行）。
 *
 * `undefined` / `null` 的参数**整条丢掉**（"没传这个参数"），而空串 `""` 是**传了但为空**
 * —— 两者签名结果不同，所以不能合并处理。
 */
export function canonicalQueryString(query = {}) {
  const keys = Object.keys(query || {}).filter((k) => query[k] !== undefined && query[k] !== null);
  keys.sort();
  return keys.map((k) => `${rfc3986(k)}=${rfc3986(query[k])}`).join("&");
}

/**
 * CanonicalHeaders / SignedHeaders。
 *
 * 只签三类头：`x-acs-*`、`host`、`content-type`（见文件头 ⚠️3）。名字小写、值 trim、
 * 按名升序；CanonicalHeaders 每条后面**都**跟一个 `\n`，SignedHeaders 用 `;` 连。
 * 空值的头丢掉 —— 发不出去的头不能进签名。
 */
export function canonicalHeaders(headers = {}) {
  const pick = [];
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName).toLowerCase();
    if (name === "authorization") continue;                       // 签名本身不参与签名
    if (!(name.startsWith("x-acs-") || name === "host" || name === "content-type")) continue;
    const value = String(rawValue ?? "").trim();
    if (!value) continue;
    pick.push([name, value]);
  }
  pick.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: pick.map(([n, v]) => `${n}:${v}\n`).join(""),
    signed: pick.map(([n]) => n).join(";"),
  };
}

/**
 * 拼 ROA 风格的 pathname，路径参数在**这里**做 RFC3986 编码 —— 之后原样用于发送与签名
 * （见文件头 ⚠️2）。模板里的 `{name}` 用 `params.name` 替换。
 *
 * ⚠️ 阿里云的路径模板本身**不自洽**（`/digitalEmployee/{name}/thread` 是驼峰，
 *    `/digital-employee/{name}` 是中划线），所以模板必须逐字从 OpenAPI 元数据抄，
 *    绝不"顺手统一风格"。
 *
 * 缺参数直接抛：拼出 `/digitalEmployee/undefined/thread` 这种路径只会换来一个
 * 语义不明的 404，查起来比当场报错贵得多。
 */
export function roaPath(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_m, key) => {
    const v = params[key];
    if (v === undefined || v === null || v === "") {
      throw new Error(`aliyun_signer_missing_path_param:${key}`);
    }
    return rfc3986(v);
  });
}

/** `x-acs-date` 的格式：UTC、秒级、无毫秒（见文件头 ⚠️6）。 */
export function acsDate(when = new Date()) {
  return new Date(when).toISOString().replace(/\.\d+Z$/, "Z");
}

/** 每请求唯一的 nonce（见文件头 ⚠️7）。32 位十六进制，与官方示例同形。 */
export function acsNonce() {
  return randomUUID().replace(/-/g, "");
}

/**
 * 给一个 POP 请求算出完整的请求头（含 `Authorization`）。
 *
 * @param {object}  p
 * @param {string}  p.method            HTTP 方法（大写）
 * @param {string}  p.host              如 `starops.cn-beijing.aliyuncs.com`
 * @param {string}  p.canonicalUri      **已编码**的 pathname（RPC 风格固定 `/`，ROA 用 roaPath()）
 * @param {object}  [p.query]           查询参数（值 undefined/null 的会被丢掉）
 * @param {string}  [p.body]            请求体**字符串**（见文件头 ⚠️5）
 * @param {string}  p.action            `x-acs-action`
 * @param {string}  p.version           `x-acs-version`
 * @param {string}  p.accessKeyId
 * @param {string}  p.accessKeySecret
 * @param {string}  [p.securityToken]   用 STS 临时凭据时必带
 * @param {string}  [p.contentType]     有 body 时默认 `application/json; charset=utf-8`
 * @param {object}  [p.extraHeaders]    额外的 `x-acs-*` 头（会一并签名）
 * @param {Date|string} [p.date]        仅测试注入
 * @param {string}  [p.nonce]           仅测试注入
 * @returns {{ headers: object, canonicalRequest: string, stringToSign: string, signature: string }}
 *   `canonicalRequest` / `stringToSign` 只给单测比对用 —— **生产路径不许打印**（见文件头 🔒）。
 */
export function signRequest({
  method, host, canonicalUri = "/", query = {}, body = "",
  action, version, accessKeyId, accessKeySecret, securityToken,
  contentType, extraHeaders = {}, date, nonce,
}) {
  // 参数缺失当场抛，且**只报字段名**（绝不回显值 —— 其中一个就是密钥）。
  if (!accessKeyId || !accessKeySecret) throw new Error("aliyun_signer_missing_credentials");
  if (!host) throw new Error("aliyun_signer_missing_host");
  if (!action || !version) throw new Error("aliyun_signer_missing_action_or_version");

  const m = String(method || "GET").toUpperCase();
  const payload = typeof body === "string" ? body : "";
  if (body && typeof body !== "string") throw new Error("aliyun_signer_body_must_be_string");
  const bodyHash = payload ? hexSha256(payload) : EMPTY_BODY_SHA256;

  const headers = {
    host,
    "x-acs-action": action,
    "x-acs-version": version,
    "x-acs-date": acsDate(date ?? new Date()),
    "x-acs-signature-nonce": nonce || acsNonce(),
    "x-acs-content-sha256": bodyHash,            // ⚠️4：必须与 body hash 一致，且要被签
    ...(securityToken ? { "x-acs-security-token": securityToken } : {}),
    ...extraHeaders,
  };
  // 有 body 才有 content-type；没 body 还发 content-type 也不算错，但保持与官方示例一致。
  if (payload) headers["content-type"] = contentType || "application/json; charset=utf-8";

  const { canonical, signed } = canonicalHeaders(headers);
  const canonicalRequest = [
    m,
    canonicalUri || "/",
    canonicalQueryString(query),
    canonical,
    signed,
    bodyHash,
  ].join("\n");

  const stringToSign = `ACS3-HMAC-SHA256\n${hexSha256(canonicalRequest)}`;
  const signature = createHmac("sha256", accessKeySecret).update(stringToSign, "utf8").digest("hex");

  // 三段之间**没有空格**（`Credential=…,SignedHeaders=…,Signature=…`），官方示例如此。
  headers.Authorization =
    `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signed},Signature=${signature}`;

  return { headers, canonicalRequest, stringToSign, signature };
}

/** 把 host / path / query 拼成最终 URL。query 的编码口径与签名**必须**一致，
 *  所以这里复用 `canonicalQueryString()` —— 两处各写一份编码迟早漂移，而漂移的表现
 *  又是 `SignatureDoesNotMatch`（指向"密钥错"）。 */
export function buildUrl({ host, canonicalUri = "/", query = {}, scheme = "https" }) {
  const qs = canonicalQueryString(query);
  return `${scheme}://${host}${canonicalUri || "/"}${qs ? `?${qs}` : ""}`;
}
