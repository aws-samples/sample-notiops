"""采集覆盖的对账判定（R13.13 / R13.14）。

回答两个问题，两个的失效形态都是**静默的**：

```
① 今天该跑的账号，run 行在不在        缺行 = 那个账号这天既没巡检也没失败记录
② 跑了的那些，完整度够不够            completeness < 95% = 有资源没被评估
```

## ★ 「缺账号行」比「run 失败」更危险

失败至少留下一行 `status=failed`，看板上能看见。而**没有行**意味着：

- `due_runs()` 压根没把它算进来（账号被 disable 了 / 定时配置漏了它）
- 或者调度器投递失败且连 `finish_run(failed)` 都没落成

两种情形在看板上都表现为「那天那个账号是空白」，与「那天没有风险」
**长得一模一样**。R9.11 把这叫做空洞。

## ⚠️ 这里只做判定，不做重投

R13.14 的重投要带 `instance_subset`，而 R13.15 要求补齐的点标
`backfilled: true` + `backfill_run_id` —— 那是一条独立的 backfill 链路，
**刻意不复用原 run 的锁**。

原因：`try_acquire_run_lock` 的条件不放行 `partial`（有测试钉着，理由是
不能让已完成的那天被重开），而 `BLOCKING_STATUSES` 又不含 `partial`
（也有测试钉着，理由是「补跑要用」）。两处意图相反。
走 backfill 链路两个不变量都不破：原 run 行保持 `partial` 不被重开，
而缺口通过带标记的补齐点填上。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Mapping, Sequence

COMPLETENESS_FLOOR = 0.95
"""R13.14 的门槛。低于它就要告警 + 补齐。

⚠️ 与 `observability.COMPLETENESS_ALARM_PCT`（95.0）是同一条判据的两种单位。
两处分叉的表现是告警响了而对账说没事（或反过来）——
`test_inspection_coverage.py` 有元断言比对。
"""


def _num(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    return None


@dataclass(frozen=True)
class Gap:
    """一个采集缺口。"""

    run_type: str
    account_id: str
    run_date: date
    kind: str
    """`missing_row`（没有 run 行）或 `low_completeness`。"""
    completeness: float | None = None
    expected: int = 0
    actual: int = 0
    status: str = ""

    @property
    def missing_instances(self) -> int:
        """没被评估到的实例数。`missing_row` 时等于 expected（一个都没跑）。"""
        return max(0, self.expected - self.actual)


@dataclass(frozen=True)
class CoverageReport:
    gaps: tuple[Gap, ...] = ()
    checked: int = 0
    dry_run_skipped: int = 0

    @property
    def missing_rows(self) -> tuple[Gap, ...]:
        return tuple(g for g in self.gaps if g.kind == "missing_row")

    @property
    def low_completeness(self) -> tuple[Gap, ...]:
        return tuple(g for g in self.gaps if g.kind == "low_completeness")


def audit_coverage(
    *,
    run_type: str,
    run_date: date,
    expected_accounts: Sequence[str],
    rows: Mapping[str, Mapping[str, Any]],
    floor: float = COMPLETENESS_FLOOR,
) -> CoverageReport:
    """比对「今天该跑的账号」与「实际的 run 行」。

    Args:
        expected_accounts: `enabled_accounts()` 的结果 —— 今天该有行的账号。
        rows: `{account_id: run 行}`。缺的键就是缺行。

    ⚠️ **`dry_run` 的行不参与完整度判定。** 预演可能刻意只跑一个子集，
    按它告警等于每次预演都报一次 —— 而预演正是灰度第 ① 段每天要做的事。
    但 dry_run 的行**仍然算「有行」**：它证明调度链路是通的。

    ⚠️ `status=running` 的行也跳过完整度：它还没跑完，
    `stats` 里的数是上一次的或压根没有。按它告警会在每一轮的中途都响一次。
    """
    gaps: list[Gap] = []
    checked = 0
    dry_skipped = 0

    for account_id in expected_accounts:
        row = rows.get(account_id)
        if row is None:
            # 一个都没跑：expected 未知（没有行就没有 stats），记 0。
            gaps.append(Gap(run_type=run_type, account_id=account_id,
                            run_date=run_date, kind="missing_row"))
            continue

        checked += 1
        stats = row.get("stats") or {}
        status = str(row.get("status") or stats.get("status") or "")
        if status == "running":
            continue
        if bool(stats.get("dry_run")):
            dry_skipped += 1
            continue

        expected = int(_num((stats.get("expected") or {}).get("instances")) or 0)
        actual = int(_num((stats.get("actual") or {}).get("instances")) or 0)
        comp = _num(stats.get("completeness"))
        if comp is None:
            # 老行没有这个字段。**不判**（宁可漏报），但也不算「已检查通过」——
            # 由 expected/actual 兜一手：两者都有时能自己算。
            if expected > 0:
                comp = min(1.0, actual / expected)
            else:
                continue

        if comp < floor:
            gaps.append(Gap(run_type=run_type, account_id=account_id,
                            run_date=run_date, kind="low_completeness",
                            completeness=comp, expected=expected,
                            actual=actual, status=status))

    return CoverageReport(gaps=tuple(gaps), checked=checked,
                          dry_run_skipped=dry_skipped)


@dataclass(frozen=True)
class CoverageStats:
    """打点用的扁平计数。"""

    missing_rows: int = 0
    low_completeness: int = 0
    missing_instances: int = 0
    checked: int = 0
    accounts: dict[str, str] = field(default_factory=dict)
    """`{account_id: kind}` —— 进 EMF 的**非维度**字段，不进维度。"""


def to_stats(report: CoverageReport) -> CoverageStats:
    return CoverageStats(
        missing_rows=len(report.missing_rows),
        low_completeness=len(report.low_completeness),
        missing_instances=sum(g.missing_instances for g in report.gaps),
        checked=report.checked,
        accounts={g.account_id: g.kind for g in report.gaps},
    )
