/**
 * EOS / 生命周期数据源（Notifications 的「生命周期/EOS」小节）。
 *
 * 数据源优先级（每个资源版本）：admin 覆盖(DDB) > 实时 API(RDS/EKS) > AWS Health 事件(Step E) > 内置表(eol-dates.json)。
 *   - RDS/Aurora：describeDBEngineVersions.SupportedEngineLifecycle.LifecycleSupportEndDate（API 权威）
 *   - EKS：describeClusterVersions.endOfStandardSupportDate（API 权威）
 *   - Lambda / ElastiCache / OpenSearch / EMR：无版本 EOL API → 内置表 + admin 覆盖（Health 融合见 Step E）
 *
 * 单账号、多 region（describeRegions 枚举已启用 region）。每个服务/每个 region 独立 try/catch，
 * 任一失败仅降级该部分，不影响整体（对齐 security.mjs 的“各源独立降级”）。全只读。
 */
import { EC2Client, DescribeRegionsCommand } from "@aws-sdk/client-ec2";
import { fillAccountNames } from "./accounts.mjs";
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand, DescribeDBEngineVersionsCommand } from "@aws-sdk/client-rds";
import { EKSClient, ListClustersCommand, DescribeClusterCommand, DescribeClusterVersionsCommand } from "@aws-sdk/client-eks";
import { LambdaClient, ListFunctionsCommand } from "@aws-sdk/client-lambda";
import { ElastiCacheClient, DescribeCacheClustersCommand } from "@aws-sdk/client-elasticache";
import { OpenSearchClient, ListDomainNamesCommand, DescribeDomainsCommand } from "@aws-sdk/client-opensearch";
import { EMRClient, ListClustersCommand as EmrListClustersCommand, DescribeClusterCommand as EmrDescribeClusterCommand } from "@aws-sdk/client-emr";
import { HealthClient, DescribeEventsCommand } from "@aws-sdk/client-health";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getEolOverrides as _getEolOverrides } from "./rbac_store.mjs";
import { credsFor } from "./xacct.mjs";

// 跨账号：请求级凭证（Lambda 同容器同一时刻只处理一个请求，模块级变量安全）。
// null = 部署账号默认凭证。所有 scanner 建客户端统一经 _cc()。
let _creds = null;
const _cc = (region) => (_creds ? { region, credentials: _creds } : { region });

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGION = process.env.AWS_REGION || "us-east-1";
const DAY = 86400000;

// 内置兜底表：同目录优先（Lambda 打包），本地回退 repo 根 config/。
function loadEolTable() {
  for (const p of [join(__dirname, "eol-dates.json"), join(__dirname, "..", "..", "config", "eol-dates.json")]) {
    try { return JSON.parse(readFileSync(p, "utf8")); } catch { /* next */ }
  }
  return {};
}
const EOL = loadEolTable();

// admin 覆盖：从 DDB(tenantcfg#eol) 读取，优先级最高。结构 { service: { versionKey: "YYYY-MM-DD" } }。
async function getEolOverrides() {
  try { return await _getEolOverrides(); } catch { return {}; }
}
// 供 Admin「生命周期」子页展示内置兜底表（与 override 一起编辑）。
export function getEolTable() { return EOL; }

const normDate = (d) => {
  if (!d) return null;
  try { const t = new Date(d); return isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10); } catch { return null; }
};
const daysLeft = (iso) => (iso ? Math.round((new Date(iso + "T00:00:00Z").getTime() - Date.now()) / DAY) : null);
// 解析最终 EOL：admin 覆盖 > API 值 > 内置表
const resolveEol = (svc, key, apiVal, overrides) =>
  (overrides?.[svc]?.[key]) || apiVal || (EOL?.[svc]?.[key]) || null;

async function enabledRegions() {
  try {
    const r = await new EC2Client(_cc(REGION)).send(new DescribeRegionsCommand({}));
    const rs = (r.Regions || []).map((x) => x.RegionName).filter(Boolean);
    return rs.length ? rs : [REGION];
  } catch { return [REGION]; }
}

