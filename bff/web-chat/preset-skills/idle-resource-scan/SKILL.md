---
name: idle-resource-scan
name-en: Idle Resource Scan
name-zh: 闲置资源扫描
description-en: Scan an AWS account for idle, unused, or oversized resources wasting money — stopped-but-billing EBS volumes, unattached Elastic IPs, idle EC2/RDS, old snapshots, and low-utilization instances. Produces a prioritized cleanup list with estimated monthly savings per item.
description-zh: 扫描 AWS 账号中闲置、未使用或规格过大的浪费资源——已停止但仍在计费的 EBS 卷、未关联的弹性 IP、闲置 EC2/RDS、过期快照及低利用率实例。产出按优先级排序的清理清单，并预估每一项的每月可省金额。
description: Scan an AWS account for idle, unused, or oversized resources that are wasting money — stopped-but-still-billing EBS volumes, unattached Elastic IPs, idle EC2 instances, idle RDS databases, old snapshots, and low-utilization instances. Use when the user asks to find waste, reduce cost, clean up unused resources, right-size, or find idle resources. Produces a prioritized cleanup list with estimated monthly savings per item.
---

# Idle & Wasted Resource Scan

You are performing a **read-only** waste sweep. You only *describe* resources and *recommend*
actions — you never stop, delete, or modify anything. Every finding must be backed by a
resource returned from a tool call.

## When to use
- The user asks to "find waste", "reduce cost", "clean up unused resources", "right-size",
  or "what can I turn off".
- A cost review surfaced spend that isn't tied to active workloads.

## What to check (each is a separate finding class)

1. **Unattached EBS volumes** — volumes in `available` state still bill. List them with size
   and type; estimate monthly cost from size × per-GB price.
2. **Unassociated Elastic IPs** — an EIP not attached to a running instance bills hourly.
3. **Stopped EC2 instances with attached EBS** — the instance is free but its volumes and any
   provisioned IOPS keep billing. Flag long-stopped instances.
4. **Idle running EC2** — instances with sustained low CPU / near-zero network over the
   trailing 1-2 weeks. Use metrics to justify "idle"; never call something idle without data.
5. **Idle RDS** — databases with near-zero connections and low CPU over the trailing window.
6. **Old / orphaned snapshots** — EBS/RDS snapshots far older than any sensible retention,
   especially those whose source volume no longer exists.

For anything the resource-specific tools can't see, fall back to the general read-only AWS
query capability to `describe`/`list` the resource — still read-only.

## Report format

Group findings by class, most-savings first:

| Resource | Type | Why it's waste | Est. monthly cost | Suggested action |
|---|---|---|---|---|

Close with a **total estimated monthly savings** (sum of items), a **confidence note**
(idle judgments are based on the metric window; a spike outside the window could change the
call), and an offer to **save the full report**.

## Guardrails
- Read-only. Suggest actions; do not take them. Deletion/stop is always the customer's call.
- "Idle" MUST be backed by a metric or state from a tool — never assert idleness by name alone.
- Cost estimates are approximate (list price × observed size/hours); label them as estimates.
- Warn before recommending deletion of any volume/snapshot that could be a backup.
