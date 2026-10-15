"""Unified LLM provider — Bedrock / OpenAI 兼容网关 共存抽象层。

设计原则：
1. 调用方只看到一个函数 `invoke_llm(model_id, system_prompt, user_prompt, max_tokens)`
   返回统一格式 `{"content": str, "stop_reason": str, "usage": dict}`
2. 走哪条协议**只看模型目录条目的 `kind`**（调用方从 BFF 投影的后端任务配置里拿到）：
   `openai_compatible` → 网关；`bedrock_mantle_responses` → Mantle；其余 → Converse。
   2026-10 之前这里还看 SSM `/notiops/llm/provider`（bedrock | litellm）。那个参数每次
   栈更新都被 CloudFormation 写回 `bedrock`，管理页也从没能设它 —— 实际是死开关，已删。
3. 凭证：
   - Bedrock：Admin 的来源次序里排在最前的 Bedrock 来源（iam / api_key）；api_key 时从
     Secrets Manager `notiops/bedrock-api-key` 读 Key
   - 网关：Secrets Manager `notiops/litellm-config` 读 base_url + api_key（名字是历史遗留）
4. 失败处理：本函数只抛异常，调用方决定降级策略。

兼容性：
- 沿用现有 `bedrock_invoker.invoke_bedrock` 的签名 + 返回值；
  历史调用点零改动只需把导入换成 `from shared.llm_provider import invoke_llm`。
- 网关路径走 OpenAI Chat Completions 协议（POST {base}/chat/completions，LiteLLM Proxy
  与 New API 都提供），不引入任何 SDK，纯 urllib + json（保持 Lambda 启动快）。
"""

from __future__ import annotations
from shared.net import safe_urlopen

import ipaddress
import json
import logging
import os
import re
import socket
import time
import urllib.error
import urllib.parse
import urllib.request

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


class LiteLLMConfigError(RuntimeError):
    """LiteLLM 配置不完整,无法调用。"""


class LiteLLMHTTPError(RuntimeError):
    """LiteLLM 端点返回非 2xx。"""


def _is_blocked_ip(addr) -> bool:
    """True if the IP is in a range base_url must never reach."""
    mapped = getattr(addr, "ipv4_mapped", None)
    if mapped is not None:
        addr = mapped  # treat ::ffff:169.254.x.x as the embedded IPv4
    # `not is_global` 覆盖了私网 / 回环 / 链路本地 / 保留 / 未指定，外加 CGNAT 100.64/10 ——
    # 与 core/llm_config、BFF 的 BlockList 同一个口径。组播另判（is_global 对部分组播为真）。
    return (not addr.is_global) or addr.is_multicast


def _validate_base_url(url: str) -> None:
    """校验 base_url 不指向内网地址，防止 SSRF。

    层次：localhost/IP 字面量黑名单 → .internal/.local 域名 → **DNS 解析**后
    校验所有 A/AAAA 记录都不是私网/环回/链路本地/保留地址（堵"公网域名解析
    到内网 IP"的绕过）。DNS 解析失败时不硬拦（best-effort，避免离线/解析抖动
    误伤；真正不可达时实际 HTTP 请求自然失败）。
    """
    parsed = urllib.parse.urlparse(url)
    hostname = parsed.hostname or ""
    if not hostname:
        raise LiteLLMConfigError("base_url has no hostname")
    if hostname in ("localhost", "127.0.0.1", "::1", "0.0.0.0"):  # nosec B104 - membership check to REJECT these hosts, not a socket bind to all interfaces
        raise LiteLLMConfigError(f"base_url must not point to localhost: {hostname}")
    try:
        addr = ipaddress.ip_address(hostname)
        if _is_blocked_ip(addr):
            raise LiteLLMConfigError(
                f"base_url must not point to private/link-local address: {hostname}"
            )
        return
    except ValueError:
        # hostname 是域名，不是 IP
        pass
    if hostname.endswith(".internal") or hostname.endswith(".local"):
        raise LiteLLMConfigError(
            f"base_url must not point to internal hostname: {hostname}"
        )
    # 解析 DNS，逐一校验解析出的地址（防公网域名→内网 IP 绕过）
    try:
        infos = socket.getaddrinfo(hostname, parsed.port or 443,
                                   proto=socket.IPPROTO_TCP)
    except OSError:
        return  # 解析失败：best-effort 放行，实际请求会自然失败
    for info in infos:
        try:
            addr = ipaddress.ip_address(info[4][0])
        except ValueError:
            continue
        if _is_blocked_ip(addr):
            raise LiteLLMConfigError(
                f"base_url hostname {hostname} resolves to a private/link-local "
                f"address ({info[4][0]}) — refused to prevent SSRF"
            )

logger = logging.getLogger("shared.llm_provider")

def reset_cache() -> None:
    """测试用 / 强制刷新（管理员页保存配置后立刻生效）。

    清来源次序、Bedrock Key 与网关连接信息三份缓存 —— 都是「Admin 一保存就该生效」的配置，
    只清其中一部分会让调用方拿到半新半旧的组合（例如新来源配旧凭证）。
    """
    global _cached_litellm, _cached_litellm_ts
    global _cached_cred_mode, _cached_cred_mode_ts, _cached_active_source, _cached_gateway_rev
    global _cached_bedrock_key, _cached_bedrock_key_ts
    _cached_active_source = ""
    _cached_gateway_rev = None
    _cached_litellm = None
    _cached_litellm_ts = 0.0
    _cached_cred_mode = None
    _cached_cred_mode_ts = 0.0
    _cached_bedrock_key = None
    _cached_bedrock_key_ts = 0.0


