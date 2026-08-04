"""
AWS What's New（最新发布）拉取 —— 读官方 RSS feed，结构化 + 过滤。

为什么用 RSS（实测结论）：AWS Knowledge / docs MCP 索引的是**文档指南**，**拿不到**
`/about-aws/whats-new/` 的发布公告（且文档有滞后）。官方 RSS 是唯一实时、结构化、
权威的"最新发布"源：每条带 title / pubDate / link / description / category，
其中 `general:products/<slug>` 是精确的服务标签。

设计：
- **纯函数、零额外依赖**（标准库 urllib + re + email.utils 解析 RFC822 日期），
  既给 agent 工具用，也能被未来的"定期摘要 Lambda"直接 import 复用（不绑 agent 上下文）。
- 过滤：日期窗口（since_days）+ 服务（按 category 的 product slug）+ 关键词（标题/正文）。
- 失败安全：抓取/解析失败 → 返回 {error}，调用方据此回退（如 web_search），不抛。

注意：`recent` feed 只保留最近一批（约数天~两周，取决于发布量）。问"这个月"可能超出
feed 覆盖范围 → 返回里带 `feed_oldest` 让上层知道边界、必要时回退 web_search 补更早的。
"""
from __future__ import annotations
from core.net import safe_urlopen

import logging
import re
import urllib.request
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
# 用 defusedxml 替代标准库 xml.etree,防御 XXE / billion-laughs 等 XML 攻击
# (即便源是 AWS 官方 RSS feed,也按不可信输入处理)。API 与 ElementTree 兼容。
import defusedxml.ElementTree as ET

logger = logging.getLogger(__name__)

_FEED_URL = "https://aws.amazon.com/about-aws/whats-new/recent/feed/"
# 官方 What's New 网站背后的 marketing API（公开、分页、可回溯到任意历史，22K+ 条）。
# 比 RSS recent feed 强：RSS 只存最近一批（约 14 天/100 条），API 能按 postDateTime 倒序翻页
# 拿到**任意时间窗**的完整发布 → 解决"上个月/任意区间"的完整性问题。RSS 仅作兜底。
_API_URL = "https://aws.amazon.com/api/dirs/items/search"
_API_PAGE_SIZE = 100      # API 单页条数（上限 100）
_API_MAX_PAGES = 60       # 翻页安全上限（60×100=6000 条，足够覆盖很宽的窗）
_TIMEOUT = 12
_MAX_ITEMS = 2000         # 单次 fetch 最多保留的条目（完整列表报告用；聊天预览另截断）
_DEFAULT_RETURN = 25      # 默认返回上限（避免塞爆上下文）
_SUMMARY_CHARS = 320      # 每条摘要截断
_UA = "Mozilla/5.0 (compatible; NotiOps/1.0)"


def _strip_html(s: str) -> str:
    """去 HTML 标签 + 常见实体，压成纯文本摘要。"""
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = (s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<")
           .replace("&gt;", ">").replace("&quot;", '"').replace("&#39;", "'"))
    return re.sub(r"\s+", " ", s).strip()


def _service_slugs(category: str) -> list[str]:
    """从 category 抽服务 slug：`general:products/amazon-ec2` → 'amazon-ec2'。"""
    out = []
    for part in (category or "").split(","):
        part = part.strip()
        if part.startswith("general:products/"):
            out.append(part[len("general:products/"):])
    return out


def _service_label(slug: str) -> str:
    """slug → 可读服务名：amazon-ec2 → 'Amazon EC2'；aws-waf → 'AWS WAF'。"""
    words = slug.split("-")
    out = []
    for w in words:
        if w in ("aws",):
            out.append("AWS")
        elif w in ("ec2", "s3", "rds", "waf", "iam", "vpc", "eks", "ecs", "sqs", "sns", "ai", "ml"):
            out.append(w.upper())
        else:
            out.append(w.capitalize())
    return " ".join(out)


