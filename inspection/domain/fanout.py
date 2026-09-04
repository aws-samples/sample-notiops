"""调度器 → 执行 Lambda 的消息组装与分批（R13.3）。

纯函数层：只做「组装 + 判大小 + 切批」，不碰 SQS 客户端。

## SQS 的三条硬限（2026-08-19 核 botocore 与官方配额页）

```
单条消息       1,048,576 字节（1 MiB）
批总载荷       1,048,576 字节 —— 与单条同值，且是「所有条目长度之和」
单批条数       10
```

⚠️ **spec 原文写的 256 KB 已过期。** 配额页与 `SendMessageBatch` 的 API 文档
都写 1 MiB；仍显示 256 KB 的是控制台 help panel（旧值）。
超 1 MiB 才需要 Extended Client Library（载荷放 S3，上限 2 GB）。

⚠️ fan-out 时**先撞上的是「10 条」而不是大小**：每条消息只有账号 ID 与
少量标量，10 条离 1 MiB 差三个数量级。所以切批必须按条数为主、大小为辅，
反过来（只按大小切）会切出 500 条一批的非法请求。

## 为什么仍然保留「配置指针」这条降级路径

限额变大不等于该把配置整份塞进消息：

```
① 1000 实例的阈值快照本来就不该走消息 —— 它属于不可变表
② 消息重投时（SQS at-least-once 是必然路径）内联副本是**当时**的配置，
   而指针回读到的是同一个版本 → 重投结果可复现
③ 消息体越大，DLQ 里的排查成本越高
```
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date

from inspection.domain.budget import Tier
from inspection.domain.schedule import DataSource, DueRun, RunMode, RunType

SQS_MAX_BYTES = 1_048_576
"""单条消息与批总载荷的上限，均为 1 MiB。

来源：`SQSDeveloperGuide/quotas-messages.html`「Message size」+
`SendMessageBatch` API 文档原文「maximum allowed individual message size and
the maximum total payload size ... are both 1 MiB」。
"""

SQS_MAX_BATCH_ENTRIES = 10
"""`SendMessageBatch` 单批条数上限。超了报 `TooManyEntriesInBatchRequest`。"""

INLINE_BUDGET_RATIO = 0.85
"""内联配置的判据：序列化后超过上限的 85% 就改传指针。