# ---------------------------------------------------------------------------
# OpenAI 兼容网关连接信息（Secrets Manager） — 5 分钟 TTL
# ---------------------------------------------------------------------------

_LITELLM_SECRET_ID = os.environ.get(
    "LITELLM_CONFIG_SECRET_ARN", "notiops/litellm-config"
)
_LITELLM_CACHE_TTL = 300

_cached_litellm: dict | None = None
_cached_litellm_ts: float = 0.0


def _normalise_gateway_base_url(url) -> str:
    """网关地址规整成 OpenAI 根路径；不合法返回 ""。

    与 `core/llm_config.normalise_gateway_base_url`、BFF `normalizeGatewayBaseUrl` 同一套规则
    （本 Lambda 不一定打包 core/，所以抄一份；三份的一致性由 tests/test_llm_provider.py 守）：
    只收 https、不带 query / fragment / 用户名密码；去尾 `/` 与误贴的 `/chat/completions`、
    `/models`；路径为空补 `/v1`，自定义前缀原样保留。私网等地址由 `_validate_base_url` 另拦。
    """
    s = str(url or "").strip()
    if not s:
        return ""
    try:
        p = urllib.parse.urlsplit(s)
        host = p.hostname or ""
        _ = p.port
    except ValueError:
        return ""
    if p.scheme.lower() != "https" or not host:
        return ""
    if p.query or p.fragment or p.username or p.password:
        return ""
    # 与 core/llm_config 同：去掉末尾的点再判；inet_aton 写法（`0x7f.1`、`2130706433`）不收。
    bare = host.lower().rstrip(".")
    if bare == "localhost" or bare.endswith(".localhost"):
        return ""
    if re.fullmatch(r"(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+)){0,3}", bare):
        try:
            if not ipaddress.ip_address(bare).is_global:
                return ""
        except ValueError:
            return ""
    path = p.path.rstrip("/")
    for suffix in ("/chat/completions", "/models"):
        if path.lower().endswith(suffix):
            path = path[: -len(suffix)].rstrip("/")
    if not path:
        path = "/v1"
    return f"https://{p.netloc}{path}"


def _get_litellm_config() -> dict:
    """读网关连接信息 Secret（带缓存）。返回 `{"base_url", "api_key"}`，base_url 已规整。

    Secret 内容形如 `{"base_url": "https://gw.example.com", "api_key": "sk-..."}`，
    由 BFF `PUT /admin/llm-config/gateway` 写入。读不到 / 不合法 → 两个字段都是空串，
    由调用方抛 `LiteLLMConfigError`。
    """
    global _cached_litellm, _cached_litellm_ts
    now = time.time()
    if _cached_litellm is not None and (now - _cached_litellm_ts) < _LITELLM_CACHE_TTL:
        return _cached_litellm

    region = os.environ.get("AWS_REGION", "us-east-1")
    try:
        client = boto3.client("secretsmanager", region_name=region)
        resp = client.get_secret_value(SecretId=_LITELLM_SECRET_ID)
        cfg = json.loads(resp["SecretString"]) or {}
        if not isinstance(cfg, dict):
            cfg = {}
    except Exception as e:
        # 只记类型：异常文本可能带 Secret ARN 以外的上下文，没必要进日志。
        logger.warning("read gateway config secret failed: %s", type(e).__name__)
        cfg = {}

    cfg = {
        "base_url": _normalise_gateway_base_url(cfg.get("base_url")),
        "api_key": str(cfg.get("api_key") or "").strip(),
    }
    _cached_litellm = cfg
    _cached_litellm_ts = now
    return cfg


def _invalidate_gateway_config() -> None:
    """网关回 401：Admin 刚换了 Key 而本进程还缓存着旧的。清掉，下次重读 Secret。"""
    global _cached_litellm, _cached_litellm_ts
    _cached_litellm = None
    _cached_litellm_ts = 0.0


# ---------------------------------------------------------------------------
# Bedrock — 复用 lambda3 现有 invoke 逻辑(import 它,避免代码漂移)
# ---------------------------------------------------------------------------

# 🔴 **这里以前有一个 `_TRUNCATION_NOTICE`，撞 `max_tokens` 时直接拼到
#    `content` 末尾。2026-09-05 删掉 —— 它是个跨模块的静默数据污染源。**
#
#    坏法：这个 provider 是**通用**的，`content` 的消费者里有一半根本不是
#    「给人看的正文」，而是要**解析**的结构化输出。拼一句中文告警进去 ⇒
#
#      • `core/case_classifier.py`   要 `json.loads(content)` ⇒ 解析失败 ⇒
#        真实生产事故：日志里 `raw='---\n⚠️ 报告因 token 限制被截断…'`，
#        一个真的 support case 被降级成 `fallback (classifier unavailable)` 误分类。
#      • 推理型模型（Grok 4.6 起全槽位默认）会把输出预算花在 thinking 上，
#        于是 `text` 块**空**而 `stopReason == max_tokens` ⇒ 拼完 `content`
#        只剩那 35 个字符的告警本身 ⇒ 下游的「空内容」判据全部失效（它不空了），
#        降级路径永不触发，用户看到的是一张**只有一句告警**的卡片。
#        这正是 2026-09-05 用户报的 D4。
#
#    正确的分工：截断是**元信息**，本来就已经在返回值里（`stop_reason`）。
#    要不要提示用户、提示在哪一层，由**渲染层**决定（它知道自己在渲染卡片
#    还是在喂 `json.loads`）。provider 不许改写 payload。
#
# ⚠️ 别再加回来。要加提示就在渲染处读 `stop_reason`。

