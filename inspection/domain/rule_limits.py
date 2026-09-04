"""客户可改的判定阈值：字段清单、取值范围、单位（R13.4）。

## 为什么需要这张表

`ThresholdRuleConfig` 等四个 dataclass 的默认值就是判定门槛，但 dataclass
本身表达不了「这个字段客户能不能改、改到多少算合法」。没有这张表的话，
写入侧只能靠调用方自己判，而那必然分叉成两套。

## 三层共用一份

```
Python   本模块              校验 + 反序列化（rule_config.py）
BFF      inspection_rule_limits.mjs   校验 + 把 range 输出给前端
前端     不写死任何范围      从 GET /inspection/config 的 rules.limits 拿
```

🔴 BFF 那份是**镜像**，不是第二个真源。两边打包边界隔开了
（BFF 的 asset 只含 `bff/web-chat/`，而 Python lambda 的 asset
`exclude` 了 `bff/**`），所以物理上没法共用一个文件。
`bff/web-chat/tests/inspection.test.mjs` 里有元断言逐字段比对两侧 ——
分叉的表现是**静默的**：BFF 放行一个 Python 侧会拒的值，或反过来
UI 上填不进一个后端接受的值。

## 不开放的字段（刻意排除，不是漏了）

```
IdleRuleConfig.window_days        它是**数据窗口**，与采集耦合。改成 14 而
                                  序列库只有 7 天数据 → 判定拿不到数，
                                  表现是「调完之后什么都不报了」
InspectionConfig.window_days      同上，且由 se.WINDOW_DAYS 统一给
InspectionConfig.max_workers      并发度，运行参数不是判定门槛
```

⚠️ 范围的上下界不是「物理极限」而是「**改到这个程度就该有人来问一句**」。
`cpu_utilization` 允许 0~100 是因为两端都有真实用途（0 = 全报，100 = 全不报），
但 `min_coverage_days` 上界给 30 而不是 365 —— 填 365 的那份配置一年内
不会产出任何 finding，而客户会以为「系统坏了」。
"""

from __future__ import annotations

from typing import Any

# 数值类型标记。`int` 会在反序列化时取整（DDB 读回来的是 Decimal）。
INT = "int"
FLOAT = "float"
STR_SET = "str_set"
"""字符串集合（`frozenset[str]`）。存 DDB 是 list，判定层要 frozenset。"""

BYTES = "bytes"
"""字节数。与 FLOAT 同样按数值校验，单独标出来是给 UI 用 ——
它该渲染成「500 MB」而不是「524288000」。
"""


# ---------------------------------------------------------------------------
# 服务分组
# ---------------------------------------------------------------------------

RDS = "rds"
AURORA = "aurora"
REDIS = "redis"
MEMCACHED = "memcached"

SERVICES: tuple[str, ...] = (RDS, AURORA, REDIS, MEMCACHED)
"""客户在 UI 上能选的四个服务组。

🔴 **这是「筛选视图」而不是「作用域」。** 阈值配置是**全局一份** ——
`cpu_utilization` 就是一个阈值，RDS 与 Redis 共用它。选服务只决定显示
哪些字段，不是「给这个服务单独设一套」。

⚠️ UI SHALL 明示这一点。做成看起来像作用域的样子（比如每个服务一个
独立的保存按钮）会让客户以为「我只调了 Redis」，而实际上 RDS 也跟着变了
—— 那种误解没有任何运行时信号。

## 为什么是 4 组而不是 7 个 MetricFamily

`metrics_meta.MetricFamily` 有 7 个成员（rds-mysql / rds-postgres /
rds-other / aurora-mysql / aurora-postgresql / redis / memcached），但对
**阈值字段**的支持在组内完全一致：

```
rds-mysql / rds-postgres / rds-other      10 个指标阈值的支持完全相同
                                          （差异只在 MaximumUsedTransactionIDs，
                                            那不是可配阈值）
aurora-mysql / aurora-postgresql          同上
redis（含 Valkey）                        valkey 的 family 就是 redis
```

所以合成 4 组不丢精度，而 7 组会让客户面对「rds-other 是什么」这种问题。
`test_inspection_rule_config.py` 有元断言钉住「组内一致」—— 哪天某个
family 的指标清单变了，这个分组就不再准确，必须被发现。
"""