def account_services(account_id: str | None = None, top: int = 12) -> list[str]:
    """业务个性化：取账号近 30 天**实际在用、有花费**的服务名（用于"跟你相关的新发布"）。
    boto3 Cost Explorer 直连（轻量、不经 MCP）。失败 → 返回 []（个性化退化为不排序，不阻断）。
    返回服务名列表（按花费降序），如 ["Amazon EC2", "Amazon Bedrock", "Amazon S3", ...]。
    可被未来的"定期摘要 Lambda"复用。"""
    try:
        import boto3
        from datetime import date
        # 跨账号沿用 aws_session（部署账号=本地凭证）；ce 控制面在 us-east-1。
        # 账号隔离(安全):指定了成员账号就**必须**用该账号的凭据;get_session 返回 None
        # (未接入/无 role_arn/被闸门拒)或抛异常 → 返回 [](个性化优雅退化),**绝不回退部署账号
        # 凭据**——否则会把部署账号"在用的服务"串给选成员账号的用户(数据泄露 + 错误个性化)。
        # 与 support_cases/resources 的跨账号安全范式一致。
        if account_id:
            try:
                from core.aws_session import get_session
                sess = get_session(account_id)
            except Exception:  # noqa: BLE001
                return []
            if sess is None:
                return []
        else:
            sess = boto3.Session()  # 无账号 = 部署账号本身,用本地凭证正确
        ce = sess.client("ce", region_name="us-east-1")
        today = date.today()
        start = (today - timedelta(days=30)).isoformat()
        r = ce.get_cost_and_usage(
            TimePeriod={"Start": start, "End": today.isoformat()},
            Granularity="MONTHLY", Metrics=["UnblendedCost"],
            GroupBy=[{"Type": "DIMENSION", "Key": "SERVICE"}])
        agg = {}
        for period in r.get("ResultsByTime", []):
            for g in period.get("Groups", []):
                name = (g.get("Keys") or [""])[0]
                amt = float(g.get("Metrics", {}).get("UnblendedCost", {}).get("Amount", 0) or 0)
                if amt > 0:
                    agg[name] = agg.get(name, 0) + amt
        return [n for n, _ in sorted(agg.items(), key=lambda kv: kv[1], reverse=True)][:top]
    except Exception as e:  # noqa: BLE001
        logger.warning("whats_new account_services failed: %s", e)
        return []


def _parse_iso(s: str):
    """宽松解析 'YYYY-MM-DD'（或带时间）为 UTC datetime；失败返回 None。"""
    s = (s or "").strip()
    if not s:
        return None
    try:
        # 只给日期时按当天 00:00:00 处理；fromisoformat 也接受完整时间戳
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:  # noqa: BLE001
        # 退路：仅取前 10 位日期
        m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
        if m:
            return datetime(int(m[1]), int(m[2]), int(m[3]), tzinfo=timezone.utc)
        return None


def render_markdown(result: dict, title: str = "", lang: str = "zh") -> str:
    """把 fetch() 的结果渲染成**完整 markdown 列表**（确定性、在 Python 里做，
    不靠模型重新生成超长内容）。供"完整列表落 S3 下载"用。

    lang：报告正文语言（"en"/"zh"）。这份 markdown 会写 S3 由客户**逐字下载**，不经模型翻译，
    所以标签必须按提问语言切换——英文客户下载到中文报告就是 bug。由 main.py 传入 _ui_locale。"""
    en = (str(lang).lower() == "en")
    items = result.get("items", []) if isinstance(result, dict) else []
    ws = result.get("window_start", "")
    we = result.get("window_end", "")
    lines = []
    _hdr = title or ("AWS What's New Releases" if en else "AWS What's New 新发布列表")
    lines.append(f"# {_hdr}")
    lines.append("")
    span = f"{ws} ~ {we}" if ws and we else (ws or we or "")
    if en:
        meta = f"- Time window: {span}  |  {len(items)} items"
        if not result.get("window_fully_covered", True):
            meta += "  |  ⚠️ Data source does not cover the full time window; earlier items may be missing"
    else:
        meta = f"- 时间窗：{span}　|　共 {len(items)} 条"
        if not result.get("window_fully_covered", True):
            meta += "　|　⚠️ 数据源未覆盖整个时间窗，较早条目可能不全"
    lines.append(meta)
    if en:
        src = "AWS official What's New API" if result.get("source") == "api" else "AWS official What's New RSS"
        lines.append(f"- Source: {src}")
    else:
        src = "AWS 官方 What's New API" if result.get("source") == "api" else "AWS 官方 What's New RSS"
        lines.append(f"- 来源：{src}")
    lines.append("")
    if en:
        lines.append("| # | Date | Title | Services | Details |")
    else:
        lines.append("| # | 日期 | 标题 | 涉及服务 | 说明 |")
    lines.append("|---|------|------|----------|------|")
    svc_sep = ", " if en else "、"
    for i, it in enumerate(items, 1):
        title_md = f"[{it.get('title','')}]({it.get('link','')})" if it.get("link") else it.get("title", "")
        svc = svc_sep.join(it.get("services", []) or [])
        summ = (it.get("summary", "") or "").replace("|", "／").replace("\n", " ")
        lines.append(f"| {i} | {it.get('date','')} | {title_md} | {svc} | {summ} |")
    lines.append("")
    return "\n".join(lines)


