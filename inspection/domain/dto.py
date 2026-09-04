"""domain 层的数据契约。

全部 frozen —— 判定链上任何一环都不得就地改写入参（否则重放不出同一结果）。

对应 spec：R2.4b.2（ResourceAttrs）、R2.5（RuleConfig）、R4（评分输出）。
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from datetime import date
from enum import Enum
from typing import Any

# ---------------------------------------------------------------------------
# 实例属性 —— R2.4b.2
# ---------------------------------------------------------------------------


class ResourceRole(str, Enum):
    """这台资源在它的复制拓扑里**是什么角色**。全仓唯一一份取值定义。

    🔴 **存在的理由是一次真实的 P0 事实错误**（2026-09-01）：

    ```
    notiops-tb-redis-ap-northeast-1-001
      ReplicationGroup  notiops-tb-redis-ap-northeast-1
      MemberClusters    [notiops-tb-redis-ap-northeast-1-001]   ← 只有 1 个成员
      NodeGroupMembers[0].CurrentRole  primary                  ← 它是主
      NumCacheNodes     1
    ```

    而 `AWS/ElastiCache` 的 `ReplicationLag` 对这台 **primary 确实有数据**
    （集群维度与节点维度都有）。判读 skill 当时的启发式是
    「有 ReplicationLag → 它是 replica」，于是把一台单节点主库判成
    `standby_replica` / `expected_behaviour` / `leave_alone` —— 三项全错。

    ## 修法：角色是 Describe API 的事实，不是从指标反推的推断

    ```
    RDS 普通实例    ReadReplicaSourceDBInstanceIdentifier 有值 → 副本
    Aurora 成员     DBClusterMembers[].IsClusterWriter          → writer / reader
    ElastiCache     NodeGroups[].NodeGroupMembers[].CurrentRole → primary / replica
    ```

    ⚠️ **不能看名字**。实测本账号有一台叫 `zetl-aurora-reader` 的实例
    `IsClusterWriter=true`（failover 过之后名字与实际角色相反，AWS 不改名）。

    ⚠️ `UNKNOWN` 与 `None` 是**两件事**，见 `ResourceAttrs.resource_role`。
    """

    RDS_STANDALONE = "rds_standalone"
    RDS_READ_REPLICA = "rds_read_replica"
    AURORA_WRITER = "aurora_writer"
    AURORA_READER = "aurora_reader"
    REDIS_PRIMARY = "redis_primary"
    REDIS_REPLICA = "redis_replica"
    MEMCACHED = "memcached"
    """Memcached 没有复制机制，所以它的角色维度只有这一个值。"""
    UNKNOWN = "unknown"
    """**试过了但判不出来** —— 如 Aurora 成员但 `describe_db_clusters` 失败。

    ⚠️ 判读侧遇到它 SHALL NOT 补一个猜测（「大概是主库吧」），
    也 SHALL NOT 据此给出破坏性建议 —— 角色未知时「删掉」和
    「删掉一台灾备」在证据上不可区分。
    """

    @property
    def is_replica(self) -> bool:
        """是不是「别人的副本」。写路径别用它做判定，用具体角色值。"""
        return self in _REPLICA_ROLES

    @property
    def is_writable(self) -> bool:
        """是不是可写节点。`UNKNOWN` 返回 False —— 不知道就不声称。"""
        return self in _WRITABLE_ROLES


_REPLICA_ROLES: frozenset[ResourceRole] = frozenset({
    ResourceRole.RDS_READ_REPLICA,
    ResourceRole.AURORA_READER,
    ResourceRole.REDIS_REPLICA,
})

_WRITABLE_ROLES: frozenset[ResourceRole] = frozenset({
    ResourceRole.RDS_STANDALONE,
    ResourceRole.AURORA_WRITER,
    ResourceRole.REDIS_PRIMARY,
    ResourceRole.MEMCACHED,
})


def resolve_role(attrs: "ResourceAttrs") -> ResourceRole:
    """读取角色的**唯一入口**。适配器没设时按既有布尔字段回退推导。

    ```
    attrs.resource_role is None       适配器没设 → 回退推导（过渡期）
    attrs.resource_role is UNKNOWN    适配器试了但判不出 → 原样返回，**不回退**
    其余                              适配器给的 Describe 事实 → 原样返回
    ```

    ⚠️ 这两档必须分开。合成一个的后果：Aurora 成员遇上
    `describe_db_clusters` 失败时 `is_cluster_writer` 是 `False`
    （因为 writer_id 拿不到），回退推导会读出 `AURORA_READER` ——
    把「不知道」变成了「它是只读副本」，而 cost-idle 会据此说
    「这是 standby，别动」。谎称知道比承认不知道更坏。
    """
    declared = attrs.resource_role
    if declared is not None:
        return declared

    svc = (attrs.service or "").strip().lower()
    eng = (attrs.engine or "").strip().lower()

    if svc == "elasticache":
        if eng.startswith("memcached"):
            return ResourceRole.MEMCACHED
        return (ResourceRole.REDIS_REPLICA if attrs.is_read_replica
                else ResourceRole.REDIS_PRIMARY)

    if svc == "rds":
        # `aurora` 是 5.6 时代的旧引擎名，`aurora-mysql` / `aurora-postgresql` 是现名。
        if eng.startswith("aurora"):
            return (ResourceRole.AURORA_WRITER if attrs.is_cluster_writer
                    else ResourceRole.AURORA_READER)
        return (ResourceRole.RDS_READ_REPLICA if attrs.is_read_replica
                else ResourceRole.RDS_STANDALONE)

    return ResourceRole.UNKNOWN


@dataclass(frozen=True)
class ResourceAttrs:
    """单个实例的静态属性快照。

    这是 R2.1.2 / R3.7 / R4.4 / R7.3 / R7.4 / R7.5 六条需求的共同前置。
    由 repository 层（Phase 4）从 describe API + 参数组 + 规格表拼出来。

    ⚠️ `memory_bytes` / `max_connections` / `baseline_iops` 允许为 None。
    domain 层遇到 None SHALL 丢弃对应维度并重归一化权重（见 scoring.idle），
    SHALL NOT 拿 0 或猜测值继续算 —— 那会静默产出错误分数。
    """

    instance_id: str
    service: str                                # rds | elasticache | ec2
    instance_class: str
    engine: str = ""
    engine_version: str = ""                    # 完整版本，如 8.0.mysql_aurora.3.10.5

    account_id: str = ""
    region: str = ""

    # 规格（可能缺失）
    memory_bytes: int | None = None
    allocated_storage_gb: float | None = None
    max_allocated_storage_gb: float | None = None   # R7.3 判是否会自动扩容
    max_connections: int | None = None
    baseline_iops: int | None = None

    # 配置属性
    maxmemory_policy: str | None = None         # R7.4 判 noeviction
    multi_az: bool = False
    is_cluster_writer: bool = False
    num_cache_nodes: int | None = None

    # 结构性风险用（R2.4.2）
    # ⚠️ 三个都用 None 表示「没读到」，不是 False / 0 —— 规则遇到 None 一律跳过。
    # 把「不知道备份开没开」当成「没开」会造出零误报规则里最刺眼的一类误报。
    storage_type: str | None = None             # gp2 | gp3 | io1 | io2 | aurora | standard
    backup_retention_days: int | None = None    # 0 = 未开自动备份
    read_replica_count: int | None = None
    is_read_replica: bool = False               # 它自己是不是别人的只读副本
    cluster_id: str | None = None

    # ── 复制拓扑里的角色 —— 判读侧的关键事实（见 `ResourceRole` 的 P0 记录）────
    #
    # 🔴 **不要直接读这个字段，读 `resolve_role(attrs)`。** 三态语义：
    #
    #    ```
    #    None              适配器没设 → resolve_role 按 is_read_replica /
    #                      is_cluster_writer 回退推导（过渡期兼容）
    #    UNKNOWN           适配器试过但判不出（如 describe_db_clusters 失败）
    #                      → resolve_role 原样返回，**不回退**
    #    其余具体值        Describe API 的事实
    #    ```
    #
    # ⚠️ `is_read_replica` 保留不删：9 处结构性规则用它做**抑制**判定
    #    （副本单 AZ / 副本没开备份都是预期，不报）。那些地方 False 是保守方向
    #    （报出来让人看），换成三态会把「不知道」变成「不报」。
    #    判读载荷这一侧才需要区分三态 —— 那里 False 的代价是误删。
    resource_role: ResourceRole | None = None

    ca_cert_identifier: str | None = None       # 如 rds-ca-rsa2048-g1

    # Aurora 的高可用在**集群层**，实例层的 multi_az 恒为 false。
    # ⚠️ 2026-08-17 实测：zetl-aurora 集群 MultiAZ=true、成员实际跨 us-east-1a/1b，
    #    但两个成员实例的 MultiAZ 字段都是 false。只读实例层字段会产出 4 条误报。
    #    所以 Aurora SHALL 用下面两个字段判，不用 multi_az。
    # ElastiCache 复用 cluster_multi_az（映射自 ReplicationGroup.MultiAZ 的
    #    'enabled'/'disabled' 枚举），并额外要看 automatic_failover ——
    #    官方要求生产两个都开，见 rules._single_az_elasticache。
    cluster_multi_az: bool | None = None        # DBCluster.MultiAZ ｜ RG.MultiAZ
    cluster_az_count: int | None = None         # 成员实例落在几个不同 AZ
    automatic_failover: bool | None = None      # ElastiCache RG.AutomaticFailover

    # ── Performance Insights（判读侧用，不参与阈值判定）────────────────────
    #
    # 🔴 存在的理由：`DBLoad`（AAS）是官方的负载度量，而它只在 PI 里，
    #    不在 CloudWatch 基础指标里。判读 skill 要靠这两个字段知道
    #    **能不能用 PI**：
    #
    #    ```
    #    enabled = None   没读到（ElastiCache 压根没有 PI，或 API 没返回）
    #    enabled = False   客户没开 → skill SHALL NOT 建议「去看 PI」
    #    enabled = True    可以用，但还要看保留期够不够
    #    ```
    #
    # ⚠️ 保留期必须一起给。PI 默认只留 **7 天**，而巡检的 `data_date` 是
    #    「最后一个完整 UTC 日」—— 回填场景下可能是 30 天前，那时 PI 里
    #    压根没有那天的数据。只给 enabled 会让 skill 说「已查 PI，DBLoad 正常」
    #    而它实际什么都没查到。
    #
    # ⚠️ 字段名对齐 `DescribeDBInstances` 的 `PerformanceInsightsEnabled` /
    #    `PerformanceInsightsRetentionPeriod`（2026-08-23 从 boto3 service
    #    model 确认，类型分别是 boolean / integer）。
    performance_insights_enabled: bool | None = None
    performance_insights_retention_days: int | None = None

    tags: Mapping[str, str] = field(default_factory=dict)
    tier: str = "nonprod"                       # tier1 | prod | nonprod（R7.5）

    # 溯源：哪些字段是估算来的，不是权威读到的
    estimated_fields: frozenset[str] = frozenset()

    def is_estimated(self, field_name: str) -> bool:
        return field_name in self.estimated_fields

    def with_estimated(self, *names: str) -> ResourceAttrs:
        return replace(self, estimated_fields=self.estimated_fields | frozenset(names))


# ---------------------------------------------------------------------------
# 规则配置 —— R2.5
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IdleRuleConfig:
    """低利用率（R2.2）的门槛。

    取代老的 `lambda1_collector.threshold.ThresholdConfig`：那个用
    `dict[str, float]` + 18 个 @property 兜默认值，真源不明且拼错 key 会静默拿默认值。
    这里改成显式字段 —— 拼错就是 TypeError。
    """

    # 入选门槛（AND 语义，R2.2.1）
    candidate_cpu_avg: float = 2.0
    candidate_connections: int = 5

    # 峰值否决（R2.2.2，承接老 peak_veto）
    peak_cpu_veto: float = 50.0

    # 隐形负载否决
    iops_total: int = 500
    write_iops: int = 1000
    evictions: int = 0
    requests_per_minute: int = 1000
    """ElastiCache「还有人在用」的门槛，单位是 **平均每分钟请求数**。

    ⚠️ 这个字段原名 `requests_sum`，而喂给它的数据从来不是窗口总量：
    `CacheHits` / `GetHits` 取的是 `Average` 统计量，在 `period=86400` 下
    它等于「那一天各个 1 分钟数据点的平均值」= 平均每分钟命中数。
    拿它去比一个叫 `requests_sum` 的门槛，两边量纲对不上，
    而对不上的地方不会报错 —— 只会给出一个谁也说不清依据的结论。

    ⚠️ 只改名不改数值（默认仍是 1000），所以**判定行为完全不变**。
    1000 次/分钟 ≈ 17 rps，作为「这个缓存还在服务流量」的门槛是合理的。
    要真的按窗口总量判，得给 `STATS` 加 `Sum` —— 那会让采集成本涨 25%（多一个
    统计量就是多一份 query），且 `Sum` 对 `CurrConnections` 这类瞬时量无意义，
    所以要按指标挑统计量而不是全量加。登记为后续任务，不在本批。
    """
    conn_max: int = 10

    # 慢性/连续低位（R2.6 的对偶：闲置侧的连续低天数）
    consecutive_days_step: float = 0.1          # value_score 的每日加成
    window_days: int = 7

    def __post_init__(self) -> None:
        if self.window_days <= 0:
            raise ValueError("window_days must be positive")
        if not 0.0 <= self.candidate_cpu_avg <= 100.0:
            raise ValueError("candidate_cpu_avg must be a percentage in [0, 100]")
        if not 0.0 <= self.peak_cpu_veto <= 100.0:
            raise ValueError("peak_cpu_veto must be a percentage in [0, 100]")


@dataclass(frozen=True)
class CapacityRuleConfig:
    """容量审计（老 capacity_audit，R4.1c 将并入 scan_structural）的门槛。"""

    free_storage_pct: float = 40.0
    """可用存储占比**高于**这个百分数即判超配（可以缩）。

    🔴 量纲是 **0~100 的百分数**，不是 0~1 的比例（用户 2026-08-23 定）。
    改的原因：同一个配置页上 `ThresholdRuleConfig.free_storage_pct` 是
    「低于 10% 告警」的百分数，两个都叫「可用存储占比」的字段一个填 0.4
    一个填 10，客户必然填错 —— 而填错的表现是门槛差 100 倍且不报错
    （填 40 当比例 → 「可用占比 > 4000%」→ 永不命中）。

    ⚠️ `capacity.audit_oversized_storage` 里除以 100 还原成比例再与
    `free_storage_ratio()` 比。"""
    cpu_max_veto: float = 50.0
    swap_max_gb: float = 0.01
    memory_util_max: float = 30.0


# ---------------------------------------------------------------------------
# 候选与评分输出 —— R4
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CandidateRecord:
    """一个实例在窗口内的指标聚合快照（闲置侧）。

    字段全部 Optional 的那些代表「可能没这个指标」（服务差异 + 采集缺口）。
    """

    instance_id: str
    service: str                        # rds | elasticache
    account_id: str = ""
    region: str = ""

    # 通用
    # ⚠️ 默认 None 而不是 0.0：「没采到数据」与「使用率是 0」必须可区分。
    # 默认 0.0 会让一条空记录看起来是「完美闲置」，是最坏的一种默认值。
    cpu_avg: float | None = None
    cpu_max: float | None = None
    peak_cpu_7d: float | None = None
    connections_avg: float | None = None
    peak_connections_7d: int | None = None

    # RDS
    free_storage_bytes: float | None = None
    read_iops: float | None = None
    write_iops: float | None = None
    write_iops_avg: float | None = None

    # ElastiCache
    # ⚠️ 只有 Redis / Valkey 有百分比形式的内存指标
    # （`DatabaseMemoryUsagePercentage`）。Memcached **没有** ——
    # 它只发 `BytesUsedForCacheItems`（绝对字节），要算占用率得自己拿
    # 节点内存做分母。所以 Memcached 上这个字段恒为 None，
    # 读它的规则必须按 None 处理，SHALL NOT 拿字节数当百分比。
    memory_usage_pct: float | None = None
    memory_used_bytes: float | None = None
    """已用内存绝对值。Redis 来自 BytesUsedForCache，
    Memcached 来自 BytesUsedForCacheItems。缺分母，只做证据不做判定。"""
    evictions: int | None = None
    cache_hits: float | None = None
    cache_misses: float | None = None
    swap_usage_bytes: float | None = None
    # ⚠️ EngineCPUUtilization ≠ CPUUtilization。Redis 是单线程的，
    # 引擎 CPU 打满时整机 CPU 可能还很低（多核只有一核在忙）。
    # 容量判定 SHALL 用 engine_cpu_max，用 cpu_max 会把打满的实例判成空闲。
    # ⚠️ Memcached 是多线程的且**没有** EngineCPUUtilization 指标，
    # 该字段恒为 None，它的 CPU 判定走 cpu_avg / peak_cpu_7d（整机 CPU）。
    engine_cpu_max: float | None = None

    network_in: float | None = None
    network_out: float | None = None
    network_unit: str | None = None
    """`network_in` / `network_out` 的单位。**必须带着走**：
    RDS/Aurora 的 Network*Throughput 是 `bytes_per_second`，
    ElastiCache 的 NetworkBytesIn/Out 是 `bytes`（累计量）。
    两者数值差三个数量级，跨服务直接比较会得出荒谬结论。"""


class BasisCode(str, Enum):
    """归一化依据的机器可读编码。

    ⚠️ domain 层 SHALL NOT 产出任何自然语言文案 —— 文案要过 i18n（R10.9），
    中文写死在这里就翻译不了。这里只出 code + params，渲染交给展示层。
    """

    CPU_PCT = "cpu_pct"
    CONN_OVER_MAX = "conn_over_max"
    STORAGE_FREE_RATIO = "storage_free_ratio"
    IOPS_OVER_BASELINE = "iops_over_baseline"
    MEMORY_PCT = "memory_pct"
    REQUESTS_OVER_THRESHOLD = "requests_over_threshold"

    # 不可用的原因
    METRIC_MISSING = "metric_missing"
    DENOMINATOR_UNKNOWN = "denominator_unknown"
    DENOMINATOR_INVALID = "denominator_invalid"
    NOT_APPLICABLE = "not_applicable"
    """该维度对这类资源**不存在**，不是「暂时取不到」。
    ⚠️ 与 DENOMINATOR_UNKNOWN 必须分开：前者永远不会有值（Aurora 的存储自动增长，
    没有「分配容量」这个概念），后者是这次没读到、下次可能有。
    混成一个会让运维一直去查一个永远查不到的东西。"""


class DenominatorSource(str, Enum):
    """归一化分母是从哪来的 —— 客户会问「你凭什么说我 max_connections 是 1000」。"""

    PARAMETER_GROUP = "parameter_group"     # 读到的实际参数组值，最权威
    PUBLISHED_TABLE = "published_table"     # AWS 公布的默认值表
    FORMULA = "formula"                     # 按参数组公式推算，是估算
    SPEC_DEFAULT = "spec_default"           # 我们配置里的门槛


@dataclass(frozen=True)
class Dimension:
    """闲置评分的一个维度的明细 —— 报告要能逐维度解释分数怎么来的。"""

    name: str
    weight: float                       # 重归一化**后**实际生效的权重
    raw_weight: float                   # 配置里声明的原始权重
    normalized_value: float | None      # 0~1，越大越闲；None = 该维度不可用
    points: float                       # 本维度贡献的分数
    basis_code: BasisCode | None = None
    basis_params: Mapping[str, Any] = field(default_factory=dict)

    @property
    def available(self) -> bool:
        return self.normalized_value is not None


class PricePrecision(str, Enum):
    """成本估算有多可信 —— 必须能传到 UI 与报告（R11e.3）。

    ⚠️ 五档是**有序的**，靠 `confidence_rank` 表达，`is_coarse` 只回答
    「能不能当成一个数字报给客户」这一个问题。早期版本只有 `is_coarse` 一个属性，
    且定义成「除 TABLE_UNVERIFIED_REGION 之外都算 coarse」——
    这与价格表自己的说明**直接矛盾**：
    `pricing_estimates.json` 的 `_region_note` 写着「在 region 未核实之前，
    **本表的任何取值都标记为 coarse**」，理由是跨区价差可达 30%+。
    两处打架时以数据文件为准：区域没核实就是 coarse，无论表里有没有 `as_of`。
    """

    EXACT_API = "exact_api"
    """从 AWS Price List API 按 (区域, 规格, 引擎) 精确取到的价。

    ⚠️ **当前没有任何代码路径产出这一档** —— 它由 落地。
    放在这里是为了让 `is_coarse` 成为一个真正依赖取值的判断，
    而不是一个恒 True 的摆设；也让「目标形态是什么」写在类型里而不是注释里。
    有测试锁住「现在确实没人产出它」。"""

    TABLE_UNVERIFIED_REGION = "table_unverified_region"
    """命中价格表的精确条目、表有 `as_of`，但**没记区域** —— 跨区误差可达 30%+。
    这是当前能达到的最好一档，但它**仍然是 coarse**：
    30% 的误差足以让跨服务排序换个次序。"""

    TABLE_NO_PROVENANCE = "table_no_provenance"
    """命中精确条目，但表**连 `as_of` 都没有** —— 不知道是哪天、哪个区域的价。
    比 UNVERIFIED_REGION 更差：那个至少知道数据什么时候采的。"""

    COARSE_KEYWORD = "coarse_keyword"
    """只按规格关键字（large / 2xlarge…）猜的，同规格不同家族价差数倍。"""

    COARSE_DEFAULT = "coarse_default"
    """连关键字都没命中，用的是全局兜底常数。排序里几乎无意义。"""

    @property
    def confidence_rank(self) -> int:
        """0 = 最可信。跨服务排序 SHALL 先按它分桶，再按金额（R4.6）。

        ⚠️ 不这么做的后果：一个 `COARSE_DEFAULT` 猜出来的 $1000 会排在
        查表得到的 $1061 前面 —— 报告第一行是个凭空捏造的数字，
        而客户会照着它去动资源。
        """
        return _PRICE_CONFIDENCE_RANK[self]

    @property
    def is_table_hit(self) -> bool:
        """是否命中了表里的精确条目（而不是按关键字猜的）。UI 的「查表/估算」标签用它。"""
        return self in (
            PricePrecision.EXACT_API,
            PricePrecision.TABLE_UNVERIFIED_REGION,
            PricePrecision.TABLE_NO_PROVENANCE,
        )

    @property
    def is_coarse(self) -> bool:
        """能不能把这个金额当成一个数字报给客户。只有 `EXACT_API` 可以。

        ⚠️ 「命中了表里的条目」≠「可以报数」：表里没记区域，
        而价格按区域差异可达 30%+（见 `pricing_estimates.json` 的 `_region_note`）。
        """
        return self is not PricePrecision.EXACT_API


# 单独一张表而不是写在 property 里：加档位时必须同时给出它的位置，
# 漏了会 KeyError 而不是静默拿到一个默认排名。
_PRICE_CONFIDENCE_RANK: dict[PricePrecision, int] = {
    PricePrecision.EXACT_API: 0,
    PricePrecision.TABLE_UNVERIFIED_REGION: 1,
    PricePrecision.TABLE_NO_PROVENANCE: 2,
    PricePrecision.COARSE_KEYWORD: 3,
    PricePrecision.COARSE_DEFAULT: 4,
}


@dataclass(frozen=True)
class PriceEstimate:
    """成本估算结果。`monthly_usd` 永远有值，但要连着 `precision` 一起看。

    ⚠️ 老实现只返回一个 float，调用方无法区分「查到精确价」与「按关键字猜的 $60」。
    而 R4.6 拿它当「唯一可比的共同标尺」做跨服务排序 —— 排序会被兜底值主导且无人察觉。
    """

    monthly_usd: float
    precision: PricePrecision
    matched_key: str | None = None      # 命中的表键，便于溯源
    as_of: str | None = None
    region: str | None = None
    num_nodes: int = 1

    @property
    def is_coarse(self) -> bool:
        return self.precision.is_coarse

    @property
    def is_table_hit(self) -> bool:
        return self.precision.is_table_hit

    @property
    def confidence_rank(self) -> int:
        return self.precision.confidence_rank


@dataclass(frozen=True)
class IdleScore:
    """R4 的评分结果。"""

    instance_id: str
    service: str
    idle_score: float | None            # 0~100；**None = 判据不足，本轮未判定**
    value_score: float | None           # idle_score × size_weight × days_factor
    size_weight: float
    consecutive_low_days: int
    consecutive_days_factor: float
    estimated_monthly_savings: PriceEstimate | None
    dimensions: tuple[Dimension, ...] = ()
    degraded_dimensions: tuple[str, ...] = ()   # 因缺数据被丢弃并重归一化的维度
    available_weight: float = 0.0
    """可用维度的**原始**权重之和（0~1）。判据还剩多少的度量。

    ⚠️ `idle_score is None` 时展示层 SHALL 显示「监控数据不足，本轮未判定」
    而不是一个数字。早期实现在所有维度都不可用时输出 **0**，
    而 0 在排序里等于「完全不闲」——「什么都不知道」被呈现成了
    「这台一点都不闲」，方向正好反了。停机的 RDS 实例就落在这个洞里：
    它不发指标 → 0 分 → 排最末，而它是全机队最该处置的那一台。
    """

    # 落库所需的三个键维度（同 Finding，理由见 Finding.finding_id 与 data_date）
    account_id: str = ""
    region: str = ""
    data_date: date | None = None

    @property
    def is_degraded(self) -> bool:
        return bool(self.degraded_dimensions)

    @property
    def is_judged(self) -> bool:
        """本轮是否真的算出了一个分。False = 判据不足（R4.7）。"""
        return self.idle_score is not None

    @property
    def monthly_usd(self) -> float | None:
        """排序用的裸金额。None = 没有价格信息（排序时 SHALL 排末尾而非当 0）。"""
        return (
            self.estimated_monthly_savings.monthly_usd
            if self.estimated_monthly_savings is not None else None
        )

    @property
    def savings_is_coarse(self) -> bool:
        """R11e.3：兜底值命中的条目要在 UI 与报告里显式标出来。"""
        return (
            self.estimated_monthly_savings.is_coarse
            if self.estimated_monthly_savings is not None else True
        )

    @property
    def savings_confidence_rank(self) -> int:
        """跨服务排序的分桶键（R4.6）。没有价格信息时排最后一桶。"""
        return (
            self.estimated_monthly_savings.confidence_rank
            if self.estimated_monthly_savings is not None
            else len(_PRICE_CONFIDENCE_RANK)
        )


class VetoReason(str, Enum):
    """为什么这个实例不算闲置。"""

    PEAK_VETO = "peak_veto"                 # 有业务高峰（R2.2.2）
    IO_INTENSIVE = "io_intensive"           # RDS IOPS 高
    EVICTING = "evicting"                   # ElastiCache 在驱逐 key
    REQUEST_BUSY = "request_busy"           # 请求量高
    CONN_BUSY = "conn_busy"                 # 连接峰值高


class VetoOutcome(str, Enum):
    """判定结果本身也要可机读 —— 「因缺数据放行」和「确认不忙」不是一回事。"""

    PASS = "pass"                           # 确认不忙
    PASS_NO_DATA = "pass_no_data"           # 缺数据，保守放行（未做判定）
    PASS_NO_RULE = "pass_no_rule"           # 该服务没有这条规则
    VETOED = "vetoed"


@dataclass(frozen=True)
class VetoResult:
    """否决结果 —— 被否决的实例也要能说清是哪条规则否的（R9.x 要展示）。

    ⚠️ 不带自然语言文案，同 Dimension：`rule` / `outcome` / `reason` 是 code，
    数值在 `params` 里，文案由展示层按 i18n 渲染。
    """

    instance_id: str
    rule: str                               # 'peak_veto' | 'hidden_load_check'
    outcome: VetoOutcome
    reason: VetoReason | None = None
    params: Mapping[str, Any] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return self.outcome is not VetoOutcome.VETOED


# ---------------------------------------------------------------------------
# 结构性风险 —— R2.4
# ---------------------------------------------------------------------------


class CapacityRule(str, Enum):
    """容量超配规则码 —— 承接老 `engine.capacity_audit`（R4.1c）。

    ⚠️ **与结构性风险不是一类**，虽然都产出 Finding：
        结构性风险  纯属性判定，零指标（R2.4.1）
        容量超配    必须读指标（剩余存储 / 内存占用 / CPU 峰值）
    所以它落在 `scoring/capacity.py` 而不是 `structural/`，
    输出归②「闲置与优化」而不是结构性风险页。理由详见 R4.1c 的修正说明。

    ⚠️ 老实现声明了 `oversized_compute` 但代码从不产出，这里不保留这个死枚举值。
    """

    OVERSIZED_STORAGE = "oversized_storage"     # RDS 存储开太大
    OVERSIZED_MEMORY = "oversized_memory"       # ElastiCache 内存开太大


class StructuralRule(str, Enum):
    """结构性风险的规则码（R2.4.2）。

    值同时用作 `finding_id` 里的 `<rule_id>` 段（R6.1），所以一旦发布
    SHALL NOT 改动 —— 改了等于旧 finding 全部失联、计数重置。
    """

    GP2_VOLUME = "gp2_volume"                   # 应迁 gp3
    BURSTABLE_IN_PROD = "burstable_in_prod"     # 生产用 T 系
    SINGLE_AZ_IN_PROD = "single_az_in_prod"     # 生产库单 AZ
    BACKUP_DISABLED = "backup_disabled"         # 自动备份未开
    NO_READ_REPLICA = "no_read_replica"         # 无只读副本
    CA_CERT_EXPIRING = "ca_cert_expiring"       # RDS CA 证书临期
    ENGINE_EOL = "engine_eol"                   # 引擎大版本 EOL

    NO_CAPACITY_METADATA = "no_capacity_metadata"
    """拿不到实例规格（总内存 / 分配存储），因此**按规格百分比的判定对它无效**。

    🔴 这一项不是「资源配置有问题」，而是「我们对这台资源判不了某类风险」。
    它仍然归结构性风险，因为它是**属性层面**的缺失（零指标）、且动作是
    补权限或补规格表，与负载无关。

    为什么必须产出一条 finding 而不是静默跳过：内存与存储改成按规格百分比
    判定之后（用户 2026-08-23 定），分母缺失意味着那两类告警对这台实例
    **永久静默**。而「没有内存告警」在看板上与「内存健康」长得完全一样。
    R9.11 那条「空列表的四种含义必须可区分」是同一个道理。

    ⚠️ 严重度固定 INFO：它本身不是风险，是一个盲区通知。
    ⚠️ **不派发 DA 判读**：要 AI 分析的是负载，而这条的动作是补
    `ec2:DescribeInstanceTypes` 权限 —— 判读它纯属浪费额度。
    """

    UNSUPPORTED_ENGINE = "unsupported_engine"
    """这台实例的引擎不在 v1 判定范围（DocumentDB / Neptune）。

    🔴 与 `NO_CAPACITY_METADATA` 同一类：不是「配置有问题」，而是
    「我们对它判不了」。

    ## 为什么必须报出来

    `aws rds describe-db-instances` **会返回** DocumentDB 与 Neptune 实例
    （它们共用 RDS 控制平面），所以它们会正常进入采集清单。但它们的
    CloudWatch 指标在 `AWS/DocDB` / `AWS/Neptune` namespace，而采集侧查的是
    `AWS/RDS` —— 于是每个指标都取不到值，`coverage_days` 为 0，
    `evaluate_threshold` 返回空 verdicts，这台实例**一条 finding 都不产**。

    表现是它在看板上完全消失，与「巡检过了、很健康」不可区分。
    2026-08-23 实测两个客户的 RDS 清单里就有 6 台（Neptune ×4 `1.4.5.1`、
    DocumentDB ×2 `3.6.0`），此前它们一直是静默跳过的。

    ⚠️ 严重度固定 INFO，不派发 DA —— 动作是「换用对应服务的巡检」或
    「确认无需巡检」，都不需要 LLM。
    """


class LifecyclePhase(str, Enum):
    """引擎版本所处的支持阶段。名称对齐 AWS 的 LifecycleSupportName 取值。"""

    STANDARD = "open-source-rds-standard-support"
    EXTENDED = "open-source-rds-extended-support"


@dataclass(frozen=True)
class LifecycleWindow:
    """一段支持窗口。"""

    phase: LifecyclePhase
    start_date: date | None
    end_date: date | None


@dataclass(frozen=True)
class EngineLifecycle:
    """某引擎某大版本的支持窗口集合。

    来源 `rds:DescribeDBMajorEngineVersions` 的 `SupportedEngineLifecycles`。
    ⚠️ 不是 `DescribeDBEngineVersions` —— 那个 shape 上没有这个字段，
    `bff/web-chat/eos.mjs:77-79` 就是踩了这个坑，导致 EOL 恒为 null（R11e.2b）。
    """

    engine: str
    major_version: str
    windows: tuple[LifecycleWindow, ...] = ()

    def window(self, phase: LifecyclePhase) -> LifecycleWindow | None:
        for w in self.windows:
            if w.phase is phase:
                return w
        return None

    @property
    def standard_end(self) -> date | None:
        w = self.window(LifecyclePhase.STANDARD)
        return w.end_date if w else None

    @property
    def extended_end(self) -> date | None:
        w = self.window(LifecyclePhase.EXTENDED)
        return w.end_date if w else None


@dataclass(frozen=True)
class StructuralRefData:
    """结构性风险需要的外部参考数据（R2.4b.4）。

    domain 层只消费，由 `inspection/adapters/refdata.py` 从 API 拉好后传入。
    两张表都允许为空 —— 空则对应规则跳过并标 `INSUFFICIENT_DATA`，
    SHALL NOT 猜日期。
    """

    # (engine, major_version) -> EngineLifecycle
    engine_lifecycles: Mapping[tuple[str, str], EngineLifecycle] = field(
        default_factory=dict
    )
    # CA 标识（如 rds-ca-rsa2048-g1）-> 到期日
    ca_cert_expiry: Mapping[str, date] = field(default_factory=dict)


@dataclass(frozen=True)
class StructuralRuleConfig:
    """结构性风险的门槛（R2.5）。"""

    # 提前多少天开始报
    engine_eol_lead_days: int = 180
    ca_cert_lead_days: int = 90

    # 哪些 tier 视为「生产」——「生产用 T 系」「生产库单 AZ」只在这些 tier 上判
    prod_tiers: frozenset[str] = frozenset({"tier1", "prod"})

    # 无只读副本：只对这些 tier 报（非生产库没副本是正常的）
    read_replica_required_tiers: frozenset[str] = frozenset({"tier1"})

    def __post_init__(self) -> None:
        if self.engine_eol_lead_days < 0 or self.ca_cert_lead_days < 0:
            raise ValueError("lead days must be non-negative")


@dataclass(frozen=True)
class Fingerprint:
    """判定指纹（R12.6b）—— 结构性风险按它去重后才交给 DA。

    同一指纹下的判读结论逐字相同，让 DA 推理 N 遍是纯浪费。
    ⚠️ 指纹只共享「这类问题该怎么办」，共享不了 per-instance 数值。
    """

    service: str
    instance_class: str
    engine_major: str
    rules: tuple[str, ...]          # 已排序，保证同一组规则产生同一指纹
    tier: str

    @property
    def key(self) -> str:
        return "|".join(
            (self.service, self.instance_class, self.engine_major,
             ",".join(self.rules), self.tier)
        )


class Severity(str, Enum):
    """严重度四档（R7.2a）。**全仓唯一一份取值定义。**

    ⚠️ 大小写曾经是分叉的：`Finding.severity` 默认 `"info"`（小写）、
    9 处规则里硬写 `"high"`/`"medium"`/`"info"`，而 `payload.VALID_SEVERITIES`
    是大写四值 → 把 `Finding.severity` 直接喂进 `build_payload()` **必抛**
    `PayloadContractError`。做成 `str` 子类的枚举后两边共用同一份，
    且 `Severity.HIGH == "HIGH"` 仍成立，JSON 序列化不用特殊处理。

    ⚠️ 与 DA `Recommendation.priority` 枚举（只有 HIGH/MEDIUM/LOW）**不是同一套** ——
    那边表达不了 CRITICAL。这也是 R9.1 禁止依赖 DA 侧分级的原因之一。
    """

    CRITICAL = "CRITICAL"
    HIGH = "HIGH"
    MEDIUM = "MEDIUM"
    INFO = "INFO"

    @property
    def order(self) -> int:
        """排序用：越小越严重。"""
        return _SEVERITY_ORDER[self]

    @classmethod
    def coerce(cls, value: "str | Severity") -> "Severity":
        """容错解析（含历史小写值）。无法识别抛 `ValueError` 而不是静默落 INFO ——
        静默落 INFO 会让一条 CRITICAL 悄悄降级成不推送（R7.7：INFO 不推 IM）。
        """
        if isinstance(value, cls):
            return value
        try:
            return cls(str(value).strip().upper())
        except ValueError:
            raise ValueError(
                f"未知 severity {value!r}；合法值 {[m.value for m in cls]}"
            ) from None


_SEVERITY_ORDER: dict[Severity, int] = {
    Severity.CRITICAL: 0,
    Severity.HIGH: 1,
    Severity.MEDIUM: 2,
    Severity.INFO: 3,
}


class Unavailable(str, Enum):
    """载荷里「这个指标没有值」的原因。

    设计的原话：空数组把「拉了没数据」「压根没拉」「客户关了」三种事实
    压成同一个值。**对 cost-idle 判读这是会造成误删的**——

    ```
    cost-idle 第 1 步判「是不是灾备副本」，判据是副本专属指标 *有没有值*
    （不是数值大小 —— ReplicaLag=0 表示已追平，是健康而非「无复制」）。

    correlated 里没有 AuroraReplicaLag 这个键时，DA 面对两种完全相反的事实
    却看到同一个东西：
        这台不是 reader          → 不是副本 → 可以考虑删
        这台是 reader 但没采到    → 是副本   → 千万别删
    → 落到 disposition: delete，删掉一台真的 standby。
    ```

    所以缺失 SHALL 显式声明，且**必须区分「我们知道不该有」与「我们期望有但拿到空」**。

    ⚠️ 与 `adapters.metrics_repo.GapReason` 不是同一套，也**不该**合并：
    `GapReason` 描述采集侧发生了什么（含 `COLLECTION_FAILED` 这种运维事实），
    是 R3.5 可观测性缺口上报的输入；这里描述的是**载荷读者需要知道的语义**。
    合并会让 domain 反向依赖 adapters（当前依赖方向是 adapters → domain，单向）。
    """

    NOT_APPLICABLE = "not_applicable"
    """该引擎/角色本来就没有这个指标 —— **我们知道不该有**。
    如 Memcached 无 `ReplicationLag`、writer 无 `AuroraReplicaLag`、
    非 T 系实例无 `CPUCreditBalance`。
    ⇒ 判读时这**是一条有效证据**（「没有 AuroraReplicaLag」= 「这台不是 reader」）。"""

    NO_DATAPOINTS = "no_datapoints"
    """请求发出去了、API 正常返回、但窗口内没有数据点 —— **我们期望有却拿到空**。
    ⇒ 判读时这**不是证据**，只能得出 insufficient_evidence。
    与 NOT_APPLICABLE 的区别正是 cost-idle 第 1 步的关键。"""

    COLLECTION_FAILED = "collection_failed"
    """采集本身失败（限流/权限/网络）。这台实例本轮**没有被真正评估**。
    ⇒ 判读 SHALL 落 insufficient_evidence，不得据此下结论。"""

    NOT_REQUESTED = "not_requested"
    """请求根本没发出去。如指标只有集群维度而这台拿不到 cluster_id。
    ⇒ 与 COLLECTION_FAILED 同样不可作为证据，但根因不同（我们的编排缺陷，非 AWS 侧）。"""


@dataclass(frozen=True)
class Finding:
    """一条结构性风险发现。

    `finding_id` 按 R6.1 的业务键推导，跨 run 稳定：
        <account>#<service>#<instance>#<rule_id>#<metric>
    结构性风险没有 metric 维度，该段固定为 `-`。
    """

    account_id: str
    service: str
    instance_id: str
    rule: StructuralRule | CapacityRule
    region: str = ""
    severity: Severity = Severity.INFO      # 结构性默认 INFO（R7.2a）
    cadence: str = "monthly"                # R2.4.3a；容量超配用 daily
    params: Mapping[str, Any] = field(default_factory=dict)
    fingerprint_key: str = ""

    # 数据窗口日期（R13.10 / R4.9）。由判定函数从 `today` 入参透传。
    # ⚠️ 必须随结果往下传，不能让写层自己调 `datetime.now()` ——
    # domain 层守住的确定性会在写层原地破掉，且同一天重跑会写出两个不同的 SK。
    data_date: date | None = None

    @property
    def finding_id(self) -> str:
        """R6.1 的业务键，跨 run 稳定。

        ⚠️ **必须含 region**：RDS DB instance identifier 只在**区域内**唯一。
        同一账号 us-east-1 与 ap-northeast-1 各有一台 `prod-mysql` 时，
        不含 region 的 key 会完全相同 → R6.8 的条件写互相覆盖 →
        一个区域的 finding 状态被另一个区域驱动。
        `region` 为空时降级为 `-`，保持段数固定（便于 DDB 侧解析）。
        """
        return "#".join((
            self.account_id,
            self.region or "-",
            self.service,
            self.instance_id,
            self.rule.value,
            "-",                            # metric 段：结构性/容量无此维度
        ))


@dataclass(frozen=True)
class FingerprintGroup:
    """一个指纹 + 它覆盖的全部 finding。这才是交给 DA 的单位。"""

    fingerprint: Fingerprint
    findings: tuple[Finding, ...]

    @property
    def instance_ids(self) -> tuple[str, ...]:
        seen: dict[str, None] = {}
        for f in self.findings:
            seen.setdefault(f.instance_id, None)
        return tuple(seen)

    @property
    def instance_count(self) -> int:
        return len(self.instance_ids)
