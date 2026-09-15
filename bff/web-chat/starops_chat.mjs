/**
 * 「STAROps 对话」—— 直连阿里云 **STAROps 数字员工** 的对话 API（`CreateChat`，SSE）。
 *
 * 目标是「在 NotiOps 网页里达到 STAROps 控制台的对话能力」：直接跟数字员工说话、让它自己
 * 发起巡检/调查、把它的思考与工具调用实时显示出来。**NotiOps 侧 0 token** —— 回答是
 * 客户自己的数字员工在生成（计客户的阿里云 AI 额度），我们只当传输层，与
 * [devops_chat.mjs](devops_chat.mjs)（AWS DevOps Agent 直连）完全同构：
 *
 *   浏览器 ──SSE── BFF ──SSE── STAROps CreateChat        （本模块，0 token）
 *   浏览器 ──SSE── BFF ──SSE── DevOps Agent SendMessage  （devops_chat.mjs，0 token）
 *   浏览器 ──SSE── BFF ── agent runtime ── Bedrock       （烧 token 的那条）
 *
 * 因此 SSE 事件与既有路径同形（token / progress / investigation_step / usage），前端渲染、
 * 右侧「调查过程」面板全部零改动复用；`usage` 恒为 `{totalTokens:0, direct:true}`。
 *
 * ── 责任划分（三个文件，一个都不许合并）────────────────────────────────
 *   [aliyun_signer.mjs](aliyun_signer.mjs)  签名（ACS3-HMAC-SHA256），纯函数，有官方测试向量
 *   [starops_sse.mjs](starops_sse.mjs)      响应流解析，纯函数，判据来自真实抓包
 *   本文件                                   请求编排 + 错误话术 + 多轮 thread 复用
 * 前两个刻意零依赖（可离线单测）；只有本文件碰 AWS SDK（读凭据/存 thread）。
 *
 * ── ✅ 已对真实服务验证（2026-09-13）─────────────────────────────────────
 * 🔁 这一段原来写的是「手上没有任何阿里云凭据，整条链路没有做过一次真实调用」。**已不成立**：
 * 2026-09-13 用一个专用 RAM 用户在真账号上跑通了全链路 —— 地域 `cn-beijing`、内置数字员工
 * `apsara-ops`，`GetDigitalEmployee` / `CreateThread` / `CreateChat` 三个 200 + 完整回答。
 * 分段验证仍然有效、别删：
 *   · 签名算法 = 官方固定参数测试向量逐字节一致（tests/aliyun_signer.test.mjs）
 *   · 请求形状 = 逐字抄自官方 OpenAPI 元数据（STAROps / 2026-04-28）
 *   · 响应解析 = 2026-09-09 从 STAROps 控制台抓到的真实事件流（tests/starops_sse.test.mjs）
 * 排障顺序（按实测重排过，别一上来就怀疑密钥）：
 *   0. 泛化的 **503 `ServiceUnavailable`**（正文是"服务临时故障"那句套话）→ 十有八九**不是**
 *      阿里云故障，而是 `CreateChat` 的**入参类型**错了：`variables` 里的值只要有一个是 number，
 *      阿里云就回这个 503 而不是 400（实测）。已由 buildVariables + 单测钉住，见那里的注释。
 *   1. `NoPermission` / `Forbidden.RAM` → 见下面 `ramHint`。真因几乎总是**自建**数字员工：
 *      官方策略 `AliyunSTAROpsReadOnlyAccess` 把 `starops:CreateThread` / `starops:CreateChat`
 *      的资源限定在 `digitalemployee/apsara-*`，非 `apsara-` 开头的员工被这条 ARN 前缀挡死
 *      （实测 403）。**补 `ram:PassRole` 治不了它** —— 那是另一回事，且我们没实测过。
 *   2. `SignatureDoesNotMatch`          → 先跑 tests/aliyun_signer.test.mjs；全绿就不是算法问题，
 *                                          查系统时钟（>15 分钟偏差直接拒）
 *   3. 404 `DigitalEmployeeNotExist`    → 数字员工 **ID**（大小写敏感）或地域不对（STAROps **只有** 2 个地域）。
 *                                          ⚠️ 最常见的填错法是把**显示名称**当 ID 填进来：`GetDigitalEmployee`
 *                                          回的 `displayName` 与 `name` 是**两个不同字段**，我们发出去的是 `name`
 *                                          （内置员工的 `name` 形如 `apsara-ops`，实测过）。控制台上那个显示名
 *                                          长什么样我们没实测，别在文案里替它编一个具体值。
 *   4. 连接超时                          → BFF 到 aliyuncs.com 的出网（Lambda 不在 VPC 里则正常有出网）
 *   ⚠️ 另有一条**不是权限**的坑：内置（`employeeType: "system"`）数字员工被 STAROps 自己的
 *      toolPolicy 禁掉了 OpenAPI 工具（逐字回过 "Aliyun CLI is forbidden for system employee"），
 *      它会回落到云监控资源中心去读。那与我们这副 AK 的 RAM 权限无关，别往权限上修。
 *
 * ── 🔒 日志纪律（docs/LOGGING_STANDARD.md）────────────────────────────
 *   · `accessKeySecret` 绝不进日志、不进异常、**连长度都不记**（由 aliyun_signer 保证）
 *   · 阿里云返回的 `message` **绝不外泄**（它会回显客户的输入）—— 只用 `code`
 *   · `workspace` 值里嵌着阿里云账号 UID（见 docs/_aliyun-m0-evidence §9）→ **不记**
 *   · `requestId` / `traceId` 可关联到具体请求 → 只在面板里给用户自己看，不进日志
 *   · 用户问题原文不进日志
 *
 * ARCC 未查询（MCP server 本次会话连不上）—— 按标准做法处理：凭据只读内存、只走 HTTPS、
 * 地域取值限定在枚举内（endpoint 主机名是拼出来的，见 starOpsHost 那段 SSRF 说明）。
 */
