"""
故障调查（Investigation）能力 via **官方 awslabs MCP servers**（进程内 stdio 子进程）。

与 core/finops_mcp.py **完全同构**（同一套进程内 stdio + 只读白名单 + 分层 + 失败安全）：
  · awslabs.cloudwatch-mcp-server —— 告警排障 / 指标 / 日志分析（CloudWatch + Logs Insights）
  · awslabs.cloudtrail-mcp-server —— "谁在何时改了什么"（管理事件查询 / CloudTrail Lake）

设计要点（AgentCore Runtime 适配，沿用 finops 的踩坑经验）：
  - 两个 server 都是 stdio-only 的 pip 包，作为子进程在 agent runtime 容器里常驻（无 sidecar）。
  - Strands `MCPClient(stdio_client(...))`，**模块级单例、首次用时 start 一次、常驻复用**。
  - **只读白名单**：只挂只读分析工具（CloudWatch/CloudTrail 本就只读，但仍显式白名单收敛 token）。
  - **分层省 token**：非「故障调查」主题只挂核心子集（覆盖高频排障）；故障调查主题挂全部。
  - **只读盘适配**：FASTMCP_LOG_FILE / HOME / TMPDIR 指到 /tmp（AgentCore 除 /tmp 外只读，
    见 finops_mcp 同款修复，避免 server 启动即崩）。
  - 失败安全：server 起不来 / 依赖缺失 → 返回空工具列表，agent 照常运行（调查能力缺席，不崩）。
"""
from __future__ import annotations

import logging
import os
import shutil

logger = logging.getLogger(__name__)

# ── 只读工具白名单 ──
# CloudWatch MCP（awslabs.github.io/mcp/servers/cloudwatch-mcp-server）暴露的工具：
_CLOUDWATCH_WHITELIST = {
    # 告警排障
    "get_active_alarms",            # 当前活跃告警（排障入口）
    "get_alarm_history",            # 告警历史状态变化
    "get_recommended_metric_alarms",  # 告警配置建议
    # 指标
    "get_metric_data",             # 任意指标数据（支持 p99/数学表达式/多指标）
    "get_metric_metadata",         # 指标元信息
    "analyze_metric",              # 趋势/季节性/统计分析
    # 日志
    "describe_log_groups",         # 列日志组
    "analyze_log_group",           # 日志异常/错误模式分析
    "execute_log_insights_query",  # Logs Insights 查询（异步：返回 queryId）
    "get_logs_insight_query_results",  # 取查询结果
    "execute_cwl_insights_batch",  # 跨组跨区批量 Logs Insights
    "cancel_logs_insight_query",   # 取消查询
    # PromQL（高级，故障调查主题才需要）
    "execute_promql_query",
    "execute_promql_range_query",
    "get_promql_label_values",
    "get_promql_series",
    "get_promql_labels",
}
# CloudTrail MCP（awslabs.github.io/mcp/servers/cloudtrail-mcp-server）：
_CLOUDTRAIL_WHITELIST = {
    "lookup_events",            # 近 90 天管理事件查询（谁/何时/改了什么）—— 核心
    "lake_query",               # CloudTrail Lake SQL（高级分析）
    "list_event_data_stores",   # 列 Lake 数据存储
    "get_query_status",         # Lake 查询状态
    "get_query_results",        # Lake 查询结果
}
_WHITELIST = _CLOUDWATCH_WHITELIST | _CLOUDTRAIL_WHITELIST

# ── 分层：非故障调查主题只挂核心子集（覆盖 80% 高频排障，省 token）──
# 核心 = 告警排障 + 关键指标 + 日志异常 + CloudTrail 事件查询；
# PromQL / Lake SQL / 批量日志等深度工具留到「故障调查」主题。
_CORE_TOOLS = {
    "get_active_alarms",
    "get_alarm_history",
    "get_metric_data",
    "describe_log_groups",
    "analyze_log_group",
    "execute_log_insights_query",
    "get_logs_insight_query_results",
    "lookup_events",
}

_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
# 可用 env 关掉（出问题时快速回退到无调查工具，不必改代码重部署）。
_DISABLED = os.environ.get("NOTIOPS_DISABLE_INVESTIGATION_MCP", "").strip().lower() in ("1", "true")

_clients = []        # 常驻 MCPClient 单例
_tools_cache = None  # 合并后的白名单工具列表（缓存）

# 两个官方 server 的启动命令（console script 名 + 模块回退路径）。
_SERVERS = [
    ("awslabs.cloudwatch-mcp-server", "awslabs.cloudwatch_mcp_server.server"),
    ("awslabs.cloudtrail-mcp-server", "awslabs.cloudtrail_mcp_server.server"),
]


