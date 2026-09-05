/**
 * 每日成本异常扫描（lambda5 产数）—— FinOps 看板的读侧。
 *
 * ## 与 `costExplorer.anomalies` 是**两套引擎**，不合并
 *
 * ```
 * costExplorer.anomalies   AWS Cost Anomaly Detection 服务（要配 monitor，
 *                          没配就 available:false）
 * 这里（dailyAnomaly）      lambda5 每天 01:15 UTC 的多因子评分（自建基线，
 *                          不依赖 CE monitor；老控制台退役后这是它唯一的读侧）
 * ```
 *
 * 合并的代价是两套口径的数字被加在一起 —— 客户自己对不上任何一边的控制台。
 * 界面上两张卡并排、各自标注来源。
 *
 * ## 数据布局（config 表，写侧 `shared/queries/cost_anomaly.py`）
 *
 * ```
 * Summary: PK=anomalysum#<account>  SK=<date>   GSI1PK=anomalysum#<date>
 * Result:  PK=anomaly#<account>#<date> SK=<svc> GSI1PK=anomaly#<date>
 *                                                GSI1SK=<score zpad12>
 * ```
 *
 * 🔴 键形状与 Python 写侧**逐字对齐**，由 bff 测试的源码断言 + pytest 侧
 *    `test_cost_anomaly_*` 双向钉住 —— 两侧漂移的表现是这页永远「无数据」，
 *    而 lambda5 明明每天在写（与「算好了没人取」同族，只是隔了一种语言）。
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

const CONFIG_TABLE = process.env.CONFIG_TABLE || "notiops-config";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const num = (v) => (v === null || v === undefined ? null : Number(v));

/** 今天的 UTC 日期（lambda5 以 UTC 日期为键；01:15 UTC 写当天）。 */
function utcToday() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date(Date.now() - n * 86400_000);
  return d.toISOString().slice(0, 10);
}

async function queryGsi1(pk, { descending = true } = {}) {
  const out = [];
  let lastKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: CONFIG_TABLE,
      IndexName: "GSI1",
      KeyConditionExpression: "GSI1PK = :pk",
      ExpressionAttributeValues: { ":pk": pk },
      ScanIndexForward: !descending,
      ExclusiveStartKey: lastKey,
    }));
    out.push(...(r.Items || []));
    lastKey = r.LastEvaluatedKey;
  } while (lastKey);
  return out;
}

/**
 * 每日异常扫描的看板数据。
 *
 * @param accountId 选中的账号；空串 = 跨账号（org 视图）
 * @param visible   `"*"` 或 `Set<accountId>`；**跨账号时不给就拒** ——
 *                  与 `inspection.mjs::getOverview` 同一道硬门。行上带
 *                  account_id，org 视图把所有账号的异常摊开，不过滤就是
 *                  把别人账号的成本异常端给受限用户。
 *
 * 🔴 三态：`{available:false, reason:"..."}` = 读失败/没跑过（**不是**
 *    「无异常」）；`{available:true, totalAnomalies:0}` = 跑了且干净。
 */
export async function getDailyAnomalies(accountId, { visible = null } = {}) {
  const acct = String(accountId || "").trim();
  if (!acct && (visible === null || visible === undefined)) {
    return { available: false, reason: "visibility_required" };
  }
  try {
    // lambda5 每天 01:15 UTC 跑 —— 00:00~01:15 之间「今天」还没有行，
    // 回退到最近 3 天里最新的那天。再往前说明 lambda5 停了，如实报
    // 「没跑」而不是端着一周前的数字装新鲜。
    let date = "";
    let summaries = [];
    for (let i = 0; i < 3; i++) {
      const d = i === 0 ? utcToday() : daysAgo(i);
      const rows = await queryGsi1(`anomalysum#${d}`);
      if (rows.length) { date = d; summaries = rows; break; }
    }
    if (!date) {
      return { available: false, reason: "no_recent_run" };
    }

    const inScope = (row) => {
      const a = String(row.account_id || "");
      if (acct) return a === acct;
      return visible === "*" || (visible && visible.has && visible.has(a));
    };
    summaries = summaries
      .filter((s) => String(s.status || "") !== "error")
      .filter(inScope)
      .map((s) => ({
        accountId: String(s.account_id || ""),
        totalAnomalies: num(s.total_anomalies_detected) ?? 0,
        projected7dExtraUsd: num(s.total_projected_7d_extra_cost) ?? 0,
        totalDailyAvg: num(s.total_daily_avg),
        recent3dDailyAvg: num(s.recent_3d_daily_avg),
      }));

    // 明细只取高分段（与每日通知同口径：score >= 60）
    const details = (await queryGsi1(`anomaly#${date}`))
      .filter((r) => (num(r.anomaly_score) ?? 0) >= 60)
      .filter(inScope)
      .map((r) => ({
        accountId: String(r.account_id || ""),
        service: String(r.service_name || ""),
        score: num(r.anomaly_score) ?? 0,
        confidence: String(r.confidence_level || ""),
        type: String(r.anomaly_type || ""),
        baselineDailyUsd: num(r.baseline_daily_avg),
        recent3dDailyUsd: num(r.recent_3d_avg),
        projected7dExtraUsd: num(r.projected_7d_extra_cost) ?? 0,
        trend: String(r.trend_symbols || ""),
      }))
      .sort((a, b) => b.score - a.score);

    return {
      available: true,
      date,
      totalAnomalies: summaries.reduce((s, x) => s + x.totalAnomalies, 0),
      projected7dExtraUsd: Math.round(summaries.reduce(
        (s, x) => s + x.projected7dExtraUsd, 0) * 100) / 100,
      accounts: summaries.length,
      details: details.slice(0, 20),
    };
  } catch (e) {
    console.error(`[BFF] daily anomaly query failed — ${e?.name || ""}: ${e?.message || e}`);
    return { available: false, reason: "query_failed" };
  }
}
