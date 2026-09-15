"""阿里云 POP 网关签名 **ACS3-HMAC-SHA256**（V3 签名）—— 纯函数，只用标准库。

`bff/web-chat/aliyun_signer.mjs` 的语义移植。**算法必须逐字节一致**，所以两份实现由
同一组测试向量钉住（Python 侧 `tests/test_aliyun_signer.py`，JS 侧
`bff/web-chat/tests/aliyun_signer.test.mjs`，用的是官方文档那个固定参数向量）。

为什么手写而不是装阿里云官方 SDK：IM worker 是个 Lambda zip，`requirements.txt` 里只有
`boto3` / `powertools` / `defusedxml` 三条（见「依赖必钉版本」），装一棵 darabonba 依赖树
只为了「给一个 ROA 请求算一个 Authorization 头」不划算。这段算法是**公开且固定**的，
官方还给了固定参数测试向量，自己实现 + 用那个向量钉住比多背一棵依赖树更可控。

⚠️ 这个文件是整条阿里云链路唯一「错一个字节就全废、而且报错还会指错方向」的地方：
   签名不对时阿里云回的是 `SignatureDoesNotMatch`，客户第一反应永远是「密钥填错了」，
   于是去重新生成 AccessKey —— 换十次也没用。所以每一条容易错的细节都写在下面，
   并且都有一条断言看着：

 1. **RFC3986 ≠ `urllib.parse.quote` 的默认口径**。默认 `safe="/"` 会**放过斜杠**，
    而斜杠在 query 值里必须编成 `%2F`。所以一律 `quote(v, safe="")`。
    （幸运的是 Python 的 always-safe 集合正好是 `A-Za-z0-9_.-~` —— 与 RFC3986 的
    unreserved 完全相同，且 `quote` 输出大写十六进制。JS 那边要额外处理 `!'()*` 和 `~`，
    Python 不需要；等价性由测试里那条"逐字符对照表"钉住。）
 2. **ROA 的 CanonicalURI 是「已经编码好的 pathname」，原样参与签名，不许再编一次**。
    所以路径参数在**拼接时**编码（`roa_path()`），拼完的字符串既拿去发请求、也拿去签名。
    再编一次 = `%2F` 变 `%252F` = 签名失败，症状同上（指向"密钥错"）。
 3. **`content-type` 必须进签名头集合**。它不是 `x-acs-*`，最容易被漏掉；带 JSON body
    却不签 content-type，必然 `SignatureDoesNotMatch`。
 4. **`x-acs-content-sha256` 必须等于 body 的 hash，并且它自己也要被签**。
 5. **body 要按发出去的**字节**算 hash**。所以本模块只接受 `str`（发送前 `.encode("utf-8")`）
    —— 调用方 `json.dumps` 一次，同一个字符串既算 hash 又发出去。传 dict 进来会导致
    "签的是一种序列化、发的是另一种"，键顺序一变就挂。
 6. **`x-acs-date` 必须是 `yyyy-MM-ddTHH:mm:ssZ`（UTC、无毫秒）**，且与服务端时钟差
    不得超过 15 分钟。`datetime.isoformat()` 带微秒 —— 必须用 strftime 削掉。
 7. **nonce 每个请求都必须不同**（服务端拿它防重放）。

🔒 日志纪律（docs/LOGGING_STANDARD.md）：本模块**不打任何日志**。`access_key_secret`
   不进日志、不进异常 message、**连长度都不记**。抛出的错误只有固定字符串
   （`aliyun_signer_missing_credentials` 之类），绝不回显任何入参值。
   `canonical_request` / `string_to_sign` 会被返回（单测要逐字节比），但它们只是**给测试用**的
   —— 生产代码路径上不许打印（里面有 AccessKey **ID** 和请求体 hash）。

ARCC 未查询（MCP server 本次会话连不上）—— 按标准做法处理凭据：只读内存、不落盘、不日志。
"""
from __future__ import annotations

import hashlib
import hmac
import re
import uuid
from datetime import datetime, timezone
from urllib.parse import quote

#: 空 body 的 SHA256（十六进制小写）。写成常量是为了让「空 body 也要有 content-sha256」
#: 这件事在代码里显眼 —— 漏了这个头就是签名失败。
EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

#: 只签这三类头（见文件头 ⚠️3）。
_SIGNED_EXACT = ("host", "content-type")
_SIGNED_PREFIX = "x-acs-"


def rfc3986(v) -> str:
    """RFC3986 百分号编码。unreserved = `A-Za-z0-9 - _ . ~`，其余全编（见文件头 ⚠️1）。"""
    return quote("" if v is None else str(v), safe="")


def hex_sha256(payload: str = "") -> str:
    """十六进制小写 SHA256。入参是 `str`（见文件头 ⚠️5）。"""
    return hashlib.sha256(("" if payload is None else str(payload)).encode("utf-8")).hexdigest()


def canonical_query_string(query: dict | None = None) -> str:
    """CanonicalQueryString：按参数名升序，名和值都 RFC3986 编码，`=` 连接、`&` 拼接。

    无查询参数时是**空字符串**（不是 `?`、也不是省略这一行）。

    `None` 的参数**整条丢掉**（"没传这个参数"），而空串 `""` 是**传了但为空** —— 两者
    签名结果不同，所以不能合并处理。
    """
    q = query or {}
    keys = sorted(k for k in q if q[k] is not None)
    return "&".join(f"{rfc3986(k)}={rfc3986(q[k])}" for k in keys)


