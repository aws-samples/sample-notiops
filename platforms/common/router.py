"""确定性分发（IM 重构 / M0）—— 0 token，双语，三平台共用。

这一层做且只做一件事：**把一条规范化消息路到七个能力之一**，然后调用平台的 `Caps` 实现。
路由判据全部来自 `core.nl_router`（正则；不过模型、不烧 token），本模块只负责：

  · 把 `Route` 映射成 `Caps` 的方法调用（含参数整形）；
  · 兜底到 `chat`（DevOps Agent 直连问答，也是 0 token）；
  · prompt-injection 二道门（§8.3：只读由 DevOps Agent 侧保证，NotiOps 只留这一道）；
  · 把"派发前该拒的"拒掉，并且**永不抛**——任何异常都变成一句人话回复。

为什么不在这里做 LLM 分类：全部七条路径里只有「案例」需要抽 display_id / 标题 / 正文，
那一步在平台的 `caps.case()` 里做（唯一保留的 LLM 调用）。其余六条纯确定性。见 §8.1。
"""
from __future__ import annotations

import logging
import re

from core import nl_router
from platforms.common import quoted_context
from platforms.common.im_types import KINDS, ImMessage

logger = logging.getLogger(__name__)

# 会把文本原样交给 agent 的三条能力 —— **只有**这三条需要"被回复的历史消息"当背景
# （B8 第 7 项）。`help` / `language` / `model` / `skills` 是确定性回复，拼进去没有意义；
# `investigate_status` 是回读一条已有调查（0 token，一个字都不发给 agent）。
QUOTE_AWARE_KINDS: frozenset[str] = frozenset({"chat", "investigate", "case"})


# ---------------------------------------------------------------------------
# prompt-injection / 变更请求 二道门
# ---------------------------------------------------------------------------
# §8.3：重构之后 IM 默认路径没有我们的模型，"只读"由 DevOps Agent 侧保证。NotiOps 侧
# **只保留这一条正则**作为二道门 —— 挡住那种明显在指使 agent 做变更 / 越权的措辞，
# 让它连传输都不发生（省一次往返，也让日志里能看到我们拦了什么）。
#
# ⚠️ 口径与 platforms/feishu/app/main.py 的 `_STRONG_CHANGE_RE` 一致：**只认强变更措辞**，
# 绝不扩到「改一下」「调整」这种日常说法 —— 误杀一次正常提问的代价远大于漏放一次
# （漏放的那次 DevOps Agent 自己会拒）。
_STRONG_CHANGE_RE = re.compile(
    # zh —— 明确的破坏性动词 + 明确的资源名词
    # 「删除这个实例」/「删掉整个 bucket」—— 允许中间夹指示词/量词/形容词 0-8 字符
    r"(?:删除|删掉|销毁|摧毁|清空|格式化|终止|停掉|关停|重启|重置|回滚|下线|摘掉)"
    r"[^\s]{0,10}?"
    r"(?:实例|集群|数据库|表|桶|bucket|卷|快照|镜像|函数|服务|节点|队列|流|"
    r"用户|角色|策略|密钥|证书|域名|记录|堆栈|stack)"
    r"|(?:强制|立刻|马上|直接)\s*(?:删除|终止|停掉|重启|回滚)"
    # en —— verb + (name-noun | AWS resource id like i-0123 / vol-...)
    r"|\b(?:delete|destroy|terminate|shutdown|shut\s+down|wipe|purge|drop|"
    r"truncate|reboot|restart|rollback|revoke|detach|deregister)\s+"
    # 允许零到两个中间修饰词（"the ec2 instance" / "my prod cluster"）
    r"(?:(?:the|my|all|an?|this|that|these|those|prod|dev|staging|ec2|rds|"
    r"eks|ecs|s3|redis|sqs|sns|old|new)\s+){0,3}"
    r"(?:instance|cluster|database|db|table|bucket|volume|snapshot|ami|image|"
    r"function|service|node|queue|stream|user|role|policy|key|certificate|"
    r"domain|record|stack|(?:i|vol|vpc|sg|snap|subnet|nat)-[0-9a-f]{6,17})"
    # prompt injection —— 试图改写我们给 agent 的约束
    r"|忽略(?:上面|以上|之前)(?:的)?(?:所有)?(?:指令|要求|限制)"
    r"|无视(?:上面|以上|之前)(?:的)?(?:指令|限制)"
    r"|你现在(?:是|扮演)"
    r"|\bignore\s+(?:all\s+)?(?:the\s+)?(?:above|previous|prior)\s+"
    r"(?:instructions?|rules?|constraints?)\b"
    r"|\bdisregard\s+(?:all\s+)?(?:previous|prior)\b"
    r"|\byou\s+are\s+now\s+(?:a|an|in)\b"
    r"|\bdeveloper\s+mode\b",
    re.IGNORECASE,
)


def looks_strongly_change(text: str) -> bool:
    """True = 这条消息明显在要求做变更 / 在做 prompt injection。

    唯一的 NotiOps 侧只读防线（DevOps Agent 侧是第一道，也是权威的那道）。
    """
    return bool(_STRONG_CHANGE_RE.search(text or ""))


