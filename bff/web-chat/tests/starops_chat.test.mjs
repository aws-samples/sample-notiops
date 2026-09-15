/**
 * 「STAROps 对话」传输层单测。运行：node bff/web-chat/tests/starops_chat.test.mjs
 *
 * 这个文件的存在理由和 `aliyun_signer.test.mjs` 一样：用一个假 `fetch` 把「请求组得对不对」
 * 和「响应读得对不对」两件事**分别**钉死，这样一旦真实调用挂了，能立刻分辨是"我们组错了请求"
 * 还是"服务端不认这个参数"。
 *
 * 🔁 2026-09-13：这里原来写的是「我们没有阿里云凭据，整条链路一次真实调用都没打过」——
 * **已不成立**。当天用一个专用 RAM 用户在真账号上跑通了全链路（`cn-beijing` + 内置数字员工
 * `apsara-ops`，三个 API 全 200）。分段验证仍然值钱、别删：真实调用只覆盖了**成功那条路**，
 * 这里钉住的绝大多数是各种坏法（连接断、CJK 劈开、message 反射），真服务不会按需重现它们。
 * 实测反过来在这里留了两条钉子：`variables` 传 number 会换来泛化的 503（见 buildVariables 一节）、
 * 以及 `ramHint` 不许把自建员工的 403 归因到 `ram:PassRole`。
 *
 * 每一节对应 `starops_chat.mjs` 里的一处 ⚠️。重点是这几条**发出去就看不见**的错误：
 *   · CJK 被 chunk 边界劈开 → 正文里出现 `` （中文界面的默认情况，不是边角）
 *   · `host` 头手动塞给 undici → 请求直接被拒
 *   · 阿里云的 `message` 漏进响应 → 把客户输入反射回浏览器
 *   · 连接断了却当成正常结束 → 客户拿到一个"看起来完整、中间少一段"的答案
 *
 * ⚠️ 里面的 AccessKey 是**假串**（`LTAI-test-…` / `test-secret-…`），不是任何真实凭据；
 *    只有签名算法的**官方向量**在 aliyun_signer.test.mjs 里，那边才要求逐字不改。
 */
