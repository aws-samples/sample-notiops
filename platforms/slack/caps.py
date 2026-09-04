"""Slack 端 `Caps` 实现（IM 重构 / M3）—— 每一条能力"发什么、怎么发"。

`platforms/feishu/caps.py` 的 Slack 对位实现。**决策不在这里**（那是
`platforms.common.router.dispatch` 的活儿）；这里只做**渲染 + 发送**。

── 与飞书那份的四处结构性差异 ──────────────────────────────────────────────────
 1. **要自己拿 WebClient**。飞书 SDK 的 client 是模块级单例（`feishu_utils` 里建好的）；
    Slack 的 `WebClient` 需要 bot token。**绝对不能** `from platforms.slack.app import main`
    去借它的 `app.client`：那个模块在 import 期就 `App(token=...)` 并做 `auth_test()`，
    凭证读失败时进 `_wait_for_credentials()` —— 一个 `while True: time.sleep(3600)`
    的死循环。在 Fargate 上那是"等人填凭证"，在 Lambda 上是**必然超时**。
    这里复用 `app/progress_sender.py::_get_client` 的做法：自己从 Secrets Manager 读、
    自己缓存。
 2. **消息 id 是 `ts`**，thread 用 `thread_ts`。`ImMessage.message_id` 存本条 ts，
    `root_message_id` 存 thread_ts（不在 thread 里时等于本条 ts）。
 3. **`case_flow` 的每个入口都要显式传 `client`**（飞书那份是模块内部拿 client），
    且参数顺序是 `(client, channel_id, thread_ts, ...)` —— 见 case_flow 文件头。
 4. **默认语言是 en**（飞书是 zh）。这里不硬编码：`msg.locale` 由 worker 用
    `locale_resolver` 解析好；`DEFAULT_LOCALE` 环境变量决定兜底值。

只有 `case` 这一条走 LLM（`analyze_intent` 抽 display_id / 标题 / 正文），
其余六条全是确定性渲染 —— 这是"压 token"这条决策的落点（§8.1）。
"""
from __future__ import annotations

import logging
import os

from core import ddb_state
from core import devops_chat
from core import i18n
from core import llm_pref_resolver
from core import locale_resolver
from core import model_catalog
from platforms.common import ack_variants, chat_lease, live_card, long_answer
from platforms.common.im_types import Caps, ImMessage
from platforms.slack import im_blocks

logger = logging.getLogger(__name__)

PLATFORM = "slack"

_client = None


def get_client():
    """缓存的 `WebClient`。

    与 `app/progress_sender.py::_get_client` 同源同口径（同一个 secret、同一个环境
    变量名 `SLACK_BOT_TOKEN_ARN`，值可以是 secret 名也可以是 ARN）。
    **fail-fast**：没有 token 就抛 —— 静默退化成"什么都不发"会让用户以为 bot 挂了，
    而日志里只有一条 warning。
    """
    global _client
    if _client is not None:
        return _client
    # ⚠️ `slack_sdk` 的 import 放在**校验之后**（下面），不要提到这里。提前 import 的话，
    # 层没建好（ModuleNotFoundError）会盖掉"token 没填"这个真正的根因 —— 读 secret、
    # 校验前缀这两件事根本不需要 SDK。
    import boto3
    ref = os.environ.get("SLACK_BOT_TOKEN_ARN", "").strip()
    if not ref:
        raise RuntimeError("SLACK_BOT_TOKEN_ARN not set")
    sm = boto3.client("secretsmanager")
    token = sm.get_secret_value(SecretId=ref)["SecretString"].strip()
    # ⚠️ "没填" 的真实形态**不是空串**：CDK 的 `new secretsmanager.Secret(...)` 不给
    # secretStringValue 时，Secrets Manager 会**随机生成**一个值。所以客户没填时这里
    # 拿到的是一串随机字符 —— `if not token` 抓不到，会一路带到 Slack API 才以
    # `invalid_auth` 报出来（离根因很远，日志里看着像"Slack 拒绝了我们"）。
    # 前缀校验是唯一能在本地判定的信号：bot token 必然是 `xoxb-`，user token `xoxp-`。
    # 异常文案保持纯英文：它只进 CloudWatch，永远不会渲染给 IM 用户，
    # 所以不走 i18n（i18n 表只装用户可见文案）。**不打印 token 本身，连长度也不打**
    # （docs/LOGGING_STANDARD.md）。
    if not token:
        raise RuntimeError("slack bot token secret is empty (fill it in the "
                           "Web Chat admin console -> Notification settings)")
    if not token.startswith(("xoxb-", "xoxp-")):
        raise RuntimeError(
            "slack bot token secret does not look like a Slack token "
            "(expected an 'xoxb-' prefix). This is what an unfilled secret looks "
            "like: CDK creates it with a randomly generated value, not an empty "
            "string. Put the real bot token from the Slack app's "
            "'OAuth & Permissions' page into the secret."
        )
    from slack_sdk import WebClient
    _client = WebClient(token=token)
    return _client


