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

# ─── uv：agent 部署的**硬前置**,必须在这里 fail fast ───
# `agentcore deploy` 打 Python CodeZip 时无条件调 `uv pip install`（@aws/agentcore 的
# dist/lib/packaging/python.js → ensureBinaryAvailable('uv')）。机器上没有 uv,那一步必失败。
#
# 为什么它值得一条独立的前置检查(而不是等 deploy_agent.sh 自己报错):
# 这条依赖过去只写在 agent-build/NotiOpsWebChat/README.md 里,客户不会读到;而失败的形态是
# **静默降级** —— agent 部署失败 → 没有 AGENT_RUNTIME_ARN → BFF 回退 echo,而 web 端照常
# 部署成功、脚本照常打印 Chat URL。客户看到的是"部署成功了,但一提问就回显我说的话"。
# 实测客户侧就是这么坏的(2026-08-26)。所以:装不上就在**第一分钟**拦住,而不是二十分钟后。
#
# 官方安装器把 uv 放在 $HOME/.local/bin(部分平台 ~/.cargo/bin),而非交互式 shell 常常
# 不在 PATH 里 —— 先捞一把再判定,避免"明明装了却说没装"。
if [ "${SKIP_AGENT:-false}" != "true" ] && [ -d "$(cd "$(dirname "$0")" && pwd)/agent-build/NotiOpsWebChat" ]; then
  if ! command -v uv >/dev/null 2>&1; then
    for _uv_dir in "$HOME/.local/bin" "$HOME/.cargo/bin"; do
      [ -x "$_uv_dir/uv" ] && { PATH="$_uv_dir:$PATH"; export PATH; break; }
    done
  fi
  if ! command -v uv >/dev/null 2>&1; then
    echo "$(t "错误: 需要安装 uv (Python 包管理器)" "Error: uv (the Python package manager) is required")"
    echo "$(t "  部署 agent runtime 时,agentcore CLI 用 uv 打 Python 依赖包;缺它会导致" "  The agentcore CLI uses uv to package the agent's Python dependencies; without it")"
    echo "$(t "  agent 部署失败,而 Web Chat 会退化成【只回显你说的话】。" "  the agent deployment fails and Web Chat degrades to ECHOING YOUR MESSAGE BACK.")"
    echo ""
    echo "$(t "  安装(macOS / Linux):" "  Install (macOS / Linux):")"
    echo "      curl -LsSf https://astral.sh/uv/install.sh | sh"
    echo "$(t "  或:" "  Or:")  brew install uv   |   pipx install uv   |   pip3 install uv"
    echo "$(t "  文档: " "  Docs: ")https://docs.astral.sh/uv/getting-started/installation/"
    echo ""
    echo "$(t "  装完新开一个终端(或 source ~/.bashrc / ~/.zshrc)让 uv 进 PATH,再重跑本脚本。" "  After installing, open a new shell (or source your rc file) so uv is on PATH, then re-run this script.")"
    echo "$(t "  （只想先部署 web 端、之后再补 agent:SKIP_AGENT=true ./setup.sh）" "  (To deploy only the web side for now and add the agent later: SKIP_AGENT=true ./setup.sh)")"
    exit 1
  fi
fi

# 容器构建工具:**已不再需要**(2026-09-03,IM 重构 M2)。
# 唯一需要 docker/finch 的地方是老 BotStack 那 5 处 `ContainerImage.fromAsset("../")`
# ——ECS 长连接容器。IM 现在走 Webhook + Lambda(ImStack),依赖打成普通 zip 层
# (scripts/build_im_layer.sh 用 pip --platform manylinux2014_x86_64,不用容器)。
# 所以这里不再探测、也不再有"选了 IM 就必须装 Docker"的硬闸门。
#
# ⚠️ 别顺手把 finch 支持加回来:若将来又引入 Docker 资产,同时要改
#   docs/DEPLOYMENT.md{,.en.md} 的前置条件表 + publish/README.public.{zh,en}.md,
#   否则客户按文档准备好环境、到跑的时候才炸(见「不许静默降级」)。

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

# 🔴 **没带 `--multi-account` 时，成员账号接入整条路是死的 —— 而脚本会正常结束。**
#
#    `MULTI_ACCOUNT_MODE` 默认 false（只有 CLI 传 `--multi-account` 才为真），
#    而下面整段 Organizations 检测挂在它上面 ⇒ `ORG_MODE=false` ⇒
#    两个 StackSet（notiops-member-onboarding / notiops-member-devops-agent）
#    压根不创建。
#
#    表现：`cdk deploy` 成功、看板能打开、Web Chat 能聊，**只有多账号那一整套
#    静默地不存在** —— 下面那段检测没跑 ⇒ ORG_FLAG 为空 ⇒ web-chat 栈的
#    organizationId 为空 ⇒ MEMBER_ONBOARDING_STACKSET_NAME 注入成空串 ⇒
#    跨账号查询一律 org_mode_disabled、LOCKED_ACCOUNT_ID 把一切钉在部署账号上。
#
# ⚠️ **不是「按钮还在、点了报 StackSetNotFound」**（这段注释 2026-09-04 原本
#    这么写，与代码不符）：BFF 的 `oneClickOnboardAvailable()`
#    （`bff/web-chat/member_accounts.mjs:57`）只看那个 env 有没有值，前端拿到
#    `oneClickOnboard: false` 后把一键接入整块**换成一段提示**
#    （`AdminPanel.tsx:2175`，文案 `admin.accounts.noOneClick`），逐账号的接入
#    按钮也一并不渲染（`:2305`）—— 所以没有可点的东西、也不会有那个报错。
#
#    真正的坏处正在于此：**没有任何东西在部署当时告诉你选错了**，而唯一的补救
#    是带 flag 重跑整个 setup.sh（~15 分钟）。一个静默少掉的能力比一个会报错的
#    按钮更难发现 —— 客户看到的是「文档里写的一键接入我这儿没有」。
#
#    而 README 把 `./setup.sh` 写成「一键部署（唯一入口）」。
#
# ⇒ 当前账号能管成员账号却没带 flag 时，**当场问**（不是打一行警告就往下走）。
#
#   为什么从「只警告」改成「问」（2026-09-04，实测踩中）：这段原本只 echo 三行
#   就继续部署。而它打印的位置在几十行 CDK/巡检/权限检查输出的**中间**，
#   一次真实部署里被直接刷过去了 —— 部署完打开管理页才发现一键接入那一块
#   压根没渲染出来，那时已经过了 15 分钟，只能整套重跑。
#   决定权仍在用户手里（默认 N = 保持单账号），所以「不自动开启」那条原则没破。
#
# 🔴 判据是**「能不能列出成员账号」**，不是「是不是管理账号」。
#    StackSets 委派管理员也能建 StackSet，按管理账号判会把这类部署漏掉 ——
#    而漏掉的表现和上面一样：多账号那一整套静默地不存在。
#    顺带只数 ACTIVE：SUSPENDED 账号接不进来，算进去会虚报。
if [ "$MULTI_ACCOUNT_MODE" != true ]; then
  _org_probe=$(aws organizations describe-organization \
    --query 'Organization.[Id,MasterAccountId]' --output text 2>/dev/null || echo "")
  if [ -n "$_org_probe" ]; then
    _org_id=$(echo "$_org_probe" | awk '{print $1}')
    _org_mgmt=$(echo "$_org_probe" | awk '{print $2}')
    _me=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
    # 列不出来(AccessDenied / 非 org)就不提示 —— 那种部署本来就只能单账号，
    # 提示了也没有可执行的下一步，只会变成噪音。
    _org_total=$(aws organizations list-accounts \
      --query 'length(Accounts[?Status==`ACTIVE`])' --output text 2>/dev/null || echo "")
    _org_members=""
    case "$_org_total" in
      ''|*[!0-9]*) _org_members="" ;;
      *) _org_members=$(( _org_total - 1 )) ;;   # 减掉当前账号自己
    esac
    if [ -n "$_org_members" ] && [ "$_org_members" -gt 0 ]; then
      echo ""
      echo "  $(t "⚠ 检测到 AWS Organizations: ${_org_id}" "⚠ AWS Organizations detected: ${_org_id}")"
      if [ -n "$_me" ] && [ "$_me" = "$_org_mgmt" ]; then
        echo "    $(t "当前账号 ${_me} 是组织管理账号(payer)，组织内另有 ${_org_members} 个 ACTIVE 成员账号。" "This account (${_me}) is the Organization management account (payer); the org has ${_org_members} other ACTIVE member account(s).")"
      else
        echo "    $(t "当前账号 ${_me} 能列出组织里的账号(StackSets 委派管理员)，另有 ${_org_members} 个 ACTIVE 账号。" "This account (${_me}) can list org accounts (StackSets delegated admin); there are ${_org_members} other ACTIVE account(s).")"
      fi
      echo "    $(t "本次**没有**带 --multi-account ⇒ 两个成员账号 StackSet 不会创建。" "--multi-account was NOT passed ⇒ the two member-account StackSets will not be created.")"
      echo "    $(t "后果：管理页里「一键接入」/「一键关联」整块不会出现（换成一段说明），跨账号查询报 org_mode_disabled。" "Consequence: the Admin page will not show the one-click onboarding section at all (a note replaces it), and cross-account queries return org_mode_disabled.")"
      echo "    $(t "(「手动接入账号」那条路不受影响：客户自行部署 CFN + 回填 Outputs)" "(The \"manual onboarding\" path is unaffected: the customer deploys the CFN themselves and you backfill the Outputs.)")"
      if [ -t 0 ]; then
        # ⚠️ `|| true`：`set -e` 下 read 读到 EOF 返回非 0 会让整个脚本退出。
        read -p "    $(t "现在就启用多账号模式(等同 --multi-account)？[y/N]: " "Enable multi-account mode now (same as --multi-account)? [y/N]: ")" _want_multi || true
        case "${_want_multi:-}" in
          [yY]*)
            MULTI_ACCOUNT_MODE=true
            echo "    $(t "✓ 已启用多账号模式 —— 会建两个 StackSet 并向 OU 下发成员账号资源。" "✓ Multi-account mode enabled — the two StackSets will be created and rolled out to the OU.")"
            ;;
          *)
            echo "    $(t "ℹ 继续单账号部署。以后要一键接入：重跑 ./setup.sh --multi-account" "ℹ Continuing single-account. To enable one-click onboarding later, re-run: ./setup.sh --multi-account")"
            ;;
        esac
      else
        echo "    $(t "(非交互环境，按单账号继续) 要一键接入：./setup.sh --multi-account" "(Non-interactive; continuing single-account.) For one-click onboarding: ./setup.sh --multi-account")"
      fi
      echo ""
    fi
  fi
fi

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
    echo "  $(t "如果需要, 请输入 Linked Account ID(逗号分隔, 如: 444455556666,111122223333)" "If needed, enter Linked Account IDs (comma-separated, e.g. 444455556666,111122223333)")"
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

