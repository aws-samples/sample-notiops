#!/usr/bin/env python3
"""一次性 / 幂等回填：给缺 GSI2PK 的 investigation 行补全局列表分区键。

背景
----
investigation 行原先只写 GSI1（按 account 分区），无过滤的全局调查列表查
GSI2 常量分区 ``invst#$ALL`` 恒空。修复后每行在 ``upsert_investigation`` 中
双写 GSI2PK/GSI2SK。但：

  * 修复部署**之前**用旧代码写入、且已进入终态(completed/failed/timed_out)
    的历史行，没有 GSI2 键；
  * ``upsert_investigation`` 的 GSI2 回填用 ``if_not_exists`` 写在带 terminal-state
    守卫的同一个 UpdateItem 里，已终态的行会被守卫整条拒绝 → GSI2 永远补不上。

因此这些历史行不会出现在全局调查列表，需要本脚本绕过守卫直接回填。

行为
----
扫描 config 表中 ``PK begins_with "invst#" AND SK = "meta" AND
attribute_not_exists(GSI2PK)`` 的行，对每行直接 UpdateItem：
``SET GSI2PK = "invst#$ALL", GSI2SK = <created_at>``（带
``attribute_not_exists(GSI2PK)`` 条件，幂等：重复运行不会覆盖已回填的行）。
created_at 缺失时回退到 SK/now，保证排序键存在。

用法
----
    CONFIG_TABLE=notiops-config AWS_REGION=us-east-1 \
        python scripts/backfill_investigation_gsi2.py [--dry-run]

或显式传参：
    python scripts/backfill_investigation_gsi2.py \
        --table notiops-config --region us-east-1 [--dry-run]
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.exceptions import ClientError

_ALL = "$ALL"
_GSI2PK_VALUE = f"invst#{_ALL}"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def backfill(table_name: str, region: str, *, dry_run: bool = False) -> dict:
    table = boto3.resource("dynamodb", region_name=region).Table(table_name)

    scanned = 0
    candidates = 0
    updated = 0
    skipped = 0

    scan_kwargs = {
        "FilterExpression": (
            Attr("PK").begins_with("invst#")
            & Attr("SK").eq("meta")
            & Attr("GSI2PK").not_exists()
        ),
        "ProjectionExpression": "PK, SK, created_at",
    }
    start_key = None
    while True:
        if start_key:
            scan_kwargs["ExclusiveStartKey"] = start_key
        resp = table.scan(**scan_kwargs)
        scanned += resp.get("ScannedCount", 0)
        for item in resp.get("Items", []):
            candidates += 1
            pk = item["PK"]
            sk = item["SK"]
            gsi2sk = item.get("created_at") or _now_iso()
            print(f"  {'[dry-run] would backfill' if dry_run else 'backfill'} "
                  f"{pk} (GSI2SK={gsi2sk})")
            if dry_run:
                continue
            try:
                table.update_item(
                    Key={"PK": pk, "SK": sk},
                    UpdateExpression="SET GSI2PK = :gpk, GSI2SK = :gsk",
                    ConditionExpression="attribute_exists(PK) AND attribute_not_exists(GSI2PK)",
                    ExpressionAttributeValues={":gpk": _GSI2PK_VALUE, ":gsk": gsi2sk},
                )
                updated += 1
            except ClientError as e:
                if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
                    skipped += 1  # 已被并发回填或刚补上，幂等跳过
                else:
                    raise
        start_key = resp.get("LastEvaluatedKey")
        if not start_key:
            break

    return {"scanned": scanned, "candidates": candidates,
            "updated": updated, "skipped": skipped}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", default=os.environ.get("CONFIG_TABLE"),
                        help="config 表名（默认取环境变量 CONFIG_TABLE）")
    parser.add_argument("--region",
                        default=os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION"),
                        help="AWS region（默认取 AWS_REGION / AWS_DEFAULT_REGION）")
    parser.add_argument("--dry-run", action="store_true",
                        help="只打印将要回填的行，不写入")
    args = parser.parse_args()

    if not args.table:
        print("ERROR: 需要 --table 或环境变量 CONFIG_TABLE", file=sys.stderr)
        return 2
    if not args.region:
        print("ERROR: 需要 --region 或环境变量 AWS_REGION", file=sys.stderr)
        return 2

    print(f"扫描表 {args.table} ({args.region})，回填缺 GSI2PK 的 investigation 行"
          f"{' [DRY-RUN]' if args.dry_run else ''} ...")
    stats = backfill(args.table, args.region, dry_run=args.dry_run)
    print(f"完成：scanned={stats['scanned']} candidates={stats['candidates']} "
          f"updated={stats['updated']} skipped(已回填)={stats['skipped']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
