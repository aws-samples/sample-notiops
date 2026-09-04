#!/usr/bin/env python3
"""建/查/删一批**巡检采集层验证用**的真实资源。

## 这个脚本证明什么、不证明什么

```
证明     采集层能不能正确读出属性
         · 7 代 / 8 代 Graviton 机型能不能被 specs 识别（内存 / burstable）
         · Aurora 与社区版 RDS 分不分得开（latency 分档靠这个）
         · ElastiCache 集群模式启用 / 禁用 两种形状
         · Valkey 这个新引擎会不会被当成未知引擎静默丢掉
         · Performance Insights 的两个字段读不读得到
         · Multi-AZ / gp2 / 备份关闭 三条结构性规则的真实输入

不证明   判定链路
         判定要 `min_coverage_days = 5` 天的历史指标，新建实例只有几分钟。
         判定侧的覆盖靠 `tests/test_inspection_verdict_matrix.py`
         （20 行真实客户观测值）+ 伪造数据。两者不可互相替代：
         矩阵测的是「数值 → 结论」，这里测的是「AWS API → 属性」。
```

🔴 **删除只认自己的 tag。** 全部资源打 `Purpose=inspection-testbed`，
`purge` 只删带这个 tag 的。不靠名字前缀 —— 前缀匹配会在有人建了同名前缀的
真实资源时把它一起删掉，而 RDS 删除即使有快照也不可逆。

## 用法

```bash
python3 scripts/inspection_testbed.py create     # 发起创建（异步，立即返回）
python3 scripts/inspection_testbed.py status     # 看进度
python3 scripts/inspection_testbed.py purge      # 删（只删带 tag 的）
```

## 主密码

随机生成、**不打印、不落盘、不进 Secrets Manager**。巡检链路只做
`describe-*` 与 CloudWatch `GetMetricData`，压根不连数据库 —— 密码建完就
不再需要。测完实例就删，所以也不需要轮换。
"""

from __future__ import annotations

import secrets
import string
import sys

REGION = "ap-northeast-1"

_PROFILE = ""
"""`--profile` 的值。空 = 默认凭证（部署账号）。

🔴 多账号验证时必须能在**成员账号**里建资源 —— 否则巡检采到 0 台，
「采对了账号」这件事就无从验证（0 台和「用错凭证但那个账号刚好没资源」
长得一样）。
"""

_VPC_CACHE: dict[str, tuple[str, list[str]]] = {}


def _sess():
    """按 `--profile` 建 session。"""
    import boto3
    return boto3.Session(profile_name=_PROFILE) if _PROFILE else boto3.Session()


def _network():
    """目标账号的默认 VPC + 子网。**不能写死** —— 每个账号的 VPC id 都不同。

    ⚠️ 第一版把部署账号的 VPC / 子网 id 硬编码成常量，在成员账号里跑会报
    `InvalidSubnet` 或者更糟：如果那个 id 恰好在目标账号也存在（不可能，
    但 subnet-group 名字会撞），错误信息完全指不到根因。
    """
    key = _PROFILE or "-"
    if key in _VPC_CACHE:
        return _VPC_CACHE[key]
    ec2 = _sess().client("ec2", region_name=REGION)
    vpcs = ec2.describe_vpcs(
        Filters=[{"Name": "isDefault", "Values": ["true"]}])["Vpcs"]
    if not vpcs:
        raise RuntimeError(
            f"账号里没有默认 VPC（profile={_PROFILE or 'default'}）。"
            "手工建一个，或者改用现有 VPC 的子网。")
    vpc = vpcs[0]["VpcId"]
    subs = [s["SubnetId"] for s in ec2.describe_subnets(
        Filters=[{"Name": "vpc-id", "Values": [vpc]}])["Subnets"]]
    if len(subs) < 2:
        raise RuntimeError(f"{vpc} 里只有 {len(subs)} 个子网，RDS 子网组要 ≥2 个 AZ")
    _VPC_CACHE[key] = (vpc, subs)
    return vpc, subs


VPC = "vpc-0b4631532de48664e"
SUBNETS = ["subnet-09914f77c7e49edc1", "subnet-0655477a64cc3147c",
           "subnet-0183f6237a168cc60"]
