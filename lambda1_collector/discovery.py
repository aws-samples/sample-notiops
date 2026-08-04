"""
资源发现模块。
调用 RDS 和 ElastiCache Describe API 发现所有实例，
提取元数据和标签，支持分页和指数退避重试。
"""

import logging
import time
import functools
from dataclasses import dataclass, field

from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


@dataclass
class InstanceMetadata:
    instance_id: str
    resource_type: str          # 'rds' | 'elasticache'
    instance_class: str
    engine: str
    tags: dict[str, str] = field(default_factory=dict)
    region: str = ""
    account_id: str = ""
    status: str = ""
    allocated_storage_gb: float | None = None  # RDS only
    num_cache_nodes: int | None = None         # ElastiCache only
    engine_version: str | None = None          # RDS + ElastiCache engine version
    # 🆕 拓扑字段（ElastiCache only）
    replication_group_id: str | None = None
    node_role: str | None = None               # "primary" | "replica"
    shard_id: str | None = None
    cluster_enabled: bool | None = None
    num_shards: int | None = None
    num_replicas_per_shard: int | None = None
    multi_az: str | None = None                # "enabled" | "disabled"
    automatic_failover: str | None = None      # "enabled" | "disabled" | "enabling" | "disabling"


def retry_with_backoff(max_retries: int = 3, initial_wait: float = 1.0, max_wait: float = 30.0):
    """指数退避重试装饰器。"""
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            wait = initial_wait
            for attempt in range(max_retries + 1):
                try:
                    return func(*args, **kwargs)
                except ClientError as e:
                    error_code = e.response["Error"]["Code"]
                    if attempt == max_retries:
                        logger.error(
                            "%s failed after %d retries: %s",
                            func.__name__, max_retries, e,
                        )
                        raise
                    if error_code == "Throttling" or "Throttl" in error_code:
                        logger.warning(
                            "%s throttled, retrying in %.1fs (attempt %d/%d)",
                            func.__name__, wait, attempt + 1, max_retries,
                        )
                    else:
                        logger.warning(
                            "%s failed with %s, retrying in %.1fs (attempt %d/%d)",
                            func.__name__, error_code, wait, attempt + 1, max_retries,
                        )
                    time.sleep(wait)  # nosemgrep: arbitrary-sleep — exponential retry backoff
                    wait = min(wait * 2, max_wait)
        return wrapper
    return decorator


@retry_with_backoff()
def discover_rds_instances(clients: dict) -> list[InstanceMetadata]:
    """
    调用 describe_db_instances 发现所有 RDS 实例。
    处理分页，提取元数据和标签，标记 account_id 和 region。
    """
    rds_client = clients["rds_client"]
    region = clients["region"]
    instances = []

    paginator = rds_client.get_paginator("describe_db_instances")
    for page in paginator.paginate():
        for db in page["DBInstances"]:
            # 提取标签
            tags = {}
            tag_list = db.get("TagList", [])
            for tag in tag_list:
                tags[tag["Key"]] = tag["Value"]

            instances.append(
                InstanceMetadata(
                    instance_id=db["DBInstanceIdentifier"],
                    resource_type="rds",
                    instance_class=db.get("DBInstanceClass", ""),
                    engine=db.get("Engine", ""),
                    tags=tags,
                    region=region,
                    account_id="",  # 由调用方设置
                    status=db.get("DBInstanceStatus", ""),
                    allocated_storage_gb=float(db.get("AllocatedStorage", 0)) if db.get("AllocatedStorage") else None,
                    engine_version=db.get("EngineVersion"),
                )
            )

    logger.info("Discovered %d RDS instances in %s", len(instances), region)
    return instances


