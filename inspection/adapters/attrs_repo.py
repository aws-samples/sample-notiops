"""describe API → `ResourceAttrs`（Phase 4）。

domain 层的六条需求（R2.1.2 / R3.7 / R4.4 / R7.3 / R7.4 / R7.5）都要它。

## 每个字段从哪来

```
字段                        RDS / Aurora                    ElastiCache
─────────────────────────  ──────────────────────────────  ─────────────────────────
instance_class              DBInstanceClass                 CacheNodeType
engine / engine_version     Engine / EngineVersion          同
allocated_storage_gb        AllocatedStorage                —（无 EBS）
max_allocated_storage_gb    MaxAllocatedStorage             —
storage_type                StorageType                     —
backup_retention_days       BackupRetentionPeriod           SnapshotRetentionLimit
multi_az                    DBInstance.MultiAZ              —（看副本组，见下）
cluster_multi_az            DBCluster.MultiAZ               RG.MultiAZ == 'enabled'
cluster_az_count            成员实例的不同 AZ 数            成员节点的不同 AZ 数
automatic_failover          —                               RG.AutomaticFailover
read_replica_count          ReadReplicaDBInstanceIdentifiers  副本组成员数 − 1
is_read_replica             ReadReplicaSourceDBInstance…    node_role == 'replica'
ca_cert_identifier          CACertificateIdentifier         —
num_cache_nodes             —                               NumCacheNodes
tags                        TagList                         list_tags_for_resource（按 ARN）
memory_bytes                ⚠️ 无 API，见 _MEMORY_NOTE
max_connections             参数组实读 → 规格表兜底
```

⚠️ **Aurora 的坑**：实例层 `MultiAZ` 恒为 `false`（HA 在集群层，存储自动三 AZ 复制）。
2026-08-17 实测 zetl-aurora：集群 `MultiAZ=true`、成员跨 us-east-1a/1b，
两个成员实例的 `MultiAZ` 都是 `false`。所以 Aurora **必须**补集群层字段，
否则 `check_single_az_in_prod` 会把每个健康成员都报一遍（R2.4.2a）。

⚠️ **ElastiCache 的 MultiAZ / AutomaticFailover 是字符串枚举**
（`'enabled'|'disabled'`，后者还有 `'enabling'|'disabling'`），不是 bool。
`'enabling'` 视为**未生效**（保守）—— 正在开启说明现在还没有跨 AZ 能力。
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field

from botocore.exceptions import BotoCoreError, ClientError

from inspection.domain import specs
from inspection.domain.dto import ResourceAttrs, ResourceRole

logger = logging.getLogger(__name__)

# 实例内存没有 describe API 可查。三条来源，按可靠性排序：
#   ① 参数组里 max_connections 的实读值（反推不出内存，但直接给了我们要的分母）
#   ② DescribeOrderableDBInstanceOptions —— 也不返回内存
#   ③ 规格表 / Price List API 的 memory 属性  ← 真正的来源，属于后续任务
# 所以 v1 的 memory_bytes 允许为 None，domain 层遇 None 会丢维度并重归一化。
_MEMORY_NOTE = "memory_bytes 需要规格表（Price List API），v1 允许为 None"

# 生产环境判定用的 tag key，按优先级尝试（R7.5）
_TIER_TAG_KEYS = ("tier", "Tier", "env", "Env", "Environment", "environment")
_TIER1_VALUES = frozenset({"tier1", "t1", "critical", "p0"})
_PROD_VALUES = frozenset({"prod", "production", "prd", "live"})


def resolve_tier(tags: Mapping[str, str]) -> str:
    """从 tags 推 tier（R7.5）。查不到一律 `nonprod`。

    ⚠️ 默认 `nonprod` 而不是 `prod`：tier 只被用来**放宽**判定
    （「生产用 T 系」「生产库单 AZ」只在生产 tier 上报），
    默认 prod 会让所有没打 tag 的资源都触发这些规则 = 大批误报。
    """
    for key in _TIER_TAG_KEYS:
        raw = tags.get(key)
        if not raw:
            continue
        v = str(raw).strip().lower()
        if v in _TIER1_VALUES:
            return "tier1"
        if v in _PROD_VALUES:
            return "prod"
    return "nonprod"


# ---------------------------------------------------------------------------
# RDS / Aurora
# ---------------------------------------------------------------------------


def load_rds_attrs(
    rds_client, account_id: str, region: str,
    errors: list[str] | None = None,
) -> list[ResourceAttrs]:
    """列出 RDS/Aurora 实例并组装 ResourceAttrs（含集群层 HA 字段）。"""
    return load_rds_attrs_with_groups(
        rds_client, account_id, region, errors=errors)[0]


def load_rds_attrs_with_groups(
    rds_client, account_id: str, region: str,
    errors: list[str] | None = None,
) -> tuple[list[ResourceAttrs], "ParamGroupMap"]:
    """同上，**外加**参数组名映射。

    ⚠️ 这个变体存在的唯一理由是省掉重复的 describe：`enrich_max_connections`
    需要参数组名，而那些名字就在本函数刚拿到的这份响应里。
    不返回它，下游只能再问一遍 AWS —— 早期实现更糟，是**每台问一遍**。
    编排层用这个变体；只要属性的调用方继续用 `load_rds_attrs`。
    """
    instances = _describe_all(rds_client, "describe_db_instances", "DBInstances",
                              errors=errors)
    clusters = _describe_all(rds_client, "describe_db_clusters", "DBClusters",
                             errors=errors)

    az_of = {
        d.get("DBInstanceIdentifier"): d.get("AvailabilityZone") for d in instances
    }
    cluster_ha = _cluster_ha_map(clusters, az_of)

    out: list[ResourceAttrs] = []
    for db in instances:
        cid = db.get("DBClusterIdentifier")
        c_multi_az, c_az_count, writer, member_count = cluster_ha.get(
            cid, (None, None, None, None)
        )
        tags = _tag_map(db.get("TagList"))
        instance_id = db.get("DBInstanceIdentifier") or ""
        replica_count, is_replica = _replica_facts(
            db, instance_id, cid, writer, member_count
        )
        role = _rds_role(db, instance_id, cid, writer, member_count)

        out.append(
            ResourceAttrs(
                instance_id=instance_id,
                service="rds",
                instance_class=db.get("DBInstanceClass") or "",
                engine=(db.get("Engine") or "").lower(),
                engine_version=db.get("EngineVersion") or "",
                account_id=account_id,
                region=region,
                allocated_storage_gb=_allocated_storage_of(db),
                max_allocated_storage_gb=_as_float(db.get("MaxAllocatedStorage")),
                storage_type=db.get("StorageType"),
                backup_retention_days=_as_int(db.get("BackupRetentionPeriod")),
                read_replica_count=replica_count,
                is_read_replica=is_replica,
                resource_role=role,
                multi_az=bool(db.get("MultiAZ")),
                cluster_id=cid,
                cluster_multi_az=c_multi_az,
                cluster_az_count=c_az_count,
                is_cluster_writer=(writer == instance_id) if writer else False,
                ca_cert_identifier=db.get("CACertificateIdentifier"),
                # Performance Insights（判读侧用）。
                # ⚠️ 用 `.get(...) is not None` 分支而不是 `bool(...)`：
                #    API 没返回这个键时要保持 None（「没读到」），
                #    而 `bool(None)` 是 False（「客户没开」）—— 两者对
                #    skill 是不同的话，后者会让它下一个错误的结论。
                performance_insights_enabled=(
                    bool(db["PerformanceInsightsEnabled"])
                    if db.get("PerformanceInsightsEnabled") is not None else None),
                performance_insights_retention_days=_as_int(
                    db.get("PerformanceInsightsRetentionPeriod")),
                tags=tags,
                tier=resolve_tier(tags),
            )
        )

    logger.info("loaded %d RDS attrs (account=%s region=%s)", len(out), account_id, region)
    return out, param_group_map(instances, clusters)


def _cluster_ha_map(
    clusters: Sequence[dict], az_of: Mapping[str, str | None]
) -> dict[str, tuple[bool | None, int | None, str | None, int | None]]:
    """{cluster_id: (cluster_multi_az, distinct_az_count, writer_id, member_count)}。

    ⚠️ AZ 数用**成员实例的实际 AZ**，不用 `DBCluster.AvailabilityZones` ——
    后者是集群「可以用」的 AZ 列表（实测返回 3 个），不是成员实际落在几个 AZ。
    拿它判会把单 AZ 集群误判为跨 AZ。

    `member_count` 是 A① 的修法：Aurora 的 reader 数量只能从这里算。
    """
    out: dict[str, tuple[bool | None, int | None, str | None, int | None]] = {}
    for c in clusters:
        cid = c.get("DBClusterIdentifier")
        if not cid:
            continue
        members = c.get("DBClusterMembers") or []
        ids = [m.get("DBInstanceIdentifier") for m in members]
        azs = {az_of.get(i) for i in ids if az_of.get(i)}
        writer = next(
            (
                m.get("DBInstanceIdentifier") for m in members
                if m.get("IsClusterWriter")
            ),
            None,
        )
        multi_az = c.get("MultiAZ")
        out[cid] = (
            bool(multi_az) if multi_az is not None else None,
            len(azs) if azs else None,
            writer,
            len(members) if members else None,
        )
    return out


def _rds_role(
    db: dict,
    instance_id: str,
    cluster_id: str | None,
    writer_id: str | None,
    member_count: int | None,
) -> ResourceRole:
    """这台 RDS/Aurora 实例在复制拓扑里的角色 —— **只看 Describe 字段**。

    ```
    非集群成员    ReadReplicaSourceDBInstanceIdentifier 有值 → RDS_READ_REPLICA
                                                    无值 → RDS_STANDALONE
    集群成员      IsClusterWriter 为真的那台 == 自己     → AURORA_WRITER
                                                 != 自己 → AURORA_READER
    ```

    ⚠️ `member_count is None`（`describe_db_clusters` 失败）→ `UNKNOWN`，
    **不是** `AURORA_READER`。这里是 `_replica_facts` 的 `(None, False)` 之外
    多出来的一档，也是它非要单独存在的理由：`is_read_replica=False` 在结构性
    规则里是「照报」（保守），而在判读载荷里会被读成「它不是副本，可以删」。
    集群信息没拿到就说得出「它不是副本」，是我们没有的证据。

    ⚠️ 同理 `writer_id is None`（集群拿到了但没有任何成员标着 IsClusterWriter，
    failover 中途会出现）→ `UNKNOWN`，不猜。
    """
    if not cluster_id:
        return (ResourceRole.RDS_READ_REPLICA
                if db.get("ReadReplicaSourceDBInstanceIdentifier")
                else ResourceRole.RDS_STANDALONE)
    if member_count is None or not writer_id:
        return ResourceRole.UNKNOWN
    return (ResourceRole.AURORA_WRITER if writer_id == instance_id
            else ResourceRole.AURORA_READER)


def _replica_facts(
    db: dict,
    instance_id: str,
    cluster_id: str | None,
    writer_id: str | None,
    member_count: int | None,
) -> tuple[int | None, bool]:
    """`(read_replica_count, is_read_replica)`。**Aurora 与普通 RDS 是两套字段。**

    ```
                    普通 RDS                              Aurora（集群成员）
    副本数量        ReadReplicaDBInstanceIdentifiers      DBClusterMembers 数 − 1
    是否是副本      ReadReplicaSourceDBInstanceIdentifier IsClusterWriter 取反
    ```

    ⚠️ 这是 A① 的修法。Aurora 实例的 `ReadReplicaDBInstanceIdentifiers`
    **恒为空数组**（Aurora 的 reader 不是 RDS read replica，它们共享同一份集群卷，
    登记在 `DBClusterMembers` 里）。用普通 RDS 的字段去数 Aurora 的副本，
    结果永远是 0 → `check_no_read_replica` 对**每一个 tier1 Aurora writer**
    都报「没有副本，单点」，哪怕集群里挂着三个 reader。

    ⚠️ 集群成员但 `describe_db_clusters` 失败时返回 `(None, False)`：
    `read_replica_count = None` 让 `check_no_read_replica` 直接跳过
    （零误报优先于覆盖率），而不是拿 0 去报一条假的单点。
    """
    if not cluster_id:
        return (
            len(db.get("ReadReplicaDBInstanceIdentifiers") or []),
            bool(db.get("ReadReplicaSourceDBInstanceIdentifier")),
        )

    # 集群成员。member_count 缺失 = 集群信息没拿到 → 不判定。
    if member_count is None:
        return None, False

    # ⚠️ 角色只能看 IsClusterWriter，**不能看实例名**：
    # 实测本账号有一台名叫 `zetl-aurora-reader` 的实例 IsClusterWriter=true
    # （failover 过之后名字与实际角色相反，且 AWS 不会改名）。
    is_replica = bool(writer_id) and writer_id != instance_id
    return max(member_count - 1, 0), is_replica


# ---------------------------------------------------------------------------
# ElastiCache
# ---------------------------------------------------------------------------

# AutomaticFailover / MultiAZ 的枚举取值 → bool。
# 'enabling' / 'disabling' 是过渡态，保守当**未生效**：
# 正在开启说明当下还没有跨 AZ 能力，判定上不该按已开算。
_EC_ENABLED = frozenset({"enabled"})


def load_elasticache_attrs(
    ec_client, account_id: str, region: str,
    errors: list[str] | None = None,
) -> list[ResourceAttrs]:
    """列出 ElastiCache 节点并组装 ResourceAttrs（含副本组层 HA 字段）。"""
    clusters = _describe_all(
        ec_client, "describe_cache_clusters", "CacheClusters",
        params={"ShowCacheNodeInfo": True}, errors=errors,
    )
    groups = _describe_all(
        ec_client, "describe_replication_groups", "ReplicationGroups",
        errors=errors,
    )

    az_of = {
        c.get("CacheClusterId"): c.get("PreferredAvailabilityZone") for c in clusters
    }
    rg_info = _rg_map(groups, az_of)
    node_role_of = _node_roles(groups)

    out: list[ResourceAttrs] = []
    for c in clusters:
        cluster_id = c.get("CacheClusterId") or ""
        rgid = c.get("ReplicationGroupId")
        multi_az, az_count, failover, member_count = rg_info.get(
            rgid, (None, None, None, None)
        )
        node_role = node_role_of.get(cluster_id)
        role = _ec_role(cluster_id, rgid, c.get("Engine") or "", node_role)

        # 副本数 = 副本组成员数 − 1（主自己不算副本）。无副本组则为 0。
        replica_count = (member_count - 1) if member_count else 0

        # 备份保留：副本组层优先（它是权威），退到节点层
        retention = _as_int(c.get("SnapshotRetentionLimit"))
        rg_retention = next(
            (
                _as_int(g.get("SnapshotRetentionLimit")) for g in groups
                if g.get("ReplicationGroupId") == rgid
            ),
            None,
        )
        if rg_retention is not None:
            retention = rg_retention

        tags = _ec_tags(ec_client, c.get("ARN"))

        out.append(
            ResourceAttrs(
                instance_id=cluster_id,
                service="elasticache",
                instance_class=c.get("CacheNodeType") or "",
                engine=(c.get("Engine") or "").lower(),
                engine_version=c.get("EngineVersion") or "",
                account_id=account_id,
                region=region,
                backup_retention_days=retention,
                num_cache_nodes=_as_int(c.get("NumCacheNodes")),
                read_replica_count=replica_count,
                # ⚠️ 判据换成节点自己的 `CurrentRole`（见 `_node_roles`），
                #    不再是「第一个 primary 不是我 ⇒ 我是副本」。
                is_read_replica=(node_role == "replica"),
                resource_role=role,
                cluster_id=rgid,
                cluster_multi_az=multi_az,
                cluster_az_count=az_count,
                automatic_failover=failover,
                tags=tags,
                tier=resolve_tier(tags),
            )
        )

    logger.info(
        "loaded %d ElastiCache attrs (account=%s region=%s)", len(out), account_id, region
    )
    return out


def _rg_map(
    groups: Sequence[dict], az_of: Mapping[str, str | None]
) -> dict[str, tuple[bool | None, int | None, bool | None, int | None]]:
    """{rg_id: (multi_az, az_count, automatic_failover, member_count)}。

    ⚠️ 角色**不在这里**，见 `_node_roles` —— 角色是 per-node 的，
    而这张表是 per-replication-group 的。混在一起就是下面那个缺陷的根因。
    """
    out: dict[str, tuple[bool | None, int | None, bool | None, int | None]] = {}
    for g in groups:
        rgid = g.get("ReplicationGroupId")
        if not rgid:
            continue
        members = g.get("MemberClusters") or []
        azs = {az_of.get(m) for m in members if az_of.get(m)}
        out[rgid] = (
            _enum_to_bool(g.get("MultiAZ")),
            len(azs) if azs else None,
            _enum_to_bool(g.get("AutomaticFailover")),
            len(members) if members else None,
        )
    return out


def _node_roles(groups: Sequence[dict]) -> dict[str, str]:
    """{cache_cluster_id: 'primary' | 'replica'} —— **每个节点读自己那条记录**。

    ⚠️ 取代原来的 `_primary_of(group)`：那个函数遍历一个副本组的所有
    `NodeGroups`，返回**第一个**找到的 primary，然后调用方拿
    `primary != cluster_id` 当「我是副本」的判据。cluster-mode-enabled
    的多分片副本组上这是错的：

    ```
    RG shard-0001: primary=node-0001, replica=node-0002
    RG shard-0002: primary=node-0003, replica=node-0004
                   ↑ _primary_of 只会返回 node-0001
    ⇒ node-0003 明明是 shard-0002 的主，却因为 "node-0001 != node-0003"
      被判成副本 → 判读侧读到「这是 standby」→ 一台在写的主库被建议留着不动，
      或者反过来把主库的高负载解释成「副本复制延迟」。
    ```

    每个节点读自己 `NodeGroupMembers` 条目里的 `CurrentRole` 就没有这个问题。

    ⚠️ 不在表里的节点**不要补默认值** —— 调用方据此落 `UNKNOWN`。
    """
    out: dict[str, str] = {}
    for g in groups:
        for ng in g.get("NodeGroups") or []:
            for m in ng.get("NodeGroupMembers") or []:
                cid = m.get("CacheClusterId")
                role = (m.get("CurrentRole") or "").strip().lower()
                if cid and role:
                    out[cid] = role
    return out


def _ec_role(
    cluster_id: str, rgid: str | None, engine: str, node_role: str | None
) -> ResourceRole:
    """ElastiCache 节点的角色。

    ```
    memcached                    → MEMCACHED（没有复制机制，只有这一档）
    无副本组                     → REDIS_PRIMARY（独立节点，它就是唯一可写节点）
    有副本组但读不到 CurrentRole → UNKNOWN（不猜）
    CurrentRole == 'primary'     → REDIS_PRIMARY
    其余                         → REDIS_REPLICA
    ```

    🔴 `REDIS_PRIMARY` 这一档就是 2026-09-01 那条 P0 的正解：
    `notiops-tb-redis-ap-northeast-1-001` 单成员副本组、`CurrentRole=primary`，
    而它的 `ReplicationLag` **有数据** —— 指标存在与否说明不了角色，
    只有这里的 Describe 事实说得了。
    """
    if (engine or "").strip().lower().startswith("memcached"):
        return ResourceRole.MEMCACHED
    if not rgid:
        return ResourceRole.REDIS_PRIMARY
    if not node_role:
        return ResourceRole.UNKNOWN
    return (ResourceRole.REDIS_PRIMARY if node_role == "primary"
            else ResourceRole.REDIS_REPLICA)


def _enum_to_bool(value) -> bool | None:
    """`'enabled'|'disabled'|'enabling'|'disabling'` → bool | None。"""
    if value is None:
        return None
    return str(value).strip().lower() in _EC_ENABLED


def _ec_tags(ec_client, arn: str | None) -> dict[str, str]:
    """ElastiCache 的 tag 要单独调 API（不像 RDS 直接在 describe 返回里）。

    失败返回空 dict —— tag 只影响 tier 推断，不值得让整轮采集失败。
    """
    if not arn:
        return {}
    try:
        resp = ec_client.list_tags_for_resource(ResourceName=arn)
    except (ClientError, BotoCoreError) as exc:
        logger.debug("list_tags_for_resource failed for %s: %s", arn, exc)
        return {}
    return _tag_map(resp.get("TagList"))


# ---------------------------------------------------------------------------
# max_connections 补全
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ParamGroupMap:
    """实例 / 集群 → 参数组名。`enrich_max_connections` 的输入。

    ⚠️ 拆出来是为了让「谁去问 AWS」这件事可控。早期实现是
    **每台实例一次 `describe_db_instances(DBInstanceIdentifier=…)`** ——
    500 台就是 500 次往返，而 `load_rds_attrs` 手上已经有那份全量响应了。
    """

    by_instance: dict[str, tuple[str, ...]] = field(default_factory=dict)
    """instance_id → instance parameter group 名（按响应顺序）。"""

    cluster_by_instance: dict[str, str] = field(default_factory=dict)
    """instance_id → **cluster** parameter group 名。

    ⚠️ Aurora PostgreSQL 的 `max_connections` 在 **cluster** parameter group 里，
    不在 instance parameter group。早期实现只读 instance PG，于是
    Aurora PG 永远读不到实读值 → 又因为它没有公布表 → 该维度永久缺失。
    """


def param_group_map(
    instances: Sequence[dict], clusters: Sequence[dict] = ()
) -> ParamGroupMap:
    """从**已有的** describe 响应里提取参数组名，不发任何请求。"""
    cluster_pg = {
        c.get("DBClusterIdentifier"): c.get("DBClusterParameterGroup")
        for c in clusters
        if c.get("DBClusterIdentifier") and c.get("DBClusterParameterGroup")
    }

    by_instance: dict[str, tuple[str, ...]] = {}
    cluster_by_instance: dict[str, str] = {}
    for db in instances:
        iid = db.get("DBInstanceIdentifier")
        if not iid:
            continue
        by_instance[iid] = tuple(
            g["DBParameterGroupName"]
            for g in (db.get("DBParameterGroups") or [])
            if g.get("DBParameterGroupName")
        )
        cid = db.get("DBClusterIdentifier")
        if cid and cluster_pg.get(cid):
            cluster_by_instance[iid] = cluster_pg[cid]

    return ParamGroupMap(by_instance=by_instance, cluster_by_instance=cluster_by_instance)


def enrich_max_connections(
    rds_client,
    attrs_list: Iterable[ResourceAttrs],
    *,
    groups: ParamGroupMap | None = None,
) -> list[ResourceAttrs]:
    """补 `max_connections`（R4.4 的归一化分母）。

    优先级：参数组实读值 → `specs.resolve_max_connections()` 的公布表兜底。
    ⚠️ 参数组值可能是公式字符串（如
    `LEAST({DBInstanceClassMemory/9531392},5000)`）而不是数字 ——
    那种情况按「没读到」处理，交给公布表兜底并打 estimated 标记。

    Args:
        groups: 参数组名映射。**建议由调用方从已有的 describe 响应构造**
            （`param_group_map(instances, clusters)`）。
            不传则本函数自己发 **2 次分页 describe**（全量），
            而不是每台一次 —— 见下方说明。

    ## 两处性能修正（第 5 批）

    ```
    改前                                              改后
    每台一次 describe_db_instances(Id=…)  ×500        1 次全量分页（或调用方直接给）
    cache 的 key 是 instance_id                       key 是**参数组名**
    ```

    第二条才是大头：500 台共用 `default.mysql8.4` 时，
    按 instance_id 缓存等于**一个都没命中** —— 同一个参数组被
    `describe_db_parameters` 分页读 500 遍。实测单次往返约 0.4 秒，
    500 次 ≈ 200 秒纯等待，而这 500 次的答案**逐字相同**。
    改成按参数组名缓存后，绝大多数机队只剩 1~3 次调用。
    """
    from dataclasses import replace

    attrs_list = list(attrs_list)
    needs = [
        a for a in attrs_list
        if a.service == "rds" and a.max_connections is None
    ]
    if not needs:
        return attrs_list

    if groups is None:
        groups = _fetch_param_group_map(rds_client)

    # 按**参数组名**缓存 —— 这是省掉 200 秒的那一处
    cache: dict[str, int | None] = {}
    out: list[ResourceAttrs] = []

    for attrs in attrs_list:
        if attrs.service != "rds" or attrs.max_connections is not None:
            out.append(attrs)
            continue

        value = _max_conn_for(rds_client, attrs, groups, cache)
        estimated = False
        if value is None:
            value, estimated = specs.resolve_max_connections(
                attrs.instance_class, attrs.engine, attrs.memory_bytes
            )

        updated = replace(attrs, max_connections=value)
        if estimated and value is not None:
            updated = updated.with_estimated("max_connections")
        out.append(updated)

    logger.info(
        "max_connections: %d instances resolved with %d distinct parameter groups read",
        len(needs), len(cache),
    )
    return out


def _fetch_param_group_map(rds_client) -> ParamGroupMap:
    """调用方没给映射时的兜底：**2 次分页全量 describe**，不是每台一次。

    ⚠️ 这里**不收 `errors`**：它只补 `max_connections` 这一个字段，失败的后果是
    连接数维度降级（`NO_DENOMINATOR`，那条路自己会报），而不是「整个账号看起来
    没有资源」。主采集路径那两处才是需要上报的。
    """
    instances = _describe_all(rds_client, "describe_db_instances", "DBInstances")
    clusters = _describe_all(rds_client, "describe_db_clusters", "DBClusters")
    return param_group_map(instances, clusters)


def _max_conn_for(
    rds_client,
    attrs: ResourceAttrs,
    groups: ParamGroupMap,
    cache: dict[str, int | None],
) -> int | None:
    """按「先实例参数组、再集群参数组」的顺序找实读值。

    ⚠️ 顺序不能反：instance PG 里的显式设置会覆盖 cluster PG，
    所以它优先。但 Aurora PostgreSQL 的 `max_connections` **只在 cluster PG**
    里有意义，所以 cluster PG 这一步不能省 —— 省了它 Aurora PG 就永远读不到值。
    """
    candidates = [
        ("db", name) for name in groups.by_instance.get(attrs.instance_id, ())
    ]
    cluster_pg = groups.cluster_by_instance.get(attrs.instance_id)
    if cluster_pg:
        candidates.append(("cluster", cluster_pg))

    for kind, name in candidates:
        key = f"{kind}:{name}"
        if key not in cache:
            cache[key] = (
                _max_conn_from_group(rds_client, name) if kind == "db"
                else _max_conn_from_cluster_group(rds_client, name)
            )
        if cache[key] is not None:
            return cache[key]
    return None


def _max_conn_from_group(rds_client, group_name: str) -> int | None:
    return _max_conn_from_parameters(
        rds_client, "describe_db_parameters",
        {"DBParameterGroupName": group_name, "Source": "user"}, group_name,
    )


def _max_conn_from_cluster_group(rds_client, group_name: str) -> int | None:
    """读 **cluster** parameter group。Aurora PostgreSQL 的 max_connections 在这里。"""
    return _max_conn_from_parameters(
        rds_client, "describe_db_cluster_parameters",
        {"DBClusterParameterGroupName": group_name, "Source": "user"}, group_name,
    )


def _max_conn_from_parameters(
    rds_client, operation: str, params: dict, group_name: str
) -> int | None:
    """返回 None 表示「没读到数字」—— 包括参数组用的是默认公式字符串这种正常情形。"""
    try:
        pages = _paginate(rds_client, operation, params)
    except (ClientError, BotoCoreError) as exc:
        logger.debug("%s failed for %s: %s", operation, group_name, exc)
        return None

    for page in pages:
        for p in page.get("Parameters") or []:
            if p.get("ParameterName") != "max_connections":
                continue
            raw = p.get("ParameterValue")
            if raw is None:
                continue
            try:
                return int(str(raw).strip())
            except ValueError:
                # 默认值是公式字符串（LEAST({DBInstanceClassMemory/…},5000)）→ 交给兜底
                return None
    return None


# ---------------------------------------------------------------------------
# 内部工具
# ---------------------------------------------------------------------------


def _describe_all(
    client, operation: str, key: str, params: dict | None = None,
    errors: list[str] | None = None,
) -> list[dict]:
    """分页取全量。失败返回空列表并告警（单个服务不可用不该拖垮整轮）。

    ## 🔴 `errors` 是**必须传**的（对能产生 finding 的采集路径）

    失败被压成空列表，而空列表与「这个账号里真的没有资源」在返回值上完全一样。
    后果：

    ```
    rds:DescribeDBInstances 返回 AccessDenied / 限流
      → 空列表 → 0 finding → run 状态 success、completeness 100%
      → 看板按 last_run 显示「跑过了、没找到风险」
      → 昨天的 active finding 走 _step_missed；昨天刚建的直接
        RESOLVED + prediction_missed（真实风险被记成误报）
    ```

    `bff/web-chat/inspection.mjs::queryFindings` 里那段注释专门为了消灭
    「零风险」与「取数失败」的歧义而存在 —— 这条路径正好绕过它，
    因为 run 记录**确实**是 success。

    ⚠️ `errors` 收到的是 `"<operation>:describe_failed"`，由调用方转成
    `skipped` 标记落进 run 记录（`build_stats` 的 `skipped` 段）。
    """
    try:
        pages = _paginate(client, operation, params or {})
    except (ClientError, BotoCoreError) as exc:
        logger.warning("%s failed: %s", operation, exc)
        if errors is not None:
            errors.append(f"{operation}:describe_failed")
        return []
    out: list[dict] = []
    for page in pages:
        out.extend(page.get(key) or [])
    return out


def _paginate(client, operation: str, params: dict) -> list[dict]:
    try:
        paginator = client.get_paginator(operation)
    except Exception:  # noqa: BLE001 — OperationNotPageableError 或方法不存在
        return [getattr(client, operation)(**params)]
    return list(paginator.paginate(**params))


def _tag_map(tag_list) -> dict[str, str]:
    if not tag_list:
        return {}
    return {
        str(t.get("Key")): str(t.get("Value", ""))
        for t in tag_list if t.get("Key")
    }


def _as_int(v) -> int | None:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _as_float(v) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# memory_bytes 补全 —— 用 ec2:DescribeInstanceTypes（权威）
# ---------------------------------------------------------------------------


def enrich_memory(
    ec2_client, attrs_list: Iterable[ResourceAttrs]
) -> list[ResourceAttrs]:
    """补 `memory_bytes`，来源 `ec2:DescribeInstanceTypes.MemoryInfo.SizeInMiB`。

    RDS / ElastiCache 的规格名去掉 `db.` / `cache.` 前缀就是 EC2 机型
    （`db.r8g.large` → `r8g.large`），2026-08-17 实测 5 个规格全部命中。

    ⚠️ 这解锁的是 **R2.1.2**「FreeableMemory 低于实例内存 20%」——
    在此之前该规则没有分母，根本算不出来。

    ⚠️ 但它**不用来推 max_connections**：公式的分子是扣掉预留后的可用内存，
    实测比标称内存小很多（详见 `specs.resolve_max_connections` 的说明），
    高估分母会导致误报闲置。所以 memory_bytes 只服务内存类判定。

    ⚠️ 少数 RDS 专属规格（如 `db.m5d.*` 的部分变体、Outpost 规格）可能在 EC2 侧
    查不到 —— 查不到就留 None，不猜。
    """
    from dataclasses import replace

    wanted = sorted({
        t for t in (
            _ec2_type_of(a.instance_class) for a in attrs_list
            if a.instance_class and a.memory_bytes is None
        )
        if t and _is_real_ec2_type(t)
    })
    if not wanted:
        return list(attrs_list)

    mem_by_type = _describe_instance_type_memory(ec2_client, wanted)

    out: list[ResourceAttrs] = []
    for a in attrs_list:
        if a.memory_bytes is not None:
            out.append(a)
            continue
        mem = mem_by_type.get(_ec2_type_of(a.instance_class) or "")
        out.append(replace(a, memory_bytes=mem) if mem else a)
    return out


# 不是 EC2 机型的伪规格名。`db.serverless` 是 Aurora Serverless v2 的**默认**形态。
#
# ⚠️ 混进批里的代价不是「少一个内存值」，而是**整批被拒**：
# `describe_instance_types` 是全批拒绝语义（实测
# `InvalidInstanceType: The following supplied instance types do not exist: [serverless]`），
# 于是 except 分支退化成逐个重试 —— 100 次 API 调用而不是 1 次，
# 每一轮、每一个有 Serverless v2 的账号都是这样。
_NOT_EC2_TYPES = frozenset({"serverless"})


def _is_real_ec2_type(ec2_type: str) -> bool:
    """EC2 机型必须是 `family.size` 两段式，且不在伪规格名单里。"""
    return "." in ec2_type and ec2_type.split(".")[0] not in _NOT_EC2_TYPES


def _ec2_type_of(instance_class: str) -> str | None:
    """`db.r8g.large` → `r8g.large`；`cache.m5.large` → `m5.large`。"""
    ic = (instance_class or "").strip().lower()
    for prefix in ("db.", "cache."):
        if ic.startswith(prefix):
            return ic[len(prefix):] or None
    return ic or None


def _describe_instance_type_memory(
    ec2_client, instance_types: Sequence[str]
) -> dict[str, int]:
    """{ec2_type: memory_bytes}。分批查（API 单次上限 100 个）。"""
    out: dict[str, int] = {}
    batch_size = 100

    for i in range(0, len(instance_types), batch_size):
        batch = list(instance_types[i:i + batch_size])
        try:
            resp = ec2_client.describe_instance_types(InstanceTypes=batch)
        except (ClientError, BotoCoreError) as exc:
            # 整批失败常见于批里有一个无效机型（API 是全批拒绝语义）→ 逐个重试
            logger.debug("describe_instance_types batch failed (%s); retrying one by one", exc)
            for one in batch:
                try:
                    r = ec2_client.describe_instance_types(InstanceTypes=[one])
                except (ClientError, BotoCoreError):
                    continue
                out.update(_memory_map(r))
            continue
        out.update(_memory_map(resp))

    logger.info("resolved memory for %d/%d instance types", len(out), len(instance_types))
    return out


def _memory_map(resp: dict) -> dict[str, int]:
    out: dict[str, int] = {}
    for it in resp.get("InstanceTypes") or []:
        name = it.get("InstanceType")
        mib = (it.get("MemoryInfo") or {}).get("SizeInMiB")
        if name and mib:
            out[str(name)] = int(mib) * 1024 * 1024
    return out


# ---------------------------------------------------------------------------
# Aurora 的存储没有「分配容量」
# ---------------------------------------------------------------------------


def is_aurora(engine: str) -> bool:
    return (engine or "").strip().lower().startswith("aurora")


def _allocated_storage_of(db: dict) -> float | None:
    """Aurora 一律返回 None —— `AllocatedStorage` 是占位值，不是真实分配量。

    ⚠️ 2026-08-17 实测（验证账号 / us-east-1）：
    四台 Aurora 实例与两个 Aurora 集群的 `AllocatedStorage` **全都是 1**，
    而普通 RDS 是真实值（20 / 100）。
    Aurora 的集群卷按需增长（上限 128 TiB），没有「预先分配多少」这个概念。

    ⚠️ 把占位值 1 当分母的后果（这是本次抓到的真 bug）：
    `AuroraVolumeBytesLeftTotal` 约 261,919 GiB ÷ 1 GiB = **ratio 261919**，
    在闲置评分里被 clamp 到 1.0 直接吃满存储维度的分，
    在容量审计里则产出一条「存储超配」的假发现。
    返回 None 让 domain 层丢掉该维度并重归一化，这才是正确语义。
    """
    if is_aurora(db.get("Engine", "")):
        return None
    return _as_float(db.get("AllocatedStorage"))