import {
  STAROPS_API_VERSION, STAROPS_REGIONS, EMPLOYEE_RE, WORKSPACE_RE,
  THREAD_GONE_RE, RAM_ERR_RE,
  starOpsHost, buildStarOpsRequest, starOpsErrCode, buildVariables,
  getDigitalEmployee, createThread, stopChat, streamChat, ramHint, createThreadFailText,
} from "../starops_chat.mjs";
import { hexSha256 } from "../aliyun_signer.mjs";
import { STAROPS_WIRE_VERSION } from "../starops_sse.mjs";

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; } else { fail++; console.log(`XX ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; console.log(`XX ${name}`); } }
async function throwsAsync(name, fn, re) {
  try { await fn(); fail++; console.log(`XX ${name}: 没抛`); }
  catch (e) { if (re.test(String(e?.message || ""))) pass++; else { fail++; console.log(`XX ${name}: message=${e?.message}`); } }
}

const CREDS = { accessKeyId: "LTAI-test-0123456789", accessKeySecret: "test-secret-not-a-real-key" };
const REGION = "cn-beijing";
const EMP = "aliyun-starops";
const THREAD = "thread-tl8ner-1owtwihkz5f6c";
const RID = "01A095CD-2D41-5843-A2E4-2280B9841CF5";
const TID = "fbd286ccccb34930a3e1f66cbcc5890e";

/** 与 devops_chat.mjs::makeSink 同契约的假 sink（duck-typed，同 starops_sse.test.mjs）。 */
function fakeSink() {
  const s = {
    reply: "", steps: [], progresses: [],
    say(t) { s.reply += t; },
    step(t, extra) { s.steps.push({ text: t, ...(extra || {}) }); },
    progress(t) { if (!s.reply) s.progresses.push(t); },
    gap() { if (s.reply && !/\n\n$/.test(s.reply)) s.say("\n\n"); },
  };
  return s;
}

/** 造一帧（`data:` 后无空格 —— 与实测一致）。 */
const frame = (payload, { callId = THREAD, role = "assistant" } = {}) =>
  "data:" + JSON.stringify({
    messages: [{ parentCallId: "", callId, role, version: STAROPS_WIRE_VERSION, timestamp: "1789219652666618780", ...payload }],
    requestId: RID, traceId: TID,
  }) + "\n";
const textFrame = (v) => frame({ contents: [{ type: "text", value: v, append: true, lastChunk: false }] });
const DONE = frame({ events: [{ type: "stream_done", payload: null }] }, { role: "system" });

/**
 * 假 fetch。`chunks` 是要吐出去的 **Uint8Array 或字符串** 序列。
 * 记录每次调用的 url / method / headers / body 供断言。
 */
function fakeFetch({ status = 200, chunks = [], text = "", noBody = false, hang = false } = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, ...init, headers: { ...(init?.headers || {}) } });
    const enc = new TextEncoder();
    const queue = chunks.map((c) => (typeof c === "string" ? enc.encode(c) : c));
    let i = 0;
    const body = {
      getReader() {
        return {
          read() {
            if (i < queue.length) return Promise.resolve({ value: queue[i++], done: false });
            if (!hang) return Promise.resolve({ value: undefined, done: true });
            // hang: 永远不再吐东西，只在 abort 时收场 —— 模拟"卡住"/"跑太久"。
            return new Promise((resolve) => {
              init.signal.addEventListener("abort", () => resolve({ value: undefined, done: true }), { once: true });
            });
          },
        };
      },
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      body: noBody ? null : body,
      text: async () => text,
    };
  };
  f.calls = calls;
  return f;
}

/* ══════════════════ 1. 地域 = 允许清单（SSRF 闸门）══════════════════ */

eq("只有两个接口地域", STAROPS_REGIONS, ["cn-beijing", "ap-southeast-1"]);
eq("endpoint 主机名", starOpsHost("cn-beijing"), "starops.cn-beijing.aliyuncs.com");
eq("新加坡也在清单里", starOpsHost("ap-southeast-1"), "starops.ap-southeast-1.aliyuncs.com");
for (const bad of ["cn-hangzhou", "", "evil.com", "cn-beijing.attacker.net", "CN-BEIJING"]) {
  let threw = false;
  try { starOpsHost(bad); } catch (e) { threw = /starops_unsupported_region/.test(e.message); }
  ok(`不在清单里就抛：${bad || "(空)"}`, threw);
}
// ⚠️ 关键：不许**静默回落**到默认地域 —— 那会让客户在 Admin 里选的目标和实际请求的目标
//    不一致（他改了下拉框，却什么都没变），属于「不许静默降级」。
ok("cn-hangzhou（被巡检地域）不能当接口地域用", !STAROPS_REGIONS.includes("cn-hangzhou"));

/* ══════════════════ 2. 名字校验：早失败、报得准 ══════════════════ */

ok("正常员工名过", EMPLOYEE_RE.test("aliyun-starops"));
ok("下划线点号过", EMPLOYEE_RE.test("my_emp.v2"));
ok("空不过", !EMPLOYEE_RE.test(""));
ok("带空格不过（整行粘错的典型）", !EMPLOYEE_RE.test("aliyun starops"));
ok("带斜杠不过（会改写 URL 路径语义）", !EMPLOYEE_RE.test("a/b"));
ok("带冒号不过", !EMPLOYEE_RE.test("emp:1"));
ok("workspace 同一套形状", WORKSPACE_RE.test("default-workspace") && !WORKSPACE_RE.test("has space"));

/* ══════════════════ 3. 组请求：路径逐字、body 只序列化一次 ══════════════════ */
{
  const r = buildStarOpsRequest({
    action: "CreateChat", method: "POST", pathTemplate: "/chat",
    bodyObj: { digitalEmployeeName: EMP, threadId: THREAD, action: "create" },
    creds: CREDS, region: REGION,
  });
  eq("URL", r.url, "https://starops.cn-beijing.aliyuncs.com/chat");
  eq("API 版本头", r.headers["x-acs-version"], STAROPS_API_VERSION);
  eq("版本是元数据里那个", STAROPS_API_VERSION, "2026-04-28");
  eq("action 头", r.headers["x-acs-action"], "CreateChat");
  ok("有 Authorization", /^ACS3-HMAC-SHA256 Credential=/.test(r.headers.Authorization));
  ok("有 host 头（签名要签它）", r.headers.host === "starops.cn-beijing.aliyuncs.com");
  // ⚠️5：签的 hash 必须就是发出去那一串的 hash。
  eq("content-sha256 == 实际 body 的 hash", r.headers["x-acs-content-sha256"], hexSha256(r.body));
  eq("body 是紧凑 JSON、字段顺序与传入一致", r.body,
    '{"digitalEmployeeName":"aliyun-starops","threadId":"thread-tl8ner-1owtwihkz5f6c","action":"create"}');
  ok("Authorization 里不含密钥", !r.headers.Authorization.includes(CREDS.accessKeySecret));
}
{
  // ⚠️2：路径模板逐字。这两条在阿里云自己那边就不自洽 —— 顺手"统一风格"就 404。
  const g = buildStarOpsRequest({
    action: "GetDigitalEmployee", method: "GET",
    pathTemplate: "/digital-employee/{name}", pathParams: { name: EMP },
    creds: CREDS, region: REGION,
  });
  ok("GetDigitalEmployee 是中划线", g.url.endsWith("/digital-employee/aliyun-starops"));
  const t = buildStarOpsRequest({
    action: "CreateThread", method: "POST",
    pathTemplate: "/digitalEmployee/{name}/thread", pathParams: { name: EMP },
    bodyObj: { title: "NotiOps" }, creds: CREDS, region: REGION,
  });
  ok("CreateThread 是驼峰", t.url.endsWith("/digitalEmployee/aliyun-starops/thread"));
  ok("空 body 时不发 content-type", g.headers["content-type"] === undefined);
  ok("有 body 时发 content-type", /application\/json/.test(t.headers["content-type"]));
}
{
  const q = buildStarOpsRequest({
    action: "GetThreadData", method: "GET",
    pathTemplate: "/digitalEmployee/{name}/thread/{threadId}/data",
    pathParams: { name: EMP, threadId: THREAD }, query: { maxResults: 100 },
    creds: CREDS, region: REGION,
  });
  ok("query 进 URL", q.url.endsWith("/data?maxResults=100"));
}
{
  let threw = false;
  try {
    buildStarOpsRequest({ action: "X", method: "GET", pathTemplate: "/x/{n}", creds: CREDS, region: REGION });
  } catch (e) { threw = /missing_path_param:n/.test(e.message); }
  ok("缺路径参数当场抛（不拼出 /undefined/ 换一个语义不明的 404）", threw);
}

/* ══════════════════ 4. 🔒 错误码：只取 Code，绝不外泄 message ══════════════════ */

eq("大写 Code", starOpsErrCode(403, '{"Code":"Forbidden.RAM","Message":"user xx is not authorized"}'), "Forbidden.RAM");
eq("小写 code 也认", starOpsErrCode(400, '{"code":"InvalidParameter"}'), "InvalidParameter");
eq("不是 JSON → 退到状态码", starOpsErrCode(502, "<html>bad gateway</html>"), "http_502");
eq("空体 → 状态码", starOpsErrCode(500, ""), "http_500");
eq("JSON 但没有 code → 状态码", starOpsErrCode(404, '{"RequestId":"x"}'), "http_404");
{
  // 这一条是本节的重点：阿里云会把客户传的参数回显在 Message 里。带出去 = 把输入反射回浏览器。
  const body = '{"Code":"InvalidParameter","Message":"digitalEmployeeName <script>alert(1)</script> not found"}';
  const code = starOpsErrCode(400, body);
  eq("只剩 code", code, "InvalidParameter");
  ok("不含 message 任何片段", !code.includes("script") && !code.includes("not found"));
}
ok("超长错误体不会被整段带出", starOpsErrCode(500, "x".repeat(100000)) === "http_500");

/* ══════════════════ 5. 错误分类：一个能给出**具体那条策略**，一个能自愈 ══════════════════ */

ok("RAM 类错误认得出（要补一句具体缺什么）", RAM_ERR_RE.test("Forbidden.RAM"));
ok("NoPermission 也算", RAM_ERR_RE.test("NoPermission"));
ok("AccessDenied 也算", RAM_ERR_RE.test("AccessDenied"));
ok("普通参数错不算权限错（否则会白给一段权限处方，把客户引到不相干的地方）",
  !RAM_ERR_RE.test("InvalidParameter"));

/* ── 5b. ramHint：**归因**必须对 ─────────────────────────────────────────────
 * 这一节钉的不是措辞，是"指向哪儿"。2026-09-13 实测：官方策略
 * `AliyunSTAROpsReadOnlyAccess` 把 CreateThread/CreateChat 的资源限定在
 * `digitalemployee/apsara-*`，所以**自建**员工（名字不以 apsara- 开头）会吃 403，
 * 而这跟 `ram:PassRole` 无关。上一版 ramHint 无条件说"你缺 PassRole" —— 客户照着改
 * 一个不相干的授权，改完还是 403，然后来报"产品坏了"。 */
for (const en of [false, true]) {
  const lang = en ? "en" : "zh";
  const custom = ramHint(en, "my-ops-agent", "NoPermission");
  ok(`${lang}: 自建员工不提 PassRole（错误码没提 RAM 时）`, !/PassRole/i.test(custom));
  ok(`${lang}: 自建员工点名那道 ARN 前缀`, custom.includes("apsara-"));
  ok(`${lang}: 自建员工给出的处方是那两个 Action`,
    custom.includes("starops:CreateThread") && custom.includes("starops:CreateChat"));
  ok(`${lang}: 处方里的 Resource 带上员工自己的名字（能直接抄）`,
    custom.includes("digitalemployee/my-ops-agent"));
  // 🔴 2026-09-14：处方**必须同时给子资源那一条**。用户照上一版（只有精确员工级 ARN）配完
  // 仍然 403 —— 而官方 `apsara-*` 里的 `*` 连 `/` 一起吃，所以内置员工顺带把子资源也覆盖了，
  // 精确 ARN 不会。少这一条，客户就会卡在"我明明照做了"上。
  ok(`${lang}: 处方同时给出子资源那一条 ARN`,
    custom.includes("digitalemployee/my-ops-agent/*"));
  // 而且不许顺手放宽成整个 starops 或所有员工 —— 那是我们自己在文档里明确劝退的做法。
  ok(`${lang}: 处方不把 Resource 放宽成 *`,
    !custom.includes("digitalemployee/*") && !custom.includes(":*:*:*"));
  // 照做仍然被拒时，得告诉他去看"授权了没 / 生效的是哪一版"，否则他只能干等。
  ok(`${lang}: 照做仍失败时指向 RAM 授权与生效版本`,
    en ? /GRANTED to that RAM user/.test(custom) && /version now in effect/.test(custom)
       : custom.includes("授权给") && custom.includes("当前生效的版本"));

  const builtin = ramHint(en, "apsara-ops", "NoPermission");
  ok(`${lang}: 内置员工只让人确认那条官方策略`,
    builtin.includes("AliyunSTAROpsReadOnlyAccess") && !/PassRole/i.test(builtin));
  // 内置员工那半边**可以**提这两个 Action（用来说明"官方那条已经含了它们"），但绝不能
  // 变成"再加一条自定义策略"的处方 —— 判据是有没有开出 Resource ARN 让人去抄。
  ok(`${lang}: 内置员工不被要求再加一条自定义策略（官方那条已经够）`,
    !builtin.includes("digitalemployee/"));

  // PassRole 只在错误码自己提到 RAM/PassRole 时才补，且必须标明「没实测过」。
  const ramCoded = ramHint(en, "my-ops-agent", "Forbidden.RAM");
  ok(`${lang}: 错误码提到 RAM 时才补 PassRole`, /PassRole/.test(ramCoded));
  ok(`${lang}: 补 PassRole 的同时说清我们没实测过`,
    en ? /have NOT verified/.test(ramCoded) : /没有实测过/.test(ramCoded));
  // 补 PassRole 时**必须**同时说"限定到那个角色"：这一句缺了，最省事的照做方式就是
  // `Resource: "*"`，等于教客户把 PassRole 开给全账号的角色。
  ok(`${lang}: 补 PassRole 时同时要求限定范围`,
    en ? /scope it to that role/.test(ramCoded) : /限定到那个角色/.test(ramCoded));
  // 而且不能只在自建那半边补 —— 内置员工若真吃到 RAM 错，也得能读到这一句。
  ok(`${lang}: 内置员工吃到 RAM 错时同样补得上`, /PassRole/.test(ramHint(en, "apsara-ops", "Forbidden.RAM")));
}
/* ── 5b-2. 自建员工的处方必须是**能整段复制的 JSON**，不是一段散文 ─────────────
 * 2026-09-14 用户原话：上一版那段处方「可读性不强」。照散文拼一份 RAM 策略要先在脑子里
 * 翻译一次，而那一步正是漏掉半条 ARN 的地方 —— 漏掉的表现就是原来那个 403。
 * 🔴 判据不是"有没有出现 json 三个字"，而是**那段围栏里的东西真能当策略用**：
 *    能被 JSON.parse、两条 ARN 都在、只有产品真正调的那几个 Action。 */
const fencedPolicy = (t) => {
  const m = /```json\n([\s\S]*?)\n```/.exec(t);
  return m ? JSON.parse(m[1]) : null;
};
for (const en of [false, true]) {
  const lang = en ? "en" : "zh";
  const doc = fencedPolicy(ramHint(en, "my-ops-agent", "NoPermission"));
  ok(`${lang}: 处方是一段围栏 JSON，且真能被解析`, doc !== null);
  ok(`${lang}: 是一份 RAM 策略（Version 1 + Statement 数组）`,
    doc.Version === "1" && Array.isArray(doc.Statement) && doc.Statement.length === 2);
  const create = doc.Statement.find((s) => String(s.Action).includes("CreateThread"));
  ok(`${lang}: 写操作那一段只放产品真正会调的两个 Action`,
    JSON.stringify(create.Action) === JSON.stringify(["starops:CreateChat", "starops:CreateThread"]));
  ok(`${lang}: 员工级与子资源两条 ARN 都在，且顺序是先粗后细`,
    JSON.stringify(create.Resource) === JSON.stringify([
      "acs:starops:*:*:digitalemployee/my-ops-agent",
      "acs:starops:*:*:digitalemployee/my-ops-agent/*"]));
  const read = doc.Statement.find((s) => String(s.Action).includes("Get*"));
  ok(`${lang}: 读那一段是 Get*/List*（GetDigitalEmployee 走它）`,
    JSON.stringify(read.Action) === JSON.stringify(["starops:Get*", "starops:List*"]));
  // 🔴 这份策略必须**自足** —— 客户只粘它就能跑通，不能悄悄依赖官方那条。产品全链路只调
  // 三个 Action（GetDigitalEmployee / CreateThread / CreateChat；停止生成是 CreateChat +
  // body.action:"stop"，不是另一个 RAM Action），所以"自足"是可以断言的。
  const granted = doc.Statement.flatMap((s) => [].concat(s.Action)).join(" ");
  ok(`${lang}: 三个真调用的 Action 都被这份策略覆盖`,
    /starops:Get\*/.test(granted) && /starops:CreateThread/.test(granted)
      && /starops:CreateChat/.test(granted));
  // 围栏之后那句"两条都要写"不能被吞进代码块 —— 少一个空行就会。
  ok(`${lang}: 围栏闭合后留了空行，后面那句解释还在正文里`,
    /```\n\n\S/.test(ramHint(en, "my-ops-agent", "NoPermission")));
}
// 员工名是客户填的自由文本 → 拼字符串会产出语法坏掉的 JSON，而客户会照着粘。
ok("员工名带引号时产出的仍是合法 JSON（用 JSON.stringify 生成，不是拼字符串）",
  fencedPolicy(ramHint(false, 'a"b', "NoPermission")).Statement[1].Resource[0]
    === 'acs:starops:*:*:digitalemployee/a"b');
