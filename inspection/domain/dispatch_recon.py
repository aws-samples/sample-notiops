"""派发对账的判定层（R13.13 / R13.13a / R13.13b）。

对账要回答一个问题：**已派发的判读任务，现在到底是什么状态。**

```
主路径  EventBridge 事件（source=aws.aidevops）→ devops_agent_callback
        超时由 AWS 自己判并发 Investigation Timed Out
兜底    对账时对仍非终态的行调 GetBacklogTask 读 status 核实
        作用是补「事件丢失」，**不是**「超时就重投」
```

## 🔴 绝不按墙钟时长判死重投

原 spec 写的「`status=running` 超 timeout×2 → 判腰斩 + 重投」有两个错，第二个致命：

① 那个 timeout 是 custom agent 的 1 小时，**investigation 没有这个配额**（R12.5）。
② 墙钟时长**分不出「排队」与「卡死」**。`TaskStatus` 有六个非终态会长期停留：

```
PENDING_START               排在并发额度后面（实测一次发 6 条，3 条停在这）
PENDING_TRIAGE              等分诊
LINKED                      已关联，等开始
IN_PROGRESS                 真的在跑
PENDING_CUSTOMER_APPROVAL   等人点确认，可以停几天
WAITING                     AWS 2026-09 新增的一档，服务模型没给语义说明
```

判死重投一条排队中的任务 → 队列更长 → 更多任务排队 → 更多被判死重投。
**正反馈**：额度烧光且永不收敛，而每一步看起来都「在正常重试」。

⇒ 本模块**只有** `GetBacklogTask` 回来的 status 能推动状态，时长只用来决定
「要不要去问一下」（`needs_probe`），从不用来决定「它死了」。

## 🔴 `SKIPPED` 与 `FAILED` / `TIMED_OUT` 的处置**相反**

`SKIPPED` 的官方语义是「matched skip criteria defined in a skill」，而那两份
skill 是我们自己上传的 —— 这条路径真实可达。重投会得到**同样**结果：
每轮白烧一次额度，报告永远不出现。所以它是终态且**永不重投**。

合并成一个「非 COMPLETED 就重投」的分支，表现是额度被一条永远会被跳过的
finding 持续消耗，而看板上那条 finding 永远是空的。

## 状态枚举的真源

取自 botocore 的服务模型 `devops-agent/2026-01-01/service-2.json.gz` 的
`TaskStatus`（11 档）。⚠️ `CANCELED` 是**一个 L**。
拼错的表现是它落不进 `TERMINAL` → 每轮都去 probe 一条永远不会变的任务。
`test_inspection_dispatch_recon.py` 有元断言直接读那份模型比对。

⚠️ 那条元断言比的是**覆盖**（模型 ⊆ 本枚举）而不是相等，因为 `requirements.txt`
给 boto3 的是下限而不是钉死的版本：botocore 1.43.73 的模型只有 10 档，1.43.88 才
加上 `WAITING`。本枚举**允许先于**本机装的服务模型知道新的一档（多出来的那档必须
登记进测试里的 `AHEAD_OF_MODEL`），但**不允许**少于它。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum

PROBE_AFTER_HOURS = 2
"""R13.13：pending 超 2 小时无终态才去问 —— 不是一有非终态就问。

⚠️ 调小到接近 0 的表现不是报错，而是**每轮对账都对全部在跑的任务调一次
`GetBacklogTask`**：那些任务正常地在排队，而我们在为它们付 API 调用。
"""


class TaskStatus(str, Enum):
    """`GetBacklogTask` 的 `task.status`。**与 botocore 服务模型逐字一致。**"""

    PENDING_TRIAGE = "PENDING_TRIAGE"
    LINKED = "LINKED"
    PENDING_START = "PENDING_START"
    IN_PROGRESS = "IN_PROGRESS"
    PENDING_CUSTOMER_APPROVAL = "PENDING_CUSTOMER_APPROVAL"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    TIMED_OUT = "TIMED_OUT"
    CANCELED = "CANCELED"
    """⚠️ 一个 L。AWS 用的是美式拼写。"""
    SKIPPED = "SKIPPED"
    WAITING = "WAITING"
    """AWS 在 botocore 1.43.88 那批服务模型里加的一档（元断言当场抓到）。

    🔴 **按非终态处理**（不进下面的 `TERMINAL`，于是自动落进 `NON_TERMINAL`）。
    服务模型只写了「Possible states of a task throughout its lifecycle」，没给这一
    档任何语义说明，所以这是**依名判断**，两个方向的代价不对称：

    ```
    真相是非终态（我们的假设）  →  超 2 小时去 probe 一次，正确
    真相是终态而我们判非终态    →  每轮都 probe 一条永不再变的任务（白花 API 钱）
    真相是非终态而我们判终态    →  它永远拿不到结论，finding 永远是空的
    ```

    后者更坏，所以名字含糊时选非终态。⚠️ 也**不进** `RETRIABLE` —— 非终态进重投
    就是本模块开头那个正反馈的入口。
    """


TERMINAL: frozenset[str] = frozenset({
    TaskStatus.COMPLETED.value,
    TaskStatus.FAILED.value,
    TaskStatus.TIMED_OUT.value,
    TaskStatus.CANCELED.value,
    TaskStatus.SKIPPED.value,
})

NON_TERMINAL: frozenset[str] = frozenset(
    s.value for s in TaskStatus) - TERMINAL

RETRIABLE: frozenset[str] = frozenset({
    TaskStatus.FAILED.value,
    TaskStatus.TIMED_OUT.value,
})
"""可以在**下一轮**重新派发的终态。

