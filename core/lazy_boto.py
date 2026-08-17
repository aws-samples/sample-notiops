"""Lazy boto3 client proxy — defer construction until first real use.

Why this exists
---------------
Nine modules under `core/` used to build their Bedrock client at *import* time:

    _bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)

That is a problem for two independent reasons.

1. **Bedrock API-key auth breaks outright.** Verified empirically against
   botocore 1.43.19 (see `scripts/test_lazy_bedrock_client.py`), which splits
   the decision across two different moments:

     * *which* signer to use is resolved **per request** — botocore's
       `choose-signer` handler reads `AWS_BEARER_TOKEN_BEDROCK` from the live
       environment on every call;
     * the *token provider* that supplies the token is built **once, when the
       client is constructed**.

   Set the variable after the client exists and those two disagree: botocore
   switches to bearer auth because the variable is now visible, then finds no
   token provider behind it and raises
   `NoAuthTokenError: Unable to locate authorization token` on **every** call.
   So the failure mode is not the "silently falls back to the IAM role" the
   spec assumed — it is a hard outage of all Bedrock traffic the moment an
   admin turns on api_key mode.

   Construction order therefore matters: setenv first, then build. Everywhere
   else in this repo already does that (`shared/llm_provider.py`,
   `shared/bedrock_summarizer.py`, `lambda3_health_checker/bedrock_invoker.py`,
   `lambda4_notifier/health_report_parser.py`); `core/` was the sole exception.

   Clearing the variable is safe on an existing client — the per-request signer
   choice reverts to SigV4 and the IAM credential resolver snapshotted at
   construction still works. Only *gaining* a token needs a rebuild, which is
   what `reset()` below is for.
2. **Importing costs an AWS call path.** In CI / unit tests / `py_compile`
   sweeps, merely importing a module would need a resolvable region and would
   build real client objects.

Design: a `__getattr__`-forwarding proxy, mirroring `core/ddb_state._LazyTable`
which does the same for a DynamoDB Table. The point of the proxy (rather than a
`_bedrock()` accessor function) is that **call sites do not change**:
`_bedrock.invoke_model(...)` and `bedrock_client or _bedrock` both keep working,
so nine modules and their ~13 call sites stay untouched — no chance of missing
one and leaving a half-migrated module behind.

Not thread-safe by design, in the benign sense: two threads racing on first use
may each build a client and one wins. boto3 clients are cheap to construct and
safe to use concurrently, so a duplicate construction is wasted work, never
corruption. Adding a lock here would serialise every attribute access on the
hot path for no real gain.
"""
from __future__ import annotations

import weakref

import boto3

# 全部 LazyClient 实例的弱引用登记表 —— 供 `reset_all()` 在凭证轮换时批量重建。
# 用 WeakSet：登记不阻止 GC，模块级单例（8 个 bedrock 客户端）本就常驻，动态创建的
# 实例回收后自动移除，不泄漏。
_REGISTRY: "weakref.WeakSet[LazyClient]" = weakref.WeakSet()

# 按 service 注册的「构造前钩子」。键为 service 名，值为无参 callable，在该 service 的
# 客户端**每次实际构造之前**被调用一次。用途：Bedrock API Key 注入需要保证
# `AWS_BEARER_TOKEN_BEDROCK` 在 `boto3.client("bedrock-runtime")` 构造**之前**就位
# （botocore 在构造时快照 token provider，设晚了会 NoAuthTokenError 硬失败——见下文）。
# 保持 lazy_boto 通用：这里只存 callable，不 import 任何上层模块（钩子由 core/
# bedrock_credentials 在启动时注册）。
_BUILD_HOOKS: "dict[str, list]" = {}

# 按 service 注册的「构造后钩子」。键为 service 名，值为 `fn(client)`，在该 service 的
# 客户端**每次实际构造之后**被调用一次。
#
# 为什么需要它而不是复用构造前钩子：有些加固只能作用在**已存在的客户端**上。具体动因是
# Bedrock API Key 的失效（spec R7.2）—— Key 被轮换或吊销后，进程内的 Key 缓存要立刻失效，
# 而这个信号只能从「一次调用回了 401/403」里读到。botocore 的做法是往 client 的事件系统
# 注册 `after-call.<service>`，那必须等 client 建好。
# 同样保持 lazy_boto 通用：这里只存 callable，不 import 任何上层模块。
_POST_BUILD_HOOKS: "dict[str, list]" = {}


def register_build_hook(service: str, fn) -> None:
    """为某 service 注册一个构造前钩子（幂等：同一 fn 不重复登记）。

    钩子在该 service 的客户端 **每次构造之前** 被调用（首建 + reset 后重建）。用于在
    构造前把凭证类 env 摆正。钩子应当自身幂等、便宜、线程安全（可能在并发 _resolve 中触发）。
    """
    fns = _BUILD_HOOKS.setdefault(service, [])
    if fn not in fns:
        fns.append(fn)


def register_post_build_hook(service: str, fn) -> None:
    """为某 service 注册一个构造后钩子（幂等：同一 fn 不重复登记）。

    钩子签名 `fn(client)`，在该 service 的客户端 **每次构造之后、被任何调用方看到之前**
    被调用（首建 + reset 后重建）。用于给新客户端挂 botocore 事件处理器之类只能作用在
    实体客户端上的加固。钩子应当自身幂等、便宜、线程安全，且**不得抛出**——抛了也会被
    吞掉（加固不能成为构造的故障源），但那意味着加固静默失效。
    """
    fns = _POST_BUILD_HOOKS.setdefault(service, [])
    if fn not in fns:
        fns.append(fn)


