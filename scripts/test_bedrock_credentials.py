"""
IM 侧 Bedrock API Key 注入测试（spec task 4.5 验收）。

与 webchat（task 3.4，`scripts/test_webchat_load_model.py`）的分工：webchat 每请求新建
BedrockModel，只需「构造前 set/pop」。IM 完全不同，两条都得测：

  1. **缓存的客户端**：8 个模块级 `LazyClient("bedrock-runtime")` 单例构造一次后复用。
     所以「set env」本身不够 —— Key 变了必须让它们重建，否则永远用旧凭证。
     更糟的是 botocore 的半态：每请求读 env 决定签名、构造时快照 token provider，
     两者不一致时是 `NoAuthTokenError` **硬失败**（不是静默回退 IAM）。
  2. **多会话并发**：飞书/Slack 进程里入站 handler + 派发线程 + 进度轮询 daemon 会并发
     调 Bedrock。「set env + 重建」必须串行化。

覆盖：
  · 钩子在**构造时**生效（这是正确性的关键：不是调用时，是构造时）
  · 有 Key → set；无 Key → pop（回退 IAM + 清掉长驻进程里上一代的残留）
  · Key 轮换 → 缓存客户端被重置（下次使用重建并带上新 Key）
  · Key 未变 → 廉价 no-op，**不重置**（否则每条消息都重建客户端）
  · install() 幂等（三个平台入口 + import 各调一次也只注册一个钩子）
  · 并发 refresh() 不产生撕裂状态
  · 钩子异常不阻断客户端构造（纵深加固不得成为故障源）

不触网：boto3.client 与 llm_config.get_bedrock_api_key 均被 stub。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_bedrock_credentials.py
"""
from __future__ import annotations

import os
import sys
import threading

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
os.environ.setdefault("CONVERSATIONS_TABLE", "test")
os.environ.setdefault("EVENTS_TABLE", "test")
os.environ.setdefault("CONFIG_TABLE", "test-config")

PASS = "✅"
FAIL = "❌"
_failed = 0
_BEARER = "AWS_BEARER_TOKEN_BEDROCK"


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


from core import bedrock_credentials as bc  # noqa: E402
from core import lazy_boto  # noqa: E402
from core import llm_config  # noqa: E402

# ── stub boto3.client：记录每次构造时看到的 env，绝不触网 ────────────────────
_builds: list[dict] = []


class _FakeEvents:
    """假 botocore 事件系统。记录 register 调用，供断言「监听器挂上了」。

    必须真实存在：`_attach_auth_listener` 走的是 `client.meta.events.register(...)`，
    而 LazyClient 会**吞掉**构造后钩子的异常。若这里缺 meta/events，钩子会静默失败，
    测试却照样通过 —— 那就正好漏掉要守的东西。
    """

    def __init__(self):
        self.registered: list[tuple] = []

    def register(self, event_name, handler, **kwargs):
        # 真 botocore 在**注册时**就校验 handler 必须接受 **kwargs
        # （botocore.hooks.HierarchicalEmitter._verify_accept_kwargs）。这里必须照做：
        # 少了这一步，把 `**_kwargs` 从 _on_after_call 去掉时 —— 真 botocore 会抛
        # ValueError，而 LazyClient 的构造后钩子**吞掉异常**，于是监听器根本没挂上、
        # 没有任何日志、IM Converse 的失效功能死掉，而本测试仍然全绿。实测确认过。
        import inspect
        sig = inspect.signature(handler)
        if not any(p.kind is inspect.Parameter.VAR_KEYWORD
                   for p in sig.parameters.values()):
            raise ValueError(
                f"Event handler {handler} must accept keyword arguments (**kwargs)")
        self.registered.append((event_name, handler))


class _FakeMeta:
    def __init__(self):
        self.events = _FakeEvents()


class _FakeClient:
    """假 boto3 客户端：任何 API 方法名都响应（我们只关心「何时构造」，不关心调用）。"""

    def __init__(self, service: str, seq: int):
        self.service = service
        self.seq = seq
        self.meta = _FakeMeta()

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return lambda *a, **k: {"service": self.service, "seq": self.seq}