DB_SUBNET_GROUP = "idle-detector-db-subnet"
"""部署账号里现成的子网组。成员账号里没有它 —— 见 `_ensure_db_subnet_group`。"""
OWN_DB_SUBNET_GROUP = "inspection-testbed-db"
"""本脚本自己建的子网组名（成员账号里用）。purge 不删它 ——
删子网组要等实例全消失，而那是异步的；留着不计费。"""
EC_SUBNET_GROUP = "inspection-testbed-ec"

TAG_KEY, TAG_VAL = "Purpose", "inspection-testbed"
MYSQL, PG = "8.4.9", "18.6"
AUR_MYSQL, AUR_PG = "8.4.mysql_aurora.8.4.7", "18.4"


def _pw() -> str:
    """RDS 主密码。⚠️ 排除 `/ " @ 空格` —— RDS 明确不接受这四个。"""
    alpha = string.ascii_letters + string.digits + "!#$%^&*()-_=+[]{}"
    return "".join(secrets.choice(alpha) for _ in range(24))


def _tags(**extra) -> list[dict]:
    t = [{"Key": TAG_KEY, "Value": TAG_VAL}]
    t += [{"Key": k, "Value": v} for k, v in extra.items()]
    return t


# ── RDS 实例清单 ────────────────────────────────────────────────────────
#
# `env` 决定 `Environment` tag，而 tier 判定读它 —— `burstable_in_prod` /
# `single_az_in_prod` 两条结构性规则只在 prod 上触发，所以必须有 prod 样本，
# 否则那两条规则的真实输入永远测不到。
RDS: list[dict] = [
    # 场景：burstable + CPUCreditBalance + burstable_in_prod 规则
    dict(id="insp-t4g-mysql", cls="db.t4g.micro", engine="mysql",
         ver=MYSQL, env="prod", storage="gp3", backup=1),
    # 场景：8 代 Graviton 非 burstable —— specs 要能查到它的内存
    dict(id="insp-m8g-mysql", cls="db.m8g.large", engine="mysql",
         ver=MYSQL, env="test", storage="gp3", backup=1),
    # 场景：7 代 + PostgreSQL（freeable_memory 的分母口径与 MySQL 不同）
    dict(id="insp-m7g-pg", cls="db.m7g.large", engine="postgres",
         ver=PG, env="test", storage="gp3", backup=1),
    # 场景：Performance Insights 开启 —— 读 attrs 的两个 PI 字段
    #       ⚠️ db.t4g.micro **不支持 PI**（实测），最小是 t4g.medium
    dict(id="insp-t4g-pi", cls="db.t4g.medium", engine="mysql",
         ver=MYSQL, env="test", storage="gp3", backup=1, pi=True),
    # 场景：gp2 卷 + 备份关闭 —— gp2_volume / backup_disabled 两条规则
    dict(id="insp-t4g-gp2", cls="db.t4g.micro", engine="mysql",
         ver=MYSQL, env="test", storage="gp2", backup=0),
    # 场景：Multi-AZ + prod —— 验证 single_az_in_prod **不**误报
    dict(id="insp-t4g-multiaz", cls="db.t4g.micro", engine="postgres",
         ver=PG, env="prod", storage="gp3", backup=1, multi_az=True),
]

# ── Aurora 集群清单 ─────────────────────────────────────────────────────
AURORA: list[dict] = [
    # 场景：Aurora MySQL —— latency 走 aurora 档（5ms/10ms 而非 15ms/30ms）
    dict(id="insp-aur-mysql", engine="aurora-mysql", ver=AUR_MYSQL,
         cls="db.t4g.medium", env="test"),
    # 场景：8 代 Aurora PostgreSQL
    dict(id="insp-aur-pg", engine="aurora-postgresql", ver=AUR_PG,
         cls="db.r8g.large", env="test"),
    # 场景：Serverless v2 —— **没有固定 instance_class**（写作 db.serverless）
    #       specs 查不到它的内存，闲置评分的 memory 维度要能优雅降级
    dict(id="insp-aur-sv2", engine="aurora-mysql", ver=AUR_MYSQL,
         cls="db.serverless", env="test", serverless=True),
]