import { signRequest, roaPath, buildUrl } from "./aliyun_signer.mjs";
import { loadAliyunCredentials, STAROPS_REGIONS } from "./aliyun_config.mjs";
import { getStarOpsThread, setStarOpsThread, clearStarOpsThread } from "./store.mjs";
import { createStarOpsParser } from "./starops_sse.mjs";
import { makeSink } from "./devops_chat.mjs";
import { safeErr } from "./safe_err.mjs";

/** STAROps 的 API 版本（`x-acs-version`）。逐字来自官方 OpenAPI 元数据。 */
export const STAROPS_API_VERSION = "2026-04-28";

/**
 * STAROps **只有两个接口地域**。清单定义在 [aliyun_config.mjs](aliyun_config.mjs)（保存时
 * 就要能拒，且那边不能反向 import 本文件 —— 会成环），这里只转出去给调用方和单测用，
 * **不重新写一份**：两处各写一遍迟早漂移，而漂移的表现是一个语义不明的 404。
 *
 * ⚠️ 它是**接口地域**（数字员工资源在哪），不是**被巡检的地域**。客户资源常在
 * cn-hangzhou（M0 实证），那个值走 `variables.region`（= 通用 `region_id`）。
 */
export { STAROPS_REGIONS };
export const DEFAULT_STAROPS_REGION = "cn-beijing";

/** 数字员工名的形状。阿里云未公布规则，这里只挡住"明显不是名字"的东西
 *  （空、带斜杠/空白/`:`，说明客户粘错了整行）——它要被拼进 URL 路径。
 *  真正的编码由 `roaPath()` 负责，这道校验是为了**早失败、报得准**。 */
export const EMPLOYEE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** workspace / project 的形状：阿里云资源名字符集，禁止 `/`、空白、`#` 等能改写 URL 或
 *  被注入到 JSON 之外的字符。它们只进 body（JSON），所以风险低于地域，但仍然做校验 ——
 *  错值的表现是数字员工"什么都查不到"，那种症状极难归因。 */
export const WORKSPACE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** endpoint 主机名。地域不在允许清单里就**抛** —— 绝不回落到默认地域：
 *  静默回落会让客户在 Admin 里选的东西与实际请求的目标不一致（见「不许静默降级」）。 */
export function starOpsHost(region) {
  const r = String(region || "");
  if (!STAROPS_REGIONS.includes(r)) throw new Error(`starops_unsupported_region:${r || "empty"}`);
  return `starops.${r}.aliyuncs.com`;
}

/** 单轮对话的最长等待（秒）。BFF Lambda 平台硬顶 900s，保守 840s —— 与
 *  「DevOps 对话」/「深度调查（直连）」同一口径。超时不算失败：已流出的正文照样落库。 */
const MAX_WAIT_SEC = (() => {
  const n = parseInt(process.env.NOTIOPS_STAROPS_MAX_WAIT_SEC ?? "", 10);
  return Number.isFinite(n) ? n : 840;
})();

/** 「一个字节都没来」的容忍窗（秒）。**只在首个 chunk 之前**生效 —— 数字员工真干活时
 *  可能有很长的单个工具调用（实测单次 Bash 26.6s，串起来更久），那种安静不许被当成卡死。
 *  与 devops_chat.mjs 的 STALL_SEC 同一用意、同一取值。 */
const STALL_SEC = (() => {
  const n = parseInt(process.env.NOTIOPS_STAROPS_STALL_SEC ?? "", 10);
  return Number.isFinite(n) ? n : 120;
})();

/** 非流式请求（CreateThread / GetDigitalEmployee）的超时。这些是毫秒级的小调用，
 *  卡住 15s 还没回就没有再等的意义 —— 早失败早给话术。 */
const UNARY_TIMEOUT_MS = 15000;

/** 错误响应体的读取上限：出错时对方可能回一大坨 HTML（网关/WAF 页面），
 *  全读进来只是浪费内存 —— 我们只要那个 `code`。 */
const ERR_BODY_MAX = 4096;

/**
 * 组一个已签名的 STAROps 请求。**纯函数**（`date`/`nonce` 可注入）→ 可离线单测。
 *
 * @param {object} p
 * @param {string} p.action        `x-acs-action`，如 `CreateChat`
 * @param {string} p.method        HTTP 方法
 * @param {string} p.pathTemplate  逐字抄自 OpenAPI 的路径模板（⚠️ 驼峰/中划线不许统一）
 * @param {object} [p.pathParams]  路径参数（在 roaPath 里做 RFC3986 编码）
 * @param {object} [p.query]
 * @param {object} [p.bodyObj]     请求体对象；序列化**一次**，同一串既签名又发送
 * @param {object} p.creds         { accessKeyId, accessKeySecret, securityToken? }
 * @param {string} p.region        接口地域（必须在 STAROPS_REGIONS 里）
 * @returns {{ url: string, headers: object, body: string }}
 */
export function buildStarOpsRequest({
  action, method, pathTemplate, pathParams = {}, query = {}, bodyObj,
  creds, region, date, nonce,
}) {
  const host = starOpsHost(region);
  const canonicalUri = roaPath(pathTemplate, pathParams);
  // ⚠️ 序列化只发生在这一处：签名用的 hash 与真正发出去的字节必须是同一串
  //    （见 aliyun_signer.mjs 文件头 ⚠️5）。
  const body = bodyObj === undefined ? "" : JSON.stringify(bodyObj);

  const { headers } = signRequest({
    method, host, canonicalUri, query, body,
    action, version: STAROPS_API_VERSION,
    accessKeyId: creds.accessKeyId,
    accessKeySecret: creds.accessKeySecret,
    securityToken: creds.securityToken,
    date, nonce,
  });
  return { url: buildUrl({ host, canonicalUri, query }), headers, body };
}

/**
 * 从阿里云的错误响应里**只**取错误码。
 *
 * 🔒 `message` 一律丢掉：阿里云会把客户传的参数原样回显在 message 里，把它转给前端等于
 *    把输入反射回浏览器（docs/LOGGING_STANDARD.md：只报 code 和异常类型名）。
 *    解析不出来就用 `http_<状态码>` —— 永远给得出一个能对着查的短码。
 */
