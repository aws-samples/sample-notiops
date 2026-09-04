"""IM 端长回答的落地策略 —— 卡片装不下的部分**必须有下文**。

── 修的是什么（2026-09-02 线上）─────────────────────────────────────────────────
两个渲染层各有一个正文上限：飞书 `im_cards.MAX_BODY = 3500`（超了整张卡不显示），
Slack `im_blocks.MAX_BODY = 2900`（超了是**整条消息 400**，不是截断显示）。M1/M3 的写法
是裸切片 `reply[:MAX_BODY]` —— 于是一个「列出所有 S3 桶及其大小」这类回答会在第 3500 个
字符处**无声无息**地断掉：没有提示、没有下文，客户以为 agent 只答了这么多。
这是典型的静默降级（见 `docs/LOGGING_STANDARD.md` 之外的那条铁律：不许静默降级）。

── 两层处理，别混 ──────────────────────────────────────────────────────────────
 1. `fit()` —— **答案**路径（`caps.chat` 的终版）。超限时把全文落成一份自包含 HTML
    网页报告（`core.reports.save_html_report`，`reports/` 前缀，链接走 ReportsCDN），
    卡片里只放开头 + 一条**说清楚发生了什么**的提示 + 报告链接。
 2. `clip()` —— 其余所有渲染位（过程行、调查进度卡正文、一句话卡）的**兜底**。
    这些位置的内容本身是过程噪音、天天在变，为它们每隔几秒写一次 S3 是纯浪费；
    但它们同样不许"看不出被切了"，所以至少留一个可见的省略标记。

── 为什么 `fit()` 必须在**调用点**、不能塞进渲染函数里 ──────────────────────────
`answer_card` / `answer_blocks` 会被 `LiveCard.flush` **反复**调用（节流后仍是每几秒
一次），`lambda_progress` 也一样。把上传塞进渲染函数 = 一次问答往 S3 写几十个对象。
所以：渲染函数只认一个已经算好的 `report_url`，S3 那一下由 `caps.chat` 在拿到终版正文
时做**一次**。
"""
from __future__ import annotations

import logging

from core import i18n

logger = logging.getLogger(__name__)


def _cut(s: str, budget: int) -> str:
    """在 `budget` 字符内切，尽量落在换行边界上。

    为什么找换行：agent 的回答里大量是 markdown 表格/列表，切在一行中间会渲染成一段
    破碎的表格（飞书会把残缺的 `|` 原样显示）。只有当最后一个换行不至于砍掉过多内容
    （这里取 60%）时才用它，否则宁可硬切 —— 一段没有换行的长文本不该被砍成一句话。
    """
    head = s[:budget]
    nl = head.rfind("\n")
    if nl >= budget * 0.6:
        return head[:nl].rstrip()
    return head.rstrip()


def clip(text: str, limit: int, locale: str) -> str:
    """按 `limit` 截断，**并且在截掉时留下可见痕迹**（裸切片的替代品）。

    返回值长度保证 ``<= limit``（提示语本身也算在预算里）—— 调用方的上限是平台硬限制，
    多一个字符的代价是整张卡/整条消息发不出去。
    """
    s = text or ""
    if len(s) <= limit:
        return s
    marker = "\n\n" + i18n.t("im.chat.clipped_marker", locale)
    return _cut(s, max(1, limit - len(marker))) + marker


def fit(reply: str, locale: str, *, limit: int, question: str = "",
        kind: str = "im-answer") -> tuple[str, str]:
    """终版答案 → `(放得进卡片的正文, 完整报告链接)`。

    没超限：原样返回，第二个值是空串（**不碰 S3** —— 绝大多数回答走这条路）。
    超限：全文落 HTML 报告，正文 = 开头 + 一条说明这里被截了 + 报告链接。
    报告写失败也照样给提示（说明失败原因），只是没有链接 —— 不许静默截断。

    `limit` 由调用方给（飞书 3500 / Slack 2900），本模块不认识平台。前提是 `limit`
    比提示语本身宽裕（现实里差一个数量级）；真要传个几十的 `limit`，这里会**优先保住
    提示语和链接**而不是保住长度 —— 截掉的链接比超长的正文更没救（渲染层还会再 clip
    一次兜底）。
    """
    s = (reply or "").strip()
    if len(s) <= limit:
        return s, ""

    total = len(s)
    saved = _save_report(s, locale, question=question, kind=kind)
    url = str(saved.get("url") or "")
    if url:
        notice = i18n.t("im.chat.truncated_report", locale, total=total,
                        hours=saved.get("expires_hours") or 12, url=url)
    else:
        # 失败原因进提示：客户看到「报告生成失败」时，运维要能从同一句话里知道是
        # 没配桶（not_configured）还是写挂了（save_failed）。
        notice = i18n.t("im.chat.truncated_nolink", locale, total=total,
                        reason=str(saved.get("error") or "save_failed"))
    tail = "\n\n" + notice
    return _cut(s, max(1, limit - len(tail))) + tail, url


def _save_report(content_md: str, locale: str, *, question: str,
                 kind: str) -> dict:
    """把全文写成网页报告。**永不抛** —— 落报告失败不能连答案一起吃掉。

    `core.reports` 在这里**懒导入**：ingress 那个函数根本走不到这条路，而它的冷启动
    时间是有 10 秒硬上限的（见 `infra/lib/constructs/im-core.ts` 里的实测记录）。
    """
    try:
        from core import reports
        # 标题用用户原问题：报告页 header 和 S3 key 的 slug 都取它，事后在桶里翻得回来。
        return reports.save_html_report(
            content_md, title=(question or "").strip()[:80], kind=kind,
            subtitle=i18n.t("im.chat.card_title", locale))
    except Exception as e:                         # noqa: BLE001
        logger.warning("long_answer: save_html_report crashed: %s", type(e).__name__)
        return {"ok": False, "error": type(e).__name__}
