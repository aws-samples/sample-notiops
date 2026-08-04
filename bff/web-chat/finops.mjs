/**
 * FinOps 仪表盘数据源（chat-app FinOps 主题的仪表盘区块，独立于聊天/LLM）。
 *
 * 三块数据，三种取数方式（见 docs/DEPLOYMENT.md §13）：
 *   1. Budget 预警：AWS Budgets 实时查（budgets:ViewBudget），不落库，与 idle/health
 *      模块同风格——Budgets 本身就是"当前状态"视图，没有落库的必要。
 *   2. CUR/Athena 状态：读 notiops-config 表的 cur-athena-status# 记录
 *      （setup.sh 创建时写 PENDING，lambda6_cur_finalizer 更新为 READY/DELAYED/FAILED）。
 *      前端据此判断是否展示"数据初始化中"占位卡片。
 *   3. DevOps Agent / Bedrock 成本明细：仅在状态=READY 时可查，走 Athena 查 CUR 表
 *      （Cost Explorer 聚合层查不到 product_product_name='AWSDevOpsAgent' 这个维度）。
 *
 * Athena 查询是异步的（start → 轮询 → 取结果），BFF 请求生命周期内做**同步轮询**
 * （Athena 典型查询几秒到十几秒，Lambda15分钟超时够用），不做后台任务队列。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { BudgetsClient, DescribeBudgetsCommand } from "@aws-sdk/client-budgets";
import { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand, ListNamedQueriesCommand, BatchGetNamedQueryCommand } from "@aws-sdk/client-athena";
import { GlueClient, GetDatabasesCommand, GetTablesCommand } from "@aws-sdk/client-glue";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { CostAndUsageReportServiceClient, DescribeReportDefinitionsCommand } from "@aws-sdk/client-cost-and-usage-report-service";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { getEdpCommitmentMock } from "./edp_mock.mjs";
import { getPotentialSavings } from "./potential_savings.mjs";
import { getCostExplorerDashboard, currentPayerAccountId, setAccountScope, listCostAllocationTagKeys, listCostAllocationTagValues, getCostByTag } from "./cost_explorer.mjs";
import { findPayerAccount, getAssumedCredentialsForAccount } from "./devops_agent_accounts.mjs";

const CONFIG_TABLE = process.env.CONFIG_TABLE || "notiops-config";
const ATHENA_RESULTS_BUCKET = process.env.ATHENA_RESULTS_BUCKET || "";
const REGION = process.env.AWS_REGION || "us-east-1";

// SQL 标识符安全校验（防 SQL 注入）：Athena/Glue 的 database/table 名合法字符集是
// [A-Za-z0-9_]，长度 ≤255。这些名字虽来自 Glue 发现结果（curStatus）而非直接用户输入，
// 但仍是**外部来源的标识符会被拼进 Athena SQL 的 FROM 子句**——按纵深防御在拼接前强校验，
// 任何越界字符（引号/分号/空格/点/连字符等）直接拒绝，绝不进入 SQL 文本。
const _IDENT_RE = /^[A-Za-z0-9_]{1,255}$/;
function assertSqlIdentifier(value, label) {
  if (typeof value !== "string" || !_IDENT_RE.test(value)) {
    throw new Error(`Unsafe SQL identifier for ${label}: only [A-Za-z0-9_] (max 255) allowed`);
  }
  return value;
}

// Sensitive-data handling (docs/LOGGING_STANDARD.md): raw AWS/SDK error text
// can embed account IDs, ARNs, table/database names or SQL fragments, and several
// of these results are rendered verbatim in the browser. Never surface the raw
// message. Log error *type* + HTTP status server-side (CloudWatch), and return a
// generic, non-sensitive string the frontend can show as-is.
function _clientErr(e, context) {
  const meta = `${e?.name || "Error"}${e?.$metadata?.httpStatusCode ? "/" + e.$metadata.httpStatusCode : ""}`;
  console.error(`finops:${context} failed (${meta})`);
  return "internal error";
}
// 校验 <database>.<table> 形式的限定名（各段独立校验后再用 "." 连接）。
function safeQualifiedName(db, table) {
  return `${assertSqlIdentifier(db, "database")}.${assertSqlIdentifier(table, "table")}`;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sts = new STSClient({});
// Budgets API 是全局服务但 SDK 端点固定 us-east-1（与 CUR 一致）。
const athena = new AthenaClient({ region: REGION });

// 跨账号查询：Budgets 数据同样大多记在 payer 账号上。不再硬编码角色 ARN——改为
// 动态发现（见 devops_agent_accounts.mjs 头部注释，与 cost_explorer.mjs 同一套
// 发现+缓存策略，两个模块各自独立缓存，因为 Budgets 和 Cost Explorer 是不同的
// AWS 客户端且刷新节奏可能不同）。
let _cachedBudgets = null;
let _cachedBudgetsExpiry = 0;
let _cachedPayerAccountId = "";

async function _getBudgetsClient() {
  const now = Date.now();
  if (_cachedBudgets && now < _cachedBudgetsExpiry) return _cachedBudgets;

  const payer = await findPayerAccount();
  if (!payer) {
    _cachedBudgets = new BudgetsClient({ region: "us-east-1" });
    _cachedBudgetsExpiry = now + 60_000;
    _cachedPayerAccountId = "";
    return _cachedBudgets;
  }

  const creds = await getAssumedCredentialsForAccount(payer.accountId);
  if (!creds) {
    _cachedBudgets = new BudgetsClient({ region: "us-east-1" });
    _cachedBudgetsExpiry = now + 60_000;
    _cachedPayerAccountId = "";
    return _cachedBudgets;
  }

  _cachedPayerAccountId = payer.accountId;
  _cachedBudgets = new BudgetsClient({ region: "us-east-1", credentials: creds });
  _cachedBudgetsExpiry = now + (3600 - 300) * 1000;
  return _cachedBudgets;
}

/** Budgets 查询用的账号 ID：跨账号模式下用发现到的 payer 账号 ID；否则回退到
 * 部署账号自身（原有行为，未发现 payer 关联账号时）。 */
