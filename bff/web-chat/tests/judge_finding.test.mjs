/**
 * 按需判读端点 `POST /inspection/judge`（2026-08-31 新增）。
 * 运行：node bff/web-chat/tests/judge_finding.test.mjs
 *
 * ## 这个端点做什么
 *
 * 给**一条** finding 派一次 DA 调查，用写好的判读 skill
 * （`inspection-cost-idle` / `inspection-high-load`）。
 *
 * 闲置轮设计上不派 DA（`gating.DETERMINISTIC_RUN_TYPES = {"idle"}`），于是
 * `cost-idle` 那份 skill 的 idle 那一半成了死代码 —— 而它回答的正是客户唯一
 * 真正关心的问题：这台是真闲，还是**有理由地**闲着（standby / 月末批量 /
 * 预热缓存 / 已停机）。
 *
 * ## 与「深度调查（直连）」的区别（客户问过，所以钉在这里）
 *
 * ```
 * 直连     聊天页的工具，**绑在会话所选账号**上（那套工具不收账号号入参 ——
 *          客户实测让它调查别的账号，它自己说「工具不接受账号 ID 这样的入参」）
 *          结果流在聊天里，两天后翻不到
 * 本端点   走 executor Lambda → 每个账号自己 assume
 *          结果绑在**那条 finding** 上（`put_dispatch` 是回拼锚点）
 * ```
 *
 * ## 本文件钉什么
 *
 * ```
 * ① 同步 invoke      RequestResponse 而不是 Event —— 要把「已经派过了」
 *                    这类可操作的原因直接回给客户
 * ② FunctionError    Lambda 抛异常时 HTTP 仍是 200，payload 里是 traceback
 * ③ code 透传        already_dispatched / kill_switch / not_found 各自一句话
 * ④ 两侧上限一致      note 的字符上限必须 == Python 的 OPERATOR_NOTE_LIMIT
 * ⑤ 不接「全部账号」   `*` 在这里没有意义（判读针对一条具体 finding）
 * ```
 */
