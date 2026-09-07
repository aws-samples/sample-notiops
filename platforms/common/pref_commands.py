"""`/agent`、`/web`、`/account` 三条开关命令的**回复文本** —— 两个平台共用这一份。

为什么单独一个模块：这几条命令**没有任何平台差异**（都是"读/写一行 DDB 偏好 + 回一句
确定性文本"），而 `platforms/feishu/caps.py` 与 `platforms/slack/caps.py` 各写一遍的下场
在这个仓库里已经反复出现过 —— 一边改了措辞/多了一个别名，另一边没改，客户在两个 IM 上
看到不一样的行为。所以这里只返回**字符串**，发送仍归各自的 `caps.reply_text`
（飞书 `reply_text` / Slack `chat.postMessage`），两个平台各一行调用，靠构造对齐。

**本模块 0 token**：一次 `get_item` / `put_item`（`/account` 的列表与切换另加一次注册表
GSI1 Query 和一次 STS），不碰任何模型。

── 三个开关的语义（详见 `core/im_prefs.py`）────────────────────────────────────
  · `agent`  ：`devops`（默认，直连客户自己的 DevOps Agent，NotiOps 侧 0 token）
               / `notiops`（走模型的 NotiOps Agent，**会烧 token**）；
  · `web`    ：联网搜索开关，**只对 `agent=notiops` 生效**（直连那条路上联不联网由
               客户自己那套 agent 决定，我们说不上话）；
  · `account`：这个会话在问哪个 AWS 账号（默认 = 部署账号）。**上车 / 启用 / 停用只在
               Web 做**，这里只"选"，且每次都拿注册表校验（`core/im_accounts.py`）。

⚠️ 切到 `notiops` 时必须把"要花钱"说出来（`agent.token_notice`），这不是客套：IM 是
被动入口，群里 @ 一下就是一轮，用户不该在不知情的前提下打开一个计费开关。
⚠️ `notiops` 切不过去时（这套部署没注入 `AGENT_RUNTIME_ARN`）必须**明确拒绝**，不许
写进偏好然后每一轮悄悄回落到 devops —— 那是「不许静默降级」正对着的那种坑。
⚠️ 同一条口径对 `/account`：单账号部署里切别的账号、或者切一个 Web 上没启用的账号，
一律**拒绝且不写偏好**。写进去的后果是每一轮 `im_accounts.resolve()` 都悄悄回落，
用户只会觉得"切了但没用"。
"""
from __future__ import annotations

from core import agent_chat, i18n, im_accounts, im_prefs, nl_router
from platforms.common.im_types import ImMessage

#: `/agent <arg>` 的入参别名。故意**只收 ASCII**：中文触发词在
#: `core/nl_router.py::_AGENT_RE` 那一层（`/智能体 notiops`），到这里 `arg` 已经是
#: 命令后面那半截。两个 agent 的名字本身不翻译（它们是产品名）。
_AGENT_ALIASES: dict[str, str] = {
    "devops": im_prefs.AGENT_DEVOPS,
    "dev": im_prefs.AGENT_DEVOPS,
    "devops-agent": im_prefs.AGENT_DEVOPS,
    "notiops": im_prefs.AGENT_NOTIOPS,
    "noti": im_prefs.AGENT_NOTIOPS,
    "notiops-agent": im_prefs.AGENT_NOTIOPS,
}

#: 「清除偏好，回到默认」。与 `/model default` 同一个词，用户不用记第二套。
_CLEAR_WORDS = frozenset({"default", "clear", "reset", "auto"})

#: `/web <arg>` 里 arg 的取值 —— **词表本身在 `core/nl_router.py`**（那一层要用同一份
#: 判断"裸词形式算不算命令"，见那边 `_switch_arg_ok` 的注释）。这里只是取用，别在这儿
#: 另起一份：`/web 开` 认得、路由那边不认，症状是同一句话在飞书能用在 Slack 不能用。
#: ⚠️ 中文用户不会打 `/web on`，他会打 `/web 开` —— 少了这几个词的症状是掉进
#: `web.usage`（"用法:…"），看起来像命令写错了，而不是我们没认。
_ON_WORDS = nl_router.WEB_ON_WORDS
_OFF_WORDS = nl_router.WEB_OFF_WORDS


def _agent_label(agent: str, locale: str) -> str:
    """agent → 带口径说明的显示名（「…(走模型 · 会消耗 token)」）。

    **不要**只回 "NotiOps Agent"：这两个名字对客户来说都只是名字，"花不花钱"才是他
    切换时真正要看的信息，所以标签自带那句。
    """
    key = ("agent.label.notiops" if agent == im_prefs.AGENT_NOTIOPS
           else "agent.label.devops")
    return i18n.t(key, locale)