_bedrock_config = Config(
    read_timeout=300,
    connect_timeout=10,
    retries={"max_attempts": 2, "mode": "adaptive"},
)

# Bedrock API Key 缓存(独立于 lambda3,避免循环 import)
_BEDROCK_API_KEY_SECRET_ENV = "BEDROCK_API_KEY_SECRET_ARN"  # nosec B105 - env var *name*, not a credential
_cached_bedrock_key: str | None = None
_cached_bedrock_key_ts: float = 0.0


_CONFIG_TABLE_ENV = "CONFIG_TABLE"
_LLMCFG_PK = "llmcfg"
_LLMCFG_SK = "meta"
_cached_cred_mode: str | None = None
_cached_cred_mode_ts: float = 0.0
# 同一次 GetItem 顺带读出的第一来源与网关版本号（见 _credential_mode）。
_cached_active_source: str = ""
_cached_gateway_rev: int | None = None
# 来源配置的缓存窗口。与对话侧 core/llm_config 的目录 TTL 同一个数：Admin 换了网关 / 次序，
# 后端任务最迟一分钟跟上（gateway_rev 一变，网关连接信息的缓存也立刻作废）。
_META_TTL = 60


def _credential_mode() -> str:
    """Admin 配的凭证方式："iam" | "api_key"（TTL 缓存，读不到一律当 "iam"）。

    为什么后端任务也必须看这个开关：在此之前本模块只判断「`BEDROCK_API_KEY_SECRET_ARN`
    有值且 Secret 非空」就用 Key，而那个 env 是 CDK **无条件**注入的。于是管理员把开关
    拨回 IAM 却保留 Key（这正是「先停用、别销毁」的标准做法）时，对话侧走 IAM、PHD 翻译
    与报告精简走 Key —— 同一份目录、两个 caller 身份，正是 spec R5.2 要消灭的不一致。
    对话侧（`core/llm_config.get_bedrock_api_key`）与 BFF 探测（`probeCredential`）都已按
    这个开关判断，本模块是最后一处漏的。

    读不到就当 "iam"：那是**不使用** Key 的一侧，失败方向保守（宁可回退部署角色，
    也不要在管理员以为已停用 Key 的情况下继续拿它计费与鉴权）。
    """
    global _cached_cred_mode, _cached_cred_mode_ts, _cached_active_source, _cached_gateway_rev
    now = time.time()
    if _cached_cred_mode is not None and (now - _cached_cred_mode_ts) < _META_TTL:
        return _cached_cred_mode

    table = os.environ.get(_CONFIG_TABLE_ENV, "")
    if not table:
        # 没有配置表的部署（老栈 / 单测）：保持历史行为，不因为读不到开关而砍掉 Key，
        # 否则升级过程中后端任务会突然从 Key 静默切回 IAM。
        _cached_cred_mode, _cached_cred_mode_ts = "api_key", now
        return "api_key"
    try:
        import boto3 as _b
        item = _b.resource("dynamodb").Table(table).get_item(
            Key={"PK": _LLMCFG_PK, "SK": _LLMCFG_SK}).get("Item") or {}
        mode = _bedrock_source(item)
        active = _active_source(item)
        try:
            rev = int(item.get("gateway_rev") or 0)
        except (TypeError, ValueError):
            rev = 0
    except Exception as e:  # noqa: BLE001 — 配置读失败不得中断推送
        logger.warning("read credential_mode failed, assuming iam: %s", type(e).__name__)
        # 读失败：上一次读到的第一来源与网关版本号**原样留着**（stale-while-error）。清空的话，
        # 网关排第一的部署会在一次 GetItem 抖动后放行 Bedrock 兜底（见 invoke_llm 的 backend_task）。
        if _cached_cred_mode is not None:
            _cached_cred_mode_ts = now
            return _cached_cred_mode
        mode, active, rev = "iam", "", None
    if rev is not None and _cached_gateway_rev is not None and rev != _cached_gateway_rev:
        _invalidate_gateway_config()     # Admin 刚改过网关：别再用缓存的旧地址 / 旧 Key
    _cached_cred_mode, _cached_cred_mode_ts = mode, now
    _cached_active_source = active
    if rev is not None:
        _cached_gateway_rev = rev
    return mode


def _active_source(item: dict) -> str:
    """Admin 排在第一的来源（"iam" | "api_key" | "gateway"）；与 core/llm_config 同一套规整。"""
    order = item.get("source_order")
    for s in (order if isinstance(order, list) else []):
        s = str(s or "").strip().lower()
        if s in ("iam", "api_key", "gateway"):
            return s
    mode = str(item.get("credential_mode") or "iam").strip().lower()
    return mode if mode in ("iam", "api_key", "gateway") else "iam"