SERVICE_LABELS: dict[str, dict[str, str]] = {
    RDS: {"zh": "RDS", "en": "RDS",
          "hint_zh": "MySQL / PostgreSQL / MariaDB / Oracle / SQL Server",
          "hint_en": "MySQL / PostgreSQL / MariaDB / Oracle / SQL Server"},
    AURORA: {"zh": "Aurora", "en": "Aurora",
             "hint_zh": "Aurora MySQL / PostgreSQL",
             "hint_en": "Aurora MySQL / PostgreSQL"},
    REDIS: {"zh": "ElastiCache Redis", "en": "ElastiCache Redis",
            "hint_zh": "Redis / Valkey", "hint_en": "Redis / Valkey"},
    MEMCACHED: {"zh": "ElastiCache Memcached", "en": "ElastiCache Memcached",
                "hint_zh": "Memcached", "hint_en": "Memcached"},
}

ALL_SERVICES = SERVICES
"""四个服务都适用的字段用它 —— 比逐个列出来更能表达「与服务无关」。"""

_RDS_LIKE = (RDS, AURORA)
"""RDS 与 Aurora 共有（`attrs.service` 都是 `"rds"`）。"""

_EC = (REDIS, MEMCACHED)
"""两种 ElastiCache 引擎共有。"""


def _f(section: str, key: str, kind: str, default: Any,
       lo: Any = None, hi: Any = None, *, unit: str = "",
       zh: str = "", en: str = "",
       services: tuple[str, ...] = SERVICES) -> dict[str, Any]:
    return {
        "section": section, "key": key, "type": kind, "default": default,
        "min": lo, "max": hi, "unit": unit, "label_zh": zh, "label_en": en,
        # 🔴 这个字段对哪些服务真的生效。空缺的表现是客户改了没反应而**零提示**
        #    —— 比如调 `read_latency_seconds` 期待 Redis 跟着变。
        "services": tuple(services),
    }


# ---------------------------------------------------------------------------
# 高负载轮（run_type = high）→ ThresholdRuleConfig
# ---------------------------------------------------------------------------
#
# ⚠️ 这一组是 **OR 语义**（R2.1）：任一指标越界即命中。所以调高任意一个
# 只会让那一项少报，不会让整条规则失效 —— 与闲置轮的 AND 语义相反。

