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

#: 「思考中」卡片的**开场句**池 —— 只管语气，不管"答案会出现在哪"。
#:
#: ⚠️ 那句"不用重复发问"不在这里，在下面的 :data:`ACK_TAIL_KEYS`。它不是客套，是唯一
#: 阻止用户重复发问的东西（重复发问会撞上 §3.22 的会话排队，把自己排到自己后面），
#: 所以 `tests/test_im_ack_variants.py` 钉的是 :func:`ack_body` **拼出来的整句**，
#: 不是单条 key —— 只看开场句永远看不到那句话。
ACK_BODY_KEYS: tuple[str, ...] = (
    "im.chat.ack_body.1",
    "im.chat.ack_body.2",
    "im.chat.ack_body.3",
    "im.chat.ack_body.4",
    "im.chat.ack_body.5",
)

#: 同一批文案的 NotiOps Agent 版本（`/agent notiops` 之后走的那条路）—— 只换了 agent
#: 的名字。**同一个种子在两套里选到同一个下标**，所以"这条消息的语气"仍然是一致的。
#:
#: 为什么要分两套而不是把名字含糊掉：默认那条路是"直连你自己的 DevOps Agent"（NotiOps
#: 侧 0 token），这条是"我们的 NotiOps Agent 在花你的 token"。名字一含糊，用户就分不清
#: 这一轮谁在答、花没花钱 —— 而这正是 `/agent` 这个开关存在的意义。
ACK_BODY_KEYS_NOTIOPS: tuple[str, ...] = (
    "im.chat.ack_body.notiops.1",
    "im.chat.ack_body.notiops.2",
    "im.chat.ack_body.notiops.3",
    "im.chat.ack_body.notiops.4",
    "im.chat.ack_body.notiops.5",
)

#: 第三套：`/agent starops`（阿里云 STAROps 数字员工，2026-09-14）。同一个种子在三套里
#: 选到同一个下标，所以"这条消息的语气"仍然一致。
#:
#: 这一套换掉的不只是名字，是**云**。前两套都在说 AWS，这条路问的是阿里云 —— 复用前两套
#: 里任何一条的下场：客户拿 AWS 的问题过来，ack 说得像 AWS 那条路，几分钟后拿到一句
#: "查不到"，然后把这归因成产品坏了。ack 是这一轮**唯一**的早期纠错窗口（真正的答案在
#: 几分钟之后），所以这五条里「阿里云」必须出现。
ACK_BODY_KEYS_STAROPS: tuple[str, ...] = (
    "im.chat.ack_body.starops.1",
    "im.chat.ack_body.starops.2",
    "im.chat.ack_body.starops.3",
    "im.chat.ack_body.starops.4",
    "im.chat.ack_body.starops.5",
)

#: agent → 那一套开场句。**用映射而不是 if/elif 链**（同 `pref_commands._AGENT_LABEL_KEYS`
#: 的理由）：if/elif 加第四个 agent 时的失败方式是"悄悄用 DevOps 那套文案"，一条报错都
#: 没有。`.get()` 的回落目标刻意仍是 devops 那套 —— 见 :func:`ack_body_key`。
#:
#: ⚠️ 键必须与 `core.im_prefs.AGENT_*` 的值逐字相等。这里写字面量是**依赖纪律**：本模块
#: 被 ingress import，模块级只许 stdlib，而 `core.im_prefs` 会拉进 boto3（见文件头）。
#: 对齐由 `tests/test_im_ack_variants.py` 一条断言盯着。
_ACK_BODY_SETS: dict[str, tuple[str, ...]] = {
    "devops": ACK_BODY_KEYS,
    "notiops": ACK_BODY_KEYS_NOTIOPS,
    "starops": ACK_BODY_KEYS_STAROPS,
}

