"""
NotiOps Athena FinOps 保存查询（Named Queries）—— 单一事实来源（single source of truth）。

这 6 条保存查询是 FinOps 仪表盘的后端：
  · Cost Deep Dive 的 4 个场景（CloudWatch / Data Transfer / EC2 / S3）直接读同名 Named Query
    （见 bff/web-chat/finops.mjs 的 DEEP_DIVE_NQ 映射），BFF 按名字取查询 → 跑 CUR 明细 →
    grounded 行喂给模型出洞察/图表。缺了它们，Deep Dive 报 `no_named_queries`。
  · 另外 2 条（DevOps Agent 用量/credit、EDP 承诺达成）供 Athena 控制台直接跑。

历史坑（本模块存在的原因）：这些查询原来只在 setup.sh 的「CUR 已 READY」分支里用 shell 内联
创建。但全新部署时 CUR 首次交付要 ~24h，那次 setup.sh 跑到该分支时 CUR 还是 PENDING → 整块
跳过 → 一条都没建。T+25h 的 lambda6_cur_finalizer 只把状态翻成 READY、发现 Athena 表，
【不创建这些查询】；除非用户事后再手动重跑一次 setup.sh，否则 Deep Dive 永远 `no_named_queries`。

修复：把查询定义收敛到本模块，由 lambda6_cur_finalizer 在【翻成 READY 的同一时刻】幂等下发
（create-named-query）并设好 primary workgroup 的结果输出位置。setup.sh 不再内联 SQL，只在需要时
同步再调一次 finalizer（幂等）。这样任何客户环境、无论 CUR 早到晚到，都零手动自动补齐、且无 SQL 漂移。

用法：
  · Lambda 内：from athena_saved_queries import provision_saved_queries; provision_saved_queries(...)
  · 本地救火（standalone）：
      python3 -m lambda6_cur_finalizer.athena_saved_queries \
        --region us-east-1 --database <db> --table <table> --data-bucket <notiops-data-...>
    （用部署账号本地凭证；幂等：已存在的查询跳过、已有输出位置不覆盖）
"""
from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)

WORKGROUP = "primary"

# Athena/Glue 库名、表名的合法字符集（小写字母/数字/下划线；CUR 建的表就是这个口径）。
# 这些值虽来自受信来源（DDB 的 cur-athena-status 记录，非用户输入），仍在拼进 SQL 前显式校验：
# ① 纵深防御——挡住任何可能的注入/SQL 漂移；② 本文件是公开 aws-samples，客户会照抄这个模式，
# 校验后即使他们改成从不受信来源取 db/table 也安全。参数化只能绑“值”不能绑“标识符”，故用允许集校验。
_IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_]+$")


def _validate_identifier(name: str, label: str) -> str:
    """校验 Athena 库/表标识符只含 [A-Za-z0-9_]；非法即抛，绝不拼进 SQL。"""
    if not isinstance(name, str) or not _IDENTIFIER_RE.match(name):
        raise ValueError(f"invalid {label} identifier (allowed: A-Za-z0-9_): {name!r}")
    return name


def _safe_err(e: Exception) -> str:
    """Sensitive-data handling: return the exception *type* (plus the AWS
    error code for botocore ClientError), never the raw message which can embed
    request payloads or user data. See docs/LOGGING_STANDARD.md."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


def _saved_queries(db: str, table: str) -> list[dict]:
    """返回 6 条保存查询的 (name, description, query_string)。全部按 `<db>.<table>` 完全限定，
    不硬编码任何库/表名——db/table 由调用方从 DDB 的 cur-athena-status 记录动态传入。
    拼进 SQL 前先校验标识符（纵深防御，见 _IDENTIFIER_RE 处说明）。"""
    db = _validate_identifier(db, "database")
    table = _validate_identifier(table, "table")
    fq = f"{db}.{table}"

    nq_devops = f"""-- DevOps Agent: this-month usage + credit allowance (tier% of prior-month Support charge)
