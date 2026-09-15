"""钉钉端 `Caps` 实现（IM 重构 / M4）—— 每一条能力"发什么、怎么发"。

`platforms/slack/caps.py` / `platforms/feishu/caps.py` 的钉钉对位实现。**决策不在
这里**（那是 `platforms.common.router.dispatch` 的活儿）；这里只做**渲染 + 发送**。

── 与另外两家的五处结构性差异（照抄会踩）─────────────────────────────────────
 1. **不需要在这里拿 client**。Slack 那份要自己从 Secrets Manager 读 bot token 建
    `WebClient`；钉钉的会话内回复走**入站报文自带的 `sessionWebhook`**（有效期
    ≈90 分钟 > Lambda 的 15 分钟上限），根本不需要 access_token。会话上下文由
    `lambda_worker` 用 `sender.bind(...)` 绑好，这里只调 `sender.reply(...)`。
    所以本模块**没有** `get_client()` 的对位函数，也没有"凭证没填"这条失败路径 ——
    那条在 `sender.load_credentials()` 里（fail-fast，绝不静默降级）。
 2. **每条消息是 `(title, text)` 两段**，`title` 只进通知栏。渲染一律走
    `dt_messages.*`，`_send()` 负责拆元组。
 3. **没有消息 id**（`sessionWebhook` 的返回只有 `{"errcode": 0}`）⇒ 没有可更新的
    句柄 ⇒ **不落 `imtask#`**（见 `investigate` 的注释）、`investigate_status`
    **永不 `attach`**、`chat` 用**追加式**进度而不是 `LiveCard`（`append_progress.py`
    的文件头写了为什么节流方向反过来了）。
 4. **没有按钮回调**（§4.2）：ActionCard 的按钮只能跳 URL。所以 `case` 那条路上
    "确认 → 执行"靠**用户回一句「确认」**（`case_text` 的 convo-session 草稿），
    `Caps` 协议里没有 `ImAction`，本模块也就没有任何 action handler。
 5. **默认语言是 zh**（同飞书，与 Slack 相反）。这里不硬编码：`msg.locale` 由
    worker 用 `locale_resolver` 解析好。

**默认配置下**只有 `case`（`/分析案例`，以及开案例时 `core.case_classifier` 那一次
分类 —— 主题摘要是确定性的 0 token）会烧 NotiOps 侧
token，其余全是确定性渲染 —— 与另外两家同口径。用户显式 `/agent notiops` 之后
`chat` 也走模型（见 `Caps.chat`）；默认值仍是 DevOps Agent 直连。

── markdown 口味 ─────────────────────────────────────────────────────────────
钉钉按**标准 markdown** 解析，所以：
· **不要**过 `blocks.to_mrkdwn()`（那是 Slack 的单星粗体 + `<url|text>`），
  `**粗体**` / `[text](url)` 原样可用；
· 表格不认 → 由 `im_markdown.to_dingtalk()` 在 `dt_messages._md()` 里统一降级；
· i18n 里那批 Slack 口味的单星文案由 `case_text._bold()` 升级成双星。
"""
from __future__ import annotations

import logging

from core import agent_chat
from core import ddb_state
from core import devops_chat
from core import i18n
from core import im_accounts
from core import im_prefs
from core import llm_pref_resolver
from core import locale_resolver
from core import model_catalog
from core import starops_chat
from platforms.common import (ack_variants, chat_lease, long_answer,
                              pref_commands)
from platforms.common.im_types import Caps, ImMessage
from platforms.dingtalk import append_progress, case_text, dt_messages, sender
from shared import dingtalk_api

logger = logging.getLogger(__name__)

PLATFORM = "dingtalk"

#: `investigate` 顺手落的一行会话路由，给**几十分钟后**的报告投递用
#: （`shared/report_delivery/dingtalk_sender`）。`link_im_investigation` 只存
#: `chat_id`，而钉钉的会话外投递必须知道"这是群还是单聊"才能选机制 2 还是机制 3
#: （`send_group` vs `send_oto`，见 `shared/dingtalk_api.py` 的机制表）。
#:
#: ⚠️ 键、TTL、哨兵 `user_id` 都在 `shared/dingtalk_api.py` 里定义 —— 因为**读的那一侧
#: 在另一个 Lambda**（那个函数 import 不到 `platforms/`）。这里只 re-export 常量给
#: 测试用；写入一律走 `sender.save_route()`，别在这里手写 `put_convo_session`：
#: 那个函数的 `user_id` 传空串是**静默 no-op**，而投递侧根本拿不到 `user_id`。
DTROUTE_KIND = dingtalk_api.ROUTE_KIND
DTROUTE_TTL_SECONDS = dingtalk_api.ROUTE_TTL_SECONDS


