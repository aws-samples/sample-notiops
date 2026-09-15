/**
 * 会话/消息持久化（DynamoDB 单表）。
 *
 * 表 notiops-web-chat：
 *   会话:   PK=user#{sub}        SK=conv#{conversationId}
 *   消息:   PK=conv#{convId}     SK=msg#{ts}
 *   偏好:   PK=user#{sub}        SK=prefs
 * 都带 ttl（会话/消息自动过期）。用运行时预装的 AWS SDK v3。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.WEB_CHAT_TABLE || "notiops-web-chat";
// 会话保留策略：每次新对话都会刷新 ttl（见 touchConversation），故等价于
// "闲置 30 天后自动删除；只要还在用就一直保留"。用户显式删除则立即移除。
const TTL_DAYS = Number(process.env.WEB_CHAT_TTL_DAYS || "30");

// removeUndefinedValues: 消息可能缺 model/sources/usage 等字段（值为 undefined），
// 不开此项 marshaller 会抛错。开启后自动剔除 undefined 字段。
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const ttl = () => Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;

export async function ensureConversation(sub, conversationId, title, topic) {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `user#${sub}`,
        SK: `conv#${conversationId}`,
        conversationId,
        title: title || "New chat",
        topic: topic || "general", // 会话主题（general=通用）
        updatedAt: Date.now(),
        ttl: ttl(),
      },
      // 已存在则不覆盖标题/创建时间/主题
      ConditionExpression: "attribute_not_exists(SK)",
    }),
  ).catch((e) => {
    if (e.name !== "ConditionalCheckFailedException") throw e;
  });
}

/** 会话头上允许出现的「对话对象」取值。别放松成任意字符串：这个值会直接决定侧栏那枚
 *  tag 写什么，写错就是"这段对话是谁答的"这条事实说错，而客户看不出来。 */
const CONV_OBJ = new Set(["notiops", "devops", "starops"]);

export async function touchConversation(sub, conversationId, accountId, obj) {
  // account_id：会话曾接触过的成员账号（可见性回收时按此过滤历史会话；
  // 一个会话只记最后一次非空账号，够用 —— 严格多账号会话建议开新对话）
  const setAcct = accountId ? ", account_id = :acct" : "";
  // obj：这一轮由**谁**回答（notiops / devops / starops）。
  // 为什么必须落在会话**头**上：侧栏那一枚 tag 只有 listConversations 这一次
  // `PK=user#{sub}` 的 Query 可用 —— 消息级的 `via` 在 `conv#{id}` 分区里，会话没被点开
  // 就读不到；localStorage 那条换台机器就没了。少了这个字段，侧栏对没点开过的会话只能
  // **猜**，而把一段阿里云 / DevOps 会话标成 NotiOps 比不标更糟。
  // 只记最后一次（客户中途换对象就跟着变）—— 与 tag 的语义"现在这段对话对着谁"一致。
  const setObj = CONV_OBJ.has(obj) ? ", obj = :obj" : "";
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `user#${sub}`, SK: `conv#${conversationId}` },
      UpdateExpression: "SET updatedAt = :now, #ttl = :ttl" + setAcct + setObj,
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":now": Date.now(), ":ttl": ttl(),
        ...(accountId ? { ":acct": String(accountId) } : {}),
        ...(setObj ? { ":obj": obj } : {}),
      },
    }),
  ).catch(() => {});
}