# 🔴 三个百分比阈值（`cpu_utilization` / `engine_cpu_utilization` /
#    `database_memory_usage_pct`）的下限是 **0.1 而不是 0**（2026-08-26 改）。
#
# `ThresholdRuleConfig.__post_init__` 要求它们落在**开区间** `(0, 100]`，而这里
# 原来写 0.0 —— 于是「写侧放行、读侧抛」：
#
# ```
# 客户在配置页把 cpu_utilization 填 0
#   → validate() 通过（0 >= min 0.0）→ 写库成功、返回 ok:true
#   → 下一轮 executor 调 threshold_config(raw) → ValueError
#   → run 落 failed → SQS 重投 → DLQ
#   → **闲置轮一起挂**（`_run_inspection` 无条件调 threshold_config）
# ```
#
# 客户看到的是「巡检不再产出」，而原因是一个 UI 接受了的数字。
#
# ⚠️ 曾有注释说「允许 0~100 是因为两端都有真实用途（0 = 全报）」—— 那与
#    headroom 的算法冲突：`headroom = (T - x) / |T|`，T=0 直接除零。
#    所以是这张表错，不是 dataclass 错。
#
_THRESHOLD = [
    _f("threshold", "cpu_utilization", FLOAT, 70.0, 0.1, 100.0, unit="%",
       zh="CPU 使用率", en="CPU utilization"),
    # 🔴 只对 **T 系实例**生效（`assemble` 按 `specs.is_burstable` 逐台加判）。
    #    对 T 系，CPUUtilization 会骗人：credit 耗尽后 CPU 被压到 baseline
    #    （t4g 10%~40%），「CPU 30%」与「打满」是同一件事而 70% 门槛不响。
    #    实测真实客户 49 台 RDS 里 18 台（37%）是 T 系。
    #    ⚠️ 四个服务都适用 —— ElastiCache 也有 cache.t* 且确实发布这个指标
    #    （metrics_meta 里 2026-08-20 实测过）。某生产账号有 9 台 cache.t4g.micro。
    _f("threshold", "cpu_credit_balance_min", FLOAT, 10.0, 0.0, 10_000.0,
       zh="CPU credit 余额下限", en="CPU credit balance floor"),
    # 🔴 内存与存储是**按规格的百分比**，不是绝对量。
    #
    # 绝对值门槛在机型跨度大的账号里两端都错：
    #
    # ```
    # 阈值「可用内存 < 500MB」
    #   db.t4g.micro    1 GB 内存   → 用掉一半就告警         噪音
    #   db.r6g.16xlarge 512 GB 内存 → 用到 99.9% 才告警       漏报
    # ```
    #
    # 20% 是 **R2.1.2 的原文**（「FreeableMemory 低于实例内存 20%」）——
    # 第一版实现成绝对值是偏离需求，这里是回归而不是新编。
    #
    # 分母来自 `ResourceAttrs.memory_bytes` / `allocated_storage_gb`。
    # ⚠️ 前者可能为 None（`attrs_repo._MEMORY_NOTE`：需要规格表，v1 允许缺）——
    #    那时**不静默跳过**，产出一条 INFO 的 `no_capacity_metadata`
    #    结构性 finding，让盲区可见。
    # 🔴 20 → 10（2026-08-23，真实客户数据校准）。实测 49 台社区版 RDS
    #    的可用内存 p50 只有 12.6%，20% 压在正常水位上（误报 69%）——
    #    成因是 MySQL 的 buffer pool 默认占 75% 且不计入 MemAvailable。
    #    完整数据见 `thresholds.freeable_memory_pct`。
    # ⚠️ 四个服务都适用 —— `FreeableMemory` 在 `metrics_meta` 的 REDIS 与
    #    MEMCACHED 清单里都有（Memcached 尤其依赖它：那一族**没有**百分比
    #    指标，只有绝对字节）。标成 `_RDS_LIKE` 会让 UI 对 EC 隐藏这个字段
    #    而判定照旧生效 —— 那是「客户看不到却在生效」，比改了没反应更糟。
    _f("threshold", "freeable_memory_pct", FLOAT, 10.0, 1.0, 50.0, unit="%",
       zh="可用内存下限", en="Freeable memory floor"),
    # 🔴 伴随门槛，与上一条是 **AND**：可用内存低**且**在实质回盘读才算命中。
    #    依据是官方 Best Practices「DB instance RAM recommendations」——
    #    判断工作集是否放得下内存，那一节只提 ReadIOPS 一个指标。
    #    量纲 IOPS/s（`ReadIOPS` 的统计量是 Average，不是 Sum）。
    _f("threshold", "memory_read_iops_min", FLOAT, 20.0, 0.0, 1_000_000.0,
       zh="内存判定的回盘读门槛", en="Read IOPS floor for memory verdict",
       services=_RDS_LIKE),
    # Aurora 存储自动扩展，没有 FreeStorageSpace 这个指标。
    # 🔴 10 → 15：对齐官方唯一给了硬数字的那条 ——「Investigate disk space
    #    consumption if space used is consistently at or above 85 percent」。
    _f("threshold", "free_storage_pct", FLOAT, 15.0, 1.0, 50.0, unit="%",
       zh="可用存储下限", en="Free storage floor", services=(RDS,)),
    # 🔴 latency 按引擎分档（2026-08-23）。Aurora 的分布与社区版差一个数量级：
    #    ```
    #                      p90       max      >50ms(旧默认)
    #    Aurora           3.83ms    7.42ms      0%     ← 50ms 是死规则
    #    社区版 RDS       10.0ms    20.0ms      0%
    #    写延迟 p99：Aurora 3.52ms / 社区版 **556ms**
    #    ```
    # ⚠️ 靠**已有的 `services` 机制**分档，不引入「per-service map」这个新概念：
    #    RDS 页显示 `read_latency_seconds`、Aurora 页显示
    #    `read_latency_seconds_aurora`，两者标签相同（「读延迟」）而互不干扰。
    #    这样就不会出现本文件开头警告的那种误解 ——「看起来像作用域，
    #    实际改的是全局一份」。它们**真的是**两个独立字段。
    _f("threshold", "read_latency_seconds", FLOAT, 0.015, 0.001, 10.0, unit="s",
       zh="读延迟", en="Read latency", services=(RDS,)),
    _f("threshold", "read_latency_seconds_aurora", FLOAT, 0.005, 0.001, 10.0,
       unit="s", zh="读延迟", en="Read latency", services=(AURORA,)),
    _f("threshold", "write_latency_seconds", FLOAT, 0.030, 0.001, 10.0, unit="s",
       zh="写延迟", en="Write latency", services=(RDS,)),
    _f("threshold", "write_latency_seconds_aurora", FLOAT, 0.010, 0.001, 10.0,
       unit="s", zh="写延迟", en="Write latency", services=(AURORA,)),
    _f("threshold", "disk_queue_depth", FLOAT, 10.0, 1.0, 1000.0,
       zh="磁盘队列深度", en="Disk queue depth", services=_RDS_LIKE),
    # 🔴 Redis 主线程单线程 —— 4 vCPU 上引擎打满时整机 CPU 仅约 25%，
    #    所以它要单独一个门槛。Memcached 多线程、没有这个指标，看整机 CPU。
    _f("threshold", "engine_cpu_utilization", FLOAT, 70.0, 0.1, 100.0, unit="%",
       zh="引擎 CPU 使用率", en="Engine CPU utilization", services=(REDIS,)),
    _f("threshold", "database_memory_usage_pct", FLOAT, 90.0, 0.1, 100.0, unit="%",
       zh="内存使用率", en="Memory usage", services=(REDIS,)),
    # 🔴 新采的指标（2026-08-23）。此前完全没有 —— 实测某生产账号有 34% 的节点
    #    碎片率 >2、p99 = 21.79，那批的内存浪费在看板上一点痕迹都没有。
    #    定 3.0 而不是通常说的 1.5：1.5 在该客户上命中 47%，没人会看。
    #    ⚠️ Memcached 用 slab 分配器，不暴露这个比率 → 只给 REDIS。
    _f("threshold", "memory_fragmentation_ratio", FLOAT, 3.0, 1.0, 100.0,
       zh="内存碎片率上限", en="Memory fragmentation ratio",
       services=(REDIS,)),
    # 🔴 与 `database_memory_usage_pct` 是 **AND**（见 `thresholds.COMPANIONS`）：
    #    有驱逐**且**内存 >90% 才算命中。allkeys-lru 策略下驱逐是设计行为 ——
    #    实测有驱逐的 6 个节点全部内存 >90%，组合判据一条不漏。
    _f("threshold", "evictions", FLOAT, 0.0, 0.0, 1_000_000.0,
       zh="驱逐数", en="Evictions", services=_EC),
    # ⚠️ 这一个**有意保持绝对值**，不跟着改百分比。
    #    它不是容量占比语义 —— Redis 一旦开始 swap 就已经在降级，与实例
    #    多大无关；50MB 这个数的作用是过滤噪音（几 KB 的 swap 不算事），
    #    而不是「用掉了多少比例」。改成「占内存 0.6%」反而没人读得懂。
    _f("threshold", "swap_usage_bytes", BYTES, 52_428_800, 0, 17_179_869_184,
       unit="B", zh="Swap 使用量", en="Swap usage"),
    # ⚠️ 下面三个是**置信门槛**不是指标阈值：它们决定「攒够多少数据才敢判」。
    #    调小会让判定更早触发但更不稳；调大会让 finding 出得更晚。
    #    与服务无关，所以四个组都适用。
    _f("threshold", "min_coverage_days", INT, 5, 1, 30, unit="d",
       zh="最少覆盖天数", en="Min coverage days"),
    _f("threshold", "chronic_days_min", INT, 5, 2, 30, unit="d",
       zh="慢性高位最少天数", en="Chronic min days"),
    _f("threshold", "chronic_min_coverage", INT, 7, 2, 30, unit="d",
       zh="慢性判定最少覆盖", en="Chronic min coverage"),
]