#: **去处句** —— "过程和结论会出现在哪"，按平台的**刷新能力**分两种，不按平台数量分。
#:
#: 2026-09-08 现网反馈原话：钉钉上那句「过程和结论会一起更新在这张卡片上」是**假的**。
#: 钉钉的 webhook 回复拿不到消息 id（见 `platforms/dingtalk/caps.py` 文件头 §4.4），
#: 发出去的消息改不了，进度是**另发新消息**（`platforms/dingtalk/append_progress.py`）。
#: 一句永远不会发生的承诺比不承诺更糟：用户会盯着第一张卡等它变。
#:
#: 为什么是"一份尾句 × N 个平台"而不是"十条钉钉专属文案"：后者要多维护 20 条字符串，
#: 而每条都得**自己记得**带上"不用重复发问" —— 那正是这个契约测试存在的原因。现在
#: 平台差异只有这一处，加平台只加一行。
#:
#: `""` 是默认档（原地刷新的卡片：飞书 / Slack）。`platform` 传了不认识的值也落这一档 ——
#: 宁可说"会更新在卡片上"再被平台打脸，也不要对能刷新的平台说"我另发一条"（那会让用户
#: 忽略真正在刷新的那张卡）。
ACK_TAIL_KEYS: dict[str, str] = {
    "dingtalk": "im.chat.ack_tail.append",
    "": "im.chat.ack_tail.card",
}

#: 开场句和去处句之间的连接。中文句号后面**不留空格**（CJK 排版没有句间空格，留了会
#: 在钉钉/飞书上显示成一个突兀的缺口）；英文必须留，否则两句会粘成 `minutes.Progress`。
_JOIN: dict[str, str] = {"zh": "", "en": " "}


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


def ack_body_key(seed: str, agent: str = "devops") -> str:
    """开场文案的 i18n key。选 key 而不是选文本，locale 由调用方决定。

    `agent` ∈ :data:`_ACK_BODY_SETS` 的键 = {"devops"（默认）, "notiops", "starops"}。

    不认识的值一律当 "devops"（**宁可说成默认那条，也不要凭空宣称在花钱、也不要凭空
    宣称在查另一家云**）。这个回落只在"加了第四条路但漏改这里"时生效，代价是文案说旧了；
    反过来（默认落 notiops 那套）会对着一个不花钱的路说在花钱，不对称。
    """
    keys = _ACK_BODY_SETS.get(agent, ACK_BODY_KEYS)
    return keys[_index(seed, len(keys))]


def ack_tail_key(platform: str = "") -> str:
    """去处句的 i18n key。见 :data:`ACK_TAIL_KEYS`（不认识的平台落默认"卡片"那一档）。"""
    return ACK_TAIL_KEYS.get(platform or "", ACK_TAIL_KEYS[""])


def ack_body(seed: str, locale: str, agent: str = "devops", *,
             platform: str = "") -> str:
    """「思考中」那条消息的开场话 = 开场句（按种子轮换）+ 去处句（按平台）。

    `platform` 建议**每个调用点都显式传**（`caps.PLATFORM`）：默认那一档说的是"会更新
    在这张卡片上"，对一个不会刷新的平台来说是假话，而漏传不会报错。

    ⚠️ `i18n` 的 import 在函数体里 —— 见模块头「依赖纪律」。ingress 只用表情那两个
    函数，不该为 i18n 那张大表付 INIT 时间。
    """
    from core import i18n
    opener = i18n.t(ack_body_key(seed, agent), locale)
    tail = i18n.t(ack_tail_key(platform), locale)
    return f"{opener}{_JOIN.get(locale, ' ')}{tail}"


def queued_body(locale: str, *, platform: str = "") -> str:
    """「排队中」那条消息的正文 —— 同一句话的"卡片"版 / "追加"版。

    与 :func:`ack_body` 不同，这句**没有开场句轮换**（排队本身就是偶发事件，不存在
    "每次都一样很生硬"的问题），所以是两条整句而不是拼接：卡片版承诺"这张卡片会自己
    变成「思考中」"，追加版说"我会另发一条消息"。选错的代价同上：一个永远不会发生的承诺。
    """
    from core import i18n
    # 「这个平台能不能原地刷新」只在 `ACK_TAIL_KEYS` 里记一次 —— 这里从那份判断派生，
    # 不再写第二个 `platform == "dingtalk"`（写第二遍就会有一天只改一处）。
    append = ack_tail_key(platform).endswith(".append")
    return i18n.t("im.chat.queued_body.append" if append
                  else "im.chat.queued_body", locale)
