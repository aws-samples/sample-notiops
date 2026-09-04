"""否决规则 —— 承接老 `engine.peak_veto` 与 `engine.hidden_load_check`。

R2.2.1 低利用率是 **AND 语义**：必须所有条件都满足才算闲。
否决规则是这个 AND 的实现方式 —— 任一条「其实它在忙」的证据成立就踢出候选。

⚠️ OR 语义会把「平时空闲、每晚跑批打满」的实例误判为闲置，那是最容易被客户
抓到的一类误报。peak_veto 就是防这个的（R2.2.2）。

与老实现的差异：
  · 返回 VetoResult 而不是过滤后的 list —— 被否决的实例要能在 UI 上说清为什么
    没进闲置清单（老实现只往 logger 写一行，客户看不到）
  · 区分「确认不忙」与「缺数据保守放行」（老实现两者都只是留在 list 里，
    看不出区别；而后者其实是一条可观测性缺口，R3.5 要求上报）
  · 吃 IdleRuleConfig 而不是 dict[str, ThresholdConfig]
  · 只出 code + 数值，不出文案（R10.9 i18n）
"""

from __future__ import annotations

from inspection.domain.dto import (
    CandidateRecord,
    IdleRuleConfig,
    VetoOutcome,
    VetoReason,
    VetoResult,
)

RULE_PEAK = "peak_veto"
RULE_HIDDEN_LOAD = "hidden_load_check"


def peak_veto(candidate: CandidateRecord, cfg: IdleRuleConfig) -> VetoResult:
    """窗口内 CPU 峰值超过门槛 → 它有业务高峰，不是闲置资源。

    `peak_cpu_7d` 为 None 时放行（数据缺失保守处理，与老实现一致），
    但结果标成 PASS_NO_DATA 而不是 PASS —— 调用方要能区分。
    """
    peak = candidate.peak_cpu_7d
    if peak is None:
        return VetoResult(
            candidate.instance_id, RULE_PEAK, VetoOutcome.PASS_NO_DATA,
            params={"missing": ["peak_cpu_7d"]},
        )

    params = {"peak_cpu": peak, "threshold": cfg.peak_cpu_veto}
    if peak > cfg.peak_cpu_veto:
        return VetoResult(
            candidate.instance_id, RULE_PEAK, VetoOutcome.VETOED,
            reason=VetoReason.PEAK_VETO, params=params,
        )
    return VetoResult(
        candidate.instance_id, RULE_PEAK, VetoOutcome.PASS, params=params
    )


def hidden_load_check(candidate: CandidateRecord, cfg: IdleRuleConfig) -> VetoResult:
    """CPU 低但实际在干活的情形 —— CPU 不是唯一的忙碌证据。

    RDS         IOPS 高（读写都算）或 WriteIOPS 高
    ElastiCache 有驱逐 / 请求量高 / 连接峰值高
    """
    iid = candidate.instance_id

    if candidate.service == "rds":
        return _check_rds(iid, candidate, cfg)
    if candidate.service == "elasticache":
        return _check_elasticache(iid, candidate, cfg)

    return VetoResult(
        iid, RULE_HIDDEN_LOAD, VetoOutcome.PASS_NO_RULE,
        params={"service": candidate.service},
    )


def _check_rds(
    iid: str, cand: CandidateRecord, cfg: IdleRuleConfig
) -> VetoResult:
    if cand.read_iops is None and cand.write_iops is None and cand.write_iops_avg is None:
        return VetoResult(
            iid, RULE_HIDDEN_LOAD, VetoOutcome.PASS_NO_DATA,
            params={"missing": ["ReadIOPS", "WriteIOPS"]},
        )

    total_iops = (cand.read_iops or 0.0) + (cand.write_iops or 0.0)
    if total_iops > cfg.iops_total:
        return VetoResult(
            iid, RULE_HIDDEN_LOAD, VetoOutcome.VETOED,
            reason=VetoReason.IO_INTENSIVE,
            params={"metric": "iops_total", "value": total_iops,
                    "threshold": cfg.iops_total},
        )
    if cand.write_iops_avg is not None and cand.write_iops_avg > cfg.write_iops:
        return VetoResult(
            iid, RULE_HIDDEN_LOAD, VetoOutcome.VETOED,
            reason=VetoReason.IO_INTENSIVE,
            params={"metric": "write_iops_avg", "value": cand.write_iops_avg,
                    "threshold": cfg.write_iops},
        )
    return VetoResult(
        iid, RULE_HIDDEN_LOAD, VetoOutcome.PASS,
        params={"iops_total": total_iops, "threshold": cfg.iops_total},
    )


def _check_elasticache(
    iid: str, cand: CandidateRecord, cfg: IdleRuleConfig
) -> VetoResult:
    has_any = any(
        v is not None
        for v in (cand.evictions, cand.cache_hits, cand.cache_misses,
                  cand.peak_connections_7d)
    )
    if not has_any:
        return VetoResult(
            iid, RULE_HIDDEN_LOAD, VetoOutcome.PASS_NO_DATA,
            params={"missing": ["Evictions", "CacheHits", "CacheMisses",
                                "CurrConnections"]},
        )

    if cand.evictions is not None and cand.evictions > cfg.evictions:
        return VetoResult(
            iid, RULE_HIDDEN_LOAD, VetoOutcome.VETOED,
            reason=VetoReason.EVICTING,
            params={"metric": "evictions", "value": cand.evictions,
                    "threshold": cfg.evictions},
        )

    if cand.cache_hits is not None or cand.cache_misses is not None:
        total_req = (cand.cache_hits or 0.0) + (cand.cache_misses or 0.0)
        if total_req > cfg.requests_per_minute:
            return VetoResult(
                iid, RULE_HIDDEN_LOAD, VetoOutcome.VETOED,
                reason=VetoReason.REQUEST_BUSY,
                params={"metric": "requests_per_minute", "value": total_req,
                        "threshold": cfg.requests_per_minute},
            )

    if (
        cand.peak_connections_7d is not None
        and cand.peak_connections_7d > cfg.conn_max
    ):
        return VetoResult(
            iid, RULE_HIDDEN_LOAD, VetoOutcome.VETOED,
            reason=VetoReason.CONN_BUSY,
            params={"metric": "peak_connections", "value": cand.peak_connections_7d,
                    "threshold": cfg.conn_max},
        )

    return VetoResult(iid, RULE_HIDDEN_LOAD, VetoOutcome.PASS)


def apply_vetoes(
    candidate: CandidateRecord, cfg: IdleRuleConfig
) -> tuple[bool, tuple[VetoResult, ...]]:
    """跑全部否决规则，返回 (是否通过, 全部规则的明细)。

    ⚠️ 不短路 —— 全部跑完才返回。报告里要能说「它同时有业务高峰**且** IOPS 高」，
    只报第一条会让客户觉得改掉一条就该进闲置清单了。
    """
    results = (peak_veto(candidate, cfg), hidden_load_check(candidate, cfg))
    return all(r.passed for r in results), results


def veto_reasons(results: tuple[VetoResult, ...]) -> tuple[VetoReason, ...]:
    """取出全部生效的否决原因，顺序稳定。"""
    return tuple(r.reason for r in results if r.reason is not None)


def has_data_gap(results: tuple[VetoResult, ...]) -> bool:
    """是否有规则因缺数据没跑成 —— R3.5 要求把这类情况当可观测性缺口上报。"""
    return any(r.outcome is VetoOutcome.PASS_NO_DATA for r in results)
