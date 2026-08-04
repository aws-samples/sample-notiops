"""
Pipeline 手动触发路由。

POST /api/pipeline/trigger  - 手动触发 Lambda1（采集+分析）
GET  /api/pipeline/status    - 查询最近一次执行状态
"""

import json
import logging
import os

import boto3

from shared.queries.execution import get_latest_execution

logger = logging.getLogger(__name__)


def handle_pipeline(method: str, path: str, query_params: dict, path_params: dict, body: dict | None) -> dict:
    if method == "POST" and path.endswith("/trigger"):
        return _trigger()
    if method == "GET" and path.endswith("/status"):
        return _get_status()
    raise ValueError(f"Unknown pipeline route: {method} {path}")


def _trigger() -> dict:
    """异步触发 Lambda1-Collector。"""
    function_name = os.environ.get("COLLECTOR_FUNCTION_NAME", "")
    if not function_name:
        raise ValueError("COLLECTOR_FUNCTION_NAME not configured")

    lambda_client = boto3.client("lambda")
    lambda_client.invoke(
        FunctionName=function_name,
        InvocationType="Event",
        Payload=json.dumps({"source": "manual"}),
    )

    logger.info("Pipeline triggered manually: function=%s", function_name)
    return {
        "message": "采集任务已提交，Lambda1 完成后将自动触发 Lambda2 分析",
        "_status_code": 202,
    }


def _get_status() -> dict:
    """查询最近一次采集执行状态。"""
    row = get_latest_execution("collection")
    if not row:
        return {"status": "unknown", "message": "暂无执行记录"}
    return {
        "status": row.get("status", "unknown"),
        "execution_date": row.get("created_at"),
        "duration_seconds": row.get("duration_seconds"),
        "error_message": row.get("error_message"),
    }
