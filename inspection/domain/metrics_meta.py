"""指标语义元数据（R3.3 / R3.4 / R3.6 / R3.6a）。

移植并扩写自一份早期的巡检脚本（workload-inspect）里的同名模块。
那份只有 BAD_UP / BAD_DOWN 两个元组（因为它只服务上色）；这里还要承载
「用哪个统计量判定」「哪个维度能取到」「哪些指标算流量标度」三件事。

⚠️ **未归类的指标 SHALL NOT 参与任何规则判定**（R3.3）。
原 skill 的教训写在它的 docstring 里：两个渲染器各自维护一份方向表，漂移到
「命中率永远不上色」。这里是唯一来源。

## 四张表分别管什么

```
DIRECTION      越大越坏 / 越小越坏     → headroom 方向归一、越线判断
KIND           比率饱和型 / 流量标度型  → R3.4 决定走哪些规则
JUDGE_STAT     用哪个统计量判定         → R3.2 的「按语义选统计量」
DIMENSIONS     实例维度 / 集群维度      → R3.6a，少数卷级指标只有集群维度
```

## 采集清单按【引擎】分族，不按服务分（R3.8a）

早期版本只分三族（`rds` / `aurora` / `elasticache`），六条静默错误全出自这里 ——
清单里的指标名对族里的一半引擎根本不存在，`GetMetricData` 照收钱、返回空数组、
判定永久零命中，而且每天产出一条「永远修不好」的可观测性缺口：

```
族          清单里的指标                     对哪个引擎不存在
─────────  ──────────────────────────────  ────────────────────────────────
aurora      AuroraVolumeBytesLeftTotal      Aurora PostgreSQL（只有 MySQL 有）
elasticache EngineCPUUtilization            Memcached（多线程，没有引擎 CPU 概念）
elasticache DatabaseMemoryUsagePercentage   Memcached
elasticache CacheHits / CacheMisses         Memcached（叫 GetHits / GetMisses）
elasticache ReplicationLag                  Memcached（无复制）
rds/aurora  NetworkIn / NetworkOut          两者都没有 —— 那是 EC2 的指标名
```

`elasticache` 那一族的后果最重：Memcached 节点的三个闲置维度全部取不到值，
`_build_dimensions` 的 `available_weight` 归零 → **闲置分恒为 0**，
容量审计因 `memory_usage_pct is None` **永不执行**。两者都无声无息。

所以族的粒度 = 引擎：
```
rds-mysql · rds-postgres · rds-other · aurora-mysql · aurora-postgresql
redis（含 valkey）· memcached
```
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from inspection.domain import specs
from inspection.domain.dto import ResourceRole


class Direction(str, Enum):
    """指标往哪个方向变是坏事。"""

    BAD_UP = "bad_up"           # 越大越坏：CPU、Swap、延迟
    BAD_DOWN = "bad_down"       # 越小越坏：可用内存、剩余存储、命中率


class MetricKind(str, Enum):
    """R3.4 的分类。决定这个指标能走哪些规则。"""

    RATIO_SATURATION = "ratio_saturation"
    """比率/饱和型。有天然上界或明确的饱和点，可做水位判定。"""

    TRAFFIC_SCALED = "traffic_scaled"
    """流量标度计数型。值随业务量成比例变动 ——
    周末流量下降会让 CacheHits 下降并命中 BAD_DOWN，那是语义错误不是算法误差。
    v1 只走 R2.6 慢性高位；有规格分母的（DatabaseConnections 对 max_connections）
    可另走 R2.1.3 的相对规格阈值。"""

    ORDINAL_STATE = "ordinal_state"
    """序数状态枚举，**不是连续量**。`AuroraMemoryHealthState` 取 0 / 5 / 10
    三个离散档位（0 = 健康）。
    ⚠️ 它 SHALL NOT 走 `headroom()`：`(T − x)/|T|` 对档位编码没有意义，
    「从 5 到 10」不代表恶化了一倍。只能做等值比较，或直接当证据交给 DA 判读。"""


class Dimension(str, Enum):
    """R3.6a：指标登记在哪个维度下。"""

    INSTANCE = "instance"       # DBInstanceIdentifier / CacheClusterId
    CLUSTER = "cluster"         # DBClusterIdentifier / ReplicationGroupId
    BOTH = "both"


class MetricFamily(str, Enum):
    """采集清单的键。粒度 = 引擎，理由见模块 docstring。"""

    RDS_MYSQL = "rds-mysql"
    RDS_POSTGRES = "rds-postgres"
    RDS_OTHER = "rds-other"
    """v1 范围外的 RDS 引擎（mariadb / oracle / sqlserver）。
    给一份保守的通用清单，避免「不在范围内」变成「静默不采集」。"""
    AURORA_MYSQL = "aurora-mysql"
    AURORA_POSTGRES = "aurora-postgresql"
    REDIS = "redis"             # 含 valkey：指标名与 Redis OSS 完全一致
    MEMCACHED = "memcached"


# ---------------------------------------------------------------------------
# 统一元数据表
# ---------------------------------------------------------------------------


class _M:
    """一条指标的元数据。用轻量类而不是 dataclass，因为这张表是纯常量。"""

    __slots__ = ("direction", "kind", "judge_stat", "dimension", "note")

    def __init__(self, direction, kind, judge_stat, dimension=Dimension.INSTANCE,
                 note=""):
        self.direction = direction
        self.kind = kind
        self.judge_stat = judge_stat
        self.dimension = dimension
        self.note = note


_UP, _DOWN = Direction.BAD_UP, Direction.BAD_DOWN
_RATIO, _TRAFFIC = MetricKind.RATIO_SATURATION, MetricKind.TRAFFIC_SCALED
_ORDINAL = MetricKind.ORDINAL_STATE
_INST, _CLUS, _BOTH = Dimension.INSTANCE, Dimension.CLUSTER, Dimension.BOTH

# judge_stat 的取值 = CloudWatch 统计量名，或 'p95'
#
# ⚠️ **日 min 不是可选项**（R3.2）：
#   FreeableMemory 锯齿型（每晚批处理占用、白天释放）的日均完全平坦，
#   只有日 min 在抬升 —— 这正是客户描述的内存问题的常见真实形态。
#   CPUCreditBalance 白天耗夜里回，日均健康但每天下午撞零，同样只有日 min 说得出真相。
#   所以 BAD_DOWN 的指标一律用 Minimum 判定。
#
# ⚠️ **p95 只能写在 `AWS/RDS` 的指标上**（R3.2a）。百分位需要原始数据点，
#   官方支持清单只有 API Gateway / ALB / EC2 / ELB / Kinesis / Amazon RDS：
#   https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html
#   `AWS/ElastiCache` 不在其中 —— 对它请求 p95 会拿到空数组（照样计费）。
#   共用的指标名（CPUUtilization）由 `judge_stat_of(metric, family)` 按族降级。
METRICS: dict[str, _M] = {
    # ── 通用（RDS + ElastiCache 都有）──
    "CPUUtilization": _M(_UP, _RATIO, "p95", _BOTH,
                         "ElastiCache 上 p95 不受支持，按族降级为 Maximum"),
    "FreeableMemory": _M(_DOWN, _RATIO, "Minimum", _BOTH),
    "SwapUsage": _M(_UP, _RATIO, "Maximum", _BOTH),

    # ── 网络吞吐：RDS 与 ElastiCache 是【不同的指标名，不同的单位】──
    # ⚠️ 早期版本两边共用 `NetworkIn` / `NetworkOut` —— 那是 **EC2** 的指标名，
    #    在 AWS/RDS 与 AWS/ElastiCache 两个命名空间里都不存在，恒返回空。
    "NetworkReceiveThroughput": _M(_UP, _TRAFFIC, "Average", _BOTH,
                                   "RDS/Aurora，单位 Bytes/Second"),
    "NetworkTransmitThroughput": _M(_UP, _TRAFFIC, "Average", _BOTH,
                                    "RDS/Aurora，单位 Bytes/Second"),
    "NetworkBytesIn": _M(_UP, _TRAFFIC, "Average", _BOTH,
                         "ElastiCache，单位 Bytes（累计量，不是速率）"),
    "NetworkBytesOut": _M(_UP, _TRAFFIC, "Average", _BOTH,
                          "ElastiCache，单位 Bytes（累计量，不是速率）"),

    # ── RDS / Aurora ──
    "FreeStorageSpace": _M(_DOWN, _RATIO, "Minimum", _INST,
                           "Aurora 没有此指标（集群卷按需增长）"),
    "FreeLocalStorage": _M(_DOWN, _RATIO, "Minimum", _BOTH,
                           "Aurora 的本地临时存储 —— Aurora PG 真正的存储风险在这里"),
    # ⚠️ 维度是 _BOTH 而不是 _CLUS。早期注释写「实测实例维度为空」，复核 ListMetrics
    # 发现同一账号下它同时登记在 DBInstanceIdentifier 与 DBClusterIdentifier 上。
    # 标成 _CLUS 的后果：describe_db_clusters 失败 → cluster_id 为 None →
    # 该指标被整个 skip 并报一条 DIMENSION_UNAVAILABLE 缺口，
    # 而实例维度本来是能取到的。
    "AuroraVolumeBytesLeftTotal": _M(_DOWN, _RATIO, "Minimum", _BOTH,
                                     "⚠️ Aurora MySQL 专属，Aurora PG 没有"),
    "VolumeBytesUsed": _M(_UP, _RATIO, "Maximum", _CLUS,
                          "R3.6a 实测：只有集群维度"),
    "DatabaseConnections": _M(_UP, _TRAFFIC, "Maximum", _BOTH,
                              "R3.4a：对 max_connections 算 headroom 时可判定"),
    "DiskQueueDepth": _M(_UP, _RATIO, "p95", _BOTH),
    "ReadIOPS": _M(_UP, _TRAFFIC, "Average", _BOTH),
    "WriteIOPS": _M(_UP, _TRAFFIC, "Average", _BOTH),
    "ReadLatency": _M(_UP, _RATIO, "p95", _BOTH),
    "WriteLatency": _M(_UP, _RATIO, "p95", _BOTH),
    "ReplicaLag": _M(_UP, _RATIO, "Maximum", _INST,
                     "普通 RDS 的只读副本延迟；Aurora 非此名，用 AuroraReplicaLag"),
    "AuroraReplicaLag": _M(_UP, _RATIO, "Maximum", _BOTH,
                           "⚠️ 只在 reader 上有值，writer 上恒空"),
    "AuroraReplicaLagMaximum": _M(_UP, _RATIO, "Maximum", _BOTH,
                                  "⚠️ 与上一条相反：只有 writer 记录它"),

    # 天然余量指标（R3.7）—— 语义天生就是「还剩多少」
    "CPUCreditBalance": _M(_DOWN, _RATIO, "Minimum", _INST, "T 系"),
    # ⚠️ **不收 `CPUCreditUsage`**（实测 ElastiCache 确实发布它）。两个理由：
    #    ① 它有意义的统计量是日 `Sum`（当天烧掉的 credit 总数），而 `STATS`
    #       只采 Min/Avg/Max/p95 —— 加进来会是一条**恒空的 series**，
    #       看起来「收了这个指标」，实际每天都取不到值且不报错。
    #    ② 信息本来就在 `CPUCreditBalance` 里：逐日余额序列的**斜率**就是燃烧率，
    #       而 `daily[]` 已经把整窗口的余额给了 DA。多收一个指标只加钱不加信息。
    "CPUSurplusCreditBalance": _M(_UP, _RATIO, "Maximum", _INST,
                                  "T 系透支额度，越大越坏。"
                                  "⚠️ 仅 RDS/EC2 —— ElastiCache 无 unlimited 模式，"
                                  "实测探针节点未发布此指标"),
    "BurstBalance": _M(_DOWN, _RATIO, "Minimum", _INST, "gp2 卷；Aurora 没有"),
    "EBSIOBalance%": _M(_DOWN, _RATIO, "Minimum", _INST,
                        "⚠️ 仅普通 RDS 且规格 ≤ *.4xlarge；Aurora 没有"),
    "EBSByteBalance%": _M(_DOWN, _RATIO, "Minimum", _INST,
                          "⚠️ 仅普通 RDS 且规格 ≤ *.4xlarge；Aurora 没有"),
    "MaximumUsedTransactionIDs": _M(_UP, _RATIO, "Maximum", _INST,
                                    "Postgres XID wraparound；MySQL 没有"),

    # Aurora 专属
    # ⚠️ 全部是**实例维度**（官方文档归在 "Instance-level metrics for Amazon Aurora"）。
    #    早期版本标成集群维度 → 请求发到 DBClusterIdentifier 上，恒返回空。
    # ⚠️ 都有版本门槛（Aurora MySQL 3.06.1+ / 3.08+），所以只进关联清单不进告警清单：
    #    进告警清单会让每台低版本实例每天产出一条永远修不好的缺口。
    "AuroraNumOomRecoveryTriggered": _M(_UP, _RATIO, "Maximum", _INST,
                                        "★ 直接对应客户描述的内存场景；需 Aurora MySQL 3.08+"),
    "AuroraMemoryHealthState": _M(_UP, _ORDINAL, "Maximum", _INST,
                                  "序数枚举 0/5/10，SHALL NOT 走 headroom；需 3.06.1+"),
    "AuroraMillisecondsSpentInOomRecovery": _M(_UP, _RATIO, "Maximum", _INST),
    "BufferCacheHitRatio": _M(_DOWN, _RATIO, "Minimum", _INST,
                              "持续下滑 = 工作集超出内存"),
    "RollbackSegmentHistoryListLength": _M(_UP, _RATIO, "Maximum", _INST,
                                           "Aurora MySQL purge 落后"),
    "TransactionAgeMaximum": _M(_UP, _RATIO, "Maximum", _INST,
                                "最老活跃事务的年龄；需 Aurora MySQL 3.08+"),

    # ── ElastiCache 共用（Redis / Valkey / Memcached）──
    "Evictions": _M(_UP, _TRAFFIC, "Maximum", _BOTH),
    "CurrConnections": _M(_UP, _TRAFFIC, "Maximum", _BOTH),
    "CurrItems": _M(_UP, _TRAFFIC, "Maximum", _BOTH),
    "Reclaimed": _M(_UP, _TRAFFIC, "Maximum", _BOTH),
    "NetworkBandwidthInAllowanceExceeded": _M(_UP, _RATIO, "Maximum", _BOTH),
    "NetworkBandwidthOutAllowanceExceeded": _M(_UP, _RATIO, "Maximum", _BOTH),
    "NetworkPacketsPerSecondAllowanceExceeded": _M(_UP, _RATIO, "Maximum", _BOTH),

    # ── ElastiCache / Redis 与 Valkey 专属 ──
    # ⚠️ Redis 主线程单线程：4 vCPU 节点上引擎打满时 CPUUtilization 仅约 25%，
    #    基于它的阈值近似永不触发 → 静默零命中（R3.6）。必须用 EngineCPUUtilization。
    # ⚠️ judge_stat 写死 Maximum 而不是 p95 —— AWS/ElastiCache 不支持百分位。
    "EngineCPUUtilization": _M(_UP, _RATIO, "Maximum", _BOTH,
                               "★ Redis 判定必须用这个；Memcached 没有此指标"),
    "DatabaseMemoryUsagePercentage": _M(_UP, _RATIO, "Maximum", _BOTH,
                                       "Redis/Valkey 专属；Memcached 没有"),
    # ★ 内存碎片率 = used_memory_rss / used_memory。**判定盲区补齐**（2026-08-23）。
    #
    # 在两个真实生产账号共 141 个节点上实测，区分度极强：
    # ```
    #               >1.5    >2.0    >3.0    >5.0
    # 账号 A          10%      3%      0%      0%
    # 账号 B          47%     34%     11%      8%     p99 = 21.79
    # ```
    # 账号 B 有 34% 的节点碎片率 >2，而我们此前完全没采这个指标 —— 那批节点
    # 的内存浪费（以及 >3 时的 OOM 风险）在看板上一点痕迹都没有。
    #
    # ⚠️ 是 `_RATIO` 而不是 `_TRAFFIC`：碎片率**不随业务量成比例变动**，
    #    它有明确的饱和点（1.0 理想 / 1.5 起浪费 / >3 严重），可做水位判定。
    # ⚠️ Memcached **没有**这个指标（它用 slab 分配器，碎片以 slab 为单位，
    #    不暴露这个比率）—— 与 EngineCPUUtilization 同一类差异。
    "MemoryFragmentationRatio": _M(_UP, _RATIO, "Maximum", _BOTH,
                                   "Redis/Valkey 专属；Memcached 用 slab 无此比率"),
    "BytesUsedForCache": _M(_UP, _TRAFFIC, "Maximum", _BOTH, "Redis/Valkey"),
    "CacheHits": _M(_DOWN, _TRAFFIC, "Average", _BOTH,
                    "⚠️ 单看它会把周末流量下降判成劣化；正确形式是命中率"),
    "CacheMisses": _M(_UP, _TRAFFIC, "Average", _BOTH),
    "ReplicationLag": _M(_UP, _RATIO, "Maximum", _BOTH,
                         "Redis/Valkey 副本节点；Memcached 无复制"),
    # ★ 二值状态（1 = 正在做快照）。**纯解释性证据，不判是非** ——
    #   做快照本身不是问题，它是「EngineCPUUtilization 低而 CPUUtilization 高」
    #   这一情形的**直接答案**。没有它，DA 面对那个组合只能猜，
    #   而最可能的错猜是「建议扩容」——而真相是每天定时备份。
    # ⚠️ `_ORDINAL` 而不是 `_RATIO`：它是 0/1 枚举，SHALL NOT 走 headroom
    #   （「快照进度 0.7」没有意义）。同 AuroraMemoryHealthState 的处理。
    # ⚠️ 只进关联清单，SHALL NOT 进告警清单 —— 进了就会对每台每天在做备份的
    #   节点报一条「风险」，而那正是客户按我们建议开的备份。
    "SaveInProgress": _M(_UP, _ORDINAL, "Maximum", _BOTH,
                         "1 = 正在做快照。解释 host CPU 抬升，不作风险判定"),

    # ── ElastiCache / Memcached 专属 ──
    # 官方指标表（派生自 memcached stats 命令）：
    # https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheMetrics.Memcached.html
    "GetHits": _M(_DOWN, _TRAFFIC, "Average", _BOTH, "Memcached 的 CacheHits"),
    "GetMisses": _M(_UP, _TRAFFIC, "Average", _BOTH, "Memcached 的 CacheMisses"),
    "BytesUsedForCacheItems": _M(_UP, _TRAFFIC, "Maximum", _BOTH,
                                 "Memcached 已用内存字节。⚠️ 无百分比指标，"
                                 "要算占用率得自己拿节点内存做分母"),
    "CmdGet": _M(_UP, _TRAFFIC, "Average", _BOTH),
    "CmdSet": _M(_UP, _TRAFFIC, "Average", _BOTH),
}


# ---------------------------------------------------------------------------
# 指标用途 —— 判读载荷的 `metric_contract` 段（Payload V2）
# ---------------------------------------------------------------------------


class MetricPurpose(str, Enum):
    """这个指标**在回答什么问题**。

    🔴 存在的理由：判读 skill 此前只拿到指标名与一串数字，于是它按名字去猜
    语义 —— 而名字会骗人。2026-09-01 那条 P0 就是这么来的：
    `ReplicationLag` 有数据 → skill 猜「有复制延迟说明它是副本」→
    把一台单节点 primary 判成 standby。

    真相是 `ReplicationLag` 回答的是「复制健康度」，**不是**「我是谁」。
    这张表把「在回答什么问题」变成载荷里的事实，让 skill 不必也不该去猜。

    ⚠️ 定义放在代码里而不是写进 SKILL.md：两份 skill 都要用同一套语义，
    写进 md 就会漂移（改了一份忘了另一份，且没有任何东西会失败）。
    """

    CPU_SATURATION = "cpu_saturation"
    ENGINE_CPU_SATURATION = "engine_cpu_saturation"
    CPU_BURST_CREDIT = "cpu_burst_credit"
    MEMORY_HEADROOM = "memory_headroom"
    MEMORY_SATURATION = "memory_saturation"
    MEMORY_PRESSURE = "memory_pressure"
    MEMORY_FRAGMENTATION = "memory_fragmentation"
    STORAGE_CAPACITY = "storage_capacity"
    STORAGE_BURST_CREDIT = "storage_burst_credit"
    IO_THROUGHPUT = "io_throughput"
    IO_QUEUE = "io_queue"
    IO_LATENCY = "io_latency"
    NETWORK_TRAFFIC = "network_traffic"
    NETWORK_ALLOWANCE = "network_allowance"
    CONNECTION_LOAD = "connection_load"
    REPLICATION_HEALTH = "replication_health"
    """复制**健康度** —— 落后了多少秒。⚠️ 不是身份，见 `ROLE_BLIND_METRICS`。"""
    TRANSACTION_HEALTH = "transaction_health"
    BUFFER_EFFICIENCY = "buffer_efficiency"
    CACHE_EFFECTIVENESS = "cache_effectiveness"
    CACHE_TRAFFIC = "cache_traffic"
    CACHE_CONTENT = "cache_content"
    MAINTENANCE_STATE = "maintenance_state"


_P = MetricPurpose

# 倒排写法（用途 → 指标）而不是给 52 个 `_M(...)` 各加一个参数：
# 后者是 52 行 diff 且容易在某一行漏掉，前者一眼看得出同一用途下有哪些指标。
# ⚠️ 完整性由 `test_every_metric_has_a_purpose` 钉住 —— 新增指标忘了归类会失败，
#    而不是静默落到「无用途」然后在载荷里少一个字段。
_PURPOSE_MEMBERS: dict[MetricPurpose, tuple[str, ...]] = {
    _P.CPU_SATURATION: ("CPUUtilization",),
    _P.ENGINE_CPU_SATURATION: ("EngineCPUUtilization",),
    _P.CPU_BURST_CREDIT: ("CPUCreditBalance", "CPUSurplusCreditBalance"),
    _P.MEMORY_HEADROOM: ("FreeableMemory",),
    _P.MEMORY_SATURATION: (
        "DatabaseMemoryUsagePercentage", "BytesUsedForCache", "BytesUsedForCacheItems",
    ),
    _P.MEMORY_PRESSURE: (
        "SwapUsage", "Evictions",
        "AuroraNumOomRecoveryTriggered", "AuroraMemoryHealthState",
        "AuroraMillisecondsSpentInOomRecovery",
    ),
    _P.MEMORY_FRAGMENTATION: ("MemoryFragmentationRatio",),
    _P.STORAGE_CAPACITY: (
        "FreeStorageSpace", "FreeLocalStorage",
        "AuroraVolumeBytesLeftTotal", "VolumeBytesUsed",
    ),
    _P.STORAGE_BURST_CREDIT: ("BurstBalance", "EBSIOBalance%", "EBSByteBalance%"),
    _P.IO_THROUGHPUT: ("ReadIOPS", "WriteIOPS"),
    _P.IO_QUEUE: ("DiskQueueDepth",),
    _P.IO_LATENCY: ("ReadLatency", "WriteLatency"),
    _P.NETWORK_TRAFFIC: (
        "NetworkReceiveThroughput", "NetworkTransmitThroughput",
        "NetworkBytesIn", "NetworkBytesOut",
    ),
    _P.NETWORK_ALLOWANCE: (
        "NetworkBandwidthInAllowanceExceeded",
        "NetworkBandwidthOutAllowanceExceeded",
        "NetworkPacketsPerSecondAllowanceExceeded",
    ),
    _P.CONNECTION_LOAD: ("DatabaseConnections", "CurrConnections"),
    _P.REPLICATION_HEALTH: (
        "ReplicaLag", "AuroraReplicaLag", "AuroraReplicaLagMaximum", "ReplicationLag",
    ),
    _P.TRANSACTION_HEALTH: (
        "MaximumUsedTransactionIDs", "RollbackSegmentHistoryListLength",
        "TransactionAgeMaximum",
    ),
    _P.BUFFER_EFFICIENCY: ("BufferCacheHitRatio",),
    _P.CACHE_EFFECTIVENESS: ("CacheHits", "CacheMisses", "GetHits", "GetMisses"),
    _P.CACHE_TRAFFIC: ("CmdGet", "CmdSet"),
    _P.CACHE_CONTENT: ("CurrItems", "Reclaimed"),
    _P.MAINTENANCE_STATE: ("SaveInProgress",),
}

PURPOSE_OF: dict[str, MetricPurpose] = {
    metric: purpose
    for purpose, metrics in _PURPOSE_MEMBERS.items()
    for metric in metrics
}


def purpose_of(metric: str) -> MetricPurpose | None:
    """None = 这个指标没归类。载荷侧遇到 None SHALL 省略 purpose 字段而不是编一个。"""
    return PURPOSE_OF.get(metric)


# 复制类指标：AWS/RDS 与 AWS/ElastiCache 各一套**名字不通用**的。
_RDS_REPLICATION_METRICS: frozenset[str] = frozenset({
    "ReplicaLag", "AuroraReplicaLag", "AuroraReplicaLagMaximum",
})
_EC_REPLICATION_METRICS: frozenset[str] = frozenset({"ReplicationLag"})

ROLE_BLIND_METRICS: frozenset[str] = _RDS_REPLICATION_METRICS | _EC_REPLICATION_METRICS
"""**看起来**像角色信号、实际不是的指标。载荷对它们显式声明 `role_evidence: false`。