export async function appendMessage(conversationId, msg) {
  const ts = msg.ts || Date.now();
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `conv#${conversationId}`,
        SK: `msg#${ts}`,
        ts,
        role: msg.role,
        text: msg.text,
        model: msg.model,
        sources: msg.sources,
        usage: msg.usage, // 本轮 token 用量 {inputTokens,outputTokens,totalTokens}
        account_id: msg.accountId || msg.account_id,  // 本轮针对的账号(多账号:历史回复标明账号徽标用)
        via: msg.via,   // 答案来源标记("devops-agent"=客户自己的 DevOps Agent 在答)。缺省=本地模型，
                        // 署名行据此显示 "AWS DevOps Agent" 而不是 "AWS Bedrock (某模型)"
        // 阿里云数字员工 ID(只有 via="starops" 那些轮有)：页脚里"这条是哪个数字员工答的"。
        // 必须逐轮落而不是读当前配置 —— 管理员换过员工之后,历史回复要仍显示**当时**那一个。
        // 不是凭据(`/features/starops` 本来就回给任何已登录用户)；workspace 才是敏感值,不落这里。
        starops_employee: msg.staropsEmployee || msg.starops_employee,
        ttl: ttl(),
      },
    }),
  );
}

export async function listConversations(sub) {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `user#${sub}`, ":sk": "conv#" },
      ScanIndexForward: false,
    }),
  );
  // obj：最后一轮的「对话对象」（notiops/devops/starops）。侧栏 tag 唯一的服务端事实来源 ——
  // 老会话没有这个属性（回 ""），前端据此显示中性的「通用」tag，**不许**猜成 NotiOps。
  return (r.Items || []).map((i) => ({ id: i.conversationId, title: i.title, updatedAt: i.updatedAt, topic: i.topic || "general", accountId: i.account_id || "", pinned: !!i.pinned, obj: i.obj || "" }));
}

/* ───────────────── 会话归属（对象级越权门禁）─────────────────
 * 表结构本身不绑用户：会话**头**在 `PK=user#{sub}`，但会话**消息**在
 * `PK=conv#{conversationId}`，`appendMessage` 连 `sub` 都不收。会话 id 又是
 * `conv-{毫秒}-{序号}` 这种低熵、可枚举的串（frontend 的 newId），于是任何一个登录用户
 * 拿别人的 id 就能读走整段历史、甚至 BatchWrite 删空对方的消息分区，返回还是 200。
 *
 * 修法不动表结构（这张表只有 PK+SK、没有 GSI）：会话头就在 `user#{sub}` 分区里，
 * 一次 GetItem 就能判归属。
 */

/** 会话头存在于 `user#{sub}` 分区 = 这个会话是他的。 */
export async function conversationOwnedBy(sub, conversationId) {
  if (!sub || !conversationId) return false;
  const r = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `user#${sub}`, SK: `conv#${conversationId}` },
    ProjectionExpression: "SK",
  }));
  return !!r?.Item;
}

/** 消息分区已被占用（`msg#` / `dachat` / `sochat` 任一条）。
 *  ⚠️ 刻意**不加** `begins_with(SK,"msg#")`：`dachat`（DevOps 对话）与 `sochat`
 *  （STAROps 对话）也要算上，否则一个只建过外部对话、还没落过消息的会话 id 会被判成
 *  "没人用" —— 于是别人可以拿这个 id 往里写。将来再加同类的"外部会话指针"行时，
 *  这里**什么都不用改**（正是不加 begins_with 的用意），但 deleteConversation 里
 *  那几条固定 SK 的删除必须同步补上。 */
export async function conversationPartitionUsed(conversationId) {
  if (!conversationId) return false;
  const r = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: { ":pk": `conv#${conversationId}` },
    ProjectionExpression: "SK",
    Limit: 1,
  }));
  return !!(r.Items && r.Items.length);
}

/** 纯函数（好单测真值表）：这一轮允不允许往这个 conversationId 上写。
 *  是我的会话 → 放行；不是我的、但分区已被占用 → 这是别人的 id，拒；
 *  两边都为假 → 全新会话的第一轮，放行（这才是正常路径）。 */
export const convAccessAllowed = ({ mine, partitionUsed }) => !!mine || !partitionUsed;

/** 一次最多读回多少条消息。刻意**硬编码默认值、不接 CDK 参数** —— 这是一条防止
 *  单次 Query 撞上 DynamoDB 1 MB 上限的内部安全阀，不是给客户调的产品旋钮。 */
const HISTORY_LIMIT = Number(process.env.WEB_CHAT_HISTORY_LIMIT || "400");

