"""
**全局最终兜底** MCP via 官方 awslabs **aws-api-mcp-server**（进程内 stdio 子进程）。

定位：这是**整个 agent 所有功能的最后兜底**——不只是"成本/调查/巡检"某一类。我们的精选
只读 MCP（FinOps / Investigation / 资源巡检 / Cases）是高频"快车道"、有业务解读；当**任何**
专用工具都覆盖不到、但用户请求本质是一次 AWS 上的**只读**操作时，由它接住，让我们"基本能
回答客户所有云上问题"。优先专用工具，它是 last-resort。

工具（只挂 2 个）：
  · call_aws            —— 执行任意 AWS CLI 命令（受只读约束）
  · suggest_aws_commands —— 自然语言 → 最可能的若干条 CLI（帮模型选对命令）
  （不开实验性 get_execution_plan / run_script。）

**严格只读 —— 三重防线（纵深防御）**：
  1) READ_OPERATIONS_ONLY=true：MCP 层只放行只读 allowlist 命令；
  2) runtime 执行角色挂 AWS 托管 ReadOnlyAccess：IAM 硬天花板，即使 1) 有缝也写不了；
  3) 自定义 denyList 兜底拦危险动作。
  （写操作即使模型想调，也会在 1)/2) 被拒——把拒绝信息原样转达用户。）

架构：复刻 finops_mcp / investigation_mcp —— Strands MCPClient(stdio_client(...))，
模块级单例、首次用时 start 一次、常驻复用；失败安全（起不来返回空工具列表，agent 照常跑）。

**只读盘适配**（AgentCore runtime 除 /tmp 外只读，已知坑，同 finops_mcp）：
  · HOME=/tmp           —— server 默认把日志写 ~/.aws/aws-api-mcp/...log；
  · AWS_API_MCP_WORKING_DIR=/tmp/...  —— 工作目录；
  · TMPDIR=/tmp；AWS_API_MCP_TELEMETRY=false（不外发 telemetry）。
"""
from __future__ import annotations

import json
import logging
import os
import shutil

logger = logging.getLogger(__name__)

# 只挂这两个：通用执行 + 命令建议。get_execution_plan 是实验性、不挂。
_WHITELIST = {
    "call_aws",
    "suggest_aws_commands",
}

_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
# 可用 env 一键关掉（出问题快速回退到无兜底，不必改代码重部署）。
_DISABLED = os.environ.get("NOTIOPS_DISABLE_AWS_API_MCP", "").strip().lower() in ("1", "true")

# ── call_aws 结果体积上限（防 token 爆炸的根治）──
# 背景：call_aws 是全局兜底、可查任意 API，结果**没有体积上限**。无过滤的全量查询
# （如不带实例 ID 扫 CloudTrail、列几百个资源）能返回几十 K token 的原始 JSON；而 agentic
# loop **每个 cycle 都把完整上下文（含所有历史工具结果）重发计费** → 一条这样的查询叠加
# 多次调用能烧掉 100 万+ token（实测："那台机器是谁启动的" 4×lookup_events → 1.17M）。
# 修法：单条工具结果超过上限就**保留首尾、中间截断 + 提示模型缩小范围**。
# 上限推导：最小模型窗口 163840(DeepSeek V3.2)；固定开销(schema+prompt+历史)~60K，
# 留给工具结果~100K；按最坏一轮 8 次调用都满额不爆 → 100K/8≈12.5K token/条 ≈ 50KB。
# 取 40000 字符(~10K token)更稳，且对绝大多数只读查询够用。env 可调。
try:
    _MAX_RESULT_CHARS = int(os.environ.get("NOTIOPS_AWS_API_MAX_CHARS", "40000"))
except ValueError:
    _MAX_RESULT_CHARS = 40000
_HEAD_FRAC = 0.7   # 截断时保留：前 70% + 后 30%（开头有结构，结尾常有 nextToken/汇总）


def _slim_events_obj(obj):
    """把一个含 CloudTrail 事件列表的对象投影成轻量结构。返回 (新对象, 是否改过)。
    兼容两种形态：call_aws/CLI 的 `Events`（大写）、cloudtrail-mcp 的 `events`（小写）。
    判据：该 key 是 list 且元素含 `CloudTrailEvent` 巨块。"""
    if not isinstance(obj, dict):
        return obj, False
    key = next((k for k in ("Events", "events")
                if isinstance(obj.get(k), list)
                and any(isinstance(e, dict) and "CloudTrailEvent" in e for e in obj[k])), None)
    if key is None:
        return obj, False
    slim_events = []
    for e in obj[key]:
        if not isinstance(e, dict):
            continue
        out = {k: e.get(k) for k in ("EventTime", "EventName", "Username",
                                     "EventSource", "Resources") if e.get(k) is not None}
        raw = e.get("CloudTrailEvent")  # 巨块：完整原始事件 JSON 字符串
        if isinstance(raw, str):
            try:
                inner = json.loads(raw)
                if inner.get("sourceIPAddress"):
                    out["sourceIPAddress"] = inner["sourceIPAddress"]
                ui = inner.get("userIdentity") or {}
                if isinstance(ui, dict) and ui.get("arn"):
                    out["actorArn"] = ui["arn"]
                if inner.get("errorCode"):
                    out["errorCode"] = inner["errorCode"]
            except (ValueError, TypeError):
                pass
        slim_events.append(out)
    new = dict(obj)
    new[key] = slim_events
    new["_note"] = ("已为节省上下文做字段投影：每条事件仅保留 时间/事件名/操作者/来源IP/资源等关键字段，"
                    "省略了完整 requestParameters/responseElements。如需某条完整原始详情，按 EventId 单独查询。")
    return new, True


