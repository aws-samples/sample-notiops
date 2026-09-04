"""
模型实例构造（webchat agent 侧）—— 全部参数由 DDB 模型目录驱动。

2026-08 起本模块**不再持有模型清单**：alias → model_id / 输出上限 / prompt cache /
Mantle 区域 全部来自 `core.llm_config`（DDB `PK=llmcfg`，Admin 可改，热生效；
DDB 不可用时该模块回退内置兜底目录）。加一个模型现在是改配置，不再是改代码发版。

对外契约不变（`main.py` 只用这两个）：
  · load_model(model_key)      → Strands 模型实例
  · resolve_model_id(model_key) → wire-level model id（用于「模型自身知识」来源标注与落款）

两条路径：
  · kind == bedrock_mantle_responses → OpenAIResponsesModel + Bedrock Mantle（GPT 系）
  · 其余                             → 标准 BedrockModel（Converse）
"""
from __future__ import annotations

import logging
import os

from botocore.config import Config as BotocoreConfig
from strands.models.bedrock import BedrockModel

from core import llm_config

# 提示缓存配置类（strands >= ~1.46 才有）。pyproject 只写了 `strands-agents >= 1.15.0`，
# 若解析到老版本会 ImportError —— 而这是**模块导入期**，抛出等于整个 runtime 起不来。
# 故做守卫导入：拿不到就回落老的 cache_prompt 写法（功能不变，只是少了 message 级缓存）。
try:
    from strands.models.model import CacheConfig, CacheToolsConfig
    _HAS_CACHE_CONFIG = True
except ImportError:  # pragma: no cover — 老版本 strands
    CacheConfig = CacheToolsConfig = None  # type: ignore[assignment,misc]
    _HAS_CACHE_CONFIG = False

# 合并说明（2026-08，main 的 perf/devops-deep-token-savings 与本分支的模型目录改造）：
# main 侧这里原有一份硬编码的 `_MODEL_MAP`（alias → model_id）。它**没有**被合并进来 ——
# 本分支已把模型清单整体移到 DDB 目录（`core.llm_config`），保留一份硬编码副本就等于
# 又多一个会和目录漂移的真源。main 在其上新增的提示缓存 TTL 逻辑则完整保留（见下）。

logger = logging.getLogger(__name__)


# ── Bedrock 客户端超时 ───────────────────────────────────────────────────────
# 背景（客户实测，2026-09-01）：Grok / GLM 这类**先想很久再吐第一个 token** 的模型，
# 在复杂问题上会直接撞客户端读超时，表现是「⚠️ 模型调用失败（ReadTimeoutError）」。
#
# 关键事实：**Bedrock 服务端没有客户可配的推理超时**，这条线的超时全部在客户端（botocore）。
# AWS 自己的建议也是调 `read_timeout`（Nova 用户指南的 Timeout configuration 一节直接给
# `read_timeout=3600` 的示例）。而我们此前**一个字都没配**，于是吃的是 Strands 的默认值
# `DEFAULT_READ_TIMEOUT = 120`（strands/models/bedrock.py）—— 只要模型 120 秒内没吐出
# 下一个 chunk 就断。120s 对 Sonnet 够，对 Grok 的长推理不够。
#
# 为什么是 300s：整条链路上比它更紧的两道闸是 BFF Lambda 的 15 分钟（web-chat-core.ts）
# 与 AgentCore Runtime 的流式 60 分钟上限，300s 离它们都很远；同时一轮里可能有多个 cycle
# （工具调用），单 cycle 再放宽就有「一轮打不完 15 分钟」的风险。
#
# ⚠️ `max_attempts` 必须**同时**收紧，这是这段配置里最容易踩的地方：botocore 默认是
# legacy 模式 5 次尝试，300 × 5 = 1500s > Lambda 的 15 分钟 → 客户端还在重试、Lambda
# 先被杀，前端看到的又是「（无响应）」那种最糟的失败形态。2 次尝试的最坏值 600s 才安全。
# 注：流**中途**的 read timeout 本来就不会被重试（重试只包 HTTP 响应头那一段，事件流是
# 调用方惰性消费的），所以收紧重试次数并不会削弱正常的抗抖动能力。
BEDROCK_READ_TIMEOUT_SEC = 300
_BOTO_CLIENT_CONFIG = BotocoreConfig(
    read_timeout=BEDROCK_READ_TIMEOUT_SEC,
    connect_timeout=10,          # 建连本身要么快要么就是网络坏了，没有等 60s 的道理
    retries={"max_attempts": 2, "mode": "standard"},
)


