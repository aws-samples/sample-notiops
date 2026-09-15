/**
 * 写操作幂等（同一次确认只真执行一次）。
 * 运行：node bff/web-chat/tests/action_idempotency.test.mjs
 *
 * ## 守的是什么
 *
 * 确认卡的执行结果只活在前端内存里（`ChatApp.patchMsgIn` 不回写后端）。于是：
 *   ① 刷新页面 → 一张**已经开过案例**的卡重新画成"待确认" → 再点一次 = 第二个真案例；
 *   ② 两个标签页各有一张"待确认"的卡；
 *   ③ 前端 disabled 随组件重挂就丢。
 * 三条都不是前端能自己解决的，所以幂等必须在 BFF。
 *
 * 这里断两件事：
 *   A. 指纹函数（`actionIdemKey`）真的能分开"不同操作"、合并"同一操作" —— 行为测试。
 *   B. 认领/收尾的**语义形状**：条件写、超时可抢、回放真实结果而不是编造成功、
 *      失败要删认领、DDB 故障 fail-open —— 源码断言（与 support_cross_account.test.mjs
 *      同一取舍：这几个函数不导出，且调用链要打 DDB）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actionIdemKey } from "../support.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "..", "support.mjs"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/* ─────────────── A. 指纹行为 ─────────────── */

const CASE = {
  type: "create_case",
  params: {
    subject: "RDS 连接超时", communication_body: "详细描述", service_code: "amazon-relational-database-service",
    category_code: "performance", severity_code: "urgent", issue_type: "technical", language: "zh",
  },
};
const clone = (o) => JSON.parse(JSON.stringify(o));

ok("同一操作 + 同一账号 → 同一指纹",
  actionIdemKey(CASE, "111122223333") === actionIdemKey(clone(CASE), "111122223333"));

// 同一份内容开到两个账号是**两个**操作 —— 这条错了会把跨账号建案的第二次静默吃掉。
ok("换账号 → 不同指纹",
  actionIdemKey(CASE, "111122223333") !== actionIdemKey(CASE, "444455556666"));

const other = clone(CASE); other.params.subject = "RDS 连接超时 (2)";
ok("改主题 → 不同指纹", actionIdemKey(CASE, "111122223333") !== actionIdemKey(other, "111122223333"));

const sev = clone(CASE); sev.params.severity_code = "low";
ok("改严重级别 → 不同指纹", actionIdemKey(CASE, "111122223333") !== actionIdemKey(sev, "111122223333"));

// undefined 与 "" 必须算同一个，否则"没填可选项"的两次提交会被当成两个操作。
const a = { type: "resolve_case", params: { case_id: "12345" } };
const b = { type: "resolve_case", params: { case_id: "12345", note: undefined } };
ok("未参与指纹的字段不影响结果", actionIdemKey(a, "") === actionIdemKey(b, ""));

ok("回复(add_communication) 有指纹", actionIdemKey({ type: "add_communication", params: { case_id: "1", communication_body: "x" } }, "1").startsWith("actidem#"));
ok("未知类型 → 空指纹（幂等跳过，不阻塞）", actionIdemKey({ type: "nope", params: {} }, "1") === "");
ok("指纹带 actidem# 前缀（与其他 PK 段不撞）", actionIdemKey(CASE, "1").startsWith("actidem#"));

/* ─────────────── B. 认领 / 收尾的语义形状 ─────────────── */

ok("读到了 support.mjs（自检）", src.length > 5000 && /export async function executeAction/.test(src));

ok("认领是条件写（attribute_not_exists），不是无条件 Put",
  /_idemClaim[\s\S]{0,900}ConditionExpression: "attribute_not_exists\(PK\) OR/.test(src));

ok("超时的认领可以被抢（否则 Lambda 被掐死就把操作堵到 TTL 过期）",
  /_IDEM_INFLIGHT_STALE_MS/.test(src) && /":stale": now - _IDEM_INFLIGHT_STALE_MS/.test(src));

ok("重复请求回放的是**存下来的真实结果**，不是编造的成功",
  /if \(got\.Item && got\.Item\.result\) return \{ mode: "replay", result: got\.Item\.result \}/.test(src));

ok("回放结果打了 duplicate:true（前端要据此明说没重复执行）",
  /return \{ \.\.\.claim\.result, duplicate: true \}/.test(src));

ok("正在执行中 → 只回错误码，不假称成功",
  /code: "action_in_flight"/.test(src) && !/code: "action_in_flight"[\s\S]{0,120}ok: true/.test(src));

ok("失败要删认领（否则一次抖动把这个操作永久堵死）",
  /_idemFinish[\s\S]{0,600}_AggDelete/.test(src));

ok("只有 ok 的结果才落表供回放",
  /if \(result && result\.ok\) \{[\s\S]{0,300}state: "done"/.test(src));

ok("认领写在真正发写请求之前（在 supportClientFor 之后、try 之前）",
  /const cli = await supportClientFor\(reqAcct\);[\s\S]{0,600}const idemPk = actionIdemKey\(action, effAcct\);[\s\S]{0,900}\n  try \{/.test(src));

ok("每条出口都过 fin（成功/回复/关闭/未知类型/异常 共 5 条）",
  (src.match(/return await fin\(/g) || []).length === 5);

ok("DDB 故障 fail-open（幂等是加固，不是可用性前置）",
  /idem claim failed[\s\S]{0,120}return \{ mode: "skip" \}/.test(src));

ok("幂等日志只记异常类型名（不记 message / 不记参数）",
  /idem claim failed \(\$\{e\?\.name \|\| "Error"\}\)/.test(src)
  && !/idem[\s\S]{0,200}console\.error[^\n]*e\?\.message/.test(src));

ok("记录带 ttl（不留永久垃圾）",
  (src.match(/ttl: Math\.floor\(now \/ 1000\) \+ _IDEM_TTL_SEC/g) || []).length === 2);

ok("复用 notiops-web-chat 表（_AGG_TABLE）—— 不需要新表 / 不需要改 IAM",
  /_idemClaim[\s\S]{0,400}TableName: _AGG_TABLE/.test(src));

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
