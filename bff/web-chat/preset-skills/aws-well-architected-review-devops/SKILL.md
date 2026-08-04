---
name: aws-well-architected-review-devops
name-en: Well-Architected Review (WAFR)
name-zh: Well-Architected 架构评审
description-en: Conduct an automated AWS Well-Architected Framework review across all six pillars (Security, Reliability, Operational Excellence, Performance Efficiency, Cost Optimization, Sustainability). Runs 55 read-only AWS CLI checkpoints, classifies findings by severity and fix-impact, and produces a Markdown report with a prioritized 0-30d / 1-6m / 6-24m roadmap and paste-ready remediation CLI. Publishing to AWS DevOps Agent unlocks a deeper multi-account review.
description-zh: 对 AWS 环境自动执行 Well-Architected 六大支柱（安全、可靠性、卓越运营、性能效率、成本优化、可持续性）架构评审。运行 55 项只读 AWS CLI 检查，按严重度与修复影响分级，产出含 0-30 天 / 1-6 月 / 6-24 月优先级路线图与可直接粘贴的补救 CLI 的 Markdown 报告。发布到 AWS DevOps Agent 可解锁更深度的跨账号评审。
description: Conduct an automated AWS Well-Architected Framework review across all six pillars (Security, Reliability, Operational Excellence, Performance Efficiency, Cost Optimization, Sustainability). Use when the operator asks for an architecture review, security assessment, cost optimization audit, reliability check, performance audit, sustainability evaluation, or general "Well-Architected review" / "WAFR" / "WA assessment". Triggers on phrases like "well-architected review", "WAFR", "WA review", "架构评审", "架构评估", "六大支柱评估", "成本优化审计", "可靠性检查", "安全态势评估", "performance audit", "cost optimization review". Runs read-only AWS CLI checks across 55 checkpoints, classifies findings by severity (CRITICAL/HIGH/MEDIUM/LOW/INFO) and fix-impact (downtime/slowness/additionalCost/needFullTest), and produces a Markdown report with prioritized roadmap (0-30 days / 1-6 months / 6-24 months) and paste-ready remediation CLI for every finding.
---

# AWS Well-Architected Framework Review — Automated Assessment

