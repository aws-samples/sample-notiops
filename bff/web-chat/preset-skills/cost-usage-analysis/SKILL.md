---
name: cost-usage-analysis
name-en: Cost & Usage Analysis
name-zh: 成本与用量分析
description-en: Analyze AWS cost and usage for a given time window — total spend and trend, breakdown by service and usage type, anomalies, and savings recommendations ranked by estimated impact.
description-zh: 按指定时间段分析 AWS 成本与用量——总支出与趋势、按服务和用量类型的拆分、异常，以及按预计节省金额排序的优化建议。
description: Analyze AWS cost and usage for a given time window — total spend and the change versus the previous period, breakdown by service and usage type, anomalies, and savings recommendations ranked by estimated impact. Use when the user asks how much they spent over a period, wants a cost or usage analysis or report for a time range (last month, this quarter, specific dates), or asks for cost optimization recommendations. Read-only.
---

# Cost & Usage Analysis

You are performing a **read-only**, decision-oriented cost and usage analysis for a time window.
Every figure you report MUST come from a tool result — never estimate, never invent pricing.
You do not change any resource.

## When to use
- "How much did we spend last month", "analyze our cost and usage for Q3", "cost report for
  2026-09-01 to 2026-09-30", "where is our money going and how do we cut it".
- For "why did the bill jump between two periods", prefer `/cost-spike-triage`; for
  commitments, `/sp-ri-coverage-analysis`; for idle resources, `/idle-resource-scan`.

## Steps

1. **Fix the window.** Turn relative phrases ("last month", "this quarter", "last week") into
   absolute start/end dates (YYYY-MM-DD) from the current date, and state the range at the top
   of the reply. No window given → default to the last 30 days and say so. Cost Explorer dates
   are UTC and the end date is exclusive (to include Sep 30, query up to Oct 1).
2. **Pick the comparison period.** A calendar month or quarter → the previous calendar month
   or quarter. Any other range → the same number of days immediately before it. If the window
   reaches today, compare like for like (e.g. Oct 1–23 vs Sep 1–23), say the current period is
   partial, and treat the most recent day as possibly incomplete. When the two periods differ in
   length, compare daily averages as well.
3. **Overview.** Total unblended cost for each period, the daily average, and the change
   (amount and %). Group by record type first: show credits, refunds, tax and discounts as
   separate lines, so that a credit or an expiring discount is not mistaken for a change in usage.
4. **By service.** The top 5–10 services by usage cost, with amount, share and change. If this
   is a payer / management account, also show the top linked accounts.
5. **By usage.** For the biggest movers, group by usage type (and region if relevant) to name
   the drivers — instance hours by family, storage GB-months, requests, data transfer.
6. **Anomalies.** If a cost anomaly tool is available, pull the anomalies in the window; also
   flag services or usage types that moved sharply versus the comparison period.
7. **Savings opportunities.** Cost Optimization Hub recommendations and, where the tools are
   available, Savings Plans / RI coverage and utilization and rightsizing. Use the savings
   figures the tools return; if a recommendation comes without an estimate, say so instead of
   estimating.

Keep the queries lean: monthly granularity for windows longer than about two months, daily only
when you need the trend; one or two group-by dimensions at a time, top N only. Use CUR (if
connected) for resource-level detail. If a data source or tool is unavailable, say which one and
continue with what you have.

## Report format

1. **One-line conclusion**: the window, the total, the change and the main drivers
   (e.g. "Sep 2026: $X, +12% vs Aug (daily average +9%), mostly EC2 and data transfer").
2. **Breakdown table**:

| Service | This period | Previous period | Change | Share |
|---|---|---|---|---|

3. **Credits, refunds, tax and discounts** (if any), as separate lines.
4. **Notable points**: anomalies, spikes and obvious waste, each with its dollar impact.
5. **Recommendations**: 3–5 concrete actions ordered by estimated savings (highest first),
   each with what to do, the estimated impact (from the tools) and the risk.
6. **Gaps**: any dimension you could not cover, and why.

Offer to save the full report.

## Guardrails
- Read-only: analyze and recommend; the user decides what to change.
- Never invent cost or savings figures. State the currency the tools return (normally USD) and
  the cost basis (unblended).
- Lead with conclusions and tables; do not paste raw tool output.
