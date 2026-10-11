"""CUR 阶段一的**执行**逻辑（幂等）：交付桶 → 桶策略 → ReportDefinition → DDB 状态。

规格在 `spec.py`（两条路径共用）；这里只是把规格落到 AWS 上。

幂等是硬要求，不是"顺便做到"
----------------------------
这段代码会被重复执行，至少三种情况：
  · 方式 A 的栈更新（custom resource 每次 Update 都会再跑一遍）；
  · 客户重跑 `setup.sh`；
  · CFN 回滚后重试。
所以每一步都是"有就复用、没有就建"，且**桶已存在时不覆盖它的策略**
（客户可能在同一个桶上挂了自己的策略语句 —— 我们没有权利把它冲掉）。

⚠️ 删除语义：什么都不删
-----------------------
`on_delete()` 是**空操作**，这是刻意的，不是没写完：
  · CUR 报告删了 = 客户的**历史账单明细**从此断档，而且 AWS **不会补发**过去的月份。
  · 交付桶删了 = 已经交付的几个月 Parquet 数据一起消失。
两者都不是"NotiOps 的资源"，是客户的账单数据，只是恰好由我们代为创建。
栈删掉只意味着"NotiOps 不再读它"，不意味着客户不要账单了。
用户要删自己动手删 —— 这符合仓库的生产安全约束（生产资源不在无明确指示下删除）。
"""
from __future__ import annotations

import json
import logging
import os

import boto3
from botocore.exceptions import ClientError

from . import spec

log = logging.getLogger(__name__)

#: 每一个 NotiOps 云资源都要带的标签（仓库强制约定）。这个桶是 boto3 直建、
#: 不经 CDK，所以标签必须在这里手工补上，否则它会是全账号里唯一一个漏标的资源。
TAGS = [{"Key": "auto-delete", "Value": "no"}, {"Key": "project", "Value": "notiops"}]


def _s3(region: str):
    return boto3.client("s3", region_name=region)


def ensure_bucket(bucket: str, region: str, account_id: str) -> str:
    """建 CUR 交付桶并挂上投递策略。返回 `created` 或 `reused`。"""
    s3 = _s3(region)
    try:
        s3.head_bucket(Bucket=bucket)
        # 已存在：**不动它的策略**。见模块 docstring 里的幂等说明。
        log.info("cur bucket already exists, reusing (policy left untouched)")
        return "reused"
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code not in ("404", "NoSuchBucket", "NotFound"):
            # 403 = 桶名被**别的账号**占了（S3 桶名全球唯一）。这种要如实报，
            # 不能当成"没有就建"继续 —— 建会失败，而且错误信息会很难懂。
            raise

    # us-east-1 是 S3 的特例：给它传 LocationConstraint 会被拒（InvalidLocationConstraint）。
    kwargs = {"Bucket": bucket}
    if region != "us-east-1":
        kwargs["CreateBucketConfiguration"] = {"LocationConstraint": region}
    s3.create_bucket(**kwargs)

    s3.put_bucket_policy(Bucket=bucket, Policy=json.dumps(spec.bucket_policy(bucket, account_id)))
    s3.put_bucket_tagging(Bucket=bucket, Tagging={"TagSet": TAGS})
    return "created"


def ensure_report(bucket: str, region: str, report_name: str, prefix: str) -> str:
    """建 CUR ReportDefinition。返回 `created` / `reused`。

    `cur` 的 API 端点固定在 us-east-1（见 `spec.CUR_API_REGION`），与栈部在哪个区无关。
    """
    cur = boto3.client("cur", region_name=spec.CUR_API_REGION)
    existing = cur.describe_report_definitions().get("ReportDefinitions", [])
    if any(r.get("ReportName") == report_name for r in existing):
        # 同名已存在：不 Put 覆盖。覆盖会改掉客户可能已经手工调过的字段，
        # 而且 OVERWRITE_REPORT 下改前缀会让历史数据"看起来消失"。
        log.info("cur report definition already exists, reusing")
        return "reused"
    cur.put_report_definition(ReportDefinition=spec.report_definition(bucket, region, report_name, prefix))
    return "created"


def write_pending_status(table_name: str, account_id: str, bucket: str,
                        report_name: str, prefix: str, region: str, now_iso: str) -> None:
    """写 `cur-athena-status#<账号>` = PENDING —— 阶段二靠这条记录接手。

    ⚠️ 已经是 READY 就不要写回 PENDING。栈更新会重跑阶段一，如果这里无条件写
    PENDING，就会把一个**已经能查的** CUR 打回"还在等首次交付"，于是成本主题
    的 CUR 工具全部退回 Cost Explorer —— 表面上没报错，客户只会觉得"答得变糙了"。
    """
    ddb = boto3.client("dynamodb", region_name=region)
    key = {"PK": {"S": f"cur-athena-status#{account_id}"}, "SK": {"S": "STATUS"}}
    try:
        cur_item = ddb.get_item(TableName=table_name, Key=key).get("Item") or {}
        if (cur_item.get("status", {}).get("S") or "") == "READY":
            log.info("cur-athena-status already READY, not resetting to PENDING")
            return
    except ClientError:
        log.warning("could not read existing cur-athena-status; writing PENDING")

    ddb.put_item(TableName=table_name, Item={
        **key,
        "status": {"S": "PENDING"},
        "bucket": {"S": bucket},
        "report_name": {"S": report_name},
        "prefix": {"S": prefix},
        "region": {"S": region},
        "created_at": {"S": now_iso},
    })


def provision(account_id: str, region: str, table_name: str, now_iso: str,
              report_name: str = spec.DEFAULT_REPORT_NAME,
              prefix: str = spec.DEFAULT_PREFIX) -> dict:
    """阶段一全过程。返回给 CFN 当 `Data` 用的摘要（不含任何敏感值）。"""
    bucket = spec.bucket_name(account_id, region)
    bucket_state = ensure_bucket(bucket, region, account_id)
    report_state = ensure_report(bucket, region, report_name, prefix)
    write_pending_status(table_name, account_id, bucket, report_name, prefix, region, now_iso)
    return {
        "Bucket": bucket,
        "ReportName": report_name,
        "Prefix": prefix,
        "BucketState": bucket_state,
        "ReportState": report_state,
    }


def on_delete() -> dict:
    """栈删除时**什么都不删** —— 见模块 docstring。"""
    log.info("stack delete: leaving the CUR report and delivery bucket in place by design")
    return {"Retained": "cur-report,delivery-bucket"}


def config_table_name() -> str:
    return os.environ.get("CONFIG_TABLE") or "notiops-config"
