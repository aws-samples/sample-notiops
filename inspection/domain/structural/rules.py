"""七项结构性风险规则（R2.4.2）。

每条规则一个纯函数，签名统一，在 `RULES` 里注册 —— 与 Phase 2 的 `SCORERS` 同一个模式。
加一条规则 = 写一个函数 + 加一行注册，不动任何已有规则。

三条贯穿全模块的约定：

1. **属性为 None 一律跳过，不判定。** 零误报是 R2.4.3 的硬要求，而「不知道备份开没开」
   当成「没开」正是最刺眼的那类误报。返回 None 表示「这条规则对这台不适用或判不了」。

2. **只出 code + params，不出文案**（R10.9b）。

3. **判定与判读分离**：这里只回答「是/否命中」这个是非题，
   「该不该修、先修哪个、怎么修」交给 DA（R2.4.3）。
   典型例子：只读副本单 AZ 是预期而非缺陷 —— 这里靠 `is_read_replica` 属性排除掉能排的，
   排不掉的交给 DA 看上下文。
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date

from inspection.domain import metrics_meta, specs
# ⚠️ severity 的**唯一**产出点在 severity.py。这里曾经硬写 4 处分档，
# 与 headroom 那套各自演化 → 同一条 finding 在列表页和详情页显示不同严重度。
from inspection.domain.severity import (
    structural_severity_backup_disabled,
    structural_severity_by_date,
    structural_severity_cert,
    structural_severity_no_read_replica,
)
from inspection.domain.dto import (
    Finding,
    LifecyclePhase,
    ResourceAttrs,
    Severity,
    StructuralRefData,
    StructuralRule,
    StructuralRuleConfig,
)

# ---------------------------------------------------------------------------
# 规则实现
# ---------------------------------------------------------------------------


def _finding(
    attrs: ResourceAttrs, rule: StructuralRule, severity: Severity = Severity.INFO,
    data_date: date | None = None, **params
) -> Finding:
    return Finding(
        account_id=attrs.account_id,
        region=attrs.region,
        service=attrs.service,
        instance_id=attrs.instance_id,
        rule=rule,
        severity=severity,
        data_date=data_date,
        params=params,
    )


def check_gp2_volume(
    attrs: ResourceAttrs, ref: StructuralRefData, cfg: StructuralRuleConfig,
    today: date,
) -> Finding | None:
    """gp2 应迁 gp3 —— 同等容量下 gp3 更便宜且基线性能更高。"""
    if attrs.storage_type is None:
        return None
    if attrs.storage_type.lower() != "gp2":
        return None
    return _finding(
        attrs, StructuralRule.GP2_VOLUME, data_date=today,
        storage_type=attrs.storage_type,
        allocated_storage_gb=attrs.allocated_storage_gb,
    )


def check_burstable_in_prod(
    attrs: ResourceAttrs, ref: StructuralRefData, cfg: StructuralRuleConfig,
    today: date,
) -> Finding | None:
    """生产环境用 T 系（突发性能）实例。

    ⚠️ 这条**只判属性，不判是否真的在出血**。T 系用于生产不必然是错的
    （低负载场景反而划算）。CPU credit 是否在透支要看指标 —— 那个数字由 Lambda
    在闲置/高负载侧算好，附在指纹载荷里（R12.6b），由 DA 合并判读。
    """
    if attrs.tier not in cfg.prod_tiers:
        return None
    if not specs.is_burstable(attrs.instance_class):
        return None
    return _finding(
        attrs, StructuralRule.BURSTABLE_IN_PROD, data_date=today,
        instance_class=attrs.instance_class, tier=attrs.tier,
    )


def check_single_az_in_prod(
    attrs: ResourceAttrs, ref: StructuralRefData, cfg: StructuralRuleConfig,
    today: date,
) -> Finding | None:
    """生产库未跨 AZ 部署。

    ⚠️ **Aurora 与普通 RDS 判据不同，混用会批量误报。**
    2026-08-17 实测 `zetl-aurora` 集群：集群层 `MultiAZ=true`、成员实际落在
    us-east-1a / 1b，但两个成员实例的 `MultiAZ` 字段都是 `false`
    —— Aurora 的高可用在集群层（存储自动三 AZ 复制），实例层那个字段恒 false。
    只读实例层字段会把每个健康的 Aurora 成员都报一遍。

    ⚠️ 只读副本单 AZ 是**预期**，不是缺陷 —— 副本本身就是跨 AZ 冗余的一部分。
    """
    if attrs.tier not in cfg.prod_tiers:
        return None
    if attrs.is_read_replica:
        return None

    if attrs.service == "elasticache":
        return _single_az_elasticache(attrs, cfg, today)

    if attrs.cluster_id:
        # Aurora / 多写集群：看集群层
        if attrs.cluster_multi_az is True:
            return None
        if attrs.cluster_az_count is not None and attrs.cluster_az_count >= 2:
            return None
        if attrs.cluster_multi_az is None and attrs.cluster_az_count is None:
            return None                 # 判不了就不判（零误报优先于覆盖率）
        return _finding(
            attrs, StructuralRule.SINGLE_AZ_IN_PROD, data_date=today,
            tier=attrs.tier, cluster_id=attrs.cluster_id, scope="cluster",
            cluster_az_count=attrs.cluster_az_count,
        )

    # 普通 RDS：看实例层
    if attrs.multi_az:
        return None
    return _finding(
        attrs, StructuralRule.SINGLE_AZ_IN_PROD, data_date=today,
        tier=attrs.tier, cluster_id=None, scope="instance",
    )


def _single_az_elasticache(
    attrs: ResourceAttrs, cfg: StructuralRuleConfig, today: date | None = None
) -> Finding | None:
    """ElastiCache 的可用性判据 —— 与 RDS 是两套东西。

    官方两个独立字段（已核对 botocore elasticache/2015-02-02 模型）：
        ReplicationGroup.MultiAZ            'enabled' | 'disabled'
        ReplicationGroup.AutomaticFailover  'enabled' | 'disabled' | 'enabling' | 'disabling'
    文档要求生产环境**两个都开**：
    「Unless you have a specific need otherwise, all production deployments
      should use Multi-AZ with auto-failover」
    https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/AutoFailover.html

    ⚠️ **与「无副本」耦合**：ElastiCache 没有副本就不可能开 Multi-AZ
    （auto-failover 需要有 replica 才能提升）。两条都报等于对同一个根因报两遍。
    所以这里在「确认没有副本」时让位给 NO_READ_REPLICA 规则，只报根因。
    """
    if attrs.tier not in cfg.prod_tiers:
        return None

    # 没有副本 → 根因是「无副本」，交给那条规则报，这里不重复
    if attrs.read_replica_count == 0:
        return None

    if metrics_meta.is_memcached(attrs.service, attrs.engine):
        # R2.4.2c 要求**显式**跳过，不靠 read_replica_count == 0 的间接效果
        # （那个间接条件在多 shard 形态下并不成立）
        return None

    enabled = attrs.cluster_multi_az
    failover = attrs.automatic_failover

    if enabled is None and failover is None:
        return None                     # 判不了就不判

    # ⚠️ **AND 而不是 OR。** 上面引的官方原话是「all production deployments
    # should use Multi-AZ **with** auto-failover」，R2.4.2a 也写「两者都开」。
    # 早期实现是 `enabled is True or failover is True: return None`，
    # 而 `AutomaticFailover=enabled` + `MultiAZ=disabled` 是完全合法且常见的配置
    # （副本与主节点同 AZ：failover 能用，但扛不住 AZ 级故障）。
    # cluster-mode-enabled 带副本时 auto-failover 基本恒为 enabled，
    # 于是这条规则在那个形态上**几乎永久静默** —— 真的单 AZ 风险漏报。
    # 半开状态照样报出来，params 里带着两个字段的实际取值交给 DA 判读。
    if enabled is True and failover is True:
        return None

    return _finding(
        attrs, StructuralRule.SINGLE_AZ_IN_PROD, data_date=today,
        tier=attrs.tier, scope="replication_group",
        multi_az_enabled=enabled, automatic_failover=failover,
        replication_group_id=attrs.cluster_id,
    )


def check_backup_disabled(
    attrs: ResourceAttrs, ref: StructuralRefData, cfg: StructuralRuleConfig,
    today: date,
) -> Finding | None:
    """自动备份未开启（保留天数 = 0）。

    两个服务的字段不同名但语义一致，都由 adapter 归一到 `backup_retention_days`：
        RDS          DBInstance.BackupRetentionPeriod
        ElastiCache  ReplicationGroup / CacheCluster.SnapshotRetentionLimit

    这条不看 tier —— 任何有状态存储关掉备份都是风险。
    ⚠️ ElastiCache 上 severity 降一档：缓存丢了通常能重建，
    不像数据库那样是不可恢复的业务数据。

    ⚠️ **Memcached 一律跳过。** ElastiCache 的快照功能不支持 Memcached ——
    对 Memcached 集群调 `CreateSnapshot` 直接抛 `SnapshotFeatureNotSupportedFault`
    （"Creating a snapshot of a cluster that is running Memcached rather than
    Valkey or Redis OSS … not supported by ElastiCache"）。
    而 `describe_cache_clusters` 照样返回 `SnapshotRetentionLimit: 0`，
    所以不特判就会对**每一个** Memcached 集群报一条客户**永远无法修复**的
    「备份未开启」。这正是 R2.4.3 零误报要挡的那类。
    """
    if metrics_meta.is_memcached(attrs.service, attrs.engine):
        return None

    # ⚠️ **只读副本一律跳过。** RDS 只读副本的 `BackupRetentionPeriod` 默认就是 0，
    # 而备份责任在源库 —— 给副本单独开备份是多付一份快照钱去解决一个不存在的问题。
    # 同文件的 `check_single_az_in_prod` 与 `check_no_read_replica` 都有这一行，
    # 这条漏了，于是机队里**每一个只读副本**每月拿一条 severity=high 的
    # 「自动备份未开启」，客户无法处置 —— 正是 R2.4.3 零误报要挡的形态。
    if attrs.is_read_replica:
        return None

    if attrs.backup_retention_days is None:
        return None
    if attrs.backup_retention_days > 0:
        return None
    return _finding(
        attrs, StructuralRule.BACKUP_DISABLED, data_date=today,
        severity=structural_severity_backup_disabled(attrs.service),
        backup_retention_days=attrs.backup_retention_days,
        field=(
            "SnapshotRetentionLimit" if attrs.service == "elasticache"
            else "BackupRetentionPeriod"
        ),
    )


def check_no_read_replica(
    attrs: ResourceAttrs, ref: StructuralRefData, cfg: StructuralRuleConfig,
    today: date,
) -> Finding | None:
    """没有副本 —— 单点。

    ⚠️ RDS 默认只对 `tier1` 报（`read_replica_required_tiers`）：
    非核心库没读副本是常态，全量报等于制造噪音。

    ⚠️ **ElastiCache 不同，对全部生产 tier 都报**，而且它是根因级的：
    没有副本 → 不可能开 Multi-AZ / auto-failover（提升需要有 replica），
    主节点挂了就是数据全丢 + 服务中断。RDS 少个读副本只是少一层，
    ElastiCache 少个副本是没有任何冗余。
    对应地 `_single_az_elasticache` 在这种情况下让位，只报这一条根因。

    ⚠️ **Memcached 一律跳过。** Memcached 引擎没有复制这个概念 ——
    它不进副本组、没有 primary/replica 角色、也没有 auto-failover。
    adapters 层因此给它 `read_replica_count = 0`，不特判的话每一个生产
    Memcached 集群都会拿到一条「没有副本，单点」——
    而客户唯一的「修复」方式是换成 Redis，这不是巡检该给的建议。
    Memcached 的可用性靠多节点 + 客户端一致性哈希，属于架构选择，交给 DA 讨论。
    """
    if metrics_meta.is_memcached(attrs.service, attrs.engine):
        return None
    if attrs.is_read_replica:
        return None
    if attrs.read_replica_count is None:
        return None
    if attrs.read_replica_count > 0:
        return None

    if attrs.service == "elasticache":
        if attrs.tier not in cfg.prod_tiers:
            return None
        return _finding(
            attrs, StructuralRule.NO_READ_REPLICA, data_date=today,
            severity=structural_severity_no_read_replica(),
            tier=attrs.tier, scope="replication_group",
            replication_group_id=attrs.cluster_id,
            implies="multi_az_impossible",
        )

    if attrs.tier not in cfg.read_replica_required_tiers:
        return None
    return _finding(
        attrs, StructuralRule.NO_READ_REPLICA, data_date=today, tier=attrs.tier, scope="instance",
    )


def check_ca_cert_expiring(
    attrs: ResourceAttrs, ref: StructuralRefData, cfg: StructuralRuleConfig,
    today: date,
) -> Finding | None:
    """RDS CA 证书临期。到期未轮换会导致强制 TLS 的客户端连不上。"""
    ca_id = attrs.ca_cert_identifier
    if not ca_id:
        return None
    expiry = ref.ca_cert_expiry.get(ca_id)
    if expiry is None:
        return None

    days_left = (expiry - today).days
    if days_left > cfg.ca_cert_lead_days:
        return None
    return _finding(
        attrs, StructuralRule.CA_CERT_EXPIRING, data_date=today,
        # ⚠️ 证书用**比通用日期分档更严**的一档（≤30 天就 HIGH）——
        # 证书到期是 TLS 握手失败即服务中断，不同于 EOL 只是多花钱。见 severity.py。
        severity=structural_severity_cert(days_left),
        ca_cert_identifier=ca_id,
        expiry_date=expiry.isoformat(),
        days_left=days_left,
    )


def check_engine_eol(
    attrs: ResourceAttrs, ref: StructuralRefData, cfg: StructuralRuleConfig,
    today: date,
) -> Finding | None:
    """引擎大版本标准支持即将/已经结束。

    数据来源 `rds:DescribeDBMajorEngineVersions`（R11e.2）。
    报的是**标准支持**结束日 —— 过了那天会自动转 Extended Support 并开始额外计费，
    这才是客户关心的那个「钱开始多花」的时点，不是彻底停止支持的那天。
    """
    if not attrs.engine or not attrs.engine_version:
        return None
    major = major_version(attrs.engine, attrs.engine_version)
    if major is None:
        return None

    lifecycle = ref.engine_lifecycles.get((attrs.engine.lower(), major))
    if lifecycle is None:
        return None
    std_end = lifecycle.standard_end
    if std_end is None:
        return None

    days_left = (std_end - today).days
    if days_left > cfg.engine_eol_lead_days:
        return None

    # 已过期 → HIGH（正在按 Extended Support 计费）｜ ≤30 天 → MEDIUM ｜ 其余 → INFO
    severity = structural_severity_by_date(days_left)

    return _finding(
        attrs, StructuralRule.ENGINE_EOL, data_date=today, severity=severity,
        engine=attrs.engine, engine_version=attrs.engine_version,
        major_version=major,
        standard_support_end=std_end.isoformat(),
        extended_support_end=(
            lifecycle.extended_end.isoformat() if lifecycle.extended_end else None
        ),
        days_left=days_left,
        phase=(
            LifecyclePhase.EXTENDED.value if days_left < 0
            else LifecyclePhase.STANDARD.value
        ),
    )


# ---------------------------------------------------------------------------
# 大版本解析
# ---------------------------------------------------------------------------


def major_version(engine: str, engine_version: str) -> str | None:
    """把完整引擎版本压成 `DescribeDBMajorEngineVersions` 用的大版本键。

    实测 / 查文档得到的对应关系（2026-08-17）：
        mysql         8.4.10                       → 8.4      两段
        postgres      16.4                         → 16       一段
        aurora-mysql  8.0.mysql_aurora.3.10.5      → 8.0      两段，先剥 aurora 后缀
        aurora-mysql  8.4.mysql_aurora.8.4.7       → 8.4
        aurora-postgresql 15.5                     → 15       一段
        redis         6.2.6                        → 6        一段
        valkey        8.0                          → 8        一段
        memcached     1.6.22                       → 1.6      两段

    ⚠️ **粒度按引擎不同，必须写死，不要试图统一推导。** 依据：
      · postgres 实测 DescribeDBMajorEngineVersions 返回 11~18（一段）
      · mysql / aurora-mysql 实测返回 5.7 / 8.0 / 8.4（两段）
      · ElastiCache 官方 Extended Support 表用「Redis OSS v4 / v5 / v6」（一段）
        https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/extended-support-versions.html
    """
    e = (engine or "").strip().lower()
    v = (engine_version or "").strip()
    if not e or not v:
        return None

    head = v.split(".mysql_aurora.")[0] if ".mysql_aurora." in v else v
    parts = head.split(".")
    if not parts or not parts[0]:
        return None

    # 一段粒度
    if (
        e.startswith("postgres")
        or e.startswith("aurora-postgres")
        or e in ("redis", "valkey")
    ):
        return parts[0]

    # 两段粒度（mysql / mariadb / aurora-mysql / memcached）
    if len(parts) >= 2:
        return f"{parts[0]}.{parts[1]}"
    return parts[0]


# ---------------------------------------------------------------------------
# 注册表 —— 加规则只需在这里加一行
# ---------------------------------------------------------------------------

RuleFn = Callable[
    [ResourceAttrs, StructuralRefData, StructuralRuleConfig, date], "Finding | None"
]

RULES: dict[StructuralRule, RuleFn] = {
    StructuralRule.GP2_VOLUME: check_gp2_volume,
    StructuralRule.BURSTABLE_IN_PROD: check_burstable_in_prod,
    StructuralRule.SINGLE_AZ_IN_PROD: check_single_az_in_prod,
    StructuralRule.BACKUP_DISABLED: check_backup_disabled,
    StructuralRule.NO_READ_REPLICA: check_no_read_replica,
    StructuralRule.CA_CERT_EXPIRING: check_ca_cert_expiring,
    StructuralRule.ENGINE_EOL: check_engine_eol,
}

NOT_SCANNED: frozenset[StructuralRule] = frozenset({
    StructuralRule.NO_CAPACITY_METADATA,
    # 由 `assemble.high_load_findings` 在引擎不受支持时产出 —— 那台实例的
    # 指标压根取不到（namespace 不同），所以属性检查也无从下手。
    StructuralRule.UNSUPPORTED_ENGINE,
})
"""在 `StructuralRule` 里但**不由 `scan_structural` 产出**的规则码。

