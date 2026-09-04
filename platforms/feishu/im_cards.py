"""飞书卡片渲染（IM 重构 / M1）—— webhook 路径上**所有**卡片都从这里出。

为什么单独一个模块：`caps.py`（发卡）与 `lambda_progress.py`（PATCH 同一张卡）必须用
**同一个**渲染函数，否则进度轮询一 PATCH 就把按钮抹掉了 —— 这类"两处各写一遍卡片"的
漂移是 IM 侧历史上最容易复发的 bug。

schema 选择：一律用**经典（v1）**卡片。
  · 我们自己发、自己 PATCH，不走 `card.action.trigger` 的 inline 回复，所以不受
    `platforms/feishu/app/main.py` 里那条「v1 回复卡不能替换 v2 消息（err 200830）」限制；
  · v1 的按钮回调把 `value` 原样投回来，`main.on_card_action` 的分流口径就是
    `action.value["action"]`，两边天然一致。

⚠️ 2026-09-03 起这里**只剩外链按钮**（打开控制台 / 查看完整报告），一个回调按钮都不发
了 —— 理由见 `answer_card` / `dispatch_card` 的说明。所以本模块也不再需要"把用户原话
截短塞进按钮 value"那套（飞书对回调 payload 有大小上限，那曾是线上 400 的常见来源）。
真要加回**回调**按钮时，记得连同这条限制一起加回来。
"""
from __future__ import annotations

from core import i18n
from core.feishu_card import card_config
from platforms.common import im_markdown, live_card, long_answer

# 卡片正文渲染上限（飞书对单个 markdown 元素有长度限制，超了整张卡不显示）。
# ⚠️ 截断一律走 `long_answer.clip()`，**不要**写裸切片 `text[:MAX_BODY]` —— 那样切完
# 用户看不出被切了（2026-09-02 线上反馈）。答案路径还要额外落报告，见 `caps.chat`。
MAX_BODY = 3500


def _md(text: str, locale: str) -> dict:
    """一个 markdown 元素。**所有**正文都必须从这里出，两件事一次做对：

     1. `im_markdown.to_feishu()` —— 飞书那个 markdown 元素只认 markdown 的子集，
        `## 标题` / GFM 表格 / 段落内软换行都不渲染（2026-09-03 线上截图）。
     2. `long_answer.clip()` —— 平台硬上限，超了整张卡不显示。
    顺序**不能反**：降级会改变长度，先 clip 再降级就可能又超限。
    """
    return {"tag": "markdown",
            "content": long_answer.clip(im_markdown.to_feishu(text),
                                        MAX_BODY, locale)}


def _url_btn(text: str, url: str) -> dict:
    """外链按钮 —— 不产生回调，点开直接进 Operator App。"""
    return {
        "tag": "button",
        "text": {"tag": "plain_text", "content": text},
        "type": "primary",
        "multi_url": {"url": url, "pc_url": url,
                      "android_url": url, "ios_url": url},
    }


#: `answer_card` 的非终态标题（终态回落到 `im.chat.card_title`）。**与 Slack 那份
#: `im_blocks._ANSWER_TITLES` 逐字对齐** —— 两边漂移是 IM 侧最容易复发的一类 bug。
_ANSWER_TITLES = {
    "queued": "im.chat.queued_title",
    "thinking": "im.chat.thinking_title",
}


