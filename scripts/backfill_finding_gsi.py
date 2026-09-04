#!/usr/bin/env python3
"""给存量 finding 行补上 GSI1PK / GSI1SK（跨账号统一视图的索引键）。

## 为什么需要它

2026-08-27 起巡检看板是**统一视图**：跨全部可见账号一起按严重度列。
数据层靠 `notiops-inspection` 表上的 GSI1：

```
GSI1PK = "inspfind"                        所有 finding 一个分区
GSI1SK = "<严重度序>#<账号>#<finding_id>"    严重度在最前
```

而 **DynamoDB 的 GSI 只收带索引键的行**。加 GSI 那一刻起，新写入的 finding
（`_finding_to_item` 已经带上了）会进索引，而**存量行不会** —— 它们在主表里
好好的，只是统一视图查不到。

🔴 这个缺失是**静默**的：查询成功、返回 200、只是少了行。客户看到的是
「升级之后昨天那些风险不见了」，而 CloudWatch 里什么都没有。

## 幂等

已经有 GSI1PK 的行会被跳过（`attribute_not_exists` 条件写）。所以可以重复跑，
也可以跑一半中断再跑。

## 用法

```bash
# 先看要改多少（不写）
AWS_REGION=<部署region> python3 scripts/backfill_finding_gsi.py

# 真写
AWS_REGION=<部署region> python3 scripts/backfill_finding_gsi.py --apply
```

`setup.sh` 部署后会自动跑一次 `--apply`（幂等、失败不阻断），所以正常升级
不用手动执行。手动跑的场景是：跳过了那一步、或者要先看看会改多少。

⚠️ **必须显式给 region。** 这台机器的 shell 里 `AWS_REGION=us-east-1` 而栈在
东京 —— 不指定会撞一片 `ResourceNotFoundException`，而那个错误信息完全不提示
region。所以脚本先 DescribeTable 探一次，表不在就把这句话打出来再退出，
**不是**默默扫 0 行然后报告「没有需要补的」（那等于假装成功）。
"""

from __future__ import annotations

import os
import sys

TABLE = os.environ.get("INSPECTION_TABLE", "notiops-inspection")
REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or ""


def main(argv: list[str]) -> int:
    import boto3
    from botocore.exceptions import ClientError

    from inspection.adapters import keys

    apply = "--apply" in argv
    if not REGION:
        print("✗ 没有 region。AWS_REGION=<部署region> python3 "
              "scripts/backfill_finding_gsi.py")
        return 2

    ddb = boto3.client("dynamodb", region_name=REGION)
    # 🔴 先确认表在这个 region。不做这一步的话，region 给错时 Scan 会抛
    #    ResourceNotFoundException —— 而那条异常的文案里**没有 region**，
    #    看起来像「表被删了」。写死一个 region 也不行：部署 region 是可配的。
    try:
        ddb.describe_table(TableName=TABLE)
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ResourceNotFoundException":
            # ⚠️ 这个 API 分不出「region 给错了」和「表还没建」——
            #    两种都说，不猜。
            print(f"✗ region {REGION} 里没有表 {TABLE}。两种可能：")
            print(f"  ① region 给错了 → 换成部署 region，例如 "
                  f"AWS_REGION=ap-northeast-1 python3 {sys.argv[0]} --apply")
            print("  ② NotiOpsBackendStack 还没部署成功 → 部署完再跑")
            return 2
        raise

    print(f"表 {TABLE} / {REGION} / {'真写' if apply else 'dry-run'}\n")

    scanned = need = done = skipped = 0
    start = None
    while True:
        kw: dict = {
            "TableName": TABLE,
            # ⚠️ 只扫 finding 行。`begins_with(PK, "inspfind#")` —— 那个前缀与
            #    `inspdispatch#` 刻意不嵌套（见 keys.assert_prefixes_disjoint），
            #    所以这个过滤不会误收派发记录。
            "FilterExpression": "begins_with(PK, :p)",
            "ExpressionAttributeValues": {":p": {"S": keys.Prefix.FINDING.value}},
            "ProjectionExpression": "PK,SK,account_id,severity,GSI1PK",
        }
        if start:
            kw["ExclusiveStartKey"] = start
        r = ddb.scan(**kw)
        for it in r.get("Items", []):
            scanned += 1
            if "GSI1PK" in it:
                skipped += 1
                continue
            need += 1
            acct = it.get("account_id", {}).get("S", "")
            sev = it.get("severity", {}).get("S", "")
            fid = it["SK"]["S"]
            if not acct:
                # ⚠️ account_id 缺失 → 从 finding_id 第一段取（六段定长，R6.1）。
                #    直接跳过会让那些行永久不进索引，而它们在主表里是好的。
                acct = fid.split(keys.SEP)[0]
            gsk = keys.finding_gsi1sk(sev, acct, fid)
            if not apply:
                if need <= 5:
                    print(f"  会补 {fid[:70]}  →  GSI1SK={gsk[:60]}")
                continue
            try:
                ddb.update_item(
                    TableName=TABLE,
                    Key={"PK": it["PK"], "SK": it["SK"]},
                    UpdateExpression="SET GSI1PK = :gpk, GSI1SK = :gsk",
                    ExpressionAttributeValues={
                        ":gpk": {"S": keys.FINDING_GSI1PK},
                        ":gsk": {"S": gsk},
                    },
                    # 幂等：已经有的不动（并发跑 / 中断重跑都安全）
                    ConditionExpression="attribute_not_exists(GSI1PK)",
                )
                done += 1
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code")
                if code == "ConditionalCheckFailedException":
                    skipped += 1          # 别的进程刚补过
                else:
                    print(f"  ✗ {fid}: {code}")
        start = r.get("LastEvaluatedKey")
        if not start:
            break

    print(f"\n扫过 {scanned} 行 · 已有索引键 {skipped} · 需要补 {need}"
          + (f" · 已补 {done}" if apply else ""))
    if need and not apply:
        print("\n（dry-run。加 --apply 才真写）")
    if not need:
        print("✓ 没有需要补的 —— 统一视图能看到全部 finding")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    raise SystemExit(main(sys.argv))
