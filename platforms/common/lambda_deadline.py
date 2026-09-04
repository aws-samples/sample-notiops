"""本次 Lambda 调用还剩多少时间 —— 给"要不要等"这类决策用。

排队等前一个问题跑完（`platforms/common/chat_lease.py`）必须知道自己还能等多久：等到
被 Lambda 超时杀掉，用户侧看到的就是一张永远停在「排队中」的卡，比直接说"忙"更糟。
唯一权威的数是 `context.get_remaining_time_in_millis()`。

── 为什么用模块级状态、而不是把 `context` 一路传下去 ──────────────────────────────
`context` 要穿过 `router.dispatch` → `Caps.chat` 才能到用得着它的地方，而 `Caps` 是
两个平台共享的协议（`platforms/common/im_types.py`）—— 为了一个只有 chat 一条路径用得到
的数，改协议的代价太大，还会让 Fargate 那条老路径也得编一个假 context 出来。
Lambda **同一个执行环境内的调用是串行的**，所以在 handler 入口存一次是安全的。

存的是**算好的绝对截止点**（`time.monotonic()` 时间轴），不是 `context` 对象本身：
后者留在模块里就成了跨调用的悬挂引用，下一次调用忘了刷新时会读到上一次的剩余时间
（一个已经过去的截止点），静默地把"还能等 800 秒"读成"一秒都不能等"。
"""
from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)

#: 拿不到 context 时的兜底剩余时间。取 worker Lambda 的 timeout（900s，见
#: `infra/lib/constructs/im-core.ts`）—— 本地/Fargate/单测路径下不存在"被平台杀掉"这回事，
#: 按满额算即可。
DEFAULT_REMAINING = 900.0

_deadline: float | None = None


def set_from_context(context) -> None:
    """handler 入口调一次。`context` 为 None 或不带那个方法时清空（回落到默认值）。"""
    global _deadline
    fn = getattr(context, "get_remaining_time_in_millis", None)
    if not callable(fn):
        _deadline = None
        return
    try:
        _deadline = time.monotonic() + float(fn()) / 1000.0
    except Exception as e:                        # noqa: BLE001
        # 不许因为取个时间就把整次调用弄崩 —— 回落到默认值。
        logger.warning("lambda_deadline: bad context: %s", type(e).__name__)
        _deadline = None


def remaining_seconds(default: float = DEFAULT_REMAINING) -> float:
    """本次调用还剩多少秒（>= 0）。没设过 context 就返回 `default`。"""
    if _deadline is None:
        return default
    return max(0.0, _deadline - time.monotonic())


def clear() -> None:
    """单测用：回到"没有 context"的状态。"""
    global _deadline
    _deadline = None