async function _budgetsAccountId() {
  if (!_cachedPayerAccountId) await _getBudgetsClient(); // 触发一次发现/解析
  return _cachedPayerAccountId || _accountId();
}

let _accountIdCache = "";
async function _accountId() {
  if (_accountIdCache) return _accountIdCache;
  const r = await sts.send(new GetCallerIdentityCommand({}));
  _accountIdCache = r.Account || "";
  return _accountIdCache;
}

/* ───────────────── 1. Budget 预警 ───────────────── */

/**
 * 返回账号下全部 Budget 的预算 vs 实际支出 + AWS 侧月末预测。
 * 无 Budget / 无权限 → { available:false }，前端优雅降级（不展示该卡片或提示"未配置预算"）。
 */
export async function getBudgetAlerts() {
  try {
    const accountId = await _budgetsAccountId();
    const r = await (await _getBudgetsClient()).send(new DescribeBudgetsCommand({ AccountId: accountId, MaxResults: 100 }));
    const budgetsList = (r.Budgets || []).map((b) => {
      const limit = Number(b.BudgetLimit?.Amount || 0);
      const actual = Number(b.CalculatedSpend?.ActualSpend?.Amount || 0);
      const forecast = Number(b.CalculatedSpend?.ForecastedSpend?.Amount || 0);
      const pctActual = limit > 0 ? (actual / limit) * 100 : 0;
      const pctForecast = limit > 0 ? (forecast / limit) * 100 : 0;
      return {
        name: b.BudgetName || "",
        unit: b.BudgetLimit?.Unit || "USD",
        limit,
        actualSpend: actual,
        forecastedSpend: forecast,
        pctActual: Math.round(pctActual * 10) / 10,
        pctForecast: Math.round(pctForecast * 10) / 10,
        // 超支预警：AWS 侧预测已经超过预算 → 高风险；实际已超 → 已发生
        status: actual > limit ? "exceeded" : forecast > limit ? "forecast_exceed" : "on_track",
        timeUnit: b.TimeUnit || "MONTHLY",
      };
    });
    return { available: true, budgets: budgetsList };
  } catch (e) {
    return { available: false, reason: "error", message: _clientErr(e, "budgets"), budgets: [] };
  }
}

/* ───────────────── 2. CUR/Athena 状态 ───────────────── */

// payer 侧 CUR 发现结果的短缓存（避免每次仪表盘刷新都重新扫全部 Glue database）。
let _cachedPayerCurStatus = null;
let _cachedPayerCurStatusExpiry = 0;
const _PAYER_CUR_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 在 payer 账号里动态发现 CUR 对应的 Glue database/table（与
 * scripts/setup_payer_cur.sh 的发现逻辑一致：扫全部 database，找列里有
 * line_item_unblended_cost 且 S3 location 匹配已知 CUR 桶前缀的表）。
 * payer 账号侧的状态**不经过 DDB**——payer 账号通常没有部署 NotiOps 基础设施，
 * 没有反向写回成员账号 DDB 的机制，所以每次 BFF 请求时直接现查 Glue（有缓存）。
 */
