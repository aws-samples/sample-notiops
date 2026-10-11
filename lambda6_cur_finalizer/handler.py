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


#: 只描述「这一次尝试」的字段。换状态时如果调用方没再给，就必须**清掉** —— 否则 READY 记录
#: 会带着上一次 DELAYED 的 `note`（「crawler-cfn.yml 尚未交付」）或 FAILED 的 `error`，
#: 读到的人会以为还没好。其余字段（bucket / report_name / **prefix** / created_at …）一律保留。
_TRANSIENT_FIELDS = ("note", "error")


def _update_status(account_id: str, **fields) -> None:
    """**合并**写状态记录，不覆盖。

    🔴 原来这里是 `put_item` —— **整条覆盖**。阶段一（cur_provisioner）写 PENDING 时带了
    `prefix`，而这里写 DELAYED / FAILED 时没传它 ⇒ 第一次 DELAYED 就把 `prefix` 从记录里
    **抹掉了**。之后每 4 小时一次的自愈规则只传 `account_id`、前缀靠从记录里读 ⇒ 读到空串 ⇒
    去 `<报告名>/` 下找 `crawler-cfn.yml`,而它实际在 `<前缀>/<报告名>/` 下 ⇒ **永远找不到**,
    每 4 小时报一次 DELAYED。2026-10-10 在验证账号上实测：AWS 10-09 就把模板投递到了，
    状态到 10-10 仍是 DELAYED。讽刺的是，这恰好是自愈规则本来要修的那种「静默卡住」。

    改成 `update_item`:只 SET 本次给出的字段，只 REMOVE 过期的瞬时字段。
    """
    table = _ddb.Table(CONFIG_TABLE)
    fields = {"updated_at": _now_iso(), **fields}
    names, values, sets = {}, {}, []
    # `status` / `region` 都是 DynamoDB 保留字 —— 一律走占位符,不区分。
    for i, (k, v) in enumerate(fields.items()):
        names[f"#k{i}"] = k
        values[f":v{i}"] = v
        sets.append(f"#k{i} = :v{i}")
    removes = []
    for j, k in enumerate(f for f in _TRANSIENT_FIELDS if f not in fields):
        names[f"#r{j}"] = k
        removes.append(f"#r{j}")
    expr = "SET " + ", ".join(sets)
    if removes:
        expr += " REMOVE " + ", ".join(removes)
    table.update_item(
        Key={"PK": f"cur-athena-status#{account_id}", "SK": "STATUS"},
        UpdateExpression=expr,
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )


def _resolve_prefix(report_name: str, event_prefix, record_prefix) -> str | None:
    """CUR 交付前缀:event → 状态记录 → **向 CUR 服务查**(权威来源)。

    为什么需要第三档:在 `_update_status` 修好之前写下的记录,`prefix` 已经被覆盖写抹掉了;
    方式 B 的 `setup.sh` 写 PENDING 时也**从来没带过** `prefix`。这些记录光靠合并写救不回来,
    而它们恰恰是自愈规则要救的那一批(T+25h 那次没成功的部署)。
    所以记录里也没有时,去问 `cur:DescribeReportDefinitions` —— 那是报告定义本身,不是猜。

    ⚠️ 用 `None` 表示「没有」,`""` 是**合法值**(CUR 允许报告直接放在桶根下)。
    返回 None = 三处都拿不到,调用方应如实报错而不是拿空串去找。
    """
    if event_prefix is not None:
        return event_prefix
    if record_prefix is not None:
        return record_prefix
    try:
        cur = boto3.client("cur", region_name="us-east-1")  # CUR 的 API 端点只有 us-east-1
        # 必须翻页：这个 API 一页最多 5 个报告定义，账号里多于 5 个时我们那个可能在后面几页 ——
        # 只看第一页就会误报「找不到前缀」。
        kwargs: dict = {}
        while True:
            page = cur.describe_report_definitions(**kwargs)
            for rd in page.get("ReportDefinitions", []):
                if rd.get("ReportName") == report_name:
                    return rd.get("S3Prefix", "")
            if not page.get("NextToken"):
                break
            kwargs = {"NextToken": page["NextToken"]}
    except Exception as exc:  # noqa: BLE001
        # 只记异常类型名 —— 详情里会带账号号。
        logger.warning("lambda6_cur_finalizer: describe_report_definitions failed: %s",
                       type(exc).__name__)
    return None


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
    # ⚠️ 不给默认值:`None` = 调用方没给,`""` = 调用方明确说「报告在桶根下」。见 _resolve_prefix。
    event_prefix = event.get("prefix")
    # 显式调用(setup.sh 同步调用 / T+25h 一次性 schedule)会带全桶名与报告名;
    # 常驻自愈规则**只**带 account_id。两者的语义不同,见下面守卫 ①。
    explicit = bool(bucket and report_name)

    if not account_id:
        logger.error("lambda6_cur_finalizer: missing required event field: account_id")
        return {"status": "FAILED", "error": "missing account_id in event"}

    # ── 三道守卫：让这个 handler 可以被**周期性**触发 ────────────────────────────
    #
    # 背景：阶段二原来只在 T+25h 被一次性 EventBridge Scheduler 触发一次。那样**不自愈** ——
    # 那一次如果撞上 AWS 交付晚了、或者 crawler 还没爬完，状态就停在 `DELAYED`，而**再也
    # 没有下一次**。客户看到的是"装了 CUR 但成本还是走 Cost Explorer"，没有任何报错，
    # 只能靠有人想起来重跑 setup.sh —— 而「靠有人记得」不是控制手段。
    # 现在改成 4 小时一次的常驻规则（见 notiops-webchat-standalone-stack.ts 与
    # notiops-backend-stack.ts），代价是本函数必须能被反复空跑。
    #
    # `_get_status` 走的是 DynamoDB **resource** API，取回来就是反序列化好的普通 dict
    # （不是 `{"S": ...}` 那种低层形状）。读失败时**不要**当成"没有记录" ——
    # 那会让第一道守卫误判成"客户没选这个功能"而永久静默。读不到就照原路往下走。
    try:
        status_item = _get_status(account_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("lambda6_cur_finalizer: status read failed (%s); continuing",
                       type(exc).__name__)
        status_item = {"status": "UNKNOWN"}
    status_item = status_item or {}
    current = status_item.get("status", "")

    # ① 没有状态记录 **且** 是常驻规则那种只带 account_id 的空跑 = 客户没让 NotiOps 建 CUR。
    #    什么都不做 —— 否则常驻规则会拿着一个不存在的桶去 list,再写一条 `FAILED` 记录,
    #    等于给没选这个功能的客户凭空造一个故障态。
    #
    #    🔴 「且」字是 2026-10-10 补的。原来只判断「没有记录」,于是方式 B 的「复用客户已有
    #    CUR」那条路被拦死了:setup.sh 在那条路上**直接**同步调用本函数、调用前**不写**任何
    #    状态记录,于是这里返回 NOT_PROVISIONED、永远写不出 READY。显式调用带全了桶名与
    #    报告名,是权威的,必须照做。
    if not status_item and not explicit:
        logger.info("lambda6_cur_finalizer: no cur-athena-status record; CUR was not provisioned "
                    "by NotiOps -- nothing to finalize")
        return {"status": "NOT_PROVISIONED"}

    # ② 已经 READY = 阶段二早就完成了。**立刻返回**，不要重新发现、更不要重新下发保存查询。
    #    常驻规则每 4h 敲一次门，READY 之后这就是一次 DDB GetItem 然后结束（成本可忽略）。
    #    少了这道守卫，它会每 4 小时重跑一遍 crawler 发现 + Athena 写保存查询 —— 那是真实
    #    的写操作，永远重复执行没有意义，还会把 CloudTrail 刷满。
    #    🔴 这道守卫必须在 ③ 解析前缀**之前**（2026-10-10 发版前审查补）：v1.0.29 及更早写下的
    #    READY 记录都没有 `prefix`，原来先解析前缀 —— CUR API 失败一次（或报告定义多于一页、
    #    我们那个不在第一页），就会把一个好好的 READY 改写成 FAILED，而 BFF 的 CUR 看板只认 READY。
    if current == "READY":
        logger.info("lambda6_cur_finalizer: already READY, nothing to do")
        return {"status": "READY", "unchanged": True}

    # ③ 桶名/报告名以**状态记录为准**，event 里的只是可选提示。
    #    这很关键：常驻规则是在部署期静态声明的，它**猜不到**桶名 —— 方式 B 可能复用客户
    #    自己那份 CUR（桶名任意）。而阶段一写的那条记录里就有权威值。
    #    反过来 setup.sh 同步调用时会把这些字段显式传进来（复用既有 CUR 的场景，那时还
    #    没有记录），所以 event 优先、记录兜底。
    bucket = bucket or status_item.get("bucket", "")
    report_name = report_name or status_item.get("report_name", "")
    region = event.get("region") or status_item.get("region") or region
    if not (bucket and report_name):
        _missing = [k for k, v in (("bucket", bucket), ("report_name", report_name)) if not v]
        logger.error("lambda6_cur_finalizer: missing %s in both the event and the status record",
                     ",".join(_missing))
        return {"status": "FAILED", "error": "missing bucket/report_name"}
    prefix = _resolve_prefix(report_name, event_prefix, status_item.get("prefix"))
    if prefix is None:
        # 三处都拿不到:**不许**拿空串去找(那正是原来那个永远 DELAYED 的缺陷的样子)。
        logger.error("lambda6_cur_finalizer: CUR prefix unknown (not in event, record, or CUR API)")
        _update_status(account_id, status="FAILED", bucket=bucket, report_name=report_name,
                       region=region, error="CUR prefix unknown")
        return {"status": "FAILED", "error": "CUR prefix unknown"}


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
        _update_status(account_id, prefix=prefix, status="READY", bucket=bucket, report_name=report_name,
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
        _update_status(account_id, prefix=prefix, status="FAILED", error=f"S3 list failed: {e}",
                        bucket=bucket, report_name=report_name, region=region)
        return {"status": "FAILED", "error": str(e)}

    if not template_key:
        # AWS 交付延迟超出预期（官方口径 up to 24h，个别情况更久）。不在本 Lambda 里自我
        # 重新调度——EventBridge Scheduler 一次性 schedule 触发后自动失效，重新调度需要
        # 新建 schedule，交给用户重跑 setup.sh 的检测逻辑处理（§setup.sh CUR 检测）。
        logger.warning("lambda6_cur_finalizer: crawler-cfn.yml not found yet under %s/%s/",
                        bucket, report_name)
        _update_status(account_id, prefix=prefix, status="DELAYED", bucket=bucket, report_name=report_name,
                        region=region,
                        note="crawler-cfn.yml not delivered yet; NotiOps re-checks every 4 hours automatically")
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
        _update_status(account_id, prefix=prefix, status="FAILED", error=f"create_stack failed: {e}",
                        bucket=bucket, report_name=report_name, region=region)
        return {"status": "FAILED", "error": str(e)}

    ok, final_status = _wait_stack_create(stack_name)
    if not ok:
        logger.error("lambda6_cur_finalizer: stack %s did not reach CREATE_COMPLETE: %s",
                     stack_name, final_status)
        _update_status(account_id, prefix=prefix, status="FAILED", error=f"stack status={final_status}",
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
        _update_status(account_id, prefix=prefix, status="DELAYED", bucket=bucket, report_name=report_name,
                        region=region, athena_stack_name=stack_name,
                        note="Athena stack deployed, crawler has not produced the table yet; NotiOps re-checks every 4 hours automatically")
        return {"status": "DELAYED"}

    logger.info("lambda6_cur_finalizer: stack %s COMPLETE, discovered %s.%s (partitioned=%s)",
                stack_name, found["database"], found["table"], found["partitioned"])
    _update_status(account_id, prefix=prefix, status="READY", bucket=bucket, report_name=report_name,
                   region=region, athena_stack_name=stack_name, athena_database=found["database"],
                   athena_table=found["table"], year_month_partitioned=found["partitioned"])
    _provision_finops_saved_queries(region, found["database"], found["table"])
    return {"status": "READY", **found}