def _slim_cloudtrail(s: str) -> str:
    """方案 B：CloudTrail `lookup-events` 结果**字段投影**收敛。

    每个 Event 含一个巨大的 `CloudTrailEvent` 原始 JSON 字符串（含完整 requestParameters /
    responseElements，单条可达数 KB；RunInstances 尤甚）。排查"谁/何时/从哪/对什么资源做了
    什么"只要少数关键字段。把每个 event 投影成轻量结构、扔掉巨块，**从源头**把结果缩小一个数量级。

    注意：call_aws 把 CLI 输出**多层嵌套**——真实 JSON 在 `response.response.json`（一个
    **再次被 JSON 序列化的字符串**），故这里递归地在任意层找 `Events` 并就地替换，包括嵌在
    字符串里的 JSON。仅当确实含 CloudTrailEvent 时才动；其它原样返回（不误伤）。失败安全。
    """
    if not isinstance(s, str) or "CloudTrailEvent" not in s:
        return s

    def _walk(node):
        """递归：dict/list 原地下钻；遇到「内含 CloudTrailEvent 的 JSON 字符串」就解析→投影→重序列化。
        返回 (新节点, 是否改过)。"""
        changed = False
        if isinstance(node, dict):
            node, did = _slim_events_obj(node)
            changed = changed or did
            for k, v in list(node.items()):
                nv, d = _walk(v)
                if d:
                    node[k] = nv
                    changed = True
            return node, changed
        if isinstance(node, list):
            for i, v in enumerate(node):
                nv, d = _walk(v)
                if d:
                    node[i] = nv
                    changed = True
            return node, changed
        if isinstance(node, str) and "CloudTrailEvent" in node:
            # 可能是被再次序列化的 JSON 字符串（call_aws 的 response.json 即如此）
            try:
                parsed = json.loads(node)
            except (ValueError, TypeError):
                return node, False
            nv, d = _walk(parsed)
            if d:
                return json.dumps(nv, ensure_ascii=False, default=str), True
            return node, False
        return node, False

    try:
        data = json.loads(s)
    except (ValueError, TypeError):
        return s
    new, changed = _walk(data)
    if not changed:
        return s
    return json.dumps(new, ensure_ascii=False, default=str)


def _truncate_text(s: str) -> str:
    """单条结果文本过大 → 保留首尾、中间用提示替代。否则原样返回。
    先做 CloudTrail 字段投影（B），再做通用体积上限兜底。"""
    s = _slim_cloudtrail(s)
    if not isinstance(s, str) or len(s) <= _MAX_RESULT_CHARS:
        return s
    keep = _MAX_RESULT_CHARS
    head_n = int(keep * _HEAD_FRAC)
    tail_n = keep - head_n
    note = (f"\n\n…[结果过大，已截断：原始 {len(s)} 字符，仅保留首 {head_n} + 尾 {tail_n}。"
            f"请缩小查询范围：加资源 ID / 时间窗 / --max-items / --query 投影，再重查。]…\n\n")
    return s[:head_n] + note + s[-tail_n:]

_clients = []        # 常驻 MCPClient 单例
_tools_cache = None  # 白名单工具列表（缓存）

# 官方包：console script 名 + 模块回退路径。
_SERVER = ("awslabs.aws-api-mcp-server", "awslabs.aws_api_mcp_server.server")

_WORKDIR = "/tmp/aws-api-mcp-workdir"


