"""DevOps Agent 调查结果回调 Lambda（多账户架构）。

EventBridge（Custom Event Bus `notiops-devops-events`）触发，处理
Investigation Completed/Failed/Timed Out 事件。

新架构职责（见 design.md "Callback Lambda 改造设计"）：

- 从事件顶层 `account` 字段识别来源业务账户，查 DynamoDB 配置表
  `notiops-config` 的账户项（`PK=da#<account_id>, SK=meta`，见
  `shared/devops_agent.py::_get_da_account`）得到账户配置
- Investigation Completed：调用平台无关报告管道（跨账户拉一次 long_report → 写 S3
  稳定 key → Bedrock 精简成 summary_card）→ UPSERT 到 `devops_agent_investigation`
  表（只存 summary_card + S3 指针，不内联 summary_raw）
- Investigation Failed / Timed Out：不拉报告、不写 S3，直接以失败描述入库 + 失败卡
- 报告交付：发起会话线程的实时进度卡 + 最终报告卡（progress poller 机制保留）；
  调查类事件**不再**推送 notify_chat_ids（_notify_im 已删除，notify_chat_ids
  机制保留供 PHD/Lambda4 日报使用）
- 测试事件（`detail.test=true` 或 `detail.metadata.test=true`）短路跳过

UPSERT 语义：调用方（Lambda4 / AgentCore）在 `create_investigation` 成功后
预注册一条 `status='pending'` 记录（含 task_id / account_id / title / source）。
本 handler UPDATE 时**不覆盖 `source`** 字段（仅更新 status / summary / model_id
等调查完成后才知道的字段），保留预注册时的触发来源信息。

异常处理：
- DynamoDB 访问失败、Bedrock 完全不可用等 **raise** 让 EventBridge 重试 → DLQ
- 测试事件、未知 account、未知 detail-type 等 return skipped（不 raise）

环境变量：
- CONFIG_TABLE（DynamoDB 配置表 `notiops-config`，由 shared/queries 读取）
- DATA_BUCKET（S3 报告桶，report_delivery 写 investigations/<task_id>/ 前缀）
- DEVOPS_AGENT_SUMMARIZER_MODEL_ID（可选，由 shared/summarizer_config.py 读取）
- BEDROCK_API_KEY_SECRET_ARN（可选，由 shared/bedrock_summarizer.py 读取）
- AWS_REGION（STS / Bedrock endpoint 区域）

Requirements: R6.1, R6.2, R6.3, R6.4, R6.5, R6.6, R6.7, R6.8, R6.9, R6.10
"""

import logging

logger = logging.getLogger("devops_agent_callback.handler")
logger.setLevel(logging.INFO)




def _upsert_investigation_record(
    task_id: str,
    execution_id: str,
    account_id: str,
    account_alias: str | None,
    title: str,
    status: str,
    summary_card: str | None,
    model_id: str | None,
    report_md_key: str | None = None,
    report_html_key: str | None = None,
    trace_html_key: str | None = None,
    report_available: bool = False,
    report_truncated: bool = False,
) -> None:
    """UPSERT investigation record via shared/queries (DDB).

    Terminal-state guard + source COALESCE handled inside upsert_investigation.
    调用方可能已经预注册了 status='pending' 的占位记录，本函数用
    upsert_investigation 完成结果回填。

    写 summary_card + S3 指针（report_md_key/html_key/trace_html_key +
    report_available/report_truncated），**不再内联 summary_raw**（H7 根因消除）。
    不动 source 字段（预注册时写入，Callback 无法得知）。
    """
    from shared.queries.reports import upsert_investigation

    fields: dict = {
        "status": status,
        "execution_id": execution_id,
        "account_alias": account_alias,
        "title": title,
        "summary_card": summary_card,
        "model_id": model_id,
        "report_available": report_available,
    }
    if report_md_key:
        fields["report_md_key"] = report_md_key
    if report_html_key:
        fields["report_html_key"] = report_html_key
    if trace_html_key:
        fields["trace_html_key"] = trace_html_key
    if report_truncated:
        fields["report_truncated"] = report_truncated

    upsert_investigation(task_id, account_id=account_id, **fields)