class DingtalkCaps(Caps):
    """具体的钉钉能力实现。**无状态**：所有会话状态在 DDB（`imchat#` / `convosess#`）。

    ⚠️ 十条能力**一条都不能少**：`router.dispatch` 找不到方法时会退化到 `chat`
    （把「/案例 关闭 12345」当成一个普通问题问 agent），那是最难发现的一类静默降级。
    """

    # ---- 传输 ----
    def reply_text(self, msg: ImMessage, text: str) -> None:
        """一句话回复。标题走通用的「回答」，正文照样过降级 + 截断。"""
        self._send(dt_messages.text_message(text, msg.locale))

    def _send(self, pair: tuple[str, str], *, at_user: str = "") -> bool:
        """`dt_messages.*` 回的 `(title, text)` → 真的发出去。

        与 Slack 的 `_post` 对位，但**没有 thread 这一层**：钉钉群里没有 thread，
        所有回复都落在主时间线上。群里回复时 @ 回原提问人 —— 那是这个平台上唯一
        的"这条是回给你的"信号（`sender.reply` 里只有机制 1 支持 @，兜底时会静默
        丢掉 @，理由见 `sender.reply` 的 docstring）。

        **不抛**：`sender.reply` 自己已经吞了异常并记了日志，返回 False。调用方靠
        返回值决定要不要兜底，而不是靠 try/except —— 与另外两家"卡片发失败退纯
        文本"的结构一致。
        """
        title, text = pair
        return sender.reply(title=title, text=text, at_user=at_user)

    def _at(self, msg: ImMessage) -> str:
        """群里要 @ 回提问人；私聊不 @（钉钉私聊里 @ 会显示成一段多余的高亮文字）。"""
        return "" if msg.is_direct else (msg.user_id or "")

    # ---- 十个能力 ----
    def help(self, msg: ImMessage) -> None:
        """`/help` 命令菜单。

        与飞书那份的差别只有一处：**不需要**"纯文本不渲染 markdown"那道保险 ——
        钉钉的 markdown 消息本来就渲染 `**粗体**` 和反引号，而这里发的**就是**
        markdown 消息（`dt_messages` 只有这一种形态）。所以也没有"卡片发失败退纯
        文本"的分支：退无可退，两者是同一条路。
        """
        from core import multicloud, nl_router
        # `multicloud.help_row_key` = 「这一行发哪份文案」，见 `core/multicloud.py`。
        rows = "\n".join(
            i18n.t(multicloud.help_row_key(feat), msg.locale)
            for feat, _en, _zh in nl_router.HELP_COMMANDS
        )
        body = (f"{i18n.t('help.intro', msg.locale)}\n\n{rows}\n\n"
                f"{i18n.t('help.footer', msg.locale)}")
        self._send(dt_messages.titled_text(
            i18n.t("help.title", msg.locale), body, msg.locale))

    def language(self, msg: ImMessage, arg: str, lang: str = "") -> None:
        """`/language [zh|en|auto]` 或 NL「切换到英文」。

        ⚠️ 命令类回复必须走 `_pre_locale` 口径（用户偏好 + 锁，**不自动检测**）——
        `language en` 本身是纯 ASCII，自动检测会在 `set_user_pref` 之前把这个私聊
        锁成 en。worker 构造 `ImMessage` 时已经把 `msg.locale` 设成 `_pre_locale`，
        这里直接用。与另外两家**逐行一致**。
        """
        target = i18n.normalize_locale(lang or arg)
        if not msg.user_id:
            self.reply_text(msg, i18n.t("main.failed_user_id", msg.locale))
            return
        if not target or target not in ("zh", "en", "auto"):
            cur, source = locale_resolver.resolve(user_id=msg.user_id,
                                                  platform=PLATFORM, text="")
            name = i18n.locale_name(cur, cur)
            key = "lang.current.user" if source == "user" else "lang.current.auto"
            self.reply_text(msg, i18n.t(key, cur, name=name) + "\n"
                            + i18n.t("lang.usage", cur))
            return
        if target == "auto":
            ok = locale_resolver.set_user_pref(msg.user_id, "auto",
                                               platform=PLATFORM)
            self.reply_text(msg, i18n.t("lang.unset" if ok else "lang.unset_failed",
                                        msg.locale))
            return
        ok = locale_resolver.set_user_pref(msg.user_id, target, platform=PLATFORM)
        name = i18n.locale_name(target, target)
        self.reply_text(msg, i18n.t("lang.set.user" if ok else "lang.set_failed",
                                    target if ok else msg.locale, name=name))

    def model(self, msg: ImMessage, model_arg: str) -> None:
        """`/model [<别名>|list|default]` —— 这个会话用哪个模型（0 token）。

        只对 `/agent notiops` 那条路生效（DevOps Agent 直连用的是客户自己的
        agent，模型不由我们选）。与另外两家逐行一致。
        """
        arg = (model_arg or "").strip().lower()
        is_dm = msg.is_direct
        if not arg:
            alias, source = llm_pref_resolver.resolve(
                platform=PLATFORM, chat_id=msg.chat_id, user_id=msg.user_id,
                is_dm=is_dm)
            entry = model_catalog.get(alias)
            text = (i18n.t("model.current", msg.locale, label=entry.label,
                           source=source)
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
            self.reply_text(msg, i18n.t(
                "model.unknown", msg.locale, alias=arg,
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
        """`/agent [notiops|devops|starops|default]` —— 这个会话的对话由谁答（0 token）。

        与另外两家**同一份**逻辑和文案（`platforms.common.pref_commands`）；三边
        各写一遍必然漂移，见那个模块的文件头。
        """
        self.reply_text(msg, pref_commands.agent_reply(msg, arg,
                                                        platform=PLATFORM))

    def web(self, msg: ImMessage, arg: str) -> None:
        """`/web [on|off]` —— 联网搜索开关（0 token）。只对 NotiOps Agent 生效。"""
        self.reply_text(msg, pref_commands.web_reply(msg, arg, platform=PLATFORM))

    def account(self, msg: ImMessage, arg: str) -> None:
        """`/account [<12 位账号 id>|list|default]` —— 这个会话在问哪个 AWS 账号。

        与另外两家同一份逻辑和文案。0 token；**上车 / 启用 / 停用只在 Web 做**，
        这里只选。
        """
        self.reply_text(msg, pref_commands.account_reply(msg, arg,
                                                          platform=PLATFORM))

    def investigate(self, msg: ImMessage, text: str) -> None:
        """发起一次深度调查 —— **0 token**：只 create_backlog_task，NotiOps 侧不
        总结、不翻译、不做任何 LLM 调用。`source` 打成 `notiops-im-dingtalk`
        方便 backlog 溯源。

        ── 与另外两家的两处硬差异 ──────────────────────────────────────────
        1. **不落 `imtask#`**（§4.4）。那一行的唯一消费者是
           `platforms/common/lambda_progress.py` —— 它每分钟拿 `message_id` 去
           **PATCH 那张卡**。钉钉发完消息只拿到 `{"errcode": 0}`，没有消息 id，
           落一行只会让进度 Lambda 对着空 `message_id` 重试 30 分钟。所以这里
           不落，并且在 ack 里**明说这条不会自动刷新**
           （`im.dt.investigate.no_live_progress`）——「说清做不到」和「假装做到」
           的差别就是这一句。
        2. **额外落一行 `dtroute` 会话路由**。`link_im_investigation` 只存
           `chat_id`，而报告投递（几十分钟后，另一个 Lambda）必须知道这是群还是
           单聊才能选机制 2/3。见 `DTROUTE_KIND` 的注释。

        `link_im_investigation` 照样写 —— 报告要靠 `incident#` / `task#` 两行才
        知道发回哪个会话。`root_message_id` 给空串：那个函数只要求
        `chat_id and (incident_id or task_id)`，空的 root 它是容忍的。
        """
        from core import devops_agent
        q = (text or "").strip()
        if not q:
            self.reply_text(msg, i18n.t("im.investigate.need_text", msg.locale))
            return
        title = q.splitlines()[0][:80]
        result = devops_agent.start_investigation(
            title=title, description=q,
            account_id=msg.account_id or None,
            source="notiops-im-dingtalk",
        )
        if result.get("error"):
            self.reply_text(msg, str(result.get("message") or result["error"]))
            return

        home = result.get("console_home") or ""
        deep = result.get("console_url") or ""
        # 落款带上账号 —— 深度调查是**真的去查那个账号**的资源，查错了账号的报告
        # 看起来跟查对了一模一样。用 `result["account_id"]`（已解析成具体 12 位）
        # 而不是 `msg.account_id`（空 = 部署账号）。
        body = (i18n.t("ack.dispatched", msg.locale)
                + i18n.t("im.dt.investigate.no_live_progress", msg.locale))
        ok = self._send(dt_messages.dispatch_text(
            body, msg.locale, deep_link=deep, home=home, state="dispatched",
            account=str(result.get("account_id") or ""),
            deploy=im_accounts.deploy_account_id()), at_user=self._at(msg))
        if not ok:
            # 消息没发出去 —— 调查**已经起了**，所以不能当作失败返回。退成一句
            # 纯文本把链接和这个事实一起说清楚（也是最后一次机会：路由行照样落，
            # 报告投递不依赖这条 ack）。
            line = i18n.t("ack.dispatched", msg.locale)
            if deep:
                line += f"\n{i18n.t('progress.btn.open_link', msg.locale)}: {deep}"
            elif home:
                line += f"\n{i18n.t('progress.btn.open_home', msg.locale)}: {home}"
            self.reply_text(msg, line)

        incident_id = f"{PLATFORM}-{msg.event_id}"
        # 报告回写路由 —— `report_handler` 只认 `incident#` / `task#`
        # （见 `core.ddb_state.link_im_investigation` 的 docstring）。三个平台
        # 必须对等，少一边就是那个平台的报告永远投不回来。
        ddb_state.link_im_investigation(
            incident_id, result.get("task_id") or "",
            platform=PLATFORM, chat_id=msg.chat_id, root_message_id="",
            locale=msg.locale, user_id=msg.user_id, raw_text=q[:1000],
            # 报告消息上的账号横幅靠这一行。
            account_id=msg.account_id or "",
        )
        # 群 / 单聊的投递机制选择（见 DTROUTE_KIND）。`robot_code` 一并存下来 ——
        # `send_group` / `send_oto` 缺它时回落到 `app_key`，正常情况下等价，但
        # 客户在开放平台改过 robotCode 时就不等价了。
        s = sender.current()
        sender.save_route(
            conversation_id=s.conversation_id or msg.chat_id,
            is_direct=bool(s.is_direct),
            staff_id=s.staff_id or msg.user_id,
            robot_code=s.robot_code)

    def investigate_status(self, msg: ImMessage, ref_id: str,
                           explicit: bool = True) -> None:
        """回读一条**已有**调查的进展 —— 0 token，**不新建任何东西**。

        与另外两家同一份共享逻辑（`platforms/common/inv_status.py`），但有一处
        钉钉专属的收窄：**永不调 `inv_status.attach()`，一律按 `mode="static"`
        渲染**。

        为什么：`attach()` 要一个 `message_id` 才能让进度 Lambda 去 PATCH 那张
        卡，钉钉给不出（§4.4）。而 `mode="attach"` 的正文里有一句
        `im.investigate.status.attached`（"这张卡会自动刷新"）—— 在钉钉上那是
        **一句假话**。所以状态一律 static，并追加一句
        `im.dt.investigate.snapshot_only` 把"这是快照、再问一次就是最新的"说明白。

        `explicit=False`（路由是**猜**的，那串 id 可能只是个 volume id / 请求 id）
        且查不到时落回 `chat` —— 与另外两家逐字一致，同样 0 token。
        """
        from platforms.common import inv_status
        info = inv_status.describe(ref_id, account_id=msg.account_id or "",
                                   locale=msg.locale)
        if not info.get("ok"):
            if not explicit:
                logger.info("caps.investigate_status: guessed ref missed → chat")
                self.chat(msg, msg.text)
                return
            if info.get("error") == "not_found":
                text = i18n.t("im.investigate.status.not_found", msg.locale,
                              ref=ref_id)
            else:
                text = str(info.get("message") or info.get("error") or "")
            self._send(dt_messages.titled_text(
                i18n.t("im.investigate.status.title", msg.locale), text,
                msg.locale), at_user=self._at(msg))
            return

        deep = str(info.get("console_url") or "")
        home = str(info.get("console_home") or "")
        body = (inv_status.body(info, msg.locale, mode="static")
                + i18n.t("im.dt.investigate.snapshot_only", msg.locale))
        self._send(dt_messages.dispatch_text(
            body, msg.locale, deep_link=deep, home=home,
            state=inv_status.card_state(info),
            # 回读的是**那条调查**查的账号，不是本轮会话当前选的账号 —— 用户完全
            # 可能已经 `/account` 切走了。
            account=str(info.get("account_id") or msg.account_id or ""),
            deploy=im_accounts.deploy_account_id()), at_user=self._at(msg))

    def case(self, msg: ImMessage, command: str, case_id: str, text: str) -> None:
        """案例路径 —— 默认配置下唯一会烧 NotiOps 侧 token 的能力（`case_analyze`
        与开案例时的主题摘要）。

        走 `platforms/dingtalk/case_text.py`（纯文本形态），**不是**旧的
        `platforms/dingtalk/app/case_flow.py`（那是 Fargate + SDK handler 形态，
        走的是 `bot-stack.ts` 那条老路，两条路的入参形状完全不同）。

        与另外两家的差异见 `case_text.py` 的文件头：没有表单弹窗、没有账号下拉，
        危险动作（开案例 / 关案例）靠**用户回一句「确认」**二次确认。那一句
        「确认」由 `lambda_worker` 在 `router.dispatch` **之前**用
        `case_text.maybe_handle_confirm(...)` 截住，不走这个方法。

        多账号（与另外两家同口径）：这条路**跟着 `msg.account_id` 走**
        （空 = 部署账号）。写操作要求目标账号的角色带 support 写权限（成员账号
        模板参数 `EnableSupportCaseWrite`，默认开）；不具备时 `core.support_logic`
        给出确切原因，**绝不回落到部署账号**。
        """
        # 空字符串 = 部署账号，全线统一口径（见 `platforms/common/im_types.py`）。
        account_id = msg.account_id or ""
        try:
            if command == "case_view":
                case_text.start_view(case_id, locale=msg.locale,
                                     account_id=account_id)
            elif command == "case_reply":
                case_text.start_reply(case_id, text or "", locale=msg.locale,
                                      account_id=account_id)
            elif command == "case_resolve":
                case_text.start_resolve(case_id, chat_id=msg.chat_id,
                                        user_id=msg.user_id, locale=msg.locale,
                                        account_id=account_id)
            elif command == "case_analyze":
                case_text.start_analyze(case_id, locale=msg.locale,
                                        account_id=account_id)
            elif command == "case_create":
                case_text.start_create(text or "", chat_id=msg.chat_id,
                                       user_id=msg.user_id, locale=msg.locale,
                                       account_id=account_id,
                                       operator_name=msg.user_name)
            else:
                case_text.start_list(status_filter="recent", locale=msg.locale,
                                     account_id=account_id)
        except Exception as e:                    # noqa: BLE001
            logger.exception("caps.case failed kind=%s: %s", command,
                             type(e).__name__)
            self.reply_text(msg, i18n.t("main.case_flow_crashed", msg.locale,
                                        kind=type(e).__name__))

    def chat(self, msg: ImMessage, text: str) -> None:
        """对话问答 —— **两条路，同一批消息**。由 `/agent` 开关（`core.im_prefs`）
        决定：

          · `devops`（默认）→ `core.devops_chat.run_devops_chat`，客户 DevOps
            Agent 直答，**NotiOps 侧 0 token**。多轮上下文靠
            `imchat#<conversation_id>` 存的 `execution_id`（按会话归属，不按用户
            拆 —— §15）。
          · `notiops` → `core.agent_chat.run_agent_chat`，走我们的 AgentCore
            runtime，**会消耗 token**。多轮上下文靠 `imagent#<conversation_id>`
            存的 runtime session id（6 小时轮换）。
          · `starops` → `core.starops_chat.run_starops_chat`，直连**阿里云**
            STAROps 数字员工，**NotiOps 侧 0 token**（烧客户自己的阿里云 AI
            额度）。多轮上下文靠 `imsochat#<conversation_id>` 存的 `thread_id`。
            2026-09-14 加。

        ⚠️ 与另外两家**逐段对齐**（分流只影响 ack 文案 / 读哪一行会话 / 调哪个
        runner / 消息上 `agent=` `sources=` `usage=` `employee=` 那几个参数），
        排队、心跳、终版、截断落报告、兜底全部共用下面这一份。

        ── 唯一的结构差异：进度是**追加**不是刷新 ──────────────────────────
        另外两家先发一条消息拿到 id，再按节流**改同一条**（`LiveCard`）。钉钉拿不
        到消息 id（§4.4），所以 `platforms/dingtalk/append_progress.py` 把语义换成
        "再发一条新消息"，代价是刷屏 ⇒ 非终态消息**最多 2 条**（t≈120s / t≈360s，
        硬上限）。三处由此而来的写法差异：

        1. `ack` 传的是 `im.dt.progress.still_running`（"还在查"）而**不是**
           `ack_variants.ack_body(...)`。ack 那条已经由本方法发出去了，进度消息
           必须说**别的话** —— `AppendProgress` 的"正文没变就不发"闸门会把内容
           相同的第二条直接吞掉，于是"进度"变成"永远没有进度"。
        2. 排队转正**不是原地改**，是 `flush(force=True)` 追加一条（`force` 跳过
           时间闸门，**不跳过** 2 条的预算闸门）。
        3. 终版永远发得出去（`finish` 走 `state="final"`，不受两道闸门约束），所以
           这里没有"改不动了就再发一条新消息"那一层兜底 —— 只保留最后的纯文本兜底。
        4. **文案和标题也得跟着换口径**（2026-09-08 现网反馈）。追加式意味着第一条
           消息**发出去就定格**，于是另外两家那套"卡片会自己更新"的说辞在这里是假话：
           · 开场话走 `ack_variants.ack_body(..., platform=PLATFORM)`，尾句变成
             "过程和结论会另发新消息"（`im.chat.ack_tail.append`）；排队同理走
             `ack_variants.queued_body(..., platform=PLATFORM)`。
           · 首条消息的标题用**不带秒表**的那一份（`elapsed=0` 时选
             `dt_messages._ANSWER_TITLES_NOCLOCK`）—— 一个永远停在「已用时 0 秒」的
             计时器不是"信息少"，是假信息。后续追加的那几条带真实秒数，照常显示。

        ── 一个会话同时只跑一个 ────────────────────────────────────────────
        多轮上下文是"一个会话一个 `execution_id`"，并发两个问题会共用同一个
        execution 互相拖死。进来先抢会话租约（`platforms/common/chat_lease.py`）：
        抢不到就把首条消息发成「排队中」，轮到自己再追加一条「思考中」继续答；
        等不到也明说，不静默丢问题。
        """
        # 第 -1 步：这个会话现在由谁答。**在发第一条消息之前**读 —— ack 文案和
        # 落款都要它。
        agent, _src = im_prefs.resolve_agent(
            platform=PLATFORM, chat_id=msg.chat_id, user_id=msg.user_id,
            is_dm=msg.is_direct)
        notiops = agent == im_prefs.AGENT_NOTIOPS
        starops = agent == im_prefs.AGENT_STAROPS

        # 落款里的账号那一段（多账号）—— **这一轮只解析一次**（org 模式下底下是
        # STS，而落款会被每条追加消息渲染一次）。与另外两家同一个做法。
        # ⚠️ STAROps 那条路上这个值**不会显示**（换成数字员工 ID，见 `im_footer`
        #    的 🔴），但照旧解析：互斥判断只在 `im_footer` 一处。
        deploy_acct = im_accounts.deploy_account_id()

        # 会话行按路分段（`imchat#` / `imsochat#`；notiops 那条不读这一行）。用闭包
        # 读是因为「排队转正」之后还要重读一次 —— 与另外两家同一个做法。
        def _load_session() -> dict:
            if starops:
                return ddb_state.get_im_starops_session(PLATFORM,
                                                        msg.chat_id) or {}
            return ddb_state.get_im_chat_session(PLATFORM, msg.chat_id) or {}

        session = _load_session()
        question = (text or msg.text or "").strip()

        # 来源 / 用量 / 数字员工 ID 要等这一轮跑完才知道，而 `AppendProgress` 的
        # `render` 回调只透传五个固定 kwarg。所以放一个可变盒子让闭包读。
        extra: dict = {"sources": [], "usage": {}, "employee": ""}

        # 第 0 步：抢这个会话的"轮次"。`acquire()` 不阻塞 —— 先把消息发出去再等，
        # 否则用户在排队的那几分钟里一个字都看不到。
        turn = chat_lease.Turn(PLATFORM, msg.chat_id, owner=msg.event_id)
        queued = not turn.acquire()

        # 第 1 步：立刻应答。开场话从 5 条里按这条消息的 id 选一条（见
        # `platforms/common/ack_variants.py`）：同一条消息永远同一条文案。
        #
        # ⚠️ `platform=PLATFORM` 是**必须**的，不是可选的礼貌：默认那一档的文案说
        # "过程和结论会更新到这张卡片上"，在钉钉上是假话（改不了已发出的消息）。
        # 漏传不会报错，只会让用户盯着第一条消息等它变 —— 2026-09-08 现网就是这样。
        state = "queued" if queued else "thinking"
        ack_seed = msg.message_id or msg.event_id
        ack = (ack_variants.queued_body(msg.locale, platform=PLATFORM) if queued
               else ack_variants.ack_body(ack_seed, msg.locale, agent,
                                          platform=PLATFORM))
        at = self._at(msg)
        self._send(dt_messages.answer_text(
            ack, msg.locale, state=state, elapsed=0, agent=agent,
            account=msg.account_id, deploy=deploy_acct), at_user=at)

        # 进度器。`ack` 传"还在查"而不是上面那句开场话（见 docstring 第 1 点）。
        # 进度消息**不 @** —— @ 一次是提醒，每条都 @ 是骚扰。
        live = append_progress.AppendProgress(
            ack=i18n.t("im.dt.progress.still_running", msg.locale),
            state=state,
            render=lambda **kw: dt_messages.answer_text(
                kw["body"], msg.locale,
                steps=kw["steps"], state=kw["state"], elapsed=kw["elapsed"],
                report_url=kw["report_url"],
                agent=agent, sources=extra["sources"], usage=extra["usage"],
                account=msg.account_id, deploy=deploy_acct,
                employee=extra["employee"]),
            send=self._send,
        )
        # 心跳是**唯一**的驱动源：`emit` 在这个平台上只累积不发送（见
        # `append_progress` 文件头），而 agent 可以整整 5 分钟不吐一个事件。
        live.start_heartbeat()

        try:
            # 第 2 步：排队的话先等到自己的轮次。等不到**必须明说**。
            if queued and not turn.wait():
                timeout_text = i18n.t("im.chat.queue_timeout", msg.locale)
                if not live.finish(timeout_text):
                    self.reply_text(msg, timeout_text)
                return
            if queued:
                # 排队转正：追加一条「思考中」（钉钉改不了已发的消息）。
                live.set_ack(i18n.t("im.dt.progress.still_running", msg.locale))
                live.set_state("thinking")
                live.flush(force=True)
                # 前一轮很可能刚写过 execution_id / thread_id，重新读一遍才是最新的
                # 上下文。
                session = _load_session()

            # 第 3 步：跑。
            if notiops:
                # 短别名直接透传（`core.llm_config` 认短别名），不在这里翻译 ——
                # 见 core/model_catalog.py 顶部关于两套别名命名空间的说明。
                model_alias, _msrc = llm_pref_resolver.resolve(
                    platform=PLATFORM, chat_id=msg.chat_id, user_id=msg.user_id,
                    is_dm=msg.is_direct)
                result = agent_chat.run_agent_chat(
                    question, locale=msg.locale,
                    session_id=ddb_state.im_agent_session_id(PLATFORM,
                                                             msg.chat_id),
                    model=model_alias,
                    account_id=msg.account_id or None,
                    # 可见账号闸门（§4.2）。与另外两家**逐字一致** —— 少传一边就
                    # 等于那一个平台上闸门是全开的（`build_payload` 的默认值是 `"*"`）。
                    allowed_accounts=im_accounts.allowed_accounts(),
                    web_search=im_prefs.resolve_web(
                        platform=PLATFORM, chat_id=msg.chat_id,
                        user_id=msg.user_id, is_dm=msg.is_direct)[0],
                    emit=live.emit,
                )
                # 填盒子 —— 必须在 `finish()` 之前。
                extra["sources"] = result.get("sources") or []
                extra["usage"] = result.get("usage") or {}
                # 这条路**不写 `imchat#`**：会话连续性由 `imagent#` 那行负责。
            elif starops:
                # 直连阿里云 STAROps 数字员工。**NotiOps 侧 0 token**，但这一轮烧的
                # 是客户自己的阿里云 AI 额度。与另外两家**逐字对齐**（含两条 ⚠️）。
                # ⚠️ `text` 是**位置参数** —— 与 `run_devops_chat(text=…)` 刻意不同。
                result = starops_chat.run_starops_chat(
                    question, locale=msg.locale,
                    session=session,
                    emit=live.emit,
                )
                # 落款上「哪个数字员工答的」那一位（必须在 `finish()` 之前填）。
                extra["employee"] = str(result.get("employee") or "")
                # ⚠️ 判断顺序与下面 devops 那支**相反**：`run_starops_chat` 在
                #    `reset_session=True` 时**照样带着那个已经死掉的 thread_id
                #    返回**。先判 thread_id 会把死 thread 存回去、下一轮原样再坏一次。
                sess = result.get("session") or {}
                if result.get("reset_session"):
                    ddb_state.clear_im_starops_session(PLATFORM, msg.chat_id)
                elif sess.get("thread_id"):
                    ddb_state.put_im_starops_session(PLATFORM, msg.chat_id, sess)
            else:
                result = devops_chat.run_devops_chat(
                    text=question, locale=msg.locale,
                    account_id=msg.account_id or None,
                    session=session,
                    emit=live.emit,
                )
                sess = result.get("session") or {}
                if sess.get("execution_id"):
                    ddb_state.put_im_chat_session(PLATFORM, msg.chat_id, sess)
                elif result.get("reset_session"):
                    # 上游把这条 execution 弄死了（`responseFailed` / 只回心跳）。必须
                    # **删掉**会话行：留着它下一轮会原样复用、原样再坏一次。三家一致。
                    ddb_state.clear_im_chat_session(PLATFORM, msg.chat_id)
        finally:
            # 租约必须在 finally 里放；心跳线程同理（Lambda 返回后冻结环境，
            # 没 join 的 daemon 线程是下一次调用的幽灵）。`finish()` 会再 close 一次。
            turn.release()
            live.close()

        reply = (result.get("reply") or "").strip()
        if not reply:
            reply = i18n.t("main.usage_hint", msg.locale)

        # 正文装不下（钉钉 `msgParam` 硬上限 15000 **字节**）→ 全文落网页报告，正文
        # 换成"开头 + 截断提示 + 报告链接"。与另外两家同一个 helper、同一个位置：
        # 只在拿到终版时做一次（见 platforms/common/long_answer.py 文件头）。
        body, report_url = long_answer.fit(reply, msg.locale,
                                           limit=dt_messages.MAX_BODY,
                                           question=question)

        # 第 4 步：终版（`state="final"`，不受追加预算约束）。终版要 @ 回提问人 ——
        # 群里可能已经隔了几分钟和十几条别人的消息。
        if live.finish(body, report_url=report_url):
            return
        # 连终版都发不出去（会话地址失效 / 一直被拒）→ 答案本身不能丢，退成最朴素
        # 的一条消息。⚠️ 落款走 `usage_footer` 而**不是**硬编码
        # `router.direct_no_token`：走模型那条路上那句是假的。
        self._send(dt_messages.text_message(
            body + "\n\n" + dt_messages.usage_footer(
                msg.locale, agent=agent, usage=extra["usage"],
                account=msg.account_id, deploy=deploy_acct,
                employee=extra["employee"]),
            msg.locale), at_user=at)


__all__ = ["DTROUTE_KIND", "PLATFORM", "DingtalkCaps"]
