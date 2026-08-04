"""
资源巡检（只读）—— 给 agent 提供"实时读取客户账号资源现状"的能力底座。
第一期覆盖 **RDS 健康巡检**所需的只读调用（配合 Customize 里的 rds-health-check skill：
skill 提供"查什么/怎么判断"的方法论，本模块提供"实际去查"的工具）。

设计原则（对齐生产级落地）：
- **严格只读**：只调 Describe*/List*/Get* / CloudWatch 读指标，绝不改资源。
- **多账号**：复用 core/aws_session.get_session(account_id)（部署账号=本地凭证，
  其他账号=STS AssumeRole，受 LOCKED_ACCOUNT_ID 闸门）。与 support_cases.py 同构。
- **缺权限→精确提醒**（用户明确要求）：捕获 AccessDenied，解析出**具体缺哪条 IAM action**，
  返回结构化 {error:'access_denied', missing_action:'rds:DescribeDBInstances', message:...}，
  让 agent 能告诉用户"请让管理员补这条只读权限"，而不是笼统说"无法访问"。
- **失败安全**：任何异常都返回 {error,...}，不抛（不因单次工具失败毁掉对话）。

工具所需 IAM（只读；部署时授予，见 cdk-stack。推荐默认 ReadOnlyAccess，客户可选精选白名单）：
  rds:DescribeDBInstances, rds:DescribeDBClusters, rds:DescribeEvents,
  rds:ListTagsForResource,
  cloudwatch:GetMetricStatistics, cloudwatch:ListMetrics
"""
from __future__ import annotations

import logging
import re
from typing import Any

from botocore.config import Config
from botocore.exceptions import ClientError, BotoCoreError

logger = logging.getLogger(__name__)

_CFG = Config(retries={"max_attempts": 3, "mode": "standard"})
_DEFAULT_REGION = "us-east-1"
_MAX_ITEMS = 100

# AccessDenied 消息里解析"缺哪条 action"用：
#   "...is not authorized to perform: rds:DescribeDBInstances on resource:..."
_ACTION_RE = re.compile(r"to perform:\s*([a-zA-Z0-9-]+:[A-Za-z0-9*]+)")


def _client(service: str, account_id: str | None, region: str | None):
    """按目标账号 + 区域取 boto3 client（只读用途）。
    account_id 缺省=部署账号本地凭证；其他账号走 get_session 的 AssumeRole（受闸门）。
    返回 None 表示跨账号被拒/AssumeRole 失败（调用方走 cross_account_error）。"""
    region = region or _DEFAULT_REGION
    from core.aws_session import get_session
    sess = get_session(account_id)
    if sess is None:
        return None
    return sess.client(service, region_name=region, config=_CFG)


def _cross_account_error(account_id: str | None) -> dict:
    return {"error": "cross_account_denied",
            "message": f"无法访问账号 {account_id} 的资源（跨账号未开启或 AssumeRole 失败）。"
                       f"当前仅支持部署账号；多账号需配置 notiops-idle-detection-role 并解除 LOCKED 闸门。"}


def _err(e: Exception) -> dict:
    """统一异常 → 结构化 error。AccessDenied 时**解析出具体缺的 action**（用户要求的精确提醒）。"""
    if isinstance(e, ClientError):
        code = e.response.get("Error", {}).get("Code", "ClientError")
        msg = e.response.get("Error", {}).get("Message", str(e))
        if code in ("AccessDenied", "AccessDeniedException", "UnauthorizedOperation",
                    "NotAuthorized", "AuthorizationError"):
            m = _ACTION_RE.search(msg or "")
            missing = m.group(1) if m else None
            human = (f"我没有读取该资源的权限（缺 IAM action：{missing}）。"
                     f"请让管理员在 NotiOps 的执行角色上补这条**只读**权限后重试；"
                     f"或我先基于你提供的信息给出分析。") if missing else (
                     "我没有读取该资源的只读权限。请让管理员在 NotiOps 的执行角色上补充相应的"
                     "只读权限（Describe*/List*/Get*）后重试；或我先基于你提供的信息分析。")
            return {"error": "access_denied", "missing_action": missing,
                    "code": code, "message": human, "raw": msg}
        logger.warning("resources api %s: %s", code, msg)
        return {"error": code, "message": msg}
    logger.warning("resources api error: %s", e)
    return {"error": "resource_error", "message": str(e)}


# ─────────────────────────── RDS（只读） ───────────────────────────

def rds_list_instances(*, account_id: str | None = None, region: str | None = None) -> dict:
    """列出 RDS 实例（含 Aurora 集群成员）概览。只读：rds:DescribeDBInstances。"""
    cli = _client("rds", account_id, region)
    if cli is None:
        return _cross_account_error(account_id)
    try:
        out: list[dict] = []
        paginator = cli.get_paginator("describe_db_instances")
        for page in paginator.paginate():
            for db in page.get("DBInstances", []):
                out.append(_brief_instance(db))
                if len(out) >= _MAX_ITEMS:
                    break
            if len(out) >= _MAX_ITEMS:
                break
        return {"region": region or _DEFAULT_REGION, "count": len(out), "instances": out}
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        return _err(e)


