"""cost-agent MCP（CUR 行级明细查询）— 经 Lambda Function URL（SigV4）接入。

与 `finops_mcp.py`（awslabs CE 口径，本账号）互补：本模块的工具直查**客户 CUR 表**
（行级明细，多 payer 全量），能回答 CE 聚合答不了的问题——ODCR 利用率、SP 合同明细、
实例/vCPU/GPU 数量、Capacity Block、DX 端口带宽、EBS/S3 存储量、Bedrock token 等。

设计（对齐 core/aws_docs_mcp.py 的 HTTP-MCP 先例，不引新依赖）：
  - Lambda URL 是 **streamable-http MCP server**（stateless JSON）。每次调用 =
    SigV4 签名的 POST /mcp（initialize 一次性完成于首次调用，无会话状态）。
  - 凭证：容器执行角色（boto3 default chain），需要 `lambda:InvokeFunctionUrl`。
  - **两个元工具**而非 43 个逐一包装：`list_cost_tools`（目录+参数说明，LLM 选择用）、
    `call_cost_tool`（按名调用）。原因：43 个 schema 全量注入 ≈ 12K+ token 固定税；
    元工具模式只花 ~600 token，选择逻辑交给注入的路由 skill（可运营，改 skill 即生效）。
  - 失败安全（**绝不阻断整个工具**）：URL 未配置 / 权限缺失 / Lambda 挂了 / Athena 超时 →
    工具返回带**降级指令**的错误对象（见 _FALLBACK），agent 改用 CE 工具、再不行用
    call_aws / aws_readonly 兜底，并如实告诉用户「行级 CUR 明细此刻不可用、这是 CE 口径」。
    另有**熔断器**：连续 2 次传输层失败后 10 分钟内直接快速失败，不再每次干等 300s ——
    否则一个挂掉的 Lambda URL 能把每轮对话卡死 5 分钟（那才是真正的"整个工具被 block"）。

配置（环境变量，agentcore.json envVars 注入）：
  COST_AGENT_MCP_URL   Lambda Function URL（如 https://xxx.lambda-url.us-east-1.on.aws/）
  留空 = 本模块不挂载（get_tools() 返回空）。
  COST_AGENT_MCP_TIMEOUT / _INIT_TIMEOUT / _BREAK_SECONDS  可选，覆盖超时/熔断时长。
"""
from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

def _env(name: str, default: str = "") -> str:
    """读 env，并把**未被部署脚本替换的占位符**（形如 __FOO__）当成未设置。

    与 core/reports.py::_env、core/devops_agent.py 的 `_SPACE_ENV`、bff 的
    `envClean` / `envConfigured` 同一套判据。

    🔴 这不是防御性代码，它修的是一个会真实发生的形态：`agentcore.json` 里
       COST_AGENT_MCP_URL 出厂就是 `__COST_AGENT_MCP_URL__`，靠
       `scripts/deploy_agent.sh` 在部署时注入真值（本仓库已把这个键加进注入表；
       但手工部署 / 老脚本 / 只改 agentcore.json 不跑脚本时仍会带着字面占位符上线）。

    ⚠️ 漏注入的后果比「模块缺席」更坏，不是等价的：`__COST_AGENT_MCP_URL__` 是
       **真值**（truthy），骗过下面 `if not _URL` 的空值保护 → `list_cost_tools` /
       `call_cost_tool` 两个元工具照常挂上 agent，而它们的 docstring 明确写着行级
       成本问题要「Call this FIRST」。模型于是优先调它，每次都打到
       `__COST_AGENT_MCP_URL__/mcp` 上失败 —— 表现是成本问题答不出来、理由还看不懂
       （LLM 也要为此付一轮 token），而不是干脆地回退到 CE 工具。
    """
    v = (os.environ.get(name) or default).strip()
    if v.startswith("__") and v.endswith("__"):
        return ""
    return v


_URL = _env("COST_AGENT_MCP_URL").rstrip("/")
_REGION = os.environ.get("AWS_REGION") or "us-east-1"
_TIMEOUT = int(os.environ.get("COST_AGENT_MCP_TIMEOUT", "300"))
# initialize / tools-list 是纯控制面调用（不跑 Athena），没有理由等 300s。
# 单独设短超时：数据源挂了时第一轮就快速失败并降级，而不是把对话卡满 5 分钟。
_INIT_TIMEOUT = int(os.environ.get("COST_AGENT_MCP_INIT_TIMEOUT", "30"))
# 熔断：连续 _FAIL_THRESHOLD 次传输层失败 → 打开 _BREAK_SECONDS 秒，期间直接快速失败。
_BREAK_SECONDS = int(os.environ.get("COST_AGENT_MCP_BREAK_SECONDS", "600"))
_FAIL_THRESHOLD = 2