def resolve_model_id(model_key: str | None = None) -> str:
    """前端模型 key → 实际模型标识（供"你用什么模型"如实回答、Sources 标注用）。

    key 不在启用集内（Admin 缩减了启用集、或存量会话带着已下线的 alias）时，
    返回的是**实际生效**的默认模型 id —— 落款必须说真话，不能显示用户以为的那个。
    """
    return llm_config.resolve(model_key).model_id


def _make_mantle_responses_model(spec: llm_config.ResolvedModel):
    """构造走 Bedrock Mantle 的 GPT 系模型实例（OpenAI Responses API）。

    坑：Strands 1.44 的 Mantle base_url 模板是 `https://bedrock-mantle.{region}.api.aws/v1`，
    **少了 `/openai`**。正确应为 `.../api.aws/openai/v1`（见 AWS 博客）。否则请求打到
    `/v1/responses`，服务端报 "model does not support the '/v1/responses' API"。
    修法：子类化 OpenAIResponsesModel，重写 _resolve_client_args —— 仍用官方逻辑每请求
    铸新 bearer token（不会过期），只把 base_url 补成 `/openai/v1`（已含则不重复插）。
    将来 Strands 修正模板后此 patch 仍兼容（幂等）。

    凭证：Strands 默认每请求用 IAM 自铸 bearer token，**不读**
    `AWS_BEARER_TOKEN_BEDROCK`。所以这里显式把 Admin 配的 Bedrock API Key 写进
    `api_key`。Mantle 端点本来就以 `Authorization: Bearer <key>` 接受 Bedrock API
    Key（文档里那正是 OpenAI SDK 的标准用法，对应 IAM 动作
    `bedrock-mantle:CallWithBearerToken`）。不这么做的后果是实测过的：Claude 那
    几轮 CloudTrail 里 caller 是 Key 背后的 IAM user，GPT 那轮却是 runtime 的
    execution_role —— 同一个「凭证方式」开关，按模型给出两种语义。
    未配置 Key 时不覆盖，保持 Strands 的 IAM 自铸行为。
    """
    from strands.models.openai_responses import OpenAIResponsesModel

    class _MantleResponsesModel(OpenAIResponsesModel):
        def _resolve_client_args(self):  # type: ignore[override]
            args = super()._resolve_client_args()
            base = args.get("base_url") or ""
            # 把 `.../api.aws/v1` 修成 `.../api.aws/openai/v1`（幂等）
            if base.endswith("/v1") and "/openai/v1" not in base:
                args["base_url"] = base[: -len("/v1")] + "/openai/v1"
            # **每请求重读**，不在闭包里捕获。`_resolve_client_args` 本来就每请求调一次，
            # 而 `get_bedrock_api_key()` 是 TTL 缓存读，代价近零。
            # 捕获一次的后果是实测过的那类问题：这个模型实例活在被缓存的 Agent 里
            # （LRU，session 最长 8h），闭包里的 Key 于是比 TTL 长得多 —— Key 轮换后
            # TTL 到期重读对它毫无作用，整个 session 继续用旧 Key。
            # Key 优先；没配就把 Strands 铸好的 IAM bearer 原样留下。
            api_key = llm_config.get_bedrock_api_key()
            if api_key:
                args["api_key"] = api_key
            # 超时与 Bedrock 那条路取同一个数（见上面 `BEDROCK_READ_TIMEOUT_SEC`）。
            # openai-python 的默认是 600s，比 BFF Lambda 的 15 分钟只差 5 分钟 —— GPT 那轮
            # 一旦真的卡住，Lambda 会先被杀，前端拿到的是「（无响应）」而不是我们的友好提示。
            args["timeout"] = float(BEDROCK_READ_TIMEOUT_SEC)
            return args

    return _MantleResponsesModel(
        model_id=spec.model_id,
        bedrock_mantle_config={"region": spec.region},
        # 走 OpenAI Responses API，参数名是 max_output_tokens（非 Bedrock 的 max_tokens）。
        params={"max_output_tokens": spec.max_output_tokens},
    )


