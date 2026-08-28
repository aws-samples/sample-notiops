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

export async function touchConversation(sub, conversationId, accountId) {
  // account_id：会话曾接触过的成员账号（可见性回收时按此过滤历史会话；
  // 一个会话只记最后一次非空账号，够用 —— 严格多账号会话建议开新对话）
  const setAcct = accountId ? ", account_id = :acct" : "";
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `user#${sub}`, SK: `conv#${conversationId}` },
      UpdateExpression: "SET updatedAt = :now, #ttl = :ttl" + setAcct,
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":now": Date.now(), ":ttl": ttl(), ...(accountId ? { ":acct": String(accountId) } : {}) },
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
  return (r.Items || []).map((i) => ({ id: i.conversationId, title: i.title, updatedAt: i.updatedAt, topic: i.topic || "general", accountId: i.account_id || "", pinned: !!i.pinned }));
}

export async function listMessages(conversationId) {
  const r = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": `conv#${conversationId}`, ":sk": "msg#" },
      ScanIndexForward: true,
    }),
  );
  return (r.Items || []).map((i) => ({ role: i.role, text: i.text, ts: i.ts, model: i.model, sources: i.sources, usage: i.usage, account_id: i.account_id, via: i.via }));
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

export async function renameConversation(sub, conversationId, title) {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `user#${sub}`, SK: `conv#${conversationId}` },
      UpdateExpression: "SET title = :t, #ttl = :ttl",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":t": (title || "New chat").slice(0, 80), ":ttl": ttl() },
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

/** 删除一个会话及其全部消息（用户显式删除 → 立即移除，不等 TTL）。 */
export async function deleteConversation(sub, conversationId) {
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
  // 3) 删「DevOps 对话」的 executionId 记录（同分区、SK 固定，不在上面 msg# 的扫描范围里）。
  //    留着不删的后果：同名 conversationId 极小概率复用时会接到一条陌生的 DevOps Agent 对话上。
  await ddb.send(
    new DeleteCommand({ TableName: TABLE, Key: { PK: `conv#${conversationId}`, SK: "dachat" } }),
  ).catch(() => {});
}
