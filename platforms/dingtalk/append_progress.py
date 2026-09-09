"""钉钉的「还在跑」提示 —— **追加式**，不是原地刷新。

`platforms/common/live_card.py` 的钉钉对位实现，**同名同签**（`emit(kind, payload)` /
`flush(...)` / `set_ack` / `set_state` / `start_heartbeat` / `close` /
`finish(reply, *, report_url="")`），好让 `caps.chat` 与飞书 / Slack 那两份逐行对齐。

── 为什么不能直接用 `LiveCard` ────────────────────────────────────────────────
`LiveCard.__init__` 要一个 `update(payload)` —— 把**同一条**消息改掉。钉钉 Tier 1
做不到：`sessionWebhook` 的返回只有 `{"errcode":0}`，连消息 id 都没有，没有可更新的
句柄（见 `caps.py` 文件头第 3 条）。所以这里的 `send(payload)` 是**发一条
新消息**，语义从"刷新"变成"追加"。

── 于是节流的目标反过来了 ──────────────────────────────────────────────────────
`LiveCard` 要解决的是"每秒几十次 PATCH 会被限流且卡片抽搐"，代价只是 API 配额。
这里每发一次就是**群里多一条消息** —— 刷屏的伤害远大于进度感的收益（钉钉群没有
thread，所有人都会被这条消息顶一次未读）。所以：

    t=0        ack（由 `caps.chat` 自己发第一条，与另外两家一致）
    t≈120s     还没出结果 → 追加 1 条进度
    t≈360s     还没出结果 → 追加 1 条进度
    出结果      最终答案（含落款）

**非终态消息一共最多 2 条（`MAX_INTERIM`），是硬上限。** 排队转正那次
`flush(force=True)` 也从这 2 条里扣 —— `force` 跳过的是**时间**闸门，不是**预算**
闸门。否则"最多 2 条"就变成了一句没有约束力的话。

正文没变时不发（也不扣预算）：一条内容与上一条一样的"还在跑"没有任何信息量，
只是又顶一次未读。

── 心跳是唯一的驱动源（不是可选项）──────────────────────────────────────────────
`emit` 只在 DevOps Agent 吐事件时才被调用，而现网实测它可以**整整 5 分钟一个事件都不
吐**（见 `live_card.py` 文件头的 worker 日志 cd0f6745）。上面那两条定时进度全靠
`start_heartbeat()` 的 daemon 线程推。`close()` 必须在 handler 返回前 join ——
Lambda 在返回后冻结执行环境，没 join 的 daemon 线程是下一次调用的幽灵。

⚠️ 心跳线程会走到 `send`，而 `send` 底下是 `platforms.dingtalk.sender.reply()`，它读
一个**模块级**的会话上下文。那个上下文之所以不能是 `threading.local`，正是因为这条
线程（见 `sender.py` 的 `bind` 注释）。

**本类永不抛异常** —— 它只是个显示层。
"""
from __future__ import annotations

import logging
import threading
import time

from platforms.common.live_card import MAX_STEPS, sources_md, steps_md

logger = logging.getLogger(__name__)

__all__ = ["MAX_INTERIM", "AppendProgress", "sources_md", "steps_md"]

#: 连续失败几次就彻底停手。与 `live_card._GIVE_UP_AFTER` 同值，但**各自定义**：
#: 那是个模块私有名，跨模块 import 私有名会让"改一处影响两处"变得看不出来。
_GIVE_UP_AFTER = 3

#: 定时追加进度的时刻（秒）。长度即硬上限，见模块头。
_INTERIM_AT: tuple[float, ...] = (120.0, 360.0)

#: 非终态消息的硬上限（含排队转正那次 force）。
MAX_INTERIM = len(_INTERIM_AT)

#: 心跳线程的醒来粒度。比 `LiveCard` 的 1s 粗得多 —— 这里的判据是"到 120s 了吗"，
#: 秒级精度毫无意义，而每次 wait 醒来都是一次 Lambda 计费时间里的上下文切换。
_HEARTBEAT_TICK = 5.0