# ---------------------------------------------------------------------------
# 闲置轮（run_type = idle）→ IdleRuleConfig / CapacityRuleConfig /
#                             StructuralRuleConfig
# ---------------------------------------------------------------------------
#
# 🔴 闲置那一组是 **AND 语义**（R2.2）：必须同时满足才算闲置候选，
# 再经峰值与隐形负载两道否决。所以把任意一个调**大**都会让更多资源被判闲置
# —— 与高负载轮相反，方向搞错就是「越调越多误报」。

_IDLE = [
    # ⚠️ 两类都生效，但**读的指标名不同**（`metrics_repo._ec_candidate`）：
    #      RDS        CPUUtilization + DatabaseConnections
    #      Redis      EngineCPUUtilization + CurrConnections
    #      Memcached  CPUUtilization + CurrConnections
    #    字段是同一个，所以四个组都适用。
    _f("idle", "candidate_cpu_avg", FLOAT, 2.0, 0.0, 100.0, unit="%",
       zh="闲置候选 CPU 均值上限", en="Idle candidate CPU avg"),
    _f("idle", "candidate_connections", INT, 5, 0, 10_000,
       zh="闲置候选连接数上限", en="Idle candidate connections"),
    _f("idle", "peak_cpu_veto", FLOAT, 50.0, 0.0, 100.0, unit="%",
       zh="峰值 CPU 否决线", en="Peak CPU veto"),
    # `veto._check_rds` 才读这两个
    _f("idle", "iops_total", INT, 500, 0, 1_000_000,
       zh="总 IOPS 否决线", en="Total IOPS veto", services=_RDS_LIKE),
    _f("idle", "write_iops", INT, 1000, 0, 1_000_000,
       zh="写 IOPS 否决线", en="Write IOPS veto", services=_RDS_LIKE),
    # `veto._check_elasticache` 才读这三个
    _f("idle", "evictions", INT, 0, 0, 1_000_000,
       zh="驱逐否决线", en="Evictions veto", services=_EC),
    _f("idle", "requests_per_minute", INT, 1000, 0, 10_000_000,
       zh="每分钟请求否决线", en="Requests/min veto", services=_EC),
    _f("idle", "conn_max", INT, 10, 0, 10_000,
       zh="最大连接否决线", en="Max connections veto", services=_EC),
    _f("idle", "consecutive_days_step", FLOAT, 0.1, 0.0, 1.0,
       zh="连续天数加权步长", en="Consecutive-day weight step"),
]

