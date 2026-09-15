/**
 * 历史读取的分页方向 —— 长会话必须丢**最早**的，不能丢最新的。
 * 运行：node bff/web-chat/tests/store_history_pagination.test.mjs
 *
 * ## 守的是什么
 *
 * `listMessages` 原来是「`ScanIndexForward: true`、不给 `Limit`、不看 `LastEvaluatedKey`」。
 * DynamoDB 单次 Query 的硬上限是 1 MB —— 正序取满就停在**最老的那一页**。于是一条长会话：
 *
 *   · 界面上少的是**刚刚问的那几轮**（最新的），不是最早的；
 *   · agent 拿到的上下文也是那一段旧的 —— 它会带着"你上一句还没说过"的记忆继续答；
 *   · 全程 200、无日志、无任何界面提示，用户只会觉得"它忘了我刚说的"。
 *
 * 深度调查的内联摘要单条能到 30-40 KB（CJK 三字节），几十轮就能顶到 1 MB —— 不是极端场景。
 *
 * 修法三件套，本文件逐条钉住：
 *   ① `ScanIndexForward: false` + `Limit: cap` —— 倒序取满，丢的一定是最早的；
 *   ② `.reverse()` 翻回时间正序 —— 前端与 agent 都按正序消费，方向不能变；
 *   ③ `truncated` 来自 `LastEvaluatedKey`（不是 `items.length === cap`：后者在"恰好 cap 条"
 *      时会误报截断），并且和 `limit` 一起一路带到界面上 —— 「悄悄少了几轮」和
 *      「这个会话本来就这么短」在界面上必须能区分开。
 *
 * 判据是**真调用**：patch `DynamoDBDocumentClient.prototype.send`，录下真实的
 * QueryCommand 入参。只 grep 源码的话，`ScanIndexForward: false` 写在注释里也能过。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

const lib = await import("@aws-sdk/lib-dynamodb");
const store = await import("../store.mjs");

/** 真调 listMessages，录下发给 DynamoDB 的 QueryCommand 入参。 */
async function query(conversationId, limit, { items = [], lastKey } = {}) {
  const orig = lib.DynamoDBDocumentClient.prototype.send;
  const sent = [];
  lib.DynamoDBDocumentClient.prototype.send = async function (cmd) {
    sent.push(cmd.input);
    return { Items: items, LastEvaluatedKey: lastKey };
  };
  try {
    const r = await store.listMessages(conversationId, limit);
    return { r, input: sent[0], calls: sent.length };
  } finally {
    lib.DynamoDBDocumentClient.prototype.send = orig;
  }
}

/* ── ① 倒序 + 有上限 ── */
{
  const { r, input, calls } = await query("conv-1");
  ok("★★★ ScanIndexForward: false —— 倒序取，要丢也只丢最早的那几轮",
    input.ScanIndexForward === false);
  ok("★★★ 带 Limit（不给上限就是「取到 1 MB 为止」，而那 1 MB 是从哪头开始取的完全不由我们说了算）",
    Number(input.Limit) > 0);
  ok("默认上限 = WEB_CHAT_HISTORY_LIMIT 的默认值 400", input.Limit === 400);
  ok("回传的 limit 与实际用的上限一致（前端那句「只显示最近 N 条」的 N 只能来自这里）",
    r.limit === input.Limit);
  ok("只发一次 Query —— 不许偷偷改成累加所有页的循环（一条被灌爆的会话能把 Lambda 内存撑爆）",
    calls === 1);
  ok("查的是这个会话的消息分区", input.ExpressionAttributeValues[":pk"] === "conv#conv-1"
    && input.ExpressionAttributeValues[":sk"] === "msg#");
}

/* ── ② 显式 limit 可覆盖；非法值回落到默认 ── */
{
  const { input } = await query("conv-1", 5);
  ok("显式 limit 生效", input.Limit === 5);
}
{
  const { input } = await query("conv-1", 0);
  ok("limit=0 回落默认（0 会被 DynamoDB 当非法值拒掉，绝不能原样传下去）", input.Limit === 400);
}
{
  const { input } = await query("conv-1", -3);
  ok("负数回落默认", input.Limit === 400);
}
{
  const { input } = await query("conv-1", "abc");
  ok("非数字回落默认", input.Limit === 400);
}

