"""从 run 的 `stats` 里导出告警信号（R11c.3）。

## 为什么是 domain 层的纯函数

「什么算静默失败」是**判据**不是管道。放进 Lambda handler 会让它只能靠真
AWS 客户端才跑得到，于是这一段永远没有测试 —— 而它恰恰是「出事时唯一会
叫的那个东西」。本文件零 IO、零 boto3（CI 的 `inspection-tests` job 故意不装
boto3），打点在 `inspection/adapters/metrics.py`。

## 五条告警的判据（R11c.3）

```
P1  连续 2 天全账号失败          RunSucceeded 的日 Sum == 0，连续 2 天
P1  run success 但零产出         ★ 见下，判据不是「零 finding」
P2  单账号 completeness < 95%    Completeness 的 Minimum
P2  派发失败率 > 10%             DispatchFailureRatio
P3  DA 额度 > 80%                DaQuotaUsedRatio（调度器侧）
```

## ★ 「success 但零产出」的判据是 `series_written == 0`，不是 `findings == 0`

R11c.3 的注释指向 R3.6 那类失效：Redis 指标名写错 → 静默零命中。追下去它的
真实表现是：

```
GetMetricData 返回 HTTP 200 但空数据点
  → 那一批**不算失败**（`batches_failed` 不涨）
  → `evaluated_instance_ids = attempted − 失败批次的实例` 把它算成「已评估」
  → actual == expected
  → terminal_status() == "success"
```

所以 `status` 与 `completeness` 都是绿的，**唯一异常的是 `series_written == 0`**。

⚠️ 反过来，用 `findings == 0` 当判据是错的：本轮真的没有风险时 findings 也是
0，那是**健康**状态（看板上就写着「本轮未发现风险」）。拿它告警会让告警在
一切正常时天天响，两周后没人再看。

## ⚠️ `dry_run` 轮必须整段跳过派发类指标

预演刻意「照常算、不真发」：`built_tasks > 0` 而 `dispatched_tasks == 0`。
按公式算出的派发失败率是 **100%** —— 于是每做一次预演就误报一次 P2，
而预演正是上线灰度第 ① 段每天都要做的事（12.4）。

## ⚠️ 缺键 ≠ 0

`build_stats` 的 `dispatch` 默认值（失败早退路径）**没有** `mapped_tasks` /
`built_tasks` / `agent_space_id` 三个键。把缺失当 0 会让失败 run 的派发失败率
算成 `0/0` 然后被当作健康。所以这里用 `None` 表达「没有这个数」，
派发比率在分母不可知时返回 `None`，调用方不打这个点。
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Mapping

RUN_STATUS_SUCCESS = "success"
"""与 `inspection/adapters/store.py` 的同名常量一致。

⚠️ 不 import 那个模块：`store.py` 顶层 import botocore，而本文件要能在
「只有 stdlib」的环境里被 import（打点是失败路径上最后还能工作的东西）。
两处分叉的代价由 `test_inspection_observability.py` 的元断言兜住。
"""

COMPLETENESS_ALARM_PCT = 95.0
"""R11c.3 的 P2 门槛。判据是**最小值** < 95 —— 见 `emit` 侧的说明。"""

DISPATCH_FAILURE_ALARM_PCT = 10.0
"""R11c.3 的 P2 门槛。"""

QUOTA_ALARM_PCT = 80.0
"""R11c.3 的 P3 门槛。"""


def _num(value: Any) -> float | None:
    """DDB 读回来的数是 `Decimal`，内存里是 `int`/`float`。都收，其余返回 None。

    ⚠️ `bool` 必须先拦掉：`isinstance(True, int)` 为真，而
    `stats["dispatch"]["heartbeat"]` 就是个 bool。让它当成 1 会让
    「有没有心跳」混进计数里。
    """
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    return None


@dataclass(frozen=True)
class RunSignals:
    """一轮 run 的告警信号。`None` 一律表示「这个数不可知」，不是 0。"""

    run_type: str
    account_id: str
    status: str
    dry_run: bool

    succeeded: bool
    """`status == success`。P1「连续 2 天全账号失败」数的是它的反面。"""

    zero_output: bool
    """★ success 且评估过实例但**一条序列都没写**（R3.6 那类静默失效）。"""

    completeness_pct: float | None
    """0~100。`None` = stats 里没有这个数（老行 / 失败早退）。"""

    dispatch_attempted: int | None
    """本轮**试图**派发的条数 = built_tasks + (心跳 1 条)。`None` = 不可知。"""

    dispatch_failed: int | None
    """`CreateBacklogTask` 抛异常没发出去的条数。"""

    dispatch_unmapped: int | None
    """发出去了但没落映射 → 那些判读**永久**回不来。"""

    @property
    def dispatch_failure_pct(self) -> float | None:
        """派发失败率（0~100）。

        分母为 0 或不可知时返回 `None` —— 本轮压根没有要派的东西，
        「失败率 0%」和「失败率无意义」是两回事，前者会让告警看起来健康。
        """
        if self.dry_run:
            return None
        if not self.dispatch_attempted or self.dispatch_failed is None:
            return None
        return 100.0 * self.dispatch_failed / self.dispatch_attempted


def signals_from_stats(
    stats: Mapping[str, Any], *, run_type: str, account_id: str,
) -> RunSignals:
    """`build_stats()` 的产物 → 告警信号。

    ⚠️ 只读不算：这里出现的每个数都能在 `stats` 里逐字找到。
    在这里补算一个百分比意味着同一个数字有两个来源（看板那份走 BFF），
    而两处必然分叉 —— 分叉的表现是告警说 94% 而看板说 96%。
    """
    status = str(stats.get("status") or "")
    dry_run = bool(stats.get("dry_run"))
    actual = stats.get("actual") or {}
    expected = stats.get("expected") or {}
    dispatch = stats.get("dispatch") or {}

    evaluated = _num(actual.get("instances")) or 0.0
    series_written = _num(actual.get("series_written"))
    succeeded = status == RUN_STATUS_SUCCESS

    # ★ 判据：success + 评估过实例 + 一条序列都没写。
    #   `series_written` 缺失（老行）时**不判**零产出 —— 宁可漏报也不能
    #   因为字段没落库就把历史行全部报成故障。
    zero_output = bool(
        succeeded
        and evaluated > 0
        and (_num(expected.get("instances")) or 0.0) > 0
        and series_written == 0.0
    )

    comp = _num(stats.get("completeness"))
    completeness_pct = None if comp is None else max(0.0, min(100.0, comp * 100.0))

    built = _num(dispatch.get("built_tasks"))
    sent = _num(dispatch.get("dispatched_tasks"))
    mapped = _num(dispatch.get("mapped_tasks"))
    heartbeat = 1.0 if dispatch.get("heartbeat") else 0.0

    attempted: int | None = None
    failed: int | None = None
    if built is not None:
        # 派发循环真实遍历的是 `list(tasks) + ([hb] if hb else [])`，
        # 所以分母必须把心跳那一条算进去，否则「只有心跳且它失败了」
        # 会算成 0/0 被当成健康。
        attempted = int(built + heartbeat)
        if sent is not None:
            failed = max(0, attempted - int(sent))

    unmapped: int | None = None
    if sent is not None and mapped is not None:
        unmapped = max(0, int(sent) - int(mapped))

    return RunSignals(
        run_type=run_type,
        account_id=account_id,
        status=status,
        dry_run=dry_run,
        succeeded=succeeded,
        zero_output=zero_output,
        completeness_pct=completeness_pct,
        dispatch_attempted=attempted,
        dispatch_failed=failed,
        dispatch_unmapped=unmapped,
    )
