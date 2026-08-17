"""
后端任务走 Bedrock Mantle（Responses 协议）的测试。

背景：Bedrock 上有一批模型**只在 `bedrock-mantle` 端点上架**，不在 `bedrock-runtime`
上，Converse 根本调不到。实测（us-east-2，2026-08）：

    Converse(openai.gpt-5.6-terra)    → ValidationException:
                                        The provided model identifier is invalid
    Converse(openai.gpt-oss-120b-1:0) → 200 OK                    ← 对照组

对照组很关键：这不是「OpenAI 家族不支持 Converse」，而是具体模型在哪个端点上架的问题。

在此之前，对话侧（webchat / IM）早就能用这些模型，后端任务侧（PHD 翻译 / 报告精简）
却不能 —— 因为 `shared/llm_provider.invoke_llm` 只有 `client.converse()` 一条路。
同一份模型目录两端能力不一致，管理员在 Admin 看到的就是「加进来了但后端下拉是灰的」，
实测被问「为什么不让我选 gpt」。本测试锁住补齐后的行为。

覆盖：
  · kind 分派：空 / 未知 → Converse（历史行为）；`bedrock_mantle_responses` → Mantle
  · **不按 model_id 猜协议**（猜错的表现是「模型不存在」，归因成本极高）
  · region 白名单：非法值不得进 hostname（region 来自 DDB，Admin 可写）
  · usage 字段名归一到 Bedrock（inputTokens / outputTokens / totalTokens）
  · 截断映射：status=incomplete + reason=max_output_tokens → stop_reason="max_tokens"
    并追加 _TRUNCATION_NOTICE（复用既有截断逻辑，不为第二种协议重写一遍）
  · 单轮无工具 → 显式 `store: false`（默认 true 会在**请求源区**留存 30 天）
  · 凭证：配了 Bedrock API Key → `Authorization: Bearer`；没配 → SigV4
  · 文本提取跳过 reasoning 块，只取 output_text

不触网：`safe_urlopen` 与 Secrets 读取均被 stub。SigV4 分支用文件顶部写死的**假**凭证
签名（签名发生在 stub 之前，拦不住），所以既不依赖环境里有没有 AWS 凭证，也不会拿真
凭证去签。

Run from repo root::

    PYTHONPATH=. python3 scripts/test_llm_provider_mantle.py
"""
from __future__ import annotations

import io
import json
import os
import sys
import urllib.error

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)