def reset_all(service: str | None = None) -> int:
    """丢弃已缓存的客户端，下次使用时重建。返回被重置的实例数。

    凭证轮换（如 Bedrock API Key 变更）时调用：botocore 在构造时快照 token provider，
    已建成的客户端不会自动改用新 token，必须重建（见 `LazyClient.reset`）。
    `service=None` 重置全部；否则只重置该 service 的实例（避免误伤无关客户端）。
    """
    n = 0
    for inst in list(_REGISTRY):
        if service is None or inst._service == service:
            inst.reset()
            n += 1
    return n


class LazyClient:
    """Proxy that builds `boto3.client(service, **kwargs)` on first attribute access.

    ``region_name`` is read from the callable passed as ``region`` (not a plain
    string) when the region itself must be resolved late — e.g. it comes from an
    environment variable a test wants to patch after import.

    Deliberately **not** using ``__slots__``. An earlier version did, and it broke
    two things that matter:

      * ``mock.patch.object(mod._bedrock, "invoke_model", fake)`` — with no
        ``__dict__`` the setattr fails outright, taking
        `scripts/test_case_analyze_intent.py` with it. Fifteen other call sites
        patch the *module* attribute (`patch.object(bedrock_chat, "_bedrock")`)
        and were unaffected, which is why this went unnoticed: that script is not
        in CI.
      * ``copy.copy`` / ``pickle`` — reconstruction leaves the instance state
        unset, so probing ``__setstate__`` reached ``__getattr__``, which read
        ``self._real``, which was also unset, which re-entered ``__getattr__`` →
        ``RecursionError``.

    With a plain ``__dict__``, a patched attribute simply shadows the proxy
    (instance attributes win over ``__getattr__``), and ``_real`` is always
    present after ``__init__``.
    """

    def __init__(self, service: str, *, region=None, **kwargs):
        self._service = service
        self._region = region
        self._kwargs = kwargs
        self._real = None
        _REGISTRY.add(self)          # 登记以支持 reset_all（凭证轮换批量重建）

    def _resolve(self):
        # 取到局部变量再返回：`reset_all()` 可能在并发线程里把 `self._real` 置空，
        # 若直接 `return self._real` 可能在「构造后、返回前」被清成 None（罕见但真实）。
        real = self._real
        if real is None:
            # 构造前钩子：让凭证类 env 在 boto3.client(...) 之前就位（如 Bedrock API Key）。
            # botocore 每请求读 AWS_BEARER_TOKEN_BEDROCK 决定签名，却在**构造时**快照 token
            # provider —— 设晚了会 NoAuthTokenError 硬失败（见模块文档）。钩子失败不阻断构造。
            for hook in _BUILD_HOOKS.get(self._service, ()):
                try:
                    hook()
                except Exception:  # noqa: BLE001 — 钩子是纵深加固，不能成为构造的故障源
                    pass
            kwargs = dict(self._kwargs)
            region = self._region() if callable(self._region) else self._region
            if region:
                kwargs["region_name"] = region
            real = boto3.client(self._service, **kwargs)
            # 构造后钩子：在把客户端交给调用方**之前**挂好（如 Key 401 失效监听）。
            # 顺序很重要——先赋值 self._real 再挂钩子的话，并发线程可能拿到一个还没装
            # 监听器的客户端。钩子失败不阻断构造，同构造前钩子。
            for hook in _POST_BUILD_HOOKS.get(self._service, ()):
                try:
                    hook(real)
                except Exception:  # noqa: BLE001 — 钩子是纵深加固，不能成为构造的故障源
                    pass
            self._real = real
        return real

    def __getattr__(self, name):
        # Only reached when normal lookup failed, so our own attributes and any
        # patched-in method never land here.
        #
        # Dunders are refused rather than forwarded, for two reasons:
        #   * they are how copy/pickle/abc probe an object, and forwarding them
        #     would build a real AWS client just to answer `hasattr(x,
        #     "__deepcopy__")` — defeating the laziness this class exists for,
        #     and raising NoRegionError instead of returning False in an
        #     environment without a region;
        #   * during reconstruction (`cls.__new__(cls)`) our state is unset, so
        #     forwarding recurses.
        # boto3 clients expose nothing through dunders that callers need.
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        # Same guard for our own attribute names: if one is missing we are in a
        # half-constructed instance, and touching `_real` would recurse.
        if name in ("_real", "_service", "_region", "_kwargs"):
            raise AttributeError(name)
        return getattr(self._resolve(), name)

    def reset(self) -> None:
        """Drop the cached client so the next use rebuilds it.

        Call this after `AWS_BEARER_TOKEN_BEDROCK` is *set* or *rotated*: the
        token provider is snapshotted at construction, so an existing client
        would switch to bearer auth (per-request env read) and then fail with
        `NoAuthTokenError`. Clearing the token does not strictly need a reset —
        the signer reverts to SigV4 on its own — but resetting on any change
        keeps the rule simple: credentials changed, rebuild.
        """
        self._real = None


__all__ = ["LazyClient", "register_build_hook", "reset_all"]