export function starOpsErrCode(status, text) {
  const s = String(text || "").slice(0, ERR_BODY_MAX);
  try {
    const j = JSON.parse(s);
    const code = String(j?.Code || j?.code || "").trim();
    if (code) return code;
  } catch { /* 不是 JSON（网关 HTML 页面之类）→ 退到状态码 */ }
  return `http_${status}`;
}

/**
 * 这个错误码是不是「thread 已经没了」。用于**一次**透明重建：thread 被阿里云侧删掉/过期后，
 * 留着旧 threadId 下一轮会原样再坏一次（客户看到的是"这个会话永久坏了"）。
 * 与 devops_chat.mjs 的 STALE_RE 同一用意。
 */
export const THREAD_GONE_RE = /NotFound|NotExist|Invalid.*Thread|Thread.*Invalid|Expired|Gone/i;

/** 权限类错误 → 给出**具体那条策略**。自建数字员工对话时必须有 `ram:PassRole`，
 *  漏了它的表现是一个笼统的鉴权失败，客户会去反复检查 AccessKey（换十次也没用）。 */
export const RAM_ERR_RE = /Forbidden|NoPermission|NotAuthorized|AccessDenied|Unauthorized/i;

/** 一次非流式调用。返回解析好的 JSON。失败抛 `Error`，`message` 只含**错误码**。 */
async function unary({ creds, region, action, method, pathTemplate, pathParams, query, bodyObj, fetchImpl }) {
  const f = fetchImpl || fetch;
  const { url, headers, body } = buildStarOpsRequest({
    action, method, pathTemplate, pathParams, query, bodyObj, creds, region,
  });
  // `host` 从发送头里去掉：Node 的 fetch(undici) 会自己按 URL 填 Host，手动塞可能被拒。
  // 签名里仍然签了 host —— 线上真正发出去的 Host 与被签的值一致，所以签名不受影响。
  const { host: _host, ...send } = headers;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UNARY_TIMEOUT_MS);
  let resp;
  try {
    resp = await f(url, { method, headers: send, body: body || undefined, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
  const text = await resp.text();
  if (!resp.ok) {
    const code = starOpsErrCode(resp.status, text);
    console.warn(`[starops] ${action} failed code=${code} status=${resp.status}`);
    throw Object.assign(new Error(code), { starOpsCode: code, httpStatus: resp.status });
  }
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}

/** 预检：这个数字员工存在吗。**便宜且指向明确** —— 名字/地域写错时给"找不到这个数字员工"，
 *  而不是让客户对着 CreateChat 的 404 猜是名字错、地域错还是没权限。 */
export async function getDigitalEmployee({ creds, region, employee, fetchImpl }) {
  return unary({
    creds, region, fetchImpl,
    action: "GetDigitalEmployee", method: "GET",
    // ⚠️ 中划线：`/digital-employee/{name}`。同一个产品里 thread 系列是驼峰
    //    `/digitalEmployee/{name}/thread` —— 阿里云自己不自洽，逐字抄，别统一。
    pathTemplate: "/digital-employee/{name}", pathParams: { name: employee },
  });
}

/** 新建一段会话（thread）。返回 threadId。 */
export async function createThread({ creds, region, employee, title, variables, fetchImpl }) {
  const r = await unary({
    creds, region, fetchImpl,
    action: "CreateThread", method: "POST",
    pathTemplate: "/digitalEmployee/{name}/thread", pathParams: { name: employee },
    bodyObj: { title: String(title || "NotiOps").slice(0, 80), ...(variables ? { variables } : {}) },
  });
  const id = String(r?.threadId || "");
  if (!id) throw Object.assign(new Error("create_thread_no_thread_id"), { starOpsCode: "InvalidResponse" });
  return id;
}

/** 请对方停止本轮生成（`action:"stop"`）。**尽力而为**：只在我们已经放弃等待时调用，
 *  目的是别让数字员工在客户账单上继续烧 AI 额度。语义未经实测，所以失败只记码、不影响回答。 */
export async function stopChat({ creds, region, employee, threadId, fetchImpl }) {
  try {
    await unary({
      creds, region, fetchImpl,
      action: "CreateChat", method: "POST", pathTemplate: "/chat",
      bodyObj: { digitalEmployeeName: employee, threadId, action: "stop" },
    });
    return true;
  } catch (e) {
    console.warn(`[starops] stop failed code=${e?.starOpsCode || safeErr(e)}`);
    return false;
  }
}

/**
 * 发一轮消息并把 SSE 实时转给前端。**本函数是这条链路的风险中心**，故独立可测
 * （`fetchImpl` 可注入一个吐手写字节流的假 fetch）。
 *
 * @returns {Promise<{done:boolean, timedOut:boolean, stalled:boolean, httpCode:string|null,
 *                    durationMs:number, success:boolean|null, requestId:string, traceId:string}>}
 *   `done` = 收到过 `stream_done`。**没收到就是不完整的一轮** —— 抓到的那份流里没有 `seq`
 *   （响应 schema 里写着有，抓包里根本没有），所以**我们这条路上**没有精确续传的依据：
 *   只能如实告诉用户这轮不完整，**绝不**把重连的内容拼到半截答案后面（那会造出一个看
 *   起来完整、实则中间少一段的答案，比明说失败糟得多）。
 *
 *   ⚠️ 别把这句写成"协议不支持续传"：官方 schema 里另有 `action:"reconnect"`，我们
 *      **没有实现**也**没有实测**。这是"我们不支持"，不是"它做不到"。
 */
export async function streamChat({
  creds, region, employee, threadId, text, variables, sink, en = false,
  maxWaitSec = MAX_WAIT_SEC, stallSec = STALL_SEC, fetchImpl, messageId,
}) {
  const f = fetchImpl || fetch;
  const { url, headers, body } = buildStarOpsRequest({
    creds, region,
    action: "CreateChat", method: "POST", pathTemplate: "/chat",
    bodyObj: {
      digitalEmployeeName: employee,
      threadId,
      action: "create",
      ...(variables ? { variables } : {}),
      messages: [{
        messageId: messageId || `notiops-${Date.now()}`,
        role: "user",
        contents: [{ type: "text", value: String(text || "") }],
      }],
    },
  });
  // `accept` 不在签名头集合里（只签 x-acs-* / host / content-type），加它不影响签名。
  const { host: _host, ...send } = headers;
  send.accept = "text/event-stream";

  const parser = createStarOpsParser(sink, {
    en,
    // 解析器的告警只记**内容形状**（未知类型名 / 版本号），不含用户文本，可以进日志。
    onWarn: (m) => console.warn(`[starops] wire: ${m}`),
  });

  let timedOut = false, stalled = false, httpCode = null;
  const ctrl = new AbortController();
  const hard = setTimeout(() => { timedOut = true; ctrl.abort(); }, maxWaitSec * 1000);
  let stall = setTimeout(() => { stalled = true; ctrl.abort(); }, stallSec * 1000);

  try {
    const resp = await f(url, { method: "POST", headers: send, body, signal: ctrl.signal });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      httpCode = starOpsErrCode(resp.status, t);
      console.warn(`[starops] CreateChat failed code=${httpCode} status=${resp.status}`);
      // 展开放在前面：`done` 等字段的**唯一权威**是解析器状态，不许被这里的局部变量盖住。
      return { ...parser.state, timedOut, stalled, httpCode };
    }
    if (!resp.body) {
      httpCode = "EmptyBody";
      return { ...parser.state, timedOut, stalled, httpCode };
    }
    const reader = resp.body.getReader();
    // ⚠️ `stream: true` 不是可选的：chunk 边界会切在一个 UTF-8 汉字的中间，
    //    每个 chunk 各自 decode 会在正文里留下 `` —— 而这是**中文界面**的默认情况。
    const dec = new TextDecoder("utf-8");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (stall) { clearTimeout(stall); stall = null; }   // 首个字节到了 → 撤掉卡死判定
      parser.push(dec.decode(value, { stream: true }));
      if (parser.state.done) break;                       // stream_done：不等对方关连接
    }
    parser.push(dec.decode());                            // 冲掉解码器里残留的半个字符
  } catch (e) {
    // AbortError = 我们自己掐的（超时/卡死）；其余是真的网络错。
    if (!timedOut && !stalled) {
      httpCode = safeErr(e);
      console.warn(`[starops] stream error ${httpCode}`);
    }
  } finally {
    clearTimeout(hard);
    if (stall) clearTimeout(stall);
    parser.end();                                          // 收尾：吐未收口的思考块、报未返回的工具
  }
  return { ...parser.state, timedOut, stalled, httpCode };
}

