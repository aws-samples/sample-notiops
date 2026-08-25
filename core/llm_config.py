"""
LLM 模型目录读取（IM bot 侧）—— DDB 单一真源 + TTL 缓存 + 内置兜底。

数据源：DynamoDB `notiops-config`，PK=`llmcfg` / SK=`meta`。由 Admin（BFF
`/admin/llm-config`）写入，`setup.sh` 首次部署从 `config/llm-model-catalog.json` seed。

⚠️ 本文件在 **webchat 侧有一份对等实现**
（`agent-build/NotiOpsWebChat/app/NotiOpsWebChat/core/llm_config.py`）。两处是不同
部署单元（ECS 镜像 vs AgentCore zip），无法共享库，改动务必同步——差异只应体现在
`_SURFACE` 常量与 per-surface 输出目标上（由 scripts/test_llm_config_reader.py 同时校验两份）。

热生效（spec R4）—— **IM 侧目前只有 TTL，最坏 60s**：
  · TTL 60s 轮询。这是 IM 唯一的生效途径。
  · `get_config(payload_generation)` 支持由调用方直推 generation 以绕过 TTL 立即强刷，
    但**IM 链路上没有调用方传它**：webchat 有 BFF 在请求路径上可以带（见
    agent-build/.../main.py 的 entrypoint），IM 没有 BFF，`platforms/*/app/main.py`
    也没有探测 generation 的代码。所以 IM 的 `payload_generation` 恒为 None。
    （本注释此前描述了一个"由平台消息入口轻量探测 generation"的机制 —— 那是设计意图，
    从未实现。按实际行为改写，免得排障时去找一段不存在的代码。）
  · 后果：每个 ECS task 各自缓存、互不同步，所以 Admin 保存后最长 60s 内，同一个群里
    两个用户可能被不同模型、不同输出上限回答。要缩短就调 `LLMCFG_CACHE_TTL`，
    要做到「下一条消息即生效」则需在 platforms 入口加一次轻量 GetItem（spec task 待办）。
  · 强刷限速（默认 10s）防被污染的 generation 打成 DDB 放大读；该值必须严格小于 TTL，
    否则强刷窗口被 TTL 完全覆盖、对最坏情况零改善（见 `_FORCED_REFRESH_MIN_INTERVAL`）。

失败安全（spec R7.1）：DDB 不可用 / 配置缺失 / 字段损坏 → 回退 `_BUILTIN_CATALOG`
（= 本文件内置的目录快照），对话不中断，仅打 WARN。
"""
from __future__ import annotations

import logging
import json as _json
import math
import os
import threading
import time
from dataclasses import dataclass
from decimal import Decimal

import boto3

logger = logging.getLogger(__name__)

# 本模块服务的端。webchat 侧对等实现只改这一个常量（+ 输出目标）。
_SURFACE = "im"

# 输出上限目标：IM 回复是**聊天尺寸**（markdown 正文 + 来源块 + 工具 trailer），
# 远小于 webchat 的长报告。实际值 = min(模型 hard_output_limit, 本目标)，
# 可被目录的 output_override["im"] 覆盖（如 GPT 的 tool-use reasoning 需 8000）。
_OUTPUT_TARGET = 6000

_CATALOG_TTL = int(os.environ.get("LLMCFG_CACHE_TTL", "60"))
_KEY_TTL = int(os.environ.get("LLMCFG_KEY_CACHE_TTL", "300"))
# 强刷限速间隔。**必须严格小于 `_CATALOG_TTL`**：两者相等时，一次强刷之后的整个
# TTL 窗口内 `fresh` 为真而 `force` 被拒，于是「保存后下一条消息即生效」只在前一个
# 窗口内没发生过强刷时成立。实测：连续两次 Admin 保存，第二次对消费端不可见，要等
# 满 TTL —— 也就是强刷路径对**最坏情况**零改善。10s 保住抗放大的初衷，同时把
# 「两次保存」这个最常见场景的延迟从 60s 降到 10s。
_FORCED_REFRESH_MIN_INTERVAL = int(os.environ.get("LLMCFG_REFRESH_MIN_INTERVAL", "10"))

_CONFIG_TABLE = os.environ.get("CONFIG_TABLE", "notiops-config")
_BEDROCK_KEY_SECRET = os.environ.get("BEDROCK_API_KEY_SECRET", "notiops/bedrock-api-key")
_PK = "llmcfg"
_SK = "meta"

# generation 合法区间（spec R4.2）：0 = 未经 Admin 修改的 seed 值；其余为 epoch-ms。
# 上界给 1 天余量，挡住 1e308 / 超大整数这类注入。
_GEN_MAX_SKEW_MS = 24 * 3600 * 1000


