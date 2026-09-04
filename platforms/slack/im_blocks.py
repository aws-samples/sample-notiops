"""Slack Block Kit 渲染（IM 重构 / M3）—— webhook 路径上**所有**消息都从这里出。

`platforms/feishu/im_cards.py` 的 Slack 对位实现，一一对应：

    im_cards.answer_card    → answer_blocks
    im_cards.dispatch_card  → dispatch_blocks
    im_cards.text_card      → text_blocks
    im_cards.message_id_of  → ts_of

存在的理由跟飞书那边一样：`caps.py`（首次发送）与 `lambda_progress.py`（后续
`chat.update` 同一条消息）必须用**同一个**渲染函数，否则一次进度更新就把按钮抹掉了。

── 为什么不直接复用 `platforms/slack/app/progress_sender.py::_build_blocks` ──────
那份是给**旧路径**（Fargate 里 `core.progress_poller` 的常驻线程 + `IR` 对象）写的，
入参是 `ir.summary_md / recent_tools / latest_thinking` 这些 IR 字段。webhook 路径的
进度轮询走 `core.devops_agent.poll_investigation()`，手里只有一段累积好的 journal
正文（跟飞书完全一致）。硬套 IR 形状等于给 poll 结果再造一个假 IR —— 那才是漂移源。
M2 删掉 Fargate 时 `progress_sender.py` 一起删。

── Slack 与飞书的三处硬差异（照抄飞书会踩）─────────────────────────────────────
 1. **没有"卡片"这个东西**：飞书 PATCH 的是一整张 card，Slack 改的是一条消息的
    `blocks`。所以这里返回的是 `list[dict]` 而不是 dict，且每次发送都必须同时给
    `text=`（fallback 文本，通知栏/无障碍读它；不给 Slack 会告警）。
 2. **section 文本上限 3000 字符**（不是飞书那 markdown 元素的宽松限制），
    header 是 150、按钮文字 75、按钮 value 2000 —— 都在 `app/blocks.py` 里截了。
    这里再按 `MAX_BODY` 截一次正文，因为超限是**整条消息 400**，不是截断显示。
 3. **按钮 value 只能是字符串**（飞书是任意 JSON 对象）。所以 `{"action":..,"q":..}`
    要 `json.dumps` 进 value，worker 侧再 loads 回来。action 名走 `action_id`，
    与飞书"分流键在 value['action'] 里"的口径不同 —— 这是 Slack 的原生形状。
"""
from __future__ import annotations

from core import i18n
from platforms.common import im_markdown, live_card, long_answer
from platforms.slack.app import blocks

# 正文渲染上限。Slack 单个 section 的 mrkdwn 上限是 3000 字符（超了整条消息 400），
# 留 100 余量给我们自己拼的标题/前缀。
# ⚠️ 截断一律走 `long_answer.clip()`，**不要**写裸切片 —— 与飞书同口径（见那边注释）。
MAX_BODY = 2900


def _sec(text: str, locale: str) -> dict:
    """一个正文 section。**所有**正文都必须从这里出 —— 与飞书 `im_cards._md` 逐条对位：

     1. `im_markdown.to_slack()` —— mrkdwn 不认 `## 标题` / GFM 表格，粗体只认单星，
        链接要 `<url|text>`（2026-09-03 与飞书同一处修复）。
     2. `long_answer.clip()` —— section 硬上限，超了是**整条消息 400**。
    顺序不能反（降级会改变长度）。
    """
    return blocks.section(
        long_answer.clip(im_markdown.to_slack(text), MAX_BODY, locale))

# ⚠️ 2026-09-03 起这里**只剩 url 按钮**（打开控制台 / 查看完整报告），一个回调按钮都
# 不发了 —— 理由见飞书 `im_cards.answer_card` 的说明。所以原来那套 `_btn_value()`
# （把 action + 截短的原话 + locale 打成 JSON 塞进 value）也一并去掉了。
# 真要加回**回调**按钮时，两条约定必须一起加回来：① Slack 的 value 只能是字符串且
# 上限 2000，原话要截短；② `locale` 必须放进 value —— `block_actions` 回调里没有
# thread_ts 之外的会话上下文，不带回来点按钮后的回复语言会跟消息本身不一致
# （`app/case_flow.py::_locale_from_action` 用的是同一个约定）。

#: `answer_blocks` 的非终态标题（终态回落到 `im.chat.card_title`）。**与飞书那份
#: `im_cards._ANSWER_TITLES` 逐字对齐** —— 两边漂移是 IM 侧最容易复发的一类 bug。
_ANSWER_TITLES = {
    "queued": "im.chat.queued_title",
    "thinking": "im.chat.thinking_title",
}


