#!/bin/bash
# =============================================================================
# teardown.sh —— 删除 ./setup.sh 部署出来的整套 NotiOps 环境
# =============================================================================
# 和 setup.sh 一一对应:setup.sh 建了什么,这里就删什么 —— 顺序按依赖倒序,
# 并把 setup.sh 用 boto3/CLI 直建的「非 CDK 资源」(CUR 报告、CUR 桶、
# EventBridge Scheduler、WebSearch Gateway、Secrets 的恢复期)一起收尾。
#
# 两档语义(与一键部署的 TeardownMode 对齐):
#   默认(保数据)          删栈与运行时,保留三张 RETAIN 表(notiops-config /
#                         notiops-conversations / notiops-web-chat)与 CUR 报告/CUR 桶。
#   --delete-everything   连表、CUR 报告、CUR 桶、Athena 保存查询、残留日志组一起删。
#
# ⚠️ 数据桶 notiops-data-<账号>-<区域> 在 setup.sh 这条路径上是 DESTROY +
#    autoDeleteObjects,**两档都会随主栈消失**(Skills、长报告都在里面)。所以本脚本
#    默认会先把它同步到本地备份目录;不想备份用 --no-backup。
#
# 用法:
#   ./teardown.sh --dry-run                    # 只盘点,不删任何东西(先跑这个)
#   ./teardown.sh                              # 删环境、保数据(会要求手输账号号码确认)
#   ./teardown.sh --delete-everything          # 全删(额外要求输入 DELETE EVERYTHING)
#   ./teardown.sh --region us-east-1 --profile my-profile
#   ./teardown.sh --backup-dir ~/notiops-backup   # 指定备份目录
#   ./teardown.sh --delete-member-stacksets    # 多账号部署:连成员账号 StackSet 一起删
#
# 参数:
#   --region <r>                部署区域(默认取 AWS_REGION / AWS_DEFAULT_REGION,再问)
#   --profile <p>               AWS CLI profile(默认取 AWS_PROFILE / default)
#   --dry-run                   只盘点并打印将要执行的删除,不改任何东西
#   --delete-everything         连数据一起删(表 / CUR / 保存查询 / 残留日志组)
#   --backup-dir <dir>          备份目录(默认 ./notiops-teardown-backup-<时间戳>)
#   --no-backup                 不做任何备份(数据桶随栈消失,不可恢复)
#   --delete-member-stacksets   删两个成员账号 StackSet 及其实例(跨账号,默认跳过)
#   --yes                       跳过交互确认(自动化用;极其危险,请配合 --dry-run 先验)
#   --lang zh|en                界面语言(默认按 $LANG 判断)
#
# 绝不碰的东西(哪怕名字里有 notiops):CDK bootstrap(CDKToolkit 栈、
# cdk-hnb659fds-assets-* 桶、cdk-hnb659fds-container-assets-* ECR、
# SSM /cdk-bootstrap/hnb659fds/version)、Glue 数据库 cid_cur(属 CID 项目)、
# Security Hub 委派管理员与 Finding Aggregator、任何不在下面白名单里的资源。
# 本脚本只按【精确名字】删,不做前缀批量删除(日志组清理除外,且那几个前缀都是本项目独占)。
# =============================================================================
set -euo pipefail

# ─── 参数解析 ───
REGION=""
PROFILE=""
DRY_RUN=false
DELETE_EVERYTHING=false
BACKUP_DIR=""
DO_BACKUP=true
DELETE_STACKSETS=false
ASSUME_YES=false
UI_LANG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --delete-everything) DELETE_EVERYTHING=true; shift ;;
    --backup-dir) BACKUP_DIR="${2:-}"; shift 2 ;;
    --no-backup) DO_BACKUP=false; shift ;;
    --delete-member-stacksets) DELETE_STACKSETS=true; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --lang) UI_LANG="${2:-}"; shift 2 ;;
    --lang=*) UI_LANG="${1#--lang=}"; shift ;;
    -h|--help) grep '^#[^!]' "$0" | sed 's/^# \{0,1\}//' | head -45; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

# ─── UI 语言检测(与 setup.sh 同一套判据)───
if [ "$UI_LANG" != "en" ] && [ "$UI_LANG" != "zh" ]; then
  case "${LC_ALL:-${LANG:-}}" in
    zh_*|zh|*zh_CN*|*zh_TW*|*zh_HK*) UI_LANG="zh" ;;
    *) UI_LANG="en" ;;
  esac
