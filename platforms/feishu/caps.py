"""Feishu 端 `Caps` 实现（IM 重构 / M1）—— 每一条能力"发什么、怎么发"。

**决策不在这里**（那是 `platforms.common.router.dispatch` 的活儿）；这里只做**渲染 + 发送**。
每个方法接收规范化的 `ImMessage`，返回值只用于日志/断言。

复用策略：
  · `case` 直接调平台里已经写好的 `case_flow`（M0 的目标就是把这些"业务模块"独立
    出来 —— 它们本来就跟 SDK 事件类型解耦）。
  · `investigate` 走 `core.devops_agent.start_investigation`（BFF「深度调查(直连)」同款，
    **不是** Fargate 时代的 `shared.devops_agent.create_investigation`）—— **不烧 token**：
    只 create_backlog_task，正文 = 用户原话；不做 NotiOps 侧摘要/翻译。
    2026-09-03 起 `case_flow._dispatch_for_case`（「开案例 + 起调查」）也走同一条路。
  · `chat` **两条路**，由会话开关 `/agent` 决定（`core.im_prefs`）：
      - `devops`（默认）→ `core.devops_chat.run_devops_chat`，客户 DevOps Agent 直答，
        **NotiOps 侧 0 token**；
      - `notiops` → `core.agent_chat.run_agent_chat`，走我们的 AgentCore runtime，
        **会消耗 token**（窄工具集 `im-chat`，口径见 `core/agent_chat.py` 头部注释）。
  · `language` / `model` / `agent` / `web` / `help` 全是确定性文本回复，直接调
    `feishu_utils.reply_text`。

⚠️ 「哪些能力花钱」的口径（改这里之前先把 `core/agent_chat.py` 的头部注释读完）：
默认配置下只有 `case_analyze` 和 `case_create` 的表单提交会烧 NotiOps 侧 token；
用户显式 `/agent notiops` 之后 `chat` 也会 —— 所以卡片落款必须按 agent 分两套说法
（`im_cards.usage_footer`），不许一律写「无模型消耗」。
"""
from __future__ import annotations

import logging

from core import agent_chat
from core import i18n
from core import ddb_state
from core import devops_chat
from core import im_prefs
from core import llm_pref_resolver
from core import locale_resolver
from core import model_catalog
from platforms.common import (ack_variants, chat_lease, live_card, long_answer,
                              pref_commands)
from platforms.common.im_types import Caps, ImMessage
from platforms.feishu import im_cards
from platforms.feishu.app import feishu_utils

logger = logging.getLogger(__name__)

PLATFORM = "feishu"


