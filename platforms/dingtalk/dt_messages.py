"""钉钉消息渲染 —— webhook 路径上**所有**消息都从这里出。

`platforms/feishu/im_cards.py` / `platforms/slack/im_blocks.py` 的钉钉对位实现：

    im_cards.answer_card    → answer_text
    im_cards.dispatch_card  → dispatch_text
    im_cards.text_card      → text_message

── 返回值是 `(title, text)` 元组，不是卡片 ────────────────────────────────────
钉钉 markdown 消息的形状是 `{"title": ..., "text": ...}`：`title` **只出现在通知栏
和会话列表的预览里**，聊天窗口里显示的只有 `text`。所以：

· `title` 走 i18n 的标题 key（和飞书卡片头 / Slack header 同一批 key，逐字复用）；
· `text` 的**第一行**要把标题再写一遍 —— 否则聊天窗口里那条消息没有任何标题。

── 与另外两家的三处硬差异（照抄会踩）─────────────────────────────────────────
 1. **没有按钮回调**（见 `caps.py` 文件头第 4 条）：ActionCard 的按钮
    只能跳 URL，没有"按钮 → 回调我们服务器"这条路。所以 url 按钮**降级成正文末尾的
    markdown 链接**（`[查看完整报告](url)`），回调按钮一个都没有（另外两家 2026-09-03
    起也只剩 url 按钮，所以这一条差异实际只影响外观）。
 2. **不认表格，但认 ATX 标题** —— `im_markdown.to_dingtalk()` 只降级表格、保留
    `#`~`######`（钉钉自己渲染得了，降级成粗体反而丢层级）。
 3. **没有消息更新**，所以这里没有 `message_id_of` / `ts_of` 的对位函数：拿到
    `errcode: 0` 之外什么都没有，本来也没有能更新的句柄（§4.4）。

── 上限 `MAX_BODY = 3000` ──────────────────────────────────────────────────
机制 2/3 的 `msgParam` 硬上限是 **15000 字节**（不是字符）。中文 UTF-8 3 字节：
3000 × 3 = 9000 字节，余量留给 JSON 转义、`title`、落款。`sessionWebhook` 的上限官方
没有精确写 —— 取"满足最严约束"的那个值，而不是赌它更宽。
（对比：飞书 3500 / Slack 2900。）

⚠️ 截断一律走 `long_answer.clip()`，**不要**写裸切片 —— 与另外两家同口径。
且顺序不能反：**先 `to_dingtalk()` 再 `clip()`**（降级会改变长度）。
"""
from __future__ import annotations

from core import i18n
from platforms.common import im_footer, im_markdown, live_card, long_answer

#: 正文渲染上限，见模块头。
MAX_BODY = 3000


def _md(text: str, locale: str) -> str:
    """一段正文。**所有**正文都必须从这里出 —— 与飞书 `im_cards._md` / Slack
    `im_blocks._sec` 逐条对位（降级 → 截断，顺序固定）。"""
    return long_answer.clip(im_markdown.to_dingtalk(text), MAX_BODY, locale)


def _link(label: str, url: str) -> str:
    """url 按钮的替代品。钉钉没有回调按钮，链接是唯一可点的东西（§4.2）。"""
    return f"[{label}]({url})"


#: `answer_text` 的非终态标题（终态回落到 `im.chat.card_title`）。
#: **与飞书 `im_cards._ANSWER_TITLES` / Slack `im_blocks._ANSWER_TITLES` 逐字对齐** ——
#: 三边漂移是 IM 侧最容易复发的一类 bug。
_ANSWER_TITLES = {
    "queued": "im.chat.queued_title",
    "thinking": "im.chat.thinking_title",
}

#: 同两个状态的**不带秒表**版本 —— 这一份是钉钉独有的，另外两家没有也不该有。
#:
#: 2026-09-08 现网反馈原话：「这个『已用时』如果不会自动刷新，也没有意义」。这条消息
#: 发出去就定格了（钉钉拿不到消息 id，改不了，见 `caps.chat` docstring §4.4），而它是
#: 用 `elapsed=0` 渲染的 —— 于是用户看到的是一个**永远停在 0 秒**的计时器。那不是
#: "少给一点信息"，是**假信息**：它让人以为进度卡住了。
#:
#: 只在 `elapsed <= 0` 时用（= 第一条消息）。追加式进度的第二、三条带的是真实秒数，
#: 那几条照样显示「已用时 N 秒」—— 那个数字是**当条消息发出的那一刻**的真值，没有骗人。
_ANSWER_TITLES_NOCLOCK = {
    "queued": "im.chat.queued_title.noclock",
    "thinking": "im.chat.thinking_title.noclock",
}

