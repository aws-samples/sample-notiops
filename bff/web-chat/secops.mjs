/**
 * ④ SecOps 仪表盘数据源（只读）：GuardDuty 发现 + Backup 任务健康。
 * 跨账号：?account= 经 xacct.credsFor 取目标账号凭证（多账号契约同 security.mjs）。
 * 各自独立降级（未开通 GuardDuty / 无 Backup 任务 → available:false / 空态）。
 * 容器级 5 分钟缓存（按账号分键）。
 */
import { GuardDutyClient, ListDetectorsCommand, GetFindingsStatisticsCommand, ListFindingsCommand, GetFindingsCommand } from "@aws-sdk/client-guardduty";
import { BackupClient, ListBackupJobsCommand, ListBackupVaultsCommand } from "@aws-sdk/client-backup";
import { credsFor } from "./xacct.mjs";
import { fillAccountNames } from "./accounts.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const gdFor = (creds) => new GuardDutyClient({ region: REGION, credentials: creds || undefined });
const buFor = (creds) => new BackupClient({ region: REGION, credentials: creds || undefined });

/* ── GuardDuty：严重度分布 + Top 高危发现 ── */
async function guardduty(creds) {
  try {
    const gd = gdFor(creds);
    const dets = await gd.send(new ListDetectorsCommand({}));
    const detectorId = (dets.DetectorIds || [])[0];
    if (!detectorId) return { available: false, reason: "not_enabled" };
    const stats = await gd.send(new GetFindingsStatisticsCommand({
      DetectorId: detectorId,
      FindingStatisticTypes: ["COUNT_BY_SEVERITY"],
      FindingCriteria: { Criterion: { "service.archived": { Eq: ["false"] } } },
    }));
    const bySev = stats.FindingStatistics?.CountBySeverity || {};
    // 数字键（如 "8.0"）→ 分档
    const sev = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
    let total = 0;
    for (const [k, v] of Object.entries(bySev)) {
      const n = Number(v) || 0; total += n;
      const s = Number(k);
      if (s >= 9) sev.CRITICAL += n; else if (s >= 7) sev.HIGH += n;
      else if (s >= 4) sev.MEDIUM += n; else sev.LOW += n;
    }
    // Top 高危（≥7）
    let top = [];
    try {
      const ids = await gd.send(new ListFindingsCommand({
        DetectorId: detectorId, MaxResults: 8,
        FindingCriteria: { Criterion: { severity: { Gte: 7 }, "service.archived": { Eq: ["false"] } } },
        SortCriteria: { AttributeName: "severity", OrderBy: "DESC" },
      }));
      if (ids.FindingIds?.length) {
        const f = await gd.send(new GetFindingsCommand({ DetectorId: detectorId, FindingIds: ids.FindingIds }));
        top = (f.Findings || []).map((x) => ({
          title: x.Title || "", severity: x.Severity ?? 0, type: x.Type || "",
          resource: x.Resource?.ResourceType || "", region: x.Region || "", updatedAt: x.UpdatedAt || "",
        }));
      }
    } catch { /* Top 拉不到不阻断统计 */ }
    return { available: true, severity: sev, total, top };
  } catch (e) {
    return { available: false, reason: e?.name || "error" };
  }
}

/* ── Backup：近 7 天任务健康 + 保护面 ── */
async function backup(creds) {
  try {
    const bu = buFor(creds);
    const since = new Date(Date.now() - 7 * 86400000);
    const jobs = [];
    let token;
    do {
      const r = await bu.send(new ListBackupJobsCommand({ ByCreatedAfter: since, MaxResults: 200, NextToken: token }));
      jobs.push(...(r.BackupJobs || []));
      token = r.NextToken;
    } while (token && jobs.length < 600);
    const byState = {};
    for (const j of jobs) byState[j.State || "UNKNOWN"] = (byState[j.State || "UNKNOWN"] || 0) + 1;
    const failed = jobs.filter((j) => ["FAILED", "ABORTED", "EXPIRED"].includes(j.State || ""))
      .slice(0, 8).map((j) => ({
        resource: j.ResourceArn?.split(":").pop() || "", resourceType: j.ResourceType || "",
        state: j.State || "", message: (j.StatusMessage || "").slice(0, 160),
        createdAt: j.CreationDate ? new Date(j.CreationDate).toISOString() : "",
      }));
    let vaults = 0;
    try { vaults = ((await bu.send(new ListBackupVaultsCommand({ MaxResults: 100 }))).BackupVaultList || []).length; } catch { /* 可选 */ }
    return {
      available: true, windowDays: 7, totalJobs: jobs.length, byState,
      failedCount: failed.length ? jobs.filter((j) => ["FAILED", "ABORTED", "EXPIRED"].includes(j.State || "")).length : 0,
      failed, vaults,
    };
  } catch (e) {
    return { available: false, reason: e?.name || "error" };
  }
}

