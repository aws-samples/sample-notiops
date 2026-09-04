"""补齐重投的判定（R13.15， 的重投半 + 8.4）。

纯函数。零 IO、零 boto3、零 `datetime.now()`。

```
coverage.CoverageReport ──► plan_backfill(...) ──► tuple[BackfillPlan, ...]
   （对账查出的缺口）                                 │ 一个缺口一条
                                                     └─► 调度器发 SQS 消息
                                                         （独立 run_id + subset）
```

## 🔴 为什么不能「重派原来那条消息」

`try_acquire_run_lock` 的阻塞条件**不含 `partial`**
（`tests/test_inspection_store.py` 刻意锁住了这一点），而
`due_runs()` 的 `BLOCKING_STATUSES` 也不含 `partial`
（`tests/test_inspection_schedule.py` 刻意锁住，注释写「否则补跑这个功能
不存在」）。两处都是有意的，但作者互不知道对方 —— 净效果是：

```
due_runs 每 tick 都重派 partial 账号  →  抢锁被拒  →  partial 永远不会重跑
```

所以补齐走**独立 run_id**（`<原 run_id>#bf<序号>`）+ 独立去重键，
完全不碰原 run 的那把锁。这也是 R13.15 存在的原因。

## 🔴 两条不重投的判据

```
dry_run 的行                    预演可能刻意只跑子集
已经补过 MAX_ATTEMPTS 次        再补下去是正反馈（补齐本身也会失败）
```

⚠️ 曾经有第三条「`missing_row` 且 `expected == 0` 不补」，**那是个缺陷**：
`audit_coverage` 造缺行 Gap 时读不到 expected（没有行就没有 stats），
所以它恒为 0 —— 于是缺整行的账号**永远不补**，而那正是最危险的那类空洞。
判据已删，理由见 `plan_backfill` 里的注释。

⚠️ 最后一条尤其重要：如果缺口的成因是「那几台实例的 CloudWatch 权限缺失」，
无上限重投会每小时打一次 GetMetricData 并永远失败 —— 额度和账单都在涨，
而缺口一直在。有上限时它停下来，`CoverageMissingRows` 指标一直高着，
那是**要人看**的信号。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any, Iterable, Mapping, Sequence

MAX_BACKFILL_ATTEMPTS = 2
"""同一个 (run_type, account, run_date) 最多补几次。

⚠️ 2 而不是「无限」：补齐失败通常是**结构性**原因（权限缺失 / 实例已删 /
限流持续），无上限会变成每小时一次的正反馈。取 2 覆盖瞬时故障
（一次限流、一次 Lambda 冷启超时），第三次还不行就该有人看
`CoverageMissingRows` 那条曲线了。

⚠️ 也不是 1：一次瞬时限流之后紧接着的那次补齐**很可能撞上同一波限流**，
只给一次机会会让大部分真正可补的缺口补不回来。
"""

MAX_SUBSET_SIZE = 200
"""单条补齐消息最多带几台。