def handler(event: dict, context) -> dict:
    """DevOps Agent 调查结果回调 Lambda 入口（EventBridge 触发）。

    顶层不吞异常：DB 连接失败等可重试错误会抛出，让 EventBridge 重试 → DLQ。
    可识别的跳过场景（测试事件、未配置账户、未知事件类型）返回 skipped。

    Requirements: R6.1, R6.2, R6.3, R6.4, R6.5, R6.6, R6.8, R6.9
    """
    detail_type = event.get("detail-type", "")
    detail = event.get("detail") or {}
    source_account_id = event.get("account", "")
    metadata = detail.get("metadata") or {}
    data = detail.get("data") or {}

    task_id = metadata.get("task_id", "") or ""
    execution_id = metadata.get("execution_id", "") or ""
    status = data.get("status", "") or ""

    logger.info(
        "收到 DevOps Agent 事件: detail_type=%s source_account=%s "
        "task_id=%s execution_id=%s status=%s",
        detail_type, source_account_id, task_id, execution_id, status,
    )

    # 1. 测试事件短路（R6.1 / 流程 4 step 3）
    if detail.get("test") is True or metadata.get("test") is True:
        logger.info(
            "收到测试事件，跳过处理: source_account=%s task_id=%s",
            source_account_id, task_id,
        )
        return {
            "status": "skipped_test",
            "source_account_id": source_account_id,
        }

    # 2. 查账户配置（raw，含 disabled — 结果仍要入库）
    from shared.devops_agent import _query_account_mapping_raw

    mapping = _query_account_mapping_raw(source_account_id)
    if mapping is None:
        logger.warning(
            "未找到账户配置，跳过处理: source_account=%s",
            source_account_id,
        )
        return {
            "status": "skipped",
            "reason": "account_not_configured",
            "source_account_id": source_account_id,
        }

    account_alias = mapping.get("account_alias") or source_account_id

    # 3. 事件类型 → event_status
    if detail_type == "Investigation Completed":
        event_status = "completed"
    elif detail_type == "Investigation Failed":
        event_status = "failed"
    elif detail_type == "Investigation Timed Out":
        event_status = "timed_out"
    elif detail_type == "Investigation Created":
        event_status = "created"
    elif detail_type == "Investigation Cancelled":
        event_status = "cancelled"
    elif detail_type == "Investigation Linked":
        event_status = "linked"
    else:
        logger.warning("未知 detail-type: %s", detail_type)
        return {
            "status": "skipped",
            "reason": "unknown_detail_type",
            "detail_type": detail_type,
        }

    # 3b. task_id 非空校验（所有事件类型）：空 task_id 会退化
    #     investigations//report.md（S3）/ invst#（DDB PK，多事件互相覆盖）。
    #     按 Req 1.6 一律拒绝并跳过，不进 DLQ。
    if not task_id:
        logger.warning(
            "事件缺 task_id，跳过（不写退化 key）: detail_type=%s source_account=%s "
            "execution_id=%s", detail_type, source_account_id, execution_id,
        )
        return {
            "status": "skipped",
            "reason": "missing_task_id",
            "source_account_id": source_account_id,
        }

    title = (
        metadata.get("title")
        or data.get("title")
        or "DevOps Agent 调查"
    )

    # 4. Completed：单次拉取报告管道（拉一次 long_report → S3 稳定 key →
    #    Bedrock summary_card）。非 completed：仅状态描述，不拉报告。
    artifacts = None
    summary_card: str | None = None
    model_id: str | None = None
    report_md_key = report_html_key = trace_html_key = None
    report_available = False
    report_truncated = False

    if event_status == "completed":
        from shared.report_delivery.report_handler import build_investigation_report

        incident_id_hint = (metadata.get("incident_id", "")
                            or data.get("incident_id", "")
                            or data.get("incidentId", ""))
        artifacts = build_investigation_report(
            execution_id=execution_id,
            target_account_id=source_account_id,
            task_id=task_id,
            detail=detail,
            event_status="completed",
            incident_id=incident_id_hint,
        )
        summary_card = artifacts.summary_card
        model_id = artifacts.model_id
        report_md_key = artifacts.report_md_key
        report_html_key = artifacts.report_html_key
        trace_html_key = artifacts.trace_html_key
        report_available = artifacts.report_available
        report_truncated = artifacts.report_truncated
    elif event_status in ("created", "cancelled", "linked"):
        label = {"created": "已创建", "cancelled": "已取消", "linked": "已关联"}
        summary_card = f"调查{label.get(event_status, event_status)}（task_id: {task_id}）"
    else:
        # failed / timed_out：不拉报告，直接写失败描述
        summary_card = (
            f"调查 {event_status}（task_id: {task_id}，状态: {status})"
            if status
            else f"调查 {event_status}（task_id: {task_id}）"
        )

    # 5. 写入 devops_agent_investigation（UPSERT）：summary_card + S3 指针，
    #    不再内联 summary_raw（H7 根因消除）
    _upsert_investigation_record(
        task_id=task_id,
        execution_id=execution_id,
        account_id=source_account_id,
        account_alias=account_alias,
        title=title,
        status=event_status,
        summary_card=summary_card,
        model_id=model_id,
        report_md_key=report_md_key,
        report_html_key=report_html_key,
        trace_html_key=trace_html_key,
        report_available=report_available,
        report_truncated=report_truncated,
    )

    # 5b. 终态行 best-effort 补指针：若本行此前已是降级终态（report_available=false、
    #     无指针），upsert 的终态 guard 会拦掉指针写入；backfill 绕过 guard 只补
    #     指针 + report_available，不动 status（修复 B3 / Property 4）。
    if event_status == "completed" and report_available and report_md_key:
        try:
            from shared.queries.reports import backfill_report_pointers
            backfill_report_pointers(
                task_id,
                report_md_key=report_md_key,
                report_html_key=report_html_key,
                trace_html_key=trace_html_key,
                report_available=True,
            )
        except Exception as e:
            logger.warning("backfill_report_pointers 异常（不阻断主流程）: %s", e)

    logger.info(
        "DevOps Agent 调查结果已入库: task_id=%s account=%s(%s) "
        "status=%s summary_card_len=%d model=%s report_available=%s",
        task_id, source_account_id, account_alias, event_status,
        len(summary_card or ""), model_id or "-", report_available,
    )

    # 6. Progress poller 行管理（终态标记，poller 发最终卡后 TTL 自清）
    try:
        if event_status in ("completed", "failed", "timed_out"):
            _mark_progress_row_completed(
                incident_id=f"task-{task_id}" if task_id else "",
                final_status=event_status,
            )
    except Exception as e:
        logger.warning("progress 行管理异常（不阻断主流程）: %s", e)

    # 6b. 报告交付（消费 artifacts，不二次拉取）
    try:
        _deliver_report(
            event=event,
            event_status=event_status,
            task_id=task_id,
            execution_id=execution_id,
            agent_space_id=metadata.get("agent_space_id", ""),
            artifacts=artifacts,
        )
    except Exception as e:
        logger.warning("报告交付异常（不阻断主流程）: %s", e)

    return {
        "status": "completed",
        "source_account_id": source_account_id,
        "task_id": task_id,
        "event_status": event_status,
        "summary_card_length": len(summary_card or ""),
        "report_available": report_available,
    }


