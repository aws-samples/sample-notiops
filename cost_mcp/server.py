"""Cost Agent MCP Server — 一套成本分析 skill 的确定性版本。

每个工具执行一条固定 SQL，口径经一份真实大规模 CUR（2026-07，45 题基准 + 变体测试）
逐题验证；LLM 只传参数、
碰不到 SQL，口径零变形。长尾/灵活查询仍由 skill 配方兜底。
"""

import calendar
import json
import re

from mcp.server import MCPServer

from . import sql as S
from .athena import env, _month_eq, _range_filter, _day_range_filter
from .columns import TAG_KEYS, tag_dimensions

#: 客户自己的 tag 维度（`CUR_TAG_KEYS` 声明，默认空）。见 columns.py 的说明。
_TAG_DIMS = tag_dimensions()
#: 工具描述里那段「可选 tag 维度」。没配 CUR_TAG_KEYS 时是空串 —— **不宣传一个
#: 结果必然全是 `(untagged)` 的维度**，那比少一个维度糟得多。
_TAG_HINT = ("/" + "/".join(sorted(_TAG_DIMS))) if _TAG_DIMS else ""

server = MCPServer(
    name="cost-agent",
    version="1.0.0",
    instructions=(
        "AWS CUR cost query toolset (every basis is production-verified). Prefer these tools for any cost question; only fall back to writing SQL from the skill recipe for long-tail questions no tool covers. All amounts exclude Tax/Credit/Refund unless stated otherwise."
    ),
)

MONTH_RE = re.compile(r"^\d{4}-\d{2}$")


def _check_month(month: str) -> str:
    if not MONTH_RE.match(month):
        raise ValueError(f"month must be in YYYY-MM format, got: {month}")
    return month


def _days_in(month: str) -> int:
    """当月自然天数；查询当月（未完月）时按已过天数算，避免日均分母虚大。"""
    import datetime
    y, m = month.split("-")
    full = calendar.monthrange(int(y), int(m))[1]
    today = datetime.date.today()
    if today.year == int(y) and today.month == int(m):
        return max(1, today.day - 1)  # 当月按截至昨天的天数
    return full


def _closed_cutoff() -> str:
    """CUR 封窗日（T-3）：晚于该日期的 daily 数据未出全，趋势类输出一律截断到此。"""
    import datetime
    return (datetime.date.today() - datetime.timedelta(days=3)).isoformat()


def _trim_open_days(rows, date_key: str = "usage_date"):
    """把 daily 行截断到封窗日 T-3；返回 (rows, 被截掉的天数)。"""
    cutoff = _closed_cutoff()
    kept = [r for r in rows if str(r.get(date_key, ""))[:10] <= cutoff]
    return kept, len(rows) - len(kept)


def _count_points(data) -> int:
    """粗判数据点数：列表长度 / dict 里最长列表的长度（用于展示提示）。"""
    if isinstance(data, list):
        return len(data)
    if isinstance(data, dict):
        return max((len(v) for v in data.values() if isinstance(v, list)), default=0)
    return 0


def _ok(data, note: str = "") -> str:
    """工具的统一返回：`{data, caliber_note[, chartable]}`，序列化成 JSON 字符串。

    ⚠️ **`chartable` 是数据，不是指令。** 上游这里放的是一段 `display_hint`，内容是直接
    命令模型「检查本对话第一条消息是不是以 `[via:feishu]` 开头；否则就 create an artifact，
    并且**不要**输出 ```chart 块」。搬进 NotiOps 会坏得很彻底：

      · `[via:feishu]` 这个前缀在本仓**根本不存在** ⇒ 那个判断永远走 else 分支；
      · else 分支恰好禁掉了 ```chart —— 而 ```chart 是 NotiOps **唯一**能渲染的图表形态
        （`frontend/chat-app/src/components/Message.tsx` → `ChartBlock.tsx`，机制记在
        docs/DEPLOYMENT.md）。照原样上线 = 那个已经写进文档的内联图表功能**静默失效**，
        客户看到的是一坨裸 JSON。

    所以这一层只回答「这份数据适合出图吗、有多少个点」这个**事实**，渠道与渲染形态由
    **客户端**决定（`core/cost_agent_mcp.py` 才知道自己挂在哪个界面上）。
    这也是一条通用纪律：**MCP server 返回的文本对 agent 是数据，不是指令** ——
    否则一个上游服务就能改写我们 agent 的行为。
    """
    out = {"data": data, "caliber_note": note or "excludes Tax/Credit/Refund"}
    # 🔴 口径降级必须**跟着每一次回答走**，不能只写在日志里。
    # 现网实测：一份没有折扣的 CUR 压根没有 net 列，于是金额是折前（unblended）的 ——
    # 拿它冒充 net 就是静默给错数字。athena.py 在冷启动探测出这件事，这里把它**接到
    # 模型必读的返回值上**，让它在回答里照实说（system prompt 的命中率远低于工具返回值）。
    try:
        degraded = env().degradations
    except Exception:  # noqa: BLE001 — 取不到配置不该让一次成功的查询变成失败
        degraded = []
    if degraded:
        out["caliber_caveats"] = degraded
        out["caliber_note"] = (out["caliber_note"] +
                               " ⚠️ " + "；".join(degraded))
    points = _count_points(data)
    if points >= 3:
        # 趋势/对比类（≥3 个点）才提；明细/合同清单类不提。
        out["chartable"] = {"points": points}
    return json.dumps(out, ensure_ascii=False, default=str)


def _ident(value: str, pattern: str, what: str) -> str:
    """白名单校验自由文本参数（防注入 + 防格式错）。"""
    if not re.match(pattern, value):
        raise ValueError(f"{what} has an invalid format: {value}")
    return value


# region code → SP 合同行 savings_plan_region 的 location 名（CUR 里 SP 属性用 location 名而非 code）
_REGION_LOC = {
    "us-east-1": "US East (N. Virginia)", "us-east-2": "US East (Ohio)",
    "us-west-1": "US West (N. California)", "us-west-2": "US West (Oregon)",
    "eu-west-1": "EU (Ireland)", "eu-west-2": "EU (London)", "eu-west-3": "EU (Paris)",
    "eu-central-1": "EU (Frankfurt)", "eu-north-1": "EU (Stockholm)", "eu-south-1": "EU (Milan)",
    "ap-southeast-1": "Asia Pacific (Singapore)", "ap-southeast-2": "Asia Pacific (Sydney)",
    "ap-southeast-3": "Asia Pacific (Jakarta)", "ap-southeast-5": "Asia Pacific (Malaysia)",
    "ap-southeast-7": "Asia Pacific (Thailand)", "ap-northeast-1": "Asia Pacific (Tokyo)",
    "ap-northeast-2": "Asia Pacific (Seoul)", "ap-northeast-3": "Asia Pacific (Osaka)",
    "ap-south-1": "Asia Pacific (Mumbai)", "ap-east-1": "Asia Pacific (Hong Kong)",
    "sa-east-1": "South America (Sao Paulo)", "ca-central-1": "Canada (Central)",
    "me-south-1": "Middle East (Bahrain)", "me-central-1": "Middle East (UAE)",
    "af-south-1": "Africa (Cape Town)",
}


# ══════════════════════ 基础费用 ══════════════════════

@server.tool(description="Total cost for a month (net_unblended, excludes Tax/Credit/Refund), aggregated by SQL. Pass month_to for a month range: per-month rows plus a range total (answers 'how much have we spent year to date' in one call).")
def get_monthly_total(month: str, month_to: str = "") -> str:
    e = env()
    if month_to:
        m_from, m_to = _check_month(month), _check_month(month_to)
        tf = _range_filter(e, m_from, m_to)
        monthly = e.run(
            f"SELECT substr(CAST(bill_billing_period_start_date AS varchar),1,7) AS month, "
            f"ROUND(SUM(line_item_net_unblended_cost),2) AS cost FROM {e.table} WHERE {tf} AND {S.NOT_TCR} GROUP BY 1 ORDER BY 1"
        )
        total = e.run(f"SELECT ROUND(SUM(line_item_net_unblended_cost),2) AS range_total FROM {e.table} WHERE {tf} AND {S.NOT_TCR}")
        return _ok({"monthly": monthly, "range_total": total[0]["range_total"]},
                   f"{m_from}~{m_to} range; range_total comes straight from SQL -- do NOT sum it yourself")
    tf = e.time_filter(_check_month(month))
    rows = e.run(f"SELECT ROUND(SUM(line_item_net_unblended_cost),2) AS total_cost FROM {e.table} WHERE {tf} AND {S.NOT_TCR}")
    return _ok(rows[0])


@server.tool(description="Daily cost trend for a month plus the total (aggregated by SQL -- do NOT sum it yourself). Optional day_from/day_to (1-31) selects a range; the range total also comes straight from SQL (range_total_sql). Use it for 'how much did we spend from day X to day Y'; do NOT sum the daily rows yourself.")
def get_daily_cost_trend(month: str, day_from: int = 0, day_to: int = 0) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    range_cond = ""
    if day_from or day_to:
        df = max(1, int(day_from) or 1)
        dt = min(31, int(day_to) or 31)
        range_cond = (f" AND line_item_usage_start_date >= TIMESTAMP '{month}-{df:02d} 00:00:00'"
                      f" AND line_item_usage_start_date < date_add('day', 1, TIMESTAMP '{month}-{dt:02d} 00:00:00')")
    daily = e.run(
        f"SELECT date_trunc('day', line_item_usage_start_date) AS usage_date, ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR}{range_cond} GROUP BY 1 ORDER BY 1"
    )
    total = e.run(f"SELECT ROUND(SUM(line_item_net_unblended_cost),2) AS total FROM {e.table} WHERE {tf} AND {S.NOT_TCR}{range_cond}")
    key = "range_total_sql" if range_cond else "month_total_sql"
    return _ok({"daily": daily, key: total[0]["total"]},
               "The total comes straight from SQL (" + key + "); quote it as-is and do NOT sum the daily rows yourself")


@server.tool(description="Cost cube: the last N days aggregated by day x service x region x account (for dashboard cross-filtering). About 50k rows per 30 days -- for programmatic use only. Do NOT use it to answer chat questions (use get_daily_cost_trend / get_cost_split instead).")
def get_cost_cube(days: int = 30, min_cost: float = 1.0, date_from: str = "", date_to: str = "") -> str:
    e = env()
    days = max(7, min(int(days), 92))
    from datetime import date, timedelta
    # 显式日期范围（精确到天）优先；否则默认近 N 天（封窗 T-3：最近 3 天 CUR 未出全）
    if date_from and date_to:
        start = date.fromisoformat(_ident(date_from, r"^\d{4}-\d{2}-\d{2}$", "date_from"))
        end = date.fromisoformat(_ident(date_to, r"^\d{4}-\d{2}-\d{2}$", "date_to"))
        if (end - start).days > 92:
            start = end - timedelta(days=92)
    else:
        end = date.today() - timedelta(days=3)
        start = end - timedelta(days=days)
    months = sorted({f"{d.year}-{d.month:02d}" for d in (start, end)} | {f"{(start + timedelta(days=i)).year}-{(start + timedelta(days=i)).month:02d}" for i in range(0, days, 28)})
    tf = _range_filter(e, months[0], months[-1])
    rows = e.run(
        f"SELECT substr(CAST(date_trunc('day', line_item_usage_start_date) AS varchar),1,10) AS d, "
        f"{S.FINAL_SERVICE} AS svc, "
        f"COALESCE(NULLIF(product_region,''),'(global)') AS region, "
        f"line_item_usage_account_id AS account, "
        f"ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} "
        f"AND line_item_usage_start_date >= TIMESTAMP '{start} 00:00:00' "
        f"AND line_item_usage_start_date < TIMESTAMP '{end + timedelta(days=1)} 00:00:00' "
        f"GROUP BY 1,2,3,4 HAVING SUM(line_item_net_unblended_cost) > {float(min_cost)} "
        f"ORDER BY 1",
        timeout_s=280,
    )
    # 列式压缩：字典编码维度值，行变 [d_idx, svc_idx, region_idx, account_idx, cost]——体积降约 70%
    dims = {"d": [], "svc": [], "region": [], "account": []}
    lut = {k: {} for k in dims}
    packed = []
    for r in rows:
        idxs = []
        for k in ("d", "svc", "region", "account"):
            v = r[k]
            if v not in lut[k]:
                lut[k][v] = len(dims[k])
                dims[k].append(v)
            idxs.append(lut[k][v])
        packed.append(idxs + [float(r["cost"])])
    return _ok({"from": str(start), "to": str(end), "encoding": "columnar",
                "dims": dims, "rows": packed},
               f"last {days}-day cost cube (columnar encoding: rows=[index of d, svc, region, account, cost]); HAVING >${min_cost}; net basis")

@server.tool(description="Top N services by cost for a month (final_service production basis: EBS/NAT/VPC are split out of EC2, and Marketplace is broken down by product name).")
def get_top_services(month: str, top_n: int = 10) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    top_n = max(1, min(int(top_n), 50))
    rows = e.run(
        f"SELECT {S.FINAL_SERVICE} AS final_service, ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT {top_n}"
    )
    return _ok(rows)