// ARN 匹配大小写敏感 → `Apsara-` 在阿里云那边同样对不上前缀，必须按自建处理。
ok("大写 Apsara- 不当成内置（阿里云 ARN 匹配大小写敏感）",
  ramHint(false, "Apsara-ops", "NoPermission").includes("digitalemployee/Apsara-ops"));
// 员工名缺失时不许崩，也不许假装是内置。
ok("员工名为空时不崩、按自建处理", ramHint(false, "", "NoPermission").includes("apsara-"));

/* ── 5c. createThreadFailText：权限错**不许**说「请稍后重试」 ──────────────────
 * 2026-09-14 用户实测原样拿到的是「创建 STAROps 会话失败（NoPermission）。请稍后重试，
 * 或换回普通对话。」——而紧接着的 `ramHint` 让他去改 RAM 策略。两句话互相抵消，客户会先
 * 选便宜的那条（重试），而权限被拒重试一万次也不会好。
 * 🔴 判据是**这一句本身**，不是"有没有 ramHint"（ramHint 从来都在，问题出在前面那句）。 */
for (const en of [false, true]) {
  const lang = en ? "en" : "zh";
  const perm = createThreadFailText(en, "NoPermission");
  ok(`${lang}: 权限错不说"稍后重试"`,
    en ? !/[Rr]etry later/.test(perm) : !perm.includes("请稍后重试"));
  ok(`${lang}: 权限错明说这是权限问题、重试没用`,
    en ? /PERMISSIONS problem/.test(perm) && /will not help/.test(perm)
       : perm.includes("**权限**问题") && perm.includes("重试不会好"));
  ok(`${lang}: 错误码原样带出来（客户拿它去控制台核对）`, perm.includes("NoPermission"));
  // 去掉的只有"重试"，**退路不许一起去掉** —— 权限没配好的这段时间客户还得干活。
  ok(`${lang}: 权限错仍然给一条还能用的退路（换回普通对话）`,
    en ? /switch back to the standard chat/.test(perm) : perm.includes("换回普通对话"));

  // 反向：非权限错（例如限流、瞬时故障）**必须**保留"稍后重试"——那种情况重试真的有用。
  const tmp = createThreadFailText(en, "Throttling");
  ok(`${lang}: 非权限错仍然让人稍后重试`,
    en ? /[Rr]etry later/.test(tmp) : tmp.includes("请稍后重试"));
  ok(`${lang}: 非权限错不谎称是权限问题`,
    en ? !/PERMISSIONS problem/.test(tmp) : !tmp.includes("**权限**问题"));
}
// `RAM_ERR_RE` 的每一种拼法都要落到"重试不会好"那一句，否则这个修复只挡住了 NoPermission。
for (const code of ["NoPermission", "Forbidden.RAM", "AccessDenied", "NotAuthorized", "Unauthorized"]) {
  ok(`${code} 走的是"重试不会好"那一句`, createThreadFailText(false, code).includes("重试不会好"));
}
// 错误码为空 / undefined 时不许崩，也不许被当成权限错。
ok("错误码为空时按非权限错处理、不崩", createThreadFailText(false, "").includes("请稍后重试"));
ok("错误码 undefined 时不崩", createThreadFailText(false, undefined).includes("请稍后重试"));
ok("thread 没了认得出 → 会重建一次", THREAD_GONE_RE.test("ThreadNotFound"));
ok("Expired 也算", THREAD_GONE_RE.test("SessionExpired"));
ok("签名错**不算** thread 没了（重建 thread 治不了签名，只会白烧一次调用）",
  !THREAD_GONE_RE.test("SignatureDoesNotMatch"));