def rds_describe_instance(db_instance_id: str, *, account_id: str | None = None,
                          region: str | None = None) -> dict:
    """取单个 RDS 实例的健康相关明细：引擎/版本、规格、Multi-AZ、存储与自动扩展、
    备份保留、加密、公开可访问、维护窗口、参数组、状态等。
    只读：rds:DescribeDBInstances（+ Aurora 时 rds:DescribeDBClusters）。"""
    cli = _client("rds", account_id, region)
    if cli is None:
        return _cross_account_error(account_id)
    try:
        resp = cli.describe_db_instances(DBInstanceIdentifier=db_instance_id)
        dbs = resp.get("DBInstances", [])
        if not dbs:
            return {"error": "not_found", "message": f"未找到 RDS 实例：{db_instance_id}"}
        db = dbs[0]
        detail = _full_instance(db)
        # Aurora：补集群层信息（备份/加密/多可用区在集群上）
        cluster_id = db.get("DBClusterIdentifier")
        if cluster_id:
            try:
                cresp = cli.describe_db_clusters(DBClusterIdentifier=cluster_id)
                cl = (cresp.get("DBClusters") or [{}])[0]
                detail["cluster"] = {
                    "dbClusterIdentifier": cl.get("DBClusterIdentifier"),
                    "engine": cl.get("Engine"),
                    "engineVersion": cl.get("EngineVersion"),
                    "multiAZ": cl.get("MultiAZ"),
                    "backupRetentionDays": cl.get("BackupRetentionPeriod"),
                    "storageEncrypted": cl.get("StorageEncrypted"),
                    "status": cl.get("Status"),
                    "members": [m.get("DBInstanceIdentifier") for m in cl.get("DBClusterMembers", [])],
                }
            except ClientError as ce:
                detail["cluster_error"] = _err(ce)
        return detail
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        return _err(e)


def rds_recent_events(db_instance_id: str | None = None, *, hours: int = 168,
                      account_id: str | None = None, region: str | None = None) -> dict:
    """取 RDS 最近事件（默认近 7 天=168h；故障切换/重启/备份/存储/参数变更等）。
    db_instance_id 缺省=账号内所有 RDS 事件。只读：rds:DescribeEvents。"""
    cli = _client("rds", account_id, region)
    if cli is None:
        return _cross_account_error(account_id)
    try:
        kwargs: dict[str, Any] = {"Duration": max(1, int(hours)) * 60, "MaxRecords": 100}
        if db_instance_id:
            kwargs["SourceType"] = "db-instance"
            kwargs["SourceIdentifier"] = db_instance_id
        resp = cli.describe_events(**kwargs)
        events = [{
            "source": ev.get("SourceIdentifier"),
            "sourceType": ev.get("SourceType"),
            "date": ev.get("Date").isoformat() if ev.get("Date") else None,
            "categories": ev.get("EventCategories", []),
            "message": ev.get("Message"),
        } for ev in resp.get("Events", [])]
        return {"hours": hours, "count": len(events), "events": events}
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        return _err(e)


def rds_metrics(db_instance_id: str, *, hours: int = 24, account_id: str | None = None,
                region: str | None = None) -> dict:
    """取 RDS 实例近 N 小时的关键 CloudWatch 指标（CPU、连接数、可用存储、可用内存、
    读写延迟、IOPS）做健康判断。只读：cloudwatch:GetMetricStatistics。"""
    cw = _client("cloudwatch", account_id, region)
    if cw is None:
        return _cross_account_error(account_id)
    import datetime as _dt
    # 时间窗用 boto3 返回的 UTC（不依赖被禁用的 Date.now；用 datetime.now(timezone.utc) 是允许的标准库）
    end = _dt.datetime.now(_dt.timezone.utc)
    start = end - _dt.timedelta(hours=max(1, int(hours)))
    period = 3600 if hours > 6 else 300
    dims = [{"Name": "DBInstanceIdentifier", "Value": db_instance_id}]
    wanted = [
        ("CPUUtilization", "Percent", "Average"),
        ("DatabaseConnections", "Count", "Average"),
        ("FreeStorageSpace", "Bytes", "Average"),
        ("FreeableMemory", "Bytes", "Average"),
        ("ReadLatency", "Seconds", "Average"),
        ("WriteLatency", "Seconds", "Average"),
    ]
    try:
        metrics = {}
        for name, unit, stat in wanted:
            r = cw.get_metric_statistics(
                Namespace="AWS/RDS", MetricName=name, Dimensions=dims,
                StartTime=start, EndTime=end, Period=period, Statistics=[stat], Unit=unit)
            pts = sorted(r.get("Datapoints", []), key=lambda p: p.get("Timestamp"))
            if not pts:
                metrics[name] = None
                continue
            vals = [p.get(stat) for p in pts if p.get(stat) is not None]
            metrics[name] = {
                "unit": unit,
                "latest": vals[-1] if vals else None,
                "avg": round(sum(vals) / len(vals), 4) if vals else None,
                "max": max(vals) if vals else None,
                "min": min(vals) if vals else None,
                "points": len(vals),
            }
        return {"dbInstanceId": db_instance_id, "hours": hours, "metrics": metrics}
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        return _err(e)