def _bedrock_source(item: dict) -> str:
    """调 Bedrock 时用哪种凭证："iam" | "api_key"。

    来源次序 `source_order` 里排在最前的 Bedrock 来源；没有次序（升级前的配置）就看
    `credential_mode`。网关排第一时后端任务本应绑网关模型（BFF 按第一来源投影），走到这里
    说明某个任务仍绑着 Bedrock 模型 —— 那就用排在最前的 Bedrock 凭证，与 IM 端同一条规则。
    """
    # 与 core/llm_config._normalise_source_order 一致：未知 / 重复项丢掉；一个合法项都没有时
    # 以 credential_mode 打头；缺的按 iam → api_key → gateway 补齐。然后取第一个 Bedrock 来源。
    known = ("iam", "api_key", "gateway")
    order: list[str] = []
    for s in (item.get("source_order") if isinstance(item.get("source_order"), list) else []):
        s = str(s or "").strip().lower()
        if s in known and s not in order:
            order.append(s)
    if not order:
        mode = str(item.get("credential_mode") or "iam").strip().lower()
        order = [mode if mode in known else "iam"]
    order.extend(s for s in known if s not in order)
    return next(s for s in order if s != "gateway")


def _get_bedrock_api_key() -> str | None:
    global _cached_bedrock_key, _cached_bedrock_key_ts
    # 开关不在 api_key 时连 Secret 都不读 —— 与 core/llm_config.get_bedrock_api_key 同款语义。
    if _credential_mode() != "api_key":
        return None
    now = time.time()
    if _cached_bedrock_key is not None and (now - _cached_bedrock_key_ts) < 300:
        return _cached_bedrock_key or None

    secret_arn = os.environ.get(_BEDROCK_API_KEY_SECRET_ENV, "")
    if not secret_arn:
        return None
    try:
        region = os.environ.get("AWS_REGION", "us-east-1")
        client = boto3.client("secretsmanager", region_name=region)
        resp = client.get_secret_value(SecretId=secret_arn)
        secret_dict = json.loads(resp["SecretString"])
        api_key = secret_dict.get("bedrock_api_key", "") or ""
        _cached_bedrock_key = api_key
        _cached_bedrock_key_ts = now
        return api_key or None
    except Exception as e:
        logger.warning("read Bedrock API key secret failed: %s", e)
        _cached_bedrock_key = ""
        _cached_bedrock_key_ts = now
        return None


# 「凭证本身不被认可」的判据 —— 与 `core/llm_config.is_credential_rejected` 同一份逻辑。
#
# 为什么在这里重写一遍而不是 import：PHD Lambda 的打包是否含 `core/` 没有确认过，而这条
# 判据是失效功能的核心，不能靠一个可能缺失的 import。`_invalidate_bedrock_api_key` 里那次
# lazy import 只用来发指标，缺了可以降级；这里缺了功能就没了。
#
# **实测形状**（us-east-2，2026-08，本部署账号）：
#   Converse + 已吊销 Key → 403 AccessDeniedException
#       "Authentication failed: Please make sure your API Key is valid."
#   Converse + 授权不足   → 403 AccessDeniedException
#       "User: arn:... is not authorized to perform: bedrock:InvokeModel on resource: ..."
#   Mantle   + 已吊销 Key → 401 invalid_api_key
# 两种 403 共用同一个 code，只有 message 能区分。第一版「只认 401、绝不认 403」因此让
# Converse 侧的失效永远不触发 —— 死 Key 在那条路上根本不回 401。
_AUTH_FAIL_CODES = frozenset({
    "UnrecognizedClientException",
    "InvalidSignatureException",
    "ExpiredTokenException",
    "UnauthorizedException",
    "HttpAuthenticationException",
})
_CREDENTIAL_DEAD_PHRASE = "authentication failed"
_AUTHZ_DENIED_PHRASE = "is not authorized to perform"