# ---------------------------------------------------------------------------
# Progress poller 行管理(移植自原 lambda/devops_agent_report_handler.py)
#
# progress# 行是 ECS progress_poller 线程的驱动数据:
#   Created → 写行(poller 扫到后开始 20s 间隔更新实时卡片)
#   Completed/Failed/TimedOut → 标记终止(poller 发最终卡、TTL 自清)
# ---------------------------------------------------------------------------

def _resolve_platform(task_id: str) -> str:
    """从 conversations 表的 task# 行读 platform 字段。"""
    try:
        from core import ddb_state
        row = ddb_state.get_by_task(task_id)
        return (row or {}).get("platform", "")
    except Exception:
        return ""


def _write_progress_row(*, incident_id: str, platform: str,
                        agent_space_id: str, execution_id: str,
                        task_id: str) -> None:
    """写 progress# 行,供 ECS poller 扫描并更新实时卡片。TTL 30 分钟自清。"""
    if not incident_id or not platform:
        return
    import time as _t
    import os
    from shared.queries._client import config_table  # conversations 表
    # 实际写 conversations 表(和 ddb_state 同表)
    import boto3
    table = boto3.resource("dynamodb").Table(os.environ.get("CONVERSATIONS_TABLE", ""))

    locale = ""
    try:
        from core import locale_resolver
        locale = locale_resolver.get_for_incident(incident_id) or ""
    except Exception:
        pass

    # 从 conversations 表读 incident 行拿 message_ref(bot 派发时写的)
    message_ref = {}
    intent_summary = ""
    try:
        from core import ddb_state
        row = ddb_state.get_by_task(task_id) or ddb_state.get_by_incident(incident_id) or {}
        intent_summary = row.get("intent_summary", "")
    except Exception:
        pass

    item = {
        "lookup_key": f"progress#{incident_id}",
        "platform": platform,
        "incident_id": incident_id,
        "agent_space_id": agent_space_id,
        "execution_id": execution_id,
        "message_ref": message_ref,
        "deep_link": "",
        "operator_home_url": "",
        "intent_summary": intent_summary[:200] if intent_summary else "",
        "started_at": int(_t.time()),
        "last_polled_at": 0,
        "tick_count": 0,
        "last_summary_md": "",
        "ttl": int(_t.time()) + 30 * 60,
    }
    if locale:
        item["locale"] = locale
    try:
        table.put_item(Item=item)
        logger.info("Wrote progress row: incident_id=%s platform=%s", incident_id, platform)
    except Exception as e:
        logger.warning("write progress row failed: %s", e)


