"""
Lambda6 — CUR/Athena Finalizer（一次性）。

背景：AWS CUR + Athena 官方集成流程分两阶段，中间有 ~24h 硬性延迟（见
docs/DEPLOYMENT.md §CUR/Athena FinOps 数据源）：
  1. setup.sh 创建 CUR ReportDefinition（TimeUnit=HOURLY + RESOURCES + Athena/Parquet）
  2. AWS 首次交付报告到 S3 后，会在同一路径下自动放一个 crawler-cfn.yml 模板
     （Glue Database + Crawler + 2 Lambda + S3 事件通知）
  3. 需要下载该模板并部署为一个新 CloudFormation Stack，才能真正查询 Athena 表

本 Lambda 由 EventBridge Scheduler 的一次性 at() 触发（setup.sh 创建 CUR 的同时
调度，T+25h），职责：
  - 检查 crawler-cfn.yml 是否已交付到 S3（首次报告可能早到/晚到，允许重试退避）
  - 交付了 → 下载模板 → create_stack 部署 Athena 集成 Stack → 更新 DDB 状态为 READY
  - 还没交付 → 更新 DDB 状态为 DELAYED（不会自我重新调度；Scheduler 只触发一次，
    延迟场景由用户重跑 setup.sh 的检测逻辑收尾，见 setup.sh §CUR 检测）
  - 任何异常：状态置为 FAILED + 记录 error，不抛（EventBridge Scheduler 一次性调度,
    抛出也不会重试，静默失败比不可观测更差）

DDB 记录（ConfigTable，见 infra/lib/notiops-backend-stack.ts）：
  PK = "cur-athena-status#<account_id>"
  SK = "STATUS"
  status: PENDING | READY | DELAYED | FAILED
  bucket / report_name / region / created_at / athena_database / athena_stack_name
  updated_at / error（FAILED 时）
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

import boto3

from lambda6_cur_finalizer.athena_saved_queries import provision_saved_queries

logger = logging.getLogger()
logger.setLevel(logging.INFO)

CONFIG_TABLE = os.environ.get("CONFIG_TABLE", "notiops-config")
# FinOps 保存查询的结果输出桶（notiops-data-<acct>-<region>）。CDK 注入；缺失则跳过设置
# workgroup 输出位置（不影响 BFF —— BFF 自带 OutputLocation；仅影响 Athena 控制台手跑）。
DATA_BUCKET = os.environ.get("DATA_BUCKET", "")
_ddb = boto3.resource("dynamodb")
_s3 = boto3.client("s3")
_cfn = boto3.client("cloudformation")
_glue = boto3.client("glue")

# AWS 交付 CUR 报告后，会在 {prefix}/{report_name}/ 下额外放一个
# crawler-cfn.yml（文件名固定，参考官方文档 use-athena-cf.md）。
_CRAWLER_TEMPLATE_FILENAME = "crawler-cfn.yml"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _update_status(account_id: str, **fields) -> None:
    table = _ddb.Table(CONFIG_TABLE)
    item = {"PK": f"cur-athena-status#{account_id}", "SK": "STATUS", "updated_at": _now_iso(), **fields}
    table.put_item(Item=item)


def _get_status(account_id: str) -> dict | None:
    table = _ddb.Table(CONFIG_TABLE)
    resp = table.get_item(Key={"PK": f"cur-athena-status#{account_id}", "SK": "STATUS"})
    return resp.get("Item")


def _find_crawler_template_key(bucket: str, report_name: str, prefix: str) -> str | None:
    """在 report 交付目录下递归找 crawler-cfn.yml。CUR 报告实际落盘路径带日期分区
    （形如 {prefix}/{report_name}/{report_name}/YYYYMMDD-YYYYMMDD/），但模板文件本身
    通常直接放在 {prefix}/{report_name}/ 顶层，做一次浅层 + 一次全量兜底搜索。"""
    base_prefix = f"{prefix.strip('/')}/{report_name}/" if prefix.strip("/") else f"{report_name}/"

    # 浅层优先（常见情况：模板就在顶层）
    resp = _s3.list_objects_v2(Bucket=bucket, Prefix=base_prefix, Delimiter="/")
    for obj in resp.get("Contents", []):
        if obj["Key"].endswith(_CRAWLER_TEMPLATE_FILENAME):
            return obj["Key"]

    # 兜底：全量搜索该 report 目录树（分页，避免大账号超时——限制扫描页数）
    paginator = _s3.get_paginator("list_objects_v2")
    pages_scanned = 0
    for page in paginator.paginate(Bucket=bucket, Prefix=base_prefix):
        pages_scanned += 1
        for obj in page.get("Contents", []):
            if obj["Key"].endswith(_CRAWLER_TEMPLATE_FILENAME):
                return obj["Key"]
        if pages_scanned >= 20:  # 硬上限，避免海量小文件账号里无限翻页
            break
    return None


def _deploy_athena_stack(bucket: str, template_key: str, stack_name: str, region: str) -> str:
    """下载模板内容（走 S3 presigned template URL，避免把可能超过 CFN inline 51200 字节
    限制的模板内容读进 Lambda 内存后再 inline 传参）。返回 CFN Stack ARN。"""
    template_url = _s3.generate_presigned_url(
        "get_object", Params={"Bucket": bucket, "Key": template_key}, ExpiresIn=3600,
    )
    resp = _cfn.create_stack(
        StackName=stack_name,
        TemplateURL=template_url,
        Capabilities=["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM"],
        Tags=[{"Key": "auto-delete", "Value": "no"}, {"Key": "notiops:component", "Value": "cur-athena"}],
        OnFailure="DO_NOTHING",  # 失败不自动回滚删除，方便排查（人工介入删除重试）
    )
    return resp["StackId"]


def _wait_stack_create(stack_name: str, timeout_seconds: int = 240) -> tuple[bool, str]:
    """轮询直到 CREATE_COMPLETE / CREATE_FAILED / ROLLBACK_*，或超时。
    Lambda 超时需 > timeout_seconds（见 CDK 里 lambda6 的 timeout 设置）。"""
    deadline = time.time() + timeout_seconds
    last_status = "CREATE_IN_PROGRESS"
    while time.time() < deadline:
        try:
            desc = _cfn.describe_stacks(StackName=stack_name)["Stacks"][0]
            last_status = desc["StackStatus"]
        except Exception as e:  # noqa: BLE001
            return False, f"describe_stacks failed: {e}"
        if last_status == "CREATE_COMPLETE":
            return True, last_status
        if last_status.endswith("FAILED") or last_status.startswith("ROLLBACK"):
            return False, last_status
        time.sleep(10)
    return False, f"timeout, last_status={last_status}"


def _norm_report_s3_prefix(bucket: str, prefix: str, report_name: str) -> str:
    """该报告数据在 S3 的根前缀（小写，用于和 Glue 表 Location 动态匹配）。完全由报告
    定义自身的 bucket/prefix/name 推出，不硬编码任何客户环境。"""
    p = (prefix or "").strip("/")
    base = f"{p}/{report_name}" if p else report_name
    return f"s3://{bucket}/{base}/".lower()


def _discover_cur_table(bucket: str, report_name: str, prefix: str) -> dict | None:
    """动态发现该 CUR 报告对应的 Glue database + table：
      - 遍历所有 database 的 table，匹配 StorageDescriptor.Location 落在该报告 S3 路径下
      - 校验含 CUR 关键列（line_item_unblended_cost + line_item_product_code），排除
        cost_and_usage_data_status 等辅助表
      - 依 PartitionKeys 是否含 year/month 判定分区结构（结构 B vs A）
    不猜库/表名、不硬编码——适配任意客户的既有/新建 CUR。None 表示尚未发现。"""
    want = _norm_report_s3_prefix(bucket, prefix, report_name)
    bucket_lc = bucket.lower()
    db_pager = _glue.get_paginator("get_databases")
    for db_page in db_pager.paginate():
        for db in db_page.get("DatabaseList", []):
            db_name = db["Name"]
            try:
                tbl_pager = _glue.get_paginator("get_tables")
                for tbl_page in tbl_pager.paginate(DatabaseName=db_name):
                    for tbl in tbl_page.get("TableList", []):
                        sd = tbl.get("StorageDescriptor", {})
                        loc = (sd.get("Location") or "").lower()
                        if not loc.startswith(f"s3://{bucket_lc}/") or want not in loc:
                            continue
                        cols = {c.get("Name") for c in sd.get("Columns", [])}
                        if "line_item_unblended_cost" not in cols or "line_item_product_code" not in cols:
                            continue  # 非 CUR 明细表（排除 *_data_status 等辅助表）
                        pkeys = {p.get("Name") for p in tbl.get("PartitionKeys", [])}
                        return {
                            "database": db_name,
                            "table": tbl["Name"],
                            "partitioned": ("year" in pkeys and "month" in pkeys),
                        }
            except Exception as e:  # noqa: BLE001 — 单库不可读不致命，继续找
                logger.warning("get_tables(%s) failed: %s", db_name, e)
    return None


def _run_stack_crawler(stack_name: str) -> None:
    """从 CFN stack 资源里动态取 Glue Crawler 物理名并启动（不硬编码 crawler 名）。
    官方 Athena 模板通常建栈时已自动跑过一次，这里兜底再触发一次刷新分区。"""
    try:
        resources = _cfn.describe_stack_resources(StackName=stack_name).get("StackResources", [])
    except Exception as e:  # noqa: BLE001
        logger.warning("describe_stack_resources(%s) failed: %s", stack_name, e)
        return
    for r in resources:
        if r.get("ResourceType") == "AWS::Glue::Crawler" and r.get("PhysicalResourceId"):
            try:
                _glue.start_crawler(Name=r["PhysicalResourceId"])
                logger.info("started crawler %s", r["PhysicalResourceId"])
            except _glue.exceptions.CrawlerRunningException:
                logger.info("crawler %s already running", r["PhysicalResourceId"])
            except Exception as e:  # noqa: BLE001
                logger.warning("start_crawler failed: %s", e)
            return


def _reset_failed_stack(stack_name: str) -> None:
    """若栈处于失败/回滚态（CREATE_FAILED / ROLLBACK_* / DELETE_FAILED），先删掉再重建——
    否则 create_stack 撞 AlreadyExists 会永久卡死（违背 setup 一次跑通）。
    CREATE_COMPLETE / *_IN_PROGRESS 不动。栈不存在直接返回。"""
    try:
        status = _cfn.describe_stacks(StackName=stack_name)["Stacks"][0]["StackStatus"]
    except Exception:  # noqa: BLE001 — 栈不存在，正常路径
        return
    if status in ("CREATE_FAILED", "ROLLBACK_COMPLETE", "ROLLBACK_FAILED", "DELETE_FAILED"):
        logger.info("resetting stack %s (status=%s): delete before recreate", stack_name, status)
        try:
            _cfn.delete_stack(StackName=stack_name)
            _cfn.get_waiter("stack_delete_complete").wait(
                StackName=stack_name, WaiterConfig={"Delay": 10, "MaxAttempts": 30})
        except Exception as e:  # noqa: BLE001
            logger.warning("delete failed stack %s: %s", stack_name, e)


def _provision_finops_saved_queries(region: str, database: str, table: str) -> None:
    """CUR 翻成 READY 的同一时刻，幂等下发 6 条 FinOps 保存查询 + 设 primary workgroup 输出位置。
    这是 Cost Deep Dive（bff/web-chat/finops.mjs 的 DEEP_DIVE_NQ）的后端；缺了它 Deep Dive
    报 no_named_queries。非致命：失败只记日志，不影响 READY 状态本身。"""
    out_loc = ""
    if DATA_BUCKET:
        out_loc = f"s3://{DATA_BUCKET}/athena-results/"
    try:
        result = provision_saved_queries(region, database, table, out_loc)
        logger.info("finops saved queries provisioned: created=%d skipped=%d errors=%d",
                    len(result.get("created", [])), len(result.get("skipped", [])),
                    len(result.get("errors", [])))
    except Exception as e:  # noqa: BLE001 — 绝不因保存查询下发失败而拖垮 finalizer 主流程
        logger.warning("provision_finops_saved_queries failed (non-fatal): %s", e)


def handler(event, context):
    """event 由 EventBridge Scheduler 一次性调度传入（setup.sh 创建时固定好）：
    { "account_id": "...", "bucket": "...", "report_name": "...",
      "prefix": "...", "region": "..." }

    另有一个轻量【provision-only】模式（setup.sh 在 CUR 已 READY 时用它幂等补齐/更新保存查询，
    无需重跑 CFN/发现流程）：
    { "mode": "provision_saved_queries", "region": "...", "database": "...", "table": "..." }
    """
    region = event.get("region", os.environ.get("AWS_REGION", "us-east-1"))

    # ── provision-only：只幂等下发 FinOps 保存查询 + 设 workgroup 输出位置 ──
    # db/table 由调用方（setup.sh）从 cur-athena-status DDB 记录直接读出传入，不再走发现流程。
    if event.get("mode") == "provision_saved_queries":
        database = event.get("database", "")
        table = event.get("table", "")
        if not (database and table):
            logger.error("lambda6_cur_finalizer: provision_saved_queries missing database/table")
            return {"status": "FAILED", "error": "missing database/table"}
        out_loc = f"s3://{DATA_BUCKET}/athena-results/" if DATA_BUCKET else ""
        result = provision_saved_queries(region, database, table, out_loc)
        return {"status": "PROVISIONED", **result}

    account_id = event.get("account_id", "")
    bucket = event.get("bucket", "")
    report_name = event.get("report_name", "")
    prefix = event.get("prefix", "")

    if not (account_id and bucket and report_name):
        # 只记缺失的字段名，不 dump 整个 event（可能含桶名/前缀等路径信息）。
        _missing = [k for k, v in (("account_id", account_id), ("bucket", bucket), ("report_name", report_name)) if not v]
        logger.error("lambda6_cur_finalizer: missing required event fields: %s", ",".join(_missing))
        return {"status": "FAILED", "error": "missing account_id/bucket/report_name in event"}

    # 幂等 / 复用快速路：既有 CUR 若已建过 Athena 表（含用户自己做过 Athena 集成的场景），
    # 直接动态发现并落库，跳过 CFN 部署。不依赖任何命名约定。
    try:
        found = _discover_cur_table(bucket, report_name, prefix)
    except Exception as e:  # noqa: BLE001
        found = None
        logger.warning("lambda6_cur_finalizer: pre-discover failed: %s", e)
    if found:
        logger.info("lambda6_cur_finalizer: discovered existing table %s.%s (partitioned=%s)",
                    found["database"], found["table"], found["partitioned"])
        _update_status(account_id, status="READY", bucket=bucket, report_name=report_name,
                       region=region, athena_database=found["database"],
                       athena_table=found["table"], year_month_partitioned=found["partitioned"])
        _provision_finops_saved_queries(region, found["database"], found["table"])
        return {"status": "READY", **found}

    logger.info("lambda6_cur_finalizer: checking crawler template for %s/%s (account=%s)",
                bucket, report_name, account_id)

    try:
        template_key = _find_crawler_template_key(bucket, report_name, prefix)
    except Exception as e:  # noqa: BLE001
        logger.exception("lambda6_cur_finalizer: S3 list failed")
        _update_status(account_id, status="FAILED", error=f"S3 list failed: {e}",
                        bucket=bucket, report_name=report_name, region=region)
        return {"status": "FAILED", "error": str(e)}

    if not template_key:
        # AWS 交付延迟超出预期（官方口径 up to 24h，个别情况更久）。不在本 Lambda 里自我
        # 重新调度——EventBridge Scheduler 一次性 schedule 触发后自动失效，重新调度需要
        # 新建 schedule，交给用户重跑 setup.sh 的检测逻辑处理（§setup.sh CUR 检测）。
        logger.warning("lambda6_cur_finalizer: crawler-cfn.yml not found yet under %s/%s/",
                        bucket, report_name)
        _update_status(account_id, status="DELAYED", bucket=bucket, report_name=report_name,
                        region=region,
                        note="crawler-cfn.yml 尚未交付，重跑 setup.sh 可重新检测/调度")
        return {"status": "DELAYED"}

    stack_name = f"notiops-cur-athena-{account_id}"
    logger.info("lambda6_cur_finalizer: found template s3://%s/%s, deploying stack %s",
                bucket, template_key, stack_name)

    _reset_failed_stack(stack_name)  # 失败/回滚态的旧栈先清掉，保证可重复部署
    try:
        _deploy_athena_stack(bucket, template_key, stack_name, region)
    except _cfn.exceptions.AlreadyExistsException:
        logger.info("lambda6_cur_finalizer: stack %s already exists, treating as in-progress/complete", stack_name)
    except Exception as e:  # noqa: BLE001
        logger.exception("lambda6_cur_finalizer: create_stack failed")
        _update_status(account_id, status="FAILED", error=f"create_stack failed: {e}",
                        bucket=bucket, report_name=report_name, region=region)
        return {"status": "FAILED", "error": str(e)}

    ok, final_status = _wait_stack_create(stack_name)
    if not ok:
        logger.error("lambda6_cur_finalizer: stack %s did not reach CREATE_COMPLETE: %s",
                     stack_name, final_status)
        _update_status(account_id, status="FAILED", error=f"stack status={final_status}",
                        bucket=bucket, report_name=report_name, region=region,
                        athena_stack_name=stack_name)
        return {"status": "FAILED", "error": final_status}

    # 栈已就绪 → 触发 crawler（兜底刷新分区）→ 动态发现真实 db/table 写回。
    # 不再用 report_name.lower() 猜库名（实测 AWS 建的是 athenacurcfn_<脱敏名>，猜不准）。
    _run_stack_crawler(stack_name)
    found = None
    for _ in range(12):  # 最多 ~2 分钟等 crawler 产出表/分区
        try:
            found = _discover_cur_table(bucket, report_name, prefix)
        except Exception as e:  # noqa: BLE001
            found = None
            logger.warning("lambda6_cur_finalizer: discover failed: %s", e)
        if found:
            break
        time.sleep(10)

    if not found:
        logger.warning("lambda6_cur_finalizer: stack %s ready but no CUR table discovered yet", stack_name)
        _update_status(account_id, status="DELAYED", bucket=bucket, report_name=report_name,
                        region=region, athena_stack_name=stack_name,
                        note="Athena stack 已部署，crawler 尚未产出表，稍后重跑 setup.sh 收尾")
        return {"status": "DELAYED"}

    logger.info("lambda6_cur_finalizer: stack %s COMPLETE, discovered %s.%s (partitioned=%s)",
                stack_name, found["database"], found["table"], found["partitioned"])
    _update_status(account_id, status="READY", bucket=bucket, report_name=report_name,
                   region=region, athena_stack_name=stack_name, athena_database=found["database"],
                   athena_table=found["table"], year_month_partitioned=found["partitioned"])
    _provision_finops_saved_queries(region, found["database"], found["table"])
    return {"status": "READY", **found}
