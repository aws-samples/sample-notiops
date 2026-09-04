"""实例规格查表（R2.4b.1）—— 归一化分母的来源。

这里只放**有官方出处**的数字，每个表都标了 URL。查不到的一律返回 None，
由调用方丢维度并重归一化（scoring.idle），不做外插。

⚠️ 本模块返回的值分两种来源，调用方必须能区分：
      authoritative   官方公布的表 / 官方公式
      estimated       按家族比例推的，只在权威值缺失时用，且会打 estimated 标记

来源：
  gp3 基线 IOPS
    https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html
    「On gp3 storage volumes, Amazon RDS provides a baseline storage performance
     of 3000 IOPS and 125 MiB/s」；≥ 阈值触发 volume striping 后为 12,000 IOPS。
    阈值按引擎不同：Db2/MariaDB/MySQL/PostgreSQL 400 GiB、Oracle 200 GiB、
    SQL Server 不支持 striping（恒 3,000）。
  Aurora MySQL max_connections 默认值表
    https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Performance.html
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# gp3 基线 IOPS —— R4.4 的 IOPS 归一化基准
# ---------------------------------------------------------------------------

GP3_BASELINE_IOPS = 3_000
GP3_STRIPED_IOPS = 12_000

# 触发 volume striping 的分配容量阈值（GiB），按引擎
_GP3_STRIPING_THRESHOLD_GIB: dict[str, int | None] = {
    "db2": 400,
    "mariadb": 400,
    "mysql": 400,
    "postgres": 400,
    "postgresql": 400,
    "aurora-mysql": 400,
    "aurora-postgresql": 400,
    "oracle": 200,
    "sqlserver": None,          # 不支持 striping，恒 3,000
}


def gp3_baseline_iops(engine: str, allocated_storage_gb: float | None) -> int:
    """gp3 卷的基线 IOPS。

    未提供容量时保守返回未 striping 的 3,000 —— 用大的分母会把繁忙实例
    的 IOPS 归一化成小数字，进而误判为闲置。
    """
    if allocated_storage_gb is None:
        return GP3_BASELINE_IOPS

    key = _normalize_engine(engine)
    threshold = _GP3_STRIPING_THRESHOLD_GIB.get(key, 400)
    if threshold is None:
        return GP3_BASELINE_IOPS
    return GP3_STRIPED_IOPS if allocated_storage_gb >= threshold else GP3_BASELINE_IOPS


def _normalize_engine(engine: str) -> str:
    e = (engine or "").strip().lower()
    if e.startswith("sqlserver") or e.startswith("mssql"):
        return "sqlserver"
    if e.startswith("oracle"):
        return "oracle"
    if e.startswith("aurora-postgres"):
        return "aurora-postgresql"
    if e.startswith("aurora"):
        return "aurora-mysql"
    if e.startswith("postgres"):
        return "postgres"
    if e.startswith("mariadb"):
        return "mariadb"
    if e.startswith("mysql"):
        return "mysql"
    if e.startswith("db2"):
        return "db2"
    return e


# ---------------------------------------------------------------------------
# max_connections —— R4.4 的连接数归一化基准
# ---------------------------------------------------------------------------

# Aurora **MySQL** 的默认值是**公布的表**，不是那条内存公式的结果，两者不能混用。
# 官方表：
# https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Performance.html
#
# ⚠️ **本表只适用于 Aurora MySQL。** Aurora PostgreSQL 没有公布表，见
# `resolve_max_connections` 的说明。
_AURORA_MAX_CONN_BY_SIZE: dict[str, int] = {
    "large": 1000,
    "xlarge": 2000,
    "2xlarge": 3000,
    "4xlarge": 4000,
    "8xlarge": 5000,
    "12xlarge": 6000,
    "16xlarge": 6000,
    "24xlarge": 7000,
    "32xlarge": 7000,
    "48xlarge": 8000,
    # ⚠️ `32xlarge` 曾被我删掉，理由写的是「官方表里 r/m/x 全系都不存在这个规格，
    # 是我按 24→48 外插的」——**那个理由是错的**。官方表里有
    # `db.r6i.32xlarge | 7000`（2026-08-18 复核）。删掉它的后果是
    # r6i.32xlarge 返回 None → 连接数维度被丢弃并重归一化 → 机队里最大的实例
    # 静默拿到一个降级的分。教训：删一行「看起来是外插」的数据前先去查表。
}

# ⚠️ 这张表覆盖 r3/r4/r5/r6g/r6i/r7g/r7i/r8g，**不覆盖 m 系** ——
# Aurora 根本不提供 m 系实例类。它被当作**兜底**表（`_AURORA_MAX_CONN_BY_SIZE.get`），
# 所以哪天 AWS 给 Aurora 出了 m8g 且用另一套阶梯，这里会返回一个捏造的值。
# 已知风险，登记在 R2.4b.1g；真要防住得把家族白名单也写死。
_AURORA_R_FAMILIES = frozenset({
    "r3", "r4", "r5", "r6g", "r6i", "r7g", "r7i", "r8g",
})

# x2 系（内存优化）**整档高一级** —— 同样的 size 后缀对应的连接数比 r 系大一档。
# 逐行核对官方表（2026-08-18）：
#   db.x2g.large 2000 / xlarge 3000 / 2xlarge 4000 / 4xlarge 5000
#   db.x2g.8xlarge 6000 / 12xlarge 7000 / 16xlarge 7000
# ⚠️ 早期版本让 x2g 走上面的 r 系表 → 每一档都低一级（large 给 1000 而非 2000）。
# max_connections 是 R4.4 的归一化**分母**：分母偏低 → 连接数比值偏高
# → 实例看着更忙 → **漏报**闲置。方向与公式那个 bug 相反，但同样是错的。
_AURORA_MAX_CONN_X2: dict[str, int] = {
    "large": 2000,
    "xlarge": 3000,
    "2xlarge": 4000,
    "4xlarge": 5000,
    "8xlarge": 6000,
    "12xlarge": 7000,
    "16xlarge": 7000,
}

_AURORA_MAX_CONN_BURSTABLE: dict[str, int] = {
    "small": 45,
    "medium": 90,
    "large": 135,
}

# 非 Aurora RDS 的默认 max_connections 是参数组公式：
#   LEAST({DBInstanceClassMemory/9531392}, 5000)
# 需要 memory_bytes 才能算，且 DBInstanceClassMemory 会扣掉 OS 预留，
# 与实例标称内存不完全相等 → 算出来的值标为 estimated。
_RDS_MAX_CONN_DIVISOR = 9_531_392
_RDS_MAX_CONN_CAP = 5_000


def aurora_default_max_connections(instance_class: str) -> int | None:
    """Aurora **MySQL** 的公布默认值。查不到返回 None。

    ⚠️ 三张表按家族路由，不是一张表按 size 查：
    `x2` 系整档比 `r` 系高一级，`t` 系是另一套数量级（45 / 90 / 135）。
    """
    size = _size_suffix(instance_class)
    if size is None:
        return None
    if _is_burstable(instance_class):
        return _AURORA_MAX_CONN_BURSTABLE.get(size)
    if _family_of(instance_class).startswith("x2"):
        return _AURORA_MAX_CONN_X2.get(size)
    return _AURORA_MAX_CONN_BY_SIZE.get(size)


def _family_of(instance_class: str) -> str:
    """`db.x2g.large` → `x2g`；`x2g.large` → `x2g`。查不到返回空串。

    ⚠️ **必须先剥前缀。** 早期实现直接 `split(".")[1] if len(parts) >= 3`，
    于是不带 `db.` 前缀的 `x2g.large` 只有 2 段 → 返回 `""` →
    落到 r 系兜底表 → `1000` 而不是 `2000`。
    同文件里 `_strip_prefix` / `_size_suffix` / `_is_burstable` 三个都容忍两种写法，
    只有这个新加的没跟上 —— 而它一错就正好复现 R2.4b.1g 那个「x2 整档低一级
    → 分母偏低 → 漏报闲置」的 bug。
    """
    parts = _strip_prefix(instance_class).split(".")
    return parts[0] if len(parts) >= 2 else ""


def rds_formula_max_connections(memory_bytes: int | None) -> int | None:
    """非 Aurora RDS 的默认 max_connections（按参数组公式算）。

    ⚠️ 结果是**估算**：公式的分子 `DBInstanceClassMemory` 是 AWS 扣掉预留后的
    可用内存，比实例标称内存小，具体扣多少未公开。调用方应打 estimated 标记。
    """
    if memory_bytes is None or memory_bytes <= 0:
        return None
    return min(memory_bytes // _RDS_MAX_CONN_DIVISOR, _RDS_MAX_CONN_CAP)


def resolve_max_connections(
    instance_class: str,
    engine: str,
    memory_bytes: int | None = None,
    *,
    allow_formula: bool = False,
) -> tuple[int | None, bool]:
    """返回 (max_connections, is_estimated)。

    优先级：Aurora 公布表 → （可选）RDS 公式 → (None, False)。
    真源应当是 repository 层读到的**实际参数组值**；本函数只是它取不到时的兜底。

    ⚠️ **`allow_formula` 默认关闭**，因为公式结果的偏差方向不安全。
    2026-08-17 实测对比（内存取自 `ec2:DescribeInstanceTypes`，权威）：

    ```
                  公式推算   Aurora 公布表   偏差
    r8g.large       1802        1000        高 80%
    t3.medium        450          90        高 400%
    ```

    原因是公式的分子 `DBInstanceClassMemory` 是**扣掉 AWS 预留后**的可用内存，
    比实例标称内存小，具体扣多少未公开。
    而 max_connections 在 R4.4 里是归一化的**分母**：高估分母 → 连接数比值变小
    → 实例看着更闲 → **可能误报闲置并建议客户缩容**。
    宁可让该维度缺失（domain 会丢维度并重归一化），也不要一个偏向误报的数字。

    ⚠️ **公布表只能给 Aurora MySQL 用，SHALL NOT 给 Aurora PostgreSQL 用。**
    官方文档明确写着 Aurora PG 的默认值来自公式
    `LEAST({DBInstanceClassMemory/9531392}, 5000)`，**没有公布表**：
    <https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Managing.html>
    早期版本用 `engine.startswith("aurora")` 一刀切，于是 Aurora PG 拿到了
    Aurora MySQL 的数字 —— 而两个引擎的内存开销不同，官方就那张表专门注明
    「The values in the table only apply to Aurora MySQL DB instances」。
    Aurora PG 走与非 Aurora RDS 相同的处置：**留 None**，让维度缺失。
    真源是 repository 层读到的实际参数组值 —— 注意 Aurora PG 的 `max_connections`
    在 **cluster** parameter group 里，不在 instance parameter group（见 attrs_repo）。
    """
    normalized = _normalize_engine(engine)
    if normalized.startswith("aurora") and not normalized.startswith("aurora-postgres"):
        published = aurora_default_max_connections(instance_class)
        if published is not None:
            return published, False

    if allow_formula:
        derived = rds_formula_max_connections(memory_bytes)
        if derived is not None:
            return derived, True

    return None, False


# ---------------------------------------------------------------------------
# 规格权重 —— 承接老 engine.get_instance_size_weight
# ---------------------------------------------------------------------------

SIZE_WEIGHT_LARGE = 1.5
SIZE_WEIGHT_SMALL = 0.5
SIZE_WEIGHT_DEFAULT = 1.0

_MICRO_SIZES = frozenset({"nano", "micro"})


def is_micro(instance_class: str) -> bool:
    """micro / nano 规格 —— 容量审计里它们单独分组沉底（省不下什么钱）。

    ⚠️ 按**规格后缀**判，不用 `"micro" in instance_class` 子串匹配。
    老实现 `engine.capacity_audit:431` 用的是子串，对 `db.t4g.micro` 没问题，
    但任何形如 `db.micro-legacy` 的命名都会误判。
    """
    size = _size_suffix(instance_class)
    return size in _MICRO_SIZES if size else False


def instance_size_weight(instance_class: str) -> float:
    """规格越大，闲置的钱越多，优先级越高。

    行为与老 `engine.get_instance_size_weight` 一致（含 "xlarge" 子串匹配会命中
    2xlarge/4xlarge/… 的特性），保留是为了让搬迁前后的分数可比。
    """
    lower = (instance_class or "").lower()
    if "xlarge" in lower:
        return SIZE_WEIGHT_LARGE
    if "nano" in lower or "micro" in lower or "small" in lower:
        return SIZE_WEIGHT_SMALL
    return SIZE_WEIGHT_DEFAULT


# ---------------------------------------------------------------------------
# 内部工具
# ---------------------------------------------------------------------------

_BURSTABLE_FAMILIES = ("t2", "t3", "t4g")


def _strip_prefix(instance_class: str) -> str:
    """'db.r6g.large' → 'r6g.large'；'cache.m5.large' → 'm5.large'。"""
    ic = (instance_class or "").strip().lower()
    for prefix in ("db.", "cache."):
        if ic.startswith(prefix):
            return ic[len(prefix):]
    return ic


def _size_suffix(instance_class: str) -> str | None:
    """取规格后缀：'db.r6g.2xlarge' → '2xlarge'。"""
    body = _strip_prefix(instance_class)
    parts = body.split(".")
    return parts[-1] if len(parts) >= 2 else None


def _is_burstable(instance_class: str) -> bool:
    body = _strip_prefix(instance_class)
    family = body.split(".")[0] if "." in body else body
    return family in _BURSTABLE_FAMILIES


def is_burstable(instance_class: str) -> bool:
    """T 系判定 —— R2.4.2 的「生产环境使用 T 系实例」结构性风险要用。"""
    return _is_burstable(instance_class)


_SERVERLESS_FAMILIES = frozenset({"serverless"})
"""伸缩型规格的「族」名。