async function collectRDS(region, overrides, cache) {
  const rds = new RDSClient(_cc(region));
  const out = [];
  const lifecycle = async (engine, version) => {
    const ck = `${engine}:${version}`;
    if (cache.has(ck)) return cache.get(ck);
    let end = null;
    try {
      const r = await rds.send(new DescribeDBEngineVersionsCommand({ Engine: engine, EngineVersion: version }));
      const v = (r.DBEngineVersions || [])[0];
      const lc = v?.SupportedEngineLifecycle || v?.SupportedEngineLifecycles || [];
      const std = lc.find((l) => /standard/i.test(l?.LifecycleSupportName || l?.lifecycleSupportName || "")) || lc[0];
      end = normDate(std?.LifecycleSupportEndDate || std?.lifecycleSupportEndDate);
    } catch { /* degrade */ }
    cache.set(ck, end);
    return end;
  };
  try {
    let marker;
    do {
      const r = await rds.send(new DescribeDBInstancesCommand({ Marker: marker }));
      for (const db of r.DBInstances || []) {
        const api = await lifecycle(db.Engine, db.EngineVersion);
        out.push({ service: "RDS", region, id: db.DBInstanceIdentifier, name: db.DBInstanceIdentifier, engine: db.Engine, version: db.EngineVersion, eolDate: resolveEol("rds", db.EngineVersion, api, overrides), source: api ? "api" : "none" });
      }
      marker = r.Marker;
    } while (marker);
  } catch { /* degrade */ }
  try {
    let marker;
    do {
      const r = await rds.send(new DescribeDBClustersCommand({ Marker: marker }));
      for (const c of r.DBClusters || []) {
        const api = await lifecycle(c.Engine, c.EngineVersion);
        out.push({ service: "Aurora", region, id: c.DBClusterIdentifier, name: c.DBClusterIdentifier, engine: c.Engine, version: c.EngineVersion, eolDate: resolveEol("rds", c.EngineVersion, api, overrides), source: api ? "api" : "none" });
      }
      marker = r.Marker;
    } while (marker);
  } catch { /* degrade */ }
  return out;
}

async function collectEKS(region, overrides) {
  const eks = new EKSClient(_cc(region));
  const out = [];
  const vmap = {};
  try {
    const rv = await eks.send(new DescribeClusterVersionsCommand({}));
    for (const cv of rv.clusterVersions || []) vmap[cv.clusterVersion] = normDate(cv.endOfStandardSupportDate);
  } catch { /* older SDK/region without API → 退表 */ }
  try {
    let token;
    do {
      const r = await eks.send(new ListClustersCommand({ nextToken: token }));
      for (const name of r.clusters || []) {
        try {
          const d = await eks.send(new DescribeClusterCommand({ name }));
          const ver = d.cluster?.version;
          const api = ver ? vmap[ver] : null;
          out.push({ service: "EKS", region, id: name, name, engine: "kubernetes", version: ver, eolDate: resolveEol("eks", ver, api, overrides), source: api ? "api" : (EOL?.eks?.[ver] ? "table" : "none") });
        } catch { /* skip cluster */ }
      }
      token = r.nextToken;
    } while (token);
  } catch { /* degrade */ }
  return out;
}

async function collectLambda(region, overrides) {
  const l = new LambdaClient(_cc(region));
  const out = [];
  try {
    let marker;
    do {
      const r = await l.send(new ListFunctionsCommand({ Marker: marker }));
      for (const fn of r.Functions || []) {
        const rt = fn.Runtime; // 镜像型函数无 Runtime
        if (!rt) continue;
        const eol = resolveEol("lambda", rt, null, overrides);
        out.push({ service: "Lambda", region, id: fn.FunctionName, name: fn.FunctionName, engine: "runtime", version: rt, eolDate: eol, source: eol ? "table" : "none" });
      }
      marker = r.NextMarker;
    } while (marker);
  } catch { /* degrade */ }
  return out;
}

