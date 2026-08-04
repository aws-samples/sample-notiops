"""
长报告落 S3 + presigned 下载链接（web-chat agent 用）。

为什么需要：像"完整新发布列表/摘要"这类输出，条目可能很多——全塞进聊天既看不全、又爆
上下文。方案（对齐 IM 端调查报告的 S3+presign 模式）：**完整报告写 S3（markdown），聊天里
只展示节选，最后给一条 presigned 下载链接**。

设计：
- 纯 boto3，零额外依赖；写共享数据桶（SKILLS_BUCKET=notiops-data-<acct>-<region>）的
  `reports/` 前缀。runtime 角色已被授予 reports/* 的 PutObject+GetObject（见 agentcore CDK）。
- presign 默认 7 天（与 IM 端调查报告一致）。
- 失败安全：任何错误返回 {ok:false, error}，调用方据此回退（如只在聊天里给节选），不抛。
- key 用 `reports/<prefix>/<date>-<rand>.md`；rand 用进程内计数器（runtime 单进程，足够唯一），
  不依赖 Math.random/Date.now 之外的东西——这里在 Python，可用 uuid。
"""
from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def _env(name: str, default: str = "") -> str:
    """读 env，并把**未被部署脚本替换的占位符**（形如 __FOO__）当成未设置。

    agentcore.json 里这些值出厂是占位符（__SKILLS_BUCKET__ 等），由 deploy_agent.sh
    在部署时注入真值。若某次部署漏注入（如绕过脚本手动 redeploy），env 会是字面
    占位符——非空字符串会骗过 `if not _BUCKET` 的空值保护，让代码拿着假桶名去调 S3，
    报错 NoSuchBucket（"存储桶不存在"）。这里统一归一化为空串，使功能优雅降级为
    "未配置"（明确提示 + 不写 S3），而非撞一个不存在的桶。与 devops_agent.py 一致。
    """
    v = os.environ.get(name, default).strip()
    if v.startswith("__") and v.endswith("__"):
        return ""
    return v


_BUCKET = _env("SKILLS_BUCKET")   # 与 skills 复用同一共享数据桶
_PREFIX = "reports"
# 报告分发 CDN 域名（CloudFront+OAC，只暴露 reports/*；NotiOpsBackendStack 的 ReportsCdnDomain 输出，
# 由 deploy_agent.sh 注入）。**设了它 → 报告链接走 CDN，真·长期有效、任地点打开**（不受临时凭证限制）；
# 空 → 回退 presigned（受 runtime 临时凭证寿命限制，见下）。
_CDN_DOMAIN = _env("REPORTS_CDN_DOMAIN")
# presign 兜底有效期（仅在无 CDN 时用）。⚠️ runtime 用**临时角色凭证**签名，实际有效期被凭证
# 寿命截断（角色 MaxSessionDuration=12h），故设 12h 与之对齐、避免"7天"误导。env 可调。
_PRESIGN_EXPIRY = int(os.environ.get("REPORT_PRESIGN_EXPIRY", str(12 * 3600)))
_s3 = None


def _report_url(key: str, ttl: int):
    """报告访问 URL：有 CDN 域名 → CloudFront URL（配合 reports/ 的 7 天生命周期，返回 168h）；
    否则 → S3 presigned 兜底（受临时凭证寿命限制，12h）。返回 (url, expires_hours)。"""
    if _CDN_DOMAIN:
        base = _CDN_DOMAIN if _CDN_DOMAIN.startswith("http") else f"https://{_CDN_DOMAIN}"
        return f"{base.rstrip('/')}/{key}", 168  # 7 天（对象生命周期到期即失效）
    url = _client().generate_presigned_url(
        "get_object", Params={"Bucket": _BUCKET, "Key": key}, ExpiresIn=ttl)
    return url, ttl // 3600


def configured() -> bool:
    return bool(_BUCKET)


def _client():
    global _s3
    if _s3 is None:
        import boto3
        _s3 = boto3.client("s3")
    return _s3


def _slug(s: str) -> str:
    """把标题压成安全的 key 片段（小写、连字符、去特殊字符）。"""
    import re
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9一-鿿]+", "-", s)
    return s.strip("-")[:48] or "report"


