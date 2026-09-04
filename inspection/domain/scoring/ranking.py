"""排序 —— R4.6。

  跨服务   按 estimated_monthly_savings（美元是唯一可比的共同标尺）
  服务内   按 value_score

⚠️ `value_score` 跨服务混排无意义：RDS 与 ElastiCache 的维度集合、权重、
归一化分母全都不同，两个 78 分不是同一个 78 分。
老实现只有一个全局排序，这是它在多服务下的一个真实缺陷。
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from inspection.domain import specs
from inspection.domain.dto import IdleScore


def rank_within_service(scores: Iterable[IdleScore]) -> list[IdleScore]:
    """服务内排序：**先按判据是否充分分桶**，再按 value_score 降序。

    同分用 `(account_id, region, instance_id)` 定序（保证可重放）。

    ⚠️ 分桶的理由与 `rank_cross_service` 对价格可信度分桶完全相同：
    维度缺了一半算出来的分与四维齐全的分**不可比**。
    只剩 cpu 的 RDS 会拿 `eff_w = 1.0`，一台 CPU 1% 但 IOPS 打满
    （只是没采到）的库拿 99 分，排在四维齐全、实测确实闲的 85 分实例前面。
    未判定的（`idle_score is None`）一律沉底。

    ⚠️ tiebreaker 用三元组而不是裸 `instance_id` —— 资源 ID 只在
    (region, service) 内唯一，跨区同名实例用单键排序结果不稳定。
    """
    return sorted(
        scores,
        key=lambda s: (
            not s.is_judged,                     # 未判定的最后
            s.is_degraded,                       # 判据不全的靠后
            -(s.value_score or 0.0),
            s.account_id, s.region, s.instance_id,
        ),
    )


def rank_cross_service(scores: Iterable[IdleScore]) -> list[IdleScore]:
    """跨服务排序：**先按价格可信度分桶，桶内按预计月节省降序**。

    缺价格的排在末尾（而不是当 0 混进中间）。

    ⚠️ 可信度必须是主键，金额只在桶内比较。早期实现只看金额，于是：

    ```
      db-guess    $1000   COARSE_DEFAULT          ← 关键字都没命中，凭空的兜底常数
      cache-real  $1061   TABLE_UNVERIFIED_REGION ← 查表得到的
    ```

    裸按金额排，第一行是那个**凭空捏造**的 $1000，而客户会照着它去动资源。
    分桶之后查表的那条排前面，猜的那条沉到下一桶 —— 金额仍然显示，
    但它不再决定「先看哪个」。

    ⚠️ 桶内才比金额，是因为同一档精度下金额确实可比；跨档不可比。
    """
    return sorted(
        scores,
        key=lambda s: (
            not s.is_judged,                # 判据不足的一律最后
            s.monthly_usd is None,          # 没有价格的次后
            s.savings_confidence_rank,      # 可信度分桶（0 最好）
            -(s.monthly_usd or 0.0),        # 桶内按金额降序
            s.account_id, s.region, s.instance_id,   # 定序，保证可重放
        ),
    )


def group_by_service(scores: Iterable[IdleScore]) -> dict[str, list[IdleScore]]:
    """按服务分组，组内已按 value_score 排好。"""
    buckets: dict[str, list[IdleScore]] = {}
    for s in scores:
        buckets.setdefault(s.service, []).append(s)
    return {svc: rank_within_service(items) for svc, items in sorted(buckets.items())}


def split_micro(
    scores: Sequence[IdleScore], instance_classes: dict[str, str]
) -> tuple[list[IdleScore], list[IdleScore]]:
    """micro 实例单独分组放末尾 —— 承接老 `capacity_audit` 的呈现习惯。

    它们省不下什么钱，混在前面会挤掉真正值钱的条目。

    ⚠️ **判据用 `specs.is_micro()`，不是 `"micro" in cls` 子串匹配。**
    早期实现在这里用子串匹配，而 `capacity.sort_capacity_findings` 用的是
    `specs.is_micro()` —— 同一个概念两套判据，对形如 `db.micro-legacy`
    这种命名会给出相反的分组结果，而报告里那两处的顺序就会互相矛盾。
    """
    non_micro, micro = [], []
    for s in scores:
        cls = instance_classes.get(s.instance_id) or ""
        (micro if specs.is_micro(cls) else non_micro).append(s)
    return non_micro, micro