def _ensure_db_subnet_group(r) -> str:
    """确保目标账号里有可用的 RDS 子网组，返回组名。

    🔴 **不能写死** `idle-detector-db-subnet` —— 那是**部署账号**的组。
    在成员账号里跑会报 `DBSubnetGroupNotFoundFault`，而那个错误信息不会
    提示「你连错账号了」。多账号验证时这是第一个撞上的墙。

    ⚠️ 已存在就复用（包括部署账号里那个现成的），不存在才建 ——
    建一个同名的会报 already exists，而复用别人的组是安全的（只读引用）。
    """
    for name in (DB_SUBNET_GROUP, OWN_DB_SUBNET_GROUP):
        try:
            r.describe_db_subnet_groups(DBSubnetGroupName=name)
            return name
        except r.exceptions.DBSubnetGroupNotFoundFault:
            continue
    _, subs = _network()
    r.create_db_subnet_group(
        DBSubnetGroupName=OWN_DB_SUBNET_GROUP,
        DBSubnetGroupDescription="inspection testbed",
        SubnetIds=subs[:3], Tags=_tags())
    print(f"  ✓ 建了 RDS 子网组 {OWN_DB_SUBNET_GROUP}（{len(subs[:3])} 个子网）")
    return OWN_DB_SUBNET_GROUP


def _rds(c):
    r = _sess().client("rds", region_name=REGION)
    grp = _ensure_db_subnet_group(r)
    for spec in RDS:
        kw = dict(
            DBInstanceIdentifier=spec["id"], DBInstanceClass=spec["cls"],
            Engine=spec["engine"], EngineVersion=spec["ver"],
            MasterUsername="admin" if spec["engine"] == "mysql" else "postgres",
            MasterUserPassword=_pw(),
            AllocatedStorage=20, StorageType=spec["storage"],
            DBSubnetGroupName=grp,
            BackupRetentionPeriod=spec["backup"],
            MultiAZ=bool(spec.get("multi_az")),
            PubliclyAccessible=False,
            # 🔴 保留删除保护**关闭**是刻意的：这是我自己建的临时验证实例，
            #    开了之后 purge 会失败而实例继续计费。
            #    ⚠️ 不要把这行抄到任何真实环境的模板里。
            DeletionProtection=False,
            Tags=_tags(Environment=spec["env"]),
        )
        if spec.get("pi"):
            kw.update(EnablePerformanceInsights=True,
                      PerformanceInsightsRetentionPeriod=7)
        try:
            r.create_db_instance(**kw)
            print(f"  ✓ RDS {spec['id']:20} {spec['cls']:16} {spec['engine']}")
        except r.exceptions.DBInstanceAlreadyExistsFault:
            print(f"  = RDS {spec['id']:20} 已存在，跳过")
        except Exception as e:                              # noqa: BLE001
            print(f"  ✗ RDS {spec['id']:20} {type(e).__name__}: "
                  f"{str(e)[:130]}")


def _aurora(c):
    r = _sess().client("rds", region_name=REGION)
    grp = _ensure_db_subnet_group(r)
    for spec in AURORA:
        cid = spec["id"]
        try:
            kw = dict(
                DBClusterIdentifier=cid, Engine=spec["engine"],
                EngineVersion=spec["ver"],
                MasterUsername=("admin" if "mysql" in spec["engine"]
                                else "postgres"),
                MasterUserPassword=_pw(),
                DBSubnetGroupName=grp,
                BackupRetentionPeriod=1, DeletionProtection=False,
                Tags=_tags(Environment=spec["env"]))
            if spec.get("serverless"):
                # Serverless v2 的容量在**集群**上声明，实例侧写 db.serverless。
                kw["ServerlessV2ScalingConfiguration"] = {
                    "MinCapacity": 0.5, "MaxCapacity": 1.0}
            r.create_db_cluster(**kw)
            print(f"  ✓ Aurora 集群 {cid:18} {spec['engine']}")
        except r.exceptions.DBClusterAlreadyExistsFault:
            print(f"  = Aurora 集群 {cid:18} 已存在，跳过")
        except Exception as e:                              # noqa: BLE001
            print(f"  ✗ Aurora 集群 {cid:18} {type(e).__name__}: "
                  f"{str(e)[:130]}")
            continue
        try:
            r.create_db_instance(
                DBInstanceIdentifier=f"{cid}-1",
                DBClusterIdentifier=cid, DBInstanceClass=spec["cls"],
                Engine=spec["engine"], PubliclyAccessible=False,
                Tags=_tags(Environment=spec["env"]))
            print(f"  ✓ Aurora 实例 {cid}-1  {spec['cls']}")
        except r.exceptions.DBInstanceAlreadyExistsFault:
            print(f"  = Aurora 实例 {cid}-1 已存在，跳过")
        except Exception as e:                              # noqa: BLE001
            print(f"  ✗ Aurora 实例 {cid}-1 {type(e).__name__}: "
                  f"{str(e)[:130]}")


