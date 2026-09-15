/**
 * 响应体的错误卫生 —— 上游异常的**原文**一律不许进 HTTP 响应。
 * 运行：node bff/web-chat/tests/error_response_hygiene.test.mjs
 *
 * ## 守的是什么
 *
 * AWS SDK 的 `e.message` 是成句的英文散文，里面常规带 12 位账号 id、完整 role / 资源 ARN、
 * 表名、database 名、SQL 片段：
 *
 *   User: arn:aws:sts::123456789012:assumed-role/WebChatStack-BffFn…/… is not authorized
 *   to perform: dynamodb:Query on resource: arn:aws:dynamodb:us-east-1:123456789012:table/notiops-web-chat
 *
 * 这些串一旦进了响应体，就会被前端**原样画到页面上** —— 不是躺在 DevTools 里。给客户交付
 * 的产品里，这等于把部署账号 id、角色名、表名、以及"这个角色缺哪条 action"一起印给了
 * 任何一个能登录的人。而运维真正需要的诊断信息只有**异常名**（`AccessDenied` 与
 * `NoSuchEntity` 指向完全不同的动作），异常名恰好不含任何拓扑信息。
 *
 * 所以口径是：**日志里可以有 message（CloudWatch 是我们自己的），响应体里只许有
 * 「异常类型名/错误码」或我们自己写的文案。** 三档见 `safe_err.mjs::errBody`。
 *
 * ⚠️ 这里刻意**不**断言 `console.error` 不含 `e?.message` —— 那是有意保留的：
 *    把日志也削成异常名，等于为了防泄漏把排障能力一起砍掉。要守的是那条**对外的**通道。
 *
 * ## 判据结构
 * ① safeErr / userError / errBody 的行为（真调用，含"真实 AWS 报文进去、什么都不该出来"）
 * ② index.mjs 的每个失败出口都走 errBody
 * ③ 全仓扫描：没有任何 .mjs 把 e.message 放进要回给前端的对象
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..");
const read = (f) => readFileSync(join(DIR, f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const { safeErr, userError, errBody } = await import("../safe_err.mjs");

/* ── ① 行为 ──────────────────────────────────────────────────────────── */

// 这就是真实的 DynamoDB AccessDenied 报文形状（账号 id 用占位号）。
class AccessDeniedException extends Error {}
const awsErr = new AccessDeniedException(
  "User: arn:aws:sts::111122223333:assumed-role/WebChatStack-BffFnServiceRole-ABC/WebChatStack-BffFn"
  + " is not authorized to perform: dynamodb:Query on resource:"
  + " arn:aws:dynamodb:us-east-1:111122223333:table/notiops-web-chat");
awsErr.name = "AccessDeniedException";

const squashed = safeErr(awsErr);
ok("★★★ safeErr 的产物里没有 12 位账号 id", !/\d{12}/.test(squashed));
ok("★★★ safeErr 的产物里没有 ARN", !/arn:aws/.test(squashed));
ok("★★★ safeErr 的产物里没有表名", !/notiops-web-chat/.test(squashed));
ok("safeErr 的产物里没有缺失的 action（「缺 dynamodb:Query」本身就是侦察情报）",
  !/dynamodb:/.test(squashed));
ok("★★ 但**保留**了异常名 —— 这是运维唯一真正需要的那一位信息",
  squashed.includes("AccessDeniedException"));
ok("形状是「构造器名/异常名」", squashed === "AccessDeniedException/AccessDeniedException");

ok("没有 name 时回落到 unknown，不抛", safeErr({}) === "Object/unknown");
ok("null / undefined 也不抛", safeErr(null) === "Error/unknown" && safeErr(undefined) === "Error/unknown");
ok("只有 HTTP 状态码时用它当 code", safeErr({ $metadata: { httpStatusCode: 503 } }) === "Object/503");

// errBody 三档
ok("★★ 第 1 档：userError 的手写文案原样外显（这是用户唯一能据以修好问题的信息）",
  JSON.stringify(errBody(userError("zip 里没有 SKILL.md", "bad_request")))
  === JSON.stringify({ error: "zip 里没有 SKILL.md", code: "bad_request" }));
ok("userError 默认 code = bad_request", userError("x").code === "bad_request");
ok("第 2 档：我们自己造的机器可读码原样回（前端按码映射本地化文案）",
  JSON.stringify(errBody({ code: "org_mode_disabled" })) === JSON.stringify({ error: "org_mode_disabled" }));