/**
 * 拼 `variables`。控制台会带上一串上下文，数字员工的内置技能靠它们定位"查哪儿"——
 * 缺了 workspace，ECS 巡检那类技能会以"什么都查不到"收场（症状极难归因）。
 *
 * 空值一律**不发**（而不是发空串）：发空串等于告诉对方"就是空的"，可能覆盖数字员工
 * 自己的默认规则。
 *
 * ⚠️ 所有值必须是**字符串**。2026-09-13 对 cn-beijing 真服务实测：`timeStamp` 传 number
 * 时 CreateChat 一律回 503 `ServiceUnavailable`（不是 400），文案是泛化的
 * "temporary failure of the server" —— 看着像阿里云故障，实际是入参类型错。
 * 同一把密钥、同一地域，只把 timeStamp 换成字符串就 200。以后往这里加字段，
 * 数字/布尔都要先 `String()`。
 * （⚠️ 实测只覆盖了 `timeStamp` 这一个字段；"任何 number 都会 503"是推断，别当实证写。）
 *
 * 🔒 `workspace` 的值里嵌着阿里云账号 UID（M0 实证 §9）→ 只进请求体，绝不进日志。
 */
export function buildVariables({ locale, region, workspace, project, now }) {
  const t = now instanceof Date ? now : new Date(now ?? Date.now());
  return {
    language: locale === "en" ? "en" : "zh",
    // 时区固定 Asia/Shanghai：STAROps 是阿里云的服务、时间轴按北京时间读最不容易误判
    // （Lambda 的 TZ 是 UTC，跟着它走会让"刚才那波报错"对不上客户看到的时间）。
    timeZone: "Asia/Shanghai",
    timeStamp: String(Math.floor(t.getTime() / 1000)),
    ...(region ? { region } : {}),
    ...(workspace ? { workspace } : {}),
    ...(project ? { project } : {}),
  };
}

/**
 * 读并校验 STAROps 所需的配置。返回 `null` = 没配好（调用方必须**当场失败**并把客户
 * 指到 Admin「多云」页，不许"跳过阿里云那部分继续答" —— 那是静默降级）。
 *
 * 返回 `{ creds, region, employee, workspace, project, inspectRegion }`。
 */
export async function loadStarOpsConfig() {
  const c = await loadAliyunCredentials();
  if (!c) return { ok: false, reason: "no_credentials" };
  const employee = String(c.staropsEmployee || "").trim();
  if (!employee) return { ok: false, reason: "no_employee" };
  if (!EMPLOYEE_RE.test(employee)) return { ok: false, reason: "bad_employee" };
  const region = String(c.staropsRegion || DEFAULT_STAROPS_REGION);
  if (!STAROPS_REGIONS.includes(region)) return { ok: false, reason: "bad_region" };
  const workspace = String(c.staropsWorkspace || "").trim();
  const project = String(c.staropsProject || "").trim();
  if (workspace && !WORKSPACE_RE.test(workspace)) return { ok: false, reason: "bad_workspace" };
  if (project && !WORKSPACE_RE.test(project)) return { ok: false, reason: "bad_project" };
  return {
    ok: true,
    creds: { accessKeyId: c.accessKeyId, accessKeySecret: c.accessKeySecret },
    region, employee, workspace, project,
    // 被巡检的地域（≠ 接口地域）。见 STAROPS_REGIONS 上面那段。
    inspectRegion: c.regionId || "",
  };
}

