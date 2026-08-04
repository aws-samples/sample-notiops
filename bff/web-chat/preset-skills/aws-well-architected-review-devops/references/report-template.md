# Report Template

## Assessment Metadata

| Field | Value |
|-------|-------|
| **Assessment Date** | {YYYY-MM-DD} |
| **Account ID** | {account_id} |
| **Region** | {region} |
| **Framework** | AWS Well-Architected Framework (General) |
| **Pillars Assessed** | {pillar_list} |
| **Assessment Mode** | Autopilot (Programmatic) |
| **Assessor** | AI-Powered WA Review Skill v1.0 |
| **Credential** | {role_arn} (ReadOnly) |

---

## Executive Summary

### Overall Health: {overall_score}/5 {star_rating}

{2-3 sentence summary of the environment's health. Highlight the strongest and weakest pillars.}

### Top 5 Risks

| # | Risk | Pillar | Severity | Quick Fix? |
|---|------|--------|----------|-----------|
| 1 | {risk} | {pillar} | CRITICAL | {yes/no} |
| 2 | {risk} | {pillar} | HIGH | {yes/no} |
| 3 | {risk} | {pillar} | HIGH | {yes/no} |
| 4 | {risk} | {pillar} | MEDIUM | {yes/no} |
| 5 | {risk} | {pillar} | MEDIUM | {yes/no} |

### Key Recommendations
1. {Recommendation 1 — immediate action}
2. {Recommendation 2 — short-term}
3. {Recommendation 3 — strategic}

---

## Pillar Scorecards

| Pillar | Score | CRITICAL | HIGH | MEDIUM | LOW |
|--------|-------|----------|------|--------|-----|
| 🔒 Security | {x}/5 | {n} | {n} | {n} | {n} |
| ⚙️ Ops Excellence | {x}/5 | {n} | {n} | {n} | {n} |
| 🔄 Reliability | {x}/5 | {n} | {n} | {n} | {n} |
| ⚡ Performance | {x}/5 | {n} | {n} | {n} | {n} |
| 💰 Cost Optimization | {x}/5 | {n} | {n} | {n} | {n} |
| 🌱 Sustainability | {x}/5 | {n} | {n} | {n} | {n} |

---

## Detailed Findings

### 🔒 Security Pillar ({score}/5)

{Per-check findings table from security-checks.md execution}

### ⚙️ Operational Excellence Pillar ({score}/5)

{Per-check findings table from ops-excellence-checks.md execution}

### 🔄 Reliability Pillar ({score}/5)

{Per-check findings table from reliability-checks.md execution}

### ⚡ Performance Efficiency Pillar ({score}/5)

{Per-check findings table from performance-checks.md execution}

### 💰 Cost Optimization Pillar ({score}/5)

{Per-check findings table from cost-checks.md execution}

### 🌱 Sustainability Pillar ({score}/5)

{Per-check findings table from sustainability-checks.md execution}

---

## Risk Portfolio

### HRI — High Risk Issues ({count})

| ID | Risk | Pillar(s) | Impact | Fix Effort | Priority |
|----|------|----------|--------|-----------|----------|
{HRI rows}

### MRI — Medium Risk Issues ({count})

| ID | Risk | Pillar(s) | Impact | Fix Effort | Priority |
|----|------|----------|--------|-----------|----------|
{MRI rows}

### LRI — Low Risk Issues ({count})

{Summary list — not full table}

---

## Improvement Roadmap

> 三段时间盒框架（来源 service-screener-v2 wa-summarizer）。每个 finding **必须**被放入以下其中一个时间盒，不要留 "待定"。

```mermaid
gantt
    title WA Improvement Roadmap (0-30 / 1-6m / 6-24m)
    dateFormat  YYYY-MM-DD
    section 0-30 days (Critical Fixes)
    {task1}           :crit, t1, {start}, 7d
    {task2}           :crit, t2, {start}, 14d
    section 1-6 months (Architectural)
    {task3}           :t3, after t1, 60d
    {task4}           :t4, after t2, 90d
    section 6-24 months (Strategic / Modernization)
    {task5}           :t5, after t3, 180d
    {task6}           :t6, after t5, 360d
```

### Phase 1: 0-30 days — Critical Fixes

**进入条件**：任何 CRITICAL finding 必进 · 公网暴露 · root MFA · 数据未加密 · 无备份

**例**：
- 启用 GuardDuty / Security Hub
- root MFA + remove root access keys
- 公网暴露服务加 ALB/CloudFront/WAF
- prod RDS 打开 Multi-AZ + automated backup
- 收敛 SG `0.0.0.0/0` 非必要规则

### Phase 2: 1-6 months — Architectural Improvements

**进入条件**：HIGH finding · 需要架构调整但不需重写 · 能在季度内交付

**例**：
- ASG / EKS 改为 Multi-AZ
- 建立 AWS Backup Plan · 跨区域备份
- IAM Identity Center / SSO 迁移
- 建立中枢化日志·告警体系（CloudWatch + SNS + Composite Alarms）
- 启用 KMS CMK 加密所有 RDS / S3 / EBS

### Phase 3: 6-24 months — Strategic / Modernization

**进入条件**：平台级改造 · 需 budget approval · 跨团队协作 · 依赖人员能力升级

**例**：
- Serverless / Container 现代化（EC2 → ECS/EKS/Lambda）
- FinOps 体系建立（CUR + QuickSight + Anomaly Detection）
- 多账号 Landing Zone (Control Tower / Org SCP)
- DR 体系升级到 Pilot Light / Warm Standby
- Sustainability 优化（Graviton / Spot / Region 选择）

### Roadmap 填充原则

- 每个 finding 在表格里加一列 `Phase: 0-30d / 1-6m / 6-24m`
- Phase 1 任务不能超过 10 项（超过就说明环境处于高风险）
- Phase 3 任务要带 ROI 估算（年节省 USD / RMB 两者）
- 不要用“未来”“后续”这种模糊表述，全部放进具体 phase

### Phase 1: 0-30 days (报告填充)
{Critical security + reliability fixes with specific commands}

### Phase 2: 1-6 months (报告填充)
{High-priority architectural improvements}

### Phase 3: 6-24 months (报告填充)
{Strategic transformations + modernization roadmap with ROI}

---

## Implementation Guide (Top 10 Fixes)

### Fix 1: {Title}
- **Pillar**: {pillar}
- **Severity**: {severity}
- **Estimated time**: {time}
- **Steps**:
```bash
{specific aws cli commands}
```

{Repeat for top 10}

---

## Appendix

### A. Full Check Results
{Complete raw output from all checks}

### B. Checks Unable to Assess
{List of checks that failed due to permissions or unavailability}

### C. Assessment Methodology
- Framework: AWS Well-Architected Framework (2025)
- Assessment type: Programmatic (API-based, read-only)
- Total checks: {N} across 6 pillars
- Checks executed: {N} | Skipped: {N} | Failed: {N}