def answer_blocks(reply: str, locale: str, *,
                  steps=None, state: str = "final", elapsed: int = 0,
                  report_url: str = "") -> list[dict]:
    """DevOps Agent 直连问答的答案消息 —— 「思考中」与「答完」**共用**这一份。

    与 `im_cards.answer_card` 逐参数对齐（含 `state` 三态 queued/thinking/final、
    **只有终版挂按钮**、`report_url` 只挂按钮不上传的口径），方便两边一起改 ——
    包括 2026-09-03 那次"去掉默认的升级/开案例两个按钮"（理由见飞书那份的说明）。
    过程行的 markdown 由 `live_card.steps_md` 统一生成。
    """
    final = state == "final"
    title_key = _ANSWER_TITLES.get(state, "im.chat.card_title")
    out: list[dict] = [
        blocks.header(i18n.t(title_key, locale, seconds=elapsed)),
        # ⚠️ section 的文本**不能为空**（Slack 直接 `invalid_blocks`，整条消息发不出去）。
        # 非终态（queued / thinking）的第一帧完全可能还没有一个字，所以兜一个省略号。
        _sec((reply or "").strip() or "...", locale),
    ]
    md = live_card.steps_md(steps, locale)
    if md:
        # 过程行单独一个 section：与正文合并会双双撞上 3000 字符上限（超限是整条消息 400）。
        out.append(_sec(md, locale))
    out.append(blocks.divider())
    out.append(blocks.context(i18n.t("router.direct_no_token", locale)))
    btns: list[dict] = []
    if report_url and final:
        # url 按钮不产生回调，`action_id` 只用来占位。
        btns.append(blocks.button(i18n.t("report.see_full", locale),
                                  "im_open_report", url=report_url))
    if btns:
        out.append(blocks.actions(*btns))
    return out


#: `dispatch_blocks` 的 4 个状态 → 标题 i18n key（Slack header 没有颜色，
#: 飞书那份的 template 颜色在这里退化成 emoji —— 标题模板里本来就带）。
_DISPATCH_TITLES = {
    "dispatched": "im.investigate.card_title",
    "running": "progress.investigating",
    "done": "progress.completed",
    "failed": "progress.failed",
}


def dispatch_blocks(body: str, locale: str, *, deep_link: str = "",
                    home: str = "", state: str = "dispatched",
                    elapsed: int = 0) -> list[dict]:
    """深度调查消息 —— 「已发起」与后续每一次 `chat.update` **共用**这一份。

    与 `im_cards.dispatch_card` 逐参数对齐（含 2026-09-03 去掉的「只要一个答案就行」
    与「开案例」两个按钮，理由见飞书那份），方便两边一起改。
    """
    title_key = _DISPATCH_TITLES.get(state, _DISPATCH_TITLES["dispatched"])
    # `im.investigate.card_title` 没有 {seconds} 占位符，多传一个 kwarg 是无害的。
    title = i18n.t(title_key, locale, seconds=elapsed)
    out: list[dict] = [
        blocks.header(title),
        _sec(body, locale),
        blocks.context(i18n.t("router.direct_no_token", locale)),
    ]
    btns: list[dict] = []
    link = deep_link or home
    if link:
        label = ("progress.btn.open_link" if deep_link else "progress.btn.open_home")
        # url 按钮不产生回调；Slack 会拒绝 url 按钮上的 style，`blocks.button` 已处理。
        btns.append(blocks.button(i18n.t(label, locale), "im_open_console", url=link))
    if btns:
        out.append(blocks.actions(*btns))
    return out


def text_blocks(text: str, locale: str, *,
                title_key: str = "im.chat.card_title") -> list[dict]:
    """一句话消息（错误 / 提示用）。"""
    return [
        blocks.header(i18n.t(title_key, locale)),
        _sec(text, locale),
    ]


def fallback_text(blocks_out: list[dict]) -> str:
    """从 blocks 里取一段 `text=` fallback（通知栏 + 无障碍读它）。

    Slack 不强制 `text`，但缺了会在 API 响应里带告警，且手机推送会显示成
    「This content can't be displayed」。取第一个 header 的文字最稳。
    """
    for b in blocks_out or []:
        if b.get("type") == "header":
            return str(((b.get("text") or {}).get("text")) or "NotiOps")
    return "NotiOps"


def ts_of(api_response) -> str:
    """从 `chat.postMessage` 的返回里取新消息的 `ts`（= 飞书的 message_id）。

    拿不到就返回空串 —— 调用方据此决定"这条消息后续能不能 update"。**不要**在拿不到时
    退回用户消息的 ts：那会让进度轮询去改用户自己发的消息（必失败，且连续失败 30 分钟）。
    """
    try:
        # SlackResponse 支持 `.get()`；真 dict 也支持。
        return str(api_response.get("ts") or "")
    except AttributeError:
        return ""