def _resolve_window(since_days: int, start_date: str, end_date: str):
    """统一解析时间窗 → (window_start, window_end, now)。显式日期优先于 since_days。"""
    now = datetime.now(timezone.utc)
    sd = _parse_iso(start_date)
    ed = _parse_iso(end_date)
    if ed is not None and ed.hour == 0 and ed.minute == 0 and ed.second == 0:
        ed = ed + timedelta(hours=23, minutes=59, seconds=59)
    if sd is not None:
        return sd, (ed or now), now
    return now - timedelta(days=max(1, int(since_days))), (ed or now), now


def _make_item(title, link, dt, slugs, summary_raw):
    summary = _strip_html(summary_raw)
    return {
        "title": title,
        "date": dt.date().isoformat() if dt else "",
        "link": link,
        "service_slugs": slugs,
        "services": [_service_label(s) for s in slugs],
        "summary": summary[:_SUMMARY_CHARS] + ("…" if len(summary) > _SUMMARY_CHARS else ""),
    }


def _fetch_api(window_start, window_end, svc, kw, limit) -> list | None:
    """用官方 marketing API（分页、可回溯任意历史）拉窗口内全部发布。
    返回 items 列表（已按窗口/服务/关键词过滤、按日期倒序）；失败返回 None（让上层回退 RSS）。"""
    import json as _json
    items = []
    cap = max(_DEFAULT_RETURN, min(limit, _MAX_ITEMS))
    for page in range(_API_MAX_PAGES):
        url = (f"{_API_URL}?item.directoryId=whats-new-v2"
               f"&sort_by=item.additionalFields.postDateTime&sort_order=desc"
               f"&size={_API_PAGE_SIZE}&item.locale=en_US&page={page}")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": _UA})
            with safe_urlopen(req, timeout=_TIMEOUT) as resp:
                data = _json.loads(resp.read())
        except Exception as e:  # noqa: BLE001
            logger.warning("whats_new API page %d failed: %s", page, e)
            return None if page == 0 else items  # 第一页就失败 → 整体回退 RSS
        entries = data.get("items", [])
        if not entries:
            break
        page_oldest = None
        for e in entries:
            af = e.get("item", {}).get("additionalFields", {})
            pub = af.get("postDateTime", "")
            dt = _parse_iso(pub[:10]) if pub else None
            if dt is not None:
                page_oldest = dt if page_oldest is None or dt < page_oldest else page_oldest
                if dt > window_end:
                    continue            # 比窗口新（倒序里靠前）→ 跳过，继续往后
                if dt < window_start:
                    continue            # 比窗口旧 → 本条不要（但可能还有同页更新的，故不 break）
            # 服务 slug 来自 tags 的 general:products/*
            slugs = []
            for tg in e.get("tags", []) or []:
                desc = (tg.get("description") or "")
                if desc.startswith("general:products/"):
                    slugs.append(desc[len("general:products/"):])
            if svc:
                joined = " ".join(slugs).lower()
                if svc not in joined and not any(svc in _service_label(s).lower() for s in slugs):
                    continue
            title = (af.get("headline") or "").strip()
            link = af.get("headlineUrl") or ""
            if link.startswith("/"):
                link = "https://aws.amazon.com" + link
            summary_raw = af.get("postBody") or ""
            if kw and kw not in title.lower() and kw not in _strip_html(summary_raw).lower():
                continue
            items.append(_make_item(title, link, dt, slugs, summary_raw))
            if len(items) >= cap:
                return items
        # 整页都比窗口起点更旧 → 后面的页只会更旧，停止翻页
        if page_oldest is not None and page_oldest < window_start:
            break
    return items