async function _discoverPayerCur(payerAccountId, creds) {
  const now = Date.now();
  if (_cachedPayerCurStatus && now < _cachedPayerCurStatusExpiry) return _cachedPayerCurStatus;

  const glue = new GlueClient({ region: "us-east-1", credentials: creds });
  const cur = new CostAndUsageReportServiceClient({ region: "us-east-1", credentials: creds });

  let result = { status: "not_configured" };
  try {
    const reportsResp = await cur.send(new DescribeReportDefinitionsCommand({ MaxResults: 100 }));
    const reports = (reportsResp.ReportDefinitions || []).filter(
      (r) => r.TimeUnit === "HOURLY" && (r.AdditionalSchemaElements || []).includes("RESOURCES"),
    );
    if (reports.length === 0) {
      result = { status: "not_configured" };
    } else {
      const report = reports[0];
      // 扫全部 Glue database，找列里有 line_item_unblended_cost 且 S3 location
      // 匹配这份 CUR 的桶——与 scripts/setup_payer_cur.sh 的发现逻辑保持一致。
      const allDbs = await glue.send(new GetDatabasesCommand({}));
      let foundDb = "", foundTable = "", partitioned = false;
      outer:
      for (const dbEntry of allDbs.DatabaseList || []) {
        const tablesResp = await glue.send(new GetTablesCommand({ DatabaseName: dbEntry.Name })).catch(() => null);
        for (const tbl of tablesResp?.TableList || []) {
          const cols = tbl.StorageDescriptor?.Columns || [];
          if (!cols.some((c) => c.Name === "line_item_unblended_cost")) continue;
          const location = tbl.StorageDescriptor?.Location || "";
          if (location.includes(report.S3Bucket)) {
            foundDb = dbEntry.Name;
            foundTable = tbl.Name;
            partitioned = (tbl.PartitionKeys || []).some((p) => p.Name === "year");
            break outer;
          }
        }
      }
      if (foundDb) {
        result = {
          status: "READY",
          bucket: report.S3Bucket,
          reportName: report.ReportName,
          athenaDatabase: foundDb,
          athenaTable: foundTable,
          yearMonthPartitioned: partitioned,
          sourceAccountId: payerAccountId,
        };
      } else {
        result = {
          status: "DELAYED",
          bucket: report.S3Bucket,
          reportName: report.ReportName,
          note: "CUR 报告存在但 Glue Catalog 里未找到对应表，Athena 集成可能还没建（首次交付最长 24h，或需运行 scripts/setup_payer_cur.sh --finalize）",
          sourceAccountId: payerAccountId,
        };
      }
    }
  } catch (e) {
    result = { status: "error", message: _clientErr(e, "payer-cur-discover"), sourceAccountId: payerAccountId };
  }

  _cachedPayerCurStatus = result;
  _cachedPayerCurStatusExpiry = now + _PAYER_CUR_CACHE_TTL_MS;
  return result;
}

/**
 * CUR/Athena 集成状态：优先动态发现 payer 账号（见 devops_agent_accounts.mjs）
 * 的 CUR（因为 DevOps Agent 调用成本明细大多要在 payer 的 CUR 里才查得到，见
 * scripts/setup_payer_cur.sh）；没有 payer 关联账号，或 payer 侧没配 CUR，
 * 才退回部署账号自己的 DDB 记录（lambda6_cur_finalizer 走的路径）。
 */
export async function getCurAthenaStatus() {
  const payer = await findPayerAccount().catch(() => null);
  if (payer?.accountId) {
    const creds = await getAssumedCredentialsForAccount(payer.accountId);
    if (creds) {
      const payerStatus = await _discoverPayerCur(payer.accountId, creds);
      if (payerStatus.status !== "not_configured") return payerStatus;
      // payer 账号本身没配 CUR，继续往下退回部署账号记录。
    }
  }

  try {
    const accountId = await _accountId();
    const r = await ddb.send(new GetCommand({
      TableName: CONFIG_TABLE,
      Key: { PK: `cur-athena-status#${accountId}`, SK: "STATUS" },
    }));
    const item = r.Item;
    if (!item) return { status: "not_configured" };
    return {
      status: item.status || "unknown",
      bucket: item.bucket || "",
      reportName: item.report_name || "",
      athenaDatabase: item.athena_database || "",
      athenaTable: item.athena_table || "",
      yearMonthPartitioned: item.year_month_partitioned === true,
      createdAt: item.created_at || "",
      updatedAt: item.updated_at || "",
      error: item.error || "",
      note: item.note || "",
      sourceAccountId: accountId,
    };
  } catch (e) {
    return { status: "error", message: _clientErr(e, "cur-status") };
  }
}

/* ───────────────── 3. Athena 查询（仅 status=READY 时可用）───────────────── */

const _WAIT_MS = 1500;
const _MAX_POLLS = 120; // 120 * 1.5s = 180s 上限，容纳 Athena 冷查询（BFF Lambda timeout 需 > 此值）

async function _pollQuery(queryExecutionId) {
  for (let i = 0; i < _MAX_POLLS; i++) {
    const r = await athena.send(new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }));
    const state = r.QueryExecution?.Status?.State;
    if (state === "SUCCEEDED") return { ok: true };
    if (state === "FAILED" || state === "CANCELLED") {
      return { ok: false, reason: r.QueryExecution?.Status?.StateChangeReason || state };
    }
    await new Promise((res) => setTimeout(res, _WAIT_MS));
  }
  return { ok: false, reason: "timeout" };
}

