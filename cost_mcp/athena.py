"""Athena query executor —— **唯一的查询出口**，也是全部安全护栏所在的那一层。

上游实现在这一层固化了 19 轮 skill 迭代踩出来的口径防线：
- 分区三形态（year/month 分区、CTAS 无分区平表、CUR2 billing_period）
- workgroup 携带（客户环境强制输出位置，不自行指定 OutputLocation）
- ARN 空值 COALESCE（原生 CUR 空串 / CTAS 表 NULL 双形态）由 SQL 模板负责
- 超时与轮询

并入 NotiOps 时在这一层**新增**的四道安全护栏（原实现一道都没有）：

1. **`_translate_sql` 改成「字面量感知」** —— 这是一个**可利用的引号注入**的修复，不是
   重构。原实现对**已经拼好的 SQL 文本**做正则替换，而替换出来的表达式自带单引号
   （`COALESCE(product['gpu'],'')`）。于是一个只含字母下划线、能过工具层白名单的值
   （比如 `product_gpu`）在 `CUR_VERSION=2` 下会被翻译成含 6 个引号的字面量，而作者
   只写了 2 个 —— 白名单看不见这条路。现在只翻译**字面量之外**的片段，
   判据：字面量片段翻译前后**逐字节相同**（tests/test_cost_mcp_sql_safety.py）。

2. **SELECT-only 校验** —— `start_query_execution` 本身是写动作。IAM 那层已经结构性
   禁写（不给 glue 写、不给 UpdateWorkGroup、`s3:PutObject` 只给结果前缀），这里是
   **纵深防御**：单语句、首关键字必须 SELECT|WITH、显式拒绝 DDL/DML/UNLOAD。

3. **结果行上限** —— 原实现把每一页都读进内存，而 `get_cost_cube` 一次约 5 万行。
   超限**抛错，不静默截断**（「不许静默降级」：截断会变成一个看起来正常的错答案）。

4. **错误不外泄** —— Athena 的 `StateChangeReason` 里带库名/表名/桶名，原实现把它塞进
   异常，一路传到 agent 再到用户。按 docs/LOGGING_STANDARD.md「绝不带上游 message」，
   现在映射成我们自己的错误码，原因只进日志。

⚠️ **扫描量上限不在这一层** —— Athena 没有逐次调用的 bytes 上限，只有 workgroup 级的
`WorkGroupConfiguration.BytesScannedCutoffPerQuery`，所以它在 IaC 里。这里只做**回读核算**
（`DataScannedInBytes` 进日志），好让「哪个工具在烧钱」可被观测。

⚠️ **静态 AK/SK 那条路已删。** 原实现支持 `CUR_ACCESS_KEY_ID` / `CUR_SECRET_ACCESS_KEY` /
`CUR_SESSION_TOKEN`，即把长期凭据放在 Lambda 环境变量里。这在一个要开源到 aws-samples 的
交付物里不能存在。跨账号改走 `CUR_ROLE_ARN` + `sts:AssumeRole`，口径参照
`core/aws_session.py` 的四条不变量（尤其第 3 条：拿不到凭证就报错，**绝不回落到本地凭证**
—— 回落的后果是"在错误的账号里读了账单数据"，而调用方看到的是成功）。
"""

import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone

import boto3

from .columns import V2 as _V2, _V2_MAP as _COLMAP

logger = logging.getLogger(__name__)

#: 结果行上限的默认值。`get_cost_cube` 一次约 5 万行，留一倍余量；仪表盘类工具可以
#: 显式传更大的值，但必须是**显式**的 —— 默认值不该照顾最大的那个消费者。
_DEFAULT_MAX_ROWS = int(os.environ.get("ATHENA_MAX_ROWS", "120000"))

#: 允许的分区形态。⚠️ 未知取值**报错**而不是回落到 flat —— 回落的表现是
#: 「查得出来但只有一个月的数据」，属于静默错答案。
_PARTITION_STYLES = ("flat", "year-month", "billing-period")

# CUR 2.0：SQL 文本统一翻译（一处拦截所有查询——常量拼的和工具 f-string 拼的都覆盖）
_COL_PAT = re.compile(r"\b(" + "|".join(sorted(_COLMAP, key=len, reverse=True)) + r")\b") if _V2 else None

#: 把 SQL 切成「字面量 / 非字面量」交替的片段。单引号字面量内部的 `''` 是转义的单引号，
#: 所以 `'(?:[^']|'')*'` 才能正确吃掉 `'it''s'` 这种值。
_LITERAL_PAT = re.compile(r"'(?:[^']|'')*'")

