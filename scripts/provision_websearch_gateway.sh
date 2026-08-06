#!/usr/bin/env bash
# 一键 provision NotiOps 的 AgentCore Web Search 基础设施（GA 2026，仅 us-east-1）。
# 幂等：已存在则复用。完成后打印 AGENTCORE_WEBSEARCH_GATEWAY_URL，填进
# agent-build/.../agentcore/agentcore.json 的 runtime envVars（或 CDK 注入）后重新 agentcore deploy。
#
# 背景：AgentCore web search 没有独立 API，必须经 Gateway + web-search connector target 调用。
# 数据全程不出 AWS（区别于 Exa 第三方）。agent 经 MCP+SigV4 调 Gateway。
# 详见 memory web-chat-phase1-deploy 的 "AgentCore Web Search" 段。
set -euo pipefail

# ─── UI 语言（双语输出）───
# 继承调用方（deploy_agent.sh / setup.sh）导出的 UI_LANG（zh/en）；单独跑时默认英文。
# t "<中文>" "<English>"：按 UI_LANG 输出对应语言。
# export：让内嵌的 python3 heredoc 子进程也能读到 UI_LANG。
export UI_LANG="${UI_LANG:-en}"
t() { if [ "$UI_LANG" = "zh" ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
GW_NAME="${GW_NAME:-notiops-websearch-gw}"
SVC_ROLE="${SVC_ROLE:-notiops-websearch-gateway-role}"
TARGET_NAME="web-search-tool"

if [ "$REGION" != "us-east-1" ]; then
  echo "$(t "⚠️  AgentCore Web Search 目前仅 us-east-1 可用，你设的是 ${REGION}。继续可能失败。" "⚠️  AgentCore Web Search is currently only available in us-east-1; you set ${REGION}. Continuing may fail.")" >&2
fi

# ── 1. Gateway 服务角色（信任 bedrock-agentcore + InvokeGateway/InvokeWebSearch）──
if ! aws iam get-role --role-name "$SVC_ROLE" >/dev/null 2>&1; then
  TRUST=$(cat <<EOF
{"Version":"2012-10-17","Statement":[{"Sid":"GatewayAssumeRolePolicy","Effect":"Allow",
"Principal":{"Service":"bedrock-agentcore.amazonaws.com"},"Action":"sts:AssumeRole",
"Condition":{"StringEquals":{"aws:SourceAccount":"${ACCOUNT}"},
"ArnLike":{"aws:SourceArn":"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:gateway/*"}}}]}
EOF
)
  aws iam create-role --role-name "$SVC_ROLE" --assume-role-policy-document "$TRUST" \
    --description "NotiOps AgentCore Gateway service role for Web Search" \
    --tags Key=auto-delete,Value=no Key=project,Value=notiops >/dev/null
  echo "$(t "✓ 创建服务角色 $SVC_ROLE" "✓ Created service role $SVC_ROLE")"
fi
# 幂等补标签：既有角色（老部署重跑）也补齐项目标签，与 CDK 资源(auto-delete=no + project=notiops)对齐。
aws iam tag-role --role-name "$SVC_ROLE" \
  --tags Key=auto-delete,Value=no Key=project,Value=notiops >/dev/null 2>&1 || true
PERMS=$(cat <<EOF
{"Version":"2012-10-17","Statement":[
{"Sid":"InvokeGateway","Effect":"Allow","Action":"bedrock-agentcore:InvokeGateway",
 "Resource":"arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:gateway/*"},
{"Sid":"InvokeWebSearch","Effect":"Allow","Action":"bedrock-agentcore:InvokeWebSearch",
 "Resource":"arn:aws:bedrock-agentcore:${REGION}:aws:tool/web-search.v1"}]}
EOF
)
aws iam put-role-policy --role-name "$SVC_ROLE" --policy-name NotiOpsWebSearchGateway --policy-document "$PERMS"
ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${SVC_ROLE}"
echo "$(t "✓ 服务角色权限就绪：$ROLE_ARN" "✓ Service role permissions ready: $ROLE_ARN")"

# ── 2. Gateway（AWS_IAM 鉴权，MCP 协议）。已存在则复用。──
GW_ID="$(aws bedrock-agentcore-control list-gateways --region "$REGION" \
  --query "items[?name=='${GW_NAME}'].gatewayId | [0]" --output text 2>/dev/null || echo "None")"
if [ -z "$GW_ID" ] || [ "$GW_ID" = "None" ]; then
  GW_ID="$(aws bedrock-agentcore-control create-gateway --region "$REGION" \
    --name "$GW_NAME" --role-arn "$ROLE_ARN" --protocol-type MCP --authorizer-type AWS_IAM \
    --description "NotiOps web search (us-east-1)" --tags auto-delete=no,project=notiops \
    --query gatewayId --output text)"
  echo "$(t "✓ 创建 Gateway ${GW_ID}（等待 READY…）" "✓ Created Gateway ${GW_ID} (waiting for READY…)")"
  for _ in $(seq 1 30); do
    S="$(aws bedrock-agentcore-control get-gateway --region "$REGION" --gateway-identifier "$GW_ID" --query status --output text)"
    [ "$S" = "READY" ] && break; sleep 3
  done
else
  echo "$(t "✓ 复用已有 Gateway $GW_ID" "✓ Reusing existing Gateway $GW_ID")"
fi
# 幂等补标签：既有 Gateway（老部署重跑）也补齐项目标签，与 CDK 资源(auto-delete=no + project=notiops)对齐。
GW_ARN="arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT}:gateway/${GW_ID}"
aws bedrock-agentcore-control tag-resource --region "$REGION" \
  --resource-arn "$GW_ARN" --tags auto-delete=no,project=notiops >/dev/null 2>&1 || true
GW_URL="$(aws bedrock-agentcore-control get-gateway --region "$REGION" --gateway-identifier "$GW_ID" --query gatewayUrl --output text)"

# ── 3. web-search connector target。已存在则跳过。──
# web-search connector 是很新的 target 类型，需 **botocore>=1.43.36**；老版本（含 AWS CLI
# 自带的）会报 "Unknown parameter ... connector"。这里用 Python boto3 创建，并在 botocore
# 过旧时自动 pip 安装到一个临时目录（不污染系统环境），保证客户机器上也能成功。
GW_ID="$GW_ID" REGION="$REGION" TARGET_NAME="$TARGET_NAME" python3 - <<'PY'
import os, sys, subprocess, tempfile

# 实际建 target 的逻辑。始终在【全新子进程】里跑（见下），这样 botocore 需要升级时，
# 干净进程会从头 import 新版 boto3/botocore；绝不在本进程删 sys.modules 再 import
# （旧写法那样会拿到半初始化模块，报 "module 'boto3' has no attribute 'client'"）。
WORK = r'''
import os, boto3
_zh = os.environ.get("UI_LANG") == "zh"
region = os.environ["REGION"]; gw = os.environ["GW_ID"]; name = os.environ["TARGET_NAME"]
c = boto3.client("bedrock-agentcore-control", region_name=region)
existing = c.list_gateway_targets(gatewayIdentifier=gw).get("items", [])
if any(t.get("name") == name for t in existing):
    print(f"✓ 复用已有 target {name}" if _zh else f"✓ Reusing existing target {name}")
else:
    r = c.create_gateway_target(
        gatewayIdentifier=gw, name=name,
        targetConfiguration={"mcp": {"connector": {
            "source": {"connectorId": "web-search"},
            "configurations": [{"name": "WebSearch", "parameterValues": {}}]}}},
        credentialProviderConfigurations=[{"credentialProviderType": "GATEWAY_IAM_ROLE"}],
    )
    print(f"✓ 创建 web-search target {r.get('targetId')}" if _zh else f"✓ Created web-search target {r.get('targetId')}")
'''

# web-search connector 是很新的 target 类型，需 botocore>=1.43.36；过旧就装到临时目录
# （不污染系统环境）并把它前置到子进程的 PYTHONPATH。
env = dict(os.environ)
need_upgrade = True
try:
    import botocore
    v = tuple(int(x) for x in botocore.__version__.split(".")[:3])
    need_upgrade = v < (1, 43, 36)
except Exception:
    need_upgrade = True

if need_upgrade:
    tgt = os.path.join(os.environ.get("TMPDIR", "/tmp"), "notiops-botocore-newer")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q",
                           "--target", tgt, "botocore>=1.43.36", "boto3>=1.40.36"])
    env["PYTHONPATH"] = tgt + os.pathsep + env.get("PYTHONPATH", "")