_initialized = False
_tool_catalog: list[dict] | None = None
_fail_streak = 0
_broken_until = 0.0

# 降级链（用户明确要求：CUR 出问题不许阻断整个工具）。这段话跟着**每一个**错误返回给
# LLM —— 因为工具返回值是模型唯一必然读到的地方（系统提示可能被长历史挤压/被 skill 覆盖）。
# 三层：客户 CUR（行级、多 payer）→ CE 官方成本工具（聚合、部署账号）→ call_aws/aws_readonly
# （任意只读 AWS API）。同时要求**说清口径变了**：静默换数据源比报错更危险（数字对不上账单）。
_FALLBACK = (
    "FALL BACK, do not give up: customer-CUR (line-item) data is unavailable right now. "
    "(1) Retry the question with the CE cost tools (cost-explorer / cost-optimization / "
    "cost-anomaly / get_pricing) for aggregate numbers; (2) if CE cannot answer it, use "
    "call_aws (or aws_readonly for a member account) to read the facts directly, read-only. "
    "Then answer with whatever you could get, and state plainly in the user's language that "
    "line-item CUR detail was unavailable, which source you used instead, and that the "
    "numbers are therefore aggregate/deployment-account scope and may not reconcile with the "
    "invoice. Never present CE numbers as CUR line-item numbers, and never invent numbers."
)


def _safe_err(e: Exception) -> str:
    resp = getattr(e, "response", None)
    code = (resp or {}).get("Error", {}).get("Code") if isinstance(resp, dict) else None
    return f"{e.__class__.__name__}/{code or getattr(e, 'code', '') or 'unknown'}"


def _breaker_open() -> bool:
    return time.monotonic() < _broken_until


def _note_failure() -> None:
    """传输层失败计数；连续 _FAIL_THRESHOLD 次就开熔断（只记异常类型，不记 payload）。"""
    global _fail_streak, _broken_until
    _fail_streak += 1
    if _fail_streak >= _FAIL_THRESHOLD and not _breaker_open():
        _broken_until = time.monotonic() + _BREAK_SECONDS
        logger.warning("cost_agent_mcp: breaker OPEN for %ds after %d failures",
                       _BREAK_SECONDS, _fail_streak)


def _note_success() -> None:
    global _fail_streak
    _fail_streak = 0


def _unavailable(detail: str) -> str:
    """统一的"不可用"返回：错误事实 + 降级指令（给 LLM 看，不面向终端用户直出）。"""
    return json.dumps({"error": detail, "fallback": _FALLBACK}, ensure_ascii=False)


def _sigv4_post(payload: dict, timeout: int | None = None) -> dict:
    """SigV4 签名 POST 到 Lambda URL 的 /mcp，解析 SSE/JSON 响应。"""
    import boto3
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    creds = boto3.Session().get_credentials().get_frozen_credentials()
    url = _URL + "/mcp"
    body = json.dumps(payload)
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    req = AWSRequest(method="POST", url=url, data=body, headers=headers)
    SigV4Auth(creds, "lambda", _REGION).add_auth(req)
    r = urllib.request.Request(url, data=body.encode(), headers=dict(req.headers), method="POST")
    with urllib.request.urlopen(r, timeout=timeout or _TIMEOUT) as resp:  # nosec B310 - fixed https URL from deploy config
        raw = resp.read().decode()
    for line in raw.splitlines():
        if line.startswith("data:"):
            return json.loads(line[5:].strip())
    return json.loads(raw) if raw.strip() else {}


def _ensure_init() -> None:
    global _initialized
    if _initialized:
        return
    _sigv4_post({
        "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                   "clientInfo": {"name": "notiops-agent", "version": "1.0"}},
    }, timeout=_INIT_TIMEOUT)
    _initialized = True