留 15% 边际是因为**我们算的字节数不等于 SQS 计的字节数** ——
消息属性、SQS 自己的信封都占额度，而我们只量 `MessageBody`。
贴着 100% 判会在临界点上偶发 `BatchRequestTooLong`，
而那是 fan-out 整批失败、不是单条失败。
"""


class FanoutError(RuntimeError):
    """消息组装阶段的失败。"""


@dataclass(frozen=True)
class InspectionMessage:
    """一条派给执行 Lambda 的消息（一个账号一条）。

    ⚠️ `config_version` 与 `config_inline` **恰好一个有值**。
    两个都有会让执行侧不知道该信哪个 —— 而它挑错的那次不会报错，
    只是用了旧阈值判定。`__post_init__` 守这条。
    """

    run_type: RunType
    account_id: str
    run_date: date
    data_date: date
    source: DataSource
    mode: RunMode
    tier: Tier
    config_version: str = ""
    config_inline: Mapping[str, object] | None = None
    catch_up: bool = False
    trigger_id: str = ""
    requested_by: str = ""
    instance_subset: tuple[str, ...] = ()
    """只巡检这几台（补齐重投用，R13.15）。空 = 全量。

    ⚠️ 存在的理由是**成本**：一个账号 1000 台里漏采了 12 台，全量重跑要
    重付一整轮 GetMetricData（155 批），而缺的只有 12 台。
    """
    backfill_run_id: str = ""
    """这一次是给哪个 run 补齐。非空即「补齐轮」。

    🔴 **它同时是「不要碰原 run 的锁」的标志。** 原 run 已经是
    `partial` / `failed`，而 `try_acquire_run_lock` 的条件不含 `partial`
    （`test_inspection_store.py` 刻意锁住了这一点）—— 补齐消息去抢同一把锁
    必然被拒，于是补齐永远不发生。所以补齐走**独立 run_id**。
    """

    @property
    def is_backfill(self) -> bool:
        return bool(self.backfill_run_id)

    def __post_init__(self) -> None:
        """`config_version` **必填**；`config_inline` 是可选的加速。

        🔴 这条断言曾经是「**恰好一个**有值」，与 `snapshot_config` 早期的
        契约配套（小配置只发 inline、不发 version）。那个契约有个静默后果：

        ```
        executor   rule_version = task.config_version = ""
        lifecycle  if rule_version and rec.rule_version and ... → 第一个条件就假
        ⇒ R6.9 的规则变更检测**永不触发**：客户调高阈值之后，本该被 resolve
          的旧 finding 一直挂着，而新阈值下它压根不该存在
        ```

        而阈值配置一定是小配置（30 个字段撑不到 SQS 上限的 1/4），也就是说
        生产上走的恒是内联那条分支 —— 那个空 version 等于让规则变更检测
        彻底不存在。所以现在两者可以同时有值：

        ```
        config_version   总是有值   审计 + rule_version（R6.9）+ 回读键
        config_inline    可选       有就用，省 executor 一次读
        ```

        ⚠️ 反过来 **version 空着仍然是错的**：那样 executor 既拿不到
        rule_version，也没有回读的键。
        """
        if not self.config_version:
            raise FanoutError(
                "config_version 必填 —— 它同时是 R6.9 的 rule_version 与"
                "大配置的回读键；空着会让规则变更检测静默失效 "
                f"(inline={'有' if self.config_inline is not None else '无'})"
            )

    def to_body(self) -> str:
        """序列化成 `MessageBody`。

        ⚠️ `sort_keys=True`：body 会被拿去算幂等 ID，dict 遍历顺序变动
        会让同一条消息产生两个不同的去重键。
        """
        payload: dict[str, object] = {
            "run_type": self.run_type.value,
            "account_id": self.account_id,
            "run_date": self.run_date.isoformat(),
            "data_date": self.data_date.isoformat(),
            "source": self.source.value,
            "mode": self.mode.value,
            "tier": self.tier.value,
            "catch_up": self.catch_up,
        }
        # 🔴 两个**独立**判断，不是 if/else。
        #
        # 曾经写的是 `if version: 写 version else: 写 inline` —— 与「恰好一个
        # 有值」那个旧契约配套。新契约下 version 总是有值，那个 else 分支
        # 就永远走不到了：内联被静默丢掉，executor 每轮都得回读一次表
        # （功能上没错，但白花 RCU，而且「内联省一次读」这个设计彻底失效）。
        #
        # ⚠️ inline 用 `is not None` 判：`{}` 是合法的内联空配置
        # （全新部署还没人改过阈值就是这个形状），`if self.config_inline`
        # 会把它当成没给。
        payload["config_version"] = self.config_version
        if self.config_inline is not None:
            payload["config_inline"] = self.config_inline
        if self.trigger_id:
            payload["trigger_id"] = self.trigger_id
        if self.requested_by:
            payload["requested_by"] = self.requested_by
        if self.instance_subset:
            # sorted：body 参与幂等键计算，集合顺序变动会产生两个去重键。
            payload["instance_subset"] = sorted(self.instance_subset)
        if self.backfill_run_id:
            payload["backfill_run_id"] = self.backfill_run_id
        return json.dumps(payload, sort_keys=True, ensure_ascii=False,
                          separators=(",", ":"))

    def dedupe_id(self) -> str:
        """幂等键。同一 `(type, date, account, source, mode)` 恒定。

        ⚠️ **不含 `trigger_id`**：手动触发要能被去重掉重复点击。
        但也**不含配置内容** —— 否则改一次阈值就绕过去重，
        而那正是客户连点两次「重新巡检」的场景。
        """
        base = [self.run_type.value, self.run_date.isoformat(),
                self.account_id, self.source.value, self.mode.value]
        # 🔴 补齐消息**必须**参与去重键，否则它会被原轮那条消息去重掉 ——
        #    表现是「检测到缺口、发了补齐消息、什么都没发生」，且零报错。
        #    ⚠️ 带上 subset 而不只是 backfill_run_id：同一个 run 可能分两批
        #    补（第一批又漏了几台），两批的 subset 不同、都该跑。
        if self.backfill_run_id:
            base.append(self.backfill_run_id)
        if self.instance_subset:
            base.append(",".join(sorted(self.instance_subset)))
        return "#".join(base)


def should_inline_config(config: Mapping[str, object],
                         *, max_bytes: int = SQS_MAX_BYTES,
                         ratio: float = INLINE_BUDGET_RATIO) -> bool:
    """配置快照能否内联进消息（R13.3）。

    ⚠️ 量的是**序列化后**的字节数，不是 `len(dict)`。
    按条目数判（比如「超 200 台就走指针」）会在实例名特别长时误判 ——
    而那次的表现是整批 `BatchRequestTooLong`，不是单条被拒。

    ⚠️ 这条只管**单条**能不能发出去，不保证批装得满。
    内联 180 KB 时 10 条就是 1.8 MB，`chunk_batches()` 会退化成每批 5 条 ——
    合法但多花请求数。真要压请求数就走 `config_version` 指针（那是它更稳的理由之一）。
    """
    body = json.dumps(config, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":"))
    return len(body.encode("utf-8")) <= int(max_bytes * ratio)


def build_messages(
    *,
    due: Sequence[DueRun],
    data_date_for: Mapping[str, date],
    tier: Tier,
    source: DataSource = DataSource.REFETCH,
    mode: RunMode = RunMode.OFFICIAL,
    config_version: str = "",
    config_inline: Mapping[str, object] | None = None,
    trigger_id: str = "",
    requested_by: str = "",
) -> list[InspectionMessage]:
    """把 `due_runs()` 的结果组装成消息列表。

    Args:
        data_date_for: `{account_id: data_date}`。
            ⚠️ **必须逐账号给**，不能统一用 today。`reuse` 时它是被复用批次的
            真实日期（R11.4a）；写 today 会让 `consecutive_high_days` 凭空 +1。

    ⚠️ 缺 `data_date` 的账号**明确抛错**，不静默回落到 `run_date`。
    静默回落正是 R11.4a 要防的那个污染，而它不报错。
    """
    out: list[InspectionMessage] = []
    for run in due:
        data_date = data_date_for.get(run.account_id)
        if data_date is None:
            raise FanoutError(
                f"账号 {run.account_id} 没有 data_date —— "
                "不回落到 run_date（R11.4a：那会让慢性判定凭空 +1 天）"
            )
        out.append(InspectionMessage(
            run_type=run.run_type,
            account_id=run.account_id,
            run_date=run.run_date,
            data_date=data_date,
            source=source,
            mode=mode,
            tier=tier,
            config_version=config_version,
            config_inline=config_inline,
            catch_up=run.catch_up,
            trigger_id=trigger_id,
            requested_by=requested_by,
        ))
    return out


@dataclass(frozen=True)
class Batch:
    """一次 `SendMessageBatch` 的内容。"""

    entries: tuple[dict[str, object], ...]

    @property
    def total_bytes(self) -> int:
        return sum(len(str(e["MessageBody"]).encode("utf-8")) for e in self.entries)


def chunk_batches(
    messages: Sequence[InspectionMessage],
    *,
    max_entries: int = SQS_MAX_BATCH_ENTRIES,
    max_bytes: int = SQS_MAX_BYTES,
    fifo: bool = False,
) -> list[Batch]:
    """切成合法的 `SendMessageBatch` 请求。

    两条约束同时满足：条数 ≤ 10 且总载荷 ≤ 1 MiB。

    ⚠️ **单条就超上限时明确抛错**，不切成半条也不静默丢。
    静默丢会让那个账号这一天没有任何巡检记录，而对账（R13.13）只能看到
    「缺账号行」这一个模糊线索。

    🔴 `fifo` 决定加不加 `MessageGroupId` / `MessageDeduplicationId`。
    默认 **False**，因为 `notiops-inspection-tasks` 是标准队列。

    此处原先无条件塞这两个参数，注释写着「FIFO 队列用；标准队列忽略」——
    **那句话是错的**。标准队列会拒收：

    ```
    HTTP 200 + Failed: [{
        "Code": "InvalidParameterValue", "SenderFault": true,
        "Message": "The request include parameter that is not valid
                    for this queue type" }]
    ```

    （东京的验证账号实测，非推断。）而 200 让人以为发成功了，
    真实后果是**每一条都投递失败**，于是整套巡检从未执行过一次：
    scheduler 建了 run 行 → 投递全失败 → 收尾又崩在 `error` 保留字上
    → run 永久 `running` → 锁占死 → 之后每轮都「已有 run 在跑，跳过」，
    而看板显示「本轮未发现风险」。
    """
    batches: list[Batch] = []
    cur: list[dict[str, object]] = []
    cur_bytes = 0
    for i, m in enumerate(messages):
        body = m.to_body()
        size = len(body.encode("utf-8"))
        if size > max_bytes:
            raise FanoutError(
                f"单条消息 {size} 字节超过上限 {max_bytes}（账号 {m.account_id}）—— "
                "配置快照应改走 config_version 指针"
            )
        if cur and (len(cur) >= max_entries or cur_bytes + size > max_bytes):
            batches.append(Batch(tuple(cur)))
            cur, cur_bytes = [], 0
        entry: dict[str, object] = {
            "Id": str(i),                     # 批内唯一即可，SQS 只用它对齐结果
            "MessageBody": body,
        }
        if fifo:
            # 只有 FIFO 队列接受这两个参数。标准队列会整条拒收，
            # 且以 HTTP 200 + Failed[].InvalidParameterValue 的形式返回。
            entry["MessageGroupId"] = m.account_id
            entry["MessageDeduplicationId"] = m.dedupe_id()
        cur.append(entry)
        cur_bytes += size
    if cur:
        batches.append(Batch(tuple(cur)))
    return batches


def failed_entry_ids(response: Mapping[str, object]) -> list[str]:
    """从 `SendMessageBatch` 响应里挑出失败条目的 `Id`。

    ⚠️ **HTTP 200 也可能部分失败。** API 文档原文：
    「the batch request can result in a combination of successful and
    unsuccessful actions, you should check for batch errors even when the
    call returns an HTTP status code of 200」。
    不查 `Failed` 会让漏掉的账号这一天静默没有巡检。
    """
    failed = response.get("Failed") or []
    if not isinstance(failed, Iterable):
        return []
    return [str(f.get("Id", "")) for f in failed if isinstance(f, Mapping)]