#: SELECT-only 判据：首关键字白名单 + 危险关键字denylist。
_LEADING_OK = re.compile(r"^\s*(?:SELECT|WITH)\b", re.IGNORECASE)
_FORBIDDEN = re.compile(
    r"\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|UNLOAD|"
    r"GRANT|REVOKE|EXECUTE|PREPARE|DEALLOCATE|CALL|MSCK|REFRESH)\b",
    re.IGNORECASE,
)

#: 临时凭证还剩多少秒就当过期。与 `core/aws_session.py::_EXPIRY_SKEW_SEC` 同一个数。
_EXPIRY_SKEW_SEC = 300

#: `CUR_ROLE_ARN` 的形状校验。**不是**为了好看 —— 一个写错的 ARN（比如指到别人账号的
#: 角色）会让我们的执行角色去 assume 一个我们不该 assume 的东西。canonical 版本是
#: `shared/account_scope.py::assert_role_belongs_to`（那边挡的是可被多方写入的 DDB
#: 字段）；这里的 `CUR_ROLE_ARN` 来自我们自己的部署参数，所以只做严格形状校验。
#: ⚠️ `..` 单独拒掉：IAM 角色路径里永远不会有它，放过去只会让一个手抖写出来的
#: `role/../x` 看起来像被我们认可了（AWS 最终会拒，但错误会显示成 AccessDenied，
#: 看上去像"客户没给权限"而不是"我们的参数写错了"）。
_ROLE_ARN_PAT = re.compile(r"^arn:aws(?:-cn|-us-gov)?:iam::(\d{12}):role/(?!.*\.\.)[\w+=,.@/-]{1,512}$")


#: 只在**账号有折扣**（EDP / PPA）的 CUR 里才存在的那组列。AWS 文档明确说 net 列是
#: 折扣账号才有的，而上游那份 SQL 几乎每个金额工具都用 `line_item_net_unblended_cost`。
#: ⇒ 一个普通客户的 CUR 上，45 个工具里约 40 个会直接崩在「列不存在」。
#: 2026-09-20 在自己的现网上实测确认了这一点（194 列，net 那几列一个都没有）。
#:
#: 降级规则很简单：**把 `_net_` 去掉**就是同口径的非 net 列（已逐个核对存在）。
#: ⚠️ 但降级**必须说出来** —— `unblended` 与 `net_unblended` 在有折扣的账号上差的就是折扣，
#: 拿前者冒充后者是静默给错数字。所以每一次降级都会进 `degradations`，由工具层写进
#: 返回值的 `caliber_note`（见 server.py::_ok），模型必须照着说。
_NET_COLUMNS = (
    "line_item_net_unblended_cost",
    "savings_plan_net_savings_plan_effective_cost",
    "reservation_net_effective_cost",
    "reservation_net_unused_amortized_upfront_fee_for_billing_period",
    "reservation_net_unused_recurring_fee",
    "line_item_net_amortized_cost",
)

#: CUR 列名的命名约定 —— 所有数据列都带这几个前缀之一。用它把 SQL 里的**列引用**
#: 从函数名/别名/关键字里分出来，从而能在**发查询之前**判断「这份 CUR 有没有这一列」。
#:
#: 🔴 为什么需要这个：CUR 的列集是**按账号动态变化**的 —— AWS 只为你**实际用到的服务
#: 维度**输出属性列。现网实测：上游 SQL 引用的 35 个属性列里**缺 11 个**，而且和折扣无关 ——
#: 没有 Savings Plan ⇒ 7 个 `savings_plan_*` 属性列不存在；没有 GPU / Direct Connect /
#: ElastiCache / SQL Server ⇒ 对应的 `product_*` 列也不存在。
#: 上游那份 SQL 是在**某一个**客户的列集上写的，所以换个账号就会有一批工具撞上"列不存在"。
#:
#: 不做这道预检的表现：Athena 报错 → 我们映射成笼统的 `query_failed`（原因只在日志里）
#: → 模型只能含糊地说"查不到"。做了之后：**明确告诉模型是哪一列、这份 CUR 提供不了**，
#: 它就能回答「你的账单里没有 Savings Plan，所以没有 SP 明细可看」——那是对的答案。
_CUR_COLUMN_PREFIXES = (
    "line_item_", "product_", "savings_plan_", "reservation_",
    "bill_", "pricing_", "resource_tags_", "discount_", "split_line_item_",
)
_CUR_IDENT_PAT = re.compile(
    r"\b(" + "|".join(_CUR_COLUMN_PREFIXES) + r")[a-z0-9_]+\b")