/* ───────────────── 可用性探测（前端「对话对象」选择器用）─────────────────
 * 前端在「新对话」里给出 notiops / devops / **starops** 三个对话对象。选了一个不可用的
 * 对象，用户要到**发出第一个问题之后**才知道 —— 那时他已经想好问题、打完字了。所以给一条
 * 便宜的探测路由，让选择器当场置灰并**说出缺哪一项**。
 *
 * ⚠️ 刻意**不搭「深度调查」那条探测的便车**：那条查的是 AWS DevOps Agent（Agent Space
 *    有没有接入），跟阿里云配置毫无关系。合成一条的后果是任一方没配就把两个都藏了。
 *
 * ⚠️ 探测**只读本地配置、不打阿里云**。理由有两条：
 *    · 打一次 GetDigitalEmployee 要签名 + 跨境往返（cn-beijing，几百毫秒起），而这条路由
 *      在每次打开选择器时都会被调用；
 *    · 权限/名字错的话，`runStarOpsChat` 的预检会在真正对话时给出**更具体**的话术
 *      （见上面那段预检）。探测的职责只是"有没有配"，不是"配得对不对"。
 *    代价说清楚：配好了但员工名写错 → 这里仍然显示"可用"，直到用户真的问一句。
 *
 * 🔒 只回 `available` / `reason` / `region` / `employee`。**绝不回 workspace**
 *    （值里嵌着阿里云账号 UID，见文件头），也绝不回任何凭据片段 —— 这条路由是
 *    「登录即可访问」的（authz.mjs 的 LOGIN_ONLY），不限管理员。
 */
export async function starOpsAvailability() {
  try {
    const cfg = await loadStarOpsConfig();
    if (!cfg.ok) return { available: false, reason: cfg.reason };
    // employee / region 回给前端只为在选择器上写清"跟哪个数字员工说话"（Admin 页本来就
    // 明文回显这两项）。它们不是凭据。
    return { available: true, employee: cfg.employee, region: cfg.region };
  } catch (e) {
    // 探测本身挂了（Secrets Manager 抖动/限流）→ **放行**。宁可让用户点进去看到真实报错，
    // 也不要因为一次抖动把功能藏起来（与 deepInvestigationAvailability 同一取舍）。
    return { available: true, probe_error: e?.name || "Error" };
  }
}

/** 「去配一下」的话术。**说清楚缺哪一项** —— 一句笼统的"未配置"会让客户把已经填好的
 *  AccessKey 又重填一遍。 */
function notConfiguredText(reason, en) {
  const where = en
    ? "Admin → Multi-cloud → Alibaba Cloud"
    : "管理后台 →「多云」→ 阿里云";
  const what = {
    no_credentials: [
      "还没有填阿里云 AccessKey（AccessKey ID + Secret 两个都要）",
      "the Alibaba Cloud AccessKey is not set (both the ID and the Secret are required)",
    ],
    // 🔴 说「ID」不说「名称」：控制台里要复制的是员工 ID（内置员工形如 `apsara-ops`，实测）。
    //    它的**显示名称**是另一个字段（`GetDigitalEmployee` 的 `displayName` ≠ `name`）——
    //    客户按"名称"去填显示名，换回来的是一个语义为空的 404，我们这边只能报"连不上"。
    //    文案与 Admin 页的字段标签必须是同一个词（见 i18n 的 admin.aliyun.so.employee）。
    no_employee: [
      "还没有填 STAROps **数字员工 ID**",
      "the STAROps **digital employee ID** is not set",
    ],
    bad_employee: [
      "填的 STAROps 数字员工 ID 格式不对（只允许字母、数字、`.`、`-`、`_`）",
      "the STAROps digital employee ID has an invalid format (letters, digits, `.`, `-`, `_` only)",
    ],
    bad_region: [
      `填的 STAROps 接口地域不在支持范围内（只有 ${STAROPS_REGIONS.join(" / ")}）`,
      `the STAROps API region is not supported (only ${STAROPS_REGIONS.join(" / ")})`,
    ],
    bad_workspace: ["填的 workspace 名称格式不对", "the workspace name has an invalid format"],
    bad_project: ["填的 project 名称格式不对", "the project name has an invalid format"],
  }[reason] || ["阿里云配置不完整", "the Alibaba Cloud configuration is incomplete"];
  return en
    ? `\n⚠️ Cannot talk to STAROps yet: ${what[1]}. Set it in **${where}**, then ask again.\n`
    : `\n⚠️ 还不能跟 STAROps 对话：${what[0]}。请到 **${where}** 填好后再问一次。\n`;
}

/**
 * `CreateThread` 失败时的第一句话。**权限类和非权限类必须分开说。**
 *
 * 🔴 2026-09-14 加。原先无论什么错都是「请稍后重试，或换回普通对话」—— 而权限被拒时
 * 紧接着还会补一段 `ramHint`（点名缺哪条策略）。两句话放在一起是自相矛盾的：前一句让人
 * 等一会儿再试，后一句让人去改 RAM。客户会先选便宜的那条（重试），重试一万次也不会好。
 * 用户本人就是这么踩的：原样拿到「创建 STAROps 会话失败（NoPermission）。请稍后重试」。
 *
 * 抽成纯函数是为了**能被测到** —— `runStarOpsChat` 要真跑起 Secrets Manager + 三个阿里云
 * 接口才走得到那个分支，单测里驱动不动，所以文案必须有一个不依赖传输层的入口。
 * `core/starops_chat.py::create_thread_fail_text` 是这个函数的**逐行对照实现**，改一边必须
 * 同时改另一边。
 *
 * @param {boolean} en    语言
 * @param {string}  code  阿里云错误码（`RAM_ERR_RE` 命中 ⇒ 走"重试不会好"那一句）
 */
export function createThreadFailText(en, code) {
  if (RAM_ERR_RE.test(String(code || ""))) {
    // 退路（换回普通对话）**必须留着** —— 去掉的只有那句"稍后重试"。
    return en
      ? `\n⚠️ Failed to create the STAROps thread (${code}) -- this is a PERMISSIONS problem, so retrying will not help. You can switch back to the standard chat for now.\n`
      : `\n⚠️ 创建 STAROps 会话失败（${code}）—— 这是**权限**问题，重试不会好。可以先换回普通对话。\n`;
  }
  return en
    ? `\n⚠️ Failed to create the STAROps thread (${code}). Retry later, or switch back to the standard chat.\n`
    : `\n⚠️ 创建 STAROps 会话失败（${code}）。请稍后重试，或换回普通对话。\n`;
}