# ─── Custom Event Bus 的跨账号判据（改动② 之后不再需要白名单交互）───
#
# 🔴 **原来这里有约 190 行交互**：读现有资源策略里的 `aws:PrincipalAccount` 列表 →
#    提示运维输入新白名单 → diff + 确认 → 用 `-c devopsAgentBusinessAccounts=`
#    传给 CDK。整块已删，因为策略的判据换成了与账号无关的形状：
#
#      ArnLike aws:PrincipalArn arn:<partition>:iam::*:role/notiops-devops-forwarder-role-*
#      AND events:source = "aws.aidevops"
#
#    加一个子账号**零部署** —— 客户的栈建出那个名字的转发角色就能投递。
#
# 🔴 **不删的后果是静默毁掉策略**：那段回读认的 key 是
#    `Condition.StringEquals["aws:PrincipalAccount"]`，新策略里没有这个 key →
#    读出空 → 提示变成「留空(首次部署 / 暂无业务账户接入)」→ 运维回车 →
#    `DEVOPS_AGENT_ACCOUNTS_FLAG=""` → 旧 CDK 那个 `length > 0` 门控不成立 →
#    **CfnEventBusPolicy 被删** → 全部成员账号 PutEvents AccessDenied。
#    而 setup.sh 打出来的是一条看起来完全正常的提示。
#
# ⚠️ 这个 flag 仍然保留成空串传给 cdk synth（第 1109 行那条命令行里有它）——
#    留着是为了不动那条命令行的形状；CDK 侧已经不读这个 context 了。
DEVOPS_AGENT_ACCOUNTS_FLAG=""

echo ""
echo "  $(t "ℹ Custom Event Bus 跨账号判据: 转发角色名 + events:source" "ℹ Custom Event Bus cross-account judgement: forwarder role name + events:source")"
echo "    $(t "  ArnLike aws:PrincipalArn .../notiops-devops-forwarder-role-*" "  ArnLike aws:PrincipalArn .../notiops-devops-forwarder-role-*")"
echo "    $(t "  AND events:source = aws.aidevops" "  AND events:source = aws.aidevops")"
echo "    $(t "新增业务账户无需重新部署本栈(不再维护账号白名单)" "Onboarding a business account no longer requires redeploying this stack (no account allowlist to maintain)")"

# 存量部署上如果还挂着老的白名单语句，说明一句它会被替换掉（本次部署的正常结果）
LEGACY_BUS_POLICY=$(aws events describe-event-bus \
  --name notiops-devops-events --region "$DEPLOY_REGION" \
  --query 'Policy' --output text 2>/dev/null || echo "")
if [ -n "$LEGACY_BUS_POLICY" ] && [ "$LEGACY_BUS_POLICY" != "None" ] \
   && echo "$LEGACY_BUS_POLICY" | grep -q "aws:PrincipalAccount"; then
  echo ""
  echo "  $(t "⚠️ 检测到旧的账号白名单语句，本次部署会用上面那条判据替换它。" "⚠️ A legacy account-allowlist statement was found; this deploy replaces it with the judgement above.")"
  echo "     $(t "影响: 白名单里的账号仍然能投递(它们用的就是那个角色名)；" "Effect: accounts in the allowlist keep working (they use that same role name);")"
  echo "     $(t "      不在白名单但部署过我们模板的账号，从此也能投递。" "      accounts not in the allowlist but running our template can now also forward.")"
fi
echo ""

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"

# ─── IM 平台选择 ───
# v1 release: dingtalk 暂不开放给客户(凭据流程 + push 自定义机器人
# 双 robot 配置链路在 Phase 2c 才稳定)。M2 之后 ImStack 只按 enabledPlatforms
# 建对应平台的 Webhook 路由,没选的平台连 Lambda 都不建。
# 第二版要恢复:把 "3) 钉钉 (DingTalk)" 选项加回菜单 + 在解析里加
# IM_PLATFORM_CHOICE 含 "3" 时 append "dingtalk,"。
echo ""
echo "$(t "── IM 平台选择（可选）──" "── IM Platform Selection (optional) ──")"
echo "  $(t "web 端默认部署。IM Bot 是可选的：你可以现在部署、或暂时不部署、" "The web UI is always deployed. IM bots are optional: deploy now, or skip and")"
echo "  $(t "以后想起来再随时重跑本脚本启用（未选中的平台整个 ImStack 不实例化，零成本）。" "re-run this script anytime later (unselected platforms: the whole ImStack is not created — zero cost).")"
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
  # 不部署 IM：整个 ImStack 都不实例化（见 infra/bin/app.ts 的 enabledPlatforms 分支）。
  # 以后想启用：重跑本脚本选 1/2 即可，无需重建。
  echo "  $(t "✓ 暂不部署 IM（web 端照常部署；以后重跑本脚本可随时启用 IM）" "✓ Skipping IM (web UI deploys as usual; re-run this script anytime to enable IM)")"
  PLATFORM_FLAG="-c enabledPlatforms=none"
else
  # 选了 IM 不再要求 Docker/Finch：M2 之后 IM 只有 Webhook + Lambda 一条路径，
  # 依赖打成 zip 层（scripts/build_im_layer.sh），没有任何容器镜像要构建。
  echo "  $(t "✓ 启用平台: " "✓ Enabled platforms: ")$ENABLED_PLATFORMS"
  PLATFORM_FLAG="-c enabledPlatforms=$ENABLED_PLATFORMS"
fi

# 1. 构建前端（web chat。老 idle 控制台已于 2026-09-04 退役，不再构建）
echo ""
echo "$(t "[1/4] 构建前端..." "[1/4] Building frontends...")"

# Web Chat 前端（WebChatStack 的 BucketDeployment 部署其 dist/）
cd "$PROJECT_ROOT/frontend/chat-app"
npm ci --loglevel=error   # ci: 严格按 package-lock.json 安装，保证可复现 + 不放宽 override floor（安全要求）
                          # loglevel=error 而非 --silent：--silent 连报错都吞，配合 set -e 会「一声不吭直接退出」
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
npm ci --omit=dev --loglevel=error --no-audit --no-fund   # ci: 严格按 lockfile（安全要求）；loglevel=error 让失败可见
echo "  $(t "✓ web chat BFF 依赖安装完成" "✓ Web Chat BFF dependencies installed")"

# ── 客户自有 CUR 数据源（cost-agent MCP，可选加装项）──
# 这是**外部**依赖：客户自己部署的一个 Athena-over-CUR 的 MCP 服务器（Lambda Function URL，
# AuthType=AWS_IAM），NotiOps 只是去调它。所以两件事都必须成立：
#   · 不填 = 这项能力**按设计不存在**（不是"坏了"）：BFF 拿到空串 → capabilities.json 的
#     requiresEnv 把 4 个 nav:finops:cur-* 节点摘掉；agent 侧一个工具都不挂。费用问题照答
#     （走 CE / call_aws），只是口径是聚合而非行级。
#   · 填了但服务挂了 = 只有那 4 张表「暂时不可用」，对话仍然能答并**明说**换了数据源。
# 为什么要两个变量：Function URL 里不含函数 ARN，而 lambda:InvokeFunctionUrl 必须按资源
# 授权（docs/DEPLOYMENT.md §14）。只填一半会得到"看起来装好了、每次调用 403"的部署，
# 而 403 的根因只在 CloudTrail 里 —— 所以在这里就拦掉，别让它跑到最后。
COST_AGENT_MCP_URL="${COST_AGENT_MCP_URL:-}"
COST_AGENT_MCP_URL="${COST_AGENT_MCP_URL%/}"
COST_AGENT_FN_ARN="${COST_AGENT_FN_ARN:-}"
COST_AGENT_FLAG=""
if [ -n "$COST_AGENT_MCP_URL" ]; then
  if [ -z "$COST_AGENT_FN_ARN" ]; then
    echo ""
    echo "  $(t "❌ 设了 COST_AGENT_MCP_URL 却没设 COST_AGENT_FN_ARN。" "❌ COST_AGENT_MCP_URL is set but COST_AGENT_FN_ARN is not.")" >&2
    echo "     $(t "Function URL 里不含函数 ARN，而 lambda:InvokeFunctionUrl 必须按资源授权 ——" "A Function URL does not contain the function ARN, and lambda:InvokeFunctionUrl must be granted per function --")" >&2
    echo "     $(t "只填一半会部署出一个每次调用都 403 的数据源。见 docs/DEPLOYMENT.md §14。" "filling in only half deploys a data source that 403s on every call. See docs/DEPLOYMENT.md section 14.")" >&2
    exit 1
  fi
  COST_AGENT_FLAG="-c costAgentMcpUrl=$COST_AGENT_MCP_URL -c costAgentFunctionArn=$COST_AGENT_FN_ARN"
  echo "  $(t "✓ 将接入客户自有 CUR 数据源（cost-agent MCP）" "✓ Will wire in your own CUR data source (cost-agent MCP)")"
fi

# ── Web Chat Agent（AgentCore Runtime）部署 ──
# 部署 Strands agent 到 AgentCore Runtime，并 provision web-search Gateway（仅 us-east-1）。
# 拿到 Runtime ARN 后，下面 CDK 部署 WebChatStack 时通过 -c agentRuntimeArn 注入，
# BFF 才会调真 agent（否则回退 echo）。agent 部署失败不阻断整体部署（web 端仍可用）。
# 跳过：SKIP_AGENT=true ./setup.sh（仅部署 web 端 + echo BFF）。
#
# AGENT_STATUS 记下这一步的**结局**（deployed / failed / no-arn / skipped / missing-dir）。
# 为什么需要它：不带 ARN 的部署会一路成功到最后，脚本照常打印 Chat URL，而客户一提问
# 只能拿到 echo 回显。那句 ⚠ 在几百行日志里翻不到 —— 所以结局要**带到最后的总结里**
# 大声说一次（见文末 "Agent 未就绪" 块）。这条链上历史上有两个分支**完全不打印**：
#   · agent 工程目录不存在（elif 只覆盖了 SKIP_AGENT=true）
#   · deploy_agent.sh 退出码 0 但 ARN 文件是空的
# 两者都直接落到 echo 模式,且没有任何一行输出提示过。现在每个分支都必须留下痕迹。
AGENT_RUNTIME_ARN=""
AGENT_ARN_FLAG=""
AGENT_STATUS="skipped"
if [ "${SKIP_AGENT:-false}" != "true" ] && [ -d "$PROJECT_ROOT/agent-build/NotiOpsWebChat" ]; then
  echo ""
  echo "  $(t "── 部署 Web Chat Agent（AgentCore Runtime，约 5-10 分钟）──" "── Deploying Web Chat Agent (AgentCore Runtime, ~5-10 min) ──")"
  AGENT_ARN_FILE="${TMPDIR:-/tmp}/notiops-agent-arn.txt"
  rm -f "$AGENT_ARN_FILE"
  if DEPLOY_REGION="$DEPLOY_REGION" PROJECT_ROOT="$PROJECT_ROOT" \
     ENABLE_WEBSEARCH="${ENABLE_WEBSEARCH:-true}" AGENT_ARN_OUT="$AGENT_ARN_FILE" \
     NOTIOPS_ALLOW_CROSS_ACCOUNT="$([ "$ORG_MODE" = true ] && echo 1 || echo "")" \
     COST_AGENT_MCP_URL="$COST_AGENT_MCP_URL" COST_AGENT_FN_ARN="$COST_AGENT_FN_ARN" \
     bash "$PROJECT_ROOT/scripts/deploy_agent.sh"; then
    AGENT_RUNTIME_ARN=$(cat "$AGENT_ARN_FILE" 2>/dev/null || echo "")
    if [ -n "$AGENT_RUNTIME_ARN" ]; then
      AGENT_ARN_FLAG="-c agentRuntimeArn=$AGENT_RUNTIME_ARN"
      AGENT_STATUS="deployed"
      echo "  $(t "✓ Agent 已部署，将注入 WebChatStack：" "✓ Agent deployed, injecting into WebChatStack: ")$AGENT_RUNTIME_ARN"
    else
      AGENT_STATUS="no-arn"
      echo "  $(t "⚠ agent 部署脚本返回成功，但没拿到 Runtime ARN（$AGENT_ARN_FILE 为空）——" "⚠ The agent deploy script succeeded but produced no Runtime ARN ($AGENT_ARN_FILE is empty) —")"
      echo "    $(t "BFF 只能回退 echo。请按文末提示单独重跑 agent 部署。" "the BFF can only fall back to echo. Re-run the agent deployment as shown at the end.")"
    fi
  else
    AGENT_STATUS="failed"
    echo "  $(t "⚠ Agent 部署失败 —— web 端仍会部署，但 BFF 暂回退 echo。" "⚠ Agent deployment failed — the web UI still deploys, but BFF falls back to echo for now.")"
    echo "    $(t "修复后可单独重跑：" "After fixing, re-run separately: ")DEPLOY_REGION=$DEPLOY_REGION bash scripts/deploy_agent.sh"
    # ⚠️ 这里**不给** `npx cdk deploy … -c agentRuntimeArn=<ARN>` 那条单栈命令：
    #    在脚本这个位置 $PLATFORM_FLAG / $ORG_FLAG / $INSPECTION_FLAGS 还没算完，
    #    照着只带一个 -c 的命令手工部会把其余 context 全部丢掉 —— 后果是静默的
    #    功能退化（IM 平台被关、org 模式失效、巡检深链变空）。文末的提示在所有
    #    flag 都算完之后打印，那里才给完整命令。
    echo "    $(t "然后重跑一次 setup.sh —— 它会把 ARN 连同其余 -c 一起注入。" "Then re-run setup.sh once -- it injects the ARN together with all the other -c flags.")"
  fi