@server.tool(description="Cost for a month split by a dimension. dimension: account/payer/region/os/usage_type/operation/billing_entity/legal_entity/charge_type. Pass month_to together with filter_value to get a per-month trend for that one dimension value (answers 'the last 6 months for account X' in one call).")
def get_cost_split(month: str, dimension: str = "account", top_n: int = 20,
                   month_to: str = "", filter_value: str = "") -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    col = {
        "account": "line_item_usage_account_id",
        "payer": "bill_payer_account_id",
        "region": "COALESCE(NULLIF(product_region,''),'(global)')",
        "os": "COALESCE(NULLIF(product_operating_system,''),'NA')",
        "usage_type": "line_item_usage_type",
        "operation": "COALESCE(NULLIF(line_item_operation,''),'(none)')",
        "billing_entity": "bill_billing_entity",
        "legal_entity": "line_item_legal_entity",
        "charge_type": "line_item_line_item_type",
    }
    if dimension not in col:
        raise ValueError(f"dimension must be one of {'/'.join(col)}, got: {dimension}")
    top_n = max(1, min(int(top_n), 300))
    if month_to:
        # 逐月趋势：filter_value 锁定单个维度值（如某账号），否则 Top N 维度值 × 月的矩阵
        m_from, m_to = _check_month(month), _check_month(month_to)
        rf = _range_filter(e, m_from, m_to)
        fv = ""
        if filter_value:
            v = _ident(filter_value, r"^[A-Za-z0-9()., _-]+$", "filter_value")
            fv = f" AND ({col[dimension]}) = '{v}'"
        rows = e.run(
            f"SELECT substr(CAST(bill_billing_period_start_date AS varchar),1,7) AS month, {col[dimension]} AS {dimension}, "
            f"ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
            f"FROM {e.table} WHERE {rf} AND {S.NOT_TCR}{fv} "
            f"GROUP BY 1,2 ORDER BY 1, 3 DESC"
        )
        if not filter_value:
            rows = rows[:top_n * 12]
        return _ok(rows, f"{m_from}~{m_to} by {dimension} per-month trend" + (" (pinned to " + filter_value + "）" if filter_value else "; without a pinned value this returns many rows, so passing filter_value is recommended"))
    rows = e.run(
        f"SELECT {col[dimension]} AS {dimension}, ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT {top_n}"
    )
    return _ok(rows)


# 数量/费用类拆分的维度白名单（列表达式经生产验证；LOB/AZ 故意不含——LOB 走客户 knowledge，AZ 不需要）
_DIM_COLS = {
    "os": "COALESCE(NULLIF(product_operating_system,''),'NA')",
    "instance_type": None,   # 特殊：用 S.INSTANCE_TYPE（Spot 行解析）
    "family": None,          # 特殊：用 S.INSTANCE_FAMILY
    "account": "line_item_usage_account_id",
    "region": "COALESCE(NULLIF(product_region,''),'(global)')",
    "charge_type": "line_item_line_item_type",
    "usage_type": "line_item_usage_type",
    **_TAG_DIMS,
}


def _dim_expr(dimension: str) -> str:
    if dimension == "instance_type":
        return S.INSTANCE_TYPE
    if dimension == "family":
        return S.INSTANCE_FAMILY
    expr = _DIM_COLS.get(dimension)
    if not expr:
        raise ValueError(f"dimension must be one of {'/'.join(_DIM_COLS)}, got: {dimension}")
    return expr


_SERVICE_ALIAS = {
    "ec2": "AmazonEC2", "ebs": "AmazonEBS", "s3": "AmazonS3", "rds": "AmazonRDS",
    "cloudfront": "AmazonCloudFront", "elasticache": "AmazonElastiCache",
    "nat": "NatGateway", "natgateway": "NatGateway", "nat gateway": "NatGateway",
    "dt": "AWSDataTransfer", "datatransfer": "AWSDataTransfer", "data transfer": "AWSDataTransfer",
    "elb": "AWSELB", "dx": "AWSDirectConnect", "directconnect": "AWSDirectConnect",
    "vpc": "AmazonVPC", "eks": "AmazonEKS", "lambda": "AWSLambda",
    "dynamodb": "AmazonDynamoDB", "redshift": "AmazonRedshift", "opensearch": "AmazonES",
}


@server.tool(description="Cost of one service for a month (final_service basis). Pass a final_service value such as AmazonS3/AmazonEC2/AWSDataTransfer/NatGateway (common short names like EBS/S3/ELB are mapped automatically).")
def get_service_cost(month: str, service: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    service = _SERVICE_ALIAS.get(service.strip().lower(), service)
    service = _ident(service, r"^[A-Za-z0-9 ().&:/-]{2,80}$", "service")
    rows = e.run(
        f"SELECT ROUND(SUM(line_item_net_unblended_cost),2) AS cost FROM {e.table} "
        f"WHERE {tf} AND {S.NOT_TCR} AND ({S.FINAL_SERVICE}) = '{service}'"
    )
    return _ok(rows[0], f"final_service='{service}'; excludes Tax/Credit/Refund")


@server.tool(description="Month-over-month attribution: by default ranks the delta per final_service. Set service to scope it to one service, then use dimension=usage_type/account/instance_type/family/region/operation to drill down (answers 'why did X go up').")
def get_mom_attribution(month_a: str, month_b: str, top_n: int = 10, service: str = "", dimension: str = "") -> str:
    e = env()
    tfa, tfb = e.time_filter(_check_month(month_a)), e.time_filter(_check_month(month_b))
    top_n = max(1, min(int(top_n), 50))
    # 服务内下钻归因：service 限定范围，dimension 选归因维度
    scope = ""
    if service:
        sv = _ident(service, r"^[A-Za-z0-9()., -]+$", "service")
        scope = f" AND ({S.FINAL_SERVICE}) = '{sv}'"
    dim_map = {"usage_type": "line_item_usage_type", "account": "line_item_usage_account_id",
               "instance_type": f"COALESCE(NULLIF({S.INSTANCE_TYPE},''),'(no-instance)')",
               "family": f"COALESCE(NULLIF({S.INSTANCE_FAMILY},''),'(no-family: SP fee/EBS/DT and other rows with no instance type)')",
               "region": "COALESCE(NULLIF(product_region,''),'(global)')", "operation": "line_item_operation"}
    dim_expr = dim_map.get(dimension) or S.FINAL_SERVICE
    dim_alias = dimension if dimension in dim_map else "final_service"
    rows = e.run(
        f"SELECT {dim_expr} AS {dim_alias}, "
        f"ROUND(SUM(CASE WHEN {tfb} THEN line_item_net_unblended_cost ELSE 0 END),2) AS cost_b, "
        f"ROUND(SUM(CASE WHEN {tfa} THEN line_item_net_unblended_cost ELSE 0 END),2) AS cost_a, "
        f"ROUND(SUM(CASE WHEN {tfb} THEN line_item_net_unblended_cost ELSE 0 END) - SUM(CASE WHEN {tfa} THEN line_item_net_unblended_cost ELSE 0 END),2) AS delta "
        f"FROM {e.table} WHERE (({tfa}) OR ({tfb})) AND {S.NOT_TCR}{scope} "
        f"GROUP BY 1 ORDER BY ABS(SUM(CASE WHEN {tfb} THEN line_item_net_unblended_cost ELSE 0 END) - SUM(CASE WHEN {tfa} THEN line_item_net_unblended_cost ELSE 0 END)) DESC LIMIT {top_n}"
    )
    return _ok(rows, f"month_a={month_a}, month_b={month_b}, delta=b-a; excludes Tax/Credit/Refund")


# ══════════════════════ EC2 / 购买方式 ══════════════════════

@server.tool(description="EC2 purchase-option split for a month (amortized basis). detail=false gives 5 coarse buckets (OD/SP/Spot/RI/CB); detail=true breaks out the four ODCR quadrants and SP waste.")
def get_purchase_option_split(month: str, detail: bool = False) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    days = _days_in(month)
    if detail:
        # R27：final_purchase_option 全谱（含 Discount/Negation 行），scope=内层 service
        rows = e.run(
            f"SELECT {S.FINAL_PURCHASE_OPTION} AS purchase_option, ROUND({S.AMORTIZED},2) AS amortized_cost, "
            f"ROUND(SUM(CASE WHEN {S.COUNT_ROWS_FILTER} THEN line_item_usage_amount ELSE 0 END)/24/{days},2) AS avg_daily_instances "
            f"FROM {e.table} WHERE {tf} AND {S.INNER_SERVICE} IN ('AmazonEC2','ComputeSavingsPlans') "
            f"GROUP BY 1 ORDER BY 2 DESC"
        )
        return _ok(rows, "R27 detailed basis (amortized); instance count = SUM(usage_amount)/24/calendar days")
    # R4：粗分 5 类，scope=实例行按 family + SP/RI/CB 计费行整行保留（缺一混入 RDS RI/EBS 行）
    rows = e.run(
        f"SELECT {S.PURCHASE_OPTION} AS purchase_option, ROUND({S.AMORTIZED},2) AS amortized_cost, "
        f"ROUND(SUM(CASE WHEN {S.COUNT_ROWS_FILTER} THEN line_item_usage_amount ELSE 0 END)/24/{days},2) AS avg_daily_instances "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} "
        f"AND line_item_product_code IN ('AmazonEC2','ComputeSavingsPlans') "
        f"AND (({S.EC2_COMPUTE_FAMILY}) "
        f"  OR COALESCE(savings_plan_savings_plan_a_r_n,'') <> '' "
        f"  OR COALESCE(reservation_reservation_a_r_n,'') <> '' "
        f"  OR line_item_usage_type LIKE '%CapacityBlockFee%') "
        f"GROUP BY 1 ORDER BY 2 DESC"
    )
    return _ok(rows, "R4 coarse basis (amortized); instance count = SUM(usage_amount)/24/calendar days")


@server.tool(description=f"Average daily instance count for a month. Optional filters (instance_type/family/account/region) and an optional dimension to split by (os/instance_type/family/account/region/charge_type{_TAG_HINT}). Instance count = SUM(usage_amount)/24.")
def get_instance_count(month: str, instance_type: str = "", family: str = "", account: str = "", region: str = "", daily_trend: bool = False, dimension: str = "") -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    days = _days_in(month)
    where = [tf, S.COUNT_ROWS_FILTER]
    note = ["instance count = SUM(usage_amount)/24 (Box+Spot+UnusedBox; includes idle ODCR capacity)"]
    if instance_type:
        it = _ident(instance_type, r"^[a-z0-9-]+\.[a-z0-9]+$", "instance_type")
        where.append(f"{S.INSTANCE_TYPE} = '{it}'")
        note.append(f"instance type={it}")
    if family:
        fam = _ident(family, r"^[a-z0-9-]+$", "family")
        where.append(f"{S.INSTANCE_FAMILY} = '{fam}'")
        note.append(f"instance family={fam} (exact match, excludes {fam}n/{fam}d and similar variants)")
    if account:
        acct = _ident(account, r"^\d{12}$", "account")
        where.append(f"line_item_usage_account_id = '{acct}'")
    if region:
        reg = _ident(region, r"^[a-z0-9-]+$", "region")
        where.append(f"product_region = '{reg}'")
    w = " AND ".join(where)
    if dimension:
        dx = _dim_expr(dimension)
        rows = e.run(f"SELECT {dx} AS {dimension}, ROUND(SUM(line_item_usage_amount)/24/{days},2) AS avg_daily_instances "
                     f"FROM {e.table} WHERE {w} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 25")
        note.append(f"by {dimension} split, top 25")
        return _ok(rows, "；".join(note))
    monthly = e.run(f"SELECT ROUND(SUM(line_item_usage_amount)/24/{days},2) AS avg_daily_instances FROM {e.table} WHERE {w}")
    result: dict = {"avg_daily_instances": monthly[0]["avg_daily_instances"]}
    if daily_trend:
        result["daily"] = e.run(
            f"SELECT date_trunc('day', line_item_usage_start_date) AS usage_date, ROUND(SUM(line_item_usage_amount)/24,2) AS instances "
            f"FROM {e.table} WHERE {w} GROUP BY 1 ORDER BY 1"
        )
    return _ok(result, "；".join(note))


@server.tool(description=f"Average daily vCPU count and GPU count for a month (same basis as instance count). Optional dimension to split by (os/instance_type/family/account/region/charge_type{_TAG_HINT}）。")
def get_vcpu_gpu_count(month: str, dimension: str = "") -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    days = _days_in(month)
    sel = (f"ROUND(SUM(line_item_usage_amount * TRY_CAST(product_vcpu AS double))/24/{days},2) AS avg_daily_vcpu, "
           f"ROUND(SUM(CASE WHEN TRY_CAST(product_gpu AS double) IS NOT NULL THEN line_item_usage_amount * TRY_CAST(product_gpu AS double) ELSE 0 END)/24/{days},2) AS avg_daily_gpu")
    if dimension:
        dx = _dim_expr(dimension)
        rows = e.run(f"SELECT {dx} AS {dimension}, {sel} FROM {e.table} WHERE {tf} AND {S.COUNT_ROWS_FILTER} "
                     f"GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 25")
        return _ok(rows, f"by {dimension} split, top 25 (ordered by vCPU)")
    rows = e.run(f"SELECT {sel} FROM {e.table} WHERE {tf} AND {S.COUNT_ROWS_FILTER}")
    return _ok(rows[0])


