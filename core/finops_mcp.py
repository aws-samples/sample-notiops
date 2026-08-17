"""
FinOps via **官方 awslabs MCP servers**（进程内 stdio 子进程）。

设计（AgentCore Runtime 适配）：
  - 两个官方 server 都是 **stdio-only** 的 pip 包，作为子进程在 agent 自己的 runtime
    容器里常驻运行（无 sidecar / 无网络跳数 / 无 HTTP 包装）：
      · awslabs.aws-pricing-mcp-server            —— AWS 服务定价
      · awslabs.billing-cost-management-mcp-server —— 成本/账单/优化/异常/RI&SP…
  - Strands `MCPClient(stdio_client(...))` 管理子进程生命周期。**模块级单例、首次用时
    start 一次、常驻复用**（不每请求重启 → 避免冷启动延迟）。
  - **只读白名单**：两个 server 合计暴露 42 个工具，含 billing-conductor 写/管理类与
    本地文件分析类。我们只挂高价值**只读分析**工具（见 _WHITELIST），收敛 token 占用、
    挡掉写操作与冷门工具。
  - 凭证：子进程用容器进程的 AWS 凭证（= runtime 执行角色）。第一版支持**部署账号**；
    跨账号（注入临时凭证给子进程）留后续。
  - 失败安全：server 起不来 / 依赖缺失 → 返回空工具列表，agent 照常运行（成本能力缺席，
    不崩）。
"""
from __future__ import annotations

import logging
import os
import shutil

logger = logging.getLogger(__name__)