/** 官方策略 `AliyunSTAROpsReadOnlyAccess` 把 `starops:CreateThread` / `starops:CreateChat` 的
 *  资源限定在 `acs:starops:*:*:digitalemployee/apsara-*`（逐字来自 `ram:GetPolicy`）。所以
 *  「员工名以 `apsara-` 开头」就是「内置员工 / 官方策略够用」的判据。ARN 匹配大小写敏感，
 *  这里刻意**不加** `i` —— 写成 `Apsara-` 的员工在阿里云那边同样对不上前缀。 */
const BUILTIN_EMPLOYEE_RE = /^apsara-/;

/**
 * 自建员工那条自定义策略的**完整可复制正文**（围栏 JSON）。
 *
 * 🔴 为什么错误信息里要放一整段 JSON，而不是用散文描述它：2026-09-14 用户原话 ——
 * 上一版把处方写成一段话（"Action 只放这两个、Resource 两条都写：`…/<员工名>` 和
 * `…/<员工名>/*`"），**可读性不强**，要照它拼出一份 RAM 策略得先在脑子里做一次翻译，
 * 而这一步正是客户最容易漏掉半条 ARN 的地方 —— 漏掉的表现就是原来那个 403，一模一样。
 * 给一段能整段粘进 RAM 控制台策略编辑器的正文，把那次翻译整个去掉。
 *
 * 这份形状**2026-09-14 在真账号上端到端跑通过**（`cn-beijing`，自建员工，
 * `GetDigitalEmployee` → `CreateThread` → `CreateChat` 全 200 并拿到完整回答）。
 * 里面的 ARN 刻意用 `acs:starops:*:*:` —— **跑通的就是这个形状**；把地域 / 账号 ID
 * 填成具体值是进一步收窄，我们**没实测过**，所以错误信息里不发那一版。
 *
 * 只需要三个 Action：`GetDigitalEmployee`（`Get*`）、`CreateThread`、`CreateChat`
 * —— 停止生成走的是 `CreateChat` + `body.action:"stop"`，不是另一个 RAM Action，
 * 所以这份策略是**自足**的（不挂官方那条也能跑通；挂了也不冲突）。
 *
 * ⚠️ 用 `JSON.stringify` 生成而不是拼字符串：员工名是客户填的自由文本，拼字符串一旦
 * 遇到引号就产出一份**语法坏掉的 JSON**，而客户会照着粘、然后卡在 RAM 控制台的报错上。
 * `core/starops_chat.py::_ram_policy_json` 用 `json.dumps(indent=2)` 产出**逐字节相同**
 * 的文本 —— 两边的判据可以互相对照。
 */
function ramPolicyJson(employee) {
  const arn = `acs:starops:*:*:digitalemployee/${employee}`;
  const doc = {
    Version: "1",
    Statement: [
      { Effect: "Allow", Action: ["starops:Get*", "starops:List*"], Resource: "*" },
      {
        Effect: "Allow",
        Action: ["starops:CreateChat", "starops:CreateThread"],
        Resource: [arn, `${arn}/*`],
      },
    ],
  };
  // 收尾**留一个空行**：紧贴围栏闭合的下一行会被一部分渲染器并进代码块的尾巴，
  // 而这里紧跟着的就是「两条 ARN 都要写」那句 —— 那句被吞掉，客户又只写一条。
  return "\n\n```json\n" + JSON.stringify(doc, null, 2) + "\n```\n\n";
}

/**
 * 权限失败时补一句**具体缺什么** —— 而且要按「内置 / 自建」分开说，因为修法完全不同。
 *
 * ✅ 2026-09-14 真因**已定**（同一副 AK、同一个自建员工，客户按两条 ARN 重配之后
 * `GetDigitalEmployee` → `CreateThread` → `CreateChat` 全 200、拿到完整回答）：缺的就是
 * **子资源那条 ARN**（`…/digitalemployee/<员工名>/*`）。当天曾经并列的另一种解释
 * （"那条策略压根没生效"）**不再是本条的开放问题** —— 但两处控制台自查仍然留在文案里：
 * 它们各自都能单独造成一模一样的 403，而客户第二次踩的时候我们没有第二次机会。
 *
 * 🔁 2026-09-13 重写。上一版逐字是「如果这是自建数字员工，RAM 用户还需要 `ram:PassRole`」——
 * 那是**错的归因**：实测自建员工（名字不以 `apsara-` 开头）在只挂官方策略时 `CreateThread`
 * 直接 403 `NoPermission`，真因是上面那条资源 ARN 前缀，补 `PassRole` 治不了。把客户往
 * `PassRole` 上引的代价很实在：他会去改一个不相干的授权，改完还是 403，然后怀疑产品坏了。
 *
 * `ram:PassRole` 只在**错误码自己提到 RAM / PassRole** 时才补一句，并且**明说我们没实测过**：
 * 官方权限配置页写着「和数字员工对话时需要 PassRole」，但 `AliyunSTAROpsFullAccess` 里的
 * `PassRole` 是限定到服务关联角色 `AliyunServiceRoleForSTAROps` 的，不是员工自己的 `roleArn`；
 * 我们手上只有内置员工，无法证实自建员工到底需不需要它。
 *
 * @param {boolean} en   语言
 * @param {string} employee  数字员工名（决定说哪一半）
 * @param {string} [code]    阿里云错误码（决定要不要补 PassRole 那句）
 */
