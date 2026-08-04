"""安全 URL 打开助手 —— 防御 B310(urllib 允许 file:// / ftp:// 等非预期 scheme)。

所有出网请求都应经 safe_urlopen(),它在打开前强制校验 scheme 为 http/https。
即便 URL 来自固定常量,也统一走这里,让安全约束显式化、可审计。
"""
from __future__ import annotations
import urllib.request

_ALLOWED_SCHEMES = ("https", "http")


def safe_urlopen(req, *args, **kwargs):
    """urllib.request.urlopen 的安全包装:仅允许 http(s) scheme,否则抛 ValueError。

    req 可以是 urllib.request.Request 或 URL 字符串。"""
    url = req.full_url if isinstance(req, urllib.request.Request) else str(req)
    scheme = url.split("://", 1)[0].lower() if "://" in url else ""
    if scheme not in _ALLOWED_SCHEMES:
        raise ValueError(f"refusing non-http(s) URL scheme: {scheme!r}")
    return urllib.request.urlopen(req, *args, **kwargs)  # nosec B310 - scheme validated above
