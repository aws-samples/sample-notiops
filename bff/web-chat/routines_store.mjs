/**
 * 定时任务的持久化（notiops-web-chat 表，两条部署路径都有）。
 *
 *   任务定义   PK=routine#all        SK=routine#<id>      （一次 Query 读全部；任务数有上限）
 *   运行记录   PK=routine#<id>       SK=run#<计划时间 ISO>  （ttl 90 天；同一个计划时间只会写一次）
 *   tick 租约  PK=routine#all        SK=lease#tick        （同一时刻只有一个 tick 在派发 / 回收）
 *   总开关     notiops-config 表 PK=appconfig#routines SK=enabled（与巡检的 appconfig#inspection 同一写法）
 *
 * 任务定义带 `version`：API 改任务与 tick 改任务（下次运行时间、进行中的那次）可能撞在一起，
 * 条件写 `version = :v` 防止后写的把先写的静默覆盖；撞上了由调用方重读再试。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const TABLE = process.env.WEB_CHAT_TABLE || "notiops-web-chat";
const CONFIG_TABLE = process.env.CONFIG_TABLE || "notiops-config";
export const RUN_TTL_DAYS = 90;

let _ddb = null;
const ddb = () => (_ddb ||= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
}));
/** 仅供测试：换掉 DynamoDB 客户端（`{ send }`）。 */
export function _setDdb(client) { _ddb = client; }

const ALL = "routine#all";
const defKey = (id) => ({ PK: ALL, SK: `routine#${id}` });
export const runSk = (scheduledMs) => `run#${new Date(scheduledMs).toISOString()}`;

/** 去掉存储字段，回给调用方的任务对象。 */
function strip(item) {
  if (!item) return null;
  const { PK, SK, ...rest } = item;
  return rest;
}

export async function listRoutines() {
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb().send(new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": ALL, ":sk": "routine#" },
      ExclusiveStartKey,
    }));
    for (const it of r.Items || []) out.push(strip(it));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

export async function getRoutine(id) {
  const r = await ddb().send(new GetCommand({ TableName: TABLE, Key: defKey(id) }));
  return strip(r.Item);
}

/** 新建（id 撞了就报错，不覆盖）。 */
export async function createRoutine(routine) {
  const item = { ...defKey(routine.id), ...routine, version: 1 };
  await ddb().send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: "attribute_not_exists(SK)" }));
  return strip(item);
}

/**
 * 整条写回，要求库里的 version 还是读出来时那个（乐观锁）。成功返回新对象；被别人先改了抛
 * `{ name: "RoutineConflict" }`，调用方重读再试。
 */
export async function saveRoutine(routine) {
  const prev = Number(routine.version || 0);
  const item = { ...defKey(routine.id), ...routine, version: prev + 1 };
  try {
    await ddb().send(new PutCommand({
      TableName: TABLE, Item: item,
      ConditionExpression: "attribute_exists(SK) AND version = :v",
      ExpressionAttributeValues: { ":v": prev },
    }));
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") throw Object.assign(new Error("routine_conflict"), { name: "RoutineConflict" });
    throw e;
  }
  return strip(item);
}

/** 读 → 改 → 带版本写回；撞上并发修改就重读重试（最多 3 次）。`mutate` 返回 null = 不写。 */
export async function updateRoutine(id, mutate) {
  for (let i = 0; i < 3; i++) {
    const cur = await getRoutine(id);
    if (!cur) return null;
    const next = mutate(structuredClone(cur));
    if (!next) return cur;
    try { return await saveRoutine(next); }
    catch (e) { if (e?.name !== "RoutineConflict") throw e; }
  }
  throw Object.assign(new Error("routine_conflict"), { name: "RoutineConflict" });
}

export async function deleteRoutine(id) {
  await ddb().send(new DeleteCommand({ TableName: TABLE, Key: defKey(id) }));
}

/** 写一条运行记录。同一个计划时间已经写过 → 返回 false（两轮 tick 撞上也只会有一条）。 */
export async function putRun(routineId, run) {
  const item = {
    PK: `routine#${routineId}`, SK: runSk(run.scheduled_at), ...run,
    ttl: Math.floor(Date.now() / 1000) + RUN_TTL_DAYS * 86400,
  };
  try {
    await ddb().send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: "attribute_not_exists(SK)" }));
    return true;
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/** 覆盖一条运行记录里的字段（读出来合并后整条写回；运行记录只有 tick 和「立即运行」写，不会并发改同一条）。 */
export async function updateRun(routineId, sk, fields) {
  const r = await ddb().send(new GetCommand({ TableName: TABLE, Key: { PK: `routine#${routineId}`, SK: sk } }));
  if (!r.Item) return null;
  const item = { ...r.Item, ...fields };
  await ddb().send(new PutCommand({ TableName: TABLE, Item: item }));
  return strip(item);
}

/** 最近 limit 次运行（新的在前）。 */
export async function listRuns(routineId, limit = 50) {
  const r = await ddb().send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
    ExpressionAttributeValues: { ":pk": `routine#${routineId}`, ":sk": "run#" },
    ScanIndexForward: false,
    Limit: limit,
  }));
  return (r.Items || []).map((i) => ({ ...strip(i), sk: i.SK }));
}

/** tick 租约：拿到返回 true。租约过期（上一个 tick 崩了没释放）也能拿。 */
export async function acquireLease(now, ttlMs, owner) {
  try {
    await ddb().send(new PutCommand({
      TableName: TABLE,
      Item: { PK: ALL, SK: "lease#tick", until: now + ttlMs, owner, at: now },
      ConditionExpression: "attribute_not_exists(SK) OR #u < :now",
      ExpressionAttributeNames: { "#u": "until" },
      ExpressionAttributeValues: { ":now": now },
    }));
    return true;
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

export async function releaseLease(owner) {
  try {
    await ddb().send(new DeleteCommand({
      TableName: TABLE, Key: { PK: ALL, SK: "lease#tick" },
      ConditionExpression: "#o = :o", ExpressionAttributeNames: { "#o": "owner" },
      ExpressionAttributeValues: { ":o": owner },
    }));
  } catch { /* 已过期被别人拿走 / 已删 —— 不影响 */ }
}

/**
 * 总开关（不改代码、不重新部署就能停掉所有定时任务的**派发**；进行中的照样回收结果）。
 * 行不存在 → 开着；读失败 → 也当开着并记 ERROR（与巡检 inspection/adapters/switches.py 同一取舍：
 * 一次 DDB 抖动不该静默停掉整个功能）。值接受 "0"/"false"/"1"/"true" 与原生 bool / 数字。
 */
export async function routinesEnabled() {
  try {
    const r = await ddb().send(new GetCommand({
      TableName: CONFIG_TABLE, Key: { PK: "appconfig#routines", SK: "enabled" },
    }));
    const v = r.Item?.config_value;
    if (v === undefined || v === null) return true;
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    return !["0", "false", "off", "no"].includes(String(v).trim().toLowerCase());
  } catch (e) {
    console.error(`[routines] kill switch read failed (${e?.name || "Error"}) — treating as enabled`);
    return true;
  }
}