elif [ "${SKIP_AGENT:-false}" = "true" ]; then
  echo "  $(t "（SKIP_AGENT=true：跳过 agent 部署，BFF 走 echo 回退。）" "(SKIP_AGENT=true: skipping agent deployment, BFF uses echo fallback.)")"
else
  AGENT_STATUS="missing-dir"
  echo ""
  echo "  $(t "⚠ 找不到 agent 工程目录 agent-build/NotiOpsWebChat —— 跳过 agent 部署，BFF 会回退 echo。" "⚠ Agent project dir agent-build/NotiOpsWebChat not found — skipping agent deployment; the BFF will fall back to echo.")"
  echo "    $(t "通常意味着仓库不完整（部分下载 / 只拷了子目录）。请完整 clone 后重跑。" "This usually means an incomplete repo (partial download / only a subdirectory copied). Re-clone in full and re-run.")"
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
# boto3/botocore 钉 1.43.65 —— **不许往下调**。Lambda 运行时自带的版本不可控，
# 层里的版本才是实际生效的。
#
# 下限有**两个独立来源**，都是运行时才炸、构建与部署全绿：
#
#   ① 服务模型存不存在。后端 Lambda（BFF 的「深度调查直连」）和 IM worker 都走
#      core/devops_agent.py，它 `boto3.client("devops-agent")`，靠 botocore 自带的
#      `botocore/data/devops-agent/` 目录。旧 botocore 里没有 → 构造客户端就
#      UnknownServiceError。
#   ② 模型里的 operation 够不够。Asset API（CreateAsset/UpdateAsset/ListAssets，
#      管 skill / custom_agent）与 Trigger API（CreateTrigger/ListTriggers，DA 原生
#      定时触发）是 1.43.2x 才进 service model 的。实测 1.43.19 只有 44 个
#      operation、这两组全缺，1.43.30 起是 62 个。缺了不报错，只在调用时抛
#      `object has no attribute 'create_trigger'`。
#
# 🔴 1.43.65 同时满足①②，2026-09-03 实测：62 个 operation，CreateAsset /
#    UpdateAsset / ListAssets / CreateTrigger / ListTriggers / CreateChat /
#    SendMessage / CreateBacklogTask / ListPendingMessages / ListAgentSpaces 全含。
#    （此前本分支钉的是 1.43.73，那只是"当时最新"、不是需求下限；合并时统一到 65
#     让下面那五处钉版本的地方一致。）
#
# 为什么必须钉、不能写 >=：CLI 漂版本会改写入库的 harness（见「依赖必钉版本」）。
#
# ⚠️ 一共**五处**钉同一个版本，改一处要全改，否则同一份 core/devops_agent.py
#    在一端能跑、另一端 UnknownServiceError，看起来像"某一端的 bug"：
#      setup.sh（本行）
#      scripts/build_im_layer.sh 的 BOTO_VERSION
#      platforms/{feishu,slack,dingtalk}/requirements.txt
pip install boto3==1.43.65 botocore==1.43.65 -t lambda_layer/python/ --quiet --upgrade $PLAT_ARGS
pip install "aws-lambda-powertools[aws-sdk]>=3.0.0" -t lambda_layer/python/ --quiet --upgrade $PLAT_ARGS
pip install "jinja2>=3.1.6" -t lambda_layer/python/ --quiet --upgrade $PLAT_ARGS
deactivate
echo "  $(t "✓ Lambda 依赖安装完成" "✓ Lambda dependencies installed")"

# 2.2 IM 依赖层（lambda_layer_im/）—— 只在选了 IM 平台时构建。
# ⚠️ 这一步**不是可选的**：ImStack 在 infra/bin/app.ts 的
# `enabledPlatforms !== "none"` 分支里实例化，而 im-stack.ts 在 synth 期就会检查层里
# 有没有 lark_oapi/slack_sdk/botocore。层没建 → 下面的 `cdk synth --all` 直接失败，
# 而不是"少部一个栈"（有意如此，见「不许静默降级」：宁可 synth 期停，也不要部上去
# 一个 import 就崩的 Lambda）。
# 为什么单独一层、为什么必须 manylinux2014_x86_64：见 scripts/build_im_layer.sh 文件头。
if [ -n "$ENABLED_PLATFORMS" ]; then
  echo ""
  echo "  $(t "构建 IM 依赖层 (lark-oapi + slack-sdk + boto3)..." "Building IM dependency layer (lark-oapi + slack-sdk + boto3)...")"
  if bash scripts/build_im_layer.sh; then
    echo "  $(t "✓ IM 依赖层构建完成" "✓ IM dependency layer built")"
  else
    echo ""
    echo "  $(t "❌ IM 依赖层构建失败（通常是访问 PyPI 失败）。" "❌ Failed to build the IM dependency layer (usually a PyPI connectivity failure).")"
    echo "     $(t "IM 的 Webhook Lambda 依赖这一层，缺了它 cdk synth 会直接失败。" "The IM webhook Lambdas need this layer; without it cdk synth fails outright.")"
    echo "     $(t "修好网络后重跑本脚本，或先单独跑: bash scripts/build_im_layer.sh" "Fix connectivity and re-run this script, or run it standalone: bash scripts/build_im_layer.sh")"
    echo "     $(t "如果只想先部署 web 端：重跑本脚本、IM 平台那一步选 0) 暂不部署 IM。" "To deploy the web side only: re-run this script and choose 0) skip IM at the platform step.")"
    exit 1
  fi
fi

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
npm ci --loglevel=error   # ci: 严格按 lockfile，保证可复现 + 不放宽 override floor（安全要求）；loglevel=error 让失败可见

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

# ─── 资源巡检的四个部署参数（R11c.3 / R11c.7 / R11b.7 / R11b.10）───
#
# 🔴 这四个不传的后果**全部是静默的** —— 巡检照跑、看板有数据、run 记录
#    success，只是：告警没人收到 / 预算护栏关着 / 推送没有深链。
#    所以这里自动探测 + 显式打印，而不是让它们默默吃兜底值。
echo ""
echo "$(t "─── 资源巡检部署参数 ───" "─── Resource Inspection deployment parameters ───")"
INSPECTION_FLAGS=""

# ① 运维告警收件人。**独立于客户推送通道**（R11c.2：混进去客户会收到
#    我们的内部故障）。不填也会建 topic —— Alarm 必须有 action，否则它只在
#    控制台变红，而「没人看控制台」正是 R11c.3 存在的原因。
if [ -n "${OPS_ALERT_EMAIL:-}" ]; then
  INSPECTION_FLAGS="$INSPECTION_FLAGS -c opsAlertEmail=$OPS_ALERT_EMAIL"
  echo "  $(t "✓ 运维告警邮箱: " "✓ Ops alert email: ")$OPS_ALERT_EMAIL"
else
  echo "  $(t "ℹ 未设 OPS_ALERT_EMAIL —— 6 条巡检告警只会在 CloudWatch 控制台变红。" "ℹ OPS_ALERT_EMAIL not set -- the 6 inspection alarms will only turn red in the console.")"
  echo "    $(t "补法: OPS_ALERT_EMAIL=sre@example.com ./setup.sh（或事后订阅 notiops-inspection-ops-alerts）" "Fix: OPS_ALERT_EMAIL=sre@example.com ./setup.sh (or subscribe to notiops-inspection-ops-alerts later)")"
fi

# ② DevOps Agent 月度额度上限（秒）。🔴 不设的话预算护栏**静默关闭**：
#    `_env(..., "-1")` 恒取兜底 → used_ratio 恒 0 → tier 恒 NORMAL。
#    按容量模型估算，满负荷月消耗
#    远超 Enterprise Support Basic 的额度，护栏关着等于第一个月烧光全年。
if [ -n "${INSPECTION_MONTHLY_LIMIT_SECONDS:-}" ]; then
  INSPECTION_FLAGS="$INSPECTION_FLAGS -c monthlyLimitSeconds=$INSPECTION_MONTHLY_LIMIT_SECONDS"
  echo "  $(t "✓ DA 月度额度上限: " "✓ DA monthly limit: ")${INSPECTION_MONTHLY_LIMIT_SECONDS}s"
else
  echo "  $(t "⚠ 未设 INSPECTION_MONTHLY_LIMIT_SECONDS —— 预算护栏关闭（P3 告警会停在 INSUFFICIENT_DATA 提示这一点）。" "⚠ INSPECTION_MONTHLY_LIMIT_SECONDS not set -- the budget guardrail is OFF (the P3 alarm stays INSUFFICIENT_DATA to surface this).")"
fi

# ③ 看板 base URL（推送正文里的「查看详情 / 查看全部」深链，R11b.7）。
#    ⚠️ 它是 **WebChatStack** 的 CloudFront 域名，而那个栈在本次部署里
#    可能还不存在（首次部署）。所以从**已有部署**的 CFN 输出里读 ——
#    首次部署拿不到（推送就没深链），重跑一次即补上。这正是
#    「用 setup.sh 更新现有资源」的场景。
EXISTING_CHAT_URL=$(aws cloudformation describe-stacks \
  --stack-name WebChatStack --region "$DEPLOY_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ChatUrl'].OutputValue | [0]" \
  --output text 2>/dev/null || echo "")
if [ -n "$EXISTING_CHAT_URL" ] && [ "$EXISTING_CHAT_URL" != "None" ]; then
  INSPECTION_FLAGS="$INSPECTION_FLAGS -c webBaseUrl=$EXISTING_CHAT_URL"
  echo "  $(t "✓ 推送深链 base URL: " "✓ Push deep-link base URL: ")$EXISTING_CHAT_URL"