fi
# t "<中文>" "<English>" —— 按 UI_LANG 输出对应语言。
t() { if [ "$UI_LANG" = "zh" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
export UI_LANG

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
info() { echo "${BLU}[teardown]${RST} $*"; }
ok()   { echo "${GRN}[ ok ]${RST} $*"; }
warn() { echo "${YEL}[warn]${RST} $*"; }
die()  { echo "${RED}[FAIL]${RST} $*" >&2; exit 1; }
step() { echo ""; echo "${BLU}── $* ──${RST}"; }

# ─── 依赖 ───
command -v aws >/dev/null 2>&1 || die "$(t "需要 AWS CLI(未找到 aws 命令)" "AWS CLI is required (aws not found)")"

if [ -n "$PROFILE" ]; then export AWS_PROFILE="$PROFILE"; fi

# 区域:命令行 > 环境变量 > 交互询问。NotiOps 的资源都在部署区,不能猜错。
if [ -z "$REGION" ]; then REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"; fi
if [ -z "$REGION" ]; then
  read -r -p "$(t "部署区域(如 us-east-1): " "Deployment region (e.g. us-east-1): ")" REGION
fi
[ -n "$REGION" ] || die "$(t "必须指定区域(--region)" "A region is required (--region)")"

# `aws` 包装:统一带区域,并把错误吞掉交给调用方判断(只在需要时打印类型化的提示)。
awsc() { aws "$@" --region "$REGION"; }
awsq() { aws "$@" --region "$REGION" --output text 2>/dev/null || true; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
[ -n "$ACCOUNT" ] && [ "$ACCOUNT" != "None" ] || \
  die "$(t "取不到当前账号(凭证无效或已过期)" "Cannot resolve the current account (credentials invalid or expired)")"

# ─── 资源清单(全部来自 setup.sh / CDK 里写死的名字)───
STACK_MAIN="NotiOpsBackendStack"
STACK_BOT="BotStack"
STACK_WEBCHAT="WebChatStack"
STACK_AGENT="AgentCore-NotiOpsWebChat-default"
STACK_CUR_ATHENA="notiops-cur-athena-${ACCOUNT}"
BUCKET_FRONTEND="notiops-frontend-${ACCOUNT}-${REGION}"
BUCKET_CHAT_FRONTEND="notiops-chat-frontend-${ACCOUNT}-${REGION}"
BUCKET_DATA="notiops-data-${ACCOUNT}-${REGION}"
BUCKET_CUR="notiops-cur-${ACCOUNT}-${REGION}"
CUR_REPORT="notiops-cur-report"
SCHEDULE_CUR="notiops-cur-finalizer-${ACCOUNT}"
GW_NAME="notiops-websearch-gw"
GW_ROLE="notiops-websearch-gateway-role"
GW_ROLE_POLICY="NotiOpsWebSearchGateway"
STACKSET_ONBOARD="notiops-member-onboarding"
STACKSET_DA="notiops-member-devops-agent"
TABLES_RETAINED=("notiops-config" "notiops-conversations" "notiops-web-chat")
SECRETS=("notiops/im-bot-feishu" "notiops/slack-bot-token" "notiops/slack-app-token" \
         "notiops/bedrock-api-key" "notiops/litellm-config")
# 日志组:WebChatStack 走 logRetention(Lambda 自建 log group)、ECS/AgentCore 也各自建,
# 删栈后会剩下孤儿。这几个前缀都是本项目独占(栈名前缀 / notiops 前缀),不会误伤别人。
LOG_PREFIXES=("/aws/lambda/notiops" "/aws/vendedlogs/RUMService_notiops" \
              "/aws/bedrock-agentcore/runtimes/NotiOpsWebChat" \
              "NotiOpsBackendStack" "WebChatStack" "BotStack" "AgentCore-NotiOpsWebChat")

# ─── 小工具 ───
stack_status() {  # $1=栈名;不存在返回空
  aws cloudformation describe-stacks --stack-name "$1" --region "$REGION" \
    --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true
}
bucket_exists() { aws s3api head-bucket --bucket "$1" --region "$REGION" >/dev/null 2>&1; }
table_exists()  { aws dynamodb describe-table --table-name "$1" --region "$REGION" >/dev/null 2>&1; }

# 一键部署(单栈 CloudFormation)用的是【同一套物理名】—— 同一个账号+区域里若装过
# 一键部署,notiops-config / notiops-web-chat / notiops-data-* 可能属于那个栈。
# 清空/删除前先问 CloudFormation「这资源是谁的」:不是本脚本负责的那几个栈,就跳过。
owner_stack() {
  aws cloudformation describe-stack-resources --physical-resource-id "$1" --region "$REGION" \
    --query 'StackResources[0].StackName' --output text 2>/dev/null || true
}
is_our_stack() {
  case "$1" in
    "$STACK_MAIN"|"$STACK_BOT"|"$STACK_WEBCHAT"|"$STACK_AGENT"|"$STACK_CUR_ATHENA") return 0 ;;
    *) return 1 ;;
  esac
}
# 返回 0 = 可以动;返回 1 = 属于别的栈,必须跳过(并打印是谁的)。
may_touch() {
  local name="$1" own
  own="$(owner_stack "$name")"
  # 没人认领(栈已删 / 非 CFN 建的资源)→ 可以动。
  if [ -z "$own" ] || [ "$own" = "None" ]; then return 0; fi
  if is_our_stack "$own"; then return 0; fi
  warn "$(t "跳过 $name —— 它属于另一个栈 $own(很可能是一键部署的单栈)。" \
           "Skipping $name — it belongs to another stack, $own (most likely the one-click single stack).")"
  echo "$(t "  要删它请去删那个栈(一键部署用栈参数 TeardownMode 控制保不保数据)。" \
           "  Delete that stack instead (the one-click stack controls data retention via its TeardownMode parameter).")"
  return 1
}

run() {  # dry-run 时只打印
  if [ "$DRY_RUN" = true ]; then echo "    ${YEL}would run:${RST} $*"; return 0; fi
  "$@"
}

# =============================================================================
# 1. 盘点 —— 只看,不动
# =============================================================================
step "$(t "盘点(只读)" "Inventory (read-only)")"
echo "$(t "账号: " "Account: ")${ACCOUNT}    $(t "区域: " "Region: ")${REGION}"
echo "$(t "模式: " "Mode: ")$([ "$DELETE_EVERYTHING" = true ] && t "全删(含数据)" "delete everything (incl. data)" || t "保数据" "keep data")$([ "$DRY_RUN" = true ] && t "  · DRY-RUN(不会删任何东西)" "  · DRY-RUN (nothing will be deleted)")"
echo ""

FOUND_ANY=false
echo "$(t "CloudFormation 栈:" "CloudFormation stacks:")"
for s in "$STACK_AGENT" "$STACK_BOT" "$STACK_WEBCHAT" "$STACK_MAIN" "$STACK_CUR_ATHENA"; do
  st="$(stack_status "$s")"
  if [ -n "$st" ] && [ "$st" != "None" ]; then
    echo "  · $s  ($st)"; FOUND_ANY=true
  else
    echo "  · $s  $(t "—— 不存在" "— not present")"
  fi
done

# 盘点阶段就把「属于别的栈」标出来 —— dry-run 要能提前看见同名冲突,而不是删到一半才知道。
own_note() {
  local own; own="$(owner_stack "$1")"
  if [ -z "$own" ] || [ "$own" = "None" ]; then return 0; fi
  if is_our_stack "$own"; then printf '%s' "  [$own]"; return 0; fi
  printf '%s' "  ⚠️ $(t "属于栈 $own,本脚本会跳过" "owned by stack $own — this script will skip it")"
}

echo "$(t "S3 桶:" "S3 buckets:")"
for b in "$BUCKET_FRONTEND" "$BUCKET_CHAT_FRONTEND" "$BUCKET_DATA" "$BUCKET_CUR"; do
  if bucket_exists "$b"; then
    n="$(aws s3 ls "s3://$b" --recursive --summarize 2>/dev/null | awk '/Total Objects:/{print $3}')"
    echo "  · $b  ($(t "对象数 " "objects ")${n:-?})$(own_note "$b")"; FOUND_ANY=true
  else
    echo "  · $b  $(t "—— 不存在" "— not present")"
  fi
done

echo "$(t "DynamoDB 表(RETAIN,删栈带不走):" "DynamoDB tables (RETAIN — stack deletion keeps them):")"
for tb in "${TABLES_RETAINED[@]}"; do
  if table_exists "$tb"; then
    echo "  · $tb$(own_note "$tb")"; FOUND_ANY=true
  else
    echo "  · $tb  $(t "—— 不存在" "— not present")"
  fi
done

echo "$(t "setup.sh 直建的非 CDK 资源:" "Non-CDK resources created directly by setup.sh:")"
CUR_FOUND="$(aws cur describe-report-definitions --region us-east-1 \
  --query "ReportDefinitions[?ReportName=='${CUR_REPORT}'].ReportName" --output text 2>/dev/null || true)"
[ -n "$CUR_FOUND" ] && [ "$CUR_FOUND" != "None" ] && { echo "  · CUR report: $CUR_REPORT"; FOUND_ANY=true; } \
  || echo "  · CUR report: $CUR_REPORT  $(t "—— 不存在" "— not present")"
SCHED_FOUND="$(awsq scheduler get-schedule --name "$SCHEDULE_CUR" --query Name)"
[ -n "$SCHED_FOUND" ] && [ "$SCHED_FOUND" != "None" ] && { echo "  · Scheduler: $SCHEDULE_CUR"; FOUND_ANY=true; } \
  || echo "  · Scheduler: $SCHEDULE_CUR  $(t "—— 不存在" "— not present")"
GW_ID="$(awsq bedrock-agentcore-control list-gateways --query "items[?name=='${GW_NAME}'].gatewayId | [0]")"
[ -n "$GW_ID" ] && [ "$GW_ID" != "None" ] && { echo "  · WebSearch Gateway: $GW_NAME ($GW_ID)"; FOUND_ANY=true; } \
  || { GW_ID=""; echo "  · WebSearch Gateway: $GW_NAME  $(t "—— 不存在" "— not present")"; }
if aws iam get-role --role-name "$GW_ROLE" >/dev/null 2>&1; then
  echo "  · IAM role: $GW_ROLE"; FOUND_ANY=true
else
  echo "  · IAM role: $GW_ROLE  $(t "—— 不存在" "— not present")"
fi
for ss in "$STACKSET_ONBOARD" "$STACKSET_DA"; do
  if aws cloudformation describe-stack-set --stack-set-name "$ss" --region "$REGION" >/dev/null 2>&1; then
    cnt="$(awsq cloudformation list-stack-instances --stack-set-name "$ss" --query 'length(Summaries)')"
    echo "  · StackSet: $ss  ($(t "实例 " "instances ")${cnt:-?})"; FOUND_ANY=true
  else
    echo "  · StackSet: $ss  $(t "—— 不存在" "— not present")"
  fi
done

if [ "$FOUND_ANY" = false ]; then
  ok "$(t "这个账号/区域里没有找到任何 NotiOps 资源 —— 无事可做。" "No NotiOps resources found in this account/region — nothing to do.")"
  exit 0
fi

# =============================================================================
# 2. 确认(不可逆)
# =============================================================================
if [ "$DRY_RUN" = true ]; then
  echo ""
  ok "$(t "DRY-RUN 结束:上面是盘点结果。去掉 --dry-run 才会真的删。" "DRY-RUN done: the above is the inventory. Drop --dry-run to actually delete.")"
  echo "$(t "  提示:先看一眼备份目录的默认位置,以及 --delete-everything 会多删什么(见 --help)。" \
           "  Tip: check the default backup location, and what --delete-everything additionally deletes (see --help).")"
  exit 0
fi

step "$(t "确认" "Confirm")"
warn "$(t "即将删除账号 ${ACCOUNT} / ${REGION} 里的 NotiOps 环境。这是不可逆的。" \
         "About to delete the NotiOps environment in account ${ACCOUNT} / ${REGION}. This is irreversible.")"
if [ "$DELETE_EVERYTHING" = true ]; then
  warn "$(t "--delete-everything:三张 RETAIN 表、CUR 报告与 CUR 桶、Athena 保存查询、残留日志组也会删。" \
           "--delete-everything: the three RETAIN'd tables, the CUR report and CUR bucket, Athena saved queries and leftover log groups will also be deleted.")"
fi
if [ "$ASSUME_YES" = false ]; then
  printf "%s" "$(t "请输入 12 位账号号码确认: " "Type the 12-digit account id to confirm: ")"
  read -r ans
  [ "$ans" = "$ACCOUNT" ] || die "$(t "输入不匹配,已取消(未删任何东西)。" "Input did not match — cancelled (nothing deleted).")"
  if [ "$DELETE_EVERYTHING" = true ]; then
    printf "%s" "$(t "再输入 DELETE EVERYTHING 确认删数据: " "Type DELETE EVERYTHING to confirm data deletion: ")"
    read -r ans2
    [ "$ans2" = "DELETE EVERYTHING" ] || die "$(t "输入不匹配,已取消(未删任何东西)。" "Input did not match — cancelled (nothing deleted).")"
  fi
else
  warn "$(t "--yes:跳过交互确认。" "--yes: skipping interactive confirmation.")"
fi

# =============================================================================
# 3. 备份(数据桶两档都会随栈消失,所以默认先备)
# =============================================================================
if [ "$DO_BACKUP" = true ]; then
  step "$(t "备份" "Backup")"
  if [ -z "$BACKUP_DIR" ]; then
    BACKUP_DIR="./notiops-teardown-backup-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  mkdir -p "$BACKUP_DIR"
  info "$(t "备份目录: " "Backup directory: ")$BACKUP_DIR"
  if bucket_exists "$BUCKET_DATA"; then
    info "$(t "同步数据桶(Skills / 长报告)…" "Syncing the data bucket (skills / reports)…")"
    aws s3 sync "s3://$BUCKET_DATA" "$BACKUP_DIR/data-bucket/" --region "$REGION" >/dev/null \
      && ok "$(t "数据桶已备份" "Data bucket backed up")" \
      || warn "$(t "数据桶同步失败(继续;删除会丢这些对象)" "Data bucket sync failed (continuing; those objects will be lost)")"
  fi
  # 表在保数据模式下不会被删,不必备;全删模式下必须先导出。
  if [ "$DELETE_EVERYTHING" = true ]; then
    for tb in "${TABLES_RETAINED[@]}"; do
      table_exists "$tb" || continue
      info "$(t "导出表 " "Exporting table ")$tb …"
      aws dynamodb scan --table-name "$tb" --region "$REGION" --output json \
        > "$BACKUP_DIR/${tb}.json" 2>/dev/null \
        && ok "$(t "已导出 " "Exported ")$BACKUP_DIR/${tb}.json" \
        || warn "$(t "导出失败(表可能很大,可自行用 DynamoDB 导出到 S3): " "Export failed (table may be large; use DynamoDB export-to-S3): ")$tb"
    done
  fi
else
  warn "$(t "--no-backup:不备份。数据桶(Skills / 长报告)会随主栈一起消失。" \
           "--no-backup: no backup. The data bucket (skills / reports) will be destroyed with the main stack.")"
fi

# =============================================================================
# 4. 删除(按依赖倒序)
# =============================================================================
delete_stack_wait() {  # $1=栈名
  local name="$1" st
  st="$(stack_status "$name")"
  if [ -z "$st" ] || [ "$st" = "None" ]; then
    echo "  · $name $(t "已不存在,跳过" "already gone, skipping")"; return 0
  fi
  info "$(t "删栈 " "Deleting stack ")$name ($st)…"
  run aws cloudformation delete-stack --stack-name "$name" --region "$REGION"
  if aws cloudformation wait stack-delete-complete --stack-name "$name" --region "$REGION" 2>/dev/null; then
    ok "$(t "已删除 " "Deleted ")$name"
  else
    warn "$(t "栈删除未成功: " "Stack deletion did not complete: ")$name ($(stack_status "$name"))"
    echo "$(t "  最近的失败事件:" "  Recent failure events:")"
    awsq cloudformation describe-stack-events --stack-name "$name" \
      --query 'StackEvents[?ResourceStatus==`DELETE_FAILED`].[LogicalResourceId,ResourceStatusReason]' \
      | head -5 | sed 's/^/    /'
    warn "$(t "处理完上面的原因后重跑本脚本(幂等)。" "Fix the cause above, then re-run this script (it is idempotent).")"
  fi
}

empty_bucket() {  # $1=桶名;只清空,不删桶(桶本体交给 CFN,避免 autoDelete 自定义资源报错)
  local b="$1"
  bucket_exists "$b" || { echo "  · $b $(t "不存在,跳过" "not present, skipping")"; return 0; }
  may_touch "$b" || return 0
  info "$(t "清空桶 " "Emptying bucket ")$b …"
  run aws s3 rm "s3://$b" --recursive --region "$REGION" >/dev/null || true
  # 开了版本控制的桶(本项目没开;防御性处理)残留 delete marker 会让 CFN 删桶失败。
  local ver; ver="$(awsq s3api get-bucket-versioning --bucket "$b" --query Status)"
  if [ "$ver" = "Enabled" ] || [ "$ver" = "Suspended" ]; then
    if command -v python3 >/dev/null 2>&1 && [ "$DRY_RUN" = false ]; then
      info "$(t "桶开了版本控制,清历史版本…" "Bucket is versioned; purging versions…")"
      python3 - "$b" "$REGION" <<'PY' || warn "$(t "清历史版本失败,可能需手工清" "Purging versions failed; may need manual cleanup")"
import sys, boto3
b, region = sys.argv[1], sys.argv[2]
s3 = boto3.client("s3", region_name=region)
p = s3.get_paginator("list_object_versions")
for page in p.paginate(Bucket=b):
    objs = [{"Key": o["Key"], "VersionId": o["VersionId"]}
            for k in ("Versions", "DeleteMarkers") for o in page.get(k, [])]
    for i in range(0, len(objs), 1000):
        s3.delete_objects(Bucket=b, Delete={"Objects": objs[i:i + 1000], "Quiet": True})
PY
    else
      warn "$(t "桶开了版本控制但没有 python3,历史版本需手工清: " "Bucket is versioned but python3 is unavailable; purge versions manually: ")$b"
    fi
  fi
}

step "$(t "1/8 AgentCore Runtime(agent 本体)" "1/8 AgentCore Runtime (the agent itself)")"
AGENT_DIR="$(cd "$(dirname "$0")" && pwd)/agent-build/NotiOpsWebChat"
if command -v agentcore >/dev/null 2>&1 && [ -d "$AGENT_DIR" ]; then
  info "$(t "用 agentcore CLI 删(它维护同名 CDK 栈)…" "Using the agentcore CLI (it owns the same-named CDK stack)…")"
  if [ "$DRY_RUN" = true ]; then
    echo "    ${YEL}would run:${RST} (cd $AGENT_DIR && AWS_REGION=$REGION agentcore destroy -y)"
  elif ( cd "$AGENT_DIR" && AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" agentcore destroy -y ); then
    ok "$(t "agentcore destroy 完成" "agentcore destroy finished")"
  else
    warn "$(t "agentcore destroy 失败,回退删栈" "agentcore destroy failed; falling back to stack deletion")"
    delete_stack_wait "$STACK_AGENT"
  fi
else
  info "$(t "没有 agentcore CLI(或没有 agent-build 目录),直接删栈" "No agentcore CLI (or no agent-build dir) — deleting the stack directly")"
  delete_stack_wait "$STACK_AGENT"
fi
# CLI 走完也确认栈真没了(agentcore 版本差异:destroy / delete 行为不完全一致)。
delete_stack_wait "$STACK_AGENT"

step "$(t "2/8 IM Bot 栈 / Web Chat 栈" "2/8 IM bot stack / Web Chat stack")"
empty_bucket "$BUCKET_CHAT_FRONTEND"
delete_stack_wait "$STACK_BOT"
delete_stack_wait "$STACK_WEBCHAT"

step "$(t "3/8 清空主栈的桶(非空会让删栈失败)" "3/8 Empty the main stack's buckets (non-empty buckets fail stack deletion)")"
empty_bucket "$BUCKET_FRONTEND"
empty_bucket "$BUCKET_DATA"

step "$(t "4/8 主栈" "4/8 Main stack")"
delete_stack_wait "$STACK_MAIN"

step "$(t "5/8 CUR → Athena 集成栈" "5/8 CUR → Athena integration stack")"
# 这个栈是 lambda6_cur_finalizer 用官方 crawler-cfn.yml 建的,里面含 Glue 数据库
# athenacurcfn_*(随栈删)。Glue 数据库 cid_cur 属于别的项目,本脚本绝不碰。
delete_stack_wait "$STACK_CUR_ATHENA"

step "$(t "6/8 非 CDK 收尾(Scheduler / Gateway / Secrets)" "6/8 Non-CDK cleanup (scheduler / gateway / secrets)")"
if [ -n "$(awsq scheduler get-schedule --name "$SCHEDULE_CUR" --query Name)" ]; then
  info "$(t "删一次性 Scheduler " "Deleting one-shot schedule ")$SCHEDULE_CUR"
  run aws scheduler delete-schedule --name "$SCHEDULE_CUR" --region "$REGION" >/dev/null || true
fi
if [ -n "$GW_ID" ]; then
  info "$(t "删 WebSearch Gateway target + gateway " "Deleting WebSearch gateway target + gateway ")$GW_ID"
  for tgt in $(awsq bedrock-agentcore-control list-gateway-targets --gateway-identifier "$GW_ID" \
                 --query 'items[].targetId'); do
    [ -n "$tgt" ] && [ "$tgt" != "None" ] || continue
    run aws bedrock-agentcore-control delete-gateway-target --gateway-identifier "$GW_ID" \
      --target-id "$tgt" --region "$REGION" >/dev/null || true
  done
  # 删 target 是**异步**的：DELETE 返回成功只表示"开始删了"。不等它真的消失就删
  # Gateway，服务端会以「还挂着 target」拒掉，而上面那个 `|| true` 把失败吞掉 ——
  # 结果是脚本报告"删完了"，Gateway 却还 READY 留在账号里。
  for _ in $(seq 1 40); do   # 40 × 3s
    remaining="$(awsq bedrock-agentcore-control list-gateway-targets \
      --gateway-identifier "$GW_ID" --query 'length(items)')"
    if [ -z "$remaining" ] || [ "$remaining" = "0" ] || [ "$remaining" = "None" ]; then break; fi
    sleep 3
  done
  run aws bedrock-agentcore-control delete-gateway --gateway-identifier "$GW_ID" --region "$REGION" >/dev/null || true
fi
if aws iam get-role --role-name "$GW_ROLE" >/dev/null 2>&1; then
  info "$(t "删 Gateway 服务角色 " "Deleting gateway service role ")$GW_ROLE"
  run aws iam delete-role-policy --role-name "$GW_ROLE" --policy-name "$GW_ROLE_POLICY" >/dev/null 2>&1 || true
  run aws iam delete-role --role-name "$GW_ROLE" >/dev/null 2>&1 || \
    warn "$(t "角色删除失败(可能还挂着别的策略),需手工清: " "Role deletion failed (other policies may be attached); clean up manually: ")$GW_ROLE"
fi
# Secrets 是 DESTROY,但 CFN 删除会留 7-30 天恢复期 —— 同名重建会冲突,这里立即彻底删。
for sec in "${SECRETS[@]}"; do
  if aws secretsmanager describe-secret --secret-id "$sec" --region "$REGION" >/dev/null 2>&1; then
    info "$(t "彻底删 Secret(不留恢复期)" "Force-deleting secret (no recovery window)")$(t ": " ": ")$sec"
    run aws secretsmanager delete-secret --secret-id "$sec" --force-delete-without-recovery \
      --region "$REGION" >/dev/null 2>&1 || true
  fi
done

step "$(t "7/8 数据(仅 --delete-everything)" "7/8 Data (only with --delete-everything)")"
if [ "$DELETE_EVERYTHING" = true ]; then
  for tb in "${TABLES_RETAINED[@]}"; do
    if table_exists "$tb" && may_touch "$tb"; then
      info "$(t "删表 " "Deleting table ")$tb"
      run aws dynamodb delete-table --table-name "$tb" --region "$REGION" >/dev/null || \
        warn "$(t "删表失败: " "Table deletion failed: ")$tb"
    fi
  done
  if [ -n "$CUR_FOUND" ] && [ "$CUR_FOUND" != "None" ]; then
    info "$(t "删 CUR 报告定义 " "Deleting CUR report definition ")$CUR_REPORT"
    # cur API 端点固定在 us-east-1(CUR 是全局服务),这里不能用部署区。
    run aws cur delete-report-definition --report-name "$CUR_REPORT" --region us-east-1 >/dev/null 2>&1 || \
      warn "$(t "删 CUR 报告失败(可手工在 Billing 控制台删)" "Deleting the CUR report failed (delete it in the Billing console)")"
  fi
  if bucket_exists "$BUCKET_CUR"; then
    info "$(t "删 CUR 桶 " "Deleting CUR bucket ")$BUCKET_CUR"
    empty_bucket "$BUCKET_CUR"
    run aws s3 rb "s3://$BUCKET_CUR" --region "$REGION" >/dev/null 2>&1 || \
      warn "$(t "CUR 桶删除失败,需手工清: " "CUR bucket deletion failed; clean up manually: ")$BUCKET_CUR"
  fi
  # Athena 保存查询(lambda6 下发的 6 条,名字都以 "NotiOps - " 开头)。
  for qid in $(awsq athena list-named-queries --query 'NamedQueryIds[]'); do
    [ -n "$qid" ] && [ "$qid" != "None" ] || continue
    qname="$(awsq athena get-named-query --named-query-id "$qid" --query 'NamedQuery.Name')"
    case "$qname" in
      "NotiOps - "*)
        info "$(t "删 Athena 保存查询: " "Deleting Athena saved query: ")$qname"
        run aws athena delete-named-query --named-query-id "$qid" --region "$REGION" >/dev/null 2>&1 || true ;;
    esac
  done
  # 残留日志组(WebChatStack 的 Lambda 自建、ECS、AgentCore、RUM)。
  for pfx in "${LOG_PREFIXES[@]}"; do
    for lg in $(awsq logs describe-log-groups --log-group-name-prefix "$pfx" --query 'logGroups[].logGroupName'); do
      [ -n "$lg" ] && [ "$lg" != "None" ] || continue
      info "$(t "删日志组 " "Deleting log group ")$lg"
      run aws logs delete-log-group --log-group-name "$lg" --region "$REGION" >/dev/null 2>&1 || true
    done
  done
else
  echo "$(t "保数据模式:以下保留(需要时用 --delete-everything 或手工删)" \
           "Keep-data mode: the following are preserved (use --delete-everything, or delete manually)")"
  for tb in "${TABLES_RETAINED[@]}"; do table_exists "$tb" && echo "  · DynamoDB $tb"; done
  [ -n "$CUR_FOUND" ] && [ "$CUR_FOUND" != "None" ] && echo "  · CUR report $CUR_REPORT"
  bucket_exists "$BUCKET_CUR" && echo "  · S3 $BUCKET_CUR"
  echo "  · $(t "Athena 保存查询「NotiOps - *」、残留日志组(见下面的收尾清单)" \
                "Athena saved queries \"NotiOps - *\", leftover log groups (see the follow-up list below)")"