# ── 输出 token 上限 ─────────────────────────────────────────────────────────
# 背景（客户实测事故）：BedrockModel 默认 max_tokens 偏小（~4096），长回答（大表格 +
# 建议 + 报告收尾）——尤其 Sonnet 5 的 adaptive thinking 常驻、reasoning token 也计入
# 输出——很容易撞顶，触发 MaxTokensReachedException → 流被中断、正文半截、且**收尾**才发的
# sources/usage 全部丢失。
#
# 现在上限由目录数据决定：min(条目 hard_output_limit, 本端目标) 或条目的 output_override，
# 计算在 `core/llm_config.py` 内完成（该文件也是硬上限数字的登记处，附官方文档核实说明）。
# 这样「模型能力」与「本端策略」分离，且手动添加的 model_id 必须显式声明能力，
# 不会再像旧实现那样靠 model_id 子串猜测而命中错误分支。
#
# 合并说明：main 侧曾在本文件里用 `_model_max_output_limit()` / `_max_tokens_for()` 按
# model_id 子串猜硬上限。那两个函数**没有**被合并进来 —— 它们正是上面这段要取代的东西。


# ── 提示缓存 TTL（per-model）─────────────────────────────────────────────────
# 背景：Bedrock 提示缓存**默认 TTL 只有 5 分钟**（不传 ttl 就是 5m）。这对
# **深度调查（DevOps Agent）** 是致命的：那条链路 cycle① 发起调查 → 工具同步轮询最长
# `NOTIOPS_DEVOPS_MAX_WAIT_SEC=840`s（14 分钟）→ cycle② 才回到模型收尾。间隔一旦超过
# 5 分钟，system + 工具 schema 那 ~7K 固定前缀**全部缓存失效、按全价重付**——调查越久越贵。
# AWS 文档明确点名这个场景是 1 小时 TTL 的用途（"an agentic side-agent will take longer
# than 5 minutes"）。故对**支持 1h 的模型**显式传 ttl="1h"。
#
# ⚠️ 1h TTL 是**按模型门控**的，不能一刀切（AWS 官方模型卡片，2026-08 核实；
# `CacheDetail.ttl` 的合法值只有 `5m | 1h`）：
#   Claude Opus 5      → 5m + 1h（每 checkpoint 最少 512 token）
#   Claude Sonnet 5    → 5m + 1h（最少 4096 token）
#   Claude Haiku 4.5   → 5m + 1h（最少 4096 token）
#   Claude Sonnet 4.6  → **仅 5m**  ← 传 1h 会被拒（ValidationException）
# 同 max_tokens 的教训：设了模型不支持的值比不设更糟。故未在名单里的一律返回 None（=5m 默认）。
#
# TODO（合并遗留，非本次 merge 范围）：这仍然是**按 model_id 子串**判断模型能力 —— 与
# `supports_prompt_cache` 已经进目录的做法不一致，也正是本分支一直在消灭的模式。应当把
# 「支持的缓存 TTL」也变成目录字段，由 `llm_config` 声明。原样保留 main 的实现是为了让
# 这次 merge 只做合并、不夹带改造。
_TTL_1H_MODELS = ("claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5")


def _cache_ttl_for(model_id: str) -> str | None:
    """该模型支持的提示缓存 TTL。支持 1 小时的返回 "1h"，其余返回 None（走默认 5m）。"""
    mid = (model_id or "").lower()
    return "1h" if any(k in mid for k in _TTL_1H_MODELS) else None