def _is_credential_rejected(status, code: str = "", message: str = "") -> bool:
    """凭证本身不成立（而非授权不足 / 限流 / 参数错）。与 core 侧同语义。

    message 只用于判断，绝不回传或落日志（可能含账号 / 资源 ARN，spec R5.5）。
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


def _invalidate_bedrock_api_key() -> None:
    """Key 被拒时失效**本模块的** Key 缓存（spec R7.2）。

    为什么这里要单独实现一份：后端任务（PHD 翻译 / 报告精简）不走 `core/llm_config`，
    它有上面那份独立的 `_cached_bedrock_key` + 300s TTL。只调 core 的
    `invalidate_api_key()` 清不掉这一份，Key 轮换后这个 Lambda 仍会用旧 Key 直到 TTL 到期。

    分两步且顺序固定：
      1. 清本地缓存 —— 纯内存赋值，不可能失败，所以放在前面，保证核心效果一定达成；
      2. 借 core 发 KeyAuthFail 指标 —— best-effort。PHD Lambda 的打包是否含 `core/`
         没有确认过（`shared/report_delivery/*` 有 import core 的先例，但那是另一个 Lambda），
         所以用分支内 lazy import + 吞异常降级：拿不到指标可以接受，丢掉失效不行。
    """
    global _cached_bedrock_key, _cached_bedrock_key_ts
    _cached_bedrock_key = None
    _cached_bedrock_key_ts = 0.0
    try:
        from core import llm_config as _core_llm_config
        _core_llm_config.invalidate_api_key()
    except Exception:  # noqa: BLE001 -- 指标是可选的，失效才是必须的
        logger.warning("bedrock api key rejected (401); local cache cleared, "
                       "KeyAuthFail metric not emitted (core/ unavailable)")


def _invoke_bedrock(
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
) -> dict:
    api_key = _get_bedrock_api_key()
    if api_key:
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = api_key
    else:
        os.environ.pop("AWS_BEARER_TOKEN_BEDROCK", None)

    client = boto3.client("bedrock-runtime", config=_bedrock_config)
    try:
        # Converse 分支。只在 bedrock-mantle 上架的模型走 _invoke_mantle_responses,
        # 由 invoke_llm 按目录的 `kind` 分派 —— 那些模型在这里会报
        # `ValidationException: The provided model identifier is invalid`。
        response = client.converse(
            modelId=model_id,
            system=[{"text": system_prompt}],
            messages=[{"role": "user", "content": [{"text": user_prompt}]}],
            inferenceConfig={"maxTokens": max_tokens},
        )
    except ClientError as e:
        err = e.response.get("Error", {})
        logger.error(
            "Bedrock converse failed: code=%s message=%s model=%s",
            err.get("Code"),
            err.get("Message"),
            model_id,
        )
        # 只有实际用了 Key 才可能是 Key 被拒；IAM 模式下这是执行角色的问题，与 Key 无关。
        status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
        if api_key and _is_credential_rejected(status, err.get("Code") or "",
                                               err.get("Message") or ""):
            _invalidate_bedrock_api_key()
        raise

    output = response.get("output", {})
    message = output.get("message", {})
    content_blocks = message.get("content", [])
    # ⚠️ 取**第一个带 `text` 的块**，不是 `content[0]`。推理型模型（Grok 4.6、
    # DeepSeek、GLM）在 Converse 下会把 `reasoningContent` 放在 content[0]，那个块
    # **没有** `text` 键 —— 硬取 [0] 会拿到空串，表现为"模型什么都没回"（不报错、
    # 不抛异常，下游只看到空内容然后走各自的 fallback，归因极难）。
    # 2026-09-01 默认模型换成 Grok 4.6 时补上；对 Claude 行为完全不变（它的
    # content[0] 就是 text 块）。
    content = ""
    for _blk in content_blocks:
        if isinstance(_blk, dict) and "text" in _blk:
            content = _blk.get("text") or ""
            break
    stop_reason = response.get("stopReason", "")
    usage = response.get("usage", {})

    # ⚠️ 撞 max_tokens 时**不**改写 content —— 截断信息就在 stop_reason 里，
    #    由渲染层决定要不要提示。理由见文件上方那段注释。
    return {"content": content, "stop_reason": stop_reason, "usage": usage}


# ---------------------------------------------------------------------------
# Bedrock Mantle(OpenAI Responses 协议)
# ---------------------------------------------------------------------------
#
# 为什么需要这条分支：Bedrock 上有一批模型**只在 `bedrock-mantle` 端点提供**，
# 不在 `bedrock-runtime` 上，因此 Converse 根本调不到。实测(us-east-2)：
#     Converse(openai.gpt-5.6-terra)    → ValidationException: The provided
#                                          model identifier is invalid
#     Converse(openai.gpt-oss-120b-1:0) → 200 OK    ← 对照组
# 也就是说这不是「OpenAI 家族不支持 Converse」，而是**具体模型在哪个端点上架**的
# 问题。GPT-5.6 Terra 的 model card 里 Programmatic Access 只有 bedrock-mantle
# 一行，Geo / Global inference ID 均为 Not supported，可以对上。
#
# 在这条分支之前，对话侧(webchat / IM)早就能用这些模型了，后端任务侧(PHD 翻译 /
# 报告精简)却不能 —— 因为后端只有 `client.converse()` 一条路。同一个模型目录，
# 两端能力不一致，管理员在 Admin 里看到的就是「加进来了但后端下拉是灰的」。
# 这条分支把两端补齐：目录里任何 Bedrock 模型，两端都能用。
#
# 与对话侧 `core/openai_responses_client.py` 的差别（有意为之，不是重复实现）：
#   · 后端任务是**单轮无工具**调用，因此不传 tools / previous_response_id，
#     也就用不到 Responses 的服务端会话状态；
#   · 既然用不到，就显式 `store: false` —— 默认 `true` 会让提示词与回复在**请求
#     源区**留存 30 天(见 Responses API 文档)。对话侧不能这么设(它靠
#     previous_response_id 串多轮)，后端侧可以，白拿一个数据留存收益；
#   · `max_output_tokens` 由调用方传入，而对话侧固定 8000。

_MANTLE_KIND = "bedrock_mantle_responses"

# Mantle 端点所在区域白名单。**必须白名单**：region 来自 DDB 模型目录（Admin 可写），
# 直接插进 hostname 等于把请求目标交给配置数据决定 —— 白名单把它限制在 AWS 自家域名内。
# 名单取自 Responses API 文档的 "Supported Regions and Endpoints"。
_MANTLE_REGIONS = frozenset({
    "us-east-1", "us-east-2", "us-west-2",
    "ap-northeast-1", "ap-south-1", "ap-southeast-2", "ap-southeast-3",
    "eu-central-1", "eu-north-1", "eu-south-1", "eu-west-1", "eu-west-2",
    "sa-east-1", "us-gov-west-1",
})
_MANTLE_REGION_DEFAULT = "us-east-2"
_MANTLE_TIMEOUT_SECONDS = 300


def _mantle_region(region: str) -> str:
    """校验并归一化 Mantle 区域。非白名单值一律回退到默认区并留日志。

    回退而不抛异常：后端任务的契约是「配置问题不能阻断推送」——一条 PHD 通知晚发
    或换个区发，都比不发好。但必须留 WARNING，否则拼错的 region 会静默生效。
    """
    r = (region or "").strip()
    if r in _MANTLE_REGIONS:
        return r
    if r:
        logger.warning(
            "mantle region %r is not a known Mantle endpoint region; "
            "falling back to %s", r, _MANTLE_REGION_DEFAULT,
        )
    return _MANTLE_REGION_DEFAULT


def _mantle_text(response: dict) -> str:
    """从 Responses 载荷里取助手可见文本。

    形如 `{"output": [{"type": "reasoning"...}, {"type": "message",
    "content": [{"type": "output_text", "text": "..."}]}]}`。

    这里**不做**对话侧那套 protocol-leak / spam 清洗：那些事故都由**工具调用参数
    被 token 上限截断**触发（见 core/openai_responses_client._looks_like_protocol_leak
    的案例注释），而后端任务不传 tools，进不了那条路径。少一层清洗也就少一个
    「翻译结果被静默丢弃」的失败模式。
    """
    parts: list[str] = []
    for block in response.get("output") or []:
        if block.get("type") != "message":
            continue
        for sub in block.get("content") or []:
            if sub.get("type") == "output_text" and sub.get("text"):
                parts.append(sub["text"])
    return "\n".join(parts).strip()


def _invoke_mantle_responses(
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
    region: str,
) -> dict:
    """单轮 Responses API 调用，返回与 `_invoke_bedrock` 完全一致的三键结构。

    凭证：配了 Bedrock API Key 就发 `Authorization: Bearer <key>`（文档里 Mantle 的
    推荐认证方式，对应 IAM 动作 `bedrock-mantle:CallWithBearerToken`）；没配则用
    SigV4 签名，签名服务名 `bedrock`（与对话侧 core/openai_responses_client 一致，
    那条已在生产验证）。这样 Key 语义在对话侧与后端侧终于统一 —— 之前后端只有 IAM。
    """
    region = _mantle_region(region)
    url = f"https://bedrock-mantle.{region}.api.aws/openai/v1/responses"

    body: dict = {
        "model": model_id,
        "input": user_prompt,
        "max_output_tokens": max_tokens,
        # 单轮无工具 → 不需要服务端会话状态。关掉可避免 30 天源区留存。
        "store": False,
    }
    if system_prompt:
        body["instructions"] = system_prompt
    body_bytes = json.dumps(body).encode("utf-8")

    headers = {"Content-Type": "application/json"}
    api_key = _get_bedrock_api_key()
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
        req = urllib.request.Request(url, data=body_bytes, method="POST",
                                     headers=headers)
    else:
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest
        creds = boto3.Session().get_credentials().get_frozen_credentials()
        signed = AWSRequest(method="POST", url=url, data=body_bytes,
                            headers=headers)
        SigV4Auth(creds, "bedrock", region).add_auth(signed)
        prepared = signed.prepare()
        req = urllib.request.Request(prepared.url, data=prepared.body,
                                     method=prepared.method)
        for k, v in prepared.headers.items():
            req.add_header(k, v)

    try:
        with safe_urlopen(req, timeout=_MANTLE_TIMEOUT_SECONDS) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        logger.error("Mantle responses failed: status=%s model=%s detail=%s",
                     e.code, model_id, detail)
        # 同 Converse 分支：只有真用了 Bearer 才可能是 Key 被拒，且只认 401。
        if api_key and e.code == 401:
            _invalidate_bedrock_api_key()
        raise

    content = _mantle_text(payload)
    # Responses 用 `status` + `incomplete_details.reason` 表达截断，Bedrock 用
    # `stopReason == "max_tokens"`。映射成后者，上游那套截断判定就不用为第二种
    # 协议再写一遍。⚠️ 只映射元信息，**不**改写 content（理由见文件上方注释）。
    reason = str(((payload.get("incomplete_details") or {}).get("reason") or ""))
    stop_reason = "max_tokens" if reason == "max_output_tokens" else str(
        payload.get("status") or "")

    # usage 字段名对齐 Bedrock（调用方与既有测试都按 inputTokens/outputTokens 读）。
    u = payload.get("usage") or {}
    usage = {
        "inputTokens": u.get("input_tokens", 0),
        "outputTokens": u.get("output_tokens", 0),
        "totalTokens": u.get("total_tokens", 0),
    }
    return {"content": content, "stop_reason": stop_reason, "usage": usage}


# ---------------------------------------------------------------------------
# OpenAI 兼容网关（LiteLLM Proxy / New API …，Chat Completions 协议）
# ---------------------------------------------------------------------------

_GATEWAY_KIND = "openai_compatible"

# 错误文本里可能回显 Key（LiteLLM 的鉴权失败会带上收到的 Key 片段）。进日志、进异常之前
# 一律抹掉形如 `sk-...` 与 `Bearer ...` 的串。
_SECRETISH_RE = re.compile(r"(sk-[A-Za-z0-9_\-\.]{4,}|Bearer\s+[^\s\"',]+)")
# 网关响应体读取上限：正常的 chat/completions 回答远小于它；坏掉 / 恶意的网关不能把 Lambda 内存吃光。
_GATEWAY_MAX_BODY = 5 * 1024 * 1024


def _redact(text: str, secret: str = "") -> str:
    """抹掉错误文本里像凭证的串。`secret` 是本次用的 Key：上游原样回显它时（不一定是 sk- 开头）
    也要抹掉。"""
    out = text or ""
    if secret and len(secret) >= 8:
        out = out.replace(secret, "[redacted]")
    return _SECRETISH_RE.sub("[redacted]", out)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """网关调用**不跟随重定向**：urllib 默认会把 Authorization 头原样带到 Location（含 http://），
    POST 还会被改成 GET 重发。网关前面的代理配错一个 301 就能把 Key 明文送出去。BFF 与 webchat
    runtime 两侧同样拒绝重定向。"""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_GATEWAY_OPENER = urllib.request.build_opener(_NoRedirect)


def _invoke_gateway(
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int,
) -> dict:
    """POST {base}/chat/completions（非流式）。model_id 原样透传给网关。

    2026-10 之前这里叫 `_invoke_litellm`，会给不含 `/` 的 model_id 自动补 `bedrock/` 前缀，
    并把路径写死成 `{base}/v1/chat/completions`。两样都删了：
      · 前缀改写是参考项目「LiteLLM 后面挂 Bedrock」那一种部署的假设。New API、或 LiteLLM 里
        自定义了 model_name 的部署，补了前缀就找不到模型。目录里填什么就发什么。
      · 路径写死 `/v1` 让「base_url 已经带 /v1」的配置拼成 `/v1/v1/...`。base_url 现在由
        `_normalise_gateway_base_url` 统一规整成 OpenAI 根路径。
    """
    cfg = _get_litellm_config()
    base_url = cfg["base_url"]
    api_key = cfg["api_key"]
    if not base_url or not api_key:
        raise LiteLLMConfigError(
            "The OpenAI-compatible gateway is the model source for this task, but its "
            "base_url/api_key are missing or invalid (Secrets Manager notiops/litellm-config). "
            "Fix it under More -> Admin -> Models -> gateway, or move a Bedrock source to the "
            "top and save."
        )
    _validate_base_url(base_url)

    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "max_tokens": max_tokens,
        "stream": False,
    }
    body = json.dumps(payload).encode("utf-8")
    url = f"{base_url}/chat/completions"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        # 与 Bedrock invoker 一致用 5min 超时。不经 safe_urlopen 的默认 opener：那个会跟随重定向
        # （见 _NoRedirect）。scheme 已由 _normalise_gateway_base_url 限定为 https。
        with _GATEWAY_OPENER.open(req, timeout=300) as resp:  # noqa: S310
            raw_bytes = resp.read(_GATEWAY_MAX_BODY + 1)
            if len(raw_bytes) > _GATEWAY_MAX_BODY:
                raise LiteLLMHTTPError("gateway response too large")
            raw = raw_bytes.decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if 300 <= e.code < 400:
            raise LiteLLMHTTPError(f"gateway redirected (HTTP {e.code}, not followed)") from None
        body_txt = ""
        try:
            body_txt = _redact(e.read(4096).decode("utf-8", errors="replace")[:1000], api_key)
        except Exception:  # noqa: BLE001
            pass
        if e.code == 401:
            _invalidate_gateway_config()
        # 不记 url：base_url 是客户内部信息，排障用 model + 状态码足够定位。
        logger.error("gateway HTTP %s for model=%s body=%s", e.code, model_id, body_txt[:300])
        raise LiteLLMHTTPError(
            f"gateway returned HTTP {e.code}: {body_txt[:200]}"
        ) from e
    except Exception as e:
        logger.error("gateway request failed: %s", type(e).__name__)
        raise

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise LiteLLMHTTPError(
            f"gateway returned non-JSON body: {_redact(raw[:200], api_key)}"
        ) from e

    if isinstance(data, dict) and "error" in data:
        err = data["error"]
        msg = err.get("message", "") if isinstance(err, dict) else str(err)
        raise LiteLLMHTTPError(f"gateway error: {_redact(str(msg), api_key)[:300]}")

    choices = (data.get("choices") if isinstance(data, dict) else None) or []
    if not choices:
        raise LiteLLMHTTPError(f"gateway returned no choices: {_redact(raw[:200], api_key)}")
    msg_obj = (choices[0] or {}).get("message") or {}
    content = msg_obj.get("content", "") or ""
    if isinstance(content, list):
        # 少数后端把 content 回成 parts 数组（OpenAI 的多模态形状）。只取文本段。
        content = "".join(str(p.get("text") or "") for p in content
                          if isinstance(p, dict) and p.get("type") in ("text", "output_text"))
    finish_reason = (choices[0] or {}).get("finish_reason", "") or ""
    usage = data.get("usage") or {}

    # 把 OpenAI 的 finish_reason 翻成 Bedrock 用的同义词,
    # 让上层判断 (== "max_tokens") 的代码继续工作。
    stop_reason = {
        "stop": "end_turn",
        "length": "max_tokens",
        "content_filter": "content_filtered",
        "tool_calls": "tool_use",
    }.get(finish_reason, finish_reason or "end_turn")

    # ⚠️ 撞 max_tokens 时**不**改写 content（理由见文件上方注释）。

    # 把 OpenAI 的 usage 名字标准化成 Bedrock 风格,日志和监控能看
    bedrock_usage = {
        "inputTokens": usage.get("prompt_tokens", 0),
        "outputTokens": usage.get("completion_tokens", 0),
        "totalTokens": usage.get("total_tokens", 0),
    }

    logger.info(
        "gateway chat completed: model=%s stop=%s usage=%s",
        model_id, stop_reason, bedrock_usage,
    )

    return {
        "content": content,
        "stop_reason": stop_reason,
        "usage": bedrock_usage,
    }


_legacy_checked = False


def _warn_legacy_provider_param() -> None:
    """升级提示：SSM `/notiops/llm/provider` 不再参与路由（2026-10）。

    之前把它手动设成 `litellm` 的部署，升级后后端任务会改走 Bedrock —— 路由已改为按目录 kind，
    网关要在 Admin「模型 → 模型来源」里配。这里每个进程只查一次，命中就打 ERROR + 指标，
    让这次行为变化**看得见**，而不是悄悄发生。只在 Lambda 里查（单测 / 本地不碰 SSM）。
    """
    global _legacy_checked
    if _legacy_checked or not os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        return
    _legacy_checked = True
    try:
        v = boto3.client("ssm").get_parameter(Name="/notiops/llm/provider")["Parameter"]["Value"]
    except Exception:  # noqa: BLE001 — 只是提示，读不到就算了
        return
    if str(v or "").strip().lower() == "litellm":
        logger.error("SSM /notiops/llm/provider=litellm is no longer honoured: backend LLM calls now "
                     "route by the model catalogue. Configure the gateway under Web Chat > More > "
                     "Admin > Models > Model sources and move it to the top.")
        try:
            print(json.dumps({"_aws": {"Timestamp": int(time.time() * 1000), "CloudWatchMetrics": [{
                "Namespace": "NotiOps/LLMConfig", "Dimensions": [["Surface"]],
                "Metrics": [{"Name": "LegacyProviderParamIgnored", "Unit": "Count"}]}]},
                "Surface": "backend", "LegacyProviderParamIgnored": 1}), flush=True)
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------


def invoke_llm(
    model_id: str,
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 16000,
    kind: str = "",
    region: str = "",
    backend_task: bool = False,
) -> dict:
    """统一 LLM 调用入口，按目录条目的 `kind` 选协议。

    Args:
        model_id: 模型 ID。Bedrock 用推理 profile(如 global.anthropic.claude-opus-4-7);
                  网关用网关里登记的模型名（原样透传，不改写）。
        system_prompt: 系统提示词
        user_prompt: 用户提示词
        max_tokens: 最大输出 token 数
        kind: 模型目录里的 `kind`。`openai_compatible` → OpenAI 兼容网关；
              `bedrock_mantle_responses` → Mantle 的 Responses 协议；其余(含空值)→ Converse。
              **不从 model_id 猜**：靠前缀猜会在目录换代时静默走错端点，而走错端点
              的表现是 `ValidationException: model identifier is invalid`,看起来像
              「模型不存在」,归因成本很高。缺省即 Converse,与历史行为一致。
        region: Mantle 专用。模型只在特定区域上架(如 GPT-5.6 Terra 仅 us-east-1 /
                us-east-2 / us-west-2),故区域是目录数据的一部分。非 Mantle 时忽略。
        backend_task: Admin「后端任务模型」驱动的调用（PHD 翻译 / 报告精简）。为真且网关是第一
                来源时，**拒绝**走 Bedrock：BFF 在网关排第一时把后端任务全部投影成网关模型，此时
                还拿到 Bedrock 模型只可能是投影行读失败后落到了 env / 硬编码兜底 —— 那是静默换来源
                （数据去向、计费主体一起换），用户决策是不许发生。抛 LiteLLMConfigError，调用方走
                自己的非 LLM 降级（PHD 推原始事件）。

    Returns:
        {"content": str, "stop_reason": str, "usage": dict}
        usage 字段名与 Bedrock 一致(inputTokens / outputTokens / totalTokens),
        三条协议分支都已归一到这个形状。

    Raises:
        ClientError: Bedrock 调用失败(限流、模型不可用)
        HTTPError: Mantle 端点返回非 2xx
        LiteLLMConfigError: 网关模型但连接信息不完整 / 地址不合法
        LiteLLMHTTPError: 网关返回非 2xx 或非 JSON

    协议覆盖:
        Converse(bedrock-runtime) / Responses(bedrock-mantle) /
        Chat Completions(网关)。**目录里任何模型,后端任务都能绑** ——
        这一点与对话侧(webchat)是对齐的。改动同时放宽过两处判定:
          · bff/web-chat/llm_config.mjs  validateConfig
          · frontend/chat-app/src/components/AdminPanel.tsx  backendEligible
        再加协议时,这三处要一起动。
    """
    logger.info(
        "invoke_llm model=%s kind=%s region=%s sys_len=%d user_len=%d max_tokens=%d",
        model_id, kind or "converse", region or "-",
        len(system_prompt), len(user_prompt), max_tokens,
    )
    _warn_legacy_provider_param()
    if kind == _GATEWAY_KIND:
        _credential_mode()   # 顺带刷新 gateway_rev：Admin 改了网关就别用缓存的旧连接信息
    elif backend_task:
        _credential_mode()
        if _cached_active_source == "gateway":
            raise LiteLLMConfigError(
                "the OpenAI-compatible gateway is the active model source, but this backend task "
                "resolved to a Bedrock model (its projected config could not be read); refusing to "
                "fall back to Bedrock")
    if kind == _GATEWAY_KIND:
        return _invoke_gateway(model_id, system_prompt, user_prompt, max_tokens)
    if kind == _MANTLE_KIND:
        return _invoke_mantle_responses(
            model_id, system_prompt, user_prompt, max_tokens, region,
        )
    return _invoke_bedrock(model_id, system_prompt, user_prompt, max_tokens)