fi

step "$(t "8/8 多账号:成员账号 StackSet" "8/8 Multi-account: member-account StackSets")"
# 跨账号删除影响别人的账号,默认只打印命令。--delete-member-stacksets 才真删。
SS_PRESENT=()
for ss in "$STACKSET_ONBOARD" "$STACKSET_DA"; do
  aws cloudformation describe-stack-set --stack-set-name "$ss" --region "$REGION" >/dev/null 2>&1 && SS_PRESENT+=("$ss")
done
if [ "${#SS_PRESENT[@]}" -eq 0 ]; then
  echo "$(t "没有 StackSet(单账号部署),跳过。" "No StackSets (single-account deployment) — skipping.")"
elif [ "$DELETE_STACKSETS" = false ]; then
  warn "$(t "发现 StackSet,但默认不删(它在成员账号里建资源,删除会影响别人的账号)。" \
           "StackSets found but not deleted by default (they create resources in member accounts).")"
  echo "$(t "  要删就重跑并加 --delete-member-stacksets,或手工:" "  Re-run with --delete-member-stacksets, or do it manually:")"
  for ss in "${SS_PRESENT[@]}"; do
    cat <<EOF
    aws cloudformation list-stack-instances --stack-set-name $ss --region $REGION
    aws cloudformation delete-stack-instances --stack-set-name $ss --region $REGION \\
      --deployment-targets OrganizationalUnitIds=<ou-id> --regions $REGION --no-retain-stacks
    aws cloudformation delete-stack-set --stack-set-name $ss --region $REGION