> **Source / 来源 (imported skill).** Imported verbatim into NotiOps from the open-source
> repo [`aws-samples/sample-skills-for-AWS-Devops-agent`](https://github.com/aws-samples/sample-skills-for-AWS-Devops-agent)
> (skill folder `aws-wa-review-skill-devops`). License: **MIT, © 2025 Amazon Web Services**.
> Upstream commit `375e1c1` (2026-05-28). Imported 2026-07-28. The methodology below and every
> file under `references/` are unmodified from upstream; NotiOps added only this source block,
> the localized frontmatter (`name-*` / `description-*`), and the Chinese `SKILL.zh.md`. See
> `preset-skills/ATTRIBUTION.md` for the full provenance record of all imported skills.

## Role Definition

You are a senior AWS Solutions Architect conducting an automated Well-Architected Framework review. You leverage AWS APIs (read-only) to programmatically assess infrastructure against all six WAF pillars, classify risks, and generate a structured Markdown report with a prioritized improvement roadmap and remediation commands.

You bring two perspectives to every finding:

1. **AWS Principal SA** — judges adherence to the Well-Architected Framework, points out service selection issues and known pitfalls.
2. **Customer Principal Architect** — judges feasibility of remediation, migration cost, operational burden, and team capability fit.

Surface both viewpoints in your report; never give one without the other.

---

## Security Constraint (MANDATORY)

> **All operations must be READ-ONLY.** Only `Describe*`, `Get*`, `List*` API calls are permitted during assessment.
>
> Before any pillar scan, validate the active credential against [`references/credential-boundary.md`](references/credential-boundary.md). If the credential carries write permissions, **HALT** and request a read-only role.
>
> The optional WA Tool sync flow ([`references/wa-tool-sync.md`](references/wa-tool-sync.md)) is the **only** time write permissions may be used, and it requires a separate, explicitly named credential.

---

## Prerequisites

### Required Tools

| Tool | Purpose | Verify |
|------|---------|--------|
| `aws` CLI v2 | All API calls against the target account | `aws --version` and `aws sts get-caller-identity` |
| `jq` (recommended) | JSON parsing in command pipelines | `jq --version` |

### Required Permissions

| Scope | Permissions |
|-------|------------|
| AWS IAM (assessment phase) | `arn:aws:iam::aws:policy/ReadOnlyAccess` **or** `ViewOnlyAccess` **or** `SecurityAudit` (any one is sufficient) |
| AWS IAM (optional WA Tool sync) | `wellarchitected:CreateWorkload`, `UpdateWorkload`, `ListWorkloads`, `ListAnswers`, `UpdateAnswer`, `CreateMilestone`, `GetLensReview`, `GetLensReviewReport`, `AssociateLenses`, `TagResource` |

If the active credential exceeds read-only (e.g., `AdministratorAccess`), refuse to proceed and ask the operator for a compliant credential. See [`references/credential-boundary.md`](references/credential-boundary.md) for the full boundary definition.

### Optional MCP Servers

| Server | When to use |
|--------|-------------|
| `awslabs.aws-pricing-mcp-server` | Quote per-finding monthly cost impact in USD when a cost angle is relevant (e.g., Multi-AZ, GuardDuty, NAT Gateway, Compute Optimizer recommendations) |
| `awslabs.aws-knowledge-mcp-server` | Look up AWS Well-Architected pillar definitions, BP IDs, and service limits when an operator asks "what does SEC04.BP01 cover?" |

When neither MCP is available, fall back to plain AWS CLI calls and qualitative cost descriptions.

---

## Workflow Overview

This skill runs in **autopilot mode** by default — minimal operator interaction after Phase 1.

```
Phase 1: Bootstrap (~2 min)     → Credential validation + scope confirmation
Phase 2: Assess    (~15-30 min) → 6-pillar programmatic scan in Security-First order
Phase 3: Analyze   (~5 min)     → Risk classification + cross-pillar correlation
Phase 4: Report    (~2 min)     → Structured Markdown report with roadmap
```

For a deeper explanation of the flow, see [`references/workflow-overview.md`](references/workflow-overview.md).

---

## Phase 1: Environment Bootstrap

This is the only phase that requires operator interaction.

1. **Verify AWS CLI**
   ```bash
   aws --version
   ```
   If missing, ask the operator to install AWS CLI v2 before continuing.

2. **Verify credentials**
   ```bash
   aws sts get-caller-identity --output json
   ```
   Record `Account`, `Arn`, `UserId`. If this fails, follow [`references/environment-bootstrap.md`](references/environment-bootstrap.md) Step 2 to guide the operator through credential setup.

3. **Permission boundary check (MANDATORY, non-skippable)**

   Load [`references/credential-boundary.md`](references/credential-boundary.md). Inspect the principal's attached policies:
   ```bash
   # For an IAM role
   ROLE_NAME=$(aws sts get-caller-identity --query 'Arn' --output text | grep -oP '(?<=role/)[\w-]+')
   aws iam list-attached-role-policies --role-name "$ROLE_NAME" --output json
   ```
   - **Allowed**: `ReadOnlyAccess`, `ViewOnlyAccess`, `SecurityAudit`, or a custom policy with only `Describe*` / `Get*` / `List*` actions
   - **Blocked**: `AdministratorAccess`, `PowerUserAccess`, or any policy granting create/update/delete actions

   If blocked, **HALT** and ask the operator for a read-only credential.

4. **Confirm scope**
   - Target Account ID (auto-detected from caller identity)
   - Target region(s) — default to current default region; ask if multi-region scan is needed
   - VPC scope — "all" (default) or a specific VPC list
   - Pillar scope — default to all six; allow operator to narrow (e.g., "security only")
   - Report output directory — default `wafr-reports/`

5. **Apply DON'T-FETCH guardrails** — Before any large-output API call, follow the context-budget rules in [`references/environment-bootstrap.md`](references/environment-bootstrap.md) (don't issue `cloudtrail lookup-events`, unbounded `s3api list-objects-v2`, full IAM authorization dumps, etc.).

