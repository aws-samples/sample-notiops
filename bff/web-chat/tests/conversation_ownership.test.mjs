/**
 * 会话归属（对象级越权 / IDOR）—— 真值表 + 门禁位置普查。
 * 运行：node bff/web-chat/tests/conversation_ownership.test.mjs
 *
 * ## 守的是什么
 *
 * `notiops-web-chat` 这张表**不按用户分消息**：会话头在 `PK=user#{sub}`，但消息在
 * `PK=conv#{conversationId}`，`appendMessage` 连 `sub` 都不收。而 conversationId 是
 * 前端 `newId()` 造的 `conv-{毫秒}-{序号}` —— 低熵、可枚举。于是修复前：
 *
 *   · `GET  /api/chat/conversations/{别人的id}` → 200 + 对方整段历史；
 *   · `DELETE /api/chat/conversations/{别人的id}` → 会话头删不掉（不在自己分区），
 *     但第 2、3 步照样 BatchWrite 把**对方的消息分区清空**，回 200 {ok:true}，无日志；
 *   · `POST /stream` 带别人的 conversation_id → 自己的问答被追加进对方的历史。
 *
 * 全部是登录用户之间的横向越权，不需要任何管理权限。
 *
 * ## 判据结构
 * ① `convAccessAllowed` 纯函数真值表（真 import 真调用）
 * ② 读/删/改路径：门禁必须**排在** listMessages / deleteConversation 之前
 * ③ 写路径：`convWriteAllowed(` 必须排在 `return await streamChat(` 之前
 * ④ 状态码：读侧统一 404（不是 403 —— 403 是一个存在性 oracle），写侧 409
 * ⑤ store.mjs 侧兜底：deleteConversation 自己也要先验归属（这一步不可逆）
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(HERE, "..", f), "utf8");

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

/* ── ① 真值表 ── */
const { convAccessAllowed } = await import("../store.mjs");

ok("是我的会话 → 放行",
  convAccessAllowed({ mine: true, partitionUsed: true }) === true);
ok("不是我的、分区已被占用 → 拒（这就是越权那一格）",
  convAccessAllowed({ mine: false, partitionUsed: true }) === false);
ok("不是我的、分区也没人用 → 放行（全新会话的第一轮，正常路径）",
  convAccessAllowed({ mine: false, partitionUsed: false }) === true);
ok("mine 为真时不看 partitionUsed",
  convAccessAllowed({ mine: true, partitionUsed: false }) === true);

/* ── ② 读/删/改门禁的**位置** ──
 * 只断言"存在一个 conversationOwnedBy 调用"是不够的：门禁排在 listMessages 之后
 * 就等于没有。这里比下标。 */
const idx = read("index.mjs");
const guardAt = idx.indexOf("if (!(await conversationOwnedBy(sub, convMatch[1])))");
const listAt = idx.indexOf("await listMessages(convMatch[1])");
const delAt = idx.indexOf("await deleteConversation(sub, convMatch[1])");

ok("index.mjs 有 conversationOwnedBy 门禁", guardAt > 0);
ok("门禁排在 listMessages 之前", guardAt > 0 && listAt > guardAt);
ok("门禁排在 deleteConversation 之前", guardAt > 0 && delAt > guardAt);
ok("门禁覆盖 GET / DELETE / PATCH 三个方法",
  /convMatch && \(method === "GET" \|\| method === "DELETE" \|\| method === "PATCH"\)/.test(idx));

/* ── ③ 写路径（/stream）── */
const writeGuardAt = idx.indexOf("await convWriteAllowed(");
const streamAt = idx.indexOf("return await streamChat(");
ok("/stream 分派前调用 convWriteAllowed", writeGuardAt > 0);
ok("convWriteAllowed 排在 streamChat 之前", writeGuardAt > 0 && streamAt > writeGuardAt);
ok("convWriteAllowed 用 conversationPartitionUsed 判「这个 id 是不是别人的」",
  /convWriteAllowed[\s\S]{0,400}conversationPartitionUsed\(/.test(idx));

/* ── ④ 状态码 ──
 * 读侧回 404 而不是 403：403 意味着"这个 id 存在，只是不属于你"，那本身就是一个
 * 可枚举的存在性 oracle。写侧回 409（冲突），语义是"这个 id 已经被占用了"。 */
ok("读侧统一 404 not_found", /return json\(404, \{ error: "not_found" \}\)/.test(idx));
ok("写侧 409 conversation_conflict",
  /return json\(409, \{ error: "conversation_conflict" \}\)/.test(idx));
ok("读侧**不**回 403（避免存在性 oracle）",
  !/convMatch[\s\S]{0,300}json\(403/.test(idx));

/* ── ⑤ store.mjs 侧兜底 ── */
const store = read("store.mjs");
ok("deleteConversation 自己先验归属（这一步不可逆，不能只靠路由层记得检查）",
  /export async function deleteConversation\(sub, conversationId\) \{\s*\n\s*if \(!\(await conversationOwnedBy\(sub, conversationId\)\)\) return \{ ok: false, code: "not_found" \};/.test(store));
ok("conversationOwnedBy 用 GetItem 打 user#{sub} 分区（表上没有 GSI，只能这么判）",
  /conversationOwnedBy[\s\S]{0,500}Key: \{ PK: `user#\$\{sub\}`, SK: `conv#\$\{conversationId\}` \}/.test(store));
ok("conversationPartitionUsed 刻意不加 begins_with(SK,\"msg#\")（dachat 也算占用）",
  /conversationPartitionUsed[\s\S]{0,400}KeyConditionExpression: "PK = :pk"[\s\S]{0,200}Limit: 1/.test(store));
ok("renameConversation / setConversationPinned 都带 attribute_exists(SK)（Update 是 upsert）",
  (store.match(/ConditionExpression: "attribute_exists\(SK\)"/g) || []).length >= 2);

console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