# ── ElastiCache 清单 ────────────────────────────────────────────────────
#
# 🔴 集群模式**启用**与**禁用**是两个不同的 API：
#    禁用 → `create_cache_cluster`（单节点）或 replication group 单分片
#    启用 → `create_replication_group` + `NumNodeGroups > 1`
#    采集层要能同时认这两种形状 —— 客户往往两种混着用。
def _ec(c):
    e = _sess().client("elasticache", region_name=REGION)
    try:
        e.create_cache_subnet_group(
            CacheSubnetGroupName=EC_SUBNET_GROUP,
            CacheSubnetGroupDescription="inspection testbed",
            SubnetIds=_network()[1][:3], Tags=_tags())
        print(f"  ✓ EC 子网组 {EC_SUBNET_GROUP}")
    except e.exceptions.CacheSubnetGroupAlreadyExistsFault:
        print(f"  = EC 子网组 {EC_SUBNET_GROUP} 已存在")
    except Exception as ex:                                 # noqa: BLE001
        print(f"  ✗ EC 子网组 {type(ex).__name__}: {str(ex)[:130]}")

    # 场景 ①：Redis 集群模式**禁用**（单分片 replication group）
    # 场景 ②：Valkey —— 新引擎，验证不会被当未知引擎丢掉
    for rid, engine, ver in (("insp-ec-redis", "redis", None),
                             ("insp-ec-valkey", "valkey", None)):
        kw = dict(
            ReplicationGroupId=rid,
            ReplicationGroupDescription=f"testbed {engine}",
            Engine=engine, CacheNodeType="cache.t4g.micro",
            NumCacheClusters=1, CacheSubnetGroupName=EC_SUBNET_GROUP,
            # ⚠️ 单节点时 Multi-AZ / 自动故障转移必须关 —— 开了会被拒
            AutomaticFailoverEnabled=False,
            Tags=_tags(Environment="test"))
        if ver:
            kw["EngineVersion"] = ver
        if engine == "valkey":
            # 🔴 Valkey 与 Redis OSS 的一处真实 API 差异（2026-08-24 实测）：
            #    Valkey **强制**要求显式声明 `TransitEncryptionEnabled`，
            #    不给就是 `InvalidParameterValue: You must specify a value
            #    (true or false) for the parameter TransitEncryptionEnabled`。
            #    Redis 引擎缺省即可。
            #
            # ⚠️ 这里写 False 只因为是**不含数据的临时验证实例**，而开 True
            #    要连带配 auth token。任何承载真实数据的 Valkey 都该开。
            kw["TransitEncryptionEnabled"] = False
        try:
            e.create_replication_group(**kw)
            print(f"  ✓ EC {rid:18} {engine} 集群模式禁用")
        except e.exceptions.ReplicationGroupAlreadyExistsFault:
            print(f"  = EC {rid:18} 已存在，跳过")
        except Exception as ex:                             # noqa: BLE001
            print(f"  ✗ EC {rid:18} {type(ex).__name__}: {str(ex)[:130]}")

    # 场景 ③：Redis 集群模式**启用** —— 2 分片，每分片 1 节点
    try:
        e.create_replication_group(
            ReplicationGroupId="insp-ec-sharded",
            ReplicationGroupDescription="testbed sharded",
            Engine="redis", CacheNodeType="cache.t4g.micro",
            NumNodeGroups=2, ReplicasPerNodeGroup=0,
            CacheSubnetGroupName=EC_SUBNET_GROUP,
            AutomaticFailoverEnabled=True,
            Tags=_tags(Environment="prod"))
        print("  ✓ EC insp-ec-sharded    redis 集群模式启用（2 分片）")
    except e.exceptions.ReplicationGroupAlreadyExistsFault:
        print("  = EC insp-ec-sharded    已存在，跳过")
    except Exception as ex:                                 # noqa: BLE001
        print(f"  ✗ EC insp-ec-sharded  {type(ex).__name__}: {str(ex)[:130]}")

    # 场景 ④：Memcached —— 多线程，判定口径与 Redis 相反
    #         （判整机 CPUUtilization，且没有 MemoryFragmentationRatio）
    try:
        e.create_cache_cluster(
            CacheClusterId="insp-ec-memcached", Engine="memcached",
            CacheNodeType="cache.t4g.micro", NumCacheNodes=2,
            CacheSubnetGroupName=EC_SUBNET_GROUP,
            Tags=_tags(Environment="test"))
        print("  ✓ EC insp-ec-memcached  memcached 2 节点")
    except e.exceptions.CacheClusterAlreadyExistsFault:
        print("  = EC insp-ec-memcached  已存在，跳过")
    except Exception as ex:                                 # noqa: BLE001
        print(f"  ✗ EC insp-ec-memcached {type(ex).__name__}: {str(ex)[:130]}")


