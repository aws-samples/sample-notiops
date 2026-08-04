"""Dashboard summary — DDB-native read-time aggregation (boto3 + stdlib).

The dashboard summary is computed on read by aggregating the latest
monitoring snapshot (metrics table) + the latest waste_report, mirroring the
original RDS `SELECT COUNT(*) ... WHERE account/region` semantics. There is
NO materialized summary item: DynamoDB can't GROUP BY, and maintaining a
per-(account,region) rollup would mean combinatorial write amplification for
a low-traffic endpoint at single-account scale.

Access pattern:
  * compute_dashboard_summary -> aggregate metrics + waste_report for a
    given (account, region) slice, defaulting to the latest snapshot date.
"""
from __future__ import annotations


def compute_dashboard_summary(*, account: str | None = None,
                              region: str | None = None) -> dict:
    """Read-time aggregation mirroring the original RDS dashboard summary.

    Resource total/candidates come from the latest monitoring snapshot
    (metrics table, cand_flag); idle total/savings from the latest
    waste_report (is_idle only). account/region filtering is applied
    client-side over the day's rows. The filters dropdown lists ALL distinct
    accounts/regions seen in the monitoring snapshot (pre-filter), matching
    the original `SELECT DISTINCT ... UNION ...`.

    DDB has no server-side COUNT/SUM/GROUP BY, so this is computed in-process
    over the day's partition (bounded; paginated in the query layer).
    """
    # Local imports avoid import-time coupling between query modules.
    from shared.queries import metrics as _metrics
    from shared.queries import waste_report as _waste

    def _match(acct: str, reg: str) -> bool:
        if account and acct != account:
            return False
        if region and reg != region:
            return False
        return True

    result = {
        "rds": {"total": 0, "candidates": 0},
        "elasticache": {"total": 0, "candidates": 0},
        "idle": {"total": 0, "total_savings": 0.0},
        "filters": {"accounts": [], "regions": []},
    }
    accounts_set: set[str] = set()
    regions_set: set[str] = set()

    for rt in ("rds", "elasticache"):
        date = _metrics.get_latest_monitoring_date(rt)
        if not date:
            continue
        total = candidates = 0
        for row in _metrics.query_monitoring_by_date(rt, date):
            acct = str(row.get("account", ""))
            reg = str(row.get("region", ""))
            if acct:
                accounts_set.add(acct)
            if reg:
                regions_set.add(reg)
            if not _match(acct, reg):
                continue
            total += 1
            if int(row.get("cand_flag", 0)) == 1:
                candidates += 1
        result[rt] = {"total": total, "candidates": candidates}

    # Idle totals/savings from the latest waste_report (is_idle only).
    wdate = _waste.get_latest_waste_date()
    if wdate:
        from shared.queries.whitelist import load_whitelist_set
        # 与闲置报告页 (_get_list) 用同一套白名单逻辑，保证两处「闲置实例」数一致。
        wl = load_whitelist_set("waste")
        idle_total = 0
        idle_savings = 0.0
        cursor = None
        while True:
            rows, cursor = _waste.list_waste_reports(
                account_id=account or None, date=wdate, cursor=cursor, limit=200,
            )
            for row in rows:
                reg = str(row.get("region", ""))
                if region and reg != region:
                    continue
                acct = str(row.get("account_id", ""))
                inst = str(row.get("instance_id", ""))
                if (acct, inst) in wl:
                    continue
                idle_total += 1
                sv = row.get("estimated_monthly_savings", row.get("savings", 0)) or 0
                idle_savings += float(sv)
            if not cursor:
                break
        result["idle"] = {"total": idle_total, "total_savings": idle_savings}

    result["filters"] = {
        "accounts": sorted(accounts_set),
        "regions": sorted(regions_set),
    }
    return result