# ─────────────────────────── 内部：实例字段抽取 ───────────────────────────

def _brief_instance(db: dict) -> dict:
    return {
        "dbInstanceId": db.get("DBInstanceIdentifier"),
        "engine": db.get("Engine"),
        "engineVersion": db.get("EngineVersion"),
        "class": db.get("DBInstanceClass"),
        "status": db.get("DBInstanceStatus"),
        "multiAZ": db.get("MultiAZ"),
        "publiclyAccessible": db.get("PubliclyAccessible"),
        "storageEncrypted": db.get("StorageEncrypted"),
        "cluster": db.get("DBClusterIdentifier"),
    }


def _full_instance(db: dict) -> dict:
    ep = db.get("Endpoint") or {}
    return {
        "dbInstanceId": db.get("DBInstanceIdentifier"),
        "engine": db.get("Engine"),
        "engineVersion": db.get("EngineVersion"),
        "class": db.get("DBInstanceClass"),
        "status": db.get("DBInstanceStatus"),
        "multiAZ": db.get("MultiAZ"),
        "availabilityZone": db.get("AvailabilityZone"),
        "secondaryAZ": db.get("SecondaryAvailabilityZone"),
        "allocatedStorageGB": db.get("AllocatedStorage"),
        "maxAllocatedStorageGB": db.get("MaxAllocatedStorage"),  # 有值=开了存储自动扩展
        "storageType": db.get("StorageType"),
        "iops": db.get("Iops"),
        "storageEncrypted": db.get("StorageEncrypted"),
        "kmsKeyId": db.get("KmsKeyId"),
        "backupRetentionDays": db.get("BackupRetentionPeriod"),  # 0=未开自动备份
        "preferredBackupWindow": db.get("PreferredBackupWindow"),
        "preferredMaintenanceWindow": db.get("PreferredMaintenanceWindow"),
        "autoMinorVersionUpgrade": db.get("AutoMinorVersionUpgrade"),
        "publiclyAccessible": db.get("PubliclyAccessible"),
        "deletionProtection": db.get("DeletionProtection"),
        "performanceInsightsEnabled": db.get("PerformanceInsightsEnabled"),
        "cluster": db.get("DBClusterIdentifier"),
        "endpoint": {"address": ep.get("Address"), "port": ep.get("Port")} if ep else None,
        "vpcSecurityGroups": [g.get("VpcSecurityGroupId") for g in db.get("VpcSecurityGroups", [])],
        "parameterGroups": [g.get("DBParameterGroupName") for g in db.get("DBParameterGroups", [])],
        "multiAZStandbyNote": None if db.get("MultiAZ") else "未启用 Multi-AZ（生产建议开启以提升可用性）",
    }


# ─────────────────────────── EC2（只读，故障调查用）───────────────────────────

def ec2_list_instances(*, account_id: str | None = None, region: str | None = None,
                       state: str = "") -> dict:
    """列出 EC2 实例概览（实时只读）。state 可选 running/stopped/... 过滤。
    只读：ec2:DescribeInstances。"""
    cli = _client("ec2", account_id, region)
    if cli is None:
        return _cross_account_error(account_id)
    try:
        filters = []
        if state:
            filters.append({"Name": "instance-state-name", "Values": [state]})
        out = []
        paginator = cli.get_paginator("describe_instances")
        for page in paginator.paginate(**({"Filters": filters} if filters else {})):
            for r in page.get("Reservations", []):
                for inst in r.get("Instances", []):
                    out.append(_brief_ec2(inst))
                    if len(out) >= _MAX_ITEMS:
                        break
        return {"region": region or _DEFAULT_REGION, "count": len(out), "instances": out}
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        return _err(e)


