"""报告卡底下那句「链接多久有效」—— 按链接**形状**判，不按配置猜。

两种链接(2026-10-13 起):
- ReportsCDN(CloudFront + OAC,只放行 `reports/*`)的不签名链接:对象落在 `reports/`
  前缀,桶上的 `expire-reports-7d` 生命周期 7 天后删 ⇒ 约 7 天有效。
- presigned S3 URL:回调 Lambda 用执行角色的**临时凭证**签名,凭证一过期链接就
  `ExpiredToken`,最长约 12 小时 —— `ExpiresIn` 写多长都没用(2026-10-13 现网实测:
  一次飞书调查签发 71.7 小时后,报告与 trace 两条都已打不开,S3 对象还在)。

那句说明必须对卡片上**每一条**报告链接都成立,所以只要有一条是 presigned(比如 CDN
副本写失败后退回了签名链接),就写短的那句。
"""
from __future__ import annotations

import re

_SIGNED_QUERY_RE = re.compile(r"[?&](?:X-Amz-Signature|Signature)=", re.IGNORECASE)


def is_presigned(url: str) -> bool:
    """URL 带签名参数(SigV4 的 `X-Amz-Signature` / SigV2 的 `Signature`)⇒ presigned。"""
    return bool(url) and bool(_SIGNED_QUERY_RE.search(url))


def validity_key(*urls: str) -> str:
    """卡片上的报告 / trace 链接 → `report.link_validity*` 的 i18n key。空链接不算。"""
    live = [u for u in urls if u]
    if live and not any(is_presigned(u) for u in live):
        return "report.link_validity_cdn"
    return "report.link_validity"
