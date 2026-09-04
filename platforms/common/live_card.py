"""IM 端「边想边看」—— 把一次长回答的过程实时刷到**同一条消息**上。

解决的是一个非常具体的线上体验问题：用户在飞书问「帮我列出所有 S3 桶的名称和其大小」，
`core.devops_chat.run_devops_chat` 实测跑了 **347 秒**，而 M1 首版的 `caps.chat` 是
"跑完再发卡" —— 这 347 秒里用户侧**一个字都没有**，看起来就像后台挂了。

做法（与 Web 端同一套事件流，见 `core/devops_chat.py::Sink`）：
  · `caps.chat` 先发一张「已收到 · 正在思考」的卡片，拿到 message_id / ts；
  · 把 `LiveCard.emit` 作为 `emit=` 传进 `run_devops_chat`，正文 delta / 过程行 /
    瞬态进度一到就累积，并按节流刷回那**同一条**消息；
  · 一轮结束再 `finish()` 强制刷一次终版（带底部两个出路按钮）。

── 为什么要节流（这是本模块存在的全部理由）─────────────────────────────────────
`emit` 是**逐 delta** 回调（`consume_events` 不缓冲），一秒可能几十次。
  · 每个 delta 都 PATCH 一次 = 每秒几十个 API 调用（Slack 官方建议 ~1 req/s per
    channel，飞书同样有频控），必然被限流，而且卡片肉眼看是在抽搐；
  · 反过来用一个固定间隔（比如 2s）：一个 6 分钟的回答就是 ~180 次调用，绝大多数发生在
    用户早已切走之后 —— 纯浪费配额。
所以间隔**随已用时长递增**：前 30 秒 2s 一次（用户正盯着），30~120 秒 5s，之后 10s。

── 为什么还需要一条心跳（2026-09-02 现网踩）─────────────────────────────────────
上面那套节流**只由 `emit` 驱动**，而 `emit` 只在 DevOps Agent 吐事件时才被调用。
现网实测：agent 收到问题后可以**整整 5 分钟一个事件都不吐**（worker 日志 cd0f6745），
于是最后一次成功刷卡定格在「正在连接 DevOps Agent…」，`elapsed` 也停在个位数 ——
客户看到的就是一张"死卡"，和真挂了完全无法区分（这正是本次线上反馈的原文）。
所以 `start_heartbeat()` 起一个 daemon 线程按同样的节流档位空刷：正文没变也要把
**已用时**推上去，让"还在跑"这件事自己会动。收尾 `close()` 里 join 掉 ——
Lambda 在 handler 返回后会冻结执行环境，daemon 线程留着不 join 就是下一次调用的幽灵。

── 失败就停手 ─────────────────────────────────────────────────────────────────
卡片被用户撤回 / 消息被删 / token 过期时，update 会**一直**失败。连续失败
`_GIVE_UP_AFTER` 次就把这个 LiveCard 置死（后续 emit 只累积、不再调 API）——
`finish()` 的返回值会是 False，调用方据此改走"发一条新消息"的兜底路径。

**本模块不认识任何平台**：`render` / `update` 两个回调由 `caps.py` 注入
（飞书 = `im_cards.answer_card` + `feishu_utils.update_card`；
Slack = `im_blocks.answer_blocks` + `chat.update`）—— 与
`platforms/common/lambda_progress.py` 的 `_RENDERERS` / `_UPDATERS` 同一个套路。
"""
from __future__ import annotations

import logging
import threading
import time

from core import i18n

logger = logging.getLogger(__name__)

#: (到第几秒为止, 这一档的最小刷新间隔秒)。越往后越稀 —— 见模块头。
_TIERS: tuple[tuple[float, float], ...] = ((30.0, 2.0), (120.0, 5.0))
#: 超过最后一档之后的间隔。
_SLOW = 10.0

#: 心跳（正文没变，只为把已用时推上去）的最小间隔。比事件驱动那档更稀：心跳的唯一职责
#: 是"让卡片看起来活着"，2 秒一次纯属浪费配额。
_HEARTBEAT_MIN = 5.0
#: 心跳线程的醒来粒度。真正发不发由 `flush` 的节流决定。
_HEARTBEAT_TICK = 1.0

#: 「过程」区最多显示几行。只留**最近**的几行：更早的步骤对"现在在干什么"没有信息量，
#: 而卡片正文有长度上限（飞书 3500 / Slack 2900），过程行挤掉答案是本末倒置。
MAX_STEPS = 8

#: 单行过程文本上限。一条 tool 调用摘要可能几百字符，原样怼进卡片会把答案挤下屏幕。
MAX_STEP_LINE = 160

#: 连续失败几次就彻底停手（见模块头）。
_GIVE_UP_AFTER = 3