/* ── 汇总（并行 + 按账号缓存 5 分钟）── */
const _cache = new Map();
const TTL = 5 * 60 * 1000;

export async function getGuarddutyDashboard(accountId) {
  const key = "gd#" + (accountId || "self");
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  let creds = null;
  try { creds = await credsFor(accountId); }
  catch { return { ok: true, available: false, reason: "cross_account_unavailable" }; }
  const data = { ok: true, accountId: String(accountId || ""), ...(await guardduty(creds)) };
  _cache.set(key, { at: Date.now(), data });
  return data;
}

export async function getBackupDashboard(accountId) {
  const key = "bu#" + (accountId || "self");
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  let creds = null;
  try { creds = await credsFor(accountId); }
  catch { return { ok: true, available: false, reason: "cross_account_unavailable" }; }
  const data = { ok: true, accountId: String(accountId || ""), ...(await backup(creds)) };
  _cache.set(key, { at: Date.now(), data });
  return data;
}

// ─── Security 组织概览：per-account 安全态势（GuardDuty 高危 + TA 安全问题），10min 缓存 ───
import { DynamoDBClient as _SDdb } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient as _SDoc, GetCommand as _SGet, PutCommand as _SPut, QueryCommand as _SQuery } from "@aws-sdk/lib-dynamodb";
import { STSClient as _SSts, GetCallerIdentityCommand as _SGci } from "@aws-sdk/client-sts";
import { OrganizationsClient as _SOrg, DescribeAccountCommand as _SDesc } from "@aws-sdk/client-organizations";
const _sddb = _SDoc.from(new _SDdb({}), { marshallOptions: { removeUndefinedValues: true } });
const _S_AGG = process.env.WEB_CHAT_TABLE || "notiops-web-chat";
const _S_CFG = process.env.CONFIG_TABLE || "notiops-config";
const _S_TTL = 10 * 60 * 1000;

async function _secCountsFor(accountId) {
  const gd = await getGuarddutyDashboard(accountId);
  const gdHigh = gd && gd.available ? ((gd.severity?.CRITICAL || 0) + (gd.severity?.HIGH || 0)) : null;
  let taIssues = null;
  try {
    const { getSecurityDashboard } = await import("./security.mjs");
    const sec = await getSecurityDashboard(accountId);
    if (sec && sec.trustedAdvisor && sec.trustedAdvisor.available) {
      taIssues = (sec.trustedAdvisor.summary?.error || 0) + (sec.trustedAdvisor.summary?.warning || 0);
    }
  } catch { /* 降级 */ }
  return { gdHigh, taIssues, available: gdHigh !== null || taIssues !== null };
}

export async function getSecurityOrgSummary(visibleSet) {
  const cacheKey = { PK: "agg#security", SK: "__rollup__" };
  let data = null;
  try {
    const hit = await _sddb.send(new _SGet({ TableName: _S_AGG, Key: cacheKey }));
    if (hit.Item && Date.now() - (hit.Item.at || 0) < _S_TTL) data = hit.Item.data;
  } catch { /* 忽略 */ }
  if (!data) {
    const self = (await new _SSts({}).send(new _SGci({}))).Account || "";
    const q = await _sddb.send(new _SQuery({ TableName: _S_CFG, IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "accounts" } }));
    let selfName = (q.Items || []).find((it) => String(it.account_id) === self)?.account_name || "";
    if (!selfName && self) { try { selfName = (await new _SOrg({}).send(new _SDesc({ AccountId: self })))?.Account?.Name || ""; } catch { /* 兜底 */ } }
    selfName = selfName || "Management account";
    const members = (q.Items || []).filter((it) => it.enabled === true && String(it.account_id) !== self)
      .map((it) => ({ accountId: String(it.account_id), name: String(it.account_name || it.name || it.account_id) }));
    const targets = [{ accountId: "", name: selfName, selfId: self, isDeployment: true }, ...members.map((m) => ({ ...m, isDeployment: false }))];
    const rows = [];
    for (const a of targets) {
      const c = await _secCountsFor(a.accountId);
      rows.push({ accountId: a.isDeployment ? a.selfId : a.accountId, name: a.name, isDeployment: a.isDeployment, ...c });
    }
    rows.sort((x, y) => (y.gdHigh || 0) - (x.gdHigh || 0) || (y.taIssues || 0) - (x.taIssues || 0));
    data = { generatedAt: new Date().toISOString(), rows };
    try { await _sddb.send(new _SPut({ TableName: _S_AGG, Item: { ...cacheKey, at: Date.now(), data, ttl: Math.floor(Date.now() / 1000) + 86400 } })); } catch { /* 忽略 */ }
  }
  if (!visibleSet || visibleSet === "*") { await fillAccountNames(data.rows || []); return data; }
  const rows = (data.rows || []).filter((r) => r.isDeployment || visibleSet.has(String(r.accountId)));
  await fillAccountNames(rows);
  return { ...data, rows };
}
