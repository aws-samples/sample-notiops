"""
RDS AI 智能巡检报告与配置 API 路由。
GET  /api/rds-health-check          - 报告列表（筛选、分页、汇总统计）
GET  /api/rds-health-check/latest   - 最新 summary 报告
GET  /api/rds-health-check/{id}     - 报告详情
POST /api/rds-health-check/trigger  - 手动触发 Lambda3 生成报告
GET  /api/rds-health-check/config   - 获取巡检配置
PUT  /api/rds-health-check/config   - 更新巡检配置
GET  /api/rds-health-check/models   - 可用 Bedrock 模型列表
"""

import json
import logging
import os
from datetime import date

import boto3

from shared.queries.reports import (
    begin_health_report,
    get_health_report,
    get_latest_health_summary,
    list_health_reports,
    reset_health_report_for_regenerate,
    upsert_health_report,
)
from shared.queries.metrics import get_latest_monitoring_date
from shared.queries._client import config_table
from api.errors import NotFoundError

logger = logging.getLogger(__name__)


def mask_api_key(key: str) -> str:
    """掩码 API Key：长度 >= 4 时返回 '****' + 末尾4位，否则全部替换为 '*'。"""
    if len(key) >= 4:
        return "****" + key[-4:]
    return "*" * len(key)


def handle_rds_health_check(
    method: str, path: str, query_params: dict,
    path_params: dict, body: dict | None,
) -> dict:
    """路由分发。"""
    if method == "GET" and path.endswith("/latest"):
        return _get_latest()
    if method == "GET" and path.endswith("/config"):
        return _get_config()
    if method == "PUT" and path.endswith("/config"):
        return _update_config(body)
    if method == "GET" and path.endswith("/models"):
        return _get_models()
    if method == "POST" and path.endswith("/trigger"):
        return _trigger()
    if method == "DELETE" and path.endswith("/batch"):
        return _delete_batch(body)

    # Detail: /api/rds-health-check/{date}/{type}
    # TODO: 暂保留整型 ID 路径兼容,内部用业务键
    parts = path.rstrip("/").split("/")
    if method == "GET" and len(parts) >= 4 and parts[-1] not in ("latest", "config", "models"):
        return _get_detail(parts[-1], query_params)

    # List
    if method == "GET":
        return _get_list(query_params)

    raise ValueError(f"Method {method} not allowed for {path}")


def _get_list(query_params: dict) -> dict:
    """报告列表，支持筛选、cursor 分页和汇总统计。

    支持 `show_all=true`：翻页拉取该日期的完整集（drain cursor），用于前端
    "显示全部" 视图（前端发 page_size + show_all，旧实现只读 limit 默认 20 →
    静默截断、历史不可达）。`page_size` 作为 `limit` 的别名。
    """
    report_date = query_params.get("report_date")
    cursor = query_params.get("cursor")
    show_all = str(query_params.get("show_all", "")).strip().lower() in ("true", "1", "yes")
    limit = min(200, max(1, int(query_params.get("limit") or query_params.get("page_size") or "20")))

    # If no date specified, always use latest from pointer (show_all uses same)
    if not report_date:
        latest = get_latest_health_summary("rds")
        report_date = latest.get("latest_date") if latest else None
        if not report_date:
            return {"items": [], "next_cursor": None, "summary": {}}

    if show_all:
        items = []
        cur = None
        while True:
            page, cur = list_health_reports(
                "rds", report_date, status=None, cursor=cur, limit=200,
            )
            items.extend(page)
            if not cur:
                break
        next_cursor = None
    else:
        items, next_cursor = list_health_reports(
            "rds", report_date, status=None, cursor=cursor, limit=limit,
        )

    # 字段映射：DDB 存 date/type/account，前端期望 report_date/report_type/account_id
    for item in items:
        item.setdefault("report_date", item.get("date", ""))
        item.setdefault("report_type", item.get("type", ""))
        account_val = item.get("account", "")
        item.setdefault("account_id", "" if account_val == "$GLOBAL" else account_val)

    # 汇总统计：从 latest pointer
    latest_summary = get_latest_health_summary("rds")
    summary = {}
    if latest_summary:
        summary = {
            "total_instances": int(latest_summary.get("total_instances", 0)),
            "critical_count": int(latest_summary.get("critical_count", 0)),
            "warning_count": int(latest_summary.get("warning_count", 0)),
            "attention_count": int(latest_summary.get("attention_count", 0)),
        }

    return {
        "items": items,
        "summary": summary,
        "next_cursor": next_cursor,
    }


def _get_latest() -> dict:
    """返回最新 report_date 的 summary 类型报告。"""
    latest = get_latest_health_summary("rds")
    if not latest:
        raise NotFoundError("No summary report found")

    date_val = latest.get("latest_date")
    if not date_val:
        raise NotFoundError("No summary report found")

    record = get_health_report("rds", date_val, "summary")
    if not record:
        raise NotFoundError("No summary report found")
    record.setdefault("report_date", record.get("date", ""))
    record.setdefault("report_type", record.get("type", ""))
    account_val = record.get("account", "")
    record.setdefault("account_id", "" if account_val == "$GLOBAL" else account_val)
    return record