class AppendProgress:
    """一轮问答的追加式进度器。签名与 `live_card.LiveCard` 对齐（见模块头）。

    `render(*, body, steps, state, elapsed, report_url)` → 平台 payload
    （钉钉是 `(title, text)` 元组）。`send(payload) -> bool` → 发一条新消息，
    返回是否成功。`state` 三态与另外两家一致：``"queued"`` / ``"thinking"`` /
    ``"final"``（只有 `finish()` 会用 final）。
    """

    def __init__(self, *, render, send, ack: str = "",
                 state: str = "thinking",
                 clock=time.monotonic, max_steps: int = MAX_STEPS) -> None:
        self._render = render
        self._send = send
        self._ack = ack
        #: 当前非终态。心跳线程也要读它 —— 排队期间不能把状态说成「思考中」。
        self._state = state or "thinking"
        self._clock = clock
        self._max_steps = max_steps

        self.reply = ""
        self.steps: list[str] = []
        self.progress = ""
        self.report_url = ""
        #: 实际发出去的消息数（不含 `caps.chat` 自己发的那条 ack）——
        #: 单测断言硬上限生效，线上进日志看频率。
        self.calls = 0
        #: 已经发掉的非终态消息数。终版不计入。
        self.interim = 0

        self._started = clock()
        self._last_body = ""
        self._fails = 0
        self._dead = False
        # `flush` 会被两个线程调用（emit 所在的主线程 + 心跳线程）—— 渲染/发送/记账
        # 整段串行化，否则两条追加消息可能乱序，用户看到进度倒退。
        self._lock = threading.RLock()
        self._hb: threading.Thread | None = None
        self._hb_stop: threading.Event | None = None

    # ---- 状态 ----
    @property
    def elapsed(self) -> int:
        return int(self._clock() - self._started)

    @property
    def dead(self) -> bool:
        return self._dead

    def body(self) -> str:
        """当前该显示的正文。优先级：正文 > 瞬态进度 > ack（口径同 `LiveCard.body`）。"""
        return self.reply.strip() or self.progress or self._ack

    def set_ack(self, ack: str) -> None:
        """换掉 ack 文案。只记下来，**不自己发** —— 什么时候发由调用方定。"""
        with self._lock:
            self._ack = ack or ""

    def set_state(self, state: str) -> None:
        """换非终态（`"queued"` → `"thinking"`）。

        **不要**用它设 `"final"` —— 终版必须走 `finish()`（那里会先停心跳）。
        """
        with self._lock:
            self._state = state or "thinking"

    # ---- 事件入口 ----
    def emit(self, kind: str, payload: dict) -> None:
        """`run_devops_chat(emit=...)` 的回调。三种 kind 与另外两家同形。

        ⚠️ 与 `LiveCard.emit` 的关键差异：**这里只累积，不触发发送**。事件驱动的发送
        在钉钉上等于事件驱动的刷屏。真正决定发不发的是心跳（见模块头）。
        """
        try:
            if kind == "text":
                self.reply += str((payload or {}).get("delta") or "")
            elif kind == "step":
                line = str((payload or {}).get("text") or "").strip()
                if line:
                    self.steps.append(line)
                    del self.steps[:-self._max_steps]      # 只留最近 N 行
            elif kind == "progress":
                self.progress = str((payload or {}).get("text") or "").strip()
        except Exception as e:                     # noqa: BLE001
            # 显示层的解析错误绝不能拖垮这一轮回答（`Sink._fire` 也吞，这里是第二道）。
            logger.warning("append_progress.emit(%s) failed: %s",
                           kind, type(e).__name__)

    # ---- 发送 ----
    def flush(self, *, force: bool = False, state: str = "",
              heartbeat: bool = False) -> bool:
        """按"追加"的口径发一条消息。返回是否**真的**发出去了。

        与 `LiveCard.flush` 的签名一致，但闸门不同（见模块头）：

        · `state="final"`（只有 `finish()` 传）→ 不受预算和时间闸门约束。
        · 其余（emit / 心跳 / 排队转正的 `force=True`）→ 先过预算闸门
          （`interim < MAX_INTERIM`），再过时间闸门（`force=True` 可跳过时间闸门，
          **不能**跳过预算），最后过"正文有没有变"。
        """
        if self._dead:
            return False
        with self._lock:
            return self._flush_locked(force=force, state=state)

    def _flush_locked(self, *, force: bool, state: str) -> bool:
        if self._dead:
            return False
        state = state or self._state
        final = state == "final"
        body = self.body()
        if not final:
            if self.interim >= MAX_INTERIM:
                return False
            if not force and self.elapsed < _INTERIM_AT[self.interim]:
                return False
            # 内容与上一条一样 → 不发、也不扣预算（见模块头）。
            if body.strip() == self._last_body.strip():
                return False
        try:
            payload = self._render(body=body, steps=list(self.steps),
                                   state=state, elapsed=self.elapsed,
                                   report_url=self.report_url)
            ok = self._send(payload)
        except Exception as e:                     # noqa: BLE001
            ok = False
            logger.warning("append_progress.flush raised: %s", type(e).__name__)
        if not ok:
            self._fails += 1
            logger.warning("append_progress.flush failed (%d/%d)",
                           self._fails, _GIVE_UP_AFTER)
            if self._fails >= _GIVE_UP_AFTER:
                # 会话地址失效 / 一直被拒 —— 别再对着它发剩下的几分钟。
                self._dead = True
                logger.error("append_progress: giving up after %d consecutive "
                             "failures", self._fails)
            return False
        self._fails = 0
        self._last_body = body
        self.calls += 1
        if not final:
            self.interim += 1
        return True

    # ---- 心跳（唯一的驱动源，见模块头）----
    def start_heartbeat(self, *, tick: float = _HEARTBEAT_TICK) -> None:
        """起一个 daemon 线程按 `_INTERIM_AT` 追加进度。幂等；`close()` 负责收。"""
        if self._hb is not None or self._dead:
            return
        self._hb_stop = threading.Event()
        self._hb = threading.Thread(target=self._heartbeat_loop, args=(tick,),
                                    daemon=True, name="dt-append-progress")
        self._hb.start()

    def _heartbeat_loop(self, tick: float) -> None:
        stop = self._hb_stop
        # **永不抛**：它跑在自己的线程里，抛出去只会静默丢线程（那就退化成没有进度、
        # 又没有任何日志），所以自己吞掉并记一条。
        while stop is not None and not stop.wait(tick):
            if self._dead or self.interim >= MAX_INTERIM:
                # 预算用完就没有理由再醒 —— 剩下的几分钟白烧 Lambda 计费时间。
                return
            try:
                self.flush(heartbeat=True)
            except Exception as e:                 # noqa: BLE001
                logger.warning("append_progress heartbeat failed: %s",
                               type(e).__name__)
                return

    def close(self) -> None:
        """停心跳并 join。**必须**在 handler 返回前调用（见模块头）。"""
        stop, t = self._hb_stop, self._hb
        self._hb, self._hb_stop = None, None
        if stop is not None:
            stop.set()
        if t is not None:
            t.join(timeout=2.0)
            if t.is_alive():
                logger.warning("append_progress: heartbeat thread still alive "
                               "after join")

    def finish(self, reply: str, *, report_url: str = "") -> bool:
        """发终版（`state="final"`）。返回是否成功。

        `reply` 用调用方拿到的**全量正文**而不是 `self.reply`：流式累积可能因为超时/
        异常而不完整，而 runner 的返回值是权威口径。调用方给的这份已经过了
        `long_answer.fit()`，`report_url` 就是那次落报告的产物 —— 本模块只把它转交给
        `render`，不认识 S3。

        先 `close()`：心跳线程在终版之后再追加一条「还在跑」，用户看到的就是"答完了
        又开始跑"。这是最容易复发的一类竞态（另外两家同一处注释）。
        """
        self.close()
        self.reply = reply or self.reply
        self.progress = ""
        self.report_url = report_url or ""
        return self.flush(force=True, state="final")