EOF
  done
else
  for ss in "${SS_PRESENT[@]}"; do
    OUS="$(awsq cloudformation list-stack-instances --stack-set-name "$ss" \
             --query 'Summaries[].OrganizationalUnitId' | tr '\t' '\n' | sort -u | grep -v '^None$' | tr '\n' ' ')"
    if [ -n "${OUS// /}" ]; then
      info "$(t "删 $ss 的实例(OU: ${OUS})…" "Deleting $ss instances (OUs: ${OUS})…")"
      # shellcheck disable=SC2086
      OP="$(awsq cloudformation delete-stack-instances --stack-set-name "$ss" \
              --deployment-targets OrganizationalUnitIds=$(echo "$OUS" | tr ' ' ',' | sed 's/,$//') \
              --regions "$REGION" --no-retain-stacks --query OperationId)"
      if [ -n "$OP" ] && [ "$OP" != "None" ]; then
        info "$(t "等待 StackSet 操作 " "Waiting for StackSet operation ")$OP …"
        for _ in $(seq 1 120); do
          ST="$(awsq cloudformation describe-stack-set-operation --stack-set-name "$ss" \
                  --operation-id "$OP" --query 'StackSetOperation.Status')"
          case "$ST" in
            SUCCEEDED) ok "$(t "实例已删除" "Instances deleted")"; break ;;
            FAILED|STOPPED) warn "$(t "StackSet 操作未成功(状态 $ST),StackSet 保留待人工处理" "StackSet operation did not succeed (status $ST); the StackSet is left for manual handling")"; break ;;
            *) sleep 10 ;;
          esac
        done
      fi
    fi
    info "$(t "删 StackSet " "Deleting StackSet ")$ss"
    run aws cloudformation delete-stack-set --stack-set-name "$ss" --region "$REGION" >/dev/null 2>&1 || \
      warn "$(t "StackSet 删除失败(可能还有实例),需手工处理: " "StackSet deletion failed (instances may remain); handle manually: ")$ss"
  done