⚠️ 这个清单必须**显式**列出来，不能让 `RULES` 与枚举的差集自由存在 ——
`test_all_rules_registered` 靠 `set(RULES) | NOT_SCANNED == set(StructuralRule)`
守住「真的漏注册一个属性规则」那种情况。差集自由的话，加了枚举值忘了写
检查函数就会静默变成「这条规则永不命中」。

`NO_CAPACITY_METADATA` 由**阈值判定**产出（`assemble.threshold_findings` 看到
`InstanceVerdict.missing_denominator` 时产），因为只有那里才知道分母缺了。
它没有属性检查函数，也不该有。
"""

# 哪些规则只适用于哪些服务。未列出的规则对所有服务生效。
#
# v1 首批范围（2026-08-17 定）：
#   RDS for PostgreSQL · RDS for MySQL · Aurora MySQL · Aurora PostgreSQL · ElastiCache
#
#   规则               RDS/Aurora  ElastiCache  不适用的原因
#   ────────────────  ──────────  ───────────  ────────────────────────────────
#   gp2_volume            ✓            ✗       EC 无 EBS 卷
#   burstable_in_prod     ✓            ✓       cache.t3/t4g 同样是突发性能
#   single_az_in_prod     ✓            ✓       判据不同，见 _single_az_elasticache
#   backup_disabled       ✓            ✓       EC 是 SnapshotRetentionLimit
#   no_read_replica       ✓            ✓       EC 上是根因级（无副本则无法开 Multi-AZ）
#   ca_cert_expiring      ✓            ✗       EC 不管理 CA 证书
#   engine_eol            ✓            ✓       EC 走维护表（无 API）
RULE_SERVICES: dict[StructuralRule, frozenset[str]] = {
    # ⚠️ `"ec2"` 是**死配置**。巡检不覆盖 EC2 实例 —— `pipeline.load_resources`
    #    只 describe RDS 与 ElastiCache，所以没有 `service == "ec2"` 的资源
    #    会走到这条规则。留着它的唯一后果是让人以为「gp2 检查也覆盖 EC2 卷」。
    #
    #    保留而不删，是因为 EC2 卷的 gp2→gp3 判据与 RDS 完全一样（同一个
    #    `storage_type` 字段），哪天把 EC2 纳入采集时这一行不用改。
    #    删掉再加回来的风险更大：那时容易只加采集而漏掉这张表。
    StructuralRule.GP2_VOLUME: frozenset({"rds", "ec2"}),
    StructuralRule.SINGLE_AZ_IN_PROD: frozenset({"rds", "elasticache"}),
    StructuralRule.BACKUP_DISABLED: frozenset({"rds", "elasticache"}),
    StructuralRule.NO_READ_REPLICA: frozenset({"rds", "elasticache"}),
    StructuralRule.CA_CERT_EXPIRING: frozenset({"rds"}),
    StructuralRule.ENGINE_EOL: frozenset({"rds", "elasticache"}),
}


def applies_to(rule: StructuralRule, service: str) -> bool:
    allowed = RULE_SERVICES.get(rule)
    return True if allowed is None else service in allowed