@server.tool(description="Graviton vs non-Graviton EC2 cost for a month (amortized; Graviton includes the waste of its own Instance SPs, Compute SP waste is not apportioned).")
def get_graviton_split(month: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    rows = e.run(
        f"SELECT CASE WHEN (({S.EC2_COMPUTE_FAMILY}) AND {S.GRAVITON_MATCH}) "
        f"OR (line_item_line_item_type = 'SavingsPlanRecurringFee' AND {S.GRAVITON_SP_FAMILY}) "
        f"THEN 'Graviton' ELSE 'Non-Graviton' END AS processor_type, "
        f"ROUND({S.AMORTIZED},2) AS amortized_cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} "
        f"AND {S.INNER_SERVICE} IN ('AmazonEC2','ComputeSavingsPlans') "
        f"AND (({S.EC2_COMPUTE_FAMILY}) OR line_item_line_item_type = 'SavingsPlanRecurringFee') "
        f"GROUP BY 1 ORDER BY 2 DESC"
    )
    return _ok(rows, "amortized; Instance SP waste is attributed to Graviton via savings_plan_instance_type_family; Compute SP waste is excluded")


@server.tool(description="Top N GPU instance cost and instance count for a month (amortized basis, by instance type).")
def get_gpu_cost(month: str, top_n: int = 10) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    days = _days_in(month)
    top_n = max(1, min(int(top_n), 50))
    rows = e.run(
        f"SELECT product_instance_type, "
        f"ROUND(SUM(CASE WHEN {S.COUNT_ROWS_FILTER} THEN line_item_usage_amount ELSE 0 END)/24/{days},2) AS avg_daily_instances, "
        f"ROUND({S.AMORTIZED},2) AS amortized_cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} AND {S.GPU_MATCH} AND {S.EC2_COMPUTE_FAMILY} "
        f"GROUP BY 1 ORDER BY 3 DESC LIMIT {top_n}"
    )
    return _ok(rows, "amortized basis")


@server.tool(description="EC2 cost by instance family for a month (amortized). families takes comma-separated exact family names such as 'c5,c6i,c7g'; empty means top 20 across all families.")
def get_family_cost(month: str, families: str = "") -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    fam_filter = ""
    if families:
        fams = [_ident(f.strip(), r"^[a-z0-9-]+$", "family") for f in families.split(",") if f.strip()]
        quoted = ",".join(f"'{f}'" for f in fams)
        fam_filter = f"AND {S.INSTANCE_FAMILY} IN ({quoted})"
    rows = e.run(
        f"SELECT {S.INSTANCE_FAMILY} AS family, ROUND({S.AMORTIZED},2) AS amortized_cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} AND {S.EC2_COMPUTE_FAMILY} {fam_filter} "
        f"GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 20"
    )
    return _ok(rows, "amortized; instance family is matched exactly (for Spot rows it is parsed out of the description)")


# ══════════════════════ SP / RI / ODCR ══════════════════════

@server.tool(description="Savings Plan coverage for a month (cost basis). granularity: monthly for a single whole-month figure, daily for a per-day series. Optional region (a code such as us-east-1) and family (an instance family such as c5) filters. Baseline is the list on-demand price. WARNING: if the user asks on a vCPU/core basis, use get_vcpu_metrics(metric=sp_coverage) -- do NOT pass this tool off as that.")
def get_sp_coverage(month: str = "", granularity: str = "monthly",
                    date_from: str = "", date_to: str = "",
                    region: str = "", family: str = "") -> str:
    e = env()
    use_range = bool(date_from and date_to)
    tf = _day_range_filter(e, date_from, date_to) if use_range else e.time_filter(_check_month(month))
    fcond, notes = "", []
    if region:
        reg = _ident(region, r"^[a-z0-9-]+$", "region")
        fcond += f" AND product_region = '{reg}'"
        notes.append(f"region={reg}")
    if family:
        fam = _ident(family, r"^[a-z0-9-]+$", "family")
        fcond += f" AND product_instance_type LIKE '{fam}.%'"
        notes.append(f"instance family={fam}")
    scope = ("; scope: " + "、".join(notes)) if notes else ""
    numer = "SUM(CASE WHEN pf3 AND lt='SavingsPlanCoveredUsage' THEN ub ELSE 0 END)"
    denom = f"NULLIF({numer} + SUM(CASE WHEN pf3 AND po='OnDemand' AND lt='Usage' THEN ub ELSE 0 END), 0)"
    cte = (
        f"WITH rt AS (SELECT date_trunc('day', line_item_usage_start_date) AS d, line_item_unblended_cost AS ub, "
        f"line_item_line_item_type AS lt, "
        f"product_product_family IN ('Compute Instance','Compute Instance (bare metal)','Dedicated Host') AS pf3, "
        f"{S.PURCHASE_OPTION} AS po FROM {e.table} WHERE {tf}{fcond})"
    )
    if granularity == "daily":
        # 账期分区可能带出 usage 日期溢出月外的调整行（如 7 月账期里的 9/9 行）——按月截断；
        # date-range 模式下 _day_range_filter 已精确截取，无需再截
        cond = "" if use_range else f" WHERE substr(CAST(d AS varchar),1,7) = '{_check_month(month)}'"
        rows = e.run(f"{cte} SELECT d AS usage_date, ROUND({numer} / {denom} * 100, 2) AS sp_coverage_pct "
                     f"FROM rt{cond} GROUP BY 1 ORDER BY 1")
        rows, trimmed = _trim_open_days(rows)
        trim_note = f"; truncated the most recent {trimmed} days of not-yet-finalized data (CUR lags 48-72h, as of {_closed_cutoff()}）" if trimmed else ""
        return _ok(rows, f"baseline is the list on-demand price; the denominator includes idle ODCR rows{scope}{trim_note}")
    rows = e.run(f"{cte} SELECT ROUND({numer} / {denom} * 100, 2) AS sp_coverage_pct FROM rt")
    return _ok(rows[0], f"computed as total numerator / total denominator over the whole period (NOT an average of the daily values); baseline is the list on-demand price{scope}")


@server.tool(description="Savings Plan utilisation for a month (computed directly as used/total on the RecurringFee rows) plus the total waste amount. granularity: monthly for a single figure, daily for a per-day trend. Optional region (a code such as us-east-1) and family (an instance family such as c5) filters -- only Instance SPs carry region/instance-type attributes, so filtering silently excludes Compute SPs (say so in your answer).")
def get_sp_utilization(month: str = "", date_from: str = "", date_to: str = "",
                       granularity: str = "monthly", region: str = "", family: str = "") -> str:
    e = env()
    use_range = bool(date_from and date_to)
    tf = _day_range_filter(e, date_from, date_to) if use_range else e.time_filter(_check_month(month))
    fcond, notes = "", []
    if region:
        reg = _ident(region, r"^[a-z0-9-]+$", "region")
        loc = _REGION_LOC.get(reg)
        if not loc:
            raise ValueError(f"unknown region code: {reg}")
        fcond += f" AND savings_plan_region = '{loc}'"
        notes.append(f"region={reg}")
    if family:
        fam = _ident(family, r"^[a-z0-9-]+$", "family")
        fcond += f" AND savings_plan_instance_type_family = '{fam}'"
        notes.append(f"instance family={fam}")
    scope = ("; scope: " + "、".join(notes) + " (Instance SPs only -- Compute SPs have no region/instance-type attributes and are not counted)") if notes else ""
    base = (
        f"ROUND(SUM(savings_plan_used_commitment)/NULLIF(SUM(savings_plan_total_commitment_to_date),0)*100,2) AS sp_utilization_pct, "
        f"ROUND(SUM(savings_plan_total_commitment_to_date - savings_plan_used_commitment),2) AS total_waste "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'SavingsPlanRecurringFee'{fcond}"
    )
    if granularity == "daily":
        rows = e.run(
            f"SELECT date_trunc('day', line_item_usage_start_date) AS usage_date, {base} GROUP BY 1 ORDER BY 1"
        )
        if not use_range:
            m = _check_month(month)
            rows = [r for r in rows if str(r.get("usage_date", ""))[:7] == m]
        rows, trimmed = _trim_open_days(rows)
        trim_note = f"; truncated the most recent {trimmed} days of not-yet-finalized data (CUR lags 48-72h, as of {_closed_cutoff()}）" if trimmed else ""
        return _ok(rows, f"used/total computed per day (RecurringFee rows aggregated daily){scope}{trim_note}")
    rows = e.run(f"SELECT {base}")
    return _ok(rows[0], f"computed directly as used/total{scope}" if notes else "")


@server.tool(description="Everything the Savings Plan dashboard needs at daily granularity (same source as the 6 SP charts in the QuickSight dashboard): daily coverage on both a cost and a vCPU basis, utilisation on a cost basis, waste amount grouped by usage_type, and wasted vCPUs grouped by usage_type. Intended for charting -- use the single-purpose tools to answer chat questions.")
def get_sp_dashboard_daily(month: str = "", date_from: str = "", date_to: str = "") -> str:
    e = env()
    tf = _day_range_filter(e, date_from, date_to) if (date_from and date_to) else e.time_filter(_check_month(month))
    day = "substr(CAST(date_trunc('day', line_item_usage_start_date) AS varchar),1,10)"
    # 利用率（费用口径，逐日）：QS sp_utilization = used/total（RecurringFee 行）
    q_util = (
        f"SELECT {day} AS d, "
        f"ROUND(SUM(savings_plan_used_commitment)/NULLIF(SUM(savings_plan_total_commitment_to_date),0)*100,2) AS utilization_pct "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'SavingsPlanRecurringFee' GROUP BY 1 ORDER BY 1"
    )
    # 浪费金额（逐日 × usage_type）：QS sp_wasted_cost 色分 usage_type
    q_waste_cost = (
        f"SELECT {day} AS d, line_item_usage_type AS usage_type, "
        f"ROUND(SUM(savings_plan_total_commitment_to_date - savings_plan_used_commitment),2) AS waste "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'SavingsPlanRecurringFee' "
        f"GROUP BY 1,2 ORDER BY 1"
    )
    # 浪费 vCPU（逐日 × usage_type）：QS sp_waste_vcpu = sp_purchased_vcpu × 未用比例。
    # 与生产 QuickSight dashboard 的同名图表完全同源，两处关键：
    # ① per_vcpu_rate 用 year>=2025 全历史算（区间费率随机型漂移偏高近一倍）
    # ② 先按 SP×天聚合（view 是日粒度行）再 ROUND 折算 purchased——在 hourly 行上 ROUND
    #    会把半个 vCPU 的舍入损耗放大 24 倍（实测 2544 vs 2555）
    q_waste_vcpu = (
        f"WITH sp_vcpu AS (SELECT savings_plan_savings_plan_a_r_n AS sp_arn, "
        f"SUM(savings_plan_net_savings_plan_effective_cost)/NULLIF(SUM(CAST(product_vcpu AS double)*line_item_usage_amount),0) AS per_vcpu_rate "
        f"FROM {e.table} WHERE {e.rate_window_filter()} AND line_item_line_item_type = 'SavingsPlanCoveredUsage' AND line_item_usage_type LIKE '%BoxUsage%' GROUP BY 1), "
        f"sp_day AS (SELECT {day} AS d, line_item_usage_type AS usage_type, savings_plan_savings_plan_a_r_n AS sp_arn, "
        f"SUM(savings_plan_total_commitment_to_date) AS total, SUM(savings_plan_used_commitment) AS used "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'SavingsPlanRecurringFee' GROUP BY 1,2,3) "
        f"SELECT m.d, m.usage_type, "
        f"ROUND(SUM(COALESCE(ROUND(m.total/24/NULLIF(v.per_vcpu_rate,0), 0) * (m.total - m.used)/NULLIF(m.total,0), 0)),1) AS waste_vcpu "
        f"FROM sp_day m LEFT JOIN sp_vcpu v ON m.sp_arn = v.sp_arn "
        f"GROUP BY 1,2 ORDER BY 1"
    )
    # 利用率（vCPU 口径，逐日）：QS sp_utilization_vcpu =
    # sum(used×purchased_vcpu/total)/sum(purchased_vcpu)，购买 vCPU 加权；
    # purchased_vcpu = total/24/per_vcpu_rate，化简后分子=used/(24×rate)、分母=total/(24×rate)。
    # 无 BoxUsage 覆盖（rate 为 NULL）的 SP 与 QS 一致：不计入分子分母。
    q_util_vcpu = (
        f"WITH sp_vcpu AS (SELECT savings_plan_savings_plan_a_r_n AS sp_arn, "
        f"SUM(savings_plan_net_savings_plan_effective_cost)/NULLIF(SUM(CAST(product_vcpu AS double)*line_item_usage_amount),0) AS per_vcpu_rate "
        f"FROM {e.table} WHERE {e.rate_window_filter()} AND line_item_line_item_type = 'SavingsPlanCoveredUsage' AND line_item_usage_type LIKE '%BoxUsage%' GROUP BY 1) "
        f"SELECT {day} AS d, "
        f"ROUND(SUM(m.savings_plan_used_commitment/(24*v.per_vcpu_rate)) / "
        f"NULLIF(SUM(m.savings_plan_total_commitment_to_date/(24*v.per_vcpu_rate)),0)*100,2) AS utilization_vcpu_pct "
        f"FROM {e.table} m JOIN sp_vcpu v ON m.savings_plan_savings_plan_a_r_n = v.sp_arn AND v.per_vcpu_rate > 0 "
        f"WHERE {tf} AND m.line_item_line_item_type = 'SavingsPlanRecurringFee' "
        f"GROUP BY 1 ORDER BY 1"
    )
    # 四条查询并发（串行跨月区间会超 Lambda 300s）
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=4) as pool:
        f_util = pool.submit(e.run, q_util)
        f_uv = pool.submit(e.run, q_util_vcpu)
        f_wc = pool.submit(e.run, q_waste_cost)
        f_wv = pool.submit(e.run, q_waste_vcpu)
        util, util_vcpu, waste_cost, waste_vcpu = f_util.result(), f_uv.result(), f_wc.result(), f_wv.result()
    return _ok({"utilization_daily": util, "utilization_vcpu_daily": util_vcpu,
                "waste_cost_daily": waste_cost, "waste_vcpu_daily": waste_vcpu},
               "Same basis as the QuickSight SP charts: utilisation = used/total; vCPU utilisation = sum(used x purchased vCPU / total) / sum(purchased vCPU) (weighted by purchased vCPU; SPs with no BoxUsage coverage are not counted); waste = total-used on the RecurringFee rows; wasted vCPU = purchased vCPU x unused ratio (converted via per_vcpu_rate)")