def _get_detail(report_id: str, query_params: dict) -> dict:
    """返回单条报告详情。

    report_id can be a date or task_id depending on how it's accessed.
    Try by date+type first, then fallback.
    """
    report_date = query_params.get("report_date")
    report_type = query_params.get("report_type", "summary")
    account_id = query_params.get("account_id")

    # If report_id looks like a date (YYYY-MM-DD), use it
    if len(report_id) == 10 and report_id[4] == "-":
        record = get_health_report("rds", report_id, report_type, account=account_id)
    else:
        # Try searching by id in the latest date's reports
        latest = get_latest_health_summary("rds")
        if latest and latest.get("latest_date"):
            items, _ = list_health_reports("rds", latest["latest_date"], limit=100)
            record = next((it for it in items if it.get("id") == report_id), None)
        else:
            record = None

    if not record:
        raise NotFoundError(f"Health check report {report_id} not found")

    # 字段映射（和 _get_list 一致）
    record.setdefault("report_date", record.get("date", ""))
    record.setdefault("report_type", record.get("type", ""))
    account_val = record.get("account", "")
    record.setdefault("account_id", "" if account_val == "$GLOBAL" else account_val)

    return record


_GENERATING_TIMEOUT_SECONDS = 600  # 10 分钟超时


def _trigger() -> dict:
    """手动触发 Lambda3 生成报告。

    占位行必须落在 Lambda3 实际会用的监控日期上。否则：占位行建在 today，
    而 Lambda3 在 today 无数据时会 fallback 到最近可用日期并把报告写到那个日期，
    导致 today 占位行永久卡 generating。因此这里先解析 target_date = 最新可用
    监控日期（无数据则用 today），用它建/重置占位行，并显式传给 Lambda3，
    避免日期错位。
    """
    function_name = os.environ.get("HEALTH_CHECKER_FUNCTION_NAME", "")

    # Lambda3 会用最新可用监控日期；占位行必须建在同一日期上以保证状态回写命中。
    target_date = get_latest_monitoring_date("rds") or date.today().isoformat()

    # 先检查是否已有 generating 状态（幂等防护 + 超时兜底）
    existing = get_health_report("rds", target_date, "summary")
    if existing and existing.get("status") == "generating":
        created_at = existing.get("created_at", "")
        is_stale = False
        if created_at:
            from datetime import datetime, timezone
            try:
                created_ts = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
                elapsed = (datetime.now(timezone.utc) - created_ts).total_seconds()
                is_stale = elapsed > _GENERATING_TIMEOUT_SECONDS
            except (ValueError, TypeError):
                is_stale = True

        if not is_stale:
            return {
                "report_id": existing.get("id", ""),
                "message": "已有报告正在生成中，请等待完成",
                "status": "generating",
                "_status_code": 202,
            }
        # 超时：视为 failed，允许重新触发
        logger.warning("RDS report generating timeout (>%ds), allowing re-trigger",
                       _GENERATING_TIMEOUT_SECONDS)

    # 已有记录（completed/failed/skipped/超时 generating）→ 强制重置
    if existing:
        report_id = reset_health_report_for_regenerate("rds", target_date, "summary")
    else:
        # 全新记录
        report_id = begin_health_report("rds", target_date, "summary")

    # 异步调用 Lambda3（显式传 monitoring_date，确保结果写回与占位行同一 key）
    lambda_client = boto3.client("lambda")
    lambda_client.invoke(
        FunctionName=function_name,
        InvocationType="Event",
        Payload=json.dumps({
            "resource_type": "rds",
            "report_id": report_id,
            "monitoring_date": target_date,
        }),
    )

    return {
        "report_id": report_id,
        "message": "Health check triggered",
        "status": "generating",
        "_status_code": 202,
    }


_RDS_CONFIG_PK = "appconfig#rds_health"


def _get_config() -> dict:
    """获取巡检配置。从 appconfig#rds_health 读取（和 Lambda3 共享同一数据源）。"""
    _table = config_table()
    model_item = _table.get_item(Key={"PK": _RDS_CONFIG_PK, "SK": "bedrock_model_id"}).get("Item", {})
    prompt_item = _table.get_item(Key={"PK": _RDS_CONFIG_PK, "SK": "agent_prompt"}).get("Item", {})

    # Read API Key from Secrets Manager via env var ARN
    api_key_masked = ""
    api_key_configured = False
    secret_arn = os.environ.get("BEDROCK_API_KEY_SECRET_ARN", "")
    if secret_arn:
        try:
            sm = boto3.client("secretsmanager")
            resp = sm.get_secret_value(SecretId=secret_arn)
            secret_dict = json.loads(resp["SecretString"])
            api_key = secret_dict.get("bedrock_api_key", "")
            if api_key:
                api_key_masked = mask_api_key(api_key)
                api_key_configured = True
        except Exception as e:
            logger.warning("Failed to read API Key from Secrets Manager: %s", e)

    return {
        "bedrock_model_id": model_item.get("config_value", ""),
        "agent_prompt": prompt_item.get("config_value", ""),
        "bedrock_api_key_masked": api_key_masked,
        "bedrock_api_key_configured": api_key_configured,
    }


