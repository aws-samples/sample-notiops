#!/bin/bash
# ============================================================
# NotiOps — Payer 账号 CUR + Athena 独立配置脚本
# ============================================================
# 背景：NotiOps 部署在 Organization 的成员账号（如 111122223333），但真实历史
# 成本 / DevOps Agent 账单明细大多记在 payer 账号上。成员账号自己建的 CUR 只包含
# 它自己的账单行，看不到 payer 侧的 AWSDevOpsAgent 等费用——必须在 payer 账号
# 自己也跑一遍 CUR + Athena 集成流程。
#
# 本脚本自包含（不依赖 setup.sh / CDK / lambda6_cur_finalizer），因为 payer 账号
# 通常没有部署 NotiOps 的任何基础设施（Lambda / EventBridge Scheduler / DDB
# 状态表）。用法：
#
#   ./scripts/setup_payer_cur.sh                 # 阶段一：创建 CUR（若不存在）
#   ./scripts/setup_payer_cur.sh --finalize       # 阶段二：24h 后手动跑，
#                                                  #   检测模板交付并部署 Athena 集成
#   ./scripts/setup_payer_cur.sh --status         # 只查当前状态，不做任何改动
#
# 前置：当前 shell 的 AWS 凭证（AWS_PROFILE / 环境变量）必须指向 payer 账号，
# 且该身份需要 cur:PutReportDefinition / cur:DescribeReportDefinitions /
# s3:CreateBucket / cloudformation:CreateStack / iam:CreateRole 等权限
# （与 setup.sh §13 CUR + Athena FinOps 数据源要求的权限一致）。
#
# 状态记录：本脚本把状态写本地文件 .notiops-payer-cur-state.json（脚本所在目录），
# 不依赖任何远程状态表——payer 账号侧独立运行，不需要 NotiOps 的 DDB。
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$SCRIPT_DIR/.notiops-payer-cur-state.json"
REGION="us-east-1"  # CUR API 是全局服务，端点固定 us-east-1

MODE="create"
for arg in "$@"; do
  case "$arg" in
    --finalize) MODE="finalize" ;;
    --status)   MODE="status" ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

# ─── 前置：确认凭证确实指向一个账号，且打印出来让用户核对（防止在错误账号上跑）───
echo "── 验证 AWS 凭证 ──"
CALLER_JSON=$(aws sts get-caller-identity --region "$REGION" 2>&1) || {
  echo "❌ 无法获取凭证身份，请检查 AWS_PROFILE / 凭证配置："
  echo "$CALLER_JSON"
  exit 1
}
ACCOUNT_ID=$(echo "$CALLER_JSON" | jq -r '.Account')
CALLER_ARN=$(echo "$CALLER_JSON" | jq -r '.Arn')
echo "  账号: $ACCOUNT_ID"
echo "  身份: $CALLER_ARN"
echo ""
read -p "确认这是 payer 账号，继续？[Y/n]: " CONFIRM
case "${CONFIRM:-Y}" in
  [nN]*) echo "已取消"; exit 0 ;;
esac

# ─── 读取本地状态（若有） ───
_read_state() {
  if [ -f "$STATE_FILE" ]; then cat "$STATE_FILE"; else echo "{}"; fi
}
_write_state() {
  echo "$1" > "$STATE_FILE"
}

CURRENT_STATE=$(_read_state)
STATE_ACCOUNT=$(echo "$CURRENT_STATE" | jq -r '.account_id // ""')
if [ -n "$STATE_ACCOUNT" ] && [ "$STATE_ACCOUNT" != "$ACCOUNT_ID" ]; then
  echo "⚠️  本地状态文件记录的账号（$STATE_ACCOUNT）与当前凭证账号（$ACCOUNT_ID）不一致。"
  echo "   如果你是故意换了账号，删除 $STATE_FILE 后重跑；否则请检查凭证配置。"
  exit 1
fi