# ── 假凭证：必须在任何 boto3.Session() 之前设好 ──────────────────────────────
# SigV4 分支（无 API Key 时）会 `boto3.Session().get_credentials()`，而这一步发生在
# 被 stub 的 `safe_urlopen` **之前** —— stub 打在出网上，拦不住签名。CI（无 AWS 凭证）
# 里 get_credentials() 回 None，于是 .get_frozen_credentials() 抛 AttributeError，
# 整个 job 崩掉；本地有凭证所以一直全绿。
#
# 不能像别处那样绕开签名走 Bearer：本文件有几条断言**就是**在验 SigV4
# （AWS4-HMAC-SHA256、服务名 bedrock、不发 Bearer），绕开等于把它们废掉。所以反过来，
# 喂一组固定的假凭证让签名照常跑完 —— 请求本身仍被 stub 拦下，永不出网。
#
# 无条件覆盖而不用 setdefault：本地开发机通常**有**真凭证，setdefault 会让测试继续
# 拿真凭证签名 —— 既不确定（签名结果随机器而变），也不该让单测碰生产凭证。
os.environ["AWS_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE"
os.environ["AWS_SECRET_ACCESS_KEY"] = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
os.environ["AWS_DEFAULT_REGION"] = "us-east-1"
os.environ.pop("AWS_SESSION_TOKEN", None)   # 半套凭证（有 token 无 key）签不出来
os.environ.pop("AWS_PROFILE", None)         # 别让 profile 把上面几行盖掉

PASS = "✅"
FAIL = "❌"
_failed = 0


def _check(label: str, cond: bool, detail: str = "") -> None:
    global _failed
    if cond:
        print(f"  {PASS} {label}")
    else:
        _failed += 1
        print(f"  {FAIL} {label}{(' :: ' + detail) if detail else ''}")


from shared import llm_provider as lp  # noqa: E402

MANTLE = "bedrock_mantle_responses"

# ── 捕获出网请求，绝不真发 ────────────────────────────────────────────────────
_sent: list[dict] = []


class _FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _install_capture(payload: dict) -> None:
    """替换 safe_urlopen：记录 (url, headers, body) 并回放 `payload`。"""
    _sent.clear()

    def fake_urlopen(req, timeout=None):
        _sent.append({
            "url": req.full_url,
            "headers": {k.lower(): v for k, v in req.header_items()},
            "body": json.loads(req.data.decode("utf-8")),
            "timeout": timeout,
        })
        return _FakeResp(json.dumps(payload).encode("utf-8"))

    lp.safe_urlopen = fake_urlopen


def _set_key(value: str | None) -> None:
    """直接写 llm_provider 的 Key 缓存，绕开 Secrets Manager。"""
    lp._cached_bedrock_key = value if value is not None else ""
    lp._cached_bedrock_key_ts = 1e18   # 永不过期，避免测试里回落到真实读取


def _converse_only() -> list[dict]:
    """替换 Converse 分支为记录器，用于验证分派走了哪一条。"""
    calls: list[dict] = []
    lp._invoke_bedrock = lambda *a, **k: (   # type: ignore[assignment]
        calls.append({"args": a, "kwargs": k})
        or {"content": "converse", "stop_reason": "end_turn", "usage": {}}
    )
    return calls


_OK_PAYLOAD = {
    "id": "resp_1",
    "status": "completed",
    "output": [
        {"type": "reasoning", "summary": []},
        {"type": "message", "role": "assistant",
         "content": [{"type": "output_text", "text": "翻译结果"}]},
    ],
    "usage": {"input_tokens": 120, "output_tokens": 45, "total_tokens": 165},
}

_TRUNCATED_PAYLOAD = {
    "id": "resp_2",
    "status": "incomplete",
    "incomplete_details": {"reason": "max_output_tokens"},
    "output": [{"type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "半截"}]}],
    "usage": {"input_tokens": 10, "output_tokens": 8, "total_tokens": 18},
}


def test_kind_dispatch() -> None:
    print("\n[1] kind 分派：默认 Converse，显式 mantle 才走 Responses")
    orig = lp._invoke_bedrock
    try:
        calls = _converse_only()
        _install_capture(_OK_PAYLOAD)
        _set_key(None)

        lp._get_provider = lambda force_refresh=False: "bedrock"  # type: ignore[assignment]

        lp.invoke_llm("global.anthropic.claude-sonnet-5", "sys", "usr")
        _check("kind 缺省 → Converse（与历史行为一致）", len(calls) == 1 and not _sent)

        lp.invoke_llm("whatever", "sys", "usr", kind="something-new")
        _check("未知 kind → Converse，不猜第三条协议", len(calls) == 2 and not _sent)

        # 关键：model_id 长得像 GPT，但没声明 kind → **不得**擅自走 Mantle。
        # 靠前缀猜会在目录换代时静默走错端点，而走错端点的报错是「model identifier
        # is invalid」，看起来像「模型不存在」。
        lp.invoke_llm("openai.gpt-5.6-terra", "sys", "usr")
        _check("model_id 像 GPT 但未声明 kind → 仍走 Converse（不按前缀猜）",
               len(calls) == 3 and not _sent)

        lp.invoke_llm("openai.gpt-5.6-terra", "sys", "usr",
                      kind=MANTLE, region="us-east-2")
        _check("kind=bedrock_mantle_responses → 走 Mantle",
               len(calls) == 3 and len(_sent) == 1)
        _check("端点 = bedrock-mantle.<region>.api.aws/openai/v1/responses",
               _sent[0]["url"] == "https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses",
               _sent[0]["url"])
    finally:
        lp._invoke_bedrock = orig  # type: ignore[assignment]


def test_region_allowlist() -> None:
    print("\n[2] region 白名单：Admin 可写的值不得直接进 hostname")
    _check("已知区域原样保留", lp._mantle_region("ap-northeast-1") == "ap-northeast-1")
    _check("空值 → 默认区", lp._mantle_region("") == lp._MANTLE_REGION_DEFAULT)
    for bad in ["evil.example.com", "us-east-2.attacker.net", "../../x",
                "us-east-2/", "US-EAST-2", "us-east-9"]:
        _check(f"非法 region 被挡下: {bad!r}",
               lp._mantle_region(bad) == lp._MANTLE_REGION_DEFAULT,
               lp._mantle_region(bad))

    # 端到端：非法 region 不得出现在实际请求的 URL 里
    _install_capture(_OK_PAYLOAD)
    _set_key(None)
    lp._invoke_mantle_responses("m", "sys", "usr", 100, "evil.example.com")
    _check("非法 region 的请求仍打在 AWS 域名上",
           _sent[0]["url"].startswith(
               f"https://bedrock-mantle.{lp._MANTLE_REGION_DEFAULT}.api.aws/"),
           _sent[0]["url"])
    _check("非法 region 字符串没有泄进 URL",
           "evil.example.com" not in _sent[0]["url"])


def test_response_normalisation() -> None:
    print("\n[3] 返回值归一：与 Converse 分支同形")
    _install_capture(_OK_PAYLOAD)
    _set_key(None)
    r = lp._invoke_mantle_responses("m", "sys", "usr", 512, "us-east-2")

    _check("只取 output_text，跳过 reasoning 块", r["content"] == "翻译结果", r["content"])
    _check("三键结构齐全", set(r) == {"content", "stop_reason", "usage"}, str(set(r)))
    _check("usage 用 Bedrock 字段名",
           r["usage"] == {"inputTokens": 120, "outputTokens": 45, "totalTokens": 165},
           str(r["usage"]))
    _check("正常完成时 stop_reason 非 max_tokens", r["stop_reason"] != "max_tokens")

    _install_capture(_TRUNCATED_PAYLOAD)
    r2 = lp._invoke_mantle_responses("m", "sys", "usr", 8, "us-east-2")
    _check("incomplete + max_output_tokens → stop_reason='max_tokens'",
           r2["stop_reason"] == "max_tokens", r2["stop_reason"])
    _check("截断时追加 _TRUNCATION_NOTICE（复用既有逻辑）",
           r2["content"].endswith(lp._TRUNCATION_NOTICE), r2["content"])


def test_request_body() -> None:
    print("\n[4] 请求体：store=false + 调用方的 max_tokens")
    _install_capture(_OK_PAYLOAD)
    _set_key(None)
    lp._invoke_mantle_responses("openai.gpt-5.6-terra", "系统词", "用户词",
                                4096, "us-west-2")
    body = _sent[0]["body"]
    _check("model 用目录里的 model_id", body["model"] == "openai.gpt-5.6-terra")
    _check("system_prompt → instructions", body["instructions"] == "系统词")
    _check("user_prompt → input", body["input"] == "用户词")
    _check("max_output_tokens 用调用方传入值（不是硬编码）",
           body["max_output_tokens"] == 4096, str(body.get("max_output_tokens")))
    # Responses API 默认 store=true → 提示词与回复在**请求源区**留存 30 天。
    # 后端任务是单轮无工具，用不到服务端会话状态，所以可以白拿这个数据留存收益。
    _check("显式 store=false（否则源区留存 30 天）", body["store"] is False,
           str(body.get("store")))

    _install_capture(_OK_PAYLOAD)
    lp._invoke_mantle_responses("m", "", "用户词", 100, "us-east-2")
    _check("system_prompt 为空时不发 instructions 空字段",
           "instructions" not in _sent[0]["body"])


def test_credential_mode_gates_the_key() -> None:
    print("\n[6] 后端任务尊重 credential_mode 开关")
    # 此前本模块只判断「BEDROCK_API_KEY_SECRET_ARN 有值 + Secret 非空」就用 Key，而那个 env
    # 是 CDK **无条件**注入的。于是管理员把开关拨回 IAM 却保留 Key（「先停用、别销毁」的
    # 标准做法）时，对话侧走 IAM、PHD 翻译与报告精简走 Key —— 同一份目录两个 caller 身份。
    # 对话侧与 BFF 探测早就按这个开关判断，后端任务是最后一处漏的。
    orig_mode = lp._credential_mode
    _install_capture(_OK_PAYLOAD)

    def _auth_of_last_request() -> str:
        return str(_sent[-1]["headers"].get("authorization", ""))

    try:
        _set_key("a-real-key")

        lp._credential_mode = lambda: "api_key"   # type: ignore[assignment]
        _install_capture(_OK_PAYLOAD)
        lp._cached_bedrock_key = None             # 强制重走 _get_bedrock_api_key 的门禁
        _set_key("a-real-key")
        lp._invoke_mantle_responses("m", "sys", "usr", 100, "us-east-2")
        _check("credential_mode=api_key → 用 Key（Bearer）",
               _auth_of_last_request().startswith("Bearer "), _auth_of_last_request()[:30])

        lp._credential_mode = lambda: "iam"       # type: ignore[assignment]
        _install_capture(_OK_PAYLOAD)
        lp._invoke_mantle_responses("m", "sys", "usr", 100, "us-east-2")
        auth = _auth_of_last_request()
        _check("credential_mode=iam → **不用** Key，退回 SigV4（即使 Secret 里仍有 Key）",
               auth.startswith("AWS4-HMAC-SHA256"), auth[:40])
        _check("iam 模式下不得发 Bearer", not auth.startswith("Bearer"))
    finally:
        lp._credential_mode = orig_mode           # type: ignore[assignment]
        _set_key(None)

    # 缓存必须一起清：只清一部分会让调用方拿到「新 provider 配旧凭证方式」的组合
    lp._cached_cred_mode = "api_key"
    lp._cached_bedrock_key = "stale"
    lp.reset_cache()
    _check("reset_cache 清掉 credential_mode 缓存", lp._cached_cred_mode is None)
    _check("reset_cache 清掉 Key 缓存", lp._cached_bedrock_key is None)


def test_credentials() -> None:
    print("\n[5] 凭证：Key 优先用 Bearer，无 Key 回退 SigV4")
    _install_capture(_OK_PAYLOAD)
    _set_key("bedrock-api-key-value")
    lp._invoke_mantle_responses("m", "sys", "usr", 100, "us-east-2")
    h = _sent[0]["headers"]
    _check("配了 Key → Authorization: Bearer <key>",
           h.get("authorization") == "Bearer bedrock-api-key-value",
           str(h.get("authorization")))
    _check("Bearer 模式不带 SigV4 签名头",
           "x-amz-date" not in h and "AWS4-HMAC" not in str(h.get("authorization", "")))

    _install_capture(_OK_PAYLOAD)
    _set_key(None)
    lp._invoke_mantle_responses("m", "sys", "usr", 100, "us-east-2")
    h2 = _sent[0]["headers"]
    auth = str(h2.get("authorization", ""))
    _check("没配 Key → SigV4 签名（AWS4-HMAC-SHA256）",
           auth.startswith("AWS4-HMAC-SHA256"), auth[:40])
    _check("SigV4 签名服务名为 bedrock（与对话侧一致，已在生产验证）",
           "/bedrock/aws4_request" in auth, auth[:200])
    _check("SigV4 模式不发 Bearer", not auth.startswith("Bearer"))


def _http_error(code: int, body: bytes = b"{}"):
    """构造一个可 .read() 的 HTTPError（生产代码会读 body 记日志）。"""
    return urllib.error.HTTPError("https://x/y", code, "err", {}, io.BytesIO(body))


def _install_failing(code: int) -> None:
    """替换 safe_urlopen 为「总是抛 HTTPError(code)」。"""
    def fake_urlopen(req, timeout=None):
        raise _http_error(code)
    lp.safe_urlopen = fake_urlopen


def _key_cache_state() -> tuple:
    return (lp._cached_bedrock_key, lp._cached_bedrock_key_ts)


def test_mantle_401_invalidates_the_key() -> None:
    """Mantle Bearer 被拒（401）→ 失效**本模块**的 Key 缓存（spec R7.2）。

    后端任务不走 core/llm_config，它有自己的 `_cached_bedrock_key` + 300s TTL。
    只清 core 的缓存清不掉这一份，Key 轮换后这个 Lambda 会继续用旧 Key 直到 TTL 到期。
    """
    print("\n[7] Key 失效：Mantle 401 清缓存，403 不清")
    _install_failing(401)
    _set_key("stale-key")
    try:
        lp._invoke_mantle_responses("m", "sys", "usr", 100, "us-east-2")
    except urllib.error.HTTPError:
        pass
    key, ts = _key_cache_state()
    _check("401 清空了本模块的 Key 缓存", key is None and ts == 0.0, f"{key!r} ts={ts}")

    # 403 = Key 有效但不许调这个模型（Admin 按模型收窄 Key 是本部署常态）。
    # 当失效处理 = 每次调用白读一次 Secrets Manager + 一条假的 KeyAuthFail。
    _install_failing(403)
    _set_key("valid-but-restricted")
    try:
        lp._invoke_mantle_responses("m", "sys", "usr", 100, "us-east-2")
    except urllib.error.HTTPError:
        pass
    key2, _ = _key_cache_state()
    _check("403 保留 Key 缓存（授权不足 ≠ 凭证失效）",
           key2 == "valid-but-restricted", repr(key2))

    # SigV4 模式下的 401 与 Key 无关，不得把「无 Key」状态误判成需要失效。
    _install_failing(401)
    _set_key(None)
    before = _key_cache_state()
    try:
        lp._invoke_mantle_responses("m", "sys", "usr", 100, "us-east-2")
    except urllib.error.HTTPError:
        pass
    _check("SigV4 模式（无 Key）下的 401 不动缓存",
           _key_cache_state() == before, f"{before} -> {_key_cache_state()}")


def test_converse_401_invalidates_the_key() -> None:
    """Converse 分支同样要接：后端任务的两条协议都可能撞上被吊销的 Key。"""
    print("\n[8] Key 失效：Converse 分支")
    from botocore.exceptions import ClientError

    def _client_raising(code: str, status: int, message: str = "m"):
        # message 可注入：Converse 上「死 Key」与「授权不足」共用 403 +
        # AccessDeniedException，只有 message 能区分，所以不带 message 就测不到判据。
        class _C:
            def converse(self, **kwargs):
                raise ClientError(
                    {"Error": {"Code": code, "Message": message},
                     "ResponseMetadata": {"HTTPStatusCode": status}},
                    "Converse")
        return _C()

    orig_boto3 = lp.boto3
    try:
        lp.boto3 = type("_B", (), {
            "client": staticmethod(
                lambda *a, **k: _client_raising("UnrecognizedClientException", 401))
        })()
        _set_key("stale-key")
        try:
            lp._invoke_bedrock("m", "sys", "usr", 100)
        except ClientError:
            pass
        key, ts = _key_cache_state()
        _check("UnrecognizedClientException 清空了 Key 缓存",
               key is None and ts == 0.0, f"{key!r} ts={ts}")

        # 授权不足：403 + AccessDeniedException + 标准 IAM 措辞 → 保留缓存
        lp.boto3 = type("_B", (), {
            "client": staticmethod(
                lambda *a, **k: _client_raising(
                    "AccessDeniedException", 403,
                    "User: arn:aws:sts::1:assumed-role/x is not authorized to perform: "
                    "bedrock:InvokeModel on resource: arn:aws:bedrock:...")),
        })()
        _set_key("valid-but-restricted")
        try:
            lp._invoke_bedrock("m", "sys", "usr", 100)
        except ClientError:
            pass
        key2, _ = _key_cache_state()
        _check("403 授权不足保留 Key 缓存",
               key2 == "valid-but-restricted", repr(key2))

        # **死 Key：也是 403 + AccessDeniedException，只有 message 不同 → 必须失效。**
        # 上一版判据「只认 401、不认 403」让这条永不触发（实测 us-east-2：死 Key 在
        # Converse 上回 403 "Authentication failed: Please make sure your API Key is valid."）。
        lp.boto3 = type("_B", (), {
            "client": staticmethod(
                lambda *a, **k: _client_raising(
                    "AccessDeniedException", 403,
                    "Authentication failed: Please make sure your API Key is valid.")),
        })()
        _set_key("revoked-key")
        try:
            lp._invoke_bedrock("m", "sys", "usr", 100)
        except ClientError:
            pass
        key_dead, ts_dead = _key_cache_state()
        _check("死 Key（403 + authentication failed）清空缓存",
               key_dead is None and ts_dead == 0.0, f"{key_dead!r} ts={ts_dead}")

        # ValidationException 是模型/参数问题，与凭证无关 —— 不得连带失效。
        lp.boto3 = type("_B", (), {
            "client": staticmethod(
                lambda *a, **k: _client_raising("ValidationException", 400))
        })()
        _set_key("good-key")
        try:
            lp._invoke_bedrock("m", "sys", "usr", 100)
        except ClientError:
            pass
        key3, _ = _key_cache_state()
        _check("ValidationException 不动 Key 缓存", key3 == "good-key", repr(key3))
    finally:
        lp.boto3 = orig_boto3


def main() -> int:
    print("=" * 72)
    print("后端任务 Mantle（Responses）分支测试")
    print("=" * 72)
    test_kind_dispatch()
    test_region_allowlist()
    test_response_normalisation()
    test_request_body()
    test_credentials()
    test_credential_mode_gates_the_key()
    test_mantle_401_invalidates_the_key()
    test_converse_401_invalidates_the_key()
    print("\n" + "=" * 72)
    if _failed:
        print(f"{FAIL} {_failed} 项失败")
        return 1
    print(f"{PASS} 全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