# ---------------------------------------------------------------------------
# 内置兜底目录 —— 仅在 DDB 不可用时生效
# ---------------------------------------------------------------------------
# 与 config/llm-model-catalog.json 保持一致（由 scripts/test_llm_catalog_seed.py 与
# scripts/test_llm_config_reader.py::test_builtin_matches_seed 双向校验）。
# **必须字段齐全**，包括 short / aliases_legacy / output_override —— 兜底态与正常态
# 行为要完全一致。曾漏掉这三个字段：DDB 一旦不可达，短别名（@bot model nova）当场
# 全部失效、per-model 输出上限也退化成本端统一目标值（nova 5000→6000 会截断来源块）。
_BUILTIN_CATALOG: dict = {
    "generation": 0,
    "provider": "bedrock",
    "credential_mode": "iam",
    "default_model": "xai-grok-4-6",
    "models": [
        {"alias": "claude-sonnet-5", "short": "claude", "aliases_legacy": ["claude"],
         "model_id": "global.anthropic.claude-sonnet-5", "label": "Claude Sonnet 5",
         "kind": "bedrock_anthropic", "region": None, "hard_output_limit": 128000,
         "output_override": {"im": 6000}, "supports_prompt_cache": True,
         "surfaces": ["webchat", "im"], "enabled": True},
        {"alias": "claude-opus-5", "short": "opus", "aliases_legacy": ["opus"],
         "model_id": "global.anthropic.claude-opus-5", "label": "Claude Opus 5",
         "kind": "bedrock_anthropic", "region": None, "hard_output_limit": 128000,
         "output_override": {"im": 6000}, "supports_prompt_cache": True,
         "surfaces": ["webchat", "im"], "enabled": True},
        {"alias": "claude-sonnet-4-6", "short": None, "aliases_legacy": [],
         "model_id": "global.anthropic.claude-sonnet-4-6", "label": "Claude Sonnet 4.6",
         "kind": "bedrock_anthropic", "region": None, "hard_output_limit": 65536,
         "output_override": {"im": 6000}, "supports_prompt_cache": True,
         "surfaces": ["webchat"], "enabled": False},
        {"alias": "claude-haiku-4-5", "short": "haiku", "aliases_legacy": [],
         "model_id": "global.anthropic.claude-haiku-4-5-20251001-v1:0",
         "label": "Claude Haiku 4.5", "kind": "bedrock_anthropic", "region": None,
         "hard_output_limit": 65536, "output_override": {"im": 6000},
         "supports_prompt_cache": True, "surfaces": ["webchat"], "enabled": True},
        {"alias": "amazon-nova-pro", "short": "nova", "aliases_legacy": ["nova"],
         # 裸 `amazon.nova-pro-v1:0` **不能按需直调**（东京实测：
         # `ValidationException: Invocation of model ID amazon.nova-pro-v1:0 with
         # on-demand throughput isn't supported. Retry ... with an inference profile`）。
         # 必须用带地理前缀的跨区推理 profile。种子里原先写的就是裸 id，而 `verified`
         # 被写死成 true，所以这条从未被探测暴露 —— 直到有人真去选它。
         "model_id": "apac.amazon.nova-pro-v1:0", "label": "Amazon Nova Pro",
         "kind": "bedrock_converse", "region": None, "hard_output_limit": 5120,
         "output_override": {"im": 5000}, "supports_prompt_cache": False,
         "surfaces": ["webchat", "im"], "enabled": True},
        {"alias": "deepseek-v3-2", "short": "deepseek", "aliases_legacy": [],
         "model_id": "deepseek.v3.2", "label": "DeepSeek V3.2", "kind": "bedrock_converse",
         "region": None, "hard_output_limit": 8192, "output_override": {},
         "supports_prompt_cache": False, "surfaces": ["webchat"], "enabled": True},
        {"alias": "gpt-5-6", "short": "gpt", "aliases_legacy": ["gpt"],
         "model_id": "openai.gpt-5.6-terra", "label": "GPT-5.6 Terra",
         "kind": "bedrock_mantle_responses", "region": "us-east-2", "hard_output_limit": 32768,
         "output_override": {"im": 8000}, "supports_prompt_cache": False,
         "surfaces": ["webchat", "im"], "enabled": True},
        {"alias": "gpt-5-6-sol", "short": "gpt_sol", "aliases_legacy": ["gpt_sol"],
         "model_id": "openai.gpt-5.6-sol", "label": "GPT-5.6 Sol",
         "kind": "bedrock_mantle_responses", "region": "us-east-2", "hard_output_limit": 32768,
         "output_override": {"im": 8000}, "supports_prompt_cache": False,
         "surfaces": ["webchat", "im"], "enabled": True},
        {"alias": "gpt-5-6-luna", "short": "gpt_luna", "aliases_legacy": ["gpt_luna"],
         "model_id": "openai.gpt-5.6-luna", "label": "GPT-5.6 Luna",
         "kind": "bedrock_mantle_responses", "region": "us-east-2", "hard_output_limit": 32768,
         "output_override": {"im": 8000}, "supports_prompt_cache": False,
         "surfaces": ["webchat", "im"], "enabled": True},
        # `hard_output_limit` / `supports_prompt_cache` 的取值依据见种子文件里同名的
        # `_*_note`（都是 us-east-1 实测，不是抄文档）：524288 是 Converse 的拒绝阈值，
        # prompt cache 虽被模型卡列为支持、但显式 cachePoint 实测被拒，故为 False。
        # `aliases_legacy` 收的是运维在 Admin 页手工加这个模型时用过的 alias。
        {"alias": "xai-grok-4-6", "short": "grok",
         "aliases_legacy": ["global-xai-grok-4-6"],
         "model_id": "global.xai.grok-4.6", "label": "Grok 4.6",
         "kind": "bedrock_converse", "region": None, "hard_output_limit": 524288,
         "output_override": None, "supports_prompt_cache": False,
         "surfaces": ["webchat", "im"], "enabled": True},
    ],
}

_KINDS = {"bedrock_anthropic", "bedrock_converse", "bedrock_mantle_responses"}


@dataclass(frozen=True)
class ResolvedModel:
    """目录条目 + 已按本端解析完的调用参数。`load_model()` 只依赖本结构。"""
    alias: str
    model_id: str
    label: str
    kind: str
    region: str | None
    max_output_tokens: int
    supports_prompt_cache: bool

    @property
    def is_mantle(self) -> bool:
        return self.kind == "bedrock_mantle_responses"