function _rowsToObjects(resultSet) {
  const cols = (resultSet?.ResultSetMetadata?.ColumnInfo || []).map((c) => c.Name);
  const rows = resultSet?.Rows || [];
  // Athena 第一行是表头（列名），与 ColumnInfo 重复，跳过。
  return rows.slice(1).map((row) => {
    const obj = {};
    (row.Data || []).forEach((cell, idx) => { obj[cols[idx]] = cell.VarCharValue ?? null; });
    return obj;
  });
}

/**
 * 执行一条只读 Athena SQL 并返回结果行（对象数组）。调用方必须保证 sql 已经过
 * 白名单校验（见 devOpsAgentCostSummary），本函数本身不做 SQL 注入防护——
 * 只暴露给内部固定查询模板，不接受任意用户输入拼接的 SQL。
 */
async function _runQuery(sql, database) {
  if (!ATHENA_RESULTS_BUCKET) throw new Error("ATHENA_RESULTS_BUCKET not configured");
  const start = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    QueryExecutionContext: database ? { Database: database } : undefined,
    ResultConfiguration: { OutputLocation: `s3://${ATHENA_RESULTS_BUCKET}/athena-results/` },
    WorkGroup: "primary",
  }));
  const queryExecutionId = start.QueryExecutionId;
  const waited = await _pollQuery(queryExecutionId);
  if (!waited.ok) throw new Error(`Athena query ${waited.reason}`);
  const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId, MaxResults: 1000 }));
  return _rowsToObjects(results.ResultSet);
}

/**
 * DevOps Agent 调用成本明细（当月 + 上月对比，按账号拆分）。
 *
 * 两种 CUR/Athena 表结构都要支持（现实中遇到过两种，不能只认一种）：
 *   A) 按月分表：customer_cur_data.<report>_<YYYYMM>（AWS 官方 CFN 集成的
 *      标准命名，lambda6_cur_finalizer 走这条路径部署时用这种）
 *   B) 单表 + year/month 分区：<database>.<table> WHERE year='YYYY' AND month='MM'
 *      （手动建过 Athena 集成的 CUR 常见这种，见 scripts/setup_payer_cur.sh
 *      的发现逻辑——它会在 curStatus 里写 athenaTable + yearMonthPartitioned）
 *
 * curStatus.athenaTable 存在 → 走 B；否则回退到 A（猜表名，向后兼容
 * lambda6_cur_finalizer 目前的写法，它还没升级成显式写表名）。
 *
 * 仅在 curStatus.status === "READY" 时调用；调用方需先查 getCurAthenaStatus()。
 */