🔴 这一组的存在就是为了钉住 2026-09-01 的 P0。实测事实：

```
notiops-tb-redis-ap-northeast-1-001   单成员副本组，CurrentRole=primary
AWS/ElastiCache ReplicationLag        对这台 primary **有数据**（集群维度 + 节点维度）
```

`ReplicationLag` 在 Redis **primary 上也发布**（主也要报告自己与副本的复制状态）。
所以「有 ReplicationLag ⇒ 它是 replica」是被真实数据直接证伪的。

⚠️ 反方向同样不成立：`ReplicaLag` 没数据不等于「它不是副本」——
可能是刚建好、可能是采集失败。角色只能来自
`attrs.resource_role`（Describe API 的事实）。

⚠️ 这一组里的指标**照样有判读价值** —— 它们回答「复制健康吗」
（`ReplicaLag == -1` 持续多久决定它是不是真断了）。禁止的只是拿它们判身份。
"""

# 角色收窄：这些指标**只在特定角色上发布**，其他角色上是 `not_applicable`。
#
# ⚠️ `ReplicationLag` **不在这张表里**，这是刻意的：Redis 的 primary 与 replica
#    都发布它（上面的实测）。放进来收窄到 replica 就是把那条 P0 从 skill
#    搬进了代码 —— 载荷会对一台 primary 说「这个指标不适用」，
#    而它明明有 6 天的数据。
_ROLE_SCOPED_METRICS: dict[str, frozenset[ResourceRole]] = {
    "ReplicaLag": frozenset({ResourceRole.RDS_READ_REPLICA}),
    "AuroraReplicaLag": frozenset({ResourceRole.AURORA_READER}),
    "AuroraReplicaLagMaximum": frozenset({ResourceRole.AURORA_WRITER}),
}


@dataclass(frozen=True)
class Applicability:
    """这个指标对**这台**资源在结构上存不存在。

    ⚠️ 与「有没有数据」是两件事，`assemble._correlated_section` 靠这个区分
    `not_applicable`（我们知道不该有 —— 是证据）与 `no_datapoints`
    （期望有却拿到空 —— 不是证据）。合并这两档会误删灾备副本。
    """

    applicable: bool
    reason: str = ""
    """只在 `applicable=False` 时非空。人类可读，会原样进载荷的 `reason`。"""


_APPLICABLE = Applicability(True)


def _as_role(role: ResourceRole | str | None) -> ResourceRole | None:
    if role is None or role == "":
        return None
    if isinstance(role, ResourceRole):
        return role
    try:
        return ResourceRole(str(role))
    except ValueError:
        return None


def applicability(
    metric: str,
    *,
    family: str = "",
    role: ResourceRole | str | None = None,
    instance_class: str = "",
    storage_type: str | None = None,
) -> Applicability:
    """这个指标对这台资源**结构上存不存在**（Payload V2 的适用性契约）。

    🔴 **判不出来时一律返回「适用」。** 声称 `not_applicable` 是一条
    确定性断言，判读侧会把它当证据用（「没有副本指标 ⇒ 不是副本 ⇒ 可以删」）。
    在证据不足时给出这条断言，等于凭空造了一个可以据此删库的理由。
    所以每个分支的前提缺失（`instance_class` 空、`storage_type` 为 None、
    `role` 是 `UNKNOWN`）都走回 `_APPLICABLE`。

    ⚠️ 只写**族清单表达不了**的规则。「Memcached 没有 EngineCPUUtilization」
    这类族级差异已经由 `ALERTING_METRICS` / `CORRELATION_METRICS` 决定
    （压根不请求），在这里再写一遍就是两份真源。这里只处理依赖
    **角色 / 规格 / 卷类型**的那些 —— 它们同族之内逐台不同。
    """
    r = _as_role(role)

    if metric in ROLE_BLIND_METRICS:
        return _replication_applicability(metric, family, r)

    if metric in _CPU_CREDIT_METRICS:
        # ⚠️ `instance_class` 为空 → 不判定。非 T 系没有 credit 机制是确定的，
        #    但「规格不知道」推不出「有 credit 机制」也推不出「没有」。
        if instance_class and not specs.is_burstable(instance_class):
            return Applicability(
                False, f"{instance_class} 非突发性能规格，无 CPU credit 机制")
        return _APPLICABLE

    if metric == "BurstBalance":
        # gp2 的突发额度是**卷类型**的属性：gp3 用基线 IOPS + 可配置吞吐，
        # 没有 burst bucket，所以 `BurstBalance` 在 gp3 卷上压根不发布。
        # ⚠️ `storage_type is None` 是「没读到」（`ResourceAttrs` 的三个
        #    None 字段之一）→ 不判定。
        st = (storage_type or "").strip().lower()
        if st and st != "gp2":
            return Applicability(
                False, f"storage_type={st} 无 gp2 突发额度机制（gp3 用基线 IOPS）")
        return _APPLICABLE

    return _APPLICABLE


def _replication_applicability(
    metric: str, family: str, role: ResourceRole | None
) -> Applicability:
    """复制类指标的适用性。**唯一允许收窄的地方**，规则写在这里好逐条读。"""
    if family and is_memcached_family(family):
        return Applicability(False, "memcached 无复制机制")

    ec_fam = is_elasticache_family(family) if family else None

    if metric in _EC_REPLICATION_METRICS:
        if ec_fam is False:
            return Applicability(
                False, f"{metric} 是 AWS/ElastiCache 的指标，本资源在 AWS/RDS")
        # 🔴 到这里就返回适用 —— **不按 primary/replica 收窄**。
        #    Redis 的主节点也发布 ReplicationLag（见 ROLE_BLIND_METRICS 的实测）。
        return _APPLICABLE

    if ec_fam is True:
        return Applicability(
            False, f"{metric} 是 AWS/RDS 的指标，本资源在 AWS/ElastiCache")

    want = _ROLE_SCOPED_METRICS.get(metric)
    if want is None or role is None or role is ResourceRole.UNKNOWN:
        return _APPLICABLE
    if role in want:
        return _APPLICABLE
    return Applicability(
        False,
        f"resource_role={role.value}；{metric} 只在 "
        f"{'/'.join(sorted(x.value for x in want))} 上发布",
    )


_CPU_CREDIT_METRICS: frozenset[str] = frozenset({
    "CPUCreditBalance", "CPUSurplusCreditBalance",
})


# ---------------------------------------------------------------------------
# 族解析
# ---------------------------------------------------------------------------

_AURORA_MYSQL_ENGINES = ("aurora-mysql", "aurora")     # 'aurora' 是 5.6 时代的旧名
_REDIS_ENGINES = ("redis", "valkey")


UNSUPPORTED_ENGINES: frozenset[str] = frozenset({"docdb", "neptune"})
"""在 `AWS/RDS` 之外发布指标、因而 v1 判定不了的引擎。