⚠️ 不含 `SKIPPED`（判据命中，重投必然同样结果）、不含 `CANCELED`
（R12.3：额度耗尽的签名，重投只会再被取消）、不含 `COMPLETED`（没什么要重的）。
⚠️ 也不含任何非终态 —— 那正是上面那个正反馈的入口。
"""


@dataclass(frozen=True)
class Verdict:
    """一条已派发任务的对账结论。"""

    task_id: str
    status: str

    @property
    def known(self) -> bool:
        """这个状态是我们认识的取值。

        ⚠️ 认不出时**当作非终态**（不落终态、不重投），并让调用方告警：
        AWS 加了新状态而我们不认识时，静默当成终态会把一条还在跑的任务
        标成结束；静默当成可重投则重开正反馈。
        """
        return self.status in TERMINAL or self.status in NON_TERMINAL

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL

    @property
    def should_retry(self) -> bool:
        return self.status in RETRIABLE

    @property
    def degraded_reason(self) -> str:
        """写进 finding 行的降级原因（`DegradedReason` 的值）。

        `COMPLETED` 返回空串 —— 那不是降级，判读内容由 callback 回拼。
        非终态也返回空串：还没有结论，写任何原因都是编。
        """
        return _REASON_BY_STATUS.get(self.status, "")


_REASON_BY_STATUS: dict[str, str] = {
    # ⚠️ 每一档都必须有自己的原因。合并的代价见模块 docstring。
    TaskStatus.FAILED.value: "investigation_failed",
    TaskStatus.TIMED_OUT.value: "investigation_timed_out",
    TaskStatus.SKIPPED.value: "skipped_by_skill",
    # R12.3：`Created` 紧接 `Cancelled` 且无 `Completed` = 月度额度用尽。
    TaskStatus.CANCELED.value: "quota_exhausted",
}
"""状态 → `DegradedReason` 的值（**字符串**，不 import degraded）。

⚠️ 取字符串是为了让本模块保持零仓内依赖 —— 它要能在只有 stdlib 的环境里
import。两处分叉由 `test_inspection_dispatch_recon.py` 的元断言兜住
（逐个值在 `DegradedReason` 里能被 `_coerce` 认出来）。
"""


def needs_probe(
    *, status: str, dispatched_at: datetime, now: datetime,
    after_hours: int = PROBE_AFTER_HOURS,
) -> bool:
    """要不要对这条调 `GetBacklogTask` 核实。

    判据只有两条，**都不是「它是不是超时了」**：
      ① 当前记录的状态不是终态（终态没什么要问的）
      ② 派发已经过去 `after_hours` 小时（没到就正常在跑，问它是白花钱）

    ⚠️ 返回 True **不代表**这条任务有问题。它只代表「主路径的事件可能丢了，
    去核实一下」。把这个函数的语义读成「判死」就会重新引入那个正反馈。
    """
    if status in TERMINAL:
        return False
    if now < dispatched_at:
        # 时钟倒退 / 数据脏。宁可不问 —— 问了也不会因此判死，
        # 但一条未来时间戳会让它每轮都被问。
        return False
    return (now - dispatched_at) >= timedelta(hours=after_hours)


def verdict_of(task_id: str, status: str) -> Verdict:
    """`GetBacklogTask` 的响应 → 对账结论。

    ⚠️ 不做归一化（不 upper()、不 strip()）之外的任何加工。
    把 `"completed"` 也认成 COMPLETED 听起来很宽容，但那会掩盖
    「我们读错了字段」这一类缺陷 —— API 返回的就是大写。
    """
    return Verdict(task_id=task_id, status=str(status or "").strip())


def stale_cutoff(now: datetime, *, after_hours: int = PROBE_AFTER_HOURS) -> datetime:
    """`needs_probe` 的时间界。抽出来给查询侧做 server-side 过滤用。"""
    return now.astimezone(timezone.utc) - timedelta(hours=after_hours)