export async function devOpsAgentCostSummary(curStatus) {
  if (!curStatus?.athenaDatabase) {
    return { available: false, reason: "cur_not_ready" };
  }
  const db = curStatus.athenaDatabase;
  const now = new Date();
  const thisYear = String(now.getUTCFullYear());
  const thisMonthNum = String(now.getUTCMonth() + 1).padStart(2, "0");
  const thisMonth = `${thisYear}${thisMonthNum}`;
  // 上月（credit 额度 = 档位% × 上月 Support 费用）。UTC 月初回退一个月。
  const lastDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastYear = String(lastDate.getUTCFullYear());
  const lastMonthNum = String(lastDate.getUTCMonth() + 1).padStart(2, "0");
  const lastMonth = `${lastYear}${lastMonthNum}`;

  // 两种表结构各自解析出：额度取数(上月表/分区) + 用量取数(本月表/分区) + 各自 WHERE 月份过滤。
  let capFrom, usageFrom, capWhere, usageWhere;
  if (curStatus.athenaTable) {
    // 结构 B：单表 + year/month 分区（无分区则全表扫，WHERE 只留业务条件）。
    // db/table 名在拼进 SQL 前强校验（防注入，见 safeQualifiedName）。
    const table = safeQualifiedName(db, curStatus.athenaTable);
    capFrom = table;
    usageFrom = table;
    // AWS Glue CUR crawler 的分区值是单位数月（month=6/7，非 06/07）；用 CAST 消除
    // 前导零假设，兼容任意 crawler 命名（避免"month='07' 查不到当月"的坑）。
    capWhere = curStatus.yearMonthPartitioned ? `CAST(year AS integer) = ${Number(lastYear)} AND CAST(month AS integer) = ${Number(lastMonthNum)} AND ` : "";
    usageWhere = curStatus.yearMonthPartitioned ? `CAST(year AS integer) = ${Number(thisYear)} AND CAST(month AS integer) = ${Number(thisMonthNum)} AND ` : "";
  } else {
    // 结构 A：按月分表（<db>_<YYYYMM>）。额度查上月表,用量查本月表。
    // db 名强校验;lastMonth/thisMonth 是本地生成的纯数字串（YYYYMM），非外部输入。
    assertSqlIdentifier(db, "database");
    capFrom = `${db}_${lastMonth}`;
    usageFrom = `${db}_${thisMonth}`;
    capWhere = "";
    usageWhere = "";
  }

  // 一条 SQL 同时算「额度(cap)」和「用量(usage)」：
  //  - credit_cap：上月 Support 费用 × 档位百分比（按 line_item_product_code 判档，通用适配任何账号）：
  //      Enterprise / Enterprise On-Ramp（AWSSupportEnterprise*）→ 75%；Business（AWSSupportBusiness*）→ 30%；
  //      其它（Developer/Basic/无付费计划）→ 0。Unified Operations 100% 暂不支持（CUR 里判不出，后续用 config 覆盖）。
  //  - usage：本月 DevOps Agent 用量（0.0083 美元/秒 官方单价 × 3600 → 每小时；官方调价需同步改这里）。
  //  - row_type 区分两类行；cap 单独一行 → 即使本月零用量，额度也一定返回。固定模板，不拼接用户输入。
  const sql = `
    WITH credit_cap AS (
      SELECT SUM(CASE
          WHEN (line_item_product_code LIKE '%Support%' OR product_product_name LIKE '%Support%') AND (line_item_product_code LIKE '%Enterprise%' OR product_product_name LIKE '%Enterprise%') THEN line_item_unblended_cost * 0.75
          WHEN (line_item_product_code LIKE '%Support%' OR product_product_name LIKE '%Support%') AND (line_item_product_code LIKE '%Business%' OR product_product_name LIKE '%Business%')   THEN line_item_unblended_cost * 0.30
          ELSE 0 END) AS monthly_credit_usd
      FROM ${capFrom}
      WHERE ${capWhere}line_item_line_item_type = 'Usage'
    ),
    usage AS (
      SELECT
        line_item_usage_account_id AS account_id,
        SUM(line_item_usage_amount) AS total_hours,
        SUM(line_item_usage_amount) * 3600 * 0.0083 AS implied_cost_usd
      FROM ${usageFrom}
      WHERE ${usageWhere}product_product_name = 'AWSDevOpsAgent' AND line_item_line_item_type = 'Usage'
      GROUP BY 1
    )
    SELECT 'usage' AS row_type, account_id, total_hours, implied_cost_usd, CAST(NULL AS double) AS monthly_credit_usd FROM usage
    UNION ALL
    SELECT 'cap' AS row_type, CAST(NULL AS varchar) AS account_id, CAST(NULL AS double) AS total_hours, CAST(NULL AS double) AS implied_cost_usd, monthly_credit_usd FROM credit_cap
  `.trim();

  const round2 = (n) => Math.round(n * 100) / 100;
  try {
    const rows = await _runQuery(sql, db);
    const usageRows = rows.filter((r) => r.row_type === "usage" && r.account_id);
    const capRow = rows.find((r) => r.row_type === "cap");
    const allowanceUsd = Number(capRow?.monthly_credit_usd || 0);
    const totalHours = usageRows.reduce((s, r) => s + Number(r.total_hours || 0), 0);
    const usedUsd = usageRows.reduce((s, r) => s + Number(r.implied_cost_usd || 0), 0);
    const remainingUsd = allowanceUsd - usedUsd;
    return {
      available: true,
      month: thisMonth,
      priorMonth: lastMonth,
      byAccount: usageRows.map((r) => ({
        accountId: r.account_id,
        totalHours: Number(r.total_hours || 0),
        impliedCostUsd: round2(Number(r.implied_cost_usd || 0)),
      })),
      totalHours,
      // credit：额度 / 已用 / 剩余（月底过期）。allowanceUsd=0 表示上月无付费 Support 计划。
      allowanceUsd: round2(allowanceUsd),
      usedUsd: round2(usedUsd),
      remainingUsd: round2(remainingUsd),
      usedPct: allowanceUsd > 0 ? Math.round((usedUsd / allowanceUsd) * 1000) / 10 : null,
      totalCostUsd: round2(usedUsd), // 向后兼容旧前端字段（= 已用）
    };
  } catch (e) {
    // 表可能还不存在（月初、本月/上月表尚未生成）——按"暂无数据"处理，前端显示 $0 而非报错。
    // （结构A 月初本月表未建时会走这里，额度也一并为 0，待表就绪后自动恢复；结构B 分区单表通常不缺表。）
    // raw msg 仅用于本地分支判定，绝不回传前端（可能含库/表名/SQL）——见 docs/LOGGING_STANDARD.md。
    const msg = String(e?.message || e);
    if (/does not exist|NoSuchObjectException|TABLE_NOT_FOUND/i.test(msg)) {
      return { available: true, month: thisMonth, priorMonth: lastMonth, byAccount: [], totalHours: 0, allowanceUsd: 0, usedUsd: 0, remainingUsd: 0, usedPct: null, totalCostUsd: 0, note: "本月暂无数据" };
    }
    return { available: false, reason: "query_failed", message: _clientErr(e, "devops-agent-cost") };
  }
}