export function ramHint(en, employee, code = "") {
  const builtin = BUILTIN_EMPLOYEE_RE.test(String(employee || ""));
  const passRole = /RAM|PassRole/i.test(String(code));
  const parts = [];
  if (builtin) {
    parts.push(en
      ? "\n\nThis looks like a permissions gap. `" + employee + "` is a built-in digital employee, so one official policy is the whole grant: check that the RAM user owning this AccessKey has `AliyunSTAROpsReadOnlyAccess` attached (it already carries `starops:CreateThread` / `starops:CreateChat`). Account-wide read-only is not needed and does not help here."
      : "\n\n这看起来是权限没给够。`" + employee + "` 是**内置**数字员工，官方那一条策略就够：请确认这副 AccessKey 所属的 RAM 用户挂了 `AliyunSTAROpsReadOnlyAccess`（它自己就含 `starops:CreateThread` / `starops:CreateChat`）。挂账号级只读既不必要、也治不了这一条。");
  } else {
    parts.push(en
      ? "\n\nThis is a permissions gap, and the cause is precise: `" + employee + "` does not start with `apsara-`, so it is a CUSTOM digital employee, and the official `AliyunSTAROpsReadOnlyAccess` policy only grants `starops:CreateThread` / `starops:CreateChat` on `digitalemployee/apsara-*`. Attach one more custom policy to the SAME RAM user -- paste this as-is (verified end to end against a real account on 2026-09-14):"
      : "\n\n这是权限没给够，原因很具体：`" + employee + "` 不以 `apsara-` 开头，是**自建**数字员工，而官方策略 `AliyunSTAROpsReadOnlyAccess` 只把 `starops:CreateThread` / `starops:CreateChat` 授到 `digitalemployee/apsara-*`。请给**同一个 RAM 用户**再加一条自定义策略，下面这段可以**整段直接复制**（2026-09-14 在真账号上按这个形状端到端跑通过）：");
    parts.push(ramPolicyJson(employee));
    // 两条 ARN 缺一条就是原来那个 403 —— 这一句是**已实测的因果**，不是猜测，所以要留。
    parts.push(en
      ? "Both resource ARNs are required: the second one is the employee's sub-resources (threads), and we measured that leaving it out is still refused. Then make sure the policy is actually GRANTED to that RAM user (creating it is not enough), and that the version now in effect is this one -- Alibaba Cloud creates a NEW version on every edit. Do not widen `Resource` to `*`."
      : "两条 ARN **都要写**：第二条是这个员工的子资源（会话），实测少了它仍然被拒。粘好之后确认两件事：这条策略确实**授权给**了那个 RAM 用户（只「创建」不算），以及**当前生效的版本**就是这一版（阿里云每次编辑都新建一个版本）。别把 `Resource` 放宽成 `*`。");
  }
  if (passRole) {
    parts.push(en
      ? " If the extra policy is already in place and the error still mentions RAM/PassRole, Alibaba Cloud's permission-configuration page says chatting with a digital employee needs `ram:PassRole` on the role that employee uses -- scope it to that role, never `*`. We have NOT verified that one ourselves."
      : " 如果那条自定义策略已经加好、错误里仍然带 RAM/PassRole 字样：阿里云的权限配置页说和数字员工对话需要对**该员工所用角色**的 `ram:PassRole`，请限定到那个角色、不要写 `*`。⚠️ 这一条我们**没有实测过**。");
  }
  return parts.join("") + "\n";
}

/**
 * 「STAROps 对话」主流程。**NotiOps 侧 0 token**。
 *
 * @param {object} p
 * @param {string} p.text            用户原话
 * @param {string} p.locale          "zh" | "en"
 * @param {string} p.conversationId  NotiOps 会话 id（用来复用同一个 threadId → 多轮上下文）
 * @param {function} p.emit          (event, data) => void，写一条 SSE
 * @param {function} [p.fetchImpl]   测试接缝
 * @returns {Promise<string>}        落库用的 assistant 正文
 */