def answer_card(reply: str, locale: str, *,
                steps=None, state: str = "final", elapsed: int = 0,
                report_url: str = "") -> dict:
    """DevOps Agent 直连问答的答案卡 —— 「思考中」与「答完」**共用**这一张。

    `state` 三态（`platforms/common/live_card.py` 每隔几秒 PATCH 一次时给）：
      · ``"queued"`` —— 还没轮到（同一个会话前一个问题在跑，见 `chat_lease.py`），
        标题是「排队中 · 已等 N 秒」；
      · ``"thinking"`` —— 在跑，标题是「思考中 · 已用时 N 秒」，让用户一眼看出**还在
        跑**、不是卡死；
      · ``"final"`` —— 终版，标题回到「DevOps Agent 回答」，这时才挂按钮。
    **只有终版挂按钮**：PATCH 很频繁，按钮跟着重绘会闪。判据是 `state == "final"`，
    不是"不是 thinking" —— 后者会让 `"queued"` 态悄悄长出按钮。
    `steps` 是最近若干条过程行（`Sink.step`），渲染口径与 Slack 共用
    `live_card.steps_md`。

    ⚠️ 2026-09-03 产品决策：**答案卡不再默认挂「升级成深度调查」/「开案例」两个按钮**。
    原设计（§8.1.1「双向兜底」）是怕答不上来时用户无路可走，实际用下来是**每一条**回答
    底下都顶着两个跟当前问题无关的按钮，噪音大于价值 —— 绝大多数回答是答对了的。
    两条出路一条没少，只是改成按需触发：直接说「深入查一下」/「开个案例」，或
    `/investigate`、`/case`（`core/nl_router.py` 的确定性路由，同样 0 token）。
    `im_escalate_investigate` / `im_open_case` 两个回调 handler **保留**
    （`lambda_worker._handle_im_action`）—— 历史消息里已经发出去的卡还带着这些按钮，
    删了 handler 等于让用户点了没反应。

    `report_url`：正文超了 `MAX_BODY` 时由 `caps.chat` 通过 `long_answer.fit()` 算出来
    的完整报告链接，这里只负责多挂一个外链按钮 —— 现在也是这张卡上**唯一**的按钮。
    **渲染函数自己不上传** —— 它每几秒就被 `LiveCard.flush` 调一次（见 long_answer.py
    文件头）。链接本身也已经在正文的截断提示里，按钮只是让它好点。
    """
    final = state == "final"
    elements: list[dict] = [_md(reply, locale)]
    md = live_card.steps_md(steps, locale)
    if md:
        elements.append({"tag": "hr"})
        elements.append(_md(md, locale))
    elements.append({"tag": "hr"})
    elements.append({"tag": "markdown",
                     "content": i18n.t("router.direct_no_token", locale)})
    actions: list[dict] = []
    if report_url and final:
        actions.append(_url_btn(i18n.t("report.see_full", locale), report_url))
    if actions:
        elements.append({"tag": "action", "actions": actions})
    title_key = _ANSWER_TITLES.get(state, "im.chat.card_title")
    return {
        "config": card_config(wide_screen_mode=True),
        "header": {"template": "blue",
                   "title": {"tag": "plain_text",
                             "content": i18n.t(title_key, locale,
                                               seconds=elapsed)}},
        "elements": elements,
    }


#: `dispatch_card` 的 4 个状态 → (header 颜色, 标题 i18n key)
_DISPATCH_STATES = {
    "dispatched": ("blue", "im.investigate.card_title"),
    "running": ("blue", "progress.investigating"),
    "done": ("green", "progress.completed"),
    "failed": ("red", "progress.failed"),
}


def dispatch_card(body: str, locale: str, *, deep_link: str = "",
                  home: str = "", state: str = "dispatched",
                  elapsed: int = 0) -> dict:
    """深度调查卡 —— 「已发起」与后续每一次进度 PATCH **共用**这一张。

    `state` 只改 header 颜色/标题；正文 `body` 由调用方拼（发起时是一句 ack，
    进度轮询时是累积的 journal 行）。`elapsed` 只在 running/done/failed 的标题里用。

    ⚠️ 2026-09-03 产品决策：这张卡上只留「打开控制台」一个外链按钮。去掉的两个：
      · 「只要一个答案就行」（`im_just_answer`，dispatched/running 态）—— 用户既然
        已经明确要求深度调查，再劝他退回快速问答是把 UI 变成一个反悔按钮；
      · 「开案例」（`im_open_case`，done/failed 态）—— 与答案卡同一个理由（见
        `answer_card` 的说明）：需要时直接说「开个案例」或 `/case` 就行。
    两个回调 handler 仍保留，历史卡片上的按钮点了要有反应。
    """
    color, title_key = _DISPATCH_STATES.get(state, _DISPATCH_STATES["dispatched"])
    # `im.investigate.card_title` 没有 {seconds} 占位符，多传一个 kwarg 是无害的。
    title = i18n.t(title_key, locale, seconds=elapsed)
    elements: list[dict] = [
        _md(body, locale),
        {"tag": "markdown", "content": i18n.t("router.direct_no_token", locale)},
    ]
    actions: list[dict] = []
    link = deep_link or home
    if link:
        label = ("progress.btn.open_link" if deep_link else "progress.btn.open_home")
        actions.append(_url_btn(i18n.t(label, locale), link))
    if actions:
        elements.append({"tag": "action", "actions": actions})
    return {
        "config": card_config(wide_screen_mode=True),
        "header": {"template": color,
                   "title": {"tag": "plain_text", "content": title}},
        "elements": elements,
    }


def text_card(text: str, locale: str, *, color: str = "grey",
              title_key: str = "im.chat.card_title") -> dict:
    """一句话卡片（错误 / 提示用）。"""
    return {
        "config": card_config(wide_screen_mode=True),
        "header": {"template": color,
                   "title": {"tag": "plain_text",
                             "content": i18n.t(title_key, locale)}},
        "elements": [_md(text, locale)],
    }


def message_id_of(api_response: dict) -> str:
    """从 `feishu_utils.send_card` 的返回里取新消息的 message_id。

    拿不到就返回空串 —— 调用方据此决定"这张卡后续能不能 PATCH"。**不要**在拿不到时
    退回用户消息的 message_id：那会让进度轮询去 PATCH 用户自己发的那条消息（必失败）。
    """
    try:
        return str(((api_response or {}).get("data") or {}).get("message_id") or "")
    except AttributeError:
        return ""