async function collectElastiCache(region, overrides) {
  const ec = new ElastiCacheClient(_cc(region));
  const out = [];
  try {
    let marker;
    do {
      const r = await ec.send(new DescribeCacheClustersCommand({ Marker: marker }));
      for (const c of r.CacheClusters || []) {
        const key = `${c.Engine}:${c.EngineVersion}`;
        const eol = resolveEol("elasticache", key, null, overrides) || resolveEol("elasticache", c.EngineVersion, null, overrides);
        out.push({ service: "ElastiCache", region, id: c.CacheClusterId, name: c.CacheClusterId, engine: c.Engine, version: c.EngineVersion, eolDate: eol, source: eol ? "table" : "none" });
      }
      marker = r.Marker;
    } while (marker);
  } catch { /* degrade */ }
  return out;
}

async function collectOpenSearch(region, overrides) {
  const os = new OpenSearchClient(_cc(region));
  const out = [];
  try {
    const list = await os.send(new ListDomainNamesCommand({}));
    const names = (list.DomainNames || []).map((d) => d.DomainName).filter(Boolean);
    if (names.length) {
      const d = await os.send(new DescribeDomainsCommand({ DomainNames: names }));
      for (const dom of d.DomainStatusList || []) {
        const ver = dom.EngineVersion; // 形如 OpenSearch_2.11 / Elasticsearch_7.10
        const eol = resolveEol("opensearch", ver, null, overrides);
        out.push({ service: "OpenSearch", region, id: dom.DomainName, name: dom.DomainName, engine: "opensearch", version: ver, eolDate: eol, source: eol ? "table" : "none" });
      }
    }
  } catch { /* degrade */ }
  return out;
}

async function collectEMR(region, overrides) {
  const emr = new EMRClient(_cc(region));
  const out = [];
  try {
    let marker;
    do {
      const r = await emr.send(new EmrListClustersCommand({ ClusterStates: ["STARTING", "BOOTSTRAPPING", "RUNNING", "WAITING"], Marker: marker }));
      for (const c of r.Clusters || []) {
        try {
          const d = await emr.send(new EmrDescribeClusterCommand({ ClusterId: c.Id }));
          const rel = d.Cluster?.ReleaseLabel; // emr-6.15.0
          const eol = resolveEol("emr", rel, null, overrides);
          out.push({ service: "EMR", region, id: c.Id, name: c.Name || c.Id, engine: "emr", version: rel, eolDate: eol, source: eol ? "table" : "none" });
        } catch { /* skip */ }
      }
      marker = r.Marker;
    } while (marker);
  } catch { /* degrade */ }
  return out;
}

/**
 * AWS Health "end of standard support / deprecation" 通知（权威, 账号级）。
 * Health 全局端点在 us-east-1；需 Business/Enterprise Support，无权限则优雅降级为空。
 */
async function getHealthEosNotices() {
  try {
    const h = new HealthClient(_cc("us-east-1"));
    const r = await h.send(new DescribeEventsCommand({
      filter: { eventTypeCategories: ["scheduledChange", "accountNotification"] },
      maxResults: 100,
    }));
    const re = /END_OF|END-OF|STANDARD_SUPPORT|DEPRECAT|EXTENDED_SUPPORT/i;
    return (r.events || [])
      .filter((e) => re.test(e.eventTypeCode || ""))
      .map((e) => ({
        service: (e.service || "").toUpperCase(),
        eventTypeCode: e.eventTypeCode,
        region: e.region || "global",
        statusCode: e.statusCode || "",
        startTime: e.startTime ? new Date(e.startTime).getTime() : null,
      }))
      .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  } catch { return []; }
}

/**
 * 汇总 EOS 仪表盘：多 region 扫描 6 类资源，算 7/30/90 天到期 + 受支持比例 + 按服务。
 * ⚠ 这是**实时全区域扫描**（~17 region × 6 服务），耗时较长；对外入口是带缓存的
 * getEosDashboard()，此函数只在缓存未命中 / 强制刷新时调用。
 * @returns {Promise<object>} { available, asOf, regionsScanned, total, counts:{past,in7,in30,in90}, atRisk, supported, supportedPct, byService, upcoming, eolTableAsOf }
 */