def _install_fake_boto3():
    seq = {"n": 0}

    def _client(service, **kwargs):
        seq["n"] += 1
        # 关键：记录**构造那一刻**的 env —— 钩子必须已经跑过
        client = _FakeClient(service, seq["n"])
        _builds.append({"service": service, "bearer": os.environ.get(_BEARER),
                        "seq": seq["n"], "client": client})
        return client

    lazy_boto.boto3 = type("_B", (), {"client": staticmethod(_client)})()


_install_fake_boto3()


def _set_key(value):
    """打桩 llm_config.get_bedrock_api_key（IM 侧读 Key 的唯一入口）。"""
    llm_config.get_bedrock_api_key = lambda: value


def _fresh():
    """每个用例的干净起点：清 env、清已施加状态、重装钩子、清构造记录。"""
    bc._reset_state_for_tests()          # noqa: SLF001
    lazy_boto._BUILD_HOOKS.clear()       # noqa: SLF001
    lazy_boto._POST_BUILD_HOOKS.clear()  # noqa: SLF001
    bc.install()
    _builds.clear()


# ---------------------------------------------------------------------------
def test_hook_applies_key_at_construction_time():
    """钩子必须在 `boto3.client()` **构造之前**把 Key 摆好。

    这是全部正确性的支点：botocore 在构造时快照 token provider。构造后再 set env，
    botocore 会按 env 切到 bearer 签名却找不到 token provider → 每次调用
    NoAuthTokenError（硬失败，不是回退 IAM）。
    """
    print("test_hook_applies_key_at_construction_time")
    _fresh()
    _set_key("key-AAA")
    c = lazy_boto.LazyClient("bedrock-runtime", region="us-east-1")
    _check("no client built before first use (still lazy)", not _builds)
    c.invoke_model                                    # 触发构造
    _check("client was built", len(_builds) == 1, str(_builds))
    _check("the key was already in env AT construction time",
           _builds[0]["bearer"] == "key-AAA", str(_builds[0]))


def test_no_key_pops_env_for_iam_fallback():
    print("test_no_key_pops_env_for_iam_fallback")
    _fresh()
    os.environ[_BEARER] = "STALE-FROM-PREVIOUS-GENERATION"
    _set_key(None)                                    # credential_mode=iam / 读失败 / 未启用
    c = lazy_boto.LazyClient("bedrock-runtime")
    c.invoke_model
    _check("stale bearer token was popped before construction",
           _builds and _builds[0]["bearer"] is None, str(_builds))
    _check("env is clean after the build (IAM fallback)", _BEARER not in os.environ,
           os.environ.get(_BEARER))


def test_rotation_rebuilds_cached_clients():
    """Key 轮换：已缓存的客户端必须被重建并带上新 Key。IM 的核心诉求。"""
    print("test_rotation_rebuilds_cached_clients")
    _fresh()
    _set_key("key-OLD")
    c = lazy_boto.LazyClient("bedrock-runtime")
    first = c.invoke_model                            # 构造 #1（key-OLD）
    _check("built with the old key", _builds[-1]["bearer"] == "key-OLD", str(_builds[-1]))
    bc.refresh()                                      # 对齐初始状态

    _set_key("key-NEW")                               # Admin 轮换
    rebuilt = bc.refresh()
    _check("refresh() reports a rebuild happened", rebuilt is True)
    second = c.invoke_model                            # 触发重建 → 构造 #2
    _check("the cached client was rebuilt", len(_builds) == 2, str(_builds))
    _check("the rebuild picked up the NEW key",
           _builds[-1]["bearer"] == "key-NEW", str(_builds[-1]))
    _check("a different underlying client object is in play",
           getattr(first, "__self__", None) is not getattr(second, "__self__", None)
           or _builds[-1]["seq"] != _builds[0]["seq"])