def _bedrock_kwargs(spec: llm_config.ResolvedModel) -> dict:
    """构造 BedrockModel 参数。

    prompt cache 把固定前缀缓存起来（cacheRead 比正常 input 便宜约 90%）。
    是否开启由目录条目的 `supports_prompt_cache` 声明 —— 这比按 model_id 子串判断可靠：
    手动添加的 model_id 必须显式声明能力，不会命中某个凑巧匹配的分支。
    （main 侧原实现是 `if "anthropic.claude" in model_id`，合并时改用目录声明。）

    缓存分三段（Converse 请求里的前缀顺序：system → tools → messages）：
      1. `cache_tools`  → 工具 schema（~3.5K，每步全量重发）
      2. `cache_config` → **messages**：历史 + 本轮注入块。这是收益最大的一段：
         Strands 把整条拼好的 prompt（含日期/账号隔离/主题聚焦/深度调查硬规则/语言锁等
         全部注入）**原样存进 conversation history**，SlidingWindow 只按条数淘汰、不改写内容，
         所以每一轮都会把**历史上每一轮的注入块**再全价重发一遍（随轮次二次增长）。
         开 CacheConfig(strategy="auto") 后 Strands 会在**最后一条 user message 末尾**插一个
         cachePoint，使整段历史走 cacheRead。不需要改动 prompt 结构（语言锁仍在最末尾）。
      3. system prompt → 由第 2 段的 cachePoint 一并覆盖前缀（system 在 messages 之前）。
         故不再单独设 `cache_prompt`——它在新版 strands 已 deprecated（每次请求都发
         UserWarning），且 `DEFAULT_SYSTEM_PROMPT` 单独算 ~3.6K，低于 Sonnet 5 的
         4096 token/checkpoint 下限，本来就可能压根没缓上。

    TTL 见 `_cache_ttl_for`：给支持的模型上 1h，解决深度调查跨 5 分钟缓存失效。
    ⚠️ 混用 TTL 时长的约束（AWS 文档）：长 TTL 的 checkpoint 必须在短 TTL 之前。这里两个
    checkpoint 用**同一个** ttl，天然满足。
    """
    kwargs: dict = {
        "model_id": spec.model_id,
        "max_tokens": spec.max_output_tokens,
        # 传了这个，Strands 就**不会**再套它自己的 120s 默认（它只在
        # `boto_client_config is None` 时兜底，见 strands/models/bedrock.py 的
        # `client_config = ...` 分支）。它仍会把 `strands-agents` merge 进 user_agent。
        "boto_client_config": _BOTO_CLIENT_CONFIG,
    }
    if spec.supports_prompt_cache:
        _ttl = _cache_ttl_for(spec.model_id)
        if _HAS_CACHE_CONFIG:
            kwargs["cache_tools"] = CacheToolsConfig(type="default", ttl=_ttl)
            # strategy="auto"：Strands 自行判断模型是否支持；不支持只 log warning，不抛错。
            kwargs["cache_config"] = CacheConfig(strategy="auto", ttl=_ttl)
        else:
            # 老版本 strands 回退：只有 tools + system 两段缓存，且只能 5m 默认 TTL。
            kwargs["cache_tools"] = "default"
            kwargs["cache_prompt"] = "default"
    return kwargs


def _build_bedrock_model(spec: llm_config.ResolvedModel) -> BedrockModel:
    """构造标准 BedrockModel，并按凭证模式注入 Bedrock API Key（spec R5.2 / R5.3）。

    这是 webchat runtime 侧**唯一**的 `AWS_BEARER_TOKEN_BEDROCK` set/pop 点。三纪律：

      ① 单点：主路径与 Mantle 兜底路径都走这里，别处不得再设该 env（R5.3①）。
      ② 空即 pop：Key 未配置 / credential_mode=iam / 读取失败时**显式删除** env —— 否则
         长驻 AgentCore microVM 里会残留上一代 Admin 设过的 Key，"清空 Key" 永不生效（R5.3②）。
      ③ set 与构造紧邻、中间无 IO：取 Key 的 Secret 读发生在 set **之前**；set 之后直接
         构造。botocore 在构造时快照 token provider、每请求再读 env 决定签名方式，两者
         必须一致，否则 Bedrock 调用硬失败（NoAuthTokenError），**不会**静默回退 IAM
         （实测见 scripts/test_lazy_bedrock_client.py）（R5.3③）。

    并发：webchat runtime 是 **AgentCore 单会话进程**，load_model 串行调用，进程级 env 无
    跨会话竞争（IM 多会话共享进程的注入见 core/bedrock_credentials.py，不在此路径）。

    Mantle 不经过这里，但**不是**因为「Key 对它无效」。此处原写「GPT 系每请求自铸 bearer
    token、不读该 env（R5.7），注入对它无意义」—— 前半句只对 env 这一种注入方式成立，
    后半句是错的：Mantle 现在也用 Key，只是走 `_make_mantle_responses_model` 里显式的
    `api_key` 参数（Responses 端点吃 `Authorization: Bearer`，对应 IAM 动作
    `bedrock-mantle:CallWithBearerToken`），而不是这个 env。
    """
    kwargs = _bedrock_kwargs(spec)                  # 纯计算，无 IO
    api_key = llm_config.get_bedrock_api_key()      # IO：读 Secret（TTL 缓存）；None → 回退 IAM
    if api_key:
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = api_key
    else:
        os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)
    model = BedrockModel(**kwargs)                  # 紧接着构造，set 与构造之间无 IO
    if api_key:
        _attach_key_rejection_listener(model)
    return model