def steps_md(steps, locale: str) -> str:
    """把过程行渲染成一段 markdown。**两个平台共用这一份** —— 飞书的 markdown 元素和
    Slack 的 mrkdwn section 对 `- ` 列表的渲染一致，没有理由各写一遍（各写一遍就会漂移，
    那是 IM 侧历史上最容易复发的一类 bug，见 `platforms/feishu/im_cards.py` 文件头）。

    空列表返回空串 —— 调用方据此决定"这一块整个不渲染"（而不是渲染一个空标题）。
    """
    lines = [str(s).strip() for s in (steps or []) if str(s).strip()]
    if not lines:
        return ""
    # 单行超长时留一个省略号 —— 裸切片 `ln[:MAX_STEP_LINE]` 让用户看不出被切了
    # （与 `long_answer.clip` / `devops_chat.excerpt` 同一条铁律：不许静默降级）。
    body = "\n".join(
        "- " + (ln[:MAX_STEP_LINE] + "…" if len(ln) > MAX_STEP_LINE else ln)
        for ln in lines)
    # 标题与列表之间**必须**有空行：飞书/Slack 的 markdown 子集里，紧贴段落的 `- `
    # 列表会被并进上一段（2026-09-03 与卡片降级同一处修复）。
    return i18n.t("im.chat.steps_title", locale) + "\n\n" + body