#: 终态标题按"谁答的"分三套。**与另外两家的 `_FINAL_TITLES` 逐字对齐**
#: （`starops` 那条点明**阿里云** —— 理由见飞书那份的说明）。
_FINAL_TITLES = {
    "devops": "im.chat.card_title",
    "notiops": "im.chat.card_title.notiops",
    "starops": "im.chat.card_title.starops",
}


def usage_footer(locale: str, *, agent: str = "devops", usage=None,
                 account: str = "", deploy: str = "",
                 employee: str = "") -> str:
    """落款 —— 实现在 `platforms.common.im_footer`，**三个平台共用同一份**。
    这里只保留入口，理由同另外两家：`caps.py` 的纯文本兜底路径直接调它。

    `agent="starops"` 时 AWS 账号那一段**整段消失**、换成阿里云数字员工 ID
    （跨云假信息，见 `im_footer` 文件头 🔴 那一段）。
    """
    return im_footer.usage_footer(locale, agent=agent, usage=usage,
                                  account=account, deploy=deploy,
                                  employee=employee)


def answer_text(reply: str, locale: str, *,
                steps=None, state: str = "final", elapsed: int = 0,
                report_url: str = "", sources=None,
                agent: str = "devops", usage=None,
                account: str = "", deploy: str = "",
                employee: str = "") -> tuple[str, str]:
    """对话问答的答案消息 → `(title, markdown)`。

    与 `im_cards.answer_card` / `im_blocks.answer_blocks` **逐参数对齐**（含 `state`
    三态 queued/thinking/final、`report_url` 只在终版出现、`agent` 只影响标题与落款），
    方便三边一起改。过程行 / 来源的 markdown 由 `live_card.steps_md` / `sources_md`
    统一生成 —— 那两个是模块级纯函数，与平台无关。

    `account` / `deploy` 是落款里「这条回答基于哪个账号」那一段（多账号）：`account`
    是本轮目标账号（空 = 部署账号），`deploy` 是部署账号号。**两个都必须由调用方传** ——
    这个函数会被追加式进度反复调，在这里解析账号等于把一次 STS 塞进渲染循环。

    `employee` 是 STAROps 那条路上**替代**账号那一段的阿里云数字员工 ID（2026-09-14），
    口径与另外两家逐字相同（含"进度态拿不到、只有终版有值"那条）。
    """
    final = state == "final"
    # 非终态且还没走过一秒 → 用不带秒表的标题（见 `_ANSWER_TITLES_NOCLOCK`）。
    titles = _ANSWER_TITLES if (elapsed or 0) > 0 else _ANSWER_TITLES_NOCLOCK
    title_key = titles.get(
        state, _FINAL_TITLES.get(agent, "im.chat.card_title"))
    title = i18n.t(title_key, locale, seconds=elapsed)

    # 正文第一行重写一遍标题：钉钉的 `title` 只进通知栏，聊天窗口里看不到（见模块头）。
    parts = [f"### {title}", ""]
    body = (reply or "").strip()
    if body:
        parts.append(_md(body, locale))
    md = live_card.steps_md(steps, locale)
    if md:
        parts.extend(["", _md(md, locale)])
    # 来源只在**终版**渲染（口径同另外两家：过程中它会随每条追加消息增长，看着抖）。
    if final:
        src = live_card.sources_md(sources, locale)
        if src:
            parts.extend(["", _md(src, locale)])
    if report_url and final:
        parts.extend(["", _link(i18n.t("report.see_full", locale), report_url)])
    parts.extend(["", "---", "",
                  usage_footer(locale, agent=agent, usage=usage,
                               account=account, deploy=deploy,
                               employee=employee)])
    return title, "\n".join(parts)


#: `dispatch_text` 的 4 个状态 → 标题 i18n key。**与另外两家的 `_DISPATCH_TITLES`
#: 逐字对齐**（飞书那份的卡片颜色在这里和 Slack 一样退化成标题模板自带的 emoji）。
_DISPATCH_TITLES = {
    "dispatched": "im.investigate.card_title",
    "running": "progress.investigating",
    "done": "progress.completed",
    "failed": "progress.failed",
}