def _attach_key_rejection_listener(model) -> None:
    """给 Strands 建好的 bedrock-runtime 客户端挂「Key 被拒」监听（spec R7.2）。

    此前这条路径是**不覆盖**的，理由写的是「Strands 的 BedrockModel 自建 boto3 客户端，
    挂不上事件」。那不成立：`BedrockModel.client` 是公开属性（strands 1.51
    `models/bedrock.py:215` 起，同文件 :1029 自己也直接用它 converse）。挂事件既不需要
    传 `boto_session`，也就不会改变 region 与凭证解析路径 —— 当初判断的风险并不存在。

    与 IM 侧（core/bedrock_credentials._on_after_call）同一套判据，都委托
    `llm_config.is_credential_rejected`。为什么必须挂 `after-call` 而不是
    `after-call-error`：鉴权失败是服务端**正常返回**的 HTTP 响应，botocore 解析后才抛
    ClientError，`after-call-error` 收不到（实测 botocore 1.43.19）。

    失效动作是 `invalidate_api_key()`，它同时把凭证纪元 +1 —— 这一步才是 webchat 真正
    需要的：token 在构造时就冻进了这个 client，只清 Key 缓存不会让它换 token，而纪元
    进了 Agent 缓存键，下一轮就会 miss 并重建（见 core/agent_cache 的 cred_epoch）。

    自身绝不抛：拿不到 `.client` 或注册失败都只记一行 —— 加固不能成为对话的故障源。
    """
    def _on_after_call(http_response=None, parsed=None, **_kwargs) -> None:
        status = getattr(http_response, "status_code", None)
        code = ""
        message = ""
        if isinstance(parsed, dict):
            err = parsed.get("Error")
            if isinstance(err, dict):
                code = err.get("Code") or ""
                message = err.get("Message") or ""
        # message 只参与判断，绝不落日志 —— 可能含账号 / 资源 ARN（spec R5.5）。
        if llm_config.is_credential_rejected(status, code, message):
            llm_config.invalidate_api_key()

    try:
        model.client.meta.events.register("after-call.bedrock-runtime", _on_after_call)
    except Exception as e:                      # noqa: BLE001 — 加固不得阻断对话
        logger.warning("could not attach key-rejection listener: %s", e)


def _bedrock_fallback_spec() -> llm_config.ResolvedModel:
    """Mantle 构造失败时的兜底：一个**非 Mantle** 的可用模型。

    不能直接用默认模型 —— 默认模型本身可能就是 GPT（Mantle），那样会再次走进
    同一条失败路径。故优先取默认模型，若它也是 Mantle 则找第一个非 Mantle 的启用项。
    """
    default = llm_config.resolve(None)
    if not default.is_mantle:
        return default
    for entry in llm_config.enabled_entries():
        spec = llm_config.resolve(entry["alias"])
        if not spec.is_mantle:
            return spec
    return default  # 极端情况：启用集里只有 Mantle 模型，交由上层报错


def load_model(model_key: str | None = None):
    """按前端模型 key 返回对应模型实例（参数全部来自 DDB 目录）。

    - Mantle（GPT 系）→ OpenAIResponsesModel + bedrock_mantle_config。依赖未装 /
      区域未开通时**安全回退**到一个非 Mantle 模型，避免整轮对话失败。
    - 其余 → 标准 BedrockModel（Converse）。凭证按 Admin 设的模式：配了 Bedrock API Key
      则用它（`AWS_BEARER_TOKEN_BEDROCK`），否则回退 runtime IAM 角色（见 _build_bedrock_model）。
      支持 prompt cache 的模型额外开工具/提示缓存。
    """
    spec = llm_config.resolve(model_key)
    if spec.is_mantle:
        try:
            return _make_mantle_responses_model(spec)
        except Exception as e:  # noqa: BLE001 — 依赖缺失/区域未开通 → 回退，不阻断整轮
            fallback = _bedrock_fallback_spec()
            logger.warning(
                "mantle model %s unavailable (%s); falling back to %s",
                spec.alias, type(e).__name__, fallback.alias)
            return _build_bedrock_model(fallback)
    return _build_bedrock_model(spec)