async function _computeEosDashboard(accountId) {
  try {
    _creds = await credsFor(accountId); // null = 部署账号
  } catch {
    return { ok: true, accountId: String(accountId || ""), available: false, reason: "cross_account_unavailable" };
  }
  const [overrides, regions, healthNotices] = await Promise.all([getEolOverrides(), enabledRegions(), getHealthEosNotices()]);
  const cache = new Map(); // RDS engine 版本 lifecycle 缓存（跨 region 复用）
  const all = [];
  await Promise.all(regions.map(async (region) => {
    const settled = await Promise.allSettled([
      collectRDS(region, overrides, cache),
      collectEKS(region, overrides),
      collectLambda(region, overrides),
      collectElastiCache(region, overrides),
      collectOpenSearch(region, overrides),
      collectEMR(region, overrides),
    ]);
    for (const s of settled) if (s.status === "fulfilled") all.push(...s.value);
  }));

  const inWin = (lo, hi) => all.filter((r) => { const d = daysLeft(r.eolDate); return d != null && d > lo && d <= hi; }).length;
  const past = all.filter((r) => { const d = daysLeft(r.eolDate); return d != null && d <= 0; }).length;
  const counts = { past, in7: inWin(0, 7), in30: inWin(0, 30), in90: inWin(0, 90) };
  const total = all.length;
  const atRisk = all.filter((r) => { const d = daysLeft(r.eolDate); return d != null && d <= 90; }).length; // 含已过期
  const supported = total - atRisk;
  const supportedPct = total ? Math.round((supported / total) * 1000) / 10 : null;

  const byService = {};
  for (const r of all) {
    const s = (byService[r.service] ||= { total: 0, atRisk: 0 });
    s.total++;
    const d = daysLeft(r.eolDate);
    if (d != null && d <= 90) s.atRisk++;
  }

  const upcoming = all
    .filter((r) => { const d = daysLeft(r.eolDate); return d != null && d <= 90; })
    .map((r) => ({ ...r, daysLeft: daysLeft(r.eolDate) }))
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .slice(0, 100);

  return {
    available: true,
    asOf: new Date().toISOString(),
    regionsScanned: regions.length,
    total,
    counts,
    atRisk,
    supported,
    supportedPct,
    byService,
    upcoming,
    eolTableAsOf: EOL.asOf || null,
    healthNotices,
    healthNoticeCount: healthNotices.length,
  };
}


// ─── ③c 组织级 EOS 汇总：per-account 风险计数（复用 cases Top-N 模式）───
// EOS 全区域扫描较重：每账号结果计数缓存 60 分钟（agg#eos#<id>），rollup 从缓存拼装；
// 未命中的账号串行扫描（受限并发 2）。账号规模化后的终局是 EventBridge 预聚合。
import { DynamoDBClient as _EDdb } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient as _EDoc, GetCommand as _EGet, PutCommand as _EPut, QueryCommand as _EQuery } from "@aws-sdk/lib-dynamodb";
const _eddb = _EDoc.from(new _EDdb({}), { marshallOptions: { removeUndefinedValues: true } });
const _E_AGG = process.env.WEB_CHAT_TABLE || "notiops-web-chat";
const _E_CFG = process.env.CONFIG_TABLE || "notiops-config";
const _E_TTL = 60 * 60 * 1000;

// ─── ① EOS 仪表盘完整结果缓存（60 分钟）───
// 背景：_computeEosDashboard 是全区域实时扫描（~17 region × 6 服务），常 >60s，超浏览器/
// CloudFront 连接超时 → 前端永久 Scanning。EOL 数据天级变化，缓存 1 小时足够。
// 命中缓存直接秒返（附 cached:true + cachedAt）；refresh=true 强制重扫（前端「重试」按钮用）。
// 存整份 payload 于 web-chat 表 eosfull#<id>；扫描失败/available:false 不写缓存（避免把坏结果钉住）。
const _E_FULL_TTL = 60 * 60 * 1000;
export async function getEosDashboard(accountId, { refresh = false } = {}) {
  const key = { PK: `eosfull#${accountId || "self"}`, SK: "meta" };
  if (!refresh) {
    try {
      const hit = await _eddb.send(new _EGet({ TableName: _E_AGG, Key: key }));
      if (hit.Item && hit.Item.data && Date.now() - (hit.Item.at || 0) < _E_FULL_TTL) {
        return { ...hit.Item.data, cached: true, cachedAt: new Date(hit.Item.at).toISOString() };
      }
    } catch { /* 缓存不可用不阻断，落到实时扫描 */ }
  }
  const data = await _computeEosDashboard(accountId);
  // 仅缓存成功扫描结果（available:true）；跨账号不可用 / 异常不写，下次仍可重试。
  if (data && data.available === true) {
    try {
      await _eddb.send(new _EPut({
        TableName: _E_AGG,
        Item: { ...key, at: Date.now(), data, ttl: Math.floor(Date.now() / 1000) + 86400 },
      }));
    } catch { /* 写缓存失败不阻断返回 */ }
  }
  return { ...data, cached: false };
}