def ec2_describe_instance(instance_id: str, *, account_id: str | None = None,
                          region: str | None = None) -> dict:
    """取单个 EC2 实例明细 + 状态原因（实时只读）：类型/状态/AZ/网络/安全组/标签/
    状态转换原因（如被谁停了、为何）。只读：ec2:DescribeInstances。"""
    cli = _client("ec2", account_id, region)
    if cli is None:
        return _cross_account_error(account_id)
    try:
        resp = cli.describe_instances(InstanceIds=[instance_id])
        insts = [i for r in resp.get("Reservations", []) for i in r.get("Instances", [])]
        if not insts:
            return {"error": "not_found", "message": f"未找到 EC2 实例：{instance_id}"}
        return _full_ec2(insts[0])
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        return _err(e)


def ec2_security_groups(instance_id: str = "", *, account_id: str | None = None,
                        region: str | None = None) -> dict:
    """查安全组入站/出站规则（实时只读，排查连通性常用）。
    给 instance_id 则查该实例挂的安全组；否则列账号内全部安全组（截断）。
    只读：ec2:DescribeSecurityGroups（+ DescribeInstances 当给了实例）。"""
    cli = _client("ec2", account_id, region)
    if cli is None:
        return _cross_account_error(account_id)
    try:
        group_ids = []
        if instance_id:
            resp = cli.describe_instances(InstanceIds=[instance_id])
            insts = [i for r in resp.get("Reservations", []) for i in r.get("Instances", [])]
            if not insts:
                return {"error": "not_found", "message": f"未找到 EC2 实例：{instance_id}"}
            group_ids = [g.get("GroupId") for g in insts[0].get("SecurityGroups", [])]
        kwargs = {"GroupIds": group_ids} if group_ids else {"MaxResults": 50}
        sgs = cli.describe_security_groups(**kwargs).get("SecurityGroups", [])
        return {"count": len(sgs), "securityGroups": [_brief_sg(g) for g in sgs[:_MAX_ITEMS]]}
    except (ClientError, BotoCoreError, Exception) as e:  # noqa: BLE001
        return _err(e)


def _brief_ec2(inst: dict) -> dict:
    name = next((t["Value"] for t in inst.get("Tags", []) if t.get("Key") == "Name"), None)
    return {
        "instanceId": inst.get("InstanceId"),
        "name": name,
        "type": inst.get("InstanceType"),
        "state": (inst.get("State") or {}).get("Name"),
        "az": (inst.get("Placement") or {}).get("AvailabilityZone"),
        "privateIp": inst.get("PrivateIpAddress"),
        "publicIp": inst.get("PublicIpAddress"),
        "launchTime": inst.get("LaunchTime").isoformat() if inst.get("LaunchTime") else None,
    }


def _full_ec2(inst: dict) -> dict:
    name = next((t["Value"] for t in inst.get("Tags", []) if t.get("Key") == "Name"), None)
    st = inst.get("State") or {}
    return {
        "instanceId": inst.get("InstanceId"),
        "name": name,
        "type": inst.get("InstanceType"),
        "state": st.get("Name"),
        "stateReason": (inst.get("StateReason") or {}).get("Message"),       # 为何到此状态
        "stateTransitionReason": inst.get("StateTransitionReason"),          # 如"User initiated ..."
        "az": (inst.get("Placement") or {}).get("AvailabilityZone"),
        "vpcId": inst.get("VpcId"),
        "subnetId": inst.get("SubnetId"),
        "privateIp": inst.get("PrivateIpAddress"),
        "publicIp": inst.get("PublicIpAddress"),
        "imageId": inst.get("ImageId"),
        "keyName": inst.get("KeyName"),
        "iamInstanceProfile": (inst.get("IamInstanceProfile") or {}).get("Arn"),
        "monitoring": (inst.get("Monitoring") or {}).get("State"),
        "launchTime": inst.get("LaunchTime").isoformat() if inst.get("LaunchTime") else None,
        "securityGroups": [{"id": g.get("GroupId"), "name": g.get("GroupName")}
                           for g in inst.get("SecurityGroups", [])],
        "tags": {t.get("Key"): t.get("Value") for t in inst.get("Tags", [])},
    }


def _brief_sg(g: dict) -> dict:
    def _rules(perms):
        out = []
        for p in perms:
            proto = p.get("IpProtocol")
            proto = "all" if proto == "-1" else proto
            frm, to = p.get("FromPort"), p.get("ToPort")
            port = "all" if frm is None else (str(frm) if frm == to else f"{frm}-{to}")
            srcs = [r.get("CidrIp") for r in p.get("IpRanges", [])] + \
                   [r.get("CidrIpv6") for r in p.get("Ipv6Ranges", [])] + \
                   [g2.get("GroupId") for g2 in p.get("UserIdGroupPairs", [])]
            out.append({"proto": proto, "port": port, "from": [s for s in srcs if s]})
        return out
    return {
        "groupId": g.get("GroupId"),
        "groupName": g.get("GroupName"),
        "vpcId": g.get("VpcId"),
        "ingress": _rules(g.get("IpPermissions", [])),
        "egress": _rules(g.get("IpPermissionsEgress", [])),
    }
