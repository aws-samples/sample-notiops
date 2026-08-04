/**
 * Investigation 告警仪表盘数据源（只读）。
 * CloudWatch DescribeAlarms（当前状态）+ DescribeAlarmHistory（最近状态变更）。
 * 绝不创建/修改/删除告警（遵守 zero-change promise）。
 * 本期为部署账号自身视角；跨账号（AssumeRole）作为后续增强。
 */
import { CloudWatchClient, DescribeAlarmsCommand, DescribeAlarmHistoryCommand } from "@aws-sdk/client-cloudwatch";
import { credsFor } from "./xacct.mjs";
import { fillAccountNames } from "./accounts.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const _cw = new CloudWatchClient({ region: REGION });

export async function getAlarmDashboard(accountId) {
  let cw = _cw;
  try {
    const creds = await credsFor(accountId); // null = 部署账号
    if (creds) cw = new CloudWatchClient({ region: REGION, credentials: creds });
  } catch {
    return { ok: true, accountId: String(accountId || ""), available: false, reason: "cross_account_unavailable", overview: { ALARM: 0, OK: 0, INSUFFICIENT_DATA: 0 }, active: [], recent: [] };
  }
  try {
    const out = await cw.send(new DescribeAlarmsCommand({ MaxRecords: 100 }));
    const metric = (out.MetricAlarms || []).map((a) => ({
      name: a.AlarmName, state: a.StateValue, metric: a.MetricName || "", namespace: a.Namespace || "",
      reason: a.StateReason || "", updated: a.StateUpdatedTimestamp ? new Date(a.StateUpdatedTimestamp).toISOString() : "",
    }));
    const composite = (out.CompositeAlarms || []).map((a) => ({
      name: a.AlarmName, state: a.StateValue, metric: "(composite)", namespace: "",
      reason: a.StateReason || "", updated: a.StateUpdatedTimestamp ? new Date(a.StateUpdatedTimestamp).toISOString() : "",
    }));
    const all = [...metric, ...composite];
    const overview = { ALARM: 0, OK: 0, INSUFFICIENT_DATA: 0 };
    for (const a of all) if (overview[a.state] != null) overview[a.state]++;
    const active = all
      .filter((a) => a.state === "ALARM")
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
      .slice(0, 20);

    let recent = [];
    try {
      const h = await cw.send(new DescribeAlarmHistoryCommand({ HistoryItemType: "StateUpdate", MaxRecords: 25 }));
      recent = (h.AlarmHistoryItems || []).map((i) => ({
        name: i.AlarmName || "", summary: i.HistorySummary || "",
        date: i.Timestamp ? new Date(i.Timestamp).toISOString() : "",
      }));
    } catch { /* 历史取不到不影响总览 */ }

    return { ok: true, available: true, overview, total: all.length, active, recent };
  } catch (e) {
    return { ok: true, available: false, reason: e?.name || "error" };
  }
}


// ─── Investigation 多账号：告警 org 汇总（per-account ALARM 计数，10min 缓存）───
import { DynamoDBClient as _ADdb } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient as _ADoc, GetCommand as _AGet, PutCommand as _APut, QueryCommand as _AQuery } from "@aws-sdk/lib-dynamodb";
import { STSClient as _ASts, GetCallerIdentityCommand as _AGci } from "@aws-sdk/client-sts";
const _addb = _ADoc.from(new _ADdb({}), { marshallOptions: { removeUndefinedValues: true } });
const _A_AGG = process.env.WEB_CHAT_TABLE || "notiops-web-chat";
const _A_CFG = process.env.CONFIG_TABLE || "notiops-config";
const _A_TTL = 10 * 60 * 1000;

async function _alarmCountsFor(accountId, name) {
  try {
    let cw = _cw;
    const creds = await credsFor(accountId);
    if (creds) cw = new CloudWatchClient({ region: REGION, credentials: creds });
    const out = await cw.send(new DescribeAlarmsCommand({ MaxRecords: 100 }));
    const all = [...(out.MetricAlarms || []), ...(out.CompositeAlarms || [])];
    const c = { ALARM: 0, OK: 0, INSUFFICIENT_DATA: 0 };
    for (const a of all) if (c[a.StateValue] != null) c[a.StateValue]++;
    return { accountId, name, available: true, total: all.length, ...c };
  } catch {
    return { accountId, name, available: false, total: 0, ALARM: 0, OK: 0, INSUFFICIENT_DATA: 0 };
  }
}

export async function getAlarmOrgSummary(visibleSet) {
  const cacheKey = { PK: "agg#alarms", SK: "__rollup__" };
  let data = null;
  try {
    const hit = await _addb.send(new _AGet({ TableName: _A_AGG, Key: cacheKey }));
    if (hit.Item && Date.now() - (hit.Item.at || 0) < _A_TTL) data = hit.Item.data;
  } catch { /* 缓存不可用不阻断 */ }
  if (!data) {
    const self = (await new _ASts({}).send(new _AGci({}))).Account || "";
    const q = await _addb.send(new _AQuery({
      TableName: _A_CFG, IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "accounts" },
    }));
    const members = (q.Items || []).filter((it) => it.enabled === true && String(it.account_id) !== self)
      .map((it) => ({ accountId: String(it.account_id), name: String(it.account_name || it.name || it.account_id) }));
    const targets = [{ accountId: "", name: "(deployment account)" }, ...members];
    const rows = [];
    for (let i = 0; i < targets.length; i += 4) {
      const settled = await Promise.allSettled(targets.slice(i, i + 4).map((a) => _alarmCountsFor(a.accountId, a.name)));
      for (const x of settled) if (x.status === "fulfilled") rows.push(x.value);
    }
    // 部署账号行补真实 id/名（默认空 accountId → 显示 self；名从 config 取，兜底 Management account）
    const selfName = (q.Items || []).find((it) => String(it.account_id) === self)?.account_name || "Management account";
    for (const r of rows) if (!r.accountId) { r.accountId = self; r.name = selfName; r.isDeployment = true; }
    rows.sort((a, b) => b.ALARM - a.ALARM || b.total - a.total);
    data = { generatedAt: new Date().toISOString(), rows };
    try { await _addb.send(new _APut({ TableName: _A_AGG, Item: { ...cacheKey, at: Date.now(), data, ttl: Math.floor(Date.now() / 1000) + 86400 } })); } catch { /* 忽略 */ }
  }
  // 可见性过滤在缓存读之后（缓存存全量，按用户过滤）
  await fillAccountNames(data.rows || []);
  if (!visibleSet || visibleSet === "*") return data;
  const rows = (data.rows || []).filter((r) => !r.accountId || visibleSet.has(String(r.accountId)));
  return { ...data, rows };
}
