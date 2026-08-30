"""MCP 工具**规格快照** —— 把「把工具挂上去」和「把子进程拉起来」解耦。

## 为什么需要它

AgentCore Runtime 按 session 隔离：`runtimeSessionId` 变了就是一个新 microVM，也就是
**每开一个新会话都是一次真冷启动**。而构造 Agent 之前必须先拿到工具的 schema，今天拿
schema 的唯一办法是把 5 个 awslabs stdio server 全部拉起来再 `list_tools`：

    pricing 4.6s · billing 5.4s · cloudwatch 9.3s · cloudtrail 2.8s · aws-api 7.2s
    （现网实测。cloudwatch 慢是因为它启动时要拉 1100+ 条 metric 元数据。）

分组并行（P0-B）之后仍然要等最慢那个 ≈ 9.3s，而这 9.3s **整段落在用户看到第一个字
之前** —— 实测现网首字中位数 23.4s，且 ttfb == ttft，首字之前一个字都没有。

关键观察：**挂载工具并不需要活着的子进程**。`MCPAgentTool.tool_spec` 只读 `mcp_tool`
这个 pydantic 模型的几个字段（name / description / inputSchema / outputSchema，
1.53+ 还有 annotations）；`mcp_client` 在整个 strands 包里只被用到一处 ——
`stream()` 里的 `await self.mcp_client.call_tool_async(...)`。也就是说只要**手里有
schema**，就能先把工具挂上、把子进程推到真正要用的时候再起。

## 做法

  1. **快照**：每个 server 的 `list_tools()` 原始返回（`mcp.types.Tool`）按**原顺序**
     存成数组，落 S3（复用 `SKILLS_BUCKET`，前缀 `mcp-snapshots/`）。
  2. **键含版本指纹**：`mcp-snapshots/v1/<sha256(包版本清单)>/<group>.json`。任何一个
     相关包版本变了 → 键就变 → 自动 cache miss → 走同步路径重建。**刻意不读
     pyproject / uv.lock**：`agentcore deploy` 跑的是 `uv pip install -r pyproject.toml`
     （不读 lock），依赖写的是区间约束，实际装到哪个版本只有运行时的
     `importlib.metadata` 知道。把指纹绑在构建期文件上 = 迟早对不上 = 永久静默走慢路径。
  3. **一个 group 一个对象**（不是一个大对象装三组）：三组并行读写，各自独立成功/失败，
     不存在 read-modify-write 互相覆盖。
  4. **快路径**：一次 GetObject → `Tool(**dump)` 重建 → 包成 `LazyMCPTool`。**不起子进程**。
  5. **预热**：`warm_now()` 起后台线程，把所有懒客户端并行 `ensure_sync()`，让那 9.3s
     与「模型出字 + 用户读字」重叠。预热走的就是懒路径同一段代码、同一把锁 ——
     「预热中途来了真调用」天然变成在同一把锁上等，不会起第二份子进程。
  6. **自愈 / 首次落盘**：同步路径成功后写快照；预热完成后再拿真 `list_tools` 与快照
     比对，不一致就重写。所以快照永远是**这个账号里实际部署的那些 server 自己写的**，
     两条部署路径（一键 CFN / setup.sh）行为一致，不需要构建期步骤，也不用人手刷新。
  7. **兜底**：读不到 / 没有 / 被关掉 / 任何异常 → **完全回到今天的同步行为**（慢但对）。

## 明确不做的事

  · 不改工具**顺序**。tools 会按列表顺序拼进 `toolConfig.tools`，而 cachePoint 在
    整段缓存前缀的最前面（`strands/models/bedrock.py`）—— 顺序抖一下就会让
    tools + system + 消息前缀整段 prompt cache 失效。快照按 server 存**有序数组**，
    拼接顺序与同步路径逐项相同。
  · 不在快照里存**过滤后**的工具：存的是原始 `list_tools` 输出，白名单改动因此立刻
    生效，不必参与指纹。
  · 不在这里做过滤/包装：两条路最后都走各模块自己的 `_post()`，保证 lazy 与同步
    产出的工具**行为完全一致**。否则会出现「只有走快路径时才少一层 denylist」
    这种最难查的分叉。
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import threading

logger = logging.getLogger(__name__)


def _safe_err(e: Exception) -> str:
    """Sensitive-data handling: return the exception *type* (plus the AWS error code
    for botocore ClientError), never the raw message / response body — those can embed
    request payloads or user data. See docs/LOGGING_STANDARD.md."""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


# ── 开关 ──────────────────────────────────────────────────────────────────────
# 出问题一键回到今天的同步行为，不用改代码重部署。
# **刻意只在 Python 侧读、不注入任何 runtime env**：一键 CFN 与 setup.sh 两条路径的
# env key 集合由 scripts/test_oneclick_parity.py 逐 key 比对，多一个 env 就多一处
# 必须两边同时改的对等面。用「默认开 + 读不到就是开」把这块对等面降到零。
_DISABLED = os.environ.get("NOTIOPS_DISABLE_LAZY_MCP", "").strip().lower() in ("1", "true")

_FORMAT = 1
_PREFIX = "mcp-snapshots/v1"

# 指纹必须覆盖的包。除了 5 个 awslabs server（它们决定工具本身），还必须有：
#   · mcp            —— `Tool` 这个 pydantic 模型由它定义，序列化/重建的形状归它管；
#   · strands-agents —— `MCPAgentTool.tool_spec` 由它决定（1.53 起才转发 annotations）。
# 这两个也是区间约束、也会漂；漏了它们就会出现「快照读得到、但重建出的 spec 与当前
# SDK 不一致」——一种不会报错的错。
_FINGERPRINT_PKGS = (
    "awslabs.aws-api-mcp-server",
    "awslabs.aws-pricing-mcp-server",
    "awslabs.billing-cost-management-mcp-server",
    "awslabs.cloudtrail-mcp-server",
    "awslabs.cloudwatch-mcp-server",
    "mcp",
    "strands-agents",
)


def _env(name: str) -> str:
    """读 env，并把**没被部署脚本替换掉的占位符**（`__FOO__`）当成空。
    占位符是非空字符串，会骗过 `if not _BUCKET` 的空值保护，让代码拿着假桶名去调 S3。
    与 core/reports.py / core/skills.py 的 `_env` 同语义。"""
    v = os.environ.get(name, "").strip()
    if v.startswith("__") and v.endswith("__"):
        return ""
    return v


_BUCKET = _env("SKILLS_BUCKET")   # 与 skills / reports 复用同一个共享数据桶


def enabled() -> bool:
    """快照机制是否可用。拿不到桶名 = 不可用（首次 setup.sh 时 agent 可能先于后端栈部署）。"""
    return not _DISABLED and bool(_BUCKET)


# ── 版本指纹 ──────────────────────────────────────────────────────────────────
_fp_cache: str | None = None
_fp_lock = threading.Lock()


def _version_of(pkg: str) -> str:
    try:
        from importlib.metadata import version as _v
        return _v(pkg)
    except Exception:  # noqa: BLE001 — 查不到就记成 ?，指纹照样稳定
        return "?"


def packages() -> dict:
    """指纹涉及的包 → 实际装上的版本。写进快照，纯为了出问题时能看懂。"""
    return {pkg: _version_of(pkg) for pkg in _FINGERPRINT_PKGS}


def fingerprint() -> str:
    """相关包版本的稳定指纹。用 `importlib.metadata` 读**真正装上的**版本。"""
    global _fp_cache
    if _fp_cache is not None:
        return _fp_cache
    with _fp_lock:
        if _fp_cache is not None:
            return _fp_cache
        # _FINGERPRINT_PKGS 本身按字母序写死，顺序稳定，不依赖 dict/set 迭代顺序。
        parts = [f"{pkg}=={_version_of(pkg)}" for pkg in _FINGERPRINT_PKGS]
        _fp_cache = hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:32]
        logger.info("mcp_snapshot: fingerprint %s", _fp_cache)
        return _fp_cache


def _key(group: str) -> str:
    return f"{_PREFIX}/{fingerprint()}/{group}.json"


# ── S3 ────────────────────────────────────────────────────────────────────────
_s3_client = None
_s3_lock = threading.Lock()


def _s3():
    """快照专用 S3 client。

    超时刻意收得很紧：这次 GetObject 就在**首字延迟的关键路径上**。S3 慢或抽风时宁可
    当 cache miss 去走同步路径，也绝不能让"优化冷启动"的代码自己给冷启动加秒数。
    """
    global _s3_client
    if _s3_client is not None:
        return _s3_client
    with _s3_lock:
        if _s3_client is not None:
            return _s3_client
        import boto3
        from botocore.config import Config
        _s3_client = boto3.client("s3", config=Config(
            connect_timeout=2, read_timeout=3, retries={"max_attempts": 1}))
        return _s3_client


# ── 序列化 ────────────────────────────────────────────────────────────────────
def _dump_tool(tool) -> dict:
    """把一个 `mcp.types.Tool` 序列化成可 JSON、且能**无损重建**的 dict。

    `by_alias=True` 不是风格选择，是必须的：`Tool.meta` 声明成 `Field(alias="_meta")`，
    而 `Tool` 没开 `populate_by_name`、却开了 `extra="allow"`。所以裸 `model_dump()`
    吐出的键是 `"meta"`，`Tool(**dump)` 会把它**静默塞进 `__pydantic_extra__`**、
    `.meta` 变成 None —— 不报错、不告警，而且重新 dump 出来字节还一样，连自愈比对
    都发现不了。
    `exclude_none=True` 只作用于 Tool / ToolAnnotations 的顶层字段（默认值都是 None，
    重建时自动补回），**不会**递归进 `inputSchema` 这种 `dict[str, Any]` —— 已实测
    schema 里合法的 `{"default": None}` 原样保留。不要换成 exclude_unset /
    exclude_defaults：那两个会连真实赋过的值一起丢。
    """
    return tool.model_dump(mode="json", by_alias=True, exclude_none=True)


def _rebuild_tool(dump: dict):
    """从快照里的一条 dump 重建 `mcp.types.Tool`。

    `deepcopy` 不是防御性编程，是**必须**的：`inputSchema` 是 `dict[str, Any]`，pydantic
    原样持有传进来的那个 dict 对象；而 `dump` 来自 `_group_cache` 里那份 doc。挂载时
    strands 的 `ToolRegistry.validate_tool_spec()` 会**就地改**这个 schema（
    `strands/tools/registry.py`：属性缺 description 就写 `"Property <name>"`，缺 type
    就写 `"string"`，顶层缺 properties/required 就补空）。不拷的话那些合成字段会写回我们
    缓存的快照 doc 里 —— 现网实测：`get_metric_data` 的 `properties.dimensions` 被塞了
    `"description": "Property dimensions"`，于是预热回校拿"被污染的快照"对"干净的实况"，
    每个会话都判不一致、白重写一份 112 KB（S3 上那份没变，因为写的是实况）。
    更该防的是下一步：任何从 doc 侧取工具去 `save()` 的改动，都会把这些合成字段变成全账号
    共享的权威快照内容。
    """
    from mcp.types import Tool
    return Tool(**copy.deepcopy(dump))


# ── 快照读 ────────────────────────────────────────────────────────────────────
_group_cache: dict[str, dict | None] = {}
_group_lock = threading.Lock()


def _load_group_doc(group: str) -> dict | None:
    """读某个 group 的快照对象（每个 group 在容器生命周期里只读一次，成功失败都记住）。

    任何异常都当 cache miss：桶可能还不存在（首次 setup.sh 时 agent 先于
    NotiOpsBackendStack 部署）、键可能不存在（版本刚变 / 第一次跑）、也可能是客户把
    ReadOnlyAccess 关了导致 AccessDenied。这些都只该退化成"这次慢一点"，不该报错。
    """
    if group in _group_cache:
        return _group_cache[group]
    with _group_lock:
        if group in _group_cache:
            return _group_cache[group]
        doc: dict | None = None
        try:
            body = _s3().get_object(Bucket=_BUCKET, Key=_key(group))["Body"].read()
            raw = json.loads(body.decode("utf-8"))
            if not isinstance(raw, dict) or raw.get("format") != _FORMAT:
                logger.warning("mcp_snapshot: %s unexpected format, ignoring", group)
            elif raw.get("fingerprint") != fingerprint():
                # 键里已经含指纹，正常到不了这里；到了说明有人手工放错了文件。
                logger.warning("mcp_snapshot: %s fingerprint mismatch inside object", group)
            else:
                doc = raw
        except Exception as e:  # noqa: BLE001 — 读不到就是 cache miss，走同步路径
            logger.info("mcp_snapshot: %s no usable snapshot (%s); starting servers inline",
                        group, _safe_err(e))
        _group_cache[group] = doc
        return doc


def snapshot_for(group: str) -> list[tuple[str, list]] | None:
    """取某 group 的快照并重建成 `[(server_key, [Tool, ...]), ...]`，**保持原顺序**。

    任何一条工具重建失败 → 整组放弃快路径。半成品挂载的表现是"模型看不到某个工具"
    （strands registry 对 spec 校验失败只记 WARNING 并把它从 toolConfig 里摘掉），
    比慢 9 秒难查得多。
    """
    if not enabled():
        return None
    doc = _load_group_doc(group)
    if not doc:
        return None
    entries = doc.get("servers")
    if not isinstance(entries, list) or not entries:
        return None
    out: list[tuple[str, list]] = []
    try:
        for ent in entries:
            key = str(ent["key"])
            tools = [_rebuild_tool(d) for d in ent["tools"]]
            if not tools:
                logger.warning("mcp_snapshot: %s/%s empty in snapshot", group, key)
                return None
            out.append((key, tools))
    except Exception as e:  # noqa: BLE001
        logger.warning("mcp_snapshot: %s rebuild failed: %s", group, _safe_err(e))
        return None
    return out


# ── 快照写 ────────────────────────────────────────────────────────────────────
def _body_for(group: str, per_server: list[tuple[str, list]]) -> bytes:
    return json.dumps({
        "format": _FORMAT,
        "fingerprint": fingerprint(),
        "packages": packages(),
        "group": group,
        "servers": [{"key": k, "tools": [_dump_tool(t) for t in tools]}
                    for k, tools in per_server],
    }, ensure_ascii=False, sort_keys=False).encode("utf-8")


def _counts(per_server: list[tuple[str, list]]) -> dict:
    return {k: len(tools) for k, tools in per_server}


def _raw_tools(per_server: list[tuple[str, list]]) -> list[tuple[str, list]]:
    """把 `[(key, [MCPAgentTool | Tool, ...])]` 归一成 `[(key, [Tool, ...])]`。

    调用方传的是刚 `list_tools_sync()` 出来的 `MCPAgentTool`（`.mcp_tool` 才是要存的
    `mcp.types.Tool`），预热回校那条路传的已经是裸 `Tool`。在这里统一剥，而**不是**让
    每个调用点自己写 `[t.mcp_tool for t in tools]`：那样的推导式会在 `enabled()` 闸门
    **之前**执行，于是关掉快照（或单测里塞替身工具）时也要求对象上必须有 `.mcp_tool`。
    """
    return [(k, [getattr(t, "mcp_tool", t) for t in tools]) for k, tools in per_server]


def save(group: str, per_server: list[tuple[str, list]], *, background: bool = True) -> None:
    """把某 group 的原始工具列表写回快照。

    `per_server` 收 `[(server_key, [该 server 的全部工具])]` —— 元素可以是
    `MCPAgentTool` 也可以是裸 `mcp.types.Tool`（见 `_raw_tools`）。

    两道**只收不缩**的闸门，都是为了防同一件事：把某个容器的一次偶发故障，升级成整个
    账号范围、跨会话持续的能力缺失。快照写坏了不会报错 —— 之后每个新会话都走"快路径
    成功"分支，少挂的那批工具没有任何告警，只有用户觉得"它以前会查 CloudWatch 的"。

      ① 有 server 一个工具都没拿到（= 没起来）→ 不写。
      ② 任何 server 的工具数比**已存在的快照**少 → 不写。
         这条专门挡预热回校那条路：容器 A 的 cloudwatch 偶发起不来，回校发现"实况与
         快照不一致"，若无脑重写就会把 A 的残缺状态盖到权威快照上。
         刻意**不设**per-server 硬编码下限：这些 server 的真实故障模式是"起不来 →
         空列表"（已被①挡住），而不是"起来了但少报工具"；凭空写死一个数字只会在
         上游正常增删工具时变成假警报。

    拒写时记 error（不是 info）：如果某个部署里某个 server 长期起不来，快路径在那里
    就永远是死代码 —— 那必须是一条能被看见的告警，而不是静默地一直慢。

    默认丢后台线程写：调用点在同步启动路径的末尾（本来就是最慢那条路），不该再给它
    叠一次 PutObject 往返。写失败/线程没跑完，最坏也只是"下次还慢"。
    """
    if not enabled():
        return
    if not per_server or any(not tools for _k, tools in per_server):
        logger.error("mcp_snapshot: %s has empty server(s) %s, refusing to save snapshot "
                     "(fast path stays disabled for this deployment until it starts cleanly)",
                     group, _counts(per_server))
        return
    try:
        per_server = _raw_tools(per_server)
    except Exception as e:  # noqa: BLE001 — 形状不对就别写，回答照常
        logger.warning("mcp_snapshot: %s unwrap failed: %s", group, _safe_err(e))
        return
    prev = _load_group_doc(group)
    if prev:
        old = {str(e["key"]): len(e.get("tools") or []) for e in (prev.get("servers") or [])}
        shrunk = {k: (old[k], n) for k, n in _counts(per_server).items()
                  if k in old and n < old[k]}
        if shrunk:
            logger.error("mcp_snapshot: %s live tool set shrank vs snapshot %s "
                         "(old, new), refusing to overwrite", group, shrunk)
            return
    try:
        body = _body_for(group, per_server)   # 序列化在调用方线程做，拿完就不再碰 Tool 对象
    except Exception as e:  # noqa: BLE001
        logger.warning("mcp_snapshot: %s serialize failed: %s", group, _safe_err(e))
        return

    def _put():
        try:
            _s3().put_object(Bucket=_BUCKET, Key=_key(group), Body=body,
                             ContentType="application/json")
            logger.info("mcp_snapshot: saved %s (%d servers, %d bytes)",
                        group, len(per_server), len(body))
        except Exception as e:  # noqa: BLE001 — 写不了只是下次还慢，不该影响本次回答
            logger.warning("mcp_snapshot: save %s failed: %s", group, _safe_err(e))

    if background:
        threading.Thread(target=_put, name=f"mcp-snap-{group}", daemon=True).start()
    else:
        _put()


# ── 懒客户端 ──────────────────────────────────────────────────────────────────
# **专用线程池，绝不用事件循环的默认 executor。** 理由是硬的：
# `strands/models/bedrock.py` 自己就用 `asyncio.to_thread(converse_stream)`，也就是
# 模型调用本身占着默认 executor 的线程。而 `MCPClient.start()` 超时后会走 `stop()`，
# `stop()` 里的 `_background_thread.join()` **没有超时** —— 一个卡死的 server 能让
# start() 永远不返回、把那个线程永久占住。容器只有 1~2 vCPU，默认 executor 只有
# min(32, cpu+4) 个线程；几个卡死的 MCP 启动就能把模型调用一起饿死，而 /ping 还是健康的
# （最难查的一类故障：进程活着、什么都不动）。给它一个隔离的、够 5 个 server 用的池，
# 卡死最多烧掉这个池里的线程，不碰模型那条路。
_POOL = None
_POOL_LOCK = threading.Lock()

# 请求路径上等一个 server 起来的上限。cloudwatch 现网实测冷启 9.3s，所以这个值必须
# 明显大于它，否则会在 server 其实能起来的时候误报"不可用"；同时必须有限，否则一个
# 卡死的 server 会把这一轮对话挂死。
_LAZY_WAIT_SEC = 25.0


def _pool():
    global _POOL
    if _POOL is not None:
        return _POOL
    with _POOL_LOCK:
        if _POOL is None:
            import concurrent.futures as cf
            # 6 = 5 个 server + 1 个余量（预热会一次性把 5 个都提交进来）。
            _POOL = cf.ThreadPoolExecutor(max_workers=6, thread_name_prefix="mcp-lazy")
        return _POOL


class LazyClient:
    """占位的 MCP client：挂载时不连，真正要调工具（或预热）时才把 server 拉起来。

    对外只要长得像 `MCPClient` 就够了 —— `MCPAgentTool.stream()` 只用 `call_tool_async`。

    并发模型：**每个 server 一个 single-flight Future**，不是"一把锁护住整段 start"。
    锁只护 Future 的创建（微秒级），**绝不跨 `_connect()` 持有**。差别很实际：若用锁
    跨 start()，第二个调用方会在锁上无限期阻塞、而且是阻塞在一个池线程里 —— 一个卡死的
    server 就能按调用次数线性吃掉线程。用 Future，所有等待方共享同一次启动，各自带
    超时地 await，超时了只是自己放弃，不占线程。
    """

    def __init__(self, group: str, server_key: str, connect):
        self.group = group
        self.server_key = server_key
        self._connect = connect          # () -> MCPClient | None（阻塞，做真正的 start）
        self._client = None
        self._dead = False
        self._future = None
        self._lock = threading.Lock()    # 只护 _future 的创建

    def _start_and_publish(self):
        """在池线程里跑：起 server，并**在返回之前**把结果写进实例状态。

        "返回前就发布"不是风格问题：`concurrent.futures.Future` 一旦进入 RUNNING 就
        `cancel()` 不掉 —— 用户中途点停止、SSE 断开，都只取消外层的 await，这个函数
        照样跑完。要是"已经起好了"只体现在返回值上，那次 start 的成果就丢了：一个活着的
        stdio 子进程没人引用（也没人 stop），下次调用再起第二个。
        """
        try:
            client = self._connect()
        except Exception as e:  # noqa: BLE001 — 起不来就是这个能力本会话不可用
            logger.warning("mcp_snapshot: lazy connect %s/%s failed: %s",
                           self.group, self.server_key, _safe_err(e))
            client = None
        if client is None:
            self._dead = True
            logger.warning("mcp_snapshot: %s/%s unavailable", self.group, self.server_key)
        else:
            self._client = client
        return client

    def _submit(self):
        with self._lock:
            if self._future is None:
                self._future = _pool().submit(self._start_and_publish)
            return self._future

    async def ensure_async(self, timeout: float = _LAZY_WAIT_SEC):
        """在请求路径上等 server 起来，**带上限**。返回真 client 或 None。"""
        if self._client is not None:
            return self._client
        if self._dead:
            return None                      # 已知起不来 → 立刻走改道提示，不再干等
        import asyncio
        fut = asyncio.wrap_future(self._submit())
        try:
            # shield：超时/取消只放弃「等」，不去动底下那次启动 —— 它已经 RUNNING、
            # 取消不掉，而且预热或下一次调用还要用它的结果。
            return await asyncio.wait_for(asyncio.shield(fut), timeout)
        except Exception as e:  # noqa: BLE001 — 超时/失败都退化成"这个能力本轮不可用"
            logger.warning("mcp_snapshot: %s/%s not ready within %.0fs (%s)",
                           self.group, self.server_key, timeout, _safe_err(e))
            return None

    @property
    def started(self) -> bool:
        return self._client is not None

    @property
    def real(self):
        """已起好的真 `MCPClient`（没起好是 None）。仅给回校用。"""
        return self._client

    async def call_tool_async(self, *args, **kwargs):
        real = self._client
        if real is None:
            # 正常到不了这里：LazyMCPTool.stream 先 ensure 过了。给个明确的错误
            # 总好过 AttributeError on None。
            raise RuntimeError(f"MCP server {self.server_key} is not started")
        return await real.call_tool_async(*args, **kwargs)


# ── 工具错误结果 ──────────────────────────────────────────────────────────────
def tool_error_event(tool_use, text: str):
    """构造一个**合法的**工具错误结果事件。

    为什么不能只 yield 一个裸的"外层信封" dict —— 这是现网真实存在过的 bug：
    strands 的工具终端只在 `isinstance(event, ToolResultEvent)` 时短路
    （`strands/tools/executors/_executor.py`），普通 dict 会一路掉到最后那句
    `yield ToolResultEvent(cast(ToolResult, last_raw_event))`。于是
    `{"type": "tool_result", "tool_result": {...}}` 这个**外层信封**被整个当成
    ToolResult：顶层没有 toolUseId / status / content，回到对话里就是一个非法的
    Bedrock `toolResult` 块，下一次 Converse 直接 ValidationException（前端表现为
    "(no response)"）。也就是说"拒绝"没能告诉模型，反而把整轮对话打死了。

    所以这里返回**内层** ToolResult，并优先包成 `ToolResultEvent`。拿不到那个类时
    退回裸的内层 dict —— 终端会把它包成合法结果（只是多走一次 ToolStreamEvent），
    仍然远好于外层信封。
    """
    try:
        tuid = str(tool_use.get("toolUseId") or "")
    except Exception:  # noqa: BLE001 — tool_use 形状不对时也要能给出结果
        tuid = ""
    inner = {"toolUseId": tuid, "status": "error", "content": [{"text": text}]}
    try:
        from strands.types._events import ToolResultEvent
    except Exception:  # noqa: BLE001 — 这个版本没有就退回裸 dict
        return inner
    return ToolResultEvent(inner)


# 刻意**点名替代工具**，而不是只说一句"不可用"。系统提示要求 agent「必须调用工具拿到
# 真实数据再作答」，如果这里只说失败，模型的默认反应是把同一个工具再试几遍 —— 每次重试
# 都是一整个 event-loop cycle、带着越来越长的历史，最后往往编一个数字出来。给一条确定的
# 改道指令，比让它抽奖强。
_UNAVAILABLE = ("This tool's backing MCP server could not be started in this session, so "
                "this tool is unavailable for the rest of this conversation. Do NOT retry "
                "it. Get the same data another way: use call_aws (deploy account) or "
                "aws_readonly (cross-account) to call the equivalent read-only AWS API. "
                "If no equivalent exists, tell the user this data source is temporarily "
                "unavailable instead of guessing.")


# ── 懒工具 ────────────────────────────────────────────────────────────────────
def make_lazy_tool_class():
    """造 `LazyMCPTool` 类。strands 在这里才 import；拿不到基类就返回 None。"""
    try:
        from strands.tools.mcp.mcp_agent_tool import MCPAgentTool
    except Exception:  # noqa: BLE001
        return None

    class LazyMCPTool(MCPAgentTool):
        """spec 来自快照、子进程按需才起的 MCP 工具。

        **刻意不定义 `__init__`** —— 必须与 `MCPAgentTool.__init__(mcp_tool, mcp_client,
        name_override=None, timeout=None)` 位置兼容。理由很硬：
        `core/aws_api_mcp.py::_wrap_capped` 会 `class _CappedTool(type(tool))` 然后用
        这 4 个参数重建实例；重建一旦 TypeError，它的 except 分支会**返回未包装的原
        工具** —— `call_aws` 的 secret 读取 denylist（只读三重防线的第 3 层）和
        40000 字符结果上限**一起消失**，而现场只有一条 WARNING。多一个必填构造参数
        就会踩上这条路。所以额外状态一律挂在 `LazyClient` 上，不进构造签名。
        """

        async def stream(self, tool_use, invocation_state, **kwargs):
            client = self.mcp_client
            ensure = getattr(client, "ensure_async", None)
            # `started` 是最常见的情况（预热早就起好了）：直接短路，不碰锁不碰线程池。
            if ensure is not None and not getattr(client, "started", False):
                if await ensure() is None:
                    yield tool_error_event(tool_use, _UNAVAILABLE)
                    return
            async for event in super().stream(tool_use, invocation_state, **kwargs):
                yield event

    return LazyMCPTool


_lazy_clients: dict[str, dict[str, LazyClient]] = {}
_clients_lock = threading.Lock()


def lazy_tools(group: str, per_server: list[tuple[str, list]],
               connect_for) -> list[tuple[str, list]] | None:
    """把快照重建成懒工具，**保持 `[(server_key, [tool, ...]), ...]` 的分组与顺序** ——
    与同步路径 `_start_servers()` 的返回形状一样，好让两条路共用同一段过滤/包装代码。

    `connect_for(server_key)` → 一个阻塞的 `() -> MCPClient | None`。
    返回 None = 硬失败（比如拿不到 `MCPAgentTool` 基类）→ 调用方走同步路径。
    """
    cls = make_lazy_tool_class()
    if cls is None:
        return None
    out: list[tuple[str, list]] = []
    clients: dict[str, LazyClient] = {}
    for key, tools in per_server:
        lc = LazyClient(group, key, connect_for(key))
        clients[key] = lc
        out.append((key, [cls(t, lc, name_override=t.name) for t in tools]))
    with _clients_lock:
        # 同一 microVM 里切主题 / 拨 DevOps 开关会再次进 `_tools_for_topic`，也就会再
        # 建一组 LazyClient。只保留第一组：它可能已经起好了子进程，覆盖掉就等于漏掉
        # 那些已启动的 server（既浪费、又让预热去起第二份）。
        if group not in _lazy_clients:
            _lazy_clients[group] = clients
    return out


# ── 预热 ──────────────────────────────────────────────────────────────────────
# 懒挂载把"起子进程"推到第一次调工具的时候。要是就这么放着，凡是需要工具的问题都会
# 在中途卡 5~9 秒 —— 那只是把延迟从开头搬到中间，不算优化。所以挂载完就在后台把
# server 起起来，让这段时间与「模型出字 + 用户读字」重叠。
#
# 预热复用的就是懒路径**同一个 `ensure_sync`、同一把锁**：预热中途来了真调用，就在同
# 一把锁上等，绝不会起第二份子进程；反过来也一样。
_warm_started = False
_warm_lock = threading.Lock()

# 预热完成后要不要拿真 list_tools 回校快照。见 `_verify_group`。
_verify_after_warm = True


def warm_now() -> None:
    """在后台把所有已挂载的懒 MCP server 起起来。**幂等**。

    幂等是必须的，不是保险：Agent 实例缓存的 key 里含 topic / account_id /
    devops_deep，所以**同一个 microVM 里切主题或拨开关会再次进 `_tools_for_topic`**，
    从而再次走到这里。第二个预热线程 = 第二组 5 个子进程。
    """
    global _warm_started
    with _clients_lock:
        groups = {g: dict(c) for g, c in _lazy_clients.items()}
    if not groups:
        return
    with _warm_lock:
        if _warm_started:
            return
        _warm_started = True

    def _run():
        import concurrent.futures as cf
        flat = [lc for cs in groups.values() for lc in cs.values()]
        try:
            # 复用懒路径**同一个** `_submit()`/Future/池：预热与"用户真的调了这个工具"
            # 于是天然是同一次启动，不可能起出第二份子进程；谁先到谁触发，另一个等它。
            futs = [lc._submit() for lc in flat]
            cf.wait(futs, timeout=180)
        except Exception as e:  # noqa: BLE001 — 预热失败只是回到懒路径现起
            logger.warning("mcp_snapshot: warm failed: %s", _safe_err(e))
            return
        logger.info("mcp_snapshot: warm done, %d/%d server(s) up",
                    sum(1 for lc in flat if lc.started), len(flat))
        if _verify_after_warm:
            for g, cs in groups.items():
                try:
                    _verify_group(g, cs)
                except Exception as e:  # noqa: BLE001 — 回校只是运维信号，不许影响服务
                    logger.warning("mcp_snapshot: verify %s failed: %s", g, _safe_err(e))

    threading.Thread(target=_run, name="mcp-warm", daemon=True).start()
    logger.info("mcp_snapshot: background warm kicked (%d server(s))",
                sum(len(c) for c in groups.values()))


def _verify_group(group: str, clients: dict[str, LazyClient]) -> None:
    """预热起完之后，拿真 `list_tools` 和快照比一比；不一致就重写快照。

    这是让整套机制**自愈**的那一步。指纹已经覆盖了包版本，所以正常情况下永远一致；
    真正要防的是"同一个版本、工具列表却不一样"（比如某个 server 的工具随区域/环境
    变）。这时快照会被这个账号里实际跑着的 server 纠正过来，而不是一直错下去。

    注意：`list_tools_sync()` 没有超时，卡住的话这个线程就卡着 —— 但它是 daemon 后台
    线程，不在任何请求路径上，卡住不影响回答。

    比的是 `_canon()` 那个**与顺序无关**的结构，不是 `_body_for()` 的字节，且告警必须点出
    差在哪个工具的哪个路径。这三件事是一起来的：现网每个会话都判一次"不一致"、白重写一份
    112 KB，而按字节比 + 只说 "differs" 的日志既查不出原因、也分不清"桶里根本还没有快照"。
    换成规范化比 + `_canon_diff()` 之后，日志直接点到
    `get_metric_data @ inputSchema.properties.dimensions.description(-live)`，才定位到真正的
    起因：strands 挂载时就地改了我们缓存的快照 doc（见 `_rebuild_tool` 的 deepcopy）。
    顺序也不该参与判定：挂载用的是**快照里的**顺序，它跨会话天然稳定（prompt cache 要的
    正是这个）；某个容器 live 顺序不同就重写，只会把稳定的快照搅成抖动的。
    """
    if not enabled():
        return
    live: list[tuple[str, list]] = []
    for key, lc in clients.items():
        if not lc.started:
            return          # 有 server 没起来 → 拿不到完整列表，不比也不写
        live.append((key, [t.mcp_tool for t in lc.real.list_tools_sync()]))
    doc = _load_group_doc(group)
    if not doc:
        # 与"内容不一致"分开记：混在一起时，日志里那句"differs"会让人去查根本没差的内容。
        logger.info("mcp_snapshot: %s no snapshot to verify against, writing one", group)
    else:
        try:
            want = _canon(group, [(str(e["key"]), [_rebuild_tool(d) for d in e["tools"]])
                                  for e in (doc.get("servers") or [])])
            got = _canon(group, live)
            if got == want:
                return
            logger.warning("mcp_snapshot: %s snapshot differs from live servers (%s), rewriting",
                           group, _canon_diff(want, got))
        except Exception as e:  # noqa: BLE001 — 比不了就当不一致，重写一份权威的
            logger.info("mcp_snapshot: %s compare failed (%s), rewriting", group, _safe_err(e))
    with _group_lock:
        _group_cache.pop(group, None)
    save(group, live, background=False)


def _canon(group: str, per_server: list[tuple[str, list]]) -> dict:
    """把 `[(server_key, [Tool, ...])]` 压成**与顺序无关**的可比结构。

    `{server_key: {tool_name: 规范化 JSON}}`：server 顺序、同一 server 内的工具顺序、
    以及每个工具 dump 出来的键顺序都不参与比较，只有"哪个 server 有哪些工具、每个工具
    长什么样"参与。`sort_keys=True` 是这里唯一与 `_body_for` 不同的地方 —— 写盘要保持
    模型字段顺序（可读性 + 与 live dump 一致），比对不需要。
    """
    return {k: {t.name: json.dumps(_dump_tool(t), sort_keys=True, ensure_ascii=False)
                for t in tools}
            for k, tools in per_server}


def _canon_diff(want: dict, got: dict) -> str:
    """说清"到底哪里不一样" —— 只给结构性差异，不回显工具内容（description 很长）。

    没有这句话时，日志里只有"differs"三个字，运营侧无法判断该不该管：是某个 server
    没起来（要管），还是上游 MCP 包偷偷改了某个工具的 schema（不用管，自愈就是干这个的）。
    """
    bits = []
    if set(want) != set(got):
        if only := sorted(set(want) - set(got)):
            bits.append(f"servers missing live: {only}")
        if new := sorted(set(got) - set(want)):
            bits.append(f"servers new in live: {new}")
    for k in sorted(set(want) & set(got)):
        if gone := sorted(set(want[k]) - set(got[k])):
            bits.append(f"{k}: tools gone {gone[:5]}")
        if added := sorted(set(got[k]) - set(want[k])):
            bits.append(f"{k}: tools added {added[:5]}")
        changed = sorted(n for n in set(want[k]) & set(got[k]) if want[k][n] != got[k][n])
        if changed:
            where = "; ".join(f"{n} @ {_json_diff_paths(want[k][n], got[k][n])}"
                              for n in changed[:3])
            bits.append(f"{k}: {len(changed)} tool(s) changed [{where}]")
    return "; ".join(bits) or "no structural difference found"


def _json_diff_paths(a: str, b: str, limit: int = 6) -> str:
    """两份规范化 JSON 差在哪几个**路径**上 —— 只给路径，不给值。

    值是 schema 片段（get_metric_data 光 description 就 7.5 KB），进日志会把 CloudWatch
    刷爆、还可能把工具文档整段搬进日志。路径足够定位：拿到
    `inputSchema.$defs.X.properties.y` 就能去上游包里对着看。
    """
    out: list[str] = []

    def walk(x, y, path: str) -> None:
        if len(out) >= limit or x == y:
            return
        if isinstance(x, dict) and isinstance(y, dict):
            for key in sorted(set(x) | set(y)):
                if key not in x:
                    out.append(f"{path}.{key}(+live)")
                elif key not in y:
                    out.append(f"{path}.{key}(-live)")
                else:
                    walk(x[key], y[key], f"{path}.{key}")
                if len(out) >= limit:
                    return
        elif isinstance(x, list) and isinstance(y, list):
            if len(x) != len(y):
                out.append(f"{path}[len {len(x)}→{len(y)}]")
                return
            for i, (xi, yi) in enumerate(zip(x, y)):
                walk(xi, yi, f"{path}[{i}]")
                if len(out) >= limit:
                    return
        else:
            out.append(f"{path}({type(x).__name__}→{type(y).__name__})"
                       if type(x) is not type(y) else path)

    try:
        walk(json.loads(a), json.loads(b), "")
    except Exception as e:  # noqa: BLE001 — 诊断用，自己不能变成故障源
        return f"path diff failed ({_safe_err(e)})"
    return ",".join(p.lstrip(".") or "<root>" for p in out[:limit]) or "?"