ok("限流不算", !THROTTLE_IS_THREAD_GONE());
function THROTTLE_IS_THREAD_GONE() { return THREAD_GONE_RE.test("Throttling"); }

/* ══════════════════ 6. variables：空值不发，别覆盖对方的默认规则 ══════════════════ */
{
  const v = buildVariables({ locale: "zh", region: "cn-hangzhou", workspace: "ws-1", project: "p-1", now: 1789219652666 });
  eq("语言", v.language, "zh");
  eq("时区固定北京（Lambda 是 UTC，跟着它走会让时间轴和客户看到的对不上）", v.timeZone, "Asia/Shanghai");
  eq("时间戳是秒", v.timeStamp, "1789219652");
  // ⚠️ 类型也是判据，不只是值：2026-09-13 对 cn-beijing 真服务实测——timeStamp 传 number
  // 时 CreateChat 一律回 503 ServiceUnavailable（**不是** 400），报错文案是泛化的
  // "temporary failure of the server"，看上去像阿里云故障，实际是入参类型。
  // 改成 Number 会让现网 STAROps 对话 100% 挂掉且极难归因 —— 别"优化"掉这个 String()。
  eq("时间戳必须是字符串（传 number → 503，见上）", typeof v.timeStamp, "string");
  eq("被巡检地域走 region（≠ 接口地域）", v.region, "cn-hangzhou");
  eq("字段齐", Object.keys(v).sort(), ["language", "project", "region", "timeStamp", "timeZone", "workspace"]);
  const en = buildVariables({ locale: "en", now: 0 });
  eq("英文", en.language, "en");
  eq("空值一个都不发（发空串等于告诉对方'就是空的'）", Object.keys(en).sort(), ["language", "timeStamp", "timeZone"]);
}