-- Credit tier: Enterprise/On-Ramp 75%, Business 30%, else 0.  Rate: 0.0083 USD/sec.
WITH credit_cap AS (
  SELECT SUM(CASE
    WHEN (line_item_product_code LIKE '%Support%' OR product_product_name LIKE '%Support%')
     AND (line_item_product_code LIKE '%Enterprise%' OR product_product_name LIKE '%Enterprise%') THEN line_item_unblended_cost*0.75
    WHEN (line_item_product_code LIKE '%Support%' OR product_product_name LIKE '%Support%')
     AND (line_item_product_code LIKE '%Business%' OR product_product_name LIKE '%Business%')   THEN line_item_unblended_cost*0.30
    ELSE 0 END) AS monthly_credit_usd
  FROM {fq}
  WHERE CAST(year AS integer) = year(current_date) AND CAST(month AS integer) = month(current_date) - 1
    AND line_item_line_item_type = 'Usage'
),
usage AS (
  SELECT line_item_usage_account_id AS account_id,
         SUM(line_item_usage_amount) AS total_hours,
         SUM(line_item_usage_amount)*3600*0.0083 AS implied_cost_usd
  FROM {fq}
  WHERE CAST(year AS integer) = year(current_date) AND CAST(month AS integer) = month(current_date)
    AND product_product_name = 'AWSDevOpsAgent' AND line_item_line_item_type = 'Usage'
  GROUP BY 1
)
SELECT 'usage' AS row_type, account_id, total_hours, implied_cost_usd, CAST(NULL AS double) AS monthly_credit_usd FROM usage
UNION ALL
SELECT 'cap' AS row_type, CAST(NULL AS varchar), CAST(NULL AS double), CAST(NULL AS double), monthly_credit_usd FROM credit_cap"""

    nq_edp = f"""-- EDP Commitment Attainment.  EDIT the 3 values in params to match your EDP contract, then Run.
WITH params AS (
  SELECT CAST(2400000 AS double) AS annual_commitment_usd,  -- <<< EDIT: your EDP annual commitment (USD)
         DATE '2026-01-01' AS contract_start,               -- <<< EDIT: contract start
         DATE '2027-01-01' AS contract_end                  -- <<< EDIT: contract end (exclusive)
),
spend AS (
  SELECT SUM(c.line_item_unblended_cost) AS attained_usd
  FROM {fq} c, params p
  WHERE c.line_item_line_item_type NOT IN ('Tax','Refund','Credit')
    AND c.line_item_usage_start_date >= CAST(p.contract_start AS timestamp)
    AND c.line_item_usage_start_date <  CAST(p.contract_end   AS timestamp)
)
SELECT ROUND(p.annual_commitment_usd,2) AS commitment_usd, ROUND(s.attained_usd,2) AS attained_usd,
       ROUND(s.attained_usd/p.annual_commitment_usd*100,1) AS attainment_pct,
       ROUND(p.annual_commitment_usd-s.attained_usd,2) AS remaining_usd
FROM spend s CROSS JOIN params p"""

    nq_cw = f"""-- CloudWatch this-month cost broken down by usage type + region (from CUR)
SELECT
  line_item_usage_type AS usage_type,
  product_region        AS region,
  ROUND(SUM(line_item_unblended_cost), 2) AS cost_usd,
  ROUND(SUM(line_item_usage_amount), 4)   AS usage_qty
FROM {fq}
WHERE CAST(year AS integer) = year(current_date) AND CAST(month AS integer) = month(current_date)
  AND line_item_product_code = 'AmazonCloudWatch'
  AND line_item_line_item_type NOT IN ('Tax','Credit','Refund')
GROUP BY 1, 2
ORDER BY cost_usd DESC"""

    nq_dt = f"""-- Data transfer this-month cost by service + usage type/direction (from CUR)
SELECT
  product_product_name AS service,
  line_item_usage_type AS usage_type,
  ROUND(SUM(line_item_unblended_cost), 2) AS cost_usd,
  ROUND(SUM(line_item_usage_amount), 4)   AS gb
FROM {fq}
WHERE CAST(year AS integer) = year(current_date) AND CAST(month AS integer) = month(current_date)
  AND product_product_family = 'Data Transfer'
  AND line_item_line_item_type = 'Usage'
GROUP BY 1, 2
ORDER BY cost_usd DESC"""

    nq_ec2 = f"""-- EC2 this-month cost by instance type + region + charge type (from CUR)
