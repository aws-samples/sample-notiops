#!/bin/bash
set -e

# ─── PHD 模式拦截(在依赖检查之前)───
# --phd 模式只需要 python3 + aws CLI, 不需要 node/npm/cdk/docker/jq
PHD_MODE=false
PHD_REMOVE=false
MULTI_ACCOUNT_MODE=false
UI_LANG=""
for arg in "$@"; do
  case "$arg" in
    --phd) PHD_MODE=true ;;
    --remove) PHD_REMOVE=true ;;
    --multi-account) MULTI_ACCOUNT_MODE=true ;;
    --lang=*) UI_LANG="${arg#--lang=}" ;;
    --lang) UI_LANG="next" ;;   # 兼容 "--lang en"（下一个 arg 是值）
    en|zh) [ "$UI_LANG" = "next" ] && UI_LANG="$arg" ;;
  esac
done

# ─── UI 语言检测(双语交互)───
# 优先级: --lang en/zh 显式指定 > $LANG/$LC_ALL 含 "zh" 则中文 > 默认英文。
# 面向全球客户: 非中文环境一律走英文, 避免看不懂提示。
if [ "$UI_LANG" != "en" ] && [ "$UI_LANG" != "zh" ]; then
  case "${LC_ALL:-${LANG:-}}" in
    zh_*|zh|*zh_CN*|*zh_TW*|*zh_HK*) UI_LANG="zh" ;;
    *) UI_LANG="en" ;;
  esac
fi
# t "<中文>" "<English>" —— 按 UI_LANG 输出对应语言(echo 时用 "$(t ... ...)")。
t() { if [ "$UI_LANG" = "zh" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }
# 导出 UI_LANG,让被本脚本调用的子脚本(deploy_agent.sh / provision_websearch_gateway.sh /
# check-iam-consistency.py)继承同一语言,输出一致的中/英文(子脚本各自 default en 兜底)。
export UI_LANG

if [ "$PHD_MODE" = true ]; then
  # PHD 模式依赖检查(仅需 python3 + aws)
  command -v python3 >/dev/null 2>&1 || { echo "$(t "错误: 需要安装 Python 3" "Error: Python 3 is required")"; exit 1; }
  command -v aws >/dev/null 2>&1 || { echo "$(t "错误: 需要安装 AWS CLI" "Error: AWS CLI is required")"; exit 1; }

  PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
  PHD_STACK_NAME="phd-event-forwarder"
  PHD_TEMPLATE="$PROJECT_ROOT/infra/phd-event-forwarder.yaml"

  if [ "$PHD_REMOVE" = true ]; then
    # ─── --phd --remove: 删除 PHD Stack ───
    echo "============================================"
    echo "  $(t "PHD 事件转发 — 清理 Linked Account Stack" "PHD Event Forwarding — Remove Linked Account Stack")"
    echo "============================================"
    echo ""

    # 获取 SNS Topic ARN 以提取 Region
    PHD_SNS_TOPIC_ARN="${PHD_SNS_TOPIC_ARN:-}"
    if [ -z "$PHD_SNS_TOPIC_ARN" ]; then
      read -p "$(t "请输入 System Account 的 PHD SNS Topic ARN: " "Enter the System Account's PHD SNS Topic ARN: ")" PHD_SNS_TOPIC_ARN
    fi

    if [ -z "$PHD_SNS_TOPIC_ARN" ]; then
      echo "$(t "错误: PHD_SNS_TOPIC_ARN 不能为空" "Error: PHD_SNS_TOPIC_ARN cannot be empty")"
      exit 1
    fi

    # 从 ARN 第 4 段提取 Region
    PHD_REGION=$(echo "$PHD_SNS_TOPIC_ARN" | cut -d':' -f4)
    if [ -z "$PHD_REGION" ]; then
      echo "$(t "错误: 无法从 ARN 提取 Region: " "Error: cannot extract Region from ARN: ")$PHD_SNS_TOPIC_ARN"
      exit 1
    fi

    echo "$(t "Stack 名称:  " "Stack name:   ")$PHD_STACK_NAME"
    echo "$(t "部署 Region: " "Deploy Region: ")$PHD_REGION"
    echo ""

    aws cloudformation delete-stack \
      --stack-name "$PHD_STACK_NAME" \
      --region "$PHD_REGION"

    echo "$(t "等待 Stack 删除完成..." "Waiting for stack deletion to complete...")"
    aws cloudformation wait stack-delete-complete \
      --stack-name "$PHD_STACK_NAME" \
      --region "$PHD_REGION" 2>/dev/null || true

    echo ""
    echo "$(t "✓ PHD Stack 已删除" "✓ PHD stack deleted")"
    exit 0
  fi

  # ─── --phd: 部署 Linked Account PHD Stack ───
  echo "============================================"
  echo "  $(t "PHD 事件转发 — Linked Account 部署" "PHD Event Forwarding — Linked Account Deployment")"
  echo "============================================"
  echo ""

  # 获取 SNS Topic ARN
  PHD_SNS_TOPIC_ARN="${PHD_SNS_TOPIC_ARN:-}"
  if [ -z "$PHD_SNS_TOPIC_ARN" ]; then
    read -p "$(t "请输入 System Account 的 PHD SNS Topic ARN: " "Enter the System Account's PHD SNS Topic ARN: ")" PHD_SNS_TOPIC_ARN
  fi

  if [ -z "$PHD_SNS_TOPIC_ARN" ]; then
    echo "$(t "错误: PHD_SNS_TOPIC_ARN 不能为空" "Error: PHD_SNS_TOPIC_ARN cannot be empty")"
    exit 1
  fi

  # 从 ARN 第 4 段提取 SNS Topic 所在 Region
  SNS_REGION=$(echo "$PHD_SNS_TOPIC_ARN" | cut -d':' -f4)
  if [ -z "$SNS_REGION" ]; then
    echo "$(t "错误: 无法从 ARN 提取 Region: " "Error: cannot extract Region from ARN: ")$PHD_SNS_TOPIC_ARN"
    exit 1
  fi

  # PHD Stack 必须部署在 SNS Topic 所在 Region(EventBridge 跨账号 SNS Target 只支持同 Region)
  PHD_REGION="$SNS_REGION"

  echo "$(t "SNS Topic ARN: " "SNS Topic ARN: ")$PHD_SNS_TOPIC_ARN"
  echo "$(t "部署 Region:   " "Deploy Region: ")$PHD_REGION"
  echo ""

  if [ ! -f "$PHD_TEMPLATE" ]; then
    echo "$(t "错误: CloudFormation 模板不存在: " "Error: CloudFormation template not found: ")$PHD_TEMPLATE"
    exit 1
  fi

  echo "$(t "部署 CloudFormation Stack..." "Deploying CloudFormation stack...")"
  aws cloudformation deploy \
    --template-file "$PHD_TEMPLATE" \
    --stack-name "$PHD_STACK_NAME" \
    --parameter-overrides "PhdSnsTopicArn=$PHD_SNS_TOPIC_ARN" \
    --capabilities CAPABILITY_NAMED_IAM \
    --region "$PHD_REGION"

  echo ""
  echo "============================================"
  echo "  $(t "PHD 事件转发部署完成！" "PHD Event Forwarding deployed!")"
  echo "============================================"
  echo ""
  echo "$(t "Stack 名称:    " "Stack name:    ")$PHD_STACK_NAME"
  echo "$(t "部署 Region:   " "Deploy Region: ")$PHD_REGION"
  echo "SNS Topic ARN: $PHD_SNS_TOPIC_ARN"
  echo ""
  echo "$(t "本账号的 PHD 事件将自动转发到系统账号处理. " "This account's PHD events will be automatically forwarded to the system account.")"
  echo "$(t "如需卸载, 运行: ./setup.sh --phd --remove" "To uninstall, run: ./setup.sh --phd --remove")"
  exit 0
fi

echo "============================================"
echo "  $(t "NotiOps — 一键部署脚本" "NotiOps — One-Click Deployment")"
echo "============================================"
echo ""

# 检查依赖
command -v node >/dev/null 2>&1 || { echo "$(t "错误: 需要安装 Node.js (22+)" "Error: Node.js (22+) is required")"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "$(t "错误: 需要安装 npm" "Error: npm is required")"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "$(t "错误: 需要安装 Python 3" "Error: Python 3 is required")"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "$(t "错误: 需要安装 AWS CLI" "Error: AWS CLI is required")"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "$(t "错误: 需要安装 jq" "Error: jq is required")"; exit 1; }

# 容器构建工具仅在部署 IM Bot 时必需(BotStack 的 ECS 容器用 CDK fromAsset 本地构建镜像)。
# 若客户只部署 web 端、暂不部署 IM,则不需要容器工具。这里只探测,不强制退出;
# 真正的强制检查移到 IM 平台选择之后(选了 IM 才要求容器工具)。
# 支持 docker 或 finch(CDK 通过 CDK_DOCKER 环境变量支持替代容器工具,
# 参考 https://docs.aws.amazon.com/cdk/v2/guide/build-containers.html)。
HAS_DOCKER=false
CONTAINER_TOOL=""
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  HAS_DOCKER=true
  CONTAINER_TOOL="docker"
elif command -v finch >/dev/null 2>&1 && finch vm status >/dev/null 2>&1; then
  HAS_DOCKER=true
  CONTAINER_TOOL="finch"
  export CDK_DOCKER=finch
fi

# 检查 CDK CLI
if ! command -v cdk >/dev/null 2>&1; then
  echo "$(t "未检测到 CDK CLI, 正在安装..." "CDK CLI not found, installing...")"
  npm install -g aws-cdk
fi

# ─── 选择 AWS Profile ───
echo "$(t "请选择部署目标 AWS Profile: " "Select the target AWS Profile for deployment:")"
echo ""

# 读取本地所有 profile 名称
PROFILES=()
if [ -f ~/.aws/credentials ]; then
  while IFS= read -r line; do
    PROFILES+=("$line")
  done < <(grep '^\[' ~/.aws/credentials | sed 's/\[//;s/\]//' | sort)
fi
if [ -f ~/.aws/config ]; then
  while IFS= read -r line; do
    PROFILES+=("$line")
  done < <(grep '^\[profile ' ~/.aws/config | sed 's/\[profile //;s/\]//' | sort)
fi

# 去重
PROFILES=($(printf '%s\n' "${PROFILES[@]}" | sort -u))

if [ ${#PROFILES[@]} -eq 0 ]; then
  echo "$(t "  未检测到 AWS Profile, 使用当前环境凭证" "  No AWS Profile found, using current environment credentials")"
else
  CURRENT_PROFILE="${AWS_PROFILE:-default}"
  echo "$(t "  当前 AWS_PROFILE: " "  Current AWS_PROFILE: ")$CURRENT_PROFILE"
  echo ""
  echo "$(t "  可用 Profile 列表: " "  Available Profiles:")"
  IDX=1
  for p in "${PROFILES[@]}"; do
    if [ "$p" = "$CURRENT_PROFILE" ]; then
      echo "  $IDX) $p  $(t "← 当前" "← current")"
    else
      echo "  $IDX) $p"
    fi
    IDX=$((IDX + 1))
  done
  echo ""
  echo "  0) $(t "保持当前" "Keep current") ($CURRENT_PROFILE)"
  echo ""
  read -p "$(t "请输入选项" "Enter choice") [0-$((${#PROFILES[@]}))]($(t "默认" "default") 0): " PROFILE_CHOICE

  if [ -n "$PROFILE_CHOICE" ] && [ "$PROFILE_CHOICE" != "0" ]; then
    SELECTED_IDX=$((PROFILE_CHOICE - 1))
    if [ $SELECTED_IDX -ge 0 ] && [ $SELECTED_IDX -lt ${#PROFILES[@]} ]; then
      export AWS_PROFILE="${PROFILES[$SELECTED_IDX]}"
      echo ""
      echo "  $(t "✓ 已切换到 Profile: " "✓ Switched to Profile: ")$AWS_PROFILE"
    else
      echo "  $(t "无效选项, 保持当前 Profile: " "Invalid choice, keeping current Profile: ")$CURRENT_PROFILE"
    fi
  else
    echo "  $(t "保持当前 Profile: " "Keeping current Profile: ")$CURRENT_PROFILE"
  fi

  # 验证凭证有效性
  echo ""
  echo "$(t "  验证 AWS 凭证..." "  Validating AWS credentials...")"
  # 注意: set -e 下 `VAR=$(cmd)` 若 cmd 失败会立即退出脚本, 导致下面的错误提示来不及打印(静默退出)。
  # 放进 if 条件里可让 set -e 不触发, 从而正常打印错误。
  if ! CALLER_IDENTITY=$(aws sts get-caller-identity 2>&1); then
    echo "  $(t "❌ AWS 凭证无效或已过期: " "❌ AWS credentials invalid or expired: ")$CALLER_IDENTITY"
    echo "$(t "  请检查 Profile 配置, 或执行 SSO 登录后重试: aws sso login --profile <profile>" "  Check your Profile config, or run SSO login and retry: aws sso login --profile <profile>")"
    exit 1
  fi

  DEPLOY_ACCOUNT=$(echo "$CALLER_IDENTITY" | jq -r '.Account')
  DEPLOY_USER=$(echo "$CALLER_IDENTITY" | jq -r '.Arn')
  echo "  $(t "✓ 目标账号: " "✓ Target account: ")$DEPLOY_ACCOUNT"
  echo "$(t "    身份:     " "    Identity:   ")$DEPLOY_USER"
  echo ""
  read -p "$(t "确认部署到该账号？[Y/n]: " "Confirm deployment to this account? [Y/n]: ")" ACCOUNT_CONFIRM
  case "${ACCOUNT_CONFIRM:-Y}" in
    [nN]*) echo "$(t "  已取消部署" "  Deployment cancelled")"; exit 0 ;;
  esac
fi

echo ""

# 选择部署 Region
echo "$(t "请选择部署 Region: " "Select the deployment Region:")"
echo ""
echo "  1) ap-northeast-1  $(t "(東京)" "(Tokyo)")"
echo "  2) us-east-1       $(t "(弗吉尼亚)" "(N. Virginia)")"
echo "  3) us-west-2       $(t "(俄勒冈)" "(Oregon)")"
echo "  4) eu-west-1       $(t "(爱尔兰)" "(Ireland)")"
echo "  5) ap-southeast-1  $(t "(新加坡)" "(Singapore)")"
echo "  6) $(t "自定义输入" "Custom input")"
echo ""
read -p "$(t "请输入选项" "Enter choice") [1-6]($(t "默认" "default") 1): " REGION_CHOICE

case "${REGION_CHOICE:-1}" in
  1) DEPLOY_REGION="ap-northeast-1" ;;
  2) DEPLOY_REGION="us-east-1" ;;
  3) DEPLOY_REGION="us-west-2" ;;
  4) DEPLOY_REGION="eu-west-1" ;;
  5) DEPLOY_REGION="ap-southeast-1" ;;
  6) read -p "$(t "请输入 Region(如 eu-central-1): " "Enter Region (e.g. eu-central-1): ")" DEPLOY_REGION ;;
  *) DEPLOY_REGION="ap-northeast-1" ;;
esac

echo ""
echo "$(t "部署 Region: " "Deploy Region: ")$DEPLOY_REGION"
export DEPLOY_REGION="$DEPLOY_REGION"

# Force AWS_REGION / AWS_DEFAULT_REGION to the chosen DEPLOY_REGION for
# this script run. If the user's shell has a stale region (e.g.
# AWS_REGION=us-west-2) but they pick us-east-1 here, both the AWS CLI
# and the CDK CLI would otherwise look up the WRONG region's CDK
# bootstrap and fail with a confusing "SSM parameter ... not found"
# error. Overriding here keeps the entire deploy aligned.
export AWS_REGION="$DEPLOY_REGION"
export AWS_DEFAULT_REGION="$DEPLOY_REGION"

