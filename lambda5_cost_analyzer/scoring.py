"""成本异常评分核心逻辑。

实现 SKILL.md 第 5 节定义的多因子异常评分公式、置信度分级和预计额外成本计算。

评分公式:
    anomaly_score = 0.30 × 统计偏离度得分
                  + 0.30 × 账号影响力得分
                  + 0.25 × 持续性得分
                  + 0.15 × 加速度得分

结果 clamp 到 0-100 范围。
"""

from __future__ import annotations


def _score_statistical_deviation(std_dev: float, baseline_avg: float, recent_3d_avg: float) -> float:
    """统计偏离度得分 (0-100)。

    基于近 3 天均值相对基线的 σ 偏离程度:
        <2σ → 0, 2σ → 40, 3σ → 70, 4σ+ → 100
    线性插值中间值。若 std_dev 为 0，偏离即视为 0。
    """
    if std_dev <= 0:
        return 0.0

    sigma_multiple = (recent_3d_avg - baseline_avg) / std_dev

    if sigma_multiple < 2.0:
        return 0.0
    elif sigma_multiple <= 3.0:
        # 2σ=40, 3σ=70 → linear interpolation
        return 40.0 + (sigma_multiple - 2.0) * 30.0
    elif sigma_multiple <= 4.0:
        # 3σ=70, 4σ=100 → linear interpolation
        return 70.0 + (sigma_multiple - 3.0) * 30.0
    else:
        return 100.0


def _score_account_impact(recent_3d_avg: float, baseline_avg: float, account_daily_avg: float) -> float:
    """账号影响力得分 (0-100)。

    近 3 天日均增量占账号日均总成本的比例:
        <0.5% → 0, 1% → 30, 3% → 60, 5%+ → 100
    线性插值中间值。
    """
    if account_daily_avg <= 0:
        return 0.0

    delta = recent_3d_avg - baseline_avg
    if delta <= 0:
        return 0.0

    impact_pct = (delta / account_daily_avg) * 100.0

    if impact_pct < 0.5:
        return 0.0
    elif impact_pct <= 1.0:
        # 0.5%=0, 1%=30 → linear interpolation
        return (impact_pct - 0.5) * 60.0
    elif impact_pct <= 3.0:
        # 1%=30, 3%=60 → linear interpolation
        return 30.0 + (impact_pct - 1.0) * 15.0
    elif impact_pct <= 5.0:
        # 3%=60, 5%=100 → linear interpolation
        return 60.0 + (impact_pct - 3.0) * 20.0
    else:
        return 100.0


def _score_persistence(consecutive_days: int) -> float:
    """持续性得分 (0-100)。

    连续超出基线阈值的天数:
        1天=10, 2天=30, 3天=50, 5天=80, 7天=100
    线性插值中间值。0 天 → 0。
    """
    if consecutive_days <= 0:
        return 0.0

    # Define breakpoints: (days, score)
    breakpoints = [(1, 10.0), (2, 30.0), (3, 50.0), (5, 80.0), (7, 100.0)]

    if consecutive_days >= 7:
        return 100.0

    # Find the interval
    for i in range(len(breakpoints) - 1):
        d1, s1 = breakpoints[i]
        d2, s2 = breakpoints[i + 1]
        if consecutive_days <= d2:
            if consecutive_days < d1:
                # Below first breakpoint but > 0 → interpolate from (0, 0) to (1, 10)
                return consecutive_days * 10.0
            # Linear interpolation between breakpoints
            return s1 + (consecutive_days - d1) * (s2 - s1) / (d2 - d1)

    return 100.0