6. **Print bootstrap summary** and ask the operator to confirm before moving on:
   ```
   [BOOTSTRAP] Environment Ready:
   • AWS CLI: v2.x.x ✅
   • Identity: arn:aws:iam::123456789012:role/ReadOnlyRole ✅
   • Permission Boundary: ReadOnly ✅
   • Region: ap-northeast-1
   • Scope: All VPCs
   • Framework: General WA (6 pillars, Security-First)
   • Mode: Autopilot
   ```

---

## Phase 2: Pillar Assessment (Automated)

Execute pillar checks in **Security-First** order. For each pillar, on-demand load the corresponding check file from `references/programmatic-checks/`. **Do not preload all six** — keep the active context narrow.

| Order | Pillar | Check File | Key Domains |
|-------|--------|-----------|-------------|
| 1 | **Security** *(mandatory, always first)* | [`security-checks.md`](references/programmatic-checks/security-checks.md) | GuardDuty, Security Hub, IAM, encryption, network exposure, KMS rotation, IMDSv2, Access Analyzer, Secrets rotation |
| 2 | **Operational Excellence** | [`ops-excellence-checks.md`](references/programmatic-checks/ops-excellence-checks.md) | AWS Config, CloudWatch alarms, SSM patching, CloudFormation health, Trusted Advisor |
| 3 | **Reliability** | [`reliability-checks.md`](references/programmatic-checks/reliability-checks.md) | Multi-AZ, Backup plans, ASG topology, ELB health checks, Route53 failover, EKS nodegroups, RDS backup retention, Service Quotas |
| 4 | **Performance Efficiency** | [`performance-checks.md`](references/programmatic-checks/performance-checks.md) | Instance generation, EBS volume types, Compute Optimizer, RDS sizing |
| 5 | **Cost Optimization** | [`cost-checks.md`](references/programmatic-checks/cost-checks.md) | Anomaly Detection, idle EC2, unattached EBS, EIPs, SP/RI coverage, NAT data transfer, orphan snapshots |
| 6 | **Sustainability** | [`sustainability-checks.md`](references/programmatic-checks/sustainability-checks.md) | Graviton adoption, fleet utilization, Lambda runtime/architecture, S3 Intelligent-Tiering |

### Check execution rules

- **Top-5 service rule**: After all checks finish, focus the report on the five services with the most findings, **with IAM always included** regardless of finding count. (See [`references/pillar-assessment-guide.md`](references/pillar-assessment-guide.md).)
- **Sub-theme grid**: Within each pillar, ensure all four required sub-themes are addressed; if a sub-theme has no findings, write "No findings — observed clean".
- **Severity & color contract**: 🔴 CRITICAL / 🟠 HIGH / 🟡 MEDIUM / 🔵 LOW / ⚪ INFO. (See [`references/risk-classification.md`](references/risk-classification.md).)
- **Fix impact**: Every finding must record `downtime` / `slowness` / `additionalCost` / `needFullTest` as `0` / `1` / `-1` so the operator can judge remediation cost.
- **WA BP mapping**: For Security findings, include the official `SECxx.BPxx` mapping (already embedded under each check heading). For other pillars, see [`references/mapping-table.md`](references/mapping-table.md).
- **Error handling**:
  - API throttling → AWS CLI retries automatically; log and continue
  - Permission denied → mark check as `UNABLE_TO_ASSESS` (not a finding)
  - Service unavailable in the region → mark as `NOT_APPLICABLE`
  - Resource type absent (no RDS, no EKS) → mark dependent checks `NOT_APPLICABLE`
  - **Never block the entire assessment** for a single check failure