# ─── PHD 事件转发开关(根据当前 Stack 状态智能提示)───
ENABLE_PHD="${ENABLE_PHD:-}"
if [ -z "$ENABLE_PHD" ]; then
  # 检测当前 Stack 是否已部署 PHD 资源
  PHD_EXISTING=$(aws cloudformation list-stack-resources \
    --stack-name NotiOpsBackendStack --region "$DEPLOY_REGION" \
    --query "StackResourceSummaries[?starts_with(LogicalResourceId,'PhdEventsTopic')].ResourceStatus | [0]" \
    --output text 2>/dev/null || echo "")

  if [ -n "$PHD_EXISTING" ] && [ "$PHD_EXISTING" != "None" ] && [ "$PHD_EXISTING" != "" ]; then
    # 已部署 PHD — 询问是否保留
    echo ""
    echo "$(t "检测到当前 Stack 已部署 AWS Health 事件转发功能. " "Detected AWS Health event forwarding already deployed in the current stack.")"
    echo ""
    read -p "$(t "是否保留 PHD 事件转发功能？[Y/n]: " "Keep PHD event forwarding? [Y/n]: ")" PHD_KEEP_CHOICE
    case "${PHD_KEEP_CHOICE:-Y}" in
      [nN]*)
        echo ""
        echo "  $(t "⚠ 移除 PHD 功能将删除 SNS Topic、Lambda、EventBridge Rule. " "⚠ Removing PHD will delete the SNS Topic, Lambda, and EventBridge Rule.")"
        echo "  $(t "如果有 Linked Account 正在转发事件, 请先执行:" "If any Linked Account is forwarding events, run this first:")"
        echo "    ./setup.sh --phd --remove"
        echo ""
        read -p "  $(t "确认移除 PHD 功能？[y/N]: " "Confirm removing PHD? [y/N]: ")" PHD_CONFIRM_REMOVE
        case "${PHD_CONFIRM_REMOVE:-N}" in
          [yY]*) ENABLE_PHD="false" ;;
          *) ENABLE_PHD="true"; echo "  $(t "保留 PHD 功能" "Keeping PHD")" ;;
        esac
        ;;
      *) ENABLE_PHD="true" ;;
    esac
  else
    # 未部署 PHD — 询问是否【额外】把 Health 事件推送到飞书 IM。
    # 说明:AWS Health 事件默认【已经】进入 Web Chat 通知收件箱(见 notiops-backend-stack.ts
    # 的 webNotif Health source, on:true, 不受此开关控制)。此开关只额外增加一条【飞书 IM 推送】——
    # PHD 转发器目前仅支持飞书(phd_event_forwarder/notifier.py 走 shared.feishu_sender)。
    # 因此:不用飞书 IM 就没必要开(Web 收件箱不受影响);故默认跳过(N)。IM 平台在稍后步骤选择。
    echo ""
    echo "$(t "是否额外把 AWS Health 事件推送到飞书 IM 群？" "Also push AWS Health events to your Feishu IM group?")"
    echo "  $(t "说明:AWS Health 事件(服务中断、计划维护等)默认【已经】进入 Web Chat 通知收件箱, " "Note: AWS Health events (outages, planned maintenance, etc.) already land in the Web Chat notification inbox")"
    echo "  $(t "无论此项是否开启。此项【仅】额外经 Bedrock 生成摘要并推送到你的飞书群。 " "regardless of this choice. This option ONLY adds an extra Bedrock-summarized push to your Feishu group.")"
    echo "  $(t "生效前提:在稍后的『IM 平台选择』步骤启用飞书,并在部署后回填飞书凭据。 " "It only takes effect if you enable Feishu in the later 'IM Platform Selection' step and fill Feishu credentials after deploy.")"
    echo "  $(t "如果你不使用飞书 IM,或已有完善的告警机制,直接跳过即可(Web 收件箱不受影响)。 " "If you don't use Feishu IM, or already have solid alerting, just skip it (the web inbox is unaffected).")"
    echo ""
    read -p "$(t "推送 Health 到飞书 IM？[y/N]: " "Push Health events to Feishu IM? [y/N]: ")" PHD_CHOICE
    case "${PHD_CHOICE:-N}" in
      [yY]*) ENABLE_PHD="true" ;;
      *) ENABLE_PHD="false" ;;
    esac
  fi
fi