/**
 * 汇总入口：一次调用拿齐 FinOps 仪表盘全部数据块。CUR 未就绪时 devOpsAgentCost 直接
 * 跳过查询（避免打一个注定失败的 Athena 查询，浪费扫描费用）。
 *
 * 新增（cost_executive_summary_dashboard_template.html 布局对齐）：
 *   - costExplorer: Spend Overview（6月趋势）+ Marketplace + Support + MoM Movers
 *     （固定查询模板，见 cost_explorer.mjs，与 LLM 无关，口径每次一致）
 *   - edpCommitment: EDP 承诺达成率 —— demo mock 数据（见 edp_mock.mjs 头部注释，
 *     计算口径复刻自 TAM 团队现有 EDP 追踪脚本，真实客户接入时换数据源不换公式）
 */
/* ───────────────── Cost Deep Dive（option 2：BFF 跑 Athena Named Query → grounded rows → Bedrock 出 insight/chart）───────────────── */
// 场景 → Athena 保存查询名（SQL 单一真源在 Athena，可在控制台改）
const DEEP_DIVE_NQ = {
  cloudwatch: "NotiOps - Deep Dive - CloudWatch cost by usage type",
  datatransfer: "NotiOps - Deep Dive - Data Transfer by service",
  ec2: "NotiOps - Deep Dive - EC2 cost by instance type",
  s3: "NotiOps - Deep Dive - S3 cost by storage class",
};

async function _runQueryFull(sql, database) {
  if (!ATHENA_RESULTS_BUCKET) throw new Error("ATHENA_RESULTS_BUCKET not configured");
  const start = await athena.send(new StartQueryExecutionCommand({
    QueryString: sql,
    QueryExecutionContext: database ? { Database: database } : undefined,
    ResultConfiguration: { OutputLocation: `s3://${ATHENA_RESULTS_BUCKET}/athena-results/` },
    WorkGroup: "primary",
  }));
  const queryExecutionId = start.QueryExecutionId;
  const waited = await _pollQuery(queryExecutionId);
  if (!waited.ok) throw new Error(`Athena query ${waited.reason}`);
  const results = await athena.send(new GetQueryResultsCommand({ QueryExecutionId: queryExecutionId, MaxResults: 1000 }));
  return { rows: _rowsToObjects(results.ResultSet), queryExecutionId };
}

// 仅对【已 grounded 的 Athena 行】做归纳/选图；数值不经模型手 → 不幻觉。
async function _deepDiveInsight(scenario, rows, period) {
  try {
    const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
    const prompt = `You are a FinOps analyst. The JSON below is the exact result of a Cost & Usage Report (CUR) Athena query for scenario "${scenario}", covering ${period || "the current calendar month to date"}. Using ONLY these rows — never invent numbers — return STRICT JSON:
{"insight":"<2-3 sentences on the biggest cost drivers, cite the real numbers, and state the time window (${period || "month to date"})>","recommendations":["<specific, actionable cost-optimization action tied to the data — e.g. reduce/consolidate/rightsize/change tier, name the driver and roughly how much it could save>","<2 to 4 items total, most impactful first>"],"chart":{"type":"bar"|"pie","labelKey":"<grouping column name from the rows>","valueKey":"<numeric cost column name, e.g. cost_usd>","title":"<short title>"}}
Rows (top 40): ${JSON.stringify(rows.slice(0, 40))}
Return ONLY the JSON object, no markdown, no prose.`;
    const resp = await bedrock.send(new ConverseCommand({
      modelId: "us.anthropic.claude-sonnet-5",
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 1000, temperature: 0 },
    }));
    const txt = resp.output?.message?.content?.[0]?.text || "";
    const parsed = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    return {
      insight: String(parsed.insight || ""),
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String).slice(0, 5) : [],
      chart: parsed.chart || null,
    };
  } catch (e) {
    return { insight: "", recommendations: [], chart: null, aiError: _clientErr(e, "deep-dive-insight") };
  }
}

// CSV 下载链接 presign 便宜/即时,不缓存 URL 本身(1h 过期)——按 queryExecutionId 需要时重签
async function _presignCsv(queryExecutionId) {
  if (!queryExecutionId) return "";
  try {
    const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
    return await getSignedUrl(s3, new GetObjectCommand({ Bucket: ATHENA_RESULTS_BUCKET, Key: `athena-results/${queryExecutionId}.csv` }), { expiresIn: 3600 });
  } catch { return ""; }
}