`db.serverless` 是 Aurora Serverless v2 的默认形态；ElastiCache Serverless
同样用这个词。两者的容量随 ACU 动态伸缩。
"""


def has_fixed_memory(instance_class: str) -> bool:
    """这个规格有没有一个**固定的**内存容量可以当分母。

    🔴 内存阈值按「占实例内存的百分之几」判定（R2.1.2）需要一个分母，而
    Serverless v2 的内存随 ACU 秒级伸缩 —— 它没有一个可作分母的固定值。
    对它来说「可用内存低于 20%」这句话本身没有意义。

    ⚠️ 这与「**拿不到**内存」是两件事，必须分开：

    ```
    拿不到（缺 ec2:DescribeInstanceTypes 权限）  → 报一条盲区 finding，
                                                   补权限就能修
    不适用（Serverless v2 没有固定内存）          → 静默跳过，
                                                   没有任何东西可以修
    ```

    混成一件事的表现是**每台 Serverless v2 实例每天报一条盲区通知** ——
    一个永远修不掉、只能靠加白名单压掉的噪音源。而白名单一旦加上去，
    真正缺权限的那些实例也会被一起压掉。
    """
    body = _strip_prefix(instance_class)
    family = body.split(".")[0] if "." in body else body
    return bool(family) and family not in _SERVERLESS_FAMILIES