# ─── Organizations 检测(--multi-account)───
# 若当前部署账号是组织管理账号(或 StackSets 委派管理员),启用 org 模式:
#   · CDK 传 -c organizationId=<o-xxxx>:解锁 LOCKED_ACCOUNT_ID 闸门 +
#     Custom Bus / PHD SNS Topic 改用 aws:PrincipalOrgID 整组放行
#   · 跳过 PHD / DevOps Agent 逐账号白名单交互(由 OrgID 条件替代)
#   · 部署完成后通过 CloudFormation StackSets(service-managed)向成员账号
#     批量下发 infra/member-account-onboarding.yaml(只读角色 + 事件转发)
# 非管理账号时退回原有逐账号白名单模式,成员账号需手动部署该模板。
ORG_MODE=false
ORG_ID=""
ORG_FLAG=""
if [ "$MULTI_ACCOUNT_MODE" = true ]; then
  echo ""
  echo "$(t "─── 多账号模式: Organizations 检测 ───" "─── Multi-Account Mode: Organizations Detection ───")"
  ORG_INFO=$(aws organizations describe-organization \
    --query 'Organization.[Id,MasterAccountId]' --output text 2>/dev/null || echo "")
  if [ -n "$ORG_INFO" ]; then
    ORG_ID=$(echo "$ORG_INFO" | awk '{print $1}')
    ORG_MGMT_ACCOUNT=$(echo "$ORG_INFO" | awk '{print $2}')
    CURRENT_ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
    if [ "$CURRENT_ACCOUNT" = "$ORG_MGMT_ACCOUNT" ]; then
      ORG_MODE=true
      echo "  $(t "✓ 当前账号是组织管理账号(Org: " "✓ Current account is the Organization management account (Org: ")$ORG_ID)"
    else
      echo "  $(t "⚠ 当前账号 " "⚠ Current account ")$CURRENT_ACCOUNT$(t " 不是组织管理账号(" " is not the Org management account (")$ORG_MGMT_ACCOUNT)$(t "。" ".")"
      echo "    $(t "若已在管理账号将本账号注册为 CloudFormation StackSets 委派管理员," "If this account is registered as a CloudFormation StackSets delegated administrator in the management account,")"
      echo "    $(t "仍可使用 org 模式(StackSets 批量下发)。" "you can still use org mode (StackSets bulk deployment).")"
      read -p "    $(t "本账号是 StackSets 委派管理员吗? [y/N]: " "Is this account a StackSets delegated administrator? [y/N]: ")" ORG_DELEGATED
      case "$ORG_DELEGATED" in
        [yY]*) ORG_MODE=true ;;
        *) ORG_MODE=false ;;
      esac
    fi
  else
    echo "  $(t "ℹ 无法读取 Organizations 信息(非组织成员或缺少权限)。" "ℹ Cannot read Organizations info (not an org member or lacking permission).")"
  fi
  if [ "$ORG_MODE" = true ]; then
    ORG_FLAG="-c organizationId=$ORG_ID"
    # OAM Sink 复用发现（每账号每 Region 限 1 个；已有则复用，避免 CREATE_FAILED）
    EXISTING_OAM_SINK=$(aws oam list-sinks --region "$DEPLOY_REGION"       --query 'Items[0].Arn' --output text 2>/dev/null || echo "")
    if [ -n "$EXISTING_OAM_SINK" ] && [ "$EXISTING_OAM_SINK" != "None" ]; then
      ORG_FLAG="$ORG_FLAG -c oamSinkArn=$EXISTING_OAM_SINK"
      echo "  $(t "✓ 复用既有 OAM Sink: " "✓ Reusing existing OAM Sink: ")$EXISTING_OAM_SINK"
    fi
    echo "  $(t "✓ Organizations 模式启用: 白名单交互跳过, 改用 aws:PrincipalOrgID 整组放行。" "✓ Organizations mode enabled: allowlist prompt skipped, using aws:PrincipalOrgID to allow the whole org.")"
    echo "    $(t "部署完成后将引导通过 StackSets 一键下发成员账号资源。" "After deployment, you will be guided to roll out member-account resources via StackSets.")"
  else
    echo "  $(t "ℹ 退回逐账号白名单模式。成员账号需手动部署:" "ℹ Falling back to per-account allowlist mode. Member accounts must be deployed manually:")"
    echo "    $(t "infra/member-account-onboarding.yaml(只读角色 + DevOps/PHD 事件转发)" "infra/member-account-onboarding.yaml (read-only role + DevOps/PHD event forwarding)")"
  fi
fi

if [ "$ENABLE_PHD" = "false" ]; then
  echo "  $(t "跳过 PHD 事件转发功能" "Skipping PHD event forwarding")"
  SKIP_PHD_FLAG="-c skipPhd=true"
  PHD_ACCOUNTS_FLAG=""
else
  echo "  $(t "✓ 将部署 PHD 事件转发功能" "✓ Will deploy PHD event forwarding")"
  SKIP_PHD_FLAG=""

  # 询问是否需要接收其他账号的 Health 事件
  # 本期跨账号 disabled,默认跳过。--multi-account 时才进入。
  PHD_LINKED_ACCOUNTS="${PHD_LINKED_ACCOUNTS:-}"
  if [ "$ORG_MODE" = true ]; then
    # Organizations 模式: SNS Topic Policy 由 aws:PrincipalOrgID 整组放行(CDK orgMode 分支),
    # 无需逐账号白名单;成员账号转发规则由 StackSets 统一下发。
    echo "  $(t "ℹ Organizations 模式: PHD 跨账号白名单交互跳过(OrgID 整组放行)" "ℹ Organizations mode: PHD cross-account allowlist prompt skipped (OrgID allows the whole org)")"
    PHD_ACCOUNTS_FLAG=""
  elif [ "$MULTI_ACCOUNT_MODE" = false ]; then
    PHD_ACCOUNTS_FLAG=""
  else
  if [ -z "$PHD_LINKED_ACCOUNTS" ]; then
    # 尝试从现有 SNS Topic Policy 读取已配置的账号列表
    CURRENT_PHD_ACCOUNTS=""
    # PHD_EXISTING 可能未定义(环境变量预设 ENABLE_PHD 时), 需独立检测
    if [ -z "${PHD_EXISTING:-}" ]; then
      PHD_EXISTING=$(aws cloudformation list-stack-resources \
        --stack-name NotiOpsBackendStack --region "$DEPLOY_REGION" \
        --query "StackResourceSummaries[?starts_with(LogicalResourceId,'PhdEventsTopic')].ResourceStatus | [0]" \
        --output text 2>/dev/null || echo "")
    fi
    if [ -n "$PHD_EXISTING" ] && [ "$PHD_EXISTING" != "None" ]; then
      PHD_TOPIC_ARN=$(aws cloudformation describe-stacks --stack-name NotiOpsBackendStack --region "$DEPLOY_REGION" \
        --query "Stacks[0].Outputs[?OutputKey=='PhdSnsTopicArn'].OutputValue | [0]" --output text 2>/dev/null || echo "")
      if [ -n "$PHD_TOPIC_ARN" ] && [ "$PHD_TOPIC_ARN" != "None" ]; then
        CURRENT_PHD_ACCOUNTS=$(aws sns get-topic-attributes --topic-arn "$PHD_TOPIC_ARN" --region "$DEPLOY_REGION" \
          --query 'Attributes.Policy' --output text 2>/dev/null | \
          python3 -c "
import sys,json,re
try:
    p=json.loads(sys.stdin.read())
    arns=[]
    for s in p.get('Statement',[]):
        if s.get('Sid')=='AllowLinkedAccountRolePublish':
            pr=s.get('Principal',{}).get('AWS',[])
            if isinstance(pr,str): pr=[pr]
            arns.extend(pr)
    accts=sorted(set(re.findall(r'::(\d{12}):', ' '.join(arns))))
    print(','.join(accts))
except Exception: pass
" 2>/dev/null || echo "")
        if [ -z "$CURRENT_PHD_ACCOUNTS" ] && [ -n "$PHD_TOPIC_ARN" ]; then
          echo "  $(t "⚠ 无法读取现有 SNS Topic Policy, 请手动输入 Linked Account IDs" "⚠ Cannot read existing SNS Topic Policy, please enter Linked Account IDs manually")"
        fi
      fi
    fi

    echo ""
    echo "  $(t "是否需要接收其他 AWS 账号的 Health 事件？" "Receive Health events from other AWS accounts?")"
    echo "  $(t "如果只监控当前账号, 直接回车跳过. " "To monitor only the current account, press Enter to skip.")"
    echo "  $(t "如果需要, 请输入 Linked Account ID(逗号分隔, 如: 111122223333,444455556666)" "If needed, enter Linked Account IDs (comma-separated, e.g. 111122223333,444455556666)")"
    echo "  $(t "(填入后, 还需在对应账号中运行 ./setup.sh --phd 完成转发配置)" "(After entering, also run ./setup.sh --phd in each account to complete forwarding setup)")"
    if [ -n "$CURRENT_PHD_ACCOUNTS" ]; then
      echo ""
      echo "  $(t "当前已配置: " "Currently configured: ")$CURRENT_PHD_ACCOUNTS"
      echo "  $(t "直接回车保留当前配置, 或输入新的完整列表. " "Press Enter to keep current config, or enter a new full list.")"
    fi
    echo ""
    read -p "  Linked Account IDs: " PHD_LINKED_ACCOUNTS

    # 用户直接回车 → 保留已有配置
    if [ -z "$PHD_LINKED_ACCOUNTS" ] && [ -n "$CURRENT_PHD_ACCOUNTS" ]; then
      PHD_LINKED_ACCOUNTS="$CURRENT_PHD_ACCOUNTS"
    fi
  fi

  if [ -n "$PHD_LINKED_ACCOUNTS" ]; then
    # 统一分隔符(支持逗号、分号、空格)+ 去除多余分隔符
    PHD_LINKED_ACCOUNTS=$(echo "$PHD_LINKED_ACCOUNTS" | tr ';' ',' | tr ' ' ',' | tr -s ',' | sed 's/^,//;s/,$//')

    # 校验每个 Account ID 格式(12 位数字)
    VALID=true
    IFS=',' read -ra ACCT_ARRAY <<< "$PHD_LINKED_ACCOUNTS"
    for acct in "${ACCT_ARRAY[@]}"; do
      if ! [[ "$acct" =~ ^[0-9]{12}$ ]]; then
        echo "  $(t "❌ 无效的 Account ID: " "❌ Invalid Account ID: ")$acct$(t "(必须为 12 位数字)" " (must be 12 digits)")"
        VALID=false
      fi
    done
    if [ "$VALID" = false ]; then
      echo "  $(t "请检查输入后重新运行 setup.sh" "Please check your input and re-run setup.sh")"
      exit 1
    fi

    echo "  $(t "✓ 跨账号转发: " "✓ Cross-account forwarding: ")$PHD_LINKED_ACCOUNTS"
    PHD_ACCOUNTS_FLAG="-c phdLinkedAccounts=$PHD_LINKED_ACCOUNTS"
  else
    echo "  $(t "仅监控当前账号" "Monitoring current account only")"
    PHD_ACCOUNTS_FLAG=""
  fi
  fi  # end MULTI_ACCOUNT_MODE else (PHD linked accounts)
fi

# ─── DevOps Agent 多账户白名单(Custom Event Bus Resource Policy)───
# 本期只 focus 系统部署账号,跨账号功能暂禁用(LOCKED_ACCOUNT_ID 硬锁)。
# 如需启用多账户,运行: ./setup.sh --multi-account
DEVOPS_AGENT_ACCOUNTS_FLAG=""

if [ "$ORG_MODE" = true ]; then
  echo ""
  echo "  $(t "ℹ Organizations 模式: DevOps Agent 白名单交互跳过 —" "ℹ Organizations mode: DevOps Agent allowlist prompt skipped —")"
  echo "    $(t "Custom Event Bus 由 aws:PrincipalOrgID + events:source 双条件整组放行(CDK orgMode 分支)" "The Custom Event Bus allows the whole org via aws:PrincipalOrgID + events:source dual conditions (CDK orgMode branch)")"
  echo ""
elif [ "$MULTI_ACCOUNT_MODE" = false ]; then
  echo ""
  echo "  $(t "ℹ 跨账号功能本期 disabled(只 focus 部署账号)。如需启用: ./setup.sh --multi-account" "ℹ Cross-account features are disabled by default (focus on the deploy account). To enable: ./setup.sh --multi-account")"
  echo ""
else

# 先检测当前是否已部署 Bus 以及白名单
EXISTING_BUS_WHITELIST=""
EXISTING_BUS_POLICY_PRECHECK=$(aws events describe-event-bus \
  --name notiops-devops-events --region "$DEPLOY_REGION" \
  --query 'Policy' --output text 2>/dev/null || echo "")
if [ -n "$EXISTING_BUS_POLICY_PRECHECK" ] && [ "$EXISTING_BUS_POLICY_PRECHECK" != "None" ]; then
  EXISTING_BUS_WHITELIST=$(echo "$EXISTING_BUS_POLICY_PRECHECK" | python3 -c "
import sys, json
try:
    p = json.loads(sys.stdin.read())
    accts = []
    for s in p.get('Statement', []):
        if s.get('Sid') == 'AllowWhitelistedBusinessAccountsForwardAidevopsEvents':
            cond = s.get('Condition', {}).get('StringEquals', {})
            v = cond.get('aws:PrincipalAccount', [])
            if isinstance(v, str):
                v = [v]
            accts.extend(v)
    print(','.join(sorted(set(accts))))
except Exception:
    pass
" 2>/dev/null || echo "")
fi

echo ""
echo "$(t "是否启用 DevOps Agent 多账户集成(跨账户调查触发 + 结果回传)？" "Enable DevOps Agent multi-account integration (cross-account investigation trigger + result callback)?")"
echo "  $(t "说明: 该功能允许系统账户通过 Custom Event Bus 接收业务账户的 DevOps Agent 调查结果事件. " "Note: this lets the system account receive DevOps Agent investigation-result events from business accounts via a Custom Event Bus.")"
echo "  $(t "若已有或计划接入业务账户, 请输入账号白名单; 否则直接回车跳过. " "If you have or plan to onboard business accounts, enter the allowlist; otherwise press Enter to skip.")"
if [ -n "$EXISTING_BUS_WHITELIST" ]; then
  echo ""
  echo "  $(t "当前已有白名单: " "Current allowlist: ")$EXISTING_BUS_WHITELIST"
  echo "  $(t "选 N 将清空白名单(相当于删除所有业务账户的访问权限)" "Choosing N clears the allowlist (revokes all business accounts access)")"
fi
read -p "  [Y/n]: " DEVOPS_AGENT_CHOICE
case "${DEVOPS_AGENT_CHOICE:-Y}" in
  [nN]*) ENABLE_DEVOPS_AGENT="false" ;;
  *) ENABLE_DEVOPS_AGENT="true" ;;
esac

if [ "$ENABLE_DEVOPS_AGENT" = "true" ]; then
  # 从已部署的 Custom Event Bus Resource Policy 读取当前白名单
  CURRENT_DEVOPS_ACCOUNTS=""
  DEVOPS_BUS_NAME="notiops-devops-events"
  CURRENT_BUS_POLICY=$(aws events describe-event-bus \
    --name "$DEVOPS_BUS_NAME" --region "$DEPLOY_REGION" \
    --query 'Policy' --output text 2>/dev/null || echo "")

  if [ -n "$CURRENT_BUS_POLICY" ] && [ "$CURRENT_BUS_POLICY" != "None" ]; then
    CURRENT_DEVOPS_ACCOUNTS=$(echo "$CURRENT_BUS_POLICY" | python3 -c "
import sys, json
try:
    p = json.loads(sys.stdin.read())
    accts = []
    for s in p.get('Statement', []):
        if s.get('Sid') == 'AllowWhitelistedBusinessAccountsForwardAidevopsEvents':
            cond = s.get('Condition', {}).get('StringEquals', {})
            v = cond.get('aws:PrincipalAccount', [])
            if isinstance(v, str):
                v = [v]
            accts.extend(v)
    print(','.join(sorted(set(accts))))
except Exception:
    pass
" 2>/dev/null || echo "")
  fi

  DEVOPS_AGENT_BUSINESS_ACCOUNTS="${DEVOPS_AGENT_BUSINESS_ACCOUNTS:-}"
  if [ -z "$DEVOPS_AGENT_BUSINESS_ACCOUNTS" ]; then
    echo ""
    echo "  $(t "请输入业务账户白名单(12 位数字, 逗号分隔, 如: 111122223333,444455556666)" "Enter business account allowlist (12-digit IDs, comma-separated, e.g. 111122223333,444455556666)")"
    echo "  $(t "直接回车 = " "Press Enter = ")"
    if [ -n "$CURRENT_DEVOPS_ACCOUNTS" ]; then
      echo "    $(t "保留当前白名单: " "keep current allowlist: ")$CURRENT_DEVOPS_ACCOUNTS"
    else
      echo "    $(t "留空(首次部署 / 暂无业务账户接入)" "leave empty (first deploy / no business accounts yet)")"
    fi
    echo ""
    read -p "  Business Account IDs: " DEVOPS_AGENT_BUSINESS_ACCOUNTS

    # 直接回车 → 保留当前
    if [ -z "$DEVOPS_AGENT_BUSINESS_ACCOUNTS" ] && [ -n "$CURRENT_DEVOPS_ACCOUNTS" ]; then
      DEVOPS_AGENT_BUSINESS_ACCOUNTS="$CURRENT_DEVOPS_ACCOUNTS"
    fi
  fi

  if [ -n "$DEVOPS_AGENT_BUSINESS_ACCOUNTS" ]; then
    # 统一分隔符(支持逗号、分号、空格)+ 去除多余分隔符
    DEVOPS_AGENT_BUSINESS_ACCOUNTS=$(echo "$DEVOPS_AGENT_BUSINESS_ACCOUNTS" \
      | tr ';' ',' | tr ' ' ',' | tr -s ',' | sed 's/^,//;s/,$//')

    # 格式校验(R5.11): 每个账号必须是 12 位数字
    DEVOPS_VALID=true
    IFS=',' read -ra DEVOPS_ACCT_ARRAY <<< "$DEVOPS_AGENT_BUSINESS_ACCOUNTS"
    for acct in "${DEVOPS_ACCT_ARRAY[@]}"; do
      if ! [[ "$acct" =~ ^[0-9]{12}$ ]]; then
        echo "  $(t "❌ 无效的业务账户 ID: " "❌ Invalid business account ID: ")$acct$(t "(必须为 12 位数字)" " (must be 12 digits)")"
        DEVOPS_VALID=false
      fi
    done
    if [ "$DEVOPS_VALID" = false ]; then
      echo "  $(t "请检查输入后重新运行 setup.sh" "Please check your input and re-run setup.sh")"
      exit 1
    fi

    # 去重校验(R5.11)
    DEVOPS_UNIQUE_ACCOUNTS=$(echo "$DEVOPS_AGENT_BUSINESS_ACCOUNTS" \
      | tr ',' '\n' | sort -u | paste -sd ',' -)
    DEVOPS_INPUT_COUNT=$(echo "$DEVOPS_AGENT_BUSINESS_ACCOUNTS" | tr ',' '\n' | wc -l | tr -d ' ')
    DEVOPS_UNIQUE_COUNT=$(echo "$DEVOPS_UNIQUE_ACCOUNTS" | tr ',' '\n' | wc -l | tr -d ' ')
    if [ "$DEVOPS_INPUT_COUNT" != "$DEVOPS_UNIQUE_COUNT" ]; then
      echo "  $(t "❌ 输入包含重复账户, 请去重后重新运行 setup.sh" "❌ Duplicate accounts in input; please de-duplicate and re-run setup.sh")"
      echo "     $(t "原始: " "Original: ")$DEVOPS_AGENT_BUSINESS_ACCOUNTS"
      echo "     $(t "去重: " "Deduped: ")$DEVOPS_UNIQUE_ACCOUNTS"
      exit 1
    fi
    DEVOPS_AGENT_BUSINESS_ACCOUNTS="$DEVOPS_UNIQUE_ACCOUNTS"

    # Diff 展示 + 显式确认(R5.12)
    DEVOPS_ADDED=$(comm -13 \
      <(echo "$CURRENT_DEVOPS_ACCOUNTS" | tr ',' '\n' | sort -u) \
      <(echo "$DEVOPS_AGENT_BUSINESS_ACCOUNTS" | tr ',' '\n' | sort -u) \
      | grep -v '^$' | paste -sd ',' - || echo "")
    DEVOPS_REMOVED=$(comm -23 \
      <(echo "$CURRENT_DEVOPS_ACCOUNTS" | tr ',' '\n' | sort -u) \
      <(echo "$DEVOPS_AGENT_BUSINESS_ACCOUNTS" | tr ',' '\n' | sort -u) \
      | grep -v '^$' | paste -sd ',' - || echo "")

    if [ -n "$DEVOPS_ADDED" ] || [ -n "$DEVOPS_REMOVED" ]; then
      echo ""
      echo "  $(t "DevOps Agent 白名单变更: " "DevOps Agent allowlist changes:")"
      [ -n "$DEVOPS_ADDED" ]   && echo "    $(t "+ 新增: " "+ Added: ")$DEVOPS_ADDED"
      [ -n "$DEVOPS_REMOVED" ] && echo "    $(t "- 删除: " "- Removed: ")$DEVOPS_REMOVED"
      echo "    $(t "最终白名单: " "Final allowlist: ")$DEVOPS_AGENT_BUSINESS_ACCOUNTS"
      echo ""
      echo "  $(t "⚠️ 删除账户的影响: 移除后该账户向 Custom Event Bus 发事件会被拒绝(AccessDenied). " "⚠️ Effect of removal: that account can no longer send events to the Custom Event Bus (AccessDenied).")"
      echo "     $(t "请确认客户侧 delete-stack 或 Dashboard 禁用已完成后再移除白名单. " "Confirm the customer-side delete-stack or Dashboard disable is done before removing from the allowlist.")"
      echo ""
      read -p "  $(t "输入 yes 确认执行 cdk deploy: " "Type yes to confirm cdk deploy: ")" DEVOPS_CONFIRM
      if [ "$DEVOPS_CONFIRM" != "yes" ]; then
        echo "  $(t "已取消部署(未输入 yes)" "Deployment cancelled (yes not entered)")"
        exit 1
      fi
    else
      echo "  $(t "✓ 白名单无变化: " "✓ Allowlist unchanged: ")$DEVOPS_AGENT_BUSINESS_ACCOUNTS"
    fi

    echo "  $(t "✓ DevOps Agent 白名单: " "✓ DevOps Agent allowlist: ")$DEVOPS_AGENT_BUSINESS_ACCOUNTS"
    DEVOPS_AGENT_ACCOUNTS_FLAG="-c devopsAgentBusinessAccounts=$DEVOPS_AGENT_BUSINESS_ACCOUNTS"
  else
    echo "  $(t "DevOps Agent 白名单为空(Custom Event Bus 不创建 resource policy)" "DevOps Agent allowlist is empty (Custom Event Bus resource policy not created)")"
    DEVOPS_AGENT_ACCOUNTS_FLAG=""
  fi
else
  # 选 N 时, 如果当前已有白名单, 警告会清空
  if [ -n "$EXISTING_BUS_WHITELIST" ]; then
    echo ""
    echo "  $(t "⚠️ 警告: 当前 Custom Event Bus 有白名单 [" "⚠️ Warning: the Custom Event Bus currently has an allowlist [")$EXISTING_BUS_WHITELIST]"
    echo "     $(t "选 N 将导致 CDK 删除 resource policy, 这些账户的事件将被拒绝(AccessDenied)" "Choosing N will make CDK delete the resource policy; these accounts events will be denied (AccessDenied)")"
    echo "     $(t "请确认客户侧 delete-stack 或 Dashboard 禁用已完成后再移除白名单. " "Confirm the customer-side delete-stack or Dashboard disable is done before removing from the allowlist.")"
    echo ""
    read -p "     $(t "输入 yes 确认清空白名单: " "Type yes to confirm clearing the allowlist: ")" CLEAR_CONFIRM
    if [ "$CLEAR_CONFIRM" != "yes" ]; then
      echo "     $(t "已取消清空(仍启用 DevOps Agent, 保留现有白名单)" "Clear cancelled (DevOps Agent stays enabled, existing allowlist kept)")"
      DEVOPS_AGENT_ACCOUNTS_FLAG="-c devopsAgentBusinessAccounts=$EXISTING_BUS_WHITELIST"
    else
      echo "  $(t "跳过 DevOps Agent 多账户白名单(Custom Event Bus 将删除 resource policy)" "Skipping DevOps Agent multi-account allowlist (Custom Event Bus resource policy will be deleted)")"
      DEVOPS_AGENT_ACCOUNTS_FLAG=""
    fi
  else
    echo "  $(t "跳过 DevOps Agent 多账户白名单交互(Custom Event Bus 将不创建 resource policy)" "Skipping DevOps Agent multi-account allowlist prompt (Custom Event Bus resource policy will not be created)")"
    DEVOPS_AGENT_ACCOUNTS_FLAG=""
  fi
fi
fi  # end MULTI_ACCOUNT_MODE guard

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

# ─── IM 平台选择 ───
# v1 release: dingtalk 暂不开放给客户(凭据流程 + push 自定义机器人
# 双 robot 配置链路在 Phase 2c 才稳定)。bot-stack.ts 仍然定义了
# DingtalkBotService 但 desiredCount=0,task 不起,不计费。
# 第二版要恢复:把 "3) 钉钉 (DingTalk)" 选项加回菜单 + 在解析里加
# IM_PLATFORM_CHOICE 含 "3" 时 append "dingtalk,"。
echo ""
echo "$(t "── IM 平台选择（可选）──" "── IM Platform Selection (optional) ──")"
echo "  $(t "web 端默认部署。IM Bot 是可选的：你可以现在部署、或暂时不部署、" "The web UI is always deployed. IM bots are optional: deploy now, or skip and")"
echo "  $(t "以后想起来再随时重跑本脚本启用（未选中的平台 ECS desiredCount=0，不启动不计费）。" "re-run this script anytime later (unselected platforms run at ECS desiredCount=0 — no cost).")"
echo "  0) $(t "暂不部署 IM（只部署 web 端，以后可随时再加）" "Skip IM for now (web UI only, can add later)")"
echo "  1) $(t "飞书 (Feishu)" "Feishu")"
echo "  2) Slack"
echo ""
read -p "  $(t "输入编号,多个用逗号分隔 [默认: 0 暂不部署]: " "Enter number(s), comma-separated [default: 0 skip]: ")" IM_PLATFORM_CHOICE
IM_PLATFORM_CHOICE="${IM_PLATFORM_CHOICE:-0}"

ENABLED_PLATFORMS=""
if echo "$IM_PLATFORM_CHOICE" | grep -q "1"; then
  ENABLED_PLATFORMS="${ENABLED_PLATFORMS}feishu,"
fi
if echo "$IM_PLATFORM_CHOICE" | grep -q "2"; then
  ENABLED_PLATFORMS="${ENABLED_PLATFORMS}slack,"
fi
ENABLED_PLATFORMS="${ENABLED_PLATFORMS%,}"  # 去尾逗号(空 = 不启用任何 IM)

if [ -z "$ENABLED_PLATFORMS" ]; then
  # 不部署 IM：BotStack 仍部署但所有 bot desiredCount=0（不起容器、不计费）。
  # 以后想启用：重跑本脚本选 1/2 即可，无需重建。
  echo "  $(t "✓ 暂不部署 IM（web 端照常部署；以后重跑本脚本可随时启用 IM）" "✓ Skipping IM (web UI deploys as usual; re-run this script anytime to enable IM)")"
  PLATFORM_FLAG="-c enabledPlatforms=none"
else
  # 选了 IM → 需要 Docker 本地构建 ECS 容器镜像
  if [ "$HAS_DOCKER" != "true" ]; then
    echo ""
    echo "  $(t "❌ 你选择了部署 IM Bot（" "❌ You chose to deploy IM bots (")$ENABLED_PLATFORMS$(t "），但未检测到可用的容器构建工具。" "), but no container build tool was detected.")"
    echo "     $(t "IM Bot 需要本地 Docker 或 Finch 构建 ECS 容器镜像。" "IM bots need local Docker or Finch to build ECS container images.")"
    echo "     $(t "请安装并启动 Docker Desktop，或运行 'finch vm start' 启动 Finch 后重试；" "Install and start Docker Desktop, or run 'finch vm start', then retry;")"
    echo "     $(t "或选 0) 暂不部署 IM。" "or choose 0) skip IM.")"
    exit 1
  fi
  echo "  $(t "✓ 启用平台: " "✓ Enabled platforms: ")$ENABLED_PLATFORMS$(t "（容器工具: " " (container tool: ")$CONTAINER_TOOL)"
  PLATFORM_FLAG="-c enabledPlatforms=$ENABLED_PLATFORMS"
fi

# 1. 构建前端（idle 控制台 + web chat）
echo ""
echo "$(t "[1/4] 构建前端..." "[1/4] Building frontends...")"
cd "$PROJECT_ROOT/frontend/frontend-app"
npm ci --silent   # ci: 严格按 package-lock.json 安装，保证可复现 + 不放宽 override floor（安全要求）
npm run build
echo "  $(t "✓ idle 控制台前端构建完成" "✓ Console frontend built")"

# Web Chat 前端（WebChatStack 的 BucketDeployment 部署其 dist/）
cd "$PROJECT_ROOT/frontend/chat-app"
npm ci --silent
npm run build
echo "  $(t "✓ web chat 前端构建完成" "✓ Web Chat frontend built")"

# Web Chat BFF 依赖（node_modules 随 Lambda asset 打包；含 bedrock-agentcore 客户端）
cd "$PROJECT_ROOT/bff/web-chat"
# 能力清单单一真源在 config/，Lambda 只打包 bff/web-chat/，故部署前复制进来
# （运行时 capabilities.mjs 优先读同目录）
cp "$PROJECT_ROOT/config/capabilities.json" "$PROJECT_ROOT/bff/web-chat/capabilities.json"
echo "  $(t "✓ 能力清单 capabilities.json 已复制进 BFF" "✓ capabilities.json copied into BFF")"
cp "$PROJECT_ROOT/config/eol-dates.json" "$PROJECT_ROOT/bff/web-chat/eol-dates.json"
echo "  $(t "✓ EOL 兜底表 eol-dates.json 已复制进 BFF" "✓ eol-dates.json copied into BFF")"
npm ci --omit=dev --silent --no-audit --no-fund   # ci: 严格按 lockfile（安全要求）
echo "  $(t "✓ web chat BFF 依赖安装完成" "✓ Web Chat BFF dependencies installed")"

# ── Web Chat Agent（AgentCore Runtime）部署 ──
# 部署 Strands agent 到 AgentCore Runtime，并 provision web-search Gateway（仅 us-east-1）。
# 拿到 Runtime ARN 后，下面 CDK 部署 WebChatStack 时通过 -c agentRuntimeArn 注入，
# BFF 才会调真 agent（否则回退 echo）。agent 部署失败不阻断整体部署（web 端仍可用）。
# 跳过：SKIP_AGENT=true ./setup.sh（仅部署 web 端 + echo BFF）。
AGENT_RUNTIME_ARN=""
AGENT_ARN_FLAG=""
if [ "${SKIP_AGENT:-false}" != "true" ] && [ -d "$PROJECT_ROOT/agent-build/NotiOpsWebChat" ]; then
  echo ""
  echo "  $(t "── 部署 Web Chat Agent（AgentCore Runtime，约 5-10 分钟）──" "── Deploying Web Chat Agent (AgentCore Runtime, ~5-10 min) ──")"
  AGENT_ARN_FILE="${TMPDIR:-/tmp}/notiops-agent-arn.txt"
  rm -f "$AGENT_ARN_FILE"
  if DEPLOY_REGION="$DEPLOY_REGION" PROJECT_ROOT="$PROJECT_ROOT" \
     ENABLE_WEBSEARCH="${ENABLE_WEBSEARCH:-true}" AGENT_ARN_OUT="$AGENT_ARN_FILE" \
     NOTIOPS_ALLOW_CROSS_ACCOUNT="$([ "$ORG_MODE" = true ] && echo 1 || echo "")" \
     bash "$PROJECT_ROOT/scripts/deploy_agent.sh"; then
    AGENT_RUNTIME_ARN=$(cat "$AGENT_ARN_FILE" 2>/dev/null || echo "")
    if [ -n "$AGENT_RUNTIME_ARN" ]; then
      AGENT_ARN_FLAG="-c agentRuntimeArn=$AGENT_RUNTIME_ARN"
      echo "  $(t "✓ Agent 已部署，将注入 WebChatStack：" "✓ Agent deployed, injecting into WebChatStack: ")$AGENT_RUNTIME_ARN"
    fi
  else
    echo "  $(t "⚠ Agent 部署失败 —— web 端仍会部署，但 BFF 暂回退 echo。" "⚠ Agent deployment failed — the web UI still deploys, but BFF falls back to echo for now.")"
    echo "    $(t "修复后可单独重跑：" "After fixing, re-run separately: ")DEPLOY_REGION=$DEPLOY_REGION bash scripts/deploy_agent.sh"
    echo "    $(t "然后：" "then: ")cd infra && npx cdk deploy WebChatStack --exclusively -c agentRuntimeArn=<ARN>"
  fi
elif [ "${SKIP_AGENT:-false}" = "true" ]; then
  echo "  $(t "（SKIP_AGENT=true：跳过 agent 部署，BFF 走 echo 回退。）" "(SKIP_AGENT=true: skipping agent deployment, BFF uses echo fallback.)")"
fi

# 2. 安装 Lambda 依赖
echo ""
echo "$(t "[2/4] 安装 Lambda 依赖..." "[2/4] Installing Lambda dependencies...")"
cd "$PROJECT_ROOT"
# 清理旧包(避免 psycopg2 等已废弃包残留 + dist-info 堆积)
rm -rf lambda_layer/python/
mkdir -p lambda_layer/python/
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip --quiet
# --platform 确保安装 Linux x86_64 二进制(Lambda 运行环境)；用单行命令, 避免 \ 续行被编辑器/换行/尾随空格破坏(更 robust)
PLAT_ARGS="--platform manylinux2014_x86_64 --implementation cp --only-binary=:all:"
pip install boto3==1.42.69 botocore==1.42.69 -t lambda_layer/python/ --quiet --upgrade $PLAT_ARGS
pip install "aws-lambda-powertools[aws-sdk]>=3.0.0" -t lambda_layer/python/ --quiet --upgrade $PLAT_ARGS
pip install "jinja2>=3.1.6" -t lambda_layer/python/ --quiet --upgrade $PLAT_ARGS
deactivate
echo "  $(t "✓ Lambda 依赖安装完成" "✓ Lambda dependencies installed")"

# 2.5. 检查遗留旧 Secret(spec: devops-agent-per-account-architecture 已废弃)
# 旧架构用 notiops/devops-agent-config Secret 存 agent_space_id, 
# 新架构改为 DynamoDB config 表(account# 前缀). 
# 新 CDK 已不再创建此 Secret, 但升级用户的 Secrets Manager 里残留一个(30 天恢复期内仍计费). 
LEGACY_DEVOPS_SECRET_ARN=$(aws secretsmanager describe-secret \
  --secret-id notiops/devops-agent-config \
  --region "$DEPLOY_REGION" \
  --query 'ARN' --output text 2>/dev/null || echo "")
if [ -n "$LEGACY_DEVOPS_SECRET_ARN" ] && [ "$LEGACY_DEVOPS_SECRET_ARN" != "None" ]; then
  echo ""
  echo "  $(t "⚠ 检测到遗留 Secret: notiops/devops-agent-config" "⚠ Detected legacy Secret: notiops/devops-agent-config")"
  echo "     $(t "(新架构已改为 DynamoDB config 表(account# 前缀), 此 Secret 不再使用)" "(the new architecture uses the DynamoDB config table (account# prefix); this Secret is no longer used)")"
  echo "     $(t "手工清理命令(不影响本次部署):" "Manual cleanup command (does not affect this deployment):")"
  echo "       aws secretsmanager delete-secret \\"
  echo "         --secret-id notiops/devops-agent-config \\"
  echo "         --force-delete-without-recovery --region $DEPLOY_REGION"
fi

# 3. 安装 CDK 依赖 + 部署
echo ""
echo "$(t "[3/4] CDK 部署到 " "[3/4] CDK deploying to ")$DEPLOY_REGION$(t "(约 10-15 分钟)..." " (~10-15 min)...")"
cd "$PROJECT_ROOT/infra"
npm ci --silent   # ci: 严格按 lockfile，保证可复现 + 不放宽 override floor（安全要求）

CDK_ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")

# ─── CDK Bootstrap（没有则 bootstrap，有则复用；但先校验健康度）───
# ⚠️ 关键教训：bootstrap「存在」≠「可用」。
# 曾遇到 CDKToolkit 栈还在、但它的 asset 仓库（container-assets ECR / file-assets S3）
# 被账外删除的情况，导致部署时「推镜像」或「传 Lambda 代码」失败，例如：
#   "No ECR repository named 'cdk-<qualifier>-container-assets-...'. Is this account bootstrapped?"
# 旧写法 `cdk bootstrap ... 2>/dev/null || true` 把这类失败全部吞掉，
# 直到很久之后真正用到该资源才爆，且报错极具误导性。
# 因此改为「有且健康则复用，没有或损坏则修」，并且不再静默吞错：
#   1. 没 bootstrap 过         → 执行 bootstrap（失败即 fail-fast，暴露权限/网络等真实原因）
#   2. bootstrap 过 + 资产齐全 → 直接复用，跳过 bootstrap（省 1-2 分钟）
#   3. bootstrap 过 + 资产缺失 → 补回资源后重跑 bootstrap 修复（普通 bootstrap 因栈 rollback 无法自愈）
#
# 通用性说明（对任意按本项目部署的用户都成立，而非仅当前账号）：
#   · region/account 全部动态取，无硬编码。
#   · qualifier 从项目 cdk.json 的 @aws-cdk/core:bootstrapQualifier 动态读取，
#     读不到才回退 CDK 默认值 hnb659fds（本项目即用默认值）。
#     ⚠ 若项目改用「app 代码里 new DefaultStackSynthesizer({ qualifier })」这种
#       非 cdk.json 的方式自定义 qualifier，需要在此同步来源。
_run_cdk_bootstrap() {
  local target="$1"
  local rc=0
  if [ -n "$target" ]; then
    echo "  $(t "执行 cdk bootstrap（" "Running cdk bootstrap (")$target$(t "）..." ")...")"
    npx cdk bootstrap "$target" || rc=$?
  else
    echo "  $(t "执行 cdk bootstrap（使用当前环境凭证/区域）..." "Running cdk bootstrap (using current environment credentials/region)...")"
    npx cdk bootstrap || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    echo ""
    echo "  $(t "❌ cdk bootstrap 失败（退出码 " "❌ cdk bootstrap failed (exit code ")$rc$(t "），无法继续部署。" "), cannot continue deployment.")"
    echo "     $(t "常见原因：" "Common causes:")"
    echo "       $(t "· 当前身份缺少创建 bootstrap 资源（S3 / ECR / IAM Role / KMS）的权限" "· The current identity lacks permission to create bootstrap resources (S3 / ECR / IAM Role / KMS)")"
    echo "       $(t "· 网络不通 / 凭证过期" "· Network unreachable / credentials expired")"
    echo "       $(t "· CDKToolkit 栈卡在 ROLLBACK_COMPLETE（首次创建即失败，无法 update 修复），" "· The CDKToolkit stack is stuck in ROLLBACK_COMPLETE (failed on first create, cannot be fixed by update),")"
    echo "         $(t "需手动删除后重建：" "delete it manually and re-create:")"
    echo "           aws cloudformation delete-stack --stack-name CDKToolkit --region $DEPLOY_REGION"
    echo "     $(t "修复后重跑 setup.sh。" "Fix the issue and re-run setup.sh.")"
    exit 1
  fi
}

if [ -z "$CDK_ACCOUNT" ]; then
  # 拿不到账号 ID（凭证异常）——退回最朴素的 bootstrap，失败即退出。
  _run_cdk_bootstrap ""
else
  # qualifier：优先读项目 cdk.json 的自定义值，读不到才用 CDK 默认 hnb659fds。
  # （jq 是本脚本的强制依赖，开头已校验。）
  BOOTSTRAP_QUALIFIER=$(jq -r '.context["@aws-cdk/core:bootstrapQualifier"] // "hnb659fds"' \
    "$PROJECT_ROOT/infra/cdk.json" 2>/dev/null || echo "hnb659fds")
  [ -n "$BOOTSTRAP_QUALIFIER" ] && [ "$BOOTSTRAP_QUALIFIER" != "null" ] || BOOTSTRAP_QUALIFIER="hnb659fds"

  CONTAINER_ASSETS_REPO="cdk-${BOOTSTRAP_QUALIFIER}-container-assets-${CDK_ACCOUNT}-${DEPLOY_REGION}"
  FILE_ASSETS_BUCKET="cdk-${BOOTSTRAP_QUALIFIER}-assets-${CDK_ACCOUNT}-${DEPLOY_REGION}"
  BOOTSTRAP_TARGET="aws://$CDK_ACCOUNT/$DEPLOY_REGION"

  # bootstrap 版本参数存在 = 这个账号+区域 bootstrap 过
  BOOTSTRAP_VERSION=$(aws ssm get-parameter \
    --name "/cdk-bootstrap/${BOOTSTRAP_QUALIFIER}/version" \
    --region "$DEPLOY_REGION" \
    --query 'Parameter.Value' --output text 2>/dev/null || echo "")

  if [ -z "$BOOTSTRAP_VERSION" ]; then
    echo "  $(t "未检测到 CDK bootstrap（qualifier=" "CDK bootstrap not found (qualifier=")$BOOTSTRAP_QUALIFIER, region=$DEPLOY_REGION$(t "），首次初始化..." "), initializing for the first time...")"
    _run_cdk_bootstrap "$BOOTSTRAP_TARGET"
  else
    # 校验两个 asset 仓库是否都真实存在（推镜像用 ECR / 传 Lambda 代码用 S3）
    NEED_REPAIR=false
    if ! aws ecr describe-repositories --repository-names "$CONTAINER_ASSETS_REPO" \
           --region "$DEPLOY_REGION" >/dev/null 2>&1; then
      echo "  $(t "⚠ 容器镜像仓库缺失：" "⚠ Container image repository missing: ")$CONTAINER_ASSETS_REPO"
      NEED_REPAIR=true
    fi
    if ! aws s3api head-bucket --bucket "$FILE_ASSETS_BUCKET" >/dev/null 2>&1; then
      echo "  $(t "⚠ 文件资产桶缺失：" "⚠ File assets bucket missing: ")$FILE_ASSETS_BUCKET"
      NEED_REPAIR=true
    fi

    if [ "$NEED_REPAIR" = false ]; then
      echo "  $(t "✓ 检测到健康的 CDK bootstrap（qualifier=" "✓ Healthy CDK bootstrap detected (qualifier=")$BOOTSTRAP_QUALIFIER$(t ", 版本 " ", version ")$BOOTSTRAP_VERSION$(t "），复用现有环境（跳过 bootstrap）" "), reusing it (skipping bootstrap)")"
    else
      echo "    $(t "（通常是这些资源被账外删除，CDKToolkit 栈会因此卡在 rollback，普通 bootstrap 无法自愈）" "(usually these were deleted out-of-band, leaving CDKToolkit stuck in rollback that a plain bootstrap cannot self-heal)")"
      echo "    $(t "→ 先补回缺失资源（补回后 bootstrap 的属性引用才能解析），再重跑 bootstrap 修复..." "→ Recreating the missing resources first (so bootstrap property refs resolve), then re-running bootstrap to repair...")"
      # 补回 ECR（幂等；已存在则忽略）
      aws ecr describe-repositories --repository-names "$CONTAINER_ASSETS_REPO" --region "$DEPLOY_REGION" >/dev/null 2>&1 \
        || aws ecr create-repository --repository-name "$CONTAINER_ASSETS_REPO" --region "$DEPLOY_REGION" >/dev/null 2>&1 || true
      # 补回 S3（区分 us-east-1 与其他 region 的 LocationConstraint）；桶属性由随后的 bootstrap 补齐
      if ! aws s3api head-bucket --bucket "$FILE_ASSETS_BUCKET" >/dev/null 2>&1; then
        if [ "$DEPLOY_REGION" = "us-east-1" ]; then
          aws s3api create-bucket --bucket "$FILE_ASSETS_BUCKET" --region "$DEPLOY_REGION" >/dev/null 2>&1 || true
        else
          aws s3api create-bucket --bucket "$FILE_ASSETS_BUCKET" --region "$DEPLOY_REGION" \
            --create-bucket-configuration LocationConstraint="$DEPLOY_REGION" >/dev/null 2>&1 || true
        fi
      fi
      _run_cdk_bootstrap "$BOOTSTRAP_TARGET"
    fi
  fi
fi

# --- IAM Role 孤儿检测(固定 roleName 的 2 个 Role)---
# 如果 role 已存在但不在当前 Stack 管理中, CDK CREATE 会失败.
# 本次检查 2 个 Role:
#   - IdleDetectionRole(历史遗留, 跨账户数据采集用)
#   - notiops-lambda-execution-role(Lambda 执行角色)
#
# 固定 roleName 的 Role 在 Stack 回滚 / 变更 roleName 升级时容易变成孤儿,
# 下次 cdk deploy 会 CREATE_FAILED: already exists. 

check_orphan_role() {
  local role_name="$1"
  local stack_logical_prefix="$2"

  local role_exists
  role_exists=$(aws iam get-role --role-name "$role_name" --query 'Role.RoleName' --output text 2>/dev/null || echo "None")
  if [ "$role_exists" = "None" ]; then
    return 0
  fi

  local stack_role_id
  stack_role_id=$(aws cloudformation list-stack-resources --stack-name NotiOpsBackendStack --region "$DEPLOY_REGION" \
    --query "StackResourceSummaries[?ResourceType=='AWS::IAM::Role' && starts_with(LogicalResourceId,'${stack_logical_prefix}')].PhysicalResourceId | [0]" \
    --output json 2>/dev/null | python3 -c "import sys,json; v=json.load(sys.stdin) if sys.stdin.readable() else None; print(v if isinstance(v,str) else 'None')" 2>/dev/null || echo "None")

  # Stack 有管理这个 Role 且 PhysicalResourceId 匹配 → 不是孤儿
  if [ -n "$stack_role_id" ] && [ "$stack_role_id" != "None" ] && [ "$stack_role_id" = "$role_name" ]; then
    return 0
  fi

  echo "  $(t "⚠ 检测到孤儿 IAM Role: " "⚠ Orphan IAM Role detected: ")$role_name$(t "(不在 CloudFormation 管理中)" " (not managed by CloudFormation)")"
  echo "     $(t "这通常是 Stack 回滚后或 roleName 变更升级后残留的资源. " "This is usually a leftover from a stack rollback or a roleName change during upgrade.")"
  echo ""
  echo "     $(t "选项: " "Options:")"
  echo "       1) $(t "自动删除并由 CDK 重新创建(推荐)" "Auto-delete and let CDK recreate it (recommended)")"
  echo "       2) $(t "跳过, 手动处理" "Skip and handle manually")"
  echo ""
  read -p "     $(t "请选择 [1/2](默认 1): " "Choose [1/2] (default 1): ")" role_action
  # 使用 case 代替 ${var,,}, 兼容 bash 3.2(macOS 默认 bash)
  case "${role_action:-1}" in
    2)
      echo "     $(t "跳过. 如果 CDK 部署报 'already exists', 请手动删除: " "Skipped. If CDK deploy reports 'already exists', delete it manually:")"
      echo "       aws iam delete-role --role-name $role_name"
      ;;
    *)
      # 先删除 inline policies
      for policy in $(aws iam list-role-policies --role-name "$role_name" --query 'PolicyNames[]' --output text 2>/dev/null); do
        aws iam delete-role-policy --role-name "$role_name" --policy-name "$policy"
      done
      # 再删除 attached managed policies
      for arn in $(aws iam list-attached-role-policies --role-name "$role_name" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
        aws iam detach-role-policy --role-name "$role_name" --policy-arn "$arn"
      done
      # 删除 instance profiles(如有)
      for ip in $(aws iam list-instance-profiles-for-role --role-name "$role_name" --query 'InstanceProfiles[].InstanceProfileName' --output text 2>/dev/null); do
        aws iam remove-role-from-instance-profile --instance-profile-name "$ip" --role-name "$role_name" 2>/dev/null || true
      done
      aws iam delete-role --role-name "$role_name"
      echo "     $(t "✓ 孤儿 Role " "✓ Orphan Role ")$role_name$(t " 已删除, CDK 将重新创建" " deleted, CDK will recreate it")"
      ;;
  esac
}

check_orphan_role "notiops-idle-detection-role" "IdleDetectionRole"
check_orphan_role "notiops-lambda-execution-role" "LambdaExecutionRole"

# 3. CDK 部署
echo ""
cd "$PROJECT_ROOT/infra"

# 部署前 IAM 权限一致性检查
echo "  $(t "🔍 运行 IAM 权限一致性检查..." "🔍 Running IAM permission consistency check...")"
SYNTH_OK=true
# --output to a dir OUTSIDE the repo root: Lambda fromAsset("../") packages the
# repo root, so the CDK output dir must NOT live inside it (infra/cdk.out would
# self-reference recursively → ENAMETOOLONG). $CDK_OUT_DIR is under the system
# temp dir, fully outside ../.
CDK_OUT_DIR="${TMPDIR:-/tmp}/notiops-cdk-out"
rm -rf "$CDK_OUT_DIR"; mkdir -p "$CDK_OUT_DIR"
npx cdk synth --quiet --all --output "$CDK_OUT_DIR" $SKIP_PHD_FLAG $PHD_ACCOUNTS_FLAG $DEVOPS_AGENT_ACCOUNTS_FLAG $PLATFORM_FLAG $AGENT_ARN_FLAG $ORG_FLAG 2>cdk-synth-stderr.log || SYNTH_OK=false

if [ "$SYNTH_OK" = false ]; then
  echo ""
  echo "  $(t "❌ cdk synth 失败, 不能继续部署. 错误信息: " "❌ cdk synth failed, cannot continue. Error output:")"
  cat cdk-synth-stderr.log 2>/dev/null
  echo ""
  echo "  $(t "请修复 CDK 代码后重跑 setup.sh" "Fix the CDK code and re-run setup.sh")"
  rm -f cdk-synth-stderr.log
  exit 1
fi

if IAM_CHECK_TEMPLATE="$CDK_OUT_DIR/NotiOpsBackendStack.template.json" python3 scripts/check-iam-consistency.py; then
  echo "  $(t "✓ 权限检查通过" "✓ Permission check passed")"
else
  echo ""
  echo "  $(t "⚠️  IAM 一致性检查发现问题(见上方详情). " "⚠️  IAM consistency check found issues (see details above).")"
  echo "  $(t "这可能是\"脚本自身的 false positive\"或\"代码里的真 bug\". " "This may be a false positive in the checker, or a real bug in the code.")"
  echo "  $(t "是否继续部署？[y/N]" "Continue deployment? [y/N]")"
  read -r CONTINUE
  if [ "$CONTINUE" != "y" ] && [ "$CONTINUE" != "Y" ]; then
    echo "  $(t "部署已取消" "Deployment cancelled")"
    rm -f cdk-synth-stderr.log
    exit 1
  fi
fi

rm -f cdk-synth-stderr.log

echo "  $(t "执行完整部署..." "Running full deployment...")"
# Same --output outside repo root as synth above (avoids fromAsset recursion).
# $AGENT_ARN_FLAG（若 agent 部署成功）= "-c agentRuntimeArn=<ARN>"，让 WebChatStack 的 BFF
# 调真 agent；为空则 BFF 回退 echo。
npx cdk deploy --all --require-approval never --output "$CDK_OUT_DIR" --outputs-file cdk-outputs.json $SKIP_PHD_FLAG $PHD_ACCOUNTS_FLAG $DEVOPS_AGENT_ACCOUNTS_FLAG $PLATFORM_FLAG $AGENT_ARN_FLAG $ORG_FLAG
echo "  $(t "✓ CDK 部署完成" "✓ CDK deployment complete")"

# ── 部署后回填:补齐【只有 NotiOpsBackendStack 部署完才拿得到】的两个 runtime env ──
# deploy_agent.sh 跑在本脚本早处(agent 必须先建,WebChatStack 才能注入其 ARN),那时
# NotiOpsBackendStack 尚未部署 → AgentSpaceId / ReportsCdnDomain 只能取到空串,退化成
# 运行时 ListAgentSpaces 自动发现 + reports 12h presigned。此刻两个栈都已就绪,读真值,
# merge-patch 回填到 runtime(只覆盖这两个 key,不动 deploy_agent.sh 已设的 gateway/桶)。
# 幂等、不阻断:失败仅告警,运行时兜底逻辑仍在。
if [ -n "$AGENT_RUNTIME_ARN" ]; then
  # STACK_NAME 变量在下面 [4/4] 段才赋值,这里用字面栈名(cdk-outputs.json 的顶层 key)。
  DA_SPACE_ID=$(jq -r '.NotiOpsBackendStack.AgentSpaceId // empty' cdk-outputs.json 2>/dev/null || echo "")
  RPT_CDN=$(jq -r '.NotiOpsBackendStack.ReportsCdnDomain // empty' cdk-outputs.json 2>/dev/null || echo "")
  if [ -n "$DA_SPACE_ID" ] || [ -n "$RPT_CDN" ]; then
    echo "  $(t "回填部署后才可得的 runtime env(Agent Space / 报告 CDN)…" "Backfilling post-deploy runtime env (Agent Space / reports CDN)…")"
    REGION="$DEPLOY_REGION" RT_ARN="$AGENT_RUNTIME_ARN" SET_IDLE="" UI_LANG="$UI_LANG" \
      bash "$PROJECT_ROOT/scripts/backfill_runtime_env.sh" \
        "DEVOPS_AGENT_SPACE_ID=$DA_SPACE_ID" "REPORTS_CDN_DOMAIN=$RPT_CDN" \
      || echo "  $(t "⚠ 部署后 env 回填未完成(不阻断);运行时兜底仍生效,可稍后重跑 setup.sh。" "⚠ Post-deploy env backfill did not complete (non-blocking); runtime fallbacks still apply, you can re-run setup.sh later.")"
  fi
fi

# 4. 部署摘要
echo ""
echo "$(t "[4/4] 提取部署信息..." "[4/4] Extracting deployment info...")"

cd "$PROJECT_ROOT/infra"
# Two stacks are now deployed (NotiOpsBackendStack + BotStack), so `keys[0]`
# is no longer deterministic. All outputs below come from NotiOpsBackendStack;
# hardcode it.
STACK_NAME="NotiOpsBackendStack"

CLOUDFRONT_URL=$(jq -r ".[\"$STACK_NAME\"].CloudFrontUrl" cdk-outputs.json)
USER_POOL_ID=$(jq -r ".[\"$STACK_NAME\"].UserPoolId" cdk-outputs.json)
IDLE_ROLE_ARN=$(jq -r ".[\"$STACK_NAME\"].IdleDetectionRoleArn" cdk-outputs.json)
LAMBDA_ROLE_ARN=$(jq -r ".[\"$STACK_NAME\"].LambdaExecutionRoleArn" cdk-outputs.json)
API_URL=$(jq -r ".[\"$STACK_NAME\"].ApiUrl" cdk-outputs.json)
DATA_BUCKET=$(jq -r ".[\"$STACK_NAME\"].DataBucketName" cdk-outputs.json 2>/dev/null || echo "N/A")
FEISHU_SECRET=$(jq -r ".[\"$STACK_NAME\"].FeishuSecretArn" cdk-outputs.json 2>/dev/null || echo "N/A")
SLACK_BOT_TOKEN_SECRET=$(jq -r ".[\"$STACK_NAME\"].SlackBotTokenSecretArn" cdk-outputs.json 2>/dev/null || echo "N/A")
SLACK_APP_TOKEN_SECRET=$(jq -r ".[\"$STACK_NAME\"].SlackAppTokenSecretArn" cdk-outputs.json 2>/dev/null || echo "N/A")
BEDROCK_API_KEY_SECRET=$(jq -r ".[\"$STACK_NAME\"].BedrockApiKeySecretArn" cdk-outputs.json 2>/dev/null || echo "${BEDROCK_API_KEY_SECRET_ARN:-N/A}")
PHD_SNS_TOPIC=$(jq -r ".[\"$STACK_NAME\"].PhdSnsTopicArn" cdk-outputs.json 2>/dev/null || echo "N/A")

# WebChatStack 输出（独立栈，key 不在 NotiOpsBackendStack 下）。WebChatStack 可能
# 没部署成功/被跳过（agent 部署失败时仍会部署 web 端，但极端情况下整栈失败），
# 缺失时给 N/A 而不是让整个脚本在这里因 jq null 报错退出。
CHAT_URL=$(jq -r ".WebChatStack.ChatUrl" cdk-outputs.json 2>/dev/null || echo "N/A")
CHAT_BFF_URL=$(jq -r ".WebChatStack.ChatBffUrl" cdk-outputs.json 2>/dev/null || echo "N/A")
[ "$CHAT_URL" = "null" ] && CHAT_URL="N/A"
[ "$CHAT_BFF_URL" = "null" ] && CHAT_BFF_URL="N/A"
CUR_FINALIZER_FN_ARN=$(jq -r ".[\"$STACK_NAME\"].CurFinalizerFunctionArn" cdk-outputs.json 2>/dev/null || echo "")
CUR_FINALIZER_SCHEDULER_ROLE_ARN=$(jq -r ".[\"$STACK_NAME\"].CurFinalizerSchedulerRoleArn" cdk-outputs.json 2>/dev/null || echo "")

# ─── CUR + Athena FinOps 数据源（检测 / 复用 / 新建）───
# 背景：FinOps 仪表盘的 "DevOps Agent 调用成本" 卡片（product_product_name=
# 'AWSDevOpsAgent'）需要 CUR 明细（Cost Explorer 聚合层查不到这个维度），
# 必须走 Athena 查 CUR 表。AWS 官方流程分两阶段、中间有 ~24h 硬性延迟
# （见 docs/DEPLOYMENT.md §CUR/Athena FinOps 数据源），此处只负责阶段一
# （创建 CUR + 调度阶段二）；阶段二由 lambda6_cur_finalizer 在 T+25h 自动完成。
echo ""
echo "$(t "── CUR + Athena FinOps 数据源 ──" "── CUR + Athena FinOps Data Source ──")"
CUR_DDB_STATUS=""
if [ -n "$CDK_ACCOUNT" ]; then
  CUR_DDB_STATUS=$(aws dynamodb get-item --table-name notiops-config \
    --key "{\"PK\":{\"S\":\"cur-athena-status#$CDK_ACCOUNT\"},\"SK\":{\"S\":\"STATUS\"}}" \
    --region "$DEPLOY_REGION" --query "Item.status.S" --output text 2>/dev/null || echo "")
  [ "$CUR_DDB_STATUS" = "None" ] && CUR_DDB_STATUS=""
fi

if [ -n "$CUR_DDB_STATUS" ]; then
  echo "  $(t "✓ 已有 NotiOps 管理的 CUR/Athena 记录，状态: " "✓ NotiOps-managed CUR/Athena record already exists, status: ")$CUR_DDB_STATUS$(t "（跳过创建；如需重建请先手动清理 DDB 记录）" " (skipping creation; to rebuild, clear the DDB record manually first)")"
else
  # 检测账号里是否已有符合条件（HOURLY + RESOURCES + Athena 集成）的既有 CUR 报告，
  # 让用户选择复用还是新建专用的（AWS 官方强烈建议 Athena 集成用专用报告/桶）。
  EXISTING_CUR_JSON=$(aws cur describe-report-definitions --region us-east-1 \
    --query "ReportDefinitions[?TimeUnit=='HOURLY' && contains(AdditionalSchemaElements, 'RESOURCES') && ReportVersioning!=null]" \
    --output json 2>/dev/null || echo "[]")
  EXISTING_CUR_COUNT=$(echo "$EXISTING_CUR_JSON" | jq 'length' 2>/dev/null || echo "0")

  CUR_CHOICE="0"
  if [ "$EXISTING_CUR_COUNT" -gt 0 ] 2>/dev/null; then
    echo "  $(t "发现 " "Found ")$EXISTING_CUR_COUNT$(t " 个符合条件的既有 CUR 报告（Hourly + Resource IDs）：" " eligible existing CUR report(s) (Hourly + Resource IDs):")"
    echo "$EXISTING_CUR_JSON" | jq -r '.[] | "    - \(.ReportName)  (bucket: \(.S3Bucket))"'
    echo ""
    echo "  0) $(t "新建专用 CUR + S3 桶（AWS 官方推荐，Athena 集成不建议复用已有报告/桶）" "Create a dedicated CUR + S3 bucket (AWS-recommended; reusing existing reports/buckets for Athena is discouraged)")"
    echo "  1) $(t "复用第一个既有报告: " "Reuse the first existing report: ")$(echo "$EXISTING_CUR_JSON" | jq -r '.[0].ReportName')"
    read -p "  $(t "输入编号 [默认: 0 新建]: " "Enter number [default: 0 create new]: ")" CUR_CHOICE
    CUR_CHOICE="${CUR_CHOICE:-0}"
  fi

  if [ "$CUR_CHOICE" = "1" ] && [ "$EXISTING_CUR_COUNT" -gt 0 ] 2>/dev/null; then
    CUR_BUCKET=$(echo "$EXISTING_CUR_JSON" | jq -r '.[0].S3Bucket')
    CUR_REPORT_NAME=$(echo "$EXISTING_CUR_JSON" | jq -r '.[0].ReportName')
    CUR_PREFIX=$(echo "$EXISTING_CUR_JSON" | jq -r '.[0].S3Prefix')
    echo "  $(t "✓ 复用既有 CUR: " "✓ Reusing existing CUR: ")$CUR_REPORT_NAME (bucket: $CUR_BUCKET)"
    # 复用既有 CUR：数据已交付，直接【同步】调用 lambda6_cur_finalizer——它会动态发现该
    # 报告对应的 Glue db/table（既有就复用，没有就部署官方 Athena 集成模板 + 跑 crawler），
    # 并写入完整 READY 记录（含 athena_database/athena_table/分区标记）。不盲写、不猜库表名，
    # 任意客户环境通用。
    if [ -n "$CUR_FINALIZER_FN_ARN" ] && [ -n "$CDK_ACCOUNT" ]; then
      FINALIZER_PAYLOAD=$(printf '{"account_id":"%s","bucket":"%s","report_name":"%s","prefix":"%s","region":"%s"}' \
        "$CDK_ACCOUNT" "$CUR_BUCKET" "$CUR_REPORT_NAME" "$CUR_PREFIX" "$DEPLOY_REGION")
      echo "  $(t "→ 同步调用 CUR finalizer 发现/建 Athena 表（既有表秒回；需建 crawler 可能等几分钟）…" "→ Synchronously invoking the CUR finalizer to discover/create the Athena table (instant if it exists; may take minutes if a crawler is needed)…")"
      if aws lambda invoke --function-name "$CUR_FINALIZER_FN_ARN" --region "$DEPLOY_REGION" \
           --cli-read-timeout 900 --cli-connect-timeout 60 \
           --cli-binary-format raw-in-base64-out --payload "$FINALIZER_PAYLOAD" \
           /tmp/notiops-cur-finalizer-out.json >/dev/null 2>&1; then
        echo "    $(t "finalizer 结果: " "finalizer result: ")$(cat /tmp/notiops-cur-finalizer-out.json 2>/dev/null)"
      else
        echo "    $(t "⚠ finalizer 调用失败（可稍后重跑 setup.sh 收尾）" "⚠ finalizer invocation failed (you can re-run setup.sh later to finish)")"
      fi
      rm -f /tmp/notiops-cur-finalizer-out.json
    else
      echo "    $(t "⚠ 未取到 CUR finalizer 函数 ARN（检查 cdk-outputs.json 的 CurFinalizerFunctionArn），跳过" "⚠ Could not get the CUR finalizer function ARN (check CurFinalizerFunctionArn in cdk-outputs.json), skipping")"
    fi
  else
    CUR_BUCKET="notiops-cur-${CDK_ACCOUNT:-unknown}-${DEPLOY_REGION}"
    CUR_REPORT_NAME="notiops-cur-report"
    CUR_PREFIX="cur"
    echo "  $(t "→ 新建专用 S3 桶: " "→ Creating dedicated S3 bucket: ")$CUR_BUCKET"
    if aws s3api head-bucket --bucket "$CUR_BUCKET" --region "$DEPLOY_REGION" >/dev/null 2>&1; then
      echo "    $(t "(桶已存在，复用)" "(bucket already exists, reusing)")"
    else
      if [ "$DEPLOY_REGION" = "us-east-1" ]; then
        aws s3api create-bucket --bucket "$CUR_BUCKET" --region "$DEPLOY_REGION" >/dev/null
      else
        aws s3api create-bucket --bucket "$CUR_BUCKET" --region "$DEPLOY_REGION" \
          --create-bucket-configuration LocationConstraint="$DEPLOY_REGION" >/dev/null
      fi
      # CUR 交付要求桶策略允许 billingreports.amazonaws.com 写入（官方固定策略）。
      cat > /tmp/notiops-cur-bucket-policy.json <<EOF
{
  "Version": "2008-10-17",
  "Statement": [
    {"Sid": "AllowCURServiceGetAcl", "Effect": "Allow",
     "Principal": {"Service": "billingreports.amazonaws.com"},
     "Action": ["s3:GetBucketAcl", "s3:GetBucketPolicy"], "Resource": "arn:aws:s3:::$CUR_BUCKET",
     "Condition": {"StringEquals": {"aws:SourceAccount": "$CDK_ACCOUNT"}, "StringLike": {"aws:SourceArn": "arn:aws:cur:us-east-1:$CDK_ACCOUNT:definition/*"}}},
    {"Sid": "AllowCURServicePutObject", "Effect": "Allow",
     "Principal": {"Service": "billingreports.amazonaws.com"},
     "Action": "s3:PutObject", "Resource": "arn:aws:s3:::$CUR_BUCKET/*",
     "Condition": {"StringEquals": {"aws:SourceAccount": "$CDK_ACCOUNT"}, "StringLike": {"aws:SourceArn": "arn:aws:cur:us-east-1:$CDK_ACCOUNT:definition/*"}}}
  ]
}
EOF
      aws s3api put-bucket-policy --bucket "$CUR_BUCKET" --policy file:///tmp/notiops-cur-bucket-policy.json >/dev/null
      rm -f /tmp/notiops-cur-bucket-policy.json
      # 该桶由 boto3 直建（不经 CDK），手动补上与 CDK 资源一致的项目标签。
      aws s3api put-bucket-tagging --bucket "$CUR_BUCKET" --region "$DEPLOY_REGION" \
        --tagging 'TagSet=[{Key=auto-delete,Value=no},{Key=project,Value=notiops}]' >/dev/null 2>&1 || true
    fi

    echo "  $(t "→ 创建 CUR ReportDefinition: " "→ Creating CUR ReportDefinition: ")$CUR_REPORT_NAME$(t "（Hourly + Resource IDs + Athena/Parquet）" " (Hourly + Resource IDs + Athena/Parquet)")"
    # cur:PutReportDefinition 仅支持 us-east-1 endpoint（CUR 是全局服务，API 端点固定）。
    if aws cur put-report-definition --region us-east-1 --report-definition "{
      \"ReportName\": \"$CUR_REPORT_NAME\",
      \"TimeUnit\": \"HOURLY\",
      \"Format\": \"Parquet\",
      \"Compression\": \"Parquet\",
      \"AdditionalSchemaElements\": [\"RESOURCES\"],
      \"S3Bucket\": \"$CUR_BUCKET\",
      \"S3Prefix\": \"$CUR_PREFIX\",
      \"S3Region\": \"$DEPLOY_REGION\",
      \"AdditionalArtifacts\": [\"ATHENA\"],
      \"RefreshClosedReports\": true,
      \"ReportVersioning\": \"OVERWRITE_REPORT\"
    }" >/dev/null 2>/tmp/notiops-cur-create-err.log; then
      echo "  $(t "✓ CUR 报告已创建，AWS 需要最长 24 小时首次交付" "✓ CUR report created; AWS takes up to 24h for first delivery")"
    else
      echo "  $(t "⚠ CUR 报告创建失败（可能已存在同名报告，或权限不足），详情：" "⚠ CUR report creation failed (a report with the same name may exist, or insufficient permissions); details:")"
      cat /tmp/notiops-cur-create-err.log 2>/dev/null | head -5
      CUR_REPORT_NAME=""  # 失败则不写 DDB / 不调度 finalizer
    fi
    rm -f /tmp/notiops-cur-create-err.log

    if [ -n "$CUR_REPORT_NAME" ] && [ -n "$CDK_ACCOUNT" ]; then
      NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
      aws dynamodb put-item --table-name notiops-config --region "$DEPLOY_REGION" \
        --item "{\"PK\":{\"S\":\"cur-athena-status#$CDK_ACCOUNT\"},\"SK\":{\"S\":\"STATUS\"},\"status\":{\"S\":\"PENDING\"},\"bucket\":{\"S\":\"$CUR_BUCKET\"},\"report_name\":{\"S\":\"$CUR_REPORT_NAME\"},\"region\":{\"S\":\"$DEPLOY_REGION\"},\"created_at\":{\"S\":\"$NOW_ISO\"}}" \
        >/dev/null 2>&1 || true

      # 调度 T+25h 一次性 EventBridge Scheduler → lambda6_cur_finalizer
      if [ -n "$CUR_FINALIZER_FN_ARN" ] && [ -n "$CUR_FINALIZER_SCHEDULER_ROLE_ARN" ]; then
        SCHEDULE_AT=$(date -u -v+25H +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || date -u -d "+25 hours" +"%Y-%m-%dT%H:%M:%S")
        SCHEDULE_NAME="notiops-cur-finalizer-${CDK_ACCOUNT}"
        aws scheduler create-schedule --region "$DEPLOY_REGION" \
          --name "$SCHEDULE_NAME" \
          --schedule-expression "at($SCHEDULE_AT)" \
          --flexible-time-window "{\"Mode\":\"OFF\"}" \
          --target "{\"Arn\":\"$CUR_FINALIZER_FN_ARN\",\"RoleArn\":\"$CUR_FINALIZER_SCHEDULER_ROLE_ARN\",\"Input\":\"{\\\"account_id\\\":\\\"$CDK_ACCOUNT\\\",\\\"bucket\\\":\\\"$CUR_BUCKET\\\",\\\"report_name\\\":\\\"$CUR_REPORT_NAME\\\",\\\"prefix\\\":\\\"$CUR_PREFIX\\\",\\\"region\\\":\\\"$DEPLOY_REGION\\\"}\"}" \
          --action-after-completion "DELETE" \
          >/dev/null 2>&1 && \
          echo "  $(t "✓ 已调度：" "✓ Scheduled: ")$SCHEDULE_AT$(t " UTC 自动检测并部署 Athena 集成（一次性，完成后自动清理）" " UTC to auto-detect and deploy the Athena integration (one-time, self-cleaning)")" || \
          echo "  $(t "⚠ EventBridge Scheduler 调度失败（可能缺少 scheduler:CreateSchedule 权限），需手动创建或重跑本脚本" "⚠ EventBridge Scheduler scheduling failed (may lack scheduler:CreateSchedule permission); create manually or re-run this script")"
      else
        echo "  $(t "⚠ 未拿到 CurFinalizer Lambda/Role 输出，跳过自动调度（CDK 输出缺失，检查 notiops-backend-stack.ts 是否已包含 Lambda6）" "⚠ CurFinalizer Lambda/Role outputs not found, skipping auto-scheduling (missing CDK outputs; check that notiops-backend-stack.ts includes Lambda6)")"
      fi
      echo "  $(t "ℹ FinOps 仪表盘在数据就绪前会显示「数据初始化中」占位卡片" "ℹ The FinOps dashboard shows a \"initializing data\" placeholder card until data is ready")"
    fi
  fi
fi

# ─── Athena FinOps 保存查询 + workgroup 输出位置（CUR 就绪后自动配好，用户零手动）───
# 读 DDB 里 lambda6/复用写入的【真实】Athena 库/表名（动态发现，不 hardcode），若 READY 则
# 同步调用 lambda6_cur_finalizer 的 provision-only 模式，幂等下发 6 条 FinOps 保存查询
# （Cost Deep Dive 后端）+ 设 primary workgroup 结果输出位置。查询定义收敛在
# lambda6_cur_finalizer/athena_saved_queries.py（单一事实来源，避免 shell / Lambda 两份 SQL 漂移）。
# 历史坑：这些查询原来在此内联 shell 创建，但全新部署时 CUR 首次交付要 ~24h、跑到这里还是
# PENDING → 整块跳过 → 一条都没建；T+25h 的 finalizer 只翻 READY 不建查询 → Cost Deep Dive 永远
# 报 no_named_queries。现在 finalizer 翻 READY 的同一时刻就自动下发，此处仅作幂等兜底/更新。
if [ -n "$CDK_ACCOUNT" ] && command -v jq >/dev/null 2>&1; then
  CUR_STATUS_JSON=$(aws dynamodb get-item --table-name notiops-config --region "$DEPLOY_REGION" \
    --key "{\"PK\":{\"S\":\"cur-athena-status#$CDK_ACCOUNT\"},\"SK\":{\"S\":\"STATUS\"}}" \
    --query "Item" --output json 2>/dev/null || echo "")
  ATHENA_DB=$(echo "$CUR_STATUS_JSON" | jq -r '.athena_database.S // empty' 2>/dev/null)
  ATHENA_TABLE=$(echo "$CUR_STATUS_JSON" | jq -r '.athena_table.S // empty' 2>/dev/null)
  CUR_STATUS_VAL=$(echo "$CUR_STATUS_JSON" | jq -r '.status.S // empty' 2>/dev/null)
  if [ "$CUR_STATUS_VAL" = "READY" ] && [ -n "$ATHENA_DB" ] && [ -n "$ATHENA_TABLE" ]; then
    echo "$(t "── Athena FinOps 保存查询（库: " "── Athena FinOps Saved Queries (db: ")$ATHENA_DB$(t " / 表: " " / table: ")$ATHENA_TABLE)──"
    if [ -n "$CUR_FINALIZER_FN_ARN" ]; then
      PROVISION_PAYLOAD=$(printf '{"mode":"provision_saved_queries","region":"%s","database":"%s","table":"%s"}' \
        "$DEPLOY_REGION" "$ATHENA_DB" "$ATHENA_TABLE")
      echo "  $(t "→ 同步调用 finalizer 幂等下发 FinOps 保存查询（Cost Deep Dive 后端）…" "→ Invoking finalizer to idempotently provision FinOps saved queries (Cost Deep Dive backend)…")"
      if aws lambda invoke --function-name "$CUR_FINALIZER_FN_ARN" --region "$DEPLOY_REGION" \
           --cli-read-timeout 120 --cli-connect-timeout 60 \
           --cli-binary-format raw-in-base64-out --payload "$PROVISION_PAYLOAD" \
           /tmp/notiops-nq-out.json >/dev/null 2>&1; then
        echo "  $(t "✓ 保存查询结果: " "✓ Saved-query result: ")$(cat /tmp/notiops-nq-out.json 2>/dev/null)"
      else
        echo "  $(t "⚠ 保存查询下发失败（可稍后重跑 setup.sh；检查 lambda6 的 athena 权限）" "⚠ Saved-query provisioning failed (re-run setup.sh later; check lambda6 athena permissions)")"
      fi
      rm -f /tmp/notiops-nq-out.json
    else
      echo "  $(t "⚠ 未取到 CUR finalizer 函数 ARN，跳过保存查询下发" "⚠ CUR finalizer function ARN not found, skipping saved-query provisioning")"
    fi
  else
    echo "$(t "── Athena FinOps 保存查询：CUR 尚未 READY（新建 CUR 需 ~24h 首次交付），就绪后重跑 setup.sh 会自动创建 ──" "── Athena FinOps saved queries: CUR not READY yet (new CUR needs ~24h for first delivery); re-run setup.sh once ready to auto-create ──")"
  fi
fi

# ─── 首次部署时创建 admin 用户 ───
ADMIN_USER_EXISTS=$(aws cognito-idp list-users \
  --user-pool-id "$USER_POOL_ID" --region "$DEPLOY_REGION" \
  --filter "username = \"admin\"" \
  --query "Users[0].Username" --output text 2>/dev/null || echo "None")

ADMIN_PASSWORD_MSG=""
if [ "$ADMIN_USER_EXISTS" = "None" ] || [ -z "$ADMIN_USER_EXISTS" ]; then
  INIT_PASSWORD="Aa1$(openssl rand -hex 5)!"
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username admin \
    --temporary-password "$INIT_PASSWORD" \
    --message-action SUPPRESS \
    --region "$DEPLOY_REGION" >/dev/null
  ADMIN_PASSWORD_MSG="$INIT_PASSWORD  (临时密码, 首次登录需修改)"
else
  ADMIN_PASSWORD_MSG="(用户已存在, 密码未变更)"
fi

# 把 admin 用户加入 admin group（幂等）。Web Chat 授权体系据此给予全部权限：
# authz.effective() 对"无 userperm 记录 + 属 cognito admin group"的用户兜底为 "*"。
# 预置角色 role:finops/
# support/viewer 由 BFF 内存 PRESET_ROLES 提供并在 Admin 列表中合并，无需 DDB seed。
aws cognito-idp admin-add-user-to-group \
  --user-pool-id "$USER_POOL_ID" \
  --username admin \
  --group-name admin \
  --region "$DEPLOY_REGION" >/dev/null 2>&1 || true

echo ""
echo "============================================"
echo "  $(t "部署完成！" "Deployment complete!")"
echo "============================================"
echo ""
echo "$(t "部署 Region:      " "Deploy Region:    ")$DEPLOY_REGION"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  $(t "👉 从这里开始 —— 打开 Web Chat（唯一主入口）" "👉 START HERE — open Web Chat (the single main entry)")"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🌐 Web Chat: $CHAT_URL"
if [ "$CHAT_URL" = "N/A" ]; then
  echo "   $(t "⚠ 未拿到 Web Chat 地址 —— 可能 WebChatStack 部署失败/被跳过，检查上面的 CDK 部署日志" "⚠ Web Chat URL not found — WebChatStack may have failed/been skipped; check the CDK deploy log above")"
fi
echo ""
echo "  $(t "👤 登录:  admin / " "👤 Login:  admin / ")$ADMIN_PASSWORD_MSG"
echo ""
echo "  $(t "Web Chat 就是你和终端用户的全部入口 —— 聊天 / 故障调查 / FinOps 成本 /" "Web Chat is the single entry for you and your end users — chat / investigation / cost /")"
echo "  $(t "Support 案例 / 通知，都在左侧菜单。所有管理配置也从这里深入,无需记第二个地址:" "Support cases / notifications — all in the left menu. All admin config is reached from here too, no second URL to remember:")"
echo "    $(t "· 阈值 / 目标账户 / 巡检报告 / Skills 管理" "· Thresholds / target accounts / inspection reports / Skills management")"
echo "      $(t "→ Web Chat 左侧「更多 → 巡检 & 报告」会打开控制台配置页(同一 admin 账号)" "→ Web Chat left menu \"More → Inspections & Reports\" opens the console config page (same admin account)")"
echo ""
echo "$(t "── 其它地址(排查 / 高级用途,平时不用管)──" "── Other URLs (troubleshooting / advanced, usually ignore) ──")"
echo "  $(t "· 巡检控制台直达(= 上面「巡检 & 报告」打开的页面): " "· Console direct link (= the page opened by \"Inspections & Reports\"): ")$CLOUDFRONT_URL"
echo "  $(t "· Web Chat BFF Function URL(排查用):              " "· Web Chat BFF Function URL (troubleshooting):   ")$CHAT_BFF_URL"
echo "  $(t "· API 地址:                                        " "· API endpoint:                                  ")$API_URL"
echo "  · IdleDetectionRole:  $IDLE_ROLE_ARN"
echo "  · LambdaExecutionRole: $LAMBDA_ROLE_ARN  $(t "← 跨账户信任策略填这个" "← use this in cross-account trust policy")"
echo ""
if [ -n "$ENABLED_PLATFORMS" ]; then
  echo "$(t "── IM Bot(ECS 长连接,无需 Webhook）── 本次启用: " "── IM Bot (ECS long-connection, no webhook) ── enabled: ")$ENABLED_PLATFORMS"
  echo "$(t "飞书 Secret:       " "Feishu Secret:     ")$FEISHU_SECRET"
  echo "Slack Bot Token:   $SLACK_BOT_TOKEN_SECRET"
  echo "Slack App Token:   $SLACK_APP_TOKEN_SECRET"
else
  echo "$(t "── IM Bot ── 本次未部署（web 端已就绪）" "── IM Bot ── not deployed this run (web UI is ready)")"
  echo "  $(t "以后想启用：重跑 ./setup.sh 选 1) 飞书 或 2) Slack 即可，无需重建其余资源。" "To enable later: re-run ./setup.sh and pick 1) Feishu or 2) Slack — no need to rebuild anything else.")"
