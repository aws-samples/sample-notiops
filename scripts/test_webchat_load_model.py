"""
webchat 模型构造测试（spec task 3.1 验收）。

`model/load.py` 改为由 DDB 目录驱动后，必须保证**构造出的模型参数与改造前逐项一致**
（否则是回归：输出上限变小会截断长回答、prompt cache 误开会 API 报错、Mantle 区域
错会打到不存在的端点）。

覆盖：
  * BedrockModel 参数：model_id / max_tokens / cache_tools+cache_prompt 三者与目录一致
  * Mantle 路径：model_id / region / params.max_output_tokens，且 base_url 的
    `/openai/v1` 修补仍生效（Strands 模板缺 `/openai` 的既有坑）
  * Mantle 构造失败 → 回退到**非 Mantle** 模型（不能回退到另一个 Mantle 模型，
    否则再次走进同一条失败路径）
  * 未知 / 已下线 alias → 回退默认，且 `resolve_model_id()` 如实返回**实际生效**的
    model id（落款不能显示用户以为的那个）
  * DDB 不可用 → 内置兜底目录仍能构造出可用模型

不触网：Strands 模型类与 DDB 均被 stub。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_webchat_load_model.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import types

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
APP = os.path.join(ROOT, "agent-build", "NotiOpsWebChat", "app", "NotiOpsWebChat")
sys.path.insert(0, APP)
os.environ.setdefault("CONFIG_TABLE", "test-config")

PASS = "✅"
FAIL = "❌"
_failed = 0

SEED = json.load(open(os.path.join(ROOT, "config", "llm-model-catalog.json")))
WEBCHAT_TARGET = 32768


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


# ---------------------------------------------------------------------------
# Stub strands before importing model.load
# ---------------------------------------------------------------------------
class _StubEvents:
    """假 botocore 事件系统。真 botocore 在**注册时**就要求 handler 接受 `**kwargs`，
    这里照做 —— 否则 handler 少了 `**kwargs` 时真 botocore 会抛、而 load.py 的
    try/except 会把它吞掉，监听器根本没挂上而测试照样全绿。"""

    def __init__(self):
        self.registered: list[tuple] = []

    def register(self, event_name, handler, **kwargs):
        import inspect
        if not any(p.kind is inspect.Parameter.VAR_KEYWORD
                   for p in inspect.signature(handler).parameters.values()):
            raise ValueError(
                f"Event handler {handler} must accept keyword arguments (**kwargs)")
        self.registered.append((event_name, handler))


class _StubClientMeta:
    def __init__(self):
        self.events = _StubEvents()


class _StubBedrockModel:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        # Strands 的 BedrockModel 把它自建的 boto3 客户端暴露成公开属性 `client`
        # （strands 1.51 models/bedrock.py:215）。load.py 靠它挂 Key 失效监听，
        # 所以 stub 必须有 —— 缺了监听器会静默挂不上（异常被吞），测试却是绿的。
        self.client = type("_C", (), {"meta": _StubClientMeta()})()


class _StubOpenAIResponsesModel:
    """记录构造参数，并暴露一个可被子类覆盖的 _resolve_client_args。"""

    #: 由测试设置：模拟 Strands 给出的（缺 /openai 的）base_url
    base_url_from_sdk = "https://bedrock-mantle.us-east-2.api.aws/v1"
    #: 由测试设置：构造时抛异常，模拟依赖缺失 / 区域未开通
    raise_on_init = False

    def __init__(self, **kwargs):
        if _StubOpenAIResponsesModel.raise_on_init:
            raise RuntimeError("simulated mantle unavailable")
        self.kwargs = kwargs

    def _resolve_client_args(self):
        return {"base_url": _StubOpenAIResponsesModel.base_url_from_sdk}


class _StubCacheConfig:
    """镜像 strands.models.model.CacheConfig 的字段（strategy / ttl）。"""

    def __init__(self, strategy=None, ttl=None):
        self.strategy = strategy
        self.ttl = ttl


class _StubCacheToolsConfig:
    """镜像 strands.models.model.CacheToolsConfig 的字段（type / ttl）。"""

    def __init__(self, type=None, ttl=None):  # noqa: A002 — 镜像上游字段名
        self.type = type
        self.ttl = ttl


def _install_strands_stubs():
    strands = types.ModuleType("strands")
    models = types.ModuleType("strands.models")
    bedrock = types.ModuleType("strands.models.bedrock")
    openai_responses = types.ModuleType("strands.models.openai_responses")
    # **必须注册 `strands.models.model`**：`model/load.py` 用守卫导入从这里取
    # CacheConfig / CacheToolsConfig，取不到就把 `_HAS_CACHE_CONFIG` 置 False 并走老的
    # `cache_prompt` 分支。少注册这一个模块的后果不是报错，而是**整套测试静默去测一条
    # 生产永不执行的分支**：现网 strands 已到 1.50.2（pyproject 已提），生产走的是
    # CacheConfig 分支，而本文件断言的却是 `cache_prompt == "default"` —— 那正是新版里
    # 已 deprecated、被有意移除的写法。而本文件是**唯一**逐条遍历目录、校验 BedrockModel
    # 全部构造参数的测试，测错分支等于那份保证整体失效。
    model_mod = types.ModuleType("strands.models.model")
    model_mod.CacheConfig = _StubCacheConfig
    model_mod.CacheToolsConfig = _StubCacheToolsConfig
    bedrock.BedrockModel = _StubBedrockModel
    openai_responses.OpenAIResponsesModel = _StubOpenAIResponsesModel
    models.bedrock = bedrock
    models.openai_responses = openai_responses
    models.model = model_mod
    strands.models = models
    for name, mod in (("strands", strands), ("strands.models", models),
                      ("strands.models.bedrock", bedrock),
                      ("strands.models.model", model_mod),
                      ("strands.models.openai_responses", openai_responses)):
        sys.modules[name] = mod


_install_strands_stubs()

from core import llm_config  # noqa: E402
from model import load as load_mod  # noqa: E402


class _FakeTable:
    def __init__(self, models=None, default="claude-sonnet-5", raise_exc=False):
        self.models = SEED["models"] if models is None else models
        self.default = default
        self.raise_exc = raise_exc

    def get_item(self, Key=None, ConsistentRead=False):  # noqa: N803
        if self.raise_exc:
            raise RuntimeError("simulated DDB outage")
        return {"Item": {
            "PK": "llmcfg", "SK": "meta",
            "generation": int(time.time() * 1000),
            "provider": "bedrock", "credential_mode": "iam",
            "default_model": self.default, "models": self.models,
        }}


def _use(models=None, default="claude-sonnet-5", raise_exc=False):
    llm_config.reset_cache()
    llm_config._table = lambda: _FakeTable(models, default, raise_exc)  # noqa: SLF001


def _webchat_seed_entries():
    return [m for m in SEED["models"] if "webchat" in m["surfaces"] and m["enabled"]]


def _expected_cap(entry: dict) -> int:
    ov = (entry.get("output_override") or {}).get("webchat")
    return ov if ov is not None else min(entry["hard_output_limit"], WEBCHAT_TARGET)


# ---------------------------------------------------------------------------
def test_bedrock_params_match_catalogue():
    print("test_bedrock_params_match_catalogue")
    _use()
    for entry in _webchat_seed_entries():
        if entry["kind"] == "bedrock_mantle_responses":
            continue
        model = load_mod.load_model(entry["alias"])
        _check(f"{entry['alias']}: BedrockModel constructed",
               isinstance(model, _StubBedrockModel))
        kw = getattr(model, "kwargs", {})
        want_mid = (entry.get("model_id_override") or {}).get("webchat") or entry["model_id"]
        _check(f"{entry['alias']}: model_id", kw.get("model_id") == want_mid,
               f"got={kw.get('model_id')} want={want_mid}")
        _check(f"{entry['alias']}: max_tokens == {_expected_cap(entry)}",
               kw.get("max_tokens") == _expected_cap(entry), f"got={kw.get('max_tokens')}")
        if entry["supports_prompt_cache"]:
            # 生产走的是 CacheConfig 分支（strands ≥ 1.46，现网 1.50.2）。断言这一条，
            # 而不是已 deprecated 的 `cache_prompt` —— 后者是 stub 少注册
            # `strands.models.model` 时才会走到的兼容分支。
            _check(f"{entry['alias']}: prompt cache uses CacheConfig (production branch)",
                   load_mod._HAS_CACHE_CONFIG,
                   "the stub did not register strands.models.model")
            _check(f"{entry['alias']}: cache_tools is CacheToolsConfig",
                   isinstance(kw.get("cache_tools"), _StubCacheToolsConfig), str(kw))
            _check(f"{entry['alias']}: cache_config strategy=auto",
                   getattr(kw.get("cache_config"), "strategy", None) == "auto", str(kw))
            # TTL 按模型门控：支持 1h 的必须拿到 "1h"，其余必须是 None（=Bedrock 默认 5m）。
            # 传一个模型不支持的 TTL 会被 ValidationException 拒 —— 与 max_tokens 同类教训。
            want_ttl = load_mod._cache_ttl_for(want_mid)
            _check(f"{entry['alias']}: cache_tools ttl == {want_ttl!r}",
                   getattr(kw.get("cache_tools"), "ttl", "MISSING") == want_ttl, str(kw))
            _check(f"{entry['alias']}: cache_config ttl == {want_ttl!r}",
                   getattr(kw.get("cache_config"), "ttl", "MISSING") == want_ttl, str(kw))
            _check(f"{entry['alias']}: deprecated cache_prompt NOT set",
                   "cache_prompt" not in kw, str(kw))
        else:
            _check(f"{entry['alias']}: prompt cache NOT set (would break API)",
                   not any(k.startswith("cache_") for k in kw), str(kw))


def test_mantle_path():
    print("test_mantle_path")
    _use()
    _StubOpenAIResponsesModel.raise_on_init = False
    mantle_entries = [e for e in _webchat_seed_entries()
                      if e["kind"] == "bedrock_mantle_responses"]
    _check("seed has at least one mantle model", bool(mantle_entries))
    for entry in mantle_entries:
        model = load_mod.load_model(entry["alias"])
        _check(f"{entry['alias']}: mantle model constructed",
               isinstance(model, _StubOpenAIResponsesModel))
        kw = getattr(model, "kwargs", {})
        _check(f"{entry['alias']}: model_id", kw.get("model_id") == entry["model_id"],
               f"got={kw.get('model_id')}")
        _check(f"{entry['alias']}: region from catalogue",
               (kw.get("bedrock_mantle_config") or {}).get("region") == entry["region"],
               str(kw.get("bedrock_mantle_config")))
        _check(f"{entry['alias']}: max_output_tokens == {_expected_cap(entry)}",
               (kw.get("params") or {}).get("max_output_tokens") == _expected_cap(entry),
               str(kw.get("params")))
        # base_url 修补：Strands 模板缺 /openai，必须被补上（幂等）
        fixed = model._resolve_client_args().get("base_url")  # noqa: SLF001
        _check(f"{entry['alias']}: base_url patched to /openai/v1",
               fixed.endswith("/openai/v1"), fixed)

    # 幂等性：SDK 若已修好模板，不应重复插入
    _StubOpenAIResponsesModel.base_url_from_sdk = \
        "https://bedrock-mantle.us-east-2.api.aws/openai/v1"
    model = load_mod.load_model(mantle_entries[0]["alias"])
    fixed = model._resolve_client_args().get("base_url")  # noqa: SLF001
    _check("base_url patch is idempotent", fixed.count("/openai") == 1, fixed)
    _StubOpenAIResponsesModel.base_url_from_sdk = \
        "https://bedrock-mantle.us-east-2.api.aws/v1"


def test_mantle_failure_falls_back_to_non_mantle():
    print("test_mantle_failure_falls_back_to_non_mantle")
    _use()
    _StubOpenAIResponsesModel.raise_on_init = True
    mantle = next(e for e in _webchat_seed_entries()
                  if e["kind"] == "bedrock_mantle_responses")
    model = load_mod.load_model(mantle["alias"])
    _check("mantle failure yields a BedrockModel (not an exception)",
           isinstance(model, _StubBedrockModel), type(model).__name__)

    # 默认模型本身是 Mantle 时，不得回退到另一个 Mantle（会再次走进失败路径）
    mantle_only_default = mantle["alias"]
    _use(default=mantle_only_default)
    model = load_mod.load_model(mantle["alias"])
    _check("mantle default still falls back to a non-mantle model",
           isinstance(model, _StubBedrockModel), type(model).__name__)
    if isinstance(model, _StubBedrockModel):
        mid = model.kwargs.get("model_id", "")
        _check("fallback model is not an openai/mantle id",
               not mid.startswith("openai."), mid)
    _StubOpenAIResponsesModel.raise_on_init = False


def test_unknown_alias_falls_back_and_reports_truthfully():
    print("test_unknown_alias_falls_back_and_reports_truthfully")
    _use()
    default_spec_id = load_mod.resolve_model_id(None)
    for bad in ("us.anthropic.claude-x", "", None, "not-a-model", "claude-sonnet-4-6"):
        # claude-sonnet-4-6 在种子里 enabled=false —— 属于「已下线」情形
        mid = load_mod.resolve_model_id(bad)
        _check(f"resolve_model_id({bad!r}) reports the effective model",
               mid == default_spec_id, f"got={mid} want={default_spec_id}")
        model = load_mod.load_model(bad)
        _check(f"load_model({bad!r}) still constructs a model",
               model is not None)


def test_ddb_outage_uses_builtin():
    print("test_ddb_outage_uses_builtin")
    _use(raise_exc=True)
    model = load_mod.load_model("claude-sonnet-5")
    _check("builtin fallback constructs a model", isinstance(model, _StubBedrockModel))
    if isinstance(model, _StubBedrockModel):
        _check("builtin model_id is non-empty",
               bool(model.kwargs.get("model_id")), str(model.kwargs))
        _check("builtin max_tokens is positive",
               (model.kwargs.get("max_tokens") or 0) > 0, str(model.kwargs))
    _check("resolve_model_id works during outage",
           bool(load_mod.resolve_model_id("claude-sonnet-5")))


def test_disabled_model_not_served():
    print("test_disabled_model_not_served")
    _use()
    disabled = [m for m in SEED["models"] if not m["enabled"]]
    for entry in disabled:
        mid = load_mod.resolve_model_id(entry["alias"])
        want_mid = (entry.get("model_id_override") or {}).get("webchat") or entry["model_id"]
        _check(f"disabled {entry['alias']!r} is not served",
               mid != want_mid, f"got={mid}")


_BEARER = "AWS_BEARER_TOKEN_BEDROCK"


def _set_key_provider(value):
    """打桩 llm_config.get_bedrock_api_key → 固定返回 value（str 或 None）。"""
    llm_config.get_bedrock_api_key = lambda: value


def test_api_key_injected_on_bedrock_path():
    """spec R5.2 / R5.3：非 Mantle 构造时按凭证模式注入 / 清除 AWS_BEARER_TOKEN_BEDROCK。"""
    print("test_api_key_injected_on_bedrock_path")
    _use()
    orig = llm_config.get_bedrock_api_key
    try:
        # (1) 配了 Key → env 被设成该 Key（且模型正常构造）
        os.environ.pop(_BEARER, None)
        _set_key_provider("bedrock-key-abc123")
        model = load_mod.load_model("claude-sonnet-5")
        _check("non-mantle build sets the bearer token to the key",
               os.environ.get(_BEARER) == "bedrock-key-abc123", os.environ.get(_BEARER))
        _check("a BedrockModel was still constructed", isinstance(model, _StubBedrockModel))

        # (2) 无 Key（credential_mode=iam / 读失败）→ env 被 pop，回退 IAM
        _set_key_provider(None)
        load_mod.load_model("claude-sonnet-5")
        _check("no key → bearer token removed (IAM fallback)", _BEARER not in os.environ,
               os.environ.get(_BEARER))

        # (3) 纪律②：长驻进程里上一代残留的 Key 必须被清掉，而不是留着
        os.environ[_BEARER] = "STALE-OLD-KEY"
        _set_key_provider(None)
        load_mod.load_model("claude-sonnet-5")
        _check("stale key is popped when the key is cleared (discipline ②)",
               _BEARER not in os.environ, os.environ.get(_BEARER))

        # (4) 轮换：新 Key 覆盖旧 Key
        os.environ[_BEARER] = "OLD"
        _set_key_provider("NEW-rotated-key")
        load_mod.load_model("claude-sonnet-5")
        _check("rotated key overwrites the previous one",
               os.environ.get(_BEARER) == "NEW-rotated-key", os.environ.get(_BEARER))
    finally:
        llm_config.get_bedrock_api_key = orig
        os.environ.pop(_BEARER, None)


def test_mantle_path_passes_key_as_api_key():
    """Mantle 用 Key 的方式是 OpenAI 客户端的 `api_key`，**不是** env bearer token。

    Strands 的 Mantle 分支默认每请求用 IAM 自铸 bearer、不读 `AWS_BEARER_TOKEN_BEDROCK`，
    所以 `_make_mantle_responses_model` 显式把 Admin 配的 Key 写进 `_resolve_client_args`
    的 `api_key`。Mantle 端点本来就以 `Authorization: Bearer <key>` 接受 Bedrock API Key。

    这条测试是补的：此前本文件只断言 `base_url` 被修补，`api_key` 覆盖**零覆盖** ——
    把那两行删掉全套测试照样绿。而这偏偏是有生产 CloudTrail 证据的那条路（未接 Key 时
    Claude 的 caller 是 Key 背后的 IAM user，GPT 却是 runtime 的 execution_role）。
    """
    print("test_mantle_path_passes_key_as_api_key")
    _use()
    _StubOpenAIResponsesModel.raise_on_init = False
    orig = llm_config.get_bedrock_api_key
    mantle = next(e for e in _webchat_seed_entries()
                  if e["kind"] == "bedrock_mantle_responses")
    try:
        # (1) 配了 Key → api_key 必须是它
        os.environ.pop(_BEARER, None)
        _set_key_provider("mantle-should-use-this-key")
        model = load_mod.load_model(mantle["alias"])
        _check("mantle model constructed", isinstance(model, _StubOpenAIResponsesModel))
        args = model._resolve_client_args()  # noqa: SLF001
        _check("mantle passes the key as api_key",
               args.get("api_key") == "mantle-should-use-this-key", str(args.get("api_key")))
        # base_url 修补必须同时仍然生效（两件事在同一个覆盖方法里，别让一个吃掉另一个）
        _check("base_url still patched alongside the key",
               str(args.get("base_url", "")).endswith("/openai/v1"), str(args.get("base_url")))
        # Key 走 api_key，**不经** env —— 否则会污染同进程里的 Converse 客户端
        _check("mantle path does NOT set the bearer env var",
               _BEARER not in os.environ, os.environ.get(_BEARER))

        # (2) 没配 Key → 不覆盖，保持 Strands 自铸的 IAM bearer
        _set_key_provider(None)
        model2 = load_mod.load_model(mantle["alias"])
        args2 = model2._resolve_client_args()  # noqa: SLF001
        _check("no key → api_key left untouched (Strands' IAM-minted bearer)",
               "api_key" not in args2, str(args2))
        _check("no key → base_url still patched",
               str(args2.get("base_url", "")).endswith("/openai/v1"), str(args2.get("base_url")))
    finally:
        llm_config.get_bedrock_api_key = orig
        os.environ.pop(_BEARER, None)


def test_mantle_fallback_injects_key():
    """Mantle 不可用 → 回退到真实 BedrockModel，那条兜底路径同样要注入 Key。"""
    print("test_mantle_fallback_injects_key")
    _use()
    _StubOpenAIResponsesModel.raise_on_init = True   # 模拟 Mantle 依赖缺失 / 区域未开通
    orig = llm_config.get_bedrock_api_key
    mantle = next(e for e in _webchat_seed_entries()
                  if e["kind"] == "bedrock_mantle_responses")
    try:
        os.environ.pop(_BEARER, None)
        _set_key_provider("fallback-key-xyz")
        model = load_mod.load_model(mantle["alias"])
        _check("mantle failure falls back to a BedrockModel",
               isinstance(model, _StubBedrockModel), type(model).__name__)
        _check("the fallback BedrockModel also gets the key injected",
               os.environ.get(_BEARER) == "fallback-key-xyz", os.environ.get(_BEARER))
    finally:
        llm_config.get_bedrock_api_key = orig
        _StubOpenAIResponsesModel.raise_on_init = False
        os.environ.pop(_BEARER, None)


def test_key_rejection_listener_is_attached():
    """配了 Key 时必须给 BedrockModel 的客户端挂「Key 被拒」监听（spec R7.2）。

    这条路径此前**完全不覆盖**，理由写的是「Strands 自建客户端，挂不上事件」——
    那不成立，`BedrockModel.client` 是公开属性。挂事件不需要传 `boto_session`，
    也就不会改变 region 与凭证解析路径。
    """
    print("test_key_rejection_listener_is_attached")
    _use()
    _set_key_provider("k-live")
    model = load_mod.load_model("claude-sonnet-5")
    reg = getattr(model, "client").meta.events.registered
    _check("exactly one handler registered", len(reg) == 1, str(reg))
    if reg:
        _check("registered on after-call.bedrock-runtime",
               reg[0][0] == "after-call.bedrock-runtime", reg[0][0])

    # 死 Key 的响应必须触发失效，并把凭证纪元推进 —— 纪元才是 webchat 自愈的那一半
    # （token 在构造时冻进 client，只清 Key 缓存不会让它换 token）。
    before = llm_config.credential_epoch()
    reg[0][1](http_response=type("_R", (), {"status_code": 403})(),
              parsed={"Error": {"Code": "AccessDeniedException",
                                "Message": "Authentication failed: Please make sure "
                                           "your API Key is valid."}})
    _check("dead-key response bumped the credential epoch",
           llm_config.credential_epoch() == before + 1,
           f"{before} -> {llm_config.credential_epoch()}")

    # 授权不足不得推进纪元（否则被收窄的 Key 每次调用都强制重建整个 Agent）
    mid = llm_config.credential_epoch()
    reg[0][1](http_response=type("_R", (), {"status_code": 403})(),
              parsed={"Error": {"Code": "AccessDeniedException",
                                "Message": "User: arn:x is not authorized to perform: "
                                           "bedrock:InvokeModel on resource: arn:y"}})
    _check("authz denial did not bump the epoch",
           llm_config.credential_epoch() == mid, f"{mid} -> {llm_config.credential_epoch()}")


def test_no_listener_without_a_key():
    """IAM 模式下不挂监听 —— 执行角色被拒与 Key 无关，挂了只会误报。"""
    print("test_no_listener_without_a_key")
    _use()
    _set_key_provider(None)
    model = load_mod.load_model("claude-sonnet-5")
    reg = getattr(model, "client").meta.events.registered
    _check("no handler registered in IAM mode", not reg, str(reg))


def test_mantle_reads_the_key_per_request():
    """Mantle 的 api_key 必须**每请求重读**，不能在闭包里捕获一次。

    这个模型实例活在被缓存的 Agent 里（LRU，session 最长 8h），闭包捕获会让它持有的
    Key 比 300s TTL 长得多 —— Key 轮换后 TTL 到期重读对它毫无作用，整个 session
    继续用旧 Key。`_resolve_client_args` 本来就每请求调一次，重读代价近零。
    """
    print("test_mantle_reads_the_key_per_request")
    _use()
    _set_key_provider("k-old")
    model = load_mod.load_model("gpt-5-6")
    args1 = model._resolve_client_args()             # noqa: SLF001
    _check("first request uses the current key",
           args1.get("api_key") == "k-old", str(args1.get("api_key")))

    _set_key_provider("k-rotated")                            # 轮换，实例不变
    args2 = model._resolve_client_args()             # noqa: SLF001
    _check("a rotated key is picked up without rebuilding the model",
           args2.get("api_key") == "k-rotated", str(args2.get("api_key")))

    _set_key_provider(None)                                   # 清空 → 回退 Strands 自铸 IAM bearer
    args3 = model._resolve_client_args()             # noqa: SLF001
    _check("clearing the key stops overriding api_key",
           args3.get("api_key") != "k-rotated", str(args3.get("api_key")))


def main() -> int:
    _bearer_before = os.environ.get(_BEARER)   # 快照，测试结束后原样恢复
    test_bedrock_params_match_catalogue()
    test_mantle_path()
    test_mantle_failure_falls_back_to_non_mantle()
    test_unknown_alias_falls_back_and_reports_truthfully()
    test_ddb_outage_uses_builtin()
    test_disabled_model_not_served()
    test_api_key_injected_on_bedrock_path()
    test_mantle_path_passes_key_as_api_key()
    test_mantle_fallback_injects_key()
    test_key_rejection_listener_is_attached()
    test_no_listener_without_a_key()
    test_mantle_reads_the_key_per_request()
    llm_config.reset_cache()
    if _bearer_before is None:
        os.environ.pop(_BEARER, None)
    else:
        os.environ[_BEARER] = _bearer_before
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