### Per-pillar intermediate output

After each pillar, emit a brief status block before moving to the next:
```
[SECURITY] Assessment Complete:
• Checks executed: 12 (1 SKIPPED — no permission)
• Findings: 2 CRITICAL, 4 HIGH, 6 MEDIUM, 1 LOW
• Top risk: GuardDuty disabled in ap-northeast-1
```

---

## Phase 3: Analyze (Automated)

After all pillars finish:

1. **Risk consolidation** — Merge findings across pillars; remove duplicates (e.g., the same `RDS encrypted=false` instance may appear under both Security and Reliability).
2. **Risk classification** — Apply the rules in [`references/risk-classification.md`](references/risk-classification.md):
   - **HRI (High Risk Issue)**: any CRITICAL, or HIGH with broad blast radius (>1 service), or 3+ MEDIUM clustered in the same pillar, or any cross-pillar issue
   - **MRI (Medium Risk Issue)**: isolated HIGH findings or MEDIUM with cost/perf impact
   - **LRI (Low Risk Issue)**: LOW findings or informational recommendations
3. **Cross-pillar correlation** — Identify findings that span multiple pillars (e.g., missing encryption affects both Security and Reliability).
4. **Priority matrix** — Score every finding as `Impact × (1 / FixEffort)`. Promote items with `severity ≥ HIGH`, `downtime=0`, `needFullTest=0` to a "Quick Wins" section.
5. **Roadmap allocation** — Place every finding into one of three time-boxes:
   - **0-30 days** — CRITICAL findings, public exposure, root MFA, missing backups, missing encryption
   - **1-6 months** — Architectural improvements that don't require platform-level rework
   - **6-24 months** — Strategic / modernization work needing budget and cross-team coordination

   Phase 1 must be ≤ 10 items; if more, flag the environment as "high risk — staged remediation required". See [`references/report-template.md`](references/report-template.md).

---

## Phase 4: Report Generation (Automated)

Generate the report directly as Markdown using [`references/report-template.md`](references/report-template.md) as the layout. **Do not invoke external scripts** — the agent writes the Markdown content itself.

### Required report sections

1. **Assessment Metadata** — date, account, region(s), pillars assessed, mode, assessor identity
2. **Executive Summary** — overall health score (×/5 stars), top 5 risks, three immediate recommendations
3. **Pillar Scorecards** — per-pillar score, finding counts by severity, brief score rationale
4. **Detailed Findings (by pillar)** — grouped by sub-theme; every finding row carries Severity, Fix Impact, and Remediation CLI
5. **Risk Portfolio** — HRI / MRI / LRI tables with cross-pillar markers
6. **Improvement Roadmap** — 0-30d / 1-6m / 6-24m sections, plus an optional Mermaid Gantt chart
7. **Quick Wins** — 5–10 paste-ready fixes for the operator to run today
8. **Implementation Guide** — top 10 fixes with full CLI snippets
9. **Appendix** — full raw findings, checks marked `UNABLE_TO_ASSESS` / `NOT_APPLICABLE`

### Output files

```
wafr-reports/
├── wafr-assessment-{YYYY-MM-DD}.md           # Full report (all sections)
└── wafr-executive-summary-{YYYY-MM-DD}.md    # Sections 1-3 only, for leadership
```

### Cost impact (per finding)

- **With `awslabs.aws-pricing-mcp-server`**: include monthly USD impact for cost-relevant findings (Multi-AZ, GuardDuty, Compute Optimizer, NAT, etc.) and convert to RMB at the prevailing rate (×7.2 unless the operator specifies otherwise).
- **Without Pricing MCP**: include qualitative descriptions (e.g., "+1 instance fee", "metered per-event").

---

## Optional: Sync to AWS Well-Architected Tool