fi
echo "Bedrock API Key:   $BEDROCK_API_KEY_SECRET"
echo "Data Bucket:       $DATA_BUCKET"
echo ""
echo "$(t "下一步（全部从 Web Chat 进,不用记别的地址）: " "Next steps (all from Web Chat, no other URL needed):")"
echo ""
echo "  $(t "1️⃣  打开 Web Chat(" "1️⃣  Open Web Chat (")$CHAT_URL$(t "),用 admin / 上述密码登录(首次登录需改密码)。" "), log in as admin with the password above (change it on first login).")"
echo ""
echo "  $(t "✅ 登录后即可直接用 —— 问答 / 故障调查 / 成本分析 / Support 案例," "✅ Ready to use right after login — Q&A / investigation / cost analysis / Support cases,")"
echo "     $(t "默认操作【部署账号】本身,无需任何额外配置。左侧菜单能看到" "operating on the [deploy account] itself by default, no extra config. The left menu shows")"
echo "     $(t "通知 / 调查 / FinOps / 案例 / Skills,以及「更多」里的 安全 / 巡检&报告 / 定制。" "Notifications / Investigation / Cost / Cases / Skills, plus Security / Inspections & Reports / Customize under \"More\".")"
echo ""
echo "  $(t "2️⃣  (可选)填 Bedrock API Key —— 跨账号调模型才需要:" "2️⃣  (Optional) Set a Bedrock API Key — only needed for cross-account model calls:")"
echo "      $(t "Web Chat 左侧「更多 → 巡检 & 报告」打开控制台 →「设置 → AI 配置」填入并保存。" "Open the console via Web Chat \"More → Inspections & Reports\" → \"Settings → AI Config\", enter and save.")"
echo "      $(t "留空则 Agent 用本地 AWS 凭证调当前账号 Bedrock 模型,不影响使用。" "If left empty, the Agent uses local AWS credentials to call the current account\x27s Bedrock models — works fine.")"
echo ""
if [ -n "$ENABLED_PLATFORMS" ]; then
  echo "  ┌──────────────────────────────────────────────────────────────────┐"
  echo "  $(t "  │ ⚠️  必做:填写 IM 机器人凭证(不填则 bot 完全无反应!)          │" "  │ ⚠️  REQUIRED: fill IM bot credentials (bot won't respond until you do!) │")"
  echo "  └──────────────────────────────────────────────────────────────────┘"
  echo "  $(t "  本次已部署 IM: " "  IM deployed this run: ")$ENABLED_PLATFORMS"
  echo "  $(t "  刚创建的凭证 Secret 是空的,必须填入你的机器人凭证,bot 才能连接。" "  The credential Secrets just created are EMPTY — you must fill in your bot credentials before the bot can connect.")"
  echo ""
  echo "  $(t "  【填法一】Web Chat 左侧「更多 → 巡检 & 报告」打开控制台 →「设置 → 通知设置」填入。" "  [Option A] Web Chat left menu \"More → Inspections & Reports\" → console → \"Settings → Notifications\".")"
  echo "  $(t "  【填法二】直接更新 Secrets Manager(下方 Secret 名),然后重启对应 ECS 服务。" "  [Option B] Update Secrets Manager directly (secret names below), then restart the matching ECS service.")"
  echo ""
  case "$ENABLED_PLATFORMS" in
    *feishu*)
      echo "  $(t "  · 飞书 —— Secret: " "  · Feishu —— Secret: ")notiops/im-bot-feishu"
      echo "  $(t "      需填字段: app_id / app_secret(从飞书开放平台「凭证与基础信息」获取)。" "      Fields: app_id / app_secret (from Feishu Open Platform \"Credentials & Basic Info\").")"
      echo "  $(t "      飞书开放平台 → 事件订阅 → 选「长连接」模式(非 Webhook)。" "      Feishu Open Platform → Event Subscription → choose \"Long Connection\" mode (NOT Webhook).")" ;;
  esac
  case "$ENABLED_PLATFORMS" in
    *slack*)
      echo "  $(t "  · Slack —— Secret: " "  · Slack —— Secret: ")notiops/slack-bot-token $(t "和" "and") notiops/slack-app-token"
      echo "  $(t "      需填: Bot Token(xoxb-)和 App Token(xapp-);Slack 用 Socket Mode,无需公网 webhook。" "      Fill: Bot Token (xoxb-) and App Token (xapp-); Slack uses Socket Mode, no public webhook needed.")" ;;
  esac
  echo ""
  echo "  $(t "  填完凭证后,强制重启 bot 加载新凭证(或等下次部署):" "  After filling credentials, force-restart the bot to load them (or wait for next deploy):")"
  echo "      aws ecs update-service --cluster <BotStack-cluster> --service <service> --force-new-deployment --region $DEPLOY_REGION"