@server.tool(description="Total Savings Plan commitment for a month (actual-spend basis, SUM(total_commitment) over the RecurringFee rows) and the number of SPs.")
def get_sp_commitment(month: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    rows = e.run(
        f"SELECT COUNT(DISTINCT savings_plan_savings_plan_a_r_n) AS sp_count, "
        f"ROUND(SUM(savings_plan_total_commitment_to_date),2) AS month_commitment "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'SavingsPlanRecurringFee'"
    )
    return _ok(rows[0], "actual-spend basis, SUM(total_commitment_to_date); SP count = COUNT(DISTINCT ARN)")


@server.tool(description="Per-contract Savings Plan detail, ordered by waste amount: ARN, payer, type, instance family, region, term, expiry, hourly commitment, utilisation and waste. Instance SP rows carry an instance family and a region, so you can filter with family/exclude_family (exact family match) and region (fuzzy match on the location name, e.g. Tokyo or Frankfurt); Compute SPs have no instance-type or region attribute.")
def get_sp_details(month: str = "", top_n: int = 20, family: str = "", region: str = "", exclude_family: str = "",
                   date_from: str = "", date_to: str = "") -> str:
    e = env()
    if date_from and date_to:
        tf = _day_range_filter(e, date_from, date_to)
        m = date_from[:7]  # days_to_expire 以区间起始月 1 日为基准
    else:
        m = _check_month(month)
        tf = e.time_filter(m)
    top_n = max(1, min(int(top_n), 300))
    cond = ""
    if family:
        f_ = _ident(family, r"^[a-z0-9-]+$", "family")
        cond += f" AND savings_plan_instance_type_family = '{f_}'"
    if exclude_family:
        f_ = _ident(exclude_family, r"^[a-z0-9-]+$", "exclude_family")
        cond += f" AND savings_plan_instance_type_family <> '{f_}'"
    if region:
        r_ = _ident(region, r"^[A-Za-z0-9()., -]+$", "region")
        cond += f" AND savings_plan_region LIKE '%{r_}%'"
    # purchased_vcpu：per_vcpu_rate = 该 SP 覆盖费用 / 覆盖 vCPU 小时（与生产 dashboard 同公式）
    rows = e.run(
        f"WITH sp_vcpu AS (SELECT savings_plan_savings_plan_a_r_n AS sp_arn, "
        f"SUM(savings_plan_net_savings_plan_effective_cost)/NULLIF(SUM(CAST(product_vcpu AS double)*line_item_usage_amount),0) AS per_vcpu_rate "
        f"FROM {e.table} WHERE {e.rate_window_filter()} AND line_item_line_item_type = 'SavingsPlanCoveredUsage' AND line_item_usage_type LIKE '%BoxUsage%' GROUP BY 1) "
        f"SELECT m.savings_plan_savings_plan_a_r_n AS sp_arn, m.bill_payer_account_id AS payer, m.line_item_usage_account_id AS account, "
        f"m.savings_plan_offering_type AS offering, "
        f"COALESCE(NULLIF(m.savings_plan_instance_type_family,''),'(Compute SP)') AS family, "
        f"COALESCE(NULLIF(m.savings_plan_region,''),'(any)') AS region, "
        f"m.savings_plan_payment_option AS payment, m.savings_plan_purchase_term AS term, "
        f"substr(m.savings_plan_start_time,1,10) AS start_date, substr(m.savings_plan_end_time,1,10) AS end_date, "
        f"date_diff('day', DATE '{m}-01', date(substr(MAX(m.savings_plan_end_time),1,10))) AS days_to_expire, "
        f"ROUND(MAX(m.savings_plan_total_commitment_to_date),4) AS hourly_commitment, "
        # 原始行是小时粒度：MAX(total)=时承诺，直接 /rate 即购买 vCPU（view 的 /24 是因为它的行是日聚合）
        f"ROUND(MAX(m.savings_plan_total_commitment_to_date)/NULLIF(MAX(v.per_vcpu_rate),0), 0) AS purchased_vcpu, "
        f"ROUND(SUM(m.savings_plan_used_commitment)/NULLIF(SUM(m.savings_plan_total_commitment_to_date),0)*100,2) AS utilization_pct, "
        f"ROUND(SUM(m.savings_plan_total_commitment_to_date - m.savings_plan_used_commitment),2) AS wasted_cost "
        f"FROM {e.table} m LEFT JOIN sp_vcpu v ON m.savings_plan_savings_plan_a_r_n = v.sp_arn "
        f"WHERE {tf.replace('year', 'm.year').replace('month', 'm.month') if 'year' in tf else tf} AND m.line_item_line_item_type = 'SavingsPlanRecurringFee'{cond.replace('savings_plan_', 'm.savings_plan_')} "
        f"GROUP BY 1,2,3,4,5,6,7,8,9,10 ORDER BY wasted_cost DESC LIMIT {top_n}"
    )
    return _ok(rows, "Instance SP rows carry an instance family and region (attributes of the SP contract); purchased_vcpu is derived from the unit price that SP actually covers (same formula as the dashboard); days_to_expire is measured from the 1st of the queried month; Compute SPs show up as (Compute SP)/(any)")


@server.tool(description="Savings Plan expiry distribution: measured from the as_of date (YYYY-MM-DD), buckets each SP by days remaining (<90 days / 90-180 days / >180 days) and lists the ones expiring within 90 days.")
def get_sp_expiry(month: str, as_of: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    as_of = _ident(as_of, r"^\d{4}-\d{2}-\d{2}$", "as_of")
    base = (
        f"SELECT savings_plan_savings_plan_a_r_n AS arn, bill_payer_account_id AS payer, line_item_usage_account_id AS account, "
        f"savings_plan_offering_type AS offering, "
        f"COALESCE(NULLIF(savings_plan_instance_type_family,''),'(Compute SP)') AS family, "
        f"COALESCE(NULLIF(savings_plan_region,''),'(any)') AS region, "
        f"savings_plan_payment_option AS payment, savings_plan_purchase_term AS term, "
        f"substr(MAX(savings_plan_start_time),1,10) AS start_date, substr(MAX(savings_plan_end_time),1,10) AS end_date, "
        f"ROUND(MAX(savings_plan_total_commitment_to_date),4) AS hourly_commitment, "
        f"ROUND(SUM(savings_plan_used_commitment)/NULLIF(SUM(savings_plan_total_commitment_to_date),0)*100,2) AS utilization_pct, "
        f"date_diff('day', DATE '{as_of}', date(substr(MAX(savings_plan_end_time),1,10))) AS days_left "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'SavingsPlanRecurringFee' "
        f"AND savings_plan_end_time <> '' GROUP BY 1,2,3,4,5,6,7,8"
    )
    dist = e.run(
        f"SELECT CASE WHEN days_left < 90 THEN '<90d' WHEN days_left <= 180 THEN '90-180d' ELSE '>180d' END AS bucket, "
        f"COUNT(*) AS sp_count FROM ({base}) WHERE days_left >= 0 GROUP BY 1 ORDER BY 1"
    )
    expiring = e.run(f"SELECT * FROM ({base}) WHERE days_left BETWEEN 0 AND 90 ORDER BY days_left LIMIT 50")
    return _ok({"distribution": dist, "expiring_within_90d": expiring}, f"as of {as_of}")


@server.tool(description="On-Demand Capacity Reservation utilisation for a month -- the only correct source on a cost basis. You MUST use this tool for any ODCR utilisation question; do NOT invent a formula from the instance counts in get_purchase_option_split. Returns a summary plus the lowest-utilisation detail rows (11 columns including payer, account, az and waste amount); granularity=daily returns a per-day committed/unused/utilisation trend. Optional filters: region (a code such as us-east-1), family (an instance family such as c5), az (such as us-east-1a) and account (a 12-digit account id). With dimension=region/family/account/az the results are grouped by that dimension (monthly mode only).")
def get_odcr_utilization(month: str, top_n: int = 10, granularity: str = "monthly",
                         region: str = "", family: str = "", az: str = "", account: str = "",
                         dimension: str = "") -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    top_n = max(1, min(int(top_n), 100))
    fcond, notes = "", []
    if region:
        reg = _ident(region, r"^[a-z0-9-]+$", "region")
        fcond += f" AND product_region = '{reg}'"
        notes.append(f"region={reg}")
    if family:
        fam = _ident(family, r"^[a-z0-9-]+$", "family")
        fcond += f" AND product_instance_type LIKE '{fam}.%'"
        notes.append(f"instance family={fam}")
    if az:
        az_ = _ident(az, r"^[a-z0-9-]+$", "az")
        fcond += f" AND product_availability_zone = '{az_}'"
        notes.append(f"az={az_}")
    if account:
        acct = _ident(account, r"^\d{12}$", "account")
        fcond += f" AND line_item_usage_account_id = '{acct}'"
        notes.append(f"account={acct}")
    scope = ("; scope: " + "、".join(notes)) if notes else ""
    odcr_where = (
        f"{tf} AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage') "
        f"AND product_capacitystatus IN ('AllocatedCapacityReservation','UnusedCapacityReservation') "
        f"AND line_item_line_item_description NOT LIKE '%Capacity Block%'{fcond}"
    )
    if granularity == "daily":
        daily = e.run(
            f"SELECT date_trunc('day', line_item_usage_start_date) AS usage_date, "
            f"ROUND(SUM(CASE WHEN product_capacitystatus = 'AllocatedCapacityReservation' THEN line_item_usage_amount ELSE 0 END)/24,2) AS committed_instances, "
            f"ROUND(SUM(CASE WHEN product_capacitystatus = 'UnusedCapacityReservation' THEN line_item_usage_amount ELSE 0 END)/24,2) AS unused_instances, "
            f"ROUND((1 - SUM(CASE WHEN product_capacitystatus = 'UnusedCapacityReservation' THEN line_item_usage_amount ELSE 0 END)/"
            f"NULLIF(SUM(CASE WHEN product_capacitystatus = 'AllocatedCapacityReservation' THEN line_item_usage_amount ELSE 0 END),0))*100,2) AS utilization_pct "
            f"FROM {e.table} WHERE {odcr_where} GROUP BY 1 ORDER BY 1"
        )
        daily, trimmed = _trim_open_days(daily)
        trim_note = f"; truncated the most recent {trimmed} days of not-yet-finalized data (CUR lags 48-72h, as of {_closed_cutoff()}）" if trimmed else ""
        return _ok({"daily": daily}, f"daily ODCR: committed/unused are in average instances for that day{scope}{trim_note}")
    if dimension:
        dim_cols = {"region": "product_region", "family": "split_part(product_instance_type, '.', 1)",
                    "account": "line_item_usage_account_id", "az": "product_availability_zone"}
        if dimension not in dim_cols:
            raise ValueError(f"dimension must be one of {'/'.join(dim_cols)}, got: {dimension}")
        rows = e.run(
            f"SELECT {dim_cols[dimension]} AS {dimension}, "
            f"ROUND(SUM(CASE WHEN product_capacitystatus = 'AllocatedCapacityReservation' THEN line_item_usage_amount ELSE 0 END)/24,2) AS committed_instance_days, "
            f"ROUND(SUM(CASE WHEN product_capacitystatus = 'UnusedCapacityReservation' THEN line_item_usage_amount ELSE 0 END)/24,2) AS unused_instance_days, "
            f"ROUND(SUM(CASE WHEN product_capacitystatus = 'UnusedCapacityReservation' THEN line_item_net_unblended_cost ELSE 0 END),2) AS wasted_cost, "
            f"ROUND((1 - SUM(CASE WHEN product_capacitystatus = 'UnusedCapacityReservation' THEN line_item_usage_amount ELSE 0 END)/"
            f"NULLIF(SUM(CASE WHEN product_capacitystatus = 'AllocatedCapacityReservation' THEN line_item_usage_amount ELSE 0 END),0))*100,2) AS utilization_pct "
            f"FROM {e.table} WHERE {odcr_where} GROUP BY 1 ORDER BY 3 DESC LIMIT {top_n}"
        )
        return _ok(rows, f"by {dimension} grouping; committed/unused are in instance-days, and the waste amount is the net cost of the Unused rows{scope}")
    cte = (
        f"WITH o AS (SELECT line_item_resource_id AS arn, bill_payer_account_id AS payer, line_item_usage_account_id AS account, "
        f"product_instance_type AS instance_type, product_region AS region, product_availability_zone AS az, "
        f"SUM(CASE WHEN product_capacitystatus = 'AllocatedCapacityReservation' THEN line_item_usage_amount ELSE 0 END)/24 AS committed, "
        f"SUM(CASE WHEN product_capacitystatus = 'UnusedCapacityReservation' THEN line_item_usage_amount ELSE 0 END)/24 AS unused, "
        f"SUM(CASE WHEN product_capacitystatus = 'UnusedCapacityReservation' THEN line_item_net_unblended_cost ELSE 0 END) AS wasted_cost, "
        f"MAX(TRY_CAST(product_vcpu AS integer)) AS vcpu_per_instance "
        f"FROM {e.table} WHERE {odcr_where} GROUP BY 1,2,3,4,5,6)"
    )
    summary = e.run(
        f"{cte} SELECT ROUND(SUM(committed),2) AS total_committed, ROUND(SUM(unused),2) AS total_unused, "
        f"ROUND((1 - SUM(unused)/NULLIF(SUM(committed),0))*100,2) AS utilization_pct, COUNT(DISTINCT arn) AS odcr_count FROM o"
    )
    worst = e.run(
        f"{cte} SELECT arn, payer, account, instance_type, region, az, ROUND(committed,2) AS committed_instance_days, "
        f"ROUND(unused,2) AS unused_instance_days, ROUND(wasted_cost,2) AS wasted_cost, vcpu_per_instance, "
        f"ROUND((1 - unused/NULLIF(committed,0))*100,2) AS utilization_pct FROM o WHERE committed > 0 ORDER BY 11 ASC LIMIT {top_n}"
    )
    return _ok({"summary": summary[0], "lowest_utilization": worst},
               "WARNING: committed/unused are in instance-days (usage_amount/24), NOT dollars -- do NOT put a $ sign in front of them. For ODCR amounts in dollars call get_purchase_option_split(detail=True). Capacity Blocks are excluded. Utilisation = 1-SUM(unused)/SUM(committed)")


# ══════════════════════ 服务深度拆分 ══════════════════════

_BREAKDOWN = {
    "s3": {
        "scope": "product_servicecode = 'AmazonS3'",
        "dim": """CASE
          WHEN line_item_usage_type LIKE '%TimedStorage%' OR line_item_usage_type LIKE '%StorageAnalytics-ObjCount%'
            OR line_item_usage_type LIKE '%StorageLens-ObjCount%' OR line_item_usage_type LIKE '%TagStorage%'
            OR line_item_usage_type LIKE '%Monitoring-Automation-INT%' THEN 'Storage'
          WHEN line_item_usage_type LIKE '%Requests%' OR line_item_usage_type LIKE '%Vectors-Request%' THEN 'Requests'
          WHEN line_item_usage_type LIKE '%Bytes%' THEN 'DataTransfer'
          WHEN line_item_usage_type LIKE '%Retrieval%' THEN 'Retrieval' ELSE 'Other' END""",
        "note": "scope=servicecode (do NOT use product_code -- it pulls in DataTransfer and Glacier rows)",
    },
    "ebs": {
        "scope": "line_item_product_code = 'AmazonEC2' AND product_product_family IN ('Storage','System Operation','Provisioned Throughput','Storage Snapshot','Fast Snapshot Restore')",
        "dim": """CASE
          WHEN line_item_usage_type LIKE '%VolumeUsage%' THEN 'Storage'
          WHEN line_item_usage_type LIKE '%VolumeP-IOPS%' THEN 'IOPS'
          WHEN line_item_usage_type LIKE '%VolumeP-Throughput%' THEN 'Throughput'
          WHEN line_item_usage_type LIKE '%Snapshot%' THEN 'Snapshot'
          WHEN line_item_usage_type LIKE '%VolumeIOUsage%' THEN 'IO'
          WHEN line_item_usage_type LIKE '%EBSOptimized%' THEN 'EBSOptimized' ELSE 'Other' END""",
        "note": "Snapshot includes Fast Snapshot Restore",
    },
    "elb": {
        "scope": "product_servicecode = 'AWSELB'",
        "dim": """CASE
          WHEN line_item_operation LIKE '%Network%' THEN 'NLB'
          WHEN line_item_operation LIKE '%Application%' THEN 'ALB'
          WHEN line_item_operation LIKE '%Gateway%' THEN 'GWLB'
          WHEN line_item_operation = 'LoadBalancing' THEN 'CLB' ELSE 'Other' END""",
        "note": "by load balancer type",
    },
    "datatransfer": {
        "scope": "product_servicecode = 'AWSDataTransfer'",
        "dim": """CASE
          WHEN line_item_usage_type LIKE '%DataTransfer-Out-Bytes%' THEN 'Internet-Out'
          WHEN line_item_usage_type LIKE '%DataTransfer-In-Bytes%' THEN 'Internet-In'
          WHEN line_item_usage_type LIKE '%DataTransfer-Regional-Bytes%' THEN 'InterAZ'
          WHEN line_item_usage_type LIKE '%AWS-Out-Bytes%' OR line_item_usage_type LIKE '%AWS-In-Bytes%'
            OR line_item_usage_type LIKE '%AWS-In-ABytes%' THEN 'InterRegion' ELSE 'Other' END""",
        "note": "DataTransfer-Out defaults to Internet-Out",
    },
    "dx": {
        "scope": "product_servicecode = 'AWSDirectConnect'",
        "dim": """CASE
          WHEN line_item_usage_type LIKE '%PortUsage%' AND line_item_usage_type NOT LIKE '%HCPort%' THEN 'Port-Dedicated'
          WHEN line_item_usage_type LIKE '%HCPortUsage%' THEN 'Port-Hosted'
          WHEN line_item_usage_type LIKE '%DataXfer-Out:dc%' THEN 'DataTransfer-Out'
          WHEN line_item_usage_type LIKE '%DataXfer-In:dc%' THEN 'DataTransfer-In'
          WHEN line_item_usage_type LIKE '%SiteLinkVifHour%' THEN 'SiteLink-VIF'
          WHEN line_item_usage_type LIKE '%SiteLink%' THEN 'SiteLink-DataTransfer' ELSE 'Other' END""",
        "note": "production dx_category basis",
    },
    "rds": {
        "scope": "line_item_product_code = 'AmazonRDS'",
        "dim": """CASE
          WHEN product_product_family = 'Database Instance' THEN 'Instance'
          WHEN product_product_family = 'ServerlessV2' THEN 'ServerlessV2'
          WHEN product_product_family = 'Database Storage' THEN 'Storage'
          WHEN product_product_family = 'Provisioned IOPS' THEN 'IOPS'
          WHEN product_product_family = 'Provisioned Throughput' THEN 'Throughput'
          WHEN product_product_family = 'Storage Snapshot' THEN 'Snapshot'
          WHEN product_product_family = 'System Operation' THEN 'Backup' ELSE 'Other' END""",
        "note": "by charge category",
    },
    "elasticache": {
        "scope": "line_item_product_code = 'AmazonElastiCache'",
        "dim": """CASE
          WHEN product_product_family = 'Cache Instance' THEN 'Instance'
          WHEN product_product_family = 'Storage Snapshot' THEN 'Snapshot'
          WHEN product_product_family = 'ElastiCache Serverless' THEN 'Serverless'
          WHEN product_product_family = 'Amazon ElastiCache Global Datastore' THEN 'GlobalDatastore'
          WHEN line_item_usage_type LIKE '%ExtendedSupport%' THEN 'ExtendedSupport' ELSE 'Other' END""",
        "note": "by charge category",
    },
    "natgateway": {
        "scope": "product_product_family = 'NAT Gateway'",
        "dim": """CASE
          WHEN line_item_usage_type LIKE '%RegionalNatGateway%' THEN 'Regional NGW'
          WHEN line_item_usage_type LIKE '%NatGateway-Bytes%' THEN 'DataProcessing'
          WHEN line_item_usage_type LIKE '%NatGateway-Hours%' THEN 'FixedHourly' ELSE 'Other' END""",
        "note": "by charge category",
    },
}


@server.tool(description="Within-service cost breakdown for a month. service: s3/ebs/elb/datatransfer/dx/rds/elasticache/natgateway. Splits by charge category by default; use dimension=usage_type/operation/account for a different axis (for example S3 by Operation/API, or NAT by usage_type).")
def get_service_breakdown(month: str, service: str, dimension: str = "") -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    if service not in _BREAKDOWN:
        raise ValueError(f"service must be one of {'/'.join(_BREAKDOWN)}, got: {service}")
    cfg = _BREAKDOWN[service]
    # dimension 覆盖默认拆分维度：usage_type / operation / account（#6 S3 Operation、#7 usage_type 拆分）
    dim_map = {"usage_type": "line_item_usage_type", "operation": "line_item_operation", "account": "line_item_usage_account_id"}
    dim_expr = dim_map.get(dimension) or cfg['dim']
    rows = e.run(
        f"SELECT {dim_expr} AS category, ROUND(SUM(line_item_net_unblended_cost),2) AS cost, "
        f"ROUND(SUM(line_item_net_unblended_cost) * 100.0 / SUM(SUM(line_item_net_unblended_cost)) OVER (), 2) AS pct "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} AND {cfg['scope']} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30"
    )
    return _ok(rows, cfg["note"] + "; excludes Tax/Credit/Refund. pct is a percentage computed by SQL -- quote it as-is and do NOT recompute it")


@server.tool(description="S3 stored volume on one day (PiB, a single-day snapshot). Pass date as YYYY-MM-DD; optional dimension to split by (account/region/storage_class). SmallFiles rows are excluded.")
def get_s3_storage(date: str, dimension: str = "") -> str:
    e = env()
    date = _ident(date, r"^\d{4}-\d{2}-\d{2}$", "date")
    month = date[:7]
    tf = e.time_filter(month)
    days = _days_in(month)
    base_where = (f"{tf} AND product_servicecode = 'AmazonS3' "
                  f"AND line_item_usage_type LIKE '%TimedStorage%' AND line_item_usage_type NOT LIKE '%SmallFiles%' "
                  f"AND line_item_line_item_type = 'Usage' "
                  f"AND date_trunc('day', line_item_usage_start_date) = TIMESTAMP '{date} 00:00:00'")
    if dimension:
        dims = {
            "account": "line_item_usage_account_id",
            "region": "COALESCE(NULLIF(product_region,''),'(global)')",
            "storage_class": """CASE
              WHEN line_item_usage_type LIKE '%TimedStorage-INT-FA%' THEN 'Intelligent-Tiering (FA)'
              WHEN line_item_usage_type LIKE '%TimedStorage-INT-IA%' THEN 'Intelligent-Tiering (IA)'
              WHEN line_item_usage_type LIKE '%TimedStorage-INT-AIA%' THEN 'Intelligent-Tiering (Archive)'
              WHEN line_item_usage_type LIKE '%GDA%' THEN 'Glacier Deep Archive'
              WHEN line_item_usage_type LIKE '%Glacier%' THEN 'Glacier'
              WHEN line_item_usage_type LIKE '%IA%' THEN 'Standard-IA'
              WHEN line_item_usage_type LIKE '%OneZone%' THEN 'One Zone-IA'
              ELSE 'Standard' END""",
            "usage_type": "line_item_usage_type",
        }
        if dimension not in dims:
            raise ValueError(f"dimension must be one of {'/'.join(dims)}, got: {dimension}")
        rows = e.run(f"SELECT {dims[dimension]} AS {dimension}, ROUND(SUM(line_item_usage_amount) * {days} / 1048576.0, 2) AS storage_pib "
                     f"FROM {e.table} WHERE {base_where} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 20")
        return _ok(rows, f"single-day snapshot {date} by {dimension} split, top 20; factor={days}")
    rows = e.run(f"SELECT ROUND(SUM(line_item_usage_amount) * {days} / 1048576.0, 2) AS storage_pib FROM {e.table} WHERE {base_where}")
    return _ok(rows[0], f"single-day snapshot {date}; scope=servicecode; factor={days} (days in that month)")


@server.tool(description="Direct Connect port inventory (count, port-hours and cost), filterable by region and port_speed, with by_location to group by point of presence. Pass month_to for a per-month trend (port count, nominal total bandwidth in Tbps, and cost); dimension=account/location/region splits it further.")
def get_dx_ports(month: str, region: str = "", port_speed: str = "", by_location: bool = False,
                 month_to: str = "", dimension: str = "") -> str:
    e = env()
    base_where = ["product_servicecode = 'AWSDirectConnect'", "line_item_line_item_type = 'Usage'", "line_item_operation = 'CreateDirectConnectPort'"]
    if region:
        base_where.append(f"product_region = '{_ident(region, r'^[a-z0-9-]+$', 'region')}'")
    if port_speed:
        base_where.append(f"product_port_speed = '{_ident(port_speed, r'^[A-Za-z0-9. -]+$', 'port_speed')}'")

    if month_to:
        # 多月趋势（端口数/标称带宽合计/费用），可选 dimension=account/location/region 再拆
        m_from, m_to = _check_month(month), _check_month(month_to)
        if e.partition_style == "year-month":
            parts, (y, mm) = [], map(int, m_from.split("-"))
            y, mm = int(m_from[:4]), int(m_from[5:7])
            while f"{y}-{mm:02d}" <= m_to:
                parts.append(f"(year='{y}' AND month='{mm:02d}')")
                mm += 1
                if mm > 12:
                    y, mm = y + 1, 1
            tf_range = "(" + " OR ".join(parts) + ")"
        elif e.partition_style == "billing-period":
            tf_range = f"billing_period >= '{m_from}' AND billing_period <= '{m_to}'"
        else:
            tf_range = (f"bill_billing_period_start_date >= TIMESTAMP '{m_from}-01 00:00:00' "
                        f"AND bill_billing_period_start_date <= TIMESTAMP '{m_to}-01 00:00:00'")
        dim_col = {"account": "line_item_usage_account_id", "location": "product_location", "region": "product_region"}.get(dimension, "")
        sel_dim = f"{dim_col} AS {dimension}, " if dim_col else ""
        grp = "1,2" if dim_col else "1"
        # 每端口取一次标称速率（去重），再按月合计——port 行数是小时数，直接 SUM 会放大
        rows = e.run(
            f"WITH p AS (SELECT substr(CAST(bill_billing_period_start_date AS varchar),1,7) AS month, "
            f"{sel_dim}line_item_resource_id AS port_id, "
            f"MAX(TRY_CAST(regexp_extract(product_port_speed, '([0-9.]+)G', 1) AS double)) AS bw_g, "
            f"SUM(line_item_net_unblended_cost) AS cost "
            f"FROM {e.table} WHERE {tf_range} AND {' AND '.join(base_where)} GROUP BY {grp},{'3' if dim_col else '2'}) "
            f"SELECT month, {dimension + ', ' if dim_col else ''}COUNT(*) AS ports, "
            f"ROUND(SUM(bw_g)/1000.0, 2) AS total_bandwidth_tbps, ROUND(SUM(cost),2) AS cost "
            f"FROM p GROUP BY {grp} ORDER BY 1"
        )
        return _ok(rows, "per-month Direct Connect trend; total_bandwidth_tbps is the sum of the nominal speeds of the deduplicated ports (Tbps), and HC- hosted ports are counted at their nominal speed")

    tf = e.time_filter(_check_month(month))
    group_col = "product_location" if by_location else "product_region"
    group_alias = "location" if by_location else "region"
    rows = e.run(
        f"SELECT {group_col} AS {group_alias}, product_port_speed AS port_speed, COUNT(DISTINCT line_item_resource_id) AS ports, "
        f"ROUND(SUM(line_item_usage_amount),2) AS port_hours, ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND {' AND '.join(base_where)} GROUP BY 1,2 ORDER BY 5 DESC"
    )
    return _ok(rows, "port basis: Usage + CreateDirectConnectPort; port_speed looks like 100G, 400G or HC-5G")


# ══════════════════════ 账务 ══════════════════════

@server.tool(description="Credit/Refund/Tax summary and detail for a month. kind: credit/refund/tax/all.")
def get_adjustments(month: str = "", kind: str = "all", granularity: str = "monthly",
                    date_from: str = "", date_to: str = "") -> str:
    e = env()
    # date_from/date_to 传入时精确到天（仪表盘 date-range 筛选）；否则按整月账期
    tf = _day_range_filter(e, date_from, date_to) if (date_from and date_to) else e.billing_filter(_check_month(month))
    kinds = {"credit": "('Credit')", "refund": "('Refund')", "tax": "('Tax')", "all": "('Credit','Refund','Tax')"}
    if kind not in kinds:
        raise ValueError(f"kind must be one of credit/refund/tax/all, got: {kind}")
    if granularity == "daily":
        daily = e.run(
            f"SELECT substr(CAST(date_trunc('day', line_item_usage_start_date) AS varchar),1,10) AS d, "
            f"{S.FINAL_SERVICE} AS svc, ROUND(SUM(line_item_net_unblended_cost),2) AS amount "
            f"FROM {e.table} WHERE {tf} AND line_item_line_item_type IN {kinds[kind]} "
            f"GROUP BY 1,2 ORDER BY 1"
        )
        return _ok({"daily_by_service": daily}, "by day x service (same shape as the QuickSight credit chart); this query applies no default exclusions")
    summary = e.run(
        f"SELECT line_item_line_item_type AS type, ROUND(SUM(line_item_net_unblended_cost),2) AS amount "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type IN {kinds[kind]} GROUP BY 1"
    )
    detail = e.run(
        f"SELECT line_item_line_item_type AS type, bill_payer_account_id AS payer, line_item_usage_account_id AS account, "
        f"substr(CAST(MIN(line_item_usage_start_date) AS varchar),1,10) AS usage_date, "
        f"line_item_line_item_description AS description, ROUND(SUM(line_item_net_unblended_cost),2) AS amount "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type IN {kinds[kind]} "
        f"GROUP BY 1,2,3,5 ORDER BY ABS(SUM(line_item_net_unblended_cost)) DESC LIMIT 30"
    )
    count = e.run(
        f"SELECT COUNT(DISTINCT line_item_line_item_description) AS distinct_items "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type IN {kinds[kind]}"
    )
    return _ok({"summary": summary, "details_top30": detail, "distinct_items": count[0]["distinct_items"]},
               "the detail rows are the top 30 by absolute amount; see distinct_items for the total number of line items. This query applies no default exclusions")


@server.tool(description="Total EDP discount for a month (list-price unblended basis -- on a net basis the EdpDiscount rows are always 0, which is normal). Split by payer.")
def get_edp_discount(month: str) -> str:
    e = env()
    tf = e.billing_filter(_check_month(month))
    total = e.run(f"SELECT ROUND(SUM(line_item_unblended_cost),2) AS edp_discount FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'EdpDiscount'")
    by_payer = e.run(
        f"SELECT bill_payer_account_id AS payer, ROUND(SUM(line_item_unblended_cost),2) AS edp_discount "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'EdpDiscount' GROUP BY 1 ORDER BY 2"
    )
    return _ok({"total": total[0]["edp_discount"], "by_payer": by_payer}, "list-price unblended basis (the EDP discount is already baked into the net price, so on a net basis this is always 0)")


@server.tool(description="Invoice reconciliation table for a month: net amount by payer x charge_type x currency (all charge types included, so the total approximates the invoice).")
def get_invoice_summary(month: str) -> str:
    e = env()
    tf = e.billing_filter(_check_month(month))
    rows = e.run(
        f"SELECT bill_payer_account_id AS payer, line_item_line_item_type AS charge_type, line_item_currency_code AS currency, "
        f"ROUND(SUM(line_item_net_unblended_cost),2) AS net_cost "
        f"FROM {e.table} WHERE {tf} GROUP BY 1,2,3 ORDER BY 1,2"
    )
    return _ok(rows, "includes every charge_type (Tax/Credit/Refund among them), so the total approximates the invoice. The three Savings Plan rows offsetting each other is normal")


@server.tool(description="Top N Marketplace charges for a month (by product name, billing_entity='AWS Marketplace').")
def get_marketplace_cost(month: str, top_n: int = 10) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    top_n = max(1, min(int(top_n), 50))
    rows = e.run(
        f"SELECT product_product_name AS product, ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} AND bill_billing_entity = 'AWS Marketplace' "
        f"GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT {top_n}"
    )
    return _ok(rows, "grouped by product_name (product_family is usually empty on Marketplace rows)")


@server.tool(description="Top N Bedrock models by cost for a month (including models billed through Marketplace, such as Claude and GPT).")
def get_bedrock_cost(month: str, top_n: int = 10) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    top_n = max(1, min(int(top_n), 50))
    rows = e.run(
        f"SELECT {S.INNER_SERVICE} AS model_or_service, ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} "
        f"AND (product_product_name LIKE '%Bedrock%' OR line_item_product_code LIKE '%Bedrock%' OR product_product_name LIKE '%Claude%') "
        f"GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT {top_n}"
    )
    return _ok(rows)


@server.tool(description=f"Cost for a month split by a user tag. tag_key must be one of the keys configured for this deployment: {'/'.join(TAG_KEYS) or '(none: this deployment has no CUR_TAG_KEYS configured)'}. metric: cost, instances (average daily instance count), vcpu or gpu.")
def get_tag_cost(month: str, tag_key: str, top_n: int = 20, metric: str = "cost") -> str:
    # ⚠️ 上游这里收的是**任意** `resource_tags_*` 列名并直接拼进 SQL。两个问题：
    #   ① 注入面 —— 白名单只挡字符集，挡不住"这一列根本不存在"；
    #   ② CUR 2.0 下 tag 压根不是独立列而是 map，传列名必然查不到（上游的
    #      `columns.tag_col()` 本来是为此写的，但从没被调用过，是死代码）。
    # 改成只接受 `CUR_TAG_KEYS` 声明过的 key，表达式由 columns.tag_dimensions() 出。
    e = env()
    tf = e.time_filter(_check_month(month))
    days = _days_in(month)
    if not TAG_KEYS:
        raise ValueError("this deployment has no CUR_TAG_KEYS configured; tag split is unavailable")
    if tag_key not in TAG_KEYS:
        raise ValueError(f"tag_key must be one of {'/'.join(TAG_KEYS)}, got: {tag_key}")
    col = _TAG_DIMS[f"tag_{tag_key}"]
    top_n = max(1, min(int(top_n), 100))
    metrics = {
        "cost": (f"ROUND(SUM(line_item_net_unblended_cost),2)", S.NOT_TCR, "cost (net_unblended)"),
        "instances": (f"ROUND(SUM(line_item_usage_amount)/24/{days},2)", S.COUNT_ROWS_FILTER, "average daily instance count"),
        "vcpu": (f"ROUND(SUM(line_item_usage_amount * TRY_CAST(product_vcpu AS double))/24/{days},2)", S.COUNT_ROWS_FILTER, "average daily vCPU"),
        "gpu": (f"ROUND(SUM(CASE WHEN TRY_CAST(product_gpu AS double) IS NOT NULL THEN line_item_usage_amount * TRY_CAST(product_gpu AS double) ELSE 0 END)/24/{days},2)", S.COUNT_ROWS_FILTER, "average daily GPU count"),
    }
    if metric not in metrics:
        raise ValueError(f"metric must be one of {'/'.join(metrics)}, got: {metric}")
    expr, cond, label = metrics[metric]
    rows = e.run(
        f"SELECT {col} AS tag_value, {expr} AS {metric} "
        f"FROM {e.table} WHERE {tf} AND {cond} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT {top_n}"
    )
    return _ok(rows, label)


# ══════════════════════ RI / Capacity Blocks ══════════════════════

@server.tool(description="Reserved Instance detail for a month (non-EC2 RIs: RDS, ElastiCache, Redshift and so on): ARN, instance type, region, term and unused fee, ordered by unused_fee. Includes the total RI count.")
def get_ri_details(month: str, top_n: int = 20) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    top_n = max(1, min(int(top_n), 100))
    rows = e.run(
        f"SELECT reservation_reservation_a_r_n AS ri_arn, line_item_product_code AS service, "
        f"COALESCE(product_instance_type,'') AS instance_type, product_region AS region, pricing_lease_contract_length AS term, "
        f"pricing_offering_class AS offering, pricing_purchase_option AS payment, "
        f"reservation_start_time, reservation_end_time, reservation_number_of_reservations AS ri_count, "
        f"ROUND(SUM(reservation_unused_recurring_fee),2) AS unused_fee "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'RIFee' "
        f"GROUP BY 1,2,3,4,5,6,7,8,9,10 ORDER BY 11 DESC LIMIT {top_n}"
    )
    count = e.run(
        f"SELECT COUNT(DISTINCT reservation_reservation_a_r_n) AS total_ri "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'RIFee'"
    )
    return _ok({"total_ri": count[0]["total_ri"], "details": rows}, "based on the RIFee rows; the detail is the top N by unused_fee")


@server.tool(description="Reserved Instance coverage for one service in a month (by usage hours). service: rds/elasticache/memorydb/redshift. This computes coverage only -- utilisation requires Cost Explorer.")
def get_ri_coverage(month: str, service: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    svc = {
        "rds": ("AmazonRDS", "(line_item_usage_type LIKE '%InstanceUsage%' OR line_item_usage_type LIKE '%Multi-AZUsage%')"),
        "elasticache": ("AmazonElastiCache", "line_item_usage_type LIKE '%NodeUsage%'"),
        "memorydb": ("AmazonMemoryDB", "line_item_usage_type LIKE '%NodeUsage%'"),
        "redshift": ("AmazonRedshift", "line_item_usage_type LIKE '%Node:%'"),
    }
    if service not in svc:
        raise ValueError(f"service must be one of {'/'.join(svc)}, got: {service}")
    code, usage = svc[service]
    rows = e.run(
        f"SELECT ROUND(SUM(CASE WHEN line_item_line_item_type = 'DiscountedUsage' THEN line_item_usage_amount ELSE 0 END) / "
        f"NULLIF(SUM(CASE WHEN line_item_line_item_type IN ('DiscountedUsage','Usage') THEN line_item_usage_amount ELSE 0 END),0)*100, 2) AS ri_coverage_pct, "
        f"ROUND(SUM(CASE WHEN line_item_line_item_type = 'DiscountedUsage' THEN line_item_usage_amount ELSE 0 END),2) AS ri_covered_hours, "
        f"ROUND(SUM(CASE WHEN line_item_line_item_type IN ('DiscountedUsage','Usage') THEN line_item_usage_amount ELSE 0 END),2) AS total_hours "
        f"FROM {e.table} WHERE {tf} AND line_item_product_code = '{code}' AND {usage}"
    )
    return _ok(rows[0], f"{code} usage-hour basis; coverage only -- for utilisation use the Cost Explorer RI Utilization Report")


@server.tool(description="Capacity Block detail on a month's bill: usage window start and end, instance count, vCPU, GPU and cost (billing_period basis).")
def get_capacity_blocks(month: str) -> str:
    e = env()
    bf = e.billing_filter(_check_month(month))
    rows = e.run(
        f"SELECT reservation_reservation_a_r_n AS cb_arn, product_instance_type AS instance_type, product_region AS region, "
        f"bill_payer_account_id AS payer, line_item_usage_account_id AS account_id, "
        f"concat(substr(identity_time_interval,1,10),' ',substr(identity_time_interval,12,5)) AS cb_start, "
        f"concat(substr(identity_time_interval,22,10),' ',substr(identity_time_interval,33,5)) AS cb_end, "
        f"TRY_CAST(reservation_number_of_reservations AS integer) AS instance_count, "
        f"TRY_CAST(reservation_number_of_reservations AS integer) * CASE product_instance_type "
        f"WHEN 'p4d.24xlarge' THEN 96 WHEN 'p4de.24xlarge' THEN 96 WHEN 'trn1.32xlarge' THEN 128 ELSE 192 END AS vcpu_count, "
        f"TRY_CAST(reservation_number_of_reservations AS integer) * CASE product_instance_type "
        f"WHEN 'trn1.32xlarge' THEN 16 WHEN 'trn2.48xlarge' THEN 16 ELSE 8 END AS gpu_count, "
        f"ROUND(SUM(line_item_net_unblended_cost),2) AS cb_fee "
        f"FROM {e.table} WHERE {bf} AND line_item_line_item_type = 'Fee' AND line_item_usage_type LIKE '%CapacityBlockFee%' "
        f"GROUP BY 1,2,3,4,5,6,7,8,9,10 ORDER BY 11 DESC"
    )
    total = e.run(
        f"SELECT ROUND(SUM(line_item_net_unblended_cost),2) AS total_fee, COUNT(DISTINCT reservation_reservation_a_r_n) AS cb_count "
        f"FROM {e.table} WHERE {bf} AND line_item_line_item_type = 'Fee' AND line_item_usage_type LIKE '%CapacityBlockFee%'"
    )
    return _ok({"total_fee": total[0]["total_fee"], "cb_count": total[0]["cb_count"], "details": rows},
               "billing_period basis (a Capacity Block is prepaid and lands on the bill for the month it was purchased, while its usage window may span months). Use total_fee for the total (straight from SQL) -- do NOT sum the detail rows yourself. vCPU/GPU come from a per-instance-type constant table, because the native columns are empty on CB Fee rows")


# ══════════════════════ vCPU 版指标 ══════════════════════

@server.tool(description="Savings Plan coverage for a month on a vCPU basis (numerator/denominator = SP-covered vCPU hours / (SP + pure on-demand) vCPU hours, including UnusedBox).")
def get_sp_coverage_vcpu(month: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    rows = e.run(
        f"SELECT ROUND(SUM(CASE WHEN (line_item_usage_type LIKE '%BoxUsage%' OR line_item_usage_type LIKE '%UnusedBox%') "
        f"AND COALESCE(savings_plan_savings_plan_a_r_n,'') <> '' THEN line_item_usage_amount * TRY_CAST(product_vcpu AS double) ELSE 0 END) / "
        f"NULLIF(SUM(CASE WHEN (line_item_usage_type LIKE '%BoxUsage%' OR line_item_usage_type LIKE '%UnusedBox%') "
        f"AND (COALESCE(savings_plan_savings_plan_a_r_n,'') <> '' OR (COALESCE(reservation_reservation_a_r_n,'') = '' AND line_item_usage_type NOT LIKE '%Spot%')) "
        f"THEN line_item_usage_amount * TRY_CAST(product_vcpu AS double) ELSE 0 END),0) * 100, 2) AS sp_coverage_vcpu_pct "
        f"FROM {e.table} WHERE {tf} AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage')"
    )
    return _ok(rows[0], "vCPU-hour basis; denominator = SP-covered + pure on-demand (including idle ODCR rows). This means something different from the cost-basis coverage in get_sp_coverage")


# ══════════════════════ 存储/资源深拆 ══════════════════════

@server.tool(description="S3 cost for a month split by storage class (Standard, IA, Glacier, Intelligent-Tiering, GDA and so on).")
def get_s3_storage_class_split(month: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    rows = e.run(
        f"SELECT CASE "
        f"WHEN line_item_usage_type LIKE '%TimedStorage-INT-FA%' THEN 'Intelligent-Tiering (FA)' "
        f"WHEN line_item_usage_type LIKE '%TimedStorage-INT-IA%' THEN 'Intelligent-Tiering (IA)' "
        f"WHEN line_item_usage_type LIKE '%TimedStorage-INT-AIA%' THEN 'Intelligent-Tiering (Archive)' "
        f"WHEN line_item_usage_type LIKE '%GDA%' OR line_item_usage_type LIKE '%GlacierStaging%' THEN 'Glacier Deep Archive' "
        f"WHEN line_item_usage_type LIKE '%Glacier%' THEN 'Glacier' "
        f"WHEN line_item_usage_type LIKE '%IA%' THEN 'Standard-IA' "
        f"WHEN line_item_usage_type LIKE '%RRS%' THEN 'Reduced Redundancy' "
        f"WHEN line_item_usage_type LIKE '%OneZone%' THEN 'One Zone-IA' "
        f"ELSE 'Standard' END AS storage_class, "
        f"ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND product_servicecode = 'AmazonS3' AND {S.NOT_TCR} "
        f"GROUP BY 1 ORDER BY 2 DESC"
    )
    return _ok(rows, "every S3 cost row is classified into a storage class (request and DataTransfer rows fall into whichever class their usage_type matches, with Standard as the fallback)")


@server.tool(description="EBS cost for a month split by volume type (gp3/gp2/io1/io2/st1/sc1/standard).")
def get_ebs_volume_type_split(month: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    rows = e.run(
        f"SELECT CASE "
        f"WHEN line_item_usage_type LIKE '%.gp3%' OR line_item_operation LIKE '%Gp3%' THEN 'gp3' "
        f"WHEN line_item_usage_type LIKE '%.gp2%' OR line_item_operation LIKE '%Gp2%' THEN 'gp2' "
        f"WHEN line_item_usage_type LIKE '%.st1%' OR line_item_operation LIKE '%St1%' THEN 'st1' "
        f"WHEN line_item_usage_type LIKE '%.io2%' OR line_item_operation LIKE '%Io2%' THEN 'io2' "
        f"WHEN line_item_usage_type LIKE '%.io1%' OR line_item_operation LIKE '%Io1%' THEN 'io1' "
        f"WHEN line_item_usage_type LIKE '%.sc1%' OR line_item_operation LIKE '%Sc1%' THEN 'sc1' "
        f"WHEN line_item_usage_type LIKE '%.standard%' OR line_item_operation LIKE '%Standard%' THEN 'standard' "
        f"ELSE 'Other' END AS volume_type, "
        f"ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} "
        f"AND line_item_product_code = 'AmazonEC2' "
        f"AND product_product_family IN ('Storage','System Operation','Provisioned Throughput','Storage Snapshot','Fast Snapshot Restore') "
        f"GROUP BY 1 ORDER BY 2 DESC"
    )
    return _ok(rows, "EBS scope=product_family across five categories (same basis as final_service='AmazonEBS'); non-volume rows such as Snapshot fall into Other")


@server.tool(description=f"EBS stored volume on one day (GiB/PiB) and the number of volumes. dimension splits by account/region/volume_type{_TAG_HINT}。")
def get_ebs_storage(date: str, dimension: str = "") -> str:
    e = env()
    date = _ident(date, r"^\d{4}-\d{2}-\d{2}$", "date")
    month = date[:7]
    tf = e.time_filter(month)
    days = _days_in(month)
    base_where = (f"{tf} AND line_item_product_code = 'AmazonEC2' "
                  f"AND line_item_usage_type LIKE '%VolumeUsage%' AND line_item_line_item_type = 'Usage' "
                  f"AND date_trunc('day', line_item_usage_start_date) = TIMESTAMP '{date} 00:00:00'")
    sel = (f"ROUND(SUM(line_item_usage_amount) * {days} / 1048576.0, 2) AS storage_pib, "
           f"approx_distinct(line_item_resource_id) AS volume_count")
    if dimension:
        dims = {
            "account": "line_item_usage_account_id",
            "region": "COALESCE(NULLIF(product_region,''),'(global)')",
            **_TAG_DIMS,
            "volume_type": """CASE
              WHEN line_item_usage_type LIKE '%.gp3%' THEN 'gp3' WHEN line_item_usage_type LIKE '%.gp2%' THEN 'gp2'
              WHEN line_item_usage_type LIKE '%.st1%' THEN 'st1' WHEN line_item_usage_type LIKE '%.io2%' THEN 'io2'
              WHEN line_item_usage_type LIKE '%.io1%' THEN 'io1' WHEN line_item_usage_type LIKE '%.sc1%' THEN 'sc1'
              WHEN line_item_usage_type LIKE '%.standard%' THEN 'standard' ELSE 'Other' END""",
        }
        if dimension not in dims:
            raise ValueError(f"dimension must be one of {'/'.join(dims)}, got: {dimension}")
        rows = e.run(f"SELECT {dims[dimension]} AS {dimension}, {sel} FROM {e.table} WHERE {base_where} "
                     f"GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 20")
        return _ok(rows, f"single-day snapshot {date} by {dimension} split, top 20; scaling factor={days}; volume count via approx_distinct")
    rows = e.run(f"SELECT ROUND(SUM(line_item_usage_amount) * {days}, 0) AS storage_gib, {sel} FROM {e.table} WHERE {base_where}")
    return _ok(rows[0], f"single-day snapshot {date}; scaling factor={days} (days in that month); the volume count uses approx_distinct (error under 2%)")


@server.tool(description="Average daily resource count for a month. service: elb/rds/elasticache/natgateway. dimension=instance_type splits by instance type (RDS/ElastiCache). Pass month_to for a per-month trend, or daily_trend for a per-day one.")
def get_resource_count(month: str, service: str, daily_trend: bool = False,
                       month_to: str = "", dimension: str = "") -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    days = _days_in(month)
    if service == "rds":
        day_expr = (
            "ROUND(SUM(CASE WHEN line_item_usage_type LIKE '%InstanceUsage%' OR line_item_usage_type LIKE '%Multi-AZUsage%' "
            "OR line_item_usage_type LIKE '%MirrorUsage%' THEN line_item_usage_amount ELSE 0 END)/24 "
            "+ COUNT(DISTINCT CASE WHEN product_product_family = 'ServerlessV2' OR line_item_usage_type LIKE '%Multi-AZClusterUsage%' "
            "THEN line_item_resource_id END), 1)"
        )
        scope = "line_item_product_code = 'AmazonRDS' AND line_item_line_item_type IN ('Usage','DiscountedUsage')"
        note = "RDS is counted across five shapes (plain, Multi-AZ and Mirror by hours/24; Cluster and ServerlessV2 by distinct resources)"
    else:
        recipes = {
            "elb": ("line_item_usage_type LIKE '%LoadBalancerUsage%' AND line_item_line_item_type = 'Usage'", "based on the ELB fixed-hourly rows (LCU and discount rows excluded)"),
            "elasticache": ("line_item_usage_type LIKE '%NodeUsage%' AND line_item_product_code = 'AmazonElastiCache' AND line_item_line_item_type IN ('Usage','DiscountedUsage')", "based on NodeUsage (includes RI nodes)"),
            "natgateway": ("line_item_usage_type LIKE '%NatGateway-Hours%' AND line_item_line_item_type = 'Usage'", "based on NatGateway-Hours (Bytes rows excluded)"),
        }
        if service not in recipes:
            raise ValueError(f"service must be one of elb/rds/elasticache/natgateway, got: {service}")
        scope, note = recipes[service]
        day_expr = "ROUND(SUM(line_item_usage_amount)/24, 1)"
    # #10 按机型拆分（RDS/ElastiCache 实例数-Instance Type 图）
    if dimension == "instance_type":
        rows = e.run(
            f"SELECT product_instance_type AS instance_type, {day_expr.replace('/24', '/24/' + str(days))} AS avg_daily_count "
            f"FROM {e.table} WHERE {tf} AND {scope} AND product_instance_type <> '' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30"
        )
        return _ok(rows, f"{note}; daily average = month total / {days} days")
    # #9 多月趋势
    if month_to:
        m_from, m_to = _check_month(month), _check_month(month_to)
        if e.partition_style == "year-month":
            parts = []
            y, mm = int(m_from[:4]), int(m_from[5:7])
            while f"{y}-{mm:02d}" <= m_to:
                parts.append(f"(year='{y}' AND month='{mm:02d}')")
                mm += 1
                if mm > 12:
                    y, mm = y + 1, 1
            tf_range = "(" + " OR ".join(parts) + ")"
        elif e.partition_style == "billing-period":
            tf_range = f"billing_period >= '{m_from}' AND billing_period <= '{m_to}'"
        else:
            tf_range = (f"bill_billing_period_start_date >= TIMESTAMP '{m_from}-01 00:00:00' "
                        f"AND bill_billing_period_start_date <= TIMESTAMP '{m_to}-01 00:00:00'")
        rows = e.run(
            f"SELECT substr(CAST(bill_billing_period_start_date AS varchar),1,7) AS month, "
            f"{day_expr.replace('/24', '/24/day(last_day_of_month(MIN(bill_billing_period_start_date)))')} AS avg_daily_count "
            f"FROM {e.table} WHERE {tf_range} AND {scope} GROUP BY 1 ORDER BY 1"
        )
        return _ok(rows, f"{note}; per-month daily averages (each month divided by its own calendar days)")
    daily = e.run(
        f"SELECT date_trunc('day', line_item_usage_start_date) AS usage_date, {day_expr} AS count_day "
        f"FROM {e.table} WHERE {tf} AND {scope} GROUP BY 1 ORDER BY 1"
    )
    data_days = len(daily)  # 未完月只按有数据的天数算日均，避免分母虚大
    avg = round(sum(float(r["count_day"]) for r in daily) / min(days, data_days), 1) if daily else 0
    out = {"avg_daily_count": avg, "latest_day": daily[-1] if daily else None}
    if daily_trend:
        out["daily"] = daily
    return _ok(out, f"{note}; daily-average denominator={min(days, data_days) if daily else 0} (for an incomplete month, divided by the days of data actually present)")


@server.tool(description="RDS/ElastiCache cost for a month split by engine. service: rds/elasticache.")
def get_engine_split(month: str, service: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    cfg = {
        "rds": ("AmazonRDS", "product_database_engine"),
        "elasticache": ("AmazonElastiCache", "product_cache_engine"),
    }
    if service not in cfg:
        raise ValueError(f"service must be one of rds/elasticache, got: {service}")
    code, col = cfg[service]
    rows = e.run(
        f"SELECT COALESCE(NULLIF({col},''),'(none)') AS engine, ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} AND line_item_product_code = '{code}' "
        f"GROUP BY 1 ORDER BY 2 DESC"
    )
    return _ok(rows, f"{code} by {col} grouping; (none) means rows with no engine label, such as storage and snapshots. For SQL Server edition detail use product_database_edition")


# ══════════════════════ 账务补充 / 日度对比 ══════════════════════

@server.tool(description="Identify new accounts by each account's first billing period (full table scan). Pass month as YYYY-MM to see only the accounts added that month, or an empty string for the 50 most recently seen.")
def get_new_accounts(month: str = "") -> str:
    e = env()
    inner = (
        f"SELECT line_item_usage_account_id AS account, "
        f"date_format(MIN(bill_billing_period_start_date), '%Y-%m') AS first_bill "
        f"FROM {e.table} GROUP BY 1"
    )
    if month:
        _check_month(month)
        rows = e.run(f"SELECT account, first_bill FROM ({inner}) WHERE first_bill = '{month}' ORDER BY account")
    else:
        rows = e.run(f"SELECT account, first_bill FROM ({inner}) ORDER BY first_bill DESC LIMIT 50")
    return _ok(rows, "first billing period = the earliest billing_period for that account in this table. This is limited by how far back the table goes: accounts present in the table's first month cannot be confirmed as genuinely new")


@server.tool(description="Compare two days: the top N deltas by final_service (the data layer for daily attribution). Pass date_a and date_b as YYYY-MM-DD.")
def get_day_comparison(date_a: str, date_b: str, top_n: int = 10) -> str:
    e = env()
    date_a = _ident(date_a, r"^\d{4}-\d{2}-\d{2}$", "date_a")
    date_b = _ident(date_b, r"^\d{4}-\d{2}-\d{2}$", "date_b")
    top_n = max(1, min(int(top_n), 50))
    months = {date_a[:7], date_b[:7]}
    tf = " OR ".join(f"({e.time_filter(m)})" for m in sorted(months))
    da = f"date_trunc('day', line_item_usage_start_date) = TIMESTAMP '{date_a} 00:00:00'"
    db = f"date_trunc('day', line_item_usage_start_date) = TIMESTAMP '{date_b} 00:00:00'"
    rows = e.run(
        f"SELECT {S.FINAL_SERVICE} AS final_service, "
        f"ROUND(SUM(CASE WHEN {db} THEN line_item_net_unblended_cost ELSE 0 END),2) AS cost_b, "
        f"ROUND(SUM(CASE WHEN {da} THEN line_item_net_unblended_cost ELSE 0 END),2) AS cost_a, "
        f"ROUND(SUM(CASE WHEN {db} THEN line_item_net_unblended_cost ELSE 0 END) - SUM(CASE WHEN {da} THEN line_item_net_unblended_cost ELSE 0 END),2) AS delta "
        f"FROM {e.table} WHERE ({tf}) AND ({da} OR {db}) AND {S.NOT_TCR} "
        f"GROUP BY 1 ORDER BY ABS(SUM(CASE WHEN {db} THEN line_item_net_unblended_cost ELSE 0 END) - SUM(CASE WHEN {da} THEN line_item_net_unblended_cost ELSE 0 END)) DESC LIMIT {top_n}"
    )
    return _ok(rows, f"date_a={date_a}, date_b={date_b}, delta=b-a. If one-off charges (Capacity Block prepayments, Extended Support fees) need excluding, say so when you interpret the result")


@server.tool(description="Extended Support cost and instance count for a month (the RDS/ElastiCache end-of-life extended support fee), split by service and engine version. Same basis as the extended-support charts in the production dashboard (amortized, usage_type containing 'xtended').")
def get_extended_support(month: str = "", granularity: str = "monthly",
                         date_from: str = "", date_to: str = "") -> str:
    e = env()
    tf = _day_range_filter(e, date_from, date_to) if (date_from and date_to) else e.time_filter(_check_month(month))
    # QS Dashboard 同款宽匹配（CONTAINS 'xtended'，含 Kinesis Extended-ShardHour 等）
    es_scope = "line_item_usage_type LIKE '%xtended%'"
    if granularity == "daily":
        # 实例数 = 去重资源数（QS non_ec2_daily_count=approx_distinct(resource_id)）；
        # 不能用 usage_amount/24——RDS 扩展支持按 vCPU-小时计费，会放大 vCPU 倍
        daily = e.run(
            f"SELECT substr(CAST(date_trunc('day', line_item_usage_start_date) AS varchar),1,10) AS d, "
            f"line_item_usage_type AS usage_type, "
            f"COALESCE(NULLIF(product_servicecode,''), line_item_product_code) AS service, "
            f"ROUND({S.AMORTIZED},2) AS cost, "
            f"COUNT(DISTINCT CASE WHEN line_item_line_item_type = 'Usage' THEN line_item_resource_id END) AS instances "
            f"FROM {e.table} WHERE {tf} AND {es_scope} AND {S.NOT_TCR} "
            f"GROUP BY 1,2,3 ORDER BY 1"
        )
        return _ok({"daily": daily}, "by day x usage_type x service (same source as the 4 extended-support charts in QuickSight); amortized basis; instance count = distinct resources")
    if date_from and date_to:
        from datetime import date as _date
        days = (_date.fromisoformat(date_to) - _date.fromisoformat(date_from)).days + 1
    else:
        days = _days_in(month)
    rows = e.run(
        f"SELECT line_item_product_code AS service, "
        f"regexp_replace(line_item_usage_type, '^[A-Z0-9]+-', '') AS es_item, "
        f"ROUND({S.AMORTIZED},2) AS amortized_cost, "
        f"ROUND(SUM(CASE WHEN line_item_line_item_type = 'Usage' THEN line_item_usage_amount ELSE 0 END)/24/{days},1) AS avg_daily_instances "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} "
        f"AND line_item_usage_type LIKE '%xtended%' "
        f"GROUP BY 1,2 ORDER BY 3 DESC"
    )
    total = e.run(
        f"SELECT ROUND({S.AMORTIZED},2) AS total FROM {e.table} "
        f"WHERE {tf} AND {S.NOT_TCR} AND line_item_usage_type LIKE '%xtended%'"
    )
    return _ok({"total": total[0]["total"], "by_item": rows},
               "End-of-life extended support fee (RDS/ElastiCache), on the same basis as the extended-support charts in the production dashboard (amortized; usage_type containing 'xtended'; instance count = usage_amount/24/days on the Usage rows). es_item carries both the engine version and the rate year band (Yr1-Yr2 and Yr3 have different rates, and the price jumps on entering Yr3). NOTE: this is NOT the same thing as Enterprise Support, which is the AWS support subscription fee")


# ══════════════════ Dashboard 缺口补齐（第二档新工具）══════════════════

@server.tool(description="Bedrock token consumption (in millions) and cost for a month. Splits by model by default; use dimension=account/usage_type for a different axis.")
def get_bedrock_tokens(month: str, top_n: int = 15, dimension: str = "") -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    top_n = max(1, min(int(top_n), 50))
    dim_map = {"account": "line_item_usage_account_id", "usage_type": "line_item_usage_type"}
    dim_expr = dim_map.get(dimension, S.INNER_SERVICE)
    dim_alias = dimension if dimension in dim_map else "model_or_service"
    rows = e.run(
        f"SELECT {dim_expr} AS {dim_alias}, "
        f"ROUND(SUM(CASE "
        f"WHEN pricing_unit LIKE '%1K%token%' THEN line_item_usage_amount / 1000.0 "
        f"WHEN pricing_unit LIKE '%1M%token%' THEN line_item_usage_amount "
        f"WHEN pricing_unit = 'Units' AND lower(line_item_usage_type) LIKE '%token%' THEN line_item_usage_amount "
        f"ELSE 0 END), 2) AS tokens_millions, "
        f"ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} "
        f"AND (product_product_name LIKE '%Bedrock%' OR line_item_product_code LIKE '%Bedrock%' "
        f"OR product_product_name LIKE '%Claude%' OR product_product_name LIKE '%GPT%') "
        f"AND (lower(pricing_unit) LIKE '%token%' OR (pricing_unit = 'Units' AND lower(line_item_usage_type) LIKE '%token%')) "
        f"GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT {top_n}"
    )
    return _ok(rows, "tokens_millions is in millions of tokens (1K rows divided by 1000; on historical Marketplace rows pricing_unit='Units' actually means 1M tokens -- verified against the unit price and included). Memory and storage rows are not counted")


@server.tool(description="DataTransfer volume for a month (GB/TB, NOT cost), split by direction (Internet-Out/InterAZ/InterRegion). Use this tool when the user asks how much traffic was transferred, how many GB or TB, about cross-AZ traffic, or about traffic out to the internet.")
def get_datatransfer_volume(month: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    rows = e.run(
        f"SELECT CASE "
        f"WHEN line_item_usage_type LIKE '%DataTransfer-Out-Bytes%' THEN 'Internet-Out' "
        f"WHEN line_item_usage_type LIKE '%DataTransfer-In-Bytes%' THEN 'Internet-In' "
        f"WHEN line_item_usage_type LIKE '%DataTransfer-Regional-Bytes%' THEN 'InterAZ' "
        f"WHEN line_item_usage_type LIKE '%AWS-Out-Bytes%' OR line_item_usage_type LIKE '%AWS-In-Bytes%' "
        f"OR line_item_usage_type LIKE '%AWS-In-ABytes%' THEN 'InterRegion' ELSE 'Other' END AS flow, "
        f"ROUND(SUM(line_item_usage_amount),0) AS volume_gb, "
        f"ROUND(SUM(line_item_usage_amount)/1024.0,1) AS volume_tb, "
        f"ROUND(SUM(line_item_net_unblended_cost),2) AS cost "
        f"FROM {e.table} WHERE {tf} AND product_servicecode = 'AWSDataTransfer' AND line_item_line_item_type = 'Usage' "
        f"GROUP BY 1 ORDER BY 4 DESC"
    )
    return _ok(rows, "pricing_unit=GB (the native CUR unit); scope = the Usage rows under the AWSDataTransfer servicecode")


@server.tool(description="RDS SQL Server cost and average daily instance count for a month, split by Database Edition.")
def get_sqlserver_edition_split(month: str) -> str:
    e = env()
    tf = e.time_filter(_check_month(month))
    days = _days_in(month)
    rows = e.run(
        f"SELECT COALESCE(NULLIF(product_database_edition,''),'(none)') AS edition, "
        f"ROUND(SUM(line_item_net_unblended_cost),2) AS cost, "
        f"ROUND(SUM(CASE WHEN line_item_usage_type LIKE '%InstanceUsage%' OR line_item_usage_type LIKE '%Multi-AZUsage%' "
        f"THEN line_item_usage_amount ELSE 0 END)/24/{days},1) AS avg_daily_instances "
        f"FROM {e.table} WHERE {tf} AND {S.NOT_TCR} "
        f"AND line_item_product_code = 'AmazonRDS' AND product_database_engine = 'SQL Server' "
        f"GROUP BY 1 ORDER BY 2 DESC"
    )
    return _ok(rows, "SQL Server by edition; instance count = InstanceUsage/Multi-AZUsage hours / 24 / days")


@server.tool(description="Three vCPU-basis metrics plus an SP waste breakdown. metric: sp_coverage (SP coverage on a vCPU basis), sp_waste (SP waste amount and percentage), sp_waste_by_family (SP waste split by instance family), or odcr_utilization (ODCR utilisation on a vCPU basis). With granularity=daily the first three return a per-day trend. WARNING: you MUST use this tool when the user asks on a vCPU/core basis; for a cost basis use get_sp_coverage or get_odcr_utilization.")
def get_vcpu_metrics(month: str = "", metric: str = "sp_coverage", granularity: str = "monthly",
                     date_from: str = "", date_to: str = "") -> str:
    e = env()
    if date_from and date_to:
        tf = _day_range_filter(e, date_from, date_to)
        from datetime import date as _date
        days = (_date.fromisoformat(date_to) - _date.fromisoformat(date_from)).days + 1
    else:
        tf = e.time_filter(_check_month(month))
        days = _days_in(month)
    day_col = "date_trunc('day', line_item_usage_start_date) AS usage_date, " if granularity == "daily" else ""
    day_grp = " GROUP BY 1 ORDER BY 1" if granularity == "daily" else ""
    if metric == "sp_coverage":
        rows = e.run(
            f"SELECT {day_col}ROUND(SUM(CASE WHEN (line_item_usage_type LIKE '%BoxUsage%' OR line_item_usage_type LIKE '%UnusedBox%') "
            f"AND COALESCE(savings_plan_savings_plan_a_r_n,'') <> '' THEN line_item_usage_amount * TRY_CAST(product_vcpu AS double) ELSE 0 END) / "
            f"NULLIF(SUM(CASE WHEN (line_item_usage_type LIKE '%BoxUsage%' OR line_item_usage_type LIKE '%UnusedBox%') "
            f"AND (COALESCE(savings_plan_savings_plan_a_r_n,'') <> '' OR (COALESCE(reservation_reservation_a_r_n,'') = '' AND line_item_usage_type NOT LIKE '%Spot%')) "
            f"THEN line_item_usage_amount * TRY_CAST(product_vcpu AS double) ELSE 0 END),0) * 100, 2) AS sp_coverage_vcpu_pct "
            f"FROM {e.table} WHERE {tf} AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage'){day_grp}"
        )
        return _ok(rows if granularity == "daily" else rows[0], "SP coverage on a vCPU basis; denominator = SP-covered + pure on-demand (including idle ODCR)")
    if metric == "sp_waste":
        rows = e.run(
            f"SELECT {day_col}ROUND(SUM((savings_plan_total_commitment_to_date - savings_plan_used_commitment)) / "
            f"NULLIF(SUM(savings_plan_total_commitment_to_date),0) * 100, 2) AS waste_pct, "
            f"ROUND(SUM(savings_plan_total_commitment_to_date - savings_plan_used_commitment),2) AS waste_usd "
            f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'SavingsPlanRecurringFee'{day_grp}"
        )
        return _ok(rows if granularity == "daily" else rows[0], "SP waste (amount and percentage)")
    if metric == "sp_waste_by_family":
        rows = e.run(
            f"SELECT COALESCE(NULLIF(savings_plan_instance_type_family,''),'(Compute SP)') AS family, "
            f"ROUND(SUM(savings_plan_total_commitment_to_date - savings_plan_used_commitment),2) AS waste_usd, "
            f"ROUND(SUM((savings_plan_total_commitment_to_date - savings_plan_used_commitment)) / "
            f"NULLIF(SUM(savings_plan_total_commitment_to_date),0) * 100, 2) AS waste_pct "
            f"FROM {e.table} WHERE {tf} AND line_item_line_item_type = 'SavingsPlanRecurringFee' "
            f"GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30"
        )
        return _ok(rows, "SP waste split by instance family (Instance SPs have a family; Compute SPs are grouped as (Compute SP))")
    if metric == "odcr_utilization":
        rows = e.run(
            f"SELECT {day_col}ROUND((1 - SUM(CASE WHEN product_capacitystatus = 'UnusedCapacityReservation' THEN line_item_usage_amount * TRY_CAST(product_vcpu AS double) ELSE 0 END) / "
            f"NULLIF(SUM(CASE WHEN product_capacitystatus = 'AllocatedCapacityReservation' THEN line_item_usage_amount * TRY_CAST(product_vcpu AS double) ELSE 0 END),0)) * 100, 2) AS odcr_utilization_vcpu_pct, "
            f"ROUND(SUM(CASE WHEN product_capacitystatus = 'UnusedCapacityReservation' THEN line_item_usage_amount * TRY_CAST(product_vcpu AS double) ELSE 0 END)/24/{days},0) AS avg_daily_wasted_vcpu "
            f"FROM {e.table} WHERE {tf} "
            f"AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage') "
            f"AND product_capacitystatus IN ('AllocatedCapacityReservation','UnusedCapacityReservation') "
            f"AND line_item_line_item_description NOT LIKE '%Capacity Block%'{day_grp}"
        )
        return _ok(rows if granularity == "daily" else rows[0], "ODCR utilisation on a vCPU basis")
    raise ValueError(f"metric must be one of sp_coverage/sp_waste/odcr_utilization, got: {metric}")


def main() -> None:
    server.run("stdio")


if __name__ == "__main__":
    main()