# ---------------------------------------------------------------------------
# 子进程环境：剥离注入型凭证（spec R6.5.3）
# ---------------------------------------------------------------------------
# `_server_env()` 以 `dict(os.environ)` 起步，也就是**全量继承**父进程环境。这在引入
# Bedrock API Key 之后变成一个真实问题：Key 的注入方式是在父进程里
# `os.environ["AWS_BEARER_TOKEN_BEDROCK"] = <key>` 然后构造 client（botocore 在构造时
# 快照 token）。IM bot 是长驻 ECS 进程，一旦设过，之后 spawn 的**每个** MCP 子进程都会
# 继承它 —— 其中包括 aws-api-mcp-server，而它再 spawn 的 `aws` CLI 又继承一层。
# 那条链的输入是 LLM 生成的命令，也就是任何进入模型上下文的内容都能操纵它。
#
# 所以显式 pop。用前缀匹配而不是写死一个名字：`AWS_BEARER_TOKEN_<SERVICE>` 是 botocore
# 的通用 bearer 机制，将来任何服务的 bearer token 都会落进同一个模式。
# **不动** AWS_ACCESS_KEY_ID / SECRET / SESSION_TOKEN —— 子进程要靠它们以任务角色身份
# 调 AWS，那是设计意图；它们的权限上限由 IAM 控制，不是靠这里剥。
_INJECTED_CREDENTIAL_PREFIXES = ("AWS_BEARER_TOKEN_",)


def _strip_injected_credentials(env: dict) -> dict:
    """就地移除我们主动注入到父进程的凭证，返回同一个 dict（便于链式调用）。"""
    for name in [k for k in env
                 if k.upper().startswith(_INJECTED_CREDENTIAL_PREFIXES)]:
        env.pop(name, None)
    return env


def _server_env() -> dict:
    env = _strip_injected_credentials(dict(os.environ))
    env.setdefault("AWS_REGION", _REGION)
    env.setdefault("AWS_DEFAULT_REGION", _REGION)
    env["FASTMCP_LOG_LEVEL"] = "ERROR"
    env["FASTMCP_DISABLE_BANNER"] = "1"
    env["PYTHONWARNINGS"] = "ignore"
    # AgentCore runtime 除 /tmp 外**只读**：把任何要落盘的路径都指到 /tmp（见 finops_mcp 同款踩坑）。
    env.setdefault("FASTMCP_LOG_FILE", "/tmp/notiops-investigation-mcp.log")
    env.setdefault("HOME", "/tmp")
    env.setdefault("TMPDIR", "/tmp")
    return env


def _resolve_cmd(console_script: str, module: str) -> list[str] | None:
    """优先用 venv 里的 console script；找不到则回退 `python -m <module>`。"""
    import sys
    path = shutil.which(console_script)
    if path:
        return [path]
    return [sys.executable, "-m", module]


def get_tools(core_only: bool = False):
    """返回故障调查工具列表（供 main.py 挂进 agent）。
    - core_only=True（非故障调查主题）：只返回 _CORE_TOOLS（高频，省 token）。
    - core_only=False（故障调查主题）：返回全部白名单（全功能）。
    任何失败：记日志，返回已成功子集（可能为空），不抛 —— agent 照常运行。
    """
    if _DISABLED:
        return []
    all_tools = _load_all_tools()
    if core_only:
        return [t for t in all_tools if t.tool_name in _CORE_TOOLS]
    return all_tools


def _load_all_tools():
    """启动两个 stdio 子进程、list_tools、按全白名单过滤、缓存全量工具（只跑一次）。"""
    global _tools_cache
    if _tools_cache is not None:
        return _tools_cache

    from mcp import StdioServerParameters
    from mcp.client.stdio import stdio_client
    from strands.tools.mcp import MCPClient

    merged = []
    env = _server_env()
    for console_script, module in _SERVERS:
        cmd = _resolve_cmd(console_script, module)
        if not cmd:
            logger.warning("investigation_mcp: cannot resolve command for %s", console_script)
            continue
        try:
            client = MCPClient(lambda c=cmd: stdio_client(
                StdioServerParameters(command=c[0], args=c[1:], env=env)))
            client.start()  # 常驻；不进入 with（生命周期 = 容器）
            _clients.append(client)
            tools = client.list_tools_sync()
            kept = [t for t in tools if t.tool_name in _WHITELIST]
            # 给工具结果加体积上限 + CloudTrail 字段投影（防 token 爆炸；复用 aws_api_mcp 的包装）。
            # 尤其 lookup_events 返回的原始 CloudTrail 事件极大、且每个 cycle 重发——必须收敛。
            try:
                from core.aws_api_mcp import _wrap_capped as _cap
                kept = [_cap(t) for t in kept]
            except Exception as _e:  # noqa: BLE001 — 包装不可用就用原工具，不阻断
                logger.warning("investigation_mcp: result-cap wrap unavailable: %s", _e)
            logger.info("investigation_mcp: %s → %d/%d tools kept (whitelist, result-capped)",
                        console_script, len(kept), len(tools))
            merged.extend(kept)
        except Exception as e:  # noqa: BLE001 — 单个 server 起不来不影响另一个/整体
            import traceback as _tb
            logger.warning("investigation_mcp: failed to start %s: %s\n%s",
                           console_script, e, _tb.format_exc())
            # 诊断：直接 spawn server 进程抓 stderr（MCPClient 后台线程吞掉真实报错）。
            try:
                import subprocess as _sp
                p = _sp.run(cmd, input=b"", env=env, capture_output=True, timeout=20)  # nosec B603 - cmd is a fixed [sys.executable,'-m',<hardcoded module>] / console-script path from _resolve_cmd(); no shell, no user input  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                logger.warning("investigation_mcp: %s stderr:\n%s",
                               console_script, (p.stderr or b"").decode("utf-8", "replace")[:2000])
            except Exception:  # noqa: BLE001
                pass

    _tools_cache = merged
    return merged