else
  echo "  $(t "ℹ WebChatStack 尚未部署 —— 本轮推送正文没有深链，部署完重跑一次即补上。" "ℹ WebChatStack not deployed yet -- push bodies will have no deep links this round; re-run setup.sh once it exists.")"
fi

# ④ 判读正文语言（R11b.10）。默认 zh —— ⚠️ 不复用 DEFAULT_LOCALE，
#    那个在 report_delivery 里兜底 "en"，共用会把巡检报告拖成英文。
if [ -n "${INSPECTION_REPORT_LOCALE:-}" ]; then
  INSPECTION_FLAGS="$INSPECTION_FLAGS -c inspectionReportLocale=$INSPECTION_REPORT_LOCALE"
  echo "  $(t "✓ 判读正文语言: " "✓ Judgment body locale: ")$INSPECTION_REPORT_LOCALE"
fi

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
# ⚠️ 目录名带上 repo 名。三个 clone（devops-assistant / NotiOps /
# sample-notiops）的 setup.sh 此前都写死 "notiops-cdk-out" —— 同一台机器上
# 并发部署两个 repo 会互相踩：一边正在被 asset 拷贝读，另一边的
# `rm -rf` 把它删了，表现是 ENOENT 或半个 asset 被打包上传。
CDK_OUT_DIR="${TMPDIR:-/tmp}/notiops-cdk-out-$(basename "$PROJECT_ROOT")"
rm -rf "$CDK_OUT_DIR"; mkdir -p "$CDK_OUT_DIR"


# ── 跑完就把 assembly 删掉（否则它一直占着盘，直到下次部署的 rm -rf）──
#
# 体积来源：`fromAsset("../")` 把 repo root 拷进每个 asset 目录，一次 synth
# 有 20~60 个 asset。`infra/bin/app.ts` 里那条「594s → 12s」的注释是同一个
# 根因的另一面 —— 那次治的是 hash 计算耗时，这里治的是留下来的拷贝。
#
# ⚠️ 只在**部署成功**时删。被 Ctrl-C 打断或部署失败时栈可能是半部署状态，
#    assembly 留着才能对照模板排查。
CDK_DEPLOY_DONE=0
_cdk_out_cleanup() {
  local rc=$?                     # 必须是第一句：下面任何命令都会覆盖 $?
  trap - EXIT INT TERM            # 自己别再触发自己
  if [ "$CDK_DEPLOY_DONE" = "1" ] && [ -d "$CDK_OUT_DIR" ]; then
    # ⚠️ 用 df 差值报体积，**不要** du -sh：这个目录有百万级文件，
    #    du 要跑好几分钟，会把部署的收尾卡住；df 是瞬时的。
    local before_k after_k freed_mb
    before_k=$(df -Pk "$CDK_OUT_DIR" 2>/dev/null | awk 'NR==2{print $4}')
    rm -rf "$CDK_OUT_DIR"
    after_k=$(df -Pk "$(dirname "$CDK_OUT_DIR")" 2>/dev/null | awk 'NR==2{print $4}')
    if [ -n "$before_k" ] && [ -n "$after_k" ] && [ "$after_k" -gt "$before_k" ]; then
      freed_mb=$(( (after_k - before_k) / 1024 ))
      echo "  $(t "已清理 CDK 构建产物，释放 ${freed_mb} MB" \
                  "Cleaned CDK assembly, freed ${freed_mb} MB")"
    else
      echo "  $(t "已清理 CDK 构建产物" "Cleaned CDK assembly")"
    fi
  elif [ -d "$CDK_OUT_DIR" ]; then
    echo "  $(t "保留 CDK 构建产物用于排查：" "Kept CDK assembly for debugging: ")$CDK_OUT_DIR"
  fi
  exit "$rc"                      # 原样传出，不改 set -e 的 fail-fast 语义
}
trap _cdk_out_cleanup EXIT INT TERM
npx cdk synth --quiet --all --output "$CDK_OUT_DIR" $SKIP_PHD_FLAG $PHD_ACCOUNTS_FLAG $DEVOPS_AGENT_ACCOUNTS_FLAG $PLATFORM_FLAG $AGENT_ARN_FLAG $ORG_FLAG $INSPECTION_FLAGS $COST_AGENT_FLAG 2>cdk-synth-stderr.log || SYNTH_OK=false

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

# ── 升级预检：退役的 CFN Export 必须「消费者优先」 ─────────────────────────
#
# 🔴 这一段治的是一个**不可自愈**的升级失败，只在升级已装环境时出现：
#
#    CDK 的跨栈引用会在**生产者**（NotiOpsBackendStack）上自动生成一条 CFN
#    Export，消费者栈（WebChatStack / ImStack）里是 `Fn::ImportValue`。某一版
#    退役了这个引用 → HEAD 的主栈不再 export 它。而 `cdk deploy --all` 按
#    `addStackDependency`（`infra/bin/app.ts`）**先更主栈** —— 那一刻客户机器上
#    已装的**老**消费者栈还持有那个 import，CloudFormation 硬拒：
#
#        Export <name> cannot be deleted as it is in use by WebChatStack
#
#    结果：主栈 `UPDATE_ROLLBACK_COMPLETE`、后续栈全 SKIPPED、`set -e` 就地
#    中止。**而且平淡重跑永远撞同一堵墙** —— CDK CLI 把
#    `UPDATE_ROLLBACK_COMPLETE` 归为 `isRollbackSuccess`，不会 delete-and-recreate，
#    所以客户手上那套环境从此升不动，除非有人手工先部消费者栈。
#
# 解法就是把顺序倒过来：先单独部消费者栈（它的新模板已经没有那条 import），
# 引用一放开，主栈就能删掉 export。判据（要不要倒 / 倒哪些栈）在
# `scripts/export_retire_plan.py`，零 AWS 调用、可单测（见 §3.73）。
#
# ⚠️ **首装与绝大多数升级走 SKIP 分支，行为逐字节不变** —— 这里只加一次
#    read-only 的 `describe-stacks`。
MAIN_DESC=$(aws cloudformation describe-stacks --stack-name NotiOpsBackendStack \
  --region "$DEPLOY_REGION" --output json 2>/dev/null || echo '{"Stacks":[]}')
RETIRE_ERR="$CDK_OUT_DIR/export-retire-plan.err"
if ! RETIRE_PLAN=$(printf '%s' "$MAIN_DESC" \
      | python3 "$PROJECT_ROOT/scripts/export_retire_plan.py" \
          --outdir "$CDK_OUT_DIR" 2>"$RETIRE_ERR"); then
  # fail closed：判据自己坏了就**不许**继续部署 —— 猜"大概没事"正是上面那个
  # 死锁的来路。
  echo ""
  echo "  $(t "❌ 升级预检（CFN Export 退役检查）失败，已停在部署之前：" \
              "❌ Upgrade preflight (CFN export retirement check) failed, stopped before deploying:")"
  cat "$RETIRE_ERR" 2>/dev/null
  echo "  $(t "这是有意的保护 —— 请修好上面的问题后重跑 setup.sh。" \
              "This guard is intentional -- fix the above and re-run setup.sh.")"
  exit 1
fi

case "${RETIRE_PLAN%% *}" in
  SKIP)
    : # 常规路径，无事可做。原因（首装 / 本次不删 export）不值得刷屏。
    ;;
  WAIT)
    echo ""
    echo "  $(t "⏳ 主栈正在变更中（" "⏳ The main stack is mid-change (")${RETIRE_PLAN#WAIT }$(t "），现在部署一定失败。" "), deploying now would fail.")"
    echo "  $(t "请等 CloudFormation 收敛（控制台看 NotiOpsBackendStack 的事件）后重跑 setup.sh。" \
                "Wait for CloudFormation to settle (watch NotiOpsBackendStack events in the console), then re-run setup.sh.")"
    exit 1
    ;;
  REORDER)
    echo "  $(t "🔁 检测到有 CFN Export 要退役 —— 先单独部署消费者栈以放开引用：" \
                "🔁 A CFN export is being retired -- deploying consumer stacks first to release the reference:")${RETIRE_PLAN#REORDER }"
    for _retire_stack in ${RETIRE_PLAN#REORDER }; do
      echo "  $(t "  → 先部署 " "  -> deploying first: ")$_retire_stack"
      # 🔴 **绝不许在这里传 `--outputs-file`**：它是全量覆写，会把
      #    cdk-outputs.json 写成只含这一个栈的输出，后面读 ChatUrl / 各 ARN 的
      #    步骤就会静默拿到空值。输出文件只由下面那条 `--all` 负责。
      # ⚠️ `--exclusively` 是关键：不加它 CDK 会先去部依赖（也就是主栈），
      #    正好把要避开的顺序又走一遍。
      # ⚠️ `-c` 必须与下面 `--all` 那行**同一套**，否则两次 synth 出的模板不同。
      npx cdk deploy "$_retire_stack" --exclusively --require-approval never \
        --output "$CDK_OUT_DIR" \
        $SKIP_PHD_FLAG $PHD_ACCOUNTS_FLAG $DEVOPS_AGENT_ACCOUNTS_FLAG \
        $PLATFORM_FLAG $AGENT_ARN_FLAG $ORG_FLAG $INSPECTION_FLAGS $COST_AGENT_FLAG
    done
    ;;
  FALLTHROUGH)
    # 同一版里既退役 export 又新增 export，且消费者要用新增的那条 —— 消费者优先
    # 在这种版本上**无解**（先部消费者会 `No export named … found`，同一个死锁
    # 换个方向复活）。照常规顺序部，但把话说清楚。真正拦这种组合的是 CI 上的
    # `scripts/check_cfn_exports.py` + `infra/exports.golden.json`。
    echo ""
    echo "  $(t "⚠️  升级预检：本版同时退役与新增 CFN Export，无法用「消费者优先」规避。" \
                "⚠️  Upgrade preflight: this version both retires and adds CFN exports; consumer-first cannot help.")"
    echo "  ${RETIRE_PLAN#FALLTHROUGH }"
    echo "  $(t "将按常规顺序部署。若主栈报 \"Export … cannot be deleted as it is in use\"，" \
                "Deploying in the normal order. If the main stack reports \"Export ... cannot be deleted as it is in use\",")"
    echo "  $(t "需要把这次发布拆成两步（先只加、后再删），见 docs/DEPLOYMENT.md「升级路径」。" \
                "split this release in two (add first, remove later) -- see docs/DEPLOYMENT.md \"Upgrade path\".")"
    ;;
  *)
    echo ""
    echo "  $(t "❌ 升级预检返回了无法识别的结论，已停在部署之前：" \
                "❌ Upgrade preflight returned an unrecognized verdict, stopped before deploying:")$RETIRE_PLAN"
    exit 1
    ;;
esac

echo "  $(t "执行完整部署..." "Running full deployment...")"
# Same --output outside repo root as synth above (avoids fromAsset recursion).
# $AGENT_ARN_FLAG（若 agent 部署成功）= "-c agentRuntimeArn=<ARN>"，让 WebChatStack 的 BFF
# 调真 agent；为空则 BFF 回退 echo。
# $COST_AGENT_FLAG（可选）= "-c costAgentMcpUrl=<url> -c costAgentFunctionArn=<arn>"：BFF 的
# 环境变量 + lambda:InvokeFunctionUrl + 缓存前缀授权 + 每日预热规则都由它决定（web-chat-core.ts）。
npx cdk deploy --all --require-approval never --output "$CDK_OUT_DIR" --outputs-file cdk-outputs.json $SKIP_PHD_FLAG $PHD_ACCOUNTS_FLAG $DEVOPS_AGENT_ACCOUNTS_FLAG $PLATFORM_FLAG $AGENT_ARN_FLAG $ORG_FLAG $INSPECTION_FLAGS $COST_AGENT_FLAG
# 部署成功 → 收尾时可以删 assembly（见上面的 _cdk_out_cleanup）。
# 放在 deploy 之后：set -e 保证 deploy 非零就到不了这里。
CDK_DEPLOY_DONE=1
echo "  $(t "✓ CDK 部署完成" "✓ CDK deployment complete")"