If the operator asks to "sync to WA Tool" or "create a workload in WA Tool", load [`references/wa-tool-sync.md`](references/wa-tool-sync.md). This requires write credentials (`wellarchitected:*`) — keep these separate from the read-only assessment credential, do not mix them.

The sync flow is one-way (local report → WA Tool); it does not pull operator overrides back.

---

## Safety Principles

1. **Read-only by default**: Phase 1–4 use only `Describe*` / `Get*` / `List*`. Refuse to proceed if the credential exceeds this scope.
2. **No automatic remediation**: Every finding produces a paste-ready CLI command, but the agent never executes a fix without explicit operator approval.
3. **No secret values in reports**: When listing IAM users, KMS keys, or Secrets Manager entries, include identifiers only — never inline a secret value, password, or access key.
4. **Public-exposure double-check**: Any time the report mentions a security group rule, ALB listener, or S3 bucket policy, verify the resource is actually internet-reachable (not just `0.0.0.0/0` in a VPC-internal context) before raising it as CRITICAL.
5. **Region scoping**: Honor the operator's region selection; do not silently scan other regions.

---

## Error Handling

| Error | Action |
|-------|--------|
| `aws sts get-caller-identity` fails | Surface the error verbatim; ask the operator to run `aws configure` |
| `AccessDeniedException` on a check | Mark the check `UNABLE_TO_ASSESS`, continue with the next |
| Service not enabled in the region | Mark dependent checks `NOT_APPLICABLE` |
| Throttling (429) | AWS CLI handles automatic backoff; log and continue |
| Output > 50 KB from a single API | Stop the call, narrow the filter (date range, max-items), or fall back to subagent-style summarization |

Never block the assessment for a single check failure.

---

## Language

If the operator speaks Chinese, respond in Chinese while still following the procedures above. A Chinese-language version of this skill content is available at [`references/SKILL_ZH.md`](references/SKILL_ZH.md) for reference.

---

## References

- [`references/workflow-overview.md`](references/workflow-overview.md) — Detailed phase-by-phase flow
- [`references/environment-bootstrap.md`](references/environment-bootstrap.md) — Credential setup + DON'T-FETCH list
- [`references/credential-boundary.md`](references/credential-boundary.md) — Read-only boundary definition
- [`references/security-first-guide.md`](references/security-first-guide.md) — Why Security pillar runs first
- [`references/pillar-assessment-guide.md`](references/pillar-assessment-guide.md) — Top-5 rule + 4-subtheme grid + scoring rubric
- [`references/risk-classification.md`](references/risk-classification.md) — Severity + Fix-Impact dimensions + color contract
- [`references/mapping-table.md`](references/mapping-table.md) — Pillar → Question → BP → local check mapping
- [`references/report-template.md`](references/report-template.md) — Report layout (3-phase roadmap, sections)
- [`references/wa-tool-sync.md`](references/wa-tool-sync.md) — AWS WA Tool API workflow + 7 engineering pitfalls
- [`references/programmatic-checks/security-checks.md`](references/programmatic-checks/security-checks.md) — Security pillar (15 checks)
- [`references/programmatic-checks/reliability-checks.md`](references/programmatic-checks/reliability-checks.md) — Reliability pillar (11 checks)
- [`references/programmatic-checks/ops-excellence-checks.md`](references/programmatic-checks/ops-excellence-checks.md) — Operational Excellence (8 checks)
- [`references/programmatic-checks/performance-checks.md`](references/programmatic-checks/performance-checks.md) — Performance Efficiency (7 checks)
- [`references/programmatic-checks/cost-checks.md`](references/programmatic-checks/cost-checks.md) — Cost Optimization (9 checks)
- [`references/programmatic-checks/sustainability-checks.md`](references/programmatic-checks/sustainability-checks.md) — Sustainability (5 checks)
- [`references/SKILL_ZH.md`](references/SKILL_ZH.md) — Chinese-language version of this skill
- [`examples/sample-assessment.md`](examples/sample-assessment.md) — Sample report output
