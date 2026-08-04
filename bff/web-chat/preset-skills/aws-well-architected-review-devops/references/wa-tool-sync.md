# AWS WA Tool Sync — Optional Post-Assessment

> **This step is OPTIONAL.** It requires write permissions to the AWS WA Tool API (`wellarchitected:*`).
> Use separate credentials from the read-only assessment credentials.

## Prerequisites

- Completed WA Review assessment with findings
- IAM role/user with `wellarchitected:*` permissions
- AWS CLI configured with the write-capable credentials

## Required IAM Policy

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "wellarchitected:CreateWorkload",
      "wellarchitected:UpdateWorkload",
      "wellarchitected:GetWorkload",
      "wellarchitected:ListWorkloads",
      "wellarchitected:AssociateLenses",
      "wellarchitected:ListLensReviews",
      "wellarchitected:ListAnswers",
      "wellarchitected:UpdateAnswer",
      "wellarchitected:GetAnswer",
      "wellarchitected:CreateMilestone",
      "wellarchitected:GetLensReview",
      "wellarchitected:GetLensReviewReport",
      "wellarchitected:TagResource"
    ],
    "Resource": "*"
  }]
}
```

## Sync Flow

### Step 1: Create or Find Workload

```bash
# List existing workloads
aws wellarchitected list-workloads --query 'WorkloadSummaries[].{Id:WorkloadId,Name:WorkloadName}' --output table

# Create new workload
aws wellarchitected create-workload \
  --workload-name "{workload_name}" \
  --description "WA Review - {date}" \
  --environment PRODUCTION \
  --aws-regions "{region}" \
  --review-owner "{owner_email}" \
  --lenses wellarchitected \
  --query 'WorkloadId' --output text
```

### Step 2: Associate Lenses

```bash
aws wellarchitected associate-lenses \
  --workload-id {workload_id} \
  --lens-aliases wellarchitected
```

### Step 3: Populate Answers

For each pillar, list questions and update answers based on assessment findings:

```bash
# List questions for a pillar
aws wellarchitected list-answers \
  --workload-id {workload_id} \
  --lens-alias wellarchitected \
  --pillar-id security \
  --query 'AnswerSummaries[].{QuestionId:QuestionId,QuestionTitle:QuestionTitle}' \
  --output table

# Update an answer
aws wellarchitected update-answer \
  --workload-id {workload_id} \
  --lens-alias wellarchitected \
  --question-id {question_id} \
  --selected-choices {choice_id_1} {choice_id_2} \
  --notes "Assessment finding: {finding_summary}" \
  --is-applicable
```

### Step 4: Create Milestone

```bash
aws wellarchitected create-milestone \
  --workload-id {workload_id} \
  --milestone-name "AI-WA Review {date}" \
  --query 'MilestoneNumber' --output text
```

### Step 5: Generate WA Tool Report

```bash
aws wellarchitected get-lens-review \
  --workload-id {workload_id} \
  --lens-alias wellarchitected \
  --output json

aws wellarchitected get-lens-review-report \
  --workload-id {workload_id} \
  --lens-alias wellarchitected \
  --query 'LensReviewReport.Base64String' --output text | base64 -d > wa-tool-report.pdf
```

## Pillar ID Mapping

| Pillar | WA Tool Pillar ID |
|--------|------------------|
| Security | `security` |
| Operational Excellence | `operationalExcellence` |
| Reliability | `reliability` |
| Performance Efficiency | `performance` |
| Cost Optimization | `costOptimization` |
| Sustainability | `sustainability` |

## Error Handling

| Error | Action |
|-------|--------|
| ConflictException (workload exists) | Offer to update existing workload |
| ValidationException (invalid choice) | Log and skip that question |
| ThrottlingException (429) | Exponential backoff |
| AccessDeniedException | Missing WA Tool permissions — guide IAM setup |

---

## AWS WA Tool API 工程细节（必读避坑）

> 以下 7 个细节是 service-screener-v2 的 `frameworks/helper/WATools.py` 踩过的坑，AWS 官方文档中 **读不到**。运行 sync 流程前逐项核对。

### 1. 幂等创建模式：list-by-prefix 而非 get-by-id

创建 workload 之前必须先 list 所有 workload 按名称前缀过滤，避免重复创建。

```bash
# 错误：直接创建 → 可能产生同名 workload、后续查询混乱
# 正确：先 list 检查是否已存在
existing=$(aws wellarchitected list-workloads \
  --workload-name-prefix "{workload_name}" \
  --query "WorkloadSummaries[?WorkloadName=='{workload_name}'].WorkloadId" \
  --output text)