/**
 * 读一条会话的消息。返回 `{ messages, truncated }`。
 *
 * ⚠️ 原来的写法是「`ScanIndexForward: true`、不给 `Limit`、不看 `LastEvaluatedKey`」，
 * 于是一条长会话会**静默丢掉最新的那些轮次**：DynamoDB 单次 Query 上限 1 MB，
 * 正序取满就停在最老的那一页。深度调查的内联摘要单条能到 30-40 KB（CJK），
 * ~30 条就撞线 —— 用户看到的是"我刚问的那几轮不见了"，而且一条日志都没有。
 * 现在改成**倒序取最近 N 条**再翻回正序，并把"还有更早的没读"如实回给前端。
 *
 * 同一张表里 listNotifications / deleteConversation 早就是这么写的（有 Limit、
 * 有 LastEvaluatedKey、有 truncated），这里只是补上一致性。
 *
 * 还回一个 `limit`：前端那句"只显示最近 N 条"里的 N 只能来自服务端。写死 400 的话，
 * 有人改了 WEB_CHAT_HISTORY_LIMIT 之后界面就开始报一个假数字 —— 而报假数字正是这次
 * 要修的病本身。
 */
export async function listMessages(conversationId, limit) {
  const cap = Number(limit) > 0 ? Number(limit) : HISTORY_LIMIT;
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `conv#${conversationId}`, ":sk": "msg#" },
      ScanIndexForward: false, // 倒序 = 先拿最新的（要丢也只丢最早的）
      Limit: cap,
    }),
  );
  const messages = (r.Items || [])
    .map((i) => ({ role: i.role, text: i.text, ts: i.ts, model: i.model, sources: i.sources, usage: i.usage, account_id: i.account_id, via: i.via, starops_employee: i.starops_employee }))
    .reverse(); // 翻回时间正序，前端与 agent 的上下文都按正序消费
  return { messages, truncated: !!r.LastEvaluatedKey, limit: cap };
}

/* ───────── 「DevOps 对话」的 DevOps Agent 会话（多轮上下文）─────────
 * DevOps Agent 侧的对话历史挂在它自己的 executionId 上 —— 要"接着上一句问"就必须复用同一个
 * executionId，因此按 NotiOps 会话存一份。放在**消息分区**里（PK=conv#{id} / SK=dachat）：
 *   · 不占 msg# 段（listMessages 用 begins_with(SK,"msg#")，天然不会把它读成一条消息）；
 *   · 不需要 sub（消息分区本来就按 conversationId 分），删会话时随分区一起清。
 * ttl 与消息同策略（30 天）。读写失败一律降级成"新建对话"，不阻断问答。
 */
export async function getDevopsChatSession(conversationId) {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `conv#${conversationId}`, SK: "dachat" },
  }));
  const i = r?.Item;
  return i ? { executionId: i.executionId, agentSpaceId: i.agentSpaceId, accountId: i.account_id || "" } : null;
}

export async function setDevopsChatSession(conversationId, s) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `conv#${conversationId}`,
      SK: "dachat",
      executionId: s?.executionId,
      agentSpaceId: s?.agentSpaceId,
      account_id: s?.accountId || "",
      updatedAt: Date.now(),
      ttl: ttl(),
    },
  }));
}

/** 丢掉这条会话记着的 executionId。
 *
 * ⚠️ 这不是"清理"，是**修复动作**：上游把一个 executionId 弄死之后（`responseFailed` /
 * 只回心跳），留着它下一轮会原样复用、原样再坏一次 —— 客户看到的是"这个会话永久坏了"。
 * 删掉它，下一轮自然会新建一段对话（代价是丢多轮上下文，比永久坏掉便宜得多）。
 * 与 `deleteConversation()` 里删同一行的那一步是同一个 Key。
 */
export async function clearDevopsChatSession(conversationId) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { PK: `conv#${conversationId}`, SK: "dachat" },
  }));
}