⚠️ SQS 消息体上限 256KB，而 200 个实例 ID（每个 ~30 字符）约 6KB —— 
上限不是为了 SQS，是为了**执行 Lambda 的 15 分钟超时**：
200 台 × 18 指标 ÷ 400/批 = 9 批，远在预算内；2000 台会超时，
而超时的补齐会被 SQS 重投，于是变成一个永不结束的循环。
"""


@dataclass(frozen=True)
class BackfillPlan:
    """一条补齐计划。调度器把它变成一条 SQS 消息。"""

    run_type: str
    account_id: str
    run_date: date
    data_date: date
    backfill_run_id: str
    instance_subset: tuple[str, ...] = ()
    """空 = 全量补（缺行的情况：一台都没跑过，没有「哪几台」可言）。"""
    attempt: int = 1
    reason: str = ""
    """`missing_row` / `low_completeness` —— 与 `coverage.Gap.kind` 同值。"""

    @property
    def is_full_rerun(self) -> bool:
        return not self.instance_subset


def backfill_run_id(run_type: str, account_id: str, run_date: date,
                    attempt: int) -> str:
    """补齐轮的 run_id。**与原 run_id 不同**，所以不抢同一把锁。

    形状 `<run_type>#<date>#<account>#bf<attempt>` —— 与执行器里
    `run_id = f"{run_type}#{date}#{account}"` 同前缀加后缀，
    这样在日志/看板上一眼能看出它是谁的补齐轮。

    ⚠️ 带 `attempt`：两次补齐必须是两个不同的 run_id，否则第二次会撞上
    第一次留下的 run 行（那时它已经是终态），于是第二次静默不跑。
    """
    return f"{run_type}#{run_date.isoformat()}#{account_id}#bf{attempt}"


def _attempt_of(existing: Mapping[str, Any] | None) -> int:
    """从已有的补齐记录里读「补过几次了」。缺失 = 0。"""
    if not existing:
        return 0
    try:
        return max(0, int(existing.get("backfill_attempts") or 0))
    except (TypeError, ValueError):
        return 0


def plan_backfill(
    gaps: Iterable[Any],
    *,
    data_date: date,
    attempts: Mapping[tuple[str, str, str], Mapping[str, Any]] | None = None,
    missing_instances: Mapping[tuple[str, str], Sequence[str]] | None = None,
    data_date_by_account: Mapping[str, date] | None = None,
    max_attempts: int = MAX_BACKFILL_ATTEMPTS,
    max_subset: int = MAX_SUBSET_SIZE,
) -> tuple[BackfillPlan, ...]:
    """把对账查出的缺口变成补齐计划。

    Args:
        gaps: `coverage.Gap` 序列（duck-typed：只读
            `run_type` / `account_id` / `run_date` / `kind` / `expected` /
            `actual` / `status`）。
        data_date: **兜底**的数据窗口日期，只在 `data_date_by_account` 里
            查不到那个账号时用。
        data_date_by_account: `{account_id: 原轮的 data_date}`。
            🔴 **必须是原轮那天的**，不是今天 —— 用今天会让补回来的点落在
            错误的日期上，而序列 SK 用 `data_date` 做键（R13.10）。
            表现是补齐「成功」了而那天的窗口还是缺。
            ⚠️ 这个参数是本轮 review 补的：此前 `BackfillPlan.data_date`
            里装的是今天（错值），只靠调用方在发消息时另起一路从 run 行重读
            才侥幸对上 —— 于是 plan 上那个字段是个陷阱。
        attempts: `{(run_type, account, run_date_iso): 补齐记录}`。
        missing_instances: `{(run_type, account): [没被评估到的实例 id]}`。
            拿不到就发全量补（`instance_subset` 为空）。
        max_attempts / max_subset: 见模块常量。

    Returns:
        按 (run_type, account_id) 排序 —— R14 要求同输入同输出。

    ⚠️ `status` 含 `dry_run` 的不补（预演可能刻意只跑子集）。
    """
    seen_attempts = attempts or {}
    missing_map = missing_instances or {}
    out: list[BackfillPlan] = []

    for gap in gaps:
        run_type = str(getattr(gap, "run_type", ""))
        account_id = str(getattr(gap, "account_id", ""))
        run_date = getattr(gap, "run_date", None)
        kind = str(getattr(gap, "kind", ""))
        if not run_type or not account_id or not isinstance(run_date, date):
            continue
        if "dry_run" in str(getattr(gap, "status", "")):
            continue
        # 🔴 **不能用 `expected == 0` 跳过 `missing_row`。**
        #    `audit_coverage` 造缺行 Gap 时压根读不到 expected（没有 run 行
        #    就没有 stats），所以它恒为 0 —— 那是「未知」而不是「零台」。
        #    以它为判据的净效果是**缺整行的账号永远不补**，而那恰恰是最
        #    危险的那类空洞（R9.11：看板空白与「那天没风险」长得一样）。
        #    review 抓到这条时，`subset = ()` 分支与 `is_full_rerun` 都是死代码。
        #
        #    ⚠️ 那么「没有在管资源的账号」会不会被每小时补一次？不会：
        #    这个账号在 config 表里是 enabled 的，它**本该**产出一行
        #    （哪怕 `expected.instances == 0` 的成功行）。缺行就是真的没跑。
        #    而 `max_attempts` 已经把正反馈封住了。

        key = (run_type, account_id, run_date.isoformat())
        done = _attempt_of(seen_attempts.get(key))
        if done >= max_attempts:
            continue

        subset = tuple(
            str(i).strip()
            for i in (missing_map.get((run_type, account_id)) or [])
            if str(i).strip()
        )[:max(0, max_subset)]
        # 缺行时没有「哪几台」可言 —— 一台都没跑过，只能全量补。
        if kind == "missing_row":
            subset = ()

        attempt = done + 1
        per_acct = (data_date_by_account or {}).get(account_id)
        out.append(BackfillPlan(
            run_type=run_type, account_id=account_id, run_date=run_date,
            data_date=per_acct if isinstance(per_acct, date) else data_date,
            backfill_run_id=backfill_run_id(run_type, account_id, run_date,
                                            attempt),
            instance_subset=subset, attempt=attempt, reason=kind,
        ))

    out.sort(key=lambda p: (p.run_type, p.account_id, p.attempt))
    return tuple(out)