def canonical_headers(headers: dict | None = None) -> tuple[str, str]:
    """返回 `(canonical, signed)`。

    只签三类头：`x-acs-*`、`host`、`content-type`（见文件头 ⚠️3）。名字小写、值 strip、
    按名升序；canonical 每条后面**都**跟一个 `\\n`，signed 用 `;` 连。
    空值的头丢掉 —— 发不出去的头不能进签名。
    """
    pick: list[tuple[str, str]] = []
    for raw_name, raw_value in (headers or {}).items():
        name = str(raw_name).lower()
        if name == "authorization":
            continue                                    # 签名本身不参与签名
        if not (name.startswith(_SIGNED_PREFIX) or name in _SIGNED_EXACT):
            continue
        value = ("" if raw_value is None else str(raw_value)).strip()
        if not value:
            continue
        pick.append((name, value))
    pick.sort(key=lambda kv: kv[0])
    canonical = "".join(f"{n}:{v}\n" for n, v in pick)
    signed = ";".join(n for n, _ in pick)
    return canonical, signed


def roa_path(template: str, params: dict | None = None) -> str:
    """拼 ROA 风格的 pathname，路径参数在**这里**做 RFC3986 编码 —— 之后原样用于发送与
    签名（见文件头 ⚠️2）。模板里的 `{name}` 用 `params["name"]` 替换。

    ⚠️ 阿里云的路径模板本身**不自洽**（`/digitalEmployee/{name}/thread` 是驼峰，
       `/digital-employee/{name}` 是中划线），所以模板必须逐字从 OpenAPI 元数据抄，
       绝不"顺手统一风格"。

    缺参数直接抛：拼出 `/digitalEmployee/None/thread` 这种路径只会换来一个语义不明的
    404，查起来比当场报错贵得多。
    """
    p = params or {}

    def _sub(m: re.Match) -> str:
        key = m.group(1)
        v = p.get(key)
        if v is None or v == "":
            raise ValueError(f"aliyun_signer_missing_path_param:{key}")
        return rfc3986(v)

    return re.sub(r"\{(\w+)\}", _sub, str(template))


def acs_date(when: datetime | None = None) -> str:
    """`x-acs-date` 的格式：UTC、秒级、无毫秒（见文件头 ⚠️6）。"""
    dt = when or datetime.now(timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def acs_nonce() -> str:
    """每请求唯一的 nonce（见文件头 ⚠️7）。32 位十六进制，与官方示例同形。"""
    return uuid.uuid4().hex


def sign_request(
    *,
    method: str,
    host: str,
    canonical_uri: str = "/",
    query: dict | None = None,
    body: str = "",
    action: str,
    version: str,
    access_key_id: str,
    access_key_secret: str,
    security_token: str = "",
    content_type: str = "",
    extra_headers: dict | None = None,
    date: datetime | None = None,
    nonce: str = "",
) -> dict:
    """给一个 POP 请求算出完整的请求头（含 `Authorization`）。

    返回 `{"headers", "canonical_request", "string_to_sign", "signature"}`。
    后三项只给单测比对用 —— **生产路径不许打印**（见文件头 🔒）。
    """
    # 参数缺失当场抛，且**只报字段名**（绝不回显值 —— 其中一个就是密钥）。
    if not access_key_id or not access_key_secret:
        raise ValueError("aliyun_signer_missing_credentials")
    if not host:
        raise ValueError("aliyun_signer_missing_host")
    if not action or not version:
        raise ValueError("aliyun_signer_missing_action_or_version")
    if body and not isinstance(body, str):
        raise ValueError("aliyun_signer_body_must_be_string")

    m = str(method or "GET").upper()
    payload = body if isinstance(body, str) else ""
    body_hash = hex_sha256(payload) if payload else EMPTY_BODY_SHA256

    headers: dict[str, str] = {
        "host": host,
        "x-acs-action": action,
        "x-acs-version": version,
        "x-acs-date": acs_date(date),
        "x-acs-signature-nonce": nonce or acs_nonce(),
        "x-acs-content-sha256": body_hash,          # ⚠️4：必须与 body hash 一致，且要被签
    }
    if security_token:
        headers["x-acs-security-token"] = security_token
    headers.update(extra_headers or {})
    # 有 body 才有 content-type；没 body 还发 content-type 也不算错，但保持与官方示例一致。
    if payload:
        headers["content-type"] = content_type or "application/json; charset=utf-8"

    canonical, signed = canonical_headers(headers)
    canonical_request = "\n".join([
        m,
        canonical_uri or "/",
        canonical_query_string(query),
        canonical,
        signed,
        body_hash,
    ])

    string_to_sign = f"ACS3-HMAC-SHA256\n{hex_sha256(canonical_request)}"
    signature = hmac.new(
        access_key_secret.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha256
    ).hexdigest()

    # 三段之间**没有空格**（`Credential=…,SignedHeaders=…,Signature=…`），官方示例如此。
    headers["Authorization"] = (
        f"ACS3-HMAC-SHA256 Credential={access_key_id},"
        f"SignedHeaders={signed},Signature={signature}"
    )
    return {
        "headers": headers,
        "canonical_request": canonical_request,
        "string_to_sign": string_to_sign,
        "signature": signature,
    }


def build_url(*, host: str, canonical_uri: str = "/", query: dict | None = None,
              scheme: str = "https") -> str:
    """把 host / path / query 拼成最终 URL。

    query 的编码口径与签名**必须**一致，所以这里复用 `canonical_query_string()` ——
    两处各写一份编码迟早漂移，而漂移的表现又是 `SignatureDoesNotMatch`（指向"密钥错"）。
    """
    qs = canonical_query_string(query)
    return f"{scheme}://{host}{canonical_uri or '/'}" + (f"?{qs}" if qs else "")


__all__ = [
    "EMPTY_BODY_SHA256",
    "acs_date",
    "acs_nonce",
    "build_url",
    "canonical_headers",
    "canonical_query_string",
    "hex_sha256",
    "rfc3986",
    "roa_path",
    "sign_request",
]