def agent_reply(msg: ImMessage, arg: str, *, platform: str) -> str:
    """`/agent [notiops|devops|default]` 的回复文本。**永不抛**（写失败也只是回一句）。

    空参 = 查看当前值（与 `/model` 同口径：查看永远不改任何东西）。
    """
    a = (arg or "").strip().lower()
    is_dm = msg.is_direct
    where = {"platform": platform, "chat_id": msg.chat_id,
             "user_id": msg.user_id, "is_dm": is_dm}

    if not a:
        cur, source = im_prefs.resolve_agent(**where)
        return (i18n.t("agent.current", msg.locale,
                       label=_agent_label(cur, msg.locale), source=source)
                + "\n" + i18n.t("agent.usage", msg.locale))

    if a in _CLEAR_WORDS:
        ok = im_prefs.clear_agent(**where)
        return i18n.t("agent.cleared" if ok else "agent.set_failed", msg.locale)

    target = _AGENT_ALIASES.get(a)
    if target is None:
        return (i18n.t("agent.unknown", msg.locale, arg=a)
                + "\n" + i18n.t("agent.usage", msg.locale))

    # 这套部署没接 NotiOps Agent → **拒绝**，并且不写偏好。写进去的后果是每一轮都
    # 悄悄回落到 devops（`agent_chat.run_agent_chat` 会明确拒答），用户只会觉得
    # "切了但没用"，而日志在另一个函数里。
    if target == im_prefs.AGENT_NOTIOPS and not agent_chat.configured():
        return i18n.t("agent.not_configured", msg.locale)

    if not im_prefs.set_agent(target, **where):
        return i18n.t("agent.set_failed", msg.locale)

    out = i18n.t("agent.set_dm" if is_dm else "agent.set_chat", msg.locale,
                 label=_agent_label(target, msg.locale))
    if target == im_prefs.AGENT_NOTIOPS:
        out += "\n" + i18n.t("agent.token_notice", msg.locale)
    return out


def web_reply(msg: ImMessage, arg: str, *, platform: str) -> str:
    """`/web [on|off]` 的回复文本。**永不抛**。

    空参 = 查看当前值。当前 agent 是 `devops` 时（默认），无论查看还是设置都会补一句
    「这个开关只对 NotiOps Agent 生效」—— 否则用户开了联网、答案却毫无变化，而原因
    （这条路是直连、联网由他自己那套 agent 决定）在界面上完全看不出来。
    """
    a = (arg or "").strip().lower()
    is_dm = msg.is_direct
    where = {"platform": platform, "chat_id": msg.chat_id,
             "user_id": msg.user_id, "is_dm": is_dm}
    cur_agent, _ = im_prefs.resolve_agent(**where)
    noop_hint = ("\n" + i18n.t("web.devops_noop", msg.locale)
                 if cur_agent != im_prefs.AGENT_NOTIOPS else "")

    if not a:
        enabled, source = im_prefs.resolve_web(**where)
        state = i18n.t("web.on" if enabled else "web.off", msg.locale)
        return (i18n.t("web.current", msg.locale, state=state, source=source)
                + "\n" + i18n.t("web.usage", msg.locale) + noop_hint)

    if a in _ON_WORDS:
        want = True
    elif a in _OFF_WORDS:
        want = False
    else:
        # 认不出来就只回用法，**不猜**：猜错的两个方向都不对称（猜成 on 是悄悄
        # 打开一个会把查询发出去的能力，猜成 off 是用户以为开了却没开）。
        return i18n.t("web.usage", msg.locale)

    if not im_prefs.set_web(want, **where):
        return i18n.t("web.set_failed", msg.locale)
    state = i18n.t("web.on" if want else "web.off", msg.locale)
    return (i18n.t("web.set_dm" if is_dm else "web.set_chat", msg.locale,
                   state=state) + noop_hint)


# ---------------------------------------------------------------------------
# /account
# ---------------------------------------------------------------------------
def _account_rows(locale: str, *, deploy: str, locked: bool) -> list[str]:
    """「可以问的账号」清单。部署账号永远排第一（它不在注册表里，见下）。

    ⚠️ 部署账号**不在**注册表里：`bff/web-chat/member_accounts.mjs::listMemberAccounts`
    有意把它排除（它"数据天然可见、没有 StackSet 实例可下线"，列进去只会让人误
    Offboard 它）。所以这一行必须我们自己补，不能指望 `list_selectable()` 带出来。
    """
    rows = ["· `{}` — {}".format(deploy, i18n.t("account.list_tag_deploy", locale))
            if deploy else "· " + i18n.t("account.list_tag_deploy", locale)]
    for it in im_accounts.list_selectable():
        acct = str(it.get("account_id") or "").strip()
        if not acct or acct == deploy:
            continue
        row = f"· `{acct}`"
        # Web 端登记时填的显示名（`account_name`）—— 有就带上，客户认名字不认 12 位数字。
        name = str(it.get("account_name") or "").strip()
        if name:
            row += f" — {name}"
        if locked:
            row += " — " + i18n.t("account.list_tag_locked", locale)
        rows.append(row)
    return rows


