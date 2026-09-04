"""结构性风险（R2.4）—— 不需要统计推断、判据是属性、日期确定的那一类。

七项规则见 `rules.py`；扫描与指纹去重见 `scan.py`。

与闲置侧（scoring/）的分工：
    scoring     看指标，判「有没有人在用」
    structural  看属性，判「配置本身有没有风险」

两者共用 `ResourceAttrs`，且按 R2.4.3a 在同一轮（`idle` 轮）执行 ——
都只需要 describe 类 API，不值得为结构性风险单开一条调度线。
"""

from inspection.domain.structural.rules import (
    NOT_SCANNED,
    RULES,
    RULE_SERVICES,
    applies_to,
    major_version,
)
from inspection.domain.structural.scan import (
    dedup_ratio,
    fingerprint_of,
    group_by_fingerprint,
    scan_structural,
    sort_findings,
)

__all__ = [
    "NOT_SCANNED",
    "RULES",
    "RULE_SERVICES",
    "applies_to",
    "dedup_ratio",
    "fingerprint_of",
    "group_by_fingerprint",
    "major_version",
    "scan_structural",
    "sort_findings",
]