def _score_acceleration(daily_changes: list[float]) -> float:
    """加速度得分 (0-100)。

    基于近 3 天日环比变化序列判断增长趋势:
        递减=0, 持平=30, 递增=70, 加速递增=100

    daily_changes: 近 3 天的日环比变化值列表 (至少需要 2 个值来判断趋势)。
    """
    if len(daily_changes) < 2:
        return 30.0  # 数据不足，视为持平

    # 取最后两个变化值判断趋势
    recent = daily_changes[-2:]
    diffs = [recent[i + 1] - recent[i] for i in range(len(recent) - 1)]

    # 判断整体趋势
    all_positive = all(d > 0 for d in daily_changes)
    all_negative = all(d < 0 for d in daily_changes)
    accelerating = all(d > 0 for d in diffs) and all_positive

    if all_negative:
        return 0.0
    elif accelerating:
        return 100.0
    elif all_positive:
        return 70.0
    elif all(abs(d) < 0.01 for d in daily_changes):
        return 30.0
    else:
        # Mixed signals
        positive_count = sum(1 for d in daily_changes if d > 0)
        if positive_count > len(daily_changes) / 2:
            return 70.0
        elif positive_count == 0:
            return 0.0
        else:
            return 30.0


def compute_anomaly_score(
    service_stats: dict,
    account_daily_avg: float,
) -> float:
    """多因子异常评分（满分 100）。

    评分公式 (SKILL.md 第 5.2 节):
        anomaly_score = 0.30 × 统计偏离度得分
                      + 0.30 × 账号影响力得分
                      + 0.25 × 持续性得分
                      + 0.15 × 加速度得分

    Args:
        service_stats: 服务统计数据字典，包含:
            - baseline_daily_avg: 基线日均成本
            - recent_3d_avg: 近 3 天日均成本
            - std_dev: 标准差
            - consecutive_days_above: 连续超阈值天数
            - daily_changes: 近 3 天日环比变化列表
        account_daily_avg: 账号 30 天日均总成本

    Returns:
        anomaly_score: 0-100 范围内的评分
    """
    baseline_avg = service_stats.get("baseline_daily_avg", 0.0)
    recent_3d_avg = service_stats.get("recent_3d_avg", 0.0)
    std_dev = service_stats.get("std_dev", 0.0)
    consecutive_days = service_stats.get("consecutive_days_above", 0)
    daily_changes = service_stats.get("daily_changes", [])

    stat_score = _score_statistical_deviation(std_dev, baseline_avg, recent_3d_avg)
    impact_score = _score_account_impact(recent_3d_avg, baseline_avg, account_daily_avg)
    persist_score = _score_persistence(consecutive_days)
    accel_score = _score_acceleration(daily_changes)

    raw_score = (
        0.30 * stat_score
        + 0.30 * impact_score
        + 0.25 * persist_score
        + 0.15 * accel_score
    )

    # Clamp to 0-100
    return max(0.0, min(100.0, raw_score))


def classify_confidence(
    score_details: dict,
    driver_contribution: float,
) -> str:
    """置信度分级: High / Medium / Low。

    SKILL.md 第 5.4 节规则:
        High: 满足以下至少 2 项 — 统计偏离显著(>=3σ)、账号影响力显著(>=1%)、
              下钻驱动项贡献 >= 60%
        Medium: 满足以上任意 1 项，且有明确驱动项
        Low: 仅检测到偏离，但驱动项分散、周期性不清晰或证据不足

    Args:
        score_details: 评分细节字典，包含:
            - sigma_multiple: σ 偏离倍数
            - impact_pct: 账号影响力百分比
        driver_contribution: 主驱动项贡献百分比 (0-100)

    Returns:
        "High", "Medium", 或 "Low"
    """
    sigma_multiple = score_details.get("sigma_multiple", 0.0)
    impact_pct = score_details.get("impact_pct", 0.0)

    criteria_met = 0
    if sigma_multiple >= 3.0:
        criteria_met += 1
    if impact_pct >= 1.0:
        criteria_met += 1
    if driver_contribution >= 60.0:
        criteria_met += 1

    if criteria_met >= 2:
        return "High"
    elif criteria_met >= 1 and driver_contribution > 0:
        return "Medium"
    else:
        return "Low"


def compute_projected_7d_extra(recent_3d_avg: float, baseline_daily_avg: float) -> float:
    """预计 7 天额外成本。

    SKILL.md 第 5.5 节:
        projected_7d_extra_cost = max(近 3 天均值 - 基线日均, 0) × 7

    Args:
        recent_3d_avg: 近 3 天日均成本
        baseline_daily_avg: 基线日均成本

    Returns:
        预计 7 天额外成本 (非负)
    """
    delta = recent_3d_avg - baseline_daily_avg
    return max(delta, 0.0) * 7.0