# 用临时文件承载 WORK（UTF-8 写入，编码安全），交给全新解释器执行。
with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False, encoding="utf-8") as f:
    f.write(WORK)
    work_path = f.name
try:
    subprocess.check_call([sys.executable, work_path], env=env)
finally:
    try:
        os.unlink(work_path)
    except OSError:
        pass
PY

# gatewayUrl 可能已含 /mcp 后缀（实测含）；幂等补：缺了才加，避免 /mcp/mcp。
MCP_URL="${GW_URL%/}"
case "$MCP_URL" in
  */mcp) : ;;            # 已以 /mcp 结尾
  *) MCP_URL="$MCP_URL/mcp" ;;
esac
echo ""
echo "$(t "================ 完成 ================" "================ Done ================")"
echo "$(t "Gateway URL（填进 agentcore.json 的 envVars.AGENTCORE_WEBSEARCH_GATEWAY_URL）：" "Gateway URL (set into agentcore.json envVars.AGENTCORE_WEBSEARCH_GATEWAY_URL):")"
echo "  $MCP_URL"
echo "$(t "然后重新 agentcore deploy。" "Then re-run agentcore deploy.")"
echo "$(t "agent 执行角色的 InvokeGateway 权限已在 agentcore 的 CDK(cdk-stack.ts)里授予，无需手动。" "The agent execution role's InvokeGateway permission is already granted in agentcore's CDK (cdk-stack.ts); no manual step needed.")"
