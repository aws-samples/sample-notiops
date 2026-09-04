"""连续低位天数 —— R4.1b。

老实现 `engine.calculate_consecutive_low_days` 在函数内部调
`shared.queries.metrics.get_monitoring_history()` 读 DDB，于是：
  · 违反 R14.1「domain 层零 IO」
  · 把 IO 传染给了调用它的 `calculate_enhanced_scores`
  · 单测必须 patch 模块路径才能跑（tests/test_engine.py 有 5 处这种 patch）
  · 依赖 Phase 4 要删的 `notiops-metrics` 表

改成纯函数：日序列由 repository 层读好后作为入参传进来。
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from inspection.domain.dto import IdleRuleConfig


def count_consecutive_low(
    daily_rows: Sequence[dict[str, Any]],
    cfg: IdleRuleConfig,
) -> int:
    """从最近一天往前回溯，数连续满足「CPU 低 AND 连接少」的天数。

    Args:
        daily_rows: 日聚合行，**必须按日期倒序**（最近一天在 [0]）。
            每行需含 `cpu_utilization` 与 `connections`。
            这个顺序契约与老实现依赖的 `get_monitoring_history(...)`
            （`ScanIndexForward=False`）一致。
        cfg: 门槛来源。

    Returns:
        0 ~ len(daily_rows)，且不超过 cfg.window_days。

    数据缺失即中断计数（不跳过、不外插）—— 「昨天没数据」不能当成
    「昨天也是低位」，否则连续天数会被凭空拉长，value_score 跟着虚高。
    """
    if not daily_rows:
        return 0

    limit = min(len(daily_rows), cfg.window_days)
    consecutive = 0

    for row in list(daily_rows)[:limit]:
        cpu = row.get("cpu_utilization")
        conns = row.get("connections")
        if cpu is None or conns is None:
            break
        if cpu <= cfg.candidate_cpu_avg and conns <= cfg.candidate_connections:
            consecutive += 1
        else:
            break

    return consecutive


def count_consecutive_high(
    daily_values: Sequence[float | None],
    threshold: float,
    bad_up: bool,
    window_days: int | None = None,
) -> int:
    """R2.6 慢性高位：水位持续处于坏侧的天数。

    Args:
        daily_values: 日值，**按日期倒序**（最近一天在 [0]）。
        threshold: 门槛。
        bad_up: True = 越大越坏（CPU / Swap）；False = 越小越坏（FreeableMemory）。
        window_days: 窗口上限。`None` = 不截断（数完传进来的全部）。

    与 `count_consecutive_low` 同样在 None 处中断。

    ⚠️ `window_days` 是后补的，补的原因是**它与 `count_consecutive_low` 曾经不一致**：
    后者有 `limit = min(len(daily_rows), cfg.window_days)` 截断，前者没有。
    v1 窗口恒为 7 天时两者等价，所以这个差异不会表现出来；v1.1 把窗口改成 28 天
    之后，「连续高位 19 天」会在一个 7 天窗口的规则语义下凭空出现 ——
    返回值超出调用方以为的取值范围，而且不会报错。
    默认 `None`（不截断）是为了不改既有调用方行为；**生产调用方 SHALL 显式传**。
    """
    values = list(daily_values)
    if window_days is not None:
        if window_days <= 0:
            return 0
        values = values[:window_days]
    consecutive = 0
    for value in values:
        if value is None:
            break
        crossed = value > threshold if bad_up else value < threshold
        if crossed:
            consecutive += 1
        else:
            break
    return consecutive
