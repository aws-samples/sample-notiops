---
name: service-quota-check
name-en: Service Quota Check
name-zh: 服务配额检查
description-en: Check AWS Service Quota utilization to find limits near their ceiling before they cause throttling or capacity failures — for a service the user names, or the common high-risk ones (EC2 vCPUs, EBS, VPC/ENI, Lambda concurrency, RDS, IAM roles). Read-only: reports utilization and recommends increases but never requests any increase or opens a case.
description-zh: 检查 AWS 服务配额（Service Quotas）的使用率，在触发限流或容量失败前发现接近上限的配额——可针对用户指定的服务，或覆盖常见高风险项（EC2 vCPU、EBS、VPC/ENI、Lambda 并发、RDS、IAM 角色）。只读：仅报告使用率并建议提升目标值，绝不发起任何配额提升申请或开工单。
description: Check AWS Service Quotas (limits) utilization to find quotas that are near their ceiling before they cause throttling or capacity failures — for a service the user names, or the common high-risk ones (EC2 vCPUs, EBS, VPC/ENI, Lambda concurrency, RDS instances, IAM roles). Use when the user asks about quotas, limits, "am I about to hit a limit", throttling, capacity headroom, or is planning a scale-up/launch. Read-only: it reports utilization and recommends increases but does NOT request any quota increase or open any case.
---

# Service Quota Utilization Check

You are performing a **read-only** review of AWS Service Quotas to surface limits that are
close to being exhausted. This is a reporting/advisory skill — it never requests an increase.

> Note: this skill is adapted for NotiOps from the open-source
> `aws-samples/sample-devops-agent-tools` `service-quota-check` skill, with the two mutating
> actions (RequestServiceQuotaIncrease / CreateSupportCase) removed to keep it strictly read-only.

## When to use
- The user asks about service quotas / limits, whether they're about to hit a limit,
  throttling risk, capacity headroom, or is planning a launch or scale-up.

## Steps

1. **Scope.** If the user named a service (e.g. "EC2", "Lambda"), focus there. Otherwise cover
   the common high-risk quotas: EC2 running On-Demand vCPUs (by family), EBS storage/volumes,
   VPC (ENIs, security groups, VPCs), Lambda concurrent executions, RDS DB instances, IAM roles.
2. **Read the quotas.** For each in-scope service, list its quotas and the applied/effective
   value (`servicequotas:ListServices`, `ListServiceQuotas`, `GetServiceQuota`). Note which
   quotas are adjustable vs hard limits.
3. **Read current usage.** Where a quota has an associated CloudWatch usage metric
   (`AWS/Usage`), read recent `GetMetricData` / `GetMetricStatistics` to compute
   **utilization = current usage ÷ quota**. If a quota has no usage metric, count the resources
   directly via the relevant describe/list API (e.g. count running instances' vCPUs).
4. **Flag risk by utilization:**
   - **≥ 90%** → HIGH (imminent throttling / launch failure).
   - **80–90%** → MEDIUM (request an increase soon).
   - **< 80%** → OK.
5. **Any in-flight increase requests?** List already-requested increases
   (`servicequotas:ListRequestedServiceQuotaChangeHistory*`) so you don't recommend duplicating
   a pending request.

## Report format

| Severity | Service · Quota | Usage / Limit | Utilization | Adjustable? | Recommendation |
|---|---|---|---|---|---|
| HIGH / MEDIUM / OK | EC2 · Running On-Demand Standard vCPUs | 460 / 512 | 90% | Yes | Request increase to ≥ 768 before launch |

Lead with the conclusion (how many quotas are at HIGH/MEDIUM risk), then the table, then the
top actions.

## Guardrails
- **Read-only. Do NOT call `RequestServiceQuotaIncrease` and do NOT open a support case** — only
  report utilization and recommend a target value. If the user explicitly wants to raise a quota,
  tell them to do it in the Service Quotas console (or ask their admin), since NotiOps stays
  read-only.
- Every utilization figure cites the quota value + the usage source (CloudWatch metric or a
  resource count). If usage for a quota can't be determined, say so rather than assuming it's fine.
- Quotas are per-Region — state which Region each figure is for.