export async function getDeepDive(scenario) {
  const nqName = DEEP_DIVE_NQ[scenario];
  if (!nqName) return { available: false, reason: "unknown_scenario" };
  const period = "current calendar month to date (MTD)";
  const periodLabel = { zh: "本月至今 (MTD)", en: "Month-to-date (MTD)" };
  try {
    const accountId = await _accountId();
    const day = new Date().toISOString().slice(0, 10); // UTC 日期:同一天命中缓存
    const cacheKey = { PK: `deep-dive-cache#${accountId}#${scenario}`, SK: day };
    // 1) 命中当天缓存 → 只重签 CSV URL(不跑 SQL、不调 AI,省钱)
    try {
      const cached = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: cacheKey }));
      if (cached.Item && cached.Item.payload) {
        return { ...cached.Item.payload, csvUrl: await _presignCsv(cached.Item.queryExecutionId), cached: true, cachedAt: cached.Item.created_at || "" };
      }
    } catch { /* 缓存读失败 → 照常跑 */ }
    // 2) 未命中 → 跑 Named Query + AI
    const listed = await athena.send(new ListNamedQueriesCommand({ WorkGroup: "primary", MaxResults: 50 }));
    const ids = listed.NamedQueryIds || [];
    if (ids.length === 0) return { available: false, reason: "no_named_queries" };
    const batch = await athena.send(new BatchGetNamedQueryCommand({ NamedQueryIds: ids }));
    const nq = (batch.NamedQueries || []).find((q) => q.Name === nqName);
    if (!nq) return { available: false, reason: "named_query_not_found", message: nqName };
    const { rows, queryExecutionId } = await _runQueryFull(nq.QueryString, nq.Database);
    const ai = await _deepDiveInsight(scenario, rows, period);
    const fallbackLabel = ({ cloudwatch: "usage_type", datatransfer: "service", ec2: "instance_type", s3: "usage_type" })[scenario] || "usage_type";
    const chart = ai.chart || { type: "bar", labelKey: fallbackLabel, valueKey: "cost_usd", title: nqName };
    const payload = { available: true, scenario, title: nqName, period, periodLabel, rowCount: rows.length, rows: rows.slice(0, 60), insight: ai.insight, recommendations: ai.recommendations || [], chart };
    // 3) 写当天缓存(TTL 2 天);失败不致命
    try {
      await ddb.send(new PutCommand({ TableName: CONFIG_TABLE, Item: { ...cacheKey, payload, queryExecutionId, created_at: new Date().toISOString(), ttl: Math.floor(Date.now() / 1000) + 172800 } }));
    } catch { /* ignore */ }
    return { ...payload, csvUrl: await _presignCsv(queryExecutionId), cached: false };
  } catch (e) {
    return { available: false, reason: "error", message: _clientErr(e, "deep-dive") };
  }
}

/* ───────────────── 成本分配标签浏览器（封装层）─────────────────
 * 底层查询在 cost_explorer.mjs（getCostByTag 等，口径 UnblendedCost）。这里负责：
 *   ① 设置账号 scope（多账号：payer 视角/选中成员账号 LINKED_ACCOUNT 过滤，与仪表盘一致）；
 *   ② 标签成本按服务分组后，给一段可选的 AI 洞察（只归纳已 grounded 的行，不碰数字）；
 *   ③ 当天缓存（同 deep-dive，省重复扫描）。
 */

// 仅对【已 grounded 的按服务分组行】做归纳；数值不经模型手 → 不幻觉。失败不致命。
async function _tagCostInsight(tagKey, tagValue, rows, totalUsd, period) {
  try {
    if (!rows || rows.length === 0) return { insight: "", recommendations: [] };
    const bedrock = new BedrockRuntimeClient({ region: process.env.AWS_REGION || "us-east-1" });
    const scope = tagValue == null
      ? `all values of cost-allocation tag "${tagKey}"`
      : (tagValue === "" ? `resources with NO value for tag "${tagKey}" (untagged)` : `tag ${tagKey}=${tagValue}`);
    const prompt = `You are a FinOps analyst. The JSON below is the exact Cost Explorer result (UnblendedCost) for ${scope}, grouped by AWS service, covering ${period || "the current calendar month to date"}. Total = $${totalUsd}. Using ONLY these rows — never invent numbers — return STRICT JSON:
{"insight":"<2-3 sentences on which services dominate this tag's cost, cite the real numbers and the time window>","recommendations":["<specific, actionable cost-optimization action tied to the data>","<1 to 3 items total, most impactful first>"]}
Rows (top 40): ${JSON.stringify(rows.slice(0, 40))}
Return ONLY the JSON object, no markdown, no prose.`;
    const resp = await bedrock.send(new ConverseCommand({
      modelId: "us.anthropic.claude-sonnet-5",
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 700, temperature: 0 },
    }));
    const txt = resp.output?.message?.content?.[0]?.text || "";
    const parsed = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    return {
      insight: String(parsed.insight || ""),
      recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String).slice(0, 4) : [],
    };
  } catch (e) {
    return { insight: "", recommendations: [], aiError: _clientErr(e, "tag-cost-insight") };
  }
}

