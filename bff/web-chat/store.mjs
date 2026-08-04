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
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

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
  return (r.Items || []).map((i) => ({ role: i.role, text: i.text, ts: i.ts, model: i.model, sources: i.sources, usage: i.usage, account_id: i.account_id }));
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

/** 列出通知（倒序，最新在前）。limit 默认 100。返回 {items, lastReadTs}。 */
export async function listNotifications(limit = 100) {
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
  return { items, lastReadTs };
}

/** 未读数 = ts > lastReadTs 的通知条数（前端红点用；只查键投影，省流量）。 */
export async function unreadNotifications() {
  const { items } = await listNotifications(200);
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
}