#: 没有安全替代列、只能整块判"这份 CUR 提供不了"的列。
#: `product_gpu`（GPU 卡数）在现网那张表里就不存在（只有 `product_gpu_memory`）。
#: 这里**不许**悄悄换成 0 或 NULL —— 那会让「GPU 花了多少」答出一个看起来正常的 0。
_NO_FALLBACK_COLUMNS = ("product_gpu",)


class CostMcpQueryError(RuntimeError):
    """查询失败 —— **只带我们自己的错误码**，不带上游报文。

    `code` 取值：`query_failed` / `query_cancelled` / `query_timeout` /
    `result_too_large` / `rejected_not_read_only`。上游的真实原因只进日志。
    """

    #: 这些错误码的 detail **可以**出现在给调用方的消息里。
    #: 判据是「detail 里装的是我们自己的东西，还是上游的报文」：
    #:   · `column_unavailable_in_this_cur` 的 detail 是一个 **CUR schema 列名**
    #:     （`savings_plan_offering_type` 这类），是公开的 AWS 字段名、不含任何客户标识，
    #:     而且它是调用方**唯一需要**的信息 —— 少了它，模型只能说"查不到"，
    #:     而带上它就能答出「你的账单里没有 Savings Plan」这个**正确答案**。
    #:   · 其余错误码的 detail 是 Athena 的 `StateChangeReason`（带库名/表名/桶名），
    #:     按 docs/LOGGING_STANDARD.md **只进日志**。
    SAFE_DETAIL_CODES = frozenset({"column_unavailable_in_this_cur"})

    def __init__(self, code: str, detail_for_log: str = "") -> None:
        msg = (f"{code}: {detail_for_log}"
               if code in self.SAFE_DETAIL_CODES and detail_for_log else code)
        super().__init__(msg)
        self.code = code
        self.detail_for_log = detail_for_log


def _translate_sql(sql: str) -> str:
    """CUR 1.0 列名 → 2.0 表达式。**只翻译字面量之外的片段。**

    为什么必须字面量感知：见模块 docstring 第 1 条。判据是「字面量片段逐字节不变」，
    这条由 `_LITERAL_PAT` 的切分**按构造保证** —— 奇数段（字面量）原样拼回去。
    """
    if not _V2:
        return sql
    out = []
    pos = 0
    for m in _LITERAL_PAT.finditer(sql):
        # 字面量之前的非字面量片段：翻译
        out.append(_COL_PAT.sub(lambda g: _COLMAP[g.group(1)], sql[pos:m.start()]))
        # 字面量本身：**原样**，一个字节都不许动
        out.append(m.group(0))
        pos = m.end()
    out.append(_COL_PAT.sub(lambda g: _COLMAP[g.group(1)], sql[pos:]))
    return "".join(out)


def _assert_read_only(sql: str) -> None:
    """SELECT-only 纵深防御。拒绝的原因只说「不是只读查询」，不回显 SQL。"""
    # 先剥掉字面量，免得一个值里带 'DROP' 就被误拒（也免得注释里的词触发）。
    bare = _LITERAL_PAT.sub("''", sql)
    bare = re.sub(r"--[^\n]*", " ", bare)          # 行注释
    bare = re.sub(r"/\*.*?\*/", " ", bare, flags=re.S)  # 块注释
    if not _LEADING_OK.match(bare):
        raise CostMcpQueryError("rejected_not_read_only", "first keyword is not SELECT/WITH")
    if ";" in bare.rstrip().rstrip(";"):
        raise CostMcpQueryError("rejected_not_read_only", "multiple statements")
    hit = _FORBIDDEN.search(bare)
    if hit:
        raise CostMcpQueryError("rejected_not_read_only", f"forbidden keyword {hit.group(0).upper()}")


def _month_eq(col: str, value: str) -> str:
    """分区列等值片段，同时兼容 `month='07'` 与 `month='7'` 两种写法。

    ⚠️ 为什么不用 `CAST(month AS integer) = 7`：对分区列做 CAST 会**让 Athena 无法做
    分区裁剪**，一个问题就从扫一个月变成扫全表 —— 那正是我们要防的花钱方式。用两个
    等值的 OR 既保留裁剪又兼容两种布局。
    成因：AWS 官方 Glue CUR crawler 写的是 `month=7`，而上游实现拼的是 `'07'`；
    NotiOps 自己的 `bff/web-chat/finops.mjs` 早就踩过并用 CAST 绕过（那边不在热路径上，
    所以 CAST 的代价可以接受，这里不行）。
    """
    stripped = value.lstrip("0") or "0"
    if stripped == value:
        return f"{col} = '{value}'"
    return f"({col} = '{value}' OR {col} = '{stripped}')"