process.env.CONFIG_TABLE = process.env.CONFIG_TABLE || "t";
process.env.AWS_REGION = "ap-northeast-1";
process.env.INSPECTION_EXECUTOR_FUNCTION = "notiops-inspection-executor";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const inspSrc = readFileSync(join(HERE, "..", "inspection.mjs"), "utf8");
const idxSrc = readFileSync(join(HERE, "..", "index.mjs"), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  let v;
  try { v = typeof cond === "function" ? cond() : cond; }
  catch (e) { fail++; console.log(`  FAIL ${name}  (threw: ${e?.message || e})`); return; }
  if (v) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/** 总数守卫。断言被跳过或删掉时 `PASSED: n ok, 0 failed` 照样打印。 */
const EXPECTED_TOTAL = 31;

/** 剥 `//` 行注释。否定式断言一律用它（本仓库踩过八次「命中自己的注释」）。 */
const strip = (code) => code.split("\n")
  .map((ln) => ln.replace(/\/\/.*$/, "")).join("\n");

const insp = await import("../inspection.mjs");
const FID = "444455556666#ap-northeast-1#elasticache#notiops-tb-mc-1#idle#-";

/**
 * 真调 `judgeFinding`，录下发给 Lambda 的入参。
 *
 * ⚠️ `resolveAccount` 空值兜底会去调 STS —— patch 掉它那一层，
 *    否则测试要么打真网络、要么账号恒为空。
 */
async function call(account, body, { resp, functionError } = {}) {
  const lam = await import("@aws-sdk/client-lambda");
  const stsLib = await import("@aws-sdk/client-sts");
  const origLam = lam.LambdaClient.prototype.send;
  const origSts = stsLib.STSClient.prototype.send;
  const sent = [];
  lam.LambdaClient.prototype.send = async function (cmd) {
    sent.push({
      fn: cmd.input.FunctionName,
      type: cmd.input.InvocationType,
      body: JSON.parse(Buffer.from(cmd.input.Payload).toString("utf8")),
    });
    return {
      FunctionError: functionError,
      Payload: Buffer.from(JSON.stringify(
        resp !== undefined ? resp
          : { ok: true, task_id: "t-1", agent_space_id: "sp-1" })),
    };
  };
  stsLib.STSClient.prototype.send = async () => ({ Account: "444455556666" });
  try {
    const r = await insp.judgeFinding(account, body, { actor: "tester" });
    return { r, sent };
  } finally {
    lam.LambdaClient.prototype.send = origLam;
    stsLib.STSClient.prototype.send = origSts;
  }
}

/* ── ① 同步 invoke + 参数正确 ─────────────────────────────────────────── */
{
  const { r, sent } = await call("444455556666",
    { finding_id: FID, note: "月末批量的缓存，别删。" });
  ok("★★★ 派发成功回传 task_id 与 space", r.ok === true && r.task_id === "t-1"
    && r.agent_space_id === "sp-1");
  ok("★★★ **同步** invoke（RequestResponse）—— 异步只能回一句「已提交」，"
    + "而「已经派过了」「缺巡检 space id」这类可操作的原因就传不回来了",
    sent[0]?.type === "RequestResponse");
  ok("★★★ 调的是 executor 而不是 scheduler（那条路与调度无关）",
    sent[0]?.fn === "notiops-inspection-executor");
  const mj = sent[0]?.body?.manual_judge || {};
  ok("★★★ 事件键是 manual_judge（executor 在 Records 循环**之前**分支它）",
    !!sent[0]?.body?.manual_judge);
  ok("★★★ finding_id 传下去了", mj.finding_id === FID);
  ok("★★★ account_id 传下去了", mj.account_id === "444455556666");
  ok("★★★ operator_note 传下去了", mj.operator_note === "月末批量的缓存，别删。");
  ok("★★ requested_by 带上了（DA 后台里能看出是谁点的）",
    mj.requested_by === "tester");
}

/* ── ② note 的归一与上限 ─────────────────────────────────────────────── */
{
  const { sent } = await call("444455556666", { finding_id: FID, note: "  两头空格  " });
  ok("★★ note 两头空格被 trim", sent[0].body.manual_judge.operator_note === "两头空格");
}
{
  const { sent } = await call("444455556666", { finding_id: FID });
  ok("★★ 没给 note → 空串（Python 侧只在非空时写进载荷）",
    sent[0].body.manual_judge.operator_note === "");
}
{
  const { r, sent } = await call("444455556666",
    { finding_id: FID, note: "x".repeat(insp.OPERATOR_NOTE_LIMIT + 1) });
  ok("★★★ 超长 note 在**这里**就拒，不 invoke —— 让它到 validate_payload 才被拒的"
    + "表现是客户看到一句长长的契约层报错",
    r.ok === false && r.code === "bad_request" && sent.length === 0);
  ok("★★ 拒的时候把上限和实际长度都说出来",
    String(r.message).includes(String(insp.OPERATOR_NOTE_LIMIT)));
}
{
  const { r } = await call("444455556666",
    { finding_id: FID, note: "x".repeat(insp.OPERATOR_NOTE_LIMIT) });
  ok("★★★ 刚好在上限上要放行（边界不能一起拒掉）", r.ok === true);
}

/* ── ③ 参数校验 ──────────────────────────────────────────────────────── */
{
  const { r, sent } = await call("444455556666", {});
  ok("★★★ 缺 finding_id → 拒且不 invoke",
    r.ok === false && r.code === "bad_request" && sent.length === 0);
}
{
  const { r, sent } = await call("*", { finding_id: FID });
  ok("★★★ 「全部账号」哨兵在这里没有意义 —— 判读针对一条具体 finding。"
    + "不挡的话 `*` 会被当账号号去查 → 报「finding 不存在」，"
    + "而真正的原因是账号选择器停在「全部账号」上",
    r.ok === false && r.code === "bad_request" && sent.length === 0);
  ok("★★ 而且要说清是选择器的问题",
    String(r.message).includes("全部账号"));
}
{
  // 空账号 → 兜底成部署账号（与其余端点同一个 resolveAccount）
  const { r, sent } = await call("", { finding_id: FID });
  ok("★★★ 空账号兜底成部署账号（不复用 resolveAccount 的表现是这个端点对"
    + "「部署账号」这个默认选项不工作）",
    r.ok === true && sent[0].body.manual_judge.account_id === "444455556666");
}

/* ── ④ executor 的失败要原样透传 ─────────────────────────────────────── */
for (const [code, msg] of [
  ["already_dispatched", "这条已经派过判读了（task t-old）"],
  ["kill_switch", "巡检已被 kill switch 停用"],
  ["not_found", "finding 不存在"],
  ["conflict", "这条 finding 已标记为「已解决」"],
]) {
  const { r } = await call("444455556666", { finding_id: FID },
    { resp: { ok: false, code, message: msg } });
  ok(`★★★ 透传 code=${code} 与原文（合成一句「派发失败」等于把可操作的话丢掉）`,
    r.ok === false && r.code === code && String(r.message).includes(msg.slice(0, 8)));
}

/* ── ⑤ FunctionError：Lambda 抛异常时 HTTP 仍是 200 ─────────────────── */
{
  const { r } = await call("444455556666", { finding_id: FID }, {
    functionError: "Unhandled",
    resp: { errorType: "KeyError", errorMessage: "'region'" },
  });
  ok("★★★ FunctionError 要单独看 —— 不看的表现是把一段 traceback 当正常结果"
    + "解析（`ok` 为 undefined），前端显示「失败」而拿不到任何原因",
    r.ok === false && r.code === "invoke_failed");
  ok("★★ 提示里指到 executor 的日志", String(r.message).includes("executor"));
}
{
  // payload 不是合法 JSON
  const lam = await import("@aws-sdk/client-lambda");
  const stsLib = await import("@aws-sdk/client-sts");
  const o1 = lam.LambdaClient.prototype.send;
  const o2 = stsLib.STSClient.prototype.send;
  lam.LambdaClient.prototype.send = async () => ({
    Payload: Buffer.from("<html>502</html>") });
  stsLib.STSClient.prototype.send = async () => ({ Account: "444455556666" });
  try {
    const r = await insp.judgeFinding("444455556666", { finding_id: FID }, {});
    ok("★★★ 响应不是 JSON → 落成失败而不是抛（抛出去 BFF 是 500 + traceback）",
      r.ok === false && r.code === "invoke_failed");
  } finally {
    lam.LambdaClient.prototype.send = o1;
    stsLib.STSClient.prototype.send = o2;
  }
}
{
  // AccessDenied（缺那条 policy）——最常见的部署疏漏
  const lam = await import("@aws-sdk/client-lambda");
  const stsLib = await import("@aws-sdk/client-sts");
  const o1 = lam.LambdaClient.prototype.send;
  const o2 = stsLib.STSClient.prototype.send;
  lam.LambdaClient.prototype.send = async () => {
    throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
  };
  stsLib.STSClient.prototype.send = async () => ({ Account: "444455556666" });
  try {
    const r = await insp.judgeFinding("444455556666", { finding_id: FID }, {});
    ok("★★★ AccessDenied 原样回传 name（缺 InspectionManualRunInvoke 里 executor "
      + "那一项时就是它）—— 退化成一句「失败」会让人查不到根因",
      r.ok === false && String(r.message).includes("AccessDenied"));
  } finally {
    lam.LambdaClient.prototype.send = o1;
    stsLib.STSClient.prototype.send = o2;
  }
}

/* ── ⑥ 两侧上限一致（元断言）─────────────────────────────────────────── */
{
  const py = readFileSync(
    join(HERE, "..", "..", "..", "inspection", "domain", "payload.py"), "utf8");
  const m = /OPERATOR_NOTE_LIMIT = ([0-9_]+)/.exec(py);
  ok("★★★ Python 侧的 OPERATOR_NOTE_LIMIT 还在", !!m);
  const pyLimit = m ? Number(m[1].replace(/_/g, "")) : -1;
  ok(`★★★ 两侧上限必须一致（BFF ${insp.OPERATOR_NOTE_LIMIT} vs Python ${pyLimit}）`
    + " —— BFF 松那边紧的表现是客户输入被放过、到契约层才拒，"
    + "而那条报错要穿过 Lambda 回到界面",
    insp.OPERATOR_NOTE_LIMIT === pyLimit);
}

/* ── ⑦ 路由与门禁 ────────────────────────────────────────────────────── */
{
  const idx = strip(idxSrc);
  ok("★★★ 有 POST /inspection/judge 这条路由",
    /path\.endsWith\("\/inspection\/judge"\)/.test(idx));
  ok("★★★ 路由读 `authBody` 而不是裸 `body`（regions 那条踩过："
    + "`body` 未声明 → ReferenceError → 500）",
    /\(authBody \|\| \{\}\)\.account \|\| q\.account/.test(idx));
  const caps = JSON.parse(readFileSync(
    join(HERE, "..", "capabilities.json"), "utf8"));
  const run = caps.nodes.find((n) => n.key === "action:inspection:run");
  ok("★★★ 门禁登记在 action:inspection:run 上（它的定义就是「唯一能被前端请求"
    + "直接花钱的巡检端点」，而这条同样花 DA 额度）",
    (run?.routes || []).some((r) => r.pattern === "/inspection/judge$"
      && r.method === "POST"));
  // 🔴 没登记的话 authz 会判 unknown_route → 对**所有人** 403，
  //    而按钮照常显示（前端只看 can("action:inspection:run")）。
  ok("★★ 两份 capabilities.json 一致（config/ 是源，setup.sh:635 复制进 BFF）",
    readFileSync(join(HERE, "..", "capabilities.json"), "utf8")
    === readFileSync(join(HERE, "..", "..", "..", "config",
                          "capabilities.json"), "utf8"));
}

const total = pass + fail;
if (total !== EXPECTED_TOTAL) {
  console.log(`\n  FAIL 断言总数 ${total} != 预期 ${EXPECTED_TOTAL} —— `
    + "要么少跑了，要么加了断言没改 EXPECTED_TOTAL。");
  fail++;
}
console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
