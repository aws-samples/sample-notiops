# Environment Bootstrap Guide

## Step 1: AWS CLI Detection

```bash
which aws 2>/dev/null && aws --version 2>/dev/null
```

**If found**: Record version, proceed to Step 2.

**If not found**: Guide installation:
```bash
# macOS
brew install awscli

# Linux (pip)
pip3 install awscli --user

# Linux (official)
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
unzip awscliv2.zip && sudo ./aws/install
```

If user declines: Switch to **questionnaire-only mode** (no programmatic checks).

## Step 2: Credential Verification

```bash
aws sts get-caller-identity --output json
```

Record:
- `Account`: Target AWS account
- `Arn`: Role/User ARN
- `UserId`: Session identifier

**If fails**: Guide credential setup:
1. Option A: `aws configure` with access key
2. Option B: `aws configure --profile wa-review` with named profile
3. Option C: Source environment file (`source ~/.aws-creds.sh`)
4. Option D: Skip → questionnaire-only mode

## Step 3: Permission Boundary Validation (MANDATORY)

See [credential-boundary.md](credential-boundary.md) for the full boundary definition.

**Quick validation**:
```bash
# For IAM Role
ROLE_NAME=$(aws sts get-caller-identity --query 'Arn' --output text | grep -oP '(?<=role/)[\w-]+')
aws iam list-attached-role-policies --role-name "$ROLE_NAME" --output json

# For IAM User
USER_NAME=$(aws sts get-caller-identity --query 'Arn' --output text | grep -oP '(?<=user/)[\w-]+')
aws iam list-attached-user-policies --user-name "$USER_NAME" --output json
```

**Allowed policies** (any of):
- `arn:aws:iam::aws:policy/ReadOnlyAccess`
- `arn:aws:iam::aws:policy/ViewOnlyAccess`
- `arn:aws:iam::aws:policy/SecurityAudit`
- Custom policy with only Describe/Get/List actions

**Blocked policies** (any of):
- `arn:aws:iam::aws:policy/AdministratorAccess`
- `arn:aws:iam::aws:policy/PowerUserAccess`
- Any policy containing write/modify/delete actions

**If boundary violated**: Display warning and HALT. Do NOT proceed.

## Step 4: Region and Scope Detection

```bash
# Current region
aws configure get region

# List available regions
aws ec2 describe-regions --query 'Regions[].RegionName' --output json

# List VPCs in target region
aws ec2 describe-vpcs --query 'Vpcs[].{VpcId:VpcId,Cidr:CidrBlock,Name:Tags[?Key==`Name`].Value|[0]}' --output table
```

Present to user for confirmation:
```
📋 ASSESSMENT SCOPE

Account:  123456789012
Region:   ap-northeast-1
VPCs:     vpc-abc123 (Production), vpc-def456 (Staging)
Framework: General WA Framework (6 pillars)
Mode:     Autopilot (Security-First)

Proceed? (Y/N)
```

## Step 5: Environment Summary

After all checks pass, log:
```
[BOOTSTRAP] Environment Ready:
• AWS CLI: {version} ✅
• Credentials: {arn} ✅
• Permission Boundary: ReadOnly ✅
• Region: {region}
• VPCs: {count} VPCs in scope
• Framework: General WA (6 pillars, Security-First)
• Mode: Autopilot
```

---

## Context Budget — DON'T-FETCH List

> 来源：service-screener-v2 wa-summarizer prompt 的 negative scope 设计。Agent 最常见失败是一口气拉下大 dump 把上下文窗口吃光。**以下 API/输出默认不调**，需要时走 subagent 或写文件。

### 默认禁调的大输出类 API

| Forbidden by default | 代替方案 |
|----------------------|----------|
| `aws cloudtrail lookup-events`（动辄上百万行） | 需要查安全事件时用 Athena + S3 trail logs、或限定 `--start-time` 几小时 + `--max-results 50` |
| `aws ec2 describe-snapshots --owner-ids self`（账号老上千条） | 限定 `--filters "Name=start-time,..."` 只看近 30 天 |
| `aws s3api list-objects-v2`（文件多的 bucket 极易爆炸） | 只针对明确小 bucket，加 `--max-items 100` |
| `aws config get-resource-config-history`（按资源个数 × 添加频率） | 限定 `--resource-id` + `--limit 10` |
| `aws ec2 describe-instances`（大账号上千台） | 加 `--filters Name=instance-state-name,Values=running` + `--query 'Reservations[].Instances[].{Id:InstanceId,Type:InstanceType,AZ:Placement.AvailabilityZone,State:State.Name}'`，不要拉全量字段 |
| `aws iam get-account-authorization-details`（返回全账号 IAM dump） | 拆分：`list-users` / `list-roles` / 按需 `get-policy-version` |
| `aws lambda list-functions` 不加 `--query`（FunctionVersion 可能上千） | 加 `--query 'Functions[].{Name:FunctionName,Runtime:Runtime,Memory:MemorySize}'` |
| `aws ce get-cost-and-usage` 不限定 granularity/group-by | 限定 `--granularity DAILY --time-period 近 30 天 --group-by Type=DIMENSION,Key=SERVICE` |
| 任何返回 >500KB 的单次调用 | **走 subagent**：spawn 个子 session 调用、提炼后只拿总结回主 session |

### 动手前的 3 个必问

1. **调用返回多少条记录？** 不确定先加 `--max-items 5` 探路
2. **返回体多大？** >50KB 的单次输出不要 read 到主 context
3. **这条 finding 需要这么多详情吗？** Severity + count 差不多了，完整资源 ID 列表走 Appendix

### subagent 隔离原则

- 3+ 个服务同时调 list · 单个输出 >150 行 · 需要多轮过滤聚合 → spawn subagent
- 主 session 只拿结论 + 决策，不拿原始 dump
- subagent 带回的 finding 表格限 50 行，超出走附件