async function _eosCountsFor(accountId, name) {
  const key = { PK: `agg#eos#${accountId || "self"}`, SK: "meta" };
  try {
    const hit = await _eddb.send(new _EGet({ TableName: _E_AGG, Key: key }));
    if (hit.Item && Date.now() - (hit.Item.at || 0) < _E_TTL) return { accountId, name, ...hit.Item.data };
  } catch { /* 缓存不可用不阻断 */ }
  const d = await getEosDashboard(accountId);
  const data = d && d.available !== false && d.counts
    ? { available: true, past: d.counts.past || 0, in90: d.counts.in90 || 0, total: d.total || 0 }
    : { available: false, past: 0, in90: 0, total: 0 };
  try { await _eddb.send(new _EPut({ TableName: _E_AGG, Item: { ...key, at: Date.now(), data, ttl: Math.floor(Date.now() / 1000) + 86400 } })); } catch { /* 忽略 */ }
  return { accountId, name, ...data };
}

export async function getEosOrgSummary(visibleSet) {
  const q = await _eddb.send(new _EQuery({
    TableName: _E_CFG, IndexName: "GSI1",
    KeyConditionExpression: "GSI1PK = :pk", ExpressionAttributeValues: { ":pk": "accounts" },
  }));
  const { STSClient, GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const self = (await new STSClient({}).send(new GetCallerIdentityCommand({}))).Account || "";
  const members = (q.Items || [])
    .filter((it) => it.enabled === true && String(it.account_id) !== self)
    .map((it) => ({ accountId: String(it.account_id), name: String(it.account_name || it.name || it.account_id) }));
  // 部署账号行：真实账号号 + 名（config 没有则从 Organizations DescribeAccount 取）
  let selfName = (q.Items || []).find((it) => String(it.account_id) === self)?.account_name || "";
  if (!selfName && self) {
    try {
      const { DescribeAccountCommand } = await import("@aws-sdk/client-organizations");
      const oc = await import("@aws-sdk/client-organizations");
      selfName = (await new oc.OrganizationsClient({}).send(new DescribeAccountCommand({ AccountId: self })))?.Account?.Name || "";
    } catch { /* 取不到用兜底 */ }
  }
  const targets = [{ accountId: "", queryId: "", label: self, name: selfName || "Management account", isDeployment: true }, ...members.map((m) => ({ ...m, queryId: m.accountId, label: m.accountId, isDeployment: false }))]
    .filter((a) => !visibleSet || visibleSet === "*" || a.isDeployment || visibleSet.has(a.accountId));
  // ⚠ 严格串行：_creds 是模块级全局，并发 getEosDashboard 会互相覆盖凭证 → 成员账号
  // 串回部署账号数据（事故根因）。逐个 await 保证每次扫描独占 _creds。
  const rows = [];
  for (const a of targets) {
    const c = await _eosCountsFor(a.queryId, a.name);
    rows.push({ ...c, accountId: a.isDeployment ? self : a.accountId, name: a.name, isDeployment: a.isDeployment });
  }
  rows.sort((a, b) => (b.past - a.past) || (b.in90 - a.in90));
  await fillAccountNames(rows);
  return { generatedAt: new Date().toISOString(), rows };
}