def create() -> int:
    c = _sess()
    print(f"创建巡检验证资源（region {REGION}，tag {TAG_KEY}={TAG_VAL}）\n")
    print("RDS 单实例:")
    _rds(c)
    print("\nAurora 集群:")
    _aurora(c)
    print("\nElastiCache:")
    _ec(c)
    print("\n发起完毕。RDS 约 6~12 分钟可用，Aurora 集群 10~18 分钟。")
    print("看进度: python3 scripts/inspection_testbed.py status")
    return 0


def status() -> int:
    r = _sess().client("rds", region_name=REGION)
    e = _sess().client("elasticache", region_name=REGION)
    ready = total = 0
    print("RDS / Aurora:")
    for d in r.describe_db_instances()["DBInstances"]:
        if not d["DBInstanceIdentifier"].startswith("insp-"):
            continue
        total += 1
        st = d["DBInstanceStatus"]
        ready += st == "available"
        cls = d["DBInstanceClass"]
        pi = "PI" if d.get("PerformanceInsightsEnabled") else "  "
        az = "MultiAZ" if d.get("MultiAZ") else "1AZ"
        print(f"  {d['DBInstanceIdentifier']:22} {cls:16} "
              f"{d['Engine']:20} {st:12} {pi} {az} "
              f"{d.get('StorageType','-')}")
    print("\nElastiCache:")
    for g in e.describe_replication_groups().get("ReplicationGroups", []):
        if not g["ReplicationGroupId"].startswith("insp-"):
            continue
        total += 1
        st = g["Status"]
        ready += st == "available"
        shards = len(g.get("NodeGroups", []))
        mode = "集群启用" if g.get("ClusterEnabled") else "集群禁用"
        print(f"  {g['ReplicationGroupId']:22} "
              f"{g.get('CacheNodeType','-'):16} "
              f"{g.get('Engine','-'):8} {st:12} {mode} {shards} 分片")
    for cc in e.describe_cache_clusters().get("CacheClusters", []):
        cid = cc["CacheClusterId"]
        if not cid.startswith("insp-") or cc.get("ReplicationGroupId"):
            continue
        total += 1
        ready += cc["CacheClusterStatus"] == "available"
        print(f"  {cid:22} {cc.get('CacheNodeType','-'):16} "
              f"{cc.get('Engine','-'):8} {cc['CacheClusterStatus']:12} "
              f"{cc.get('NumCacheNodes','?')} 节点")
    print(f"\n就绪 {ready}/{total}")
    return 0 if total and ready == total else 1