/* ══════════════════ 7. 非流式调用 ══════════════════ */
{
  const f = fakeFetch({ text: JSON.stringify({ requestId: RID, name: EMP, displayName: "巡检助手", regionId: "cn-beijing" }) });
  const emp = await getDigitalEmployee({ creds: CREDS, region: REGION, employee: EMP, fetchImpl: f });
  eq("GetDigitalEmployee 解析出 displayName", emp.displayName, "巡检助手");
  eq("方法是 GET", f.calls[0].method, "GET");
  // ⚠️ host 头必须在发出去之前摘掉：undici 会按 URL 自己填 Host，手动塞可能被拒；
  //    签名里仍然签了它，所以摘掉不影响验签。
  ok("发送头里没有 host", f.calls[0].headers.host === undefined);
  ok("发送头里有 Authorization", !!f.calls[0].headers.Authorization);
  ok("GET 不带 body", f.calls[0].body === undefined);
}
{
  const f = fakeFetch({ text: JSON.stringify({ requestId: RID, threadId: THREAD }) });
  const id = await createThread({
    creds: CREDS, region: REGION, employee: EMP, title: "NotiOps 对话",
    variables: { workspace: "ws-1" }, fetchImpl: f,
  });
  eq("拿到 threadId", id, THREAD);
  const body = JSON.parse(f.calls[0].body);
  eq("标题带上", body.title, "NotiOps 对话");
  eq("CreateThread 的 variables 只有 workspace/project", body.variables, { workspace: "ws-1" });
  ok("URL 是驼峰 thread 路径", f.calls[0].url.endsWith("/digitalEmployee/aliyun-starops/thread"));
}
await throwsAsync("CreateThread 回了 200 但没有 threadId → 抛（别拿 undefined 去发下一个请求）",
  () => createThread({ creds: CREDS, region: REGION, employee: EMP, fetchImpl: fakeFetch({ text: "{}" }) }),
  /create_thread_no_thread_id/);