else
  echo "  $(t "3️⃣  (可选)IM 机器人 —— 本次未部署。" "3️⃣  (Optional) IM bots — not deployed this run.")"
  echo "      $(t "以后想加飞书/Slack:重跑 ./setup.sh 选对应平台即可,无需重建其余资源。" "To add Feishu/Slack later: re-run ./setup.sh and pick the platform — no need to rebuild anything else.")"
fi
echo ""
echo "  $(t "4️⃣  (可选)开启闲置资源检测 + 成本自动巡检 —— 不配也不影响 Web Chat:" "4️⃣  (Optional) Enable idle-resource detection + auto cost inspection — does not affect Web Chat:")"
echo "      $(t "Web Chat 左侧「更多 → 巡检 & 报告」打开控制台 →「目标账户管理」→ 添加要巡检的账户:" "Open the console (Web Chat \"More → Inspections & Reports\") → \"Target Accounts\" → add accounts to inspect:")"
echo "        $(t "- 账户 ID: 当前 AWS 账户 ID(或其他要扫描的账户)" "- Account ID: the current AWS account (or any other account to scan)")"
echo "        - Role ARN: $IDLE_ROLE_ARN"
echo "        $(t "- Region:   要扫描的区域" "- Region:   the region to scan")"
echo "      $(t "配好后系统每天 00:00 UTC 自动扫描。" "Once configured, the system scans automatically daily at 00:00 UTC.")"
echo ""
echo "  $(t "ℹ️  FinOps 的 DevOps Agent 调用成本卡需 CUR/Athena 数据源,首次部署后约 24h" "ℹ️  The FinOps DevOps Agent cost card needs the CUR/Athena data source; ~24h after first deploy")"
echo "      $(t "才有数据(占位卡片会先显示),其余 FinOps/Budget 数据即时可用。" "before data appears (a placeholder card shows first). All other FinOps/Budget data is available immediately.")"