# ── 部署后:把巡检判读 skill 同步到 Agent Space ────────────────────────────
#
# 🔴 **这一步此前不存在**,后果是静默的:改了仓库里的 GUARDRAILS 不等于改了
#    DA 手里那份。2026-08-24 实测巡检 space 里的判读 skill 是 8/22 的版本,
#    而 8/23 新加的三段(PI 方法论 / 内存双条件 / burstable)一直没生效 ——
#    DA 照样返回判读,只是用的是旧方法论,没有任何信号。
#
#    没有自动同步的原因:UI 的 Skills 页管的是 S3 里那 12 个预置
#    skill(有「发布到 DevOps Agent」按钮),而巡检这两份在仓库
#    inspection/skills/ 里,既没有 UI 入口,setup.sh 与 CDK 里也没有上传步骤。
#    scripts/sync_inspection_skills.py 只保证**仓库里**两份 SKILL.md 与共享段
#    逐字一致,管不到「有没有传上去」—— 所以那套 CI 检查一直是绿的。
#
# ⚠️ **best-effort,不阻断部署。** 传不上去的表现是判读不受约束(退化,不是
#    崩溃),而部署失败会让整套系统都用不上。失败时打一行醒目的提示 +
#    给出手动重跑的命令。
# ⚠️ 幂等:内容没变时 client_token 不变,服务端不产生新版本,asset_id 也稳定。
# 🔴 **`InspectionAgentSpaceId`，不是 `AgentSpaceId`。** 这套部署有两个
#    Agent Space（刻意拆开,见 notiops-backend-stack.ts 的 InspectionAgentSpace
#    那段）:AgentSpaceId 是排障/web chat 用的,InspectionAgentSpaceId 才是巡检。
#    skill 是 per agent space 的,而 executor 派发用 INSPECT_AGENT_SPACE_ID
#    (= 巡检那个)。传错 space 会两头都错:巡检侧仍加载不到 GUARDRAILS,
#    排障侧被判读 skill 污染。2026-08-24 第一版这里写的就是 AgentSpaceId。
DA_SPACE_FOR_SKILLS=$(jq -r '.NotiOpsBackendStack.InspectionAgentSpaceId // empty' \
  cdk-outputs.json 2>/dev/null || echo "")
if [ -n "$DA_SPACE_FOR_SKILLS" ]; then
  echo ""
  echo "$(t "[3.5/4] 同步巡检判读 skill 到 Agent Space..." "[3.5/4] Syncing inspection judgement skills to the Agent Space...")"
  # .venv 优先(项目自己的 boto3);没有就用系统 python3。
  SKILL_PY="$PROJECT_ROOT/.venv/bin/python"
  [ -x "$SKILL_PY" ] || SKILL_PY="python3"
  # 🔴 `--all-accounts`：传给**每个**已启用账号自己的巡检 space（per-account
  #    agent space 之后必须这样）。不加这个参数只会传部署账号那一个 ——
  #    成员账号的 space 里没有判读 skill → DA 用通用提示词自由发挥 →
  #    切不出 `## <finding_id>` → 全部 da_parse_status: parse_failed。
  #    判读的钱花了、结果全是废的。
  #
  # ⚠️ 仍然传 `--space`：它作为**部署账号那一个**的 env 兜底
  #    （多账号模式下部署账号自己也在列表里，走的是 env/CFN 那条路）。
  #
  # ⚠️ 部分失败**不阻断部署**（下面的 else 分支）—— 部署不该因为一个成员账号的
  #    assume 失败而停。但脚本会逐账号列出来并非零退出，那是运维唯一的信号。
  if AWS_REGION="$DEPLOY_REGION" PYTHONPATH="$PROJECT_ROOT" \
     "$SKILL_PY" "$PROJECT_ROOT/scripts/upload_inspection_skills.py" \
       --all-accounts --space "$DA_SPACE_FOR_SKILLS" --region "$DEPLOY_REGION"; then
    # 🔴 上传成功 ≠ DA 手里那份是仓库当前版本。三种情况都会让判读依据是旧的
    #    而**判读结果看起来完全正常**（它照样输出结论，只是基于旧阈值）:
    #      · 传进了错的 space(2026-08-24 真的发生过)
    #      · 仓库里两份 SKILL.md 的共享段没同步
    #      · 有人在控制台手改过
    #    所以传完立刻把内容拉回来逐字比一次。
    if AWS_REGION="$DEPLOY_REGION" PYTHONPATH="$PROJECT_ROOT" \
       "$SKILL_PY" "$PROJECT_ROOT/scripts/upload_inspection_skills.py" \
         --all-accounts --verify --space "$DA_SPACE_FOR_SKILLS" --region "$DEPLOY_REGION"; then
      :
    else
      echo "  $(t "⚠ 校验发现 space 里的 skill 与仓库不一致 —— DA 的判读依据不是当前规则(不阻断部署)。" "⚠ Verification found the space's skills differ from the repo — DA judgements are not using current rules (non-blocking).")"
    fi
  else
    # 🔴 这行文案必须点明「静默 / SILENT」这三个字。
    #    原文只写了 parse_failed + 不阻断,而那读起来像「会有个失败状态等着我」——
    #    实际不会:lambda_inspection_executor/handler.py:2109-2130 记着实测结论,
    #    space 里没判读 skill 时 DA **不报错**,它用通用提示词自由发挥 → 切不出
    #    `## <finding_id>` → 每条 finding 的 da_parse_status 都是 parse_failed,
    #    而**巡检照跑、报告照出、run 仍是 success、判读额度照花**。也就是说除了
    #    此刻这一行,后面再没有任何一处会提醒运维。所以「静默」本身是这行要传达
    #    的第一信息,而不是脚注 —— 中英两侧都要说,只写一侧的那半个客户看不到。
    echo "  $(t "⚠ 有账号的判读 skill 没传上去 —— 这是静默降级:巡检照跑、报告照出、run 仍是 success,只有那些账号的每条 finding 都会 parse_failed(判读额度照花,不阻断部署)。此刻这一行是唯一的信号。" "⚠ Some accounts did not get the judgement skills — this degrades SILENTLY: inspections still run, reports are still generated and the run still reports success; only those accounts' findings all come back parse_failed (judgement quota still spent, non-blocking). This line is the only signal you will get.")"
    echo "    $(t "上面那份逐账号清单指出了是哪些账号；常见原因是该账号还没回填巡检 space(管理页显示「待更新栈」)。" "The per-account list above shows which ones; the usual cause is a missing inspection space id (the admin page shows \"Stack update needed\").")"
    echo "    $(t "手动重跑: " "Retry manually: ")AWS_REGION=$DEPLOY_REGION PYTHONPATH=\$PWD .venv/bin/python scripts/upload_inspection_skills.py --all-accounts"
  fi
else
  echo "  $(t "ℹ 拿不到 AgentSpaceId,跳过判读 skill 同步(可事后跑 scripts/upload_inspection_skills.py)。" "ℹ No AgentSpaceId available; skipping judgement-skill sync (run scripts/upload_inspection_skills.py later).")"
fi

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

# ── 巡检判读 skill 的上传在上面【已经做过了】──
#
# 🔴 这里原本有**第二个**上传块，而它从来没成功过：传的参数是
#    `--space-id` / `--account-id`，而 `upload_inspection_skills.py` 的 argparse
#    只认 `--space` / `--region` / `--dry-run` / `--verify`。
#
#    ```
#    $ python3 scripts/upload_inspection_skills.py --space-id abc --account-id 1234...
#    error: unrecognized arguments: --space-id abc --account-id 123456789012
#    exit 2
#    ```
#
#    exit 2 → 走 else 分支 → 打一行 ⚠ 警告（不阻断），而那行警告给出的
#    「请手动重跑」命令**用的还是同一套错参数**。所以它是一个必然失败、
#    且失败提示会把人引到同一个错误上的块。
#
# ⚠️ 而且它取的 space 与上面那块**完全一样**（都是
#    `.NotiOpsBackendStack.InspectionAgentSpaceId`）—— 也就是说即使参数改对，
#    它也只是把同一份 skill 往同一个 space 传第二遍。上面那块参数正确、
#    还带 `--verify` 回读校验，所以这里直接删掉，不是修参数。
#
#    （2026-08-29 三方交叉 review 发现。实跑复现过。）

# ── 部署后:给存量 finding 补 GSI1 索引键(跨账号统一视图) ──
# 2026-08-27 起巡检看板是【跨全部可见账号的统一视图】,数据层走 notiops-inspection
# 表新加的 GSI1。而 DynamoDB 的 GSI 只收带索引键的行:加索引那一刻起新写入的进索引,
# 【存量行不会】—— 它们在主表里好好的,只是统一视图查不到。
#
# 🔴 不做这一步的后果是【静默的】:查询成功、返回 200、只是少了行。客户看到的是
#    「升级之后昨天那些风险不见了」,而 CloudWatch 里什么都没有。所以放进部署流程,
#    不指望人记住。
#
# 幂等:条件写 attribute_not_exists(GSI1PK),已经有的不动 —— 重复部署是空跑。
# 只 SET 两个索引属性,不碰任何业务字段。
# 不阻断:失败只影响统一视图的存量部分,新 finding 照常进索引。
echo "  $(t "回填存量 finding 的跨账号索引键…" "Backfilling cross-account index keys on existing findings…")"
if AWS_REGION="$DEPLOY_REGION" python3 "$PROJECT_ROOT/scripts/backfill_finding_gsi.py" --apply; then
  :
else
  echo "  $(t "⚠ 索引键回填未完成(不阻断)。后果:巡检页看不到【升级前】的 finding(新的不受影响)。手动重跑:" "⚠ Index-key backfill did not complete (non-blocking). Impact: findings created BEFORE this upgrade will not show on the inspection page (new ones are fine). Re-run manually:")"
  echo "      AWS_REGION=$DEPLOY_REGION python3 scripts/backfill_finding_gsi.py --apply"
fi

# 4. 部署摘要
echo ""
echo "$(t "[4/4] 提取部署信息..." "[4/4] Extracting deployment info...")"

cd "$PROJECT_ROOT/infra"
# Several stacks are deployed (NotiOpsBackendStack + ImStack + WebChatStack),
# so `keys[0]` is not deterministic. All outputs below come from
# NotiOpsBackendStack; hardcode it.
STACK_NAME="NotiOpsBackendStack"

