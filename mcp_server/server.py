"""
AWS 资源闲置检测 MCP Server。

将现有的 21 个工具通过 MCP 协议暴露，支持 stdio 和 SSE 两种传输方式。
外部 Agent（如 OpenClaw）可通过 MCP 协议直接调用这些工具。

启动方式：
  stdio:  python -m mcp_server.server
  SSE:    python -m mcp_server.server --transport sse --port 8888
"""

import json
import logging
import os
import sys
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

logger = logging.getLogger("mcp_server")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

# API 基础地址 — 指向现有的 API Gateway 或本地 API Lambda
API_BASE_URL = os.environ.get("API_BASE_URL", "http://localhost:3000/api")

mcp = FastMCP(
    "notiops",
    instructions="AWS 资源闲置检测与优化系统 — 查询闲置资源、分析报告、管理白名单和阈值配置",
)

# ---------------------------------------------------------------------------
# HTTP 客户端 — 调用现有 API Lambda
# ---------------------------------------------------------------------------

_http_client: httpx.AsyncClient | None = None


async def get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(base_url=API_BASE_URL, timeout=30.0)
    return _http_client


async def api_call(method: str, endpoint: str, params: dict | None = None, body: dict | None = None) -> dict:
    """调用现有 API 端点并返回 JSON 响应。"""
    client = await get_client()
    try:
        if method == "GET":
            resp = await client.get(endpoint, params=params)
        elif method == "POST":
            resp = await client.post(endpoint, json=body)
        elif method == "PUT":
            resp = await client.put(endpoint, json=body)
        elif method == "DELETE":
            resp = await client.delete(endpoint)
        else:
            return {"error": f"不支持的 HTTP 方法: {method}"}
        resp.raise_for_status()
        return resp.json()
    except httpx.HTTPStatusError as e:
        return {"error": f"API 返回 {e.response.status_code}", "detail": e.response.text[:500]}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# 只读工具（11 个）
# ---------------------------------------------------------------------------