def test_unchanged_key_is_a_cheap_noop():
    """Key 未变时 refresh() 不得重置 —— 否则每条 IM 消息都重建一次客户端。"""
    print("test_unchanged_key_is_a_cheap_noop")
    _fresh()
    _set_key("key-SAME")
    c = lazy_boto.LazyClient("bedrock-runtime")
    c.invoke_model
    # 进程启动后的第一次 refresh() 因哨兵必然对齐一次状态（重置 → 下次使用重建）。
    # 这是设计意图：启动时（main() 里）还没有客户端，重置 0 个实例，代价为零。
    # 稳态从这之后开始 —— 先把重建落地，再取基线。
    bc.refresh()
    c.invoke_model
    builds_before = len(_builds)

    rebuilt_any = False
    for _ in range(50):
        if bc.refresh():
            rebuilt_any = True
            break
    _check("50 refreshes with an unchanged key trigger no rebuild",
           not rebuilt_any, "refresh() reported a rebuild")
    c.invoke_model
    _check("the client was not rebuilt in the steady state",
           len(_builds) == builds_before, f"{builds_before} -> {len(_builds)}")


def test_clearing_the_key_also_rebuilds():
    """Key 被清空（切回 IAM）也是一次变化：必须重建，且 env 被 pop。"""
    print("test_clearing_the_key_also_rebuilds")
    _fresh()
    _set_key("key-XYZ")
    c = lazy_boto.LazyClient("bedrock-runtime")
    c.invoke_model
    bc.refresh()
    _set_key(None)                                    # Admin 清空 Key
    _check("clearing the key is detected as a change", bc.refresh() is True)
    c.invoke_model
    _check("rebuilt without a bearer token", _builds[-1]["bearer"] is None,
           str(_builds[-1]))


def test_install_is_idempotent():
    """三个平台入口 + import 时各调一次 install()，钩子只能注册一个。"""
    print("test_install_is_idempotent")
    _fresh()
    for _ in range(5):
        bc.install()
    hooks = lazy_boto._BUILD_HOOKS.get("bedrock-runtime", [])   # noqa: SLF001
    _check("exactly one build hook registered", len(hooks) == 1, str(len(hooks)))

    # 幂等由**两层**保证（install 的标记 + register_build_hook 内部去重）。终态不变量
    # 「只有一个钩子」对两层都成立，所以单测终态无法分辨哪层生效 —— 破坏任一层都测不出来。
    # 故对两层各自独立断言。
    _check("layer 1: install() records that it ran",
           bc._installed is True, str(bc._installed))          # noqa: SLF001
    # Layer 1 是**短路**：第二次起 install() 不该再走到注册函数。只断言终态钩子数的话，
    # 这层被删掉也测不出来（Layer 2 会兜住），所以直接数「注册函数被调了几次」。
    bc._reset_state_for_tests()                                # noqa: SLF001
    real_register = lazy_boto.register_build_hook
    calls = {"n": 0}

    def _counting(service, fn):
        calls["n"] += 1
        return real_register(service, fn)

    lazy_boto.register_build_hook = _counting
    try:
        for _ in range(4):
            bc.install()
    finally:
        lazy_boto.register_build_hook = real_register
    _check("layer 1: install() short-circuits after the first call",
           calls["n"] == 1, f"register_build_hook called {calls['n']} time(s)")

    lazy_boto._BUILD_HOOKS.clear()                             # noqa: SLF001

    def _same_fn():
        return None

    for _ in range(3):
        lazy_boto.register_build_hook("bedrock-runtime", _same_fn)
    _check("layer 2: register_build_hook de-dupes the same callable on its own",
           len(lazy_boto._BUILD_HOOKS["bedrock-runtime"]) == 1,          # noqa: SLF001
           str(lazy_boto._BUILD_HOOKS["bedrock-runtime"]))               # noqa: SLF001
    lazy_boto.register_build_hook("bedrock-runtime", lambda: None)
    _check("layer 2: a different callable is still added",
           len(lazy_boto._BUILD_HOOKS["bedrock-runtime"]) == 2,          # noqa: SLF001
           str(lazy_boto._BUILD_HOOKS["bedrock-runtime"]))               # noqa: SLF001
    _fresh()                                                    # 复原给后续断言
    _set_key("key-once")
    c = lazy_boto.LazyClient("bedrock-runtime")
    c.invoke_model
    _check("the client is built exactly once", len(_builds) == 1, str(_builds))


