"""规范化的 IM 事件 + 能力协议（IM 重构 / M0）。

这些类型是**平台适配层与决策层之间唯一的接口**。加字段的规矩：新字段一律给默认值，
否则三个平台的适配器要同时改（M3/M4 落地时必然漏一个）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class ImMessage:
    """一条已经规范化的入站文本消息。

    Attributes:
      platform: "feishu" | "slack" | "dingtalk"。
      event_id: 平台事件 id —— 幂等键。飞书是 UUID，Slack 用 message ts，钉钉用 msgId。
        ⚠️ 幂等去重发生在 **worker**，不在 ingress（ingress 异步投递完就立刻返回了，
        它不知道 worker 会不会真的跑起来）。见 §6.3。
      chat_id: 会话 id（群或私聊）。
      user_id: 发送者 id。
      text: 已经剥掉 @mention 的正文。
      raw_text: 未剥离的原文（写库 / 展示"原始消息"时用）。
      message_id: 这条消息本身的 id —— 回帖到同一个 thread 要用它。
      root_message_id: 所在 thread 的根消息 id（不在 thread 里则为空）。
      quoted_message_id: **被回复的那条历史消息**的 id（飞书 `parent_id`，Slack 的
        thread 父消息 ts）。不是回复则为空。
      quoted_text: 那条历史消息的正文 —— 平台层取回来填在这里。⚠️ **路由永远不看
        它**（只看 `text`）：历史消息是别人写的字，让它参与分类就能把意图带偏。
        它只在 `chat` / `investigate` / `case` 这三条会把文本交给 agent 的路径上被
        拼进 prompt，见 `platforms/common/quoted_context.py`。
      quoted_author: 那条历史消息的发件人 id（只用于给 agent 标一句 "from …"）。
      is_direct: 是否私聊（决定回帖用 thread 还是行内）。
      mentioned: 是否 @ 了 bot（群里必须 @ 才响应）。
      account_id: 目标 AWS 账号（**空 = 部署账号**，不是"未知"）。由平台的
        `lambda_worker` 在规范化时用 `core.im_accounts.resolve(...)` 填 —— 那一层已经
        把偏好拿去注册表校验过（Web 上停用了就回落到空），所以下游能力**不需要**再校验
        一次。
        ⚠️ `case` 那条路 2026-09-07 起也**跟着这个字段走**（原先有意忽略、只开在
        部署账号）。它是本产品唯一的**写**路径：目标账号的角色必须带 support 写权限
        （成员账号模板参数 `EnableSupportCaseWrite`，默认开），不具备时
        `core.support_logic` 报确切原因，**绝不回落到部署账号**替客户写另一个账号的
        工单。卡片/消息上会把账号号写出来（控制台的案例链接不带账号参数）。
      locale: 已解析好的 locale（"zh" / "en"）。⚠️ 命令类回复必须用 `_pre_locale`
        口径（只看用户偏好 + 锁，**不做自动检测**）—— `language en` 是纯 ASCII，
        自动检测会在 set_user_pref 之前就把这个私聊锁成 en。见 §8.1.4 #3。
    """
    platform: str
    event_id: str = ""
    chat_id: str = ""
    user_id: str = ""
    text: str = ""
    raw_text: str = ""
    message_id: str = ""
    root_message_id: str = ""
    is_direct: bool = True
    mentioned: bool = True
    account_id: str = ""
    locale: str = "zh"
    user_name: str = ""
    quoted_message_id: str = ""
    quoted_text: str = ""
    quoted_author: str = ""


@dataclass(frozen=True)
class ImAction:
    """一次卡片按钮回调（飞书 card.action.trigger / Slack block_actions / 钉钉 card）。"""
    platform: str
    action_tag: str = ""
    action_value: dict = field(default_factory=dict)
    chat_id: str = ""
    user_id: str = ""
    message_id: str = ""
    locale: str = "zh"
    account_id: str = ""
    form_values: dict = field(default_factory=dict)
    user_name: str = ""


@runtime_checkable
class Caps(Protocol):
    """十个能力 + 传输，由平台层实现。

    每个方法都**必须自己完成回复**（发文本或发卡片），返回值只用于日志 / 测试断言。
    这样决策层完全不碰传输，Slack 的 Block Kit 与飞书的 v2 card 各自演进不互相牵连。

    ⚠️ 会烧 NotiOps 侧 token 的只有两条路径（2026-09-06 校正，其余八条全是确定性渲染）：

      1. `case` —— 但**不是**在路由/抽参那一步（`display_id` / 标题 / 正文由
         `core.nl_router` 确定性抽出，`analyze_intent` 在活路径上已不再被调用）。
         花钱的是下游两处：`case_analyze` 的工单总结，和 `case_create` **提交表单**
         时的 `core.case_classifier`（整份服务目录进 prompt，全 IM 最贵的单次输入）。
      2. `chat` **且** `im_prefs.resolve_agent(...) == "notiops"` —— 走
         `core.agent_chat` 打 NotiOps Agent（模型 + 窄工具集）。默认值是
         `"devops"`（直连客户自己的 DevOps Agent，NotiOps 侧 0 token），用户要
         显式 `/agent notiops` 才切过去。见 `core/agent_chat.py` 头部注释。

    `agent` / `web` / `account` 这三条**本身**是 0 token 的开关（只读写一行 DDB 偏好；
    `account` 另加一次注册表 GSI1 Query，仍然一个模型都不碰）。

    `investigate_status` 与 `investigate` 的分工：前者**回读一条已有调查**（0 token，
    不新建任何东西），后者**新起一条**（付费）。分成两个能力而不是在 `investigate`
    里判，是因为"分不清"的代价是不对称的 —— 见 `core.nl_router.parse_investigation_ref`。
    """

    # ---- 传输 ----
    def reply_text(self, msg: ImMessage, text: str) -> None: ...

    # ---- 十个能力 ----
    def help(self, msg: ImMessage) -> None: ...

    def language(self, msg: ImMessage, arg: str, lang: str = "") -> None: ...

    def model(self, msg: ImMessage, model_arg: str) -> None: ...

    def agent(self, msg: ImMessage, arg: str) -> None: ...

    def web(self, msg: ImMessage, arg: str) -> None: ...

    def account(self, msg: ImMessage, arg: str) -> None: ...

    def investigate(self, msg: ImMessage, text: str) -> None: ...

    def investigate_status(self, msg: ImMessage, ref_id: str,
                           explicit: bool = True) -> None: ...

    def case(self, msg: ImMessage, command: str, case_id: str, text: str) -> None: ...

    def chat(self, msg: ImMessage, text: str) -> None: ...


# 决策层认识的能力名 —— 与 core.nl_router.Route.kind 一一对应，加一条 "chat" 兜底。
# 保持这份清单是**闭集**：worker 里 `getattr(caps, kind)` 之前先查它，避免一个畸形
# Route 变成任意方法调用。
#: ⚠️ `"skills"` 2026-09-06 从这里删掉 —— skill 能力完整地在 Web 端，IM 侧不再有入口
#: （详见 `core/nl_router.py` 文件末尾那段）。删的是**闭集里的一条**，所以万一别处漏了
#: 一个 `Route(kind="skills")`，worker 的白名单检查会把它挡在 `getattr` 之前而不是
#: 抛 AttributeError。
KINDS: frozenset[str] = frozenset({
    "help", "language", "model", "agent", "web", "account", "investigate",
    "investigate_status", "case", "chat",
})