@retry_with_backoff()
def discover_elasticache_clusters(
    clients: dict,
    topology_map: dict[str, dict] | None = None,
) -> tuple[list[InstanceMetadata], dict[str, str]]:
    """
    调用 describe_cache_clusters 发现所有 ElastiCache 集群。
    使用 ShowCacheNodeInfo=True 获取节点信息，处理分页。

    返回:
        (instances, node_endpoint_map) 元组。
        node_endpoint_map: {CacheClusterId → endpoint_address}，
        用于 CME 下判定节点角色。
    """
    ec_client = clients["elasticache_client"]
    region = clients["region"]
    instances = []
    node_endpoint_map: dict[str, str] = {}

    paginator = ec_client.get_paginator("describe_cache_clusters")
    for page in paginator.paginate(ShowCacheNodeInfo=True):
        for cluster in page["CacheClusters"]:
            cluster_id = cluster["CacheClusterId"]
            engine = cluster.get("Engine", "")

            # 提取节点 endpoint 到 node_endpoint_map
            cache_nodes = cluster.get("CacheNodes", [])
            if cache_nodes:
                endpoint = cache_nodes[0].get("Endpoint")
                if endpoint is not None:
                    address = endpoint.get("Address", "")
                    if address:
                        node_endpoint_map[cluster_id] = address

            # ElastiCache 标签需要单独调用 list_tags_for_resource
            tags = {}
            arn = cluster.get("ARN", "")
            if arn:
                try:
                    tag_response = ec_client.list_tags_for_resource(ResourceName=arn)
                    for tag in tag_response.get("TagList", []):
                        tags[tag["Key"]] = tag["Value"]
                except ClientError as e:
                    logger.warning("Failed to get tags for %s: %s", arn, e)

            # 确定拓扑字段
            topo_kwargs: dict = {}
            if engine.lower() == "memcached":
                # Memcached 不支持复制组，拓扑字段全 None
                pass
            elif topology_map is not None and cluster_id in topology_map:
                topo_info = topology_map[cluster_id]
                topo_kwargs = {
                    "replication_group_id": topo_info.get("replication_group_id"),
                    "node_role": topo_info.get("node_role"),
                    "shard_id": topo_info.get("shard_id"),
                    "cluster_enabled": topo_info.get("cluster_enabled"),
                    "num_shards": topo_info.get("num_shards"),
                    "num_replicas_per_shard": topo_info.get("num_replicas_per_shard"),
                    "multi_az": topo_info.get("multi_az"),
                    "automatic_failover": topo_info.get("automatic_failover"),
                }
            # else: standalone 或未提供 topology_map → 全 None（默认值）

            instances.append(
                InstanceMetadata(
                    instance_id=cluster_id,
                    resource_type="elasticache",
                    instance_class=cluster.get("CacheNodeType", ""),
                    engine=engine,
                    tags=tags,
                    region=region,
                    account_id="",  # 由调用方设置
                    status=cluster.get("CacheClusterStatus", ""),
                    num_cache_nodes=cluster.get("NumCacheNodes"),
                    engine_version=cluster.get("EngineVersion"),
                    **topo_kwargs,
                )
            )

    logger.info("Discovered %d ElastiCache clusters in %s", len(instances), region)
    return instances, node_endpoint_map


def discover_replication_groups(
    clients: dict,
    node_endpoint_map: dict[str, str],
) -> dict[str, dict]:
    """
    调用 describe_replication_groups API 获取所有复制组拓扑信息。

    不使用 @retry_with_backoff 装饰器，改为函数内部逐页 try/except：
    - 每页独立捕获异常，单页失败不丢弃已获取的前序页面数据
    - 整个函数外层再包一个 try/except，完全失败时返回空字典

    参数:
        clients: AWS 客户端字典
        node_endpoint_map: {CacheClusterId → endpoint_address} 映射，
            用于 CME 下判定节点角色。

    返回: {cache_cluster_id: {拓扑信息字典}}
    """
    try:
        ec_client = clients["elasticache_client"]
        topology: dict[str, dict] = {}

        paginator = ec_client.get_paginator("describe_replication_groups")
        for page in paginator.paginate():
            try:
                for rg in page.get("ReplicationGroups", []):
                    rg_id = rg.get("ReplicationGroupId", "")
                    cluster_enabled = rg.get("ClusterEnabled", False)
                    multi_az = rg.get("MultiAZ", "disabled")
                    automatic_failover = rg.get("AutomaticFailover", "disabled")
                    node_groups = rg.get("NodeGroups", [])
                    num_shards = len(node_groups)

                    for ng in node_groups:
                        shard_id = ng.get("NodeGroupId", "")
                        members = ng.get("NodeGroupMembers", [])
                        num_replicas = max(len(members) - 1, 0)

                        # CME: 获取 PrimaryEndpoint 用于角色判定
                        primary_endpoint_addr = ""
                        if cluster_enabled:
                            primary_ep = ng.get("PrimaryEndpoint")
                            if primary_ep is not None:
                                primary_endpoint_addr = primary_ep.get("Address", "")

                        for member in members:
                            cache_cluster_id = member.get("CacheClusterId", "")
                            if not cache_cluster_id:
                                continue

                            # 判定节点角色
                            if cluster_enabled:
                                # CME: 通过 endpoint 比较判定角色
                                node_ep = node_endpoint_map.get(cache_cluster_id, "")
                                if node_ep and primary_endpoint_addr and node_ep == primary_endpoint_addr:
                                    node_role = "primary"
                                else:
                                    node_role = "replica"
                            else:
                                # CMD: 直接读取 CurrentRole
                                node_role = member.get("CurrentRole", "replica")

                            topology[cache_cluster_id] = {
                                "replication_group_id": rg_id,
                                "node_role": node_role,
                                "shard_id": shard_id,
                                "cluster_enabled": cluster_enabled,
                                "num_shards": num_shards,
                                "num_replicas_per_shard": num_replicas,
                                "multi_az": multi_az,
                                "automatic_failover": automatic_failover,
                            }

            except Exception as e:
                logger.warning(
                    "Failed to process a page of describe_replication_groups: %s", e
                )
                continue

        logger.info(
            "Discovered topology for %d ElastiCache nodes from replication groups",
            len(topology),
        )
        return topology

    except Exception as e:
        logger.error("describe_replication_groups completely failed: %s", e)
        return {}