def _mark_progress_row_completed(incident_id: str, final_status: str = "completed") -> None:
    """标记 progress# 行终止,poller 下次扫描时发最终卡片。"""
    if not incident_id:
        return
    import time as _t
    import os
    import boto3
    table = boto3.resource("dynamodb").Table(os.environ.get("CONVERSATIONS_TABLE", ""))
    try:
        table.update_item(
            Key={"lookup_key": f"progress#{incident_id}"},
            UpdateExpression="SET #s = :st, finalized_at = :ts, #ttl = :ttl",
            ExpressionAttributeNames={"#s": "status", "#ttl": "ttl"},
            ExpressionAttributeValues={
                ":st": final_status,
                ":ts": int(_t.time()),
                ":ttl": int(_t.time()) + 30 * 60,
            },
            ConditionExpression="attribute_exists(lookup_key)",
        )
        logger.info("Marked progress row status=%s: incident_id=%s", final_status, incident_id)
    except Exception as e:
        if "ConditionalCheckFailed" in str(e):
            pass  # 行已不在(TTL 清了或从未写)
        else:
            logger.warning("mark progress row failed: %s", e)


# ---------------------------------------------------------------------------
# 报告交付 — 调用 shared/report_delivery 完成 HTML 报告 + IM 卡片交付
# ---------------------------------------------------------------------------

def _deliver_report(
    *,
    event: dict,
    event_status: str,
    task_id: str,
    execution_id: str,
    agent_space_id: str,
    artifacts=None,
) -> None:
    """根据事件类型交付报告（消费已构建的 artifacts，不二次拉取）。

    - Created: 发初始实时卡(带 console 深链 + 写 progress# 行带 message_ref)
    - Completed: deliver_report_card(artifacts) —— 复用管道产出的 summary_card/
      report_url/long_report，不再二次 fetch
    - Failed/TimedOut: deliver_failure_card —— 不拉报告、不写 S3
    - Cancelled/Linked: 不投递富卡
    """
    import os
    os.environ.setdefault("CONVERSATIONS_TABLE",
                          os.environ.get("CONVERSATIONS_TABLE", ""))

    from shared.report_delivery.report_handler import (
        _handle_investigation_started,
        deliver_report_card,
        deliver_failure_card,
    )

    detail = event.get("detail") or {}
    metadata = detail.get("metadata") or {}
    data = detail.get("data") or {}
    incident_id = (metadata.get("incident_id", "")
                   or data.get("incident_id", "")
                   or data.get("incidentId", ""))

    if event_status == "created":
        _handle_investigation_started(
            agent_space_id=agent_space_id,
            execution_id=execution_id,
            task_id=task_id,
            incident_id=incident_id,
        )

    elif event_status == "completed":
        if artifacts is None:
            logger.warning("completed 交付缺 artifacts，跳过卡片投递: task_id=%s", task_id)
            return
        deliver_report_card(
            artifacts=artifacts,
            incident_id=(getattr(artifacts, "incident_id", "") or incident_id),
            task_id=task_id,
            agent_space_id=agent_space_id,
            execution_id=execution_id,
            detail=detail,
        )

    elif event_status in ("failed", "timed_out"):
        deliver_failure_card(
            incident_id=incident_id,
            task_id=task_id,
            detail=detail,
            event_status=event_status,
            agent_space_id=agent_space_id,
            execution_id=execution_id,
            target_account_id=event.get("account", ""),
        )
    # cancelled / linked: 仅状态入库，不投递富卡
