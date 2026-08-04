---
name: aws-health-events
name-en: AWS Health Event Review
name-zh: AWS Health 事件核查
description-en: Check AWS Health for service events, scheduled changes, and account notifications that may explain or correlate with an operational issue — filtered by service, time window, region, and status. Read-only. Requires a Business/Enterprise/On-Ramp support plan and queries the us-east-1 Health endpoint; data covers the last 90 days.
description-zh: 查询 AWS Health 的服务事件、计划变更与账户通知，找出可能导致或与当前运维问题相关的 AWS 侧事件——可按服务、时间窗、区域与状态过滤。只读。需 Business/Enterprise/On-Ramp 支持计划，且 Health API 仅在 us-east-1，数据覆盖最近 90 天。
description: Check AWS Health for service events, scheduled changes, and account notifications that may explain or correlate with an operational issue — filtered by service, time window, region, and status. Use when investigating service degradation, elevated error rates, latency spikes, connection failures, throttling, or capacity issues to determine whether an AWS-side event is a root cause or contributing factor, or when the user asks for an AWS Health summary/report over a time period. Read-only: it only describes Health events and their affected entities. Requires a Business / Enterprise / Enterprise On-Ramp support plan and queries the us-east-1 Health endpoint; data covers the last 90 days.
---

# AWS Health Event Review

You are performing a **read-only** review of AWS Health. When an incident is under
investigation, check whether an AWS-side event (a service issue, scheduled maintenance, or
account notification) causes or correlates with the observed symptoms. Also use it on demand
to summarize an account's Health events over a time period.

> Note: this skill is adapted for NotiOps from the open-source
> `aws-samples/sample-devops-agent-tools` `aws-health-events` skill, condensed and kept strictly
> read-only (describe/list only — it never modifies anything or opens a case).

## When to use
- Investigating degradation, elevated error rates, latency spikes, connection failures,
  throttling, or capacity issues — and you want to know whether an AWS-side event is the root
  cause or a contributing factor.
- The user asks for an AWS Health summary/report for their account, region, or a service over a
  time window.

## Prerequisites
- The AWS **Health API** requires a **Business / Enterprise / Enterprise On-Ramp** support plan.
  If it's not available (`support_plan_required` / access denied), say exactly that and stop —
  do NOT guess the specific tier.
- The Health API endpoint is **only in us-east-1** — target it regardless of where the affected
  resources live. Data covers the **last 90 days** only.
- Read-only IAM: `health:DescribeEvents`, `DescribeEventDetails`, `DescribeAffectedEntities`,
  `DescribeEventTypes`.

## Steps

1. **Gather incident context.** Affected service(s), timeframe (ISO 8601), specific resource IDs,
   region/AZ, and symptoms. Use these as filter criteria below.
2. **Search events** (`DescribeEvents`, us-east-1). Filter by `services`, `startTimes` (`from` =
   ~7 days before the incident), `regions`, `eventStatusCodes` `[open, closed]`, and
   `eventTypeCategories` `[issue, scheduledChange, accountNotification]`. Follow `nextToken`
   (cap ~500 events, 100/page). Include both `ACCOUNT_SPECIFIC` and `PUBLIC` events.
3. **Filter to the relevant subset** (using fields already returned, before fetching details):
   keep events whose `service` matches an affected service (or a related one — see the map
   below), whose active window overlaps the incident, and whose region/AZ matches. Drop
   `accountNotification` unless the incident is account-level, and drop `closed` events that
   ended > 2h before the incident started.
4. **Get details** (`DescribeEventDetails`, ≤ 10 ARNs/call) for the relevant subset:
   `latestDescription`, timeline (start/end/updated), status, service/region, type. Report any
   `failedSet` ARNs and keep going with the `successfulSet`.
5. **Affected entities** — only for **ACCOUNT_SPECIFIC** events (`DescribeAffectedEntities`);
   exact-match each `entityValue` against the incident's resource IDs, and note entity status
   (`IMPAIRED` / `UNIMPAIRED` / `UNKNOWN` / `PENDING`). PUBLIC events return no entities.
6. **Correlate & score relevance.** **High** = matching service + overlapping timeframe +
   matching resource (or region/AZ if no resource IDs). **Medium** = matching service +
   overlapping timeframe. **Low** = matching service only. Any **open** High/Medium event is a
   **"likely contributing factor"**.

## Report format

Lead with a one-line verdict — *whether an AWS-side event likely explains the incident*. Then
group by category (**Issues** → **Scheduled changes** → **Account notifications**), sorted
High → Medium → Low, then newest first:

| Relevance | Category · Service | Region / AZ | Status | Window (start–end) | Summary | Contributing? |
|---|---|---|---|---|---|---|

If nothing correlates, **say so explicitly**, state the search parameters used (service, window,
region), and suggest other paths (recent deploys/config changes, quota exhaustion, network,
app-level errors). When a service-specific search is empty, broaden to related services and/or
widen the window to 14 days *before* concluding "none found".

**Service dependency map** (broaden to ≤ 3 related services when the primary search is empty):
ELB/ALB/NLB → EC2, VPC, Route 53 · RDS → EC2, EBS · ECS/EKS → EC2, VPC, ELB · Lambda → VPC,
CloudWatch · CloudFront → S3, Route 53 · API Gateway → Lambda, VPC · ElastiCache → EC2, VPC.

## Guardrails
- **Read-only**: only `DescribeEvents` / `DescribeEventDetails` / `DescribeAffectedEntities` /
  `DescribeEventTypes`. Never modify a resource and never open a support case.
- **Always query us-east-1** for the Health API, whatever region the resources are in.
- If the account's support plan doesn't include the Health API, report exactly which support
  entitlement or IAM action is missing and **stop** — don't guess the tier, and don't fall back
  to another account.
- Distinguish **fact** (from the Health API) from **inference** (⚠️). Correlation is not proof —
  label likely contributors, don't assert causation.
- Only fetch details / affected entities for events that passed relevance filtering, to keep the
  number of API calls bounded.
