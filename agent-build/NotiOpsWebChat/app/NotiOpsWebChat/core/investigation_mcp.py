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
import threading

from core import mcp_snapshot as _snap

logger = logging.getLogger(__name__)

_GROUP = "investigation"   # 快照分组名（见 core/mcp_snapshot.py）


def _safe_err(e: Exception) -> str:
    """Sensitive-data handling: return the exception *type* (plus the AWS
    error code for botocore ClientError), never the raw message / traceback
    which can embed request payloads or user data. See docs/LOGGING_STANDARD.md."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


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
_LOAD_LOCK = threading.Lock()  # 守住"子进程只起一次"（_load_all_tools 可能被并发进入）

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
    """拿到全量白名单工具并缓存（只跑一次）。与 finops_mcp._load_all_tools 同构，两条路：

    ① **快照路径**：从 S3 读回工具 schema 直接挂成懒工具，**不起子进程**；`main.py`
       在寒暄闸门之后调 `mcp_snapshot.warm_now()` 在后台真正拉起来。
    ② **同步路径**（首次 / 版本变了 / 快照不可用）：并行启动 + list_tools（今天的行为），
       成功后把快照写回 S3，于是**下一个新会话**走 ①。

    为什么并行（②）：启动几乎全是等待，串行会把两个 server 的秒级冷启**直接累加**到每个
    新会话的首字延迟上（现网实测 cloudwatch 9.3s + cloudtrail 2.8s ≈ 12s，并行后 ≈ 最慢
    那个）。MCPClient 每实例自带后台线程 + 独立事件循环、实例间无共享可变状态，故并发
    start() 安全；返回顺序按 `_SERVERS` 固定（预分配槽位），不随线程完成先后抖动 ——
    工具顺序进 prompt，抖动会让 prompt 缓存整段失效。快照路径同样按 `_SERVERS` 顺序拼接。
    """
    global _tools_cache
    if _tools_cache is not None:
        return _tools_cache
    # 双检 + 锁：并发的首轮请求（Agent 实例缓存未命中时可能同时构造）不能各起一遍子进程。
    with _LOAD_LOCK:
        if _tools_cache is not None:
            return _tools_cache
        lazy = _lazy_all_tools()
        if lazy is not None:
            _tools_cache = lazy
            logger.info("investigation_mcp: total %d investigation tools exposed "
                        "(from snapshot, no subprocess started)", len(lazy))
            return lazy
        per_server = _start_servers()
        _tools_cache = _post(per_server)
        logger.info("investigation_mcp: total %d investigation tools exposed", len(_tools_cache))
        # 存**原始** list_tools 输出（不是过滤/包装后的）：白名单与包装改动因此立刻生效，
        # 不必参与快照指纹。
        _snap.save(_GROUP, per_server)
        return _tools_cache


def _post(per_server: list) -> list:
    """白名单过滤 + 结果上限包装 + 按 server 原顺序拼接。
    **快照路径与同步路径共用这一段**，保证两条路产出的工具集合与包装逐项一致 ——
    否则会出现「只有走某条路时才少一层结果截断」这种最难查的分叉。"""
    merged: list = []
    for console_script, tools in per_server:
        kept = [t for t in tools if t.tool_name in _WHITELIST]
        # 给工具结果加体积上限 + CloudTrail 字段投影（防 token 爆炸；复用 aws_api_mcp 的包装）。
        # 尤其 lookup_events 返回的原始 CloudTrail 事件极大、且每个 cycle 重发——必须收敛。
        try:
            from core.aws_api_mcp import _wrap_capped as _cap
            kept = [_cap(t) for t in kept]
        except Exception as _e:  # noqa: BLE001 — 包装不可用就用原工具，不阻断
            logger.warning("investigation_mcp: result-cap wrap unavailable: %s", _safe_err(_e))
        logger.info("investigation_mcp: %s → %d/%d tools kept (whitelist, result-capped)",
                    console_script, len(kept), len(tools))
        merged.extend(kept)
    return merged


def _lazy_all_tools():
    """用 S3 快照挂载工具（不起子进程）。拿不到 / 对不上 → 返回 None，调用方走同步路径。"""
    snap = _snap.snapshot_for(_GROUP)
    if not snap:
        return None
    # server 集合与顺序必须与当前 `_SERVERS` 完全一致。对不上说明代码增删了 server 而
    # 包版本没变（指纹抓不到这种改动）—— 宁可回到同步路径重建，也不要挂一份过时清单。
    if [k for k, _ in snap] != [s[0] for s in _SERVERS]:
        logger.warning("investigation_mcp: snapshot server set differs from _SERVERS, ignoring")
        return None
    per_server = _snap.lazy_tools(_GROUP, snap, _connector_for)
    if per_server is None:
        return None
    return _post(per_server)


def _connector_for(console_script: str):
    """给懒客户端用：返回一个「把这个 server 拉起来并交出 MCPClient」的阻塞可调用。"""
    def _connect():
        for server in _SERVERS:
            if server[0] == console_script:
                return _connect_one(server, _server_env())
        logger.warning("investigation_mcp: unknown server %s", console_script)
        return None
    return _connect


def _start_servers() -> list:
    """并行启动 `_SERVERS`，按其原顺序返回 `[(console_script, 该 server 的全部工具)]`
    （起不来的那个是空列表）。"""
    import concurrent.futures as _cf

    env = _server_env()
    slots: list = [(s[0], []) for s in _SERVERS]
    if len(_SERVERS) < 2:
        for i, server in enumerate(_SERVERS):
            slots[i] = (server[0], _start_one(server, env))
        return slots
    with _cf.ThreadPoolExecutor(max_workers=len(_SERVERS),
                               thread_name_prefix="investigation-mcp") as ex:
        futs = {ex.submit(_start_one, server, env): i for i, server in enumerate(_SERVERS)}
        for fut, i in futs.items():
            try:
                slots[i] = (_SERVERS[i][0], fut.result())
            except Exception as e:  # noqa: BLE001 — _start_one 已自吞；这里是兜底
                logger.warning("investigation_mcp: server slot %d failed: %s", i, _safe_err(e))
    return slots


def _start_one(server: tuple, env: dict) -> list:
    """启动单个 server 并返回它 `list_tools` 的**全部**工具（过滤/包装在 `_post`）。
    任何失败都只记日志、返回空列表。"""
    client = _connect_one(server, env)
    if client is None:
        return []
    try:
        return client.list_tools_sync()
    except Exception as e:  # noqa: BLE001 — 单个 server 列不出工具不影响另一个/整体
        logger.warning("investigation_mcp: list_tools failed for %s: %s",
                       server[0], _safe_err(e))
        return []


def _connect_one(server: tuple, env: dict):
    """启动单个 server 子进程并返回常驻的 `MCPClient`（失败返回 None，只记日志不抛）。

    同步路径与懒路径**共用**这一个函数，所以两条路起出来的子进程环境、命令解析、
    日志文件、诊断行为完全相同。
    """
    from mcp import StdioServerParameters
    from mcp.client.stdio import stdio_client
    from strands.tools.mcp import MCPClient

    console_script, module = server
    # 每个 server 一份**独立的** env 副本，并给它单独的 FASTMCP_LOG_FILE。
    # 两个原因：① _start_one 现在是**并发**跑的，共享一个可变 dict 是白送出去的隐患
    # （我们自己不改它，但 env 会一路传进 mcp 库，下游怎么用不在我们手里）；
    # ② 原来一组里两个 server 共写同一个日志文件 —— 串行启动时只是先后追加，并发启动
    # 会让两个 server 的启动期 traceback 逐行交织，正好毁掉排查并行问题最需要的那份日志。
    # 运营方若显式设了 FASTMCP_LOG_FILE，尊重它（沿用 _server_env 的 setdefault 语义）。
    env = dict(env)
    if not os.environ.get("FASTMCP_LOG_FILE"):
        env["FASTMCP_LOG_FILE"] = f"/tmp/notiops-mcp-{console_script.replace('.', '-')}.log"
    cmd = _resolve_cmd(console_script, module)
    if not cmd:
        logger.warning("investigation_mcp: cannot resolve command for %s", console_script)
        return None
    try:
        client = MCPClient(lambda c=cmd: stdio_client(
            StdioServerParameters(command=c[0], args=c[1:], env=env)))
        client.start()  # 常驻；不进入 with（生命周期 = 容器）
        _clients.append(client)  # 仅保活引用，无人按下标读；append 在 GIL 下原子
        logger.info("investigation_mcp: %s started", console_script)
        return client
    except Exception as e:  # noqa: BLE001 — 单个 server 起不来不影响另一个/整体
        # Security: WARNING 只记异常类型；traceback / 子进程 stderr 可能带 payload 或用户数据，
        # 只在 DEBUG 下输出（与 finops_mcp 一致，见 docs/LOGGING_STANDARD.md）。
        logger.warning("investigation_mcp: failed to start %s: %s", console_script, _safe_err(e))
        if logger.isEnabledFor(logging.DEBUG):
            import traceback as _tb
            logger.debug("investigation_mcp: %s start traceback:\n%s", console_script, _tb.format_exc())
            # 诊断：直接 spawn server 进程抓 stderr（MCPClient 后台线程吞掉真实报错）。
            try:
                import subprocess as _sp
                p = _sp.run(cmd, input=b"", env=env, capture_output=True, timeout=20)  # nosec B603 - cmd is a fixed [sys.executable,'-m',<hardcoded module>] / console-script path from _resolve_cmd(); no shell, no user input  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                err = (p.stderr or b"").decode("utf-8", "replace")[-1500:]
                logger.debug("investigation_mcp: %s direct-spawn stderr tail:\n%s", console_script, err)
            except Exception as e2:  # noqa: BLE001
                logger.debug("investigation_mcp: %s direct-spawn diag failed: %s", console_script, _safe_err(e2))
        return None