# ── 区间过滤（从 server.py 搬过来）──────────────────────────────────────────────
# 为什么搬：这两个函数是**分区逻辑**，和上面 `_month_eq` / `AthenaEnv.time_filter` 是同一
# 件事。它们原来住在 server.py，而那个模块在 import 期就 `import mcp` —— 仓库的 .venv 里
# 没有 mcp，于是 **CI 根本测不到它们**。2026-09-20 那个「多月区间扫 0 字节返回空」的 bug
# 正是因此溜过去的：单月那条（在本文件里、有判据）修了，区间那条没人看得见。
# 搬过来之后两者共用同一套补零兼容，且都能在 pytest-suite 里被钉住。

def _range_filter(e, m_from: str, m_to: str) -> str:
    """多月区间分区过滤（三形态）。"""
    if e.partition_style == "year-month":
        # ⚠️ 必须走 `_month_eq` 同时命中 `'08'` 与 `'8'` —— 官方 Glue CUR crawler 写的是
        # **不补零**的 `month=8`。2026-09-20 在现网实测踩到:单月查询（time_filter 已修）
        # 正常，而多月区间**扫 0 字节、返回空**，因为这里只发了 `month='06'`。
        # 症状极具误导性:不报错、有结构、只是 data 是空的 —— 模型会照着空数据答
        # 「这几个月没有费用」。受影响的是所有区间类问题（「今年到现在花了多少」、
        # 「最近 6 个月趋势」、SP 仪表盘、cost cube、DX 逐月…），也就是最常问的那批。
        parts = []
        y, mm = int(m_from[:4]), int(m_from[5:7])
        while f"{y}-{mm:02d}" <= m_to:
            parts.append(f"(year='{y}' AND {_month_eq('month', f'{mm:02d}')})")
            mm += 1
            if mm > 12:
                y, mm = y + 1, 1
        return "(" + " OR ".join(parts) + ")"
    if e.partition_style == "billing-period":
        return f"billing_period >= '{m_from}' AND billing_period <= '{m_to}'"
    return (f"bill_billing_period_start_date >= TIMESTAMP '{m_from}-01 00:00:00' "
            f"AND bill_billing_period_start_date <= TIMESTAMP '{m_to}-01 00:00:00'")


def _day_range_filter(e, date_from: str, date_to: str) -> str:
    """精确到天的时间过滤：跨月分区 + usage_start_date 截取（仪表盘 date-range 筛选用）。"""
    df = _ident(date_from, r"^\d{4}-\d{2}-\d{2}$", "date_from")
    dt = _ident(date_to, r"^\d{4}-\d{2}-\d{2}$", "date_to")
    if df > dt:
        raise ValueError(f"date_from {df} is later than date_to {dt}")
    return (f"{_range_filter(e, df[:7], dt[:7])} "
            f"AND line_item_usage_start_date >= TIMESTAMP '{df} 00:00:00' "
            f"AND line_item_usage_start_date < date_add('day', 1, TIMESTAMP '{dt} 00:00:00')")