echo ""
echo "  $(t "── ⚠️ Agent Space 重要提示 ──" "── ⚠️ Agent Space Important Note ──")"
echo "  $(t "CDK 在你账号下新建了一个 Agent Space:" "CDK created a new Agent Space in your account:")"
echo "    notiops-devops-${CDK_ACCOUNT:-<account>}"
echo "  $(t "bot 派发调查只用这一个 space, 与你账号下其他已有 space 完全隔离." "The bot dispatches investigations only to this space, fully isolated from any other spaces in your account.")"
echo ""
echo "  $(t "如果你之前在别的 Agent Space 配过:" "If you previously configured, in another Agent Space:")"
echo "    $(t "• 第三方 MCP server (Grafana / Datadog / PagerDuty / Slack / Jira / GitHub)" "• Third-party MCP servers (Grafana / Datadog / PagerDuty / Slack / Jira / GitHub)")"
echo "    $(t "• 自定义 Skill / Playbook" "• Custom Skills / Playbooks")"
echo "    $(t "• 扩展 IAM 数据源 (DB ReadOnly / S3 ReadOnly 等)" "• Extended IAM data sources (DB ReadOnly / S3 ReadOnly, etc.)")"
echo "    $(t "• 跨 region / 跨账号资源访问" "• Cross-region / cross-account resource access")"
echo "  $(t "这些配置 不会自动继承, 需要在新 space 里手动重配." "these are NOT inherited automatically — reconfigure them in the new space manually.")"
echo ""
echo "  $(t "详见 docs/DEPLOYMENT.md §5.3 部署后必读 — Agent Space 重新配置." "See docs/DEPLOYMENT.md §5.3 Post-deploy must-read — Agent Space reconfiguration.")"