if [ -n "$existing" ]; then
  echo "Workload exists: $existing, reuse"
  workload_id="$existing"
else
  workload_id=$(aws wellarchitected create-workload ... --query 'WorkloadId' --output text)
fi
```

### 2. Milestone 命名 × ConflictException 3 次重试

Milestone name 在 workload 内全局唯一，同名会冲突。必须加时间戳 + attempt 后缀 + 3 次重试。

```bash
for attempt in 1 2 3; do
  ts=$(date +%Y%m%d%H%M%S)
  milestone_name="AI-WA-${ts}-${attempt}"
  result=$(aws wellarchitected create-milestone \
    --workload-id "$workload_id" \
    --milestone-name "$milestone_name" \
    --query 'MilestoneNumber' --output text 2>&1)
  if [[ "$result" != *ConflictException* ]]; then
    echo "$result"; break
  fi
  sleep 1
done
```

参考：`SS-{YYYYMMDDHHmmss}-{attempt}` 是 service-screener 的原生命名。

### 3. Notes 必须截断到 2000 字符

`update_answer` 的 `--notes` API 上限是 2048，但多字节字符会超。留 buffer 截到 2000。

```bash
notes=$(echo "$finding_summary" | head -c 2000)
aws wellarchitected update-answer ... --notes "$notes"
```

如果 notes 被截，末尾加一行 `... [truncated, full report at: <link>]`。

### 4. selectedChoices 必须 dedupe + 过滤 None

```bash
# 错误：--selected-choices 传了重复 ID 或空字符串 → ValidationException
# 正确：先 dedupe + 过滤空
choices=$(echo "$raw_choices" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ' ')
aws wellarchitected update-answer ... --selected-choices $choices
```

### 5. workload 创建后 ≈ 3s 最终一致性窗口

刚创建的 workload 立刻调 `list-answers` 会 `ResourceNotFoundException`。加 3 次 × 3s 重试。

```bash
for attempt in 1 2 3; do
  result=$(aws wellarchitected list-answers \
    --workload-id "$workload_id" \
    --lens-alias wellarchitected \
    --pillar-id security 2>&1)
  if [[ "$result" != *ResourceNotFoundException* ]]; then
    echo "$result"; break
  fi
  sleep 3
done
```

### 6. 权限降级标志位：碑不崩溃

Agent 流程遇到 `AccessDeniedException` 不应 crash 全部同步，而是设个 `HASPERMISSION=false` 标志位，跳过后续写操作，只输出本地报告 + 提示客户手工导入 WA Tool。

```bash
HASPERMISSION=true
result=$(aws wellarchitected list-workloads 2>&1) || true
if [[ "$result" == *AccessDenied* ]]; then
  HASPERMISSION=false
  echo "⚠️ WA Tool 写权限缺失，后续 sync 步骤跳过。本地报告仍会生成。"
fi
```

### 7. list_answers 不要传 MilestoneNumber

service-screener 代码中有一行被注释掉的 `list_answers(MilestoneNumber=...)` —— 实际用 milestone-attached answers 查询 API 行为不稳。**不要加 MilestoneNumber 参数**，始终查当前 state。

---

## 调用顺序 Checklist

```
[✓] 预检查：region / reportName / new-milestone-flag 各一个必填
[✓] preflight 调 list-workloads，判定 HASPERMISSION
[✓] HASPERMISSION=false → 跳过后续，只输出本地 .md 报告
[✓] HASPERMISSION=true → list-by-prefix 检查同名 workload
[✓] 不存在则 create-workload，存在则复用
[✓] sleep 3 + retry list-answers（最终一致性）
[✓] 按 pillar 递归，update-answer 逐问题写入 (notes 截 2000、choices dedupe)
[✓] 所有 update 完成 → create-milestone × ConflictException 3 次重试
[✓] 最后 get-lens-review-report 拉 PDF
```

---

## 反向同步（不支持）

WATools.py 只做单向推（本地报告 → WA Tool）。**不从 WA Tool 拉回人工修订的答题**。如需双向：
- 在本地报告里标记 `ManualOverride: true` 的 finding
- sync 时跳过这些字段，避免覆盖人工决策
- 本 skill 未实现，记载为 known limitation