await throwsAsync("非 2xx → 抛，且 message 就是错误码本身",
  () => createThread({
    creds: CREDS, region: REGION, employee: EMP,
    fetchImpl: fakeFetch({ status: 403, text: '{"Code":"Forbidden.RAM","Message":"user is not authorized to PassRole"}' }),
  }),
  /^Forbidden\.RAM$/);
{
  // 🔒 抛出来的异常会被上层 safeErr 打进日志 —— 里面绝不能带 message 原文。
  let msg = "";
  try {
    await createThread({
      creds: CREDS, region: REGION, employee: EMP,
      fetchImpl: fakeFetch({ status: 400, text: '{"Code":"InvalidParameter","Message":"secret leaked here"}' }),
    });
  } catch (e) { msg = String(e.message); }
  ok("异常 message 不含服务端 message", !msg.includes("secret leaked here"));
}
{
  // stop 是**尽力而为**：失败只记码、绝不影响已经给出的回答。
  const okF = fakeFetch({ text: "{}" });
  eq("stop 成功", await stopChat({ creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, fetchImpl: okF }), true);
  eq("stop 的 action 字段", JSON.parse(okF.calls[0].body).action, "stop");
  eq("stop 走的还是 /chat", new URL(okF.calls[0].url).pathname, "/chat");
  const badF = fakeFetch({ status: 500, text: "boom" });
  eq("stop 失败不抛、返回 false", await stopChat({ creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, fetchImpl: badF }), false);
}