/* ───────── 「STAROps 对话」的阿里云 thread（多轮上下文）─────────
 * 与上面的 `dachat` 同构、但**必须是另一行**：那边存的是 AWS DevOps Agent 的 executionId，
 * 这边存的是阿里云 STAROps 的 `threadId` + 数字员工名 + 地域。两朵云的会话句柄混在一行里，
 * 切换对话对象时就会拿 A 云的 id 去 B 云发请求（表现是一个语义不明的 404/403）。
 *
 * SK 固定为 `sochat`（STAROps chat）。同样放消息分区（PK=conv#{id}）：不占 `msg#` 段、
 * 不需要 sub、删会话时随分区一起清（见 deleteConversation 里那几条固定 SK 的删除）。
 *
 * ⚠️ `employee` 与 `region` 一起存下来，读的时候要**逐个比对**：客户在 Admin 里换了
 * 数字员工或换了地域之后，老 threadId 在新目标上根本不存在 —— 不比对就会拿它去发请求，
 * 换来一个 404 而客户完全不知道为什么（他只是改了个下拉框）。
 */
export async function getStarOpsThread(conversationId) {
  const r = await ddb.send(new GetCommand({
    TableName: TABLE,
    Key: { PK: `conv#${conversationId}`, SK: "sochat" },
  }));
  const i = r?.Item;
  return i ? { threadId: i.threadId, employee: i.employee || "", region: i.region || "" } : null;
}

export async function setStarOpsThread(conversationId, s) {
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `conv#${conversationId}`,
      SK: "sochat",
      threadId: s?.threadId,
      employee: s?.employee || "",
      region: s?.region || "",
      updatedAt: Date.now(),
      ttl: ttl(),
    },
  }));
}

/** 丢掉这条会话记着的 STAROps threadId。与 clearDevopsChatSession 同一用意：
 *  这不是"清理"，是**修复动作** —— thread 在阿里云侧被删/过期后留着它下一轮会原样复用、
 *  原样再坏一次，客户看到的是"这个会话永久坏了"。 */
export async function clearStarOpsThread(conversationId) {
  await ddb.send(new DeleteCommand({
    TableName: TABLE,
    Key: { PK: `conv#${conversationId}`, SK: "sochat" },
  }));
}

export async function renameConversation(sub, conversationId, title) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `user#${sub}`, SK: `conv#${conversationId}` },
      UpdateExpression: "SET title = :t, #ttl = :ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":t": (title || "New chat").slice(0, 80), ":ttl": ttl() },
      // Update 默认是 upsert：改一个不存在的 id 会在自己分区里凭空造一条只有 title 的
      // 幽灵会话头（没有 conversationId/topic），侧栏于是多出一行 id=undefined 的垃圾。
      ConditionExpression: "attribute_exists(SK)",
    }),
  ).catch(() => {});
}

/** 置顶/取消置顶（持久化到会话记录，刷新后保留）。 */
export async function setConversationPinned(sub, conversationId, pinned) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `user#${sub}`, SK: `conv#${conversationId}` },
      UpdateExpression: "SET pinned = :p, #ttl = :ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":p": !!pinned, ":ttl": ttl() },
      ConditionExpression: "attribute_exists(SK)", // 同 renameConversation：不许 upsert 出幽灵会话头
    }),
  ).catch(() => {});
}

/* ───────────────── 通知收件箱（主动观察 push 的 web 端 sink）─────────────────
 * 由 shared/report_delivery/web_push_handler.py 写入（EventBridge 事件 → 落库）。
 * BFF 侧只读 + 维护"已读游标"。账号级共享一份收件箱（方案 Q1 一期选 account 级）。
 *   通知事件:  PK=notif#{key}   SK=evt#{ts13}#{dedupe}   （web_push_handler 写）
 *   已读游标:  PK=notif#{key}   SK=cursor                （本文件维护）
 * key 默认 "account"（与 handler 的 NOTIF_INBOX_KEY 对齐）。
 */