def _safe_err(e: Exception) -> str:
    """Sensitive-data handling: return the exception *type* (plus the AWS
    error code for botocore ClientError), never the raw message / traceback
    which can embed request payloads or user data. See docs/LOGGING_STANDARD.md."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__

# ── 只读工具白名单（沿用老 sidecar 的精选只读集 + Pricing）──
# 成本（billing-cost-management-mcp-server 暴露的 33 个里取这些只读分析项）：
_COST_WHITELIST = {
    "cost-explorer",        # 成本与用量（核心）
    "cost-anomaly",         # 成本异常
    "cost-comparison",      # 任意两期对比
    "cost-optimization",    # Cost Optimization Hub 建议
    "compute-optimizer",    # rightsizing 明细
    "ri-performance",       # 预留实例表现
    "sp-performance",       # Savings Plans 表现
    "budgets",              # 预算 vs 实际
    "free-tier-usage",      # 免费额度
    "storage-lens",         # S3 存储分析
    "rec-details",          # 优化建议下钻
    "session-sql",          # cost-explorer preview 的跟进 SQL 查询（awslabs 要求）
    "list-cost-allocation-tags",  # 成本分配标签
}
# 定价（aws-pricing-mcp-server 暴露的 9 个里取只读定价查询）：
_PRICING_WHITELIST = {
    "get_pricing",                      # 查服务单价（核心）
    "get_pricing_service_codes",        # 服务代码
    "get_pricing_service_attributes",   # 可筛选属性
    "get_pricing_attribute_values",     # 属性取值
    "generate_cost_report",             # 成本报告（基于定价）
}
_WHITELIST = _COST_WHITELIST | _PRICING_WHITELIST

# ── P1b 工具分层：省 token ──
# 全部 18 个工具的 schema 合计 ~17K token，**每次模型调用都全量带上**。其中很多
# （storage-lens / ri/sp-performance / cost-comparison / generate_cost_report …）是
# 深度/低频工具。**非 FinOps 主题只挂核心子集**（覆盖 80% 高频成本/定价问题），
# FinOps 主题才挂全部 18 个。核心集刻意精简，控制固定 token 税。
_CORE_TOOLS = {
    "cost-explorer",                  # 成本/用量（最高频）
    "cost-optimization",              # 降本建议
    "cost-anomaly",                   # 异常
    "get_pricing",                    # 定价
    "get_pricing_service_codes",      # （get_pricing 的前置）
    "get_pricing_attribute_values",   # （get_pricing 的前置）
    "session-sql",                    # cost-explorer preview 的必需跟进
}

# 子进程环境：静默 banner / 降日志噪声；区域跟随 runtime。
_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"

# 可用 env 关掉（出问题时快速回退到无成本工具，不必改代码重部署）。
_DISABLED = os.environ.get("NOTIOPS_DISABLE_FINOPS_MCP", "").strip().lower() in ("1", "true")

_clients = []      # 常驻 MCPClient 单例
_tools_cache = None  # 合并后的白名单工具列表（缓存）


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
    # 关键修复①：billing-cost-management server 默认把日志写到**包安装目录/logs**
    # （logging_utils.get_server_directory → base_dir/'logs'.mkdir()）。AgentCore runtime
    # 的文件系统除 /tmp 外**只读**，该 mkdir 抛错 → server 启动即崩、Connection closed。
    # 显式把 FASTMCP_LOG_FILE 指到 /tmp（可写），绕开对包目录的写入。
    env.setdefault("FASTMCP_LOG_FILE", "/tmp/notiops-finops-mcp.log")
    # 关键修复②：大响应的 SQLite 会话库落盘问题。
    # billing server 在响应 > MCP_SQL_THRESHOLD(默认 25KB) 时会把结果转成 SQLite 紧凑引用
    # （sql_utils.get_session_db_path → base_dir/'sessions'/makedirs；路径由 __file__ 推导、
    # 只读盘 → PermissionError）。**真正修法是改写盘位置（见 _BILLING_BOOTSTRAP 把 session 目录
    # patch 到 /tmp），而不是关掉 SQL 转换**。
    # ⚠️ 教训：曾一度把 MCP_SQL_THRESHOLD 设成 1GB 直接关掉 SQL 转换来"绕开"落盘——这是错的：
    #   SQL 转换正是 awslabs 用来把"按天×各服务整月"这类**超大响应**压成紧凑 SQL 引用、
    #   **避免塞爆模型上下文窗口**的机制。关掉后，原始大 JSON 直接进 prompt → DeepSeek V3.2
    #   (163840 上限) 溢出 → ConverseStream ValidationException → 前端 "(no response)"。
    #   现在 session 目录已能安全写 /tmp，故**恢复默认阈值**（保留 SQL 紧凑化这道保护）。
    env["MCP_FORCE_SQL"] = "false"  # 不强制（小响应仍直返，省一次 SQL 开销）
    # 兜底：万一未来某工具仍尝试写"工作目录"，把 HOME / 临时目录都指到 /tmp（可写）。
    env.setdefault("HOME", "/tmp")
    env.setdefault("TMPDIR", "/tmp")
    return env


# 关键修复③（cost-explorer 真正修复）：billing server 的 cost_explorer 等工具会**无条件**
# 调 convert_api_response_to_table → get_session_db_path()，把一个 SQLite 落到
# **包目录/sessions**（由 __file__ 推导、**无 env 可改**、且 MCP_SQL_THRESHOLD 对这条
# 直连路径**无效**）。AgentCore 上包目录只读 → 每次 cost-explorer 调用都 PermissionError。
# 唯一可靠修法：用一个 bootstrap 脚本在**子进程内** monkeypatch 该函数，把 session DB 改到
# /tmp（可写），再启动 server。对 billing server 用此 bootstrap 启动；pricing server 无此问题。
_BILLING_BOOTSTRAP_SRC = '''\
import os, uuid, atexit
_SESS = "/tmp/awslabs-sessions"
os.makedirs(_SESS, exist_ok=True)
import awslabs.billing_cost_management_mcp_server.utilities.sql_utils as su
def _patched_get_session_db_path():
    if su._SESSION_DB_PATH is None:
        su._SESSION_DB_PATH = os.path.join(_SESS, "session_%s.db" % str(uuid.uuid4())[:8])
        atexit.register(su.cleanup_session_db)
    return su._SESSION_DB_PATH
su.get_session_db_path = _patched_get_session_db_path
su._SESSION_DB_PATH = None
from awslabs.billing_cost_management_mcp_server.server import main
main()
'''
_BILLING_BOOTSTRAP_PATH = "/tmp/notiops_billing_bootstrap.py"


def _resolve_cmd(console_script: str, module: str) -> list[str] | None:
    """启动命令。billing server 用 bootstrap 脚本（修只读盘 sessions 问题）；其余优先 console
    script，找不到回退 `python -m <module>`。"""
    import sys
    if module == "awslabs.billing_cost_management_mcp_server.server":
        try:
            with open(_BILLING_BOOTSTRAP_PATH, "w", encoding="utf-8") as f:
                f.write(_BILLING_BOOTSTRAP_SRC)
            return [sys.executable, _BILLING_BOOTSTRAP_PATH]
        except Exception as e:  # noqa: BLE001 — 写不了就回退普通启动（至少 pricing 可用）
            logger.warning("finops_mcp: write billing bootstrap failed: %s", _safe_err(e))
            return [sys.executable, "-m", module]
    path = shutil.which(console_script)
    if path:
        return [path]
    return [sys.executable, "-m", module]


# 两个官方 server 的启动命令（console script 名 + 模块回退路径）。
_SERVERS = [
    ("awslabs.aws-pricing-mcp-server", "awslabs.aws_pricing_mcp_server.server"),
    ("awslabs.billing-cost-management-mcp-server", "awslabs.billing_cost_management_mcp_server.server"),
]


def get_tools(core_only: bool = False):
    """返回 FinOps 工具列表（供 main.py 挂进 agent）。

    - core_only=True（非 FinOps 主题）：只返回 _CORE_TOOLS（~7 个高频，省 token）。
    - core_only=False（FinOps 主题）：返回全部白名单（18 个，全功能）。

    子进程只启动一次（首次调用时），全量工具缓存；core/full 只是对缓存做过滤，
    不重启子进程。任何失败：记日志，返回已成功子集（可能为空），不抛 —— agent 照常运行。
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
            logger.warning("finops_mcp: cannot resolve command for %s", console_script)
            continue
        try:
            client = MCPClient(lambda c=cmd: stdio_client(
                StdioServerParameters(command=c[0], args=c[1:], env=env)))
            client.start()  # 常驻；不进入 with（生命周期 = 容器）
            _clients.append(client)
            tools = client.list_tools_sync()
            kept = [t for t in tools if t.tool_name in _WHITELIST]
            logger.info("finops_mcp: %s → %d/%d tools kept (whitelist)",
                        console_script, len(kept), len(tools))
            merged.extend(kept)
        except Exception as e:  # noqa: BLE001 — 单个 server 起不来不影响另一个/整体
            # Security: WARNING 只记异常类型（不含 traceback/原始消息，可能含 payload）；
            # 完整 traceback + 子进程 stderr 仅在 DEBUG 下输出，供本地排障。见 docs/LOGGING_STANDARD.md。
            logger.warning("finops_mcp: failed to start %s: %s", console_script, _safe_err(e))
            if logger.isEnabledFor(logging.DEBUG):
                import traceback as _tb
                logger.debug("finops_mcp: %s start traceback:\n%s", console_script, _tb.format_exc())
                # 诊断：直接 spawn server 进程、抓它的 stderr（MCPClient 后台线程吞掉了真实报错）。
                try:
                    import subprocess as _sp
                    p = _sp.run(cmd, input=b"", env=env, capture_output=True, timeout=20)  # nosec B603 - cmd is a fixed [sys.executable,'-m',<hardcoded module>] / console-script path from _resolve_cmd(); no shell, no user input  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
                    err = (p.stderr or b"").decode("utf-8", "replace")[-1500:]
                    logger.debug("finops_mcp: %s direct-spawn stderr tail:\n%s", console_script, err)
                except Exception as e2:  # noqa: BLE001
                    logger.debug("finops_mcp: %s direct-spawn diag failed: %s", console_script, _safe_err(e2))

    _tools_cache = merged
    logger.info("finops_mcp: total %d FinOps tools exposed", len(merged))
    return merged