def _account_view(msg: ImMessage, *, where: dict) -> str:
    """`/account`（空参）与 `/account list` 的回复 —— **只读，什么都不改**。"""
    locale = msg.locale
    locked = im_accounts.is_locked()
    deploy = im_accounts.deploy_account_id()
    pref, source = im_prefs.resolve_account(**where)

    parts: list[str] = []
    # 先说"你上次选的那个失效了"，再说当前是什么 —— 顺序反过来的话用户先看到
    # "当前=部署账号"，会以为自己上次根本没切成功（§4.4）。
    if pref and im_accounts.is_stale(pref):
        parts.append(i18n.t("account.stale", locale, account=pref))
        pref = ""
    if pref:
        parts.append(i18n.t("account.current_selected", locale,
                            account=pref, source=source))
    else:
        parts.append(i18n.t("account.current_default", locale))

    rows = _account_rows(locale, deploy=deploy, locked=locked)
    if len(rows) <= 1:
        parts.append(i18n.t("account.list_empty", locale))
    else:
        parts.append(i18n.t("account.list_title", locale) + "\n" + "\n".join(rows))
    if locked:
        parts.append(i18n.t("account.locked_note", locale))
    parts.append(i18n.t("account.usage", locale))
    return "\n".join(parts)


def account_reply(msg: ImMessage, arg: str, *, platform: str) -> str:
    """`/account [<12 位账号 id>|list|default]` 的回复文本。**永不抛**。

    空参 / `list` = 查看 + 列出可选（只读）。12 位数字 = 切换。`default` = 回部署账号。

    ⚠️ 三条**拒绝**分支都在 `set_account` **之前**，而且都不写偏好：
      1. 单账号部署（`LOCKED_ACCOUNT_ID` 非空）切别的账号 → `account.locked_refused`；
      2. 目标不在 Web 已启用的清单里 → `account.not_enabled`；
      3. 目标就是部署账号本身 → 走 `clear_account`（**不是** `set_account`）。
    第 3 条容易被当成"多余的特例"删掉，删了的症状很隐蔽：部署账号不在注册表里，
    所以偏好写进去之后 `im_accounts.resolve()` 每轮都会把它当"未启用"丢掉，
    而 `/account` 又会把它显示成「已失效」—— 用户看到的是"切了部署账号反而报失效"。
    """
    a = (arg or "").strip().lower()
    is_dm = msg.is_direct
    where = {"platform": platform, "chat_id": msg.chat_id,
             "user_id": msg.user_id, "is_dm": is_dm}

    if not a or a in nl_router.ACCOUNT_LIST_WORDS:
        return _account_view(msg, where=where)

    if a in nl_router.ACCOUNT_CLEAR_WORDS:
        ok = im_prefs.clear_account(**where)
        return i18n.t("account.cleared" if ok else "account.set_failed", msg.locale)

    if not im_prefs.is_account_id(a):
        return (i18n.t("account.unknown", msg.locale, arg=a)
                + "\n" + i18n.t("account.usage", msg.locale))

    # 部署账号自己 = 回默认。**在闸门之前**判：单账号部署里 `/account <部署账号>`
    # 是一句完全合理的话，不该被 `account.locked_refused` 拒掉。
    # `locked_account_id()` 在单账号部署里就是部署账号且不需要 STS，所以两个都比一遍。
    if a in {im_accounts.deploy_account_id(), im_accounts.locked_account_id() or ""}:
        ok = im_prefs.clear_account(**where)
        return i18n.t("account.cleared" if ok else "account.set_failed", msg.locale)

    if im_accounts.is_locked():
        return (i18n.t("account.locked_refused", msg.locale) + "\n"
                + i18n.t("account.locked_note", msg.locale))

    if a not in im_accounts.selectable_ids():
        return i18n.t("account.not_enabled", msg.locale, account=a)

    if not im_prefs.set_account(a, **where):
        return i18n.t("account.set_failed", msg.locale)

    # 切成功就把「案例也跟着切」说清楚（2026-09-07 起案例支持跨账号，这句话从
    # "案例是个例外" 改成 "案例也跟着走"）。开工单是本产品唯一的**写**操作，
    # 落在哪个账号必须在切换那一刻就讲明白 —— 等工单开出来才发现落错账号就晚了。
    return (i18n.t("account.set_dm" if is_dm else "account.set_chat", msg.locale,
                   account=a)
            + "\n" + i18n.t("account.case_notice", msg.locale, account=a))


__all__ = ["account_reply", "agent_reply", "web_reply"]