# ---------------------------------------------------------------------------
# 分发
# ---------------------------------------------------------------------------
def decide(text: str) -> tuple[str, dict]:
    """把一段用户原话变成 ``(kind, kwargs)``。**纯函数、0 token、永不抛。**

    ``kind`` 一定在 :data:`platforms.common.im_types.KINDS` 里；不认识的一律 "chat"
    （DevOps Agent 直连问答 —— 也是 0 token，所以兜底不会带来成本）。
    """
    s = (text or "").strip()
    if not s:
        return "chat", {"text": ""}
    try:
        route = nl_router.classify(s)
    except Exception as e:                    # 正则不该抛，但兜底一次比事后查线上便宜
        logger.warning("router.decide classify failed: %s", type(e).__name__)
        return "chat", {"text": s}
    if not route or route.kind not in KINDS:
        return "chat", {"text": s}
    kind = route.kind
    if kind == "language":
        return kind, {"arg": route.arg, "lang": route.lang}
    if kind == "model":
        return kind, {"model_arg": route.model_arg}
    if kind == "skills":
        return kind, {"arg": route.arg}
    if kind == "investigate":
        # command form 的 arg 是 `/调查` 后面那段；NL form 的 arg 是整句原话。
        # 两者都可能为空（光打 `/调查`）→ 交给平台层弹表单让用户补。
        return kind, {"text": route.arg or s}
    if kind == "investigate_status":
        # 「问已有那条调查」——0 token，不新建任何东西。`explicit` 决定查不到时的行为：
        # True（用户明确写了引用）→ 照实说查不到；False（我们从裸 uuid 猜的）→ 静默
        # 落回 chat。判据在 `core.nl_router.parse_investigation_ref`。
        return kind, {"ref_id": route.ref_id, "explicit": route.ref_explicit}
    if kind == "case":
        return kind, {"command": route.case_command, "case_id": route.case_id,
                      "text": route.arg or s}
    return kind, {}


def dispatch(msg: ImMessage, caps, *, refusal_text: str = "") -> str:
    """决策 + 调用平台能力。返回实际走到的 ``kind``（日志/测试用）。

    `refusal_text` 是被二道门拦下时要回的那句话（由调用方按 locale 从 i18n 取，
    这一层不碰文案）。空串 = 不拦（仅用于单测）。
    """
    kind, kwargs = decide(msg.text)

    # 二道门：只拦"要求做变更 / prompt injection"，且**不拦命令类**——`/model`、`/help`
    # 这些根本不会到 agent 那边去，拦了只是无端制造困惑。
    # ⚠️ `investigate_status` 也**不拦**：它是回读一条已有调查（GetBacklogTask + 读
    # journal），一个字都不发给 agent。而"问状态"的句子里出现"重启了实例"这种复述式
    # 措辞是常见的（『查一下那次重启实例的调查到哪步了』），拦了就是误杀。它内部那条
    # 落回 `chat` 的降级分支确实会发给 agent —— 那条路上 agent 侧的只读约束仍然是
    # 权威防线（口径见本文件头 §8.3）。
    if kind in ("investigate", "chat") and refusal_text and looks_strongly_change(msg.text):
        logger.info("router: refused change-like request platform=%s kind=%s",
                    msg.platform, kind)
        try:
            caps.reply_text(msg, refusal_text)
        except Exception as e:
            logger.warning("router: refusal reply failed: %s", type(e).__name__)
        return "refused"

    # 被回复的历史消息 → 拼进要发给 agent 的那段文本（B8 第 7 项）。
    # **在二道门之后**做：门只看用户原话，引用一条写着「删掉那个实例」的告警来问
    # "这是怎么回事"是正常用法，不能因为引用的内容触发拦截。
    if kind in QUOTE_AWARE_KINDS and msg.quoted_text and "text" in kwargs:
        kwargs["text"] = quoted_context.augment(
            kwargs["text"], msg.quoted_text, author=msg.quoted_author)

    fn = getattr(caps, kind, None)
    if not callable(fn):
        # 平台还没实现这条能力（M3/M4 分阶段落地时会出现）→ 退化到 chat，而不是静默丢掉。
        logger.warning("router: caps.%s not implemented on %s — falling back to chat",
                       kind, msg.platform)
        # 退化到 chat 也要带上引用的历史消息 —— 否则"平台少实现一条能力"会顺手把
        # 用户引用的上下文也吞掉，表现回到 B8 第 7 项那个 bug。
        kind, kwargs, fn = "chat", {
            "text": quoted_context.augment(msg.text, msg.quoted_text,
                                           author=msg.quoted_author),
        }, getattr(caps, "chat", None)
        if not callable(fn):
            return "unhandled"
    try:
        fn(msg, **kwargs)
    except Exception as e:
        # 平台能力炸了：日志留类型名（不留原始 message，见 docs/LOGGING_STANDARD.md），
        # 用户侧至少收到一句可操作的提示，绝不静默。
        logger.exception("router: caps.%s failed on %s: %s",
                         kind, msg.platform, type(e).__name__)
        raise
    return kind