const NOTIF_KEY = process.env.NOTIF_INBOX_KEY || "account";

/** 列出通知（倒序，最新在前）。返回 {items, lastReadTs, total, truncated, bySource}。
 *
 * 【为什么要返回 total/truncated】收件箱是累积的（TTL 90 天，见 web_push_handler.py 的
 * NOTIF_TTL_DAYS），而这里只取最新 limit 条。稳态条数 ≈ 日均新增 × 90，一旦超过 limit，
 * 旧实现会**静默截断**：徽章永远顶在 limit、更老的通知看不到，且界面上没有任何提示
 * （对比 Health 那几栏有 moreCount + "更多去控制台"）。用户会以为"就这些"。
 * 故这里显式回传真实总数 + 是否被截断，由前端如实展示"显示最新 N 条，共 M 条"。
 *
 * 【为什么要返回 bySource】前端按事件类型分组展示（CloudWatch 告警 / AWS Health /
 * Backup / GuardDuty …），每组的徽章要是**该类型在整个收件箱里的真实条数**，而不是
 * "本页碰巧取到的条数" —— 否则一截断，各组徽章就一起变成谎报的小数字。
 *
 * 【成本】未截断（常态）时 items 就是全量，total/bySource 直接本地算，零额外查询。
 * 只有确实被截断才多发一次投影聚合（只读 source 属性，见 aggregateBySource）。
 * withTotal=false 则完全跳过聚合 —— 60s 轮询的 unread 路径用它，避免热路径涨成本。
 */
export async function listNotifications(limit = 200, withTotal = true) {
  const [evts, cursor] = await Promise.all([
    ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `notif#${NOTIF_KEY}`, ":sk": "evt#" },
      ScanIndexForward: false, // 最新在前
      Limit: limit,
    })),
    ddb.send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND SK = :sk",
      ExpressionAttributeValues: { ":pk": `notif#${NOTIF_KEY}`, ":sk": "cursor" },
    })).catch(() => ({ Items: [] })),
  ]);
  const lastReadTs = (cursor.Items && cursor.Items[0] && cursor.Items[0].lastReadTs) || 0;
  const items = (evts.Items || []).map((i) => ({
    id: i.SK, ts: i.ts, source: i.source, title: i.title, severity: i.severity,
    resource: i.resource, region: i.region, account: i.account,
    description: i.description, consoleUrl: i.console_url,
    dispatchQuery: i.dispatch_query, read: i.ts <= lastReadTs,
  }));
  // 判据用 LastEvaluatedKey 而非 items.length === limit：后者在"恰好 limit 条"时会误报截断。
  const truncated = !!evts.LastEvaluatedKey;
  if (!truncated) {
    // 常态：本页即全量，总数/分类数直接本地算，不发额外查询。
    return { items, lastReadTs, total: items.length, truncated, bySource: tally(items) };
  }
  const agg = withTotal ? await aggregateBySource() : null;
  // agg 为 null（聚合失败或 withTotal=false）→ 如实回 null，让前端说"未知总数"而不是编一个。
  return { items, lastReadTs, total: agg?.total ?? null, truncated, bySource: agg?.bySource ?? null };
}

/** 按 source 计数：{"CloudWatch Alarm": 16, "AWS Health": 28} */
const tally = (items) => items.reduce((m, i) => { const k = i.source || "?"; m[k] = (m[k] || 0) + 1; return m; }, {});

/** 全收件箱按 source 聚合（真实总数 + 每类条数），分页累加。
 *  用 ProjectionExpression 只取 source —— 单条 ~1.4KB，投影后每条几十字节，
 *  1MB 上限下一次就能扫上万条；不投影则 700 条就要翻页。
 *  #s 转义：source 不是 DynamoDB 保留字，但 SDK 侧统一用 ExpressionAttributeNames 更稳。
 *  仅在列表被截断时调用。失败 → null（调用方降级成"未知总数"，不谎报）。 */