# CloudFrontUrl / ApiUrl 已随老控制台退役（2026-09-04）——容错读取，老栈升级时可能还有
CLOUDFRONT_URL=$(jq -r ".[\"$STACK_NAME\"].CloudFrontUrl" cdk-outputs.json 2>/dev/null || echo "N/A")
USER_POOL_ID=$(jq -r ".[\"$STACK_NAME\"].UserPoolId" cdk-outputs.json)
IDLE_ROLE_ARN=$(jq -r ".[\"$STACK_NAME\"].IdleDetectionRoleArn" cdk-outputs.json)
LAMBDA_ROLE_ARN=$(jq -r ".[\"$STACK_NAME\"].LambdaExecutionRoleArn" cdk-outputs.json)
API_URL=$(jq -r ".[\"$STACK_NAME\"].ApiUrl" cdk-outputs.json 2>/dev/null || echo "N/A")
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

# ImStack 输出（M2 之后 IM 走 Webhook + Lambda）。这两个 URL 是**客户必须拿到的东西**：
# 要粘进飞书开放平台的「请求地址」/ Slack 的 Request URL，不打印出来客户就得自己去
# CloudFormation 控制台翻 —— 那一步一卡住，IM 这条链路等于没交付。
FEISHU_WEBHOOK_URL=$(jq -r ".ImStack.FeishuWebhookUrl" cdk-outputs.json 2>/dev/null || echo "N/A")
SLACK_WEBHOOK_URL=$(jq -r ".ImStack.SlackWebhookUrl" cdk-outputs.json 2>/dev/null || echo "N/A")
[ "$FEISHU_WEBHOOK_URL" = "null" ] && FEISHU_WEBHOOK_URL="N/A"
[ "$SLACK_WEBHOOK_URL" = "null" ] && SLACK_WEBHOOK_URL="N/A"
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

# ─── LLM 模型目录 seed（DDB PK=llmcfg / SK=meta）───
# 幂等：写入条件是 attribute_not_exists(PK)，所以重跑部署绝不覆盖管理员在控制台里
# 配好的目录。不 seed 也能聊（各端都有内置兜底目录），但 Admin 的「模型」页会是空表，
# 而管理员只能添加**能被枚举并连通性测试通过**的模型 —— 于是第一次保存很难做成。
# 详见 scripts/seed_llm_catalog.py 的文件头。
echo ""
echo "$(t "── LLM 模型目录 ──" "── LLM model catalogue ──")"
if command -v python3 >/dev/null 2>&1; then
  # 用 $PROJECT_ROOT 而不是 $(dirname "$0")：执行到这里时已经 cd 进 infra/，
  # 相对 $0 的路径会解析成 infra/./scripts/... → No such file，seed 静默失败
  if AWS_REGION="$DEPLOY_REGION" python3 "$PROJECT_ROOT/scripts/seed_llm_catalog.py" \
       --table notiops-config --region "$DEPLOY_REGION" 2>/tmp/notiops-llmcfg-seed-err.log; then
    :
  else
    echo "  $(t "⚠ 模型目录 seed 失败（各端会使用内置兜底目录，对话不受影响；Admin「模型」页将为空表）。详情：" "⚠ Model catalogue seed failed (every surface falls back to its builtin catalogue, chat is unaffected; the Admin \"Models\" tab will be empty). Details:")"
    head -5 /tmp/notiops-llmcfg-seed-err.log 2>/dev/null
    echo "  $(t "  修好后可单独重跑：python3 scripts/seed_llm_catalog.py --region " "  Re-run on its own once fixed: python3 scripts/seed_llm_catalog.py --region ")$DEPLOY_REGION"
  fi
  rm -f /tmp/notiops-llmcfg-seed-err.log
else
  echo "  $(t "⚠ 未找到 python3，跳过模型目录 seed。稍后手动执行：python3 scripts/seed_llm_catalog.py --region " "⚠ python3 not found, skipping the model catalogue seed. Run manually later: python3 scripts/seed_llm_catalog.py --region ")$DEPLOY_REGION"
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
echo "  $(t "Support 案例 / 通知 / 巡检看板 / 管理配置(阈值·账号·Skills)，都在站内。" "Support cases / notifications / inspection dashboards / admin config (thresholds, accounts, skills) — all in-app.")"
echo ""
echo "$(t "── 其它地址(排查 / 高级用途,平时不用管)──" "── Other URLs (troubleshooting / advanced, usually ignore) ──")"
echo "  $(t "· Web Chat BFF Function URL(排查用):              " "· Web Chat BFF Function URL (troubleshooting):   ")$CHAT_BFF_URL"
echo "  · IdleDetectionRole:  $IDLE_ROLE_ARN"
echo "  · LambdaExecutionRole: $LAMBDA_ROLE_ARN  $(t "← 跨账户信任策略填这个" "← use this in cross-account trust policy")"
echo ""
if [ -n "$ENABLED_PLATFORMS" ]; then
  echo "$(t "── IM Bot(Webhook + Lambda）── 本次启用: " "── IM Bot (webhook + Lambda) ── enabled: ")$ENABLED_PLATFORMS"
  echo "$(t "飞书 Secret:       " "Feishu Secret:     ")$FEISHU_SECRET"
  echo "Slack Bot Token:   $SLACK_BOT_TOKEN_SECRET"
  # Slack App Token(xapp-)只有 socket mode 用得上。M2 之后正常路径是 Webhook +
  # 签名校验(notiops/slack-signing-secret),这个 Secret 平时留空即可 —— 把它跟
  # 必填项并排打印会让客户以为不填 bot 就不工作,白等一场。
  echo "$(t "Slack App Token:   " "Slack App Token:   ")$SLACK_APP_TOKEN_SECRET  $(t "← 仅回滚到长连接(socket mode)时才需要填,正常留空" "← only needed if you roll back to socket mode; leave empty otherwise")"
else
  echo "$(t "── IM Bot ── 本次未部署（web 端已就绪）" "── IM Bot ── not deployed this run (web UI is ready)")"
  echo "  $(t "以后想启用：重跑 ./setup.sh 选 1) 飞书 或 2) Slack 即可，无需重建其余资源。" "To enable later: re-run ./setup.sh and pick 1) Feishu or 2) Slack — no need to rebuild anything else.")"
fi
echo "Bedrock API Key:   $BEDROCK_API_KEY_SECRET"
echo "Data Bucket:       $DATA_BUCKET"
echo ""
# ─── Agent 未就绪:必须在总结里大声说 ───
# 没有 Runtime ARN 的部署,web 端一切正常、Chat URL 照常打印,但 BFF 只会**回显**用户
# 说的话("收到 —— 你说的是：…")。这是客户侧最贵的一种失败:看起来部署成功了,
# 产品的全部价值(问答/调查/成本/案例)其实都不在。所以这里不是一行 ⚠,是一整块,
# 并且给出可直接粘贴的两条修复命令。
#
# 钉住的 CLI 版本的**唯一权威**是 scripts/deploy_agent.sh；这里只是把它读出来印给客户,
# 而不是在第二个文件里再写一遍版本号(那必然会漏改其中一处)。读不到才回退字面量,
# 且 scripts/test_setup_agent_gate.py 会断言这个回退值与权威值一致。
AGENTCORE_CLI_VERSION_EXPECTED="$(grep -oE 'AGENTCORE_CLI_VERSION:-[0-9]+\.[0-9]+\.[0-9]+' \
  "$PROJECT_ROOT/scripts/deploy_agent.sh" 2>/dev/null | head -1 | cut -d- -f2- || true)"
[ -n "$AGENTCORE_CLI_VERSION_EXPECTED" ] || AGENTCORE_CLI_VERSION_EXPECTED="0.24.2"
if [ "$AGENT_STATUS" != "deployed" ]; then
  echo "  ┌──────────────────────────────────────────────────────────────────┐"
  echo "  $(t "  │ ⚠️  Agent 未就绪 —— Web Chat 现在只会【回显你说的话】!          │" "  │ ⚠️  AGENT NOT READY — Web Chat will only ECHO YOUR MESSAGE back!       │")"
  echo "  └──────────────────────────────────────────────────────────────────┘"
  case "$AGENT_STATUS" in
    failed)  echo "  $(t "  原因: agent 部署失败(往上翻找 deploy_agent.sh 的报错)。" "  Cause: the agent deployment failed (scroll up for the deploy_agent.sh error).")" ;;
    no-arn)  echo "  $(t "  原因: agent 部署脚本没产出 Runtime ARN。" "  Cause: the agent deploy script produced no Runtime ARN.")" ;;
    skipped) echo "  $(t "  原因: SKIP_AGENT=true,本次有意跳过了 agent 部署。" "  Cause: SKIP_AGENT=true — the agent deployment was intentionally skipped.")" ;;
    *)       echo "  $(t "  原因: 找不到 agent 工程目录 agent-build/NotiOpsWebChat(仓库不完整)。" "  Cause: the agent project dir agent-build/NotiOpsWebChat is missing (incomplete repo).")" ;;
  esac
  echo "  $(t "  症状: 任何提问都只会得到「收到 —— 你说的是：…」这种回显,不是真回答。" "  Symptom: every question comes back as \"Got it — you said: ...\" instead of a real answer.")"
  echo ""
  echo "  $(t "  真正的报错在 agentcore CLI 自己的日志里(终端上往往只剩一句概括):" "  The real error is in the agentcore CLI's own log (the terminal usually shows only a summary):")"
  echo "      tail -80 \"\$(ls -t agent-build/NotiOpsWebChat/agentcore/.cli/logs/deploy/*.log | head -1)\""
  echo ""
  echo "  $(t "  最省事的修法 —— 一条命令(先只读体检、给出结论,动手前会让你确认):" "  Easiest fix — one command (read-only diagnosis first; asks before changing anything):")"
  echo "      UI_LANG=$UI_LANG bash scripts/fix_web_chat_echo.sh --region $DEPLOY_REGION"
  echo ""
  echo "  $(t "  它查/修的就是已知的两个原因(也可以照下面手工做):" "  It checks/fixes the two known causes (you can also do it by hand):")"
  echo "  $(t "   ① 缺 uv(agentcore 打 Python 包必须):" "   (1) missing uv (required to package the agent's Python deps):")"
  echo "      curl -LsSf https://astral.sh/uv/install.sh | sh"
  echo "  $(t "   ② agentcore CLI 版本不是 $AGENTCORE_CLI_VERSION_EXPECTED(更新的版本会改写入库的 CDK harness → tsc 失败):" "   (2) the agentcore CLI is not $AGENTCORE_CLI_VERSION_EXPECTED (a newer one rewrites the in-repo CDK harness → tsc fails):")"
  echo "      npm install -g @aws/agentcore@$AGENTCORE_CLI_VERSION_EXPECTED"
  echo "      git checkout -- agent-build/NotiOpsWebChat/agentcore/cdk/package.json agent-build/NotiOpsWebChat/agentcore/cdk/package-lock.json"
  echo "      rm -rf agent-build/NotiOpsWebChat/agentcore/cdk/node_modules"
  echo "  $(t "   然后重跑这两步(不必重建其余资源):" "   Then re-run these two steps (no need to rebuild anything else):")"
  echo "      DEPLOY_REGION=$DEPLOY_REGION bash scripts/deploy_agent.sh"
  echo "      $(t "# 上一步会打印 Runtime ARN,填到下面这条里" "# the step above prints the Runtime ARN; paste it below")"
  # 🔴 必须带**全套** -c，不能只带 agentRuntimeArn。少一个的后果都是静默的：
  #    少 -c enabledPlatforms → IM 平台被关（已配好的 bot 不再收消息）；
  #    少 $ORG_FLAG → org 模式失效（跨账号查询报 org_mode_disabled）；
  #    少 $INSPECTION_FLAGS → 推送深链变空、巡检预算护栏关掉。
  #    CDK 的 context 不是"合并进已部署的栈"，而是每次 synth 从零重算。
  echo "      cd infra && npx cdk deploy WebChatStack --exclusively --require-approval never -c agentRuntimeArn=<ARN> $SKIP_PHD_FLAG $PHD_ACCOUNTS_FLAG $DEVOPS_AGENT_ACCOUNTS_FLAG $PLATFORM_FLAG $ORG_FLAG $INSPECTION_FLAGS $COST_AGENT_FLAG"
  echo "  $(t "   （上面这条已带本次部署用的全套 -c；少任何一个都会静默关掉对应功能。）" "   (The command above already carries the full -c set used by this deployment; dropping any one silently disables that feature.)")"
  echo ""
fi

echo "$(t "下一步（全部从 Web Chat 进,不用记别的地址）: " "Next steps (all from Web Chat, no other URL needed):")"
echo ""
echo "  $(t "1️⃣  打开 Web Chat(" "1️⃣  Open Web Chat (")$CHAT_URL$(t "),用 admin / 上述密码登录(首次登录需改密码)。" "), log in as admin with the password above (change it on first login).")"
echo ""
if [ "$AGENT_STATUS" = "deployed" ]; then
  echo "  $(t "✅ 登录后即可直接用 —— 问答 / 故障调查 / 成本分析 / Support 案例," "✅ Ready to use right after login — Q&A / investigation / cost analysis / Support cases,")"
  echo "     $(t "默认操作【部署账号】本身,无需任何额外配置。左侧菜单能看到" "operating on the [deploy account] itself by default, no extra config. The left menu shows")"
  echo "     $(t "通知 / 调查 / FinOps / 案例 / Skills,以及「更多」里的 安全 / 巡检&报告 / 定制。" "Notifications / Investigation / Cost / Cases / Skills, plus Security / Inspections & Reports / Customize under \"More\".")"