def test_concurrent_refresh_is_serialised():
    """并发 refresh()（入站 handler + 派发线程 + 轮询 daemon）不得撕裂状态。

    Key 是进程级、全会话同值，所以并发把 env 设成同一个值是良性的；真正需要串行化的是
    「变化时的重建」。这里断言：多线程同时 refresh 一个新 Key，最终 env 与已施加状态一致，
    且不抛异常。
    """
    print("test_concurrent_refresh_is_serialised")
    _fresh()
    _set_key("key-start")
    bc.refresh()
    _set_key("key-rotated")

    errors: list[BaseException] = []
    rebuilds: list[bool] = []
    lock = threading.Lock()

    def worker():
        try:
            r = bc.refresh()
            with lock:
                rebuilds.append(r)
        except BaseException as e:      # noqa: BLE001
            with lock:
                errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(24)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    _check("no thread raised", not errors, "; ".join(type(e).__name__ for e in errors[:3]))
    _check("exactly one thread performed the rebuild (the rest were no-ops)",
           rebuilds.count(True) == 1, f"rebuild count={rebuilds.count(True)}")
    _check("env reflects the rotated key", os.environ.get(_BEARER) == "key-rotated",
           os.environ.get(_BEARER))


def test_hook_failure_does_not_block_construction():
    """钩子是纵深加固，不能成为故障源：读 Key 抛异常时客户端仍要建出来（回退 IAM）。"""
    print("test_hook_failure_does_not_block_construction")
    _fresh()

    def _boom():
        raise RuntimeError("secrets manager unavailable")

    llm_config.get_bedrock_api_key = _boom
    c = lazy_boto.LazyClient("bedrock-runtime")
    try:
        c.invoke_model
        built = True
    except Exception as e:      # noqa: BLE001
        built = False
        _check("client construction did not raise", False, repr(e))
    if built:
        _check("client was still constructed despite the hook failing",
               len(_builds) == 1, str(_builds))


def _last_client():
    """最近一次被构造出来的假客户端。"""
    return _builds[-1]["client"]


def _invalidations(fn, *args, **kwargs) -> int:
    """跑 fn，返回期间 llm_config.invalidate_api_key 被调用的次数。"""
    calls = {"n": 0}
    orig = llm_config.invalidate_api_key
    llm_config.invalidate_api_key = lambda: calls.__setitem__("n", calls["n"] + 1)
    try:
        fn(*args, **kwargs)
    finally:
        llm_config.invalidate_api_key = orig
    return calls["n"]


class _Resp:
    def __init__(self, status):
        self.status_code = status


def test_post_build_hook_attaches_auth_listener():
    """构造后钩子必须把 Key 失效监听挂到新客户端上（spec R7.2 的接线点）。

    挂在 `after-call` 而非 `after-call-error`：鉴权失败是服务端**正常返回**的 HTTP
    响应，botocore 解析后才抛 ClientError，`after-call-error` 收不到（实测 1.43.19）。
    """
    print("test_post_build_hook_attaches_auth_listener")
    _fresh()
    _set_key("key-listener")
    c = lazy_boto.LazyClient("bedrock-runtime")
    c.converse                                        # 触发构造
    _check("client was built", len(_builds) == 1, str(len(_builds)))
    reg = _last_client().meta.events.registered
    _check("exactly one handler registered", len(reg) == 1, str(reg))
    if reg:
        _check("registered on after-call.bedrock-runtime",
               reg[0][0] == "after-call.bedrock-runtime", reg[0][0])
        _check("handler is the key-invalidation listener",
               reg[0][1] is bc._on_after_call)        # noqa: SLF001


def test_http_401_invalidates_the_key():
    """401 = 「这个 token 不成立」→ 必须失效缓存，下次重读 Secret。"""
    print("test_http_401_invalidates_the_key")
    _fresh()
    os.environ[_BEARER] = "key-in-use"
    n = _invalidations(bc._on_after_call,             # noqa: SLF001
                       http_response=_Resp(401), parsed={})
    _check("401 invalidated the key cache", n == 1, f"calls={n}")


# 期望的失效 code **硬编码在测试里**，不从被测模块取。
# 上一版写的是 `for code in sorted(bc._AUTH_FAIL_CODES)` —— 遍历被测集合本身，于是把
# 集合清空（等于关掉整个失效功能）时循环一次都不执行，测试仍然全绿。实测确认过。
_EXPECTED_AUTH_FAIL_CODES = (
    "UnrecognizedClientException",
    "InvalidSignatureException",
    "ExpiredTokenException",
    "UnauthorizedException",
    "HttpAuthenticationException",
)