def _fetch_rss(window_start, window_end, svc, kw, limit):
    """RSS 兜底（API 不可用时）。只覆盖最近一批（约 14 天）。返回 (items, feed_oldest)。"""
    req = urllib.request.Request(_FEED_URL, headers={"User-Agent": _UA})
    with safe_urlopen(req, timeout=_TIMEOUT) as resp:
        raw = resp.read()
    root = ET.fromstring(raw)
    items, feed_oldest = [], None
    for it in root.iter("item"):
        if len(items) >= limit:
            break
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        cat = it.findtext("category") or ""
        desc_raw = it.findtext("description") or ""
        pub = it.findtext("pubDate") or ""
        try:
            dt = parsedate_to_datetime(pub)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
        except Exception:  # noqa: BLE001
            dt = None
        if dt is not None and (feed_oldest is None or dt < feed_oldest):
            feed_oldest = dt
        if dt is not None and (dt < window_start or dt > window_end):
            continue
        slugs = _service_slugs(cat)
        if svc:
            joined = " ".join(slugs).lower()
            if svc not in joined and not any(svc in _service_label(s).lower() for s in slugs):
                continue
        if kw and kw not in title.lower() and kw not in _strip_html(desc_raw).lower():
            continue
        items.append(_make_item(title, link, dt, slugs, desc_raw))
    return items, feed_oldest


def fetch(since_days: int = 3, service: str = "", keyword: str = "",
          limit: int = _DEFAULT_RETURN,
          start_date: str = "", end_date: str = "") -> dict:
    """拉 AWS What's New，按日期窗口 + 服务 + 关键词过滤。**纯函数，可被 Lambda 复用。**

    数据源：**优先官方 marketing API**（分页、可回溯任意历史 22K+ 条 → "上个月/任意区间"
    都能拿全），失败时回退 RSS recent feed（只覆盖最近约 14 天）。

    时间窗（互斥，显式日期优先）：
      1. **显式区间** `start_date`/`end_date`（ISO `YYYY-MM-DD`，含两端）——任意区间，
         如"上个月"(2026-05-01~2026-05-31)、"当月"(2026-06-01~今天)。只给 start → end=现在。
      2. **回看天数** `since_days`（默认 3）——等价 [现在-N天, 现在]。仅在未给 start_date 时生效。

    Returns:
        {ok, count, since_days, source("api"|"rss"), window_start, window_end,
         feed_oldest, window_fully_covered, items:[{title,date,link,services,service_slugs,summary}]}
        失败: {error, message}
    """
    window_start, window_end, now = _resolve_window(since_days, start_date, end_date)
    svc = (service or "").strip().lower().replace(" ", "-")
    kw = (keyword or "").strip().lower()
    eff_limit = max(_DEFAULT_RETURN, min(int(limit), _MAX_ITEMS))

    # 1) 优先 marketing API（完整、可回溯）
    api_items = None
    try:
        api_items = _fetch_api(window_start, window_end, svc, kw, eff_limit)
    except Exception as e:  # noqa: BLE001
        logger.warning("whats_new API fetch error: %s", e)
        api_items = None
    if api_items is not None:
        return {
            "ok": True, "count": len(api_items), "since_days": int(since_days),
            "source": "api",
            "window_start": window_start.date().isoformat(),
            "window_end": window_end.date().isoformat(),
            "feed_oldest": None,
            "window_fully_covered": True,   # API 可回溯任意历史 → 视为完整覆盖
            "items": api_items,
        }

    # 2) 回退 RSS（只最近一批）
    try:
        rss_items, feed_oldest = _fetch_rss(window_start, window_end, svc, kw, eff_limit)
    except Exception as e:  # noqa: BLE001
        logger.warning("whats_new RSS fallback failed: %s", e)
        return {"error": "fetch_failed",
                "message": f"无法获取 AWS What's New（API+RSS 均失败）：{e}。可改用联网搜索。"}
    return {
        "ok": True, "count": len(rss_items), "since_days": int(since_days),
        "source": "rss",
        "window_start": window_start.date().isoformat(),
        "window_end": window_end.date().isoformat(),
        "feed_oldest": feed_oldest.date().isoformat() if feed_oldest else None,
        "window_fully_covered": bool(feed_oldest and feed_oldest <= window_start),
        "items": rss_items,
    }