/* ── ③ 方向：倒序拿到手，必须翻回时间正序 ──
 * DDB 回的是「最新在前」；前端渲染和 agent 的上下文都按时间正序消费。
 * 这里的 items 刻意按 DDB 的顺序给（ts 递减），断言出口是递增。 */
{
  const items = [
    { role: "assistant", text: "c", ts: 300 },
    { role: "user", text: "b", ts: 200 },
    { role: "assistant", text: "a", ts: 100 },
  ];
  const { r } = await query("conv-1", 10, { items });
  ok("★★★ 出口是时间**正序**（DDB 回的是倒序，忘了 reverse 就是整段历史前后颠倒）",
    r.messages.map((m) => m.ts).join(",") === "100,200,300");
  // ⚠️ 这一格是**允许清单**，不是"随便列几个字段"：`i` 是整条 DDB item，直接 `...i`
  //    会把主键（`PK`/`SK`）和以后加的任何内部字段一起发给浏览器。所以每加一个字段都
  //    必须来这里显式加一次，**顺序也要对**（`join(",")` 逐字比）——刻意让它变成一次
  //    有意识的动作，而不是"投影里多一个字段没人注意到"。
  //    2026-09-14 加 `starops_employee`：阿里云 STAROps 那条路的页脚要显示"这条是哪个
  //    数字员工答的"，刷新页面后还得在，所以它必须跟着历史一起回来。它是**员工 ID**，
  //    本来就渲染在客户自己眼前；🔒 `workspace`（内嵌阿里云账号 UID）**不在**这份清单里，
  //    也永远不许进来。
  ok("消息字段按允许清单投影（role/text/ts/model/sources/usage/account_id/via/starops_employee）",
    Object.keys(r.messages[0]).join(",")
    === "role,text,ts,model,sources,usage,account_id,via,starops_employee");
}

/* ── ④ truncated 的判据 ── */
{
  const { r } = await query("conv-1", 10, { items: [], lastKey: undefined });
  ok("没有 LastEvaluatedKey → truncated 为假", r.truncated === false);
}
{
  const items = Array.from({ length: 10 }, (_, i) => ({ role: "user", text: "x", ts: i }));
  const { r } = await query("conv-1", 10, { items });
  ok("★★ 恰好取满 limit 条、但没有 LastEvaluatedKey → **不**算截断"
    + "（用 items.length === limit 判就会在这一格谎报「更早的没加载」）",
    r.truncated === false);
}
{
  const { r } = await query("conv-1", 10, {
    items: [{ role: "user", text: "x", ts: 1 }], lastKey: { PK: "conv#conv-1", SK: "msg#1" },
  });
  ok("★★★ 有 LastEvaluatedKey → truncated 为真（这是界面上唯一能提示「少了几轮」的信号）",
    r.truncated === true);
  ok("truncated 是布尔，不是把 LastEvaluatedKey 本身漏出去（里面是主键，进不了响应体）",
    r.truncated === true && typeof r.truncated === "boolean");
}

/* ── ⑤ 一路带到界面：路由层与前端都不许把这两个字段吞掉 ── */
const idx = readFileSync(join(HERE, "..", "index.mjs"), "utf8");
ok("index.mjs 把 truncated 和 limit 一起回给前端",
  /json\(200, \{ messages: h\.messages, truncated: h\.truncated, limit: h\.limit \}\)/.test(idx));

const app = readFileSync(join(HERE, "..", "..", "..",
  "frontend", "chat-app", "src", "pages", "ChatApp.tsx"), "utf8");
ok("前端把 truncated 落到会话上", /historyTruncated: truncated/.test(app));
ok("★★ 界面上真的渲染了截断提示条（字段带到了但不画，等于没修）",
  /active\.historyTruncated &&/.test(app) && /thread-truncated/.test(app));
ok("提示里的条数取服务端回的 limit，不是前端写死的 400",
  /\$\{active\.historyLimit \|\| 0\}/.test(app) && !/只显示最近 400 条/.test(app));

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