class FeishuCaps(Caps):
    """具体的飞书能力实现。**无状态**：所有会话状态在 DDB（`imchat#` / `imtask#`）。"""

    # ---- 传输 ----
    def reply_text(self, msg: ImMessage, text: str) -> None:
        in_thread = not msg.is_direct
        feishu_utils.reply_text(msg.message_id, text, in_thread=in_thread)

    # ---- 九个能力 ----
    def help(self, msg: ImMessage) -> None:
        """`/help` 命令菜单 —— 必须发**卡片**，不能发纯文本。

        ⚠️ 2026-09-03 现网反馈：菜单「直接是源码，没有格式」。根因是这里原来走
        `reply_text`，而**飞书的纯文本消息不渲染 markdown** —— `**深度调查**` 和
        `` `/调查` `` 会一个字不差地把星号和反引号显示给用户看。卡片里的
        `{"tag": "markdown"}` 元素才渲染。所以菜单类内容一律走 `im_cards.text_card`：
        标题进 header，正文（intro + 每行命令 + footer）进 markdown 元素。
        这条同样适用于以后任何带 `**` / 反引号的 i18n 文案。
        """
        from core import nl_router
        rows = "\n".join(
            i18n.t(f"help.row.{feat}", msg.locale)
            for feat, _en, _zh in nl_router.HELP_COMMANDS
        )
        body = (f"{i18n.t('help.intro', msg.locale)}\n\n{rows}\n\n"
                f"{i18n.t('help.footer', msg.locale)}")
        card = im_cards.text_card(body, msg.locale, color="blue",
                                  title_key="help.title")
        resp = feishu_utils.send_card(msg.chat_id, card)
        if not im_cards.message_id_of(resp):
            # 卡片发不出去（权限/限流）→ 菜单本身不能丢，退纯文本。
            # 退化后格式会变回源码样，但"看得见"优先于"好看"；**不许静默**。
            logger.error("caps.help: send_card failed code=%s",
                         (resp or {}).get("code"))
            self.reply_text(msg, f"{i18n.t('help.title', msg.locale)}\n\n{body}")

    def language(self, msg: ImMessage, arg: str, lang: str = "") -> None:
        """`/language [zh|en|auto]` 或 NL"切换到英文"。

        ⚠️ 命令类回复必须走 `_pre_locale` 口径（用户偏好 + 锁，**不自动检测**）——
        因为『language en』这种入参本身就影响下一句要用哪个 locale 回。上层 worker
        在构造 `ImMessage` 时已经把 `msg.locale` 设成 `_pre_locale`，这里直接用。
        """
        # NL 分支直接给了 zh/en；命令分支的 arg 可能是空 / `zh` / `en` / `auto` / 别的
        target = i18n.normalize_locale(lang or arg)
        if not msg.user_id:
            self.reply_text(msg, i18n.t("main.failed_user_id", msg.locale))
            return
        if not target or target not in ("zh", "en", "auto"):
            # 显示当前
            cur, source = locale_resolver.resolve(user_id=msg.user_id,
                                                  platform=PLATFORM, text="")
            name = i18n.locale_name(cur, cur)
            key = "lang.current.user" if source == "user" else "lang.current.auto"
            self.reply_text(msg, i18n.t(key, cur, name=name) + "\n"
                            + i18n.t("lang.usage", cur))
            return
        if target == "auto":
            ok = locale_resolver.set_user_pref(msg.user_id, "auto", platform=PLATFORM)
            self.reply_text(msg, i18n.t("lang.unset" if ok else "lang.unset_failed",
                                        msg.locale))
            return
        ok = locale_resolver.set_user_pref(msg.user_id, target, platform=PLATFORM)
        name = i18n.locale_name(target, target)
        self.reply_text(msg, i18n.t("lang.set.user" if ok else "lang.set_failed",
                                    target if ok else msg.locale, name=name))

    def model(self, msg: ImMessage, model_arg: str) -> None:
        arg = (model_arg or "").strip().lower()
        is_dm = msg.is_direct
        if not arg:
            alias, source = llm_pref_resolver.resolve(
                platform=PLATFORM, chat_id=msg.chat_id, user_id=msg.user_id, is_dm=is_dm)
            entry = model_catalog.get(alias)
            text = (i18n.t("model.current", msg.locale, label=entry.label, source=source)
                    + "\n" + i18n.t("model.usage", msg.locale))
            self.reply_text(msg, text)
            return
        if arg == "list":
            rows = "\n".join(
                i18n.t("model.list_row", msg.locale, alias=e.alias, label=e.label)
                for e in model_catalog.all_entries()
            )
            self.reply_text(msg, i18n.t("model.list_header", msg.locale) + "\n"
                            + rows + "\n\n" + i18n.t("model.usage", msg.locale))
            return
        if arg == "default":
            if is_dm:
                llm_pref_resolver.clear_dm_pref(PLATFORM, msg.user_id)
            else:
                llm_pref_resolver.clear_chat_pref(PLATFORM, msg.chat_id)
            self.reply_text(msg, i18n.t("model.cleared", msg.locale))
            return
        if not model_catalog.is_known(arg):
            self.reply_text(msg, i18n.t("model.unknown", msg.locale, alias=arg,
                                        valid=", ".join(model_catalog.list_aliases())))
            return
        ok = (llm_pref_resolver.set_dm_pref(PLATFORM, msg.user_id, arg)
              if is_dm else
              llm_pref_resolver.set_chat_pref(PLATFORM, msg.chat_id, arg))
        if not ok:
            self.reply_text(msg, i18n.t("model.set_failed", msg.locale))
            return
        entry = model_catalog.get(arg)
        key = "model.set_dm" if is_dm else "model.set_chat"
        self.reply_text(msg, i18n.t(key, msg.locale, label=entry.label))

    def agent(self, msg: ImMessage, arg: str) -> None:
        """`/agent [notiops|devops|default]` —— 这个会话的对话由谁答（0 token）。

        逻辑与文案全在 `platforms.common.pref_commands`：这两条命令没有任何平台差异，
        两边各写一遍必然漂移（见那个模块的文件头）。
        """
        self.reply_text(msg, pref_commands.agent_reply(msg, arg, platform=PLATFORM))

    def web(self, msg: ImMessage, arg: str) -> None:
        """`/web [on|off]` —— 联网搜索开关（0 token）。只对 NotiOps Agent 生效。"""
        self.reply_text(msg, pref_commands.web_reply(msg, arg, platform=PLATFORM))

    def investigate(self, msg: ImMessage, text: str) -> None:
        """发起一次深度调查 —— **0 token**：只 create_backlog_task，NotiOps 侧不总结、
        不翻译、不做任何 LLM 调用。正文直接是 `text`；`source` 打成 `notiops-im-feishu`
        方便 Operator App backlog 里溯源。

        发的是**卡片**而不是文本，且 `imtask#` 落库的 `message_id` 必须是**这张卡的**
        message_id —— 进度 Lambda 每分钟 PATCH 的就是它。落成用户那条消息的 id 会让
        `update_card` 去改用户自己发的消息（必失败，而且一失败就连续失败 30 分钟）。
        """
        from core import devops_agent
        q = (text or "").strip()
        if not q:
            # `/调查` 后面什么都没写 —— 直接问清楚，别拿空正文去开任务。
            self.reply_text(msg, i18n.t("im.investigate.need_text", msg.locale))
            return
        title = q.splitlines()[0][:80]
        result = devops_agent.start_investigation(
            title=title, description=q,
            account_id=msg.account_id or None,
            source="notiops-im-feishu",
        )
        if result.get("error"):
            self.reply_text(msg, str(result.get("message") or result["error"]))
            return

        home = result.get("console_home") or ""
        deep = result.get("console_url") or ""
        body = i18n.t("ack.dispatched", msg.locale)
        card = im_cards.dispatch_card(body, msg.locale, deep_link=deep, home=home,
                                      state="dispatched")
        resp = feishu_utils.send_card(msg.chat_id, card)
        card_message_id = im_cards.message_id_of(resp)
        if not card_message_id:
            # 卡片没发出去 → 没有 PATCH 落点。**不落 imtask#**（否则进度 Lambda 会对着
            # 一个空 message_id 重试 30 分钟），改用文本把链接和这个事实一起告诉用户。
            logger.error("caps.investigate: send_card failed code=%s",
                         (resp or {}).get("code"))
            line = body
            if deep:
                line += f"\n{i18n.t('progress.btn.open_link', msg.locale)}: {deep}"
            elif home:
                line += f"\n{i18n.t('progress.btn.open_home', msg.locale)}: {home}"
            line += "\n\n" + i18n.t("im.investigate.card_failed", msg.locale)
            self.reply_text(msg, line)
            return

        incident_id = f"feishu-{msg.event_id}"
        ddb_state.put_im_task(
            incident_id,
            platform=PLATFORM, chat_id=msg.chat_id, message_id=card_message_id,
            locale=msg.locale, account_id=result.get("account_id") or "",
            task_id=result.get("task_id") or "",
            execution_id=result.get("execution_id") or "",
            agent_space_id=result.get("agent_space_id") or "",
            user_id=msg.user_id, title=title,
            console_url=deep, console_home=home,
        )
        # 第二行路由：**最终报告卡**（摘要 + 报告链接 + trace）走的是另一条链路 ——
        # DevOps Agent 的 EventBridge 事件 → notiops-devops-callback →
        # report_handler，它只认 `incident#` / `task#`。少了这一步，进度卡会一路刷到
        # 「已完成」，但报告只躺在 S3 里，用户拿不到链接（现网 2026-09-02 实测形态）。
        ddb_state.link_im_investigation(
            incident_id, result.get("task_id") or "",
            platform=PLATFORM, chat_id=msg.chat_id,
            root_message_id=card_message_id,
            locale=msg.locale, user_id=msg.user_id, raw_text=q[:1000],
        )

    def investigate_status(self, msg: ImMessage, ref_id: str,
                           explicit: bool = True) -> None:
        """回读一条**已有**调查的进展 —— 0 token，**不新建任何东西**。

        这是 2026-09-03 现网 bug 的修复出口：用户拿着 `[[investigation:…]]` 追问
        「现在什么状态」/「帮我监控实时进展」，之前每问一次就再开一条付费调查。
        判据在 `core.nl_router.parse_investigation_ref`，共享逻辑在
        `platforms/common/inv_status.py`（Slack 用同一份）。

        `explicit` 决定"查不到"时怎么办：
          · True（用户明确写了 `[[investigation:…]]` / `execution_id=…` / `exe-…`）
            → **照实说查不到**，并明说没有替他新建。绝不能"顺手起一条新的"。
          · False（我们从一个裸 uuid 猜的）→ 静默落回 `chat`：那串 uuid 很可能是个
            volume id / 请求 id，用户问的是别的事。
        """
        from platforms.common import inv_status
        info = inv_status.describe(ref_id, account_id=msg.account_id or "",
                                   locale=msg.locale)
        if not info.get("ok"):
            if not explicit:
                # 猜错了 —— 当作普通问题交给 DevOps Agent 直答（同样 0 token）。
                logger.info("caps.investigate_status: guessed ref missed → chat")
                self.chat(msg, msg.text)
                return
            if info.get("error") == "not_found":
                text = i18n.t("im.investigate.status.not_found", msg.locale,
                              ref=ref_id)
            else:
                text = str(info.get("message") or info.get("error") or "")
            card = im_cards.text_card(text, msg.locale, color="orange",
                                      title_key="im.investigate.status.title")
            if not im_cards.message_id_of(feishu_utils.send_card(msg.chat_id, card)):
                self.reply_text(msg, text)
            return

        mode = inv_status.plan(info)
        deep = str(info.get("console_url") or "")
        home = str(info.get("console_home") or "")
        card = im_cards.dispatch_card(
            inv_status.body(info, msg.locale, mode=mode), msg.locale,
            deep_link=deep, home=home, state=inv_status.card_state(info))
        resp = feishu_utils.send_card(msg.chat_id, card)
        card_message_id = im_cards.message_id_of(resp)
        if not card_message_id:
            # 没有 PATCH 落点 → **不落 imtask#**（进度 Lambda 会对着空 message_id
            # 重试到 TTL），改用文本，并且把"这里不会自动刷新"说清楚。
            logger.error("caps.investigate_status: send_card failed code=%s",
                         (resp or {}).get("code"))
            line = inv_status.body(info, msg.locale, mode="card_failed")
            if deep or home:
                key = ("progress.btn.open_link" if deep
                       else "progress.btn.open_home")
                line += f"\n{i18n.t(key, msg.locale)}: {deep or home}"
            self.reply_text(msg, line)
            return
        if mode == "attach":
            inv_status.attach(info, platform=PLATFORM,
                              incident_id=f"{PLATFORM}-{msg.event_id}",
                              chat_id=msg.chat_id, message_id=card_message_id,
                              locale=msg.locale, user_id=msg.user_id)

    def case(self, msg: ImMessage, command: str, case_id: str, text: str) -> None:
        """案例路径 —— **默认配置下唯一会烧 NotiOps 侧 token 的能力**。

        （"默认配置下"这四个字是 2026-09-06 加的：用户显式 `/agent notiops` 之后
        `chat` 也会走模型。默认值仍是 `devops` 直连，所以开箱即用时只有这一条。）

        🔴 别把这里的 LLM 记成 `analyze_intent`（2026-09-06 校正）：`display_id` /
        标题 / 正文是 `core.nl_router` **确定性**抽出来的，`analyze_intent` 在
        重构后的活路径上**一次都不会被调到**。真正花钱的只有两处，都在下游：

          - `case_analyze` → `core/case_analyze.py`（读工单往来后总结，1500 输出上限）；
          - `case_create` 的**表单提交那一刻** → `core/case_classifier.py`，把
            `describe_services` 的**整份服务目录**塞进 system prompt 换一个合法的
            `(serviceCode, categoryCode, issueType)` 三元组。**这是全 IM 单次
            输入最贵的一次调用**（现网实测 ~1.8 万输入 token，且无 prompt cache）。
            发出表单本身是 0 token —— 标题预填是确定性的，见
            `case_flow._summarize_subject`。

        其余四个 `case_*`（view / reply / resolve / list）都是纯 boto3 + 确定性渲染。

        M1 首版：由 worker 直接把 `ImMessage` 转成老 `case_flow` 的入参调用。案例卡片
        渲染仍走 platforms/feishu/app/case_flow.py 的现成实现。
        """
        from platforms.feishu.app import case_flow
        try:
            if command == "case_view":
                case_flow.start_view(msg.chat_id, case_id, locale=msg.locale)
            elif command == "case_reply":
                case_flow.start_reply(msg.chat_id, case_id, text or "",
                                      locale=msg.locale)
            elif command == "case_resolve":
                case_flow.start_resolve(msg.chat_id, case_id, locale=msg.locale)
            elif command == "case_analyze":
                case_flow.start_analyze(msg.chat_id, case_id, locale=msg.locale)
            elif command == "case_create":
                case_flow.start_create(msg.chat_id, text or "", locale=msg.locale)
            else:
                case_flow.start_list(msg.chat_id, status_filter="recent",
                                     locale=msg.locale)
        except Exception as e:
            logger.exception("caps.case failed kind=%s: %s", command, type(e).__name__)
            self.reply_text(msg, i18n.t("main.case_flow_crashed", msg.locale,
                                        kind=type(e).__name__))

    def chat(self, msg: ImMessage, text: str) -> None:
        """对话问答 —— **两条路，同一张卡**。由 `/agent` 开关（`core.im_prefs`）决定：

          · `devops`（默认）→ `core.devops_chat.run_devops_chat`，客户 DevOps Agent
            直答，**NotiOps 侧 0 token**。多轮上下文靠 `imchat#<chat_id>` 存的
            `execution_id`。
          · `notiops` → `core.agent_chat.run_agent_chat`，走我们的 AgentCore runtime，
            **会消耗 token**。多轮上下文靠 `imagent#<chat_id>` 存的 runtime session id
            （6 小时轮换，因为 AgentCore 的 `maxLifetime` 是 8 小时而 IM 的 chat_id 是
            永久的 —— 详见 `core.ddb_state.im_agent_session_id`）。

        ⚠️ 分流**只影响三件事**：ack 文案用哪一套、调哪个 runner、卡片上 `agent=` /
        `sources=` / `usage=` 三个参数。排队/心跳/终版/截断落报告/兜底全部共用下面这一份
        —— 两条路各写一遍 `chat()` 是这个文件最容易长出漂移的地方。

        答案发**卡片**而不是文本：要有状态标题（排队中/思考中/答完 + 计时）、过程行、
        正文超长时的「查看完整报告」外链。纯文本这三样一样都做不到。
        ⚠️ 2026-09-03 起卡上**没有**默认的「升级成深度调查」/「开案例」按钮了
        （原 §8.1.1「双向兜底」）—— 理由见 `im_cards.answer_card`。两条出路仍在，
        改成按需：直接说「深入查一下」/「开个案例」或 `/investigate`、`/case`
        （`core/nl_router.py` 确定性路由，同样 0 token）。

        ── 「先应答，再边想边看」（2026-09-02）───────────────────────────────────
        M1 首版是"跑完再发卡"。现网实测一个「列出所有 S3 桶及其大小」的问题跑了
        **347 秒**，这 347 秒里用户侧一个字都没有 —— 客户的判断是"后台出问题了"。
        现在分三步：
          1. **立刻**发一张「思考中」卡（拿到 message_id 才有 PATCH 落点）；
          2. 把 `LiveCard.emit` 传进 `run_devops_chat`，正文/过程行/进度按节流 PATCH
             同一张卡（节流策略见 `platforms/common/live_card.py`）；
          3. 收尾 `finish()` 刷终版 —— 用返回值里的全量正文，不是流式累积的那份；
             正文超过 `im_cards.MAX_BODY` 时先过 `long_answer.fit()`（全文落网页报告
             + 一条说清楚"这里被截了、完整版在哪"的提示），不许静默切掉。
        任何一步的卡片操作失败都不许吃掉答案：`live.dead` / 首卡发不出去时退回发文本。

        ── 一个会话同时只跑一个（2026-09-02）──────────────────────────────────────
        多轮上下文是"一个 chat 一个 `execution_id`"，并发两个问题会共用同一个
        execution 互相拖死（现网实测：前一轮跑到 318 秒后死在上游 `connection_error`）。
        所以进来先抢会话租约（`platforms/common/chat_lease.py`）：抢不到就把首卡发成
        「排队中」，等前一个跑完**就地**转成「思考中」继续答；等不到也明说。
        """
        # 第 -1 步：这个会话现在由谁答。**在发卡之前**读 —— ack 文案和卡片落款都要它。
        agent, _src = im_prefs.resolve_agent(
            platform=PLATFORM, chat_id=msg.chat_id, user_id=msg.user_id,
            is_dm=msg.is_direct)
        notiops = agent == im_prefs.AGENT_NOTIOPS

        # 群会话按 chat 归属（§15：一个 chat 一个会话，不按用户拆）
        session = ddb_state.get_im_chat_session(PLATFORM, msg.chat_id) or {}
        question = (text or msg.text or "").strip()

        # 来源 / 用量要等这一轮跑完才知道，而 `LiveCard` 的 `render` 回调只透传五个
        # 固定 kwarg（body/steps/state/elapsed/report_url）。所以放一个可变盒子让
        # `render=` 的闭包读 —— 终版之前填好，`finish()` 那一刷就带上了。
        extra: dict = {"sources": [], "usage": {}}

        # 第 0 步：抢这个会话的"轮次"。`acquire()` 不阻塞 —— 先把卡发出去再等，
        # 否则用户在排队的那几分钟里一个字都看不到（正是本次要修的那种体验）。
        turn = chat_lease.Turn(PLATFORM, msg.chat_id, owner=msg.event_id)
        queued = not turn.acquire()

        # 第 1 步：立刻应答。非终态的卡不挂按钮，正文是 ack 文案。
        state = "queued" if queued else "thinking"
        # 开场话从 5 条里按这条消息的 id 选一条（见 platforms/common/ack_variants.py）：
        # 同一条消息永远同一条文案，所以下面「排队转正」那次 set_ack 换的是 state，
        # 不是说法 —— 用户不会看到卡片自己改口。
        ack_seed = msg.message_id or msg.event_id
        ack = (i18n.t("im.chat.queued_body", msg.locale) if queued
               else ack_variants.ack_body(ack_seed, msg.locale, agent))
        resp = feishu_utils.send_card(
            msg.chat_id,
            im_cards.answer_card(ack, msg.locale, state=state, elapsed=0,
                                 agent=agent))
        card_message_id = im_cards.message_id_of(resp)
        live = None
        if card_message_id:
            live = live_card.LiveCard(
                ack=ack, state=state,
                render=lambda **kw: im_cards.answer_card(
                    kw["body"], msg.locale,
                    steps=kw["steps"], state=kw["state"], elapsed=kw["elapsed"],
                    report_url=kw["report_url"],
                    agent=agent, sources=extra["sources"], usage=extra["usage"]),
                update=lambda payload: feishu_utils.update_card(
                    card_message_id, payload),
            )
            # 心跳：agent 可以整整 5 分钟不吐一个事件，只靠 emit 驱动的节流刷新会让卡片
            # 定格在「正在连接…」（现网 cd0f6745）。排队期间更是**全程**没有 emit。
            live.start_heartbeat()
        else:
            # 首卡都发不出去 → 没有 PATCH 落点，本轮退化成"跑完发一段文本"。
            # **不许静默**：这条 error 是排查"用户说没反应"的唯一线索。
            logger.error("caps.chat: ack send_card failed code=%s",
                         (resp or {}).get("code"))

        try:
            # 第 2 步：排队的话先等到自己的轮次。等不到**必须明说** —— 静默丢掉一个
            # 问题比说"忙"更糟（用户会一直等一张永远不动的卡）。
            if queued and not turn.wait():
                timeout_text = i18n.t("im.chat.queue_timeout", msg.locale)
                if live is None or not live.finish(timeout_text):
                    self.reply_text(msg, timeout_text)
                return
            if queued:
                # 排队转正：就地把这张卡变成「思考中」（不新发一条 —— 争抢一次只该
                # 占一条消息）。这一下值得 force：用户最想知道的就是"轮到我了"。
                if live is not None:
                    live.set_ack(ack_variants.ack_body(ack_seed, msg.locale, agent))
                    live.set_state("thinking")
                    live.flush(force=True)
                # 前一轮很可能刚写过 execution_id，重新读一遍才是最新的上下文。
                session = ddb_state.get_im_chat_session(PLATFORM, msg.chat_id) or {}

            # 第 3 步：跑，并把过程实时刷回那张卡。
            if notiops:
                # 模型偏好用与 Web 端同一套（`/model` 那条命令的产物）。短别名直接透传
                # 给 agent —— `core.llm_config` 认短别名，不需要在这里翻译一层
                # （见 core/model_catalog.py 顶部关于两套别名命名空间的说明）。
                model_alias, _msrc = llm_pref_resolver.resolve(
                    platform=PLATFORM, chat_id=msg.chat_id, user_id=msg.user_id,
                    is_dm=msg.is_direct)
                result = agent_chat.run_agent_chat(
                    question, locale=msg.locale,
                    session_id=ddb_state.im_agent_session_id(PLATFORM, msg.chat_id),
                    model=model_alias,
                    account_id=msg.account_id or None,
                    web_search=im_prefs.resolve_web(
                        platform=PLATFORM, chat_id=msg.chat_id,
                        user_id=msg.user_id, is_dm=msg.is_direct)[0],
                    emit=(live.emit if live is not None else None),
                )
                # 填盒子（见上面 `extra` 的注释）—— 必须在 `finish()` 之前。
                extra["sources"] = result.get("sources") or []
                extra["usage"] = result.get("usage") or {}
                # 这条路**不写 `imchat#`**：会话连续性由 `imagent#` 那行的 session id
                # 负责，而它的轮换逻辑整个在 `ddb_state.im_agent_session_id` 里面。
            else:
                result = devops_chat.run_devops_chat(
                    text=question, locale=msg.locale,
                    account_id=msg.account_id or None,
                    session=session,
                    emit=(live.emit if live is not None else None),
                )
                # 持久化下一轮的 execution_id
                sess = result.get("session") or {}
                if sess.get("execution_id"):
                    ddb_state.put_im_chat_session(PLATFORM, msg.chat_id, sess)
        finally:
            # 租约必须在 finally 里放 —— 中途抛异常还占着，整个会话要等 TTL 到期才解锁。
            turn.release()
            # 心跳线程同理：Lambda 在 handler 返回后冻结执行环境，没 join 掉的 daemon
            # 线程就是下一次调用的幽灵。`finish()` 里还会再 close 一次（幂等）。
            if live is not None:
                live.close()

        reply = (result.get("reply") or "").strip()
        if not reply:
            reply = i18n.t("main.usage_hint", msg.locale)

        # 卡片正文装不下（飞书 3500）→ 全文落一份网页报告，正文换成"开头 + 说清楚这里被
        # 截了 + 报告链接"。**只在这里做一次**（渲染函数每几秒被 PATCH 调一次，见
        # platforms/common/long_answer.py 文件头）。绝大多数回答没超限，走的是原样返回。
        body, report_url = long_answer.fit(reply, msg.locale,
                                           limit=im_cards.MAX_BODY,
                                           question=question)

        # 第 4 步：终版。`finish` 成功 = 那张卡已经是最终答案（标题回到「回答」、
        # 超长时挂上「查看完整报告」），到此结束。
        # （`finish` 自己会先停心跳 —— 否则心跳下一刷就把终版状态刷回「思考中」。）
        if live is not None and live.finish(body, report_url=report_url):
            return
        # 走到这里：要么首卡没发出去，要么这张卡已经刷不动了（被撤回/一直被拒）。
        # 答案本身不能丢 —— 再发一张新卡；新卡也发不出去才退纯文本。
        card = im_cards.answer_card(body, msg.locale, report_url=report_url,
                                   agent=agent, sources=extra["sources"],
                                   usage=extra["usage"])
        resp = feishu_utils.send_card(msg.chat_id, card)
        if not im_cards.message_id_of(resp):
            # 退纯文本丢的只是卡片外观（状态标题 / 过程行 / 报告按钮）。
            # 报告链接不会丢：它在 `body` 的截断提示里（正文自带，不依赖按钮）。
            # ⚠️ 落款走 `usage_footer` 而**不是**硬编码 `router.direct_no_token`：
            # 走模型那条路上那句是假的（这一轮确实花了钱）。
            logger.error("caps.chat: final send_card failed code=%s",
                         (resp or {}).get("code"))
            self.reply_text(msg, body + "\n\n" + im_cards.usage_footer(
                msg.locale, agent=agent, usage=extra["usage"]))
