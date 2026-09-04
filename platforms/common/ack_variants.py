"""「收到了」这一下反馈的**花样** —— 表情池 + 开场文案池，按消息 id 确定性选取。

现网反馈（2026-09-03）：「每个问题都有一个表情回复 + 『NotiOps』文字；机制很好，
但文案生硬，希望改成随机或预设的几条，让客户有新鲜感。」

── 先说清一件事：那三个字不在我们手里 ─────────────────────────────────────────
用户在飞书里看到的 `😀 NotiOps` 里的 **「NotiOps」是平台渲染的机器人显示名**（表情
反应旁边显示的是"谁点的"），来自飞书开放平台 / Slack App 配置里的 bot 名称，
`platforms/common/quick_ack.py` 从来没有发过任何文字。想换那个词只能去开放平台改
应用名称 —— 改不了代码，代码里也**不该**为它造一个假象。

所以"有新鲜感"落在两处**真的是我们写的**文案上：

  1. **表情本身**（ingress，T+0.3s）—— 一直是同一个 `OnIt` / `eyes`；
  2. **「思考中」卡片的开场话**（worker，T+4~6s）—— `im.chat.ack_body.*`，
     这句每问一次就一字不差地重复一次，是"生硬"的主要来源。

── 为什么是"确定性"而不是 `random` ───────────────────────────────────────────
平台重试会让同一条消息**再走一遍** ingress。`reactions.add` 对「同一个用户 + 同一个
表情」是幂等的（Slack 直接返回 `already_reacted`，见 `quick_ack` 模块头），这份幂等
性**正是建立在"同一个表情"上的** —— 随机选就会在用户那条消息上贴出**第二个**表情，
把一个原本免费的幂等性亲手拆掉。所以用消息 id 做种子：同一条消息永远同一个表情。

顺带的好处：ingress 选表情、worker 选开场话，两边用**同一个种子**（消息 id），一次
问答的"语气"是一致的，而不是表情说 A、卡片说 B。

── 依赖纪律 ─────────────────────────────────────────────────────────────────
本模块被 **ingress** import（`quick_ack`），而 ingress 的 INIT 有 10s 硬上限
。所以模块级**只许 stdlib**；要 i18n 的
那个函数把 import 放在函数体里，ingress 永远不为它付钱。
"""
from __future__ import annotations

import hashlib
import os

#: 飞书 `reaction_type.emoji_type` 的键。
#:
#: ⚠️ **只有 `OnIt` 是现网实测过的**（2026-09-03 起一直在用）。后面几个来自飞书开放
#: 平台的「表情文案说明」表，但**没有在真实租户上逐个验证过**，而填错一个键的表现是
#: 静默的：一条 WARNING + 那次没有表情。所以 `quick_ack.feishu()` 对非默认键留了
#: **一次回落**（失败就用 `OnIt` 再发一次并打 WARNING）—— 这样"我记错了键名"的代价是
#: 一条日志，不是"用户那次没收到反馈"。验证过之后可以把回落逻辑简化，别提前简化。
FEISHU_EMOJI_POOL: tuple[str, ...] = ("OnIt", "Typing", "MUSCLE", "THUMBSUP", "DONE")

#: 飞书那个"一定能用"的兜底键 —— 回落目标，也是 pool 的第一项。
FEISHU_EMOJI_FALLBACK = "OnIt"

#: Slack `reactions.add` 的 `name`（不带冒号）。这几个都是 Slack 自带的标准短名，
#: 不依赖 workspace 自定义表情（自定义表情会 `invalid_name`）。
SLACK_EMOJI_POOL: tuple[str, ...] = (
    "eyes", "mag", "hourglass_flowing_sand", "zap", "brain")

SLACK_EMOJI_FALLBACK = "eyes"

#: 「思考中」卡片的开场文案池。**每一条都必须自带那句"不用重复发问"**：它不是客套，
#: 是这张卡唯一阻止用户重复发问的东西（重复发问会撞上 §3.22 的会话排队，把自己排到
#: 自己后面）。`tests/test_im_ack_variants.py` 用断言钉住这条不变量 —— 加新文案时
#: 漏了那句话，测试会挂，而不是等客户开始重复发问。
ACK_BODY_KEYS: tuple[str, ...] = (
    "im.chat.ack_body.1",
    "im.chat.ack_body.2",
    "im.chat.ack_body.3",
    "im.chat.ack_body.4",
    "im.chat.ack_body.5",
)


def _index(seed: str, n: int) -> int:
    """种子 → `[0, n)`。

    用 sha256 而不是内置 `hash()`：CPython 的 `hash(str)` 带**进程级随机盐**
    （PYTHONHASHSEED），同一条消息在 ingress 那个进程和 worker 那个进程里会算出不同
    的下标 —— 表情和开场话就对不上了，而且平台重试落到新容器上就会贴第二个表情。
    这正是这里不能用 `hash()` 的原因，不是风格偏好。
    """
    if n <= 0:
        raise ValueError("pool must not be empty")
    if not seed:
        return 0
    digest = hashlib.sha256(seed.encode("utf-8", "replace")).digest()
    return int.from_bytes(digest[:8], "big") % n


def _pinned(env_name: str) -> str:
    """客户显式钉了某个表情就不轮换。

    `IM_ACK_EMOJI_FEISHU` / `IM_ACK_EMOJI_SLACK` 在轮换之前就存在，语义是「换成自家
    习惯的那个」。轮换上线之后这个语义**不变**：设了就是钉死一个（这才是"换成那个"的
    意思），没设才轮换。悄悄把它降级成"池子里的一项"会让配过它的客户看到别的表情。
    """
    return os.environ.get(env_name, "").strip()


def feishu_emoji(seed: str) -> str:
    return _pinned("IM_ACK_EMOJI_FEISHU") or \
        FEISHU_EMOJI_POOL[_index(seed, len(FEISHU_EMOJI_POOL))]


def slack_emoji(seed: str) -> str:
    return _pinned("IM_ACK_EMOJI_SLACK") or \
        SLACK_EMOJI_POOL[_index(seed, len(SLACK_EMOJI_POOL))]


def ack_body_key(seed: str) -> str:
    """开场文案的 i18n key。选 key 而不是选文本，locale 由调用方决定。"""
    return ACK_BODY_KEYS[_index(seed, len(ACK_BODY_KEYS))]


def ack_body(seed: str, locale: str) -> str:
    """「思考中」卡片的开场话。

    ⚠️ `i18n` 的 import 在函数体里 —— 见模块头「依赖纪律」。ingress 只用表情那两个
    函数，不该为 i18n 那张大表付 INIT 时间。
    """
    from core import i18n
    return i18n.t(ack_body_key(seed), locale)