else
  # agent 没上线时这句"登录后即可直接用"是**假的** —— 别说。
  echo "  $(t "⚠ 上面的 Agent 问题修好之前,聊天只会回显,不要按下面的流程验收。" "⚠ Until the agent issue above is fixed, chat only echoes — do not sign off on the steps below yet.")"
fi
echo ""
# ⚠️ 站内「资源巡检」看板与上面那个「巡检 & 报告」是**两个不同的东西**：
#    后者外链到老控制台（CloudFront），前者是站内看板。这里必须单独说一句 ——
#    不说的话客户跑完 setup.sh 压根不知道有这个页面（侧栏入口是 fail-CLOSED 的，
#    只有拿到 nav:inspection 能力才显示），于是整个 feature 交付了等于没交付。
echo "  $(t "  📋 资源巡检看板(站内,与上面的「巡检 & 报告」外链不是同一个页面):" "  📋 Resource Inspection dashboard (in-app; NOT the \"Inspections & Reports\" external link above):")"
echo "     $(t "左侧「资源巡检」→ 总览 / 高负载 / 闲置与成本 / 结构性风险 / 巡检范围 / 阈值与定时。" "Left menu \"Resource Inspection\" → Overview / High Load / Idle & Cost / Structural Risk / Scope / Schedule.")"
echo "     $(t "两类巡检默认都在每天 UTC 02:00(= 北京时间 10:00)跑,首轮结果在那之后可见;时刻可在「阈值与定时」页改。" "Both run types default to 02:00 UTC daily; first results appear after that. Change it on the \"Thresholds & Schedule\" page.")"
echo "     $(t "改排除清单 / 改执行时刻需要 action:inspection:scope / :schedule 权限(默认只有 admin 有)。" "Editing exclusions / schedule needs action:inspection:scope / :schedule (admin only by default).")"
echo "     $(t "出问题要立刻停:见 inspection/adapters/switches.py 顶部的 kill switch 命令(改 DDB 一行,不用重新部署)。" "To stop it immediately: see the kill switch commands atop inspection/adapters/switches.py (one DDB write, no redeploy).")"
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
  # M2 之后没有可重启的 ECS 服务了:Webhook Lambda 每次冷启动都重新读 Secret,
  # 热容器最多带一个短 TTL 的缓存 —— 所以「填完等下一次调用」就是全部操作,
  # 不存在也不需要「重启服务」这一步。旧文案让客户去找一个不存在的 ECS 服务。
  echo "  $(t "  【填法二】直接更新 Secrets Manager(下方 Secret 名);Webhook Lambda 下次调用即生效,无需重启任何服务。" "  [Option B] Update Secrets Manager directly (secret names below); the webhook Lambda picks it up on its next invocation — nothing to restart.")"
  echo ""
  # 请求地址必须打印:客户下一步就是把它粘到飞书/Slack 控制台里。
  echo "  $(t "  ▸ 要粘进平台控制台的【请求地址 / Request URL】:" "  ▸ The Request URL to paste into the platform console:")"
  case "$ENABLED_PLATFORMS" in
    *feishu*) echo "  $(t "    · 飞书: " "    · Feishu: ")$FEISHU_WEBHOOK_URL" ;;
  esac
  case "$ENABLED_PLATFORMS" in
    *slack*)  echo "  $(t "    · Slack: " "    · Slack:  ")$SLACK_WEBHOOK_URL" ;;
  esac
  echo ""
  case "$ENABLED_PLATFORMS" in
    *feishu*)
      echo "  $(t "  · 飞书 —— Secret: " "  · Feishu —— Secret: ")notiops/im-bot-feishu"
      echo "  $(t "      需填字段: app_id / app_secret(从飞书开放平台「凭证与基础信息」获取)。" "      Fields: app_id / app_secret (from Feishu Open Platform \"Credentials & Basic Info\").")"
      echo "  $(t "      Webhook 模式还要填 encrypt_key / verification_token(见下面的配置指南)。" "      Webhook mode also needs encrypt_key / verification_token (see the setup guide below).")" ;;
  esac
  case "$ENABLED_PLATFORMS" in
    *slack*)
      echo "  $(t "  · Slack —— Secret: " "  · Slack —— Secret: ")notiops/slack-bot-token $(t "和" "and") notiops/slack-signing-secret"
      echo "  $(t "      需填: Bot Token(OAuth & Permissions 页)和 Signing Secret(Basic Information 页)。" "      Fill: the Bot Token (OAuth & Permissions page) and the Signing Secret (Basic Information page).")"
      echo "  $(t "      ⚠️ 这两个 Secret 现在装的是 CDK 随机生成的值,不是空串 —— 忘了填不会报「为空」,而是报「密钥不对」。" "      ⚠️ Both secrets currently hold a CDK-generated random value, not an empty string — forgetting to fill them shows up as a wrong credential, not as an empty one.")" ;;
  esac
  echo ""
  echo "  $(t "  ▸ 两个平台在控制台具体点哪几个开关、顺序为什么不能反、怎么回滚:" "  ▸ Which switches to flip in each platform's console, why the order matters, and how to roll back:")"
  echo "      docs/IM_WEBHOOK_SETUP.md"
  echo "  $(t "    (飞书是「原地切换现有 App」,权限一条都不用加;Slack 是新建 App。" "    (Feishu is an in-place cutover of your existing app — no new scopes needed; Slack is a new app.")"
  echo "  $(t "     必须先把 Secret 填好,再去平台上保存请求地址 —— 反了 URL 校验必失败。)" "     Fill the secrets BEFORE saving the Request URL in the console — the URL challenge fails otherwise.)")"
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
# 以前这里是「⚠️ 必做一步:去控制台 Configure web app」。现在 CDK 建 space 时就把
# Operator App(web app)开好了(notiops-backend-stack.ts 的 DevOpsAgentOperatorAppRole
# + operatorApp),所以这一步**不再需要客户手点**。留一句排错提示:老部署(本版本之前建的
# space)可能还没开过,症状就是下面那个报错。
echo "  $(t "── Web 应用(Operator App)已自动开好 ──" "── The web app (operator app) is enabled automatically ──")"
echo "  $(t "CDK 建 Agent Space 时已顺手开启 Operator App,你不需要再去控制台点 Configure web app." "CDK enables the operator app when it creates the agent space — you don't need to click Configure web app in the console.")"
echo "  $(t "如果发起调查时仍报 \"Invalid or unregistered domain\"(通常是本版本之前建的老 space):" "If starting an investigation still errors with \"Invalid or unregistered domain\" (usually a space created before this version):")"
echo "    $(t "进 DevOps Agent 控制台 → space(notiops-devops-${CDK_ACCOUNT:-<account>}) → Configure web app 点一次即可" "open the DevOps Agent console → space (notiops-devops-${CDK_ACCOUNT:-<account>}) → Configure web app, once")"
echo "        https://console.aws.amazon.com/aidevops/home#/agent-spaces"