export async function runStarOpsChat({ text, locale, conversationId, emit, fetchImpl }) {
  const en = locale === "en";
  const dv = (zh, enStr) => (en ? enStr : zh);
  const sink = makeSink({ emit });
  const say = (s) => sink.say(s);
  // NotiOps 侧不烧 token —— 每条退出路径都必须发这一条（前端对 totalTokens:0 不画 token 徽章）。
  const finishUsage = () => emit("usage", { usage: { totalTokens: 0, cycles: 0, direct: true } });

  const cfg = await loadStarOpsConfig();
  if (!cfg.ok) {
    say(notConfiguredText(cfg.reason, en));
    finishUsage();
    return sink.reply;
  }
  const { creds, region, employee, workspace, project, inspectRegion } = cfg;
  const base = { creds, region, employee, fetchImpl };

  // 页脚署名要带上**数字员工 ID 的值**：这条回答是"客户账号里的哪一个数字员工"答的 ——
  // 一个阿里云账号可以有多个员工，纳管范围与答案质量完全不同，所以这是读答案时的必要坐标。
  // （这一位以前放的是 **AWS** 账号 ID，属跨云假信息，已删；见 Message.tsx 里的 🔴。）
  // 早发是故意的：放在预检**之前**，连不上时页脚也显示"刚才试的是哪个 ID"—— 那正是客户
  // 要拿去控制台核对的那个值。
  // 🔒 只发 `employee`。**绝不发 `workspace`**（它内嵌阿里云账号 UID，是管理员专属值）；
  //    `employee` 本身不是凭据，`/features/starops` 早就把它回给任何已登录用户了。
  emit("via", { via: "starops", employee });

  sink.progress(dv("正在连接 STAROps…", "Connecting to STAROps…"));

  // ── 预检 ──
  // 名字/地域错、或权限没给够时，这一步的错误比 CreateChat 的错误**指向明确得多**。
  // 一次 GET，几十毫秒，换来的是"客户知道该改哪个字段"。
  try {
    const emp = await getDigitalEmployee(base);
    const label = String(emp?.displayName || emp?.name || employee);
    sink.step(dv(`已连接数字员工「${label}」（${region}）`, `Connected to digital employee "${label}" (${region})`));
  } catch (e) {
    const code = e?.starOpsCode || safeErr(e);
    say(dv(
      `\n⚠️ 连不上 STAROps 数字员工 \`${employee}\`（${code}，地域 ${region}）。请确认：填的是控制台里的**数字员工 ID**（不是显示名称）且大小写一致、它就在这个地域、且这副 AccessKey 有 STAROps 的读取权限。\n`,
      `\n⚠️ Could not reach the STAROps digital employee \`${employee}\` (${code}, region ${region}). Check that this is the digital employee ID from the console (not its display name) with matching case, that it lives in this region, and that the AccessKey has STAROps read permissions.\n`));
    if (RAM_ERR_RE.test(code)) say(ramHint(en, employee, code));
    finishUsage();
    return sink.reply;
  }

  const variables = buildVariables({ locale, region: inspectRegion, workspace, project });

  // ── 多轮上下文：复用同一个 threadId ──
  // STAROps 的对话历史挂在 threadId 上，"接着上一句问"必须复用它。数字员工或地域变了
  // 就不能复用（老 thread 在新目标上不存在）—— 见 store.mjs::getStarOpsThread 的 ⚠️。
  let sess = null;
  try {
    sess = await getStarOpsThread(conversationId);
  } catch (e) {
    console.warn(`[starops] load_thread_failed ${safeErr(e)}`);  // 读不到就当新会话，不阻断
  }
  let threadId = (sess && sess.employee === employee && sess.region === region)
    ? String(sess.threadId || "") : "";
  const reused = !!threadId;

  const newThread = async () => {
    const id = await createThread({
      ...base,
      title: dv("NotiOps 对话", "NotiOps chat"),
      // CreateThread 的 variables 只认 workspace / project（元数据里就这两个字段）。
      variables: (workspace || project)
        ? { ...(workspace ? { workspace } : {}), ...(project ? { project } : {}) }
        : undefined,
    });
    await setStarOpsThread(conversationId, { threadId: id, employee, region })
      .catch((e) => console.warn(`[starops] save_thread_failed ${safeErr(e)}`));
    return id;
  };

  if (!threadId) {
    sink.progress(dv("正在创建会话…", "Creating the thread…"));
    try {
      threadId = await newThread();
    } catch (e) {
      const code = e?.starOpsCode || safeErr(e);
      say(createThreadFailText(en, code));
      if (RAM_ERR_RE.test(code)) say(ramHint(en, employee, code));
      finishUsage();
      return sink.reply;
    }
  }

  const prelude = sink.reply;   // 真正开始对话前已经写进气泡的内容（目前恒为空，留作将来）
  sink.progress(dv("已发送，STAROps 正在处理…", "Sent — STAROps is working…"));

  let res = await streamChat({ ...base, threadId, text, variables, sink, en });

  // 复用的 thread 已经不在了 → **透明**重建一次再问（对用户无感）。
  // 只在这一轮**一个字都还没吐**时才做，否则重试的内容会接在半截答案后面。
  if (reused && sink.reply === prelude && res.httpCode && THREAD_GONE_RE.test(res.httpCode)) {
    console.warn(`[starops] thread gone (${res.httpCode}) — creating a new one and retrying`);
    sink.step(dv("上一段会话已失效，正在新建会话重试（不带之前的上下文）…",
                 "The previous thread is gone — starting a new one and retrying (without the earlier context)…"));
    try {
      threadId = await newThread();
      res = await streamChat({ ...base, threadId, text, variables, sink, en });
    } catch (e) {
      console.warn(`[starops] recreate_thread_failed ${safeErr(e)}`);
    }
  }

  // ── 收尾话术：每一种坏法都要**说实话** ──
  if (res.httpCode) {
    say(dv(`\n\n⚠️ STAROps 未能完成本次回答（${res.httpCode}）。`,
            `\n\n⚠️ STAROps could not complete this answer (${res.httpCode}).`));
    if (RAM_ERR_RE.test(res.httpCode)) say(ramHint(en, employee, res.httpCode));
    // 会话已经不可用 → 丢掉它，让"再问一次"真的有意义（同 devops_chat 的契约）。
    if (THREAD_GONE_RE.test(res.httpCode)) {
      await clearStarOpsThread(conversationId).catch((e) => console.warn(`[starops] clear_thread_failed ${safeErr(e)}`));
      say(dv("\n\n已丢弃这个会话的上下文，**直接再问一次**即可（会从一段新会话开始）。",
              "\n\nThe stored thread has been discarded — **just ask again** (it will start a fresh thread)."));
    }
  } else if (res.stalled) {
    say(dv(`\n\n⚠️ STAROps 在 ${STALL_SEC} 秒内一个字节都没返回，本轮判定为卡住。请再问一次。`,
            `\n\n⚠️ STAROps sent nothing at all within ${STALL_SEC}s — treating this turn as stuck. Please ask again.`));
  } else if (res.timedOut) {
    say(dv(`\n\n⏳ 本轮等待超过 ${MAX_WAIT_SEC} 秒，先返回已生成的部分。`,
            `\n\n⏳ This turn exceeded ${MAX_WAIT_SEC}s; returning what was generated so far.`));
    // 我们不再等了，但对方还在跑、还在烧客户的 AI 额度 → 尽力让它停下。
    await stopChat({ ...base, threadId });
  } else if (!res.done) {
    // 连接结束但没有 `stream_done`。**必须说出来**：实测流里没有 `seq`，没有任何精确
    // 续传依据，把重连内容拼上去会造出一个"看起来完整、中间少一段"的答案。
    say(dv("\n\n⚠️ 与 STAROps 的连接提前结束，**本轮回答可能不完整**（上面已经显示的部分是真实返回的内容）。可以再问一次，或到 STAROps 控制台看这段会话的完整记录。",
            "\n\n⚠️ The connection to STAROps ended early, so **this answer may be incomplete** (what is shown above is what actually came back). Ask again, or open this thread in the STAROps console for the full record."));
  } else if (!sink.reply) {
    say(dv("\n（STAROps 本轮没有返回内容，请换个说法再试。）\n",
            "\n(STAROps returned no content this turn — try rephrasing.)\n"));
  }

  // 面板尾行：本轮耗时 + 请求标识。requestId / traceId 只给用户自己排查用
  // （🔒 不进日志），STAROps 工单里报这两个值能直接定位。
  if (res.durationMs > 0 || res.requestId) {
    const secs = res.durationMs > 0 ? `${(res.durationMs / 1000).toFixed(1)}s` : "";
    sink.step(dv(
      `本轮耗时 ${secs}${res.requestId ? ` · requestId ${res.requestId}` : ""}`,
      `Took ${secs}${res.requestId ? ` · requestId ${res.requestId}` : ""}`));
  }

  finishUsage();
  return sink.reply;
}