# ─── --status：只读展示，不做任何改动 ───
if [ "$MODE" = "status" ]; then
  echo ""
  echo "── 当前状态（本地记录） ──"
  echo "$CURRENT_STATE" | jq .
  if [ -n "$(echo "$CURRENT_STATE" | jq -r '.bucket // ""')" ]; then
    BUCKET=$(echo "$CURRENT_STATE" | jq -r '.bucket')
    REPORT_NAME=$(echo "$CURRENT_STATE" | jq -r '.report_name')
    PREFIX=$(echo "$CURRENT_STATE" | jq -r '.prefix')
    echo ""
    echo "── 检查 crawler-cfn.yml 是否已交付 ──"
    FOUND=$(aws s3 ls "s3://$BUCKET/$PREFIX/$REPORT_NAME/" --recursive 2>/dev/null | grep -c "crawler-cfn.yml" || echo "0")
    if [ "$FOUND" -gt 0 ]; then
      echo "  ✓ 模板已交付，可以跑 --finalize 部署 Athena 集成"
    else
      echo "  ⏳ 模板尚未交付（AWS 首次交付最长 24 小时）"
    fi
  fi
  exit 0
fi

# ─── --finalize：阶段二，检测模板交付并部署 Athena 集成 CFN 栈 ───
if [ "$MODE" = "finalize" ]; then
  BUCKET=$(echo "$CURRENT_STATE" | jq -r '.bucket // ""')
  REPORT_NAME=$(echo "$CURRENT_STATE" | jq -r '.report_name // ""')
  PREFIX=$(echo "$CURRENT_STATE" | jq -r '.prefix // ""')
  if [ -z "$BUCKET" ] || [ -z "$REPORT_NAME" ]; then
    echo "❌ 本地没有阶段一的记录（$STATE_FILE 缺 bucket/report_name）。"
    echo "   请先不带参数跑一次本脚本完成阶段一，或手动在状态文件里补充。"
    exit 1
  fi

  echo ""
  echo "── 检查 CUR 报告是否已交付（S3 里应该能看到 crawler-cfn.yml）──"
  TEMPLATE_KEY=$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix "$PREFIX/$REPORT_NAME/" \
    --query "Contents[?ends_with(Key,'crawler-cfn.yml')].Key | [0]" --output text 2>/dev/null || echo "None")
  if [ "$TEMPLATE_KEY" = "None" ] || [ -z "$TEMPLATE_KEY" ]; then
    echo "  ⏳ 模板尚未交付。AWS 首次交付最长 24 小时，创建时间: $(echo "$CURRENT_STATE" | jq -r '.created_at // "未知"')"
    echo "     稍后重跑 ./scripts/setup_payer_cur.sh --finalize"
    exit 0
  fi
  echo "  ✓ 找到模板: s3://$BUCKET/$TEMPLATE_KEY"

  STACK_NAME="notiops-cur-athena-${ACCOUNT_ID}"
  echo ""
  echo "── 部署 Athena 集成 CFN 栈: $STACK_NAME ──"
  echo "  该模板由 AWS 自动生成，包含："
  echo "    · 3 个 IAM Role（Glue Crawler 执行角色等）"
  echo "    · 1 个 Glue Database + 1 个 Glue Crawler"
  echo "    · 2 个 Lambda（S3 事件触发，自动重跑 Crawler）"
  echo "    · 1 个 S3 事件通知（挂在 CUR 交付桶上）"
  read -p "  确认部署？[Y/n]: " DEPLOY_CONFIRM
  case "${DEPLOY_CONFIRM:-Y}" in
    [nN]*) echo "已取消，模板已找到但未部署，可稍后重跑 --finalize"; exit 0 ;;
  esac

  TEMPLATE_URL=$(aws s3 presign "s3://$BUCKET/$TEMPLATE_KEY" --region "$REGION" --expires-in 3600)

  EXISTING_STACK_STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "NOT_FOUND")

  if [ "$EXISTING_STACK_STATUS" = "CREATE_COMPLETE" ] || [ "$EXISTING_STACK_STATUS" = "UPDATE_COMPLETE" ]; then
    echo "  ✓ 栈已存在且状态正常（$EXISTING_STACK_STATUS），跳过重新创建"
  else
    aws cloudformation create-stack --stack-name "$STACK_NAME" \
      --template-url "$TEMPLATE_URL" \
      --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
      --tags Key=auto-delete,Value=no Key=notiops:component,Value=cur-athena \
      --region "$REGION" --on-failure DO_NOTHING >/dev/null
    echo "  → 已提交创建，等待完成（最长 4 分钟）..."
    if aws cloudformation wait stack-create-complete --stack-name "$STACK_NAME" --region "$REGION" 2>/dev/null; then
      echo "  ✓ CREATE_COMPLETE"
    else
      FINAL_STATUS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
        --query "Stacks[0].StackStatus" --output text 2>/dev/null || echo "UNKNOWN")
      echo "  ⚠️ 未在预期时间内完成，当前状态: $FINAL_STATUS —— 去 CloudFormation 控制台查看详情"
      exit 1
    fi
  fi

  ATHENA_DATABASE=$(echo "$REPORT_NAME" | tr '[:upper:]' '[:lower:]' | tr '-' '_')
  NEW_STATE=$(echo "$CURRENT_STATE" | jq \
    --arg status "READY" --arg stack "$STACK_NAME" --arg db "$ATHENA_DATABASE" \
    --arg updated "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '.status = $status | .athena_stack_name = $stack | .athena_database = $db | .updated_at = $updated')
  _write_state "$NEW_STATE"

  echo ""
  echo "✅ 完成。Athena database: $ATHENA_DATABASE"
  echo "   现在可以用 Athena 查询该账号的 CUR 明细，例如："
  echo "   SELECT * FROM ${ATHENA_DATABASE}.<table> WHERE product_product_name = 'AWSDevOpsAgent'"
  exit 0
fi

# ─── 阶段一（默认模式）：检测既有 CUR / 新建 ───
echo ""
echo "── 检测该账号是否已有符合条件（Hourly + Resource IDs + Athena 集成）的 CUR ──"
EXISTING_CUR_JSON=$(aws cur describe-report-definitions --region "$REGION" \
  --query "ReportDefinitions[?TimeUnit=='HOURLY' && contains(AdditionalSchemaElements, 'RESOURCES') && ReportVersioning!=null]" \
  --output json 2>/dev/null || echo "[]")
EXISTING_CUR_COUNT=$(echo "$EXISTING_CUR_JSON" | jq 'length' 2>/dev/null || echo "0")

CUR_CHOICE="0"
if [ "$EXISTING_CUR_COUNT" -gt 0 ] 2>/dev/null; then
  echo "  发现 $EXISTING_CUR_COUNT 个符合条件的既有 CUR 报告："
  echo "$EXISTING_CUR_JSON" | jq -r '.[] | "    - \(.ReportName)  (bucket: \(.S3Bucket))"'
  echo ""
  echo "  0) 新建专用 CUR + S3 桶（AWS 官方推荐）"
  echo "  1) 复用第一个既有报告: $(echo "$EXISTING_CUR_JSON" | jq -r '.[0].ReportName')"
  read -p "  输入编号 [默认: 0 新建]: " CUR_CHOICE
  CUR_CHOICE="${CUR_CHOICE:-0}"
fi

if [ "$CUR_CHOICE" = "1" ] && [ "$EXISTING_CUR_COUNT" -gt 0 ] 2>/dev/null; then
  CUR_BUCKET=$(echo "$EXISTING_CUR_JSON" | jq -r '.[0].S3Bucket')
  CUR_REPORT_NAME=$(echo "$EXISTING_CUR_JSON" | jq -r '.[0].ReportName')
  CUR_PREFIX=$(echo "$EXISTING_CUR_JSON" | jq -r '.[0].S3Prefix')
  echo "  ✓ 复用既有 CUR: $CUR_REPORT_NAME (bucket: $CUR_BUCKET)"

  # 实际去 Glue Data Catalog 里找这份 CUR 对应的 Athena database/table，而不是
  # 猜名字或直接标记 READY——AWS 官方 CFN 集成生成的库名规则是
  # athenacurcfn_<report_name 小写去特殊字符>，但历史上手动建过 Athena 集成的
  # CUR 命名可能不遵循这个规则，所以用"扫全部 database 找匹配表结构"兜底。
  echo ""
  echo "── 在 Glue Data Catalog 里查找对应的 Athena 表 ──"
  ALL_DBS=$(aws glue get-databases --region "$REGION" --query "DatabaseList[].Name" --output text 2>/dev/null || echo "")
  FOUND_DB=""
  FOUND_TABLE=""
  FOUND_PARTITIONED="false"
  for db in $ALL_DBS; do
    TABLES=$(aws glue get-tables --database-name "$db" --region "$REGION" \
      --query "TableList[?StorageDescriptor.Columns[?Name=='line_item_unblended_cost']].Name" \
      --output text 2>/dev/null || echo "")
    for tbl in $TABLES; do
      # 用 S3 location 是否指向同一个 CUR 桶来确认这张表就是这份报告的
      LOCATION=$(aws glue get-table --database-name "$db" --name "$tbl" --region "$REGION" \
        --query "Table.StorageDescriptor.Location" --output text 2>/dev/null || echo "")
      if [[ "$LOCATION" == *"$CUR_BUCKET"* ]]; then
        FOUND_DB="$db"
        FOUND_TABLE="$tbl"
        PARTITION_KEYS=$(aws glue get-table --database-name "$db" --name "$tbl" --region "$REGION" \
          --query "Table.PartitionKeys[].Name" --output text 2>/dev/null || echo "")
        if [[ "$PARTITION_KEYS" == *"year"* ]]; then FOUND_PARTITIONED="true"; fi
        break 2
      fi
    done
  done

  if [ -n "$FOUND_DB" ]; then
    echo "  ✓ 找到: database=$FOUND_DB, table=$FOUND_TABLE, year/month 分区=$FOUND_PARTITIONED"
    NEW_STATE=$(jq -n --arg acc "$ACCOUNT_ID" --arg status "READY" --arg bucket "$CUR_BUCKET" \
      --arg report "$CUR_REPORT_NAME" --arg prefix "$CUR_PREFIX" \
      --arg db "$FOUND_DB" --arg table "$FOUND_TABLE" --arg partitioned "$FOUND_PARTITIONED" \
      --arg updated "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
      '{account_id:$acc, status:$status, bucket:$bucket, report_name:$report, prefix:$prefix,
        athena_database:$db, athena_table:$table, year_month_partitioned:($partitioned=="true"),
        updated_at:$updated}')
    _write_state "$NEW_STATE"
    echo ""
    echo "✅ 已确认 Athena 集成存在。查询示例："
    if [ "$FOUND_PARTITIONED" = "true" ]; then
      echo "   SELECT * FROM ${FOUND_DB}.${FOUND_TABLE} WHERE year='2026' AND month='07' AND product_product_name='AWSDevOpsAgent'"
    else
      echo "   SELECT * FROM ${FOUND_DB}.${FOUND_TABLE} WHERE product_product_name='AWSDevOpsAgent'"
    fi
  else
    echo "  ⚠️ 没在任何 Glue database 里找到指向 $CUR_BUCKET 的表。"
    echo "     可能 Athena 集成还没建（这份 CUR 只是普通报告，没跑过官方 CFN 模板/手动建表）。"
    NEW_STATE=$(jq -n --arg acc "$ACCOUNT_ID" --arg status "DELAYED" --arg bucket "$CUR_BUCKET" \
      --arg report "$CUR_REPORT_NAME" --arg prefix "$CUR_PREFIX" \
      --arg note "复用既有 CUR，但 Glue Catalog 里没找到对应表，Athena 集成可能未建" \
      '{account_id:$acc, status:$status, bucket:$bucket, report_name:$report, prefix:$prefix, note:$note}')
    _write_state "$NEW_STATE"
    echo "     去 S3 桶 $CUR_BUCKET 下确认是否有 crawler-cfn.yml，有则可跑 --finalize 部署。"
  fi
  exit 0
fi

CUR_BUCKET="notiops-payer-cur-${ACCOUNT_ID}-${REGION}"
CUR_REPORT_NAME="notiops-payer-cur-report"
CUR_PREFIX="cur"

echo "  → 新建专用 S3 桶: $CUR_BUCKET"
if aws s3api head-bucket --bucket "$CUR_BUCKET" --region "$REGION" >/dev/null 2>&1; then
  echo "    (桶已存在，复用)"
else
  aws s3api create-bucket --bucket "$CUR_BUCKET" --region "$REGION" >/dev/null
  cat > /tmp/notiops-payer-cur-bucket-policy.json <<EOF
{
  "Version": "2008-10-17",
  "Statement": [
    {"Sid": "AllowCURServiceGetAcl", "Effect": "Allow",
     "Principal": {"Service": "billingreports.amazonaws.com"},
     "Action": ["s3:GetBucketAcl", "s3:GetBucketPolicy"], "Resource": "arn:aws:s3:::$CUR_BUCKET",
     "Condition": {"StringEquals": {"aws:SourceAccount": "$ACCOUNT_ID"}, "StringLike": {"aws:SourceArn": "arn:aws:cur:us-east-1:$ACCOUNT_ID:definition/*"}}},
    {"Sid": "AllowCURServicePutObject", "Effect": "Allow",
     "Principal": {"Service": "billingreports.amazonaws.com"},
     "Action": "s3:PutObject", "Resource": "arn:aws:s3:::$CUR_BUCKET/*",
     "Condition": {"StringEquals": {"aws:SourceAccount": "$ACCOUNT_ID"}, "StringLike": {"aws:SourceArn": "arn:aws:cur:us-east-1:$ACCOUNT_ID:definition/*"}}}
  ]
}
EOF
  aws s3api put-bucket-policy --bucket "$CUR_BUCKET" --policy file:///tmp/notiops-payer-cur-bucket-policy.json
  rm -f /tmp/notiops-payer-cur-bucket-policy.json
fi

echo "  → 创建 CUR ReportDefinition: $CUR_REPORT_NAME（Hourly + Resource IDs + Athena/Parquet）"
aws cur put-report-definition --region "$REGION" --report-definition "{
  \"ReportName\": \"$CUR_REPORT_NAME\",
  \"TimeUnit\": \"HOURLY\",
  \"Format\": \"Parquet\",
  \"Compression\": \"Parquet\",
  \"AdditionalSchemaElements\": [\"RESOURCES\"],
  \"S3Bucket\": \"$CUR_BUCKET\",
  \"S3Prefix\": \"$CUR_PREFIX\",
  \"S3Region\": \"$REGION\",
  \"AdditionalArtifacts\": [\"ATHENA\"],
  \"RefreshClosedReports\": true,
  \"ReportVersioning\": \"OVERWRITE_REPORT\"
}"

NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
NEW_STATE=$(jq -n --arg acc "$ACCOUNT_ID" --arg status "PENDING" --arg bucket "$CUR_BUCKET" \
  --arg report "$CUR_REPORT_NAME" --arg prefix "$CUR_PREFIX" --arg created "$NOW_ISO" \
  '{account_id:$acc, status:$status, bucket:$bucket, report_name:$report, prefix:$prefix, created_at:$created}')
_write_state "$NEW_STATE"

echo ""
echo "✅ CUR 报告已创建，AWS 需要最长 24 小时首次交付。"
echo "   24 小时后运行：./scripts/setup_payer_cur.sh --finalize"
echo "   随时查看状态：./scripts/setup_payer_cur.sh --status"