echo ""
echo "  $(t "── ⚠️ 必做一步:在 DevOps Agent 控制台注册 Web 应用域名 ──" "── ⚠️ Required step: register the web app domain in the DevOps Agent console ──")"
echo "  $(t "否则在 Web Chat 里点『发起调查/连接调查』会报错:" "Otherwise clicking 'investigate / connect investigation' in Web Chat will error with:")"
echo "    \"Invalid or unregistered domain\""
echo "  $(t "步骤:进 DevOps Agent 控制台 → 你的 space(notiops-devops-${CDK_ACCOUNT:-<account>}) → Configure web app" "Steps: open the DevOps Agent console → your space (notiops-devops-${CDK_ACCOUNT:-<account>}) → Configure web app")"
echo "        https://console.aws.amazon.com/aidevops/home#/agent-spaces"
echo "  $(t "把下面这个 Web Chat 域名登记为允许的 web app 域名(注册后即可正常发起调查):" "and register the Web Chat domain below as an allowed web app domain (investigations work once registered):")"
echo "    ${CHAT_URL}"

echo ""
echo "  $(t "── DevOps Agent 多账户集成 ──" "── DevOps Agent Multi-Account Integration ──")"
DEVOPS_EVENT_BUS_ARN=$(jq -r ".[\"$STACK_NAME\"].DevOpsAgentEventBusArn" cdk-outputs.json 2>/dev/null || echo "N/A")
DEVOPS_WHITELIST=$(jq -r ".[\"$STACK_NAME\"].DevOpsAgentBusinessAccountsWhitelist" cdk-outputs.json 2>/dev/null || echo "N/A")
ONBOARDING_BUCKET=$(jq -r ".[\"$STACK_NAME\"].DataBucketName" cdk-outputs.json 2>/dev/null || echo "N/A")
echo "  Custom Event Bus ARN:            $DEVOPS_EVENT_BUS_ARN"
echo "  $(t "当前白名单业务账户:              " "Current allowlisted business accounts: ")$DEVOPS_WHITELIST"
echo "  $(t "Onboarding 模板 S3 Bucket:       " "Onboarding template S3 Bucket:         ")$ONBOARDING_BUCKET"
echo ""
echo "  $(t "新增业务账户流程: " "To onboard a new business account:")"
echo "    $(t "1. 本脚本重跑或执行: " "1. Re-run this script, or: ")cd infra && npx cdk deploy -c devopsAgentBusinessAccounts=\"$(t "<新白名单>" "<new-allowlist>")\""
echo "    $(t "2. 在 Dashboard「DevOps Agent 账户配置」页生成 Launch Stack URL 发给客户" "2. In the Dashboard \"DevOps Agent Account Config\" page, generate a Launch Stack URL and send it to the customer")"
echo "    $(t "3. 客户部署 CFN → 回填 OnboardingPayload → 测试连接 → 启用" "3. Customer deploys the CFN → fills back the OnboardingPayload → tests connection → enables")"
echo "  $(t "详见 docs/USER_GUIDE.md 的 DevOps Agent 接入章节" "See the DevOps Agent onboarding section in docs/USER_GUIDE.md")"