def test_credential_error_codes_invalidate_the_key():
    """凭证不被认可的 error code（可能配 200/400 状态码）同样要失效。"""
    print("test_credential_error_codes_invalidate_the_key")
    _fresh()
    os.environ[_BEARER] = "key-in-use"
    for code in _EXPECTED_AUTH_FAIL_CODES:
        n = _invalidations(bc._on_after_call,        # noqa: SLF001
                           http_response=_Resp(400),
                           parsed={"Error": {"Code": code}})
        _check(f"{code} invalidated the key cache", n == 1, f"calls={n}")


def test_dead_key_on_converse_invalidates_despite_403():
    """**Converse 上死掉的 Key 是 403 + AccessDeniedException，不是 401。**

    这条是上一版最大的漏洞：判据写成「只认 401、绝不认 403」，理由是 403 属于授权不足、
    是按模型收窄 Key 的常态 —— 那半句对，但漏了另一半，死 Key 在 Converse 上根本不回 401。
    结果 Converse 侧的失效永不触发，KeyAuthFail 在最可能的三种吊销路径上一动不动。

    实测（us-east-2，本部署账号）：
        死 Key   → 403 AccessDeniedException "Authentication failed: Please make sure
                   your API Key is valid."
        授权不足 → 403 AccessDeniedException "User: arn:... is not authorized to
                   perform: bedrock:InvokeModel on resource: ..."
    两者共用 code，只有 message 能区分。
    """
    print("test_dead_key_on_converse_invalidates_despite_403")
    _fresh()
    os.environ[_BEARER] = "key-in-use"
    n = _invalidations(bc._on_after_call,             # noqa: SLF001
                       http_response=_Resp(403),
                       parsed={"Error": {
                           "Code": "AccessDeniedException",
                           "Message": "Authentication failed: Please make sure your "
                                      "API Key is valid."}})
    _check("dead key (403 + authentication-failed) invalidated the cache",
           n == 1, f"calls={n}")


def test_authz_denial_does_not_invalidate_the_key():
    """授权不足不是凭证失效 —— 失效它只会白读 Secret 并把指标刷成噪声。

    这不是理论情形：Admin 生成 Key 时可按模型收窄，被禁模型的**每一次**调用都回 403。
    当成失效处理 = 每次调用多一次 Secrets Manager 读 + 一条假的 KeyAuthFail，
    真正的轮换事故会淹没在噪声里。判据靠 message 里的标准 IAM 措辞区分。
    """
    print("test_authz_denial_does_not_invalidate_the_key")
    _fresh()
    os.environ[_BEARER] = "key-in-use"
    n = _invalidations(bc._on_after_call,             # noqa: SLF001
                       http_response=_Resp(403),
                       parsed={"Error": {
                           "Code": "AccessDeniedException",
                           "Message": "User: arn:aws:sts::1:federated-user/x is not "
                                      "authorized to perform: bedrock:InvokeModel on "
                                      "resource: arn:aws:bedrock:us-east-2::"
                                      "foundation-model/openai.gpt-oss-20b-1:0"}})
    _check("authz denial left the cache alone", n == 0, f"calls={n}")

    # 无 message 的 403 同样不动 —— 拿不到区分信号时保守处理（宁可等 TTL）。
    n2 = _invalidations(bc._on_after_call,            # noqa: SLF001
                        http_response=_Resp(403),
                        parsed={"Error": {"Code": "AccessDeniedException"}})
    _check("403 without a message left the cache alone", n2 == 0, f"calls={n2}")

    # 两个短语同时出现时，授权措辞优先 —— 防止将来 AWS 把两种情形合并成一句话时误伤。
    n3 = _invalidations(bc._on_after_call,            # noqa: SLF001
                        http_response=_Resp(403),
                        parsed={"Error": {
                            "Code": "AccessDeniedException",
                            "Message": "Authentication failed. User: arn:x is not "
                                       "authorized to perform: bedrock:InvokeModel"}})
    _check("authz wording wins when both phrases appear", n3 == 0, f"calls={n3}")


