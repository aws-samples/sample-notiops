---
name: sp-ri-coverage-analysis
name-en: Savings Plans / RI Coverage
name-zh: 储蓄计划 / RI 覆盖分析
description-en: Analyze AWS Savings Plans and Reserved Instance coverage and utilization to find on-demand spend that should be covered by a commitment. Produces a coverage report with a recommended commitment, estimated monthly savings, and payback period.
description-zh: 分析 AWS 储蓄计划（Savings Plans）与预留实例（RI）的承诺覆盖率和利用率，找出本应被承诺折扣覆盖的按需（On-Demand）支出。产出覆盖率报告、建议的承诺方案、预估每月节省额与回本周期。
description: Analyze AWS Savings Plans and Reserved Instance commitment coverage and utilization to find on-demand spend that should be covered by a commitment. Use when the user asks about Savings Plans, Reserved Instances, RI/SP coverage, commitment utilization, how much they could save with a Savings Plan, or why compute costs are high. Produces a coverage report with a recommended commitment, estimated monthly savings, and payback period.
---

# Savings Plans & RI Coverage Analysis

You are performing a **read-only** FinOps commitment-coverage review. Every number you
report MUST come from a tool call — never estimate, never invent pricing. State clearly
that recommendations are advisory and that you will not purchase anything.

## When to use
- The user asks about Savings Plans (SP), Reserved Instances (RI), commitment coverage,
  utilization, or "how much can I save".
- Compute (EC2 / Fargate / Lambda) on-demand spend looks high and you want to check whether
  a commitment would help.

## Steps

1. **Establish the spend baseline.** Use the Cost Explorer tools to pull the last full
   month of compute cost, grouped by usage type and purchase option (On-Demand vs
   Savings Plan vs Reserved). Note the share still running On-Demand — that is the
   addressable opportunity.
2. **Read current coverage.** Pull Savings Plans coverage and Reserved Instance coverage
   for the trailing 30 days. Record the coverage % and the uncovered On-Demand hours.
3. **Read current utilization.** Pull Savings Plans utilization and RI utilization. A
   commitment that is *under-utilized* (below ~95%) is already being wasted — flag it and
   do NOT recommend buying more of the same until the existing commitment is fully used.
4. **Get the recommendation.** Use the Cost Explorer Savings Plans purchase recommendation
   tool (Compute SP, 1-year, No Upfront as the default lens; also note 3-year if asked).
   Capture: recommended hourly commitment, estimated monthly savings, estimated savings %,
   and estimated payback/break-even.
5. **Sanity-check.** If recommended savings are trivial (<5%) or coverage is already high
   (>85%) with good utilization, say so plainly — the honest answer may be "you're already
   well covered."

## Report format

Produce a short report with:

| Metric | Value | Source |
|---|---|---|
| Last-month compute spend | $X | Cost Explorer |
| On-Demand share | X% | Cost Explorer |
| Current SP coverage | X% | SP Coverage |
| Current SP utilization | X% | SP Utilization |
| Recommended commitment | $Y/hr Compute SP, 1yr No-Upfront | SP Recommendation |
| Estimated monthly savings | $Z (~X%) | SP Recommendation |
| Estimated payback | N months | SP Recommendation |

Then: **Recommendation** (2-3 sentences, plain language), **Caveats** (utilization risk,
workload stability, term lock-in), and **Next step** (offer to save a full report and to
open a Support case with an SP specialist if they want validation).

## Guardrails
- Read-only. You never purchase, modify, or delete anything.
- All dollar figures and percentages are quoted directly from tool output, with the source
  named. If a tool returns no data, say the data is unavailable rather than guessing.
- Commitments are a multi-month/multi-year financial decision — frame savings as *estimates*
  and recommend the customer validate against their own roadmap before committing.