@mcp.tool()
async def query_dashboard_summary(account_id: str = "", region: str = "") -> str:
    """查询资源大盘概览，返回各类资源的闲置统计和成本节省汇总"""
    params = {}
    if account_id:
        params["account_id"] = account_id
    if region:
        params["region"] = region
    result = await api_call("GET", "/dashboard/summary", params=params)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def query_waste_report(
    account_id: str = "",
    resource_type: str = "",
    report_date: str = "",
) -> str:
    """查询闲置资源报告，支持按账户、资源类型（rds/elasticache）、报告日期筛选。

    返回该日期（缺省为最新）经白名单过滤后的完整 idle 列表 + total + total_savings。
    """
    params = {}
    if account_id:
        params["account_id"] = account_id
    if resource_type:
        params["resource_type"] = resource_type
    if report_date:
        params["report_date"] = report_date
    result = await api_call("GET", "/waste-report", params=params)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def query_optimization_report(
    account_id: str = "",
    resource_type: str = "",
    report_date: str = "",
) -> str:
    """查询容量优化报告，支持按账户、资源类型（rds/elasticache）、报告日期筛选。

    返回资源优化建议 + total + total_cost（该日期缺省为最新）。
    """
    params = {}
    if account_id:
        params["account_id"] = account_id
    if resource_type:
        params["resource_type"] = resource_type
    if report_date:
        params["report_date"] = report_date
    result = await api_call("GET", "/optimization-report", params=params)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def query_ec2_underutilized(account_id: str = "", region: str = "") -> str:
    """查询 EC2 低利用率报告，返回低利用率实例列表及指标数据"""
    params = {}
    if account_id:
        params["account_id"] = account_id
    if region:
        params["region"] = region
    result = await api_call("GET", "/ec2-underutilized", params=params)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def query_rds_health_report(account_id: str = "", report_date: str = "", show_all: str = "") -> str:
    """查询 RDS 巡检报告列表。不传 report_date 时默认只返回最新日期的报告；如需查询历史报告请传 report_date（YYYY-MM-DD）；如需所有日期请传 show_all=true"""
    params = {}
    if account_id:
        params["account_id"] = account_id
    if report_date:
        params["report_date"] = report_date
    if show_all:
        params["show_all"] = show_all
    result = await api_call("GET", "/rds-health-check", params=params)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def query_rds_health_detail(id: str) -> str:
    """查询巡检报告详情，返回指定报告的完整巡检结果"""
    result = await api_call("GET", f"/rds-health-check/{id}")
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def query_pipeline_status() -> str:
    """查询采集流水线执行状态，返回当前和历史执行记录"""
    result = await api_call("GET", "/pipeline/status")
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def query_target_accounts() -> str:
    """查询已注册目标账户列表，返回所有受管 AWS 账户信息"""
    result = await api_call("GET", "/target-accounts")
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def query_whitelist(resource_type: str = "") -> str:
    """查询闲置检测白名单，返回已加入白名单的资源列表"""
    params = {}
    if resource_type:
        params["resource_type"] = resource_type
    result = await api_call("GET", "/whitelist", params=params)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def query_health_check_whitelist() -> str:
    """查询巡检白名单，返回已排除巡检的资源列表"""
    result = await api_call("GET", "/health-check-whitelist")
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def query_threshold_config(resource_type: str = "") -> str:
    """查询阈值配置，返回各资源类型的闲置判定阈值"""
    params = {}
    if resource_type:
        params["resource_type"] = resource_type
    result = await api_call("GET", "/threshold-config", params=params)
    return json.dumps(result, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 触发工具（2 个）
# ---------------------------------------------------------------------------

@mcp.tool()
async def trigger_collection() -> str:
    """触发数据采集流水线，启动跨账户资源监控指标采集任务"""
    result = await api_call("POST", "/pipeline/trigger")
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def trigger_health_check(account_id: str = "") -> str:
    """触发 RDS AI 巡检报告生成，启动数据库健康检查分析"""
    body = {}
    if account_id:
        body["account_id"] = account_id
    result = await api_call("POST", "/rds-health-check/trigger", body=body)
    return json.dumps(result, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 写操作工具（8 个）— 需要确认后执行
# ---------------------------------------------------------------------------

@mcp.tool()
async def add_whitelist(resource_id: str, resource_type: str, reason: str = "") -> str:
    """添加闲置检测白名单 [写操作]，将指定资源排除在闲置检测之外"""
    body: dict[str, Any] = {"resource_id": resource_id, "resource_type": resource_type}
    if reason:
        body["reason"] = reason
    result = await api_call("POST", "/whitelist", body=body)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def remove_whitelist(id: str) -> str:
    """移除闲置检测白名单 [写操作]，将指定资源重新纳入闲置检测范围"""
    result = await api_call("DELETE", f"/whitelist/{id}")
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def add_health_check_whitelist(resource_id: str, resource_type: str, reason: str = "") -> str:
    """添加巡检白名单 [写操作]，将指定资源排除在健康巡检之外"""
    body: dict[str, Any] = {"resource_id": resource_id, "resource_type": resource_type}
    if reason:
        body["reason"] = reason
    result = await api_call("POST", "/health-check-whitelist", body=body)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def remove_health_check_whitelist(id: str) -> str:
    """移除巡检白名单 [写操作]，将指定资源重新纳入健康巡检范围"""
    result = await api_call("DELETE", f"/health-check-whitelist/{id}")
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def update_threshold_config(id: str, threshold_value: float, description: str = "") -> str:
    """更新阈值配置 [写操作]，修改资源闲置判定的阈值参数"""
    body: dict[str, Any] = {"threshold_value": threshold_value}
    if description:
        body["description"] = description
    result = await api_call("PUT", f"/threshold-config/{id}", body=body)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def add_target_account(account_id: str, account_name: str, regions: list[str], role_arn: str) -> str:
    """添加目标账户 [写操作]，注册新的 AWS 账户到监控范围"""
    body = {
        "account_id": account_id,
        "account_name": account_name,
        "regions": regions,
        "role_arn": role_arn,
    }
    result = await api_call("POST", "/target-accounts", body=body)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def update_target_account(
    id: str, account_name: str = "", regions: list[str] | None = None, role_arn: str = ""
) -> str:
    """更新目标账户配置 [写操作]，修改已注册账户的监控设置"""
    body: dict[str, Any] = {}
    if account_name:
        body["account_name"] = account_name
    if regions is not None:
        body["regions"] = regions
    if role_arn:
        body["role_arn"] = role_arn
    result = await api_call("PUT", f"/target-accounts/{id}", body=body)
    return json.dumps(result, ensure_ascii=False, indent=2)


@mcp.tool()
async def delete_target_account(id: str) -> str:
    """删除目标账户 [写操作]，从监控范围中移除指定 AWS 账户"""
    result = await api_call("DELETE", f"/target-accounts/{id}")
    return json.dumps(result, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main():
    """启动 MCP Server。

    默认 stdio 传输，可通过命令行参数切换：
      --transport sse --port 8888
    """
    transport = "stdio"
    port = 8888

    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--transport" and i + 1 < len(args):
            transport = args[i + 1]
            i += 2
        elif args[i] == "--port" and i + 1 < len(args):
            port = int(args[i + 1])
            i += 2
        else:
            i += 1

    if transport == "sse":
        logger.info("启动 MCP Server (SSE)，端口 %d", port)
        mcp.run(transport="sse", port=port)
    else:
        logger.info("启动 MCP Server (stdio)")
        mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
