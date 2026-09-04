"""一个会话同时只跑一个问题 —— 排队，而不是并发。

── 修的是什么（2026-09-02 线上）─────────────────────────────────────────────────
DevOps Agent 的多轮上下文是**一个 chat 一个 `execution_id`**（`ddb_state.imchat#`）。
同一个会话里在第一个问题还没答完时再问一句，两次 worker 调用会拿着同一个 execution_id
并发打到同一个 agent 上。现网实测的形态：
  · 后一个把前一个饿死 —— 前一轮跑了 318 秒，最后死在上游 `connection_error`；
  · 两张「思考中」卡片同时在动，用户分不清哪张是自己刚问的；
  · `put_im_chat_session` 是整行 `put_item`，两次写谁最后落谁说话。

── 为什么是"排队 + 立刻告知"，不是"直接拒绝" ───────────────────────────────────
直接回一句「忙，稍后再问」= 把重试的活儿甩给用户，而他并不知道要等多久；在群里更糟
（别人问的他看不见，只看到 bot 拒绝了自己）。所以：**先告诉他排在后面**（一张会动的
卡，心跳把已用时推上去，见 `live_card.py`），拿到租约就地转成「正在思考」继续答。
等不到也**必须明说**（`im.chat.queue_timeout`）—— 不许静默丢掉一个问题。

── 等待期间那个 worker 在干什么 ────────────────────────────────────────────────
就是空等（`time.sleep` + 每 3 秒重试一次条件写）。代价是这段 Lambda 时长的钱：
1024 MB 等满 7 分钟 ≈ 0.7 美分。worker 没有 `reservedConcurrentExecutions`
（只有 ingress 有，见 `infra/lib/constructs/im-core.ts`），所以等着的 worker 不会挤掉
别的会话。用 Step Functions / SQS 重投递能省掉这点钱，但那要引入一个新组件和一套新的
失败模式 —— 不值得。

── 时间预算（`_MAX_WAIT` / `_RESERVE` 怎么来的）─────────────────────────────────
worker 的 Lambda timeout 是 900 秒。等到被平台杀掉，用户侧就是一张永远停在「排队中」
的卡 —— 比一开始就说"忙"更糟。所以只等 `min(_MAX_WAIT, 本次剩余 - _RESERVE)`：
`_RESERVE` 是留给"轮到自己以后真去答"的时间（现网一个复杂问题实测 347 秒）。
"""
from __future__ import annotations

import logging
import time
import uuid

from core import ddb_state
from platforms.common import lambda_deadline

logger = logging.getLogger(__name__)

#: 最多排多久。超过这个时长的等待，用户早就切走了 —— 明说"还在忙"更有用。
_MAX_WAIT = 420.0
#: 轮到自己之后留给"真去答"的时间。现网实测一个复杂问题 347 秒，留 300 秒是下限。
_RESERVE = 300.0
#: 重试抢租约的间隔。3 秒 = 最坏 140 次条件写（每次 1 WCU），可以忽略。
_POLL = 3.0
#: 租约 TTL 相对"本次调用还剩多久"的富余量。被 Lambda 超时杀掉时走不到 release，
#: 靠这个让租约在自己死后 ~30 秒自动失效（而不是堵住整个会话）。
_TTL_SLACK = 30


class Turn:
    """一次 chat 在某个会话上的"轮次"。

    用法（两个 `caps.chat` 都是这个形状）::

        turn = chat_lease.Turn(PLATFORM, msg.chat_id, owner=msg.event_id)
        queued = not turn.acquire()        # 抢不到 → 先把「排队中」的卡发出去
        try:
            if queued and not turn.wait():
                ...                        # 等不到：明确告知，然后 return
            result = devops_chat.run_devops_chat(...)
        finally:
            turn.release()                 # **必须**在 finally 里

    `acquire()` 从不阻塞；等待是 `wait()` 显式做的 —— 因为"发一张排队卡"这件事只有
    平台层会做，本模块不认识任何平台。
    """

    def __init__(self, platform: str, chat_id: str, *, owner: str = "",
                 sleep=None, clock=None) -> None:
        self.platform = platform
        self.chat_id = chat_id
        # owner 必须每次调用唯一：release 是带条件的（只删自己那把），拿一个会重复的
        # 值当 owner 就会删掉别人的租约。event_id 天然唯一（而且已经是幂等键），
        # 没有的路径（Fargate / 单测）退到 uuid。
        self.owner = owner or uuid.uuid4().hex
        # ⚠️ 默认值必须**晚绑定**（这里存 None，用的时候才落到 `time.sleep`）。
        # 写成 `sleep=time.sleep` 会在 import 时就把真函数钉进函数签名里，
        # `monkeypatch.setattr(chat_lease.time, "sleep", ...)` 从此完全无效 ——
        # 单测会真睡满整个排队时长（实测让这一个文件从 1 秒涨到 49 秒）。
        self._sleep = sleep
        self._clock = clock
        self._held = False
        #: 实际排了多少秒 —— 进日志用（判断"客户说慢"是排队还是 agent 本身慢）。
        self.waited = 0.0

    @property
    def held(self) -> bool:
        return self._held

    # 晚绑定的两个注入点（见 `__init__` 里那条注释）。
    def _now(self) -> float:
        return (self._clock or time.monotonic)()

    def _nap(self, seconds: float) -> None:
        (self._sleep or time.sleep)(seconds)

    def acquire(self) -> bool:
        """试一次。**不阻塞**。DDB 出错时 fail-open（见 `ddb_state`）。"""
        if self._held:
            return True
        ttl = int(lambda_deadline.remaining_seconds()) + _TTL_SLACK
        self._held = ddb_state.acquire_im_chat_lease(
            self.platform, self.chat_id, owner=self.owner, ttl_seconds=ttl)
        return self._held

    def wait_budget(self) -> float:
        """还能排多久（<= 0 = 一秒都不该等，直接告诉用户忙）。"""
        return min(_MAX_WAIT, lambda_deadline.remaining_seconds() - _RESERVE)

    def wait(self) -> bool:
        """排队等前一个问题跑完。True = 轮到自己了（租约已在手）。

        超时返回 False，**调用方必须把这件事告诉用户**（不是静默 return）。
        """
        budget = self.wait_budget()
        if budget <= 0:
            logger.info("chat_lease: no time to queue on %s (budget %.0fs)",
                        self.chat_id, budget)
            return False
        started = self._now()
        deadline = started + budget
        while True:
            left = deadline - self._now()
            if left <= 0:
                self.waited = self._now() - started
                logger.info("chat_lease: gave up queueing on %s after %.0fs",
                            self.chat_id, self.waited)
                return False
            self._nap(min(_POLL, left))
            if self.acquire():
                self.waited = self._now() - started
                logger.info("chat_lease: got the turn on %s after %.0fs",
                            self.chat_id, self.waited)
                return True

    def release(self) -> None:
        """放掉租约。幂等；没拿到过的时候什么都不做（别去删别人的）。"""
        if not self._held:
            return
        self._held = False
        ddb_state.release_im_chat_lease(self.platform, self.chat_id,
                                       owner=self.owner)
