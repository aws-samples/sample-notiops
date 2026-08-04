---
name: cost-spike-triage
name-en: Cost Spike Triage
name-zh: 成本突增排查
description-en: Triage a sudden AWS bill spike to find the root cause — which service, usage type, region, and account/resource drove the change between two periods. Produces a ranked delta breakdown with the likely driver and next steps.
description-zh: 排查 AWS 账单突然上涨的根因——定位是哪个服务、用量类型、区域，以及（可获取时）哪个账号或资源导致了两个周期之间的变化。产出按影响排序的差异明细、最可能的诱因与下一步建议。
description: Triage a sudden AWS cost increase or bill spike to find the root cause — which service, usage type, region, and (where available) which account or resource drove the change between two periods. Use when the user says their AWS bill went up, costs spiked, there's a cost anomaly, spend is higher than expected, or asks why this month costs more than last month. Produces a ranked breakdown of the delta with the most likely driver and next steps.
---

# Cost Spike Triage

You are performing a **read-only** cost root-cause investigation. You explain *what changed*
and *why*, backed entirely by Cost Explorer data. You do not change any resource.

## When to use
- "My bill went up", "costs spiked", "cost anomaly", "why is this month more expensive than
  last month", "spend is higher than expected".

## Steps

1. **Confirm the window.** Establish the two periods to compare (e.g. this month vs last
   month, or the anomaly week vs the prior week). If ambiguous, default to current month vs
   previous month and state that.
2. **Top-level delta by service.** Pull unblended cost for both periods grouped by service.
   Compute the per-service delta and rank by absolute increase — this usually names the
   culprit service in one step.
3. **Drill into the top mover(s).** For the service with the biggest increase, group by
   **usage type** (and by **region** if relevant) across the two periods to see exactly which
   dimension grew (e.g. NAT gateway data processing, cross-AZ transfer, GB-months of storage,
   instance hours of a specific family).
4. **Check anomalies.** If a cost anomaly detection tool is available, pull recent anomalies
   for corroboration and to catch spikes the period-comparison smooths over.
5. **Attribute where possible.** If the account is a payer, group by linked account to point
   at the account that grew. Note that resource-level attribution may require CUR/Athena.

## Report format

Lead with the headline: **"$X increase (+Y%), primarily driven by <service> / <usage type>."**
Then:

| Rank | Service | Prev | Current | Δ | Δ% | Likely driver |
|---|---|---|---|---|---|---|

Follow with a short **root-cause narrative** (2-4 sentences) and **next steps** (what to
verify, whether a Savings Plan or right-sizing would help, offer to open a Support case if it
looks like unexpected charges). Offer to save the full report.

## Guardrails
- Read-only. Every figure comes from Cost Explorer output, with the period stated.
- Distinguish a real usage increase from a pricing/credit expiry — call out when the delta
  looks like an expiring discount rather than new usage.
- If data for a period is incomplete (current month not closed), say the current-month figure
  is partial/run-rate, not final.