SELECT
  product_instance_type    AS instance_type,
  product_region           AS region,
  line_item_line_item_type AS charge_type,
  ROUND(SUM(line_item_unblended_cost), 2) AS cost_usd,
  ROUND(SUM(line_item_usage_amount), 2)   AS usage_hours
FROM {fq}
WHERE CAST(year AS integer) = year(current_date) AND CAST(month AS integer) = month(current_date)
  AND line_item_product_code = 'AmazonEC2'
  AND product_instance_type <> ''
  AND line_item_line_item_type IN ('Usage','DiscountedUsage','SavingsPlanCoveredUsage','SpotUsage')
GROUP BY 1, 2, 3
ORDER BY cost_usd DESC"""

    nq_s3 = f"""-- S3 this-month cost by usage type (storage class / requests / transfer) + region (from CUR)
SELECT
  line_item_usage_type AS usage_type,
  product_region        AS region,
  ROUND(SUM(line_item_unblended_cost), 2) AS cost_usd,
  ROUND(SUM(line_item_usage_amount), 2)   AS usage_qty
FROM {fq}
WHERE CAST(year AS integer) = year(current_date) AND CAST(month AS integer) = month(current_date)
  AND line_item_product_code = 'AmazonS3'
  AND line_item_line_item_type NOT IN ('Tax','Credit','Refund')