_CAPACITY = [
    # `capacity.AUDITS["rds"]` = audit_oversized_storage
    #
    # 🔴 量纲是 **0~100 的百分数**，不是 0~1 的比例。
    #    此前是 0.4（比例），而同一个配置页上 `threshold.free_storage_pct`
    #    是 10（百分数）—— 两个都叫「可用存储占比」的字段，一个填 0.4
    #    一个填 10，客户必然填错，而填错的表现是判定门槛差 100 倍且不报错。
    #    `capacity.py::audit_oversized_storage` 里除以 100 还原。
    _f("capacity", "free_storage_pct", FLOAT, 40.0, 0.0, 100.0, unit="%",
       zh="可用存储占比上限（判超配）", en="Free storage ratio (oversized)",
       services=(RDS,)),
    # 两个 audit 都用它
    _f("capacity", "cpu_max_veto", FLOAT, 50.0, 0.0, 100.0, unit="%",
       zh="CPU 峰值否决线", en="CPU max veto"),
    # `audit_oversized_memory` 开头就 `if is_memcached: return` → 只 Redis
    _f("capacity", "swap_max_gb", FLOAT, 0.01, 0.0, 1024.0, unit="GB",
       zh="Swap 上限", en="Swap max", services=(REDIS,)),
    _f("capacity", "memory_util_max", FLOAT, 30.0, 0.0, 100.0, unit="%",
       zh="内存使用率上限", en="Memory utilization max", services=(REDIS,)),
]