ok("★★★ 第 3 档：其余一切（AWS SDK / 运行时异常）压成异常名",
  JSON.stringify(errBody(awsErr)) === JSON.stringify({ error: "AccessDeniedException/AccessDeniedException" }));
ok("★★ 顺序不能反：既有 userMessage 又有 code 时，先出文案（反了就把手写提示吞成一句干码）",
  errBody(userError("请先选择账号", "need_account")).error === "请先选择账号");
ok("第 3 档不含账号 id / ARN（把 errBody 整个序列化了再查一遍）",
  !/\d{12}|arn:aws/.test(JSON.stringify(errBody(awsErr))));

/* ── ② index.mjs 的失败出口 ──────────────────────────────────────────── */
const idx = read("index.mjs");
ok("★★★ 兜底 500 走 errBody", /return json\(500, errBody\(e\)\)/.test(idx));
ok("★★★ 没有任何 json(...) 直接把 e.message 当 error 回",
  !/json\([^)]*\{\s*error:\s*(String\()?e\??\.message/.test(idx));
// JWKS 拉不通 ≠ token 不合法。回 401 会让前端把用户**登出**（清 token、跳登录页），
// 而重新登录还要过同一个拉不通的 IdP —— 一次 cognito-idp 抖动就变成"全员被踢出且登不回来"。
// 对外的码刻意换成 idp_unavailable：`jwks_unavailable` 是内部实现词，对外只说"身份服务暂不可用"。
ok("★★★ JWKS 拉不通 → 503 + 固定码 idp_unavailable（既不是 500 也不是 401，更不是回 fetch 原文）",
  /if \(e\?\.code === "jwks_unavailable"\)/.test(idx)
  && /return json\(503, \{ error: "idp_unavailable" \}\)/.test(idx));
ok("errBody 是从 safe_err.mjs import 的（不是各处各写一份）",
  /import \{[^}]*errBody[^}]*\} from "\.\/safe_err\.mjs"/.test(idx));

/* ── ③ 全仓扫描 ───────────────────────────────────────────────────────
 * 只看"要进响应体的对象字面量"这一类写法。这条断言的价值在于**新增代码**：
 * 下一个人写 catch 时最自然的手感就是 `message: e.message`，得在 CI 里拦住。 */
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".mjs"));
// 形如  error: e.message / message: String(e?.message || e) / reason: e.message
const LEAK = /\b(error|message|reason|detail|details|aiError)\s*:\s*(?:String\()?\s*(?:`[^`]*\$\{\s*)?e\d?\??\.message/;
const leaks = [];
for (const f of FILES) {
  const src = read(f);
  src.split("\n").forEach((line, i) => {
    if (LEAK.test(line)) leaks.push(`${f}:${i + 1}: ${line.trim()}`);
  });
}
ok("★★★ 全仓没有把 e.message 直接放进响应对象字段的写法"
  + (leaks.length ? `\n       ${leaks.join("\n       ")}` : ""), leaks.length === 0);

// 反面确认：这条正则**确实**能抓到问题写法（否则它是一条永绿的假断言）。
ok("★★ 扫描正则本身有效（喂进原 bug 的三种写法都必须命中）",
  LEAK.test('    return json(500, { error: String(e?.message || e) });')
  && LEAK.test('    return { available: false, message: e.message };')
  && LEAK.test('    return { ok: false, reason: `boom ${e?.message}` };'));

// 每个 catch 里的"给用户的那一段"都必须过 safeErr / userError / _clientErr 之一。
// 这三个是同一套口径的三个入口（_clientErr 是 finops.mjs 的历史名字）。
const SANCTIONED = /safeErr\(|userError\(|_clientErr\(|errBody\(/;
const withResponses = ["support.mjs", "health.mjs", "security.mjs", "member_accounts.mjs",
  "inspection.mjs", "cost_explorer.mjs", "potential_savings.mjs", "devops_agent_accounts.mjs",
  "feishu_config.mjs", "skills.mjs", "devops_agent_skills.mjs", "role_guard.mjs",
  "aliyun_config.mjs"];
for (const f of withResponses) {
  ok(`${f} 用的是收口后的那套（safeErr / userError / _clientErr）`, SANCTIONED.test(read(f)));
}

/* ── ④ 日志侧刻意不收紧（把这条写下来，免得下次有人"顺手统一一下"） ── */
ok("★★ console.error 仍然带 e?.message —— 这是**有意**的：CloudWatch 是我们自己的，"
  + "要关的是对外那条通道。把日志也削成异常名等于顺手砍掉排障能力",
  /console\.error\([^)]*e\?\.message/.test(idx) || /e\?\.message/.test(idx));

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