def purge() -> int:
    """删除。**只删带 `Purpose=inspection-testbed` tag 的**。

    🔴 不按名字前缀删。前缀匹配会在有人建了同名前缀的真实资源时把它一起
    删掉，而 RDS 的删除即使留了快照也不可逆（快照恢复是新实例，端点变了）。
    """
    r = _sess().client("rds", region_name=REGION)
    e = _sess().client("elasticache", region_name=REGION)

    def tagged_rds(arn: str) -> bool:
        try:
            tl = r.list_tags_for_resource(ResourceName=arn)["TagList"]
            return any(t["Key"] == TAG_KEY and t["Value"] == TAG_VAL
                       for t in tl)
        except Exception:                                   # noqa: BLE001
            return False

    n = 0
    # ① 先删实例（Aurora 集群必须先空）
    for d in r.describe_db_instances()["DBInstances"]:
        if not tagged_rds(d["DBInstanceArn"]):
            continue
        try:
            r.delete_db_instance(DBInstanceIdentifier=d["DBInstanceIdentifier"],
                                 SkipFinalSnapshot=True,
                                 DeleteAutomatedBackups=True)
            print(f"  ✓ 删除实例 {d['DBInstanceIdentifier']}")
            n += 1
        except Exception as ex:                             # noqa: BLE001
            print(f"  ✗ {d['DBInstanceIdentifier']}: "
                  f"{type(ex).__name__}: {str(ex)[:110]}")
    # ② 再删集群
    for cl in r.describe_db_clusters().get("DBClusters", []):
        if not tagged_rds(cl["DBClusterArn"]):
            continue
        try:
            r.delete_db_cluster(DBClusterIdentifier=cl["DBClusterIdentifier"],
                                SkipFinalSnapshot=True)
            print(f"  ✓ 删除集群 {cl['DBClusterIdentifier']}")
            n += 1
        except Exception as ex:                             # noqa: BLE001
            print(f"  ✗ {cl['DBClusterIdentifier']}: "
                  f"{type(ex).__name__}: {str(ex)[:110]}")
    # ③ ElastiCache
    for g in e.describe_replication_groups().get("ReplicationGroups", []):
        gid = g["ReplicationGroupId"]
        if not gid.startswith("insp-"):
            continue
        try:
            tl = e.list_tags_for_resource(ResourceName=g["ARN"])["TagList"]
            if not any(t["Key"] == TAG_KEY and t["Value"] == TAG_VAL
                       for t in tl):
                continue
            e.delete_replication_group(ReplicationGroupId=gid,
                                       RetainPrimaryCluster=False)
            print(f"  ✓ 删除 EC 组 {gid}")
            n += 1
        except Exception as ex:                             # noqa: BLE001
            print(f"  ✗ {gid}: {type(ex).__name__}: {str(ex)[:110]}")
    for cc in e.describe_cache_clusters().get("CacheClusters", []):
        cid = cc["CacheClusterId"]
        if not cid.startswith("insp-") or cc.get("ReplicationGroupId"):
            continue
        try:
            e.delete_cache_cluster(CacheClusterId=cid)
            print(f"  ✓ 删除 EC 集群 {cid}")
            n += 1
        except Exception as ex:                             # noqa: BLE001
            print(f"  ✗ {cid}: {type(ex).__name__}: {str(ex)[:110]}")
    print(f"\n发起删除 {n} 项。子网组要等节点都消失之后才能删。")
    return 0


def main() -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("cmd", nargs="?", default="status",
                    choices=["create", "status", "purge"])
    ap.add_argument("--profile", default="",
                    help="在**哪个账号**里建/查/删（多账号验证用）。"
                         "缺省 = 默认凭证（部署账号）")
    args = ap.parse_args()

    global _PROFILE
    _PROFILE = args.profile
    if _PROFILE:
        who = _sess().client("sts").get_caller_identity()
        print(f"⚠️  profile={_PROFILE} → 账号 {who['Account']}  region={REGION}\n")

    return {"create": create, "status": status, "purge": purge}[args.cmd]()


if __name__ == "__main__":
    raise SystemExit(main())