async function aggregateBySource() {
  const bySource = {};
  let total = 0, lastKey;
  try {
    do {
      const r = await ddb.send(new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `notif#${NOTIF_KEY}`, ":sk": "evt#" },
        ExpressionAttributeNames: { "#s": "source" },
        ProjectionExpression: "#s",
        ExclusiveStartKey: lastKey,
      }));
      for (const it of r.Items || []) {
        const k = it.source || "?";
        bySource[k] = (bySource[k] || 0) + 1;
        total++;
      }
      lastKey = r.LastEvaluatedKey;
    } while (lastKey);
  } catch {
    return null;
  }
  return { total, bySource };
}

/** 未读数 = ts > lastReadTs 的通知条数（前端红点用，60s 轮询）。
 *  取 200 条窗口：未读数只在"用户没进过页面"时才可能大，200 足够；且显式 withTotal=false
 *  跳过聚合分页 —— 这是每 60s 打一次的热路径，不能让它随收件箱增长而涨成本。
 *  total 这里只是本次窗口内条数，红点逻辑不依赖它。 */
export async function unreadNotifications() {
  const { items } = await listNotifications(200, false);
  const unread = items.filter((i) => !i.read).length;
  const latestTs = items.length ? items[0].ts : 0;
  return { unread, latestTs, total: items.length };
}

/** 标记已读到某时间点（默认到最新）：把已读游标前移到 ts。 */
export async function markNotificationsRead(uptoTs) {
  const ts = Number(uptoTs) || Date.now();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      PK: `notif#${NOTIF_KEY}`, SK: "cursor",
      lastReadTs: ts,
      ttl: Math.floor(Date.now() / 1000) + 400 * 86400, // 游标存久一点（400天）
    },
  })).catch(() => {});
  return { ok: true, lastReadTs: ts };
}

/** 删除一个会话及其全部消息（用户显式删除 → 立即移除，不等 TTL）。
 *
 * ⚠️ 第 2、3 步删的是 `conv#{id}` 分区，**与 sub 无关**。所以这里必须先确认归属再动手：
 * 原来第 1 步删一个不属于自己的会话头只是静默 no-op（`.catch(() => {})`），第 2、3 步
 * 却照样把对方的整段消息 BatchWrite 删干净，还回 `200 {ok:true}`、不留一条日志。
 * 路由层已经有一道门禁，这里再兜一次 —— 这一步不可逆，不能只靠调用方记得检查。
 */
export async function deleteConversation(sub, conversationId) {
  if (!(await conversationOwnedBy(sub, conversationId))) return { ok: false, code: "not_found" };
  // 1) 删会话头
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: `user#${sub}`, SK: `conv#${conversationId}` },
    }),
  ).catch(() => {});
  // 2) 删该会话所有消息（分页查 + 批量删，每批 25 条）
  let lastKey;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: { ":pk": `conv#${conversationId}`, ":sk": "msg#" },
        ProjectionExpression: "PK, SK",
        ExclusiveStartKey: lastKey,
      }),
    );
    const items = r.Items || [];
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25).map((it) => ({
        DeleteRequest: { Key: { PK: it.PK, SK: it.SK } },
      }));
      if (batch.length) {
        await ddb.send(new BatchWriteCommand({ RequestItems: { [TABLE]: batch } })).catch(() => {});
      }
    }
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  // 3) 删外部会话句柄（同分区、SK 固定，不在上面 msg# 的扫描范围里）：
  //    `dachat` = DevOps Agent 的 executionId，`sochat` = 阿里云 STAROps 的 threadId。
  //    留着不删的后果：同名 conversationId 极小概率复用时会接到一条陌生的外部对话上。
  //    ⚠️ 新增同类行时必须往这个数组里补一条 —— 分区扫描只覆盖 `msg#`，扫不到它们。
  for (const sk of ["dachat", "sochat"]) {
    await ddb.send(
      new DeleteCommand({ TableName: TABLE, Key: { PK: `conv#${conversationId}`, SK: sk } }),
    ).catch(() => {});
  }
  return { ok: true };
}