#: 同三个状态的**不带秒表**版本 —— 钉钉独有，理由与 `_ANSWER_TITLES_NOCLOCK` 逐字相同。
#:
#: 2026-09-09 现网反馈原话：「返回的信息开始仍有『调查中 · 已用时 0 秒』…… 在钉钉里，
#: 『已用时 0 秒』这个就不需要了」。这一条走的是**状态回读**那条路
#: （`caps.investigate_status` → `platforms/common/inv_status.py`）：那边只有"这条调查
#: 现在什么状态"，压根没有 `elapsed` 可传 ⇒ 三个状态全部渲染成 0 秒。一次跑了 6 分钟
#: 的调查在用户眼里成了「已用时 0 秒」，而这条钉钉消息发出去就定格（拿不到消息 id，
#: 改不了，§4.4）—— 那不是少给信息，是**假信息**。
#:
#: 同 `answer_text`：只在 `elapsed <= 0` 时用。真有秒数的（追加式进度）照样显示 ——
#: 那个数字是**当条消息发出的那一刻**的真值。
#: ⚠️ `dispatched` 不进这张表：`im.investigate.card_title` 本来就没有 `{seconds}`。
_DISPATCH_TITLES_NOCLOCK = {
    "running": "progress.investigating.noclock",
    "done": "progress.completed.noclock",
    "failed": "progress.failed.noclock",
}


def dispatch_text(body: str, locale: str, *, deep_link: str = "",
                  home: str = "", state: str = "dispatched",
                  elapsed: int = 0, account: str = "",
                  deploy: str = "") -> tuple[str, str]:
    """深度调查消息 → `(title, markdown)`。

    与 `im_cards.dispatch_card` / `im_blocks.dispatch_blocks` 逐参数对齐。钉钉这边
    `state` 的 `running` 只可能来自追加式进度或**状态回读**（没有原地刷新，§4.4），
    所以 `elapsed <= 0` 时走 `_DISPATCH_TITLES_NOCLOCK`：见那张表的注释。
    """
    titles = _DISPATCH_TITLES if (elapsed or 0) > 0 else _DISPATCH_TITLES_NOCLOCK
    title_key = (titles.get(state)
                 or _DISPATCH_TITLES.get(state, _DISPATCH_TITLES["dispatched"]))
    # `im.investigate.card_title` 没有 {seconds} 占位符，多传一个 kwarg 是无害的。
    title = i18n.t(title_key, locale, seconds=elapsed)
    parts = [f"### {title}", ""]
    if (body or "").strip():
        parts.append(_md(body, locale))
    # 标签必须与 href 对上 —— 判断在 `live_card.console_link()`（三家共用），见那边注释。
    link, label = live_card.console_link(deep_link, home)
    if link:
        parts.extend(["", _link(i18n.t(label, locale), link)])
    # 深度调查永远是直连那条路（0 token），所以落款固定 `agent="devops"`；账号那一段
    # 在这条消息上尤其要有 —— 深度调查是**真的去查那个账号的资源**，查错了账号的报告
    # 看起来跟查对了一模一样。
    parts.extend(["", "---", "",
                  usage_footer(locale, account=account, deploy=deploy)])
    return title, "\n".join(parts)


def titled_text(title: str, text: str, locale: str) -> tuple[str, str]:
    """标题**已经渲染好**的一段消息 → `(title, markdown)`。

    给带占位符的标题用（`case.analyze.title` 要 `display_id`、案例列表标题要
    过滤器标签…）。正文照样过 `_md()` —— 案例正文里就有 GFM 表格式的行，
    绕过降级就会在钉钉里显示成一堆竖线。
    """
    return title, f"### {title}\n\n{_md(text, locale)}"


def text_message(text: str, locale: str, *,
                 title_key: str = "im.chat.card_title") -> tuple[str, str]:
    """一句话消息（错误 / 提示用）→ `(title, markdown)`。"""
    return titled_text(i18n.t(title_key, locale), text, locale)


__all__ = ["MAX_BODY", "answer_text", "dispatch_text", "text_message",
           "titled_text", "usage_footer"]