def _cur_from_config_table() -> tuple[str, str]:
    """`CUR_TABLE` 没配时，去 `notiops-config` 里读 NotiOps 自己建的那张 CUR 表。

    返回 `(表名, 分区形态)`；任一取不到就返回空串。

    ⚠️ **分区形态也必须从这里取，不能靠客户填** —— 这是 2026-09-20 一次真部署时
    发现的缺陷。自建 CUR 走的是官方 Athena 集成，
    它产出的是 **year/month 分区**表；而方式 A 的 `CurPartitionStyle` 参数默认 `flat`，
    客户没有任何依据去改它（那张表在他填参数的时候还不存在）。于是 CUR 就绪之后
    `PARTITION_STYLE` 永远停在 `flat`，而 `flat` 分支走的是
    `bill_billing_period_start_date` 过滤 —— 这个参数自己的说明就写着
    「填错不会报错，只会**静默**让查询只覆盖一部分数据」。
    方式 B 不吃这个亏，因为 `setup.sh` 会在 CUR 就绪后重跑时读 `year_month_partitioned`
    并据此设值（setup.sh:1270-1288）。所以这条回落同时也是**两条路径对等**的要求。

    为什么需要这条回落
    ------------------
    NotiOps 可以**替客户建 CUR**（方式 A 的 `ProvisionCur=yes` / 方式 B 的 setup.sh）。
    但 AWS 建完 CUR 到首次交付有 **~24h 硬延迟**，Glue 库表名是延迟结束后由
    `lambda6_cur_finalizer` 发现/创建的 —— **部署那一刻它还不存在**，所以部署期
    根本没法把它写进 `CUR_TABLE` 环境变量。

    没有这条回落的话，客户就得在一天后**再来部署一次**（方式 A 重跑栈更新、方式 B
    重跑 setup.sh）才能真正用上 CUR。而"过一天记得回来再点一次"这种要求，实际结果
    就是大部分人不会回来点，于是成本主题永远停在 Cost Explorer —— 客户以为 CUR
    没生效是产品问题。

    所以：env 里没有表名时，就去 finalizer 写状态的那条记录里拿。
    一次 `GetItem`，只在冷启动跑一次（`AthenaEnv` 被 `env()` 缓存）。

    ⚠️ 只认 `READY`。`PENDING` / `DELAYED` 时**返回空**，让上层照常抛
    "CUR_TABLE not set" —— 此时那张表要么不存在、要么还没爬完，连上去查只会得到
    看起来正常的空结果，那比明确报错糟得多。
    """
    config_table = os.environ.get("CONFIG_TABLE", "")
    account_id = os.environ.get("NOTIOPS_ACCOUNT_ID", "")
    if not config_table or not account_id:
        return "", ""
    try:
        import boto3
        region = os.environ.get("AWS_REGION") or "us-east-1"
        item = boto3.client("dynamodb", region_name=region).get_item(
            TableName=config_table,
            Key={"PK": {"S": f"cur-athena-status#{account_id}"}, "SK": {"S": "STATUS"}},
        ).get("Item") or {}
    except Exception as exc:  # noqa: BLE001
        # 只记异常**类型名** —— 这条路径上的错误详情会带表名/账号号。
        logger.warning("cur-athena-status lookup failed: %s", type(exc).__name__)
        return "", ""
    if (item.get("status", {}).get("S") or "") != "READY":
        return "", ""
    db = item.get("athena_database", {}).get("S") or ""
    tbl = item.get("athena_table", {}).get("S") or ""
    if not (db and tbl):
        return "", ""
    # `year_month_partitioned` 由 finalizer 写(它是**真去 Glue 看过分区键**才写的,
    # 不是按命名约定猜的)。取不到时返回空串,让调用方保留 env 里的值 —— 不自己造默认。
    ym = item.get("year_month_partitioned", {}).get("BOOL")
    style = "year-month" if ym is True else ("flat" if ym is False else "")
    return f"{db}.{tbl}", style