🔴 **它们会正常进入采集清单** —— `aws rds describe-db-instances` 返回
DocumentDB 与 Neptune 实例（共用 RDS 控制平面）。但指标分别在
`AWS/DocDB` / `AWS/Neptune` namespace，采集侧查 `AWS/RDS` 一个值都拿不到：

```
每个指标 NO_DATA  →  coverage_days = 0  →  evaluate_threshold 返回空 verdicts
                  →  一条 finding 都不产  →  在看板上完全消失
```

而「完全消失」与「巡检过了、很健康」不可区分。2026-08-23 实测两个客户的
RDS 清单里有 6 台（Neptune ×4 `1.4.5.1`、DocumentDB ×2 `3.6.0`）一直被
静默跳过。`assemble.high_load_findings` 现在为它们产一条 INFO
`unsupported_engine`，让这个盲区可见。

⚠️ 判据是 `Engine` 字段而不是版本号 —— 版本号（`3.6.0` / `1.4.5.1`）碰巧
能认出来，但那是巧合：DocumentDB 5.0 的版本号与 MySQL 5.x 撞形。
⚠️ 不用它去过滤采集：少采几个指标省不了钱，而**把实例从清单里摘掉**
会让「这台没被巡检」这件事重新变成不可见的。
"""


def is_unsupported_engine(engine: str) -> bool:
    """这个引擎是否在 v1 判定范围之外（见 `UNSUPPORTED_ENGINES`）。"""
    return (engine or "").strip().lower() in UNSUPPORTED_ENGINES


def metric_family(service: str, engine: str = "") -> str:
    """`(service, engine)` → 采集清单的键。返回 `MetricFamily` 的 value。

    ⚠️ 粒度是**引擎**而不是服务。共用一份清单的六条静默错误见模块 docstring。
    未知引擎落到该服务的保守族（`rds-other` / `redis`），SHALL NOT 返回空 ——
    「不认识这个引擎」不该等于「一个指标都不采」。
    """
    svc = (service or "").strip().lower()
    eng = (engine or "").strip().lower()

    if svc == "rds":
        if eng.startswith("aurora-postgres"):
            return MetricFamily.AURORA_POSTGRES.value
        if eng.startswith("aurora"):
            # aurora / aurora-mysql 都归 MySQL 兼容
            return MetricFamily.AURORA_MYSQL.value
        if eng.startswith("postgres"):
            return MetricFamily.RDS_POSTGRES.value
        if eng.startswith("mysql"):
            return MetricFamily.RDS_MYSQL.value
        return MetricFamily.RDS_OTHER.value

    if svc == "elasticache":
        if eng.startswith("memcached"):
            return MetricFamily.MEMCACHED.value
        if any(eng.startswith(e) for e in _REDIS_ENGINES):
            return MetricFamily.REDIS.value
        # 引擎读不到时按 Redis 处理：它是绝大多数，且 Redis 清单里
        # 只有 4 个指标对 Memcached 不存在（都在关联清单，不产生缺口噪音）
        return MetricFamily.REDIS.value

    return svc


def is_elasticache_family(family: str) -> bool:
    return family in (MetricFamily.REDIS.value, MetricFamily.MEMCACHED.value)


def is_memcached_family(family: str) -> bool:
    """族名版的 Memcached 判定。

    ⚠️ 与 `is_memcached(service, engine)` 是同一件事的两个入口 ——
    调用方手上有的是族名还是 (service, engine) 不一定。
    `applicability()` 只收族名（它是纯指标侧的函数，不该要求调用方带 service）。
    """
    return family == MetricFamily.MEMCACHED.value


def is_memcached(service: str, engine: str = "") -> bool:
    """Memcached 判定的**唯一来源**。

    结构性风险与容量审计里有好几条规则对 Memcached 不适用
    （不支持快照、没有复制、没有引擎 CPU、没有内存占用率指标），
    各自写一遍 `engine.startswith("memcached")` 迟早漂移 —— 走这一个入口。
    """
    return metric_family(service, engine) == MetricFamily.MEMCACHED.value


def is_aurora_family(family: str) -> bool:
    return family in (
        MetricFamily.AURORA_MYSQL.value, MetricFamily.AURORA_POSTGRES.value
    )


# ---------------------------------------------------------------------------
# per-family 采集清单（R3.8）
# ---------------------------------------------------------------------------
#
# 两份集合，边界是刻意的：
#   ALERTING      客户可改。判定用。**缺失会报可观测性缺口。**
#   CORRELATION   系统决定，客户只读。做证据用，进 DA 载荷。缺失是常态，不报。
#
# ⚠️ 关联指标 SHALL NOT 从客户可改的白名单取（R3.8）：客户去掉连接数后，
#   DA 载荷里 related_metrics 变空数组，Agent 不会报错、会照样出一份
#   缺少关键证据的报告，且无任何日志提示。关联关系是领域知识。
#
# ⚠️ **进 ALERTING 的门槛**：该指标对这个族的**每一台**实例都应当有值。
#   任何「只有某些实例/某些版本/某个角色才有」的指标一律放 CORRELATION，
#   否则每天会为每台不满足条件的实例产出一条永远修不好的缺口，把真信号淹掉。
#   典型：
#     · AuroraReplicaLag        只有 reader 有 → writer 每天一条缺口
#     · AuroraReplicaLagMaximum 只有 writer 有 → reader 每天一条缺口
#     · ReplicationLag          只有副本节点有
#     · CPUCreditBalance        只有 T 系有
#     · BurstBalance            只有 gp2 有
#     · EBSIOBalance%           只有 ≤4xlarge 的普通 RDS 有
#     · Aurora OOM 三件套       有引擎版本门槛
#   代价是 v1 不对复制延迟做阈值判定。这是有意的取舍：现在它是 DA 的证据，
#   要变成告警项得先按角色拆采集清单（登记为后续任务）。

# 四个 RDS/Aurora 族的公共部分 —— 官方文档确认这些在 RDS 与 Aurora 都有
_RDS_CORE_ALERTING: tuple[str, ...] = (
    "CPUUtilization",
    "FreeableMemory",
    "DatabaseConnections",
    "ReadIOPS",
    "WriteIOPS",
    # 🔴 2026-08-23 补：这三个此前**只在 CORRELATION 里**，于是
    #    `read_latency_seconds` / `write_latency_seconds` / `disk_queue_depth`
    #    三个阈值字段是**死配置** —— 客户能在配置页上改，但判定层压根拿不到
    #    这些指标的值（`assemble.high_load_findings` 只遍历 alerting 清单），
    #    所以改了没有任何效果、也没有任何提示。
    #
    #    四处都当它们是判定项，只有这份清单没有：
    #    ```
    #    rule_limits._THRESHOLD              暴露给客户改（services=_RDS_LIKE）
    #    thresholds._THRESHOLD_BY_METRIC_FIELD  有指标 → 字段映射
    #    severity.METRIC_FIX_ACTION          有 FixAction（APP_QUERY_FIX）
    #    thresholds._NON_NEGATIVE_FIELDS     有取值校验
    #    ```
    #
    #    代价是实测出来的：某生产账号有 2 台 WriteLatency 超 50ms（p99 = 556ms）、
    #    9 台超 10ms，全部报不出来。
    #
    # ⚠️ **同时保留在 `_RDS_CORE_CORRELATION` 里**，不是移动。
    #    `metrics_for_family` 会合并两份清单并去重（采集不会重复请求），
    #    而 `assemble` 的 correlated 段单独读 CORRELATION —— 移走的话 DA
    #    就拿不到 latency 的**日序列**作为证据，而「CPU 高 + 读延迟高 →
    #    IO 瓶颈」这类推断全靠它。
    #
    # ⚠️ 满足 R3.8b 准入门槛（该族每台实例都应当有值）：真实数据 79 台
    #    RDS/Aurora 这三个指标全部有值，不会产生「永远修不好的缺口」。
    "ReadLatency",
    "WriteLatency",
    "DiskQueueDepth",
)

# ⚠️ `SwapUsage` **只放非 Aurora RDS 的告警清单**。
# 官方：「This metric isn't available for the following DB instance classes:
#   db.r3.* / db.r4.* / db.r7g.*（Aurora MySQL）· db.r7g.*（Aurora PostgreSQL）」
# https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.AuroraMonitoring.Metrics.html
# db.r7g 是当代主力规格。放进 Aurora 告警清单就违反 R3.8b 的准入门槛
# （该族每台实例都应当有值），后果是每台 r7g/r4/r3 Aurora 每天一条
# 永远修不好的缺口 —— 与 EBSIOBalance% 那类被刻意留在关联清单的指标同一形态。
_RDS_ONLY_ALERTING: tuple[str, ...] = ("SwapUsage",)

_RDS_CORE_CORRELATION: tuple[str, ...] = (
    "DiskQueueDepth",
    "ReadLatency",
    "WriteLatency",
    "CPUCreditBalance",
    "CPUSurplusCreditBalance",
    "NetworkReceiveThroughput",
    "NetworkTransmitThroughput",
)

# Aurora 两族的条件性指标：存在但不是每台都有 → 按 R3.8b 只能进关联清单
_AURORA_CONDITIONAL_CORRELATION: tuple[str, ...] = (
    "SwapUsage",        # r7g / r4 / r3 上不存在
    "FreeLocalStorage",  # db.serverless 上不适用
)

# 只有挂 EBS 卷的普通 RDS 才有这几个（Aurora 用集群卷，没有）
_RDS_EBS_CORRELATION: tuple[str, ...] = (
    "BurstBalance",
    "EBSIOBalance%",
    "EBSByteBalance%",
    "ReplicaLag",
)

_EC_CORE_CORRELATION: tuple[str, ...] = (
    "NetworkBytesIn",
    "NetworkBytesOut",
    "NetworkBandwidthInAllowanceExceeded",
    "NetworkBandwidthOutAllowanceExceeded",
    "NetworkPacketsPerSecondAllowanceExceeded",
    "CurrItems",
    "Reclaimed",
    # ★ 2026-08-20 实测：ElastiCache **确实发布** CPUCreditBalance
    #   （探针 cache.t4g.micro / Valkey 9.1，3 个数据点 avg 1.648）。
    #   在此之前两份 EC 关联清单都没有它，而 RDS 侧有 ——
    #   于是 `cache.t3` / `cache.t4g` 的 credit 见底在 EC 侧完全看不见。
    #   结构性规则 `burstable_in_prod` 只说得出「你用了突发规格」，
    #   说不出「你的 credit 正在耗尽」——后者才是那台节点即将被节流的原因。
    #
    # ⚠️ **不收 `CPUCreditUsage`**：它有意义的统计量是日 `Sum`，而 `STATS`
    #    只采 Min/Avg/Max/p95 → 会是一条恒空 series。燃烧率看余额序列的斜率即可。
    # ⚠️ **不收 `CPUSurplusCreditBalance`**：ElastiCache 无 unlimited 模式，
    #    实测探针节点未发布。照 RDS 抄会多花钱换回一条恒空 series。
    "CPUCreditBalance",
)

ALERTING_METRICS: dict[str, tuple[str, ...]] = {
    MetricFamily.RDS_MYSQL.value: (
        _RDS_CORE_ALERTING + _RDS_ONLY_ALERTING + ("FreeStorageSpace",)
    ),
    MetricFamily.RDS_POSTGRES.value: _RDS_CORE_ALERTING + _RDS_ONLY_ALERTING + (
        "FreeStorageSpace",
        # XID wraparound 会让数据库强制只读 —— PG 上这是真正的停机风险
        "MaximumUsedTransactionIDs",
    ),
    MetricFamily.RDS_OTHER.value: (
        _RDS_CORE_ALERTING + _RDS_ONLY_ALERTING + ("FreeStorageSpace",)
    ),
    # ⚠️ Aurora 两族都**不含** SwapUsage（r7g/r4/r3 上不存在，见 _RDS_ONLY_ALERTING）
    # 也不含 FreeLocalStorage（官方注明「This doesn't apply to Aurora serverless」，
    # 而 db.serverless 是 Aurora Serverless v2 的默认形态）—— 两个都进关联清单。
    MetricFamily.AURORA_MYSQL.value: _RDS_CORE_ALERTING + (
        "AuroraVolumeBytesLeftTotal",   # ⚠️ Aurora MySQL 专属
    ),
    MetricFamily.AURORA_POSTGRES.value: _RDS_CORE_ALERTING + (
        # ⚠️ **没有 AuroraVolumeBytesLeftTotal** —— Aurora PG 不发这个指标。
        # 早期版本照抄 Aurora MySQL 清单 → Aurora PG 的存储判定永久零命中，
        # 且每台每天一条永远修不好的缺口。
        "MaximumUsedTransactionIDs",
    ),
    MetricFamily.REDIS.value: (
        "EngineCPUUtilization",
        "DatabaseMemoryUsagePercentage",
        # ⚠️ 只在 REDIS 清单里，**不在 MEMCACHED**：Memcached 用 slab
        #    分配器，不暴露这个比率（同 EngineCPUUtilization 的差异）。
        "MemoryFragmentationRatio",
        "Evictions",
        "CurrConnections",
        "CacheHits",
        "CacheMisses",
        "SwapUsage",
        "FreeableMemory",
    ),
    MetricFamily.MEMCACHED.value: (
        # ⚠️ Memcached 是**多线程**的，没有 EngineCPUUtilization。
        # 官方指导就是看整机 CPUUtilization，与 Redis 恰好相反。
        "CPUUtilization",
        "Evictions",
        "CurrConnections",
        "GetHits",                      # ⚠️ 不是 CacheHits
        "GetMisses",                    # ⚠️ 不是 CacheMisses
        "SwapUsage",
        "FreeableMemory",
        "BytesUsedForCacheItems",       # ⚠️ 没有百分比指标，只有绝对字节
    ),
}

CORRELATION_METRICS: dict[str, tuple[str, ...]] = {
    MetricFamily.RDS_MYSQL.value: _RDS_CORE_CORRELATION + _RDS_EBS_CORRELATION,
    MetricFamily.RDS_POSTGRES.value: _RDS_CORE_CORRELATION + _RDS_EBS_CORRELATION,
    MetricFamily.RDS_OTHER.value: _RDS_CORE_CORRELATION + _RDS_EBS_CORRELATION,
    MetricFamily.AURORA_MYSQL.value: _RDS_CORE_CORRELATION
    + _AURORA_CONDITIONAL_CORRELATION + (
        "AuroraReplicaLag",
        "AuroraReplicaLagMaximum",
        "AuroraNumOomRecoveryTriggered",
        "AuroraMillisecondsSpentInOomRecovery",
        "AuroraMemoryHealthState",
        "BufferCacheHitRatio",
        "RollbackSegmentHistoryListLength",
        "TransactionAgeMaximum",
        "VolumeBytesUsed",
    ),
    MetricFamily.AURORA_POSTGRES.value: _RDS_CORE_CORRELATION
    + _AURORA_CONDITIONAL_CORRELATION + (
        "AuroraReplicaLag",
        "AuroraReplicaLagMaximum",
        "BufferCacheHitRatio",
        "VolumeBytesUsed",
        # ⚠️ InnoDB 相关的三个（RollbackSegmentHistoryListLength /
        # TransactionAgeMaximum / OOM 三件套）是 Aurora MySQL 专属，不放这里。
    ),
    MetricFamily.REDIS.value: _EC_CORE_CORRELATION + (
        "CPUUtilization",               # 整机 CPU：与引擎 CPU 对比能看出是否多核不均
        "ReplicationLag",
        "BytesUsedForCache",
        # 「引擎闲 + 整机忙」的直接答案。缺它 DA 只能猜，最可能的错猜是「扩容」。
        "SaveInProgress",
    ),
    MetricFamily.MEMCACHED.value: _EC_CORE_CORRELATION + (
        "CmdGet",
        "CmdSet",
    ),
}


def collected_metrics(service: str, engine: str = "") -> tuple[str, ...]:
    """`collected_metrics` = alerting ∪ correlation（R3.8）。顺序稳定。"""
    fam = metric_family(service, engine)
    alerting = ALERTING_METRICS.get(fam, ())
    correlation = CORRELATION_METRICS.get(fam, ())
    seen: dict[str, None] = {}
    for m in (*alerting, *correlation):
        seen.setdefault(m, None)
    return tuple(seen)


def alerting_metrics(service: str, engine: str = "") -> tuple[str, ...]:
    return ALERTING_METRICS.get(metric_family(service, engine), ())


def families() -> tuple[str, ...]:
    """全部已定义的族。给「每族都要有清单」这类元断言用。"""
    return tuple(f.value for f in MetricFamily)


# ---------------------------------------------------------------------------
# 统计量：哪些族支持百分位
# ---------------------------------------------------------------------------

# 官方支持百分位的服务清单（需要原始数据点）：
# API Gateway / Application Load Balancer / EC2 / Elastic Load Balancing /
# Kinesis / Amazon RDS
# https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Statistics-definitions.html
_PERCENTILE_CAPABLE_FAMILIES = frozenset({
    MetricFamily.RDS_MYSQL.value,
    MetricFamily.RDS_POSTGRES.value,
    MetricFamily.RDS_OTHER.value,
    MetricFamily.AURORA_MYSQL.value,
    MetricFamily.AURORA_POSTGRES.value,
})

# 不支持百分位时的替代统计量。按方向选：
#   BAD_UP   → Maximum（看最坏的高点）
#   BAD_DOWN → Minimum（看最坏的低点）
# ⚠️ 不能一律用 Maximum：对 BAD_DOWN 指标那是「最好的一天」，方向正好反了。
_PERCENTILE_FALLBACK = {
    Direction.BAD_UP: "Maximum",
    Direction.BAD_DOWN: "Minimum",
}


def supports_percentiles(family: str) -> bool:
    """该族所在的命名空间是否支持 p95 一类的扩展统计量。"""
    return family in _PERCENTILE_CAPABLE_FAMILIES


def stats_for_family(family: str, all_stats: tuple[str, ...]) -> tuple[str, ...]:
    """从统一的统计量清单里剔掉该族拿不到的。

    对 ElastiCache 剔掉 p95：请求它只会拿到空数组，**但照样按指标数计费**
    （GetMetricData 按 requested metrics 计价，每个统计量是独立的 query）。
    顺手省掉 EC 侧 25% 的采集成本。
    """
    if supports_percentiles(family):
        return all_stats
    return tuple(s for s in all_stats if not s.lower().startswith("p"))


# ---------------------------------------------------------------------------
# 查询
# ---------------------------------------------------------------------------


def is_known(metric: str) -> bool:
    return metric in METRICS


def direction_of(metric: str) -> Direction | None:
    """None = 未归类。调用方 SHALL NOT 让它参与判定（R3.3）。"""
    m = METRICS.get(metric)
    return m.direction if m else None


def kind_of(metric: str) -> MetricKind | None:
    m = METRICS.get(metric)
    return m.kind if m else None


def judge_stat_of(metric: str, family: str = "") -> str | None:
    """判定该用哪个统计量（R3.2）。

    `family` 给出时按族做可用性降级 —— 同一个指标名在不同命名空间下
    可用的统计量不同。`CPUUtilization` 在 `AWS/RDS` 上能取 p95，
    在 `AWS/ElastiCache` 上不能（R3.2a）。
    不传 family 时返回表里的原值（向后兼容，但**判定路径应当传**）。
    """
    m = METRICS.get(metric)
    if m is None:
        return None
    stat = m.judge_stat
    if family and stat.lower().startswith("p") and not supports_percentiles(family):
        return _PERCENTILE_FALLBACK.get(m.direction, "Maximum")
    return stat


def dimension_of(metric: str) -> Dimension | None:
    m = METRICS.get(metric)
    return m.dimension if m else None


def note_of(metric: str) -> str:
    m = METRICS.get(metric)
    return m.note if m else ""


def available_on_instance(metric: str) -> bool:
    d = dimension_of(metric)
    return d in (Dimension.INSTANCE, Dimension.BOTH)


def available_on_cluster(metric: str) -> bool:
    d = dimension_of(metric)
    return d in (Dimension.CLUSTER, Dimension.BOTH)


def is_bad_up(metric: str) -> bool | None:
    d = direction_of(metric)
    return None if d is None else d is Direction.BAD_UP


def crossed(metric: str, value: float, threshold: float) -> bool | None:
    """按方向判是否越线。未归类返回 None（调用方必须处理，不得当 False）。"""
    bad_up = is_bad_up(metric)
    if bad_up is None:
        return None
    return value > threshold if bad_up else value < threshold


def headroom(metric: str, value: float, threshold: float) -> float | None:
    """方向归一后的余量（术语表 / R2.1.2）。

    先按方向翻成「越大越坏」，再 `(T − x) / |T|`。
    `> 0` 未越线，`≤ 0` 已越线。未归类返回 None。

    ⚠️ 必须先归一再算。裸用 `(threshold − value)/threshold`：
    `FreeableMemory` 当前 1000MB、阈值 800MB（还健康）会算出 −0.25，被判成已越线。

    ⚠️ 序数状态量返回 None：档位编码上的差值没有比例意义
    （`AuroraMemoryHealthState` 从 5 到 10 不是「坏了一倍」）。
    """
    if kind_of(metric) is MetricKind.ORDINAL_STATE:
        return None
    bad_up = is_bad_up(metric)
    if bad_up is None:
        return None
    if threshold == 0:
        return None
    x, t = (value, threshold) if bad_up else (-value, -threshold)
    return (t - x) / abs(t)


def unclassified(metrics: object) -> tuple[str, ...]:
    """挑出未归类的指标名 —— 加新指标忘记归类时靠这个发现（R3.3）。"""
    return tuple(sorted(m for m in metrics if m not in METRICS))


def orphan_metrics() -> tuple[str, ...]:
    """定义在 METRICS 里但不在任何族的采集清单中的指标名。

    这类条目是纯负债：看着像「系统会看这个指标」，实际永远不会被拉取。
    元断言用它棘轮 —— 新增定义就必须挂到某个族上，或者别加。
    """
    used: set[str] = set()
    for fam in families():
        used.update(ALERTING_METRICS.get(fam, ()))
        used.update(CORRELATION_METRICS.get(fam, ()))
    return tuple(sorted(set(METRICS) - used))
