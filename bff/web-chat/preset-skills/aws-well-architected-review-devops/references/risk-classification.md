# Risk Classification Guide

## Severity Levels (per finding)

> Color contract: report rendering MUST use these colors so 审阅人 visual scan 一致。

| Level | Color | Emoji | Description | Examples |
|-------|-------|-------|-------------|---------|
| **CRITICAL** | 🔴 red | 🔴 | Immediate security/reliability threat. Exploitable now. | GuardDuty disabled, SSH open to internet, root no MFA, public-facing prod resource without WAF |
| **HIGH** | 🟠 orange | 🟠 | Significant risk, needs attention within days. | Unencrypted databases, no backups, stale access keys, single-AZ prod, IAM wildcard policies |
| **MEDIUM** | 🟡 yellow | 🟡 | Notable gap, address within weeks. | Missing log retention, single-AZ non-prod databases, no lifecycle policies, default SG in use |
| **LOW** | 🔵 blue | 🔵 | Minor improvement opportunity. | Old instance types, unused Elastic IPs, missing tags, naming inconsistency |
| **INFO** | ⚪ gray | ⚪ | Informational — passing check or recommendation. | Everything configured correctly, advisory note |

## Fix Impact Dimensions (每个 finding 必填)

> 客户 PA 决策时最关心的 4 个维度。Severity 只回答"问题多严重"，这 4 个字段回答"修复代价多大"。来源：service-screener-v2 reporter.json schema。

| Field | Values | Meaning |
|-------|--------|---------|
| `downtime` | `0` / `1` / `-1` | 修复是否造成服务中断。`0`=无停机；`1`=有停机；`-1`=取决于实施方式 |
| `slowness` | `0` / `1` / `-1` | 修复期间是否性能下降。`0`=无影响；`1`=会变慢；`-1`=depends |
| `additionalCost` | `0` / `1` / `-1` | 修复是否产生新的持续成本。`0`=无；`1`=有（如 Multi-AZ、跨区域备份）；`-1`=depends |
| `needFullTest` | `0` / `1` / `-1` | 是否需要全量回归测试。`0`=配置改动可灰度；`1`=需要 full regression（如加密 / 引擎升级）；`-1`=depends |

### 评分指引

常见 finding 类型的参考评分：

| Finding 类型 | downtime | slowness | additionalCost | needFullTest |
|-------------|----------|----------|----------------|--------------|
| RDS 启用 Multi-AZ | `0`（在线转换） | `1`（短暂） | `1`（×2 实例费） | `0` |
| RDS 启用静态加密 | `1`（需 snapshot+restore） | `0` | `0` | `1` |
| S3 启用 Versioning | `0` | `0` | `1`（旧版本存储费） | `0` |
| S3 Public Access Block | `0` | `0` | `0` | `-1`（依赖业务是否真公开） |
| EC2 SG 收敛 0.0.0.0/0 | `-1`（误删可能断连） | `0` | `0` | `1` |
| 启用 GuardDuty | `0` | `0` | `1`（按事件计费） | `0` |
| ASG 改 Multi-AZ | `0` | `0` | `1`（跨 AZ 流量费） | `0` |
| EKS 升级到 supported version | `1`（控制面 + 节点滚动） | `1` | `0` | `1` |
| Lambda 加 reserved concurrency | `0` | `0` | `0` | `0` |
| RDS 引擎大版本升级 | `1` | `1` | `0` | `1` |

### 在 finding 表格里的呈现

```
| Result | Severity | Finding | Down | Slow | Cost | Test |
|--------|----------|---------|------|------|------|------|
| Single-AZ prod RDS | 🟠 HIGH | RDS {id} 无自动故障切换 | 0 | 1 | 1 | 0 |
```

值用 `0/1/-1` 简记，可粘贴回 reporter.json schema。

## Risk Issue Classification (aggregated)

### HRI — High Risk Issue
- Any CRITICAL finding
- Any HIGH finding with blast radius > 1 service
- Cluster of 3+ MEDIUM findings in the same pillar
- Cross-pillar issue (affects 2+ pillars)

### MRI — Medium Risk Issue
- Isolated HIGH findings (single service impact)
- MEDIUM findings with cost or performance impact
- Missing best practices in non-critical areas

### LRI — Low Risk Issue
- LOW findings
- Optimization opportunities
- Informational recommendations

## Priority Scoring Matrix

```
Priority Score = Impact Score × (1 / Fix Effort Score)

Impact Score (1-5):
  5 = Data loss or security breach potential
  4 = Service outage potential
  3 = Degraded performance or high cost waste
  2 = Non-compliance or operational friction
  1 = Minor improvement

Fix Effort Score (1-5):
  1 = One CLI command / console toggle (minutes)
  2 = Configuration change (hours)
  3 = Architecture modification (days)
  4 = Multi-service redesign (weeks)
  5 = Major migration (months)

Quick Wins = High Impact (4-5) + Low Effort (1-2)
```

## Cross-Pillar Impact Map

| Primary Pillar | Commonly Affects | Example |
|---------------|-----------------|---------|
| Security | All pillars | Missing encryption affects reliability + compliance |
| Reliability | Performance, Cost | Under-provisioned = poor performance AND cost spikes |
| Performance | Cost, Reliability | Over-provisioned = cost waste; under = reliability risk |
| Cost | Sustainability | Idle resources = wasted energy |
| Ops Excellence | Reliability | No monitoring = slow incident response |
| Sustainability | Cost | Energy-inefficient = higher cloud bill |