/* ══════════════════ 8. streamChat：请求形状 ══════════════════ */
{
  const sink = fakeSink();
  const f = fakeFetch({ chunks: [textFrame("好的"), DONE] });
  const res = await streamChat({
    creds: CREDS, region: REGION, employee: EMP, threadId: THREAD,
    text: "帮我看看 ECS 有没有问题", variables: { language: "zh" }, sink, fetchImpl: f, messageId: "m-1",
  });
  const body = JSON.parse(f.calls[0].body);
  eq("员工名", body.digitalEmployeeName, EMP);
  eq("threadId", body.threadId, THREAD);
  eq("action=create", body.action, "create");
  eq("variables 原样带上", body.variables, { language: "zh" });
  eq("消息结构（messages[].contents[].type/value）", body.messages,
    [{ messageId: "m-1", role: "user", contents: [{ type: "text", value: "帮我看看 ECS 有没有问题" }] }]);
  // accept 刻意**不签**（签名头集合只含 x-acs-* / host / content-type），加它不影响验签。
  eq("accept: text/event-stream", f.calls[0].headers.accept, "text/event-stream");
  ok("发送头里没有 host", f.calls[0].headers.host === undefined);
  eq("正文流出来了", sink.reply, "好的");
  eq("收到 stream_done → 这一轮是完整的", res.done, true);
  eq("requestId 带回来（客户报工单要用）", res.requestId, RID);
  eq("traceId 也带回来", res.traceId, TID);
  eq("没超时", [res.timedOut, res.stalled, res.httpCode], [false, false, null]);
}

/* ══════════════════ 9. ⚠️ CJK 被 chunk 边界劈开（中文界面的默认情况）══════════════════ */
{
  // 把整条 SSE 编成字节后，在**一个汉字的中间**切开。逐 chunk 各自 decode 会得到 ``。
  const whole = new TextEncoder().encode(textFrame("巡检结果正常") + DONE);
  const mid = whole.indexOf(new TextEncoder().encode("巡检结果正常")[0]) + 4; // 落在某个汉字的字节中间
  const res = await (async () => {
    const sink = fakeSink();
    const r = await streamChat({
      creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, text: "x", sink,
      fetchImpl: fakeFetch({ chunks: [whole.slice(0, mid), whole.slice(mid)] }),
    });
    return { sink, r };
  })();
  eq("跨 chunk 的汉字拼得回来", res.sink.reply, "巡检结果正常");
  ok("正文里没有替换字符 ", !res.sink.reply.includes("�"));
  eq("仍然收到 stream_done", res.r.done, true);
}
{
  // 逐字节喂（最恶劣的切法）也必须完好 —— 顺带证明帧边界与 chunk 边界无关。
  const bytes = new TextEncoder().encode(textFrame("巡检完成，无异常。") + DONE);
  const sink = fakeSink();
  const r = await streamChat({
    creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, text: "x", sink,
    fetchImpl: fakeFetch({ chunks: Array.from(bytes, (b) => new Uint8Array([b])) }),
  });
  eq("逐字节喂也完好", sink.reply, "巡检完成，无异常。");
  eq("done", r.done, true);
}