def test_iam_mode_never_invalidates():
    """IAM 模式（env 无 bearer token）下的 401 与 Key 无关，不得误报。"""
    print("test_iam_mode_never_invalidates")
    _fresh()
    os.environ.pop(_BEARER, None)
    n = _invalidations(bc._on_after_call,             # noqa: SLF001
                       http_response=_Resp(401),
                       parsed={"Error": {"Code": "UnrecognizedClientException"}})
    _check("no invalidation when no key is in play", n == 0, f"calls={n}")


def test_successful_call_does_not_invalidate():
    """200 正常响应绝不能触发失效（否则每次调用都重读 Secret）。"""
    print("test_successful_call_does_not_invalidate")
    _fresh()
    os.environ[_BEARER] = "key-in-use"
    n = _invalidations(bc._on_after_call,             # noqa: SLF001
                       http_response=_Resp(200),
                       parsed={"output": {"message": {}}})
    _check("200 left the cache alone", n == 0, f"calls={n}")


def test_post_build_hook_failure_does_not_block_construction():
    """构造后钩子抛异常时客户端仍要建出来（加固不得成为故障源）。"""
    print("test_post_build_hook_failure_does_not_block_construction")
    _fresh()
    _set_key("key-boom")

    def _boom(client):
        raise RuntimeError("events system unavailable")

    lazy_boto.register_post_build_hook("bedrock-runtime", _boom)
    c = lazy_boto.LazyClient("bedrock-runtime")
    try:
        c.converse
        _check("client was still constructed despite the post-build hook failing",
               len(_builds) == 1, str(len(_builds)))
    except Exception as e:                            # noqa: BLE001
        _check("client construction did not raise", False, repr(e))


def test_only_bedrock_clients_are_touched():
    """钩子/重置按 service 过滤 —— 不得波及 ddb / s3 等无关客户端。"""
    print("test_only_bedrock_clients_are_touched")
    _fresh()
    _set_key("key-scoped")
    other = lazy_boto.LazyClient("dynamodb")
    other.get_item
    _check("non-bedrock client built without the hook running",
           _builds[-1]["service"] == "dynamodb" and _builds[-1]["bearer"] is None,
           str(_builds[-1]))
    real_before = other._real                          # noqa: SLF001
    _set_key("key-scoped-2")
    bc.refresh()
    _check("rotation did not reset the dynamodb client",
           other._real is real_before, "unrelated client was reset")   # noqa: SLF001


def test_wiring_present_in_im_entrypoints():
    """接线必须还在：IM 的三处 Bedrock 入口都要有机会收敛凭证。"""
    print("test_wiring_present_in_im_entrypoints")
    checks = [
        ("core/bedrock_chat.py", "refresh()"),
        ("core/progress_poller.py", "refresh()"),
        ("platforms/feishu/app/main.py", "install()"),
        ("platforms/slack/app/main.py", "install()"),
        ("platforms/dingtalk/app/main.py", "install()"),
    ]
    for rel, needle in checks:
        src = open(os.path.join(ROOT, rel)).read()
        _check(f"{rel} calls bedrock_credentials.{needle}",
               "bedrock_credentials" in src and needle in src)


def main() -> int:
    before = os.environ.get(_BEARER)
    test_hook_applies_key_at_construction_time()
    test_no_key_pops_env_for_iam_fallback()
    test_rotation_rebuilds_cached_clients()
    test_unchanged_key_is_a_cheap_noop()
    test_clearing_the_key_also_rebuilds()
    test_install_is_idempotent()
    test_concurrent_refresh_is_serialised()
    test_hook_failure_does_not_block_construction()
    test_post_build_hook_attaches_auth_listener()
    test_http_401_invalidates_the_key()
    test_credential_error_codes_invalidate_the_key()
    test_dead_key_on_converse_invalidates_despite_403()
    test_authz_denial_does_not_invalidate_the_key()
    test_iam_mode_never_invalidates()
    test_successful_call_does_not_invalidate()
    test_post_build_hook_failure_does_not_block_construction()
    test_only_bedrock_clients_are_touched()
    test_wiring_present_in_im_entrypoints()
    if before is None:
        os.environ.pop(_BEARER, None)
    else:
        os.environ[_BEARER] = before
    if _failed:
        print(f"\n{FAIL} {_failed} check(s) failed")
        return 1
    print(f"\n{PASS} all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