fi

# =============================================================================
# 5. 删完清点 + 手工收尾清单
# =============================================================================
step "$(t "删完清点" "Post-deletion inventory")"
LEFT=false
for s in "$STACK_AGENT" "$STACK_BOT" "$STACK_WEBCHAT" "$STACK_MAIN" "$STACK_CUR_ATHENA"; do
  st="$(stack_status "$s")"
  if [ -n "$st" ] && [ "$st" != "None" ]; then echo "  · $(t "仍在: " "still there: ")$s ($st)"; LEFT=true; fi
done
for b in "$BUCKET_FRONTEND" "$BUCKET_CHAT_FRONTEND" "$BUCKET_DATA" "$BUCKET_CUR"; do
  bucket_exists "$b" && { echo "  · $(t "仍在: " "still there: ")S3 $b"; LEFT=true; }
done
for tb in "${TABLES_RETAINED[@]}"; do
  table_exists "$tb" && { echo "  · $(t "仍在: " "still there: ")DynamoDB $tb"; LEFT=true; }
done
[ "$LEFT" = false ] && ok "$(t "清点:本脚本负责的资源都没了。" "Inventory: everything this script owns is gone.")"

step "$(t "本脚本【故意】不做的事(需要就自己来)" "What this script deliberately does NOT do (do it yourself if needed)")"
cat <<EOF
$(t "· 成员账号里的 PHD 事件转发栈:在【每个 linked 账号】跑" \
     "· PHD event-forwarder stacks in member accounts: run in EACH linked account")
    ./setup.sh --phd --remove