/* ══════════════════ 10. 坏路径：每一种都要能**说实话** ══════════════════ */
{
  const sink = fakeSink();
  const r = await streamChat({
    creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, text: "x", sink,
    fetchImpl: fakeFetch({ status: 403, text: '{"Code":"Forbidden.RAM","Message":"echo of user input"}' }),
  });
  eq("HTTP 失败 → 只回错误码", r.httpCode, "Forbidden.RAM");
  eq("没有正文", sink.reply, "");
  eq("done 为 false", r.done, false);
  ok("话术里不含服务端 message", !JSON.stringify(r).includes("echo of user input"));
}
{
  const sink = fakeSink();
  const r = await streamChat({
    creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, text: "x", sink,
    fetchImpl: fakeFetch({ noBody: true }),
  });
  eq("200 但没有响应体 → EmptyBody（不是静默的空回答）", r.httpCode, "EmptyBody");
}
{
  // ⚠️ 最贵的一种：连接结束了但没有 `stream_done`。实测流里**没有 seq**（响应 schema 里
  //    写着有，抓包根本没有），所以没有任何精确续传依据 —— 只能如实说这轮不完整。
  const sink = fakeSink();
  const r = await streamChat({
    creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, text: "x", sink,
    fetchImpl: fakeFetch({ chunks: [textFrame("我先看一下"), textFrame("磁盘")] }),
  });
  eq("已经流出来的正文照样保留", sink.reply, "我先看一下磁盘");
  eq("done=false → 调用方据此告诉用户这轮不完整", r.done, false);
  eq("这不是 HTTP 错误", r.httpCode, null);
  eq("也不是超时", [r.timedOut, r.stalled], [false, false]);
}
{
  // 一个字节都没来 → 判卡住（stall 计时器**只在首个 chunk 之前**生效）。
  const sink = fakeSink();
  const r = await streamChat({
    creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, text: "x", sink,
    stallSec: 0.15, maxWaitSec: 30, fetchImpl: fakeFetch({ hang: true }),
  });
  eq("stalled", r.stalled, true);
  eq("不算 HTTP 错误（是我们自己掐的）", r.httpCode, null);
  eq("done=false", r.done, false);
}
{
  // 首个 chunk 到了之后就**不再**按卡死判 —— 数字员工真干活时单个工具调用可以很久
  //  （实测单次 Bash 26.6s）。这里 stallSec 很小但已有正文，必须走硬超时那条路。
  const sink = fakeSink();
  const t0 = Date.now();
  const r = await streamChat({
    creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, text: "x", sink,
    stallSec: 0.1, maxWaitSec: 0.5,
    fetchImpl: fakeFetch({ chunks: [textFrame("正在执行巡检…")], hang: true }),
  });
  eq("有正文了就不算卡死", r.stalled, false);
  eq("走的是硬超时", r.timedOut, true);
  eq("已生成的部分留下", sink.reply, "正在执行巡检…");
  ok("确实等到了硬超时才返回（>=stallSec 很久）", Date.now() - t0 >= 400);
}
{
  // 真的网络错（不是我们掐的）→ 记异常类型名，不记原始错误文本。
  const sink = fakeSink();
  const boom = async () => { throw new TypeError("fetch failed: ECONNREFUSED 1.2.3.4:443"); };
  const r = await streamChat({
    creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, text: "x", sink, fetchImpl: boom,
  });
  ok("有错误码", !!r.httpCode);
  ok("是类型名而不是原文（safeErr）", !String(r.httpCode).includes("1.2.3.4"));
  eq("done=false", r.done, false);
}
{
  // stream_done 之后**立刻**收工，不等对方关连接（否则一轮要多挂几秒）。
  const sink = fakeSink();
  const f = fakeFetch({ chunks: [textFrame("完"), DONE], hang: true });
  const t0 = Date.now();
  const r = await streamChat({
    creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, text: "x", sink,
    stallSec: 30, maxWaitSec: 30, fetchImpl: f,
  });
  eq("done", r.done, true);
  ok("没有被 hang 拖住（<2s 返回）", Date.now() - t0 < 2000);
}
{
  // 面板信息：耗时来自 task_finished（纳秒 → 毫秒）。
  const sink = fakeSink();
  const r = await streamChat({
    creds: CREDS, region: REGION, employee: EMP, threadId: THREAD, text: "x", sink,
    fetchImpl: fakeFetch({ chunks: [
      textFrame("好"),
      frame({ events: [{ type: "task_finished", payload: { statistics: { duration: 26581599305 }, success: true } }] }, { role: "system" }),
      DONE,
    ] }),
  });
  eq("墙钟毫秒", Math.round(r.durationMs), 26582);
  eq("success 记下来", r.success, true);
}

{
  // ── 页脚那位「数字员工 ID」的来源（源码级断言）──
  // `runStarOpsChat` 的主流程要真跑得起 Secrets Manager + 三个阿里云 API，这里跑不动；
  // 但**丢掉这一行的后果是静默的**：页脚少一位、看着只是"少显示了点东西"，而它恰恰是
  // 上一版那个错的 AWS 账号 ID 的替代物（见 Message.tsx 的 🔴）。所以按源码钉两件事：
  //   ① `via` 事件必须带 employee（前端 onVia 的第二个参数 + BFF 落库都从它取值）；
  //   ② 这条事件**绝不能**顺手把 workspace 带出去 —— workspace 内嵌阿里云账号 UID，
  //      是管理员专属值，不回给非管理员。
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../starops_chat.mjs", import.meta.url), "utf8"));
  const line = (src.match(/emit\(\s*"via"[^)]*\)/) || [""])[0];
  ok("via 事件带 employee（页脚显示数字员工 ID 的唯一来源）", /employee/.test(line));
  ok("via 事件不带 workspace（内嵌阿里云账号 UID）", !/workspace/.test(line));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
