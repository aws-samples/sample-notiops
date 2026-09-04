"""评分链（R4）—— 从 `lambda2_analyzer/engine.py` 搬迁并修 bug。

    候选实例 ─┬─ veto.apply_vetoes ────────► 被否决（带原因，仍要能在 UI 上解释）
              │
              └─ 通过 ─► idle.score_idle ─► ranking.rank_* ─► 报告

老 engine.py 的对应关系：

    engine.peak_veto                     → veto.peak_veto
    engine.hidden_load_check             → veto.hidden_load_check
    engine.calculate_enhanced_idle_score → idle.score_idle（拆成 per-service + 修 3 个 bug）
    engine.calculate_consecutive_low_days→ lowdays.count_consecutive_low（去 IO，改纯函数）
    engine.get_instance_size_weight      → specs.instance_size_weight
    engine.calculate_enhanced_scores     → idle.score_idle + ranking（IO 出栈）
    engine.estimate_monthly_savings      → pricing.estimate_monthly_savings（价格表入参化）
    engine.capacity_audit                → capacity.scan_capacity
    engine._audit_rds                    → capacity.audit_oversized_storage
    engine._audit_elasticache            → capacity.audit_oversized_memory
    JudgmentResult.value_score（内联字段）→ idle.value_score（提成函数，R4.1）

⚠️ R4.1c 原写「capacity_audit SHALL 并入 scan_structural」，**未照做**。
容量超配必须读指标，而结构性风险按 R2.4.1 是「纯属性判定、零指标」，
`scan_structural(attrs, refdata, cfg, today)` 的签名里也没有指标入参 ——
并进去会同时破掉那条定义和那个签名。它的真实语义是 rightsizing，
输出归②「闲置与优化」，所以留在本包。详见 capacity.py 的模块 docstring。
"""

from inspection.domain.scoring.capacity import (
    AUDITS,
    audit_oversized_memory,
    audit_oversized_storage,
    free_storage_ratio,
    scan_capacity,
    sort_capacity_findings,
)
from inspection.domain.scoring.idle import (
    SCORERS,
    WEIGHTS_ELASTICACHE,
    WEIGHTS_RDS,
    consecutive_days_factor,
    score_idle,
    supported_services,
    value_score,
)
from inspection.domain.scoring.lowdays import (
    count_consecutive_high,
    count_consecutive_low,
)
from inspection.domain.scoring.pricing import (
    DEFAULT_MONTHLY_USD,
    estimate_monthly_savings,
)
from inspection.domain.scoring.ranking import (
    group_by_service,
    rank_cross_service,
    rank_within_service,
    split_micro,
)
from inspection.domain.scoring.veto import (
    apply_vetoes,
    has_data_gap,
    hidden_load_check,
    peak_veto,
    veto_reasons,
)

__all__ = [
    "AUDITS",
    "SCORERS",
    "WEIGHTS_ELASTICACHE",
    "WEIGHTS_RDS",
    "apply_vetoes",
    "audit_oversized_memory",
    "audit_oversized_storage",
    "consecutive_days_factor",
    "free_storage_ratio",
    "scan_capacity",
    "sort_capacity_findings",
    "count_consecutive_high",
    "count_consecutive_low",
    "DEFAULT_MONTHLY_USD",
    "estimate_monthly_savings",
    "group_by_service",
    "has_data_gap",
    "hidden_load_check",
    "peak_veto",
    "rank_cross_service",
    "rank_within_service",
    "score_idle",
    "split_micro",
    "supported_services",
    "value_score",
    "veto_reasons",
]