class LiveCard:
    """一条消息的实时刷新器。**永不抛异常** —— 它只是个显示层。

    `render(*, body, steps, state, elapsed, report_url)` → 平台 payload（飞书 card
    dict / Slack blocks list）。`update(payload)` → 写回那条消息。
    `state` 三态：``"queued"``（还没轮到，见 `platforms/common/chat_lease.py`）/
    ``"thinking"``（过程中）/ ``"final"``（终版，只有它挂按钮）。前两态由
    `state=` 初值 + `set_state()` 决定，终版由 `finish()` 强制。
    """

    def __init__(self, *, render, update, ack: str = "",
                 state: str = "thinking",
                 clock=time.monotonic, max_steps: int = MAX_STEPS) -> None:
        self._render = render
        self._update = update
        self._ack = ack
        #: 当前非终态（`"queued"` / `"thinking"`）。心跳线程也要读它 —— 否则排队期间
        #: 每次心跳都会把卡片打回「思考中」，而这一轮其实一个字都还没开始跑。
        self._state = state or "thinking"
        self._clock = clock
        self._max_steps = max_steps

        self.reply = ""
        self.steps: list[str] = []
        self.progress = ""
        #: 终版正文被截断时的「完整报告」链接（`finish(report_url=...)` 填）。
        #: 过程中恒为空 —— 报告是拿到全量正文之后才落的一次性动作。
        self.report_url = ""
        #: 实际发出去的 update 次数 —— 单测断言节流生效，线上进日志看频率。
        self.calls = 0

        self._started = clock()
        self._last = 0.0          # 0.0 = 还没刷过（第一次 emit 立即刷）
        self._dirty = False
        self._fails = 0
        self._dead = False
        # `flush` 会被两个线程调用（emit 所在的主线程 + 心跳线程）——渲染/写回/记账
        # 整段串行化，否则两次 update 可能乱序，卡片会闪回旧内容。
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
        """当前该显示的正文。

        优先级：正文 > 瞬态进度 > ack 文案。`Sink.progress()` 本身就只在正文还没开始时
        才发，这里再兜一层，保证正文来了之后进度行不会盖回去。
        """
        return self.reply.strip() or self.progress or self._ack

    def set_ack(self, ack: str) -> None:
        """换掉 ack 文案（「排队中」→「正在思考」，见 `platforms/common/chat_lease.py`）。

        只标脏，不自己发 —— 什么时候刷由调用方定（排队转正这一下值得 `force=True`
        立刻刷：那正是用户最想知道"轮到我了"的时刻）。
        """
        with self._lock:
            self._ack = ack or ""
            self._dirty = True

    def set_state(self, state: str) -> None:
        """换非终态（`"queued"` → `"thinking"`）。同样只标脏，不自己发。

        **不要**用它设 `"final"` —— 终版必须走 `finish()`（那里会先停心跳，
        否则心跳的下一次刷新会把按钮抹掉）。
        """
        with self._lock:
            self._state = state or "thinking"
            self._dirty = True

    # ---- 事件入口 ----
    def emit(self, kind: str, payload: dict) -> None:
        """`run_devops_chat(emit=...)` 的回调。三种 kind 与 Web 端同形。"""
        try:
            if kind == "text":
                self.reply += str((payload or {}).get("delta") or "")
            elif kind == "step":
                line = str((payload or {}).get("text") or "").strip()
                if line:
                    self.steps.append(line)
                    # 只留最近 N 行（见 MAX_STEPS）
                    del self.steps[:-self._max_steps]
            elif kind == "progress":
                self.progress = str((payload or {}).get("text") or "").strip()
            else:
                return
            self._dirty = True
        except Exception as e:                     # noqa: BLE001
            # 显示层的解析错误绝不能拖垮这一轮回答（`Sink._fire` 也吞，这里是第二道）。
            logger.warning("live_card.emit(%s) failed: %s", kind, type(e).__name__)
            return
        self.flush()

    # ---- 刷新 ----
    def _interval(self, elapsed: float) -> float:
        for until, gap in _TIERS:
            if elapsed < until:
                return gap
        return _SLOW

    def flush(self, *, force: bool = False, state: str = "",
              heartbeat: bool = False) -> bool:
        """按节流把当前状态写回那条消息。返回是否**真的**发出了一次 update。

        `state=""`（默认，也是 emit / 心跳走的路）用当前的 `self._state`，
        **不是**硬编码 `"thinking"` —— 排队期间硬编码会把卡片打回「思考中」。
        只有 `finish()` 显式传 `"final"`。
        `force=True`（`finish()` 用）跳过节流，但仍然尊重 `_dead`。
        `heartbeat=True`（心跳线程用）不要求 `_dirty`——已用时本身就变了，就是要刷它；
        节流间隔取 `max(档位, _HEARTBEAT_MIN)`。
        """
        if self._dead:
            return False
        with self._lock:
            return self._flush_locked(force=force, state=state, heartbeat=heartbeat)

    def _flush_locked(self, *, force: bool, state: str, heartbeat: bool) -> bool:
        if self._dead:
            return False
        state = state or self._state
        now = self._clock()
        if not force:
            if not self._dirty and not heartbeat:
                return False
            gap = self._interval(now - self._started)
            if heartbeat:
                gap = max(gap, _HEARTBEAT_MIN)
            if self._last and (now - self._last) < gap:
                return False
        try:
            payload = self._render(body=self.body(), steps=list(self.steps),
                                   state=state, elapsed=int(now - self._started),
                                   report_url=self.report_url)
            self._update(payload)
        except Exception as e:                     # noqa: BLE001
            self._fails += 1
            logger.warning("live_card.flush failed (%d/%d): %s",
                           self._fails, _GIVE_UP_AFTER, type(e).__name__)
            if self._fails >= _GIVE_UP_AFTER:
                # 卡片没了 / 一直被拒 —— 别再对着它刷剩下的几分钟。
                self._dead = True
                logger.error("live_card: giving up after %d consecutive failures",
                             self._fails)
            return False
        self._fails = 0
        self._last = now
        self._dirty = False
        self.calls += 1
        return True

    # ---- 心跳（见模块头「为什么还需要一条心跳」）----
    def start_heartbeat(self, *, tick: float = _HEARTBEAT_TICK) -> None:
        """起一个 daemon 线程空刷已用时。幂等；`close()` 负责收。"""
        if self._hb is not None or self._dead:
            return
        self._hb_stop = threading.Event()
        self._hb = threading.Thread(target=self._heartbeat_loop, args=(tick,),
                                    daemon=True, name="live-card-heartbeat")
        self._hb.start()

    def _heartbeat_loop(self, tick: float) -> None:
        stop = self._hb_stop
        # 心跳**永不抛**：它跑在自己的线程里，抛出去只会静默丢线程（那就退化成没有心跳、
        # 又没有任何日志），所以自己吞掉并记一条。
        while stop is not None and not stop.wait(tick):
            if self._dead:
                return
            try:
                self.flush(heartbeat=True)
            except Exception as e:                 # noqa: BLE001
                logger.warning("live_card heartbeat failed: %s", type(e).__name__)
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
                logger.warning("live_card: heartbeat thread still alive after join")

    def finish(self, reply: str, *, report_url: str = "") -> bool:
        """刷终版（`state="final"`，底部挂出路按钮）。返回是否成功写回。

        `reply` 用调用方拿到的**全量正文**而不是 `self.reply`：流式累积可能因为超时/
        异常而不完整，而 `run_devops_chat` 的返回值是权威口径。而且调用方给的这份已经
        过了 `long_answer.fit()`（超限则是"开头 + 截断提示"），`report_url` 就是那次
        落报告的产物 —— 本模块只把它转交给 `render`，不认识 S3。

        先 `close()`：心跳线程在终版之后再刷一次就会把 `state` 打回 `"thinking"`，
        按钮当场消失 —— 这是最容易复发的一类竞态。
        """
        self.close()
        self.reply = reply or self.reply
        self.progress = ""
        self.report_url = report_url or ""
        return self.flush(force=True, state="final")