def _server_env() -> dict:
    env = dict(os.environ)
    env.setdefault("AWS_REGION", _REGION)
    env.setdefault("AWS_DEFAULT_REGION", _REGION)
    # ── 只读铁律（防线 1）──
    env["READ_OPERATIONS_ONLY"] = "true"
    # 不需要交互式 mutation consent（只读模式下本就拒写；保持默认 false 即可）。
    env.setdefault("REQUIRE_MUTATION_CONSENT", "false")
    # 不开实验脚本能力。
    env["EXPERIMENTAL_AGENT_SCRIPTS"] = "false"
    # ── 只读盘适配（AgentCore 除 /tmp 外只读）──
    env["HOME"] = "/tmp"                      # 日志默认写 ~/.aws/aws-api-mcp/...log
    env["TMPDIR"] = "/tmp"
    try:
        os.makedirs(_WORKDIR, exist_ok=True)
    except Exception:  # noqa: BLE001
        pass
    env["AWS_API_MCP_WORKING_DIR"] = _WORKDIR
    # 不外发 telemetry。
    env["AWS_API_MCP_TELEMETRY"] = "false"
    # 降日志噪声。
    env["FASTMCP_LOG_LEVEL"] = "ERROR"
    env["FASTMCP_DISABLE_BANNER"] = "1"
    env["PYTHONWARNINGS"] = "ignore"
    return env


def _resolve_cmd() -> list[str]:
    """启动命令：优先 console script，找不到回退 `python -m <module>`。"""
    import sys
    console_script, module = _SERVER
    path = shutil.which(console_script)
    if path:
        return [path]
    return [sys.executable, "-m", module]


def _wrap_capped(tool):
    """把 MCP 工具包一层：在结果回给模型前，对每个 text 块做体积上限截断。
    在工具的 stream() 拦截 ToolResultEvent，改写其 content 里的 text。失败安全：
    包装出错就返回原工具（不阻断）。"""
    try:
        from strands.tools.mcp.mcp_agent_tool import MCPAgentTool
    except Exception:  # noqa: BLE001 — 拿不到基类就不包，原样返回
        return tool

    class _CappedTool(type(tool)):  # 继承实际类（MCPAgentTool 子类），复用其全部行为
        async def stream(self, tool_use, invocation_state, **kwargs):
            async for event in super().stream(tool_use, invocation_state, **kwargs):
                try:
                    # ToolResultEvent 是 dict 子类：{"type":"tool_result","tool_result":<ToolResult>}
                    res = event.get("tool_result") if hasattr(event, "get") else None
                    if isinstance(res, dict) and isinstance(res.get("content"), list):
                        for block in res["content"]:
                            if isinstance(block, dict) and isinstance(block.get("text"), str):
                                block["text"] = _truncate_text(block["text"])
                except Exception as e:  # noqa: BLE001 — 截断失败不影响结果传递
                    logger.warning("aws_api_mcp: truncate failed: %s", e)
                yield event

    # 用同样的构造参数重建为 _CappedTool（保留 mcp_tool / client / name / timeout）
    try:
        return _CappedTool(tool.mcp_tool, tool.mcp_client,
                           name_override=tool.tool_name, timeout=getattr(tool, "timeout", None))
    except Exception as e:  # noqa: BLE001
        logger.warning("aws_api_mcp: wrap failed (%s), using raw tool", e)
        return tool


def get_tools():
    """返回兜底工具列表（call_aws + suggest_aws_commands），供 main.py 全主题挂载。
    子进程只启动一次（首次调用时）并缓存。任何失败：记日志、返回空，不抛 —— agent 照常运行。"""
    if _DISABLED:
        return []
    global _tools_cache
    if _tools_cache is not None:
        return _tools_cache

    from mcp import StdioServerParameters
    from mcp.client.stdio import stdio_client
    from strands.tools.mcp import MCPClient

    env = _server_env()
    cmd = _resolve_cmd()
    merged = []
    try:
        client = MCPClient(lambda: stdio_client(
            StdioServerParameters(command=cmd[0], args=cmd[1:], env=env)))
        client.start()  # 常驻；生命周期 = 容器
        _clients.append(client)
        tools = client.list_tools_sync()
        kept = [t for t in tools if t.tool_name in _WHITELIST]
        merged = [_wrap_capped(t) for t in kept]
        logger.info("aws_api_mcp: %d/%d tools kept (whitelist, result cap=%d chars)",
                    len(merged), len(tools), _MAX_RESULT_CHARS)
    except Exception as e:  # noqa: BLE001 — 起不来不阻断 agent
        import traceback as _tb
        logger.warning("aws_api_mcp: failed to start: %s\n%s", e, _tb.format_exc())
        # 诊断：直接 spawn 抓 stderr（MCPClient 后台线程会吞掉真实报错）。
        try:
            import subprocess as _sp
            p = _sp.run(cmd, input=b"", env=env, capture_output=True, timeout=25)  # nosec B603 - cmd is a fixed [sys.executable,'-m',<hardcoded module>] / console-script path from _resolve_cmd(); no shell, no user input  # nosemgrep: python.lang.security.audit.dangerous-subprocess-use-audit
            err = (p.stderr or b"").decode("utf-8", "replace")[-1500:]
            logger.warning("aws_api_mcp: direct-spawn stderr tail:\n%s", err)
        except Exception as e2:  # noqa: BLE001
            logger.warning("aws_api_mcp: direct-spawn diag failed: %s", e2)

    _tools_cache = merged
    return merged