# ─── Organizations 模式: StackSets 批量下发成员账号资源 ───
# 一个 StackSet 同时完成: 只读采集角色 + DevOps Agent 事件转发 + (可选)PHD 事件转发。
# auto-deployment 开启后, 新账号加入目标 OU 会自动完成接入(仍需在控制台
# 「账户接入」页登记 regions 才会被采集)。
if [ "$ORG_MODE" = true ]; then
  echo ""
  echo "$(t "─── Organizations 模式: 成员账号资源下发(StackSets) ───" "─── Organizations Mode: Member-Account Rollout (StackSets) ───")"
  MEMBER_TEMPLATE="$PROJECT_ROOT/infra/member-account-onboarding.yaml"
  STACKSET_NAME="notiops-member-onboarding"
  MEMBER_BUS_ARN="arn:aws:events:${DEPLOY_REGION}:${CDK_ACCOUNT}:event-bus/notiops-devops-events"
  MEMBER_PHD_ARN=""
  if [ "$ENABLE_PHD" != "false" ]; then
    MEMBER_PHD_ARN="arn:aws:sns:${DEPLOY_REGION}:${CDK_ACCOUNT}:phd-events"
  fi

  # 1. 开启 StackSets 与 Organizations 的可信访问(幂等; 仅管理账号可执行,
  #    委派管理员场景该调用会失败——但可信访问应已在管理账号开启, 忽略即可)
  aws organizations enable-aws-service-access \
    --service-principal member.org.stacksets.cloudformation.amazonaws.com 2>/dev/null || true

  # 2. 创建或更新 StackSet(SERVICE_MANAGED + auto-deployment)
  if aws cloudformation describe-stack-set --stack-set-name "$STACKSET_NAME" \
       --region "$DEPLOY_REGION" >/dev/null 2>&1; then
    echo "  $(t "检测到已有 StackSet, 更新模板/参数..." "Existing StackSet detected, updating template/parameters...")"
    aws cloudformation update-stack-set \
      --stack-set-name "$STACKSET_NAME" \
      --template-body "file://$MEMBER_TEMPLATE" \
      --parameters "ParameterKey=SystemAccountId,ParameterValue=$CDK_ACCOUNT" \
                   "ParameterKey=DevOpsEventBusArn,ParameterValue=$MEMBER_BUS_ARN" \
                   "ParameterKey=PhdSnsTopicArn,ParameterValue=$MEMBER_PHD_ARN" \
                   "ParameterKey=OrganizationId,ParameterValue=$ORG_ID" \
      --capabilities CAPABILITY_NAMED_IAM \
      --region "$DEPLOY_REGION" >/dev/null \
      && echo "  $(t "✓ StackSet 已更新(既有实例将随 operation 滚动更新)" "✓ StackSet updated (existing instances roll out with the operation)")" \
      || echo "  $(t "⚠ StackSet 更新失败(可能有进行中的 operation, 稍后重跑 setup.sh 即可)" "⚠ StackSet update failed (an operation may be in progress; just re-run setup.sh later)")"
  else
    echo "  $(t "创建 StackSet: " "Creating StackSet: ")$STACKSET_NAME"
    aws cloudformation create-stack-set \
      --stack-set-name "$STACKSET_NAME" \
      --description "NotiOps member account onboarding (readonly role + event forwarding)" \
      --template-body "file://$MEMBER_TEMPLATE" \
      --parameters "ParameterKey=SystemAccountId,ParameterValue=$CDK_ACCOUNT" \
                   "ParameterKey=DevOpsEventBusArn,ParameterValue=$MEMBER_BUS_ARN" \
                   "ParameterKey=PhdSnsTopicArn,ParameterValue=$MEMBER_PHD_ARN" \
                   "ParameterKey=OrganizationId,ParameterValue=$ORG_ID" \
      --capabilities CAPABILITY_NAMED_IAM \
      --permission-model SERVICE_MANAGED \
      --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false \
      --region "$DEPLOY_REGION" >/dev/null
    echo "  $(t "✓ StackSet 已创建" "✓ StackSet created")"
  fi

  # 2b. DevOps Agent 关联 StackSet(Phase 2)：成员账号独立 Agent Space + Trigger Role。
  #     不开 auto-deployment、不批量下发 —— space 有独立成本/配置，按账号在控制台
  #     「账户接入」页第二步一键关联时才创建实例。
  DA_TEMPLATE="$PROJECT_ROOT/infra/member-devops-agent.yaml"
  DA_STACKSET_NAME="notiops-member-devops-agent"
  if aws cloudformation describe-stack-set --stack-set-name "$DA_STACKSET_NAME" \
       --region "$DEPLOY_REGION" >/dev/null 2>&1; then
    aws cloudformation update-stack-set \
      --stack-set-name "$DA_STACKSET_NAME" \
      --template-body "file://$DA_TEMPLATE" \
      --parameters "ParameterKey=SystemAccountId,ParameterValue=$CDK_ACCOUNT" \
                   "ParameterKey=OrganizationId,ParameterValue=$ORG_ID" \
      --capabilities CAPABILITY_NAMED_IAM \
      --region "$DEPLOY_REGION" >/dev/null \
      && echo "  $(t "✓ DevOps Agent StackSet 已更新" "✓ DevOps Agent StackSet updated")" \
      || echo "  $(t "⚠ DevOps Agent StackSet 更新失败(可能有进行中的 operation)" "⚠ DevOps Agent StackSet update failed (an operation may be in progress)")"
  else
    aws cloudformation create-stack-set \
      --stack-set-name "$DA_STACKSET_NAME" \
      --description "NotiOps member DevOps Agent onboarding (agent space + trigger role)" \
      --template-body "file://$DA_TEMPLATE" \
      --parameters "ParameterKey=SystemAccountId,ParameterValue=$CDK_ACCOUNT" \
                   "ParameterKey=OrganizationId,ParameterValue=$ORG_ID" \
      --capabilities CAPABILITY_NAMED_IAM \
      --permission-model SERVICE_MANAGED \
      --auto-deployment Enabled=false \
      --region "$DEPLOY_REGION" >/dev/null
    echo "  $(t "✓ DevOps Agent StackSet 已创建(按账号在控制台第二步一键关联)" "✓ DevOps Agent StackSet created (associate per-account in step 2 of the console)")"
  fi

  # 3. 选择部署目标 OU(留空 = 跳过批量下发, 之后在控制台「账户接入」页逐账号接入)
  ORG_TARGET_OUS="${ORG_TARGET_OUS:-}"
  if [ -z "$ORG_TARGET_OUS" ]; then
    echo ""
    echo "  $(t "输入要批量接入的 OU ID(如 ou-abcd-12345678; 根 r-abcd = 全组织; 逗号分隔)。" "Enter OU IDs to onboard in bulk (e.g. ou-abcd-12345678; root r-abcd = entire org; comma-separated).")"
    echo "  $(t "留空跳过 —— 之后可在控制台「账户接入」页逐账号一键接入。" "Leave empty to skip — you can onboard accounts one-by-one later on the console \"Account Onboarding\" page.")"
    read -p "  Target OU IDs: " ORG_TARGET_OUS
  fi
  if [ -n "$ORG_TARGET_OUS" ]; then
    ORG_TARGET_OUS=$(echo "$ORG_TARGET_OUS" | tr ';' ',' | tr ' ' ',' | tr -s ',' | sed 's/^,//;s/,$//')
    echo "  $(t "下发 Stack Instances 到: " "Deploying Stack Instances to: ")$ORG_TARGET_OUS(region: $DEPLOY_REGION)"
    OU_JSON=$(echo "$ORG_TARGET_OUS" | awk -F',' '{printf "["; for(i=1;i<=NF;i++){printf "%s\"%s\"", (i>1?",":""), $i}; printf "]"}')
    aws cloudformation create-stack-instances \
      --stack-set-name "$STACKSET_NAME" \
      --deployment-targets "{\"OrganizationalUnitIds\":$OU_JSON}" \
      --regions "$DEPLOY_REGION" \
      --operation-preferences FailureTolerancePercentage=100,MaxConcurrentPercentage=100 \
      --region "$DEPLOY_REGION" >/dev/null \
      && echo "  $(t "✓ 已提交(异步执行, 可在 CloudFormation StackSets 控制台查看进度)" "✓ Submitted (runs asynchronously; track progress in the CloudFormation StackSets console)")" \
      || echo "  $(t "⚠ 提交失败(常见原因: 目标 OU 已有实例或有进行中的 operation)" "⚠ Submission failed (common causes: target OU already has instances, or an operation is in progress)")"
    echo "  $(t "⚠ 注意: StackSet 只创建账号内资源;各账号仍需在控制台「账户接入」页" "⚠ Note: StackSet only creates in-account resources; each account still needs to be registered on the console \"Account Onboarding\" page")"
    echo "     $(t "登记(选择采集 region)后才会进入巡检/成本采集范围。" "(choosing the collection region) before it enters the inspection/cost-collection scope.")"
  else
    echo "  $(t "跳过批量下发。控制台「账户接入」页可逐账号一键接入。" "Skipping bulk rollout. Onboard accounts one-by-one on the console \"Account Onboarding\" page.")"
  fi

  # 4. (可选) Security Hub 组织聚合 —— 把部署账号设为 Security Hub 委派管理员并创建
  #    Finding Aggregator(ALL_REGIONS)。之后 Security tab 在部署账号一次 GetFindings
  #    即可看到全组织发现(优于逐账号 AssumeRole 扇出);逐账号 ?account= 视角仍可用于下钻。
  SH_ORG_AGG="${SH_ORG_AGG:-}"
  if [ -z "$SH_ORG_AGG" ]; then
    echo ""
    read -p "  $(t "启用 Security Hub 组织聚合(委派管理员=部署账号)? [y/N]: " "Enable Security Hub org aggregation (delegated admin = deploy account)? [y/N]: ")" SH_ORG_AGG
  fi
  case "$SH_ORG_AGG" in
    [yY]*)
      aws organizations enable-aws-service-access \
        --service-principal securityhub.amazonaws.com 2>/dev/null || true
      if aws securityhub enable-organization-admin-account \
           --admin-account-id "$CDK_ACCOUNT" --region "$DEPLOY_REGION" 2>/dev/null; then
        echo "  $(t "✓ 部署账号已设为 Security Hub 委派管理员" "✓ Deploy account set as Security Hub delegated administrator")"
      else
        echo "  $(t "⚠ 设置委派管理员未成功(可能已设置 / 缺权限 / SH 未开通), 跳过" "⚠ Could not set delegated administrator (may already be set / lacking permission / SH not enabled), skipping")"
      fi
      if aws securityhub create-finding-aggregator \
           --region-linking-mode ALL_REGIONS --region "$DEPLOY_REGION" >/dev/null 2>&1; then
        echo "  $(t "✓ Finding Aggregator 已创建(ALL_REGIONS)" "✓ Finding Aggregator created (ALL_REGIONS)")"
      else
        echo "  $(t "ℹ Finding Aggregator 已存在或创建失败, 跳过" "ℹ Finding Aggregator already exists or creation failed, skipping")"
      fi
      ;;
    *) echo "  $(t "跳过 Security Hub 组织聚合(Security tab 走逐账号 ?account= 视角)" "Skipping Security Hub org aggregation (the Security tab uses per-account ?account= views)")" ;;
  esac
fi

if [ "$ENABLE_PHD" != "false" ]; then
echo ""
echo "  $(t "── PHD 事件跨账号转发 ──" "── PHD Cross-Account Event Forwarding ──")"
echo "  PHD SNS Topic: $PHD_SNS_TOPIC"
if [ -n "$PHD_LINKED_ACCOUNTS" ]; then
echo "  $(t "跨账号监控:    " "Cross-account monitoring: ")$PHD_LINKED_ACCOUNTS"
fi
echo "  $(t "在 Linked Account 中部署 PHD 事件转发: " "Deploy PHD event forwarding in each Linked Account:")"
echo "    ./setup.sh --phd"
echo "  $(t "或指定 ARN 非交互部署: " "Or deploy non-interactively with an explicit ARN:")"
echo "    PHD_SNS_TOPIC_ARN=$PHD_SNS_TOPIC ./setup.sh --phd"
fi
echo ""
