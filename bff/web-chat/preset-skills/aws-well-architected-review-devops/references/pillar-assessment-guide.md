# Pillar Assessment Guide

## 审阅优先级原则（Top-N + IAM 强制）

> 来源：service-screener-v2 wa-summarizer prompt 的经验值。避免 Agent 平均用力、重点不突出。

### Top-5 服务优先原则

- 完成所有 pillar checks 后，按 finding 总数排序服务，**重点讲 Top-5**
- 其他服务在 Appendix 里一笔带过，不占 Executive Summary 篧幅
- Top-5 中每个服务最多讲 3 个 finding（从 HIGH 以上选）

### IAM 强制纳入

**无论 IAM 在 Top-5 里排多少，报告中都必须为它保留独立一节**。原因：
- IAM 是 blast radius 最大的服务，一个 wildcard policy 可以贯穿所有 pillar
- 客户 PA 汇报时 IAM 是必问项

### Quick Wins 提炼

从所有 finding 中提炼 5-10 个 **High Impact + Low Effort**项，独立一节。评判标准：
- Severity ≥ HIGH
- `downtime=0` 且 `needFullTest=0`　→快修
- 修复命令 ≤ 3 行 bash

---

## 6 支柱 × 固定子主题 Grid（强制覆盖）

> 每个支柱必须覆盖以下 4 个子主题。哪个子主题没 finding 也要写一句"已体检与未发现问题"。避免 Agent 逆向合理化只报容易领域。

| 支柱 | 子主题 1 | 子主题 2 | 子主题 3 | 子主题 4 |
|------|----------|----------|----------|----------|
| 🔒 Security | Identity & Access | Data Protection | Network Security | Detection & Incident Response |
| 🔄 Reliability | Foundations (Quota/Network) | Workload Architecture | Change Management | Failure Management (Backup/DR) |
| ⚙️ Operational Excellence | Organization | Prepare (Telemetry/IaC) | Operate (Monitoring/Runbook) | Evolve (Postmortem/Improvement) |
| ⚡ Performance | Selection (Compute/Storage/DB) | Review (Right-sizing) | Monitoring (Metrics/APM) | Trade-offs (Cache/Async) |
| 💰 Cost | Cloud Financial Management | Cost-effective Resources | Manage Demand & Supply | Optimize Over Time |
| 🌱 Sustainability | Region Selection | User Behavior Patterns | Software & Architecture | Data / HW / Process |

每个子主题下至少列 1-3 个 finding或明确标 "No findings"。

---

## Per-Pillar Output Structure

After each pillar's programmatic checks complete, produce this structured output:

```markdown
## {Pillar Name} Assessment

### Summary
- Checks executed: {N}
- Findings: {critical} CRITICAL, {high} HIGH, {medium} MEDIUM, {low} LOW
- Pillar health: {★★★★☆} ({score}/5)

### Findings by Sub-theme

#### {子主题 1}
| ID | Check | Severity | Finding | Down | Slow | Cost | Test | Remediation |
|----|-------|----------|---------|------|------|------|------|-------------|
| SEC-01 | GuardDuty | 🔴 CRITICAL | Not enabled | 0 | 0 | 1 | 0 | `aws guardduty create-detector --enable` |

#### {子主题 2}
...

### Pillar Score Rationale
{Brief explanation of why this score was given}
```

## Scoring Rubric (5-Star)

| Stars | Rating | Criteria |
|-------|--------|----------|
| ★★★★★ | Excellent | 0 CRITICAL, 0 HIGH, ≤2 MEDIUM |
| ★★★★☆ | Good | 0 CRITICAL, ≤1 HIGH, ≤4 MEDIUM |
| ★★★☆☆ | Adequate | 0 CRITICAL, ≤3 HIGH, any MEDIUM |
| ★★☆☆☆ | Needs Improvement | ≤1 CRITICAL, any HIGH |
| ★☆☆☆☆ | Critical Risk | 2+ CRITICAL findings |

## Radar Chart Data

After all pillars complete, generate a Mermaid radar-like visualization:

```markdown
### Overall Health Score

| Pillar | Score | Rating |
|--------|-------|--------|
| Security | 3/5 | ★★★☆☆ |
| Ops Excellence | 4/5 | ★★★★☆ |
| Reliability | 2/5 | ★★☆☆☆ |
| Performance | 4/5 | ★★★★☆ |
| Cost Optimization | 3/5 | ★★★☆☆ |
| Sustainability | 3/5 | ★★★☆☆ |
| **Overall** | **3.2/5** | **★★★☆☆** |
```

## Assessment Adaptations

### When Check Cannot Execute
- API permission denied → mark as `UNABLE_TO_ASSESS` (not a finding)
- Service not in region → mark as `NOT_APPLICABLE`
- Timeout → retry once, then `UNABLE_TO_ASSESS`

### When Service Not Present
- No RDS → skip REL-01, PERF-04 → mark as `NOT_APPLICABLE`
- No EKS → skip REL-06 → mark as `NOT_APPLICABLE`
- No Lambda → skip PERF-07, SUS-03 → mark as `NOT_APPLICABLE`

### Quick Scan Mode
If user requests "quick scan" or "security only":
- Execute only Security pillar
- Skip all other pillars
- Generate abbreviated report
