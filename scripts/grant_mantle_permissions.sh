#!/usr/bin/env bash
# 幂等地给 NotiOps AgentCore runtime 执行角色补 Bedrock Mantle 权限（GPT-5.4 用）。
#
# 背景：GPT-5.4 经 Bedrock Mantle（OpenAI Responses API，us-east-2/us-west-2）调用。
# `agentcore deploy` 生成的 runtime 执行角色默认没有 mantle 权限，缺了会在 SSE 流里报 401
# （bedrock-mantle:CreateInference / CallWithBearerToken）。
#
# 推荐做法是把权限写进 agentcore CDK（cdk-stack.ts，部署即生效，客户零操作）；
# 本脚本是**补救路径**：当角色已存在、或没带 CDK 改动时，手动一键补权限。重复执行安全。
#
# 用法：
#   AWS_REGION=us-east-1 ./scripts/grant_mantle_permissions.sh
#   （会自动发现名字以 AgentCore-NotiOpsWebChat 开头、含 ExecutionRole 的角色；
#     也可显式指定：ROLE_NAME=<role> ./scripts/grant_mantle_permissions.sh）
set -euo pipefail

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
POLICY_NAME="NotiOpsBedrockMantle"

# 发现执行角色（除非显式给了 ROLE_NAME）
if [ -z "${ROLE_NAME:-}" ]; then
  ROLE_NAME="$(aws iam list-roles \
    --query "Roles[?contains(RoleName, 'AgentCore-NotiOpsWebChat') && contains(RoleName, 'ExecutionRole')].RoleName | [0]" \
    --output text 2>/dev/null || echo "None")"
fi

if [ -z "$ROLE_NAME" ] || [ "$ROLE_NAME" = "None" ]; then
  echo "❌ 未找到 AgentCore NotiOps runtime 执行角色。" >&2
  echo "   请先 'agentcore deploy'，或用 ROLE_NAME=<角色名> 显式指定。" >&2
  exit 1
fi

echo "→ 角色: $ROLE_NAME"
echo "→ 账号: $ACCOUNT  策略: $POLICY_NAME"

POLICY_DOC="$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "NotiOpsBedrockMantleInference",
      "Effect": "Allow",
      "Action": ["bedrock-mantle:CreateInference", "bedrock-mantle:GetInference"],
      "Resource": [
        "arn:aws:bedrock-mantle:us-east-2:${ACCOUNT}:*",
        "arn:aws:bedrock-mantle:us-west-2:${ACCOUNT}:*"
      ]
    },
    {
      "Sid": "NotiOpsBedrockMantleBearer",
      "Effect": "Allow",
      "Action": ["bedrock-mantle:CallWithBearerToken"],
      "Resource": "*"
    }
  ]
}
EOF
)"

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "$POLICY_NAME" \
  --policy-document "$POLICY_DOC"

echo "✓ 已授予 Bedrock Mantle 权限（幂等）。GPT-5.4 现在可经 Mantle 调用。"