_STRUCTURAL = [
    # RULE_SERVICES[ENGINE_EOL] = {rds, elasticache} —— 四组都有
    _f("structural", "engine_eol_lead_days", INT, 180, 1, 730, unit="d",
       zh="引擎 EOL 提前告知天数", en="Engine EOL lead days"),
    # RULE_SERVICES[CA_CERT_EXPIRING] = {rds} —— ElastiCache 不管理 CA 证书
    _f("structural", "ca_cert_lead_days", INT, 90, 1, 730, unit="d",
       zh="CA 证书到期提前天数", en="CA cert lead days", services=_RDS_LIKE),
    # ⚠️ 这两个是**标签值**，不是数值。客户的 tag 未必叫 prod / tier1 ——
    #    改不了它等于结构性规则里所有「只报生产库」的判据对该客户全部失效。
    _f("structural", "prod_tiers", STR_SET, ["prod", "tier1"],
       zh="视为生产环境的 tier 标签", en="Tags treated as production"),
    _f("structural", "read_replica_required_tiers", STR_SET, ["tier1"],
       zh="必须有只读副本的 tier 标签", en="Tiers requiring a read replica"),
]

FIELDS: tuple[dict[str, Any], ...] = tuple(
    _THRESHOLD + _IDLE + _CAPACITY + _STRUCTURAL)

# ---------------------------------------------------------------------------
# 显示单位（UI 用，判定不读）
# ---------------------------------------------------------------------------

DISPLAY_UNITS: dict[str, tuple[tuple[str, float], ...]] = {
    "threshold.swap_usage_bytes": (("MB", 1_048_576.0), ("GB", 1_073_741_824.0)),
    "threshold.read_latency_seconds": (("ms", 0.001), ("s", 1.0)),
    "threshold.write_latency_seconds": (("ms", 0.001), ("s", 1.0)),
    # ⚠️ Aurora 那两档也要 —— 漏了的表现是 Aurora 页上显示「0.005 s」
    #    而 RDS 页显示「15 ms」，同一个概念两种量纲，客户会填错 1000 倍。
    "threshold.read_latency_seconds_aurora": (("ms", 0.001), ("s", 1.0)),
    "threshold.write_latency_seconds_aurora": (("ms", 0.001), ("s", 1.0)),
}
"""`section.key` → 可选的显示单位与换算系数。**第一项是默认显示单位。**

## 为什么这张表必须存在

`BYTES` 这个类型标记就是为这件事加的（见它的 docstring），但光有标记不够 ——
UI 还需要知道「换算成什么」。没有这张表的表现是输入框里躺着 `524288000`：

```
现在                          要的
────────────────────         ─────────────────────────
524288000                    [500      ] [MB ▾]
5368709120                   [5        ] [GB ▾]
0.05                         [50       ] [ms ▾]
```

延迟那两个同样是这个问题：默认 `0.05` s，而客户认的是 **50 ms**。

🔴 **前端 SHALL NOT 自己写死换算表。** `api/inspection.ts` 已经为 min/max/default
立了这条规矩，单位是同一类东西 —— 两份换算表分叉的表现是 UI 显示 500MB
而实际存进去 500GB，且没有任何错误。

## 判定层不读它

存储值永远是**基础单位**（字节 / 秒），这张表只影响显示：
`显示值 = 存储值 / scale`，保存时 `存储值 = round(显示值 × scale)`。
校验仍然按换算回来的存储值打 `min`/`max`（单一来源还是上面那张 FIELDS）。

⚠️ 加新的 `BYTES` 字段或秒级字段时必须同时在这里登记 ——
`test_inspection_rule_config.py` 有断言守住，漏了会红。
"""