$(t "· Security Hub 委派管理员 / Finding Aggregator(setup.sh --multi-account 可选步骤):" \
     "· Security Hub delegated admin / finding aggregator (optional step of setup.sh --multi-account):")
    aws securityhub list-finding-aggregators --region $REGION
    aws securityhub disable-organization-admin-account --admin-account-id $ACCOUNT --region $REGION
$(t "· CDK bootstrap(CDKToolkit 栈、cdk-hnb659fds-assets-* 桶、cdk-hnb659fds-container-assets-* ECR、" \
     "· CDK bootstrap (CDKToolkit stack, cdk-hnb659fds-assets-* bucket, cdk-hnb659fds-container-assets-* ECR,")
  $(t "  SSM /cdk-bootstrap/hnb659fds/version):所有 CDK 项目共用,删了会让本账号其它 CDK 部署失败。" \
       "  SSM /cdk-bootstrap/hnb659fds/version): shared by every CDK project — deleting it breaks other deployments.")
$(t "· Glue 数据库 cid_cur(属 Cloud Intelligence Dashboards)、以及任何不是 NotiOps 建的东西。" \
     "· Glue database cid_cur (belongs to Cloud Intelligence Dashboards) and anything NotiOps did not create.")
$(t "· Bedrock 模型访问权限、Organizations 的服务访问设置 —— 别的项目可能也在用。" \
     "· Bedrock model access and AWS Organizations service-access settings — other projects may rely on them.")
EOF

echo ""
if [ "$DO_BACKUP" = true ] && [ -n "${BACKUP_DIR:-}" ] && [ -d "$BACKUP_DIR" ]; then
  info "$(t "备份在: " "Backup at: ")$BACKUP_DIR"
fi
ok "$(t "teardown 完成。要重装:重跑 ./setup.sh(重装后邀请邮件会重发、IM 凭据要重新填)。" \
       "Teardown complete. To reinstall: re-run ./setup.sh (the invite email is re-sent and IM credentials must be re-entered).")"
