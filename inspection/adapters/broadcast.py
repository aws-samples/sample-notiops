"""多平台广播层（R11b.4）。

按一份投递目标清单，把**已经渲染好的 markdown** 投给多个 chat。
路由在这里，渲染在 `shared/report_delivery/*_sender.py`（只复用，不重写）。

```
resolve_inspection_targets()  ──►  broadcast(targets, body_for=…)
        （domain/targets.py）           │
                                       ├─ feishu   ─► feishu_sender.send_markdown
                                       ├─ slack    ─► slack_sender.send_markdown
                                       └─ dingtalk ─► dingtalk_sender.send_markdown
                                                        （单 webhook 绑一个群）
```

## 为什么不用 `send_report`

它会再渲染一张 header 卡片，槽位是 `status` / `priority` / `task_id` /
report 链接按钮 —— 巡检日报一个都没有，渲染出来是
「Investigation Completed · UNKNOWN priority · task_id: 」，看着像报告坏了。
而且三个 `send_report` 全是 `-> None`，广播拿不到逐 chat 成败，
「今天哪个群没收到」就无从回答。⇒ 三个 sender 各加了一个
`send_markdown(chat_id, markdown, *, locale) -> bool` 的薄公开壳，
内部走的还是它们各自既有的 markdown 渲染路径。

## 部分失败不阻断（抄 `phd_event_forwarder/notifier.py` 的形状）

逐 chat `try/except`，一个失败继续下一个，返回**逐条结果**而不是一个布尔。
⚠️ 返回布尔的表现是「五个群里有一个发失败」与「五个全失败」在日志里
长得一样，而前者不用叫人、后者要。

## ⚠️ 这一层不做任何过滤

`enabled` / `accounts` / `severity_min` 的判定全在
`domain/targets.py`（纯函数、可单测）。在这里再判一次会出现两处判据，
而两处一定会分叉 —— 表现是「管理页显示已停用，群里照样收到」。
本层只回答「投出去了没有」。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Callable, Sequence

from inspection.domain.targets import ChatTarget

logger = logging.getLogger(__name__)

_SENDERS: dict[str, Any] = {}


def load_sender(platform: str) -> Any:
    """`platform` → sender 模块（惰性 + 缓存）。认不出/导入失败返回 `None`。

    ⚠️ 三个分支都写**完整路径** `from shared.report_delivery import X`。
    `shared/report_delivery/push_handler.py:312` 那份写的是裸模块名
    `import dingtalk_sender`，于是 ImportError 被 `except ImportError` 吞掉
    → 钉钉推送永远拿不到 sender 且零报错。抄那段的时候不要把这个一起抄走。
    """
    key = (platform or "").strip().lower()
    if not key:
        return None
    if key in _SENDERS:
        return _SENDERS[key]
    sender = None
    try:
        if key == "feishu":
            from shared.report_delivery import feishu_sender as sender  # type: ignore
        elif key == "slack":
            from shared.report_delivery import slack_sender as sender  # type: ignore
        elif key == "dingtalk":
            from shared.report_delivery import dingtalk_sender as sender  # type: ignore
    except ImportError as e:
        logger.warning("没有 platform=%s 的 sender 模块: %s", key, e)
        sender = None
    _SENDERS[key] = sender
    return sender


@dataclass(frozen=True)
class Delivery:
    """一次投递的结果。`reason` 是**稳定标识**而不是散文 —— 要能计数。"""

    platform: str
    chat_id: str
    ok: bool
    reason: str = ""

    @property
    def key(self) -> str:
        return f"{self.platform}#{self.chat_id}"


NO_SENDER = "no_sender"
NO_SEND_MARKDOWN = "no_send_markdown"
NOT_CONFIGURED = "not_configured"
EMPTY_BODY = "empty_body"
SENDER_ERROR = "sender_error"
SENDER_REFUSED = "sender_refused"
DRY_RUN = "dry_run"


@dataclass(frozen=True)
class BroadcastResult:
    deliveries: tuple[Delivery, ...] = ()

    @property
    def sent(self) -> int:
        return sum(1 for d in self.deliveries if d.ok)

    @property
    def failed(self) -> int:
        """真失败。**不含 dry_run** —— 把预演算成失败会让灰度第 ① 段
        每天误报（R11c.7 的第一段就是「只算不发」）。"""
        return sum(1 for d in self.deliveries
                   if not d.ok and d.reason != DRY_RUN)

    @property
    def skipped(self) -> int:
        return sum(1 for d in self.deliveries if d.reason == DRY_RUN)

    @property
    def failures(self) -> tuple[Delivery, ...]:
        return tuple(d for d in self.deliveries
                     if not d.ok and d.reason != DRY_RUN)


def broadcast(
    targets: Sequence[ChatTarget],
    *,
    body_for: Callable[[ChatTarget], str],
    dry_run: bool = False,
) -> BroadcastResult:
    """把 `body_for(target)` 的 markdown 投给每个目标。**从不抛异常。**

    Args:
        body_for: 逐目标产出正文。**必须逐目标调**，不能算一次到处发 ——
            R11b.3 要求一个 chat 只看到自己账号的 finding（`accounts[]`），
            R11b.10 要求正文语言由该目标的 `locale` 决定。
            ⚠️ 它自己抛异常时按该目标失败处理，不影响其余目标。
        dry_run: 只走到「算完正文」为止，不调 sender。

    ⚠️ 空正文**不投**（`EMPTY_BODY`）。投一条空消息的表现是群里出现一张
    空白卡片，客户会问「这是坏了吗」；而正文为空本身通常意味着
    该 chat 今天没有任何可见的 finding，那种情况该由调用方决定发不发
    「本轮未发现风险」。
    """
    out: list[Delivery] = []
    for t in targets:
        try:
            body = body_for(t) or ""
        except Exception as e:
            logger.error("渲染正文失败 target=%s: %s", t.key, e)
            out.append(Delivery(t.platform, t.chat_id, False, SENDER_ERROR))
            continue

        if not body.strip():
            logger.info("正文为空，跳过 target=%s", t.key)
            out.append(Delivery(t.platform, t.chat_id, False, EMPTY_BODY))
            continue

        if dry_run:
            logger.info("dry_run：不投递 target=%s（正文 %d 字符）",
                        t.key, len(body))
            out.append(Delivery(t.platform, t.chat_id, False, DRY_RUN))
            continue

        sender = load_sender(t.platform)
        if sender is None:
            out.append(Delivery(t.platform, t.chat_id, False, NO_SENDER))
            continue
        send = getattr(sender, "send_markdown", None)
        if not callable(send):
            # 有人删了那个薄壳、或者换了名字。整平台静默不投是最坏的情况，
            # 所以这里明确记一条而不是当成「发失败」。
            logger.error("platform=%s 的 sender 没有 send_markdown", t.platform)
            out.append(Delivery(t.platform, t.chat_id, False, NO_SEND_MARKDOWN))
            continue
        if not _is_configured(sender):
            logger.warning("platform=%s 未配置凭证，跳过 target=%s",
                           t.platform, t.key)
            out.append(Delivery(t.platform, t.chat_id, False, NOT_CONFIGURED))
            continue

        try:
            ok = bool(send(t.chat_id, body, locale=t.locale))
        except Exception as e:
            # 逐 chat 兜住：一个群的 token 过期不该让其余群收不到。
            logger.error("投递异常 target=%s: %s", t.key, e)
            out.append(Delivery(t.platform, t.chat_id, False, SENDER_ERROR))
            continue
        out.append(Delivery(t.platform, t.chat_id, ok,
                            "" if ok else SENDER_REFUSED))
        if ok:
            logger.info("投递成功 target=%s", t.key)
        else:
            logger.warning("投递被拒 target=%s", t.key)
    return BroadcastResult(deliveries=tuple(out))


def _is_configured(sender: Any) -> bool:
    """`sender.is_configured()`。没这个函数就当**已配置**。

    ⚠️ 方向是 fail-open：三个 sender 都有 `is_configured`，
    没有的话说明是替身（测试）或者新平台还没加 —— 当成未配置会让
    整平台静默不投，而那比多打一次失败日志严重得多。
    """
    probe = getattr(sender, "is_configured", None)
    if not callable(probe):
        return True
    try:
        return bool(probe())
    except Exception as e:
        logger.warning("is_configured 抛异常，按已配置处理: %s", e)
        return True