def _update_config(body: dict | None) -> dict:
    """更新巡检配置（bedrock_model_id / agent_prompt / bedrock_api_key）。
    写入 appconfig#rds_health（和 Lambda3 共享同一数据源）。
    """
    if not body:
        raise ValueError("Request body is required")

    # Bedrock API Key 的写入已收敛到 webchat 管理页（BFF `/admin/llm-config/bedrock-key`）
    # 为唯一入口。历史上这里也能写同一个 Secret `notiops/bedrock-api-key`，于是两处抢写、
    # 后写覆盖先写：admin 在 webchat 设好 Key，有人在这个巡检配置页一保存就把它抹掉。
    # 现在写一律拒绝并指回 webchat（放在最前，避免 model_id/prompt 半写后才失败）；GET 仍
    # 回脱敏状态（读同一个 Secret，无冲突）。后端 lambdaRole 的 PutSecretValue 也已一并移除
    # （notiops-backend-stack.ts），判定层 + IAM 层双保险。
    if "bedrock_api_key" in body:
        return {
            "success": False,
            "error": "Bedrock API Key 已由 webchat 管理页统一管理，请在 webchat 设置；此处不再接受写入。",
            "_status_code": 409,
        }

    _table = config_table()
    from shared.queries._client import _now_iso
    now = _now_iso()

    for key in ("bedrock_model_id", "agent_prompt"):
        if key in body:
            value = body[key] if body[key] is not None else ""
            _table.put_item(Item={
                "PK": _RDS_CONFIG_PK,
                "SK": key,
                "config_value": value,
                "updated_at": now,
            })

    return {"success": True}


def _delete_batch(body: dict | None) -> dict:
    """批量删除报告。body: {"items": [{date, type, account}]}"""
    if not body or not body.get("items"):
        raise ValueError("items is required")
    items = body["items"]
    if not isinstance(items, list):
        raise ValueError("items must be a list")

    _table = config_table()
    deleted = 0
    for item in items:
        report_date = item.get("date")
        report_type = item.get("type", "summary")
        account = item.get("account")
        if not report_date:
            continue
        pk = f"hreport#rds#{report_date}"
        sk = f"{report_type}#{account if account else '$GLOBAL'}"
        _table.delete_item(Key={"PK": pk, "SK": sk})
        deleted += 1
    return {"deleted": deleted}


def _get_models() -> dict:
    """返回当前 LLM Provider 下可用的模型列表。"""
    # 1. 决定走哪个 provider
    try:
        from shared.llm_provider import _get_provider as _get_llm_provider
        provider = _get_llm_provider(force_refresh=True)
    except Exception:
        provider = "bedrock"

    # 2. LiteLLM 路径
    if provider == "litellm":
        try:
            from api.routes.system_config import _list_litellm_models
            data = _list_litellm_models()
        except Exception as e:
            logger.exception("LiteLLM models bridge failed; falling back empty list: %s", e)
            return {
                "models": [],
                "llm_provider": "litellm",
                "litellm_reason": f"{type(e).__name__}: {e}",
            }

        out_models = [
            {
                "model_id": m["id"],
                "model_name": m["id"],
                "provider": m.get("provider", "other"),
            }
            for m in (data.get("models") or [])
        ]
        result: dict = {
            "models": out_models,
            "llm_provider": "litellm",
        }
        if data.get("reason"):
            result["litellm_reason"] = data["reason"]
        return result

    # 3. Bedrock 路径(原逻辑)
    client = boto3.client("bedrock")
    models = []
    seen_ids = set()

    try:
        paginator = client.get_paginator("list_inference_profiles")
        for page in paginator.paginate():
            for profile in page.get("inferenceProfileSummaries", []):
                profile_id = profile.get("inferenceProfileId", "")
                profile_name = profile.get("inferenceProfileName", "")
                status = profile.get("status", "")
                if status == "ACTIVE" and profile_id not in seen_ids:
                    seen_ids.add(profile_id)
                    models.append({
                        "model_id": profile_id,
                        "model_name": profile_name or profile_id,
                        "provider": "bedrock",
                    })
    except Exception as e:
        logger.error("Failed to list inference profiles: %s", str(e))

    try:
        resp = client.list_foundation_models(byOutputModality="TEXT")
        for model in resp.get("modelSummaries", []):
            model_id = model.get("modelId", "")
            model_name = model.get("modelName", "")
            throughput = model.get("inferenceTypesSupported", [])
            if "ON_DEMAND" in throughput and model_id not in seen_ids:
                seen_ids.add(model_id)
                models.append({
                    "model_id": model_id,
                    "model_name": model_name or model_id,
                    "provider": "bedrock",
                })
    except Exception as e:
        logger.error("Failed to list foundation models: %s", str(e))

    models.sort(key=lambda m: m["model_name"].lower())

    return {"models": models, "llm_provider": "bedrock"}