# ---------------------------------------------------------------------------
# 缓存状态
# ---------------------------------------------------------------------------
_lock = threading.Lock()
_cached_cfg: dict | None = None
_cached_cfg_ts: float = 0.0
_last_forced_refresh_ts: float = 0.0

_cached_key: str | None = None
_cached_key_ts: float = 0.0

_ddb = None


def _table():
    global _ddb
    if _ddb is None:
        _ddb = boto3.resource("dynamodb").Table(_CONFIG_TABLE)
    return _ddb


def _safe_err(e: Exception) -> str:
    """只记异常类型（+ AWS 错误码），绝不记原始 message —— 后者可能带请求负载/用户数据。
    与 core/ddb_state.py 的同名函数一致（docs/LOGGING_STANDARD.md）。"""
    resp = getattr(e, "response", None)
    code = (resp.get("Error", {}) or {}).get("Code") if isinstance(resp, dict) else None
    return f"{type(e).__name__}/{code}" if code else type(e).__name__


def _as_int(value, default: int = 0) -> int:
    """DDB 数值回来是 Decimal；顺带挡住 None/str/bool 等脏值。"""
    if isinstance(value, bool):
        return default
    if isinstance(value, (int, Decimal)):
        try:
            return int(value)
        except (ValueError, ArithmeticError):
            return default
    return default