class AthenaEnv:
    """环境配置：全部来自 Lambda 环境变量，换客户/换表零改码。"""

    def __init__(self) -> None:
        table = os.environ.get("CUR_TABLE", "")
        resolved_style = ""
        if not table:
            table, resolved_style = _cur_from_config_table()
        if not table:
            raise RuntimeError(
                "CUR_TABLE not set -- configure the Lambda env var, e.g. 'my_cur_db.my_cur_table'"
            )
        self.table = table
        self.workgroup = os.environ.get("ATHENA_WORKGROUP", "primary")
        # ⚠️ 只有在**表名本身**是从 DDB 解析来的时候才用解析出的分区形态。
        # 客户显式给了 `CUR_TABLE`(用自己那张表)时,`PARTITION_STYLE` 以 env 为准 ——
        # 那是他自己的表,他知道形状,而 DDB 那条记录描述的是**我们建的**那张。
        self.partition_style = resolved_style or os.environ.get("PARTITION_STYLE", "flat")
        if self.partition_style not in _PARTITION_STYLES:
            raise RuntimeError(
                f"PARTITION_STYLE must be one of {_PARTITION_STYLES}, got: {self.partition_style}"
            )
        self.output_location = os.environ.get("ATHENA_OUTPUT", "")  # 空 = 由 workgroup 决定
        # ⚠️ `AWS_REGION` 是 Lambda **保留**环境变量，函数配置里设不了 —— 它永远等于函数
        # 自己所在的区。跨区 CUR/Athena 必须用我们自己的 `ATHENA_REGION`。
        self.region = os.environ.get("ATHENA_REGION") or os.environ.get("AWS_REGION") or "us-east-1"
        self.query_timeout = int(os.environ.get("ATHENA_TIMEOUT", "120"))
        self.max_rows = _DEFAULT_MAX_ROWS
        self._role_arn = (os.environ.get("CUR_ROLE_ARN") or "").strip()
        if self._role_arn and not _ROLE_ARN_PAT.match(self._role_arn):
            # 只说形状不对，**不回显 ARN**（它带账号号）。
            raise RuntimeError("CUR_ROLE_ARN is not a well-formed IAM role ARN")
        # 本地开发用；**不进任何部署参数面**（部署路径一律走执行角色或 CUR_ROLE_ARN）。
        self._profile = os.environ.get("AWS_PROFILE_NAME", "")
        self._creds: dict | None = None
        self._creds_exp: datetime | None = None
        #: 这份 CUR 实际有哪些列（Glue 探测；None = 探测失败，此时**不做任何降级**）。
        self._columns: set[str] | None = None
        #: 列名替换表（缺 net 列时把 `_net_` 去掉），以及人类可读的降级说明。
        self._col_alias: dict[str, str] = {}
        self.degradations: list[str] = []
        self._probe_columns()

    def _probe_columns(self) -> None:
        """冷启动探一次表的列，据此决定要不要降级。

        为什么用 Glue 而不是 `SELECT * LIMIT 0`：Glue `get_table` **不花钱、不扫字节**，
        而 Athena 的任何查询都要计费。这道探测每个容器只跑一次。

        ⚠️ 探测失败时**什么都不做** —— 不猜、不降级。让 Athena 自己报「列不存在」，
        比我们基于一个失败的探测去替换列名安全得多（后者可能把对的列换成错的）。
        """
        db, _, tbl = self.table.partition(".")
        if not tbl:
            return
        try:
            glue = boto3.client("glue", region_name=self.region)
            desc = glue.get_table(DatabaseName=db, Name=tbl)["Table"]
        except Exception as e:  # noqa: BLE001
            logger.warning("cost_mcp: Glue column probe failed (%s) -- no aliasing applied",
                           type(e).__name__)
            self.degradations.append(
                "could not read the CUR table schema, so no column compatibility checks were applied"
            )
            return
        cols = {c["Name"] for c in desc.get("StorageDescriptor", {}).get("Columns", [])}
        cols |= {c["Name"] for c in desc.get("PartitionKeys", [])}
        self._columns = cols
        missing_net = [c for c in _NET_COLUMNS if c not in cols]
        for c in missing_net:
            plain = c.replace("_net_", "_", 1)
            if plain in cols:
                self._col_alias[c] = plain
        if self._col_alias:
            logger.info("cost_mcp: CUR has no net columns; aliasing %d of them",
                        len(self._col_alias))
            self.degradations.append(
                "this CUR has no net (post-discount) cost columns, so all amounts are "
                "pre-discount (unblended). If this account has an EDP/PPA, the real amounts "
                "are lower than reported -- say so when answering"
            )
        gone = [c for c in _NO_FALLBACK_COLUMNS if c not in cols]
        self._unavailable = tuple(gone)
        if gone:
            logger.info("cost_mcp: CUR is missing %s with no safe fallback", gone)
            self.degradations.append(
                "this CUR does not carry " + ", ".join(gone)
                + ", so tools that need it are unavailable (they will say so rather than "
                  "report a zero)"
            )

    # ── 凭证 ────────────────────────────────────────────────────────────────
    def _assume(self) -> dict:
        """assume `CUR_ROLE_ARN`，返回临时凭证。失败**抛错**，绝不回落到本地凭证。"""
        sts = boto3.client("sts", region_name=self.region)
        try:
            resp = sts.assume_role(RoleArn=self._role_arn, RoleSessionName="notiops-cost-mcp")
        except Exception as e:  # noqa: BLE001
            # 只记异常**类型名**，不记 message（可能带 ARN / 账号号）。
            logger.warning("cost_mcp: assume_role failed (%s)", type(e).__name__)
            raise CostMcpQueryError("cur_role_assume_failed", type(e).__name__) from None
        c = resp["Credentials"]
        self._creds_exp = c["Expiration"]
        return {
            "aws_access_key_id": c["AccessKeyId"],
            "aws_secret_access_key": c["SecretAccessKey"],
            "aws_session_token": c["SessionToken"],
        }

    @property
    def client(self):
        """每次取用都现建 client（**只缓存凭证，不缓存 client**）。

        与 `core/aws_session.py` 不变量 4 同一条理由：临时凭证有时效，缓存 client 会在
        一小时后开始静默 401，而 boto3 不会自己去续。
        """
        if not self._role_arn:
            session = boto3.Session(profile_name=self._profile) if self._profile else boto3.Session()
            return session.client("athena", region_name=self.region)
        near = datetime.now(timezone.utc) + timedelta(seconds=_EXPIRY_SKEW_SEC)
        if self._creds is None or self._creds_exp is None or self._creds_exp <= near:
            self._creds = self._assume()
        return boto3.Session(**self._creds).client("athena", region_name=self.region)

    # ── 时间过滤 ────────────────────────────────────────────────────────────
    def time_filter(self, month: str) -> str:
        """month: 'YYYY-MM' → 该月的时间过滤 SQL 片段（分区三形态，usage_date 语义）。"""
        year, mm = month.split("-")
        if self.partition_style == "billing-period":
            return f"billing_period = '{month}'"
        if self.partition_style == "year-month":
            return f"year = '{year}' AND {_month_eq('month', mm)}"
        nxt_y, nxt_m = (int(year) + 1, 1) if mm == "12" else (int(year), int(mm) + 1)
        return (
            f"line_item_usage_start_date >= TIMESTAMP '{year}-{mm}-01 00:00:00' "
            f"AND line_item_usage_start_date < TIMESTAMP '{nxt_y}-{nxt_m:02d}-01 00:00:00'"
        )

    def billing_filter(self, month: str) -> str:
        """账期过滤（billing_period 语义）：EDP/Credit/对账等账单行用此口径。

        账务行的 usage_date 可能落在账期边界外（EdpDiscount 实测差 2.1 万），
        billing_period 过滤在分区/平表上语义一致。
        """
        year, mm = month.split("-")
        if self.partition_style == "billing-period":
            return f"billing_period = '{month}'"
        if self.partition_style == "year-month":
            return f"year = '{year}' AND {_month_eq('month', mm)}"
        return f"bill_billing_period_start_date = TIMESTAMP '{year}-{mm}-01 00:00:00'"

    def rate_window_filter(self) -> str:
        """SP 的 `per_vcpu_rate` **费率标定窗口**过滤片段（不是查询月份过滤）。

        上游三处 SP 查询（`get_sp_dashboard_daily` ×2、`get_sp_details`）里硬编码着
        `WHERE year >= '2025'`。它的**意图是对的**：per_vcpu_rate 要用长历史算，只取查询
        区间会让费率随机型漂移偏高近一倍（上游注释实测）。但那行有两个缺陷：

        1. 🔴 **`year` 列只在 `year-month` 分区形态下存在。** 默认的 `PARTITION_STYLE=flat`
           和 `billing-period` 上根本没有这一列 ⇒ 三处查询直接失败，也就是 SP 那个
           dashboard sheet 在默认配置下是坏的。
        2. `'2025'` 是写死的字面量，会随时间腐烂（2028 年它就成了"全历史"，等于没有上限，
           而上限正是防止扫全表的那道闸）。

        改法：窗口长度用 `SP_RATE_WINDOW_YEARS`（默认 2）表达，起始年 = 今年 - (N-1)。
        2026 年算出来正好是 `>= 2025` —— **与上游当前行为逐字等价**，只是不再腐烂、
        并且三种分区形态都能用。
        """
        years = max(1, int(os.environ.get("SP_RATE_WINDOW_YEARS", "2")))
        from_year = datetime.now(timezone.utc).year - (years - 1)
        if self.partition_style == "year-month":
            return f"year >= '{from_year}'"
        if self.partition_style == "billing-period":
            return f"billing_period >= '{from_year}-01'"
        return f"line_item_usage_start_date >= TIMESTAMP '{from_year}-01-01 00:00:00'"

    def _apply_column_aliases(self, sql: str) -> str:
        """按探测结果替换列名；碰到没有替代列的就**报错而不是给个 0**。

        与 `_translate_sql` 同样**字面量感知** —— 否则又是一次引号注入（见模块 docstring
        第 1 条）。这里复用同一套切分。
        """
        if not self._col_alias and not getattr(self, "_unavailable", ()) and not self._columns:
            return sql
        # 先拦无替代列：这类工具必须明确不可用，不许答出一个看起来正常的零。
        bare = _LITERAL_PAT.sub("''", sql)
        for c in getattr(self, "_unavailable", ()):
            if re.search(rf"\b{re.escape(c)}\b", bare):
                raise CostMcpQueryError("column_unavailable_in_this_cur", c)
        if self._col_alias:
            sql = self._rewrite_outside_literals(sql, self._col_alias)
        # 通用预检：SQL 里凡是按 CUR 命名约定的列引用，只要这份表没有，就**点名报错**。
        # 放在别名替换**之后**：别名换完剩下的才是真正缺的。
        if self._columns:
            bare2 = _LITERAL_PAT.sub("''", sql)
            for m in _CUR_IDENT_PAT.finditer(bare2):
                name = m.group(0)
                if name not in self._columns:
                    raise CostMcpQueryError("column_unavailable_in_this_cur", name)
        return sql

    @staticmethod
    def _rewrite_outside_literals(sql: str, alias: dict[str, str]) -> str:
        """按 `alias` 替换列名，**只动字面量之外的片段**（同 `_translate_sql` 的理由）。"""
        pat = re.compile(r"\b(" + "|".join(sorted(alias, key=len, reverse=True)) + r")\b")
        out, pos = [], 0
        for m in _LITERAL_PAT.finditer(sql):
            out.append(pat.sub(lambda g: alias[g.group(1)], sql[pos:m.start()]))
            out.append(m.group(0))      # 字面量原样
            pos = m.end()
        out.append(pat.sub(lambda g: alias[g.group(1)], sql[pos:]))
        return "".join(out)

    # ── 执行 ────────────────────────────────────────────────────────────────
    def run(self, sql: str, timeout_s: int = 0, max_rows: int = 0) -> list[dict]:
        """执行查询，返回 list[dict]（首行列名作 key）。

        失败一律抛 `CostMcpQueryError`（只带错误码），由工具层包装成给模型看的文本。
        """
        timeout_s = timeout_s or self.query_timeout
        cap = max_rows or self.max_rows
        sql = _translate_sql(sql)   # CUR 2.0 列名翻译（V1 时为 no-op；字面量不动）
        sql = self._apply_column_aliases(sql)  # net 列缺失时的降级（同样字面量不动）
        _assert_read_only(sql)      # 纵深防御：IAM 已结构性禁写，这里再拦一道

        client = self.client
        kwargs: dict = {"QueryString": sql, "WorkGroup": self.workgroup}
        if self.output_location:
            kwargs["ResultConfiguration"] = {"OutputLocation": self.output_location}
        qid = client.start_query_execution(**kwargs)["QueryExecutionId"]

        waited = 0.0
        delay = 1.0
        while True:
            qe = client.get_query_execution(QueryExecutionId=qid)["QueryExecution"]
            state = qe["Status"]
            if state["State"] == "SUCCEEDED":
                # 扫描量回读 —— 唯一能让「哪个工具在烧钱」可观测的地方。
                # workgroup 级的 BytesScannedCutoffPerQuery 在 IaC 里，这里只核算。
                scanned = (qe.get("Statistics") or {}).get("DataScannedInBytes")
                if scanned is not None:
                    logger.info("cost_mcp: query %s scanned %s bytes", qid, scanned)
                break
            if state["State"] in ("FAILED", "CANCELLED"):
                # ⚠️ StateChangeReason 带库名/表名/桶名 —— 只进日志，绝不进异常。
                logger.warning(
                    "cost_mcp: query %s %s: %s",
                    qid, state["State"], state.get("StateChangeReason", "unknown"),
                )
                code = "query_cancelled" if state["State"] == "CANCELLED" else "query_failed"
                raise CostMcpQueryError(code, state.get("StateChangeReason", "unknown"))
            time.sleep(delay)
            waited += delay
            delay = min(delay * 1.5, 5.0)
            if waited > timeout_s:
                client.stop_query_execution(QueryExecutionId=qid)
                logger.warning("cost_mcp: query %s timed out after %ss", qid, timeout_s)
                raise CostMcpQueryError("query_timeout", f"{timeout_s}s")

        rows: list[dict] = []
        header: list[str] = []
        paginator = client.get_paginator("get_query_results")
        for page in paginator.paginate(QueryExecutionId=qid):
            for row in page["ResultSet"]["Rows"]:
                values = [c.get("VarCharValue") for c in row["Data"]]
                if not header:
                    header = [v or "" for v in values]
                    continue
                rows.append(dict(zip(header, values)))
                if len(rows) > cap:
                    # 超限**抛错**，不静默截断 —— 截断出来的是一个看起来正常的错答案。
                    logger.warning("cost_mcp: query %s exceeded row cap %s", qid, cap)
                    raise CostMcpQueryError("result_too_large", f"cap={cap}")
        return rows


_ENV: AthenaEnv | None = None


def env() -> AthenaEnv:
    global _ENV
    if _ENV is None:
        _ENV = AthenaEnv()
    return _ENV
