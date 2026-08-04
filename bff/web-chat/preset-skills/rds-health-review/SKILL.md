---
name: rds-health-review
name-en: RDS Health Review
name-zh: RDS 健康检查
description-en: Review the operational health and best-practice posture of Amazon RDS databases — Multi-AZ and backups, storage headroom and autoscaling, right-sizing from CPU/connection metrics, recent failovers, and pending maintenance. Produces a graded review with prioritized findings.
description-zh: 检查 Amazon RDS 数据库的运行健康度与最佳实践合规性——多可用区与备份配置、存储余量与自动扩容、基于 CPU/连接数指标的规格评估、近期故障切换或维护事件，以及待执行的维护。产出带评级的检查报告与按优先级排序的问题项。
description: Review the operational health and best-practice posture of Amazon RDS databases — Multi-AZ and backup configuration, storage headroom and autoscaling, instance right-sizing from CPU and connection metrics, recent failovers or maintenance events, and pending maintenance. Use when the user asks about RDS health, database reliability, whether a database is at risk, RDS best practices, or an RDS performance or availability concern. Produces a graded review with prioritized findings.
---

# RDS Operational Health Review

You are performing a **read-only** RDS best-practice review for one or more databases.
Ground every finding in configuration or metrics returned by a tool — no assumptions.

## When to use
- The user asks about RDS health, reliability, "is this database at risk", best practices,
  or a specific RDS performance / availability concern.

## Steps

1. **Inventory.** List RDS instances (in the relevant region). If the user named one, focus
   there; otherwise review the notable ones.
2. **Per database, describe configuration** and check:
   - **Multi-AZ**: single-AZ prod databases are a resiliency risk → HIGH.
   - **Backups**: automated backups enabled and retention ≥ 7 days; PITR available.
   - **Deletion protection**: on for production.
   - **Public accessibility**: a publicly accessible DB is a security finding → HIGH.
   - **Encryption**: storage encryption enabled.
   - **Engine version**: flag versions near or past end-of-support.
3. **Metrics (trailing 24h-7d):** CPU utilization, freeable memory, free storage space,
   database connections, read/write latency. Use these to judge:
   - **Storage headroom**: free space trending toward zero → HIGH (risk of outage).
   - **Right-sizing**: sustained very low CPU + few connections → oversized (cost); sustained
     high CPU / latency → undersized (performance).
4. **Recent events & pending maintenance:** pull recent RDS events (failovers, storage
   autoscaling, restarts) and any pending maintenance actions.

## Report format

Give each database an overall grade and a findings table:

| Severity | Finding | Evidence | Recommendation |
|---|---|---|---|
| CRITICAL / HIGH / MEDIUM / LOW | … | metric/config from tool | … |

Severity guide: **CRITICAL** = imminent outage/data-loss risk (storage nearly full, no
backups on prod). **HIGH** = single-AZ prod, publicly accessible, EOL engine. **MEDIUM** =
right-sizing, retention < 7d. **LOW** = cosmetic/informational.

Close with the top 3 actions and an offer to save the full report.

## Guardrails
- Read-only: describe and recommend only; never modify a database.
- Every severity call cites the specific metric or config field it's based on.
- If metrics are unavailable for the window, say so instead of guessing the database is fine.