echo ""
echo "  $(t "── DevOps Agent 多账户集成 ──" "── DevOps Agent Multi-Account Integration ──")"
DEVOPS_EVENT_BUS_ARN=$(jq -r ".[\"$STACK_NAME\"].DevOpsAgentEventBusArn" cdk-outputs.json 2>/dev/null || echo "N/A")
DEVOPS_BUS_JUDGEMENT=$(jq -r ".[\"$STACK_NAME\"].DevOpsAgentBusPolicyJudgement" cdk-outputs.json 2>/dev/null || echo "N/A")
ONBOARDING_BUCKET=$(jq -r ".[\"$STACK_NAME\"].DataBucketName" cdk-outputs.json 2>/dev/null || echo "N/A")
echo "  Custom Event Bus ARN:            $DEVOPS_EVENT_BUS_ARN"
echo "  $(t "总线跨账号判据:                  " "Bus cross-account judgement:           ")$DEVOPS_BUS_JUDGEMENT"
echo "  $(t "Onboarding 模板 S3 Bucket:       " "Onboarding template S3 Bucket:         ")$ONBOARDING_BUCKET"
echo ""
echo "  $(t "新增业务账户流程: " "To onboard a new business account:")"
echo "    $(t "1. (不需要重新部署本栈 —— 判据与账号无关)" "1. (No redeploy of this stack needed - the judgement is account-agnostic)")"
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

  # 🔴 **这两行赋值必须在参数数组之前。** bash 数组在赋值那一刻就展开 ——
  #    引用一个还没赋值的变量**不报错**（本脚本有 `set -e` 但没有 `set -u`），
  #    静默变空串。
  #
  #    2026-08-30 就是这么错过一次：参数数组按 `STACKSET_NAME=` 这个锚点插在
  #    它下面，而这两行赋值在**更下面** ⇒ `DevOpsEventBusArn` 传空串。
  #    而模板里那个参数**无 Default 且有 AllowedPattern**（空串不匹配）⇒
  #      · CFN 在 `create-stack-set` 就拒 → `set -e` 让脚本**停在这里**，
  #        后面 DA 的 StackSet 与 OU 下发全都不跑 ⇒「一键接入」与
  #        「一键关联」两步都失败（各报找不到 StackSet）
  #      · 或 CFN 推迟到 `create-stack-instances` 才校验 → StackSet 建成、
  #        脚本打印「✓ 已创建」，而每个成员账号的实例异步失败，
  #        脚本那时打的是「✓ 已提交(异步执行)」
  #
  #    ⚠️ `bash -n` 抓不到（语法合法）。真正钉住它的是
  #      `tests/test_member_template_inspection_space.py::
  #       test_StackSet_参数展开后不能有空值` —— 它把这一段**真跑一遍**
  #      再查展开后的值。
  MEMBER_BUS_ARN="arn:aws:events:${DEPLOY_REGION}:${CDK_ACCOUNT}:event-bus/notiops-devops-events"
  MEMBER_PHD_ARN=""
  if [ "$ENABLE_PHD" != "false" ]; then
    MEMBER_PHD_ARN="arn:aws:sns:${DEPLOY_REGION}:${CDK_ACCOUNT}:phd-events"
  fi

  # ⚠️ 这道守卫**抓不到上面那个顺序问题**（它跑的时候变量已经赋值了，空串
  #    早就烙进数组）—— 我实测确认过。它管的是另一类：变量真的算出来是空的
  #    （比如 `CDK_ACCOUNT` 没解析出来）。留着是因为那种情况的失败位置
  #    （第 2 步的 stack instance）离原因很远。
  for _v in DEPLOY_REGION CDK_ACCOUNT ORG_ID MEMBER_BUS_ARN; do
    eval "_val=\$$_v"
    [ -n "$_val" ] || { echo "  BUG: $_v 为空，拒绝创建 StackSet（空参数会让成员账号接入静默失败）" >&2; exit 1; }
  done

  # ─── 这个 StackSet 的参数 ───
  #
  # 🔴 **PrimaryRegion 此前从不传**（2026-08-30 补）。
  #
  #    模板的 Default 是 `us-east-1`，而 `IsPrimaryRegion` 控制两件事：
  #      · IAM 角色只在主区建一次（IAM 是全局资源）
  #      · `DevOpsEventsForwardRole`（转发角色）
  #    而转发**规则** `DevOpsEventsForwardRule` **没有**这个条件。
  #
  #    ⇒ 客户的 regions 不含 us-east-1 时：角色不建、规则照建、
  #      规则的 RoleArn 是手拼字符串、指向一个不存在的角色
  #      ⇒ 转发静默失败。只有 EventBridge 的 FailedInvocations 指标，
  #        我们这侧零信号 —— 表现是「那个账号的判读一直空着」。
  #
  # ⚠️ 手动接入那条路（`member_accounts.mjs` 的 `generateCollectionStackUrl`）
  #    一直是传 `param_PrimaryRegion` 的 —— **只有 StackSet 这条漏了**。
  ONBOARD_SS_PARAMS=(
    "ParameterKey=SystemAccountId,ParameterValue=$CDK_ACCOUNT"
    "ParameterKey=DevOpsEventBusArn,ParameterValue=$MEMBER_BUS_ARN"
    "ParameterKey=PhdSnsTopicArn,ParameterValue=$MEMBER_PHD_ARN"
    "ParameterKey=OrganizationId,ParameterValue=$ORG_ID"
    "ParameterKey=PrimaryRegion,ParameterValue=$DEPLOY_REGION"
  )

  # 1. 开启 StackSets 与 Organizations 的可信访问。
  #
  # 🔴 **这里有两个独立的开关，只开一个不够**（2026-08-31 实测踩到）：
  #
  #    ```
  #    Organizations 侧   enable-aws-service-access
  #                       --service-principal member.org.stacksets.cloudformation.amazonaws.com
  #    CloudFormation 侧  cloudformation activate-organizations-access   ← 此前漏了
  #    ```
  #
  #    只开第一个时 `describe-organizations-access` 仍然是 **DISABLED**，
  #    而 `create-stack-set --permission-model SERVICE_MANAGED` 报
  #      ValidationError: You must enable organizations access to operate
  #                       a service managed stack set
  #    ⇒ `set -e` 让脚本**停在这里**，后面 DA 的 StackSet 与 OU 下发都不跑。
  #
  #    实测现场最误导的一点：Organizations 侧的列表里
  #    member.org.stacksets… **已经在了**（第一条调用成功了），而 CFN 侧是
  #    DISABLED —— 所以只看第一条会以为没问题。
  #
  # ⚠️ 两条都**只有管理账号能调**。委派管理员场景会失败，那时可信访问应该已经
  #    在管理账号开过了，所以照旧忽略错误 —— 但**不能静默**：真的没开时
  #    下面 create-stack-set 会报上面那个 ValidationError，而那句话**不提**
  #    该调 activate-organizations-access。所以这里把状态与补救命令打出来。
  #
  # ⚠️ API 形状已查官方文档核实：`activate-organizations-access` **无参数**
  #    （boto3 `activate_organizations_access()`）。
  aws organizations enable-aws-service-access \
    --service-principal member.org.stacksets.cloudformation.amazonaws.com 2>/dev/null || true
  aws cloudformation activate-organizations-access --region "$DEPLOY_REGION" 2>/dev/null || true

  _ORG_ACCESS=$(aws cloudformation describe-organizations-access \
    --region "$DEPLOY_REGION" --query Status --output text 2>/dev/null || echo UNKNOWN)
  if [ "$_ORG_ACCESS" = "ENABLED" ]; then
    echo "  $(t "✓ StackSets 与 Organizations 的可信访问已激活" "✓ Trusted access between StackSets and Organizations is active")"
  else
    echo "  $(t "⚠ StackSets 的 Organizations 可信访问状态: " "⚠ StackSets Organizations access status: ")$_ORG_ACCESS"
    echo "    $(t "下一步 create-stack-set 大概率会报 'You must enable organizations access'。" "The next create-stack-set will likely fail with 'You must enable organizations access'.")"
    echo "    $(t "请用**组织管理账号**执行下面两条，然后重跑本脚本:" "Run these from the **organization management account**, then re-run this script:")"
    echo "      aws cloudformation activate-organizations-access --region $DEPLOY_REGION"
    echo "      aws organizations enable-aws-service-access \\"
    echo "        --service-principal member.org.stacksets.cloudformation.amazonaws.com"
  fi

  # 2. 创建或更新 StackSet(SERVICE_MANAGED + auto-deployment)
  if aws cloudformation describe-stack-set --stack-set-name "$STACKSET_NAME" \
       --region "$DEPLOY_REGION" >/dev/null 2>&1; then
    echo "  $(t "检测到已有 StackSet, 更新模板/参数..." "Existing StackSet detected, updating template/parameters...")"
    aws cloudformation update-stack-set \
      --stack-set-name "$STACKSET_NAME" \
      --template-body "file://$MEMBER_TEMPLATE" \
      --parameters "${ONBOARD_SS_PARAMS[@]}" \
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
      --parameters "${ONBOARD_SS_PARAMS[@]}" \
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

  # ─── 这个 StackSet 的参数 ───
  #
  # 🔴 **CreateCollectionRole 必须显式传 no**（2026-08-30 补）。
  #
  #    模板的 Default 是 `"yes"`，而 org 这条路上采集角色
  #    `notiops-idle-detection-role-<系统账号>` 由**另一份**模板
  #    （上面那个 `notiops-member-onboarding` StackSet）负责建。
  #
  #    两份都建 → `EntityAlreadyExists`（IAM 角色是全局资源，而那个名字里只有
  #    **系统**账号、不含成员账号）→ 第二步「一键关联」**整栈 rollback**
  #      ⇒ `devopsAgentAssocStatus` 写 `onboarding_status="failed"`
  #      ⇒ `accounts._is_active` 把 failed 排除 ⇒ 那个账号**永不进**
  #        `enabled_accounts()` ⇒ 巡检侧零信号
  #      ⇒ 唯一的线索是管理页第二步显示 failed
  #
  # ⚠️ `member-devops-agent.yaml` 的注释把责任推给「客户在控制台选 no」——
  #    而 StackSet 这条路**没有人去选**，走的是模板 Default。
  #
  # ⚠️ `DevOpsEventBusArn` 刻意**不传**（模板 Default 是空串）：org 账号的
  #    转发规则由 onboarding 那份建，两份都建会让同一批事件被投两次
  #    （callback 跑两遍、双份 Bedrock 摘要，且不报错）。
  DA_SS_PARAMS=(
    "ParameterKey=SystemAccountId,ParameterValue=$CDK_ACCOUNT"
    "ParameterKey=OrganizationId,ParameterValue=$ORG_ID"
    "ParameterKey=CreateCollectionRole,ParameterValue=no"
  )

  if aws cloudformation describe-stack-set --stack-set-name "$DA_STACKSET_NAME" \
       --region "$DEPLOY_REGION" >/dev/null 2>&1; then
    aws cloudformation update-stack-set \
      --stack-set-name "$DA_STACKSET_NAME" \
      --template-body "file://$DA_TEMPLATE" \
      --parameters "${DA_SS_PARAMS[@]}" \
      --capabilities CAPABILITY_NAMED_IAM \
      --region "$DEPLOY_REGION" >/dev/null \
      && echo "  $(t "✓ DevOps Agent StackSet 已更新" "✓ DevOps Agent StackSet updated")" \
      || echo "  $(t "⚠ DevOps Agent StackSet 更新失败(可能有进行中的 operation)" "⚠ DevOps Agent StackSet update failed (an operation may be in progress)")"
  else
    aws cloudformation create-stack-set \
      --stack-set-name "$DA_STACKSET_NAME" \
      --description "NotiOps member DevOps Agent onboarding (agent space + trigger role)" \
      --template-body "file://$DA_TEMPLATE" \
      --parameters "${DA_SS_PARAMS[@]}" \
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

# ─── 两个接入模板同步到数据桶（**不在 ORG_MODE 块里**）────────────────────
#
# 🔴 2026-08-30 把这段从 `if [ "$ORG_MODE" = true ]` 块里**挪了出来**。
#
#    它原本在块内，而它自己的注释写着：「那条路径恰恰是 partner-resold /
#    **非 org** 客户唯一的接入方式」—— 也就是说它**修在了自己点名的那个场景
#    永远进不去的地方**。非 org 部署（或忘了 `--multi-account`）时模板压根不
#    同步，点「生成部署链接」报 `config_error: template not found`。
#
#    BFF 的「手动接入账号」流程（`generateLaunchStackUrl` /
#    `generateCollectionStackUrl`）会先试从 Lambda 包里读模板，读不到就从这里
#    拿 —— 而 Lambda 包只打 `bff/web-chat`，**不含 `infra/`**，所以 S3 这份是
#    唯一来源。手动接入与 org 模式无关，同步也不该有关。
#
# ⚠️ 此前没有任何自动化：DA 模板是 2026-08-21 手工传上去的，采集模板压根
#    没传过。
#
# ⚠️ 桶的生命周期规则删的是 `onboarding/` 前缀（规则名虽然叫
#    expire-onboarding-templates-7d），`onboarding-templates/` 不受影响。
if [ -n "${DATA_BUCKET:-}" ] || DATA_BUCKET="notiops-data-${CDK_ACCOUNT}-${DEPLOY_REGION}"; then
  for _tmpl in member-devops-agent.yaml member-account-onboarding.yaml; do
    if aws s3 cp "$PROJECT_ROOT/infra/$_tmpl" \
         "s3://$DATA_BUCKET/onboarding-templates/$_tmpl" \
         --content-type "text/yaml; charset=utf-8" \
         --region "$DEPLOY_REGION" >/dev/null 2>&1; then
      echo "  $(t "✓ 接入模板已同步: $_tmpl" "✓ Onboarding template synced: $_tmpl")"
    else
      echo "  $(t "⚠ 接入模板同步失败: $_tmpl —— 「手动接入账号」的生成链接会报 template not found" "⚠ Failed to sync onboarding template: $_tmpl — Manual onboarding's link generation will report template not found")"
    fi
  done
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