def _load_catalog() -> list[dict]:
    global _tool_catalog
    if _tool_catalog is not None:
        return _tool_catalog
    _ensure_init()
    r = _sigv4_post({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, timeout=_INIT_TIMEOUT)
    tools = r.get("result", {}).get("tools", [])
    _tool_catalog = [
        {"name": t["name"], "description": t.get("description", ""),
         "params": list((t.get("inputSchema") or {}).get("properties", {}).keys())}
        for t in tools
    ]
    logger.info("cost_agent_mcp: catalog loaded, %d tools", len(_tool_catalog))
    return _tool_catalog


def get_tools():
    """供 main.py 挂进 agent。URL 未配置 → 空列表（模块缺席，agent 照常跑）。"""
    if not _URL:
        logger.info("cost_agent_mcp: COST_AGENT_MCP_URL not set — module disabled")
        return []
    try:
        from strands import tool
    except ImportError:
        logger.warning("cost_agent_mcp: strands not available")
        return []

    @tool
    def list_cost_tools() -> str:
        """List the CUR (billing line-item) cost analysis tools. Call this FIRST when
        the question needs LINE-ITEM depth or billing-exact numbers — per-contract
        SP/RI details, utilization & waste (incl. vCPU), ODCR utilization, instance/
        vCPU/GPU counts, Capacity Blocks, DX ports/bandwidth, EBS/S3 storage volume,
        Bedrock tokens, credits, extended support, EDP, tag/LOB splits, MoM attribution,
        or any number that must reconcile with the invoice. Use CE tools instead for:
        optimization recommendations, rightsizing, budgets, pricing lookups, or quick
        aggregate trends of THIS deployment account. Note: these CUR tools query the
        CUR table configured in the backend (may be a customer's multi-payer table —
        answers are independent of the chat's account context); CE tools only see the
        deployment account. Returns tool names + params; then call_cost_tool.
        If this returns an "error"/"fallback" field, the CUR source is down — follow the
        fallback: answer via the CE tools, then call_aws, and say the source changed."""
        if _breaker_open():
            return _unavailable("customer-CUR source is temporarily marked unavailable "
                                "(recent failures); not retried on this turn")
        try:
            cat = _load_catalog()
            _note_success()
            return json.dumps({
                "usage_note": (
                    "CUR data for the last ~3 days is INCOMPLETE. For any 'last N days / recent' "
                    "question, set date_to = today-3 and date_from = today-(N+3) (e.g. last 7 days "
                    "= today-10 .. today-3), and tell the user the window used. Monthly questions "
                    "about the CURRENT month: mention the month is still partial."
                ),
                "tools": cat,
            }, ensure_ascii=False)
        except Exception as e:  # noqa: BLE001
            logger.warning("cost_agent_mcp: list failed: %s", _safe_err(e))
            _note_failure()
            return _unavailable(f"cost-agent MCP unreachable ({_safe_err(e)})")

    @tool
    def call_cost_tool(tool_name: str, arguments_json: str = "{}") -> str:
        """Invoke one customer-CUR cost tool by name (see list_cost_tools for the
        catalog). arguments_json: JSON object string of the tool's parameters, e.g.
        '{"month": "2026-07", "top_n": 5}'. Returns the tool's JSON result — numbers
        are SQL-computed server-side; do NOT recompute or aggregate them yourself.
        If this returns an "error"/"fallback" field, do NOT tell the user the question
        cannot be answered — follow the fallback chain (CE tools, then call_aws) and say
        which source you ended up using."""
        try:
            args = json.loads(arguments_json or "{}")
        except Exception:
            return json.dumps({"error": "arguments_json is not valid JSON"})
        if _breaker_open():
            return _unavailable("customer-CUR source is temporarily marked unavailable "
                                "(recent failures); not retried on this turn")
        try:
            _ensure_init()
            r = _sigv4_post({"jsonrpc": "2.0", "id": 2, "method": "tools/call",
                             "params": {"name": tool_name, "arguments": args}})
            _note_success()   # 传输层通了（哪怕这个工具自身报逻辑错），不该计入熔断
            if "error" in r:
                # 单个工具的逻辑错（参数不对/该 CUR 表没这列…）：数据源是活的，
                # 让 LLM 先改参数重试；实在不行再按 fallback 换 CE/call_aws。
                return json.dumps({"error": r["error"].get("message", "tool error"),
                                   "hint": "fix the arguments and retry once; if it still "
                                           "fails, " + _FALLBACK}, ensure_ascii=False)
            content = r.get("result", {}).get("content", [])
            text = "".join(c.get("text", "") for c in content if isinstance(c, dict))
            return text or json.dumps(r.get("result", {}), ensure_ascii=False)
        except urllib.error.HTTPError as e:
            logger.warning("cost_agent_mcp: call %s HTTP %s", tool_name, e.code)
            # 403 = IAM 没配到（缺 lambda:InvokeFunctionUrl / 资源策略），5xx/超时 = 后端挂了。
            # 两者都属"数据源不可用"，都走降级链，不把用户卡在这里。
            _note_failure()
            return _unavailable(f"HTTP {e.code} calling {tool_name}")
        except Exception as e:  # noqa: BLE001
            logger.warning("cost_agent_mcp: call %s failed: %s", tool_name, _safe_err(e))
            _note_failure()
            return _unavailable(f"{tool_name} failed ({_safe_err(e)})")

    return [list_cost_tools, call_cost_tool]