def _sane_generation(value) -> int | None:
    """校验 generation 是合法 epoch-ms（或 seed 的 0）。非法返回 None（调用方忽略）。

    spec R4.2：generation 虽由 BFF 服务端生成，但仍是经 payload 到达的外部输入，
    必须校验——否则 `1e308` / 负数 / 字符串会让"与本地不同"恒真，把 TTL 兜底彻底
    失效并放大 DDB 读。
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, float):
        # payload JSON 可能给出 1e308 / inf / nan。inf 与 nan 连 int() 都会抛
        # （OverflowError / ValueError），必须先挡掉再谈取整。
        if not math.isfinite(value) or value != int(value):
            return None
        value = int(value)
    if isinstance(value, str):
        if not value.strip().isdigit():
            return None
        value = int(value)
    if not isinstance(value, (int, Decimal)):
        return None
    gen = int(value)
    if gen < 0:
        return None
    if gen > int(time.time() * 1000) + _GEN_MAX_SKEW_MS:
        return None
    return gen


def _normalise(raw: dict) -> dict | None:
    """把 DDB item 规整成内部结构；结构性损坏返回 None（调用方回退兜底）。"""
    if not isinstance(raw, dict):
        return None
    models_raw = raw.get("models")
    if not isinstance(models_raw, list) or not models_raw:
        return None

    models: list[dict] = []
    for m in models_raw:
        if not isinstance(m, dict):
            continue
        alias = str(m.get("alias") or "").strip().lower()
        model_id = str(m.get("model_id") or "").strip()
        kind = str(m.get("kind") or "").strip()
        if not alias or not model_id or kind not in _KINDS:
            logger.warning("llm_config: dropping malformed catalogue entry alias=%r", alias)
            continue
        surfaces = m.get("surfaces")
        surfaces = [str(s) for s in surfaces] if isinstance(surfaces, list) else ["webchat", "im"]
        override = m.get("model_id_override")
        override = override if isinstance(override, dict) else {}
        out_override = m.get("output_override")
        out_override = out_override if isinstance(out_override, dict) else {}
        models.append({
            "alias": alias,
            "short": (str(m["short"]).strip().lower() if m.get("short") else None),
            "aliases_legacy": [str(a).strip().lower()
                               for a in (m.get("aliases_legacy") or [])
                               if str(a).strip()],
            "model_id": model_id,
            "model_id_override": {str(k): str(v) for k, v in override.items() if v},
            "label": str(m.get("label") or alias),
            "kind": kind,
            "region": (str(m["region"]).strip() if m.get("region") else None),
            "hard_output_limit": _as_int(m.get("hard_output_limit"), 8192) or 8192,
            "output_override": {str(k): _as_int(v) for k, v in out_override.items()
                                if _as_int(v) > 0},
            "supports_prompt_cache": bool(m.get("supports_prompt_cache")),
            "surfaces": surfaces,
            "enabled": bool(m.get("enabled")),
            # 曾有 "verified"。该字段已整体删除 —— 它是「(模型 × 区域 × 凭证 × 时间)
            # 这个组合当时成立」的快照，任何一维变了就失效，而运行时**从来没有消费它**
            # （只是抄进这个 dict，且 /models 明确禁止它出现在响应里）。可用性改由
            # 保存时的现场探测保证（BFF probeDefaultModel）。
        })

    if not models:
        return None

    by_alias = {m["alias"]: m for m in models}
    default = str(raw.get("default_model") or "").strip().lower()
    # 不变量兜底：默认模型必须存在且启用；否则取第一个启用项，再退第一项。
    if default not in by_alias or not by_alias[default]["enabled"]:
        fallback = next((m["alias"] for m in models if m["enabled"]), models[0]["alias"])
        if default:
            logger.warning("llm_config: default_model %r unusable, falling back to %r",
                           default, fallback)
        default = fallback

    return {
        "generation": _as_int(raw.get("generation")),
        "provider": str(raw.get("provider") or "bedrock").strip().lower(),
        "credential_mode": (str(raw.get("credential_mode") or "iam").strip().lower()
                            if str(raw.get("credential_mode") or "iam").strip().lower()
                            in ("iam", "api_key") else "iam"),
        "default_model": default,
        "models": models,
        "backend_tasks": (raw.get("backend_tasks")
                          if isinstance(raw.get("backend_tasks"), dict) else {}),
        "_source": "ddb",
    }


# ---------------------------------------------------------------------------
# Metric 发射（CloudWatch EMF）
# ---------------------------------------------------------------------------
# 仓库此前**零 metric**，而本模块的降级都是静默的：DDB 读不到就用内置目录、模型不在
# 启用集就换默认、Key 401 就退回 IAM —— 对话照常，日志里一条 WARN，没人会去 grep。
# 而「所有端都跑在兜底目录上」正是全新部署的默认状态（目录尚未 seed 时），最需要被看见。
#
# 用 EMF（Embedded Metric Format）而不是 PutMetricData：
#   · 无需任何设置，把符合规范的 JSON 写进 CloudWatch Logs 即可，CloudWatch 自动抽取
#     成指标（2023-01 起连特殊 header 都不需要）
#     https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Embedded_Metric_Format.html
#   · 不需要 cloudwatch:PutMetricData 权限 —— 五个部署单元的 role 一个都不用改
#   · 不增加请求延迟、不占 API 配额；本模块在对话热路径上，这一点是决定性的
#   · 五个单元（Lambda / ECS / AgentCore）都已经在往 CloudWatch Logs 写，机制统一
#
# 发射失败绝不冒泡：观测不该成为新的故障源。
_METRIC_NAMESPACE = os.environ.get("LLMCFG_METRIC_NAMESPACE", "NotiOps/LLMConfig")
_METRICS_ENABLED = os.environ.get("LLMCFG_METRICS", "1") not in ("0", "false", "False")


def _emit(metric: str, value: int = 1, **dimensions) -> None:
    """发一条 EMF 指标行。metric 名用 PascalCase（CloudWatch 惯例）。

    `dimensions` 里的键会成为 CloudWatch 维度；`Surface` 恒定加上，便于按端切分。
    维度基数必须保持很低 —— 别把 alias、model_id 之类放进来当维度（会按维度组合计费
    并炸掉指标数）；需要高基数信息就放在同一行的非维度字段里，用 Logs Insights 查。
    """
    if not _METRICS_ENABLED:
        return
    try:
        dims = {"Surface": _SURFACE, **{k: str(v) for k, v in dimensions.items()}}
        payload = {
            "_aws": {
                "Timestamp": int(time.time() * 1000),
                "CloudWatchMetrics": [{
                    "Namespace": _METRIC_NAMESPACE,
                    "Dimensions": [sorted(dims)],
                    "Metrics": [{"Name": metric, "Unit": "Count"}],
                }],
            },
            **dims,
            metric: value,
        }
        # 必须单行：EMF 按单条 log event 解析
        print(_json.dumps(payload, separators=(",", ":")), flush=True)
    except Exception:  # noqa: BLE001 — 观测不得成为故障源
        pass


def _builtin() -> dict:
    cfg = _normalise(_BUILTIN_CATALOG) or {}
    cfg["_source"] = "builtin"
    return cfg


def _fetch(consistent: bool = False) -> dict | None:
    try:
        resp = _table().get_item(Key={"PK": _PK, "SK": _SK}, ConsistentRead=consistent)
    except Exception as e:  # noqa: BLE001 — 读配置失败绝不能中断对话
        logger.warning("llm_config: DDB read failed (%s); using builtin fallback", _safe_err(e))
        _emit("FallbackBuiltin", reason="read_error")
        return None
    item = resp.get("Item")
    if not item:
        logger.warning("llm_config: no llmcfg item in %s; using builtin fallback", _CONFIG_TABLE)
        # 目录尚未 seed。全新部署的默认状态，也是最该被看见的那一种 ——
        # 对话正常、Admin 页空表，没有 metric 的话完全无声。
        _emit("FallbackBuiltin", reason="not_seeded")
        return None
    cfg = _normalise(item)
    if cfg is None:
        logger.warning("llm_config: llmcfg item malformed; using builtin fallback")
        _emit("FallbackBuiltin", reason="malformed")
    return cfg


# ---------------------------------------------------------------------------
# 公有 API
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Feature flag（spec R9.1）—— 每端独立
# ---------------------------------------------------------------------------
# `LLMCFG_ENABLED=0` 让本端**完全不读 DDB**，只用内置兜底目录。这就是灰度失败时的回滚
# 拉杆：不用回滚代码、不用重新部署镜像，改一个环境变量即可。
#
# 关闭态 == 本 feature 之前的行为，不是"某种降级"：`_BUILTIN_CATALOG` 的内容与旧的
# 硬编码目录（IM 的 `model_catalog._CATALOG`、webchat 的 `load._MODEL_MAP`）逐字段一致，
# 由 scripts/test_llm_config_reader.py::test_builtin_matches_seed 双向校验。所以关掉之后
# Admin 的改动不生效，其余一切照旧。
#
# 三端独立是有意的：webchat runtime / IM bot / BFF 是三个部署单元，问题往往只出在一端，
# 一刀切关掉会把好的那两端也退回去。按 spec R9.2 的顺序逐端开、逐端验。
# 注意 BFF 侧的语义不同（只旁路消费路径，Admin 写入照常可用）—— 见
# bff/web-chat/llm_config.mjs 的同名开关说明。
_ENABLED = os.environ.get("LLMCFG_ENABLED", "1") not in ("0", "false", "False")


def get_config(payload_generation=None) -> dict:
    """返回当前配置（TTL 缓存 + generation 直推强刷 + 兜底）。

    payload_generation: BFF 在本条消息 payload 里带来的服务端 generation。与本地缓存
    不同 → 绕过 TTL 强制刷新（受 `_FORCED_REFRESH_MIN_INTERVAL` 限速）。非法值忽略。
    """
    global _cached_cfg, _cached_cfg_ts, _last_forced_refresh_ts

    if not _ENABLED:
        # 关闭态：不读 DDB、不读 Secret，直接给内置目录。复用 TTL 缓存把 metric 与日志
        # 限速成"每个窗口一次"，否则每轮对话都会刷一行。
        with _lock:
            if _cached_cfg is not None and (time.time() - _cached_cfg_ts) < _CATALOG_TTL:
                return _cached_cfg
        cfg = _builtin()
        logger.info("llm_config: disabled by LLMCFG_ENABLED=0; using builtin catalogue")
        _emit("FallbackBuiltin", reason="disabled")
        with _lock:
            _cached_cfg = cfg
            _cached_cfg_ts = time.time()
        _note_status(cfg)
        return cfg

    now = time.time()
    incoming = _sane_generation(payload_generation)

    with _lock:
        cached = _cached_cfg
        fresh = cached is not None and (now - _cached_cfg_ts) < _CATALOG_TTL
        force = False
        if incoming is not None and cached is not None:
            if incoming != _as_int(cached.get("generation")):
                if (now - _last_forced_refresh_ts) >= _FORCED_REFRESH_MIN_INTERVAL:
                    force = True
                    _last_forced_refresh_ts = now
        if fresh and not force:
            return cached

    # 网络 IO 放在锁外，避免阻塞其它请求（AgentCore 单会话，IM 多会话共享进程）。
    cfg = _fetch(consistent=force)
    if cfg is None:
        # 强刷失败尤其值得单独看见：`_last_forced_refresh_ts` 在发起 fetch **之前**就已
        # 提交，所以这一次失败之后，直到限速窗口过去都拿不到新配置 —— 兜底目录会被服务
        # 一整个窗口。_fetch 内部已发过 FallbackBuiltin，这里叠一个"是强刷路径失败"。
        if force:
            _emit("RefreshFail")
        cfg = _builtin()

    with _lock:
        _cached_cfg = cfg
        _cached_cfg_ts = time.time()
    _note_status(cfg)
    return cfg


def generation() -> int:
    return _as_int(get_config().get("generation"))


def config_source() -> str:
    """"ddb" | "builtin" —— 供诊断与 metric 用（spec R9.4/R9.5）。"""
    return str(get_config().get("_source") or "")


# ---------------------------------------------------------------------------
# 只读诊断（spec R9.4 / task 9.2）
# ---------------------------------------------------------------------------
# 排障时最先要回答的问题是「**这个正在跑的实例**当前用的是哪一代配置、来自 DDB 还是内置
# 兜底」。此前没有任何办法问出来：`config_source()` 有定义但零调用方，metric 只给计数不给
# generation 的值，而 webchat runtime 与 IM bot 都是长驻进程、各自持有独立的 TTL 缓存 ——
# 于是「混合态」（几个实例分别在不同代上）既真实存在又完全不可见。
#
# 机制：**只在发生迁移时**打一行结构化日志（首次加载 / generation 变化 / 来源在
# ddb↔builtin 之间翻转）。这几个时刻恰好就是想知道的时刻，而按代打点又不会像"每轮对话
# 打一行"那样淹掉日志。单行 JSON + 固定前缀 `llmcfg_status`，便于 Logs Insights 直接筛。
# 跨端查询语句由 BFF 的 `GET /admin/llm-config/status` 一并给出（各端日志组名由 CDK
# 生成、不稳定，所以不在代码里写死）。
#
# **绝不记录凭证**：只有代号、来源、计数与别名（spec R5.5）。
_last_status_key: tuple | None = None


def status(cfg: dict | None = None) -> dict:
    """本端当前生效配置的只读快照。无副作用（除了可能触发一次 TTL 刷新）。"""
    cfg = cfg if cfg is not None else get_config()
    entry = _default_entry(cfg)
    return {
        "surface": _SURFACE,
        "enabled_flag": _ENABLED,
        "generation": _as_int(cfg.get("generation")),
        "source": str(cfg.get("_source") or ""),
        "default_alias": str(entry["alias"]) if entry else "",
        "enabled_models": len(enabled_entries(cfg)),
        "credential_mode": str(cfg.get("credential_mode") or "iam"),
        "catalog_ttl_s": _CATALOG_TTL,
        "force_refresh_min_interval_s": _FORCED_REFRESH_MIN_INTERVAL,
        "output_target": _OUTPUT_TARGET,
    }


def _note_status(cfg: dict) -> None:
    """生效配置发生迁移时打一行 `llmcfg_status`。同一代内重复调用不打。"""
    global _last_status_key
    try:
        key = (_as_int(cfg.get("generation")), str(cfg.get("_source") or ""))
        if key == _last_status_key:
            return
        _last_status_key = key
        logger.info("llmcfg_status %s",
                    _json.dumps(status(cfg), separators=(",", ":"), sort_keys=True))
    except Exception:  # noqa: BLE001 — 诊断不得成为故障源
        pass


def _default_entry(cfg: dict) -> dict | None:
    """本端可用的默认条目。

    `default_model` 是**全局**设置，但某个模型可能不在本端的 `surfaces` 里
    （例：Claude Haiku 只在 webchat 开放）。此时必须回落到本端第一个启用项——
    否则调用方拿到一个本端无法解析的 alias，会静默落到硬编码默认，
    admin 的选择被吞掉（2026-08 由 task 0.2 的测试抓到）。
    """
    entries = _entries(cfg)
    want = str(cfg.get("default_model") or "")
    for m in entries:
        if m["alias"] == want and m.get("enabled"):
            return m
    for m in entries:
        if m.get("enabled"):
            if want:
                logger.warning(
                    "llm_config: default_model %r unavailable on surface %r; using %r",
                    want, _SURFACE, m["alias"])
            return m
    return entries[0] if entries else None


def default_alias() -> str:
    """本端可用的默认模型 alias（见 `_default_entry` 的 surface 回落规则）。"""
    entry = _default_entry(get_config())
    if entry is not None:
        return str(entry["alias"])
    return str(_BUILTIN_CATALOG["default_model"])


def _entries(cfg: dict | None = None) -> list[dict]:
    cfg = cfg or get_config()
    return [m for m in cfg.get("models", []) if _SURFACE in m.get("surfaces", [])]


def entries(cfg: dict | None = None) -> list[dict]:
    """本端可用的**全部**条目，含已被 Admin 停用的（顺序即目录顺序）。

    仅供「描述一个已受信的 model_id」用途 —— 典型是 `model_catalog.find_by_model_id()`
    要给某个 model_id 反查输出上限。停用一个模型不该让在途请求的上限退化到全局保守值
    （那会重开 2026-06-05 的来源块截断事故）。
    **不得用于准入判定**，准入用 `is_enabled()`。
    """
    return list(_entries(cfg))


def enabled_entries(cfg: dict | None = None) -> list[dict]:
    """本端可用且被 Admin 启用的条目（顺序即展示顺序）。"""
    return [m for m in _entries(cfg) if m.get("enabled")]


def enabled_aliases(cfg: dict | None = None) -> list[str]:
    return [m["alias"] for m in enabled_entries(cfg)]


def is_enabled(alias: str | None, cfg: dict | None = None) -> bool:
    """启用集准入判定（spec R3.5）。接受规范 alias、short、legacy alias。"""
    a = (alias or "").strip().lower()
    if not a:
        return False
    for m in enabled_entries(cfg):
        if a == m["alias"] or a == (m.get("short") or "") or a in m.get("aliases_legacy", []):
            return True
    return False


def _find(alias: str, cfg: dict) -> dict | None:
    a = (alias or "").strip().lower()
    if not a:
        return None
    for m in _entries(cfg):
        if a == m["alias"] or a == (m.get("short") or "") or a in m.get("aliases_legacy", []):
            return m
    return None


def _resolve_entry(m: dict) -> ResolvedModel:
    override = (m.get("output_override") or {}).get(_SURFACE)
    max_out = override if override else min(m["hard_output_limit"], _OUTPUT_TARGET)
    return ResolvedModel(
        alias=m["alias"],
        model_id=(m.get("model_id_override") or {}).get(_SURFACE) or m["model_id"],
        label=m["label"],
        kind=m["kind"],
        region=m.get("region"),
        max_output_tokens=max_out,
        supports_prompt_cache=bool(m.get("supports_prompt_cache")),
    )


def resolve_entry(raw: dict) -> ResolvedModel:
    """把**给定的**目录条目解析成本端参数，不做查找、不做启用集替换。

    与 `resolve(alias)` 的区别很关键：后者对不在启用集内的 alias 会替换成默认模型
    （这是用户选择路径想要的行为），因此**不能**用来描述一个已停用的条目 —— 会拿到
    默认模型的 model_id 和上限。`model_catalog.find_by_model_id()` 需要的正是后者：
    给一个已受信的 model_id 反查它自己的输出上限，即使它刚被 Admin 停用。
    """
    return _resolve_entry(raw)


def resolve(alias: str | None, payload_generation=None,
            cfg: dict | None = None) -> ResolvedModel:
    """alias → 本端可直接用的模型参数。

    不在启用集内（含 Admin 缩减启用集后的存量会话偏好）→ 回退默认模型
    （spec R3.3；调用方可用 `was_substituted()` 判断是否需要提示用户）。

    `cfg`：调用方已经取过一份配置时传进来，用于把「遍历目录逐条解析」变成一次原子读。
    不传则自行取（TTL 缓存命中时几乎无成本，但**跨多次调用不保证同一代**：TTL 若在
    循环中途到期，前几条会用旧代、后几条用新代，得到一个混合结果）。
    """
    cfg = cfg if cfg is not None else get_config(payload_generation)
    entry = _find(alias or "", cfg)
    if entry is not None and entry.get("enabled"):
        return _resolve_entry(entry)
    default = _default_entry(cfg)
    if default is None:  # 理论不可达（_normalise 已保证目录非空），兜底防御
        default = _entries(cfg)[0]
    # 只在**确实点了**某个模型却被换掉时计数：alias 为空是"没指定、走默认"，属正常路径，
    # 计进去会把这个指标变成流量计数器。alias 本身不作维度（高基数，会炸指标数）——
    # 需要知道被换掉的是哪个就查同一行的 requested 字段。
    if (alias or "").strip():
        _emit("ModelSubstituted", requested_kind=("unknown" if entry is None else "disabled"))
    return _resolve_entry(default)


def was_substituted(alias: str | None, payload_generation=None) -> bool:
    """请求的 alias 是否被换成了默认模型（用于回复 metadata / 前端提示）。"""
    a = (alias or "").strip().lower()
    if not a:
        return False
    cfg = get_config(payload_generation)
    entry = _find(a, cfg)
    return entry is None or not entry.get("enabled")


def backend_task_alias(task: str) -> str:
    """后端任务（phd_translate / devops_report_summarize）的模型 alias。
    未配置或配置失效 → 默认模型（spec R8.1.3）。"""
    cfg = get_config()
    val = str((cfg.get("backend_tasks") or {}).get(task) or "").strip().lower()
    if val and is_enabled(val, cfg):
        return val
    return str(cfg["default_model"])


# ---------------------------------------------------------------------------
# Bedrock API Key（凭证模式 api_key 时生效）
# ---------------------------------------------------------------------------
def credential_mode() -> str:
    """"iam" | "api_key"。"""
    return str(get_config().get("credential_mode") or "iam")


def get_bedrock_api_key() -> str | None:
    """读 Bedrock API Key（TTL 缓存）。凭证模式非 api_key、或读取失败 → None（回退 IAM）。

    ⚠️ 返回值是凭证：禁止写日志、禁止进回复、禁止进异常信息（spec R5.5）。
    """
    global _cached_key, _cached_key_ts

    # 关闭态连 Secret 都不读：这个开关的语义是"本端完全不参与新机制"，
    # 而 credential_mode 本身就来自被旁路掉的那份配置。
    if not _ENABLED:
        return None
    if credential_mode() != "api_key":
        return None

    now = time.time()
    with _lock:
        if _cached_key and (now - _cached_key_ts) < _KEY_TTL:
            return _cached_key

    try:
        import json
        raw = boto3.client("secretsmanager").get_secret_value(
            SecretId=_BEDROCK_KEY_SECRET)["SecretString"]
        parsed = json.loads(raw) if raw.strip().startswith("{") else {"bedrock_api_key": raw}
        key = str(parsed.get("bedrock_api_key") or parsed.get("api_key") or "").strip()
    except Exception as e:  # noqa: BLE001 — 凭证读取失败回退 IAM，不中断对话
        logger.warning("llm_config: bedrock api key read failed (%s); falling back to IAM",
                       _safe_err(e))
        return None

    if not key:
        logger.warning("llm_config: bedrock api key empty; falling back to IAM")
        return None

    with _lock:
        _cached_key = key
        _cached_key_ts = time.time()
    return key


# ── 「这次失败是不是凭证被拒」的判据 ────────────────────────────────────────
#
# 放在这里而不是各调用点，因为 IM Converse（core/bedrock_credentials）与 webchat runtime
# （agent-build 的 model/load.py）都要用同一份判断，而这个模块本来就是两端共有的。
# 后端任务（shared/llm_provider）另有一份 —— 那个 Lambda 不一定打包 core/，见那边注释。
#
# **实测决定了这份判据的形状**（us-east-2，2026-08，本部署账号）：
#
#   Converse + 已吊销的 Key → HTTP 403  AccessDeniedException
#       "Authentication failed: Please make sure your API Key is valid."
#   Converse + 授权不足     → HTTP 403  AccessDeniedException
#       "User: arn:... is not authorized to perform: bedrock:InvokeModel on resource: ..."
#   Mantle   + 已吊销的 Key → HTTP 401  invalid_api_key
#
# 也就是说 **Converse 上「Key 已死」和「Key 不许调这个模型」共用 403 + AccessDeniedException**，
# 唯一的线上区分信号是 message 文本。第一版判据写的是「只认 401，绝不认 403」，理由是
# 403 属于授权不足、是本部署的常态 —— 那半句没错，但漏了另一半：**死 Key 在 Converse 上
# 根本不回 401**。结果是 Converse 侧的失效永远不触发，KeyAuthFail 指标在最可能的三种
# 吊销路径（删 IAM user / Key 过期 / Key 停用）上一动不动，而那个指标的文档写着
# 「Key 被轮换或撤销时这里是唯一信号」。Mantle 侧的 401 判据是对的，保留。
#
# 靠 message 匹配当然不理想 —— 它不是 API 契约，AWS 改文案就会失效。但这是唯一可用的
# 信号，且两个方向的代价不对称：
#   · 漏判（AWS 改了文案）→ 退回今天的行为：Key 缓存等 TTL 到期，最多 300s 失败。
#   · 误判（把授权不足当死 Key）→ 每次调用多读一次 Secrets Manager + 一条假 KeyAuthFail。
# 所以两个短语都参与判断：命中「认证失败」才算凭证问题，且显式排除标准的
# 「is not authorized to perform」措辞，免得将来两种情形被合并成一句话时误伤。
_AUTH_FAIL_CODES = frozenset({
    "UnrecognizedClientException",   # token 不被识别（已删除 / 拼错 / 跨账号）
    "InvalidSignatureException",     # 签名不匹配
    "ExpiredTokenException",         # 临时凭证过期
    "UnauthorizedException",         # 部分 service 用这个表达 401
    "HttpAuthenticationException",
})
# 死凭证的特征短语（小写比较）。实测见上方表格。
_CREDENTIAL_DEAD_PHRASE = "authentication failed"
# 授权不足的标准 IAM 措辞。命中它一律不算凭证问题，哪怕同时命中上面那句。
_AUTHZ_DENIED_PHRASE = "is not authorized to perform"


def is_credential_rejected(status, code: str = "", message: str = "") -> bool:
    """这次失败是否意味着「凭证本身不成立」（而非授权不足 / 限流 / 参数错）。

    命中任一即为真：
      · HTTP 401 —— Mantle 走这条
      · error code 属于 `_AUTH_FAIL_CODES`
      · HTTP 403 + `AccessDeniedException` + message 含「authentication failed」
        且不含「is not authorized to perform」—— Converse 上死 Key 走这条

    调用方只需把拿到的三样原样传进来；本函数不读全局状态、不发指标、不抛异常，
    便于两端复用与单测。**message 只用于判断，绝不可回传给用户或写日志**
    （上游文案可能含账号 / 资源 ARN，spec R5.5）。
    """
    if status == 401:
        return True
    if code in _AUTH_FAIL_CODES:
        return True
    if status == 403 and code == "AccessDeniedException":
        low = (message or "").lower()
        if _AUTHZ_DENIED_PHRASE in low:
            return False
        return _CREDENTIAL_DEAD_PHRASE in low
    return False

# 凭证纪元 —— 每次 Key 被判定失效就 +1。
#
# 为什么需要它，而不是「清掉 Key 缓存就够了」：botocore 在**构造 client 时**把 bearer
# token 冻进去，之后每请求只重新决定「走 bearer 还是 SigV4」，**不重新取值**。而 webchat
# 的 client 活在被缓存的 Agent 里（LRU，session 最长 8h）。所以清掉 `_cached_key` 只影响
# 「下一次构造」，对已经建好的 client 毫无作用 —— 那个 client 会一直用冻结的旧 token，
# 每轮 401，直到 microVM 回收。IM 侧用 `lazy_boto.reset_all()` 解决；webchat 没有等价物。
#
# 做法是把这个纪元并入 Agent 缓存键（见 webchat 的 `core/agent_cache.build_key`）：
# 纪元一变，键就变 → 缓存 miss → 重建 Agent → 重建 client → 重新读 Secret、冻结新 token。
# 旧条目靠 LRU 自然老化，不需要额外的逐出 API，也不需要从 botocore 的回调里跨线程去掏
# `main.py` 闭包里的那个缓存字典。
#
# IM 侧读不读它都无所谓（那边靠 reset_all），但计数本身是无害且便宜的，两端共用一份实现。
_cred_epoch = 0


def credential_epoch() -> int:
    """当前凭证纪元。调用方把它并入需要「凭证一换就重建」的缓存键。"""
    return _cred_epoch

def invalidate_api_key() -> None:
    """Key 认证失败（401）时调用：立即失效缓存，下次重新读 Secret（spec R7.2）。

    调用方（覆盖边界，改动前先读这段）：
      · IM Converse —— `core/bedrock_credentials._on_after_call`，通过 botocore
        `after-call.bedrock-runtime` 事件挂在全部 8 个 LazyClient 上（构造后钩子）。
      · IM Mantle  —— `core/openai_responses_client._note_bearer_rejection`。
      · 后端任务    —— `shared/llm_provider._invalidate_bedrock_api_key`。它另有一份
        **独立**的 Key 缓存，所以那边先清自己的，再调这里发指标。
      · webchat runtime —— Converse 走 `model/load.py::_attach_key_rejection_listener`
        （挂在 `BedrockModel.client` 上，那是公开属性）；Mantle 走同文件
        `_MantleResponsesModel._resolve_client_args` 的每请求重读。
        此处曾写「不覆盖，Strands 自建客户端挂不上事件，靠 300s TTL 自愈」——
        **两句都是错的**：`client` 一直是公开属性，挂事件不需要传 `boto_session`，
        也就不会改变 region 与凭证解析路径；而「TTL 自愈」更不成立 —— botocore 在
        **构造 client 时**把 bearer token 冻进去，之后每请求只重新决定走 bearer 还是
        SigV4、不重新取值，所以清掉 Key 缓存对已建好的 client 毫无作用。webchat 的
        client 又活在被缓存的 Agent 里（LRU，session 最长 8h），于是一次外部轮换能让
        整个会话每轮 401 到 microVM 回收。真正让它自愈的是 `credential_epoch()`：
        本函数把纪元 +1，纪元进 Agent 缓存键，下一轮 miss 重建。

    只认 401、不认 403：403 是「Key 有效但不许调这个模型」（Admin 按模型收窄 Key 是
    本部署常态），当失效处理只会白读 Secret 并把本指标刷成噪声。
    """
    global _cached_key, _cached_key_ts
    # Key 被轮换 / 撤销时这里是唯一信号。没有 metric 的话，表现只是"推理偶发失败后
    # 自己好了"，查不出根因。**绝不记录 Key 本身或其任何片段**（spec R5.5）。
    _emit("KeyAuthFail")
    global _cred_epoch
    with _lock:
        _cached_key = None
        _cached_key_ts = 0.0
        # 纪元 +1：让「凭证一换就重建」的缓存键失效。清 _cached_key 只影响下一次构造，
        # 已建好的 client 里 token 是冻结的（见 credential_epoch 的说明）。
        _cred_epoch += 1


def reset_cache() -> None:
    """测试用：清空全部缓存。**不重置凭证纪元** —— 纪元是单调计数，重置它会让
    「纪元变了就该重建」这条不变式在测试里失真；要观察纪元就读 credential_epoch()。"""
    global _cached_cfg, _cached_cfg_ts, _last_forced_refresh_ts, _cached_key, _cached_key_ts
    with _lock:
        _cached_cfg = None
        _cached_cfg_ts = 0.0
        _last_forced_refresh_ts = 0.0
        _cached_key = None
        _cached_key_ts = 0.0


__all__ = [
    "ResolvedModel",
    "get_config", "generation", "config_source",
    "default_alias", "enabled_entries", "enabled_aliases", "is_enabled",
    "resolve", "was_substituted", "backend_task_alias",
    "credential_mode", "get_bedrock_api_key", "invalidate_api_key",
    "is_credential_rejected", "credential_epoch",
    "status",
    "reset_cache",
]