GROUP BY 1, 2
ORDER BY cost_usd DESC"""

    return [
        {"name": "NotiOps - DevOps Agent Usage & Credit",
         "description": "本月 DevOps Agent 用量 + credit 额度(tier% x 上月 Support 费)，与仪表盘同口径。",
         "query": nq_devops},
        {"name": "NotiOps - EDP Commitment Attainment",
         "description": "EDP 承诺达成率：改 params 里 3 个值(年度承诺 + 合同起止)即可直接跑。",
         "query": nq_edp},
        {"name": "NotiOps - Deep Dive - CloudWatch cost by usage type",
         "description": "Deep Dive: 本月 CloudWatch 成本按 usage_type/region 拆解(仪表盘 Cost Deep Dive 用)。",
         "query": nq_cw},
        {"name": "NotiOps - Deep Dive - Data Transfer by service",
         "description": "Deep Dive: 本月数据传输成本按服务/方向拆解(仪表盘 Cost Deep Dive 用)。",
         "query": nq_dt},
        {"name": "NotiOps - Deep Dive - EC2 cost by instance type",
         "description": "Deep Dive: 本月 EC2 成本按实例类型/购买方式拆解(仪表盘 Cost Deep Dive 用)。",
         "query": nq_ec2},
        {"name": "NotiOps - Deep Dive - S3 cost by storage class",
         "description": "Deep Dive: 本月 S3 成本按存储类别/用量类型拆解(仪表盘 Cost Deep Dive 用)。",
         "query": nq_s3},
    ]


def _existing_named_query_names(athena, region: str) -> set[str]:
    """primary workgroup 里已有的保存查询名字集合（幂等去重用）。分页取全。"""
    names: set[str] = set()
    ids: list[str] = []
    token = None
    while True:
        kwargs = {"WorkGroup": WORKGROUP, "MaxResults": 50}
        if token:
            kwargs["NextToken"] = token
        resp = athena.list_named_queries(**kwargs)
        ids.extend(resp.get("NamedQueryIds", []))
        token = resp.get("NextToken")
        if not token:
            break
    # batch-get 每次最多 50 个
    for i in range(0, len(ids), 50):
        batch = athena.batch_get_named_query(NamedQueryIds=ids[i:i + 50])
        for q in batch.get("NamedQueries", []):
            names.add(q.get("Name", ""))
    return names


def _ensure_workgroup_output(athena, region: str, output_location: str) -> None:
    """给 primary workgroup 设结果输出位置（Athena 控制台跑查询必须有 S3 结果桶）。
    已有则不覆盖——尊重客户既有配置。"""
    if not output_location:
        return
    try:
        wg = athena.get_work_group(WorkGroup=WORKGROUP)
        cur = (((wg.get("WorkGroup") or {}).get("Configuration") or {})
               .get("ResultConfiguration") or {}).get("OutputLocation")
        if cur:
            logger.info("primary workgroup already has output location (%s), not overwriting", cur)
            return
        athena.update_work_group(
            WorkGroup=WORKGROUP,
            ConfigurationUpdates={"ResultConfigurationUpdates": {"OutputLocation": output_location}},
        )
        logger.info("set primary workgroup output location to %s", output_location)
    except Exception as e:  # noqa: BLE001 — 非致命：设不上不影响 BFF（BFF 自带 OutputLocation）
        logger.warning("ensure workgroup output failed (non-fatal): %s", _safe_err(e))


def provision_saved_queries(region: str, database: str, table: str,
                            output_location: str = "", athena_client=None) -> dict:
    """幂等下发 6 条 FinOps 保存查询 + 设好 primary workgroup 结果输出位置。

    Args:
      region: AWS region（如 us-east-1）
      database / table: CUR 的 Athena 库/表（由 cur-athena-status DDB 记录动态得来，不硬编码）
      output_location: primary workgroup 结果输出位置，如 s3://notiops-data-<acct>-<region>/athena-results/
                       （空则跳过设置；已有则不覆盖）
      athena_client: 可选，注入的 boto3 athena client（测试/复用连接用）

    Returns: {"created": [...names], "skipped": [...names], "errors": [{"name":..,"error":..}]}
    非致命：单条失败不抛，记进 errors，尽量把能建的都建上（部分成功优于全失败）。
    """
    if not (database and table):
        logger.warning("provision_saved_queries: missing database/table, skip")
        return {"created": [], "skipped": [], "errors": [{"name": "*", "error": "missing database/table"}]}

    # 拼 SQL 前先校验标识符；非法则结构化返回（保持“非致命、不抛”的契约），绝不下发。
    # 用布尔判断而非捕获 ValueError——消息是我们自己构造的受控串（含被拒标识符，供取证；
    # 非用户可见、非原始异常/响应体），不走 str(e)/`%s", e` 这类原始异常日志模式。
    bad = next((f"{lbl}={val!r}" for lbl, val in (("database", database), ("table", table))
                if not _IDENTIFIER_RE.match(val)), None)
    if bad:
        msg = f"invalid identifier (allowed A-Za-z0-9_): {bad}"
        logger.warning("provision_saved_queries: %s", msg)
        return {"created": [], "skipped": [], "errors": [{"name": "*", "error": msg}]}

    import boto3
    athena = athena_client or boto3.client("athena", region_name=region)

    _ensure_workgroup_output(athena, region, output_location)

    try:
        existing = _existing_named_query_names(athena, region)
    except Exception as e:  # noqa: BLE001 — 拿不到既有列表时按“全不存在”处理（create 撞名会各自失败并记录）
        logger.warning("list existing named queries failed: %s", _safe_err(e))
        existing = set()

    created, skipped, errors = [], [], []
    for q in _saved_queries(database, table):
        name = q["name"]
        if name in existing:
            skipped.append(name)
            continue
        try:
            athena.create_named_query(
                Name=name, Description=q["description"], Database=database,
                QueryString=q["query"], WorkGroup=WORKGROUP,
            )
            created.append(name)
            logger.info("created named query: %s", name)
        except Exception as e:  # noqa: BLE001
            errors.append({"name": name, "error": _safe_err(e)})
            logger.warning("create named query failed (%s): %s", name, _safe_err(e))
    logger.info("provision_saved_queries done: created=%d skipped=%d errors=%d",
                len(created), len(skipped), len(errors))
    return {"created": created, "skipped": skipped, "errors": errors}


if __name__ == "__main__":  # 本地救火 / 手动补齐用（standalone）
    import argparse
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="Provision NotiOps FinOps Athena saved queries (idempotent).")
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--database", required=True, help="CUR Athena database (from cur-athena-status DDB)")
    ap.add_argument("--table", required=True, help="CUR Athena table")
    ap.add_argument("--data-bucket", default="", help="notiops-data bucket (for workgroup output location)")
    args = ap.parse_args()
    out_loc = f"s3://{args.data_bucket}/athena-results/" if args.data_bucket else ""
    result = provision_saved_queries(args.region, args.database, args.table, out_loc)
    print(result)