def display_units_of(section: str, key: str) -> tuple[tuple[str, float], ...]:
    """该字段的显示单位表。空元组 = 按原始值显示（多数字段是这样）。"""
    return DISPLAY_UNITS.get(f"{section}.{key}", ())


def needs_display_units(spec: dict[str, Any]) -> bool:
    """这个字段是不是**必须**登记显示单位。

    判据只有两条，都以「客户不会用这个单位思考」为准：

    ```
    type == BYTES     没人用「524288000」表达 500MB
    unit == "s"       延迟客户认 ms，0.05 s 要显示成 50 ms
    ```

    ⚠️ `swap_max_gb`（capacity）**不在**其中 —— 它的存储单位本来就是 GB，
    字段名里也写着，不需要换算。
    """
    return spec["type"] == BYTES or spec.get("unit") == "s"

BY_RUN_TYPE: dict[str, tuple[str, ...]] = {
    "high": ("threshold",),
    "idle": ("idle", "capacity", "structural"),
}
"""哪一轮能改哪几个 section（R11.1：两轮独立）。

⚠️ 高负载轮改不了闲置阈值，反之亦然。合成一份会让「把闲置 CPU 门槛调高」
顺带影响高负载判定，而那两件事的语义完全不同。
"""

SECTIONS: tuple[str, ...] = ("threshold", "idle", "capacity", "structural")


def fields_of(section: str) -> tuple[dict[str, Any], ...]:
    return tuple(f for f in FIELDS if f["section"] == section)


def sections_for(run_type: str) -> tuple[str, ...]:
    return BY_RUN_TYPE.get(str(run_type), ())


def find(section: str, key: str) -> dict[str, Any] | None:
    for f in FIELDS:
        if f["section"] == section and f["key"] == key:
            return f
    return None


def defaults_of(section: str) -> dict[str, Any]:
    """该 section 的全部默认值。**与 dataclass 的默认值必须一致** ——
    有元断言（`test_inspection_rule_config.py`）逐字段比对，
    分叉的表现是 UI 上显示的「默认值」与实际判定用的不是一个数。
    """
    return {f["key"]: f["default"] for f in fields_of(section)}


def applies_to(spec: dict[str, Any], service: str) -> bool:
    """这个字段对该服务组生效吗。`service` 为空 = 不筛选。"""
    if not service:
        return True
    return service in spec.get("services", ())


def fields_for(section: str, service: str = "") -> tuple[dict[str, Any], ...]:
    """该 section 里对指定服务组生效的字段。"""
    return tuple(f for f in fields_of(section) if applies_to(f, service))


def count_for(service: str = "") -> int:
    """该服务组一共有多少个可改字段 —— UI 的「显示 22 / 共 30 项」用它。

    ⚠️ 必须让客户看见这个数。选了 Memcached 只剩十几个字段，不说的话
    会以为「字段丢了」而不是「那些对 Memcached 不适用」。
    """
    return sum(1 for f in FIELDS if applies_to(f, service))