def fetch_message_text(channel_id: str, ts: str) -> tuple[str, str]:
    """读一条**已有消息**的正文，返回 ``(正文, 发件人)``（B8 第 7 项）。

    Slack 没有"引用某条消息"的事件字段 —— 用户"针对历史消息提问"的形态就是**在那条
    消息的 thread 里回复**，所以要的正是 thread 的父消息：`conversations.replies` 的
    第一条就是它（`limit=1` 只取父消息，不把整条 thread 拉回来）。

    用的是现有 scope（`channels:history` / `groups:history` / `im:history`；群 DM 还要
    `mpim:history`）。缺 scope 时 SDK 抛 `SlackApiError`，由
    `platforms.common.quoted_context.enrich` 捕获并**明确告诉用户**，不静默。
    """
    from platforms.slack import msg_text
    resp = get_client().conversations_replies(channel=channel_id, ts=ts, limit=1)
    messages = (resp.get("messages") if resp else None) or []
    if not messages:
        return "", ""
    return msg_text.parse_message(messages[0]), msg_text.sender_of(messages[0])


class SlackCaps(Caps):
    """具体的 Slack 能力实现。**无状态**：所有会话状态在 DDB（`imchat#` / `imtask#`）。"""

    # ---- 传输 ----
    def reply_text(self, msg: ImMessage, text: str) -> None:
        self._post(msg, text=text)

    def _post(self, msg: ImMessage, *, text: str = "",
              blocks_out: list[dict] | None = None):
        """`chat.postMessage` 收口。返回 SlackResponse（调用方取 ts）。

        ── thread 规则：与 `platforms/slack/app/main.py::on_app_mention` **逐字对齐** ──
        · **私聊（channel_type=="im"）不开 thread**：DM 本身就是 1:1 私密会话，把每条
          回复塞进 thread 只是多一次点击 —— 所以 `is_direct` 时**不传** thread_ts。
        · 群里**一律** thread 在用户那条消息上（或延续用户已经在的 thread），主时间线
          保持干净。
        改这条 = 改线上 UX；而且群里的 follow-up 免 @ 机制（`ddb_state.is_bot_thread`）
        正建立在"群消息必有 thread_ts"这个前提上。

        ⚠️ `text=` 必须给：Slack 用它做通知栏 / 无障碍 fallback，缺了手机推送会显示成
        「This content can't be displayed」。
        """
        kwargs = {
            "channel": msg.chat_id,
            "text": text or im_blocks.fallback_text(blocks_out or []),
        }
        if not msg.is_direct:
            kwargs["thread_ts"] = msg.root_message_id or msg.message_id or None
        if blocks_out:
            kwargs["blocks"] = blocks_out
        # thread_ts=None 会被 slack_sdk 直接丢掉（不会发成字符串 "None"）
        return get_client().chat_postMessage(**kwargs)

    # ---- 七个能力 ----
    def help(self, msg: ImMessage) -> None:
        """`/help` 命令菜单 —— 发 blocks，且正文必须过 `blocks.to_mrkdwn()`。

        ⚠️ 2026-09-03：共享 i18n 里的粗体是 `**x**`（飞书/钉钉口径），Slack mrkdwn
        只认单星号，直接发过去星号会原样显示（同一次改动也修了飞书那边的"纯文本不渲染
        markdown"）。标题走 header block，正文走 section。
        """
        from core import nl_router
        from platforms.slack.app import blocks
        rows = "\n".join(
            i18n.t(f"help.row.{feat}", msg.locale)
            for feat, _en, _zh in nl_router.HELP_COMMANDS
        )
        body = (f"{i18n.t('help.intro', msg.locale)}\n\n{rows}\n\n"
                f"{i18n.t('help.footer', msg.locale)}")
        out = im_blocks.text_blocks(blocks.to_mrkdwn(body), msg.locale,
                                    title_key="help.title")
        try:
            self._post(msg, blocks_out=out)
        except Exception as e:                        # noqa: BLE001
            # blocks 发不出去 → 菜单本身不能丢，退纯文本（格式会退化，但看得见优先）。
            logger.error("caps.help: postMessage(blocks) failed: %s", type(e).__name__)
            self.reply_text(msg, f"{i18n.t('help.title', msg.locale)}\n\n"
                                 f"{blocks.to_mrkdwn(body)}")

    def language(self, msg: ImMessage, arg: str, lang: str = "") -> None:
        """`/language [zh|en|auto]` 或 NL「切换到英文」。

        ⚠️ 命令类回复必须走 `_pre_locale` 口径（用户偏好 + 锁，**不自动检测**）——
        `language en` 本身是纯 ASCII，自动检测会在 `set_user_pref` 之前把这个私聊锁成 en。
        worker 构造 `ImMessage` 时已经把 `msg.locale` 设成 `_pre_locale`，这里直接用。
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

    def skills(self, msg: ImMessage, arg: str) -> None:
        """`/skills` —— 一句确定性的"去 Web 端"指路（0 token）。

        与飞书同口径、同一次改动（理由见 `platforms/feishu/caps.py::skills`）：
        2026-09-03 起 skills 不在 `/help` 菜单里，IM 侧也不再回那句自指的
        "请用 `/skills create …`"。路由保留，否则 `/skills` 会掉进 `chat`。
        """
        self.reply_text(msg, i18n.t("skill.im_web_only", msg.locale))

    def investigate(self, msg: ImMessage, text: str) -> None:
        """发起一次深度调查 —— **0 token**：只 create_backlog_task，NotiOps 侧不总结、
        不翻译、不做任何 LLM 调用。`source` 打成 `notiops-im-slack` 方便 backlog 溯源。

        落 `imtask#` 时 `message_id` 必须是**我们刚发的这条**消息的 ts —— 进度 Lambda
        每分钟 `chat.update` 的就是它。落成用户那条消息的 ts 会让 update 去改用户自己
        发的消息（Slack 直接 `cant_update_message`，而且会连续失败 30 分钟）。
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
            source="notiops-im-slack",
        )
        if result.get("error"):
            self.reply_text(msg, str(result.get("message") or result["error"]))
            return

        home = result.get("console_home") or ""
        deep = result.get("console_url") or ""
        body = i18n.t("ack.dispatched", msg.locale)
        blocks_out = im_blocks.dispatch_blocks(body, msg.locale, deep_link=deep,
                                               home=home, state="dispatched")
        try:
            resp = self._post(msg, blocks_out=blocks_out)
        except Exception as e:                    # noqa: BLE001
            logger.error("caps.investigate: postMessage failed: %s", type(e).__name__)
            resp = None
        card_ts = im_blocks.ts_of(resp) if resp is not None else ""
        if not card_ts:
            # 消息没发出去 → 没有 update 落点。**不落 imtask#**（否则进度 Lambda 会对着
            # 一个空 ts 重试 30 分钟），改用文本把链接和这个事实一起告诉用户。
            line = body
            if deep:
                line += f"\n{i18n.t('progress.btn.open_link', msg.locale)}: {deep}"
            elif home:
                line += f"\n{i18n.t('progress.btn.open_home', msg.locale)}: {home}"
            line += "\n\n" + i18n.t("im.investigate.card_failed", msg.locale)
            self.reply_text(msg, line)
            return

        incident_id = f"slack-{msg.event_id}"
        ddb_state.put_im_task(
            incident_id,
            platform=PLATFORM, chat_id=msg.chat_id, message_id=card_ts,
            locale=msg.locale, account_id=result.get("account_id") or "",
            task_id=result.get("task_id") or "",
            execution_id=result.get("execution_id") or "",
            agent_space_id=result.get("agent_space_id") or "",
            user_id=msg.user_id, title=title,
            console_url=deep, console_home=home,
        )
        # 第二行路由 —— 最终报告卡走 EventBridge → notiops-devops-callback →
        # report_handler，它只认 `incident#` / `task#`（见 ddb_state 里那段注释）。
        # 与飞书侧同一处改动，两个平台必须对等。
        ddb_state.link_im_investigation(
            incident_id, result.get("task_id") or "",
            platform=PLATFORM, chat_id=msg.chat_id, root_message_id=card_ts,
            locale=msg.locale, user_id=msg.user_id, raw_text=q[:1000],
        )

    def investigate_status(self, msg: ImMessage, ref_id: str,
                           explicit: bool = True) -> None:
        """回读一条**已有**调查的进展 —— 0 token，**不新建任何东西**。

        与 `platforms/feishu/caps.py::investigate_status` 同一份共享逻辑
        （`platforms/common/inv_status.py`），只有渲染/发送不同。修的 bug、
        `explicit` 的含义、"查不到时绝不顺手新起一条"这三点都见飞书那份的说明。

        ⚠️ 正文要过 `blocks.to_mrkdwn()`：共享 i18n 里的粗体是 `**x**`（飞书口径），
        Slack mrkdwn 只认单星号 —— 不转的话用户看到的是一串裸星号。
        """
        from platforms.common import inv_status
        from platforms.slack.app import blocks
        info = inv_status.describe(ref_id, account_id=msg.account_id or "",
                                   locale=msg.locale)
        if not info.get("ok"):
            if not explicit:
                # 猜错了（那串 uuid 大概是个 volume id / 请求 id）—— 当普通问题问
                # DevOps Agent，同样 0 token。
                logger.info("caps.investigate_status: guessed ref missed → chat")
                self.chat(msg, msg.text)
                return
            if info.get("error") == "not_found":
                text = i18n.t("im.investigate.status.not_found", msg.locale,
                              ref=ref_id)
            else:
                text = str(info.get("message") or info.get("error") or "")
            out = im_blocks.text_blocks(blocks.to_mrkdwn(text), msg.locale,
                                        title_key="im.investigate.status.title")
            try:
                self._post(msg, blocks_out=out)
            except Exception as e:                    # noqa: BLE001
                logger.error("caps.investigate_status: postMessage failed: %s",
                             type(e).__name__)
                self.reply_text(msg, text)
            return

        mode = inv_status.plan(info)
        deep = str(info.get("console_url") or "")
        home = str(info.get("console_home") or "")
        blocks_out = im_blocks.dispatch_blocks(
            blocks.to_mrkdwn(inv_status.body(info, msg.locale, mode=mode)),
            msg.locale, deep_link=deep, home=home,
            state=inv_status.card_state(info))
        try:
            resp = self._post(msg, blocks_out=blocks_out)
        except Exception as e:                        # noqa: BLE001
            logger.error("caps.investigate_status: postMessage failed: %s",
                         type(e).__name__)
            resp = None
        card_ts = im_blocks.ts_of(resp) if resp is not None else ""
        if not card_ts:
            # 没有 update 落点 → **不落 imtask#**，并且把"这里不会自动刷新"说清楚。
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
                              chat_id=msg.chat_id, message_id=card_ts,
                              locale=msg.locale, user_id=msg.user_id)

    def case(self, msg: ImMessage, command: str, case_id: str, text: str) -> None:
        """案例路径 —— **唯一保留 LLM 的能力**（`analyze_intent` 抽 display_id/标题/正文）。

        直接调 `platforms/slack/app/case_flow.py` 的现成实现（那 1300 行 Block Kit +
        modal 已经在线上跑了很久，重写只会引入回归）。注意参数顺序是
        `(client, channel_id, thread_ts, ...)`，且 `start_create` / `start_reply` 还要
        `user_id` —— 与飞书那份的入参形状不同，抄过来会静默错位。
        """
        from platforms.slack.app import case_flow
        client = get_client()
        # DM 不 thread（与 `_post` 和 main.py 同口径）。main.py 在 DM 分支里传的就是
        # `None`，case_flow 内部所有 `chat_postMessage(thread_ts=...)` 都吃 None。
        thread_ts = None if msg.is_direct else (msg.root_message_id or msg.message_id)
        try:
            if command == "case_view":
                case_flow.start_view(client, msg.chat_id, thread_ts, case_id,
                                     locale=msg.locale)
            elif command == "case_reply":
                case_flow.start_reply(client, msg.chat_id, thread_ts, case_id,
                                      text or "", msg.user_id, locale=msg.locale)
            elif command == "case_resolve":
                case_flow.start_resolve(client, msg.chat_id, thread_ts, case_id,
                                        locale=msg.locale)
            elif command == "case_analyze":
                case_flow.start_analyze(client, msg.chat_id, thread_ts, case_id,
                                        locale=msg.locale)
            elif command == "case_create":
                case_flow.start_create(client, msg.chat_id, text or "",
                                       msg.user_id, thread_ts, locale=msg.locale)
            else:
                case_flow.start_list(client, msg.chat_id, thread_ts,
                                     status_filter="recent", locale=msg.locale)
        except Exception as e:                    # noqa: BLE001
            logger.exception("caps.case failed kind=%s: %s", command, type(e).__name__)
            self.reply_text(msg, i18n.t("main.case_flow_crashed", msg.locale,
                                        kind=type(e).__name__))

    def chat(self, msg: ImMessage, text: str) -> None:
        """DevOps 对话直连 —— **NotiOps 侧 0 token**（`core.devops_chat`）。

        多轮上下文靠 `imchat#<channel_id>` 存的 `execution_id`（按 channel 归属，
        不按用户拆 —— §15）。

        答案发 blocks 而不是纯文本：要有状态标题（排队中/思考中/答完 + 计时）、过程行、
        正文超长时的「查看完整报告」外链 —— 纯文本这三样一样都做不到。
        ⚠️ 2026-09-03 起**没有**默认的「升级成深度调查」/「开案例」按钮了（原
        §8.1.1）—— 与飞书同一处改动，理由见 `platforms/feishu/im_cards.answer_card`。

        ── 「先应答，再边想边看」（2026-09-02，与飞书同一处改动）──────────────────
        M1/M3 首版是"跑完再发消息"；一个复杂问题能跑几分钟（现网实测 347 秒），期间
        用户侧完全静默，看起来像 bot 挂了。现在先发一条「思考中」消息拿到 `ts`，再把
        `LiveCard.emit` 传进 `run_devops_chat` 按节流 `chat.update` 同一条消息，最后
        `finish()` 刷终版。节流策略与失败停手逻辑见 `platforms/common/live_card.py`。
        终版正文超过 `im_blocks.MAX_BODY` 时先过 `long_answer.fit()`（全文落网页报告
        + 明确的截断提示），与飞书同一份逻辑 —— 不许静默切掉。

        ⚠️ `chat.update` 必须带 `text=`（fallback），否则手机推送显示成
        「This content can't be displayed」—— 与 `_post` / `lambda_progress` 同口径。

        ── 一个会话同时只跑一个（2026-09-02，与飞书同一处改动）────────────────────
        多轮上下文是"一个 channel 一个 `execution_id`"，并发两个问题会共用同一个
        execution 互相拖死。进来先抢会话租约（`platforms/common/chat_lease.py`）：
        抢不到就把首条消息发成「排队中」，轮到自己**就地**转成「思考中」继续答；
        等不到也明说，不静默丢问题。
        """
        session = ddb_state.get_im_chat_session(PLATFORM, msg.chat_id) or {}
        question = (text or msg.text or "").strip()

        # 第 0 步：抢这个会话的"轮次"。`acquire()` 不阻塞 —— 先把消息发出去再等，
        # 否则用户在排队的那几分钟里一个字都看不到。
        turn = chat_lease.Turn(PLATFORM, msg.chat_id, owner=msg.event_id)
        queued = not turn.acquire()

        # 第 1 步：立刻应答（非终态不挂按钮）。
        state = "queued" if queued else "thinking"
        # 开场话从 5 条里按这条消息的 id 选一条（见 platforms/common/ack_variants.py）：
        # 同一条消息永远同一条文案，所以下面「排队转正」那次 set_ack 换的是 state，
        # 不是说法 —— 用户不会看到卡片自己改口。
        ack_seed = msg.message_id or msg.event_id
        ack = (i18n.t("im.chat.queued_body", msg.locale) if queued
               else ack_variants.ack_body(ack_seed, msg.locale))
        try:
            resp = self._post(msg, blocks_out=im_blocks.answer_blocks(
                ack, msg.locale, state=state, elapsed=0))
        except Exception as e:                    # noqa: BLE001
            logger.error("caps.chat: ack postMessage failed: %s", type(e).__name__)
            resp = None
        card_ts = im_blocks.ts_of(resp) if resp is not None else ""
        live = None
        if card_ts:
            def _update(payload, _ts=card_ts):
                get_client().chat_update(
                    channel=msg.chat_id, ts=_ts,
                    text=im_blocks.fallback_text(payload), blocks=payload)

            live = live_card.LiveCard(
                ack=ack, state=state,
                render=lambda **kw: im_blocks.answer_blocks(
                    kw["body"], msg.locale,
                    steps=kw["steps"], state=kw["state"], elapsed=kw["elapsed"],
                    report_url=kw["report_url"]),
                update=_update,
            )
            # 心跳：agent 可以整整 5 分钟不吐一个事件（现网 cd0f6745），只靠 emit 驱动
            # 的节流刷新会让消息定格在「正在连接…」。排队期间更是全程没有 emit。
            live.start_heartbeat()

        try:
            # 第 2 步：排队的话先等到自己的轮次。等不到**必须明说**。
            if queued and not turn.wait():
                timeout_text = i18n.t("im.chat.queue_timeout", msg.locale)
                if live is None or not live.finish(timeout_text):
                    self.reply_text(msg, timeout_text)
                return
            if queued:
                # 排队转正：就地把这条消息变成「思考中」（不新发一条）。
                if live is not None:
                    live.set_ack(ack_variants.ack_body(ack_seed, msg.locale))
                    live.set_state("thinking")
                    live.flush(force=True)
                # 前一轮很可能刚写过 execution_id，重新读一遍才是最新的上下文。
                session = ddb_state.get_im_chat_session(PLATFORM, msg.chat_id) or {}

            # 第 3 步：跑，并把过程实时刷回那条消息。
            result = devops_chat.run_devops_chat(
                text=question, locale=msg.locale,
                account_id=msg.account_id or None,
                session=session,
                emit=(live.emit if live is not None else None),
            )
            sess = result.get("session") or {}
            if sess.get("execution_id"):
                ddb_state.put_im_chat_session(PLATFORM, msg.chat_id, sess)
        finally:
            # 租约必须在 finally 里放；心跳线程同理（Lambda 返回后冻结环境，
            # 没 join 的 daemon 线程是下一次调用的幽灵）。`finish()` 会再 close 一次。
            turn.release()
            if live is not None:
                live.close()

        reply = (result.get("reply") or "").strip()
        if not reply:
            reply = i18n.t("main.usage_hint", msg.locale)

        # 正文装不下（Slack section 2900，超限是**整条消息 400**）→ 全文落网页报告，
        # 正文换成"开头 + 截断提示 + 报告链接"。与飞书同一个 helper、同一个位置：
        # 只在拿到终版时做一次（见 platforms/common/long_answer.py 文件头）。
        body, report_url = long_answer.fit(reply, msg.locale,
                                           limit=im_blocks.MAX_BODY,
                                           question=question)

        # 第 3 步：终版。成功 = 那条消息已经是最终答案（标题回到「回答」、
        # 超长时挂上「查看完整报告」）。
        if live is not None and live.finish(body, report_url=report_url):
            return
        # 首条没发出去 / 这条已经改不动了 → 再发一条新消息；还不行才退纯文本。
        blocks_out = im_blocks.answer_blocks(body, msg.locale,
                                             report_url=report_url)
        try:
            resp = self._post(msg, blocks_out=blocks_out)
        except Exception as e:                    # noqa: BLE001
            logger.error("caps.chat: final postMessage failed: %s", type(e).__name__)
            resp = None
        if resp is None or not im_blocks.ts_of(resp):
            # blocks 发失败 → 答案本身不能丢，退成文本（丢的只是消息外观：状态标题 /
            # 过程行 / 报告按钮；报告链接在 `body` 的截断提示里，不依赖按钮）。
            self.reply_text(msg, body + "\n\n"
                            + i18n.t("router.direct_no_token", msg.locale))
