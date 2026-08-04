"""
API Lambda 主入口。
处理 API Gateway 事件，路由到对应的处理函数。
"""

import json
import logging
import os
import traceback
from decimal import Decimal

from api.routes.dashboard import handle_dashboard
from api.routes.waste_report import handle_waste_report
from api.routes.whitelist import handle_whitelist
from api.routes.threshold import handle_threshold
from api.routes.accounts import handle_accounts
from api.routes.optimization_report import handle_optimization_report
from api.routes.ec2_underutilized import handle_ec2_underutilized
from api.routes.rds_health_check import handle_rds_health_check
from api.routes.elasticache_health_check import handle_elasticache_health_check
from api.routes.health_check_whitelist import handle_health_check_whitelist
from api.routes.pipeline import handle_pipeline
from api.routes.notification_config import handle_notification_config
from api.routes.cost_anomaly import handle_cost_anomaly
from api.routes.devops_agent import handle_devops_agent
from api.routes.agent_config import handle_agent_config
from api.routes.system_config import handle_system_config
from api.routes.org_onboard import handle_org_onboard

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# 路由映射表
ROUTE_MAP = {
    "/api/dashboard": handle_dashboard,
    "/api/waste-report": handle_waste_report,
    "/api/whitelist": handle_whitelist,
    "/api/threshold-config": handle_threshold,
    "/api/target-accounts": handle_accounts,
    "/api/optimization-report": handle_optimization_report,
    "/api/ec2-underutilized": handle_ec2_underutilized,
    "/api/rds-health-check": handle_rds_health_check,
    "/api/elasticache-health-check": handle_elasticache_health_check,
    "/api/health-check-whitelist": handle_health_check_whitelist,
    "/api/pipeline": handle_pipeline,
    "/api/notification-config": handle_notification_config,
    "/api/cost-anomaly": handle_cost_anomaly,
    "/api/devops-agent": handle_devops_agent,
    "/api/agent-config": handle_agent_config,
    "/api/system-config": handle_system_config,
    "/api/org-onboard": handle_org_onboard,
}


def _cors_headers() -> dict:
    return {
        "Access-Control-Allow-Origin": os.environ.get("CORS_ALLOWED_ORIGIN", "*"),
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    }


def _json_encode_default(o):
    """JSON default for API responses.

    DynamoDB returns all numbers as Decimal; emit them as JSON numbers
    (int for integral, float otherwise) so the frontend receives real
    numbers rather than quoted strings. Any other non-serializable type
    falls back to str (preserves prior behavior).
    """
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    return str(o)


def _response(status_code: int, body: dict | list | str) -> dict:
    return {
        "statusCode": status_code,
        "headers": {**_cors_headers(), "Content-Type": "application/json"},
        "body": json.dumps(body, default=_json_encode_default),
    }


def _csv_response(status_code: int, body: str, filename: str) -> dict:
    return {
        "statusCode": status_code,
        "headers": {
            **_cors_headers(),
            "Content-Type": "text/csv",
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
        "body": body,
    }


def handler(event: dict, context) -> dict:
    """API Gateway Lambda 主入口。"""
    http_method = event.get("httpMethod", "GET")
    path = event.get("path", "")
    query_params = event.get("queryStringParameters") or {}
    path_params = event.get("pathParameters") or {}

    # OPTIONS 预检请求
    if http_method == "OPTIONS":
        return _response(200, {"message": "OK"})

    # 解析请求体
    body = None
    if event.get("body"):
        try:
            body = json.loads(event["body"])
        except (json.JSONDecodeError, TypeError):
            return _response(400, {"error": "ValidationError", "message": "Invalid JSON body"})

    # 路由匹配
    matched_handler = None
    for route_prefix, route_handler in ROUTE_MAP.items():
        if path == route_prefix or path.startswith(route_prefix + "/"):
            matched_handler = route_handler
            break

    if matched_handler is None:
        return _response(404, {"error": "NotFound", "message": f"Route not found: {path}"})

    try:
        result = matched_handler(
            method=http_method,
            path=path,
            query_params=query_params,
            path_params=path_params,
            body=body,
        )
        # 支持 CSV 导出等特殊响应
        if isinstance(result, dict) and result.get("_csv"):
            return _csv_response(200, result["_csv"], result.get("_filename", "export.csv"))
        # 支持自定义状态码（如 trigger 返回 202）
        status_code = 200
        if isinstance(result, dict) and result.get("_status_code"):
            status_code = result.pop("_status_code")
        return _response(status_code, result)
    except ValueError as e:
        return _response(400, {"error": "ValidationError", "message": str(e)})
    except KeyError as e:
        return _response(404, {"error": "NotFound", "message": str(e)})
    except Exception as e:
        logger.error("Unhandled error: %s\n%s", e, traceback.format_exc())
        return _response(500, {"error": "InternalError", "message": "Internal server error"})