def save_report(content: str, title: str = "", kind: str = "general",
                fmt: str = "md") -> dict:
    """把完整报告（markdown 文本）写 S3，返回 presigned 下载链接。

    Args:
        content: 报告全文（markdown）。
        title:   报告标题（用于 key 片段 + 下载文件名，可选）。
        kind:    报告类型前缀（如 "whats-new"/"cost"，归类用，可选）。
        fmt:     扩展名/格式，默认 "md"。

    Returns:
        成功: {ok:true, url, key, bytes, expires_days}
        失败: {ok:false, error, message}
    """
    if not _BUCKET:
        return {"ok": False, "error": "not_configured",
                "message": "未配置报告存储桶（SKILLS_BUCKET），无法生成下载链接。"}
    if not content or not content.strip():
        return {"ok": False, "error": "empty", "message": "报告内容为空，未写入。"}
    try:
        today = datetime.now(timezone.utc).date().isoformat()
        rand = uuid.uuid4().hex[:8]
        slug = _slug(title)
        kind_seg = _slug(kind) or "general"
        key = f"{_PREFIX}/{kind_seg}/{today}-{slug}-{rand}.{fmt}"
        ctype = "text/markdown; charset=utf-8" if fmt == "md" else "text/plain; charset=utf-8"
        body = content.encode("utf-8", errors="replace")
        # 下载文件名：ASCII 安全名走 filename=，非 ASCII（如中文标题）走 RFC 5987
        # filename*=UTF-8''<pct-encoded>，避免浏览器/HTTP 头里出现乱码。
        import urllib.parse as _up
        ascii_name = f"{kind_seg}-{today}.{fmt}"
        utf8_name = f"{slug or kind_seg}-{today}.{fmt}"
        disp = (f"attachment; filename=\"{ascii_name}\"; "
                f"filename*=UTF-8''{_up.quote(utf8_name)}")
        _client().put_object(
            Bucket=_BUCKET, Key=key, Body=body, ContentType=ctype,
            ContentDisposition=disp,
        )
        url, hrs = _report_url(key, _PRESIGN_EXPIRY)
        return {"ok": True, "url": url, "key": key, "bytes": len(body),
                "expires_hours": hrs,   # None = CDN 长期有效；数字 = presigned 小时数
                "via_cdn": bool(_CDN_DOMAIN)}
    except Exception as e:  # noqa: BLE001
        logger.warning("save_report failed: %s", e)
        return {"ok": False, "error": "save_failed",
                "message": f"写报告到 S3 失败：{e}。可改为只在对话里给节选。"}


def save_html_report(content_md: str, title: str = "", kind: str = "general",
                     subtitle: str = "", meta: dict | None = None,
                     status: str = "", priority: str = "") -> dict:
    """把报告渲染成**自包含 HTML 网页**写 S3，返回 presigned **网页链接**（`text/html` +
    `inline` → 任何地方点开即在浏览器里看，不是下载）。样式与 IM 端调查报告一致。

    Args:
        content_md: 报告正文（markdown；HTML 里客户端 JS 渲染表格/列表/代码/TOC）。
        title/kind/subtitle/meta/status/priority: 见 report_html.render_report。
    Returns: 成功 {ok, url, key, bytes, expires_days, fmt:"html"}；失败 {ok:false,...}。
    """
    if not _BUCKET:
        return {"ok": False, "error": "not_configured",
                "message": "未配置报告存储桶（SKILLS_BUCKET），无法生成网页报告。"}
    if not content_md or not content_md.strip():
        return {"ok": False, "error": "empty", "message": "报告内容为空，未写入。"}
    try:
        from core import report_html as _rh
        html = _rh.render_report(content_md, title=title or "NotiOps Report",
                                 subtitle=subtitle, meta=meta, status=status, priority=priority)
        today = datetime.now(timezone.utc).date().isoformat()
        rand = uuid.uuid4().hex[:8]
        slug = _slug(title)
        kind_seg = _slug(kind) or "general"
        key = f"{_PREFIX}/{kind_seg}/{today}-{slug}-{rand}.html"
        body = html.encode("utf-8", errors="replace")
        # inline → 浏览器直接渲染成网页（而非下载）。与 IM 端一致。
        _client().put_object(
            Bucket=_BUCKET, Key=key, Body=body,
            ContentType="text/html; charset=utf-8", ContentDisposition="inline",
        )
        url, hrs = _report_url(key, _PRESIGN_EXPIRY)
        return {"ok": True, "url": url, "key": key, "bytes": len(body),
                "expires_hours": hrs,   # None = CDN 长期有效
                "via_cdn": bool(_CDN_DOMAIN), "fmt": "html"}
    except Exception as e:  # noqa: BLE001
        logger.warning("save_html_report failed: %s", e)
        return {"ok": False, "error": "save_failed",
                "message": f"生成网页报告失败：{e}。可改为只在对话里给节选。"}