/** 列出已激活的成本分配标签键（+ 当前生效账号，供前端标注口径）。 */
export async function getTagKeys(accountId) {
  setAccountScope(accountId || "");
  try {
    const { tagKeys } = await listCostAllocationTagKeys();
    const costDataSourceAccountId = currentPayerAccountId() || (await _accountId());
    return { available: true, tagKeys, accountScope: String(accountId || ""), costDataSourceAccountId };
  } catch (e) {
    return { available: false, reason: "error", message: _clientErr(e, "tag-keys"), tagKeys: [] };
  }
}

/** 列出某标签键的可选值（前端二级下拉）。 */
export async function getTagValues(accountId, tagKey) {
  setAccountScope(accountId || "");
  try {
    const r = await listCostAllocationTagValues(tagKey);
    return { available: true, ...r };
  } catch (e) {
    return { available: false, reason: "error", message: _clientErr(e, "tag-values"), tagKey: String(tagKey || ""), tagValues: [] };
  }
}

/** 按标签查成本（按服务分组）+ 可选 AI 洞察，当天缓存。 */
export async function getTagCost(accountId, tagKey, tagValue) {
  const key = String(tagKey || "").trim();
  if (!key) return { available: false, reason: "missing_tag_key" };
  setAccountScope(accountId || "");
  const valNorm = tagValue == null ? "__ALL__" : (tagValue === "" ? "__UNTAGGED__" : String(tagValue));
  try {
    const acct = currentPayerAccountId() || (await _accountId());
    const day = new Date().toISOString().slice(0, 10);
    const cacheKey = { PK: `tag-cost-cache#${acct}#${String(accountId || "")}#${key}#${valNorm}`, SK: day };
    // 1) 命中当天缓存
    try {
      const cached = await ddb.send(new GetCommand({ TableName: CONFIG_TABLE, Key: cacheKey }));
      if (cached.Item && cached.Item.payload) return { ...cached.Item.payload, cached: true, cachedAt: cached.Item.created_at || "" };
    } catch { /* 读缓存失败 → 照常查 */ }
    // 2) 未命中 → 查 CE + AI
    const base = await getCostByTag(key, tagValue);
    if (!base.available) return base;
    const ai = await _tagCostInsight(key, base.tagValue, base.rows, base.totalUsd, base.period);
    const payload = { ...base, insight: ai.insight, recommendations: ai.recommendations || [], costDataSourceAccountId: acct, accountScope: String(accountId || "") };
    // 3) 写当天缓存（TTL 2 天）；失败不致命
    try {
      await ddb.send(new PutCommand({ TableName: CONFIG_TABLE, Item: { ...cacheKey, payload, created_at: new Date().toISOString(), ttl: Math.floor(Date.now() / 1000) + 172800 } }));
    } catch { /* ignore */ }
    return { ...payload, cached: false };
  } catch (e) {
    return { available: false, reason: "error", message: _clientErr(e, "tag-cost") };
  }
}

export async function getFinopsDashboard(accountId) {
  // 多账号：payer 视角天然含全组织；选中成员账号 → CE 查询按 LINKED_ACCOUNT 过滤。
  // budgets / COH savings / DevOps Agent credit / EDP 承诺 等板块无该过滤维度，保持组织级，
  // orgOnlySections 告知前端如实标注口径。
  setAccountScope(accountId || "");
  const [budgetAlerts, curStatus, costExplorer, potentialSavings] = await Promise.all([
    getBudgetAlerts(), getCurAthenaStatus(), getCostExplorerDashboard(), getPotentialSavings(),
  ]);
  let devOpsAgentCost = { available: false, reason: "cur_not_ready" };
  if (curStatus.status === "READY") {
    devOpsAgentCost = await devOpsAgentCostSummary(curStatus);
  }
  const edpCommitment = getEdpCommitmentMock();
  // 透明度：告诉前端这些数字实际来自哪个账号（动态发现的 payer，还是回退到部署
  // 账号自身视角）——避免用户看到数字却不知道口径，见之前"<deployment-account> 的成本
  // 为什么没出现"的排查过程。
  const costDataSourceAccountId = currentPayerAccountId() || (await _accountId());
  return {
    budgetAlerts, curStatus, devOpsAgentCost, costExplorer, edpCommitment, potentialSavings, costDataSourceAccountId,
    accountScope: String(accountId || ""),
    orgOnlySections: ["budgetAlerts", "potentialSavings", "devOpsAgentCost", "edpCommitment", "anomalies", "coverage"],
  };
}
